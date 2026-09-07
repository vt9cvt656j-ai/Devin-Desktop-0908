// 浏览器结果的链接预览卡：形状按 Telegram——竖条 | 站点名 / 标题 / 描述 / 截图。
// 真渲染一次核结构（node-html-parser 是仓库里现成的），main.js 的调用点只用源码断言守着。
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import { browserLinkCardHtml, hostOf, bindBrowserLinkCardMedia } from "../src/agent/browser-link-card.js";
import { CODE as SRC } from "./helpers/source.mjs";
import { readFileSync } from "node:fs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SHOT = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const dom = (html) => parse(`<div id="vp">${html}</div>`).querySelector("#vp");
const classes = (el) => String(el.getAttribute("class") || "");

test("截图在上、站点名和标题在下，竖条独立成列贯穿整块", () => {
  const vp = dom(browserLinkCardHtml({ url: "https://new.xianbao.fun/a?b=1", title: "线报酷 - 专注线报活动", screenshot: SHOT }, esc));
  const card = vp.querySelector(".browser-link-card");
  assert.ok(card && !classes(card).includes("browser-link-card--bare"));
  assert.equal(classes(card.childNodes.filter((n) => n.tagName)[0]), "browser-link-card__bar");
  const body = card.querySelector(".browser-link-card__body");
  assert.deepEqual(body.childNodes.filter((n) => n.tagName).map(classes),
    ["browser-link-card__media", "browser-link-card__site", "browser-link-card__title"]);
  assert.equal(body.querySelector(".browser-link-card__site").textContent, "new.xianbao.fun");
  assert.equal(body.querySelector(".browser-link-card__title").textContent, "线报酷 - 专注线报活动");
  assert.equal(body.querySelector("img").getAttribute("src"), SHOT);
});

test("描述可选；标题和主机名一样时不重复画一行；文字要转义", () => {
  const withDesc = dom(browserLinkCardHtml({ url: "https://a.b/", title: "T", description: "d <b>x</b>", screenshot: SHOT }, esc));
  assert.equal(withDesc.querySelector(".browser-link-card__desc").textContent, "d <b>x</b>");
  assert.equal(withDesc.querySelector(".browser-link-card__desc b"), null, "描述没转义就成了注入口");
  const sameAsHost = dom(browserLinkCardHtml({ url: "https://a.b/", title: "a.b", screenshot: SHOT }, esc));
  assert.equal(sameAsHost.querySelector(".browser-link-card__title"), null);
  const hostile = dom(browserLinkCardHtml({ url: "https://a.b/", title: "<img onerror=1>", screenshot: SHOT }, esc));
  assert.equal(hostile.querySelector(".browser-link-card__title img"), null, "标题没转义就成了注入口");
});

test("纯截图（没有 URL/标题）只画媒体块；什么都没有就返回空串", () => {
  const bare = dom(browserLinkCardHtml({ screenshot: SHOT }, esc));
  assert.ok(bare.querySelector(".browser-link-card--bare .browser-link-card__media img"));
  assert.equal(bare.querySelector(".browser-link-card__bar"), null);
  assert.equal(browserLinkCardHtml({}, esc), "");
  assert.equal(hostOf("not a url"), "not a url");
  assert.equal(hostOf("https://x.y.z/path"), "x.y.z");
});

test("点一下媒体块切换展开，重复绑定不叠加", () => {
  // 最小的假元素：只要 dataset / classList / addEventListener 三样，不用整个 DOM。
  const handlers = [];
  const media = {
    dataset: {},
    classList: { _s: new Set(), toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(_type, fn) { handlers.push(fn); },
  };
  const root = { querySelector: (sel) => (sel === ".browser-link-card__media" ? media : null) };
  assert.equal(bindBrowserLinkCardMedia(root), true);
  assert.equal(bindBrowserLinkCardMedia(root), false, "第二次绑定应当被幂等标记挡住");
  assert.equal(handlers.length, 1);
  handlers[0]();
  assert.ok(media.classList.contains("is-expanded"));
  handlers[0]();
  assert.ok(!media.classList.contains("is-expanded"));
  assert.equal(bindBrowserLinkCardMedia(null), false);
});

test("main.js 的浏览器结果视口用的就是这份实现，旧的 browser-url-card 不再存在", () => {
  assert.match(SRC, /browserLinkCardHtml\(state, _escHtml\)/, "浏览器结果没走链接预览卡");
  assert.match(SRC, /bindBrowserLinkCardMedia\(vp\)/, "截图的展开/收起没绑上");
  assert.doesNotMatch(SRC, /browser-url-card/, "旧卡片的 DOM 还在，两套样式会打架");
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  for (const sel of [".browser-link-card__bar", ".browser-link-card__site", ".browser-link-card__title", ".browser-link-card__desc", ".browser-link-card__media.is-expanded"]) {
    assert.ok(css.includes(sel), `app.css 少了 ${sel}`);
  }
  assert.doesNotMatch(css, /\.browser-url-card/, "旧卡片的样式还留着");
});
