/**
 * 各数据库的目录查询与运维查询：库/模式/表/列/索引/外键/DDL/例程/服务器信息/会话列表，
 * 以及分页取数、按主键改数的 SQL 生成。每个函数只产出「要发给 db_query 的语句」和
 * 「怎么把结果归一化」——不碰网络、不碰 DOM，方便逐条对着真库验证。
 *
 * 同一套 API 覆盖 MySQL/MariaDB、PostgreSQL、SQLite、SQL Server、ClickHouse，
 * MongoDB / Elasticsearch / Redis 给能给的那几样（列出集合、取样、计数）。不支持的
 * 组合返回 null，调用方据此隐藏对应的页签，而不是发一条注定报错的语句。
 */
import { quoteIdent, sqlLiteral, isNumericType } from "./db-sql-tools.js";

const SQL_DRIVERS = new Set(["mysql", "mariadb", "postgres", "sqlite", "mssql", "clickhouse"]);

export function isSqlDriver(driver) {
  return SQL_DRIVERS.has(driver);
}

/** 这个引擎有没有「库」这一层（能列出并切换）。 */
export function hasDatabases(driver) {
  return ["mysql", "mariadb", "postgres", "mssql", "clickhouse", "mongodb"].includes(driver);
}

/** 这个引擎有没有「模式」这一层。 */
export function hasSchemas(driver) {
  return driver === "postgres" || driver === "mssql";
}

export function defaultSchema(driver) {
  if (driver === "postgres") return "public";
  if (driver === "mssql") return "dbo";
  return "";
}

const lit = (s) => "'" + String(s ?? "").replaceAll("'", "''") + "'";

/** schema.table（有模式的引擎）或 table。 */
export function qualifiedName(driver, table, schema = "") {
  const t = quoteIdent(driver, table);
  return schema && hasSchemas(driver) ? `${quoteIdent(driver, schema)}.${t}` : t;
}

// ---- 库 / 模式 ------------------------------------------------------------------

export function listDatabasesQuery(driver) {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY SCHEMA_NAME";
    case "postgres":
      return "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname";
    case "mssql":
      return "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY (CASE WHEN database_id <= 4 THEN 1 ELSE 0 END), name";
    case "clickhouse":
      return "SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name";
    case "mongodb":
      return '{"listDatabases": 1, "nameOnly": true}';
    default:
      return null;
  }
}

export function parseDatabasesResult(driver, out) {
  if (driver === "mongodb") {
    const list = out?.result?.databases;
    return Array.isArray(list) ? list.map((d) => d?.name).filter(Boolean) : [];
  }
  return (out?.rows || []).map((r) => r?.[0]).filter((x) => typeof x === "string" && x);
}

export function listSchemasQuery(driver) {
  if (driver === "postgres") {
    return "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY (nspname <> 'public'), nspname";
  }
  if (driver === "mssql") {
    return "SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db\\_%' ESCAPE '\\' ORDER BY (CASE WHEN name = 'dbo' THEN 0 ELSE 1 END), name";
  }
  return null;
}

// ---- 表 / 视图 -------------------------------------------------------------------

/** 列表结果统一成 [{name, table_type, row_count, comment, engine}]。 */
export function listTablesQuery(driver, { schema = "" } = {}) {
  const s = schema || defaultSchema(driver);
  switch (driver) {
    case "mysql":
    case "mariadb":
      return "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME";
    case "postgres":
      // reltuples 是规划器估算；-1 表示从没 ANALYZE 过，NULLIF 让它如实变成 null（UI 画成 —）。
      return `SELECT c.relname, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END, NULLIF(c.reltuples::bigint, -1), obj_description(c.oid, 'pg_class'), CASE c.relkind WHEN 'm' THEN 'materialized' WHEN 'p' THEN 'partitioned' ELSE '' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${lit(s)} AND c.relkind IN ('r','v','m','p') ORDER BY c.relname`;
    case "sqlite":
      return "SELECT name, type, NULL, NULL, NULL FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
    case "mssql":
      return `SELECT t.TABLE_NAME, t.TABLE_TYPE, (SELECT SUM(p.rows) FROM sys.partitions p JOIN sys.tables st ON st.object_id = p.object_id JOIN sys.schemas ss ON ss.schema_id = st.schema_id WHERE ss.name = t.TABLE_SCHEMA AND st.name = t.TABLE_NAME AND p.index_id IN (0,1)), NULL, NULL FROM INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_SCHEMA = ${lit(s)} ORDER BY t.TABLE_NAME`;
    case "clickhouse":
      return "SELECT name, if(engine LIKE '%View', 'view', 'table'), total_rows, comment, engine FROM system.tables WHERE database = currentDatabase() ORDER BY name";
    case "mongodb":
      return '{"listCollections": 1, "nameOnly": true}';
    case "elastic":
      return "GET /_cat/indices?format=json&h=index,docs.count,store.size&s=index";
    default:
      return null;
  }
}

