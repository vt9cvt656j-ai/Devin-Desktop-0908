// 回复底下那行统计里的计时器，任务结束就得停。
//
// 用户实拍：「明明任务都结束了，却还一直在数」。它不是显示错了——那个 setInterval
// 真的还在一秒一跳，而且会一直跳到关掉这个窗口为止。
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFrom, fnSource, SRC } from "./helpers/source.mjs";

test("计时器自己会停，不靠「每条收尾路径都记得调 stop()」", () => {
  // 收尾段里 stop() 前面排着一串会抛的活（写记忆、存盘、渲染建议、改时间线）。任何一处抛
  // 出来，整段收尾就断在那里，计时器没人关——这就是用户看到的「一直在数」。
  // 手工名单治不了这个，判据要结构性的：每一跳问一句「这一轮还活着吗」。
  const fn = fnSource("_liveTurnStats");
  assert.match(fn, /isLive/, "计时器不认「这一轮还活着吗」，只能等别人来关它");
  assert.match(fn, /if \(el && typeof isLive === "function" && !isLive\(\)\) \{ freeze\(\); return; \}/,
    "每一跳没有自检——收尾一旦断在半路，它就永远跳下去");
  // 自停是**冻住**不是删掉：显式 stop() 意味着"最终那行马上就来"，删掉才对；
  // 自停时最终那行可能永远不来（收尾断了），删掉等于把统计整条抹掉。
  const fz = fn.slice(fn.indexOf("const freeze = ()"), fn.indexOf("const tick = ()"));
  assert.match(fz, /clearInterval\(timer\)/, "冻住时没停掉定时器——等于没冻");
  assert.match(fz, /classList\.remove\("turn-stats--live"\)/, "冻住之后还挂着 live 的样式");
  assert.doesNotMatch(fz, /el\.remove\(\)/, "自停时把统计行删了——收尾断了的话，用户什么都看不到");
  // 显式 stop() 仍然要删（最终那行紧接着就渲染出来）。
  const st = fn.slice(fn.indexOf("stop() {"));
  assert.match(st, /if \(el\) el\.remove\(\)/, "显式 stop 不删的话，会和最终那行并排出现两条统计");
});

test("两处创建都把「还活着吗」传进去了", () => {
  // 少传一处，那条路径就退回原来的样子——而且是静默的：不报错，只是数字永远不停。
  //
  // 断言必须切到**这两个创建块里面**去看：`isLive: _live` 在 main.js 里出现 6 次
  //（预检那几处也用同一个判据），按全文匹配的话，把这里删掉照样绿——那就是一条
  // 「断言真实、守的却是别处」的恒真守卫。
  // 按 AST 取这两个参数对象（blockFrom 的锚点不唯一时要显式给 nth，多一处会当场抛错——
  // 那正好也是"新增了第三个创建点却忘了传 isLive"的信号）。
  const blocks = [0, 1].map((nth) => blockFrom("= _liveTurnStats(body, {", { nth }));
  assert.ok(blocks.some((b) => /isLive: _live,/.test(b)), "智能体那条没传");
  assert.ok(blocks.some((b) => /isLive: \(\) => !!sess\.streaming,/.test(b)), "纯对话那条没传");
  assert.ok(blocks.every((b) => /isLive:/.test(b)), "有一处创建没传「还活着吗」——那条路径的计时器永远停不下来");

});

test("耗时定格在内容写完的那一刻，不含收尾", () => {
  // 用户读这个数是「这次回答花了多久」，不是「包括等结算、写盘在内的一切」。
  // 而且这一行必须在 finally 的**最前面**：后面任何一步抛出来，计时器都已经停了。
  const fin = blockFrom("} catch (e) { if (!err) err = String(e); }\n  finally {");
  const head = fin.slice(0, fin.indexOf("clearAgentRetryToast"));
  assert.match(head, /const _contentDoneMs = Date\.now\(\) - _taskStartedAt;/,
    "没有在收尾一开始就定格耗时");
  assert.match(head, /_liveStats\.stop\(\);/, "stop 不在 finally 的最前面——后面一抛就又关不掉了");
  // 最终那行用的就是定格的数，不是"现在几点"。
  assert.equal((SRC.match(/elapsedMs: _contentDoneMs,/g) || []).length, 2,
    "两条路径没有都用定格的耗时（一条是纯对话，一条是智能体）");
  // 门禁拦下那条（blockedBody）压根没起过计时器，它照旧现算，不在这条守卫的范围里。
  const stray = SRC.split("\n").filter((ln) => /elapsedMs: Date\.now\(\) - _taskStartedAt/.test(ln));
  assert.ok(stray.every((ln) => ln.includes("blockedBody")),
    `还有别的地方用「现在几点」算最终耗时（把收尾也算进去了）：\n${stray.join("\n")}`);
});
