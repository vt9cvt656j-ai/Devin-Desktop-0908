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

test("恢复合并：DOM 快照两边都可能有，按拍摄时间取新的；只有快照的会话也算有内容", async () => {
  const { mergeJournalIntoDrafts } = await import("../src/agent/stream-journal.js");
  const snap = [{ sessionId: "a", text: "正文", reasoning: "", steps: "", html: "<div>退出时拍的</div>", htmlAt: 200 }];
  const journal = [{ sessionId: "a", gen: 3, text: "正文", reasoning: "", html: "<div>3 秒节拍拍的</div>", htmlAt: 100 }];
  const m = mergeJournalIntoDrafts(snap, journal);
  assert.equal(m[0].html, "<div>退出时拍的</div>", "退出 flush 那份更新，取它");
  const m2 = mergeJournalIntoDrafts(snap, [{ ...journal[0], htmlAt: 300 }]);
  assert.equal(m2[0].html, "<div>3 秒节拍拍的</div>", "日志那份更新就取日志的");
  const only = mergeJournalIntoDrafts([], [{ sessionId: "b", gen: 1, text: "", reasoning: "", html: "<div>只跑了工具</div>", htmlAt: 5 }]);
  assert.equal(only.length, 1);
  assert.equal(only[0].html, "<div>只跑了工具</div>", "一个字没写、只跑了工具的那轮也要回来");
  assert.equal(mergeJournalIntoDrafts([{ sessionId: "c", text: "x", reasoning: "", steps: "" }], [{ sessionId: "c", gen: 1, text: "x", reasoning: "" }])[0].html, undefined, "两边都没快照就没有");
});

test("drainJournal：流式会话每 3 秒拍一次在途消息快照，内容没变不重写，收尾清掉记忆", async () => {
  const { drainJournal, HTML_SNAPSHOT_INTERVAL_MS } = await import("../src/agent/stream-journal.js");
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); };
  let clock = 10_000; const now = () => clock;
  let dom = "<div class=\"msg\">v1</div>";
  const s = { id: "a", _runGen: 7, streaming: true, _liveMsgEl: {}, _journalBuf: [] };
  await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.deepEqual(calls, [["stream_draft_snapshot", { sessionId: "a", gen: 7, at: 10_000, html: "<div class=\"msg\">v1</div>" }]]);
  clock += 1000; await drainJournal([s], invoke, { snapshotHtml: () => "<div>v2</div>", now });
  assert.equal(calls.length, 1, "不到 3 秒不重拍");
  clock += HTML_SNAPSHOT_INTERVAL_MS; await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(calls.length, 1, "内容没变不重写");
  clock += HTML_SNAPSHOT_INTERVAL_MS; dom = "<div class=\"msg\">v2</div>"; await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(calls.length, 2); assert.equal(calls[1][1].html, dom);
  // 不在流式 / 没有在途节点 / 没注入拍照函数：一律不拍
  clock += HTML_SNAPSHOT_INTERVAL_MS; await drainJournal([{ ...s, streaming: false }], invoke, { snapshotHtml: () => "<x/>", now });
  await drainJournal([{ ...s, _liveMsgEl: null }], invoke, { snapshotHtml: () => "<x/>", now });
  await drainJournal([s], invoke, { now });
  assert.equal(calls.length, 2);
  // 拍照函数抛错不影响 delta 刷盘
  s._journalBuf = [{ g: 7, t: "字", r: "" }]; clock += HTML_SNAPSHOT_INTERVAL_MS;
  await drainJournal([s], invoke, { snapshotHtml: () => { throw new Error("boom"); }, now });
  assert.deepEqual(calls[2], ["stream_draft_append", { sessionId: "a", gen: 7, text: "字", reasoning: "" }]);
  // 收尾：clear 之外还要忘掉上一份快照内容，下一轮同样的开头也要重新拍
  s._journalClearPending = true; await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(s._draftHtmlLast, "");
});

test("大快照放慢节拍：整份 HTML 每次都要过一遍 IPC，连着刷会顶主线程", async () => {
  const { drainJournal, htmlSnapshotInterval, HTML_SNAPSHOT_INTERVAL_MS, HTML_SNAPSHOT_LARGE_BYTES, HTML_SNAPSHOT_LARGE_FACTOR } =
    await import("../src/agent/stream-journal.js");
  assert.equal(htmlSnapshotInterval(0), HTML_SNAPSHOT_INTERVAL_MS);
  assert.equal(htmlSnapshotInterval(HTML_SNAPSHOT_LARGE_BYTES), HTML_SNAPSHOT_INTERVAL_MS);
  assert.equal(htmlSnapshotInterval(HTML_SNAPSHOT_LARGE_BYTES + 1), HTML_SNAPSHOT_INTERVAL_MS * HTML_SNAPSHOT_LARGE_FACTOR);

  let clock = 0;
  const now = () => clock;
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); };
  const s = { id: "s1", streaming: true, _liveMsgEl: {}, _runGen: 1 };
  let dom = "<div>" + "b".repeat(HTML_SNAPSHOT_LARGE_BYTES + 10) + "</div>";
  clock += HTML_SNAPSHOT_INTERVAL_MS;
  await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(calls.filter((c) => c[0] === "stream_draft_snapshot").length, 1, "第一份大快照照拍");

  dom = "<div>" + "c".repeat(HTML_SNAPSHOT_LARGE_BYTES + 10) + "</div>";
  clock += HTML_SNAPSHOT_INTERVAL_MS;
  await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(calls.filter((c) => c[0] === "stream_draft_snapshot").length, 1, "大快照 3 秒后不该又拍一次");

  clock += HTML_SNAPSHOT_INTERVAL_MS * HTML_SNAPSHOT_LARGE_FACTOR;
  await drainJournal([s], invoke, { snapshotHtml: () => dom, now });
  assert.equal(calls.filter((c) => c[0] === "stream_draft_snapshot").length, 2, "到了放慢后的节拍就该拍");
});
