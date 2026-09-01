// 点上下文环弹出来的「上下文用量」面板。
//
// 用户：「上下文计数器这里如果点击的话，就显示第二个图里面这种内容给用户看」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextUsageView } from "../src/agent/context-usage.js";
import { blockFrom, SRC } from "./helpers/source.mjs";

const css = () => readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("分项加起来正好等于上面那个总数", () => {
  // 这是整块面板成立的前提。分项要是拿本地估算拼的，六个看着精确的数字加起来对不上
  // 那个真实读数——这个仓库为这种「兜底冒充真值」做过全站审计。
  const v = contextUsageView(
    { prompt: 85200, completion: 21200, total: 106400, limit: 200000, pct: 53, cached: 60000, cacheWrite: 5000 }, {});
  assert.equal(v.rows.reduce((n, r) => n + r.value, 0), 106400, "分项之和对不上总数");
  assert.deepEqual(v.rows.map((r) => r.key), ["cached", "cacheWrite", "uncached", "completion"]);
  assert.equal(v.headline, "53% 已用");
  assert.equal(v.sub, "106K / 200K");
});

test("上游没报缓存字段时，不拆、也不写成 0", () => {
  // cached 为 null 是「没报」，不是「真 0」。写成 0 会让人以为一次都没命中。
  const v = contextUsageView({ prompt: 1000, completion: 200, total: 1200, limit: 8000, pct: 15, cached: null }, {});
  assert.deepEqual(v.rows.map((r) => r.key), ["uncached", "completion"]);
  assert.equal(v.rows[0].label, "输入", "没有缓存分项时还叫「未缓存输入」，等于暗示另有一块命中了");
  assert.ok(v.notes.some((n) => n.includes("没报缓存字段")), "没说清楚为什么不拆");
  // 真 0 就该拆，只是那一段不画。
  const z = contextUsageView({ prompt: 1000, completion: 0, total: 1000, limit: 8000, pct: 12, cached: 0 }, {});
  assert.deepEqual(z.rows.map((r) => r.key), ["uncached"]);
  assert.ok(!z.notes.some((n) => n.includes("没报缓存字段")));
});

test("分母是猜的、数是估的，都要当面说出来", () => {
  const guessed = contextUsageView({ prompt: 100, total: 100, limit: 128000, pct: 91, windowReported: false }, {});
  assert.ok(guessed.notes.some((n) => n.includes("按模型名推的")), "分母是猜的却没说——91% 看着和真读数一样确定");
  const est = contextUsageView({ prompt: 100, total: 100, limit: 8000, pct: 2, estimated: true }, {});
  assert.ok(est.notes.some((n) => n.includes("本地估算")), "估算没标出来");
  // 一次都没上报过就如实说空，别画一条 0 段的条。
  const none = contextUsageView({}, {});
  assert.equal(none.empty, true);
  assert.equal(none.rows.length, 0);
  // 坏输入不许抛：它挂在点击路径上。
  for (const bad of [null, undefined, { prompt: "x" }, { cached: "y" }]) {
    assert.doesNotThrow(() => contextUsageView(bad, bad));
  }
});

test("接线：环可点、面板真用这份判据、点外面会关", () => {
  // 用量那半边现在由**悬停**那块承担，标记在 _ctxPanelHtml("usage") 里拼。
  const html = blockFrom('function _ctxPanelHtml(kind) {');
  assert.match(html, /_contextUsageView\(_ctxMeter \|\| \{\}, _tok \|\| \{\}\)/,
    "面板没有用那份判据——多半是又在这儿现算了一遍");
  assert.match(html, /view\.empty/, "没上报过用量时没有走「如实说空」那条");
  assert.match(html, /style="flex:\$\{r\.value\}"/, "分段条的宽度不是那个数本身，条和数会对不上");
  const fn = blockFrom("function _toggleContextPanel(anchor) {");
  assert.match(fn, /document\.addEventListener\("mousedown", away, true\)/, "点面板外面关不掉");
  assert.match(fn, /setTimeout\(\(\) => \{/, "关闭监听没有推迟一帧——这一次点击会立刻把它关掉");
  // 「环真的被接成一个可点的按钮」这件事不在这里守：源码里有没有 addEventListener 这行字，
  // 和运行时它有没有真的挂上，是两回事——上一版就是把接线写进了一个恒假的分支，
  // 这种文本断言照样绿，功能却是死的。真跑的那几条在 test/context-parts.test.mjs。
  const c = css();
  assert.match(c, /\.cache-ring\[role="button"\] \{ cursor: pointer/, "环看不出可以点");
  for (const k of ["cached", "cacheWrite", "uncached", "completion"]) {
    assert.ok(c.includes(`.ctx-panel__dot--${k}`), `分项 ${k} 没有颜色，点和条对不上号`);
  }
});
