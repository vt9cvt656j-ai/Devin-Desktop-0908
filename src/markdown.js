// Lightweight, dependency-free Markdown → DOM renderer for the AI assistant.
//
// Builds real DOM nodes (text is always set via textContent), so it is XSS-safe
// by construction — no innerHTML of model output, link hrefs are scheme-checked.
// Fenced code blocks render as Devin-style "cards" (language/filename header +
// copy button); an optional async `highlighter` paints syntax colors.

// ---- small DOM helpers ----
function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
function txt(s) {
  return document.createTextNode(s);
}
function icon(id, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic " + cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#" + id);
  svg.appendChild(use);
  return svg;
}

// ---- language display names + Monaco ids ----
const LANG_LABEL = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JSX", mjs: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  json: "JSON", html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", less: "Less",
  md: "Markdown", markdown: "Markdown", rs: "Rust", rust: "Rust",
  py: "Python", python: "Python", go: "Go", java: "Java", c: "C", h: "C",
  cpp: "C++", "c++": "C++", cc: "C++", cs: "C#", csharp: "C#",
  rb: "Ruby", ruby: "Ruby", php: "PHP", swift: "Swift", kt: "Kotlin", kotlin: "Kotlin",
  sh: "Shell", bash: "Bash", zsh: "Shell", shell: "Shell", console: "Shell",
  yml: "YAML", yaml: "YAML", toml: "TOML", ini: "INI", sql: "SQL",
  dockerfile: "Dockerfile", diff: "Diff", text: "Text", txt: "Text", plaintext: "Text",
};
const LANG_MONACO = {
  js: "javascript", javascript: "javascript", jsx: "javascript", mjs: "javascript",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  json: "json", html: "html", xml: "xml", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", rs: "rust", rust: "rust",
  py: "python", python: "python", go: "go", java: "java", c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", cs: "csharp", csharp: "csharp",
  rb: "ruby", ruby: "ruby", php: "php", swift: "swift", kt: "kotlin", kotlin: "kotlin",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
  dockerfile: "dockerfile", diff: "plaintext",
};

export function langLabel(lang) {
  const k = (lang || "").toLowerCase();
  return LANG_LABEL[k] || (lang ? lang.toUpperCase() : "Text");
}

// ---- per-language brand icons (inline SVG, brand colors) ----
// Keyed by the Monaco language id (after alias normalization). Each entry is the
// inner SVG markup for a 16x16 viewBox; unknown languages fall back to the
// generic "</>" sprite icon.
const _badge = (bg, text, fg = "#fff", fs = 6.5) =>
  `<rect x="1" y="1" width="14" height="14" rx="3" fill="${bg}"/><text x="8" y="11" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="${fs}" font-weight="700" fill="${fg}">${text}</text>`;
