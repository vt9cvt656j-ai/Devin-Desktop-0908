// 核心记忆 —— 每轮都在场、字节稳定、可编辑的那一小块。
//
// # 它补的是这套记忆里缺的那一层
//
// 2026-09-05 量过盘上的真实数据（38 个项目、136 条 KG 笔记、1331 条情景档案）：
//   · 跨项目的全局库 **0 条** —— 用户是谁、怎么干活，从来没有地方落；
//   · 每轮注入的 KG 块里平均 1.8 条相关命中配 4.7 条「无条件常驻」，39% 的轮次相关命中为 0；
//   · 71% 的笔记从未被检索命中。
// 「每轮必带的约束」这个角色被塞在按相关性检索的块里：既挤掉相关内容，又因为每写一条
// 新笔记就换一次内容而打断上游的前缀缓存。
//
// # 分工（和 KG 笔记的区别）
//
//   · 核心记忆：**少**（用户层 ≤16 条、项目层 ≤12 条）、每轮必带、渲染成确定性文本进系统
//     提示（走网关时随 adaptiveBlock 一起送上去，两条线路都到得了模型）。改动有版本：
//     新条目 supersede 旧条目，旧的留作审计、不再渲染。
//   · KG 笔记：**多**、按本轮相关性检索、进每轮尾部的动态块。
// 一句话要么是约束（进核心），要么是资料（留 KG）。被提升进核心的 KG 笔记打 core:true，
// 检索侧就不再把它当常驻带 —— 同一句话不进两次。
//
// # 三条不许越的线
//
//   1. 渲染必须是纯函数：同一份条目 → 逐字节相同的文本。里面不许出现时间戳、id、计数。
//      这块坐在系统提示里，一个字节变了整条前缀缓存就作废。
//   2. 用户亲口说的（source=user）永远排在模型自己记的前面，淘汰时也最后才轮到它。
//      模型记的带 [你记的] 前缀渲染 —— 和 KG 那边 _KG_RECORDED 戳是同一个道理：
//      模型看见的必须能分清「用户的规矩」和「我自己的笔记」。
//   3. 存储由宿主注入。模块不碰 localStorage / Tauri store 全局：测试里用内存桩，
//      生产由 main.js 传真实的进来。

export const CORE_LIMITS = {
  user: { entries: 16, chars: 1400 },
  project: { entries: 12, chars: 1200 },
};
export const CORE_KINDS = ["preference", "rule", "fact", "goal"];
export const CORE_SOURCES = ["user", "agent", "seed", "promoted"];
/** 模型自己记的条目渲染时带的前缀。 */
export const CORE_AGENT_MARK = "[你记的]";

let _storage = null;   // { getItem(k), setItem(k, v), removeItem?(k) }
let _mirror = null;    // async (key, entries) => void；宿主的文件镜像，失败只吞掉
let _stat = null;      // (key) => void；记忆统计，可选

export function configureCoreMemory(deps = {}) {
  if (deps.storage && typeof deps.storage.getItem === "function") _storage = deps.storage;
  if (typeof deps.mirror === "function") _mirror = deps.mirror;
  if (typeof deps.stat === "function") _stat = deps.stat;
}

export function coreKey(scope) { return "michael-ide.core:" + (scope || "_global"); }
function limitsFor(scope) { return scope ? CORE_LIMITS.project : CORE_LIMITS.user; }
function bump(key) { try { if (_stat) _stat(key); } catch {} }

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}
/** 判重用的词：ASCII 整词 + 中文双字滑窗。和 KG 那边的分词是同一个思路，故意不引用它。 */
export function coreTokens(text) {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z_][a-z0-9_./-]{1,}/g) || []) out.add(w.replace(/[.\-/]+$/, ""));
  for (const run of t.replace(/[^一-龥]+/g, " ").split(/\s+/)) {
    if (run.length < 2) continue;
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sanitize(entry) {
  if (!entry || typeof entry !== "object") return null;
  const text = normalizeText(entry.text);
  if (text.length < 4) return null;
  return {
    id: String(entry.id || "").slice(0, 40) || newId(),
    text,
    kind: CORE_KINDS.includes(entry.kind) ? entry.kind : "fact",
    source: CORE_SOURCES.includes(entry.source) ? entry.source : "agent",
    confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0.8)),
    created: Math.max(1, Number(entry.created) || Date.now()),
    updated: Math.max(1, Number(entry.updated) || Number(entry.created) || Date.now()),
    supersededBy: String(entry.supersededBy || ""),
    seen: Math.max(0, Math.trunc(Number(entry.seen) || 0)),
  };
}
function newId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 读全量（含已作废的）。坏 JSON 当空表，绝不抛：这条链挂在发消息的路径上。 */
export function coreLoad(scope) {
  if (!_storage) return [];
  let raw = null;
  try { raw = _storage.getItem(coreKey(scope)); } catch { return []; }
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(sanitize).filter(Boolean) : [];
  } catch { return []; }
}

