// Word 文档：按 JSON 规格生成 .docx（docx 库，懒加载），以及把已有 .docx 读成结构（mammoth）。
//
// 规格覆盖 docx 库的全部主要能力：页面（纸张/方向/页边距/分栏）、默认字体、页眉页脚（含页码域）、
// 标题、段落（富文本 run：粗斜下划线删除线颜色字号字体高亮上下标换行超链接脚注）、对齐/间距/缩进、
// 多级项目符号与编号列表、表格（合并/底纹/边框/列宽/表头重复/对齐）、图片（base64 / 工作区路径）、
// 分页、分节、目录域、水平线、书签与内部链接。文档级 help 见 office-tool.js。
//
// 只做「新建」：docx 库不解析已有文档。改已有 Word 的路是 office_read 读出结构 → 模型重写规格 → 新建。

let _docx = null;
async function lib() {
  if (!_docx) _docx = await import("docx");
  return _docx;
}

// ── 小工具 ──
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const hex = (c) => {
  const s = String(c || "").trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : (/^[0-9a-fA-F]{3}$/.test(s) ? s.split("").map((x) => x + x).join("").toUpperCase() : null);
};
const ALIGN = { left: "left", center: "center", right: "right", justify: "both", both: "both", start: "start", end: "end" };
const PAGE_SIZES = { // 缇（twips，1/20 pt）：docx 库的 page.size 用 twips
  A4: { width: 11906, height: 16838 }, A3: { width: 16838, height: 23811 }, A5: { width: 8391, height: 11906 },
  Letter: { width: 12240, height: 15840 }, Legal: { width: 12240, height: 20160 }, B5: { width: 9979, height: 14175 },
};
const MARGIN_PRESETS = { normal: 1440, narrow: 720, moderate: 1080, wide: 2160 }; // twips（1 英寸 = 1440）
const HIGHLIGHTS = new Set(["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white"]);

/** 把规格里的一段文字（字符串 / run 对象 / run 数组）变成 TextRun 列表。 */
function runsOf(d, input, ctx) {
  const items = Array.isArray(input) ? input : [input];
  const out = [];
  for (const it of items) {
    if (it == null) continue;
    if (typeof it !== "object") { out.push(new d.TextRun({ text: String(it) })); continue; }
    const o = {};
    if (it.bold != null) o.bold = !!it.bold;
    if (it.italic != null) o.italics = !!it.italic;
    if (it.underline) o.underline = typeof it.underline === "object" ? it.underline : { type: it.underline === true ? "single" : String(it.underline) };
    if (it.strike) o.strike = true;
    if (it.doubleStrike) o.doubleStrike = true;
    if (it.color && hex(it.color)) o.color = hex(it.color);
    if (it.size) o.size = num(it.size, 0) * 2; // 规格用 pt，docx 用半磅
    if (it.font) o.font = String(it.font);
    if (it.highlight && HIGHLIGHTS.has(it.highlight)) o.highlight = it.highlight;
    if (it.shading && hex(it.shading)) o.shading = { type: d.ShadingType.CLEAR, fill: hex(it.shading), color: "auto" };
    if (it.superscript) o.superScript = true;
    if (it.subscript) o.subScript = true;
    if (it.smallCaps) o.smallCaps = true;
    if (it.allCaps) o.allCaps = true;
    if (it.characterSpacing != null) o.characterSpacing = num(it.characterSpacing, 0);
    if (it.style) o.style = String(it.style);
    if (it.break) o.break = num(it.break, 1);
    const text = it.text != null ? String(it.text) : "";
    if (it.link) {
      // 外链 ExternalHyperlink；内部链接（#书签）InternalHyperlink
      const child = new d.TextRun({ text, style: "Hyperlink", ...o });
      const target = String(it.link);
      out.push(target.startsWith("#") ? new d.InternalHyperlink({ children: [child], anchor: target.slice(1) }) : new d.ExternalHyperlink({ children: [child], link: target }));
      continue;
    }
    if (it.footnote != null) {
      const id = ctx.footnotes.length + 1;
      ctx.footnotes.push({ id, children: [new d.Paragraph({ children: runsOf(d, it.footnote, ctx) })] });
      if (text) out.push(new d.TextRun({ text, ...o }));
      out.push(new d.FootnoteReferenceRun(id));
      continue;
    }
    if (it.tab) { out.push(new d.TextRun({ children: [new d.Tab(), text], ...o })); continue; }
    if (it.pageNumber) { out.push(new d.TextRun({ children: [d.PageNumber.CURRENT], ...o })); continue; }
    if (it.totalPages) { out.push(new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], ...o })); continue; }
    if (it.bookmark) { out.push(new d.Bookmark({ id: String(it.bookmark), children: [new d.TextRun({ text, ...o })] })); continue; }
    out.push(new d.TextRun({ text, ...o }));
  }
  return out;
}

