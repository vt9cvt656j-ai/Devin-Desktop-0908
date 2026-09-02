// 反漂移：不让「面向模型的说明文本」悄悄长回客户端包里。
//
// 这条测试守的不是「今天干净」，而是「明天有人加东西时会当场知道」。三种漂移形状，
// 每一种一条断言：
//   1. 给 TOOL_METADATA 加了一个新的散文字段（比如 anti_pattern / when_not）；
//   2. 在 tool-guides.js 里新写一张表（TOOL_EXAMPLES 就是这么来的，FIELD_VALUES 也是）；
//   3. 新建一个文件来放工具说明（绕开 tool-guides.js 这个名字）。
//
// 本条测试**自己**的失效风险见文件末尾那几条自查断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripToolGuides, STRIP_REGIONS, ALLOWED_REGIONS } from "../build/strip-tool-guides.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GUIDES = join(ROOT, "src/tool-guides.js");
const RAW = readFileSync(GUIDES, "utf8");

// 剥离作用域**认识**的字段。给 TOOL_METADATA 加一个不在这里的散文字段 = 那个字段
// 原样进包，而 changed 阈值仍然是绿的（它只数它认识的那几个键）。
const KNOWN_META_FIELDS = new Set(["category", "priority", "use_cases", "triggers", "example_call", "usage_note"]);
// 允许留下的**非散文**字段。加进这张表的每一条都要能回答「它凭什么不是 IP」。
const NON_PROSE_FIELDS = new Set(["category", "priority"]);


// _capabilityNote 没有导出（它是名录内部的），按 AST 从真源码里抠出来跑——
// 抠的是产品真正用的那一份，不是测试台自己写一个形状。
function loadCapabilityNote() {
  const src = readFileSync(new URL("../src/tool-guides.js", import.meta.url), "utf8");
  const at = src.indexOf("function _capabilityNote(name, meta) {");
  assert.ok(at > 0, "_capabilityNote 改名了，这几条守卫要跟着改");
  let d = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) break;
  }
  const fn = src.slice(at, i + 1);
  const se = src.match(/const _SELF_EVIDENT\s*=\s*new Set\(\[[\s\S]*?\]\);/);
  return new Function(`${se ? se[0] : "const _SELF_EVIDENT=new Set();"}\n${fn}\n;return _capabilityNote;`)();
}

test("TOOL_METADATA 没有出现剥离器不认识的字段", async () => {
  const mod = await import(pathToFileURL(GUIDES).href);
  const seen = new Set();
  for (const meta of Object.values(mod.TOOL_METADATA)) for (const k of Object.keys(meta)) seen.add(k);
  const unknown = [...seen].filter((k) => !KNOWN_META_FIELDS.has(k));
  assert.deepEqual(unknown, [],
    `TOOL_METADATA 里出现了新字段 ${unknown.join(",")} —— build/strip-tool-guides.mjs 的 PROSE_KEYS 不认识它，`
    + "于是它会原样进发布包，而剥离计数仍然是绿的。要么把它加进 PROSE_KEYS（散文），"
    + "要么加进本文件的 NON_PROSE_FIELDS（并写清它凭什么不是 IP）。");
  for (const k of NON_PROSE_FIELDS) {
    assert.ok(seen.has(k), `NON_PROSE_FIELDS 里的 ${k} 已经不在数据里了 —— 这张豁免表在守一个不存在的东西`);
  }
});

