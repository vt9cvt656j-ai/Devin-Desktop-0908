/**
 * Hierarchical conversation memory with LLM-powered intelligent compression.
 * The LLM decides what's important based on CONTENT, not position — a key
 * decision from message #3 stays while a verbose tool dump from #48 gets
 * condensed. No fixed "keep last N" window.
 *
 * Structure: summaries (compressed context) + recent (new messages since
 * last compaction). LLM compaction is driven by main.js.
 */

/*
 * 压缩的**高低水位**（条数一套、token 一套）。
 *
 * # 为什么要低水位
 *
 * 原来只有单条线：超过就砍最老的 10 条。一个真实 agent 回合结束时往 memory 批量写回
 * 约 19 条、约 1.7 万 token，而砍一批只腾出约 1 万 —— 于是**从第 3 轮起每一轮都会压缩**。
 * 压缩把 recent 头部切掉，而模型看到的历史是 `prefixMessages() + recent`，
 * 头部一动，位置 1 往后全部错位：OpenAI / xAI 那一族的严格前缀缓存整段作废。
 *
 * 线上实测（2026-09-02，gpt-5.6-luna 的 >40k 真回合）：请求 56k→缓存 24k、105k→42k、
 * 165k→36k —— **缓存量恒定、不随请求增长**，命中率也与请求间隔无关（<1分 26.9%）。
 * 就是"只有静态头进了缓存、几万 token 的历史一条没进"。
 *
 * # 参数是量出来的，不是拍的
 *
 * 用 10 个真实尺寸的回合跑「相邻两轮历史前缀的公共部分占比」：
 *   原始（100 条 / 48k，每次一批）        复用  7.4%
 *   128→80 / 72k→36k                      复用 54.6%   ← 采用
 *   160→100 / 96k→48k                     复用 67.2%
 *   200→120 / 110k→55k                    复用 83.3%（但 recent 会到 108k，小窗口模型有风险）
 * 选 128/72k 这组：复用提升七倍，而 recent 封顶 72k、加上网关静态头约 20k 仍在 128k 窗口内。
 *
 * 压缩的**总量不变**，变的只是频次——同样的历史照样被折叠，只是攒够一批再做，
 * 中间那些轮次里前缀逐字节不动。
 */
// 高水位必须保持在原值（100 条 / 4.8 万）。
//
// 2026-09-02 我一度把它抬到 128 / 7.2 万，理由是合成测试里「前缀复用率」7.4% → 54.6%。
// 那是**优化了代理指标而不是钱**：线上实测 deepseek-v4-pro 平均输入 17,214 → 27,448
// （+59%），命中率反而 29.8% → 24.8%，单请求成本 $1.82 → $2.31（+27%）。
// 高水位决定每轮塞给模型多少历史；抬高它 = 每轮按全价多发几万 token，而省下的
// 那点压缩次数根本换不回来。判据是「每请求成本」，不是复用率。
export const RECENT_WINDOW = 100;
export const RECENT_WINDOW_LOW = 80;
const COMPRESS_HIGH_TOKENS = 48000;
const COMPRESS_LOW_TOKENS = 36000;
const MAX_SUMMARIES = 8;
export const SUMMARY_BATCH = 10;
const PERSISTED_MEDIA_BUDGET = 3_200_000;
const MAX_ARCHIVE = 400;          // archived (compacted-away) turns kept for recall
const ARCHIVE_ENTRY_MAX = 1600;   // chars per archived turn
const MERGED_SUMMARY_MAX = 8000;  // merged summary text cap (head+tail keep)
const MAX_CORRECTIONS = 160;
const CORRECTION_TEXT_MAX = 420;
const CORRECTION_PREFIX_MAX = 8;

// Tokenizer for archival search: latin words + CJK bigrams (MemGPT-style
// archival memory needs retrieval that works for Chinese without a segmenter).
function memSearchTokens(s) {
  const lower = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of lower.match(/[a-z0-9_$./-]{2,}/g) || []) out.add(w);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].slice(0, 64);
}

function cleanCorrectionText(value, max = CORRECTION_TEXT_MAX) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 掐中间的截断：头 55% + 尾 45%，预算不变。
 *
 * 工具结果的价值密度在**两头**：开头是它做了什么，结尾是结论（报错、根因、
 * "3 failing"）。从头截断只留开头，等于把结论扔掉、把噪音留下——一段
 * "PASS…PASS…FAIL: ECONNREFUSED" 截到 700 字就只剩满屏 PASS，读起来是"全都过了"。
 * 这是**主动误导**，比不记还糟。本文件 _mergeSummaries 早就是头+尾（0.6/0.35），
 * 这里两个调用点跟上，别再一边掐中间一边掐尾巴。
 */
function cleanEnds(value, max) {
  const one = String(value || '').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const head = Math.max(1, Math.floor(max * 0.55));
  const tail = Math.max(1, max - head - 3);
  return `${one.slice(0, head)}…${one.slice(-tail)}`;
}

/**
 * Extract only high-confidence, explicit replacements. General complaints such
 * as "still slow" deliberately do not create a factual correction.
 */
export function extractExplicitCorrection(value) {
  const text = cleanCorrectionText(value, 1200);
  if (text.length < 4) return null;
  const patterns = [
    /(?:不是|并非)\s*([^，,。；;]{1,180})\s*(?:，|,|；|;)\s*(?:而是|是|应该是|应为|正确的是|改成)\s*([^。；;]{1,260})/i,
    /(?:不是|并非)\s*([^，。；;]{1,180})\s*(?:，|,|；|;)?\s*(?:而是|应该是|应为|正确的是|改成)\s*([^。；;]{1,260})/i,
    /(?:不要|别用|不该用)\s*([^，。；;]{1,180})\s*(?:，|,|；|;)\s*(?:要用|改用|请用|应该用|用)\s*([^。；;]{1,260})/i,
    /([^，。；;]{2,180})\s*(?:不对|错了|是错的)\s*(?:，|,|；|;)?\s*(?:正确的是|应该是|应为|改成)\s*([^。；;]{1,260})/i,
    /\bnot\s+(.{1,180}?),\s*(?:but|use|it is|should be)\s+(.{1,260})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const incorrect = cleanCorrectionText(match[1], 240);
    const corrected = cleanCorrectionText(match[2], 360);
    if (incorrect.length >= 2 && corrected.length >= 2 && incorrect.toLowerCase() !== corrected.toLowerCase()) {
      return { incorrect, corrected, explicitReplacement: true };
    }
  }
  const general = /^(?:不对|错了|你搞错了|你理解错了|不是这样|我的意思是|纠正一下|更正一下|no[,，:]?|that's wrong[,，:]?)\s*/i;
  if (!general.test(text)) return null;
  const corrected = cleanCorrectionText(text.replace(general, ''), 500);
  if (corrected.length < 4) return null;
  return { incorrect: '', corrected, explicitReplacement: false };
}

function serializeLocationEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return undefined;
  const latitude = evidence.latitude;
  const longitude = evidence.longitude;
  const hasCoordinates = typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  const statuses = new Set([
    'embedded_location_absent',
    'embedded_location_unreadable',
    'embedded_gps',
    'embedded_gps_resolved',
    'embedded_gps_unresolved',
    'embedded_gps_reverse_failed',
  ]);
  const status = statuses.has(evidence.status) ? evidence.status : (hasCoordinates ? 'embedded_gps' : 'embedded_location_absent');
  const cleanText = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : null;
  const candidate = (value) => {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const key of ['source', 'label', 'house_number', 'road', 'neighborhood', 'suburb', 'city_district', 'city', 'state', 'country', 'country_code']) {
      const text = cleanText(value[key]);
      if (text) out[key] = text;
    }
    const lat = value.latitude, lon = value.longitude;
    if (typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90) out.latitude = lat;
    if (typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180) out.longitude = lon;
    return Object.keys(out).length ? out : null;
  };
  const out = {
    status,
    coordinateSource: hasCoordinates ? 'embedded_exif_gps' : null,
    metadataAuthenticity: 'not_verified',
  };
  if (['source_file_changed', 'missing_source_fingerprint'].includes(evidence.invalidatedReason)) {
    out.invalidatedReason = evidence.invalidatedReason;
  }
  if (hasCoordinates) {
    out.latitude = latitude;
    out.longitude = longitude;
    const accuracy = evidence.reportedAccuracyM;
    out.reportedAccuracyM = typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;
  }
  out.reverseGeocoding = (Array.isArray(evidence.reverseGeocoding) ? evidence.reverseGeocoding : [])
    .slice(0, 4).map(candidate).filter(Boolean);
  out.sourceStatuses = (Array.isArray(evidence.sourceStatuses) ? evidence.sourceStatuses : [])
    .slice(0, 4).map((value) => ({
      source: cleanText(value?.source, 120) || 'unknown',
      status: cleanText(value?.status, 40) || 'unknown',
      detail: cleanText(value?.detail, 500) || '',
    }));
  out.retrievedAt = typeof evidence.retrievedAt === 'number' && Number.isFinite(evidence.retrievedAt) ? evidence.retrievedAt : null;
  out.limitations = (Array.isArray(evidence.limitations) ? evidence.limitations : [])
    .slice(0, 10).map((value) => cleanText(value, 600)).filter(Boolean);
  return out;
}

