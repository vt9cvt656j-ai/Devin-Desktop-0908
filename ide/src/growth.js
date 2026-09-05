// ---------------------------------------------------------------------------
// Growth — an adaptive "learner model" that grows with the user.
//
// This is a small Intelligent-Tutoring-System (ITS) living inside the IDE:
//   • a *learner model* — a per-skill mastery estimate of THIS user, updated
//     from their real behaviour via Bayesian Knowledge Tracing (BKT);
//   • a *pedagogical layer* — it turns that model into adaptive teaching by
//     injecting a tailored block into the AI's system prompt (Lever 1).
//
// Design goals (grounded in the literature, see docs/growth-system.md):
//   • Low floor: a brand-new user starts "novice everywhere", so the AI
//     explains richly out of the box — beginners onboard with zero setup.
//   • High ceiling: as mastery rises, scaffolding *fades* (expertise-reversal
//     effect — explanations that help novices only annoy experts).
//   • "越勇越厉害" for real: the signals reward *cognitive engagement*
//     (reviewing diffs, catching bad edits, planning, writing your own code),
//     not blind delegation — directly countering AI-tool deskilling.
//   • Open Learner Model: the user can see and correct the model's beliefs,
//     which respects autonomy (Self-Determination Theory) and builds trust.
//
// Self-contained: persists to localStorage (works in the native app AND in
// `npm run dev` browser-mock mode), injects its own styles, and every public
// entry point is wrapped so a bug here can never break the chat hot-path.
// ---------------------------------------------------------------------------

const STORE_KEY = "michael-ide.learner-model.v1";

// The skill graph. Each skill is fed by real, captured behavioural signals
// (see applyEvent below) — no padded/dead bars. These feed the Open Learner Model
// panel only; the model is never handed a per-skill coaching instruction.
const SKILLS = [
  {
    id: "reviewing",
    label: "审查 AI 产出",
    blurb: "看懂并判断 AI 改了什么、对不对",
  },
  {
    id: "authoring",
    label: "独立投入",
    blurb: "自己思考、不把活全外包给 AI",
  },
  {
    id: "prompting",
    label: "表达需求",
    blurb: "把想要的东西讲清楚",
  },
  {
    id: "planning",
    label: "任务规划",
    blurb: "把复杂任务拆成步骤",
  },
  {
    id: "tooling",
    label: "掌握 IDE 能力",
    blurb: "用上 plan / agent / @文件 等高级能力",
  },
  {
    id: "verifying",
    label: "验证习惯",
    blurb: "改完会跑测试/诊断确认，而不是直接信",
  },
];
const SKILL_IDS = SKILLS.map((s) => s.id);

// Export avgMastery for external access (runtime policy lookup)
export function getAvgMastery() {
  try { load(); return avgMastery(); } catch { return 0.5; }
}

/**
 * 和 getAvgMastery() 只差一件事：**拿不到就说拿不到**（返回 null），不编一个 0.5。
 *
 * 为什么要这个变体：0.5 不是中性值。按熟练度放宽工具窗口那条判据的阈值是 0.45 / 0.7，
 * 0.5 恰好越过第一档——于是"读失败"会被当成"中等熟练"，把窗口从 10 放宽到 12。
 * **失败路径反而给更多工具**，而工具窗口每一轮都收注意力税。
 * 凡是"拿不到就该保守"的调用方用这个；只是要个数字显示的用上面那个。
 */
export function getAvgMasteryStrict() {
  try { load(); const v = avgMastery(); return Number.isFinite(v) ? v : null; } catch { return null; }
}

// --- Bayesian Knowledge Tracing ------------------------------------------------
// Classic 4-parameter BKT: a latent "mastered?" probability updated by each
// observation. Interpretable and cheap — deep/LSTM knowledge tracing is overkill
// for a single local user.
const BKT = { pInit: 0.25, pLearn: 0.12, pSlip: 0.1, pGuess: 0.2, forgetPerDay: 0.015 };

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function bktUpdate(p, correct) {
  const { pSlip, pGuess, pLearn } = BKT;
  const post = correct
    ? (p * (1 - pSlip)) / (p * (1 - pSlip) + (1 - p) * pGuess)
    : (p * pSlip) / (p * pSlip + (1 - p) * (1 - pGuess));
  return clamp(post + (1 - post) * pLearn, 0.02, 0.98);
}

