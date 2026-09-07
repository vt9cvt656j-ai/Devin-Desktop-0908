// 浏览器工具结果里的链接预览卡（Telegram「大图在上」的那种形状）：左侧一条强调色竖条
// 从截图一直贯到文字，右侧依次是页面截图、站点名（强调色）、标题（粗）、描述（灰，可选）。
// 顺序是所有者定的：内容在上、卡在下——只重做样子，不换顺序。
//
// 为什么把它从 main.js 拆出来：这块是纯字符串拼接，拆出来能在 Node 里真渲染一次核对结构，
// 也能让官网 / 预览夹具用同一份实现，而不是各抄一份 DOM 再漂开。
//
// 截图默认按 380px 高度裁掉下半截（object-fit: cover，顶部对齐），点击媒体区展开成完整一张；
// 展开状态只是一个 class，样式在 app.css 的 .browser-link-card__media.is-expanded。

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

/**
 * @param {{url?: string, title?: string, description?: string, screenshot?: string}} state
 *   浏览器工具返回的页面状态；screenshot 是 data URL。
 * @param {(s: string) => string} escHtml 调用方的 HTML 转义。
 * @returns {string} 一段可直接塞进 .atc-viewport 的 HTML；什么都没有时返回空串。
 */
export function browserLinkCardHtml(state, escHtml) {
  const esc = typeof escHtml === "function" ? escHtml : (s) => String(s);
  const shot = String(state?.screenshot || "");
  const url = String(state?.url || "").trim();
  const title = String(state?.title || "").trim();
  const desc = String(state?.description || state?.meta_description || "").trim();
  const host = hostOf(url);
  const media = shot
    ? `<div class="browser-link-card__media" title="点击展开 / 收起完整截图"><img src="${esc(shot)}" alt="页面截图" decoding="async"></div>`
    : "";
  if (!host && !title) {
    // 纯截图（screenshot 动作、或页面没给出 URL/标题）：只画媒体块，不画空的文字行。
    return media ? `<div class="browser-link-card browser-link-card--bare">${media}</div>` : "";
  }
  const rows = [
    host ? `<span class="browser-link-card__site">${esc(host)}</span>` : "",
    // 标题缺失或和主机名一样时只画站点名那一行，否则两行渲染出一模一样的字，像重复了一遍。
    title && title !== host ? `<span class="browser-link-card__title">${esc(title)}</span>` : "",
    desc ? `<span class="browser-link-card__desc">${esc(desc)}</span>` : "",
  ].join("");
  return `<div class="browser-link-card"><div class="browser-link-card__bar"></div>`
    + `<div class="browser-link-card__body">${media}${rows}</div></div>`;
}

/** 给媒体块装上「点一下展开完整截图」；重复调用是幂等的。 */
export function bindBrowserLinkCardMedia(root) {
  const media = root && typeof root.querySelector === "function" ? root.querySelector(".browser-link-card__media") : null;
  if (!media || media.dataset.expandBound === "1") return false;
  media.dataset.expandBound = "1";
  media.addEventListener("click", () => { media.classList.toggle("is-expanded"); });
  return true;
}
