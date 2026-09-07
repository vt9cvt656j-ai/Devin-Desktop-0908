//! 对账：**每个中转站收我们多少，我们从用户身上收回来多少，差额是正是负。**
//!
//! # 两侧的数从哪来
//!
//! 收入那一侧是现成的：`endpoint_usage.cost_micro_usd` 记的就是「按这个出口发出去的
//! 请求，一共扣了用户多少钱」，逐笔累加，和计费同源。
//!
//! 成本那一侧没有任何接口能直接回答。这里给两个数，**它们互为校验**：
//!
//! · **估算成本** = 收入 × `cost_ratio / rate`。这个恒等式成立是因为两边同底：
//!   用户被扣的是 `tokens × 官方价 × rate`，我们付上游的是 `tokens × 官方价 × cost_ratio`，
//!   官方价和 tokens 一约就没了。好处是**部署当天就有数**，不用等快照攒够。
//!   它的前提是运维把 `cost_ratio` 填对了 —— 填错就只是把一个错误的假设算得很精确。
//!
//! · **实测成本** = 中转账户余额（或「已用」）在这段时间里的变化量。这是真金白银，
//!   不依赖任何人填对什么。代价是要等两次快照，而且有些中转根本不给余额接口。
//!
//! 两个数差得远，说明 `cost_ratio` 填错了，或者上游在按和你以为的不同的价目表收费。
//! 这正是对账要抓的东西 —— 所以两个都显示，不合并成一个。
//!
//! # 为什么优先用「已用」而不是「余额」
//!
//! 余额会被充值打断：期间充了 100 刀，`first - last` 会算出一个负成本，然后面板显示
//! 这条线路在给你送钱。「已用」是单调递增的，充值不影响它。只有在这家不给「已用」时
//! 才退回余额，并且**一旦发现余额上升就整段作废**，而不是把负数当成利润报上去。

use axum::extract::{Query, State};
use axum::Json;
use std::collections::HashMap;
use std::time::Duration;

use crate::auth::Claims;
use crate::error::{AppError, ApiResult};
use crate::models::Model;
use crate::AppState;

/// 多久拍一次余额快照。
///
/// 30 分钟：对账看的是天/周级别的差额，再密只是多打网络往返；再疏则「今天花了多少」
/// 会只剩一两个采样点，一次网络抖动就让当天没有数。
const SNAPSHOT_EVERY: Duration = Duration::from_secs(30 * 60);
/// 查一次余额的耐心。三种形态各试一次，所以给得比单次请求宽一点。
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

// ---------------------------------------------------------------- 快照

/// 拍一轮：每条线路自带地址 + 它挂的每个出口，各存一行。
pub async fn snapshot_once(state: &AppState) {
    let Ok(http) = reqwest::Client::builder().timeout(SNAPSHOT_TIMEOUT).build() else {
        return;
    };
    let routes: Vec<Model> =
        match sqlx::query_as("SELECT * FROM models WHERE active = true ORDER BY sort, created_at")
            .fetch_all(&state.db)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "余额快照：线路读不出来，本轮跳过");
                return;
            }
        };
    let eps = crate::route_endpoints::load_for_routes(
        &state.db,
        &routes.iter().map(|m| m.id).collect::<Vec<_>>(),
    )
    .await;

    // 「问了几个」和「问到几个」都要报出来。
    //
    // 只在失败时打日志的话，「跑了一轮但一家都不给余额接口」和「这个任务压根没起来」
    // 在日志里长得一模一样 —— 而它们要做的事完全相反（前者去换个中转或手工记账，
    // 后者去查任务为什么没跑）。实测线上第一轮就是 0 行，当时无从判断是哪一种。
    let mut tried = 0usize;
    let mut got = 0usize;

    for r in &routes {
        // (出口 id, 地址, 调用密钥, 余额令牌)
        let mut targets: Vec<(uuid::Uuid, String, String, String)> =
            vec![(r.id, r.base_url.clone(), r.api_key.clone(), r.balance_token.clone())];
        for e in eps.get(&r.id).into_iter().flatten().filter(|e| e.active) {
            let key = if e.api_key.trim().is_empty() { r.api_key.clone() } else { e.api_key.clone() };
            // 出口没配令牌就用线路的 —— 同一个中转账号挂几个入口是常见配置。
            let btok = if e.balance_token.trim().is_empty() { r.balance_token.clone() } else { e.balance_token.clone() };
            targets.push((e.id, e.base_url.clone(), key, btok));
        }
        for (id, base, key, btok) in targets {
            // 两种凭据都空才跳过：只配了令牌没配密钥是合法的。
            if base.trim().is_empty() || (key.trim().is_empty() && btok.trim().is_empty()) {
                continue;
            }
            tried += 1;
            // 和健康面板、网关适配器走**同一个入口**。这里曾经直接调 route_endpoints
            // 那份独立实现，而它对 sub2api 打的是要控制台令牌的那条路 —— 三处各自
            // 查余额、其中两处拿不到，那正是这次要消灭的形状。
            let Some(b) = crate::relay_sync::balance_now(
                state,
                id,
                &base,
                &crate::models::model_key(&key),
                &crate::models::model_key(&btok),
            )
            .await
            else {
                // 查不到就**不写行**。写一行 NULL 会让「这家没有余额接口」和
                // 「这次网络抖了一下」长得一模一样，而前者不该每半小时占一行。
                continue;
            };
            let _ = sqlx::query(
                "INSERT INTO endpoint_balance (endpoint_id, route_id, remaining_usd, used_usd, raw) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(id)
            .bind(r.id)
            .bind(b.remaining_usd)
            .bind(b.used_usd)
            .bind(&b.text)
            .execute(&state.db)
            .await;
            got += 1;

            // 余额比上一次高 = 充值。
            //
            // 这是**没有控制台令牌时唯一能拿到充值事实的途径**，也是套餐表的交叉验证：
            // 到账金额对不上任何一档套餐，说明套餐表过期了，或者这笔是站外充的
            // （实测 zyz 那家 payment_enabled=false，充值走站外）。
            //
            // 阈值不是防抖，是防「同一个数的浮点尾巴」：实测两次读数会在小数点后
            // 第八位抖动，不夹的话每半小时就记一笔金额为 0.00000001 的「充值」。
            if let Some(now_bal) = b.remaining_usd {
                let prev: Option<f64> = sqlx::query_scalar(
                    "SELECT remaining_usd FROM endpoint_balance \
                     WHERE endpoint_id = $1 AND remaining_usd IS NOT NULL \
                       AND taken_at < now() - INTERVAL '1 second' \
                     ORDER BY taken_at DESC LIMIT 1",
                )
                .bind(id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
                if let Some(prev) = prev {
                    let delta = now_bal - prev;
                    if delta > 0.01 {
                        // 就近匹配一档套餐。匹配不上就留空，**不猜一个价** ——
                        // 猜出来的人民币金额会让「1 元买到多少」整个失真。
                        let hit: Option<(String, f64, String)> = sqlx::query_as(
                            "SELECT plan_key, price, currency FROM endpoint_topup_plan \
                             WHERE endpoint_id = $1 AND granted IS NOT NULL \
                               AND abs(granted - $2) < greatest(0.01, $2 * 0.02) \
                             ORDER BY abs(granted - $2) LIMIT 1",
                        )
                        .bind(id)
                        .bind(delta)
                        .fetch_optional(&state.db)
                        .await
                        .ok()
                        .flatten();
                        let (plan, price, cur) = match hit {
                            Some((k, p, c)) => (k, Some(p), c),
                            None => (String::new(), None, String::new()),
                        };
                        let _ = sqlx::query(
                            "INSERT INTO endpoint_topup_event \
                               (endpoint_id, route_id, before_bal, after_bal, granted, \
                                matched_plan, price, currency) \
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                        )
                        .bind(id)
                        .bind(r.id)
                        .bind(prev)
                        .bind(now_bal)
                        .bind(delta)
                        .bind(&plan)
                        .bind(price)
                        .bind(&cur)
                        .execute(&state.db)
                        .await;
                        tracing::info!(%id, prev, now_bal, delta, plan = %plan,
                            "余额上升，记为一次充值");
                    }
                }
            }
        }
    }

    if got == 0 && tried > 0 {
        // 一个都问不到不是错误 —— 多数国内中转的 /api/user/self 认的是控制台登录令牌，
        // 不是 sk- 开头的调用密钥。但它必须说出来，否则对账页的「成本(实测)」会永远
        // 空着而没人知道为什么。
        tracing::info!(
            tried,
            "余额快照：问了 {tried} 个出口，没有一个给出可识别的余额 ——              对账页的「成本(实测)」会一直空着，只能用估算列"
        );
    } else {
        tracing::info!(tried, got, "余额快照完成");
    }
}

/// 起后台任务。
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 开机就拍一张：否则重启之后要等半小时才有第一个采样点，
        // 而重启往往正发生在「出事了在查」的时候。
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            snapshot_once(&state).await;
            tokio::time::sleep(SNAPSHOT_EVERY).await;
        }
    });
}

// ---------------------------------------------------------------- 对账

#[derive(sqlx::FromRow, Clone)]
struct ModelUsage {
    endpoint_id: uuid::Uuid,
    model_id: String,
    calls: i64,
    revenue_micro: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    cached_tokens: i64,
    cache_creation_tokens: i64,
    /// `prompt_tokens` 含不含 `cached_tokens`。跟着回执走，事后反推不出来。
    /// 老行（这一列上线前的）是 NULL，见 `prompt_is_inclusive` 的兜底。
    prompt_includes_cached: Option<bool>,
}

#[derive(sqlx::FromRow, Clone)]
pub struct ModelPrice {
    pub endpoint_id: uuid::Uuid,
    pub model_id: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cached_per_mtok: Option<f64>,
    /// 每百万「写入缓存的 token」多少美元。NULL = 没录，按输入价 × 1.25 推
    /// （上游普遍的倍数）—— **不按 0**。按 0 就是这个 bug 的原样重演。
    pub cache_write_per_mtok: Option<f64>,
    /// 上游**按次**收的钱（美元/次）。new-api 形态的 `quota_type=1`、OpenRouter 的
    /// `request` 价都落在这里。这一列 `relay_sync` 一直在写，但读的人一个都没有 ——
    /// 于是「按次计费」的出口成本恒为 0，对账页上毛利 100%，且不进「待录单价」名单。
    /// 线上实测:366 条自动价里 35 条有按次价,其中 **32 条 input/output 都是 0**
    /// —— 对这 32 条,成本里除了按次价什么都没有,不读它就等于没有成本。
    /// 后果不止对账好看:`check_margin_after_change` 用同一份价重算,一条按次计费
    /// 的亏本线路永远算出 100% 毛利,自动止血那条链对这类出口**结构性哑掉**。
    pub per_request: Option<f64>,
    pub note: String,
}

#[derive(sqlx::FromRow)]
struct BalanceEdge {
    endpoint_id: uuid::Uuid,
    first_remaining: Option<f64>,
    last_remaining: Option<f64>,
    first_used: Option<f64>,
    last_used: Option<f64>,
    samples: i64,
}

/// 一个出口上某个模型这段时间的账。
#[derive(serde::Serialize)]
pub struct ModelRow {
    pub model_id: String,
    pub calls: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    /// 写进缓存的 token。**成本大头**，界面必须画出来 —— 不画的话
    /// 「输入才 2 个 token 怎么扣了 46 分」这种问题永远问不明白。
    pub cache_creation_tokens: i64,
    pub revenue_usd: f64,
    /// token × 录入单价。None = **这个模型的进价还没录**，不是 0。
    pub cost_usd: Option<f64>,
    pub margin_usd: Option<f64>,
    /// 当前录着的单价，回给界面直接填进输入框。
    pub input_per_mtok: Option<f64>,
    pub output_per_mtok: Option<f64>,
    pub cached_per_mtok: Option<f64>,
    pub price_note: String,
    /// 这个价是**推算**的（官方价 × 倍率），不是抓来的。
    /// 界面必须分开显示 —— 把推算的和实测的混成一个数，等于把一个假设说成事实。
    pub price_derived: bool,
}

