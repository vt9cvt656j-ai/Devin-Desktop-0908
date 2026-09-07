// 数据库工作台的纯逻辑模块：拆语句 / 分类 / 格式化 / 导出、各引擎目录查询与结果归一化、
// 连接档案、历史、AI 消息。全部真跑函数、比行为——目录查询的 SQL 另外在本地 PG16 与 SQLite
// 上逐条执行过（见 ~/.mrday-scratch/dbwb-test），这里守的是形状与解析。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sqlMask, stripSqlLiterals, splitSqlStatements, classifySql, explainSql, quoteIdent, sqlLiteral,
  isNumericType, formatSql, rowsToCsv, rowsToJson, rowsToMarkdown, rowsToInsertSql, filterAndSortRows,
} from "../src/agent/db-sql-tools.js";
import * as D from "../src/agent/db-dialects.js";
import {
  buildConnectionUrl, parseConnectionUrl, normalizeSavedConnection, connectionAddress,
  defaultConnectionName, groupConnections, writeGuard, envMeta, DB_ENVIRONMENTS,
} from "../src/agent/db-connections.js";
import { pushHistory, historyForConnection, formatRelativeTime, sqlPreview, upsertSnippet, removeSnippet } from "../src/agent/db-history.js";
import { buildSqlAssistMessages, extractSqlFromReply, explanationFromReply, schemaDigest } from "../src/agent/db-ai.js";

// ---- SQL 文本工具 ----------------------------------------------------------------

test("字面量与注释被剥掉，代码位置不变；分号只在代码区拆", () => {
  const sql = "SELECT 'a;b' AS x, \"q;\" FROM t -- c;\nWHERE y = $$z;$$; /* ; */ UPDATE t SET a = 1";
  const code = stripSqlLiterals(sql);
  assert.equal(code.length, sql.length);
  assert.doesNotMatch(code, /a;b|q;|c;|z;/);
  const parts = splitSqlStatements(sql).map((p) => p.sql);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^SELECT 'a;b'/);
  assert.match(parts[1], /^\/\* ; \*\/ UPDATE t SET a = 1$/);
  // 偏移指向原文
  const [first] = splitSqlStatements(sql);
  assert.equal(sql.slice(first.start, first.end), first.sql);
  assert.equal(splitSqlStatements("-- 只有注释\n").length, 0);
  assert.equal(sqlMask("[a;b]")[2], 1, "MSSQL 方括号里的分号不算");
});

test("分类：读 / 写 / DDL / 破坏性 / 无 WHERE，可写 CTE 与 EXPLAIN ANALYZE 都算改库", () => {
  const c = (s) => classifySql(s);
  assert.equal(c("SELECT * FROM t").kind, "read");
  assert.equal(c("show tables").kind, "read");
  assert.equal(c("WITH x AS (SELECT 1) SELECT * FROM x").mutates, false);
  assert.deepEqual([c("DELETE FROM users").destructive, c("DELETE FROM users").unbounded], [true, true]);
  assert.equal(c("DELETE FROM users WHERE id = 1").destructive, false);
  assert.equal(c("UPDATE t SET a = 1").unbounded, true);
  assert.equal(c("DROP TABLE x").destructive, true);
  assert.equal(c("ALTER TABLE t DROP COLUMN c").destructive, true);
  assert.equal(c("ALTER TABLE t ADD COLUMN c int").destructive, false);
  assert.equal(c("TRUNCATE t").kind, "ddl");
  // 数据不是代码：字面量里的 drop 不触发
  assert.equal(c("INSERT INTO audit VALUES ('drop table users')").destructive, false);
  // 可写 CTE 与 EXPLAIN ANALYZE
  const cte = c("WITH d AS (DELETE FROM u RETURNING id) SELECT * FROM d");
  assert.deepEqual([cte.kind, cte.mutates, cte.destructive], ["write", true, true]);
  assert.equal(c("EXPLAIN ANALYZE DELETE FROM t WHERE a = 1").mutates, true);
  assert.equal(c("EXPLAIN SELECT 1").mutates, false);
  assert.equal(c("CALL p()").mutates, true);
  // 非 SQL 引擎
  assert.equal(classifySql("FLUSHALL", "redis").destructive, true);
  assert.equal(classifySql("GET k", "redis").mutates, false);
  assert.equal(classifySql('{"drop": "users"}', "mongodb").destructive, true);
  assert.equal(classifySql('{"find": "users"}', "mongodb").mutates, false);
  assert.equal(classifySql("DELETE /users", "elastic").destructive, true);
  assert.equal(classifySql("GET /_cat/indices", "elastic").mutates, false);
});

