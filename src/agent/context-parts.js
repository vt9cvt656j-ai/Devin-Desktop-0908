/**
 * 「这些上下文是从哪来的」——按来源把一轮请求拆开。
 *
 * # 唯一的诚实做法：客户端只报自己真拼过的那几块，剩下的按差额倒推并说明白
 *
 * 走网关那条线（L0，也是默认线）时，客户端拼好的系统提示词会被**整条丢掉**，
 * 内置工具的 schema 也不进请求体（只把工具名放在 HTTP 头里），两者都由网关注入。
 * 也就是说：客户端手里根本没有那份文本，量不到它的体积。
 *
 * 所以分两类：
 *  · **量得到的**——用户规则、技能、语言/自适应/鉴权块、MCP 与用户声明工具的 schema、
 *    对话历史。这些是客户端自己拼的字符串，逐块估 token。
 *  · **量不到的**——网关注入的系统提示词 + 内置工具定义。它不猜，按
 *    「上游报的真实读数 − 量得到的那些」倒推，并在标签上写明这是倒推出来的。
 *
 * 三条不许越的线：
 *  ① 上游还没报过读数就什么都不显示（没有分母，倒推没有意义）；
 *  ② 倒推为负说明估算偏大，如实说，不显示一个负数、也不悄悄归零；
 *  ③ 非网关线路（自定义端点）上系统提示词和工具 schema 确实在客户端，那就直接量，
 *    但发布版把内置工具的**描述**剥空了，那一项只能算下限，得标注。
 *
 * 纯函数：数从参数进，不碰 DOM、不读全局。
 */

function short(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, "") + "K";
  return (v / 1000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/**
 * @param parts  [{ key, label, tokens }] 客户端真量到的那几块（tokens 是估算）
 * @param total  上游报的这一轮输入 token（真数）；<=0 表示还没报过
 * @param l0     是否走网关线（系统提示词与内置工具由网关注入）
 * @param toolsStripped 发布版是否剥空了内置工具描述（影响非网关线路那一项的标注）
 */
export function contextPartsView(opts) {
  // 解构的默认值只兜 undefined，兜不住 null——而这一层挂在点击路径上，调用方一次取空
  // 就会在用户按下去的那一刻抛出来。
  const { parts = [], total = 0, l0 = true } = opts || {};
  const list = (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.key && Math.round(Number(p.tokens) || 0) > 0)
    .map((p) => ({ key: String(p.key), label: String(p.label || p.key), tokens: Math.round(Number(p.tokens) || 0) }));
  const known = list.reduce((n, p) => n + p.tokens, 0);
  const real = Math.max(0, Math.round(Number(total) || 0));

  // 没有真数就整段不显示：倒推没有分母，剩下的只是一堆估算，摆出来会被当成真的。
  if (real <= 0) return { pending: true, rows: [], known, real: 0 };

  const rows = list.map((p) => ({ ...p, text: short(p.tokens), estimated: true }));
  const residual = real - known;
  /*
   * 走网关时，客户端拼的系统提示词会被整条替换、内置工具只发名字——那两样的**体积**
   * 客户端量不到。所以按「上游真实读数 − 客户端各块」倒推，并把这件事写进**标签本身**
   * （「· 网关组装」），而不是在面板下面另起一段说明：用户点名删掉了那几行注解，
   * 而出处不能跟着一起消失。
   *
   * 倒推为负说明客户端估大了，那就不画这一行——一个负数或者一个抹平成 0 的数，
   * 比没有这一行更糟。
   */
  if (l0 && residual > 0) {
    rows.push({
      key: "gateway",
      label: "系统提示词 + 工具定义 · 网关组装",
      tokens: residual,
      text: short(residual),
      estimated: false,
    });
  }
  return { pending: false, rows, known, real };
}
