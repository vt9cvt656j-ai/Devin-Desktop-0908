// computer 工具的动作映射与坐标换算。纯函数，真跑。
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_ACTIONS, STANDARD_ACTIONS, mapComputerAction, applyScreenMap, screenMapFrom,
  toPoints, toImagePx, normalizeKey, splitCombo, annotateReceipt, describeScreenImage, WAIT_MAX_SECONDS,
} from "../src/agent/computer-actions.js";

// Retina 1728×1117 点的屏，sidecar 缩到 1280×827，一个像素 = 1.35 点
const MAP = screenMapFrom({
  image_px: { width: 1280, height: 827 },
  points_origin: { x: 0, y: 0 },
  points_per_image_px: 1.35,
});

test("官方 17 个动作一个不少，且顺序稳定（schema enum 照它生成）", () => {
  const official = ["screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
    "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position",
    "scroll", "type", "key", "hold_key", "wait"];
  assert.deepEqual([...STANDARD_ACTIONS], official);
  for (const a of official) assert.ok(COMPUTER_ACTIONS.includes(a), a);
});

test("每个动作都映射到 sidecar 真正实现的方法名，审批策略按方法判才认得", () => {
  const sidecarMethods = new Set([
    "mouse.click", "mouse.double_click", "mouse.triple_click", "mouse.down", "mouse.up", "mouse.move",
    "mouse.position", "mouse.drag", "mouse.scroll", "keyboard.type", "keyboard.press", "keyboard.combo",
    "keyboard.hold", "keyboard.paste", "screen.info", "screen.capture", "clipboard.get", "clipboard.set",
    "window.list", "window.activate", "window.minimize", "window.restore",
    "recorder.save", "recorder.replay", "recorder.list", "screen.wait",
  ]);
  const sample = {
    screenshot: {}, zoom: { region: [0, 0, 10, 10] },
    left_click: { coordinate: [1, 2] }, right_click: {}, middle_click: {}, double_click: {}, triple_click: {},
    left_click_drag: { start_coordinate: [1, 1], coordinate: [9, 9] }, mouse_move: { coordinate: [3, 4] },
    left_mouse_down: {}, left_mouse_up: {}, cursor_position: {},
    scroll: { scroll_direction: "down", scroll_amount: 3 }, type: { text: "hi" }, key: { text: "Return" },
    hold_key: { text: "shift", duration: 1 }, paste: { text: "x" }, screen_info: {}, window_list: {},
    window_activate: { title: "Finder" }, window_minimize: { title: "Finder" }, window_restore: { title: "Finder" },
    clipboard_get: {}, clipboard_set: { text: "x" }, recorder_save: { name: "a" }, recorder_replay: { name: "a" }, recorder_list: {},
    wait_for: { text: "保存成功" },
  };
  for (const action of COMPUTER_ACTIONS) {
    if (action === "wait") continue;
    const m = mapComputerAction({ action, ...(sample[action] || {}) });
    assert.ok(!m.error, `${action}: ${m.error}`);
    assert.ok(sidecarMethods.has(m.method), `${action} → ${m.method} 不是 sidecar 实现的方法`);
  }
});

test("wait 在本地睡，不打 sidecar，也就不过审批门", () => {
  const m = mapComputerAction({ action: "wait", duration: 2 });
  assert.equal(m.local.wait, 2);
  assert.equal(mapComputerAction({ action: "wait", duration: 9999 }).local.wait, WAIT_MAX_SECONDS, "要封顶");
});

test("点击坐标从截图像素换成屏幕点：origin + px × points_per_image_px", () => {
  const m = applyScreenMap(mapComputerAction({ action: "left_click", coordinate: [640, 413] }), MAP);
  assert.equal(m.method, "mouse.click");
  assert.equal(m.params.button, "left");
  assert.equal(m.params.x, 864, "640 × 1.35");
  assert.equal(m.params.y, Math.round(413 * 1.35));
  assert.equal(m.coordSpace, "points", "换算后就是屏幕点，sidecar 直接用");
});

test("区域截图的原点不是 (0,0)：换算要加回原点", () => {
  const zoomMap = screenMapFrom({ image_px: { width: 800, height: 600 }, points_origin: { x: 100, y: 200 }, points_per_image_px: 0.5 });
  assert.deepEqual(toPoints([0, 0], zoomMap), [100, 200]);
  assert.deepEqual(toPoints([800, 600], zoomMap), [500, 500]);
  assert.deepEqual(toImagePx(100, 200, zoomMap), [0, 0]);
});

