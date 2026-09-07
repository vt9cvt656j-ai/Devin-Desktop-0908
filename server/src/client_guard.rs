//! 客户端指纹验证 + 请求时效性检查。
//!
//! **指纹验证只对聊天类昂贵端点强制**——这些端点是反代/逆向攻击的主目标，
//! 而且客户端的请求组装代码集中在少数几个函数里，可以确保带头。
//!
//! 其他 API 端点（/api/me、/api/desktop/heartbeat 等）靠 JWT/API key 认证
//! 保护，不要求指纹头——客户端散布在几十个 fetch 调用里，逐个加头不现实。
//!
//! 请求时效性校验在所有端点上生效（带了 x-req-ts 就校验，不带不拦）。

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;

/// 客户端标识头
const H_CLIENT_ID: &str = "x-mide-client";
/// 请求时间戳头（毫秒）
const H_REQ_TS: &str = "x-req-ts";
/// MSE 会话头（有这个头说明走了 MSE，时效性由 MSE 层校验）
const H_MSE_SID: &str = "x-mse-sid";

/// 合法客户端标识前缀
const VALID_CLIENT_PREFIXES: &[&str] = &[
    "mide/",          // 桌面端 Michael IDE
    "mide-web/",      // 网页版
    "mide-mobile/",   // 移动端（预留）
];

/// 时间戳最大偏差（毫秒）——5 分钟
const MAX_TS_SKEW_MS: i64 = 5 * 60 * 1000;

/// 需要强制指纹验证的路径——只对最昂贵、最容易被反代的聊天端点
fn requires_fingerprint(path: &str) -> bool {
    path.starts_with("/api/models/") && path.ends_with("/chat")
}

/// 完全不做任何检查的路径
fn is_exempt(path: &str) -> bool {
    path == "/"
        || path.starts_with("/health")
        || path == "/api/logo.png"
        || path == "/ws"
        || path.starts_with("/api/crypto/")
}

fn guard_response(msg: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        [("content-type", "application/json")],
        format!(r#"{{"error":"client_rejected","message":"{msg}"}}"#),
    )
        .into_response()
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub async fn middleware(
    State(_st): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    if is_exempt(&path) {
        return next.run(req).await;
    }

    let headers = req.headers();
    let has_mse = headers.get(H_MSE_SID).is_some();

    // ── 1. 指纹验证（仅聊天端点 + 非 MSE） ──
    if requires_fingerprint(&path) && !has_mse {
        match headers.get(H_CLIENT_ID).and_then(|v| v.to_str().ok()) {
            Some(cid) => {
                if !VALID_CLIENT_PREFIXES.iter().any(|p| cid.starts_with(p)) {
                    tracing::warn!(
                        client_id = %cid, path = %path,
                        "[client_guard] 非法客户端标识"
                    );
                    return guard_response("客户端版本不受支持");
                }
            }
            None => {
                tracing::warn!(path = %path, "[client_guard] 聊天端点缺少客户端标识头");
                return guard_response("缺少客户端标识");
            }
        }
    }

    // ── 2. 请求时效性检查（所有端点，带了就校验） ──
    if let Some(ts_val) = headers.get(H_REQ_TS).and_then(|v| v.to_str().ok()) {
        if let Ok(ts) = ts_val.parse::<i64>() {
            let now = unix_millis();
            let skew = (now - ts).abs();
            if skew > MAX_TS_SKEW_MS {
                tracing::warn!(
                    skew_ms = skew, path = %path,
                    "[client_guard] 请求时间戳偏差过大"
                );
                return guard_response("请求已过期");
            }
        }
    }

    next.run(req).await
}
