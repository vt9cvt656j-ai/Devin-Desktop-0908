// 单步 browser click / type 走哪条路，纯判断。
//
// 两条路：
//   · CDP 路：页内脚本只**定位**（locate → data-mfind），Rust 的 browser_click / browser_type 按
//     '[data-mfind]' 发 trusted 事件 + 真实轨迹（browser.rs 里那条"人类化 CDP 优先"的路径）。
//   · JS 路：整段页内脚本合成事件（isTrusted=false），支持修饰键/多击/偏移/期望校验/追加输入。
// 2026-09-05 之前单步 click/type 全走 JS 路，人类化那套只有批处理在用（第 65110 行那条）。
// 判据：请求里只要带着 JS 路才会处理的东西（修饰键、多击、坐标偏移、expect*、append），就留在
// JS 路；纯粹的"点这个/在这里输入这段"走 CDP 路。CDP 路失败时调用方回落 JS 路，行为不会更差。
const EXPECT_KEYS = ["expect", "expectText", "expect_text", "assertText", "assert_text", "expectSelector", "expect_selector", "assertSelector", "assert_selector", "expectUrl", "expect_url", "expectValue", "expect_value", "expectAbsent", "expect_absent"];

function has(call, key) {
  const v = call?.[key];
  return v !== undefined && v !== null && v !== "" && v !== false;
}

/** 单步 click 能否走 CDP 路。 */
export function clickPrefersCdp(call) {
  if (!call || typeof call !== "object") return false;
  if (has(call, "modifiers")) return false;
  const count = Number(call.clickCount ?? call.click_count ?? 1);
  if (Number.isFinite(count) && count > 1) return false;
  if (String(call.button || "").toLowerCase() && String(call.button).toLowerCase() !== "left") return false;
  if (has(call, "x") || has(call, "y")) return false;
  if (EXPECT_KEYS.some((k) => has(call, k))) return false;
  return true;
}

/** 单步 type 能否走 CDP 路：Rust 那条总是先清空再输，所以 append 留给 JS 路；期望校验同理。 */
export function typePrefersCdp(call) {
  if (!call || typeof call !== "object") return false;
  if (has(call, "append")) return false;
  if (EXPECT_KEYS.some((k) => has(call, k))) return false;
  return typeof call.text === "string";
}

/** 页内定位这一步的参数：和 click/type 同一套目标解析（selector/node/text/role）。 */
export function locateStep(call, selector, kind) {
  return {
    op: "locate", kind, selector: String(selector || ""),
    target: call?.target || (kind === "click" ? call?.text : "") || "",
    role: call?.role || (kind === "type" ? "textbox" : ""),
    text: kind === "click" ? (call?.text || "") : "",
  };
}

/**
 * Rust 那条路失败了要不要回落 JS 路。元素"找到了但当前不可点"（disabled / covered / not_visible）
 * 是页面状态，不是路径问题，回落只会在遮罩上点一下然后报成功——那正是要避免的，直接把原因交回模型。
 */
export function cdpFailureFallsBackToJs(message) {
  const m = String(message || "");
  return !/disabled|covered|not_visible|不可点|被遮|遮罩|pointer_events_none/i.test(m);
}

/**
 * 单步 click / type 的执行。先按上面的判据决定走不走 CDP 路：走的话页内脚本只定位
 * （locate → data-mfind），再让 Rust 的 browser_click / browser_type 发 trusted 事件；
 * Rust 那条抛错就按 cdpFailureFallsBackToJs 决定回落 JS 路。
 * 返回 { state, parsed, via }，parsed 和 JS 路同形（ok / log / failed），调用方原有的失败分支不用改。
 */
export async function runClickOrTypeStep({ kind, call, selector, smartStep, invoke, fastJs }) {
  const parse = (st) => { try { return JSON.parse(String(st?.result || "{}")); } catch { return null; } };
  const js = async () => {
    const st = await invoke("browser_eval", { script: fastJs([smartStep]) });
    return { state: st, parsed: parse(st), via: "js" };
  };
  const prefers = kind === "click" ? clickPrefersCdp(call) : typePrefersCdp(call);
  if (!prefers) return js();
  const loc = await invoke("browser_eval", { script: fastJs([locateStep(call, selector, kind)]) });
  const lp = parse(loc);
  if (!lp) return js();
  if (lp.ok === false) return { state: loc, parsed: lp, via: "locate" };
  try {
    const st = kind === "click"
      ? await invoke("browser_click", { selector: "[data-mfind]" })
      : await invoke("browser_type", { selector: "[data-mfind]", text: String(call?.text ?? "") });
    const log = (lp.log || []).map((l) => `${l} → ${kind === "click" ? "CDP trusted click" : "CDP trusted typing"} ✓`);
    const parsed = { ok: true, log, via: "cdp" };
    if (st && typeof st === "object") st.result = JSON.stringify(parsed);
    return { state: st, parsed, via: "cdp" };
  } catch (e) {
    if (!cdpFailureFallsBackToJs(e?.message || e)) throw e;
    return js();
  }
}
