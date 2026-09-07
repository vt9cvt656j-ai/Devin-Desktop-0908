import test from "node:test";
import assert from "node:assert/strict";
import { SRC } from "./helpers/source.mjs";
import {
  TURN_TOOL_RESULTS_MAX_CHARS as CAP,
  PER_RESULT_FLOOR as FLOOR,
  allocateTurnResultBudget as alloc,
  capTurnToolResults,
} from "../src/agent/tool-output.js";

// 这个上限决定「一轮往上下文里灌多少」。它不是一次性的：灌进去的东西，这个会话剩下的
// 每一个请求都要再驮一遍（压缩刻意攒着不做，为的是保前缀缓存；最近 8 条还不折）。
// 线上实测每轮真正追加：p50 2,554 / p75 6,048 / p90 13,782 / p99 68,627 token。
// 旧值 200,000 字符 ≈ 55,000 token —— 只在 p99 以上才生效，等于没有上限。

test("上限落在 p90 之上、p99 之下：九成的轮次一字不削", () => {
  const tok = (chars) => chars / 3.6;          // 代码/路径为主，约 3.6 字节每 token
  assert.ok(tok(CAP) > 13_782, `上限 ${Math.round(tok(CAP))} token 低于 p90(13,782)——会削掉一成以上的正常轮次`);
  // 上界不能拿 p99 当判据：旧值 200,000 字符 ≈ 55,556 token，也 < 68,627，一样"通过"
  // （变异测试当场证伪：退回 200_000 这条断言不红）。真正要守的是**它得钳住肥尾**——
  // p95 量级的一轮必须被削，否则这道闸对着它要治的那批轮次根本不生效。
  const p95ish = 30_000 * 3.6;                 // ≈ 30,000 token 的一轮（落在 p90 与 p99 之间）
  assert.ok(CAP < p95ish,
    `上限 ${CAP} 字符钳不住 p95 量级(${Math.round(p95ish)} 字符)的一轮——等于没有上限`);
});

test("p90 量级的一轮逐字节不变（前缀缓存照旧全命中）", () => {
  // p90 ≈ 13,782 token ≈ 49,600 字符。这一档不许被碰。
  const sizes = [20000, 15000, 9000, 5600];    // 合计 49,600
  assert.deepEqual(alloc(sizes), sizes, "p90 量级的一轮被削了——九成的轮次都会受影响");
});

test("肥尾被钳住，而且每条都还剩得下东西", () => {
  const ten = Array(10).fill(60000);           // 十个并行大读取
  const got = alloc(ten);
  assert.equal(got.reduce((a, b) => a + b, 0), CAP, "总量没被钳到上限");
  assert.ok(Math.min(...got) >= FLOOR, `有结果被压到地板以下（最小 ${Math.min(...got)}）`);
  // 公平灌水：不许"前几条削到地板、后几条一字不动"
  assert.equal(new Set(got).size, 1, "十条等长的输入应当等分，出现了偏袒");
});

test("削掉的部分要落盘并给出取回路径——收紧不许销毁证据", () => {
  const big = "x".repeat(300000);
  let sunk = null;
  const out = capTurnToolResults(
    [{ role: "tool", content: big }],
    undefined,
    (raw, delivered, kind) => { sunk = { rawLen: raw.length, delivered, kind }; return "\n[全文已存: /tmp/t.txt]"; },
  );
  assert.ok(sunk, "削了却没调落盘钩子——那才是真的把证据丢了");
  assert.equal(sunk.rawLen, 300000, "落盘的必须是**原文**，不是削后的");
  assert.equal(sunk.kind, "turnclip");
  assert.match(out[0].content, /全文已存/, "回执里没有取回路径");
});

test("单条结果的地板没被动", () => {
  assert.equal(FLOOR, 1_200);
  const many = Array(60).fill(50000);          // 60 条抢 60,000 字
  const got = alloc(many);
  assert.ok(Math.min(...got) >= FLOOR, "条数一多就把某几条压成空了");
});

test("注释里写明了判据来源，别让下一个人再当成随手拍的数", () => {
  assert.match(SRC, /p50 2,554 \/ p75 6,048 \/ p90 13,782 \/ p99 68,627/,
    "没记下这个数是从哪来的——下次调它的人只能再赌一次");
  assert.match(SRC, /止住了灾难，但从来\s*\n?\s*\/\/ 没按延迟调过/,
    "没写清旧值 200_000 当初解决的是什么问题");
});
