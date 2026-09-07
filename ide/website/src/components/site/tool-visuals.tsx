import {
  AlertTriangle, ArrowRightLeft, Binary, Bot, Boxes, Brain, Bug, Clock, Cloud, Code2,
  Copy, Database, FileCode2, FileDiff, FilePlus2, FileSearch, FileText, FlaskConical,
  Folder, FolderPlus, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Globe,
  Image as ImageIcon, Languages, LayoutTemplate, ListChecks, ListTree, MessageCircleQuestion,
  Monitor, MousePointerClick, Move, Network, Package, Palette, Play, Radar, Rocket, Scale,
  ScanLine, Search, Server, Share2, Shield, SquareTerminal, Terminal, TestTube2, Trash2,
  Users, Wand2, Waypoints, Wifi, Wrench, type LucideIcon,
} from "lucide-react";

/*
 * 每个工具一套：图标 + 图标底色 + 动作词 + 参数 + 结果 + 真实产物。
 * "产物"沿用 IDE 里这些工具真正渲染的形态（统一 diff / 目录行 / 终端输出 /
 * 搜索命中 / 计划清单 / 嵌套子智能体卡 / 数据行），让人一眼看懂这工具干什么。
 */
export type Payload =
  | { kind: "diff"; lines: Array<[" " | "+" | "-", string]> }
  | { kind: "ls"; rows: Array<{ name: string; dir?: boolean }> }
  | { kind: "term"; cmd: string; out: string[]; code: number }
  | { kind: "hits"; rows: Array<{ file: string; line: number; text: string }> }
  | { kind: "plan"; steps: Array<{ text: string; done?: boolean; doing?: boolean }> }
  | { kind: "agents"; rows: Array<{ role: string; scope: string; result: string }> }
  | { kind: "rows"; rows: Array<[string, string]> }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "note"; text: string };

export type Visual = {
  icon: LucideIcon;
  tint: string;
  verb: string;
  arg: string;
  result: string;
  payload: Payload;
};

const T = {
  file: "#3a8fe0",
  write: "#46a64e",
  danger: "#d24b43",
  cmd: "#6e6e73",
  search: "#c98a3a",
  git: "#e0673b",
  agent: "#7c5cff",
  web: "#1fb6d4",
  design: "#a25cff",
  data: "#4b8bbe",
};

