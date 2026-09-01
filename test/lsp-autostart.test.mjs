// 语言服务要**全自动**：没起来就自己起，起来之后死了就自己回来。
//
// 用户实拍状态栏一句「LSP: python 未启动」，补全 / 跳转 / 悬浮同时全没有。
// 抓到的真凶不是"没装"——日志里 70ms 内 spawn 了三次 pyright，收场一个进程都不剩：
// 三个 .py 标签页恢复时各发一次 didOpen，三次都通过了 clients.get() 那道**同步**检查，
// 各自 await 一次解释器探测，于是后端收到三次 lsp_start；第 2、3 次撞「already running」
// 走「先 stop 再重试」的恢复分支，stop 掉的正是第 1 次刚起好的那个。
//
// 这一份跑的是真代码：真的并发调、真的发 stopped 事件、真的等退避到点。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lsp-client.js", import.meta.url), "utf8")
  .replace('import * as monaco from "monaco-editor";', "")
  .replace("export function createLspManager", "function createLspManager");

// 「开着」的判据是**真的调过 didOpen**，不是内存里躺着一个 model：这个 IDE 会把项目里
// 所有代码文件预载成 model，照 model 起服务就是打开一个仓库拉起六个语言服务器。
const openModels = [];
const model = (lang, path) => ({
  getLanguageId: () => lang,
  getValue: () => "",
  getVersionId: () => 1,
  uri: { toString: () => `file://${path}`, fsPath: path, path },
  isAttachedToEditor: () => true,
});
const monaco = {
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  languages: new Proxy({ CompletionItemKind: new Proxy({}, { get: (_t, k) => k }) }, {
    get(t, k) {
      if (typeof k === "string" && /^register\w+Provider$/.test(k)) return () => ({ dispose() {} });
      return t[k];
    },
  }),
  Uri: { file: (p) => ({ toString: () => `file://${p}` }), parse: (u) => ({ toString: () => u, fsPath: u.replace(/^file:\/\//, "") }) },
  editor: {
    getModels: () => openModels,
    getModel: () => null,
    setModelMarkers: () => {},
    registerCommand: () => ({ dispose() {} }),
  },
};
const { createLspManager } = new Function("monaco", source + "\nreturn { createLspManager };")(monaco);

const tick = () => new Promise((r) => setImmediate(r));

function backendWith({ failStart = false } = {}) {
  const b = {
    starts: [], stops: [], callbacks: [],
    async lspStart(config, cb) {
      b.starts.push(config.lang);
      if (failStart) throw new Error("boom");
      b.callbacks.push(cb);
    },
    async lspSend(_lang, raw) {
      const m = JSON.parse(raw);
      if (m.id === undefined) return;
      const cb = b.callbacks.at(-1);
      queueMicrotask(() => cb({ kind: "message", data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } }) }));
    },
    async lspStop(lang) { b.stops.push(lang); },
    async lspCheckAvailable() { return true; },
    // 真实链路上这一步是**异步**的（要去跑一次解释器）。那个 await 正是三次并发
    // 都挤过同步检查的缝——所以它必须是异步的，否则这条 bug 在测试里根本不成立。
    async lspDetectPython() { await tick(); return { pythonPath: "/usr/bin/python3" }; },
  };
  return b;
}

test("三个标签页同时开同一门语言，只 spawn 一次——不是三次然后互相杀掉", async () => {
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  const [a, b, c] = await Promise.all([m.ensureServer("python"), m.ensureServer("python"), m.ensureServer("python")]);
  assert.equal(backend.starts.length, 1, `并发启动没有去重，spawn 了 ${backend.starts.length} 次`);
  assert.equal(backend.stops.length, 0, "有人走了「already running → 先 stop 再重试」，那会把刚起好的杀掉");
  assert.ok(a && a === b && a === c, "三次调用拿到的不是同一个客户端");
  assert.equal(m.isRunning("python"), true);
  await m.stop("python");
});

test("在途去重结束后不粘住：这一次起完，下一次还能真的再起", async () => {
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  await m.ensureServer("python");
  await m.stop("python");
  await m.ensureServer("python");
  assert.equal(backend.starts.length, 2, "第二次没起来——在途 Promise 没被清掉");
  await m.stop("python");
});

test("服务器死了会自己爬起来，不用等用户再打开一个同语言文件", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.didOpen("/w/a.rs", model("rust", "/w/a.rs"));
  await tick(); await tick(); await tick();
  assert.equal(backend.starts.length, 1);

  backend.callbacks.at(-1)({ kind: "stopped", lang: "rust", tail: [] });
  await tick();
  assert.equal(m.isRunning("rust"), false, "死了之后客户端还挂着");
  assert.equal(m.restartPending("rust"), true, "没有排上自动重启——用户会一直卡在「未启动」");

  t.mock.timers.tick(900);
  await tick(); await tick(); await tick();
  assert.equal(backend.starts.length, 2, "退避到点了却没有真的重启");
  assert.equal(m.isRunning("rust"), true, "重启完服务没回来");
  t.mock.timers.reset();
});

