// 用户原话 / 存量笔记 → 核心记忆 的三条路，从 main.js 搬出来（尺寸闸）。
//
//   · _coreCaptureUtterance：一句用户的话（发送 / 插话两处调用）。判据在 memory-signals.js；
//     「不是 X，是 Y」走 coreSupersede 换掉旧条。收进核心的同时给 KG 里同一句打 core 标，
//     检索侧不再把它当常驻带 —— 同一句话不进两次。
//   · _kgMarkCore：给 KG 里内容相同的笔记打 core 标（比较时剥掉 [来源戳]）。
//   · syncCoreFromKg：打开项目时跑一次 —— 文件镜像 → 本地（本地为空时）；存量笔记按新规则
//     重判类型（tv=3）并把偏好/约定升进核心。
// KG 的读写 / 分类 / 上下文缓存失效由 configureCoreCapture 注入；名字原样保留，测试按名抠取。
import { judgeDurableUtterance } from "./memory-signals.js";
import { extractExplicitCorrection } from "../conversation-memory.js";
import { coreUpsert, coreActive, coreSupersede, coreRestore, corePromoteNote, coreReplaceAll, coreImportMarkdown, coreStats, coreSimilarity, CORE_AGENT_MARK } from "./core-memory.js";
import { memStat, memStats } from "./memory-stats.js";

let _ccKgLoad = () => [];
let _ccKgSave = () => {};
let _ccKgClassify = () => "fact";
let _ccInvalidate = () => {};

export function configureCoreCapture(deps = {}) {
  if (typeof deps.kgLoad === "function") _ccKgLoad = deps.kgLoad;
  if (typeof deps.kgSave === "function") _ccKgSave = deps.kgSave;
  if (typeof deps.kgClassify === "function") _ccKgClassify = deps.kgClassify;
  if (typeof deps.invalidateContext === "function") _ccInvalidate = deps.invalidateContext;
}

export function _coreCaptureUtterance(root, text) {
  try {
    const j = judgeDurableUtterance(text);
    if (!j) return null;
    const scope = j.scope === "global" ? "" : String(root || "");
    // 「不是 X，是 Y」这种明确纠正：核心里已有说 X 的条目就换掉它（旧条留作审计，不再渲染）。
    // 这是核心记忆唯一会"改写"旧条的路径——同义判重只会合并，不会替换。
    const parsed = extractExplicitCorrection(text);
    if (parsed?.explicitReplacement && String(parsed.incorrect || "").length >= 2) {
      const wrong = String(parsed.incorrect).toLowerCase();
      const old = coreActive(scope).find((en) => en.text.toLowerCase().includes(wrong));
      if (old) {
        const r = coreSupersede(scope, old.id, j.text, "user");
        if (r) { memStat("capture.core.superseded"); _kgMarkCore(scope, j.text); return r; }
      }
    }
    const e = coreUpsert(scope, { text: j.text, kind: j.kind, source: "user", confidence: 0.9 });
    memStat(e ? "capture.core.accepted" : "capture.core.rejected");
    if (e) _kgMarkCore(scope, j.text);
    return e;
  } catch { return null; }
}

