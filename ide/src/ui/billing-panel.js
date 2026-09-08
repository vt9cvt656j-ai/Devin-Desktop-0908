// 账单面板。
//
// 2026-09-07 所有者：「太丑了，没有 cursor / windsurf 那种大厂风格」。上一版是一座 Material
// 孤岛——Google 蓝的余额数字、28px 圆角、灰底卡片、描边圆形翻页钮——而整个应用是中性色 +
// 毛玻璃的另一套语言。两套语言并排放，单独看每一处都「没错」，合起来就是那种「像是别人
// 贴上来的页面」的观感。
//
// 这一版三条规矩：
//   · 颜色一律走应用自己的 token（--text / --text-dim / --line / --popover-surface），
//     深色模式因此不用再写第二套规则，用户换皮肤它也跟着变；
//   · 层级靠字号、字重和留白，不靠盒子 —— 上一版一屏里叠了卡片框、表格框、按钮框三层描边；
//   · 每一块都是真数据。「每日消费」「按模型」来自网关的聚合查询，不是装饰性图表
//     （见 memory no-hollow-report-cards：所有者点名讨厌没有信息量的报告卡片）。
//
// 这个文件只做**纯计算 + 造 DOM**，钱怎么换算、怎么取数、图标从哪来全部由调用方注入，
// 所以下面那几个纯函数可以在 Node 里直接跑（test/billing-panel.test.mjs）。

/**
 * `model_usage.cost_cents` 的单位分水岭。
 *
 * 2026-08-28 那次改动把这一列从**美元分**变成**人民币分**（差 7.1 倍），而库里没有任何一列
 * 能把两个年代分开。跨过这天直接把每天的钱画在同一根轴上，图上会凭空多出一段高七倍的
 * 历史——那不是「旧数据」，是错的数。分水岭当天两种单位都可能有，整天丢掉。
 *
 * 正常情况下窗口起点由网关随响应下发（`window_from`），这个常量只在老网关 / 自定义端点
 * 没有下发时兜底。两处必须写同一天，test/billing-panel.test.mjs 里有一条对账断言钉着。
 */
export const COST_UNIT_EPOCH = "2026-08-29";

const DAY_MS = 86_400_000;

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** UTC 日期串 `YYYY-MM-DD`。天按 UTC 切是和网关那边商量好的：两边说的是同一个格子。 */
export function utcDay(t) {
  const d = t instanceof Date ? t : new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** `YYYY-MM-DD` 往后数 n 天。纯字符串进出，不受本地时区影响。 */
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? utcDay(new Date(t + n * DAY_MS)) : day;
}

/**
 * 把稀疏的 `[{day, cost_cents, calls}]` 填成连续的日期序列。
 *
 * 没有调用的那天必须**在图上占一格**，否则「三天没用」和「三天连着用」画出来一模一样，
 * 而这正是一张消费图唯一要回答的问题。
 */
export function fillDays(points, from, to) {
  const by = new Map();
  for (const p of points || []) {
    const day = String(p?.day || "").slice(0, 10);
    if (!day) continue;
    const prev = by.get(day);
    const cents = Math.max(0, Number(p?.cost_cents) || 0);
    const calls = Math.max(0, Number(p?.calls) || 0);
    by.set(day, prev ? { cents: prev.cents + cents, calls: prev.calls + calls } : { cents, calls });
  }
  const out = [];
  // 上限 400 格：起止日期算错时（时钟漂了、网关回了个 1970）不该把界面卡死在一个死循环里。
  for (let day = from, guard = 0; guard < 400; day = addDays(day, 1), guard++) {
    const hit = by.get(day);
    out.push({ day, cents: hit ? hit.cents : 0, calls: hit ? hit.calls : 0 });
    if (day >= to) break;
  }
  return out;
}

/**
 * 每日消费。优先用网关下发的聚合（真·全量），没有那一段时回落到最近 200 条明细自己数。
 *
 * 回落那条路要**说清自己是回落**：明细只有最近 200 条，重度用户一天就能把它用满，
 * 那时候「最近 30 天」的图其实只画了半天——`source: "recent"` 让界面照实写「按最近 N 条明细」，
 * 而不是端出一张看着像全量的图。
 */
