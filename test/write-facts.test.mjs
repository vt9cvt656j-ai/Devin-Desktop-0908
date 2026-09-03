// ── 写入质量事实：判据已经在算（或一次查询就能算）的结论，必须接到「写下去那一刻」
//    的模型通道上 ──────────────────────────────────────────────────────────────
//
// 六条同一机制的病：
//   1. 三条写入质量事实（占位/删了没查引用的导出/盲覆写）只在静默收尾轮算，算完就
//      break——模型永远读不到；
//   2. 符号索引每次落盘都在刷新，「新符号是否与项目里已有实现重名」却从没查过；
//   3. 新增行扫描器只有占位一族规则，硬编码一条都没有；
//   4. 触及的导出符号有没有真实调用方，从没做过引用查询；
//   5. 诊断门分不清「查过了干净」和「这门语言没有检查器」；
//   6. 改的文件有同名测试文件而本 run 没读没跑，从没人点名。
// 修法全部是：把已经算出（或一次只读查询能算出）的执行事实，经既有的写时通道
// （_pushNudge 事实类 / 写工具返回值）交回模型；run 级 Set 去重、每处每 run 一次。
import test from "node:test";
// 这一对 2026-08-25 搬进了 src/agent/code-text.js —— 直接 import 真模块，
// 不再抠源码：抠源码验得到行为，验不到它在真实调用链上还在不在。
import { splitCodeAndComments as _splitCC, symbolPatternsFor as _symPat } from "../src/agent/code-text.js";
import assert from "node:assert";
import { SRC, CODE, fnSource, load, blockFrom } from "./helpers/source.mjs";

const loop = fnSource("_runAgenticLoop", { code: true });

// ---- ① 三条写入质量事实在每轮工具阶段末尾就说，不再等收尾 ----