#[derive(serde::Serialize)]
pub struct ReconRow {
    pub endpoint_id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub route_label: String,
    pub label: String,
    pub vendor: &'static str,
    pub is_own: bool,
    pub active: bool,
    pub calls: i64,
    pub revenue_usd: f64,
    /// 收入和成本**折成人民币**。页面上真正该看的是这两个。
    ///
    /// # 为什么必须折
    ///
    /// 上面那两个 `*_usd` 不是同一种「美元」，直接相减是量纲错误：
    ///
    /// * `revenue_usd` 是**真实计费分 ÷ 100**（`compute_cost` 里 `官方价 × 100 × 线路 rate`），
    ///   它的量纲由**线路自带地址那家**的充值汇率定；
    /// * `cost_usd` 是「真实 token × 这个出口的进价」，而进价无论是人工录的还是
    ///   按倍率推的，单位都是**这个出口那家中转的余额面值** —— 那个 `$` 不是美元。
    ///
    /// 两家的充值汇率差多少，减出来的毛利就错多少倍。线上实测：清衍挂在 Claude 线路下，
    /// 线路自带那家 ¥1 买 1 面值、清衍 ¥1 买 10 面值，于是成本被放大了 10 倍，
    /// 页面显示「收 $4.46 / 花 $10.89 / 毛利 -144%」—— 而清衍换算后每花掉一美元官方价
    /// 只要 ¥0.65，比自带地址还便宜。**同一条流水，两个相反的结论。**
    ///
    /// 顺带解释了为什么有些行看着正常：出口和自带地址在同一家时两边同倍放大，
    /// 百分比恰好抵消。只有跨家的行会炸，而那正是多路由要用的行。
    ///
    /// 换算口径和 `plan_health` 里那条单位链一字一样：人民币 = 真实分 ÷ 100 ÷ 充值汇率。
    ///
    /// **两家里有一家没填汇率就都是 None**，不拿另一家的顶上 —— 那会得到一个
    /// 看起来精确的错数字，而且没有任何地方会报错。
    pub revenue_cny: Option<f64>,
    pub cost_cny: Option<f64>,
    pub margin_cny: Option<f64>,
    /// 折不出来的时候说清楚是**哪一家**没填汇率，否则运维不知道该去填谁。
    pub fx_note: String,
    /// 真实成本 = Σ(真实 token × 录入单价)。
    ///
    /// **只有这个出口用过的模型全都录了价才有值。** 少录一个就是 None ——
    /// 把没录价的那部分按 0 加进来，得到的是一个看起来很精确的错数字。
    pub cost_usd: Option<f64>,
    pub margin_usd: Option<f64>,
    pub margin_pct: Option<f64>,
    /// 用过但还没录价的模型。非空 = 上面三个数都是 None。
    pub unpriced_models: Vec<String>,
    /// 这一行的成本里，有多少美元是按「官方价 × 倍率」推出来的。
    pub derived_cost_usd: f64,
    /// 推算部分折人民币。
    pub derived_cost_cny: Option<f64>,
    /// 这一行的调用/收入来自**按出口聚合的老表**（那段流量发生在按模型记账上线之前）。
    /// 成本拆不出来不是因为没录价，是因为没有模型维度可以乘单价。
    pub legacy_only: bool,
    /// 余额读数差出来的成本。和上面那个各自独立，用来**互相印证** ——
    /// 两个都有而且对不上，说明单价录错了或者中转在按另一份价目表收费。
    pub cost_by_balance_usd: Option<f64>,
    /// 余额口径折人民币。余额读数天生就是那家中转的面值单位，同样要折。
    pub cost_by_balance_cny: Option<f64>,
    pub balance_basis: Option<&'static str>,
    pub balance_note: String,
    /// 这个出口的进价**还能从哪儿拿到**。三档，越靠前越省事：
    ///
    ///   `panel`     —— 中转的面板价目接口能读，已经自动拿到了，什么都不用做；
    ///   `calibrate` —— 面板读不到，但**余额读得到** → 一键标定：发两发真实请求、
    ///                  按余额差反推真实进价（比价目表还准，含了分组倍率和活动折扣）；
    ///   `manual`    —— 面板和余额都读不到，只能人去抄。
    ///
    /// 加这一位是因为这三档此前在界面上**分不出来**：对账页只说「N 个模型待录价」，
    /// 而标定按钮埋在某一行展开之后。线上实测 34 个活跃出口里有 **8 个属于 calibrate
    /// 档、一次都没被标定过** —— 一个已经写好的、能自动解决问题的功能，因为没人知道
    /// 它对哪些出口可用而闲置着。
    pub price_source: &'static str,
    /// 拉不到价时适配器给的原话（「站长把价目接口关了」「面板被人机校验挡住」…）。
    /// 它一直存在 endpoint_adapter.note 里，但只在「适配器」那一屏显示 ——
    /// 而人是在对账页上发现「这个出口没成本」的。
    pub price_hint: String,
    /// 按模型展开。界面点开一行就是它，也是录价的地方。
    pub models: Vec<ModelRow>,
}

#[derive(serde::Deserialize)]
pub struct ReconQuery {
    /// 看最近几天。默认 7。
    #[serde(default)]
    pub days: Option<i64>,
}

/// 一个模型这一段的真实成本。
///
/// # 缓存 token 必须先从输入里减出来
///
/// `prompt_tokens` 是**含**缓存命中的总输入，各家的 usage 帧都是这个口径。
/// 不减直接乘输入价，命中率高的模型成本会被高估好几倍 —— 而缓存价通常只有输入价
/// 的十分之一，正是它让「同样的对话第二轮便宜得多」这件事成立。
///
/// `cached_per_mtok` 没录时按输入价算：那等于「这家不给缓存折扣」，是**保守**的方向
/// （宁可把成本算高一点，也不要把毛利算得比实际好看）。
/// 上游普遍的缓存写入倍数：输入价的 1.25 倍。没录写入价时按它推。
///
/// 推一个数而不是当 0：0 是**确定错的**（上游一定收了这笔钱），而 1.25 是
/// 实测普遍值。宁可估得接近，也不要一个确定为假的零。
const CACHE_WRITE_FACTOR: f64 = 1.25;

/// 抓不到价目时，按 **OpenRouter 官方价 × 这个出口的倍率** 推一个进价。
///
/// # 为什么这不是「编一个数」
///
/// 中转本来就是这么定价的：我们真抓到的价目里，`group_multiplier` 就是原样折在
/// 单价上的（梦幻API 的 grok-heavy 分组 0.2 倍 → $2 的官方价标成 $0.40）。
/// 所以「官方价 × 倍率」复现的是它们自己的定价规则，不是拍脑袋。
///
/// 官方价取自 OpenRouter 的实时目录（`official_price`，和计费用的是同一份），
/// 那是全网最全也最新的一份公开价目 —— 411 个模型，每半小时刷新。
///
/// # 但它仍然是推算，必须标出来
///
/// 用户明确要求过「都不要估算，都要真实的计算」，而那次删掉的估算
/// （`收入 × 进价折扣 ÷ 计费倍率`）**前提是假的** —— 那个折扣是排序旋钮不是价格。
/// 这一条不同：前提是中转真实的定价规则。但它终究是推的，所以
/// `price_note` 会写明来源，界面上和抓来的真价分开显示，合计也分开报。
///
/// 目录里没有这个模型 → 返回 None，仍然是「待录单价」。**不猜。**
fn derived_price(endpoint_id: uuid::Uuid, model_id: &str, ratio: f64) -> Option<ModelPrice> {
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }
    let (inp, out) = crate::models::official_price(model_id)?;
    // 缓存价跟着目录的真实倍数走，和 compute_cost 一个做法 —— 目录给了就用它的比例，
    // 没给就留空，由 model_cost_usd 按输入价推。
    let live = crate::model_catalog::lookup(model_id);
    let scale = |v: Option<f64>| match (v, inp) {
        (Some(c), i) if i > 0.0 => Some(c / i * inp * ratio),
        _ => None,
    };
    Some(ModelPrice {
        endpoint_id,
        model_id: model_id.to_string(),
        input_per_mtok: inp * ratio,
        output_per_mtok: out * ratio,
        cached_per_mtok: scale(live.as_ref().and_then(|e| e.cache_read_price)),
        cache_write_per_mtok: scale(live.as_ref().and_then(|e| e.cache_write_price)),
        // 推算价来自 OpenRouter 官方**按量**价目，没有按次那一项。
        per_request: None,
        note: format!("推算：OpenRouter 官方价 × 倍率 {}", (ratio * 10000.0).round() / 10000.0),
    })
}

/// 一个模型这段时间的真实成本。
///
/// # 缓存写入必须算进来
///
/// 上一版只算「新鲜输入 + 缓存读 + 输出」，**完全漏掉了写入**。而上游按输入价的
/// 1.25 倍收写入，实测一次 claude-opus-5 调用里写入是新鲜输入的一百六十倍
/// （381 vs 61,634）—— 那一笔 $1.16 的成本里有 $1.156 是写入。
///
/// 后果不是随机误差，是**系统性单向偏差**：收入那一侧一直算了写入
/// （`compute_cost` 里的 write_tok），成本这一侧当 0，于是毛利被高估，
/// 而且缓存命中率越高的模型账面越漂亮、实际越亏。
/// 这一份用量的 `prompt_tokens` 含不含缓存读。
///
/// 有记录就照记录（写进库的那一刻从回执上读到的，见 `BillTokens`）。
/// 老行没有这一列，只能推：`cached > prompt` 在「含」的形状下**不可能**发生，
/// 出现了就一定是 Anthropic 形状；同理 Anthropic 才会单独报缓存写入。
/// 两个都不成立就按「含」算 —— 那是这一列上线之前的行为，不制造新的偏差。
fn prompt_is_inclusive(u: &ModelUsage) -> bool {
    if let Some(v) = u.prompt_includes_cached {
        return v;
    }
    !(u.cached_tokens > u.prompt_tokens || u.cache_creation_tokens > 0)
}

/// # 两家的回执形状不一样，夹一刀会把缓存读整段丢掉
///
/// 上一版写的是 `cached = min(cached, prompt)`。对 OpenAI 形状（prompt 含缓存读）
/// 是对的；对 Anthropic 形状（prompt **不**含）就把超出的部分全丢了。
/// 线上实测最近 7 天：claude-fable-5 输入 764,233 / 缓存读 10,818,782，
/// claude-opus-5 输入 569,259 / 缓存读 6,436,239 —— 一共 1590 万个缓存读 token
/// 从成本里消失，还顺带把那几十万新鲜输入按缓存价算了。
///
/// 偏差是**单向**的：成本低估、毛利高估，缓存命中率越高错得越狠。计费那边
/// （`compute_cost`）一直是按形状分开算的，只有对账这一侧在夹刀 —— 于是同一批
/// token，收钱按一套算、算成本按另一套算。
fn model_cost_usd(u: &ModelUsage, p: &ModelPrice) -> f64 {
    let (fresh, cached) = if prompt_is_inclusive(u) {
        let cached = u.cached_tokens.max(0).min(u.prompt_tokens.max(0));
        ((u.prompt_tokens.max(0) - cached) as f64, cached)
    } else {
        // Anthropic 形状：prompt 就是新鲜输入，缓存读是另外一份，不相减也不夹。
        (u.prompt_tokens.max(0) as f64, u.cached_tokens.max(0))
    };
    let cached_price = p.cached_per_mtok.unwrap_or(p.input_per_mtok);
    let write_price = p
        .cache_write_per_mtok
        .unwrap_or(p.input_per_mtok * CACHE_WRITE_FACTOR);
    // 按次那一项**不除以一百万** —— 它的单位是美元/次，不是美元/百万 token。
    // 上游同时按次又按量的（OpenRouter 有这种）两项都算，只按次的那 32 条出口
    // 全部成本都在这一项里。
    let per_call = u.calls.max(0) as f64 * p.per_request.unwrap_or(0.0);
    (fresh * p.input_per_mtok
        + cached as f64 * cached_price
        + u.cache_creation_tokens.max(0) as f64 * write_price
        + u.completion_tokens.max(0) as f64 * p.output_per_mtok)
        / 1_000_000.0
        + per_call
}

