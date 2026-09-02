// 中断/停止时的**成绩单**：显示侧和状态侧各归各的。
//
// 用户实拍：一轮跑到一半被中断，聊天记录末尾多出一条
//   〔中断前的写入结果〕本次运行已经真实写入磁盘：…server.py、…session.py
// 这条是 harness 写的字，被当成模型正文拼进了可见消息。用户的原话：
//   「即使中断也要显示完整的聊天记录，而不是就说中断了然后 xxx 了，这样是不正确的。」
//
// 定的两条性质：
//   1. 显示侧：中断那一轮的**真实流式正文**（turn.text）照旧先入账再 break，一个字不丢；
//      而那条〔中断前的写入结果〕页脚**不再**拼进可见消息（summaryText）。
//   2. 状态侧：「中断前改了哪些文件」这件事没丢——它记成状态（run._breakWriteFact →
//      _lastRunState.breakWriteFact → 续跑时的 run._resumeFact），照样喂给模型，
//      让它「别重写已落盘的文件」。删显示不等于砍掉模型的通道。
//
// 中断路径深埋在 _runAgenticLoop 里、没法在 Node 里真跑，所以这里按源码锚点断言
// （与 prefix-cache.test.mjs 里那组同源）。锚点尽量挑实现特征，不挑说明词。
import test from "node:test";
import assert from "node:assert/strict";
import { SRC, fnSource } from "./helpers/source.mjs";

