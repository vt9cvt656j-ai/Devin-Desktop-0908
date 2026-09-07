// 浏览器工具结果里的链接预览卡——现代的那种（iMessage / X / Notion 书签卡的形状）：
// 页面截图通栏在上，下面一块信息区：站点头像 + 站点名一行、标题、描述。没有竖条，没有彩色底，
// 中性描边 + 圆角 12px。顺序是所有者定的：内容在上、卡在下。
//
// 为什么把它从 main.js 拆出来：这块是纯字符串拼接，拆出来能在 Node 里真渲染一次核对结构，
// 也能让官网 / 预览夹具用同一份实现，而不是各抄一份 DOM 再漂开。
//
// 站点头像：Rust 侧随页面状态给出 favicon 地址（<link rel=icon> 或 /favicon.ico）；图标加载失败
// 时退回站点名首字母的方块头像（bindBrowserLinkCard 监听 error 把 <img> 摘掉，字母就露出来）。
// 截图默认裁到 360px 高、顶部对齐，点一下展开完整一张（.is-expanded）。

/** 只取主机名；不是合法 URL 时原样返回（比如只有一个标题、或者 about:blank）。 */
export function hostOf(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname || raw;
  } catch {
    return raw;
  }
}

/** 首字母头像用的字：主机名去掉 www. 之后的第一个字符，大写；没有就用 ∙。 */
export function siteInitial(host) {
  const h = String(host || "").replace(/^www\./i, "").trim();
  return h ? h[0].toUpperCase() : "∙";
}

/**
 * @param {{url?: string, title?: string, description?: string, screenshot?: string, favicon?: string}} state
 *   浏览器工具返回的页面状态；screenshot 是 data URL，favicon 是站点图标的绝对地址。
 * @param {(s: string) => string} escHtml 调用方的 HTML 转义。
 * @returns {string} 一段可直接塞进 .atc-viewport 的 HTML；什么都没有时返回空串。
 */
export function browserLinkCardHtml(state, escHtml) {
  const esc = typeof escHtml === "function" ? escHtml : (s) => String(s);
  const shot = String(state?.screenshot || "");
  const url = String(state?.url || "").trim();
  const title = String(state?.title || "").trim();
  const desc = String(state?.description || state?.meta_description || "").trim();
  const favicon = String(state?.favicon || "").trim();
  const host = hostOf(url);
  const media = shot
    ? `<div class="browser-link-card__media" title="点击展开 / 收起完整截图"><img src="${esc(shot)}" alt="页面截图" decoding="async"></div>`
    : "";
  if (!host && !title) {
    // 纯截图（screenshot 动作、或页面没给出 URL/标题）：只画媒体块，不画空的信息区。
    return media ? `<div class="browser-link-card browser-link-card--bare">${media}</div>` : "";
  }
  // 只放行 http(s) 和 data:image/ 两种地址：javascript: 之类不能进 src。
  const iconImg = /^(?:https?:\/\/|data:image\/)/i.test(favicon) ? `<img class="browser-link-card__favicon" src="${esc(favicon)}" alt="" decoding="async">` : "";
  const site = host
    ? `<span class="browser-link-card__site"><span class="browser-link-card__icon" data-letter="${esc(siteInitial(host))}">${iconImg}</span><span class="browser-link-card__host">${esc(host)}</span></span>`
    : "";
  const rows = [
    site,
    // 标题缺失或和主机名一样时只画站点行，否则两行渲染出一模一样的字，像重复了一遍。
    title && title !== host ? `<span class="browser-link-card__title">${esc(title)}</span>` : "",
    desc ? `<span class="browser-link-card__desc">${esc(desc)}</span>` : "",
  ].join("");
  return `<div class="browser-link-card">${media}<div class="browser-link-card__meta">${rows}</div></div>`;
}

/** 给卡片装上行为：点媒体块展开完整截图；站点图标加载失败就摘掉，露出首字母头像。幂等。 */
export function bindBrowserLinkCard(root) {
  const q = (sel) => (root && typeof root.querySelector === "function" ? root.querySelector(sel) : null);
  let bound = false;
  const media = q(".browser-link-card__media");
  if (media && media.dataset.expandBound !== "1") {
    media.dataset.expandBound = "1";
    media.addEventListener("click", () => { media.classList.toggle("is-expanded"); });
    bound = true;
  }
  const icon = q(".browser-link-card__favicon");
  if (icon && icon.dataset.errBound !== "1") {
    icon.dataset.errBound = "1";
    icon.addEventListener("error", () => { if (icon.parentNode) icon.parentNode.removeChild(icon); });
    bound = true;
  }
  return bound;
}

/** 旧名字，main.js 的调用点还叫它；行为同 bindBrowserLinkCard。 */
export const bindBrowserLinkCardMedia = bindBrowserLinkCard;
