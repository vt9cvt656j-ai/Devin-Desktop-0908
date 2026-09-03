/**
 * ask_user 那张卡片的纯逻辑：选项归一化、单选/多选怎么定、交回给模型的那句话怎么写。
 *
 * DOM、键盘、动画全在 main.js 那一半。这里没有 window、没有 document，所以测试是真跑出来的。
 */

/** 卡片上最多列几项。超过这个数，用户就不是在"选"而是在"读列表"了。 */
export const ASK_MAX_OPTIONS = 5;

/**
 * 选项归一化。
 *
 * 两种写法都收：`"批量测试哪些代理可用"` 和 `{ label: "…", description: "…" }`。
 * 后者是给「光看标签分不出差别」的选项用的——两个选项都叫"重建"和"迁移"时，
 * 真正决定用户怎么选的是那行小字（会不会丢数据、要多久）。没有 description 就不画那一行。
 *
 * 空标签直接丢掉：模型偶尔会塞一个空串进来，画出来是一个点不动的空按钮。
 */
export function normalizeAskOptions(raw, max = ASK_MAX_OPTIONS) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (out.length >= Math.max(1, max)) break;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const label = String(item.label ?? item.title ?? item.text ?? item.value ?? "").trim();
      if (!label) continue;
      const description = String(item.description ?? item.detail ?? item.hint ?? "").trim();
      out.push(description ? { label, description } : { label });
      continue;
    }
    const label = String(item ?? "").trim();
    if (label) out.push({ label });
  }
  return out;
}

/**
 * 这张卡片是单选、多选，还是只有输入框。
 *
 * **判据写死在这里，不靠调用方各自记：**
 *  · `text`   —— 一个选项都没有（或只有一个）。一个选项的"选择"不是选择，直接让人打字。
 *  · `multi`  —— 模型显式声明 multi_select，且至少两个选项。语义是"这些可以同时成立"
 *                （挑要启用的功能、挑要一起改的文件）。
 *  · `single` —— 其余。语义是"这几条互斥，只能走一条"（改数据库是原地迁移还是重建）。
 *
 * 为什么 multi 必须由模型显式声明、不去猜：猜错的两个方向代价不对称。把互斥问题画成多选，
 * 用户能同时勾上"原地迁移"和"推倒重建"，模型收到一个自相矛盾的答案；而把可并存的问题画成
 * 单选，用户至少还能用输入框补一句。所以默认单选，多选是模型主动要的。
 */
export function askMode({ options, multiSelect } = {}) {
  const n = Array.isArray(options) ? options.length : 0;
  if (n < 2) return "text";
  return multiSelect ? "multi" : "single";
}

/**
 * 交回给模型的那句话。
 *
 * 要素三样，缺一样模型就会走偏：用户**选了什么**、这是**哪一种**选择（单选/多选/自己打的/
 * 让你定），以及**接下来照它做**。多选尤其要说清是"这几项都要"，否则模型常只挑第一项做。
 */
export function askAnswerText(kind, payload) {
  const p = payload || {};
  if (kind === "single") return `用户选择了：「${p.label}」。就按这个需求继续做。`;
  if (kind === "multi") {
    const picked = Array.isArray(p.labels) ? p.labels : [];
    return `用户勾选了这 ${picked.length} 项，**每一项都要做**：${picked.map((l) => `「${l}」`).join("")}。`
      + `按这些需求继续做，不要只挑其中一项。`;
  }
  if (kind === "custom") return `用户输入了具体需求：${p.text}。就按这个继续做。`;
  if (kind === "auto") return "用户让你自行判断——按你认为最合理的方案直接继续做，别再问。";
  if (kind === "confirm") return `用户已输入确认文本「${p.text}」确认执行。继续。`;
  if (kind === "cancel") return "[已取消] 当前等待已因任务停止或被新的请求替换，不要继续此步骤。";
  return "";
}

/** 卡片答完之后原地显示的那一行短标签。 */
export function askAnswerLabel(kind, payload) {
  const p = payload || {};
  if (kind === "single") return `你选了：${p.label}`;
  if (kind === "multi") return `你选了：${(Array.isArray(p.labels) ? p.labels : []).join("、")}`;
  if (kind === "custom") return `你的需求：${p.text}`;
  if (kind === "auto") return "AI 自行判断";
  if (kind === "confirm") return `已确认：${p.text}`;
  if (kind === "cancel") return "已取消";
  return "";
}

// ---------------------------------------------------------------------------
// 提问边界：模型这一轮以问句收尾时，是把它按回去继续做，还是真的停下来等用户。
// ---------------------------------------------------------------------------

