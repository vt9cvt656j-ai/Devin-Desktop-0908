use axum::async_trait;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::Config;
use crate::error::{ApiResult, AppError};
use crate::AppState;

/// 窗口额度多久回满一次（PostgreSQL interval 字面量）。
///
/// 2026-08-18 从 `5 hours 30 minutes` 改成 `30 minutes`：用户的原话是"感觉有点拉"。
///
/// 这个窗口是**节流阀，不是预算**——花钱时 `quota_total_cents` 和 `quota_window_cents`
/// 一起扣（见 models.rs 的结算 UPDATE），而回满值是 `LEAST(窗口上限, 剩余总额度)`。
/// 所以缩短它不会让任何人多花一分钱，只是让人能按自己的节奏用掉本来就有的额度，
/// 而不是撞上"本时段已用完，等 5 个半小时"。
///
/// 抽成常量而不是散在 7 条 SQL 里：这个值散落多处然后各自漂移，是本仓库最常见的一类 bug。
pub const QUOTA_WINDOW_REFRESH: &str = "30 minutes";

/// 「窗口回满 + 周计数器重置」这条 UPDATE 的唯一出处。
///
/// 上面那个常量抽出来是因为「值」漂移过；这个函数抽出来是因为「语句」也漂移了——同一条
/// UPDATE 曾经在 auth.rs 的 /api/me 和 models.rs 的 chat / image / audio 三处各抄了一份，
/// 四份逐字相同。2026-08-22 给它加 WHERE 闸时，四处都得改；改三处漏一处，就会出现
/// 「网页上看余额刷了、发消息时没刷」这种查不明白的分歧。现在只有这一处。
///
/// **末尾的 WHERE 是正确性的一部分，不是优化。** 每个 CASE 分支在条件为假时都返回原值，
/// 所以没有 WHERE 时它在绝大多数调用上是个空写——而 Postgres 不知道那是空写：照样写新
/// 元组、写 WAL、留死行。2026-08-22 线上实测：users 表 171 行，累计 n_tup_upd 647,154；
/// 自动 ANALYZE 跑了 9,244 次（171 行的表约每 67 次修改就重算统计，把池子里所有连接的
/// 执行计划作废）；全库 22GB WAL 里 2,596,965 个整页镜像（约 20GB）主要来自这种同页重写。
/// 抽样时 171 行里只有 139 行窗口到期、156 行日期到期。
///
/// WHERE 的条件和 CASE 里的条件**逐字同构**（窗口到期 或 周到期），所以结果集完全一致，
/// 只是不再为不该动的行写元组。并发也安全：READ COMMITTED 拿到行锁后会重新求值 WHERE，
/// 同一用户的并发请求塌缩成一次真写。
///
/// 绑定参数：`$1` = 用户 id。
pub fn quota_refresh_sql() -> String {
    format!(
        "UPDATE users SET \
         quota_window_cents = CASE WHEN (quota_window_reset_at IS NULL OR quota_window_reset_at <= now()) AND quota_total_cents > 0 THEN LEAST(quota_window_cap_cents, quota_total_cents) ELSE quota_window_cents END, \
         quota_window_reset_at = CASE WHEN (quota_window_reset_at IS NULL OR quota_window_reset_at <= now()) AND quota_total_cents > 0 THEN now() + interval '{QUOTA_WINDOW_REFRESH}' ELSE quota_window_reset_at END, \
         quota_week_used_cents = CASE WHEN quota_week_reset_at IS NULL OR quota_week_reset_at <= now() THEN 0 ELSE quota_week_used_cents END, \
         quota_week_reset_at = CASE WHEN quota_week_reset_at IS NULL OR quota_week_reset_at <= now() THEN now() + interval '7 days' ELSE quota_week_reset_at END \
         WHERE id = $1 AND ( \
           ((quota_window_reset_at IS NULL OR quota_window_reset_at <= now()) AND quota_total_cents > 0) \
           OR quota_week_reset_at IS NULL OR quota_week_reset_at <= now() \
         )"
    )
}

// ---- models ----------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: uuid::Uuid,
    pub email: String,
    #[serde(skip)]
    pub password_hash: String,
    pub role: String,
    /// US order: given name first, family name second. Empty when never set.
    /// `avatar` is deliberately NOT a field here — this struct is also what
    /// `/api/admin/users` returns for up to 500 rows, and an inline image on each
    /// would turn that response into megabytes. `me` fetches it separately.
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    /// Interface language as a BCP-47 tag, or empty when never chosen. Clients treat an
    /// unrecognised value as "not set" and fall back to English.
    #[serde(default)]
    pub language: String,
    pub plan: String,
    pub plan_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub credits_cents: i64,
    /// Daily free allowance, in 点. ¥0.5 = 10 点, so the ¥2 grant is 40 点.
    #[serde(default)]
    pub free_points: i64,
    pub quota_total_cents: i64,
    pub quota_window_cap_cents: i64,
    pub quota_window_cents: i64,
    pub quota_window_reset_at: Option<chrono::DateTime<chrono::Utc>>,
    pub quota_weekly_cap_cents: i64,
    pub quota_week_used_cents: i64,
    pub quota_week_reset_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub last_login_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user id
    pub email: String,
    pub role: String,
    pub exp: i64,
    /// The `sessions` row this token was issued for, so a single device can be signed
    /// out without rotating the signing secret and ending everyone's session.
    ///
    /// Optional because tokens issued before sessions existed carry no `sid`, and those
    /// people should not be logged out by a deploy. Such a token still authenticates but
    /// cannot be listed or revoked individually; it ages out with the 30-day expiry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
}

// ---- JWT extractor: any handler taking `claims: Claims` requires a valid token

#[async_trait]
impl FromRequestParts<AppState> for Claims {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::unauthorized("缺少 Authorization 头"))?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::unauthorized("Authorization 需为 Bearer <token>"))?;
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| AppError::unauthorized("无效或已过期的令牌"))?;
        let mut claims = data.claims;

        // The token is trusted for IDENTITY but never for PRIVILEGE.
        //
        // All 13 admin gates test `claims.role != "admin"`, and role was whatever was
        // baked into the JWT at login. With a 30-day TTL and no revocation that meant
        // demoting or even deleting an admin left their existing token fully
        // privileged for up to a month — and since the admin endpoints can re-grant
        // the role, one surviving token could take it back permanently. Re-reading
        // role from the row on every request makes demotion and deletion effective
        // immediately; a missing row (deleted user) now fails closed.
        let uid = uuid::Uuid::parse_str(&claims.sub)
            .map_err(|_| AppError::unauthorized("令牌主体无效"))?;
        let sid = claims.sid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());

        // One statement, because this runs on every authenticated request:
        //   * read the role from the row (see above),
        //   * confirm the session behind this token has not been revoked,
        //   * and bump last_seen_at, but only when it is already stale.
        //
        // The `$2 IS NULL` arm is what keeps pre-sessions tokens working: they carry no
        // sid, so there is no session to check and the request is judged on the user row
        // alone — exactly as it was before.
        let row: Option<(String, bool)> = sqlx::query_as(
            "WITH live AS ( \
                 SELECT id FROM sessions \
                 WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL \
             ), touched AS ( \
                 UPDATE sessions SET last_seen_at = now() \
                 WHERE id IN (SELECT id FROM live) \
                   AND last_seen_at < now() - interval '5 minutes' \
                 RETURNING 1 \
             ) \
             SELECT u.role, ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM live)) AS session_ok \
             FROM users u WHERE u.id = $1",
        )
        .bind(uid)
        .bind(sid)
        .fetch_optional(&state.db)
        .await?;

        let (role, session_ok) = row.ok_or_else(|| AppError::unauthorized("账号不存在或已注销"))?;
        if !session_ok {
            return Err(AppError::unauthorized("该设备的登录已被移除，请重新登录"));
        }
        claims.role = role;
        Ok(claims)
    }
}

/// Which kind of client signed in.
///
/// The hint the client sends wins because a Tauri window reports the system webview's
/// User-Agent — indistinguishable from Safari — so sniffing alone would file every
/// desktop sign-in as a browser. Anything unrecognised is called "web": guessing wrong
/// in the direction of the least specific answer is better than inventing a device.
pub(crate) fn device_kind(hint: Option<&str>, user_agent: &str) -> &'static str {
    match hint.map(str::trim).unwrap_or("").to_ascii_lowercase().as_str() {
        "desktop" => return "desktop",
        "mobile" => return "mobile",
        "web" => return "web",
        _ => {}
    }
    let ua = user_agent.to_ascii_lowercase();
    if ua.contains("tauri") || ua.contains("mrday") || ua.contains("electron") {
        "desktop"
    } else if ua.contains("iphone") || ua.contains("ipad") || ua.contains("android") || ua.contains("mobile") {
        "mobile"
    } else {
        "web"
    }
}

/// The client's device id, reduced to something safe to store and compare.
///
/// Clients are asked for a UUID. Anything else is accepted as long as it survives this —
/// the value is only ever compared for equality and rendered nowhere — but it is bounded
/// and stripped so a hostile client cannot use it to smuggle length or punctuation into a
/// column the console later reads. Empty out means "no id", which falls back to the old
/// User-Agent grouping.
pub(crate) fn clean_device_id(raw: Option<&str>) -> String {
    raw.unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(64)
        .collect()
}

/// Open a `sessions` row for a sign-in and hand back a token that names it.
///
/// Every path that mints a token goes through here, so there is no way to end up with a
/// token that has no session behind it and therefore cannot be revoked.
pub(crate) async fn start_session(
    state: &AppState,
    user: &User,
    headers: &axum::http::HeaderMap,
    hint: Option<&str>,
    device_id: Option<&str>,
) -> ApiResult<String> {
    let user_agent: String = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();
    let kind = device_kind(hint, &user_agent);
    let device_id = clean_device_id(device_id);

    // Signing in again on a device that already has a live session replaces it. Without
    // this the table grows a row per sign-in and the console lists the same laptop three
    // times — each row a genuinely valid token, which is why it cannot just be hidden at
    // display time: the old tokens have to actually stop working.
    //
    // Scoped to this account, so signing in here never touches anybody else's session on
    // a shared computer.
    if !device_id.is_empty() {
        sqlx::query(
            "UPDATE sessions SET revoked_at = now() \
             WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
        )
        .bind(user.id)
        .bind(&device_id)
        .execute(&state.db)
        .await?;
    }

    let sid: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO sessions (user_id, kind, user_agent, ip, device_id) \
         VALUES ($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(user.id)
    .bind(kind)
    .bind(&user_agent)
    .bind(client_ip(headers))
    .bind(&device_id)
    .fetch_one(&state.db)
    .await?;

    issue_token(&state.cfg, user, sid)
}

fn issue_token(cfg: &Config, user: &User, sid: uuid::Uuid) -> ApiResult<String> {
    let claims = Claims {
        sub: user.id.to_string(),
        email: user.email.clone(),
        role: user.role.clone(),
        exp: chrono::Utc::now().timestamp() + cfg.jwt_ttl_secs,
        sid: Some(sid.to_string()),
    };
    Ok(encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(cfg.jwt_secret.as_bytes()),
    )?)
}

