// 流式增量渲染的块边界判据：顶格 fence 开启也算边界。
//
// 原来只认「fence 外的空行」。于是模型写 `**train.py**` 紧跟代码块（中间没空行）时，
// 散文和代码块一起卡在 tail 里，正在生长的 <pre> 每帧销毁重建 —— 同一份 600 行 Python，
// 紧贴写法 5257 节点 / 4.40MB DOM 文本写入，fence 前多一个空行则是 299 节点 / 0.03MB。
// 用户感受到的不是「慢」，是**不可预测**：同一个模型同一类问题，这次流畅下次卡。
//
// 只认**顶格** fence：缩进的 fence 可能在列表项里，从那儿切开会让尾块变成顶层代码块
// 而不是列表内的代码块 —— 那是渲染变化，不是加速。这个文件两头都守。
import assert from "node:assert/strict";
import test from "node:test";

class _N {
  constructor(tag) { this.tagName = (tag || "").toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = new Map(); this.style = {}; this.className = ""; this._text = ""; this.dataset = {}; }
  _adopt(n) { if (n.tagName === "#FRAGMENT") { const k = [...n.childNodes]; for (const c of k) c.parentNode = null; n.childNodes = []; return k; } if (n.parentNode) n.parentNode.removeChild(n); return [n]; }
  appendChild(n) { for (const k of this._adopt(n)) { this.childNodes.push(k); k.parentNode = this; } return n; }
  insertBefore(n, ref) { const k = this._adopt(n); let i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) i = this.childNodes.length; this.childNodes.splice(i, 0, ...k); for (const c of k) c.parentNode = this; return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  get classList() {
    const own = this;
    const set = () => new Set(String(own.className || "").split(/\s+/).filter(Boolean));
    const put = (s) => { own.className = [...s].join(" "); };
    return { add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); put(s); },
      remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); put(s); },
      contains: (c) => set().has(c),
      toggle: (c) => { const s = set(); if (s.has(c)) { s.delete(c); put(s); return false; } s.add(c); put(s); return true; } };
  }
  addEventListener() {}
  querySelector() { return null; }
  set textContent(v) { this._text = String(v ?? ""); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent || "").join(""); }
}
class _T extends _N { constructor(v) { super(); this._text = String(v); } }
globalThis.document = {
  createElement: (t) => new _N(t), createElementNS: (_n, t) => new _N(t),
  createDocumentFragment: () => new _N("#fragment"), createTextNode: (v) => new _T(v),
};
const { renderMarkdownStream, renderMarkdownInto } = await import("../src/markdown.js");
const OPT = { streaming: true, showCaret: false };

/** 逐块喂进去，返回容器。 */
function stream(chunks) {
  const box = new _N("div");
  let acc = "";
  for (const c of chunks) { acc += c; renderMarkdownStream(box, acc, OPT); }
  return { box, acc };
}
/** 一次性渲染同一份文本，用来对拍。 */
function oneShot(text) { const b = new _N("div"); renderMarkdownInto(b, text); return b; }

test("散文紧跟代码块（中间没空行）：散文当场结算，边界落在 ``` 那一行", () => {
  const prose = "这是 **train.py**：\n";
  const { box } = stream([prose, "```python\n", "print(1)\n"]);
  const st = box.__mdStream;
  assert.ok(st, "流式状态要挂在容器上");
  assert.equal(st.boundary, prose.length,
    "边界应落在 fence 起始处（" + prose.length + "），实际 " + st.boundary + " —— 0 表示散文没结算，整段还在 tail 里每帧重建");
});

test("代码块在后续帧里是追加，不是每帧重建（节点身份不变）", () => {
  const box = new _N("div");
  let acc = "说明如下：\n```js\n";
  renderMarkdownStream(box, acc, OPT);
  const first = box.childNodes[box.childNodes.length - 1];
  for (let i = 0; i < 20; i++) {
    acc += `line ${i};\n`;
    renderMarkdownStream(box, acc, OPT);
  }
  const last = box.childNodes[box.childNodes.length - 1];
  assert.equal(last, first, "尾块节点被换过 —— 说明每帧在销毁重建，正是那个 147 倍的来源");
});