/** 段落级属性（对齐 / 间距 / 缩进 / 边框 / 底纹 / 保持同页 / 段前分页 / 样式）。 */
function paragraphOpts(d, b) {
  const o = {};
  if (b.align && ALIGN[b.align]) o.alignment = ALIGN[b.align];
  if (b.spacing && typeof b.spacing === "object") {
    const sp = {};
    if (b.spacing.before != null) sp.before = num(b.spacing.before, 0);
    if (b.spacing.after != null) sp.after = num(b.spacing.after, 0);
    if (b.spacing.line != null) sp.line = num(b.spacing.line, 240); // 240 = 单倍
    if (b.spacing.lineRule) sp.lineRule = b.spacing.lineRule;
    o.spacing = sp;
  }
  if (b.indent && typeof b.indent === "object") o.indent = { left: b.indent.left, right: b.indent.right, firstLine: b.indent.firstLine, hanging: b.indent.hanging };
  if (b.style) o.style = String(b.style);
  if (b.keepNext) o.keepNext = true;
  if (b.keepLines) o.keepLines = true;
  if (b.pageBreakBefore) o.pageBreakBefore = true;
  if (b.shading && hex(b.shading)) o.shading = { type: d.ShadingType.CLEAR, fill: hex(b.shading), color: "auto" };
  if (b.border) {
    const side = (s) => ({ style: d.BorderStyle.SINGLE, size: num(s?.size, 6), color: hex(s?.color) || "000000", space: num(s?.space, 1) });
    const all = b.border === true || typeof b.border === "string";
    o.border = all
      ? { top: side({}), bottom: side({}), left: side({}), right: side({}) }
      : Object.fromEntries(["top", "bottom", "left", "right"].filter((k) => b.border[k]).map((k) => [k, side(b.border[k] === true ? {} : b.border[k])]));
  }
  if (b.tabStops) o.tabStops = b.tabStops.map((t) => ({ type: t.type || d.TabStopType.LEFT, position: num(t.position, 0) }));
  return o;
}

/** 表格单元格 → TableCell。cell 可以是字符串、run 数组、或 { text|runs|content, colspan, rowspan, shading, align, valign, width, bold... } */
function tableCell(d, cell, ctx, defaults) {
  const c = cell && typeof cell === "object" && !Array.isArray(cell) ? cell : { text: cell };
  const children = c.content ? blocks(d, c.content, ctx) : [new d.Paragraph({ children: runsOf(d, c.runs || (c.text != null ? { text: String(c.text), bold: c.bold, italic: c.italic, color: c.color, size: c.size } : []), ctx), ...paragraphOpts(d, { align: c.align || defaults.align }) })];
  const o = { children };
  if (c.colspan > 1) o.columnSpan = num(c.colspan, 1);
  if (c.rowspan > 1) o.rowSpan = num(c.rowspan, 1);
  if (c.shading && hex(c.shading)) o.shading = { type: d.ShadingType.CLEAR, fill: hex(c.shading), color: "auto" };
  if (c.valign) o.verticalAlign = { top: d.VerticalAlign.TOP, middle: d.VerticalAlign.CENTER, center: d.VerticalAlign.CENTER, bottom: d.VerticalAlign.BOTTOM }[c.valign] || d.VerticalAlign.TOP;
  if (c.width != null) o.width = { size: num(c.width, 0), type: defaults.widthType };
  if (c.margins) o.margins = c.margins;
  return new d.TableCell(o);
}

