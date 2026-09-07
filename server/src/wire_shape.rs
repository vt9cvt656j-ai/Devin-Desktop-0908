//! 出站 Anthropic 请求的形状规范化 —— **我们发出去的必须永远是一份合法的对话**。
//!
//! # 这道闸挡的是什么
//!
//! Anthropic 对 `messages` 有两条硬约束，违反任何一条都是 400、整轮直接死：
//!
//! · 每个 `tool_result` 块，都必须能在**它前面的某个助手轮**里找到同 id 的 `tool_use`；
//! · 第一条消息必须是 `user`。
//!
//! 而这条链上有**三处**会在不看这两条约束的情况下裁掉历史开头：
//!
//! 1. 客户端按覆盖前缀省略已折叠的部分（`_applyCompressionPrefix`）；
//! 2. 网关的上下文压缩按**累计 token 数**切段（`compression::segment_messages`
//!    是纯贪心累加，一个字都不看 role）；
//! 3. 同一个边界在 `compression_write_back` 里被再切一次。
//!
//! 一个 agent 回合的历史里绝大多数是 assistant / tool 消息，所以边界落在
//! 「assistant 发起工具调用」和「它的结果」之间是常态。切开之后，上游收到的第一条
//! 就是一个没有主人的 `tool_result`。
//!
//! 更麻烦的是**这个错误形状曾经被测试正面钉住**：`write_back_preserves_tool_call_structure`
//! 特意在 assistant(call_1) 和 tool(call_1) 之间下刀，然后断言输出的第 4 条是那条孤儿
//! `tool`。那条测试的本意是「逐字尾部的结构字段不能丢」，是对的；但它顺带把
//! 「配对被切断」固化成了预期输出。
//!
//! # 为什么修在这里，而不是修那三个切点
//!
//! 修切点要改的是一个付费功能的形状（原生做法是把摘要作为 `user` 轮，我们注入的是
//! `system` 块），而且**修好一个不代表另外两个不会再切**。这里是唯一一个所有路径都
//! 必经的地方：不管是谁切的、以后再长出第四个切点，出站请求的合法性都在这一道守住。
//!
//! 它也是**纯函数**，所以判据能真跑，不用靠源码断言。
//!
//! # 三条规则
//!
//! · **孤儿 `tool_result` 整块丢掉。** 丢的是一段没有上文的工具输出 —— 模型看不到是
//!   哪次调用产生的，本来也读不懂；留着则是 400。同一条消息里的正文照留。
//! · **消息被掏空就整条丢掉。** 空 content 的消息 Anthropic 同样不收。
//! · **开头不是 `user` 就补一条。** 补的是一句字节恒定的过渡语 —— 恒定是有意的：
//!   它排在整条消息前缀的最前面，每轮变一次就等于每轮把整段历史的缓存作废。
//!   不能改成「丢掉开头的 assistant」：那会把模型自己上一轮的动作从上下文里抹掉。

use serde_json::{json, Value};

/// 开头缺 `user` 时补的那一句。**逐字节恒定**，见模块头。
const BRIDGE: &str = "（这段对话较早的部分已被折叠，从这里接着说。）";

fn blocks_of(m: &Value) -> Option<&Vec<Value>> {
    m.get("content").and_then(|c| c.as_array())
}