// Forgetting: gentle decay toward the prior for skills not exercised lately
// (spacing / desirable-difficulty intuition — unused skills fade).
function applyForgetting(skill, now) {
  if (!skill.last) return;
  const days = (now - skill.last) / 86400000;
  if (days > 1) skill.p = clamp(skill.p - BKT.forgetPerDay * (days - 1), BKT.pInit * 0.6, 0.98);
}

// --- state --------------------------------------------------------------------

function freshState() {
  const skills = {};
  for (const id of SKILL_IDS) skills[id] = { p: BKT.pInit, n: 0, last: 0 };
  return {
    v: 1,
    skills,
    prefs: { explain: "auto", challenge: false },   // explain: auto | min | rich
    stats: { messages: 0, aiEdits: 0, reviews: 0, undos: 0, reverts: 0, blind: 0, predicts: 0, predictHits: 0, reworks: 0, cleanRuns: 0, asked: 0 },
    trend: [],                                       // [{ msgs, avg, t }]
    sessionModes: [],                               // modes seen this run (tooling breadth)
    projects: {},                                    // root -> { name, first, last, turns, touched:{skill:count} }
  };
}

let state = null;
// The project (workspace root) the user is currently acting in. Set on every
// message-sent so that skill practice can be attributed across projects — the
// basis for "transferable" mastery (a skill proven in many projects is yours to
// keep; varied practice → better transfer, per Bjork).
let currentProject = null;
// Per-turn ledger, reconciled at the start of the next turn so that AI edits the
// user never looked at count as "blind accepts" (the deskilling signal).
let turn = { applied: 0, reviewed: 0, engaged: false, verified: false };
// At most one "predict-first" challenge gate per turn, so it teaches without nagging.
let gatedThisTurn = false;

function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const fresh = freshState();
      // Deep-merge the nested objects: a shallow spread would let an OLDER save's
      // partial `stats`/`prefs` replace the whole fresh object, leaving new fields
      // undefined — then `stats.blind += n` → NaN, which persists and poisons the
      // stats forever. Merge field-by-field so upgrades always have every key.
      state = {
        ...fresh,
        ...parsed,
        stats: { ...fresh.stats, ...(parsed.stats || {}) },
        prefs: { ...fresh.prefs, ...(parsed.prefs || {}) },
        skills: { ...fresh.skills, ...(parsed.skills || {}) },
      };
      // heal: ensure every known skill exists (graph may grow across versions)
      for (const id of SKILL_IDS) if (!state.skills[id]) state.skills[id] = { p: BKT.pInit, n: 0, last: 0 };
    }
  } catch { /* corrupt / unavailable — fall through to fresh */ }
  if (!state) state = freshState();
  // "This run" means THIS app launch — the persisted copy carries stale modes from
  // past sessions, which silenced the tooling signal forever (first-use credit could
  // never fire again). Reset on load so each launch re-credits feature breadth.
  state.sessionModes = [];
  return state;
}

function save() {
  // Synchronous: the payload is tiny and signals fire on user actions (not per
  // token), so there's no perf reason to debounce — and a debounce risks losing
  // the last turn if the app closes right after.
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota / unavailable */ }
}

function observe(skillId, correct) {
  const s = state.skills[skillId];
  if (!s) return;
  const now = Date.now();
  applyForgetting(s, now);
  s.p = bktUpdate(s.p, correct);
  s.n += 1;
  s.last = now;
  // Attribute this practice to the current project, so we can tell how broadly
  // (across how many projects) a skill has been exercised.
  const proj = currentProject && state.projects[currentProject];
  if (proj) proj.touched[skillId] = (proj.touched[skillId] || 0) + 1;
}

