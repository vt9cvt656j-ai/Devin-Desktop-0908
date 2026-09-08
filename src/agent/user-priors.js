// 用户先验 —— 「这个人这么说话时，通常是想干什么」。
//
// 所有者 2026-09-08：「要完全完全能够预判用户要做的事情，而不是瞎猜，也不是瞎搞，
// 你可以不断收集数据保存他的本地」。
//
// 缺口是结构性的：意图裁决那次调用的输入里**没有一个字段是关于这个用户的**，
// 它每个会话遇到的都是陌生人。而四个记忆库（核心 / KG / 情景 / 工作流）确实在长，
// 但一个字都到不了裁决——记住的东西只影响「怎么干」，从不影响「判成什么」。
// 这个模块补的就是那条边，而且只补那一条。
//
// ── 三条设计约束，每条都有踩过的坑撑着 ──────────────────────────────
//
// ① **不瞎猜**：规律的支持度是**数出来**的，不是模型说的。统计层（cells）是纯计数，
//    模型只做一件事：把「6 次里 4 次返工」翻译成下次能照做的一句话。它不做发现。
//    判错的标签也全部来自执行事实（返工 / 中途被纠正 / 声明与执行不符 / 没成功），
//    没有一处靠词表猜语义。
//
// ② **不撑爆输入**：注入量的上界由**裁决的输出空间**钉死，与库存量无关。裁决要填的是
//    有限枚举，一个字段塞两条先验只会互相稀释，所以按字段分桶、每桶一条、最多 4 条、
//    ≤600 字节。库里 6 条和 600 条，注入的字节数完全一样。
//    这不是检索问题。实测教训：240 条流水喂进蒸馏产出为 0，卡的是输入规模。
//
// ③ **不夺能力**：先验只作为文本进裁决的输入，**不进任何 harness 闸门**。判歪的最坏
//    后果是「裁决多考虑了一个错的先验」，不可能是「某个工具被直接夺走」。
//    这条由 test/user-priors.test.mjs 的可达性断言钉着。
//
// ── 两个必须记住的坑 ─────────────────────────────────────────────
//
// · **pickUserPriors 必须是确定性的。** 裁决的缓存键是整个 boundedContext 的指纹。
//   这里只要带上毫秒时间戳或随机数，同一轮内两次调用就产出不同指纹，15 分钟裁决缓存
//   整个失效。所以 mute 的判定用**天粒度**，不用毫秒。
// · **注入依赖要传惰性引用。** 调用方 configure 的时机远早于 _taskSim 那批函数的定义处，
//   传裸函数名是 TDZ。
//
// 用户作用域和项目作用域**物理隔离**：这里的键不带 root（抄 michael-ide.model-caps 的形状，
// 那是「这台机器上的事实」）；项目规律仍走现有 KG 的〔跨轮规律〕，两条腿不同的键、不同的
// 归纳提示词、不同的注入点、不同的读者。项目规律永远不进裁决（它对「用户想干什么」零信息），
// 用户规律永远不进主上下文（塞给主模型只会让它去揣摩用户而不是干活）。

export const SIGNALS_KEY = "michael-ide.user-signals";
export const PRIORS_KEY = "michael-ide.user-priors";
export const PRIORS_ARCHIVE_KEY = "michael-ide.user-priors-archive";
export const PRIORS_MODE_KEY = "michael-ide.user-priors-mode";
export const DISTILL_MARK_KEY = "michael-ide.user-distill-at";

/** 结论只能落在这几个字段上。落不进白名单的条目直接丢——这道结构闸比「禁止空话」
 *  那句提示词硬得多：空话写不出合法的 field。 */
export const PRIOR_FIELDS = ["ws", "rm", "plan", "om", "cont", "act"];

/** 样本不足就别下结论。和 _MODEL_CAP_MIN_SAMPLES 同一档，理由相同。 */
export const MIN_SUPPORT = 4;
/** 判错率低于这个数的格子不值得当先验——它说明当时判得挺对。 */
export const MIN_BAD_RATE = 0.4;
export const MAX_PRIORS = 64;
export const MAX_INJECT = 4;
export const MAX_INJECT_BYTES = 600;
const MAX_CELLS = 300;
const MAX_RING = 200;
const MAX_SHAPES = 120;
const MUTE_DAYS = 14;
const DAY_MS = 86400000;

let _storage = null;
let _taskWords = (s) => String(s || "").toLowerCase().split(/\W+/).filter(Boolean);
let _taskSim = () => 0;
let _now = () => Date.now();

