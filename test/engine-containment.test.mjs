// 长对话「跑着跑着就卡」的那道优化，被关在了本应用最需要它的平台上。
//
// content-visibility: auto 让视口外的消息完全跳过布局和绘制——app.css 里那段注释自己写着
// 它是「长对话性能（跑着跑着就卡的根因）」的解药。可它的开关判据是「是不是 WebKit」，
// 而 macOS 上这个应用**只能**跑在 WKWebView 里，于是 mac 用户从来没拿到过这项优化。
//
// 那道排除有它的理由（老 WebKit 会把跳过绘制变成滚动白屏），但那是老引擎的缺陷：
// 相关 API `Element.checkVisibility` 是 Safari 17.4 才有的，而那批渲染缺陷正是 17.x 修掉的。
// 所以判据换成「这个 WebKit 新到修过那个缺陷没有」，老引擎的行为一个字不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, CODE } from "./helpers/source.mjs";

const classes = load("_engineRenderClasses");
const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

const SAFARI26 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
const WKWEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";
const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 Edg/140";

test("新 WebKit 要拿到这项优化——mac 桌面端就是它", () => {
  // WKWebView 的 UA 里没有 Version/ 标记，所以判据不能靠版本号，只能靠能力探测。
  assert.deepEqual(classes(WKWEBVIEW, true), ["is-webkit", "cv-safe"],
    "新 WebKit 还是没拿到 cv-safe——长对话在 mac 上照旧全量布局，这正是用户报的卡顿");
  assert.deepEqual(classes(SAFARI26, true), ["is-webkit", "cv-safe"]);
});

test("老 WebKit 的行为一个字不变——那道排除有它的理由", () => {
  // 老引擎会把「跳过绘制」变成滚动白屏。探不到那个 API 就照旧保守。
  assert.deepEqual(classes(WKWEBVIEW, false), ["is-webkit"],
    "老 WebKit 也开了优化——会把用户滚到一张白页上");
});

test("Chromium 一直都有，判据换了也不能把它弄丢", () => {
  assert.deepEqual(classes(CHROME, true), ["cv-safe"]);
  assert.deepEqual(classes(EDGE, true), ["cv-safe"]);
  // Chromium 没有这个缺陷，所以它不该依赖那个能力探测。
  assert.deepEqual(classes(CHROME, false), ["cv-safe"],
    "Chromium 也被能力探测挡住了——它本来就没有那个缺陷");
});

test("探测的是和 content-visibility 直接相关的那个 API，不是随手挑的新特性", () => {
  // 探的是 document.body.checkVisibility（同一个 API，只是不写 Element 那个全局——
  // 仓库有一条「客户端模块不许有未声明标识符」的守卫按名单认全局，Element 不在名单里）。
  assert.match(CODE, /typeof document\.body\.checkVisibility === "function"/,
    "换成了别的探测——判据要和它守的那件事有关，否则下次有人升级探测就把语义弄丢了");
});

test("样式那一侧还在：cv-safe 真的会跳过视口外的布局", () => {
  // 判据两侧缺一不可：类加上了而样式没了，等于什么都没做，而且不会有人发现。
  assert.match(CSS, /\.cv-safe \.msg \{ content-visibility: auto; contain-intrinsic-size: auto \d+px; \}/,
    "消息行的 content-visibility 规则没了");
  assert.match(CSS, /\.cv-safe \.agent-tool-step[\s\S]{0,80}content-visibility: auto/,
    "工具卡的规则没了");
});
