// 「全部都要自适应」——缩放、拖拽、不同屏幕。2026-09-06 逐配置实测后落的四条机制：
//   ① vh/vw 在 CSS zoom 下不跟着变（Chromium 实测 1.4 倍时 100vh 元素高 1176 物理像素，
//      满铺 fixed 盒子只有 840）→ 全部换成 JS 量出来的有效视口 --eh/--ew；
//   ② 助手栏的物理下限（÷缩放）在放大时会低于输入栏的内容下限 → 两个下限取大；
//   ③ 标题栏只有标题会缩，缩没了就把右侧工具组推出屏幕 → 标题剩不到 72px 就收成「≡」；
//   ④ 竖向档位按物理高度分，放大后当窗口够高 → 改按有效高度。
// 能在 Node 里跑的（分档纯函数）真跑；改在 CSS/调用点里的用源码守调用点，并做过变异。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { layoutHeightStep, LAYOUT_HEIGHT_STEPS } from "../src/agent/layout-density.js";
import { fnSource, SRC } from "./helpers/source.mjs";
// helpers 里那个剥注释是按 JS 词法做的（acorn），喂 CSS 会当场 SyntaxError；CSS 用正则。
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/styles/app.css"), "utf8");
// 不自己读 main.js：用 helpers 的 SRC（main.js + 已拆出的模块拼接），模块搬家时不假红。
const MAIN = SRC;

test("竖向档位：放大之后按有效高度分——1.5 倍的 700px 窗口就是个 466px 的窗口", () => {
  assert.equal(layoutHeightStep(700), "short", "700 物理像素本身只是 short");
  assert.equal(layoutHeightStep(700 / 1.5), "xshort", "除以缩放之后才是真实处境：xshort");
  assert.equal(layoutHeightStep(900 / 1.05), "", "略缩放的高窗口不该被误判");
  // 档位表本身的形状：从高到矮，最后命中的那一档生效
  assert.ok(LAYOUT_HEIGHT_STEPS.length >= 2 && LAYOUT_HEIGHT_STEPS[0][0] > LAYOUT_HEIGHT_STEPS[1][0]);
});

test("调用点真的把高度除以了缩放，且宽度仍是物理值", () => {
  const src = fnSource("_applyLayoutDensity", { code: true });
  assert.match(src, /window\.innerHeight\s*\/\s*z\b/, "高度没除以缩放——放大后竖向档位会当窗口够高");
  assert.match(src, /applyLayoutDensity\(\s*window\.innerWidth\s*,/, "宽度必须仍是物理 innerWidth（三栏宽度已经除过缩放）");
});

test("有效视口变量：写入点、两条触发路径、CSS 里不再有裸的 vh/vw", () => {
  const sync = fnSource("_syncEffectiveViewport", { code: true });
  assert.match(sync, /--eh/, "没写 --eh");
  assert.match(sync, /--ew/, "没写 --ew");
  assert.match(sync, /innerHeight[^;]*\/\s*z\b/, "--eh 必须是 innerHeight ÷ 缩放，两个引擎口径才一致");
  const zoom = fnSource("_applyUiZoom", { code: true });
  assert.match(zoom, /_syncEffectiveViewport\(\)/, "缩放时没刷新有效视口——叠层照样按旧 vh 撑出屏");
  const listener = MAIN.slice(MAIN.indexOf('window.addEventListener("resize", () => {\n  if (_uiZoom > _uiZoomCeiling())'));
  const body = listener.slice(0, listener.indexOf("\n});"));
  assert.match(body, /_syncEffectiveViewport\(\)/, "窗口尺寸变了没刷新有效视口");
  assert.match(body, /_syncTitlebarCompact\(\)/, "resize 里没重算标题栏紧凑态——缩放复位后菜单名回不来");

  // 声明里的 vh/vw 只允许作为 var() 的回退值出现（:root 的两个默认值除外）
  const decl = stripCss(CSS).replace(/var\(--e[hw],\s*100v[hw]\)/g, "").replace(/--e[hw]:\s*100v[hw];/g, "");
  const bare = decl.match(/(?<![\w.-])\d+(?:\.\d+)?v[hw]\b/g) || [];
  assert.deepEqual(bare, [], `还有裸的 vh/vw：${JSON.stringify(bare)}——放大时会按未缩放的视口撑大`);
  assert.ok((CSS.match(/var\(--eh, 100vh\)/g) || []).length >= 20, "--eh 的替换面不够，像是被整体回退了");
  for (const f of ["memory-center.jsx", "session-picker.jsx"]) {
    const jsx = readFileSync(join(HERE, "../src/ui", f), "utf8");
    assert.ok(!/\[\d+vh\]/.test(jsx), `${f} 里的 Tailwind 视口值没换成 --eh`);
  }
});

test("助手栏下限：物理下限与输入栏的内容下限取大", () => {
  const m = CSS.match(/\.layout \.assistant \{[\s\S]*?min-width:\s*max\(calc\((\d+)px \/ var\(--ui-zoom, 1\)\),\s*(\d+)px\)/);
  assert.ok(m, "助手栏 min-width 不再是 max(物理, 内容)——放大到 1.4 倍发送键又会被顶出去");
  assert.ok(Number(m[2]) >= 268, `内容下限 ${m[2]}px 小于输入栏让完之后的实测下限 268px`);
});

test("标题栏紧凑模式：入口占第 0 位、真菜单从 1 起、收放判据是标题剩余宽度", () => {
  const build = fnSource("buildMenubar", { code: true });
  assert.match(build, /tb-menu--compact/, "紧凑入口没建");
  assert.match(build, /openMenu\(i \+ 1\)/, "紧凑列表点第 i 项必须打开第 i+1 个面板（第 0 位是入口自己）");
  assert.match(build, /const i = buttons\.length;/, "真菜单的下标必须按数组长度取，否则和紧凑入口撞位");
  assert.match(build, /_syncTitlebarCompact\(\);\s*\}\s*$/, "buildMenubar 收尾没重算紧凑态——换语言后菜单名宽度变了却不重判");
  const sync = fnSource("_syncTitlebarCompact", { code: true });
  assert.match(sync, /classList\.remove\("is-compact"\)/, "判断前必须先摘掉 is-compact，否则收了就永远收着");
  assert.match(sync, /offsetWidth/, "要用 offsetWidth/scrollWidth（两个引擎都是 CSS 像素），别用 getBoundingClientRect");
  assert.match(sync, /titleW\s*<\s*72/, "判据是标题剩余宽度，不是等到真溢出（那时标题早就是 0 了）");
  assert.match(MAIN, /_titlebarCompactRO\s*=\s*new ResizeObserver\(/, "标题栏的 ResizeObserver 必须留引用，否则可能被回收");
  const css = stripCss(CSS);
  assert.match(css, /\.titlebar\.is-compact \.tb-menu:not\(\.tb-menu--compact\) > \.tb-menu__btn \{ display: none; \}/);
  assert.match(css, /\.titlebar\.is-compact \.tb-menu \{ position: static; \}/, "紧凑态下面板要改挂到菜单栏，否则五个面板各自贴着已隐藏的按钮飞");
});
