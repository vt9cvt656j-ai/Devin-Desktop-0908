// 统计行（秒表 / 输入·输出 / 金额）的「在途」部分：网关还没结算的那些 token 和钱。
//
// 2026-09-07 所有者点名：「不管什么时候，计时器那里都要有 token 和金额那两格，不然有时候
// 扣了费用户都看不到」。此前那两格只在网关结算落地后才出现——第一轮还在思考时只有一只秒表，
// 结算失败或按停之后干脆一个字没有。
//
// 数从三层来，按可信度排：
//   1. 网关结算（准，正式扣费的数）——由 _liveRunSettlement 提供，不在这个文件里；
//   2. 上游流里报的 usage（token 是准的，钱按目录单价折算）——每轮流结束时到，结算之前；
//   3. 本地估算（正在流的这一轮）：提示词按上一轮实测 / 本地拼装的量估，输出按已收到的字数估。
// 只要含第 2/3 层，界面就在数前挂 ≈；结算齐了 ≈ 自动消失。这里只算数：不碰 DOM、不查目录，
// 单价、分母、估算基数全由调用方递进来，测试可以直接喂。

const KINDS_WITH_INFLIGHT_ESTIMATE = new Set(["main", "chat"]);

function isCjk(c) {
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}

/** 一段文字里的 CJK 字数（与 main.js 的 _estimateTokens 同一套区间）。 */
export function countCjk(text) {
  const s = String(text || "");
  let n = 0;
  for (let i = 0; i < s.length; i++) if (isCjk(s.charCodeAt(i))) n++;
  return n;
}

/** 已流出的字数 → token 估算。与 _estimateTokens 同一算法：中文≈每字 1 token，其余每 3.5 字符 1 token。 */
export function streamedTokens(chars, cjk) {
  const c = Math.max(0, Number(chars) || 0);
  const k = Math.min(c, Math.max(0, Number(cjk) || 0));
  return Math.ceil(k + (c - k) / 3.5);
}

/** 上下文拼装各部分（system / rules / skills / history / tools / mcp …）的估算总和。`at` 是时间戳、`l0` 是线路旗标，不是量。 */
export function sumContextParts(parts) {
  if (!parts || typeof parts !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(parts)) {
    if (k === "at" || k === "l0") continue;
    const x = Number(v);
    if (Number.isFinite(x) && x > 0) n += x;
  }
  return Math.round(n);
}

/**
 * 按目录单价（美元 / 每 100 万 token）算一份用量的**标价**，单位美元。
 * 单价缺失（按次计费 / 免费模型）回 null。
 * `promptIncludesCached`：prompt 含不含缓存读——OpenAI 形状含（缺省），Anthropic 形状不含；
 * 流里报的 usage 已被传输层归一成「含」。
 * 缓存读单价没下发（cacheKnown 不为 true 且为 0）时，估算按输入价的 0.1× 折——这只用于
 * 带 ≈ 的在途估算，悬停面板那份「命中/未命中拆解」照旧拒绝推算。
 */
export function listPriceUsd({ prompt = 0, completion = 0, cacheRead = 0, cacheWrite = 0, promptIncludesCached = true } = {}, prices) {
  if (!prices) return null;
  const inP = Math.max(0, Number(prices.in) || 0);
  const outP = Math.max(0, Number(prices.out) || 0);
  if (!inP && !outP) return null;
  const readP = (Number(prices.cacheRead) || 0) > 0 || prices.cacheKnown === true ? Math.max(0, Number(prices.cacheRead) || 0) : inP * 0.1;
  const writeP = Math.max(0, Number(prices.cacheWrite) || 0);
  const p = Math.max(0, Number(prompt) || 0);
  const read = Math.max(0, Number(cacheRead) || 0);
  const write = Math.max(0, Number(cacheWrite) || 0);
  const uncached = promptIncludesCached === false ? p : Math.max(0, p - read - write);
  const out = Math.max(0, Number(completion) || 0);
  return (uncached * inP + read * readP + write * writeP + out * outP) / 1_000_000;
}