// Keep enough recent visual context to survive a restart without letting base64
// media overflow localStorage. Raw videos are never persisted; their compressed
// key frames (or a stable local path) are the durable representation.
function serializeAttachment(attachment, budget) {
  if (!attachment || typeof attachment !== 'object') return null;
  const kind = attachment.kind === 'video' ? 'video' : 'image';
  let budgetOmitted = 0;
  const out = {
    id: String(attachment.id || '').slice(0, 160),
    kind,
    mime: String(attachment.mime || attachment.type || (kind === 'video' ? 'video/mp4' : 'image/png')).slice(0, 120),
    name: String(attachment.name || (kind === 'video' ? 'video' : 'image')).slice(0, 240),
    path: String(attachment.path || '').slice(0, 2048),
    sourceFingerprint: typeof attachment.sourceFingerprint === 'string'
      ? attachment.sourceFingerprint.slice(0, 120) : '',
    visionText: String(attachment.visionText || '').slice(0, 6000),
    locationVisionText: String(attachment.locationVisionText || '').slice(0, 6000),
    modelMediaSanitized: attachment.modelMediaSanitized === true
      ? true
      : attachment.modelMediaSanitized === false ? false : undefined,
    mediaSourceChanged: attachment.mediaSourceChanged === true,
    locationEvidence: serializeLocationEvidence(attachment.locationEvidence),
    frames: [],
  };
  const keepDataUrl = (value, prefix) => {
    const data = typeof value === 'string' && value.startsWith(prefix) ? value : '';
    if (!data) return '';
    if (data.length > budget.remaining) {
      budgetOmitted++;
      return '';
    }
    budget.remaining -= data.length;
    return data;
  };
  if (kind === 'image') {
    const dataUrl = keepDataUrl(attachment.dataUrl, 'data:image/');
    if (dataUrl) out.dataUrl = dataUrl;
  }
  for (const frame of Array.isArray(attachment.frames) ? attachment.frames.slice(0, 4) : []) {
    const data = keepDataUrl(frame, 'data:image/');
    if (data) out.frames.push(data);
  }
  const priorOmitted = !!attachment.omitted;
  const hasDurableMedia = !!(out.path || out.dataUrl || out.frames.length);
  if (budgetOmitted || priorOmitted || !hasDurableMedia) {
    out.omitted = true;
    out.omittedReason = budgetOmitted
      ? 'persistence_media_budget'
      : String(attachment.omittedReason || (kind === 'video' ? 'raw_video_not_persisted' : 'media_unavailable')).slice(0, 120);
    out.omittedCount = Math.max(1, Number(attachment.omittedCount) || 0, budgetOmitted);
  }
  return out;
}

const LOCAL_TEXT_TRUNCATION_MARKER = '\n...[local recovery mirror truncated; full history remains on disk]...\n';
/// Bytes of a message kept even when the shared budget is completely spent.
const TEXT_BUDGET_FLOOR = 400;
/// Reasoning is display-only on restore; it gets a flat cap instead of budget bidding.
const REASONING_PERSIST_MAX = 4000;

function serializeTextWithBudget(value, textBudget) {
  if (typeof value !== 'string' || !textBudget || typeof textBudget !== 'object') return value;
  textBudget.remaining = Math.max(0, Number(textBudget.remaining) || 0);
  const perValue = Math.max(0, Number(textBudget.perValue) || textBudget.remaining);
  const keep = Math.min(value.length, textBudget.remaining, perValue);
  if (value.length <= keep) {
    textBudget.remaining -= value.length;
    return value;
  }
  // Never return '' — an empty string is indistinguishable from "the user sent nothing",
  // and it goes straight back into the model's context on restore. A shared budget can be
  // exhausted by earlier sessions, so this floor is what stops later tabs from being
  // restored as a column of blank messages while their bubbles still render from the
  // journal. Overrunning `remaining` here is deliberate: a marked stub costs a few hundred
  // bytes and keeps the turn legible.
  if (keep <= 0) {
    const tail = value.slice(-TEXT_BUDGET_FLOOR);
    const result = value.length > TEXT_BUDGET_FLOOR ? LOCAL_TEXT_TRUNCATION_MARKER + tail : tail;
    textBudget.remaining = 0;
    return result;
  }
  let result;
  if (keep <= LOCAL_TEXT_TRUNCATION_MARKER.length + 32) {
    result = value.slice(-keep);
  } else {
    const available = keep - LOCAL_TEXT_TRUNCATION_MARKER.length;
    const head = Math.ceil(available * 0.55);
    result = value.slice(0, head) + LOCAL_TEXT_TRUNCATION_MARKER + value.slice(-(available - head));
  }
  textBudget.remaining -= result.length;
  return result;
}

function serializeMessageText(message, textBudget) {
  if (!message || typeof message !== 'object' || !textBudget) return message;
  if (typeof message.content === 'string') {
    message.content = serializeTextWithBudget(message.content, textBudget);
  } else if (Array.isArray(message.content)) {
    const content = new Array(message.content.length);
    for (let index = message.content.length - 1; index >= 0; index--) {
      const raw = message.content[index];
      if (!raw || typeof raw !== 'object') { content[index] = raw; continue; }
      const part = { ...raw };
      if (typeof part.text === 'string') part.text = serializeTextWithBudget(part.text, textBudget);
      if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string') {
        part.image_url = { ...part.image_url, url: serializeTextWithBudget(part.image_url.url, textBudget) };
      }
      content[index] = part;
    }
    message.content = content;
  }
  if (typeof message.reasoning === 'string') {
    // Reasoning is stripped before the request goes out (_sanitizeProviderMessages), so it
    // never reaches the model — it only repaints the thinking card after a restart. Letting
    // it bid for the shared budget against real message text is why a session with deep
    // thinking enabled loses its context sooner than an identical one without it.
    message.reasoning = message.reasoning.slice(0, REASONING_PERSIST_MAX);
  }
  if (Array.isArray(message.tool_calls)) {
    const calls = new Array(message.tool_calls.length);
    for (let index = message.tool_calls.length - 1; index >= 0; index--) {
      const raw = message.tool_calls[index];
      if (!raw || typeof raw !== 'object') { calls[index] = raw; continue; }
      const call = { ...raw };
      if (call.function && typeof call.function === 'object') {
        call.function = { ...call.function };
        if (typeof call.function.arguments === 'string') {
          call.function.arguments = serializeTextWithBudget(call.function.arguments, textBudget);
        }
      }
      calls[index] = call;
    }
    message.tool_calls = calls;
  }
  return message;
}

