// 三栏布局的自适应档位：窗口越窄，两条侧栏让得越多，中间编辑区才留得住。
//
// # 为什么量的是 window.innerWidth
//
// 界面缩放走 `documentElement.style.zoom`（见 main.js 的 _applyUiZoom）。app.css 里三栏的
// 宽度已经除以 `--ui-zoom`，各栏占屏幕的比例因此与缩放无关 —— 缩放只把字和图标变大变小。
//
// 档位要是再按布局视口（媒体查询量的就是它，= 屏宽 / 缩放）分，等于把缩放算了两次：
// 放大一次、档位又缩一次，窄窗口里一放大侧栏反而更小。所以这里读 `window.innerWidth`，
// 它不随 zoom 变。
//
// 注意它**不是设备像素**：HiDPI 屏和 Windows 的显示缩放都由 devicePixelRatio 吸收
//（实测这台 mac：dpr=2、screen.width=1728、innerWidth 与之同一口径）。它是「未经界面
// 缩放的 CSS 像素」，各平台口径一致 —— 正因如此才适合拿来分档。
//
// # 为什么住在这里而不是 main.js
//
// main.js 有行数闸（test/main-size-budget.test.mjs），仓库规矩是「撞线先腾地方」。
// 这段只依赖参数、没有模块级可变状态，正好搬得动，也因此能被单独测。

/**
 * 窄端：宽度**小于**这些值时依次让位。从宽到窄，取最后命中的一档。
 */
export const LAYOUT_DENSITY_STEPS = [[1180, "narrow"], [980, "tight"], [780, "min"]];

/**
 * 宽端：宽度**不小于**这些值时把侧栏的默认宽度调大。从窄到宽，同样取最后命中的一档。
 *
 * 大屏是窄屏的同一个问题掉了个头：2K/4K 上 250px 的侧栏细得像条缝，助手栏 440px 装不下
 * 一段代码。这一档改的是默认宽度，用户拖过的宽度永远优先（见 app.css 里的两层 var）。
 */
export const LAYOUT_WIDE_STEPS = [[2200, "wide"], [3000, "xwide"]];

/**
 * 竖直方向：窗口**矮**到这些值以下时收紧竖直留白。从高到矮，取最后命中的一档。
 *
 * 竖直的空间大头不是三栏，而是：聊天区上下内边距、消息之间的 gap、输入框的最大高度、
 * 空状态那一坨（图标 40 + 标题 + 说明 + 一排 chip ≈ 200px）、页签条。矮窗口里这些加起来
 * 能把消息区挤到只剩两三行 —— 横向那套档位一点忙都帮不上，它只看宽度。
 *
 * 口径和宽度**不同**：宽度读物理值（三栏宽度本来就除以了缩放），高度读**有效**高度
 * （innerHeight / 缩放，由 main.js 的 _applyLayoutDensity 换算后传进来）。竖直方向没有任何
 * 按物理尺寸排的东西——聊天区、输入框、空状态、页签条全是 CSS 像素——放大到 1.5 倍的 700px
 * 窗口就是一个 466px 高的窗口，按 700 分档等于当它够高，输入框会把聊天区挤到只剩两三行。
 * 留白本身仍是 CSS 像素，缩放时跟着字一起变大——这一点不变，变的只是「选哪一档」。
 */
export const LAYOUT_HEIGHT_STEPS = [[820, "short"], [680, "xshort"]];

/** 纯函数：给定窗口高度，算出竖直档位名（够高时返回空串）。 */
export function layoutHeightStep(height, steps = LAYOUT_HEIGHT_STEPS) {
  const h = Number(height) || 0;
  if (!(h > 0)) return "";
  let step = "";
  for (const [px, name] of steps) if (h < px) step = name;
  return step;
}

/** 纯函数：给定窗口宽度，算出档位名（不命中任何一档时返回空串 = 用默认布局）。 */
export function layoutDensityStep(width, steps = LAYOUT_DENSITY_STEPS, wide = LAYOUT_WIDE_STEPS) {
  const w = Number(width) || 0;
  if (!(w > 0)) return "";
  let step = "";
  for (const [px, name] of steps) if (w < px) step = name;
  if (step) return step;                       // 窄端优先：两端不可能同时命中
  for (const [px, name] of wide) if (w >= px) step = name;
  return step;
}

/**
 * 把档位打到根元素的 `data-layout` 上；CSS 那边拿 `max-width` 封顶。
 *
 * **封顶而不是改 `--sidebar-w`/`--assistant-w`**：那两个变量是拖分隔条存下来的（内联在
 * `.layout` 上），改掉等于把用户拖出来的宽度抹了，窗口再拉宽也回不来。封顶只是暂时压住，
 * 窗口一宽就自动松开。
 */
export function applyLayoutDensity(width, height, rootEl) {
  if (!rootEl || !rootEl.dataset) return "";
  const step = layoutDensityStep(width);
  if ((rootEl.dataset.layout || "") !== step) {
    if (step) rootEl.dataset.layout = step;
    else delete rootEl.dataset.layout;
  }
  // 竖直独立成一个属性：宽和高互不相干，一个窄而高的窗口和一个宽而矮的窗口要的是
  // 完全不同的两组收紧，合成一个档位名只会组合爆炸。
  const vstep = layoutHeightStep(height);
  if ((rootEl.dataset.vlayout || "") !== vstep) {
    if (vstep) rootEl.dataset.vlayout = vstep;
    else delete rootEl.dataset.vlayout;
  }
  return step;
}

/*
 * 视口尺寸有**两种口径，绝不能混用**。而且两个引擎的行为**是反的** —— 这一点必须写在
 * 代码里，否则在 mac 上验对的东西到 Windows 上会以另一种方式错。
 *
 * 实测（2026-08-30，同一段探针：把 zoom 设成 1.4，量一个 width:100px 的元素）：
 *
 *   引擎                           rect.width   innerWidth   clientWidth
 *   WebKit / WKWebView（mac）         100          不变       ÷1.4 变小
 *   Chromium / WebView2（Windows）    140          不变         不变
 *
 * 也就是说：WebKit 的 rect 是**未缩放**的 CSS 像素，视口在这套单位下是 clientWidth；
 * Chromium 的 rect 是**已缩放**的，视口在这套单位下是 innerWidth（此时它正好等于
 * clientWidth）。
 *
 * 所以 `clientWidth` 在**两个引擎上都对**：mac 上它是唯一正确的那个，Windows 上它恰好
 * 等于 innerWidth，取谁都一样。反过来取 innerWidth 就只在 Windows 上对 —— 那正是用户在
 * mac 上看到的：放到 140% 时 `Math.min(r.left, innerWidth - w - 8)` 的上界永远大于 r.left，
 * 夹取一次都不触发，模型菜单、悬浮卡、右键菜单直接飞出屏幕右下角。
 *
 * 反过来，只有两处该用 innerWidth：缩放上限和上面的自适应档位。它们问的都是「这块屏幕
 * 有多大」，要的就是那个不随缩放变的数，跟布局坐标系无关。
 */
export function viewportW() {
  const el = typeof document !== "undefined" ? document.documentElement : null;
  return (el && el.clientWidth) || (typeof window !== "undefined" ? window.innerWidth : 0) || 0;
}
export function viewportH() {
  const el = typeof document !== "undefined" ? document.documentElement : null;
  return (el && el.clientHeight) || (typeof window !== "undefined" ? window.innerHeight : 0) || 0;
}
