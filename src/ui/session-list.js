// 会话列表的纯计算：排序、按项目过滤、按天分组、一行里的文案。
//
// 2026-09-07 所有者：「最新的排上面、旧的排下面；每个窗口只加载自己这个项目的会话，别的不显示；
// 换了文件夹要自动更新」。上一版三样都没有——顺序是「打开的标签 → 关掉的 → 归档的」三段各自
// 内部按下标，六百多条不分项目全堆在一起。
//
// 这里不碰 DOM、不读全局：每一行是 main.js 拼好的平对象（at / projectPath / stats …），
// 时间由调用方传进来，所以 test/session-picker.test.mjs 能直接喂假数据跑。

/** 路径归一：正斜杠、去掉尾部斜杠。两条路径是不是同一个项目，只按这个比。 */
export function normalizeRoot(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

export function sameProject(a, b) {
  const x = normalizeRoot(a); const y = normalizeRoot(b);
  return !!x && x === y;
}

/**
 * 最近活动在前。`at` 相同或都没有的保持原顺序（稳定排序），没时间戳的一律沉底——
 * 那是老数据，不该因为缺一个字段就冒到最上面。
 */
export function sortNewestFirst(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e, i) => ({ e, i, at: Number(e?.at) || 0 }))
    .sort((p, q) => (q.at - p.at) || (p.i - q.i))
    .map(({ e }) => e);
}

/**
 * 按项目过滤。`scope === "project"` 只留 projectPath 等于当前根目录的；没开文件夹时无从谈
 * 「这个项目」，退成全部。`"all"` 原样返回。
 */
export function scopeEntries(entries, root, scope = "project") {
  const list = Array.isArray(entries) ? entries : [];
  const r = normalizeRoot(root);
  if (scope !== "project" || !r) return list;
  return list.filter((e) => sameProject(e?.projectPath, r));
}

const DAY_MS = 86_400_000;

/** 本地日历上的「第几天」：同一天差 0，昨天差 1。用本地零点算，不用 UTC——用户看的是自己的日历。 */
function localDayIndex(ms) {
  const d = new Date(ms);
  return Math.floor((ms - d.getTimezoneOffset() * 60_000) / DAY_MS);
}

export const BUCKETS = ["today", "yesterday", "week", "older"];

export function dayBucket(at, now = Date.now()) {
  const t = Number(at) || 0;
  if (!t) return "older";
  const diff = localDayIndex(now) - localDayIndex(t);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "week";
  return "older";
}

/** 已排好序的行按天分组，空组不出现，组的顺序固定：今天 → 昨天 → 近 7 天 → 更早。 */
export function groupByDay(sorted, now = Date.now()) {
  const by = new Map(BUCKETS.map((b) => [b, []]));
  for (const e of Array.isArray(sorted) ? sorted : []) by.get(dayBucket(e?.at, now)).push(e);
  return BUCKETS.map((bucket) => ({ bucket, items: by.get(bucket) })).filter((g) => g.items.length);
}

const two = (n) => String(n).padStart(2, "0");

/**
 * 行尾那个时间：今天只给时刻，昨天写「昨天 HH:MM」，同年给 MM/DD，跨年带年份。
 * 越近的越具体——用户是在找「刚才那段」还是「上周那段」，这两种精度正好够。
 */
export function timeLabel(at, now = Date.now(), labels = {}) {
  const t = Number(at) || 0;
  if (!t) return "";
  const d = new Date(t); const n = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const diff = localDayIndex(now) - localDayIndex(t);
  if (diff <= 0) return hm;
  if (diff === 1) return `${labels.yesterday || "昨天"} ${hm}`;
  const md = `${two(d.getMonth() + 1)}/${two(d.getDate())}`;
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/**
 * 第二行的计数：轮数、文件线索、纠正。上一版印「6 turns · 6 msgs」，两个数十有八九相等，
 * 只是把同一件事说两遍；条数只在和轮数不同时才出现（说明有摘要折叠过）。零值一律不印。
 */
export function metaText(stats, labels = {}) {
  const s = stats || {};
  const turns = Number(s.totalTurns) || Number(s.recentCount) || 0;
  const msgs = Number(s.recentCount) || 0;
  const parts = [];
  if (turns) parts.push(`${turns} ${labels.turns || "轮"}`);
  if (msgs && msgs !== turns) parts.push(`${msgs} ${labels.msgs || "条"}`);
  if (Number(s.fileEvidenceCount) > 0) parts.push(`${Number(s.fileEvidenceCount)} ${labels.files || "文件"}`);
  if (Number(s.correctionCount) > 0) parts.push(`${Number(s.correctionCount)} ${labels.corrections || "纠正"}`);
  return parts.join(" · ");
}
