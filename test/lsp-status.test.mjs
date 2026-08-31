// 语言服务没起来时，状态栏必须**说出来**，而不是把那一栏整条摘掉。
//
// 用户实拍两次：「ide 没有点击变量、函数的跳转功能吗」「鼠标悬浮 没有函数那种弹窗了」。
// 两次都不是功能没做——补全、跳转、悬浮的 provider 一直注册着，是那一刻**语言服务没在跑**。
// 而状态栏在"一个服务都没起来"时 removeStatusBarItem("lsp")，屏幕上干干净净，
// 于是静默的缺席被读成"这个 IDE 没有这个功能"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fnSource, SRC, CODE } from "./helpers/source.mjs";

test("一个服务都没起来时不再摘掉那一栏，而是写明「未启动」", () => {
  const fn = fnSource("updateLspStatusBar", { code: true });
  assert.match(fn, /未启动/, "又变回静默摘掉了——用户只会看到功能凭空消失");
  // 判据是「当前文件的语言本来就该有服务」。Markdown、纯文本没有服务，给它们写一句
  // 「未启动」是另一种噪音。
  assert.match(fn, /lspManager\.isManaged\?\.\(_lang\)/,
    "没有按「这个语言该不该有服务」门控——纯文本文件也会挂一句未启动");
  assert.match(fn, /removeStatusBarItem\("lsp"\)/, "不该有服务的语言仍然要摘掉，别留噪音");
  // 死因要摆出来。上一次为什么停的，管理器自己记着。
  assert.match(fn, /lastStopReason\?\.\(_lang\)/, "没把上次的停止原因摆出来，用户只知道没了不知道为什么");
});

test("那一栏可以点，点了真去启动", () => {
  const fn = fnSource("updateLspStatusBar", { code: true });
  assert.match(fn, /lspManager\.ensureServer\?\.\(_lang\)/, "点了没有真去启动");
  // 起来了要立刻刷新自己，没起来要说清楚——不能点完什么反馈都没有。
  assert.match(fn, /updateLspStatusBar\(\)/, "启动之后没有刷新状态栏");
  assert.match(fn, /showToast/, "点完没有任何反馈");
});

test("isManaged 真的从 lsp-client 导出了", () => {
  // 少了这个导出，上面那道门永远为假：状态栏又变回静默摘掉，而且不会有人发现。
  const lsp = readFileSync(new URL("../src/lsp-client.js", import.meta.url), "utf8");
  assert.match(lsp, /^\s{4}isManaged,\s*$/m, "isManaged 没有导出——状态栏那道门恒假");
  assert.match(lsp, /function isManaged\(langId\) \{/, "isManaged 的实现没了");
});

test("悬浮/跳转/补全的 provider 一直是注册着的——问题从来不在这儿", () => {
  // 这条守的是"别在排查时把 provider 当成嫌疑人删掉或改坏"。
  const lsp = readFileSync(new URL("../src/lsp-client.js", import.meta.url), "utf8");
  for (const [reg, what] of [
    ["registerHoverProvider", "鼠标悬浮的函数说明"],
    ["registerDefinitionProvider", "⌘+单击跳定义"],
    ["registerCompletionItemProvider", "补全"],
  ]) {
    assert.ok(lsp.includes(`monaco.languages.${reg}(PROVIDER_LANGS`), `${what}（${reg}）没注册了`);
  }
  // 跨文件跳转要靠这个 opener 接进我们自己的页签系统。
  assert.match(SRC, /monaco\.editor\.registerEditorOpener\(\{/, "跨文件跳转的 opener 没了");
  // 编辑器没有把悬浮关掉。
  assert.doesNotMatch(CODE, /hover:\s*\{\s*enabled:\s*false/, "编辑器把悬浮关掉了");
});
