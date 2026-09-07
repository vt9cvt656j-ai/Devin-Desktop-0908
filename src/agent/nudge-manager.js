/**
 * 主循环里 harness 对模型说的话——提醒（nudge）的登记、替换、淘汰、清扫，和「事实」投递。
 *
 * 从 `_runAgenticLoop` 里搬出来的第一段（阶段 4：让五步骨架露出来）。搬出来的判据：只依赖
 * 参数（messages / run / 一组 getter），没有 DOM、没有模块级可变状态——测试能拿一份干净的
 * messages 数组做真往返，而不是抠源码。**逻辑逐字不变**，call sites 在 main.js 里保持原名。
 *
 * 治的是「提醒消息越堆越多」的 context rot：循环里各种 harness 注入的提醒（verify 报错 /
 * 卡住诊断 / churn 警告 / 工具目录刷新…）以前全是永久 user 消息，长任务里能堆几十条：
 * token 白烧、旧提醒和新状态互相打架、还稀释真正的用户指令。现在按「类别」管理：同类新提醒
 * **替换**旧的（只留最新一条），离上下文尾部太远的陈旧提醒每轮自动注销。
 */

/**
 * 提醒的重要性分级。判据只有一条：**丢了它，模型会不会按错误的图景继续干活**。
 *   事实类 —— 丢了就等于让它蒙着眼睛干：构建失败、新增诊断错误、改了从没读过的文件、
 *            子智能体带回来的结果、工具被闸门挡住、磁盘实况纠正历史误信。
 *   建议类 —— 丢了只是少一句提点：先调研、先出计划、别原地打转、提问次数提醒。
 * 没登记的一律按建议类处理——新加的提醒默认可丢，要保命就显式登记。
 */
export const _NUDGE_FACTS = new Set([
  // turnRetry：「上一轮线路断了，这几个文件已经落盘」是执行记录不是建议。
  "toolRepair", "turnRetry", "buildFix", "diag", "diagFinish", "bugEvidence",
  // 「刚改完、这个版本还没验过」是执行记账里的硬事实，丢了模型就会照着"应该没问题"收尾。
  "blindEdit", "subagentResult",
  // researchFirst 和 websiteContent 是同一个判据的两半（取证台账是空的），由执行事实算出来，
  // 陈述的不是"建议你去查一下"，是"这一栏现在是零"。它偏偏在第一次写入那一刻推（整个 run
  // 只有这一次机会），挤掉就等于这一整个 run 再也不会有第二次提起。
  "researchFirst",
]);

/**
 * **一次性**提醒：整个 run 只推得出来一次，被挤掉就是永久失去。判据是结构性的：推送点由一个
 * run 级标记守着（读了就置位）。这一档必须保持短——它挡在 ≤4 的名额前面，列进来的越多，
 * 上限越接近失效。加新的一条之前先问：它的推送点真的被 run 级一次性标记守着吗？
 */
export const _NUDGE_ONCE = new Set([
  "researchFirst",      // researchGateNudges < 1
  "planFinish",         // run._planQuestionIntercepted（建议类里唯一的一次性）
]);

/** 数字越大越先被淘汰：steer < 一次性 < 普通事实 < 建议。 */
export const _nudgeRank = (cat) => (cat === "steer" ? 0 : _NUDGE_ONCE.has(cat) ? 1 : _NUDGE_FACTS.has(cat) ? 2 : 3);

/** 建议类同时只留几条；所有类别（steer 除外）同时最多几条。 */
export const NUDGE_ADVICE_CAP = 1;
export const NUDGE_TOTAL_CAP = 4;
/** 距尾超过这么多条的提醒早已过时：注销（退出管理），但不从历史里抠。 */
export const NUDGE_STALE_DISTANCE = 14;

/**
 * @param {{
 *   messages: Array<{role:string, content:string}>,
 *   run: object,
 *   orchNote: string,                       // 编排信封前缀（_ORCH_NOTE）
 *   isEnabled: () => boolean,               // harness 提醒总闸
 *   exempt: Set<string>,                    // 不受总闸管的类别（NUDGE_GATE_EXEMPT）
 *   floor: () => number,                    // 本轮尾部区间起点（_nudgeTurnFloor 的 getter）
 *   readCap?: () => number,                 // 单次运行 token 预算（0 = 没设）
 *   usageTokens?: () => number,             // 本 run 已结算 token
 *   billingTasks?: () => Array<Promise<any>>|undefined,
 * }} deps
 */