export function dailySeries(data, { now = Date.now(), days = 30 } = {}) {
  const today = utcDay(new Date(now));
  const epoch = String(data?.window_from || "").slice(0, 10) || COST_UNIT_EPOCH;
  const wanted = addDays(today, -(Math.max(1, days) - 1));
  const from = wanted > epoch ? wanted : epoch;

  const server = Array.isArray(data?.daily) ? data.daily : null;
  if (server) {
    return { points: fillDays(server, from, today), source: "server", from, to: today };
  }
  const rows = Array.isArray(data?.recent) ? data.recent : [];
  const counted = [];
  let oldest = "";
  for (const r of rows) {
    const day = utcDay(r?.time);
    if (!day || day < from) continue;
    if (!oldest || day < oldest) oldest = day;
    counted.push({ day, cost_cents: Number(r?.cost_cents) || 0, calls: 1 });
  }
  return {
    points: fillDays(counted, oldest || from, today),
    source: "recent",
    from: oldest || from,
    to: today,
    // 明细是「最近 200 条」，最早那一天必然是被截断的半天，图上不该把它当成完整的一天读。
    partialFrom: rows.length > 0 && counted.length >= rows.length,
  };
}

/**
 * 按模型排开。网关只回前 8 名，所以剩下的钱要单独并成「其他」一行 —— 把前 8 名相加当成
 * 「这段时间一共花了多少」会把第 9 名之后的钱悄悄抹掉，那是最难被发现的一种错。
 */
export function modelRows(data) {
  const server = Array.isArray(data?.by_model) ? data.by_model : null;
  const rows = server
    ? server.map((m) => ({
      model: String(m?.model || "—"),
      cents: Math.max(0, Number(m?.cost_cents) || 0),
      calls: Math.max(0, Number(m?.calls) || 0),
    }))
    : aggregateRecentByModel(data);
  const total = server && Number.isFinite(Number(data?.window_cost_cents))
    ? Math.max(0, Number(data.window_cost_cents))
    : rows.reduce((n, r) => n + r.cents, 0);
  const listed = rows.reduce((n, r) => n + r.cents, 0);
  const rest = Math.max(0, total - listed);
  const out = rows.filter((r) => r.cents > 0 || r.calls > 0);
  // 「其他」只在真的差出一分钱时才出现：差 0 的时候多一行灰字是噪音。
  if (rest > 0) out.push({ model: "其他", cents: rest, calls: 0, isRest: true });
  const denom = Math.max(1, total);
  return out.map((r) => ({ ...r, share: r.cents / denom }));
}

function aggregateRecentByModel(data) {
  const by = new Map();
  const epoch = String(data?.window_from || "").slice(0, 10) || COST_UNIT_EPOCH;
  for (const r of Array.isArray(data?.recent) ? data.recent : []) {
    if (utcDay(r?.time) < epoch) continue;
    const name = String(r?.model || "—");
    const prev = by.get(name) || { model: name, cents: 0, calls: 0 };
    prev.cents += Math.max(0, Number(r?.cost_cents) || 0);
    prev.calls += 1;
    by.set(name, prev);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents || b.calls - a.calls).slice(0, 8);
}

/** 图上每根柱子的高度百分比。峰值那根满格，其余按比例；非零的一天至少 4% —— 低到看不见的
 *  一天和完全没有的一天在图上必须能分开。 */
export function barHeights(points) {
  const peak = Math.max(0, ...points.map((p) => p.cents));
  return points.map((p) => (p.cents <= 0 ? 0 : peak > 0 ? Math.max(4, (p.cents / peak) * 100) : 4));
}

/** `MM-DD`。图下面只放头尾两个日期，中间靠悬停看，省得一排小字糊成一片。 */
export function shortDay(day) {
  return String(day || "").slice(5).replace("-", "/");
}

const PER_PAGE = 10;

/**
 * 造面板。所有外部依赖都从参数进来：
 *   fetchUsage()  → /api/usage 的 JSON
 *   fmtUsd(cents) → 金额文本（钱包分 → 面值美元，分母由网关下发）
 *   tokenShort(n) → token 数的短写
 *   t(key)        → 译文
 *   icon(kind)    → 内联 SVG（lucide 烤出来的那份，绝不手画）
 */