test("没截过图就给坐标 → 拒绝并指向 screenshot，绝不按屏幕点瞎点", () => {
  const m = applyScreenMap(mapComputerAction({ action: "left_click", coordinate: [10, 10] }), null);
  assert.ok(m.error && /screenshot/.test(m.error), m.error);
  // 不带坐标的点击（在指针当前位置）不需要 map
  const noCoord = applyScreenMap(mapComputerAction({ action: "left_click" }), null);
  assert.ok(!noCoord.error);
  assert.equal(noCoord.params.x, undefined);
});

test("zoom 的 region 是全图像素空间，换成屏幕点的区域截图；且不改变主 map", () => {
  const m = applyScreenMap(mapComputerAction({ action: "zoom", region: [100, 100, 300, 250] }), MAP);
  assert.equal(m.method, "screen.capture");
  assert.equal(m.params.x, 135); assert.equal(m.params.y, 135);
  assert.equal(m.params.width, 270); assert.equal(m.params.height, Math.round(150 * 1.35));
  assert.equal(m.isZoom, true, "执行器据此不用 zoom 的回执覆盖主 map");
  assert.equal(m.params.region_px, undefined, "像素区域已换算，不能再传给 sidecar");
});

test("拖拽两端都换算；修饰键随 text 传成 keys", () => {
  const m = applyScreenMap(mapComputerAction({ action: "left_click_drag", start_coordinate: [10, 10], coordinate: [20, 20], text: "shift" }), MAP);
  assert.equal(m.method, "mouse.drag");
  assert.deepEqual([m.params.from_x, m.params.from_y, m.params.to_x, m.params.to_y], [14, 14, 27, 27]);
  assert.deepEqual(m.params.keys, ["shift"]);
  const c = mapComputerAction({ action: "left_click", coordinate: [1, 1], text: "cmd+shift" });
  assert.deepEqual(c.params.keys, ["cmd", "shift"]);
});

test("scroll：方向变成 delta 的正负，left/right 走 delta_x", () => {
  assert.equal(mapComputerAction({ action: "scroll", scroll_direction: "down", scroll_amount: 5 }).params.delta_y, 5);
  assert.equal(mapComputerAction({ action: "scroll", scroll_direction: "up", scroll_amount: 5 }).params.delta_y, -5);
  const r = mapComputerAction({ action: "scroll", scroll_direction: "right", scroll_amount: 2 }).params;
  assert.equal(r.delta_x, 2); assert.equal(r.delta_y, 0);
  assert.ok(mapComputerAction({ action: "scroll", scroll_direction: "sideways" }).error);
});

test("键名：xdotool 风格翻成 sidecar 认的；组合键拆成数组；单键走 press", () => {
  assert.equal(normalizeKey("Return"), "enter");
  assert.equal(normalizeKey("BackSpace"), "backspace");
  assert.equal(normalizeKey("Escape"), "esc");
  assert.equal(normalizeKey("super"), "cmd");
  assert.equal(normalizeKey("Page_Down"), "pagedown");
  assert.equal(normalizeKey("a"), "a");
  assert.equal(normalizeKey("F12"), "f12");
  assert.deepEqual(splitCombo("ctrl+shift+S"), ["ctrl", "shift", "S"]);
  const single = mapComputerAction({ action: "key", text: "Return" });
  assert.equal(single.method, "keyboard.press"); assert.equal(single.params.key, "enter");
  const combo = mapComputerAction({ action: "key", text: "cmd+s", repeat: 3 });
  assert.equal(combo.method, "keyboard.combo"); assert.deepEqual(combo.params.keys, ["cmd", "s"]); assert.equal(combo.repeat, 3);
  assert.equal(mapComputerAction({ action: "key", text: "x", repeat: 500 }).repeat, 100, "repeat 封顶 100");
});

test("hold_key 秒→毫秒并封顶；type 空串报错", () => {
  const h = mapComputerAction({ action: "hold_key", text: "shift", duration: 2 });
  assert.equal(h.method, "keyboard.hold"); assert.equal(h.params.ms, 2000);
  assert.equal(mapComputerAction({ action: "hold_key", text: "shift", duration: 99 }).params.ms, 10_000);
  assert.ok(mapComputerAction({ action: "type", text: "" }).error);
});

test("老写法 mouse.click{x,y} 直通，坐标当屏幕点，不换算", () => {
  const m = applyScreenMap(mapComputerAction({ method: "mouse.click", params: { x: 100, y: 200 } }), MAP);
  assert.equal(m.method, "mouse.click");
  assert.deepEqual([m.params.x, m.params.y], [100, 200]);
  assert.equal(m.legacy, true);
});

