/**
 * 数据库工作台（企业版）的静态视图：功能区、连接树、对象列表、例程列表、信息栏、连接对话框、
 * 确认框、通用数据网格。全部是 state → HTML 的纯函数；图标与转义函数由 main.js 注入，
 * 这样这一层既不依赖 DOM，也能在 Node 里直接渲染出来断言。
 */
import { envMeta, groupConnections, connectionAddress, DB_ENVIRONMENTS } from "./db-connections.js";
import { dbIcon } from "./db-icons.js";
import { hasDatabases, hasSchemas, isSqlDriver } from "./db-dialects.js";

let icon = () => "";
let objectIcon = () => "";
let esc = (s) => String(s ?? "");
let escAttr = (s) => String(s ?? "");
let shortcut = (s) => s;
let driverNames = {};

export function configureDbWorkbenchViews(deps = {}) {
  if (deps.icon) icon = deps.icon;
  if (deps.objectIcon) objectIcon = deps.objectIcon;
  if (deps.escHtml) esc = deps.escHtml;
  if (deps.escAttr) escAttr = deps.escAttr;
  if (deps.shortcut) shortcut = deps.shortcut;
  if (deps.driverNames) driverNames = deps.driverNames;
}

/** 工作台自己补的几枚描边图标（main.js 那套没有的）。 */
export function wbIcon(kind) {
  // 统一图标集（Lucide）；没有的键回落到宿主注入的图标表。
  return dbIcon(kind) || icon(kind);
}

/** 自绘下拉的占位：main.js 渲染后用 buildSelectControl 换掉（原生下拉的弹出菜单位置和宽度管不着）。 */
export function selectPlaceholderHtml(key, options, value, { title = "" } = {}) {
  return `<span class="mpm-pick" data-mpm-select="${escAttr(key)}" data-mpm-options="${escAttr(JSON.stringify(options))}" data-mpm-value="${escAttr(String(value ?? ""))}"${title ? ` title="${escAttr(title)}"` : ""}></span>`;
}

export function envBadgeHtml(env, { small = false } = {}) {
  const m = envMeta(env);
  if (!m.id) return "";
  return `<span class="mpm-env${small ? " mpm-env--sm" : ""} is-${m.id}" style="--env:${m.color}">${esc(m.label)}</span>`;
}

export function envDotHtml(env) {
  const m = envMeta(env);
  return `<span class="mpm-envdot" style="--env:${m.color || "var(--mp-dim)"}" title="${escAttr(m.label || "未标环境")}"></span>`;
}

// ---- 功能区 -----------------------------------------------------------------------

export function ribbonHtml({ conn, category, centerTab, canQuery, readOnly }) {
  const onObjects = centerTab === "objects";
  const btn = (act, ic, label, active = false, disabled = false, title = "", primary = false) => `
    <button type="button" class="mpm-rib__btn${active ? " is-active" : ""}${primary ? " is-primary" : ""}" data-mpm-act="${act}" ${disabled ? "disabled" : ""}${title ? ` title="${escAttr(title)}"` : ""}>
      <span class="mpm-rib__icon">${ic}</span>
      <span class="mpm-rib__label">${label}</span>
    </button>`;
  // 顶栏（产品栏）：品牌 + 当前实例上下文 + 只读/环境标签 + 关闭；下面一行是 Ant 式工具条。
  const ctx = conn
    ? `<div class="mpm-topbar__ctx">${wbIcon("server")}<strong title="${escAttr(conn.label)}">${esc(conn.label)}</strong><em>${esc(driverNames[conn.driver] || conn.driver || "")}</em></div>`
    : `<div class="mpm-topbar__ctx is-empty">${wbIcon("server")}<span>未选择实例</span></div>`;
  return `
    <div class="mpm-ribbon">
      <div class="mpm-topbar">
        <div class="mpm-topbar__brand"><span class="mpm-topbar__logo">${icon("cylinder")}</span><strong>Michael Premium</strong><em>数据管理</em></div>
        <i class="mpm-topbar__sep"></i>
        ${ctx}
        <div class="mpm-topbar__right">
          ${readOnly ? `<span class="mpm-rib__ro" title="这条连接是只读的：改库语句不会执行">${wbIcon("lock")}<span>只读</span></span>` : ""}
          ${conn?.saved ? envBadgeHtml(conn.saved.env) : ""}
          <button type="button" class="mpm-close" data-mpm-close title="关闭" aria-label="关闭">${icon("close")}</button>
        </div>
      </div>
      <div class="mpm-toolbar">
        ${btn("new-conn", icon("plugC"), "新建连接", false, false, "", true)}
        ${btn("new-query", icon("newquery"), "新建查询", false, !canQuery, shortcut("mod+n"))}
        <i class="mpm-rib__sep"></i>
        ${btn("cat-tables", objectIcon("table"), "表", onObjects && category === "tables", !conn)}
        ${btn("cat-views", objectIcon("view"), "视图", onObjects && category === "views", !conn)}
        ${btn("cat-fx", icon("fxC"), "函数", onObjects && category === "fx", !conn)}
        ${btn("open-server", wbIcon("server"), "服务器", centerTab.startsWith("s:"), !conn)}
        <i class="mpm-rib__sep"></i>
        ${btn("refresh-conn", icon("refresh"), "刷新", false, !conn)}
        ${btn("edit-conn", icon("edit"), "编辑连接", false, !conn || conn.kind !== "saved")}
        ${btn("open-selected-conn", icon("open"), "工作台", false, !conn || conn.kind !== "file")}
        <i class="mpm-rib__flex"></i>
      </div>
    </div>`;
}

// ---- 连接树 -----------------------------------------------------------------------

