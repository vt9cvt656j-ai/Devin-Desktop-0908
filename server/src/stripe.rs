//! Stripe Checkout and webhook fulfilment.
//!
//! Two endpoints:
//!   * `POST /api/billing/checkout` — signed-in user picks a `lookup_key`, gets back a
//!     Stripe-hosted Checkout URL. No card data ever touches this server.
//!   * `POST /api/webhooks/stripe`  — Stripe tells us the money arrived; we grant the
//!     plan or credits through the same `codes::apply_*` helpers a redeem code and an
//!     admin grant use, so every path into a user's balance behaves identically.
//!
//! What the catalogue is: rows in `prices`. The Rust here never decides what a product
//! costs or grants — it reads `stripe_price_id`, `plan`, `duration_days`,
//! `credits_cents` off the row. Editing a product is a row update, not a redeploy.
//!
//! Trust boundary: the browser sends a `lookup_key` and nothing else. Amounts, plans
//! and credit grants are all read server-side from the matching row, so a tampered
//! request can at worst buy a different listed product at its real price.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::AppState;

const STRIPE_API: &str = "https://api.stripe.com/v1";

/// Stripe signatures older than this are refused, so a captured webhook body cannot be
/// replayed at leisure. Stripe's own libraries default to the same window.
const SIGNATURE_TOLERANCE_SECS: i64 = 300;

/// Secrets come from the environment like everything else in `config.rs`. They are read
/// per call rather than cached in `Config` so that adding them to the container is a
/// restart, not a rebuild — and so a deploy without them still boots and serves every
/// other route, with only billing reporting itself as unconfigured.
fn secret_key() -> Option<String> {
    std::env::var("STRIPE_SECRET_KEY").ok().filter(|s| !s.trim().is_empty())
}

fn webhook_secret() -> Option<String> {
    std::env::var("STRIPE_WEBHOOK_SECRET").ok().filter(|s| !s.trim().is_empty())
}

/// Where Stripe sends the buyer back to. Defaults to the gateway's own dashboard.
fn public_base() -> String {
    std::env::var("PUBLIC_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://code.mrday.one".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// One purchasable row, as the billing page needs it.
#[derive(Debug, sqlx::FromRow)]
struct CatalogRow {
    id: uuid::Uuid,
    label: String,
    kind: String,
    plan: Option<String>,
    duration_days: Option<i32>,
    credits_cents: Option<i64>,
    amount_cents: i64,
    amount_usd_cents: Option<i64>,
    stripe_price_id: Option<String>,
    lookup_key: Option<String>,
    recurring: bool,
    once_per_account: bool,
    unit_credits_cents: Option<i64>,
    blurb: String,
}

/// What Stripe says a price actually is. Fetched by lookup key, never typed by hand.
#[derive(Clone, Debug, Default)]
pub struct LivePrice {
    /// Stripe's own id for the price this lookup key currently points at.
    pub id: String,
    /// Minor units in the price's own currency (fen for cny, cents for usd).
    pub cny_minor: Option<i64>,
    pub usd_minor: Option<i64>,
    /// The price's base currency. What Checkout charges when the buyer's currency has no
    /// entry in `currency_options` — so it decides what the card is honest to display.
    pub currency: String,
    /// The product's name and description. These are what the operator edits in Stripe,
    /// and the card shows them verbatim rather than keeping a second copy in the database
    /// that nobody remembers to update.
    pub name: Option<String>,
    pub description: Option<String>,
    /// Per-language overrides read from the Stripe product's metadata, keyed by BCP-47
    /// tag. The operator adds `name_ja` / `description_de` there and the console picks
    /// them up on the next cache refresh — no deploy, and Stripe stays the one place a
    /// product is described.
    pub names: serde_json::Map<String, serde_json::Value>,
    pub descriptions: serde_json::Map<String, serde_json::Value>,
    /// Stripe's `recurring` is null on a one-time price. This decides the checkout mode,
    /// and getting it wrong is a hard 400 from Stripe, not a cosmetic slip.
    pub recurring: bool,
}

static PRICE_CACHE: LazyLock<RwLock<Option<(Instant, HashMap<String, LivePrice>)>>> =
    LazyLock::new(|| RwLock::new(None));
/// Long enough that the billing page is not making an API call per view; short enough
/// that editing a price in Stripe shows up without a deploy.
const PRICE_CACHE_TTL: Duration = Duration::from_secs(120);

/// Read every price this catalogue references straight from Stripe.
///
/// The amounts and the one-time/recurring flag used to be typed into the `prices` table
/// by hand, which meant two sources of truth for the same fact. They drift, and both ways
/// of drifting are bad: a wrong amount advertises a price you do not charge, and a wrong
/// `recurring` flag makes Stripe reject the checkout outright with "You must provide at
/// least one recurring price in subscription mode" — which is exactly how the test plan
/// broke. Asking Stripe removes the second copy.
///
/// Returns an empty map on any failure. Every caller falls back to the stored columns, so
/// Stripe being unreachable degrades the page to its previous behaviour rather than
/// emptying the shop.
async fn live_prices(state: &AppState) -> HashMap<String, LivePrice> {
    if let Some((at, cached)) = PRICE_CACHE.read().ok().and_then(|g| g.clone()) {
        if at.elapsed() < PRICE_CACHE_TTL {
            return cached;
        }
    }
    let Some(key) = secret_key() else {
        return HashMap::new();
    };

    // `currency_options` carries the per-currency amounts of a multi-currency price, and
    // `product` the name and description shown on the card. Neither is returned unless
    // expanded.
    let res = state
        .update_http
        .get(format!("{STRIPE_API}/prices"))
        .bearer_auth(&key)
        .query(&[
            ("limit", "100"),
            ("active", "true"),
            ("expand[]", "data.currency_options"),
            ("expand[]", "data.product"),
        ])
        .send()
        .await;
    let Ok(res) = res else { return HashMap::new() };
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
    let Some(list) = body.get("data").and_then(|v| v.as_array()) else {
        return HashMap::new();
    };

    let mut out: HashMap<String, LivePrice> = HashMap::new();
    for p in list {
        if let Some((lookup, live)) = parse_price(p) {
            out.insert(lookup, live);
        }
    }

    if let Ok(mut g) = PRICE_CACHE.write() {
        *g = Some((Instant::now(), out.clone()));
    }
    out
}

/// One entry of Stripe's `/v1/prices` list. Split out from the fetch so the shape it
/// expects can be tested against real Stripe payloads without a network call.
///
/// Returns None for a price with no `lookup_key`: the catalogue is keyed by it, and a
/// price that has none is one this gateway was never told to sell.
fn parse_price(p: &serde_json::Value) -> Option<(String, LivePrice)> {
    let lookup = p.get("lookup_key").and_then(|v| v.as_str())?;
    let base_ccy = p.get("currency").and_then(|v| v.as_str()).unwrap_or("");
    let base_amount = p.get("unit_amount").and_then(|v| v.as_i64());
    // A multi-currency price lists its other currencies here; the base one is not
    // repeated, so it has to be folded in by hand.
    let opt = |c: &str| {
        p.pointer(&format!("/currency_options/{c}/unit_amount"))
            .and_then(|v| v.as_i64())
    };
    // Blank strings are Stripe's "unset", not a name — treat them as absent so the card
    // falls back to the stored label instead of rendering an empty heading.
    let text = |path: &str| {
        p.pointer(path)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some((
        lookup.to_owned(),
        LivePrice {
            id: p.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
            cny_minor: opt("cny").or(if base_ccy == "cny" { base_amount } else { None }),
            usd_minor: opt("usd").or(if base_ccy == "usd" { base_amount } else { None }),
            currency: base_ccy.to_owned(),
            name: text("/product/name"),
            description: text("/product/description"),
            names: localized(p, "name"),
            descriptions: localized(p, "description"),
            recurring: p.get("recurring").map(|v| !v.is_null()).unwrap_or(false),
        },
    ))
}

/// Pull `name_xx` / `description_xx` out of a Stripe product's metadata.
///
/// Stripe metadata keys cannot contain a hyphen in practice for these, so `zh_CN` and
/// `zh-CN` are both accepted and normalised to the BCP-47 form the client asks for.
/// Blank values are dropped so an empty metadata field falls back rather than rendering
/// an empty product name.
fn localized(price: &serde_json::Value, field: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let Some(meta) = price.pointer("/product/metadata").and_then(|v| v.as_object()) else {
        return out;
    };
    let prefix = format!("{field}_");
    for (k, v) in meta {
        let Some(tag) = k.strip_prefix(&prefix) else { continue };
        let Some(text) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        out.insert(tag.replace('_', "-"), json!(text));
    }
    out
}

/// What a card should print: the amount, and the currency it is honest to print it in.
///
/// Checkout charges a price's base currency unless the buyer's currency has an entry in
/// `currency_options`, so quoting USD is only truthful when Stripe actually carries a USD
/// amount. Falling back to the stored USD column field-by-field is what produced a card
/// reading "¥4 · $0.15": Stripe had moved that price to ¥4 while the column still held the
/// $0.15 from when it was ¥1.
///
/// `stored` is (cny_minor, usd_minor) from the database, used only when Stripe said
/// nothing at all about this price.
fn display_amount(
    live: Option<&LivePrice>,
    stored: (i64, Option<i64>),
    want: &str,
) -> (Option<i64>, Option<i64>, String, Option<i64>) {
    let (cny, usd, currency) = match live {
        Some(p) => {
            // 买家要人民币、而这个价格在 Stripe 上确实有人民币金额，才显示人民币。
            // 否则退回美元 —— 日卡和三个加油包没有人民币价，中国买家看到的就是美元，
            // 那也是他们实际会被收的币种，卡上和结账页因此永远一致。
            let ccy = if want == "cny" && p.cny_minor.is_some() {
                "cny".to_owned()
            } else if p.usd_minor.is_some() {
                "usd".to_owned()
            } else {
                p.currency.clone()
            };
            (p.cny_minor, p.usd_minor, ccy)
        }
        None => (
            Some(stored.0),
            stored.1,
            if want == "cny" { "cny".to_owned() } else { "usd".to_owned() },
        ),
    };
    let minor = match currency.as_str() {
        "usd" => usd,
        "cny" => cny,
        _ => None,
    };
    (cny, usd, currency, minor)
}

/// `GET /api/admin/stripe/payments` — what Stripe says happened, for the console.
///
/// The console used to list the local `orders` table and offer a "confirm payment" button
/// beside each pending row. That table records checkout sessions we *created*, not money
/// that *arrived*, so an abandoned checkout sat there looking like an invoice awaiting
/// approval. Stripe is the only thing that knows whether a card was charged, so the
/// console asks Stripe.
///
/// Each row is reconciled against the local order so the operator can see the case that
/// actually matters: Stripe took the money and this gateway granted nothing.
pub async fn admin_payments(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    let Some(key) = secret_key() else {
        return Ok(Json(json!({ "configured": false, "payments": [], "unfulfilled": 0 })));
    };

    // Sessions rather than payment intents: a session carries the buyer's email, the
    // amount, the payment status and the id this gateway stored on its own order, so one
    // list answers every column the console shows.
    let res = state
        .update_http
        .get(format!("{STRIPE_API}/checkout/sessions"))
        .bearer_auth(&key)
        .query(&[("limit", "100")])
        .send()
        .await
        .map_err(|e| AppError::internal(format!("Stripe 无法访问：{e}")))?;
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
    if let Some(err) = body.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        return Err(AppError::internal(format!("Stripe 返回错误：{err}")));
    }
    let sessions = body.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // One query for every session on the page, not one per row.
    let ids: Vec<String> = sessions
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let local: std::collections::HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT stripe_session_id, status FROM orders WHERE stripe_session_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .collect();

    let mut unfulfilled = 0;
    let payments: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            let id = s.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let payment_status = s.get("payment_status").and_then(|v| v.as_str()).unwrap_or("");
            let paid = payment_status == "paid" || payment_status == "no_payment_required";
            let order_status = local.get(id).cloned();
            // The case worth alarming about: Stripe took the money, the local order never
            // reached 'paid'. Everything else is an abandoned checkout, which is normal.
            let needs_attention = paid && order_status.as_deref() != Some("paid");
            if needs_attention {
                unfulfilled += 1;
            }
            json!({
                "session_id": id,
                "created": s.get("created").and_then(|v| v.as_i64()),
                "amount": s.get("amount_total").and_then(|v| v.as_i64()),
                "currency": s.get("currency").and_then(|v| v.as_str()),
                "email": s.pointer("/customer_details/email").and_then(|v| v.as_str()),
                "status": s.get("status").and_then(|v| v.as_str()),
                "payment_status": payment_status,
                "paid": paid,
                "payment_intent": s.get("payment_intent").and_then(|v| v.as_str()),
                // None when Stripe knows about a session this gateway never recorded.
                "order_status": order_status,
                "needs_attention": needs_attention,
            })
        })
        .collect();

    Ok(Json(json!({
        "configured": true,
        "payments": payments,
        "unfulfilled": unfulfilled,
    })))
}

/// 这次请求按哪个币种定价，以及判定所依据的三个信号。
pub struct Buyer {
    pub currency: &'static str,
    pub country: Option<String>,
    pub language: Option<String>,
    pub timezone: Option<String>,
    pub offset_minutes: Option<i32>,
}

/// 中国大陆时区名。乌鲁木齐/喀什也算：它们在中国境内，只是历史上曾用过 +6。
const CN_ZONES: &[&str] = &[
    "asia/shanghai", "asia/chongqing", "asia/chungking", "asia/harbin",
    "asia/urumqi", "asia/kashgar", "asia/macau", "prc",
];

/// 简体中文标签。刻意不含 zh-TW / zh-HK / zh-Hant —— 那是港澳台，不按大陆价。
fn language_says_cn(tag: &str) -> bool {
    let t = tag.trim().to_ascii_lowercase();
    let t = t.split(|c| c == ';' || c == ',').next().unwrap_or("").trim();
    matches!(t, "zh" | "zh-cn" | "zh-hans" | "zh-hans-cn" | "zh-sg") || t.starts_with("zh-hans")
}

/// 判定这次请求是不是中国区买家。
///
/// 规则按需求原话实现：**语言和时区都指向中国，就算中国用户，哪怕 IP 不是**。
/// 换句话说 IP 只是三个信号之一，它单独为真也算（人在国内直连），但它为假否决不了
/// 另外两个都为真的情况（人在国内挂了代理，或者出差在外仍按国内价）。
///
///     is_cn = (语言=简中 且 时区=中国) 或 IP=CN
///
/// 时区那一腿要过 `validated_user_timezone`：客户端同时报时区名和 UTC 偏移，那个函数会
/// 检查「这个时区此刻的真实偏移」和声称的偏移是否一致，所以随手编一个 Asia/Shanghai
/// 但偏移填 -300 会被否掉。
///
/// **这条规则是可以被自己声明的**，而且这是需求本身要求的：把系统语言和时区都设成中国，
/// 就能拿到人民币价（¥100 ≈ US$14，比 $20 便宜三成）。这是「ip不对 那也是中国用户」
/// 这句话的必然代价。为此三个原始信号会原样写进订单行，事后有争议能查。
pub fn buyer_currency(headers: &HeaderMap) -> Buyer {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_string());

    let country = h("cf-ipcountry")
        .map(|s| s.to_ascii_uppercase())
        .filter(|s| s.len() == 2 && s != "XX" && s != "T1");

    // 优先用 IDE/前端显式上报的语言；退回浏览器每个请求都会带的 Accept-Language。
    let language = h("x-ide-language").or_else(|| h("accept-language"));
    let timezone = h("x-ide-timezone");
    let offset_minutes = h("x-ide-utc-offset-minutes").and_then(|s| s.parse::<i32>().ok());

    let lang_cn = language.as_deref().map(language_says_cn).unwrap_or(false);
    let tz_cn = match (timezone.as_deref(), offset_minutes) {
        (Some(name), Some(off)) => {
            crate::prompts::validated_user_timezone(name, off, chrono::Utc::now()).is_some()
                && CN_ZONES.contains(&name.trim().to_ascii_lowercase().as_str())
        }
        _ => false,
    };
    let ip_cn = country.as_deref() == Some("CN");

    let currency = if (lang_cn && tz_cn) || ip_cn { "cny" } else { "usd" };
    Buyer { currency, country, language, timezone, offset_minutes }
}

/// GET /api/billing/catalog — the Stripe-purchasable products, plus whether billing is
/// actually wired up. The page renders straight from this; it holds no prices of its own.
pub async fn catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    claims: Claims,
) -> ApiResult<Json<serde_json::Value>> {
    let uid = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;

    let rows = sqlx::query_as::<_, CatalogRow>(
        "SELECT id, label, kind, plan, duration_days, credits_cents, amount_cents, \
         amount_usd_cents, stripe_price_id, lookup_key, recurring, once_per_account, \
         unit_credits_cents, blurb \
         FROM prices \
         WHERE active = true AND lookup_key IS NOT NULL AND stripe_price_id IS NOT NULL \
         ORDER BY sort, created_at",
    )
    .fetch_all(&state.db)
    .await?;

    // A day pass is sold once per account; say so up front rather than letting the buyer
    // reach Stripe and get refused at fulfilment.
    //
    // 「refused at fulfilment」这半句在 2026-08 之前是空话：fulfil_session 把
    // once_per_account 读进来过，但一次都没看过它，重复付款照发。现在发放点真的会拒发
    // （并把订单打上待退款标记），这句话才成立 —— 见 fulfil_session 里的同名闸门。
    let spent_once: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT p.lookup_key FROM orders o JOIN prices p ON p.id = o.price_id \
         WHERE o.user_id = $1 AND o.status = 'paid' AND p.once_per_account = true \
           AND p.lookup_key IS NOT NULL",
    )
    .bind(uid)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // Stripe is the authority on price and on one-time-vs-subscription; the columns are
    // only a fallback for when it cannot be reached.
    let live = live_prices(&state).await;

    // 先定币种，再画卡片。原来这一句在下面 items 组装**之后**才调用，
    // 所以它算出来的答案根本没机会影响任何一张卡的价格。
    let buyer = buyer_currency(&headers);

    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let key = r.lookup_key.clone().unwrap_or_default();
            let lp = live.get(&key);
            // What a plan actually grants, from the same table apply_plan uses — so a
            // card can say "$49.77 included" instead of only quoting a price, and can
            // never drift from what the purchase really delivers.
            let spec = r.plan.as_deref().and_then(crate::settings::plan_spec);

            let (cny_minor, usd_minor, display_currency, display_minor) =
                display_amount(lp, (r.amount_cents, r.amount_usd_cents), buyer.currency);

            json!({
                "lookup_key": key,
                // Stripe's product name and description win: they are what the operator
                // edits, and the stored copies are only there for when Stripe is silent.
                "label": lp.and_then(|p| p.name.clone()).unwrap_or_else(|| r.label.clone()),
                "kind": r.kind,
                "plan": r.plan,
                "included_cents": spec.map(|s| s.0),
                "window_cap_cents": spec.map(|s| s.1),
                "weekly_cap_cents": spec.map(|s| s.2),
                "duration_days": r.duration_days,
                "credits_cents": r.credits_cents,
                "amount_cents": cny_minor,
                "amount_usd_cents": usd_minor,
                // What the card should print, and in which currency — decided here so the
                // page never has to guess which of the two amounts Stripe will honour.
                "display_currency": display_currency,
                "display_minor": display_minor,
                "recurring": lp.map(|p| p.recurring).unwrap_or(r.recurring),
                "once_per_account": r.once_per_account,
                "unit_credits_cents": r.unit_credits_cents,
                "blurb": lp.and_then(|p| p.description.clone()).unwrap_or_else(|| r.blurb.clone()),
                // Whole maps, not a pre-picked language: the catalogue is cached for two
                // minutes and shared by every reader, so the language has to be chosen
                // per request — which the client does anyway, from its own setting.
                "labels": lp.map(|p| p.names.clone()).unwrap_or_default(),
                "blurbs": lp.map(|p| p.descriptions.clone()).unwrap_or_default(),
                "already_purchased": spent_once.contains(&key),
            })
        })
        .collect();

    Ok(Json(json!({
        "enabled": secret_key().is_some(),
        "raw_cents_per_credit_usd": crate::settings::raw_cents_per_credit_usd(),
        "currency": buyer.currency,
        "country": buyer.country,
        "items": items,
    })))
}

