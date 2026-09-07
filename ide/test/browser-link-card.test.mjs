// 浏览器结果的链接预览卡：现代书签卡的形状——截图通栏在上，信息区在下：站点头像 + 站点名 / 标题 / 描述。
// 真渲染一次核结构（node-html-parser 是仓库里现成的），main.js 的调用点只用源码断言守着。
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import { browserLinkCardHtml, hostOf, siteInitial, bindBrowserLinkCard, clipText, TITLE_MAX, DESC_MAX } from "../src/agent/browser-link-card.js";
import { CODE as SRC } from "./helpers/source.mjs";
import { readFileSync } from "node:fs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SHOT = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const dom = (html) => parse(`<div id="vp">${html}</div>`).querySelector("#vp");
const classes = (el) => String(el.getAttribute("class") || "");
const kids = (el) => el.childNodes.filter((n) => n.tagName);

test("截图通栏在上，信息区在下：站点行（头像 + 站点名）、标题、描述；没有竖条", () => {
  const vp = dom(browserLinkCardHtml({ url: "https://new.xianbao.fun/a?b=1", title: "线报酷 - 专注线报活动", description: "每天更新", favicon: "https://new.xianbao.fun/favicon.ico", screenshot: SHOT }, esc));
  const card = vp.querySelector(".browser-link-card");
  assert.ok(card && !classes(card).includes("browser-link-card--bare"));
  assert.deepEqual(kids(card).map(classes), ["browser-link-card__media", "browser-link-card__meta"]);
  const meta = card.querySelector(".browser-link-card__meta");
  assert.deepEqual(kids(meta).map(classes), ["browser-link-card__site", "browser-link-card__title", "browser-link-card__desc"]);
  assert.equal(meta.querySelector(".browser-link-card__host").textContent, "new.xianbao.fun");
  assert.equal(meta.querySelector(".browser-link-card__icon").getAttribute("data-letter"), "N");
  assert.equal(meta.querySelector(".browser-link-card__favicon").getAttribute("src"), "https://new.xianbao.fun/favicon.ico");
  assert.equal(meta.querySelector(".browser-link-card__title").textContent, "线报酷 - 专注线报活动");
  assert.equal(meta.querySelector(".browser-link-card__desc").textContent, "每天更新");
  assert.equal(card.querySelector("img").getAttribute("src"), SHOT, "截图是卡里第一张图");
  assert.equal(vp.querySelector(".browser-link-card__bar"), null, "竖条已经去掉");
});

test("没有 favicon 或地址不是 http(s) 时只留首字母头像；www. 前缀不算首字母", () => {
  const none = dom(browserLinkCardHtml({ url: "https://www.example.org/", title: "T", screenshot: SHOT }, esc));
  assert.equal(none.querySelector(".browser-link-card__favicon"), null);
  assert.equal(none.querySelector(".browser-link-card__icon").getAttribute("data-letter"), "E");
  const bad = dom(browserLinkCardHtml({ url: "https://a.b/", title: "T", favicon: "javascript:alert(1)", screenshot: SHOT }, esc));
  assert.equal(bad.querySelector(".browser-link-card__favicon"), null, "非 http(s) 的图标地址不能进 src");
  const dataIcon = dom(browserLinkCardHtml({ url: "https://a.b/", title: "T", favicon: "data:image/svg+xml;utf8,<svg/>", screenshot: SHOT }, esc));
  assert.ok(dataIcon.querySelector(".browser-link-card__favicon"), "data:image/ 的图标可以进 src");
  assert.equal(siteInitial(""), "∙");
});

test("描述可选；标题和主机名一样时不重复画一行；文字要转义", () => {
  const sameAsHost = dom(browserLinkCardHtml({ url: "https://a.b/", title: "a.b", screenshot: SHOT }, esc));
  assert.equal(sameAsHost.querySelector(".browser-link-card__title"), null);
  assert.equal(sameAsHost.querySelector(".browser-link-card__desc"), null);
  const hostile = dom(browserLinkCardHtml({ url: "https://a.b/", title: "<img onerror=1>", description: "d <b>x</b>", screenshot: SHOT }, esc));
  assert.equal(hostile.querySelector(".browser-link-card__title img"), null, "标题没转义就成了注入口");
  assert.equal(hostile.querySelector(".browser-link-card__desc b"), null, "描述没转义就成了注入口");
});

