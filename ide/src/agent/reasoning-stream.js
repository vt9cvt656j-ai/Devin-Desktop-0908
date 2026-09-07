// 推理流解析：把内容流里内联的 <think>…</think> 拆成「思考」和「正文」两股。
//
// 只处理**流式分片**这一件事：跨 delta 被切开的标签、答案开始之后姗姗来迟的 <think>
// （那是供应商的包装噪音，不是第二段思考）、以及重试层要数的「这一片有没有真进度」。
// 状态对象由调用方持有（每次模型请求一个），重试时可以整个换掉，不碰已经渲染出去的思考。
// 纯函数、零依赖；从 main.js 原样搬出，一行逻辑没改。

// Some OpenAI-compatible relays put reasoning in the ordinary content stream as
// <think>...</think> (or <thinking>...</thinking>) instead of reasoning_content.
// Keep a tiny cross-delta parser so split tags never leak into the answer or leave
// the thinking card empty. The state object is deliberately caller-owned: retries
// can reset it without touching the visible reasoning accumulated by another turn.
export function _routeInlineThinkingDelta(state, delta) {
  const s0 = String(state?.hold || "") + String(delta || "");
  const stateRef = state || {};
  // A model turn has one-way phases: reasoning -> visible answer/tool call. Once
  // visible output starts, a late <think> block is provider framing noise, not a
  // second phase that belongs below the answer. Keeping this bit on the parser
  // state also handles an opening tag split across two deltas.
  if (typeof stateRef.answerStarted !== "boolean") stateRef.answerStarted = false;
  stateRef.hold = "";
  let s = s0;
  let reasoning = "";
  let answer = "";
  let acceptedControl = false;
  const appendAnswer = (value) => {
    if (!value) return;
    answer += value;
    if (/\S/.test(value)) stateRef.answerStarted = true;
  };
  const appendReasoning = (value) => {
    if (value && !stateRef.answerStarted) reasoning += value;
  };
  const opening = /<think(?:ing)?>/i;
  const closing = /<\/think(?:ing)?>/i;
  const partialLength = (value, tags) => {
    for (let length = Math.min(value.length, 12); length > 0; length--) {
      const suffix = value.slice(-length).toLowerCase();
      if (tags.some((tag) => tag.startsWith(suffix) && suffix.length < tag.length)) return length;
    }
    return 0;
  };
  while (s) {
    if (!stateRef.inThink) {
      const match = s.match(opening);
      if (!match) {
        const hold = partialLength(s, ["<think>", "<thinking>"]);
        if (hold) {
          appendAnswer(s.slice(0, -hold));
          stateRef.hold = s.slice(-hold);
          if (!stateRef.answerStarted) acceptedControl = true;
        }
        else appendAnswer(s);
        break;
      }
      appendAnswer(s.slice(0, match.index));
      if (!stateRef.answerStarted) acceptedControl = true;
      s = s.slice(match.index + match[0].length);
      stateRef.inThink = true;
    } else {
      const match = s.match(closing);
      if (!match) {
        const hold = partialLength(s, ["</think>", "</thinking>"]);
        appendReasoning(hold ? s.slice(0, -hold) : s);
        if (hold) {
          stateRef.hold = s.slice(-hold);
          if (!stateRef.answerStarted) acceptedControl = true;
        }
        break;
      }
      appendReasoning(s.slice(0, match.index));
      if (!stateRef.answerStarted) acceptedControl = true;
      s = s.slice(match.index + match[0].length);
      stateRef.inThink = false;
    }
  }
  return {
    reasoning,
    answer,
    // The retry layer must count only data accepted by this one-way turn phase.
    // A split control tag before the answer counts as accepted transport progress;
    // whitespace and late <think> blocks after visible prose do not.
    accepted: acceptedControl || /\S/.test(reasoning) || /\S/.test(answer),
  };
}

export function _flushInlineThinkingDelta(state) {
  if (!state || !state.hold) return { reasoning: "", answer: "" };
  const hold = state.hold;
  state.hold = "";
  // A partial closing tag is control syntax, not model prose. Inside a think block the
  // parser only ever holds a prefix of "</think>" / "</thinking>" (see partialLength in
  // _routeInlineThinkingDelta), so everything held there is control syntax — including the
  // short prefixes ("<", "</t", "</thi") that the old /^<\/?think/ test let through as
  // literal reasoning text when the stream ended mid-tag.
  // A partial opening tag is preserved as answer text because the model may simply have typed '<'.
  if (state.inThink) return { reasoning: "", answer: "" };
  if (/\S/.test(hold)) state.answerStarted = true;
  return { reasoning: "", answer: hold };
}

export function _canRenderPreAnswerReasoning(state) {
  return !state || state.answerStarted !== true;
}
