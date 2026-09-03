// 实时状态条的「等待上游首字节 / 接收中」必须说的是**当前这一轮**。
//
// 这两个标签原来读的是任务级首次事件（timeline.firstModelProgressAt / firstVisibleAt），
// 而这两个字段只在第一次有值时写入。于是第一轮首显之后它们永远非空，两个分支从第二轮起
// 再也进不去：模型请求发出后卡 10-30 秒没有首字节（中转不做流式转发、网关重试第 2/3 次），
// 界面上只有一只光跑的秒表，一个字都不说在等什么——而 agent 模式下绝大多数等待恰恰发生在
// 第二轮以后，这条标签在它最需要出现的地方恒定缺席。
//
// 更难查的是：同一份数据在 tooltip 里是逐轮全的（悬停能看到「#5 发起 1:02 · 响应头 - ·
// 模型进度 -」），可见标签却一个字没有——同一份事实两个出口说法不一致。
//
// 逐轮字段（requestStartedAt / firstProgressAt / firstVisibleAt / endedAt / attempts）
// timeline.turns 上早就齐了，这条修复不新增任何记录点，只是改成读它们。
import test from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, SRC as RAW_SRC, load } from "./helpers/source.mjs";

// _turnStatsText 必须保持自包含（test/logic.test.mjs 只注入这三个格式化函数就把它跑起来）。
const statsText = load("_turnStatsText", {
  _fmtElapsed: (ms) => `${Math.round(Number(ms) || 0)}ms`,
  _tokenShort: (n) => String(n),
  _dispUsd: (c) => `$${c}`,
});

// 行内撤下「模型 / 首显」之后，这两个量的**唯一**出口就是 tooltip。所以这里必须把
// tooltip 也真跑起来：只断言行内没有，等于允许「顺手把记录点也删掉」这种改法照样绿。
const statsTitle = load("_turnStatsTitle", {
  _fmtElapsed: (ms) => `${Math.round(Number(ms) || 0)}ms`,
  _tokenShort: (n) => String(n),
  _dispUsd: (c) => `$${c}`,
});

const T0 = 1_700_000_000_000;
const line = (opts) => statsText(opts).html.replace(/<[^>]+>/g, "");

/** 一条模型轮次。缺省是「已发起、还没收到首字节、还没结束」。 */
function turn(over = {}) {
  return {
    stepIndex: 1, kind: "main", startedAt: T0,
    requestStartedAt: T0, responseHeadersAt: null, firstChunkAt: null,
    firstProgressAt: null, firstVisibleAt: null, endedAt: null, attempts: [{ index: 1 }],
    ...over,
  };
}
const timelineOf = (...turns) => ({
  startedAt: T0,
  firstModelProgressAt: turns.find((t) => t.firstProgressAt != null)?.firstProgressAt ?? null,
  firstVisibleAt: turns.find((t) => t.firstVisibleAt != null)?.firstVisibleAt ?? null,
  turns,
});

test("第一轮：请求已发出、上游还没开口时说明在等首字节", () => {
  const tl = timelineOf(turn());
  assert.match(line({ elapsedMs: 8000, timeline: tl, live: true }), /等待上游首字节/);
});

test("第一轮：开始收了但还没画出来时说「接收中」", () => {
  const tl = timelineOf(turn({ firstProgressAt: T0 + 900 }));
  const text = line({ elapsedMs: 8000, timeline: tl, live: true });
  assert.match(text, /接收中/);
  assert.doesNotMatch(text, /等待上游首字节/);
});

test("第二轮起同样要说话——这正是原来整条静默的地方", () => {
  // 第一轮完整跑完（任务级 firstModelProgressAt / firstVisibleAt 从此永远非空），
  // 第二轮刚发出去、还没首字节。
  const first = turn({ stepIndex: 1, firstProgressAt: T0 + 800, firstVisibleAt: T0 + 1200, endedAt: T0 + 5000 });
  const second = turn({ stepIndex: 2, startedAt: T0 + 9000, requestStartedAt: T0 + 9000 });
  const tl = timelineOf(first, second);
  assert.notEqual(tl.firstModelProgressAt, null, "任务级字段确实已经有值了（旧判据据此永远沉默）");
  const text = line({ elapsedMs: 30000, timeline: tl, live: true });
  assert.match(text, /等待上游首字节/, "第二轮卡在上游不开口，界面必须说出来");
  assert.match(text, /第 2 轮/, "多轮时要指明是哪一轮在等");
});

