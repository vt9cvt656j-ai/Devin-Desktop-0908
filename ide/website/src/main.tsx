import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { GATEWAY } from "@/lib/account";
import { configureMse, mseEnvConfig, mseReady } from "@/lib/mse";
import { installRegionRouting } from "@/lib/region";
import "@/index.css";

/*
 * 地区：写 canonical；美国站上「IP 判成大陆、库里没省份、浏览器是中文」的访客换到备案镜像
 * （硬规则在 nginx 里已经按 IP 做完，这里只补语言那一半）。不等它——绝大多数访客一行网络请求
 * 都不会发，真要跳的那几个也不该先看一次白屏。见 lib/region.ts。
 */
void installRegionRouting().catch(() => {
  /* 地区判断失败就当在美国站，不影响渲染 */
});

/*
 * Application-layer encryption, configured before anything is rendered — and so before any
 * component effect can reach the gateway.
 *
 * `base` has to be spelled out rather than left at the default empty string. Every call
 * this site makes is cross-origin: the pages are served from mrday.one and the API lives on
 * code.mrday.one, which is why `lib/account.ts` prefixes each path with `GATEWAY`. The
 * client's own bootstrap does not go through those call sites, so with the default base it
 * would fetch `/api/crypto/pubkey` from the static host, get the SPA's index.html back, and
 * fail to bootstrap — every request would then quietly go out in plaintext.
 *
 * Started, not awaited. The handshake is a round trip to another host and nothing on the
 * first paint depends on it; blocking render on it would buy nothing and cost a visible
 * delay. The catch is not indifference — a failed bootstrap is retried by the first sealed
 * request that needs it, and swallowing it here only keeps an unhandled rejection out of
 * the console.
 */
configureMse({ ...mseEnvConfig(), base: GATEWAY });
void mseReady().catch(() => {
  /* retried by the first sealed request */
});

/*
 * A visit to the bare address starts at the top of the page.
 *
 * Browsers restore the scroll offset you left a URL at, and on a page this tall that
 * drops you somewhere in the middle with no explanation — you asked for the front page
 * and got the architecture section. Worse, the stylesheet sets `scroll-behavior: smooth`
 * on the root, so the restore is *animated*: the page appears to scroll itself downwards
 * for a second after it loads, which reads as a bug rather than as a browser feature.
 *
 * "manual" hands that decision back to us: no hash means the top, a hash means that
 * section. Smooth scrolling is kept for clicking the nav, where it is wanted — the jump
 * below is explicitly instant so the page never animates on arrival.
 *
 * Runs before render so it is set well before the browser would otherwise restore.
 */
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

const INSTANT = "instant" as ScrollBehavior;

function jumpTo(target: Element) {
  target.scrollIntoView({ behavior: INSTANT });
}

/**
 * Put the page where the address says it should be.
 *
 * The awkward part is that the target does not exist yet: every section is rendered by
 * React, so at the moment the document is ready `#architecture` is not in the DOM. Two
 * earlier attempts got this wrong — a single frame's wait, then a sixty-frame budget.
 * Both looked fine locally and both failed in practice, because `requestAnimationFrame`
 * is throttled whenever the page is not actively painting, so the budget expired before
 * React mounted and the fallback dutifully scrolled to the top.
 *
 * A MutationObserver has no such dependency: it fires when the element actually appears,
 * however long that takes. The timeout is a backstop for a hash that names nothing.
 */
function positionOnEntry() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) {
    window.scrollTo({ top: 0, behavior: INSTANT });
    return;
  }

  const existing = document.getElementById(id);
  if (existing) {
    jumpTo(existing);
    settleAfterImages(id);
    return;
  }

  const observer = new MutationObserver(() => {
    const target = document.getElementById(id);
    if (!target) return;
    observer.disconnect();
    clearTimeout(giveUp);
    jumpTo(target);
    settleAfterImages(id);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // A hash pointing at nothing should not leave the observer running for the life of the
  // page. Three seconds is far longer than this app takes to mount.
  const giveUp = setTimeout(() => observer.disconnect(), 3000);
}

/**
 * Land on the section again once the page has stopped growing.
 *
 * The images above the fold have no intrinsic size until they load, so the first jump
 * aims at a position that is still moving — by the time the posters arrive the section
 * has been pushed down and the reader is left above it. Re-aiming on `load` costs one
 * scroll and removes the drift.
 */
function settleAfterImages(id: string) {
  if (document.readyState === "complete") return;
  window.addEventListener(
    "load",
    () => {
      const target = document.getElementById(id);
      if (target) jumpTo(target);
    },
    { once: true },
  );
}

/*
 * In-page navigation scrolls, but does not rewrite the address.
 *
 * The nav is ordinary `<a href="#architecture">` links, so every click used to push that
 * hash into the address bar and into history. That is the actual reason the site "opens
 * at the architecture section": once `mrday.one/#architecture` is in history, typing
 * "mrday.one" autocompletes to it, and the page is then correctly honouring the anchor it
 * was given. No amount of fixing the scroll code helps, because the URL genuinely says
 * that — the address bar had been quietly collecting section links all along.
 *
 * So: scroll, and leave the address alone. The canonical address of this page stays
 * `https://mrday.one/`. Links shared from elsewhere with a `#section` still work — those
 * arrive as a real navigation and are handled on entry above.
 *
 * Delegated from the document so it covers the navbar, the footer and anything added
 * later without each of them needing to know about it.
 */
document.addEventListener("click", (event) => {
  // Anything the app already handled, and every gesture that means "open somewhere else":
  // a modified click or a middle click should keep the browser's own behaviour.
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = (event.target as Element | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || !href || !href.startsWith("#")) return;
  if (anchor.getAttribute("target") === "_blank") return;

  if (href === "#") {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const target = document.getElementById(decodeURIComponent(href.slice(1)));
  // A link to a section that does not exist is left to the browser rather than silently
  // swallowed — better a visible no-op than a dead click this code pretended to handle.
  if (!target) return;

  event.preventDefault();
  scrollToSection(target);
});

/**
 * Smooth where it is available, instant where it is not — but never nothing.
 *
 * Having taken over the click, this code now owns the outcome: if the smooth scroll does
 * not happen the link is simply dead, which is worse than the behaviour it replaced.
 * Smooth scrolling is genuinely absent in some environments — reduced-motion settings,
 * embedded webviews, headless browsers — and it fails silently rather than throwing, so
 * the only way to notice is to look afterwards.
 */
function scrollToSection(target: Element) {
  const from = window.scrollY;
  const to = Math.round(from + target.getBoundingClientRect().top);
  if (Math.abs(to - from) < 2) return; // already there

  target.scrollIntoView({ behavior: "smooth" });
  window.setTimeout(() => {
    if (Math.abs(window.scrollY - from) < 2) {
      window.scrollTo({ top: to, behavior: INSTANT });
    }
  }, 400);
}

/*
 * Not `addEventListener("DOMContentLoaded", …)` on its own.
 *
 * This is a module script, so it is deferred — and by the time it executes the document
 * has often already finished parsing and fired that event. Listening for an event that
 * has been and gone means this never runs at all.
 */
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", positionOnEntry);
} else {
  positionOnEntry();
}

const container = document.getElementById("root");

if (!container) {
  throw new Error("找不到 #root 挂载点，请检查 index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
