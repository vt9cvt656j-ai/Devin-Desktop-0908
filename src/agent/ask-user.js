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