export function openBillingPanel({ fetchUsage, fmtUsd, tokenShort, t, icon, locale = "zh-CN", now = () => Date.now() }) {
  const T = (k, fallback) => {
    const v = typeof t === "function" ? t(k) : "";
    return v && v !== k ? v : fallback;
  };
  const dlg = document.createElement("dialog");
  dlg.className = "bill";
  dlg.innerHTML = `
    <div class="bill__head">
      <div class="bill__title">${escapeHtml(T("account.billing", "账单"))}</div>
      <div class="bill__head-right"><span class="bill__plan" hidden></span>
      <button class="bill__x" type="button" aria-label="${escapeHtml(T("common.close", "关闭"))}">${icon("close")}</button></div>
    </div>
    <div class="bill__body">${skeleton()}</div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const close = () => { try { dlg.close(); } catch {} dlg.remove(); };
  dlg.querySelector(".bill__x").onclick = close;
  // 点遮罩关闭：只认落在 dialog 元素本身（也就是遮罩）上的那一下，落在内容里的不算。
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });

  const body = dlg.querySelector(".bill__body");
  (async () => {
    let data;
    try {
      data = await fetchUsage();
    } catch (err) {
      body.innerHTML = `<div class="bill__msg bill__msg--err">${escapeHtml(String(err?.message || err))}</div>`;
      return;
    }
    try {
      renderBody(body, data, { fmtUsd, tokenShort, T, icon, locale, now: now() });
      const plan = String(data?.plan || "");
      if (plan && plan !== "none") {
        const chip = dlg.querySelector(".bill__plan");
        chip.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
        chip.hidden = false;
      }
    } catch (err) {
      body.innerHTML = `<div class="bill__msg bill__msg--err">${escapeHtml(String(err?.message || err))}</div>`;
    }
  })();
  return { close, el: dlg };
}

function skeleton() {
  const row = '<div class="bill__sk-row"></div>';
  return `<div class="bill__sk"><div class="bill__sk-stats"></div>${row.repeat(5)}</div>`;
}

function renderBody(body, data, ctx) {
  const { fmtUsd, T } = ctx;
  const balance = Number(data?.credits_cents) || 0;
  const total = Number(data?.total_spent_cents) || 0;
  const series = dailySeries(data, { now: ctx.now });
  const windowCents = Number.isFinite(Number(data?.window_cost_cents))
    ? Number(data.window_cost_cents)
    : series.points.reduce((n, p) => n + p.cents, 0);
  const windowCalls = Number.isFinite(Number(data?.window_calls))
    ? Number(data.window_calls)
    : series.points.reduce((n, p) => n + p.calls, 0);

  const stat = (label, value, sub) =>
    `<div class="bill__stat"><div class="bill__stat-k">${escapeHtml(label)}</div>` +
    `<div class="bill__stat-v" translate="no">${escapeHtml(value)}</div>` +
    (sub ? `<div class="bill__stat-s" translate="no">${escapeHtml(sub)}</div>` : "") + "</div>";

  // 窗口被单位分水岭截短时不能还写「近 30 天」—— 那是**说了一个没发生的口径**。
  // 满 30 天才用那句话，不满就写真实起点（「08/29 起」）。
  const full = series.points.length >= 30;
  const windowLabel = full
    ? T("billing.windowSpend", "近 30 天")
    : `${shortDay(series.from)} ${T("billing.since", "起")}`;
  const stats = `<div class="bill__stats">` +
    stat(T("billing.balance", "余额"), fmtUsd(balance)) +
    stat(windowLabel, fmtUsd(windowCents), `${windowCalls} ${T("billing.calls", "次调用")}`) +
    stat(T("billing.totalSpend", "累计消费"), fmtUsd(total)) +
    `</div>`;

  body.innerHTML = stats + chartSection(series, ctx) + modelSection(data, ctx) + tableSection(data, ctx);
  wireTable(body, data, ctx);
}

function section(title, note, inner) {
  return `<section class="bill__sec"><div class="bill__sec-h"><h3>${escapeHtml(title)}</h3>` +
    (note ? `<span class="bill__sec-n">${escapeHtml(note)}</span>` : "") +
    `</div>${inner}</section>`;
}

function chartSection(series, { fmtUsd, T }) {
  const pts = series.points;
  if (!pts.length) return "";
  const heights = barHeights(pts);
  const peak = Math.max(0, ...pts.map((p) => p.cents));
  const bars = pts.map((p, i) => {
    const tip = `${p.day} · ${fmtUsd(p.cents)} · ${p.calls} ${T("billing.calls", "次调用")}`;
    const cls = "bill__bar" + (p.cents > 0 && p.cents === peak ? " is-peak" : "") + (p.cents <= 0 ? " is-zero" : "");
    return `<div class="${cls}" style="--h:${heights[i].toFixed(1)}%" title="${escapeHtml(tip)}"><i></i></div>`;
  }).join("");
  // 头部放峰值，轴上放起止 —— 原来两处都写日期区间，同一句话说了两遍。
  // 回落那条路照实说自己只看了最近 200 条明细，别把半天的图端成整段历史。
  const note = series.source === "server"
    ? `${T("billing.peak", "峰值")} ${fmtUsd(peak)}`
    : T("billing.fromRecent", "按最近 200 条明细统计");
  const axis = `<div class="bill__axis" translate="no"><span>${escapeHtml(shortDay(series.from))}</span>` +
    `<span>${escapeHtml(shortDay(series.to))}</span></div>`;
  return section(T("billing.daily", "每日消费"), note, `<div class="bill__chart">${bars}</div>${axis}`);
}

function modelSection(data, { fmtUsd, T }) {
  const rows = modelRows(data);
  if (!rows.length) return "";
  const inner = rows.map((r) => {
    const name = r.isRest ? T("billing.other", "其他") : r.model;
    return `<div class="bill__mrow${r.isRest ? " is-rest" : ""}">` +
    `<span class="bill__mname" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
    `<span class="bill__mbar"><i style="width:${(r.share * 100).toFixed(1)}%"></i></span>` +
    `<span class="bill__mcost" translate="no">${escapeHtml(fmtUsd(r.cents))}</span>` +
    `<span class="bill__mshare" translate="no">${(r.share * 100).toFixed(0)}%</span></div>`;
  }).join("");
  return section(T("billing.byModel", "按模型"), "", `<div class="bill__models">${inner}</div>`);
}

