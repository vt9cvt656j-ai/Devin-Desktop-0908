/**
 * run._writeLedger 的读法。
 *
 * 账本是**顺序追加、整 run 不剪枝**的：一个文件写失败、下一轮重试成功，两条都留在
 * 账上。所以「哪些文件此刻没落盘」只能**按 path 取最后一条**，不能 filter(ok === false)
 * ——后者会把已经补救成功的也算进去。
 *
 * 这件事踩过一次：收尾门（run._incompleteReason）一直是对的，而喂给模型的
 * _deliveryFactsLine 用的是 filter，于是重试成功之后**每一轮**还在告诉模型
 * 「src/api/invoices.ts 此刻不在磁盘上，不要说它已保存」。模型要么把刚写对的文件
 * 从头再整篇写一遍覆盖掉，要么收尾对用户说「没能保存成功，请手动检查」，而文件
 * 好好躺在磁盘上。两个消费方读同一本账，判据只能有一个——就是这里。
 *
 * `a.ok === true` 是严格的：只有明确记成功才算落盘，undefined / 缺字段一律当没落盘。
 * 沿用收尾门原本的写法，别放宽——放宽的方向是「谎报已保存」。
 */
export function failedWritePaths(ledger) {
  const last = new Map();
  for (const a of (Array.isArray(ledger) ? ledger : [])) if (a?.path) last.set(String(a.path), a.ok === true);
  return [...last].filter(([, ok]) => !ok).map(([path]) => path).filter(Boolean);
}

/** 会往工作区落盘的那三类工具。判据集中在这里，别在调用点各写一份。 */
const WRITE_TOOL_TYPES = new Set(["write", "edit", "multiedit"]);

/**
 * 判断一次工具调用要不要记进写入账本，以及记成成功还是失败。
 *
 * **抽出来的动机是记账时刻，不是整洁。** 原来这个判据长在「整批工具跑完之后」那个大记账
 * 循环里，而它在「批次中途按停」那条 break 的**下面 466 行**。于是：模型一批发出
 * [edit_file A, run_cmd npm test]（修改类是硬屏障、串行），A 真的落了盘，用户在 npm test
 * 跑着的时候点停 —— A 在磁盘上，`run._writeLedger` 却一条都没有。
 * 后果不是少一条日志：`run._breakWriteFact` 因此为空，`session._lastRunState` 里没有它，
 * 下一轮模型读到「本次运行还没有任何文件落盘」，于是**从头整份重写**。
 * 这就是「中断之后说继续，它还是从头来」剩下的那条腿。
 *
 * 判据逐字沿用原处，包括三个排除项，每一个都有事故背书：
 *  - `eager`：流式那条钩子已经记过了，再记一笔会把 writes_failed 吹大一倍；
 *  - `skipped`：压根没派发；
 *  - `notAttempted`：补空洞那段只写了「[未执行]」消息、没写 rawResult，而
 *    `attempted(undefined)` 是 true —— 一次根本没发生的写入会以「写失败」进账，
 *    把每轮喂给模型的交付事实和收尾的 writes_failed 一起带偏。
 *
 * @returns `{ path, ok }` 表示要记一笔；`null` 表示这一项不进账。
 */
export function writeAttemptEntry({ type, path, ok, attempted, eager = false, skipped = false, notAttempted = false } = {}) {
  if (eager || skipped || notAttempted) return null;
  if (!WRITE_TOOL_TYPES.has(String(type || ""))) return null;
  if (!path || !attempted) return null;
  return { path, ok: ok === true };
}