test("第二轮开始收内容但这一轮还没出字时是「接收中」", () => {
  const first = turn({ stepIndex: 1, firstProgressAt: T0 + 800, firstVisibleAt: T0 + 1200, endedAt: T0 + 5000 });
  const second = turn({ stepIndex: 2, startedAt: T0 + 9000, requestStartedAt: T0 + 9000, firstProgressAt: T0 + 12000 });
  const text = line({ elapsedMs: 30000, timeline: timelineOf(first, second), live: true });
  assert.match(text, /接收中/);
  assert.doesNotMatch(text, /等待上游首字节/);
});

test("物理重试要标出来：用户看到的不是一次长等待，而是第几次重来", () => {
  const t = turn({ stepIndex: 3, attempts: [{ index: 1 }, { index: 2 }, { index: 3 }] });
  const first = turn({ stepIndex: 1, firstProgressAt: T0 + 800, firstVisibleAt: T0 + 900, endedAt: T0 + 1000 });
  const text = line({ elapsedMs: 60000, timeline: timelineOf(first, t), live: true });
  assert.match(text, /重试 #3/);
  assert.match(text, /等待上游首字节/);
});

test("轮次都结束了（正在跑工具）就不加标签——工具卡自己在转", () => {
  const done = turn({ firstProgressAt: T0 + 800, firstVisibleAt: T0 + 1200, endedAt: T0 + 5000 });
  const text = line({ elapsedMs: 30000, timeline: timelineOf(done), live: true });
  assert.doesNotMatch(text, /等待上游首字节|接收中/);
});

test("异常留下的陈迹不许一直亮着：它后面还有已结束的轮次就当它不存在", () => {
  const stale = turn({ stepIndex: 1, endedAt: null });          // 结束时机漏写
  const done = turn({ stepIndex: 2, startedAt: T0 + 6000, requestStartedAt: T0 + 6000, firstProgressAt: T0 + 6100, firstVisibleAt: T0 + 6200, endedAt: T0 + 9000 });
  const text = line({ elapsedMs: 40000, timeline: timelineOf(stale, done), live: true });
  assert.doesNotMatch(text, /等待上游首字节|接收中/, "倒序扫到已结束的轮次就停，不再往前翻");
});

test("并行子体和主轮同时未结束时，说的是主轮", () => {
  const main = turn({ stepIndex: 4, kind: "main" });
  const sub = turn({ stepIndex: 5, kind: "subagent", startedAt: T0 + 100, requestStartedAt: T0 + 100, firstProgressAt: T0 + 200 });
  const text = line({ elapsedMs: 20000, timeline: timelineOf(main, sub), live: true });
  assert.match(text, /等待上游首字节/, "主轮还在等首字节，就报主轮");
  assert.doesNotMatch(text, /子体/);
});

test("只有子体在跑时如实说是子体，不冒充第 N 轮", () => {
  const done = turn({ stepIndex: 1, firstProgressAt: T0 + 800, firstVisibleAt: T0 + 900, endedAt: T0 + 1000 });
  const sub = turn({ stepIndex: 2, kind: "subagent", startedAt: T0 + 3000, requestStartedAt: T0 + 3000 });
  const text = line({ elapsedMs: 20000, timeline: timelineOf(done, sub), live: true });
  assert.match(text, /子体 · 等待上游首字节/);
});

test("还没开过任何一轮时退回任务级判据（首轮开跑前的等待照样有字）", () => {
  const tl = { startedAt: T0, firstModelProgressAt: null, firstVisibleAt: null, turns: [] };
  assert.match(line({ elapsedMs: 3000, timeline: tl, live: true }), /等待上游首字节/);
  assert.match(line({ elapsedMs: 3000, timeline: null, live: true }), /等待上游首字节/);
});

// 「模型 24s / 首显 24s」从行内撤下 —— 但只是换出口，不是丢数据。
//
// 用户在 grok-4.6 的回复下看到的是「⏱ 25s  模型 24s  首显 24s」：三个几乎相同的秒数。
// 那条线路不做流式转发，首字节到达时整段已经生成完，于是两个「首个事件」必然贴着总耗时。
// 这一项对用户是纯噪音，而在做流式转发的线路上它仍然有诊断价值 —— 所以搬进 tooltip，
// 不是删除。这条测试同时钉住两边：行内没有了，tooltip 里还在，而且 tooltip 还挂在出口上。
test("收尾（非 live）不加等待标签，且行内不再显示「模型 / 首显」两项", () => {
  const done = turn({ firstProgressAt: T0 + 800, firstVisibleAt: T0 + 1200, endedAt: T0 + 5000 });
  const tl = timelineOf(done);
  const text = line({ elapsedMs: 30000, timeline: tl, live: false });
  assert.doesNotMatch(text, /等待上游首字节|接收中/);
  assert.doesNotMatch(text, /模型 800ms/, "行内还在显示「首个模型事件」耗时——用户明确要求撤下");
  assert.doesNotMatch(text, /首显 1200ms/, "行内还在显示「首显」耗时——用户明确要求撤下");
  // 撤下显示 ≠ 撤掉记录点。
  const title = statsTitle({ elapsedMs: 30000, timeline: tl });
  assert.match(title, /任务首个有效模型事件: 800ms/, "撤下行内的同时把任务级记录也弄丢了");
  assert.match(title, /任务首个实际文字渲染: 1200ms/);
  assert.match(title, /模型进度 800ms model · 首显 1200ms text/, "逐轮明细也要还在");
  // 「不挪、直接删」的全部前提是 tooltip 还挂在渲染出口上。构造器里有数据 ≠ 用户够得着：
  // 20302（实时）/20442（收尾）任一处的 el.title 被顺手删掉，上面三条照样全绿而两个数彻底消失。
  assert.ok((SRC.match(/el\.title = _turnStatsTitle\(/g) || []).length >= 2,
    "tooltip 没挂在渲染出口上了——行内已经撤下，这两个数就彻底看不到了");
  // 等待期间必须照样说话：firstProgressMs / firstVisibleMs 两个 const 还是那条退路的判据，
  // 别顺手一起删干净了。startedAt 不能是 0——Number(null) === 0 会让 _timelineElapsed 返回 0
  // 而不是 null，这条退路永远进不去，断言就成了摆设。
  assert.match(line({ elapsedMs: 3000, live: true,
    timeline: { startedAt: T0, firstModelProgressAt: null, firstVisibleAt: null, turns: [] } }),
    /等待上游首字节/);
});

test("判据不再是任务级首次事件", () => {
  const at = RAW_SRC.indexOf("function _turnStatsText(");
  const fn = SRC.slice(at, RAW_SRC.indexOf("function _turnStatsTitle", at));
  const liveAt = fn.indexOf("if (live) {");
  assert.ok(liveAt > 0, "找不到 live 分支");
  // 下界原来钉的是 `if (firstProgressMs != null)` —— 那一行已经被删掉了，indexOf 会返回
  // -1，slice(liveAt, -1) 于是切到函数末尾，窗口悄悄撑大而这条测试**照样全绿**
  // （撑大之后 doesNotMatch(/_timelineElapsed\(/) 仍然通过，因为剩下的调用都在 liveAt 之前）。
  // 换成 live 分支后面第一个必然存在的结构，并断言它真的找到了。
  const boundary = fn.indexOf("if (settlement) {", liveAt);
  assert.ok(boundary > liveAt, "找不到 live 分支的下界（if (settlement)）——切片会退化成整个函数，下面几条守卫会变恒真");
  const liveBlock = fn.slice(liveAt, boundary);
  assert.ok(liveBlock.length < 3000, `切出来 ${liveBlock.length} 字节，不像是 live 分支，锚点失效了`);
  assert.match(liveBlock, /timeline\?\.turns/, "live 分支必须看逐轮数据");
  assert.match(liveBlock, /endedAt/, "必须按「这一轮结束没有」判定");
  // 任务级字段只允许在「一轮都还没开过」那条退路上出现。
  const perTurn = liveBlock.slice(0, liveBlock.indexOf("} else if (!turns.length)"));
  assert.doesNotMatch(perTurn, /firstProgressMs|firstVisibleMs/,
    "逐轮判定里不许再读任务级首次事件——那正是第二轮起整条静默的原因");
  // 这个函数必须继续自包含：它被单独取出来跑，引入新 helper 会当场 ReferenceError。
  assert.doesNotMatch(liveBlock, /_timelineElapsed\(/, "逐轮判据直接看字段是否为空即可");
});

// 实时费用要把「缓存命中」和「没命中」分别算清楚。
//
// 关键不变量：**拆出来的几项必须精确加回服务端结算的总额**。做法是按单价权重去摊那个
// 总额，而不是拿单价另算一份——真正扣费的是 compute_cost 的 `usd * 100 * rate`，中间那个
// 线路 rate 倍率和运行期目录单价客户端都复现不了，另算必然对不上，用户就会看到
// 「四项相加 ≠ 总额」。摊开则 rate 和单位在比值里约掉，天然自洽。
test("费用拆解按单价权重摊开，几项精确加回总额", () => {
  const cents = [];
  const title = load("_turnStatsTitle", {
    _fmtElapsed: (ms) => `${ms}ms`,
    _tokenShort: (n) => String(n),
    // 记录每一次格式化的金额，用来验加总
    _dispUsd: (c, d = 2) => { cents.push(Number(c) || 0); return "$" + (Number(c) / 663).toFixed(d); },
    _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663,
  });
  const out = title({ elapsedMs: 5000, settlement: {
    costCents: 298, usageReported: true, promptTokens: 53253, completionTokens: 4025,
    cachedTokens: 46080, cacheCreationTokens: 0, settledTurns: 1, reportedTurns: 1,
    promptIncludesCached: true,
    prices: { in: 0.27, out: 1.10, cacheRead: 0.0123, cacheWrite: 0 },
  }});
  assert.match(out, /命中\/未命中分别算/, "没有出费用拆解");
  assert.match(out, /cache HIT .*若未命中要 .*省下/, "没说清命中省了多少");
  // **必须验真实渲染出来的那几个数**，不能在测试里把不变量重算一遍——重算的话，
  // 生产代码改成「按单价另算一份」照样绿（实测过，那正是恒真守卫）。
  const total = Number(out.match(/Credit cost: \$([0-9.]+)/)?.[1]);
  // 只取每行 `→ $x` 那一个（括号里的「若未命中要/省下」不是份额，不参与加总）
  const parts = [...out.matchAll(/·[^\n]*?→ \$([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(parts.length >= 3, `只解析到 ${parts.length} 项份额`);
  const sum = parts.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - total) < 0.005,
    `拆出来的几项加不回总额：${parts.join(" + ")} = ${sum.toFixed(3)}，总额 ${total}`);
});

test("网关没下发缓存单价时不推算，宁可不显示", () => {
  const title = load("_turnStatsTitle", {
    _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: (n) => String(n),
    _dispUsd: (c, d = 2) => "$" + (Number(c) / 663).toFixed(d),
    _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663,
  });
  const out = title({ elapsedMs: 1000, settlement: {
    costCents: 100, usageReported: true, promptTokens: 10000, completionTokens: 100,
    cachedTokens: 5000, cacheCreationTokens: 0, settledTurns: 1, reportedTurns: 1,
    promptIncludesCached: true,
    prices: { in: 0.27, out: 1.10, cacheRead: 0, cacheWrite: 0 }, // 缓存单价缺失
  }});
  assert.doesNotMatch(out, /命中\/未命中分别算/,
    "缓存单价没下发却还是把拆解印出来了 —— 那等于按 0.1× 推算，实测偏一半");
});

// 缓存单价 0 有两种意思，必须分开：下发过的 0 = 这条线路不计缓存费（照实显示 $0）；
// 压根没下发 = 不知道（整段不出）。混成一个 0 会两个方向都骗人。
test("线路不计缓存费时照实显示 $0，而不是当成「不知道」藏起来", () => {
  const title = load("_turnStatsTitle", {
    _fmtElapsed: (ms) => `${ms}ms`, _tokenShort: (n) => String(n),
    _dispUsd: (c, d = 2) => "$" + (Number(c) / 663).toFixed(d),
    _MICHAEL_RAW_CENTS_PER_CREDIT_USD: 663,
  });
  const base = {
    costCents: 298, usageReported: true, promptTokens: 53253, completionTokens: 4025,
    cachedTokens: 46080, cacheCreationTokens: 0, settledTurns: 1, reportedTurns: 1,
    promptIncludesCached: true,
  };
  // 下发过、且是 0 → 免费线路：出拆解，并写明不计缓存费
  const free = title({ elapsedMs: 1000, settlement: { ...base,
    prices: { in: 0.27, out: 1.10, cacheRead: 0, cacheWrite: 0, cacheKnown: true } } });
  assert.match(free, /命中\/未命中分别算/, "免费线路把整段藏起来了");
  assert.match(free, /此线路不计缓存费/, "没说明这条线路不计缓存费");
  // 没下发 → 不知道：不出拆解，也绝不按 0.1× 推算
  const unknown = title({ elapsedMs: 1000, settlement: { ...base,
    prices: { in: 0.27, out: 1.10, cacheRead: 0, cacheWrite: 0 } } });
  assert.doesNotMatch(unknown, /命中\/未命中分别算/, "单价未下发却还是把拆解印出来了");
});