function table(d, b, ctx) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const widthType = b.widthType === "dxa" ? d.WidthType.DXA : d.WidthType.PERCENTAGE;
  const headerRows = num(b.headerRows, b.header ? 1 : 0);
  const borderSide = (s) => ({ style: d.BorderStyle.SINGLE, size: num(s?.size, 4), color: hex(s?.color) || (b.borderColor && hex(b.borderColor)) || "BFBFBF" });
  let borders;
  if (b.borders === "none") borders = Object.fromEntries(["top", "bottom", "left", "right", "insideHorizontal", "insideVertical"].map((k) => [k, { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" }]));
  else if (b.borders === "outer") borders = { top: borderSide(), bottom: borderSide(), left: borderSide(), right: borderSide(), insideHorizontal: { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" }, insideVertical: { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" } };
  else if (b.borders === "horizontal") borders = { top: borderSide(), bottom: borderSide(), left: { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" }, insideHorizontal: borderSide(), insideVertical: { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" } };
  else if (b.borders && typeof b.borders === "object") borders = Object.fromEntries(Object.entries(b.borders).map(([k, v]) => [k, v === false ? { style: d.BorderStyle.NONE, size: 0, color: "FFFFFF" } : borderSide(v)]));
  else borders = Object.fromEntries(["top", "bottom", "left", "right", "insideHorizontal", "insideVertical"].map((k) => [k, borderSide()]));
  const tableRows = rows.map((r, ri) => {
    const cells = Array.isArray(r) ? r : (Array.isArray(r?.cells) ? r.cells : []);
    const isHeader = ri < headerRows;
    const cellDefaults = { widthType, align: b.align };
    return new d.TableRow({
      tableHeader: isHeader,
      cantSplit: !!b.cantSplit,
      height: r && !Array.isArray(r) && r.height ? { value: num(r.height, 0), rule: d.HeightRule.ATLEAST } : undefined,
      children: cells.map((c, ci) => {
        const cellObj = c && typeof c === "object" && !Array.isArray(c) ? { ...c } : { text: c };
        if (isHeader && cellObj.bold == null) cellObj.bold = true;
        if (isHeader && cellObj.shading == null && b.headerShading) cellObj.shading = b.headerShading;
        if (cellObj.width == null && Array.isArray(b.widths) && b.widths[ci] != null) cellObj.width = b.widths[ci];
        return tableCell(d, cellObj, ctx, cellDefaults);
      }),
    });
  });
  const o = { rows: tableRows, borders };
  if (Array.isArray(b.widths) && b.widths.length) o.columnWidths = widthType === d.WidthType.DXA ? b.widths.map((w) => num(w, 0)) : undefined;
  if (b.width != null) o.width = { size: num(b.width, 100), type: widthType }; else o.width = { size: 100, type: d.WidthType.PERCENTAGE };
  if (b.tableAlign) o.alignment = ALIGN[b.tableAlign] || "center";
  if (b.style) o.style = String(b.style);
  if (b.layout === "fixed") o.layout = d.TableLayoutType.FIXED;
  return new d.Table(o);
}

/** 图片来源：data URL / 裸 base64 / 工作区路径（由 ctx.readBytes 取字节）。返回 { data, type } */
async function imageBytes(src, ctx) {
  const s = String(src || "");
  const m = s.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
  if (m) return { data: b64ToBytes(m[2]), type: m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase() };
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(s)) return { data: b64ToBytes(s), type: sniff(b64ToBytes(s.slice(0, 64))) };
  if (!ctx.readBytes) throw new Error(`图片 ${s} 需要从工作区读取，但当前环境没有文件读取通道`);
  const data = await ctx.readBytes(s);
  return { data, type: sniff(data) };
}
function b64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sniff(bytes) {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return "png";
}

/** 内容块 → docx 元素数组（Paragraph / Table）。 */
function blocks(d, list, ctx) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    if (raw == null) continue;
    const b = typeof raw === "string" ? { type: "paragraph", text: raw } : raw;
    const type = String(b.type || (b.level ? "heading" : "paragraph")).toLowerCase();
    switch (type) {
      case "heading": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "title": {
        const lvl = type === "title" ? "TITLE" : `HEADING_${Math.min(6, Math.max(1, num(b.level, +type.slice(1) || 1)))}`;
        out.push(new d.Paragraph({ heading: d.HeadingLevel[lvl], children: runsOf(d, b.runs || b.text || "", ctx), ...paragraphOpts(d, b) }));
        break;
      }
      case "paragraph": case "p": case "text":
        out.push(new d.Paragraph({ children: runsOf(d, b.runs || b.text || "", ctx), ...paragraphOpts(d, b) }));
        break;
      case "quote":
        out.push(new d.Paragraph({ children: runsOf(d, b.runs || b.text || "", ctx), ...paragraphOpts(d, { ...b, indent: b.indent || { left: 720 }, border: b.border || { left: { size: 18, color: "BFBFBF" } } }) }));
        break;
      case "code": {
        const lines = String(b.text || "").split("\n");
        lines.forEach((ln, i) => out.push(new d.Paragraph({ children: [new d.TextRun({ text: ln, font: b.font || "Consolas", size: num(b.size, 10) * 2 })], shading: { type: d.ShadingType.CLEAR, fill: hex(b.shading) || "F5F5F5", color: "auto" }, spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0 } })));
        break;
      }
      case "list": case "bullets": case "numbered": {
        const numbered = type === "numbered" || /^(number|decimal|ordered|roman|letter)/i.test(String(b.style || ""));
        const ref = numbered ? ctx.numberingRef(b.style) : "bullets";
        const walk = (items, level) => {
          for (const it of Array.isArray(items) ? items : []) {
            const item = typeof it === "object" && it && !Array.isArray(it) ? it : { text: it };
            out.push(new d.Paragraph({ children: runsOf(d, item.runs || item.text || "", ctx), numbering: { reference: ref, level: Math.min(8, level) }, ...paragraphOpts(d, item) }));
            if (item.items) walk(item.items, level + 1);
          }
        };
        walk(b.items, num(b.level, 0));
        break;
      }
      case "table": out.push(table(d, b, ctx)); if (b.spaceAfter !== false) out.push(new d.Paragraph({ text: "" })); break;
      case "image": case "img": {
        const img = ctx.images.get(b);
        if (!img) { out.push(new d.Paragraph({ children: [new d.TextRun({ text: `[图片缺失: ${b.src || ""}]`, color: "C00000" })] })); break; }
        const w = num(b.width, 400), h = num(b.height, Math.round(w * (img.ratio || 0.75)));
        const run = new d.ImageRun({ type: img.type, data: img.data, transformation: { width: w, height: h }, altText: b.alt ? { title: String(b.alt), description: String(b.alt), name: String(b.alt) } : undefined });
        out.push(new d.Paragraph({ children: [run], ...paragraphOpts(d, { align: b.align || "center", spacing: b.spacing }) }));
        if (b.caption) out.push(new d.Paragraph({ children: [new d.TextRun({ text: String(b.caption), italics: true, size: 18, color: "666666" })], alignment: "center", spacing: { after: 160 } }));
        break;
      }
      case "pagebreak": case "page-break": out.push(new d.Paragraph({ children: [new d.PageBreak()] })); break;
      case "hr": case "rule": out.push(new d.Paragraph({ children: [], border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: hex(b.color) || "BFBFBF", space: 1 } }, spacing: { before: 120, after: 120 } })); break;
      case "toc":
        if (b.title) out.push(new d.Paragraph({ children: [new d.TextRun({ text: String(b.title), bold: true, size: 32 })], spacing: { after: 200 } }));
        out.push(new d.TableOfContents(String(b.title || "目录"), { hyperlink: true, headingStyleRange: String(b.levels || "1-3") }));
        ctx.hasToc = true;
        break;
      case "bookmark": out.push(new d.Paragraph({ children: [new d.Bookmark({ id: String(b.id || b.name || "bm"), children: runsOf(d, b.text || "", ctx) })], ...paragraphOpts(d, b) })); break;
      case "columns": // 多栏只作用于分节：交给上层 section 处理；这里把内容平铺
        out.push(...blocks(d, b.content || [], ctx)); break;
      default:
        out.push(new d.Paragraph({ children: runsOf(d, b.runs || b.text || JSON.stringify(b), ctx), ...paragraphOpts(d, b) }));
    }
  }
  return out;
}

