// 能力面板（2026-09-07 重做：所有者「弄成大厂风格」）。
//
// 这一版修的是三件事，三条断言各守一件：类名不再和抓包面板撞、颜色只走 token、文案三语。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CODE, fnSource } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf8");
const CSS = read("../src/styles/app.css");
const I18N = read("../src/i18n.js");
const PANEL = fnSource("_openCapabilitiesPanel");

test("类名不再和抓包回放面板撞", () => {
  // 上一版两个面板都叫 .cap-row / .cap-sec__*，而抓包那份在样式表里更靠后，于是能力面板的行
  // 实际上被另一个面板的规则接管（padding、边框、状态色都不是自己的）。这类事故查不出来，
  // 因为两边单独看都「有样式」。
  assert.ok(!/class="cap-(?!s__)/.test(PANEL), "面板里还有旧的 cap- 类名");
  assert.ok(PANEL.includes('class="caps__'), "面板没改用 caps__ 前缀");
  // 抓包面板那批仍然在，且仍然只有它自己用
  for (const kept of [".cap-sec__title", ".cap-pre", ".cap-reqline"]) {
    assert.ok(CSS.includes(kept), `${kept} 是抓包面板的，不该被一起删掉`);
  }
  assert.ok(!CSS.includes(".cap-file"), "能力面板的旧样式没删干净");
  assert.ok(!/\n\.cap-row \{/.test(CSS.slice(0, CSS.indexOf(".ctp-card--bp"))), "旧的 .cap-row 定义还在前半段");
});

test("自己的对话框、只用 token，深色不写第二套", () => {
  assert.match(PANEL, /document\.createElement\("dialog"\)/, "面板还在借共用的 _chatToolModal 壳");
  assert.match(PANEL, /dlg\.showModal\(\)/);
  assert.match(PANEL, /dlg\.addEventListener\("click", \(e\) => \{ if \(e\.target === dlg\) close\(\); \}\)/, "点遮罩要能关");
  const at = CSS.indexOf("/* ── 能力面板");
  assert.ok(at > 0, "样式块的锚点没了");
  const block = CSS.slice(at, CSS.indexOf(".ctp-card--bp", at));
  assert.ok(block.length > 2000, `只切出 ${block.length} 字符，切法坏了`);
  const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexes, [], `能力面板里不该有写死的颜色：${hexes.join(" ")}`);
  for (const token of ["var(--popover-surface)", "var(--text-dim)", "var(--line)", "var(--scrim)", "var(--shadow)", "var(--hover)", "var(--destructive)"]) {
    assert.ok(block.includes(token), `没用 ${token}`);
  }
  assert.ok(block.includes(".caps[open] { display: flex;"), "display 没挂在 [open] 上，关着的对话框会显示出来");
  assert.ok(!/\[data-theme="dark"\][^\n]*\.caps\b/.test(CSS), "又给能力面板写了一套深色覆盖，说明颜色没走 token");
  // 等宽只给地址和路径，名字用正文字体
  assert.ok(block.includes(".caps__detail") && block.includes("var(--mono)"), "地址 / 路径要用等宽");
});

test("文案三语，作用域标签也带键", () => {
  const keys = [...new Set([...PANEL.matchAll(/T\("(caps\.[\w.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 20, `只扫到 ${keys.length} 个 caps.* 键，取法多半坏了`);
  for (const key of keys) {
    const hits = (I18N.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length;
    assert.equal(hits, 3, `${key} 只有 ${hits} 种语言，EN / ZH / JA 三份都要`);
  }
  // 三个作用域标签由 _capabilityScopePaths 产出，面板按 sc.key 翻
  const scopes = fnSource("_capabilityScopePaths");
  for (const key of ["caps.scopeUser", "caps.scopeProject", "caps.scopeLocal"]) {
    assert.ok(scopes.includes(key), `作用域没带 ${key}，换语言时这三行会漏成中文`);
    assert.equal((I18N.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length, 3);
  }
  assert.match(PANEL, /T\(sc\.key, sc\.label\)/, "面板没按键翻作用域标签");
  // 不许再有写死的中文界面文案（用户数据和常量除外）
  assert.doesNotMatch(PANEL, /esc\("[^"]*[一-鿿]/, "又出现写死的中文文案");
});

test("用户给的字符串全部转义，且不送去自动翻译", () => {
  // 工具名、URL、路径、报错正文都来自用户的配置文件；直通 innerHTML 就是注入口。
  for (const [what, re] of [
    ["行的名字和来源", /esc\(name\)[\s\S]{0,200}esc\(source\)/],
    ["行的细节", /esc\(detail\)/],
    ["报错的原因", /esc\(reason\)/],
    ["报错指的对象", /esc\(subject\)/],
    ["配置文件路径", /esc\(sc\.path\)/],
    ["关掉的内置工具名", /caps\.disabled\.map\(\(d\) => `<code data-i18n-skip>\$\{esc\(d\)\}<\/code>`\)/],
  ]) {
    assert.match(PANEL, re, `${what}没过转义 / 没标免翻`);
  }
  // 计数是数字，别让翻译器把它变成「千」那种东西
  assert.match(PANEL, /class="caps__n" translate="no"/);
  // 报错那一段是**和别的段同一个形状**，只是图标和计数染红——不是一整块粉底横幅。
  assert.match(PANEL, /section\("warn", T\("caps\.errTitle"/, "报错没有走和别的段一样的骨架");
  assert.match(PANEL, /" caps__sec--err"/, "报错段没有那个只染图标和计数的修饰类");
  assert.ok(!/caps__err/.test(PANEL), "旧的粉底横幅还在");
  assert.equal((PANEL.match(/data-i18n-skip/g) || []).length >= 4, true, "用户数据没标 data-i18n-skip");
});

test("面板的行为没被这次重做改掉：重读一次、已有内容不覆盖、老目录先搬", () => {
  assert.match(PANEL, /_userCapsCache = \{ root: null, ts: 0 \};/, "打开面板要重读，不能给 10 秒前的缓存");
  assert.match(PANEL, /if \(String\(existing \|\| ""\)\.trim\(\)\)/, "已有内容必须不覆盖");
  assert.match(PANEL, /_seedFromLegacyScopeFile\(sc\.path\)/, "老目录里的配置要先搬过来");
  assert.match(PANEL, /content: seeded \|\| _CAPABILITY_STARTER/);
  assert.match(CODE, /_capsItem\.addEventListener\("click", \(\) => \{ _closeCapabilitiesMenu\(\); void _openCapabilitiesPanel\(\); \}\)/,
    "菜单里的入口没了");
});
