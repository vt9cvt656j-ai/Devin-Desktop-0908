/**
 * 数据库工作台（企业版）的三块中央面板：表页签（数据 / 结构 / 索引 / 外键 / DDL）、
 * 查询页签（多语句结果、历史、AI 助手）、服务器页签（概览 + 会话）。和 views 一样是
 * state → HTML 的纯函数，图标与转义由 main.js 注入。
 */
import { configureDbWorkbenchViews, wbIcon, gridHtml, envBadgeHtml, selectPlaceholderHtml } from "./db-workbench-views.js";
import { isSqlDriver, hasSchemas, formatUptime } from "./db-dialects.js";
import { sqlPreview, formatRelativeTime } from "./db-history.js";

let icon = () => "";
let objectIcon = () => "";
let esc = (s) => String(s ?? "");
let escAttr = (s) => String(s ?? "");
let shortcut = (s) => s;
let driverNames = {};

export function configureDbWorkbenchPanels(deps = {}) {
  if (deps.icon) icon = deps.icon;
  if (deps.objectIcon) objectIcon = deps.objectIcon;
  if (deps.escHtml) esc = deps.escHtml;
  if (deps.escAttr) escAttr = deps.escAttr;
  if (deps.shortcut) shortcut = deps.shortcut;
  if (deps.driverNames) driverNames = deps.driverNames;
  configureDbWorkbenchViews(deps);
}

// ---- 表页签 -----------------------------------------------------------------------

const TABLE_MODES = [
  ["data", "grid", "数据"],
  ["struct", "struct", "结构"],
  ["indexes", "columns", "索引"],
  ["fks", "link", "外键"],
  ["ddl", "code", "DDL"],
];

export function tableModesHtml(tab, { sqlDriver }) {
  const modes = sqlDriver ? TABLE_MODES : TABLE_MODES.filter(([m]) => m === "data" || m === "struct");
  return `<div class="mp-seg" role="tablist">${modes.map(([m, ic, label]) => `<button type="button" class="${tab.mode === m ? "is-active" : ""}" data-mpm-ttab-mode="${m}">${m === "data" ? icon("grid") : m === "struct" ? icon("struct") : wbIcon(ic)}<span>${label}</span></button>`).join("")}</div>`;
}

function pagerHtml(tab) {
  const size = Number(tab.pageSize) || 200;
  const page = Number(tab.page) || 0;
  const shown = (tab.rows || []).length;
  const total = tab.total;
  const from = shown ? page * size + 1 : 0;
  const to = page * size + shown;
  const hasMore = tab.truncated || (typeof total === "number" && to < total);
  return `
    <div class="mpm-pager">
      <button type="button" data-mpm-page="first" ${page === 0 ? "disabled" : ""} title="第一页">${wbIcon("first")}</button>
      <button type="button" data-mpm-page="prev" ${page === 0 ? "disabled" : ""} title="上一页">${wbIcon("left")}</button>
      <span class="mpm-pager__info">${from.toLocaleString()}–${to.toLocaleString()}${typeof total === "number" ? ` / ${total.toLocaleString()}` : hasMore ? " / …" : ""}</span>
      <button type="button" data-mpm-page="next" ${hasMore ? "" : "disabled"} title="下一页">${wbIcon("right")}</button>
      ${typeof total === "number" ? `<button type="button" data-mpm-page="last" ${to < total ? "" : "disabled"} title="最后一页">${wbIcon("last")}</button>` : `<button type="button" data-mpm-page="count" title="统计总行数">Σ</button>`}
      <span class="mp-limit">每页 ${selectPlaceholderHtml("ttab-limit", [50, 100, 200, 500, 1000, 2000].map((n) => [n, String(n)]), size)}</span>
    </div>`;
}

