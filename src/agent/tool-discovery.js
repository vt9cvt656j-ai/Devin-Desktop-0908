// 工具发现：模型（主循环或子智能体）要一个手上没有的工具时，本地怎么找、找到了怎么判能不能给。
//
//   · _searchToolsExactQuery / _searchToolsLookup —— 精确名通道（先过 _canonicalToolName 同一套归一）；
//   · _searchToolsFuzzyMatch / _confidentFuzzyResolution —— 名称/描述/场景/触发条件的本地检索，
//     以及「够不够硬、能不能省掉那次网络编排调用」的保守判据；
//   · _nearestToolNames / _unknownToolHint / _subAgentUsableToolNames —— 叫错名字时最接近的候选；
//   · _subAgentAdmitTools / _subAgentSearchToolsLabel —— 子智能体按自己的沙箱准入；
//   · _toolSchemaFromRegistry —— 按（可能是别名的）名字从注册表取 schema。
//
// 四个 main.js 事实由 configureToolDiscovery 注入：工具名归一化（它不能搬——logic.test 按名字
// 抠它跑，多一个自由标识符就 ReferenceError）、严格变更工具名单、全量注册表构造、名字→类型映射。
// **标识符名字原样保留**：test/ 里有几十处按名字 load() 这些函数并按名字注入依赖。
// 从 main.js 原样搬出，一行逻辑没改。
import { TOOL_METADATA, CATEGORY_LABELS, autoEnrichToolMetadata } from "../tool-guides.js";

/*
 * 按**分类**查工具。
 *
 * 146 个工具 90 天里只有 72 个被调过，前 14 个占 93%——不是另外 74 个没用，是模型够不着：
 * 它们不在开局窗口里，search_tools 只认精确名、模糊匹配、最后才是一次 20 秒的网络编排。
 * 名录本来就按分类列出全部工具，缺的是「拿着分类名整组取回」这一步。
 *
 * 判据只认**整体**等于某个分类的 id / 展示名 / 别名（大小写、空格、连字符、「类/工具/相关」
 * 这种后缀都容忍），不做子串匹配——"git_status" 不能因为含 git 就被当成整类请求。
 */
export const TOOL_CATEGORY_ALIASES = Object.freeze({
  planning: ["规划", "起步", "计划", "脚手架", "技能", "plan", "planning", "scaffold", "skills", "setup"],
  file_io: ["文件", "文件读写", "读写", "目录", "files", "file", "filesystem", "fs", "io"],
  code_editing: ["编辑", "代码编辑", "改代码", "写文件", "edit", "editing", "write", "code_editing"],
  search: ["检索", "代码检索", "符号", "查找", "搜代码", "lsp", "search", "symbols", "code_search", "find"],
  diagnostics: ["诊断", "调试", "性能", "报错", "diagnostics", "debug", "debugging", "performance", "profiling"],
  execution: ["终端", "命令", "执行", "运行", "部署", "shell", "terminal", "command", "commands", "execution", "run", "deploy"],
  version_control: ["git", "版本控制", "版本", "提交", "pr", "github_pr", "vcs", "version_control", "source_control"],
  research: ["调研", "联网调研", "联网", "搜索来源", "论文", "社区", "仓库", "research", "web", "internet", "papers", "community"],
  networking: ["网络", "网络请求", "抓包", "http", "api", "request", "requests", "network", "networking", "capture", "remote", "远程"],
  ui_automation: ["浏览器", "网页自动化", "浏览器自动化", "browser", "web_automation", "e2e", "playwright"],
  desktop_automation: ["桌面", "桌面自动化", "电脑操作", "desktop", "computer", "gui", "desktop_automation"],
  creative: ["设计", "视觉", "figma", "设计稿", "creative", "design", "visual", "ui_design", "image"],
  game_asset_generation: ["游戏素材", "游戏", "素材", "3d", "音效", "音乐", "game", "assets", "game_assets", "audio", "music"],
  office: ["文档", "办公", "excel", "word", "ppt", "表格", "office", "docs", "documents", "spreadsheet", "wiki"],
  data_layer: ["数据", "数据库", "实时信息", "天气", "sql", "db", "data", "database", "data_layer", "realtime"],
  orchestration: ["编排", "子智能体", "多智能体", "并行", "agents", "subagent", "subagents", "orchestration", "workers"],
  interaction: ["交互", "记忆", "提问", "提醒", "interaction", "memory", "ask", "schedule", "user"],
});

