// 从 src/main.js 抽出。判据是内聚 + 边界干净：这一族对 main.js 其余部分的引用
// 实测为零；调用点全部在族内，或经 import 显式接回。
//
// 本目录下的 import / export 必须写成**单物理行**：test/helpers/source.mjs 拼 SRC 时
// 按行过滤 `^\s*import`，多行写法只删得掉第一行，剩下的那半行会让顶层 acorn.parse
// 当场 SyntaxError —— 十几个测试文件一起在 import 期崩溃，而不是某条断言变红。

/** Classify transient failures for the single bounded pre-progress retry owner. */
export function _stripAiRetryPrefix(msg) {
  return String(msg || "").replace(/^\[(?:(?:fast|turn|tool-stream)-retry-exhausted)\]\s*/i, "").trim();
}
/**
 * 网关这一次回的 HTTP 状态码。**结构化拿，不从文案里猜。**
 *
 * `_formatAiHttpError(resp.status, …)` 拼字符串的时候手里就有这个数，可之后每一处判据
 * 都在拿正则把它从中文文案里捞回来：`_isProviderGatewayStatusError` 捞一次、
 * `_formatAgentFinalError` 再捞一次，而 `_isUnrecoverableUpstreamError` 干脆改成匹配
 * 「密钥无效 / 账户异常 / 暂无可用账号」这些**措辞**——它上面那段注释写着「判据挂在措辞上
 * 是不对的，但网关的措辞就是我们唯一能拿到的东西」。后半句不成立：状态码一直都在，
 * 只是在事件里被丢掉了。
 *
 * 代价是真实的，注释里也记着：同一个 401，网关换一句措辞就会从「配置问题」漂成
 * 「网络抖动」，用户白等三轮续传，再看到同一条错误。文案会变，状态码不会。
 *
 * 现在错误事件带着 `status` 一路传下来；这个函数只在拿不到它时（传输层断线、停滞看门狗
 * 这类根本没有 HTTP 响应的失败）才退回去解析文案。
 */
