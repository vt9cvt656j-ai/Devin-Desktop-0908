// 实时监听：用户**用**自己做的东西的时候，IDE 盯着运行时——预览页面的控制台、dev server 的终端、
// 抓包里的失败请求、桌面应用界面上的文字——出了问题就自己开一轮去修，不等用户把报错贴回来。
//
// 所有者 2026-09-07：「实时监听最有用，用户用的过程中出现问题或者出现 xxx 内容，他能够全自动去帮
// 用户去改内容、优化内容、操作，而不是傻傻等着用户一直手动反馈。」
//
// 这个文件只放纯逻辑（判错、去重、限流、规则匹配、拼通知），没有 DOM 和 backend；main.js 负责接
// 四个源头和 _queueNotice / _drainFollowups（后台监控等到条件时走的同一条路——那条路本来就能在
// 没有用户消息的情况下开一轮）。能在 Node 里跑的都在这里，测试做真往返。

export const LIVE_WATCH_STORE_KEY = "michael-ide.live-watch";

/** 事件来源。 */
export const WATCH_SOURCES = Object.freeze(["preview", "terminal", "capture", "screen"]);

export const DEFAULT_LIVE_WATCH = Object.freeze({
  // auto = 跟随「执行节奏」设置（自动推进→自动修，关键处确认→先提示，稳一点→只记录）；on / ask / off 是硬指定。
  mode: "auto",
  sources: Object.freeze({ preview: true, terminal: true, capture: true, screen: true }),
  rules: Object.freeze([]),
  // 同一签名多久内不再触发；十分钟内最多自动开几轮。
  cooldownSec: 600,
  maxPer10Min: 3,
});

export function normalizeLiveWatchConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mode = ["auto", "on", "ask", "off"].includes(r.mode) ? r.mode : "auto";
  const src = r.sources && typeof r.sources === "object" ? r.sources : {};
  const sources = {};
  for (const s of WATCH_SOURCES) sources[s] = src[s] === undefined ? DEFAULT_LIVE_WATCH.sources[s] : !!src[s];
  const rules = (Array.isArray(r.rules) ? r.rules : []).map(normalizeRule).filter(Boolean).slice(0, 50);
  const cooldownSec = Math.min(3600, Math.max(30, Number(r.cooldownSec) || DEFAULT_LIVE_WATCH.cooldownSec));
  const maxPer10Min = Math.min(20, Math.max(1, Number(r.maxPer10Min) || DEFAULT_LIVE_WATCH.maxPer10Min));
  return { mode, sources, rules, cooldownSec, maxPer10Min };
}

/** 一条用户规则：来源 + 要匹配的字（或正则）+ 匹配到了做什么（prompt）。screen 来源还要 app。 */
export function normalizeRule(raw) {
  const r = raw && typeof raw === "object" ? raw : null;
  if (!r) return null;
  const source = WATCH_SOURCES.includes(r.source) ? r.source : "any";
  const pattern = String(r.pattern || "").trim().slice(0, 300);
  const app = String(r.app || "").trim().slice(0, 120);
  const prompt = String(r.prompt || "").trim().slice(0, 2000);
  if (!pattern && source !== "capture") return null;
  if (source === "screen" && !app) return null;
  return {
    id: String(r.id || "").trim() || `rule_${Math.abs(hashText(source + pattern + app)).toString(36)}`,
    enabled: r.enabled !== false,
    source,
    pattern,
    isRegex: !!r.isRegex,
    app,
    prompt,
  };
}

/** mode 落到实际策略。autonomy 是自适应画像里的「执行节奏」。 */
export function resolveWatchPolicy(cfg, autonomy) {
  const mode = cfg && cfg.mode;
  if (mode === "on") return "auto";
  if (mode === "ask") return "ask";
  if (mode === "off") return "off";
  const a = String(autonomy || "proactive");
  if (a === "proactive") return "auto";
  if (a === "confirm") return "ask";
  return "off";
}

// ── 判错 ─────────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
export function stripAnsi(s) {
  return String(s || "").replace(ANSI_RE, "");
}

