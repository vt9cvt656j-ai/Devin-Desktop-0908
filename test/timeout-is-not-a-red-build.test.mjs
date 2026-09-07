// 命令**超时**和命令**跑失败了**是两回事，不能在半路被抹平。
//
// Rust 侧算得清清楚楚（tasks.rs 的 timed_out，serde 到 JS 是 timedOut）。但 JS 侧
// 重建结果对象时只抄了 code/stdout/stderr/sandbox/sandboxDenied —— timedOut 掉了。
// 于是下游执行事实里那句 `timedOut: result.timedOut === true` 对**每一条 run_cmd
// 都恒为 false**：一次超时被当成退出码非 0 的红构建，模型转头去「修」一个根本没
// 失败的东西，而真正该做的是放宽超时或换个跑法。
//
// 这是「静默假话」那一类：没报错、返回值和真相无法区分。

import test from "node:test";
import assert from "node:assert/strict";
import { fnSource, blockFrom } from "./helpers/source.mjs";

test("子进程结果重建时必须抄上 timedOut", () => {
  const fn = fnSource("_agentRunInTerminal");
  assert.match(fn, /timedOut: r\?\.timedOut === true \|\| r\?\.timed_out === true/,
    "重建 result 时把 timedOut 抄漏了 —— 下游那句 timedOut 判定会对每一条命令恒为 false");
  // 顺带钉住它确实是从后端那个对象抄的，不是凭空 false。
  assert.doesNotMatch(fn, /timedOut: false/, "把 timedOut 写死成 false 了");
});

test("cmd 工具的结果对象要把它带给执行事实", () => {
  // _ideMeta 读的是工具结果上的 timedOut；中间断一环，前面抄对了也没用。
  const ret = blockFrom('        type: "cmd",\n        path: call.command,');
  assert.match(ret, /timedOut: result\.timedOut === true/,
    "cmd 工具结果没带 timedOut —— 执行事实里那一位永远是 false");
  assert.match(ret, /exitCode: result\.code/, "切出来的不是那个返回对象");
});

test("执行事实那一层本来就读得对（这一环不该动）", () => {
  const fn = fnSource("_executionEvidenceFromTool");
  assert.match(fn, /timedOut: result\.timedOut === true \|\| result\.timed_out === true/,
    "执行事实层的读法变了 —— 上游抄对了这里也接不住");
});
