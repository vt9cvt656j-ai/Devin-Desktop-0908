/**
 * 数据库连接档案：结构化字段 ⇄ 连接串、环境标签、分组、只读、密码打码。
 *
 * 原来一条连接只有 {id, name, driver, url}。企业里用的是「哪个环境、哪个组、能不能写」——
 * 生产库要一眼看出来、要默认只读、要在写之前拦一下。这里只做纯数据变换，存取仍在调用方。
 */

export const DB_ENVIRONMENTS = [
  ["dev", "开发", "#2fb15a"],
  ["test", "测试", "#3b82f6"],
  ["staging", "预发", "#f59e0b"],
  ["prod", "生产", "#ef4444"],
];

export const DB_DEFAULT_PORTS = {
  mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433, mongodb: 27017,
  redis: 6379, clickhouse: 8123, elastic: 9200, sqlite: 0,
};

const SCHEMES = {
  mysql: "mysql", mariadb: "mysql", postgres: "postgres", mssql: "mssql", mongodb: "mongodb",
  redis: "redis", clickhouse: "clickhouse", elastic: "http", sqlite: "",
};

export function envMeta(env) {
  const hit = DB_ENVIRONMENTS.find(([id]) => id === env);
  if (!hit) return { id: "", label: "", color: "" };
  return { id: hit[0], label: hit[1], color: hit[2] };
}

/** 结构化字段 → 连接串。填了 url 且没填 host 的老档案原样返回 url。 */
export function buildConnectionUrl(profile) {
  const p = profile || {};
  const driver = String(p.driver || "mysql");
  if (driver === "sqlite") return String(p.path || p.url || "").trim();
  if (!p.host && p.url) return String(p.url).trim();
  const scheme = p.scheme || (driver === "elastic" ? (p.ssl ? "https" : "http") : SCHEMES[driver]) || driver;
  const user = p.user ? encodeURIComponent(String(p.user)) : "";
  const pass = p.password ? encodeURIComponent(String(p.password)) : "";
  const auth = user ? `${user}${pass ? ":" + pass : ""}@` : (pass && driver === "redis" ? `:${pass}@` : "");
  const host = String(p.host || "127.0.0.1").trim();
  const port = Number(p.port) || DB_DEFAULT_PORTS[driver] || 0;
  const hostPart = /:/.test(host) && !host.startsWith("[") ? `[${host}]` : host; // IPv6
  const database = p.database ? "/" + encodeURIComponent(String(p.database)) : (driver === "redis" ? "/0" : "");
  const params = [];
  if (p.ssl) {
    if (driver === "mysql" || driver === "mariadb") params.push("ssl-mode=REQUIRED");
    else if (driver === "postgres") params.push("sslmode=require");
    else if (driver === "mssql") params.push("encrypt=true");
    else if (driver === "mongodb") params.push("tls=true");
    else if (driver === "redis") return `rediss://${auth}${hostPart}:${port}${database}`;
  } else if (driver === "mssql") {
    params.push("encrypt=off");
  }
  if (p.params) params.push(String(p.params).replace(/^\?/, ""));
  const srv = driver === "mongodb" && p.srv;
  const portPart = srv ? "" : port ? `:${port}` : "";
  return `${srv ? "mongodb+srv" : scheme}://${auth}${hostPart}${portPart}${database}${params.length ? "?" + params.join("&") : ""}`;
}

