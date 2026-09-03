/**
 * 一轮工具调用的执行顺序，以及**出错时不许炸掉整个 run**。
 *
 * 段键语义（和搬过来之前逐字一致）：
 *   falsy       = 硬屏障，串行执行
 *   相同 truthy = **连续**的这几项组成一段并行执行
 * 这让「读工具段」和「worker 段」各自并行、互不混段 —— worker 会改文件，绝不能和同轮的
 * 读工具并跑（否则读到半成品）；不同 worker 之间由 scope 互不重叠守卫保证安全。
 *
 * **为什么要有 onItemError（这才是搬出来的真正动机）**：
 * 搬过来之前，`execute` 里任何一次没被包住的 await 抛出，都会穿过 `Promise.all` 一路炸出
 * 外层 `for (let iter …)` 整个智能体循环。抛出那一刻，messages 里有一条**带 tool_calls 的
 * assistant 消息**和**零条工具结果** —— 转录当场不合法（下一次请求会被上游拒），
 * 而用户看到的是一句原生 JS 报错。
 *
 * 现在：每一项各自 try 住，并行段用 allSettled；失败的那项由调用方通过 onItemError 落一条
 * 如实的失败结果。于是「一个工具炸了」退化成「这个工具失败了」——模型下一轮能看见、能应对，
 * 而不是整轮凭空消失。这也正是 main.js 里那段 `[未执行]` 兜底本来想达到的状态
 * （它今天挂在一条走不到的分支上，因为异常根本到不了那里）。
 *
 * @param items          本轮要跑的项
 * @param segmentKeyOf   (item, index) → 段键
 * @param execute        (item, index) → Promise，允许抛
 * @param isLive         () → boolean，false 时停止推进（用户按了停）
 * @param onItemError    (item, index, error) → void，**必须**为这一项落一条结果；
 *                       省略时异常被吞掉（保持"不炸循环"），但转录会缺一条结果 ——
 *                       所以正常调用点一律要传。
 */
export async function runOrderedToolSegments(items, segmentKeyOf, execute, isLive = () => true, onItemError = null) {
  const runOne = async (item, index) => {
    try {
      await execute(item, index);
    } catch (error) {
      // 兜底自己再抛就前功尽弃了：那条异常会原样穿回 allSettled 之外。
      if (onItemError) { try { onItemError(item, index, error); } catch { /* 记账失败不许升级成致命 */ } }
    }
  };
  for (let index = 0; index < items.length && isLive();) {
    const key = segmentKeyOf(items[index], index);
    if (!key) {
      await runOne(items[index], index);
      index++;
      continue;
    }
    let end = index;
    const segment = [];
    while (end < items.length && segmentKeyOf(items[end], end) === key) {
      const current = end++;
      segment.push(runOne(items[current], current));
    }
    // runOne 自己不会 reject，这里用 allSettled 是第二层保险：将来有人在 runOne 之外
    // 往 segment 里塞 promise 时，Promise.all 会让整段的第一个 reject 吃掉其余全部结果。
    await Promise.allSettled(segment);
    index = end;
  }
}
