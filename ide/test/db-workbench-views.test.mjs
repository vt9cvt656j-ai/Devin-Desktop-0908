// 数据库工作台（企业版）的视图层：state → HTML 的纯函数在 Node 里真渲染一遍，
// 守的是「该出现的控件与标记都在、危险动作有确认、只读与生产标识可见、没有原生 select」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configureDbWorkbenchViews, wbIcon, ribbonHtml, treeHtml, objectsHtml, routinesHtml, gridHtml, cellHtml,
  infoHtml, connectionDialogHtml, confirmDialogHtml, centerTabsHtml, statusHtml, selectPlaceholderHtml,
} from "../src/agent/db-workbench-views.js";
import { configureDbWorkbenchPanels, tableTabHtml, queryTabHtml, serverTabHtml, historyPanelHtml, aiPanelHtml } from "../src/agent/db-workbench-panels.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const deps = { icon: (k) => `<svg data-icon="${k}"></svg>`, objectIcon: (k) => `<svg data-obj="${k}"></svg>`, escHtml: esc, escAttr: esc, shortcut: (s) => s.toUpperCase(), driverNames: { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite", redis: "Redis" } };
configureDbWorkbenchViews(deps);
configureDbWorkbenchPanels(deps);

const prod = { id: "c1", name: "订单库 · 生产", driver: "postgres", url: "postgres://app:pw@db:5432/shop", host: "db", port: 5432, user: "app", password: "pw", database: "shop", env: "prod", group: "电商", readOnly: true, ssl: true, notes: "负责人：张三" };
const dev = { id: "c2", name: "本地开发", driver: "mysql", url: "mysql://root@127.0.0.1:3306/app", host: "127.0.0.1", port: 3306, user: "root", database: "app", env: "dev", group: "", readOnly: false };
const resolveConn = (key) => {
  const saved = [prod, dev].find((c) => `conn:${c.id}` === key);
  return saved ? { key, kind: "saved", saved, driver: saved.driver, url: saved.url, label: saved.name } : null;
};

test("连接树：分组、环境点、只读锁、库与模式切换（自绘下拉占位）、分类计数都渲染出来", () => {
  const live = { "conn:c1": { status: "ready", tables: [{ name: "orders", table_type: "table" }, { name: "v", table_type: "view" }], databases: ["shop", "shop_test"], currentDatabase: "shop", schemas: ["public", "app"], fnStatus: "ready", routines: [{ name: "f" }] } };
  const html = treeHtml({ files: [], savedConns: [prod, dev], selected: "conn:c1", collapsed: {}, live, inspections: {}, inspecting: "", dbSel: { "conn:c1": { database: "shop", schema: "app" } }, category: "tables", centerTab: "objects", inTauri: true, guessDriverLabel: () => "SQLite", resolveConn, rootOpen: true });
  assert.match(html, /mpm-tree__group[^>]*data-mpm-group="电商"/, "分组行");
  assert.match(html, /mpm-env mpm-env--sm is-prod/, "生产环境标签");
  assert.match(html, /mpm-tree__ro/, "只读锁");
  assert.match(html, /data-mpm-select="db"[^>]*data-mpm-value="shop"/, "库切换占位");
  assert.match(html, /data-mpm-select="schema"[^>]*data-mpm-value="app"/, "模式切换占位");
  assert.match(html, /data-mpm-act="cat-tables">[\s\S]*?<em>1<\/em>/, "表计数");
  assert.match(html, /data-mpm-act="cat-views">[\s\S]*?<em>1<\/em>/, "视图计数");
  assert.match(html, /data-mpm-act="open-server"/, "服务器入口");
  assert.doesNotMatch(html, /<select[\s>]/, "不许原生 select");
  // 空状态与错误状态
  assert.match(treeHtml({ files: null, savedConns: [], selected: "", collapsed: {}, live: {}, inspections: {}, inspecting: "", dbSel: {}, category: "tables", centerTab: "objects", inTauri: true, guessDriverLabel: () => "", resolveConn, rootOpen: false }), /正在扫描工作区/);
  const err = treeHtml({ files: [], savedConns: [dev], selected: "conn:c2", collapsed: {}, live: { "conn:c2": { status: "error", error: "拒绝连接" } }, inspections: {}, inspecting: "", dbSel: {}, category: "tables", centerTab: "objects", inTauri: true, guessDriverLabel: () => "", resolveConn, rootOpen: true });
  assert.match(err, /拒绝连接[\s\S]*data-mpm-act="refresh-conn"/, "错误要带重试");
});