/// `GET /api/admin/reconciliation?days=7`
///
/// 一行一个出口：收了多少、真实花了多少、差额多少。**没有估算**。
pub async fn admin_reconciliation(
    State(state): State<AppState>,
    claims: Claims,
    Query(q): Query<ReconQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    // 上下界都钳住：0 天什么都查不出来，而不限上界会让一次点击扫全表。
    let days = q.days.unwrap_or(7).clamp(1, 90);

    let routes: Vec<Model> =
        sqlx::query_as("SELECT * FROM models WHERE active = true ORDER BY sort, created_at")
            .fetch_all(&state.db)
            .await?;
    let eps = crate::route_endpoints::load_for_routes(
        &state.db,
        &routes.iter().map(|m| m.id).collect::<Vec<_>>(),
    )
    .await;

    let usage: Vec<ModelUsage> = sqlx::query_as(
        "SELECT endpoint_id, model_id, \
                SUM(calls)::bigint             AS calls, \
                SUM(revenue_micro_usd)::bigint AS revenue_micro, \
                SUM(prompt_tokens)::bigint     AS prompt_tokens, \
                SUM(completion_tokens)::bigint AS completion_tokens, \
                SUM(cached_tokens)::bigint     AS cached_tokens, \
                SUM(cache_creation_tokens)::bigint AS cache_creation_tokens, \
                bool_and(prompt_includes_cached)   AS prompt_includes_cached \
         FROM endpoint_model_usage \
         WHERE day > current_date - $1::int \
         GROUP BY endpoint_id, model_id",
    )
    .bind(days as i32)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // 价目有两个来源，**自动的优先**：
    //
    //   · `endpoint_auto_price` —— 网关适配器从中转自己的接口拉回来的，会随倍率变化
    //     自动跟上；
    //   · `endpoint_model_price` —— 运维手填的，只在拉不到时兜底（有些中转把价目
    //     接口关了，one-api 上游干脆没有）。
    //
    // 这里曾经**只读手填那张**：适配器拉回来的 535 条真实进价一条都没被用上，
    // 于是「明明自动拉到了价，对账页成本还是空的」。
    let mut price_of: HashMap<(uuid::Uuid, String), ModelPrice> = HashMap::new();
    for p in sqlx::query_as::<_, ModelPrice>("SELECT * FROM endpoint_model_price")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
    {
        price_of.insert((p.endpoint_id, p.model_id.clone()), p);
    }
    #[derive(sqlx::FromRow)]
    struct AutoPrice {
        endpoint_id: uuid::Uuid,
        model_id: String,
        input_per_mtok: f64,
        output_per_mtok: f64,
        cached_per_mtok: Option<f64>,
        cache_write_per_mtok: Option<f64>,
        per_request: Option<f64>,
        source: String,
    }
    for a in sqlx::query_as::<_, AutoPrice>(
        // cache_write_per_mtok 这一列在 endpoint_auto_price 里**一直有**，只是从来没被
        // 读出来过 —— 抓价的时候存了，算成本的时候没用。
        // 过期的抓价由 `relay_sync::sweep` 在同步那一轮统一清掉，这里读到的就是新鲜的。
        //
        // **刻意不在每条查询上各挂一个新鲜度过滤器**：读这张表的地方有五处（这里、
        // 覆盖率、推算成本、比价屏…），五份手写的天数必然会漂，而漂掉的那一处会
        // 安静地继续拿冻结的旧价算成本。清理放在**唯一的写入方**那里，读的人不用知道。
        "SELECT endpoint_id, model_id, input_per_mtok, output_per_mtok, cached_per_mtok, \
                cache_write_per_mtok, per_request, source \
         FROM endpoint_auto_price",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    {
        price_of.insert(
            (a.endpoint_id, a.model_id.clone()),
            ModelPrice {
                endpoint_id: a.endpoint_id,
                model_id: a.model_id,
                input_per_mtok: a.input_per_mtok,
                output_per_mtok: a.output_per_mtok,
                cached_per_mtok: a.cached_per_mtok,
                cache_write_per_mtok: a.cache_write_per_mtok,
                per_request: a.per_request,
                note: format!("自动拉取（{}）", a.source),
            },
        );
    }

    let mut by_ep: HashMap<uuid::Uuid, Vec<ModelUsage>> = HashMap::new();
    for u in usage {
        by_ep.entry(u.endpoint_id).or_default().push(u);
    }

    // 按模型记账是后加的，之前的流量只在 `endpoint_usage` 里（按出口聚合，没有模型维度）。
    //
    // 不读这张表的话，那段时间的行会显示成「这段时间没跑过」—— 而它跑了几千次。
    // **那是一句假话**，比空白更糟：它会让人以为这条线路闲着。
    // 成本仍然拆不出来（没有模型就乘不了单价），但「跑了多少、收了多少」是真的，
    // 而且正是判断「这条线路值不值得配价」的依据。
    #[derive(sqlx::FromRow)]
    struct LegacyUsage {
        endpoint_id: uuid::Uuid,
        calls: i64,
        cost_micro: i64,
    }
    let legacy: HashMap<uuid::Uuid, (i64, i64)> = sqlx::query_as::<_, LegacyUsage>(
        "SELECT endpoint_id, SUM(calls)::bigint AS calls, \
                SUM(cost_micro_usd)::bigint AS cost_micro \
         FROM endpoint_usage WHERE day > current_date - $1::int GROUP BY endpoint_id",
    )
    .bind(days as i32)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|l| (l.endpoint_id, (l.calls, l.cost_micro)))
    .collect();

    // 适配器上一轮的结论：面板价目拿到几条、余额读不读得到、拉不到时的原话。
    // 用来在这一页上分诊「这个出口的进价还能从哪儿拿」——见 ReconRow::price_source。
    let adapters: HashMap<uuid::Uuid, (i64, bool, String)> =
        sqlx::query_as::<_, (uuid::Uuid, i64, bool, Option<String>)>(
            "SELECT endpoint_id, priced_models, balance_ok, note FROM endpoint_adapter",
        )
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(id, n, ok, note)| (id, (n, ok, note.unwrap_or_default())))
        .collect();

    // 余额那条独立的证据链，留着和单价算出来的数互相印证。
    let edges: Vec<BalanceEdge> = sqlx::query_as(
        "WITH w AS ( \
             SELECT * FROM endpoint_balance WHERE taken_at > now() - ($1::int * INTERVAL '1 day') \
         ), \
         f AS (SELECT DISTINCT ON (endpoint_id) endpoint_id, remaining_usd, used_usd \
               FROM w ORDER BY endpoint_id, taken_at ASC), \
         l AS (SELECT DISTINCT ON (endpoint_id) endpoint_id, remaining_usd, used_usd \
               FROM w ORDER BY endpoint_id, taken_at DESC), \
         c AS (SELECT endpoint_id, count(*)::bigint AS samples FROM w GROUP BY endpoint_id) \
         SELECT c.endpoint_id, \
                f.remaining_usd AS first_remaining, l.remaining_usd AS last_remaining, \
                f.used_usd      AS first_used,      l.used_usd      AS last_used, \
                c.samples \
         FROM c JOIN f ON f.endpoint_id = c.endpoint_id JOIN l ON l.endpoint_id = c.endpoint_id",
    )
    .bind(days as i32)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let edges: HashMap<uuid::Uuid, BalanceEdge> =
        edges.into_iter().map(|e| (e.endpoint_id, e)).collect();

    let mut rows: Vec<ReconRow> = Vec::new();
    for r in &routes {
        let vendor = crate::route_endpoints::vendor_of(
            &r.provider,
            &crate::models::allowed_ids(r),
            &r.base_url,
        );
        // 多带一个倍率：抓不到价目时要靠它从官方价推算（见 derived_price）。
        // 线路自带地址没有这一列，按 1.0 —— 那正是「我按官方价进货」的意思。
        let mut targets: Vec<(uuid::Uuid, String, bool, bool, f64, String)> =
            vec![(r.id, format!("{}（自带地址）", r.label), true, true, 1.0, r.base_url.clone())];
        for e in eps.get(&r.id).into_iter().flatten() {
            let label = if e.label.trim().is_empty() { "未命名出口".to_string() } else { e.label.clone() };
            targets.push((e.id, label, false, e.active, e.cost_ratio, e.base_url.clone()));
        }

        // 收入折人民币用**钱包那把尺子**（全局 `usd_per_cny_bps`），成本才各折各家。
        //
        // 这两件事看着对称，其实问的是两个问题：
        //   · 成本 = 我们在那家中转花掉的面值 ÷ 「¥1 在那家买到多少面值」。
        //     `channel_rates.usd_per_cny` 正是后者，所以成本侧用它是对的。
        //   · 收入 = 用户被扣了多少人民币。而扣款只走一条路：`bill_inner` 里的
        //     `usd_cents_to_wallet_cents`，用的是**全局一个** usd_per_cny_bps。
        //     供应商给我们的进货折扣和用户付多少钱毫无关系。
        //
        // 之前这里也取 `channel_rates`，理由是「revenue_usd 的量纲属于自带地址那家」——
        // 那个说法在 c387e33（2026-08-28 给钱包加全局折算）之后就不成立了，但这段注释
        // 和钉着它的那条测试没跟着改。后果按站分布，实测 7 天：
        //     api.hao.ai              页面 ¥7891.29  实际 ¥7846.48   1.0×  ← 碰巧对
        //     api.teamorouter.com     页面 ¥ 926.86  实际 ¥ 921.59   1.0×  ← 碰巧对
        //     polly.modelbridge.cc    页面 ¥ 380.79  实际 ¥2704.48   7.1×
        //     api.hanhegufei.online   页面 ¥ 335.69  实际 ¥2431.83   7.2×
        //     api.maomaoai.pro        页面 ¥ 217.80  实际 ¥1546.88   7.1×
        //     zyz.qingyanzhiying.top  页面 ¥  25.12  实际 ¥ 945.46  37.6×
        //     合计                    页面 ¥9777.57  实际 ¥16396.86  低画 40%
        // 那两个「碰巧对」是最坏的一种对：这几家的 usd_per_cny 填的 0.14 恰好 ≈ 1/7.1023
        // （他们按面值卖），于是 Claude 那几条线路的数字一直准，没人怀疑过这一列。
        //
        // 折不出来的可能性也随之消失：全局汇率是后台设置，永远有值。所以下面的
        // `fx_note` 只剩成本侧一种缺口。
        let cny_per_usd = 10_000.0 / crate::settings::usd_per_cny_bps() as f64;

        for (id, label, is_own, active, ratio, base_url) in targets {
            let used = by_ep.get(&id).map(|v| v.as_slice()).unwrap_or(&[]);
            let mut models: Vec<ModelRow> = Vec::new();
            let mut unpriced: Vec<String> = Vec::new();
            let mut revenue = 0.0_f64;
            let mut cost = 0.0_f64;
            // 这一行的成本里有多少来自推算。全额报出去 —— 「其中 X 是推的」
            // 和「全部都是实测的」是两句话，不能压成一个数。
            let mut derived_cost = 0.0_f64;
            // 老表兜底时用它顶替 calls —— 那时没有按模型的行可数。
            let mut legacy_calls = 0i64;

            for u in used {
                let rev = u.revenue_micro as f64 / 1_000_000.0;
                revenue += rev;
                // 价的三级：手录 → 抓来的 → **按 OpenRouter 官方价 × 这个出口的倍率推算**。
                // 前两级是事实，第三级是推算，界面上必须分得开（看 price_note / derived）。
                let fetched = price_of.get(&(id, u.model_id.clone())).cloned();
                let derived = fetched.is_none().then(|| derived_price(id, &u.model_id, ratio)).flatten();
                let p = fetched.as_ref().or(derived.as_ref());
                let c = p.map(|p| model_cost_usd(u, p));
                match &c {
                    Some(v) => cost += v,
                    None => unpriced.push(u.model_id.clone()),
                }
                models.push(ModelRow {
                    model_id: u.model_id.clone(),
                    calls: u.calls,
                    prompt_tokens: u.prompt_tokens,
                    completion_tokens: u.completion_tokens,
                    cached_tokens: u.cached_tokens,
                    cache_creation_tokens: u.cache_creation_tokens,
                    revenue_usd: rev,
                    cost_usd: c,
                    margin_usd: c.map(|c| rev - c),
                    input_per_mtok: p.map(|p| p.input_per_mtok),
                    output_per_mtok: p.map(|p| p.output_per_mtok),
                    cached_per_mtok: p.and_then(|p| p.cached_per_mtok),
                    price_note: p.map(|p| p.note.clone()).unwrap_or_default(),
                    price_derived: derived.is_some(),
                });
                if derived.is_some() {
                    if let Some(v) = c {
                        derived_cost += v;
                    }
                }
            }
            // 贵的排前面：一个出口上二十个模型时，该先看哪个由金额决定。
            models.sort_by(|a, b| b.revenue_usd.partial_cmp(&a.revenue_usd).unwrap_or(std::cmp::Ordering::Equal));

            // 少录一个模型的价，整行的成本就是未知 —— 把没录的那部分按 0 加进来，
            // 得到的是一个看起来很精确的错数字，而且它会让这一行显示成高毛利。
            // 按模型没有记录、但老表有量：那段流量发生在「按模型记账」上线之前。
            // 调用数和收入照实显示，成本明确标成拆不出来 —— 而不是把整行说成没跑过。
            let legacy_hit = used.is_empty().then(|| legacy.get(&id)).flatten();
            if let Some(&(lcalls, lmicro)) = legacy_hit {
                revenue = lmicro as f64 / 1_000_000.0;
                legacy_calls = lcalls;
            }

            let row_cost = unpriced.is_empty().then_some(cost).filter(|_| !used.is_empty());
            let margin = row_cost.map(|c| revenue - c);
            let (bal_cost, bal_basis, _samples, bal_note) = balance_cost(edges.get(&id));
            // 进价还能从哪儿拿。**只在这一行真的缺价时才谈得上**，所以判据看
            // `unpriced`：已经算得出成本的行不需要分诊。
            let (ad_priced, ad_balance, ad_note) = adapters
                .get(&id)
                .cloned()
                .unwrap_or((0, false, String::new()));
            let price_source = if ad_priced > 0 {
                "panel"
            } else if ad_balance {
                "calibrate"
            } else {
                "manual"
            };

            // 折人民币。两家的汇率缺一不可 —— 拿另一家顶上会得到一个看起来精确的错数字。
            let cost_rate = crate::relay_rates::usd_per_cny(&base_url);
            // 收入永远折得出来（全局汇率），只有成本侧还可能缺进货折扣。
            let fx_note = match cost_rate {
                Some(_) => String::new(),
                None => format!(
                    "这个出口那家（{}）还没填充值汇率，成本折不出人民币",
                    host_of(&base_url)
                ),
            };
            let rev_cny = Some(revenue * cny_per_usd);
            let to_cny = |x: f64| cost_rate.filter(|v| *v > 0.0).map(|v| x / v);
            let cost_cny = row_cost.and_then(to_cny);
            let margin_cny = match (rev_cny, cost_cny) {
                (Some(a), Some(b)) => Some(a - b),
                _ => None,
            };

            rows.push(ReconRow {
                endpoint_id: id,
                route_id: r.id,
                route_label: r.label.clone(),
                label,
                vendor,
                is_own,
                active,
                calls: if used.is_empty() { legacy_calls } else { used.iter().map(|u| u.calls).sum() },
                revenue_usd: revenue,
                cost_usd: row_cost,
                margin_usd: margin,
                revenue_cny: rev_cny,
                cost_cny,
                margin_cny,
                fx_note,
                // 毛利率必须用**折过的**两个数算。用原来那两个算出来的百分比是错的：
                // 分子分母不是同一种货币，线上清衍那一行就是这么变成 -144% 的。
                // 折不出来时不报百分比 —— 宁可空着，也不给一个方向都可能相反的数。
                margin_pct: margin_cny
                    .zip(rev_cny)
                    .filter(|(_, rev)| *rev > 0.0)
                    .map(|(m, rev)| m / rev * 100.0),
                unpriced_models: unpriced,
                derived_cost_usd: derived_cost,
                derived_cost_cny: to_cny(derived_cost),
                legacy_only: legacy_hit.is_some(),
                price_source,
                price_hint: ad_note,
                cost_by_balance_usd: bal_cost,
                cost_by_balance_cny: bal_cost.and_then(to_cny),
                balance_basis: bal_basis,
                balance_note: bal_note,
                models,
            });
        }
    }

    // 亏得最狠的排最前：这一页是用来发现问题的，不是用来浏览的。
    // 没有毛利数的（价没录全、或者汇率没填）沉到最后，而不是混在中间冒充打平。
    //
    // 按**折过的**人民币毛利排。按 margin_usd 排的话，一个跨中转的出口只因为它那家
    // 汇率大就被顶到「亏得最狠」的第一位 —— 线上清衍就是这么排到榜首的，而它其实赚钱。
    rows.sort_by(|a, b| match (a.margin_cny, b.margin_cny) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let revenue_total: f64 = rows.iter().map(|r| r.revenue_usd).sum();
    // 合计只加**算得出成本**的那些行，并把加了几行报出去 —— 否则总额会把
    // 「还没录价的出口」当成零成本，合计毛利凭空变好看。
    let counted: Vec<&ReconRow> = rows.iter().filter(|r| r.cost_usd.is_some()).collect();
    let cost_total: f64 = counted.iter().filter_map(|r| r.cost_usd).sum();
    let counted_revenue: f64 = counted.iter().map(|r| r.revenue_usd).sum();
    // 合计的人民币口径只加**两边都折得出来**的行。少折一家就把那一行整个排除，
    // 而不是拿没折的数混进来 —— 混进去的话合计的单位就不成立了。
    let fx_ok: Vec<&ReconRow> = rows
        .iter()
        .filter(|r| r.cost_cny.is_some() && r.revenue_cny.is_some())
        .collect();
    let cost_total_cny: f64 = fx_ok.iter().filter_map(|r| r.cost_cny).sum();
    let revenue_total_cny: f64 = fx_ok.iter().filter_map(|r| r.revenue_cny).sum();
    // 有多少行因为汇率没填而进不了人民币合计。不报的话合计会看起来是全量的。
    let fx_missing = rows.len() - fx_ok.len();
    // 还差多少个模型没录价 —— 这是「离能看真数还有多远」的唯一进度条。
    let unpriced_total: usize = rows.iter().map(|r| r.unpriced_models.len()).sum();

    let accounts = account_rates(&state, days).await;

    Ok(Json(serde_json::json!({
        "days": days,
        "accounts": accounts,
        "rows": rows,
        "totals": {
            "revenue_usd": revenue_total,
            "counted_revenue_usd": counted_revenue,
            "cost_usd": cost_total,
            "margin_usd": counted_revenue - cost_total,
            "counted_rows": counted.len(),
            "total_rows": rows.len(),
            "unpriced_models": unpriced_total,
            // 合计里有多少是推算的。分开报，让「实测覆盖了多少」一眼可见。
            "derived_cost_usd": counted.iter().map(|r| r.derived_cost_usd).sum::<f64>(),
            "revenue_cny": revenue_total_cny,
            "cost_cny": cost_total_cny,
            "margin_cny": revenue_total_cny - cost_total_cny,
            "fx_rows": fx_ok.len(),
            "fx_missing_rows": fx_missing,
            "derived_cost_cny": fx_ok.iter().filter_map(|r| r.derived_cost_cny).sum::<f64>(),
        },
    })))
}

