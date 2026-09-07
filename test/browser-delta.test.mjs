// 浏览器动作后的回执：变化 / 视口位置 / 节点清单 / 正文节选 / 下一步一句——纯函数，真跑不看源码。
import test from "node:test";
import assert from "node:assert/strict";
import { renderBrowserFeedback, browserDelta, renderElements, scrollLine, renderReadResult, renderFindResult, feedbackSnapshot, nextStepHint } from "../src/agent/browser-delta.js";

const st = (over = {}) => ({
  url: "https://a.io/b", title: "B",
  elements: [{ ref: 0, role: "link", text: "首页" }, { ref: 1, role: "textbox", text: "邮箱", state: "value=x@y.z" }, { ref: 2, role: "button", text: "登录", state: "disabled", off: true }],
  text: "hello", text_total: 9000, scroll: { y: 800, height: 4000, viewport: 800 },
  ...over,
});

test("第一步不说变化；第二步说 URL/标题/节点/滚动/焦点的变化；动作后什么都没变要点名说出来", () => {
  assert.deepEqual(browserDelta(null, st(), "click"), []);
  const prev = feedbackSnapshot(st({ url: "https://a.io/", title: "A", scroll: { y: 0, height: 4000, viewport: 800 } }));
  const lines = browserDelta(prev, st({ focus: 'input[node=1] "x"' }), "click");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /URL：https:\/\/a\.io\/ → https:\/\/a\.io\/b/);
  assert.match(lines[0], /标题：「A」→「B」/);
  assert.match(lines[0], /滚动位置 0 → 800/);
  assert.match(lines[0], /焦点在 input\[node=1\]/);
  const same = browserDelta(feedbackSnapshot(st()), st(), "click");
  assert.match(same[0], /页面没有变化/, "动作后没变化必须说出来，否则模型会原样重发");
  assert.deepEqual(browserDelta(feedbackSnapshot(st()), st(), "read"), [], "读类动作页面不变是正常的，不该报");
});

test("对话框、新标签页、弹层被关掉三件事各说一句，且不依赖上一步", () => {
  const lines = browserDelta(null, st({ dialog: { kind: "confirm", message: "Sure?", accepted: true }, opened_tab: { index: 1, title: "详情", url: "https://a.io/d" }, overlay_dismissed: "接受全部" }), "click");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /confirm「Sure\?」，已自动按确定/);
  assert.match(lines[1], /新标签页 \[1\] 详情 — https:\/\/a\.io\/d/);
  assert.match(lines[1], /tab op:"switch"/);
  assert.match(lines[2], /「接受全部」/);
});

test("节点清单：视口内在前、off 在后、状态和值都显示、超出上限说数量；视口行会说下面还有几屏", () => {
  const text = renderElements(st().elements);
  assert.ok(text.indexOf("[0] link") < text.indexOf("[2] button"));
  assert.match(text, /\[1\] textbox "邮箱" = x@y\.z/);
  assert.match(text, /\[2\] button "登录" \{disabled\} off/);
  const many = renderElements(Array.from({ length: 130 }, (_, i) => ({ ref: i, role: "link", text: `l${i}`, off: i >= 100 })));
  assert.match(many, /还有 20 个没列/);
  assert.match(scrollLine(st()), /约 5\.0 屏高，现在在 40% 处，下面还有约 3\.0 屏/);
  assert.match(scrollLine(st({ scroll: { y: 0, height: 700, viewport: 800 } })), /整页一屏放得下/);
  assert.match(scrollLine(st()), /正文共 9000 字/);
  assert.equal(renderElements([]), "");
});

test("整段回执：读类动作不重复列节点和正文；read 的下一页 offset、find 的命中数进提示；快照给下一步比较", () => {
  const fb = renderBrowserFeedback({ act: "click", state: st(), prev: null });
  assert.match(fb.text, /可交互节点/);
  assert.match(fb.text, /页面可见文本（前 1500 字，全文 9000 字用 read 分页看）/);
  assert.match(fb.text, /读内容用 read/);
  assert.equal(fb.snapshot.count, 3);
  assert.equal(fb.snapshot.scrollY, 800);
  const rd = renderBrowserFeedback({ act: "read", state: st(), prev: null, extra: { next: 6000 } });
  assert.doesNotMatch(rd.text, /可交互节点/);
  assert.doesNotMatch(rd.text, /页面可见文本/);
  assert.match(rd.text, /read offset=6000/);
  assert.match(nextStepHint("read", { next: null }), /已读到末尾/);
  assert.match(nextStepHint("find", { count: 0 }), /没找到/);
  assert.match(nextStepHint("find", { count: 2 }), /已滚进视口/);
  assert.match(nextStepHint("batch"), /assert\/check\/find/);
  assert.match(nextStepHint("autofill"), /missing\/invalid/);
  assert.equal(nextStepHint("nodes"), "");
});

test("read / find 的结构化结果渲染：分页头、大纲、错误各有说法；命中带上下文和节点号", () => {
  const r = renderReadResult(JSON.stringify({ root: "main#c", offset: 0, chars: 5, total: 12, next: 5, outline: [{ l: 2, t: "章" }], crossOriginFrames: 1, text: "hello" }));
  assert.match(r.text, /main#c，第 0–5 字，共 12 字，还有后面/);
  assert.match(r.text, /大纲：## 章/);
  assert.match(r.text, /1 个跨域 iframe/);
  assert.equal(r.next, 5);
  assert.match(renderReadResult(JSON.stringify({ error: "selector_not_found", selector: "#x" })).text, /selector「#x」没有匹配到元素/);
  assert.equal(renderReadResult("not json").text, "not json");
  const f = renderFindResult(JSON.stringify({ query: "价格", nodeMatches: [{ i: 3, r: "button", n: "查价格", off: 1 }], textMatches: [{ ctx: "…价格 99 元…", node: 3, inView: false }], scrolled: true }));
  assert.equal(f.count, 2);
  assert.match(f.text, /节点 1 处，正文 1 处（第一处已滚进视口）/);
  assert.match(f.text, /\[3\] button "查价格" off/);
  assert.match(f.text, /→ node=3 \(视口外\)/);
  assert.match(renderFindResult(JSON.stringify({ error: "bad_pattern", detail: "x" })).text, /不是合法正则/);
  assert.match(renderFindResult(JSON.stringify({ error: "empty_query" })).text, /需要 text/);
  assert.match(renderFindResult(JSON.stringify({ query: "q", nodeMatches: [], textMatches: [] })).text, /没有命中/);
});
