/**
 * Reads the IDE's real runtime tool catalog and writes public/tools.json.
 *
 * Evaluate `_buildAgentToolSchemas(true, [])` instead of scanning every schema
 * literal in main.js: retired helpers and the separately defined search_tools meta
 * schema are not part of the runtime catalog and must not leak into the gallery.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 目录字面量 2026-08-25 从 main.js 搬到了 src/agent/tool-catalog.js。
// 这里把两份拼起来读：函数名之类的抽取判据仍指向 main.js，而 141 条 schema 在另一边。
const SOURCE = resolve(here, "../../src/main.js");
const CATALOG_SOURCE = resolve(here, "../../src/agent/tool-catalog.js");
const OUT = resolve(here, "../public/tools.json");

const src = readFileSync(SOURCE, "utf8");
const srcCatalog = readFileSync(CATALOG_SOURCE, "utf8");

function skipString(source, index, quote) {
  for (index++; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === quote) return index;
  }
  return index;
}

function skipRegex(source, index) {
  let characterClass = false;
  for (index++; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === "[") characterClass = true;
    else if (source[index] === "]") characterClass = false;
    else if (source[index] === "/" && !characterClass) return index;
  }
  return index;
}

function skipTemplate(source, index) {
  for (index++; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === "`") return index;
    else if (source[index] === "$" && source[index + 1] === "{") {
      index += 2;
      let depth = 1;
      for (; index < source.length && depth > 0; index++) {
        const char = source[index];
        if (char === "\\") index++;
        else if (char === "'" || char === '"') index = skipString(source, index, char);
        else if (char === "`") index = skipTemplate(source, index);
        else if (char === "{") depth++;
        else if (char === "}") depth--;
      }
      index--;
    }
  }
  return index;
}

function isRegexPosition(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous--;
  if (previous < 0 || "=([,{;:!&|?+-*%<>~^".includes(source[previous])) return true;
  return /(?:^|[^\w$])(return|typeof|case|in|of|do|else|void|delete|instanceof|yield|await)$/.test(
    source.slice(Math.max(0, previous - 12), previous + 1),
  );
}

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`extract-tools: function ${name} not found in main.js.`);
  let index = src.indexOf("{", match.index);
  let depth = 0;
  for (; index < src.length; index++) {
    const char = src[index];
    const next = src[index + 1];
    if (char === "/" && next === "/") {
      index = src.indexOf("\n", index);
      if (index < 0) index = src.length;
    } else if (char === "/" && next === "*") {
      index = src.indexOf("*/", index + 2) + 1;
    } else if (char === "'" || char === '"') {
      index = skipString(src, index, char);
    } else if (char === "`") {
      index = skipTemplate(src, index);
    } else if (char === "/" && isRegexPosition(src, index)) {
      index = skipRegex(src, index);
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      return src.slice(match.index, index + 1);
    }
  }
  throw new Error(`extract-tools: unbalanced braces in ${name}.`);
}

// `_userCapabilities` returns the user's own declared tools/commands, read from their
// config files at runtime. The gallery documents the *product* catalog, so the right
// snapshot here is the empty one — and that is not an approximation: main.js itself
// evaluates `_buildAgentToolSchemas` once at module-evaluation time to build
// `_KNOWN_TOOLS`, and reads exactly this empty snapshot then, precisely because the
// static full set must not be widened or trimmed by whoever happens to be running the
// app. Returning it keeps the `user__`-prefixed entries and the per-user disabled list
// out of public/tools.json by construction rather than by filtering after the fact.
// `_withoutDisabledTools` is pulled in as its real source rather than stubbed: it reads
// the same snapshot, so an empty `disabled` list makes it a no-op on its own. Extracting
// it means a future change to how disabling works cannot silently diverge here.
const buildCatalog = new Function(
  "inTauri",
  "_applyCloudToolDescs",
  "_userCapabilities",
  // 目录字面量已搬到 src/agent/tool-catalog.js —— 整份拼进来（去掉 export，
  // 因为这里是 new Function 不是模块），组装逻辑仍从 main.js 抠。
  `${srcCatalog.replace(/^(\s*)export\s+/gm, "$1")}
   ${extractFunction("_withoutDisabledTools")}
   ${extractFunction("_applyUserRoleEnums")}
   ${extractFunction("_buildAgentToolSchemas")}
   ;return _buildAgentToolSchemas;`,
)(true, (tools) => tools, () => ({
  tools: [],
  commands: [],
  disabled: [],
  errors: [],
}));
const names = buildCatalog(true, [])
  .map((tool) => tool?.function?.name)
  .filter(Boolean);