function catRow(act, ic, label, count, active) {
  return `<button type="button" class="mpm-tree__cat${active ? " is-active" : ""}" data-mpm-act="${act}">${ic}<span>${label}</span><em>${count}</em></button>`;
}

export function treeChildrenHtml({ conn, live, inspection, inspecting, category, centerTab, dbSel, inTauri }) {
  const key = conn.key;
  let tables = [];
  let parsed = false;
  if (conn.kind === "file") {
    parsed = !!inspection?.sqlite;
    tables = parsed ? inspection.sqlite.tables : [];
    if (inspecting) return `<div class="mpm-tree__children"><div class="mpm-tree__loading"><span class="mp-spinner"></span>正在解析…</div></div>`;
    if (inspection && !inspection.sqlite) return `<div class="mpm-tree__children"><div class="mpm-tree__loading">${esc(inspection.error || "不是可解析的 SQLite 库")}</div></div>`;
    if (!inspection && !inTauri) return `<div class="mpm-tree__children"><div class="mpm-tree__loading">网页版无法解析本地库</div></div>`;
    if (!inspection) return "";
  } else {
    if (live?.status === "loading") return `<div class="mpm-tree__children"><div class="mpm-tree__loading"><span class="mp-spinner"></span>正在连接…</div></div>`;
    if (live?.status === "error") return `<div class="mpm-tree__children"><div class="mpm-tree__loading is-err">${esc(live.error || "连接失败")}</div><button type="button" class="mpm-tree__retry" data-mpm-act="refresh-conn">${icon("refresh")}<span>重试</span></button></div>`;
    parsed = live?.status === "ready";
    tables = live?.tables || [];
    if (!parsed) return "";
  }
  const parts = [];
  const sel = dbSel || {};
  // 库 / 模式切换：MySQL/PG/MSSQL/ClickHouse/Mongo 有库这一层，PG/MSSQL 还有模式。
  if (conn.kind === "saved" && hasDatabases(conn.driver) && Array.isArray(live?.databases) && live.databases.length) {
    parts.push(`<div class="mpm-tree__pick" title="切换数据库">${wbIcon("database")}${selectPlaceholderHtml("db", live.databases.map((d) => [d, d]), sel.database || live.currentDatabase)}</div>`);
  }
  if (conn.kind === "saved" && hasSchemas(conn.driver) && Array.isArray(live?.schemas) && live.schemas.length) {
    parts.push(`<div class="mpm-tree__pick" title="切换模式">${wbIcon("layers")}${selectPlaceholderHtml("schema", live.schemas.map((d) => [d, d]), sel.schema || live.schemas[0])}</div>`);
  }
  if (live?.redis) {
    parts.push(catRow("new-query", icon("query"), "命令行（PING / GET …）", "CLI", centerTab.startsWith("q:")));
    parts.push(catRow("open-server", wbIcon("server"), "服务器", "", centerTab.startsWith("s:")));
    return `<div class="mpm-tree__children">${parts.join("")}</div>`;
  }
  const tableCount = tables.filter((t) => String(t?.table_type || "table").toLowerCase() !== "view").length;
  const viewCount = tables.length - tableCount;
  const fnCount = live?.fnStatus === "ready" ? (live.routines || []).length : "…";
  const onObjects = centerTab === "objects";
  parts.push(catRow("cat-tables", objectIcon("table"), "表", tableCount, onObjects && category === "tables"));
  parts.push(catRow("cat-views", objectIcon("view"), "视图", viewCount, onObjects && category === "views"));
  parts.push(catRow("cat-fx", icon("fxC"), "函数 / 过程", fnCount, onObjects && category === "fx"));
  parts.push(catRow("new-query", icon("query"), "查询", "SQL", centerTab.startsWith("q:")));
  parts.push(catRow("open-server", wbIcon("server"), "服务器", "", centerTab.startsWith("s:")));
  return `<div class="mpm-tree__children">${parts.join("")}</div>`;
}

