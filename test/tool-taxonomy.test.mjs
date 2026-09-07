// 工具分类：146 个工具收成 17 个自洽的类，并且 search_tools 能**按类整组装载**。
//
// 2026-09-07 生产库 90 天读数：31,584 次工具调用里 146 个目录工具只有 72 个被调过，前 14 个占 93%，
// 74 个从未被调——不是没用，是够不着：不在开局窗口里，search_tools 只认精确名、本地模糊，
// 最后才是一次 20 秒的网络编排。名录本来就按类列出全部工具，缺的是「拿着类名整组取回」。
//
// 能在 Node 里跑的（分类解析、分类装载、模糊维度）一律真跑；只有主循环接线用源码守调用点。

import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_METADATA, CATEGORY_LABELS, enrichedCatalogLine } from "../src/tool-guides.js";
import { baseTools, readonlyExternalTools, writeTools } from "../src/agent/tool-catalog.js";
import {
  TOOL_CATEGORY_ALIASES, _toolCategoryFromQuery, _toolsInCategory, _searchToolsCategory, _searchToolsFuzzyMatch,
} from "../src/agent/tool-discovery.js";
import { fnSource, SRC } from "./helpers/source.mjs";

const registry = new Map();
for (const t of [...baseTools(), ...readonlyExternalTools(), ...writeTools()]) registry.set(t.function.name, t);
const CATALOG = [...registry.keys()];

test("每个目录工具有且只有一个分类，分类都有展示名，没有孤零零的单工具类", () => {
  const missing = CATALOG.filter((n) => !TOOL_METADATA[n]?.category);
  assert.deepEqual(missing, [], `没分类的工具：${missing.join(", ")}`);
  const unlabeled = [...new Set(CATALOG.map((n) => TOOL_METADATA[n].category))].filter((c) => !CATEGORY_LABELS[c]);
  assert.deepEqual(unlabeled, [], `分类没有展示名：${unlabeled.join(", ")}`);
  const sizes = {};
  for (const n of CATALOG) sizes[TOOL_METADATA[n].category] = (sizes[TOOL_METADATA[n].category] || 0) + 1;
  const singletons = Object.entries(sizes).filter(([, k]) => k < 2).map(([c]) => c);
  assert.deepEqual(singletons, [], `只有一个工具的类是噪声，并进邻近的类：${singletons.join(", ")}`);
  // 展示名表里的每一类都要真的有工具，别留空桶让模型去查
  const empty = Object.keys(CATEGORY_LABELS).filter((c) => !sizes[c]);
  assert.deepEqual(empty, [], `空分类：${empty.join(", ")}`);
  // 每个分类都要有别名，否则模型用中文/口语问不到
  const noAlias = Object.keys(CATEGORY_LABELS).filter((c) => !(TOOL_CATEGORY_ALIASES[c] || []).length);
  assert.deepEqual(noAlias, [], `分类没有别名：${noAlias.join(", ")}`);
});

test("同一件事不许拆在两个类里：代码检索、联网读页、文件落盘各归一处", () => {
  const cat = (n) => TOOL_METADATA[n].category;
  assert.equal(cat("search"), cat("find_files"), "search 和 find_files 是同一件事的两种问法");
  assert.equal(cat("search"), cat("semantic_search"));
  assert.equal(cat("web_fetch"), cat("web_search"), "web_fetch 读的就是 web_search 找到的页面");
  assert.equal(cat("download_file"), cat("read_file"), "下载到本地和读文件都是文件读写");
  assert.equal(cat("start_demo"), cat("run_cmd"), "启停演示是在机器上跑东西");
  assert.equal(cat("visual_compare"), cat("figma"), "视觉比对是设计工作");
  assert.notEqual(cat("browser"), cat("computer"), "浏览器自动化和桌面自动化是两套沙箱，不能混");
});

