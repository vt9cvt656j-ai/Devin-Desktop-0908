// 思考流的增量拼接。
//
// 搬出 main.js 的理由和别的模块一样：纯函数、只依赖参数、能在 Node 里真跑，
// 于是守卫做的是**真往返**（等价性 + 复杂度），而不是匹配源码文本。

/**
 * 把一段 reasoning delta 接到已累积的文本上，并在拼接边界补两类段落分隔。
 *
 * @param st 可选的 { tail } —— 调用方持有的「acc 末尾 8 字符」。
 *   传了它，常见路径**一次都不碰 acc**；不传则退化成自己去 slice，行为逐字相同。
 *   这不是微优化：`a + b` 在 V8 里是 O(1) 的绳索节点，而 slice / 带 `$` 的正则一碰
 *   就得先把整条绳索摊平 —— 每个 delta 一次 O(n)，而且每个 delta 调**两次**
 *   （reasoning 和 reasoningAll 两个累加器）。实测 12000 个 delta：463ms → 5.2ms。
 *   这些全是流式过程中从主线程上偷走的时间，用户感受到的就是「回复卡一下」。
 */
export function joinReasoningDelta(acc, delta, st) {
  if (!delta) return acc;
  // 两条修补规则都只发生在本次拼接边界附近——旧版每个 delta 对全量累计思考文本跑两次
  // 全文 replace，长思考就是 O(n²) 卡顿源。只重扫「旧文末尾 8 字符 + 新 delta」，语义
  // 不变（模式最长回看 5 个字符；已插入的段落分隔含空白，不会被二次命中）。
  //
  // **但只改正则还不够。** `acc.slice(...)` 本身会让 V8 把整条 cons string 摊平：
  // 拼接（`a + b`）是 O(1) 的绳索节点，而一旦 slice / 带 `$` 的正则去碰它，就得先
  // flatten 整段 —— 每个 delta 一次 O(n)，而且每个 delta 调**两次**（reasoning 和
  // reasoningAll 两个累加器）。实测：1000 个 delta 2ms，6000 个 105ms，12000 个 433ms，
  // 纯拼接全程 0.1ms。这些全是流式过程中从主线程上偷走的时间，用户感受到的就是「卡一下」。
  //
  // 所以让调用方持有那 8 个字符（st.tail）：常见路径一次都不碰 acc，只有真的要改写时
  // 才付一次 O(n)。没传 st 时退化成原来的写法，行为逐字不变。
  const tailPrev = st ? String(st.tail || "") : acc.slice(Math.max(0, acc.length - 8));
  // 分片边界恰好是段首的旧兜底：上段以字母/数字收尾、这段以「完整起句词 + 空白」开头
  const brk = tailPrev && /[A-Za-z0-9)]$/.test(tailPrev) && /^[A-Z][a-z]{2,}\s/.test(delta) ? "\n\n" : "";
  const joined = tailPrev + brk + delta;
  // **标题A****标题B** → 中间补段落分隔（行首的 **** 水平线不受影响，前面要求非空白非星号）
  // 句子收尾紧贴下一段的加粗标题：…dependencies.**Updating → 补段落分隔
  const fixed = joined
    .replace(/([^\s*])\*\*\*\*(?=[^\s*])/g, "$1**\n\n**")
    .replace(/([.!?;:。！？；：])\*\*(?=[A-Z一-鿿])/g, "$1\n\n**");
  let out;
  if (fixed === tailPrev + delta) out = acc + delta;      // 绝大多数 delta 走这条：纯拼接，不摊平
  else out = acc.slice(0, acc.length - tailPrev.length) + fixed;
  // 新尾巴从 fixed 上取（小字符串，便宜），绝不从 out 上取（那会把刚省下的摊平又做一遍）。
  if (st) st.tail = fixed.length <= 8 ? fixed : fixed.slice(fixed.length - 8);
  return out;
}
