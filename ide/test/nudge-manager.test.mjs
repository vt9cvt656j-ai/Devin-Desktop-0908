// 提醒管理器：从 _runAgenticLoop 搬出来的第一段。这里做**真往返**（一份干净的 messages 数组
// 驱动），不抠源码——搬出来的意义就在这。判据逐条对应搬之前的行为。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createNudgeManager, _nudgeRank as nudgeRank, _NUDGE_FACTS as NUDGE_FACTS, _NUDGE_ONCE as NUDGE_ONCE, NUDGE_ADVICE_CAP, NUDGE_TOTAL_CAP, NUDGE_STALE_DISTANCE,
} from "../src/agent/nudge-manager.js";
import { NUDGE_GATE_EXEMPT } from "../src/agent/nudge-gate.js";

const NOTE = "〔编排〕";
function mk({ enabled = true, floor = 0, cap = 0, used = 0 } = {}) {
  const messages = [{ role: "user", content: "u0" }, { role: "assistant", content: "a0" }];
  const run = {};
  const state = { floor };
  const n = createNudgeManager({
    messages, run, orchNote: NOTE, isEnabled: () => enabled, exempt: NUDGE_GATE_EXEMPT,
    floor: () => state.floor, readCap: () => cap, usageTokens: () => used,
  });
  return { messages, run, n, state };
}
const cats = (messages) => messages.filter((m) => m.content.startsWith(NOTE)).map((m) => m.content.slice(NOTE.length));

test("分级：steer < 一次性 < 事实 < 建议；没登记的按建议", () => {
  assert.equal(nudgeRank("steer"), 0);
  assert.equal(nudgeRank("researchFirst"), 1, "一次性排在普通事实前面");
  assert.equal(nudgeRank("buildFix"), 2);
  assert.equal(nudgeRank("从没听过的类别"), 3);
  assert.ok(NUDGE_ONCE.has("researchFirst") && NUDGE_FACTS.has("researchFirst"));
});

test("同类替换：本轮尾部的旧条真删，本轮起点之前的留在历史里只换登记", () => {
  const { messages, n, state } = mk();
  n.push("planStale", "第一版");
  assert.deepEqual(cats(messages), ["第一版"]);
  n.push("planStale", "第二版");
  assert.deepEqual(cats(messages), ["第二版"], "尾部的旧条该被 splice 掉");
  // 下一轮：floor 抬到当前长度，旧条落在历史区。
  state.floor = messages.length;
  n.push("planStale", "第三版");
  assert.deepEqual(cats(messages), ["第二版", "第三版"], "历史区的旧条不许抠（上游前缀缓存会失效）");
  assert.equal(n.reg.get("planStale").content, NOTE + "第三版", "登记表只认最新那条");
});

test("建议只留 1 条、总额 4 条；超额时先淘汰建议，再淘汰最旧的事实；steer 永不清", () => {
  const { messages, n } = mk();
  n.push("steer", "用户插话");
  n.push("adviceA", "a");
  n.push("adviceB", "b");
  assert.deepEqual(cats(messages), ["用户插话", "b"], "第二条建议到达时第一条建议要被挤掉");
  n.push("buildFix", "f1"); n.push("diag", "f2"); n.push("blindEdit", "f3");
  // 现在：steer + adviceB + f1 f2 f3 = others(不含 steer)=4 → 再来一条事实要挤：先挤建议
  n.push("bugEvidence", "f4");
  assert.deepEqual(cats(messages), ["用户插话", "f1", "f2", "f3", "f4"], "超额先挤建议 b，事实一条不丢");
  n.push("subagentResult", "f5");
  assert.deepEqual(cats(messages), ["用户插话", "f2", "f3", "f4", "f5"], "没有建议可挤时挤最旧的事实 f1");
  assert.ok(messages.some((m) => m.content === NOTE + "用户插话"), "steer 永远不被淘汰");
  assert.equal(NUDGE_ADVICE_CAP, 1); assert.equal(NUDGE_TOTAL_CAP, 4);
});

