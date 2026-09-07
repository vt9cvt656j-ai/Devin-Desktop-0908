use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use futures_util::StreamExt;
use serde_json::json;

use crate::error::{ApiResult, AppError};
use crate::AppState;

const FEED_CHANNEL: &str = "events:feed";

/// Persist an event and publish it to the live feed. Best-effort: a telemetry
/// failure must never break the request that triggered it.
pub async fn record_event(
    state: &AppState,
    user_id: Option<uuid::Uuid>,
    kind: &str,
    data: serde_json::Value,
) {
    let res: ApiResult<()> = async {
        sqlx::query("INSERT INTO events (user_id, kind, data) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(kind)
            .bind(&data)
            .execute(&state.db)
            .await?;
        let payload = json!({
            "kind": kind,
            "user_id": user_id,
            "data": data,
            "ts": chrono::Utc::now().to_rfc3339(),
        })
        .to_string();
        let mut conn = state.redis.clone();
        let _: () = redis::cmd("PUBLISH")
            .arg(FEED_CHANNEL)
            .arg(payload)
            .query_async(&mut conn)
            .await?;
        Ok(())
    }
    .await;
    if let Err(e) = res {
        tracing::warn!("record_event({kind}) failed: {}", e.msg);
    }
}

/// Presence is one short-lived key PER CONNECTION, refreshed while the socket is open.
///
/// The previous single `online:count` INCRBY/DECRBY counter drifted upward forever: a
/// container restart, a panic, or a killed task skipped the decrement, and the key had no
/// TTL to heal it — so "online" only ever grew and became meaningless. Per-connection keys
/// expire on their own when a process dies.
const PRESENCE_PREFIX: &str = "ws:online:";
const PRESENCE_TTL_SECS: i64 = 45;
const PRESENCE_REFRESH: std::time::Duration = std::time::Duration::from_secs(15);

async fn touch_presence(state: &AppState, key: &str) {
    let mut conn = state.redis.clone();
    let _: Result<(), _> = redis::cmd("SET")
        .arg(key)
        .arg(1)
        .arg("EX")
        .arg(PRESENCE_TTL_SECS)
        .query_async(&mut conn)
        .await;
}

async fn drop_presence(state: &AppState, key: &str) {
    let mut conn = state.redis.clone();
    let _: Result<(), _> = redis::cmd("DEL").arg(key).query_async(&mut conn).await;
}

/// Count live presence keys. SCAN, not KEYS — KEYS blocks Redis for the whole sweep.
async fn online_count(state: &AppState) -> i64 {
    let mut conn = state.redis.clone();
    let pattern = format!("{PRESENCE_PREFIX}*");
    let mut cursor: u64 = 0;
    let mut n: i64 = 0;
    loop {
        let res: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(500)
            .query_async(&mut conn)
            .await;
        match res {
            Ok((next, keys)) => {
                n += keys.len() as i64;
                cursor = next;
                if cursor == 0 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    n
}

/// GET /ws — upgrade to a WebSocket that streams the live event feed (fanned out
/// across all backend instances via Redis pub/sub) and tracks online presence.
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// How long a freshly upgraded socket may stay silent before we hang up on it.
/// The feed carries every user's email plus order/grant/commission amounts, so an
/// unauthenticated socket must never reach `stream_feed`.
const WS_AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How often a still-open feed socket re-checks that it is still allowed to be open.
/// Without this, a socket opened while the user WAS an admin keeps streaming for as
/// long as it stays connected, which for this feed can be days.
///
/// 「还允许开着」是两件事，不是一件：这个账号现在还是不是管理员，以及**这次登录**本身
/// 还在不在。原来只查前者，于是「注销该设备」对已经连上的这条 socket 完全不生效。
const WS_AUTH_RECHECK: std::time::Duration = std::time::Duration::from_secs(300);

/// Is this user an admin *right now*, according to the users table?
///
/// The token is trusted for identity, never for privilege — the same rule the `Claims`
/// extractor enforces. `claims_from_jwt` only decodes, so checking `claims.role` here
/// would have left `/ws` as the one place where a 30-day token still carried privilege:
/// a demoted or deleted admin would keep streaming every user's email, order amounts
/// and commissions until the token expired.
async fn is_admin_now(state: &AppState, uid: uuid::Uuid) -> bool {
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(uid)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    role.as_deref() == Some("admin")
}

/// Authenticate a WebSocket from its first frame: `{"type":"auth","token":"<jwt>"}`.
///
/// The browser cannot set an Authorization header on a WebSocket, and putting the
/// token in the query string would write it into nginx's access log, so the token
/// travels in the first message instead. Returns the admin's user id and the id of the
/// session that token names, on success.
async fn ws_authenticate(
    socket: &mut WebSocket,
    state: &AppState,
) -> Option<(uuid::Uuid, Option<uuid::Uuid>)> {
    let first = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return None,
    };
    let frame = serde_json::from_str::<serde_json::Value>(&first).ok()?;
    if frame.get("type").and_then(|v| v.as_str()) != Some("auth") {
        return None;
    }
    let token = frame.get("token").and_then(|v| v.as_str())?;
    let claims = crate::auth::claims_from_jwt(&state.db, &state.cfg, token).await?;
    let uid = uuid::Uuid::parse_str(&claims.sub).ok()?;
    // sid 要一路带到 stream_feed：连上之后每次复查都得拿它去问「这次登录还在吗」。
    // `claims_from_jwt` 在这里已经查过一次了，但那只覆盖握手的那一瞬间。
    // 没有 sid 的是 sessions 表出现之前签发的老令牌，`session_is_live` 照原样放行
    // （`SESSION_LIVE_SQL` 的 `$2::uuid IS NULL OR …`）—— 也就是说这道复查对它们是
    // **fail-open**：吊销设备之后，这类连接不会掉线。
    //
    // 这个口子有尽头，不是长期属性，2026-08-22 核过：全仓只有 `auth::issue_token`
    // 一处签发令牌（`grep -n "encode(&Header"` 只此一家），而它无条件写
    // `sid: Some(sid.to_string())`。所以今天发出去的每一把令牌都带 sid，剩下的只有
    // 存量老令牌，JWT 30 天，随时间自然清零。
    //
    // 别照着 `device_id` 那条推断这里也一样 —— 那一条**不是**有尽头的：handoff 的
    // redeem 今天仍在以 `device_id: None` 建会话（见 sessions.rs 里 revoke 的注释）。
    // 两处形状像，结论相反，判据是「今天还在不在产生新的空值」。
    let sid = claims.sid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());
    is_admin_now(state, uid).await.then_some((uid, sid))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let Some((uid, sid)) = ws_authenticate(&mut socket, &state).await else {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "auth_error", "error": "需要管理员权限" }).to_string(),
            ))
            .await;
        let _ = socket.close().await;
        return;
    };
    let _ = socket
        .send(Message::Text(json!({ "type": "auth_ok" }).to_string()))
        .await;
    let presence = format!("{}{}", PRESENCE_PREFIX, uuid::Uuid::new_v4());
    touch_presence(&state, &presence).await;
    let result = stream_feed(&mut socket, &state, uid, sid, &presence).await;
    if let Err(e) = result {
        tracing::debug!("ws closed: {}", e.msg);
    }
    drop_presence(&state, &presence).await;
}

