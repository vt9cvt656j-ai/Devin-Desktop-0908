// Excel（JS 侧）：用 exceljs **读**已有工作簿的结构，以及**修改**已有工作簿后另存。
// 新建工作簿走 Rust（src-tauri/src/office_xlsx.rs，rust_xlsxwriter）——那边能写原生图表、
// 条件格式、数据验证、表格、图片、页面设置，JS 生态没有能写原生 xlsx 图表的开源库。
// 这里的「修改」覆盖：改/加单元格与整行、公式、样式（字体/填充/对齐/边框/数字格式）、合并、
// 列宽行高、冻结、筛选、加/删/重命名工作表、插入/删除行、批注、超链接、数据验证、条件格式、图片。
// 规格词汇和 Rust 那边一致（同一份 help），所以模型学一套就够。

let _excel = null;
async function lib() {
  if (!_excel) { const m = await import("exceljs"); _excel = m.default || m; }
  return _excel;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const argb = (c) => {
  const s = String(c || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(s)) return s.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "FF" + s.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(s)) return "FF" + s.split("").map((x) => x + x).join("").toUpperCase();
  return null;
};
const BORDER_STYLES = new Set(["thin", "medium", "thick", "dashed", "dotted", "double", "hair", "mediumDashed", "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot"]);

/** 规格样式（也可是命名样式名）→ exceljs 的 style 片段。 */
export function toXlsxStyle(style, named = {}) {
  const st = typeof style === "string" ? named[style] : style;
  if (!st || typeof st !== "object") return {};
  const out = {};
  const font = {};
  if (st.bold != null) font.bold = !!st.bold;
  if (st.italic != null) font.italic = !!st.italic;
  if (st.underline) font.underline = st.underline === true ? true : String(st.underline);
  if (st.strike) font.strike = true;
  if (st.size) font.size = num(st.size, 11);
  if (st.font) font.name = String(st.font);
  if (st.color && argb(st.color)) font.color = { argb: argb(st.color) };
  if (Object.keys(font).length) out.font = font;
  const fillColor = st.fill ?? st.bg ?? st.background;
  if (fillColor) {
    const c = typeof fillColor === "object" ? fillColor.color : fillColor;
    if (argb(c)) out.fill = { type: "pattern", pattern: (typeof fillColor === "object" && fillColor.pattern) || "solid", fgColor: { argb: argb(c) } };
  }
  const al = st.align && typeof st.align === "object" ? st.align : (typeof st.align === "string" ? { h: st.align } : null);
  if (al || st.wrap != null || st.valign) {
    const a = {};
    const h = al?.h || al?.horizontal; if (h) a.horizontal = h === "justify" ? "justify" : h;
    const v = al?.v || al?.vertical || st.valign; if (v) a.vertical = v;
    if (al?.wrap != null) a.wrapText = !!al.wrap; if (st.wrap != null) a.wrapText = !!st.wrap;
    if (al?.indent != null) a.indent = num(al.indent, 0);
    if (al?.rotation != null || al?.textRotation != null) a.textRotation = num(al.rotation ?? al.textRotation, 0);
    if (al?.shrink) a.shrinkToFit = true;
    out.alignment = a;
  }
  if (st.border) {
    const side = (v) => {
      if (!v) return undefined;
      if (v === true) return { style: "thin" };
      if (typeof v === "string") return { style: BORDER_STYLES.has(v) ? v : "thin", color: undefined };
      return { style: BORDER_STYLES.has(v.style) ? v.style : "thin", color: v.color && argb(v.color) ? { argb: argb(v.color) } : undefined };
    };
    if (st.border === true || typeof st.border === "string") { const s = side(st.border === true ? "thin" : st.border); const withColor = st.borderColor && argb(st.borderColor) ? { ...s, color: { argb: argb(st.borderColor) } } : s; out.border = { top: withColor, left: withColor, bottom: withColor, right: withColor }; }
    else { const b = {}; for (const k of ["top", "left", "bottom", "right", "diagonal"]) if (st.border[k]) b[k] = side(st.border[k]); if (st.border.all) { const s = side(st.border.all); b.top = b.top || s; b.left = b.left || s; b.bottom = b.bottom || s; b.right = b.right || s; } out.border = b; }
  }
  if (st.numFmt || st.format) out.numFmt = String(st.numFmt || st.format);
  if (st.locked != null || st.hidden != null) out.protection = { locked: st.locked, hidden: st.hidden };
  return out;
}

