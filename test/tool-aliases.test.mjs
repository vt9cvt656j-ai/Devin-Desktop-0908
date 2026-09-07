// 工具名归一化：模型编出来的名字要能落到真实工具上；落不到的要如实成「未知工具」，不能静默执行错工具。
//
// 数据来源：生产 30 天 model_usage.emitted_tool（30,808 次调用里 44 种不存在的名字、327 次），
// 对照 server/prompts/tools.json 逐个跑 _canonicalToolName——落空 71 次，每次一整轮白烧。
// 这份测试把那批**真实出现过的**名字钉住，用的是 main.js 那份真函数（load 抠源码跑）配
// 真实别名表和真实目录，不是一个手写的替身。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _TOOL_ALIASES, _lev } from "../src/agent/tool-aliases.js";
import { load } from "./helpers/source.mjs";

const gw = JSON.parse(readFileSync(new URL("../../server/prompts/tools.json", import.meta.url), "utf8"));
const KNOWN = new Set(
  (Array.isArray(gw) ? gw : (gw.tools || Object.values(gw))).map((t) => t?.name || t?.function?.name).filter(Boolean),
);
KNOWN.add("search_tools"); // 网关常驻的元工具，不在静态目录里（main.js 也是单独 add 进 _KNOWN_TOOLS 的）
assert.ok(KNOWN.size > 100, `目录只读出 ${KNOWN.size} 个工具，取法多半坏了`);

const canonical = load("_canonicalToolName", { _KNOWN_TOOLS: KNOWN, _TOOL_ALIASES, _lev });

test("生产里真出现过的错名字，现在都能落到对的工具上", () => {
  // 左边逐字来自 emitted_tool；右边是执行分支真实存在的工具。
  const cases = {
    RunCommand: "run_cmd", run_code: "run_cmd", execute_command: "run_cmd", Bash: "run_cmd", bash: "run_cmd",
    pwsh: "run_cmd", PowerShell: "run_cmd",
    Grep: "search", grep: "search", search_files: "search",
    Read: "read_file", read: "read_file", Write: "write_file", Edit: "edit_file", edit: "edit_file",
    LS: "list_dir", Glob: "find_files", skill: "read_skill",
    run_terminal: "run_in_terminal",
    CheckCommandStatus: "read_terminal",
    Task: "run_subagent",
    StopCommand: "stop_terminal", terminate_terminal: "stop_terminal",
    SearchReplace: "edit_file", DeleteFile: "delete_path",
    get_weather: "live_environment",
    browser_navigate: "browser", browser_action: "browser",
  };
  for (const [emitted, want] of Object.entries(cases)) {
    assert.equal(canonical(emitted), want, `${emitted} 应归一到 ${want}`);
  }
});

test("没有对应工具的名字必须落空（null），不能被编辑距离撮合到一个错的工具上", () => {
  // OpenPreview / job_list / list_agents 都没有语义相同的工具；record_identity_probe / tool_3 /
  // cc_tool_dispatch 是纯垃圾。落空之后主循环会回「未知工具 + 最接近的几个候选」，模型能自纠；
  // 撮合到错工具则是静默执行了一个别的动作。
  for (const junk of ["OpenPreview", "job_list", "list_agents", "record_identity_probe", "tool_3", "cc_tool_dispatch", "get_projects"]) {
    assert.equal(canonical(junk), null, `${junk} 不该被撮合到任何工具`);
  }
});

test("mcp__ 前缀原样透传（那是用户自己接的服务，名字由它定）", () => {
  assert.equal(canonical("mcp__context7__query-docs"), "mcp__context7__query-docs");
  assert.equal(canonical("mcp__playwright__browser_navigate"), "mcp__playwright__browser_navigate");
});

test("折键：CamelCase 拆成下划线、分隔符归一、大小写不敏感——真实目录名直接命中，不靠别名", () => {
  // 这些名字别名表里一个都没有：它们能落到工具上，全靠折键之后正好等于目录名。
  assert.equal(canonical("ReadFile"), "read_file");
  assert.equal(canonical("ListDir"), "list_dir");
  assert.equal(canonical("HTTPRequest"), "http_request");
  assert.equal(canonical("Run-Cmd"), "run_cmd");
  assert.equal(canonical("web fetch"), "web_fetch");
  assert.equal(canonical("read.file"), "read_file");
  assert.equal(canonical("  __find_files__ "), "find_files");
  // 拆 CamelCase 之后，别名表里现成的 delete_file / search_replace 才够得着。
  assert.equal(canonical("DeleteFile"), "delete_path");
  assert.equal(canonical("SearchReplace"), "edit_file");
  assert.equal(canonical("run_cmd"), "run_cmd", "已经是规范形状的一个字不能动");
  assert.equal(canonical(null), null);
  assert.equal(canonical(""), null);
});

test("别名表里每一个目标都是目录里真实存在的工具——指向不存在的工具就是把一次调用送进未知", () => {
  const dangling = [...new Set(Object.values(_TOOL_ALIASES))].filter((v) => !KNOWN.has(v)).sort();
  assert.deepEqual(dangling, [], `这些别名目标在 tools.json 里不存在：${dangling.join(", ")}`);
});

test("别名不许把一个真实工具名映射成别的工具（自映射除外）", () => {
  const hijacks = Object.entries(_TOOL_ALIASES).filter(([k, v]) => KNOWN.has(k) && v !== k).map(([k, v]) => `${k}→${v}`);
  assert.deepEqual(hijacks, [], `这些真实工具名被别名劫持了：${hijacks.join(", ")}`);
});
