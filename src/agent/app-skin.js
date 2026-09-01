/**
 * 自定义软件皮肤的纯逻辑：校验、夹取、以及"面板该保留多少不透明度"。
 *
 * 这里没有 window、没有 document、没有 canvas —— 上传、缩放、编码那一半在 main.js，
 * 挂到 DOM 上那一半也在。分工和 ask-user.js / term-drag.js 一致：能在 Node 里跑的
 * 判断放这儿，于是测试是真跑出来的，不是对着源码做文本匹配。
 */

/** 图存在偏好文件里（Tauri store，不是 localStorage），所以上限可以给到 2.5MB。 */
export const APP_SKIN_MAX_BYTES = 2_500_000;

/**
 * 面板在皮肤下最低保留多少不透明度。
 *
 * **这个下限不是保守，是必须的。** 让用户能把界面调到读不清字，是把"可配置"做成陷阱：
 * 他调过头之后看到的是一个坏掉的 IDE，而不是"我把浓度拉太高了"。62% 是实测在最花的
 * 底图上正文仍然清楚的位置。
 */
export const SKIN_PANEL_MIN_ALPHA = 0.62;

/**
 * 底图本身**不参与调节**：它就是背景板，永远画满。
 *
 * 一度让浓度同时控制图层不透明度和面板不透明度，那是错的 —— 两者是**相乘**的：
 * 浓度 45% 时图层 0.38 × 面板让出的 0.17 ≈ 6.5%，实测几乎看不见，用户传完图会以为
 * 功能没生效。一个滑块不该在两处各打一次折。
 *
 * 现在只有一个旋钮：浓度决定**面板让出多少**，让出多少就看见多少。
 * 浓度 0 时面板完全不透明，底图自然一点都看不到，不需要再把图也调暗一次。
 */
export const SKIN_IMAGE_ALPHA = 1;

/**
 * 只认 base64 的位图 data URL，且不超上限。
 *
 * **不收 svg**（图标那边收）：皮肤是铺满整窗口的底图，而 svg 可以内联 `<script>`、
 * 外链字体和图片。图标那条路径会把 svg 重绘进 canvas，这条不会——它直接进 CSS
 * background-image。所以这里不给 svg 开口子。
 */
export function normalizeAppSkin(value, max = APP_SKIN_MAX_BYTES) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (!/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(s)) return "";
  return s.length <= max ? s : "";
}

/**
 * 浓度夹到 0–100 的整数。
 *
 * 拿到脏值时回落到 fallback 而不是 NaN：NaN 会让 `--skin-a` 变成非法值，整层直接消失，
 * 表现是"上传成功了但什么都没发生"。
 */
export function clampSkinOpacity(value, fallback = 45) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return clampSkinOpacity(fallback, 0);
  return Math.max(0, Math.min(100, n));
}

/**
 * 浓度 → 面板保留的不透明度（带下限）。
 *
 * 这是**唯一**一条把滑块变成视觉效果的算式：面板让出 1-a，让出多少就看见多少底图。
 * CSS 里不许再算一遍（有测试钉着）。
 */
export function skinPanelAlpha(opacity) {
  const a = 1 - (clampSkinOpacity(opacity) / 100) * (1 - SKIN_PANEL_MIN_ALPHA);
  return Math.max(SKIN_PANEL_MIN_ALPHA, Math.min(1, a));
}

/**
 * 编码阶梯：先缩到哪一档，再按什么格式/画质试。
 *
 * **为什么必须有 jpeg，而且不能只靠 webp。** Safari / WKWebView（这个应用在 macOS 上
 * 只能跑它）对不认识的 toDataURL 类型不会报错，会**静默回退成 PNG**。于是原来那条
 * 「webp 三档 → png 兜底」的阶梯在 mac 上实际是「png 四次」——而一张 2560px 的照片
 * 存成 PNG 常常 5–10MB，四次全部超限，最后抛「图片太大」。用户放一张正常的照片就被拒。
 *
 * jpeg 是 canvas 上唯一各家都必然支持、且对照片压得动的格式，所以它必须在阶梯里，
 * 并且排在 png 前面。png 只留给带透明通道的图（jpeg 会把透明压成黑）。
 *
 * 尺寸也要能退：单靠降画质压不下来的图（很大的截图、插画），缩一档立刻就够了。
 */
export const SKIN_ENCODE_LADDER = Object.freeze([
  { maxSide: 2560, type: "image/webp", quality: 0.85 },
  { maxSide: 2560, type: "image/jpeg", quality: 0.82 },
  { maxSide: 1920, type: "image/webp", quality: 0.82 },
  { maxSide: 1920, type: "image/jpeg", quality: 0.78 },
  { maxSide: 1440, type: "image/jpeg", quality: 0.75 },
  { maxSide: 1080, type: "image/jpeg", quality: 0.7 },
  { maxSide: 2560, type: "image/png" },
  { maxSide: 1440, type: "image/png" },
]);
