// 思考台账：一轮思考全文 → 只留结论句 → FIFO 挂在 session 上 → 下一轮以「勿重新推导」注入。
//
// 纯规则、零模型调用。三条判据是在生产里踩出来的：只认收尾段落里的决策词句；带猜想词
//（可能/也许/待确认…）的一律不入账——账本会把一句猜测变成下一轮的"如前所述"；
// 总量硬约束 ≤400 字，最新一条永远在场。从 main.js 原样搬出，一行逻辑没改。

// ── 方案A：思考结论沉淀 ──────────────────────────────────────────────────────
// 从整轮思考全文提取"结论摘要"：纯规则、零模型调用——取收尾段落里含决策词的句子
//（决定/选择/因此/方案/根因/结论/应该/需要），兜底取末段，上限 ~400 字。思考全文
// 可能几千字，只有结论值得进下轮上下文（token 经济，不滥注）。
export function _extractThinkingConclusion(reasoning, maxChars = 400) {
  const text = String(reasoning || "").replace(/\u000d/g, "").trim();
  if (text.length < 80) return ""; // 空/极短思考轮不入账
  const cap = Math.max(80, Math.floor(Number(maxChars) || 400));
  const paras = text.split(/\u000a\s*\u000a/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length >= 8);
  if (!paras.length) return text.replace(/\s+/g, " ").slice(-cap);
  // 「应该」「需要」是推理中段的情态词，不是结论词——"应该先 read_file 看一下"是待办，
  // 不是已定结论，而这本账本下一轮是以"勿重新推导已定结论"注入的。
  const decisionRe = /决定|选择|因此|所以|方案|根因|结论|最终|therefore|decided|conclusion|root cause/i;
  // 猜想词黑名单：模型说"可能配置在 config.json 里"，账本抄成一句光秃秃的断言，
  // 下一轮它就"如前所述，配置在 config.json"——那个文件它从没读过，且纠正无效，
  // 因为账本还在，重启也还在。带这些词的句子一律不入账。
  const hedgeRe = /可能|也许|大概|似乎|好像|不确定|待确认|尚未|还没|未验证|没验证|猜测|怀疑|试试|看看|下一步|maybe|perhaps|might|probably|not sure|unverified|guess|assume|[?？]/i;
  const picked = [];
  let total = 0;
  // 从最后一段往前捞决策性语句——收尾处的结论价值最高；最多回看 6 段
  outer: for (let i = paras.length - 1; i >= Math.max(0, paras.length - 6); i--) {
    const sentences = paras[i].split(/(?<=[。；;！!？?])\s*/).map((s) => s.trim()).filter((s) => s.length >= 8);
    for (let j = sentences.length - 1; j >= 0; j--) {
      if (!decisionRe.test(sentences[j]) || hedgeRe.test(sentences[j]) || picked.includes(sentences[j])) continue;
      picked.unshift(sentences[j]);
      total += sentences[j].length;
      if (total >= cap) break outer;
    }
  }
  // 兜底取末段时同样过猜想词。一段"下一步打算去确认 X"被当成已定结论注入，正是
  // 模型下一轮拿没验证过的前提往下走的来源。宁可这一轮什么都不记。
  if (!picked.length) {
    const tail = paras[paras.length - 1];
    return hedgeRe.test(tail) ? "" : tail.slice(0, cap);
  }
  return picked.join(" ").slice(0, cap);
}

// 思考结论入账：FIFO ≤6 条、每条 ≤400 字，挂 session 跨 run 存活（同 _demandLedger 通道）。
export function _thinkLedgerPush(session, summary, turn = 0) {
  const s = String(summary || "").trim();
  if (!s || !session) return;
  session._thinkLedger = Array.isArray(session._thinkLedger) ? session._thinkLedger : [];
  session._thinkLedger.push({ turn: Math.max(0, Number(turn) || 0), summary: s.slice(0, 400) });
  if (session._thinkLedger.length > 6) session._thinkLedger.splice(0, session._thinkLedger.length - 6);
}

// 注入块构造：从最新往旧装、总量硬约束 ≤400 字（最新一条永远在场），不滥注。
// 让模型"接着想"而不是每轮从零重想；结论与最新事实冲突时以事实为准。
export function _thinkLedgerBlockText(ledger) {
  const list = Array.isArray(ledger) ? ledger.filter((t) => t && String(t.summary || "").trim()) : [];
  if (!list.length) return "";
  const picked = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = String(list[i].summary).trim();
    if (picked.length && total + s.length > 400) break;
    picked.unshift(s);
    total += s.length;
  }
  return `【上轮思考结论（参考，勿重新推导已定结论；与最新事实冲突时以事实为准）】\n${picked.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n`;
}
