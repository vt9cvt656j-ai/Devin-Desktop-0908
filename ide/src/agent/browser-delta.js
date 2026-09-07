// 浏览器动作之后给模型的回执——纯函数，不碰 DOM、不发请求。
//
// 原来每一步回给模型的是：一张截图、最多 60 个视口内元素（`[ref] <tag type> text`）、1500 字
// 正文、一句固定的「优先用 index」。缺的是**这一步改变了什么**：URL 有没有变、标题有没有变、
// 节点清单有没有变、焦点落在哪、有没有弹对话框、有没有开新标签页、视口在页面的什么位置、
// 下面还有多少没看到。模型看不到这些就只能凭截图猜「刚才那下有没有生效」，猜错就原样重发。
//
// 这里把 Rust 快照里的结构化事实（scroll / focus / text_total / tab_count / dialog / opened_tab /
// overlay_dismissed / elements 的 role+state+off）拼成给模型看的话。措辞只在这一处。

export const FEEDBACK_LIMITS = { inView: 80, offView: 40, textChars: 1500, sigNodes: 60 };

const ACTING = new Set(["click", "dblclick", "rightclick", "longpress", "type", "clear", "append", "autofill", "fill", "hover", "drag", "slide", "swipe", "wheel", "toggle", "uncheck", "select", "focus", "blur", "press", "scroll", "batch", "upload", "back", "forward", "reload"]);
const OBSERVING = new Set(["read", "find", "nodes", "observe", "tab", "design", "network", "inspect", "assert", "check", "cookies", "storage", "task", "screenshot"]);

/** 节点清单的指纹：前几十个节点的 编号:角色:名称。用来判「这一步之后清单变了没有」。 */
export function elementsSignature(elements, limit = FEEDBACK_LIMITS.sigNodes) {
  return (Array.isArray(elements) ? elements : []).slice(0, limit).map((e) => `${e.ref}:${e.role || e.tag || ""}:${e.text || ""}`).join("|");
}

/** 下一步比较用的最小快照。 */
export function feedbackSnapshot(state) {
  const els = Array.isArray(state?.elements) ? state.elements : [];
  return {
    url: String(state?.url || ""),
    title: String(state?.title || ""),
    count: els.length,
    sig: elementsSignature(els),
    scrollY: Number(state?.scroll?.y) || 0,
    focus: String(state?.focus || ""),
  };
}

/** 状态串（Rust 给的 "disabled,checked,value=abc"）→ 展示：` {disabled,checked} = abc`。 */
function stateText(state) {
  const parts = String(state || "").split(",").filter(Boolean);
  const flags = parts.filter((p) => !p.startsWith("value="));
  const value = parts.find((p) => p.startsWith("value="));
  return (flags.length ? ` {${flags.join(",")}}` : "") + (value ? ` = ${value.slice(6)}` : "");
}

/** 可交互节点清单：视口内的排前面，视口外的标 off，各有上限，超出的说数量。 */
export function renderElements(elements, limits = FEEDBACK_LIMITS) {
  const els = Array.isArray(elements) ? elements : [];
  if (!els.length) return "";
  const line = (e) => `[${e.ref}] ${e.role || e.tag || "?"}${e.text ? ` "${String(e.text).slice(0, 60)}"` : ""}${stateText(e.state)}${e.off ? " off" : ""}`;
  const on = els.filter((e) => !e.off), off = els.filter((e) => e.off);
  const shownOn = on.slice(0, limits.inView), shownOff = off.slice(0, limits.offView);
  const rest = (on.length - shownOn.length) + (off.length - shownOff.length);
  return `可交互节点（[n] 角色 "名称" 状态；n 就是截图上的红数字，click/type 用 node=n；off=在视口外，直接操作会先滚过去）：\n`
    + [...shownOn, ...shownOff].map(line).join("\n")
    + (rest > 0 ? `\n…还有 ${rest} 个没列，用 nodes 看全部` : "");
}

