// **循环里每一条「强制续跑」都必须有预算。** 这是这个循环向 Claude Code 形状对齐时
// 唯一一条提示词接不住、只能靠结构守住的不变量。
//
// Claude Code 的循环是 `while (true) { … if (toolCalls.length === 0) break }` —— 模型说做完了
// 就结束，harness **一条强制续跑腿都没有**。它敢那么写正是因为这个：没有任何东西能推翻
// 模型的收尾决定，所以 while(true) 是安全的。
//
// 这个循环做不到 0（每条腿都有事故背书），那底线就是：**每一条都必须有有限预算**。
// 这不是理论洁癖 —— 唯一那条没预算的腿（正文提问）实测能让循环**永不退出**：
// `_askUserCount >= 3` 命中后 continue，而计数只增，第 4、5、6… 次全部再次命中，
// 每轮一次完整付费调用，只能靠用户按 Stop（按停还被记成 user_stopped）。
// 它还绕得过所有兜底：budget 是 Infinity，_idleIters++ 和 quietTurns++ 都在它 continue 之后。
//
// 判据用 AST，不用文本：
//   · 只数「最近的外层循环就是 agent 循环」的 continue —— 嵌套 `for (const it of items)` 里的
//     continue 只跳过一个工具项，不多跑模型轮。第一次量成 29 条就是栽在这里，真数是 8。
//   · 只数不在内嵌函数里的 —— 那 137 个闭包里的 continue 和循环无关。
import assert from "node:assert/strict";
import test from "node:test";
import * as acorn from "acorn";
import { fnSource } from "./helpers/source.mjs";

const SRC = fnSource("_runAgenticLoop");
// **偏移量必须回到同一份文本上。** 为了让一个函数声明能被当表达式解析，这里在两侧加了括号，
// 于是 AST 里所有 start/end 都比 SRC 多 1。第一版直接拿这些偏移去 SRC.slice，切出来的
// 条件掉了首字符（`_qb.action` 变成 `qb.action`），预算正则当场失配、报了一条假的"无界"。
// 统一在 WRAPPED 上切，就不存在这个错位。
const WRAPPED = "(" + SRC + ")";
const ast = acorn.parse(WRAPPED, { ecmaVersion: "latest" });
const root = ast.body[0].expression;
const srcOf = (n) => WRAPPED.slice(n.start, n.end);
const lineOf = (off) => WRAPPED.slice(0, off).split("\n").length;

/** agent 循环本体：`for (let iter = 0; iter < budget; iter++)`。 */
const loop = (() => {
  let found = null;
  (function walk(n, inFn) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, inFn)); return; }
    const isFn = n !== root && /Function|Arrow/.test(n.type);
    if (!inFn && n.type === "ForStatement" && !found && /iter < budget/.test(WRAPPED.slice(n.start, n.body.start))) found = n;
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k], inFn || isFn);
  })(root.body, false);
  return found;
})();

test("agent 循环本体还在，而且判据没漂", () => {
  assert.ok(loop, "找不到 `for (let iter = 0; iter < budget; iter++)` —— 这个文件的全部断言都失效了");
});

/** 属于 agent 循环自己的 continue（不在嵌套循环里、不在内嵌函数里）。 */
const forcedContinues = (() => {
  const out = [];
  (function walk(n, depth, inFn) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, depth, inFn)); return; }
    if (/Function|Arrow/.test(n.type)) {
      for (const k of Object.keys(n)) if (k !== "type") walk(n[k], depth, true);
      return;
    }
    if (/^(For|While|DoWhile)/.test(n.type)) {
      for (const k of Object.keys(n)) if (k !== "type") walk(n[k], depth + 1, inFn);
      return;
    }
    if (!inFn && depth === 0 && n.type === "ContinueStatement") out.push(lineOf(n.start));
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k], depth, inFn);
  })(loop.body, 0, false);
  return out;
})();

/**
 * 预算判据。**沿 AST 往上收集包住这条 continue 的每一个 if 条件**，不切固定行窗口。
 *
 * 第一版是「往上 34 行做正则」，当场两条误报：`turnRetry` 的闸写成
 * `(run._turnErrRetries || 0) < 2`（中间隔着 `|| 0)`，正则接不上），插话作废那条的闸
 * 在 34 行之外。固定窗口在这个仓库里已经栽过很多次 —— 函数一长就守到别处去，而且是静默的。
 *
 * 认三类：harness 自己的计数器/池、用户插话（那不是 harness 强制，是用户的输入）、
 * 以及搬进模块的判定函数（decideQuestionBoundary 自带 ASK_PUSHBACK_LIMIT）。
 */
//
// `_qb.action` 这一支的预算**不在循环里**：判定整段搬进了 src/agent/ask-user.js 的
// decideQuestionBoundary，上界是那边的 ASK_PUSHBACK_LIMIT，由 test/question-boundary.test.mjs
// 做**行为**验证（真跑一遍：模型每轮都提问，循环必须在有限轮内停）。
// 这正是想要的方向——判定搬出去、循环里只留分派——所以这里认它，
// 但认的同时下面那条断言会盯着那个模块里的上界还在不在。
// `_qt.gate` 同理：静默轮那四道门的判定 2026-09-02 整段搬进了 src/agent/quiet-turn.js，
// 上界（每门 2 次 + 共享池 3）在那边，由下面「搬出去的那两条腿」做行为验证。
const BUDGET = /Nudges?|Attempts|Retries|Reminders|_quietResumePool|PUSHBACK_LIMIT|_steerQueue|decideQuestionBoundary|_canResume|_qb\.action|_qt\.gate/;