export function parseTablesResult(driver, out) {
  if (driver === "mongodb") {
    const batch = out?.result?.cursor?.firstBatch || [];
    return batch.map((c) => ({ name: c?.name, table_type: String(c?.type || "") === "view" ? "view" : "table", row_count: null, comment: "", engine: "" })).filter((t) => t.name);
  }
  if (driver === "elastic") {
    const list = Array.isArray(out?.result) ? out.result : [];
    return list.map((x) => ({ name: x?.index, table_type: "table", row_count: Number(x?.["docs.count"]) || null, comment: x?.["store.size"] || "", engine: "" })).filter((t) => t.name && !String(t.name).startsWith("."));
  }
  return (out?.rows || []).map((r) => {
    const type = String(r?.[1] || "").toLowerCase();
    return {
      name: r?.[0],
      table_type: type.includes("view") ? "view" : "table",
      row_count: typeof r?.[2] === "number" ? r[2] : null,
      comment: r?.[3] == null ? "" : String(r[3]),
      engine: r?.[4] == null ? "" : String(r[4]),
    };
  }).filter((t) => typeof t.name === "string" && t.name);
}

// ---- 列 --------------------------------------------------------------------------

export function columnsQuery(driver, table, { schema = "" } = {}) {
  const s = schema || defaultSchema(driver);
  switch (driver) {
    case "mysql":
    case "mariadb":
      return `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${lit(table)} ORDER BY ORDINAL_POSITION`;
    case "postgres":
      return `SELECT a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, pg_get_expr(d.adbin, d.adrelid), CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) THEN 'PRI' ELSE '' END, CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' ELSE '' END, col_description(c.oid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = ${lit(s)} AND c.relname = ${lit(table)} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
    case "sqlite":
      return `PRAGMA table_info(${quoteIdent("sqlite", table)})`;
    case "mssql":
      return `SELECT c.COLUMN_NAME, c.DATA_TYPE + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) END + ')' WHEN c.NUMERIC_PRECISION IS NOT NULL AND c.DATA_TYPE IN ('decimal','numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(10)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(10)) + ')' ELSE '' END, c.IS_NULLABLE, c.COLUMN_DEFAULT, CASE WHEN k.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END, CASE WHEN COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') = 1 THEN 'identity' ELSE '' END, '' FROM INFORMATION_SCHEMA.COLUMNS c LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') k ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME WHERE c.TABLE_SCHEMA = ${lit(s)} AND c.TABLE_NAME = ${lit(table)} ORDER BY c.ORDINAL_POSITION`;
    case "clickhouse":
      return `SELECT name, type, if(type LIKE 'Nullable(%', 'YES', 'NO'), default_expression, if(is_in_primary_key, 'PRI', ''), default_kind, comment FROM system.columns WHERE database = currentDatabase() AND table = ${lit(table)} ORDER BY position`;
    case "mongodb":
      return `{"find": ${JSON.stringify(String(table))}, "limit": 1}`;
    case "elastic":
      return `GET /${encodeURIComponent(String(table))}/_mapping`;
    default:
      return null;
  }
}