function avgMastery() {
  const vals = SKILL_IDS.map((id) => state.skills[id].p);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// How many distinct projects a skill has been genuinely practiced in (≥2 reps,
// so a single incidental touch doesn't count) — its transfer breadth.
function skillBreadth(skillId) {
  let n = 0;
  for (const root in state.projects) if ((state.projects[root].touched[skillId] || 0) >= 2) n++;
  return n;
}
function projectCount() { return Object.keys(state.projects).length; }
// "Transferable" = both fairly mastered AND proven across ≥2 projects.
function isTransferable(skillId) { return state.skills[skillId].p >= 0.6 && skillBreadth(skillId) >= 2; }
function transferableCount() { return SKILL_IDS.filter(isTransferable).length; }

function snapshotTrend() {
  const t = state.trend;
  const point = { msgs: state.stats.messages, avg: +avgMastery().toFixed(3), t: Date.now() };
  const last = t[t.length - 1];
  if (!last || point.msgs !== last.msgs) t.push(point);
  if (t.length > 40) t.shift();
}

// Close out the previous turn: any AI edit the user never opened is a blind
// accept → weak negative evidence for "reviewing" (and disengagement for
// "authoring"). This is what makes over-reliance visibly cost mastery.
function reconcileTurn() {
  // 「闭眼接受」的判据原来只看"有没有在 IDE 里点开 diff"。2026-09-05 量了产品所有者自己的
  // 档案：862 轮里 AI 改了 1041 处、点开 27 次，"未看就接受率" 70%，四项能力钉在地板 ——
  // 他不是没审，是不在这个面板里审：改完立刻跑测试 / 看构建 / 直接用。
  // 所以这一轮的 run 如果**验证过**（测试/构建/诊断真跑过且过了），没点开 diff 不算闭眼；
  // 没验证过才算。验证是执行事实，点开面板只是一个界面事件。
  const blind = turn.verified ? 0 : Math.max(0, turn.applied - turn.reviewed);
  if (blind > 0) {
    state.stats.blind += blind;
    const hits = Math.min(blind, 3);            // cap so one big run can't tank the estimate
    for (let i = 0; i < hits; i++) observe("reviewing", false);
    observe("authoring", false);
  } else if (turn.applied > 0 || turn.engaged) {
    observe("authoring", true);                 // they engaged with the work this turn
  }
  turn = { applied: 0, reviewed: 0, engaged: false, verified: false };
  gatedThisTurn = false;                         // allow one predict-gate next turn
}

// --- public: record a behavioural signal --------------------------------------

export function signal(type, payload = {}) {
  try {
    load();
    switch (type) {
      case "message-sent": {
        reconcileTurn();                          // closes prior turn (still attributed to the prior project)
        state.stats.messages += 1;
        const proj = payload.project || "";
        if (proj) {
          currentProject = proj;
          const p = state.projects[proj] ||
            (state.projects[proj] = { name: payload.projectName || proj, first: Date.now(), last: 0, turns: 0, touched: {} });
          if (payload.projectName) p.name = payload.projectName;
          p.last = Date.now();
          p.turns += 1;
        }
        // 「表达需求」不再按字数判：≥60 字算好、否则算差，把老手的一句话指令全记成失败
        // （实测 prompting 钉在 0.14）。改成 run 收尾按执行事实判——见 run-complete 里的 asked。
        if (payload.mode === "plan") { observe("planning", true); turn.engaged = true; }
        if (payload.complex && payload.mode === "agent") observe("planning", true); // 勇于接复杂任务
        if (payload.mode === "chat" || payload.mode === "plan") turn.engaged = true; // thinking, not autopiloting
        // tooling breadth — credit the first use of each mode/feature this run
        const feats = [payload.mode, ...(payload.usedAt ? ["at"] : [])].filter(Boolean);
        for (const f of feats) {
          if (!state.sessionModes.includes(f)) { state.sessionModes.push(f); observe("tooling", true); }
        }
        snapshotTrend();
        break;
      }
      case "review-diff":
        observe("reviewing", true);
        turn.reviewed += 1; turn.engaged = true;
        state.stats.reviews += 1;
        break;
      case "edit-applied":
        turn.applied += 1;
        state.stats.aiEdits += 1;
        break;
      case "undo-edit":
        observe("reviewing", true);               // caught a bad edit = strong engagement
        turn.reviewed += 1; turn.engaged = true;
        state.stats.undos += 1;
        break;
      case "run-complete": {
        // An agent run that edited files: did it verify its own work (tests /
        // build / diagnostics) or ship unverified? The beneficial-usage signal.
        observe("verifying", !!payload.verified);
        turn.verified = !!payload.verified;   // 供下一轮 reconcileTurn 判"闭眼"用
        // 下面三条全是执行事实，不是界面事件（判据见文件头 / docs/growth-system.md §3）：
        //  · asked：这个 run 里问了用户几次。0 次且做成了 = 需求讲清楚了；≥2 次 = 没讲清。
        //  · reworked：上一轮记了 ✓，用户半小时内又提了同一件事（情景档案 _markReworkIfAny 配出来的）
        //    = 上一轮的产出没过用户这一关 → 审查/表达两项的负证据。
        //  · 改了文件、验证过、没返工 = 干净的一轮 → 审查的弱正证据（他确实在把关，只是不在面板里）。
        if (Number.isFinite(Number(payload.asked))) {
          const asked = Math.max(0, Math.trunc(Number(payload.asked)));
          state.stats.asked += asked;
          if (payload.outcome === "success" || asked >= 2) observe("prompting", asked === 0);
        }
        if (payload.reworked) {
          state.stats.reworks += 1;
          observe("reviewing", false);
          observe("prompting", false);
        } else if (payload.wroteFiles && payload.verified && payload.outcome === "success") {
          state.stats.cleanRuns += 1;
          observe("reviewing", true);
        }
        break;
      }
      case "predict":
        // "你先猜": the user committed to a guess before seeing the AI's diff —
        // retrieval practice + desirable difficulty, the strongest learning signal.
        observe("authoring", !!payload.hit);      // did their mental model match?
        observe("reviewing", true);               // they engaged & self-assessed
        turn.reviewed += 1; turn.engaged = true;
        state.stats.predicts += 1;
        if (payload.hit) state.stats.predictHits += 1;
        break;
    }
    save();
  } catch { /* a telemetry bug must never break the editor */ }
}

/**
 * 「老用户还是新用户」—— 只看用量和项目广度，不看 BKT。
 *
 * 为什么要这个：放宽工具窗口那条判据读的是 BKT 平均掌握度，而 BKT 的信号有一半是界面
 * 事件（点没点开 diff）。产品所有者 862 轮、32 个项目，平均掌握度 0.42 < 0.45，被判成新手、
 * 拿最窄的工具窗口。用了这么多轮、跨这么多项目的人不是新手 —— 这是执行事实，BKT 是估计。
 */
export function getExperienceTier() {
  try {
    load();
    return (state.stats.messages >= 60 && projectCount() >= 2) ? "seasoned" : "new";
  } catch { return "new"; }
}

/**
 * 一个 run 收尾时喂给 run-complete 的三条执行事实（全从账本/档案读，不从界面事件推）：
 *  · asked：这个 run 里 ask_user 了几次；
 *  · reworked：档案里上一条 ✓ 被这一条返工了（_markReworkIfAny 配出来的 reworkedAt）；
 *  · wroteFiles：这一轮改没改文件。
 */
export function factsFromRun(run, episodes, outcome) {
  const eps = Array.isArray(episodes) ? episodes : [];
  const last = eps[eps.length - 1], prev = eps[eps.length - 2];
  return {
    asked: (run?._toolLedger?.entries || []).filter((e) => e && e.tool === "ask_user").length,
    reworked: !!(prev && last && prev.reworkedAt && prev.reworkedAt === last.ts),
    wroteFiles: (run?.recording || []).some((st) => st && /write|edit|multiedit/.test(String(st.type || ""))),
    outcome,
  };
}

/** 测试专用：清掉模块级状态。生产代码不许调。 */
export function _resetForTests() {
  state = null;
  turn = { applied: 0, reviewed: 0, engaged: false, verified: false };
  gatedThisTurn = false;
  currentProject = null;
}

// --- public: the "你先猜" (predict-first) challenge gate -----------------------

export function challengeOn() {
  try { load(); return !!state.prefs.challenge; } catch { return false; }
}

// Overlay a just-rendered diff viewport with a "guess first, then reveal" gate.
// Purely additive DOM — the diff underneath is untouched, so if anything here
// throws the edit still shows normally. Caller passes the viewport element and
// the change size; we decide whether to actually gate (challenge on, not already
// gated this turn, change substantial enough to be worth predicting).
export function predictGate(viewportEl, opts = {}) {
  try {
    load();
    if (!state.prefs.challenge || gatedThisTurn || !viewportEl) return false;
    if ((opts.lines || 0) < 4) return false;     // trivial edits aren't worth a guess
    gatedThisTurn = true;
    injectStyles();

    viewportEl.style.position = viewportEl.style.position || "relative";
    const gate = document.createElement("div");
    gate.className = "growth-gate";
    gate.innerHTML =
      `<div class="growth-gate__inner">` +
      `<div class="growth-gate__t">🙈 你先猜</div>` +
      `<div class="growth-gate__s">先在脑子里想一遍：这段你会怎么改？想好了再看我的实现——自己先推一遍，记得更牢。</div>` +
      `<button type="button" class="growth-gate__reveal">揭晓答案</button>` +
      `</div>`;
    gate.querySelector(".growth-gate__reveal").addEventListener("click", (e) => {
      e.stopPropagation();
      gate.remove();
      const ask = document.createElement("div");
      ask.className = "growth-gate__check";
      ask.innerHTML =
        `<span>你的思路和我的接近吗？</span>` +
        `<button type="button" data-hit="1">👍 接近</button>` +
        `<button type="button" data-hit="0">👎 差挺多</button>`;
      ask.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          signal("predict", { hit: b.dataset.hit === "1" });
          ask.innerHTML = `<span class="growth-gate__done">已记下——${b.dataset.hit === "1" ? "稳。" : "没关系，正是这种「费点劲」最长本事。"}</span>`;
          setTimeout(() => ask.remove(), 2600);
        });
      });
      viewportEl.appendChild(ask);
    });
    viewportEl.appendChild(gate);
    return true;
  } catch { return false; }
}

