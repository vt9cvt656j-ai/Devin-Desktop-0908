// ── 浏览器验证候选：改完前端 UI 不再只靠嘴说「好了」──────────────────────────
//
// run._verifyCandidate（verifyNow 预填 run_cmd）的同形扩展，浏览器这一侧：
//   · 触发是执行事实：本批真的落盘了前端源码（_UI_SOURCE_EXT，uiLook 同一判据），
//     且运行状态里有活着的 dev server URL（_agentTerminalEntries 的 urls 字段，
//     "运行中" 才算活着——运行状态块同一来源）。
//   · 预填第一步 navigate 打开那个 URL；browser 没有一个 action 能同时「开页 + 读
//     控制台」（check 只对当前已打开页面跑），所以第二步（action:"check" 读控制台
//     错误）写进事实文案由模型自己发。
//   · 模型空参数/缺参数调 browser 即点头，_browserVerifyCandidateFill 在唯一授权
//     检查点之前代填（_verifyCandidateFill 同款位置）；IDE 从不代跑。
//   · 与 run_cmd 候选并存不打架：先后判据是本批改动文件类型这个执行事实——
//     全前端批 → 浏览器候选先说、verifyNow 让位；混合批 → 命令候选先说。
//   · 有界：每 run 每 URL 只提示一次；候选一次性消费。
//
// 全部用夹具跑，不起真浏览器。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SRC, CODE, fnSource, load } from "./helpers/source.mjs";

const loop = fnSource("_runAgenticLoop", { code: true });
const fill = load("_browserVerifyCandidateFill");

// 构造器落出来的「空调用」形态：browser({}) → action 默认 "screenshot"、url ""。
const mkEmptyCall = (over = {}) => ({
  type: "browser", action: "screenshot", url: "", selector: "", target: "", role: "",
  text: "", script: "", key: "", fields: {}, steps: null, uploadPaths: [], mobile: false,
  ...over,
});
const mkRun = () => ({ _browserVerifyCandidate: { action: "navigate", url: "http://localhost:5173" } });

// ---- 代填器：点头即执行预填的 navigate ----

test("空参数 browser 调用点头：代填 navigate + URL，候选一次性消费", () => {
  const run = mkRun();
  const call = mkEmptyCall();
  assert.equal(fill(run, call), "http://localhost:5173");
  assert.equal(call.action, "navigate");
  assert.equal(call.url, "http://localhost:5173");
  assert.equal(run._browserVerifyCandidate, null, "候选必须一次性消费，陈旧候选不许常驻");

  // 缺 url 的显式 navigate 同样算点头（它本来要么报错要么开错页面）。
  const r2 = mkRun();
  const c2 = mkEmptyCall({ action: "navigate" });
  assert.equal(fill(r2, c2), "http://localhost:5173");
  assert.equal(c2.url, "http://localhost:5173");

  // action 为空串（构造器之外的形态）也认。
  const r3 = mkRun();
  const c3 = mkEmptyCall({ action: "" });
  assert.equal(fill(r3, c3), "http://localhost:5173");
  assert.equal(c3.action, "navigate");
});

test("模型自带 URL＝它已接管验证路线：一个字不动，候选就地作废", () => {
  const run = mkRun();
  const call = mkEmptyCall({ action: "navigate", url: "http://localhost:9999/other" });
  assert.equal(fill(run, call), null);
  assert.equal(call.url, "http://localhost:9999/other", "模型自己的 URL 不许被覆盖");
  // 作废而不是留着：否则之后一次普通的空 screenshot 会被陈旧候选劫持成再导航。
  assert.equal(run._browserVerifyCandidate, null,
    "模型带 URL 开页后候选还挂着——下一次空 screenshot 会被劫持");
});

test("带任何载荷的调用是明确操作，不是点头：不代填、候选保留", () => {
  for (const over of [
    { action: "check" },                              // 对当前页的体检
    { action: "assert", selector: "#app" },           // 定位类
    { target: "登录" },
    { role: "button" },
    { text: "hello" },
    { action: "eval", script: "1+1" },
    { action: "press", key: "Enter" },
    { action: "batch", steps: [{ op: "click", node: 1 }] },
    { action: "autofill", fields: { email: "a@b.c" } },
    { action: "upload", uploadPaths: ["/tmp/a.png"] },
    { action: "viewport", width: 1440, height: 900 },
    { width: 390 },                                    // 缺 action 的疑似 viewport
    { mobile: true },
  ]) {
    const run = mkRun();
    const call = mkEmptyCall(over);
    const before = JSON.stringify(call);
    assert.equal(fill(run, call), null, `不该碰：${JSON.stringify(over)}`);
    assert.equal(JSON.stringify(call), before, `调用被改了：${JSON.stringify(over)}`);
    assert.ok(run._browserVerifyCandidate, `候选不该被 ${JSON.stringify(over)} 消耗`);
  }
});

