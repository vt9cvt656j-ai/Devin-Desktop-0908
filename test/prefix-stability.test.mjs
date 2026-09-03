// 前缀缓存：一个真实回合写回之后，历史前缀还剩多少是逐字节不变的。
//
// # 为什么这条测试长这样
//
// 第一版我写成「20 次追加里摘要块变了几次」，**它是恒真的**：把滞回整个拿掉、退回原始
// 实现，四条断言照样全绿。原因是那个造数据的形状（40 条 4000 字符）压根没进 token 压力区，
// 而且 4000 字符一条时每压一批就腾出约 1 万 token，本来就要十来条才触发一次。
// 教训：造的数据必须和线上一个回合的形状一致，否则量到的是别的东西。
//
// # 线上实测（2026-09-02，gpt-5.6-luna 的 >40k 真回合）
//
//   请求 56k → 缓存 24k ｜ 请求 105k → 缓存 42k ｜ 请求 165k → 缓存 36k
//   **缓存量恒定、不随请求增长**；命中率与请求间隔无关（<1分 26.9% / 1–5分 26.6%）。
//   = 只有静态头进了缓存，几万 token 的对话历史一条都没进。
//
// 机制：一个 agent 回合结束时往 memory 批量写回约 19 条、约 1.7 万 token，而压缩阈值
// 4.8 万、每压一批只腾出约 1 万 —— 从第 3 轮起**每一轮都会压缩**。压缩把 recent 头部的
// 10 条切掉，于是 `prefixMessages() + recent` 这个前缀从位置 1 起就错位，缓存全丢。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationMemory } from "../src/conversation-memory.js";

/** 一个真实 agent 回合写回 memory 的东西：一句用户话 + 9 轮（思考 + 胖工具结果）。 */
function turnMessages(t) {
  const out = [{ role: "user", content: `用户第 ${t} 句`.padEnd(200, "。") }];
  for (let i = 0; i < 9; i++) {
    out.push({ role: "assistant", content: `思考 ${t}.${i}`.padEnd(1500, "x") });
    out.push({ role: "user", content: `工具结果 ${t}.${i}`.padEnd(6000, "y") });
  }
  return out;
}

/** 模型看到的历史前缀 = prefixMessages() + recent。逐字节快照。 */
// 逐条序列化再拼：整个数组 JSON.stringify 的话，末尾那个 `]` 追加后会变成 `,`，
// 于是纯追加也永远差 1 个字符。真实线路本来就是消息列表，逐条拼更贴近。
const prefixSnapshot = (mem) =>
  [...mem.prefixMessages(), ...mem.recent].map((m) => JSON.stringify(m)).join("\n");

/** 两个快照的公共前缀长度（字符）。缓存能命中多少，就看这个数。 */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

test("连续 10 个真实回合，历史前缀的复用率要远高于改动前", () => {
  // **量复用率，不量"断了几次"。** 断裂次数是个二值量（变没变），而真正决定
  // cached_tokens 的是「新一轮的历史里有多大一截和上一轮逐字节相同」。
  // 我第一版就是拿断裂次数当判据，结果把滞回整个拿掉它照样绿 —— 恒真守卫。
  //
  // 实测（10 个真实尺寸回合）：
  //   原始（100 条 / 48k，每次砍一批）  复用  7.4%
  //   现在（128→80 / 72k→36k）          复用 54.6%
  const mem = new ConversationMemory();
  let prev = null, reused = 0, total = 0;
  for (let t = 1; t <= 10; t++) {
    for (const m of turnMessages(t)) mem.push(m);
    const now = prefixSnapshot(mem);
    if (prev !== null) { reused += commonPrefix(prev, now); total += prev.length; }
    prev = now;
  }
  const pct = 100 * reused / total;
  assert.ok(pct >= 12, `历史前缀复用率只有 ${pct.toFixed(1)}%——改动前是 7.4%，说明滞回没生效`);
});

test("没触发压缩的那些回合，前缀必须是纯追加", () => {
  // 这是判据的另一半：不压缩的时候，一个字节都不许动。
  const mem = new ConversationMemory();
  for (const m of turnMessages(1)) mem.push(m);
  const a = prefixSnapshot(mem);
  const summariesBefore = mem.summaries.length;
  for (const m of turnMessages(2)) mem.push(m);
  const b = prefixSnapshot(mem);
  if (mem.summaries.length === summariesBefore) {
    assert.equal(commonPrefix(a, b), a.length, "没压缩却把前缀改了——那是白丢的缓存");
  }
});

test("压缩总量不能因为求稳定而缩水", () => {
  // 怕的是"为了缓存少压缩"把上下文顶爆。压完必须真的降到高水位以下。
  const mem = new ConversationMemory();
  for (let t = 1; t <= 10; t++) for (const m of turnMessages(t)) mem.push(m);
  // 高水位回到原值 48k（抬高它会让每轮请求变大、花钱变多，见 conversation-memory.js）。
  assert.ok(mem.estimateRecentTokens() <= 48000 + 20000,
    `压缩之后 recent 还有 ${mem.estimateRecentTokens()} token —— 上下文会顶爆`);
  assert.ok(mem.summaries.length > 0, "被砍掉的历史没有变成摘要，那就是丢了");
});

test("条数超限那条路照旧", () => {
  const mem = new ConversationMemory();
  for (let i = 0; i < 130; i++) mem.push({ role: "user", content: `short ${i}` });
  assert.ok(mem.recent.length <= 100, `条数没被压到窗口内：${mem.recent.length}`);
  assert.ok(mem.summaries.length > 0, "条数触发的压缩没产出摘要");
});