/// Resolve a user id from a raw JWT (used by the model gateway so the IDE can
/// authenticate with the login token, not just an API key). None if invalid.
///
/// **签名有效 ≠ 这次登录还在。** 这个函数以前只验签名和过期就放行，而它正是所有计费入口
/// 的认证回落路径：`/v1/chat/completions`、responses、audio、images、knowledge。`Claims`
/// 提取器一直在查 `sessions.revoked_at`，这里没查 —— 两条路对同一张令牌给出相反的答案。
///
/// 后果是用户在后台点「注销该设备」之后：`/api/me` 如实 401 了，可同一张令牌还能继续烧他
/// 的额度，直到 30 天自然过期。设备列表在宣传一个不生效的开关，而真正花钱的那条路根本
/// 没在听。所以这里必须做和提取器一模一样的检查。
///
/// 删号同理：用户行没了也要拒，否则注销的账号还能接着调用。
pub async fn user_from_jwt(
    db: &sqlx::PgPool,
    cfg: &Config,
    token: &str,
) -> Option<uuid::Uuid> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(cfg.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()?;
    let uid = uuid::Uuid::parse_str(&data.claims.sub).ok()?;
    let sid = data.claims.sid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());

    // 和 Claims 提取器同一条判定：`$2 IS NULL` 那一支放行 sessions 表出现之前签发的老令牌
    // （它们没有 sid，没有对应的行可查），其余一律要求会话还活着。
    let ok: Option<(bool,)> = sqlx::query_as(
        "SELECT ($2::uuid IS NULL OR EXISTS ( \
             SELECT 1 FROM sessions \
             WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL \
         )) AS live \
         FROM users WHERE id = $1",
    )
    .bind(uid)
    .bind(sid)
    .fetch_optional(db)
    .await
    .ok()?;

    match ok {
        Some((true,)) => Some(uid),
        // 会话已注销，或者用户行已经不在了。
        _ => None,
    }
}

/// Decode and validate a login JWT into its claims. For contexts that cannot use
/// the `Claims` extractor because there is no request to extract from — notably the
/// WebSocket feed, where the browser cannot send an Authorization header and the
/// token arrives in the first frame instead.
/// 同样要查会话是否已注销 —— 理由见上面 `user_from_jwt`。这条路的调用方（管理后台的
/// WebSocket）随后会用 `is_admin_now` 现查一次 role，所以降权是立刻生效的；但"这次登录
/// 已被注销"以前没人查，被踢掉的管理员会话照样能连上实时推送。
pub async fn claims_from_jwt(db: &sqlx::PgPool, cfg: &Config, token: &str) -> Option<Claims> {
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(cfg.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|data| data.claims)?;

    let uid = uuid::Uuid::parse_str(&claims.sub).ok()?;
    let sid = claims.sid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());
    let live: Option<(bool,)> = sqlx::query_as(
        "SELECT ($2::uuid IS NULL OR EXISTS ( \
             SELECT 1 FROM sessions \
             WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL \
         )) AS live \
         FROM users WHERE id = $1",
    )
    .bind(uid)
    .bind(sid)
    .fetch_optional(db)
    .await
    .ok()?;
    matches!(live, Some((true,))).then_some(claims)
}

// ---- password-login brute-force guard --------------------------------------
// The emailed-code path is carefully budgeted (per-code attempts + an hourly ceiling that
// resends cannot reset). Password login had no budget at all — only bcrypt's cost factor,
// which slows an attacker but never stops one, and fail2ban on this host is configured for
// SSH, not for HTTP 401s from the backend.

/// Failed passwords tolerated per account per hour before login is paused.
const LOGIN_FAIL_PER_EMAIL: i64 = 10;
/// Failed passwords tolerated per source IP per hour — stops one host spraying many accounts.
const LOGIN_FAIL_PER_IP: i64 = 50;
const LOGIN_FAIL_WINDOW_SECS: i64 = 3600;

/// A throwaway hash so "no such account" spends the same CPU as a wrong password.
static DUMMY_HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    bcrypt::hash("michael-timing-equalizer", bcrypt::DEFAULT_COST).unwrap_or_default()
});

/// Client IP as nginx sees it (`X-Real-IP`, else the first `X-Forwarded-For` hop).
fn client_ip(headers: &axum::http::HeaderMap) -> String {
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.split(',').next())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Reject outright when either budget is spent; otherwise hand back the two counter keys.
async fn login_guard(state: &AppState, email: &str, ip: &str) -> ApiResult<(String, String)> {
    let mut conn = state.redis.clone();
    let ekey = format!("login_fail:{}", normalize_email(email));
    let ikey = format!("login_fail_ip:{ip}");
    let e_fails: Option<i64> = redis::cmd("GET").arg(&ekey).query_async(&mut conn).await?;
    let i_fails: Option<i64> = redis::cmd("GET").arg(&ikey).query_async(&mut conn).await?;
    if e_fails.unwrap_or(0) >= LOGIN_FAIL_PER_EMAIL || i_fails.unwrap_or(0) >= LOGIN_FAIL_PER_IP {
        return Err(AppError::bad(
            "登录失败次数过多，请稍后再试，或改用邮箱验证码登录",
        ));
    }
    Ok((ekey, ikey))
}

async fn login_fail(state: &AppState, ekey: &str, ikey: &str) {
    let mut conn = state.redis.clone();
    for k in [ekey, ikey] {
        let _: Result<i64, _> = redis::cmd("INCR").arg(k).query_async(&mut conn).await;
        // EXPIRE on every increment (idempotent): setting it only on the first failure
        // risks a crash in between leaving a TTL-less key that locks the account out forever
        // — the same reasoning as take_code() above.
        let _: Result<(), _> = redis::cmd("EXPIRE")
            .arg(k)
            .arg(LOGIN_FAIL_WINDOW_SECS)
            .query_async(&mut conn)
            .await;
    }
}

async fn login_ok(state: &AppState, ekey: &str, ikey: &str) {
    let mut conn = state.redis.clone();
    let _: Result<(), _> = redis::cmd("DEL")
        .arg(ekey)
        .arg(ikey)
        .query_async(&mut conn)
        .await;
}

/// Lightweight email format check ("合规").
pub fn valid_email(e: &str) -> bool {
    let e = e.trim();
    if e.len() < 6 || e.len() > 254 || e.contains(char::is_whitespace) {
        return false;
    }
    let mut parts = e.split('@');
    let (local, domain) = match (parts.next(), parts.next(), parts.next()) {
        (Some(l), Some(d), None) => (l, d),
        _ => return false,
    };
    !local.is_empty()
        && domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.rsplit('.').next().is_some_and(|tld| tld.len() >= 2)
}

// ---- verification codes (Redis, with TTL) ----------------------------------

fn code_key(email: &str) -> String {
    format!("code:{}", email.trim().to_lowercase())
}

/// Max wrong guesses against a SINGLE emailed code before it is BURNED.
const MAX_CODE_ATTEMPTS: i64 = 5;
/// Hard ceiling on TOTAL failed guesses per email per hour — NOT reset by requesting
/// fresh codes, so resends can't multiply the attempt budget (cleared on success).
const HOURLY_ATTEMPT_CAP: i64 = 20;

fn attempts_key(email: &str) -> String {
    format!("code_tries:{}", email.trim().to_lowercase())
}

async fn store_code(state: &AppState, email: &str, code: &str) -> ApiResult<()> {
    let mut conn = state.redis.clone();
    let _: () = redis::cmd("SET")
        .arg(code_key(email))
        .arg(code)
        .arg("EX")
        .arg(state.cfg.code_ttl_secs)
        .query_async(&mut conn)
        .await?;
    // Fresh code → fresh attempt window.
    let _: () = redis::cmd("DEL")
        .arg(attempts_key(email))
        .query_async(&mut conn)
        .await?;
    Ok(())
}

/// Increment a counter inside a **fixed** window: the key is created together with
/// its TTL in one atomic `SET NX EX`, and later increments leave that TTL alone, so
/// the window expires a fixed time after the first hit no matter how many follow.
async fn bump_fixed_window(
    conn: &mut redis::aio::ConnectionManager,
    key: &str,
    ttl_secs: u64,
) -> ApiResult<i64> {
    let _: Option<String> = redis::cmd("SET")
        .arg(key)
        .arg(0i64)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async(conn)
        .await?;
    Ok(redis::cmd("INCR").arg(key).query_async::<i64>(conn).await?)
}

async fn take_code(state: &AppState, email: &str, code: &str) -> ApiResult<bool> {
    let mut conn = state.redis.clone();
    let key = code_key(email);
    // Brute-force guard: count guesses within the code's TTL window. Past the cap,
    // BURN the code so even a later correct guess can't pass — the user must request
    // a fresh one (which resets the counter via store_code).
    // Both counters are created with their TTL in one atomic `SET NX EX` and then
    // only INCR'd, because INCR leaves an existing TTL alone.
    //
    // Calling EXPIRE on every attempt (the previous approach) made the window slide
    // forward with each guess, so the counter never actually expired while an attacker
    // kept poking: 20 wrong guesses put the hourly counter over the cap, and one
    // request per hour after that held it there — permanently blocking registration
    // and code-login for that address, from an anonymous caller. Creating the key with
    // its TTL up front also avoids the TTL-less-key risk that motivated EXPIRE-always.
    // (a) Per-code budget: reset when a fresh code is sent (store_code DELs it).
    let tries_key = attempts_key(email);
    let tries = bump_fixed_window(&mut conn, &tries_key, state.cfg.code_ttl_secs).await?;
    // (b) Hourly budget across the whole email, NOT reset by resends — caps total
    // guesses so an attacker can't keep requesting fresh codes to refill (a)'s 5.
    let hour_key = format!("code_tries_h:{}", normalize_email(email));
    let hourly = bump_fixed_window(&mut conn, &hour_key, 3600).await?;
    if tries > MAX_CODE_ATTEMPTS || hourly > HOURLY_ATTEMPT_CAP {
        let _: () = redis::cmd("DEL").arg(&key).query_async(&mut conn).await?;
        return Err(AppError::bad("验证码尝试次数过多，请稍后重新获取验证码"));
    }
    let stored: Option<String> = redis::cmd("GET").arg(&key).query_async(&mut conn).await?;
    match stored {
        Some(s) if s == code => {
            let _: () = redis::cmd("DEL").arg(&key).query_async(&mut conn).await?;
            // Success → clear BOTH budgets so a legit user is never carried over.
            let _: () = redis::cmd("DEL")
                .arg(&tries_key)
                .arg(&hour_key)
                .query_async(&mut conn)
                .await?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Google-style, light-themed verification email. Table layout + inline styles only, so it renders
/// consistently across mail clients (Gmail / QQ / 163 / Outlook all strip <style> and dislike flex).
fn code_email_html(code: &str) -> String {
    format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f3f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="448" cellpadding="0" cellspacing="0" style="max-width:448px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #e8eaed;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
<tr><td style="padding:40px 44px 6px;text-align:center;"><img src="https://code.mrday.one/api/logo.png" width="52" height="52" alt="Mr. Day One" style="display:inline-block;width:52px;height:52px;border-radius:14px;" /></td></tr>
<tr><td style="padding:16px 44px 0;text-align:center;"><div style="font-size:22px;font-weight:500;color:#202124;">验证您的邮箱</div><div style="font-size:14px;color:#5f6368;line-height:1.7;margin-top:10px;">您正在登录 / 注册 <b style="color:#202124;">Mr. Day One</b>，请在登录页面输入下面的验证码：</div></td></tr>
<tr><td style="padding:26px 44px 6px;text-align:center;"><div style="display:inline-block;background:#f6f9fe;border:1px solid #d2e3fc;border-radius:12px;padding:16px 22px 16px 32px;font-size:34px;font-weight:700;letter-spacing:10px;color:#1a73e8;font-family:'SF Mono',Menlo,Consolas,monospace;">{code}</div></td></tr>
<tr><td style="padding:18px 44px 0;text-align:center;"><div style="font-size:13px;color:#80868b;line-height:1.7;">验证码 <b>10 分钟</b>内有效，请勿泄露给他人。如果这不是您本人的操作，请忽略此邮件。</div></td></tr>
<tr><td style="padding:28px 44px 0;"><div style="border-top:1px solid #e8eaed;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:16px 44px 34px;text-align:center;"><div style="font-size:12px;color:#9aa0a6;line-height:1.6;">此邮件由 Mr. Day One 自动发送，请勿直接回复。</div></td></tr>
</table></td></tr></table></body></html>"#,
        code = code
    )
}

async fn send_code_email(cfg: &Config, to: &str, code: &str) -> ApiResult<bool> {
    if !cfg.mail_enabled() {
        tracing::warn!("[DEV] 邮件服务未配置. Code for {to}: {code}");
        return Ok(false);
    }
    let html = code_email_html(code);
    crate::email::send_mail(cfg, to, "Mr. Day One 登录验证码", &html, true).await?;
    Ok(true)
}

fn gen_code() -> String {
    use rand::Rng;
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000))
}

