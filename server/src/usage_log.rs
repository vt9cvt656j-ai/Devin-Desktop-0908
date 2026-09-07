//! 请求级溯源日志（计划 §3.8 / M4）。
//!
//! 和 `model_usage` 分开：那张表在结算事务里、外键钉死、**没有失败行**。这里记的是
//! 一次请求的结局——成功、上游报错、卡死——写失败必须静默，绝不进结算事务。
//!
//! 写入全部 `tokio::spawn`：观测失败不能让用户多等一毫秒。列对齐
//! `migrations/20260907_usage_log.sql`。

use uuid::Uuid;

use crate::AppState;

const MAX_DETAIL: usize = 400;

/// 一次请求的观测快照。所有 UUID 都是快照，不带外键。
pub struct Event {
    pub kind: &'static str,
    pub user_id: Option<Uuid>,
    pub api_key_id: Option<Uuid>,
    pub route_id: Option<Uuid>,
    pub endpoint_id: Option<Uuid>,
    pub model_name: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub latency_ms: Option<i32>,
    pub http_status: Option<i32>,
    pub err_class: Option<String>,
    pub err_detail: Option<String>,
    pub cost_micro_usd: i64,
    pub cost_cny_micro: i64,
}

/// HTTP 状态 → 文档要的 err_class。
pub fn class_for_status(status: u16, stall: bool) -> &'static str {
    if stall {
        return "timeout";
    }
    match status {
        401 | 403 => "auth",
        402 => "balance",
        408 | 504 => "timeout",
        429 => "upstream_4xx",
        400..=499 => "upstream_4xx",
        500..=599 => "upstream_5xx",
        _ => "upstream_5xx",
    }
}

fn clip(raw: &str) -> String {
    raw.chars().take(MAX_DETAIL).collect()
}

/// 火后不管。写不进去只少一行日志，不影响计费、不影响派单。
pub fn spawn(state: &AppState, ev: Event) {
    if ev.model_name.trim().is_empty() {
        return;
    }
    if ev.kind != "ok" && ev.kind != "fail" && ev.kind != "stall" {
        return;
    }
    let st = state.clone();
    tokio::spawn(async move {
        let detail = ev.err_detail.as_deref().map(clip);
        let _ = sqlx::query(
            "INSERT INTO usage_log (\
                kind, user_id, api_key_id, route_id, endpoint_id, group_id, model_name, \
                prompt_tokens, completion_tokens, cached_tokens, latency_ms, http_status, \
                err_class, err_detail, cost_micro_usd, cost_cny_micro\
             ) VALUES (\
                $1,$2,$3,$4,$5,\
                (SELECT group_id FROM route_endpoints WHERE id = $5),\
                $6,$7,$8,$9,$10,$11,$12,$13,$14,$15\
             )",
        )
        .bind(ev.kind)
        .bind(ev.user_id)
        .bind(ev.api_key_id)
        .bind(ev.route_id)
        .bind(ev.endpoint_id)
        .bind(&ev.model_name)
        .bind(ev.prompt_tokens)
        .bind(ev.completion_tokens)
        .bind(ev.cached_tokens)
        .bind(ev.latency_ms)
        .bind(ev.http_status)
        .bind(ev.err_class.as_deref())
        .bind(detail)
        .bind(ev.cost_micro_usd)
        .bind(ev.cost_cny_micro)
        .execute(&st.db)
        .await;
    });
}

/// 计费成功收口。`cost_cents` 是美元分，`cny_cents` 是用户实付人民币分。
pub fn spawn_ok(
    state: &AppState,
    user_id: Uuid,
    route_id: Uuid,
    endpoint_id: Option<Uuid>,
    model_name: &str,
    prompt: i64,
    completion: i64,
    cached: i64,
    cost_cents: i64,
    cny_cents: i64,
) {
    let micro = crate::models::MICRO_USD_PER_CENT;
    spawn(
        state,
        Event {
            kind: "ok",
            user_id: Some(user_id),
            api_key_id: None,
            route_id: Some(route_id),
            endpoint_id: endpoint_id.or(Some(route_id)),
            model_name: model_name.to_string(),
            prompt_tokens: prompt,
            completion_tokens: completion,
            cached_tokens: cached,
            latency_ms: None,
            http_status: Some(200),
            err_class: None,
            err_detail: None,
            cost_micro_usd: cost_cents.saturating_mul(micro),
            cost_cny_micro: cny_cents.saturating_mul(micro),
        },
    );
}

/// 派单失败/超时收口。`stall` 对应表头都没回来。
pub fn spawn_dispatch(
    state: &AppState,
    user_id: Option<Uuid>,
    route_id: Uuid,
    endpoint_id: Uuid,
    model_name: &str,
    status: u16,
    stall: bool,
    detail: &str,
) {
    let kind = if stall { "stall" } else { "fail" };
    spawn(
        state,
        Event {
            kind,
            user_id,
            api_key_id: None,
            route_id: Some(route_id),
            endpoint_id: Some(endpoint_id),
            model_name: model_name.to_string(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            latency_ms: None,
            http_status: Some(status as i32),
            err_class: Some(class_for_status(status, stall).to_string()),
            err_detail: Some(detail.to_string()),
            cost_micro_usd: 0,
            cost_cny_micro: 0,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_match_the_doc_examples() {
        assert_eq!(class_for_status(400, false), "upstream_4xx");
        assert_eq!(class_for_status(402, false), "balance");
        assert_eq!(class_for_status(401, false), "auth");
        assert_eq!(class_for_status(504, true), "timeout");
        assert_eq!(class_for_status(504, false), "timeout");
        assert_eq!(class_for_status(502, false), "upstream_5xx");
    }

    #[test]
    fn insert_is_fire_and_forget_and_does_not_touch_model_usage() {
        let src = include_str!("usage_log.rs");
        let spawn = src
            .split("pub fn spawn(")
            .nth(1)
            .expect("spawn");
        let body = &spawn[..spawn.find("\n}\n").unwrap_or(spawn.len())];
        assert!(
            body.contains("tokio::spawn(async move {"),
            "usage_log 写成同步会挡派单"
        );
        assert!(
            body.contains("INSERT INTO usage_log"),
            "观测必须写 usage_log，不是 model_usage"
        );
        assert!(
            !body.contains("INSERT INTO model_usage"),
            "观测写进计费表了"
        );
        assert!(
            body.contains("SELECT group_id FROM route_endpoints"),
            "分组要冗余进这一行，免日志查询再 JOIN"
        );
    }

    #[test]
    fn kinds_are_the_three_the_check_constraint_allows() {
        let src = include_str!("usage_log.rs");
        assert!(src.contains("kind != \"ok\" && ev.kind != \"fail\" && ev.kind != \"stall\""));
    }
}