/** 列结果 → [{name, type, nullable, default, pk, extra, comment}]。 */
export function parseColumnsResult(driver, out) {
  if (driver === "sqlite") {
    const cols = out?.columns || [];
    const ix = (n) => cols.indexOf(n);
    return (out?.rows || []).map((r) => ({
      name: String(r[ix("name")] ?? ""),
      type: String(r[ix("type")] ?? "") || "ANY",
      nullable: !Number(r[ix("notnull")]),
      default: r[ix("dflt_value")] == null ? null : String(r[ix("dflt_value")]),
      pk: Number(r[ix("pk")]) > 0,
      extra: "",
      comment: "",
    })).filter((c) => c.name);
  }
  if (driver === "mongodb") {
    const doc = out?.result?.cursor?.firstBatch?.[0];
    if (!doc || typeof doc !== "object") return [];
    return Object.entries(doc).map(([k, v]) => ({ name: k, type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v, nullable: true, default: null, pk: k === "_id", extra: "", comment: "" }));
  }
  if (driver === "elastic") {
    const res = out?.result;
    const idx = res && typeof res === "object" ? Object.values(res)[0] : null;
    const props = idx?.mappings?.properties;
    if (!props || typeof props !== "object") return [];
    return Object.entries(props).map(([k, v]) => ({ name: k, type: v?.type || (v?.properties ? "object" : ""), nullable: true, default: null, pk: false, extra: "", comment: "" }));
  }
  return (out?.rows || []).map((r) => ({
    name: String(r?.[0] ?? ""),
    type: String(r?.[1] ?? ""),
    nullable: String(r?.[2] ?? "YES").toUpperCase() !== "NO",
    default: r?.[3] == null ? null : String(r[3]),
    pk: String(r?.[4] ?? "").toUpperCase() === "PRI",
    extra: r?.[5] == null ? "" : String(r[5]),
    comment: r?.[6] == null ? "" : String(r[6]),
  })).filter((c) => c.name);
}

// ---- 索引 ------------------------------------------------------------------------

export function indexesQuery(driver, table, { schema = "" } = {}) {
  const s = schema || defaultSchema(driver);
  switch (driver) {
    case "mysql":
    case "mariadb":
      return `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), MIN(NON_UNIQUE), INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${lit(table)} GROUP BY INDEX_NAME, INDEX_TYPE ORDER BY (INDEX_NAME <> 'PRIMARY'), INDEX_NAME`;
    case "postgres":
      return `SELECT i.relname, pg_get_indexdef(ix.indexrelid), CASE WHEN ix.indisunique THEN 0 ELSE 1 END, am.amname, ix.indisprimary FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam WHERE n.nspname = ${lit(s)} AND t.relname = ${lit(table)} ORDER BY ix.indisprimary DESC, i.relname`;
    case "sqlite":
      return `SELECT name, sql, NULL, 'btree' FROM sqlite_master WHERE type = 'index' AND tbl_name = ${lit(table)} ORDER BY name`;
    case "mssql":
      return `SELECT i.name, STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, ''), CASE WHEN i.is_unique = 1 THEN 0 ELSE 1 END, i.type_desc, i.is_primary_key FROM sys.indexes i WHERE i.object_id = OBJECT_ID(${lit(`${s}.${table}`)}) AND i.name IS NOT NULL ORDER BY i.is_primary_key DESC, i.name`;
    case "clickhouse":
      return `SELECT 'PRIMARY', primary_key, 0, 'primary', 1 FROM system.tables WHERE database = currentDatabase() AND name = ${lit(table)} AND primary_key <> '' UNION ALL SELECT name, expr, 1, type, 0 FROM system.data_skipping_indices WHERE database = currentDatabase() AND table = ${lit(table)}`;
    default:
      return null;
  }
}

/** 索引结果 → [{name, columns, unique, primary, type}]。 */
export function parseIndexesResult(driver, out) {
  return (out?.rows || []).map((r) => {
    const name = String(r?.[0] ?? "");
    let columns = r?.[1] == null ? "" : String(r[1]);
    let primary = driver === "mysql" || driver === "mariadb" ? name.toUpperCase() === "PRIMARY" : !!(r?.[4] === true || r?.[4] === 1 || String(r?.[4]) === "true" || String(r?.[4]) === "1");
    if (driver === "postgres" || driver === "sqlite") {
      // pg_get_indexdef / sqlite_master.sql 是整条 CREATE INDEX；把括号里的列抠出来展示。
      const m = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:WHERE|$)?/i.exec(columns.replace(/\bINCLUDE\s*\([^)]*\)/i, ""));
      if (m) columns = m[1].trim();
      if (driver === "sqlite" && !r?.[1]) columns = "(自动索引)";
    }
    return {
      name,
      columns,
      unique: Number(r?.[2] ?? 1) === 0,
      primary,
      type: r?.[3] == null ? "" : String(r[3]),
    };
  }).filter((x) => x.name);
}

// ---- 外键 ------------------------------------------------------------------------

