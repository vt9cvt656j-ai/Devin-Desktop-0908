// 悬浮说明：内容显示全、样式跟应用一套、文档按用户选的语言翻。
//
// 用户：「内容都要显示全，然后就是那个意思好好显示全，样式好好搞搞。然后把变量，函数，
// 方法 根据用户选择的语言 进行自动翻译 对每个开发者都能很友好」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitDocSegments, docWorthTranslating, translateDocSegments, translateHoverMarkdown } from "../src/agent/hover-doc.js";
import { blockFrom, SRC } from "./helpers/source.mjs";

const css = () => readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const lsp = () => readFileSync(new URL("../src/lsp-client.js", import.meta.url), "utf8");

test("签名一个字都不翻，只翻围栏外的散文", () => {
  // 签名被翻了，`def show(buf, name) -> None` 就成了一句读不了也抄不走的话，比不翻更糟。
  const md = "```python\ndef show(buf, name) -> None\n```\n---\nOne turn conversation with a Cursor agent.";
  const segs = splitDocSegments(md);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].code, true, "代码围栏没被认出来——签名会被送去翻");
  assert.equal(segs[1].code, false);
  const out = translateDocSegments(segs, () => "一次与 Cursor 智能体的对话。");
  assert.ok(out.includes("def show(buf, name) -> None"), "签名被改了");
  assert.ok(out.includes("一次与 Cursor 智能体的对话。"), "散文没被翻");
});

test("围栏按开栏那一行的长度配对：文档里嵌四个反引号也不会提前收栏", () => {
  // 按固定三个配对的话，中间会提前收栏，后半段代码被当成散文翻掉。
  // 行首那道短围栏是关键：它在**行首**、但比开栏短，按长度配对不该收栏。
  const md = "````text\n```\nstill code\n````\nafter the block, prose here.";
  const segs = splitDocSegments(md);
  assert.equal(segs.filter((x) => x.code).length, 1, "围栏配对错了");
  assert.ok(segs[0].text.includes("still code"), "代码块在中间被切断了");
  assert.equal(segs[1].code, false);
});

test("不值得翻的一律不送：太短 / 已经不是拉丁文 / 凑不出两个词", () => {
  // 每一条否决都是「翻了反而更糟」。
  assert.equal(docWorthTranslating("None"), false, "类型名被送去翻了");
  assert.equal(docWorthTranslating("bool = False"), false, "参数默认值被送去翻了");
  assert.equal(docWorthTranslating("一次与智能体的对话，用来演示。"), false, "已经是中文了还要再翻一遍");
  // 夹着 API 名的中文文档最容易漏判：它有拉丁字母、也凑得出两个英文词。
  // 这一条必须有**相邻的两个英文词**（"is optional"），否则"凑不出两个词"那条就先把它挡了，
  // 中日韩占比这道门永远轮不到出场——那就是一道恒真的守卫。
  assert.equal(docWorthTranslating("这个函数把 buf 里的字段打印出来，参数 name is optional，其余照旧。"), false,
    "夹了几个 API 名的中文文档被当成英文又翻了一遍");
  // 反过来，夹几个中文标点的英文文档仍然要翻。
  assert.equal(docWorthTranslating("One turn conversation with a Cursor agent（see Usage）."), true,
    "夹了一对中文括号的英文文档被误判成已翻译");
  assert.equal(docWorthTranslating("cursor_proxy/session.py"), false, "路径被送去翻了");
  assert.equal(docWorthTranslating("One turn conversation with a Cursor agent."), true, "真文档没被送去翻");
});

test("翻不成就保留原文——悬浮说明宁可是英文，不能变空白", () => {
  const segs = splitDocSegments("One turn conversation with a Cursor agent.");
  for (const bad of [() => "", () => null, () => { throw new Error("boom"); }, null]) {
    const out = translateDocSegments(segs, bad);
    assert.ok(out.includes("One turn conversation"), "翻译失败时把原文也弄丢了");
  }
  assert.doesNotThrow(() => translateDocSegments(null, null));
});

