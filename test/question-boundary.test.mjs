// 提问边界：模型以问句收尾时，把它按回去还是停下来等用户。
//
// **这个文件存在的理由是一次无界自旋。** 原判据是
//     run._askUserCount = (run._askUserCount || 0) + 1;
//     if (run._askUserCount >= 3 && _live()) { _pushNudge("askBudget", …); continue; }
// _askUserCount 只增不减，所以第 4、5、6…次提问全部再次命中同一条、每次都 continue。
// 模型只要每轮以一句问句收尾，循环就**永不退出**，每轮一次完整付费模型调用。
// 而且它绕得过全部兜底：外层 for 的 budget 是 Infinity；空转断路器 _idleIters++ 和静默轮
// quietTurns++ 都排在这条腿 continue 之后，一次都执行不到。只能靠用户按 Stop，
// 按停之后还被记成 user_stopped —— 看起来像用户不耐烦，不像 harness 自旋。
//
// Claude Code 的 while(true) 敢那么写，是因为**只有模型能决定停**、没有任何强制续跑腿。
// 这里做不到完全没有（每条提醒都有事故背书），那底线就是：**每条强制续跑腿都要有有限预算**。
import assert from "node:assert/strict";
import test from "node:test";
import { decideQuestionBoundary, ASK_PUSHBACK_LIMIT } from "../src/agent/ask-user.js";

const plan = (n, status = "pending") =>
  Array.from({ length: n }, (_, i) => ({ content: "第" + i + "步", status }));

/** 模拟主循环：模型每轮都以问句收尾，看多少轮之后真的停下来。 */
function spin(facts0, maxIters = 500) {
  const run = { askUserCount: 0, pushbacks: 0, planIntercepted: false, ...facts0 };
  let iters = 0, nudges = 0;
  for (; iters < maxIters; iters++) {
    const r = decideQuestionBoundary({
      planSteps: run.planSteps, planIntercepted: run.planIntercepted,
      askUserCount: run.askUserCount, pushbacks: run.pushbacks,
      planInherited: run.planInherited, planTouched: run.planTouched, live: true,
    });
    if (r.nudge) nudges++;
    run.askUserCount = r.counters.askUserCount;
    run.pushbacks = r.counters.pushbacks;
    run.planIntercepted = r.counters.planIntercepted;
    if (r.action === "await_user") return { stoppedAfter: iters + 1, nudges, run };
  }
  return { stoppedAfter: Infinity, nudges, run };
}

test("模型每轮都提问：循环必须在有限轮之后停下来（这条以前是无限的）", () => {
  const { stoppedAfter } = spin({ planSteps: [] });
  assert.ok(Number.isFinite(stoppedAfter), "还是无界自旋：模型每轮问一句就能一直烧钱");
  assert.ok(stoppedAfter <= 2 + ASK_PUSHBACK_LIMIT + 1,
    `${stoppedAfter} 轮才停，超出预算（上限应约为 2 + ASK_PUSHBACK_LIMIT）`);
});

test("带一份还没做完的计划、模型每轮都提问：同样必须有限", () => {
  const { stoppedAfter } = spin({ planSteps: plan(5), planTouched: true });
  assert.ok(Number.isFinite(stoppedAfter), "计划分支下仍然是无界自旋");
  assert.ok(stoppedAfter <= 3 + ASK_PUSHBACK_LIMIT + 1, `${stoppedAfter} 轮才停`);
});

test("计划还剩步骤：第一次提问被按回去，不是停下来", () => {
  const r = decideQuestionBoundary({ planSteps: plan(5), planTouched: true, askUserCount: 0, pushbacks: 0 });
  assert.equal(r.action, "resume");
  assert.equal(r.nudge.cat, "planFinish");
  assert.match(r.nudge.text, /还剩 5 步/);
  assert.equal(r.counters.planIntercepted, true, "这一次要记掉，否则同一条能无限用");
});

test("同一份计划不会被拦第二次", () => {
  const r = decideQuestionBoundary({ planSteps: plan(5), planTouched: true, planIntercepted: true, askUserCount: 0, pushbacks: 1 });
  assert.equal(r.action, "await_user", "计划提醒用过一次之后还在续跑");
});

test("继承来、本轮没碰过的陈旧计划不参与强制续跑", () => {
  // 一次不相干的问答，不该因为上一轮留下的计划硬多跑一轮。
  const r = decideQuestionBoundary({ planSteps: plan(5), planInherited: true, planTouched: false, askUserCount: 0, pushbacks: 0 });
  assert.equal(r.action, "await_user");
  assert.equal(r.incompleteReason, null, "陈旧计划也不该被算成「未完成」记账");
});

test("按停之后一律不再推提醒、直接等用户", () => {
  const r = decideQuestionBoundary({ planSteps: plan(5), planTouched: true, live: false, askUserCount: 0, pushbacks: 0 });
  assert.equal(r.action, "await_user");
  assert.equal(r.nudge, null);
});

test("真的停下来时，计划还有剩步要如实记账（别让 awaiting_user 读起来像干净收工）", () => {
  const r = decideQuestionBoundary({ planSteps: plan(3), planTouched: true, planIntercepted: true, askUserCount: 9, pushbacks: 9 });
  assert.equal(r.action, "await_user");
  assert.equal(r.incompleteReason, "plan_steps_pending:3");
});

test("卡片提问和正文提问合并计数——两条路之间横跳不该刷新预算", () => {
  // 模型被拦下之后改用另一种形态问，用户看到的还是「一直在问」。
  const r = decideQuestionBoundary({ planSteps: [], askUserCount: 2, pushbacks: 0 });
  assert.equal(r.action, "resume");
  assert.match(r.nudge.text, /第 3 次向用户提问/);
  assert.equal(r.counters.askUserCount, 3, "计数必须往前走，否则预算永远用不完");
});

test("预算用完那一刻就停，不再推提醒", () => {
  const r = decideQuestionBoundary({ planSteps: [], askUserCount: 5, pushbacks: ASK_PUSHBACK_LIMIT });
  assert.equal(r.action, "await_user");
  assert.equal(r.nudge, null, "预算用完还在推提醒 = 还在烧一轮模型调用");
});
