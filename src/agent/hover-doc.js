/**
 * 悬浮说明里哪些字该翻、哪些一个字都不能动。
 *
 * 语言服务给的 hover 是一段 markdown：**签名**在代码围栏里，**文档**是围栏外的散文。
 * 用户要的是「把变量、函数、方法按我选的语言翻出来」——指的是那段散文；签名要是被翻了，
 * `def show(buf, name) -> None` 会变成一句读不了也抄不走的话，那比不翻更糟。
 *
 * 纯字符串进、纯字符串出，没有 DOM、没有网络。
 */

/**
 * 按代码围栏把 markdown 切成交替的段：`{ code: true }` 原样保留，`{ code: false }` 可翻。
 *
 * 围栏的判据是**行首连续三个以上的反引号**，并且用开栏那一行的长度去配对——文档字符串里
 * 嵌四个反引号的块很常见，按固定三个配对会在中间提前收栏，后半段代码被当成散文翻掉。
 */
export function splitDocSegments(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let buf = [], inCode = false, fence = "";
  const flush = (code) => { if (buf.length) out.push({ code, text: buf.join("\n") }); buf = []; };
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!inCode && m) { flush(false); inCode = true; fence = m[1][0].repeat(m[1].length); buf.push(line); continue; }
    if (inCode && m && m[1].length >= fence.length && m[1][0] === fence[0]) {
      buf.push(line); flush(true); inCode = false; fence = ""; continue;
    }
    buf.push(line);
  }
  flush(inCode);
  return out;
}

/**
 * 值不值得送去翻。
 *
 * 三条否决，每一条都是「翻了反而更糟」：
 *  · 太短（一两个词）——多半是 `None`、`bool`、参数名，翻出来是噪音；
 *  · 一个拉丁字母都没有——已经是中文/日文了，再翻一次是浪费额度还可能被改写；
 *  · 整段都是标识符、路径、类型签名这类**不该被读成句子**的东西（没有一个空格分开的词组）。
 */
export function docWorthTranslating(text) {
  const s = String(text ?? "").trim();
  if (s.length < 12) return false;
  if (!/[A-Za-z][A-Za-z'’-]*\s+[A-Za-z]/.test(s)) return false; // 连两个英文单词都凑不出
  // 已经**基本上**是中日韩了：夹几个 API 名的中文文档很常见（「把 buf 里的字段 print 出来」），
  // 光看"有没有拉丁字母"判不出来——那种句子照样有。按 CJK 占比判：三成以上就当它已经是
  // 目标语言，再翻一遍既费额度，又可能被改写成另一种说法。
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  if (cjk / s.length >= 0.3) return false;
  return true;
}

/**
 * 把翻好的段落装回去。
 *
 * `translate` 拿到一段散文、返回译文；返回空或原样都按「没翻成」处理，保留原文——
 * 悬浮说明宁可是英文，也不能因为翻译这一步而变空白。
 */
export function translateDocSegments(segments, translate) {
  const list = Array.isArray(segments) ? segments : [];
  return list.map((seg) => {
    if (!seg || seg.code || !docWorthTranslating(seg.text)) return seg?.text ?? "";
    let out = "";
    try { out = translate ? String(translate(seg.text) ?? "") : ""; } catch { out = ""; }
    return out.trim() ? out : seg.text;
  }).join("\n");
}

/**
 * 把一整段 hover markdown 翻好并原样拼回来。
 *
 * `translateBatch(texts) -> Promise<Map<原文, 译文>>` 由调用方注入。这样这个模块不碰网络、
 * 不碰 i18n，lsp-client 那边也只需要**一个**注入函数（它是被 new Function 直接跑的，
 * 多一条静态 import 就加载不了）。
 *
 * 一律不抛，翻不成就把原文还回去。
 */
export async function translateHoverMarkdown(markdown, translateBatch) {
  const src = String(markdown ?? "");
  if (!src.trim() || typeof translateBatch !== "function") return src;
  try {
    const segs = splitDocSegments(src);
    const want = segs.filter((x) => !x.code && docWorthTranslating(x.text)).map((x) => x.text);
    if (!want.length) return src;
    const map = await translateBatch(want);
    const got = map && typeof map.get === "function" ? map : new Map();
    const out = translateDocSegments(segs, (t) => got.get(t));
    return out.trim() ? out : src;
  } catch { return src; }
}
