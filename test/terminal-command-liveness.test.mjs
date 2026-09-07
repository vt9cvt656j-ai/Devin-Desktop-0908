// 「命令还在不在跑」必须和「shell 还在不在」分开问。
//
// 在这之前全系统只有一个字段 `entry.exited`，而它只在 PTY 读到 EOF（**shell 自己退出**）
// 时才置位。可 run_in_terminal 是把命令写进一个交互式登录 shell（-i -l）—— 命令崩了、
// 被 Ctrl-C、端口被占用退出，shell 照样活着，EOF 永远不来。于是任务终端的 exited
// **结构上恒为 false**，一口气打哑五处机制：崩溃现场贴不出来、页签无限堆积、
// background_monitor 只能等满超时、终端复用永远走不到「原地重跑」、状态一律报「运行中」。
//
// 用户的说法是「终端被关闭半天了、做了一大会才发现」—— 不是发现得晚，是没有发现的通道。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE } from "./helpers/source.mjs";
import { applyRunningPoll, commandEnded, markCommandStarted, anyCommandPending } from "../src/agent/terminal-liveness.js";

const tab = (o = {}) => ({ backendId: 1, exited: false, ...o });

test("命令跑起来又停了 → 判定结束（而 shell 从头到尾都活着）", () => {
  const t = markCommandStarted(tab(), 1000);
  assert.equal(commandEnded(t), false, "刚发出去就说结束了");

  // 第一次轮询：前台组已经切给命令了。
  applyRunningPoll([t], [1], { now: 1900 });
  assert.equal(t.cmdRunning, true);
  assert.equal(commandEnded(t), false);

  // 第二次：命令没了。shell 还在（exited 仍是 false），但命令确实结束了。
  const ended = applyRunningPoll([t], [], { now: 2800 });
  assert.equal(commandEnded(t), true, "跑过又停了却没判成结束");
  assert.equal(t.exited, false, "不该去动 shell 的生死");
  assert.deepEqual(ended.map((x) => x.backendId), [1], "没报出这一次新结束的条目");
});

test("宽限期：刚发出去、前台组还没切过来，不许当场误报结束", () => {
  // 这是唯一会**每条命令都误报一次**的形状，必须挡住。
  const t = markCommandStarted(tab(), 1000);
  applyRunningPoll([t], [], { now: 1100, graceMs: 1800 });
  assert.equal(commandEnded(t), false, "命令刚写进去就被判结束了");
  applyRunningPoll([t], [], { now: 1700, graceMs: 1800 });
  assert.equal(commandEnded(t), false);
  // 过了宽限期仍然没在跑 —— 那它就是一条 1.8 秒内跑完的快命令。
  applyRunningPoll([t], [], { now: 2900, graceMs: 1800 });
  assert.equal(commandEnded(t), true, "快命令永远等不到结局 —— 状态会一直卡在「运行中」");
});

test("没发过命令的终端不会凭空「结束」", () => {
  // 用户自己开的终端、还没被派活的任务终端：一律不该有结局。
  const t = tab();
  applyRunningPoll([t], [], { now: 9e9 });
  assert.equal(commandEnded(t), false);
  assert.equal(anyCommandPending([t]), false);
});

test("同一个终端跑第二条命令时，上一条的结局要作废", () => {
  const t = markCommandStarted(tab(), 1000);
  applyRunningPoll([t], [1], { now: 1900 });
  applyRunningPoll([t], [], { now: 2800 });
  assert.equal(commandEnded(t), true);

  // 复用这个终端跑下一条。
  markCommandStarted(t, 3000);
  assert.equal(commandEnded(t), false, "上一条的结局没清掉，新命令一上来就是「已结束」");
  applyRunningPoll([t], [1], { now: 3900 });
  assert.equal(commandEnded(t), false);
  assert.equal(anyCommandPending([t]), true, "还在跑却说没有命令在等结局 —— 轮询会被停掉");
});

test("用户自己在同一个终端敲了命令：结局同样作废，不会被上一条误判", () => {
  const t = markCommandStarted(tab(), 1000);
  applyRunningPoll([t], [1], { now: 1900 });
  applyRunningPoll([t], [], { now: 2800 });
  assert.equal(commandEnded(t), true);
  // 用户敲了 npm run dev：前台组又有东西了。
  applyRunningPoll([t], [1], { now: 3700 });
  assert.equal(commandEnded(t), false, "终端里又有东西在跑了，却还挂着「已结束」");
});