export function foreignKeysQuery(driver, table, { schema = "" } = {}) {
  const s = schema || defaultSchema(driver);
  switch (driver) {
    case "mysql":
    case "mariadb":
      return `SELECT k.CONSTRAINT_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), k.REFERENCED_TABLE_NAME, GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ${lit(table)} AND k.REFERENCED_TABLE_NAME IS NOT NULL GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.UPDATE_RULE, r.DELETE_RULE ORDER BY k.CONSTRAINT_NAME`;
    case "postgres":
      return `SELECT con.conname, (SELECT string_agg(a.attname, ', ' ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum), (SELECT n2.nspname || '.' || c2.relname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace WHERE c2.oid = con.confrelid), (SELECT string_agg(a.attname, ', ' ORDER BY x.ord) FROM unnest(con.confkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum), CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END, CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE con.contype = 'f' AND n.nspname = ${lit(s)} AND c.relname = ${lit(table)} ORDER BY con.conname`;
    case "sqlite":
      return `PRAGMA foreign_key_list(${quoteIdent("sqlite", table)})`;
    case "mssql":
      return `SELECT fk.name, STUFF((SELECT ', ' + cp.name FROM sys.foreign_key_columns fkc JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 2, ''), OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id), STUFF((SELECT ', ' + cr.name FROM sys.foreign_key_columns fkc JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 2, ''), fk.update_referential_action_desc, fk.delete_referential_action_desc FROM sys.foreign_keys fk WHERE fk.parent_object_id = OBJECT_ID(${lit(`${s}.${table}`)}) ORDER BY fk.name`;
    default:
      return null;
  }
}

/** 外键结果 → [{name, columns, refTable, refColumns, onUpdate, onDelete}]。 */
export function parseForeignKeysResult(driver, out) {
  if (driver === "sqlite") {
    const cols = out?.columns || [];
    const ix = (n) => cols.indexOf(n);
    const groups = new Map();
    for (const r of out?.rows || []) {
      const id = String(r[ix("id")]);
      const g = groups.get(id) || { name: `fk_${id}`, columns: [], refTable: String(r[ix("table")] ?? ""), refColumns: [], onUpdate: String(r[ix("on_update")] ?? ""), onDelete: String(r[ix("on_delete")] ?? "") };
      g.columns.push(String(r[ix("from")] ?? ""));
      g.refColumns.push(String(r[ix("to")] ?? ""));
      groups.set(id, g);
    }
    return [...groups.values()].map((g) => ({ ...g, columns: g.columns.join(", "), refColumns: g.refColumns.join(", ") }));
  }
  return (out?.rows || []).map((r) => ({
    name: String(r?.[0] ?? ""),
    columns: r?.[1] == null ? "" : String(r[1]),
    refTable: r?.[2] == null ? "" : String(r[2]),
    refColumns: r?.[3] == null ? "" : String(r[3]),
    onUpdate: r?.[4] == null ? "" : String(r[4]),
    onDelete: r?.[5] == null ? "" : String(r[5]),
  })).filter((x) => x.name);
}

// ---- DDL -------------------------------------------------------------------------

/** 引擎自己能吐 DDL 的：一条语句拿到；PG / MSSQL 返回 null，由 composeDdl 从目录拼。 */
export function ddlQuery(driver, table, { schema = "", view = false } = {}) {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return `SHOW CREATE ${view ? "VIEW" : "TABLE"} ${quoteIdent(driver, table)}`;
    case "sqlite":
      return `SELECT sql FROM sqlite_master WHERE (name = ${lit(table)} OR (type = 'index' AND tbl_name = ${lit(table)})) AND sql IS NOT NULL ORDER BY (type <> 'table' AND type <> 'view'), name`;
    case "clickhouse":
      return `SHOW CREATE TABLE ${quoteIdent(driver, table)}`;
    case "postgres":
      return view ? `SELECT pg_get_viewdef(${lit(qualifiedName("postgres", table, schema || "public"))}::regclass, true)` : null;
    default:
      return null;
  }
}

