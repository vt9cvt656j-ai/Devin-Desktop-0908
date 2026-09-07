// 窗口命令的**权限**必须覆盖代码真正调用的那些。
//
// 2026-08-26：用户报「Windows 上放大/最小化报错，然后就没法用了」。真因不在窗口代码里，
// 在 Tauri 的能力清单：`src-tauri/capabilities/default.json` 放行了 close / destroy /
// start_dragging / set_title 等等，**唯独没放行 minimize 和 toggle_maximize**——
// 而标题栏那三个按钮接的正是它们。调用被 ACL 拒掉 → promise 抛出 → 全局的
// unhandledrejection 处理器弹一句 `Error: …` → 按钮点了没反应。
//
// **为什么只有 Windows 上炸**：macOS 走 titleBarStyle:"Overlay"，系统红绿灯还在，
// 那排自绘按钮的 CSS 是 `body.is-win .titlebar__winctl { display: flex }` —— mac 用户
// 根本看不到它们。Windows 那边 decorations:false，自绘按钮是**唯一**的窗口控制，
// 于是「最小化点了没反应、最大化报错、只有关闭能用」。
//
// ── 判据为什么不读 gen/schemas ────────────────────────────────────────────────
//
// 第一版是去展开 `src-tauri/gen/schemas/acl-manifests.json`（Tauri 生成的完整权限表）。
// 那条路在 CI 上是**死的**：`.gitignore` 第 14 行写着 `/src-tauri/gen`，全仓
// `git ls-files src-tauri/gen/` 返回空。全新检出上这个文件不存在，测试会直接崩在
// readFileSync 上——而且是在「本机明明是绿的」之后才崩，最难查的那种。
//
// 改成只读**被跟踪的**两份来源：capabilities/default.json（显式放行的）+ 下面这张
// core:window:default 的常量表（Tauri 默认给的只读访问器）。那张表会不会和上游漂开？
// 会，所以下面第三条测试在**本机有生成文件时**拿它做交叉核对——本机能抓到漂移，
// CI 上那条自动跳过，而核心判据在两边都跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CAP = join(ROOT, "src-tauri/capabilities/default.json");
const MANIFEST = join(ROOT, "src-tauri/gen/schemas/acl-manifests.json");

/**
 * `core:window:default` 默认放行的命令（全是只读访问器，不改窗口状态）。
 *
 * 抄自本机生成的清单，2026-08-26 实测 28 条。它是常量而不是现算的，因为生成目录
 * 没被 git 跟踪——见文件头。漂移由下面第三条测试在本机兜住。
 */
const CORE_WINDOW_DEFAULT = new Set([
  "activity_name", "available_monitors", "current_monitor", "cursor_position",
  "get_all_windows", "inner_position", "inner_size", "internal_toggle_maximize",
  "is_always_on_top", "is_closable", "is_decorated", "is_enabled", "is_focused",
  "is_fullscreen", "is_maximizable", "is_maximized", "is_minimizable", "is_minimized",
  "is_resizable", "is_visible", "monitor_from_point", "outer_position", "outer_size",
  "primary_monitor", "scale_factor", "scene_identifier", "theme", "title",
]);

/** JS 侧的方法名 → Tauri 的命令名（后者是 snake_case）。 */
const toCommand = (m) => m.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

/** capabilities/default.json 里**显式**放行的 core:window 命令。 */
function explicitlyGranted() {
  const cap = JSON.parse(readFileSync(CAP, "utf8"));
  return new Set((cap.permissions || [])
    .filter((p) => typeof p === "string" && p.startsWith("core:window:allow-"))
    .map((p) => p.slice("core:window:allow-".length).replace(/-/g, "_")));
}

