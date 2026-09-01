// 编辑器里选中的一段代码拖进输入框。
//
// 用户原话：「我鼠标选中的内容 要能够直接拖拽到对话框那里 使用」。
// 纯的那一半（标签怎么写、正文怎么围栏、超长怎么截断）在这里真跑；鼠标那一半留在 main.js，
// 下面用锚点钉住它确实接上了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionLabel, selectionText, selectionToken, parseSelectionToken, sliceLines } from "../src/agent/selection-drag.js";
import { SRC, blockFrom, fnSource } from "./helpers/source.mjs";

test("片上的标签：只留文件名 + 行号范围，单行不写范围", () => {
  // 和输入框里其它每一种片同一条规则：只显示最后一段名字（完整路径进 tooltip）。
  assert.equal(selectionLabel("cursor_proxy/extract_fields.py", 8, 17), "extract_fields.py:8-17");
  assert.equal(selectionLabel("a.py", 8, 8), "a.py:8", "单行还写成 8-8 只是噪音");
  assert.equal(selectionLabel("a.py", 8), "a.py:8");
  // 坏输入不许炸：它跑在拖放路径上。
  assert.equal(selectionLabel("", 0, 0), ":1");
  assert.equal(typeof selectionLabel(null), "string");
});

test("展开的正文带出处——模型要知道是哪个文件的哪几行才能改它", () => {
  const t = selectionText({ rel: "cursor_proxy/x.py", lang: "python", startLine: 8, endLine: 9, code: "a=1\nb=2" });
  assert.match(t, /引用 cursor_proxy\/x\.py 第 8-9 行/, "没带出处，模型只能猜这段在哪");
  assert.match(t, /```python\na=1\nb=2\n```/, "代码没有进围栏，会和用户自己的话糊在一起");
  assert.match(selectionText({ rel: "x.py", startLine: 3, endLine: 3, code: "a" }), /第 3 行/, "单行也要写清楚");
});

test("围栏按内容算：选区里自带 ``` 也不能把块提前关掉", () => {
  // markdown、文档字符串里嵌代码块都很常见。固定三个反引号的话，后半段代码会变成正文。
  const code = "前言\n```js\nconsole.log(1)\n```\n收尾";
  const t = selectionText({ rel: "a.md", lang: "markdown", code, startLine: 1, endLine: 5 });
  const fence = /\n(`{4,})markdown\n/.exec(t);
  assert.ok(fence, "围栏没有比内容里最长的那串反引号更长——代码块会提前关掉");
  assert.ok(t.endsWith(`${fence[1]}\n`), "结尾围栏和开头不一致");
  assert.ok(t.includes(code), "代码被改过——它必须原样进块里");
  // 再长一点的也要跟着长。
  const t2 = selectionText({ rel: "a.md", code: "````\nx\n````", startLine: 1, endLine: 3 });
  assert.match(t2, /\n`{5,}\n/, "内容里有四个反引号时围栏没跟着加长");
});

test("超长要明说截断了，不能默默少给几行", () => {
  // 默默少给会让模型以为自己看到了全部，然后基于半段代码下结论。
  const code = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const t = selectionText({ rel: "a.py", code, startLine: 1, endLine: 500, maxLines: 10 });
  assert.match(t, /选区共 500 行，这里只带了前 10 行/, "截断了却没说");
  assert.ok(!t.includes("line 20"), "maxLines 没生效");
  // 字符上限同样要说。
  const wide = Array.from({ length: 5 }, () => "x".repeat(400)).join("\n");
  const t2 = selectionText({ rel: "a.py", code: wide, startLine: 1, endLine: 5, maxChars: 500 });
  assert.match(t2, /只带了前 \d+ 行/, "按字符截断时没说");
  // 没超就不许无中生有地说截断。
  assert.doesNotMatch(selectionText({ rel: "a.py", code: "a\nb", startLine: 1, endLine: 2 }), /只带了前/,
    "没截断却说截断了");
});

test("坏输入一律不抛——它跑在拖放路径上", () => {
  for (const bad of [undefined, null, {}, { code: null }, { code: 123 }]) {
    assert.doesNotThrow(() => selectionText(bad));
  }
});