test("没候选/没 run/非 browser 调用：原路放行", () => {
  assert.equal(fill({}, mkEmptyCall()), null);
  assert.equal(fill(null, mkEmptyCall()), null);
  assert.equal(fill({ _browserVerifyCandidate: { url: "" } }, mkEmptyCall()), null);
  assert.equal(fill(mkRun(), { type: "cmd", command: "" }), null,
    "cmd 的空参数点头归 _verifyCandidateFill，不许越界");
});

// ---- 接入点：唯一授权检查点之前，同款先例、不开新口子 ----

test("代填发生在唯一授权检查点之前，且与 run_cmd 代填同一接入函数", () => {
  const wrapper = fnSource("_executeToolStep", { code: true });
  const cmdFillAt = wrapper.indexOf("_verifyCandidateFill(run, call)");
  const bvFillAt = wrapper.indexOf("_browserVerifyCandidateFill(run, call)");
  const approveAt = wrapper.indexOf("_approveToolCall(call, run)");
  assert.ok(cmdFillAt > 0 && bvFillAt > 0 && approveAt > 0, "两个代填器和授权检查点都得在");
  assert.ok(bvFillAt < approveAt,
    "代填要发生在授权检查之前，否则确认框里给用户看的是一次空截图请求，不是真实导航");
  // 不开新口子：全文件只有这一个接入点（其余都是声明与测试）。
  const callSites = [...CODE.matchAll(/_browserVerifyCandidateFill\(/g)].length;
  assert.equal(callSites, 2, "接入点该恰好两处：函数声明 + _executeToolStep 里那一次调用");
});

// ---- 触发：全是执行事实，候选在提示前武装 ----

test("触发是执行事实：前端源码真落盘 + 运行中终端的 urls（运行状态同一来源）", () => {
  const at = loop.indexOf("[前端改了没看] 刚改了");  // 载体换了：文本追加到 [本轮交付事实]，不再是一条 nudge
  assert.ok(at > 0, "改完前端没有任何一处在浏览器侧出声");
  const armWindow = loop.slice(Math.max(0, at - 3600), at);
  // 候选先武装、后开口——「预填好参数」才成立，否则提醒退化回劝诫。
  assert.match(armWindow, /run\._browserVerifyCandidate = \{ action: "navigate", url: _bvUrl \}/,
    "候选没武装——空参数点头无从代填");
  // 前端源码判据复用 uiLook 那一条，不另立一套。
  assert.match(armWindow, /_UI_SOURCE_EXT\.test\(p\)/,
    "没按前端源码扩展名筛——改 .rs/.md 也会被喊去开浏览器");
  // 落盘失败的写入不算「改了前端」。
  assert.match(armWindow, /ERROR\|BLOCKED\|DENIED/,
    "没排除写失败的那些——文件没落盘却说「你改了前端」");
  // dev server 活着的判据：运行状态块同一来源（_agentTerminalEntries），
  // 状态必须是运行中、URL 来自真实终端输出。
  assert.match(armWindow, /_agentTerminalEntries\(\)/,
    "没读运行状态同一来源——URL 要么是猜的要么另立台账");
  assert.match(armWindow, /t\.status === "运行中" && t\.urls\.length/,
    "「活着」没有判据——已退出的 dev server 也会被当成能开的页面");
  // 别把验证指到另一个项目的端口上：终端 cwd 必须在本工作区内。
  assert.match(armWindow, /c === _rootNorm \|\| c\.startsWith\(_rootNorm \+ "\/"\)/,
    "没锁工作区——别的项目的 dev server 端口会被当成本项目的验证目标");
});

test("事实文案写清两步：第一步 navigate 已预填，第二步 check 读控制台错误", () => {
  const at = loop.indexOf("[前端改了没看] 刚改了");  // 载体换了：文本追加到 [本轮交付事实]，不再是一条 nudge
  const msg = loop.slice(at, at + 1200);
  assert.match(msg, /参数留空即可/, "没告诉模型空参数即点头——弱模型拼不出参数就烧轮");
  assert.match(msg, /navigate 打开/, "没说预填的是哪一步");
  assert.match(msg, /action:"check"/,
    "第二步没写清——browser 没有一个 action 能同时开页+读控制台，不说第二步就只开了页");
  assert.match(msg, /控制台错误/, "没说 check 是为了读控制台错误——JS 报错截图看不出来");
  // 只给事实不抢回合：收尾门「安静一轮＝模型的收尾判断」红线同样成立。
  assert.doesNotMatch(loop.slice(at, at + 400), /\bcontinue;/,
    "在这里补回合就推翻了「安静一轮＝模型的收尾判断」");
});

test("browserVerify 登记进事实类：不被一条建议挤掉", () => {
  // 按解析那张表判，不按子串——_pushNudge("browserVerify" 那一行自己就含这个子串。
  const facts = new Set([...(/const _NUDGE_FACTS = new Set\(\[([\s\S]*?)\]\)/.exec(SRC)[1]
    .matchAll(/"([a-zA-Z]+)"/g))].map((m) => m[1]));
  // 原来钉「登记进事实类」——为的是别被建议类挤掉。现在它不在淘汰表里了：文本追加到
  // [本轮交付事实]，而那块每轮无条件推、推前把上一份 splice 掉，**完全不参与同轮淘汰**。
  // 「挤不掉」这个保证因此比原来更强。
  assert.ok(!facts.has("browserVerify"),
    "browserVerify 又回到淘汰表里了 —— 它现在待在不参与淘汰的交付事实块里，两处都有就是重复");});

// ---- 有界：每 run 每 URL 只提示一次 ----

test("每 run 每 URL 只提示一次：URL 名额在开口那一刻消耗", () => {
  const at = loop.indexOf("[前端改了没看] 刚改了");  // 载体换了：文本追加到 [本轮交付事实]，不再是一条 nudge
  const armWindow = loop.slice(Math.max(0, at - 3600), at);
  assert.match(armWindow, /!run\._browserVerifyPromptedUrls\.has\(_bvUrl\)/,
    "没有每 URL 上界——同一个 dev server 每批改动都唠叨一遍");
  assert.match(armWindow, /run\._browserVerifyPromptedUrls\.add\(_bvUrl\)/,
    "名额没登记——上界形同虚设");
  // add 在 push 之前：名额和开口同时发生，不存在「武装了却没提示」的暗状态。
  const addAt = armWindow.lastIndexOf("_browserVerifyPromptedUrls.add(_bvUrl)");
  const armAt = armWindow.lastIndexOf("run._browserVerifyCandidate = ");
  assert.ok(addAt > 0 && armAt > addAt, "名额消耗要发生在武装之前的同一原子段里");
});

// ---- 与 run_cmd 候选并存不打架：先后判据是改动文件类型 ----

test("先后判据写在两侧：全前端批浏览器候选先说，混合批命令候选先说", () => {
  // verifyNow 一侧：浏览器候选刚发言且本批代码改动全是前端 → 本批让位（计数不消耗）。
  assert.match(loop, /_justChanged\.length && !\(_bvSpokeThisBatch && _justChanged\.every\(\(p\) => _UI_SOURCE_EXT\.test\(p\)\)\)/,
    "verifyNow 没有让位判据——同一批里两条候选一起喊，模型两头表态");
  // 浏览器一侧：verifyNow 够格发言且批里有非前端代码 → 命令候选优先，本批不说。
  assert.match(loop, /_vnWould && _bvCode\.some\(\(p\) => !_UI_SOURCE_EXT\.test\(p\)\)/,
    "浏览器候选没有让位判据——后端改动批里它抢在编译检查前面");
  // 让位判据必须镜像 verifyNow 自己的门槛（含代码改动这个执行事实），不是猜它会说。
  assert.match(loop, /const _vnWould = verifyNudges < 2 && _implOps > 0 && _verifiedAtImplOps < _implOps\s*&& _lastVerifyNudgeAtImplOps < _implOps && _bvCode\.length > 0/,
    "_vnWould 和 verifyNow 的真实门槛脱钩——让位判据建立在预测上");
});

test("消费互不越界：browser 代填器只认 browser，cmd 代填器只认 cmd", () => {
  const cmdFill = load("_verifyCandidateFill");
  // 两个候选同时在场：空 run_cmd 消费命令候选、不碰浏览器候选；空 browser 反之。
  const run = {
    _verifyCandidate: { command: "npm test", cwd: "/w" },
    _browserVerifyCandidate: { action: "navigate", url: "http://localhost:5173" },
  };
  const cmdCall = { type: "cmd", command: "" };
  assert.equal(cmdFill(run, cmdCall), "npm test");
  assert.ok(run._browserVerifyCandidate, "空 run_cmd 不许消耗浏览器候选");
  const bCall = mkEmptyCall();
  assert.equal(fill(run, bCall), "http://localhost:5173");
  assert.equal(run._browserVerifyCandidate, null);
  assert.equal(run._verifyCandidate, null, "命令候选已被上面那次点头消费");
});

// ---- 红线：发起方永远是模型，IDE 不代跑 ----

test("IDE 不代跑：武装段只挂状态推事实，不发浏览器调用、不补回合", () => {
  const at = loop.indexOf("[前端改了没看] 刚改了");  // 载体换了：文本追加到 [本轮交付事实]，不再是一条 nudge
  const start = loop.lastIndexOf("_bvSpokeThisBatch = false", at);
  assert.ok(start > 0);
  const block = loop.slice(start, at);
  assert.doesNotMatch(block, /backend\.invoke\(/,
    "触发块自己发了浏览器调用——发起方必须永远是模型");
  assert.doesNotMatch(block, /_executeToolStep(?:Inner)?\(/,
    "触发块自己派发了工具——IDE 代跑红线");
});
