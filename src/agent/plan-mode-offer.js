// 模型提议进入 Plan 模式 → 用户确认 → 本轮当场生效。
//
// 所有者原话（2026-09-04）：「我最新的 plan 模式也要能用，比如 update_plan 需要用到我的
// plan 模式时候，给用户确认，那么也能用」。配套的另一半是同一天那句「update_plan 要根据
// 模型觉得要不要用，而不是直接触发的」—— 两句合起来就是 Claude Code 的形状：**判断权在
// 模型，开关权在用户，harness 一处都不硬触发**。所以这里没有任何「什么时候该进 Plan 模式」
// 的启发式判据：模型在 update_plan 上声明 plan_mode，harness 只负责问一句、按答案落实。
//
// 为什么必须走确认、不能模型说了算：进 Plan 模式会把写工具从它自己的工具表里撤下来。
// 那是用户这一轮能不能拿到东西的分水岭 —— 用户说「改一下这个」，模型自作主张切成只读、
// 回一份方案，就是「不完全遵循用户说的话」。
export const PLAN_MODE_YES = "进入 Plan 模式";
export const PLAN_MODE_NO = "不用，直接开始做";

/**
 * 这一次到底问不问用户。返回 { ask, reason }。
 * 不问的时候 reason 要能变成一句给模型的话——否则模型声明了 plan_mode 却什么反馈都没有，
 * 会以为自己已经在只读模式里，然后按只读的口径收尾（用户拿到一份方案，而他要的是改动）。
 */
export function planModeOffer({ mode, requested, unattended, alreadyAsked, steps } = {}) {
  if (!requested) return { ask: false, reason: "" };
  if (mode !== "agent") return { ask: false, reason: "not-agent" };
  if (!Array.isArray(steps) || !steps.length) return { ask: false, reason: "no-steps" };
  // 一轮只问一次。第二次问同一件事就是用户实测抱怨过的「一直不停问问问」，
  // 而且第一次的答案已经是这一轮的答案了。
  if (alreadyAsked) return { ask: false, reason: "already" };
  if (unattended) return { ask: false, reason: "unattended" };
  return {
    ask: true,
    question: "这一轮要先切到 Plan 模式（只读出方案）吗？",
    options: [
      { label: PLAN_MODE_YES, description: "本轮只读：撤下写文件和跑命令的工具，先把方案讲清楚，你点「用 Agent 执行此方案」再动手" },
      { label: PLAN_MODE_NO, description: "保持 Agent 模式，按刚收下的计划直接开始做" },
    ],
  };
}

/**
 * 卡片答完之后的判据。
 *
 * 只认「用户点了那个按钮」这一种是。取消、超时、在「其他」里自己打字，一律按**不切**处理
 * —— 默认值必须是「维持现状」：判错成「切了」的代价是用户要的改动一个字没落盘，判错成
 * 「没切」的代价只是模型多写了几个文件。两边不对称，就该往不对称的轻的那头倒。
 */
export function planModeAnswerIsYes(answer) {
  return String(answer || "").includes("「" + PLAN_MODE_YES + "」");
}

/** 进入之后，把写工具从这一轮的工具窗口里撤下来。返回被撤下的名字。 */
export function dropWriteTools(win, isBlocked) {
  if (!Array.isArray(win) || typeof isBlocked !== "function") return [];
  const name = (t) => String(t?.function?.name || "");
  const dropped = win.filter((t) => name(t) && isBlocked(name(t))).map(name);
  if (dropped.length) {
    const keep = win.filter((t) => !(name(t) && isBlocked(name(t))));
    win.splice(0, win.length, ...keep);
  }
  return dropped;
}

/**
 * 进入之后给模型的那段话。
 *
 * discipline 由调用方传 `_modeRuntimeGuidanceBlock("plan", …)` 的**原文**进来，不在这里
 * 重抄一份：那段纪律另有两个消费方（run 起点的上下文前言、模式选择器），抄第三份就是
 * 三份会各自漂。
 *
 * 必须讲清「系统提示词没变」：模式是中途切的，而系统提示词整轮冻结（messages[0] 在 run
 * 起点就定死，全文件没有第二个赋值点）。模型手上那份仍然是 Agent 那一份，里面写着去写
 * 代码。不点破的话它读到的是两条互相矛盾的指令，而更早的那条看起来更权威。
 */
export function planModeEnteredNote({ dropped, discipline } = {}) {
  const list = Array.isArray(dropped) ? dropped : [];
  // 头一句是**撤回**，不是客套：上面那段计划回执是在切模式之前拼的，它对 agent 模式说的是
  // 「现在去做第一步」。不当场作废，模型读到的就是两句直接打架的指令。
  return "\n\n[已进入 Plan 模式]（上面那句「现在去做第一步」作废——本轮一步都不执行。）"
    + "用户确认了：**从这一刻起本轮是只读的**。"
    + (list.length
      ? `已经把 ${list.length} 个会改东西的工具从你的工具表里撤下（${list.slice(0, 8).join("、")}${list.length > 8 ? "…" : ""}）——不是拦你，是真的不在表里了。`
      : "写文件和跑命令的工具这一轮不可用。")
    + "\nread_file / search / find_files / list_dir / update_plan 这些照常可用，取证该做多少做多少。"
    + "\n\n注意：模式是**中途**切的，而系统提示词整轮冻结——你手上那份仍然是 Agent 那一份，"
    + "里面让你去写代码。**以这一条为准。**"
    + String(discipline || "")
    + "\n\n本轮结束时用户会看到「用 Agent 执行此方案」按钮，点了才开始动手。所以现在把方案交代清楚，"
    + "不要在收尾里说任何东西已经实现了。";
}

