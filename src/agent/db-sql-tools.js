/**
 * SQL 文本工具：拆语句、分类（读/写/DDL/破坏性）、格式化、结果导出。
 *
 * 纯函数、零 DOM、零模块级可变状态——给数据库工作台用。判据一律先剥掉字面量和注释再看
 * （`INSERT INTO audit VALUES ('drop table users')` 是数据不是代码），拆语句同样要认得
 * 引号、注释和 PG 的 $$ 块，否则一个含分号的字符串就把一条语句拆成两半。
 */

const CLAUSE_BREAKS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET",
  "UNION ALL", "UNION", "EXCEPT", "INTERSECT", "INSERT INTO", "VALUES", "UPDATE", "SET",
  "DELETE FROM", "RETURNING", "WITH", "ON CONFLICT", "ON DUPLICATE KEY UPDATE",
];
const JOIN_BREAKS = [
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN", "LEFT JOIN", "RIGHT JOIN",
  "FULL JOIN", "INNER JOIN", "CROSS JOIN", "NATURAL JOIN", "JOIN",
];
const INLINE_KEYWORDS = [
  "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "ON", "USING", "LIKE", "ILIKE", "BETWEEN",
  "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "ASC", "DESC", "EXISTS", "ALL", "ANY",
  "TRUE", "FALSE", "CREATE", "TABLE", "VIEW", "INDEX", "ALTER", "DROP", "TRUNCATE", "PRIMARY",
  "KEY", "REFERENCES", "DEFAULT", "UNIQUE", "CONSTRAINT", "FOREIGN", "IF", "REPLACE", "INTO",
  "EXPLAIN", "ANALYZE", "SHOW", "DESCRIBE", "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST",
  "OVER", "PARTITION BY", "WINDOW", "FETCH", "NEXT", "ROWS", "ONLY", "TOP", "WITH",
];

/**
 * 逐字符扫描 SQL，把字面量/注释区域标出来。返回和源文本等长的掩码：
 * 0 = 代码，1 = 字面量或注释。拆语句、分类、格式化都建立在这一层上。
 * 认得：'…'（'' 转义）、"…"、`…`、[ … ]（MSSQL）、$tag$ … $tag$（PG）、-- 行注释、# 行注释、块注释。
 */
export function sqlMask(sql) {
  const s = String(sql || "");
  const mask = new Uint8Array(s.length);
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === "-" && next === "-") {
      const end = s.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === "#") {
      const end = s.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "\\" && ch !== "`") { j += 2; continue; }
        if (s[j] === ch) {
          if (s[j + 1] === ch) { j += 2; continue; } // '' 转义
          break;
        }
        j++;
      }
      const stop = Math.min(n, j + 1);
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === "[") {
      // MSSQL 的 [标识符]，只在看得到配对时当引用；否则就是普通字符（比如数组下标）。
      const end = s.indexOf("]", i + 1);
      if (end > 0 && end - i < 200 && !s.slice(i + 1, end).includes("\n")) {
        mask.fill(1, i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end + tag.length;
        mask.fill(1, i, stop);
        i = stop;
        continue;
      }
    }
    i++;
  }
  return mask;
}

/** 剥掉字面量和注释后的代码（原位置以空格占位，长度不变，方便回溯偏移）。 */
export function stripSqlLiterals(sql) {
  const s = String(sql || "");
  const mask = sqlMask(s);
  let out = "";
  for (let i = 0; i < s.length; i++) out += mask[i] ? " " : s[i];
  return out;
}

/**
 * 按分号拆成多条语句。返回 [{ sql, start, end }]，偏移指向原文，空语句丢掉。
 * 分号只在字面量/注释之外算数；最后一条没有分号也算一条。
 */
export function splitSqlStatements(sql) {
  const s = String(sql || "");
  const mask = sqlMask(s);
  const out = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const atEnd = i === s.length;
    if (atEnd || (s[i] === ";" && !mask[i])) {
      const raw = s.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      // 只有注释的片段不算语句。
      if (text && stripSqlLiterals(text).trim()) {
        out.push({ sql: text, start: start + lead, end: start + lead + text.length });
      }
      start = i + 1;
    }
  }
  return out;
}

