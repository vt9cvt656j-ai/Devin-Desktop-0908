//! 网关级速率限制中间件。
//!
//! 固定窗口计数器，按 IP + 按认证用户双层限制。
//! 存 Redis，TTL 自动回收，fail-open（Redis 挂了不拦请求）。

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::AppState;

/// 每 IP 每分钟最大请求数（未认证请求——IDE 启动时会密集调 /api/me 等十几个端点）
const IP_RPM_ANON: i64 = 120;
/// 每 IP 每分钟最大请求数（已认证——宽松一些，有用户维度兜底）
const IP_RPM_AUTHED: i64 = 300;
/// 每用户每分钟最大请求数（所有端点合计）
const USER_RPM: i64 = 60;
/// 每用户每分钟最大聊天请求数（/chat, /chat/completions, /responses 等昂贵端点）
const USER_CHAT_RPM: i64 = 30;
/// 窗口大小（秒）
const WINDOW_SECS: u64 = 60;

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

fn is_chat_path(path: &str) -> bool {
    path.contains("/chat") || path.starts_with("/v1/responses") || path == "/responses"
}

/// 固定窗口计数。Redis 挂了返回 0（fail-open）。
async fn bump(redis: &mut redis::aio::ConnectionManager, key: &str, window: u64) -> i64 {
    let n: i64 = redis::cmd("INCR")
        .arg(key)
        .query_async(redis)
        .await
        .unwrap_or(0);
    if n == 1 {
        let _: Result<(), redis::RedisError> = redis::cmd("EXPIRE")
            .arg(key)
            .arg(window)
            .query_async(redis)
            .await;
    }
    n
}

fn rate_response(retry_after: u64) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            ("retry-after", retry_after.to_string()),
            ("content-type", "application/json".to_string()),
        ],
        r#"{"error":"rate_limited","message":"请求过于频繁，请稍后重试"}"#,
    )
        .into_response()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 从 Authorization header 提取用户标识（只用于限流分桶，不做鉴权）。
fn extract_user_hint(headers: &axum::http::HeaderMap) -> Option<String> {
    let auth = headers.get(axum::http::header::AUTHORIZATION)?;
    let s = auth.to_str().ok()?;
    let token = s.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        return None;
    }
    let hash = Sha256::digest(token.as_bytes());
    Some(format!("u:{}", to_hex(&hash[..16])))
}

pub async fn middleware(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path().to_string();

    if path.starts_with("/health")
        || path.starts_with("/api/crypto/")
        || path.starts_with("/api/auth/")
        || path == "/"
        || path == "/api/logo.png"
        || path == "/ws"
    {
        return next.run(req).await;
    }

    let ip = client_ip(&headers);
    let user_hint = extract_user_hint(&headers);
    let chat = is_chat_path(&path);
    let mut redis = st.redis.clone();
    let minute = epoch_minute();

    // ── 1. IP 维度 ──
    let ip_limit = if user_hint.is_some() {
        IP_RPM_AUTHED
    } else {
        IP_RPM_ANON
    };
    let ip_key = format!("rl:ip:{ip}:{minute}");
    let ip_count = bump(&mut redis, &ip_key, WINDOW_SECS).await;
    if ip_count > ip_limit {
        tracing::warn!(ip = %ip, count = ip_count, limit = ip_limit, "[rate_guard] IP 限速");
        return rate_response(WINDOW_SECS);
    }

    // ── 2. 用户维度（仅当能识别用户时） ──
    if let Some(ref uid) = user_hint {
        let user_key = format!("rl:usr:{uid}:{minute}");
        let user_count = bump(&mut redis, &user_key, WINDOW_SECS).await;
        let limit = if chat { USER_CHAT_RPM } else { USER_RPM };
        if user_count > limit {
            tracing::warn!(
                user = %uid, count = user_count, limit = limit, path = %path,
                "[rate_guard] 用户限速"
            );
            return rate_response(WINDOW_SECS);
        }
    }

    next.run(req).await
}

fn epoch_minute() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 60
}
