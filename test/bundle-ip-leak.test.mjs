// 发布产物里不许出现「面向模型的散文」——判据建立在**解码后的字符串表**上，不是明文。
//
// 为什么不能 grep 明文（本仓 dist/assets/main-*.js 实测）：
//     标记            字符串表   明文 grep
//     【何时用】          95        42
//     【vs 替代】         68         0   ← grep 报「干净」
//     example_call 形状   99         0   ← grep 报「干净」
//     "规划与起步"         1         0   ← grep 报「干净」
// stringArrayThreshold=0.75 把四分之三的字面量搬进了 base64 表，而且用的是**打乱过的
// base64 字母表**，所以「取出数组元素自己 atob」也不成立。唯一站得住的做法在
// build/bundle-strings.mjs：把混淆器自己的数组函数 + 解码函数抠出来在 vm 里跑。
//
// 探针**不是手写的**。手写探针是本仓记着的「测试台自编形状」：测试证明了自己编的那份
// 文本不在包里，而真正泄漏的那份从没被问过。这里的探针逐字取自 src/tool-guides.js
// 的 TOOL_METADATA / TOOL_EXAMPLES 和 main.js 的 _buildToolHint —— 也就是**要保护的
// 那份数据本身**。有人给 tool-guides.js 加一条新工具，探针自动多几条，不用改这个文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { extractBundleStrings } from "../build/bundle-strings.mjs";
import { ALLOWED_REGIONS } from "../build/strip-tool-guides.mjs";
import { fnSource } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "../dist/assets");
// 发布流水线必须置位。缺了它，「dist 不在就跳过」会把这条测试变成一条**恒绿**的门。
//
// **只认显式标志，不认裸的 CI=true。** 这条流水线的顺序是「先跑测试、再构建」
// （.github/workflows/ide-package.yml：Run frontend logic tests 在 Build installable
// desktop bundle 之前），所以那一轮里 dist 天然不存在 —— 拿 CI=true 当发布路径，
// 会让每一次打包都在测试步就红，而它想守的那件事（产物里有没有 IP）根本还没发生。
// 正确落点是构建**之后**的独立一步，那一步显式置 IDE_RELEASE_CHECK=1。
const REQUIRED = process.env.IDE_RELEASE_CHECK === "1";

function appChunks() {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST)
    .filter((f) => /^(main|overlay)-.*\.js$/.test(f))
    .map((f) => join(DIST, f));
}