#[derive(Deserialize)]
pub struct CheckoutReq {
    pub lookup_key: String,
    /// Only meaningful for the quantity-priced top-up; clamped below.
    #[serde(default)]
    pub quantity: Option<i64>,
}

/// POST /api/billing/checkout — create a Stripe Checkout Session and hand back its URL.
pub async fn checkout(
    State(state): State<AppState>,
    claims: Claims,
    // Json 必须在最后：它是消费请求体的提取器，顺序错了编译就过不去。
    headers: HeaderMap,
    Json(req): Json<CheckoutReq>,
) -> ApiResult<Json<serde_json::Value>> {
    let key = secret_key().ok_or_else(|| {
        AppError::bad("支付尚未配置：网关缺少 STRIPE_SECRET_KEY")
    })?;
    let uid = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;

    let row = sqlx::query_as::<_, CatalogRow>(
        "SELECT id, label, kind, plan, duration_days, credits_cents, amount_cents, \
         amount_usd_cents, stripe_price_id, lookup_key, recurring, once_per_account, \
         unit_credits_cents, blurb \
         FROM prices WHERE lookup_key = $1 AND active = true",
    )
    .bind(&req.lookup_key)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::bad("商品不存在或已下架"))?;

    // Resolved by lookup key, not from the stored column. A Stripe price is immutable:
    // changing an amount means creating a NEW price and moving the lookup key onto it.
    // Reading the id from the key means that move is all it takes — no row to update, and
    // no window where the database points at the old price while Stripe has the new one.
    // The stored column stays as the fallback for when Stripe cannot be reached.
    let live = live_prices(&state).await;
    let live_entry = live.get(&req.lookup_key);
    let price_id = live_entry
        .map(|p| p.id.clone())
        .filter(|id| !id.is_empty())
        .or_else(|| row.stripe_price_id.clone())
        .ok_or_else(|| AppError::bad("该商品未绑定 Stripe 价格"))?;

    // Quantity only applies where the row prices per unit; everything else is one.
    let quantity = if row.unit_credits_cents.is_some() {
        req.quantity.unwrap_or(1).clamp(1, 100_000)
    } else {
        1
    };

    // 友好前置检查，**不是**那道闸。
    //
    // 这里数的是「已付款」的订单，而 N 个还没付款的 checkout 全都能通过它：连开 N 个
    // 日卡结账、一个都不付，N 次查询看到的都是 0。真正拦住重复发放的是 fulfil_session
    // 里的同名检查（在发放点，且带 users 行锁）。这一条留着只为一件事：让重复购买在
    // **付款之前**就被挡回去，而不是收了钱再由人去退。
    if row.once_per_account {
        let already: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM orders WHERE user_id = $1 AND price_id = $2 AND status = 'paid'",
        )
        .bind(uid)
        .bind(row.id)
        .fetch_one(&state.db)
        .await?;
        if already > 0 {
            return Err(AppError::bad("该商品每个账号仅限购买一次"));
        }
    }

    // Ask Stripe what this price is rather than trusting the stored flag. A row that
    // says "recurring" over a one-time price makes Stripe reject the session outright
    // ("You must provide at least one recurring price in subscription mode"), which is a
    // Subscribe button that silently does nothing. Stripe is the only thing that
    // actually knows, so it is the thing that decides.
    let recurring = live_entry.map(|p| p.recurring).unwrap_or(row.recurring);
    let mode = if recurring { "subscription" } else { "payment" };
    let base = public_base();

    /*
     * 中国区按人民币收，其余按美元。
     *
     * 判定条件用的是**这个价格在 Stripe 上有没有人民币金额**（currency_options），而不是
     * 库里的 amount_cents —— 现在每一行都填了人民币展示价，但日卡和三个加油包在 Stripe 上
     * 并没有人民币价，照着库里的列去指定 cny 会被 Stripe 直接 400，买按钮就死了。
     *
     * live_prices 任何失败都返回空表，所以 Stripe 抖动时会退回美元 —— 往安全的一边退。
     */
    let buyer = buyer_currency(&headers);
    let charge_ccy = if buyer.currency == "cny"
        && live_entry.and_then(|p| p.cny_minor).is_some()
    {
        "cny"
    } else {
        "usd"
    };

    // Form-encoded: Stripe's API does not take JSON.
    let mut form: Vec<(String, String)> = vec![
        ("mode".into(), mode.into()),
        ("line_items[0][price]".into(), price_id),
        ("line_items[0][quantity]".into(), quantity.to_string()),
        (
            "success_url".into(),
            // 复用 /billing：nginx 里 /billing 和 /dashboard 是逐条写死的 location，
            // 新加一个路径要改 nginx，而 nginx 配置来自仓库、手改会被下次部署覆盖。
            // 带上 session id，前端据此渲染支付成功页而不是商品列表。
            format!("{base}/billing?paid={{CHECKOUT_SESSION_ID}}"),
        ),
        ("cancel_url".into(), format!("{base}/billing?canceled=1")),
        ("client_reference_id".into(), uid.to_string()),
        ("customer_email".into(), claims.email.clone()),
        // Echoed back on the webhook. The webhook re-reads the row anyway, but carrying
        // the ids makes a delivery self-describing when reading Stripe's event log.
        ("metadata[user_id]".into(), uid.to_string()),
        ("metadata[lookup_key]".into(), req.lookup_key.clone()),
        ("metadata[price_row]".into(), row.id.to_string()),
        ("metadata[quantity]".into(), quantity.to_string()),
    ];
    if charge_ccy == "cny" {
        form.push(("currency".into(), "cny".into()));
    }
    /*
     * 这里曾经打开 adjustable_quantity，让买家在 Stripe 页面上改数量。它必须关掉。
     *
     * 发放走的是 metadata[quantity]（fulfil_session 读它，再乘 unit_credits_cents），而
     * adjustable_quantity 允许买家在**付款前**把数量调下去。于是：下单时填 100000，到
     * Stripe 页面改成 1，付一份的钱，拿到 100000 份的额度。
     *
     * 按当前的每份面额，这是花 $0.15 拿走约 $15,000 的余额；按新价率（每 $1 = 2.5 额度、
     * 每份 1658）是 $25 万。要让它安全，得在履约时改从 line_items 读**实际结算数量**，
     * 那要多一次 API 调用和一条新的失败路径；关掉这三行没有任何新的失败模式，
     * 想买多少在我们自己的页面上填。
     */

    let res = state
        .update_http
        .post(format!("{STRIPE_API}/checkout/sessions"))
        .bearer_auth(&key)
        // Retrying a failed create must not open two sessions for the same intent — but
        // the key has to move whenever the request does, and it must not outlive the
        // attempt it belongs to. The old key was (user, product, quantity) and broke both
        // ways:
        //
        //   * Stripe remembers a key for 24h and rejects it outright if the parameters
        //     differ. Fixing this product's mode from subscription to payment therefore
        //     locked the buyer out for a day with an idempotency_error, not a price
        //     error — the Subscribe button simply kept failing.
        //   * Buying the same product twice inside 24h replayed the FIRST session instead
        //     of opening a new one, handing the buyer a checkout they had already used.
        //
        // So: everything that shapes the request goes in, plus a 5-minute bucket. A
        // network retry seconds later still collapses onto one session; a genuine second
        // purchase gets a genuine second session.
        .header(
            "Idempotency-Key",
            format!(
                "co_{uid}_{}_{quantity}_{mode}_{charge_ccy}_{}",
                req.lookup_key,
                chrono::Utc::now().timestamp() / 300
            ),
        )
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::internal(format!("Stripe 不可达：{e}")))?;

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let msg = body
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("Stripe 拒绝了这次结账请求");
        tracing::warn!("Stripe checkout failed ({status}): {body}");
        return Err(AppError::bad(msg.to_string()));
    }

    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::internal("Stripe 未返回结账地址"))?;
    let session_id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default();

    // Record the intent now so an abandoned checkout is still visible in the admin
    // order list; the webhook flips it to 'paid'.
    let credits = row
        .unit_credits_cents
        .map(|u| u.saturating_mul(quantity))
        .or(row.credits_cents);
    sqlx::query(
        // 三个原始信号一起落库：定价争议（「为什么我看到的是美元」）只能靠它回答。
        "INSERT INTO orders (user_id, email, price_id, kind, plan, duration_days, credits_cents, \
         amount_cents, method, status, stripe_session_id, quantity, \
         resolved_currency, signal_country, signal_language, signal_timezone, \
         signal_offset_minutes) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'stripe','pending',$9,$10,$11,$12,$13,$14,$15) \
         ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING",
    )
    .bind(uid)
    .bind(&claims.email)
    .bind(row.id)
    .bind(&row.kind)
    .bind(&row.plan)
    .bind(row.duration_days)
    .bind(credits)
    .bind(row.amount_cents.saturating_mul(quantity))
    .bind(session_id)
    .bind(quantity as i32)
    .bind(charge_ccy)
    .bind(&buyer.country)
    .bind(&buyer.language)
    .bind(&buyer.timezone)
    .bind(buyer.offset_minutes)
    .execute(&state.db)
    .await?;

    // 币种回给前端：卡上写的和实际要收的一旦不一致，页面能当场发现。
    Ok(Json(json!({ "url": url, "session_id": session_id, "currency": charge_ccy })))
}