export function configureUserPriors(deps = {}) {
  if (deps.storage && typeof deps.storage.getItem === "function") _storage = deps.storage;
  if (typeof deps.taskWords === "function") _taskWords = deps.taskWords;
  if (typeof deps.taskSim === "function") _taskSim = deps.taskSim;
  if (typeof deps.now === "function") _now = deps.now;
}

function _read(key, fallback) {
  try {
    const raw = _storage?.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch { return fallback; }
}
function _write(key, value) {
  try { _storage?.setItem(key, JSON.stringify(value)); } catch { /* 配额 / 不可用 */ }
}
/** 天粒度。**不要换成毫秒**：这个值会进裁决的缓存指纹，见文件头。 */
function _today() { return Math.floor(_now() / DAY_MS); }

// ── 表达形状 ────────────────────────────────────────────────────────
//
// 形状**完全由裁决自己的输出坐标 + 一个物理量**组成，一个词表都不用。
// 用正则/词表分类是这个项目明令禁止的（声明优先）：那正是「瞎猜」。
// act / cont / amb 是裁决声明的，len 是可观测的物理量。

export function lenBucket(text) {
  const n = String(text || "").trim().length;
  return n < 15 ? "S" : n <= 60 ? "M" : "L";
}

export function shapeOf(verdict, text) {
  const v = verdict || {};
  const act = String(v.act || "?").slice(0, 16);
  const cont = String(v.cont || "?").slice(0, 16);
  const amb = Number(v.amb) > 0 ? "+amb" : "";
  return `${act}/${cont}${amb}:${lenBucket(text)}`;
}

/**
 * 「这一轮判错了吗」——四个来源全是执行事实，没有一处靠猜。
 *  · 用户半小时内又提了同一件事（返工）
 *  · 用户中途插话纠正
 *  · 声明与执行不符（verdictMismatch）
 *  · 压根没成功
 */
export function isBadTurn(ep) {
  const e = ep || {};
  return !!(e.reworkedAt || e.steer || (Array.isArray(e.mm) && e.mm.length)
    || (e.outcome && e.outcome !== "success"));
}

/**
 * 声明 vs 执行事实的不符。全部由已有字段就地算：不需要模型、不需要正则猜语义。
 * 这是「判错」里最干净的一类——完全不依赖用户有没有抱怨，纯自证。
 */
export function verdictMismatch(ep) {
  const e = ep || {};
  const vd = e.vd || {};
  const files = Array.isArray(e.files) ? e.files : [];
  const walls = Array.isArray(e.walls) ? e.walls : [];
  const out = [];
  if ((vd.ws === "none" || vd.ws === "inspect") && files.length > 0) out.push("ws_none_but_wrote");
  if (vd.ws === "modify" && files.length === 0 && e.outcome === "success") out.push("ws_mod_no_write");
  if (vd.rm === "none" && walls.some((w) => /web_fetch|web_search|browser/.test(String(w)))) out.push("rm_none_but_searched");
  if (vd.plan === true && Number(e.steps) < 4) out.push("plan_on_tiny");
  if (vd.om && vd.om !== "solo" && !(Array.isArray(e.dispatch) && e.dispatch.length)) out.push("orch_declared_not_dispatched");
  return out;
}

// ── 统计层 ──────────────────────────────────────────────────────────

export function loadSignals() {
  const s = _read(SIGNALS_KEY, null);
  if (!s || typeof s !== "object") return { v: 1, updated: 0, cells: {}, shapes: {}, ring: [] };
  return {
    v: 1,
    updated: Number(s.updated) || 0,
    cells: s.cells && typeof s.cells === "object" ? s.cells : {},
    shapes: s.shapes && typeof s.shapes === "object" ? s.shapes : {},
    ring: Array.isArray(s.ring) ? s.ring : [],
  };
}

function _trimCells(cells) {
  const keys = Object.keys(cells);
  if (keys.length <= MAX_CELLS) return cells;
  // 按样本数淘汰：样本少的格子本来也过不了支持度门槛。
  const keep = keys.sort((a, b) => (cells[b].n || 0) - (cells[a].n || 0)).slice(0, MAX_CELLS);
  const out = {};
  for (const k of keep) out[k] = cells[k];
  return out;
}

function _trimShapes(shapes) {
  const keys = Object.keys(shapes);
  if (keys.length <= MAX_SHAPES) return shapes;
  const keep = keys.sort((a, b) => (shapes[b] || 0) - (shapes[a] || 0)).slice(0, MAX_SHAPES);
  const out = {};
  for (const k of keep) out[k] = shapes[k];
  return out;
}

/**
 * 一轮收尾时记一次。`text` 是用户这一轮的原话，只用来算形状和存 40 字的线索，
 * **不整句落盘**（归纳时也明令不许抄用户原话）。
 */
export function recordTurnSignal({ text, ep } = {}) {
  if (!ep || !ep.vd) return null;                 // 没有裁决结果的轮次不入账：配不上「判成了什么」
  const signals = loadSignals();
  const shape = shapeOf(ep.vd, text);
  const bad = isBadTurn(ep) ? 1 : 0;

  signals.shapes[shape] = (signals.shapes[shape] || 0) + 1;
  // 一个格子 = 「这种表达形状 + 当时判成的那个值」。判错率按格子统计，
  // 于是「你说这种话时我判成 X，6 次里 4 次返工」是数出来的。
  for (const field of PRIOR_FIELDS) {
    const value = ep.vd[field];
    if (value === undefined || value === null || value === "") continue;
    const key = `${shape}|${field}=${String(value).slice(0, 24)}`;
    const cell = signals.cells[key] || { n: 0, bad: 0 };
    cell.n += 1;
    cell.bad += bad;
    signals.cells[key] = cell;
  }
  signals.ring.push({
    t: _today(),
    q: String(text || "").trim().slice(0, 40),
    vd: ep.vd,
    bad,
    mm: Array.isArray(ep.mm) ? ep.mm.slice(0, 4) : [],
  });
  if (signals.ring.length > MAX_RING) signals.ring = signals.ring.slice(-MAX_RING);
  signals.cells = _trimCells(signals.cells);
  signals.shapes = _trimShapes(signals.shapes);
  signals.updated = _now();
  _write(SIGNALS_KEY, signals);
  return { shape, bad };
}

// ── 先验库 ──────────────────────────────────────────────────────────

export function loadPriors() {
  const list = _read(PRIORS_KEY, []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p === "object") : [];
}
function _savePriors(list) { _write(PRIORS_KEY, list.slice(0, MAX_PRIORS)); }

function _priorId(when, field) {
  const base = `${field}|${String(when).slice(0, 60)}`;
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) { h ^= base.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "up" + (h >>> 0).toString(36);
}

/**
 * 把归纳出来的条目并进库。非法 field 直接丢——这是那道结构闸。
 * 已存在的同 id 只更新文案和支持度，**胜负账保留**：那是它自己的实证读数。
 */
export function applyDistilledPriors(items) {
  const list = loadPriors();
  const byId = new Map(list.map((p) => [p.id, p]));
  let added = 0, dropped = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const field = String(raw?.field || "").trim();
    const when = String(raw?.when || "").trim();
    const then = String(raw?.then || "").trim();
    if (!PRIOR_FIELDS.includes(field) || when.length < 4 || then.length < 4) { dropped++; continue; }
    const id = _priorId(when, field);
    const support = String(raw?.support || "").slice(0, 40);
    const prev = byId.get(id);
    if (prev) {
      prev.when = when.slice(0, 80); prev.then = then.slice(0, 80); prev.support = support;
      prev.updated = _today();
    } else {
      const entry = {
        id, field, when: when.slice(0, 80), then: then.slice(0, 80), support,
        n: Math.max(MIN_SUPPORT, Number(raw?.n) || MIN_SUPPORT),
        wins: 0, losses: 0, injected: 0, mutedUntil: 0, created: _today(), updated: _today(),
      };
      list.push(entry); byId.set(id, entry); added++;
    }
  }
  if (list.length > MAX_PRIORS) {
    // 超了按「净胜场，再按样本」淘汰，淘汰的**进档案不删除**。
    list.sort((a, b) => ((b.wins - b.losses) - (a.wins - a.losses)) || ((b.n || 0) - (a.n || 0)));
    const evicted = list.splice(MAX_PRIORS);
    const arc = _read(PRIORS_ARCHIVE_KEY, []);
    _write(PRIORS_ARCHIVE_KEY, (Array.isArray(arc) ? arc : []).concat(evicted).slice(-200));
  }
  _savePriors(list);
  return { added, dropped, total: list.length };
}

