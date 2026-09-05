// 办公文档三件套：office_write（新建）/ office_edit（改已有）/ office_read（读结构）。
//
// 分工：Excel 新建走 Rust（office_xlsx_write：原生图表 / 条件格式 / 验证 / 表格 / 迷你图 / 图片 / 保护，
// JS 生态写不了图表）；Word / PPT 新建在 JS 渲染（docx / pptxgenjs）；读和改在 JS（exceljs / mammoth /
// jszip）。这里只做：判格式、拼路径、调渲染器、写字节、拼给模型看的回执。字节进出 Rust 走 base64。
//
// 规格词汇（OFFICE_HELP）就是模型的说明书：工具描述里只说「要完整字段表调 help:true」，
// 描述短、词汇全，两边都不牺牲。写错字段不会静默吞掉——Rust / JS 侧都把不认识的键报回来。

import { renderDocx, readDocx } from "./office-docx.js";
import { renderPptx, readPptx } from "./office-pptx.js";
import { editXlsx, readXlsx } from "./office-xlsx.js";
import { editOoxmlText, inspectXlsxParts } from "./office-ooxml.js";

export const OFFICE_FORMATS = ["xlsx", "docx", "pptx"];

/** 按显式 format 或扩展名判格式；认不出返回 null。 */
export function officeFormatOf(path, explicit) {
  const f = String(explicit || "").trim().toLowerCase().replace(/^\./, "");
  if (f === "excel" || f === "xls" || f === "xlsx") return "xlsx";
  if (f === "word" || f === "doc" || f === "docx") return "docx";
  if (f === "ppt" || f === "powerpoint" || f === "pptx") return "pptx";
  const m = String(path || "").toLowerCase().match(/\.(xlsx|docx|pptx|xlsm|doc|xls|ppt)$/);
  if (!m) return null;
  return { xlsx: "xlsx", xlsm: "xlsx", xls: "xlsx", docx: "docx", doc: "docx", pptx: "pptx", ppt: "pptx" }[m[1]] || null;
}

/** 保证 dest 带上正确扩展名（模型常写 "报表" 或 "报表.xls"）。 */
export function officeDestFor(dest, format) {
  const d = String(dest || "").trim();
  if (!d) return "";
  if (new RegExp(`\\.${format}$`, "i").test(d)) return d;
  return d.replace(/\.(xls|xlsm|doc|ppt|xlsx|docx|pptx)$/i, "") + "." + format;
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin); // Node ≥16 和浏览器都有 btoa / atob，不引 Buffer
}
export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const fmtKb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ── 规格说明书 ────────────────────────────────────────────────────────────────