/// Constant-time compare so a wrong signature leaks nothing through timing.
fn secure_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verify Stripe's `Stripe-Signature` header against the raw body.
///
/// The body must be the bytes as received — parsing to JSON and re-serialising changes
/// whitespace and key order, and the signature would never match again.
fn verify_signature(secret: &str, header: &str, body: &[u8]) -> Result<(), String> {
    let mut timestamp: Option<i64> = None;
    let mut signatures: Vec<&str> = Vec::new();
    for part in header.split(',') {
        let Some((k, v)) = part.trim().split_once('=') else { continue };
        match k {
            "t" => timestamp = v.parse().ok(),
            // v1 is the current scheme; v0 is a test-mode artefact and is not accepted.
            "v1" => signatures.push(v),
            _ => {}
        }
    }
    let timestamp = timestamp.ok_or("签名缺少时间戳")?;
    if signatures.is_empty() {
        return Err("签名缺少 v1".into());
    }

    let age = chrono::Utc::now().timestamp() - timestamp;
    if age.abs() > SIGNATURE_TOLERANCE_SECS {
        return Err(format!("签名时间戳超出容忍窗口（{age}s）"));
    }

    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .map_err(|_| "Webhook 密钥无效".to_string())?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    let expected = mac.finalize().into_bytes();
    let expected_hex = hex_lower(&expected);

    if signatures
        .iter()
        .any(|s| secure_eq(s.as_bytes(), expected_hex.as_bytes()))
    {
        Ok(())
    } else {
        Err("签名不匹配".into())
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// POST /api/webhooks/stripe — the only endpoint that may grant a plan or credits
/// without an admin. Unauthenticated by design: Stripe proves who it is with the
/// signature, so an unsigned or stale request is rejected before anything is read.
pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    let secret = webhook_secret()
        .ok_or_else(|| AppError::bad("Webhook 未配置：网关缺少 STRIPE_WEBHOOK_SECRET"))?;
    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::unauthorized("缺少 Stripe-Signature"))?;

    verify_signature(&secret, sig, &body).map_err(|e| {
        tracing::warn!("Stripe webhook rejected: {e}");
        AppError::unauthorized(format!("Stripe 签名校验失败：{e}"))
    })?;

    let event: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| AppError::bad("事件体不是 JSON"))?;
    let event_id = event.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or_default();
    if event_id.is_empty() {
        return Err(AppError::bad("事件缺少 id"));
    }

    // Idempotency gate — and the grant it guards — in ONE transaction.
    //
    // This used to claim the event on its own connection, commit, and only then fulfil.
    // That combination loses paid orders in silence: if fulfilment then failed for any
    // transient reason (deadlock, pool timeout, a dropped connection), the handler
    // returned 500, Stripe retried, and the retry found the id already present and
    // answered `200 duplicate` — so Stripe stopped retrying and the grant never
    // happened. The customer was charged and received nothing, and both systems
    // reported success. Nothing else would have caught it: there is no reconciliation
    // job, and `invoice.paid` never fires for a one-off purchase.
    //
    // Sharing one transaction makes the claim conditional on the grant. A failure rolls
    // BOTH back, so Stripe's next delivery genuinely re-runs the work. The "give up"
    // paths below (unknown product, unusable user id) deliberately return Ok and let the
    // claim commit — retrying those cannot change the outcome, so they must not loop.
    let mut tx = state.db.begin().await?;
    let claimed =
        sqlx::query("INSERT INTO stripe_events (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING")
            .bind(event_id)
            .bind(event_type)
            .execute(&mut *tx)
            .await?;
    if claimed.rows_affected() == 0 {
        return Ok(Json(json!({ "ok": true, "duplicate": true })));
    }

    // Anything user-visible is recorded AFTER the commit — an event announced from
    // inside a transaction that later rolls back is a lie told to the admin console.
    let mut post_commit: Vec<(uuid::Uuid, &'static str, serde_json::Value)> = Vec::new();
    // 履约单独收着：回执和 order_paid 不再挂在 webhook 自己身上，而是交给
    // announce_fulfilment —— 三条能赢下竞态的路径共用同一个出口。见那个函数的注释。
    let mut fulfilled: Vec<(Fulfilled, &'static str)> = Vec::new();

    match event_type {
        // Covers both one-off payments and the first period of a subscription.
        "checkout.session.completed" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            // Only fulfil once the money is actually there. Async methods can complete
            // the session while payment is still pending.
            let paid = obj
                .get("payment_status")
                .and_then(|v| v.as_str())
                .map(|s| s == "paid" || s == "no_payment_required")
                .unwrap_or(false);
            if paid {
                if let Some(f) = fulfil_session(&mut tx, &obj).await? {
                    fulfilled.push((f, "stripe"));
                }
            }
        }
        // Fallback for an endpoint that was never subscribed to
        // checkout.session.completed. That is the only event carrying who bought what, so
        // without it the money lands and nothing is granted — which is exactly what
        // happened here: charge.succeeded and payment_intent.succeeded arrived, the
        // session event did not, and the buyer got nothing.
        //
        // Stripe can map a payment intent back to its session, so the missing event can be
        // reconstructed. Double-granting is prevented by the session claim inside
        // fulfil_session, not by hoping only one of the two events is subscribed.
        "payment_intent.succeeded" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            let pi = obj.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_owned();
            if !pi.is_empty() {
                if let Some(session) = session_for_payment_intent(&state, &pi).await {
                    if let Some(f) = fulfil_session(&mut tx, &session).await? {
                        tracing::info!("fulfilled {pi} via payment_intent fallback");
                        fulfilled.push((f, "stripe"));
                    }
                }
            }
        }
        // Renewals. The first invoice of a subscription arrives here too, but the
        // session already granted it and `stripe_events` keeps that from doubling up
        // only per-event — so renewals are matched on the subscription id instead.
        // BOTH names, because Stripe sends two events for one paid invoice and an endpoint
        // receives only what it is subscribed to. This endpoint's subscription list has
        // `invoice.payment_succeeded` and NOT `invoice.paid` — checked against the live
        // account on 2026-08-11 — so listening for `invoice.paid` alone meant renewals
        // never reached this code at all: no extra month granted, no commission, nothing.
        // No subscription had renewed yet, so nothing was actually lost.
        //
        // Handling both is safe rather than merely tolerable: the two events carry the same
        // invoice, and `fulfil_renewal` claims on the invoice id, so whichever arrives second
        // finds the claim taken and stops. Being subscribed to both is now the harmless case
        // instead of the double-grant it would have been before that claim existed.
        "invoice.paid" | "invoice.payment_succeeded" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            fulfil_renewal(&mut tx, &obj).await?;
        }
        // The subscription is over — cancelled, or dunning finally gave up. Until this
        // was handled, cancelling in Stripe never reached this database at all: the row
        // kept its plan and its quota, so a cancelled subscriber went on being served
        // forever. This is the event that actually ends a paid relationship.
        "customer.subscription.deleted" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            if let Some(uid) = end_subscription(&mut tx, &obj).await? {
                post_commit.push((uid, "user_updated", json!({ "by": "stripe", "action": "subscription_deleted" })));
            }
        }
        // Mid-life changes. Only the terminal statuses act: `cancel_at_period_end` is
        // NOT one of them — that subscriber has paid through the end of the period and
        // keeps everything until `deleted` arrives. Revoking here would be taking away
        // time they already bought.
        "customer.subscription.updated" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            let status = obj.get("status").and_then(|v| v.as_str()).unwrap_or_default();
            if is_terminal_subscription_status(status) {
                if let Some(uid) = end_subscription(&mut tx, &obj).await? {
                    post_commit.push((uid, "user_updated", json!({ "by": "stripe", "action": "subscription_ended", "status": status })));
                }
            }
        }
        // The money went back. A refunded or disputed purchase must stop paying its
        // referrer — until this existed, a customer could buy, generate a commission, and
        // be refunded in full while the commission stayed on the books as earned.
        //
        // Entitlement is deliberately NOT revoked here. Refunds are issued for all sorts of
        // reasons, some of them goodwill, and cutting off access on the strength of a
        // webhook is the kind of thing that hurts the wrong person. Commission is the part
        // that is unambiguous: no sale, no commission.
        "charge.refunded" | "charge.dispute.created" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            /*
             * 按退款比例追回，而不是一律整笔作废（规范 7.3：
             * clawbackRatio = refund.amount / order.amount_total）。
             *
             * charge.refunded 在部分退款时也会触发，amount_refunded < amount。之前这里
             * 不看金额，客户退 $10 就把整笔佣金抹掉 —— 少付推荐人。
             *
             * 拒付（dispute）没有部分之说，对象上也没有 amount_refunded，按全额处理。
             */
            let amount = obj.get("amount").and_then(|v| v.as_i64()).unwrap_or(0);
            let refunded = obj.get("amount_refunded").and_then(|v| v.as_i64()).unwrap_or(0);
            let ratio_bps = if event_type == "charge.refunded" {
                if amount > 0 && refunded > 0 {
                    ((refunded.min(amount) * 10_000) / amount).clamp(0, 10_000)
                } else {
                    10_000
                }
            } else {
                10_000
            };
            // 退了多少钱，也要落库（20260876）。这个数上面已经解析出来了，此前算完比例
            // 就扔掉，于是收入汇总永远不知道该扣多少，部分退款和全额退款在库里同形。
            //
            // 拒付走的是另一条：`charge.dispute.created` 的对象上没有 `amount_refunded`，
            // 佣金按全额追回，金额这里取 `amount`（被拒付的那一整笔）。两条路都不写 0 ——
            // 0 的意思是「确实一分没退」，而这两条路都退了钱。
            let refunded_cents = if event_type == "charge.refunded" {
                refunded.min(amount).max(0)
            } else {
                amount.max(0)
            };
            if let Some(order_id) = order_for_reversal(&state, &mut tx, &obj).await? {
                // 先把退款记在订单上。退过款的 Checkout Session 在 Stripe 那边仍然报
                // payment_status: paid，所以没有这个标记，履约和计佣还能再跑一遍。
                // **不许吞。** 这一句报错会让整个事务作废，而 Postgres 对作废事务的
                // COMMIT 是静默 ROLLBACK 且不报错 —— 于是 handler 照回 200，Stripe
                // 认为投递成功不再重投，连上面那条幂等认领也一起回滚了。
                // 用 `?` 才走得到本函数开头那段注释设计的路：500 → Stripe 重投 → 真的重跑。
                // 金额用 GREATEST 累加式取大：同一单可以退好几次，Stripe 每次都把
                // **累计**的 amount_refunded 发过来，而 webhook 不保证按顺序到达。
                // 直接覆盖的话，一条迟到的「退了 $10」会把后来的「累计退了 $30」盖掉。
                // 取大在乱序下也收敛到最终值，且永远不会把已记的退款额调小。
                //
                // `$2 <= 0` 时**不写**，让这一列留 NULL。NULL 的意思是「没记到金额」，
                // 0 的意思是「确实一分没退」—— 收入汇总要能分开这两件事。回执里没有
                // 金额（字段缺失、对象形状变了）却写个 0 进去，等于用一个确定的假事实
                // 盖住「不知道」，而这一列存在的全部理由就是别再让退款额靠猜。
                sqlx::query(
                    "UPDATE orders SET refunded_at = COALESCE(refunded_at, now()), \
                     refunded_cents = CASE WHEN $2 > 0 \
                       THEN GREATEST(COALESCE(refunded_cents, 0), $2) \
                       ELSE refunded_cents END WHERE id = $1",
                )
                .bind(order_id)
                .bind(refunded_cents)
                .execute(&mut *tx)
                .await?;
                crate::referral::reverse(&mut tx, order_id, event_type, ratio_bps).await;
            }
        }
        // Nobody paid, and now nobody can. Closes the order so 「待付款」 means something and
        // the reconciler's queue does not grow forever. The reconciler catches these too, on
        // a ten-minute delay; this is the same job done immediately.
        "checkout.session.expired" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            if let Some(sid) = obj.get("id").and_then(|v| v.as_str()) {
                sqlx::query(
                    "UPDATE orders SET status = 'canceled' \
                     WHERE stripe_session_id = $1 AND status = 'pending'",
                )
                .bind(sid)
                .execute(&mut *tx)
                .await?;
            }
        }
        // A referrer's connected account changed — usually onboarding finishing, sometimes
        // Stripe withdrawing a capability. Nothing is cached from it (readiness is asked
        // fresh at payout time), so this exists to tell the browser to re-read the screen
        // the person is very likely staring at, having just come back from Stripe.
        "account.updated" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            if let Some(acct) = obj.get("id").and_then(|v| v.as_str()) {
                let uid: Option<uuid::Uuid> = sqlx::query_scalar(
                    "SELECT id FROM users WHERE stripe_connect_account_id = $1",
                )
                .bind(acct)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some(uid) = uid {
                    post_commit.push((
                        uid,
                        "connect_updated",
                        json!({
                            "payouts_enabled": obj.get("payouts_enabled").and_then(|v| v.as_bool()),
                            "details_submitted": obj.get("details_submitted").and_then(|v| v.as_bool()),
                        }),
                    ));
                }
            }
        }
        // A payout we sent came back. The referrer never got the money, so it has to return
        // to their withdrawable balance — `withdrawable` excludes 'returned' for exactly
        // this. Told apart from 'failed' on purpose: this one did leave and came back, and
        // "what happened to my payout" deserves the true answer.
        "transfer.reversed" | "transfer.failed" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            if let Some(tr) = obj.get("id").and_then(|v| v.as_str()) {
                /*
                 * 只有整笔冲回才把这条提现放回余额。
                 *
                 * Stripe 的 transfer 可以被部分冲回：一笔 $50 的转账冲回 $10，事件同样是
                 * transfer.reversed。之前这里只看事件名，直接把整行标成 returned，而
                 * withdrawable() 是整行剔除的 —— $50 全部回到可提现余额，用户再提一次，
                 * 于是 $40 被付了两遍。
                 *
                 * `reversed` 是 Stripe 自己给的「是否已全额冲回」，比自己拿
                 * amount_reversed 和金额相比更可靠（金额单位、币种都不用我们再判断一次）。
                 */
                let fully = obj
                    .get("reversed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(event_type == "transfer.failed");
                if !fully {
                    tracing::warn!(
                        transfer = %tr,
                        amount_reversed = ?obj.get("amount_reversed"),
                        "partial transfer reversal — withdrawal left as paid, needs a person"
                    );
                }
                let row: Option<(uuid::Uuid, i64)> = sqlx::query_as(
                    "UPDATE withdrawals SET status = $2, updated_at = now(), \
                         failure_reason = $3 \
                     WHERE transfer_id = $1 AND status = 'paid' AND $4 \
                     RETURNING user_id, amount_cents",
                )
                .bind(tr)
                .bind(if event_type == "transfer.reversed" { "returned" } else { "failed" })
                .bind(event_type)
                .bind(fully)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some((uid, cents)) = row {
                    tracing::warn!(transfer = %tr, %uid, cents, "payout came back");
                    /*
                     * 钱回来了，被这次打款锁走的佣金也必须一起放回去 —— kit 在
                     * PayoutService 里对 FAILED/RETURNED 做的就是这件事。
                     *
                     * 少了这一步，佣金会永远停在 paid：不会被支付（打款已经失败），也不会
                     * 再被下一轮扫到（扫的是 settled）。推荐人的钱凭空消失，而且没有任何报错。
                     */
                    let released: Option<i64> = sqlx::query_scalar(
                        "WITH back AS ( \
                             UPDATE commissions SET status = 'settled', payout_id = NULL, \
                                 updated_at = now() \
                             WHERE payout_id = (SELECT id FROM withdrawals WHERE transfer_id = $1) \
                               AND status = 'paid' \
                             RETURNING 1 \
                         ) SELECT count(*)::bigint FROM back",
                    )
                    .bind(tr)
                    .fetch_optional(&mut *tx)
                    .await?;
                    if let Some(n) = released {
                        if n > 0 {
                            tracing::warn!(transfer = %tr, released = n, "commissions released back to settled");
                        }
                    }
                    post_commit.push((
                        uid,
                        "withdrawal_decided",
                        json!({ "status": "returned", "amount_cents": cents, "by": "stripe" }),
                    ));
                }
            }
        }
        // The dispute is over. If we won it, the money stayed with us all along and the
        // commission we reversed on `charge.dispute.created` should not have been.
        "charge.dispute.closed" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            let won = obj.get("status").and_then(|v| v.as_str()) == Some("won");
            if won {
                if let Some(order_id) = order_for_reversal(&state, &mut tx, &obj).await? {
                    // 金额也要一起撤。只清时间戳的话，这一单在收入汇总里既算「没退款」
                    // （refunded_at 为空）又留着一个退款额，两个字段自相矛盾。
                    sqlx::query("UPDATE orders SET refunded_at = NULL, refunded_cents = NULL WHERE id = $1")
                        .bind(order_id)
                        .execute(&mut *tx)
                        .await?;
                    crate::referral::unreverse(&mut tx, order_id).await;
                }
            }
        }
        // A renewal charge failed. Deliberately does NOT revoke: Stripe retries on its
        // own schedule for days, and cutting a paying customer off on the first failed
        // attempt would be wrong. Record it so it is visible, and let the terminal
        // events above do the revoking if it never recovers.
        "invoice.payment_failed" => {
            let obj = event.pointer("/data/object").cloned().unwrap_or(json!({}));
            if let Some(sub) = subscription_id_of(&obj) {
                if let Some(uid) = user_for_subscription(&mut tx, &sub).await? {
                    post_commit.push((uid, "payment_failed", json!({ "via": "stripe", "subscription": sub })));
                }
            }
        }
        _ => {}
    }

    tx.commit().await?;

    // 付款成功要发回执。**必须在提交之后**——事务里发信的话，事务一回滚就成了
    // 「钱没扣、回执已经发出去」。
    //
    // 在这之前 receipt::purchase_html 在整个 server/src 的生产代码里**零调用点**：
    // 全仓构造 Receipt 的三处都在测试模块里。也就是说付了钱的用户手里没有任何
    // 金额/额度/有效期/订单号的凭据，而退订页明确写着「回执照发」。
    //
    //（这段注释刻意不写出那个 cfg 属性的字面量：本文件里有一条测试用它来切分生产代码，
    // 注释里出现一次就会把它的切点提前，让断言在错误的范围上求值。）
    for (f, via) in fulfilled {
        announce_fulfilment(&state, &f, via).await;
    }

    for (uid, kind, payload) in post_commit {
        crate::realtime::record_event(&state, Some(uid), kind, payload).await;
    }

    Ok(Json(json!({ "ok": true })))
}

/// 一次履约的收尾：回执 + `order_paid`，由**真正完成这次发放的那条路径**发，正好一次。
///
/// 能赢下履约竞态的有三条：webhook、对账扫描（`reconcile_once`）、支付成功页
/// （`session_result`）。回执和 order_paid 原来只挂在 webhook 的提交后循环上，而成功页
/// 抢先是**常态**——Stripe 先把浏览器重定向回来，webhook 是另一条链路，晚几百毫秒到几秒
/// 都正常。成功页赢下的那一笔，webhook 随后拿到的是「已经付过了」（`Ok(None)`），于是
/// 买家一封回执都收不到，而退订页明确写着「回执照发」。对账扫描那条也一样，它记了事件
/// 但从不发回执。
///
/// 不会重复发：`fulfil_session` 只对**认领成功**的那一次返回 `Some`，另外两条拿到
/// `None`，压根不会走到这里。
async fn announce_fulfilment(state: &AppState, f: &Fulfilled, via: &str) {
    if !f.granted {
        /*
         * 钱收了，货没发（once_per_account 已经用过）。
         *
         * 这里刻意**不**发回执：回执上写着买到了什么额度、有效期多久，而这一笔什么都
         * 没买到，发出去就是一句谎。也刻意**不**自动退款：webhook 里自动动钱是更坏的
         * 失败模式（一次误判就是一笔真金退出去，且没有人在环里）。
         *
         * 所以只做一件事——记一条运营看得见的事件，点名这笔订单，由人去决定退不退。
         * 「多收的这笔怎么办」是产品决策，代码只保证两条底线：不多发额度、不静默吞钱。
         *
         * 但**别把下面这条事件当成账**，它三头都靠不住：record_event 跑在事务提交之后，
         * 失败只 warn（realtime.rs），提交完到发事件之间崩一下，通知就没了而钱照收；
         * 控制台的动态只读 events 最后 50 条（realtime.rs 的 recent_events），忙的一天
         * 几分钟就翻过去；而 order_needs_refund 在控制台 EVENT_LABEL 里没有条目，
         * 翻到了也只显示原始 kind。
         *
         * 耐久的那份留痕是 orders.note：它在 fulfil_session 的**同一个事务**里写，和
         * 「这笔钱记成 paid」同生共死。所以运营事后要捞这些单，跑的是这句，不是翻动态：
         *
         *   SELECT id, user_id, created_at, amount_cents FROM orders
         *    WHERE note LIKE 'once_per_account:%' AND refunded_at IS NULL
         *    ORDER BY created_at DESC;
         *
         *（前缀由 ONCE_PER_ACCOUNT_REFUND_NOTE 定，fulfilment_gate_tests 有一条断言钉着
         * 它——改了前缀这句 SQL 不报错，只是静默捞不到单。控制台缺的那条 EVENT_LABEL 和
         * 订单备注列要单独开一张单子，不在本文件里。）
         */
        crate::realtime::record_event(
            state,
            Some(f.user),
            "order_needs_refund",
            json!({
                "via": via,
                "product": f.label,
                "quantity": f.quantity,
                "session": f.session,
                "order": f.order.map(|id| id.to_string()),
                "reason": "once_per_account",
            }),
        )
        .await;
        return;
    }

    if !f.session.is_empty() {
        let st = state.clone();
        let (uid, session) = (f.user, f.session.clone());
        // 分离出去：发信失败绝不能让调用方失败 —— webhook 回非 2xx 会让 Stripe 一直重投一个
        // **已经完成**的事件，而重投什么都改变不了（幂等认领会直接跳过）。
        tokio::spawn(async move { send_purchase_receipt(&st, uid, &session).await });
    }
    crate::realtime::record_event(
        state,
        Some(f.user),
        "order_paid",
        json!({
            "via": via, "product": f.label, "quantity": f.quantity, "session": f.session,
        }),
    )
    .await;
}

/// 给刚付款成功的那一笔发一封回执。
///
/// 只读已提交的订单行，所以必须在事务提交之后调用。任何一步取不到就安静放弃：
/// 回执是锦上添花，缺了不该影响入账，更不该让 webhook 回非 2xx。
async fn send_purchase_receipt(state: &AppState, uid: uuid::Uuid, session: &str) {
    if !state.cfg.mail_enabled() {
        return;
    }
    // 判据是 `charged_cents IS NULL`，不是「等于 0」。
    //
    // 原来是 `NULLIF(o.charged_cents, 0)`：整单优惠券会产生一笔**真实的 0 元**收款，
    // 那条 NULLIF 把它当成「没记录收了多少」，于是回执上印的是目录标价 ——
    // 客户明明一分没付，收到的邮件写着 ¥295。
    // 「收了 0 元」和「没记录收了多少」是两件事，只有 NULL 表示后者。
    let row: Option<(String, Option<String>, Option<i32>, i64, i64, Option<String>, uuid::Uuid)> =
        sqlx::query_as(
            "SELECT COALESCE(o.email, u.email), o.plan, o.duration_days, o.credits_cents, \
                    COALESCE(o.charged_cents, o.amount_cents), o.charged_currency, o.id \
               FROM orders o LEFT JOIN users u ON u.id = o.user_id \
              WHERE o.stripe_session_id = $1 LIMIT 1",
        )
        .bind(session)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let Some((email, plan, days, credits_cents, charged, currency, order_id)) = row else {
        tracing::warn!(%uid, session, "找不到订单行，回执跳过");
        return;
    };
    if email.trim().is_empty() {
        return;
    }

    let cur = currency.unwrap_or_else(|| "usd".into()).to_uppercase();
    let symbol = match cur.as_str() {
        "CNY" => "¥",
        "USD" => "$",
        _ => "",
    };
    let amount = format!("{symbol}{:.2}", charged as f64 / 100.0);
    let product = plan.clone().unwrap_or_else(|| "额度充值".into());
    let granted = if credits_cents > 0 {
        // 额度是按真实计费分存的，展示要折成用户看得懂的面值（settings 里那个分母）。
        format!(
            "${:.2} 额度",
            credits_cents as f64 / crate::settings::raw_cents_per_credit_usd().max(1) as f64
        )
    } else {
        format!("{product} 会员")
    };
    let duration = days.filter(|d| *d > 0).map(|d| format!("{d} 天"));
    let base = state.cfg.public_base.trim_end_matches('/');
    let html = crate::receipt::purchase_html(&crate::receipt::Receipt {
        product: &product,
        amount: &amount,
        granted: &granted,
        duration: duration.as_deref(),
        order_id: &order_id.to_string(),
        console_url: &format!("{base}/billing"),
        logo_url: &format!("{base}/api/logo.png"),
    });
    if let Err(err) = crate::email::send_mail(
        &state.cfg,
        &email,
        &format!("购买回执 · {product}"),
        &html,
        true,
    )
    .await
    {
        tracing::warn!(reason = %err.msg, %uid, "购买回执发送失败");
    }
}

/// Statuses from which a subscription never comes back, so entitlement should end.
///
/// `past_due` is absent on purpose: Stripe is still retrying the card, and the
/// subscriber has not lost anything yet. `trialing` and `active` are obviously alive.
/// `paused` is absent too — it resumes.
fn is_terminal_subscription_status(status: &str) -> bool {
    matches!(status, "canceled" | "unpaid" | "incomplete_expired")
}

/// Which account a Stripe subscription belongs to, via the order that created it.
async fn user_for_subscription(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sub: &str,
) -> ApiResult<Option<uuid::Uuid>> {
    let found: Option<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM orders \
         WHERE stripe_subscription_id = $1 AND user_id IS NOT NULL \
         ORDER BY created_at LIMIT 1",
    )
    .bind(&sub)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(found.map(|(uid,)| uid))
}