/// The single canonical form of an email address. Everything that keys off an email
/// — Redis code/attempt/cooldown keys, user lookup, the stored row — must agree, or
/// the mismatch itself becomes the bug: codes were already stored lowercased while
/// lookup and INSERT used the raw string, so `Alice@x.com` missed the existing
/// `alice@x.com` row, passed the "already registered" check, and inserted a second
/// account for one mailbox (users.email's UNIQUE index is case-sensitive).
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Look a user up case-insensitively. Matching on `lower(email)` rather than the
/// normalized string keeps mixed-case rows created before normalization loginable.
/// `LIMIT 1` (oldest first) because such rows may already collide pairwise, and a
/// bare `fetch_optional` would error out instead of resolving to the original account.
pub(crate) async fn find_user(state: &AppState, identity: &str) -> ApiResult<Option<User>> {
    // Matches on `email`, which in this deployment is really an IDENTITY column — the admin
    // account's stored email is literally "fendoushaonian", not an address. A username therefore
    // already works and no username column is needed; what blocked login was a `type="email"` on
    // the client input, which the browser rejected before the request was ever sent. Deliberately
    // ONE query: an email-or-username OR would let a username shadow someone else's real address.
    Ok(sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1",
    )
    .bind(normalize_email(identity))
    .fetch_optional(&state.db)
    .await?)
}

// ---- request/response payloads ---------------------------------------------

#[derive(Deserialize)]
pub struct EmailReq {
    pub email: String,
}
#[derive(Deserialize)]
pub struct LoginReq {
    pub email: String,
    pub password: String,
    /// What kind of client this is: "web", "desktop" or "mobile". Display only — it
    /// grants nothing, so a client that lies about it gains nothing. Absent from older
    /// clients, in which case the User-Agent decides.
    #[serde(default)]
    pub device: Option<String>,
    /// Which machine, so a second sign-in replaces this device's row instead of adding
    /// one. Also display only, and also safe to lie about: the worst a made-up value
    /// does is give that client a row of its own.
    #[serde(default)]
    pub device_id: Option<String>,
}
#[derive(Deserialize)]
pub struct RegisterReq {
    pub email: String,
    pub password: String,
    pub code: String,
    /// What kind of client this is: "web", "desktop" or "mobile". Display only — it
    /// grants nothing, so a client that lies about it gains nothing. Absent from older
    /// clients, in which case the User-Agent decides.
    #[serde(default)]
    pub device: Option<String>,
    /// See `LoginReq::device_id`.
    #[serde(default)]
    pub device_id: Option<String>,
    /// 邀请码，可选。在建号的同一个请求里绑推荐人。
    ///
    /// 为什么在这里而不是只靠事后的 /api/referral/claim：产品规则是「只有新注册的账号能绑
    /// 推荐人」，那么最准确的时机就是注册这一刻。而且桌面端 App 里注册的人根本走不到网页
    /// 控制台那条事后绑定的路 —— 「点链接 → 下载 App → 在 App 里注册」整条推荐会丢掉。
    #[serde(default)]
    pub referral_code: Option<String>,
}
#[derive(Deserialize)]
pub struct CodeReq {
    pub email: String,
    pub code: String,
    /// What kind of client this is: "web", "desktop" or "mobile". Display only — it
    /// grants nothing, so a client that lies about it gains nothing. Absent from older
    /// clients, in which case the User-Agent decides.
    #[serde(default)]
    pub device: Option<String>,
    /// See `LoginReq::device_id`.
    #[serde(default)]
    pub device_id: Option<String>,
}

// ---- handlers --------------------------------------------------------------

pub async fn check_email(
    State(state): State<AppState>,
    Json(req): Json<EmailReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_email(&req.email) {
        return Err(AppError::bad("邮箱格式不正确"));
    }
    let Some(user) = find_user(&state, &req.email).await? else {
        return Ok(Json(json!({ "exists": false, "password": false, "providers": [] })));
    };

    // How this account signs in, so the page can ask for the right thing. Without it,
    // someone who created their account with Google is shown a password box that no
    // password will ever satisfy.
    let providers: Vec<String> = sqlx::query_scalar(
        "SELECT provider FROM auth_identities WHERE user_id = $1 ORDER BY provider",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({
        "exists": true,
        "password": !user.password_hash.is_empty(),
        "providers": providers,
    })))
}

/// Per-address daily send ceiling. A 30s cooldown alone still allows 2880 mails a
/// day at one victim's inbox.
const CODE_SENDS_PER_EMAIL_PER_DAY: i64 = 12;
/// Ceiling on how many distinct sends one caller IP can trigger per hour. The
/// gateway has no rate-limit middleware at all, so without this a single host can
/// walk an address list and burn the whole email quota (which also gets the sending
/// domain blacklisted — damage that outlives the attack).
const CODE_SENDS_PER_IP_PER_HOUR: i64 = 20;

pub async fn send_code(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<EmailReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_email(&req.email) {
        return Err(AppError::bad("邮箱格式不正确"));
    }
    let email = normalize_email(&req.email);
    let mut conn = state.redis.clone();
    // Cooldown: one code per 30s per email. Without it an attacker could spam fresh
    // codes to reset the attempt cap (and bomb the inbox / our email quota).
    {
        let ok: Option<String> = redis::cmd("SET")
            .arg(format!("code_cd:{email}"))
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(30i64)
            .query_async(&mut conn)
            .await?;
        if ok.is_none() {
            return Err(AppError::bad("验证码发送过于频繁，请 30 秒后再试"));
        }
    }
    // 调用方的每小时上限**先查**。
    //
    // 顺序在这里是安全属性，不是风格问题。原来是先给 `code_send_d:{email}` 加一，再查 IP
    // 上限 —— 于是一个被 IP 限流挡掉、一封信都没发出去的请求，照样烧掉了受害者当天 12 次
    // 配额里的一次。一个 IP 因此可以在不触发任何发信的情况下，把任意多个邮箱的验证码登录
    // 路径挨个封死：每个地址打 12 下就够了，而它自己早就越过上限、什么都没寄出去。
    //
    // 先查 IP，越限的请求根本走不到那个计数器，攻击就没有了着力点。
    //
    // nginx restores the real client IP (conf.d/cloudflare-realip.conf), so
    // X-Forwarded-For's last hop is meaningful here; absent it we fall back to a
    // shared bucket rather than skipping the check.
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next_back())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let per_ip = bump_fixed_window(&mut conn, &format!("code_send_ip:{ip}"), 3600).await?;
    if per_ip > CODE_SENDS_PER_IP_PER_HOUR {
        return Err(AppError::bad("请求过于频繁，请稍后再试"));
    }
    // Daily ceiling per address — protects the victim's inbox.
    let per_email =
        bump_fixed_window(&mut conn, &format!("code_send_d:{email}"), 24 * 3600).await?;
    if per_email > CODE_SENDS_PER_EMAIL_PER_DAY {
        return Err(AppError::bad("该邮箱今日验证码发送次数已达上限，请明天再试"));
    }
    let code = gen_code();
    store_code(&state, &req.email, &code).await?;
    let sent = send_code_email(&state.cfg, &req.email, &code).await?;
    Ok(Json(
        json!({ "sent": sent, "message": if sent { "验证码已发送到邮箱（10 分钟有效）" } else { "开发模式：验证码见服务端日志" } }),
    ))
}

pub async fn register(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RegisterReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_email(&req.email) {
        return Err(AppError::bad("邮箱格式不正确"));
    }
    if req.password.len() < 6 {
        return Err(AppError::bad("密码至少 6 位"));
    }
    // Duplicate check BEFORE consuming the code. take_code() deletes the code on success,
    // so the old order burned the code of anyone who retried a registration that had
    // already gone through — they then had to wait out the 30s resend cooldown.
    if find_user(&state, &req.email).await?.is_some() {
        return Err(AppError::bad("该邮箱已注册，请直接登录"));
    }
    if !take_code(&state, &req.email, &req.code).await? {
        return Err(AppError::bad("验证码错误或已过期"));
    }
    let hash = bcrypt::hash(&req.password, bcrypt::DEFAULT_COST)?;
    // Store the canonical form so the UNIQUE index actually enforces one account per
    // mailbox from here on.
    // ON CONFLICT: two concurrent registrations for the same address both clear the check
    // above; without this the loser hits the UNIQUE index and surfaces as a raw 500.
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) \
         ON CONFLICT (email) DO NOTHING RETURNING *",
    )
    .bind(normalize_email(&req.email))
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::bad("该邮箱已注册，请直接登录"))?;
    let token = start_session(&state, &user, &headers, req.device.as_deref(), req.device_id.as_deref()).await?;

    // 带了邀请码就当场绑。失败不影响注册：账号已经建好了，一个绑不上的推荐关系不该让人
    // 注册不成 —— 网页那条路稍后还会再试一次（同一个码、同一套规则）。
    let referred_by = match req.referral_code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(code) => crate::referral::bind_at_signup(&state, user.id, code).await,
        None => None,
    };

    crate::realtime::record_event(
        &state,
        Some(user.id),
        "register",
        json!({ "email": user.email, "referred_by": referred_by }),
    )
    .await;
    // 布尔，不是邮箱。
    //
    // `bind_at_signup` 返回的是**推荐人的真实邮箱**，上面那行 record_event 需要它（事件流
    // 只有管理员看得到）。但它同时被原样放进了 HTTP 响应 —— 而邀请链接是公开发布的：
    // 任何人拿一个公开的 `?ref=CODE` 注册一个自己的邮箱，响应体里就有推荐人的邮箱。
    //
    // 调用方（ide/src/main.js:386）只判断真假 —— 绑上了就把本地存的邀请码清掉，从不显示
    // 这个值。所以换成布尔不影响任何人，而邮箱不再离开服务器。键名保持不变，老客户端照常工作。
    Ok(Json(json!({ "token": token, "user": user, "referred_by": referred_by.is_some() })))
}