export const OFFICE_HELP = {
  xlsx: `【Excel 规格 · office_write(format:"xlsx")】spec = 工作簿对象。单表可以直接把工作表字段写在顶层。
顶层：sheets:[工作表…]，styles:{名字:样式}（命名样式，用 style:"名字" 引用），font/fontSize/color（全簿默认字体），
  properties:{title,subject,author,company,keywords,comment}，definedNames:{名字:"=Sheet1!$A$1:$A$5"}，activeSheet:"名字"，headerStyle，autofit。
工作表：name；columns:[{header,key,type:"date|datetime|time|number|int|percent|currency|string|bool",width,hidden,numFmt,style…}]（表头写在第 1 行，含默认样式）；
  rows:[[单元格…] | {key:值…} | {values:[…],style,height,hidden}]（从表头下一行开始；startRow:N 改起点）；cells:{"E2":单元格}（稀疏写）；
  styleRanges:{"A1:D1":样式}；merges:["A1:D1" | {range,text,样式…}]；widths:{"A":14,"B:D":10}；heights:{"1":28}；hiddenCols/hiddenRows；
  groupRows/groupCols:[[2,5] | {from,to,collapsed}]；freeze:true|N|"B2"|{rows,cols}；autoFilter:true|"A1:D20"；filters:[{col,values:[…]} | {col,op:"gt|lt|contains…",value}]；
  tables:[{ref:"A1:D10",name,style:"Medium9"（Light1-21/Medium1-28/Dark1-11）,totalRow,columns:[{header,total:"sum|average|count|max|min",totalLabel,formula:"=[@数量]*[@单价]",numFmt}],bandedRows}]；
  conditionalFormats:[{ref, type:"cell"（operator:">|<|>=|<=|=|<>|between|notBetween", value/min/max）| "colorScale"（colors:[2或3色]）| "dataBar"（color）| "iconSet"（icons:"3Arrows|3TrafficLights|4Rating|5Arrows…"）| "top|bottom"（rank,percent）| "aboveAverage" | "duplicate|unique" | "text"（operator:"contains|notContains|beginsWith|endsWith",text）| "date"（period:"today|last7Days|thisMonth…"）| "blank|notBlank|error|notError" | "formula"（formula:"=$C2>20"）, style, stopIfTrue}]；
  validations:[{ref, type:"list"（values:[…] 或 formula:"=$H$1:$H$5"）| "whole|decimal|length"（operator,value/min/max）| "date|time"（value 如 "2026-01-01"）| "custom"（formula）, prompt, promptTitle, error, errorTitle, errorStyle:"stop|warning|info", allowBlank}]；
  charts:[{type:"column|bar|line|area|pie|doughnut|scatter|radar|stock"（可加 Stacked / PercentStacked，如 "columnStacked"）, at:"H2", width:480, height:288, title,
    series:[{name, categories:"A2:A7", values:"B2:B7"（也可 "表名!B2:B7" 或字面量数组 [1,2,3]）, color, line:{color,width,dash}, marker:"circle|square|diamond|none"|{type,size}, labels:true|{value,percent,category,position:"outsideEnd|center…",numFmt}, trendline:"linear|exponential|movingAverage"|{type,equation,r2}, secondaryAxis, smooth, gap, overlap, pointColors:[…]}],
    xAxis/yAxis/y2Axis:{title,min,max,majorUnit,numFmt,majorGridlines,reverse,logBase,hidden,dateAxis}, legend:"bottom|right|top|left|none", style:1-48, holeSize（环形）, rotation（饼图起始角）, dataTable, combine:{type,series:[…]}（组合图，如柱+线）}]；
  images:[{src:"工作区路径或 data:image/png;base64,…", at:"F2", width, height（像素）| scale, fitToCell, embed, offset:{x,y}}]；
  sparklines:[{at:"F2", range:"B2:E2", type:"line|column|winLose", color, high, low, first, last, markers}]；
  notes:[{at:"A1", text, author, visible}]；shapes:[{at, text, width, height, fill, line, font:{size,bold,color}, align, valign}]（文本框）；checkboxes:[{at, checked}]；hyperlinks:[{at,url,text,tip}]；
  pageSetup:{orientation:"landscape|portrait", paper:"A4|Letter|A3…", margins:{left,right,top,bottom,header,footer}（英寸）, fitToPages:[宽页数,高页数], scale, printArea:"A1:H50", repeatRows:[1,1], printGridlines, centerH, pageBreaks:[行号]}；
  headerFooter:{header:{left,center,right} | "&C标题", footer:"&C第 {PAGE} 页 / 共 {PAGES} 页"}（{DATE}{TIME}{FILE}{SHEET} 亦可）；
  protect:true|"密码"|{password, options:{sort,autofilter,formatCells,insertRows,deleteRows…}, unprotectRanges:["B2:B100"]}；tabColor；zoom；gridlines:false；rtl；hidden；active；selection:"B2"；autofit:true（按内容自动列宽）。
单元格：数字 / 字符串 / true / null；"=SUM(A1:A5)" 是公式（动态数组函数 FILTER/UNIQUE/XLOOKUP… 自动识别）；"'=文本" 转义；
  对象 {v:值, t:"date|number|string|bool", f:"公式", v:缓存结果, array:"A1:B3"（数组公式）, link:"https://…", tip, note:"批注", rich:[{text,bold,color…},"普通"], style:"名字"|{…}, 及任意内联样式键}。
样式键：bold, italic, underline:true|"double", strike, size, font, color, fill（背景色）, align:"left|center|right"|{h,v,wrap,indent,rotation,shrink}, valign:"top|middle|bottom", wrap, indent, rotation,
  border:true|"thin|medium|thick|dashed|dotted|double"|{all,top,bottom,left,right:样式|{style,color}}, borderColor, numFmt:"percent|number|currency|date|datetime|time|text|integer|accounting"（别名）或 Excel 格式串如 "0.00%" / "#,##0.00" / "yyyy-mm-dd", locked:false, hidden, superscript, subscript。
颜色："#1677FF" / "1677FF" / "red|blue|green|gray…"。行列地址一律 A1 写法，行号从 1 起。`,
  docx: `【Word 规格 · office_write(format:"docx")】spec = 文档对象。
顶层：title, author, properties:{title,subject,description,keywords}, font（默认字体，默认 Microsoft YaHei）, fontSize（磅）, color, lineSpacing（240=单倍，276=1.15）, paragraphSpacing（twips，120=6pt）,
  styles:{paragraph:{Heading1:{size,bold,color,font}, 自定义名:{size,bold,italic,color,font,align,spacingBefore,spacingAfter}}},
  content:[内容块…]（单节）或 sections:[{page, header, footer, firstHeader, firstFooter, content:[…]}]（多节，各节可换纸张/方向/分栏）,
  page:{size:"A4|A3|A5|Letter|Legal|B5"|{width,height}（twips）, orientation:"portrait|landscape", margins:"normal|narrow|moderate|wide"|{top,right,bottom,left,header,footer}（twips，1440=1 英寸）, columns:2, columnSpace, pageNumberStart, titlePage},
  header/footer: "文字（可含 {PAGE} 和 {NUMPAGES}）" | {text, align, size, color, rule:true（下/上横线）} | {content:[内容块…]}。
内容块（content 数组元素，type 决定形状）：
  {type:"heading", level:1-6, text|runs} / {type:"title"} / {type:"paragraph", text|runs, align:"left|center|right|justify", spacing:{before,after,line,lineRule}, indent:{left,right,firstLine,hanging}, shading, border, keepNext, keepLines, pageBreakBefore, style:"自定义名", tabStops:[{type,position}]}
  {type:"quote", text|runs} / {type:"code", text, font, size, shading} / {type:"list", items:[字符串 | {text|runs, items:[子项…], align…}], style:"bullet|decimal|roman|upperRoman|letter|upperLetter|chineseCounting"（写 decimal 等即编号列表）, level} / {type:"numbered", items:[…]}
  {type:"table", rows:[[单元格…] | {cells:[…], height}], header:true|headerRows:N, columnWidths:[…], widthType:"pct|dxa", width, align:"center", cellAlign, borders:"all|none|outer|horizontal"|{top,bottom,left,right,insideHorizontal,insideVertical}, borderColor, cantSplit, spaceAfter:false}
    单元格：字符串 | run 数组 | {text|runs|content:[内容块], colspan, rowspan, shading:"F2F2F2", align, valign:"top|middle|bottom", width, bold, italic, color, size, margins}
  {type:"image", src:"工作区路径 | data:image/png;base64,…", width, height（像素）, align, caption, alt} / {type:"pagebreak"} / {type:"hr", color} / {type:"toc", title, levels:"1-3"} / {type:"bookmark", id, text}
run（富文本片段，text 可以是字符串或 run 数组）：{text, bold, italic, underline:true|"double|dash", strike, doubleStrike, color, size（磅）, font, highlight:"yellow|green|cyan|magenta|red|blue|darkGray|lightGray…", shading, superscript, subscript, smallCaps, allCaps, characterSpacing, link:"https://… 或 #书签id", footnote:"脚注文字", break:1（换行）, tab:true, pageNumber:true, totalPages:true, bookmark:"id"}。
颜色用 6 位十六进制（"1677FF" / "#1677FF"）。字号一律磅（pt）。`,
  pptx: `【PowerPoint 规格 · office_write(format:"pptx")】spec = 演示文稿对象。坐标/尺寸单位英寸（16:9 画布 10×5.625），也可写 "50%"。
顶层：layout:"16x9|16x10|4x3|wide"|{width,height}, title, author, subject, company, lang, rtl, defaults:{fontFace,fontSize,color,accent}, theme:{headFont,bodyFont},
  master:{background:"1F1F1F"|{color}|{image:"路径"}, footer:"页脚文字", footerColor, logo:"路径", slideNumber:true}, background（全局背景色）, slideNumber:true,
  slides:[页…]。
页（快捷字段自动排版）：{layout:"title|section|content|twocolumn|blank", title, titleSize, titleColor, subtitle, subtitleSize, subtitleColor, bullets:[字符串 | {text,level,bold,color…}], numbered:true, text, bodySize,
  rightBullets/rightText（twocolumn 的右栏）, image:{src,x,y,w,h}|"路径", background, notes:"演讲者备注", transition:"fade|push|wipe…", elements:[元素…]}。
元素（elements 数组，type 决定形状，x/y/w/h 定位）：
  {type:"text", text|runs:[{text,bold,italic,underline,strike,color,size,font,highlight,link,superscript,subscript,breakLine}]|lines:[…], x,y,w,h, fontSize, font, bold, italic, underline, color, align:"left|center|right", valign:"top|middle|bottom", fill, line:{color,width,dash}, shadow, margin, lineSpacing, paraSpaceBefore/After, charSpacing, rotate, autoFit, fit:"shrink|resize", rectRadius, link, transparency}
  {type:"list", items:[字符串 | {text,level,bold,color…}], numbered:true|bullet:"number"|"•", x,y,w,h, fontSize…}
  {type:"image", src:"工作区路径 | data:… | http(s)://…", x,y,w,h, rounded, sizing:"contain|cover|crop", link}
  {type:"shape", shape:"rect|roundRect|ellipse|line|triangle|diamond|pentagon|hexagon|star|rightArrow|leftArrow|upArrow|downArrow|chevron|cloud|heart|callout", x,y,w,h, fill:"1677FF"|{color,transparency}|"none", line:{color,width,dash}, text, fontSize, color, align, valign, shadow, rectRadius, rotate}
  {type:"table", rows:[[单元格…]], header:true|headerRows:N, headerFill, headerColor, colW:[…], x,y,w,h, rowH, fontSize, font, border:{type,color,pt}, fill, color, align, autoPage}
    单元格：字符串 | {text, bold, italic, color, fill, align, valign, size, colspan, rowspan, margin, link}
  {type:"chart", chartType:"bar|column|hbar|line|pie|doughnut|area|scatter|radar|bubble", labels:["Q1","Q2"], series:[{name, values:[…], labels?}], x,y,w,h, stacked, horizontal, colors:[…], title, titleSize, legend:false, legendPos:"b|t|l|r", showValues, labelPos, numFmt, xTitle, yTitle, yMin, yMax, axisSize, markers:false, smooth, holeSize, showPercent}
  {type:"notes", text} / {type:"media", src, x,y,w,h}
颜色 6 位十六进制；字号磅。一页放不下的内容请分页，别堆在一页。`,
  edit: `【office_edit · 改已有文件】path 是已有文件；dest 缺省覆盖原文件。
Excel（exceljs 直改，保留原有单元格/样式；⚠ 图表、迷你图、透视表、宏存不下来——文件里有这些时另存 dest 或改用 office_write 重建）：
  spec.sheets:[{name（按名匹配，不存在则新建）| index, rows:[…]（默认追加到末尾；startRow:N 从第 N 行覆盖写）, cells:{"B3":值|{v,f,style…}}, styleRanges, merges, unmerge, widths, heights, hiddenCols/Rows, freeze, autoFilter, tabColor,
    validations, conditionalFormats（词汇同 office_write，条件格式 type 用 exceljs 名：cellIs/expression/colorScale/dataBar/iconSet/top10/aboveAverage/containsText/timePeriod）, images:[{src, range:"B2:D6"|{col,row,width,height}}], pageSetup, protect}]
  spec.ops:[{op:"deleteSheet",name} | {op:"renameSheet",from,to} | {op:"insertRows",sheet,at,count|rows:[…]} | {op:"deleteRows",sheet,at,count} | {op:"spliceColumns",sheet,at,count} | {op:"clear",sheet,range} | {op:"copySheet",from,to} | {op:"setActive",name} | {op:"moveSheet",name,index}]
  spec.definedNames:[{name,ref}]；spec.styles:{命名样式}；spec.properties。
Word / PowerPoint（直接改 XML，保留全部排版）：ops:[{op:"replace", find:"旧文字", replace:"新文字", all:true, regex:false, caseInsensitive:false, scope:"all|body|notes"}]——按段落匹配，跨段的句子分两次替换。
  要大改结构（加章节、换表格、重排版）：先 office_read 读出内容，再用 office_write 生成新文件。`,
};

