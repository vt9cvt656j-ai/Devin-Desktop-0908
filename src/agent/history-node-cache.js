/**
 * 历史消息的 DOM 缓存：被裁掉的 .msg 节点整个存起来，翻回去时原样插回。
 *
 * # 为什么值得做
 *
 * 聊天区没有虚拟化、也没有节点复用：翻页时被裁的节点是**真删**，翻回来是**真重建**——
 * 每条重跑一遍 markdown 解析 + 代码高亮，一页 32 条。main.js 里那个 50ms 让路循环
 * （_RENDER_SLICE_BUDGET_MS）就是为这一坨开销存在的：它把冻结摊成了多帧，总量一点没少。
 * 把节点存下来复用等于把这一坨整个跳过，翻回去只剩 insertBefore。
 *
 * 顺带也省掉取数那一步，但那**不是**主要收益：消息数据本来就有 session._historyCache
 * 兜着（384 条 / 24MB），大多数翻页根本不发 IPC。真正的开销是渲染。
 *
 * # 为什么缓存挂在 container 上，不挂在 session 上
 *
 * 唯一的入口 `_removeRenderedHistoryMessage(message)` 只拿得到节点，而它的三个调用点里有
 * 两个写成 `.forEach(_removeRenderedHistoryMessage)` —— 给它加个 session 参数，数组下标就会
 * 被当成 session 传进来。node.parentElement 本来就是这个会话的容器，够用了。
 * 顺带还解决了生命周期：关标签时 _disposeChatSession 把 container 摘掉并置 null，缓存连同
 * 里面那批脱离文档的节点一起变成垃圾，不用另写一处清理（另写的那处迟早会漏）。
 *
 * # 三条不变量（改之前先读）
 *
 * ① **没有 transcriptSequence 的节点不进缓存。** 那是当前这一轮刚上屏、还在流式改写的
 *    消息，它没有稳定身份；存下来只会在以后某次翻页把半截内容贴回去。
 * ② **带 <video> / blob: 的节点不进缓存。** 裁剪那条路要靠 _releaseBlobMediaInNode 撤销
 *    objectURL，而那个动作会把 src 摘掉再 load()，存下来的就是一块空白播放器；反过来
 *    「存了就不撤销」也不行——视频 blob 会一直挂在内存里，比重渲染贵得多。更麻烦的是
 *    ConversationMemory 的 removalHandler 会独立地撤销同一批 objectURL，而它只在 container
 *    里找 <video> 换关键帧，找不到已经脱离文档的那个。
 *    **正因为有这条**，淘汰和作废时都不需要再释放什么：缓存里根本不存在 blob。谁要放宽
 *    上面那个 querySelector，就得同时回答「那谁来撤销」。
 * ③ **一段要么整段命中、要么一个都不取。** 见 takeHistoryNodes。
 */

/** 只给聊天会话容器做缓存。别的容器（无会话时的 chatEl）永远不会翻页，存了纯占内存。 */
const CONTAINER_CLASS = "chat-session-container";
// 64 而不是 128：两页就够（_RENDER_LIMIT 一页，上下各翻一次仍然满命中），而
// main.js:2405 那个为「1.3GB 卡死」存在的 MemGC 定时器是靠 document.querySelectorAll("*")
// 数节点的 —— 它**一个都数不到**这些脱离文档的缓存节点。也就是说这里存多少，
// 那道内存兜底就瞎多少。上限往紧了取，是因为看不见的东西不能放宽。
const MAX_NODES = 64;
// 和 main.js 里 _HISTORY_CACHE_MAX_BYTES 同一个教训：只按条数封顶挡不住内存。数据缓存那边
// 曾经 384 条悄悄钉住上百 MB，因为消息里带着 base64 截图；节点这边带着同一批 data: URL。
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * 一个节点大致占多少字节。只量内联媒体：能把内存撑爆的只有 data:/base64 那种 src，
 * 结构本身按定额算，不去遍历。
 *
 * 结果**记在节点上**。这不是为了省时间，是为了**防止计数漂移**：存进去和淘汰时各算一次，
 * 万一中间节点变了，减掉的和加上的对不上，计数器就会越漂越离谱——最后要么永不淘汰（内存
 * 白封顶），要么把缓存反复清空（复用永远不命中）。两种坏法都不报错。
 */
function nodeBytes(node) {
  const memo = Number(node?._historyNodeBytes);
  if (Number.isFinite(memo)) return memo;
  let bytes = 2048;
  let media = [];
  try { media = node.querySelectorAll("img, video, source, [poster]") || []; } catch { media = []; }
  for (const el of media) {
    try {
      bytes += String(el.getAttribute("src") || "").length;
      bytes += String(el.getAttribute("poster") || "").length;
    } catch { /* 属性读不到就按定额算：量不准可以接受，为此中断裁剪不可以 */ }
  }
  try { node._historyNodeBytes = bytes; } catch { /* 节点被冻结之类：同上 */ }
  return bytes;
}

