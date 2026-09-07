// 统计行（秒表 / 输入·输出 / 金额）的「在途」部分：网关还没结算的那些 token 和钱。
//
// 2026-09-07 所有者点名：「不管什么时候，计时器那里都要有 token 和金额那两格，不然有时候
// 扣了费用户都看不到」。此前那两格只在网关结算落地后才出现——第一轮还在思考时只有一只秒表，
// 结算失败或按停之后干脆一个字没有。
//
// 数从三层来，按可信度排：
//   1. 网关结算（准，正式扣费的数）——由 _liveRunSettlement 提供，不在这个文件里；
//   2. 上游流里报的 usage（token 是准的）——每轮流结束时到（Anthropic 线路首帧就报输入），结算之前；
//   3. 本地估算（正在流的这一轮）：提示词按上一轮实测 / 本地拼装的量估，输出按已收到的字数估。
// 第 3 层（正在流的这一轮按本地估算）2026-09-07 按所有者要求撤掉：界面不再出现 ≈，金额只认结算。这里只算数：不碰 DOM、不查目录，
// 单价、分母、估算基数全由调用方递进来，测试可以直接喂。


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





/**
 * 时间线上所有**还没结算**的轮次合成一份在途用量。**只认真实来源**（所有者 2026-09-07：
 * 「不要估算，都要走真实的，接入真实的那条路」）：
 *   · 有 turn.usage（上游流里报过用量）的：token 照实；金额不折算——标价 × 校准那份不是真扣的数，
 *     等网关结算；
 *   · 正在流、还没报用量的轮：**不编数**。它的真数在上游报出用量那一刻就到；
 *   · 已结束却没报用量的轮（出错 / 按停在首字节前）：只计入 unsettledTurns。
 * 一个都没有就回 null。costCents 恒为 null（保留字段是为了调用方形状不变）。
 */
export function pendingTurnUsage({ turns = [] } = {}) {
  let inTok = 0, outTok = 0, real = false, unsettled = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || t.settled === true) continue;
    const u = t.usage;
    if (u && ((Number(u.prompt) || 0) > 0 || (Number(u.completion) || 0) > 0)) {
      real = true; unsettled++;
      inTok += Math.max(0, Math.round(Number(u.prompt) || 0));
      outTok += Math.max(0, Math.round(Number(u.completion) || 0));
    } else if (t.endedAt != null) {
      unsettled++;
    }
  }
  if (!unsettled) return null;
  return { in: inTok, out: outTok, costCents: null, real, estimated: false, unsettledTurns: unsettled };
}