test("拆块不改变渲染结果：流式喂完的文本和一次性渲染逐字一致", () => {
  const cases = [
    "这是 **train.py**：\n```python\nprint(1)\nprint(2)\n```\n收尾一句。\n",
    "标题\n```\nplain fence\n```\n",
    "前言\n\n```ts\nconst a = 1;\n```\n\n后记\n",
    "~~~sh\necho hi\n~~~\n",
  ];
  for (const md of cases) {
    const { box } = stream(md.split(/(?<=\n)/));
    assert.equal(box.textContent, oneShot(md).textContent, `渲染结果变了：\n${md}`);
  }
});

test("列表里缩进的 fence 不当边界——从那儿切开会把它变成顶层代码块", () => {
  const md = "- 第一项\n  ```js\n  code();\n  ```\n";
  const box = new _N("div");
  let acc = "";
  for (const c of md.split(/(?<=\n)/)) { acc += c; renderMarkdownStream(box, acc, OPT); }
  const st = box.__mdStream;
  // 缩进 fence 前面那一行是 "- 第一项\n"（9 字节）。边界若落在那儿就说明切开了。
  assert.notEqual(st.boundary, "- 第一项\n".length,
    "缩进的 fence 被当成了块边界：列表项会被拆成「列表」+「顶层代码块」两块，渲染结果就变了");
  assert.equal(box.textContent, oneShot(md).textContent, "列表内代码块的渲染结果必须和一次性渲染一致");
});

test("fence 内部的 ``` 不重复结算（inFence 状态没被这次改动带歪）", () => {
  const md = "开头\n````md\n```js\nnested\n```\n````\n";
  const box = new _N("div");
  let acc = "";
  for (const c of md.split(/(?<=\n)/)) { acc += c; renderMarkdownStream(box, acc, OPT); }
  assert.equal(box.textContent, oneShot(md).textContent, "嵌套 fence 的渲染结果变了");
});

test("缩进 ≥4 的 fence 也要被认出来——否则代码块内部的空行会把它从中间切开", () => {
  // 原来匹配围栏用的是 `/^(\s{0,3})(`{3,}|~{3,})/`：缩进上限 3。
  // CommonMark 里 ≥4 空格**在顶层**是缩进代码块，但在列表项内部（内容缩进 4）
  // ```` ``` ```` 就是一个正常的围栏。于是那种围栏整个匹配不上 → st.inFence 从不置位 →
  // 代码块**内部的空行**（函数之间空一行，最常见的写法）被当成块边界，
  // 已结算的那半从此永远保持切错的样子，后面的帧再也改不回来。
  //
  // 实测（修之前）：顶格/缩进2 → boundary 落在代码块之前；缩进 4 → 落在代码块**内部**。
  const md = "说明\n\n1. 步骤\n    ```python\n    def a():\n        return 1\n\n    def b():\n        return 2\n    ```\n";
  const box = new _N("div");
  let acc = "";
  for (const c of md.split(/(?<=\n)/)) { acc += c; renderMarkdownStream(box, acc, OPT); }
  const st = box.__mdStream;
  // 边界绝不能落在围栏之后：落在那儿就说明代码块被从内部切开了。
  const fenceAt = md.indexOf("```");
  assert.ok(st.boundary <= fenceAt,
    `边界落在 ${st.boundary}，而围栏在 ${fenceAt} —— 代码块被从内部切开了`);
  assert.equal(box.textContent, oneShot(md).textContent,
    "缩进 4 的列表内代码块，流式渲染结果必须和一次性渲染逐字一致");

  // 放宽缩进只影响 inFence 的**跟踪**，不许顺带把结算边界也放宽：
  // 从缩进围栏处切块会把列表内代码块变成顶层代码块，那是渲染变化不是加速。
  const md2 = "- 第一项\n  ```js\n  code();\n  ```\n";
  const box2 = new _N("div");
  let acc2 = "";
  for (const c of md2.split(/(?<=\n)/)) { acc2 += c; renderMarkdownStream(box2, acc2, OPT); }
  assert.notEqual(box2.__mdStream.boundary, "- 第一项\n".length,
    "结算边界跟着放宽了 —— 列表项会被拆成「列表」+「顶层代码块」");
});