function persist(scope, entries) {
  if (!_storage) return false;
  try { _storage.setItem(coreKey(scope), JSON.stringify(entries)); } catch { return false; }
  if (_mirror) { try { Promise.resolve(_mirror(coreKey(scope), entries)).catch(() => {}); } catch {} }
  return true;
}

/** 现役条目：没被作废的，按写入时间升序 —— 渲染顺序也是它，所以两处不会漂。 */
export function coreActive(scope) {
  return coreLoad(scope).filter((e) => !e.supersededBy).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

/**
 * 淘汰到上限以内。**先淘汰模型记的，再淘汰最老的**；用户亲口说的永远最后。
 * 上限有两道：条数和总字数，任一超了都淘汰 —— 这块进系统提示，字数才是真正的成本。
 */
function enforceLimits(scope, entries) {
  const lim = limitsFor(scope);
  const active = () => entries.filter((e) => !e.supersededBy);
  const chars = () => active().reduce((n, e) => n + e.text.length + 3, 0);
  const rank = (e) => (e.source === "user" ? 2 : e.source === "seed" ? 1 : 0);
  while (active().length > lim.entries || chars() > lim.chars) {
    const victims = active().sort((a, b) => rank(a) - rank(b) || a.updated - b.updated || a.created - b.created);
    const v = victims[0];
    if (!v) break;
    v.supersededBy = "evicted";
  }
  // 已作废的只留最近 40 条审计，别让存储无限长。
  const gone = entries.filter((e) => e.supersededBy).sort((a, b) => b.updated - a.updated);
  const keepGone = new Set(gone.slice(0, 40).map((e) => e.id));
  return entries.filter((e) => !e.supersededBy || keepGone.has(e.id));
}

/**
 * 写入一条。重复（同义到 0.8 以上）就返回已有那条并计一次 seen，不新增。
 * 给了 supersedes 就把那条作废；不给的话**不自动作废相近条目** —— 「用中文回答」和
 * 「用中文写注释」相似度很高但不是同一件事，自动作废会把对的删掉。要换掉旧条目，
 * 走 coreSupersede（明确纠正那条路才会调它）。
 */
export function coreUpsert(scope, input = {}) {
  const next = sanitize({ ...input, id: input.id || newId(), created: input.created || Date.now(), updated: Date.now() });
  if (!next) { bump("core.rejected"); return null; }
  const entries = coreLoad(scope);
  const toks = coreTokens(next.text);
  const dup = entries.find((e) => !e.supersededBy && (e.text.toLowerCase() === next.text.toLowerCase() || jaccard(coreTokens(e.text), toks) >= 0.8));
  if (dup) {
    dup.seen += 1; dup.updated = Date.now();
    // 用户亲口重申一条模型记的 → 升格为用户的。反过来不降。
    if (next.source === "user" && dup.source !== "user") dup.source = "user";
    persist(scope, entries);
    bump("core.dup");
    return { ...dup };
  }
  const _sup = String(input.supersedes || "");
  if (_sup) {
    const old = entries.find((e) => e.id === _sup);
    if (old && !old.supersededBy) { old.supersededBy = next.id; old.updated = Date.now(); }
  }
  entries.push(next);
  const bounded = enforceLimits(scope, entries);
  persist(scope, bounded);
  bump("core.added");
  return { ...next };
}

/** 用一条新的换掉旧的（明确纠正）。旧的留作审计，不再渲染。 */
export function coreSupersede(scope, oldId, text, source = "user") {
  const entries = coreLoad(scope);
  const old = entries.find((e) => e.id === String(oldId || ""));
  if (!old) return null;
  return coreUpsert(scope, { text, kind: old.kind, source, supersedes: old.id, confidence: 0.9 });
}

/**
 * 面板保存：按行整体重建。文本没变的条目**保留原 id 和来源**（否则每次保存都把用户
 * 早先记的变成"刚记的"，模型记的也全洗成用户说的）；删掉的行作废；新行按用户来源新增。
 */
export function coreReplaceAll(scope, lines, source = "user") {
  const wanted = (Array.isArray(lines) ? lines : String(lines || "").split("\n"))
    .map((l) => normalizeText(String(l).replace(/^[-*]\s*/, "").replace(new RegExp("^" + CORE_AGENT_MARK.replace(/[[\]]/g, "\\$&") + "\\s*"), "")))
    .filter((l) => l.length >= 4);
  const entries = coreLoad(scope);
  const keep = new Set();
  for (const text of wanted) {
    const existing = entries.find((e) => !e.supersededBy && e.text.toLowerCase() === text.toLowerCase());
    if (existing) { keep.add(existing.id); continue; }
    const fresh = sanitize({ id: newId(), text, kind: guessKind(text), source, created: Date.now(), updated: Date.now() });
    if (fresh) { entries.push(fresh); keep.add(fresh.id); }
  }
  for (const e of entries) if (!e.supersededBy && !keep.has(e.id)) { e.supersededBy = "removed"; e.updated = Date.now(); }
  const bounded = enforceLimits(scope, entries);
  persist(scope, bounded);
  return bounded.filter((e) => !e.supersededBy).length;
}

/** 给面板/导入用的粗分类。不追求准：kind 只影响渲染分组，不影响是否常驻。 */
export function guessKind(text) {
  const t = String(text || "");
  if (/目标|要做成|做一个|产品是|项目是|goal/i.test(t)) return "goal";
  if (/必须|禁止|不许|一律|别用|不要用|禁用|绝不|永远不/.test(t)) return "rule";
  if (/喜欢|偏好|习惯|风格|口味|prefer|希望|尽量|优先|回复|回答|语言|中文|英文/.test(t)) return "preference";
  return "fact";
}

/**
 * 渲染成进提示词的文本。**纯函数于条目内容**：没有时间、没有 id、没有计数。
 * 空的就返回空串 —— 没内容不许白付每轮的钱（user-rules 那边的既有不变量）。
 */
export function renderCoreBlock(scope, opts = {}) {
  const entries = coreActive(scope);
  if (!entries.length) return "";
  const title = scope ? "【核心记忆·本项目】" : "【核心记忆·用户】";
  const lead = scope
    ? "本项目的目标、约定和禁忌，每轮常驻。"
    : "跨项目常驻的用户偏好与规矩。";
  const note = `带 ${CORE_AGENT_MARK} 的是你自己在运行中记下的，不是用户的规矩，权重分开；与本轮明确指令冲突时以指令为准。`;
  const users = entries.filter((e) => e.source === "user" || e.source === "seed" || e.source === "promoted");
  const agents = entries.filter((e) => e.source === "agent");
  const lines = [
    ...users.map((e) => `- ${e.text}`),
    ...agents.map((e) => `- ${CORE_AGENT_MARK} ${e.text}`),
  ];
  const head = opts.compact ? `${title}` : `${title}${lead}${note}`;
  return `\n\n${head}\n${lines.join("\n")}\n`;
}

/** KG 笔记要不要升进核心：只认「约束类」且不是机器批量写的档案/规律。 */
export function shouldPromote(note) {
  if (!note || typeof note !== "object") return false;
  const c = String(note.content || "").trim();
  if (c.length < 5 || c.length > 200) return false;
  if (/^项目(?:环境|档案):|^〔跨轮规律〕|^\[据本轮归纳\]/.test(c)) return false;
  return note.type === "preference" || note.type === "convention";
}
/** 把一条 KG 笔记提升进核心。返回核心条目；不够格返回 null。 */
export function corePromoteNote(scope, note, source = "promoted") {
  if (!shouldPromote(note)) return null;
  const text = String(note.content || "").replace(/^\[[^\]\n]{1,16}\]\s*/, "").trim();
  return coreUpsert(scope, { text, kind: note.type === "convention" ? "rule" : "preference", source, confidence: 0.85, created: note.created });
}

