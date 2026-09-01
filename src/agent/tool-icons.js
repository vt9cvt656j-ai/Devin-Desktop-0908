/**
 * 工具卡的图标。
 *
 * **为什么整套换掉**：原来用的是 GitHub Octicons 的 16px **实心**图形。实心图标在 15px
 * 这个尺寸上会糊成一个色块——一屏工具卡下来，形状之间的差别几乎读不出来，只剩下"有个
 * 深色小方块"。而这个产品恰恰指望图标承担"这一步在干什么"的第一眼判断。
 *
 * 换成 **24 网格的描边图形**（stroke 1.75、圆头圆角），也就是 Lucide / Radix 那一路的
 * 画法——Vercel、Linear、Raycast 用的都是它。描边在小尺寸下保留轮廓，形状差别看得出来，
 * 视觉重量也轻得多，十几张卡叠在一起不吵。
 *
 * 这里只存**几何**（viewBox 内的 path），外层 svg 由调用方套，这样描边宽度、尺寸、颜色
 * 都在一处控制，不会出现"某个图标自己带 fill 结果不跟主题"这种事。
 */

/** 外层属性：整套图标共用一份，改一次全体生效。 */
export const TOOL_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const FOLDER = '<path d="M4 6a2 2 0 0 1 2-2h3.5l2 2.5H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>';
const WINDOW = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>';

/**
 * 类型 → 图形。每一种都长得不一样——这是"一眼看出这步在干什么"的唯一载体，
 * 所以宁可多画一个，也不让两种动作共用同一个形状。
 */
export const TOOL_ICONS = {
  // ── 读 ───────────────────────────────────────────────────────────────
  read: FILE + '<path d="M8.5 13h7"/><path d="M8.5 16.5h4.5"/>',
  list: FOLDER,
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  find: FILE + '<circle cx="11.5" cy="14" r="2.5"/><path d="M15 17.5l-1.7-1.7"/>',
  knowledge: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5"/><path d="M9 8h6"/>',
  _ksearch: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v10"/><path d="M4 5.5v15A2.5 2.5 0 0 1 6.5 18H12"/><circle cx="17" cy="17" r="3.2"/><path d="M21 21l-1.7-1.7"/>',
  lsp: '<path d="M8.5 4C6.5 4 6.5 8 6.5 9s0 3-2.5 3c2.5 0 2.5 2 2.5 3s0 5 2 5"/><path d="M15.5 4c2 0 2 4 2 5s0 3 2.5 3c-2.5 0-2.5 2-2.5 3s0 5-2 5"/>',
  current_time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',

  // ── 写 ───────────────────────────────────────────────────────────────
  write: FILE + '<path d="M12 12v5"/><path d="M9.5 14.5h5"/>',
  edit: '<path d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17z"/><path d="M14.5 7l2.5 2.5"/>',
  multiedit: '<path d="M4 17h3.5L17 7.5a1.8 1.8 0 0 0-2.5-2.5L5 14.5z"/><path d="M13 6.5l2.5 2.5"/><path d="M9 21h11"/>',
  format: '<path d="M4 6h16"/><path d="M4 11h10"/><path d="M4 16h13"/><path d="M4 21h7"/>',
  mkdir: FOLDER + '<path d="M12 10.5v5"/><path d="M9.5 13h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6a2 2 0 0 0-2 2v6.5A2.5 2.5 0 0 0 6.5 15"/>',
  move: '<path d="M4 12h16"/><path d="M15 7l5 5-5 5"/><path d="M9 7L4 12l5 5"/>',
  delete: '<path d="M4 6.5h16"/><path d="M9 6.5V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5v2"/><path d="M6.5 6.5l.9 12.2A2 2 0 0 0 9.4 20.5h5.2a2 2 0 0 0 2-1.8l.9-12.2"/>',

  // ── 跑 ───────────────────────────────────────────────────────────────
  cmd: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M13 15h4"/>',
  termtask: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 10l2.5 2-2.5 2"/><path d="M12.5 14h4"/><circle cx="18.5" cy="6.5" r="2.2"/>',
  termread: '<path d="M6 3h10a2 2 0 0 1 2 2v13a3 3 0 0 0 3 3H8a2 2 0 0 1-2-2z"/><path d="M9.5 8h5"/><path d="M9.5 12h5"/>',
  termlist: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9h9"/><path d="M7.5 13h9"/><path d="M7.5 17h5"/>',
  termstop: '<circle cx="12" cy="12" r="8.5"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1"/>',
  demostart: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8l5.4 3.2-5.4 3.2z"/>',
  demostop: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 9.2v5.6"/><path d="M13.8 9.2v5.6"/>',

  // ── 网 ───────────────────────────────────────────────────────────────
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/>',
  websearch: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M4 10.5h13"/><path d="M10.5 4c1.7 1.9 2.6 4.1 2.6 6.5s-.9 4.6-2.6 6.5c-1.7-1.9-2.6-4.1-2.6-6.5S8.8 5.9 10.5 4z"/><path d="M20 20l-3.5-3.5"/>',
  http: '<path d="M4 9h16"/><path d="M17 6l3 3-3 3"/><path d="M20 15H4"/><path d="M7 12l-3 3 3 3"/>',
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4.5 19.5h15"/>',
  browser: WINDOW + '<circle cx="6.5" cy="6.5" r=".6"/><circle cx="9" cy="6.5" r=".6"/>',
  screenshot: '<path d="M4 8.5A2 2 0 0 1 6 6.5h1.6l1.2-2h6.4l1.2 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
  computer: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 16.5v4"/>',
  remote: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
  mcp: '<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
  qr: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14 14h2.5"/><path d="M20.5 14v6.5H14"/>',
  db: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  git: '<circle cx="7" cy="6" r="2.5"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="10" r="2.5"/><path d="M7 8.5v7"/><path d="M17 12.5c0 2.5-2 3.5-4.5 3.8"/>',

  // ── 想 ───────────────────────────────────────────────────────────────
  think: '<path d="M12 3.5a4 4 0 0 0-4 4v.4A3.6 3.6 0 0 0 6.4 14 3.6 3.6 0 0 0 10 17.5h2"/><path d="M12 3.5a4 4 0 0 1 4 4v.4A3.6 3.6 0 0 1 17.6 14 3.6 3.6 0 0 1 14 17.5h-2"/><path d="M12 3.5v17"/>',
  skill: '<path d="M12 3l1.9 4.4 4.6.4-3.5 3.1 1.1 4.6L12 13.1 7.9 15.5l1.1-4.6L5.5 7.8l4.6-.4z"/><path d="M18.5 17.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/>',
  memory: '<path d="M6 4h11a2 2 0 0 1 2 2v14l-6.5-3.5L6 20z"/><path d="M9.5 9h6"/>',
  askuser: '<path d="M20 15a3 3 0 0 1-3 3H9l-4.5 3.5V6a3 3 0 0 1 3-3h9.5a3 3 0 0 1 3 3z"/><path d="M10.2 8.8a2 2 0 1 1 2.8 2.2c-.7.4-1 .8-1 1.5"/><path d="M12 15h.01"/>',
  genimage: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.8" cy="9.8" r="1.6"/><path d="M20.5 15.5l-4.5-4.5L6 20"/>',

  // ── 游戏 / 生成 ───────────────────────────────────────────────────────
  game_scaffold: '<path d="M7 8.5h10a4.5 4.5 0 0 1 4.3 5.8l-.7 2.3A2.6 2.6 0 0 1 16 17l-1.4-1.5H9.4L8 17a2.6 2.6 0 0 1-4.6-.4l-.7-2.3A4.5 4.5 0 0 1 7 8.5z"/><path d="M8.5 12h2"/><path d="M9.5 11v2"/><circle cx="15.5" cy="11.6" r=".7"/>',
  generate_3d: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/><path d="M12 12L4 7.5"/>',
  generate_sound: '<path d="M11 5.5L6.5 9.5H3.5v5h3L11 18.5z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18.5 7a7 7 0 0 1 0 10"/>',
  generate_music: '<path d="M9 18V6.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  generate_voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  auto_rig: '<circle cx="12" cy="4.8" r="2"/><path d="M12 6.8v6"/><path d="M12 12.8L8 20"/><path d="M12 12.8L16 20"/><path d="M7 9h10"/>',
  generate_motion: '<path d="M3 12h3l2.5-6 4 13 3-9 2 2h3.5"/>',
  generate_texture: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17"/><path d="M3.5 15h17"/><path d="M9.5 3.5v17"/><path d="M15 3.5v17"/>',
  search_game_assets: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4"/><path d="M12 11v10"/>',
  download_asset: '<path d="M12 2.5l7.5 4v11l-7.5 4-7.5-4v-11z"/><path d="M12 9v6"/><path d="M9.3 12.3L12 15l2.7-2.7"/>',
};

