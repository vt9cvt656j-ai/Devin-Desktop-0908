// 发送前的消息清洗：两条请求路径（chat / agent）共同的最后一道出线口。
//
// 三件事，都是「对上游说话之前把本地记账摘干净」：
//   · 配对修复（repairToolPairing）：assistant.tool_calls 与 tool 结果一一对应，缺一半上游整轮拒收；
//   · 摘掉 IDE 自用字段（reasoning / _ideMeta / model / feedback）和旧版塞进正文的〔推理摘要〕；
//   · 补掉被 .slice() 切成半个的 UTF-16 代理对——Rust 的 serde_json 会以
//     "lone leading surrogate" 硬拒收，整轮红着结束。
// 纯函数；从 main.js 原样搬出，一行逻辑没改。
import { repairToolPairing } from "./tool-pairing.js";

export function _withoutLegacyReasoningSummary(content, reasoning) {
  if (typeof content !== "string" || typeof reasoning !== "string") return content;
  const summary = reasoning.trim().slice(0, 2000);
  if (!summary) return content;
  const marker = `〔推理摘要〕${summary}`;
  const index = content.indexOf(marker);
  if (index < 0) return content;
  let start = index;
  let end = index + marker.length;
  if (content.slice(start - 2, start) === "\n\n") start -= 2;
  else if (content.slice(end, end + 2) === "\n\n") end += 2;
  return content.slice(0, start) + content.slice(end);
}

// 被切成两半的 UTF-16 代理对，在交给后端之前补掉。
//
// 用户实拍的报错原文：`lone leading surrogate in hex escape at line 1 column 47665`。
// 这句话是 **Rust 的 serde_json** 才会说的——出现在"把消息交给后端"那一跳：JS 字符串容得下
// 半个代理对，JSON.stringify 也照样输出 \ud83d，但 Rust 那边直接拒收，整轮当场红着结束，
// 用户看到的就是一条看不懂的红字。
//
// 来源是**截断**。这份代码到处 .slice() 工具结果和历史（-7000 / 0,240 / head-tail 各种），
// 一刀切在 emoji、部分 CJK 扩展字的中间，就留下一个孤立的高位或低位代理。列号 47665 说明
// 是个大结果——社区搜索、网页抓取这类最容易带 emoji。
//
// 收口放在这里而不是每个 slice 点：slice 有几十处，逐个补漏一个就复发；而**所有**出站消息
// 都要过这个函数。先判再改，绝大多数消息一次拷贝都不产生。

export function _stripLoneSurrogates(value) {
  if (typeof value !== "string") return value;
  // ES2024 的原生实现优先；老引擎走下面的手工配对，不用 lookbehind——WKWebView 版本跨度大，
  // 不赌语法支持。
  if (typeof value.isWellFormed === "function") {
    return value.isWellFormed() ? value : value.toWellFormed();
  }
  let out = null;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index++; continue; } // 完整的一对，跳过
    }
    // 走到这里的一定是落单的（成对的低位已被上面跳过）
    if (out === null) out = [...value];
    out[index] = "\uFFFD";
  }
  return out === null ? value : out.join("");
}

// 消息内容可能是字符串，也可能是多模态的分片数组；工具调用的 arguments 是 JSON 字符串。
// 三种形状都可能带着被截断的代理对，所以三种都要过。
export function _wellFormedContent(content) {
  if (typeof content === "string") return _stripLoneSurrogates(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const parts = content.map((part) => {
    if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
    const text = _stripLoneSurrogates(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? parts : content;
}

// Conversation memory carries IDE-only fields used for restoring the thought
// card and compacting tool evidence. Providers receive a clean request copy;
// the source messages remain untouched for rendering and local orchestration.

export function _sanitizeProviderMessages(messages) {
  const source = repairToolPairing(Array.isArray(messages) ? messages : []);
  return source.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    // `model`（这条历史当初是哪个模型答的）和 `feedback`（用户点的赞/踩）都是**展示用**
    // 的记账，不是消息协议的一部分。这里是**排除法**不是白名单，未知字段会原样发给上游，
    // 所以必须显式摘掉 —— 和 reasoning 同一个道理、同一个位置。
    // 两条请求路径（chat / agent）都过这个函数，这里是它们共同的最后一道出线口。
    const { reasoning, _ideMeta, model: _uiModelTag, feedback: _uiFeedback, ...providerMessage } = message;
    void _uiModelTag; void _uiFeedback;
    if (message.role === "assistant" && typeof reasoning === "string") {
      providerMessage.content = _withoutLegacyReasoningSummary(message.content, reasoning);
    }
    providerMessage.content = _wellFormedContent(providerMessage.content);
    if (Array.isArray(providerMessage.tool_calls)) {
      providerMessage.tool_calls = providerMessage.tool_calls.map((call) => {
        const args = call?.function?.arguments;
        if (typeof args !== "string") return call;
        const fixed = _stripLoneSurrogates(args);
        return fixed === args ? call : { ...call, function: { ...call.function, arguments: fixed } };
      });
    }
    return providerMessage;
  });
}