export function officeHelp(format, mode = "write") {
  if (mode === "edit") return OFFICE_HELP.edit;
  return OFFICE_HELP[format] || `${OFFICE_HELP.xlsx}\n\n${OFFICE_HELP.docx}\n\n${OFFICE_HELP.pptx}`;
}

function parseSpec(spec) {
  if (spec == null) return null;
  if (typeof spec === "string") {
    const raw = spec.trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { throw new Error(`spec 不是合法 JSON：${String(e?.message || e).slice(0, 120)}`); }
  }
  return typeof spec === "object" ? spec : null;
}

// ── 三个入口 ─────────────────────────────────────────────────────────────────
// ctx = { root, invoke(cmd, args), resolve(rel) → 绝对路径 }

async function readWorkspaceBytes(ctx, rel) {
  const abs = ctx.resolve(rel);
  const b64 = await ctx.invoke("read_file_bytes", { path: abs });
  return base64ToBytes(b64);
}

export async function runOfficeWrite(call, ctx) {
  const format = officeFormatOf(call.dest, call.format);
  if (call.help || !call.spec) {
    const f = format || "xlsx";
    return { ok: !call.dest && !call.spec ? true : false, help: true, content: `${call.spec ? "" : "缺少 spec（文档规格）。"}${format ? "" : "format 不明确时按 dest 扩展名判断；"}下面是 ${f} 的完整字段表：\n\n${officeHelp(f)}` };
  }
  if (!format) return { ok: false, content: `[ERROR] 判不出格式：dest「${call.dest || ""}」不带 .xlsx/.docx/.pptx，也没传 format。` };
  if (!call.dest) return { ok: false, content: `[ERROR] office_write 需要 dest（保存路径，相对工作区）。` };
  let spec;
  try { spec = parseSpec(call.spec); } catch (e) { return { ok: false, content: `[ERROR] ${e.message}` }; }
  if (!spec || typeof spec !== "object") return { ok: false, content: `[ERROR] spec 必须是对象。\n\n${officeHelp(format)}` };
  const dest = officeDestFor(call.dest, format);
  const abs = ctx.resolve(dest);
  try {
    if (format === "xlsx") {
      const r = await ctx.invoke("office_xlsx_write", { root: ctx.root, dest: abs, spec });
      const warn = Array.isArray(r?.warnings) && r.warnings.length ? `\n⚠️ ${r.warnings.join("；")}` : "";
      return { ok: true, path: dest, absPath: r?.path || abs, bytes: r?.bytes || 0, content: `已生成 Excel：${dest}（${fmtKb(r?.bytes || 0)}，工作表：${(r?.sheets || []).join("、")}）。${warn}\n用 office_read 可以回读核对；要改再用 office_edit。` };
    }
    const readBytes = (rel) => readWorkspaceBytes(ctx, rel);
    const out = format === "docx" ? await renderDocx(spec, { readBytes }) : await renderPptx(spec, { readBytes });
    await ctx.invoke("write_file_bytes", { path: abs, base64: bytesToBase64(out.bytes) });
    return { ok: true, path: dest, absPath: abs, bytes: out.bytes.length, content: `已生成 ${format === "docx" ? "Word" : "PowerPoint"}：${dest}（${fmtKb(out.bytes.length)}，${out.summary}）。\n用 office_read 可以回读核对文字；改文字用 office_edit，改结构重新 office_write。` };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 400);
    const hint = /不认识|不合法|需要|缺少|json/i.test(msg) ? `\n\n字段表：\n${officeHelp(format)}` : "";
    return { ok: false, path: dest, content: `[失败] 生成 ${format} 出错：${msg}${hint}` };
  }
}