pub async fn login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<LoginReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if req.email.trim().is_empty() || req.password.is_empty() {
        return Err(AppError::bad("账号或密码不能为空"));
    }
    let ip = client_ip(&headers);
    let (ekey, ikey) = login_guard(&state, &req.email, &ip).await?;
    // One message for "no such account" and "wrong password", and the same bcrypt cost on
    // both paths. Splitting them — and skipping bcrypt entirely when the account did not
    // exist — made both the response text AND the response time an enumeration oracle,
    // on an endpoint that had no rate limit at all.
    let user = match find_user(&state, req.email.trim()).await? {
        Some(u) => u,
        None => {
            let _ = bcrypt::verify(&req.password, &DUMMY_HASH);
            login_fail(&state, &ekey, &ikey).await;
            return Err(AppError::unauthorized("账号或密码错误"));
        }
    };
    // An account created by signing in with a provider has no password. bcrypt::verify
    // against '' is an *error*, not a false, so without this the person gets a 500 for
    // doing something entirely reasonable.
    //
    // This says which account it is, unlike the message above. That is not a new leak:
    // /api/auth/check-email already answers whether an address is registered — the sign-in
    // page is built on it — so the existence of the account is not what is being protected
    // here. Being told "use Google" is the difference between signing in and being stuck.
    if user.password_hash.is_empty() {
        // Same cost as the real path, so the timing does not become the oracle the
        // message is not.
        let _ = bcrypt::verify(&req.password, &DUMMY_HASH);
        login_fail(&state, &ekey, &ikey).await;
        return Err(AppError::bad(
            "该账号使用第三方登录创建，请用下方的 GitHub 或 Google 按钮登录",
        ));
    }
    if !bcrypt::verify(&req.password, &user.password_hash)? {
        login_fail(&state, &ekey, &ikey).await;
        return Err(AppError::unauthorized("账号或密码错误"));
    }
    login_ok(&state, &ekey, &ikey).await;
    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    let token = start_session(&state, &user, &headers, req.device.as_deref(), req.device_id.as_deref()).await?;
    crate::realtime::record_event(
        &state,
        Some(user.id),
        "login",
        json!({ "email": user.email }),
    )
    .await;
    Ok(Json(json!({ "token": token, "user": user })))
}

pub async fn verify_code(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<CodeReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if !take_code(&state, &req.email, &req.code).await? {
        return Err(AppError::bad("验证码错误或已过期"));
    }
    let user = find_user(&state, &req.email)
        .await?
        .ok_or_else(|| AppError::bad("该邮箱尚未注册，请先设置密码注册"))?;
    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    let token = start_session(&state, &user, &headers, req.device.as_deref(), req.device_id.as_deref()).await?;
    crate::realtime::record_event(
        &state,
        Some(user.id),
        "login",
        json!({ "email": user.email, "via": "code" }),
    )
    .await;
    Ok(Json(json!({ "token": token, "user": user })))
}

