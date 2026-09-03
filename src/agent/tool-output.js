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
 *
 * `sink` 可选：形状同 `makeOverflowSink` 的返回值。给了它，被这道闸额外削掉的那部分
 * 就会落盘并在正文里给出路径——「知道被削了」和「拿得回来」是两件事，只做前一件时
 * 模型唯一的出路是重跑，而重跑正是「小 bug 修半天」的燃料。
 */
export function capTurnToolResults(messages, maxTotal = TURN_TOOL_RESULTS_MAX_CHARS, sink = null) {
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
    // 落盘出口。**这一段是必须的**：这道闸是整条链上唯一「削了却给不出取回办法」的
    // 地方——上面那句话的收尾是「分几轮调用」，而对 run_cmd 这类不可重取的工具，
    // 重跑既有副作用也会被同样削一遍，等于让模型对着中间缺一大块的内容往下猜。
    // 逐次上限那条路早就有落盘了（`_toolMsgForModel` → `_overflowSink`），偏偏被削得
    // 最狠的这条没有：十个并行读取撞上总预算时，每条都可能只剩五分之一。
    const note = typeof sink === "function" ? String(sink(orig, want, "turnclip") || "") : "";
    const room = Math.max(120, want - marker.length - note.length);
    const head = Math.max(1, Math.floor(room * 0.5));
    const tail = Math.max(1, room - head);
    out[i] = { ...list[i], content: orig.slice(0, head) + marker + orig.slice(-tail) + note };
  }
  return out;
}

/**
 * 被截断的工具结果**落盘**，让模型能把剩下的取回来。
 *
 * 投递层今天做到了「知道」——首尾预览 + 一句「原始结果共 N 字」——但做不到「拿到」：
 * 那句话的收尾是「换更窄的查询重取」，而对 run_cmd 这类**不可重取**的工具（重跑命令
 * 既不免费也有副作用，它被刻意排除在 `_REFETCHABLE` 之外）那是一句空话。模型只能对着
 * 中间缺一大块的内容往下猜、或者再跑一遍命令——后者正是「修小 bug 修半天」的燃料。
 *
 * 落盘之后那句话才兑现：正文里给出**绝对路径**，模型用 read_file（大文件配 offset/limit）
 * 取回任意一段。落在**用户自己机器的临时目录**：不经过网络，也不写进工作区
 * （`<root>/.mrdayone/` 是进版本库的，往那儿倒工具输出会污染他的仓库）。
 *
 * 目录**在启动时解析一次**注入进来，所以这个函数是纯同步的——正文必须同步返回。
 * 写是发出去就不等的：模型下一轮至少隔一次往返（实测中位 20 秒以上），文件早落定了；
 * 万一没落定，read_file 会如实报错——比假装内容还在好。
 */
export const OVERFLOW_MIN_OMITTED_CHARS = 12_000;

/** 追加到正文末尾那段话。它是整条链上**唯一**告诉模型「怎么拿到剩下的」的地方。 */
export function overflowNote(path, total, delivered) {
  return `\n\n〔完整结果已存盘〕这次结果共 ${total} 字，上面只投递了约 ${delivered} 字。`
    + `**完整内容在 ${path}** —— 用 read_file 读它，文件大就配 offset/limit 分段读。`
    + `不要为了看剩下的重跑这次调用：它可能有副作用，而且重跑一遍还会被同样截断。`;
}

/**
 * @param {{writeText:(p:string,t:string)=>unknown, dir:string, minOmitted?:number}} io
 * @returns {(raw:string, deliveredLen:number, kind:string)=>string} 要追加的正文；不落盘时空串
 */
export function makeOverflowSink(io) {
  const dir = String(io?.dir || "").replace(/[\\/]+$/, "");
  const write = io?.writeText;
  const floor = Number.isFinite(io?.minOmitted) ? io.minOmitted : OVERFLOW_MIN_OMITTED_CHARS;
  let seq = 0;
  return (raw, deliveredLen, kind) => {
    const text = String(raw ?? "");
    const delivered = Math.max(0, Number(deliveredLen) || 0);
    // 只在**真丢了一大块**时才落盘：丢几百字不值得写一个文件，而首尾预览已经把差额说清了。
    if (!dir || typeof write !== "function" || text.length - delivered < floor) return "";
    const tag = String(kind || "out").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "out";
    const path = `${dir}/tool-${String(++seq).padStart(4, "0")}-${tag}.txt`;
    try { void write(path, text); } catch { return ""; }   // 写不出去就不许承诺路径
    return overflowNote(path, text.length, delivered);
  };
}

/**
 * 从一段正文里认出落盘路径 —— `overflowNote` 写进去的那条。
 *
 * 为什么要单独拿出来：工具结果进了历史之后还会被**再改写两次**（`_trimMessagesIfHuge`
 * 的 Tier 1 折叠成一行桩、Tier 2 压到 400 字），而那句给路径的话在正文**末尾**，
 * 两次改写都会把它扔掉。结果是文件还躺在磁盘上、模型手上的指针没了 ——
 * 而它被告知的是「重新调用一次取回」，对 run_cmd 这类不可重取的工具那是一句空话。
 */
export const OVERFLOW_PATH_RE = /\*\*完整内容在 (\S+)\*\*/;

export function overflowPathOf(text) {
  const found = OVERFLOW_PATH_RE.exec(String(text ?? ""));
  return found ? found[1] : "";
}

/** 改写后的正文要把取回指针带上。原文里没有路径时原样返回（零副作用）。 */
export function withOverflowPointer(rewritten, original) {
  const path = overflowPathOf(original);
  if (!path) return rewritten;
  const text = String(rewritten ?? "");
  if (text.includes(path)) return text;          // 已经带着了就别重复贴
  return `${text}\n完整结果仍在 ${path}（用 read_file 读它，文件大就配 offset/limit）。`;
}