#[derive(serde::Deserialize)]
pub struct SavePriceReq {
    pub endpoint_id: uuid::Uuid,
    pub model_id: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    #[serde(default)]
    pub cached_per_mtok: Option<f64>,
    #[serde(default)]
    pub note: String,
}

/// 批量录价的请求。
#[derive(serde::Deserialize)]
pub struct BulkPriceReq {
    pub endpoint_id: uuid::Uuid,
    /// 一行一个模型，随便什么分隔符。见 `parse_price_lines`。
    pub text: String,
    #[serde(default)]
    pub note: String,
}

/// 从粘贴的文本里解析出 (模型, 输入, 输出, 缓存读, 缓存写)。
///
/// # 为什么需要它
///
/// 自研网关（线上 api.teamorouter.com，挂了 9 个出口）**没有任何可拉的价目接口** ——
/// 它的价目只在自己前端里动态渲染，服务端拿不到；被人机校验挡住的面板同理。
/// 对这些站手工录是唯一的路，而原来的表单一次只能填一个模型、而且只对**已经有流量**
/// 的模型才出现 —— 一个还没跑过的新出口一条都填不进去。那等于「只能手工录」这句话
/// 在实现上是空的。
///
/// # 解析口径
///
/// 单位一律是**美元每百万 token**，和界面上那句「进价（$ / 百万 token）」一致，
/// 也和 `endpoint_model_price` 的列一致。这一点必须在界面上写死写明 ——
/// 单位靠猜是这套账里最贵的一类错。
///
/// 每行取第一个字段当模型名，后面的数字依次是 输入 / 输出 / 缓存读 / 缓存写。
/// 至少要有输入和输出两个数，否则这一行**报错回去**，不静默跳过 ——
/// 粘 30 行进去只存了 12 行而不说，比什么都没存糟。
pub fn parse_price_lines(text: &str) -> (Vec<(String, f64, f64, Option<f64>, Option<f64>)>, Vec<String>) {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        // **千分位逗号必须先挡掉。** 逗号在这里同时是字段分隔符和千分位符号，
        // 两种含义分不开：`1,250` 到底是「1 和 250 两个字段」还是「一千二百五」？
        // 猜任何一种都会静默产生一个看起来完全正常的错数字。所以不猜，退回去让人
        // 把逗号去掉 —— 一次多问一句，好过一张错的价目表。
        if has_thousands_comma(line) {
            bad.push(format!(
                "第 {} 行「{}」：数字里的逗号分不清是千分位还是分隔符，请去掉千分位逗号",
                i + 1,
                trunc(line)
            ));
            continue;
        }
        // 分隔符什么都收：制表、逗号（半角全角）、顿号、竖线、多个空格。
        // 从中转后台直接框选复制过来的多半是制表符或多空格。
        let parts: Vec<&str> = line
            .split(|c: char| c == '\t' || c == ',' || c == '，' || c == '、' || c == '|' || c.is_whitespace())
            .filter(|x| !x.trim().is_empty())
            .collect();
        let Some((name, rest)) = parts.split_first() else { continue };
        let name = name.trim();
        let nums: Vec<f64> = rest.iter().filter_map(|x| parse_money(x)).collect();
        if name.is_empty() || nums.len() < 2 {
            bad.push(format!("第 {} 行「{}」：认不出「模型名 输入价 输出价」这三样", i + 1, trunc(line)));
            continue;
        }
        // 负数一定是填错了。放进去成本会变成负数，那一行会显示成「毛利高于收入」。
        if nums.iter().any(|v| *v < 0.0 || !v.is_finite()) {
            bad.push(format!("第 {} 行「{}」：价格不能是负数", i + 1, trunc(line)));
            continue;
        }
        // 每百万 token 上万美元一定是单位填错了（多半把「每 token」的数填进来了，
        // 或者把人民币当美元）。挡住并说清楚，而不是收下一个天价。
        if nums.iter().any(|v| *v > 10_000.0) {
            bad.push(format!(
                "第 {} 行「{}」：单价超过每百万 token 一万美元，多半是单位填错了",
                i + 1,
                trunc(line)
            ));
            continue;
        }
        out.push((
            name.to_string(),
            nums[0],
            nums[1],
            nums.get(2).copied(),
            nums.get(3).copied(),
        ));
    }
    (out, bad)
}