export function tableTabHtml(tab, ctx) {
  const { conn, fileConn, inspectionTable, editable, editCount, columnsMeta } = ctx;
  const sqlDriver = isSqlDriver(conn?.driver) || fileConn;
  const mode = tab.mode || "data";
  const connLabel = conn?.label || "";
  const scroll = `mpm:${tab.id}`;
  let body = "";
  let statusText = "";
  const retry = `<div class="mpm-info__actions"><button type="button" class="mp-run" data-mpm-ttab-refresh>${icon("refresh")}<span>重试</span></button></div>`;
  const loading = (text) => `<div class="mp-running"><span class="mp-spinner"></span>${text}</div>`;
  const failed = (text) => `<div class="mp-blank"><span class="mp-blank__icon">${wbIcon("warn")}</span><h3>读取失败</h3><p>${esc(text || "")}</p>${retry}</div>`;
  const metaStatus = tab.metaStatus?.[mode];

  if (mode === "struct") {
    const cols = Array.isArray(columnsMeta) ? columnsMeta : null;
    if (!cols && metaStatus === "error") body = failed(tab.metaError?.[mode]);
    else if (!cols) body = loading("正在读取结构…");
    else body = cols.length
      ? gridHtml(["字段", "类型", "可空", "默认值", "键", "附加", "说明"], cols.map((c) => [c.name, c.type, c.nullable ? "YES" : "NO", c.default, c.pk ? "PK" : "", c.extra, c.comment]), { scrollKey: scroll, className: "mpm-structgrid", emptyRowsText: "没有字段" })
      : `<div class="mp-blank"><h3>没有字段信息</h3><p>点「刷新」重新读取。</p></div>`;
    statusText = cols ? `${cols.length} 个字段${cols.some((c) => c.pk) ? ` · 主键 ${cols.filter((c) => c.pk).map((c) => c.name).join(", ")}` : " · 无主键"}` : "";
  } else if (mode === "indexes") {
    const ix = tab.indexes;
    if (!ix && metaStatus === "error") body = failed(tab.metaError?.[mode]);
    else if (!ix) body = loading("正在读取索引…");
    else body = ix.length
      ? gridHtml(["索引", "列", "唯一", "主键", "类型"], ix.map((i) => [i.name, i.columns, i.unique ? "✓" : "", i.primary ? "✓" : "", i.type]), { scrollKey: scroll, emptyRowsText: "没有索引" })
      : `<div class="mp-blank"><span class="mp-blank__icon">${wbIcon("columns")}</span><h3>没有索引</h3><p>这张表上没有索引；大表上按常用查询列建索引能明显提速。</p></div>`;
    statusText = ix ? `${ix.length} 个索引` : "";
  } else if (mode === "fks") {
    const fk = tab.foreignKeys;
    if (!fk && metaStatus === "error") body = failed(tab.metaError?.[mode]);
    else if (!fk) body = loading("正在读取外键…");
    else body = fk.length
      ? gridHtml(["约束", "本表列", "引用表", "引用列", "更新时", "删除时"], fk.map((f) => [f.name, f.columns, f.refTable, f.refColumns, f.onUpdate, f.onDelete]), { scrollKey: scroll })
      : `<div class="mp-blank"><span class="mp-blank__icon">${wbIcon("link")}</span><h3>没有外键</h3><p>这张表没有声明外键约束。</p></div>`;
    statusText = fk ? `${fk.length} 个外键` : "";
  } else if (mode === "ddl") {
    if (tab.ddl == null && metaStatus === "error") body = failed(tab.metaError?.[mode]);
    else if (tab.ddl == null) body = loading("正在生成 DDL…");
    else body = `<div class="mpm-ddl"><div class="mpm-ddl__bar"><span class="mp-objects__hint">${conn?.driver === "postgres" || conn?.driver === "mssql" ? "由目录信息拼出（列 / 主键 / 外键 / 索引 / 注释）" : "引擎返回的建表语句"}</span><i></i><button type="button" data-mpm-copy-text="${escAttr(tab.ddl)}">${icon("copy")}<span>复制</span></button><button type="button" data-mpm-act="ddl-to-query">${icon("query")}<span>在查询中打开</span></button></div><pre class="mpm-ddl__pre">${esc(tab.ddl || "-- 没有拿到 DDL")}</pre></div>`;
    statusText = tab.ddl != null ? `${String(tab.ddl).split("\n").length} 行` : "";
  } else {
    // 数据
    if (tab.status === "loading" || tab.status === "idle") body = loading("正在加载数据…");
    else if (tab.status === "error") body = failed(tab.error);
    else {
      const pkSet = new Set((columnsMeta || []).filter((c) => c.pk).map((c) => c.name));
      const typeMap = {};
      for (const c of columnsMeta || []) typeMap[c.name] = c.type || "";
      body = gridHtml(tab.columns || [], tab.rows || [], {
        scrollKey: scroll, pkSet, typeMap, sortable: !fileConn || true, sortCol: tab.sortCol, sortDir: tab.sortDir,
        offset: (Number(tab.page) || 0) * (Number(tab.pageSize) || 200), editable,
        rowRefs: (i) => `r:${i}`, dirtyCells: ctx.dirtyCells, deletedRefs: ctx.deletedRefs, selectedRef: tab.selRow, newRows: tab.newRows,
        formatBytes: ctx.formatBytes, emptyRowsText: tab.where ? "没有符合筛选条件的行" : "这张表当前没有数据",
      });
      const shown = (tab.rows || []).length;
      statusText = `${shown.toLocaleString()} 行${typeof tab.total === "number" ? `（共 ${tab.total.toLocaleString()}）` : tab.truncated ? "（还有更多）" : ""}${editCount ? ` · ${editCount} 处待保存` : ""} · ${Number(tab.elapsed || 0).toLocaleString()} ms`;
    }
  }
  const editBar = mode === "data" && tab.status === "ready"
    ? (editable ? `
        <div class="mpm-crud">
          <button type="button" data-mpm-ecrud="add" title="添加一行">${icon("plus")}<span>添加行</span></button>
          <button type="button" data-mpm-ecrud="del" title="删除选中行" ${tab.selRow ? "" : "disabled"}>${icon("minus")}<span>删除行</span></button>
          ${editCount ? `<button type="button" class="mp-run" data-mpm-ecrud="save">保存 (${editCount})</button><button type="button" class="mpm-ghost" data-mpm-ecrud="discard">放弃</button>` : ""}
        </div>`
      : `<span class="mpm-readonly-hint">${tab.tableType === "view" ? "视图只读" : ctx.readOnlyReason || "只读"}</span>`)
    : "";
  const filterBar = mode === "data" ? `
      <div class="mpm-filterbar">
        ${wbIcon("filter")}
        <input data-mpm-where value="${escAttr(tab.where || "")}" placeholder="${sqlDriver ? "WHERE 条件，例如 status = 'paid' AND amount > 100（回车应用）" : conn?.driver === "mongodb" ? "筛选 JSON，例如 {\"status\": \"paid\"}" : "查询串"}" spellcheck="false" aria-label="筛选条件" />
        ${tab.where ? `<button type="button" data-mpm-where-clear title="清除筛选">${icon("close")}</button>` : ""}
      </div>` : "";
  return `
    <div class="mpm-objbar mpm-objbar--table">
      ${tableModesHtml(tab, { sqlDriver })}
      ${editBar}
      <i></i>
      ${mode === "data" && tab.status === "ready" ? `
        <div class="mpm-menu" data-mpm-menu="export">
          <button type="button" data-mpm-menu-toggle title="导出当前数据">${wbIcon("download")}<span>导出</span></button>
          <div class="mpm-menu__list" hidden>
            <button type="button" data-mpm-export="csv">复制为 CSV</button>
            <button type="button" data-mpm-export="json">复制为 JSON</button>
            <button type="button" data-mpm-export="md">复制为 Markdown</button>
            <button type="button" data-mpm-export="insert">复制为 INSERT 语句</button>
            <i></i>
            <button type="button" data-mpm-export="csv-file">保存 CSV 文件…</button>
            <button type="button" data-mpm-export="json-file">保存 JSON 文件…</button>
          </div>
        </div>` : ""}
      <button type="button" data-mpm-act="table-to-query" title="在查询中打开 SELECT">${icon("query")}</button>
      <button type="button" data-mpm-ttab-refresh title="重新加载">${icon("refresh")}</button>
      ${fileConn ? `<button type="button" data-mpm-wb-table="${escAttr(tab.name)}" title="在完整工作台打开">${icon("open")}</button>` : ""}
    </div>
    ${filterBar}
    ${editable && mode === "data" ? `<div class="mpm-edithint">双击单元格改值 · ${tab.saving ? "正在保存…" : "改动累积后点「保存」，会先预览生成的 SQL"}</div>` : ""}
    ${body}
    <footer class="mp-tableview__status">
      <span class="mp-tableview__name">${objectIcon(tab.tableType || "table")}${esc(tab.schema ? tab.schema + "." : "")}${esc(tab.name)}</span>
      <span>${statusText}</span>
      ${mode === "data" && tab.status === "ready" ? pagerHtml(tab) : ""}
      <span class="mp-tableview__conn">${envBadgeHtml(conn?.saved?.env, { small: true })}${esc(connLabel)}</span>
    </footer>`;
}

