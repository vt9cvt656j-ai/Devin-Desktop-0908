// 思考台账（src/agent/think-ledger.js）的真往返：只留结论句、猜想不入账、FIFO 与总量约束。
import assert from "node:assert/strict";
import test from "node:test";
import { _extractThinkingConclusion, _thinkLedgerPush, _thinkLedgerBlockText } from "../src/agent/think-ledger.js";

test("从收尾段落里捞带决策词的句子；带猜想词的一律不入账", () => {
  const reasoning = [
    "先看一下报错的位置，这个栈指向 src/x.js 的第 12 行，附近是解析函数。",
    "对照了两处调用，参数形状一致，问题不在调用方。",
    "根因是解析函数没处理空串，因此决定在入口加一道空值判断。可能还有别的边界，先看看再说。",
  ].join("\n\n");
  const got = _extractThinkingConclusion(reasoning);
  assert.equal(got, "根因是解析函数没处理空串，因此决定在入口加一道空值判断。", "句尾标点跟着句子走");
});

test("极短的思考不入账；只有猜想的收尾也不入账（账本会把猜测变成下一轮的「如前所述」）", () => {
  assert.equal(_extractThinkingConclusion("太短了"), "");
  const hedge = "可能是缓存的问题，也许重启就好，也许是别的，不确定要不要先清一下。".repeat(3);
  assert.equal(_extractThinkingConclusion(hedge), "");
});

test("没有决策词但也没有猜想词时，兜底取末段", () => {
  const tail = "整体流程走完了，三个步骤都验证过，输出与预期一致，没有额外的问题。";
  const text = "前面是一些过程描述，读了几个文件，跑了一次命令，看了输出。\n\n" + tail.repeat(4);
  assert.equal(_extractThinkingConclusion(text), tail.repeat(4));
  assert.equal(_extractThinkingConclusion(text, 30).length, 80, "上限按 maxChars 截，但有 80 字的地板");
});

test("台账 FIFO ≤6 条、每条 ≤400 字、挂在 session 上；空摘要和空 session 都静默", () => {
  const session = {};
  for (let i = 1; i <= 8; i++) _thinkLedgerPush(session, `结论 ${i} ` + "x".repeat(500), i);
  assert.equal(session._thinkLedger.length, 6);
  assert.equal(session._thinkLedger[0].turn, 3, "最老的两条被挤掉");
  assert.equal(session._thinkLedger[5].summary.length, 400);
  _thinkLedgerPush(session, "   ", 9);
  assert.equal(session._thinkLedger.length, 6);
  assert.doesNotThrow(() => _thinkLedgerPush(null, "x"));
});

test("注入块从最新往旧装、总量 ≤400 字、最新一条永远在场", () => {
  assert.equal(_thinkLedgerBlockText([]), "");
  assert.equal(_thinkLedgerBlockText(null), "");
  const text = _thinkLedgerBlockText([{ summary: "a".repeat(300) }, { summary: "b".repeat(300) }]);
  assert.ok(text.includes("1. " + "b".repeat(300)));
  assert.ok(!text.includes("aaa"), "装不下的旧结论不硬塞");
  assert.match(text, /勿重新推导/);
  const both = _thinkLedgerBlockText([{ summary: "老结论" }, { summary: "新结论" }]);
  assert.match(both, /1\. 老结论\n2\. 新结论/);
});