export function parseDdlResult(driver, out, { table = "", schema = "", view = false } = {}) {
  const rows = out?.rows || [];
  if (driver === "mysql" || driver === "mariadb") return rows[0]?.[1] == null ? "" : String(rows[0][1]);
  if (driver === "sqlite") return rows.map((r) => String(r?.[0] ?? "").trim()).filter(Boolean).map((s) => (s.endsWith(";") ? s : s + ";")).join("\n\n");
  if (driver === "clickhouse") return rows[0]?.[0] == null ? "" : String(rows[0][0]);
  if (driver === "postgres" && view) {
    const body = rows[0]?.[0] == null ? "" : String(rows[0][0]).trim();
    return body ? `CREATE OR REPLACE VIEW ${qualifiedName("postgres", table, schema || "public")} AS\n${body}` : "";
  }
  return rows[0]?.[0] == null ? "" : String(rows[0][0]);
}

/** 从目录信息拼一份可读的 CREATE TABLE（PG / MSSQL 用；其它引擎有原生语句）。 */
export function composeDdl(driver, table, { schema = "", columns = [], indexes = [], foreignKeys = [], comment = "" } = {}) {
  const name = qualifiedName(driver, table, schema || defaultSchema(driver));
  const lines = columns.map((c) => {
    const parts = [quoteIdent(driver, c.name), c.type || "TEXT"];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
    if (c.extra === "identity") parts.push(driver === "mssql" ? "IDENTITY(1,1)" : "GENERATED BY DEFAULT AS IDENTITY");
    return `  ${parts.join(" ")}`;
  });
  const pk = columns.filter((c) => c.pk).map((c) => quoteIdent(driver, c.name));
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  for (const fk of foreignKeys) {
    const cols = String(fk.columns || "").split(",").map((x) => quoteIdent(driver, x.trim())).join(", ");
    const refCols = String(fk.refColumns || "").split(",").map((x) => quoteIdent(driver, x.trim())).join(", ");
    let clause = `  CONSTRAINT ${quoteIdent(driver, fk.name)} FOREIGN KEY (${cols}) REFERENCES ${fk.refTable} (${refCols})`;
    if (fk.onUpdate && fk.onUpdate !== "NO ACTION" && fk.onUpdate !== "NO_ACTION") clause += ` ON UPDATE ${fk.onUpdate.replaceAll("_", " ")}`;
    if (fk.onDelete && fk.onDelete !== "NO ACTION" && fk.onDelete !== "NO_ACTION") clause += ` ON DELETE ${fk.onDelete.replaceAll("_", " ")}`;
    lines.push(clause);
  }
  const out = [`CREATE TABLE ${name} (\n${lines.join(",\n")}\n);`];
  for (const ix of indexes) {
    if (ix.primary) continue;
    out.push(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(driver, ix.name)} ON ${name} (${ix.columns});`);
  }
  if (comment) out.push(`COMMENT ON TABLE ${name} IS ${lit(comment)};`);
  for (const c of columns) if (c.comment) out.push(`COMMENT ON COLUMN ${name}.${quoteIdent(driver, c.name)} IS ${lit(c.comment)};`);
  return out.join("\n");
}

// ---- 函数 / 过程 -------------------------------------------------------------------

export function routinesQuery(driver, { schema = "" } = {}) {
  const s = schema || defaultSchema(driver);
  switch (driver) {
    case "mysql":
    case "mariadb":
      return "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_TYPE, ROUTINE_NAME";
    case "postgres":
      return `SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' WHEN 'w' THEN 'WINDOW' ELSE 'FUNCTION' END, pg_get_function_arguments(p.oid) || ' → ' || pg_get_function_result(p.oid), l.lanname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = ${lit(s)} ORDER BY 2, 1 LIMIT 1000`;
    case "sqlite":
      return "PRAGMA function_list";
    case "mssql":
      return `SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, '' FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ${lit(s)} ORDER BY ROUTINE_TYPE, ROUTINE_NAME`;
    case "clickhouse":
      return "SELECT name, 'FUNCTION', '', description FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name";
    default:
      return null;
  }
}

/** 例程结果 → [{name, type, signature, comment}]。 */
export function parseRoutinesResult(driver, out) {
  if (driver === "sqlite") {
    const cols = out?.columns || [];
    const nameIx = cols.indexOf("name");
    const typeIx = cols.indexOf("type");
    const argIx = cols.indexOf("narg");
    const seen = new Set();
    const list = [];
    for (const r of out?.rows || []) {
      const name = String(r[nameIx >= 0 ? nameIx : 0] ?? "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push({ name, type: String(r[typeIx] ?? "").toUpperCase() === "W" ? "WINDOW" : String(r[typeIx] ?? "").toUpperCase() === "A" ? "AGGREGATE" : "FUNCTION", signature: argIx >= 0 && r[argIx] != null ? `${r[argIx] < 0 ? "…" : r[argIx]} 参数` : "", comment: "" });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return (out?.rows || []).map((r) => ({
    name: String(r?.[0] ?? ""),
    type: String(r?.[1] ?? "FUNCTION").toUpperCase(),
    signature: r?.[2] == null ? "" : String(r[2]),
    comment: r?.[3] == null ? "" : String(r[3]),
  })).filter((x) => x.name);
}

