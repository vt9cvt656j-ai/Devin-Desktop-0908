import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Shell } from "./app/Shell.jsx";
import "./styles/app.css";
import "./styles/shadcn.css";
// 精修层排在 shadcn.css 之后、tailwind 之前：它重写的是 app.css 里的排版与间距，
// 靠源码顺序取胜，提前就被 app.css 盖回去了。
import "./styles/refine.css";
import "./ui/tailwind.css";
import { loadMonacoNls } from "./monaco-nls.js";
import { applyLayoutDensity } from "./agent/layout-density.js";
import { initLocale } from "./i18n.js";

/**
 * 应用入口。顺序是这里唯一重要的东西。
 *
 * main.js 在**模块顶层**就抓 DOM：
 *
 *     const treeEl = $("tree");
 *     const tabsEl = $("tabs");
 *
 * 也就是说它一被 import，元素就必须已经在文档里了。React 18/19 的 `root.render()`
 * 默认是并发、异步提交的 —— 直接 `render(); import("./main.js")` 会让 main.js 抢在
 * commit 之前跑，那 159 个 ref 全是 null，整个 IDE 静默死掉。
 *
 * `flushSync` 强制同步提交：这一行返回时，DOM 已经在文档里了。这是全应用**唯一**
 * 需要 flushSync 的地方，代价只有首屏这一次，换来的是启动顺序确定。
 *
 * 然后才动态 import main.js —— 静态 import 会被提升到 flushSync 之前，那就前功尽弃。
 */
const host = document.getElementById("root");
if (!host) throw new Error("boot: #root 不存在，index.html 被改坏了");

/*
 * **首屏契约**：缩放、布局密度、界面语言必须在第一帧之前生效。
 *
 * 这三样原来都在 main.js 顶层补 —— 也就是 8.3 万行跑完、React 已经画完之后。
 * 用户看到的是：外壳先出现，过一下文案整片从英文翻成中文、布局跳一下。
 * 实测外壳 164ms，文案变中文在 291~469ms；而全应用没有 splash 也没有 cloak，
 * 窗口一开就画，所以每一次「补」都被看见。
 *
 * Cursor/VSCode 那种「开起来就是稳的」不是因为它们更快：它们在 window ready 之前
 * 不显示，持久化的布局/缩放/语言在首帧之前就应用完了。这段就是补上那个契约。
 *
 * 缩放和密度只写根元素上的属性，不依赖任何 DOM 内容，所以排在 flushSync **之前**。
 */
try {
  const z = Number(localStorage.getItem("michael-ide.ui-zoom"));
  if (z >= 0.5 && z <= 2 && z !== 1) {
    document.documentElement.style.zoom = String(z);
    // --ui-zoom 必须同时设：标题栏用 calc(84px / var(--ui-zoom)) 给原生红绿灯反向
    // 补偿留位，只设 zoom 不设它，第一帧的红绿灯就是错位的（见 main.js _applyUiZoom）。
    document.documentElement.style.setProperty("--ui-zoom", String(z));
  }
} catch { /* localStorage 不可用（隐私模式）就用默认值，绝不挡启动 */ }
try {
  applyLayoutDensity(window.innerWidth, window.innerHeight, document.documentElement);
} catch { /* 同上 */ }

const root = createRoot(host);
flushSync(() => {
  root.render(<Shell />);
});

// **语言要排在 flushSync 之后**：initLocale 里的 applyToDOM 是遍历已有 DOM 做替换的，
// 元素还没进文档就等于空跑。而它必须排在 main.js 之前 —— 排在里面就成了现在这样：
// 8.3 万行跑完才翻译。zh-CN 的词条是内置的（i18n.js 的 translations 里直接挂着
// ZH_CN），所以这一步纯同步、不发请求，最常见的那条路径一帧英文都不会有。
//
// main.js 末尾那次 initLocale() 保留不动：它的监听器（main.js 的 onLocaleChange）
// 要到那时才注册得上，而语言包异步到货的通知得有人接。initLocale 因此做成了幂等的。
try { initLocale(); } catch (e) { console.warn("[boot] initLocale 失败，界面留在默认语言：", e); }

// Monaco 自己那套界面文案（右键菜单、查找框、命令面板）在**模块求值时**就把标题定死了，
// 所以语言包必须赶在 main.js 那行 `import * as monaco` 之前灌进去。排在这里才成立：
// main.js 是动态 import 的，会等这个 await；换成静态 import 就不会等（同层的静态依赖在
// 依赖遍历时直接求值）。加载失败只是菜单留在英文，不挡启动。
await loadMonacoNls();

// 到这里 159 个 ID 都在文档里了，main.js 可以安全地抓它的 ref。
await import("./main.js");
