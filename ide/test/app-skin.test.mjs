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

// ── 皮肤覆盖面：谁跟着透、谁永远不透 ─────────────────────────────────────────
//
// 用户实拍两类毛病，根子是同一个：**皮肤有两套并行机制**，一套是改变量（覆盖面广、
// 跟滑块走），一套是逐个元素写 `background: transparent`（绕开滑块）。第二套每多一条，
// 滑块就多一块管不到的地方 —— 那就是"皮肤内容不全"。
//
// 这一组守的是收口之后的形状：**只留改变量那一套**。
const CSS_ALL = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
/** 切出皮肤那一节（到设置页样式为止），并剥掉注释——注释里逐字写着旧写法长什么样。 */
function skinBlock() {
  const from = CSS_ALL.indexOf("/* ═══ 自定义软件皮肤");
  const to = CSS_ALL.indexOf(".settings-row--skin ");
  assert.ok(from > 0 && to > from, "皮肤那一段没切出来，锚点漂了");
  return CSS_ALL.slice(from, to)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("每个跟皮肤走的面色，都从自己那份 *-opaque 推导", () => {
  // 皮肤要按浓度调一个面色，就必须有一份**没被调过的原值**可推导。缺了它只能一刀切成
  // transparent（--bg 原来就是这样），于是所有消费者一起变成全透、滑块完全管不到。
  const block = skinBlock();
  const m = block.match(/:root\[data-skin="on"\]\s*\{([^}]*)\}/);
  assert.ok(m, "皮肤的变量覆盖块不见了");
  const decls = [...m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)];
  assert.ok(decls.length >= 5, `只覆盖了 ${decls.length} 个变量，覆盖面缩了`);
  // 五个外框面一个都不能少：少一个，那一块就永远不跟着皮肤走。
  // （`--skin-blur` 也在这个块里，但它是滤镜不是颜色，由下面那条单独的测试守。）
  const SURFACES = ["--bg", "--panel", "--panel-solid", "--panel-2", "--editor-bg"];
  for (const need of SURFACES) {
    assert.ok(decls.some(([, n]) => n === need), `${need} 没被皮肤覆盖，这一块会漏`);
  }
  for (const [, name, value] of decls) {
    if (!SURFACES.includes(name)) continue;
    assert.match(
      value,
      /color-mix\(in srgb, var\(--[a-z0-9-]+-opaque\) var\(--skin-panel-a\), transparent\)/,
      `${name} 没有按「原值 × 浓度」推导（值是 ${value.trim()}）——` +
      "写死 transparent 或写死颜色都会让浓度滑块对它失效",
    );
  }
});

test("皮肤块里不许有 per-element 规则——只有底图那两条例外", () => {
  // 两条例外都属于"铺底图"本身，不属于"让某个面透"：
  //   body::before  底图层，图就画在它上面；
  //   body          自己的底色必须让开，否则底图被它整块盖住。
  // 除它俩之外，每一条 per-element 规则都是在绕开变量机制。删掉的四条各自的毛病：
  //   .layout        空操作（那个元素本来就没有背景）；
  //   .editorwrap    把滑块钉死成全透，浓度调到 0 也照样漏底图；
  //   .welcome       重复，而且把颜色换成了另一个色阶；
  //   .feature-panel 把设置页四个面色都调透 —— 而它是覆盖整窗的浮层，底下是**工作区**，
  //                  于是欢迎页大标题、文件树、助手栏对话全从设置项文字底下透出来。
  //
  // **判据不能只看 `background`。** 上面 .feature-panel 那条改的是 `--feature-*` 自定义
  // 属性，一个 background 字都没有 —— 旧版判据正是这么被绕过去的，而它是这一批里
  // 最严重的一处。所以这里禁的是"出现 per-element 规则"本身，不是"规则里写了什么"。
  const ALLOWED = new Set(["body", "body::before"]);
  const block = skinBlock();
  const bad = [];
  for (const m of block.matchAll(/:root\[data-skin="on"\]\s+([^{,]+)\{/g)) {
    const sel = m[1].trim();
    if (ALLOWED.has(sel)) continue;
    bad.push(sel);
  }
  assert.deepEqual(bad, [], `又出现了绕开变量机制的 per-element 规则：${bad.join(", ")}`);
});

test("皮肤要把底图糊掉，不是拿一层白纱压在清晰照片上", () => {
  // 用户实拍否掉过没有模糊的版本：一层半透明veil压在一张清晰照片上，得到的是"脏"。
  // 照片的高频细节直接顶在正文后面，对比度被打散。macOS vibrancy / Warp / Acrylic
  // 做的都是"先糊掉背后，再上色veil"，所以底图退成柔和色场、文字始终压在纯色上。
  const block = skinBlock();
  const m = block.match(/:root\[data-skin="on"\]\s*\{([^}]*)\}/);
  assert.ok(m, "皮肤的变量覆盖块不见了");
  assert.match(m[1], /--skin-blur\s*:\s*[^;]*blur\(/, "皮肤开着时没有开启背景模糊");
  assert.match(m[1], /--skin-blur\s*:\s*[^;]*saturate\(/,
    "模糊会把颜色摊平，不补饱和度底图会灰得像蒙了层灰");

  // 没有皮肤时必须是 none —— 否则等于给全窗口无条件加了一层昂贵的合成层。
  assert.match(CSS_ALL, /(?<!\])\n:root \{[\s\S]*?--skin-blur:\s*none;/,
    "--skin-blur 的默认值不是 none，没有皮肤时也会触发模糊");

  // 消费方：外框面要真的吃到它，否则变量开了也没人用。
  const nc = CSS_ALL.replace(/\/\*[\s\S]*?\*\//g, "");
  const users = (nc.match(/backdrop-filter:\s*var\(--skin-blur\)/g) || []).length;
  assert.ok(users >= 4, `只有 ${users} 处消费 --skin-blur，外框面没接全`);
});

test("浮层永远不透：它们浮在别的界面上，不是浮在壁纸上", () => {
  // 实拍过：下拉菜单跟着半透之后，菜单文字和它盖住的输入框文字叠在一起。
  // 这跟底图好不好看无关 —— 判据是"这个面底下是壁纸还是别的界面"。
  const nc = CSS_ALL.replace(/\/\*[\s\S]*?\*\//g, "");
  const FLOATING = [
    ".settings-dropdown", ".assistant-capability__menu", ".ctp-card",
    ".menu", ".git-branch-menu", ".palette__panel",
  ];
  const SKINNED = ["--panel-solid", "--panel-2", "--editor-bg", "--bg", "--panel"];
  for (const sel of FLOATING) {
    const re = new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "m");
    const m = nc.match(re);
    assert.ok(m, `${sel} 的规则找不到了`);
    const bg = m[1].match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    assert.ok(bg, `${sel} 没有背景声明了`);
    const v = bg[1];
    assert.match(v, /var\(--popover-surface\)/, `${sel} 的底色不是 --popover-surface`);
    for (const t of SKINNED) {
      assert.ok(!v.includes(`var(${t})`), `${sel} 又吃上了会被皮肤调低的 ${t}`);
    }
  }
  // 反方向：--popover-surface 必须**不**在皮肤的覆盖名单里，否则上面全白做。
  assert.ok(
    !/--popover-surface\s*:/.test(skinBlock()),
    "--popover-surface 被皮肤覆盖了，浮层会重新变透",
  );
});
