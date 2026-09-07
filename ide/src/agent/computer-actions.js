// computer 工具的动作表与映射。**纯函数**：不碰 DOM、不碰 backend，测试真跑。
//
// # 为什么换成这套动作名
//
// 前沿模型（Fable 5 / Mythos 5 / Opus 5 / Sonnet 5、以及 Qwen3.8 Max）在 OSWorld 上 85% 以上的
// 成绩，用的是 Anthropic 官方 `computer_toolset_20260801` 那 17 个动作：left_click{coordinate}、
// zoom{region}、scroll{scroll_direction, scroll_amount}、key{text}、wait{duration}……**坐标一律在
// 它看到的那张截图的像素空间**。我们原来递给它的是自造的 `{method:"mouse.click",params:{x,y}}`，
// 坐标还是屏幕点，模型得先把学过的那套翻译成我们这套——每一次翻译都是一次出错机会。
//
// 这里只做两件事：① 把标准动作翻译成 sidecar 的方法名（`mouse.click` 这类，审批/只读策略认的
// 就是它们，见 tool-policy.js 的 AUTOMATION_OBSERVE_METHODS）；② 把截图像素坐标换算成屏幕点。
// 换算靠上一次 screenshot / read_screen 回执里的几何关系（`points_per_image_px` 与原点），
// 模型不做任何除法。老的 `mouse.click{x,y}` 写法照样收（坐标当作屏幕点直通），缓存里的旧
// 提示词和旧对话不会因此失效。

/** Anthropic computer_toolset_20260801 的 17 个成员，名字和参数形状逐字一致。 */
export const STANDARD_ACTIONS = Object.freeze([
  "screenshot", "zoom",
  "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position",
  "scroll", "type", "key", "hold_key", "wait",
]);

/** 标准集里没有、桌面工作离不开的扩展，命名跟标准集同一风格。 */
export const EXTENDED_ACTIONS = Object.freeze([
  "paste",
  "screen_info", "window_list", "window_activate", "window_minimize", "window_restore",
  "clipboard_get", "clipboard_set",
  "recorder_save", "recorder_replay", "recorder_list",
]);

export const COMPUTER_ACTIONS = Object.freeze([...STANDARD_ACTIONS, ...EXTENDED_ACTIONS]);

/** 一次 wait 最多多少秒。官方上限 300；这里 60——桌面等待超过一分钟多半是在等一个不会来的东西。 */
export const WAIT_MAX_SECONDS = 60;
/** key 的 repeat 上限，和官方一致。 */
export const KEY_REPEAT_MAX = 100;

/** 截图回执 → 换算关系。`null` 表示这条回执不带几何（老 sidecar / Windows 老口径）。 */
export function screenMapFrom(result, now = Date.now()) {
  if (!result || typeof result !== "object") return null;
  const px = result.image_px, o = result.points_origin;
  const k = Number(result.points_per_image_px);
  if (!px || !Number.isFinite(k) || k <= 0) return null;
  const w = Number(px.width), h = Number(px.height);
  if (!(w > 0 && h > 0)) return null;
  return {
    imageW: w, imageH: h,
    originX: Number(o?.x) || 0, originY: Number(o?.y) || 0,
    pointsPerPx: k,
    at: now,
  };
}

/** 图上像素 → 屏幕点。 */
export function toPoints(coord, map) {
  const [x, y] = coord;
  return [map.originX + x * map.pointsPerPx, map.originY + y * map.pointsPerPx];
}
/** 屏幕点 → 图上像素（回执里的落点要换回模型的空间）。 */
export function toImagePx(x, y, map) {
  const k = map.pointsPerPx || 1;
  return [(x - map.originX) / k, (y - map.originY) / k];
}

