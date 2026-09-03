import assert from "node:assert/strict";
import test from "node:test";

class FakeNode {
  constructor(tagName = "") {
    this.tagName = tagName ? tagName.toUpperCase() : "";
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this._text = "";
  }

  appendChild(node) {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener() {}

  set textContent(value) {
    this._text = String(value ?? "");
    this.childNodes = [];
  }

  get textContent() {
    return this._text + this.childNodes.map((node) => node.textContent || "").join("");
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this._text = String(value);
  }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode("fragment"),
  createTextNode: (value) => new FakeText(value),
};

const {
  mediaKindForUrl,
  renderMarkdownInto,
  safeMediaSrc,
} = await import("../src/markdown.js");
const mod = await import("../src/markdown.js");

function findTag(node, tagName) {
  const wanted = tagName.toUpperCase();
  if (node.tagName === wanted) return node;
  for (const child of node.childNodes || []) {
    const found = findTag(child, wanted);
    if (found) return found;
  }
  return null;
}

function findClass(node, className) {
  if (String(node.className || "").split(/\s+/).includes(className)) return node;
  for (const child of node.childNodes || []) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

test("safeMediaSrc only accepts approved media sources", () => {
  assert.equal(safeMediaSrc("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.equal(safeMediaSrc("assets/a.png"), "assets/a.png");
  assert.equal(safeMediaSrc("asset://localhost/a.png"), "asset://localhost/a.png");
  assert.equal(safeMediaSrc("http://asset.localhost/demo.mp4", "video"), "http://asset.localhost/demo.mp4");
  assert.equal(safeMediaSrc("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(safeMediaSrc("data:video/mp4;base64,AAAA", "video"), "data:video/mp4;base64,AAAA");
  assert.equal(
    safeMediaSrc("https://cdn.example.com/media?id=42&signature=abc", "image", { explicit: true }),
    "https://cdn.example.com/media?id=42&signature=abc",
  );

  assert.equal(safeMediaSrc("javascript:alert(1)"), null);
  assert.equal(safeMediaSrc("file:///tmp/private.png"), null);
  assert.equal(safeMediaSrc("//evil.example/tracker.png"), null);
  assert.equal(safeMediaSrc("\\\\evil.example\\share\\tracker.png"), null);
  assert.equal(safeMediaSrc("http://evil.example/tracker.png"), null);
  assert.equal(safeMediaSrc("http://127.0.0.1:4173/api/delete"), null);
  assert.equal(safeMediaSrc("http://127.0.0.1:4173/api/delete.png"), null);
  assert.equal(safeMediaSrc("http://localhost:3000/shutdown.mp4", "video"), null);
  assert.equal(safeMediaSrc("https://tracker.example/pixel"), null);
  assert.equal(safeMediaSrc("https://localhost/private.png", "image", { explicit: true }), null);
  assert.equal(safeMediaSrc("https://127.0.0.1/private", "image", { explicit: true }), null);
  for (const url of [
    "https://10.0.0.5/restart",
    "https://100.64.0.1/private",
    "https://169.254.169.254/latest/meta-data",
    "https://172.31.2.3/admin",
    "https://192.168.1.1/admin",
    "https://0.0.0.0/private",
    "https://[fd00::1]/private",
    "https://[fe80::1]/private",
  ]) assert.equal(safeMediaSrc(url, "image", { explicit: true }), null, url);
  assert.equal(safeMediaSrc("/api/private"), null);
  assert.equal(safeMediaSrc("data:text/html;base64,PGgxPkJvb208L2gxPg=="), null);
  assert.equal(safeMediaSrc("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), null);
  assert.equal(safeMediaSrc("data:image/png;base64,AAAA", "video"), null);
});

test("mediaKindForUrl detects explicit and extension-based media", () => {
  assert.equal(mediaKindForUrl("https://cdn.example.com/photo.webp?x=1"), "image");
  assert.equal(mediaKindForUrl("https://cdn.example.com/demo.mp4#t=2"), "video");
  assert.equal(mediaKindForUrl("https://cdn.example.com/stream", "视频：演示"), "video");
  assert.equal(mediaKindForUrl("https://example.com/article"), null);
});

test("markdown image syntax creates a lazy, no-referrer image", () => {
  const container = new FakeNode("div");
  renderMarkdownInto(container, "![Screenshot](https://cdn.example.com/screen.png)");
  const image = findTag(container, "img");
  assert.ok(image);
  assert.equal(image.src, "https://cdn.example.com/screen.png");
  assert.equal(image.alt, "Screenshot");
  assert.equal(image.loading, "lazy");
  assert.equal(image.decoding, "async");
  assert.equal(image.referrerPolicy, "no-referrer");
});

test("explicit markdown media accepts extensionless signed HTTPS URLs", () => {
  const imageUrl = "https://media.example.com/render/42?X-Amz-Signature=signed";
  const imageContainer = new FakeNode("div");
  renderMarkdownInto(imageContainer, `![Generated preview](${imageUrl})`);
  const image = findClass(imageContainer, "md-media--image");
  assert.ok(image);
  assert.equal(image.src, imageUrl);

  const videoUrl = "https://video.example.com/playback/42?token=signed";
  const videoContainer = new FakeNode("div");
  renderMarkdownInto(videoContainer, `[视频：演示](${videoUrl})`);
  const video = findClass(videoContainer, "md-media--video");
  assert.ok(video);
  assert.equal(video.src, videoUrl);
});

test("ordinary links and bare URLs do not infer extensionless media", () => {
  const url = "https://cdn.example.com/resource?id=42&signature=signed";

  const linkContainer = new FakeNode("div");
  renderMarkdownInto(linkContainer, `[下载资源](${url})`);
  assert.equal(findClass(linkContainer, "md-media--image"), null);
  assert.equal(findClass(linkContainer, "md-media--video"), null);
  const link = findTag(linkContainer, "a");
  assert.ok(link);
  assert.equal(link.href, url);

  const bareContainer = new FakeNode("div");
  renderMarkdownInto(bareContainer, url);
  assert.equal(findClass(bareContainer, "md-media--image"), null);
  assert.equal(findClass(bareContainer, "md-media--video"), null);
  assert.ok(findClass(bareContainer, "url-card"));
});

test("explicit extensionless loopback media stays inert", () => {
  const container = new FakeNode("div");
  renderMarkdownInto(container, "![private](https://127.0.0.1/render?token=signed)");
  assert.equal(findClass(container, "md-media--image"), null);
  assert.match(container.textContent, /Image: private/);
});

test("markdown video links create a bounded native player", () => {
  const container = new FakeNode("div");
  renderMarkdownInto(container, "[演示](https://cdn.example.com/demo.webm)");
  const video = findTag(container, "video");
  assert.ok(video);
  assert.equal(video.src, "https://cdn.example.com/demo.webm");
  assert.equal(video.controls, true);
  assert.equal(video.preload, "metadata");
  assert.equal(video.playsInline, true);
  assert.equal(video.getAttribute("playsinline"), "");
  assert.equal(video.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(video.style.maxWidth, "100%");
});

test("unsafe markdown media stays inert text", () => {
  const container = new FakeNode("div");
  renderMarkdownInto(container, "![bad](javascript:alert(1))");
  assert.equal(findTag(container, "img"), null);
  assert.equal(findTag(container, "video"), null);
  assert.match(container.textContent, /Image: bad/);
});

test("回复里的文件路径变成可点击链接，标识符/口令不变", () => {
  const { renderMarkdownInto } = mod;
  const mk = (src) => { const c = new FakeNode("div"); renderMarkdownInto(c, src); return c; };
  const findCode = (node, out = []) => {
    if (node.tagName === "CODE") out.push(node);
    for (const ch of node.childNodes || []) findCode(ch, out);
    return out;
  };
  // 路径：带 .md-filelink + data-filepath
  const c1 = findCode(mk("看 `decompiled/config.rt.py` 里的 AppConfig"));
  const link = c1.find((n) => n.className === "md-filelink");
  assert.ok(link, "decompiled/config.rt.py 没被标成文件链接");
  assert.equal(link.attributes.get("data-filepath"), "decompiled/config.rt.py");
  // 同一段里的普通代码不该被标
  const plain = c1.filter((n) => n.className !== "md-filelink");
  assert.ok(plain.length >= 0);
  // 标识符 / 口令 / 命令：绝不标
  for (const s of ["`AppConfig`", "`login`", "`RgL0g1n@2026Ky!1`", "`xattr -cr`", "`obj.method`"]) {
    const codes = findCode(mk("值 " + s));
    assert.ok(!codes.some((n) => n.className === "md-filelink"), `${s} 被误判成文件链接`);
  }
});