/**
 * 「把问题按回去」的次数上限。
 *
 * **这个常数存在的唯一理由是止住一次无界自旋。** 原来的判据是
 * `if (run._askUserCount >= 3) { 推提醒; continue; }` —— 而 `_askUserCount` 只增不减，
 * 所以第 4、5、6……次提问全部再次命中同一条，每次都 continue。结果是：
 * 模型只要每轮以一句问句收尾，循环就**永不退出**，每轮一次完整付费模型调用，
 * 只能靠用户按停（按停还被记成 user_stopped）。
 *
 * 而且这条腿绕得过所有兜底：外层 `for (let iter = 0; iter < budget)` 的 budget 是
 * `Infinity`，空转断路器 `_idleIters++` 在循环体尾部、这条腿在它之前就 continue 走了，
 * 静默轮的 `quietTurns++` 同样够不着。**全循环唯一一处缺陷直接换算成账单的地方。**
 *
 * Claude Code 的 `while (true)` 敢那么写，靠的是一条不变量：**只有模型能决定停**，
 * 没有任何一条强制续跑腿。这里做不到完全没有（那些提醒各自有事故背书），
 * 那退而求其次：每一条强制续跑腿都必须有**有限的预算**。
 */
export const ASK_PUSHBACK_LIMIT = 2;

/**
 * 决定一次「模型正文提问」怎么处理。纯函数：不读 DOM、不读全局、不做 IO。
 *
 * @param facts 全部来自调用点现成的值
 *   - planSteps        run._planSteps（原样传，内部自己过滤 pending/in_progress）
 *   - planIntercepted  run._planQuestionIntercepted（计划提醒是否已经用掉那一次）
 *   - askUserCount     run._askUserCount（卡片提问和正文提问**合并**计数）
 *   - pushbacks        run._askPushbacks（已经把问题按回去几次）
 *   - planInherited / planTouched  用于判断计划是不是「继承来又没碰过」
 *   - live             _live()，用户按停之后一律不再推提醒
 * @returns
 *   - action: "resume" 继续跑 | "await_user" 停下来等用户
 *   - nudge:  要推给模型的提醒（null 表示不推）
 *   - incompleteReason: 收尾记账用；null 表示不写
 *   - counters: 调用方要写回 run 上的计数
 */
export function decideQuestionBoundary(facts = {}) {
  const {
    planSteps, planIntercepted = false, askUserCount = 0, pushbacks = 0,
    planInherited = false, planTouched = false, live = true,
  } = facts;
  const pending = (Array.isArray(planSteps) ? planSteps : [])
    .filter((s) => s?.status === "pending" || s?.status === "in_progress");
  // 「继承来、本轮模型压根没碰过」的陈旧计划不参与任何强制续跑：
  // 否则一次不相干的问答会因为上一轮留下的计划硬多跑一轮。
  const planActionable = pending.length > 0 && (!planInherited || planTouched);
  const nextCount = askUserCount + 1;

  // ① 计划还剩步骤：拦一次，把问题按回去继续做。第二次再问就是真的在等用户了。
  if (planActionable && live && !planIntercepted) {
    return {
      action: "resume",
      nudge: { cat: "planFinish", text: `计划还剩 ${pending.length} 步没做完（下一步：${pending[0].content}）。`
        + `\n这不是需要用户拍板的方向问题，直接继续做，别用「要不要我继续」停下来。` },
      incompleteReason: null,
      counters: { askUserCount, pushbacks: pushbacks + 1, planIntercepted: true },
    };
  }

  // ② 问得太多：推一次「别再问了」。**但这条腿有预算** —— 预算用完就必须停，
  //    否则就是上面那个常数注释里说的无界自旋。
  if (nextCount >= 3 && live && pushbacks < ASK_PUSHBACK_LIMIT) {
    return {
      action: "resume",
      nudge: { cat: "askBudget", text: `这是本次任务第 ${nextCount} 次向用户提问（卡片和正文提问合并计数）。`
        + `\n别再问了：按最合理的方案直接做下去，把假设写进最终回答（"我按 X 处理了，因为 Y；要是你想要 Z，说一声我改"）。`
        + `\n能自己查清的先查（read_file / search / probe_env 都在手边）。`
        + `\n只有在"不做假设就没法继续、或者做错了整个成果作废"时才停——那种情况把卡在哪、需要什么写进最终回答，用一句话说清，而不是再问一次。` },
      incompleteReason: null,
      counters: { askUserCount: nextCount, pushbacks: pushbacks + 1, planIntercepted },
    };
  }

  // ③ 真的在等用户了。计划还有剩步就如实记账 —— 别让 awaiting_user 读起来像干净收工。
  return {
    action: "await_user",
    nudge: null,
    incompleteReason: planActionable ? `plan_steps_pending:${pending.length}` : null,
    counters: { askUserCount: nextCount, pushbacks, planIntercepted },
  };
}