const READ_VERBS = new Set(["SELECT", "SHOW", "PRAGMA", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE", "ANALYZE", "CHECK"]);
const WRITE_VERBS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT", "LOAD", "COPY", "IMPORT"]);
const DDL_VERBS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "COMMENT", "REINDEX", "VACUUM", "OPTIMIZE", "ATTACH", "DETACH"]);
const TX_VERBS = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SET", "USE", "LOCK", "UNLOCK", "CALL", "EXEC", "EXECUTE", "DO", "KILL"]);

/** 顶层（括号深度 0）出现的第一个关键字——CTE 后面才是真正的动词。 */
function topLevelVerb(code) {
  const tokens = code.toUpperCase().match(/\(|\)|[A-Z_][A-Z0-9_]*/g) || [];
  let depth = 0;
  let sawWith = false;
  for (const t of tokens) {
    if (t === "(") { depth++; continue; }
    if (t === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (t === "WITH") { sawWith = true; continue; }
    if (sawWith && (t === "RECURSIVE" || t === "AS")) continue;
    if (READ_VERBS.has(t) || WRITE_VERBS.has(t) || DDL_VERBS.has(t) || TX_VERBS.has(t)) return t;
    // CTE 名字之类的标识符，跳过。
  }
  return tokens.find((t) => t !== "(" && t !== ")") || "";
}

/**
 * 给一条语句定性。返回：
 *   kind: read | write | ddl | tx | other
 *   verb: 顶层动词（大写）
 *   destructive: 会丢数据或结构的（DROP / TRUNCATE / ALTER … DROP / 无 WHERE 的 DELETE、UPDATE）
 *   unbounded: 无 WHERE 的 DELETE / UPDATE
 *   mutates: 会改库（write / ddl）
 */
export function classifySql(sql, driver = "") {
  const raw = String(sql || "").trim();
  if (driver === "redis") {
    const verb = (raw.split(/\s+/)[0] || "").toUpperCase();
    const destructive = ["FLUSHALL", "FLUSHDB", "SWAPDB"].includes(verb);
    const writes = ["SET", "DEL", "HSET", "LPUSH", "RPUSH", "SADD", "ZADD", "INCR", "DECR", "EXPIRE", "RENAME", "MSET", "HDEL", "LPOP", "RPOP", "SREM", "ZREM", "PERSIST", "SETEX", "APPEND"].includes(verb);
    return { kind: destructive ? "ddl" : writes ? "write" : "read", verb, destructive, unbounded: false, mutates: destructive || writes };
  }
  if (driver === "mongodb") {
    let cmd = "";
    try { cmd = Object.keys(JSON.parse(raw))[0] || ""; } catch { cmd = ""; }
    const c = cmd.toLowerCase();
    const destructive = ["drop", "dropdatabase", "dropindexes"].includes(c) || (c === "delete" && /"limit"\s*:\s*0/.test(raw) && /"q"\s*:\s*\{\s*\}/.test(raw.replace(/\s/g, "")));
    const writes = ["insert", "update", "delete", "findandmodify", "create", "createindexes", "renamecollection"].includes(c);
    return { kind: destructive ? "ddl" : writes ? "write" : "read", verb: cmd, destructive, unbounded: false, mutates: destructive || writes };
  }
  if (driver === "elastic") {
    const verb = (raw.split(/\s+/)[0] || "").toUpperCase();
    const destructive = verb === "DELETE" && !/\/_doc\//.test(raw);
    return { kind: destructive ? "ddl" : verb === "GET" || verb === "HEAD" ? "read" : "write", verb, destructive, unbounded: false, mutates: verb !== "GET" && verb !== "HEAD" };
  }
  const code = stripSqlLiterals(raw);
  let verb = topLevelVerb(code);
  const upper = code.toUpperCase();
  const hasWhere = /\bWHERE\b/.test(upper);
  let kind = "other";
  if (READ_VERBS.has(verb)) kind = "read";
  else if (WRITE_VERBS.has(verb)) kind = "write";
  else if (DDL_VERBS.has(verb)) kind = "ddl";
  else if (TX_VERBS.has(verb)) kind = "tx";
  // 可写 CTE：`WITH d AS (DELETE FROM u RETURNING id) SELECT …` 顶层动词是 SELECT，
  // 但库真的会被改；EXPLAIN ANALYZE 同理会真的执行里面的语句。判据看整条代码。
  const innerWrite = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.exec(upper);
  if ((kind === "read" || verb === "WITH") && innerWrite && /^\s*(WITH|EXPLAIN)\b/.test(upper)) {
    kind = "write";
    verb = innerWrite[1];
  }
  const unbounded = (verb === "DELETE" || verb === "UPDATE") && !hasWhere;
  const destructive = verb === "DROP" || verb === "TRUNCATE" || unbounded
    || (verb === "ALTER" && /\bDROP\b/.test(upper));
  return { kind, verb, destructive, unbounded, mutates: kind === "write" || kind === "ddl" || (kind === "tx" && (verb === "CALL" || verb === "EXEC" || verb === "EXECUTE" || verb === "KILL")) };
}

/** 各方言的 EXPLAIN 写法；不支持的引擎返回 null。 */
export function explainSql(driver, sql, analyze = false) {
  const body = String(sql || "").trim().replace(/;\s*$/, "");
  if (!body) return null;
  switch (driver) {
    case "mysql":
    case "mariadb":
      return analyze ? `EXPLAIN ANALYZE ${body}` : `EXPLAIN FORMAT=TRADITIONAL ${body}`;
    case "postgres":
      return analyze ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${body}` : `EXPLAIN (FORMAT TEXT) ${body}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${body}`;
    case "clickhouse":
      return analyze ? `EXPLAIN PIPELINE ${body}` : `EXPLAIN PLAN ${body}`;
    case "mssql":
      return null; // SHOWPLAN 需要会话级 SET，单次连接做不了。
    default:
      return null;
  }
}

/** 标识符引用：MySQL 系反引号、MSSQL 方括号、其余双引号。 */
export function quoteIdent(driver, name) {
  const n = String(name ?? "");
  if (driver === "mysql" || driver === "mariadb" || driver === "clickhouse") return "`" + n.replaceAll("`", "``") + "`";
  if (driver === "mssql") return `[${n.replaceAll("]", "]]")}]`;
  return `"${n.replaceAll('"', '""')}"`;
}

/** 值 → SQL 字面量。数字列且值是数字不加引号；null / undefined → NULL；布尔按引擎；其余转义成字符串。 */
export function sqlLiteral(value, { numeric = false, driver = "" } = {}) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") {
    if (driver === "mssql" || driver === "sqlite") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "object") return "'" + JSON.stringify(value).replaceAll("'", "''") + "'";
  const s = String(value);
  if (numeric && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return s;
  if (driver === "mysql" || driver === "mariadb") return "'" + s.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  return "'" + s.replaceAll("'", "''") + "'";
}

/** 列类型名 → 是不是数值列（决定字面量要不要加引号）。 */
export function isNumericType(type) {
  return /\b(INT|INTEGER|SMALLINT|BIGINT|TINYINT|MEDIUMINT|SERIAL|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|NUMBER|MONEY|BIT|BOOL|BOOLEAN|UINT\d*|INT\d+|FLOAT\d+|DECIMAL\d*)\b/i.test(String(type || ""));
}

// ---- 格式化 ----------------------------------------------------------------

function tokenizeSql(sql) {
  const s = String(sql || "");
  const mask = sqlMask(s);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (mask[i]) {
      let j = i;
      while (j < s.length && mask[j]) j++;
      tokens.push({ type: "lit", text: s.slice(i, j) });
      i = j;
      continue;
    }
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_@#$\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && !mask[j] && /[A-Za-z0-9_$.\u0080-\uffff]/.test(s[j])) j++;
      tokens.push({ type: "word", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+-]/.test(s[j]) && !(s[j] === "-" && !/[eE]/.test(s[j - 1]))) j++;
      tokens.push({ type: "num", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push({ type: ch, text: ch }); i++; continue; }
    if (ch === ";") { tokens.push({ type: ";", text: ";" }); i++; continue; }
    let j = i + 1;
    while (j < s.length && !mask[j] && /[<>=!|:*\/%^~+-]/.test(s[j]) && /[<>=!|:*\/%^~+-]/.test(ch)) j++;
    tokens.push({ type: "op", text: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

function matchPhrase(tokens, at, phrases) {
  for (const phrase of phrases) {
    const words = phrase.split(" ");
    let ok = true;
    for (let k = 0; k < words.length; k++) {
      const t = tokens[at + k];
      if (!t || t.type !== "word" || t.text.toUpperCase() !== words[k]) { ok = false; break; }
    }
    if (ok) return { phrase, length: words.length };
  }
  return null;
}

/**
 * 轻量格式化：关键字大写、主要子句另起一行、AND/OR 缩进换行、SELECT 列表逐列换行、
 * 子查询按所在行缩进一级、函数调用紧贴函数名。只动字面量和注释之外的空白，语义不变。
 */
export function formatSql(sql, { keywordCase = "upper", indent = "  " } = {}) {
  const src = String(sql || "");
  if (!src.trim()) return "";
  const tokens = tokenizeSql(src);
  const KW = new Set([...CLAUSE_BREAKS, ...JOIN_BREAKS, ...INLINE_KEYWORDS].flatMap((p) => p.split(" ")));
  const caseWord = (w) => (keywordCase === "upper" ? w.toUpperCase() : keywordCase === "lower" ? w.toLowerCase() : w);
  // 这些词后面的括号是分组/子查询，要留空格；其它标识符后面的括号是函数调用，紧贴。
  const SPACE_BEFORE_PAREN = new Set(["IN", "AND", "OR", "NOT", "VALUES", "ON", "AS", "EXISTS", "THEN", "ELSE", "WHEN", "SELECT", "FROM", "WHERE", "JOIN", "HAVING", "BY", "SET", "UNION", "ALL", "ANY", "SOME", "INTO", "RETURNING", "DISTINCT", "OVER", "USING", "KEY", "REFERENCES", "CHECK", "DEFAULT", "LIKE", "ILIKE", "BETWEEN", "IS", "TABLE", "INDEX", "VIEW", "CONFLICT", "UPDATE", "DELETE", "INSERT", "WITH", "EXCEPT", "INTERSECT", "LIMIT", "OFFSET", "CASE", "END", "="]);
  // `INSERT INTO t (…)` / `CREATE TABLE t (…)`：表名后面的括号不是函数调用。
  const TABLE_INTRO = new Set(["INTO", "TABLE", "VIEW", "INDEX", "FUNCTION", "PROCEDURE", "TRIGGER", "REFERENCES", "JOIN", "FROM", "UPDATE"]);
  let out = "";
  let curIndent = "";
  let lineStart = true;
  const parenStack = []; // { sub, selectList, indentBefore, closeIndent }
  let inSelectList = false;
  let prev = null;
  let prev2 = null;
  const lineIndentNow = () => (out.slice(out.lastIndexOf("\n") + 1).match(/^[ \t]*/) || [""])[0];
  const nl = (extra = 0) => { out = out.replace(/[ \t]+$/, "") + "\n" + curIndent + indent.repeat(Math.max(0, extra)); lineStart = true; };
  const put = (text) => { if (!lineStart && !/^[,)]/.test(text) && !/\($/.test(out)) out += " "; out += text; lineStart = false; };
  const advance = (t) => { prev2 = prev; prev = t; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "lit") {
      if (/^(--|#)/.test(t.text)) { put(t.text); nl(); advance(t); continue; }
      put(t.text);
      advance(t);
      continue;
    }
    if (t.type === "(") {
      const sub = !!matchPhrase(tokens, i + 1, ["SELECT", "WITH"]);
      const afterTableName = prev && prev.type === "word" && prev2 && prev2.type === "word" && TABLE_INTRO.has(prev2.text.toUpperCase());
      const fnCall = !afterTableName && prev && (prev.type === "word" && !SPACE_BEFORE_PAREN.has(prev.text.toUpperCase()) || prev.type === ")");
      const closeIndent = lineIndentNow();
      if (fnCall && !lineStart) out = out.replace(/[ \t]+$/, "") + "(";
      else put("(");
      lineStart = false;
      parenStack.push({ sub, selectList: inSelectList, indentBefore: curIndent, closeIndent });
      inSelectList = false;
      if (sub) { curIndent = closeIndent + indent; nl(); }
      else { lineStart = true; }
      advance(t);
      continue;
    }
    if (t.type === ")") {
      const frame = parenStack.pop() || { sub: false, selectList: false, indentBefore: curIndent, closeIndent: "" };
      inSelectList = frame.selectList;
      curIndent = frame.indentBefore;
      out = out.replace(/[ \t]+$/, "") + (frame.sub ? "\n" + frame.closeIndent : "") + ")";
      lineStart = false;
      advance(t);
      continue;
    }
    if (t.type === ",") {
      out = out.replace(/[ \t]+$/, "") + ",";
      if (inSelectList) nl(1); else lineStart = false;
      advance(t);
      continue;
    }
    if (t.type === ";") { out = out.replace(/[ \t]+$/, "") + ";"; nl(); advance(t); continue; }
    if (t.type === "word") {
      const join = matchPhrase(tokens, i, JOIN_BREAKS);
      if (join) { nl(); put(caseWord(join.phrase)); i += join.length - 1; inSelectList = false; advance({ type: "word", text: "JOIN" }); continue; }
      const clause = matchPhrase(tokens, i, CLAUSE_BREAKS);
      if (clause) {
        if (!lineStart) nl();
        put(caseWord(clause.phrase));
        i += clause.length - 1;
        inSelectList = clause.phrase === "SELECT";
        if (clause.phrase === "SELECT") { const d = matchPhrase(tokens, i + 1, ["DISTINCT"]); if (d) { put(caseWord("DISTINCT")); i += 1; } nl(1); }
        advance({ type: "word", text: clause.phrase.split(" ").pop() });
        continue;
      }
      const upper = t.text.toUpperCase();
      if ((upper === "AND" || upper === "OR") && !inSelectList && !parenStack.some((f) => !f.sub)) { nl(1); put(caseWord(upper)); advance(t); continue; }
      put(KW.has(upper) ? caseWord(upper) : t.text);
      advance(t);
      continue;
    }
    put(t.text);
    advance(t);
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + (src.trim().endsWith(";") && !out.trim().endsWith(";") ? ";" : "");
}

// ---- 结果导出 ----------------------------------------------------------------

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function rowsToCsv(columns, rows, { delimiter = ",", header = true } = {}) {
  const esc = (s) => {
    const t = cellText(s);
    return /[",\n\r\t]/.test(t) || t.includes(delimiter) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  const lines = [];
  if (header) lines.push(columns.map(esc).join(delimiter));
  for (const r of rows) lines.push(columns.map((c, j) => esc(Array.isArray(r) ? r[j] : r?.[c])).join(delimiter));
  return lines.join("\n");
}

export function rowsToJson(columns, rows) {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, Array.isArray(r) ? r[j] : r?.[c]]))), null, 2);
}

export function rowsToMarkdown(columns, rows) {
  const esc = (s) => cellText(s).replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [`| ${columns.map(esc).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${columns.map((c, j) => esc(Array.isArray(r) ? r[j] : r?.[c])).join(" | ")} |`);
  return lines.join("\n");
}

/** 结果集 → INSERT 语句（每行一条），数值按值判断，其余走字符串字面量。 */
export function rowsToInsertSql(driver, table, columns, rows, { numericCols = null } = {}) {
  const t = quoteIdent(driver, table);
  const cols = columns.map((c) => quoteIdent(driver, c)).join(", ");
  const numeric = new Set(numericCols || []);
  return rows.map((r) => {
    const vals = columns.map((c, j) => {
      const v = Array.isArray(r) ? r[j] : r?.[c];
      return sqlLiteral(v, { numeric: numeric.has(c) || typeof v === "number", driver });
    });
    return `INSERT INTO ${t} (${cols}) VALUES (${vals.join(", ")});`;
  }).join("\n");
}

/** 客户端侧的筛选 + 排序（本地文件或已经拿到的结果集用）。 */
export function filterAndSortRows(columns, rows, { filter = "", sortCol = "", sortDir = "asc" } = {}) {
  let list = Array.isArray(rows) ? rows.slice() : [];
  const needle = String(filter || "").trim().toLowerCase();
  if (needle) list = list.filter((r) => r.some((v) => cellText(v).toLowerCase().includes(needle)));
  const idx = columns.indexOf(sortCol);
  if (idx >= 0) {
    const dir = sortDir === "desc" ? -1 : 1;
    list.sort((a, b) => {
      const x = a[idx], y = b[idx];
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }
  return list;
}