// ---- 查询页签 ---------------------------------------------------------------------

function resultBlockHtml(r, idx, { formatBytes }) {
  if (!r) return "";
  if (r.error) return `<div class="mp-error"><strong>第 ${idx + 1} 条失败</strong>${esc(r.error)}${r.sql ? `<pre>${esc(sqlPreview(r.sql, 300))}</pre>` : ""}</div>`;
  if (Array.isArray(r.columns)) {
    if (!r.columns.length) return `<div class="mp-affected">${wbIcon("check")}查询成功 · 0 行 · ${Number(r.elapsed_ms || 0).toLocaleString()} ms</div>`;
    return `${gridHtml(r.columns, r.rows || [], { scrollKey: `result:${idx}`, sortable: true, sortCol: r.sortCol, sortDir: r.sortDir, formatBytes })}
      <div class="mp-result-meta">
        <span>${r.truncated ? `已显示前 ${(r.rows || []).length.toLocaleString()} 行，还有更多` : `${(r.rows || []).length.toLocaleString()} 行`}</span>
        <span>${Number(r.elapsed_ms || 0).toLocaleString()} ms</span>
        <div class="mpm-menu" data-mpm-menu="export-result">
          <button type="button" data-mpm-menu-toggle>${wbIcon("download")}<span>导出</span></button>
          <div class="mpm-menu__list" hidden>
            <button type="button" data-mpm-export="csv" data-mpm-result-idx="${idx}">复制为 CSV</button>
            <button type="button" data-mpm-export="json" data-mpm-result-idx="${idx}">复制为 JSON</button>
            <button type="button" data-mpm-export="md" data-mpm-result-idx="${idx}">复制为 Markdown</button>
            <i></i>
            <button type="button" data-mpm-export="csv-file" data-mpm-result-idx="${idx}">保存 CSV 文件…</button>
            <button type="button" data-mpm-export="json-file" data-mpm-result-idx="${idx}">保存 JSON 文件…</button>
          </div>
        </div>
      </div>`;
  }
  if (r.result !== undefined) return `<pre class="mp-json">${esc(JSON.stringify(r.result, null, 2))}</pre>`;
  if (r.ok || r.rows_affected !== undefined) return `<div class="mp-affected">${wbIcon("check")}执行成功 · ${Number(r.rows_affected || 0).toLocaleString()} 行受影响 · ${Number(r.elapsed_ms || 0).toLocaleString()} ms</div>`;
  if (r.blocked) return `<div class="mp-error"><strong>没有执行</strong>${esc(r.blocked)}</div>`;
  return `<div class="mp-empty">没有返回结果</div>`;
}

