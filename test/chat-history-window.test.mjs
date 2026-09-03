// 翻历史这条路上的两个**正确性** bug —— 它们长得像性能问题，用户体验成「卡/没反应/没了」。
//
// ① 往回翻过历史后再发消息：_renderLatestHistoryWindow 同步清空容器、然后 await 一次
//    SQLite IPC 才把历史 append 回来；而唯一的调用方 addMessage 是 `void` 掉这个 promise
//    继续同步往下走的 —— 它紧接着就把新气泡 append 进那个空容器。等历史回来时，
//    56 条旧消息全排到新气泡**后面**。用户的提问和正在流式的回复顶在整段历史最上方，
//    再配合钉底，看起来就是「发出去了，没反应」。
//
// ② 跑任务时往上翻到渲染窗口顶部：裁尾删的是最后 excess 条，而正在流式的那条永远在最后。
//    回复卡当场从 DOM 消失且不再更新（流还在写一个脱离文档的节点）。
//
// 两条都用**真函数 + 真 DOM 顺序**验，不做源码断言：顺序错没错，跑一遍就知道。
import assert from "node:assert/strict";
import test from "node:test";
import { fnSource, load } from "./helpers/source.mjs";

// --- 最小 DOM：只要能表达 append / insertBefore / remove 的顺序语义 ---
class N {
  constructor(tag, cls = "") { this.tagName = (tag || "").toUpperCase(); this.className = cls; this.childNodes = []; this.parentNode = null; this.dataset = {}; }
  get classList() { const o = this; return { contains: (c) => String(o.className || "").split(/\s+/).includes(c) }; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); this.childNodes.push(n); n.parentNode = this; return n; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    n.parentNode = this; return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelectorAll(sel) {
    // 只支持 ":scope > .a, :scope > .b" 这一种形态 —— 被测代码用的就是这种。
    const classes = sel.split(",").map((s) => s.trim().replace(":scope > .", ""));
    return this.childNodes.filter((c) => c.classList && classes.some((cl) => c.classList.contains(cl)));
  }
}
class C { constructor(t) { this.nodeType = 8; this._t = t; this.parentNode = null; } remove() { if (this.parentNode) this.parentNode.removeChild(this); } }
const label = (container) => container.childNodes.map((c) => c.dataset?.tag || (c.nodeType === 8 ? "#anchor" : "?")).join(",");

// ---------------------------------------------------------------------------
// ① 新消息不能排到历史上方
// ---------------------------------------------------------------------------

test("翻过历史后再发消息：历史插在新气泡之前，不是之后", async () => {
  const container = new N("div");
  const session = { container, _historyAtLatest: false, id: "s1" };

  // 真函数，把它依赖的东西全注入成可观测的替身。
  const calls = [];
  const fn = load("_renderLatestHistoryWindow", {
    _removeRenderedHistoryMessage: (n) => n.remove(),
    _sessionHistoryLength: () => 56,
    _RENDER_LIMIT: 50,
    _updateHistoryControls: () => {},
    document: { createComment: (t) => new C(t) },
    // 替身照抄真 _renderMsgRange 的关键行为：**先 await**（真实现要走一次 IPC），
    // 然后按 options.before 决定 insertBefore 还是 appendChild —— 这正是 addMessage 的做法。
    _renderMsgRange: async (sess, from, to, options) => {
      calls.push({ from, to, before: options?.before ? "anchor" : null });
      await new Promise((r) => setTimeout(r, 0));
      for (let i = from; i < to; i++) {
        const m = new N("div", "msg"); m.dataset.tag = "h" + i;
        if (options?.before && options.before.parentNode === sess.container) sess.container.insertBefore(m, options.before);
        else sess.container.appendChild(m);
      }
    },
  });

  const p = fn(session);                       // 调用方 void 掉它继续同步往下走
  const fresh = new N("div", "msg"); fresh.dataset.tag = "新消息";
  container.appendChild(fresh);                // ← addMessage 在同一个同步段里做的事
  await p;

  assert.ok(calls.length === 1 && calls[0].before === "anchor",
    "_renderMsgRange 没拿到 before 锚点：历史会 append 到新气泡后面");
  const order = label(container);
  assert.ok(order.endsWith("新消息"),
    `新消息必须在最后，实际顺序：${order}`);
  assert.ok(order.startsWith("h6,h7"), `历史要从 h6 开始排在前面，实际：${order.slice(0, 40)}`);
  assert.ok(!container.childNodes.some((c) => c.nodeType === 8), "锚点没被清掉，留在 DOM 里了");
});