/// End a subscription.
///
/// **只有当这个账号再没有别的活订阅时，才清空 plan 和额度。**
///
/// 额度是加法累积的（`codes::apply_plan`：new_total = cur_total + total），所以一个账号的
/// quota_total_cents 可以由多笔付款叠出来——先订 basic，再走 checkout 买 pro（每次 checkout
/// 都新建一条 Stripe subscription，代码里没有任何地方取消上一条）。线上已经有这样的账号。
///
/// 而取消原来是无条件 `clear_plan`：用户在 Stripe 客户门户把已经用不上的那条旧订阅退掉，
/// 把**还在付钱的那条**的额度一起赔进去了。减法被做成了归零。
///
/// 现在先把这条订阅记成已结束，再看还有没有别的活着的；有就只记账、不动额度。
async fn end_subscription(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    subscription: &serde_json::Value,
) -> ApiResult<Option<uuid::Uuid>> {
    let Some(sub) = subscription.get("id").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let Some(uid) = user_for_subscription(tx, sub).await? else {
        tracing::warn!("Stripe cancellation for unknown subscription {sub}");
        return Ok(None);
    };

    // 结束这条订阅——**并且把「是我结束的」这件事抢下来**。
    //
    // 原来这里是 `SET subscription_ended_at = COALESCE(subscription_ended_at, now())`，对
    // 「只标记」来说确实幂等（重投不改结果）。但下面新增了一段**读—算—写**的额度扣减，
    // 它不继承那个性质，而 end_subscription 对同一次取消是会被走**两遍**的：
    // customer.subscription.deleted 和 customer.subscription.updated（终态 canceled /
    // unpaid / incomplete_expired）各是一个独立 event id，stripe_events 那层去重按 event id
    // 走，两条都会放行；普通退订 Stripe 就会同时发这两条，欠费流程还会先 unpaid 再 deleted。
    //
    // 走两遍的后果正好把这次修复抵消掉：basic（面额 33000）+ 兑换码 5000 = 38000。
    // 第一条事件算出 38000−33000=5000 写回（正确）；第二条事件再来一次，current 变成 5000，
    // 5000−33000 夹到 0 → clear_plan → 兑换码那份仍然被清空，只是从一步变成了两步。
    //
    // 所以把标记改成**认领**：只有把 NULL 改成 now() 的那一次才算数（rows_affected == 1），
    // 后来的重投看到 0 行，直接跳过扣减返回。并发的两条事件在 orders 的行锁上串行，
    // 第二条一定看到 0。
    let claimed_ending = sqlx::query(
        "UPDATE orders SET subscription_ended_at = now() \
         WHERE stripe_subscription_id = $1 AND subscription_ended_at IS NULL",
    )
    .bind(sub)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    if claimed_ending == 0 {
        // 这条订阅早就被上一个事件结束过了，账已经算完。再算一遍就是重复扣减。
        tracing::info!(
            %uid, subscription = sub,
            "订阅结束事件重投：这条订阅已结束过，跳过额度扣减（幂等）"
        );
        return Ok(Some(uid));
    }

    let (others,): (i64,) = sqlx::query_as(
        "SELECT count(DISTINCT stripe_subscription_id) FROM orders \
         WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL \
           AND stripe_subscription_id <> $2 AND subscription_ended_at IS NULL",
    )
    .bind(uid)
    .bind(sub)
    .fetch_one(&mut **tx)
    .await?;

    if others > 0 {
        tracing::info!(
            %uid, subscription = sub, still_active = others,
            "订阅已结束，但这个账号还有别的活订阅——保留 plan 与额度，不清零"
        );
        return Ok(Some(uid));
    }

    /*
     * 到这里这个账号已经没有别的**订阅**了。但额度池不是只有订阅在往里加。
     *
     * quota_total_cents 是一个加法池，四个来源都往里写（都走 codes::apply_plan）：
     * 兑换码、管理员发放、手工订单确认、Stripe 购买（含日卡和一次性套餐）。
     * **只有 Stripe 订阅**会在 orders 上写 stripe_subscription_id，所以上面那句
     * others 查询看不见前三者。原来这里无条件 clear_plan（quota_total_cents = 0），
     * 于是「兑换了一张 30 天码，又顺手在 Stripe 客户门户退掉一条订阅」＝把还没到期的
     * 兑换额度一起抹掉。用户那边是静默数据丢失，日志里一个字都没有。
     *
     * 精确记账做不到：库里没有「这笔额度是谁给的」这一列。所以走保守路线——**只减这条
     * 订阅自己那一份**（按 plan_quotas 里该套餐的 total_cents），下限 0；减完还有剩，
     * 说明剩下的来自别处，plan 标签和上限就都留着，只有减到 0 才清。
     *
     * 残留的不精确，写清楚，免得下一个人以为这里已经准确了：
     *   1. quota_total_cents 是**余额**（models.rs 按用量逐次扣减），而这里减的是套餐
     *      面额。用户把订阅那份花掉大半再退订，减法会咬进别处来的那部分——多减。
     *   2. 同一账号叠了两条**同款**订阅，退掉其中一条会走上面 others 那道闸提前返回，
     *      一分不减——少减。
     *   3. 续费每期再 apply_plan 一次，上期没花完的留在池子里；退订只减一份面额。
     *   4. plan_spec 读的是 plan_quotas 里该套餐**此刻**的面额，不是当初卖出去时那个。
     *      目录在库内已经重定价过一轮（migration 20260834_reprice_2026q3）：basic
     *      33000→39780、power 180000→139230、ultra 500000→497250 —— 两个方向都出现过。
     *      在重定价之前买的人，涨过价的套餐退订时多减（咬进兑换码/管理员发放的那份），
     *      降过价的少减（留下一截白拿的额度）。orders 上没有存下当时的面额，所以此刻
     *      没有更准的数可取。
     * 前三条要「这笔额度是谁给的」才算得准：users 上按来源分列的额度，或者一张额度
     * 流水表。第 4 条要的是另一样东西——下单时把套餐面额快照进 orders，退订优先用订单上
     * 那一份。两样都是独立的 schema 改动，不在这次修复里做。
     */
    let plan = sqlx::query_scalar::<_, Option<String>>(
        "SELECT plan FROM orders \
         WHERE stripe_subscription_id = $1 AND kind = 'plan' AND plan IS NOT NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(sub)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

    let Some(plan_total) = plan.as_deref().and_then(crate::settings::plan_spec).map(|s| s.0) else {
        // 认不出这条订阅当初发的是哪个套餐，就没有「该减多少」的答案。退回旧行为（清空）
        // 并且吼一嗓子：让一条已取消的订阅无限期保留全额额度，比多清一点更贵。
        tracing::error!(
            %uid, subscription = sub, ?plan,
            "取消订阅：认不出套餐，退回清空额度的旧行为——这行日志出现就说明订单数据有问题"
        );
        crate::codes::clear_plan(tx, uid).await?;
        return Ok(Some(uid));
    };

    // 行锁先拿：下面是「读—算—写」，两条取消事件并发进来会各自按同一个旧值算，
    // 两次减法都落在同一个基数上，等于只减了一份。apply_plan 拿的也是这把锁。
    let current: i64 =
        sqlx::query_scalar("SELECT quota_total_cents FROM users WHERE id = $1 FOR UPDATE")
            .bind(uid)
            .fetch_one(&mut **tx)
            .await?;
    let remaining = quota_after_subscription_ends(current, plan_total);

    if remaining == 0 {
        // 池子空了，plan 标签和上限跟着走 —— 一份定义，和管理员手工取消同一条路径。
        crate::codes::clear_plan(tx, uid).await?;
    } else {
        // 只动总额和窗口余额。窗口余额要跟着夹住（它是从总额里取的一段），上限
        // quota_window_cap_cents 不动：还剩额度就还是这一档的待遇。
        sqlx::query(
            "UPDATE users SET quota_total_cents = $2, \
             quota_window_cents = LEAST(quota_window_cents, $2), updated_at = now() \
             WHERE id = $1",
        )
        .bind(uid)
        .bind(remaining)
        .execute(&mut **tx)
        .await?;
        tracing::info!(
            %uid, subscription = sub, ?plan, deducted = plan_total, remaining,
            "订阅结束：只扣掉这条订阅自己那一份，余下的额度来自别处，保留"
        );
    }
    Ok(Some(uid))
}

/// 取消一条订阅之后，额度池该剩多少：减掉这条订阅那个套餐的面额，下限 0。
///
/// 单独拎成函数是为了能被断言钉住。这里唯一容易写错的是那个下限：不夹 0 就会把额度做成
/// 负数，而访问闸判的是 `quota_total_cents > 0` —— 负数在闸门那里和 0 等价，看不出异常，
/// 却会让用户之后**每一次**充值先去填这个坑，直到把坑填平才重新能用。
fn quota_after_subscription_ends(current_total: i64, plan_total: i64) -> i64 {
    current_total.saturating_sub(plan_total).max(0)
}

/// Grant what the purchased row says, in the caller's transaction — the same one that
/// claimed the event — so the grant and the claim commit or fail together.
///
/// `Ok(None)` means "nothing to announce, and do not retry": the payload named a product
/// or a user we cannot resolve, and a redelivery would reach the identical conclusion.
/// Real failures propagate with `?` and take the event claim down with them.
/// On success returns (user, product label, quantity) for the caller to record post-commit.
/// Find the Checkout Session a payment intent belongs to.
///
/// Used only by the fallback path above. Returns None on any failure — a fallback that
/// cannot reach Stripe simply does not fire, and the primary event (or Stripe's retry)
/// remains the path that matters.
/// Which of our orders a refunded charge or a dispute belongs to.
///
/// Two shapes arrive here. A `charge` carries `invoice` when it came from a subscription
/// renewal, which maps straight onto the order that renewal wrote. Everything else is
/// matched through the payment intent back to the Checkout session, the same route the
/// `payment_intent.succeeded` fallback already uses.
///
/// A dispute object has no `invoice`, so a disputed *renewal* falls through and is logged
/// rather than guessed at. Renewals before the invoice id existed have no `stripe_invoice_id`
/// either and land in the same place. Both are visible in the log rather than silently
/// reversing whatever order happened to be nearest.
/// 返回 `Err` 表示**没查成**（数据库出错、Stripe 不可达）—— 那会让整个 webhook 事务回滚，
/// Stripe 重投，退款下次再处理。返回 `Ok(None)` 才是「查过了，确实不是我们的订单」。
///
/// 以前这里是 `Option`，两种情况长得一模一样：一次网络抖动会被当成「与我无关」，事件被标记
/// 处理完毕并提交，Stripe 收到 200 再也不重投 —— 那笔退款就永远没人追了。
async fn order_for_reversal(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    obj: &serde_json::Value,
) -> ApiResult<Option<uuid::Uuid>> {
    if let Some(invoice) = obj.get("invoice").and_then(|v| v.as_str()) {
        // `?` 而不是 .ok()：库出错要往上抛，让事务回滚重投。
        let found: Option<(uuid::Uuid,)> =
            sqlx::query_as("SELECT id FROM orders WHERE stripe_invoice_id = $1")
                .bind(invoice)
                .fetch_optional(&mut **tx)
                .await?;
        if let Some((id,)) = found {
            return Ok(Some(id));
        }
    }

    let Some(pi) = obj.get("payment_intent").and_then(|v| v.as_str()) else {
        tracing::warn!("refund/dispute carries no payment_intent; nothing to match");
        return Ok(None);
    };
    let Some(session) = session_for_payment_intent(state, pi).await else {
        // 这里分不出「Stripe 说没有」和「问不到 Stripe」，所以按问不到处理：宁可重投一次。
        return Err(AppError::internal(format!(
            "refund for {pi}: could not resolve the checkout session"
        )));
    };
    let Some(session_id) = session.get("id").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let found: Option<(uuid::Uuid,)> =
        sqlx::query_as("SELECT id FROM orders WHERE stripe_session_id = $1")
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await?;
    if found.is_none() {
        tracing::warn!("refund/dispute for {pi} matched no order; commission left as is");
    }
    Ok(found.map(|(id,)| id))
}

async fn session_for_payment_intent(
    state: &AppState,
    payment_intent: &str,
) -> Option<serde_json::Value> {
    let key = secret_key()?;
    let body: serde_json::Value = state
        .update_http
        .get(format!("{STRIPE_API}/checkout/sessions"))
        .bearer_auth(&key)
        .query(&[("payment_intent", payment_intent), ("limit", "1")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let session = body.get("data")?.as_array()?.first()?.clone();
    // Only fulfil once the money is actually there, same rule as the primary path.
    let paid = session
        .get("payment_status")
        .and_then(|v| v.as_str())
        .map(|s| s == "paid" || s == "no_payment_required")
        .unwrap_or(false);
    paid.then_some(session)
}

/// 打在订单上的标记：钱收了、按 once_per_account 拒发，等人工退款。
///
/// 写进 `orders.note` 而不是新开一列：这一列本来就是「这笔订单出了什么事」的位置。
/// 而 status 必须留在 'paid' —— `fulfil_session` 的认领条件是 `status <> 'paid'`，
/// 把状态改成别的等于把这一笔重新变成可履约的，另一条路径会把它再发一遍。
const ONCE_PER_ACCOUNT_REFUND_NOTE: &str = "once_per_account: 重复购买，已收款未发放，待人工退款";

/// 一次**由本次调用真正完成**的履约。
///
/// `fulfil_session` 只对认领成功的那一次返回它；抢输的路径拿到 `None`。回执和
/// order_paid 因此可以挂在「谁拿到 Some」上，正好发一次——见 `announce_fulfilment`。
struct Fulfilled {
    user: uuid::Uuid,
    label: String,
    quantity: i64,
    /// Checkout Session id：回执按它回查订单行。
    session: String,
    /// 这一笔到底发没发货。`false` = 钱收了、按 once_per_account 拒发，等运营退款。
    granted: bool,
    /// 出事时用来点名这一笔的订单行。
    order: Option<uuid::Uuid>,
}

async fn fulfil_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session: &serde_json::Value,
) -> ApiResult<Option<Fulfilled>> {
    let session_id = session.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let uid_str = session
        .get("client_reference_id")
        .and_then(|v| v.as_str())
        .or_else(|| session.pointer("/metadata/user_id").and_then(|v| v.as_str()))
        .unwrap_or_default();
    let Ok(uid) = uuid::Uuid::parse_str(uid_str) else {
        tracing::warn!("Stripe session {session_id} has no usable user id");
        return Ok(None);
    };
    let lookup_key = session
        .pointer("/metadata/lookup_key")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let subscription = session
        .get("subscription")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let row = sqlx::query_as::<_, CatalogRow>(
        "SELECT id, label, kind, plan, duration_days, credits_cents, amount_cents, \
         amount_usd_cents, stripe_price_id, lookup_key, recurring, once_per_account, \
         unit_credits_cents, blurb FROM prices WHERE lookup_key = $1",
    )
    .bind(&lookup_key)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        tracing::warn!("Stripe session {session_id} references unknown product {lookup_key}");
        return Ok(None);
    };

    // 结账时定下的数量。adjustable_quantity 已经关掉（见 checkout），所以 Stripe 页面上
    // 改不了它 —— metadata 里的这个数就是实际付款的份数。
    //
    // 以前这里的注释写着「metadata 是下限，所以不会多发」，那是反的：买家能往**下**调，
    // 而发放照着 metadata 走，少付多拿。
    let quantity = session
        .pointer("/metadata/quantity")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(1)
        .max(1);

    // Claim the SESSION before granting anything.
    //
    // `stripe_events` dedupes by event id, which is not the same thing: one payment can
    // arrive as two different events — checkout.session.completed and, on endpoints
    // subscribed to it, payment_intent.succeeded. Two ids, two passes through here, and
    // with grant() first that is two grants for one payment. Ordering the claim first
    // makes the session itself the unit of "already done".
    // `charged_*` is what Stripe says it took. `amount_cents` on this row came from the
    // catalogue and is the CNY shelf price — see migration 20260827.
    let charged = session.get("amount_total").and_then(|v| v.as_i64());
    let charged_ccy = session.get("currency").and_then(|v| v.as_str()).unwrap_or_default();

    let claimed = sqlx::query(
        "UPDATE orders SET status = 'paid', paid_at = now(), stripe_subscription_id = $2, \
             charged_cents = $3, charged_currency = $4 \
         WHERE stripe_session_id = $1 AND status <> 'paid'",
    )
    .bind(session_id)
    .bind(&subscription)
    .bind(charged)
    .bind(charged_ccy)
    .execute(&mut **tx)
    .await?;

    if claimed.rows_affected() == 0 {
        // Nothing pending to flip. Either the buyer never went through our checkout (no
        // row at all), or this session was already fulfilled. The insert decides which:
        // the unique index on stripe_session_id makes it atomic, so a conflict means
        // somebody else got there first and we must not grant again.
        let inserted = sqlx::query(
            "INSERT INTO orders (user_id, email, price_id, kind, plan, duration_days, \
             credits_cents, amount_cents, method, status, stripe_session_id, \
             stripe_subscription_id, quantity, paid_at, charged_cents, charged_currency) \
             VALUES ($1,'',$2,$3,$4,$5,$6,$7,'stripe','paid',$8,$9,$10, now(),$11,$12) \
             ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING",
        )
        .bind(uid)
        .bind(row.id)
        .bind(&row.kind)
        .bind(&row.plan)
        .bind(row.duration_days)
        .bind(row.unit_credits_cents.map(|u| u * quantity).or(row.credits_cents))
        .bind(row.amount_cents * quantity)
        .bind(session_id)
        .bind(&subscription)
        .bind(quantity as i32)
        .bind(charged)
        .bind(charged_ccy)
        .execute(&mut **tx)
        .await?;
        if inserted.rows_affected() == 0 {
            tracing::info!("Stripe session {session_id} already fulfilled; skipping");
            return Ok(None);
        }
    }

    /*
     * once_per_account —— 这道闸只有在**发放点**才站得住。
     *
     * 结账时也查一次（见 `checkout`），但那次只数**已付款**的订单：连开 N 个日卡结账、
     * 一个都不付，N 次查询看到的都是 0，然后把 N 笔一起付掉。每一笔都认领到自己那个
     * stripe_session_id，各自走到这里，而 apply_plan 是加法（codes.rs：
     * new_total = cur_total + total）——$1 的日卡付 N 次就叠出 N 份额度。日卡收 $1 发
     * 约 $5 的量，这道补贴上限就是这么被绕过去的，连并发都不需要。
     *
     * 先锁住 users 这一行再数。两笔并发履约认领的是**不同的** orders 行，彼此不冲突，
     * 光数一次谁都看不见对方。users 行是 apply_plan 接下来无论如何都要拿的锁
     * （codes.rs 里的 SELECT … FOR UPDATE），提前到这里拿不引入新的加锁顺序；
     * READ COMMITTED 下后一笔在这里排队，拿到锁之后 COUNT 是一个新快照，
     * 于是能看见前一笔已提交的那张 'paid' 订单。
     *
     * 外面这层 `if` 只决定「要不要花一次锁和一次 COUNT」，判据在 once_per_account_blocks。
     */
    if row.once_per_account {
        sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
            .bind(uid)
            .execute(&mut **tx)
            .await?;
        let others: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM orders \
             WHERE user_id = $1 AND price_id = $2 AND status = 'paid' \
               AND stripe_session_id IS DISTINCT FROM $3",
        )
        .bind(uid)
        .bind(row.id)
        .bind(session_id)
        .fetch_one(&mut **tx)
        .await?;

        if once_per_account_blocks(row.once_per_account, others) {
            // 钱已经收了，所以不能就这么算了。订单留在 'paid'（Stripe 那边确实收到了），
            // 打上标记说明没发货，再让调用方记一条运营看得见的事件点名这一笔。
            //
            // 这里也**不**计佣：一笔准备退掉的销售不该产生推荐佣金。真退款之后
            // charge.refunded 会走 referral::reverse，两条路都不留脏账。
            let order = sqlx::query_scalar::<_, uuid::Uuid>(
                "UPDATE orders SET note = $2 WHERE stripe_session_id = $1 RETURNING id",
            )
            .bind(session_id)
            .bind(ONCE_PER_ACCOUNT_REFUND_NOTE)
            .fetch_optional(&mut **tx)
            .await?;
            tracing::warn!(
                %uid, session = session_id, product = %row.label, ?order,
                "once_per_account 已经用过：钱收了但没有发放，等运营退款"
            );
            return Ok(Some(Fulfilled {
                user: uid,
                label: row.label.clone(),
                quantity,
                session: session_id.to_string(),
                granted: false,
                order,
            }));
        }
    }

    grant(tx, uid, &row, quantity).await?;

    // Whoever referred this buyer, if their window is still open.
    //
    // Inside this transaction on purpose: the `UPDATE … WHERE status <> 'paid'` above is
    // what makes a duplicate webhook harmless, and putting the commission behind the same
    // claim gives it the same exactly-once property for free. `award` never returns an
    // error — a payment must not fail because a referral could not be recorded.
    let paid_order: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM orders WHERE stripe_session_id = $1")
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await
            .unwrap_or(None);
    crate::referral::award(
        tx,
        uid,
        paid_order,
        commission_basis(session, &row, quantity),
        charged_ccy,
        // Checkout Session 上没有 paid_at；created 是发起结账的时刻，仍然比「webhook 什么时候
        // 送到」接近事实得多。
        session.get("created").and_then(|v| v.as_i64()).unwrap_or(0),
    )
    .await;

    if let Some(cust) = session.get("customer").and_then(|v| v.as_str()) {
        // 同样不许吞：这一句在共享事务里，报错就让整块作废，而作废之后的 COMMIT
        // 不会报错。吞掉的唯一效果是「我们不知道」，而不是「它没坏」。
        sqlx::query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2")
            .bind(cust)
            .bind(uid)
            .execute(&mut **tx)
            .await?;
    }

    Ok(Some(Fulfilled {
        user: uid,
        label: row.label.clone(),
        quantity,
        session: session_id.to_string(),
        granted: true,
        order: paid_order,
    }))
}

