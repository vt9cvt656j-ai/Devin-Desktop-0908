// 「这条错误是我这一轮弄出来的，还是仓库里本来就有的」——这道减法的判据。
//
// 收尾门只报**新增**错误，靠的是改动前先给每个文件采一份基线，之后逐条抵扣。
// 抵扣那一行原来是：
//     if (!baselineCounts || occurrence > (baselineCounts.get(identity) || 0)) fresh.push(marker);
// `|| 0` 把**两件完全不同的事**压成了同一个值：
//   · 这个文件采过基线，当时这条错误出现 0 次  → 现在出现就是真新增；
//   · 这个文件**根本没采过基线**             → 一无所知，却也被当成"当时是 0 次"。
// 后者于是让仓库存量错误整份变成"本轮新增"。用户实拍：「lsp 172 个报错…那些报错属于
// 正常的没影响」，而收尾门照着这 172 条要求继续修，任务明明已经完成。
//
// 没采过基线的来路不止一条，而且都很常见：
//   · run_worker 的 scope 允许写**目录**（系统自己教模型这么切），而基线候选按扩展名过滤，
//     "src/api" 这种条目 `split(".").pop()` 得到的不是扩展名，整条被滤掉 —— worker 写的
//     每一个文件都没有基线；
//   · 基线那一趟本身可能没跑成（语言服务器没起来、超时、语言不支持），而登记"已采过基线"
//     的那个 Set 是无条件 add 的，此后再也不会重试。
//
// 所以判据改成三态：采过且有数 / 采过是 0 / **没采过**。第三态一律不计入新增——
// 少报永远好过把存量算到模型头上，因为后者会让门一开就再也关不上。

/**
 * 这条 marker 算不算「本轮新增」。
 *
 * @param baselineCounts Map<identity, count>；null 表示**这一趟就是基线采集**，
 *                       此时全部当"新"（只用来生成基线报告，不驱动任何门）。
 * @param baselined      已经真的采到基线的文件键集合；null = 调用方没给，退回旧行为。
 * @param fileKey        当前文件的归一化键，和 baselined 里的键同一套。
 */
export function isNewMarker({ baselineCounts, baselined, fileKey, identity, occurrence }) {
  if (!baselineCounts) return true;
  if (baselined && !baselined.has(fileKey)) return false;
  return occurrence > (baselineCounts.get(identity) || 0);
}
