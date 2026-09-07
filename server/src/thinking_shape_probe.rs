//! **思考形状实测探针** —— 直接问上游"这个模型到底吃哪一种 thinking 参数"。
//!
//! 这个文件存在的理由是一次真实的失败:关于「Claude 5 一族拒收
//! `{"type":"enabled","budget_tokens":N}`、只能用 `adaptive` + `output_config.effort`」这条,
//! 全仓上下只有一段**注释**在断言,没有任何可复现的证据。排查思考不出来的时候,
//! 那段注释被当成事实反复引用,于是整条排查建立在一个没人验过的前提上。
//!
//! 判据只有一个:**发出去,看回来什么**。每种形状发一次最小请求,记下
//! HTTP 状态、错误原文、以及真实回来的思考字符数。
//!
//! 只有管理员能调,一次几百 token。

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::AppState;

#[derive(Deserialize)]
pub struct ProbeReq {
    /// 要测哪条线路。留空 = 测这个模型当前会被派到的第一条。
    pub route_id: Option<uuid::Uuid>,
    pub model: String,
}

fn other_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// 要试的几种形状。名字是给人看的,值是**逐字**发出去的那个 `thinking` 对象。
fn shapes() -> Vec<(&'static str, serde_json::Value, Option<serde_json::Value>)> {
    vec![
        // 官方文档里唯一记载的扩展思考形状。
        ("enabled+budget_4096", json!({"type":"enabled","budget_tokens":4096}), None),
        ("enabled+budget_16000", json!({"type":"enabled","budget_tokens":16000}), None),
        // 网关现在真正在发的那一种。
        (
            "adaptive+summarized+effort_high",
            json!({"type":"adaptive","display":"summarized"}),
            Some(json!({"effort":"high"})),
        ),
        // 网关对 max 档发的(effort 的取值也一并验)。
        (
            "adaptive+summarized+effort_max",
            json!({"type":"adaptive","display":"summarized"}),
            Some(json!({"effort":"max"})),
        ),
        // 光 adaptive,不带 display —— 用来验「display 到底管不管用」。
        ("adaptive_bare", json!({"type":"adaptive"}), None),
        // 完全不要思考,做对照组:确认这条线路本身是通的。
        ("none", serde_json::Value::Null, None),
    ]
}

pub async fn admin_thinking_probe(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<ProbeReq>,
) -> ApiResult<Json<serde_json::Value>> {
    crate::route_endpoints::admin_only(&claims)?;

    let route: crate::models::Model = match req.route_id {
        Some(id) => sqlx::query_as("SELECT * FROM models WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::bad("没有这条线路"))?,
        None => sqlx::query_as(
            "SELECT * FROM models WHERE active AND protocol = 'anthropic' \
               AND $1 = ANY(enabled_models) ORDER BY sort, rate LIMIT 1",
        )
        .bind(&req.model)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::bad("没有哪条启用的 anthropic 线路开放这个模型"))?,
    };

    let key = crate::models::model_key(&route.api_key);
    if key.is_empty() {
        return Err(AppError::bad("这条线路没有可用的密钥"));
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::bad(format!("建 http 客户端失败: {e}")))?;

    let mut results = Vec::new();
    for (name, thinking, output_config) in shapes() {
        // 用 OpenAI 形状进 aux_wire_request，和生产同一条转换路径 —— 别在探针里
        // 手搓一份请求体，那样测的是探针自己而不是网关真正会发的东西。
        let mut oai = json!({
            "model": req.model,
            "max_tokens": 32000,
            "messages": [{"role":"user","content":"一个农夫有 17 只羊，除了 9 只以外都跑了。又买回原有数量的三分之一（向下取整）。现在有几只？请一步步推理。"}],
        });
        if !thinking.is_null() {
            oai["thinking"] = thinking.clone();
        }
        if let Some(oc) = &output_config {
            oai["output_config"] = oc.clone();
        }
        let (url, mut body) = crate::models::aux_wire_request(&route.base_url, &route.protocol, &oai)
            .map_err(|e| AppError::bad(format!("拼请求失败: {e}")))?;
        // aux_wire_request 走的是网关自己的推导（会按模型代次覆盖 thinking）——
        // 探针要测的是**指定的那一种**，所以在这里逐字盖回去。
        if thinking.is_null() {
            body.as_object_mut().map(|o| o.remove("thinking"));
            body.as_object_mut().map(|o| o.remove("output_config"));
        } else {
            body["thinking"] = thinking.clone();
            match &output_config {
                Some(oc) => body["output_config"] = oc.clone(),
                None => {
                    body.as_object_mut().map(|o| o.remove("output_config"));
                }
            }
        }
        body["stream"] = json!(false);

        let sent = body.get("thinking").cloned().unwrap_or(serde_json::Value::Null);
        let sent_oc = body.get("output_config").cloned().unwrap_or(serde_json::Value::Null);
        let started = std::time::Instant::now();
        let resp = http
            .post(&url)
            .header("Authorization", format!("Bearer {key}"))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;
        let ms = started.elapsed().as_millis() as u64;

        let entry = match resp {
            Err(e) => json!({"shape": name, "sent_thinking": sent, "sent_output_config": sent_oc,
                             "error": e.to_string(), "ms": ms}),
            Ok(r) => {
                let status = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                let parsed: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                // 非流式回执里思考在 content[] 里,type 是 thinking / redacted_thinking。
                let mut thinking_chars = 0usize;
                let mut block_types: Vec<String> = Vec::new();
                // **非 text 块的形状要看得见。** `thinking_chars=0` 有两种可能:
                // 文字真是空串,或者文字挂在我们没读的键上。只记**键名和各自的长度**,
                // 不记内容 —— 长度足以分开这两种,而内容进不了管理日志。
                let mut block_shapes: Vec<serde_json::Value> = Vec::new();
                if let Some(arr) = parsed.get("content").and_then(|c| c.as_array()) {
                    for b in arr {
                        let ty = b.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                        block_types.push(ty.to_string());
                        if let Some(t) = b.get("thinking").and_then(|v| v.as_str()) {
                            thinking_chars += t.chars().count();
                        }
                        if ty == "text" {
                            continue;
                        }
                        let fields: Vec<serde_json::Value> = b
                            .as_object()
                            .map(|o| {
                                o.iter()
                                    .map(|(k, v)| match v {
                                        serde_json::Value::String(sv) => {
                                            json!({"key": k, "kind": "string", "chars": sv.chars().count()})
                                        }
                                        other => json!({"key": k, "kind": other_kind(other)}),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        block_shapes.push(json!({"type": ty, "fields": fields}));
                    }
                }
                json!({
                    "shape": name,
                    "sent_thinking": sent,
                    "sent_output_config": sent_oc,
                    "http_status": status,
                    "thinking_chars": thinking_chars,
                    "block_types": block_types,
                    "block_shapes": block_shapes,
                    "output_tokens": parsed.pointer("/usage/output_tokens"),
                    // 只在**出错**时把上游原文带出来 —— 那正是「到底支不支持」的答案。
                    // 成功时不带正文,免得把用户内容写进管理日志。
                    "upstream_error": if status >= 400 {
                        json!(text.chars().take(600).collect::<String>())
                    } else { serde_json::Value::Null },
                    "ms": ms
                })
            }
        };
        tracing::info!(probe = %entry, "thinking shape probe");
        results.push(entry);
    }

    Ok(Json(json!({
        "route": route.label,
        "base_url": crate::models::api_base(&route.base_url),
        "model": req.model,
        "results": results,
    })))
}