/// 这一笔限购商品该不该被拒发。
///
/// 拎成函数是为了把边界钉死：判据是「除自己以外**还有没有另一笔**已付款的同款订单」，
/// 也就是 `> 0`。写成 `> 1` 会正好放过第二笔（第一笔＋自己＝2 才拦），而第二笔就是这个
/// 漏洞全部的收益所在。
fn once_per_account_blocks(once_per_account: bool, other_paid_orders: i64) -> bool {
    once_per_account && other_paid_orders > 0
}

/// The subscription an invoice belongs to, across Stripe API versions.
///
/// THIS IS WHY RENEWALS DID NOTHING. `invoice.subscription` was removed in
/// `2025-04-30.basil` and moved under `parent.subscription_details`. This webhook endpoint
/// is pinned to **2026-06-24.dahlia** — checked against the live account — so the old field
/// has not been present on a single invoice Stripe has ever sent here. `fulfil_renewal`
/// read only that field and returned `Ok(())`, which means every renewal was a silent no-op:
/// no order row, no `grant()`, so the customer's plan lapses while their card is still being
/// charged, and no `award()`, so the referrer earns nothing after month one. Stripe got a
/// 200 every time and never retried, and the reconciler only sweeps pending *Checkout*
/// orders, so nothing anywhere would have caught it.
///
/// New shape first, legacy second — the same order the reference kit uses
/// (packages/core/src/commission/events.ts:60-67).
fn subscription_id_of(invoice: &serde_json::Value) -> Option<String> {
    invoice
        .pointer("/parent/subscription_details/subscription")
        .and_then(|v| v.as_str())
        .or_else(|| invoice.get("subscription").and_then(|v| v.as_str()))
        .or_else(|| {
            invoice
                .pointer("/lines/data/0/parent/subscription_item_details/subscription")
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
}

/// What a commission is a percentage OF: the money Stripe actually collected.
///
/// Not the catalogue price. `prices` carries two figures — `amount_cents`, which is the
/// display price in CNY fen, and `amount_usd_cents` — and the commission used to be taken
/// from the first. For 「Power」 that is 18800, so a 30% commission came out as 5640 and was
/// then rendered, credited and paid as **$56.40**, against a sale that charged US$34.99.
/// Roughly six and a half times too much, in the referrer's favour, silently.
///
/// Nor `amount_usd_cents`: for that same plan the catalogue says 2799 while the live Stripe
/// price charges 3499. Neither local column is the truth. The only figure that is, is the
/// one on the object Stripe just told us it charged.
///
/// 基数 = amount_subtotal 减掉 total_details.amount_discount。
///
/// Stripe 的 `amount_subtotal` 是**折扣前**的合计 —— 这里以前的注释写反了，说它「已经扣过
/// 折扣」。按原样用，一张五折券会按原价付佣金；一张全免券会在实收 $0 的订单上付出真钱。
/// 税不算在内：抽税款的成，等于抽一笔本来就不属于我们的钱。
fn commission_basis(session: &serde_json::Value, row: &CatalogRow, quantity: i64) -> i64 {
    // amount_subtotal 是**折扣前**的合计（Stripe 的定义，和这里以前的注释相反）。
    // 折扣要自己减掉，否则一张五折券会按原价付佣金，一张全免券会在零收入上付真金。
    let discount = session
        .pointer("/total_details/amount_discount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0);
    session
        .get("amount_subtotal")
        .and_then(|v| v.as_i64())
        .map(|c| (c - discount).max(0))
        .or_else(|| session.get("amount_total").and_then(|v| v.as_i64()))
        .filter(|c| *c > 0)
        // Last resort only. Wrong currency, but a commission recorded low is a bug someone
        // reports; one recorded 6× high is money that leaves before anybody notices.
        .unwrap_or_else(|| row.amount_usd_cents.unwrap_or(row.amount_cents) * quantity)
}

/// A subscription renewed. Extend the plan by another period, and pay the referrer.
///
/// The first invoice of a subscription is skipped: the Checkout session already granted
/// that period, and granting again here would hand out two months for one payment.
///
/// ORDER OF OPERATIONS, and why it changed. This used to grant first and insert the order
/// row afterwards with no unique key, so "have I already handled this invoice" was answered
/// only by the per-event dedupe in `stripe_events`. That covers a redelivery of the same
/// event id and nothing else. The Checkout path does it the other way round — claim, then
/// grant — precisely so a second delivery finds the claim taken. Renewals now do the same,
/// keyed on the invoice id: the INSERT is the claim, and if it conflicts there is nothing
/// left to do. That protects the grant and the commission with one guard.
async fn fulfil_renewal(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    invoice: &serde_json::Value,
) -> ApiResult<()> {
    let reason = invoice
        .get("billing_reason")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if reason != "subscription_cycle" {
        // 不放宽这个闸：fulfil_renewal 是按**原始订单**解析商品的，放 subscription_update
        // 进来会照着旧套餐再发一次。但也不能一声不响 —— 在 Stripe 后台改了订阅之后，
        // 客户为什么没拿到东西，只能靠这行日志回答。
        if !reason.is_empty() && reason != "subscription_create" {
            tracing::warn!(
                billing_reason = reason,
                invoice = ?invoice.get("id").and_then(|v| v.as_str()),
                "invoice ignored: only subscription_cycle renews"
            );
        }
        return Ok(());
    }
    let Some(sub) = subscription_id_of(invoice) else {
        // 取不到订阅 id 就什么都做不了，但这必须是响的：这正是让每一次续费空转的那个分支。
        tracing::error!(
            invoice = ?invoice.get("id").and_then(|v| v.as_str()),
            "renewal ignored: no subscription id on the invoice"
        );
        return Ok(());
    };
    let invoice_id = invoice.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if invoice_id.is_empty() {
        // Without it there is no claim to make, and granting unguarded is how a retry
        // hands out two months. Stripe always sends one; if it did not, do nothing.
        tracing::warn!("Stripe renewal for {sub} carried no invoice id; skipping");
        return Ok(());
    }

    // Find the original order for this subscription; it names the product AND how many
    // seats were bought. The seat count used to be hardcoded to 1 here, so a subscription
    // bought as a 3-seat plan renewed as a 1-seat plan every month after the first.
    let found: Option<(uuid::Uuid, uuid::Uuid, i32)> = sqlx::query_as(
        "SELECT user_id, price_id, quantity FROM orders \
         WHERE stripe_subscription_id = $1 AND user_id IS NOT NULL AND price_id IS NOT NULL \
         ORDER BY created_at LIMIT 1",
    )
    .bind(&sub)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((uid, price_id, quantity)) = found else {
        tracing::warn!("Stripe renewal for unknown subscription {sub}");
        return Ok(());
    };
    let quantity = quantity.max(1) as i64;

    let row = sqlx::query_as::<_, CatalogRow>(
        "SELECT id, label, kind, plan, duration_days, credits_cents, amount_cents, \
         amount_usd_cents, stripe_price_id, lookup_key, recurring, once_per_account, \
         unit_credits_cents, blurb FROM prices WHERE id = $1",
    )
    .bind(price_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else { return Ok(()) };

    // The claim. `RETURNING id` also hands us the order the commission hangs off, so
    // there is no second lookup and no chance of attaching it to the wrong row.
    let claimed: Option<(uuid::Uuid,)> = sqlx::query_as(
        "INSERT INTO orders (user_id, email, price_id, kind, plan, duration_days, \
         credits_cents, amount_cents, method, status, stripe_subscription_id, \
         stripe_invoice_id, quantity, paid_at, charged_cents, charged_currency) \
         VALUES ($1,'',$2,$3,$4,$5,$6,$7,'stripe','paid',$8,$9,$10, now(),$11,$12) \
         ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING \
         RETURNING id",
    )
    .bind(uid)
    .bind(row.id)
    .bind(&row.kind)
    .bind(&row.plan)
    .bind(row.duration_days)
    .bind(row.unit_credits_cents.map(|u| u * quantity).or(row.credits_cents))
    .bind(row.amount_cents * quantity)
    .bind(&sub)
    .bind(invoice_id)
    .bind(quantity as i32)
    .bind(invoice.get("amount_paid").and_then(|v| v.as_i64()))
    .bind(invoice.get("currency").and_then(|v| v.as_str()).unwrap_or_default())
    .fetch_optional(&mut **tx)
    .await?;

    let Some((order_id,)) = claimed else {
        tracing::info!("Stripe invoice {invoice_id} already fulfilled; skipping");
        return Ok(());
    };

    grant(tx, uid, &row, quantity).await?;

    // The referrer gets paid for renewals inside the window, not just the first month.
    //
    // Basis is what Stripe actually collected for the goods: `subtotal` is after discounts
    // and before tax, which is the number a percentage of revenue should be taken from —
    // paying commission on sales tax would be paying it on money that was never ours. Falls
    // back to the catalogue price if the invoice does not carry one.
    // Same rule as the Checkout path — see `commission_basis`. An invoice calls its
    // pre-tax, post-discount figure `subtotal` where a session calls it `amount_subtotal`.
    // 同上：invoice 的 subtotal 也是发票级折扣之前的数。
    let inv_discount: i64 = invoice
        .get("total_discount_amounts")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|d| d.get("amount").and_then(|v| v.as_i64())).sum())
        .unwrap_or(0)
        .max(0);
    let basis = invoice
        .get("subtotal")
        .and_then(|v| v.as_i64())
        .map(|c| (c - inv_discount).max(0))
        .filter(|c| *c > 0)
        .unwrap_or_else(|| row.amount_usd_cents.unwrap_or(row.amount_cents) * quantity);
    crate::referral::award(
        tx,
        uid,
        Some(order_id),
        basis,
        invoice.get("currency").and_then(|v| v.as_str()).unwrap_or_default(),
        invoice
            .pointer("/status_transitions/paid_at")
            .and_then(|v| v.as_i64())
            .or_else(|| invoice.get("created").and_then(|v| v.as_i64()))
            .unwrap_or(0),
    )
    .await;

    Ok(())
}

/// The single place a Stripe purchase turns into entitlement. Deliberately routed
/// through `codes::apply_*` so a card payment, a redeem code and an admin grant all
/// stack quota the same way.
async fn grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    uid: uuid::Uuid,
    row: &CatalogRow,
    quantity: i64,
) -> ApiResult<()> {
    if row.kind == "plan" {
        crate::codes::apply_plan(
            tx,
            uid,
            row.plan.as_deref().unwrap_or("none"),
            row.duration_days.unwrap_or(0),
        )
        .await
    } else {
        let cents = row
            .unit_credits_cents
            .map(|u| u.saturating_mul(quantity))
            .or(row.credits_cents)
            .unwrap_or(0);
        crate::codes::apply_credits(tx, uid, cents).await
    }
}

#[cfg(test)]
mod tests {
    /// 付款成功要真的发出回执。
    ///
    /// receipt::purchase_html 此前在整个 server/src 的生产代码里**零调用点**——付了钱的
    /// 用户手里没有任何金额/额度/有效期/订单号的凭据，而退订页明确承诺「回执照发」。
    #[test]
    fn a_paid_order_actually_sends_a_receipt() {
        let src = include_str!("stripe.rs");
        let production = src.split_once("#[cfg(test)]").expect("测试模块").0;

        assert!(
            production.contains("receipt::purchase_html"),
            "回执模块仍然没有任何生产调用点",
        );
        // 必须在**提交之后**发：事务里发信的话，事务一回滚就成了「钱没扣、回执已发」。
        let commit = production
            .find("for (uid, kind, payload) in post_commit")
            .expect("post-commit 循环不见了");
        let send = production
            .find("send_purchase_receipt")
            .expect("没有发回执的调用");
        assert!(send > commit, "回执发在提交之前，回滚时会发出一封假回执");
        // 发信失败不许让 webhook 回非 2xx —— Stripe 会一直重投一个已经完成的事件。
        //
        // 比位置，**不切片**：`find` 返回的是字节偏移，而这一段几乎全是中文注释，
        // 按字节切窗口不但会短得离谱，还可能落在多字节字符中间直接 panic。
        let spawn_at = production[commit..]
            .find("tokio::spawn")
            .map(|i| commit + i)
            .expect("回执没有分离出去，发信失败会把 webhook 拖成非 2xx");
        assert!(
            spawn_at < send,
            "spawn 排在发回执之后，等于没有分离",
        );
    }

    /// 取消一条订阅，不许把账号上别的订阅的额度一起清零。
    ///
    /// 额度是加法累积的（apply_plan：new_total = cur_total + total），一个账号可以由多笔
    /// 付款叠出来——线上已经有挂着多条订阅的账号。而取消原来是无条件 clear_plan：
    /// 用户在 Stripe 客户门户退掉一条用不上的旧订阅，把还在付钱的那条的额度一起赔进去。
    #[test]
    fn cancelling_one_subscription_must_not_wipe_the_others() {
        let src = include_str!("stripe.rs");
        let raw = src
            .split("async fn end_subscription")
            .nth(1)
            .and_then(|s| s.split("\n/// ").next())
            .expect("end_subscription 不见了");
        // 剥注释再断言：函数里的中文注释逐字提到了 `clear_plan`（在解释重投会怎么把额度
        // 清掉），而下面用 `body.find("clear_plan")` 判先后顺序——不剥的话会命中注释里
        // 那一处，把「闸门在 clear_plan 之前」判成假。AGENTS.md 第四条说的就是这个。
        let body: String = raw
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let body = body.as_str();

        // 必须先把这条订阅记成已结束——否则「还有没有别的活订阅」这句问不出正确答案。
        assert!(
            body.contains("subscription_ended_at"),
            "没有记录订阅结束，无法判断账号上还有没有别的活订阅",
        );
        // 必须真的去数别的活订阅。
        assert!(
            body.contains("stripe_subscription_id <> $2") && body.contains("subscription_ended_at IS NULL"),
            "没有排除自己、也没有只数活着的——这个判断会得出错的答案",
        );
        // 有别的活订阅时必须**提前返回**，不能走到 clear_plan。
        let guard = body.find("if others > 0").expect("缺少「还有别的活订阅就不清零」这道闸");
        let clear = body.find("clear_plan").expect("clear_plan 不见了");
        assert!(guard < clear, "闸门排在 clear_plan 之后，等于没有");
        assert!(
            body[guard..clear].contains("return Ok(Some(uid))"),
            "闸门里没有提前返回，额度照样会被清零",
        );
    }

    use super::*;

    /// The claim on `stripe_events` must never commit independently of the grant.
    ///
    /// This is a source-level assertion because the failure it guards needs a database
    /// that fails halfway, which this suite has no way to stage. The bug it pins was
    /// real: the INSERT ran on `state.db` (its own auto-committed connection) and the
    /// fulfilment opened a separate transaction afterwards. A transient failure between
    /// them left the event claimed and nothing granted, and because the retry then saw
    /// the id already present and answered `200 duplicate`, Stripe stopped retrying — a
    /// paid customer, no entitlement, and success reported on both sides.
    ///
    /// Written against the source rather than behaviour so that reintroducing the shape
    /// fails, not just reintroducing the symptom.
    #[test]
    fn the_event_claim_shares_the_grants_transaction() {
        let src = include_str!("stripe.rs");
        let claim = src
            .split_once("INSERT INTO stripe_events")
            .expect("the idempotency INSERT should still exist")
            .1;
        // The executor is named a few lines below the SQL, after the binds.
        let executor = claim
            .split_once(".execute(")
            .expect("the INSERT should be executed")
            .1;
        let executor: String = executor.chars().take(40).collect();
        assert!(
            executor.contains("tx"),
            "the stripe_events claim must run inside the fulfilment transaction, \
             but it executes against `{}` — committing the claim on its own connection \
             silently drops paid orders when fulfilment then fails",
            executor.trim()
        );
        assert!(
            !executor.contains("state.db"),
            "the stripe_events claim must not run on the pool directly: {}",
            executor.trim()
        );
    }

    /// `idx_orders_stripe_session` is intentionally partial so legacy rows with no
    /// Stripe session remain valid. PostgreSQL can only infer that index when the
    /// conflict target repeats its predicate; omitting it causes every checkout
    /// pre-write and webhook fallback to fail with 42P10.
    #[test]
    fn stripe_session_conflicts_match_the_partial_unique_index() {
        let src = include_str!("stripe.rs");
        let conflict_target =
            "ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING";
        let production = src
            .split_once("#[cfg(test)]")
            .expect("the test module must follow the Stripe SQL")
            .0;
        assert_eq!(
            production.matches(conflict_target).count(),
            2,
            "both Stripe order INSERTs must infer the partial session index"
        );

        let migration = include_str!("../migrations/20260808_stripe_billing.sql");
        assert!(
            migration.contains("ON orders (stripe_session_id) WHERE stripe_session_id IS NOT NULL"),
            "the regression test must stay aligned with the already-applied partial index"
        );

        let checkout_write = production
            .split_once("// Record the intent now")
            .expect("checkout pending-order write")
            .1
            .split_once("Ok(Json")
            .expect("checkout response follows the pending-order write")
            .0;
        assert!(
            checkout_write.contains(".await?;"),
            "checkout must surface a failed pending-order write"
        );
        assert!(
            !checkout_write.contains("let _ = sqlx::query"),
            "checkout must not silently discard a pending-order write failure"
        );
    }

    /// Only genuinely dead subscriptions revoke. `past_due` means Stripe is still
    /// retrying the card — cutting that customer off would be taking away a period
    /// they may yet pay for.
    #[test]
    fn only_terminal_statuses_end_a_subscription() {
        for dead in ["canceled", "unpaid", "incomplete_expired"] {
            assert!(is_terminal_subscription_status(dead), "{dead} should revoke");
        }
        for alive in ["active", "trialing", "past_due", "paused", "incomplete", ""] {
            assert!(
                !is_terminal_subscription_status(alive),
                "{alive} must NOT revoke — the subscriber has not lost the period they paid for"
            );
        }
    }

    /// Every event the fulfilment logic depends on must actually be handled. Adding a
    /// branch is cheap; noticing months later that cancellations were never wired up is
    /// not — that gap let a cancelled subscriber keep their plan indefinitely.
    #[test]
    fn the_lifecycle_events_are_all_handled() {
        let src = include_str!("stripe.rs");
        for event in [
            "checkout.session.completed",
            "invoice.paid",
            "customer.subscription.deleted",
            "customer.subscription.updated",
            "invoice.payment_failed",
        ] {
            assert!(
                src.contains(&format!("\"{event}\" =>"))
                    || src.contains(&format!("\"{event}\" | "))
                    || src.contains(&format!("| \"{event}\"")),
                "no match arm for {event}"
            );
        }
    }

    /// A real Stripe header, signed with a known secret, must verify — and every way of
    /// tampering with it must not.
    fn sign(secret: &str, ts: i64, body: &[u8]) -> String {
        let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(ts.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);
        hex_lower(&mac.finalize().into_bytes())
    }

    #[test]
    fn a_correctly_signed_payload_verifies() {
        let secret = "whsec_test_abc";
        let body = br#"{"id":"evt_1","type":"checkout.session.completed"}"#;
        let ts = chrono::Utc::now().timestamp();
        let header = format!("t={ts},v1={}", sign(secret, ts, body));
        assert!(verify_signature(secret, &header, body).is_ok());
    }

    #[test]
    fn a_tampered_body_is_refused() {
        let secret = "whsec_test_abc";
        let body = br#"{"id":"evt_1","amount":100}"#;
        let ts = chrono::Utc::now().timestamp();
        let header = format!("t={ts},v1={}", sign(secret, ts, body));
        let tampered = br#"{"id":"evt_1","amount":999999}"#;
        assert!(
            verify_signature(secret, &header, tampered).is_err(),
            "a rewritten payload must not pass with the original signature"
        );
    }

    #[test]
    fn the_wrong_secret_is_refused() {
        let body = br#"{"id":"evt_1"}"#;
        let ts = chrono::Utc::now().timestamp();
        let header = format!("t={ts},v1={}", sign("whsec_real", ts, body));
        assert!(verify_signature("whsec_attacker", &header, body).is_err());
    }

    #[test]
    fn a_stale_signature_is_refused() {
        let secret = "whsec_test_abc";
        let body = br#"{"id":"evt_1"}"#;
        let ts = chrono::Utc::now().timestamp() - (SIGNATURE_TOLERANCE_SECS + 60);
        let header = format!("t={ts},v1={}", sign(secret, ts, body));
        assert!(
            verify_signature(secret, &header, body).is_err(),
            "an old capture must not be replayable"
        );
    }

    #[test]
    fn a_header_missing_its_parts_is_refused() {
        let body = br#"{"id":"evt_1"}"#;
        assert!(verify_signature("s", "", body).is_err());
        assert!(verify_signature("s", "t=123", body).is_err(), "no v1");
        let ts = chrono::Utc::now().timestamp();
        assert!(
            verify_signature("s", &format!("v1={}", sign("s", ts, body)), body).is_err(),
            "no timestamp"
        );
    }

    /// Stripe sends `v0` alongside `v1` in some test payloads; only `v1` counts.
    #[test]
    fn a_v0_signature_alone_is_refused() {
        let secret = "whsec_test_abc";
        let body = br#"{"id":"evt_1"}"#;
        let ts = chrono::Utc::now().timestamp();
        let header = format!("t={ts},v0={}", sign(secret, ts, body));
        assert!(verify_signature(secret, &header, body).is_err());
    }

    /// Multiple v1s appear while a signing secret is being rotated; any valid one wins.
    #[test]
    fn one_valid_signature_among_several_is_enough() {
        let secret = "whsec_test_abc";
        let body = br#"{"id":"evt_1"}"#;
        let ts = chrono::Utc::now().timestamp();
        let header = format!("t={ts},v1=deadbeef,v1={}", sign(secret, ts, body));
        assert!(verify_signature(secret, &header, body).is_ok());
    }

    /// Shaped like a real `/v1/prices` entry with `currency_options` and `product`
    /// expanded, which is how the gateway asks for them.
    fn stripe_price(extra: serde_json::Value) -> serde_json::Value {
        let mut base = json!({
            "id": "price_123",
            "lookup_key": "starter_monthly",
            "currency": "cny",
            "unit_amount": 8800,
            "recurring": { "interval": "month" },
            "product": { "name": "Starter", "description": "For everyday work." }
        });
        let (serde_json::Value::Object(b), serde_json::Value::Object(e)) = (&mut base, extra) else {
            unreachable!()
        };
        for (k, v) in e {
            b.insert(k, v);
        }
        base
    }

    #[test]
    fn product_metadata_supplies_per_language_names() {
        let (_, live) = parse_price(&stripe_price(json!({
            "product": {
                "name": "Starter",
                "description": "For everyday work.",
                "metadata": {
                    "name_ja": "スターター",
                    "name_zh_CN": "入门版",
                    "description_de": "Für die tägliche Arbeit.",
                    // Blank must not shadow the English original with an empty heading.
                    "name_es": "   ",
                    // Not one of ours; must not be mistaken for a language.
                    "internal_note": "do not ship"
                }
            }
        })))
        .unwrap();
        assert_eq!(live.names.get("ja").and_then(|v| v.as_str()), Some("スターター"));
        // Stripe metadata keys use underscores; the client asks in BCP-47.
        assert_eq!(live.names.get("zh-CN").and_then(|v| v.as_str()), Some("入门版"));
        assert_eq!(live.descriptions.get("de").and_then(|v| v.as_str()), Some("Für die tägliche Arbeit."));
        assert!(!live.names.contains_key("es"), "a blank override must fall back");
        assert!(!live.names.contains_key("internal-note"));
        assert_eq!(live.name.as_deref(), Some("Starter"), "English is still the base");
    }

    #[test]
    fn a_product_with_no_metadata_yields_no_overrides() {
        let (_, live) = parse_price(&stripe_price(json!({}))).unwrap();
        assert!(live.names.is_empty());
        assert!(live.descriptions.is_empty());
    }

    #[test]
    fn a_price_without_a_lookup_key_is_not_ours_to_sell() {
        let mut p = stripe_price(json!({}));
        p.as_object_mut().unwrap().remove("lookup_key");
        assert!(parse_price(&p).is_none());
    }

    #[test]
    fn the_base_currency_amount_is_folded_in() {
        // Stripe does not repeat the base currency inside currency_options, so a CNY-only
        // price would otherwise parse as having no amount at all.
        let (key, live) = parse_price(&stripe_price(json!({}))).unwrap();
        assert_eq!(key, "starter_monthly");
        assert_eq!(live.cny_minor, Some(8800));
        assert_eq!(live.usd_minor, None);
        assert_eq!(live.currency, "cny");
        assert!(live.recurring);
    }

    #[test]
    fn a_multi_currency_price_reports_both() {
        let (_, live) = parse_price(&stripe_price(json!({
            "currency_options": { "usd": { "unit_amount": 1299 } }
        })))
        .unwrap();
        assert_eq!(live.cny_minor, Some(8800));
        assert_eq!(live.usd_minor, Some(1299));
    }

    #[test]
    fn a_one_time_price_is_not_recurring() {
        // Stripe sends `recurring: null`, and mistaking it for a subscription is a hard
        // 400 at checkout, not a cosmetic slip.
        let (_, live) = parse_price(&stripe_price(json!({ "recurring": serde_json::Value::Null }))).unwrap();
        assert!(!live.recurring);
    }

    #[test]
    fn a_blank_product_name_falls_back_rather_than_rendering_empty() {
        let (_, live) = parse_price(&stripe_price(json!({
            "product": { "name": "   ", "description": "" }
        })))
        .unwrap();
        assert_eq!(live.name, None);
        assert_eq!(live.description, None);
    }

    #[test]
    fn the_product_name_and_description_come_through() {
        let (_, live) = parse_price(&stripe_price(json!({}))).unwrap();
        assert_eq!(live.name.as_deref(), Some("Starter"));
        assert_eq!(live.description.as_deref(), Some("For everyday work."));
    }

    #[test]
    fn dollars_are_quoted_only_when_stripe_carries_them() {
        let live = LivePrice {
            cny_minor: Some(400),
            usd_minor: None,
            currency: "cny".into(),
            ..Default::default()
        };
        // The stored column still says $0.15 from when this price was ¥1. Quoting it
        // would advertise a figure nobody is charged.
        let (_, _, currency, minor) = display_amount(Some(&live), (100, Some(15)), "usd");
        assert_eq!(currency, "cny");
        assert_eq!(minor, Some(400), "must quote Stripe's ¥4, not the stale ¥1");
    }

    /// 买家不是中国区时，有美元价就报美元。中国区的行为另有一组测试。
    #[test]
    fn dollars_win_when_stripe_has_a_usd_amount() {
        let live = LivePrice {
            cny_minor: Some(8800),
            usd_minor: Some(1299),
            currency: "cny".into(),
            ..Default::default()
        };
        let (_, _, currency, minor) = display_amount(Some(&live), (8800, Some(9999)), "usd");
        assert_eq!(currency, "usd");
        assert_eq!(minor, Some(1299), "Stripe's USD, never the stored column");
    }

    #[test]
    fn the_stored_columns_are_used_only_when_stripe_said_nothing() {
        // No key configured, or Stripe unreachable: the shop degrades to its old
        // behaviour rather than emptying itself.
        let (cny, usd, currency, minor) = display_amount(None, (8800, Some(1299)), "usd");
        assert_eq!(cny, Some(8800));
        assert_eq!(usd, Some(1299));
        assert_eq!(currency, "usd");
        assert_eq!(minor, Some(1299));
    }

    #[test]
    fn an_unsupported_currency_quotes_nothing_rather_than_a_wrong_number() {
        let live = LivePrice {
            cny_minor: None,
            usd_minor: None,
            currency: "eur".into(),
            ..Default::default()
        };
        let (_, _, currency, minor) = display_amount(Some(&live), (8800, Some(1299)), "usd");
        assert_eq!(currency, "eur");
        assert_eq!(minor, None, "no EUR amount was parsed, so there is nothing honest to print");
    }

    fn hdr(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    /// 现在中国的 UTC 偏移。validated_user_timezone 会拿声称的偏移和时区真实偏移比对，
    /// 所以测试必须给一个对的数，否则时区那一腿直接不成立。
    fn cn_offset() -> String {
        use chrono::Offset;
        let tz: chrono_tz::Tz = "Asia/Shanghai".parse().unwrap();
        (chrono::Utc::now().with_timezone(&tz).offset().fix().local_minus_utc() / 60).to_string()
    }

    /// 需求原话：「时区语言和时区时间对得上，ip 不对 那也是中国用户」。
    #[test]
    fn language_and_timezone_together_beat_a_foreign_ip() {
        let h = hdr(&[
            ("cf-ipcountry", "US"),
            ("x-ide-language", "zh-CN"),
            ("x-ide-timezone", "Asia/Shanghai"),
            ("x-ide-utc-offset-minutes", &cn_offset()),
        ]);
        assert_eq!(
            buyer_currency(&h).currency,
            "cny",
            "语言和时区都指向中国时，IP 说是美国也仍然按中国区定价",
        );
    }

    /// IP 单独为真也算 —— 人在国内直连，系统却是英文的。
    #[test]
    fn a_chinese_ip_alone_is_enough() {
        assert_eq!(buyer_currency(&hdr(&[("cf-ipcountry", "CN")])).currency, "cny");
        assert_eq!(
            buyer_currency(&hdr(&[("cf-ipcountry", "cn")])).currency,
            "cny",
            "大小写不能影响判定",
        );
    }

    /// 只满足一条不算。否则一个在上海出差的美国用户会拿到人民币价。
    #[test]
    fn one_signal_alone_is_not_enough() {
        assert_eq!(
            buyer_currency(&hdr(&[
                ("cf-ipcountry", "US"),
                ("x-ide-timezone", "Asia/Shanghai"),
                ("x-ide-utc-offset-minutes", &cn_offset()),
            ]))
            .currency,
            "usd",
            "只有时区在中国、语言不是简中 —— 不算",
        );
        assert_eq!(
            buyer_currency(&hdr(&[
                ("cf-ipcountry", "US"),
                ("x-ide-language", "zh-CN"),
                ("x-ide-timezone", "America/New_York"),
                ("x-ide-utc-offset-minutes", "-300"),
            ]))
            .currency,
            "usd",
            "只有语言是简中、时区在纽约 —— 不算",
        );
    }

    /// 时区名和声称的偏移必须自洽，随手编一个挡不住。
    #[test]
    fn a_timezone_whose_offset_does_not_match_is_rejected() {
        assert_eq!(
            buyer_currency(&hdr(&[
                ("x-ide-language", "zh-CN"),
                ("x-ide-timezone", "Asia/Shanghai"),
                ("x-ide-utc-offset-minutes", "-300"),
            ]))
            .currency,
            "usd",
            "声称在上海却报纽约的偏移 —— 这一腿不成立",
        );
    }

    /// 港澳台不按大陆价。
    #[test]
    fn traditional_chinese_is_not_mainland() {
        assert_eq!(
            buyer_currency(&hdr(&[
                ("x-ide-language", "zh-TW"),
                ("x-ide-timezone", "Asia/Shanghai"),
                ("x-ide-utc-offset-minutes", &cn_offset()),
            ]))
            .currency,
            "usd",
        );
    }

    /// 浏览器自带的 Accept-Language 也要认 —— 网页端不会主动发 x-ide-language。
    #[test]
    fn accept_language_is_a_valid_source() {
        let h = hdr(&[
            ("accept-language", "zh-CN,zh;q=0.9,en;q=0.8"),
            ("x-ide-timezone", "Asia/Shanghai"),
            ("x-ide-utc-offset-minutes", &cn_offset()),
        ]);
        assert_eq!(buyer_currency(&h).currency, "cny");
    }

    /// 中国买家看没有人民币价的商品时，卡上必须显示美元 —— 那才是实际会收的币种。
    #[test]
    fn a_cny_buyer_sees_usd_when_the_price_has_no_cny_amount() {
        let live = LivePrice {
            cny_minor: None,
            usd_minor: Some(2000),
            currency: "usd".into(),
            ..Default::default()
        };
        let (_, _, currency, minor) = display_amount(Some(&live), (14200, Some(2000)), "cny");
        assert_eq!(currency, "usd");
        assert_eq!(minor, Some(2000), "卡上和结账页必须一致，否则就是一笔拒付");
    }

    /// 有人民币价时，中国买家看到人民币。
    #[test]
    fn a_cny_buyer_sees_cny_when_stripe_carries_it() {
        let live = LivePrice {
            cny_minor: Some(29500),
            usd_minor: Some(6000),
            currency: "usd".into(),
            ..Default::default()
        };
        let (_, _, currency, minor) = display_amount(Some(&live), (29500, Some(6000)), "cny");
        assert_eq!(currency, "cny");
        assert_eq!(minor, Some(29500));
    }

    #[test]
    fn secure_eq_matches_only_identical_slices() {
        assert!(secure_eq(b"abc", b"abc"));
        assert!(!secure_eq(b"abc", b"abd"));
        assert!(!secure_eq(b"abc", b"ab"));
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xff]), "000fff");
    }
}