test("不认识的动作报错并列出可用动作；缺 action 也一样", () => {
  const e = mapComputerAction({ action: "teleport" });
  assert.match(e.error, /teleport/); assert.match(e.error, /left_click/);
  assert.match(mapComputerAction({}).error, /screenshot/);
});

test("回执里的屏幕点落点换回图上像素，模型对得上自己的坐标", () => {
  const r = annotateReceipt({ status: "ok", x: 864, y: 558 }, MAP);
  assert.deepEqual(r.image_px, [640, Math.round(558 / 1.35)]);
  assert.equal(annotateReceipt({ status: "ok" }, MAP).image_px, undefined);
});

test("老 sidecar 的回执没有几何 → map 为空，而不是一个错的 map", () => {
  assert.equal(screenMapFrom({ data_url: "data:image/png;base64,AAAA", scale_note: "…" }), null);
  assert.equal(screenMapFrom({ image_px: { width: 0, height: 0 }, points_per_image_px: 1 }), null);
});

test("几何说明：整屏截图说尺寸和坐标规则；标注图加「编号 = ref」和被盖住的数量；没图说原因", () => {
  const plain = describeScreenImage({ image_px: { width: 1280, height: 827 } });
  assert.match(plain, /1280×827/); assert.match(plain, /像素/);
  assert.ok(!/ref/.test(plain), "普通截图不该提 ref");
  const marked = describeScreenImage({ image_px: { width: 1280, height: 827 }, marks: 96, marks_hidden: 212 }, { marked: true });
  assert.match(marked, /编号 = 上面元素的 ref/); assert.match(marked, /96 个/); assert.match(marked, /212 个被别的窗口盖住/);
  const occ = describeScreenImage({ occluded: { target_pid: 511, front_pid: 11541, front_app: "Claude" } });
  assert.match(occ, /pid 511/); assert.match(occ, /「Claude」/); assert.match(occ, /window_activate/);
  assert.equal(describeScreenImage(null), ""); assert.equal(describeScreenImage({}), "");
  // 锁屏：截图全黑、窗口栈为空、AX 树照样读得到——不说出来，黑图会被当成「这个应用什么都没显示」
  const locked = describeScreenImage({ image_px: { width: 1280, height: 827 }, marks: 9, screen_locked: true }, { marked: true });
  assert.match(locked, /锁着/); assert.match(locked, /解锁/); assert.ok(!/1280×827/.test(locked), "锁屏时别再教它按图上像素给坐标");
});

test("window_activate 认窗口标题、应用名、pid 三种写法；一个都没给才报错", () => {
  // 所有者的 Electron 应用：进程叫 Electron、窗口叫「ZipMate 压缩助手」，模型眼里只有后者——
  // 三个键都收，值是标题还是应用名由 sidecar 的 app.resolve 一次全认。
  assert.deepEqual(mapComputerAction({ action: "window_activate", title: "ZipMate 压缩助手" }).params, { title: "ZipMate 压缩助手" });
  assert.deepEqual(mapComputerAction({ action: "window_activate", app: "Finder" }).params, { title: "Finder" });
  assert.deepEqual(mapComputerAction({ action: "window_activate", name: "访达" }).params, { title: "访达" });
  // read_screen / app.resolve 回来的就是 pid，直接透传，不再翻译成名字。
  assert.deepEqual(mapComputerAction({ action: "window_activate", pid: 511 }).params, { pid: 511 });
  assert.deepEqual(mapComputerAction({ action: "window_activate", pid: "511" }).params, { pid: 511 });
  const bad = mapComputerAction({ action: "window_activate" });
  assert.match(bad.error, /title/);
  assert.match(bad.error, /应用名/);
  assert.deepEqual(mapComputerAction({ action: "window_minimize", app: "Finder" }).method, "window.minimize");
});

test("wait_for：text 必填，秒数封顶 30，title/app 指目标，gone 等消失", () => {
  const m = mapComputerAction({ action: "wait_for", text: "保存成功", duration: 5, title: "记事本" });
  assert.equal(m.method, "screen.wait");
  assert.deepEqual(m.params, { text: "保存成功", timeout_ms: 5000, app: "记事本" });
  assert.equal(mapComputerAction({ action: "wait_for", text: "x", duration: 999 }).params.timeout_ms, 30000, "要封顶");
  assert.equal(mapComputerAction({ action: "wait_for", text: "x" }).params.timeout_ms, 8000, "默认 8 秒");
  assert.equal(mapComputerAction({ action: "wait_for", text: "正在加载", gone: true }).params.gone, true);
  assert.match(mapComputerAction({ action: "wait_for" }).error, /text/);
});
