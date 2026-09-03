// 回合收尾会把这一段正文用 streaming:false **全量重建**，而 markdown.js 的规则是
// 「完整的块默认折叠」（见它的 startsFolded 注释：流式期间开着，好让人看着代码写出来）。
// 折叠本身是有意设计，但用户**亲手点开**、正在读的那张卡被折回去不是 ——
// 页面高度当场塌陷、滚动跳。这个文件守住「明确意图不能被重建抹掉」。
//
// 身份用正文文本而不是卡片下标：收尾用的 cleanFinal 过了 _dedupeRunNarrative /
// _dedupeRepeatedText，段落可能被删掉，重建前后的下标对不上。
import assert from "node:assert/strict";
import test from "node:test";
import { fnSource, load } from "./helpers/source.mjs";

class N {
  constructor(tag, cls = "") { this.tagName = (tag || "").toUpperCase(); this.className = cls; this.childNodes = []; this.parentNode = null; this.dataset = {}; this._text = ""; }
  get classList() {
    const o = this;
    const set = () => new Set(String(o.className || "").split(/\s+/).filter(Boolean));
    const put = (s) => { o.className = [...s].join(" "); };
    return { add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); put(s); },
      remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); put(s); },
      contains: (c) => set().has(c),
      toggle: (c) => { const s = set(); if (s.has(c)) { s.delete(c); put(s); return false; } s.add(c); put(s); return true; } };
  }
  appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v ?? ""); this.childNodes = []; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // 支持「后代选择器 + 类/标签」：被测代码用的是 ".code-card.is-foldable"、
  // ".code-card.is-foldable.is-folded" 和 ".code-card__body code" 三种。
  // 一开始只切了 "."，`.code-card__body code` 那个空格被当成类名的一部分，
  // 于是永远匹配不到 —— 断言当场红，但错在测试台不在被测代码。
  querySelectorAll(sel) {
    const steps = sel.trim().split(/\s+/).filter(Boolean);
    const matches = (node, step) => {
      if (!step.startsWith(".")) return node.tagName === step.toUpperCase();
      return step.split(".").filter(Boolean).every((c) => node.classList?.contains(c));
    };
    let scope = [this];
    for (const step of steps) {
      const next = [];
      for (const root of scope) {
        const walk = (n) => { for (const c of n.childNodes) { if (matches(c, step)) next.push(c); walk(c); } };
        walk(root);
      }
      scope = next;
    }
    return scope;
  }
}
function mkCard(code, { folded, userFold, lang = "plaintext" } = {}) {
  const card = new N("div", "code-card is-foldable" + (folded ? " is-folded" : ""));
  card.dataset.lang = lang;
  if (folded) card.dataset.code = code;
  else { const body = new N("div", "code-card__body"); const c = new N("code", ""); c.textContent = code; body.appendChild(c); card.appendChild(body); }
  if (userFold !== undefined) card.dataset.userFold = userFold;
  return card;
}
/** 重建之后的样子：折叠态（data-code 上挂着正文），但 body/code 节点已经在了。 */
function mkFoldedWithBody(code, userFold) {
  const card = mkCard(code, { folded: true, userFold });
  const body = new N("div", "code-card__body"); const c = new N("code"); c.textContent = "";
  body.appendChild(c); card.appendChild(body);
  return card;
}

const deps = { highlightCode: async () => "" };
const codeText = load("_codeCardText", deps);
const collect = load("_userExpandedCodeTexts", { ...deps, _codeCardText: codeText });
const restore = load("_restoreUserExpandedCode", {
  ...deps, _codeCardText: codeText, _expandCodeCard: load("_expandCodeCard", deps),
});

test("只收集用户亲手展开过的卡，不收流式期间自动开着的", () => {
  const root = new N("div");
  root.appendChild(mkCard("AAA", { folded: false, userFold: "0" }));  // 用户点开过
  root.appendChild(mkCard("BBB", { folded: false }));                  // 流式自动开着，没点过
  root.appendChild(mkCard("CCC", { folded: true, userFold: "1" }));    // 用户亲手收起的
  const got = collect(root);
  assert.deepEqual([...got], ["AAA"],
    "流式期间自动展开的卡不是用户意图，收尾把它们折起来是 markdown.js 有意的设计");
});

test("重建之后，用户展开过的那张被重新展开并补出正文", () => {
  const rebuilt = new N("div");
  const a = mkFoldedWithBody("AAA");        // 重建后一律折叠态
  const b = mkFoldedWithBody("BBB");
  rebuilt.appendChild(a); rebuilt.appendChild(b);
  restore(rebuilt, new Set(["AAA"]));
  assert.ok(!a.classList.contains("is-folded"), "用户展开过的这张应该被恢复成展开");
  assert.equal(a.dataset.userFold, "0", "意图要跟着一起恢复，否则下一次重建又丢");
  assert.equal(a.querySelector("code").textContent, "AAA",
    "折叠卡的正文是懒建的：只去掉 class 而不补正文，展开后是一张空卡");
  assert.equal(a.dataset.code, undefined, "建完要把 data-code 还回去");
  assert.ok(b.classList.contains("is-folded"), "没被用户点过的那张应该保持折叠");
});

test("正文一样但顺序变了也能对上（下标不可靠，dedupe 会删段落）", () => {
  const rebuilt = new N("div");
  rebuilt.appendChild(mkFoldedWithBody("ZZZ"));
  const target = mkFoldedWithBody("AAA");
  rebuilt.appendChild(target);
  restore(rebuilt, new Set(["AAA"]));
  assert.ok(!target.classList.contains("is-folded"), "按正文匹配失败了——用下标就会错位");
});

test("没有用户展开过的卡时不动任何东西", () => {
  const rebuilt = new N("div");
  const a = mkFoldedWithBody("AAA");
  rebuilt.appendChild(a);
  restore(rebuilt, new Set());
  assert.ok(a.classList.contains("is-folded"));
});