export async function runOfficeEdit(call, ctx) {
  const format = officeFormatOf(call.path, call.format);
  if (call.help) return { ok: true, help: true, content: OFFICE_HELP.edit };
  if (!call.path) return { ok: false, content: `[ERROR] office_edit 需要 path（已有文件）。\n\n${OFFICE_HELP.edit}` };
  if (!format) return { ok: false, content: `[ERROR] 判不出格式：path「${call.path}」不带 .xlsx/.docx/.pptx。` };
  let spec;
  try { spec = parseSpec(call.spec); } catch (e) { return { ok: false, content: `[ERROR] ${e.message}` }; }
  const ops = Array.isArray(call.ops) ? call.ops : (Array.isArray(spec?.ops) && format !== "xlsx" ? spec.ops : null);
  const dest = officeDestFor(call.dest || call.path, format);
  const abs = ctx.resolve(dest);
  try {
    const bytes = await readWorkspaceBytes(ctx, call.path);
    if (format === "xlsx") {
      if (!spec || typeof spec !== "object") return { ok: false, content: `[ERROR] 改 Excel 需要 spec（sheets / ops）。\n\n${OFFICE_HELP.edit}` };
      const parts = await inspectXlsxParts(bytes).catch(() => null);
      const lossy = parts && (parts.charts || parts.sparklines || parts.pivots || parts.macros);
      if (lossy && call.force !== true && dest === officeDestFor(call.path, format)) {
        return { ok: false, content: `[未执行] ${call.path} 里有 ${[parts.charts && `${parts.charts} 张图表`, parts.sparklines && `${parts.sparklines} 个迷你图`, parts.pivots && `${parts.pivots} 个透视表`, parts.macros && "宏"].filter(Boolean).join("、")}，exceljs 重存会把它们丢掉。三个选择：① 传 dest 另存一份（原文件保留）；② 用 office_write 按新规格重建整个文件（图表也能重画）；③ 明确接受丢失就传 force:true。` };
      }
      const r = await editXlsx(bytes, spec, { readBytes: (rel) => readWorkspaceBytes(ctx, rel) });
      await ctx.invoke("write_file_bytes", { path: abs, base64: bytesToBase64(r.bytes) });
      const lossNote = lossy ? `\n⚠️ 原文件里的图表 / 迷你图 / 透视表没有带到 ${dest}。` : "";
      return { ok: true, path: dest, absPath: abs, bytes: r.bytes.length, content: `已修改并保存到 ${dest}（${fmtKb(r.bytes.length)}）：${r.summary}${lossNote}` };
    }
    if (!ops || !ops.length) return { ok: false, content: `[ERROR] 改 ${format === "docx" ? "Word" : "PowerPoint"} 需要 ops（如 [{op:"replace",find,replace}]）。\n\n${OFFICE_HELP.edit}` };
    const r = await editOoxmlText(bytes, format, ops);
    if (!r.total) return { ok: false, path: dest, content: `[未改动] 没有任何一处命中：\n${r.report.join("\n")}\n先 office_read 看看实际文字（Word 常把一句话拆成多段，标点和空格要完全一致）。` };
    await ctx.invoke("write_file_bytes", { path: abs, base64: bytesToBase64(r.bytes) });
    return { ok: true, path: dest, absPath: abs, bytes: r.bytes.length, content: `已修改并保存到 ${dest}（${r.total} 处）：\n${r.report.join("\n")}` };
  } catch (e) {
    return { ok: false, path: dest, content: `[失败] 修改 ${format} 出错：${String(e?.message || e).slice(0, 400)}` };
  }
}

