// 弱模型工具名归一化：别名表 + 编辑距离。
//
// 两块都是**纯数据/纯函数**，零依赖，所以从 main.js 搬到这里（尺寸闸撞线时先搬模块，
// 不抬线）。留在 main.js 的是 _canonicalToolName 本身——它要读 _KNOWN_TOOLS，而那个
// 是从 _buildAgentToolSchemas 现算出来的，跟不过来。
//
// 名字一个字没改（仍是 _TOOL_ALIASES / _lev）：test/helpers/source.mjs 会把 main.js 和
// src/agent/*.js 拼成一份文本供源码断言用，改名会让一批按名字断言的用例以「这段代码
// 不见了」的形式假红。

export const _TOOL_ALIASES = {
  readfile: "read_file", read: "read_file", cat: "read_file", openfile: "read_file", open: "read_file", view: "read_file", viewfile: "read_file", get_file: "read_file", show_file: "read_file", read_text: "read_file",
  writefile: "write_file", write: "write_file", create_file: "write_file", createfile: "write_file", save_file: "write_file", savefile: "write_file", newfile: "write_file", put_file: "write_file", write_to_file: "write_file",
  editfile: "edit_file", edit: "edit_file", str_replace: "edit_file", str_replace_editor: "edit_file", str_replace_based_edit_tool: "edit_file", replace: "edit_file", replace_in_file: "edit_file", apply_patch: "edit_file", applypatch: "edit_file", patch: "edit_file", search_replace: "edit_file",
  multiedit: "multi_edit", edit_multiple: "multi_edit", multi_replace: "multi_edit",
  listdir: "list_dir", ls: "list_dir", list: "list_dir", dir: "list_dir", list_directory: "list_dir", listdirectory: "list_dir", readdir: "list_dir", list_files: "list_dir",
  grep: "search", ripgrep: "search", rg: "search", search_files: "search", searchfiles: "search", search_text: "search", search_code: "search", findtext: "search", find_in_files: "search", codebase_search: "search", grep_search: "search",
  glob: "find_files", findfiles: "find_files", find: "find_files", find_file: "find_files", fileglob: "find_files", file_search: "find_files", glob_file_search: "find_files",
  bash: "run_cmd", shell: "run_cmd", sh: "run_cmd", exec: "run_cmd", execute: "run_cmd", run: "run_cmd", runcommand: "run_cmd", run_command: "run_cmd", terminal: "run_cmd", cmd: "run_cmd", command: "run_cmd", execute_command: "run_cmd", run_shell: "run_cmd", run_shell_command: "run_cmd", shell_exec: "run_cmd", shell_command: "run_cmd",
  runinterminal: "run_in_terminal", run_background: "run_in_terminal",
  webfetch: "web_fetch", fetch: "web_fetch", fetch_url: "web_fetch", curl: "web_fetch", http_get: "web_fetch", get_url: "web_fetch", read_url: "web_fetch", open_url: "web_fetch", visit: "web_fetch",
  websearch: "web_search", search_web: "web_search", google: "web_search", searchweb: "web_search", internet_search: "web_search", web_query: "web_search",
  localdiscovery: "local_discovery", nearby: "local_discovery", nearby_search: "local_discovery", places: "local_discovery", place_search: "local_discovery",
  liveenvironment: "live_environment", environment_data: "live_environment", weather_data: "live_environment", air_quality: "live_environment", earthquake_data: "live_environment", hazard_data: "live_environment",
  readscreen: "read_screen", inspect_screen: "read_screen", accessibility_tree: "read_screen",
  uiclick: "ui_click", ax_click: "ui_click", accessibility_click: "ui_click",
  runsubagent: "run_subagent", subagent: "run_subagent",
  spawnagents: "spawn_multiple_agents", spawnmultipleagents: "spawn_multiple_agents", spawn_agents: "spawn_multiple_agents",
  awaitsubagent: "await_subagent", wait_subagent: "await_subagent", waitsubagent: "await_subagent",
  runworker: "run_worker",
  updateplan: "update_plan", plan: "update_plan", todo: "update_plan", todowrite: "update_plan", todo_write: "update_plan", set_plan: "update_plan", write_todos: "update_plan",
  loadguide: "load_guide", get_guide: "load_guide", read_guide: "load_guide", fetch_guide: "load_guide", guide: "load_guide",
  readskill: "read_skill", skill: "read_skill", load_skill: "read_skill", use_skill: "read_skill", get_skill: "read_skill", open_skill: "read_skill",
  getdiagnostics: "get_diagnostics", diagnostics: "get_diagnostics", diag: "get_diagnostics", lint: "get_diagnostics", check_errors: "get_diagnostics", get_errors: "get_diagnostics", problems: "get_diagnostics",
  generateimage: "generate_image", genimage: "generate_image", gen_image: "generate_image", image_gen: "generate_image", create_image: "generate_image", make_image: "generate_image", draw_image: "generate_image", text_to_image: "generate_image",
  designboard: "design_board", design_grid: "design_board", show_designs: "design_board", show_design_board: "design_board", design_variants: "design_board", image_grid: "design_board",
  dbquery: "db_query", querydb: "db_query", query_db: "db_query", sql: "db_query", run_sql: "db_query", execute_sql: "db_query", sql_query: "db_query",
  deletepath: "delete_path", delete: "delete_path", rm: "delete_path", remove: "delete_path", delete_file: "delete_path", removefile: "delete_path", remove_file: "delete_path", unlink: "delete_path",
  movepath: "move_path", move: "move_path", mv: "move_path", rename: "move_path", rename_file: "move_path", move_file: "move_path",
  copypath: "copy_path", copy: "copy_path", cp: "copy_path", copy_file: "copy_path",
  createdir: "create_dir", mkdir: "create_dir", makedir: "create_dir", make_directory: "create_dir", create_directory: "create_dir", create_folder: "create_dir", makedirs: "create_dir",
  officewrite: "office_write", write_excel: "office_write", create_excel: "office_write", excel_write: "office_write", write_xlsx: "office_write", create_xlsx: "office_write", create_spreadsheet: "office_write", write_docx: "office_write", create_docx: "office_write", write_word: "office_write", create_word: "office_write", write_pptx: "office_write", create_pptx: "office_write", create_ppt: "office_write", write_ppt: "office_write", create_presentation: "office_write", generate_excel: "office_write", generate_docx: "office_write", generate_pptx: "office_write",
  officeedit: "office_edit", edit_excel: "office_edit", edit_xlsx: "office_edit", edit_docx: "office_edit", edit_word: "office_edit", edit_pptx: "office_edit", edit_ppt: "office_edit", update_excel: "office_edit", update_xlsx: "office_edit",
  officeread: "office_read", read_excel: "office_read", read_xlsx: "office_read", read_docx: "office_read", read_word: "office_read", read_pptx: "office_read", read_ppt: "office_read", read_spreadsheet: "office_read",
  downloadfile: "download_file", download: "download_file", wget: "download_file", fetch_file: "download_file", save_url: "download_file",
  formatfile: "format_file", format: "format_file", prettier: "format_file", format_code: "format_file",
  rememberthis: "remember", memorize: "remember", save_memory: "remember", note: "remember", remember_note: "remember", add_memory: "remember",
  recall: "recall_conversation", recall_memory: "recall_conversation", search_memory: "recall_conversation", search_conversation: "recall_conversation", search_history: "recall_conversation", conversation_search: "recall_conversation", recall_history: "recall_conversation",
  takescreenshot: "screenshot", take_screenshot: "screenshot", snapshot: "screenshot", screen_shot: "screenshot", capture_screen: "screenshot",
  httprequest: "http_request", http: "http_request", request: "http_request", api_call: "http_request", api_request: "http_request",
  figma_tokens: "figma", figma_design: "figma", figma_inspect: "figma", figma_get: "figma", figma_variables: "figma", figma_image: "figma", figma_export: "figma", figma_to_code: "figma", get_figma: "figma", figma_read: "figma", figma_layout: "figma", figma_theme: "figma", figma_colors: "figma", figjam: "figma",
  decodeqr: "decode_qr", scan_qr: "decode_qr", scanqr: "decode_qr", read_qr: "decode_qr", qr_decode: "decode_qr", qrcode: "decode_qr", qr: "decode_qr",
  remote_connect: "remote", connect_remote: "remote", remote_dev: "remote", remotedev: "remote",
  app: "system", launch_app: "system", open_app: "system", activate_app: "system", switch_app: "system", app_control: "system", system_control: "system", click_menu: "system", app_menu: "system",
  schedule: "schedule", schedule_task: "schedule", cron: "schedule", set_timer: "schedule", remind: "schedule",
  ask_user: "ask_user", task_user: "ask_user", askuser: "ask_user", clarify: "ask_user", ask_question: "ask_user", confirm_intent: "ask_user", ask_choice: "ask_user", request_input: "ask_user",
  research_project: "research_project", explore_codebase: "research_project", explore_project: "research_project", map_project: "research_project", understand_codebase: "research_project", study_project: "research_project", deep_research_codebase: "research_project",
  learn_design: "learn_design", design_learn: "learn_design", learn_style: "learn_design", study_design: "learn_design", refero: "learn_design",
  design_research: "design_research", research_design: "design_research", ui_research: "design_research", plan_ui: "design_research", design_plan: "design_research", ui_architecture: "design_research", plan_design: "design_research",
  previewchoices: "preview_choices", show_choices: "preview_choices", showchoices: "preview_choices", preview_options: "preview_choices", show_options: "preview_choices", preview_variants: "preview_choices", preview_animation: "preview_choices", preview_effect: "preview_choices", preview_style: "preview_choices", preview_component: "preview_choices", compare_styles: "preview_choices", style_picker: "preview_choices", animation_picker: "preview_choices", pick_style: "preview_choices", choose_style: "preview_choices", show_preview: "preview_choices", live_preview: "preview_choices",
  visualexplain: "visual_explain", explain_visual: "visual_explain", comic_explain: "visual_explain", visual_comic: "visual_explain", explain_concept: "visual_explain", teach_visual: "visual_explain", show_explain: "visual_explain", animated_explain: "visual_explain", explainer: "visual_explain", comic: "visual_explain",
  // LSP aliases — every model phrases these differently.
  lspsymbols: "lsp_symbols", symbols: "lsp_symbols", get_symbols: "lsp_symbols", outline: "lsp_symbols", list_symbols: "lsp_symbols", file_outline: "lsp_symbols", file_symbols: "lsp_symbols",
  findsymbol: "find_symbol", find_function: "find_symbol", find_class: "find_symbol", locate_symbol: "find_symbol", where_is: "find_symbol", lookup_symbol: "find_symbol", project_symbols: "find_symbol", workspace_symbols: "find_symbol",
  semanticsearch: "semantic_search", semsearch: "semantic_search", semantic: "semantic_search", concept_search: "semantic_search", natural_search: "semantic_search", smart_search: "semantic_search", code_search: "semantic_search", find_code: "semantic_search", find_related: "semantic_search",
  knowledgesearch: "knowledge_search", knowledge: "knowledge_search", kb_search: "knowledge_search", search_knowledge: "knowledge_search", best_practice: "knowledge_search", best_practices: "knowledge_search", lookup_knowledge: "knowledge_search", domain_knowledge: "knowledge_search", how_to: "knowledge_search", how_should_i: "knowledge_search",
  lspdefinition: "lsp_definition", goto_definition: "lsp_definition", go_to_definition: "lsp_definition", definition: "lsp_definition", find_definition: "lsp_definition", jump_to_definition: "lsp_definition",
  lspreferences: "lsp_references", references: "lsp_references", find_references: "lsp_references", find_usages: "lsp_references", usages: "lsp_references", who_uses: "lsp_references",
  // Common LLM typos / plural variants.
  read_files: "read_file", readfilescontent: "read_file", readtextfile: "read_file", openfilecontent: "read_file",
  writefiles: "write_file", create_files: "write_file",
  editfiles: "edit_file", apply_edits: "edit_file", make_edit: "edit_file",
  list_dirs: "list_dir", listdirs: "list_dir", ls_dir: "list_dir",
  // Git tool variants — model often writes git_xxx vs gitXxx.
  gitstatus: "git_status", status: "git_status", gitst: "git_status",
  gitdiff: "git_diff", diff: "git_diff",
  gitlog: "git_log", log: "git_log", commits: "git_log", commit_log: "git_log",
  gitblame: "git_blame", blame: "git_blame", who_changed: "git_blame",
  gitstashlist: "git_stash_list", stash_list: "git_stash_list", stashes: "git_stash_list",
  gitconflicts: "git_conflicts", conflicts: "git_conflicts", merge_conflicts: "git_conflicts",
  gitclone: "git_clone", clone_repo: "git_clone", clone_repository: "git_clone",
  // GitHub / PR / CI aliases.
  ghprcreate: "gh_pr_create", pr_create: "gh_pr_create", create_pr: "gh_pr_create", open_pr: "gh_pr_create", openpr: "gh_pr_create", new_pr: "gh_pr_create", make_pr: "gh_pr_create", github_pr_create: "gh_pr_create", pull_request_create: "gh_pr_create",
  ghprview: "gh_pr_view", pr_view: "gh_pr_view", view_pr: "gh_pr_view", show_pr: "gh_pr_view", get_pr: "gh_pr_view", pr_info: "gh_pr_view", pr_details: "gh_pr_view",
  ghprchecks: "gh_pr_checks", pr_checks: "gh_pr_checks", pr_status: "gh_pr_checks", ci_status: "gh_pr_checks", check_ci: "gh_pr_checks", actions_status: "gh_pr_checks",
  ghactionslog: "gh_actions_log", actions_log: "gh_actions_log", ci_log: "gh_actions_log", actions_logs: "gh_actions_log", workflow_log: "gh_actions_log", read_ci: "gh_actions_log",
  ghprreviewcomments: "gh_pr_review_comments", pr_review_comments: "gh_pr_review_comments", review_comments: "gh_pr_review_comments", read_reviews: "gh_pr_review_comments", get_reviews: "gh_pr_review_comments",
  ghprreply: "gh_pr_reply", pr_reply: "gh_pr_reply", pr_comment: "gh_pr_reply", comment_pr: "gh_pr_reply", reply_pr: "gh_pr_reply",
  // Terminal-task tool variants.
  runinterminal_alias: "run_in_terminal", run_terminal: "run_in_terminal", start_task: "run_in_terminal", spawn_terminal: "run_in_terminal", background_run: "run_in_terminal",
  readterminal: "read_terminal", get_terminal_output: "read_terminal", tail_terminal: "read_terminal",
  readlogs: "read_logs", read_log: "read_logs", get_logs: "read_logs", tail_logs: "read_logs", log_reader: "read_logs",
  listterminals: "list_terminals", list_tasks: "list_terminals", running_terminals: "list_terminals",
};

/** 编辑距离，长度差 >2 直接返回 3（调用方的阈值是 <3，早退省一趟 DP）。 */
export function _lev(a, b) {
  a = String(a); b = String(b);
  if (Math.abs(a.length - b.length) > 2) return 3;
  const n = b.length; const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) { const tmp = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return dp[n];
}
