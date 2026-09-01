/**
 * 每一种工具卡都得有自己的图标和配色 —— 不许静默回落。
 *
 * 起因：用户实拍「批量读取怎么没国外风格大厂图标」。查下去不是那一个的问题：
 * `toolIconSvg` 认不出类型时会回落到一张通用文件图（这是对的，不能留空方块），
 * 但**回落是静默的**，于是 101 种卡片类型里有 58 种长着同一张灰纸，
 * 图标就不再承担"这一步在干什么"的第一眼判断了。
 *
 * 所以判据放在这里，而不是靠人一屏一屏看：卡片类型的**全集**从 main.js 里那张
 * 「工具名 → 卡片类型」的 switch 现取，逐个要求在两张表里都有条目。
 * 新加一个工具时忘了配图标，这条会直接红。
 */
import test from "node:test";
import assert from "node:assert";
import { TOOL_ICONS, TOOL_FAMILY, toolIconSvg, toolIconFamily } from "../src/agent/tool-icons.js";
// 走共享的 CODE（注释已抹平、行号保留），不自己读 main.js：注释里出现一个 case
// 或一段旧的图标拼接，都会让下面的断言凭注释变绿。
import { CODE } from "./helpers/source.mjs";

/** main.js 里 `case "read_file": … return { type: "read"` 那张表。 */
function cardTypes() {
  const map = new Map();
  for (const m of CODE.matchAll(/case\s+"([a-z0-9_]+)":[^\n]*?return\s*\{\s*type:\s*"([a-z0-9_]+)"/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

test("switch 那张表本身还在（锚点没漂）", () => {
  const map = cardTypes();
  // 数量只做下界：加工具会涨，但从三位数掉到个位数一定是锚点失效了。
  assert.ok(map.size > 80, `只认出 ${map.size} 个工具，正则多半没匹配上了`);
  assert.strictEqual(map.get("read_file"), "read");
  assert.strictEqual(map.get("search"), "search");
});

test("每一种卡片类型都有专属图标，没有静默回落", () => {
  const types = [...new Set(cardTypes().values())];
  const miss = types.filter((t) => !(t in TOOL_ICONS));
  assert.deepStrictEqual(miss, [],
    `这些类型会回落成通用文件图：${miss.join(" ")}——在 src/agent/tool-icons.js 里给它们各画一个`);
});

test("每一种卡片类型都有配色家族，不落中性灰", () => {
  const types = [...new Set(cardTypes().values())];
  const miss = types.filter((t) => !(t in TOOL_FAMILY));
  assert.deepStrictEqual(miss, [], `这些类型会退成灰：${miss.join(" ")}`);
});

test("图形两两不同——图标是用来分辨的", () => {
  const seen = new Map();
  const dup = [];
  for (const [k, v] of Object.entries(TOOL_ICONS)) {
    if (seen.has(v)) dup.push(`${k} 和 ${seen.get(v)} 同形`);
    else seen.set(v, k);
  }
  assert.deepStrictEqual(dup, [], dup.join("；"));
});

test("批量读取那张聚合卡：和单张读取不同形，且走 read 族的蓝", () => {
  // 这一张是用户实际指出来的。它以前把图标内联在 main.js 里，整套换描边时没跟上。
  assert.ok("readbatch" in TOOL_ICONS, "批量读取又没有自己的图标了");
  assert.notStrictEqual(TOOL_ICONS.readbatch, TOOL_ICONS.read, "批量读取和单张读取长一样了");
  assert.strictEqual(toolIconFamily("readbatch"), "read");
  // 而且 main.js 那边必须是从这张表取，不能再内联一份——内联的那份就是漂移的来源。
  assert.match(CODE, /data-fam="\$\{_toolIconFamily\("readbatch"\)\}">\$\{_toolIconSvg\("readbatch"\)\}/,
    "批量读取的图标又被内联回 main.js 了");
});

test("所有图形都是描边的 24 网格，没有夹带 fill 的旧图", () => {
  for (const [k, geo] of Object.entries(TOOL_ICONS)) {
    assert.doesNotMatch(geo, /fill="(?!none)/, `${k} 自带填色，不会跟主题走`);
    assert.doesNotMatch(geo, /viewBox/, `${k} 自己套了 svg，外层属性就管不住它了`);
  }
  const svg = toolIconSvg("read");
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
});