/** 视口在页面的什么位置、下面还有多少、正文一共多少字。 */
export function scrollLine(state) {
  const s = state?.scroll;
  const total = Number(state?.text_total) || 0;
  const parts = [];
  if (s && Number(s.height) > 0 && Number(s.viewport) > 0) {
    const y = Math.max(0, Number(s.y) || 0), h = Number(s.height), v = Number(s.viewport);
    const screens = h / v;
    const below = Math.max(0, (h - y - v) / v);
    if (screens <= 1.05) parts.push("视口：整页一屏放得下");
    else parts.push(`视口：页面约 ${screens.toFixed(1)} 屏高，现在在 ${Math.min(100, Math.round(((y + v) / h) * 100))}% 处${below >= 0.2 ? `，下面还有约 ${below.toFixed(1)} 屏没看到` : "，已到底"}`);
  }
  if (total > 0) parts.push(`正文共 ${total} 字`);
  return parts.join("；");
}

/** 这一步和上一步之间的变化。第一步（没有上一步）不说。 */
export function browserDelta(prev, state, act) {
  const out = [];
  if (state?.dialog && typeof state.dialog === "object") {
    out.push(`页面弹了 ${state.dialog.kind || "对话框"}「${String(state.dialog.message || "").slice(0, 160)}」，已自动按确定，不会挂住后面的动作`);
  }
  if (state?.opened_tab && typeof state.opened_tab === "object") {
    out.push(`这一步打开了新标签页 [${state.opened_tab.index}] ${String(state.opened_tab.title || "").slice(0, 60) || "(无标题)"} — ${String(state.opened_tab.url || "").slice(0, 120)}；已切过去，后面的动作作用于它，要回去用 tab op:"switch"`);
  }
  if (state?.overlay_dismissed) {
    out.push(`目标被弹层盖住，已自动点「${String(state.overlay_dismissed).slice(0, 40)}」关掉后再操作`);
  }
  if (!prev || typeof prev !== "object") return out;
  const now = feedbackSnapshot(state);
  const changes = [];
  if (prev.url !== now.url) changes.push(`URL：${prev.url || "(空)"} → ${now.url}`);
  if (prev.title !== now.title) changes.push(`标题：「${prev.title}」→「${now.title}」`);
  if (prev.sig !== now.sig) changes.push(`可交互节点 ${prev.count} → ${now.count} 个${prev.count === now.count ? "（清单内容变了）" : ""}`);
  if (Math.abs(prev.scrollY - now.scrollY) > 4) changes.push(`滚动位置 ${prev.scrollY} → ${now.scrollY}`);
  if (now.focus && now.focus !== prev.focus) changes.push(`焦点在 ${now.focus}`);
  if (changes.length) out.push(`变化：${changes.join("；")}`);
  else if (ACTING.has(String(act || ""))) out.push("页面没有变化：URL、标题、节点清单、滚动位置都和上一步一样——这一步没生效，或目标本来就不改变页面。别原样重发；先 read/find 看清楚，换目标或换做法。");
  return out;
}

/** 动作后的一句提示：只在需要时说，读 / 找类动作各有自己的一句。 */
export function nextStepHint(act, extra = {}) {
  const a = String(act || "");
  if (a === "read") return extra.next != null ? `（还没读完：接着 read offset=${extra.next}；要点正文里的链接/按钮，用它旁边的 [n] 作 node）` : "（已读到末尾；要点正文里的链接/按钮，用它旁边的 [n] 作 node）";
  if (a === "find") return extra.count ? "（第一处命中已滚进视口；node 就是它旁边可以操作的节点号）" : "（没找到：换个词、用 pattern 正则，或先 read 看页面到底写了什么）";
  if (a === "nodes" || a === "observe") return "";
  if (a === "task" || a === "tab") return "";
  if (a === "batch") return "（继续 batch，或用 assert/check/find 核对结果；不要每一步 screenshot）";
  if (a === "autofill" || a === "fill") return "（先看 filled/missing/invalid：缺字段补上再 submit，别只看截图猜）";
  return "（读内容用 read，找位置用 find；操作按 node=n；连着几步用 batch，不知道要几步用 task；改完用 assert/check 核对，不要每一步 screenshot）";
}

/**
 * 一步之后的整段回执。
 * @returns {{ text: string, snapshot: object }} text 接在正文后面；snapshot 存起来给下一步比较。
 */
