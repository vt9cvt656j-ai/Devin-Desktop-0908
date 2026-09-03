// harness 在循环里说的话，收敛到 Claude Code 的形状之后**还剩下什么**，以及每一条
// 为什么还在。
//
// 背景：用户的要求是「全部彻底根治掉，全部全部和 claude code 完全一样，可以删除的，
// 记得删除了也要一样强大」。前半句好办，后半句才是难的——把还扛着东西的删掉，
// 数字好看了，能力没了。
//
// 判据（这一整轮迁移一直用的那把尺子）：
//   · 纯指令（每次都一样的话，零运行时事实）→ 系统提示词 / 工具描述，走缓存前缀；
//   · 运行事实（这一次真的发生了什么）→ 产生它的那条工具结果，或已有的每轮状态块；
//   · 控制流（要让循环再转一圈）→ **搬不动**：提示词说不出「continue」。
//
// 这条测试守两件事：① 剩下的确实只有后两类；② 数量不许悄悄涨回去。
import test from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";
// 走共享的 SRC（helpers/source.mjs），不自己读文件：从 main.js 搬出模块时自读会假红。
import { SRC } from "./helpers/source.mjs";

/** 按 AST 数，不按文本数：这一轮里每一条删除都在注释里写下了被删的类名，
 *  按 grep 数会把那些注释算成注入点（实测多出 8 个）。 */
function pushNudgeCalls(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "CallExpression" && n.callee?.name === "_pushNudge") {
      const a = n.arguments[0];
      out.push({ cat: a?.type === "Literal" ? a.value : null, start: n.start });
    }
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k]);
  })(ast);
  return out;
}

// 每一条剩下的注入，连同它留下来的理由。改动这张表时请连理由一起改——
// 一条没有理由的注入，就是下一次该被搬走的那条。
const FLOOR = {
  // ── 控制流：要让循环再转一圈。提示词里写不出 continue，结构上搬不动。 ──
  toolRepair: { n: 2, why: "control-flow" },   // 工具调用残缺 → 带着修复指令重来
  turnRetry: { n: 1, why: "control-flow" },    // 这一轮模型没产出 → 重试
  buildFix: { n: 1, why: "control-flow" },     // 声明为验证的命令失败 → 不许收尾
  diagFinish: { n: 1, why: "control-flow" },   // 诊断没清零 → 不许收尾
  planFinish: { n: 1, why: "control-flow" },   // 计划没做完 → 不许收尾

  // ── 运行事实：这一次真的发生了什么，且没有更早的通道能带它。 ──
  diag: { n: 2, why: "fact" },                 // 语言服务器/linter 的报告；算它要 await，
                                               // 挪到工具返回值上等于给每一轮加延迟
  stuck: { n: 1, why: "fact" },                // 近 8 次里失败 ≥4 —— 跨调用的聚合，
                                               // 没有任何单条工具结果看得见它
  researchFirst: { n: 1, why: "fact" },        // 这次工程语义要求哪种真实参考、还差哪种
  bugEvidence: { n: 1, why: "fact" },
  probeLoop: { n: 1, why: "fact" },
  directionCheck: { n: 1, why: "fact" },       // 评审给出的走向判断
  dynamicToolRoute: { n: 1, why: "fact" },     // 这一轮的工具窗口刚被改成什么样

  // ── 用户自己的话：不是 harness 在说话。 ──
  steer: { n: 1, why: "user" },
};
// 类名是算出来的那两条：ask_user 边界裁决（控制流）和 churn:<路径>（按文件的盲改计数）。
const DYNAMIC_EXPECTED = 2;

test("循环里 harness 说的话已经收敛到地板，且不许悄悄涨回去", () => {
  const calls = pushNudgeCalls(SRC);
  const byCat = new Map();
  let dynamic = 0;
  for (const c of calls) {
    if (c.cat == null) { dynamic++; continue; }
    byCat.set(c.cat, (byCat.get(c.cat) || 0) + 1);
  }

  const unexpected = [...byCat.keys()].filter((k) => !FLOOR[k]);
  assert.deepEqual(unexpected, [],
    `新增的注入没有登记理由：${unexpected.join("、")}。\n`
    + "先按上面那把尺子分类：纯指令进提示词/工具描述，运行事实挂到产生它的工具结果上，\n"
    + "只有真正的控制流才留在循环里——并在 FLOOR 里写下它留下来的理由。");

  for (const [cat, spec] of Object.entries(FLOOR)) {
    const got = byCat.get(cat) || 0;
    assert.ok(got <= spec.n,
      `${cat} 的注入点从 ${spec.n} 涨到了 ${got}——同一件事开始在两个地方说了。`);
  }
  assert.equal(dynamic, DYNAMIC_EXPECTED, "类名算出来的那两条：ask_user 边界 + churn:<路径>");

  // 总量闸：这一轮从 25 个降到 17 个。往回涨要先解释清楚。
  assert.ok(calls.length <= 17,
    `注入点 ${calls.length} 个，超过地板 17。`);
});

test("已经搬走的那些，不许再回到循环里", () => {
  const cats = new Set(pushNudgeCalls(SRC).map((c) => c.cat));
  // 每一条后面是它搬去了哪儿——回归时按这个去核对，而不是重新加一条注入。
  const MOVED = {
    investigate: "edit_file / multi_edit 的工具描述（先读再改）",
    blindEdit: "write_file 的工具描述 + _blindOverwritePrecheck 落盘前拦截",
    toolReminder: "agent_core §4（工具窗口会变，早先看到的清单不是上限）",
    planNudge: "update_plan 的工具描述（改动铺开到三个文件就该先落计划）",
    planRefresh: "〔执行状态〕块 _planStateLineText 的 ahead 段",
    planStale: "〔执行状态〕块 _planStateLineText 的 _planSigStaleOps 段",
    subagentResult: "_pushRunFact 那条完整报告（指针并进去了）",
    recovery: "_toolMsgForModel 生成失败工具结果时拼在正文末尾的 [RECOVERY:…]",
    cmdFail: "失败命令自己的工具结果",
    design: "design_components.txt（语义画像路由的条件层）",
    verifyNow: "[本轮交付事实] 块",
    writeFacts: "[本轮交付事实] 块",
  };
  for (const [cat, where] of Object.entries(MOVED)) {
    assert.ok(!cats.has(cat), `${cat} 又出现在循环里了；它已经搬到：${where}`);
  }
});