#[cfg(test)]
mod renewal_and_refund_tests {
    /// Renewals inside the window must pay the referrer.
    ///
    /// This was the whole defect: `award` was reachable only from the Checkout path, so a
    /// programme advertising a rate "for three months" paid on month 1 and nothing after.
    #[test]
    fn a_renewal_pays_the_referrer() {
        let src = include_str!("stripe.rs");
        let f = src
            .split("async fn fulfil_renewal(")
            .nth(1)
            .expect("the renewal path must exist");
        let body = &f[..f.find("\n/// ").unwrap_or(f.len())];
        assert!(
            body.contains("crate::referral::award("),
            "a renewal must award commission — paying only on the first invoice breaks the \
             terms the programme advertises",
        );
        assert!(
            body.contains("subtotal"),
            "commission must be taken from the invoice subtotal: after discounts, before \
             tax. A percentage of sales tax is a percentage of money that was never ours.",
        );
    }

    /// The claim comes first, and it is the invoice.
    ///
    /// The renewal path used to grant and then insert an unkeyed order row, leaning entirely
    /// on per-event dedupe. One redelivery with a new event id — or a retry after a partial
    /// failure — was two months of plan for one payment, and now would also be two
    /// commissions.
    #[test]
    fn a_redelivered_invoice_cannot_grant_or_pay_twice() {
        let src = include_str!("stripe.rs");
        let f = src
            .split("async fn fulfil_renewal(")
            .nth(1)
            .expect("renewal");
        let body = &f[..f.find("\n/// ").unwrap_or(f.len())];

        let claim = body
            .find("ON CONFLICT (stripe_invoice_id)")
            .expect("the renewal order must be claimed on the invoice id");
        let grant = body.find("grant(tx,").expect("a renewal must grant");
        let award = body.find("crate::referral::award(").expect("a renewal must award");
        assert!(
            claim < grant && claim < award,
            "the claim must come BEFORE the grant and the award, or a redelivery does both \
             again before finding out it was already handled",
        );
        assert!(
            body.contains("tracing::info!(\"Stripe invoice {invoice_id} already fulfilled"),
            "a losing claim must return, not carry on",
        );
    }

    /// Seats bought once are seats renewed.
    #[test]
    fn a_renewal_keeps_the_seat_count() {
        let src = include_str!("stripe.rs");
        let f = src.split("async fn fulfil_renewal(").nth(1).expect("renewal");
        let body = &f[..f.find("\n/// ").unwrap_or(f.len())];
        assert!(
            body.contains("SELECT user_id, price_id, quantity FROM orders"),
            "the renewal must read the seat count off the original order",
        );
        assert!(
            !body.contains("grant(tx, uid, &row, 1)"),
            "the seat count was hardcoded to 1: a 3-seat subscription renewed as 1 seat \
             every month after the first",
        );
    }

    /// Refunds and disputes have to reach the ledger.
    #[test]
    fn a_refund_reaches_the_commission_ledger() {
        let src = include_str!("stripe.rs");
        for event in ["charge.refunded", "charge.dispute.created"] {
            assert!(
                src.contains(&format!("\"{event}\"")),
                "no handler for {event} — a refunded sale would keep paying commission",
            );
        }
        let arm = src
            .split("\"charge.refunded\" | \"charge.dispute.created\" => {")
            .nth(1)
            .expect("the refund arm");
        assert!(
            arm[..arm.find("\"checkout.session.expired\"").unwrap_or(arm.len())]
                .contains("crate::referral::reverse("),
            "the refund arm must reverse the commission",
        );
        assert!(
            arm[..arm.find("\"checkout.session.expired\"").unwrap_or(arm.len())]
                .contains("ratio_bps"),
            "clawback must be pro-rata (spec 7.3): a $10 refund on a $100 sale takes back \
             a tenth of the commission, not all of it",
        );
        // Entitlement is deliberately untouched here; see the comment on the arm.
        let refund_arm = &arm[..arm.find("\"checkout.session.expired\"").unwrap_or(arm.len())];
        assert!(
            !refund_arm.contains("end_subscription") && !refund_arm.contains("apply_plan"),
            "a refund must not revoke access as a side effect — that is a separate decision",
        );
    }
}

