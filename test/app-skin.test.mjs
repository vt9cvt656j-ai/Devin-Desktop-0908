// 自定义软件皮肤的纯逻辑。这些是真跑出来的，不是对源码做文本匹配。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeAppSkin, clampSkinOpacity, skinPanelAlpha,
  APP_SKIN_MAX_BYTES, SKIN_PANEL_MIN_ALPHA, SKIN_IMAGE_ALPHA,
} from "../src/agent/app-skin.js";

const png = (n = 40) => "data:image/png;base64," + "A".repeat(n);

test("只收位图 data URL", () => {
  assert.equal(normalizeAppSkin(png()), png());
  for (const ext of ["jpeg", "jpg", "webp", "gif", "avif"]) {
    assert.ok(normalizeAppSkin(`data:image/${ext};base64,AAAA`), `${ext} 该收`);
  }
  for (const bad of ["", null, undefined, "  ", "https://example.com/a.png",
                     "data:text/html;base64,AAAA", "javascript:alert(1)",
                     "data:image/png,notbase64"]) {
    assert.equal(normalizeAppSkin(bad), "", `${JSON.stringify(bad)} 不该被收`);
  }
});

test("svg 一律拒掉——它不是被重绘进 canvas，是直接进 CSS background-image", () => {
  // 图标那条路径把 svg 画进 canvas 再取出来，所以那边收 svg 是安全的。
  // 皮肤这条不经过 canvas：原样进 background-image。svg 能内联 script、外链字体和图片，
  // 所以这里不开口子。这条测试就是那个决定本身。
  assert.equal(normalizeAppSkin("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), "");
});

test("超上限的丢掉，不是截断", () => {
  const big = "data:image/png;base64," + "A".repeat(APP_SKIN_MAX_BYTES);
  assert.equal(normalizeAppSkin(big), "", "超了还收，偏好文件会被撑爆");
  const ok = "data:image/png;base64," + "A".repeat(APP_SKIN_MAX_BYTES - 100);
  assert.equal(normalizeAppSkin(ok).length, ok.length, "没超的不许改动一个字节");
});

test("浓度夹到 0–100，脏值回落而不是 NaN", () => {
  assert.equal(clampSkinOpacity(0), 0);
  assert.equal(clampSkinOpacity(100), 100);
  assert.equal(clampSkinOpacity(-30), 0);
  assert.equal(clampSkinOpacity(1e9), 100);
  assert.equal(clampSkinOpacity(41.6), 42, "要取整——CSS 里那两个百分比不该带一串小数");
  // NaN 会让 --skin-a 变成非法值、整层消失：表现是"上传成功了但什么都没发生"。
  for (const bad of ["abc", NaN, null, undefined, {}, []]) {
    const v = clampSkinOpacity(bad);
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 100, `${String(bad)} 回落成了 ${v}`);
  }
  assert.equal(clampSkinOpacity("abc"), 45, "默认浓度变了就改这里，别让它悄悄变成 0");
});

test("面板永远留得住字——这是下限，不是保守", () => {
  // 让用户能把界面调到读不清字，是把"可配置"做成陷阱。
  for (let o = 0; o <= 100; o++) {
    const a = skinPanelAlpha(o);
    assert.ok(a >= SKIN_PANEL_MIN_ALPHA - 1e-9, `浓度 ${o} 时面板只剩 ${a}，字要糊了`);
    assert.ok(a <= 1 + 1e-9, `浓度 ${o} 时面板不透明度算出 ${a}`);
  }
  assert.equal(skinPanelAlpha(0), 1, "没浓度时面板该是完全不透明的");
  assert.ok(Math.abs(skinPanelAlpha(100) - SKIN_PANEL_MIN_ALPHA) < 1e-9, "拉满时该正好落在下限上");
  // 单调：拖动滑块必须一直往一个方向走，否则手感是坏的。
  for (let o = 1; o <= 100; o++) {
    assert.ok(skinPanelAlpha(o) <= skinPanelAlpha(o - 1), `${o - 1}→${o} 面板反而更不透明了`);
  }
});

test("底图不参与调节：只有一个旋钮", () => {
  // 曾经浓度同时控制图层和面板，两者相乘 —— 45% 时有效可见度 6.5%，实测看不见。
  // 现在图层恒为 1，浓度只决定面板让出多少，让出多少就看见多少。
  assert.equal(SKIN_IMAGE_ALPHA, 1, "底图又被调暗了一次，滑块会重新变得没手感");
});

test("CSS 不许自己再算一遍", () => {
  // 同一个语义写两处，迟早各漂一次；而这一处漂了的后果是字看不清。
  // 样式里只准用 var(--skin-a) / var(--skin-panel-a)，算式只在 app-skin.js。
  const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const skin = CSS.slice(CSS.indexOf('/* ═══ 自定义软件皮肤'), CSS.indexOf(".skin-opacity-control"));
  assert.ok(skin.length > 400, "皮肤那一段没切出来，锚点漂了");
  assert.doesNotMatch(skin, /calc\([^)]*--skin-panel-a[^)]*\*/, "CSS 又在自己乘系数了");
  assert.match(skin, /var\(--skin-panel-a\)/, "面板没有用算好的那个值");
});