/**
 * 类型 → 色族。
 *
 * **只有七族，不是四十三种。** 上一版把 43 种粉彩底整套删掉、全部走灰，用户的反馈是
 * 「不要走现在这种色……每个卡片类型要不一样的」——他要的是**能分辨**，不是回到彩虹。
 * 所以颜色按"这一步在动什么"分族：读的、写的、跑的、连网的、想的、危险的。
 * 同族共用一个色，族内靠图形区分。颜色只上在**描边**上，不做填色底块——填色块正是
 * 上一版被判"杂乱"的那个东西。
 */
export const TOOL_FAMILY = {
  read: "read", list: "read", search: "read", find: "read", knowledge: "read",
  _ksearch: "read", lsp: "read", current_time: "read", readbatch: "read",
  write: "write", edit: "write", multiedit: "write", format: "write",
  mkdir: "write", copy: "write", move: "write",
  cmd: "run", termtask: "run", termread: "run", termlist: "run", termstop: "run",
  demostart: "run", demostop: "run", debug: "run",
  web: "net", websearch: "net", http: "net", download: "net", browser: "net",
  screenshot: "net", computer: "net", remote: "net", mcp: "net", qr: "net",
  db: "net", git: "net", gh: "net",
  think: "think", skill: "think", memory: "think", askuser: "think",
  genimage: "think", subagent: "think", plan: "think", updateplan: "think",
  game_scaffold: "make", generate_3d: "make", generate_sound: "make",
  generate_music: "make", generate_voice: "make", auto_rig: "make",
  generate_motion: "make", generate_texture: "make",
  search_game_assets: "make", download_asset: "make",
  delete: "danger",
};

/** 这个类型该用哪一族的颜色。认不出的一律走中性灰——不猜。 */
export function toolIconFamily(type) {
  return TOOL_FAMILY[String(type || "")] || "neutral";
}

/** 完整的 svg 字符串。认不出的类型回落到一张普通文件——不留空方块。 */
export function toolIconSvg(type) {
  const g = TOOL_ICONS[String(type || "")] || FILE;
  return `<svg ${TOOL_ICON_ATTRS}>${g}</svg>`;
}