#[derive(Deserialize)]
pub struct ResetPasswordReq {
    pub email: String,
    pub code: String,
    pub password: String,
    /// See `LoginReq::device`.
    #[serde(default)]
    pub device: Option<String>,
    /// See `LoginReq::device_id`.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// `POST /api/auth/reset-password` — 用邮箱验证码给**已有**账号设一个新密码，并当场登录。
///
/// 在这之前产品里没有任何一条改密码的路：注册对已存在的邮箱直接拒绝，登录只认旧密码，
/// 第三方登录建的账号密码是空的。忘了密码的人只能找管理员去数据库里改——2026-09-05 真的
/// 发生了一次。这条路复用发码 / 验码那套预算（每码 5 次、每小时 20 次、每天 12 封）和
/// 注册用的 bcrypt 成本，不另立一套。
///
/// 顺序是安全属性：先查账号存不存在、再消费验证码——和 register 同一个理由，别把重试者的
/// 码烧掉；「尚未注册」这条消息和 verify_code 一致，而 check-email 本来就公开这件事。
///
/// 密码换了 = 这个人此刻在场。**其它设备上的登录一律作废**：丢密码的常见原因是设备丢了，
/// 不作废的话拿着旧令牌的人照样能用 30 天。本次请求随后 start_session 开一条新会话，
/// 所以调用方自己不会被登出。登录失败计数也一并清掉，否则刚重置完还被锁着。
pub async fn reset_password(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ResetPasswordReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_email(&req.email) {
        return Err(AppError::bad("邮箱格式不正确"));
    }
    if req.password.len() < 6 {
        return Err(AppError::bad("密码至少 6 位"));
    }
    let user = find_user(&state, &req.email)
        .await?
        .ok_or_else(|| AppError::bad("该邮箱尚未注册，请先注册"))?;
    if !take_code(&state, &req.email, &req.code).await? {
        return Err(AppError::bad("验证码错误或已过期"));
    }
    let hash = bcrypt::hash(&req.password, bcrypt::DEFAULT_COST)?;
    sqlx::query(
        "UPDATE users SET password_hash = $1, updated_at = now(), last_login_at = now() WHERE id = $2",
    )
    .bind(&hash)
    .bind(user.id)
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    {
        let mut conn = state.redis.clone();
        let _: Result<(), _> = redis::cmd("DEL")
            .arg(format!("login_fail:{}", normalize_email(&req.email)))
            .query_async(&mut conn)
            .await;
    }
    let token = start_session(&state, &user, &headers, req.device.as_deref(), req.device_id.as_deref()).await?;
    crate::realtime::record_event(
        &state,
        Some(user.id),
        "password_reset",
        json!({ "email": user.email }),
    )
    .await;
    Ok(Json(json!({ "token": token, "user": user })))
}

/// `GET /api/authz` —— nginx `auth_request` 的目标。204 = 已登录，401 = 没登录。
///
/// ## 为什么必须和 /api/me 分开
///
/// `/_app_authz` 原来打的是 `/api/me`，而 `/api/me` 每次要跑 **两条 UPDATE + 一条
/// SELECT \***（配额窗口刷新、每日免费点发放、整行读取）。nginx 的 auth_request 是
/// **每个受门禁的请求**都触发一次 —— 包括 `/app/` 和 `/account/` 下的每一个 JS、CSS、
/// 字体文件。打开一次网页版 IDE 有几十个静态资源，就是几十次 auth 子请求、上百次
/// 对同一行 users 的写。
///
/// 线上实测（2026-08-05）：users 表 120 行，累计 **362,059 次 UPDATE**，而
/// model_usage 只有 78,086 行 —— 也就是说绝大多数写入根本不来自计费，来自这个门禁。
/// HOT update 让它没有膨胀（dead tuple 只有 26），但每条 UPDATE 都要拿行锁，同一个
/// 用户的并发请求因此串行化，日志里那条 `time to acquire exceeded slow threshold
/// aquired_after_secs=2.29` 就是连接卡在行锁上。
///
/// 这个问题 console_session.rs 早就写明白了（"/api/me … 还会跑两条 UPDATE，不适合
/// 每个请求都触发一次"），并且为 `/console/` 单独做了只读的 `/api/admin/authz`。
/// 这里只是把同一套做法补给 `/app/` 和 `/account/`。
///
/// 本函数**一次写都没有**：`Claims` 提取器已经按主键读过一次 users 校验身份和 role，
/// 到这里只需要回一个状态码。配额刷新和每日发放仍然在 `/api/me` 里做 —— 那才是真正
/// 要展示余额的地方，而且它由用户打开资料页触发，不是每个静态资源都触发。
pub async fn authz(_claims: Claims) -> Response {
    // 能走到这里说明 Claims 提取器已经验过令牌、且用户还在库里（删号立刻失效）。
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /api/auth/logout` — 结束调用方自己这一次登录。
///
/// **为什么必须有服务端这一步。** 以前「退出登录」只是各自清各自的本地存储 —— 令牌本身
/// 还是好的。官网在 mrday.one，登录页和后台在 code.mrday.one，两个源的 localStorage
/// 互相看不见：官网点退出，只能删掉共享的那颗 cookie，删不掉 code.mrday.one 里那份
/// `michael_token` 副本。于是：
///
/// ```text
///   /dashboard  ──(nginx 只认 cookie，没有)──▶  302 /gate?next=/dashboard
///   /gate       ──(读到残留的 localStorage 令牌，/api/me 说它有效)──▶  跳回 /dashboard
/// ```
///
/// 两边各自都「对」，合起来是一个永不停止的跳转循环 —— 用户看到的就是登录页一直刷新，
/// 而且退不掉、也登不进。真正的修法不是拦跳转，是让退出登录真的把这次登录作废：令牌一失效，
/// 残留副本在哪个源里都换不来任何东西。
///
/// 只作废 `sid` 指的这一条，所以桌面端不受影响 —— 这也正是界面上写的那句「登出只会清除
/// 当前浏览器的登录」。
///
/// **重复调用会拿到 401，不是 200。** Claims 提取器在进入本函数之前就会拒掉已作废的令牌，
/// 所以第二次点退出登录，请求在门口就被挡了。这是对的，不值得为它开一条"接受已作废令牌"
/// 的路：客户端两边都把这个调用包在 try 里，无论成败都照常清本地、回登录页 —— 因为网络
/// 不通或者"你已经退过了"就不让人退出，才是错误的失败方式。
pub async fn logout(State(state): State<AppState>, claims: Claims) -> ApiResult<Json<serde_json::Value>> {
    let uid = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;
    let sid = claims.sid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok());

    // 限定 user_id：sid 来自调用方的令牌，但仍然只允许作废自己的行。
    let revoked = match sid {
        Some(sid) => {
            sqlx::query(
                "UPDATE sessions SET revoked_at = now() \
                 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            )
            .bind(sid)
            .bind(uid)
            .execute(&state.db)
            .await?
            .rows_affected()
                > 0
        }
        // sessions 表出现之前签发的令牌不带 sid，没有对应的行可以作废。这种令牌只能等
        // 30 天自然过期 —— 和它无法在设备列表里被单独登出是同一个既有限制。照实回报，
        // 不要假装作废成功。
        None => false,
    };

    if revoked {
        tracing::info!(%uid, "session revoked by logout");
    }
    // revoked=false 有两种情况：本来就已作废，或者是那种老令牌。前端不据此改变行为
    // （无论如何都要清本地并回登录页），但排查问题时这个字段能说明是哪一种。
    Ok(Json(json!({ "ok": true, "revoked": revoked, "revocable": sid.is_some() })))
}

pub async fn me(State(state): State<AppState>, claims: Claims) -> ApiResult<Json<serde_json::Value>> {
    let id = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;
    // Apply the 30-minute window refill + weekly reset so the profile shows current quota.
    // 语句本体和它为什么带 WHERE，见 quota_refresh_sql()。
    let _ = sqlx::query(&quota_refresh_sql())
        .bind(id)
        .execute(&state.db)
        .await;

    // 每日免费点的惰性发放。同样加了 WHERE：原来 `free_points_date = CURRENT_DATE` 是**无
    // 条件**赋值，所以哪怕日期没变也照写一遍——这是 /api/me 每次调用的第二条空写。
    //
    // 顺序也换了：以前是 UPDATE ... RETURNING 排在 SELECT 之后，用返回值当余额。加了
    // WHERE 之后不该发放时不会有行返回（RETURNING 给不出值），所以改成先执行、再由下面
    // 那条 SELECT 读出结果——`User` 结构体本来就有 free_points 字段，读到的是同一个值。
    let (member_grant, base_grant) = daily_grant_binds();
    let _ = sqlx::query(&format!(
        "UPDATE users SET free_points = {grant}, free_points_date = CURRENT_DATE \
         WHERE id = $1 AND free_points_date IS DISTINCT FROM CURRENT_DATE",
        // 每日赠送分两档。判据和档位选择都在 daily_grant_sql 里，四个发放点共用一份 ——
        // 漏一处的症状是那条路径上的会员静默拿回旧额度，不报错。
        // 非会员恒走 $3，也就是今天的 free_milli_points_daily()，一个字都没变。
        grant = daily_grant_sql("$2", "$3"),
    ))
    .bind(id)
    .bind(member_grant)
    .bind(base_grant)
    .execute(&state.db)
    .await;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::unauthorized("用户不存在"))?;
    // 上面那条 UPDATE 已经落盘，所以这里读到的就是今天该有的余额。
    let free_points: i64 = user.free_points;

    // 附带 michael-compression 的可用档位，客户端据此决定「本地要不要自己压」。
    // 这是**加字段**，老客户端会忽略它，不会破坏现有消费方（nginx 的 auth_request
    // 只看状态码）。
    let plan_active =
        user.plan != "none" && user.plan_expires_at.is_none_or(|e| e > chrono::Utc::now());
    // 关着的时候必须报 null，不能只是"不压缩"。客户端一旦从这里看到档位，就会
    // **关掉自己的本地压缩**（认为网关接管了）—— 只报档位却不真压，等于两边都不压，
    // 长对话直接撞穿模型原生窗口。报档位和真压缩必须由同一个开关控制。
    let tier = if state.cfg.compression_enabled {
        crate::compression::max_tier_for_plan(&user.plan, plan_active, user.credits_cents)
    } else {
        None
    };
    // （每日免费点的发放已经上移到 SELECT 之前，见那里的注释。语义不变：存的日期不是
    // 今天就把池子覆盖成今天的额度，昨天的余量永远不结转。）

    let mut body = serde_json::to_value(&user).unwrap_or_else(|_| json!({}));
    if let Some(obj) = body.as_object_mut() {
        // Stored in milli-点; exposed as fractional 点 so the client renders "39.94 点"
        // rather than a whole number that hides every sub-point call.
        obj.insert(
            "free_points".into(),
            json!(free_points as f64 / crate::models::MILLI as f64),
        );
        // 每日赠送分两档之后，这里报的必须是**这个人自己那一档**，否则会员的进度条会
        // 显示成 300%（桌面端 ide/src/main.js 的 `_freePointsMetric` 拿它当分母，
        // account-ui 的 Dashboard / Billing 显示 free_points / free_points_daily）。
        // 会员判据不在 Rust 里重写第二份 —— 由下面那条 SELECT 用 ACTIVE_MEMBER_SQL 判，
        // 和四个发放点是同一个字符串。取值因此挪到那条查询之后。
        // 免费池扣完之后会不会接着扣钱包/会员额度。客户端必须知道这一条才能把话说对：
        // 池子见底那句原来写的是「今日已用完 · 明天 0 点重置（付费模型不受影响）」——
        // 只说了付费模型不受影响，一个字都没提免费模型此刻正在扣余额。开关在服务端
        // （MICHAEL_FREE_FALLBACK_PAID），客户端猜不到，所以随资料一起下发。
        obj.insert(
            "free_fallback_to_paid".into(),
            json!(crate::models::free_fallback_to_paid()),
        );
        // 面值分母随资料一起下发。客户端与两个管理页原先各自硬编码 663，其中三处还在
        // 写路径上（管理员输入的美元由前端乘 663 变成存库的真实分），改一处不改其余就会
        // "发出去多少"和"显示多少"对不上。现在只有服务端有这个数。
        obj.insert(
            "raw_cents_per_credit_usd".into(),
            json!(crate::settings::raw_cents_per_credit_usd()),
        );
        // Fetched on its own rather than as a `User` field: see the note on the struct.
        // avatar 和「是不是有效会员」并成一条：`me` 是客户端轮询的接口，为一个布尔再开
        // 一次往返不值得，而这两件事本来就在查同一行。
        // Fetched on its own rather than as a `User` field: see the note on the struct.
        //
        // 注意：本函数上面还有一个 `plan_active`，那是**另一件事**（喂 compression 分级，
        // 判据少了 `plan <> ''`）。钱的那一侧只认 ACTIVE_MEMBER_SQL，两者不许互相替用。
        //
        // 这个布尔永不为 NULL：users.plan 是 NOT NULL DEFAULT 'none'，而 plan_expires_at
        // 为空时走的是 `IS NULL OR …` 的 TRUE 分支，所以能直接 decode 成 bool。
        let (avatar, is_member) = sqlx::query_as::<_, (Option<String>, bool)>(&format!(
            "SELECT avatar, ({ACTIVE_MEMBER_SQL}) FROM users WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or((None, false));
        obj.insert("avatar".into(), json!(avatar));
        // 进度条的分母：会员看自己那一档。查不到就按非会员报 —— 和「查不到 avatar 就报
        // null」同一个取向：宁可少报，也别给非会员报一个他根本拿不到的额度。
        obj.insert(
            "free_points_daily".into(),
            json!(if is_member {
                crate::models::free_points_daily_member()
            } else {
                crate::models::free_points_daily()
            }),
        );
        // 会员那一档**无条件**下发，与本人是不是会员无关：套餐页要用它写「开通会员每天
        // N 点」，而看那一屏的恰恰是非会员。加字段，老客户端忽略它（和 free_fallback_to_paid、
        // raw_cents_per_credit_usd 是同一类下发）。
        obj.insert(
            "free_points_daily_member".into(),
            json!(crate::models::free_points_daily_member()),
        );
        // 一个点值多少人民币分。客户端拿它把点数写成钱 —— 不发的话它只能自己写死一个
        // 数字，而那正是刚踩过的坑：客户端硬编码 ¥0.05/点，后台设定却是 ¥0.01/点
        // （100 积分 = ¥1），界面上的钱数一直比真实值大 5 倍。
        // 加字段，老客户端忽略它（和 free_fallback_to_paid / raw_cents_per_credit_usd 同一类下发）。
        obj.insert(
            "cny_cents_per_point".into(),
            json!(crate::models::CNY_CENTS_PER_POINT),
        );
        obj.insert(
            "michael_compression".into(),
            match tier {
                Some(t) => json!({ "tier": t.as_str(), "max_input_tokens": t.max_input_tokens() }),
                None => serde_json::Value::Null,
            },
        );
    }
    Ok(Json(body))
}

/// Longest name half accepted. Generous for a legal name, short enough that the column
/// can never be used as free storage.
const NAME_MAX_CHARS: usize = 64;
/// Longest `data:` URL accepted, in characters. The browser resizes to a 256px square
/// before upload (~30 KB), so this is roughly seven times what an honest client sends —
/// enough headroom for an odd encoder, far short of letting the column hold a file.
const AVATAR_MAX_CHARS: usize = 300_000;

/// Names are free text, but not *anything*: control characters would let a display name
/// break out of the line it is rendered on, and leading or trailing space is invisible
/// yet compares unequal.
fn clean_name(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::bad("姓名不能包含控制字符"));
    }
    if trimmed.chars().count() > NAME_MAX_CHARS {
        return Err(AppError::bad(format!("姓名最长 {NAME_MAX_CHARS} 个字符")));
    }
    Ok(trimmed.to_owned())
}

/// Only these three encodings, and only as a self-contained `data:` URL. An `http(s)`
/// URL would turn every profile render into a request to a third party chosen by the
/// account holder — an SSRF-shaped hole on the server and a tracking pixel on the client.
pub(crate) fn clean_avatar(raw: &str) -> Result<Option<String>, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None); // an explicit clear
    }
    if value.len() > AVATAR_MAX_CHARS {
        return Err(AppError::bad("头像过大，请换一张图片"));
    }
    const ALLOWED: [&str; 3] = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ];
    let Some(prefix) = ALLOWED.iter().find(|p| value.starts_with(**p)) else {
        return Err(AppError::bad("头像格式不支持"));
    };
    // Reject anything that is not actually base64 after the comma, so the column cannot
    // be loaded with a payload that only *looks* like an image to this check.
    let payload = &value[prefix.len()..];
    if payload.is_empty()
        || !payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
    {
        return Err(AppError::bad("头像数据无效"));
    }
    Ok(Some(value.to_owned()))
}

#[derive(Deserialize)]
pub struct ProfileReq {
    /// Absent leaves the stored value alone; present replaces it. That distinction is
    /// what lets the picture be saved without resending the names and vice versa.
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    /// A `data:` URL, or "" to remove the current picture.
    pub avatar: Option<String>,
    /// BCP-47 tag. Length-capped and character-restricted below rather than checked
    /// against a list: the list of offered languages belongs to the client.
    #[serde(default)]
    pub language: Option<String>,
}