test("功能区与状态栏：只读与生产标识、面包屑、上一条查询结果", () => {
  const conn = resolveConn("conn:c1");
  const rib = ribbonHtml({ conn, category: "tables", centerTab: "objects", canQuery: true, readOnly: true });
  assert.match(rib, /mpm-rib__ro/);
  assert.match(rib, /mpm-env[^>]*is-prod/);
  assert.match(rib, /data-mpm-act="edit-conn"(?! disabled)/, "已保存的连接可以编辑");
  const st = statusHtml({ files: [], savedCount: 2, conn, objectCount: 3, centerTab: "objects", lastQuery: { ok: true, rows: 12, ms: 34, sql: "SELECT 1" }, dbSel: { database: "shop", schema: "app" }, live: {} });
  assert.match(st, /mpm-crumb[\s\S]*订单库[\s\S]*shop[\s\S]*app/);
  assert.match(st, /12 行 · 34 ms/);
  assert.match(st, /mpm-status__ro/);
  assert.match(statusHtml({ files: [], savedCount: 0, conn: null, objectCount: 0, centerTab: "objects", lastQuery: { ok: false, sql: "x" }, dbSel: null, live: null }), /上一条失败/);
});

test("对象列表与例程列表：引擎 / 说明列按需出现，无连接时给出新建入口", () => {
  const conn = resolveConn("conn:c2");
  const list = [{ name: "orders", table_type: "table", row_count: 1000, columns: null, engine: "InnoDB", comment: "订单" }, { name: "big", table_type: "view", row_count: null }];
  const html = objectsHtml({ conn, live: { status: "ready", tables: list }, inspection: null, inspecting: false, category: "tables", list, selectedIndex: 0, objFilter: "", inTauri: true, guessDriverLabel: () => "" });
  assert.match(html, /<th>引擎<\/th>/);
  assert.match(html, /<th>说明<\/th>/);
  assert.match(html, /data-mpm-obj="0"[^>]*data-mpm-name="orders"/);
  assert.doesNotMatch(html, /data-mpm-name="big"/, "看表的时候不列视图");
  assert.match(html, /data-mpm-mode="ddl"/, "DDL 入口");
  assert.match(objectsHtml({ conn: null, category: "tables", list: [], selectedIndex: -1, inTauri: true, guessDriverLabel: () => "" }), /data-mpm-act="new-conn"/);
  const fx = routinesHtml({ conn, live: { fnStatus: "ready", routines: [{ name: "total_for", type: "FUNCTION", signature: "cid integer → numeric", comment: "" }] }, objFilter: "" });
  assert.match(fx, /total_for[\s\S]*cid integer → numeric/);
  assert.match(routinesHtml({ conn, live: null, objFilter: "" }), /data-mpm-need-fx/, "没加载过要触发加载");
});