// ---- 服务器信息 / 会话 ---------------------------------------------------------

/** 一组小查询，每条取第一行第一格（或指定格）。返回 [{key, label, sql, cell}]。 */
export function serverInfoQueries(driver) {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return [
        { key: "version", label: "版本", sql: "SELECT VERSION()", cell: 0 },
        { key: "database", label: "当前库", sql: "SELECT DATABASE()", cell: 0 },
        { key: "uptime", label: "已运行", sql: "SHOW GLOBAL STATUS LIKE 'Uptime'", cell: 1, seconds: true },
        { key: "connections", label: "当前连接", sql: "SHOW GLOBAL STATUS LIKE 'Threads_connected'", cell: 1 },
        { key: "size", label: "库大小", sql: "SELECT CONCAT(ROUND(COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) / 1048576, 1), ' MB') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", cell: 0 },
        { key: "charset", label: "字符集", sql: "SELECT CONCAT(@@character_set_database, ' / ', @@collation_database)", cell: 0 },
      ];
    case "postgres":
      return [
        { key: "version", label: "版本", sql: "SELECT version()", cell: 0 },
        { key: "database", label: "当前库 / 用户", sql: "SELECT current_database() || ' / ' || current_user", cell: 0 },
        { key: "uptime", label: "已运行", sql: "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint", cell: 0, seconds: true },
        { key: "connections", label: "当前连接", sql: "SELECT count(*)::text || ' / ' || current_setting('max_connections') FROM pg_stat_activity", cell: 0 },
        { key: "size", label: "库大小", sql: "SELECT pg_size_pretty(pg_database_size(current_database()))", cell: 0 },
        { key: "charset", label: "编码 / 时区", sql: "SELECT current_setting('server_encoding') || ' / ' || current_setting('TimeZone')", cell: 0 },
      ];
    case "sqlite":
      return [
        { key: "version", label: "版本", sql: "SELECT 'SQLite ' || sqlite_version()", cell: 0 },
        { key: "pages", label: "页数 × 页大小", sql: "SELECT (SELECT page_count FROM pragma_page_count()) || ' × ' || (SELECT page_size FROM pragma_page_size()) || ' B'", cell: 0 },
        { key: "journal", label: "日志模式", sql: "PRAGMA journal_mode", cell: 0 },
        { key: "encoding", label: "编码", sql: "PRAGMA encoding", cell: 0 },
        { key: "fk", label: "外键约束", sql: "SELECT CASE (SELECT foreign_keys FROM pragma_foreign_keys()) WHEN 1 THEN '开' ELSE '关' END", cell: 0 },
      ];
    case "mssql":
      return [
        { key: "version", label: "版本", sql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(64)) + ' ' + CAST(SERVERPROPERTY('Edition') AS varchar(128))", cell: 0 },
        { key: "database", label: "当前库", sql: "SELECT DB_NAME()", cell: 0 },
        { key: "uptime", label: "已运行", sql: "SELECT DATEDIFF(second, sqlserver_start_time, GETDATE()) FROM sys.dm_os_sys_info", cell: 0, seconds: true },
        { key: "connections", label: "当前连接", sql: "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1", cell: 0 },
        { key: "size", label: "库大小", sql: "SELECT CAST(CAST(SUM(size) * 8.0 / 1024 AS decimal(12,1)) AS varchar(32)) + ' MB' FROM sys.database_files", cell: 0 },
      ];
    case "clickhouse":
      return [
        { key: "version", label: "版本", sql: "SELECT version()", cell: 0 },
        { key: "database", label: "当前库", sql: "SELECT currentDatabase()", cell: 0 },
        { key: "uptime", label: "已运行", sql: "SELECT uptime()", cell: 0, seconds: true },
        { key: "size", label: "库大小", sql: "SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE database = currentDatabase() AND active", cell: 0 },
        { key: "tables", label: "表数", sql: "SELECT count() FROM system.tables WHERE database = currentDatabase()", cell: 0 },
      ];
    case "redis":
      return [
        { key: "server", label: "服务器", sql: "INFO server", raw: true },
        { key: "keys", label: "键数量", sql: "DBSIZE", raw: true },
        { key: "memory", label: "内存", sql: "INFO memory", raw: true },
      ];
    case "mongodb":
      return [
        { key: "build", label: "版本", sql: '{"buildInfo": 1}', raw: true, pick: "version" },
        { key: "stats", label: "库统计", sql: '{"dbStats": 1, "scale": 1048576}', raw: true, pick: "dataSize" },
      ];
    case "elastic":
      return [
        { key: "root", label: "集群", sql: "GET /", raw: true, pick: "version.number" },
        { key: "health", label: "健康", sql: "GET /_cluster/health", raw: true, pick: "status" },
      ];
    default:
      return [];
  }
}

