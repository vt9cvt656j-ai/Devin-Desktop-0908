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
  // 批量读取的聚合卡：一叠纸，和单张 read 一眼分得开。
  readbatch: '<path d="M8 3h5l3 3v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M13 3v3h3"/><path d="M18 8v11a2 2 0 0 1-2 2H8"/><path d="M9.5 11h4"/>',
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
  // ── 补齐：下面这 58 种以前没有专属图形，全部静默回落到那张通用文件图。
  //    用户实拍指出的「批量读取怎么没国外风格大厂图标」就是其中一个；一屏卡片里
  //    过半都是同一张灰纸，图标就不再承担"这一步在干什么"的判断了。
  //    有品牌的按品牌自己的形（GitLab 的狐狸角、Stack Overflow 的栈、Figma 的五块），
  //    没品牌的按动作的实物画。
  // ── 代码 / 诊断（read 族）────────────────────────────────────────────
  findsymbol: '<path d="M9 4C7 4 7 8 7 9s0 3-2.5 3c2.5 0 2.5 2 2.5 3s0 5 2 5"/><circle cx="16" cy="11.5" r="3.2"/><path d="M20.2 15.7l-1.9-1.9"/>',
  semsearch: '<circle cx="10.5" cy="10.5" r="6"/><path d="M19.5 19.5L15 15"/><path d="M10.5 7.3l.85 2.35 2.35.85-2.35.85-.85 2.35-.85-2.35-2.35-.85 2.35-.85z"/>',
  search_tools: '<rect x="4" y="6" width="16" height="13" rx="2"/><path d="M4 10.5h16"/><path d="M9 6V4.5h6V6"/><path d="M12 13.5v2.5"/>',
  recall: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v3.6h3.6"/><path d="M12 8v4.3l2.9 1.7"/>',
  diag: '<path d="M12 4.2l8.6 15.3H3.4z"/><path d="M12 10v4"/><path d="M12 16.8h.01"/>',
  logs: '<path d="M6 3h11a2 2 0 0 1 2 2v15.5l-2.6-1.6L14 20.5l-2.4-1.6L9.2 20.5 6.6 18.9 4 20.5V5a2 2 0 0 1 2-2z"/><path d="M8.4 8h8"/><path d="M8.4 12h5"/>',
  viewimage: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.4" cy="10" r="1.6"/><path d="M4 17.2l4.6-4.6 3 3L15 11l5 5"/>',
  readscreen: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8"/><path d="M12 16.5v4"/><path d="M6.5 8.5h7"/><path d="M6.5 12h4"/>',
  probeenv: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l3.8-3.4"/><path d="M12 3.5V6"/><path d="M20.5 12H18"/><path d="M3.5 12H6"/>',
  openapi_parser: '<path d="M8.5 4H7a2 2 0 0 0-2 2v3.8L3 12l2 2.2V18a2 2 0 0 0 2 2h1.5"/><path d="M15.5 4H17a2 2 0 0 1 2 2v3.8L21 12l-2 2.2V18a2 2 0 0 1-2 2h-1.5"/><path d="M12 8.5v7"/>',
  package_source: '<path d="M3.5 8L12 3.7 20.5 8v8L12 20.3 3.5 16z"/><path d="M3.5 8L12 12.3 20.5 8"/><path d="M12 12.3v8"/>',
  // ── 检索服务（net 族）────────────────────────────────────────────────
  package_search: '<path d="M12 12.3L3.5 8 12 3.7 20.5 8z"/><path d="M3.5 8v8L12 20.3v-8"/><circle cx="17.5" cy="15.8" r="3.2"/><path d="M21.3 19.6l-1.6-1.6"/>',
  bundlephobia_search: '<path d="M12 3.5v3"/><path d="M6 6.5h12"/><path d="M4 20.3h16"/><path d="M12 6.5v13.8"/><path d="M6.4 6.8L4 13.2h4.8z"/><path d="M17.6 6.8L15.2 13.2H20z"/>',
  iconify_search: '<circle cx="7.4" cy="7.4" r="3"/><rect x="13.6" y="4.4" width="6" height="6" rx="1.2"/><path d="M7.4 13.4l3.1 6.2H4.3z"/><circle cx="16.6" cy="16.6" r="3"/>',
  github_repo: '<path d="M6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z"/><path d="M4 17.4h15"/><path d="M9 3v8.6l2.5-1.9 2.5 1.9V3"/>',
  github_search: '<path d="M6.5 3h9v11.5h-9A2.5 2.5 0 0 0 4 17V5.5A2.5 2.5 0 0 1 6.5 3z"/><path d="M4 17a2.5 2.5 0 0 0 2.5 2.5h4"/><circle cx="16.8" cy="17" r="3.4"/><path d="M21.2 21.4l-2-2"/>',
  gitlab_repo: '<path d="M12 20.6L3.7 12.7l1.7-6.5 2.7 6.5h7.8l2.7-6.5 1.7 6.5z"/>',
  gitee_repo: '<circle cx="12" cy="12" r="8.5"/><path d="M16.3 9.2h-4.9A2.6 2.6 0 0 0 8.8 11.8v3.1h5.6v-2.6h-2.3"/>',
  codeberg_repo: '<path d="M12 3.4l8.7 17.2H3.3z"/><path d="M12 10.6l5.1 10h-10.2z"/>',
  stackoverflow_search: '<path d="M17.2 15.4V19a1.6 1.6 0 0 1-1.6 1.6H6.4A1.6 1.6 0 0 1 4.8 19v-3.6"/><path d="M7.8 17h7.4"/><path d="M8.1 13.5l7.2 1.5"/><path d="M9 10l6.8 2.8"/><path d="M10.7 6.6l5.9 4"/>',
  hackernews_search: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.4"/><path d="M8.2 8.2l3.8 4.8 3.8-4.8"/><path d="M12 13v3.6"/>',
  mdn_search: '<rect x="3" y="4.6" width="18" height="14.8" rx="2"/><path d="M6.8 15.4V9l2.6 3.2L12 9v6.4"/><path d="M14.8 9v6.4h1.7a3.2 3.2 0 0 0 0-6.4z"/>',
  wiki_search: '<circle cx="12" cy="12" r="8.5"/><path d="M6.8 8.8l2.1 6.4L12 8.8l3.1 6.4 2.1-6.4"/>',
  arxiv_search: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9.2 11.8l5 5.2"/><path d="M14.2 11.8l-5 5.2"/>',
  pubmed_search: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M12 11v6"/><path d="M9 14h6"/>',
  clinical_trials_search: '<path d="M9.6 3.5v5.2L4.9 17a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3l-4.7-8.3V3.5"/><path d="M8.4 3.5h7.2"/><path d="M7.3 13.6h9.4"/>',
  pubchem_search: '<circle cx="12" cy="5.8" r="2.2"/><circle cx="5.6" cy="16" r="2.2"/><circle cx="18.4" cy="16" r="2.2"/><path d="M10.6 7.6L7.2 13.9"/><path d="M13.4 7.6l3.4 6.3"/><path d="M7.8 16h8.4"/>',
  crossref_search: '<path d="M10 10.4a3.3 3.3 0 0 1 4.6 0l3 3a3.3 3.3 0 0 1-4.6 4.6l-.8-.8"/><path d="M14 13.6a3.3 3.3 0 0 1-4.6 0l-3-3A3.3 3.3 0 0 1 11 6l.8.8"/>',
  openalex_search: '<circle cx="12" cy="12" r="2.9"/><circle cx="5.2" cy="6.2" r="2"/><circle cx="18.8" cy="6.2" r="2"/><circle cx="5.2" cy="17.8" r="2"/><circle cx="18.8" cy="17.8" r="2"/><path d="M9.8 10.2L6.8 7.6"/><path d="M14.2 10.2l3-2.6"/><path d="M9.8 13.8l-3 2.6"/><path d="M14.2 13.8l3 2.6"/>',
  cve_search: '<path d="M12 3.4l7 2.5v6.2c0 4.2-2.9 7.4-7 8.5-4.1-1.1-7-4.3-7-8.5V5.9z"/><path d="M12 8.8v4.2"/><path d="M12 16.2h.01"/>',
  developer_community_search: '<circle cx="9" cy="8.4" r="3"/><path d="M3.4 19.2a5.6 5.6 0 0 1 11.2 0"/><path d="M16 6.1a3.1 3.1 0 0 1 0 5.8"/><path d="M17.6 19.2a5.6 5.6 0 0 0-2.7-4.8"/>',
  steam_search: '<path d="M8 9h8a5 5 0 0 1 4.85 6.2l-.5 2a2.4 2.4 0 0 1-4.25.85L15 16.2H9l-1.1 1.85a2.4 2.4 0 0 1-4.25-.85l-.5-2A5 5 0 0 1 8 9z"/><path d="M8.4 11.8v2.6"/><path d="M7.1 13.1h2.6"/><circle cx="15.6" cy="12.4" r=".9"/>',
  awwwards_search: '<path d="M8 3.6h8V9a4 4 0 0 1-8 0z"/><path d="M8 5.2H5.4v1.4a3 3 0 0 0 3 3"/><path d="M16 5.2h2.6v1.4a3 3 0 0 1-3 3"/><path d="M12 13v3.2"/><path d="M10 16.2h4l1.1 4.2H8.9z"/>',
  codrops_search: '<path d="M12 3.4s6.1 6.5 6.1 10.3a6.1 6.1 0 0 1-12.2 0C5.9 9.9 12 3.4 12 3.4z"/><path d="M9.1 14.4a2.9 2.9 0 0 0 2.9 2.9"/>',
  smashingmag_search: '<path d="M3.4 5.4h6.9a2 2 0 0 1 2 2v11a2.6 2.6 0 0 0-2.6-2H3.4z"/><path d="M20.6 5.4h-6.9a2 2 0 0 0-2 2v11a2.6 2.6 0 0 1 2.6-2h6.3z"/>',
  // ── 仓库 / 环境（net 族）─────────────────────────────────────────────
  gh: '<circle cx="6.8" cy="6" r="2.4"/><circle cx="6.8" cy="18" r="2.4"/><circle cx="17.2" cy="18" r="2.4"/><path d="M6.8 8.4v7.2"/><path d="M17.2 15.6V11a3 3 0 0 0-3-3h-3.4"/><path d="M13.2 5.6L10.6 8l2.6 2.4"/>',
  docker_compose_up: '<rect x="4" y="11.6" width="4" height="4"/><rect x="9" y="11.6" width="4" height="4"/><rect x="14" y="11.6" width="4" height="4"/><rect x="9" y="7" width="4" height="4"/><path d="M2.8 17.4c2.4 2.4 5.6 3 8.8 3 5 0 8.6-2.6 9.6-6.6-1.5.9-3.1.6-4.1-.4"/>',
  worktree: '<path d="M4 6.4A1.5 1.5 0 0 1 5.5 4.9h3.4l1.5 2h4.1A1.5 1.5 0 0 1 16 8.4v1.4"/><path d="M4 6.4v11.2a1.5 1.5 0 0 0 1.5 1.5h6"/><circle cx="18" cy="12.6" r="2"/><circle cx="18" cy="19.4" r="2"/><path d="M18 14.6v2.8"/>',
  figma: '<path d="M9 3.4h3v6H9a3 3 0 1 1 0-6z"/><path d="M12 3.4h3a3 3 0 1 1 0 6h-3z"/><path d="M9 9.4h3v6H9a3 3 0 1 1 0-6z"/><circle cx="15" cy="12.4" r="3"/><path d="M12 15.4v3a3 3 0 1 1-3-3z"/>',
  automation: '<rect x="3.4" y="4.4" width="17.2" height="12.2" rx="2"/><path d="M8 20.6h8"/><path d="M12 16.6v4"/><circle cx="12" cy="10.5" r="2.2"/><path d="M12 6.6v1.5"/><path d="M12 12.9v1.5"/><path d="M8.5 10.5H10"/><path d="M14 10.5h1.5"/>',
  uiextract: '<rect x="3.4" y="4" width="12" height="12" rx="2"/><path d="M8.4 20h8.6a3 3 0 0 0 3-3V8.4"/><path d="M6.8 8.4h5.2"/><path d="M6.8 12h3.2"/>',
  liveenvironment: '<circle cx="12" cy="12" r="2.5"/><path d="M8.3 8.3a5.3 5.3 0 0 0 0 7.4"/><path d="M15.7 15.7a5.3 5.3 0 0 0 0-7.4"/><path d="M5.5 5.5a9.3 9.3 0 0 0 0 13"/><path d="M18.5 18.5a9.3 9.3 0 0 0 0-13"/>',
  capture_start: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/>',
  capture_stop: '<circle cx="12" cy="12" r="8.5"/><rect x="9.1" y="9.1" width="5.8" height="5.8" rx="1.2"/>',
  capture_flows: '<rect x="3.4" y="3.8" width="6.2" height="5" rx="1.5"/><rect x="14.4" y="3.8" width="6.2" height="5" rx="1.5"/><rect x="8.9" y="15.2" width="6.2" height="5" rx="1.5"/><path d="M6.5 8.8v3.4h11V8.8"/><path d="M12 12.2v3"/>',
  mcpconfig: '<path d="M9 3.2v5"/><path d="M15 3.2v5"/><path d="M6.4 8.2h11.2v2.9a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 16.7v4.1"/>',
  // ── 跑 / 排查（run 族）───────────────────────────────────────────────
  debug: '<path d="M9 7.4a3 3 0 0 1 6 0"/><rect x="7" y="7.4" width="10" height="11.2" rx="5"/><path d="M3.8 11.2H7"/><path d="M17 11.2h3.2"/><path d="M3.8 16.2H7"/><path d="M17 16.2h3.2"/><path d="M7.6 5.8L6.2 4.4"/><path d="M16.4 5.8l1.4-1.4"/>',
  performance_profile: '<path d="M3.6 19.6h16.8"/><rect x="4.4" y="13.2" width="15" height="2.7" rx="1.2"/><rect x="6.6" y="9" width="8.6" height="2.7" rx="1.2"/><rect x="8.2" y="4.8" width="4.4" height="2.7" rx="1.2"/>',
  schedule: '<rect x="3.4" y="5" width="17.2" height="15.5" rx="2"/><path d="M3.4 10h17.2"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M12 13v3.1l2.2 1.3"/>',
  worker: '<rect x="3.4" y="6.6" width="17.2" height="12" rx="2"/><path d="M8.2 6.6V5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 2 2v1.6"/><path d="M12 11v3"/><path d="M10.5 12.5h3"/>',
  // ── 想 / 造（think / make 族）────────────────────────────────────────
  subagent: '<rect x="5" y="8.2" width="14" height="10.8" rx="3"/><path d="M12 4.8v3.4"/><circle cx="12" cy="3.5" r="1.4"/><path d="M9.6 12.6v1.6"/><path d="M14.4 12.6v1.6"/><path d="M2.6 12.4v3.2"/><path d="M21.4 12.4v3.2"/>',
  awaitsubagent: '<path d="M7 3.6h10"/><path d="M7 20.4h10"/><path d="M8.2 3.6v3.2c0 2 3.8 3.5 3.8 5.2s-3.8 3.2-3.8 5.2v3.2"/><path d="M15.8 3.6v3.2c0 2-3.8 3.5-3.8 5.2s3.8 3.2 3.8 5.2v3.2"/>',
  explain: '<path d="M12 3.4a5.6 5.6 0 0 0-3.1 10.3v2.5h6.2v-2.5A5.6 5.6 0 0 0 12 3.4z"/><path d="M10 19h4"/><path d="M10.6 21.4h2.8"/>',
  vizcompare: '<rect x="3" y="4.6" width="18" height="14.8" rx="2"/><path d="M12 4.6v14.8"/><path d="M6 9.6h3.2"/><path d="M14.8 9.6H18"/><path d="M6 13.6h3.2"/><path d="M14.8 13.6H18"/>',
  preview: '<rect x="3" y="5" width="7.2" height="14" rx="1.6"/><rect x="13.8" y="5" width="7.2" height="14" rx="1.6"/><path d="M5.4 9.4h2.4"/><path d="M16.2 9.4h2.4"/>',
  designboard: '<rect x="3.4" y="4" width="17.2" height="12.6" rx="2"/><path d="M12 16.6v3.9"/><path d="M8.6 20.5h6.8"/><rect x="6.4" y="6.8" width="4.6" height="3.4" rx="1"/><rect x="13" y="6.8" width="4.6" height="6.6" rx="1"/><path d="M6.4 12.6h4.6"/>',
  learndesign: '<path d="M4 5.4A2.4 2.4 0 0 1 6.4 3H19v14.2H6.4A2.4 2.4 0 0 0 4 19.6z"/><path d="M4 19.6A2.4 2.4 0 0 1 6.4 17.2H19v3.8H6.4"/><path d="M11.5 6.4l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"/>',
  createproject: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2"/><path d="M3.4 9.4h17.2"/><path d="M8.4 9.4v10.2"/><path d="M11.6 14.4h6.2"/><path d="M14.7 11.3v6.2"/>',
  web_scaffold: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M12 12.4v5"/><path d="M9.4 14.9h5.2"/>',
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
  // 补齐的 58 种（原来一律回落成中性灰）。分族的判据仍是"这一步在动什么"：
  // 动本地文件/知识 → read，动网络与外部服务 → net，跑起来 → run，在想/在造 → think/make。
  findsymbol: "read", semsearch: "read", search_tools: "read", recall: "read",
  diag: "read", logs: "read", viewimage: "read", readscreen: "read",
  probeenv: "read", openapi_parser: "read", package_source: "read",
  package_search: "net", bundlephobia_search: "net", iconify_search: "net",
  github_repo: "net", github_search: "net", gitlab_repo: "net", gitee_repo: "net",
  codeberg_repo: "net", stackoverflow_search: "net", hackernews_search: "net",
  mdn_search: "net", wiki_search: "net", arxiv_search: "net", pubmed_search: "net",
  clinical_trials_search: "net", pubchem_search: "net", crossref_search: "net",
  openalex_search: "net", cve_search: "net", developer_community_search: "net",
  steam_search: "net", awwwards_search: "net", codrops_search: "net",
  smashingmag_search: "net", docker_compose_up: "net", worktree: "net",
  figma: "net", automation: "net", uiextract: "net", liveenvironment: "net",
  capture_start: "net", capture_stop: "net", capture_flows: "net", mcpconfig: "net",
  performance_profile: "run", schedule: "run", worker: "run",
  awaitsubagent: "think", explain: "think", vizcompare: "think", preview: "think",
  designboard: "make", learndesign: "make", createproject: "make", web_scaffold: "make",
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