export function treeHtml(ctx) {
  const { files, savedConns, selected, collapsed, live, inspections, inspecting, guessDriverLabel, rootOpen } = ctx;
  const parts = [];
  const fileCount = Array.isArray(files) ? files.length : 0;
  parts.push(`<div class="mpm-tree__sect"><span>工作区</span>${fileCount ? `<em>${fileCount}</em>` : ""}</div>`);
  if (files === null) {
    parts.push(`<div class="mpm-tree__loading"><span class="mp-spinner"></span>正在扫描工作区…</div>`);
  } else if (!files.length) {
    parts.push(`<div class="mpm-tree__hint">${wbIcon("folder")}<span>${rootOpen ? "工作区里没有数据库文件" : "打开文件夹后，这里会列出 .db / .sqlite 文件"}</span></div>`);
  } else {
    for (const rel of files) {
      const key = `file:${rel}`;
      const active = selected === key;
      const expanded = active && !collapsed?.[key];
      const conn = ctx.resolveConn(key);
      parts.push(`
        <div class="mpm-tree__node${expanded ? " is-open" : ""}">
          <button type="button" class="mpm-tree__conn${active ? " is-active" : ""}" data-mpm-conn="${escAttr(key)}" data-mpm-name="${escAttr(rel)}" title="${escAttr(rel)}">
            <span class="mpm-tree__caret${expanded ? " is-open" : ""}">${icon("chev")}</span>
            <span class="mpm-tree__db">${icon("cylinder")}</span>
            <span class="mpm-tree__label">${esc(rel.split("/").pop())}</span>
            <span class="mpm-item__badge">${esc(guessDriverLabel(rel))}</span>
          </button>
          ${expanded && conn ? treeChildrenHtml({ conn, live: live[key], inspection: inspections[rel], inspecting: inspecting === rel, category: ctx.category, centerTab: ctx.centerTab, dbSel: null, inTauri: ctx.inTauri }) : ""}
        </div>`);
    }
  }
  parts.push(`<div class="mpm-tree__sect"><span>我的连接</span>${savedConns.length ? `<em>${savedConns.length}</em>` : ""}</div>`);
  if (!savedConns.length) {
    parts.push(`<div class="mpm-tree__empty">${wbIcon("database")}<strong>还没有连接</strong><button type="button" class="mpm-tree__cta" data-mpm-act="new-conn">${icon("plus")}<span>新建连接</span></button></div>`);
  } else {
    const badges = { mysql: "MySQL", mariadb: "Maria", postgres: "PG", mssql: "MSSQL", mongodb: "Mongo", redis: "Redis", sqlite: "SQLite", clickhouse: "CH", elastic: "ES" };
    for (const [group, list] of groupConnections(savedConns)) {
      const gkey = `g:${group}`;
      const gCollapsed = !!collapsed?.[gkey];
      if (group) parts.push(`<button type="button" class="mpm-tree__group${gCollapsed ? " is-collapsed" : ""}" data-mpm-group="${escAttr(group)}"><span class="mpm-tree__caret${gCollapsed ? "" : " is-open"}">${icon("chev")}</span>${gCollapsed ? wbIcon("folder") : wbIcon("folderOpen")}<span>${esc(group)}</span><em>${list.length}</em></button>`);
      if (group && gCollapsed) continue;
      for (const c of list) {
        const key = `conn:${c.id}`;
        const active = selected === key;
        const expanded = active && !collapsed?.[key];
        const conn = ctx.resolveConn(key);
        const st = live[key]?.status;
        parts.push(`
          <div class="mpm-tree__node${expanded ? " is-open" : ""}${group ? " is-grouped" : ""}">
            <button type="button" class="mpm-tree__conn${active ? " is-active" : ""}${c.env === "prod" ? " is-prod" : ""}" data-mpm-conn="${escAttr(key)}" data-mpm-name="${escAttr(c.name || c.driver)}" title="${escAttr(connectionAddress(c))}">
              <span class="mpm-tree__caret${expanded ? " is-open" : ""}">${icon("chev")}</span>
              <span class="mpm-tree__db${st === "ready" ? " is-on" : st === "error" ? " is-err" : ""}" title="${st === "ready" ? "已连接" : st === "error" ? "连接失败" : "未连接"}">${wbIcon("database")}</span>
              <span class="mpm-tree__label">${esc(c.name || c.driver)}</span>
              ${envBadgeHtml(c.env, { small: true })}
              ${c.readOnly ? `<span class="mpm-tree__ro" title="只读">${wbIcon("lock")}</span>` : ""}
              <span class="mpm-item__badge">${esc(badges[c.driver] || c.driver)}</span>
            </button>
            ${expanded && conn ? treeChildrenHtml({ conn, live: live[key], inspection: null, inspecting: false, category: ctx.category, centerTab: ctx.centerTab, dbSel: ctx.dbSel?.[key], inTauri: ctx.inTauri }) : ""}
          </div>`);
      }
    }
  }
  return parts.join("");
}

// ---- 对象列表 / 例程 -------------------------------------------------------------