test("标题、描述过长就截断补「…」：数据层先截到上限，CSS 两行 clamp 再按视觉宽度收口", () => {
  const vp = dom(browserLinkCardHtml({ url: "https://a.b/", title: "标".repeat(TITLE_MAX + 40), description: "描".repeat(DESC_MAX + 200) + "。", screenshot: SHOT }, esc));
  const t = vp.querySelector(".browser-link-card__title").textContent;
  const d = vp.querySelector(".browser-link-card__desc").textContent;
  assert.ok(t.endsWith("…") && Array.from(t).length === TITLE_MAX, "标题该截到上限并以 … 结尾");
  assert.ok(d.endsWith("…") && Array.from(d).length === DESC_MAX, "描述该截到上限并以 … 结尾");
  assert.equal(clipText("刚好", 2), "刚好", "不超上限一个字都不动");
  assert.equal(clipText("到句号为止，再来", 6), "到句号为止…");
  assert.equal(clipText("到句号为止，再来", 7), "到句号为止…", "截断点前面的标点要去掉再补 …");
  assert.equal(clipText("", 5), "");
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf(".browser-link-card__title {"), css.indexOf('[data-theme="dark"] .browser-link-card'));
  assert.equal((block.match(/-webkit-line-clamp: 2/g) || []).length, 2, "标题和描述都要有两行 clamp（WebKit / Blink 在第二行末尾画 …）");
});

test("纯截图（没有 URL/标题）只画媒体块；什么都没有就返回空串", () => {
  const bare = dom(browserLinkCardHtml({ screenshot: SHOT }, esc));
  assert.ok(bare.querySelector(".browser-link-card--bare .browser-link-card__media img"));
  assert.equal(bare.querySelector(".browser-link-card__meta"), null);
  assert.equal(browserLinkCardHtml({}, esc), "");
  assert.equal(hostOf("not a url"), "not a url");
  assert.equal(hostOf("https://x.y.z/path"), "x.y.z");
});

test("绑定：点媒体块切换展开；图标加载失败就摘掉；重复绑定不叠加", () => {
  // 最小的假元素：只要 dataset / classList / addEventListener / parentNode 几样，不用整个 DOM。
  const mk = () => ({ dataset: {}, handlers: {}, classList: { _s: new Set(), toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); } });
  const media = mk();
  const icon = mk(); let removed = null; icon.parentNode = { removeChild(n) { removed = n; } };
  const root = { querySelector: (sel) => (sel === ".browser-link-card__media" ? media : sel === ".browser-link-card__favicon" ? icon : null) };
  assert.equal(bindBrowserLinkCard(root), true);
  assert.equal(bindBrowserLinkCard(root), false, "第二次绑定应当被幂等标记挡住");
  assert.equal(media.handlers.click.length, 1);
  media.handlers.click[0]();
  assert.ok(media.classList.contains("is-expanded"));
  media.handlers.click[0]();
  assert.ok(!media.classList.contains("is-expanded"));
  assert.equal(icon.handlers.error.length, 1);
  icon.handlers.error[0]();
  assert.equal(removed, icon, "图标加载失败要把 <img> 摘掉，露出首字母");
  assert.equal(bindBrowserLinkCard(null), false);
});

test("main.js 的浏览器结果视口用的就是这份实现，旧的 browser-url-card 不再存在", () => {
  assert.match(SRC, /browserLinkCardHtml\(state, _escHtml\)/, "浏览器结果没走链接预览卡");
  assert.match(SRC, /bindBrowserLinkCard(?:Media)?\(vp\)/, "截图展开 / 图标兜底没绑上");
  assert.doesNotMatch(SRC, /browser-url-card/, "旧卡片的 DOM 还在，两套样式会打架");
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  for (const sel of [".browser-link-card__media.is-expanded", ".browser-link-card__meta", ".browser-link-card__site", ".browser-link-card__icon::before", ".browser-link-card__favicon", ".browser-link-card__title", ".browser-link-card__desc"]) {
    assert.ok(css.includes(sel), `app.css 少了 ${sel}`);
  }
  assert.doesNotMatch(css, /\.browser-url-card|browser-link-card__bar|browser-link-card__body/, "旧卡片/竖条的样式还留着");
  // Rust 侧随页面状态给出 favicon / description，卡片才有头像和描述可画。
  const rs = readFileSync(new URL("../src-tauri/src/browser.rs", import.meta.url), "utf8");
  assert.match(rs, /favicon: Option<String>/, "BrowserState 没有 favicon 字段");
  assert.match(rs, /description: Option<String>/, "BrowserState 没有 description 字段");
  assert.match(rs, /fn page_favicon\(/, "favicon 没有在页面里求值");
  // 站点图标要用网站真实的：Rust 侧把图标字节取回来编成 data URL，卡片不靠 webview 跨站拉图。
  assert.match(rs, /fn favicon_data_url\(/, "站点图标没有在 Rust 侧取回编成 data URL");
  assert.match(rs, /fn sniff_image_mime\(/, "取回的字节没按魔数认图片，HTML 404 页会被当成图标");
});