/** 单元格规格 → exceljs 值（公式 / 富文本 / 超链接 / 日期）。 */
export function toCellValue(v) {
  if (v == null) return null;
  if (typeof v === "string") return v.startsWith("=") ? { formula: v.slice(1) } : v;
  if (typeof v !== "object" || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v.rich || v.richText) return { richText: (v.rich || v.richText).map((r) => (typeof r === "string" ? { text: r } : { text: String(r.text ?? ""), font: toXlsxStyle(r).font })) };
  const f = v.f ?? v.formula;
  if (f != null) { const o = { formula: String(f).replace(/^=/, "") }; if (v.v != null || v.result != null) o.result = v.v ?? v.result; return o; }
  let val = v.v ?? v.value ?? v.text ?? null;
  const t = String(v.t || v.type || "").toLowerCase();
  if (t === "date" || t === "datetime") val = val instanceof Date ? val : new Date(val);
  else if (t === "number") val = num(val, null);
  else if (t === "bool" || t === "boolean") val = val === true || val === "true" || val === 1;
  else if (t === "string") val = val == null ? "" : String(val);
  else if (typeof val === "string" && val.startsWith("=")) return { formula: val.slice(1) };
  if (v.link || v.hyperlink) return { text: val == null ? String(v.link || v.hyperlink) : String(val), hyperlink: String(v.link || v.hyperlink), tooltip: v.tooltip };
  return val;
}

/** 把一个单元格规格里的样式/批注/超链接落到 exceljs cell 上。 */
function decorateCell(cell, spec, named) {
  if (!spec || typeof spec !== "object" || spec instanceof Date) return;
  const inline = {};
  for (const k of ["bold", "italic", "underline", "strike", "size", "font", "color", "fill", "bg", "align", "valign", "wrap", "border", "borderColor", "numFmt", "format", "locked"]) if (spec[k] != null) inline[k] = spec[k];
  const st = { ...toXlsxStyle(spec.style, named), ...toXlsxStyle(inline) };
  for (const [k, v] of Object.entries(st)) cell[k] = v;
  if (spec.note || spec.comment) cell.note = String(spec.note || spec.comment);
}

