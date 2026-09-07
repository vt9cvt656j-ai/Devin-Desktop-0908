// 统计行「任何时刻都有数」（2026-09-07 所有者点名）：秒表 / 输入·输出 / 金额三格永远都在；
// 网关还没结算的部分以带 ≈ 的在途估算补上，结算齐了 ≈ 自动消失；金额三位小数。
//
// 能在 Node 里跑的（算数模块、_turnStatsText、_turnStatsTitle、_liveTurnPending、两个记录点）
// 一律真跑；只有主循环 / 纯对话的接线用源码守调用点。
import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE, blockFrom, fnSource } from "./helpers/source.mjs";
import {
  countCjk, streamedTokens, sumContextParts, listPriceUsd, costCalibration, pendingTurnUsage,
} from "../src/agent/turn-pending.js";

const short = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const usd = (c, d = 3) => "$" + (Number(c) / 663).toFixed(d);
const stats = load("_turnStatsText", { _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: short, _dispUsd: usd });
const title = load("_turnStatsTitle", { _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: short, _dispUsd: usd, _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663 });
const text = (o) => stats(o).html.replace(/<[^>]+>/g, "");
const items = (o) => (stats(o).html.match(/turn-stats__item/g) || []).length;
const PRICES = { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 0, cacheKnown: true };

test("已流出的字数换 token 与 _estimateTokens 同一算法：中文按字、其余按 3.5 字符", () => {
  const est = load("_estimateTokens");
  for (const s of ["hello world, this is a plain ascii sentence", "全部中文的一句话", "中英 mixed 混合 text 一起", ""]) {
    assert.equal(streamedTokens(s.length, countCjk(s)), est(s), `「${s}」`);
  }
  assert.equal(sumContextParts({ at: 1_700_000_000_000, l0: true, system: 5000, history: 1234.4, tools: "x", mcp: -3 }), 6234);
  assert.equal(sumContextParts(null), 0);
});

test("标价：两种 prompt 形状、缓存价「下发过的 0」按 0、没下发按输入价 0.1× 折", () => {
  // OpenAI 形状：prompt 含缓存读 → 未缓存 = 10000 - 8000
  assert.equal(listPriceUsd({ prompt: 10000, completion: 500, cacheRead: 8000, cacheWrite: 0, promptIncludesCached: true }, PRICES), (2000 * 1 + 8000 * 0.1 + 500 * 2) / 1e6);
  // Anthropic 形状：prompt 不含缓存读 → 未缓存 = 10000
  assert.equal(listPriceUsd({ prompt: 10000, completion: 500, cacheRead: 8000, cacheWrite: 0, promptIncludesCached: false }, PRICES), (10000 * 1 + 8000 * 0.1 + 500 * 2) / 1e6);
  // 下发过的 0 = 这条线路不计缓存费
  assert.equal(listPriceUsd({ prompt: 10000, completion: 0, cacheRead: 8000 }, { in: 1, out: 2, cacheRead: 0, cacheKnown: true }), 2000 / 1e6);
  // 没下发 = 不知道 → 估算按 0.1×（只用于带 ≈ 的在途估算）
  assert.equal(listPriceUsd({ prompt: 10000, completion: 0, cacheRead: 8000 }, { in: 1, out: 2, cacheRead: 0 }), (2000 + 800) / 1e6);
  assert.equal(listPriceUsd({ prompt: 10 }, null), null, "没单价回 null，不编数");
  assert.equal(listPriceUsd({ prompt: 10 }, { in: 0, out: 0 }), null, "按次计费 / 免费模型没有 per-token 单价");
});