const LANG_ICON = {
  javascript: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#F7DF1E"/><text x="8" y="11.5" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="7" font-weight="800" fill="#000">JS</text>`,
  typescript: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#3178C6"/><text x="8" y="11.5" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="7" font-weight="800" fill="#fff">TS</text>`,
  rust: `<circle cx="8" cy="8" r="6.6" fill="none" stroke="#CE422B" stroke-width="1.5" stroke-dasharray="2.2 1.1"/><circle cx="8" cy="8" r="4.2" fill="#CE422B"/><text x="8" y="10.6" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="6.5" font-weight="800" fill="#fff">R</text>`,
  python: `<path d="M7.9 1.5c-2 0-3.3.9-3.3 2.4v1.6h3.5v.6H3.3c-1.3 0-2 1.2-2 2.9 0 1.6.7 2.9 2 2.9h1.3V9.7c0-1.3 1.1-2.3 2.4-2.3h3c1.1 0 2-.9 2-2V3.9c0-1.5-1.3-2.4-3.1-2.4h-1zm-1 1.3a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4z" fill="#3776AB"/><path d="M8.1 14.5c2 0 3.3-.9 3.3-2.4v-1.6H7.9v-.6h4.8c1.3 0 2-1.2 2-2.9 0-1.6-.7-2.9-2-2.9h-1.3v2.2c0 1.3-1.1 2.3-2.4 2.3H6c-1.1 0-2 .9-2 2v1.5c0 1.5 1.3 2.4 3.1 2.4h1zm1-1.3a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z" fill="#FFD43B"/>`,
  go: _badge("#00ADD8", "GO", "#fff", 6.5),
  java: _badge("#EA2D2E", "J", "#fff", 8),
  c: _badge("#5C6BC0", "C", "#fff", 8),
  cpp: _badge("#00599C", "C++", "#fff", 5.5),
  csharp: _badge("#68217A", "C#", "#fff", 6.5),
  ruby: `<path d="M8 1.6 13.9 5v6L8 14.4 2.1 11V5L8 1.6z" fill="#CC342D"/><path d="M8 1.6 13.9 5 8 8.2 2.1 5 8 1.6z" fill="#E0574F"/>`,
  php: _badge("#777BB4", "php", "#fff", 5.5),
  swift: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#F05138"/><path d="M11.6 10.4c.9-1.7.6-3.7-.6-5.4.9 1 1.3 2.3 1.1 3.5C13.4 9.7 13 11.6 13 11.6s-1-.6-1.9-.5c-.8.7-2 .9-3.2.5-1.6-.6-3-2-3.9-3.6 1 .8 2.2 1.5 3.3 1.8C5.9 8.7 4.8 7.2 4.1 5.9c1.5 1.4 3.1 2.5 4.6 3.2-1-1.2-2-2.7-2.7-4 1.9 1.9 3.9 3.5 5 4.2l.6 1.1z" fill="#fff"/>`,
  kotlin: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#7F52FF"/><path d="M3.5 3.5h9L8 8l4.5 4.5h-9v-9z" fill="#fff" opacity=".9"/>`,
  html: `<path d="M2.5 1.5h11l-1 12L8 14.7l-4.5-1.2-1-12z" fill="#E44D26"/><path d="M8 2.6v11l3.6-1L12.5 2.6H8z" fill="#F16529"/><path d="M5 4.5h6l-.15 1.5H6.6l.1 1.5h4l-.4 4-2.3.7-2.3-.7-.15-1.7h1.5l.08.9 1 .3 1-.3.1-1.7H4.8L4.5 4.5z" fill="#fff" opacity=".95"/>`,
  css: `<path d="M2.5 1.5h11l-1 12L8 14.7l-4.5-1.2-1-12z" fill="#1572B6"/><path d="M8 2.6v11l3.6-1L12.5 2.6H8z" fill="#33A9DC"/><path d="M5 4.5h6l-.15 1.5H6.6l.1 1.5h4l-.4 4-2.3.7-2.3-.7-.15-1.7h1.5l.08.9 1 .3 1-.3.1-1.7H4.8L4.5 4.5z" fill="#fff" opacity=".95"/>`,
  scss: _badge("#CD6799", "S", "#fff", 8),
  less: _badge("#1D365D", "{L}", "#fff", 5.5),
  json: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#8A8F98"/><text x="8" y="11.5" text-anchor="middle" font-family="var(--mono,monospace)" font-size="8" font-weight="700" fill="#fff">{}</text>`,
  xml: _badge("#F60", "XML", "#fff", 5),
  yaml: _badge("#CB171E", "Y", "#fff", 8),
  ini: `<rect x="1" y="1" width="14" height="14" rx="3" fill="#6E7781"/><circle cx="8" cy="8" r="4" fill="none" stroke="#fff" stroke-width="1.3" stroke-dasharray="1.6 1.4"/><circle cx="8" cy="8" r="1.6" fill="#fff"/>`,
  markdown: `<rect x="1" y="3" width="14" height="10" rx="2" fill="none" stroke="#57606A" stroke-width="1.3"/><path d="M3.5 10.5v-5l2 2.2 2-2.2v5M11.5 5.5v3.4m0 0L10 7.5m1.5 1.4L13 7.5" fill="none" stroke="#57606A" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  shell: `<rect x="1" y="2" width="14" height="12" rx="2.5" fill="#2B3137"/><path d="M4 6l2.2 2L4 10" fill="none" stroke="#4AF626" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10.5h4" stroke="#4AF626" stroke-width="1.4" stroke-linecap="round"/>`,
  sql: `<ellipse cx="8" cy="3.8" rx="5.5" ry="2.3" fill="#336791"/><path d="M2.5 3.8v8.4c0 1.3 2.5 2.3 5.5 2.3s5.5-1 5.5-2.3V3.8c0 1.3-2.5 2.3-5.5 2.3s-5.5-1-5.5-2.3z" fill="#336791" opacity=".75"/>`,
  dockerfile: `<rect x="1.5" y="7" width="3" height="3" fill="#2496ED"/><rect x="5" y="7" width="3" height="3" fill="#2496ED"/><rect x="8.5" y="7" width="3" height="3" fill="#2496ED"/><rect x="5" y="3.5" width="3" height="3" fill="#2496ED"/><rect x="8.5" y="3.5" width="3" height="3" fill="#2496ED"/><path d="M1 11h13.5c-.5 2-2.5 3.5-6.5 3.5S1.7 13 1 11z" fill="#2496ED"/>`,
};

/** Return a 16x16 SVG element with the language's brand icon (fallback: sprite "</>"). */
export function langIcon(lang) {
  const inner = LANG_ICON[monacoLang(lang)] || (lang && LANG_ICON[String(lang).toLowerCase()]);
  if (!inner) return icon("i-code");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic lang-ic");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = inner;
  return svg;
}
export function monacoLang(lang) {
  return LANG_MONACO[(lang || "").toLowerCase()] || "plaintext";
}

// ---- inline parsing ----
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
function safeHref(url) {
  const u = (url || "").trim();
  if (!u) return null;
  if (u.startsWith("#") || u.startsWith("/") || u.startsWith("./") || u.startsWith("../")) return u;
  if (SAFE_SCHEME.test(u)) return u;
  // bare "example.com/..." → treat as https
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(u)) return "https://" + u;
  return null;
}