/// `POST /api/me/profile` — the account holder edits their own display name and picture.
///
/// Scoped to the caller's own row by the token: there is no id in the path and none is
/// accepted from the body, so this endpoint cannot be aimed at another account.
pub async fn update_profile(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<ProfileReq>,
) -> ApiResult<Json<serde_json::Value>> {
    let id = uuid::Uuid::parse_str(&claims.sub).map_err(|_| AppError::unauthorized("令牌损坏"))?;

    let first = req.first_name.as_deref().map(clean_name).transpose()?;
    let last = req.last_name.as_deref().map(clean_name).transpose()?;
    // Flattened deliberately: "not sent" and "sent an explicit clear" both collapse to
    // None here, and the boolean bound to $4 below is what tells them apart.
    let avatar: Option<String> = req.avatar.as_deref().map(clean_avatar).transpose()?.flatten();
    // A tag, not free text: letters and hyphens only, and short enough that no amount of
    // it can bloat the row. Nothing here decides behaviour on the server — it is handed
    // straight back to clients — but it is still stored input, so it is bounded.
    let language: Option<String> = req.language.as_deref().map(|v| {
        v.trim()
            .chars()
            .filter(|c| c.is_ascii_alphabetic() || *c == '-')
            .take(16)
            .collect::<String>()
    });

    // COALESCE keeps the stored value when the client sent no opinion. The avatar needs
    // the extra flag because "sent nothing" and "sent an explicit clear" both arrive as
    // a SQL NULL and mean opposite things.
    sqlx::query(
        "UPDATE users SET \
           first_name = COALESCE($2, first_name), \
           last_name  = COALESCE($3, last_name), \
           avatar     = CASE WHEN $4 THEN $5 ELSE avatar END, \
           language   = COALESCE($6, language), \
           updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(first.as_deref())
    .bind(last.as_deref())
    .bind(req.avatar.is_some())
    .bind(avatar.as_deref())
    .bind(language.as_deref())
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn admin_users(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<Vec<User>>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    let users = sqlx::query_as::<_, User>("SELECT * FROM users ORDER BY created_at DESC LIMIT 500")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(users))
}

/// 「这个人现在是有效会员吗」——**全站只有这一处定义**。
///
/// 它同时被三个地方用：列表的筛选、四个统计卡片里的「有效会员」、以及前端每一行的徽章。
/// 前两个在这里（同一个常量拼进两条 SQL），第三个在 Customers.tsx 的 `isActive`。
/// 这条口径一旦分叉，症状是「筛选出 13 个，卡片写 12 个」——两边都不报错，谁也说不清哪个对。
/// 本仓库最常见的一类 bug（见 `refresh_interval_is_a_single_source_of_truth` 那条注释）。
///
/// `plan_expires_at IS NULL` 算**有效**而不是过期：那是「永久」，和前端的
/// `!u.plan_expires_at || …` 一致。
pub(crate) const ACTIVE_MEMBER_SQL: &str =
    "plan <> '' AND plan <> 'none' AND (plan_expires_at IS NULL OR plan_expires_at > now())";

/// 「今天该发多少毫点」——**全站只有这一处定义**，四个懒发放点 + /api/me 的展示分母共用。
///
/// 每日赠送分两档之后，档位选择必须和发放写在**同一条 SQL** 里：先查一次会员状态再发，
/// 中间隔着一次往返，会员刚好在这中间过期就会发错档；而多一次往返在结算路径上是每次
/// 调用都要付的成本。判据直接读 `users` 那一行的 plan / plan_expires_at，四个发放点
/// 本来就都以 uid 定位这一行，所以是零成本。
///
/// 两个参数按顺序是「会员档」「非会员档」，取值用 [`daily_grant_binds`]，别在调用处
/// 各自手写两个函数 —— 绑反了非会员会拿到会员档，而「非会员行为一个字不变」这条没有
/// 任何报错会提醒你，只能靠对账发现。
///
/// `::bigint` 不是必需的（sqlx 的 `.bind(i64)` 在 Parse 里带 INT8 的 OID，参数不是
/// unknown），但零代价且防住「将来有人把某一侧换成字面量」——留着。
pub fn daily_grant_sql(member_param: &str, base_param: &str) -> String {
    format!(
        "(CASE WHEN {ACTIVE_MEMBER_SQL} THEN {member_param}::bigint ELSE {base_param}::bigint END)"
    )
}

/// 和 [`daily_grant_sql`] 的两个参数一一对应：`(会员档, 非会员档)`，单位毫点。
///
/// 存在的唯一理由是把顺序绑死在一处：四个发放点各自 `.bind(a).bind(b)` 手写两个函数名，
/// 迟早有一处绑反，而那一处的症状是非会员拿到会员档 —— 不报错。
pub fn daily_grant_binds() -> (i64, i64) {
    (
        crate::models::free_milli_points_daily_member(),
        crate::models::free_milli_points_daily(),
    )
}

/// 一页最多多少行。上限存在的理由：`page_size` 是客户端传的，不夹住的话一条
/// `?page_size=999999` 就等于把全表拉下来，而这个接口本来就是为了**不**这么干才加的。
const CUSTOMERS_MAX_PAGE_SIZE: i64 = 200;
const CUSTOMERS_DEFAULT_PAGE_SIZE: i64 = 20;

#[derive(Deserialize)]
pub struct CustomersQuery {
    pub q: Option<String>,
    pub filter: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

/// 把用户输入变成一个 LIKE 模式，并且**转义掉通配符**。
///
/// 不转义的话，搜 `100%` 会把 `%` 当成「任意字符」，搜出全表；搜 `a_b` 会匹配 `axb`。
/// 用户在搜索框里打的是字面量，不是模式。Postgres 的 LIKE 默认转义符就是反斜杠，
/// 所以反斜杠自己也要先转义，且必须**排在最前**——否则后面补的那些反斜杠会被再转一次。
fn like_pattern(raw: &str) -> String {
    let escaped = raw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// 页码从 1 起。0、负数、超大值都夹回合法区间，而不是报错——分页控件不该因为
/// 一个坏参数就把整屏变成错误页。
fn clamp_page(raw: Option<i64>) -> i64 {
    raw.unwrap_or(1).max(1)
}

fn clamp_page_size(raw: Option<i64>) -> i64 {
    raw.unwrap_or(CUSTOMERS_DEFAULT_PAGE_SIZE)
        .clamp(1, CUSTOMERS_MAX_PAGE_SIZE)
}

/// 列表的 WHERE。`$1` = 搜索模式（NULL 表示不搜），`$2` = 筛选项（NULL 表示全部）。
///
/// 筛选项走的是**绑定参数里的等值比较**，不是把字符串拼进 SQL。看着绕，但这一段是
/// 唯一一处让用户输入影响 SQL 结构的地方，拼字符串就等于开了注入的门。
fn customers_where() -> String {
    format!(
        "WHERE ($1::text IS NULL OR email ILIKE $1 OR role ILIKE $1 OR plan ILIKE $1 OR id::text ILIKE $1) \
           AND ($2::text IS NULL OR ( \
                 ($2 = 'member' AND ({active})) \
              OR ($2 = 'none'   AND NOT ({active})) \
              OR ($2 = 'admin'  AND role = 'admin') \
              OR ($2 NOT IN ('member', 'none', 'admin') AND plan = $2) \
           ))",
        active = ACTIVE_MEMBER_SQL,
    )
}

/// GET /api/admin/customers —— 按页取客户，带搜索、筛选和全量统计。
///
/// # 为什么不是给 `/api/admin/users` 加参数
///
/// 那个接口还有第二个消费者：总览页的套餐分布和注册趋势两张图，要的是「最近 500 位的
/// 完整名单」而不是某一页。两件事的正确答案不一样，塞进一个接口就得靠参数分叉，
/// 于是每个调用点都要知道另一个调用点想要什么。
///
/// # 为什么搜索和筛选必须跟着一起搬到服务端
///
/// 分页之后客户端手里只有当页那 20 行。搜索还留在前端就变成「在这 20 行里搜」——
/// 那不是搜索，是骗人。之前没这个问题，只是因为前端一次就把（最多 500 行的）全量拿在手里。
///
/// # 四个统计卡片算的是全量
///
/// 它们走一条**独立的聚合**，和上面的 WHERE 无关：卡片回答的是「这盘生意现在什么样」，
/// 不是「你当前筛出来的这堆什么样」。这也是改动前的语义（前端从未筛选的 `users` 上数），
/// 搬过来时保持不变。
pub async fn admin_customers(
    State(state): State<AppState>,
    claims: Claims,
    Query(qs): Query<CustomersQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }

    let pattern = qs
        .q
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(like_pattern);
    let filter = qs
        .filter
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let page_size = clamp_page_size(qs.page_size);
    let page = clamp_page(qs.page);

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM users {}",
        customers_where()
    ))
    .bind(pattern.as_deref())
    .bind(filter.as_deref())
    .fetch_one(&state.db)
    .await?;

    // 页码可能落在末页之后（筛选变窄、或别人刚删了人）。夹回最后一页，而不是回一页空表——
    // 空表看着像「没有这个人」，那是另一件事。
    let pages = ((total + page_size - 1) / page_size).max(1);
    let page = page.min(pages);

    // 排序补一个 id：只按 created_at 排的话，同一秒注册的几行在两次查询之间顺序可以变，
    // 于是翻页会**重复或漏掉**行——行数越多越明显，也最难被发现。
    let users = sqlx::query_as::<_, User>(&format!(
        "SELECT * FROM users {} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4",
        customers_where()
    ))
    .bind(pattern.as_deref())
    .bind(filter.as_deref())
    .bind(page_size)
    .bind((page - 1) * page_size)
    .fetch_all(&state.db)
    .await?;

    // `drained` 要和前端 windowUse() 逐字对齐：存的是「本时段还剩多少」，
    // left = clamp(quota_window_cents, 0, cap)，cap > 0 时 left <= 0 等价于原值 <= 0。
    let stats = sqlx::query_as::<_, (i64, i64, i64, i64)>(&format!(
        "SELECT count(*), \
                count(*) FILTER (WHERE {active}), \
                count(*) FILTER (WHERE quota_window_cap_cents > 0 AND quota_window_cents <= 0), \
                count(*) FILTER (WHERE last_login_at > now() - interval '7 days') \
         FROM users",
        active = ACTIVE_MEMBER_SQL,
    ))
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "users": users,
        "total": total,
        "page": page,
        "page_size": page_size,
        "stats": {
            "total": stats.0,
            "members": stats.1,
            "drained": stats.2,
            "recent": stats.3,
        },
    })))
}

#[derive(Deserialize)]
pub struct SetRoleReq {
    pub role: String,
}

/// POST /api/admin/users/:id/role  { role: "admin"|"user" } — admin only.
pub async fn set_user_role(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<SetRoleReq>,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    if req.role != "admin" && req.role != "user" {
        return Err(AppError::bad("角色只能是 admin 或 user"));
    }
    if claims.sub == id.to_string() {
        return Err(AppError::bad("不能修改自己的角色"));
    }
    let res = sqlx::query("UPDATE users SET role = $1, updated_at = now() WHERE id = $2")
        .bind(&req.role)
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::bad("用户不存在"));
    }
    crate::realtime::record_event(&state, Some(id), "role_change", json!({ "role": req.role }))
        .await;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/admin/users/:id — admin only.