test("渲染中途抛异常也不能把锚点留在 DOM 里", async () => {
  const container = new N("div");
  const session = { container, _historyAtLatest: false, id: "s2" };
  const fn = load("_renderLatestHistoryWindow", {
    _removeRenderedHistoryMessage: (n) => n.remove(),
    _sessionHistoryLength: () => 10,
    _RENDER_LIMIT: 50,
    _updateHistoryControls: () => {},
    document: { createComment: (t) => new C(t) },
    _renderMsgRange: async () => { throw new Error("IPC 挂了"); },
  });
  await assert.rejects(() => fn(session), /IPC 挂了/);
  assert.ok(!container.childNodes.some((c) => c.nodeType === 8), "异常路径漏掉了锚点清理");
});

// ---------------------------------------------------------------------------
// ② 裁尾不能把正在流式的那条删掉
// ---------------------------------------------------------------------------

function mkSession(n, streaming) {
  const container = new N("div");
  for (let i = 0; i < n; i++) { const m = new N("div", "msg"); m.dataset.tag = "m" + i; container.appendChild(m); }
  return { container, streaming, _historyVisibleStart: 0, _historyVisibleEnd: n, _historyAtLatest: true };
}
const trim = load("_trimRenderedHistoryWindow", {
  _RENDER_LIMIT: 5,
  _removeRenderedHistoryMessage: (n) => n.remove(),
  _dropOrphanSuggestionBlocks: () => {},
  _sessionHistoryLength: () => 100,
});

test("流式中裁尾：最后那条（正在流式的）必须留下", () => {
  const s = mkSession(8, true);           // 8 条，上限 5 → 想裁 3 条
  const cut = trim(s, "end");
  assert.equal(cut, 2, "该裁 2 条（3 条减去被保护的那条）");
  assert.equal(s.container.childNodes.length, 6);
  assert.equal(s.container.childNodes.at(-1).dataset.tag, "m7",
    "正在流式的那条被裁掉了——回复卡会当场消失，而流还在往脱离文档的节点里写");
});

test("没在流式时行为不变：该裁几条裁几条", () => {
  const s = mkSession(8, false);
  assert.equal(trim(s, "end"), 3);
  assert.equal(s.container.childNodes.length, 5);
  assert.equal(s.container.childNodes.at(-1).dataset.tag, "m4");
});

test("保护之后没得可裁：不动 DOM，也不许把 _historyAtLatest 置 false", () => {
  const s = mkSession(6, true);           // 只超 1 条，而那 1 条正在流式
  assert.equal(trim(s, "end"), 0);
  assert.equal(s.container.childNodes.length, 6, "什么都不该删");
  assert.equal(s._historyAtLatest, true,
    "「已经在最新一页」的状态被凭空丢掉了，翻页按钮会跟着乱");
  assert.equal(s._historyVisibleEnd, 6, "一条没裁，可见区间也不该动");
});

test("裁头那一支没被这次改动带歪", () => {
  const s = mkSession(8, true);
  assert.equal(trim(s, "start"), 3);
  assert.equal(s.container.childNodes.at(0).dataset.tag, "m3");
  assert.equal(s.container.childNodes.at(-1).dataset.tag, "m7");
});
