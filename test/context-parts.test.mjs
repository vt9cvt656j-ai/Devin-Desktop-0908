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

test("来源分项：量得到的照实报，量不到的按差额倒推并说明白", () => {
  const v = contextPartsView({
    parts: [{ key: "rules", label: "用户规则", tokens: 1200 }, { key: "history", label: "对话历史", tokens: 5000 }],
    total: 17200, l0: true,
  });
  const gw = v.rows.find((r) => r.key === "gateway");
  assert.ok(gw, "网关注入那一项没出来——用户想看的「系统提示词 / 工具定义」正是这一项");
  assert.equal(gw.tokens, 17200 - 6200, "倒推的数不对");
  assert.equal(gw.estimated, false, "倒推项被标成了估算——它是按真数减出来的");
  assert.ok(v.rows.filter((r) => r.key !== "gateway").every((r) => r.estimated), "客户端那几块没标成估算");
  assert.ok(v.notes.some((n) => n.includes("倒推")), "没说清楚网关那一项是怎么来的");
  assert.ok(v.notes.some((n) => n.includes("量不到")), "没说清楚为什么客户端量不到系统提示词和内置工具");
});

test("三种不确定都不许糊过去", () => {
  // ① 上游还没报过就什么都不显示：没有分母，倒推没有意义。
  const p = contextPartsView({ parts: [{ key: "a", label: "x", tokens: 100 }], total: 0, l0: true });
  assert.equal(p.pending, true);
  assert.equal(p.rows.length, 0, "没有真数还画分项——那是一堆估算冒充真值");
  // ② 倒推为负 = 客户端估大了：如实说，不显示负数、也不悄悄归零。
  const neg = contextPartsView({ parts: [{ key: "a", label: "x", tokens: 9999 }], total: 100, l0: true });
  assert.ok(!neg.rows.some((r) => r.key === "gateway"), "倒推为负还画了网关那一项");
  assert.ok(neg.rows.every((r) => r.tokens > 0), "出现了非正数的分项");
  assert.ok(neg.notes.some((n) => n.includes("估算偏大")), "估大了却不说");
  // ③ 非网关线路：系统提示词和工具确实在客户端，但发布版把内置工具描述剥空了。
  const direct = contextPartsView({ parts: [{ key: "system", label: "系统提示词", tokens: 3000 }], total: 3000, l0: false });
  assert.ok(!direct.rows.some((r) => r.key === "gateway"), "非网关线路不该有「网关注入」这一项");
  assert.ok(direct.notes.some((n) => n.includes("下限")), "没说明工具那一项只是下限");
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
  assert.match(SRC, /system: _l0 \? 0 : _estimateTokens\(/,
    "网关线路上也把客户端那份系统提示词算进去了——它根本没发出去，会把网关那一项的倒推压小");
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
