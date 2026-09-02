/**
 * 工具结果投递给模型之前的**保真**处理。
 *
 * 这个模块只回答一个问题：**模型手上这段文本，和真实发生的事差多少，它知不知道。**
 * 凡是裁剪，必须当场说清裁了多少、为什么裁、以及怎么拿到剩下的——静默截断会让模型
 * 把「前 2000 字里没有报错」读成「这条命令成功了」，那是本仓库最贵的一类假事实。
 *
 * **单条结果的裁剪不在这里。** 那套机器（`_clipPreservingErrors` → `_headTailModelText`，
 * 带「错误关键行从被省略的中段豁免捞回」）已经在 main.js 里，而且比首尾预览更强；
 * 这里只补它管不到的那一层：**一轮里有几条**。
 *
 * 纯函数，无 DOM、无 IO。放这里而不是 main.js：一来 main.js 的行数闸只剩个位数余量，
 * 二来这些判据全都能在 Node 里做真往返，比在 8 万行里靠源码正则守它强得多。
 */

/**
 * 单轮里**所有**工具结果加起来的字符预算。
 *
 * 逐次上限（`_toolMsgForModel` 的 60000 / 30000 / 8000）管的是「一个工具能有多大」，
 * 管不住「一轮里有几个」：`_runOrderedToolSegments` 对同段键的连续项直接 `Promise.all`，
 * 段长没有任何计数或字节闸，10 个并行 read 就是 600,000 字进一轮上下文。上游只剩两道
 * 数量级之外的兜底（整条 transcript 10M、请求体 3.5MB），600,000 两道都过。
 */
export const TURN_TOOL_RESULTS_MAX_CHARS = 200_000;

/** 每条结果无论如何都要留下的字符数——宁可整轮略超，也绝不让某一条被压成空。 */
export const PER_RESULT_FLOOR = 1_200;

/**
 * 最大-最小公平灌水：给定每条的实际长度，算出每条允许多少。
 *
 * **与顺序无关、结果唯一、零语义判断。** 反复取「剩余预算 ÷ 剩余条数」当公平份额：
 * 比份额短的原样保留并把富余让出去，剩下的平分。
 *
 * 为什么不是「从最长的开始削」——那个贪心看着合理，实测是灾难：10 条各 60,000、预算
 * 200,000 时，它会把前六条一路削到地板（600 字），第七条削一半，后三条**一字不动**。
 * 六份证据被毁、三份完好，而公平灌水给的是每条 20,000。差别不在总量，在**每一条还剩
 * 多少可用信息**，而这正是这道闸唯一的目的。
 */
export function allocateTurnResultBudget(
  sizes,
  cap = TURN_TOOL_RESULTS_MAX_CHARS,
  floor = PER_RESULT_FLOOR,
) {
  const n = sizes.length;
  if (!n) return [];
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= cap) return sizes.slice();           // 没超就完全隐形，一个字节都不动

  const alloc = new Array(n).fill(null);
  let leftCap = cap;
  let left = n;
  for (;;) {
    if (left <= 0) break;
    const share = leftCap / left;
    let settled = false;
    for (let i = 0; i < n; i++) {
      if (alloc[i] !== null || sizes[i] > share) continue;
      alloc[i] = sizes[i];                          // 本来就比份额短：原样留，富余让出去
      leftCap -= sizes[i];
      left--;
      settled = true;
    }
    if (!settled) {                                 // 剩下的都比份额长 → 平分
      const even = Math.max(0, Math.floor(leftCap / left));
      for (let i = 0; i < n; i++) if (alloc[i] === null) alloc[i] = even;
      break;
    }
  }
  // 地板兜底：算下来低于地板的抬回地板。这会让总量略微超过 cap——**这是刻意的**，
  // 「模型以为它看到了全部」正是这一整组要治的病，把一条结果压成空是同一个病的更重形态。
  return alloc.map((v, i) => Math.min(sizes[i], Math.max(Number(v) || 0, Math.min(sizes[i], floor))));
}

/**
 * 把一轮里所有工具结果压进总预算。
 *
 * · **绝不整条丢弃。** 少一条 tool 结果，模型看到自己调了工具却没有任何结果反驳它，
 *   于是默认成功。
 * · **削了就说，且说清是「这一轮工具太多」**，不是这个工具自己的上限——两种原因的
 *   下一步动作完全不同（前者该分几轮调用，后者该收窄这一次的范围）。
 *
 * 只改 `role === "tool"` 且正文是字符串的消息；没超预算时返回**原数组本身**。
 */
export function capTurnToolResults(messages, maxTotal = TURN_TOOL_RESULTS_MAX_CHARS) {
  const list = Array.isArray(messages) ? messages : [];
  const idx = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === "tool" && typeof m.content === "string") idx.push(i);
  }
  if (!idx.length) return list;

  const sizes = idx.map((i) => list[i].content.length);
  const cap = Math.max(PER_RESULT_FLOOR, Math.floor(Number(maxTotal) || TURN_TOOL_RESULTS_MAX_CHARS));
  if (sizes.reduce((a, b) => a + b, 0) <= cap) return list;

  const alloc = allocateTurnResultBudget(sizes, cap);
  const out = list.slice();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const orig = list[i].content;
    const want = alloc[k];
    if (want >= orig.length) continue;
    const marker =
      `\n…（⚠️ 这一轮的工具结果加起来超过了单轮上限，所以**这一条被额外削短了**：`
      + `它原本 ${orig.length} 字，这里只保留约 ${want} 字的开头和结尾。`
      + `这不是这个工具自己的截断——是你这一轮同时发了太多工具。`
      + `需要完整内容就**分几轮调用**，或者把范围收窄后单独再取一次。）…\n`;
    const room = Math.max(120, want - marker.length);
    const head = Math.max(1, Math.floor(room * 0.5));
    const tail = Math.max(1, room - head);
    out[i] = { ...list[i], content: orig.slice(0, head) + marker + orig.slice(-tail) };
  }
  return out;
}