/** 写进项目里那份 memory.md 的一节。用户手改这一节 → 下次打开项目读回。 */
export function coreMarkdownSection(scope) {
  const entries = coreActive(scope);
  if (!entries.length) return "";
  return ["## 核心记忆（每轮常驻）", "", ...entries.map((e) => `- ${e.source === "agent" ? CORE_AGENT_MARK + " " : ""}${e.text}`)].join("\n");
}
/** 从 memory.md 读回核心那一节；只认列表项。返回导入条数。 */
export function coreImportMarkdown(scope, text) {
  const src = String(text || "");
  const at = src.search(/^## 核心记忆/m);
  if (at < 0) return 0;
  const afterHead = src.indexOf("\n", at);
  if (afterHead < 0) return 0;
  const rest = src.slice(afterHead + 1);
  const nextHead = rest.search(/^## /m);
  const body = nextHead >= 0 ? rest.slice(0, nextHead) : rest;
  let n = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    const isAgent = body.startsWith(CORE_AGENT_MARK);
    const t = isAgent ? body.slice(CORE_AGENT_MARK.length).trim() : body;
    if (coreUpsert(scope, { text: t, kind: guessKind(t), source: isAgent ? "agent" : "user" })) n++;
  }
  return n;
}

/** 从文件镜像读回：只在本地一条都没有时才写，本地有就不碰（文件是备份，不是权威）。 */
export function coreRestore(scope, entries) {
  if (!Array.isArray(entries) || !entries.length || !_storage) return 0;
  if (coreLoad(scope).length) return 0;
  const clean = entries.map(sanitize).filter(Boolean);
  try { _storage.setItem(coreKey(scope), JSON.stringify(clean)); } catch { return 0; }
  return clean.length;
}

export function coreStats(scope) {
  const all = coreLoad(scope);
  const active = all.filter((e) => !e.supersededBy);
  return {
    active: active.length,
    superseded: all.length - active.length,
    bySource: active.reduce((m, e) => { m[e.source] = (m[e.source] || 0) + 1; return m; }, {}),
    chars: active.reduce((n, e) => n + e.text.length, 0),
  };
}