export function createNudgeManager(deps) {
  const { messages, run, orchNote = "", exempt, floor } = deps;
  const isEnabled = typeof deps.isEnabled === "function" ? deps.isEnabled : () => true;
  const readCap = typeof deps.readCap === "function" ? deps.readCap : () => 0;
  const usageTokens = typeof deps.usageTokens === "function" ? deps.usageTokens : () => 0;
  const billingTasks = typeof deps.billingTasks === "function" ? deps.billingTasks : () => run?._billingTasks;
  const floorAt = () => Number(floor?.()) || 0;
  /** category → message object（按身份 splice，不加自定义字段防 API 拒收） */
  const reg = new Map();

  // 提醒的增删也要守「历史只进不摆」那条棘轮：只有「旧条就在本轮刚推的这一截里」才 splice
  //（那是尾部，上游前缀缓存本来就没覆盖到），更早的留在原地当历史、只从登记表里摘掉。
  // 从消息中段抠掉一条，上游前缀缓存从那一点起全部失效——为省一条两百字的提醒重算几万 token。
  const _dropNudge = (victim) => {
    const oldMsg = reg.get(victim);
    const oi = messages.indexOf(oldMsg);
    if (oi >= floorAt()) messages.splice(oi, 1);
    reg.delete(victim);
  };

  const _pushNudge = (cat, content) => {
    // **先记账，再看闸。** 这套提醒有几十个注入点，每条都为修一个真实事故而加，但叠在一起就是
    // 「简单事情也长篇大论、一个任务跑 27 步」。没人量过它们帮了多少、害了多少——所以计数在
    // 闸门之前：关掉之后「本来会推几条」照样有数，A/B 才比得了。steer 不受闸门管：那是用户
    // 自己的实时插话，不是 harness 的话。
    run._nudgeCounts = run._nudgeCounts || Object.create(null);
    run._nudgeCounts[cat] = (run._nudgeCounts[cat] || 0) + 1;
    run._nudgeAttempts = (run._nudgeAttempts || 0) + 1;
    if (!(exempt && exempt.has(cat)) && !isEnabled()) {
      run._nudgeSuppressed = (run._nudgeSuppressed || 0) + 1;
      return;
    }
    const prev = reg.get(cat);
    if (prev) {
      const i = messages.indexOf(prev);
      if (i >= floorAt()) messages.splice(i, 1);
    }
    // 同轮活跃上限。「总数 ≤2」把病治过头了：一条 [BUILD_FAILED] 的真实 stderr、一条"你改了
    // 从没读过的文件"、一份子智能体带回的结论——三份互不替代的现场，丢哪一条模型都会照着错误
    // 的图景继续干活。"逐条表态"的病根在建议类，所以分开算：建议只留 1 条，总额 4 条，
    // 超额时按重要性挑（先建议、再最旧的事实）。
    const incomingRank = _nudgeRank(cat);
    for (;;) {
      const others = [...reg.keys()].filter((key) => key !== "steer" && key !== cat);
      const advice = others.filter((key) => _nudgeRank(key) === 3);
      if (advice.length > (incomingRank === 3 ? 0 : NUDGE_ADVICE_CAP)) { _dropNudge(advice[0]); continue; }
      if (others.length + 1 <= NUDGE_TOTAL_CAP) break;
      // Map 的键序就是插入序，reduce 用严格大于 → 同级里保留最先遇到的那个，也就是最旧的先走。
      _dropNudge(others.reduce((worst, key) => (_nudgeRank(key) > _nudgeRank(worst) ? key : worst)));
    }
    const m = { role: "user", content: orchNote + content };
    reg.set(cat, m);
    messages.push(m);
  };

  // 陈旧提醒**注销**，但不从消息里抠：它要退出的是占名额、挡同类刷新、被 clear 连坐这三件事。
  const _sweepNudges = () => {
    for (const [cat, m] of reg) {
      const i = messages.indexOf(m);
      if (i === -1) { reg.delete(cat); continue; }
      if (messages.length - i > NUDGE_STALE_DISTANCE) reg.delete(cat);
    }
  };

  const _clearNudges = () => {
    for (const m of reg.values()) {
      const i = messages.indexOf(m);
      if (i >= floorAt()) messages.splice(i, 1);
    }
    reg.clear();
  };

  // 提醒之外的另一条投递路：**事实**的载体不能是"随时会被撤走的提醒"。子智能体报告是主 run
  // 花了几十个模型轮次换回来的证据——它必须像工具结果一样留在历史里，三条删除路径都够不着它。
  const _pushRunFact = (content) => {
    const m = { role: "user", content: orchNote + content };
    messages.push(m);
    return m;
  };

  // ── 单次运行 token 预算：判定挂在**结算落地**那一刻，不在读数那一刻 ──
  // 结算是后台任务，模型轮刚结束时账上还是空的；在那一刻同步读会错位一轮、被上个 run 的
  // 尾数污染。改成：结算 promise 落地 → 用本 run 自己的账重算并判超限，只置一个标记；
  // 下一轮迭代开头消费这个标记推收尾提醒。
  const noteTokenCapOnSettlement = () => {
    if (run._tokenCapNudged || run._tokenCapPending) return;
    const cap = readCap();
    if (!cap) return;
    const used = usageTokens();
    if (used > cap) run._tokenCapPending = { used, cap };
  };
  const hooked = new WeakSet();
  const hookSettlementTasks = () => {
    for (const task of billingTasks() || []) {
      if (!task || typeof task.then !== "function" || hooked.has(task)) continue;
      hooked.add(task);
      task.then(noteTokenCapOnSettlement, () => {});
    }
  };

  return { reg, push: _pushNudge, sweep: _sweepNudges, clear: _clearNudges, pushRunFact: _pushRunFact, noteTokenCapOnSettlement, hookSettlementTasks, rank: _nudgeRank };
}