const IMAGE_EXT = /\.(?:avif|bmp|gif|ico|jpe?g|png|webp)(?:[?#].*)?$/i;
const VIDEO_EXT = /\.(?:m4v|mov|mp4|ogv|webm)(?:[?#].*)?$/i;
const SAFE_IMAGE_DATA = /^data:image\/(?:avif|bmp|gif|x-icon|vnd\.microsoft\.icon|jpeg|png|webp);base64,/i;
const SAFE_VIDEO_DATA = /^data:video\/(?:mp4|webm|ogg|quicktime|x-m4v);base64,/i;

function isRestrictedMediaHost(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || hostname.endsWith(".lan")
      || hostname.endsWith(".home.arpa")) return true;
    // Literal IPv6 hosts are never needed for signed CDN media. Rejecting all of
    // them also covers loopback, ULA, link-local, multicast, and IPv4-mapped forms.
    if (hostname.includes(":")) return true;
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!match) return false;
    const octets = match.slice(1).map(Number);
    if (octets.some((value) => value < 0 || value > 255)) return true;
    const [a, b] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  } catch {
    return true;
  }
}

/**
 * Return a media URL only when its source is safe to load inside the chat.
 * Remote media must use HTTPS; HTTP is limited to Tauri's internal asset host.
 * Data URLs are restricted to known raster/video MIME
 * types so HTML, SVG, and arbitrary executable payloads never become media.
 * Explicit Markdown media may use extensionless HTTPS URLs (for signed/CDN
 * endpoints); inferred media still requires a recognized file extension.
 */
export function safeMediaSrc(url, kind = "image", { explicit = false } = {}) {
  const u = String(url || "").trim();
  if (!u || u.startsWith("//")) return null;
  const expectedExtension = kind === "video" ? VIDEO_EXT : IMAGE_EXT;
  if (u.startsWith("/") || u.startsWith("./") || u.startsWith("../")) return expectedExtension.test(u) ? u : null;
  if (/^https:/i.test(u)) {
    if (isRestrictedMediaHost(u)) return null;
    return explicit || expectedExtension.test(u) ? u : null;
  }
  if (/^blob:/i.test(u) || /^asset:/i.test(u)) return u;
  if (/^http:\/\/asset\.localhost(?::\d+)?(?:\/|$)/i.test(u)) return u;
  if (kind === "video" ? SAFE_VIDEO_DATA.test(u) : SAFE_IMAGE_DATA.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(u) && expectedExtension.test(u)) return "https://" + u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && !/[\\\u0000-\u001f\u007f]/.test(u) && expectedExtension.test(u)) return u;
  return null;
}