test("EXPLAIN 写法按方言；不支持的引擎返回 null", () => {
  assert.equal(explainSql("postgres", "SELECT 1;"), "EXPLAIN (FORMAT TEXT) SELECT 1");
  assert.match(explainSql("postgres", "SELECT 1", true), /ANALYZE, BUFFERS/);
  assert.equal(explainSql("mysql", "SELECT 1"), "EXPLAIN FORMAT=TRADITIONAL SELECT 1");
  assert.equal(explainSql("sqlite", "SELECT 1"), "EXPLAIN QUERY PLAN SELECT 1");
  assert.equal(explainSql("mssql", "SELECT 1"), null);
  assert.equal(explainSql("redis", "GET k"), null);
});

test("引用与字面量按引擎", () => {
  assert.equal(quoteIdent("mysql", "a`b"), "`a``b`");
  assert.equal(quoteIdent("mssql", "a]b"), "[a]]b]");
  assert.equal(quoteIdent("postgres", 'a"b'), '"a""b"');
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("it's", { driver: "mysql" }), "'it\\'s'");
  assert.equal(sqlLiteral("12", { numeric: true }), "12");
  assert.equal(sqlLiteral("12abc", { numeric: true }), "'12abc'");
  assert.equal(sqlLiteral(true, { driver: "sqlite" }), "1");
  assert.equal(sqlLiteral(true, { driver: "postgres" }), "TRUE");
  assert.equal(sqlLiteral({ a: 1 }), "'{\"a\":1}'");
  assert.ok(isNumericType("numeric(12,2)") && isNumericType("bigint") && !isNumericType("text") && isNumericType("UInt64"));
});

test("格式化：子句换行、SELECT 列表逐列、函数调用紧贴、子查询按所在行缩进、语义不变", () => {
  const out = formatSql("select a.id, count(*) as n, coalesce(sum(x),0) from orders a left join customers b on a.customer_id=b.id where a.status='paid' and b.tier in (select tier from tiers where active) group by a.id order by n desc limit 10;");
  assert.match(out, /^SELECT\n  a\.id,\n  COUNT\(\*\) AS n,\n  COALESCE\(SUM\(x\), 0\)\nFROM orders a\nLEFT JOIN customers b ON a\.customer_id = b\.id\nWHERE a\.status = 'paid'\n  AND b\.tier IN \(\n    SELECT\n      tier\n    FROM tiers\n    WHERE active\n  \)\nGROUP BY a\.id\nORDER BY n DESC\nLIMIT 10;$/);
  // 字面量原样、关键字大写只发生在代码区
  assert.match(formatSql("select 'select from' from t"), /^SELECT\n  'select from'\nFROM t$/);
  assert.match(formatSql("insert into t (a,b) values (1,'x')"), /^INSERT INTO t \(a, b\)\nVALUES \(1, 'x'\)$/);
  assert.equal(formatSql("   "), "");
  // 去掉空白后与原文等价（格式化不能改变 token 序列）
  const src = "UPDATE t SET a=1,b=now() WHERE id=5 AND deleted_at IS NULL";
  assert.equal(formatSql(src).replace(/\s+/g, "").toLowerCase(), src.replace(/\s+/g, "").toLowerCase());
});