test("写入质量扫描器在工具阶段（blindEdit 与 verifyNow 之间）就跑，输出走 writeFacts 事实通道", () => {
  // 上界锚点换了（2026-09-02）：blindEdit 那条 _pushNudge 已删（规则搬进工具描述、
  // 拦截搬进 _blindOverwritePrecheck）。改钉同一位置那句仍在的真代码。
  const from = loop.indexOf('const _isBlindable =');
  // 下界锚点换了：verifyNow 的文本追加到交付事实块了，不再是一条 _pushNudge。
  // 这条测试只拿它当"工具阶段到哪儿为止"的地标，换成它的文本即可。
  const to = loop.indexOf("[未验证] 刚改了");
  assert.ok(from > 0 && to > from, "盲改记账 / verifyNow 两个锚点都得在");
  const seg = loop.slice(from, to);
  assert.match(seg, /_stubDeliveryFindings\(run\)/,
    "占位扫描器只在静默收尾轮跑的话，结果随 break 蒸发，模型永远读不到");
  assert.match(seg, /_removedDeclarationsUnchecked\(run, _wfTerms\)/,
    "「删了没查引用的导出」必须在写完那一轮就说");
  assert.match(seg, /run\._blindOverwrites \|\| \[\]/,
    "「没读过还覆写掉一半」的记账要在写时就转述给模型");
  // 载体换了（2026-09-02）：不再单独推一条 `_pushNudge("writeFacts", …)`，
  // 而是**追加到本轮那条 [本轮交付事实] 上**。三条事实仍然走同一条通道，
  // 而且拿到了那块的"每轮自替换、不累积"性质（原来走 _pushNudge，受同轮淘汰管，
  // 长 run 里可能被别的提醒挤掉）。
  assert.match(seg, /_DELIVERY_FACTS_TAG/, "三条事实必须走同一条写时通道");
  assert.match(seg, /\[写入质量事实\]/, "标题丢了，模型分不出这是执行事实还是推断");
  assert.doesNotMatch(seg, /_pushNudge\("writeFacts"/,
    "又变回单独一条 harness 消息了 —— 同一轮里两条讲同一件事");
  // **必须追加到本轮那条，不能存起来等下一轮**：交付事实块在更早处就推掉了，
  // 而这些行到这里才算出来，存起来等于模型拿上一轮的写入质量判这一轮。
  assert.match(seg, /for \(let i = messages\.length - 1; i >= 0; i--\)/,
    "没有回头找本轮那条交付事实 —— 事实会晚一轮到");
  assert.match(seg, /if \(!_appended\) messages\.push/,
    "交付事实块是有条件推的，没找到时必须自己推一条，不能让事实凭空消失");
  // 只给事实不抢回合：收尾门「安静一轮＝模型的收尾判断」那条红线在这里同样成立。
  const wfAt = seg.indexOf("[写入质量事实]");
  assert.doesNotMatch(seg.slice(wfAt, wfAt + 700), /\bcontinue;/,
    "写入质量事实只陈述，不补回合");
});

test("writeFacts 登记进事实类，且同一处每 run 只说一次（run 级 Set 去重）", () => {
  // 按解析那张表判，不按子串——_pushNudge("writeFacts" 那一行自己就含这个子串。
  const facts = new Set([...(/const _NUDGE_FACTS = new Set\(\[([\s\S]*?)\]\)/.exec(SRC)[1]
    .matchAll(/"([a-zA-Z]+)"/g))].map((m) => m[1]));
  // 原来钉「writeFacts 登记进事实类」——为的是别被建议类挤掉。现在它不在淘汰表里了：
  // 文本追加到 [本轮交付事实]，而那块每轮无条件推、推前把上一份 splice 掉，
  // **完全不参与同轮淘汰**。「挤不掉」这个保证因此比原来更强，不是没了。
  assert.ok(!facts.has("writeFacts"),
    "writeFacts 又回到淘汰表里了 —— 它现在待在不参与淘汰的交付事实块里，两处都有就是重复");
  // 上界锚点换了（2026-09-02）：blindEdit 那条 _pushNudge 已删（规则搬进工具描述、
  // 拦截搬进 _blindOverwritePrecheck）。改钉同一位置那句仍在的真代码。
  const from = loop.indexOf('const _isBlindable =');
  const seg = loop.slice(from, loop.indexOf('_pushNudge("verifyNow"'));
  assert.match(seg, /run\._writeFactsSaid \|\| \(run\._writeFactsSaid = new Set\(\)\)/,
    "没有 run 级去重，同一条事实会每轮复读、烧掉上下文预算");
  for (const key of ["stub:", "removed:", "overwrote:", "hard:", "testfile:"]) {
    assert.ok(seg.includes("`" + key), `去重键族缺了 ${key}`);
  }
});

test("收尾门的记账没有被搬空：三个扫描器在静默轮照旧写 incompleteReason", () => {
  // 搬的是「输出通道」不是「记账」：收尾门那份闭合枚举还是用户结局卡片的来源。
  // 结束锚点原来写的是 `"break; // truly done"` —— 带 `//` 注释文本，而 loop 来自
  // fnSource(..., { code: true })，注释已被抹成空格：indexOf 永远返回 **-1**。
  // 于是 slice(起点, -1) 不是空串，而是「到函数尾少一个字」——实测拿到 189196 字
  // （整个 _runAgenticLoop 的 67%），而静默分支只有 18609 字。三条断言从此在函数
  // 大半截里找字符串，谁把记账搬出静默轮都照样绿。
  // 而且 `slice(a, -1)` 返回非空，所以「切出来是不是空的」这类哨兵结构上抓不到它。
  // 改成按 AST 取整个 if 块（这个锚点在源码里有两处，另一处不在本函数里，所以传 nth；
  // 次数一旦变化 blockFrom 会当场抛错，不会静默漂到别处）。
  const quiet = blockFrom("if (!turn.toolCalls.length) {", { code: true, nth: 1 });
  assert.match(quiet, /quietTurns\+\+/, "切到的不是静默轮分支");
  assert.match(quiet, /removed_unchecked:\$\{_gone\.length\}/);
  assert.match(quiet, /overwrote_unread:\$\{run\._blindOverwrites\.length\}/);
  assert.match(quiet, /stub_delivery:\$\{_stubs\.length\}/);
});

// ---- ② 落盘查重：新符号与项目里已有实现重名，一次 Map.get 就该说出来 ----

test("新增顶层符号命中别的文件里的同名定义时，name @ path:line + 签名行拼进写结果", () => {
  const idx = new Map([
    ["formatdate", [
      { name: "formatDate", kind: "function", path: "src/utils/date.ts", line: 10, sig: "export function formatDate(d) {" },
      { name: "formatDate", kind: "function", path: "src/b.ts", line: 3, sig: "export function formatDate(x) {" },
    ]],
  ]);
  const note = load("_duplicateSymbolNote", {
    _symbolIndexBuilt: true,
    _symbolIndexRoot: "/w",
    _symbolIndex: idx,
    _symbolPatternsFor: _symPat,
  });
  const run = {};
  const out = note(run, "/w/src/b.ts", "", "export function formatDate(x) {\n  return x;\n}\n");
  assert.match(out, /formatDate @ src\/utils\/date\.ts:10/, "要给出真实定义位置");
  assert.match(out, /export function formatDate\(d\)/, "签名行要一起带出去，模型才核对得动");
  assert.doesNotMatch(out, /src\/b\.ts:3/, "本文件自己的条目不算重名");
  // 每 run 每 path:line 只说一次。
  assert.equal(note(run, "/w/src/b.ts", "", "export function formatDate(x) {}\n"), "");
  // 基线里已有的行不算这次新增。
  assert.equal(note({}, "/w/src/b.ts", "export function formatDate(x) {\n", "export function formatDate(x) {\n"), "");
});

test("符号索引没建好就一个字不说（降级而不是撒谎）", () => {
  const note = load("_duplicateSymbolNote", {
    _symbolIndexBuilt: false,
    _symbolIndexRoot: "/w",
    _symbolIndex: new Map([["formatdate", [{ name: "formatDate", path: "a.ts", line: 1, sig: "x" }]]]),
    _symbolPatternsFor: _symPat,
  });
  assert.equal(note({}, "/w/b.ts", "", "export function formatDate() {}\n"), "");
});

test("查重结果走写工具返回值那条已被证明有效的通道（write/edit 与 multiedit 都接）", () => {
  assert.match(CODE, /_duplicateSymbolNote\(run, fp, existed \? old : "", newContent\)/,
    "write/edit 分支没接查重——落盘那一刻索引里明明两份同名符号都在");
  assert.match(CODE, /\+ _duplicateSymbolNote\(run, fp, old, newContent\)/,
    "multiedit 分支没接查重");
});

// ---- ③ 硬编码规则族：只看新增行，命中 .env 已有配置项时点名 ----

test("硬编码扫描器认端口/URL/绝对路径/密钥形字面量，且只报新增行", () => {
  const scan = load("_hardcodedDeliveryFindings", { _CODE_FILE_RE: /\.(?:tsx?|jsx?|py|rs|go)$/i });
  const mk = (before, current) => ({ checkpoint: new Map([["/p/a.ts", { existed: true, content: before, current }]]) });
  const hits = scan(mk("const KEEP = 1;", [
    "const KEEP = 1;",
    'const api = "http://localhost:3000/api";',
    'fetch("https://api.stripe.com/v1/charges");',
    'const p = "/Users/michael/data.json";',
    'const apiKey = "sk_live_a1b2c3d4e5f6";',
  ].join("\n")), []);
  const kinds = hits.map((h) => h.kind).join("|");
  assert.match(kinds, /端口/, "写死的 localhost:3000 没被认出来");
  assert.match(kinds, /URL/, "写死的外部 URL 没被认出来");
  assert.match(kinds, /绝对路径/, "写死的 /Users/... 没被认出来");
  assert.match(kinds, /密钥形字面量/, "密钥字面量贴进源码没被认出来");
  for (const h of hits) assert.ok(h.line >= 2 && h.text, "每条都要有 file:line + 原文佐证");
  // 基线里本来就有的行不算这次交付的账。
  assert.deepEqual(scan(mk('const api = "http://localhost:3000";', 'const api = "http://localhost:3000";'), []), []);
  // 注释行、以及值是表达式（process.env.X）的不报。
  assert.deepEqual(scan(mk("", '// see https://api.stripe.com/docs'), []), []);
  assert.deepEqual(scan(mk("", "const apiKey = process.env.API_KEY;"), []), []);
});

test("命中的字面量对应 .env 里已有的 key 名时，措辞升级为「项目里已经有配置项 X」", () => {
  const scan = load("_hardcodedDeliveryFindings", { _CODE_FILE_RE: /\.(?:tsx?|jsx?)$/i });
  const mk = (current) => ({ checkpoint: new Map([["/p/a.ts", { existed: true, content: "", current }]]) });
  const [port] = scan(mk('app.listen("localhost:3000");'), ["PORT", "API_URL"]);
  assert.equal(port.envKey, "PORT");
  const [url] = scan(mk('fetch("https://api.example.io/v1");'), ["PORT", "API_URL"]);
  assert.equal(url.envKey, "API_URL");
  // .env 里没有对应项就不硬编一个名字出来。
  const [bare] = scan(mk('fetch("https://api.example.io/v1");'), []);
  assert.equal(bare.envKey, "");
  // 事实行里把配置项名字说出去。
  // 上界锚点换了（2026-09-02）：blindEdit 那条 _pushNudge 已删（规则搬进工具描述、
  // 拦截搬进 _blindOverwritePrecheck）。改钉同一位置那句仍在的真代码。
  const from = loop.indexOf('const _isBlindable =');
  const seg = loop.slice(from, loop.indexOf('_pushNudge("verifyNow"'));
  assert.match(seg, /_hardcodedDeliveryFindings\(run, _envKeysByRoot\.get\(root\) \|\| \[\]\)/);
  assert.match(seg, /项目 \.env 里已经有配置项 \$\{h\.envKey\}/);
  // key 名的采集挂在本来就在读 .env 的那条路径上（只有名字，值从不缓存）。
  assert.match(CODE, /_envKeysByRoot\.set\(root, \[\.\.\.new Set\(\[\.\.\.\(_envKeysByRoot\.get\(root\) \|\| \[\]\), \.\.\.allKeys\]\)\]\.slice\(0, 64\)\)/);
});

// ---- ④ 触及的导出符号做有界引用查询 ----

test("_touchedExportedDecls 只挑声明行真变了的导出，全新符号与原样声明不进名单", () => {
  const pick = load("_touchedExportedDecls", { _CODE_FILE_RE: /\.(?:tsx?|jsx?|py|rs)$/i });
  const run = {
    checkpoint: new Map([["/p/a.ts", {
      existed: true,
      content: "export function changed(a) {}\nexport function same() {}\n",
      current: "export function changed(a, b) {}\nexport function same() {}\nexport function brandNew() {}\n",
    }]]),
  };
  const out = pick(run, ["/p/a.ts"], 3);
  assert.equal(out.length, 1, "只有签名变了的那一个该进引用查询名单");
  assert.equal(out[0].name, "changed");
  assert.equal(out[0].line, 1);
  assert.ok(out[0].character >= 0);
  // 每 run 每符号只查一次。
  assert.deepEqual(pick(run, ["/p/a.ts"], 3), []);
  // 新建文件（existed:false）不查。
  assert.deepEqual(pick({ checkpoint: new Map([["/p/b.ts", { existed: false, content: "", current: "export function x() {}" }]]) }, ["/p/b.ts"]), []);
});

test("引用查询分流：JS/TS 走进程内 TS worker，其它语言只在 LSP isRunning 时查，查不成不下结论", () => {
  // 上界锚点换了（2026-09-02）：blindEdit 那条 _pushNudge 已删（规则搬进工具描述、
  // 拦截搬进 _blindOverwritePrecheck）。改钉同一位置那句仍在的真代码。
  const from = loop.indexOf('const _isBlindable =');
  const seg = loop.slice(from, loop.indexOf('_pushNudge("verifyNow"'));
  assert.match(seg, /_touchedExportedDecls\(run, run\._lastSuccessfulEdits \|\| \[\], 3\)/,
    "每轮最多 3 个符号的上界没了");
  assert.match(seg, /_tsWorkerLocate\(t\.abs, t\.line, t\.character, "references"\)/,
    "JS/TS 要走进程内 TS worker 的真实引用查询");
  assert.match(seg, /lspManager\?\.isRunning\?\.\(_tLang\)/,
    "非 JS/TS 必须先问语言服务器在不在跑，不许瞎等");
  assert.match(seg, /if \(!Array\.isArray\(_refs\)\) continue;/,
    "查不成 ≠ 没有引用——没拿到数组就一个字不说");
  // 「没有其它调用方」同样是有用的事实，要说出来。
  assert.match(seg, /本文件之外查不到它的任何引用/);
});

// ---- ⑤ 诊断门分清「查过了干净」和「这门语言没有检查器」 ----

test("语言服务器没在跑的文件不建 model、不进等待循环，unchecked 清单随返回值带出", async () => {
  const created = [];
  const diag = load("_interleavedDiagnostics", {
    monaco: {
      Uri: { file: (p) => ({ fsPath: p }) },
      editor: {
        getModel: () => null,
        createModel: (content, lang, uri) => { created.push(uri); return { uri, dispose() {} }; },
        getModelMarkers: () => [],
      },
    },
    lspManager: { isRunning: () => false, didOpen() {}, didClose() {} },
    backend: { readTextFile: async () => "x = 1\n" },
    _resolveExisting: async (rel) => "/w/" + rel,
    _normRel: (p) => String(p).replace(/^\/w\//, ""),
    _lintableLangId: (name) => (String(name).endsWith(".py") ? "python" : null),
    _LINTABLE_EXT: new Set(["py", "js"]),
    _TS_EXT: new Set(["ts", "tsx", "mts", "cts"]),
    _INTERLEAVED_DIAG_MAX_FILES: 16,
    _INTERLEAVED_DIAG_MAX_WAIT_MS: 1,
    // .js 现在走 Monaco 自带 worker 那条短腿（jsFamily），所以这个常量也必须注进来；
    // 少了它 own() 会 ReferenceError —— 而那恰好证明 .js 真的改走短腿了。
    _INTERLEAVED_DIAG_TS_WAIT_MS: 1,
    formatDiagnosticsForAgent: () => "",
  });
  const t0 = Date.now();
  const r = await diag(["src/app.py"], "/w");
  assert.equal(r.ran, false, "没有一个可检查目标时不该谎称跑过");
  assert.deepEqual(r.unchecked, [{ rel: "src/app.py", lang: "python" }],
    "「没有检查器」必须以结构化清单返回，而不是和「干净」同形的沉默");
  assert.equal(created.length, 0, "没有服务器还建 model 就是白等 4 秒的那条老路");
  assert.ok(Date.now() - t0 < 500, "unchecked 路径不该进等待循环");
});

test("JS/TS 不受 isRunning 影响（Monaco 自带 worker），unchecked 事实在调用点登记并走写时通道", async () => {
  const diag = load("_interleavedDiagnostics", {
    monaco: {
      Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
      editor: {
        getModel: () => null,
        createModel: (content, lang, uri) => ({ uri, dispose() {} }),
        getModelMarkers: () => [],
      },
    },
    lspManager: { isRunning: () => false, didOpen() {}, didClose() {} },
    backend: { readTextFile: async () => "const a = 1;\n" },
    _resolveExisting: async (rel) => "/w/" + rel,
    _normRel: (p) => String(p).replace(/^\/w\//, ""),
    _lintableLangId: (name) => (String(name).endsWith(".py") ? "python" : "javascript"),
    _LINTABLE_EXT: new Set(["py", "js"]),
    _TS_EXT: new Set(["ts", "tsx", "mts", "cts"]),
    _INTERLEAVED_DIAG_MAX_FILES: 16,
    _INTERLEAVED_DIAG_MAX_WAIT_MS: 1,
    // .js 现在走 Monaco 自带 worker 那条短腿（jsFamily），所以这个常量也必须注进来；
    // 少了它 own() 会 ReferenceError —— 而那恰好证明 .js 真的改走短腿了。
    _INTERLEAVED_DIAG_TS_WAIT_MS: 1,
    formatDiagnosticsForAgent: () => "",
  });
  const r = await diag(["a.js", "b.py"], "/w");
  assert.equal(r.ran, true, "JS 有 Monaco 自带 worker，isRunning=false 不该拦它");
  assert.deepEqual(r.unchecked, [{ rel: "b.py", lang: "python" }]);
  // 调用点：登记 run._uncheckedLangs + 事实进 _writeFactsPending，由写时通道统一说。
  assert.match(loop, /run\._uncheckedLangs = run\._uncheckedLangs \|\| new Set\(\)/);
  assert.match(loop, /run\._writeFactsPending = run\._writeFactsPending \|\| \[\]/);
  assert.match(loop, /没有任何检查器看过/);
  // verifyNow 在无检查器语言上要把「这条命令是唯一的正确性检查」这半句事实补上。
  // 锚点换了：verifyNow 的文本追加到交付事实块了，不再是一条 _pushNudge。
  const vAt = loop.indexOf("[未验证] 刚改了");
  assert.match(loop.slice(vAt, vAt + 1400), /run\._uncheckedLangs && run\._uncheckedLangs\.size/,
    "verifyNow 没读 unchecked 事实——没有 LSP 的语言上它说得不够硬");
});

// ---- ⑥ 改的文件有同名测试文件而本 run 没读没跑 ----

test("同名测试文件存在且本 run 没读没跑时，点名那条具体路径；读过/跑过/有验证证据则闭嘴", async () => {
  const deps = {
    _projectStacks: new Map([["/w", { testDir: "tests" }]]),
    backend: { readDir: async () => [{ name: "test_app.py", is_dir: false }, { name: "unit", is_dir: true }] },
    _CODE_FILE_RE: /\.(?:tsx?|jsx?|py|rs)$/i,
    _looksLikeTestFile: load("_looksLikeTestFile"),
    _runHasRead: () => false,
    _deliveryFacts: () => ({ verifiers: [] }),
    _normRel: (p, root) => String(p).replace(String(root) + "/", ""),
  };
  const probe = (over = {}) => load("_untouchedTestFilesFor", { ...deps, ...over });
  const run = () => ({ _toolLedger: { entries: [] } });
  const hit = await probe()(run(), "/w", ["/w/src/app.py"]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].rel, "tests/test_app.py", "必须给出那条具体路径，不是一句「有测试」");
  assert.equal(hit[0].src, "src/app.py");
  // 读过就不报。
  assert.deepEqual(await probe({ _runHasRead: () => true })(run(), "/w", ["/w/src/app.py"]), []);
  // 本 run 有识别为验证的命令跑过就不报。
  assert.deepEqual(await probe({ _deliveryFacts: () => ({ verifiers: [{ exitCode: 0 }] }) })(run(), "/w", ["/w/src/app.py"]), []);
  // 某条命令点名了这个文件就不报。
  const ranIt = { _toolLedger: { entries: [{ tool: "run_cmd", category: "cmd", args: '{"command":"pytest tests/test_app.py"}' }] } };
  assert.deepEqual(await probe()(ranIt, "/w", ["/w/src/app.py"]), []);
  // 改的本来就是测试文件不报（那正是我们希望它写的地方）。
  assert.deepEqual(await probe()(run(), "/w", ["/w/tests/test_app.py"]), []);
  // 没探测到套件目录就一个字不说。
  assert.deepEqual(await probe({ _projectStacks: new Map() })(run(), "/w", ["/w/src/app.py"]), []);
});

test("testDir 必须先落到 stack 再进 _projectStacks（浅拷贝在先，探测结果就永远进不了 Map）", () => {
  const assignAt = CODE.indexOf("stack.testDir = _testDir.dir;");
  const setAt = CODE.indexOf("_projectStacks.set(root, { ...stack, root })");
  assert.ok(assignAt > 0 && setAt > 0);
  assert.ok(assignAt < setAt,
    "先 set 后赋 testDir 的话，Map 里那份浅拷贝没有 testDir——_strayScratchFiles 和同名测试判据读的都是 Map 里那份");
});

// ── 诊断门的扩展名表必须覆盖 Monaco 自带 worker 的那几种 ────────────────────
//
// json / css / html 三个 worker 在 main.js 顶部就 import 着、MonacoEnvironment 里接着，
// 装都不用装、免费就能查。而它们一直不在 _LINTABLE_EXT 里 —— 于是模型写坏一个
// package.json 或 tsconfig.json（整个项目当场跑不起来）、写出一条不闭合的 CSS，
// 那道「你这次改动引入了新增错误」的闸一个字都不说。
//
// 这几种恰恰是「坏了整个项目就起不来」的那一类，比漏掉一门要另装语言服务器的语言严重得多。
test("诊断门覆盖 Monaco 免费就能查的那几种扩展名", () => {
  const m = /const _LINTABLE_EXT = new Set\(\[([\s\S]*?)\n\]\);/.exec(SRC);
  assert.ok(m, "_LINTABLE_EXT 抠不出来了");
  const body = m[1].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const set = new Set(eval("[" + body + "]"));   // eslint-disable-line no-eval
  for (const ext of ["json", "jsonc", "css", "scss", "less", "html", "htm"]) {
    assert.ok(set.has(ext),
      `.${ext} 不在诊断门的扩展名表里 —— 而 Monaco 自带的 worker 免费就能查它。`
      + "写坏一个 package.json 就是整个项目起不来，诊断门却一声不吭。");
  }
  // 对应的 worker 真的装着（表里加了而 worker 没接，就是另一种假话：查了、但永远没有结果）
  for (const w of ["json/json.worker", "css/css.worker", "html/html.worker"]) {
    assert.ok(SRC.includes(w), `Monaco 的 ${w} 没有 import —— 表里加了扩展名也查不出东西`);
  }
  assert.match(SRC, /self\.MonacoEnvironment = \{/, "MonacoEnvironment 没接，worker 起不来");
  // 三个卡口都读这张表，漏一个那条腿就还是哑的
  assert.equal((SRC.match(/_LINTABLE_EXT\.has\(ext\)/g) || []).length, 3,
    "读这张表的卡口数变了 —— 重新核一遍哪几条腿真的用上了");
});
