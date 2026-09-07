import test from "node:test";
import assert from "node:assert";
import { CODE } from "./helpers/source.mjs";

const NOOP = { redact: (t) => t };   // 回显必须显式接打码器，见下面「失败关闭」那条
import { changedSnippet, changedRange, editEchoNote } from "../src/agent/edit-echo.js";

const FILE = ["import a from \"a\";", "", "function foo() {", "  return 1;", "}", "", "function bar() {", "  return 2;", "}"].join("\n");

test("改完把落点带行号回给模型——这是「改完再读一遍」那一步的替代物", () => {
  const out = changedSnippet(FILE, FILE.replace("  return 2;", "  return 99;"));
  assert.match(out, /8\u2502 {2}return 99;/, "改动那一行没带行号回来");
  // 上下文要够看清落在哪个函数里——只回改动行等于没回答「改到第几处」。
  assert.match(out, /function bar/);
  assert.doesNotMatch(out, /function foo/, "上下文放太宽，等于把文件又传了一遍");
  // 行号右对齐，宽度跟着最大行号走。
  assert.ok(editEchoNote(FILE, FILE.replace("  return 2;", "  return 99;"), NOOP).includes("改动后的片段"));
});

test("一字未改 / 入参不合用时一个字都不加", () => {
  assert.equal(changedSnippet(FILE, FILE), "", "内容没变还回显，等于凭空多一段噪音");
  assert.equal(editEchoNote(FILE, FILE, NOOP), "");
  assert.equal(editEchoNote(FILE, "", NOOP), "");
  assert.equal(editEchoNote(FILE, null, NOOP), "");
  assert.equal(changedRange(FILE, FILE), null);
});

test("增、删、改三种形状都定位得到，纯删除圈的是接缝那一行", () => {
  assert.deepEqual(changedRange("a\nb\nc", "a\nX\nc"), { from: 1, to: 1 });   // 改
  assert.deepEqual(changedRange("a\nc", "a\nb\nc"), { from: 1, to: 1 });       // 增
  assert.deepEqual(changedRange("a\nb\nc", "a\nc"), { from: 1, to: 1 });       // 删：new 上没有新行
  assert.match(changedSnippet("a\nb\nc", "a\nc"), /2\u2502c/, "删完之后接上了谁，模型得看得见");
});

test("必须封顶：行数、字符数、以及压缩产物那种超长单行", () => {
  const many = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  // needle 必须**跨多行**。只替换一行时窗口本来就只有 1+2*CONTEXT 行，永远撞不到上限——
  // 那样的断言即使把封顶整个删掉也照样绿（实测：变异「去掉行数封顶」曾经通过）。
  const big = Array.from({ length: 150 }, (_, i) => `line ${i + 100}`).join("\n");
  const out = changedSnippet(many, many.replace(big, big.replace(/line/g, "LINE")));
  assert.ok(out.split("\n").length <= 25, `回显 ${out.split("\n").length} 行，没有封顶`);
  assert.match(out, /片段已截断/, "截断了却没告诉模型，它会以为这就是全部");

  const huge = "head\n" + "x".repeat(50000) + "\ntail";
  const wide = changedSnippet(huge, "head\n" + "y".repeat(50000) + "\ntail");
  assert.ok(wide.length < 1000, `单行没截断，回显 ${wide.length} 字符——一行就能把回执撑爆`);
  assert.match(wide, /本行过长已截断/);
});

test("批量替换要说明这一段覆盖了几处", () => {
  const edited = FILE.replace("  return 1;", "  return 9;");
  assert.match(editEchoNote(FILE, edited, { moreEdits: 2, redact: (t) => t }), /本次共 3 处替换/);
  assert.doesNotMatch(editEchoNote(FILE, edited, { moreEdits: 0, redact: (t) => t }), /本次共/);
});

test("两条写路径都接上了，且整文件重写不回显", () => {
  assert.match(CODE, /call\.type === "edit" \? _editEchoNote\(old, newContent, \{ redact: _redactSecrets \}\) : ""/,
    "单笔 edit 没接上，或者没把整文件 write 排除掉");
  assert.match(CODE, /_editEchoNote\(old, newContent, \{ moreEdits: edits\.length - 1, redact: _redactSecrets \}\)/,
    "multi_edit 没接上——它才是改存量代码最常走的那条");
});

test("失败关闭：没接打码器就一个字不回显", () => {
  // 这段片段是文件正文，会随工具结果进模型上下文。read_file 那条路早就在打码
  // （「此前这里发的是逐字符原文」——同一个坑仓库里踩过一次）。默认放行等于给这条
  // 新出口开一个静默的密钥外泄口，所以判据反过来：没接打码器就当没配好。
  const edited = FILE.replace("  return 1;", "  return 9;");
  assert.equal(editEchoNote(FILE, edited), "", "不传 redact 竟然回显了原文");
  assert.equal(editEchoNote(FILE, edited, {}), "");
  assert.equal(editEchoNote(FILE, edited, { redact: "不是函数" }), "");
  assert.ok(editEchoNote(FILE, edited, NOOP).includes("改动后的片段"), "接了打码器反而不回显");
});

test("片段碰到疑似密钥就整段省掉，并指路 read_file", () => {
  // 不在这里另开一个编号打码出口：占位符要按 run 级序号回写，read_file 是唯一那个出口，
  // 这里再来一份会让同一段内容出现两种占位符渲染。
  const before = 'const t = "x";';
  const after = 'const t = "sk-live-ABCDEFGH12345678";';
  const note = editEchoNote(`a\n${before}\nb`, `a\n${after}\nb`, { redact: (t) => t.replace(/sk-live-\w+/, "[R]") });
  assert.doesNotMatch(note, /sk-live-ABCDEFGH12345678/, "密钥明文进了模型上下文");
  assert.match(note, /已省略片段回显/);
  assert.match(note, /read_file/, "省掉了却不指路，模型不知道该怎么核对");
});