test("导出：CSV 按 RFC4180 引号、JSON 按列名、Markdown 转义竖线、INSERT 按值定引号", () => {
  const cols = ["a", "b"];
  const rows = [[1, 'x,"y"'], [null, "p|q"]];
  assert.equal(rowsToCsv(cols, rows), 'a,b\n1,"x,""y"""\n,p|q');
  assert.deepEqual(JSON.parse(rowsToJson(cols, rows)), [{ a: 1, b: 'x,"y"' }, { a: null, b: "p|q" }]);
  assert.match(rowsToMarkdown(cols, rows), /\| 1 \| x,"y" \|\n\|  \| p\\\|q \|$/);
  assert.equal(rowsToInsertSql("postgres", "t", cols, [[1, "it's"]]), `INSERT INTO "t" ("a", "b") VALUES (1, 'it''s');`);
  assert.equal(rowsToInsertSql("mysql", "t", ["n"], [["5"]], { numericCols: ["n"] }), "INSERT INTO `t` (`n`) VALUES (5);");
  const sorted = filterAndSortRows(["k", "v"], [["b", 2], ["a", null], ["c", 1]], { sortCol: "v", sortDir: "asc" });
  assert.deepEqual(sorted.map((r) => r[0]), ["c", "b", "a"], "NULL 排最后");
  assert.deepEqual(filterAndSortRows(["k"], [["apple"], ["Berry"]], { filter: "BER" }).flat(), ["Berry"]);
});

// ---- 目录查询 -----------------------------------------------------------------

test("目录查询：每个 SQL 引擎都有表 / 列 / 索引 / 外键 / 例程 / 服务器信息 / 会话；标识符与字面量都转义", () => {
  for (const d of ["mysql", "mariadb", "postgres", "sqlite", "mssql", "clickhouse"]) {
    assert.ok(D.listTablesQuery(d), `${d} 表清单`);
    assert.ok(D.columnsQuery(d, "t"), `${d} 列`);
    assert.ok(D.indexesQuery(d, "t"), `${d} 索引`);
    assert.ok(D.routinesQuery(d), `${d} 例程`);
    assert.ok(D.serverInfoQueries(d).length >= 3, `${d} 服务器信息`);
    assert.ok(D.countQuery(d, "t"), `${d} 计数`);
    assert.ok(D.selectPageQuery(d, "t", { limit: 10, offset: 20 }), `${d} 分页`);
    if (d !== "sqlite") assert.ok(D.processListQuery(d), `${d} 会话`);
  }
  // 表名里的引号不能逃出字面量
  assert.match(D.columnsQuery("postgres", "it's", { schema: "app" }), /c\.relname = 'it''s'/);
  assert.match(D.columnsQuery("sqlite", 'a"b'), /PRAGMA table_info\("a""b"\)/);
  assert.match(D.selectPageQuery("mssql", "t", { schema: "dbo", limit: 5, offset: 10 }), /^SELECT \* FROM \[dbo\]\.\[t\] ORDER BY \(SELECT NULL\) OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY$/);
  assert.match(D.selectPageQuery("postgres", "orders", { schema: "app", limit: 3, offset: 2, orderBy: "amount", orderDir: "desc", where: "status = 'paid'" }), /^SELECT \* FROM "app"\."orders" WHERE status = 'paid' ORDER BY "amount" DESC LIMIT 3 OFFSET 2$/);
  assert.equal(D.selectPageQuery("mysql", "t", { limit: 5000 }).includes("LIMIT 2000"), true, "分页上限 2000");
  assert.equal(JSON.parse(D.selectPageQuery("mongodb", "c", { limit: 5, offset: 10, orderBy: "x", orderDir: "desc" })).sort.x, -1);
  assert.equal(D.killSessionQuery("postgres", "12"), "SELECT pg_terminate_backend(12)");
  assert.equal(D.killSessionQuery("mysql", "12; DROP"), null, "会话 id 只认数字");
  assert.equal(D.explainable ?? true, true);
});