test("main.js 真的接上了：按在选区里才算候选，落到输入框才插片", () => {
  const h = blockFrom("(function _wireSelectionDragToComposer() {");
  // 判据是「按下的位置在不在选区里」。少了这一条，编辑器里任何一次按下拖动都会变成拖代码，
  // 正常的框选就没法做了。
  assert.match(h, /sel\.containsPosition\(t\.position\)/,
    "没有判「按在选区里」——普通框选会被当成拖拽");
  assert.match(h, /monacoEditor\.getTargetAtClientPoint\(e\.clientX, e\.clientY\)/,
    "没有把鼠标位置换算成编辑器里的位置");
  // 阈值：不走够距离不算拖，否则点一下就插一枚片。
  assert.match(h, /< 6\) return;/, "没有拖拽阈值——点一下就会插片");
  // 只在落到输入框上时才插，且插的是 code 片 + 展开的正文。
  assert.match(h, /_insertRefAtCursor\(c\.rel, "code", _selectionLabel\([\s\S]{0,80}_selectionToken\(/,
    "落点没有接到 code 片上，或者又把整段代码塞进片里了");
  // 片带的是短记号；_chipText 序列化时两侧要留空格，否则提及扫描（按空白切）认不出它。
  assert.match(fnSource("_chipText"), /if \(kind === "code"\) return " " \+ \(chip\?\.dataset\?\.text \|\| ""\) \+ " ";/,
    "code 片的记号没有两侧留空格——提及扫描按空白切，贴着别的字就认不出来");
  assert.match(fnSource("_insertRefAtCursor"), /if \(dataText\) chip\.dataset\.text = dataText;/,
    "插入时没有把记号挂到片上，发送出去会是空的");
  // 记号不许被当成本地路径去读：那会 readTextFile("code:…") 抛错、被吞掉，还白占一个提及名额。
  // 名单又长了一个（term：终端里拖进来的输出）。守的是「@code: 在名单里」，不是名单的长度。
  assert.match(SRC, /_REMOTE_AT = \/\^\([a-z|]*\bcode\b[a-z|]*\):/,
    "@code: 没有从本地路径扫描里摘出去");
  // 发送期真的按记号把那几行读回来，展开进上下文。
  assert.match(SRC, /const ref = _parseSelectionToken\(tok\);/, "发送期没有解析 @code: 记号");
  assert.match(SRC, /_sliceLines\(await backend\.readTextFile\(fp\), ref\.startLine, ref\.endLine\)/,
    "没有按行号把那几行读回来——模型只会收到一个记号，看不到代码");
  // 气泡里也画成片，而不是把代码摊出来。
  assert.match(fnSource("_renderMentionsToHtml"), /const code = _parseSelectionToken\(rel\);/,
    "气泡里没有把 @code: 记号画成片");
  // 图标用这个文件真正的图标，且必须从 rel 算 —— code 片的 name 是「quota.py:275-284」，
  // 带着行号去查扩展名会落到兜底图标上（用户：「前面图标要用真实的文件图标」）。
  assert.match(SRC, /kind === "code"\s*\n?\s*\? iconImg\(fileIconUrl\(rel\.split\("\/"\)/,
    "code 片没有用真实的文件图标，或者图标是从带行号的 name 算的");
});

test("发出去的是短记号，不是一大坨代码", () => {
  // 用户：「发出去的内容也要是组件囊」。片直接展开成代码块的话，气泡里就是一整屏代码。
  // 和 @element: 同一条路子：可见文本只留短记号，代码在发送期展开进上下文。
  assert.equal(selectionToken("cursor_proxy/quota.py", 286, 303), "@code:cursor_proxy/quota.py#286-303");
  // 单行也写成 #286-286：标签那边可以省掉范围，记号不行——省了解析处就得多一支。
  assert.equal(selectionToken("a.py", 5, 5), "@code:a.py#5-5");
  // 记号里不能有空格，否则提及扫描（按空白切）会把它切断。
  assert.doesNotMatch(selectionToken("a b/c.py", 1, 2), / /,
    "路径带空格时记号会被提及扫描切断——那样气泡里画不出片，上下文也展不开");
  // 编码必须可逆，否则展开时按错误的路径去读文件。
  for (const rel of ["a b/c.py", "有 空格/x.py", "100%/y.py", "a\tb/z.py", "plain/ok.py"]) {
    assert.equal(parseSelectionToken(selectionToken(rel, 1, 2))?.rel, rel, `${rel} 没有原样还原`);
  }
});

test("记号解析：认得出就还原，认不出一律 null", () => {
  assert.deepEqual(parseSelectionToken("@code:a/b.py#286-303"), { rel: "a/b.py", startLine: 286, endLine: 303 });
  assert.deepEqual(parseSelectionToken("code:a/b.py#1-1"), { rel: "a/b.py", startLine: 1, endLine: 1 });
  // 路径里带 # 或 : 也要还原对：正则取的是**最后**一个 #。
  assert.deepEqual(parseSelectionToken("@code:a#b/c.py#2-3"), { rel: "a#b/c.py", startLine: 2, endLine: 3 });
  // 别的前缀不许被它抢走——@github:owner/repo 有自己的分支。
  for (const bad of ["@github:o/r", "@a.py", "@code:a.py", "@code:a.py#x-y", "", null, undefined]) {
    assert.equal(parseSelectionToken(bad), null, `不该认下 ${String(bad)}`);
  }
});

test("按行号切片：1 起算、两端都含、越界只取交集", () => {
  const f = "l1\nl2\nl3\nl4\nl5";
  assert.equal(sliceLines(f, 2, 4), "l2\nl3\nl4");
  assert.equal(sliceLines(f, 3, 3), "l3", "单行没取到");
  // 文件在拖进来之后被改短了是常事：给出剩下的部分，好过整条丢掉。
  assert.equal(sliceLines(f, 4, 99), "l4\nl5", "越界应该只取交集");
  assert.equal(sliceLines(f, 0, 1), "l1", "行号从 1 起算");
  assert.doesNotThrow(() => sliceLines(null, 1, 2));
});

test("⌘/Ctrl + 单击直接跳过去，不弹 Peek", () => {
  // 用户：「ide 没有点击变量、函数的跳转功能吗，类似与 vscode 中的 Ctrl+鼠标左键」。
  // 跳转链路本来就通（lsp-client 注册了 definition provider，main.js 注册了
  // registerEditorOpener 把跨文件的目标接进页签系统），卡在这个选项上：
  // definitionLinkOpensInPeek: true 的意思是"这个鼠标手势永远只开 Peek 浮层"，
  // 于是点了半天页面不动，看着就像没有跳转功能。VS Code 的默认是 false。
  const opts = blockFrom("const monacoEditor = monaco.editor.create(editorEl, {");
  assert.match(opts, /definitionLinkOpensInPeek:\s*false/,
    "⌘+单击又只弹 Peek 了——用户要的是像 VS Code 那样直接跳过去");
  // 命中多个定义时仍然 Peek，这和 VS Code 一致，别一起改掉。
  assert.match(opts, /multipleDefinitions:\s*"peek"/, "多个定义时的 Peek 被顺手改掉了");
  // 跨文件跳转靠这个 opener 接进我们自己的页签系统；它没了就只能在同一个文件里跳。
  assert.match(SRC, /monaco\.editor\.registerEditorOpener\(\{/,
    "跨文件跳转的 opener 没了——跳到别的文件会静默什么都不发生");
});

// ── 拖的过程里编辑器不许自己滚 ─────────────────────────────────────────────
//
// 用户实拍：「将文件内容选中后拖拽对话框时候，不应该滚轮往上和往下，可能一下滑到底下的
// 代码或者顶上代码」。真凶在 Monaco：指针一离开内容区，mouseHandler 里
// `position.type === OUTSIDE_EDITOR` 那条分支就启动 TopBottom/LeftRight DragScrolling，
// 每 10ms 一次，一边滚一边用 _dispatchMouse 把选区**朝指针方向拉长**。
//
// 这一份**真跑**那段接线：造一个假编辑器，按下、拖出去、发一次滚动事件，看它拨不拨回去。
function runSelectionDrag({ scrollMax = Infinity } = {}) {
  const calls = { setTop: [], setLeft: [], setSel: [], chips: [], disposed: 0 };
  const listeners = {};
  const rect = (l, t, w, h) => () => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
  const cls = () => ({ add() {}, remove() {}, toggle() {} });
  const box = { getBoundingClientRect: rect(900, 700, 300, 80), classList: cls() };
  const promptEl = { closest: () => box };
  const editorEl = {
    getBoundingClientRect: rect(100, 100, 700, 500),
    addEventListener: (t, fn) => { listeners["editor:" + t] = fn; },
  };
  let scrollTop = 4200, scrollLeft = 0, scrollCb = null;
  const SEL = { startLineNumber: 22, endLineNumber: 39, isEmpty: () => false, containsPosition: () => true };
  const monacoEditor = {
    getSelection: () => SEL,
    getModel: () => ({ getLanguageId: () => "markdown", getValueInRange: () => "code" }),
    getTargetAtClientPoint: () => ({ position: { lineNumber: 30, column: 1 } }),
    getScrollTop: () => scrollTop,
    getScrollLeft: () => scrollLeft,
    // 照 Monaco 的真实语义来：**setScrollTop 自己会再发一次滚动事件**。少了这一条，
    // 「自激」那条测试就是恒真的——回拨代码不管写没写防护都只会被调一次。
    setScrollTop: (v) => {
      calls.setTop.push(v);
      if (calls.setTop.length > 40) throw new Error("回拨自激了：一次滚动引出了停不下来的来回");
      // 夹取是真实存在的：文档变短之后，Monaco 会把 setScrollTop 夹到当前最大值。
      // 于是"拨回去"永远拨不到目标值——没有自激防护的话这里就是一个停不下来的来回。
      scrollTop = Math.min(v, scrollMax); scrollCb?.();
    },
    setScrollLeft: (v) => { calls.setLeft.push(v); scrollLeft = v; scrollCb?.(); },
    onDidScrollChange: (cb) => { scrollCb = cb; return { dispose: () => { calls.disposed++; scrollCb = null; } }; },
    setSelection: (s) => calls.setSel.push(s),
  };
  const body = blockFrom("(function _wireSelectionDragToComposer() {");
  new Function(
    "promptEl", "editorEl", "monacoEditor", "document", "window", "activePath",
    "_pathToRel", "_selectionLabel", "_selectionToken", "_insertRefAtCursor",
    `(function()${body})();`,
  )(
    promptEl, editorEl, monacoEditor,
    {
      addEventListener: (t, fn) => { listeners["doc:" + t] = fn; },
      body: { classList: cls(), appendChild() {} },
      createElement: () => ({ className: "", textContent: "", style: {}, remove() {} }),
    },
    { getSelection: () => ({ removeAllRanges() {} }) },
    "/w/README.md", () => "README.md", () => "README.md:22-39", () => "@code:README.md#22-39",
    (...a) => calls.chips.push(a),
  );
  return {
    calls,
    down: (x, y) => listeners["editor:mousedown"]({ button: 0, clientX: x, clientY: y }),
    move: (x, y) => listeners["doc:mousemove"]({ clientX: x, clientY: y }),
    up: (x, y) => listeners["doc:mouseup"]({ clientX: x, clientY: y }),
    scrollTo: (v) => { scrollTop = v; scrollCb?.(); },
    top: () => scrollTop,
  };
}

test("拖的过程里 Monaco 自己滚了，要被拨回去", () => {
  const h = runSelectionDrag();
  h.down(300, 300);              // 按在选区里
  h.move(320, 305);              // 走够阈值 → 开始拖，此刻记下 4200
  h.scrollTo(0);                 // Monaco 的 DragScrolling 把它滚到了顶上
  assert.deepEqual(h.calls.setTop, [4200], "滚上去了却没拨回来——用户拖到一半代码就飞走了");
  assert.equal(h.top(), 4200);
  h.scrollTo(9999);              // 再滚到底
  assert.deepEqual(h.calls.setTop, [4200, 4200], "只拨得回第一次");
});

test("拨回去不许自激：目标值被夹住时也只拨一次", () => {
  // setScrollTop 自己会再发一次滚动事件，而**它不保证落到你给的那个值**——文档变短之后
  // Monaco 会把它夹到当前最大值。于是 `拨到的值 !== 想要的值` 永远成立：没有自激防护，
  // 这里就是一个停不下来的来回（真机上是主线程直接卡死）。
  const h = runSelectionDrag({ scrollMax: 1000 });   // 想拨回 4200，最多只能到 1000
  h.down(300, 300); h.move(320, 305);
  assert.doesNotThrow(() => h.scrollTo(0), "回拨自激了——一次滚动引出停不下来的来回");
  assert.equal(h.calls.setTop.length, 1, "一次滚动引出了不止一次回拨");
});

test("松手落在编辑器外：被拉长的选区还原；落在里面不碰它", () => {
  const out = runSelectionDrag();
  out.down(300, 300); out.move(320, 305);
  out.up(1000, 730);             // 落在输入框上（编辑器外）
  assert.equal(out.calls.setSel.length, 1, "落在编辑器外却没还原选区——它已经被 Monaco 拉长了");
  assert.equal(out.calls.chips.length, 1, "落到输入框上没插片");
  assert.ok(out.calls.disposed >= 1, "滚动监听没退订——拖完之后编辑器就再也滚不动了");

  const inside = runSelectionDrag();
  inside.down(300, 300); inside.move(320, 305);
  inside.up(400, 300);           // 落在编辑器里 = Monaco 自己的「拖动选中文字来移动它」
  assert.equal(inside.calls.setSel.length, 0, "落在编辑器里还去还原选区，会跟 Monaco 的移动打架");
  assert.equal(inside.calls.chips.length, 0, "没落到输入框上却插了片");
  assert.ok(inside.calls.disposed >= 1, "滚动监听没退订");
});

test("没拖起来（只是点了一下）就不冻结、也不还原", () => {
  const h = runSelectionDrag();
  h.down(300, 300);
  h.up(300, 300);                // 没走够阈值
  assert.deepEqual(h.calls.setTop, []);
  assert.equal(h.calls.setSel.length, 0, "点一下就把选区改了");
  assert.equal(h.calls.chips.length, 0);
});
