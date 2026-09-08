/**
 * SPA page metadata.
 *
 * Google executes JS and will pick these up; crawlers that do not (WeChat,
 * iMessage, most social unfurlers) only see `index.html` — that is why the
 * OG tags also live in the static shell. This helper is for the URLs the
 * SPA actually renders after hydration.
 *
 * Canonical is rewritten to the *current* URL rather than left pointing at
 * `/`. Leaving the homepage canonical on every path would collapse the site
 * into one indexed URL, which is the thing we are trying to stop. The
 * homepage shell still ships `rel=canonical` for `/`; subpages replace that
 * node so a crawler never sees two conflicting canonicals on one document.
 */

export const SITE_ORIGIN = "https://mrday.one";

/** Must stay byte-identical to the `<title>` in `index.html`. */
export const HOME_TITLE =
  "Mr. Day One — The AI-native code editor that reads your whole repo";

/** Must stay byte-identical to the meta description in `index.html`. */
export const HOME_DESCRIPTION =
  "Mr. Day One wires repo indexing, the terminal, and diagnostics into one agent loop: the AI edits your code, runs the tests, reads the errors, and verifies its own work — instead of just handing you a suggestion.";

export function canonicalFor(pathname: string): string {
  if (pathname === "/" || pathname === "") return `${SITE_ORIGIN}/`;
  return `${SITE_ORIGIN}${pathname.replace(/\/$/, "")}`;
}

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  const sel = `meta[${attr}="${key}"]`;
  let el = document.querySelector(sel);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function applyPageMeta(opts: {
  title: string;
  description: string;
  canonical: string;
  /** Omit for the default (index,follow) — we remove the tag rather than write it. */
  robots?: string;
}) {
  document.title = opts.title;
  upsertMeta("name", "description", opts.description);
  upsertMeta("property", "og:title", opts.title);
  upsertMeta("property", "og:description", opts.description);
  upsertMeta("property", "og:url", opts.canonical);
  upsertMeta("name", "twitter:title", opts.title);
  upsertMeta("name", "twitter:description", opts.description);

  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", opts.canonical);

  const existing = document.querySelector('meta[name="robots"]');
  if (opts.robots) {
    const el = existing ?? document.createElement("meta");
    el.setAttribute("name", "robots");
    el.setAttribute("content", opts.robots);
    if (!existing) document.head.appendChild(el);
  } else {
    existing?.remove();
  }
}

/**
 * Pull a meta description from markdown.
 *
 * Headings and fenced code are skipped because they are labels / samples, not
 * the sentence a crawler should quote. Truncated at 155 characters — Google's
 * typical display budget. If the body is only a heading, the caller must
 * supply a fallback.
 */
export function descriptionFromMarkdown(md: string, max = 155): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) {
      if (inFence) {
        inFence = false;
        continue;
      }
      if (parts.length) break;
      inFence = true;
      continue;
    }
    if (inFence) continue;
    if (!t) {
      if (parts.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(t)) continue;
    parts.push(
      t
        .replace(/^>\s?/, "")
        .replace(/!\[[^\]]*]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/[*_`#]/g, ""),
    );
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "").trimEnd()}…`;
}
