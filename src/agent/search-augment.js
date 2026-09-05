// `search`（仓内文本检索）的两条增强，纯函数：给检索结果**附加**东西，不改它。
//
// 为什么挂在 search 上而不是让模型去用 semantic_search / find_symbol：
// 2026-09-05 网关 30 天读数：search 1543 次、find_files 376 次，而 semantic_search 2 次、
// find_symbol 4 次 —— 两个索引就在同一个页面里，模型几乎从不伸手（它们不在开局窗口，
// 场景直觉表也只提一句）。与其教模型换工具，不如让它已经在用的那把工具在两种情形下自己接上：
//   ① 零命中：文本没搜到，按语义相近的位置给几处 —— 模型第二次就不用换词瞎猜；
//   ② 查的是一个标识符：符号索引里有定义就直接附上（file:line + 签名），省一次 find_symbol。
// 两条都只**附加**，标注来源和"不是精确匹配"，不替换正文；索引没就绪就什么都不加。
export const IDENT_RE = /^[A-Za-z_$][\w$]{2,}$/;

export function looksLikeIdentifier(q) {
  return IDENT_RE.test(String(q || "").trim());
}

/**
 * @param {{ query: string, totalHits: number, symbolHits?: Array<{kind?:string,path:string,line:number,sig?:string}>, semanticHits?: Array<{path:string,start:number,end:number,score:number,snippet:string}>, symbolIndexReady?: boolean, semanticIndexReady?: boolean }} p
 * @returns {string} 追加在检索结果后面的文本；没什么可加就是空串
 */
export function augmentSearchResult(p) {
  const q = String(p?.query || "").trim();
  const parts = [];
  const sym = Array.isArray(p?.symbolHits) ? p.symbolHits.filter((h) => h && h.path) : [];
  if (looksLikeIdentifier(q) && sym.length) {
    const lines = sym.slice(0, 8).map((h) => `[${h.kind || "?"}] ${h.path}:${h.line}    ${String(h.sig || "").slice(0, 120)}`);
    parts.push(`🔎 符号索引里「${q}」的定义（find_symbol 同一份索引，共 ${sym.length} 处${sym.length > 8 ? "，只列前 8" : ""}）：\n${lines.join("\n")}`);
  }
  const total = Math.max(0, Number(p?.totalHits) || 0);
  const sem = Array.isArray(p?.semanticHits) ? p.semanticHits.filter((h) => h && h.path) : [];
  if (total === 0 && sem.length) {
    const lines = sem.slice(0, 5).map((h, i) => `[${i + 1}] ${h.path}:${h.start}-${h.end} (score=${Number(h.score || 0).toFixed(2)})\n${String(h.snippet || "").replace(/\s+/g, " ").slice(0, 200)}`);
    parts.push(`文本没命中；按**语义**相近的位置（semantic_search 同一份索引，供定位参考，不是精确匹配，读过再下结论）：\n${lines.join("\n")}`);
  } else if (total === 0 && p?.semanticIndexReady === false) {
    parts.push("（语义索引还没建好，这次没法按语义兜底；下次零命中时会有。）");
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