/** Detect a media link without treating every ordinary URL as an image. */
export function mediaKindForUrl(url, label = "") {
  const u = String(url || "").trim();
  const hint = String(label || "").trim();
  if (/^data:video\//i.test(u) || VIDEO_EXT.test(u) || /^(?:video|视频)(?:\s*[:：-]|$)/i.test(hint)) return "video";
  if (/^data:image\//i.test(u) || IMAGE_EXT.test(u) || /^(?:image|img|图片|图像)(?:\s*[:：-]|$)/i.test(hint)) return "image";
  return null;
}

function hasExplicitMediaLabel(label) {
  return /^(?:video|视频|image|img|图片|图像)(?:\s*[:：-]|$)/i.test(String(label || "").trim());
}

function mediaNode(kind, url, label, { explicit = false } = {}) {
  const src = safeMediaSrc(url, kind, { explicit });
  const fallback = `${kind === "video" ? "Video" : "Image"}: ${label || url || "media"}`;
  if (!src) return txt(fallback);
  if (kind === "video") {
    const video = el("video", "md-media md-media--video");
    video.src = src;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("referrerpolicy", "no-referrer");
    video.setAttribute("aria-label", label || "Video");
    video.style.maxWidth = "100%";
    video.style.display = "block";
    return video;
  }
  const image = el("img", "md-media md-media--image");
  image.src = src;
  image.alt = label || "Image";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  return image;
}

// 已知的代码/文本文件扩展名白名单——只在**没有斜杠**的单文件名（`start.command`）上用它，
// 避免把 `obj.method`、`Class.attr` 当成文件。带斜杠的（`a/b.py`）明确是路径，任意扩展都收。
const FILE_EXTS = new Set([
  "py", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "jsonc", "txt", "md", "mdx",
  "rs", "go", "java", "kt", "kts", "c", "cc", "cpp", "cxx", "h", "hpp", "cs", "rb",
  "php", "swift", "m", "mm", "css", "scss", "sass", "less", "html", "htm", "xml",
  "vue", "svelte", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "lock",
  "sh", "bash", "zsh", "fish", "command", "ps1", "bat", "sql", "csv", "tsv",
  "proto", "graphql", "gradle", "make", "mk", "dockerfile", "lua", "r", "dart",
  "gitignore", "npmrc", "editorconfig", "config",
]);

/** 保守判断一段行内代码是不是"可点开的文件路径"。宁可漏，不可把标识符/口令误判成文件。 */
function looksLikeFilePath(s) {
  if (typeof s !== "string") return false;
  s = s.trim();
  if (!s || s.length > 240) return false;
  // 整段只能由路径字符构成：字母数字、`_ . / -`、`~`。含空格/括号/@/! 等一律不是路径。
  if (!/^~?[A-Za-z0-9_./-]+$/.test(s)) return false;
  if (s.includes("..") || s.endsWith("/")) return false;
  const last = s.split("/").pop();
  const dot = last.lastIndexOf(".");
  // 末段必须有扩展名（点在中间，不是开头点文件除非它本身在白名单里，如 .gitignore）。
  if (dot <= 0) {
    return last.startsWith(".") && FILE_EXTS.has(last.slice(1).toLowerCase());
  }
  const ext = last.slice(dot + 1).toLowerCase();
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return false;
  // 带斜杠 = 明确路径，任意扩展；无斜杠 = 单文件名，扩展必须在白名单里。
  return s.includes("/") ? true : FILE_EXTS.has(ext);
}

// Inline token matchers, tried by earliest start index (ties: order below).
const INLINE = [
  { // inline code `...`
    re: /(`+)([\s\S]*?[^`]|[^`])\1(?!`)/,
    make: (m) => {
      let code = m[2];
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
        code = code.slice(1, -1);
      }
      const c = el("code");
      c.textContent = code;
      // 回复里形如 `decompiled/config.rt.py` 的路径变成可点开的链接（悬浮蓝、点击左侧
      // 编辑器打开）。判据保守：整段只能是路径字符、末段必须带扩展名——把 `login`、
      // `AppConfig`、`RgL0g1n@2026Ky!1`、`xattr -cr` 这类标识符/口令/命令排除在外。
      // 只打标记（class + data-filepath），真正的打开在 main.js 的 chatEl 点击委托里做，
      // 这个模块要能被 node --test 直接加载，不能依赖 openFile。
      if (looksLikeFilePath(code)) {
        c.className = "md-filelink";
        // 用 setAttribute 而不是 c.dataset.filepath：浏览器里 element.dataset.filepath
        // 会照样读回这个 data-filepath，而测试台的 FakeNode 没有 dataset、只有 setAttribute。
        c.setAttribute("data-filepath", code);
      }
      return c;
    },
  },
  { // strikethrough ~~...~~
    re: /~~(?=\S)([\s\S]*?\S)~~/,
    make: (m) => withChildren(el("del"), m[1]),
  },
  { // bold **...** or __...__
    re: /\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![A-Za-z0-9])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/,
    make: (m) => withChildren(el("strong"), m[1] ?? m[2]),
  },
  { // italic *...* or _..._
    re: /\*(?=\S)([\s\S]*?\S)\*|(?<![A-Za-z0-9])_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/,
    make: (m) => withChildren(el("em"), m[1] ?? m[2]),
  },
  { // image/video embed: ![alt](url); video is detected by extension or a "video:" label
    re: /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/,
    make: (m) => {
      const kind = mediaKindForUrl(m[2], m[1]) || "image";
      return mediaNode(kind, m[2], m[1], { explicit: true });
    },
  },
  { // link [text](url)
    re: /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/,
    make: (m) => {
      const kind = mediaKindForUrl(m[2], m[1]);
      if (kind) return mediaNode(kind, m[2], m[1], { explicit: hasExplicitMediaLabel(m[1]) });
      const href = safeHref(m[2]);
      if (!href) return withChildren(el("span"), m[1]);
      const a = el("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.appendChild(frag(parseInline(m[1])));
      return a;
    },
  },
  { // autolink <https://...>
    re: /<((?:https?:\/\/|mailto:)[^>\s]+)>/,
    make: (m) => /^mailto:/i.test(m[1]) ? linkNode(m[1], m[1]) : urlCardNode(m[1]),
  },
  { // bare url
    re: /(?<![\w@/"'(=])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)\]}'"])/,
    make: (m) => urlCardNode(m[1]),
  },
];

function linkNode(text, url) {
  const href = safeHref(url);
  if (!href) return txt(text);
  const a = el("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.textContent = text;
  return a;
}

function urlCardNode(url) {
  const kind = mediaKindForUrl(url);
  if (kind) return mediaNode(kind, url, "");
  const href = safeHref(url);
  if (!href) return txt(url);
  let domain;
  try { domain = new URL(href).hostname.replace(/^www\./, ""); }
  catch { domain = href; }

  const card = el("a", "url-card");
  card.href = href;
  card.target = "_blank";
  card.rel = "noreferrer noopener";

  const ico = el("img", "url-card__ico");
  ico.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  ico.width = 16; ico.height = 16; ico.alt = "";
  ico.loading = "lazy";
  ico.onerror = function () { this.style.display = "none"; };
  card.appendChild(ico);

  const body = el("span", "url-card__body");
  const site = el("span", "url-card__site");
  site.textContent = domain;
  body.appendChild(site);
  let display = url;
  if (display.length > 60) display = display.slice(0, 57) + "…";
  const path = el("span", "url-card__path");
  path.textContent = display;
  body.appendChild(path);
  card.appendChild(body);

  const arrow = el("span", "url-card__arrow");
  arrow.textContent = "↗";
  card.appendChild(arrow);

  return card;
}
function withChildren(node, inner) {
  node.appendChild(frag(parseInline(inner)));
  return node;
}
function frag(nodes) {
  const f = document.createDocumentFragment();
  for (const n of nodes) f.appendChild(n);
  return f;
}

/** Parse inline markdown into an array of DOM nodes. Handles \n as <br>. */
function parseInline(text) {
  const out = [];
  let rest = text;
  while (rest.length) {
    let best = null;
    for (let p = 0; p < INLINE.length; p++) {
      const m = INLINE[p].re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) {
        best = { p, m };
        if (m.index === 0) break;
      }
    }
    if (!best) {
      pushText(out, rest);
      break;
    }
    if (best.m.index > 0) pushText(out, rest.slice(0, best.m.index));
    out.push(INLINE[best.p].make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}
// Append text, turning escaped chars into literals and \n into <br>.
function pushText(out, s) {
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, "$1");
  const parts = s.split("\n");
  parts.forEach((part, i) => {
    if (i > 0) out.push(el("br"));
    if (part) out.push(txt(part));
  });
}

// ---- block parsing ----
const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_UL = /^(\s*)[-*+][ \t]+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)+\|?[ \t]*$/;

function indentOf(line) {
  const m = /^(\s*)/.exec(line);
  return m[1].replace(/\t/g, "    ").length;
}
function isBlank(line) {
  return line.trim() === "";
}
function startsBlock(line) {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line) ||
    RE_QUOTE.test(line)
  );
}