test("结果归一化：列 / 索引 / 外键 / 例程 / 表清单在各引擎的真实形状上都能解析", () => {
  // PG 列（真库跑出来的形状）
  const pgCols = D.parseColumnsResult("postgres", { rows: [["id", "bigint", "NO", "nextval('app.orders_id_seq'::regclass)", "PRI", "", null], ["amount", "numeric(12,2)", "NO", null, "", "", "金额"]] });
  assert.deepEqual(pgCols.map((c) => [c.name, c.pk, c.nullable, c.comment]), [["id", true, false, ""], ["amount", false, false, "金额"]]);
  // SQLite PRAGMA table_info
  const sqCols = D.parseColumnsResult("sqlite", { columns: ["cid", "name", "type", "notnull", "dflt_value", "pk"], rows: [[0, "id", "INTEGER", 0, null, 1], [1, "name", "TEXT", 1, "'x'", 0]] });
  assert.deepEqual(sqCols.map((c) => [c.name, c.type, c.nullable, c.pk, c.default]), [["id", "INTEGER", true, true, null], ["name", "TEXT", false, false, "'x'"]]);
  // MySQL SHOW-ish（information_schema 列）
  const myCols = D.parseColumnsResult("mysql", { rows: [["id", "int(11)", "NO", null, "PRI", "auto_increment", ""]] });
  assert.deepEqual([myCols[0].pk, myCols[0].extra], [true, "auto_increment"]);
  // PG 索引：从 CREATE INDEX 文本里抠列
  const pgIdx = D.parseIndexesResult("postgres", { rows: [["orders_pkey", "CREATE UNIQUE INDEX orders_pkey ON app.orders USING btree (id)", 0, "btree", true], ["orders_customer_idx", "CREATE INDEX orders_customer_idx ON app.orders USING btree (customer_id, created_at DESC)", 1, "btree", false]] });
  assert.deepEqual(pgIdx.map((i) => [i.name, i.columns, i.unique, i.primary]), [["orders_pkey", "id", true, true], ["orders_customer_idx", "customer_id, created_at DESC", false, false]]);
  // SQLite 自动索引没有 sql
  assert.equal(D.parseIndexesResult("sqlite", { rows: [["sqlite_autoindex_t_1", null, null, "btree"]] })[0].columns, "(自动索引)");
  // MySQL 主键按名字
  assert.equal(D.parseIndexesResult("mysql", { rows: [["PRIMARY", "id", 0, "BTREE"]] })[0].primary, true);
  // 外键：SQLite 多列同一个 id 合并
  const fks = D.parseForeignKeysResult("sqlite", { columns: ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"], rows: [[0, 0, "c", "a1", "b1", "NO ACTION", "CASCADE", "NONE"], [0, 1, "c", "a2", "b2", "NO ACTION", "CASCADE", "NONE"]] });
  assert.deepEqual([fks.length, fks[0].columns, fks[0].refColumns, fks[0].onDelete], [1, "a1, a2", "b1, b2", "CASCADE"]);
  // 例程
  assert.deepEqual(D.parseRoutinesResult("postgres", { rows: [["total_for", "FUNCTION", "cid integer → numeric", "sql"]] })[0], { name: "total_for", type: "FUNCTION", signature: "cid integer → numeric", comment: "sql" });
  const sqFns = D.parseRoutinesResult("sqlite", { columns: ["name", "builtin", "type", "enc", "narg", "flags"], rows: [["pow", 1, "s", "utf8", 2, 0], ["pow", 1, "s", "utf8", 2, 0], ["sum", 1, "a", "utf8", 1, 0]] });
  assert.deepEqual(sqFns.map((f) => [f.name, f.type]), [["pow", "FUNCTION"], ["sum", "AGGREGATE"]], "重载去重");
  // 表清单
  assert.deepEqual(D.parseTablesResult("postgres", { rows: [["big_orders", "view", null, null, ""], ["orders", "table", 1000, "订单", ""]] }).map((t) => [t.name, t.table_type, t.row_count, t.comment]), [["big_orders", "view", null, ""], ["orders", "table", 1000, "订单"]]);
  assert.deepEqual(D.parseTablesResult("elastic", { result: [{ index: ".kibana", "docs.count": "1" }, { index: "logs", "docs.count": "42", "store.size": "1mb" }] }).map((t) => t.name), ["logs"], "系统索引不列");
  assert.deepEqual(D.parseDatabasesResult("mongodb", { result: { databases: [{ name: "admin" }, { name: "shop" }] } }), ["admin", "shop"]);
});

test("DDL：引擎能吐的用原生，PG / MSSQL 从目录拼；视图有自己的路", () => {
  assert.equal(D.ddlQuery("mysql", "t"), "SHOW CREATE TABLE `t`");
  assert.equal(D.ddlQuery("mysql", "v", { view: true }), "SHOW CREATE VIEW `v`");
  assert.equal(D.ddlQuery("postgres", "t"), null);
  assert.match(D.ddlQuery("postgres", "v", { schema: "app", view: true }), /pg_get_viewdef\('"app"\."v"'::regclass, true\)/);
  assert.equal(D.parseDdlResult("mysql", { rows: [["t", "CREATE TABLE `t` (...)"]] }), "CREATE TABLE `t` (...)");
  assert.equal(D.parseDdlResult("sqlite", { rows: [["CREATE TABLE t(id)"], ["CREATE INDEX i ON t(id)"]] }), "CREATE TABLE t(id);\n\nCREATE INDEX i ON t(id);");
  const ddl = D.composeDdl("postgres", "orders", {
    schema: "app",
    columns: [{ name: "id", type: "bigint", nullable: false, default: "nextval('s')", pk: true, extra: "", comment: "" }, { name: "amount", type: "numeric(12,2)", nullable: false, default: null, pk: false, extra: "", comment: "金额" }],
    indexes: [{ name: "orders_pkey", columns: "id", unique: true, primary: true }, { name: "orders_customer_idx", columns: "customer_id, created_at DESC", unique: false, primary: false }],
    foreignKeys: [{ name: "orders_customer_id_fkey", columns: "customer_id", refTable: "app.customers", refColumns: "id", onUpdate: "NO ACTION", onDelete: "CASCADE" }],
    comment: "订单",
  });
  assert.match(ddl, /^CREATE TABLE "app"\."orders" \(\n  "id" bigint NOT NULL DEFAULT nextval\('s'\),\n  "amount" numeric\(12,2\) NOT NULL,\n  PRIMARY KEY \("id"\),\n  CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY \("customer_id"\) REFERENCES app\.customers \("id"\) ON DELETE CASCADE\n\);\nCREATE INDEX "orders_customer_idx" ON "app"\."orders" \(customer_id, created_at DESC\);\nCOMMENT ON TABLE "app"\."orders" IS '订单';\nCOMMENT ON COLUMN "app"\."orders"\."amount" IS '金额';$/);
});

test("网格编辑 → SQL：按主键定位，没有主键拒绝，数值列不加引号，删改增顺序固定", () => {
  const columns = [{ name: "id", type: "int", pk: true }, { name: "name", type: "text", pk: false }, { name: "score", type: "numeric(5,2)", pk: false }];
  const out = D.buildRowEditSql("postgres", "t", { columns, rowColumns: ["id", "name", "score"], rows: [[1, "a", 1.5], [2, "b", null]], changes: { 0: { name: "a2", score: "3.25" }, 1: { name: "b2" } }, deletes: [1], inserts: [{ name: "c", score: "9" }, {}] });
  assert.equal(out.error, "");
  assert.deepEqual(out.statements, [
    `DELETE FROM "t" WHERE "id" = 2;`,
    `UPDATE "t" SET "name" = 'a2', "score" = 3.25 WHERE "id" = 1;`,
    `INSERT INTO "t" ("name", "score") VALUES ('c', 9);`,
  ]);
  const noPk = D.buildRowEditSql("mysql", "t", { columns: [{ name: "a", type: "text", pk: false }], rowColumns: ["a"], rows: [["x"]], changes: { 0: { a: "y" } } });
  assert.match(noPk.error, /没有主键/);
  assert.equal(noPk.statements.length, 0);
  // 只有新增不需要主键
  assert.equal(D.buildRowEditSql("mysql", "t", { columns: [{ name: "a", type: "text", pk: false }], rowColumns: ["a"], rows: [], inserts: [{ a: "z" }] }).statements[0], "INSERT INTO `t` (`a`) VALUES ('z');");
});

test("切换库只改连接串里的库名，其它部分原样", () => {
  assert.equal(D.urlWithDatabase("mysql", "mysql://u:p@h:3306/old?ssl-mode=REQUIRED", "new db"), "mysql://u:p@h:3306/new%20db?ssl-mode=REQUIRED");
  assert.equal(D.urlWithDatabase("postgres", "postgres://u@h/old", "x"), "postgres://u@h/x");
  assert.equal(D.urlWithDatabase("sqlite", "/a/b.db", "x"), "/a/b.db");
  assert.equal(D.databaseFromUrl("mysql://u:p@h:3306/shop?x=1"), "shop");
  assert.equal(D.databaseFromUrl("redis://h:6379"), "");
  assert.ok(D.hasDatabases("postgres") && D.hasSchemas("postgres") && !D.hasSchemas("mysql") && !D.hasDatabases("sqlite"));
  assert.equal(D.formatUptime(90061), "1 天 1 小时");
  assert.equal(D.formatUptime(125), "2 分 5 秒");
});

// ---- 连接档案 -----------------------------------------------------------------

test("结构化字段 ⇄ 连接串往返，密码与库名转义，SSL 按引擎写法", () => {
  const p = { driver: "postgres", host: "db.internal", port: 5432, user: "app", password: "p@ss:word/", database: "shop db", ssl: true };
  const url = buildConnectionUrl(p);
  assert.equal(url, "postgres://app:p%40ss%3Aword%2F@db.internal:5432/shop%20db?sslmode=require");
  const back = parseConnectionUrl("postgres", url);
  assert.deepEqual([back.user, back.password, back.database, back.ssl, back.host, back.port], ["app", "p@ss:word/", "shop db", true, "db.internal", 5432]);
  assert.equal(buildConnectionUrl({ driver: "mysql", host: "h", ssl: true }), "mysql://h:3306?ssl-mode=REQUIRED");
  assert.equal(buildConnectionUrl({ driver: "mssql", host: "h", user: "sa", password: "x" }), "mssql://sa:x@h:1433?encrypt=off");
  assert.equal(buildConnectionUrl({ driver: "redis", host: "h", password: "s3" }), "redis://:s3@h:6379/0");
  assert.equal(buildConnectionUrl({ driver: "redis", host: "h", ssl: true }), "rediss://h:6379/0");
  assert.equal(buildConnectionUrl({ driver: "mongodb", host: "cluster0.x.mongodb.net", user: "u", password: "p", database: "d", srv: true }), "mongodb+srv://u:p@cluster0.x.mongodb.net/d");
  assert.equal(buildConnectionUrl({ driver: "elastic", host: "h", ssl: true }), "https://h:9200");
  assert.equal(buildConnectionUrl({ driver: "sqlite", path: "/x/y.db" }), "/x/y.db");
  assert.equal(buildConnectionUrl({ driver: "postgres", host: "::1", port: 5432 }), "postgres://[::1]:5432");
  // 老档案（只有 url）原样保留
  assert.equal(buildConnectionUrl({ driver: "mysql", url: "mysql://a:b@c/d" }), "mysql://a:b@c/d");
});

test("老档案升级成新档案：解析出字段、补环境 / 分组 / 只读默认值，连接串不变", () => {
  const c = normalizeSavedConnection({ id: "c1", name: "线上", driver: "mysql", url: "mysql://root:pw@10.0.0.5:3306/shop" });
  assert.deepEqual([c.host, c.port, c.user, c.password, c.database, c.env, c.group, c.readOnly], ["10.0.0.5", 3306, "root", "pw", "shop", "", "", false]);
  assert.equal(c.url, "mysql://root:pw@10.0.0.5:3306/shop");
  assert.equal(connectionAddress(c), "root@10.0.0.5:3306/shop");
  assert.equal(defaultConnectionName(c), "shop @ 10.0.0.5");
  assert.equal(normalizeSavedConnection({ id: "x", driver: "mysql", url: "mysql://h/d", env: "nope" }).env, "");
  assert.equal(normalizeSavedConnection({ id: "s", driver: "sqlite", url: "sqlite:///a/b.db" }).path, "/a/b.db");
  assert.deepEqual(groupConnections([{ group: "B" }, { group: "" }, { group: "A" }, { group: "B" }]).map(([g, xs]) => [g, xs.length]), [["", 1], ["A", 1], ["B", 2]]);
  assert.equal(envMeta("prod").label, "生产");
  assert.equal(DB_ENVIRONMENTS.length, 4);
});

test("写保护：只读连接直接拦，生产环境与破坏性语句要确认，普通读不拦", () => {
  const read = { mutates: false };
  const write = { mutates: true, destructive: false, unbounded: false };
  const boom = { mutates: true, destructive: true, unbounded: true };
  assert.equal(writeGuard({ env: "prod", readOnly: true }, read).block, false);
  assert.equal(writeGuard({ readOnly: true, name: "R" }, write).block, true);
  assert.deepEqual([writeGuard({ env: "prod", name: "P" }, write).confirm, writeGuard({ env: "prod" }, write).block], [true, false]);
  assert.equal(writeGuard({ env: "dev" }, write).confirm, false);
  assert.match(writeGuard({ env: "dev" }, boom).reason, /没有 WHERE/);
});

// ---- 历史 / AI ------------------------------------------------------------------

test("历史：倒序、封顶、同连接同语句只留最新", () => {
  let h = [];
  const t0 = 1_000_000;
  h = pushHistory(h, { connKey: "c1", sql: "SELECT 1", at: t0, ms: 5, rows: 1 });
  h = pushHistory(h, { connKey: "c1", sql: "SELECT 2", at: t0 + 1 });
  h = pushHistory(h, { connKey: "c2", sql: "SELECT 1", at: t0 + 2 });
  h = pushHistory(h, { connKey: "c1", sql: "SELECT 1", at: t0 + 3, ok: false, error: "boom" });
  assert.deepEqual(h.map((x) => [x.connKey, x.sql, x.ok]), [["c1", "SELECT 1", false], ["c2", "SELECT 1", true], ["c1", "SELECT 2", true]]);
  assert.equal(pushHistory(h, { connKey: "c1", sql: "   " }).length, 3, "空语句不进历史");
  assert.equal(pushHistory([], { sql: "x" }, 1).length, 1);
  assert.deepEqual(historyForConnection(h, "c1", { filter: "2" }).map((x) => x.sql), ["SELECT 2"]);
  assert.equal(formatRelativeTime(t0, t0 + 30_000), "刚刚");
  assert.equal(formatRelativeTime(t0, t0 + 5 * 60_000), "5 分钟前");
  assert.equal(formatRelativeTime(t0, t0 + 3 * 3_600_000), "3 小时前");
  assert.equal(sqlPreview("SELECT\n   *  FROM t", 8), "SELECT …");
  let s = upsertSnippet([], { name: "慢查询", sql: "SELECT …" });
  s = upsertSnippet(s, { name: "慢查询", sql: "SELECT 2" });
  assert.deepEqual([s.length, s[0].sql], [1, "SELECT 2"]);
  assert.equal(removeSnippet(s, "慢查询").length, 0);
});

test("AI 助手：消息带表结构与任务，回复里的 SQL 优先取 sql 代码块", () => {
  const msgs = buildSqlAssistMessages({ mode: "generate", driver: "postgres", dialectLabel: "PostgreSQL", tables: [{ name: "orders", columns: [{ name: "id", type: "bigint", pk: true }, { name: "amount", type: "numeric" }] }], task: "找出金额最高的 10 单" });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[1].content, /TABLE orders \(id bigint PK, amount numeric\)/);
  assert.match(msgs[1].content, /金额最高的 10 单/);
  assert.match(msgs[1].content, /写出一条可以直接执行的 SQL/);
  assert.match(buildSqlAssistMessages({ mode: "fix", sql: "SELEC 1", error: "syntax" })[1].content, /【错误】\nsyntax/);
  assert.equal(extractSqlFromReply("先看表：\n```sql\nSELECT * FROM orders ORDER BY amount DESC LIMIT 10;\n```\n然后…"), "SELECT * FROM orders ORDER BY amount DESC LIMIT 10;");
  assert.equal(extractSqlFromReply("```\nselect 1\n```"), "select 1");
  assert.equal(extractSqlFromReply("直接 SELECT 1 FROM t"), "SELECT 1 FROM t");
  assert.equal(explanationFromReply("说明\n```sql\nSELECT 1\n```\n完"), "说明\n\n完");
  const digest = schemaDigest(Array.from({ length: 60 }, (_, i) => ({ name: `t${i}`, columns: [{ name: "a" }] })), { maxTables: 5 });
  assert.equal(digest.split("\n").length, 5);
});