pub async fn delete_user(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    if claims.sub == id.to_string() {
        return Err(AppError::bad("不能删除自己"));
    }
    let res = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::bad("用户不存在"));
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod password_reset_tests {
    /// 「忘记密码」这条路的不变式，守在源码上（这里没有 DB / Redis 的集成台，和本文件
    /// 其它守卫一个做法）。
    #[test]
    fn reset_route_is_registered() {
        let main_src = include_str!("main.rs");
        assert!(
            main_src.contains(".route(\"/api/auth/reset-password\", post(auth::reset_password))"),
            "reset-password 没挂到路由表——功能写了等于没写",
        );
    }

    #[test]
    fn reset_checks_the_account_before_burning_the_code_and_revokes_other_sessions() {
        let src = include_str!("auth.rs");
        let at = src.find("\npub async fn reset_password(").expect("reset_password 改名了");
        let end = src[at + 1..]
            .find("\npub async fn ")
            .map(|i| at + 1 + i)
            .unwrap_or(src.len());
        let body = &src[at..end];
        let find_at = body.find("find_user(").expect("必须先查账号");
        let take_at = body.find("take_code(").expect("必须消费验证码");
        assert!(
            find_at < take_at,
            "先消费验证码再查账号：账号不存在也把重试者的码烧掉了（register 踩过同一个坑）",
        );
        assert!(
            body.contains("bcrypt::hash(&req.password, bcrypt::DEFAULT_COST)"),
            "散列成本要和注册一致",
        );
        assert!(
            body.contains("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL"),
            "换密码没有作废其它设备的登录——丢了设备的人换完密码，旧令牌还能用 30 天",
        );
        assert!(body.contains("start_session("), "重置完要当场登录，否则用户还得再输一遍");
        assert!(body.contains("req.password.len() < 6"), "密码下限要和注册一致");
        assert!(body.contains("\"password_reset\""), "要进事件流，管理台才看得到");
    }

    /// 两个登录入口都要有「忘记密码」：网页登录页、桌面端登录框。缺一个，那个入口上的人
    /// 就只能找管理员——这条路存在的全部理由。
    #[test]
    fn every_sign_in_surface_offers_the_reset_path() {
        let gate = include_str!("../../ide/gate/gate.html");
        assert!(gate.contains("/api/auth/reset-password"), "网页登录页没有接重置接口");
        assert!(gate.contains("id=\"resetForm\""), "网页登录页没有重置表单");
        let shell = include_str!("../../ide/src/app/Shell.jsx");
        assert!(shell.contains("id=\"loginForgotBtn\""), "桌面端登录框没有「忘记密码」入口");
        let main_js = include_str!("../../ide/src/main.js");
        assert!(
            main_js.contains("_michaelAuth(\"reset-password\""),
            "桌面端没有调用重置接口",
        );
    }
}

#[cfg(test)]
mod customers_page_tests {
    use super::{
        clamp_page, clamp_page_size, customers_where, like_pattern, ACTIVE_MEMBER_SQL,
        CUSTOMERS_MAX_PAGE_SIZE,
    };

    /// 搜索框里打的是**字面量**，不是 LIKE 模式。
    ///
    /// 不转义的话，搜 `100%` 里的 `%` 会当成「任意字符」——一个套餐名都没打完就搜出全表；
    /// 搜 `a_b` 会连 `axb` 一起匹配。两种都不报错，只是结果多得莫名其妙。
    #[test]
    fn a_wildcard_typed_by_a_human_is_matched_literally() {
        assert_eq!(like_pattern("abc"), "%abc%");
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        // 反斜杠必须**先**转义。顺序反了的话，为 `%` 补的那个反斜杠会被再转一次，
        // 于是 `\%` 变成 `\\%`：反斜杠自己被转义了，`%` 反而重新变回通配符。
        assert_eq!(like_pattern("a\\%b"), "%a\\\\\\%b%");
    }

    /// 页大小是客户端传的，不夹住的话一条 `?page_size=999999` 就等于把全表拉下来 ——
    /// 而这个接口本来就是为了**不**这么干才加的。
    #[test]
    fn a_client_cannot_ask_for_the_whole_table_in_one_page() {
        assert_eq!(clamp_page_size(Some(999_999)), CUSTOMERS_MAX_PAGE_SIZE);
        assert_eq!(clamp_page_size(Some(0)), 1);
        assert_eq!(clamp_page_size(Some(-5)), 1);
        assert_eq!(clamp_page_size(Some(20)), 20);
        assert_eq!(clamp_page_size(None), super::CUSTOMERS_DEFAULT_PAGE_SIZE);
        // 页码同理：坏参数夹回合法值，不是把整屏变成错误页。
        assert_eq!(clamp_page(Some(0)), 1);
        assert_eq!(clamp_page(Some(-3)), 1);
        assert_eq!(clamp_page(None), 1);
        assert_eq!(clamp_page(Some(7)), 7);
    }

    /// 筛选项是用户传的字符串，**只能**作为绑定参数参与等值比较，不许拼进 SQL。
    ///
    /// 这是整条查询里唯一一处让用户输入影响 SQL 结构的地方。写成拼接会短几行，
    /// 也就同时开了注入的门。
    #[test]
    fn the_filter_never_reaches_the_sql_as_text() {
        let w = customers_where();
        assert!(w.contains("$2::text IS NULL"), "筛选项没走绑定参数：{w}");
        assert!(w.contains("$1::text IS NULL"), "搜索词没走绑定参数：{w}");
        // format! 只拼了 ACTIVE_MEMBER_SQL 这一个常量进去，别的占位符一个都不该有。
        assert!(!w.contains('{'), "WHERE 里还有没替换掉的占位符：{w}");
    }

    /// 「有效会员」这条口径全站只能有一处。
    ///
    /// 它同时被三个地方用：列表筛选（`filter=member`）、统计卡片里的「有效会员」、
    /// 以及前端每一行的徽章。前两个都在服务端，靠同一个常量拼进两条 SQL；
    /// 分叉的症状是「筛出来 13 个，卡片写 12 个」——两边都不报错，谁也说不清哪个对。
    #[test]
    fn active_membership_has_exactly_one_definition() {
        // 列表那侧：member 和 none 是同一个判据的正反面，所以要出现两次。
        assert_eq!(
            customers_where().matches(ACTIVE_MEMBER_SQL).count(),
            2,
            "member / none 两个分支必须共用同一条判据",
        );
        // 统计那侧：从 handler 的源文本里取，确认它也没有自己另写一份。
        let src = include_str!("auth.rs");
        let at = src
            .find("\npub async fn admin_customers(")
            .expect("admin_customers 改名了 —— 这条测试守的是它的 SQL");
        let end = src[at + 1..]
            .find("\n#[derive(")
            .map(|i| at + 1 + i)
            .unwrap_or(src.len());
        let body = &src[at..end];
        assert!(
            !body.contains("fn active_membership_has_exactly_one_definition"),
            "切片切进测试模块了，下面的断言会匹配到自己写的字面量",
        );
        assert!(
            body.contains("count(*) FILTER (WHERE {active})"),
            "统计里的「有效会员」没有引用同一个常量，口径会漂",
        );
        // 「时段额度用尽」要和前端 windowUse() 对齐：cap > 0 且本时段剩余 <= 0。
        assert!(
            body.contains("quota_window_cap_cents > 0 AND quota_window_cents <= 0"),
            "「用尽」的判据变了，和前端那条会对不上",
        );
        // 翻页要有稳定全序。只按 created_at 排的话，同一秒注册的几行在两次查询之间
        // 顺序可以变，于是翻页**重复或漏掉**行 —— 行数越多越明显，也最难被发现。
        assert!(
            body.contains("ORDER BY created_at DESC, id DESC"),
            "排序少了 id 这个 tiebreaker，翻页会重复或漏行",
        );
        // 每日赠送分两档之后，四个懒发放点都要判会员。它们必须调 daily_grant_sql，不许
        // 各自往 SQL 里抄一份判据 —— 抄了不报错，只会让某条路径上的会员拿错档，而这
        // 四条语句形状还不一样（一条在 SET 里、一条在外层 CASE 的 THEN 里、两条在 CTE 里），
        // 最容易漏。这条断言扫的是 models.rs，而它自己写在 auth.rs 里，不会匹配到自身。
        let models = include_str!("models.rs");
        // 四个：free_points_balance / spend_free_points / try_spend_free_points /
        // spend_free_points_draining（按量计费免费模型的抽干扣点）。
        assert_eq!(
            models.matches("crate::auth::daily_grant_sql(").count(),
            4,
            "models.rs 里的四个发放点没有全部共用同一条会员判据",
        );
        assert!(
            !models.contains("plan_expires_at > now()"),
            "models.rs 又自己写了一份会员判据 —— 口径会漂，而且不报错",
        );
        // /api/me 那一处。锚到下一个具名项切片，切不到就 expect 报错；固定行数的窗口会在
        // 函数变长时静默失效，仍然是绿的。
        let me_at = src.find("\npub async fn me(").expect("me 改名了");
        let me_end = src[me_at + 1..]
            .find("\nconst NAME_MAX_CHARS")
            .map(|i| me_at + 1 + i)
            .expect("me 后面那个锚点没了 —— 切片会一路吃到测试模块，断言就恒真了");
        let me_body = &src[me_at..me_end];
        assert!(
            me_body.contains("daily_grant_sql("),
            "/api/me 的每日发放没走同一条会员判据",
        );
        assert!(
            me_body.contains("free_points_daily_member()"),
            "/api/me 报的分母又变回全局那一档了 —— 会员的进度条会显示成 300%",
        );
    }

    /// 分页之后，搜索和统计**必须**留在服务端。
    ///
    /// 客户端手里只有当页那 20 行。在这 20 行里再筛一遍不是筛选，是骗人；
    /// 在这 20 行上数「有效会员」也一样，翻一页数字就变。
    /// 改动前没这个问题，只是因为前端一次就把（最多 500 行的）全量拿在手里。
    #[test]
    fn the_console_does_not_recount_or_refilter_a_single_page() {
        let ui = include_str!("../admin-ui/src/pages/Customers.tsx");
        assert!(
            ui.contains("/api/admin/customers?"),
            "列表没走分页接口",
        );
        for gone in [
            "users.filter(isActive).length",
            "const kw = q.trim().toLowerCase();",
        ] {
            assert!(!ui.contains(gone), "前端还在自己数/自己筛：{gone}");
        }
        assert!(ui.contains("stats.members"), "统计卡片没读服务端的数");
        // 前端的每页行数超过服务端上限会被夹住，页数就算错了 —— 分页控件说有 5 页，
        // 实际翻到第 3 页就没了。页大小现在是四张表共用的（components/Pager.tsx），
        // 所以从那里读：这条断言因此同时守住了另外三张表。
        let pager = include_str!("../admin-ui/src/components/Pager.tsx");
        let ps: i64 = pager
            .split("export const PAGE_SIZE = ")
            .nth(1)
            .and_then(|t| t.split(';').next())
            .and_then(|t| t.trim().parse().ok())
            .expect("Pager.tsx 里找不到 PAGE_SIZE");
        assert!(
            ui.contains("PAGE_SIZE") && ui.contains("@/components/Pager"),
            "客户页没在用共享的分页组件了，这条上限断言就守不到它",
        );
        assert!(
            ps >= 1 && ps <= CUSTOMERS_MAX_PAGE_SIZE,
            "前端每页 {ps} 行，超出服务端上限 {CUSTOMERS_MAX_PAGE_SIZE}",
        );
    }
}