test("网格：主键图标、类型徽章、排序标记、可编辑单元格与新增行、NULL 与 JSON 的区分", () => {
  const html = gridHtml(["id", "meta"], [[1, '{"a":1}'], [null, ""]], { pkSet: new Set(["id"]), typeMap: { id: "bigint" }, sortable: true, sortCol: "id", sortDir: "desc", editable: true, dirtyCells: { "r:0": { meta: "x" } }, deletedRefs: new Set(["r:1"]), selectedRef: "r:0", newRows: [{ id: "9" }], offset: 200 });
  assert.match(html, /mp-grid__key/);
  assert.match(html, /<em>bigint<\/em>/);
  assert.match(html, /is-sortable is-sorted" data-mpm-sort="id"[\s\S]*mp-grid__sort/);
  assert.match(html, /mpm-ecell is-dirty" data-mpm-ecell="r:0" data-mpm-ecol="meta"/);
  assert.match(html, /is-deleted[^>]*data-mpm-erow="r:1"/);
  assert.match(html, /is-newrow[\s\S]*data-mpm-ecell="n:0"/);
  assert.match(html, /mp-grid__num">201</, "行号带分页偏移");
  assert.match(cellHtml(null), /mp-null/);
  assert.match(cellHtml(""), /is-empty/);
  assert.match(cellHtml('{"k":1}'), /is-json/);
  assert.match(cellHtml(true), /is-bool/);
  assert.match(cellHtml(42), /is-num/);
});

test("连接对话框：表单字段、环境分段、只读、SSL、连接串模式切换；确认框：危险态与勾选确认", () => {
  const d = { id: "c1", name: "x", driver: "postgres", group: "电商", env: "prod", host: "db", port: 5432, user: "app", password: "pw", database: "shop", ssl: true, readOnly: true, notes: "", rawMode: false, showPassword: false, testing: false, testResult: "连接成功 · 12 ms", testOk: true };
  const html = connectionDialogHtml(d, { driverIds: ["mysql", "postgres", "sqlite"], driverHints: { postgres: "postgres://…" }, groups: ["电商"] });
  assert.match(html, /data-mpm-select="dlg-driver"[^>]*data-mpm-value="postgres"/);
  assert.match(html, /data-mpm-dlg-env="prod"[^>]*is-active|is-active" data-mpm-dlg-env="prod"/);
  assert.match(html, /data-mpm-dlg-host value="db"/);
  assert.match(html, /data-mpm-dlg-port class="is-port" value="5432"/);
  assert.match(html, /data-mpm-dlg-password type="password"/);
  assert.match(html, /data-mpm-dlg-ssl checked/);
  assert.match(html, /data-mpm-dlg-ro checked/);
  assert.match(html, /data-mpm-dlg-delete/, "编辑态可以删除");
  assert.match(html, /data-mpm-dlg-dup/, "编辑态可以复制");
  assert.match(html, /is-ok">连接成功 · 12 ms/);
  assert.doesNotMatch(html, /<select[\s>]/);
  const raw = connectionDialogHtml({ ...d, id: "", rawMode: true, url: "postgres://a:b@c/d" }, { driverIds: ["postgres"], driverHints: {}, groups: [] });
  assert.match(raw, /data-mpm-dlg-url value="postgres:\/\/a:b@c\/d"/);
  assert.doesNotMatch(raw, /data-mpm-dlg-delete/, "新建态没有删除");
  const sq = connectionDialogHtml({ ...d, driver: "sqlite", path: "/x.db" }, { driverIds: ["sqlite"], driverHints: {}, groups: [] });
  assert.match(sq, /data-mpm-dlg-path value="\/x.db"/);
  const c = confirmDialogHtml({ title: "生产环境：确认执行", message: "会改数据", preview: "DELETE FROM t WHERE id = 1;", danger: true, ack: "我确认", okLabel: "执行" });
  assert.match(c, /h4 class="is-danger"/);
  assert.match(c, /mpm-dialog__pre">DELETE FROM t WHERE id = 1;/);
  assert.match(c, /data-mpm-confirm-ack/);
  assert.match(c, /data-mpm-confirm-ok disabled/, "勾选前不能执行");
  assert.equal(confirmDialogHtml(null), "");
});

test("表页签：五种模式、筛选栏、分页器、导出菜单、可编辑工具条、只读原因", () => {
  const conn = resolveConn("conn:c2");
  const base = { id: 1, connKey: "conn:c2", connLabel: "本地开发", name: "orders", schema: "", tableType: "table", mode: "data", page: 1, pageSize: 100, sortCol: "id", sortDir: "desc", where: "status = 'paid'", total: 1000, truncated: false, status: "ready", columns: ["id", "status"], rows: [[1, "paid"]], columnsMeta: [{ name: "id", type: "int", pk: true }, { name: "status", type: "text" }], metaStatus: {}, metaError: {}, edits: {}, newRows: [], delRows: [], selRow: null, elapsed: 7 };
  const html = tableTabHtml(base, { conn, fileConn: false, editable: true, editCount: 2, columnsMeta: base.columnsMeta, dirtyCells: {}, deletedRefs: new Set(), readOnlyReason: "", formatBytes: (n) => `${n} B` });
  for (const m of ["data", "struct", "indexes", "fks", "ddl"]) assert.match(html, new RegExp(`data-mpm-ttab-mode="${m}"`), `模式 ${m}`);
  assert.match(html, /data-mpm-where value="status = &#39;paid&#39;"/);
  assert.match(html, /data-mpm-where-clear/);
  assert.match(html, /mpm-pager__info">101–101 \/ 1,000/);
  assert.match(html, /data-mpm-select="ttab-limit"[^>]*data-mpm-value="100"/);
  assert.match(html, /data-mpm-export="insert"/);
  assert.match(html, /data-mpm-ecrud="save">保存 \(2\)/);
  assert.match(html, /1 行（共 1,000） · 2 处待保存 · 7 ms/);
  const ro = tableTabHtml({ ...base, edits: {} }, { conn, fileConn: false, editable: false, editCount: 0, columnsMeta: base.columnsMeta, dirtyCells: {}, deletedRefs: new Set(), readOnlyReason: "连接设为只读", formatBytes: () => "" });
  assert.match(ro, /mpm-readonly-hint">连接设为只读/);
  const ddl = tableTabHtml({ ...base, mode: "ddl", ddl: "CREATE TABLE orders (...)" }, { conn, fileConn: false, editable: false, editCount: 0, columnsMeta: base.columnsMeta, dirtyCells: {}, deletedRefs: new Set(), readOnlyReason: "", formatBytes: () => "" });
  assert.match(ddl, /mpm-ddl__pre">CREATE TABLE orders/);
  assert.match(ddl, /data-mpm-act="ddl-to-query"/);
  const loading = tableTabHtml({ ...base, mode: "indexes", indexes: null, metaStatus: { indexes: "loading" } }, { conn, fileConn: false, editable: false, editCount: 0, columnsMeta: base.columnsMeta, dirtyCells: {}, deletedRefs: new Set(), readOnlyReason: "", formatBytes: () => "" });
  assert.match(loading, /正在读取索引/);
  const failed = tableTabHtml({ ...base, mode: "fks", foreignKeys: null, metaStatus: { fks: "error" }, metaError: { fks: "没权限" } }, { conn, fileConn: false, editable: false, editCount: 0, columnsMeta: base.columnsMeta, dirtyCells: {}, deletedRefs: new Set(), readOnlyReason: "", formatBytes: () => "" });
  assert.match(failed, /读取失败[\s\S]*没权限[\s\S]*data-mpm-ttab-refresh/);
  assert.doesNotMatch(html, /<select[\s>]/);
});

test("查询页签：工具条、多结果页、失败结果、被拦语句、历史与 AI 侧栏", () => {
  const conn = resolveConn("conn:c1");
  const tab = { id: 3, title: "查询 3", connKey: "conn:c1", driver: "postgres", sql: "SELECT 1; DELETE FROM t", results: [{ sql: "SELECT 1", columns: ["a"], rows: [[1]], elapsed_ms: 3 }, { sql: "DELETE FROM t", blocked: "只读连接" }, { sql: "x", error: "syntax error" }], activeResult: 2, running: false, limit: 500, side: "history", historyFilter: "", ai: { mode: "generate" } };
  const html = queryTabHtml(tab, { conn, history: [{ id: "h1", sql: "SELECT 1", at: Date.now(), ms: 3, rows: 1, ok: true, connName: "订单库" }], snippets: [{ name: "慢查询", sql: "SELECT …" }], canExplain: true, readOnly: true, hasModel: false, formatBytes: () => "" });
  assert.match(html, /data-mpm-run title[\s\S]*data-mpm-run-sel[\s\S]*data-mpm-explain[\s\S]*data-mpm-format/);
  assert.match(html, /data-mpm-select="qlimit"[^>]*data-mpm-value="500"/);
  assert.match(html, /mpm-chip is-ro/);
  assert.match(html, /mpm-results__tabs[\s\S]*结果 1 · 1[\s\S]*结果 2[\s\S]*is-err[^>]*data-mpm-result="2"/);
  assert.match(html, /第 3 条失败<\/strong>syntax error/);
  assert.match(html, /mpm-side--history[\s\S]*常用片段[\s\S]*data-mpm-snippet="慢查询"[\s\S]*最近执行[\s\S]*data-mpm-hist="h1"/);
  assert.match(html, /data-mpm-snippet-save/);
  const blocked = queryTabHtml({ ...tab, activeResult: 1, side: "" }, { conn, history: [], canExplain: true, readOnly: true, hasModel: true, formatBytes: () => "" });
  assert.match(blocked, /没有执行<\/strong>只读连接/);
  const ai = aiPanelHtml({ mode: "fix", busy: false, error: "", reply: "说明", sql: "SELECT 2", explanation: "改了 x" }, { hasModel: true });
  assert.match(ai, /data-mpm-ai-mode="fix"[^>]*|is-active" data-mpm-ai-mode="fix"/);
  assert.match(ai, /mpm-ai__sql">SELECT 2[\s\S]*data-mpm-ai-insert/);
  assert.match(aiPanelHtml({ mode: "generate" }, { hasModel: false }), /请先登录账号并选择模型/);
  assert.match(queryTabHtml({ ...tab, results: [], side: "" }, { conn, history: [], canExplain: false, readOnly: false, hasModel: true, formatBytes: () => "" }), /MOD\+ENTER 执行全部/);
  assert.match(historyPanelHtml([], {}), /还没有历史/);
});

test("服务器页签：概览卡片、原始信息、会话表与终止按钮", () => {
  const conn = resolveConn("conn:c1");
  const tab = { id: "s1", connKey: "conn:c1", title: "x · 服务器", status: "ready", facts: [{ key: "version", label: "版本", value: "PostgreSQL 16" }, { key: "uptime", label: "已运行", value: 90061, seconds: true }], info: { raw: "# 内存\nused: 1" }, sessions: [[12, "app", "10.0.0.1", "shop", "active", 3, "", "SELECT …"]], error: "" };
  const html = serverTabHtml(tab, { conn, canKill: true });
  assert.match(html, /mpm-fact[\s\S]*版本[\s\S]*PostgreSQL 16/);
  assert.match(html, /1 天 1 小时/);
  assert.match(html, /mpm-server__raw">#/);
  assert.match(html, /data-mpm-kill="12"/);
  assert.match(html, /mpm-chip is-on">active/);
  assert.match(serverTabHtml({ ...tab, sessions: [] }, { conn, canKill: false }), /没有其它会话/);
  assert.match(serverTabHtml({ ...tab, status: "loading", facts: [{ key: "v", label: "版本", value: null }], sessions: null }, { conn, canKill: false }), /mp-spinner[\s\S]*正在读取会话/);
});

test("信息栏与标签栏：对象 / 连接 / 空态三种，页签带未保存点与运行中转圈", () => {
  const conn = resolveConn("conn:c1");
  const obj = infoHtml({ conn, object: { name: "orders", table_type: "table", row_count: 5, columns: [{ name: "id", pk: true, type: "int" }], engine: "InnoDB", comment: "订单" }, live: null, inspection: null, absPath: "", formatBytes: () => "", formatTime: () => "", guessDriverLabel: () => "", dbSel: null });
  assert.match(obj, /orders[\s\S]*主键<\/dt><dd>id[\s\S]*InnoDB[\s\S]*订单/);
  const c = infoHtml({ conn, object: null, live: { status: "ready", tables: [1, 2], version: "PG 16", latencyMs: 12 }, inspection: null, absPath: "", formatBytes: () => "", formatTime: () => "", guessDriverLabel: () => "", dbSel: { database: "shop", schema: "app" } });
  assert.match(c, /mpm-env[\s\S]*is-ro[\s\S]*SSL[\s\S]*电商/);
  assert.match(c, /app@db:5432\/shop/);
  assert.match(c, /shop · app/);
  assert.match(c, /12 ms/);
  assert.doesNotMatch(c, /pw/, "密码不上屏");
  assert.equal(infoHtml({ conn: null, object: null }), "", "没选中时详情栏不渲染欢迎语");
  const tabs = centerTabsHtml({ centerTab: "q:1", tableTabs: [{ id: 2, name: "t", tableType: "table", dirty: true }], queryTabs: [{ id: 1, title: "查询 1", running: true }], serverTabs: [{ id: "s", title: "srv" }] });
  assert.match(tabs, /mp-tab__dot/);
  assert.match(tabs, /mp-spinner--xs/);
  assert.match(tabs, /data-mpm-tab="s:s"/);
  assert.match(selectPlaceholderHtml("db", [["a", "A"]], "a"), /data-mpm-options="\[\[&quot;a&quot;,&quot;A&quot;\]\]"/);
  assert.match(wbIcon("server"), /<svg/);
  assert.match(wbIcon("nope"), /data-icon="nope"/, "不认识的图标回落到主图标表");
});