/** 终端输出里的失败信号：只认**强**形状（栈、panic、编译失败、端口占用），警告和弃用提示不算。 */
const TERMINAL_PATTERNS = [
  ["python-traceback", /Traceback \(most recent call last\)/],
  ["node-unhandled", /Unhandled(?:Promise)?Rejection|Unhandled promise rejection|uncaughtException|UnhandledPromiseRejectionWarning/],
  ["js-error", /(?:^|\n)\s*(?:Uncaught )?(?:TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|Error)(?: \[[A-Z_]+\])?: .+(?:\n\s+at .+){1,}/],
  ["rust-panic", /thread '[^']*' panicked at|panicked at '|error\[E\d{4}\]/],
  ["java-exception", /Exception in thread|(?:^|\n)\s*(?:[a-zA-Z_$][\w$]*\.)+[A-Z]\w*(?:Exception|Error): |Caused by: /],
  ["go-panic", /(?:^|\n)panic: |goroutine \d+ \[running\]/],
  ["php-fatal", /PHP Fatal error|Uncaught Error:|Uncaught Exception/],
  ["dotnet-exception", /Unhandled exception\.|System\.\w+Exception:/],
  ["compile-failed", /Failed to compile|error TS\d{4}|Build failed|build failed with|Compilation failed|could not compile/],
  ["module-missing", /Cannot find module|Module not found|ModuleNotFoundError|No module named/],
  ["port-in-use", /EADDRINUSE|address already in use|Address already in use/],
  ["conn-refused", /ECONNREFUSED|connection refused/i],
  ["http-500", /Internal Server Error|(?:^|\s)5\d\d (?:Internal )?Server Error/],
  ["fatal", /(?:^|\n)\s*(?:\[ERROR\]|ERROR[: ]|FATAL[: ]|fatal error:|Segmentation fault|segfault|core dumped)/],
];
const TERMINAL_NOISE = /(?:^|\n)[^\n]*(?:warning|deprecat|npm WARN|ExperimentalWarning|DeprecationWarning)[^\n]*(?:\n|$)/gi;

/**
 * 在**新到的这一段**输出里找失败信号。返回 { hit, pattern, excerpt }；excerpt 是命中行前后几行。
 * 只看新段：老输出早就报过了，重扫会让同一个栈在每次刷屏时反复触发。
 */
export function detectTerminalError(chunk, { minIndex = 0 } = {}) {
  const full = stripAnsi(chunk).replace(TERMINAL_NOISE, "\n");
  if (!full.trim()) return { hit: false, pattern: "", excerpt: "", index: -1 };
  // 调用方把「新到的这一段」拼在旧尾巴后面一起判（栈可能跨两次 PTY 回调），但命中必须落在新段里：
  // 老输出早报过了，每来一个字节都重扫旧栈会让同一个错误反复触发。从新段所在行的行首切开再找。
  const from = minIndex > 0 ? Math.max(0, full.lastIndexOf("\n", Math.min(minIndex, full.length)) + 1) : 0;
  const text = full.slice(from);
  for (const [name, re] of TERMINAL_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const lines = text.split(/\r?\n/);
    // 找到命中处所在的行号，向后多带几行（栈就在下面）。
    let at = 0;
    const idx = m.index;
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      acc += lines[i].length + 1;
      if (acc > idx) { at = i; break; }
    }
    const excerpt = lines.slice(Math.max(0, at - 2), at + 14).join("\n").trim().slice(0, 900);
    return { hit: true, pattern: name, excerpt, index: from + m.index };
  }
  return { hit: false, pattern: "", excerpt: "", index: -1 };
}

/** 预览页控制台：只要 error 级；几类已知噪音不算。 */
const PREVIEW_NOISE = /favicon\.ico|Download the React DevTools|\[HMR\]|\[vite\] (?:hot updated|connected|connecting)|ResizeObserver loop|Third-party cookie|was preloaded using link preload|DevTools failed to load source map/i;
export function detectPreviewError(level, msg) {
  if (String(level || "") !== "error") return false;
  const m = String(msg || "").trim();
  if (!m || PREVIEW_NOISE.test(m)) return false;
  return true;
}

/** 抓包：服务端错误才算（4xx 大多是页面自己的 404 / 401，噪音多）。 */
export function detectCaptureFailure(flow) {
  const st = Number(flow?.status || 0);
  if (st >= 500) return { hit: true, why: `HTTP ${st}` };
  if (flow?.error && !st) return { hit: true, why: String(flow.error).slice(0, 120) };
  return { hit: false, why: "" };
}

// ── 事件、去重、限流 ───────────────────────────────────────────────────────────

export function hashText(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}