/**
 * 这一笔是谁付的。判据全是这一行自己带的数：free_points_spent 是免费池付掉的点（1 点 = ¥0.01 =
 * 1 计费分），cost_cents 是这一笔的真实计费分。池子付满 = 免费点；付了一部分、剩下的落到额度或
 * 钱包 = 免费点+额度；一点没付 = 额度·钱包（网关这条明细不区分额度和钱包，不猜）。
 */
export function paymentSource(r) {
  const pts = Math.max(0, Number(r?.free_points_spent) || 0);
  const cents = Math.max(0, Number(r?.cost_cents) || 0);
  const ptsText = `${Math.round(pts * 1000) / 1000}`;
  if (pts <= 0) return { kind: "paid", pts, key: "billing.src.paid", fallback: "额度·钱包", title: "" };
  // 免费池按毫点扣（pts 是这次的真实花费），而 cost_cents 是它**向上取整**成的计费分。
  // 所以判据是「点数取整之后还盖得住这个分」——写成 `pts >= cents - 0.5` 会把
  // 6.238 点 / 7 分这种「池子其实全付了」的行误判成混合付（实测就是这一条红的）。
  if (Math.ceil(pts) >= cents) return { kind: "free", pts, key: "billing.src.free", fallback: "免费点", title: `免费点 ${ptsText}` };
  return { kind: "mixed", pts, key: "billing.src.mixed", fallback: "免费点+额度", title: `免费点 ${ptsText}，其余记入额度或钱包` };
}