function colIndex(ref) {
  // "C" → 3；数字原样
  if (Number.isFinite(+ref)) return +ref;
  let n = 0; for (const ch of String(ref).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colLetter(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/** 把一份工作表规格施加到已有 worksheet 上（修改模式）。 */
async function applySheet(ws, sh, ctx) {
  const named = ctx.named;
  if (Array.isArray(sh.columns) && sh.columns.length) {
    // 只改宽度/键，不重写表头（表头已经在文件里）；要改表头用 cells 或 rows 覆盖
    sh.columns.forEach((c, i) => { const col = ws.getColumn(i + 1); if (c.width) col.width = num(c.width, 12); if (c.key) col.key = String(c.key); if (c.style) { const st = toXlsxStyle(c.style, named); for (const [k, v] of Object.entries(st)) col[k] = v; } });
  }
  if (sh.widths && typeof sh.widths === "object") for (const [k, w] of Object.entries(sh.widths)) ws.getColumn(colIndex(k)).width = num(w, 12);
  if (sh.heights && typeof sh.heights === "object") for (const [k, h] of Object.entries(sh.heights)) ws.getRow(num(k, 1)).height = num(h, 15);
  if (Array.isArray(sh.hiddenCols)) for (const c of sh.hiddenCols) ws.getColumn(colIndex(c)).hidden = true;
  if (Array.isArray(sh.hiddenRows)) for (const r of sh.hiddenRows) ws.getRow(num(r, 1)).hidden = true;
  // rows：默认追加到末尾；startRow 指定起点则覆盖写
  if (Array.isArray(sh.rows)) {
    let r = num(sh.startRow, 0);
    for (const row of sh.rows) {
      const rowSpec = row && typeof row === "object" && !Array.isArray(row) && (row.values || row.cells) ? row : null;
      const values = rowSpec ? (rowSpec.values || rowSpec.cells) : row;
      let target;
      if (r > 0) { target = ws.getRow(r); const vals = Array.isArray(values) ? values : Object.values(values || {}); vals.forEach((v, i) => { target.getCell(i + 1).value = toCellValue(v); }); r++; }
      else { const vals = Array.isArray(values) ? values.map(toCellValue) : Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, toCellValue(v)])); target = ws.addRow(vals); }
      const cellSpecs = Array.isArray(values) ? values : Object.values(values || {});
      cellSpecs.forEach((v, i) => { if (v && typeof v === "object" && !(v instanceof Date)) decorateCell(target.getCell(i + 1), v, named); });
      if (rowSpec?.style) { const st = toXlsxStyle(rowSpec.style, named); target.eachCell({ includeEmpty: false }, (c) => { for (const [k, v] of Object.entries(st)) c[k] = v; }); }
      if (rowSpec?.height) target.height = num(rowSpec.height, 15);
      target.commit?.();
    }
  }
  if (sh.cells && typeof sh.cells === "object") {
    for (const [addr, spec] of Object.entries(sh.cells)) {
      const cell = ws.getCell(addr);
      const isSpec = spec && typeof spec === "object" && !(spec instanceof Date) && !Array.isArray(spec);
      if (!isSpec || spec.v !== undefined || spec.value !== undefined || spec.f !== undefined || spec.formula !== undefined || spec.text !== undefined || spec.rich || spec.link) cell.value = toCellValue(spec);
      decorateCell(cell, spec, named);
    }
  }
  if (sh.styleRanges && typeof sh.styleRanges === "object") {
    // { "A1:D1": style } 整块套样式
    for (const [range, style] of Object.entries(sh.styleRanges)) {
      const st = toXlsxStyle(style, named);
      const [a, b] = String(range).split(":"); const A = ws.getCell(a), B = ws.getCell(b || a);
      for (let r = A.row; r <= B.row; r++) for (let c = A.col; c <= B.col; c++) { const cell = ws.getCell(r, c); for (const [k, v] of Object.entries(st)) cell[k] = v; }
    }
  }
  if (Array.isArray(sh.merges)) for (const m of sh.merges) { try { ws.mergeCells(String(m)); } catch { /* 已合并 */ } }
  if (Array.isArray(sh.unmerge)) for (const m of sh.unmerge) { try { ws.unMergeCells(String(m)); } catch {} }
  if (sh.freeze != null) { const f = typeof sh.freeze === "object" ? sh.freeze : { rows: num(sh.freeze, 1), cols: 0 }; ws.views = [{ state: "frozen", xSplit: num(f.cols, 0), ySplit: num(f.rows, 0), topLeftCell: `${colLetter(num(f.cols, 0) + 1)}${num(f.rows, 0) + 1}` }]; }
  if (sh.autoFilter) ws.autoFilter = sh.autoFilter === true ? { from: "A1", to: `${colLetter(Math.max(1, ws.columnCount))}1` } : String(sh.autoFilter);
  if (sh.tabColor && argb(sh.tabColor)) ws.properties.tabColor = { argb: argb(sh.tabColor) };
  if (Array.isArray(sh.validations)) for (const v of sh.validations) {
    const refs = Array.isArray(v.ref) ? v.ref : [v.ref];
    const formulae = v.type === "list" && Array.isArray(v.values) ? [`"${v.values.map(String).join(",")}"`] : (Array.isArray(v.formulae) ? v.formulae.map(String) : (v.formula ? [String(v.formula)] : []));
    for (const ref of refs) ws.dataValidations.add(String(ref), { type: v.type || "list", operator: v.operator, formulae, allowBlank: v.allowBlank !== false, showErrorMessage: v.showErrorMessage !== false, errorStyle: v.errorStyle, errorTitle: v.errorTitle, error: v.error, showInputMessage: !!(v.prompt || v.promptTitle), promptTitle: v.promptTitle, prompt: v.prompt });
  }
  if (Array.isArray(sh.conditionalFormats)) for (const cf of sh.conditionalFormats) {
    const rules = (cf.rules || [cf]).map((r, i) => {
      const rule = { type: r.type || "cellIs", priority: num(r.priority, i + 1) };
      if (r.operator) rule.operator = r.operator;
      if (r.formulae) rule.formulae = r.formulae.map((x) => (typeof x === "string" ? x.replace(/^=/, "") : x));
      if (r.text) rule.text = String(r.text);
      if (r.style) rule.style = toXlsxStyle(r.style, named);
      if (r.type === "colorScale") { rule.cfvo = r.cfvo || [{ type: "min" }, { type: "max" }]; rule.color = (r.colors || ["F8696B", "63BE7B"]).map((c) => ({ argb: argb(c) })); }
      if (r.type === "dataBar") { rule.cfvo = r.cfvo || [{ type: "min" }, { type: "max" }]; rule.color = { argb: argb(r.color || "638EC6") }; rule.gradient = r.gradient !== false; }
      if (r.type === "iconSet") { rule.iconSet = r.iconSet || "3TrafficLights1"; rule.cfvo = r.cfvo || [{ type: "percent", value: 0 }, { type: "percent", value: 33 }, { type: "percent", value: 67 }]; }
      if (r.type === "top10") { rule.rank = num(r.rank, 10); rule.percent = !!r.percent; rule.bottom = !!r.bottom; }
      if (r.type === "aboveAverage") rule.aboveAverage = r.above !== false;
      if (r.type === "timePeriod") rule.timePeriod = r.timePeriod || "today";
      return rule;
    });
    ws.addConditionalFormatting({ ref: String(cf.ref), rules });
  }
  if (Array.isArray(sh.images) && ctx.readBytes) for (const im of sh.images) {
    try {
      let base64 = "", extension = "png";
      const src = String(im.src || im.path || "");
      const m = src.match(/^data:image\/([a-z]+);base64,(.+)$/i);
      if (m) { base64 = m[2]; extension = m[1] === "jpeg" ? "jpeg" : m[1]; }
      else { const bytes = await ctx.readBytes(src); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); base64 = btoa(bin); extension = /\.jpe?g$/i.test(src) ? "jpeg" : /\.gif$/i.test(src) ? "gif" : "png"; }
      const id = ctx.wb.addImage({ base64, extension });
      if (im.range) ws.addImage(id, String(im.range)); else ws.addImage(id, { tl: { col: num(im.col, 0), row: num(im.row, 0) }, ext: { width: num(im.width, 300), height: num(im.height, 200) } });
    } catch (e) { ctx.warnings.push(`图片 ${im.src || im.path}: ${String(e?.message || e)}`); }
  }
  if (sh.pageSetup && typeof sh.pageSetup === "object") ws.pageSetup = { ...ws.pageSetup, ...sh.pageSetup };
  if (sh.headerFooter && typeof sh.headerFooter === "object") ws.headerFooter = { ...ws.headerFooter, ...sh.headerFooter };
  if (sh.protect) await ws.protect(String(sh.protect.password || sh.protect === true ? "" : sh.protect), typeof sh.protect === "object" ? sh.protect : {});
}

