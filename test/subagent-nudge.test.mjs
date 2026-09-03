// 子智能体交付 + 编排提醒（nudge）+ 单次运行 token 预算。
//
// 这三件事共用主循环里同一块地方，病也是同一种：**把"事实"托付给了一个随时会被撤走的
// 载体，或者在事实还没落地的时候就去读它**。
//
//   · 子体报告走默认异步路时被压成一行、裁到 ≤1200 字，投递载体又是 nudge（同类重发删旧、
//     距尾 >14 条清扫、_clearNudges 整条删）——主 run 为子体付了几十个模型轮次，留下的是
//     10% 的单行摘要，而且几轮后它从上下文里消失。
//   · nudge 每轮从消息**中段** splice，和本文件自己写下的棘轮原则（历史只进不摆）打架：
//     每删一条，上游前缀缓存从那一点起全失效，重新计费的是它后面的整段历史。
//   · token 预算累加的是"上一轮"的读数：结算是后台任务，读的时候还没落地，于是判定整体
//     错位一轮，第一轮读到的还是上一个 run 的尾数。
//   · 子体的 search_tools 三种相反结局（装上了 / 全在沙箱外 / 一个都没有）全画成绿色「完成」。
//
// 断言一律跑在 CODE（剥注释的源码）：注释里引用一段已经删掉的旧代码就能把正向断言喂绿。
// 需要定位器和要拿去 new Function 跑的片段用 RAW_SRC（原文）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, SRC as RAW_SRC, fnSource, load } from "./helpers/source.mjs";
import { NUDGE_GATE_EXEMPT } from "../src/agent/nudge-gate.js";

const clip = () => load("_clipPreservingErrors", {
  _headTailModelText: load("_headTailModelText"),
  _hasErrorLine: load("_hasErrorLine"),
});

// 一份"真实形状"的子体简报：结论段 + 空行 + 证据清单（path:line）+ 空行 + 根因。
// 行结构本身就是内容——压成一行之后 _clipPreservingErrors 按行做的错误行豁免同时作废。
const REPORT = [
  "结论：登录在 Safari 上必失败，原因是 cookie 的 SameSite=None 没有配 Secure。",
  "",
  "证据清单：",
  ...Array.from({ length: 140 }, (_, i) => `· src/auth/session.ts:${100 + i} 设置 cookie 时缺 Secure`),
  "",
  "[ERROR] 复现命令 npm run e2e:safari 退出码 1",
  "",
  "下一步：改 session.ts 的 cookieOptions，然后重跑 e2e:safari。",
].join("\n");

// ── ① 自动交付：完整报告进历史，nudge 只做通知 ────────────────────────────────
const gateSource = () => {
  const start = RAW_SRC.indexOf("// === P2.1 结果自动交付");
  const end = RAW_SRC.indexOf("// ── 空项目行动门禁①");
  assert.ok(start > 0 && end > start, "自动交付 gate 的锚点没了");
  return { start, end, src: SRC.slice(start, end) };
};

