// 终端里选中的输出拖进输入框（用户：「让终端里面的内容 也能拖拽到对话框里面用」）。
//
// 判定命中要自己算：xterm 用 WebGL/Canvas 画字，选区**不是 DOM 节点**，
// elementFromPoint 只拿得到那张画布。这一份跑真代码，钉的是格子坐标换算和边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInTermSelection, trimTermText, termChipLabel, termSnippetText } from "../src/agent/term-drag.js";
import { fnSource, CODE } from "./helpers/source.mjs";

// 100,50 起，80 列 × 20 行，每格 10 × 20 像素。
const RECT = { left: 100, top: 50, width: 800, height: 400 };
const hit = (x, y, sel, viewportY = 10) =>
  pointInTermSelection(x, y, { rect: RECT, cols: 80, rows: 20, sel, viewportY });
// 缓冲区第 r 行 / 第 c 列格子的中心点（viewportY=10）
const cell = (c, r) => [100 + c * 10 + 5, 50 + (r - 10) * 20 + 10];

test("单行选区：只有选中的那几格算命中，右端是开区间", () => {
  const sel = { start: { x: 3, y: 12 }, end: { x: 9, y: 12 } };
  assert.equal(hit(...cell(5, 12), sel), true, "选区正中都判不中");
  assert.equal(hit(...cell(3, 12), sel), true, "左端第一格不算命中");
  assert.equal(hit(...cell(8, 12), sel), true, "右端最后一格不算命中");
  assert.equal(hit(...cell(9, 12), sel), false, "end.x 是开区间，第 9 格不该算");
  assert.equal(hit(...cell(2, 12), sel), false, "选区左边算命中了");
  assert.equal(hit(...cell(5, 11), sel), false, "上一行算命中了");
  assert.equal(hit(...cell(5, 13), sel), false, "下一行算命中了");
});

test("多行选区：首行从起点起、末行到终点止、中间整行都算", () => {
  const sel = { start: { x: 40, y: 12 }, end: { x: 6, y: 15 } };
  assert.equal(hit(...cell(39, 12), sel), false, "首行起点之前算命中了");
  assert.equal(hit(...cell(41, 12), sel), true, "首行起点之后不算命中");
  assert.equal(hit(...cell(0, 13), sel), true, "中间整行的行首不算命中");
  assert.equal(hit(...cell(79, 14), sel), true, "中间整行的行尾不算命中");
  assert.equal(hit(...cell(5, 15), sel), true, "末行终点之前不算命中");
  assert.equal(hit(...cell(6, 15), sel), false, "末行 end.x 是开区间，第 6 格不该算");
  assert.equal(hit(...cell(5, 16), sel), false, "末行之后算命中了");
});

test("滚上去之后行号要跟着视口换算", () => {
  const sel = { start: { x: 0, y: 300 }, end: { x: 5, y: 300 } };
  // 视口顶端在第 295 行 → 缓冲区 300 行落在屏幕第 5 行
  assert.equal(pointInTermSelection(105, 50 + 5 * 20 + 10,
    { rect: RECT, cols: 80, rows: 20, sel, viewportY: 295 }), true, "没按 viewportY 换算");
  // 同一个像素点，视口没滚时对应的是别的缓冲区行
  assert.equal(pointInTermSelection(105, 50 + 5 * 20 + 10,
    { rect: RECT, cols: 80, rows: 20, sel, viewportY: 0 }), false, "viewportY 被无视了");
});

test("没有选区、框外、尺寸为 0，一律不算命中", () => {
  const sel = { start: { x: 3, y: 12 }, end: { x: 9, y: 12 } };
  // 这一条是**最要紧的**：判错成 true，整个终端就变成可拖区，「按住拖来选字」这个终端
  // 最基本的操作会被整个盖掉——而它恰恰是用户为了拖必须先做的那一步。
  assert.equal(hit(...cell(5, 12), null), false, "没有选区时判成了命中");
  assert.equal(hit(...cell(5, 12), { start: null, end: null }), false);
  assert.equal(hit(50, 45, sel), false, "终端框外判成了命中");
  assert.equal(hit(100 + 800, 50 + 10, sel), false, "右边界是开区间，正好在边上不该算");
  assert.equal(pointInTermSelection(105, 55, { rect: { left: 0, top: 0, width: 0, height: 0 }, cols: 80, rows: 20, sel }),
    false, "终端还没排版出来（宽高 0）时判成了命中");
});

test("行尾的填充空格要削掉", () => {
  // 终端是定宽网格，选到行尾会带一长串空格。原样进代码块就是一片方阵，还白占 token。
  assert.equal(trimTermText("$ ls   \nfoo   \n\n"), "$ ls\nfoo");
  assert.equal(trimTermText("  缩进保留   "), "  缩进保留");
  assert.equal(trimTermText(null), "");
});