function sectionProps(d, page = {}) {
  const size = typeof page.size === "object" && page.size ? { width: num(page.size.width, 11906), height: num(page.size.height, 16838) } : (PAGE_SIZES[page.size] || PAGE_SIZES.A4);
  const landscape = String(page.orientation || "").toLowerCase() === "landscape";
  const m = typeof page.margins === "string" ? MARGIN_PRESETS[page.margins] ?? 1440 : null;
  const margins = typeof page.margins === "object" && page.margins
    ? { top: num(page.margins.top, 1440), right: num(page.margins.right, 1440), bottom: num(page.margins.bottom, 1440), left: num(page.margins.left, 1440), header: num(page.margins.header, 708), footer: num(page.margins.footer, 708) }
    : { top: m ?? 1440, right: m ?? 1440, bottom: m ?? 1440, left: m ?? 1440, header: 708, footer: 708 };
  const props = {
    page: {
      size: { width: landscape ? size.height : size.width, height: landscape ? size.width : size.height, orientation: landscape ? d.PageOrientation.LANDSCAPE : d.PageOrientation.PORTRAIT },
      margin: margins,
      ...(page.pageNumberStart ? { pageNumbers: { start: num(page.pageNumberStart, 1) } } : {}),
    },
  };
  if (page.columns && num(page.columns, 1) > 1) props.column = { count: num(page.columns, 2), space: num(page.columnSpace, 708), equalWidth: true };
  if (page.titlePage) props.titlePage = true;
  return props;
}

