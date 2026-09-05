// 崩溃 / 重启后，把「流到一半的草稿」补成一条 assistant 消息时的两个判断，纯函数。
//
// 背景：一轮回复的三条通道（正文 text / 思考 reasoning / 工具步骤 steps）是分别流式落盘的。
// 被打断在「思考完、正文还没开写」那一刻时，草稿里 text="" 而 reasoning 有一大段。恢复时若
// 一律写「以下为已生成的部分」再接正文，正文是空的，用户就看到一句提示指着一片空白——
// 而真正生成的思考被折在上方「已思考」卡里（默认还是折叠的）。这正是用户报的
// 「被打断的内容没显示，要完整显示」。所以：提示语按实际生成了什么讲实话，并指到内容真正在哪。

/**
 * 恢复消息顶部那句提示。
 * @param {{hasText:boolean, hasReason:boolean, hasSteps:boolean}} p
 */
export function recoveredDraftNotice({ hasText, hasReason, hasSteps }) {
  if (hasText) return "⚠️ 这轮回复在生成途中因软件重启被打断，下面是已经写出的部分：";
  // 正文没写出来：说清正文为空，并把用户指到实质内容（思考 / 步骤）真正所在，别留空承诺。
  const where = hasReason
    ? (hasSteps
        ? "上方「已思考」是恢复出的思考过程，下面是这轮做过的步骤"
        : "上方「已思考」里是模型已生成的完整思考过程")
    : (hasSteps ? "下面是这轮已经做过的步骤" : "这轮没有可恢复的正文内容");
  return `⚠️ 这轮在写出正文之前就因软件重启被打断了——模型还没开始写回答。${where}。`;
}

/**
 * 恢复出的思考要不要**默认展开**：正文为空、且确有思考时，思考是这轮唯一的实质内容，
 * 折叠起来等于把「已生成的部分」藏了。有正文时按普通历史处理（保持折叠）。
 */
export function recoveredThinkingOpen({ hasText, hasReason }) {
  return !hasText && !!hasReason;
}