/** 把结构压成模型好读的文本：xlsx 每表一段、每行一行 JSON；docx 给标题树 + 正文；pptx 每页一段。 */
function renderReadResult(format, r, opts) {
  if (format === "xlsx") {
    const lines = [`Excel · 工作表：${r.sheetNames.join("、")}${r.definedNames?.length ? ` · 定义名称：${r.definedNames.join(", ")}` : ""}`];
    for (const sh of r.sheets) {
      const meta = [`${sh.dims.rows} 行 × ${sh.dims.cols} 列`, sh.freeze ? `冻结 ${sh.freeze.rows} 行 ${sh.freeze.cols} 列` : "", sh.merges.length ? `合并 ${sh.merges.slice(0, 12).join(" ")}${sh.merges.length > 12 ? "…" : ""}` : "", sh.autoFilter ? `筛选 ${typeof sh.autoFilter === "string" ? sh.autoFilter : "开"}` : "", sh.tables.length ? `表格 ${sh.tables.join(",")}` : "", sh.images ? `${sh.images} 张图` : "", sh.conditionalFormats ? `${sh.conditionalFormats} 条条件格式` : "", sh.validations ? `${sh.validations} 条验证` : ""].filter(Boolean).join(" · ");
      lines.push(`\n## ${sh.name}（${meta}）从 ${sh.from} 起：`);
      sh.data.forEach((row, i) => { lines.push(`${i + 1}: ${JSON.stringify(row)}`); });
      if (sh.truncated) lines.push(`…（已截断：maxRows=${opts.maxRows ?? 200} / maxCols=${opts.maxCols ?? 50}，用 range 或 sheet 参数分段读）`);
    }
    return lines.join("\n");
  }
  if (format === "docx") {
    const head = r.headings.length ? `标题结构：\n${r.headings.map((h) => `${"  ".repeat(h.level - 1)}H${h.level} ${h.text}`).join("\n")}\n\n` : "";
    const tables = r.tables.length ? `\n\n表格（${r.tables.length} 个）：\n${r.tables.slice(0, 20).map((t, i) => `[表 ${i + 1}]\n${t.map((row) => row.join(" | ")).join("\n")}`).join("\n\n")}` : "";
    return `Word · ${r.stats.chars} 字 · ${r.stats.paragraphs} 段 · ${r.stats.tables} 表 · ${r.stats.images} 图\n\n${head}正文：\n${r.text}${tables}${r.warnings.length ? `\n\n⚠️ ${r.warnings.join("；")}` : ""}`;
  }
  const slides = r.slides.map((s) => `--- 第 ${s.index} 页${s.pictures ? ` · ${s.pictures} 图` : ""}${s.charts ? ` · ${s.charts} 图表` : ""}${s.tables ? ` · ${s.tables} 表` : ""} ---\n${s.texts.join("\n") || "(无文字)"}${s.notes ? `\n[备注] ${s.notes}` : ""}`).join("\n");
  return `PowerPoint · ${r.slideCount} 页${r.layout ? ` · ${r.layout} 英寸` : ""}\n${slides}${r.truncated ? "\n…（已截断，用 maxSlides 调大）" : ""}`;
}