test("分类解析：id / 中文展示名 / 中英文别名 / 带前后缀的口语都认，工具名和随便一个词不认", () => {
  const cases = {
    git: "version_control", "版本控制": "version_control", "Git 相关工具": "version_control", "load all git tools": "version_control",
    "数据库": "data_layer", db: "data_layer", browser: "ui_automation", "浏览器自动化": "ui_automation",
    "所有文件类工具": "file_io", files: "file_io", "列出设计工具": "creative", office: "office",
    "联网调研": "research", research: "research", "终端": "execution", "桌面": "desktop_automation",
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(_toolCategoryFromQuery(q), want, `「${q}」`);
  for (const q of ["git_status", "random", "", "browser_click", "read the file"]) assert.equal(_toolCategoryFromQuery(q), null, `「${q}」不该被当成分类`);
  // 每个分类的 id 和展示名都能反解回自己（展示名里的括号说明会被剥掉）
  for (const [id, label] of Object.entries(CATEGORY_LABELS)) {
    assert.equal(_toolCategoryFromQuery(id), id);
    assert.equal(_toolCategoryFromQuery(label), id, `展示名「${label}」解不回 ${id}`);
  }
});

test("分类装载：跳过已在窗口里的，高优先级排前面，超出上限的按名字列出而不是丢掉", () => {
  const loaded = new Set(["git_status", "git_diff"]);
  const r = _searchToolsCategory("git", registry, loaded, 5);
  assert.equal(r.id, "version_control");
  assert.deepEqual(r.already.sort(), ["git_diff", "git_status"]);
  assert.equal(r.schemas.length, 5, "上限 5 就装 5 个");
  for (const s of r.schemas) assert.ok(!loaded.has(s.function.name), "装了已在手上的");
  assert.equal(r.names.length, r.already.length + r.schemas.length + r.overflow.length, "总数 = 已装 + 本次装 + 溢出，一个都不能丢");
  const ranks = { critical: 0, high: 1, medium: 2, normal: 2, low: 3 };
  const got = r.schemas.map((s) => ranks[TOOL_METADATA[s.function.name].priority] ?? 2);
  assert.deepEqual(got, [...got].sort((a, b) => a - b), "装载顺序要按优先级");
  assert.equal(_searchToolsCategory("git_status", registry, loaded), null, "工具名不走分类通道");
  // 整类都已在手上
  const all = new Set(_toolsInCategory("office", registry).map((t) => t.name));
  const r2 = _searchToolsCategory("office", registry, all);
  assert.equal(r2.schemas.length, 0); assert.equal(r2.already.length, all.size);
});

test("模糊匹配多了分类这一维：「数据库」直接把 db_query 顶到最前", () => {
  const hits = _searchToolsFuzzyMatch("数据库", registry, new Set());
  assert.ok(hits.length, "没有命中");
  assert.equal(hits[0].name, "db_query");
  assert.ok(hits[0].matchedOn.includes("category"), "命中维度里要能看出是分类命中的");
});

test("编排器目录行带【分类】，模型按类扫一遍就能圈候选", () => {
  const line = enrichedCatalogLine({ name: "db_query", description: "x", inputs: [], required: [] });
  assert.match(line, /【分类】数据与实时信息/);
});

test("主循环的 search_tools 分支：分类通道排在精确名和模糊之前，描述里告诉模型可以传类名", () => {
  const src = SRC;
  const at = src.indexOf("const _cat = _searchToolsCategory(call.query, registry, loaded);");
  assert.ok(at > 0, "主循环没接分类通道");
  const branch = src.slice(at, at + 1500);
  assert.match(branch, /if \(_cat\) \{ exact = null; fastAdds = _cat\.schemas; \}/, "分类命中要直接走快通道");
  assert.match(branch, /if \(!_cat && !exact\?\.schema\) \{/, "分类命中后不许再跑模糊匹配");
  assert.ok(src.indexOf("_searchToolsFuzzyMatch(call.query, registry, loaded)", at) > at, "模糊匹配必须在分类之后");
  const desc = src.match(/const _SEARCH_TOOLS_DESCRIPTION = `([^`]+)`;/)?.[1] || "";
  for (const id of Object.keys(CATEGORY_LABELS)) assert.ok(desc.includes(id), `描述里没列分类 ${id}`);
  assert.match(fnSource("_searchToolsCategory", { code: true }), /overflow/, "溢出的名字要列出来，不能静默丢");
});