/**
 * 把形状串渲染成模型读得懂的一句话。`create/new:S` 对人和模型都是密码，而这一层是
 * 冷启动时**唯一**的先验来源（还没攒够去跑归纳），说不清就等于没有。
 * 只翻译坐标，不添油加醋：每个词都对应形状里的一个分量。
 */
export function describeShape(shape) {
  const [head, len] = String(shape || "").split(":");
  const [act = "", rest = ""] = String(head).split("/");
  const cont = rest.replace("+amb", "");
  const amb = rest.includes("+amb");
  const contText = { new: "开了个新话题", continue: "接着上一轮", correct: "在纠正上一轮",
    replace: "推翻上一轮重来", clarify: "在澄清" }[cont] || (cont ? `关系是 ${cont}` : "");
  const lenText = { S: "很短的一句", M: "中等长度", L: "很长的一段" }[len] || "";
  return [lenText, contText, act ? `动作判成 ${act}` : "", amb ? "而且带着没问清的点" : ""]
    .filter(Boolean).join("、");
}

/** 冷启动第 1 段：跳过模型，直接把最强的那个统计格子渲染成一条先验。零模型调用就开始有用。 */
export function statisticalPriors(signals = loadSignals()) {
  const out = [];
  for (const [key, cell] of Object.entries(signals.cells || {})) {
    const n = Number(cell?.n) || 0, bad = Number(cell?.bad) || 0;
    if (n < MIN_SUPPORT || bad / n < 0.5) continue;
    const at = key.indexOf("|");
    const shape = key.slice(0, at);
    const assign = key.slice(at + 1);
    const field = assign.split("=")[0];
    if (!PRIOR_FIELDS.includes(field)) continue;
    out.push({
      id: _priorId(shape, field), field, when: describeShape(shape) || shape, shape,
      then: `上次这样判是 ${assign}，${n} 次里有 ${bad} 次判完就返工或被你纠正`,
      support: `${n} 次中 ${bad} 次`, n, bad, wins: 0, losses: 0, mutedUntil: 0, stat: true,
    });
  }
  return out.sort((a, b) => (b.bad / b.n) - (a.bad / a.n) || b.n - a.n);
}