export async function runOfficeRead(call, ctx) {
  const format = officeFormatOf(call.path, call.format);
  if (!call.path) return { ok: false, content: "[ERROR] office_read 需要 path。" };
  if (!format) return { ok: false, content: `[ERROR] 判不出格式：path「${call.path}」不带 .xlsx/.docx/.pptx（纯文本、PDF 用 read_file）。` };
  try {
    const bytes = await readWorkspaceBytes(ctx, call.path);
    const opts = { sheet: call.sheet, range: call.range, maxRows: call.maxRows, maxCols: call.maxCols, styles: call.styles, maxSlides: call.maxSlides, maxChars: call.maxChars };
    const r = format === "xlsx" ? await readXlsx(bytes, opts) : format === "docx" ? await readDocx(bytes, opts) : await readPptx(bytes, opts);
    return { ok: true, path: call.path, data: r, content: renderReadResult(format, r, opts) };
  } catch (e) {
    return { ok: false, path: call.path, content: `[失败] 读取 ${format} 出错：${String(e?.message || e).slice(0, 400)}` };
  }
}

/**
 * main.js 执行分支的全部逻辑（那边只剩一行接线，main.js 有尺寸闸）。
 * ui = { inTauri, root, invoke, resolve(rel, root), reloadDir, parentDir, escHtml, res, vp }
 */