/** Ordered: first match wins, so specific names beat family prefixes. */
const RULES: Array<[RegExp, (name: string) => Visual]> = [
  [/^read_file$/, () => ({
    icon: FileCode2, tint: T.file, verb: "Read", arg: "src/utils/math.ts", result: "9 lines",
    payload: { kind: "code", lang: "ts", lines: [
      "export function clamp(value, min, max) {",
      "  return Math.min(Math.max(value, min), max);",
      "}",
      "export const TAU = Math.PI * 2;",
    ] },
  })],
  [/^(edit_file|multi_edit)$/, () => ({
    icon: FileDiff, tint: T.write, verb: "Edit", arg: "app/routers/invoices.py", result: "+4 −1",
    payload: { kind: "diff", lines: [
      [" ", "def void_invoice(invoice_id: str):"],
      ["-", "    _INVOICES.pop(invoice_id)"],
      ["+", "    if _INVOICES.pop(invoice_id, None) is None:"],
      ["+", "        raise HTTPException(404, \"no such invoice\")"],
      ["+", "    return {\"voided\": True}"],
    ] },
  })],
  [/^write_file$/, () => ({
    icon: FilePlus2, tint: T.write, verb: "Write", arg: "src/utils/lerp.ts", result: "+12",
    payload: { kind: "diff", lines: [
      ["+", "export function lerp(a: number, b: number, t: number) {"],
      ["+", "  return a + (b - a) * clamp(t, 0, 1);"],
      ["+", "}"],
    ] },
  })],
  [/^list_dir$/, () => ({
    icon: ListTree, tint: T.file, verb: "List", arg: "src/utils/", result: "1 dir · 3 files",
    payload: { kind: "ls", rows: [
      { name: "helpers/", dir: true }, { name: "dom.js" }, { name: "format.js" }, { name: "math.ts" },
    ] },
  })],
  [/^create_dir$/, () => ({
    icon: FolderPlus, tint: T.write, verb: "New folder", arg: "src/features/billing", result: "created",
    payload: { kind: "note", text: "Parent directories are created as needed." },
  })],
  [/^delete_path$/, () => ({
    icon: Trash2, tint: T.danger, verb: "Delete", arg: "build/cache/", result: "12 files",
    payload: { kind: "note", text: "Moved to trash — recoverable, never an unlinked hard delete." },
  })],
  [/^move_path$/, () => ({
    icon: Move, tint: T.file, verb: "Move", arg: "utils/ → lib/", result: "9 files",
    payload: { kind: "note", text: "Open tabs follow the file to its new path." },
  })],
  [/^copy_path$/, () => ({
    icon: Copy, tint: T.file, verb: "Copy", arg: "config.example.json", result: "1 file",
    payload: { kind: "note", text: "Copies recursively, refusing to overwrite silently." },
  })],
  [/^format_file$/, () => ({
    icon: Wand2, tint: T.write, verb: "Format", arg: "src/App.tsx", result: "reformatted",
    payload: { kind: "diff", lines: [["-", "const x  =  1"], ["+", "const x = 1;"]] },
  })],
  [/^read_logs$/, () => ({
    icon: FileText, tint: T.cmd, verb: "Logs", arg: "dev-server", result: "420 lines",
    payload: { kind: "term", cmd: "tail -f dev-server.log", out: ["ready in 412 ms", "hmr update /src/App.tsx"], code: 0 },
  })],

  [/^search$/, () => ({
    icon: Search, tint: T.search, verb: "Search", arg: '"greet("', result: "3 hits",
    payload: { kind: "hits", rows: [
      { file: "src/main.js", line: 4, text: 'mount(document.body, greet("world"));' },
      { file: "src/utils/format.js", line: 1, text: "export function greet(name) {" },
      { file: "tests/format.test.js", line: 7, text: 'expect(greet("")).toBe("Hello, world!");' },
    ] },
  })],
  [/^find_files$/, () => ({
    icon: FileSearch, tint: T.search, verb: "Find files", arg: "**/*.test.ts", result: "4 files",
    payload: { kind: "ls", rows: [
      { name: "tests/clamp.test.ts" }, { name: "tests/format.test.ts" },
      { name: "tests/router.test.ts" }, { name: "tests/store.test.ts" },
    ] },
  })],
  [/^semantic_search$/, () => ({
    icon: Radar, tint: T.search, verb: "Semantic search", arg: '"where is auth handled"', result: "3 passages",
    payload: { kind: "hits", rows: [
      { file: "app/routers/webhooks.py", line: 18, text: "verify the signature before trusting the body" },
      { file: "app/deps.py", line: 9, text: "current_user() resolves the bearer token" },
      { file: "README.md", line: 42, text: "Auth is delegated to the gateway." },
    ] },
  })],
  [/^find_symbol$/, () => ({
    icon: Binary, tint: T.search, verb: "Find symbol", arg: "InvoiceRouter", result: "1 definition",
    payload: { kind: "hits", rows: [{ file: "app/routers/invoices.py", line: 7, text: "router = APIRouter()" }] },
  })],
  [/^search_tools$/, () => ({
    icon: Wrench, tint: T.search, verb: "Find tools", arg: '"database"', result: "3 tools",
    payload: { kind: "rows", rows: [["db_query", "run SQL"], ["openapi_parser", "read a schema"], ["docker_compose_up", "start services"]] },
  })],
  [/^deep_search$/, () => ({
    icon: Radar, tint: T.search, verb: "Deep search", arg: "cross-repo", result: "7 sources",
    payload: { kind: "note", text: "Runs several search strategies and merges what they agree on." },
  })],

  [/^lsp_definition$/, () => ({
    icon: Waypoints, tint: T.file, verb: "Go to definition", arg: "clamp", result: "math.ts:5",
    payload: { kind: "hits", rows: [{ file: "src/utils/math.ts", line: 5, text: "export function clamp(value, min, max) {" }] },
  })],
  [/^lsp_references$/, () => ({
    icon: Share2, tint: T.file, verb: "Find references", arg: "greet", result: "5 call sites",
    payload: { kind: "hits", rows: [
      { file: "src/main.js", line: 4, text: 'greet("world")' },
      { file: "components/Card.js", line: 6, text: "greet(title)" },
      { file: "tests/format.test.js", line: 7, text: 'greet("")' },
    ] },
  })],
  [/^lsp_symbols$/, () => ({
    icon: ListTree, tint: T.file, verb: "Symbols", arg: "app/models.py", result: "2 classes",
    payload: { kind: "rows", rows: [["class LineItem", "line 6"], ["class Invoice", "line 13"]] },
  })],
  [/^get_diagnostics$/, () => ({
    icon: AlertTriangle, tint: T.search, verb: "Diagnostics", arg: "workspace", result: "0 errors · 1 warning",
    payload: { kind: "hits", rows: [{ file: "src/main.js", line: 530, text: "TS6133: 'reply' is declared but never read" }] },
  })],
  [/^generate_test_cases$/, () => ({
    icon: TestTube2, tint: T.write, verb: "Test cases", arg: "clamp()", result: "4 cases",
    payload: { kind: "rows", rows: [["min > max", "raises RangeError"], ["below min", "returns min"], ["above max", "returns max"], ["inside", "returns value"]] },
  })],
  [/^visual_explain$/, () => ({
    icon: LayoutTemplate, tint: T.design, verb: "Visual explainer", arg: "request lifecycle", result: "4 panels",
    payload: { kind: "note", text: "Draws the flow as panels instead of describing it in prose." },
  })],

  [/^git_diff$/, () => ({
    icon: FileDiff, tint: T.git, verb: "Diff", arg: "src/utils/format.js", result: "+1 −1",
    payload: { kind: "diff", lines: [
      ["-", "export function greet(name) {"],
      ["+", "export function salutation(name) {"],
      [" ", "  return `Hello, ${name}!`;"],
    ] },
  })],
  [/^git_status$/, () => ({
    icon: GitBranch, tint: T.git, verb: "Status", arg: "main", result: "3 changed",
    payload: { kind: "rows", rows: [["M  src/utils/format.js", "staged"], [" M README.md", "unstaged"], ["?? components/Card.js", "untracked"]] },
  })],
  [/^git_commit$/, () => ({
    icon: GitCommitHorizontal, tint: T.git, verb: "Commit", arg: "main", result: "5 files",
    payload: { kind: "term", cmd: "git commit", out: ["refactor(utils): rename greet() to salutation()", "5 files changed, 12 insertions(+), 12 deletions(-)"], code: 0 },
  })],
  [/^git_log$/, () => ({
    icon: Clock, tint: T.git, verb: "Log", arg: "last 3", result: "3 commits",
    payload: { kind: "rows", rows: [["a91f2c4", "fix(utils): guard clamp bounds"], ["7d3e881", "feat(api): void invoice"], ["1c02fa9", "chore: pin deps"]] },
  })],
  [/^git_conflicts$/, () => ({
    icon: GitMerge, tint: T.danger, verb: "Conflicts", arg: "format.js", result: "1 file",
    payload: { kind: "diff", lines: [["-", "<<<<<<< HEAD"], [" ", "  return `Hello, ${who}!`;"], ["-", ">>>>>>> feature/greeting"]] },
  })],
  [/^git_/, (n) => ({
    icon: GitBranch, tint: T.git, verb: "Git", arg: n.replace("git_", "").replace(/_/g, " "), result: "ok",
    payload: { kind: "note", text: "Runs against your real repository, not a copy." },
  })],
  [/^gh_pr_create$/, () => ({
    icon: GitPullRequest, tint: T.git, verb: "Open PR", arg: "fix/clamp-bounds", result: "#412",
    payload: { kind: "rows", rows: [["title", "fix(utils): guard clamp bounds"], ["base", "main"], ["checks", "queued"]] },
  })],
  [/^gh_/, (n) => ({
    icon: GitPullRequest, tint: T.git, verb: "GitHub", arg: n.replace("gh_", "").replace(/_/g, " "), result: "ok",
    payload: { kind: "note", text: "Talks to GitHub through your own credentials." },
  })],

  [/^(run_cmd|run_in_terminal)$/, () => ({
    icon: Play, tint: T.cmd, verb: "Run", arg: "pytest -q", result: "exit 0",
    payload: { kind: "term", cmd: "pytest -q", out: ["........................", "24 passed in 0.61s"], code: 0 },
  })],
  [/^read_terminal$/, () => ({
    icon: Terminal, tint: T.cmd, verb: "Read terminal", arg: "Terminal 1", result: "40 lines",
    payload: { kind: "term", cmd: "npm run dev", out: ["VITE ready in 412 ms", "Local: http://localhost:5173/"], code: 0 },
  })],
  [/^(list_terminals|stop_terminal)$/, (n) => ({
    icon: SquareTerminal, tint: T.cmd, verb: n === "stop_terminal" ? "Stop terminal" : "Terminals", arg: "Terminal 1", result: "ok",
    payload: { kind: "rows", rows: [["Terminal 1", "npm run dev"], ["Terminal 2", "pytest -q"]] },
  })],
  [/^worktree$/, () => ({
    icon: GitMerge, tint: T.git, verb: "Worktree", arg: "migrate/rename", result: "created",
    payload: { kind: "note", text: "A long migration runs in its own tree, leaving your branch alone." },
  })],
  [/^docker_compose_up$/, () => ({
    icon: Boxes, tint: T.cmd, verb: "Compose", arg: "docker-compose.yml", result: "3 services",
    payload: { kind: "term", cmd: "docker compose up -d", out: ["✔ db      started", "✔ api     started", "✔ worker  started"], code: 0 },
  })],
  [/^system$/, () => ({
    icon: Monitor, tint: T.cmd, verb: "System", arg: "volume, display", result: "ok",
    payload: { kind: "note", text: "Desktop-only, and always through an explicit permission." },
  })],
  [/^background_monitor$/, () => ({
    icon: Wifi, tint: T.cmd, verb: "Monitor", arg: "build output", result: "watching",
    payload: { kind: "note", text: "Keeps watching a long job and reports back when it changes." },
  })],

  [/^update_plan$/, () => ({
    icon: ListChecks, tint: T.agent, verb: "Plan", arg: "3 steps", result: "2/3 done",
    payload: { kind: "plan", steps: [
      { text: "Read src/utils/math.ts", done: true },
      { text: "Guard the inverted range", done: true },
      { text: "Re-run the suite", doing: true },
    ] },
  })],
  [/^run_subagent$/, () => ({
    icon: Bot, tint: T.agent, verb: "Subagent", arg: "Explore the codebase", result: "4 steps",
    payload: { kind: "agents", rows: [{ role: "research", scope: "whole project", result: "map ready" }] },
  })],
  [/^spawn_multiple_agents$/, () => ({
    icon: Users, tint: T.agent, verb: "Subagents", arg: "3 in parallel", result: "3 settled",
    payload: { kind: "agents", rows: [
      { role: "architect", scope: "src/", result: "2 steps" },
      { role: "security", scope: "app/", result: "2 steps" },
      { role: "test", scope: "tests/", result: "2 steps" },
    ] },
  })],
  [/^await_subagent$/, () => ({
    icon: Users, tint: T.agent, verb: "Await subagents", arg: "all", result: "3 jobs settled",
    payload: { kind: "note", text: "Blocks until every background agent has reported." },
  })],
  [/^run_worker$/, () => ({
    icon: Bot, tint: T.agent, verb: "Worker", arg: "scope: src/utils", result: "3 files",
    payload: { kind: "agents", rows: [
      { role: "backend", scope: "src/utils", result: "3 files" },
      { role: "frontend", scope: "components", result: "2 files" },
    ] },
  })],
  [/^debate$/, () => ({
    icon: Scale, tint: T.agent, verb: "Debate", arg: "3 perspectives", result: "verdict",
    payload: { kind: "rows", rows: [["for", "ship behind a flag"], ["against", "migration is unbounded"], ["verdict", "flag it, then migrate"]] },
  })],
  [/^research_project$/, () => ({
    icon: Brain, tint: T.agent, verb: "Explore the codebase", arg: "whole project", result: "map ready",
    payload: { kind: "rows", rows: [["entry", "src/main.js"], ["modules", "utils, components"], ["toolchain", "Vite only"]] },
  })],
  [/^generate_wiki$/, () => ({
    icon: FileText, tint: T.agent, verb: "Wiki", arg: "PRODUCT_WIKI.md", result: "written",
    payload: { kind: "note", text: "Reads the source and writes a structured product wiki into the repo." },
  })],
  [/^ask_user$/, () => ({
    icon: MessageCircleQuestion, tint: T.agent, verb: "Needs your input", arg: "pick a direction", result: "awaiting",
    payload: { kind: "rows", rows: [["1", "keep the current API"], ["2", "break it and migrate callers"]] },
  })],
  [/^(remember|recall_conversation)$/, (n) => ({
    icon: Brain, tint: T.agent, verb: n === "remember" ? "Remember" : "Recall", arg: "project memory", result: "3 notes",
    payload: { kind: "rows", rows: [["convention", "no build step for extensions"], ["gotcha", "format.js has conflict markers"]] },
  })],

  [/^web_search$/, () => ({
    icon: Globe, tint: T.web, verb: "Web search", arg: '"fastapi background tasks"', result: "3 results",
    payload: { kind: "rows", rows: [["fastapi.tiangolo.com", "Background Tasks"], ["stackoverflow.com", "when not to use them"], ["github.com", "example repo"]] },
  })],
  [/^web_fetch$/, () => ({
    icon: Globe, tint: T.web, verb: "Fetch", arg: "fastapi.tiangolo.com", result: "12 kB",
    payload: { kind: "note", text: "Fetches the page and hands back readable text, not raw markup." },
  })],
  [/^http_request$/, () => ({
    icon: Server, tint: T.web, verb: "HTTP", arg: "GET /healthz", result: "200",
    payload: { kind: "rows", rows: [["status", "200 OK"], ["body", '{"status":"ok"}'], ["time", "38 ms"]] },
  })],
  [/^browser$/, () => ({
    icon: Monitor, tint: T.web, verb: "Browser", arg: "localhost:5173", result: "loaded",
    payload: { kind: "note", text: "Drives a real browser: navigate, click, read the page back." },
  })],
  [/^screenshot$/, () => ({
    icon: ImageIcon, tint: T.web, verb: "Screenshot", arg: "viewport", result: "1 image",
    payload: { kind: "note", text: "The image goes back into the conversation as something it can read." },
  })],
  [/^(read_screen|ui_click|automation)$/, (n) => ({
    icon: MousePointerClick, tint: T.web, verb: n === "read_screen" ? "Read screen" : n === "ui_click" ? "Click element" : "Automation",
    arg: "desktop", result: "ok",
    payload: { kind: "note", text: "Desktop-only, and gated behind an explicit grant." },
  })],
  [/^capture_/, (n) => ({
    icon: ScanLine, tint: T.web, verb: "Capture", arg: n.replace("capture_", ""), result: "ok",
    payload: { kind: "note", text: "Records real traffic so a failing request can be replayed." },
  })],
  [/^remote$/, () => ({
    icon: Network, tint: T.web, verb: "Remote", arg: "ssh build-box", result: "connected",
    payload: { kind: "note", text: "Work on another machine without leaving the window." },
  })],
  [/^(start_demo|stop_demo)$/, (n) => ({
    icon: Play, tint: T.web, verb: n === "start_demo" ? "Record demo" : "Stop recording", arg: "screen", result: "ok",
    payload: { kind: "note", text: "Records what it does as a walkthrough you can hand to someone." },
  })],
  [/^deploy_site$/, () => ({
    icon: Rocket, tint: T.write, verb: "Deploy", arg: "aurora-site", result: "live",
    payload: { kind: "term", cmd: "deploy aurora-site", out: ["uploaded 42 files", "https://aurora.michaelide.xyz"], code: 0 },
  })],

  [/^db_query$/, () => ({
    icon: Database, tint: T.data, verb: "Database", arg: "SELECT … FROM invoices", result: "3 rows",
    payload: { kind: "rows", rows: [["inv_00041", "£76.00"], ["inv_00042", "£19.00"], ["inv_00043", "£240.00"]] },
  })],
  [/^openapi_parser$/, () => ({
    icon: Code2, tint: T.data, verb: "OpenAPI", arg: "openapi.json", result: "18 routes",
    payload: { kind: "rows", rows: [["POST /invoices", "create"], ["GET /invoices/{id}", "read"], ["DELETE /invoices/{id}", "void"]] },
  })],
  [/^performance_profile$/, () => ({
    icon: Radar, tint: T.data, verb: "Profile", arg: "startup", result: "412 ms",
    payload: { kind: "rows", rows: [["parse", "88 ms"], ["mount", "214 ms"], ["first paint", "412 ms"]] },
  })],
  [/^current_time$/, () => ({
    icon: Clock, tint: T.data, verb: "Current time", arg: "Asia/Shanghai", result: "ok",
    payload: { kind: "note", text: "Real clock, so dates in generated code are never invented." },
  })],
  [/^(design_board|design_research|learn_design)$/, (n) => ({
    icon: Palette, tint: T.design, verb: n === "learn_design" ? "Learn design system" : "Design", arg: "3 directions", result: "ready",
    payload: { kind: "rows", rows: [["A", "editorial, high contrast"], ["B", "soft, rounded"], ["C", "dense, technical"]] },
  })],
  [/^generate_image$/, () => ({
    icon: ImageIcon, tint: T.design, verb: "Generate image", arg: "hero illustration", result: "1 image",
    payload: { kind: "note", text: "For brand art the repository does not already have." },
  })],
  [/^visual_compare$/, () => ({
    icon: ArrowRightLeft, tint: T.design, verb: "Visual compare", arg: "before / after", result: "2 diffs",
    payload: { kind: "note", text: "Compares two screenshots and points at what actually moved." },
  })],
  [/^preview_choices$/, () => ({
    icon: LayoutTemplate, tint: T.design, verb: "Preview options", arg: "3 variants", result: "pick one",
    payload: { kind: "rows", rows: [["variant 1", "sandboxed iframe"], ["variant 2", "sandboxed iframe"], ["variant 3", "sandboxed iframe"]] },
  })],
  [/^cve_search$/, () => ({
    icon: Shield, tint: T.search, verb: "CVE lookup", arg: "fastapi 0.115.0", result: "0 advisories",
    payload: { kind: "note", text: "Checks a dependency before you take it, not after." },
  })],
  [/^package_search$/, () => ({
    icon: Package, tint: T.search, verb: "Package", arg: "pydantic", result: "2.9.0",
    payload: { kind: "rows", rows: [["latest", "2.9.0"], ["licence", "MIT"], ["weekly downloads", "94M"]] },
  })],
  [/^knowledge_search$/, () => ({
    icon: Brain, tint: T.search, verb: "Knowledge search", arg: "internal corpus", result: "5 passages",
    payload: { kind: "note", text: "Searches your own curated knowledge base, not the open web." },
  })],
  [/_search$/, (n) => ({
    icon: FlaskConical, tint: T.search, verb: "Research", arg: n.replace(/_search$/, "").replace(/_/g, " "), result: "results",
    payload: { kind: "note", text: "One of the research sources the agent can cite from." },
  })],
  [/^(github_repo|gitlab_repo|gitee_repo|codeberg_repo|github_trending)$/, (n) => ({
    icon: GitBranch, tint: T.git, verb: "Repository", arg: n.replace(/_/g, " "), result: "ok",
    payload: { kind: "note", text: "Reads a public repository without cloning it first." },
  })],
  [/^(live_|road_environment|track_shipment|shop_catalog|realtime_news_feed|local_discovery)/, (n) => ({
    icon: Cloud, tint: T.data, verb: "Live data", arg: n.replace(/_/g, " "), result: "fresh",
    payload: { kind: "note", text: "Fetches something that changes, so the answer is current." },
  })],
  [/^(download_file|download_asset)$/, () => ({
    icon: Package, tint: T.web, verb: "Download", arg: "asset", result: "saved",
    payload: { kind: "note", text: "Saves into the workspace, never outside it." },
  })],
  [/^(generate_|auto_rig)/, (n) => ({
    icon: Wand2, tint: T.design, verb: "Generate", arg: n.replace("generate_", "").replace(/_/g, " "), result: "ready",
    payload: { kind: "note", text: "Produces an asset the project needs and drops it in place." },
  })],
  [/^(game_scaffold|web_scaffold)$/, (n) => ({
    icon: LayoutTemplate, tint: T.write, verb: "Scaffold", arg: n.replace("_scaffold", ""), result: "22 files",
    payload: { kind: "note", text: "Starts a project from the house standard, not a blank folder." },
  })],
  [/^bug/, () => ({
    icon: Bug, tint: T.danger, verb: "Debug", arg: "session", result: "ok",
    payload: { kind: "note", text: "Breakpoints, stepping and variables over DAP." },
  })],
  [/^(i18n|translate|languages)/, () => ({
    icon: Languages, tint: T.data, verb: "Localise", arg: "strings", result: "ok",
    payload: { kind: "note", text: "Keeps the interface honest in every language it ships." },
  })],
];

const FALLBACK: Visual = {
  icon: Wrench, tint: T.cmd, verb: "Tool", arg: "", result: "ok",
  payload: { kind: "note", text: "Runs as an ordinary tool call and reports back with evidence." },
};

export function visualFor(name: string): Visual {
  for (const [re, make] of RULES) {
    if (re.test(name)) return make(name);
  }
  return { ...FALLBACK, arg: name.replace(/_/g, " ") };
}

export { Folder };