test("片上的标签：一行就显示那一行，多行才计数", () => {
  assert.equal(termChipLabel("终端 1", "pip install pyright   "), "终端 1: pip install pyright");
  assert.equal(termChipLabel("终端 1", "a\nb\nc"), "终端 1: 3 行");
  assert.equal(termChipLabel("终端 1", "   \n  "), "终端 1: 空");
  assert.equal(termChipLabel("", "ls"), "终端: ls");
  // 太长要按**显示宽度**夹（中日韩两格），不是按字符数——按字符数夹，中文那行会宽出一倍。
  const long = termChipLabel("终端 1", "这是一条很长很长很长很长很长很长的中文输出", 20);
  assert.ok(long.endsWith("…"), "超长没有省略号");
  // 判据钉在**正文那一段**上：夹的是正文，前缀「终端 1: 」不参与。20 的显示宽度预算，
  // 汉字两格 → 最多 9 个再加省略号；按字符数夹的话这里会是 19 个，宽出一倍。
  const body = long.split(": ").slice(1).join(": ");
  assert.ok([...body].filter((c) => /[一-鿿]/.test(c)).length <= 10,
    `按字符数夹的，中文会超宽：${body}`);
});

test("发送时展开：带出处、围栏按内容算、截断要明说", () => {
  const out = termSnippetText({ label: "终端 1", cwd: "/w/proj", text: "$ ls\nfoo" });
  assert.match(out, /用户在「终端 1」里选中的输出（工作目录 \/w\/proj）/, "没带出处");
  assert.match(out, /```\n\$ ls\nfoo\n```/, "正文没进代码块");

  // 输出里本来就有 ``` 时，固定三个反引号会把块提前关掉，后半段变成正文。
  const fenced = termSnippetText({ label: "终端 1", text: "前\n```\n里面\n```\n后" });
  assert.match(fenced, /````\n前/, "围栏没有按内容加长——后半段会漏出代码块");

  // 截断必须写清楚。默默少给几行，模型会以为自己看到了全部日志然后据此下结论。
  const cut = termSnippetText({ label: "终端 1", text: Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"), maxLines: 10 });
  assert.match(cut, /选区共 50 行，这里只带了前 10 行/, "截断了却没说");
  assert.ok(!cut.includes("line10"), "说是只带 10 行，实际带多了");

  // 取空不许抛：这一层跑在发送路径上，抛一次整轮就发不出去。
  assert.doesNotThrow(() => termSnippetText(null));
  assert.doesNotThrow(() => termSnippetText({ text: null }));
});

// ── 接线那一半 ────────────────────────────────────────────────────────────
test("终端片走的是「短记号 + 快照」，不是把整段输出灌进输入框", () => {
  const fn = fnSource("_wireTermDragToComposer", { code: true });
  assert.match(fn, /_termPicked\.set\(id, \{ label: c\.label, cwd: c\.cwd, text: c\.text \}\)/,
    "没存快照——终端输出是一次性的，发送时再去抓就不是他指的那一段了");
  assert.match(fn, /_insertRefAtCursor\(id, "term", _termChipLabel\(/,
    "插进输入框的不是一枚片");
  assert.ok(!/promptEl\.(textContent|innerText)\s*\+=/.test(fn),
    "把整段输出直接拼进输入框了——会把用户已经打的字和别的片冲掉");
  // 快照有上限：终端选中是高频动作，不封顶一次会话能攒出几百份输出。
  assert.match(fn, /_termPicked\.size > TERM_PICK_CAP/, "快照没有上限");
});

test("没按在选中的字上就不许拦——否则整个终端都没法框选了", () => {
  const fn = fnSource("_wireTermDragToComposer", { code: true });
  // 判据要**顺序敏感**：只问"两者都在"是不够的——在前面多加一句 preventDefault，
  // 后面那句原封不动，`命中判定 … preventDefault` 这个形状照样匹配得上，而行为已经坏了
  // （整个终端变成可拖区，框选没了）。所以钉的是：拦截**只能**出现在命中判定之后。
  const guard = fn.indexOf("if (!hit) return;");
  assert.ok(guard > 0, "命中判定那道门没了");
  assert.equal(fn.slice(0, guard).includes("preventDefault"), false,
    "命中判定之前就拦了 mousedown——按住拖来选字这个最基本的操作会被整个盖掉");
  assert.ok(fn.slice(guard).includes("e.preventDefault();"), "命中之后没有拦下这次 mousedown");
  assert.match(fn, /if \(!wasDragging\) \{ try \{ term\.clearSelection\?\.\(\); \} catch \{\} return; \}/,
    "拦了 mousedown 却没补回「点一下取消选中」");
});

test("@term 记号三处都认：不当本地路径扫、气泡里画成片、发送时展开", () => {
  assert.match(CODE, /const _REMOTE_AT = \/\^\(github\|gitlab\|gitee\|codeberg\|model\|element\|code\|term\):/,
    "@term 没从本地路径扫描里摘出去——会拿 t3 去 readTextFile/readDir，两次都抛还白占一个 @ 名额");
  assert.match(CODE, /const pfx = \/\^\(github\|gitlab\|mcp\|term\):\(\.\+\)\$\/\.exec\(rel\)/,
    "气泡里 @term 没走前缀那支——会被当成本地路径画成文件夹图标");
  assert.match(CODE, /@term:\(\[A-Za-z0-9\]\+\)/, "发送期没有展开 @term");
  // 快照没了要说一句，不能静默返回空——那样模型看到一个孤零零的记号，只会当成用户打错字。
  const ctx = fnSource("_termContextFor", { code: true });
  assert.match(ctx, /已经取不到的终端输出/, "快照丢了却什么都不说");
});