// --- public: the adaptive teaching block for the system prompt ----------------

function levelLabel(p) { return p >= 0.7 ? "熟练" : p >= 0.4 ? "进阶" : "新手"; }

// The adaptive teaching block used to live here. It scored the user with the learner
// model and, below a mastery threshold, dictated the exact shape of every wrap-up:
// "what was done / why / how to use it / which files changed", gloss each new term in
// one sentence, then a transferable principle and a small next step to try. The model
// followed it literally, so every single reply came out as the same six-section lecture
// regardless of what had actually been asked — and a fresh install starts below that
// threshold, so it was the default experience.
//
// It also contradicted answer_quality.txt, which already tells the model to let depth
// follow whether the reader can use the answer, and says plainly: no templates, no
// reciting rules. A prompt that prescribes section headings cannot coexist with that.
//
// Adaptation is the model's job from the conversation in front of it, not a template
// chosen by a mastery score. The learner model keeps its panel and its signals; it no
// longer writes the endings.

// --- public: the Open Learner Model panel -------------------------------------

/*
 * 样式已经搬进 src/styles/app.css（搜 "growth panel"）。
 *
 * 原来是运行时往 <head> 注入一段 <style>，那是这一页所有排版偏差的同一个根因：它活在
 * app.css 之外，改设计语言时没人会想到还有这么一份；而且它写死了自己的一套圆角、开关
 * 尺寸、状态色，和面板里其它页各说各话。
 */