function _aiStatusFromMessage(msg) {
  const m = /ai request failed\s*\(\s*(\d{3})\b/i.exec(_stripAiRetryPrefix(msg));
  return m ? Number(m[1]) : 0;
}

/**
 * 这一次失败属于哪一类。返回空串表示「没有 HTTP 状态码可依据」，交回文案判据。
 *
 *   auth       401 —— 登录过期。清掉 token、弹登录框；重登之后可以直接接着发。
 *   payment    402 —— **用户自己**的额度用完了。给充值 / 开通路径。
 *   upstream   424 —— 上游账号问题（key 无效 / 没有可用账号 / 供应商欠费）。
 *                     这是运营侧的问题，用户重试多少次都没用，唯一有效动作是换模型。
 *   rate       429 —— 限流。独立的长退避预算，重试只会加深它。
 *   transient  5xx / 408 / 409 / 425 —— 可以重试。
 *   permanent  400 / 413 / 422 —— 请求本身有问题，原样重发必然再失败。
 */
export function _aiFailureKind(msg, status = 0) {
  // 网关自己那道并发闸的标记。**必须排在状态码判断之前**：它和上游限流同为 429，
  // 而下面的分类只看状态码，于是这道闸会被当成真限流，白等 15 秒再等 30 秒。
  //
  // 两者性质相反：真限流是上游让我们慢下来，长退避是对的、也确实在省配额；这道闸的
  // 请求**根本没发出去**，不烧任何配额，位子在用户自己那几个在跑的请求里任何一个
  // 结束时就腾出来了。所以它走普通重试那条（2 秒起步的指数退避）。
  //
  // 字面量写在函数**里面**：test/logic.test.mjs 有自己的加载器（按函数名抠出源码再
  // eval），模块级常量不在它的作用域里 —— 提出去会让那边 12 条测试一起
  // `ReferenceError`（这次改动当场撞到）。
  if (String(msg || "").includes("[gateway-inflight]")) return "gateway_busy";
  const code = Number(status) || _aiStatusFromMessage(msg);
  // 上游会把**容量**错误包在 400 + invalid_request_error 里发出来。实测原文：
  //   {"error":{"message":"请稍后重试，暂无可用渠道，或切换模型 (request id: …)",
  //             "type":"invalid_request_error"}}
  // 它自己都在说「请稍后重试」，却因为外面套着 invalid_request_error 被两边同时判成
  // 「请求写错了」：网关不换线路（`upstream rejected the request body; not failing over`），
  // 客户端也不重试。一个本该几秒后就好的容量问题，变成了用户面前的死路。
  if (code === 400 && /暂无可用|没有可用|no available channel|请稍后重试|try again later/i.test(String(msg || ""))) {
    return "transient";
  }
  switch (code) {
    case 401: return "auth";
    case 402: return "payment";
    case 424: return "upstream";
    case 429: return "rate";
    case 408: case 409: case 425:
    case 500: case 502: case 503: case 504: return "transient";
    case 400: case 413: case 422: return "permanent";
    default: return "";
  }
}

export function _isProviderGatewayStatusError(msg) {
  const raw = _stripAiRetryPrefix(msg);
  const low = raw.toLowerCase();
  return /ai request failed\s*\((?:500|502|503|504)\s+(?:bad gateway|service unavailable|gateway timeout|internal server error)\)/i.test(raw)
    || /【[^】]{1,100}】[^。\n]*(?:上游|供应商|模型线路)[^。\n]*(?:不可用|失败|暂无可用|未授权|账户异常)/.test(raw)
    || (/ai request failed\s*\(502\s+bad gateway\)/i.test(raw) && /(?:error\s*code\s*:\s*502|bad gateway|上游|供应商|线路)/i.test(raw));
}
/// 被限流（429 / rate limit / 并发过多）。
///
/// 这类错误和"网络抖动"性质完全相反：网络抖动重试一下就好，限流**重试只会让情况更糟**
/// —— 每一发都带完整上下文，既加深限流又实打实消耗配额。此前它被归进可重试集合，加上
/// 探活探针把「任何 HTTP 响应」都当成链路已恢复（退避实际为 0），内外两层重试相乘，
/// 25 秒内能对一个已经限流的网关打出 18 次全上下文请求。
export function _isRateLimitedAiError(msg, status = 0) {
  // 有确定的分类就只信它：文案匹配在这里是兜底，不是补充——两条同时生效的话，
  // 一句含「请稍后再试」的 503 文案会被误判成限流，然后白等 15 秒起步的长退避。
  const kind = _aiFailureKind(msg, status);
  if (kind) return kind === "rate";
  const raw = _stripAiRetryPrefix(msg);
  return /\b429\b|too many requests|rate.?limit|并发请求过多|请求过于频繁|过于频繁/i.test(raw);
}
/**
 * 上游的**配置性**失败：重发多少次都不会变好。
 *
 * key 无效、未授权、账户异常、没有可用账号、余额不足——这些是后台配置或账务问题，
 * 不是网络抖动。以前它们里有几条会被下面 _isRetryableAiError 的第二条正则认领
 * （"上游暂不可用（供应商未授权 / 账户异常）"、"上游暂无可用账号"），于是同一个 401，
 * 网关换个措辞就变成"可以续传"，用户白等三轮续传再看到同一条错误。
 * 判据挂在措辞上是不对的，但网关的措辞就是我们唯一能拿到的东西——那就把它认全，
 * 并且放在最前面，让它压过所有"看起来像网络问题"的词。
 */
function _isUnrecoverableUpstreamError(msg, status = 0) {
  // 401 / 402 / 424 / 400 / 413 / 422：重发都不会变好，但**原因和出路各不相同**，
  // 由 _formatAgentFinalError 按 kind 分开说。这里只回答「还要不要再发一次」。
  const kind = _aiFailureKind(msg, status);
  if (kind) return kind === "auth" || kind === "payment" || kind === "upstream" || kind === "permanent";
  const t = String(msg || "");
  return /424|Failed Dependency|密钥无效|key\s*无效|未授权|账户异常|暂无可用账号|额度不足|余额不足|欠费|无可用线路/i.test(t);
}
export function _isRetryableAiError(msg, status = 0) {
  // 有状态码 → 分类说了算。没有状态码的失败（流中途断掉、停滞看门狗、fetch 抛错）
  // 本来就没有 HTTP 响应可依据，才轮到下面那些文案判据——续传（canResume）走的正是这条路。
  const kind = _aiFailureKind(msg, status);
  // gateway_busy 和 transient 一样要重试 —— 区别只在**退避多长**：它走这条（2 秒起步），
  // 不走限流那条（15 秒起步）。判成不可重试的话，一次自家排队会被当成整轮失败。
  if (kind) return kind === "transient" || kind === "gateway_busy";
  if (_isUnrecoverableUpstreamError(msg)) return false;
  if (_isRateLimitedAiError(msg)) return false;
  if (_isProviderGatewayStatusError(msg)) return true;
  const m = String(msg || "").toLowerCase();
  // 传输层掉线的中文文案必须在这里认得出来。这条判据决定 canResume 走不走，而两种掉线
  // 以前落在相反的结论上：上游把已经 200 的响应体中途 abort（网关校验出被截断的工具参数
  // 时就是这么做的）→ 桌面端发出「连接中断（网络波动）」→ 这个正则里 network /
  // connection reset 全是英文，一个都不匹配 → 判为不可重试 → 续传那一整套机制根本不会被
  // 调用；而它的兄弟情况（干净 EOF）发的是含 "stream closed" 的英文串 → 判为可重试。
  // 同样是断线，一个能续一个不能，中间没有任何理由。用户看到的 ⚠️「重试已达到」是假的：
  // 三个续传名额一个都没花过，一次都没试。
  return /\b(408|409|425|500|502|503|504)\b/.test(m)   // 429 单独由 _isRateLimitedAiError 处理
    || /连接中断|连接提前结束|网络波动/.test(String(msg || ""))
    || /rate.?limit|too many requests|overloaded|temporar|timeout|timed out|econn|enotfound|network|connection (reset|refused|closed)|fetch failed|stream (error|closed)|server error|service unavailable|capacity|try again|超时|无有效进度|首个有效输出|没有(?:继续)?生成有效内容/.test(m);
}
export function _isCompressionPrefixInvalidError(msg) {
  return /\[mc-prefix-invalid\]/i.test(String(msg || ""));
}
export function _isStalledAiError(msg) {
  return /无有效进度|首个有效输出|连接卡住|模型长时间无响应|响应头超时|等待模型.*超时|没有(?:继续)?生成有效内容|timed out waiting for response headers/i.test(String(msg || ""));
}

export function _modelEventHasProgress(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.kind === "reasoning" || ev.kind === "token") return /\S/.test(String(ev.delta || ""));
  if (ev.kind === "toolCall") return !!String(ev.id || ev.name || ev.arguments || "");
  return false;
}

