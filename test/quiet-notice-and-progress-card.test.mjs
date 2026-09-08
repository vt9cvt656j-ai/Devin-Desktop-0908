// 对话里的两处噪音（2026-09-07 所有者实拍指出）。
//
// 一、「终端「install-deps」的命令已退出」那行灰字 —— 终端卡片和终端页签都已经写着它退了，
//     再补一行是同一件事的第三遍。所有者：「这种提示可以删除了」。
//     删的是**画给人看的那一行**，不是通知本身：模型照旧收到完整正文，才知道命令结束了。
//     所以这里两头都钉：不许再画，也不许顺手把模型那一份删掉。
//
// 二、「已生成 run_cmd · 等待执行 · 1.5k 字符」那张卡 —— run_cmd 有自己的终端卡片，而且
//     它不在进度卡的名单里，`friendly` 就退化成注册名，界面上直接冒出 `run_cmd` 这个
//     英文标识符。所有者：「run_cmd 直接用终端卡片就可以…这样是旧的」。

import test from "node:test";
import assert from "node:assert/strict";
import { CODE, fnSource } from "./helpers/source.mjs";

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("终端命令退出：通知照发，只是不在对话里画那一行", () => {
  const notify = stripComments(fnSource("_notifyTerminalCommandEnded"));
  // 模型那一份一个字没少
  assert.match(notify, /_queueNotice\(sess,/, "通知整条被删了——模型就不知道命令结束了");
  assert.match(notify, /\[run_in_terminal 结束\]/, "给模型的正文没了");
  assert.match(notify, /最后的输出/, "输出尾巴没给模型");
  // 但它标了 quiet
  assert.match(notify, /quiet: true/, "终端退出通知没标 quiet，那行灰字还会画出来");
  assert.match(notify, /display: `终端「\$\{label\}」的命令已退出`/,
    "display 仍然要留着：它是这条通知在日志/调试里的名字，只是不再上屏");
});

test("_queueNotice：quiet 决定画不画，不决定发不发", () => {
  const q = stripComments(fnSource("_queueNotice"));
  assert.match(q, /quiet: !!meta\.quiet/, "notice 上没有 quiet 字段");
  // 画那一行被 quiet 挡住
  assert.match(q, /if \(!notice\.quiet\) \{ try \{ addMessage\("user", notice\.display/,
    "addMessage 没有被 quiet 挡住");
  // 发给模型的三件事都在 quiet 之外：steer 队列、会话记忆、闲着时的待发
  assert.match(q, /_steerQueue = sess\._steerQueue \|\| \[\]\)\.push\(\{ text: content, body, attachments: \[\], notice \}\)/,
    "正在跑的那一轮不再收到这条通知");
  assert.match(q, /sess\.memory\.push\(\{ role: "user", content, attachments: \[\], _ideMeta: \{ notice \} \}\)/,
    "通知没进会话记忆，模型下一轮就看不到了");
  assert.match(q, /_pendingSends = sess\._pendingSends \|\| \[\]\)\.push\(\{ text: content, attachments: \[\], notice \}\)/,
    "闲着时不再排这条通知");
  // quiet 不能被误读成「别发」
  const gate = q.slice(q.indexOf("if (sess.streaming"));
  assert.ok(!/quiet/.test(gate.replace(/if \(!notice\.quiet\) \{ try \{ addMessage[^\n]*\n/, "")),
    "分发那一段也在看 quiet——它只该管画不画");
});

test("重画历史时也跳过：删一次要删在两个地方", () => {
  // 分页重画（正常路径）
  assert.match(CODE, /if \(m && m\.content != null && !\(m\.role !== "assistant" && m\._ideMeta\?\.notice\?\.quiet\)\)/,
    "分页重画没跳过 quiet 通知，重开会话那行灰字又回来了");
  // 老格式整段恢复
  assert.match(CODE, /if \(m\._ideMeta\?\.notice\?\.quiet\) continue;/,
    "老格式恢复路径没跳过 quiet 通知");
  // 闲着时唤醒的那一轮
  assert.match(CODE, /if \(!opts\.alreadyInTranscript && !opts\.notice\.quiet\) addMessage\("user", opts\.notice\.display/,
    "唤醒那一轮仍然会画出通知行");
  // 存盘时 notice 整体带走，quiet 才活得过重启
  assert.match(fnSource("_pendingSendsForStorage"), /\.\.\.\(pending\?\.notice \? \{ notice: pending\.notice \} : \{\}\)/,
    "存盘挑字段的话 quiet 会在重启后丢掉");
});

test("进度卡只给名单里那几个工具，界面上不会出现工具的注册名", () => {
  const prog = stripComments(fnSource("_liveToolProgress"));
  // 判据是「在不在名单里」，不是「参数长不长」
  assert.match(prog, /if \(!\(entry\.name in _TOOL_PROGRESS_LABELS\)\) return;/,
    "进度卡的判据不是名单");
  assert.ok(!/args\.length < 200/.test(prog), "按参数长度兜底的那条又回来了——run_cmd 会再拿到进度卡");
  // 名字只从名单取：取不到就不该有卡，所以没有 `|| entry.name` 这种退化
  assert.match(prog, /const friendly = _TOOL_PROGRESS_LABELS\[entry\.name\];/);
  assert.ok(!/_TOOL_PROGRESS_LABELS\[entry\.name\] \|\| entry\.name/.test(prog),
    "又退回用注册名当显示名——界面上会直接出现 run_cmd 这种英文标识符");
});

test("名单里没有任何拥有自己卡片的工具", () => {
  const table = CODE.slice(CODE.indexOf("const _TOOL_PROGRESS_LABELS = {"));
  const line = table.slice(0, table.indexOf("\n"));
  const names = [...line.matchAll(/(\w+):\s*"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["design_board", "preview_choices", "visual_explain", "generate_image", "design_research"]);
  // 有自己卡片的工具一个都不许在名单里
  for (const owns of ["run_cmd", "run_in_terminal", "write_file", "edit_file", "browser", "read_file"]) {
    assert.ok(!names.includes(owns), `${owns} 有自己的卡片，不该再要一张进度卡`);
  }
  // 名单里每个都得有中文名（有英文名就说明又漏了标识符）
  const labels = [...line.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.length, names.length);
  for (const label of labels) assert.match(label, /[一-鿿]/, `「${label}」不是中文显示名`);
});