test("这门语言一个文件都没开着就不重启——起来也没人用", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // 没有任何 .rs 开着：服务是别的路径（智能体的 lsp_* 工具）拉起来的
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  await m.ensureServer("rust");
  backend.callbacks.at(-1)({ kind: "stopped", lang: "rust", tail: [] });
  await tick();
  assert.equal(m.restartPending("rust"), false, "没人用还在重启，白占几百 MB");
  t.mock.timers.tick(60000);
  await tick();
  assert.equal(backend.starts.length, 1);
  t.mock.timers.reset();
});

test("连着起不来就停手并说一句，不许变成看不见的重试风暴", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = backendWith();
  const toasts = [];
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true, showToast: (s) => toasts.push(s) });
  m.didOpen("/w/a.rs", model("rust", "/w/a.rs"));
  await tick(); await tick(); await tick();
  // 每次刚起来就死：退避一路退到顶。
  for (let i = 0; i < 6; i++) {
    const cb = backend.callbacks.at(-1);
    cb({ kind: "stopped", lang: "rust", tail: [] });
    await tick();
    t.mock.timers.tick(31000);
    await tick(); await tick(); await tick();
  }
  assert.ok(backend.starts.length <= 5, `退避没有上限，已经 spawn ${backend.starts.length} 次`);
  assert.ok(toasts.some((s) => /不自动重试|没起来/.test(s)), "停手了却一个字都没说——又是一次静默的功能消失");
  t.mock.timers.reset();
});

test("巡检会把「该有服务却没起来」的补上", async () => {
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.didOpen("/w/a.go", model("go", "/w/a.go"));
  m.didOpen("/w/r.md", model("markdown", "/w/r.md"));
  await tick(); await tick(); await tick();
  await m.stop("go");                      // 服务没了，而文件还开着——正是用户那一幕
  assert.equal(backend.starts.length, 1);
  m.ensureForOpenModels();
  await tick(); await tick(); await tick();
  assert.deepEqual(backend.starts, ["go", "go"], "巡检没把没起来的补上，或者给 markdown 也起了一个");
  await m.stop("go");
});

test("起不来的语言有冷却——巡检不会 20 秒一次地砸它", async () => {
  const backend = backendWith({ failStart: true });
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true, showToast: () => {} });
  m.didOpen("/w/a.go", model("go", "/w/a.go"));
  await tick(); await tick(); await tick();
  m.ensureForOpenModels(); await tick(); await tick();
  m.ensureForOpenModels(); await tick(); await tick();
  m.ensureForOpenModels(); await tick(); await tick();
  assert.equal(backend.starts.length, 1, `没有冷却，对着一个起不来的服务 spawn 了 ${backend.starts.length} 次`);
});

test("明确 stop 掉的，自动重启不许把它拉回来", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.didOpen("/w/a.rs", model("rust", "/w/a.rs"));
  await tick(); await tick(); await tick();
  backend.callbacks.at(-1)({ kind: "stopped", lang: "rust", tail: [] });
  await tick();
  assert.equal(m.restartPending("rust"), true);
  await m.stop("rust");
  assert.equal(m.restartPending("rust"), false, "stop 之后那次重启还排着");
  t.mock.timers.tick(60000);
  await tick(); await tick();
  assert.equal(backend.starts.length, 1, "被停掉的服务又被自动拉起来了");
  t.mock.timers.reset();
});

test("换工作区会撤掉排着的重启——否则会按旧根把服务器拉起来", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.didOpen("/w/a.rs", model("rust", "/w/a.rs"));
  await tick(); await tick(); await tick();
  backend.callbacks.at(-1)({ kind: "stopped", lang: "rust", tail: [] });
  await tick();
  assert.equal(m.restartPending("rust"), true);
  await m.resetForNewWorkspace();
  assert.equal(m.restartPending("rust"), false, "切工作区之后旧的重启还排着");
  t.mock.timers.tick(60000);
  await tick(); await tick();
  assert.equal(backend.starts.length, 1);
  t.mock.timers.reset();
});

test("项目预载出来的 model 不许拉起服务——只认用户真打开的那些", async () => {
  // 这个 IDE 会把项目里所有代码文件预载成 monaco model（跨文件跳转要用）。照 model 起
  // 服务，等于打开一个仓库就在后台拉起六个语言服务器，每个几百 MB，其中五个用户一眼没看过。
  openModels.length = 0;
  openModels.push(model("go", "/w/pre.go"), model("rust", "/w/pre.rs"), model("python", "/w/pre.py"));
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.ensureForOpenModels();
  await tick(); await tick(); await tick();
  assert.deepEqual(backend.starts, [], "按内存里躺着的 model 起服务了——开个仓库就是一把语言服务器");
  openModels.length = 0;
});

test("文件关掉之后就不再为它自动重启", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = backendWith();
  const m = createLspManager({ backend, isWorkspaceTrusted: () => true });
  m.didOpen("/w/a.rs", model("rust", "/w/a.rs"));
  await tick(); await tick(); await tick();
  m.didClose("/w/a.rs");
  backend.callbacks.at(-1)({ kind: "stopped", lang: "rust", tail: [] });
  await tick();
  assert.equal(m.restartPending("rust"), false, "文件都关了还在给它重启");
  t.mock.timers.tick(60000);
  await tick(); await tick();
  assert.equal(backend.starts.length, 1);
  t.mock.timers.reset();
});
