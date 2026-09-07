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

// ── 超预算时按代价从小到大瘦身 ───────────────────────────────────────────────
//
// 原来是「太大就整份放弃」。听起来保守，实际是**专挑最该保住的那些丢**：一轮里只要有一张
// 截图（data URL 的 base64 动辄几百 KB 到几 MB）或者几个大文件预览，快照当场超限、静默变成
// 空串，恢复只好退回那份「这一轮执行过的步骤（N 步）」清单——所有者看到的就是这个。
// 而超限的重量几乎全在两处，且这两处都是**可以只丢它们**的：内嵌媒体、工具卡的展开区。

/** 被丢掉的内嵌图用它顶替：一张自带说明文字的 SVG，几百字节顶替几百 KB。 */
const SHED_MEDIA_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="56">' +
      '<rect width="600" height="56" fill="none" stroke="#9aa0a6" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<text x="300" y="33" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="13" fill="#9aa0a6">' +
      "图片太大，重启后没有保留" +
      "</text></svg>",
  );

const MEDIA_TAGS = new Set(["img", "video", "audio", "source", "image", "canvas"]);
const MEDIA_ATTRS = ["src", "href", "poster", "data-src"];
/** 这个尺寸以下的 data URL 不值得动（图标、favicon）。 */
const SMALL_DATA_URL = 4096;

/** 遍历所有元素后代。真 DOM 和测试里那个假 DOM 都走得通（不依赖通配选择器）。 */
function eachElement(root, fn) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    for (const child of Array.from(node?.children || [])) {
      fn(child);
      stack.push(child);
    }
  }
}

function tagOf(el) {
  return String(el?.tagName || el?.tag || "").toLowerCase();
}

/** 第一级：把内嵌的 base64 媒体换成占位。卡片、编号、说明文字全都还在，只有像素没了。 */
export function shedInlineMedia(root) {
  let shed = 0;
  eachElement(root, (el) => {
    if (!MEDIA_TAGS.has(tagOf(el))) return;
    for (const attr of MEDIA_ATTRS) {
      const v = el.getAttribute?.(attr);
      if (typeof v !== "string" || v.length <= SMALL_DATA_URL || !v.startsWith("data:")) continue;
      el.setAttribute?.(attr, attr === "src" ? SHED_MEDIA_SRC : "");
      el.setAttribute?.("data-shed", "media");
      shed++;
    }
  });
  return shed;
}

/** 第二级：工具卡的展开区从大到小收，收到进预算为止。卡头（做了什么、结果）一律保留。 */
export function shedLargestBlocks(root, maxChars) {
  const blocks = Array.from(root?.querySelectorAll?.(".atc-viewport") || [])
    .map((el) => ({ el, size: String(el.outerHTML || "").length }))
    .sort((a, b) => b.size - a.size);
  let shed = 0;
  for (const { el } of blocks) {
    if (String(root?.outerHTML || "").length <= maxChars) break;
    const chars = String(el.textContent || "").length;
    for (const child of Array.from(el.children || [])) child.remove?.();
    el.textContent = chars
      ? `（这里原有 ${chars} 个字符的内容，太大，重启后没有保留）`
      : "（内容太大，重启后没有保留）";
    el.setAttribute?.("data-shed", "block");
    shed++;
  }
  return shed;
}

/**
 * 在途 `.msg` 元素 → 静止 HTML。
 *
 * 超预算时**逐级瘦身**而不是整份丢：先换掉内嵌媒体，再从大到小收工具卡的展开区。
 * 两级都做完还超，说明重量在正文本身——那份走文字那条老路照样能恢复，这时才返回 ""。
 * 克隆一次性、每 3 秒一次，不在每 token 的热路上。
 */
export function liveMessageHtml(msgEl, maxChars = LIVE_HTML_MAX_CHARS) {
  if (!msgEl || typeof msgEl.cloneNode !== "function") return "";
  let clone;
  try { clone = msgEl.cloneNode(true); } catch { return ""; }
  settleLiveClone(clone);
  let html = String(clone.outerHTML || "");
  if (html.length <= maxChars) return html;
  if (shedInlineMedia(clone)) {
    html = String(clone.outerHTML || "");
    if (html.length <= maxChars) return html;
  }
  if (shedLargestBlocks(clone, maxChars)) html = String(clone.outerHTML || "");
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
