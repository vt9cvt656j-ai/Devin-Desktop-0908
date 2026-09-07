// 请求预算：一份请求体发出去之前压到网关/代理的字节上限之下；上下文真溢出时的最后手段。
//
//   · _enforceModelRequestBudget —— 在**请求专用副本**上按优先级裁：历史 write/edit 的大参数先
//     换成保留 path 的摘要桩 → 旧媒体帧 → 最新媒体帧的后续帧 → 旧的长文本（📌 请求边界整段保住，
//     最新一条带报错的工具结果豁免）→ 最后才动最新一条的前置上下文。仍超限就抛
//     MODEL_REQUEST_TOO_LARGE：413 对这一轮是终态，不会拿第二份转录本重放。
//   · _squeezeMessagesForContext —— 上游报 context_length_exceeded 之后在 messages **本体**上硬挤压
//     （幂等；压完由调用方 sync 读取覆盖账本）。
//   · _REQUEST_MARKERS —— 网关认的两种请求边界标记（英文是本版发出的，中文是改写提示词之前
//     存下来的会话里还有的）。要和 server/src/prompts.rs 的 USER_REQUEST_MARKER 同步。
// 从 main.js 原样搬出，一行逻辑没改。
import { _clipPreservingErrors, _hasErrorLine } from "./model-text.js";

// Every request-boundary marker the gateway recognizes: the English one this build emits, plus
// the Chinese spelling still present in conversations stored before the prompt rewrite. Keep in
// sync with USER_REQUEST_MARKER / LEGACY_CN_USER_REQUEST_MARKER in server/src/prompts.rs.
export const _REQUEST_MARKERS = ["📌 **This turn's user request**: ", "📌 **用户本次请求**："];

