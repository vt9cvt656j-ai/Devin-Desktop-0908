// 统计行「任何时刻都有数」（2026-09-07 所有者点名）：秒表 / 输入·输出 / 金额三格永远都在；
// 同一天下午所有者再点名「不要估算，都要走真实的」：在途只认上游报过的准数，金额只认网关结算，
// 界面不再出现 ≈；正在流的这一轮不编数。金额三位小数。
//
// 能在 Node 里跑的（算数模块、_turnStatsText、_turnStatsTitle、_liveTurnPending、两个记录点）
// 一律真跑；只有主循环 / 纯对话的接线用源码守调用点。
import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE, blockFrom, fnSource } from "./helpers/source.mjs";
import { countCjk, pendingTurnUsage } from "../src/agent/turn-pending.js";

const short = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const usd = (c, d = 3) => "$" + (Number(c) / 663).toFixed(d);
const stats = load("_turnStatsText", { _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: short, _dispUsd: usd });
const title = load("_turnStatsTitle", { _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: short, _dispUsd: usd, _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663 });
const text = (o) => stats(o).html.replace(/<[^>]+>/g, "");
const items = (o) => (stats(o).html.match(/turn-stats__item/g) || []).length;

test("CJK 计数：中文按字，其余不算", () => {
  assert.equal(countCjk("hello 你好世界"), 4); assert.equal(countCjk(""), 0);
});



test("在途合成：已结算跳过、流里报过的按实、正在流的一律不编数、结束却没报的只计数，一个没有回 null", () => {
  const turns = [
    { kind: "main", settled: true, usage: { prompt: 99999, completion: 999 } },                       // 已结算 → 不算
    { kind: "main", settled: false, endedAt: 5, usage: { prompt: 10000, completion: 500, cacheRead: 8000, cacheWrite: 0 } },
    { kind: "main", settled: false, endedAt: null, streamChars: 350, streamCjk: 0 },                 // 正在流 → 不编数
    { kind: "aux", settled: false, endedAt: null, streamChars: 9999, streamCjk: 0 },                 // 正在流 → 不编数
    { kind: "main", settled: false, endedAt: 9 },                                                     // 结束了却没报用量 → 只计数
  ];
  const r = pendingTurnUsage({ turns });
  assert.equal(r.in, 10000, "只有上游报过的那轮算数，正在流的不许估"); assert.equal(r.out, 500);
  assert.equal(r.costCents, null, "金额不折算：标价 × 校准不是真扣的数，等结算");
  assert.equal(r.real, true); assert.equal(r.estimated, false); assert.equal(r.unsettledTurns, 2);
  assert.equal(pendingTurnUsage({ turns: [turns[0]] }), null, "全部结算了就没有在途");
  assert.equal(pendingTurnUsage({ turns: [turns[2]] }), null, "只有正在流的一轮 = 什么真数都还没有");
  // 首帧就报了输入 token（Anthropic 线路）：轮还没结束也照实出，输出 0
  const early = pendingTurnUsage({ turns: [{ kind: "main", settled: false, endedAt: null, usage: { prompt: 15700, completion: 0 } }] });
  assert.equal(early.in, 15700); assert.equal(early.out, 0); assert.equal(early.real, true);
});


test("_turnStatsText：三格永远都在；只出真实数，界面上没有 ≈；什么都没有印 —", () => {
  const bare = stats({ elapsedMs: 1200 });
  assert.equal(items({ elapsedMs: 1200 }), 3);
  assert.match(text({ elapsedMs: 1200 }), /1200ms.*—\/—.*\$—/s); assert.doesNotMatch(bare.html, /≈/);
  // 上游首帧报了输入 token、还没结算：token 照实出、不带 ≈；金额等结算，印 —
  const early = text({ elapsedMs: 3000, live: true, pending: { in: 15700, out: 0, costCents: null, estimated: false, real: true } });
  assert.match(early, /15\.7k\/0/); assert.doesNotMatch(early, /≈/); assert.match(early, /\$—/);
  // 已结算 + 上游已报（还没结算）：token 相加，金额只认已结算的那份
  const settled = { usageReported: true, promptTokens: 20000, completionTokens: 300, cachedTokens: 0, cacheCreationTokens: 0, costCents: 40, promptIncludesCached: true };
  const mixed = text({ elapsedMs: 3000, settlement: settled, pending: { in: 5000, out: 100, costCents: null, estimated: false, real: true } });
  assert.match(mixed, /25\.0k\/400/); assert.match(mixed, /\$0\.060/); assert.doesNotMatch(mixed, /≈/);
  // 全部已结算：金额三位小数
  const done = text({ elapsedMs: 3000, settlement: settled });
  assert.doesNotMatch(done, /≈/); assert.match(done, /20\.0k\/300/); assert.match(done, /\$0\.060/);
  // 结算到了但上游没报用量、也没有在途：老文案照旧，金额照出
  const noUsage = text({ elapsedMs: 3000, settlement: { usageReported: false, costCents: 7 } });
  assert.match(noUsage, /Usage unavailable/); assert.match(noUsage, /\$0\.011/);
  // 就算有人硬塞一个折算金额进来，也不印：金额只认结算
  const stray = text({ elapsedMs: 3000, live: true, pending: { in: 100, out: 5, costCents: 33, estimated: true, real: false } });
  assert.doesNotMatch(stray, /≈/); assert.match(stray, /\$—/);
});

test("tooltip 把在途那一层说清楚：token 是上游报的准数、金额等结算，不再有 ≈", () => {
  const withPending = title({ elapsedMs: 3000, live: true, pending: { in: 24800, out: 12, costCents: null, estimated: false, real: true } });
  assert.match(withPending, /在途（上游已报用量、网关还没结算）: 输入 24\.8k · 输出 12/);
  assert.match(withPending, /token 是上游报的准数；金额等网关结算，不折算/);
  assert.match(withPending, /^Live stats \(settled \+ reported\)/);
  assert.doesNotMatch(withPending, /≈|估/, "tooltip 里还在说估算");
  assert.doesNotMatch(title({ elapsedMs: 3000 }), /在途/);
  assert.doesNotMatch(CODE, /pending requests are not estimated/, "老说明别回来——现在的说法是「上游报的准数 + 等结算」");
});

test("_liveTurnPending：正在流的一轮不编数；上游报过的照实；调用点形状不变", () => {
  const live = load("_liveTurnPending", { _pendingTurnUsage: pendingTurnUsage });
  const session = { _ctxRealFloor: { total: 30000, input: 28000, output: 2000, cacheRead: 14000 }, _ctxParts: { at: 1, l0: true, system: 5000, history: 1000 } };
  const prices = { in: 1, out: 1, cacheRead: 0.1, cacheKnown: true };
  // 第一轮还在思考、上游一个数都没报：null → 界面印 —，不印估算
  assert.equal(live({ session, timeline: { turns: [{ kind: "main", settled: false, endedAt: null, streamChars: 35, streamCjk: 0 }] }, prices }), null,
    "正在流的一轮又被估算出数来了——所有者要的是真实的");
  // 首帧报了输入 token：照实出
  const r = live({ session, timeline: { turns: [{ kind: "main", settled: false, endedAt: null, usage: { prompt: 15700, completion: 0 } }] }, prices });
  assert.equal(r.in, 15700); assert.equal(r.costCents, null, "金额只认结算");
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