test("在途合成：已结算跳过、流里报过的按实、正在流的主轮按估算、结束却没报的只计数，一个没有回 null", () => {
  const turns = [
    { kind: "main", settled: true, usage: { prompt: 99999, completion: 999 } },                       // 已结算 → 不算
    { kind: "main", settled: false, endedAt: 5, usage: { prompt: 10000, completion: 500, cacheRead: 8000, cacheWrite: 0 } },
    { kind: "main", settled: false, endedAt: null, streamChars: 350, streamCjk: 0 },                 // 在途：输出 100 token
    { kind: "aux", settled: false, endedAt: null, streamChars: 9999, streamCjk: 0 },                 // 辅助轮不估提示词
    { kind: "main", settled: false, endedAt: 9 },                                                     // 结束了却没报用量 → 只计数
  ];
  const r = pendingTurnUsage({ turns, prices: PRICES, rawCentsPerUsd: 663, promptEstimate: 20000, cacheRatio: 0.5 });
  assert.equal(r.in, 30000); assert.equal(r.out, 600);
  const usdReal = (2000 * 1 + 8000 * 0.1 + 500 * 2) / 1e6;                  // 0.0038
  const usdEst = (10000 * 1 + 10000 * 0.1 + 100 * 2) / 1e6;                 // 0.0112
  assert.ok(Math.abs(r.costCents - (usdReal + usdEst) * 663) < 1e-9, `costCents=${r.costCents}`);
  assert.equal(r.real, true); assert.equal(r.estimated, true); assert.equal(r.unsettledTurns, 3);
  assert.equal(pendingTurnUsage({ turns: [turns[0]], prices: PRICES }), null, "全部结算了就没有在途");
  assert.equal(pendingTurnUsage({ turns: [turns[2]], prices: null, promptEstimate: 100 }).costCents, null, "没单价：token 照出，金额 null");
  // 校准系数乘在金额上，token 不动
  const r2 = pendingTurnUsage({ turns: [turns[1]], prices: PRICES, rawCentsPerUsd: 663, calibration: 2 });
  assert.ok(Math.abs(r2.costCents - usdReal * 663 * 2) < 1e-9); assert.equal(r2.in, 10000);
});

test("校准：只在已结算轮全部报了用量时启用，比值夹在 [0.05, 20]", () => {
  const base = { in: 20000, out: 1000, cacheRead: 10000, cacheCreation: 0, settledTurns: 1, reportedTurns: 1, promptIncludesCached: true };
  const listCents = ((10000 * 1 + 10000 * 0.1 + 1000 * 2) / 1e6) * 663;
  assert.ok(Math.abs(costCalibration({ ...base, costCents: listCents * 2 }, PRICES, 663) - 2) < 1e-9);
  assert.equal(costCalibration({ ...base, costCents: listCents * 2, reportedTurns: 0 }, PRICES, 663), 1, "有轮没报用量就别校准");
  assert.equal(costCalibration({ ...base, costCents: 0 }, PRICES, 663), 1);
  assert.equal(costCalibration({ ...base, costCents: listCents * 999 }, PRICES, 663), 20);
  assert.equal(costCalibration(null, PRICES, 663), 1); assert.equal(costCalibration(base, null, 663), 1);
});

