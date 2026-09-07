import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";
import { planFactLands } from "../src/agent/plan-fact-note.js";

// 所有者决定（2026-09-04）：「update_plan 要根据模型觉得要不要用，而不是直接触发的，
// 我是按照 claude code 走的」。Claude Code 的 TodoWrite 没有任何运行时拦截去逼模型先列待办。
//
// 而这里原来有全系统**唯一**一道硬拦回合的门：从零建东西的第一次落盘且本轮无计划时，
// 把工具调用换成 [BLOCKED_PLAN_FIRST] 假结果打回去。它和 update_plan 自己的描述**直接矛盾**
// ——描述里逐字写着「most requests need no plan at all, and a plan that lists work the user
// did not ask for is worse than no plan」，判断权已经完整交给模型了，动手时又被打回来。

const gate = load("_planBeforeBuildIssue", {
  _implementationGroundingCandidate: () => true,
  _introducesNewTech: () => false,
  fileEditTypes: () => new Set(["write", "edit", "multiedit"]),
  _implementationGroundingFilePath: () => true,
});
const build = (extra) => ({ mode: "agent", engineering: { projectScope: true }, ...extra });
const write = { type: "write", path: "src/app.ts", content: "x" };

test("事实还在说，但话术不许再谎称「没有执行」", () => {
  const note = gate(build(), write);
  assert.ok(note, "这个观测事实不该被一起删掉——它是真的");
  assert.match(note, /照常执行/);
  assert.match(note, /你自己判断/, "判断权要明确交回模型");
  assert.doesNotMatch(note, /BLOCKED_PLAN_FIRST/, "硬拦的 failure code 回来了");
  assert.doesNotMatch(note, /没有执行|一个字节都没改|原样重发/, "硬拦的话术回来了");
});

test("执行路径上：计划这一支不再把调用换成假结果", () => {
  assert.match(CODE, /if \(_planFirst\) \{\s*\n\s*it\._planFactNote =/,
    "计划门还在走「换成 blocked 假结果」那条路");
  assert.match(CODE, /const _it = items\[_i\], _note = _it\?\._planFactNote;/,
    "事实存下了却没人读——等于既不拦也不说，两头落空");
  assert.match(CODE, /toolMsgs\[_i\]\.content = String\(toolMsgs\[_i\]\.content \|\| ""\) \+ _note/,
    "没挂到那次调用自己的结果上");
});

test("查包那道门保持硬拦——它和「要不要写待办」不是一回事", () => {
  // tech_research 说的是「你要引一个没查过的第三方依赖」，那是真该先查。
  assert.match(CODE, /run\._techResearchStopUsed = true;/);
  assert.match(CODE, /_settleToolStep\(it\.step, blocked, "先查一下再选"\)/,
    "查包门的话术被计划门的降级带走了");
  assert.doesNotMatch(CODE, /_planFirst \? "先写计划再动手" : "先查一下再选"/,
    "两道门又合流了——计划门已经不拦，不该再共用同一条打回路径");
});

test("守的东西一个没少：只触发一次、不碰改已有代码、不认派生量", () => {
  assert.equal(gate(build({ _planStopUsed: true }), write), "", "一个 run 只说一次");
  assert.equal(gate(build({ _planSteps: [{ status: "pending" }] }), write), "", "有计划就不用说");
  assert.equal(gate({ mode: "agent", engineering: { bug: true } }, write), "", "改 bug 不该被念");
  assert.equal(gate({ mode: "agent", engineering: { substantial: true } }, write), "",
    "substantial 是 harness 的派生量，不许拿它当判据");
  // intentSource 挂在 run.engineering 上（源码里那句注释专门说明了为什么写在 run.engineering
  // 而不是解构出来的 p 上：元测试按白名单扫 p.*，而 intentSource 是裁决的到场状态、不是维度）。
  assert.equal(gate({ mode: "agent", engineering: { projectScope: true, intentSource: "fast" } }, write), "",
    "快通道画像不许驱动它");
});

test("update_plan 的描述本来就把判断权给足了——这次是让代码别再覆盖它", () => {
  assert.match(CODE, /most requests need no plan at all/);
  assert.match(CODE, /a simple one-step change does not need the ceremony/);
  // 描述里那条软规则（铺开到三个以上文件还没计划就先落一个）由模型自己执行，不由门强制
  assert.match(CODE, /three or more files and you still have no plan/);
});

// ——那句「照常执行了」是在工具执行**之前**定下的，追加却发生在整批工具落定之后。
// 中间三条路会让它变成假话，而这三条路都不是假想：同批门拦是 2026-08-23 用户现场
// （README 编辑 + chmod）的镜像，抛异常和写入被拒是每天都在走的分支。
test("事实只在这次调用真跑过时才说得出口", () => {
  const note = "\n\n[无计划的首次落盘] …这次调用照常执行了…";
  const msg = { role: "tool", content: "已写入 src/app.ts" };
  assert.equal(planFactLands({ note, msg, blocked: false, succeeded: true }), true,
    "真跑过还不说，这条降级就退化成既不拦也不说，两头落空");
  assert.equal(planFactLands({ note, msg, blocked: true, succeeded: true }), false,
    "同批被门拦下的调用，正文是门拦话术，后面不许再跟一句「照常执行了」");
  assert.equal(planFactLands({ note, msg, blocked: false, succeeded: false }), false,
    "抛异常/写入被拒的调用同理——harness 不许说反话");
  // succeeded 有第三种取值：判不出来（undefined）。判不出来不等于失败，照说。
  assert.equal(planFactLands({ note, msg, blocked: false, succeeded: undefined }), true,
    "把「判不出成败」当成失败，等于让这条事实在多数工具上永远沉默");
  assert.equal(planFactLands({ note: "", msg, blocked: false, succeeded: true }), false);
  assert.equal(planFactLands({ note, msg: null, blocked: false, succeeded: true }), false,
    "没有对应的工具消息就没有挂载点");
  assert.equal(planFactLands(), false, "裸调用不许抛");
});

test("「一个 run 只说一次」的配额烧在说出口那一刻", () => {
  // 设值点不许再置位：设值到追加之间有三条路会把事实整条丢掉（同批门拦、抛异常、
  // _live 转假后的 break），配额在那儿白吃，本 run 就再也不说第二次——和这道门当初
  // 「硬拦配额被一次 README 编辑用掉」是同一个病。
  const setSite = CODE.slice(CODE.indexOf("if (_planFirst) {"), CODE.indexOf("run._techResearchStopUsed"));
  assert.doesNotMatch(setSite, /_planStopUsed/, "配额又烧回设值点了");
  const appendSite = CODE.slice(CODE.indexOf("const _it = items[_i], _note = _it?._planFactNote;"));
  assert.match(appendSite.slice(0, 400), /toolMsgs\[_i\]\.content = [^\n]*\+ _note;\s*\n\s*run\._planStopUsed = true;/,
    "配额没烧在追加成功之后");
});