export function renderBrowserFeedback({ act, state, prev, limits = FEEDBACK_LIMITS, extra = {} }) {
  const a = String(act || "");
  const parts = [];
  for (const line of browserDelta(prev, state, a)) parts.push(line);
  const sl = scrollLine(state);
  if (sl) parts.push(sl);
  const showElements = !OBSERVING.has(a) || a === "screenshot";
  if (showElements) {
    const el = renderElements(state?.elements, limits);
    if (el) parts.push(el);
  }
  const text = String(state?.text || "");
  if (text && a !== "read" && a !== "nodes" && a !== "observe") {
    const total = Number(state?.text_total) || 0;
    parts.push(`页面可见文本${total > limits.textChars ? `（前 ${limits.textChars} 字，全文 ${total} 字用 read 分页看）` : ""}:\n${text.slice(0, limits.textChars)}`);
  }
  const hint = nextStepHint(a, extra);
  if (hint) parts.push(hint);
  return { text: parts.length ? `\n${parts.join("\n")}` : "", snapshot: feedbackSnapshot(state) };
}

/** read 的回执：结构化 JSON → 给模型看的文本。 */
export function renderReadResult(raw) {
  let r = raw;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { return { text: String(raw || ""), next: null }; } }
  if (!r || typeof r !== "object") return { text: "", next: null };
  if (r.error === "selector_not_found") return { text: `[失败] read 的 selector「${r.selector}」没有匹配到元素；不传 selector 会自动选正文容器。`, next: null };
  if (r.error) return { text: `[失败] read：${r.error}`, next: null };
  const head = `**页面内容**（${r.root || "body"}，第 ${r.offset || 0}–${(r.offset || 0) + (r.chars || 0)} 字，共 ${r.total || 0} 字${r.next != null ? "，还有后面" : "，已到末尾"}；正文里 [n] 是可操作节点号，链接后面的 [n] 可以直接 click）`;
  const outline = Array.isArray(r.outline) && r.outline.length ? `大纲：${r.outline.map((h) => `${"#".repeat(Math.max(1, Math.min(6, Number(h.l) || 1)))} ${h.t}`).join(" · ")}` : "";
  const frames = Number(r.crossOriginFrames) > 0 ? `（有 ${r.crossOriginFrames} 个跨域 iframe，里面的内容读不到）` : "";
  return { text: [head, outline, frames, String(r.text || "")].filter(Boolean).join("\n"), next: r.next == null ? null : r.next };
}

/** find 的回执。 */
export function renderFindResult(raw) {
  let r = raw;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { return { text: String(raw || ""), count: 0 }; } }
  if (!r || typeof r !== "object") return { text: "", count: 0 };
  if (r.error === "bad_pattern") return { text: `[失败] find 的 pattern 不是合法正则：${r.detail || ""}`, count: 0 };
  if (r.error === "empty_query") return { text: "[失败] find 需要 text（子串）或 pattern（正则）或 role（角色）之一。", count: 0 };
  if (r.error) return { text: `[失败] find：${r.error}`, count: 0 };
  const nodes = Array.isArray(r.nodeMatches) ? r.nodeMatches : [];
  const texts = Array.isArray(r.textMatches) ? r.textMatches : [];
  const lines = [`**查找「${r.query}」**：节点 ${nodes.length} 处，正文 ${texts.length} 处${r.scrolled ? "（第一处已滚进视口）" : ""}`];
  if (nodes.length) lines.push("节点命中：\n" + nodes.map((n) => `[${n.i}] ${n.r}${n.n ? ` "${n.n}"` : ""}${n.s && n.s.value ? ` = ${n.s.value}` : ""}${n.off ? " off" : ""}`).join("\n"));
  if (texts.length) lines.push("正文命中（…上下文…；node=旁边可操作的节点）：\n" + texts.map((t, i) => `${i + 1}. …${String(t.ctx || "").slice(0, 200)}…${t.node != null ? ` → node=${t.node}` : ""}${t.inView ? "" : " (视口外)"}`).join("\n"));
  if (!nodes.length && !texts.length) lines.push("没有命中。");
  return { text: lines.join("\n"), count: nodes.length + texts.length };
}