/** 页眉/页脚：字符串、run 数组或内容块；支持 {PAGE} / {NUMPAGES} 占位。 */
function headerFooter(d, spec, ctx, Ctor) {
  if (spec == null) return undefined;
  const s = typeof spec === "string" ? { text: spec } : spec;
  let children;
  if (s.content) children = blocks(d, s.content, ctx);
  else {
    const text = String(s.text ?? "");
    const parts = text.split(/(\{PAGE\}|\{NUMPAGES\})/);
    const runs = parts.filter(Boolean).map((p) => p === "{PAGE}" ? new d.TextRun({ children: [d.PageNumber.CURRENT], size: num(s.size, 9) * 2, color: hex(s.color) || "666666" }) : p === "{NUMPAGES}" ? new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: num(s.size, 9) * 2, color: hex(s.color) || "666666" }) : new d.TextRun({ text: p, size: num(s.size, 9) * 2, color: hex(s.color) || "666666", bold: !!s.bold }));
    children = [new d.Paragraph({ children: runs, alignment: ALIGN[s.align] || "center", border: s.rule ? { [Ctor === d.Header ? "bottom" : "top"]: { style: d.BorderStyle.SINGLE, size: 4, color: "BFBFBF", space: 4 } } : undefined })];
  }
  return new Ctor({ children });
}

/**
 * 规格 → .docx 字节。ctx.readBytes(path) 用来取工作区里的图片。
 * 返回 { bytes: Uint8Array, summary: string }
 */