/** 源码里对当前窗口句柄调用的方法名。事件订阅和纯 JS 数组方法不是 Tauri 命令，排掉。 */
function windowMethodsUsed() {
  const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
  const NOT_COMMANDS = new Set([
    "onCloseRequested", "onResized", "onMoved", "onFocusChanged", "listen", "once",
    "map", "flatMap", "reduce", "slice", "some", "filter", "forEach", "join", "find",
  ]);
  const hits = new Set();
  for (const m of src.matchAll(/\bcurrentWindow\.([a-zA-Z]+)\(/g)) hits.add(m[1]);
  for (const m of src.matchAll(/getCurrentWindow\(\)\.([a-zA-Z]+)\(/g)) hits.add(m[1]);
  return [...hits].filter((n) => !NOT_COMMANDS.has(n)).sort();
}

test("代码调用的每一个窗口命令，能力清单里都必须放行", () => {
  const granted = explicitlyGranted();
  const used = windowMethodsUsed();
  assert.ok(used.length >= 4, `只从源码里捞到 ${used.length} 个窗口方法：${used}`);

  const missing = used.filter((m) => {
    const cmd = toCommand(m);
    return !granted.has(cmd) && !CORE_WINDOW_DEFAULT.has(cmd);
  });
  assert.deepEqual(missing, [],
    `这些窗口方法代码在调、能力清单却没放行：${missing.map((m) => `${m}() → core:window:allow-${toCommand(m).replace(/_/g, "-")}`).join("、")}\n`
    + "调用会被 ACL 拒掉、抛出，然后被全局 unhandledrejection 变成一句 Error 提示。\n"
    + "**Windows 上尤其致命**：那边 decorations:false，自绘按钮是唯一的窗口控制；\n"
    + "而 macOS 保留了系统红绿灯、那排按钮 CSS 上就不显示，所以本机测不出来。");
});

test("最小化和最大化确实在显式放行名单里（用户报的就是这两个）", () => {
  const granted = explicitlyGranted();
  for (const cmd of ["minimize", "toggle_maximize", "close", "start_dragging"]) {
    assert.ok(granted.has(cmd),
      `core:window:allow-${cmd.replace(/_/g, "-")} 没放行——标题栏按钮点了会报错`);
  }
});

test("core:window:default 那张常量表没和上游漂开（本机有生成清单时才跑）", () => {
  if (!existsSync(MANIFEST)) {
    // CI / 全新检出上没有这个文件（gen 目录被 .gitignore 掉了），跳过是对的——
    // 上面两条核心判据不依赖它。本机跑一次就够抓住漂移。
    return;
  }
  const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const out = new Set();
  const expand = (plugin, name, depth = 0) => {
    if (depth > 10) return;
    const m = man[plugin] || {};
    const ps = m.permissions || {}, sets = m.permission_sets || {};
    if (ps[name]) { for (const c of ps[name].commands?.allow || []) out.add(c); return; }
    if (sets[name]) {
      for (const r of sets[name].permissions || []) {
        const s = String(r);
        if (!s.includes(":")) { expand(plugin, s, depth + 1); continue; }
        const [a, ...rest] = s.split(":");
        const b = rest.join(":");
        if (b.includes(":")) { const [s2, ...r2] = b.split(":"); expand(`${a}:${s2}`, r2.join(":"), depth + 1); }
        else expand(a, b, depth + 1);
      }
      return;
    }
    if (name === "default") {
      for (const r of (m.default_permission?.permissions) || []) expand(plugin, String(r), depth + 1);
    }
  };
  expand("core:window", "default");
  assert.ok(out.size > 10, `展开只得到 ${out.size} 条，展开器坏了（那会让这条恒绿）`);
  const drifted = [...out].filter((c) => !CORE_WINDOW_DEFAULT.has(c));
  const stale = [...CORE_WINDOW_DEFAULT].filter((c) => !out.has(c));
  assert.deepEqual({ drifted, stale }, { drifted: [], stale: [] },
    "上面那张 CORE_WINDOW_DEFAULT 常量表和 Tauri 生成的清单对不上了——"
    + "上游改了默认权限集，把表更新过来（多出来的是新放行的，少掉的是已被移除的）");
});

test("Windows 的自绘标题栏是唯一控制，所以按钮必须真的显示", () => {
  // 这条守的是「为什么 mac 上测不出来」那半：CSS 只在 is-win 时显示那排按钮。
  // 哪天有人把它改成两个平台都显示、或都不显示，上面几条的前提就变了。
  const css = readFileSync(join(ROOT, "src/styles/app.css"), "utf8");
  assert.match(css, /body\.is-win \.titlebar__winctl \{ display: flex; \}/,
    "Windows 上那排窗口按钮不显示了——decorations:false 之下就没有任何窗口控制了");
  const win = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"));
  assert.equal(win.app.windows[0].decorations, false,
    "Windows 的 decorations 变了——它决定了自绘按钮是不是唯一控制，两条要一起看");
});

/**
 * 全屏：绑一个 F11 是不够的，两处会把它吃掉。
 *
 * 全屏这个功能以前整个产品都没有——全仓唯一的 fullscreen 代码是只读同步（把系统全屏
 * 状态镜像到 body 上）。mac 用户靠系统绿灯，而 Windows 的原生标题栏被 decorations:false
 * 关掉了，那边根本没有任何全屏入口。
 *
 * 补上之后，光加键位表还是收不到 F11：
 *   ① Monaco 的键盘派发挂在编辑器容器上、命中即 stopPropagation，而 F11 被无条件
 *      绑给了调试器的「单步进入」——编辑器有焦点在 IDE 里是常态；
 *   ② 全局派发器对**裸键**主动让路给「正在打字」，而 .monaco-editor / .xterm 都算打字。
 * 两处都得改，所以这三条一起钉。
 */
test("F11 在非调试态让给全屏，不被调试器无条件占着", () => {
  const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
  assert.doesNotMatch(src, /addCommand\(monaco\.KeyCode\.F11, \(\) => dapManager\?\.stepIn\(\)\)/,
    "F11 又被调试器无条件占着了——Monaco 会 stopPropagation，键位表永远收不到它");
  assert.match(src, /monaco\.KeyCode\.F11[\s\S]{0,160}dapManager\?\.isActive\?\.\(\)[\s\S]{0,120}_toggleFullScreen\(\)/,
    "非调试态没有让给全屏（语义和 VS Code 一致：stepIn 只在调试中生效）");
});

test("功能键不算「正在打字」，否则在编辑器里永远收不到", () => {
  const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
  assert.match(src, /const bare = !e\.metaKey && !e\.ctrlKey && !e\.altKey && !\/\^F\\d\{1,2\}\$\/\.test/,
    "功能键又被当成裸键让给输入框了——F1~F12 从来不是打字");
});

test("全屏动作接齐了：权限、动作表、键位、标签", () => {
  const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
  const cap = JSON.parse(readFileSync(CAP, "utf8"));
  assert.ok(cap.permissions.includes("core:window:allow-set-fullscreen"),
    "setFullscreen 没放行——点了会被 ACL 拒，和 minimize 那个坑一模一样");
  assert.match(src, /"view\.toggleFullScreen": \(\) => _toggleFullScreen\(\)/, "动作表里没接");
  assert.match(src, /f11: "view\.toggleFullScreen"/, "默认键位没给（Windows/Linux 上就没有入口了）");
  assert.match(src, /"view\.toggleFullScreen": "切换全屏"/,
    "标签没加——键位设置界面是靠 ACTION_LABELS 枚举的，mac 用户会连自己绑一个键都做不到");
  // 失败必须说出来：静默 catch 会把「点了没反应」这个坑再挖一遍。
  const fn = src.slice(src.indexOf("async function _toggleFullScreen"), src.indexOf("async function _applyUiZoom"));
  assert.match(fn, /showToast\(/, "切换失败时一个字都不说——那正是这次要修掉的形状");
});

/**
 * 平台配置是 **RFC 7396 合并**：patch 不是 object 就整体替换。
 *
 * `tauri.windows.conf.json` 里写 `app.windows: [{ decorations: false }]` 时，
 * windows 是**数组**——按 RFC 7396 数组不做元素级合并，而是把基础配置那一整个数组
 * 顶掉。结果 Windows 上 label / title / width / height / minWidth / minHeight /
 * resizable **全部丢失**，回落到 Tauri 默认值：800×600、"Tauri App"、**没有最小尺寸约束**。
 *
 * 后果不是"观感降级"：.layout 是 flex 且 `overflow: hidden`，
 * .explorer 250px + .assistant 440px（两者 flex:none，不收缩）+ .editorwrap min-width 200px
 * = **890px 硬底**。800px 宽时右边 90px 被直接裁掉，裁掉的正是助手栏输入区和发送键那一带
 * ——**首启即有控件够不着**。而且最小尺寸没了，用户还能把它拖得更小。
 *
 * 判据直接跑一遍合并，断言的是**合并结果**。原来那条只断言平台文件自身
 * `decorations === false`，从不看合并后是什么——正是它漏掉的地方。
 */
function mergeRfc7396(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = (target && typeof target === "object" && !Array.isArray(target)) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergeRfc7396(out[k], v);
  }
  return out;
}

test("Windows 合并后的窗口配置不许把尺寸和标题丢掉", () => {
  const base = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const win = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"));
  const merged = mergeRfc7396(base, win);
  const w = merged.app.windows[0];

  assert.equal(w.decorations, false, "Windows 上必须关掉系统装饰（自绘标题栏才是唯一控制）");
  assert.equal(w.label, "main",
    "label 丢了——能力清单是按 [\"main\", \"win-*\", \"glow-overlay\"] 授权的，"
    + "标签对不上就一个窗口命令都调不了");
  assert.equal(w.title, base.app.windows[0].title, "标题丢了，会显示成 Tauri 的默认名");
  assert.equal(w.width, base.app.windows[0].width, "初始宽度丢了，会回落到 800");
  assert.equal(w.height, base.app.windows[0].height, "初始高度丢了，会回落到 600");
  assert.equal(w.minWidth, base.app.windows[0].minWidth,
    "最小宽度丢了——.layout 是 overflow:hidden，窄到三栏放不下就直接裁掉助手栏右缘"
    + "（输入区和发送键）。2026-08-29 侧栏改成可收缩之后硬底从 890px 降到 640px"
    + "（实测：560 会裁、640 不会），但窗口最小宽度仍然必须有");
  assert.equal(w.minHeight, base.app.windows[0].minHeight, "最小高度丢了");

  // 反向：mac 专属的两项不该被带进 Windows（那边根本不认，留着只会误导）。
  assert.ok(!("titleBarStyle" in w), "titleBarStyle 是 macOS 专属，不该出现在 Windows 配置里");
  assert.ok(!("hiddenTitle" in w), "hiddenTitle 是 macOS 专属，同上");
});

test("三栏布局的硬底仍然存在，只是从 890px 降到了 640px（这条是上面那条的前提）", () => {
  // 这条原来钉的是「侧栏必须 flex:none」，注释里写着：哪天有人把它改成可收缩，
  // 上面那条的严重性就变了，那时该重新评估，而不是让它继续用一个过时的理由挡着。
  //
  // 2026-08-29 就是那一天：侧栏改成了 `flex: 0 1 auto`。原因是 flex:none 下窗口一窄，
  // 编辑器被挤破自己的 min-width、助手栏被 overflow:hidden 整个裁到屏幕外 ——
  // 实测 890px 以下就开始裁；允许收缩之后裁切阈值降到 640px 以下。
  //
  // 判据跟着换：不再要求「不许收缩」，改为要求收缩有下限（min-width 还在）
  // 且裁切仍然可能发生（overflow:hidden 还在）—— 那两条才是上面那条断言的真前提。
  const css = readFileSync(join(ROOT, "src/styles/app.css"), "utf8");
  const rule = (sel) => {
    const i = css.indexOf(sel + " {");
    assert.ok(i >= 0, sel + " 的规则不见了");
    return css.slice(i, css.indexOf("}", i) + 1);
  };
  for (const sel of [".layout .explorer", ".layout .assistant"]) {
    // 下限现在按**物理像素**写：calc(140px / var(--ui-zoom))。裸 140px 在放大时会跟着
    // 变大，等于下限自己多吃屏幕 —— 所以认 calc 形式，不再认裸像素。
    assert.match(rule(sel), /min-width:\s*calc\(\d+px \/ var\(--ui-zoom/, sel + " 没有最小宽度，会被一路压成 0");
    assert.ok(!/flex:\s*none/.test(rule(sel)), sel + " 又变回不可收缩了 —— 890px 以下就会裁");
  }
  assert.match(rule(".layout .editorwrap"), /min-width:\s*calc\(200px \/ var\(--ui-zoom/, "编辑器丢了自己的下限");
  assert.match(css, /\.layout\s*\{[\s\S]{0,200}overflow: hidden;/,
    "布局不再裁切了——那样窗口过窄只会出横向滚动条，不再是「控件够不着」");
});

/**
 * Windows 字重补偿：只准降档，不准抬高，也不准把两档压成同一个数。
 *
 * 2026-09-06：用户报「高级设置在 Windows 上界面都不一样」。把 `is-win` 这个 class
 * 手动加到 body 上做 A/B（它只是个 class，mac 上就能复现 CSS 那一半差异），量出来
 * 整个面板 155 个元素里只有 28 个变，且全在标签页上——那块补偿在这个面板里只干了
 * 一件事，而这件事是反的：
 *
 *   `.feature-tab` 未选中 500 → **550**（抬高了，和「抵掉 DirectWrite 的墨」正相反）
 *   `.feature-tab.is-active`  600 → 550（于是选中和未选中都是 550，**选中态消失**）
 *   `.mcpfp-card__name strong` 700 → 550（strong 继承 UA 的 bold，一把摁掉 150）
 *   `.titlebar__menu` / `.statusbar` 400 → 450（基础就是最轻档，没有下移余地，却被抬高）
 *   `.settings-row__label` 550 → 550（纯空转）
 *   `body.is-win .tab` 全应用匹配 0 个元素（死选择器）
 *
 * 根因是「按选择器钉死一个绝对值」：一个 --wt-strong: 550 同时盖到基础 700/600/550/500
 * 四种元素上。改成按档位下移之后，下面这三条守着它不再退回去。
 *
 * MAC_BASE 是**在浏览器里 getComputedStyle 量出来的**，不是从源码猜的——加新选择器
 * 必须先量再登记，这正是上一版栽跟头的地方。
 */
test("Windows 字重补偿只降不升，且不抹平选中态", () => {
  const css = readFileSync(join(ROOT, "src/styles/app.css"), "utf8");

  const varBlock = css.match(/body\.is-win \{([^}]*)\}/);
  assert.ok(varBlock, "body.is-win 的档位表没了——补偿整块被删或改写了");
  const tier = new Map();
  for (const m of varBlock[1].matchAll(/--wt-(\d+)\s*:\s*(\d+)\s*;/g)) {
    tier.set(Number(m[1]), Number(m[2]));
  }
  assert.ok(tier.size >= 3, `只解析到 ${tier.size} 个档位，解析器坏了（那会让这条恒绿）`);
  for (const [base, win] of tier) {
    assert.ok(win < base,
      `--wt-${base} 被设成 ${win}——Windows 上只准比 mac 轻。抬高等于把病治反了：`
      + "Blink 在 Windows 不实现 -webkit-font-smoothing，同一个数值本来就已经更粗。");
  }

  // selector -> 它被分到哪个档
  const assigned = new Map();
  const RULE = /((?:body\.is-win [^,{}]+,\s*)*body\.is-win [^,{}]+)\{\s*font-weight:\s*var\(--wt-(\d+)\)\s*;\s*\}/g;
  for (const m of css.matchAll(RULE)) {
    const base = Number(m[2]);
    for (const sel of m[1].split(",")) {
      const s = sel.trim().replace(/^body\.is-win\s+/, "");
      if (s) assigned.set(s, base);
    }
  }
  assert.ok(assigned.size >= 5, `只解析到 ${assigned.size} 条选择器，解析器坏了`);

  // 浏览器实测的 mac 计算值。改这张表之前先去量，别照着 CSS 源码猜——
  // `.mcpfp-card__name strong` 自己的规则里就没有 font-weight，700 是 UA 给 strong 的。
  const MAC_BASE = {
    ".mcpfp-card__name strong": 700,
    ".titlebar__title": 600,
    ".skill-row__name": 600,
    ".feature-tab.is-active": 600,
    ".settings-row__label": 550,
    ".tbtn": 550,
    ".feature-tab": 500,
    ".ctp-btn": 500,
  };
  const unmeasured = [...assigned.keys()].filter((s) => !(s in MAC_BASE));
  assert.deepEqual(unmeasured, [],
    "这些选择器进了 is-win 补偿但没登记实测基础字重——先在浏览器里读一次 "
    + "getComputedStyle(el).fontWeight 再填进 MAC_BASE，照源码猜就是上一版翻车的原因");
  const misfiled = [...assigned].filter(([s, base]) => MAC_BASE[s] !== base)
    .map(([s, base]) => `${s}: 实测 ${MAC_BASE[s]} 却挂在 --wt-${base} 档`);
  assert.deepEqual(misfiled, [],
    "档位挂错了——挂错档就等于按另一个基础值去降，降幅要么不够要么过头");

  // 选中态那条必须比常态重，且类更多（否则 body.is-win .x 会靠元素选择器盖掉 .x.is-active）
  for (const [variant, vBase] of assigned) {
    for (const [plain, pBase] of assigned) {
      if (variant === plain) continue;
      if (!variant.startsWith(plain) || !/^[.:]/.test(variant.slice(plain.length))) continue;
      assert.ok(vBase > pBase,
        `${variant} 和 ${plain} 落在同一档——Windows 上这两个状态的字重会一模一样，`
        + "选中/强调态在视觉上直接消失");
      const cls = (s) => (s.match(/\./g) || []).length;
      assert.ok(cls(variant) > cls(plain),
        `${variant} 的类不比 ${plain} 多，优先级压不住 body.is-win ${plain}`);
    }
  }
});