/**
 * How to resume a turn whose model stream dropped mid-output, decided from what actually happened
 * so far. Pure, so it is unit-tested without the streaming closure.
 *
 * The subtlety this encodes: a turn's tool calls normally run only after the whole turn settles,
 * but an EAGER write (write_file lands the moment its arguments finish streaming) is the exception.
 *
 *   - "stop": an eager write already executed — re-issuing that call on a fresh attempt would write
 *     the file twice. The old code bailed on *any* streamed tool call; this narrows the stop to the
 *     one genuinely unsafe case. (Folding the completed call + its result into history to continue
 *     even here is a follow-up.)
 *   - "continue": prose already reached the user → prefill it and continue. The text is not
 *     replayed (prompt-cached), and a tool call that was only half-streamed (its JSON never closed,
 *     so it never ran) is re-issued cleanly as the model keeps going.
 *   - "rerequest": NOTHING was delivered to the user and nothing executed — the drop landed during
 *     reasoning, or mid a tool call whose JSON never closed (so it never ran). Re-run the turn
 *     cleanly after a full state reset. This is the case that abandoned the round with
 *     "本轮不会重放", and with a reasoning model (long thinking phase = the widest window for a
 *     transient drop) it is BY FAR the most common one.
 *
 * A previous revision routed the reasoning-only drop to "stop", on the theory that re-requesting
 * would stack a second "思考中" card. That was wrong twice over: it turned the commonest
 * recoverable drop into an abandoned round, and the duplicate-thinking problem was already solved
 * here — the tool-arg repair retry does a full clean-slate reset (prose, reasoning, think cards,
 * write previews) before its fresh attempt. The caller does the same reset before re-requesting,
 * so a retry cannot duplicate anything.
 */
export function _streamResumeMode({ eagerExecuted, hasProse }) {
  if (eagerExecuted) return "stop";
  return hasProse ? "continue" : "rerequest";
}