/** 连接串 → 结构化字段（解析不了的留空，url 原样保留）。 */
export function parseConnectionUrl(driver, url) {
  const u = String(url || "").trim();
  const out = { driver, host: "", port: "", user: "", password: "", database: "", ssl: false, srv: false, params: "" };
  if (driver === "sqlite") { out.path = sqlitePathFromUrl(u); return out; }
  const m = /^([a-z+]+):\/\/(?:([^:@/]*)(?::([^@]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(u);
  if (!m) return out;
  const dec = (s) => { try { return decodeURIComponent(s || ""); } catch { return s || ""; } };
  out.scheme = m[1];
  out.srv = m[1] === "mongodb+srv";
  out.user = dec(m[2]);
  out.password = dec(m[3]);
  out.host = (m[4] || "").replace(/^\[|\]$/g, "");
  out.port = m[5] ? Number(m[5]) : "";
  out.database = dec(m[6]);
  const params = m[7] || "";
  out.ssl = /(?:^|&)(?:sslmode=(?:require|verify-ca|verify-full)|ssl-mode=(?:REQUIRED|VERIFY_CA|VERIFY_IDENTITY)|encrypt=true|tls=true)(?:&|$)/i.test(params) || m[1] === "rediss" || m[1] === "https";
  out.params = params.split("&").filter((kv) => kv && !/^(sslmode|ssl-mode|encrypt|tls)=/i.test(kv)).join("&");
  return out;
}

/** sqlite:///abs/path.db → /abs/path.db；sqlite://rel.db → rel.db；裸路径原样。 */
export function sqlitePathFromUrl(url) {
  const u = String(url || "").trim();
  if (!/^sqlite:/i.test(u)) return u;
  const rest = u.replace(/^sqlite:/i, "");
  if (rest.startsWith("///")) return rest.slice(2);
  if (rest.startsWith("//")) return rest.slice(2);
  return rest.replace(/^\/+/, "/");
}

/** 老档案 {id,name,driver,url} → 完整档案；已经是新档案的原样补默认值。 */
export function normalizeSavedConnection(raw) {
  const c = raw && typeof raw === "object" ? { ...raw } : {};
  c.id = String(c.id || "");
  c.driver = String(c.driver || "mysql");
  c.name = String(c.name || "");
  c.group = String(c.group || "");
  c.env = DB_ENVIRONMENTS.some(([id]) => id === c.env) ? c.env : "";
  c.readOnly = !!c.readOnly;
  c.notes = String(c.notes || "");
  c.color = String(c.color || "");
  if (!c.host && c.url && c.driver !== "sqlite") {
    const parsed = parseConnectionUrl(c.driver, c.url);
    Object.assign(c, { host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.password, database: parsed.database, ssl: parsed.ssl, srv: parsed.srv, params: parsed.params });
  }
  if (c.driver === "sqlite" && !c.path && c.url) c.path = sqlitePathFromUrl(c.url);
  c.url = buildConnectionUrl(c) || String(c.url || "");
  return c;
}

/** 档案里除密码外的展示地址：user@host:port/database。 */
export function connectionAddress(profile) {
  const p = profile || {};
  if (p.driver === "sqlite") return String(p.path || p.url || "");
  const parsed = p.host ? p : parseConnectionUrl(p.driver, p.url);
  const host = parsed.host || "";
  const port = parsed.port ? `:${parsed.port}` : "";
  const db = parsed.database ? `/${parsed.database}` : "";
  return `${parsed.user ? parsed.user + "@" : ""}${host}${port}${db}`;
}

/** 缺省名称：库名或主机名，本地文件用文件名。 */
export function defaultConnectionName(profile) {
  const p = profile || {};
  if (p.driver === "sqlite") return String(p.path || p.url || "SQLite").split("/").pop() || "SQLite";
  const parsed = p.host ? p : parseConnectionUrl(p.driver, p.url);
  return parsed.database ? `${parsed.database} @ ${parsed.host || "server"}` : `${p.driver} @ ${parsed.host || "server"}`;
}

/** 按 group 分组，组内保持原顺序；没有组的放最前面的「未分组」。 */
export function groupConnections(list) {
  const groups = new Map();
  for (const c of list || []) {
    const g = String(c?.group || "");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])));
}

/** 生产 / 只读连接上跑会改库的语句前要不要拦。返回 {block, confirm, reason}。 */
export function writeGuard(profile, classification) {
  const p = profile || {};
  const cls = classification || {};
  if (!cls.mutates) return { block: false, confirm: false, reason: "" };
  if (p.readOnly) return { block: true, confirm: false, reason: `连接「${p.name || p.driver}」设为只读，改库语句不会执行。` };
  if (p.env === "prod") return { block: false, confirm: true, reason: `这是生产环境（${p.name || p.driver}），${cls.destructive ? "而且这条语句会丢数据或结构" : "确认后才执行"}。` };
  if (cls.destructive) return { block: false, confirm: true, reason: cls.unbounded ? "这条语句没有 WHERE，会改到整张表。" : "这条语句会删除数据或结构。" };
  return { block: false, confirm: false, reason: "" };
}