export function _kgMarkCore(root, text) {
  try {
    const strip = (v) => String(v || "").replace(/^\[[^\]\n]{1,16}\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
    const norm = strip(text);
    if (!norm) return;
    const notes = _ccKgLoad(root);
    let hit = false;
    for (const n of notes) if (n && !n.core && strip(n.content) === norm) { n.core = true; hit = true; }
    if (hit) _ccKgSave(root, notes);
  } catch {}
}

/** 返回升格条数。只跑一次（tv=3 记在笔记上），失败只吞掉：这条挂在打开项目的路径上。 */
export function syncCoreFromKg(root, fileEntries) {
  try {
    if (Array.isArray(fileEntries) && fileEntries.length) coreRestore(root, fileEntries);
    const notes = _ccKgLoad(root);
    let changed = false, promoted = 0;
    for (const n of notes) {
      if (!n || n.tv === 3) continue;
      n.type = _ccKgClassify(n.content); n.tv = 3; changed = true;
      if (corePromoteNote(root, n)) { n.core = true; promoted++; }
    }
    if (changed) { _ccKgSave(root, notes); _ccInvalidate(); }
    if (promoted) console.log(`[core] ${root || "_global"}: 从存量笔记升格 ${promoted} 条进核心记忆`);
    return promoted;
  } catch (e) { console.warn("[core] sync failed:", e); return 0; }
}

/** remember 工具写完 KG 之后：约束类（偏好/约定）同时升进核心。模型自己记的 source=agent，
 *  渲染时带 [你记的] 标，和用户亲口说的分得开。 */
export function promoteRememberedNote(scope, content) {
  try {
    const note = { type: _ccKgClassify(content), content: String(content || ""), created: Date.now() };
    if (corePromoteNote(scope, note, "agent")) _kgMarkCore(scope, content);
  } catch {}
}

/** 打开项目时：本地核心为空才从 memory.md 读回（文件是备份不是权威，本地有就不碰）。 */
export async function coreImportIfEmpty(root, readText) {
  try {
    if (!root || coreActive(root).length) return 0;
    const text = String((await readText()) || "");
    return text.trim() ? coreImportMarkdown(root, text) : 0;
  } catch { return 0; }
}

/** 记忆中心 Core 页要的三样：初始文本、计数、保存回调。宿主只递进三个副作用。 */
export function corePanelProps(root, hooks = {}) {
  const text = (scope) => { try { return coreActive(scope).map((e) => (e.source === "agent" ? `${CORE_AGENT_MARK} ` : "") + e.text).join("\n"); } catch { return ""; } };
  return {
    initialCore: { user: text(""), project: root ? text(root) : "" },
    memoryStats: (() => { try { return { ...memStats(), "core.user": coreStats("").active, "core.project": root ? coreStats(root).active : 0 }; } catch { return {}; } })(),
    onSaveCore: (userText, projectText) => {
      const u = coreReplaceAll("", userText);
      const pc = root ? coreReplaceAll(root, projectText) : 0;
      if (root) { try { hooks.mirrorProject?.(); } catch {} }
      try { hooks.invalidateContext?.(); } catch {}
      try { hooks.toast?.(root ? `核心记忆已保存：我的 ${u} 条，本项目 ${pc} 条` : `核心记忆已保存：我的 ${u} 条`); } catch {}
    },
  };
}

/** 意图裁决里说"这是项目级交付"的那几面旗。取自画像（run.engineering）上的布尔位。 */
const PROJECT_SCOPE_FLAGS = ["projectScope", "fullWebsite", "fromZeroUiProject", "websiteDelivery", "productionReadiness"];

/**
 * 任务契约的耐久那一半 → 项目核心。
 *
 * 契约（goal / action / target / constraints / successCriteria）本来只活在会话里，新会话第一句
 * 就忘了"这个仓库是要做成什么"。但**一轮的目标不等于项目的目标**：「修一下登录页的 bug」升进
 * 核心之后会每轮当项目目标注入。所以只在裁决把这一轮判成**项目级**交付、且这轮做成时才升；
 * 目标演进（相似 ≥0.5）时替换旧的，不并存。constraints 不升：多数是本轮的（"这次别改界面"）。
 * 返回写进去的条目；不够格返回 null。
 */
export function promoteContractGoal(scope, profile, semantic, outcome) {
  try {
    if (outcome !== "success") return null;
    const goal = String(semantic?.goal || "").replace(/\s+/g, " ").trim();
    if (goal.length < 8 || goal.length > 200) return null;
    if (!PROJECT_SCOPE_FLAGS.some((k) => !!profile?.[k])) return null;
    const text = `目标：${goal}`;
    const prior = coreActive(scope).filter((e) => e.kind === "goal");
    const evolved = prior.find((e) => coreSimilarity(e.text, text) >= 0.5);
    const r = evolved
      ? coreSupersede(scope, evolved.id, text, "agent")
      : coreUpsert(scope, { text, kind: "goal", source: "agent", confidence: 0.75 });
    if (r) memStat("capture.core.goal");
    return r;
  } catch { return null; }
}
