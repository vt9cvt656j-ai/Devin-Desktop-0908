/**
 * 验收契约块 —— 把需求清单渲染成模型能对照的靶子，**按条目分来源**。
 *
 * 条目有两个来源：意图裁决声明的 successCriteria/constraints（模型算出的可观察结果），
 * 以及裁决没给时按标点切用户原话的正则兜底。两者语义完全不同，却一度共用同一份表头。
 *
 * 切出来的东西经常是**排除项**。实测：
 *   「把登录页做出来，然后 lsp 172 个报错那些属于正常的没影响，不用管」
 *     → ["把登录页做出来，", "lsp 172 个报错那些属于正常的没影响，不用管"]
 * 第二条带着「未满足的条目不得声称完成」这条硬规则，于是一句「不用管」被读成
 * 「必须做到」；收尾评审判 done=false、整轮记成 partial，而 partial 又是下一步建议
 * 和情景记忆的输入。用户侧的说法是「明明完成了用户目标却还一直揪着不放」。
 *
 * ## 来源必须按条目记，不能按轮记
 *
 * 清单是**跨轮合并**的（session._acceptanceContract 累积），而「等裁决落地」的窗口
 * 每会话只付一次 —— 第二轮起裁决常常赶不上，intentSemantic 为 null。这时若按
 * 「本轮有没有声明」记一个 run 级布尔，第一轮真正声明出来的判据会**连坐**被降级成
 * 「原话、没做到也别不敢收尾」，收尾评审还会拿到空契约。那比不分来源更糟 ——
 * 这个回归真的发生过一次，是这个模块存在的直接原因。
 *
 * `declared = null` 沿用历史语义（不知道来源就全按声明算）；两个生产调用点都显式传，
 * 有守卫钉着。
 */
// 硬约束靶子。纯复用 _extractRequirementsChecklist/_mergeRequirementsChecklist 的产出，
// 不新增模型调用；总量 ≤maxChars（默认 500 字，token 经济），装不下时保留靠前条目截断。
export function acceptanceContractBlock(checklist, maxChars = 500, { declared = null, contractOnly = false } = {}) {
  // **按条目分来源。** 裁决声明的 successCriteria/constraints 才是验收项；按标点切原话
  // 得到的常常是**排除项**：「…lsp 172 个报错那些属于正常的没影响，不用管」会被切成
  // 一条独立条目（实测），带上「未满足不得声称完成」就成了「必须做到」，收尾评审判
  // done=false、整轮记成 partial —— 用户看到的是「完成了还揪着不放」。
  //
  // 来源跟着**条目**走不跟着轮次走：清单是跨轮合并的，而等裁决的窗口每会话只付一次，
  // 第二轮起裁决常常赶不上；按轮记一个布尔的话，第一轮声明出来的判据会连坐被降级
  //（这个回归真的发生过）。`declared = null` 沿用历史语义：不知道来源就全按声明算，
  // 两个生产调用点都显式传（有守卫钉着）。
  const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const items = (Array.isArray(checklist) ? checklist : []).map(norm).filter(Boolean);
  if (!items.length) return "";
  const declaredSet = declared == null ? null : new Set((Array.isArray(declared) ? declared : []).map(norm).filter(Boolean));
  const hard = declaredSet ? items.filter((x) => declaredSet.has(x)) : items;
  const soft = declaredSet ? items.filter((x) => !declaredSet.has(x)) : [];
  // 收尾评审只该拿到硬验收项：给它一份语义相反的清单，比给空清单更糟。
  if (contractOnly) return hard.length ? contractSection(hard, maxChars, false) : "";
  const parts = [];
  if (hard.length) parts.push(contractSection(hard, maxChars, false));
  if (soft.length) parts.push(contractSection(soft, Math.max(160, Math.floor(maxChars / 2)), true));
  return parts.join("\n\n");
}

/// 渲染一段契约。`soft=true` 是「按标点切出来的用户原话」那一种：不带硬规则，
/// 而且明说里面可能是排除项 —— 否则模型会把「别动它」当成待办去做。
function contractSection(items, maxChars, soft) {
  const header = soft
    ? "【用户原话（供理解目标用，不是逐条验收项）】"
    : "【本任务验收契约（思考与收尾都对照此清单）】";
  const footer = soft
    ? "（这几条是按标点切出来的原话，**其中可能包含「不用管 / 别动 / 不影响」这类排除项**——那是约束，不是交付物。别把排除项当成待办去做，也别因为它「没完成」而不敢收尾。）"
    : "（思考开工先对照契约定靶；收尾前逐条自检，未满足的条目不得声称完成。）";
  const budget = Math.max(120, Number(maxChars) || 500) - footer.length - 1;
  let out = header;
  let n = 0;
  for (const item of items) {
    const line = `\n${n + 1}. ${item}`;
    if (out.length + line.length > budget) {
      // 至少保住第一条：一条都装不下时把它截到剩余空间，别输出空契约
      if (n === 0) out += line.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += line;
    n++;
  }
  return out + "\n" + footer;
}

export function extractRequirementsChecklist(text, maxItems = 10, maxChars = 1600) {
  const source = String(text || "").replace(/\r/g, "").trim();
  if (!source) return [];
  const normalized = source
    .replace(/\n\s*(?:[-*+\u2022]|\d+[.)\u3001])\s*/g, "\n")
    .replace(/([\u3002\uff01\uff1f\uff1b;])\s*/g, "$1\n")
    .replace(/(?:然后|还有|并且|同时|接着|另外|此外|再者)(?=[\s\uff0c,A-Za-z\u3400-\u9fff])/g, "\n");
  const out = [];
  let used = 0;
  for (const raw of normalized.split(/\n+/)) {
    const item = raw.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!item || out.includes(item)) continue;
    const remaining = Math.max(0, maxChars - used);
    if (!remaining) break;
    const bounded = item.slice(0, remaining);
    if (!bounded) break;
    out.push(bounded);
    used += bounded.length;
    if (out.length >= maxItems) break;
  }
  return out;
}

export function mergeRequirementsChecklist(existing, text, maxItems = 12, maxChars = 2000, pinned = []) {
  const normalize = (item) => String(item || "").replace(/\s+/g, " ").trim();
  const fixed = [];
  let fixedChars = 0;
  for (const item of Array.isArray(pinned) ? pinned : []) {
    const value = normalize(item);
    if (!value || fixed.includes(value) || fixed.length >= maxItems) continue;
    const remaining = maxChars - fixedChars;
    if (remaining <= 0) break;
    const bounded = value.slice(0, remaining);
    if (!bounded) break;
    fixed.push(bounded);
    fixedChars += bounded.length;
  }

  const additions = [];
  for (const item of [...(Array.isArray(existing) ? existing : []), ...extractRequirementsChecklist(text, maxItems, maxChars)]) {
    const value = normalize(item);
    if (value && !fixed.includes(value) && !additions.includes(value)) additions.push(value);
  }
  while (fixed.length + additions.length > maxItems
      || fixedChars + additions.reduce((sum, item) => sum + item.length, 0) > maxChars) additions.shift();
  return [...fixed, ...additions];
}
