/**
 * 查询历史与常用片段：纯数据操作，持久化由调用方决定（桌面端存 localStorage）。
 * 历史按时间倒序、封顶条数、同连接同语句去重保留最新一次；片段按名字唯一。
 */

export const DB_HISTORY_MAX = 300;

export function pushHistory(list, entry, max = DB_HISTORY_MAX) {
  const arr = Array.isArray(list) ? list : [];
  const e = {
    id: entry?.id || `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    connKey: String(entry?.connKey || ""),
    connName: String(entry?.connName || ""),
    driver: String(entry?.driver || ""),
    sql: String(entry?.sql || "").trim(),
    at: Number(entry?.at) || Date.now(),
    ms: Number(entry?.ms) || 0,
    rows: entry?.rows == null ? null : Number(entry.rows),
    ok: entry?.ok !== false,
    error: String(entry?.error || ""),
  };
  if (!e.sql) return arr;
  const rest = arr.filter((h) => !(h.connKey === e.connKey && h.sql === e.sql));
  return [e, ...rest].slice(0, max);
}

export function historyForConnection(list, connKey, { limit = 50, filter = "" } = {}) {
  const needle = String(filter || "").trim().toLowerCase();
  return (Array.isArray(list) ? list : [])
    .filter((h) => (!connKey || h.connKey === connKey) && (!needle || h.sql.toLowerCase().includes(needle)))
    .slice(0, limit);
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 日期。 */
export function formatRelativeTime(at, now = Date.now()) {
  const d = Math.max(0, now - Number(at || 0));
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 172_800_000) return "昨天";
  const date = new Date(Number(at));
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 一行摘要：折叠空白、截断。 */
export function sqlPreview(sql, max = 90) {
  const s = String(sql || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function upsertSnippet(list, snippet) {
  const arr = Array.isArray(list) ? list : [];
  const name = String(snippet?.name || "").trim();
  const sql = String(snippet?.sql || "").trim();
  if (!name || !sql) return arr;
  const rec = { name, sql, driver: String(snippet?.driver || ""), at: Date.now() };
  return [rec, ...arr.filter((s) => s.name !== name)].slice(0, 200);
}

export function removeSnippet(list, name) {
  return (Array.isArray(list) ? list : []).filter((s) => s.name !== name);
}