/**
 * 「标价 → 实扣」的校准系数：拿这次 run 已结算的部分，算出网关实扣 / 目录标价的比值
 * （线路倍率、真实缓存价都在里面），乘到在途估算上。没有可靠的已结算样本就 1。
 */
export function costCalibration(runUsage, prices, rawCentsPerUsd) {
  if (!runUsage || !prices) return 1;
  const settled = Math.max(0, Math.round(Number(runUsage.settledTurns) || 0));
  const reported = Math.max(0, Math.round(Number(runUsage.reportedTurns) || 0));
  const cost = Number(runUsage.costCents) || 0;
  if (!settled || reported !== settled || cost <= 0) return 1;
  const usd = listPriceUsd({
    prompt: runUsage.in, completion: runUsage.out, cacheRead: runUsage.cacheRead, cacheWrite: runUsage.cacheCreation,
    promptIncludesCached: runUsage.promptIncludesCached !== false,
  }, prices);
  const denom = usd == null ? 0 : usd * (Number(rawCentsPerUsd) || 0);
  if (denom <= 0) return 1;
  return Math.min(20, Math.max(0.05, cost / denom));
}

/**
 * 时间线上所有**还没结算**的轮次合成一份在途用量：
 *   · 有 turn.usage（流里报过用量）的：token 照实、钱按标价 × 校准；
 *   · 还没结束、也还没报用量的主轮：提示词按 promptEstimate、输出按已流出的字数估，
 *     缓存命中按 cacheRatio 摊；
 *   · 已结束却没报用量的轮（出错 / 按停在首字节前）：不编数，只计入 unsettledTurns。
 * 一个都没有就回 null（调用方据此不挂 ≈）。costCents 是网关口径的原始美分，单价缺失时为 null。
 */
export function pendingTurnUsage({ turns = [], prices = null, rawCentsPerUsd = 663, promptEstimate = 0, cacheRatio = 0, calibration = 1 } = {}) {
  let inTok = 0, outTok = 0, usd = 0, priced = false, real = false, estimated = false, unsettled = 0;
  const ratio = Math.min(1, Math.max(0, Number(cacheRatio) || 0));
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || t.settled === true) continue;
    const u = t.usage;
    const kind = String(t.kind || "main");
    if (u && ((Number(u.prompt) || 0) > 0 || (Number(u.completion) || 0) > 0)) {
      real = true; unsettled++;
      inTok += Math.max(0, Math.round(Number(u.prompt) || 0));
      outTok += Math.max(0, Math.round(Number(u.completion) || 0));
      const price = listPriceUsd({ prompt: u.prompt, completion: u.completion, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, promptIncludesCached: true }, prices);
      if (price != null) { usd += price; priced = true; }
    } else if (t.endedAt == null && KINDS_WITH_INFLIGHT_ESTIMATE.has(kind)) {
      estimated = true; unsettled++;
      const p = Math.max(0, Math.round(Number(promptEstimate) || 0));
      const out = streamedTokens(t.streamChars, t.streamCjk);
      inTok += p; outTok += out;
      const price = listPriceUsd({ prompt: p, completion: out, cacheRead: Math.round(p * ratio), cacheWrite: 0, promptIncludesCached: true }, prices);
      if (price != null) { usd += price; priced = true; }
    } else if (t.endedAt != null) {
      unsettled++;
    }
  }
  if (!unsettled) return null;
  const cal = Number.isFinite(Number(calibration)) && Number(calibration) > 0 ? Number(calibration) : 1;
  const costCents = priced ? Math.max(0, usd * (Number(rawCentsPerUsd) || 0) * cal) : null;
  return { in: inTok, out: outTok, costCents, real, estimated, unsettledTurns: unsettled };
}
