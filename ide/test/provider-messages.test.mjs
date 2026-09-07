// 发送前的消息清洗（src/agent/provider-messages.js）的真往返：IDE 自用字段摘掉、旧版推理摘要摘掉、
// 半个代理对补掉、配对补齐——而且源消息一个字不动。
import assert from "node:assert/strict";
import test from "node:test";
import { _sanitizeProviderMessages, _stripLoneSurrogates, _wellFormedContent, _withoutLegacyReasoningSummary } from "../src/agent/provider-messages.js";
import { MISSING_TOOL_RESULT } from "../src/agent/tool-pairing.js";

test("_stripLoneSurrogates：落单的高位/低位代理换成 U+FFFD，完整的一对原样（且不拷贝）", () => {
  assert.equal(_stripLoneSurrogates("a\uD83Db"), "a�b");
  assert.equal(_stripLoneSurrogates("x\uDE00"), "x�");
  const ok = "完整\u{1F600}表情";
  assert.equal(_stripLoneSurrogates(ok), ok);
  assert.equal(_stripLoneSurrogates(42), 42);
});

test("_wellFormedContent：字符串和多模态分片都过；没改动时返回原数组本身", () => {
  const parts = [{ type: "text", text: "好的" }, { type: "image_url", image_url: { url: "data:x" } }];
  assert.equal(_wellFormedContent(parts), parts);
  const fixed = _wellFormedContent([{ type: "text", text: "坏\uD83D" }, parts[1]]);
  assert.equal(fixed[0].text, "坏�");
  assert.equal(fixed[1], parts[1], "没坏的分片保持同一个对象");
});

test("_withoutLegacyReasoningSummary：只摘掉正文里那段和 reasoning 对应的〔推理摘要〕", () => {
  assert.equal(_withoutLegacyReasoningSummary("答案\n\n〔推理摘要〕思路", "思路"), "答案");
  assert.equal(_withoutLegacyReasoningSummary("答案", "思路"), "答案");
  assert.equal(_withoutLegacyReasoningSummary("答案〔推理摘要〕别的", "思路"), "答案〔推理摘要〕别的", "对不上的不动");
  assert.equal(_withoutLegacyReasoningSummary(null, "x"), null);
});

test("_sanitizeProviderMessages：摘掉 reasoning/_ideMeta/model/feedback，修正文和 tool_call 参数，源消息不动", () => {
  const assistant = {
    role: "assistant", content: "答\n\n〔推理摘要〕思路", reasoning: "思路", _ideMeta: { kind: "x" }, model: "m", feedback: "up",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\uD83D\"}" } }],
  };
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: [{ type: "text", text: "u\uDC00" }] },
    assistant,
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const out = _sanitizeProviderMessages(messages);
  assert.equal(out.length, 4);
  assert.deepEqual(Object.keys(out[2]).sort(), ["content", "role", "tool_calls"]);
  assert.equal(out[2].content, "答");
  assert.equal(out[2].tool_calls[0].function.arguments, "{\"path\":\"a�\"}");
  assert.equal(out[1].content[0].text, "u�");
  assert.equal(assistant.reasoning, "思路", "源消息还要拿来渲染，不能被改");
  assert.equal(assistant.tool_calls[0].function.arguments, "{\"path\":\"a\uD83D\"}");
});

test("缺了结果的 tool_call 补一条〔未执行〕占位——上游严格校验配对，缺一半整轮拒收", () => {
  const out = _sanitizeProviderMessages([
    { role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [{ id: "c9", type: "function", function: { name: "run_cmd", arguments: "{}" } }] },
    { role: "user", content: "插话" },
  ]);
  const filler = out.find((m) => m.role === "tool" && m.tool_call_id === "c9");
  assert.ok(filler, "没补上配对");
  assert.equal(filler.content, MISSING_TOOL_RESULT);
});
