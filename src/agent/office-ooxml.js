// OOXML 直改：不经过任何文档库，直接改 zip 里的 XML。
// 用在两处：① 改已有 Word / PPT 的文字（docx 库和 pptxgenjs 都只会新建，不会读改）；
// ② 探测已有 xlsx 里有没有图表（exceljs 存不下图表，改完会丢——得提前告诉模型）。
//
// 替换是「段落感知」的：Word 会把一句话拆进好几个 <w:r>（拼写检查、格式切换都会拆），
// 逐个 <w:t> 找是找不到的。所以按段落把所有 <w:t> 拼成一整句再匹配，命中后把整段新文本
// 放进第一个 <w:t>、其余清空——第一段 run 的格式得以保留，后面的 run 变成空串不占位。

let _zip = null;
async function jszip() {
  if (!_zip) { const m = await import("jszip"); _zip = m.default || m; }
  return _zip;
}

const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescXml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");

/**
 * 在一段 XML 里做段落感知替换。
 * @param {string} xml 整个 part 的 XML
 * @param {{pTag:string,tTag:string}} tags docx: {pTag:"w:p", tTag:"w:t"}；pptx: {pTag:"a:p", tTag:"a:t"}
 * @param {{find:string,replace:string,all?:boolean,regex?:boolean,caseInsensitive?:boolean}} op
 * @returns {{xml:string, count:number}}
 */
export function replaceInXml(xml, tags, op) {
  const { pTag, tTag } = tags;
  const pRe = new RegExp(`<${pTag}\\b[^>]*>[\\s\\S]*?<\\/${pTag}>`, "g");
  const tRe = new RegExp(`<${tTag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tTag}>`, "g");
  const flags = (op.all !== false ? "g" : "") + (op.caseInsensitive ? "i" : "");
  const pattern = op.regex ? new RegExp(op.find, flags) : new RegExp(String(op.find).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  let count = 0;
  let done = false;
  const out = xml.replace(pRe, (para) => {
    if (done) return para;
    const pieces = [...para.matchAll(tRe)];
    if (!pieces.length) return para;
    const joined = pieces.map((m) => unescXml(m[2])).join("");
    if (!pattern.test(joined)) return para;
    pattern.lastIndex = 0;
    let local = 0;
    const replaced = joined.replace(pattern, (...args) => { local++; return typeof op.replace === "string" ? (op.regex ? args[0].replace(pattern, op.replace) : op.replace) : String(op.replace ?? ""); });
    count += local;
    if (op.all === false && local) done = true;
    // 第一个 <t> 装全文（保留它的属性，加 xml:space="preserve" 防止首尾空格被吃），其余清空
    let idx = 0;
    return para.replace(tRe, (whole, attrs) => {
      const i = idx++;
      if (i === 0) {
        const a = String(attrs || "");
        const withSpace = /xml:space=/.test(a) ? a : `${a} xml:space="preserve"`;
        return `<${tTag}${withSpace}>${escXml(replaced)}</${tTag}>`;
      }
      return `<${tTag}${attrs || ""}></${tTag}>`;
    });
  });
  return { xml: out, count };
}

/** docx / pptx 里哪些 part 装正文。 */
function textParts(names, format) {
  if (format === "docx") return names.filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n));
  if (format === "pptx") return names.filter((n) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(n)).sort();
  return [];
}

/**
 * 对已有 docx / pptx 做一组文字操作，返回新字节。
 * ops: [{op:"replace", find, replace, all?, regex?, caseInsensitive?, scope?:"body"|"notes"|"all"}]
 * @returns {Promise<{bytes:Uint8Array, report:string[], total:number}>}
 */
export async function editOoxmlText(bytes, format, ops) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const parts = textParts(names, format);
  if (!parts.length) throw new Error(`这不是一个可识别的 ${format} 文件（找不到正文 XML）`);
  const tags = format === "docx" ? { pTag: "w:p", tTag: "w:t" } : { pTag: "a:p", tTag: "a:t" };
  const report = [];
  let total = 0;
  const cache = new Map();
  for (const name of parts) cache.set(name, await zip.file(name).async("string"));
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw && typeof raw === "object" ? raw : null;
    const kind = String(op?.op || op?.action || "replace").toLowerCase();
    if (!op || kind !== "replace") { report.push(`跳过不认识的操作：${JSON.stringify(raw).slice(0, 80)}（目前支持 replace）`); continue; }
    if (op.find == null || op.find === "") { report.push("跳过：replace 缺少 find"); continue; }
    const scope = String(op.scope || "all");
    let hits = 0;
    for (const name of parts) {
      const isNotes = /notesSlide/.test(name);
      if (scope === "body" && isNotes) continue;
      if (scope === "notes" && !isNotes) continue;
      const { xml, count } = replaceInXml(cache.get(name), tags, op);
      if (count) { cache.set(name, xml); hits += count; }
    }
    total += hits;
    report.push(hits ? `「${String(op.find).slice(0, 40)}」→「${String(op.replace ?? "").slice(0, 40)}」：${hits} 处` : `「${String(op.find).slice(0, 40)}」：没找到（文字可能跨段，或大小写不同——试 caseInsensitive:true）`);
  }
  for (const [name, xml] of cache) zip.file(name, xml);
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes: out, report, total };
}

/** 已有 xlsx 里有多少图表 / 图片 / 迷你图 / 透视表——exceljs 一存就丢的那些。 */
export async function inspectXlsxParts(bytes) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const count = (re) => names.filter((n) => re.test(n)).length;
  const out = { charts: count(/^xl\/charts\/chart\d+\.xml$/), images: count(/^xl\/media\//), pivots: count(/^xl\/pivotTables\//), drawings: count(/^xl\/drawings\/drawing\d+\.xml$/), macros: names.some((n) => /^xl\/vbaProject\.bin$/.test(n)), sparklines: 0 };
  for (const n of names.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
    const xml = await zip.file(n).async("string");
    out.sparklines += (xml.match(/<x14:sparklineGroup\b/g) || []).length;
  }
  return out;
}