test("_turnStatsText：三格永远都在；在途估算带 ≈，结算齐了不带；什么都没有印 —", () => {
  const bare = stats({ elapsedMs: 1200 });
  assert.equal(items({ elapsedMs: 1200 }), 3);
  assert.match(text({ elapsedMs: 1200 }), /1200ms.*—\/—.*\$—/s); assert.doesNotMatch(bare.html, /≈/);
  // 只有在途估算（第一轮还在思考）
  const est = text({ elapsedMs: 3000, live: true, pending: { in: 24800, out: 12, costCents: 33, estimated: true, real: false } });
  assert.match(est, /≈24\.8k\/12/); assert.match(est, /≈\$0\.050/);
  // 已结算 + 上游已报（token 准、钱是估的）：token 不带 ≈，金额带
  const settled = { usageReported: true, promptTokens: 20000, completionTokens: 300, cachedTokens: 0, cacheCreationTokens: 0, costCents: 40, promptIncludesCached: true };
  const mixed = text({ elapsedMs: 3000, settlement: settled, pending: { in: 5000, out: 100, costCents: 10, estimated: false, real: true } });
  assert.match(mixed, /(^|[^≈])25\.0k\/400/); assert.match(mixed, /≈\$0\.075/);
  // 全部已结算：没有 ≈，金额三位小数
  const done = text({ elapsedMs: 3000, settlement: settled });
  assert.doesNotMatch(done, /≈/); assert.match(done, /20\.0k\/300/); assert.match(done, /\$0\.060/);
  // 结算到了但上游没报用量、也没有在途：老文案照旧，金额照出
  const noUsage = text({ elapsedMs: 3000, settlement: { usageReported: false, costCents: 7 } });
  assert.match(noUsage, /Usage unavailable/); assert.match(noUsage, /\$0\.011/);
  // 在途只有 token 没单价：金额那格退到已结算的数（仍带 ≈，说明没结完）
  const noPrice = text({ elapsedMs: 3000, settlement: settled, pending: { in: 100, out: 5, costCents: null, estimated: true, real: false } });
  assert.match(noPrice, /≈\$0\.060/);
});

test("tooltip 把在途那一层说清楚：来源、金额按什么折、结算后 ≈ 消失", () => {
  const withPending = title({ elapsedMs: 3000, live: true, pending: { in: 24800, out: 12, costCents: 33, estimated: true, real: false } });
  assert.match(withPending, /在途（网关还没结算）: 输入 24\.8k · 输出 12 → ≈\$0\.050/);
  assert.match(withPending, /正在流：提示词按上一轮实测估、输出按已收到的字数估/);
  assert.match(withPending, /结算落地后以网关为准，≈ 随之消失/);
  assert.match(withPending, /^Live stats \(settled \+ pending ≈\)/);
  const real = title({ elapsedMs: 3000, pending: { in: 5000, out: 100, costCents: null, estimated: false, real: true } });
  assert.match(real, /单价未知，金额待结算/); assert.match(real, /上游已报用量/);
  assert.doesNotMatch(title({ elapsedMs: 3000 }), /在途/);
  assert.doesNotMatch(CODE, /pending requests are not estimated/, "「在途不估算」那句老说明必须撤掉——现在估了");
});

test("_liveTurnPending：提示词估算取上一轮实测与本地拼装的大者；缓存比例先看本次 run，再看上一轮实测；校准乘上去", () => {
  const live = load("_liveTurnPending", {
    _sumContextParts: sumContextParts, _pendingTurnUsage: pendingTurnUsage, _costCalibration: costCalibration,
    _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663,
  });
  const session = { _ctxRealFloor: { total: 30000, input: 28000, output: 2000, cacheRead: 14000 }, _ctxParts: { at: 1, l0: true, system: 5000, history: 1000 } };
  const timeline = { turns: [{ kind: "main", settled: false, endedAt: null, streamChars: 35, streamCjk: 0 }] };
  const prices = { in: 1, out: 1, cacheRead: 0.1, cacheKnown: true };
  const r = live({ session, timeline, prices });
  assert.equal(r.in, 30000, "取 max(上一轮实测 30000, 本地拼装 6000)"); assert.equal(r.out, 10);
  const usdFloorRatio = (15000 * 1 + 15000 * 0.1 + 10 * 1) / 1e6;        // 缓存比例 14000/28000 = 0.5
  assert.ok(Math.abs(r.costCents - usdFloorRatio * 663) < 1e-9, `costCents=${r.costCents}`);
  assert.equal(r.estimated, true);
  // 本次 run 已结算一轮：缓存比例按 run 口径（10000/20000），并按实扣/标价校准（这里 2×）
  const listCents = ((10000 * 1 + 10000 * 0.1 + 1000 * 1) / 1e6) * 663;
  const runUsage = { in: 20000, out: 1000, cacheRead: 10000, cacheCreation: 0, costCents: listCents * 2, settledTurns: 1, reportedTurns: 1, promptIncludesCached: true, prices };
  const r2 = live({ session, timeline, prices, runUsage });
  assert.ok(Math.abs(r2.costCents - usdFloorRatio * 663 * 2) < 1e-6, `costCents=${r2.costCents}`);
  assert.equal(live({ session, timeline: { turns: [] }, prices }), null);
  assert.equal(live({ session: null, timeline: { turns: [{ kind: "main", settled: true }] }, prices }), null);
});