#[cfg(test)]
mod quota_window_tests {
    use super::QUOTA_WINDOW_REFRESH;

    /// 窗口回满间隔必须只有一个源。2026-08-18 从 5.5 小时改 30 分钟时，它散在 7 条 SQL 里
    /// （auth / codes / models 三个文件），漏改一条就会出现"有的账号 30 分钟刷、有的还是
    /// 5.5 小时"这种谁都查不明白的 bug——本仓库最常见的一类。抽成常量之后，这条钉住它。
    #[test]
    fn refresh_interval_is_a_single_source_of_truth() {
        assert_eq!(QUOTA_WINDOW_REFRESH, "30 minutes");
        // 必须是合法的 PostgreSQL interval 字面量（数字 + 单位），别写成 "30min" 之类。
        assert!(
            QUOTA_WINDOW_REFRESH.contains("minute")
                || QUOTA_WINDOW_REFRESH.contains("hour")
                || QUOTA_WINDOW_REFRESH.contains("day"),
            "不是合法的 interval 单位：{QUOTA_WINDOW_REFRESH}"
        );
    }

    /// 回满语句只能有一份，而且必须带 WHERE 闸。
    ///
    /// 抓的是一个真实存在过的形状：同一条 UPDATE 在 /api/me、chat、image、audio 四处各抄
    /// 了一份逐字相同的副本。2026-08-22 给它加 WHERE 闸时四处都要改——只改一处就会出现
    /// 「网页上余额刷新了、发消息时没刷」这种分歧，而类型检查和现有测试都抓不到。
    ///
    /// 断言的是「连接」不是「实现」：语句怎么写随便改，但 (a) 原始 SQL 片段在整个
    /// server/src 里只能出现一次（就在 quota_refresh_sql 里），(b) 那一份必须带 WHERE。
    #[test]
    fn quota_refresh_statement_has_exactly_one_home_and_keeps_its_guard() {
        // 用 concat! 拆开：否则这段断言自己的字面量会被 include_str! 数进去。
        let fragment = concat!("quota_window_cents", " = CASE WHEN");

        let auth_src = include_str!("auth.rs");
        assert_eq!(
            auth_src.matches(fragment).count(),
            1,
            "auth.rs 里出现了不止一份回满语句——它只应该活在 quota_refresh_sql() 里",
        );
        for (name, src) in [
            ("models.rs", include_str!("models.rs") as &str),
            ("codes.rs", include_str!("codes.rs")),
            ("settings.rs", include_str!("settings.rs")),
        ] {
            assert_eq!(
                src.matches(fragment).count(),
                0,
                "{name} 里又抄了一份回满语句。改调 crate::auth::quota_refresh_sql()——\
                 四份副本各自漂移正是这条测试要挡的那个 bug",
            );
        }

        // WHERE 闸本身。没有它，这条语句在绝大多数调用上都是空写，而 Postgres 照样写
        // 新元组 + WAL：线上 171 行的 users 表因此累计了 64.7 万次更新、9,244 次自动
        // ANALYZE，以及 22GB WAL 里约 20GB 的整页镜像。
        let sql = super::quota_refresh_sql();
        let where_pos = sql.find("WHERE id = $1").expect("必须按 id 定位");
        let guard = &sql[where_pos..];
        assert!(
            guard.contains("quota_window_reset_at <= now()")
                && guard.contains("quota_week_reset_at <= now()"),
            "WHERE 闸被拿掉或只剩一半了：两个到期条件都要在，否则要么退化成每次空写、\
             要么该刷的那一半刷不到。当前语句尾部：{guard}",
        );
    }
}

#[cfg(test)]
mod privilege_source_tests {
    /// Guard rail, not a behavioural test: the `Claims` extractor must keep reading
    /// `role` from the database instead of trusting the JWT claim.
    ///
    /// All 13 admin gates are `claims.role != "admin"`. When role came from the token,
    /// a 30-day JWT kept working after its owner was demoted or deleted, and because
    /// the admin endpoints can re-grant the role, one surviving token could take it
    /// back for good. There is no integration harness for the extractor here, so this
    /// asserts on the source: if someone "optimizes away" the lookup to save a query,
    /// this fails and explains why it exists.
    #[test]
    fn a_device_id_is_bounded_and_stripped() {
        use super::clean_device_id;

        assert_eq!(clean_device_id(Some("9f3a-4b1c_d2")), "9f3a-4b1c_d2");
        assert_eq!(clean_device_id(None), "");
        assert_eq!(clean_device_id(Some("   ")), "");
        // Anything that is not id-shaped is dropped rather than rejected: the value is
        // compared for equality and nothing else, so a client sending junk just gets a
        // group of its own instead of an error it cannot act on.
        assert_eq!(clean_device_id(Some("a'; DROP TABLE sessions; --")), "aDROPTABLEsessions--");
        assert_eq!(clean_device_id(Some(&"x".repeat(500))).len(), 64);
    }

    /// Signing in twice on one device must leave one live session, not two.
    ///
    /// This is the whole reason the column exists: the console showed the same laptop
    /// three times because three sign-ins wrote three rows and every token still worked.
    /// Hiding the duplicates at display time would not have been enough — the older
    /// tokens have to actually stop working — so the revoke has to happen here, before
    /// the insert, and it has to be scoped to this account.
    #[test]
    fn signing_in_again_on_a_device_replaces_that_devices_session() {
        let src = include_str!("auth.rs");
        let body = src
            .split("async fn start_session")
            .nth(1)
            .expect("start_session");
        let body = &body[..body.find("\nfn issue_token").unwrap_or(body.len())];
        let revoke = body
            .find("UPDATE sessions SET revoked_at")
            .expect("a prior session on the same device must be revoked");
        let insert = body.find("INSERT INTO sessions").expect("the new session row");
        assert!(revoke < insert, "the revoke has to run before the insert");
        assert!(
            body[revoke..insert].contains("user_id = $1") && body[revoke..insert].contains("device_id = $2"),
            "scoped to this account and this device, or a shared computer signs someone else out"
        );
        assert!(
            body.contains("if !device_id.is_empty()"),
            "an absent id must not match every legacy row and revoke them all"
        );
    }

    #[test]
    fn claims_extractor_resolves_role_from_the_database() {
        let src = include_str!("auth.rs");
        let extractor = src
            .split("impl FromRequestParts<AppState> for Claims")
            .nth(1)
            .expect("Claims extractor impl");
        let extractor = &extractor[..extractor.find("\nfn issue_token").unwrap_or(extractor.len())];
        assert!(
            extractor.contains("SELECT u.role")
                && extractor.contains("FROM users u WHERE u.id = $1")
                && extractor.contains("claims.role = role"),
            "the extractor must re-read role from the users row, never trust the JWT claim"
        );
        assert!(
            extractor.contains("账号不存在或已注销"),
            "a deleted user's surviving token must fail closed"
        );
    }
}


#[cfg(test)]
mod authz_gate_tests {
    /// 门禁端点必须是**只读**的。
    ///
    /// nginx 的 `auth_request` 对每个受保护请求触发一次 —— 包括 `/app/` 和 `/account/`
    /// 下的每个静态资源。它原来打的是 `/api/me`，而 `/api/me` 每次跑两条 UPDATE
    /// （配额窗口刷新 + 每日免费点发放）。线上 users 表 120 行累计 362,059 次 UPDATE，
    /// 远超 model_usage 的 78,086 行 —— 写入的主体不是计费，是这道门禁。
    ///
    /// 这条测试盯住两件事：`authz` 自己不能写，且 nginx 不能再指回 /api/me。
    ///
    /// 边界靠花括号配对，不靠"下一个函数是谁"。原来是从 `pub async fn authz(` 一路切到
    /// `\npub async fn me(`，注释还写着"me 紧随其后"—— 直到 `logout` 插在这两者之间：
    /// 切片里于是多出 logout 那条完全合法的 `UPDATE sessions SET revoked_at`，测试红了，
    /// 而 authz 本身自始至终只有三行、零写入。守卫报了假警，被守的代码没有任何问题。
    #[test]
    fn authz_endpoint_performs_no_writes() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/auth.rs"))
            .expect("read auth.rs");
        let start = src.find("pub async fn authz(").expect("authz 必须存在");
        let open = start + src[start..].find('{').expect("authz 必须有函数体");
        let mut depth = 0usize;
        let mut end = None;
        for (offset, ch) in src[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + offset + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[start..end.expect("authz 的花括号必须配平")];
        for write in ["UPDATE ", "INSERT ", "DELETE ", "sqlx::query"] {
            assert!(
                !body.contains(write),
                "authz 里出现了 `{write}` —— 它每个静态资源都会跑一次，必须保持零写入",
            );
        }
    }

    #[test]
    fn nginx_app_gate_points_at_the_readonly_endpoint() {
        let conf = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/nginx/michael-backend.conf"
        ))
        .expect("read nginx conf");
        let start = conf.find("location = /_app_authz").expect("门禁 location 必须在");
        // 按**字符**截取，不按字节：这个文件里有中文注释，`&conf[a..a+400]` 一旦落在
        // 多字节字符中间就会 panic（第一版就是这么挂的，而配置本身是对的）。
        let block: String = conf[start..].chars().take(400).collect();
        let block = block.as_str();
        assert!(
            block.contains("/api/authz"),
            "/_app_authz 必须打只读的 /api/authz",
        );
        assert!(
            !block.contains("proxy_pass http://127.0.0.1:8080/api/me"),
            "/_app_authz 不能再打 /api/me —— 那会让每个静态资源触发两条 UPDATE",
        );
    }

    /// 调用方的上限必须在受害者的配额之前检查。
    ///
    /// 顺序反了的后果不是「限流不准」，是一个可以拿来封别人账号的工具：被 IP 上限挡掉、
    /// 一封信都没发的请求，照样会把目标邮箱当天的发送次数扣掉一次。一个 IP 每个地址打
    /// 12 下，就能把任意多个人的验证码登录路径封死，而它自己什么都没寄出去。
    #[test]
    fn the_caller_ceiling_is_checked_before_the_victims_quota() {
        let src = include_str!("auth.rs");
        let body = &src[..src.find("\n#[cfg(test)]").unwrap_or(src.len())];
        let f = body.split("pub async fn send_code(").nth(1).expect("send_code");
        // 匹配真正的调用形式，不是裸键名 —— 上面那段注释里就提到了键名，只找名字会命中注释。
        let ip_at = f
            .find(r#"bump_fixed_window(&mut conn, &format!("code_send_ip:"#)
            .expect("per-IP counter");
        let email_at = f
            .find(r#"bump_fixed_window(&mut conn, &format!("code_send_d:"#)
            .expect("per-email counter");
        assert!(
            ip_at < email_at,
            "per-IP 的计数与判定必须排在 per-email 之前，否则越限的请求仍在消耗受害者配额",
        );
        // 两个上限都要真的判，不能只计数不拦。
        assert!(f.contains("per_ip > CODE_SENDS_PER_IP_PER_HOUR"));
        assert!(f.contains("per_email > CODE_SENDS_PER_EMAIL_PER_DAY"));
    }
}