function cacheOf(container, create = false) {
  const existing = container?._historyNodeCache;
  if (existing instanceof Map) return existing;
  if (!create || !container) return null;
  const cache = new Map();
  container._historyNodeCache = cache;
  container._historyNodeCacheBytes = 0;
  return cache;
}

/** 从缓存里摘掉一条并回补字节计数。摘掉的节点不需要释放什么，见不变量 ②。 */
function forget(container, sequence) {
  const cache = cacheOf(container);
  if (!cache || !cache.has(sequence)) return false;
  const node = cache.get(sequence);
  cache.delete(sequence);
  container._historyNodeCacheBytes =
    Math.max(0, (Number(container._historyNodeCacheBytes) || 0) - nodeBytes(node));
  return true;
}

/**
 * 把一个即将被删的历史消息节点存进缓存。返回 true 表示已收下——**收下之后调用方就不能再
 * 对它做释放类的收尾**（那会把存下来的节点弄坏）。返回 false 表示不收，走原来的删除路径。
 */
export function stashHistoryNode(node) {
  const container = node?.parentElement;
  if (!container?.classList?.contains?.(CONTAINER_CLASS)) return false;
  const sequence = Number(node?.dataset?.transcriptSequence);
  if (!Number.isFinite(sequence) || sequence < 0) return false;          // 不变量 ①
  let hasBlob = true;
  try { hasBlob = !!node.querySelector?.('video, [src^="blob:"], [poster^="blob:"]'); }
  catch { hasBlob = true; }                                              // 判不出来就当有，宁可不缓存
  if (hasBlob) return false;                                             // 不变量 ②
  const cache = cacheOf(container, true);
  forget(container, sequence);          // 同一条被重渲染过：旧节点作废，只留最新那个
  cache.set(sequence, node);            // Map 的插入顺序就是 LRU 顺序
  container._historyNodeCacheBytes = (Number(container._historyNodeCacheBytes) || 0) + nodeBytes(node);
  while (cache.size > MAX_NODES
         || ((Number(container._historyNodeCacheBytes) || 0) > MAX_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    forget(container, oldest);
  }
  return true;
}

/**
 * 取回 [from, to) 这一段的节点，**整段命中才给**，缺一条就一个都不动（返回 null）。
 *
 * 为什么是全有或全无，两个理由：
 *  · 取数那侧 _sessionHistorySlice 只能按连续区间要，缺一条也得把整页拉回来——那时候
 *    整段数据都在手上，混着复用省不下什么，却要在两条渲染路径之间来回切；
 *  · 更硬的一条：取节点必须**同步一次做完**。渲染循环每 50ms 会 await 让路，让路期间另一次
 *    翻页可能进来抢同一批节点，边取边用就会出现「取到一半没了」，而那时已经插进去半段。
 * 实际使用中这两条不损失命中率：裁掉的正好是下一次翻回去要的那一页。
 */
export function takeHistoryNodes(container, from, to) {
  const cache = cacheOf(container);
  const start = Math.trunc(Number(from));
  const end = Math.trunc(Number(to));
  if (!cache || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const taken = new Map();
  for (let sequence = start; sequence < end; sequence++) {
    const node = cache.get(sequence);
    // isConnected 为真＝这个节点还挂在文档里（不该发生：只有摘下来的才进缓存）。复用它会把
    // 它从原位搬走，当场少一条消息。当脏条目清掉，整段退回重渲染。
    if (node && node.isConnected) { forget(container, sequence); return null; }
    if (!node) return null;
    taken.set(sequence, node);
  }
  for (const sequence of taken.keys()) forget(container, sequence);
  return taken;
}

/**
 * 作废 sequence 及其之后的全部缓存节点。编辑历史消息重发时必须调。
 *
 * 比数据缓存那半更要命：数据作废了还会重新去 SQLite 取正确的，而这里存的是**成品节点**，
 * 翻回去直接贴上屏——用户会看见自己刚删掉的那几轮原封不动地回来，而且全程不发一次请求，
 * 没有任何东西有机会纠正它。
 */
export function dropHistoryNodesFrom(container, sequence) {
  const cache = cacheOf(container);
  if (!cache) return 0;
  const cut = Math.max(0, Math.trunc(Number(sequence) || 0));
  let dropped = 0;
  // 先快照 keys：forget 会在遍历过程中删条目。
  for (const key of Array.from(cache.keys())) if (key >= cut && forget(container, key)) dropped++;
  return dropped;
}