const _normCategoryQuery = (query) => {
  let q = String(query || "").toLowerCase().replace(/[\s\-]+/g, "_").replace(/[（(].*?[)）]/g, "");
  // 「Git 相关工具」「所有文件类」这种：前缀和后缀可能叠好几层，剥到不变为止
  for (let i = 0; i < 4; i++) {
    const next = q
      .replace(/(?:_?(?:类|类别|分类|相关|工具|一族|全部|所有|tools?|category|group|family))$/, "")
      .replace(/^(?:所有|全部|列出|加载|装载|load|list|show|all)_?/, "")
      .replace(/_+$/, "").replace(/^_+/, "");
    if (next === q) break;
    q = next;
  }
  return q.trim();
};

/** 查询整体是不是某个分类：返回分类 id，不是就 null。 */
export function _toolCategoryFromQuery(query) {
  const q = _normCategoryQuery(query);
  if (!q) return null;
  for (const [id, aliases] of Object.entries(TOOL_CATEGORY_ALIASES)) {
    if (q === id) return id;
    const label = String(CATEGORY_LABELS[id] || "").toLowerCase().replace(/\s+/g, "_");
    if (label && (q === label || q === label.replace(/[（(].*?[)）]/g, ""))) return id;
    if (aliases.some((alias) => q === String(alias).toLowerCase().replace(/[\s\-]+/g, "_"))) return id;
  }
  return null;
}

/** 某个分类里注册表真有的工具，按元数据 priority 高的排前面（同级按名字）。 */
export function _toolsInCategory(categoryId, registry) {
  const rank = { critical: 0, high: 1, medium: 2, normal: 2, low: 3 };
  const out = [];
  for (const [name, schema] of registry?.entries?.() || []) {
    const meta = TOOL_METADATA[name];
    if (!meta || meta.category !== categoryId) continue;
    out.push({ name, schema, rank: rank[meta.priority] ?? 2 });
  }
  return out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(({ name, schema }) => ({ name, schema }));
}

/**
 * search_tools 的分类通道：查询就是一个分类名时，一次把这一类装进窗口。
 * 返回 null 表示「不是分类查询」，调用方照走原来的精确 / 模糊 / 编排路径。
 */
export function _searchToolsCategory(query, registry, loadedNames, max = 12) {
  const id = _toolCategoryFromQuery(query);
  if (!id) return null;
  const all = _toolsInCategory(id, registry);
  const loaded = new Set([...(loadedNames || [])]);
  const fresh = all.filter((t) => !loaded.has(t.name));
  return {
    id,
    label: CATEGORY_LABELS[id] || id,
    names: all.map((t) => t.name),
    already: all.filter((t) => loaded.has(t.name)).map((t) => t.name),
    schemas: fresh.slice(0, Math.max(0, max)).map((t) => t.schema),
    overflow: fresh.slice(Math.max(0, max)).map((t) => t.name),
  };
}

let _canonicalToolName = (name) => String(name || "");
let _STRICT_MUTATING_TOOL_NAMES = new Set();
let _buildToolRegistry = () => new Map();
let _mapToolCall = () => null;
/** main.js 在 _STRICT_MUTATING_TOOL_NAMES 定义之后调用一次；测试里用桩。 */
export function configureToolDiscovery(deps = {}) {
  if (typeof deps._canonicalToolName === "function") _canonicalToolName = deps._canonicalToolName;
  if (deps._STRICT_MUTATING_TOOL_NAMES instanceof Set) _STRICT_MUTATING_TOOL_NAMES = deps._STRICT_MUTATING_TOOL_NAMES;
  if (typeof deps._buildToolRegistry === "function") _buildToolRegistry = deps._buildToolRegistry;
  if (typeof deps._mapToolCall === "function") _mapToolCall = deps._mapToolCall;
}

