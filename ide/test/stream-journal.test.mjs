// 流式草稿增量日志的纯逻辑：按轮次合并 delta、恢复时快照与日志取较全者。
import test from "node:test";
import assert from "node:assert/strict";
import { groupDeltasByGen, mergeJournalIntoDrafts } from "../src/agent/stream-journal.js";

test("同一轮的 delta 顺序拼接；跨轮切换分成两条记录", () => {
  const r = groupDeltasByGen([
    { g: 5, t: "你" }, { g: 5, r: "想" }, { g: 5, t: "好" },
    { g: 6, t: "新轮" },
  ]);
  assert.deepEqual(r, [
    { gen: 5, text: "你好", reasoning: "想" },
    { gen: 6, text: "新轮", reasoning: "" },
  ]);
  assert.deepEqual(groupDeltasByGen([]), []);
  assert.deepEqual(groupDeltasByGen(null), []);
});

test("恢复合并：同会话正文/思考各取较长者，steps 从快照保留", () => {
  const snap = [{ sessionId: "a", text: "旧短", reasoning: "思考旧", steps: "步骤1\n步骤2" }];
  const journal = [{ sessionId: "a", gen: 3, text: "更长的完整正文", reasoning: "思" }];
  const m = mergeJournalIntoDrafts(snap, journal);
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "更长的完整正文", "增量日志更新 → 取它");
  assert.equal(m[0].reasoning, "思考旧", "快照的思考更长 → 保留快照的");
  assert.equal(m[0].steps, "步骤1\n步骤2", "步骤只有快照有，必须留住");
});

test("日志独有的会话（快照那份被 SIGKILL 丢了）也补进来", () => {
  const m = mergeJournalIntoDrafts([], [{ sessionId: "b", gen: 1, text: "只在日志里", reasoning: "" }]);
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "只在日志里");
  assert.equal(m[0].steps, "");
});

test("快照独有的会话原样保留；两边都空不产出", () => {
  const m = mergeJournalIntoDrafts([{ sessionId: "c", text: "快照", reasoning: "", steps: "" }], []);
  assert.equal(m[0].text, "快照");
  assert.deepEqual(mergeJournalIntoDrafts([], []), []);
});

test("drainJournal：把缓冲按轮次刷成 append 调用；收尾会话改调 clear、且清掉标记", async () => {
  const { drainJournal } = await import("../src/agent/stream-journal.js");
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); };
  const s1 = { id: "a", _runGen: 2, _journalBuf: [{ g: 2, t: "你", r: "" }, { g: 2, t: "好", r: "想" }] };
  const s2 = { id: "b", _journalClearPending: true, _journalBuf: [{ g: 1, t: "残", r: "" }] };
  const s3 = { id: "c", _journalBuf: [] };
  await drainJournal([s1, s2, s3, null, { id: "" }], invoke);
  assert.deepEqual(calls, [
    ["stream_draft_append", { sessionId: "a", gen: 2, text: "你好", reasoning: "想" }],
    ["stream_draft_clear", { sessionId: "b" }],
  ]);
  assert.equal(s1._journalBuf.length, 0, "刷过的缓冲要清空，别下拍重发");
  assert.equal(s2._journalClearPending, false, "清除标记消费后复位");
});

test("drainJournal：invoke 抛错不影响其它会话（主链路还有 2s 全量兜底）", async () => {
  const { drainJournal } = await import("../src/agent/stream-journal.js");
  const ok = [];
  const invoke = async (cmd, args) => { if (args.sessionId === "bad") throw new Error("boom"); ok.push(args.sessionId); };
  await drainJournal([{ id: "bad", _journalBuf: [{ g: 1, t: "x", r: "" }] }, { id: "good", _journalBuf: [{ g: 1, t: "y", r: "" }] }], invoke);
  assert.deepEqual(ok, ["good"]);
});