/** Render an array of source lines into a DocumentFragment. */
function parseBlocks(lines, ctx) {
  const out = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // fenced code
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      const fenceChar = marker[0];
      const closeRe = new RegExp("^\\s{0,3}\\" + fenceChar + "{" + marker.length + ",}\\s*$");
      const info = fence[3].trim();
      const { lang, filename } = parseFenceInfo(info);
      const buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.appendChild(codeCard(buf.join("\n"), lang, filename, ctx));
      continue;
    }

    // heading
    const h = RE_HEADING.exec(line);
    if (h) {
      const node = el("h" + h[1].length);
      node.appendChild(frag(parseInline((h[2] || "").trim())));
      out.appendChild(node);
      i++;
      continue;
    }

    // horizontal rule
    if (RE_HR.test(line)) {
      out.appendChild(el("hr"));
      i++;
      continue;
    }

    // table
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const res = parseTable(lines, i);
      out.appendChild(res.node);
      i = res.next;
      continue;
    }

    // blockquote
    if (RE_QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (!isBlank(lines[i]) && !startsBlock(lines[i]) && inner.length))) {
        const qm = RE_QUOTE.exec(lines[i]);
        inner.push(qm ? qm[1] : lines[i].trim());
        i++;
      }
      const bq = el("blockquote");
      bq.appendChild(parseBlocks(inner, ctx));
      out.appendChild(bq);
      continue;
    }

    // lists
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const res = parseList(lines, i, ctx);
      out.appendChild(res.node);
      i = res.next;
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    const p = el("p");
    p.appendChild(frag(parseInline(para.join("\n").trim())));
    out.appendChild(p);
  }
  return out;
}

function parseFenceInfo(info) {
  if (!info) return { lang: "", filename: "" };
  const first = info.split(/\s+/)[0];
  if (first.includes(":")) {
    const idx = first.indexOf(":");
    return { lang: first.slice(0, idx), filename: first.slice(idx + 1) };
  }
  const rest = info.slice(first.length).trim();
  const titleMatch = /title=("?)([^"]+)\1/.exec(rest);
  return { lang: first, filename: titleMatch ? titleMatch[2] : (rest && !rest.includes("=") ? rest : "") };
}

function parseTable(lines, start) {
  const aligns = lines[start + 1]
    .replace(/^\s*\|?/, "")
    .replace(/\|?\s*$/, "")
    .split("|")
    .map((c) => {
      const s = c.trim();
      const l = s.startsWith(":");
      const r = s.endsWith(":");
      return r && l ? "center" : r ? "right" : l ? "left" : "";
    });
  const header = splitRow(lines[start]);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const wrap = el("div", "md-table");
  const table = el("table");
  const thead = el("thead");
  const htr = el("tr");
  header.forEach((cell, c) => {
    const th = el("th");
    if (aligns[c]) th.style.textAlign = aligns[c];
    th.appendChild(frag(parseInline(cell)));
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (let c = 0; c < header.length; c++) {
      const td = el("td");
      if (aligns[c]) td.style.textAlign = aligns[c];
      td.appendChild(frag(parseInline(row[c] || "")));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return { node: wrap, next: i };
}
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

function parseList(lines, start, ctx) {
  const baseIndent = indentOf(lines[start]);
  const ordered = RE_OL.test(lines[start]) && !RE_UL.test(lines[start]);
  const list = el(ordered ? "ol" : "ul");
  if (ordered) {
    const sm = RE_OL.exec(lines[start]);
    if (sm && sm[2] !== "1") list.setAttribute("start", sm[2]);
  }
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) break;
    const ind = indentOf(line);
    if (ind < baseIndent) break;
    const m = RE_UL.exec(line) || RE_OL.exec(line);
    if (!m || ind > baseIndent) break;

    const isOl = !RE_UL.test(line);
    const content = isOl ? m[3] : m[2];
    const contentCol = line.length - content.length;

    const li = el("li");
    let firstText = content;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) {
      li.classList.add("task");
      const box = el("input");
      box.type = "checkbox";
      box.disabled = true;
      box.checked = task[1].toLowerCase() === "x";
      li.appendChild(box);
      firstText = task[2];
    }

    const childLines = [];
    i++;
    while (i < lines.length) {
      const l2 = lines[i];
      if (isBlank(l2)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > baseIndent) {
          for (let k = i; k < j; k++) childLines.push("");
          i = j;
          continue;
        }
        break;
      }
      if (indentOf(l2) > baseIndent) {
        childLines.push(dedent(l2, contentCol));
        i++;
      } else {
        break;
      }
    }
    while (childLines.length && childLines[childLines.length - 1] === "") childLines.pop();

    const subLines = [firstText, ...childLines];
    const onlyInline = !childLines.some((l) => startsBlock(l) || isBlank(l));
    if (!childLines.length) {
      li.appendChild(frag(parseInline(firstText)));
    } else if (onlyInline) {
      li.appendChild(frag(parseInline(subLines.join("\n").trim())));
    } else {
      li.appendChild(parseBlocks(subLines, ctx));
    }
    list.appendChild(li);
  }
  return { node: list, next: i };
}
function dedent(line, cols) {
  let n = 0;
  let removed = 0;
  while (n < line.length && removed < cols && (line[n] === " " || line[n] === "\t")) {
    removed += line[n] === "\t" ? 4 : 1;
    n++;
  }
  return line.slice(n);
}

