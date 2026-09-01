/**
 * 「上下文用量」面板的内容：分段条 + 每一段的数。
 *
 * # 为什么分项是这几项，而不是「系统提示词 / 工具定义 / 规则 / 技能 / 子智能体 / 对话」
 *
 * 那种分法要知道**提示词是怎么拼出来的**。这个客户端在 L0 线路上根本没有那份文本——提示词
 * 和工具 schema 由网关注入，客户端手里只有工具名（这是产品的既定保护，不是能补的缺口）。
 * 硬要显示，只能拿本地估算去填，那就是「兜底冒充真值」：六个看着精确的数字，加起来还对不上
 * 上面那个真实读数。这个仓库为这种事做过一次全站审计。
 *
 * 所以分的是**上游真报过的那几刀**：输入里哪些命中了缓存、哪些是这次新写进缓存的、哪些是
 * 原价读的，加上输出。每一段都来自 usage 回执，加起来正好等于上面那个总数。
 *
 * 纯函数：状态从参数进，不碰 DOM。
 */

/** 千分位缩写，和仪表上那个 _tokenShort 同口径。 */
function short(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, "") + "K";
  return (v / 1000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/**
 * @param state  _ctxMeter 的快照
 * @param totals 会话累计（_tok）
 * @returns { pct, headline, sub, rows, notes, empty }
 */
export function contextUsageView(state = {}, totals = {}) {
  const s = state || {};
  const prompt = Math.max(0, Number(s.prompt) || 0);
  const completion = Math.max(0, Number(s.completion) || 0);
  const total = Math.max(0, Number(s.total) || 0);
  const limit = Math.max(1, Number(s.limit) || 1);
  const pct = Math.max(0, Math.min(999, Math.round(Number(s.pct) || 0)));
  // 上游没报缓存字段时 cached 是 null（≠ 真 0）：那一段不画，也不写成 0。
  const cached = s.cached == null ? null : Math.max(0, Number(s.cached) || 0);
  const cacheWrite = Math.max(0, Number(s.cacheWrite) || 0);
  const uncached = Math.max(0, prompt - (cached || 0) - cacheWrite);

  const rows = [];
  // 命中 0 也要**把这一行摆出来**。
  //
  // 原来 0 就整行不画，屏幕上只剩「未缓存输入」——用户读到的是"这个功能没做/是假的"
  // （实拍原话：「做成真实的，真实的缓存命中那些显示，而不是虚假内容」）。
  // 而 0 恰恰是**上游报回来的真数**：会话第一次请求本来就没有可命中的前缀。
  // 把它写出来，和「上游根本没报缓存字段」（cached === null，下面那条 note）才分得开——
  // 这两件事在旧版界面上长得一模一样。
  if (cached || (cached === 0 && prompt > 0)) {
    rows.push({ key: "cached", label: "缓存命中", value: cached, text: short(cached) });
  }
  if (cacheWrite) rows.push({ key: "cacheWrite", label: "新写入缓存", value: cacheWrite, text: short(cacheWrite) });
  if (uncached) rows.push({ key: "uncached", label: cached == null && !cacheWrite ? "输入" : "未缓存输入", value: uncached, text: short(uncached) });
  if (completion) rows.push({ key: "completion", label: "本轮输出", value: completion, text: short(completion) });

  const notes = [];
  // 分母是猜的就得说出来，否则 91% 看上去和真实读数一样确定。
  if (s.windowReported === false && total > 0) notes.push(`窗口未上报 · ${short(limit)} 是按模型名推的，百分比仅供参考`);
  if (s.estimated) notes.push("本地估算 · 供应商尚未上报本轮用量");
  if (cached == null && prompt > 0) notes.push("上游没报缓存字段，无法拆出命中/新写");
  // 报了、但这一轮是 0：说清楚它是真数，不是"没做"。
  if (cached === 0 && prompt > 0) notes.push("本轮缓存命中 0 —— 这是上游报回来的真数，同一段前缀要连着用才会命中");
  const t = totals || {};
  if (t.anyReal) {
    const hit = Number(t.inWithCacheInfo) > 0 ? Math.round((Number(t.cached) || 0) / Number(t.inWithCacheInfo) * 100) : null;
    notes.push(`会话累计 输入 ${short(t.in)} · 输出 ${short(t.out)}${hit == null ? "" : ` · 缓存命中 ${hit}%`}`);
  }
  // 档位那一行和模型名不进这块面板（用户点名删的）：模型名在下面的选择器和每条回复的
  // 抬头上各写着一次，档位是账户属性、不是"这一轮读了多少"。两者都还在 aria-label 的
  // 详版里，读屏软件读不了这块面板。

  return {
    pct,
    headline: `${pct}% 已用`,
    sub: `${short(total)} / ${short(limit)}`,
    rows,
    notes,
    // 一次都还没上报过：如实说空，别画一条 0 段的条。
    empty: total <= 0,
  };
}
