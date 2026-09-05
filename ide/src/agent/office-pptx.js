// PowerPoint：按 JSON 规格生成 .pptx（pptxgenjs，懒加载），以及把已有 .pptx 读成每页文字 + 备注（jszip）。
//
// 规格覆盖 pptxgenjs 的主要能力：版式（16:9 / 16:10 / 4:3 / 自定义）、文档属性、默认字体与配色、
// 母版（背景 / 页脚 / 页码）、每页：背景（色/图）、备注、快捷字段（title / subtitle / bullets）
// 以及任意元素：文本框（富文本 run、项目符号、多级、对齐、填充、边框、阴影、超链接）、图片、形状
// （矩形/圆角/椭圆/线/三角/箭头等，带文字）、表格（列宽/表头/合并/边框/底纹）、图表
// （柱/条/折线/饼/环/面积/散点/雷达，多系列，标题/图例/数据标签/坐标轴）。
// 只做「新建」：pptxgenjs 不解析已有文件；改已有 PPT 的路是 office_read 读出每页文字 → 重写规格。

let _pptx = null;
async function lib() {
  if (!_pptx) { const m = await import("pptxgenjs"); _pptx = m.default || m; }
  return _pptx;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const hex = (c) => { const s = String(c || "").trim().replace(/^#/, ""); return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null; };
/** 坐标/尺寸：数字按英寸，"50%" 这种百分比字符串原样交给 pptxgenjs。 */
const dim = (v, d) => (typeof v === "string" && /%$/.test(v.trim()) ? v.trim() : num(v, d));
const LAYOUTS = { "16x9": "LAYOUT_16x9", "16:9": "LAYOUT_16x9", wide: "LAYOUT_WIDE", "16x10": "LAYOUT_16x10", "16:10": "LAYOUT_16x10", "4x3": "LAYOUT_4x3", "4:3": "LAYOUT_4x3" };
const SHAPES = { rect: "rect", rectangle: "rect", roundrect: "roundRect", roundedrect: "roundRect", ellipse: "ellipse", circle: "ellipse", oval: "ellipse", line: "line", triangle: "triangle", rtTriangle: "rtTriangle", diamond: "diamond", pentagon: "pentagon", hexagon: "hexagon", octagon: "octagon", star5: "star5", star: "star5", rightarrow: "rightArrow", leftarrow: "leftArrow", uparrow: "upArrow", downarrow: "downArrow", chevron: "chevron", cloud: "cloud", heart: "heart", parallelogram: "parallelogram", trapezoid: "trapezoid", callout: "wedgeRectCallout", rounded: "roundRect" };
const CHARTS = { bar: "bar", column: "bar", hbar: "bar", line: "line", pie: "pie", doughnut: "doughnut", donut: "doughnut", area: "area", scatter: "scatter", radar: "radar", bubble: "bubble" };

/** 文本框 / 文字属性（规格字段名 → pptxgenjs 选项）。 */
function textOpts(e, defaults) {
  const o = {};
  o.x = dim(e.x, 0.5); o.y = dim(e.y, 0.5); o.w = dim(e.w, "90%"); o.h = dim(e.h, 1);
  o.fontFace = e.fontFace || e.font || defaults.fontFace;
  o.fontSize = num(e.fontSize || e.size, defaults.fontSize);
  if (e.bold != null) o.bold = !!e.bold;
  if (e.italic != null) o.italic = !!e.italic;
  if (e.underline) o.underline = { style: "sng" };
  if (e.strike) o.strike = "sngStrike";
  o.color = hex(e.color) || defaults.color;
  if (e.align) o.align = e.align;
  if (e.valign) o.valign = e.valign;
  if (e.fill) o.fill = { color: hex(typeof e.fill === "string" ? e.fill : e.fill.color) || "FFFFFF", transparency: num(e.fill?.transparency, 0) };
  if (e.line) o.line = { color: hex(typeof e.line === "string" ? e.line : e.line.color) || "999999", width: num(e.line?.width, 1), dashType: e.line?.dash || "solid" };
  if (e.shadow) o.shadow = typeof e.shadow === "object" ? e.shadow : { type: "outer", blur: 3, offset: 2, angle: 45, color: "000000", opacity: 0.3 };
  if (e.margin != null) o.margin = e.margin;
  if (e.lineSpacing) o.lineSpacing = num(e.lineSpacing, 0);
  if (e.paraSpaceBefore != null) o.paraSpaceBefore = num(e.paraSpaceBefore, 0);
  if (e.paraSpaceAfter != null) o.paraSpaceAfter = num(e.paraSpaceAfter, 0);
  if (e.charSpacing != null) o.charSpacing = num(e.charSpacing, 0);
  if (e.rotate != null) o.rotate = num(e.rotate, 0);
  if (e.autoFit) o.autoFit = true;
  if (e.fit) o.fit = e.fit; // "shrink" | "resize"
  if (e.wrap === false) o.wrap = false;
  if (e.rectRadius != null) o.rectRadius = num(e.rectRadius, 0);
  if (e.bullet) o.bullet = e.bullet === true ? true : (typeof e.bullet === "object" ? e.bullet : { type: String(e.bullet) === "number" ? "number" : undefined, code: typeof e.bullet === "string" && e.bullet !== "number" ? e.bullet : undefined });
  if (e.indentLevel != null) o.indentLevel = num(e.indentLevel, 0);
  if (e.link) o.hyperlink = /^\d+$/.test(String(e.link)) ? { slide: +e.link } : { url: String(e.link) };
  if (e.vert) o.vert = e.vert;
  if (e.transparency != null) o.transparency = num(e.transparency, 0);
  return o;
}

/** 文本内容：字符串 / run 数组 / 项目符号列表 → pptxgenjs 的 text 参数（字符串或 [{text, options}]）。 */
function textContent(e, defaults) {
  const items = e.runs || e.paragraphs || e.items || e.lines;
  if (Array.isArray(items)) {
    return items.map((it, i) => {
      const r = typeof it === "object" && it && !Array.isArray(it) ? it : { text: it };
      const opts = {};
      if (r.bold != null) opts.bold = !!r.bold; if (r.italic != null) opts.italic = !!r.italic;
      if (r.underline) opts.underline = { style: "sng" }; if (r.strike) opts.strike = "sngStrike";
      if (r.color) opts.color = hex(r.color) || undefined; if (r.size || r.fontSize) opts.fontSize = num(r.size || r.fontSize, defaults.fontSize);
      if (r.font || r.fontFace) opts.fontFace = r.font || r.fontFace;
      if (r.highlight) opts.highlight = hex(r.highlight) || "FFFF00";
      if (r.link) opts.hyperlink = /^\d+$/.test(String(r.link)) ? { slide: +r.link } : { url: String(r.link) };
      if (r.superscript) opts.superscript = true; if (r.subscript) opts.subscript = true;
      // 项目符号：列表元素默认带；显式 bullet:false 取消；level 控制缩进层级
      const listMode = Array.isArray(e.items) || Array.isArray(e.lines) || e.bullet;
      if (r.bullet != null) opts.bullet = r.bullet === true ? true : (r.bullet === false ? false : (typeof r.bullet === "object" ? r.bullet : { type: r.bullet === "number" ? "number" : undefined, code: r.bullet !== "number" ? r.bullet : undefined }));
      else if (listMode && !e.runs) opts.bullet = e.bullet && typeof e.bullet === "object" ? e.bullet : (e.bullet === "number" ? { type: "number" } : true);
      if (r.level != null) opts.indentLevel = num(r.level, 0);
      if (r.align) opts.align = r.align;
      // run 数组默认同一段；lines/items 每条一段（breakLine）
      if (!e.runs || r.breakLine || r.break) opts.breakLine = i < items.length - 1 || !!r.break;
      if (r.paraSpaceBefore != null) opts.paraSpaceBefore = num(r.paraSpaceBefore, 0);
      if (r.paraSpaceAfter != null) opts.paraSpaceAfter = num(r.paraSpaceAfter, 0);
      return { text: String(r.text ?? ""), options: opts };
    });
  }
  return String(e.text ?? "");
}

async function imageSource(src, ctx) {
  const s = String(src || "");
  if (/^data:image\//i.test(s)) return { data: s };
  if (/^https?:\/\//i.test(s)) return { path: s };
  if (/^[A-Za-z0-9+/=\s]{200,}$/.test(s)) return { data: "image/png;base64," + s.replace(/\s+/g, "") };
  if (!ctx.readBytes) throw new Error(`图片 ${s} 需要从工作区读取，但当前环境没有文件读取通道`);
  const bytes = await ctx.readBytes(s);
  const ext = (s.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "image/png";
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin); // Node ≥16 和浏览器都有 btoa
  return { data: `${mime};base64,${b64}` };
}

function tableRows(e, defaults) {
  const rows = Array.isArray(e.rows) ? e.rows : [];
  const headerRows = num(e.headerRows, e.header === false ? 0 : 1);
  return rows.map((r, ri) => (Array.isArray(r) ? r : (r?.cells || [])).map((c) => {
    const cell = c && typeof c === "object" && !Array.isArray(c) ? c : { text: c };
    const o = {};
    if (ri < headerRows) { o.bold = cell.bold !== false; o.fill = { color: hex(cell.fill || e.headerFill) || "F2F2F2" }; o.color = hex(cell.color || e.headerColor) || "1F1F1F"; }
    else { if (cell.bold != null) o.bold = !!cell.bold; if (cell.fill) o.fill = { color: hex(cell.fill) || "FFFFFF" }; if (cell.color) o.color = hex(cell.color) || undefined; }
    if (cell.italic) o.italic = true;
    if (cell.align) o.align = cell.align; if (cell.valign) o.valign = cell.valign;
    if (cell.size || cell.fontSize) o.fontSize = num(cell.size || cell.fontSize, num(e.fontSize, 12));
    if (cell.colspan > 1) o.colspan = num(cell.colspan, 1); if (cell.rowspan > 1) o.rowspan = num(cell.rowspan, 1);
    if (cell.margin != null) o.margin = cell.margin;
    if (cell.link) o.hyperlink = { url: String(cell.link) };
    return { text: String(cell.text ?? ""), options: o };
  }));
}

function chartData(e) {
  // 两种写法：series: [{name, labels, values}] 或 { labels: [...], series: [{name, values}] }
  const labels = Array.isArray(e.labels) ? e.labels.map(String) : null;
  const series = Array.isArray(e.series) ? e.series : (Array.isArray(e.data) ? e.data : []);
  return series.map((s, i) => ({ name: String(s.name ?? `系列${i + 1}`), labels: Array.isArray(s.labels) ? s.labels.map(String) : (labels || (s.values || []).map((_, k) => String(k + 1))), values: (s.values || []).map((v) => num(v, 0)) }));
}

/** 规格 → .pptx 字节。ctx.readBytes(path) 取工作区图片。返回 { bytes, summary } */
export async function renderPptx(spec, ctx = {}) {
  const PptxGen = await lib();
  const s = spec && typeof spec === "object" ? spec : {};
  const pres = new PptxGen();
  if (typeof s.layout === "object" && s.layout) { pres.defineLayout({ name: "CUSTOM", width: num(s.layout.width, 10), height: num(s.layout.height, 5.625) }); pres.layout = "CUSTOM"; }
  else pres.layout = LAYOUTS[String(s.layout || "16x9").toLowerCase()] || "LAYOUT_16x9";
  if (s.title) pres.title = String(s.title);
  if (s.author) pres.author = String(s.author);
  if (s.subject) pres.subject = String(s.subject);
  if (s.company) pres.company = String(s.company);
  pres.lang = s.lang || "zh-CN";
  if (s.rtl) pres.rtlMode = true;
  const defaults = { fontFace: s.defaults?.fontFace || s.fontFace || s.font || "Microsoft YaHei", fontSize: num(s.defaults?.fontSize || s.fontSize, 18), color: hex(s.defaults?.color || s.color) || "333333", accent: hex(s.defaults?.accent || s.accent) || "1677FF" };
  if (s.theme && typeof s.theme === "object") pres.theme = { headFontFace: s.theme.headFont || s.theme.fontFace, bodyFontFace: s.theme.bodyFont || s.theme.fontFace, lang: s.lang || "zh-CN" };

  // 母版：背景 / 页脚文字 / 页码
  const master = s.master && typeof s.master === "object" ? s.master : null;
  const MASTER = "MAIN";
  {
    const objects = [];
    if (master?.footer) objects.push({ text: { text: String(master.footer), options: { x: 0.4, y: "92%", w: "60%", h: 0.35, fontSize: 10, color: hex(master.footerColor) || "8C8C8C", fontFace: defaults.fontFace } } });
    if (master?.logo) { try { const img = await imageSource(master.logo, ctx); objects.push({ image: { ...img, x: "88%", y: 0.25, w: 0.9, h: 0.5 } }); } catch {} }
    if (master?.title !== undefined && master.title !== null && typeof master.title === "object") objects.push({ placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.3, w: "90%", h: 1, fontSize: num(master.title.fontSize, 32), bold: master.title.bold !== false, color: hex(master.title.color) || defaults.color, fontFace: defaults.fontFace } } });
    const bg = master?.background ?? s.background;
    let background;
    if (bg) { if (typeof bg === "string" && hex(bg)) background = { color: hex(bg) }; else if (typeof bg === "object" && bg.color) background = { color: hex(bg.color) || "FFFFFF" }; else if (typeof bg === "object" && (bg.src || bg.path)) { try { background = await imageSource(bg.src || bg.path, ctx); } catch {} } }
    pres.defineSlideMaster({ title: MASTER, background: background || { color: "FFFFFF" }, objects, slideNumber: master?.slideNumber || s.slideNumber ? { x: "94%", y: "92%", fontSize: 10, color: "8C8C8C", fontFace: defaults.fontFace } : undefined });
  }

  const slides = Array.isArray(s.slides) ? s.slides : [];
  let elementCount = 0, chartCount = 0, imageErrors = [];
  for (let si = 0; si < slides.length; si++) {
    const sl = slides[si] && typeof slides[si] === "object" ? slides[si] : { title: String(slides[si] ?? "") };
    const slide = pres.addSlide({ masterName: MASTER });
    // 页面背景
    const bg = sl.background;
    if (bg) { if (typeof bg === "string" && hex(bg)) slide.background = { color: hex(bg) }; else if (typeof bg === "object" && bg.color) slide.background = { color: hex(bg.color) || "FFFFFF" }; else if (typeof bg === "object" && (bg.src || bg.path)) { try { slide.background = await imageSource(bg.src || bg.path, ctx); } catch (e) { imageErrors.push(`第 ${si + 1} 页背景: ${String(e?.message || e)}`); } } }
    if (sl.notes) slide.addNotes(String(sl.notes));
    if (sl.transition) slide.transition = typeof sl.transition === "object" ? sl.transition : { type: String(sl.transition) };
    // 快捷字段：title / subtitle / bullets / text（按版式自动排位）
    const kind = String(sl.layout || (sl.subtitle && !sl.bullets && !sl.elements ? "title" : sl.title && (sl.bullets || sl.text) ? "content" : sl.title && !sl.elements ? "section" : "blank")).toLowerCase();
    if (sl.title) {
      const titleOpts = kind === "title" ? { x: 0.6, y: "34%", w: "88%", h: 1.2, fontSize: num(sl.titleSize, 40), bold: true, align: "center", valign: "middle" } : kind === "section" ? { x: 0.6, y: "38%", w: "88%", h: 1.1, fontSize: num(sl.titleSize, 36), bold: true, align: sl.titleAlign || "left", valign: "middle" } : { x: 0.6, y: 0.35, w: "88%", h: 0.9, fontSize: num(sl.titleSize, 28), bold: true, align: sl.titleAlign || "left", valign: "middle" };
      slide.addText(textContent({ text: sl.title }, defaults), { ...titleOpts, fontFace: defaults.fontFace, color: hex(sl.titleColor) || defaults.color, margin: 0 });
      elementCount++;
    }
    if (sl.subtitle) { slide.addText(String(sl.subtitle), { x: 0.6, y: kind === "title" ? "52%" : 1.2, w: "88%", h: 0.7, fontSize: num(sl.subtitleSize, kind === "title" ? 20 : 16), color: hex(sl.subtitleColor) || "8C8C8C", align: kind === "title" ? "center" : "left", fontFace: defaults.fontFace, margin: 0 }); elementCount++; }
    if (sl.bullets || (sl.text && kind === "content")) {
      const twoCol = sl.layout === "twocolumn" || sl.layout === "two-column";
      const body = { items: sl.bullets, text: sl.text, bullet: sl.bullets ? (sl.numbered ? "number" : true) : undefined };
      slide.addText(textContent(body, defaults), { x: 0.6, y: sl.subtitle ? 1.9 : 1.4, w: twoCol ? "43%" : "88%", h: sl.subtitle ? 3 : 3.5, fontSize: num(sl.bodySize, 18), color: defaults.color, fontFace: defaults.fontFace, valign: "top", paraSpaceAfter: 6, margin: 0 });
      elementCount++;
      if (twoCol && (sl.right || sl.rightBullets || sl.rightText)) { slide.addText(textContent({ items: sl.rightBullets, text: sl.rightText || sl.right, bullet: sl.rightBullets ? true : undefined }, defaults), { x: "52%", y: sl.subtitle ? 1.9 : 1.4, w: "43%", h: 3.5, fontSize: num(sl.bodySize, 18), color: defaults.color, fontFace: defaults.fontFace, valign: "top", margin: 0 }); elementCount++; }
    }
    if (sl.image && !sl.elements) { try { const img = await imageSource(sl.image.src || sl.image, ctx); slide.addImage({ ...img, x: sl.image.x != null ? dim(sl.image.x, 5.5) : "55%", y: dim(sl.image.y, 1.4), w: dim(sl.image.w, "40%"), h: dim(sl.image.h, 3.2), sizing: sl.image.sizing ? { type: sl.image.sizing, w: dim(sl.image.w, 4), h: dim(sl.image.h, 3.2) } : undefined }); elementCount++; } catch (e) { imageErrors.push(`第 ${si + 1} 页图片: ${String(e?.message || e)}`); } }
    // 任意元素
    for (const e of Array.isArray(sl.elements) ? sl.elements : []) {
      if (!e || typeof e !== "object") continue;
      const t = String(e.type || "text").toLowerCase();
      try {
        if (t === "text" || t === "textbox" || t === "list" || t === "bullets") {
          const body = t === "list" || t === "bullets" ? { ...e, items: e.items || e.lines, bullet: e.bullet ?? (e.numbered ? "number" : true) } : e;
          slide.addText(textContent(body, defaults), textOpts(body, defaults));
        } else if (t === "image" || t === "img") {
          const img = await imageSource(e.src || e.path || e.data, ctx);
          slide.addImage({ ...img, x: dim(e.x, 1), y: dim(e.y, 1), w: dim(e.w, 4), h: dim(e.h, 3), rounding: !!e.rounded, sizing: e.sizing ? { type: e.sizing, w: dim(e.w, 4), h: dim(e.h, 3) } : undefined, hyperlink: e.link ? { url: String(e.link) } : undefined, rotate: e.rotate, transparency: e.transparency });
        } else if (t === "shape") {
          const shape = pres.ShapeType[SHAPES[String(e.shape || "rect").toLowerCase()] || "rect"];
          const o = { x: dim(e.x, 1), y: dim(e.y, 1), w: dim(e.w, 3), h: dim(e.h, 1), fill: e.fill === "none" ? undefined : { color: hex(typeof e.fill === "string" ? e.fill : e.fill?.color) || defaults.accent, transparency: num(e.fill?.transparency, 0) }, line: e.line === "none" ? { color: "FFFFFF", width: 0 } : { color: hex(typeof e.line === "string" ? e.line : e.line?.color) || (e.fill ? hex(typeof e.fill === "string" ? e.fill : e.fill?.color) || defaults.accent : defaults.accent), width: num(e.line?.width, e.line ? 1 : 0), dashType: e.line?.dash || "solid", beginArrowType: e.line?.beginArrow, endArrowType: e.line?.endArrow }, rectRadius: e.rectRadius != null ? num(e.rectRadius, 0) : (SHAPES[String(e.shape || "").toLowerCase()] === "roundRect" ? 0.1 : undefined), rotate: e.rotate, shadow: e.shadow ? (typeof e.shadow === "object" ? e.shadow : { type: "outer", blur: 3, offset: 2, angle: 45, color: "000000", opacity: 0.25 }) : undefined, flipH: e.flipH, flipV: e.flipV };
          if (e.text != null || e.runs) slide.addText(textContent(e, defaults), { ...o, shape, fontFace: e.font || defaults.fontFace, fontSize: num(e.fontSize || e.size, 14), color: hex(e.color) || "FFFFFF", align: e.align || "center", valign: e.valign || "middle", bold: !!e.bold, margin: e.margin ?? 6 });
          else slide.addShape(shape, o);
        } else if (t === "table") {
          const rows = tableRows(e, defaults);
          const cols = Math.max(0, ...rows.map((r) => r.length));
          const colW = Array.isArray(e.colW || e.widths) ? (e.colW || e.widths).map((w) => num(w, 1)) : (e.w && typeof e.w === "number" ? Array(cols).fill(e.w / Math.max(1, cols)) : undefined);
          slide.addTable(rows, { x: dim(e.x, 0.6), y: dim(e.y, 1.4), w: colW ? undefined : dim(e.w, "88%"), h: e.h != null ? dim(e.h, 3) : undefined, colW, rowH: e.rowH, fontSize: num(e.fontSize, 12), fontFace: e.font || defaults.fontFace, color: hex(e.color) || defaults.color, border: e.border === "none" ? { type: "none" } : { type: "solid", pt: num(e.border?.width, 0.75), color: hex(typeof e.border === "string" ? e.border : e.border?.color) || "D9D9D9" }, fill: e.fill ? { color: hex(e.fill) || "FFFFFF" } : undefined, align: e.align || "left", valign: e.valign || "middle", autoPage: !!e.autoPage, margin: e.margin ?? 4 });
        } else if (t === "chart") {
          const type = pres.ChartType[CHARTS[String(e.chartType || e.chart || "bar").toLowerCase()] || "bar"];
          const data = chartData(e);
          const barDir = /^hbar$/i.test(String(e.chartType || "")) || e.horizontal ? "bar" : "col";
          const o = { x: dim(e.x, 0.6), y: dim(e.y, 1.4), w: dim(e.w, "88%"), h: dim(e.h, 3.5), barDir, barGrouping: e.stacked ? "stacked" : "clustered", chartColors: Array.isArray(e.colors) ? e.colors.map((c) => hex(c) || "1677FF") : ["1677FF", "52C41A", "FAAD14", "F5222D", "722ED1", "13C2C2", "EB2F96", "FA8C16"], showLegend: e.legend !== false, legendPos: e.legendPos || "b", showTitle: !!e.title, title: e.title ? String(e.title) : undefined, titleFontSize: num(e.titleSize, 14), showValue: !!e.showValues, dataLabelPosition: e.labelPos, dataLabelFormatCode: e.numFmt, catAxisTitle: e.xTitle, valAxisTitle: e.yTitle, showCatAxisTitle: !!e.xTitle, showValAxisTitle: !!e.yTitle, valAxisMinVal: e.yMin, valAxisMaxVal: e.yMax, catAxisLabelFontSize: num(e.axisSize, 10), valAxisLabelFontSize: num(e.axisSize, 10), lineDataSymbol: e.markers === false ? "none" : "circle", lineSmooth: !!e.smooth, holeSize: e.holeSize, showPercent: e.showPercent, showLabel: e.showLabels, valGridLine: e.gridlines === false ? { style: "none" } : undefined, fontFace: defaults.fontFace };
          slide.addChart(type, data, o); chartCount++;
        } else if (t === "notes") { slide.addNotes(String(e.text || "")); continue; }
        else if (t === "media" || t === "video" || t === "audio") { slide.addMedia({ type: t === "audio" ? "audio" : "video", path: String(e.src || e.path), x: dim(e.x, 1), y: dim(e.y, 1), w: dim(e.w, 4), h: dim(e.h, 3) }); }
        else { slide.addText(String(e.text ?? JSON.stringify(e)), textOpts(e, defaults)); }
        elementCount++;
      } catch (err) { imageErrors.push(`第 ${si + 1} 页 ${t}: ${String(err?.message || err)}`); }
    }
  }
  // uint8array 两端通用（nodebuffer 只有 Node 有，arraybuffer 还得再包一层）。
  const out = await pres.write({ outputType: "uint8array" });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
  const summary = `${slides.length} 页 · ${elementCount} 个元素${chartCount ? ` · ${chartCount} 张图表` : ""}${imageErrors.length ? `\n⚠️ 未能载入：${imageErrors.join("；")}` : ""}`;
  return { bytes, summary };
}

/** 已有 .pptx → 每页文字与备注（jszip 直接解析 slide XML）。 */
export async function readPptx(bytes, opts = {}) {
  const JSZipMod = await import("jszip");
  const JSZip = JSZipMod.default || JSZipMod;
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]);
  const decode = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  // 页码 / 日期 / 页脚占位符（母版塞进来的）不算内容，先剥掉整个形状
  const stripPlaceholders = (xml) => xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (sp) => (/<p:ph\b[^>]*type="(sldNum|dt|ftr)"/.test(sp) ? "" : sp));
  const textsOf = (raw) => {
    const xml = stripPlaceholders(raw);
    // 每个 <a:p> 是一段；段内 <a:t> 拼接；空段跳过
    const paras = [];
    for (const p of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const lvl = +(p[0].match(/<a:pPr[^>]*\blvl="(\d+)"/)?.[1] || 0);
      // <a:t> 可能带属性（xml:space="preserve" 等），只认裸标签会把整段丢掉
      const t = [...p[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decode(m[1])).join("");
      if (t.trim()) paras.push(lvl ? `${"  ".repeat(lvl)}- ${t}` : t);
    }
    return paras;
  };
  const maxSlides = num(opts.maxSlides, 200);
  const slides = [];
  for (const n of slideNames.slice(0, maxSlides)) {
    const idx = +n.match(/(\d+)/)[1];
    const xml = await zip.file(n).async("string");
    let notes = "";
    const notesName = `ppt/notesSlides/notesSlide${idx}.xml`;
    if (zip.file(notesName)) notes = textsOf(await zip.file(notesName).async("string")).join("\n");
    const pics = (xml.match(/<p:pic\b/g) || []).length, charts = (xml.match(/<c:chart\b/g) || []).length, tables = (xml.match(/<a:tbl\b/g) || []).length;
    slides.push({ index: idx, texts: textsOf(xml), notes, pictures: pics, charts, tables });
  }
  let layout = "";
  try { const pres = await zip.file("ppt/presentation.xml").async("string"); const m = pres.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/); if (m) layout = `${(+m[1] / 914400).toFixed(2)}x${(+m[2] / 914400).toFixed(2)} 英寸`; } catch {}
  return { format: "pptx", slideCount: slideNames.length, layout, slides, truncated: slideNames.length > maxSlides };
}
