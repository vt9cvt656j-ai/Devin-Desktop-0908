// 静默轮的停止决策。
//
// 模型这一轮没调工具——在 Claude Code 里这就是 `if (!toolCalls.length) break`，一句话。
// 这里之所以不止一句，是因为这套系统多认四条**已观测到的执行事实**：用户插话、
// 新增诊断、声明为验证的命令红了、模型自己用 update_plan 立下的计划没做完。
// 每一条都由机器产生（输入队列里真有消息 / 诊断相对基线有增量 / 退出码非零 /
// 计划步骤状态），**模型正文里的任何措辞都不是事实**。
//
// 把「判定」从「动作」里分出来，理由和 ask-user.js 那次一样：判定能在 Node 里真跑，
// 于是守卫可以做真往返，而不是去匹配 main.js 的源码文本（本仓库有一整类断言
// 「真实却守错了东西」的坑）。动作——推提醒、清计数、continue——仍留在循环里，
// 因为提醒的正文要拼运行时数据，而 continue 是控制流，搬不出去。
//
// 两类错误的代价不对称：**停早了**用户打一句「继续」，成本一轮；**停晚了**是烧钱空转、
// 把用户明说别动的文件改掉、把一次干净成功盖成 partial。所以分界线画在保守一侧。

/** 全局续跑预算：四道门各自还有子上限，这个池子防止它们加起来能多转 9 轮。 */
export const QUIET_RESUME_POOL = 3;

/**
 * @param f 事实（全部由机器产生，不含任何对模型措辞的解读）
 *   mode                 运行模式；非 "agent" 时所有门关闭
 *   userDenied           用户拒绝过这一轮的动作
 *   readOnlyBlocked      只读模式拦下过
 *   live                 这一轮还活着（没被按停）
 *   quietTurns           连续静默轮数（本轮已计入）
 *   quietResumePool      剩余全局续跑预算；null/undefined 视为满
 *   steerQueued          用户输入队列里真有消息
 *   diagnosticBlock      本轮改动引入的新增诊断文本（空串/假值 = 没有）
 *   diagnosticNudges     诊断门已经开过几次
 *   lastSuccessfulEdits  **上一轮**成功编辑数（不是本轮——本轮的还没汇总，读它是 TDZ）
 *   buildFail            _freshBuildFailure 的结果（对象或 null）
 *   buildFixAttempts     构建门已经开过几次
 *   pendingPlanSteps     未完成的计划步骤数
 *   planActionable       计划是本轮模型碰过的（继承来又没碰过的不许硬顶回合）
 *   planFinishNudges     计划门已经开过几次
 *
 * @returns
 *   action  "continue"（再转一轮）或 "break"（收尾）
 *   gate    是哪道门开的：steer | diagnostics | build | plan | null
 *   counters 要写回去的计数器（只含变了的）
 *   labels  要记进 incompleteReason 的原因，按优先级排列（先到先占位）
 */
export function decideQuietTurn(f) {
  const counters = {};
  const labels = [];
  const nope = (extra = {}) => ({ action: "break", gate: null, counters, labels, ...extra });

  if (!f.live) return nope();

  // R0 全局关闸。用的是执行事实，不是画像推出来的 explicitReadOnly——
  // 纯问答时那个字段是 false，救不了任何一次问答。
  const gatesOff = f.mode !== "agent" || f.userDenied === true || f.readOnlyBlocked === true;
  // R2 连续静默闸：推了提醒、模型却只把文字重写一遍 → 立刻停。正常修复路径
  // （推提醒 → 调工具修 → 再静默）中间那个工具轮会把 quietTurns 归零，所以这条只拦真空转。
  const quietRepeat = (f.quietTurns || 0) >= 2;
  const pool = f.quietResumePool == null ? QUIET_RESUME_POOL : f.quietResumePool;
  const canResume = !gatesOff && !quietRepeat && pool > 0;

  // R1 用户插话优先于所有门。用户重新定义了任务，之前的欠账账本一并作废——
  // 五个计数器全部清零，否则账没销干净，下一轮又被旧欠账挟持。
  if (f.steerQueued && !gatesOff) {
    return {
      action: "continue", gate: "steer", labels,
      counters: {
        diagnosticNudges: 0, buildFixAttempts: 0, planFinishNudges: 0,
        quietResumePool: QUIET_RESUME_POOL, quietTurns: 0,
      },
    };
  }

  // ① 新增诊断：这次改动把项目改红了。
  if (f.diagnosticBlock) {
    if (canResume && (f.diagnosticNudges || 0) < 2) {
      // 上一轮已经推过一次、而那一轮模型没有产生任何新的成功编辑 → 提醒没起作用，
      // 而 diagnosticBlock 只在有成功编辑时才重算，再推就是拿一个陈旧值反复烧钱。
      //
      // **这里不再 continue。** 原来判完「再推也没用、把预算还回去」之后照样 continue，
      // 于是白烧一次付费轮：模型收到的还是上一轮那条一模一样的提醒，它只能把答案换个
      // 说法重写，然后 quietTurns 撞到 2 才收尾。判定不开火，就该收尾。
      const stale = (f.diagnosticNudges || 0) >= 1 && !(f.lastSuccessfulEdits > 0);
      if (stale) { labels.push("new_diagnostics_unresolved"); return nope(); }
      counters.diagnosticNudges = (f.diagnosticNudges || 0) + 1;
      counters.quietResumePool = pool - 1;
      return { action: "continue", gate: "diagnostics", counters, labels };
    }
    labels.push("new_diagnostics_unresolved");
  }

  // ② 红构建：模型**自己声明为验证**的命令退出码非零。观测到失败，是「已完成」为假的直接证据。
  if (f.buildFail) {
    if (canResume && (f.buildFixAttempts || 0) < 2) {
      counters.buildFixAttempts = (f.buildFixAttempts || 0) + 1;
      counters.quietResumePool = pool - 1;
      return { action: "continue", gate: "build", counters, labels };
    }
    // 账不在这里记：红了之后又修好、重跑绿了的话，中途记的账会粘到收尾变成假 partial。
    // 收尾处按终态重判（_freshBuildFailure 自带版本钉）。
  }

  // ③ 计划没做完。这个退出点正是「模型写完第 2 步、说两句话、停下来」的那一轮，
  // 而上面三条门没有一条读计划。有界（2 次，和另外两道门对齐——全局池只有 3）。
  const pending = Number(f.pendingPlanSteps) || 0;
  if (pending > 0 && f.planActionable) {
    if (canResume && (f.planFinishNudges || 0) < 2) {
      counters.planFinishNudges = (f.planFinishNudges || 0) + 1;
      counters.quietResumePool = pool - 1;
      return { action: "continue", gate: "plan", counters, labels };
    }
    labels.push(`plan_steps_pending:${pending}`);
  }

  return nope();
}