#[cfg(test)]
mod renewal_event_name_tests {
    /// Renewals must be listened for under BOTH names Stripe uses.
    ///
    /// A paid invoice produces `invoice.paid` AND `invoice.payment_succeeded`, and an endpoint
    /// only receives the ones it subscribes to. The live endpoint had the second and not the
    /// first, so a handler matching `invoice.paid` alone was never going to run: no renewed
    /// month, no commission, and no error anywhere to notice it by.
    #[test]
    fn renewals_listen_for_both_names_stripe_uses() {
        let src = include_str!("stripe.rs");
        let arm = src
            .find("\"invoice.paid\" | \"invoice.payment_succeeded\" =>")
            .or_else(|| src.find("\"invoice.payment_succeeded\" | \"invoice.paid\" =>"))
            .expect(
                "renewals must match both invoice.paid and invoice.payment_succeeded — an \
                 endpoint receives only what it subscribes to, and subscribing to the other \
                 one silently disables renewals entirely",
            );
        assert!(
            src[arm..arm + 300].contains("fulfil_renewal"),
            "both names must reach the renewal path",
        );
    }
}

#[cfg(test)]
mod commission_basis_tests {
    use super::*;

    fn row() -> CatalogRow {
        // 「Power」 as it really sits in the catalogue: ¥188.00 display, US$27.99 recorded,
        // and the live Stripe price charging US$34.99 — three different numbers.
        CatalogRow {
            id: uuid::Uuid::nil(),
            label: "Power".into(),
            kind: "plan".into(),
            plan: Some("pro".into()),
            duration_days: Some(30),
            credits_cents: None,
            amount_cents: 18800,
            amount_usd_cents: Some(2799),
            stripe_price_id: None,
            lookup_key: Some("power_monthly".into()),
            recurring: true,
            once_per_account: false,
            unit_credits_cents: None,
            blurb: String::new(),
        }
    }

    /// The percentage comes off what Stripe charged, not off the CNY shelf price.
    #[test]
    fn commission_follows_the_money_stripe_actually_took() {
        let session = serde_json::json!({ "amount_subtotal": 3499, "amount_total": 3499 });
        assert_eq!(
            commission_basis(&session, &row(), 1),
            3499,
            "must use the session's own figure — 18800 is CNY fen and would pay a 30% \
             commission of $56.40 on a $34.99 sale",
        );
    }

    /// Discounts count, tax does not.
    #[test]
    fn commission_is_taken_before_tax_and_after_discount() {
        let session = serde_json::json!({ "amount_subtotal": 3000, "amount_total": 3600 });
        assert_eq!(
            commission_basis(&session, &row(), 1),
            3000,
            "subtotal wins: a share of sales tax is a share of money that was never ours",
        );
    }

    /// With nothing from Stripe to go on, fall back to the USD column, never the CNY one.
    #[test]
    fn the_fallback_is_never_the_cny_price() {
        let bare = serde_json::json!({});
        assert_eq!(commission_basis(&bare, &row(), 1), 2799);
        assert_eq!(commission_basis(&bare, &row(), 3), 2799 * 3, "seats still multiply");
        assert_ne!(
            commission_basis(&bare, &row(), 1),
            18800,
            "falling back to amount_cents pays a commission in the wrong currency",
        );
    }
}

// ---------------------------------------------------------------------------------------
// The backstop: payments the webhook never told us about
// ---------------------------------------------------------------------------------------

/// How often to sweep. Long enough that Stripe's own retry schedule (which runs for up to
/// three days) usually wins first, short enough that a customer who paid and got nothing is
/// waiting minutes rather than discovering it themselves.
const RECONCILE_EVERY: Duration = Duration::from_secs(10 * 60);

/// Reconcile payments Stripe accepted but this service never heard about.
///
/// WHY THIS EXISTS. Every grant in this system hangs off one webhook delivery. That is a
/// single point of failure with no second chance: if `checkout.session.completed` is not
/// delivered — the endpoint was down through a deploy, the event type was not on the
/// subscription list, Stripe exhausted its retries, a 500 escaped the handler — then the
/// customer has paid, the order sits `pending` forever, and nothing in the system will ever
/// notice. There is no error to see, because from here it looks exactly like a checkout
/// nobody completed. That is the worst shape a payment bug can take.
///
/// Stripe is the source of truth, so reconciling is just asking it. Every pending order
/// with a session id gets checked against the session itself: paid means fulfil, expired
/// means close it out, anything else means leave it alone and look again next sweep.
///
/// SAFE TO RACE with a late webhook. `fulfil_session` claims the order with
/// `UPDATE … WHERE status <> 'paid'` before granting anything, so whichever of the two gets
/// there first does the work and the other finds nothing to claim. The commission hangs off
/// the same claim, so it cannot double-pay either.
pub fn spawn_reconciler(state: AppState) {
    tokio::spawn(async move {
        // Let the service finish starting before adding outbound traffic, and stagger away
        // from the health prober so a restart does not fire everything at once.
        tokio::time::sleep(Duration::from_secs(45)).await;
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        loop {
            tick.tick().await;
            if let Err(err) = reconcile_once(&state).await {
                // Never fatal. The next sweep is ten minutes away and a database or network
                // blip must not take the backstop down for the life of the process.
                tracing::warn!(%err, "stripe reconcile sweep failed");
            }
        }
    });
}

async fn reconcile_once(state: &AppState) -> anyhow::Result<()> {
    let Some(key) = secret_key() else { return Ok(()) };

    // Seven days back: Stripe sessions expire after 24h, so anything older is settled one
    // way or the other and re-asking every ten minutes forever would be pure noise. The cap
    // keeps one bad sweep from making a hundred API calls.
    let pending: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, stripe_session_id FROM orders \
         WHERE status = 'pending' AND stripe_session_id IS NOT NULL \
           AND created_at > now() - interval '7 days' \
         ORDER BY created_at LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;

    if pending.is_empty() {
        return Ok(());
    }

    let mut rescued = 0usize;
    let mut expired = 0usize;

    for (order_id, session_id) in pending {
        let res = state
            .update_http
            .get(format!("{STRIPE_API}/checkout/sessions/{session_id}"))
            .bearer_auth(&key)
            .send()
            .await;
        let Ok(res) = res else { continue };
        if !res.status().is_success() {
            continue;
        }
        let Ok(session) = res.json::<serde_json::Value>().await else { continue };

        let paid = session
            .get("payment_status")
            .and_then(|v| v.as_str())
            .map(|s| s == "paid" || s == "no_payment_required")
            .unwrap_or(false);

        if paid {
            let mut tx = state.db.begin().await?;
            match fulfil_session(&mut tx, &session).await {
                Ok(Some(f)) => {
                    tx.commit().await?;
                    if f.granted {
                        rescued += 1;
                    }
                    tracing::warn!(
                        order = %order_id, session = %session_id, label = %f.label,
                        granted = f.granted,
                        "reconciler fulfilled a paid order the webhook never delivered"
                    );
                    // 回执也归到这里。这条路径原来只记 order_paid、从不发回执，于是
                    // 「买家收不收得到回执」取决于是哪条路径先抢到履约——从买家看是随机的。
                    announce_fulfilment(state, &f, "stripe-reconcile").await;
                }
                // Already fulfilled between the query and now — the webhook won the race,
                // which is the normal case and not worth a line in the log.
                Ok(None) => {
                    tx.rollback().await.ok();
                }
                Err(err) => {
                    tx.rollback().await.ok();
                    tracing::warn!(order = %order_id, err = %err.msg, "reconciler could not fulfil");
                }
            }
        } else if session.get("status").and_then(|v| v.as_str()) == Some("expired") {
            // Nobody paid and nobody can now. Close it so the queue does not grow forever
            // and so 「待付款」 on the billing screen means something.
            let done = sqlx::query(
                "UPDATE orders SET status = 'canceled' WHERE id = $1 AND status = 'pending'",
            )
            .bind(order_id)
            .execute(&state.db)
            .await;
            if matches!(&done, Ok(r) if r.rows_affected() > 0) {
                expired += 1;
            }
        }
    }

    if rescued > 0 || expired > 0 {
        tracing::info!(rescued, expired, "stripe reconcile sweep");
    }
    Ok(())
}

#[cfg(test)]
mod reconcile_tests {
    /// A payment must survive the webhook not arriving.
    ///
    /// Before this, every grant hung off one delivery of one event. A missed delivery —
    /// endpoint down through a deploy, event type absent from the subscription, Stripe out
    /// of retries — meant the customer paid, the order stayed `pending`, and nothing ever
    /// looked again. It is indistinguishable from an abandoned checkout, so nobody finds it.
    #[test]
    fn a_missed_webhook_is_recovered_not_lost() {
        let src = include_str!("stripe.rs");
        let f = src
            .split("async fn reconcile_once(")
            .nth(1)
            .expect("the backstop must exist");
        let body = &f[..f.find("\n#[cfg(test)]").unwrap_or(f.len())];

        assert!(
            body.contains("status = 'pending'") && body.contains("stripe_session_id IS NOT NULL"),
            "the sweep must look for orders that were started and never confirmed",
        );
        assert!(
            body.contains("fulfil_session(&mut tx, &session)"),
            "recovery must go through the SAME fulfilment path as the webhook — a second \
             implementation is a second set of bugs, and it would not share the claim",
        );
        assert!(
            body.contains("payment_status") && body.contains("no_payment_required"),
            "only fulfil what Stripe says was actually paid",
        );
    }

    /// The backstop must not become a second way to pay a commission or grant a plan twice.
    #[test]
    fn reconciling_cannot_double_grant() {
        let src = include_str!("stripe.rs");
        // fulfil_session claims before granting; that claim is what makes the race safe.
        let f = src.split("async fn fulfil_session(").nth(1).expect("fulfil_session");
        let claim = f.find("WHERE stripe_session_id = $1 AND status <> 'paid'")
            .expect("the claim must still be conditional on not-already-paid");
        let grant = f.find("grant(tx,").expect("grant");
        assert!(
            claim < grant,
            "the claim must precede the grant, or the reconciler and a late webhook can \
             both grant before either discovers the other",
        );

        let r = src.split("async fn reconcile_once(").nth(1).expect("reconcile");
        let body = &r[..r.find("\n#[cfg(test)]").unwrap_or(r.len())];
        assert!(
            body.contains("Ok(None) =>"),
            "losing the race must be handled quietly, not treated as a failure",
        );
        assert!(
            body.contains("tx.rollback()"),
            "a transaction that fulfilled nothing must not be committed",
        );
    }

    /// Recording a payment must record the payment, not the shelf price.
    #[test]
    fn a_paid_order_records_what_stripe_charged() {
        let src = include_str!("stripe.rs");
        let f = src.split("async fn fulfil_session(").nth(1).expect("fulfil_session");
        let body = &f[..f.find("\n/// ").unwrap_or(f.len())];
        assert!(
            body.contains("charged_cents = $3") && body.contains("charged_currency = $4"),
            "the claim must write what Stripe actually took — orders.amount_cents is the \
             CNY shelf price and reporting it as USD overstates revenue five-fold",
        );
        assert!(
            body.contains(r#"session.get("amount_total")"#),
            "the amount must come off the Stripe session, not the catalogue row",
        );
    }
}

#[cfg(test)]
mod payout_callback_tests {
    /// Every event that changes money or entitlement must have a home.
    ///
    /// The list is the point: an event Stripe sends and this service ignores is a state
    /// change that happened in the world and not here. `invoice.paid` was exactly that for
    /// months, under a name nobody checked against the subscription.
    #[test]
    fn the_events_that_matter_all_have_handlers() {
        let src = include_str!("stripe.rs");
        for event in [
            "checkout.session.completed",
            "checkout.session.expired",
            "payment_intent.succeeded",
            "invoice.paid",
            "invoice.payment_succeeded",
            "invoice.payment_failed",
            "customer.subscription.deleted",
            "customer.subscription.updated",
            "charge.refunded",
            "charge.dispute.created",
            "charge.dispute.closed",
            "transfer.reversed",
            "transfer.failed",
            "account.updated",
        ] {
            let quoted = format!("\"{event}\"");
            assert!(
                src.contains(&format!("{quoted} =>"))
                    || src.contains(&format!("{quoted} | "))
                    || src.contains(&format!("| {quoted}")),
                "no handler for {event}",
            );
        }
    }