/**
 * 修改已有工作簿：bytes（原文件）+ spec → 新 bytes。
 * spec.sheets[]：按 name 匹配已有工作表施加修改，不存在则新建；spec.ops[] 做结构操作：
 *   {op:"deleteSheet", name} / {op:"renameSheet", from, to} / {op:"insertRows", sheet, at, count}
 *   {op:"deleteRows", sheet, at, count} / {op:"clear", sheet, range} / {op:"copySheet", from, to}
 *   {op:"spliceColumns", sheet, at, count} / {op:"setActive", name} / {op:"moveSheet", name, index}
 */
export async function editXlsx(bytes, spec, ctx = {}) {
  const ExcelJS = await lib();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  const s = spec && typeof spec === "object" ? spec : {};
  const rctx = { named: s.styles || {}, readBytes: ctx.readBytes, wb, warnings: [] };
  const changed = [];
  for (const op of Array.isArray(s.ops) ? s.ops : []) {
    const kind = String(op?.op || "").toLowerCase();
    const ws = op?.sheet != null ? (wb.getWorksheet(op.sheet) || wb.getWorksheet(num(op.sheet, -1))) : null;
    if (kind === "deletesheet") { const t = wb.getWorksheet(op.name); if (t) { wb.removeWorksheet(t.id); changed.push(`删除工作表 ${op.name}`); } else rctx.warnings.push(`要删的工作表不存在：${op.name}`); }
    else if (kind === "renamesheet") { const t = wb.getWorksheet(op.from); if (t) { t.name = String(op.to); changed.push(`重命名 ${op.from} → ${op.to}`); } else rctx.warnings.push(`要重命名的工作表不存在：${op.from}`); }
    else if (kind === "insertrows" && ws) { const rows = Array.isArray(op.rows) ? op.rows.map((r) => (Array.isArray(r) ? r.map(toCellValue) : r)) : Array.from({ length: num(op.count, 1) }, () => []); ws.insertRows(num(op.at, 1), rows, op.inherit ? "i" : undefined); changed.push(`${ws.name} 第 ${op.at} 行前插入 ${rows.length} 行`); }
    else if (kind === "deleterows" && ws) { ws.spliceRows(num(op.at, 1), num(op.count, 1)); changed.push(`${ws.name} 删除第 ${op.at} 起 ${num(op.count, 1)} 行`); }
    else if (kind === "splicecolumns" && ws) { ws.spliceColumns(num(op.at, 1), num(op.count, 1)); changed.push(`${ws.name} 删除第 ${op.at} 起 ${num(op.count, 1)} 列`); }
    else if (kind === "clear" && ws) { const [a, b] = String(op.range || "A1").split(":"); const A = ws.getCell(a), B = ws.getCell(b || a); for (let r = A.row; r <= B.row; r++) for (let c = A.col; c <= B.col; c++) ws.getCell(r, c).value = null; changed.push(`${ws.name} 清空 ${op.range}`); }
    else if (kind === "copysheet") { const src = wb.getWorksheet(op.from); if (src) { const dst = wb.addWorksheet(String(op.to)); dst.model = { ...src.model, name: String(op.to), id: dst.id }; changed.push(`复制工作表 ${op.from} → ${op.to}`); } }
    else if (kind === "setactive") { const t = wb.getWorksheet(op.name); if (t) wb.views = [{ activeTab: wb.worksheets.indexOf(t) }]; }
    else if (kind === "movesheet") { const t = wb.getWorksheet(op.name); if (t) { const arr = wb.worksheets; const i = arr.indexOf(t); if (i >= 0) { arr.splice(i, 1); arr.splice(num(op.index, 0), 0, t); t.orderNo = num(op.index, 0); } } }
    else rctx.warnings.push(`不认识的 op：${op?.op}${op?.sheet != null && !ws ? `（工作表 ${op.sheet} 不存在）` : ""}`);
  }
  for (const sh of Array.isArray(s.sheets) ? s.sheets : []) {
    if (!sh || typeof sh !== "object") continue;
    let ws = sh.name != null ? wb.getWorksheet(sh.name) : (sh.index != null ? wb.worksheets[num(sh.index, 0)] : wb.worksheets[0]);
    if (!ws) { ws = wb.addWorksheet(String(sh.name || `Sheet${wb.worksheets.length + 1}`)); changed.push(`新建工作表 ${ws.name}`); if (Array.isArray(sh.columns)) ws.columns = sh.columns.map((c) => ({ header: c.header, key: c.key || c.header, width: num(c.width, 12) })); }
    else changed.push(`修改工作表 ${ws.name}`);
    await applySheet(ws, sh, rctx);
  }
  if (s.properties && typeof s.properties === "object") { if (s.properties.creator) wb.creator = String(s.properties.creator); if (s.properties.title) wb.title = String(s.properties.title); wb.modified = new Date(); }
  if (Array.isArray(s.definedNames)) for (const dn of s.definedNames) { try { wb.definedNames.add(String(dn.ref), String(dn.name)); } catch (e) { rctx.warnings.push(`定义名称 ${dn.name}: ${String(e?.message || e)}`); } }
  const out = await wb.xlsx.writeBuffer();
  return { bytes: new Uint8Array(out), summary: `${changed.join("；") || "无结构变化"}${rctx.warnings.length ? `\n⚠️ ${rctx.warnings.join("；")}` : ""}`, sheets: wb.worksheets.map((w) => w.name) };
}

