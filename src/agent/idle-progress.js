/**
 * 空转断路器的**进展度量**。
 *
 * 断路器本身（连续 N 轮没进展就如实收尾）在 main.js 的主循环里。这里只回答一件事：
 * **「这一轮到底有没有发生什么」**——而这个判断此前有两个方向相反的错，两个都真实发生：
 *
 * ## 一、拦不住：产出可以由模型自己声明出来
 *
 * `_toolMutatesWorkspace` 对 run_cmd / run_in_terminal 的判据是
 * `_fsDelta === true`（文件监视器观测到的事实）**或** `call.purpose ∈ {mutate, scaffold, install}`。
 * 而 `purpose` 是模型自己填进参数里的，没有任何执行事实校验。于是最常见的那种卡死——
 * 一轮一轮重跑 `npm install`，每轮都自称在装依赖——每轮都记一次产出、每轮把空转计数清零，
 * 断路器**在它自己的目标场景里永远不触发**。
 *
 * 判据不是「不许信声明」。声明本来就是这套架构的判断来源，问题在于这里**有事实可核**：
 * 监视器已经在报了。所以规则是「**事实压过声明，但只在事实确实存在的时候**」——
 * 监视器在这个 run 里证明过自己能报（至少报出过一次真实变化）之后，它说「一个文件都没动」
 * 才压过声明；证明之前一律信声明。宁可漏拦，绝不误杀正在干活的 run。
 *
 * ## 二、会误杀：进展的度量自己会往下掉
 *
 * 原来的度量是 `_implOps + _runtimeEffects.size + _externalEffects.size + 新证据数`，
 * 拿它和一条**只升不降的水位线**比。但 `_runtimeEffects` 会在每次 `_implOps++` 的同时被
 * **故意**删掉 build/test/run/package 四类（验证凭据随产物过期，这是对的，属于另一件事）。
 * 于是「改一次代码」这一轮的净变化可能是 **-3**：水位线不升，反倒记一次空转。
 * 「改代码 → 跑测试 → 改代码」这种最正常的节奏，连着几轮会被算成原地打转。
 *
 * 修法是把两个用途分开：验证凭据该过期照样过期，而**进展只增不减**——这里的两个集合
 * 只添不删，所以拿水位线比就退化成了「这一轮有没有新东西」，也正是注释一直说它要的判据。
 *
 * 纯函数、无 DOM、无 IO，能在 Node 里做真往返，比在八万行里靠源码正则守它强得多。
 */

/**
 * 一次 run 的进展账本。
 *
 * @returns {{
 *   noteRuntimeKind: (kind: string) => void,
 *   noteExternalKind: (kind: string) => void,
 *   noteFsFact: (fsDelta: unknown) => void,
 *   noteImplOp: (opts?: {cmdLike?: boolean, fsDelta?: unknown}) => boolean,
 *   total: (novelEvidenceCount?: number) => number,
 *   watcherProven: () => boolean,
 * }}
 */
export function createProgressLedger() {
  // 只添不删——和 main.js 里那两个会被清空的集合是**不同的用途**，故意各存一份。
  const runtimeKinds = new Set();
  const externalKinds = new Set();
  let implOps = 0;
  let watcherProven = false;

  /** 监视器报过一次真实变化 → 从此它说「没变」就有分量。 */
  const noteFsFact = (fsDelta) => { if (fsDelta === true) watcherProven = true; };

  return {
    noteRuntimeKind: (kind) => { if (kind) runtimeKinds.add(String(kind)); },
    noteExternalKind: (kind) => { if (kind) externalKinds.add(String(kind)); },
    noteFsFact,
    /**
     * 记一次「产出」。返回它算不算进展。
     *
     * `cmdLike`：这是不是 run_cmd / run_in_terminal（它们的「改了工作区」可能只来自声明）。
     * `fsDelta`：`true` 监视器看到变化；`false` 监视器明确没看到；`undefined` 没有观测。
     */
    noteImplOp: ({ cmdLike = false, fsDelta } = {}) => {
      noteFsFact(fsDelta);
      // 非命令类工具（write/edit/…）本身就是执行事实，不需要再核。
      // 命令类：监视器证明过自己之后，「没看到变化」压过模型的自我声明。
      const counted = !cmdLike || fsDelta === true || !watcherProven;
      if (counted) implOps++;
      return counted;
    },
    total: (novelEvidenceCount = 0) =>
      implOps + runtimeKinds.size + externalKinds.size + Math.max(0, Number(novelEvidenceCount) || 0),
    watcherProven: () => watcherProven,
  };
}
