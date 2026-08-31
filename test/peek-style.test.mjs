// Peek 浮层（⌘+单击落在定义自己身上时弹的「引用 (N)」）的样子。
//
// 用户：「样式好好弄弄」。出厂配色是亮蓝粗边 + 浅灰列表 + 方角，贴在这个应用的编辑器上
// 像另一个软件的窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blockFrom, SRC } from "./helpers/source.mjs";

const css = () => readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("配色走 Monaco 的主题键，深浅两套都要有", () => {
  // 走主题键而不是 CSS 盖类名：类名是 Monaco 的内部实现，升一次版就可能对不上，
  // 而且那时是**静默**失效——浮层悄悄变回出厂配色，没有任何报错。
  const KEYS = [
    "peekView.border",
    "peekViewTitle.background",
    "peekViewTitleLabel.foreground",
    "peekViewEditor.background",
    "peekViewResult.background",
    "peekViewResult.selectionBackground",
    "peekViewResult.matchHighlightBackground",
  ];
  const dark = blockFrom('monaco.editor.defineTheme("cursor-dark", {');
  const light = blockFrom('monaco.editor.defineTheme("cursor-light", {');
  for (const k of KEYS) {
    assert.ok(dark.includes(`"${k}"`), `深色主题少了 ${k}，那一块会退回出厂配色`);
    assert.ok(light.includes(`"${k}"`), `浅色主题少了 ${k}，那一块会退回出厂配色`);
  }
  // 浅色不能再直接用内置的 "vs"：那样一个键都设不上。
  assert.match(SRC, /light:\s*\{ monaco: "cursor-light", css: "light" \}/,
    "浅色又指回内置的 vs 了——Peek 的配色一个键都设不上");
  // 但语法着色必须原样保留：rules 为空 + inherit，改的只有 colors。
  assert.match(light, /base:\s*"vs"/, "浅色主题的底不是 vs，语法色会整个变样");
  assert.match(light, /inherit:\s*true/, "没有继承 vs，语法色会整个变样");
  assert.match(light, /rules:\s*\[\]/, "浅色主题动了语法着色规则——这次只该改 Peek 的配色");
});

test("主题键管不到的那几样用 CSS 补，且挂在 .monaco-editor 下面", () => {
  const c = css();
  const i = c.indexOf(".monaco-editor .peekview-widget {");
  assert.ok(i > 0, "Peek 浮层没有样式——圆角、投影这些主题键给不了");
  const block = c.slice(i, c.indexOf("}", i));
  assert.match(block, /border-radius/, "还是方角，和应用里其它面板不是一套");
  assert.match(block, /box-shadow/, "没有投影，浮层浮不起来");
  // 深色要单独给一版投影：浅色那档在深底上几乎看不见。
  assert.match(c, /\[data-theme="dark"\] \.monaco-editor \.peekview-widget/, "深色没有单独的投影");
  // 每一条都必须挂在 .monaco-editor 下面——那是 i18n 自动翻译的跳过区，
  // 裸选择器会波及别处，而且这些类名本来就只属于编辑器。
  for (const line of c.slice(i).split("\n")) {
    if (!line.includes("peekview-widget")) continue;
    if (line.trim().startsWith("*") || line.trim().startsWith("/*")) continue;
    assert.ok(line.includes(".monaco-editor"), `Peek 的选择器没有挂在 .monaco-editor 下面：${line.trim()}`);
  }
});