export function serializeMessagesForPersistence(messages, mediaBudget = PERSISTED_MEDIA_BUDGET, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // Callers serializing several queues or sessions may pass one shared budget
  // object so the aggregate media payload stays bounded.
  const budget = mediaBudget && typeof mediaBudget === 'object'
    ? mediaBudget
    : { remaining: Math.max(0, Number(mediaBudget) || 0) };
  budget.remaining = Math.max(0, Number(budget.remaining) || 0);
  const out = new Array(list.length);
  // Spend the bounded media budget on the newest turns first.
  for (let i = list.length - 1; i >= 0; i--) {
    let message = list[i] && typeof list[i] === 'object' ? { ...list[i] } : list[i];
    message = serializeMessageText(message, options?.textBudget);
    if (message && Array.isArray(message.attachments)) {
      message.attachments = message.attachments
        .map((attachment) => serializeAttachment(attachment, budget))
        .filter(Boolean);
    }
    out[i] = message;
  }
  return out;
}

export class ConversationMemory {
  constructor() {
    this.totalTurns = 0;
    this.recent = [];
    this.summaries = [];
    // 这里曾经还有一个 milestones 账本 + markMilestone()。它**从来没有写入点**——
    // 从初始导入起就只有定义，没人调，于是那条「📌 Key milestones from earlier」系统
    // 消息一次也没发出去过。要接它就得先定义「什么算里程碑」，而纠错账本 / 摘要 /
    // 文件证据 / 思考结论四条通道已经在做同一件事，第五条只会挤占上下文。旧会话 JSON
    // 里可能还留着 milestones 键，读回来时忽略即可（它恒为空数组）。
    this.fileEvidence = [];
    // The prompt-facing memory below is intentionally compacted. Keep a separate
    // append-only transcript for durable chat recovery so saving tokens can never
    // discard what the user or agent actually said.
    this.transcript = [];
    // `transcript` may be only the in-process tail after a restart. Its first
    // item still has a stable, absolute journal sequence so a new append can
    // never overwrite the beginning of a long SQLite transcript.
    this.transcriptOffset = 0;
    // Archival memory (MemGPT/Letta-style): compacted-away turns keep a bounded
    // text-only record here, searchable via searchArchive() / the recall tool,
    // so compression no longer means permanent loss of early details.
    this.archive = [];
    // Append-only overlay. Raw conversation/archive entries remain untouched;
    // newer correction records supersede older beliefs during retrieval.
    this.corrections = [];
    this._onMessagesRemoved = null;
    this._onTranscriptMutation = null;
    this._externalCompression = false;
    this._recentChars = 0;
  }

  setExternalCompression(enabled) {
    this._externalCompression = !!enabled;
  }

  setRemovalHandler(handler) {
    this._onMessagesRemoved = typeof handler === 'function' ? handler : null;
  }

  setTranscriptMutationHandler(handler) {
    this._onTranscriptMutation = typeof handler === 'function' ? handler : null;
  }

  _notifyTranscriptMutation(mutation) {
    if (!this._onTranscriptMutation) return;
    try { this._onTranscriptMutation(mutation); } catch {}
  }

  _notifyMessagesRemoved(messages) {
    if (!messages?.length || !this._onMessagesRemoved) return;
    try { this._onMessagesRemoved(messages); } catch {}
  }

  push(msg) {
    const sequence = this.transcriptOffset + this.transcript.length;
    this.totalTurns++;
    this.transcript.push(msg);
    this.totalTurns = Math.max(this.totalTurns, sequence + 1);
    this._notifyTranscriptMutation({ kind: 'append', sequence, message: msg });
    this.recent.push(msg);
    this._recentChars += ConversationMemory._messageChars(msg);
    // Adaptive compression: by count (long chats of short turns) OR by token
    // pressure (few turns but huge tool outputs). Threshold sits ABOVE the LLM
    // auto-compact trigger (~28k in main.js) so the smart compactor gets first
    // shot; this is the mechanical safety net.
    if (this._externalCompression) return;
    // 触发只算一次 token（estimateRecentTokens 是 O(全部字符) 的，不能放进循环里反复调）。
    const overCount = this.recent.length > RECENT_WINDOW;
    let est = null;
    if (!overCount && this.recent.length >= SUMMARY_BATCH + 6) {
      est = this.estimateRecentTokens();
    }
    if (!overCount && !(est != null && est > COMPRESS_HIGH_TOKENS)) return;
    if (est == null) est = this.estimateRecentTokens();
    // 一次压到**低水位以下**，别让下一条消息又触发一次（见上面那段说明）。
    // 循环里不再重算全量估值，按被砍掉那一批的实际用量增量扣减。
    let guard = RECENT_WINDOW * 2; // 防呆：任何情况下都不许在这里转圈
    while (guard-- > 0
           && this.recent.length >= SUMMARY_BATCH + 6
           && (this.recent.length > RECENT_WINDOW_LOW || est > COMPRESS_LOW_TOKENS)) {
      const dropped = this.recent.slice(0, SUMMARY_BATCH);
      const before = this.recent.length;
      this._compressOldestBatch();
      if (this.recent.length === before) break; // 没压动就别空转
      est -= ConversationMemory._estimateMessagesTokens(dropped);
    }
  }

  /** 一批消息的估算 token。和 estimateRecentTokens 用同一把尺子（CJK 1，其余 0.25）。 */
  static _estimateMessagesTokens(list) {
    let t = 0;
    for (const m of list || []) {
      const c = typeof m?.content === 'string' ? m.content : '';
      for (let i = 0; i < c.length; i++) t += c.charCodeAt(i) > 0x2E7F ? 1 : 0.25;
    }
    return t;
  }

  // Display/recovery deliberately reads this durable record, whereas assemble()
  // remains the bounded, prompt-facing view. Falling back to `recent` keeps
  // snapshots created by older app versions readable.
  transcriptEntries() {
    return this.transcript.length || this.transcriptOffset > 0 ? this.transcript : this.recent;
  }

  transcriptLength() {
    return this.transcriptOffset + this.transcriptEntries().length;
  }

  transcriptSlice(from = 0, to = this.transcriptLength()) {
    const entries = this.transcriptEntries();
    const length = this.transcriptLength();
    const start = Math.max(0, Math.min(length, Math.trunc(Number(from) || 0)));
    const end = Math.max(start, Math.min(length, Math.trunc(Number(to) || 0)));
    const localStart = Math.max(0, start - this.transcriptOffset);
    const localEnd = Math.max(localStart, Math.min(entries.length, end - this.transcriptOffset));
    return entries.slice(localStart, localEnd);
  }