test("子体报告：完整报告作为持久事实进历史，nudge 只带首段结论和取回指针", () => {
  const { src } = gateSource();
  // 这个门只能拿到 run / _pushNudge / _clipPreservingErrors 三个外部名字（logic.test.mjs
  // 也是这么执行它的），所以完整报告的投递必须走 run 上挂着的助手，不能直接摸 messages。
  const gate = new Function("run", "_pushNudge", "_clipPreservingErrors", src);
  const facts = [];
  const pushes = [];
  const run = {
    _pushRunFact: (content) => facts.push(content),
    _subAgentJobs: new Map([[1, { id: 1, desc: "调研登录", status: "done", result: REPORT, consumed: false }]]),
  };
  gate(run, (cat, msg) => pushes.push([cat, msg]), clip());

  assert.equal(facts.length, 1, "完整报告必须单独落一条持久消息");
  assert.match(facts[0], /job#1 完成·调研登录·完整报告/);
  assert.ok(facts[0].includes("\n· src/auth/session.ts:100"),
    "完整报告被压成一行了：证据清单的行结构没了，_clipPreservingErrors 按行做的错误行豁免同时作废");
  assert.ok(facts[0].length > 2000,
    `完整报告被裁到 ${facts[0].length} 字——预算必须够装下一份真简报，不是 1200 字摘要`);
  assert.match(facts[0], /src\/auth\/session\.ts:239/, "证据清单末尾的行号也要在");
  assert.match(facts[0], /\[ERROR\] 复现命令/, "错误行豁免");

  // **一条消息，不是两条**（2026-09-02）。
  //
  // 原来还有一条 `_pushNudge("subagentResult", …)` 带「首段结论 + 取回指针」，
  // 而那个首段就是完整报告的第一段 —— 逐字重复。唯一独有的是取回指针，已经并进
  // 事实消息本身。所以这里改成：nudge 一条都不推，指针和结论都在那条持久事实里。
  assert.equal(pushes.length, 0, "子体产出又开始额外推一条提醒了 —— 同一段结论会出现两遍");
  assert.match(facts[0], /await_subagent job=1/, "取回指针丢了：模型没法再取一次完整报告");
  assert.match(facts[0], /结论：登录在 Safari/, "首段结论必须在（它本来就是报告的第一段）");
  assert.equal(run._subAgentJobs.get(1).consumed, true);

  // 并发多份时预算摊薄，一次交付的总量有界——证据进历史，但不是无上限地进。
  assert.match(src, /Math\.min\(8000, Math\.max\(2000, Math\.floor\(16000 \/ _settledJobs\.length\)\)\)/,
    "完整报告的预算要有界：单份对齐同步路 8000，并发多份摊薄");
});

test("自动交付不再把报告压成一行——按行做的错误行豁免要还成立", () => {
  const { src } = gateSource();
  assert.doesNotMatch(src, /replace\(\/\\s\+\/g, " "\)/,
    "又把子体报告压成一行了：_clipPreservingErrors 的错误行豁免是 split(/\\r?\\n/) 做的，压完就废");
});

test("完整报告的载体不进 nudge 注册表——三条删除路径都够不着它", () => {
  const src = fnSource("_pushRunFact", { code: true });
  assert.match(src, /messages\.push\(/, "它得真把消息推进历史");
  assert.doesNotMatch(src, /_nudgeReg/,
    "一旦注册进 _nudgeReg，同类重发 / 14 条清扫 / _clearNudges 就能把这份证据整条删掉");
  assert.match(SRC, /run\._pushRunFact = _pushRunFact/, "得挂到 run 上，门那一侧才够得着");
});

// ── ② await_subagent：模型显式来取时，取回的是报告本身 ──────────────────────
const awaitBranch = () => {
  const start = RAW_SRC.indexOf('call.type === "awaitsubagent"');
  assert.ok(start > 0, "awaitsubagent 分支的锚点没了");
  const bodyStart = RAW_SRC.indexOf("{", start) + 1;
  const end = RAW_SRC.indexOf('} else if (call.type === "openapi_parser")', start);
  assert.ok(end > bodyStart);
  return SRC.slice(bodyStart, end);
};

test("await_subagent 取回完整报告：预算对齐同步路，不压空白，总量不再砍到 3200", async () => {
  const body = awaitBranch();
  const exec = new Function("call", "run", "res", "_clipPreservingErrors", "t",
    `return (async () => { const _endRunCollaborationSession = () => false; ${body} })();`);
  const job = { id: 1, desc: "调研登录", status: "done", startedAt: Date.now(), result: REPORT, consumed: false, promise: Promise.resolve() };
  const run = { _subAgentJobs: new Map([[1, job]]) };
  const out = await exec({ type: "awaitsubagent", job: "1" }, run, {}, clip(),
    (k, p) => String(k).replace(/^.*\./, "") + (p && p.count != null ? " " + p.count : ""));

  assert.match(out.content, /\[job#1 完成·调研登录\]/);
  assert.ok(out.content.includes("\n· src/auth/session.ts:100"),
    "换行被压掉了：证据清单 (path:line) 的行结构是内容本身");
  assert.match(out.content, /src\/auth\/session\.ts:239/, "报告尾部被 3200 砍掉了");
  assert.ok(out.content.length > 3200,
    `取回的报告只有 ${out.content.length} 字——把每份放大到 8000 之后又按 3200 砍一刀等于白做`);
});

test("await_subagent 的报告预算按并发份数摊，仍然有界", () => {
  const body = awaitBranch();
  assert.match(body, /Math\.max\(2000, Math\.floor\(8000 \/ _targets\.length\)\)/,
    "每份报告的预算要跟着并发份数摊，且有下限");
  assert.doesNotMatch(body, /replace\(\/\\s\+\/g, " "\), Math\.min\(1200/,
    "又回到「压成一行 + 1200 字」了");
});

// ── ③ 子体 search_tools 的卡片标签 ─────────────────────────────────────────
test("子体 search_tools：三种相反的结局给三种标签，不再全是绿色「完成」", () => {
  const label = load("_subAgentSearchToolsLabel");
  assert.match(label(["read_file", "grep"], []), /已加载 2/);
  assert.match(label([], ["deploy_site", "git_push"]), /沙箱外 2/);
  assert.match(label([], ["deploy_site"]), /交回主任务/, "全在沙箱外时要说清去向");
  const both = label(["read_file"], ["git_push"]);
  assert.match(both, /已加载 1/);
  assert.match(both, /沙箱外 1/);
  assert.equal(label([], []), "无匹配");
  assert.equal(label(undefined, undefined), "无匹配", "拿不到数组时也得给出结局，不能崩");

  // 三种正文一个失败词都不含 → _settleToolStep 的正文扫词判不出区别，标签必须自己传。
  const failed = /\[(?:ERROR|BLOCKED|DENIED|失败|不可用|interrupted|未执行)\]|失败|缺参数|未知工具|已停止/i;
  for (const text of [
    "已加载工具：read_file、grep。下一步直接调用。",
    "以下工具超出子任务沙箱，不能在这里执行；如确实需要，在最终报告里请父智能体处理：git_push",
    "没有匹配的工具。用现有工具完成，或在最终报告里说明缺少的能力。",
  ]) assert.equal(failed.test(text), false, "前提变了：这条正文现在能被扫词判成失败");

  assert.match(SRC, /_settleToolStep\(_stStep, \{ type: "search_tools", path: "", content: _stContent \}, _stLabel\)/,
    "子体的 search_tools 又不传标签了");
  assert.match(SRC, /_stLabel = _subAgentSearchToolsLabel\(_stAdmitted, _found\.outside\)/,
    "标签必须跟着已经判明的分支走，不需要新判据");
  assert.match(SRC, /_stLabel = "搜索出错"/, "搜索抛错那条也要有自己的标签");
});

// ── ④ nudge 棘轮：历史只进不摆 ────────────────────────────────────────────
const mkHistory = (n) => Array.from({ length: n }, (_, i) => ({ role: "assistant", content: `turn-${i}` }));

test("陈旧提醒只注销、不从消息中段 splice——中段删一条就把它后面的整段历史踢出前缀缓存", () => {
  const messages = mkHistory(3);
  const stale = { role: "user", content: "〔提醒〕旧的" };
  messages.push(stale);
  messages.push(...mkHistory(20)); // 距尾远超 14 条
  const reg = new Map([["diag", stale]]);
  const sweep = load("_sweepNudges", { messages, _nudgeReg: reg });
  const before = messages.length;

  sweep();
  assert.equal(reg.has("diag"), false, "陈旧提醒必须退出管理：不再占活跃名额、不再挡同类刷新");
  assert.equal(messages.length, before, "它已经付过 token 了，从中段删掉只会让前缀缓存从那点起失效");
  assert.equal(messages.indexOf(stale), 3, "而且不许挪位置");

  // 已经不在 messages 里的条目照旧从注册表清掉（_clearNudges 走过之后的残留）。
  const orphan = { role: "user", content: "被 _clearNudges 摘掉了" };
  reg.set("gone", orphan);
  sweep();
  assert.equal(reg.has("gone"), false);
});

/**
 * _pushNudge 现在还要两个依赖：`run`（往它上面记这一轮推了几条、哪几类）和
 * `_harnessNudgesEnabled`（总闸）。加它们是为了让「34 类提醒到底帮了多少」第一次能被量 ——
 * 用户报的「简单事情也长篇大论 / 一个任务 27 步 / 190 万输入 token」很可能就是它们叠出来的，
 * 而 Claude Code 的循环里 harness 对模型说的话是 0 条。
 *
 * load() 的依赖清单是**手工**的：函数体里多一个自由标识符就是 ReferenceError（不是断言失败，
 * 是整条用例炸）。抽成工厂，免得每个用例各写一份、下次再漏。
 * 每次调用返回**新的** run 对象：计数是累加的，共用一个会让用例之间互相污染。
 */
const NUDGE_DEPS = (on = true) => ({ run: {}, _NUDGE_GATE_EXEMPT: NUDGE_GATE_EXEMPT, _harnessNudgesEnabled: () => on });

test("同类提醒重发：只有本轮尾部区间里的旧条才 splice，更早的留在原地", () => {
  const _nudgeRank = () => 1; // 全按事实类，避开淘汰逻辑，这条只看同类替换
  const _ORCH_NOTE = "〔编排〕";

  // A) 旧条在本轮尾部区间之内（同一轮里推了两次）→ 换掉，消息不增长。
  {
    const messages = mkHistory(5);
    const reg = new Map();
    const push = load("_pushNudge", { messages, _nudgeReg: reg, _nudgeRank, _ORCH_NOTE, _nudgeTurnFloor: 5, ...NUDGE_DEPS() });
    push("diag", "第一次");
    const afterFirst = messages.length;
    push("diag", "第二次");
    assert.equal(messages.length, afterFirst, "同一轮里的旧条就在尾部，替换掉它不动历史");
    assert.match(messages[messages.length - 1].content, /第二次/);
  }

  // B) 旧条落在更早的轮次（本轮尾部区间起点之前）→ 留在原地，新条追加。
  {
    const messages = mkHistory(5);
    const reg = new Map();
    const pushEarly = load("_pushNudge", { messages, _nudgeReg: reg, _nudgeRank, _ORCH_NOTE, _nudgeTurnFloor: 5, ...NUDGE_DEPS() });
    pushEarly("toolReminder", "第 12 轮的目录刷新");
    const old = messages[messages.length - 1];
    messages.push(...mkHistory(6)); // 中间隔了模型轮和工具结果
    const floor = messages.length;
    const pushNow = load("_pushNudge", { messages, _nudgeReg: reg, _nudgeRank, _ORCH_NOTE, _nudgeTurnFloor: floor, ...NUDGE_DEPS() });
    pushNow("toolReminder", "第 24 轮的目录刷新");

    assert.ok(messages.includes(old), "旧条被从中段抠走了——每 12 轮抠一次，前缀缓存每 12 轮塌一次");
    assert.equal(messages.indexOf(old), 5, "旧条不许挪位置");
    assert.match(messages[messages.length - 1].content, /第 24 轮/);
    assert.equal(reg.get("toolReminder"), messages[messages.length - 1], "注册表要指向最新那条");
  }
});

test("超额淘汰在尾部照样摘掉，但不许伸进历史中段", () => {
  // 这条原来的理由是「淘汰只发生在活跃条目之间，它们都在尾部」——**不成立**。
  // _nudgeReg 跨轮存活，它里面那条是「这个类别上次触发时」推的。toolReminder 每 12 轮
  // 才推一次，所以第 13 轮去淘汰它时，那条在十几轮之前，位置在消息中段。从中段抠掉一条
  // 两百字的提醒，上游前缀缓存从那一点起全部失效，重新计费的是它后面的整段历史。
  //
  // 所以两件事都要：**尾部区间内照样摘**（gate-tristate 钉着「不能只从注册表删」，
  // 那条仍然成立，收敛行为一字不变），**更早的留在原地当历史**（它们隔了十几轮，
  // 早就不构成「同时挂一堆提醒逼模型逐条表态」那个问题了）。
  // 按**内容边界**切，不用固定字符窗口：注释剥离器把注释换成等长空格，
  // 函数上多写几行说明就会把窗口撑爆，断言静默失配（本仓库踩过好几次）。
  const src = fnSource("_pushNudge", { code: true });
  const at = src.indexOf("const _dropNudge");
  assert.ok(at >= 0, "_dropNudge 被改名或挪走了");
  const body = src.slice(at, src.indexOf("_nudgeReg.delete(victim)", at));
  assert.ok(body, "切不到 _dropNudge 的函数体");
  assert.match(body, /messages\.splice\(oi, 1\)/, "超额淘汰不再把条目从 messages 摘掉了");
  assert.match(body, /oi >= _nudgeTurnFloor\) messages\.splice\(oi, 1\)/,
    "淘汰没有被尾部区间守着——它会伸进历史中段，把整段前缀缓存作废");
});

// ── ⑤ 单次运行 token 预算 ─────────────────────────────────────────────────
test("run 用量读的是本 run 自己的结算账，不是挂在 session 上的「上一轮」", () => {
  const tokens = load("_runUsageTokens");
  assert.equal(tokens({ in: 100, out: 20, cacheRead: 5, cacheCreation: 1 }), 126);
  assert.equal(tokens(null), 0, "run 刚起步、账本还没建时不能崩");
  assert.equal(tokens({}), 0);

  assert.match(SRC, /run\._tokens = _runUsageTokens\(session\._runUsage\)/,
    "又回去累加 session._lastTurnTokens 了：那是上一轮（首轮是上一个 run 尾轮）的读数");
  assert.doesNotMatch(SRC, /run\._tokens = \(run\._tokens \|\| 0\) \+ \(session\._lastTurnTokens \|\| 0\)/,
    "逐轮累加一个滞后一轮的字段 = 判定整体错位、最后一轮永远不计入");
  // 窗口从 400 放宽到 1200：_runUsage 初始化里后来挂了 run 级计费单价（prices，给费用
  // 拆解用）并带一段注释，把 _lastTurnTokens 那行挤出了原窗口。守的性质没变——两行仍
  // 必须挨在同一个 run 起点里；固定窗口本身是这条断言的已知弱点，函数一长就会再失效。
  assert.match(SRC, /session\._runUsage = \{ in: 0[\s\S]{0,1200}session\._lastTurnTokens = 0;/,
    "run 起点必须把这个跨 run 存活的字段清零");
});

test("预算判定挂在结算落地那一刻，下一轮开头消费标记——不阻塞工具执行", async () => {
  const _runUsageTokens = load("_runUsageTokens");
  const session = { _runUsage: { in: 900, out: 100, cacheRead: 0, cacheCreation: 0 } };
  const run = {};
  const _readTokenCap = load("_readTokenCap", { localStorage: { getItem: () => "1500" } });
  assert.equal(_readTokenCap(), 1500);
  const note = load("_noteTokenCapOnSettlement", { run, session, _readTokenCap, _runUsageTokens });

  note();
  assert.equal(run._tokenCapPending, undefined, "1000 < 1500，还没超");
  session._runUsage.in = 1600;
  note();
  assert.deepEqual(run._tokenCapPending, { used: 1700, cap: 1500 },
    "结算落地后要用本 run 自己的账判超限，并且只置标记（推提醒是下一轮开头的事）");
  const first = run._tokenCapPending;
  session._runUsage.in = 9999;
  note();
  assert.equal(run._tokenCapPending, first, "标记还没被消费，不重复覆盖");
  run._tokenCapPending = null;
  run._tokenCapNudged = true;
  note();
  assert.equal(run._tokenCapPending, null, "已经提醒过就不再置");

  // 关的是「零上限 = 不限」这道门。
  const noCap = load("_noteTokenCapOnSettlement", {
    run: {}, session, _runUsageTokens, _readTokenCap: load("_readTokenCap", { localStorage: { getItem: () => "0" } }),
  });
  noCap();
});

test("结算任务每条只挂一次钩子，落地即判——异常也不许把主循环带下去", async () => {
  let notes = 0;
  const run = { _billingTasks: [] };
  const hook = load("_hookSettlementTasks", {
    run, _billingHooked: new WeakSet(), _noteTokenCapOnSettlement: () => { notes++; },
  });
  const settled = Promise.resolve("settlement");
  const failed = Promise.reject(new Error("gateway down"));
  run._billingTasks.push(settled, failed, "not-a-promise");
  hook();
  hook(); // 每轮都调；已经挂过的不许再挂一次
  await Promise.allSettled([settled, failed]);
  await Promise.resolve();
  assert.equal(notes, 1, "结算落地判定必须每条任务只跑一次，失败的那条不判也不抛");

  assert.match(SRC, /_hookSettlementTasks\(\);\s*\n\s*run\._tokens = _runUsageTokens/,
    "钩子要在主循环里每轮挂一次，否则 break/continue 路径上新压入的结算任务永远没人接");
});

test("收尾余量按最近一轮的真实开销给，不是固定 3 轮", () => {
  const at = SRC.indexOf("run._tokenCapPending && !run._tokenCapNudged");
  assert.ok(at > 0, "预算判定块的锚点没了");
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /const _lastTurn = session\._lastTurnTokens \|\| 0;/,
    "收尾余量没有任何依据——固定 3 轮意味着一轮吃掉半个预算的任务，收尾再烧一个半预算");
  assert.match(block, /budget = Math\.min\(budget, iter \+ \(_lastTurn \* 2 > _cap \? 1 : 3\)\)/);
  assert.match(block, /run\._tokenCapNudged = true/, "提醒只推一次");
});