/// 规范化一份出站 Anthropic `messages`，返回一份一定收得下的。
pub(crate) fn normalize(messages: Vec<Value>) -> Vec<Value> {
    let mut declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::with_capacity(messages.len() + 1);

    for mut m in messages {
        let is_assistant = m.get("role").and_then(|r| r.as_str()) == Some("assistant");
        // 助手轮先登记它声明了哪些 tool_use —— 顺序很重要：同一轮里不可能出现
        // 引用自己的 tool_result，但下一轮的可以引用这一轮的。
        if is_assistant {
            if let Some(bs) = blocks_of(&m) {
                for b in bs {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        if let Some(id) = b.get("id").and_then(|v| v.as_str()) {
                            declared.insert(id.to_string());
                        }
                    }
                }
            }
        } else if let Some(bs) = blocks_of(&m) {
            let kept: Vec<Value> = bs
                .iter()
                .filter(|b| {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        return true;
                    }
                    b.get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .is_some_and(|id| declared.contains(id))
                })
                .cloned()
                .collect();
            if kept.len() != bs.len() {
                if kept.is_empty() {
                    continue; // 整条消息只剩空壳，丢掉
                }
                if let Some(slot) = m.get_mut("content") {
                    *slot = json!(kept);
                }
            }
        }
        // content 本来就是空数组的（上游给的畸形数据）同样不能发。
        if blocks_of(&m).is_some_and(|b| b.is_empty()) {
            continue;
        }
        out.push(m);
    }

    if out
        .first()
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        != Some("user")
        && !out.is_empty()
    {
        out.insert(0, json!({"role":"user","content":[{"type":"text","text":BRIDGE}]}));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asst(id: &str) -> Value {
        json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"想","signature":"s"},
            {"type":"tool_use","id":id,"name":"read_file","input":{}}
        ]})
    }
    fn result(id: &str) -> Value {
        json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"文件内容"}]})
    }
    fn user(t: &str) -> Value {
        json!({"role":"user","content":[{"type":"text","text":t}]})
    }
    fn roles(v: &[Value]) -> Vec<&str> {
        v.iter().map(|m| m["role"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_complete_conversation_passes_through_untouched() {
        // 最重要的一条：正常形状**一个字节都不能动**。这道闸每一轮都跑在出站路径上，
        // 它多改一处就是多一处每轮变化的字节，前缀缓存会被它自己作废。
        let ok = vec![user("开工"), asst("t1"), result("t1"), user("接着")];
        assert_eq!(normalize(ok.clone()), ok);
    }

    #[test]
    fn an_orphan_tool_result_at_the_head_is_dropped_and_a_user_turn_opens_the_history() {
        // 压缩正好在 assistant(t1) 和它的结果之间下刀之后的形状。
        // 直接发上去是两个 400 叠在一起：孤儿 tool_result + 开头不是 user。
        let cut = vec![result("t1"), asst("t2"), result("t2"), user("接着")];
        let got = normalize(cut);
        assert_eq!(roles(&got), vec!["user", "assistant", "user", "user"]);
        assert_eq!(got[0]["content"][0]["text"], BRIDGE, "补的开场白不对");
        assert!(
            !got.iter().any(|m| m["content"][0]["tool_use_id"] == "t1"),
            "孤儿 tool_result 还在 —— 上游会判 400「tool_result 没有对应的 tool_use」"
        );
        // t2 那一对是完整的，必须原样留着。
        assert_eq!(got[2]["content"][0]["tool_use_id"], "t2");
    }

    #[test]
    fn an_assistant_first_history_gets_a_user_turn_instead_of_losing_the_assistant() {
        // 丢掉开头那条 assistant 也能让请求合法，但那会把模型自己上一轮做过什么
        // 从上下文里抹掉 —— 它下一轮就会重做一遍。
        let got = normalize(vec![asst("t1"), result("t1"), user("接着")]);
        assert_eq!(roles(&got), vec!["user", "assistant", "user", "user"]);
        assert_eq!(got[1], asst("t1"), "开头那条助手轮被改动或丢掉了");
    }

    #[test]
    fn a_tool_result_mixed_with_real_text_keeps_the_text() {
        let m = json!({"role":"user","content":[
            {"type":"tool_result","tool_use_id":"gone","content":"孤儿"},
            {"type":"text","text":"用户这句话不能丢"}
        ]});
        let got = normalize(vec![m]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(got[0]["content"][0]["text"], "用户这句话不能丢");
    }

    #[test]
    fn a_forward_reference_is_still_an_orphan() {
        // tool_result 只能引用**它前面**的 tool_use。引用后面那条的照样是孤儿 ——
        // 用一个「全局收集 id」的实现会漏掉这种。
        let got = normalize(vec![user("开工"), result("t9"), asst("t9")]);
        assert_eq!(roles(&got), vec!["user", "assistant"]);
        assert!(!got.iter().any(|m| m["content"][0]["type"] == "tool_result"));
    }

    #[test]
    fn the_bridge_text_is_byte_stable_so_it_never_invalidates_the_prefix() {
        // 补的那条排在整条消息前缀最前面。它每轮变一次，后面整段历史每轮全价重算 ——
        // 比不补还贵。所以它不许含时间戳、计数、随机数或任何随请求变化的东西。
        let a = normalize(vec![asst("t1"), result("t1")]);
        let b = normalize(vec![asst("t1"), result("t1"), user("又一轮")]);
        assert_eq!(a[0], b[0], "补的开场白在两次请求之间变了");
        assert!(!BRIDGE.chars().any(|c| c.is_ascii_digit()), "开场白里有数字，可能是变量");
    }

    #[test]
    fn an_empty_message_list_stays_empty_rather_than_growing_a_bridge() {
        assert!(normalize(Vec::new()).is_empty());
    }
}
