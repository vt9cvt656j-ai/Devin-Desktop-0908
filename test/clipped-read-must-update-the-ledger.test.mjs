import test from "node:test";
import assert from "node:assert/strict";
import { CODE } from "./helpers/source.mjs";
import { capTurnToolResults } from "../src/agent/tool-output.js";

// 读取结果的执行事实（覆盖了哪些行、签名、完不完整）挂在 _ideMeta 上，是在**产生结果那一刻**
// 记的；单轮总量削减发生在**投递前**。原来只换 content、_ideMeta 原样带过去 ——
// 账本仍然说「这个文件本轮已完整读过」，而模型手上只剩五分之一。
const readMsg = (sig) => ({
  role: "tool",
  content: "x".repeat(260000),   // 单条就超单轮总上限(20 万)，保证削减循环一定会跑
  _ideMeta: { kind: "read", canonicalPath: "src/a.ts", from: 1, to: 900, total: 900, complete: true, signature: sig },
});

test("正文被削的那一条，账本要当场标成「正文不在上下文里」", () => {
  const out = capTurnToolResults([readMsg("s1"), readMsg("s2")]);
  for (const m of out) {
    assert.ok(m.content.length < 260000, "没削？那这条测试的前提就没成立");
    assert.equal(m._ideMeta.contextAvailable, false,
      "削了正文却没改账 —— 盲覆写闸会据此放行整文件重写");
  }
});

test("同一批里没被削的那条，账本一个字不许动", () => {
  // 必须放在**同一批**里，而且这一批要真的超限 —— 否则函数在削减循环之前就返回了，
  // 这条断言不管实现怎么写都绿（实测：把"连没削的也标"这个变异放进去照样通过）。
  const out = capTurnToolResults([
    readMsg("big"),
    { role: "tool", content: "short", _ideMeta: { kind: "read", canonicalPath: "src/b.ts", complete: true, signature: "sb" } },
  ]);
  assert.ok(out[0].content.length < 260000, "大的那条没被削，前提不成立");
  assert.equal(out[1].content, "short", "小的那条被削了？公平灌水不该动它");
  assert.deepEqual(out[1]._ideMeta, { kind: "read", canonicalPath: "src/b.ts", complete: true, signature: "sb" },
    "顺手把没削的也标成不可用，会把正常的读取覆盖一起抹掉");
});

test("没有 _ideMeta 的条目不许被凭空造一个", () => {
  const out = capTurnToolResults([
    { role: "tool", content: "y".repeat(260000) },
    { role: "tool", content: "z".repeat(260000) },
  ]);
  for (const m of out) assert.equal(m._ideMeta, undefined);
});

test("用的是账本既有的那个字段，不是新造一套语义", () => {
  // 折叠、去重两处早就在用 contextAvailable:false；覆盖账本重建时按它跳过。
  // 另起一个字段的话，三个下游一个都不会认。
  // CODE 只拼 main.js + src/agent/*.js，tool-output.js 在里面。
  assert.match(CODE, /_clipped\._ideMeta = \{ \.\.\._clipped\._ideMeta, contextAvailable: false \}/,
    "削减出口没有改账");
  assert.match(CODE, /\|\| meta\.contextAvailable === false \|\| !meta\.canonicalPath/,
    "覆盖账本重建时不再按 contextAvailable 跳过了，这条修复就落空了");
  assert.match(CODE, /_readEvidenceCovers\(meta, prevMeta\) && prevMeta\?\.contextAvailable !== false/,
    "同版本读取去重不再看 contextAvailable —— 会拿被削的那条去顶掉完整的");
});