/** 读已有工作簿 → 结构（每表：维度、合并、冻结、列宽、数据；公式带 f/v）。 */
export async function readXlsx(bytes, opts = {}) {
  const ExcelJS = await lib();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  const maxRows = num(opts.maxRows, 200), maxCols = num(opts.maxCols, 50);
  const only = opts.sheet != null ? String(opts.sheet) : null;
  const sheets = [];
  for (const ws of wb.worksheets) {
    if (only && ws.name !== only && String(wb.worksheets.indexOf(ws) + 1) !== only) continue;
    const dims = { rows: ws.rowCount, cols: ws.columnCount };
    let r0 = 1, r1 = ws.rowCount, c0 = 1, c1 = ws.columnCount;
    if (opts.range) { const [a, b] = String(opts.range).split(":"); const A = ws.getCell(a), B = ws.getCell(b || a); r0 = A.row; r1 = B.row; c0 = A.col; c1 = B.col; }
    const rEnd = Math.min(r1, r0 + maxRows - 1), cEnd = Math.min(c1, c0 + maxCols - 1);
    const data = [];
    for (let r = r0; r <= rEnd; r++) {
      const row = ws.getRow(r); const arr = [];
      let any = false;
      for (let c = c0; c <= cEnd; c++) {
        const cell = row.getCell(c);
        let v = cell.value;
        if (v && typeof v === "object" && !(v instanceof Date)) {
          if (v.formula != null || v.sharedFormula != null) v = { f: v.formula || v.sharedFormula, v: v.result ?? null };
          else if (v.richText) v = v.richText.map((x) => x.text).join("");
          else if (v.hyperlink) v = { text: v.text, link: v.hyperlink };
          else if (v.error) v = { error: v.error };
        }
        if (v instanceof Date) v = v.toISOString();
        if (opts.styles && cell.style && Object.keys(cell.style).length) v = { v, numFmt: cell.numFmt, bold: cell.font?.bold || undefined, fill: cell.fill?.fgColor?.argb };
        arr.push(v ?? null); if (v != null) any = true;
      }
      if (any || opts.keepEmpty) data.push(arr);
    }
    // exceljs 把合并存成 {左上角地址: Range}；Range 上有 tl/br，拼回 "A7:D7"
    const merges = Object.values(ws._merges || {}).map((m) => (m && m.tl && m.br ? `${m.tl}:${m.br}` : (m?.shortRange || m?.range || ""))).filter(Boolean);
    const widths = {}; ws.columns.forEach((col, i) => { if (col && col.width) widths[colLetter(i + 1)] = col.width; });
    const views = Array.isArray(ws.views) ? ws.views[0] : null;
    sheets.push({ name: ws.name, dims, from: `${colLetter(c0)}${r0}`, merges: merges.slice(0, 200), widths, freeze: views?.state === "frozen" ? { rows: views.ySplit || 0, cols: views.xSplit || 0 } : null, autoFilter: ws.autoFilter || null, data, truncated: rEnd < r1 || cEnd < c1, tables: Object.keys(ws.tables || {}), images: (ws.getImages?.() || []).length, conditionalFormats: (ws.conditionalFormattings || []).reduce((n, cf) => n + (Array.isArray(cf?.rules) ? cf.rules.length : 1), 0), validations: new Set(Object.values(ws.dataValidations?.model || {}).map((v) => JSON.stringify(v))).size });
  }
  return { format: "xlsx", sheetNames: wb.worksheets.map((w) => w.name), sheets, definedNames: (() => { try { return wb.definedNames.model.filter((d) => !/^_xlnm\./.test(String(d.name || ""))).map((d) => `${d.name}=${d.ranges?.join(",")}`).slice(0, 50); } catch { return []; } })(), properties: { creator: wb.creator, title: wb.title, modified: wb.modified } };
}