/** 用户没点头。原话要原样带回去——他可能在「其他」里直接把要求写了。 */
export function planModeDeclinedNote(answer) {
  const said = String(answer || "").trim();
  return "\n\n[仍是 Agent 模式] 用户没有选择切到 Plan 模式。"
    + (said ? `\n用户的回答：${said}` : "")
    + "\n计划已经收下了，**现在去做第一步**，别再问要不要规划。";
}

/** 声明了 plan_mode 但这一次没能问出去——把原因讲给模型，别让它以为已经切了。 */
export function planModeNotOfferedNote(reason) {
  if (reason === "not-agent") return "\n\n[plan_mode 未生效] 这一轮本来就不是 Agent 模式，没有可切的。";
  if (reason === "no-steps") return "\n\n[plan_mode 未生效] 这份计划一步都没解析出来，空计划不值得为它切模式。先把步骤写出来。";
  if (reason === "already") return "\n\n[plan_mode 未生效] 这一轮已经问过用户一次了，答案就是那一次的答案，不再问第二次。";
  if (reason === "unattended") return "\n\n[plan_mode 未生效] 本次运行是无人值守启动的（定时任务），此刻没有人能确认，卡片没有弹出。按 Agent 模式把事情做完，并把你原本想先确认的那一点写进最终回答。";
  return "";
}

// ── 用户在 Plan 模式里说「执行」 ────────────────────────────────────────────────
//
// 所有者（2026-09-07）：「如果我用 plan 模式的话，那么他只能写出计划给我，如果用户点击执行那些
// 的话，记得下面 plan 模式自动切换成 agent 模式」。两颗按钮（回复末尾的「用 Agent 执行此方案」、
// 方案页签的「按这个方案执行」）早就会切；漏的是**用户直接在输入框里说**「执行 / 开始做 / 就这么办」
// 这条路——原来它照旧按 Plan 模式跑，模型只能再写一份方案，用户以为软件没听懂。
//
// 判据只认「对已交付方案的放行」：单纯点头、短祈使、或明确的执行动词。带问号的（还在问）、带否定
// 的（先别执行）、在改方案的（第三步换成…）都不算——判错成「切了」的代价是用户想继续讨论却被动手
// 改了文件，判错成「没切」只是再点一下按钮，往轻的那头倒。
const EXEC_VERB_RE = new RegExp([
  "(?:^|[^不别没未])(?:执行|实施|落地|动手|开干|开做|去做|搞起|开搞|开整|走起|安排上)",
  "开始(?:做|干|写|改|实现|实施|执行|动手|吧|了)",
  "(?:按照|按|照|依)(?:这个|此|上面|该|你的|这份|你说的)?的?(?:方案|计划|步骤)(?:做|来|走|执行|实施|实现|推进|开始)?",
  "就按(?:这个|此|上面|这份|你的|你说的)(?:来|做|办|走|执行|实施|实现)",
  "就这么(?:做|办|来|干|搞|定)", "(?:做|干|来|上|搞|整)吧$", "实现(?:它|吧|这个方案|这个计划)",
  "go ahead", "do it", "let'?s (?:do|go|build|start|ship)", "\\bproceed\\b", "implement(?: it| this| the plan)?",
  "\\bexecute\\b", "carry (?:it )?out", "ship it", "build it", "make it (?:so|happen)",
  "start (?:implementing|building|coding|now|working)", "run the plan", "\\bapproved?\\b", "sounds good", "looks good", "\\blgtm\\b",
].join("|"), "i");
// 单纯点头：整句只由这些词组成（最多四个，逗号句号随意）。
const ACK_ONLY_RE = /^(?:(?:好的|好啊|好吧|好|行吧|行|可以的|可以|嗯|恩|对|同意|确认|批准|没问题|就这样吧|就这样|就这么办|ok|okay|yes|yep|yeah|sure|go|approved|approve|lgtm|👍|✅)[,，、。！!.\s~～]*){1,4}$/i;
const NEGATION_RE = /(?:不要|不用|别|先不|先别|暂不|暂时不|不必|不急|不着急|等等|等一下|等下|稍等|don'?t|do not|not (?:yet|now)|hold (?:off|on)|\bwait\b|\blater\b)/i;
// 还在讨论方案：问句、改方案、要解释。
const DISCUSS_RE = /[?？吗]\s*$|(?:怎么|为什么|为啥|是不是|能不能|可不可以|要不要|有没有|哪个|什么|如何|多久|多少)|(?:改一?下|换成|改成|加上|去掉|删掉|删除|调整|补充|再详细|详细说|展开说|解释|说说|讲讲|重新(?:规划|出|写)|再出一?份|换个方案|另一个方案|\bwhy\b|\bhow\b|\bwhat\b|\bwhich\b|explain|instead|\bchange\b|modify|revise|\badd |\bremove\b|\bdrop\b)/i;

/**
 * 用户这一句是不是在放行已交付的方案。返回 { execute, reason }。
 * 调用方自己保证「会话在 Plan 模式」且「确实交付过方案」——这里只看这一句话。
 */
export function planExecuteIntent(text) {
  const t = String(text || "").trim();
  if (!t) return { execute: false, reason: "empty" };
  // 长段落是新需求或新一轮讨论，不是放行。
  if (t.length > 400) return { execute: false, reason: "too-long" };
  if (ACK_ONLY_RE.test(t)) return { execute: true, reason: "ack" };
  if (NEGATION_RE.test(t)) return { execute: false, reason: "negated" };
  if (!EXEC_VERB_RE.test(t)) return { execute: false, reason: "no-verb" };
  if (DISCUSS_RE.test(t)) return { execute: false, reason: "still-discussing" };
  return { execute: true, reason: "verb" };
}
