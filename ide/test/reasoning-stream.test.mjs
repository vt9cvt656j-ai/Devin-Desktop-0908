// 推理流解析（src/agent/reasoning-stream.js）的真往返：内容流里内联的 <think> 怎么拆、跨片怎么接。
import assert from "node:assert/strict";
import test from "node:test";
import { _routeInlineThinkingDelta, _flushInlineThinkingDelta, _canRenderPreAnswerReasoning } from "../src/agent/reasoning-stream.js";

test("同一片里开合都在：思考进思考、正文进正文", () => {
  const st = {};
  const r = _routeInlineThinkingDelta(st, "<think>先看报错</think>结论是 A");
  assert.deepEqual([r.reasoning, r.answer, r.accepted], ["先看报错", "结论是 A", true]);
  assert.equal(st.answerStarted, true);
});

test("标签被切成两片：前半片先扣住，后半片来了再判", () => {
  const st = {};
  const a = _routeInlineThinkingDelta(st, "<thi");
  assert.deepEqual([a.reasoning, a.answer], ["", ""]);
  assert.equal(st.hold, "<thi");
  assert.equal(a.accepted, true, "答案开始前的半个控制标签算传输进度，重试层不能把它当卡住");
  const b = _routeInlineThinkingDelta(st, "nk>x</think>y");
  assert.deepEqual([b.reasoning, b.answer], ["x", "y"]);
  assert.equal(st.hold, "");
});

test("正文开始之后姗姗来迟的 <think> 是供应商包装噪音：不进思考卡，也不算进度", () => {
  const st = {};
  _routeInlineThinkingDelta(st, "Hello");
  const late = _routeInlineThinkingDelta(st, "<think>secret</think>");
  assert.deepEqual([late.reasoning, late.answer, late.accepted], ["", "", false]);
  assert.equal(_canRenderPreAnswerReasoning(st), false);
});

test("flush：半个闭合标签是控制语法丢掉；半个开标签是模型可能真的打了个 <，还给正文", () => {
  assert.deepEqual(_flushInlineThinkingDelta({ inThink: true, hold: "</thi" }), { reasoning: "", answer: "" });
  const st = { inThink: false, hold: "<thi", answerStarted: false };
  assert.deepEqual(_flushInlineThinkingDelta(st), { reasoning: "", answer: "<thi" });
  assert.equal(st.answerStarted, true);
  assert.deepEqual(_flushInlineThinkingDelta(null), { reasoning: "", answer: "" });
});

test("_canRenderPreAnswerReasoning：没状态或正文没开始都能渲染", () => {
  assert.equal(_canRenderPreAnswerReasoning(null), true);
  assert.equal(_canRenderPreAnswerReasoning({ answerStarted: false }), true);
  assert.equal(_canRenderPreAnswerReasoning({ answerStarted: true }), false);
});