function coordOf(v) {
  if (Array.isArray(v) && v.length >= 2) {
    const x = Number(v[0]), y = Number(v[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
    return null;
  }
  if (v && typeof v === "object") {
    const x = Number(v.x), y = Number(v.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  return null;
}

/**
 * xdotool 风格的键名（官方 computer 工具用的那套）→ sidecar 认的键名。
 * 单个字符原样；未知名字小写后原样交给 sidecar，让它自己报错——别在这里静默吞掉。
 */
const KEY_ALIASES = {
  return: "enter", enter: "enter", kp_enter: "enter",
  backspace: "backspace", delete: "delete", del: "delete",
  escape: "esc", esc: "esc",
  tab: "tab", space: "space",
  up: "up", down: "down", left: "left", right: "right",
  home: "home", end: "end",
  page_up: "pageup", pageup: "pageup", prior: "pageup",
  page_down: "pagedown", pagedown: "pagedown", next: "pagedown",
  super: "cmd", meta: "cmd", cmd: "cmd", command: "cmd", win: "win",
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift",
};
export function normalizeKey(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (s.length === 1) return s;
  const low = s.toLowerCase();
  if (KEY_ALIASES[low]) return KEY_ALIASES[low];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return low;
  return low;
}
/** "ctrl+shift+s" → ["ctrl","shift","s"]；单键 → ["enter"]。 */
export function splitCombo(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s === "+") return ["+"];
  return s.split("+").map(normalizeKey).filter(Boolean);
}

/**
 * 标准动作 → sidecar 调用。
 *
 * 返回 `{ method, params, coordSpace, local }`：
 *   · coordSpace = "image" 表示 params 里的坐标还是图上像素，执行前要用 screenMap 换算
 *     （见 applyScreenMap）；"points" 表示已经是屏幕点，直通。
 *   · local = { wait: seconds } 表示不用打 sidecar，执行器自己睡（wait 不该走审批门）。
 * 返回 `{ error }` 表示参数不合法，文案直接给模型。
 */
export function mapComputerAction(args) {
  const a = args && typeof args === "object" ? args : {};
  const action = String(a.action || a.method || "").trim();
  if (!action) return { error: `computer 需要 action。可用的是：${COMPUTER_ACTIONS.join(" / ")}` };

  // 老写法：sidecar 方法名直通，坐标当屏幕点。
  if (action.includes(".")) {
    const p = a.params && typeof a.params === "object" && !Array.isArray(a.params) ? a.params : {};
    return { method: action, params: p, coordSpace: "points", legacy: true };
  }
  if (!COMPUTER_ACTIONS.includes(action)) {
    return { error: `computer 不认识动作「${action}」。可用的是：${COMPUTER_ACTIONS.join(" / ")}` };
  }
  const mods = a.text != null && /^(?:[a-z_]+)(?:\+[a-z_]+)*$/i.test(String(a.text)) && !["type", "key", "hold_key"].includes(action)
    ? splitCombo(a.text)
    : [];
  const coord = coordOf(a.coordinate);
  const clickParams = (button) => {
    const p = { button };
    if (coord) { p.x = coord[0]; p.y = coord[1]; }
    if (mods.length) p.keys = mods;
    return p;
  };

  switch (action) {
    case "screenshot":
      return { method: "screen.capture", params: { max_side: sideOf(a) }, coordSpace: "points", setsMap: true };
    case "zoom": {
      const r = Array.isArray(a.region) ? a.region.map(Number) : null;
      if (!r || r.length !== 4 || r.some((n) => !Number.isFinite(n))) {
        return { error: "zoom 需要 region:[x0,y0,x1,y1]（截图上的像素坐标，左上到右下）" };
      }
      const [x0, y0, x1, y1] = r;
      if (x1 <= x0 || y1 <= y0) return { error: "zoom 的 region 要 x1>x0 且 y1>y0" };
      return {
        method: "screen.capture",
        params: { region_px: [x0, y0, x1, y1], max_side: sideOf(a) },
        coordSpace: "image",
        isZoom: true,
      };
    }
    case "left_click": return { method: "mouse.click", params: clickParams("left"), coordSpace: "image" };
    case "right_click": return { method: "mouse.click", params: clickParams("right"), coordSpace: "image" };
    case "middle_click": return { method: "mouse.click", params: clickParams("middle"), coordSpace: "image" };
    case "double_click": return { method: "mouse.double_click", params: clickParams("left"), coordSpace: "image" };
    case "triple_click": return { method: "mouse.triple_click", params: clickParams("left"), coordSpace: "image" };
    case "left_click_drag": {
      const from = coordOf(a.start_coordinate), to = coord;
      if (!from || !to) return { error: "left_click_drag 需要 start_coordinate:[x,y] 和 coordinate:[x,y]（截图像素）" };
      const p = { from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] };
      if (mods.length) p.keys = mods;
      return { method: "mouse.drag", params: p, coordSpace: "image" };
    }
    case "mouse_move": {
      if (!coord) return { error: "mouse_move 需要 coordinate:[x,y]（截图像素）" };
      return { method: "mouse.move", params: { x: coord[0], y: coord[1] }, coordSpace: "image" };
    }
    case "left_mouse_down": return { method: "mouse.down", params: coord ? { x: coord[0], y: coord[1], button: "left" } : { button: "left" }, coordSpace: "image" };
    case "left_mouse_up": return { method: "mouse.up", params: coord ? { x: coord[0], y: coord[1], button: "left" } : { button: "left" }, coordSpace: "image" };
    case "cursor_position": return { method: "mouse.position", params: {}, coordSpace: "points", reportsPoint: true };
    case "scroll": {
      const dir = String(a.scroll_direction || "down").toLowerCase();
      const amt = Math.max(1, Math.min(50, Math.round(Number(a.scroll_amount) || 3)));
      const p = {};
      if (coord) { p.x = coord[0]; p.y = coord[1]; }
      if (dir === "up") p.delta_y = -amt;
      else if (dir === "down") p.delta_y = amt;
      else if (dir === "left") { p.delta_y = 0; p.delta_x = -amt; }
      else if (dir === "right") { p.delta_y = 0; p.delta_x = amt; }
      else return { error: "scroll_direction 只能是 up / down / left / right" };
      if (mods.length) p.keys = mods;
      return { method: "mouse.scroll", params: p, coordSpace: "image" };
    }
    case "type": {
      if (a.text == null || a.text === "") return { error: "type 需要 text" };
      return { method: "keyboard.type", params: { text: String(a.text) }, coordSpace: "points" };
    }
    case "key": {
      const keys = splitCombo(a.text);
      if (!keys.length) return { error: 'key 需要 text，例如 "Return"、"ctrl+s"、"cmd+shift+p"' };
      const repeat = Math.max(1, Math.min(KEY_REPEAT_MAX, Math.round(Number(a.repeat) || 1)));
      const call = keys.length === 1
        ? { method: "keyboard.press", params: { key: keys[0] }, coordSpace: "points" }
        : { method: "keyboard.combo", params: { keys }, coordSpace: "points" };
      if (repeat > 1) call.repeat = repeat;
      return call;
    }
    case "hold_key": {
      const keys = splitCombo(a.text);
      if (keys.length !== 1) return { error: "hold_key 需要 text（单个键）和 duration（秒）" };
      const ms = Math.max(50, Math.min(10_000, Math.round((Number(a.duration) || 0.5) * 1000)));
      return { method: "keyboard.hold", params: { key: keys[0], ms }, coordSpace: "points" };
    }
    case "wait": {
      const sec = Math.max(0, Math.min(WAIT_MAX_SECONDS, Number(a.duration) || 1));
      return { local: { wait: sec }, method: "wait", params: {}, coordSpace: "points" };
    }
    case "paste": {
      if (a.text == null) return { error: "paste 需要 text" };
      return { method: "keyboard.paste", params: { text: String(a.text) }, coordSpace: "points" };
    }
    case "screen_info": return { method: "screen.info", params: {}, coordSpace: "points" };
    case "window_list": return { method: "window.list", params: {}, coordSpace: "points" };
    case "window_activate": case "window_minimize": case "window_restore": {
      const title = String(a.title || a.text || "").trim();
      if (!title) return { error: `${action} 需要 title（window_list 里的窗口标题）` };
      return { method: `window.${action.slice("window_".length)}`, params: { title }, coordSpace: "points" };
    }
    case "clipboard_get": return { method: "clipboard.get", params: {}, coordSpace: "points" };
    case "clipboard_set": {
      if (a.text == null) return { error: "clipboard_set 需要 text" };
      return { method: "clipboard.set", params: { text: String(a.text) }, coordSpace: "points" };
    }
    case "recorder_list": return { method: "recorder.list", params: {}, coordSpace: "points" };
    case "recorder_save": case "recorder_replay": {
      const name = String(a.name || a.text || "").trim();
      if (!name) return { error: `${action} 需要 name` };
      return { method: `recorder.${action.slice("recorder_".length)}`, params: { name }, coordSpace: "points" };
    }
    default:
      return { error: `computer 不认识动作「${action}」` };
  }
}

function sideOf(a) {
  const n = Number(a.max_side);
  return Number.isFinite(n) && n >= 0 ? Math.min(4096, Math.round(n)) : undefined;
}

/**
 * 把 coordSpace = "image" 的调用换算成屏幕点。没有 map 就报错，**不猜**：
 * 模型没看过截图却给了坐标，这个坐标在任何空间里都没有意义，直接点等于瞎点。
 */
export function applyScreenMap(mapped, map) {
  if (!mapped || mapped.error) return mapped;
  if (mapped.coordSpace !== "image") return mapped;
  const p = { ...(mapped.params || {}) };
  const hasCoord = ["x", "from_x", "region_px"].some((k) => p[k] != null);
  if (!hasCoord) return { ...mapped, params: p, coordSpace: "points" };
  if (!map) {
    return { error: "这次调用带了截图坐标，但这一轮还没有截图可以对照——先 computer{action:\"screenshot\"}（或 read_screen）拿到图，再按图上像素给坐标。" };
  }
  if (p.region_px) {
    const [x0, y0, x1, y1] = p.region_px;
    const [px0, py0] = toPoints([x0, y0], map);
    const [px1, py1] = toPoints([x1, y1], map);
    delete p.region_px;
    p.x = Math.round(px0); p.y = Math.round(py0);
    p.width = Math.max(1, Math.round(px1 - px0)); p.height = Math.max(1, Math.round(py1 - py0));
    // 区域已经是屏幕点了，**到此为止**——再进下面那个循环会把它当像素再换算一次
    // （测试抓到过：135 点被再乘 1.35 变成 182）。
    return { ...mapped, params: p, coordSpace: "points" };
  }
  for (const [kx, ky] of [["x", "y"], ["from_x", "from_y"], ["to_x", "to_y"]]) {
    if (p[kx] != null && p[ky] != null) {
      const [sx, sy] = toPoints([Number(p[kx]), Number(p[ky])], map);
      p[kx] = Math.round(sx); p[ky] = Math.round(sy);
    }
  }
  return { ...mapped, params: p, coordSpace: "points" };
}

/**
 * 给模型的一句几何说明：图多大、坐标怎么给；read_screen 的标注图再加「编号 = ref」和被盖住的
 * 数量；没出图时说清原因。Rust 侧只回结构化事实（rpc.rs screen.marked 的 occluded），话在这里拼。
 */
export function describeScreenImage(meta, { marked = false } = {}) {
  const m = meta && typeof meta === "object" ? meta : null;
  if (!m) return "";
  if (m.screen_locked === true) {
    return "屏幕现在锁着：截图是全黑的，窗口也都不在屏幕上。元素和 ref 来自可访问性树，仍然有效，但坐标点击落不到东西上。先让用户解锁，再 screenshot / read_screen。";
  }
  if (m.occluded && typeof m.occluded === "object") {
    const o = m.occluded;
    const front = o.front_app ? `「${o.front_app}」` : (o.front_pid ? `pid ${o.front_pid}` : "别的应用");
    return `这次没有截图：目标（pid ${o.target_pid}）在屏幕上没有窗口（最小化了，或在别的桌面），前台是${front}。`
      + "元素和 ref 照常可用（ui_click 不要求窗口可见）；要看图，先 computer{action:\"window_activate\", title:\"…\"} 把它提到前台再读。";
  }
  const px = m.image_px;
  if (!px || !(Number(px.width) > 0 && Number(px.height) > 0)) return "";
  let s = `图 ${px.width}×${px.height} 像素；给 computer 的坐标一律按这张图的像素（左上角为原点），壳会换算成屏幕点。`;
  if (marked) {
    const n = Number(m.marks) || 0, hidden = Number(m.marks_hidden) || 0;
    s += `红框里的编号 = 上面元素的 ref，只标了截图上真看得见的可交互控件（${n} 个${hidden ? `，另有 ${hidden} 个被别的窗口盖住没标` : ""}）。`;
  }
  return s;
}

/** 回执里的屏幕点落点换回图上像素，好让模型对得上它自己的坐标。 */
export function annotateReceipt(result, map) {
  if (!map || !result || typeof result !== "object") return result;
  const x = Number(result.x), y = Number(result.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return result;
  const [ix, iy] = toImagePx(x, y, map);
  return { ...result, image_px: [Math.round(ix), Math.round(iy)] };
}