export async function renderDocx(spec, ctx = {}) {
  const d = await lib();
  const s = spec && typeof spec === "object" ? spec : {};
  const rctx = { footnotes: [], images: new Map(), hasToc: false, readBytes: ctx.readBytes, numberingRef: (style) => `numbers-${String(style || "decimal").replace(/[^a-z]/gi, "").toLowerCase() || "decimal"}` };
  // 图片先取好（异步），块渲染是同步的
  const collect = (list) => { for (const b of Array.isArray(list) ? list : []) { if (b && typeof b === "object") { if (/^(image|img)$/i.test(String(b.type || ""))) rctx.pendingImages.push(b); if (b.content) collect(b.content); if (b.rows) for (const r of b.rows) for (const c of Array.isArray(r) ? r : (r?.cells || [])) if (c && c.content) collect(c.content); } } };
  rctx.pendingImages = [];
  const sections = Array.isArray(s.sections) && s.sections.length ? s.sections : [{ page: s.page, header: s.header, footer: s.footer, content: s.content || s.blocks || s.body || [] }];
  for (const sec of sections) { collect(sec.content); collect(sec.header?.content); collect(sec.footer?.content); }
  for (const b of rctx.pendingImages) {
    try { const img = await imageBytes(b.src || b.data || b.path, rctx); rctx.images.set(b, img); }
    catch (e) { rctx.images.set(b, null); rctx.imageErrors = (rctx.imageErrors || []).concat(`${b.src || b.path}: ${String(e?.message || e)}`); }
  }
  // 编号定义：项目符号 + 各种数字样式，多级
  const fmt = { decimal: d.LevelFormat.DECIMAL, roman: d.LevelFormat.LOWER_ROMAN, upperroman: d.LevelFormat.UPPER_ROMAN, letter: d.LevelFormat.LOWER_LETTER, upperletter: d.LevelFormat.UPPER_LETTER, chinese: d.LevelFormat.CHINESE_COUNTING, number: d.LevelFormat.DECIMAL, ordered: d.LevelFormat.DECIMAL };
  const levels = (format, textFn) => Array.from({ length: 9 }, (_, i) => ({ level: i, format, text: textFn(i), alignment: d.AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }));
  const bulletsGlyph = ["•", "◦", "▪", "•", "◦", "▪", "•", "◦", "▪"];
  const numbering = { config: [
    { reference: "bullets", levels: levels(d.LevelFormat.BULLET, (i) => bulletsGlyph[i]) },
    ...Object.entries(fmt).map(([k, f]) => ({ reference: `numbers-${k}`, levels: levels(f, (i) => `%${i + 1}.`) })),
  ] };
  const defaultFont = s.font || s.styles?.default?.font || "Microsoft YaHei";
  const defaultSize = num(s.fontSize || s.styles?.default?.size, 11) * 2;
  const paragraphStyles = [];
  const headingSizes = { Heading1: 32, Heading2: 26, Heading3: 22, Heading4: 20, Heading5: 18, Heading6: 16 };
  for (const [id, sz] of Object.entries(headingSizes)) {
    const custom = s.styles?.paragraph?.[id] || s.styles?.[id] || {};
    paragraphStyles.push({ id, name: id.replace(/(\d)/, " $1"), basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: num(custom.size, sz / 2) * 2, bold: custom.bold !== false, color: hex(custom.color) || (id === "Heading1" ? "1F1F1F" : "2F2F2F"), font: custom.font || defaultFont }, paragraph: { spacing: { before: num(custom.before, id === "Heading1" ? 360 : 240), after: num(custom.after, 120) }, outlineLevel: +id.slice(-1) - 1 } });
  }
  for (const [id, st] of Object.entries(s.styles?.paragraph || {})) {
    if (headingSizes[id]) continue;
    paragraphStyles.push({ id, name: id, basedOn: "Normal", quickFormat: true, run: { size: st.size ? num(st.size, 11) * 2 : undefined, bold: st.bold, italics: st.italic, color: hex(st.color) || undefined, font: st.font }, paragraph: { alignment: ALIGN[st.align], spacing: st.spacing, indent: st.indent } });
  }
  // 先把各节内容渲染出来（脚注 / 目录标记在这一步收集），再一次性构造 Document。
  const rendered = sections.map((sec) => ({
    properties: sectionProps(d, sec.page || {}),
    headers: sec.header != null ? { default: headerFooter(d, sec.header, rctx, d.Header), ...(sec.firstHeader != null ? { first: headerFooter(d, sec.firstHeader, rctx, d.Header) } : {}) } : undefined,
    footers: sec.footer != null ? { default: headerFooter(d, sec.footer, rctx, d.Footer), ...(sec.firstFooter != null ? { first: headerFooter(d, sec.firstFooter, rctx, d.Footer) } : {}) } : undefined,
    children: blocks(d, sec.content || sec.blocks || sec.body || [], rctx),
  }));
  const doc = new d.Document({
    creator: s.author || s.properties?.creator || "Mr. Day One",
    title: s.title || s.properties?.title,
    description: s.properties?.description,
    subject: s.properties?.subject,
    keywords: s.properties?.keywords,
    styles: { default: { document: { run: { font: defaultFont, size: defaultSize, color: hex(s.color) || "262626" }, paragraph: { spacing: { line: num(s.lineSpacing, 276), after: num(s.paragraphSpacing, 120) } } } }, paragraphStyles },
    numbering,
    footnotes: Object.fromEntries(rctx.footnotes.map((f) => [f.id, { children: f.children }])),
    features: rctx.hasToc ? { updateFields: true } : undefined,
    sections: rendered,
  });
  // toBase64String 在浏览器和 Node 里都可用（toBuffer 依赖 Node 的 Buffer）。
  const bytes = b64ToBytes(await d.Packer.toBase64String(doc));
  const counts = { sections: sections.length, blocks: sections.reduce((n, sec) => n + (Array.isArray(sec.content || sec.blocks || sec.body) ? (sec.content || sec.blocks || sec.body).length : 0), 0), images: rctx.images.size, footnotes: rctx.footnotes.length };
  const summary = `${counts.sections} 节 · ${counts.blocks} 个内容块${counts.images ? ` · ${counts.images} 张图` : ""}${counts.footnotes ? ` · ${counts.footnotes} 条脚注` : ""}${rctx.hasToc ? " · 含目录（打开后按 F9 更新域）" : ""}${rctx.imageErrors ? `\n⚠️ 图片未能载入：${rctx.imageErrors.join("；")}` : ""}`;
  return { bytes, summary };
}

