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

// ── 编码阶梯 ────────────────────────────────────────────────────────────────
// 用户实拍：「现在放图片能用了？？？？」—— 一张正常照片被拒。
// 原因不在上传、不在 CSP，在编码那一步：Safari / WKWebView 对不认识的 toDataURL 类型
// **不报错，静默回退成 PNG**。原来的阶梯是「webp×3 → png」，在 mac 上实际是「png×4」，
// 而一张 2560px 的照片存成 PNG 常常 5–10MB，四次全部超上限，最后抛「图片太大」。
import { SKIN_ENCODE_LADDER } from "../src/agent/app-skin.js";

/** 按各家引擎的真实行为伪造 toDataURL。体积按 (边长² × 每格字节) 粗估。 */
function fakeCanvas({ webp = true, bytesPerPx }) {
  const c = { width: 0, height: 0 };
  c.getContext = () => ({ drawImage() {} });
  c.toDataURL = (type, q) => {
    // Safari：不支持的类型不报错，返回 PNG。这正是那条静默失败的来源。
    const real = (type === "image/webp" && !webp) ? "image/png" : type;
    const px = c.width * c.height;
    const per = bytesPerPx[real] ?? 3;
    const bytes = real === "image/png" ? px * per : px * per * (q ?? 0.8);
    return `data:${real};base64,` + "A".repeat(Math.max(1, Math.round(bytes)));
  };
  return c;
}

/** 把 main.js 那段阶梯逻辑照搬过来跑（同一份 SKIN_ENCODE_LADDER 驱动）。 */
function encode(canvas, w, h) {
  const ctx = canvas.getContext("2d");
  let lastSide = 0;
  for (const step of SKIN_ENCODE_LADDER) {
    if (step.maxSide !== lastSide) {
      lastSide = step.maxSide;
      const scale = Math.min(1, step.maxSide / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.drawImage();
    }
    let out = "";
    try { out = canvas.toDataURL(step.type, step.quality); } catch { continue; }
    if (normalizeAppSkin(out)) return out;
  }
  return null;
}

test("Safari 把 webp 悄悄换成 PNG 时，一张正常照片仍然能存下来", () => {
  // 4032×3024 的手机照片，PNG 约 3 字节/像素、jpeg/webp 约 0.35。
  const bytesPerPx = { "image/png": 3, "image/jpeg": 0.35, "image/webp": 0.25 };
  const got = encode(fakeCanvas({ webp: false, bytesPerPx }), 4032, 3024);
  assert.ok(got, "mac 上一张普通照片被整条阶梯拒掉了——这就是用户撞到的那个「图片太大」");
  assert.match(got, /^data:image\/jpeg;base64,/, "回退时该落到 jpeg，而不是继续在 PNG 上打转");
  assert.ok(normalizeAppSkin(got), "存下来的东西自己过不了校验");
});

test("支持 webp 的引擎上仍然优先用 webp（画质体积都更好）", () => {
  const bytesPerPx = { "image/png": 3, "image/jpeg": 0.35, "image/webp": 0.25 };
  const got = encode(fakeCanvas({ webp: true, bytesPerPx }), 4032, 3024);
  assert.match(got, /^data:image\/webp;base64,/, "有 webp 却没用");
});

test("阶梯里必须有 jpeg，且排在 png 前面", () => {
  // jpeg 是 canvas 上唯一各家都必然支持、且对照片压得动的格式。
  // 它一旦被拿掉或排到 png 后面，mac 上就退回原来那条静默失败的路。
  const types = SKIN_ENCODE_LADDER.map((s) => s.type);
  assert.ok(types.includes("image/jpeg"), "阶梯里没有 jpeg —— mac 上会退回「一直在编 PNG」");
  assert.ok(types.indexOf("image/jpeg") < types.indexOf("image/png"), "jpeg 排到 png 后面了");
  // 尺寸也要能退：单靠降画质压不下来的图，缩一档立刻就够。
  const sides = [...new Set(SKIN_ENCODE_LADDER.map((s) => s.maxSide))];
  assert.ok(sides.length >= 3, `只有 ${sides.length} 档尺寸，压不动的图没有退路`);
  assert.equal(Math.max(...sides), 2560, "最大边不再是 2560，注释和上限就对不上了");
});

test("怎么都压不下去时是明确失败，不是存一个半截的东西", () => {
  // 一张纯噪声的巨图：任何格式都压不动。这时必须抛，不能返回一个超限的串
  // ——超限的串会被 normalizeAppSkin 判成空，表现是"上传成功但什么都没发生"。
  const bytesPerPx = { "image/png": 40, "image/jpeg": 40, "image/webp": 40 };
  const got = encode(fakeCanvas({ webp: true, bytesPerPx }), 8000, 8000);
  assert.equal(got, null, "压不下去却返回了东西");
});