// Keep each request comfortably below the gateway/proxy body ceiling. The request is
// prepared before it is sent; a 413 is terminal for this user turn and is never replayed
// with a second copy of the transcript.
export const _MODEL_REQUEST_BODY_BYTE_CAP = 3_500_000;
/// Reused across turns: constructing a TextEncoder per measurement would undo the saving.
let _requestByteEncoder = null;
export function _enforceModelRequestBudget(messages, tools = [], byteCap = _MODEL_REQUEST_BODY_BYTE_CAP) {
  const source = Array.isArray(messages) ? messages : [];
  const prepared = source.map((message) => ({
    ...message,
    ...(Array.isArray(message?.content) ? { content: message.content.map((part) => ({ ...part, ...(part?.image_url ? { image_url: { ...part.image_url } } : {}) })) } : {}),
    ...(Array.isArray(message?.tool_calls) ? {
      tool_calls: message.tool_calls.map((call) => ({
        ...call,
        ...(call?.function ? { function: { ...call.function } } : {}),
      })),
    } : {}),
  }));
  const requestTools = Array.isArray(tools) ? tools : [];
  const cap = Math.max(1024, Number(byteCap) || 0);
  const byteLength = (value) => {
    const json = JSON.stringify(value);
    // TextEncoder is native and ~4x faster than walking the string in JS; the manual
    // fallback keeps this working anywhere it is missing. Both agree exactly.
    if (typeof TextEncoder === "function") {
      try { return (_requestByteEncoder ||= new TextEncoder()).encode(json).length; } catch {}
    }
    let bytes = 0;
    for (let index = 0; index < json.length; index++) {
      const code = json.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length
        && json.charCodeAt(index + 1) >= 0xdc00 && json.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    }
    return bytes;
  };
  // ── Measure once per message, not once per request ─────────────────────────
  //
  // `requestBytes()` used to JSON.stringify the ENTIRE request — every message, every
  // write_file body — and then walk the result character by character. It is called from
  // EIGHT places here, several of them inside trim loops, so a long run paid O(n²): each of
  // N oversized historical tool calls re-measured all N messages again.
  //
  // Measured on a realistic transcript (120 write_file calls of ~30KB, a 3.6MB request)
  // that is ~0.7s of BLOCKED main thread per model turn — and it runs during request
  // PREPARATION, before a single token streams back. That is the "software freezes and sits
  // on the loading spinner" report: the spinner is up, the turn has not started, and the
  // main thread is busy re-measuring megabytes it already measured.
  //
  // Every trim site below except the historical-argument loop REPLACES `prepared[i]` with a
  // fresh object, so object identity is a sound cache key: a rewritten message misses the
  // cache and is re-measured, untouched messages cost nothing. The single in-place mutation
  // invalidates its own entry explicitly.
  const _sizeCache = new WeakMap();
  const msgBytes = (message) => {
    if (!message || typeof message !== "object") return byteLength(message);
    const cached = _sizeCache.get(message);
    if (cached !== undefined) return cached;
    const size = byteLength(message);
    _sizeCache.set(message, size);
    return size;
  };
  // `tools` is never rewritten in this function, so it is measured once.
  const toolsBytes = byteLength(requestTools);
  // Exact JSON envelope of `{"messages":[…],"tools":…}` around the per-message sizes:
  // `{` + `"messages":` + `[` + `]` + `,` + `"tools":` + `}` = 24 chars, plus one comma
  // between each pair of messages. Verified against the naive whole-request measure in
  // test/logic.test.mjs so this stays a pure speed-up, not a behaviour change.
  const REQUEST_ENVELOPE_BYTES = 24;
  const requestBytes = () => {
    let total = 0;
    for (const message of prepared) total += msgBytes(message);
    return total + Math.max(0, prepared.length - 1) + REQUEST_ENVELOPE_BYTES + toolsBytes;
  };
  const historicalArgumentSummary = (rawArguments, toolName, maxBytes = 2048) => {
    const raw = typeof rawArguments === "string"
      ? rawArguments
      : (() => { try { return JSON.stringify(rawArguments ?? {}); } catch { return "{}"; } })();
    if (byteLength(raw) <= maxBytes) return raw;
    const safeToolName = String(toolName || "tool").slice(0, 80);
    const omitted = `[historical ${safeToolName} argument omitted; original UTF-8 bytes: ${byteLength(raw)}]`;
    const isWrite = /write(?:_file)?$/i.test(safeToolName);
    const isEdit = /edit(?:_file)?$/i.test(safeToolName);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    let summary;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const path = typeof parsed.path === "string" && parsed.path
        ? parsed.path.slice(0, 256)
        : "[historical path unavailable]";
      if (isWrite) {
        summary = { path, content: omitted };
      } else if (isEdit) {
        summary = {
          path,
          old_string: omitted,
          new_string: omitted,
          ...(Object.prototype.hasOwnProperty.call(parsed, "replace_all") ? { replace_all: !!parsed.replace_all } : {}),
        };
      } else {
        summary = {};
        for (const [key, value] of Object.entries(parsed).slice(0, 12)) {
          if (value == null || typeof value === "number" || typeof value === "boolean") summary[key] = value;
          else if (typeof value === "string" && byteLength(value) <= 256) summary[key] = value;
          else summary[key] = omitted;
        }
        if (!Object.keys(summary).length) summary = { _michael_history: omitted };
      }
    } else summary = { _michael_history: omitted };
    let encoded = JSON.stringify(summary);
    if (byteLength(encoded) > maxBytes) {
      if (isWrite) encoded = JSON.stringify({ path: "[historical path omitted]", content: omitted });
      else if (isEdit) encoded = JSON.stringify({ path: "[historical path omitted]", old_string: omitted, new_string: omitted });
      else encoded = JSON.stringify({ _michael_history: omitted });
    }
    return encoded;
  };

  // A completed assistant tool call and its tool result are one protocol unit.
  // Keep both messages and their IDs, but replace multi-megabyte historical
  // arguments on the request-only copy. Removing either side makes strict
  // OpenAI-compatible providers reject the next turn as an invalid transcript.
  const completedToolCallIds = new Set(prepared
    .filter((message) => message?.role === "tool" && message.tool_call_id)
    .map((message) => String(message.tool_call_id)));
  const historicalCalls = [];
  for (const message of prepared) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!call?.function) continue;
      const raw = typeof call.function.arguments === "string"
        ? call.function.arguments
        : (() => { try { return JSON.stringify(call.function.arguments ?? {}); } catch { return "{}"; } })();
      call.function.arguments = raw;
      if (completedToolCallIds.has(String(call.id || "")) && byteLength(raw) > 2048) {
        // `message` is carried so the loop below can invalidate its cached size: rewriting
        // `call.function.arguments` mutates a NESTED object, leaving the message's own
        // identity unchanged, which is the one case the identity cache cannot notice.
        historicalCalls.push({ call, raw, name: String(call.function.name || ""), message });
      }
    }
  }
  let bytes = requestBytes();
  for (const historical of historicalCalls) {
    if (bytes <= cap) break;
    historical.call.function.arguments = historicalArgumentSummary(historical.raw, historical.name);
    _sizeCache.delete(historical.message); // in-place edit: identity unchanged, size is not
    bytes = requestBytes();
  }
  const mediaIndexes = prepared
    .map((message, index) => Array.isArray(message?.content) && message.content.some((part) => part?.type === "image_url") ? index : -1)
    .filter((index) => index >= 0);
  const newestMediaIndex = mediaIndexes.length ? mediaIndexes[mediaIndexes.length - 1] : -1;
  const withoutMedia = (message, dropParts = null) => {
    let removed = 0;
    const text = [];
    const content = [];
    for (let index = 0; index < (message.content || []).length; index++) {
      const part = message.content[index];
      const shouldDrop = part?.type === "image_url" && (!dropParts || dropParts.has(index));
      if (shouldDrop) { removed++; continue; }
      content.push(part);
      if (part?.type === "text" && part.text) text.push(String(part.text));
    }
    if (!removed) return message;
    if (!content.some((part) => part?.type === "image_url")) {
      return { ...message, content: `${text.join("\n")}\n（较早媒体已从本次请求省略以控制请求大小；原聊天记录仍保留。）`.trim() };
    }
    content.push({ type: "text", text: `（${removed} 个媒体画面因本次请求总量上限未重复发送。）` });
    return { ...message, content };
  };

  for (const index of mediaIndexes) {
    if (bytes <= cap || index === newestMediaIndex) continue;
    prepared[index] = withoutMedia(prepared[index]);
    bytes = requestBytes();
  }
  // The current visual turn is last to lose data. If it alone cannot fit, remove
  // later key frames first so at least the first/representative frame survives.
  if (bytes > cap && newestMediaIndex >= 0) {
    const original = prepared[newestMediaIndex];
    const mediaParts = original.content
      .map((part, index) => part?.type === "image_url" ? index : -1)
      .filter((index) => index >= 0)
      .reverse();
    const dropped = new Set();
    for (const partIndex of mediaParts) {
      if (bytes <= cap) break;
      dropped.add(partIndex);
      prepared[newestMediaIndex] = withoutMedia(original, dropped);
      bytes = requestBytes();
    }
  }

  // Media is normally the only multi-megabyte field. If unusually large older
  // text still exceeds the body budget, fold it without breaking tool-call roles.
  // 方案B：最新一条带报错的工具结果是模型即将思考的对象——豁免对折，全量在场
  //（其内容产生时已被 12KB 级上限约束过，这里不再二次裁剪）。只豁免最新一条，
  // 旧报错照常折叠，豁免总量不失控。
  let _latestToolErrorIndex = -1;
  for (let index = prepared.length - 1; index >= 0; index--) {
    const message = prepared[index];
    if (message?.role === "tool" && typeof message.content === "string" && _hasErrorLine(message.content)) {
      _latestToolErrorIndex = index;
      break;
    }
  }
  const newestMessageIndex = prepared.length - 1;
  for (let index = 0; bytes > cap && index < prepared.length; index++) {
    if (index === newestMessageIndex || prepared[index]?.role === "system") continue;
    if (index === _latestToolErrorIndex) continue;
    const content = prepared[index]?.content;
    if (typeof content !== "string" || content.length <= 1600) continue;
    // 带 📌 请求边界的消息必须整段保住边界起的正文：头 600+尾 600 的对折会把边界切掉，
    // 网关 latest_user_request 找不到标记就漂移到编排 nudge——推理检查点/知识块/意图门控
    // 全部跟着抖（真实用户请求通常只有几 KB，不是超预算的元凶）。只折叠边界之前的动态前导。
    // Both spellings: the English marker this build emits, and the Chinese one that is still
    // sitting in conversations stored before the prompt rewrite. Missing either one folds the
    // boundary away and the gateway loses the request.
    const _reqMarker = _REQUEST_MARKERS.find((marker) => content.includes(marker));
    if (_reqMarker) {
      const _bm = content.search(/━{8,}\s*\n\s*📌/); // a complete boundary = the ━━━ line + the 📌 line; without both the gateway cannot recognize it
      const _bk = _bm >= 0 ? _bm : content.indexOf(_reqMarker);
      if (_bk > 1200) {
        prepared[index] = { ...prepared[index], content: `${content.slice(0, 400)}\n…（较早的动态前导已压缩以满足请求上限）…\n${content.slice(_bk)}` };
        bytes = requestBytes();
      }
      continue;
    }
    // 方案B/E：对折改走统一裁剪出口——被裁中段里的错误关键行以豁免块保留
    prepared[index] = { ...prepared[index], content: _clipPreservingErrors(content, 1300) };
    bytes = requestBytes();
  }
  // The user's actual request is appended at the end of its text block. Preserve
  // that tail if a giant one-shot context injection is the final remaining cause.
  while (bytes > cap && newestMessageIndex >= 0) {
    const message = prepared[newestMessageIndex];
    if (typeof message?.content === "string" && message.content.length > 2000) {
      const remove = Math.min(message.content.length - 1600, Math.max(1024, bytes - cap));
      prepared[newestMessageIndex] = { ...message, content: `（过大的前置上下文已省略）\n${message.content.slice(remove)}` };
    } else if (Array.isArray(message?.content)) {
      const textIndex = message.content.findIndex((part) => part?.type === "text" && String(part.text || "").length > 2000);
      if (textIndex < 0) break;
      const next = message.content.map((part) => ({ ...part }));
      const value = String(next[textIndex].text || "");
      const remove = Math.min(value.length - 1600, Math.max(1024, bytes - cap));
      next[textIndex].text = `（过大的前置上下文已省略）\n${value.slice(remove)}`;
      prepared[newestMessageIndex] = { ...message, content: next };
    } else break;
    const nextBytes = requestBytes();
    if (nextBytes >= bytes) break;
    bytes = nextBytes;
  }
  bytes = requestBytes();
  if (bytes > cap) {
    const error = new RangeError(`Model request is ${bytes} UTF-8 bytes after safe compression; limit is ${cap} bytes.`);
    error.code = "MODEL_REQUEST_TOO_LARGE";
    error.requestBytes = bytes;
    error.byteCap = cap;
    throw error;
  }
  return prepared;
}