// ── 挑选与注入 ──────────────────────────────────────────────────────

function _usable(p, today) {
  if (!p || !PRIOR_FIELDS.includes(p.field)) return false;
  if ((Number(p.n) || 0) < MIN_SUPPORT) return false;
  if (Number(p.mutedUntil) > today) return false;
  return true;
}

/**
 * 挑出这一轮要注入的几条。**必须是确定性的**（见文件头）。
 *
 * 上界由裁决的输出空间钉死：按 field 分桶、每桶一条、最多 4 条、≤600 字节。
 * 只有「同一个 field 有多条候选」时才发生检索，那里用现成的 bigram 相似度在桶内排一次序。
 */
export function pickUserPriors(text, opts = {}) {
  const today = Number.isFinite(opts.today) ? opts.today : _today();
  const pool = (Array.isArray(opts.priors) ? opts.priors : loadPriors())
    .filter((p) => _usable(p, today));
  const stat = Array.isArray(opts.statistical) ? opts.statistical : [];
  const all = pool.length ? pool : stat.filter((p) => _usable(p, today));
  if (!all.length) return [];

  const words = _taskWords(String(text || ""));
  const bucket = lenBucket(text);
  const buckets = new Map();
  for (const p of all) {
    const sim = (() => { try { return Number(_taskSim(words, _taskWords(p.when))) || 0; } catch { return 0; } })();
    const score = 3 * sim
      + (String(p.shape || "").endsWith(`:${bucket}`) ? 2 : 0)
      + ((Number(p.wins) || 0) - (Number(p.losses) || 0)) * 0.1;
    const prev = buckets.get(p.field);
    // 同分按 id 定序，保证确定性。
    if (!prev || score > prev.score || (score === prev.score && p.id < prev.p.id)) {
      buckets.set(p.field, { p, score });
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1));
  const out = [];
  let bytes = 0;
  for (const { p } of ranked) {
    if (out.length >= MAX_INJECT) break;
    const item = { when: p.when, then: p.then, n: Number(p.n) || MIN_SUPPORT };
    const size = JSON.stringify(item).length;
    if (bytes + size > MAX_INJECT_BYTES) break;
    bytes += size;
    out.push({ ...item, id: p.id });
  }
  return out;
}