test("整段走一遍：签名留着、散文翻掉、翻不成还原文", async () => {
  const md = "```python\ndef show(buf, name) -> None\n```\n---\nOne turn conversation with a Cursor agent.";
  const ok = await translateHoverMarkdown(md, async (texts) => new Map(texts.map((t) => [t, "一次与 Cursor 智能体的对话。"])));
  assert.ok(ok.includes("def show(buf, name) -> None"), "签名被改了");
  assert.ok(ok.includes("一次与 Cursor 智能体的对话。"), "散文没翻");
  // 翻译器炸了 / 返回空 / 压根没注入：一律还原文，绝不让悬浮说明变空。
  for (const bad of [undefined, null, async () => { throw new Error("boom"); }, async () => null, async () => new Map()]) {
    assert.equal((await translateHoverMarkdown(md, bad)).includes("One turn conversation"), true,
      "翻译这一步失败时把原文弄丢了");
  }
  assert.equal(await translateHoverMarkdown("", async () => new Map()), "");
});

test("hover provider 只认一个注入函数，自己不 import 任何东西", () => {
  const s = lsp();
  assert.match(s, /if \(typeof translateDoc === "function"\)/,
    "没有按「注入了才翻」门控");
  assert.match(s, /const merged = await translateDoc\(contents\.map\(\(c\) => c\.value\)\.join\("\\n\\n"\)\)/,
    "hover 没把整段 markdown 交给注入的翻译器");
  assert.match(s, /^\s{4}translateDoc,\s*$/m, "translateDoc 没有从 options 里解构出来");
  // 这个模块是被测试用 new Function 直接跑的：多一条静态 import 就整份加载不了。
  assert.doesNotMatch(s, /from "\.\/i18n\.js"/, "lsp-client 直接 import 了 i18n");
  assert.doesNotMatch(s, /from "\.\/agent\/hover-doc\.js"/,
    "lsp-client 静态 import 了 hover-doc —— test/lsp-client-lifecycle 会整份加载不了");
  // main.js 那侧真的把整条流程接上了，而且带超时。
  assert.match(SRC, /translateDoc: \(md\) => _translateHoverMarkdown\(md, \(texts\) => translateNow\(texts, \{ timeoutMs: \d+ \}\)\)/,
    "main.js 没有把翻译流程注入给 lsp-client，或者没给超时");
});

test("翻译走缓存 + 超时，慢的时候照样出英文", () => {
  // translateNow 在 i18n.js 里，不在 main.js —— blockFrom 只切 main.js。
  const i18n = readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8");
  const start = i18n.indexOf("export async function translateNow(");
  assert.ok(start > 0, "i18n 里找不到 translateNow");
  const fn = i18n.slice(start, i18n.indexOf("\nexport ", start + 10));
  assert.match(fn, /getAdhocCache\(tag\)/, "没有复用临时翻译的缓存——每次悬浮都要走一次网络");
  assert.match(fn, /hasOwnProperty\.call\(cache, t\)/,
    "缓存命中判据用的是真值——原文=译文那种「本来就是目标语言」会被反复重排");
  assert.match(fn, /AbortController/, "没有超时——网关慢的时候鼠标停在那儿什么都不出");
  assert.match(fn, /cache\[text\] = v \|\| text;/, "没翻成的也要记一笔，否则每次悬浮都重新去问");
  assert.match(fn, /catch \{/, "翻译失败没有兜住——它挂在渲染路径上");
});

test("悬浮浮层：配色进主题，内容显示全", () => {
  for (const [theme, name] of [["cursor-dark", "深色"], ["cursor-light", "浅色"]]) {
    const block = blockFrom(`monaco.editor.defineTheme("${theme}", {`);
    for (const k of ["editorHoverWidget.background", "editorHoverWidget.foreground", "editorHoverWidget.border"]) {
      assert.ok(block.includes(`"${k}"`), `${name}主题少了 ${k}，悬浮浮层会退回出厂配色`);
    }
  }
  const c = css();
  const i = c.indexOf(".monaco-editor .monaco-hover .monaco-hover-content {");
  assert.ok(i > 0, "没有给悬浮内容放宽高度——长文档会被切在半句话上");
  const block = c.slice(i, c.indexOf("}", i));
  assert.match(block, /max-height/, "没有设高度上限");
  assert.match(block, /overflow-y:\s*auto/, "超出部分没法滚——那就是「显示不全」");
  assert.match(c, /\.monaco-editor \.monaco-hover \{/, "浮层本身没有样式（圆角、投影）");
});