/// 有没有 `1,250` 这种千分位写法：数字、逗号、紧跟正好三位数字、再后面不是数字。
fn has_thousands_comma(line: &str) -> bool {
    let b: Vec<char> = line.chars().collect();
    for i in 0..b.len() {
        if b[i] != ',' || i == 0 || !b[i - 1].is_ascii_digit() {
            continue;
        }
        let d: Vec<char> = b[i + 1..].iter().copied().take_while(|c| c.is_ascii_digit()).collect();
        if d.len() == 3 && !b.get(i + 4).is_some_and(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    false
}

/// 一个字段里的钱。收 `$1.25`、`0.28/M`、`￥3`（符号只是被剥掉，
/// **不做币种换算** —— 换算要汇率，而这里没有，猜一个是错的）。
fn parse_money(s: &str) -> Option<f64> {
    let t: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    if t.is_empty() || t == "-" || t == "." {
        return None;
    }
    t.parse::<f64>().ok()
}

fn trunc(s: &str) -> String {
    // 按**字符**截，不按字节 —— 按字节切会在中文中间断开直接 panic。
    let t: String = s.chars().take(28).collect();
    if t.chars().count() < s.chars().count() { format!("{t}…") } else { t }
}

/// `POST /api/admin/endpoint-prices/bulk` —— 一次录一个出口的一整张价目表。
pub async fn admin_bulk_prices(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<BulkPriceReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let (rows, bad) = parse_price_lines(&req.text);
    if rows.is_empty() {
        return Err(AppError::bad(if bad.is_empty() {
            "没解析出任何一行".to_string()
        } else {
            format!("一行都没认出来：\n{}", bad.join("\n"))
        }));
    }
    let mut saved = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for (model, inp, outp, cached, cache_write) in rows {
        let r = sqlx::query(
            "INSERT INTO endpoint_model_price \
               (endpoint_id, model_id, input_per_mtok, output_per_mtok, cached_per_mtok, \
                cache_write_per_mtok, note) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (endpoint_id, model_id) DO UPDATE SET \
               input_per_mtok = EXCLUDED.input_per_mtok, \
               output_per_mtok = EXCLUDED.output_per_mtok, \
               cached_per_mtok = EXCLUDED.cached_per_mtok, \
               cache_write_per_mtok = EXCLUDED.cache_write_per_mtok, \
               note = EXCLUDED.note, \
               updated_at = now()",
        )
        .bind(req.endpoint_id)
        .bind(model.trim())
        .bind(inp)
        .bind(outp)
        .bind(cached)
        .bind(cache_write)
        .bind(req.note.trim())
        .execute(&state.db)
        .await;
        match r {
            Ok(_) => saved += 1,
            // 写失败逐条报出来。整批回滚会让「29 条对的」也白填，
            // 而静默吞掉会让人以为全存上了。
            Err(e) => failed.push(format!("{model}：{e}")),
        }
    }
    Ok(Json(serde_json::json!({
        "saved": saved,
        "skipped": bad,
        "failed": failed,
    })))
}

/// `POST /api/admin/endpoint-prices` —— 录一个出口上某个模型的真实进价。
pub async fn admin_save_price(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<SavePriceReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    if req.model_id.trim().is_empty() {
        return Err(AppError::bad("缺少模型"));
    }
    // 负价一定是填错了。放进去的话成本会变成负数，那一行会显示成「毛利高于收入」。
    // 0 是合法的（确实有白送的模型），负数不是。
    for (v, what) in [
        (req.input_per_mtok, "输入价"),
        (req.output_per_mtok, "输出价"),
        (req.cached_per_mtok.unwrap_or(0.0), "缓存价"),
    ] {
        if !v.is_finite() || v < 0.0 {
            return Err(AppError::bad(format!("{what}不能是负数或非数字")));
        }
    }
    sqlx::query(
        "INSERT INTO endpoint_model_price \
           (endpoint_id, model_id, input_per_mtok, output_per_mtok, cached_per_mtok, note) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (endpoint_id, model_id) DO UPDATE SET \
           input_per_mtok = EXCLUDED.input_per_mtok, \
           output_per_mtok = EXCLUDED.output_per_mtok, \
           cached_per_mtok = EXCLUDED.cached_per_mtok, \
           note = EXCLUDED.note, \
           updated_at = now()",
    )
    .bind(req.endpoint_id)
    .bind(req.model_id.trim())
    .bind(req.input_per_mtok)
    .bind(req.output_per_mtok)
    .bind(req.cached_per_mtok)
    .bind(req.note.trim())
    .execute(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 一个**中转账户**这段时间的实测费率。
#[derive(serde::Serialize)]
pub struct AccountRate {
    pub base_url: String,
    /// 共用这个账户的线路名。两把不同的密钥挂在同一个账户下是常态。
    pub routes: Vec<String>,
    /// 余额掉了多少（美元）。None = 采样不足、或期间充过值。
    pub spent_usd: Option<f64>,
    pub user_tokens: i64,
    /// 探活烧掉的 token。**必须算进分母** —— 那笔钱也是从这个余额里出的。
    pub probe_tokens: i64,
    /// 实测单价：余额掉的钱 ÷ 总 token。**这是执行事实，不是任何人的声明。**
    pub implied_per_mtok: Option<f64>,
    /// 按价目表算出来的**预测消耗**（美元总额）。
    ///
    /// **可比的是这个数，不是每 M 单价。** 单价那一列是混合费率 —— 真实计费是
    /// `输入×输入价 + 输出×输出价`，而输出价通常是输入价的 4~5 倍，所以
    /// 「余额差 ÷ 总 token」完全取决于这一段的输入输出配比，拿去乘别的用量会错得离谱。
    /// 美元总额没有这个问题：两边都是「这一段花了多少钱」，同一批 token、同一个窗口。
    pub predicted_usd: Option<f64>,
    /// 按价目表加权的混合费率。**只用于展示这一段的量级，不能当单价用**（理由同上）。
    pub listed_per_mtok: Option<f64>,
    /// 两者的偏差百分比。差得远 = 中转在按另一份价目收费，或者我们的价目过期了。
    pub gap_pct: Option<f64>,
    pub note: String,
}

/// 按**账户**算实测费率。
///
/// # 为什么必须按账户，不能按线路
///
/// 实测：Claude 和 GPT 是两把不同的密钥（`c32100dd` / `f27979fa`），但余额到小数点后
/// 8 位同步变动 —— 同一个中转账户下的两把 key。按线路算的话，同一笔扣款会被算进
/// 两条线路，加总时**重复计算**。
///
/// 归并判据是地址：同一个 host 下的线路默认同账户。但**不盲信** —— 如果它们在同一
/// 时刻报出不同的余额，那就是两个账户，此时不归并并在 note 里说明。
///
/// # 为什么这个数比价目表更硬
///
/// 价目表是中转的**声明**，余额差是**真金白银**。两者对不上，说明中转在按另一份
/// 价目收费，或者我们抄来的表过期了 —— 而这正是「有没有在亏钱」里最难发现的一种。
async fn account_rates(state: &AppState, days: i64) -> Vec<AccountRate> {
    #[derive(sqlx::FromRow)]
    struct Row {
        base_url: String,
        label: String,
        endpoint_id: uuid::Uuid,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT base_url, label, id AS endpoint_id FROM models WHERE active = true ORDER BY base_url",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut by_host: HashMap<String, Vec<Row>> = HashMap::new();
    for r in rows {
        by_host.entry(r.base_url.clone()).or_default().push(r);
    }

    let mut out = Vec::new();
    for (base_url, group) in by_host {
        let ids: Vec<uuid::Uuid> = group.iter().map(|g| g.endpoint_id).collect();

        // 同一时刻余额不一致 = 不是同一个账户。归并会把两笔账混成一笔。
        let distinct: i64 = sqlx::query_scalar(
            "SELECT count(DISTINCT remaining_usd) FROM endpoint_balance \
             WHERE endpoint_id = ANY($1) AND remaining_usd IS NOT NULL \
               AND taken_at = (SELECT max(taken_at) FROM endpoint_balance \
                               WHERE endpoint_id = ANY($1))",
        )
        .bind(&ids)
        .fetch_one(&state.db)
        .await
        .unwrap_or(1);
        if distinct > 1 {
            out.push(AccountRate {
                base_url: base_url.clone(),
                routes: group.iter().map(|g| g.label.clone()).collect(),
                spent_usd: None,
                user_tokens: 0,
                probe_tokens: 0,
                implied_per_mtok: None,
                predicted_usd: None,
                listed_per_mtok: None,
                gap_pct: None,
                note: format!(
                    "同一个地址下有 {distinct} 个不同余额 —— 这是 {distinct} 个独立账户，\
                     没有归并（合起来算会把两笔账混成一笔）"
                ),
            });
            continue;
        }

        // **两边必须覆盖同一段时间。**
        //
        // `predicted` 来自 `endpoint_model_usage`，那张表 2026-08-25 才上线；而余额差
        // 覆盖整个窗口。实测这一天的后果：hanhegufei 七天里计费流水 10,848 次
        // / 3.14 亿 token，而按模型记账只有 132 次 / 776 万 —— 拿 2.5% 的流量算出来的
        // 成本去比 100% 的余额下降，界面上就报出 **+2156%「中转扣的和它自己的价目表
        // 对不上」**。那句话是错的，而且指着一个无辜的中转。
        //
        // 所以余额差也**从按模型记账有数据的那天算起**。两边同一段，比出来的才是话。
        let cover_from: Option<chrono::NaiveDate> = sqlx::query_scalar(
            "SELECT min(day) FROM endpoint_model_usage \
             WHERE endpoint_id = ANY($1) AND day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

        // 余额差：取这一组里任意一个出口的首尾（它们是同一个数）。
        let edge: Option<(Option<f64>, Option<f64>, i64)> = sqlx::query_as(
            "WITH w AS (SELECT * FROM endpoint_balance \
                        WHERE endpoint_id = ANY($1) AND remaining_usd IS NOT NULL \
                          AND taken_at > now() - ($2::int * INTERVAL '1 day') \
                          AND ($3::date IS NULL OR taken_at >= $3::date)) \
             SELECT (SELECT remaining_usd FROM w ORDER BY taken_at ASC LIMIT 1), \
                    (SELECT remaining_usd FROM w ORDER BY taken_at DESC LIMIT 1), \
                    (SELECT count(DISTINCT taken_at)::bigint FROM w)",
        )
        .bind(&ids)
        .bind(days as i32)
        .bind(cover_from)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

        let (spent, note) = match edge {
            Some((Some(first), Some(last), n)) if n >= 2 => {
                let d = first - last;
                if d >= 0.0 {
                    (Some(d), String::new())
                } else {
                    // 余额涨了 = 期间充过值。**不能报成负消耗**。
                    (None, "期间余额上升（充过值），这段的实测费率算不出来".into())
                }
            }
            Some((_, _, n)) if n < 2 => (None, format!("只采到 {n} 个余额点，算不出差额")),
            _ => (None, "这个账户还没有余额读数".into()),
        };

        let user_tokens: i64 = sqlx::query_scalar(
            // 缓存写也烧钱，也从这个余额里出 —— 不进分母的话实测单价会偏高。
            "SELECT COALESCE(SUM(prompt_tokens + completion_tokens + cache_creation_tokens), 0)::bigint \
             FROM endpoint_model_usage WHERE endpoint_id = ANY($1) AND day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        // 探活的 token 也从这个余额里出。不算进分母的话，实测单价会偏高，
        // 而那个数字看起来完全正常 —— 没有任何迹象说它被污染了。
        let probe_tokens: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint \
             FROM endpoint_probe_usage WHERE endpoint_id = ANY($1) AND day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        let total = user_tokens + probe_tokens;
        let implied = spent.filter(|_| total > 0).map(|d| d / total as f64 * 1_000_000.0);

        // 预测消耗：按价目表把这一段的每个模型逐个乘出来再相加。
        //
        // **这才是和余额差可比的那个数。** 不能用「平均单价 × 总 token」代替 ——
        // 那等于假设所有 token 同价，而输出价通常是输入价的 4~5 倍。
        //
        // 公式必须和 `model_cost_usd` **逐项一致**：新鲜输入 + 缓存读 + 缓存写 + 输出。
        // 上一版只算「prompt × 输入价 + completion × 输出价」，两处偏差方向相反且都不小：
        //   · 缓存读按全价算 —— 高估（实测 grok-4.6 七百万输入里四百万是缓存读）；
        //   · 缓存写完全不算 —— 低估，而它常常是成本大头。
        // 同一个「成本」有两份实现，这是这个仓库里反复吃亏的那种形状。
        // 先量**定价覆盖率**：这一段时间里，有多少 token 是我们真的知道单价的。
        //
        // 下面那条 predicted 是内连接 endpoint_auto_price —— 没抓到价的模型对分子贡献 0，
        // 而分母（余额掉账）覆盖这个账户的**全部**消耗。于是「我们没录价」会显示成
        // 「中转多收了 2383%」，页面还把原因穷举成「中转按另一份价收费 / 我们的表过期了」，
        // 真实原因根本不在其中 —— 这是在拿自己的缺口去指控对方。
        //
        // 出口明细那一侧早就有相反的规矩：`row_cost = unpriced.is_empty().then_some(cost)`，
        // 注释写着「少录一个模型的价，整行成本就是未知」，还有测试钉着。
        // 账户这一侧照抄同一条规矩，仓库里就只有一条口径而不是两条。
        let coverage: Option<(f64, i64, i64)> = sqlx::query_as(
            "SELECT COALESCE(SUM(u.prompt_tokens + u.completion_tokens) \
                      FILTER (WHERE p.model_id IS NOT NULL), 0)::float8 \
                    / NULLIF(SUM(u.prompt_tokens + u.completion_tokens), 0), \
                    count(DISTINCT u.model_id) FILTER (WHERE p.model_id IS NULL), \
                    count(DISTINCT u.model_id) \
             FROM endpoint_model_usage u \
             LEFT JOIN endpoint_auto_price p \
               ON p.endpoint_id = u.endpoint_id AND p.model_id = u.model_id \
             WHERE u.endpoint_id = ANY($1) AND u.day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
        let (priced_share, unpriced_models, total_models) =
            coverage.unwrap_or((0.0, 0, 0));

        // 输入怎么拆成「新鲜 + 缓存读」必须和 `model_cost_usd` 同一套判据：
        // 两家回执形状不同，硬夹 `LEAST(cached, prompt)` 会把 Anthropic 那边超出的
        // 缓存读整段丢掉（线上 7 天 1590 万个 token）。判据在 `prompt_is_inclusive`，
        // 这里是它的 SQL 版本，逐字对应：有记录照记录，没记录才按两个不可能条件推。
        let predicted: Option<f64> = sqlx::query_scalar(
            "SELECT SUM( \
                 s.fresh_tokens * p.input_per_mtok \
                 + s.cache_read_tokens \
                   * COALESCE(p.cached_per_mtok, p.input_per_mtok) \
                 + u.cache_creation_tokens \
                   * COALESCE(p.cache_write_per_mtok, p.input_per_mtok * 1.25) \
                 + u.completion_tokens * p.output_per_mtok \
             ) / 1000000.0 \
             FROM endpoint_model_usage u \
             JOIN endpoint_auto_price p \
               ON p.endpoint_id = u.endpoint_id AND p.model_id = u.model_id \
             CROSS JOIN LATERAL (SELECT COALESCE(u.prompt_includes_cached, \
                   NOT (u.cached_tokens > u.prompt_tokens \
                        OR u.cache_creation_tokens > 0)) AS incl) x \
             CROSS JOIN LATERAL (SELECT \
                 CASE WHEN x.incl \
                      THEN GREATEST(u.prompt_tokens - LEAST(u.cached_tokens, u.prompt_tokens), 0) \
                      ELSE GREATEST(u.prompt_tokens, 0) END AS fresh_tokens, \
                 CASE WHEN x.incl \
                      THEN LEAST(u.cached_tokens, u.prompt_tokens) \
                      ELSE GREATEST(u.cached_tokens, 0) END AS cache_read_tokens) s \
             WHERE u.endpoint_id = ANY($1) AND u.day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

        // 混合费率，只用于展示量级。
        let listed: Option<f64> = sqlx::query_scalar(
            "SELECT CASE WHEN SUM(u.prompt_tokens + u.completion_tokens) > 0 \
                    THEN SUM(u.prompt_tokens * p.input_per_mtok \
                             + u.completion_tokens * p.output_per_mtok) \
                         / SUM(u.prompt_tokens + u.completion_tokens) \
                    ELSE NULL END \
             FROM endpoint_model_usage u \
             JOIN endpoint_auto_price p \
               ON p.endpoint_id = u.endpoint_id AND p.model_id = u.model_id \
             WHERE u.endpoint_id = ANY($1) AND u.day > current_date - $2::int",
        )
        .bind(&ids)
        .bind(days as i32)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

        // **偏差按美元总额算，不按每 M 单价算。**
        // 单价那两个数各自都是混合费率，相除等于拿两个「平均」去比，
        // 而它们的加权口径本来就一样 —— 比出来的百分比和按总额算是同一个数，
        // 但用总额表达不会让人误以为那是单价的偏差。
        let gap = match (spent, predicted) {
            (Some(a), Some(p)) if p > 0.0 => Some((a - p) / p * 100.0),
            _ => None,
        };

        // 实际比的是几天，必须说出来。
        //
        // 按模型记账 2026-08-25 才上线，所以选「7 天」时这一行很可能只覆盖两天。
        // 不说的话，用户看到的是「7 天的账对不上」，而实际上比的是两天 —— 那句话
        // 会把一个无辜的中转指成多收钱。判据是**执行事实**（真有数据的最早那天），
        // 不是我们希望它覆盖多久。
        let covered_days = cover_from
            .map(|d| (chrono::Utc::now().date_naive() - d).num_days() + 1)
            .unwrap_or(0);
        let short = covered_days > 0 && covered_days < days as i64;
        // 价没录全就**不给这个百分比**。
        //
        // 分子只算得出有价那部分，分母是全部消耗 —— 差多少完全取决于我们漏录了多少，
        // 和中转怎么收费无关。给一个这样算出来的数，等于拿自己的缺口去指控对方。
        // 这条和出口明细的 `unpriced.is_empty().then_some(cost)` 是同一条规矩。
        let priced_enough = priced_share >= 0.999;
        let (predicted, gap) = if priced_enough {
            (predicted, gap)
        } else {
            (None, None)
        };

        let note = if !note.is_empty() {
            note
        } else if !priced_enough && total_models > 0 {
            format!(
                "{total_models} 个模型里有 {unpriced_models} 个没抓到价，\
                 只覆盖了 {:.0}% 的 token —— 剩下那部分的成本算不出来，这一段没法对账。\
                 差的不是中转，是我们自己的价目",
                priced_share * 100.0,
            )
        } else if total == 0 {
            "这段时间这个账户没有任何 token 消耗，反推不出单价".into()
        } else if short {
            format!(
                "只比了最近 {covered_days} 天 —— 按模型记账从那天才有数据，\
                 余额差也只取了同一段（两边不同段的话，比出来的百分比没有意义）"
            )
        } else {
            String::new()
        };

        out.push(AccountRate {
            base_url,
            routes: group.iter().map(|g| g.label.clone()).collect(),
            spent_usd: spent,
            user_tokens,
            probe_tokens,
            implied_per_mtok: implied,
            predicted_usd: predicted,
            listed_per_mtok: listed,
            gap_pct: gap,
            note,
        });
    }
    out.sort_by(|a, b| b.spent_usd.unwrap_or(0.0).partial_cmp(&a.spent_usd.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// 从首尾两条余额读数算成本。
///
/// 返回 (成本, 口径, 采样点数, 说明)。成本为 None 时说明里一定有一句话 ——
/// 「这里没有数字」和「为什么没有」必须一起给，否则面板上一片横杠没人知道该做什么。
/// 只取域名，用来在提示里指名道姓说是哪一家没填汇率。
/// 不回完整 URL：查询串里可能有人把密钥写在了地址上。
fn host_of(base_url: &str) -> String {
    base_url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn balance_cost(e: Option<&BalanceEdge>) -> (Option<f64>, Option<&'static str>, i64, String) {
    let Some(e) = e else {
        return (None, None, 0, "这个出口还没有余额读数（多数中转的余额接口认的是控制台令牌，不是调用密钥）".into());
    };
    if e.samples < 2 {
        return (None, None, e.samples, "余额只采到一个点，算不出差额（再等半小时）".into());
    }
    // 优先「已用」：它单调递增，充值不打断。
    if let (Some(a), Some(b)) = (e.first_used, e.last_used) {
        let d = b - a;
        if d >= 0.0 {
            return (Some(d), Some("used"), e.samples, String::new());
        }
        return (
            None,
            None,
            e.samples,
            "「已用」比上次小了 —— 多半是换了密钥，这段时间没法比".into(),
        );
    }
    if let (Some(a), Some(b)) = (e.first_remaining, e.last_remaining) {
        let d = a - b;
        if d >= 0.0 {
            return (Some(d), Some("remaining"), e.samples, String::new());
        }
        // 余额涨了 = 期间充过值。**不能报成负成本**，那会显示成中转在给你送钱。
        return (
            None,
            None,
            e.samples,
            "期间余额上升（充过值），这段的成本算不出来".into(),
        );
    }
    (None, None, e.samples, "这家只给了额度上限，既不是余额也不是已用".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> String {
        let all = include_str!("reconcile.rs");
        all.split("\n#[cfg(test)]").next().unwrap().to_string()
    }

    /// 按花括号配对抠出一个函数体。
    ///
    /// 不切固定长度的窗口：函数一长，窗口就够不到要守的那一行，而测试**仍然是绿的**
    /// —— 它守的东西已经不在它看的那段里了。
    fn fn_body(src: &str, sig: &str) -> String {
        let at = src.find(sig).unwrap_or_else(|| panic!("找不到 {sig}"));
        let open = at + src[at..].find('{').expect("函数没有花括号");
        let b = src.as_bytes();
        let (mut d, mut i) = (0i32, open);
        while i < b.len() {
            match b[i] {
                b'{' => d += 1,
                b'}' => {
                    d -= 1;
                    if d == 0 {
                        return src[open..=i].to_string();
                    }
                }
                _ => {}
            }
            i += 1;
        }
        panic!("{sig} 花括号没配平");
    }

    fn edge(fr: Option<f64>, lr: Option<f64>, fu: Option<f64>, lu: Option<f64>, n: i64) -> BalanceEdge {
        BalanceEdge {
            endpoint_id: uuid::Uuid::nil(),
            first_remaining: fr,
            last_remaining: lr,
            first_used: fu,
            last_used: lu,
            samples: n,
        }
    }

    fn usage(prompt: i64, cached: i64, completion: i64) -> ModelUsage {
        ModelUsage {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "m".into(),
            calls: 1,
            revenue_micro: 0,
            prompt_tokens: prompt,
            completion_tokens: completion,
            cached_tokens: cached,
            // 老的这几条测试都是「没有缓存写入」的形态 —— 补 0 之后它们的期望值
            // 一个字都不用改，这正说明这次改动没动到任何一条没有写入的账。
            cache_creation_tokens: 0,
            // 这几条测的是 OpenAI 形状（prompt 含缓存读），也就是这个夹刀本来就正确的
            // 那一半。显式写出来，免得哪天默认值一变，它们静默换了被测对象。
            prompt_includes_cached: Some(true),
        }
    }

    fn price(inp: f64, out: f64, cached: Option<f64>) -> ModelPrice {
        ModelPrice {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "m".into(),
            input_per_mtok: inp,
            output_per_mtok: out,
            cached_per_mtok: cached,
            cache_write_per_mtok: None,
            per_request: None,
            note: String::new(),
        }
    }

    /// 缓存 token 必须先从输入里减出来。
    ///
    /// `prompt_tokens` 是**含**缓存命中的总输入（各家 usage 帧都是这个口径）。
    /// 不减直接乘输入价，命中率高的模型成本会被高估好几倍 —— 而缓存价通常只有输入价
    /// 的十分之一，正是它让「同一段对话第二轮便宜得多」成立。
    #[test]
    fn anthropic_cache_reads_are_not_clamped_away() {
        // Anthropic 形状：prompt **不含**缓存读。线上 claude-opus-5 就是这个样子
        // （最近 7 天：输入 569,259、缓存读 6,436,239）。
        let mut u = usage(30, 80_310, 100);
        u.prompt_includes_cached = Some(false);
        let p = price(5.0, 25.0, Some(0.5));

        // 新鲜输入 30 个按输入价，缓存读 80,310 个按缓存价 —— 一个都不许丢。
        let want = (30.0 * 5.0 + 80_310.0 * 0.5 + 100.0 * 25.0) / 1_000_000.0;
        assert!((model_cost_usd(&u, &p) - want).abs() < 1e-12, "缓存读被夹掉了");

        // 夹刀版本会算成：cached=min(80310,30)=30、fresh=0，也就是只认 30 个
        // 缓存 token，8 万个凭空消失。确认新写法确实比它大得多。
        let clamped = (30.0 * 0.5 + 100.0 * 25.0) / 1_000_000.0;
        assert!(model_cost_usd(&u, &p) > clamped * 1.5, "还在按夹刀算");

        // OpenAI 形状（prompt 含缓存读）一个字不能变 —— 那一半本来就是对的。
        let mut o = usage(1_000, 400, 100);
        o.prompt_includes_cached = Some(true);
        let want_o = (600.0 * 5.0 + 400.0 * 0.5 + 100.0 * 25.0) / 1_000_000.0;
        assert!((model_cost_usd(&o, &p) - want_o).abs() < 1e-12, "OpenAI 那一半被改坏了");
    }

    /// 没有记录形状的老行只能推，而推的判据必须是**不可能反过来**的那两个。
    #[test]
    fn an_old_row_without_the_flag_is_inferred_not_guessed() {
        // cached > prompt 在「含缓存」的形状下不可能发生 —— 出现了就一定是 Anthropic。
        let mut a = usage(30, 80_310, 0);
        a.prompt_includes_cached = None;
        assert!(!prompt_is_inclusive(&a), "cached 超过 prompt 还当成含缓存 —— 那一段会被夹掉");

        // 只有 Anthropic 会单独报缓存写入。
        let mut b = usage(1_000, 100, 0);
        b.prompt_includes_cached = None;
        b.cache_creation_tokens = 500;
        assert!(!prompt_is_inclusive(&b));

        // 两个都不成立 → 按「含」算，也就是这一列上线之前的行为，不制造新偏差。
        let mut c = usage(1_000, 100, 0);
        c.prompt_includes_cached = None;
        assert!(prompt_is_inclusive(&c));

        // 有记录时**记录说了算**，不许被推翻 —— 推只是老行的兜底。
        let mut d = usage(1_000, 100, 0);
        d.prompt_includes_cached = Some(false);
        assert!(!prompt_is_inclusive(&d), "存着的形状被推理覆盖了");
    }

    /// 账单核对那条 SQL 必须和 `model_cost_usd` 用**同一套**拆法。
    ///
    /// 两处分叉的话，一边说成本 X、另一边说 Y，而「差额」那一栏正是拿它们相减的。
    #[test]
    fn the_predicted_sql_splits_input_the_same_way() {
        let body = fn_body(&src(), "async fn account_rates(");
        assert!(
            body.contains("COALESCE(u.prompt_includes_cached,"),
            "predicted 那条 SQL 没看回执形状 —— Anthropic 的缓存读会被夹掉",
        );
        assert!(
            body.contains("ELSE GREATEST(u.cached_tokens, 0) END AS cache_read_tokens"),
            "predicted 在 Anthropic 形状下还在夹 cached",
        );
        assert!(
            body.contains("ELSE GREATEST(u.prompt_tokens, 0) END AS fresh_tokens"),
            "predicted 在 Anthropic 形状下还在拿 prompt 减 cached",
        );
        // 推理兜底两边逐字一致，否则老行在两处会被判成不同形状。
        assert!(
            body.contains("NOT (u.cached_tokens > u.prompt_tokens"),
            "老行的推理判据和 prompt_is_inclusive 对不上",
        );
    }

    #[test]
    fn the_two_dollar_signs_are_not_the_same_currency() {
        // 这条测的是**量纲**，不是某个数值。
        //
        // 收入 `revenue_usd` 来自 compute_cost 的「官方价 × 100 × 线路 rate」，量纲属于
        // **线路自带地址那家**；成本 `cost_usd` 是「真实 token × 这个出口的进价」，而进价
        // 无论人工录的还是按倍率推的，单位都是**这个出口那家中转的余额面值**。
        // 两家充值汇率差多少，直接相减出来的毛利就错多少倍。
        //
        // 线上真实数据：清衍挂在 Claude 线路下，自带那家 ¥1 买 1 面值、清衍 ¥1 买 10 面值。
        // 页面曾显示「收 $4.46 / 花 $10.89 / 毛利 -$6.43（-144%）」，而清衍换算后
        // 每花掉一美元官方价只要 ¥0.65，比自带地址还便宜。同一条流水两个相反结论。
        let body = fn_body(&src(), "pub async fn admin_reconciliation(");

        // 收入折**钱包那把尺子**，成本折**出口那家的进货折扣** —— 两个基准不同源。
        //
        // 这条断言 2026-08-31 反过来了。原来它钉的是「收入也用 channel_rates」，
        // 理由写着「revenue_usd 的量纲属于线路自带地址那家」。那个理由在 c387e33
        // （2026-08-28 给钱包加全局折算）之后就不成立了：扣用户钱只走
        // `usd_cents_to_wallet_cents`，用的是全局一个 usd_per_cny_bps，和供应商给我们的
        // 进货折扣毫无关系。实测 7 天两把尺子的差：zyz 那条线路 37.6 倍，合计低画 40%
        // （详见 admin_reconciliation 里那张表）。而 api.hao.ai / teamorouter 一直是准的，
        // 因为他们的 usd_per_cny 填的 0.14 恰好 ≈ 1/7.1023 —— 「碰巧对」正是这条错了
        // 三个月没人发现的原因。
        assert!(
            body.contains("let cny_per_usd = 10_000.0 / crate::settings::usd_per_cny_bps() as f64;"),
            "收入没按钱包那把尺子折 —— 用户实付走的是全局汇率，不是某家中转的进货折扣",
        );
        assert!(
            body.contains("let rev_cny = Some(revenue * cny_per_usd);"),
            "收入折算没接上全局汇率",
        );
        assert!(
            !body.contains("crate::relay_rates::usd_per_cny(&r.base_url)"),
            "收入又回去取中转的进货折扣了 —— 那是「¥1 在那家能买多少面值」，不是汇率",
        );
        assert!(
            body.contains("let cost_rate = crate::relay_rates::usd_per_cny(&base_url);"),
            "成本没按这个出口那家的汇率折 —— 跨中转的行会整整错一个汇率的倍数",
        );

        // 毛利率必须用折过的算。这是页面上最显眼、也最容易被信以为真的那个数。
        assert!(
            body.contains("margin_pct: margin_cny"),
            "毛利率还在拿两种货币相减的结果算 —— 那个百分比连正负号都可能是反的",
        );
        // 排序也得按折过的，否则一个赚钱的跨中转出口会被顶到「亏得最狠」榜首。
        assert!(
            body.contains("rows.sort_by(|a, b| match (a.margin_cny, b.margin_cny) {"),
            "还在按未折算的毛利排序 —— 汇率大的那家会假装亏得最狠",
        );

        // 缺一家就都不给，不拿另一家顶上。
        assert!(
            body.contains("(Some(a), Some(b)) => Some(a - b),"),
            "缺一边汇率时还在算毛利 —— 那是个看起来精确的错数字",
        );
        // 正面钉形状，不列禁用词：兜底的写法有无数种（unwrap_or / unwrap_or_default /
        // unwrap_or_else / 提前赋个默认值……），黑名单挡不住，而漏掉一种的后果是
        // 「没填汇率的站凭空显示成成本极低」——最该拦的恰好是这一种。
        // 成本侧仍然可能「折不出来」（那家的进货折扣没填），这时必须如实变成 None。
        // 收入侧不再有这个可能：全局汇率是后台设置，永远有值。
        for shape in [
            "let to_cny = |x: f64| cost_rate.filter(|v| *v > 0.0).map(|v| x / v);",
        ] {
            assert!(
                body.contains(shape),
                "汇率缺失没有如实变成「算不出」（缺 `{shape}`）—— 一旦被兜底成某个默认值，\
                 没填汇率的站会凭空显示成成本极低，而且没有任何地方会报错",
            );
        }
    }

    /// 前端不能再打 `$`。
    ///
    /// 服务端折好了人民币，前端要是还读 `*_usd` 那几个字段、还打美元符号，
    /// 这一屏就一个字都没变好 —— 而且不会有任何地方报错。
    #[test]
    fn the_console_shows_the_converted_numbers() {
        let ui = include_str!("../admin-ui/src/pages/Reconcile.tsx");
        for shape in [
            "{cny(r.revenue_cny)}",
            "{cny(r.cost_cny)}",
            "{cny(r.margin_cny)}",
            "const losing = r.margin_cny !== null && r.margin_cny < 0;",
            "value={cny(t.margin_cny)}",
        ] {
            assert!(
                ui.contains(shape),
                "出口明细那一屏还在显示未折算的数（缺 `{shape}`）",
            );
        }
        // 折不出来时必须指名道姓说是哪一家没填，否则只看到一排「—」不知道去填谁。
        assert!(
            ui.contains("{r.fx_note}"),
            "汇率缺失的原因没显示出来 —— 运维不知道该去补哪一家",
        );
    }

    #[test]
    fn cached_input_is_billed_at_the_cache_rate_not_the_input_rate() {
        // 100 万输入里 90 万命中缓存，输入 $3/M、缓存 $0.3/M、输出 $15/M，输出 10 万。
        let u = usage(1_000_000, 900_000, 100_000);
        let c = model_cost_usd(&u, &price(3.0, 15.0, Some(0.3)));
        // 10 万新输入 × 3 + 90 万缓存 × 0.3 + 10 万输出 × 15，全部 ÷ 1e6
        let want = (100_000.0 * 3.0 + 900_000.0 * 0.3 + 100_000.0 * 15.0) / 1_000_000.0;
        assert!((c - want).abs() < 1e-9, "算出 {c}，应为 {want}");

        // 不减缓存的话会算成这个数 —— 差 2.4 倍，而且是往高了算。
        let naive = (1_000_000.0 * 3.0 + 100_000.0 * 15.0) / 1_000_000.0;
        assert!(naive > c * 2.0, "这个测试本身失去意义了：两种算法差别太小");
    }

    /// 没录缓存价时按输入价算 —— 保守方向，宁可把成本算高也不要把毛利算好看。
    #[test]
    fn a_missing_cache_price_falls_back_to_the_input_price() {
        let u = usage(1_000_000, 900_000, 0);
        let c = model_cost_usd(&u, &price(3.0, 15.0, None));
        assert!((c - 3.0).abs() < 1e-9, "应当整段按输入价算，得到 3.0，实得 {c}");
    }

    /// cached 比 prompt 还大时不能算出负的新增输入。
    ///
    /// 上游偶尔会回不自洽的 usage（cached 超过 prompt）。不夹的话 `fresh` 变负数，
    /// 成本被减掉一块，那一行的毛利凭空变高 —— 而且没有任何迹象。
    #[test]
    fn an_inconsistent_usage_frame_cannot_produce_negative_input() {
        let u = usage(100, 5_000, 0);
        let c = model_cost_usd(&u, &price(3.0, 15.0, Some(0.3)));
        assert!(c >= 0.0, "算出了负成本：{c}");
        // 全部按缓存价算：100 × 0.3 / 1e6
        assert!((c - 100.0 * 0.3 / 1_000_000.0).abs() < 1e-12, "夹取之后的口径不对：{c}");
    }

    /// 少录一个模型的价，整行成本就是未知，不能把那部分按 0 加进来。
    #[test]
    fn one_unpriced_model_makes_the_whole_row_unknown() {
        let s = src();
        assert!(
            s.contains("let row_cost = unpriced.is_empty().then_some(cost)"),
            "行成本没有要求「全部模型都录了价」—— 漏一个就会得到一个看着很精确的错数字",
        );
        // 合计也必须排掉这些行。
        assert!(
            s.contains("filter(|r| r.cost_usd.is_some())"),
            "合计把没录价的行按零成本计入了，毛利会凭空变好看",
        );
    }

    /// 自动拉到的价必须真的被用上。
    ///
    /// 账单核对的两边必须覆盖**同一段时间**，而且成本公式只许有一份。
    ///
    /// # 这条钉的是一次把无辜中转指成小偷的误报
    ///
    /// `predicted` 来自 `endpoint_model_usage`（2026-08-25 才上线），`spent` 来自余额
    /// 快照（覆盖整个窗口）。实测 hanhegufei 七天：计费流水 10,848 次 / 3.14 亿 token，
    /// 而按模型记账只有 132 次 / 776 万 —— 拿 **2.5% 的流量**算出来的成本去比
    /// **100% 的余额下降**，界面报出 `+2156% ← 中转扣的和它自己的价目表对不上`。
    ///
    /// 那句话是错的。40 倍的流量差对上 22.6 倍的缺口，同一个量级 —— 缺口整个是
    /// 窗口错配造出来的。**一个自信、具体、而且冤枉人的结论，比没有结论糟得多。**
    #[test]
    fn the_account_check_compares_the_same_window_with_one_cost_formula() {
        let src = include_str!("reconcile.rs");
        // **按行首锚定。** 直接 find("pub async fn account_rates(") 会先在**这条测试
        // 自己写的那句字面量**上命中（真实签名没有 pub），于是切片从测试内部开始，
        // 下面每一条断言都在自己身上命中 —— 恒真。第一版就是这么绿的。
        let at = src
            .find("\nasync fn account_rates(")
            .expect("按账户核对的函数不见了");
        let rest = &src[at..];
        // **两个边界都要看，取先到的那个。**
        //
        // `account_rates` 是这个文件里最后一个 `pub async fn`，所以只找「下一个函数」
        // 会一路切到文件末尾、把测试模块也包进来 —— 于是下面每一条断言都能在**它自己
        // 写的那句字面量**上命中，测试恒真。第一版就是这样：把余额窗口的夹取整个删掉，
        // 它照样绿。只有故意改坏跑一遍才看得出来。
        let end = [rest[1..].find("\npub async fn "), rest[1..].find("\n#[cfg(test)]")]
            .into_iter()
            .flatten()
            .min()
            .map(|i| i + 1)
            .unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            !body.contains("fn the_account_check_compares"),
            "切片切到测试模块里去了 —— 下面的断言会在自己身上命中，等于什么都没测",
        );

        // 余额差必须按「按模型记账有数据的那天」起算。
        assert!(
            body.contains("let cover_from"),
            "没有算覆盖起点 —— 两边又会比不同的时间段",
        );
        assert!(
            body.contains("taken_at >= $3::date"),
            "余额差没有被覆盖起点夹住 —— 它仍然覆盖整个窗口，而 predicted 只覆盖一部分",
        );
        // 实际比了几天要说出来。
        assert!(
            body.contains("只比了最近 {covered_days} 天"),
            "覆盖天数没有回给界面 —— 用户会以为比的是他选的那个天数",
        );

        // 成本公式和 model_cost_usd 逐项一致：四项都要在。
        for term in [
            "p.input_per_mtok",
            "COALESCE(p.cached_per_mtok, p.input_per_mtok)",
            "COALESCE(p.cache_write_per_mtok, p.input_per_mtok * 1.25)",
            "p.output_per_mtok",
        ] {
            assert!(
                body.contains(term),
                "predicted 少了一项（{term}）—— 它和 model_cost_usd 又分叉了",
            );
        }
        // 分母也要含缓存写：那笔钱同样从这个余额里出。
        assert!(
            body.contains("prompt_tokens + completion_tokens + cache_creation_tokens"),
            "实测单价的分母漏了缓存写 —— 单价会偏高，而那个数看起来完全正常",
        );
    }

    /// 抓不到价目时按「官方价 × 倍率」推算 —— 而且**必须标成推算**。
    ///
    /// # 为什么允许这一条推算
    ///
    /// 用户早先要求过「都不要估算，都要真实的计算」，当时删掉的那个估算是
    /// `收入 × 进价折扣 ÷ 计费倍率` —— 它的**前提是假的**：那个折扣是多路由用来
    /// 排序出口的旋钮，不是价格。
    ///
    /// 这一条不同：中转本来就是「官方价 × 分组倍率」定价的，我们真抓到的价目里
    /// `group_multiplier` 就是原样折在单价上的（grok-heavy 0.2 倍 → $2 标成 $0.40）。
    /// 复现它们自己的定价规则，不是拍脑袋。
    ///
    /// # 但它终究是推的
    ///
    /// 所以 `price_derived` 必须为真、`price_note` 必须写明来源、合计必须分开报。
    /// 混进实测数字里，一个假设就变成了事实，而这一页的全部价值就在于它说真数。
    #[test]
    fn a_derived_price_is_marked_as_derived_and_never_invented() {
        let ep = uuid::Uuid::nil();
        // 目录里没有的模型 → 不猜，仍然是「待录单价」。
        assert!(derived_price(ep, "完全不存在的模型-9x", 1.0).is_none());
        // 倍率非法 → 不推。0 会把成本推成 0，那正是「过期的零」那一类错误。
        assert!(derived_price(ep, "claude-opus-5", 0.0).is_none());
        assert!(derived_price(ep, "claude-opus-5", -1.0).is_none());
        assert!(derived_price(ep, "claude-opus-5", f64::NAN).is_none());

        // 目录里有的话，价必须是 官方价 × 倍率。
        //
        // **这一段是条件成立的**：`official_price` 读的是实时目录，测试环境里通常是空的，
        // 整块会被跳过。所以「必须标成推算」那条断言**不能放在这里面** —— 第一版就放了，
        // 于是把 note 里的「推算」二字删掉，测试照样绿。下面改成扫源码，与目录无关。
        if let Some((oi, oo)) = crate::models::official_price("claude-opus-5") {
            let p = derived_price(ep, "claude-opus-5", 0.25).expect("目录里有就该推得出来");
            assert!((p.input_per_mtok - oi * 0.25).abs() < 1e-9, "输入价不是官方价×倍率");
            assert!((p.output_per_mtok - oo * 0.25).abs() < 1e-9, "输出价不是官方价×倍率");
            assert!(p.note.contains("推算"), "推算出来的价没有标明来源：{}", p.note);
        }

        // 取价的顺序：抓来的优先，抓不到才推。反过来的话，真价会被推算盖住。
        let src = include_str!("reconcile.rs");
        let at = src.find("let fetched = price_of.get(").expect("取价那段变了");
        let seg = &src[at..at + 400.min(src.len() - at)];
        assert!(
            seg.contains("fetched.is_none().then(|| derived_price("),
            "推算不是只在抓不到时才跑 —— 真实价目会被一个推算值盖掉",
        );
        assert!(
            seg.contains("fetched.as_ref().or(derived.as_ref())"),
            "取价优先级反了：推算排在抓来的前面",
        );
        // 标签必须写在源码里，和实时目录有没有加载无关。
        let fnbody = {
            let a = src.find("fn derived_price(").expect("推算函数不见了");
            let r = &src[a..];
            let e = r[1..].find("\n/// ").map(|i| i + 1).unwrap_or(r.len());
            &r[..e]
        };
        assert!(
            fnbody.contains(r#"note: format!("推算："#),
            "推算出来的价没有在 note 里标明它是推的 —— 它会在界面上冒充实测价",
        );
        assert!(
            src.contains("price_derived: derived.is_some()"),
            "推算标记没有跟着行走 —— 界面分不出哪一行是推的",
        );
    }

    /// 缓存写入必须算进成本，而且**不许当 0**。
    ///
    /// # 这条钉的是一个真实的单向偏差
    ///
    /// 上一版 `model_cost_usd` 只算「新鲜输入 + 缓存读 + 输出」。而上游按输入价的
    /// 1.25 倍收缓存写入，实测 2026-08-26 一次 claude-opus-5 调用：新鲜输入 381、
    /// **写入 61,634**、输出 1152 —— 那一笔 $1.19 的成本里 $1.156 是写入。
    ///
    /// 收入那一侧一直算了它（`compute_cost` 里的 write_tok），成本这一侧当 0，
    /// 于是**毛利被系统性高估，而且缓存命中率越高的模型账面越漂亮、实际越亏**。
    /// 这不是随机误差，是永远朝一个方向偏。
    #[test]
    fn cache_writes_are_part_of_the_cost_never_zero() {
        let u = ModelUsage {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "claude-opus-5".into(),
            calls: 1,
            revenue_micro: 0,
            prompt_tokens: 381,
            completion_tokens: 1152,
            cached_tokens: 0,
            cache_creation_tokens: 61_634,
            prompt_includes_cached: Some(true),
        };
        let p = ModelPrice {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "claude-opus-5".into(),
            input_per_mtok: 15.0,
            output_per_mtok: 25.0,
            cached_per_mtok: None,
            cache_write_per_mtok: None, // 没录 → 按输入价 × 1.25 推
            per_request: None,
            note: String::new(),
        };
        let got = model_cost_usd(&u, &p);
        // 381×15 + 61634×18.75 + 1152×25，除以一百万。
        let want = (381.0 * 15.0 + 61_634.0 * 18.75 + 1152.0 * 25.0) / 1_000_000.0;
        assert!((got - want).abs() < 1e-9, "算出来 {got}，应当是 {want}");

        // 漏掉写入会少算多少：这里是二十倍。
        let without_write = (381.0 * 15.0 + 1152.0 * 25.0) / 1_000_000.0;
        assert!(
            got > without_write * 20.0,
            "写入贡献了绝大部分成本，漏掉它就是把成本算成零头",
        );

        // 录了写入价就用录的那个，不再去推。
        let p2 = ModelPrice { cache_write_per_mtok: Some(3.0), ..p.clone() };
        let got2 = model_cost_usd(&u, &p2);
        let want2 = (381.0 * 15.0 + 61_634.0 * 3.0 + 1152.0 * 25.0) / 1_000_000.0;
        assert!((got2 - want2).abs() < 1e-9, "录了写入价却没用它");

        // 一个写入为 0 的调用，结果必须和改造前逐字相同 —— 这次改动不该动到
        // 任何一条没有缓存写入的历史账。
        let u0 = ModelUsage { cache_creation_tokens: 0, ..u.clone() };
        assert!((model_cost_usd(&u0, &p) - without_write).abs() < 1e-9);
    }
    /// **上游按次收的钱,成本这一侧一直读不到 —— 于是这类出口毛利恒 100%。**
    ///
    /// `endpoint_auto_price.per_request` 这一列 `relay_sync` 从抓价那天起就在写
    /// (new-api 的 `quota_type=1`、OpenRouter 的 `request` 价都落在这里),但**读的人一个都没有**:
    /// 五处 SELECT 全是显式列清单,没有一处带上它。
    ///
    /// 线上实测(2026-09-03):366 条自动价里 35 条有按次价,其中 **32 条 input/output 都是 0**
    /// —— 对这 32 条出口,成本里除了按次价什么都没有,不读它就等于「这条出口不花钱」。
    /// 连带后果比对账页难看更贵:`check_margin_after_change` 用同一份价重算,
    /// 一条按次计费的亏本出口永远算出 100% 毛利,**自动止血那条链对它结构性哑掉**。
    #[test]
    fn per_request_upstream_pricing_is_part_of_the_cost() {
        // 只按次计价的上游:按量单价全 0,每次 $0.10。
        let u = ModelUsage {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "some-per-call-model".into(),
            calls: 10_000,
            revenue_micro: 0,
            prompt_tokens: 4_000_000,
            completion_tokens: 600_000,
            cached_tokens: 0,
            cache_creation_tokens: 0,
            prompt_includes_cached: Some(true),
        };
        let per_call_only = ModelPrice {
            endpoint_id: uuid::Uuid::nil(),
            model_id: "some-per-call-model".into(),
            input_per_mtok: 0.0,
            output_per_mtok: 0.0,
            cached_per_mtok: None,
            cache_write_per_mtok: None,
            per_request: Some(0.10),
            note: String::new(),
        };
        let got = model_cost_usd(&u, &per_call_only);
        assert!(
            (got - 1_000.0).abs() < 1e-6,
            "按次进价没算进成本:算出 ${got},应当是 10000 次 × $0.10 = $1000"
        );

        // 同时按量又按次的(OpenRouter 有这种):两项都要算,不是二选一。
        let both = ModelPrice { input_per_mtok: 3.0, output_per_mtok: 15.0, ..per_call_only.clone() };
        let want = (4_000_000.0 * 3.0 + 600_000.0 * 15.0) / 1_000_000.0 + 1_000.0;
        let got2 = model_cost_usd(&u, &both);
        assert!((got2 - want).abs() < 1e-6, "两种计价混用时算错了:{got2},应当 {want}");

        // 反方向:没有按次价(绝大多数出口)时,结果必须**逐字**等同于加这一项之前。
        let no_per_call = ModelPrice { per_request: None, ..both.clone() };
        let got3 = model_cost_usd(&u, &no_per_call);
        assert!(
            (got3 - (want - 1_000.0)).abs() < 1e-6,
            "没有按次价的出口被凭空加了钱:{got3}"
        );
        // Some(0.0) 和 None 必须同解 —— 上游明说「按次不收费」不该变成一笔账。
        let zero = ModelPrice { per_request: Some(0.0), ..both.clone() };
        assert_eq!(model_cost_usd(&u, &zero), got3, "显式按次 0 和没录不同解了");
    }

    /// 第一版这里只读手填的 `endpoint_model_price`，而适配器把 535 条真实进价写进了
    /// `endpoint_auto_price` —— 一条都没被读。表现是「明明自动拉到了价，对账页的
    /// 成本还是空的」，而且看起来像适配器没工作。
    #[test]
    fn auto_fetched_prices_are_actually_used() {
        let s = src();
        assert!(
            s.contains("FROM endpoint_auto_price"),
            "对账没读自动价表 —— 适配器拉回来的价一条都用不上",
        );
        // 自动的要覆盖手填的（手填只在拉不到时兜底），所以自动那一轮必须在后面插入。
        let manual = s.find("SELECT * FROM endpoint_model_price").expect("手填价没读");
        let auto = s.find("FROM endpoint_auto_price").expect("自动价没读");
        assert!(manual < auto, "自动价没有覆盖手填价 —— 倍率变了之后手填的旧值会一直赢");
    }

    /// 「跑过但没按模型记账」不许说成「没跑过」。
    ///
    /// 按模型记账是后加的，之前的流量只在按出口聚合的老表里。不读那张表的话，
    /// 那些行会显示成「这段时间没跑过」—— 而它们跑了几千次。**那是一句假话**，
    /// 比空白更糟：它会让人以为这条线路闲着。
    #[test]
    fn traffic_without_per_model_detail_is_not_reported_as_no_traffic() {
        let s = src();
        assert!(
            s.contains("FROM endpoint_usage WHERE day >"),
            "没读按出口聚合的老表 —— 按模型记账上线之前的流量会显示成「没跑过」",
        );
        assert!(s.contains("legacy_only"), "没有把「老口径」这件事标出来");
        // 老表只在按模型没有记录时才顶上，不能盖掉真实的按模型数据。
        assert!(
            s.contains("used.is_empty().then(|| legacy.get(&id)).flatten()"),
            "老表数据会盖掉按模型的真实数据 —— 两者口径不同，混在一起就都不可信了",
        );
        // 界面必须分开说。
        let ui = include_str!("../admin-ui/src/pages/Reconcile.tsx");
        assert!(
            ui.contains("r.calls === 0 && !r.legacy_only"),
            "界面还是把老口径的行说成「没跑过」",
        );
    }

    /// 实测费率必须按**账户**算，而且探活的 token 要进分母。
    ///
    /// 两个错法各自的后果：
    ///   · 按线路算 —— 同一个账户下的两把密钥（实测 Claude 和 GPT 就是）会把同一笔
    ///     扣款各算一遍，加总直接翻倍；
    ///   · 探活 token 不进分母 —— 那笔钱也是从这个余额里出的，不算进去的话实测单价
    ///     偏高，而那个数字看起来完全正常，没有任何迹象说它被污染了。
    #[test]
    fn the_implied_rate_is_per_account_and_counts_probe_tokens() {
        let body = fn_body(&src(), "async fn account_rates(");
        assert!(
            body.contains("by_host") && body.contains("endpoint_id = ANY($1)"),
            "没有按账户归并 —— 同一账户下的多把密钥会把扣款重复计算",
        );
        assert!(
            body.contains("endpoint_probe_usage"),
            "探活 token 没进分母 —— 实测单价会偏高，而且看不出来",
        );
        assert!(
            body.contains("user_tokens + probe_tokens"),
            "分母不是两者之和",
        );
    }

    /// 账单核对必须按**美元总额**比，不能按每 M 单价比。
    ///
    /// 真实计费是 `输入×输入价 + 输出×输出价`，而输出价通常是输入价的 4~5 倍。
    /// 所以「余额差 ÷ 总 token」是一个**混合费率**，完全取决于这一段的输入输出配比 ——
    /// 拿它当单价去乘别的用量会错得离谱。
    ///
    /// 美元总额没有这个问题：两边都是「这一段花了多少钱」，同一批 token、同一个窗口。
    /// 这条守的就是「别再把混合费率当单价用」。
    #[test]
    fn the_bill_check_compares_dollars_not_blended_rates() {
        let body = fn_body(&src(), "async fn account_rates(");
        // 预测消耗必须逐模型乘出来再相加，不能用平均单价 × 总 token。
        assert!(
            body.contains("u.prompt_tokens * p.input_per_mtok")
                && body.contains("u.completion_tokens * p.output_per_mtok"),
            "预测消耗没有逐模型分输入输出算 —— 那等于假设所有 token 同价",
        );
        // 偏差按总额算。
        assert!(
            body.contains("let gap = match (spent, predicted)"),
            "偏差还在按每 M 单价算 —— 那会让人以为那是单价的偏差",
        );

        // 界面上混合费率必须标成不可当单价用，而且**必须是可见文本**。
        //
        // 上一版把这句话写在 JSX 注释 `{/* ... */}` 里 —— 断言跑在源码上，通过了；
        // 而注释在构建时被剥掉，线上包里 0 处命中，用户永远看不到。
        // **测试守的东西没有出现在真正发出去的产物里**，这是最难发现的一种假绿。
        // 所以这里先把注释整个剥掉，再断言。
        let ui_raw = include_str!("../admin-ui/src/pages/Reconcile.tsx");
        let ui: String = ui_raw
            .replace("{/*", "\u{0}")
            .split('\u{0}')
            .enumerate()
            .map(|(i, part)| {
                if i == 0 {
                    part.to_string()
                } else {
                    part.split_once("*/}").map(|(_, rest)| rest.to_string()).unwrap_or_default()
                }
            })
            .collect::<Vec<_>>()
            .join("");
        assert!(
            ui.contains("混合费率") && ui.contains("不是单价"),
            "「不是单价」这句话不在可见文本里（多半又写进了 JSX 注释）—— \
             构建时会被剥掉，用户看不到，而这条断言在源码上照样绿",
        );
        assert!(
            !ui.contains("实测 $/M"),
            "「实测 $/M」这个标题会被读成单价，而它不是",
        );
    }

    /// 同一个地址下余额不一致时**不许归并**。
    ///
    /// 那是两个独立账户。合起来算会把两笔账混成一笔，而结果看起来是个正常的数。
    #[test]
    fn two_accounts_on_one_host_are_not_merged() {
        let body = fn_body(&src(), "async fn account_rates(");
        assert!(
            body.contains("count(DISTINCT remaining_usd)") && body.contains("if distinct > 1"),
            "没有检查同一地址下是不是同一个账户 —— 两个账户会被合成一个",
        );
        assert!(
            body.contains("没有归并"),
            "不归并的时候没有说明原因 —— 那一行会是一片空白",
        );
    }

    /// 充值期间算不出实测费率，而且不能报成负消耗。
    #[test]
    fn a_top_up_window_yields_no_implied_rate() {
        let body = fn_body(&src(), "async fn account_rates(");
        assert!(
            body.contains("if d >= 0.0") && body.contains("充过值"),
            "余额上升时没有作废这一段 —— 会算出负的消耗和负的单价",
        );
    }

    /// 没有用量的出口不该显示成「成本 0、毛利 0」。
    #[test]
    fn an_idle_endpoint_has_no_cost_at_all() {
        let s = src();
        assert!(
            s.contains(".filter(|_| !used.is_empty())"),
            "一个这段时间没跑过的出口会显示成成本 0 —— 那读起来像「白用」，其实是「没用过」",
        );
    }

    /// 负单价一定是填错了，必须在入口拦掉。
    #[test]
    fn a_negative_price_is_refused_at_the_door() {
        let s = src();
        let i = s.find("pub async fn admin_save_price(").expect("录价入口不见了");
        let body = &s[i..];
        assert!(
            body.contains("!v.is_finite() || v < 0.0"),
            "没拦负数/NaN —— 成本会变成负的，那一行显示成毛利高于收入",
        );
        assert!(body.contains("cached_per_mtok"), "缓存价没参与校验");
    }

    /// 充值不能变成负成本（余额那条独立证据链）。
    #[test]
    fn a_top_up_never_becomes_negative_cost() {
        let (cost, basis, _, note) = balance_cost(Some(&edge(Some(10.0), Some(110.0), None, None, 5)));
        assert!(cost.is_none(), "充值被算成了负成本");
        assert!(basis.is_none());
        assert!(note.contains("充过值"), "没说清为什么没有数字：{note}");
    }

    /// 有「已用」时优先用它 —— 它不被充值打断。
    #[test]
    fn used_wins_over_remaining() {
        let (cost, basis, _, _) =
            balance_cost(Some(&edge(Some(10.0), Some(110.0), Some(3.0), Some(8.0), 5)));
        assert_eq!(basis, Some("used"), "有已用却退回去用余额了");
        assert!((cost.unwrap() - 5.0).abs() < 1e-9, "成本算错：{cost:?}");
    }

    /// 一个采样点算不出差额，而且必须说清楚。
    #[test]
    fn one_sample_is_not_a_delta() {
        let (cost, _, n, note) = balance_cost(Some(&edge(Some(10.0), Some(10.0), None, None, 1)));
        assert!(cost.is_none());
        assert_eq!(n, 1);
        assert!(!note.is_empty(), "没有数字也没有原因，面板上就是一片横杠");
    }

    /// 完全没有读数 ≠ 成本为零。
    #[test]
    fn no_reading_is_not_zero_cost() {
        let (cost, _, n, note) = balance_cost(None);
        assert!(cost.is_none(), "没有读数被当成了零成本 —— 那会让毛利凭空变好看");
        assert_eq!(n, 0);
        assert!(!note.is_empty());
    }

    /// 「只给上限」既不是余额也不是已用，不许拿来算。
    #[test]
    fn a_hard_limit_is_not_a_balance() {
        let (cost, basis, _, note) = balance_cost(Some(&edge(None, None, None, None, 4)));
        assert!(cost.is_none() && basis.is_none());
        assert!(note.contains("上限"), "{note}");
    }

    /// 这一页不许再出现「按收入反推成本」那套估算。
    ///
    /// 用户点名要真实计算。估算那版是 `收入 × cost_ratio / rate` —— 它的前提是
    /// `cost_ratio` 填对了，而那是个**选路旋钮**，不是价格。留着它就会有人去看它。
    #[test]
    fn there_is_no_estimate_left_anywhere() {
        let s = src();
        for banned in ["cost_est", "cost_ratio / r.rate", "revenue * cost_ratio"] {
            assert!(!s.contains(banned), "估算又回来了：{banned}");
        }
    }

    /// 粘贴录价：**认不出的行必须报出来**，不能静默跳过。
    ///
    /// 粘 30 行进去只存了 12 行而不说，比一条都没存糟得多 —— 后者你知道要重来，
    /// 前者你以为填完了，而对账会拿那 18 个缺口按推算值顶上，看起来一切正常。
    #[test]
    fn pasted_prices_report_every_line_they_could_not_read() {
        let (ok, bad) = parse_price_lines(
            "claude-opus-5\t5\t25\n\
             gpt-5.6-sol, 1.25, 10, 0.125\n\
             deepseek-v4-flash $0.28 $0.42\n\
             \n\
             # 这是注释\n\
             这一行没有价格\n\
             坏价 -1 5\n\
             单位错了 5000000 1\n",
        );
        assert_eq!(ok.len(), 3, "该认的没认出来");
        assert_eq!(ok[0], ("claude-opus-5".into(), 5.0, 25.0, None, None));
        assert_eq!(ok[1], ("gpt-5.6-sol".into(), 1.25, 10.0, Some(0.125), None));
        assert_eq!(ok[2], ("deepseek-v4-flash".into(), 0.28, 0.42, None, None));

        // 三种坏行都要各报一条，一条都不许吞。
        assert_eq!(bad.len(), 3, "认不出的行没有全部报出来：{bad:?}");
        assert!(bad.iter().any(|b| b.contains("没有价格")), "缺价那行没报");
        assert!(bad.iter().any(|b| b.contains("负数")), "负价那行没报");
        assert!(bad.iter().any(|b| b.contains("单位")), "天价那行没报");
        // 报错要指出是第几行，否则 30 行里找不到是哪一条。
        assert!(bad.iter().all(|b| b.starts_with("第 ")), "没说是第几行：{bad:?}");

        // 空行和注释不算错，也不该被报出来。
        assert!(!bad.iter().any(|b| b.contains("注释")));
    }

    /// 粘贴录价必须在**没有流量的出口**上也能用。
    ///
    /// 上一版 `ModelDetail` 在没有调用记录时直接返回一句话就完了，于是一个还没跑过
    /// 的新出口一条价都填不进去 —— 而自研网关（没有任何可拉的价目接口）恰恰只能靠
    /// 手工录。那等于「只能手工录」这句话在实现上是空的。
    #[test]
    fn the_paste_box_reaches_endpoints_with_no_traffic() {
        let ui = include_str!("../admin-ui/src/pages/Reconcile.tsx");
        // 空态那一支里必须也挂着粘贴框。
        let at = ui.find("if (row.models.length === 0) {").expect("空态分支不见了");
        let branch = &ui[at..at + 700.min(ui.len() - at)];
        assert!(
            branch.contains("<BulkPrices row={row} onSaved={onSaved} />"),
            "没有流量的出口上没有粘贴框 —— 自研网关一条价都填不进去",
        );
        // 单位必须写在界面上。靠猜单位是这套账里最贵的一类错。
        assert!(
            ui.contains("美元 / 百万 token"),
            "粘贴框没写清单位 —— 填成每 token 会差一百万倍",
        );
        // 认不出的行要逐条显示，不能只报一个成功数。
        assert!(
            ui.contains("{result.skipped.map((x) => (") && ui.contains("{result.failed.map((x) => ("),
            "跳过和失败的行没有逐条列出来 —— 人会以为填完了",
        );
        // 后端那条路由要存在。
        let main = include_str!("main.rs");
        assert!(
            main.contains("\"/api/admin/endpoint-prices/bulk\", post(reconcile::admin_bulk_prices)"),
            "批量录价的路由没挂上",
        );
    }

    /// 中文行截断按字符，不按字节 —— 按字节切会在汉字中间断开直接 panic。
    #[test]
    fn a_bad_chinese_line_does_not_panic() {
        let (ok, bad) = parse_price_lines("这是一行很长很长很长很长很长很长很长很长的中文没有任何价格数字在里面");
        assert!(ok.is_empty());
        assert_eq!(bad.len(), 1);
    }

    /// 钱的符号只剥不换算。
    #[test]
    fn a_currency_symbol_is_stripped_never_converted() {
        // 剥符号：$1.25 就是 1.25。
        let (ok, _) = parse_price_lines("m $1.25 $10");
        assert_eq!(ok[0].1, 1.25);
        // **千分位逗号被拒绝，不是被猜。** 逗号在这里同时是分隔符和千分位，
        // 猜哪一种都会静默给出一个看起来正常的错数字（`1,250` 读成 1）。
        let (ok, bad) = parse_price_lines("m 1,250 2,500");
        assert!(ok.is_empty(), "千分位那行被猜着读进去了");
        assert!(bad[0].contains("千分位"), "没说清为什么拒绝：{bad:?}");
        // 但普通的逗号分隔照常能用 —— 只有「数字,三位数字」那个形状才算歧义。
        let (ok, _) = parse_price_lines("m,1.25,10");
        assert_eq!(ok[0], ("m".into(), 1.25, 10.0, None, None));
        // **人民币符号不做汇率换算** —— 换算要汇率，这里没有，猜一个就是错的。
        // 剥成同一个数字，单位由界面上那句「$ / 百万 token」负责说清。
        let (ok, _) = parse_price_lines("m ￥3 ￥9");
        assert_eq!(ok[0].1, 3.0);
    }
}
