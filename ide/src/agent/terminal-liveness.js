/**
 * 终端里的**命令**是不是还在跑 —— 和 shell 是不是还活着，是两件事。
 *
 * ## 在这之前只有一件事
 *
 * 全系统判断「这个终端还活着吗」只有一个字段：`entry.exited`。而它只在 PTY 读到 EOF
 * （也就是 **shell 自己退出**）时才置位。可 `run_in_terminal` 是把命令写进一个交互式
 * 登录 shell（`-i -l`）—— 命令崩了、被 Ctrl-C、端口被占用退出，shell 照样活着，
 * EOF 永远不来。
 *
 * 于是**任务终端的 `exited` 结构上恒为 false**，一口气把五处机制打哑：
 *
 * 1. 每轮环境块里「已退出的终端贴最后 600 字输出」那一支永不触发 —— 模型永远拿不到
 *    崩溃现场，只能等到自己想起来去 read_terminal；
 * 2. `_reapExitedAgentTerminals` 的 `if (!t.exited) continue` 永不放行，页签无限堆积；
 * 3. background_monitor 的「生产者已停就别空等」永不命中，只能等满整个超时；
 * 4. 终端复用永远走不到「已结束 → 原地重跑」，同一个任务的第二次调用一律拿到
 *    `alreadyRunning` —— 模型以为上一次还在跑，转头去轮询空等；
 * 5. `read_terminal` / `list_terminals` 一律报「运行中」。
 *
 * 用户的说法是「终端被关闭半天了、做了一大会才发现」。不是发现得晚，是结构上根本
 * 没有发现的通道。
 *
 * ## 真值来源本来就有
 *
 * `term_running_ids` 比对 PTY 的**前台进程组**和 shell 自己的 pid，不相等就说明有命令
 * 在跑。它每 900ms 采一次，而此前只喂给了一个 CSS class。
 *
 * **Windows 上拿不到这个信号**（ConPTY 没有前台进程组）。这里要极其小心：**「拿不到」和
 * 「没有命令在跑」必须是两个不同的值**。原来 windows 分支返回空表 `Vec::new()`，而空表在
 * 这条判据里的含义是"一个都没在跑" —— 过了宽限期，Windows 上**每一条命令**都会被判
 * 「已结束」：健康的 dev server 起来 1.9 秒后就被当成结束，终端复用那条随即"原地重跑"
 * 往同一个 PTY 里再写一条命令。（同一个坑在非 Windows 上也有：`state.inner.lock()` 失败
 * 时同样返回空表。）
 *
 * 所以信号改成 `Option<Vec<u32>>`：拿不到是 `null`，拿到了但没命令在跑才是 `[]`。
 * 本函数收到 null/undefined 一个字段都不动 —— 失败关闭。
 *
 * ## 为什么要宽限期
 *
 * 前台进程组的切换不是瞬时的：命令刚写进去那一下，前台组可能还是 shell 自己。不设
 * 宽限期的话，**每一条命令都会先被误报一次「已结束」**。两个轮询周期足够任何真实命令
 * 把前台组抢过去；而真的在 1.8 秒内就跑完的命令，靠的是「过了宽限期仍没在跑」这一支
 * —— 两条判据合起来，快命令和慢启动都答得对。
 */

/** 起跑后多久之内不下「已结束」的结论。调用方按自己的轮询周期传。 */
export const CMD_START_GRACE_POLLS = 2;

/**
 * 一条命令刚被写进这个终端：清掉上一条的结局，重新开始观测。
 *
 * `entry` 原地改（调用方持有的就是那个 tab 对象）。
 */
export function markCommandStarted(entry, now = Date.now()) {
  if (!entry) return entry;
  entry.cmdStartedAt = now;
  entry.cmdEndedAt = 0;
  entry.cmdSeenRunning = false;
  entry.cmdRunning = false;
  return entry;
}

/**
 * 这个终端里**智能体发出的那条命令**是不是已经结束了（跑完还是崩了都算）。
 *
 * 注意它和 `entry.exited` 互不蕴含：shell 还活着时 `exited` 仍然是 false。
 */
export function commandEnded(entry) {
  return !!(entry && entry.cmdStartedAt && entry.cmdEndedAt && entry.cmdEndedAt >= entry.cmdStartedAt);
}

/** 还有没有命令在等结局。有的话轮询不许停，哪怕终端面板已经收起来了。 */
export function anyCommandPending(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((t) => t && t.backendId != null && t.cmdStartedAt && !t.cmdEndedAt);
}

/**
 * 拿一次轮询结果更新所有终端的命令存活，并检出「跑过 → 停了」的跃迁。
 *
 * 返回这一次**新判定为已结束**的条目，方便调用方决定要不要立刻刷新哪块 UI/上下文。
 */
export function applyRunningPoll(entries, runningIds, { now = Date.now(), graceMs = 1800 } = {}) {
  // 「拿不到」和「没有在跑」必须分开。null/undefined = 平台报不了（Windows）或这次没采到
  // （锁失败）—— 一个字段都不许动，否则每条命令都会被误判成已结束。空数组才是"真的没有"。
  if (runningIds == null) return [];
  const running = runningIds instanceof Set ? runningIds : new Set(Array.isArray(runningIds) ? runningIds : []);
  const justEnded = [];
  for (const t of Array.isArray(entries) ? entries : []) {
    if (!t || t.backendId == null) continue;
    if (running.has(t.backendId)) {
      t.cmdRunning = true;
      t.cmdSeenRunning = true;
      // 又有命令在跑了（同一个终端被复用、或者用户自己敲了一条）：上一条的结局作废。
      t.cmdEndedAt = 0;
      continue;
    }
    t.cmdRunning = false;
    // 「没在跑」≠「已结束」：得先有一条命令被发出去过，而且要么我们真的见过它在跑，
    // 要么已经过了宽限期。少这一条的话，还没抢到前台组的命令会被当场误报结束。
    if (!t.cmdStartedAt || t.cmdEndedAt) continue;
    if (t.cmdSeenRunning || now - t.cmdStartedAt >= graceMs) {
      t.cmdEndedAt = now;
      justEnded.push(t);
    }
  }
  return justEnded;
}
