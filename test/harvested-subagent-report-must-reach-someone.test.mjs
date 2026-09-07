import test from "node:test";
import assert from "node:assert/strict";
import { CODE } from "./helpers/source.mjs";

// 后台子智能体的报告只有一条正常投递路：主循环**下一次迭代开头**的自动交付。
// 模型静默收尾时循环直接 break，没有下一次迭代 —— 于是收尾处加了「补收」。
// 但补收用的是 _pushRunFact，而它往**本次请求体**的 messages 里塞；那段代码在 finally 里，
// 循环已经退出、最后一次模型调用早已返回，那个数组再没有任何读者。
// 结果：几十轮模型调用的钱照付，报告就摆在 job.result 里，模型和用户一个字都拿不到。

test("补收到的报告存进跨得出这一轮的载体，不只是 push 进死数组", () => {
  assert.match(CODE, /\(run\._harvestedSubagentReports \|\|= \[\]\)\.push\(_harvested\);/,
    "只 _pushRunFact 的话，finally 里那次调用等于空操作");
  assert.match(CODE, /subagentReports: \(run\._harvestedSubagentReports \|\| \[\]\)\.slice\(-3\)/,
    "没落进 session._lastRunState —— 出了这一轮就没了");
});

test("下一轮真的取出来，并进每轮必注入的〔执行状态〕块", () => {
  assert.match(CODE, /run\._subagentCatchUp = `上一轮结束时有 \$\{session\._lastRunState\.subagentReports\.length\} 份子智能体报告/,
    "存了却没人取");
  assert.match(CODE, /if \(run\._subagentCatchUp\) _parts\.push\(run\._subagentCatchUp\);/,
    "取了却没进那个块 —— 和存在死数组里没区别");
  // 那个块本身是有触发条件的：只有"这一轮有活动"才发。补收必须能自己撑起这个条件，
  // 否则一轮纯问答之后报告照样送不出去。
  assert.match(CODE, /_planLine \|\| run\._resumeFact \|\| run\._subagentCatchUp\)/,
    "没进触发条件——上一轮派了子体、这一轮只是问一句话，报告又沉底了");
});

test("送达一次就清空，不会每轮重复念", () => {
  // subagentReports 是**每轮无条件重写**的（没有就是空数组），所以送达过一次之后
  // 下一轮自然为空。写成"只在有值时才写"就会一直留着，每轮念一遍同一份报告。
  const at = CODE.indexOf("subagentReports: (run._harvestedSubagentReports");
  assert.ok(at > 0);
  const line = CODE.slice(at, CODE.indexOf("\n", at));
  assert.doesNotMatch(line, /\?|&&/, "写成了条件写入——报告会每轮重复注入");
});

test("有上限：最多 3 条、每条 1200 字", () => {
  // 它是"接着往下做"的线索，不是存档。不封顶的话一次派十个子体就能把尾部注意力位占满。
  assert.match(CODE, /\.slice\(-3\)\.map\(\(t\) => String\(t\)\.slice\(0, 1200\)\)/);
});