export async function runOfficeStep(call, ui) {
  const res = ui.res || {};
  const fail = (badge, content) => { res.className = "atc-result atc-result--err"; res.textContent = badge; return { type: call.type, path: call.dest || call.path || "", content }; };
  if (!ui.inTauri) return fail("桌面专用", `[不可用] ${call.type} 只能在桌面 App 里用。`);
  const root = ui.root || "";
  if (!root && !call.help) return fail("未打开工作区", "[失败] 未打开工作区，无法确定文件位置。");
  res.className = "atc-result"; res.innerHTML = `<span class="atc-spin"></span> ${call.type === "office_read" ? "读取中…" : "生成中…"}`;
  const ctx = { root, invoke: ui.invoke, resolve: (p) => ui.resolve(p, root) };
  const out = call.type === "office_write" ? await runOfficeWrite(call, ctx) : call.type === "office_edit" ? await runOfficeEdit(call, ctx) : await runOfficeRead(call, ctx);
  if (out.ok && out.absPath) { try { ui.reloadDir(ui.parentDir(out.absPath)); } catch {} }
  res.className = `atc-result ${out.ok ? "atc-result--ok" : "atc-result--err"}`;
  res.textContent = out.help ? "字段表" : out.ok ? (call.type === "office_read" ? "已读取" : `已保存${out.bytes ? " · " + Math.max(1, Math.round(out.bytes / 1024)) + " KB" : ""}`) : "失败";
  if (ui.vp && out.content && (call.type === "office_read" || out.help)) ui.vp.innerHTML = `<pre>${ui.escHtml(String(out.content).slice(0, 12000))}</pre>`;
  return { type: call.type, path: out.path || call.dest || call.path || "", content: String(out.content || "") };
}
