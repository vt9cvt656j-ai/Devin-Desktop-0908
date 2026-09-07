/**
 * 模型每次 update_plan 交上来的状态，按两条**结构性底线**校正后才落到计划上。
 *
 * 判断权仍在模型：哪一步做完了、哪一步不做了，由它声明。这里只守两件靠声明守不住的事，
 * 而且两件都是用户当面看见过的形状（2026-09-05 实拍）：
 *
 *   · **一次只做一步。** 交上来两步同时 in_progress（"第二个 + 第四个一起做"），用户那侧的
 *     进度条和「当前步骤」就没有意义了；计划推进、位置行、卡片高亮全都建立在「当前步骤只有
 *     一个」上。多出来的退回 pending，保留的优先是**上一版就在进行中的那一步**（连续性），
 *     否则取靠前的那个。
 *   · **没做完不许勾。** 一步只有先进入过 in_progress、且在那之后**真的发生过事情**（又跑过
 *     工具，或者跨过了一轮模型调用）才能标 completed。两种假勾都在这条上被挡住：
 *       - 跳过进行中直接 pending → completed（把没做的活顺手勾了）；
 *       - 同一轮里刚标 in_progress 又标 completed，中间一次工具都没跑（勾了个寂寞）。
 *     被挡下的退回它原来的状态，理由随工具回执一起告诉模型——它下一次就会先做再勾。
 *
 * 第一份计划（之前没有计划）例外：模型常常把开局前已经做过的事直接列成 completed，那不是
 * 假勾，是记账。这时只要本轮确实有过执行证据就照收；一条证据都没有的「全 completed」由
 * 调用方那道 _unprovenPlanCompletionIssue 单独处理。
 *
 * 纯函数：不碰传进来的数组和对象；返回新数组。步骤按文字（去空白、小写）对应上一版。
 */

const norm = (c) => String(c || "").trim().toLowerCase();

/** 把上一版里这一步的记账（何时开始、攒了多少证据）带到新版。 */
function carry(prev, step) {
  if (!prev) return step;
  const out = { ...step };
  for (const k of ["startedAt", "evidence", "lastEvidence", "advancedBy"]) {
    if (prev[k] !== undefined && out[k] === undefined) out[k] = prev[k];
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array} p.prev 落地前的计划（run._planSteps），没有就传空
 * @param {Array} p.next 模型这次交上来的（已归一化的）步骤
 * @param {number} p.iter 本轮是第几次模型调用（0 起）
 * @param {number} p.evidence 本 run 到现在为止的执行证据计数（读/写/命令/外部操作）
 * @returns {{ steps: Array, notes: string[], changed: boolean }}
 */
export function reconcilePlanUpdate({ prev = [], next = [], iter = 0, evidence = 0 } = {}) {
  const before = Array.isArray(prev) ? prev.filter(Boolean) : [];
  const submitted = Array.isArray(next) ? next.filter(Boolean) : [];
  const prevByKey = new Map();
  for (const s of before) {
    const k = norm(s.content);
    if (k && !prevByKey.has(k)) prevByKey.set(k, s);
  }
  const hadPlan = before.length > 0;
  const it = Number(iter) || 0;
  const ev = Number(evidence) || 0;
  const notes = [];
  let changed = false;

  let steps = submitted.map((s) => carry(prevByKey.get(norm(s.content)), s));

  // ── 没做完不许勾 ────────────────────────────────────────────────────────
  // 这一关必须排在「一次只做一步」**之前**：它会把一步从 completed 退回 in_progress，
  // 于是那一步和模型交上来的下一步就同时在进行中了 —— 顺序反过来的话，这个新产生的
  // 双进行中没人再收拾，用户看到的还是两步一起亮着。
  steps = steps.map((s) => {
    if (s.status !== "completed") return s;
    const was = prevByKey.get(norm(s.content));
    if (was?.status === "completed") return s;            // 早就完成的，原样
    if (!hadPlan) {
      // 第一份计划：开局前做过的事列成 completed 是记账，不是假勾——只要本轮真有证据。
      if (ev > 0) return s;
      changed = true;
      notes.push(`「${String(s.content).slice(0, 40)}」本轮还没有任何执行证据，退回待办`);
      return { ...s, status: "pending" };
    }
    if (was?.status === "in_progress") {
      const started = was.startedAt || {};
      const startedIter = Number(started.iter) || 0;
      const startedEv = Number(started.evidence) || 0;
      if (it > startedIter || ev > startedEv) return s;
      changed = true;
      notes.push(`「${String(s.content).slice(0, 40)}」刚标成进行中，这之后一次工具都没跑，先做再标 completed`);
      return { ...s, status: "in_progress" };
    }
    // pending → completed 一步到位，或者是新加进来就说做完了的步骤
    changed = true;
    notes.push(`「${String(s.content).slice(0, 40)}」没经过进行中就被标成完成，退回待办：先标 in_progress，做完再标 completed`);
    return { ...s, status: "pending" };
  });

  // ── 一次只做一步 ────────────────────────────────────────────────────────
  const active = steps.map((s, i) => (s.status === "in_progress" ? i : -1)).filter((i) => i >= 0);
  if (active.length > 1) {
    const wasActive = active.find((i) => prevByKey.get(norm(steps[i].content))?.status === "in_progress");
    const keep = wasActive !== undefined ? wasActive : active[0];
    const demoted = [];
    steps = steps.map((s, i) => {
      if (i === keep || s.status !== "in_progress") return s;
      demoted.push(`「${String(s.content).slice(0, 40)}」`);
      return { ...s, status: "pending" };
    });
    changed = true;
    notes.push(`一次只做一步：${demoted.join("、")}退回待办，「${String(steps[keep].content).slice(0, 40)}」保持进行中；做完它再把下一步标 in_progress`);
  }

  // ── 当前步骤记账：新进入进行中的那一步记下从何时算起 ─────────────────────
  const hasActive = steps.some((s) => s.status === "in_progress");
  if (!hasActive) {
    const idx = steps.findIndex((s) => s.status === "pending");
    if (idx >= 0) steps = steps.map((s, i) => (i === idx ? { ...s, status: "in_progress" } : s));
  }
  steps = steps.map((s) => {
    if (s.status !== "in_progress") return s;
    const was = prevByKey.get(norm(s.content));
    if (was?.status === "in_progress" && was.startedAt) return s.startedAt ? s : { ...s, startedAt: was.startedAt };
    return { ...s, startedAt: { iter: it, evidence: ev } };
  });

  return { steps, notes, changed };
}
