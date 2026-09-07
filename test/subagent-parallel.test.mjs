// 子智能体一轮里发多个纯读工具时，I/O 必须重叠。
//
// 主循环早就有并发调度器（_runOrderedToolSegments），子体这条路一直是严格串行的
// —— 而「一轮发三个 read」恰恰最常出现在子体里（research_project / run_worker /
// spawn_multiple_agents 都由它承载，这些角色的活基本就是读和搜）。
//
// 判据部分是纯函数，**在这里真跑**；main.js 里只剩接线，用源码断言守"接上了没有"。

import test from "node:test";
import assert from "node:assert/strict";
import { readOnlyBatch, NEVER_PREFETCH } from "../src/agent/subagent-batch.js";
import { SRC } from "./helpers/source.mjs";

// 一个够真实的替身：按名字给出类型，参数原样带上。
const READ_ONLY = new Set(["read", "list", "search", "find", "lsp", "diag", "semsearch", "findsymbol"]);
const EXEC = ["read", "list", "search", "find", "lsp", "diag", "semsearch", "findsymbol", "git", "mcp", "cmd", "browser", "db", "gh"];
const NAME_TO_TYPE = {
  read_file: "read", list_dir: "list", search: "search", find_files: "find",
  get_diagnostics: "diag", find_symbol: "findsymbol", semantic_search: "semsearch",
  git_status: "git", run_cmd: "cmd", search_tools: "search_tools",
  browser: "browser", db_query: "db", gh_pr_create: "gh", mcp_thing: "mcp",
};
const mapCall = (name, args) => (NAME_TO_TYPE[name] ? { type: NAME_TO_TYPE[name], path: args?.path || "" } : null);
const call = (name, args = {}) => ({ name, parsedArgs: args });
const batch = (...names) => readOnlyBatch(names.map((n) => call(n)), mapCall, { readOnlyTypes: READ_ONLY, execTypes: EXEC });

test("一批纯读调用整批放行，且按原顺序返回", () => {
  const got = batch("read_file", "list_dir", "search");
  assert.ok(got, "三个互不依赖的读取被判成不能并发");
  assert.deepEqual(got.map((c) => c.type), ["read", "list", "search"], "顺序变了 —— 工具结果会和声明它们的消息对不上");
});

test("第二个就是非纯读的：前缀只有一个，没有并发可言，退回串行", () => {
  // 这几个是「单类型多行为」：类型放行 ≠ 这一次放行。子体循环在执行前有一道逐次
  // 准入闸（git 只放只读 op、mcp 看 readOnlyHint、browser 只放观察动作、db 只放不改
  // 数据的查询）。预起跑发生在那道闸**之前**，所以它们一个都不能进前缀 ——
  // 否则就是「闸还没判，动作已经做了」。
  for (const bad of ["git_status", "browser", "db_query", "gh_pr_create", "mcp_thing"]) {
    assert.equal(batch("read_file", bad), null, `${bad} 混在批里居然被放行了`);
  }
});

test("前缀语义：连续的纯读打头就起跑，撞到第一个非纯读为止，后面的留给串行循环", () => {
  // 调研型子体一轮里最常见的形状：先读几份文件，再看一眼 git。上一版整批退回串行，
  // 三次互不依赖的读取排队跑，多出来的时间白付。
  const got = batch("read_file", "list_dir", "git_status", "search");
  assert.ok(got, "前缀两个纯读没被起跑");
  assert.deepEqual(got.map((c) => c.type), ["read", "list"], "前缀必须**恰好**停在第一个非纯读之前");
  // 非纯读打头：前缀为空，一切照旧串行。
  assert.equal(batch("git_status", "read_file", "list_dir"), null);
  // 中间断一次：只有第一段算前缀，第二段不能越过闸门被预起跑。
  assert.deepEqual(batch("read_file", "search", "run_cmd", "list_dir", "find_files").map((c) => c.type), ["read", "search"]);
  // cmd / search_tools 同样是前缀的终点，不是跳过它继续数。
  assert.deepEqual(batch("read_file", "list_dir", "search_tools", "search").map((c) => c.type), ["read", "list"]);
});

test("cmd 和 search_tools 永远不预起跑（它们有自己的执行分支）", () => {
  // run_cmd 有命令白名单 + 60 秒超时那一支；search_tools 在循环更靠前的地方被单独应答。
  assert.equal(batch("read_file", "run_cmd"), null);
  assert.equal(batch("read_file", "search_tools"), null);
  assert.ok(NEVER_PREFETCH.has("cmd") && NEVER_PREFETCH.has("search_tools"));
});

test("认不出的工具名是前缀的终点，不是当成空批放行", () => {
  assert.equal(batch("read_file", "完全不存在的工具"), null);
  assert.deepEqual(batch("read_file", "list_dir", "完全不存在的工具", "search").map((c) => c.type), ["read", "list"]);
});