/** 注进去的那几条，收尾时按这一轮判没判错记账。连输 3 次且没赢过 → 自动静音 14 天，**不删除**。 */
export function scorePriors(ids, bad) {
  if (!Array.isArray(ids) || !ids.length) return { win: 0, loss: 0, muted: 0 };
  const list = loadPriors();
  const byId = new Map(list.map((p) => [p.id, p]));
  let win = 0, loss = 0, muted = 0;
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    p.injected = (Number(p.injected) || 0) + 1;
    if (bad) { p.losses = (Number(p.losses) || 0) + 1; loss++; }
    else { p.wins = (Number(p.wins) || 0) + 1; win++; }
    if ((Number(p.losses) || 0) >= 3 && !(Number(p.wins) || 0)) {
      p.mutedUntil = _today() + MUTE_DAYS; muted++;
    }
  }
  _savePriors(list);
  return { win, loss, muted };
}

// ── A/B 与读数 ──────────────────────────────────────────────────────

export function priorsMode() {
  const raw = String(_read(PRIORS_MODE_KEY, "ab") || "ab");
  return ["on", "off", "ab"].includes(raw) ? raw : "ab";
}
export function setPriorsMode(mode) {
  if (["on", "off", "ab"].includes(mode)) _write(PRIORS_MODE_KEY, mode);
}

/** 按会话分组，不按轮：按轮分会让同一个任务的上下文串味，读数就没意义了。 */
export function priorsArm(sessionId) {
  const mode = priorsMode();
  if (mode === "on") return 1;
  if (mode === "off") return 0;
  const s = String(sessionId || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2) === 0 ? 1 : 0;
}

/**
 * 唯一能证明「真在变准」的东西。三个指标全是执行事实，不需要谁打分。
 * 样本不足时**不给百分比**——「没查成」不等于「没有」。
 */
export function userPriorReadout(episodes, minSample = 30) {
  const acc = { on: { n: 0, rework: 0, steer: 0, mismatch: 0 }, off: { n: 0, rework: 0, steer: 0, mismatch: 0 } };
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    if (!ep || ep.pab === undefined || ep.pab === null) continue;
    const side = ep.pab ? acc.on : acc.off;
    side.n++;
    if (ep.reworkedAt) side.rework++;
    if (ep.steer) side.steer++;
    if (Array.isArray(ep.mm) && ep.mm.length) side.mismatch++;
  }
  const enough = acc.on.n >= minSample && acc.off.n >= minSample;
  return {
    ...acc,
    enough,
    perPrior: loadPriors().map((p) => ({
      id: p.id, field: p.field, when: p.when,
      injected: Number(p.injected) || 0, wins: Number(p.wins) || 0, losses: Number(p.losses) || 0,
      muted: Number(p.mutedUntil) > _today(),
    })),
  };
}

/** 学歪了自己关掉：两边样本都够，而开着那边的被纠正率反而更高 → 整套降到 off。修机制，不加劝诫。 */
export function autoDisableIfHarmful(episodes, minSample = 30) {
  const r = userPriorReadout(episodes, minSample);
  if (!r.enough) return false;
  const onRate = r.on.steer / r.on.n;
  const offRate = r.off.steer / r.off.n;
  if (onRate > offRate) { setPriorsMode("off"); return true; }
  return false;
}

// ── 归纳 ────────────────────────────────────────────────────────────

/**
 * 喂给模型的**不是流水，是已经算好的统计**。两块各 ≤20 行，严守实测能稳定产出的粒度。
 * 模型只负责把统计翻译成一句能照做的话，不负责发现规律——发现由计数完成。
 */
export function distillUserPriorsInput(signals = loadSignals()) {
  const badRing = (signals.ring || []).filter((r) => r && r.bad).slice(-20)
    .map((r) => `「${r.q}」→ 判成 ${JSON.stringify(r.vd)}${r.mm?.length ? ` | 不符:${r.mm.join(",")}` : ""}`);
  const cells = Object.entries(signals.cells || {})
    .map(([key, c]) => ({ key, n: Number(c?.n) || 0, bad: Number(c?.bad) || 0 }))
    .filter((c) => c.n >= MIN_SUPPORT && c.bad / c.n >= MIN_BAD_RATE)
    .sort((a, b) => b.bad - a.bad).slice(0, 20)
    .map((c) => `${c.key} → ${c.n} 次里 ${c.bad} 次判完就返工或被纠正`);
  const chunks = [];
  if (badRing.length) chunks.push(badRing.join("\n"));
  if (cells.length) chunks.push(cells.join("\n"));
  return chunks;
}

export function distillDue(signals = loadSignals(), every = 40) {
  const mark = Number(_read(DISTILL_MARK_KEY, 0)) || 0;
  const seen = (signals.ring || []).length + Object.keys(signals.cells || {}).length;
  return seen - mark >= every ? seen : 0;
}
export function markDistilled(at) { _write(DISTILL_MARK_KEY, Number(at) || 0); }
