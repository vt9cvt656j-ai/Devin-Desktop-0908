//! 思考块的跨轮回传 —— 让 Claude 这条线真正是**原生 Anthropic**，而不只是端点原生。
//!
//! # 在这之前丢了什么
//!
//! 上游按 Anthropic 协议回来的助手轮长这样：
//!
//! ```text
//! content: [
//!   {"type":"thinking","thinking":"用户要的是…所以先读那个文件","signature":"EqQBCgIYAi…"},
//!   {"type":"tool_use","id":"toolu_1","name":"read_file","input":{…}}
//! ]
//! ```
//!
//! 网关把它翻成 OpenAI 形状时（`anthropic_to_oai`）只取 `thinking` 的**文字**塞进
//! `reasoning_content`，`signature` 一个字都不读；流式那条更彻底 —— `signature_delta`
//! 事件压根没有分支，落到 `_ => {}` 静默丢掉。下一轮请求重建助手消息时
//! （`oai_to_anthropic_with_cache` 的 `"assistant"` 分支）只生成 `text` 和 `tool_use`
//! 两种块。于是：
//!
//! **模型每拿回一次工具结果，就看不见自己上一轮的推理了。**
//!
//! 一轮里想「先读 A 再读 B，因为 B 的含义取决于 A 里的那个常量」，工具结果回来时
//! 那句「因为…」已经不在上下文里 —— 它只看得见自己调了 read_file，看不见为什么。
//! 多步任务里这一条会累积成"每一步都从头想一遍"。
//!
//! # 为什么之前认为不用管
//!
//! `models.rs` 里有一条实测结论：replayed tool_use turns **WITHOUT** preserved thinking
//! blocks are tolerated（200，不是 400）。这句话是真的，但它回答的是**上游拒不拒**，
//! 不是**模型有没有变笨**。中转返回 200 只说明它不校验，不说明推理链还在。
//!
//! # 签名不能当普通文本处理
//!
//! `signature` 是上游对这段思考的加密签署，绑定到**具体模型**。回放一个不属于当前模型
//! 的签名会被判 400 —— 也就是说这个功能会把今天「能跑但降级」的形状换成「直接失败」。
//! 所以下面每一条判据都是必要条件，缺一条就不回放（不回放＝退回今天的行为，安全）：
//!
//! · **这一轮真的开了思考**。思考关着的请求里带 thinking 块是协议错误。
//! · **模型逐字相同**。用户中途换模型是常事，跨模型的签名必然无效。
//! · **签名非空**。中转可能只转发思考文字不转发签名（我们自己以前就是这么丢的）；
//!   没有签名的 thinking 块发上去也是 400。
//! · **思考文字非空**。签名签的是这段文字，空文字对不上。
//!
//! 判据不满足时静默跳过而不是报错：这条链上任何一环（客户端版本、中转、上游）都可能
//! 不带签名，那时候正确的行为是**退回到今天**，不是让用户这一轮失败。
//!
//! # 块要整块存，不能拍平成一个字符串
//!
//! 一个助手轮可以有多个思考块（交错思考），每块有各自的签名 —— 签名签的是**它自己那段
//! 文字**。若把所有思考文字拼成一个串再配一个签名，回放上去必然对不上。所以中间形态是
//! **数组**，逐块带自己的签名，顺序保持原样。
//!
//! 客户端不需要理解这个数组，原样存、原样回传即可 —— 配对由网关做完了。

use serde_json::{json, Value};

/// OpenAI 形状的助手消息上挂思考块的字段名。客户端只当它是不透明数据。
pub(crate) const FIELD: &str = "reasoning_blocks";

/// 从一份 Anthropic 响应的 `content` 数组里抽出可回放的思考块。
///
/// `model` 一起记下来，回放时用它做跨模型判据 —— 光有签名判断不出它属于谁。
pub(crate) fn collect(content: &Value, model: &str) -> Vec<Value> {
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
        .filter_map(|b| {
            let thinking = b.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
            let signature = b.get("signature").and_then(|v| v.as_str()).unwrap_or("");
            one(thinking, signature, model)
        })
        .collect()
}

/// 组一个中间形态的块。文字或签名为空就返回 None —— 存下来也回放不了，不如不存。
pub(crate) fn one(thinking: &str, signature: &str, model: &str) -> Option<Value> {
    if thinking.is_empty() || signature.is_empty() {
        return None;
    }
    Some(json!({"thinking": thinking, "signature": signature, "model": model}))
}