test("还有命令在等结局 → 轮询不许停（面板收起来也一样）", () => {
  const pending = markCommandStarted(tab({ backendId: 7 }), 1000);
  assert.equal(anyCommandPending([pending]), true);
  applyRunningPoll([pending], [7], { now: 1900 });
  applyRunningPoll([pending], [], { now: 2800 });
  assert.equal(anyCommandPending([pending]), false, "已经有结局了还在空转轮询");
  // 后端没起来的终端不算 —— 它压根没有 PTY 可问。
  assert.equal(anyCommandPending([markCommandStarted(tab({ backendId: null }), 1000)]), false);
});

test("拿不到信号 ≠ 没有命令在跑：null/undefined 一个字段都不许动", () => {
  // Windows 上 ConPTY 没有前台进程组，term_running_ids 返回 null。
  //
  // 这条断言原来只测到 now=1200 / 1500 —— **两次都在 1800ms 宽限期之内**，于是不管
  // 函数怎么写它都绿。真实行为是：过了宽限期，空信号会把每一条命令判成"已结束"，
  // Windows 上健康的 dev server 起来 1.9 秒后就被当成结束，终端复用随即"原地重跑"
  // 往同一个 PTY 里再写一条命令。所以这里必须测**远超宽限期**的时间点。
  for (const signal of [null, undefined]) {
    const t = markCommandStarted(tab(), 1000);
    applyRunningPoll([t], signal, { now: 1200 });
    assert.equal(commandEnded(t), false);
    applyRunningPoll([t], signal, { now: 9e9 });
    assert.equal(commandEnded(t), false,
      `信号是 ${signal} 时判成了"已结束"——"拿不到"被当成了"全都跑完了"`);
  }
  // 反方向同样要成立：空数组是**真的没有命令在跑**，过了宽限期就该有结局，
  // 否则这条修复会顺手把 macOS/Linux 上"命令结束了"这件事一起弄哑。
  const u = markCommandStarted(tab(), 1000);
  applyRunningPoll([u], [], { now: 9e9 });
  assert.equal(commandEnded(u), true, "空数组是真的没在跑，不能和「拿不到」混为一谈");
});

test("Rust 侧返回的是 Option，不是空表", () => {
  const rs = readFileSync(new URL("../src-tauri/src/terminal.rs", import.meta.url), "utf8");
  assert.match(rs, /pub fn term_running_ids\(_state: State<TerminalState>\) -> Option<Vec<u32>>/,
    "Windows 分支还在返回 Vec，空表会被读成「全都结束了」");
  assert.match(rs, /pub fn term_running_ids\(state: State<TerminalState>\) -> Option<Vec<u32>>/);
  assert.doesNotMatch(rs, /let Ok\(inner\) = state\.inner\.lock\(\) else \{\s*return Vec::new\(\);/,
    "锁失败仍然返回空表——同一个坑在非 Windows 上也成立");
});

test("坏输入不许把整轮轮询炸掉", () => {
  assert.doesNotThrow(() => applyRunningPoll(null, null, {}));
  assert.doesNotThrow(() => applyRunningPoll([null, undefined, {}], [1], {}));
  assert.equal(anyCommandPending(null), false);
  assert.equal(commandEnded(null), false);
  assert.equal(commandEnded(undefined), false);
});

test("background_monitor 的「生产者已停」用的是命令结束，不是 shell 退出", () => {
  // 任务终端的 exited 结构上恒为 false（本文件顶部那段注释列的第 3 条就是这个）。
  // 只读 exited 的话，这道门对它唯一要救的场景——dev server 起失败、模型却空等满整个
  // 超时窗口——从头到尾不会命中。
  assert.match(CODE, /const _bmStopped = \(t\) => !!\(t && \(t\.exited \|\| _terminalCommandEnded\(t\)\)\)/,
    "判据没接上命令级真值来源");
  assert.match(CODE, /nowExited: _bmStopped\(_bmWatchEnt\)/);
  assert.doesNotMatch(CODE, /nowExited: !!_bmWatchEnt\.exited/, "又退回只读 shell 退出了");
  assert.match(CODE, /const _bmWatchWasExited = _bmStopped\(_bmWatchEnt\)/,
    "起点快照也要用同一套判据，否则「一开始就停着」判不出来");
});
