import test from "node:test";
import assert from "node:assert/strict";
import { CODE } from "./helpers/source.mjs";
import { decideQuietTurn } from "../src/agent/quiet-turn.js";

const base = { mode: "agent", live: true, quietTurns: 0, quietResumePool: 3, lastSuccessfulEdits: 0 };

// ── 能停就停：推过一次没起作用，就别再推 ──────────────────────────────────
// 这条规则诊断门早就有（它的注释记着那次事故：「照样 continue 就是白烧一次付费轮，
// 模型收到的还是同一条提醒，只能把答案换个说法重写」）。构建门和计划门一直没接，
// 于是各自还能白烧两轮 —— 线上一轮 54k token、首字 6~14 秒。

test("构建门：推过一次而模型没有新的成功编辑 → 收尾，不再推", () => {
  assert.equal(decideQuietTurn({ ...base, buildFail: {}, buildFixAttempts: 0 }).action, "continue",
    "第一次必须推——红构建是「已完成」为假的直接证据");
  assert.equal(decideQuietTurn({ ...base, buildFail: {}, buildFixAttempts: 1 }).action, "break",
    "推过一次、模型什么也没改，再推就是白烧一轮");
  assert.equal(decideQuietTurn({ ...base, buildFail: {}, buildFixAttempts: 1, lastSuccessfulEdits: 3 }).action, "continue",
    "模型真在改，就该继续推——别把正常修复路径也掐了");
});

test("计划门：同一条短路", () => {
  const plan = { ...base, pendingPlanSteps: 4, planActionable: true };
  assert.equal(decideQuietTurn({ ...plan, planFinishNudges: 0 }).action, "continue");
  assert.equal(decideQuietTurn({ ...plan, planFinishNudges: 1 }).action, "break");
  assert.equal(decideQuietTurn({ ...plan, planFinishNudges: 1, lastSuccessfulEdits: 2 }).action, "continue");
});

test("诊断门原样保留——这次是补 ②③，不是改 ①", () => {
  assert.equal(decideQuietTurn({ ...base, diagnosticBlock: "x", diagnosticNudges: 0 }).action, "continue");
  assert.equal(decideQuietTurn({ ...base, diagnosticBlock: "x", diagnosticNudges: 1 }).action, "break");
  assert.equal(decideQuietTurn({ ...base, diagnosticBlock: "x", diagnosticNudges: 1, lastSuccessfulEdits: 1 }).action, "continue");
});

test("短路要报出「为什么没继续」，不能静默收尾", () => {
  const b = decideQuietTurn({ ...base, buildFail: {}, buildFixAttempts: 1 });
  assert.ok((b.labels || []).includes("build_failing"), "构建门短路没留下原因");
  const p = decideQuietTurn({ ...base, pendingPlanSteps: 4, planActionable: true, planFinishNudges: 1 });
  assert.ok((p.labels || []).some((l) => l.startsWith("plan_steps_pending")), "计划门短路没留下原因");
});

test("用户插话仍然优先于所有门，账全清零", () => {
  const r = decideQuietTurn({ ...base, steerQueued: true, buildFail: {}, buildFixAttempts: 2, pendingPlanSteps: 9, planActionable: true });
  assert.equal(r.action, "continue");
  assert.equal(r.gate, "steer");
  assert.equal(r.counters.buildFixAttempts, 0);
  assert.equal(r.counters.planFinishNudges, 0);
});

// ── 不做不相关的事：新问题不许继承旧计划 ────────────────────────────────
test("计划继承改成白名单：只有「接着上一轮」才继承", () => {
  // 原来是黑名单 correct||replace，而枚举是 new/continue/correct/clarify —— **漏了 new**。
  // 于是问一个全新、不相干的问题时旧计划照样被继承：注入提示词、界面「接下来」显示
  // "继续没做完的步骤"，模型一碰 update_plan 就又能硬顶一轮。
  assert.match(CODE, /const _planCarries = _planRel === "continue" \|\| _planRel === "clarify";/);
  assert.match(CODE, /const _planDropped = !_planCarries;/);
  assert.doesNotMatch(CODE, /const _planDropped = _planRel === "correct" \|\| _planRel === "replace";/,
    "黑名单回来了——new 又会继承旧计划");
});

test("判定未决时也不继承——错误丢弃可恢复，错误继承正是那个 bug", () => {
  // 旧计划仍留在 session 上，下一条「继续」照样捡得回来；而且按执行事实的那个继承点
  // （上一轮 failed/partial）本来就覆盖了"跑到一半被打断"这个正当场景。
  assert.match(CODE, /if \(isAgent && !run\._planSteps\s*&&[\s\S]{0,120}_prevOutcome === "failed" \|\| _prevOutcome === "partial"/,
    "按执行事实继承的那条腿不在了——白名单化之后正当的续跑场景就没人管了");
  assert.doesNotMatch(CODE, /_planDropped[\s\S]{0,200}?session\._planSteps = \[\]/,
    "不许把会话里那份也删掉——用户想接着做时要捡得回来");
});

test("「计划作废」那句话按真实原因分开说，不许对新问题谎称是纠正", () => {
  assert.match(CODE, /=== "new" \? "一件新的事，和上一轮不相干"/,
    "对 new 也说「这一轮是对上一轮的纠正」——模型会去猜用户在否定什么");
  assert.match(CODE, /: "没有判定为「接着上一轮做」"/, "判定未决时没有诚实的措辞");
  assert.match(CODE, /=== "correct" \? "对上一轮的纠正"/, "真的纠正时那句话要保留");
});