function tableSection(data, ctx) {
  const { T } = ctx;
  const rows = Array.isArray(data?.recent) ? data.recent : [];
  const head = `<div class="bill__tr bill__tr--h">` +
    `<span>${escapeHtml(T("billing.time", "时间"))}</span>` +
    `<span>${escapeHtml(T("billing.model", "模型"))}</span>` +
    `<span class="n">${escapeHtml(T("billing.in", "输入"))}</span>` +
    `<span class="n">${escapeHtml(T("billing.cache", "缓存"))}</span>` +
    `<span class="n">${escapeHtml(T("billing.out", "输出"))}</span>` +
    `<span class="n">${escapeHtml(T("billing.cost", "费用"))}</span></div>`;
  const pager = rows.length > PER_PAGE
    ? `<div class="bill__pager"><button class="bill__pg" data-dir="prev" type="button" aria-label="${escapeHtml(T("billing.prev", "上一页"))}">${ctx.icon("left")}</button>` +
      `<span class="bill__pgi" translate="no"></span>` +
      `<button class="bill__pg" data-dir="next" type="button" aria-label="${escapeHtml(T("billing.next", "下一页"))}">${ctx.icon("right")}</button></div>`
    : "";
  return section(T("billing.detail", "明细"), "", `<div class="bill__table">${head}<div class="bill__rows"></div></div>${pager}`);
}

function wireTable(body, data, ctx) {
  const { fmtUsd, tokenShort, T, locale } = ctx;
  const rows = Array.isArray(data?.recent) ? data.recent : [];
  const host = body.querySelector(".bill__rows");
  if (!host) return;
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  let page = 0;

  const fmtTime = (v) => {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  const num = (v, reported) => (reported ? tokenShort(Math.max(0, Number(v) || 0)) : "—");

  const draw = () => {
    const slice = rows.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    host.innerHTML = slice.length
      ? slice.map((r) => {
        const reported = r?.usage_reported !== false;
        // **一列一种钱。** 上一版把免费池付的行印成「22.462 点」、其余行印成「$0.012」——
        // 同一列两种单位并排，所有者一眼读成「免费点扣了两千倍」（实拍 2026-09-07）。
        // 其实 1 点 = ¥0.01，22.462 点 = ¥0.22 ≈ $0.032，和旁边同量级。
        // 现在每行都印钱：cost_cents 就是这一笔的真实计费分，不管是谁付的；谁付的用
        // 一个小标签说（免费点 / 免费点+额度 / 额度·钱包），点数本身放进悬停。
        const src = paymentSource(r);
        const cost = fmtUsd(Number(r?.cost_cents) || 0);
        const cache = Math.max(0, Number(r?.cached_tokens) || 0) + Math.max(0, Number(r?.cache_creation_tokens) || 0);
        const tag = src.kind === "paid" ? "" : `<i class="bill__src bill__src--${src.kind}" title="${escapeHtml(src.title)}">${escapeHtml(T(src.key, src.fallback))}</i>`;
        return `<div class="bill__tr">` +
          `<span translate="no">${escapeHtml(fmtTime(r?.time))}</span>` +
          `<span class="bill__model" title="${escapeHtml(String(r?.model || "—"))}">${escapeHtml(String(r?.model || "—"))}</span>` +
          `<span class="n" translate="no">${escapeHtml(num(r?.prompt_tokens, reported))}</span>` +
          `<span class="n bill__dim" translate="no">${escapeHtml(reported && cache > 0 ? tokenShort(cache) : "—")}</span>` +
          `<span class="n" translate="no">${escapeHtml(num(r?.completion_tokens, reported))}</span>` +
          `<span class="n bill__cost" translate="no">${tag}${escapeHtml(cost)}</span></div>`;
      }).join("")
      : `<div class="bill__msg">${escapeHtml(T("billing.empty", "暂无记录"))}</div>`;
    const info = body.querySelector(".bill__pgi");
    if (info) info.textContent = `${page + 1} / ${pages}`;
    body.querySelectorAll(".bill__pg").forEach((btn) => {
      const next = btn.dataset.dir === "next";
      btn.disabled = next ? page >= pages - 1 : page <= 0;
      btn.onclick = () => { page += next ? 1 : -1; draw(); };
    });
  };
  draw();
}
