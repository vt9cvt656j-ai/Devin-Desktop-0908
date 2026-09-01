// 点上下文环弹出的面板：① 它真的点得开；② 第二段按来源拆分，且不编数。
//
// 用户实拍两次：「点击那里没有用，也没这个啊」。上一版是**死代码**：接线写在
// `if (!el)` 里，而 #tokenMeter 是 Shell.jsx 静态渲染的，那个分支一次都不会进。
// 上一版的守卫是源码文本断言（"源码里有没有 addEventListener 这行字"），所以它带着绿灯发布。
// 这一份改成**真跑**：按真实前置条件（元素已经在文档里）跑 _renderTokenMeter，再看结果。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextPartsView } from "../src/agent/context-parts.js";
import { contextUsageView as contextUsageViewForNotes } from "../src/agent/context-usage.js";
import { fnSource, load, SRC } from "./helpers/source.mjs";

const shell = () => readFileSync(new URL("../src/app/Shell.jsx", import.meta.url), "utf8");

function renderMeter() {
  const listeners = [];
  const mkEl = () => ({
    hidden: true, dataset: {}, tabIndex: -1, _attrs: { role: "status" },
    classList: { toggle() {}, add() {}, remove() {} },
    style: { setProperty() {} },
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    addEventListener(t, fn) { listeners.push([t, fn]); },
    querySelector() { return { textContent: "" }; },
    appendChild() {}, remove() {},
  });
  // **前置条件就是这条**：元素已经在文档里（Shell.jsx 静态渲染的），
  // 于是 _renderTokenMeter 里 `if (!el)` 恒假。
  const ring = mkEl();
  let opened = 0;
  const fn = load("_renderTokenMeter", {
    document: { getElementById: () => ring, createElement: () => mkEl(), body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    _tokenShort: (n) => String(n),
    _ctxMeter: { total: 100, limit: 1000, pct: 10, prompt: 90, completion: 10, cached: 0, cacheWrite: 0, model: "m", estimated: false },
    _tok: { in: 0, out: 0, cached: 0, inWithCacheInfo: 0, anyReal: false, anyCacheInfo: false },
    _CONTEXT_RING_WARN_PCT: 70, _CONTEXT_RING_DANGER_PCT: 90,
    _activeThinkEffort: "off", _lastReasoningTok: 0, _lastThinkChars: 0,
    _toggleContextPanel: () => { opened++; },
    setTimeout: () => 0,
  });
  fn();
  return { ring, listeners, opened: () => opened };
}

test("元素已经在文档里时，环仍然被接成一个可点的按钮", () => {
  // Shell.jsx 静态渲染了 #tokenMeter，这是让上一版变成死代码的那个前置条件。
  assert.match(shell(), /id="tokenMeter"/, "Shell.jsx 不再静态渲染这个环了——这条测试的前置条件变了，要重写");
  const m = renderMeter();
  assert.equal(m.ring.getAttribute("role"), "button",
    "环还是 role=status——接线多半又写回了 `if (!el)` 那个死分支（连 cursor:pointer 都不会生效）");
  assert.equal(m.ring.tabIndex, 0, "键盘到不了这个环");
  assert.ok(m.listeners.some(([t]) => t === "keydown"), "键盘打不开面板");
});

test("悬停出用量、按下出来源——两块分开，且悬停那块不吃点击", () => {
  // 用户：「悬停显示上半段用量，只有点击时才出来下半段来源」。
  // 分开是有道理的：用量是随时想瞟一眼的数，来源是要坐下来读的账。
  const m = renderMeter();
  const kinds = m.listeners.map(([t]) => t);
  assert.ok(kinds.includes("pointerenter"), "悬停不出用量面板");
  assert.ok(kinds.includes("pointerleave"), "移开之后那块面板不会消失");
  const html = fnSource("_ctxPanelHtml");
  assert.match(html, /if \(kind === "usage"\)/, "两块面板没有按 kind 分开");
  assert.match(html, /上下文用量/, "悬停那块的标题没了");
  assert.match(html, /上下文来源/, "点开那块的标题没了");
  // 悬停那块只读不点：它绝不能吃掉落在环上的那一下按压（用户就是点不开才报的 bug）。
  assert.match(fnSource("_showContextHover"), /ctx-panel--usage/, "悬停那块没有自己的类名，样式分不开");
  assert.match(fnSource("_showContextHover"), /if \(_ctxPanelEl\) return;/,
    "点开着的时候还弹悬停那块——两层卡片会在同一个位置互相盖住");
  assert.match(fnSource("_toggleContextPanel"), /_hideContextHover\(\);/, "点开时没有把悬停那块收掉");
});

test("按下就开，用 pointerdown 不用 click", () => {
  // AI 回复期间渲染繁忙，WKWebView 会吞掉 click（按下+松开配对）——本仓的齿轮菜单和
  // 新建项目弹窗都为此改过。而「上下文在涨」恰恰是最想点开它的时候。
  const m = renderMeter();
  const pd = m.listeners.find(([t]) => t === "pointerdown");
  assert.ok(pd, "没有 pointerdown——AI 回复期间点了会没反应");
  assert.ok(!m.listeners.some(([t]) => t === "click"), "又用回 click 了");
  pd[1]({ button: 0, preventDefault() {} });
  assert.equal(m.opened(), 1, "按下去没有打开面板");
  // 右键不开。
  pd[1]({ button: 2, preventDefault() {} });
  assert.equal(m.opened(), 1, "右键也把面板打开了");
});

test("接线不许再写回那个死分支", () => {
  // 结构守卫：`if (!el) { … }` 那一段里不能再出现 addEventListener / role=button。
  const fn = fnSource("_renderTokenMeter");
  const i = fn.indexOf("if (!el) {");
  assert.ok(i > 0, "_renderTokenMeter 的形状变了，这条守卫要重写");
  let depth = 0, end = i;
  for (let k = fn.indexOf("{", i); k < fn.length; k++) {
    if (fn[k] === "{") depth++;
    else if (fn[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
  }
  const dead = fn.slice(i, end);
  assert.doesNotMatch(dead, /addEventListener/, "接线又回到 `if (!el)` 里了——那个分支一次都不会进");
  assert.doesNotMatch(dead, /role", "button/, "role=button 又写回死分支了");
  assert.match(fn, /if \(!el\.dataset\.ctxWired\)/, "没有一次性绑定标记——每次刷新都会再挂一个监听器");
});

test("七行齐全、顺序和 Claude Code 一致，且加起来等于上游真数", () => {
  // 用户要的就是那张图的样子：System prompt / Tool definitions / Rules / Skills /
  // MCP & dynamic tools / Subagent definitions / Conversation，每行一个数。
  const v = contextPartsView({
    parts: [
      { key: "system", label: "系统提示词", tokens: 12500 },
      { key: "tools", label: "工具定义", tokens: 600 },
      { key: "rules", label: "用户规则", tokens: 1400 },
      { key: "skills", label: "技能", tokens: 2800 },
      { key: "mcp", label: "MCP 与动态工具", tokens: 2000 },
      { key: "subagent", label: "子智能体定义", tokens: 770 },
      { key: "history", label: "对话", tokens: 8000 },
    ],
    total: 49100, l0: true,
  });
  assert.deepEqual(v.rows.map((r) => r.key),
    ["system", "tools", "rules", "skills", "mcp", "subagent", "history"],
    "行的构成或顺序和 Claude Code 那张图对不上");
  // 加起来必须正好等于上游报的真数——这是整块面板成立的前提。
  assert.equal(v.rows.reduce((n, r) => n + r.tokens, 0), 49100, "分项之和对不上上游读数");
  // 「工具定义」在网关线上是按差额补齐的（内置工具只发名字，描述在发布版里被剥空），
  // 所以它不打「估」字：它是从真数减出来的。客户端量到的那 600 要并进去，不能两头都算。
  const tools = v.rows.find((r) => r.key === "tools");
  assert.equal(tools.estimated, false, "工具定义被标成了估算——它是按真数减出来的");
  assert.equal(tools.tokens, 49100 - (12500 + 1400 + 2800 + 2000 + 770 + 8000), "差额补齐算错了");
  assert.ok(v.rows.filter((r) => r.key !== "tools").every((r) => r.estimated), "客户端量到的那几块没标成估算");
  // 面板下面不再挂说明段。
  assert.equal(v.notes, undefined, "面板下面那段说明又回来了");
});

test("三种不确定都不许糊过去", () => {
  // ① 上游还没报过就什么都不显示：没有分母，倒推没有意义。
  const p = contextPartsView({ parts: [{ key: "a", label: "x", tokens: 100 }], total: 0, l0: true });
  assert.equal(p.pending, true);
  assert.equal(p.rows.length, 0, "没有真数还画分项——那是一堆估算冒充真值");
  // ② 倒推为负 = 客户端估大了：那就不画这一行。一个负数、或者一个抹平成 0 的数，
  //    都比没有这一行更糟。
  const neg = contextPartsView({ parts: [{ key: "system", label: "x", tokens: 9999 }], total: 100, l0: true });
  assert.ok(neg.rows.every((r) => r.tokens > 0), "出现了非正数的分项");
  assert.ok(!neg.rows.some((r) => r.key === "tools"), "差额为负还硬补了「工具定义」那一行");
  // ③ 非网关线路：内置工具的 schema 本来就在请求体里，客户端量得到，不做差额补齐。
  const direct = contextPartsView({
    parts: [{ key: "system", label: "系统提示词", tokens: 3000 }, { key: "tools", label: "工具定义", tokens: 900 }],
    total: 9000, l0: false,
  });
  assert.ok(direct.rows.every((r) => r.estimated), "非网关线路上不该有按差额补出来的行");
  assert.equal(direct.rows.find((r) => r.key === "tools").tokens, 900, "非网关线路的工具定义被差额顶掉了");
  // 坏输入不许抛：它挂在点击路径上。
  for (const bad of [null, undefined, { parts: "x" }, { parts: [null, {}] }]) assert.doesNotThrow(() => contextPartsView(bad));
});

test("分项的数是发送时真记下来的，不是打开面板时现估的", () => {
  // 现估的话，模型看到的和面板显示的是两份不同的文本（这一轮的动态前导、@ 引用展开、
  // 账本都只在发送那一刻成形）。
  assert.match(SRC, /sess\._ctxParts = \{/, "发送时没有记下客户端各块");
  assert.match(SRC, /rules: _estimateTokens\(userRulesBlock\)/, "用户规则那一块没记");
  assert.match(SRC, /skills: _estimateTokens\(skillsBlock\)/, "技能那一块没记");
  // 系统提示词只在**非网关**线路上真的发出去（网关线会被 _l0MessagesWithSkills 整条替换）。
  // 「系统提示词」两条线路同一个算法：走网关时客户端那条 system 消息虽然被整条替换，
  // 但网关注入的**正文客户端手里就有**——_P() 读的 _remotePrompts 就是启动时从网关
  // /api/ide-prompts 拉的同一份。所以量它不是"拿本地的冒充网关的"，是量同一份文本。
  assert.match(SRC, /system: _estimateTokens\(\s*\n?\s*sysPrompt \+ _modelStyleTuning/,
    "「系统提示词」没有把提示词正文算进去——那一项会永远偏小，差额全被推给工具定义");
  assert.match(SRC, /subagent: _estimateTokens\(_agentRoleBlock\(effectiveMode\)/,
    "子智能体定义那一项没记");
  // MCP 单列：它是用户自己装上去的东西，得看得见每轮为它多付多少。
  assert.match(SRC, /sess\._ctxParts\.mcp = _estimateTokens\(JSON\.stringify\(_toolSchemas\.filter\(_isMcp\)\)\)/,
    "MCP 的 schema 没单独计量");
  assert.match(SRC, /sess\._ctxParts\.tools = _estimateTokens\(JSON\.stringify\(_toolSchemas\.filter\(\(t\) => !_isMcp\(t\)\)\)\)/,
    "工具定义没有把 MCP 摘出去，两格会重复计一遍");
  // 分类名跟 Claude Code 那套走。
  for (const label of ["系统提示词", "工具定义", "用户规则", "技能", "MCP 与动态工具", "子智能体定义", "对话"]) {
    assert.ok(SRC.includes(`label: "${label}"`), `分项少了「${label}」这一类，或者名字又自造了`);
  }
  assert.match(SRC, /sess\._ctxParts\.history = messages\.slice\(1\)/, "对话历史那一块没记，或者把 system 也算进去了");
});

test("语音按钮的底样式还在——它是上次删提示时被误伤的邻居", () => {
  // 用户实拍：「语音输入按钮周围变丑，有黑块」。真因不是这个按钮被改过，而是上一次删
  // `.cache-ring::after` 那层纯文字提示时**多数了一个右大括号**，把紧挨着它的
  // `.voice-btn { … }` 一起删了。没有这条规则，按钮退回浏览器默认的 <button> 样式：
  // 浅色下就是一块黑底方块。
  //
  // 守的是「这条规则在、且它把默认样式压住了」，不是某个具体数值。
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const i = css.indexOf("\n.voice-btn {");
  assert.ok(i > 0, "语音按钮的底样式没了——它会退回浏览器默认样式，浅色下是一块黑方块");
  const rule = css.slice(i, css.indexOf("}", i));
  for (const [prop, why] of [
    ["background: transparent", "不压住默认底色，浅色下就是一块黑方块"],
    ["border: 0", "不去掉默认边框，按钮会带一圈立体边"],
    ["border-radius", "没有圆角，和旁边的环不是一套"],
  ]) {
    assert.ok(rule.includes(prop), `.voice-btn 少了 ${prop}——${why}`);
  }
});

test("重启之后来源分项还在——它和上下文读数搭同一班车落盘", () => {
  // 用户实拍：重启软件后点开「上下文来源」，只剩一句「还拆不出来源」。
  // 分项是**发送那一刻**才算得出来的（规则/技能/语言块/工具 schema/对话历史都在那步成形），
  // 本地重算不出来——和上下文读数同一个性质，所以塞进 ctxFloor：它的写点和读点各有两个、
  // 四条路都是通的，不必再开一份白名单。
  const forStorage = load("_ctxPartsForStorage", {});
  const live = { _ctxParts: { l0: true, at: 1234, system: 900, rules: 1400, skills: 2800, tools: 500, mcp: 2000, subagent: 770, history: 63000 } };
  const stored = forStorage(live);
  assert.deepEqual(stored, { l0: true, at: 1234, system: 900, rules: 1400, skills: 2800, tools: 500, mcp: 2000, subagent: 770, history: 63000 },
    "落盘形状丢了字段——重启后那几行就少了");
  // 从存储形状再跑一遍要等价（读点就是这么调的）：形状同构，才经得起归档→恢复→再归档。
  assert.deepEqual(forStorage({ ctxFloor: { parts: stored } }), stored, "存储形状回不去，归档一次就丢");
  // 一项都没有就别写：空对象存进去会把「还拆不出来源」变成「全是 0」，后者更像坏了。
  assert.equal(forStorage({ _ctxParts: { l0: true, at: 1 } }), undefined);
  assert.equal(forStorage({}), undefined);
  assert.equal(forStorage(null), undefined);
  // 脏值不许穿过去。
  assert.deepEqual(forStorage({ _ctxParts: { rules: "x", history: -5, skills: 1.7, l0: 0, at: "z" } }),
    { l0: false, at: 0, system: 0, rules: 0, skills: 2, tools: 0, mcp: 0, subagent: 0, history: 0 });
});

test("落盘和回灌四条路都带上它，且它进了持久化指纹", () => {
  // 读写点各两个，漏一处就是"某种情况下丢"。
  assert.match(SRC, /parts: _ctxPartsForStorage\(session\)/, "写盘形状里没有分项");
  assert.match(SRC, /parts: _ctxPartsForStorage\(\{ ctxFloor: stored \}\)/, "回灌形状里没有分项");
  assert.equal((SRC.match(/if \(_ctxRead\.parts\) session\._ctxParts = _ctxRead\.parts;/g) || []).length, 2,
    "两个恢复点没有都把分项装回 session——某一条路径下重启后仍然是空的");
  // **指纹**这条最容易漏：分项变了、会话内容没变时指纹不变 → 快照走缓存 → 落盘对象里根本
  // 没有它。同一段注释里已经为 ctxFloor 记过这个坑。
  const fp = fnSource("_sessionPersistFingerprint");
  assert.match(fp, /_ctxParts\?\.history/, "分项没进持久化指纹——快照走缓存时它永远落不了盘");
});

test("面板下面不再多那一句解释", () => {
  // 用户点名删的：命中 0 那一行摆在那儿，值就是 0，话已经说完了。
  const v = contextUsageViewForNotes({ prompt: 31000, completion: 213, total: 31213, limit: 1000000, pct: 3, cached: 0 }, {});
  assert.deepEqual(v.notes, [], "面板下面又多出解释文字了");
  // 但「上游根本没报」那条必须还在——那是另一件事，不能一起删掉。
  const none = contextUsageViewForNotes({ prompt: 1000, completion: 0, total: 1000, limit: 8000, pct: 12, cached: null }, {});
  assert.ok(none.notes.some((n) => n.includes("没报缓存字段")), "把「上游没报缓存字段」也一起删了");
});