export function queryResultsHtml(tab, ctx) {
  if (tab.running) return `<div class="mp-running"><span class="mp-spinner"></span>正在执行${tab.runningIndex != null && tab.runningTotal > 1 ? `第 ${tab.runningIndex + 1} / ${tab.runningTotal} 条` : ""}…</div>`;
  const results = Array.isArray(tab.results) ? tab.results : [];
  if (!results.length) {
    return `<div class="mp-empty">${esc(shortcut("mod+enter"))} 执行全部；选中一段再按 ${esc(shortcut("mod+enter"))} 只跑选中；${esc(shortcut("mod+shift+f"))} 格式化；${esc(shortcut("mod+e"))} 看执行计划。多条语句用分号分隔，结果按语句分页显示。</div>`;
  }
  if (results.length === 1) return resultBlockHtml(results[0], 0, ctx);
  const active = Math.min(Number(tab.activeResult) || 0, results.length - 1);
  return `
    <div class="mpm-results__tabs">
      ${results.map((r, i) => `<button type="button" class="${i === active ? "is-active" : ""}${r.error ? " is-err" : ""}" data-mpm-result="${i}" title="${escAttr(sqlPreview(r.sql || "", 160))}">${r.error ? wbIcon("warn") : ""}执行结果 ${i + 1}${Array.isArray(r.columns) ? ` · ${(r.rows || []).length}` : r.rows_affected != null ? ` · ${r.rows_affected} 行` : ""}</button>`).join("")}
    </div>
    <div class="mpm-results__body">${resultBlockHtml(results[active], active, ctx)}</div>`;
}