/** 签名：同一个错误在不同时间、不同行号、不同哈希下长得一样。 */
export function eventSignature(source, text) {
  const norm = String(text || "")
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/[a-z0-9_-]{16,}/g, "#")       // 哈希、随机 id、chunk 名
    .replace(/(?:\/[\w.-]+)+/g, "/…")         // 路径
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${source}:${norm}`;
}

/**
 * 造一个事件。source ∈ WATCH_SOURCES；kind 说明是什么（preview_error / terminal_error / http_error /
 * screen_match / rule_match）；text 是给模型看的正文；where 是它发生在哪（URL / 终端名 / 应用名）。
 */
export function makeWatchEvent({ source, kind, text, where = "", extra = null, at = Date.now() } = {}) {
  const t = String(text || "").trim().slice(0, 2000);
  return {
    id: `w_${at.toString(36)}_${Math.abs(hashText(t)).toString(36).slice(0, 6)}`,
    source: WATCH_SOURCES.includes(source) ? source : "preview",
    kind: String(kind || "event"),
    text: t,
    where: String(where || "").slice(0, 300),
    extra: extra && typeof extra === "object" ? extra : null,
    at,
    sig: eventSignature(source, t),
  };
}

export function newWatchState() {
  return { sigs: {}, fires: [], recent: [] };
}

/** 用户规则匹配：来源对得上、字（或正则）在正文里。返回第一条匹配的规则。 */
export function matchRules(rules, ev) {
  const list = Array.isArray(rules) ? rules : [];
  for (const r of list) {
    if (!r || r.enabled === false) continue;
    if (r.source !== "any" && r.source !== ev.source) continue;
    if (r.source === "screen" && r.app && ev.where && r.app.toLowerCase() !== String(ev.where).toLowerCase()) continue;
    if (!r.pattern) { if (r.source === "capture") return r; continue; }
    if (r.isRegex) {
      try { if (new RegExp(r.pattern, "i").test(ev.text)) return r; } catch { /* 坏正则当没写 */ }
    } else if (ev.text.toLowerCase().includes(r.pattern.toLowerCase())) {
      return r;
    }
  }
  return null;
}

/**
 * 要不要为这个事件开一轮。去重（同签名冷却期内只报一次）+ 限流（十分钟内最多 N 次）。
 * 记录进 state（会改 state）。返回 { fire, reason }：fire=false 时 reason 是 off / duplicate / rate_limited。
 */
export function decideFire(state, ev, cfg, policy, now = Date.now()) {
  const s = state || newWatchState();
  const c = cfg || DEFAULT_LIVE_WATCH;
  const rec = { id: ev.id, at: now, source: ev.source, kind: ev.kind, text: ev.text.slice(0, 240), where: ev.where, outcome: "" };
  s.recent = [rec, ...(s.recent || [])].slice(0, 60);
  if (policy === "off") { rec.outcome = "recorded"; return { fire: false, reason: "off" }; }
  const last = s.sigs[ev.sig];
  if (last && now - last < c.cooldownSec * 1000) { rec.outcome = "duplicate"; return { fire: false, reason: "duplicate" }; }
  const window = 10 * 60 * 1000;
  s.fires = (s.fires || []).filter((t) => now - t < window);
  if (s.fires.length >= c.maxPer10Min) { rec.outcome = "rate_limited"; return { fire: false, reason: "rate_limited" }; }
  s.sigs[ev.sig] = now;
  s.fires.push(now);
  rec.outcome = policy === "auto" ? "auto" : "ask";
  return { fire: true, reason: policy === "auto" ? "auto" : "ask" };
}

// ── 通知正文 ──────────────────────────────────────────────────────────────────

const SOURCE_LABEL = { preview: "预览页面", terminal: "终端", capture: "抓包", screen: "应用界面" };

/**
 * 给模型的那条通知（走 _queueNotice）。全是事实：哪里、什么、最近的上下文、命中了哪条规则；
 * 最后一句说明这一轮该做什么——修（默认）或按规则的 prompt 做。
 */
export function composeWatchNotice(ev, { rule = null, tail = "", previewUrl = "", terminalLabel = "", workspaceRoot = "" } = {}) {
  const src = SOURCE_LABEL[ev.source] || ev.source;
  const whereLine = ev.source === "preview" ? `预览页面 ${ev.where || previewUrl || ""}（浏览器控制台）`
    : ev.source === "terminal" ? `终端「${terminalLabel || ev.where || ""}」的输出`
    : ev.source === "capture" ? `抓包 ${ev.where || ""}`
    : ev.source === "screen" ? `应用「${ev.where || ""}」的界面` : src;
  const parts = [];
  parts.push(`〔实时监听〕用户正在使用应用时，IDE 在${whereLine}发现了${rule ? "规则命中" : "问题"}：`);
  parts.push("```");
  parts.push(ev.text);
  parts.push("```");
  if (tail) {
    parts.push(`最近的输出（供定位）：`);
    parts.push("```");
    parts.push(String(tail).trim().slice(-2500));
    parts.push("```");
  }
  if (workspaceRoot) parts.push(`工作区：${workspaceRoot}`);
  if (rule && rule.prompt) {
    parts.push(`用户设的规则「${rule.pattern || rule.source}」命中，要求：${rule.prompt}`);
  } else {
    parts.push("要做的事：定位根因并修好（改源码、改配置、补依赖），修完用项目自己的检查（诊断 / 构建 / 测试）确认；"
      + "只有在必须看到页面才能确认时才用 browser / read_screen。修不了或判断这不是问题，就说清楚为什么并停下。");
  }
  const display = `${rule ? "规则命中" : "发现问题"} · ${src}：${ev.text.split("\n")[0].slice(0, 90)}`;
  return {
    text: parts.join("\n"),
    display,
    task: `实时监听 — ${src}`,
    status: rule ? `命中规则「${(rule.pattern || rule.source).slice(0, 40)}」` : `${ev.kind}`,
  };
}

/** 「先提示」模式下给用户看的那句话。 */
export function describeWatchEventForUser(ev) {
  const src = SOURCE_LABEL[ev.source] || ev.source;
  return `${src}${ev.where ? `（${ev.where.slice(0, 60)}）` : ""}：${ev.text.split("\n")[0].slice(0, 120)}`;
}