/** 已有 .docx → { text, html, headings, tables, warnings }（mammoth）。 */
export async function readDocx(bytes, opts = {}) {
  const mammoth = (await import("mammoth")).default || (await import("mammoth"));
  // Node 版 mammoth 认 buffer（JSZip 直接吃 Uint8Array），浏览器版认 arrayBuffer——两个键都给，谁认谁用。
  const input = { buffer: bytes, arrayBuffer: bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes };
  const html = await mammoth.convertToHtml(input, { styleMap: ["p[style-name='Title'] => h1.title", "p[style-name='Quote'] => blockquote"] });
  const raw = await mammoth.extractRawText(input);
  const h = String(html.value || "");
  const headings = [...h.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], text: m[2].replace(/<[^>]+>/g, "").trim() }));
  const tables = [...h.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((m) => [...m[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim())));
  const maxChars = num(opts.maxChars, 60000);
  const text = String(raw.value || "");
  return {
    format: "docx",
    text: text.length > maxChars ? text.slice(0, maxChars) + `\n…（已截断，共 ${text.length} 字）` : text,
    html: h.length > maxChars ? h.slice(0, maxChars) + "\n<!-- 已截断 -->" : h,
    headings, tables,
    stats: { chars: text.length, paragraphs: (h.match(/<p[ >]/g) || []).length, tables: tables.length, images: (h.match(/<img /g) || []).length },
    warnings: (html.messages || []).map((m) => m.message).slice(0, 10),
  };
}