export function historyPanelHtml(items, { filter = "", snippets = [] } = {}) {
  return `
    <aside class="mpm-side mpm-side--history">
      <div class="mpm-side__head">${wbIcon("history")}<span>历史与片段</span><i></i><button type="button" data-mpm-snippet-save title="把编辑器里的 SQL 存成常用片段">${wbIcon("pin")}</button><button type="button" data-mpm-side-close aria-label="关闭">${icon("close")}</button></div>
      <label class="mp-side-search mpm-side__search">${icon("search")}<input data-mpm-history-filter value="${escAttr(filter)}" placeholder="搜索历史与片段" /></label>
      <div class="mpm-side__list">
        ${snippets.length ? `<div class="mpm-side__sect">常用片段</div>${snippets.filter((sn) => !filter || sn.name.toLowerCase().includes(String(filter).toLowerCase()) || sn.sql.toLowerCase().includes(String(filter).toLowerCase())).map((sn) => `
          <div class="mpm-hist mpm-hist--snippet" title="${escAttr(sn.sql)}">
            <button type="button" class="mpm-hist__main" data-mpm-snippet="${escAttr(sn.name)}"><strong>${esc(sn.name)}</strong><code>${esc(sqlPreview(sn.sql, 100))}</code></button>
            <button type="button" class="mpm-hist__del" data-mpm-snippet-del="${escAttr(sn.name)}" title="删除片段">${icon("close")}</button>
          </div>`).join("")}<div class="mpm-side__sect">最近执行</div>` : ""}
        ${items.length ? items.map((h) => `
          <button type="button" class="mpm-hist${h.ok ? "" : " is-err"}" data-mpm-hist="${escAttr(h.id)}" title="${escAttr(h.sql)}">
            <code>${esc(sqlPreview(h.sql, 120))}</code>
            <span>${esc(formatRelativeTime(h.at))}${h.ok ? (h.rows == null ? "" : ` · ${Number(h.rows).toLocaleString()} 行`) + ` · ${Number(h.ms || 0).toLocaleString()} ms` : ` · 失败`}${h.connName ? ` · ${esc(h.connName)}` : ""}</span>
          </button>`).join("") : `<div class="mpm-side__empty">还没有历史。跑过的语句会记在这里，点一条回填到编辑器。</div>`}
      </div>
    </aside>`;
}