test("只有一个调用时不预起跑 —— 没有并发可言，别多走一遍映射", () => {
  assert.equal(batch("read_file"), null);
  assert.equal(readOnlyBatch([], mapCall, { readOnlyTypes: READ_ONLY, execTypes: EXEC }), null);
});

test("映射函数抛异常时安全退回串行，不把整轮炸掉", () => {
  const boom = () => { throw new Error("坏了"); };
  assert.equal(readOnlyBatch([call("read_file"), call("list_dir")], boom, { readOnlyTypes: READ_ONLY, execTypes: EXEC }), null);
});

test("类型是纯读但这一轮不允许用，照样不放行", () => {
  // 只读子体和 worker 拿到的执行类型表不同；纯读表是全局的，允许表是这一轮的。
  const got = readOnlyBatch([call("read_file"), call("get_diagnostics")], mapCall,
    { readOnlyTypes: READ_ONLY, execTypes: ["read"] });
  assert.equal(got, null, "这一轮不允许用的类型被预先跑了");
});

test("main.js 的子体循环确实接上了预起跑，并且结果被取用", () => {
  const at = SRC.indexOf("async function _runSubAgent(");
  assert.ok(at > 0, "_runSubAgent 改名了");
  const end = SRC.indexOf("\nasync function ", at + 30);
  const sub = SRC.slice(at, end > at ? end : SRC.length);

  assert.match(sub, /readOnlyBatch\(turn\.toolCalls,/, "子体没接预起跑 —— 一轮三个 read 就是三次串行 I/O");
  // 前缀语义下只能按返回的那几项建卡；按 turn.toolCalls 全量遍历会对着 undefined 取 .type 炸掉。
  assert.match(sub, /if \(_batch\) _batch\.forEach\(\(c, _i\) => \{\s*\n\s*const tc = turn\.toolCalls\[_i\];/,
    "消费方没按前缀遍历——readOnlyBatch 现在只返回可起跑的前缀");
  assert.match(sub, /result = _preRun \? await _preRun\.p : await _executeToolStep\(step, call, root, execRun\)/,
    "预起跑的结果没被取用，等于同一件事跑了两遍");
  assert.match(sub, /\.catch\(\(e\) => \(\{ type: c\.type, path: c\.path, content: `\[ERROR\]/,
    "预起跑的 promise 没兜异常 —— 一个读失败会变成未处理的 rejection");

  // 打断判据必须排在取用预起跑结果之前，否则打断之后推的是那条已经跑完的读取结果。
  const live = sub.indexOf('if (!_live()) result = { type: call.type, path: call.path, content: "[interrupted]" };');
  const take = sub.indexOf("result = _preRun ? await _preRun.p");
  assert.ok(live > 0 && take > live, "打断判据必须排在取用预起跑结果之前");
});

// ── run_cmd 也要进跨工具打转台账 ──────────────────────────────────────────
//
// `spinTargetOf` 原来只读 path/pattern/query/name，而 run_cmd 一个都没有 —— 于是它
// **一次都进不了这本台账**，而它恰恰是打转量最大的工具。用户实拍的那条路径里第二次
// 尝试往往就是一条命令：view_image image.png 读不到 → `cat image.png` 也读不到 →
// 再换第三个。不认这一支，「两个不同的工具都没找到」这条结论在最常见的形状上永远不成立。
import { spinTargetOf } from "../src/agent/spin-target.js";

test("命令和读图工具指向同一个文件时，跨工具目标要能对上", () => {
  assert.equal(spinTargetOf({ type: "view_image", path: "assets/image.png" }), "image.png");
  assert.equal(spinTargetOf({ type: "cmd", command: "cat assets/image.png" }), "image.png",
    "run_cmd 的目标认不出来 —— 最常见的那种跨工具打转永远检出不了");
  // 开关要跳过，别把 -la 当成目标。
  assert.equal(spinTargetOf({ type: "cmd", command: "ls -la src/foo" }), "foo");
  // 没有路径样参数时退回第一个普通参数，仍然能和别的工具对上（npm test / test 文件）。
  assert.equal(spinTargetOf({ type: "cmd", command: "npm test" }), "test");
});

test("原来那几路一个字节都不能变", () => {
  assert.equal(spinTargetOf({ pattern: "**/image*.png" }), "image.png");
  assert.equal(spinTargetOf({ path: "a/b/C.TXT" }), "c.txt");
  assert.equal(spinTargetOf({ query: "handler" }), "handler");
  // path 优先于 command：两者都有时不该被命令行盖掉。
  assert.equal(spinTargetOf({ path: "real.js", command: "cat other.js" }), "real.js");
  assert.equal(spinTargetOf({ type: "cmd", command: "" }), "");
  assert.equal(spinTargetOf({}), "");
  assert.equal(spinTargetOf(null), "");
});