function injectStyles() {}

function trendVerdict() {
  const t = state.trend;
  if (t.length < 4) return null;
  const cur = t[t.length - 1];
  const prev = t.find((p) => cur.msgs - p.msgs >= 6) || t[0];
  const dMsgs = cur.msgs - prev.msgs;
  const dAvg = cur.avg - prev.avg;
  if (dMsgs < 6) return null;
  // 「元认知惰性」那条警告已按所有者要求删除：它是在用户没做错任何事的时候跳出来
  // 指责他偷懒，而判据只是"用得多但分数没涨"——一个人用得多完全可能是因为项目变难了。
  // 剩下的只有正向那一条。
  if (dAvg >= 0.02)
    return { warn: false, text: `保持住——最近你的整体掌握度在上升（+${Math.round(dAvg * 100)} 点）。越勇越厉害。` };
  return null;
}

export function renderPanel(body, ctx = {}) {
  try {
    load();
    injectStyles();

    const head = document.createElement("div");
    head.className = "tool-head";
    head.innerHTML = `<h2></h2><p></p>`;
    head.querySelector("h2").textContent = "成长";
    head.querySelector("p").textContent = "这是你的开发者成长档案——跨所有项目积累、换项目也带着走。越战越勇：一项能力在越多样的项目里练过，就越是你的。你可以随时纠正我。";
    body.appendChild(head);

    const wrap = document.createElement("div");
    wrap.className = "growth-wrap";
    body.appendChild(wrap);

    const rerender = () => { body.innerHTML = ""; renderPanel(body, ctx); };

    // trend banner
    const v = trendVerdict();
    if (v) {
      const b = document.createElement("div");
      b.className = "growth-banner" + (v.warn ? " warn" : "");
      b.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.2a.9.9 0 01.9.9v3.6a.9.9 0 01-1.8 0V5.1A.9.9 0 018 4.2zm0 7.2a1 1 0 110-2 1 1 0 010 2z"/></svg><span></span>`;
      b.querySelector("span").textContent = v.text;
      wrap.appendChild(b);
    }

    // cross-project growth headline — this capability is YOURS, not this app's;
    // breadth across projects is what makes a skill transferable ("越战越勇").
    {
      const np = projectCount();
      const nt = transferableCount();
      const strip = document.createElement("div");
      strip.className = "growth-profile";
      strip.innerHTML =
        `<div class="growth-profile__cells">` +
          `<div class="growth-profile__c"><b>${np}</b><span>实战项目</span></div>` +
          `<div class="growth-profile__c"><b>${nt}/${SKILLS.length}</b><span>可迁移能力</span></div>` +
          `<div class="growth-profile__c"><b>${state.stats.messages}</b><span>累计轮次</span></div>` +
        `</div><p class="growth-profile__line"></p>`;
      strip.querySelector(".growth-profile__line").textContent = np <= 1
        ? "目前只在 1 个项目里实战。多上手几个不同项目，你的能力会被「跨项目」证明、迁移性更强——越战越勇。"
        : `已在 ${np} 个项目里实战，其中 ${nt} 项能力已跨项目验证、换新项目也带得走。这才是真正的成长。`;
      wrap.appendChild(strip);
    }

    // skills (the open learner model — each row is inspectable AND editable)
    const st = document.createElement("div");
    st.className = "growth-section-t";
    st.textContent = "能力档位（点 ± 可纠正我的判断；标签 = 跨项目迁移度）";
    wrap.appendChild(st);

    // 一组能力档位拼成一张卡（行间发丝线），和设置页"一组一张卡"是同一个形态。
    // 原来这些行是直接裸挂在 wrap 上的，各自带 margin，看着是一堆浮在底色上的条。
    const skillsCard = document.createElement("div");
    skillsCard.className = "growth-skills-card";
    wrap.appendChild(skillsCard);

    for (const sk of SKILLS) {
      const m = state.skills[sk.id];
      const pct = Math.round(m.p * 100);
      const breadth = skillBreadth(sk.id);
      const xfer = isTransferable(sk.id);
      const xferTxt = xfer ? `可迁移 · ${breadth}` : breadth >= 1 ? `${breadth} 个项目` : "未跨项目";
      const row = document.createElement("div");
      row.className = "growth-skill";
      row.innerHTML =
        `<div class="growth-skill__name">${sk.label}<small>${sk.blurb}</small></div>` +
        `<div class="growth-bar"><div class="growth-bar__fill" style="width:${pct}%"></div></div>` +
        `<div class="growth-skill__right">` +
          `<span class="growth-xfer${xfer ? " is-xfer" : ""}" title="在 ${breadth} 个不同项目里练过">${xferTxt}</span>` +
          `<span class="growth-skill__pct">${levelLabel(m.p)} · ${pct}%</span>` +
          `<button class="growth-nudge" data-d="-1" title="我比这更弱">−</button>` +
          `<button class="growth-nudge" data-d="1" title="我比这更强">＋</button>` +
        `</div>`;
      row.querySelectorAll(".growth-nudge").forEach((btn) => {
        btn.addEventListener("click", () => {
          const d = +btn.dataset.d;
          m.p = clamp(m.p + d * 0.08, 0.02, 0.98);
          m.last = Date.now();
          save();
          rerender();
        });
      });
      skillsCard.appendChild(row);
    }

    // project understanding — the "越来越懂你的项目" half of the model. Reuses the
    // agent's `remember` project memory, passed in by the host (main.js).
    if (ctx.projectMemory !== undefined) {
      const facts = String(ctx.projectMemory || "")
        .split("\n").map((s) => s.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
      const pt = document.createElement("div");
      pt.className = "growth-section-t";
      pt.textContent = "我对这个项目的理解" + (ctx.projectName ? ` · ${ctx.projectName}` : "");
      wrap.appendChild(pt);

      const box = document.createElement("div");
      box.className = "growth-project growth-card";
      const intro = document.createElement("p");
      intro.className = "growth-project__intro";
      if (facts.length) {
        intro.textContent = `已记住 ${facts.length} 条关于这个项目的知识（架构 / 约定 / 命令 / 易踩的坑），每轮自动带进上下文——所以我越用越懂你的项目。`;
        box.appendChild(intro);
        const ul = document.createElement("ul");
        ul.className = "growth-project__list";
        for (const f of facts.slice(-4).reverse()) {
          const li = document.createElement("li");
          li.textContent = f.length > 120 ? f.slice(0, 120) + "…" : f;
          ul.appendChild(li);
        }
        box.appendChild(ul);
        if (facts.length > 4) {
          const more = document.createElement("div");
          more.className = "growth-project__more";
          more.textContent = `…还有 ${facts.length - 4} 条`;
          box.appendChild(more);
        }
      } else {
        intro.textContent = ctx.projectName
          ? "还没攒下关于这个项目的长期知识。随着一起干活，我会用 remember 把架构、约定、构建/测试命令记下来，下次自动带上。"
          : "打开一个工作区文件夹后，我会开始记住这个项目的知识。";
        box.appendChild(intro);
      }
      if (ctx.onOpenMemory) {
        const btn = document.createElement("button");
        btn.className = "growth-project__btn";
        btn.textContent = "管理项目记忆 →";
        btn.addEventListener("click", () => { try { ctx.onOpenMemory(); } catch { /* host gone */ } });
        box.appendChild(btn);
      }
      wrap.appendChild(box);
    }

    // controls
    const ct = document.createElement("div");
    ct.className = "growth-section-t";
    ct.textContent = "教学偏好";
    wrap.appendChild(ct);

    // 两行装进一张卡，用和设置页一样的"左标题右控件"结构——原来是两行裸挂在底色上的
    // 控件，同一页里"有卡"和"没卡"两种形态混着出现。
    const ctlCard = document.createElement("div");
    ctlCard.className = "growth-card";

    const row1 = document.createElement("div");
    row1.className = "growth-row";
    row1.innerHTML = `<div class="growth-row__meta"><span class="growth-row__label">AI 讲解密度</span>`
      + `<span class="growth-row__hint">能力涨上去之后，讲解会自动收敛</span></div>`;
    const ctl1 = document.createElement("div");
    ctl1.className = "growth-row__control";
    const EXPLAIN = [["auto", "自动（随能力渐隐）"], ["rich", "总是详尽"], ["min", "总是极简"]];
    if (typeof ctx.buildSelect === "function") {
      ctl1.appendChild(ctx.buildSelect(EXPLAIN, state.prefs.explain, (v) => {
        state.prefs.explain = String(v);
        save();
      }));
    } else {
      // 宿主没把构造函数递进来时的退路。正常路径不会走到这里。
      const sel = document.createElement("select");
      for (const [val, lbl] of EXPLAIN) {
        const o = document.createElement("option");
        o.value = val; o.textContent = lbl;
        if (state.prefs.explain === val) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => { state.prefs.explain = sel.value; save(); });
      ctl1.appendChild(sel);
    }
    row1.appendChild(ctl1);
    ctlCard.appendChild(row1);

    const row2 = document.createElement("div");
    row2.className = "growth-row";
    row2.innerHTML = `<div class="growth-row__meta"><span class="growth-row__label">挑战模式</span>`
      + `<span class="growth-row__hint">难的地方让我先自己想，AI 再揭晓（练得更扎实）</span></div>`;
    const ctl2 = document.createElement("div");
    ctl2.className = "growth-row__control";
    const sw = document.createElement("label");
    sw.className = "growth-switch";
    sw.innerHTML = `<input type="checkbox">`;
    const cb = sw.querySelector("input");
    cb.checked = !!state.prefs.challenge;
    cb.addEventListener("change", () => { state.prefs.challenge = cb.checked; save(); });
    ctl2.appendChild(sw);
    row2.appendChild(ctl2);
    ctlCard.appendChild(row2);
    wrap.appendChild(ctlCard);

    // stats
    const stt = document.createElement("div");
    stt.className = "growth-section-t";
    stt.textContent = "行为信号";
    wrap.appendChild(stt);

    const s = state.stats;
    const blindRate = s.aiEdits ? Math.round((s.blind / s.aiEdits) * 100) : 0;
    const statCard = document.createElement("div");
    statCard.className = "growth-card";
    const grid = document.createElement("div");
    grid.className = "growth-stats";
    const cells = [
      [s.messages, "提问轮次"],
      [s.aiEdits, "AI 改动"],
      [s.reviews, "你审过的 diff"],
      [s.undos, "你撤回的改动"],
      [blindRate + "%", "未看就接受率"],
      [s.predicts ? Math.round((s.predictHits / s.predicts) * 100) + "%" : "—", "你先猜命中率"],
    ];
    for (const [val, lbl] of cells) {
      const cell = document.createElement("div");
      cell.className = "growth-stat";
      cell.innerHTML = `<b></b><span></span>`;
      cell.querySelector("b").textContent = val;
      cell.querySelector("span").textContent = lbl;
      grid.appendChild(cell);
    }
    statCard.appendChild(grid);
    wrap.appendChild(statCard);

    const reset = document.createElement("button");
    reset.className = "growth-reset";
    reset.textContent = "重置我的成长档案";
    reset.addEventListener("click", () => {
      if (!confirm("确定清空「成长」对你的全部画像与统计？此操作不可撤销。")) return;
      state = freshState();
      turn = { applied: 0, reviewed: 0, engaged: false, verified: false };
      save();
      rerender();
    });
    wrap.appendChild(reset);
  } catch (e) {
    body.innerHTML = `<div style="padding:20px;color:var(--text-dim,#888)">「成长」面板渲染失败：${(e && e.message) || e}</div>`;
  }
}

// ===== ADAPTIVE RUNTIME POLICY =====
// 根据 avgMastery 输出工具加载策略。
//
// ⚠️ 目前**没有调用方**：策略算出来了，工具装载路径谁也没读它，所以三档档位从未生效过。
// 要接的话，接的是工具目录的 initialToolCount / criticMaxTools。
//
// 顺带修掉的实现 bug：原来写的是 `growthState || state`，再去问这个对象有没有
// `avgMastery()` 方法或 `avg_mastery` 字段——而模块内的 `state` 两者都没有（avgMastery 是
// 模块级函数，不是 state 的方法）。于是 avgP 恒等于 0.5 的兜底值，永远落在「进阶」档，
// 就算接上去也不会随熟练度变化。现在默认走模块自己的 getAvgMastery()。
export function getRuntimePolicy(growthState = null) {
    const g = growthState || {};
    const avgP = typeof g.avgMastery === 'function' ? g.avgMastery()
               : (typeof g.avg_mastery === 'number' ? g.avg_mastery : getAvgMastery());

    // 三档策略：新手/进阶/专家
    if (avgP > 0.7) {
        // 专家模式：开放更多工具窗口
        return {
            initialToolCount: 20,
            criticMaxTools: 15,
            catalogDensity: 'minimal', // 减少冗余描述节省空间
            enableProfessionalTools: true,
            allowAutoLoadAdvanced: true
        };
    } else if (avgP > 0.45) {
        // 进阶模式：适度扩展
        return {
            initialToolCount: 14,
            criticMaxTools: 12,
            catalogDensity: 'balanced',
            enableProfessionalTools: true,
            allowAutoLoadAdvanced: false
        };
    } else {
        // 新手模式：保守
        return {
            initialToolCount: 11,
            criticMaxTools: 10,
            catalogDensity: 'rich', // 新手需要更详细的提示
            enableProfessionalTools: false,
            allowAutoLoadAdvanced: false
        };
    }
}
