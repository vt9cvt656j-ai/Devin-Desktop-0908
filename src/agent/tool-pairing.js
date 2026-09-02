/**
 * 发给模型之前，把 tool_call ↔ tool_result 的配对补齐。
 *
 * **为什么必须在出线口做一次，而不是在每条退出路径上各补一次。**
 *
 * 每一个 `tool_calls[i].id` 都必须有一条 `{role:"tool", tool_call_id: id}` 与之对应：
 * 它既是协议单元（严格网关会判整份转录不合法、直接 400），也是模型判断「我到底做没做」
 * 的**唯一依据**。缺一条的后果不是少一段文字——模型看到自己调了工具、却没有任何结果
 * 反驳它，于是默认成功，写下「已改好」，而那次调用根本没跑。这是「任务没执行、
 * 智能体说执行完毕」最隐蔽的一条机器成因：连一条错误都没有。
 *
 * 循环内部已经在批次收尾时补过一次（那条 `[未执行]` 的回填）。但空洞不止那一个来源：
 * 用户在工具执行途中按停、turn 抛异常、崩溃恢复后从落库的转录重建、后台标签页被顶掉。
 * 每发现一条就在那条路上补一次，是在跟一份没人维护得全的清单赛跑。这里是 chat / agent
 * 两条请求路径**共同的最后一道出线口**，在这儿做一次，上面所有来源一次覆盖。
 *
 * **幂等**：已经配好的原样返回同一个数组（连拷贝都不做），补过的再跑一遍不会变。
 *
 * **只加不减。** 反过来的那种空洞（有 tool 结果、却找不到对应的 assistant 调用）
 * 这里**故意不处理**：它的正常来源是历史从前面被压缩掉了，而那条结果本身是**证据**。
 * 删掉它等于为了让协议好看而丢用户的内容——这个仓库反复挨过那种投诉。要处理它，
 * 该在压缩那一侧保住成对关系，不是在出线口把内容抹掉。
 */

/** 缺席的工具结果长什么样。措辞和循环内那条 `[未执行]` 回填保持一致。 */
export const MISSING_TOOL_RESULT =
  "[未执行] 这次调用没有结果回来——它可能被中断、被顶掉，或者从未真正执行。"
  + "**不要把它当成已完成**：它没有产生任何结果，也没有证据表明它改动过任何东西。"
  + "仍然需要的话，重新发起这次调用。";

function callIdsOf(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const ids = [];
  for (const c of calls) {
    const id = c?.id;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * @param {Array} messages 出线前的消息数组
 * @param {string} [filler] 补进去的正文（测试可覆盖）
 * @returns {Array} 配对补齐后的数组；本来就齐的话返回**原数组本身**
 */
export function repairToolPairing(messages, filler = MISSING_TOOL_RESULT) {
  const list = Array.isArray(messages) ? messages : [];
  // 已经出现过的 tool_call_id。整份扫一遍而不是只看紧邻的下一条：
  // 并发批次的结果顺序和调用顺序不保证一致，插话还会在中间夹别的消息。
  const answered = new Set();
  for (const m of list) {
    if (m && m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id) {
      answered.add(m.tool_call_id);
    }
  }

  // 先只做一次判断：到底缺不缺。不缺就原样返回，绝不重建数组——
  // 这个函数在**每一次请求**的出线口上跑，无谓的拷贝会落在最热的那条路上。
  let missing = 0;
  for (const m of list) {
    if (!m || m.role !== "assistant") continue;
    for (const id of callIdsOf(m)) if (!answered.has(id)) missing++;
  }
  if (!missing) return list;

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    out.push(m);
    if (!m || m.role !== "assistant") continue;
    const ids = callIdsOf(m);
    if (!ids.length) continue;
    // 先把**真实回来过**的那些原样带过去（紧跟在这条 assistant 后面的那一串），
    // 补的排在它们之后：真实发生过的先来，是模型推理这一步时看到的顺序。
    while (i + 1 < list.length && list[i + 1] && list[i + 1].role === "tool") {
      out.push(list[++i]);
    }
    for (const id of ids) {
      if (answered.has(id)) continue;
      // 补在**发起它的那条 assistant 之后**：协议要求工具结果紧跟发起方。
      out.push({ role: "tool", tool_call_id: id, content: filler });
      answered.add(id);   // 同一个 id 在历史里出现两次时只补一条
    }
  }
  return out;
}
