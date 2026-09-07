// 崩溃 / 重启后，把「流到一半的那条回复」按**关闭前那一刻的样子**带回来。
//
// 背景：一轮回复有四条通道——正文 text / 思考 reasoning / 工具步骤 steps / 富工具卡（只活在
// DOM 里）。老做法是把前三条拼成 markdown 重画，外加一句「因软件重启被打断」横幅：工具卡塌成
// 一串文字清单、思考卡没了、正文之上还多了一句 harness 替模型说的话。用户原话：
// 「关闭前啥样，他就要啥样」。所以这里改成：流式期间定期把在途 `.msg` 克隆成静止 HTML
// 落盘（Rust 真文件，进程被杀也在），恢复时整块塞回去；「被打断」只作为状态挂在消息底下，
// 不进正文、不进模型。这个文件只放能在 Node 里用假节点验的逻辑（鸭子类型，不依赖真 DOM）。

/** 在途消息 HTML 的上限：超过就放弃快照，回退到「步骤清单 + 正文」那条老路。 */
export const LIVE_HTML_MAX_CHARS = 2_000_000;

/**
 * 把在途消息的克隆整理成「静止形态」：去掉纯瞬时 UI，把还在跑的东西定格成它们的终态。
 * 每一条都对应一种恢复后会撒谎的形状：思考卡的光标永远闪、工具卡的圈永远转、操作条永远不出场。
 * @param {object} root  `.msg` 节点（或它的克隆）；只用 querySelectorAll / classList / remove / textContent
 */
export function settleLiveClone(root, { interruptedLabel = "中断" } = {}) {
  const qsa = (sel) => Array.from(root?.querySelectorAll?.(sel) || []);
  // 纯瞬时：思考中占位、流式光标、临时建议 chips、方案执行按钮、任何自标 transient 的东西
  qsa(".thinking, .stream-cursor, .md-caret, .md-stream-tail, .next-steps, .plan-exec-btn, [data-transient]").forEach((e) => e.remove());
  // 还在流的思考卡 → 已思考（保留它当时是展开还是折叠）
  for (const card of qsa(".think-card.streaming")) {
    card.classList.remove("streaming");
    const tt = card.querySelector?.(".think-title");
    if (tt) tt.textContent = "已思考";
  }
  // 还在跑的工具卡 → 明确标成「中断」：转圈定格成状态，而不是一个永远转下去的圈
  for (const step of qsa(".agent-tool-step.is-running")) {
    step.classList.remove("is-running");
    step.classList.add("is-interrupted");
    const res = step.querySelector?.(".atc-result");
    if (res) { res.className = "atc-result atc-result--interrupted"; res.textContent = interruptedLabel; }
  }
  // 实时统计条不再实时（数字停在被打断那一刻，不再假装在走）
  for (const st of qsa(".turn-stats--live")) st.classList.remove("turn-stats--live");
  // 操作条出场：复制 / 反馈按钮是事件委托的，恢复后照样能用
  for (const acts of qsa(".msg__acts.is-pending")) acts.classList.remove("is-pending");
  return root;
}

/**
 * 在途 `.msg` 元素 → 静止 HTML。太大就放弃（返回 ""），让恢复走文字那条老路而不是把
 * 几 MB 的字符串塞进每 3 秒一次的落盘。克隆是一次性的、每 3 秒一次，不在每 token 的热路上。
 */
export function liveMessageHtml(msgEl, maxChars = LIVE_HTML_MAX_CHARS) {
  if (!msgEl || typeof msgEl.cloneNode !== "function") return "";
  let clone;
  try { clone = msgEl.cloneNode(true); } catch { return ""; }
  settleLiveClone(clone);
  const html = String(clone.outerHTML || "");
  return html.length > maxChars ? "" : html;
}

/**
 * 恢复时给塞回去的消息挂上「被打断」的**状态行**（不是正文：不进模型、不进 markdown、
 * 不参与查重）。同时再过一遍 settleLiveClone——退出路径上同步拍的那份可能没整理过。
 */
export function markRecoveredMessage(msgEl, { document: doc, label = "生成到这里被软件重启打断" } = {}) {
  if (!msgEl?.querySelector) return msgEl;
  settleLiveClone(msgEl);
  msgEl.classList?.add?.("is-interrupted");
  const main = msgEl.querySelector(".msg__main");
  if (main && !main.querySelector(".msg__interrupted") && doc?.createElement) {
    const el = doc.createElement("div");
    el.className = "msg__interrupted";
    el.setAttribute?.("role", "status");
    el.textContent = label;
    const acts = main.querySelector(".msg__acts");
    if (acts && typeof main.insertBefore === "function") main.insertBefore(el, acts);
    else main.appendChild?.(el);
  }
  return msgEl;
}

/**
 * 没有 HTML 快照、只能按文字重画时：思考要不要**默认展开**。正文为空、且确有思考时，
 * 思考是这轮唯一的实质内容，折叠起来等于把「已生成的部分」藏了。有正文时按普通历史处理。
 */
export function recoveredThinkingOpen({ hasText, hasReason }) {
  return !hasText && !!hasReason;
}