test("中断/停止：真实正文仍先入账再 break（完整聊天记录不丢）", () => {
  // 用户点停止那一轮：turn.text 必须在 break **之前**收进 run 摘要。
  assert.match(SRC,
    /if \(!_live\(\)\) \{[\s\S]{0,900}summaryText \+= \(summaryText \? "\\n\\n" : ""\) \+ turn\.text\.trim\(\);[\s\S]{0,900}break;/,
    "按停止那一轮的真实正文没有先入账——中断后聊天记录里会少掉这段");
});

test("〔中断前的写入结果〕页脚不再拼进可见消息", () => {
  // 关键回归闸：那条页脚是 _settleEagerWritesForBreak 造的，以前三处 break/插话都把它
  // `summaryText += … + _eagerNote` 进可见消息。现在一处都不许有。
  assert.doesNotMatch(SRC, /summaryText \+= \(summaryText \? "\\n\\n" : ""\) \+ _eagerNote/,
    "又把〔中断前的写入结果〕页脚拼回可见消息了——它是 harness 写的字，不该冒充模型正文");
  // 更广的闸：任何给 summaryText 赋值的行都不许带上写盘页脚（不管换成 _breakWriteFact
  // 还是直接拼字面量）。summaryText 是可见/落库的助手消息，页脚只能进状态。
  const badLine = SRC.split("\n").find((ln) =>
    /summaryText\s*(\+?=)/.test(ln) && /_eagerNote|_breakWriteFact|中断前的写入结果/.test(ln));
  assert.equal(badLine, undefined,
    `有一行把写盘页脚拼进了可见消息 summaryText：${badLine || ""}`);
});

test("写盘事实的收账不许再靠「枚举 break 点」——finally 里必须有一条兜底", () => {
  // 【这条测试换过判据。旧版断的是「至少三个调用点」——而**一个数够三个的断言，结构上
  //   不可能发现缺的是第四条路**。它确实一直绿着，而漏掉的恰恰是最常见的那条：
  //   用户在**工具批次执行途中**按停（main.js 那句 `for (const m of toolMsgs) messages.push(m);`
  //   后面的 break）。那条路上 run._breakWriteFact 从没被写过 → 收尾落成空串 →
  //   下一轮 run._resumeFact 为空 → 「别重写已落盘文件」压根不生成。
  //   补第四个调用点治标：这个循环的退出路径还有轮间按停、静默轮按停、预算耗尽、异常。
  //   判据因此改成「finally 里有没有一条覆盖所有路径的兜底」。】
  const loop = fnSource("_runAgenticLoop");
  const fin = loop.slice(loop.indexOf("\n  finally {"));
  assert.ok(fin.length > 200, "_runAgenticLoop 的 finally 段没找到，这条守卫要跟着改");
  assert.match(fin, /_settleEagerWritesForBreak\(run\)/,
    "finally 里没有兜底收账 —— 又回到「逐条枚举 break 点」，而那份清单没人维护得全");
  // 兜底必须只在**真没跑完**时做（和 breakWriteFact 落库那句同源），否则正常收尾也白等一次在途写入。
  assert.match(fin, /finalErr \|\| _stoppedEarly \|\| run\._incompleteReason/,
    "兜底没有按「确实没跑完」门控");
  // 已经算出来的不许被覆盖：那几条更近、带各自的上下文。
  assert.match(fin, /!run\._breakWriteFact/, "兜底会覆盖掉更近的那条结算结果");

  // 逐条结算点仍然要把 note 记成状态，不拼进可见正文。
  assert.ok((SRC.match(/if \(_eagerNote\) run\._breakWriteFact = _eagerNote;/g) || []).length >= 3,
    "结算点没有把写盘事实记成 run._breakWriteFact 状态");
});

test("工具批次执行途中按停：那条 break 也要收账", () => {
  // 用户最常按停的时刻就是这里——界面上工具正在跑。模型吐字的时候没人点停止。
  // 这条路补 [interrupted] 工具结果、把它们推进 messages、然后 break；
  // 而流完即写在参数流完那一刻**已经落盘**，磁盘是真变了的。
  const loop = fnSource("_runAgenticLoop");
  const at = loop.indexOf("for (const m of toolMsgs) messages.push(m);");
  assert.ok(at > 0, "工具批次的中断分支改写了，这条守卫要跟着改");
  // 从那一行到它所属 if 块结束（下一个 `break;`）之间，必须出现结算调用。
  const tail = loop.slice(at, loop.indexOf("break;", at) + 6);
  assert.match(tail, /_settleEagerWritesForBreak\(run\)/,
    "工具批次途中按停这条路没有收账 —— run._breakWriteFact 会是空的，"
    + "下一轮模型不知道自己已经落过盘，会把同一个文件从头重写一遍");
  assert.match(tail, /run\._breakWriteFact = /, "算出来了却没记成状态");
});

test("状态只在真没跑完时留存，正常收尾（哪怕插过话）不留", () => {
  // _lastRunState.breakWriteFact 用「本轮确实没跑完」门控，否则新任务会莫名收到
  // 「上一轮中断前已落盘」。门控用的就是收尾判据里现成的那三个信号。
  assert.match(SRC,
    /breakWriteFact: \(finalErr \|\| _stoppedEarly \|\| run\._incompleteReason\)[\s\S]{0,160}run\._breakWriteFact/,
    "_lastRunState.breakWriteFact 没有按「确实没跑完」门控，正常收尾也会误带写盘事实");
});

test("续跑时写盘事实照样喂给模型（删了显示没砍掉模型通道）", () => {
  // 同会话「停止→继续」走不到崩溃重启那条 _wfInterrupted，所以另补一条 run._resumeFact，
  // 从 _lastRunState.breakWriteFact 取，走每轮必注入的〔执行状态〕。crash 路已置则不覆盖。
  const seed = SRC.slice(SRC.indexOf("session?._lastRunState?.breakWriteFact"));
  assert.ok(seed, "找不到同会话续跑的写盘事实种子——续跑时模型会不知道哪些文件已落盘");
  assert.match(seed.slice(0, 400), /run\._resumeFact = /,
    "写盘事实没有接到 run._resumeFact 这条每轮必注入的通道上");
  assert.match(seed.slice(0, 400), /不要重做|别重写|不要整份重写/,
    "续跑提示没有告诉模型「别重写已落盘文件」");
  // 不能盖掉崩溃重启那条（那条更准，带步号）。
  assert.match(SRC, /!run\._resumeFact && session\?\._lastRunState\?\.breakWriteFact/,
    "同会话续跑的种子没有让崩溃重启那条优先");
});