async fn stream_feed(
    socket: &mut WebSocket,
    state: &AppState,
    uid: uuid::Uuid,
    sid: Option<uuid::Uuid>,
    presence: &str,
) -> ApiResult<()> {
    let mut pubsub = state.redis_client.get_async_pubsub().await?;
    pubsub.subscribe(FEED_CHANNEL).await?;
    let mut messages = pubsub.on_message();
    let mut recheck = tokio::time::interval(WS_AUTH_RECHECK);
    recheck.tick().await; // the first tick fires immediately; auth just succeeded
    let mut heartbeat = tokio::time::interval(PRESENCE_REFRESH);
    heartbeat.tick().await; // ditto — touch_presence already ran
    loop {
        tokio::select! {
            _ = heartbeat.tick() => { touch_presence(state, presence).await; }
            _ = recheck.tick() => {
                // 两件事都要现查，缺一条就漏一种踢人方式。
                //
                // 只查 role 的那一版留下的洞：管理员的笔记本丢了，他在另一台机器上从设备
                // 列表把那次登录注销掉 —— 他自己还是管理员，所以这里判定通过，那台机器上
                // 已经连着的 socket 照推不误，把全站用户的邮箱、订单和佣金金额一直推到
                // 30 天令牌自然过期为止。整条认证链上只有这里不查 `revoked_at`：提取器、
                // user_from_jwt、claims_from_jwt、门禁 cookie 每次调用都查。
                //
                // 顺序无所谓，两条都失败时先报哪条都行；分成两条只是为了让前端显示的原因
                // 是对的（降权 vs 这次登录被移除）。
                //
                // 「这次登录还在不在」不在这里自己写一遍 SQL：修上面那个洞时这里一度是
                // 那条判定的第**三**份手抄件（另两份在 auth.rs 的 user_from_jwt 和
                // claims_from_jwt 里），而多份手抄正是这个洞本身的成因。判定只有一份文本，
                // 在 `crate::sessions::SESSION_LIVE_SQL`；查不出来算「不在」的 fail-closed
                // 语义也在那里，对这条流尤其要紧 —— 它推的是全站用户的邮箱和订单/佣金金额，
                // 掉线重连的代价远小于多推五分钟。
                if !is_admin_now(state, uid).await {
                    let _ = socket.send(Message::Text(
                        json!({ "type": "auth_error", "error": "权限已变更" }).to_string(),
                    )).await;
                    break;
                }
                if !crate::sessions::session_is_live(&state.db, uid, sid).await {
                    let _ = socket.send(Message::Text(
                        json!({ "type": "auth_error", "error": "该设备的登录已被移除，请重新登录" })
                            .to_string(),
                    )).await;
                    break;
                }
            }
            maybe = messages.next() => {
                match maybe {
                    Some(msg) => {
                        let payload: String = msg.get_payload().unwrap_or_default();
                        if socket.send(Message::Text(payload)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(p))) => { let _ = socket.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct Event {
    pub id: i64,
    pub user_id: Option<uuid::Uuid>,
    pub kind: String,
    pub data: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/admin/events — recent activity for the dashboard's initial load
/// (the live tail then arrives over /ws). Admin only.
pub async fn recent_events(
    State(state): State<AppState>,
    claims: crate::auth::Claims,
) -> ApiResult<Json<Vec<Event>>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    let rows = sqlx::query_as::<_, Event>(
        "SELECT id, user_id, kind, data, created_at FROM events ORDER BY id DESC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// 近 24 小时白送出去的调用。`/api/admin/stats` 和部署自检 `/health/reports` 共用。
///
/// **抽成函数是为了让自检跑同一条 SQL，而不是抄一份。** 抄一份的话，被抄的那边
/// 改了类型转换、自检仍然报绿 —— 而自检要防的恰好是「SQL 的类型和 Rust 的解码
/// 对不上」，也就是接口 500。抄出来的副本对这件事结构性地看不见。
pub(crate) async fn zero_priced_24h(state: &AppState) -> serde_json::Value {
    // ── 白送出去的调用 ──────────────────────────────────────────────────────
    //
    // 「有 token、没收钱、也没扣免费点」= 这一次上游的钱我们照付、用户一分没付、
    // 免费额度也没动。原因永远是同一个：这个模型在这条线路上三样价都没配
    // （每模型价 / 官方目录 / 连接级），`compute_cost` 只好返回 0。
    //
    // 它此前完全不可见：不报错、不进任何报表，`model_usage` 里就是安静的一行 0。
    // 实测抓到两笔：grok-4.6 在 2026-08-28 一天里 717 次 / 3403 万 token 收 0（新线路
    // 还没填每模型价），deepseek-v4-flash-vision-exp 在 08-29 是 49/57 次。
    //
    // **刻意排除 `mode:"free"` 的模型**：那些是运营决定免费的（deepseek-v4-pro 就是），
    // 它们收 0 是对的，混进来会把这个数变成噪声，然后这一格就没人看了。
    // 现算不缓存：这一格的用途就是「现在有没有在漏」，缓存住等于答非所问。
    let zero_rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "WITH freecfg AS ( \
           SELECT DISTINCT k FROM models, \
             LATERAL jsonb_object_keys(COALESCE(model_billing, '{}'::jsonb)) k \
           WHERE model_billing->k->>'mode' = 'free' \
         ) \
         SELECT model_name, count(*)::bigint, \
                COALESCE(sum(prompt_tokens + completion_tokens), 0)::bigint \
         FROM model_usage \
         WHERE created_at > now() - interval '24 hours' \
           AND cost_cents = 0 AND free_milli_points_spent = 0 \
           AND prompt_tokens + completion_tokens > 0 \
           AND model_name NOT IN (SELECT k FROM freecfg) \
         GROUP BY 1 ORDER BY 3 DESC LIMIT 20",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    json!({
        "calls": zero_rows.iter().map(|r| r.1).sum::<i64>(),
        "tokens": zero_rows.iter().map(|r| r.2).sum::<i64>(),
        "models": zero_rows
            .iter()
            .map(|(name, calls, tokens)| json!({ "model": name, "calls": calls, "tokens": tokens }))
            .collect::<Vec<_>>(),
    })
}

/// 免费额度池收了多少点，而那些调用**实际值多少钱**。近 24 小时，按模型。
///
/// 池子扣点扣的是**售价**，于是同一份「每日免费额度」在不同模型上根本不是同一个东西：
///   · 显式配 `{"in":0,"out":0}` 的模型（deepseek-v4-pro 就是）售价为 0 →
///     `free_points_needed(0)` 落到地板 1 → **4.5 万 token 和 45 个 token 一样扣 1 毫点**；
///   · 按次计价的 glm-5.3-flash 每次扣 4000 毫点，而它一次只值 $0.003。
/// 2026-08-29~31 三天实测，「实扣毫点」和「按目录价该扣多少」的比值：
///     deepseek-v4-pro    2954 次   实扣    2954   应扣 4,561,533   少 1544 倍
///     deepseek-v4-flash   159 次   实扣     159   应扣     8,223   少   52 倍
///     glm-5.3-flash        95 次   实扣 380,000   应扣     5,813   多   65 倍
///     glm-5.3              53 次   实扣 544,603   应扣    33,251   多   16 倍
///
/// **这一格只报数，不改行为。** 免费额度值多少是运营决策：按参考成本扣点会让
/// deepseek-v4-pro 从「实际无限」变成每天约 65 次，而 glm-5.3-flash 从每天 25 次
/// 变成约 1600 次。那是产品定价，不该由计费这一层替谁定。
///
/// `ref_micro_usd` 是 2026-09-01 才加的列，之前的行是 NULL。所以要**把没有参考价的
/// 次数报出去**——不报的话这一格在刚上线那天会显示「免费额度几乎不花钱」，而那只是
/// 因为数据还没攒够，和真结论长得一模一样。
pub(crate) async fn free_pool_value_24h(state: &AppState) -> serde_json::Value {
    let rows: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT model_name, count(*)::bigint, \
                COALESCE(sum(free_milli_points_spent), 0)::bigint, \
                COALESCE(sum(ref_micro_usd), 0)::bigint, \
                count(*) FILTER (WHERE ref_micro_usd IS NULL)::bigint \
         FROM model_usage \
         WHERE created_at > now() - interval '24 hours' AND free_milli_points_spent > 0 \
         GROUP BY 1 ORDER BY 3 DESC LIMIT 20",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    // 换算走 models.rs 那唯一一条（`milli_points_for_micro_usd`）。
    // 原来这里手抄了一个 50 —— 那是 1 点 = ¥0.355 时代的数，而点值现在由后台汇率推导
    // （100 积分 = ¥1）。手抄的那份不会跟着动，于是这块面板会一直按旧口径报「该扣多少」，
    // 而它正是用来发现扣点口径漂了的面板。
    let total_micro: i64 = rows.iter().map(|r| r.3).sum();
    // micro-USD → 人民币分。推导：usd_cents = micro/10000，cny_cents = usd_cents*10000/bps，
    // 约掉就是 micro/bps。**别在前端写死 7.1023**：那个数是后台设置，改了之后前端不会跟。
    let bps = crate::settings::usd_per_cny_bps().max(1);
    json!({
        "milli_points": rows.iter().map(|r| r.2).sum::<i64>(),
        "ref_micro_usd": total_micro,
        "ref_cny_cents": total_micro / bps,
        "unpriced_calls": rows.iter().map(|r| r.4).sum::<i64>(),
        "models": rows
            .iter()
            .map(|(model, calls, milli, micro, unpriced)| {
                // 「按参考成本该扣多少毫点」——同一把尺子换算过去。
                let should = crate::models::milli_points_for_micro_usd(*micro);
                json!({
                    "model": model,
                    "calls": calls,
                    "milli_points": milli,
                    "ref_micro_usd": micro,
                    "should_milli_points": should,
                    "unpriced_calls": unpriced,
                })
            })
            .collect::<Vec<_>>(),
    })
}

/// GET /api/admin/stats — headline numbers for the dashboard (admin only).
pub async fn stats(
    State(state): State<AppState>,
    claims: crate::auth::Claims,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&state.db)
        .await?;
    let today: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE created_at >= date_trunc('day', now())",
    )
    .fetch_one(&state.db)
    .await?;
    // 下面三项是**全量聚合**，不是分页列表算出来的。
    //
    // 总览页此前把「已收款 / 已付订单数 / 套餐构成」都从两条带硬上限的列表里算：
    // /api/admin/users 是 `LIMIT 500`、/api/admin/orders 是 `LIMIT 1000`。于是用户过 500、
    // 订单过 1000 之后，这几个数字**静默变成"最近 N 条里的合计"**，而紧挨着它们的
    // 「总用户」用的是上面那个真 count(*) —— 同一屏里一个真一个截断，运营看不出来。
    //
    // 收款口径和前端 lib/money.ts 一致：只有 charged_cents + charged_currency 是真钱
    //（Stripe 扣款成功后 webhook 写回的事实），amount_cents 是目录里的人民币标价，不算。
    let paid_orders: i64 = sqlx::query_scalar("SELECT count(*) FROM orders WHERE status = 'paid'")
        .fetch_one(&state.db)
        .await?;
    let revenue_rows: Vec<(String, i64)> = sqlx::query_as(
                // `sum(bigint)` 在 Postgres 里回的是 **numeric**，不是 bigint —— 不显式转，
        // sqlx 解码时就是 `i64 is not compatible with SQL type NUMERIC`，整个总览 500。
        "SELECT lower(charged_currency), COALESCE(sum(charged_cents), 0)::bigint FROM orders \
         WHERE status = 'paid' AND charged_cents IS NOT NULL AND charged_currency IS NOT NULL \
         GROUP BY lower(charged_currency)",
    )
    .fetch_all(&state.db)
    .await?;
    let revenue: serde_json::Map<String, serde_json::Value> = revenue_rows
        .into_iter()
        .map(|(ccy, cents)| (ccy, serde_json::Value::from(cents)))
        .collect();
    // 「有效会员」的判据和前端 active() 一致：有套餐、不是 none、且没过期。
    let plan_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT plan, count(*) FROM users \
         WHERE plan IS NOT NULL AND plan <> 'none' \
           AND (plan_expires_at IS NULL OR plan_expires_at > now()) \
         GROUP BY plan",
    )
    .fetch_all(&state.db)
    .await?;
    let plan_mix: serde_json::Map<String, serde_json::Value> = plan_rows
        .into_iter()
        .map(|(plan, n)| (plan, serde_json::Value::from(n)))
        .collect();

    let zero_priced = zero_priced_24h(&state).await;

    Ok(Json(json!({
        "total_users": total,
        "today_users": today,
        "online": online_count(&state).await,
        "paid_orders": paid_orders,
        "revenue_cents": revenue,
        "plan_mix": plan_mix,
        "zero_priced_24h": zero_priced,
        "free_pool_24h": free_pool_value_24h(&state).await,
    })))
}

#[cfg(test)]
mod tests {
    /// 剥掉注释再断言。注释里写着「原来只查 role」这类字样，连注释一起扫的话，
    /// 断言会被注释喂到，把 bug 放回去也照样是绿的。
    fn code_of(src: &str) -> String {
        src.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn body(src: &str) -> &str {
        &src[..src.find("#[cfg(test)]").unwrap_or(src.len())]
    }

    /// 已经连上的推送流，每次复查都要同时查「还是不是管理员」和「这次登录还在不在」。
    ///
    /// 只查 role 的那一版留下的洞：管理员笔记本丢了，他在另一台机器上把那次登录注销掉，
    /// 自己仍然是管理员 —— 于是那台机器上已经连着的 socket 判定通过，继续把全站用户的
    /// 邮箱和订单/佣金金额推满 30 天令牌寿命。整条认证链上只有这里不查 revoked_at。
    /// 这里没有能连真实数据库的用例，所以钉源码：谁把这段「优化」掉，这条会红并解释原因。
    #[test]
    fn an_open_feed_socket_rechecks_the_session_not_just_the_role() {
        let src = code_of(include_str!("realtime.rs"));
        let src = body(&src);

        let handshake = src
            .split("async fn ws_authenticate(")
            .nth(1)
            .expect("ws_authenticate");
        let handshake = &handshake[..handshake.find("async fn handle_socket").unwrap_or(handshake.len())];
        assert!(
            handshake.contains("claims.sid"),
            "sid 必须从令牌里取出来带走 —— 丢掉它，连上之后就没有东西可以复查",
        );

        let feed = src.split("async fn stream_feed(").nth(1).expect("stream_feed");
        assert!(
            feed.contains("sid: Option<uuid::Uuid>"),
            "这条连接的 sid 要一路带进推送循环",
        );

        let arm = feed.split("_ = recheck.tick() =>").nth(1).expect("recheck 分支");
        let arm = &arm[..arm.find("maybe = messages.next()").unwrap_or(arm.len())];
        // 钉的是**整个条件**，不是被调用的那个函数名。
        //
        // 只断言「调用存在」挡不住一次符号翻转：把 `if !session_is_live(…)` 改成
        // `if session_is_live(…)`，效果是把所有**还活着**的管理员连接踢掉、而所有**已被
        // 吊销**的继续推流 —— 原漏洞原样回来，还附赠一次线上故障。实测那样改之后
        // realtime:: 两条测试照样全绿。所以 `!` 和整条 if 都要在断言里。
        assert!(
            arm.contains("if !is_admin_now(state, uid).await {"),
            "降权和删号仍然要现查，而且判据必须是「不再是管理员就断开」——\
             少一个 ! 就变成「还是管理员才断开」，方向正好反过来",
        );
        assert!(
            arm.contains("if !crate::sessions::session_is_live(&state.db, uid, sid).await {"),
            "「注销该设备」必须能切断已经连上的这条流，否则设备列表宣传的是个不生效的开关。\
             同样要钉住 !：符号一翻，被吊销的连接反而是唯一留下来的",
        );
        assert_eq!(
            arm.matches("break;").count(),
            2,
            "两条判定各自都要断开连接，任一条不过就不能再推",
        );
    }

    /// 这里不许再有第三份手抄的存活判定。
    ///
    /// 修「/ws 不查 revoked_at」那个洞时，这个文件里一度原样抄了一份 SQL —— 而洞本身的
    /// 成因就是同一条规则有多份实现（当时 auth.rs 里已经有两份）。判定的唯一文本在
    /// `crate::sessions::SESSION_LIVE_SQL`，两份手抄件之间是否还一致由 sessions.rs 的
    /// `liveness_tests` 逐字比对；这条只盯一件事：realtime 不要把它抄回来。
    #[test]
    fn the_recheck_does_not_keep_its_own_copy_of_the_liveness_sql() {
        let src = code_of(include_str!("realtime.rs"));
        let src = body(&src);
        assert!(
            !src.contains("FROM sessions"),
            "realtime 又自己写了一条查 sessions 的语句 —— 改调 \
             crate::sessions::session_is_live()，那条判定只应该有一份文本",
        );
    }
}
