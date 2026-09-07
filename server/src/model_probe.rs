//! 直接问上游要真值：公开目录没收录的模型，用**针探法**测出它真正的上下文窗口。
//!
//! # 为什么需要这一层
//!
//! 能力数据的第一来源是公开目录（`model_catalog`）。但目录不可能收全：实测 `glm-5.3`
//! 在 OpenRouter 里就没有（只有 5.1 / 5.2 / 5-turbo）。硬编码表删掉之后，这类模型就
//! 一点窗口数据都没有了。
//!
//! 两条备选路都不好：
//!   · 代码里再写一张表 —— 正是刚删掉的那个东西，实测在售 13 款里错了 6 款；
//!   · 让运维在后台手填 —— 能用，但那是把"查真值"这件事推给人，而人手上并没有比
//!     这台机器更好的信息源。
//!
//! 真值其实就在上游那儿，问一次就知道。
//!
//! # 为什么不能只看 HTTP 200
//!
//! **转卖网关会悄悄截断，而不是报错。** 实测：给 `glm-5.3` 发 300 万字符（≈75 万 token）
//! 的请求，照样返回 200 —— 它只是把超出的部分丢掉了。拿"没报错"当"能装下"，会得出
//! 一个荒唐的窗口。
//!
//! 所以判据是**召回**：开头埋一个暗号，中间灌满填充，结尾要它原样复述那个暗号。
//! 答对 = 开头那段真的进了模型的注意力范围。实测 glm-5.3 在 100K / 200K 都能答对，
//! 而它被硬编码成 128K。
//!
//! # 成本控制
//!
//! 探测烧的是真 token，所以：
//!   · **只探目录没收录的模型**（目录有就用目录的，那是免费且更准的）；
//!   · 只试常见的几个档位，从大到小，命中即止 —— 不做二分（二分要 log2(1M)≈20 次）；
//!   · 结果长期缓存，由 `model_catalog` 落库，重启不丢；
//!   · 每轮刷新最多探几个模型，避免某天 enabled_models 被填了几十个新模型时一次烧穿。

use crate::model_catalog::Entry;

/// 从大到小试这些档位，命中即止。挑的是厂商真实会用的整数档，不是二分。
///
/// 从大往小试是刻意的：命中第一个就停，常见情况（模型确实很大）只花一次请求。
/// 反过来从小往大试，每次都得把所有档位走完。
const PROBE_TIERS: &[i64] = &[1_000_000, 512_000, 262_144, 200_000, 131_072, 65_536, 32_768];

/// 一轮最多探几个模型。探测烧真 token，不能因为某天多配了几十个模型就一次烧穿。
pub const MAX_PROBES_PER_ROUND: usize = 3;

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// 暗号。挑一个绝不会在填充文本里偶然出现的串。
const NEEDLE: &str = "ZEBRA-7741-QUARTZ";
/// 填充语料。用自然句子而不是重复单字符：后者容易被上游的去重/压缩优化掉，
/// 那样测出来的是压缩率，不是窗口。
const FILLER_LINE: &str = "The quick brown fox jumps over the lazy dog. ";

/// 一行填充大约几个 token（英文 ~4 字符/token）。只用来把目标长度换算成行数，
/// 不需要精确 —— 判据是能不能召回，不是数字本身。
fn approx_tokens_per_line() -> usize {
    FILLER_LINE.len() / 4
}

fn build_probe_prompt(target_tokens: i64) -> String {
    let lines = (target_tokens as usize / approx_tokens_per_line()).max(1);
    let mut s = String::with_capacity(lines * FILLER_LINE.len() + 256);
    s.push_str("MEMO CODE: ");
    s.push_str(NEEDLE);
    s.push_str("\n\n");
    for _ in 0..lines {
        s.push_str(FILLER_LINE);
    }
    s.push_str("\n\nQuestion: repeat the MEMO CODE from the very beginning, exactly, and nothing else.");
    s
}

/// 这个长度能不能被真正读到。`Ok(true)` = 复述出了暗号。
async fn recalls_at(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    protocol: &str,
    model_id: &str,
    target_tokens: i64,
) -> anyhow::Result<bool> {
    let body = serde_json::json!({
        "model": model_id,
        "messages": [{ "role": "user", "content": build_probe_prompt(target_tokens) }],
        "max_tokens": 40,
        "temperature": 0,
    });
    // 按线路自己的协议打。以前无条件拼 /chat/completions —— Anthropic 线路上 404，
    // 而下面那句「非 2xx 都算这个长度不行」会把 404 读成「装不下」，于是整条线路上的
    // 模型被探成「一档都过不了」。这个错法尤其阴：它和「模型真的很小」返回同一个值。
    let (url, body) = crate::models::aux_wire_request(base_url, protocol, &body)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let resp = http
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        // 4xx/5xx 都算"这个长度不行"。区分不了"超限"和"临时故障"，但代价对称：
        // 误判为不行只是这一轮少测一档，下一轮还会再来。
        return Ok(false);
    }
    let v = crate::models::aux_wire_response(protocol, model_id, resp.json().await?);
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    Ok(text.contains(NEEDLE))
}

/// 探出这个模型真正能装下多少。`None` = 一档都没通过（线路不可用/模型名不对）。
pub async fn probe_context(
    base_url: &str,
    api_key: &str,
    protocol: &str,
    model_id: &str,
) -> Option<Entry> {
    let http = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;
    for &tier in PROBE_TIERS {
        match recalls_at(&http, base_url, api_key, protocol, model_id, tier).await {
            Ok(true) => {
                tracing::info!(model = model_id, window = tier, "能力探测：召回成功，采信这一档");
                return Some(Entry {
                    contexts: vec![tier],
                    ..Entry::default()
                });
            }
            Ok(false) => {
                tracing::debug!(model = model_id, window = tier, "能力探测：这一档召回失败，往下试");
            }
            Err(e) => {
                tracing::debug!(model = model_id, window = tier, error = %e, "能力探测：请求失败");
            }
        }
    }
    tracing::warn!(model = model_id, "能力探测：所有档位都没召回，保持未知");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 探测档位必须从大到小() {
        // 从大往小、命中即止：模型确实很大时只花一次请求。反过来每次都要走完所有档位。
        let mut sorted = PROBE_TIERS.to_vec();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(PROBE_TIERS, sorted.as_slice(), "档位顺序反了，探测会变贵");
        assert!(PROBE_TIERS.len() <= 8, "档位太多，一个模型最坏要发这么多次大请求");
    }

    #[test]
    fn 提示词把暗号放在最开头() {
        // 暗号必须在**最前面**：要测的是"开头那段还在不在注意力范围里"。
        // 放中间或结尾的话，模型靠最近的上下文就能答对，测不出窗口。
        let p = build_probe_prompt(10_000);
        let at = p.find(NEEDLE).expect("暗号不见了");
        assert!(at < 40, "暗号不在开头（位置 {at}），这样测不出真实窗口");
        assert!(p.trim_end().ends_with("and nothing else."), "结尾要有提问");
        // 长度要大致到位，否则测的是一个比目标短得多的输入
        assert!(p.len() > 10_000 * 3, "填充不足，实际长度远小于目标");
    }

    #[test]
    fn 填充用自然句子而不是重复单字符() {
        // 重复单字符容易被上游的去重/压缩优化掉，那样测出来的是压缩率不是窗口。
        assert!(FILLER_LINE.split_whitespace().count() > 5, "填充要是自然句子");
        let p = build_probe_prompt(1_000);
        assert!(!p.contains("xxxxxxxxxx"), "不要用重复单字符填充");
    }
}