// Identifier-shaped input can be an explicit tool-name request. Exact registered
// names always win, and unknown compound identifiers never degrade into loose terms:
// `local_discovery` must not match `http_request` merely because it says localhost.
/// 子任务当前手上真正能用的工具名（按它被允许的 type 过滤注册表）。
///
/// 拒绝的时候要能把这份清单说出来。说不出来，「换一个工具」就是一句空话——
/// 子体侧没有主循环那套「回执里点名的工具当轮装进窗口」的自愈。
/// 叫错工具名时那一句提示。
///
/// 单独一个函数而不是就地 IIFE：仓库里有一条「并发槽位在每一条退出路径上都要还回去」
/// 的检查，它按 return 的位置扫，就地 IIFE 的 return 会被误判成提前退出。
export function _unknownToolHint(wanted, execTypes, write) {
  const near = _nearestToolNames(wanted, _subAgentUsableToolNames(execTypes, write));
  return near.length
    ? `最接近的是：${near.join("、")}——是不是想调其中一个？`
    : "用 search_tools 传精确名字取回它的 schema，或者换一个你手上已有的工具。";
}

export function _subAgentUsableToolNames(execTypes, write) {
  try {
    const reg = _buildToolRegistry(!!write, []);
    const ok = [];
    for (const name of reg.keys()) {
      let type = "";
      try { type = (_mapToolCall(name, {}) || {}).type || ""; } catch { continue; }
      if (type && Array.isArray(execTypes) && execTypes.includes(type)) ok.push(name);
    }
    return ok.sort();
  } catch { return []; }
}

/// 名字打错时最接近的几个候选。纯本地：前缀/包含 + 一个便宜的编辑距离上界。
export function _nearestToolNames(wanted, pool, limit = 3) {
  const w = String(wanted || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (!w || !Array.isArray(pool) || !pool.length) return [];
  const score = (name) => {
    const n = String(name).toLowerCase().replace(/[\s_-]+/g, "");
    if (n === w) return 0;
    if (n.startsWith(w) || w.startsWith(n)) return 1;
    if (n.includes(w) || w.includes(n)) return 2;
    // 共同字符占比——不做完整编辑距离，够用且零依赖。
    // 阈值卡得高、并且要求长度接近：给错方向比不给更糟。放松到 0.7 时
    // "readfile" 会把 "find_files" 也算成候选（重合 5/7），那是在帮倒忙。
    if (Math.abs(n.length - w.length) > 2) return 99;
    const set = new Set(n);
    let hit = 0;
    for (const c of new Set(w)) if (set.has(c)) hit++;
    const ratio = hit / Math.max(new Set(w).size, 1);
    return ratio >= 0.85 ? 3 : 99;
  };
  return pool.map((n) => [score(n), n]).filter(([sc]) => sc < 99)
    .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
    .slice(0, limit).map(([, n]) => n);
}

export function _searchToolsExactQuery(query, registry) {
  const requested = String(query || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requested)) return null;
  // 第三步必须做**同一套归一**。
  //
  // 直接按名字调用时会先过 _canonicalToolName（别名、复数、连字符/下划线互换都收），
  // 而这里只试了原样和全小写。于是同一个名字：直接调能通、拿去 search_tools 查却被判
  // 「注册表里没有这个工具」。模型正是在够不着某个工具时才来搜的——这一步失手，
  // 它就以为这个能力不存在，转去绕远路或者干脆放弃。
  // 纯本地、零成本；mcp__ 前缀原样跳过（那套名字有自己的命名空间，不参与归一）。
  let exactName = registry.has(requested)
    ? requested
    : [...registry.keys()].find((name) => name.toLowerCase() === requested.toLowerCase()) || "";
  if (!exactName && !requested.startsWith("mcp__")) {
    try {
      const canon = _canonicalToolName(requested);
      if (canon && registry.has(canon)) exactName = canon;
    } catch {}
  }
  const schema = exactName ? registry.get(exactName) || null : null;
  if (!schema && !/[_-]/.test(requested)) return null;
  return { name: exactName || requested, schema };
}

// search_tools lookup is intentionally exact-only. Natural-language capability routing is
// delegated to _semanticToolOrchestrator; this function only handles an explicit registered
// name and never guesses from keywords or descriptions.
export function _searchToolsLookup(query, registry, loadedNames) {
  const exact = _searchToolsExactQuery(query, registry);
  if (!exact || !exact.schema || loadedNames?.has(exact.name)) return [];
  return [exact.schema];
}

