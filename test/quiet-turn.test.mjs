// 静默轮停止决策的行为测试。
//
// 判定 2026-09-02 从 _runAgenticLoop 里搬进 src/agent/quiet-turn.js —— 搬的理由就是这个：
// 纯函数能在 Node 里真跑，于是守卫做的是**真往返**，而不是去匹配 main.js 的源码文本。
// 本仓库有一整类「断言真实却守错了东西」的恒真守卫，源码断言只用来钉调用点。
import test from "node:test";
import assert from "node:assert/strict";
import { decideQuietTurn, QUIET_RESUME_POOL } from "../src/agent/quiet-turn.js";

const Q = (over = {}) => decideQuietTurn({
  mode: "agent", live: true, quietTurns: 1, planActionable: true, ...over,
});

test("默认收尾：模型没调工具就是它的收尾决定", () => {
  const r = Q();
  assert.equal(r.action, "break");
  assert.equal(r.gate, null);
  assert.deepEqual(r.labels, []);
  // 被按停时连算都不算。
  assert.equal(Q({ live: false, diagnosticBlock: "x", steerQueued: true }).action, "break");
});

test("诊断门推过一次、模型却没有新的成功编辑 → 收尾，不再白烧一轮", () => {
  // 这是 2026-09-02 修掉的一个真缺陷。原来的代码判完「再推也没用、把扣掉的预算还回去」
  // 之后**照样 continue**：模型收到的还是上一轮那条一模一样的提醒（diagnosticBlock 只在
  // 有成功编辑时才重算），它唯一能做的合规动作就是把答案换个说法重写，于是又一个静默轮，
  // 撞到 quietTurns >= 2 才收尾。净效果是每次都多烧一次付费调用，且什么都没换来。
  const stale = Q({ diagnosticBlock: "TS2304", diagnosticNudges: 1, lastSuccessfulEdits: 0 });
  assert.equal(stale.action, "break", "推过一次又没有新编辑，就不该再推第二次");
  assert.ok(stale.labels.includes("new_diagnostics_unresolved"), "不推也要如实记账");
  assert.ok(!("quietResumePool" in stale.counters), "不开火就不该扣预算");

  // 对照：上一轮真的改了东西 → 说明提醒起作用了，值得再推一次。
  const fresh = Q({ diagnosticBlock: "TS2304", diagnosticNudges: 1, lastSuccessfulEdits: 3 });
  assert.equal(fresh.gate, "diagnostics");
  assert.equal(fresh.counters.diagnosticNudges, 2);
  assert.equal(fresh.counters.quietResumePool, QUIET_RESUME_POOL - 1);

  // 第一次永远推（还没有「上一轮」可言）。
  assert.equal(Q({ diagnosticBlock: "TS2304", lastSuccessfulEdits: 0 }).gate, "diagnostics");
});

test("四道门的优先级：插话 > 诊断 > 构建 > 计划", () => {
  const all = { steerQueued: true, diagnosticBlock: "x", buildFail: { command: "c" }, pendingPlanSteps: 2 };
  assert.equal(Q(all).gate, "steer");
  assert.equal(Q({ ...all, steerQueued: false }).gate, "diagnostics");
  assert.equal(Q({ ...all, steerQueued: false, diagnosticBlock: "" }).gate, "build");
  assert.equal(Q({ ...all, steerQueued: false, diagnosticBlock: "", buildFail: null }).gate, "plan");
});

test("缺席不是失败：没跑验证、没写测试，一律不补回合", () => {
  // 「没跑验证」观测到的是**缺席**，缺席不等于工作是坏的——改动很小、项目根本没有构建
  // 系统、用户明说别跑，都是正当理由。拿缺席去覆盖模型的收尾判断，就是用 harness 的
  // 偏好压过它的判断。（红构建不一样：那是**观测到失败**。）
  //
  // 判定的入参里根本没有「有没有验证证据」这一项——这条性质是结构性的，不是靠分支实现的。
  assert.equal(Q({ mutatedCode: true, hasVerifyEvidence: false }).action, "break");
  assert.equal(Q({ verifiedAtImplOps: 0, implOps: 12 }).action, "break");
});

test("有界：每道门 2 次，三道门共用 3 轮 —— 一次 run 最多多转 3 轮", () => {
  let pool = QUIET_RESUME_POOL, turns = 0;
  const state = { diagnosticNudges: 0, buildFixAttempts: 0, planFinishNudges: 0 };
  for (let i = 0; i < 50; i++) {
    const r = decideQuietTurn({
      mode: "agent", live: true, quietTurns: 1, planActionable: true, quietResumePool: pool,
      diagnosticBlock: "x", lastSuccessfulEdits: 9,
      buildFail: { command: "c" }, pendingPlanSteps: 3, ...state,
    });
    if (r.action !== "continue") break;
    turns++;
    Object.assign(state, r.counters);
    if ("quietResumePool" in r.counters) pool = r.counters.quietResumePool;
  }
  assert.equal(turns, QUIET_RESUME_POOL,
    `三道门都有活干时一共多转了 ${turns} 轮；共享池是 ${QUIET_RESUME_POOL}，各算各的会到 6`);
});

test("插话把整本欠账销干净，包括那个会反过来关掉所有门的静默计数", () => {
  const c = Q({ steerQueued: true, quietTurns: 9, quietResumePool: 0,
    diagnosticNudges: 2, buildFixAttempts: 2, planFinishNudges: 2 }).counters;
  assert.equal(c.quietTurns, 0, "静默计数到 2 就把三道门一起关掉，它不清零等于账没销干净");
  assert.equal(c.quietResumePool, QUIET_RESUME_POOL);
  assert.equal(c.diagnosticNudges, 0);
  assert.equal(c.buildFixAttempts, 0);
  assert.equal(c.planFinishNudges, 0);
});