/// 把中间形态还原成 Anthropic 的 `thinking` 块，用于下一轮请求的助手消息。
///
/// 判据全在这里，不满足返回空 —— 空即退回今天的行为。
pub(crate) fn replay(msg: &Value, model: &str, thinking_on: bool) -> Vec<Value> {
    if !thinking_on {
        return Vec::new();
    }
    let Some(saved) = msg.get(FIELD).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    saved
        .iter()
        .filter_map(|b| {
            let thinking = b.get("thinking").and_then(|v| v.as_str())?;
            let signature = b.get("signature").and_then(|v| v.as_str())?;
            // 签名绑定到模型：换了模型的签名一定无效，宁可不回放也不能让这一轮 400。
            if b.get("model").and_then(|v| v.as_str()) != Some(model) {
                return None;
            }
            if thinking.is_empty() || signature.is_empty() {
                return None;
            }
            Some(json!({"type": "thinking", "thinking": thinking, "signature": signature}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anth_content() -> Value {
        json!([
            {"type": "thinking", "thinking": "先读 A 再读 B", "signature": "EqQBCgIYAi"},
            {"type": "text", "text": "我来看看"},
            {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}
        ])
    }

    #[test]
    fn a_thinking_block_survives_the_round_trip_intact() {
        let saved = collect(&anth_content(), "claude-opus-5");
        assert_eq!(saved.len(), 1, "思考块没被收下来");

        let msg = json!({"role": "assistant", FIELD: saved});
        let back = replay(&msg, "claude-opus-5", true);
        assert_eq!(
            back,
            vec![json!({"type":"thinking","thinking":"先读 A 再读 B","signature":"EqQBCgIYAi"})],
            "回放出来的块和上游发下来的不是同一个 —— 签名对不上就是 400"
        );
    }

    #[test]
    fn multiple_thinking_blocks_keep_their_own_signatures_and_order() {
        // 交错思考：一轮里多个思考块，每块签自己那段文字。拼成一个串就全废了。
        let content = json!([
            {"type": "thinking", "thinking": "第一段", "signature": "sig-1"},
            {"type": "tool_use", "id": "t1", "name": "read", "input": {}},
            {"type": "thinking", "thinking": "第二段", "signature": "sig-2"}
        ]);
        let back = replay(
            &json!({FIELD: collect(&content, "m")}),
            "m",
            true,
        );
        assert_eq!(back.len(), 2);
        assert_eq!(back[0]["thinking"], "第一段");
        assert_eq!(back[0]["signature"], "sig-1");
        assert_eq!(back[1]["signature"], "sig-2", "两块的签名被串到一起了");
    }

    #[test]
    fn a_signature_from_another_model_is_never_replayed() {
        // 这是本模块唯一会把「今天能跑」变成「明天 400」的形状，必须挡住。
        let saved = collect(&anth_content(), "claude-opus-5");
        let msg = json!({FIELD: saved});
        assert!(
            replay(&msg, "claude-fable-5-1", true).is_empty(),
            "跨模型回放了签名 —— 用户中途换个模型整轮就 400"
        );
    }

    #[test]
    fn nothing_is_replayed_when_thinking_is_off_this_turn() {
        // 思考关着还带 thinking 块是协议错误，同样是把降级换成失败。
        let msg = json!({FIELD: collect(&anth_content(), "m")});
        assert!(replay(&msg, "m", false).is_empty());
    }

    #[test]
    fn a_thinking_block_without_a_signature_is_dropped_at_collect_time() {
        // 中转只转发思考文字、不转发签名是真实存在的形状（我们自己以前就这么丢的）。
        // 存下来也回放不了，且回放上去是 400 —— 所以在入口就丢掉。
        let content = json!([{"type": "thinking", "thinking": "有文字没签名"}]);
        assert!(collect(&content, "m").is_empty());
        // 也挡住直接构造出来的坏数据（老客户端、手工拼的历史）。
        let msg = json!({FIELD: [{"thinking": "有文字没签名", "signature": "", "model": "m"}]});
        assert!(replay(&msg, "m", true).is_empty());
    }

    #[test]
    fn redacted_thinking_is_not_replayed_as_a_plain_thinking_block() {
        // redacted_thinking 的载荷在 `data` 里、形状完全不同，当普通思考块回放必然无效。
        let content = json!([{"type": "redacted_thinking", "data": "opaque"}]);
        assert!(collect(&content, "m").is_empty());
    }

    #[test]
    fn a_message_with_no_saved_blocks_replays_nothing_rather_than_failing() {
        // 老客户端、历史消息、非 Claude 线路 —— 全都没有这个字段。必须静默退回今天的行为。
        assert!(replay(&json!({"role": "assistant", "content": "hi"}), "m", true).is_empty());
        assert!(replay(&json!({FIELD: "不是数组"}), "m", true).is_empty());
        assert!(replay(&json!({FIELD: []}), "m", true).is_empty());
    }

    #[test]
    fn collect_tolerates_a_content_that_is_not_an_array() {
        // Anthropic 的 content 一定是数组，但中转返回什么形状不由我们决定。
        assert!(collect(&json!("纯字符串"), "m").is_empty());
        assert!(collect(&json!(null), "m").is_empty());
    }
}