// P1 #5: search_tools 多维度模糊匹配层——名称/描述/场景(use_cases)/触发器(triggers)/
// 自动推断标签 五个维度的本地检索。定位严格遵循「AI 主判、关键词兜底」：自然语言
// 路由的第一腿仍是 _semanticToolOrchestrator，本函数的命中只作(a)编排器的候选提示
// (b) 编排器不可用时的降级回退，不新增任何替代语义判断的硬路由分支。
// 返回按得分降序的 [{name, schema, score, matchedOn}]，精确匹配路径不受影响（向后兼容）。

export function _searchToolsFuzzyMatch(query, registry, loadedNames) {
  const q = String(query || "").toLowerCase().trim();
  if (!q || !registry || typeof registry.entries !== "function") return [];
  // 分词：空格/逗号分隔的多词查询逐词匹配；单字符噪声词丢弃，保留中文短词。
  const tokens = q.split(/[\s,，、]+/).filter((w) => w.length >= 2);
  if (!tokens.length) tokens.push(q);
  // 中文不带空格，整句会变成**一个** token：「在浏览器里点一下按钮」要求某条 trigger
  // 逐字包含这十个字才算命中，实际恒不命中。编排器超时时模糊层是唯一兜底，而用户
  // 大多用中文提问——于是兜底在最需要它的时候恒为空。给 CJK 词补二字滑窗作为附加词；
  // 整词命中仍按原分计，二元组只记 1 分，排序逻辑一个字不动。
  const bigrams = [];
  for (const w of tokens) {
    if (w.length < 3 || !/[\u4e00-\u9fff]/.test(w)) continue;
    for (let i = 0; i + 2 <= w.length; i++) bigrams.push(w.slice(i, i + 2));
  }
  // 同一个盲区的第二种形状：`browser_click`、`git_status` 这类标识符按上面的分词规则是
  // **一个** token，要求某个工具名/触发条件逐字包含 "browser_click" 才算命中——恒不命中。
  // 而这恰恰是模型最自然的查询形态（它就是照着工具命名法在猜名字）。零命中 → 快通道必空
  // → 等 MCP → 编排器，最坏 28 秒换回一句话。拆出子词，和 CJK 二元组同样按 1 分计：
  // 片段是弱信号，不能让 "database_inspector" 里的 "database" 以整词的分量把某个数据库
  // 工具直接顶成"判据明确"。排序逻辑一个字不动。
  const subwords = [];
  for (const w of tokens) {
    if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(w)) continue;
    for (const part of w.split(/[_-]+/)) if (part.length >= 3) subwords.push(part);
  }
  const extraTokens = [...new Set([...bigrams, ...subwords])].filter((b) => !tokens.includes(b));
  const hits = [];
  for (const [name, schema] of registry.entries()) {
    const fn = schema?.function;
    if (!fn?.name) continue;
    const lname = String(name).toLowerCase();
    const desc = String(fn.description || "").toLowerCase();
    const meta = TOOL_METADATA[name] || {};
    const autoMeta = autoEnrichToolMetadata({ name }) || {};
    const triggers = [...(meta.triggers || []), ...(autoMeta.triggers || [])];
    const useCases = [...(meta.use_cases || []), ...(autoMeta.use_cases || [])];
    let score = 0;
    const matchedOn = [];
    // 分类是第六个维度：「数据库」「浏览器」「git」这类词本身就是分类名，
    // 命中所属分类记 2 分（结构化维度，和触发条件同级）。
    const catId = meta.category || autoMeta.category || "";
    const catWords = catId
      ? [catId, String(CATEGORY_LABELS[catId] || "").toLowerCase(), ...(TOOL_CATEGORY_ALIASES[catId] || []).map((x) => String(x).toLowerCase())]
      : [];
    for (const w of tokens) {
      if (lname.includes(w)) { score += 3; matchedOn.push("name"); }
      if (catWords.some((c) => c && c === w)) { score += 2; matchedOn.push("category"); }
      if (triggers.some((t) => String(t).toLowerCase().includes(w))) { score += 2; matchedOn.push("trigger"); }
      if (useCases.some((u) => String(u).toLowerCase().includes(w))) { score += 2; matchedOn.push("use_case"); }
      if (desc.includes(w)) { score += 1; matchedOn.push("desc"); }
    }
    // 二元组也要**归因到具体维度**。统一记成 "cjk" 的话，下游判"有没有命中结构化维度"
    // 对中文查询结构上永远为假——而中文恰恰只能靠二元组命中，于是快通道对中文全盲。
    for (const w of extraTokens) {
      if (lname.includes(w)) { score += 1; matchedOn.push("name"); }
      else if (triggers.some((t) => String(t).toLowerCase().includes(w))) { score += 1; matchedOn.push("trigger"); }
      else if (useCases.some((u) => String(u).toLowerCase().includes(w))) { score += 1; matchedOn.push("use_case"); }
      else if (desc.includes(w)) { score += 1; matchedOn.push("desc"); }
    }
    if (score <= 0) continue;
    hits.push({
      name: fn.name,
      schema,
      score,
      alreadyLoaded: !!loadedNames?.has(fn.name),
      matchedOn: [...new Set(matchedOn)],
      // 去重后的推荐元数据，供结果展示「推荐场景/触发条件」。
      triggers: [...new Set(triggers)].slice(0, 3),
      use_cases: [...new Set(useCases)].slice(0, 3),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20);
}

/// 本地模糊命中够不够硬，够就别再发那一次网络编排调用了。
///
/// 一次非精确的 search_tools 现在最坏要串行等：8 秒 MCP 发现 + 20 秒编排器 LLM 调用，
/// 然后模型还得再花一轮回合才真正调到工具。而绝大多数查询（「在浏览器里点一下」
/// 「看一眼数据库」「跑一下测试」）本地零毫秒就能给出同一个答案。
///
/// 判据刻意保守——宁可多走一次编排器，也不要给错工具：
///   · 至少命中一个**结构化维度**（工具名 / 触发条件 / 使用场景），
///     只在描述正文里出现过（desc / cjk）不算数，那是弱信号；
///   · 与第二名拉开至少 2 分，或者干脆只有一个命中——排名咬得很紧时说明查询本身有歧义，
///     那正是语义编排器存在的意义。
/// 拿不准一律返回 null 走原路。
export function _confidentFuzzyResolution(hits) {
  const fresh = (Array.isArray(hits) ? hits : []).filter((h) => h && !h.alreadyLoaded);
  if (!fresh.length) return null;
  const top = fresh[0];
  const strong = (top.matchedOn || []).some((m) => m === "name" || m === "trigger" || m === "use_case");
  if (!strong || !(top.score >= 3)) return null;
  const second = fresh[1];
  if (second && top.score - second.score < 2) return null;
  // 同分并列的一起带上（例如 browser 与 browser_batch），最多 3 个。
  return fresh.filter((h) => h.score === top.score).slice(0, 3);
}

// 模糊命中的展示后缀：在 compactToolGuide 基础行之外追加推荐场景/触发条件，
// 帮主模型建立工具↔场景关联（无元数据的工具自动省略，不加占位噪声）。
export function _toolMetaGuideSuffix(name) {
  const meta = TOOL_METADATA[name] || autoEnrichToolMetadata({ name }) || {};
  const parts = [];
  if (Array.isArray(meta.use_cases) && meta.use_cases.length) parts.push(`🎯推荐场景：${meta.use_cases.slice(0, 3).join("、")}`);
  if (Array.isArray(meta.triggers) && meta.triggers.length) parts.push(`🔍触发条件：${meta.triggers.slice(0, 2).join("、")}`);
  return parts.length ? `｜${parts.join("｜")}` : "";
}

export function _toolSchemaFromRegistry(registry, name) {
  if (!registry || !name) return null;
  const canonical = _canonicalToolName(name) || name;
  if (registry instanceof Map) return registry.get(name) || registry.get(canonical) || null;
  if (Array.isArray(registry)) {
    return registry.find((schema) => {
      const schemaName = schema?.function?.name;
      return schemaName === name || schemaName === canonical;
    }) || null;
  }
  return null;
}

/**
 * Sub-agent tool discovery, capability-filtered by the child's own sandbox.
 *
 * A child's toolset used to be frozen at dispatch for its entire 12–18-turn life; when it
 * guessed a tool name — the exact moment it signals which capability it needs — the loop
 * threw that signal away with a static [BLOCKED] and burned the turn. This searches the
 * registry with the same local matchers the main loop uses (exact, then fuzzy; no
 * orchestrator round-trip — a child's discovery must stay cheap and offline) and splits
 * hits into:
 *
 *   admitted — mapped type is inside the child's execTypes: safe to add to its payload.
 *   outside  — real capability, wrong sandbox (e.g. write tools for a read-only child,
 *              MCP for any child): named back to the model so its REPORT can ask the
 *              parent, instead of the child silently lacking it.
 *
 * Fails closed: unmappable names count as outside, any matcher error returns empty.
 */
export function _subAgentAdmitTools(query, { registry, loaded, execTypes, mapCall, max = 6 }) {
  const out = { admitted: [], outside: [] };
  let hits = [];
  try {
    const exact = _searchToolsExactQuery(query, registry);
    hits = exact
      ? _searchToolsLookup(query, registry, loaded)
      : _searchToolsFuzzyMatch(query, registry, loaded)
          .filter((h) => !h.alreadyLoaded).map((h) => h.schema);
  } catch { return out; }
  for (const schema of hits) {
    const name = schema?.function?.name;
    if (!name || loaded.has(name)) continue;
    let type = "";
    try { type = (mapCall(name, {}) || {}).type || ""; } catch { type = ""; }
    // Type alone is not authority. Two admitted-by-type escapes were real:
    //   deploy_site maps to type "cmd" — which every child has — but it publishes the
    //   workspace to a public HTTPS domain; a scope-bounded worker must never gain that
    //   from a discovery query.
    //   git_commit/git_push map to type "git" (read-listed for the op-gated read four),
    //   so admission wasted a turn on a schema the dispatcher's op gate then [BLOCKED],
    //   without ever telling the child to route the need to the parent.
    // Every strict-mutating tool a child is entitled to is already in its INITIAL
    // allowlist; one that is not loaded is by definition outside this sandbox.
    // MCP 不再整类拒绝，改成按**服务自己声明的只读性**判。
    //
    // 一刀切 `name.startsWith("mcp__")` 的代价是：子智能体被派去"调研 X 怎么用"，
    // 而用户为此专门装的文档类 MCP 服务它一个都够不着，只能把需求原样退回给父智能体
    // ——多一轮往返，还常常就地放弃、凭记忆答了。
    // 没声明 readOnlyHint 的仍然算 strict（落进 outside，由父智能体处理），这是对的：
    // 规范里这个提示是可选的，缺失时必须按"可能有副作用"处理。
    let _mcpReadOnly = false;
    if (name.startsWith("mcp__")) {
      try { _mcpReadOnly = !!(mapCall(name, {}) || {}).mcpReadOnly; } catch { _mcpReadOnly = false; }
    }
    const _strict = _STRICT_MUTATING_TOOL_NAMES.has(name) || (name.startsWith("mcp__") && !_mcpReadOnly);
    if (!_strict && type && execTypes.includes(type)) {
      if (out.admitted.length < max) out.admitted.push(schema);
    } else {
      out.outside.push(name);
    }
  }
  out.outside = out.outside.slice(0, 8);
  return out;
}
// 子体 search_tools 的卡片标签。三种结局在拼正文时已经判明（装上了 / 全在沙箱外 /
// 一个都没有），标签直接跟着同一个分支走，不需要新判据。
//
// 不给标签的代价是实打实的：_settleToolStep 在 label 为空时只能拿正文扫词判红绿，而
// 「已加载工具：…」「以下工具超出子任务沙箱」「没有匹配的工具」三条一个失败词都不含
// —— 三种相反的结局在卡片上全是绿色「完成」，排查"子体为什么没用 X 工具"时这张卡
// 一点区分度都没有。主循环的同一个工具早就按分支贴了标签，这条并行路径漏了。
export function _subAgentSearchToolsLabel(admitted, outside) {
  const _a = Array.isArray(admitted) ? admitted.length : 0;
  const _o = Array.isArray(outside) ? outside.length : 0;
  if (_a && _o) return `已加载 ${_a} · 沙箱外 ${_o}`;
  if (_a) return `已加载 ${_a}·子任务`;
  if (_o) return `沙箱外 ${_o} · 交回主任务`;
  return "无匹配";
}
