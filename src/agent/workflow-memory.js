// 工作流（AWM 归纳出来的可复用步骤）的近义合并。从 main.js 搬出来（尺寸闸）。
//
// 2026-09-05 实测 169 条工作流里「看看这个项目是干嘛的」有四条措辞不同的副本（项目探索与远程
// 连接 / 代码库探索与分析 / 项目功能解释 / 快速了解项目内容）：名字+when 的相似度过不了 0.4，
// 但步骤几乎一样。所以步骤也算一遍；合并时留命中多的那条，命中数累加。幂等。
// 相似度函数是 main.js 的（和情景检索共用同一把尺子），由 configureWorkflowMemory 注入。
let _wmTaskSim = () => 0;
let _wmTaskWords = () => new Set();

export function configureWorkflowMemory(deps = {}) {
  if (typeof deps.taskSim === "function") _wmTaskSim = deps.taskSim;
  if (typeof deps.taskWords === "function") _wmTaskWords = deps.taskWords;
}

export function _wfDedup(wfs) {
  const out = [];
  for (const w of Array.isArray(wfs) ? wfs : []) {
    if (!w) continue;
    const i = out.findIndex((x) => _wmTaskSim(_wmTaskWords((w.name || "") + " " + (w.when || "")), (x.name || "") + " " + (x.when || "")) >= 0.4
      || _wmTaskSim(_wmTaskWords((w.steps || []).join(" ")), (x.steps || []).join(" ")) >= 0.5);
    if (i < 0) { out.push(w); continue; }
    const keep = ((w.hits || 0) + (w.uses || 0)) > ((out[i].hits || 0) + (out[i].uses || 0)) ? w : out[i];
    out[i] = { ...keep, hits: (w.hits || 0) + (out[i].hits || 0), uses: Math.max(w.uses || 0, out[i].uses || 0) };
  }
  return out;
}

/** 超上限按「被检索命中次数 + 新近度」淘汰，别按写入顺序砍：老的但一直在用的该留。结果仍按时间升序。 */
export function wfPrune(wfs, cap = 40) {
  const list = _wfDedup(wfs);
  if (list.length <= cap) return list;
  return [...list].sort((a, b) => ((b.hits || 0) - (a.hits || 0)) || String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, cap)
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}