// ---- code card ----
// A code block longer than this folds to just its header once it is complete. Long code is
// what makes a transcript unscrollable: three 300-line blocks push everything else off the
// page. Folded, each is one row that says what it is and how big — click to open.
const CODE_CARD_FOLD_LINES = 16;
function codeCard(code, lang, filename, ctx) {
  const card = el("div", "code-card");
  card.dataset.lang = monacoLang(lang);

  const head = el("div", "code-card__head");
  const label = el("span", "code-card__lang");
  const lineCount = String(code ?? "").replace(/\n$/, "").split("\n").length;
  const foldable = lineCount > CODE_CARD_FOLD_LINES;
  if (foldable) label.appendChild(el("span", "code-card__chev"));
  label.appendChild(langIcon(lang));
  const labelText = el("span");
  labelText.textContent = filename || langLabel(lang);
  label.appendChild(labelText);
  if (foldable) {
    const meta = el("span", "code-card__meta");
    meta.textContent = `${lineCount} 行`;
    label.appendChild(meta);
  }
  head.appendChild(label);
  const startsFolded = foldable && !(ctx && ctx.streaming);
  if (foldable) {
    card.classList.add("is-foldable");
    // Auto-fold only a COMPLETE block. While the model is still writing the code you must be
    // able to watch it arrive, so a card built during streaming starts open; the final render
    // (streaming:false) rebuilds it folded. Restored history renders folded for the same reason.
    if (startsFolded) card.classList.add("is-folded");
    // 展开/收起由 main.js 里的**事件委托**处理，不在这里绑。两个原因：
    //   1) 会话是靠 innerHTML 快照恢复的，内联监听器在恢复后全部丢失——原来的折叠卡
    //      重开对话后根本点不动（这是个一直存在的老毛病）。
    //   2) 折叠卡的正文是懒加载的，展开时需要拿到 highlightCode，那在 main.js 里。
  }

  const copy = el("button", "code-card__copy");
  copy.type = "button";
  copy.appendChild(icon("i-copy"));
  const copyText = el("span");
  copyText.textContent = "";
  copy.appendChild(copyText);
  copy.addEventListener("click", (event) => {
    event?.stopPropagation?.(); // the head toggles the fold; copying must not also collapse it
    const write = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(code)
      : Promise.reject();
    write
      .then(() => flashCopied(copy, copyText))
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = code;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          flashCopied(copy, copyText);
        } catch {
          copyText.textContent = "Failed";
          setTimeout(() => (copyText.textContent = "Copy"), 1400);
        }
      });
  });
  head.appendChild(copy);
  card.appendChild(head);

  const pre = el("pre", "code-card__body");
  const codeEl = el("code");
  pre.appendChild(codeEl);
  card.appendChild(pre);

  // 折叠态**不把正文放进 DOM**，也不做语法高亮。
  //
  // 折叠原本只是 `display: none`：卡片看不见了，但它的每一行仍然完整挂在 DOM 上，
  // 而且照样跑一遍 Monaco 着色，把一行拆成几十个 span。也就是说"折叠"省的是屏幕，
  // 不是内存——一段长对话里几十张这样的卡加起来，正是内容一多就卡的来源之一。
  //
  // 现在正文先留在 data-code 上（一个字符串，比几万个节点便宜得多），第一次展开时
  // 才建 DOM、才着色。放在 attribute 上而不是闭包里，是因为会话靠 innerHTML 快照
  // 持久化：闭包活不过一次重启，attribute 可以，重开对话后照样能展开。
  if (startsFolded) {
    card.dataset.code = code;
  } else {
    codeEl.textContent = code;
    if (ctx && typeof ctx.highlighter === "function" && code.trim()) {
      const mono = monacoLang(lang);
      if (mono !== "plaintext") {
        ctx.highlighter(code, mono)
          .then((html) => {
            if (html) codeEl.innerHTML = html;
          })
          .catch(() => {});
      }
    }
  }
  return card;
}
function flashCopied(btn, label) {
  btn.classList.add("is-copied");
  label.textContent = "Copied";
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove("is-copied");
    label.textContent = "Copy";
  }, 1400);
}

// ---- public API ----
/**
 * Render markdown `text` into `container` (replacing its contents).
 * @param {HTMLElement} container
 * @param {string} text
 * @param {{ highlighter?: (code:string, lang:string)=>Promise<string>, streaming?: boolean, showCaret?: boolean }} [opts]
 */
export function renderMarkdownInto(container, text, opts = {}) {
  // A full render supersedes any incremental stream state on this container, so drop it.
  // Without this, __mdStream survives on the finalized element for the life of the chat tab,
  // and it holds strong references to st.chunks[i].nodes — every top-level node the streamed
  // render produced (code cards, images, tables) — which textContent="" merely DETACHES,
  // plus a second full copy of the source text in st.src and the last fence body. Every
  // streamed reply therefore leaked roughly a duplicate of itself. Classic webview OOM.
  container.__mdStream = null;
  container.textContent = "";
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  container.appendChild(parseBlocks(lines, opts));
  if (opts.streaming && opts.showCaret !== false) {
    const caret = el("span", "md-caret");
    container.appendChild(caret);
  }
}

