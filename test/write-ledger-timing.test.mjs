// 写入账本记在什么时候——这是「中断之后说继续，它还是从头重来」剩下的那条腿。
//
// 原来这笔账记在「整批工具跑完之后」那个大记账循环里，而它在「批次中途按停」那条 break
// 的**下面 466 行**。复现：模型一批发出 [edit_file A, run_cmd npm test]（修改类是硬屏障、
// 串行）→ A 真的落了盘 → 用户在 npm test 跑着的时候点停 → A 在磁盘上，run._writeLedger
// 一条都没有 → run._breakWriteFact 为空 → session._lastRunState 里没有它 →
// **下一轮模型读到「本次运行还没有任何文件落盘」，于是从头整份重写。**
//
// 判据本身一个字没改（三个排除项各有事故背书），改的只是记账时刻。
import assert from "node:assert/strict";
import test from "node:test";
import { writeAttemptEntry, failedWritePaths } from "../src/agent/write-ledger.js";
import { fnSource, blockFrom } from "./helpers/source.mjs";

test("三类写工具都记账，读类不记", () => {
  for (const type of ["write", "edit", "multiedit"]) {
    assert.deepEqual(writeAttemptEntry({ type, path: "a.ts", ok: true, attempted: true }), { path: "a.ts", ok: true });
  }
  for (const type of ["read", "list", "command", "worker", ""]) {
    assert.equal(writeAttemptEntry({ type, path: "a.ts", ok: true, attempted: true }), null);
  }
});

test("落盘失败也要记——模型手上必须有和「已经改好了」相矛盾的事实", () => {
  // edit_file 因为 old_string 对不上整体没写、multi_edit 被编辑器里未保存的改动挡下，
  // 这些失败一次都不进账的话，模型没有任何可反驳自己的事实，于是照说「已保存」。
  assert.deepEqual(writeAttemptEntry({ type: "edit", path: "a.ts", ok: false, attempted: true }), { path: "a.ts", ok: false });
  assert.deepEqual(writeAttemptEntry({ type: "edit", path: "a.ts", attempted: true }), { path: "a.ts", ok: false },
    "ok 缺字段要当成没落盘——放宽的方向是谎报已保存");
});

test("三个排除项：流式已记过、没派发、没执行", () => {
  const base = { type: "write", path: "a.ts", ok: true, attempted: true };
  assert.equal(writeAttemptEntry({ ...base, eager: true }), null, "流式钩子记过了，再记一笔把 writes_failed 吹大一倍");
  assert.equal(writeAttemptEntry({ ...base, skipped: true }), null);
  // 补空洞那段只写了「[未执行]」消息、没写 rawResult，而 attempted(undefined) 是 true——
  // 一次根本没发生的写入会以「写失败」进账，把交付事实和 writes_failed 一起带偏。
  assert.equal(writeAttemptEntry({ ...base, ok: false, notAttempted: true }), null);
});

test("没尝试过 / 没路径的一律不记", () => {
  assert.equal(writeAttemptEntry({ type: "write", path: "a.ts", ok: true, attempted: false }), null);
  assert.equal(writeAttemptEntry({ type: "write", path: "", ok: true, attempted: true }), null);
});

test("记账时刻：调度器回调里就记，不等整批跑完", () => {
  // 这条是调用点断言，按 AST 取块（不切固定字符窗口——这一段一变长就静默守到别处去）。
  const cb = blockFrom("const message = { role: \"tool\", tool_call_id: it.tc.id, content: await executeScheduledItem(index) };", { code: true, enclosing: true });
  assert.match(cb, /_writeAttemptEntry\(\{/, "每一项结算的那一刻没有记账：中途按停就丢账");
  assert.match(cb, /it\._ledgerRecorded = true/, "要打标记，否则批次后那处会把同一次写入再记一笔");
});

test("批次后那处只兜底，不重记", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  assert.match(loop, /if \(!it\._ledgerRecorded\) \{/,
    "批次后无条件重记 = 同一次写入两笔账，writes_failed 直接翻倍");
});

test("中断那条 break 也要认 didMutate——同族另外两条都写了", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  // 落了盘却不认，收尾按「本轮什么都没改」结算，未验证的改动被静默放行。
  assert.match(loop, /if \(_landedHere\) \{ didMutate = true; run\._didMutate = true; _implOps\+\+; \}/);
});

test("账本读法没被这次改动带歪：按 path 取最后一条，不是 filter(ok===false)", () => {
  // 一个文件写失败、下一轮重试成功，两条都留在账上。filter 会把已经补救成功的也算进去，
  // 于是每一轮还在告诉模型「这个文件此刻不在磁盘上」——模型要么整篇重写覆盖掉，
  // 要么对用户说「没能保存，请手动检查」，而文件好好躺在磁盘上。
  assert.deepEqual(failedWritePaths([{ path: "a.ts", ok: false }, { path: "a.ts", ok: true }]), []);
  assert.deepEqual(failedWritePaths([{ path: "a.ts", ok: true }, { path: "a.ts", ok: false }]), ["a.ts"]);
});
