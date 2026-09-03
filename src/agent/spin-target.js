// 「换着工具找同一个根本不存在的东西」——这是执行事实能直接推出的结论，
// 不是一句劝诫，所以它归工具结果本身，不归事后提醒。
//
// 用户实拍的那条路径：view_image image.png 读不到 → find **/image*.png 无匹配 →
// 再换第三个工具找同一个文件。两次是**不同的调用**、各失败一次，所以按调用签名
// 计数的死循环闸一次都不响；而模型自己也不会把「两个不同工具都没找到」归纳成
// 「它不存在」——它只会归纳成「这个工具不好使，换一个」。
//
// 结论落在**第二次失败那条工具结果**里：模型读工具结果的注意力远高于读一条追加的
// 提醒，而且这是 Claude Code 的形状——工具自己把发生了什么讲清楚。

/** 这次调用冲着哪个东西去的。归一化到「去掉目录和通配符的名字」，跨工具才对得上。 */
export function spinTargetOf(call) {
  const c = call || {};
  const raw = String(c.path || c.pattern || c.query || c.name || "").trim();
  if (!raw) return "";
  const base = raw.split("/").filter(Boolean).pop() || raw;
  return base.replace(/[*?[\]]/g, "").toLowerCase().slice(0, 60);
}

/**
 * 登记一次「冲着 target 的调用失败了」，并在**第二个不同工具**也失败时返回该说的话。
 *
 * @param ledger  run 级 Map<target, Map<sig, toolName>>，跨批次累计（滑动窗口会漏）
 * @returns 该追加到这条工具结果末尾的文字；还不构成结论时返回 ""
 */
export function crossToolMissNote(ledger, { target, sig, toolName }) {
  if (!ledger || !target || !sig) return "";
  let rec = ledger.get(target);
  if (!rec) { rec = { sigs: new Map(), said: false }; ledger.set(target, rec); }
  const other = [...rec.sigs.entries()].find(([s]) => s !== sig);
  const already = rec.sigs.has(sig);
  rec.sigs.set(sig, toolName || rec.sigs.get(sig) || sig);
  // 只在**第二个不同工具第一次失败**那一刻说一次。第三个工具再来就是噪音了：
  // 结论已经给过，重复只会挤掉真正的工具输出。
  if (!other || already || rec.said) return "";
  rec.said = true;
  const otherName = other[1] || other[0];
  return `\n\n[两个不同的工具都没找到「${target}」] 本 run 里 ${otherName} 也没找到它。`
    + `两个不同的工具都找不到，通常说明**它根本不存在**，而不是工具不好使——再换第三个工具也是一样的结果。`
    + `三条路：① 它本来就该由你创建，那就直接创建；② 名字或位置记错了，回到已经确认存在的证据（列一次目录、看一眼真实文件名）重新定位；③ 确实得由用户提供，用 ask_user 一句话问清它在哪。`;
}

/**
 * 「同一个调用又拿到一模一样的结果」——同样是执行事实，同样归工具结果本身。
 *
 * 判据要**调用相同且结果也相同**：只看调用会把正当轮询（构建跑着的时候反复
 * read_terminal）判成死循环，只看结果什么都不是。这和死循环检测用的是同一套签名。
 *
 * 说的频率：第 3 次说一次，之后每 4 次（7、11…）。每次都说会把真实输出淹掉。
 */
export function repeatNote(ledger, { sig, resultSig }) {
  if (!ledger || !sig) return "";
  const key = `${sig}@${resultSig || ""}`;
  const n = (ledger.get(key) || 0) + 1;
  ledger.set(key, n);
  if (n < 3 || (n - 3) % 4 !== 0) return "";  // 3、7、11…
  return `\n\n[第 ${n} 次拿到完全相同的结果] 本 run 里这个调用已经重复到第 ${n} 次，返回的东西一个字都没变。`
    + `同样的动作不会产生新证据——退一步写清这几次共同依赖的**哪个假设错了**，换一条完全不同的路子，别再原样重试。`;
}

/**
 * 给这一批工具结果挂上「换着工具找同一个不存在的东西」的结论。
 *
 * 整段住在这里而不是 main.js：main.js 有行数闸，仓库规矩是「撞线先腾地方」。
 * 失败判据和调用签名由调用方注入 —— 那两条必须和死循环检测用的是同一套，
 * 各写一份就会漂。
 *
 * @param run       挂 run 级台账的对象（滑动窗口漏得掉跨批次的第二次失败）
 * @param items     本批工具项，每项要有 .call / .rawResult / .tc
 * @param toolMsgs  与 items 同序的工具结果消息（**就地追加**，必须在推进 messages 之前调用）
 * @param failed    (item, text) => boolean
 * @param sig       (call) => string
 * @param resultSig (text) => string   结果指纹；和死循环检测共用一套
 */
export function annotateCrossToolMisses(run, items, toolMsgs, { failed, sig, resultSig }) {
  if (!run || !Array.isArray(items)) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const msg = toolMsgs[i], it = items[i];
    if (!msg || !it?.call || it._notAttempted) continue;
    const text = String(msg.content || "");
    const callSig = sig(it.call);
    // 重复检测**不限于失败**：同一个调用反复拿到同样的成功结果，一样是空转。
    const rep = resultSig
      ? repeatNote((run._repeatLedger ||= new Map()), { sig: callSig, resultSig: resultSig(text) })
      : "";
    const miss = failed(it, text)
      ? crossToolMissNote((run._spinTargetLedger ||= new Map()), {
          target: spinTargetOf(it.call), sig: callSig, toolName: it.tc?.name || it.call.type })
      : "";
    if (rep || miss) { msg.content = text + rep + miss; n++; }
  }
  return n;
}