// 上下文真溢出（OpenAI 系 400 context_length_exceeded / Anthropic prompt too long 等）。
// 它既不是 413 请求体过大，也不是网络波动——原样重试必然再爆，必须先压缩消息本体。
export function _isContextOverflowAiError(msg) {
  return /context[_ ]?length|maximum context|context window|prompt is too long|too many tokens|input.{0,20}exceed|exceeds?.{0,24}(?:context|token)|上下文(?:长度)?(?:超出|溢出|过长)|超出.{0,8}上下文/i.test(String(msg || ""));
}

// 上下文溢出后的最后手段：在 messages 本体上做一次硬挤压——
// ① 历史 assistant tool_calls 的大参数（write_file 全文等）原地替换成保留 path 的摘要桩
//    （最后一组 assistant+tool 配对不动，模型还要靠它接续）；
// ② 更早的长工具结果硬截断。改动幂等且一次定形，压完由调用方 sync 读取覆盖账本。
export function _squeezeMessagesForContext(messages) {
  let changed = false;
  let lastToolsIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && Array.isArray(messages[i].tool_calls)) { lastToolsIdx = i; break; }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && i !== lastToolsIdx) {
      let msgChanged = false;
      const tcs = m.tool_calls.map((tc) => {
        const args = (tc && tc.function && tc.function.arguments) || "";
        if (args.length <= 2048 || /"_summarized"/.test(args)) return tc;
        msgChanged = true;
        const stub = { _summarized: `原参数 ${args.length} 字因上下文溢出已省略；结果见对应 tool 消息` };
        try {
          const p = JSON.parse(args);
          if (p && typeof p === "object") {
            if (p.path) stub.path = p.path;
            if (p.command) stub.command = String(p.command).slice(0, 160);
          }
        } catch {}
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(stub) } };
      });
      if (msgChanged) { messages[i] = { ...m, tool_calls: tcs }; changed = true; }
    } else if (m.role === "tool" && typeof m.content === "string" && m.content.length > 800 && i < messages.length - 6 && !m.content.endsWith("需要就重新获取）")) {
      messages[i] = {
        ...m,
        ...(m._ideMeta?.kind === "read" ? { _ideMeta: { ...m._ideMeta, contextAvailable: false } } : {}),
        content: m.content.slice(0, 600) + "\n…（上下文溢出，已硬截断；需要就重新获取）",
      };
      changed = true;
    }
  }
  return changed;
}