// The end-offset of the last "settled" markdown block: the position after the
// last blank line that is NOT inside a code fence. Everything before it is made
// of complete blocks that won't change as more text streams in.
// INCREMENTAL: the old version re-split the WHOLE accumulated text every frame
// (O(n) allocation per frame → O(n²) over a long reply — a main cause of the
// long-content UI freeze). Scan state lives on the stream state object and each
// call only walks the NEW complete lines since the last call.
function _advanceSettledScan(st, text) {
  let i = st.scanPos || 0;
  for (;;) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) break; // last line still incomplete — scanned once it terminates
    if (nl > i) {
      const line = text.slice(i, nl);
      // 缩进放宽到任意长度（原来是 `\s{0,3}`）。
      //
      // CommonMark 里 ≥4 空格在**顶层**是缩进代码块，但在列表项内部（内容缩进 4）
      // ```` ``` ```` 就是一个正常的围栏。原来那个 0-3 的上限让这种围栏整个匹配不上，
      // 于是 st.inFence 从不置位，代码块**内部的空行**（函数之间空一行，最常见的写法）
      // 被当成块边界，已结算的那半从此永远保持切错的样子。实测：
      //   顶格 / 缩进 2 → boundary 落在代码块之前（对）
      //   缩进 4        → boundary 落在代码块**内部**（错）
      //
      // 放宽只影响 inFence 的跟踪；结算边界仍然只认顶格（下面 `fm[1] === ""`），
      // 所以「从缩进围栏处切块会改变渲染」那条克制原样保留。
      const fm = /^(\s*)(`{3,}|~{3,})/.exec(line);
      if (fm) {
        // **开启一个顶格 fence 也算块边界**，不必等下一个空行。
        //
        // 之前只认「fence 外的空行」，于是模型写 `**train.py**` 紧跟代码块（中间没空行）
        // 时，整段散文和代码块一起留在 tail 里，正在生长的 <pre> 每帧销毁重建。
        // 实测同一份 600 行 Python：紧贴写法 5257 节点 / 4.40MB DOM 文本写入，
        // fence 前多一个空行则是 299 节点 / 0.03MB —— 147 倍。用户看到的就是
        // 「同一个模型、同一类问题，这次流畅下次卡」，找不到规律。
        //
        // 只认**顶格**（`/^(```|~~~)/`，不是上面那个允许缩进的 `\s{0,3}`）：
        // 缩进的 fence 可能在列表项里，从那儿切开会让尾块变成顶层代码块而不是
        // 列表内的代码块——那是渲染变化，不是加速。顶格 fence 在 CommonMark 里
        // 必然能打断段落，所以「散文 + 代码块」拆成两块的渲染结果和不拆完全一样。
        //
        // **fence 的开合要认标记长度**：CommonMark 里收尾标记必须和开头同字符、且不更短。
        // 原来这里是无条件 `st.inFence = !st.inFence`，于是 ````md 里嵌的 ``` 会把外层
        // 提前关掉。以前不出事，是因为从不设边界、整段留在 tail 每帧全量重解析 ——
        // 渲染碰巧是对的。一旦按边界切块，这个跟踪缺陷就变成真实的渲染错误
        // （新增的「嵌套 fence」用例正是这么抓到的）。
        const marker = fm[2];
        if (!st.inFence) {
          st.fenceMark = marker[0];
          st.fenceLen = marker.length;
          if (fm[1] === "") st.boundary = i; // 顶格才结算，理由见上
          st.inFence = true;
        } else if (marker[0] === st.fenceMark && marker.length >= st.fenceLen) {
          st.inFence = false;
        }
      }
      if (!st.inFence && line.trim() === "") st.boundary = nl + 1;
    } else if (!st.inFence) {
      st.boundary = nl + 1; // empty complete line
    }
    i = nl + 1;
  }
  st.scanPos = i;
  return st.boundary || 0;
}

/**
 * Incremental streaming render. Settled blocks (before the last block boundary)
 * are parsed once and left untouched; only the still-growing tail block is
 * re-parsed on each call. This keeps per-frame cost ∝ the current block instead
 * of re-parsing/rebuilding the whole reply every token (which was O(n²) and, with
 * terminal output, froze the UI). Resets to a clean full render if the text
 * diverges from what was committed or the container was modified externally.
 * @param {HTMLElement} container
 * @param {string} text
 * @param {object} [opts]
 */
export function renderMarkdownStream(container, text, opts = {}) {
  // 取证埋点：冻结哨兵按相位归因——流式渲染此前没有独立相位，长任务全被记在
  // agentModelTurn:assemble 名下。经 main.js 挂的 window 桥取用，模块保持零依赖。
  try { globalThis.__midePerfPhase?.("renderMarkdownStream len=" + String(text == null ? "" : text).length); } catch {}
  try { _renderMarkdownStreamCore(container, text, opts); }
  finally { try { globalThis.__midePerfPhase?.("renderMarkdownStream:done"); } catch {} }
}