test("一次性提醒排在事实前面：四条事实凑齐时最先被踢的不是它", () => {
  const { messages, n } = mk();
  n.push("researchFirst", "取证台账是空的");
  n.push("buildFix", "f1"); n.push("diag", "f2"); n.push("blindEdit", "f3");
  n.push("bugEvidence", "f4");
  assert.ok(cats(messages).includes("取证台账是空的"), "一次性提醒被普通事实挤掉了——这个 run 再也不会提第二次");
  assert.ok(!cats(messages).includes("f1"), "该走的是最旧的普通事实");
});

test("总闸关掉：计数照记、消息不进；豁免类别照进", () => {
  const { messages, run, n } = mk({ enabled: false });
  const before = messages.length;
  n.push("verifyNow", "x"); n.push("verifyNow", "x"); n.push("investigate", "x");
  assert.equal(messages.length, before, "关掉之后还有提醒进上下文");
  assert.equal(run._nudgeAttempts, 3); assert.equal(run._nudgeSuppressed, 3);
  assert.deepEqual({ ...run._nudgeCounts }, { verifyNow: 2, investigate: 1 });
  n.push("steer", "用户的话");
  assert.equal(messages.length, before + 1, "steer 不受闸门管");
  assert.equal(run._nudgeSuppressed, 3);
});

test("sweep：距尾超过 14 条的提醒注销但不抠历史；已被别处删掉的也注销", () => {
  const { messages, n } = mk();
  n.push("planStale", "旧");
  const old = n.reg.get("planStale");
  for (let i = 0; i < NUDGE_STALE_DISTANCE + 1; i++) messages.push({ role: "assistant", content: "…" });
  n.sweep();
  assert.equal(n.reg.has("planStale"), false, "过时的要退出管理");
  assert.ok(messages.includes(old), "但不许从历史中段抠掉");
  n.push("diag", "d");
  const dm = n.reg.get("diag");
  messages.splice(messages.indexOf(dm), 1);   // 别处把它删了
  n.sweep();
  assert.equal(n.reg.has("diag"), false);
});

test("clear：只删本轮尾部的，历史区的留下；登记表全清", () => {
  const { messages, n, state } = mk();
  n.push("planStale", "历史里的");
  state.floor = messages.length;
  n.push("diag", "本轮的");
  n.clear();
  assert.deepEqual(cats(messages), ["历史里的"]);
  assert.equal(n.reg.size, 0);
});

test("pushRunFact：直接入历史，不进登记表，三条删除路径都够不着", () => {
  const { messages, n } = mk();
  const m = n.pushRunFact("子智能体报告");
  assert.equal(m.content, NOTE + "子智能体报告");
  assert.equal(n.reg.size, 0);
  n.clear(); n.sweep();
  assert.ok(messages.includes(m));
});

test("token 预算挂在结算落地那一刻：超限只置标记，不重复置", async () => {
  const { run, n } = mk({ cap: 1000, used: 1500 });
  let resolve;
  const task = new Promise((r) => { resolve = r; });
  run._billingTasks = [task];
  n.hookSettlementTasks();
  n.hookSettlementTasks();   // 同一个 task 只挂一次
  assert.equal(run._tokenCapPending, undefined, "结算还没落地不该判");
  resolve(); await task; await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(run._tokenCapPending, { used: 1500, cap: 1000 });
  run._tokenCapPending = undefined; run._tokenCapNudged = true;
  n.noteTokenCapOnSettlement();
  assert.equal(run._tokenCapPending, undefined, "已经提醒过就不再置");
});

test("没设预算时结算落地什么都不做", async () => {
  const { run, n } = mk({ cap: 0, used: 99999 });
  run._billingTasks = [Promise.resolve()];
  n.hookSettlementTasks();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(run._tokenCapPending, undefined);
});