if (names.length < 50) {
  throw new Error(`extract-tools: only found ${names.length} runtime tools.`);
}
if (new Set(names).size !== names.length) {
  throw new Error("extract-tools: runtime catalog contains duplicate tool names.");
}

/** Group by what the tool actually touches. Order matters: first match wins. */
const GROUPS = [
  // create_project 建的是一整个项目目录，属于文件操作。不列进来会掉进末尾那个
  // `?? "Knowledge"` 兜底桶——那个桶的语义是"没归到类的"，不是"知识类工具"。
  ["Office documents", /^office_(write|edit|read)$/],
  ["Files", /^(read_file|write_file|edit_file|multi_edit|list_dir|create_dir|create_project|copy_path|move_path|delete_path|format_file|read_logs|download_file)$/],
  // Searching YOUR repository, kept apart from the research lookups below.
  ["Code search", /^(search|find_files|semantic_search|find_symbol|search_tools|deep_search|sourcegraph_search)$/],
  ["Code intelligence", /^(lsp_|get_diagnostics|visual_explain)/],
  ["Git & GitHub", /^(git_|gh_|gitlab_|gitee_|codeberg_)/],
  ["Terminal & system", /^(run_cmd|run_in_terminal|read_terminal|list_terminals|stop_terminal|debug_control|system|worktree|docker_compose_up|background_monitor)$/],
  ["Agents", /^(run_subagent|await_subagent|spawn_multiple_agents|run_worker|research_project|generate_wiki|update_plan|ask_user|recall_conversation|remember)$/],
  ["Web & browser", /^(browser|web_fetch|web_search|http_request|screenshot|read_screen|ui_click|automation|computer|capture_|remote|start_demo|stop_demo)/],
  ["Design & media", /^(design_|learn_design|generate_(image|3d|sound|music|voice|motion|texture)|auto_rig|search_game_assets|download_asset|game_scaffold|web_scaffold|visual_compare|preview_choices|iconify_search|color_search)/],
  ["Data", /^(db_query|openapi_parser|performance_profile|live_environment|realtime_news_feed|current_time|local_discovery)/],
  ["Deploy", /^(deploy_site)$/],
  // Everything else ending in _search is a research lookup against a public corpus.
  ["Research", /_search$|^github_repo$|^github_trending$|^gitlab_repo$|^gitee_repo$|^codeberg_repo$/],
];

// Tools the app deliberately withholds from the browser build (see the desktopOnly
// set in _buildAgentToolSchemas). The gallery marks them so nobody is told a demo
// failed when the product is simply refusing to expose a desktop capability.
// 先剥注释，再按「引号里的标识符」抽。原来是整段按 ASCII 逗号 split——而那段源码里夹着
// 中文注释，注释里每一个半角逗号都会切一刀：`git_status` 正好被切在一句注释的尾巴上
// （"…照常发给模型。\n  "git_status"），于是它从集合里消失，官网工具画廊就不给它打
// 「桌面专属」标记，访客以为网页版能查 git 状态、进去发现没有。同一次还把两整段中文注释
// 当成"工具名"塞进了集合（无害，但说明这条路一直是靠运气对的）。
// 按标识符抽之后，逗号怎么放、注释怎么写都不影响。
const DESKTOP_ONLY = new Set(
  ((src.match(/const desktopOnly = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .match(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g) ?? [])
    .map((s) => s.replace(/^["']|["']$/g, "")),
);

const tools = names.map((name) => {
  const group = GROUPS.find(([, re]) => re.test(name))?.[0] ?? "Knowledge";
  return { name, group, desktopOnly: DESKTOP_ONLY.has(name) };
});

const payload = {
  generatedFrom: "ide/src/main.js · _buildAgentToolSchemas",
  generatedAt: null, // deliberately unset: a timestamp would churn the build output
  count: tools.length,
  groups: [...new Set(tools.map((t) => t.group))].sort(),
  tools,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
console.log(`extract-tools: ${tools.length} tools → public/tools.json`);