/** 秒数 → 「3 天 4 小时」。 */
export function formatUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${Math.floor(s % 60)} 秒`;
}

/** 会话/进程列表：统一列 [id, user, host, db, state, seconds, wait, query]。 */
export function processListQuery(driver) {
  switch (driver) {
    case "mysql":
    case "mariadb":
      return "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 300) FROM information_schema.PROCESSLIST ORDER BY TIME DESC";
    case "postgres":
      return "SELECT pid, usename, COALESCE(client_addr::text, 'local'), datname, COALESCE(state, ''), COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::int, 0), COALESCE(wait_event_type, ''), LEFT(query, 300) FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY (pid = pg_backend_pid()), query_start DESC NULLS LAST";
    case "mssql":
      return "SELECT s.session_id, s.login_name, s.host_name, DB_NAME(s.database_id), s.status, COALESCE(r.total_elapsed_time / 1000, 0), COALESCE(r.wait_type, ''), LEFT(t.text, 300) FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE s.is_user_process = 1 ORDER BY s.session_id";
    case "clickhouse":
      return "SELECT query_id, user, toString(address), current_database, 'running', toInt64(elapsed), '', left(query, 300) FROM system.processes ORDER BY elapsed DESC";
    case "redis":
      return "CLIENT LIST";
    default:
      return null;
  }
}

export function killSessionQuery(driver, id) {
  const n = String(id ?? "").trim();
  if (!n) return null;
  switch (driver) {
    case "mysql":
    case "mariadb":
      return /^\d+$/.test(n) ? `KILL ${n}` : null;
    case "postgres":
      return /^\d+$/.test(n) ? `SELECT pg_terminate_backend(${n})` : null;
    case "mssql":
      return /^\d+$/.test(n) ? `KILL ${n}` : null;
    case "clickhouse":
      return `KILL QUERY WHERE query_id = ${lit(n)}`;
    case "redis":
      return /^\d+$/.test(n) ? `CLIENT KILL ID ${n}` : null;
    default:
      return null;
  }
}

// ---- 取数 / 计数 / 改数 ------------------------------------------------------------

export function countQuery(driver, table, { schema = "", where = "" } = {}) {
  const w = where ? ` WHERE ${where}` : "";
  if (driver === "mongodb") return `{"count": ${JSON.stringify(String(table))}}`;
  if (driver === "elastic") return `GET /${encodeURIComponent(String(table))}/_count`;
  if (!isSqlDriver(driver)) return null;
  return `SELECT COUNT(*) FROM ${qualifiedName(driver, table, schema)}${w}`;
}

/** 分页取数；orderBy 为空时 MSSQL 用 (SELECT NULL) 占位，其它引擎不排序。 */
export function selectPageQuery(driver, table, { schema = "", limit = 200, offset = 0, orderBy = "", orderDir = "asc", where = "" } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const off = Math.max(Number(offset) || 0, 0);
  const dir = String(orderDir).toLowerCase() === "desc" ? "DESC" : "ASC";
  if (driver === "mongodb") {
    const spec = { find: String(table), limit: lim, skip: off };
    if (orderBy) spec.sort = { [orderBy]: dir === "DESC" ? -1 : 1 };
    if (where) { try { spec.filter = JSON.parse(where); } catch { /* 非 JSON 的筛选忽略 */ } }
    return JSON.stringify(spec);
  }
  if (driver === "elastic") {
    const qs = [`size=${lim}`, `from=${off}`];
    if (orderBy) qs.push(`sort=${encodeURIComponent(orderBy)}:${dir.toLowerCase()}`);
    if (where) qs.push(`q=${encodeURIComponent(where)}`);
    return `GET /${encodeURIComponent(String(table))}/_search?${qs.join("&")}`;
  }
  if (!isSqlDriver(driver)) return null;
  const name = qualifiedName(driver, table, schema);
  const w = where ? ` WHERE ${where}` : "";
  const order = orderBy ? ` ORDER BY ${quoteIdent(driver, orderBy)} ${dir}` : "";
  if (driver === "mssql") {
    return `SELECT * FROM ${name}${w}${order || " ORDER BY (SELECT NULL)"} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`;
  }
  return `SELECT * FROM ${name}${w}${order} LIMIT ${lim}${off ? ` OFFSET ${off}` : ""}`;
}

/**
 * 网格编辑 → SQL。columns 是 parseColumnsResult 的结果（要 pk / type）；
 * rows 为原始行（数组）；changes = {rowIndex: {col: newValue}}；deletes = [rowIndex]；inserts = [{col: value}]。
 * 没有主键的表拒绝生成（返回 {error}）——按全部列匹配去改数是把多行一起改掉的常见事故。
 */
export function buildRowEditSql(driver, table, { schema = "", columns = [], rowColumns = [], rows = [], changes = {}, deletes = [], inserts = [] } = {}) {
  const pkCols = columns.filter((c) => c.pk).map((c) => c.name);
  const name = qualifiedName(driver, table, schema);
  const typeOf = (col) => columns.find((c) => c.name === col)?.type || "";
  const literal = (col, v) => sqlLiteral(v, { numeric: isNumericType(typeOf(col)), driver });
  const whereFor = (row) => pkCols.map((pk) => {
    const ix = rowColumns.indexOf(pk);
    const v = ix >= 0 ? row[ix] : undefined;
    return `${quoteIdent(driver, pk)} ${v === null || v === undefined ? "IS NULL" : "= " + literal(pk, v)}`;
  }).join(" AND ");
  const stmts = [];
  const needPk = Object.keys(changes).length || deletes.length;
  if (needPk && !pkCols.length) return { error: "这张表没有主键，工作台不生成按整行匹配的改数语句；请到查询里手写并自带 WHERE。", statements: [] };
  if (needPk && pkCols.some((pk) => rowColumns.indexOf(pk) < 0)) return { error: "结果集里没有主键列，无法定位要改的行。", statements: [] };
  for (const i of deletes) {
    const row = rows[i];
    if (!row) continue;
    stmts.push(`DELETE FROM ${name} WHERE ${whereFor(row)};`);
  }
  for (const [iStr, cols] of Object.entries(changes)) {
    const i = Number(iStr);
    if (deletes.includes(i)) continue;
    const row = rows[i];
    const sets = Object.entries(cols || {}).map(([c, v]) => `${quoteIdent(driver, c)} = ${literal(c, v)}`);
    if (!row || !sets.length) continue;
    stmts.push(`UPDATE ${name} SET ${sets.join(", ")} WHERE ${whereFor(row)};`);
  }
  for (const rec of inserts) {
    const cols = Object.keys(rec || {}).filter((c) => rec[c] !== undefined && rec[c] !== "");
    if (!cols.length) continue;
    stmts.push(`INSERT INTO ${name} (${cols.map((c) => quoteIdent(driver, c)).join(", ")}) VALUES (${cols.map((c) => literal(c, rec[c])).join(", ")});`);
  }
  return { error: "", statements: stmts };
}

/** 切换库：改写连接串里的库名（MySQL/PG/MSSQL/ClickHouse/Mongo）。sqlite/redis 没有这一层。 */
export function urlWithDatabase(driver, url, database) {
  const u = String(url || "");
  if (!database || !hasDatabases(driver)) return u;
  const m = /^([a-z+]+:\/\/[^/?#]*)(\/[^?#]*)?(\?.*)?$/i.exec(u);
  if (!m) return u;
  return `${m[1]}/${encodeURIComponent(database)}${m[3] || ""}`;
}

/** 从连接串里读当前库名。 */
export function databaseFromUrl(url) {
  const m = /^[a-z+]+:\/\/[^/?#]*\/([^/?#]+)/i.exec(String(url || ""));
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return m ? m[1] : ""; }
}