/** 从循环体根部走到目标节点，沿途记下所有 IfStatement 的条件源码。 */
function guardsFor(targetLine) {
  const chain = [];
  let hit = false;
  (function walk(n, conds) {
    if (hit || !n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, conds)); return; }
    let next = conds;
    if (n.type === "IfStatement") next = conds.concat(srcOf(n.test));
    if (n.type === "ContinueStatement" && lineOf(n.start) === targetLine) { chain.push(...next); hit = true; return; }
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k], next);
  })(loop.body, []);
  return chain.join(" && ");
}

test("每一条强制续跑腿都有预算——一条无界的就够把循环变成无限烧钱", () => {
  const naked = [];
  for (const L of forcedContinues) {
    if (!BUDGET.test(guardsFor(L))) naked.push(L);
  }
  assert.deepEqual(naked, [],
    `这几行的 continue 没有任何可见预算（相对 _runAgenticLoop 的行号）：${naked.join("、")}\n`
    + "无界的强制续跑 = 模型只要满足一次条件就能让循环永不退出，每轮一次付费调用。\n"
    + "加一条腿就必须同时给它上界；做不到就别用 continue。");
});

test("强制续跑腿的条数有上限——别再往循环里加新的了", () => {
  // 8 是 2026-09-02 实测值：toolRepair / turnRetry / 插话作废批次 / 提问 / 插话队列 /
  // diagFinish / buildFix / planFinish。前两条和用户插话那两条各有自己的理由，
  // 剩下的靠共享的 _quietResumePool 封顶。
  //
  // 这条不是"数字必须等于 8"，是**只许降不许升**：Claude Code 的这个数是 0，
  // 每加一条都是离那个形状更远一步，而且都得先回答"提示词为什么接不住"。
  assert.ok(forcedContinues.length <= 8,
    `强制续跑腿涨到 ${forcedContinues.length} 条了（上次是 8）。\n`
    + "每一条都能推翻模型的收尾决定、多烧一轮付费调用。加之前先回答：这件事为什么不能写进系统提示词？");
});

test("静默轮那一族共用一个池，不是各算各的", async () => {
  // 各算各的话，三道门（诊断/构建/计划）每条 2 次就是 6 次额外调用。共享池把这一族整体封顶。
  // 判定搬进模块之后这里真跑：三道门轮流开，池子必须一路扣到 0，然后谁都开不了。
  const { decideQuietTurn, QUIET_RESUME_POOL } = await import("../src/agent/quiet-turn.js");
  assert.equal(typeof QUIET_RESUME_POOL, "number");
  assert.ok(QUIET_RESUME_POOL >= 1 && QUIET_RESUME_POOL <= 5, `共享池 ${QUIET_RESUME_POOL} —— 太大等于没有池`);
  let pool = QUIET_RESUME_POOL, opened = 0;
  // 每一轮都摆出「三道门都有活干」的事实，看它总共能开几次。
  for (let i = 0; i < 30; i++) {
    const r = decideQuietTurn({
      mode: "agent", live: true, quietTurns: 1, planActionable: true, quietResumePool: pool,
      diagnosticBlock: "x", diagnosticNudges: Math.min(i, 1), lastSuccessfulEdits: 5,
      buildFail: { command: "c" }, buildFixAttempts: Math.max(0, i - 2),
      pendingPlanSteps: 3, planFinishNudges: Math.max(0, i - 4),
    });
    if (r.action !== "continue") break;
    opened++;
    if ("quietResumePool" in (r.counters || {})) pool = r.counters.quietResumePool;
  }
  assert.equal(opened, QUIET_RESUME_POOL,
    `三道门一共开了 ${opened} 次，而共享池是 ${QUIET_RESUME_POOL} —— 各算各的话会开到 6 次`);
  assert.equal(pool, 0, "开门要扣池，不扣就是池子形同虚设");
  // 接线：循环真的把池子读进去、也真的写回来。
  const body = srcOf(loop);
  assert.match(body, /quietResumePool: run\._quietResumePool/, "循环没把池子喂给判定");
  assert.match(body, /run\._quietResumePool = c\.quietResumePool/, "循环没把扣完的池子写回去");
});

test("搬出去的那条腿，上界还在模块里", async () => {
  // 上面 BUDGET 认 `_qb.action` 是因为预算在 decideQuestionBoundary 里。
  // 那就必须盯着它真的还在 —— 否则这条腿会从"预算搬走了"悄悄变成"预算没了"，
  // 而循环侧的断言看不出任何区别。
  const m = await import("../src/agent/ask-user.js");
  assert.equal(typeof m.ASK_PUSHBACK_LIMIT, "number", "提问腿的上界常量没了");
  assert.ok(m.ASK_PUSHBACK_LIMIT >= 1 && m.ASK_PUSHBACK_LIMIT <= 4,
    `提问腿的上界是 ${m.ASK_PUSHBACK_LIMIT} —— 太大等于没有上界`);
  // 真跑一遍：模型每轮都以问句收尾，必须在有限轮内停。
  //
  // **起点必须是「额度已经攒到推回那一支」**，不能从 0 起：从 0 起的话第一次调用
  // （nextCount=1 < 3）直接就 await_user 了，循环立刻退出，那条预算一次都没被走到 ——
  // 于是把模块里的上界删掉这个变异照样绿（实测过）。卡片提问和正文提问合并计数，
  // 所以 askUserCount 到 2 是很平常的状态。
  let n = 0, run = { askUserCount: 2, pushbacks: 0, planIntercepted: false };
  for (; n < 200; n++) {
    const r = m.decideQuestionBoundary({ planSteps: [], ...run, live: true });
    run = { askUserCount: r.counters.askUserCount, pushbacks: r.counters.pushbacks, planIntercepted: r.counters.planIntercepted };
    if (r.action === "await_user") break;
  }
  assert.ok(n < 200, "提问腿又变成无界自旋了 —— 模型每轮问一句就能一直烧钱");
});