  // SQLite restores the compact prompt projection first, then supplies the exact
  // transcript only when this tab is opened. Hydration must not emit a journal
  // mutation: these records already exist durably and re-appending would create
  // duplicate work on every restart.
  replaceTranscript(messages) {
    this.transcript = Array.isArray(messages) ? messages.slice() : [];
    this.transcriptOffset = 0;
    this.totalTurns = this.transcript.length;
    if (!this.recent.length && this.transcript.length) {
      this.recent = this.transcript.slice(-RECENT_WINDOW);
      this._recentChars = this.recent.reduce((total, message) => total + ConversationMemory._messageChars(message), 0);
    }
    return this.transcript.length;
  }

  // Editing/resending a historical user turn invalidates every later turn. Keep
  // the exact retained transcript, then rebuild the compact prompt projection
  // so stale summaries or archive entries cannot steer the next model call.
  truncateTranscript(index) {
    const cut = Math.max(0, Math.min(this.transcriptLength(), Math.trunc(Number(index) || 0)));
    const localCut = Math.max(0, Math.min(this.transcript.length, cut - this.transcriptOffset));
    const removed = this.transcript.slice(localCut);
    if (cut <= this.transcriptOffset) {
      this.transcript = [];
      this.transcriptOffset = cut;
    } else {
      this.transcript = this.transcript.slice(0, localCut);
    }
    this.totalTurns = cut;
    this.recent = this.transcript.slice();
    this._recentChars = this.recent.reduce((total, message) => total + ConversationMemory._messageChars(message), 0);
    this.summaries = [];
    this.archive = [];
    this.fileEvidence = [];
    this.corrections = this.corrections.filter((item) => {
      const sourceTurns = Array.isArray(item?.sourceTurns) ? item.sourceTurns : [];
      return sourceTurns.every((turn) => Number(turn) <= this.totalTurns);
    });
    while (this.recent.length > RECENT_WINDOW) this._compressOldestBatch();
    this._notifyMessagesRemoved(removed);
    this._notifyTranscriptMutation({ kind: 'truncate', length: cut });
    return removed;
  }

  // The durable journal is authoritative after startup. Keep only a bounded
  // prompt projection in memory, but advance the absolute append sequence to
  // its real length before accepting another user turn.
  setExternalTranscriptLength(length) {
    const total = Math.max(0, Math.trunc(Number(length) || 0));
    if (!this.transcript.length) this.transcriptOffset = total;
    this.totalTurns = Math.max(total, this.transcriptOffset + this.transcript.length);
    return this.totalTurns;
  }

  // The journal can legitimately run ahead of the checkpoint: while any tab is streaming,
  // `saveChatHistory` downgrades to lightweight and writes no checkpoint at all, yet every
  // appended message still reaches SQLite. After a crash the bubbles all render (they come
  // from the journal) while the model's context stops at the older checkpoint — the user
  // asks "继续刚才那个" and it has never heard of it.
  //
  // Unlike `replacePromptTail` this is additive: summaries, archive and file evidence are
  // real state the checkpoint did carry, and dropping them would trade one kind of amnesia
  // for another. Only the tail that the checkpoint never saw is grafted on.
  adoptJournalTail(messages, totalTurns = this.totalTurns) {
    const tail = Array.isArray(messages) ? messages.filter(Boolean) : [];
    if (!tail.length) return 0;
    // Identity is by position in the durable journal, so overlap is resolved by count, not
    // by comparing content — two identical "继续" turns must not collapse into one.
    const known = Math.max(0, Math.trunc(Number(this.totalTurns) || 0));
    const target = Math.max(known, Math.trunc(Number(totalTurns) || 0));
    const missing = Math.min(tail.length, target - known);
    if (missing <= 0) return 0;
    const added = tail.slice(tail.length - missing);
    this.recent = [...this.recent, ...added];
    this._recentChars = this.recent.reduce((total, message) => total + ConversationMemory._messageChars(message), 0);
    this.totalTurns = target;
    // 溢出的头部要**归档**，不能直接 slice 掉。
    //
    // 这条路正好是崩溃重开那条：日志比 checkpoint 跑得远（流式期间 saveChatHistory 降级、
    // 不写 checkpoint，但每条消息都进了 SQLite），恢复时把差额补进来。`slice(-RECENT_WINDOW)`
    // 一刀切掉超出的头部，而这批消息**同时**从模型上下文和 recall_conversation 里消失——
    // 别的丢弃路径（push / fromJSON / truncate）都走 _compressOldestBatch 归档，只有这里没走。
    // 于是"崩溃前聊过的那一段"变成谁都找不回来的黑洞，而这正是用户最需要它还在的时刻。
    while (this.recent.length > RECENT_WINDOW) this._compressOldestBatch();
    if (!this.transcript.length) this.transcriptOffset = target;
    return added.length;
  }

  // Used after a historical edit. These messages are deliberately not inserted
  // into `transcript`: they already exist in SQLite and must not be re-appended.
  replacePromptTail(messages, totalTurns = this.totalTurns) {
    this.recent = Array.isArray(messages) ? messages.slice(-RECENT_WINDOW) : [];
    this._recentChars = this.recent.reduce((total, message) => total + ConversationMemory._messageChars(message), 0);
    this.summaries = [];
    this.archive = [];
    this.fileEvidence = [];
    this.totalTurns = Math.max(0, Math.trunc(Number(totalTurns) || 0));
    return this.recent.length;
  }

  _archiveBatch(removed, startTurn) {
    for (let i = 0; i < removed.length; i++) {
      const msg = removed[i];
      const role = msg?.role === 'assistant' ? 'assistant' : msg?.role === 'user' ? 'user' : msg?.role === 'tool' ? 'tool' : 'system';
      let text = typeof msg?.content === 'string' ? msg.content.replace(/\s+/g, ' ').trim() : '';
      if (msg?.tool_calls?.length) {
        const names = msg.tool_calls.map((tc) => tc?.function?.name).filter(Boolean).join(', ');
        if (names) text = (text ? text + ' ' : '') + `[调用工具: ${names}]`;
      }
      if (!text) continue;
      // 归档不只是"留个念想"：searchArchive 就是在这段文本上做关键词检索的。
      // 从头截断会同时毁掉两件事——回忆起来的内容缺了结论，以及**只出现在尾部的
      // 关键词整条搜不到**。模型 recall 一次拿到 0 条，读到的是"这事没发生过"
      // （失败和不存在同一个值），于是从头再来一遍。
      this.archive.push({ turn: startTurn + i, role, text: cleanEnds(text, role === 'tool' ? 700 : ARCHIVE_ENTRY_MAX) });
    }
    if (this.archive.length > MAX_ARCHIVE) this.archive.splice(0, this.archive.length - MAX_ARCHIVE);
  }

