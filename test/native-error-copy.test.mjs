// 原生层只回码和事实，措辞在 JS 这一侧。
//
// 2026-09-07 把三段文案从 Rust 挪了出来（棘轮 test/rust-agent-text.test.mjs 记着账）。挪的
// 理由有两条，都不是洁癖：
//   · 写在 src-tauri 里的中文进不了 JS 那套字符串剥离，`strings` 也扫不到（UTF-8 整段跳过），
//     等于把面向模型的散文原样摆在二进制里；
//   · 它永远只有一种语言 —— 日文用户会在浏览器卡片里看到一句中文。
// 所以这里钉两头：原生层不许把话写回去，JS 这边每个码都要有三语。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CODE, fnSource, load } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf8");
const I18N = read("../src/i18n.js");
const AI_RS = read("../src/main.js") && read("../src-tauri/src/ai.rs");
const BROWSER_RS = read("../src-tauri/src/browser.rs");

// t() 换成「把键原样回来」，这样断言看的是**走没走 i18n**，而不是某句话的字面量。
const noteText = load("_browserSessionNoteText", { t: (k) => k });

test("会话提示：认识的码翻成话，不认识的行原样留着", () => {
  assert.equal(noteText("[EXT_IGNORED_CHROME137] count=3"), "browser.note.extIgnored");
  assert.equal(noteText("[ATTACHED_OWN_APP] who=Mrday.one brand=Chrome port=9222"), "browser.note.attachedOwnApp");
  // 一条提示可能是「上一份配置用不了」那句 + 一行码：前一行是后端真说的话，不许吞掉。
  const mixed = noteText("上一份浏览器配置用不了，已改用一次性临时配置。\n[EXT_IGNORED_CHROME137] count=2");
  assert.equal(mixed, "上一份浏览器配置用不了，已改用一次性临时配置。\nbrowser.note.extIgnored");
  // 不认识的码宁可露出来，也不要静默变成空字符串——那样后端说的话就整段消失了。
  assert.equal(noteText("[SOMETHING_NEW] x=1"), "[SOMETHING_NEW] x=1");
  assert.equal(noteText(""), "");
  assert.equal(noteText(null), "");
});

test("码里的事实真的被填进去（不是把占位符原样吐出来）", () => {
  const real = load("_browserSessionNoteText", {
    t: (k) => ({
      "browser.note.extIgnored": "配了 {n} 个扩展，不会生效。",
      "browser.note.attachedOwnApp": "已接管 {who}（{brand}，端口 {port}）。",
    }[k] || k),
  });
  assert.equal(real("[EXT_IGNORED_CHROME137] count=3"), "配了 3 个扩展，不会生效。");
  assert.equal(real("[ATTACHED_OWN_APP] who=Mrday.one brand=Chrome port=9222"), "已接管 Mrday.one（Chrome，端口 9222）。");
  // 字段缺了不能印出 undefined
  assert.doesNotMatch(real("[ATTACHED_OWN_APP]"), /undefined/);
  assert.equal(real("[EXT_IGNORED_CHROME137]"), "配了 0 个扩展，不会生效。");
});

test("三个码都有 EN / ZH / JA 三份文案", () => {
  for (const key of ["browser.note.extIgnored", "browser.note.attachedOwnApp", "stream.mseSessionGone"]) {
    const hits = (I18N.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length;
    assert.equal(hits, 3, `${key} 只有 ${hits} 种语言`);
  }
});

test("原生层这三处只回码，一个字的措辞都不带回去", () => {
  // ai.rs：两处 MSE 分支共用一个常量，常量本身是纯码。
  assert.match(AI_RS, /const MSE_SESSION_GONE: &str = "\[MSE_SESSION_GONE\]";/);
  // 两个分支都用常量，不许有人再手写一份字面量回来。
  assert.equal((AI_RS.match(/MSE_SESSION_GONE\.to_string\(\)/g) || []).length, 2, "两个 MSE 分支没有共用同一个常量");
  assert.ok(!/收到密文流/.test(AI_RS), "MSE 那段散文又写回 Rust 了");
  // browser.rs：两条会话提示只带码和 key=value。
  assert.match(BROWSER_RS, /\[EXT_IGNORED_CHROME137\] count=\{\}/);
  assert.match(BROWSER_RS, /\[ATTACHED_OWN_APP\] who=\{who\} brand=\{brand\} port=\{port\}/);
  assert.ok(!/不再接受命令行加载扩展/.test(BROWSER_RS), "扩展那段散文又写回 Rust 了");
  assert.ok(!/这是用户自己在开发的应用，后面每个/.test(BROWSER_RS), "接管那段散文又写回 Rust 了");
});

test("两个渲染器真的接在数据流上，没有绕过去", () => {
  // 会话提示：进模型上下文的和进面板的必须是**翻译后**那一份。
  const browserStep = CODE.slice(CODE.indexOf("const _sessNote = _browserSessionNoteText("));
  assert.match(browserStep.slice(0, 600), /content \+= `\\n\\n\[浏览器会话\] \$\{_sessNote\}`/,
    "给模型的还是原始 session_note");
  assert.match(browserStep.slice(0, 1600), /browser-session-note">\$\{_escHtml\(_sessNote\)\}/,
    "面板显示的还是原始 session_note");
  assert.ok(!/_escHtml\(state\.session_note\)/.test(CODE), "面板还有一处在直接显示原始提示");
  // 流错误：唯一那个漏斗要过 _nativeErrorText。
  assert.match(CODE, /attemptError = _nativeErrorText\(ev\.message\) \|\| "模型线路出现问题"/);
  assert.match(fnSource("_nativeErrorText") || "", /\[MSE_SESSION_GONE\]/);
});