function _renderMarkdownStreamCore(container, text, opts = {}) {
  text = String(text ?? "").replace(/\r\n?/g, "\n");
  let st = container.__mdStream;
  if (st && st.tail && st.tail.parentNode !== container) st = null; // container touched externally → full reset
  if (st && !text.startsWith(st.src)) {
    // Committed text changed under us — main.js's _cleanAgentText strips narration /
    // filler lines only once they COMPLETE, so its output is not append-only. The old
    // code answered every such divergence with container.textContent = "" plus a full
    // re-parse AND re-highlight of every settled block; on long tool-narrated replies
    // this fired over and over — the remaining O(n²) rebuild behind the streaming
    // freeze. Roll back to the last committed chunk that still matches instead.
    if (!_rollbackStreamChunks(st, text)) st = null;
  }
  if (!st) {
    container.textContent = "";
    st = container.__mdStream = { src: "", tail: null, scanPos: 0, inFence: false, boundary: 0, chunks: [] };
  }
  const settled = _advanceSettledScan(st, text);
  if (settled > st.src.length) {
    const chunk = text.slice(st.src.length, settled);
    // Record the top-level nodes each committed chunk produced, so a later divergence
    // can remove just the invalidated chunks (fragment children spill into the
    // container on insert — snapshot them before that).
    let nodes = [];
    if (chunk.trim()) {
      const node = parseBlocks(chunk.split("\n"), opts);
      nodes = Array.from(node.childNodes);
      if (st.tail) container.insertBefore(node, st.tail);
      else container.appendChild(node);
    }
    st.chunks.push({ end: settled, nodes });
    st.src = text.slice(0, settled);
  }
  const tailText = text.slice(st.src.length);
  if (!st.tail) { st.tail = el("div", "md-stream-tail"); container.appendChild(st.tail); }

  // Nothing new to show. The plain-chat flush loop re-schedules itself on a timer
  // whether or not tokens arrived, so without this roughly half the frames rebuilt
  // an identical tail.
  if (tailText === st.lastTail) return;
  st.lastTail = tailText;

  // Fast path: the tail is one still-open code fence.
  //
  // `_advanceSettledScan` only accepts a blank line *outside* a fence as a block
  // boundary, so while the model is writing a code block the boundary is frozen and
  // the tail keeps growing — for a 40KB file write, every frame cleared the tail and
  // re-parsed all 40KB, then re-laid out a `<pre>` thousands of lines tall. Appending
  // just the new characters to the existing `<code>` keeps per-frame cost proportional
  // to what actually arrived. The fence closes → the normal path takes over and the
  // final full render re-parses and highlights everything, so output is unchanged.
  const open = _openFenceTail(tailText);
  if (open && st.fenceCard && st.fenceInfo === open.info && open.body.startsWith(st.fenceBody)) {
    if (open.body.length > st.fenceBody.length) {
      st.fenceCodeEl.appendChild(document.createTextNode(open.body.slice(st.fenceBody.length)));
      st.fenceBody = open.body;
    }
    return;
  }
  st.fenceCard = st.fenceCodeEl = null;
  st.fenceInfo = st.fenceBody = "";

  st.tail.textContent = "";
  // The tail block is re-parsed every frame — skip the async highlighter there
  // (settled blocks above get it once; the final full render recolors everything).
  if (tailText.trim()) st.tail.appendChild(parseBlocks(tailText.split("\n"), opts.highlighter ? { ...opts, highlighter: undefined } : opts));
  if (opts.streaming && opts.showCaret !== false) st.tail.appendChild(el("span", "md-caret"));

  // Remember the freshly built card so the next frames can append into it.
  if (open) {
    const card = st.tail.querySelector(".code-card");
    const codeEl = card && card.querySelector("pre.code-card__body > code");
    if (codeEl) {
      st.fenceCard = card;
      st.fenceCodeEl = codeEl;
      st.fenceInfo = open.info;
      st.fenceBody = open.body;
    }
  }
}

// Undo committed chunks past the point where `text` diverges from what was rendered:
// keep every chunk that ends inside the common prefix, drop only the DOM of the rest,
// and rewind the settled scan to that boundary (a blank line outside a fence, so
// inFence is false there by construction). Returns false when not even the first
// chunk survives — the caller then falls back to a full reset.
function _rollbackStreamChunks(st, text) {
  const chunks = st.chunks || [];
  const max = Math.min(st.src.length, text.length);
  let p = 0;
  while (p < max && st.src.charCodeAt(p) === text.charCodeAt(p)) p++;
  let keep = 0;
  while (keep < chunks.length && chunks[keep].end <= p) keep++;
  if (!keep) return false;
  for (let i = keep; i < chunks.length; i++) {
    for (const n of chunks[i].nodes) { if (n.parentNode) n.parentNode.removeChild(n); }
  }
  chunks.length = keep;
  const end = chunks[keep - 1].end;
  st.src = st.src.slice(0, end);
  st.scanPos = end;
  st.boundary = end;
  st.inFence = false;
  st.lastTail = undefined; // the tail must rebuild against the new text
  st.fenceCard = st.fenceCodeEl = null;
  st.fenceInfo = st.fenceBody = "";
  return true;
}

/// If `tailText` is exactly one unterminated code fence, describe it: the info string
/// (fence characters + language) and the body accumulated so far. Null otherwise —
/// any prose before the fence means the tail still needs normal block parsing.
function _openFenceTail(tailText) {
  const m = /^\s{0,3}(```+|~~~+)([^\n]*)\n?/.exec(tailText);
  if (!m) return null;
  const rest = tailText.slice(m[0].length);
  const fence = m[1][0];
  // A closing fence anywhere means this is a complete block, not a growing one.
  if (new RegExp("^\\s{0,3}" + fence + "{3,}\\s*$", "m").test(rest)) return null;
  return { info: m[1] + m[2].trim(), body: rest };
}