    /// A payout that comes back must return to the balance it came out of.
    #[test]
    fn a_reversed_payout_gives_the_money_back() {
        let src = include_str!("stripe.rs");
        let arm = src
            .split("\"transfer.reversed\" | \"transfer.failed\" => {")
            .nth(1)
            .expect("the reversal arm");
        // 按下一个分支切，不要按固定字节数：这一段注释是中文，1400 字节远不到 1400 个字。
        let body = &arm[..arm.find("\"charge.dispute.closed\"").unwrap_or(arm.len())];
        assert!(
            body.contains("WHERE transfer_id = $1 AND status = 'paid' AND $4"),
            "only a payout recorded as paid can come back, found by the transfer id — and \
             the $4 gate is what keeps a PARTIAL reversal from releasing the whole row",
        );
        assert!(
            body.contains("let fully = obj") && body.contains(r#".get("reversed")"#),
            "a partial reversal must be told apart from a full one, or a $50 transfer \
             reversed by $10 gives the referrer the whole $50 back to withdraw again",
        );
        assert!(
            body.contains("returned") && body.contains("failed"),
            "'left and came back' and 'never left' are different answers to \
             『我的钱呢』 and must not be collapsed",
        );

        // The accounting half: withdrawable has to exclude both, or the money stays locked.
        let r = include_str!("referral.rs");
        let w = r.split("async fn withdrawable").nth(1).expect("withdrawable");
        assert!(
            w[..w.find("\n#[derive").unwrap_or(w.len())]
                .contains("status NOT IN ('rejected', 'failed', 'returned')"),
            "a failed or returned payout must stop counting against the balance",
        );
    }

    /// Winning a dispute must undo the reversal that opening it caused.
    #[test]
    fn a_won_dispute_restores_the_commission() {
        let src = include_str!("stripe.rs");
        let arm = src
            .split("\"charge.dispute.closed\" => {")
            .nth(1)
            .expect("the dispute-closed arm");
        let body = &arm[..arm.find("\"invoice.payment_failed\"").unwrap_or(arm.len())];
        assert!(
            body.contains(r#"== Some("won")"#),
            "only a WON dispute restores anything — a lost one is a real refund",
        );
        assert!(
            body.contains("referral::unreverse"),
            "the commission reversed when the dispute opened must be undone",
        );
    }
}

#[cfg(test)]
mod refund_marker_tests {
    /// 「查不到」和「没有」必须分开。
    ///
    /// 以前两者都返回 None：一次数据库抖动或者 Stripe 不可达，会被当成「这笔退款与我们无关」，
    /// 事件被记为处理完毕并提交，Stripe 收到 200 再也不重投 —— 那笔退款就永远没人追了。
    #[test]
    fn a_failed_lookup_is_not_mistaken_for_no_match() {
        let src = include_str!("stripe.rs");
        let f = src.split("async fn order_for_reversal(").nth(1).expect("fn");
        let sig = &f[..f.find(" {").unwrap_or(200)];
        assert!(
            sig.contains("ApiResult<Option<uuid::Uuid>>"),
            "查不到要能往上抛，让整个 webhook 事务回滚重投",
        );
        let body = &f[..f.find("\nasync fn session_for_payment_intent").unwrap_or(f.len())];
        assert!(
            !body.contains(".ok()\n                .flatten()"),
            "数据库错误不能再被 .ok() 吞掉",
        );
    }

    /// 退款要记在订单上，否则退过款的订单还能再被履约一次。
    #[test]
    fn a_refunded_order_is_marked_on_the_order() {
        let src = include_str!("stripe.rs");
        assert!(
            src.contains("UPDATE orders SET refunded_at = COALESCE(refunded_at, now())"),
            "退过款的 Checkout Session 在 Stripe 那边仍然报 payment_status: paid —— \
             没有这个标记，履约和计佣还能再跑一遍",
        );
        assert!(
            src.contains("UPDATE orders SET refunded_at = NULL"),
            "拒付打赢了要把标记清掉：钱其实从来没走",
        );
    }
}

/// `GET /api/billing/session/:id` — 这一笔到底买到了什么。
///
/// 支付成功页用它。有两件事让它不能只是一次简单的查询：
///
/// **一、跳回来的那一刻，webhook 很可能还没到。** Stripe 先把浏览器重定向回来，webhook 是
/// 另一条链路，晚几百毫秒到几秒都正常。如果这里只读订单，用户会看到「未支付」——他刚付完钱。
/// 所以订单还挂着的时候，这里直接去问 Stripe：真付了就当场走**和 webhook 完全相同**的履约
/// 路径。`fulfil_session` 先认领后发放，所以和 webhook 抢也不会发两次。
///
/// **二、只能看自己的。** session id 出现在跳转地址里，是会被复制、被分享的。查询按
/// `user_id = 调用者` 过滤，拿到别人的 id 也只会得到 404。
pub async fn session_result(
    State(state): State<AppState>,
    claims: Claims,
    axum::extract::Path(sid): axum::extract::Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let uid = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;

    let found: Option<(String, String, Option<String>, Option<i32>, Option<i64>, i64, Option<i64>, Option<String>, Option<uuid::Uuid>)> =
        sqlx::query_as(
            "SELECT status, kind, plan, duration_days, credits_cents, amount_cents, \
                    charged_cents, charged_currency, price_id \
             FROM orders WHERE stripe_session_id = $1 AND user_id = $2",
        )
        .bind(&sid)
        .bind(uid)
        .fetch_optional(&state.db)
        .await?;
    let Some((mut status, kind, plan, duration_days, credits, amount_cents, charged, charged_ccy, price_id)) = found
    else {
        return Err(AppError::bad("找不到这笔订单"));
    };

    // 还没到账就去问 Stripe。付了就当场发，用户不用等 webhook。
    if status != "paid" {
        if let Some(key) = secret_key() {
            let res = state
                .update_http
                .get(format!("{STRIPE_API}/checkout/sessions/{sid}"))
                .bearer_auth(&key)
                .send()
                .await;
            if let Ok(res) = res {
                if res.status().is_success() {
                    if let Ok(session) = res.json::<serde_json::Value>().await {
                        let paid = session
                            .get("payment_status")
                            .and_then(|v| v.as_str())
                            .map(|s| s == "paid" || s == "no_payment_required")
                            .unwrap_or(false);
                        if paid {
                            let mut tx = state.db.begin().await?;
                            match fulfil_session(&mut tx, &session).await {
                                Ok(Some(f)) => {
                                    tx.commit().await?;
                                    status = "paid".into();
                                    tracing::info!(session = %sid, granted = f.granted, "success page fulfilled ahead of the webhook");
                                    // 成功页抢先是**常态**（Stripe 先重定向、webhook 后到），
                                    // 所以回执必须挂在这里：webhook 随后看到「已经付过了」，
                                    // 什么都不会再发，买家一封回执都收不到。
                                    announce_fulfilment(&state, &f, "stripe-return").await;
                                }
                                // webhook 抢先了，也算成功。
                                Ok(None) => {
                                    tx.rollback().await.ok();
                                    status = "paid".into();
                                }
                                Err(e) => {
                                    tx.rollback().await.ok();
                                    tracing::warn!(session = %sid, err = %e.msg, "success page could not fulfil");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 发放之后的实际状态，从账号本身读 —— 而不是复述订单里写了什么。
    let (user_plan, plan_expires, credits_now, quota_total): (String, Option<chrono::DateTime<chrono::Utc>>, i64, i64) =
        sqlx::query_as(
            "SELECT plan, plan_expires_at, credits_cents, quota_total_cents FROM users WHERE id = $1",
        )
        .bind(uid)
        .fetch_one(&state.db)
        .await?;

    let label: Option<String> = match price_id {
        Some(pid) => sqlx::query_scalar("SELECT label FROM prices WHERE id = $1")
            .bind(pid)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None),
        None => None,
    };

    Ok(Json(json!({
        "paid": status == "paid",
        "kind": kind,
        "label": label,
        "plan": plan,
        "duration_days": duration_days,
        // 这一单买到的额度，和账号当前总余额分开报：用户想看到的是「这次拿到了什么」。
        "credits_cents": credits,
        "amount_cents": amount_cents,
        "charged_cents": charged,
        "charged_currency": charged_ccy,
        "raw_cents_per_credit_usd": crate::settings::raw_cents_per_credit_usd(),
        "account": {
            "plan": user_plan,
            "plan_expires_at": plan_expires,
            "credits_cents": credits_now,
            "quota_total_cents": quota_total,
        },
    })))
}

#[cfg(test)]
mod bind_arity_tests {
    /// 每条 SQL 用到的最大 `$n`，必须有同样多的 `.bind(...)` 跟在后面。
    ///
    /// 这个错在本次改动里犯了第二次：漏一个 `.bind` 编译期毫无提示，跑起来才报
    /// 「bind message supplies 1 parameters, but prepared statement requires 2」，
    /// 而且只在那一条路径被真正走到时才出现 —— 支付成功页正是那种平时没人点的路径。
    /// referral.rs 有一份同样的守卫，这是 stripe.rs 的那份。
    #[test]
    fn every_query_binds_what_its_sql_asks_for() {
        let src = include_str!("stripe.rs");
        let mut checked = 0;
        for (idx, _) in src.match_indices("sqlx::query") {
            let tail = &src[idx..];
            let end = tail.find(".await").unwrap_or(tail.len().min(3000));
            let stmt = &tail[..end];

            // 只看 SQL 字符串字面量本身。整段扫会把注释里的金额（"$100"）当成占位符。
            let Some(q0) = stmt.find('"') else { continue };
            let rest = &stmt[q0 + 1..];
            let mut sql_len = 0usize;
            let bytes = rest.as_bytes();
            while sql_len < bytes.len() {
                if bytes[sql_len] == b'\\' {
                    sql_len += 2;
                    continue;
                }
                if bytes[sql_len] == b'"' {
                    break;
                }
                sql_len += 1;
            }
            let sql = &rest[..sql_len.min(rest.len())];

            let mut max_n = 0usize;
            let b = sql.as_bytes();
            for i in 0..b.len() {
                if b[i] == b'$' {
                    let mut j = i + 1;
                    let mut n = 0usize;
                    while j < b.len() && b[j].is_ascii_digit() {
                        n = n * 10 + (b[j] - b'0') as usize;
                        j += 1;
                    }
                    if j > i + 1 && n <= 40 {
                        max_n = max_n.max(n);
                    }
                }
            }
            if max_n == 0 {
                continue;
            }
            let binds = stmt[q0 + sql_len..].matches(".bind(").count();
            checked += 1;
            assert!(
                binds >= max_n,
                "一条 SQL 用到了 ${max_n}，但只跟了 {binds} 个 .bind —— 漏绑在编译期查不出来，\
                 只有那条路径被走到时才 500。语句片段：\n{}",
                &sql[..sql.len().min(240)],
            );
        }
        assert!(checked > 15, "扫到的语句太少（{checked}），这个断言可能没在检查什么");
    }
}

#[cfg(test)]
mod fulfilment_gate_tests {
    use super::*;

    /// 从源码里切出一个顶层函数：签名到第一处顶格 `}`。
    ///
    /// 函数体里的括号都有缩进，所以「顶格的 }」就是这个函数的结尾。比按行数切稳。
    fn top_level_fn<'a>(src: &'a str, needle: &str) -> &'a str {
        let start = src.find(needle).unwrap_or_else(|| panic!("找不到 {needle}"));
        let tail = &src[start..];
        let end = tail.find("\n}\n").map(|i| i + 3).unwrap_or(tail.len());
        &tail[..end]
    }

    /// 剥掉注释再做源码断言 —— 两种注释都要剥。
    ///
    /// 这个坑本文件已经踩过：end_subscription 的注释里**逐字**引用了被换掉的旧写法
    /// （`COALESCE(subscription_ended_at, now())`），只按行剥 `//` 又漏了 `/* */`
    /// 那一大段——注释一路把断言喂饱，把 bug 放回去照样绿。断言也因此只挑实现特征
    /// （SQL 片段、调用名），不挑说明词。
    fn code_only(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut rest = src;
        // 本文件的 /* */ 只用来写大段事故说明：不嵌套，也从不出现在字符串字面量里。
        while let Some(i) = rest.find("/*") {
            out.push_str(&rest[..i]);
            match rest[i..].find("*/") {
                Some(j) => rest = &rest[i + j + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 从 `needle` 起按花括号配平切出一个语句块（含首尾大括号）。
    ///
    /// 不按「下一处同缩进的 `}`」切：要切的那个拒发分支里 `return Ok(Some(Fulfilled { … }))`
    /// 自带一层括号，按缩进切会在它身上断掉，切出来短一截。而这上面挂的断言是「块里
    /// **没有**某个调用」——片段短了断言自动为真，又变成一条空守卫。
    /// 调用方必须先 `code_only`：注释里一个 `{` 就能把配平算歪。
    fn brace_block<'a>(src: &'a str, needle: &str) -> &'a str {
        let start = src.find(needle).unwrap_or_else(|| panic!("找不到 {needle}"));
        let open =
            start + src[start..].find('{').unwrap_or_else(|| panic!("{needle} 后面没有 {{"));
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[start..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("{needle} 的块没有闭合")
    }

    /// 限购的判据是「除自己以外还有没有**另一笔**已付款的同款订单」。
    ///
    /// 边界就在第二笔上：第一笔必须放行（它就是那次合法购买），第二笔必须拦。
    /// 写成 `> 1` 会正好把第二笔放过去，而第二笔起就是白拿。
    #[test]
    fn the_second_paid_order_is_the_one_that_must_be_refused() {
        assert!(!once_per_account_blocks(true, 0), "第一笔必须放行");
        assert!(once_per_account_blocks(true, 1), "第二笔就该拒——刷额度全靠这一笔");
        assert!(once_per_account_blocks(true, 99), "第 100 笔更该拒");
        assert!(!once_per_account_blocks(false, 99), "不限购的商品不受这道闸影响");
    }

    /// 限购必须在**发放点**兜住，不能只在结账时查。
    ///
    /// 结账那次查的是「已付款」的订单数，N 个还没付的 checkout 全都能通过它：连开 N 个
    /// 日卡结账、一起付掉，apply_plan 是加法，$1 的日卡就叠出 N 份额度。
    /// 而 catalog 里写着「reach Stripe and get refused at fulfilment」—— 在这段代码
    /// 存在之前，那句话是假的：fulfil_session 把标志读进来过，一次都没看过它。
    #[test]
    fn once_per_account_is_enforced_at_the_grant_not_only_at_checkout() {
        let src = include_str!("stripe.rs");
        let owned = code_only(top_level_fn(src, "async fn fulfil_session("));
        let body = owned.as_str();
        // 找的是**带条件的那一行**，不是「提到过 once_per_account」。差别是实的：
        // 把条件改成常量假、闸门原地变成死代码，这条守卫第一版就没拦住。
        let check = body.find("if row.once_per_account {").expect(
            "fulfil_session 不再按 once_per_account 分支：连开 N 个结账再一起付就是 N 份额度",
        );
        let grant = body.find("grant(tx, uid, &row, quantity)").expect("grant 调用不见了");
        assert!(check < grant, "限购检查排在发放之后，等于没有");

        let gate = &body[check..grant];
        assert!(gate.contains("return Ok(Some("), "查了却没拦：检查必须能提前返回");
        // 数「别人」要排除正在履约的这一笔。忘了排除，方向就反过来：上面刚把这笔
        // 认领成 'paid'，它会数到自己，于是**第一次**合法购买也被拒发。
        assert!(
            gate.contains("stripe_session_id IS DISTINCT FROM"),
            "COUNT 没排除正在履约的这一笔，第一次合法购买就会被当成重复购买拒发",
        );

        // 那句 COUNT 只挡得住**串行**付款。并发的两笔认领的是不同的 orders 行，彼此不
        // 冲突，READ COMMITTED 下两次 COUNT 各拿各的旧快照，谁都数不到对方——两笔都会发。
        // 补住这一半的只有 users 那把行锁，而且它必须排在 COUNT **前面**：排在后面，
        // 第二笔在排队拿锁之前就已经把 0 读走了，锁等于白拿。
        //
        // 这两条是后补的：在此之前把那四行锁整段删掉，本模块 4 个测试全绿。
        let lock = gate.find("FROM users WHERE id = $1 FOR UPDATE").expect(
            "没先锁 users 行：两笔并发履约认领的是不同的 orders 行，\
             各自 COUNT 都看不见对方，两笔都会发",
        );
        let count = gate.find("SELECT count(*) FROM orders").expect("限购的 COUNT 不见了");
        assert!(
            lock < count,
            "users 行锁排在 COUNT 之后：并发的第二笔在拿到锁之前就数完了，这道闸只挡得住串行付款",
        );

        assert!(gate.contains("granted: false"), "拒发之后要让调用方知道这一笔没发货");
        // 钱已经收了。不许静默——订单上要留痕，运营才有得查。
        assert!(
            gate.contains("UPDATE orders SET note"),
            "收了钱不发货却不在订单行上留痕，这笔钱就没人知道该退",
        );
        // announce_fulfilment 的注释里给运营留了一句按 `once_per_account:` 前缀捞单的 SQL。
        // 前缀改了，那句 SQL 不报错，只是静默返回 0 行——看起来像「没有待退款的单」。
        assert!(
            ONCE_PER_ACCOUNT_REFUND_NOTE.starts_with("once_per_account:"),
            "退款留痕的前缀变了：注释里给运营的 `note LIKE 'once_per_account:%'` 会静默捞不到单",
        );

        // 一笔准备退掉的销售不该产生推荐佣金。
        //
        // 这里原来写的是 `!gate.contains("referral::award")`，那是句空话：gate 只切到
        // grant 为止，而 award 本来就在 grant **之后**，改这个 bug 之前的代码也一样能过；
        // 它只有在有人把 award 挪到 grant 上面时才会响。真正要钉的是拒发那个分支自己——
        // 在分支里加一行 `use crate::referral::award; award(...).await;`，旧断言纹丝不动。
        let refuse = brace_block(body, "if once_per_account_blocks(");
        assert!(
            !refuse.contains("award("),
            "拒发分支里出现了计佣：这一笔是准备退掉的，不该产生推荐佣金——\
             真退款时 charge.refunded 会走 referral::reverse，两条路都不留脏账",
        );
        assert!(
            refuse.contains("return Ok(Some("),
            "拒发分支自己没有提前返回，会一路走到 grant——上面那条只看得出「gate 里某处有 return」",
        );
    }

    /// 三条能赢下履约竞态的路径，都要发回执 / 记事件。
    ///
    /// webhook、对账扫描、支付成功页都能是真正发放的那一条，而回执原来只挂在 webhook 上。
    /// 成功页抢先是常态（Stripe 先重定向），于是那些订单一封回执都没有——退订页却写着
    /// 「回执照发」。
    #[test]
    fn whichever_path_wins_the_race_sends_the_receipt() {
        // 先剥注释再断言。webhook 体内有一行 `// announce_fulfilment —— 三条能赢下竞态的
        // 路径共用同一个出口`，**逐字**含被断言的那个名字：不剥的话，把真实调用整句删掉
        // 这条断言照样绿 —— 三条腿里恰恰只有 webhook 这一条是被自己的注释喂饱的。
        let src = code_only(include_str!("stripe.rs"));
        for (needle, who) in [
            ("pub async fn webhook(", "webhook"),
            ("async fn reconcile_once(", "对账扫描"),
            ("pub async fn session_result(", "支付成功页"),
        ] {
            let body = top_level_fn(&src, needle);
            assert!(
                body.contains("announce_fulfilment("),
                "{who} 能抢到履约却不发回执、不记 order_paid —— \
                 同一笔付款收不收得到回执，变成看哪条路径先跑到",
            );
        }
        // 只有一处真正发信，所以「谁发的」等价于「谁发放的」，不会重复发。
        // 针不能写成字面量：这行断言自己也在源码里，会被自己数进去。
        let needle = format!("{}(&st", "send_purchase_receipt");
        let sends = src.as_str().matches(needle.as_str()).count();
        assert_eq!(sends, 1, "回执有 {sends} 个发出点，重复发只是时间问题");
    }

    /// 退订一条订阅，只许拿回这条订阅自己那一份额度。
    ///
    /// 兑换码 / 管理员发放 / 日卡 / 一次性套餐都往同一个 quota_total_cents 里加，且都不写
    /// stripe_subscription_id —— end_subscription 里那句「还有没有别的活订阅」看不见它们。
    /// 原来这里无条件 clear_plan（归零），于是退一条订阅会把兑换码买的额度一起抹掉。
    #[test]
    fn cancelling_a_subscription_only_takes_back_its_own_quota() {
        // 兑换码给了 5000，basic 订阅给了 33000；退订只该拿走 33000。
        assert_eq!(quota_after_subscription_ends(38_000, 33_000), 5_000);
        assert_eq!(quota_after_subscription_ends(33_000, 33_000), 0);
        // 池子里剩的比套餐面额还少（订阅那份已经花掉大半）——夹到 0，绝不做成负数：
        // 负数在 `quota_total_cents > 0` 的访问闸那里和 0 长得一样，看不出异常，
        // 却会让之后每一次充值先去填坑。
        assert_eq!(quota_after_subscription_ends(1_000, 33_000), 0);
        assert_eq!(quota_after_subscription_ends(0, 33_000), 0);

        let src = include_str!("stripe.rs");
        // 先剥注释再断言（code_only 的文档里写了这个坑长什么样）：这个函数的 `//` 注释里
        // **逐字**引用了被换掉的旧写法（`COALESCE(subscription_ended_at, now())`）和
        // `clear_plan`，而 /* */ 那一大段又逐字写着扣减取的是 plan_quotas 里的面额。
        // 连注释一起扫，下面这些断言全会被注释喂到——把 bug 放回去也照样绿。
        let owned = code_only(top_level_fn(src, "async fn end_subscription("));
        let body = owned.as_str();
        assert!(
            body.contains("quota_after_subscription_ends"),
            "退订又回到了无条件清零：非订阅来源的额度会被一起抹掉，而且不留任何痕迹",
        );
        let deduct = body
            .find("quota_after_subscription_ends")
            .expect("减法不见了");
        assert!(
            body[deduct..].contains("if remaining == 0"),
            "缺了「减完为 0 才清 plan」这道判断，clear_plan 会照样把剩下的额度抹掉",
        );

        // 减法本身对，取数取错照样扣错——而下面这几句上面一条都管不着。
        //
        // 三种改法都能让上面的断言全绿而结果是错的：ORDER BY 掉个头（中途升过级的账号
        // 按升级**前**那档扣）、去掉 kind = 'plan'（同一条订阅上的加购/手工行会被当成
        // 套餐行）、绑成别的订阅 id（扣的是人家那条订阅的面额）。
        let lookup = body
            .find("SELECT plan FROM orders")
            .expect("按订阅反查套餐的语句不见了：没有它就不知道该减多少");
        let stmt: String = body[lookup..].chars().take(300).collect();
        assert!(
            stmt.contains("WHERE stripe_subscription_id = $1 AND kind = 'plan'"),
            "套餐反查没有同时按「这条订阅」和「套餐行」收窄：丢掉 kind = 'plan' 就会\
             把同一条订阅上的加购行当成套餐行，扣错面额",
        );
        assert!(
            stmt.contains("ORDER BY created_at DESC LIMIT 1"),
            "套餐反查取的不是**最新**那条 plan 订单：中途升过级的账号，退订时会按升级前那档扣",
        );
        assert!(stmt.contains(".bind(sub)"), "套餐反查绑的不是当前这条订阅");
        assert!(lookup < deduct, "先减后查，减的是上一次的答案");

        // 读—算—写 之前先拿 users 行锁。两条取消事件并发进来，各自读到同一个旧总额，
        // 两次减法落在同一个基数上，等于只减了一份。apply_plan 拿的也是这把锁。
        let lock = body
            .find("SELECT quota_total_cents FROM users WHERE id = $1 FOR UPDATE")
            .expect("读总额没带 FOR UPDATE：并发的两条取消事件各按旧值算，只会减掉一份");
        assert!(lock < deduct, "行锁排在减法之后，减法用的还是拿锁之前读到的旧值");

        // 扣减必须只发生一次。
        //
        // 抓的是这个修复自己差点带进来的 bug：扣减是「读—算—写」，不像原来那句纯标记那样
        // 天然幂等，而 end_subscription 对同一次取消会被走两遍——customer.subscription.deleted
        // 和 customer.subscription.updated（终态）是两个独立 event id，stripe_events 的去重
        // 按 event id 走，两条都放行。走两遍的话：38000 −33000→ 5000，第二条再 5000 −33000
        // 夹到 0 → clear_plan，兑换码那 5000 还是没了，只是分两步。
        //
        // 所以标记语句必须是**认领**（NULL → now()），并且扣减挂在 rows_affected 后面。
        let claim = body
            .find("subscription_ended_at IS NULL")
            .expect("结束标记必须是认领：WHERE ... AND subscription_ended_at IS NULL");
        assert!(
            !body[..claim].contains("COALESCE(subscription_ended_at, now())"),
            "标记退回了 COALESCE 写法：那样每一次重投都会认领成功，扣减跟着跑第二遍",
        );
        assert!(
            body.contains("rows_affected()") && body.contains("if claimed_ending == 0"),
            "缺少「没抢到就直接返回」这道闸——重投事件会把额度再扣一遍",
        );
        assert!(
            claim < deduct,
            "认领必须排在扣减之前，否则闸门形同虚设",
        );
    }
}