test("两个记录点：字数按 CJK 分开累计；流里报的用量落到轮次上，空回执不覆盖", () => {
  const noteDelta = load("_noteTurnStreamDelta", { _countCjk: countCjk });
  const noteUsage = load("_noteTurnStreamUsage");
  const turn = { streamChars: 0, streamCjk: 0, usage: null };
  noteDelta(turn, "hello 你好"); noteDelta(turn, "世界"); noteDelta(null, "x"); noteDelta(turn, "");
  assert.equal(turn.streamChars, 10); assert.equal(turn.streamCjk, 4);
  noteUsage(turn, { prompt_tokens: 120, completion_tokens: 30, cached_tokens: 100, cache_creation_tokens: 0 });
  assert.deepEqual(turn.usage, { prompt: 120, completion: 30, cacheRead: 100, cacheWrite: 0 });
  noteUsage(turn, { promptTokens: 0, completionTokens: 0 });
  assert.equal(turn.usage.prompt, 120, "空回执不许把已有用量抹掉");
  noteUsage(turn, { promptTokens: 200, completionTokens: 40, cachedTokens: null });
  assert.deepEqual(turn.usage, { prompt: 200, completion: 40, cacheRead: 0, cacheWrite: 0 });
});

test("接线：两条路的实时行都递 getPending，两条路的页脚都递 pending，写点都在，金额三位小数", () => {
  const blocks = [0, 1].map((nth) => blockFrom("= _liveTurnStats(body, {", { nth }));
  assert.ok(blocks.every((b) => /getPending: \(\) => _liveTurnPending\(/.test(b)), "有一处实时行没递在途估算——那条路第一轮又只剩秒表");
  const footers = CODE.match(/_appendTurnStatsFooter\(body, \{\s*\n\s*elapsedMs: _contentDoneMs,[\s\S]{0,400}?\}\);/g) || [];
  assert.equal(footers.length, 2, "两条路各一个定格页脚");
  assert.ok(footers.every((f) => /pending: _liveTurnPending\(/.test(f)), "页脚没递 pending——结算失败时又是整行没数");
  assert.match(CODE, /settlement: _finalRunSettlement\(_ru\) \|\| _liveRunSettlement\(_ru\),/, "有一轮没结算成就退到已结算的部分，别整行不出");
  assert.equal((CODE.match(/_noteTurnStreamDelta\(_timelineTurn, ev\.delta\)/g) || []).length, 2, "智能体路 reasoning + token 两个写点");
  assert.equal((CODE.match(/_noteTurnStreamDelta\(_plainTimelineTurn, ev\.delta\)/g) || []).length, 2, "纯对话路 reasoning + token 两个写点");
  assert.match(CODE, /_noteTurnStreamUsage\(_timelineTurn, ev\)/); assert.match(CODE, /_noteTurnStreamUsage\(_plainTimelineTurn, ev\)/);
  assert.match(CODE, /if \(_timelineTurn && settlement\) _timelineTurn\.settled = true;/);
  assert.match(CODE, /if \(_plainTimelineTurn && _plainSettlement\) _plainTimelineTurn\.settled = true;/);
  const tpl = fnSource("_agentTimelineStartTurn");
  for (const f of ["streamChars: 0", "streamCjk: 0", "usage: null", "settled: false"]) assert.ok(tpl.includes(f), `轮次模板缺 ${f}`);
  assert.match(CODE, /function _dispUsd\(rawCents, digits = 3\)/, "金额缺省三位小数");
});