test("tool-guides.js 里每一张顶层数据表都登记过（剥 or 显式豁免）", () => {
  // 枚举顶层 `const X = Object.freeze({ / [ / new Set(`。TOOL_EXAMPLES 和 FIELD_VALUES
  // 当初都是这样悄悄加进来的：一张新表，剥离器不认识，测试也不问。
  const found = [...RAW.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\(\s*)?(?:new Set\(\s*)?[[{]/gm)]
    .map((m) => m[1]);
  assert.ok(found.length >= 4, `只枚举到 ${found.length} 张顶层表 —— 枚举正则坏了，这条断言在守空气`);
  const unregistered = found.filter((n) => !STRIP_REGIONS.includes(n) && !(n in ALLOWED_REGIONS));
  assert.deepEqual(unregistered, [],
    `这些顶层表既不在剥离作用域里、也没有登记豁免：${unregistered.join(",")}。`
    + "在 build/strip-tool-guides.mjs 里把它加进 STRIP_REGIONS（会随发布构建剥空），"
    + "或者加进 ALLOWED_REGIONS 并写清它凭什么可以留在客户端。");
  // 反向：豁免清单不许守一张已经不存在的表（那种条目会永远绿着，且掩盖真实覆盖率）。
  for (const n of [...STRIP_REGIONS, ...Object.keys(ALLOWED_REGIONS)]) {
    assert.ok(found.includes(n), `登记表里的 ${n} 在 tool-guides.js 里已经不存在了 —— 清单和现实脱节`);
  }
});

test("剥离是完整的：三个互相独立的计数必须同时成立", () => {
  const r = stripToolGuides(RAW);
  assert.equal(r.found, true, `剥离作用域没认出全部区间，漏了：${(r.missing || []).join(",")}`);
  // A 与 B：一个逐字符走出来，一个朴素 split 数出来。两者相等 = 没有半途而废的行。
  assert.equal(r.changed, r.expected,
    `逐字符剥掉 ${r.changed} 个键，而独立计数器数出应有 ${r.expected} 个 —— 有一批键没被剥到。`);
  // 字面量数 >= 键数：`usage_note: '前半'+'后半'` 是一个键两段。差额恒等于 0 反而说明
  // 拼接串那条分支从没走到过——本仓当前有 4 条这种形状（probe_env / ui_extract /
  // view_image / git_show），差额应当正好是 4。写成 >= 是不想让加/删一条拼接串就红。
  assert.ok(r.literals >= r.changed,
    `字面量数 ${r.literals} 少于键数 ${r.changed} —— 计数逻辑坏了`);
  // C：剥完之后回头看还剩几个非空散文值。这条抓的是「剥了一半」，changed 阈值抓不到。
  assert.equal(r.residual, 0, `剥完之后仍有 ${r.residual} 个非空的说明值留在区间里`);
  // 下限：只挡「整个文件被换成别的东西、于是无事可剥、residual 也trivially 为 0」这一种。
  // 不写成 566/568 这种贴着当前值的数——那种阈值每加一个工具就要动一次，而它其实
  // 只需要回答一个问题：「这个文件还是那个装着一百多条工具说明的文件吗」。
  assert.ok(r.changed >= 400,
    `只剥掉 ${r.changed} 个值（143 个工具 × 4 个散文字段 + 109 条示例，当前实际 666）。`
    + "掉到 400 以下说明这个文件的形状变了，剥离作用域要重新核过，而不是把阈值调低。");
});

test("剥完之后模块仍然能加载、仍然导出全部工具名", async () => {
  // 剥离改的是数据不是结构。它把文件改成语法不合法、或者把某条工具整条弄丢，
  // 都是发布版才炸的故障（dev 不剥），本地永远复现不出来。
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tg-strip-"));
  const p = join(dir, "stripped.mjs");
  writeFileSync(p, stripToolGuides(RAW).code, "utf8");
  const stripped = await import(pathToFileURL(p).href);
  const dev = await import(pathToFileURL(GUIDES).href);
  assert.deepEqual(Object.keys(stripped.TOOL_METADATA), Object.keys(dev.TOOL_METADATA),
    "剥离改变了工具名集合 —— 它只该改文本值");
  assert.ok(typeof stripped.toolCapabilityIndex() === "string", "剥完之后 toolCapabilityIndex 崩了");
  // 散文确实没了（正向判据，不是「没报错就算过」）。
  const prose = Object.values(stripped.TOOL_METADATA)
    .filter((m) => String(m.usage_note || "").trim() || String(m.example_call || "").trim()
      || (m.use_cases || []).length || (m.triggers || []).length);
  assert.equal(prose.length, 0, `${prose.length} 条工具的说明在剥离后还在`);
});

test("没有第二个文件在承载工具说明", () => {
  // 绕开 tool-guides.js 这个名字最省事的办法就是新建一个文件。判据不看文件名，
  // 看**内容特征**：【何时用】/【vs 替代】这些是这份 IP 独有的标记，散到别处就该被发现。
  const MARKERS = ["【何时用】", "【vs 替代】", "【何时不用】", "usage_note:", "example_call:"];
  // 只有 src/ 会被打进产物。build/ 是构建期跑在本机的脚本，test/ 更不进包 ——
  // 整目录排除，而不是把这些文件一个个记进白名单：手记的白名单本身就会漂
  //（每加一个守卫文件就要记一条，忘了就是一条假红，而假红最后总是被人把测试关掉）。
  const NOT_SHIPPED = /^(build|test|scripts|src-tauri)\//;
  const OWNED = new Set([
    "src/tool-guides.js",         // 正主，由 strip-tool-guides 覆盖
    "src/agent/tool-catalog.js",  // 由 strip-tool-ip 覆盖
    "src/main.js",                // 由 strip-tool-ip 覆盖 _buildAgentToolSchemas
  ]);
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // .claude/worktrees 是并行会话的隔离副本，不是产品源码（本仓常年挂着七八个）。
        // website/public/app 是**网页版发布产物**——它确实在漏（实测 main-HwOQfA7d.js
        // 里有 38 处明文【何时用】），但它是「已经发出去的旧构建」，归 bundle-ip-leak
        // 那条按字符串表扫的测试管；在这里列它只会把一条源码漂移检查变成常红噪音。
        if (["node_modules", "dist", ".git", ".claude", "target", "test-results", "website"].includes(e.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|jsx|ts|tsx|json)$/.test(e.name)) continue;
      if (statSync(full).size > 12 * 1024 * 1024) continue;
      const rel = relative(ROOT, full).split("\\").join("/");
      if (OWNED.has(rel) || NOT_SHIPPED.test(rel)) continue;
      const text = readFileSync(full, "utf8");
      const hit = MARKERS.filter((m) => text.includes(m));
      if (hit.length) hits.push(`${rel} (${hit.join(" ")})`);
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [],
    `这些文件里出现了工具说明的标记，而它们不在任何剥离作用域内：\n  ${hits.join("\n  ")}\n`
    + "要么把它们并回 tool-guides.js，要么给 build/ 下加一条覆盖它们的剥离并登记到 OWNED。");
});

// ——— 本条测试自己的自查：防止它变成一条恒真的门 ———

test("自查：剥离器坏掉时这些断言真的会红", () => {
  // 变异 1：把剥离器的作用域标记改掉（模拟「有人把 TOOL_METADATA 改名了」）。
  const renamed = RAW.replace("const TOOL_METADATA = Object.freeze({", "const TOOL_META = Object.freeze({");
  const r1 = stripToolGuides(renamed);
  assert.equal(r1.found, false, "作用域标记失配时 found 仍是 true —— 这是「锚点失效」的形状，剥不到却报成功");

  // 变异 2：往区间里塞一条剥离器认识的字段，但值是跨行的（逐字符实现会跳过它）。
  //         这一条必须被 residual 抓到，而不是被 changed 抹平。
  const injected = RAW.replace(
    "  think: {",
    "  __probe__: { category: 'planning', usage_note: '这条不该活到发布包里' },\n  think: {",
  );
  const r2 = stripToolGuides(injected);
  assert.equal(r2.residual, 0, "注入的普通行应当被正常剥掉");
  assert.equal(r2.changed, r2.expected, "注入之后两个计数器仍应一致");
  assert.ok(r2.changed > stripToolGuides(RAW).changed, "多注入一条说明，剥掉的条数必须跟着涨 —— 不涨说明计数器没在数真东西");

  // 变异 3：三种**剥离器处理不了**的值形状。三种的共同点是「计数器全对，包却脏了」——
  // 所以只有 residual 这条腿抓得住它们。第三种尤其说明问题：changed 和 expected 完全相等。
  const ANCHOR = "usage_note: '【何时用】决策前记一条内部结论。【何时不用】不要拿它当回复用户的话。'";
  assert.ok(RAW.includes(ANCHOR), "变异锚点不在源码里了 —— 下面三条断言在守空气，先把锚点换成一条真实存在的");
  const shapes = {
    "跨行模板串": "usage_note: `【何时用】决策前\n记一条内部结论。`",
    "标识符引用": "usage_note: THINK_NOTE",
    "拼接了变量": "usage_note: '【何时用】决策前'+SUFFIX",
  };
  for (const [name, replacement] of Object.entries(shapes)) {
    const r = stripToolGuides(RAW.replace(ANCHOR, replacement));
    assert.equal(r.residual, 1,
      `${name}：剥离器处理不了这种形状，residual 必须报 1 —— 报 0 就是一个脏包被放行了`);
  }
  // 「拼接了变量」这一种，两个计数器是完全相等的 —— 写死这一条，是为了让人看见
  // 「只靠 changed/expected 就够了」这个想法在哪里破掉。
  const tricky = stripToolGuides(RAW.replace(ANCHOR, "usage_note: '【何时用】决策前'+SUFFIX"));
  assert.equal(tricky.changed, tricky.expected,
    "这一种本来就骗得过计数器；如果它现在不相等了，说明计数逻辑变了，上面那条 residual 断言的意义要重估");
});

// ---- 能力名录的注解：短不等于坏，坏的是「被截断成短」 ----------------------
//
// 这一组**真跑** _capabilityNote，喂真实的 TOOL_METADATA。原实现无条件 slice(0,16)
// 再剥尾部 ASCII，把 8 条注解削成语义相反的三两个字，其中两条还削成了逐字相同的
// 「启动」——read_terminal（读日志）和 run_in_terminal（起进程）在模型眼里没有区别。
// 名录每个 agent 轮都在上下文里，这类注解不是「信息量不足」，是把模型往反方向推。
test("能力注解：没有一条被截成语义相反的残句", async () => {
  const note = loadCapabilityNote();
  const { TOOL_METADATA } = await import(pathToFileURL(GUIDES).href);
  const bad = [];
  for (const [name, meta] of Object.entries(TOOL_METADATA)) {
    const out = note(name, meta);
    if (!out) continue;                       // 不给注解是允许的：没有比错的强
    const inner = out.slice(1, -1);
    // 被截断的残句才是问题。判据：注解比原句短（说明截过），却只剩三两个字。
    const raw = String(meta?.usage_note || "");
    const src = (raw.match(/【何时用】([^【]*)/) || [])[1] || (meta?.use_cases || [])[0] || "";
    const full = String(src).replace(/\s+/g, "").split(/[；;。，,——｜|]/)[0];
    if (inner.length < 5 && full.length > inner.length) bad.push(`${name}: 「${inner}」← ${full.slice(0, 40)}`);
  }
  assert.deepEqual(bad, [],
    `这些注解被截成了残句（原句更长，剩下的三两个字已经改变了语义）：\n  ${bad.join("\n  ")}`);
});

test("能力注解：两个工具不许拿到逐字相同的注解", async () => {
  // read_terminal 和 run_in_terminal 曾经都是「(启动)」。同一条注解挂在语义相反的两个
  // 工具上，比没有注解更糟：它给了模型一个错误的区分依据。
  const note = loadCapabilityNote();
  const { TOOL_METADATA } = await import(pathToFileURL(GUIDES).href);
  const seen = new Map();
  for (const [name, meta] of Object.entries(TOOL_METADATA)) {
    const out = note(name, meta);
    if (!out) continue;
    (seen.get(out) || seen.set(out, []).get(out)).push(name);
  }
  const dup = [...seen].filter(([, names]) => names.length > 1)
    .map(([n, names]) => `${n} ← ${names.join(" / ")}`);
  assert.deepEqual(dup, [], `这些工具共用了同一条注解：\n  ${dup.join("\n  ")}`);
});

test("能力注解：尾巴不许悬空（半个标识符、孤零零的括号或破折号）", async () => {
  const note = loadCapabilityNote();
  const { TOOL_METADATA } = await import(pathToFileURL(GUIDES).href);
  const bad = [];
  for (const [name, meta] of Object.entries(TOOL_METADATA)) {
    const inner = (note(name, meta) || "").slice(1, -1);
    if (!inner) continue;
    if (/[（(【[/、\-—－_]$/.test(inner)) bad.push(`${name}: 「${inner}」`);
    if ((inner.match(/（/g) || []).length !== (inner.match(/）/g) || []).length) bad.push(`${name}: 括号不成对「${inner}」`);
  }
  assert.deepEqual(bad, [], `尾巴悬空：\n  ${bad.join("\n  ")}`);
});

test("能力注解：整块的字节数没有失控（它每轮都在上下文里）", async () => {
  const note = loadCapabilityNote();
  const { TOOL_METADATA } = await import(pathToFileURL(GUIDES).href);
  let chars = 0, n = 0;
  for (const [name, meta] of Object.entries(TOOL_METADATA)) {
    const out = note(name, meta);
    if (out) { chars += out.length; n++; }
  }
  assert.ok(n >= 100, `只生成了 ${n} 条注解 —— 判据本身坏了，任何"通过"都不作数`);
  assert.ok(chars <= 2600,
    `注解总长 ${chars} 字符。修截断的代价应当是几十字符量级；`
    + "涨到这个程度说明放宽档位失控了，而这块每个 agent 轮都在上下文里。");
});