export function objectsHtml({ conn, live, inspection, inspecting, category, list, selectedIndex, objFilter, inTauri, guessDriverLabel }) {
  if (!conn) {
    return `<div class="mp-blank"><span class="mp-blank__icon">${icon("cylinder")}</span><h3>没有选中连接</h3><p>在左侧选择一个工作区数据库或保存的连接；点功能区「新建连接」可以添加。</p><div class="mpm-info__actions"><button type="button" class="mp-run" data-mpm-act="new-conn">${icon("plugC")}<span>新建连接</span></button></div></div>`;
  }
  if (conn.kind === "file") {
    if (inspecting && !inspection) return `<div class="mp-running"><span class="mp-spinner"></span>正在解析 ${esc(conn.label)}…</div>`;
    if (!inTauri && !inspection) return `<div class="mp-blank"><h3>网页版无法解析本地库</h3><p>请在桌面版使用，或新建远程连接。</p></div>`;
    if (inspection && !inspection.sqlite) return `<div class="mp-blank"><h3>${esc(guessDriverLabel(conn.rel))}</h3><p>${esc(inspection.error || "这种格式暂不支持直接解析；可以用「新建查询」连接对应的数据库服务。")}</p></div>`;
    if (!inspection) return `<div class="mp-running"><span class="mp-spinner"></span>正在解析…</div>`;
  } else {
    if (!live || live.status === "loading") return `<div class="mp-running"><span class="mp-spinner"></span>正在连接 ${esc(conn.label)}…</div>`;
    if (live.status === "error") return `<div class="mp-blank"><span class="mp-blank__icon">${wbIcon("warn")}</span><h3>连接失败</h3><p>${esc(live.error || "")}</p><div class="mpm-info__actions"><button type="button" class="mp-run" data-mpm-act="refresh-conn">${icon("refresh")}<span>重试</span></button><button type="button" class="mpm-ghost" data-mpm-act="edit-conn">${icon("edit")}<span>编辑连接</span></button></div></div>`;
    if (live.redis) return `<div class="mp-blank"><span class="mp-blank__icon">${icon("cylinder")}</span><h3>Redis 键值库</h3><p>Redis 没有表结构。用「新建查询」执行 PING、GET、SET、KEYS、SCAN 等命令，「服务器」页看内存与键数。</p><div class="mpm-info__actions"><button type="button" class="mp-run" data-mpm-act="new-query">${icon("query")}<span>新建查询</span></button><button type="button" class="mpm-ghost" data-mpm-act="open-server">${wbIcon("server")}<span>服务器</span></button></div></div>`;
  }
  if (category === "fx") return routinesHtml({ conn, live, objFilter });
  const wantView = category === "views";
  const rows = [];
  list.forEach((t, i) => {
    const isView = String(t?.table_type || "table").toLowerCase() === "view";
    if (isView === wantView) rows.push([t, i]);
  });
  const canOpen = selectedIndex >= 0;
  const hasEngine = rows.some(([t]) => t?.engine);
  const hasComment = rows.some(([t]) => t?.comment);
  return `
    <div class="mpm-objbar">
      <button type="button" data-mpm-open-sel data-mpm-need-sel ${canOpen ? "" : "disabled"}>${icon("open")}<span>打开</span></button>
      <button type="button" data-mpm-open-sel data-mpm-mode="struct" data-mpm-need-sel ${canOpen ? "" : "disabled"}>${icon("struct")}<span>结构</span></button>
      <button type="button" data-mpm-open-sel data-mpm-mode="ddl" data-mpm-need-sel ${canOpen ? "" : "disabled"}>${wbIcon("code")}<span>DDL</span></button>
      <button type="button" data-mpm-act="query-selected" data-mpm-need-sel ${canOpen ? "" : "disabled"}>${icon("query")}<span>查询</span></button>
      <button type="button" data-mpm-act="refresh-conn">${icon("refresh")}<span>刷新</span></button>
      <i></i>
      <span class="mp-objects__hint">${rows.length} 个${wantView ? "视图" : "表"} · 双击打开</span>
      <label class="mp-side-search mpm-objsearch">${icon("search")}<input data-mpm-obj-filter placeholder="搜索对象" aria-label="搜索对象" value="${escAttr(objFilter || "")}" /></label>
    </div>
    ${rows.length ? `
    <div class="mp-grid mpm-objgrid">
      <table>
        <thead><tr><th class="mp-grid__num">#</th><th>名称</th><th>类型</th><th>行</th><th>字段</th>${hasEngine ? "<th>引擎</th>" : ""}${hasComment ? "<th>说明</th>" : ""}</tr></thead>
        <tbody>
          ${rows.map(([t, i], n) => `
            <tr class="mp-object-row${selectedIndex === i ? " is-selected" : ""}" data-mpm-obj="${i}" data-mpm-name="${escAttr(t?.name || "")}">
              <td class="mp-grid__num">${n + 1}</td>
              <td><span class="mp-object-row__name">${objectIcon(t?.table_type || "table")}<span title="${escAttr(t?.name || "")}">${esc(t?.name || "unknown")}</span></span></td>
              <td>${wantView ? (t?.engine === "materialized" ? "物化视图" : "视图") : (t?.engine === "partitioned" ? "分区表" : "表")}</td>
              <td class="is-num">${typeof t?.row_count === "number" ? Number(t.row_count).toLocaleString() : "—"}</td>
              <td class="is-num">${Array.isArray(t?.columns) ? t.columns.length.toLocaleString() : "—"}</td>
              ${hasEngine ? `<td><span class="mpm-chip">${esc(t?.engine || "")}</span></td>` : ""}
              ${hasComment ? `<td class="is-dim" title="${escAttr(t?.comment || "")}">${esc(t?.comment || "")}</td>` : ""}
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : `<div class="mp-blank"><h3>没有${wantView ? "视图" : "表"}</h3><p>这个数据库里没有${wantView ? "视图" : "用户表"}。</p></div>`}`;
}

export function routinesHtml({ conn, live, objFilter }) {
  if (!live || live.fnStatus === "loading" || !live.fnStatus) {
    return `<div class="mp-running" data-mpm-need-fx><span class="mp-spinner"></span>正在加载函数与过程…</div>`;
  }
  if (live.fnStatus === "error") {
    return `<div class="mp-blank"><h3>函数清单加载失败</h3><p>${esc(live.fnError || "")}</p><div class="mpm-info__actions"><button type="button" class="mp-run" data-mpm-act="refresh-conn">${icon("refresh")}<span>重试</span></button></div></div>`;
  }
  const fns = live.routines || [];
  if (!fns.length) return `<div class="mp-blank"><span class="mp-blank__icon">${icon("fxC")}</span><h3>没有函数或过程</h3><p>这个库（当前模式）里没有可列出的例程。</p></div>`;
  const hasSig = fns.some((f) => f.signature);
  return `
    <div class="mpm-objbar">
      <span class="mp-objects__hint">${conn.driver === "sqlite" ? "SQLite 引擎内置函数" : "库内函数与存储过程"} · 共 ${fns.length} 个</span>
      <i></i>
      <label class="mp-side-search mpm-objsearch">${icon("search")}<input data-mpm-obj-filter placeholder="搜索" aria-label="搜索函数" value="${escAttr(objFilter || "")}" /></label>
    </div>
    <div class="mp-grid mpm-objgrid">
      <table>
        <thead><tr><th class="mp-grid__num">#</th><th>名称</th><th>类型</th>${hasSig ? "<th>签名</th>" : ""}<th>说明</th></tr></thead>
        <tbody>
          ${fns.map((f, n) => `
            <tr class="mp-object-row" data-mpm-obj-fn data-mpm-name="${escAttr(f.name)}">
              <td class="mp-grid__num">${n + 1}</td>
              <td><span class="mp-object-row__name">${icon("fx")}<span>${esc(f.name)}</span></span></td>
              <td><span class="mpm-chip">${esc(f.type || "FUNCTION")}</span></td>
              ${hasSig ? `<td class="is-mono">${esc(f.signature || "")}</td>` : ""}
              <td class="is-dim">${esc(f.comment || "")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

// ---- 通用网格 ------------------------------------------------------------------

export function cellHtml(value, { formatBytes } = {}) {
  if (value === null || value === undefined) return `<span class="mp-null">NULL</span>`;
  if (typeof value === "object" && Number.isFinite(Number(value?.blob_bytes))) {
    return `<span class="mp-blob" title="${escAttr(value.preview || "")}">BLOB · ${formatBytes ? formatBytes(value.blob_bytes) : value.blob_bytes + " B"}</span>`;
  }
  if (typeof value === "boolean") return `<span class="mp-cell is-bool">${value ? "true" : "false"}</span>`;
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (s === "") return `<span class="mp-null is-empty">空</span>`;
  const isNum = typeof value === "number" || (s.length < 18 && /^-?\d+(\.\d+)?$/.test(s));
  const isJson = !isNum && s.length > 1 && (s[0] === "{" || s[0] === "[") && (s.endsWith("}") || s.endsWith("]"));
  const shown = s.length > 200 ? s.slice(0, 200) + "…" : s;
  return `<span class="mp-cell${isNum ? " is-num" : ""}${isJson ? " is-json" : ""}" title="${escAttr(s.slice(0, 500))}">${esc(shown)}</span>`;
}

/**
 * 数据网格。opts: { pkSet, typeMap, scrollKey, emptyText, offset, sortCol, sortDir, sortable, editable,
 *   rowRefs: (i)=>ref, dirtyCells: {ref:{col:true}}, deletedRefs:Set, selectedRef, newRows:[{...}], formatBytes }
 */
export function gridHtml(columns, rows, opts = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  if (!cols.length) return `<div class="mp-empty">${esc(opts.emptyText || "没有可显示的数据")}</div>`;
  const pk = opts.pkSet || null;
  const types = opts.typeMap || null;
  const offset = Number(opts.offset) || 0;
  const sortable = !!opts.sortable;
  const head = cols.map((c) => {
    const sorted = opts.sortCol === c ? (opts.sortDir === "desc" ? "desc" : "asc") : "";
    return `
      <th title="${escAttr(String(c))}${types && types[c] ? escAttr(" · " + types[c]) : ""}"${sortable ? ` class="is-sortable${sorted ? " is-sorted" : ""}" data-mpm-sort="${escAttr(String(c))}"` : ""}>
        <span class="mp-grid__col">
          ${pk && pk.has && pk.has(c) ? `<span class="mp-grid__key" title="主键">${icon("key")}</span>` : ""}
          <span>${esc(String(c))}</span>
          ${sorted ? `<span class="mp-grid__sort">${wbIcon(sorted === "desc" ? "sortDesc" : "sortAsc")}</span>` : ""}
        </span>
        ${types && types[c] ? `<em>${esc(types[c])}</em>` : ""}
      </th>`;
  }).join("");
  const body = [];
  list.forEach((row, i) => {
    const ref = opts.rowRefs ? opts.rowRefs(i) : `r:${i}`;
    const deleted = opts.deletedRefs?.has?.(ref);
    const sel = opts.selectedRef === ref;
    body.push(`<tr class="mpm-erow${deleted ? " is-deleted" : ""}${sel ? " is-selrow" : ""}" data-mpm-erow="${escAttr(ref)}">
      <td class="mp-grid__num">${offset + i + 1}</td>
      ${cols.map((c, j) => {
        const dirty = opts.dirtyCells?.[ref] && (c in opts.dirtyCells[ref]);
        const val = dirty ? opts.dirtyCells[ref][c] : (Array.isArray(row) ? row[j] : row?.[c]);
        return `<td class="${opts.editable ? "mpm-ecell" : ""}${dirty ? " is-dirty" : ""}"${opts.editable ? ` data-mpm-ecell="${escAttr(ref)}" data-mpm-ecol="${escAttr(String(c))}"` : ""}>${cellHtml(val, opts)}</td>`;
      }).join("")}
    </tr>`);
  });
  (opts.newRows || []).forEach((nr, k) => {
    const ref = `n:${k}`;
    const sel = opts.selectedRef === ref;
    body.push(`<tr class="mpm-erow is-newrow${sel ? " is-selrow" : ""}" data-mpm-erow="${ref}">
      <td class="mp-grid__num" title="新增行">＋</td>
      ${cols.map((c) => `<td class="mpm-ecell${(c in (nr || {})) ? " is-dirty" : ""}" data-mpm-ecell="${ref}" data-mpm-ecol="${escAttr(String(c))}">${cellHtml((c in (nr || {})) ? nr[c] : "", opts)}</td>`).join("")}
    </tr>`);
  });
  return `
    <div class="mp-grid${opts.className ? ` ${opts.className}` : ""}${opts.editable ? " mpm-egrid is-editable" : ""}"${opts.scrollKey ? ` data-mpm-scroll="${escAttr(opts.scrollKey)}"` : ""} role="table">
      <table>
        <thead><tr><th class="mp-grid__num">#</th>${head}</tr></thead>
        <tbody>${body.join("") || `<tr><td class="mp-grid__num">—</td><td colspan="${cols.length}" class="mp-grid__none">${esc(opts.emptyRowsText || "没有数据")}</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ---- 信息栏 -----------------------------------------------------------------------

export function infoHtml({ conn, object, live, inspection, absPath, formatBytes, formatTime, guessDriverLabel, dbSel }) {
  if (object && conn) {
    const t = object;
    const columns = Array.isArray(t.columns) ? t.columns : null;
    const pk = columns ? columns.filter((c) => c?.primary_key || c?.pk).map((c) => c.name) : [];
    return `
      <div class="mpm-info__obj">
        <span class="mpm-info__icon">${objectIcon(t.table_type || "table")}</span>
        <div class="mpm-info__title"><strong title="${escAttr(t.name || "")}">${esc(t.name || "")}</strong><em>${String(t.table_type || "table").toLowerCase() === "view" ? "视图" : "表"} · ${esc(conn.label)}</em></div>
      </div>
      <dl class="mpm-info__facts">
        <div><dt>行数</dt><dd>${typeof t.row_count === "number" ? Number(t.row_count).toLocaleString() : "—"}</dd></div>
        <div><dt>字段</dt><dd>${columns ? columns.length.toLocaleString() : "—"}</dd></div>
        ${columns ? `<div><dt>主键</dt><dd>${pk.length ? esc(pk.join(", ")) : "无"}</dd></div>` : ""}
        ${t.engine ? `<div><dt>引擎</dt><dd>${esc(t.engine)}</dd></div>` : ""}
        ${t.comment ? `<div><dt>说明</dt><dd>${esc(t.comment)}</dd></div>` : ""}
        ${inspection ? `<div><dt>修改日期</dt><dd>${formatTime(inspection.modified_ms)}</dd></div>` : ""}
      </dl>
      ${columns && columns.length ? `
        <div class="mpm-info__sub">字段</div>
        <div class="mpm-info__fields">
          ${columns.slice(0, 30).map((c) => `<div class="mpm-info__field"><span class="mpm-info__fname">${(c?.primary_key || c?.pk) ? `<span class="mp-grid__key" title="主键">${icon("key")}</span>` : ""}${esc(c?.name || "field")}</span><span class="mpm-info__ftype" title="${escAttr(c?.decl_type || c?.type || "")}">${esc(c?.decl_type || c?.type || "")}</span></div>`).join("")}
          ${columns.length > 30 ? `<span class="mpm-info__more">… 共 ${columns.length} 个字段</span>` : ""}
        </div>` : ""}
      <div class="mpm-info__actions">
        <button type="button" class="mp-run" data-mpm-open-sel>${icon("open")}<span>打开</span></button>
        <button type="button" class="mpm-ghost" data-mpm-open-sel data-mpm-mode="struct">${icon("struct")}<span>结构</span></button>
        <button type="button" class="mpm-ghost" data-mpm-open-sel data-mpm-mode="ddl">${wbIcon("code")}<span>DDL</span></button>
      </div>`;
  }
  if (conn && conn.kind === "file") {
    const sqlite = inspection?.sqlite || null;
    return `
      <div class="mpm-info__obj">
        <span class="mpm-info__icon">${icon("cylinder")}</span>
        <div class="mpm-info__title"><strong title="${escAttr(absPath)}">${esc(conn.label)}</strong><em>${esc(guessDriverLabel(conn.rel))}</em></div>
      </div>
      <dl class="mpm-info__facts">
        <div><dt>大小</dt><dd>${formatBytes(inspection?.size)}</dd></div>
        <div><dt>对象</dt><dd>${sqlite ? (sqlite.tables || []).length.toLocaleString() : "—"}</dd></div>
        <div><dt>页大小</dt><dd>${sqlite ? formatBytes(sqlite.page_size) : "—"}</dd></div>
        <div><dt>编码</dt><dd>${esc(sqlite?.text_encoding || "—")}</dd></div>
        <div><dt>修改日期</dt><dd>${formatTime(inspection?.modified_ms)}</dd></div>
        <div><dt>路径</dt><dd class="is-mono" title="${escAttr(absPath)}">${esc(absPath)}</dd></div>
      </dl>
      <div class="mpm-info__actions">
        <button type="button" class="mp-run" data-mpm-open="${escAttr(conn.key)}">${icon("open")}<span>打开工作台</span></button>
        <button type="button" class="mpm-ghost" data-mpm-copy="${escAttr(absPath)}">${icon("copy")}<span>复制路径</span></button>
      </div>`;
  }
  if (conn) {
    const c = conn.saved || {};
    const statusText = !live ? "未连接" : live.status === "loading" ? "连接中…" : live.status === "error" ? "连接失败" : "已连接";
    const sel = dbSel || {};
    return `
      <div class="mpm-info__obj">
        <span class="mpm-info__icon">${icon("cylinder")}</span>
        <div class="mpm-info__title"><strong>${esc(conn.label)}</strong><em>${esc(driverNames[conn.driver] || conn.driver)} · ${statusText}</em></div>
      </div>
      <div class="mpm-info__tags">${envBadgeHtml(c.env)}${c.readOnly ? `<span class="mpm-chip is-ro">${wbIcon("lock")}只读</span>` : ""}${c.ssl ? `<span class="mpm-chip">${wbIcon("shield")}SSL</span>` : ""}${c.group ? `<span class="mpm-chip">${icon("folder")}${esc(c.group)}</span>` : ""}</div>
      <dl class="mpm-info__facts">
        <div><dt>地址</dt><dd class="is-mono" title="${escAttr(connectionAddress(c))}">${esc(connectionAddress(c))}</dd></div>
        ${sel.database || live?.currentDatabase ? `<div><dt>当前库</dt><dd>${esc(sel.database || live.currentDatabase)}${sel.schema ? " · " + esc(sel.schema) : ""}</dd></div>` : ""}
        <div><dt>对象</dt><dd>${live?.status === "ready" && !live.redis ? (live.tables || []).length.toLocaleString() : "—"}</dd></div>
        ${live?.version ? `<div><dt>版本</dt><dd title="${escAttr(live.version)}">${esc(String(live.version).slice(0, 60))}</dd></div>` : ""}
        ${live?.latencyMs != null ? `<div><dt>延迟</dt><dd>${Number(live.latencyMs).toLocaleString()} ms</dd></div>` : ""}
        ${c.notes ? `<div><dt>备注</dt><dd>${esc(c.notes)}</dd></div>` : ""}
      </dl>
      <div class="mpm-info__actions">
        <button type="button" class="mp-run" data-mpm-act="new-query">${icon("query")}<span>新建查询</span></button>
        <button type="button" class="mpm-ghost" data-mpm-act="edit-conn">${icon("edit")}<span>编辑</span></button>
        <button type="button" class="mpm-ghost" data-mpm-act="refresh-conn">${icon("refresh")}<span>重连</span></button>
      </div>`;
  }
  // 没选中连接时不显示详情栏（main.js 会把这一栏整个藏起来），不放欢迎语。
  return "";
}

// ---- 连接对话框 / 确认框 ---------------------------------------------------------

export function connectionDialogHtml(d, { driverIds, driverHints, groups = [] }) {
  if (!d) return "";
  const isSqlite = d.driver === "sqlite";
  const row = (label, inner, cls = "") => `<div class="mpm-dialog__row${cls ? " " + cls : ""}"><label>${label}</label>${inner}</div>`;
  const envSeg = DB_ENVIRONMENTS.map(([id, label, color]) => `<button type="button" class="mpm-envseg${d.env === id ? " is-active" : ""}" data-mpm-dlg-env="${id}" style="--env:${color}">${esc(label)}</button>`).join("");
  return `
    <div class="mpm-dialog">
      <div class="mpm-dialog__card mpm-dialog__card--conn" role="dialog" aria-modal="true" aria-label="${d.id ? "编辑连接" : "新建连接"}">
        <h4>${icon("plugC")}<span>${d.id ? "编辑连接" : "新建连接"}</span>${d.id ? `<button type="button" class="mpm-dialog__dup" data-mpm-dlg-dup title="复制一份">${wbIcon("dup")}<span>复制</span></button>` : ""}</h4>
        <div class="mpm-dialog__grid">
          ${row("类型", selectPlaceholderHtml("dlg-driver", driverIds.map((x) => [x, driverNames[x] || x]), d.driver))}
          ${row("名称", `<input data-mpm-dlg-name value="${escAttr(d.name)}" placeholder="例如 订单库 · 生产" spellcheck="false" />`)}
          ${row("分组", `<input data-mpm-dlg-group list="mpm-groups" value="${escAttr(d.group || "")}" placeholder="可选，例如 电商 / 数据平台" spellcheck="false" /><datalist id="mpm-groups">${groups.map((g) => `<option value="${escAttr(g)}"></option>`).join("")}</datalist>`)}
          ${row("环境", `<div class="mpm-envrow">${envSeg}<button type="button" class="mpm-envseg${!d.env ? " is-active" : ""}" data-mpm-dlg-env="">未标</button></div>`)}
          ${isSqlite
            ? row("文件", `<input data-mpm-dlg-path value="${escAttr(d.path || "")}" placeholder="/绝对路径/data.db" spellcheck="false" />`)
            : d.rawMode
              ? row("连接串", `<input data-mpm-dlg-url value="${escAttr(d.url || "")}" placeholder="${escAttr(driverHints[d.driver] || "")}" spellcheck="false" />`, "is-wide")
              : `
          ${row("主机", `<div class="mpm-hostrow"><input data-mpm-dlg-host value="${escAttr(d.host || "")}" placeholder="127.0.0.1 或域名" spellcheck="false" /><span>:</span><input data-mpm-dlg-port class="is-port" value="${escAttr(d.port || "")}" placeholder="${escAttr(String(d.defaultPort || ""))}" inputmode="numeric" /></div>`)}
          ${row("用户名", `<input data-mpm-dlg-user value="${escAttr(d.user || "")}" autocomplete="off" spellcheck="false" />`)}
          ${row("密码", `<div class="mpm-pwrow"><input data-mpm-dlg-password type="${d.showPassword ? "text" : "password"}" value="${escAttr(d.password || "")}" autocomplete="new-password" /><button type="button" class="mpm-eye" data-mpm-dlg-eye title="${d.showPassword ? "隐藏" : "显示"}">${icon("eye")}</button></div>`)}
          ${row(d.driver === "elastic" ? "路径" : "数据库", `<input data-mpm-dlg-database value="${escAttr(d.database || "")}" placeholder="${d.driver === "redis" ? "0" : d.driver === "elastic" ? "可留空" : "可留空，连上后再选"}" spellcheck="false" />`)}
          ${row("选项", `<div class="mpm-optrow"><label><input type="checkbox" data-mpm-dlg-ssl ${d.ssl ? "checked" : ""} /> SSL / TLS</label>${d.driver === "mongodb" ? `<label><input type="checkbox" data-mpm-dlg-srv ${d.srv ? "checked" : ""} /> SRV（Atlas）</label>` : ""}<label class="is-ro"><input type="checkbox" data-mpm-dlg-ro ${d.readOnly ? "checked" : ""} /> 只读连接</label></div>`)}`}
          ${isSqlite ? row("选项", `<div class="mpm-optrow"><label class="is-ro"><input type="checkbox" data-mpm-dlg-ro ${d.readOnly ? "checked" : ""} /> 只读连接</label></div>`) : ""}
          ${row("备注", `<input data-mpm-dlg-notes value="${escAttr(d.notes || "")}" placeholder="可选：负责人、用途、注意事项" />`, "is-wide")}
        </div>
        ${!isSqlite ? `<button type="button" class="mpm-dialog__raw" data-mpm-dlg-rawtoggle>${d.rawMode ? "改用表单填写" : "直接填连接串"}</button>` : ""}
        <div class="mpm-dialog__hint">${esc(driverHints[d.driver] || "")}</div>
        <div class="mpm-dialog__test${d.testResult ? (d.testOk ? " is-ok" : " is-err") : ""}">${d.testing ? `<span class="mp-spinner"></span> 正在测试…` : esc(d.testResult || "")}</div>
        <div class="mpm-dialog__actions">
          ${d.id ? `<button type="button" class="mpm-ghost is-danger" data-mpm-dlg-delete>${wbIcon("trash")}<span>删除</span></button>` : ""}
          <i></i>
          <button type="button" class="mpm-ghost" data-mpm-dlg-cancel>取消</button>
          <button type="button" class="mpm-ghost" data-mpm-dlg-test ${d.testing ? "disabled" : ""}>${icon("connect")}<span>测试连接</span></button>
          <button type="button" class="mp-run" data-mpm-dlg-save>${icon("run")}<span>${d.id ? "保存" : "保存并连接"}</span></button>
        </div>
      </div>
    </div>`;
}

export function confirmDialogHtml(c) {
  if (!c) return "";
  return `
    <div class="mpm-dialog">
      <div class="mpm-dialog__card mpm-dialog__card--confirm" role="alertdialog" aria-modal="true" aria-label="${escAttr(c.title || "确认")}">
        <h4 class="${c.danger ? "is-danger" : ""}">${wbIcon(c.danger ? "warn" : "shield")}<span>${esc(c.title || "确认执行")}</span></h4>
        <p class="mpm-dialog__msg">${esc(c.message || "")}</p>
        ${c.preview ? `<pre class="mpm-dialog__pre">${esc(c.preview)}</pre>` : ""}
        ${c.ack ? `<label class="mpm-dialog__ack"><input type="checkbox" data-mpm-confirm-ack /> ${esc(c.ack)}</label>` : ""}
        <div class="mpm-dialog__actions">
          <i></i>
          <button type="button" class="mpm-ghost" data-mpm-confirm-cancel>取消</button>
          <button type="button" class="mp-run${c.danger ? " is-danger" : ""}" data-mpm-confirm-ok ${c.ack ? "disabled" : ""}>${esc(c.okLabel || "执行")}</button>
        </div>
      </div>
    </div>`;
}

// ---- 标签栏 / 状态栏 ---------------------------------------------------------------

export function centerTabsHtml({ centerTab, tableTabs, queryTabs, serverTabs }) {
  const tab = (key, ic, label, title, closable = true, extra = "") => `
    <button type="button" class="mp-tab${closable ? " mp-tab--table" : ""}${centerTab === key ? " is-active" : ""}" data-mpm-tab="${escAttr(key)}" title="${escAttr(title || label)}">
      ${ic}<span>${esc(label)}</span>${extra}
      ${closable ? `<span class="mp-tab__close" data-mpm-closetab="${escAttr(key)}" role="button" aria-label="关闭 ${escAttr(label)}">${icon("close")}</span>` : ""}
    </button>`;
  return [
    tab("objects", icon("grid"), "对象", "对象", false),
    ...tableTabs.map((t) => tab(`t:${t.id}`, objectIcon(t.tableType || "table"), t.name, `${t.connLabel || ""} · ${t.name}`, true, t.dirty ? `<span class="mp-tab__dot" title="有未保存的改动"></span>` : "")),
    ...queryTabs.map((t) => tab(`q:${t.id}`, icon("query"), t.title, t.title, true, t.running ? `<span class="mp-spinner mp-spinner--xs"></span>` : "")),
    ...serverTabs.map((t) => tab(`s:${t.id}`, wbIcon("server"), t.title, t.title, true)),
  ].join("");
}

export function statusHtml({ files, savedCount, conn, objectCount, centerTab, lastQuery, dbSel, live }) {
  const connCount = (Array.isArray(files) ? files.length : 0) + savedCount;
  const crumbs = [];
  if (conn) {
    crumbs.push(`<span class="mpm-crumb">${envDotHtml(conn.saved?.env)}${esc(conn.label)}</span>`);
    const db = dbSel?.database || live?.currentDatabase;
    if (db) crumbs.push(`<span class="mpm-crumb">${wbIcon("database")}${esc(db)}</span>`);
    if (dbSel?.schema) crumbs.push(`<span class="mpm-crumb">${wbIcon("layers")}${esc(dbSel.schema)}</span>`);
  }
  return `
    <span>${Array.isArray(files) ? `${connCount} 个连接` : "扫描中…"}</span>
    ${crumbs.length ? `<span class="mpm-crumbs">${crumbs.join('<i class="mpm-crumb__sep">›</i>')}</span>` : ""}
    ${conn && centerTab === "objects" ? `<span>${objectCount} 个对象</span>` : ""}
    ${lastQuery ? `<span class="mpm-status__last${lastQuery.ok ? "" : " is-err"}" title="${escAttr(lastQuery.sql || "")}">${lastQuery.ok ? wbIcon("check") : wbIcon("warn")}${lastQuery.ok ? `${lastQuery.rows == null ? "" : Number(lastQuery.rows).toLocaleString() + " 行 · "}${Number(lastQuery.ms || 0).toLocaleString()} ms` : "上一条失败"}</span>` : ""}
    <i></i>
    ${conn?.saved?.readOnly ? `<span class="mpm-status__ro">${wbIcon("lock")}只读</span>` : ""}
    <span class="mp-statusbar__brand">Michael Premium</span>`;
}