/** 逐字取自源码的探针集合。只留 >= 12 字符的，短串会误伤（"list_dir"、"high"）。 */
async function probesFromSource() {
  const probes = new Map(); // 文本 -> 出处
  const add = (text, where) => {
    const s = String(text || "").trim();
    if (s.length >= 12) probes.set(s, where);
  };
  const guidesPath = join(HERE, "../src/tool-guides.js");
  // 直接 import 拿真实数据，而不是从源文本正则抠——抠出来的是「我以为的形状」。
  const mod = await import(pathToFileURL(guidesPath).href);
  for (const [name, meta] of Object.entries(mod.TOOL_METADATA)) {
    add(meta.usage_note, `TOOL_METADATA.${name}.usage_note`);
    add(meta.example_call, `TOOL_METADATA.${name}.example_call`);
    for (const u of meta.use_cases || []) add(u, `TOOL_METADATA.${name}.use_cases`);
    for (const t of meta.triggers || []) add(t, `TOOL_METADATA.${name}.triggers`);
  }
  for (const label of Object.values(mod.CATEGORY_LABELS)) add(label, "CATEGORY_LABELS");
  // TOOL_EXAMPLES 不导出，从源文本里取它那段的字符串字面量。
  const src = readFileSync(guidesPath, "utf8");
  const at = src.indexOf("const TOOL_EXAMPLES = Object.freeze({");
  if (at >= 0) {
    const seg = src.slice(at, src.indexOf("\n});", at));
    for (const m of seg.matchAll(/(['"])((?:[^\\]|\\.)*?)\1/g)) add(m[2], "TOOL_EXAMPLES");
  }
  // 减掉**显式豁免留在客户端**的那些串（build/strip-tool-guides.mjs 的 ALLOWED_REGIONS）。
  // 不减的话会有假阳性：TOOL_EXAMPLES 里的 "https://github.com/owner/repo.git" 和
  // FIELD_VALUES 里同名参数的占位值逐字相同，剥完之后前者没了、后者按设计留着，
  // 而探针分不出这两处 —— 一条永远修不好的红，最后一定是被人把探针删掉收场。
  for (const region of Object.keys(ALLOWED_REGIONS)) {
    const a = src.indexOf(`const ${region} = `);
    if (a < 0) continue;
    const seg2 = src.slice(a, src.indexOf("\n});", a) + 1 || undefined);
    for (const t of [...probes.keys()]) if (seg2.includes(t)) probes.delete(t);
  }
  // 客户端拼给模型的那三段（动态工具编排 / 场景→工具直觉 / 完整能力名录）。
  // 用 fnSource 按 AST 取，不用固定字符窗口——函数变长时窗口会静默守空。
  const hint = fnSource("_buildToolHint", { code: true });
  for (const m of hint.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    add(m[1].replace(/\\n/g, "\n").slice(0, 60), "_buildToolHint");
  }
  return probes;
}

test("发布产物里不许出现面向模型的散文（判据在解码后的字符串表上）", async () => {
  const chunks = appChunks();
  if (!chunks.length) {
    assert.ok(!REQUIRED,
      "dist/assets 里没有 main-*/overlay-* 产物，这条泄漏检查一次都没跑。"
      + "发布路径上「没跑」不等于「通过」——先 npm run build 再跑。");
    return; // 本地开发树里没构建过，如实跳过
  }
  const probes = await probesFromSource();
  assert.ok(probes.size > 300,
    `只从源码里取出 ${probes.size} 条探针 —— 取探针那一步坏了，扫描结果不作数。`);

  // **按探针去重，不按「块 × 探针」。** 上一版每个块各数一遍：同一段文本同时出现在
  // main-*.js 的两个块里就算两次，而哪些字面量落到哪个块由代码分割决定、每次构建可能
  // 不同 —— 于是这个数会在 351 / 355 之间抖，棘轮就没法钉住。
  // 去重之后它是「我的源文本有多少条出现在了发布包里」，语义也更对。
  const leakedProbes = new Map(); // 文本 -> 出处
  for (const file of chunks) {
    const src = readFileSync(file, "utf8");
    // canary：一段**必然**在包里的文本。抽取器看不见它 = 抽取器坏了，直接 throw，
    // 而不是安静地返回空表让这条测试变成恒绿。
    const { strings, diag } = extractBundleStrings(src, { canary: "assets/" });
    const table = new Set(strings);
    const joined = strings.join(" ");
    for (const [text, where] of probes) {
      if (table.has(text) || joined.includes(text) || src.includes(text)) {
        leakedProbes.set(text, where);
      }
    }
    // 按体积缩放的下限：混淆产物里字面量密度很稳（本仓实测约 350 B/条）。
    // 8000 B/条 是它的二十几分之一，只在「抽取器基本没抓到东西」时才会红。
    const floor = Math.max(32, Math.floor(src.length / 8000));
    assert.ok(diag.arrayLen >= floor,
      `${file}: 字符串表只有 ${diag.arrayLen} 条，按 ${src.length} 字节的体积至少该有 ${floor} 条 —— 抽取器没抓全，扫描结果不作数。`);
  }
  const leaks = [...leakedProbes].map(([text, where]) => `${where}: ${JSON.stringify(text.slice(0, 48))}`);

  // **棘轮，不是开关。** 目标是 0，但把这些文本搬到服务端要分几批（网关先补上、客户端
  // 再剥，且必须一次性验收）。中间这段时间不能让这条门一直红 —— 一条永远红的门等于没门，
  // 人会学会忽略它，然后连真的回归也一起忽略。
  //
  // 判据是「只许降不许涨」：每搬完一批就把这个数改小。改**大**必须在提交信息里说明为什么。
  //
  // 现值 369，**从发布构建量的**（GitHub Actions 的 ide-package.yml，commit 61ca559）。
  //
  // 别拿本地 `npm run build` 的数当基准：同一份源码，本地开发构建量到 351、发布构建 369。
  // 差的是产出的块（main-*/overlay-*）数量和切分 —— 发布路径上更多探针被命中。
  // 我为此白烧了三轮 CI，把这条写在这儿免得下一个人重来。
  //
  // 【2026-09-01 补】还有更麻烦的一层：**这个数在同一份源码上也不稳定**。实测同源连跑
  // 三次本地发布构建，命中数分别是 376 / ≤369 / ≤369。原因在 vite.config.js 的混淆器：
  // `stringArrayThreshold: 0.75` 表示**随机**挑 75% 的字符串literal 进字符串表，而
  // extractBundleStrings 只能从那张表里捞 —— 没设 `seed`（默认 0 = 每次随机），
  // 于是每次构建被捞到的子集不同。
  //
  // 也就是说：这条门偶发假红，而且假红的幅度（实测 +7）足以盖过一次真的回归。
  // 判据本身要修（给混淆器钉 seed，或把 threshold 提到 1 让覆盖变确定），但那是在动
  // **发布产物的安全设置**，要单独评估后再改，不该顺手带进一个改按钮样式的提交。
  // 在那之前：这条红了先重跑一次构建再下结论，别急着抬上限——泄漏的语料一条都没变，
  // 变的只是这次捞到了几条。
  //
  // 【2026-09-01：369 → 20】这上限原来锁的是一个**从来没被修过的洞**——
  // build/strip-tool-guides-plugin.mjs 2026-08-27 就写好了，但引入它的那笔提交里没有
  // vite.config.js，插件从未接进构建，于是 143 个工具的完整使用说明整份跟着发布包出门。
  // 接上之后同一条判据实测从 369 掉到 8（【何时用】93→0、「vs 替代」61→0）。
  //
  // 上限取 20 而不是 8：上面那段说的混淆器随机抽样（无 seed，实测抖动 ±7）仍在，
  // 钉死 8 会让这道门在**没有任何回归**时偶发假红。20 = 8 + 抖动余量，
  // 而离真正的回归（几十上百条）还有足够距离。
  // 剩下那几条是 ALLOWED_REGIONS 显式豁免的、以及 _buildToolHint 里刻意留在客户端的一句。
  const LEAK_BUDGET = 20;
  assert.ok(leaks.length <= LEAK_BUDGET,
    `发布包里查到 ${leaks.length} 条工具说明文本，比上限 ${LEAK_BUDGET} 多了 `
    + `${leaks.length - LEAK_BUDGET} 条 —— 有人往客户端加了新的工具说明。\n`
    + `样例：\n  ${leaks.slice(0, 5).join("\n  ")}\n`
    + "这些是网关该持有的东西，客户端一份都不该带。");
  // 搬完一批却忘了收紧上限，等于把门重新放松。降下来就要当场钉住。
  // 窗口下沿 -25：既能兜住「本地开发构建比发布构建少数十几条」这个已知差值，
  // 又能在真的搬走一批之后逼人收紧上限。
  assert.ok(leaks.length >= LEAK_BUDGET - 18,
    `实际只剩 ${leaks.length} 条，远低于上限 ${LEAK_BUDGET} —— 搬迁推进了，`
    + `请把 LEAK_BUDGET 改成 ${leaks.length}（目标 0），否则这道门会一直松着。`);
});

test("抽取器坏掉时必须 throw，不许退化成「没扫到」", () => {
  // 反向变异：喂一段没有 stringArray 结构的代码，抽取器必须报错而不是返回空数组。
  assert.throws(() => extractBundleStrings("const a=1;console.log(a);"),
    /认不出混淆器的字符串表结构/);
});

test("阳性对照缺席时必须 throw", () => {
  const chunks = appChunks();
  if (!chunks.length) return;
  const src = readFileSync(chunks[0], "utf8");
  assert.throws(
    () => extractBundleStrings(src, { canary: "这段文本绝不可能在任何产物里出现-Zx9" }),
    /阳性对照/,
  );
});