  _activeCorrections(query = '', k = CORRECTION_PREFIX_MAX) {
    if (!this.corrections.length) return [];
    const superseded = new Set(this.corrections.map((item) => item?.supersedes).filter(Boolean));
    const active = this.corrections.filter((item) => item && item.id && !superseded.has(item.id));
    const q = cleanCorrectionText(query, 800).toLowerCase();
    const terms = memSearchTokens(q);
    const scored = active.map((item, index) => {
      const haystack = `${item.incorrect || ''} ${item.corrected || ''} ${(item.topicTerms || []).join(' ')}`.toLowerCase();
      let score = q && haystack.includes(q) ? Math.max(12, q.length * 3) : 0;
      for (const term of terms) if (haystack.includes(term)) score += Math.max(1, term.length);
      return { item, index, score };
    });
    const selected = q ? scored.filter((row) => row.score > 0) : scored;
    selected.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt || b.index - a.index);
    return selected.slice(0, Math.max(1, Math.min(20, Number(k) || CORRECTION_PREFIX_MAX))).map((row) => ({ ...row.item }));
  }

  activeCorrections(query = '', k = CORRECTION_PREFIX_MAX) {
    return this._activeCorrections(query, k);
  }

  recordCorrection(input = {}) {
    const incorrect = cleanCorrectionText(input.incorrect);
    const corrected = cleanCorrectionText(input.corrected);
    if (corrected.length < 2 || (incorrect && incorrect.toLowerCase() === corrected.toLowerCase())) return null;
    const requestedSupersedes = cleanCorrectionText(input.supersedes, 160);
    const priorRecord = requestedSupersedes
      ? this.corrections.find((item) => item?.id === requestedSupersedes)
      : null;
    const aliases = [...new Set([
      ...(Array.isArray(input.aliases) ? input.aliases : []),
      ...(Array.isArray(priorRecord?.aliases) ? priorRecord.aliases : []),
      priorRecord?.incorrect,
    ].map((value) => cleanCorrectionText(value, 240)).filter(Boolean))].slice(0, 12);
    const topicTerms = memSearchTokens(`${aliases.join(' ')} ${incorrect} ${corrected}`).slice(0, 32);
    const active = this._activeCorrections(`${incorrect} ${corrected}`, 8);
    const duplicate = active.find((item) => item.corrected.toLowerCase() === corrected.toLowerCase()
      && (!incorrect || item.incorrect.toLowerCase() === incorrect.toLowerCase()));
    if (duplicate) return duplicate;
    let supersedes = requestedSupersedes;
    if (!supersedes && active.length) {
      const candidate = active.find((item) => {
        const priorValue = cleanCorrectionText(item.corrected, 420).toLowerCase();
        const nextOldValue = incorrect.toLowerCase();
        return priorValue.length >= 2 && nextOldValue.length >= 2
          && (priorValue.includes(nextOldValue) || nextOldValue.includes(priorValue));
      });
      if (candidate) supersedes = candidate.id;
    }
    const sourceTurns = [...new Set((Array.isArray(input.sourceTurns) ? input.sourceTurns : [])
      .map((turn) => Math.max(0, Math.trunc(Number(turn) || 0))).filter(Boolean))].slice(0, 8);
    const record = {
      id: `cor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Math.max(1, Number(input.createdAt) || Date.now()),
      kind: ['user', 'reflection', 'memory'].includes(input.kind) ? input.kind : 'memory',
      incorrect,
      corrected,
      aliases,
      topicTerms,
      sourceTurns,
      confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0.8)),
      supersedes: supersedes || '',
    };
    this.corrections.push(record);
    if (this.corrections.length > MAX_CORRECTIONS) this.corrections.splice(0, this.corrections.length - MAX_CORRECTIONS);
    return { ...record };
  }

  recordUserCorrection(value) {
    const parsed = extractExplicitCorrection(value);
    if (!parsed) return null;
    let previousAssistant = null;
    let previousTurn = 0;
    for (let index = this.recent.length - 1; index >= 0; index--) {
      const message = this.recent[index];
      if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) continue;
      previousAssistant = message.content;
      previousTurn = Math.max(1, this.totalTurns - (this.recent.length - 1 - index));
      break;
    }
    // A bare "不对 / 错了 / 我的意思是" means the user is redirecting, not that the whole
    // previous reply is void. Letting previousAssistant stand in registered its first 420
    // chars as a superseded fact, then re-injected that at top priority every turn — the
    // model would start avoiding the very files and steps it had just done correctly.
    // The clarification itself is still an ordinary user message in `recent`, so nothing
    // is lost. This restores the intent already documented at the top of this file.
    const incorrect = parsed.incorrect;
    if (!incorrect) return null;
    return this.recordCorrection({
      kind: 'user',
      incorrect,
      corrected: parsed.corrected,
      sourceTurns: [previousTurn, this.totalTurns + 1],
      confidence: parsed.explicitReplacement ? 1 : 0.92,
    });
  }

  _correctionForArchiveText(text) {
    const value = cleanCorrectionText(text, ARCHIVE_ENTRY_MAX).toLowerCase();
    if (!value) return null;
    return this._activeCorrections('', 20).find((item) => {
      return [item.incorrect, ...(item.aliases || [])].some((entry) => String(entry || '').length >= 2
        && value.includes(String(entry).toLowerCase()));
    }) || null;
  }

  /** Keyword search over archived (compacted-away) turns. Returns newest-biased
   *  best matches: [{turn, role, text}]. */
  searchArchive(query, k = 6) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = memSearchTokens(q);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(20, Number(k) || 6));
    const correctionHits = this._activeCorrections(q, limit).map((item) => ({
      turn: item.sourceTurns?.[item.sourceTurns.length - 1] || 0,
      role: 'system',
      text: `[纠错记忆·当前有效] ${item.incorrect ? `旧说法「${item.incorrect}」已作废；` : ''}应以「${item.corrected}」为准。`,
      correction: true,
    }));
    const scored = [];
    for (let i = 0; i < this.archive.length; i++) {
      const entry = this.archive[i];
      const text = entry.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = 0, n = 0;
        while (n < 8 && (idx = text.indexOf(t, idx)) !== -1) { n++; idx += t.length; }
        score += n * Math.max(1, t.length);
      }
      if (text.includes(q)) score += q.length * 4; // exact-phrase bonus
      if (score > 0) scored.push({ entry, i, score });
    }
    scored.sort((a, b) => b.score - a.score || b.i - a.i);
    const archiveHits = scored.map((s) => {
      const correction = this._correctionForArchiveText(s.entry.text);
      return correction
        ? { ...s.entry, text: `[已过时·仅供审计] ${s.entry.text}（当前纠正：${correction.corrected}）`, superseded: true }
        : { ...s.entry };
    });
    return [...correctionHits, ...archiveHits].slice(0, limit);
  }

  recordFileEvidence(evidence) {
    if (!evidence || !evidence.root || !evidence.path || !evidence.signature) return;
    const next = {
      root: String(evidence.root),
      path: String(evidence.path),
      signature: String(evidence.signature),
      total: Math.max(0, Number(evidence.total) || 0),
      ranges: Array.isArray(evidence.ranges) ? evidence.ranges : [[evidence.from, evidence.to]],
      digest: String(evidence.digest || "").slice(0, 700),
      redacted: !!evidence.redacted,
      updatedAt: Number(evidence.updatedAt) || Date.now(),
    };
    next.ranges = next.ranges
      .map((range) => [Math.max(1, Number(range?.[0]) || 1), Math.max(0, Number(range?.[1]) || 0)])
      .filter((range) => range[1] >= range[0])
      .sort((a, b) => a[0] - b[0]);
    const index = this.fileEvidence.findIndex((item) => item.root === next.root && item.path === next.path);
    const current = index >= 0 ? this.fileEvidence[index] : null;
    if (current && current.signature === next.signature) {
      next.ranges.push(...(Array.isArray(current.ranges) ? current.ranges : []));
      if (!next.digest) next.digest = current.digest || "";
      next.redacted = next.redacted || !!current.redacted;
    }
    next.ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of next.ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    next.ranges = merged;
    next.complete = next.total > 0 && next.ranges.length === 1 && next.ranges[0][0] === 1 && next.ranges[0][1] >= next.total;
    if (index >= 0) this.fileEvidence.splice(index, 1);
    this.fileEvidence.push(next);
    if (this.fileEvidence.length > 80) this.fileEvidence.splice(0, this.fileEvidence.length - 80);
  }

  invalidateFileEvidence(root, path) {
    const r = String(root || ""), p = String(path || "");
    this.fileEvidence = this.fileEvidence.filter((item) => !(item.root === r && item.path === p));
  }

  fileEvidenceForRoot(root) {
    const r = String(root || "");
    return this.fileEvidence.filter((item) => item.root === r).map((item) => ({ ...item, ranges: (item.ranges || []).map((range) => [...range]) }));
  }

  assemble() {
    return this.assembledSlice(0, this.assembledLength());
  }

  prefixMessages() {
    const result = [];
    // Was `_activeCorrections('', MAX)` — an empty query means "no filter", so this block
    // was a newest-first dump of every correction regardless of what the user just asked.
    // Score against a user message instead, with the newest 2 always carried so a
    // fresh correction can never be filtered out by a topic change.
    //
    // # 打分用的那句话必须**在同一段对话里钉住**
    //
    // 原来取的是「最新一条用户消息」。它每一轮都变 → 选中的纠错集合变 → 这个 system
    // 块的文字变。而这个块坐在整段对话历史的**最前面**，于是它后面所有内容的
    // 自动前缀缓存每换一个话题就整段作废。
    //
    // 线上实测这一刀（按「一轮里的第一发 / 轮内续跑」切开，输入 >20k token）：
    // grok-4.6 23.7% / 40.9%，qwen3.8-max 18.4% / 45.0% —— 掉的正好是每轮第一发。
    //
    // 现在的判据：**只在纠错集合真的变了的时候才重新取这句话。**
    // 集合没变 → 块逐字节不变 → 缓存一路命中；集合变了 → 块本来就得变，
    // 那一次未命中是应该付的。相关性也不丢：重新取的时机正是「刚学到新东西」那一刻。
    const _sig = this.corrections.map((item) => item && item.id).join(',');
    if (this._prefixQuerySig !== _sig) {
      this._prefixQuerySig = _sig;
      this._prefixQuery = [...this.recent].reverse()
        .find((m) => m?.role === 'user' && typeof m.content === 'string')?.content || '';
    }
    const q = this._prefixQuery || '';
    const pool = new Map();
    for (const item of this._activeCorrections('', 2)) pool.set(item.id, item);
    for (const item of (q ? this._activeCorrections(q, CORRECTION_PREFIX_MAX) : [])) pool.set(item.id, item);
    const corrections = [...pool.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, CORRECTION_PREFIX_MAX);
    if (corrections.length > 0) {
      // A reflection's `incorrect` is just this run's tool trace, not a forbidden action.
      // Rendering it under "避免重复" told the model to stop reading the files it must read.
      // The lesson (`corrected`) is the half that carries value.
      const text = corrections.map((item) => item.kind === 'reflection'
        ? `- 经验教训（上一次没跑完的运行留下的，是建议不是禁令）：${item.corrected}`
        : `- 已作废：${String(item.incorrect).slice(0, 120)}${item.aliases?.length ? `（此前相关旧说法：${item.aliases.join('、')}）` : ''}\n  当前有效：${String(item.corrected).slice(0, 200)}`).join('\n');
      result.push({
        role: 'system',
        content: `[纠错记忆·最高优先级]\n以下是对早期内容的追加纠正。原始历史仅供审计，不得继续把“已作废”内容当成事实或要求；若多条纠正冲突，以列表中更靠前的最新条目为准。\n${text}`,
      });
    }
    if (this.summaries.length > 0) {
      // range 从两个写入点、一个合并点一路维护下来，却在**唯一**通往模型的出口被丢掉。
      // 后果是先后顺序没了：摘要里写着「[user] 端口是 5433 不是 5432」，recent 里用户说
      // 「改回默认端口」，模型无法判断哪句在前——而 searchArchive 返回的条目是带 turn 的，
      // 两边对不上号。摘要被折叠合并之后跨度可能有几十轮，歧义只会更大。
      const merged = this.summaries.map((s) => (s.range ? `【${s.range}】\n${s.text}` : s.text)).join('\n\n');
      const recallHint = this.archive.length
        ? '\n\n（以上是早期对话的压缩摘要；需要某段早期对话的原文细节时，用 recall_conversation 工具按关键词检索归档）'
        : '';
      // _ideMeta 打标，让下游 _trimMessagesIfHuge 的 Tier 3 放过这条。
      //
      // Tier 3 把「长的 assistant 正文」对折成 400 字，而这条消息形状上完全符合
      // （assistant / 无 tool_calls / >600 字）且坐在 i=1。实测 3893 字被折成 400 字：
      // 用户第一轮定下的硬约束（接口前缀 /api/v2、金额用分存）当场消失——它们既不在
      // recent 里（已被压掉），也不在摘要里（刚被折掉）。它是被压掉那段历史的**唯一**
      // 替代物，折它等于把压缩的成果直接扔掉。
      //
      // 更糟的是 _foldAssistantText 贴的那句话对摘要三项全错：它不是「你这段早先的
      // 回复」，结尾不是「当时的结论、以它为准不要重新推导」，也不是「无法取回」
      // （archive 里还在，recall_conversation 捞得回来）——等于把唯一的退路也劝退了。
      //
      // 标记本身不会发给上游：_sanitizeProviderMessages 的解构里已经摘掉 _ideMeta。
      result.push({ role: 'assistant', _ideMeta: { kind: 'context_summary' }, content: `[对话上下文摘要]\n${merged}${recallHint}` });
    }
    return result;
  }

  assembledLength() {
    return this.prefixMessages().length + this.recent.length;
  }

  assembledAt(index) {
    const i = Math.trunc(Number(index) || 0);
    if (i < 0) return undefined;
    const prefixLength = this.prefixMessages().length;
    if (i >= prefixLength) return this.recent[i - prefixLength];
    return this.prefixMessages()[i];
  }

  assembledSlice(from = 0, to = this.assembledLength()) {
    const length = this.assembledLength();
    const start = Math.max(0, Math.min(length, Math.trunc(Number(from) || 0)));
    const end = Math.max(start, Math.min(length, Math.trunc(Number(to) || 0)));
    if (start === end) return [];
    const prefixLength = this.prefixMessages().length;
    const result = [];
    if (start < prefixLength) {
      const prefix = this.prefixMessages();
      for (let index = start; index < Math.min(end, prefixLength); index++) result.push(prefix[index]);
    }
    const recentStart = Math.max(0, start - prefixLength);
    const recentEnd = Math.max(0, end - prefixLength);
    if (recentEnd > recentStart) result.push(...this.recent.slice(recentStart, recentEnd));
    return result;
  }

  static _messageChars(message) {
    if (!message || typeof message !== 'object') return String(message || '').length;
    let total = typeof message.content === 'string' ? message.content.length : 0;
    if (Array.isArray(message.content)) {
      for (const part of message.content) total += String(part?.text || part?.image_url?.url || '').length;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) total += String(call?.function?.arguments || '').length;
    }
    if (Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        total += String(attachment?.dataUrl || '').length;
        for (const frame of Array.isArray(attachment?.frames) ? attachment.frames : []) total += String(frame || '').length;
      }
    }
    return total;
  }

  estimateRecentChars() {
    return Math.max(0, this._recentChars);
  }

  estimateRecentTokens() {
    let t = 0;
    for (const m of this.recent) {
      const c = typeof m.content === 'string' ? m.content : '';
      for (let i = 0; i < c.length; i++) t += c.charCodeAt(i) > 0x2E7F ? 1 : 0.25;
    }
    return Math.ceil(t);
  }

  /** Replace `count` oldest messages in recent with an LLM-generated summary.
   *  count can equal recent.length (compress everything). */
  compactRecent(count, summaryText) {
    if (count <= 0 || count > this.recent.length) return [];
    const removed = this.recent.splice(0, count);
    for (const message of removed) this._recentChars -= ConversationMemory._messageChars(message);
    this._recentChars = Math.max(0, this._recentChars);
    const startTurn = Math.max(1, this.totalTurns - this.recent.length - removed.length + 1);
    this._archiveBatch(removed, startTurn);
    this._notifyMessagesRemoved(removed);
    const endTurn = startTurn + removed.length - 1;
    this.summaries.push({
      range: `turns ${startTurn}–${endTurn}`,
      text: summaryText
    });
    while (this.summaries.length > MAX_SUMMARIES) {
      const a = this.summaries.shift();
      const b = this.summaries.shift();
      this.summaries.unshift({
        range: `${a.range}, ${b.range}`,
        text: this._mergeSummaryText(a.text, b.text)
      });
    }
    return removed;
  }

  // Merged summaries used to grow without bound (plain concatenation). Cap with a
  // head+tail keep so the oldest framing and the newest facts both survive.
  _mergeSummaryText(a, b) {
    const merged = `${a}\n${b}`;
    if (merged.length <= MERGED_SUMMARY_MAX) return merged;
    const head = merged.slice(0, Math.floor(MERGED_SUMMARY_MAX * 0.6));
    const tail = merged.slice(-Math.floor(MERGED_SUMMARY_MAX * 0.35));
    return `${head}\n…（更早摘要已折叠，原文可用 recall_conversation 检索）…\n${tail}`;
  }

  _compressOldestBatch() {
    if (this.recent.length < SUMMARY_BATCH) return;
    const batch = this.recent.splice(0, SUMMARY_BATCH);
    for (const message of batch) this._recentChars -= ConversationMemory._messageChars(message);
    this._recentChars = Math.max(0, this._recentChars);
    const startTurn = this.totalTurns - this.recent.length - batch.length + 1;
    this._archiveBatch(batch, startTurn);
    this._notifyMessagesRemoved(batch);
    const endTurn = startTurn + batch.length - 1;
    this.summaries.push({ range: `turns ${startTurn}-${endTurn}`, text: this._summarizeBatch(batch) });
    if (this.summaries.length > MAX_SUMMARIES) {
      const a = this.summaries.shift();
      const b = this.summaries.shift();
      this.summaries.unshift({ range: `${a.range} + ${b.range}`, text: this._mergeSummaryText(a.text, b.text) });
    }
  }

  _summarizeBatch(batch) {
    const actions = new Set(), files = new Set(), lines = [];
    const clean = (value, max) => String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
    // 工具结果**掐头去尾都不行，要掐中间**。
    //
    // 报错的价值分布在两头：第一行说"是什么错"，最后几行说"根因/结论"，中间那一坨
    // stack frame 是噪音。而 slice(0, 320) 砍的正是末尾——实测一条真实的 pg 连接失败
    // （491 字符）过完这个函数，模型看到 "Error: connect ECONNREFUSED …" 加五行
    // node_modules 里的栈，而最后那句「根因：DATABASE_URL 指向 5432，而 compose 里映射的是
    // 5433」被截掉了。于是压缩之后模型知道"连不上库"，却不知道自己上一轮已经查出为什么，
    // 只能从头再查一遍——这正是「跑久了变蠢」。
    // 预算不变（还是 max），只是改成头 55% + 尾 45%，中间用 … 标出来。
    for (const msg of batch) {
      // 出货路径上**没有一条**历史消息带 tool_calls：assistant 消息带 tool_calls 却没有
      // 配套的 tool 角色回复是非法请求体，所以入账处一律 text-only（main.js 收尾那段有
      // 原话）。下面那个 msg.tool_calls 分支因此在真实会话里从不进入——Files:/Actions:
      // 两行恒为空。真正的来源是入账时挂在 _ideMeta 上的执行事实（_ideMeta 已在
      // _sanitizeProviderMessages 里被摘掉，不会发给上游）。
      const meta = msg?._ideMeta;
      if (meta && Array.isArray(meta.files)) {
        for (const f of meta.files) if (f) files.add(String(f));
        // 截断要说出来，别让"只改了 60 个"看起来像全部。
        if (Number(meta.filesTotal) > meta.files.length) files.add(`…共 ${meta.filesTotal} 个`);
      }
      if (msg.tool_calls) for (const tc of msg.tool_calls) {
        const n = tc.function?.name;
        if (n) {
          actions.add(n);
          // multi_edit 一度不在这张名单里，而它正是主力重构工具（它自己的工具描述写着
          // 「faster and more reliable than firing multiple edit_file calls」，鼓励模型优先用）。
          // 后果很具体：压缩掉最老那批消息之后，摘要是模型对那段历史的**唯一**替代物，
          // 而 multi_edit 改过的文件从 Files: 里静默消失——只剩一句「做过 multi_edit」。
          // 越是按建议用它做大改，压缩后越想不起来自己动过哪些文件。这是「跑久了变笨」
          // 的一种具体机制。format_file / create_dir / delete_path 同理，一并补上。
          // 参数名不止 path：move_path / copy_path 用的是 from + to，所以它们既不在这张
          // 名单里、就算加进来 `a.path` 也取不到——实测「Actions: move_path」在，而
          // Files: 里 src/old.ts → src/new.ts 两个都没有。摘要于是变成「做过一次移动，
          // 但不知道移的是什么」，比不记还误导。三个键都收。
          if (['write_file', 'edit_file', 'multi_edit', 'read_file', 'format_file',
               'create_dir', 'delete_path', 'move_path', 'copy_path'].includes(n)) {
            try {
              const a = JSON.parse(tc.function.arguments || '{}');
              for (const k of ['path', 'from', 'to']) if (a[k]) files.add(String(a[k]));
            } catch {}
          }
        }
      }
      const role = msg?.role === 'assistant' ? 'assistant'
        : msg?.role === 'user' ? 'user'
        : msg?.role === 'tool' ? 'tool'
        : 'system';
      // 工具结果走 cleanEnds（保住末尾的根因）；用户/助手的正文是连贯叙述，从头读就行。
      const text = role === 'tool'
        ? cleanEnds(msg?.content, 320)
        : clean(msg?.content, role === 'user' ? 700 : role === 'assistant' ? 520 : 320);
      if (text) lines.push(`[${role}] ${text}`);
      // 思考结论优先保留：助手消息尾部的〔推理摘要〕段被上面的 520 字截断裁掉时，
      // 补一条独立结论行（≤400 字），跨压缩边界仍能"接着想"而不是重新推导
      //（与 main.js 的 _thinkLedger 同一条治理线）。
      if (role === 'assistant' && typeof msg?.content === 'string') {
        const reasoningAt = msg.content.indexOf('〔推理摘要〕');
        if (reasoningAt >= 0 && !text.includes('〔推理摘要〕')) {
          lines.push(`[assistant·推理结论] ${clean(msg.content.slice(reasoningAt), 400)}`);
        }
      }
      const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
      if (attachments.length) {
        // 只写 kind 等于没写。用户把构建报错截图拖进来、一个字没打，压缩之后摘要里
        // 是「1 item(s): image」——之后他问「刚才那个报错是哪个文件报的」，模型既没有
        // 文件名也没有磁盘路径，连重新看一眼都做不到，只能反问「你说的是哪个报错」，
        // 而用户觉得自己十分钟前才给过。附件对象上 name / path 一直都在。
        const label = (x) => {
          const kind = x?.kind || "media";
          const name = x?.name || (x?.path ? String(x.path).split(/[\\/]/).pop() : "");
          return name ? `${kind}:${name}` : kind;
        };
        const shown = attachments.slice(0, 4).map(label).join(", ");
        const more = attachments.length > 4 ? ` 等 ${attachments.length} 个` : "";
        // 路径单独留一份：重新打开它要的是全路径，不是文件名。
        const paths = attachments.map((x) => x?.path).filter(Boolean).slice(0, 4);
        lines.push(`[attachments] ${attachments.length} item(s): ${shown}${more}`
          + (paths.length ? `（${paths.join("、")}）` : ""));
      }
    }
    const p = [];
    if (lines.length) p.push(lines.join('\n'));
    if (actions.size) p.push(`Actions: ${[...actions].join(', ')}`);
    if (files.size) p.push(`Files: ${[...files].join(', ')}`);
    return p.length ? p.join('\n') : 'Continued conversation.';
  }

  stats() {
    return { totalTurns: this.totalTurns, recentCount: this.recent.length, summaryCount: this.summaries.length, archiveCount: this.archive.length, correctionCount: this._activeCorrections('', MAX_CORRECTIONS).length, recentTokens: this.estimateRecentTokens() };
  }

  toJSON(mediaBudget = PERSISTED_MEDIA_BUDGET, options = {}) {
    // JSON.stringify calls toJSON with a string property key. Treat only an
    // explicit number/shared-budget object as the serializer override.
    const effectiveBudget = typeof mediaBudget === 'number' || (mediaBudget && typeof mediaBudget === 'object')
      ? mediaBudget
      : PERSISTED_MEDIA_BUDGET;
    const limit = Number.isFinite(options?.recentLimit)
      ? Math.max(0, Math.trunc(options.recentLimit))
      : this.recent.length;
    const recent = limit === 0 ? [] : limit < this.recent.length ? this.recent.slice(-limit) : this.recent;
    const transcriptLimit = Number.isFinite(options?.transcriptLimit)
      ? Math.max(0, Math.trunc(options.transcriptLimit))
      : this.transcript.length;
    const transcript = transcriptLimit === 0
      ? []
      : transcriptLimit < this.transcript.length
        ? this.transcript.slice(-transcriptLimit)
        : this.transcript;
    const serializedTranscriptOffset = this.transcriptOffset + Math.max(0, this.transcript.length - transcript.length);
    return {
      totalTurns: this.totalTurns,
      recent: serializeMessagesForPersistence(recent, effectiveBudget, { textBudget: options?.textBudget }),
      // This is deliberately independent from `recent` and `archive`: those two
      // serve bounded model context and retrieval, while transcript is the exact
      // local record used to restore a conversation after a restart.
      transcript: serializeMessagesForPersistence(transcript, effectiveBudget, { textBudget: options?.textBudget }),
      transcriptOffset: serializedTranscriptOffset || undefined,
      transcriptCheckpoint: options?.externalizeTranscript ? this.transcriptLength() : undefined,
      summaries: this.summaries,
      fileEvidence: this.fileEvidence,
      archive: this.archive,
      corrections: this.corrections,
    };
  }

  static fromJSON(obj) {
    const mem = new ConversationMemory();
    if (obj) {
      mem.totalTurns = obj.totalTurns || 0;
      mem.recent = Array.isArray(obj.recent) ? obj.recent : [];
      mem.transcript = Array.isArray(obj.transcript) ? obj.transcript : [];
      const checkpoint = Number.isFinite(obj.transcriptCheckpoint)
        ? Math.max(0, Math.trunc(obj.transcriptCheckpoint)) : null;
      mem.transcriptOffset = Number.isFinite(obj.transcriptOffset)
        ? Math.max(0, Math.trunc(obj.transcriptOffset)) : 0;
      // SQLite checkpoints externalize the entire exact transcript. Do not
      // synthesize one from `recent`: that would give old messages sequence 0
      // and let the next append overwrite stored history.
      if (checkpoint !== null && mem.transcript.length === 0) {
        mem.transcriptOffset = checkpoint;
      }
      mem._recentChars = mem.recent.reduce((total, message) => total + ConversationMemory._messageChars(message), 0);
      mem.summaries = obj.summaries || [];
      mem.fileEvidence = Array.isArray(obj.fileEvidence) ? obj.fileEvidence.slice(-80) : [];
      mem.archive = Array.isArray(obj.archive)
        ? obj.archive.slice(-MAX_ARCHIVE)
          .filter((e) => e && typeof e.text === 'string' && e.text)
          .map((e) => ({ turn: Math.max(0, Number(e.turn) || 0), role: String(e.role || 'assistant'), text: String(e.text).slice(0, ARCHIVE_ENTRY_MAX) }))
        : [];
      // Older session.json files only had compacted recent/archive memories.
      // Recover the best available display history once, then all future saves
      // persist the canonical transcript without another lossy conversion.
      // `transcriptOffset === 0` is what makes this branch safe: a genuinely legacy blob
      // starts at sequence 0, so synthesizing a transcript from archive+recent lands on the
      // sequences those messages already have. A session that HAS run against SQLite carries
      // a large offset, and synthesizing there inflates transcriptLength() by
      // archive+recent — the next append then jumps that far ahead and punches a permanent
      // gap in the journal, after which the backend refuses the window and the tab is dead.
      // (Reachable because _archiveChatSession serializes a closed tab without
      // externalizeTranscript, so the checkpoint field is absent while the offset is not.)
      if (!mem.transcript.length && checkpoint === null && mem.transcriptOffset === 0) {
        const legacyArchive = mem.archive.map((entry) => ({
          role: entry.role,
          content: entry.text,
        }));
        mem.transcript = legacyArchive.concat(mem.recent);
      }
      if (checkpoint !== null && mem.transcript.length && checkpoint <= mem.transcriptOffset + mem.transcript.length) {
        const localCheckpoint = Math.max(0, Math.min(mem.transcript.length, checkpoint - mem.transcriptOffset));
        const tail = mem.transcript.slice(localCheckpoint);
        if (tail.length) {
          mem.recent.push(...tail);
          for (const message of tail) mem._recentChars += ConversationMemory._messageChars(message);
          while (mem.recent.length > RECENT_WINDOW) mem._compressOldestBatch();
        }
      }
      mem.totalTurns = Math.max(mem.totalTurns, mem.transcriptOffset + mem.transcript.length, mem.recent.length);
      mem.corrections = Array.isArray(obj.corrections)
        ? obj.corrections.slice(-MAX_CORRECTIONS).map((item) => ({
          id: cleanCorrectionText(item?.id, 160),
          createdAt: Math.max(1, Number(item?.createdAt) || Date.now()),
          kind: ['user', 'reflection', 'memory'].includes(item?.kind) ? item.kind : 'memory',
          incorrect: cleanCorrectionText(item?.incorrect),
          corrected: cleanCorrectionText(item?.corrected),
          aliases: [...new Set((Array.isArray(item?.aliases) ? item.aliases : [])
            .map((value) => cleanCorrectionText(value, 240)).filter(Boolean))].slice(0, 12),
          topicTerms: memSearchTokens(`${(item?.aliases || []).join(' ')} ${item?.incorrect || ''} ${item?.corrected || ''}`).slice(0, 32),
          sourceTurns: [...new Set((Array.isArray(item?.sourceTurns) ? item.sourceTurns : [])
            .map((turn) => Math.max(0, Math.trunc(Number(turn) || 0))).filter(Boolean))].slice(0, 8),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0.8)),
          supersedes: cleanCorrectionText(item?.supersedes, 160),
        })).filter((item) => item.id && item.corrected)
        : [];
    }
    return mem;
  }
}