export function aiPanelHtml(ai, { hasModel }) {
  const a = ai || {};
  const modes = [["generate", "生成 SQL"], ["explain", "解释"], ["optimize", "优化"], ["fix", "修错"]];
  return `
    <aside class="mpm-side mpm-side--ai">
      <div class="mpm-side__head">${wbIcon("sparkle")}<span>AI 助手</span><i></i><button type="button" data-mpm-side-close aria-label="关闭">${icon("close")}</button></div>
      <div class="mpm-ai__modes">${modes.map(([m, label]) => `<button type="button" class="${(a.mode || "generate") === m ? "is-active" : ""}" data-mpm-ai-mode="${m}">${label}</button>`).join("")}</div>
      ${(a.mode || "generate") === "generate" ? `<textarea data-mpm-ai-task placeholder="用中文说要查什么，例如：最近 7 天每个客户的订单总额，按金额倒序取前 20" rows="4">${esc(a.task || "")}</textarea>` : `<p class="mpm-ai__hint">${a.mode === "fix" ? "会把编辑器里的 SQL 和上一次的报错一起交给模型。" : a.mode === "optimize" ? "针对编辑器里的 SQL 给出改写与索引建议。" : "解释编辑器里的 SQL。"}</p>`}
      <div class="mpm-ai__actions">
        <button type="button" class="mp-run" data-mpm-ai-run ${a.busy || !hasModel ? "disabled" : ""}>${a.busy ? `<span class="mp-spinner"></span>` : wbIcon("sparkle")}<span>${a.busy ? "思考中…" : "开始"}</span></button>
        ${!hasModel ? `<span class="mpm-ai__nomodel">请先登录账号并选择模型</span>` : `<span class="mpm-ai__note">用当前选择的模型 · 只发送表结构，不发送数据</span>`}
      </div>
      ${a.error ? `<div class="mp-error">${esc(a.error)}</div>` : ""}
      ${a.reply ? `
        <div class="mpm-ai__reply">
          ${a.sql ? `<pre class="mpm-ai__sql">${esc(a.sql)}</pre><div class="mpm-ai__replyactions"><button type="button" class="mp-run" data-mpm-ai-insert>${icon("edit")}<span>放进编辑器</span></button><button type="button" class="mpm-ghost" data-mpm-copy-text="${escAttr(a.sql)}">${icon("copy")}<span>复制</span></button></div>` : ""}
          ${a.explanation ? `<div class="mpm-ai__text">${esc(a.explanation)}</div>` : ""}
        </div>` : ""}
    </aside>`;
}

export function queryTabHtml(tab, ctx) {
  const { conn, history, canExplain, readOnly, hasModel, snippets = [] } = ctx;
  const side = tab.side === "history" ? historyPanelHtml(history, { filter: tab.historyFilter, snippets }) : tab.side === "ai" ? aiPanelHtml(tab.ai, { hasModel }) : "";
  return `
    <div class="mpm-console${side ? " has-side" : ""}">
      <div class="mpm-qbar">
        <button type="button" class="mp-run" data-mpm-run title="执行（${escAttr(shortcut("mod+enter"))}）" ${tab.running ? "disabled" : ""}>${wbIcon("play")}<span>执行</span></button>
        <button type="button" data-mpm-run-sel title="只执行选中的语句（${escAttr(shortcut("mod+enter"))}，有选中时自动只跑选中）" ${tab.running ? "disabled" : ""}>${wbIcon("playSel")}<span>执行选中</span></button>
        <button type="button" data-mpm-explain title="执行计划（${escAttr(shortcut("mod+e"))}）" ${canExplain && !tab.running ? "" : "disabled"}>${wbIcon("explain")}<span>执行计划</span></button>
        <button type="button" data-mpm-format title="格式化 SQL（${escAttr(shortcut("mod+shift+f"))}）">${wbIcon("wand")}<span>格式化</span></button>
        <i class="mpm-rib__sep"></i>
        <button type="button" class="${tab.side === "history" ? "is-active" : ""}" data-mpm-side="history" title="查询历史">${wbIcon("history")}<span>历史</span></button>
        <button type="button" class="${tab.side === "ai" ? "is-active" : ""}" data-mpm-side="ai" title="AI 生成 / 解释 / 优化 / 修错">${wbIcon("sparkle")}<span>AI</span></button>
        <i></i>
        <span class="mp-limit">上限 ${selectPlaceholderHtml("qlimit", [100, 500, 1000, 2000].map((n) => [n, String(n)]), Number(tab.limit) || 1000)}</span>
        <span class="mpm-qconn" title="${escAttr(conn ? conn.label : "未绑定连接")}">${envBadgeHtml(conn?.saved?.env, { small: true })}${readOnly ? `<span class="mpm-chip is-ro">${wbIcon("lock")}只读</span>` : ""}<span class="mpm-qconn__name">${esc(conn ? conn.label : "未绑定连接")}</span><em>${esc(driverNames[tab.driver] || tab.driver)}</em></span>
      </div>
      <div class="mpm-console__main">
        <div class="mpm-console__editor">
          <div class="mpm-sqlhost" data-mpm-sql-mount></div>
          <div class="mp-query__result mpm-results" data-mpm-result>${queryResultsHtml(tab, ctx)}</div>
        </div>
        ${side}
      </div>
    </div>`;
}

// ---- 服务器页签 ------------------------------------------------------------------

export function serverTabHtml(tab, ctx) {
  const { conn } = ctx;
  const info = tab.info || {};
  const facts = Array.isArray(tab.facts) ? tab.facts : [];
  const sessions = tab.sessions;
  const canKill = ctx.canKill;
  return `
    <div class="mpm-server">
      <div class="mpm-objbar">
        <span class="mp-objects__hint">${wbIcon("server")}<span>${esc(conn?.label || "")} · ${esc(driverNames[conn?.driver] || conn?.driver || "")}</span></span>
        <i></i>
        <button type="button" data-mpm-server-refresh>${icon("refresh")}<span>刷新</span></button>
      </div>
      ${tab.status === "error" ? `<div class="mp-error">${esc(tab.error || "")}</div>` : ""}
      <div class="mpm-server__facts">
        ${facts.length ? facts.map((f) => `<div class="mpm-fact"><span>${esc(f.label)}</span><strong title="${escAttr(String(f.value ?? ""))}">${f.value == null ? (tab.status === "loading" ? `<span class="mp-spinner"></span>` : "—") : esc(f.seconds ? formatUptime(f.value) : String(f.value))}</strong></div>`).join("") : `<div class="mpm-fact"><span>信息</span><strong>${tab.status === "loading" ? `<span class="mp-spinner"></span>` : "这个引擎没有可读的服务器信息"}</strong></div>`}
      </div>
      ${info.raw ? `<pre class="mp-json mpm-server__raw">${esc(info.raw)}</pre>` : ""}
      ${sessions !== undefined ? `
      <div class="mpm-server__sessions">
        <div class="mpm-server__subhead">${wbIcon("dots")}<span>会话 / 进程</span><em>${Array.isArray(sessions) ? sessions.length : ""}</em><i></i>${canKill ? `<span class="mp-objects__hint">选中一行后可终止</span>` : ""}</div>
        ${Array.isArray(sessions) ? (sessions.length ? `
          <div class="mp-grid mpm-sessgrid">
            <table>
              <thead><tr><th>ID</th><th>用户</th><th>来源</th><th>库</th><th>状态</th><th>耗时(s)</th><th>等待</th><th>语句</th>${canKill ? "<th></th>" : ""}</tr></thead>
              <tbody>${sessions.map((s) => `<tr><td class="is-num">${esc(String(s[0] ?? ""))}</td><td>${esc(String(s[1] ?? ""))}</td><td>${esc(String(s[2] ?? ""))}</td><td>${esc(String(s[3] ?? ""))}</td><td><span class="mpm-chip${/active|running|query|execut/i.test(String(s[4] || "")) ? " is-on" : ""}">${esc(String(s[4] ?? ""))}</span></td><td class="is-num">${esc(String(s[5] ?? ""))}</td><td>${esc(String(s[6] ?? ""))}</td><td class="is-mono is-dim" title="${escAttr(String(s[7] ?? ""))}">${esc(String(s[7] ?? "").slice(0, 120))}</td>${canKill ? `<td><button type="button" class="mpm-kill" data-mpm-kill="${escAttr(String(s[0] ?? ""))}" title="终止这个会话">${wbIcon("stop")}</button></td>` : ""}</tr>`).join("")}</tbody>
            </table>
          </div>` : `<div class="mp-empty">没有其它会话</div>`) : (typeof sessions === "string" ? `<pre class="mp-json">${esc(sessions)}</pre>` : `<div class="mp-running"><span class="mp-spinner"></span>正在读取会话…</div>`)}
      </div>` : ""}
    </div>`;
}
