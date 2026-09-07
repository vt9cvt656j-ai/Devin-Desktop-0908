// ── 依赖坑前置：写 manifest 落盘那一刻，就把「该依赖该版本还没核对过资料」交回模型 ──
//
// 机制（不是劝诫）：
//   1. 触发是执行事实——写工具真的往 manifest 落了盘，且 checkpoint 基线相减的新增行里
//      解析得出 (名字,版本)（与 _stubDeliveryFindings/_duplicateSymbolNote 同一套手法）；
//   2. 连着 context7（run.mcpToolCache 有 mcp__context7__query-docs）→ 参数已预填的查询
//      挂成候选（run._depDocsCandidate），模型空参数调用即点头（_verifyCandidate 同款）；
//      没有 context7 → 指路事实：registry URL 按 manifest 类型确定性拼出，模型 web_fetch；
//   3. 有界：每轮最多 2 条（run._depHintBudget）；(生态,名字,主版本) 跨 run 只提示一次
//      （localStorage LRU，上限 64）；
//   4. 一切走已有写时通道（写工具返回值），IDE 绝不自己发网络请求（不代跑红线同族）。
import test from "node:test";
import assert from "node:assert";
import { CODE, fnSource, load } from "./helpers/source.mjs";

// 全部夹具离线：localStorage 是内存桩，解析器输入是字符串，没有任何网络。
const memStorage = (seed = {}) => {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    _dump: () => Object.fromEntries(store),
  };
};

const loadAdditions = () => load("_manifestDepAdditions", {
  _manifestDepKind: load("_manifestDepKind"),
  _depRegistryUrl: load("_depRegistryUrl"),
});

const loadTouch = (storage) => load("_depSeenTouch", {
  localStorage: storage,
  _DEP_SEEN_LS_KEY: "michael-ide.dep-pitfalls-seen",
  _DEP_SEEN_MAX: 64,
});

const loadNote = (storage) => load("_depPitfallNote", {
  _manifestDepAdditions: loadAdditions(),
  _depSeenTouch: loadTouch(storage),
});

// ---- ① 触发是执行事实：checkpoint 基线相减的新增行解析出 (名字,版本) ----

test("package.json：只有依赖区块里的新增行算新依赖，scripts/顶层键不算", () => {
  const adds = loadAdditions();
  const before = [
    "{",
    '  "name": "demo",',
    '  "version": "1.0.0",',
    '  "scripts": {',
    '    "dev": "vite"',
    "  },",
    '  "dependencies": {',
    '    "vue": "^3.4.0"',
    "  }",
    "}",
  ].join("\n");
  const after = [
    "{",
    '  "name": "demo",',
    '  "version": "1.0.0",',
    '  "scripts": {',
    '    "dev": "vite",',
    '    "lodash": "echo not-a-dep"',
    "  },",
    '  "dependencies": {',
    '    "vue": "^3.4.0",',
    '    "react": "^18.2.0"',
    "  },",
    '  "devDependencies": {',
    '    "vitest": "1.6.0"',
    "  }",
    "}",
  ].join("\n");
  const out = adds("/w/package.json", before, after);
  // vue 那行只多了个尾逗号（往它后面追加 react 的标点后果）——不是新依赖。
  assert.deepEqual(out.map((d) => d.name).sort(), ["react", "vitest"],
    "该认的是依赖区块新增行：react + vitest；scripts 里的 lodash、只多了尾逗号的 vue 都不是");
  const react = out.find((d) => d.name === "react");
  assert.equal(react.version, "^18.2.0");
  assert.equal(react.major, "18", "主版本从版本串里取第一段数字");
  assert.equal(react.kind, "npm");
  assert.equal(react.registry, "https://www.npmjs.com/package/react");
});

test("Cargo.toml：[dependencies] 行、[dependencies.foo] 节都认；path/git 本地依赖不算", () => {
  const adds = loadAdditions();
  const before = [
    "[package]",
    'name = "demo"',
    'version = "0.1.0"',
    "[dependencies]",
    'serde = "1.0"',
  ].join("\n");
  const after = [
    "[package]",
    'name = "demo"',
    'version = "0.1.0"',
    "[dependencies]",
    'serde = "1.0"',
    'anyhow = "1.0.86"',
    'local-helper = { path = "../helper" }',
    "[dependencies.tokio]",
    'version = "1.38"',
    'features = ["full"]',
    "[dev-dependencies]",
    'insta = { version = "1.39", features = ["yaml"] }',
  ].join("\n");
  const out = adds("/w/Cargo.toml", before, after);
  assert.deepEqual(out.map((d) => d.name).sort(), ["anyhow", "insta", "tokio"],
    "path 本地依赖和 [package] 的键都不该混进来");
  assert.equal(out.find((d) => d.name === "tokio").version, "1.38", "[dependencies.foo] 的版本在节内 version 行里");
  assert.equal(out.find((d) => d.name === "insta").version, "1.39", "内联表要取 version 键");
  assert.equal(out.find((d) => d.name === "anyhow").registry, "https://crates.io/crates/anyhow");
});

test("requirements*.txt：spec 行认名字和版本，注释/选项行/URL 行不算", () => {
  const adds = loadAdditions();
  const before = "flask==2.3.1\n";
  const after = [
    "flask==2.3.1",
    "requests>=2.32.0",
    "uvicorn[standard]==0.30.1",
    "# a comment",
    "-r base.txt",
    "git+https://github.com/x/y.git",
  ].join("\n");
  const out = adds("/w/requirements-dev.txt", before, after);
  assert.deepEqual(out.map((d) => d.name).sort(), ["requests", "uvicorn"]);
  assert.equal(out.find((d) => d.name === "uvicorn").version, "0.30.1", "extras 方括号不进名字");
  assert.equal(out.find((d) => d.name === "requests").registry, "https://pypi.org/project/requests/");
});

test("pyproject.toml：project.dependencies 数组和 poetry 节都认；python 键和 keywords 数组不算", () => {
  const adds = loadAdditions();
  const before = [
    "[project]",
    'name = "demo"',
    'keywords = ["cli", "tool"]',
    "dependencies = [",
    '  "httpx>=0.27",',
    "]",
  ].join("\n");
  const after = [
    "[project]",
    'name = "demo"',
    'keywords = ["cli", "tool", "extra"]',
    "dependencies = [",
    '  "httpx>=0.27",',
    '  "pydantic==2.8.2",',
    "]",
    "[tool.poetry.dependencies]",
    'python = "^3.11"',
    'rich = "^13.7"',
  ].join("\n");
  const out = adds("/w/pyproject.toml", before, after);
  assert.deepEqual(out.map((d) => d.name).sort(), ["pydantic", "rich"],
    "keywords 数组元素和 python 版本约束都不是依赖");
  assert.equal(out.find((d) => d.name === "pydantic").major, "2");
});

test("go.mod：require 块和单行 require 都认，// indirect 不算", () => {
  const adds = loadAdditions();
  const before = "module demo\n\ngo 1.22\n";
  const after = [
    "module demo",
    "",
    "go 1.22",
    "",
    "require (",
    "\tgithub.com/gin-gonic/gin v1.10.0",
    "\tgolang.org/x/sys v0.21.0 // indirect",
    ")",
    "",
    "require github.com/spf13/cobra v1.8.1",
  ].join("\n");
  const out = adds("/w/go.mod", before, after);
  assert.deepEqual(out.map((d) => d.name).sort(), ["github.com/gin-gonic/gin", "github.com/spf13/cobra"],
    "indirect 是 go mod tidy 的产物，不是模型的选择");
  assert.equal(out.find((d) => d.name.endsWith("gin")).registry, "https://pkg.go.dev/github.com/gin-gonic/gin");
  assert.equal(out.find((d) => d.name.endsWith("gin")).major, "1");
});

test("非 manifest 文件一个字不说；package-lock.json 也不是 manifest", () => {
  const adds = loadAdditions();
  assert.deepEqual(adds("/w/src/index.ts", "", '"react": "^18.0.0"'), []);
  assert.deepEqual(adds("/w/package-lock.json", "{}", '{ "dependencies": { "react": { "version": "18.0.0" } } }'), []);
});

test("registry URL 是 manifest 类型的确定性映射，不是猜测", () => {
  const url = load("_depRegistryUrl");
  assert.equal(url("npm", "@scope/pkg"), "https://www.npmjs.com/package/@scope/pkg");
  assert.equal(url("crates", "serde"), "https://crates.io/crates/serde");
  assert.equal(url("pypi", "flask"), "https://pypi.org/project/flask/");
  assert.equal(url("go", "github.com/x/y"), "https://pkg.go.dev/github.com/x/y");
  assert.equal(url("unknown", "x"), "");
});

// ---- ② 缓存：(生态,名字,主版本) 跨 run 只提示一次，LRU 上限 64 ----

test("_depSeenTouch：首见 false、再见 true；64 条上限按 LRU 淘汰，touch 会续命", () => {
  const storage = memStorage();
  const touch = loadTouch(storage);
  assert.equal(touch("npm:react@18"), false, "第一次没见过");
  assert.equal(touch("npm:react@18"), true, "第二次已见过");
  assert.equal(touch("npm:react@17"), false, "不同主版本是另一条记录");
  // 填满 64 条：react@18 是最老的，但先 touch 它续命，再塞新条目挤掉的应是别人。
  for (let i = 0; i < 62; i++) touch(`npm:pkg${i}@1`);
  // 目前 64 条：react@18, react@17, pkg0..pkg61。touch react@18 把它刷到最新。
  assert.equal(touch("npm:react@18"), true);
  assert.equal(touch("crates:new@1"), false, "第 65 条挤掉最老的 react@17");
  assert.equal(touch("npm:react@17"), false, "react@17 被 LRU 淘汰后重新算首见");
  assert.equal(touch("npm:react@18"), true, "刚续过命的 react@18 还在");
  const stored = JSON.parse(storage._dump()["michael-ide.dep-pitfalls-seen"]);
  assert.ok(stored.length <= 64, "持久化的清单必须有界");
});

test("localStorage 坏数据/抛异常都不炸，降级为「当作没见过」", () => {
  const bad = { getItem: () => "not-json{{", setItem: () => { throw new Error("quota"); } };
  const touch = loadTouch(bad);
  assert.equal(touch("npm:react@18"), false, "读不出历史就当首见，写失败也不许抛");
});

// ---- ③ 事实通道与内容：无 context7 时给 registry 指路，连着时预填候选 ----

test("无 context7：写结果里带「未核对资料」事实 + 每个依赖的 registry URL（web_fetch 指路）", () => {
  const note = loadNote(memStorage());
  const run = {};
  const out = note(run, "/w/package.json",
    '{\n  "dependencies": {\n  }\n}',
    '{\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}');
  assert.match(out, /react@\^18\.2\.0/, "依赖名和版本要点名");
  assert.match(out, /尚未核对资料/, "「未经资料核对」这个事实是主体");
  assert.match(out, /web_fetch/, "退路要说清用什么工具核对");
  assert.match(out, /https:\/\/www\.npmjs\.com\/package\/react/, "registry URL 是确定性映射，必须给出");
  assert.equal(run._depDocsCandidate, undefined, "没有 context7 就没有候选可预填");
});

test("有 context7：候选被武装（参数已预填），note 说明空参数调用即点头", () => {
  const note = loadNote(memStorage());
  const run = { mcpToolCache: [
    { type: "function", function: { name: "mcp__context7__resolve-library-id" } },
    { type: "function", function: { name: "mcp__context7__query-docs" } },
  ] };
  const out = note(run, "/w/package.json",
    '{\n  "dependencies": {\n  }\n}',
    '{\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}');
  assert.ok(run._depDocsCandidate, "候选没武装——「预填好参数」就无从发生");
  assert.equal(run._depDocsCandidate.mcpName, "mcp__context7__resolve-library-id",
    "候选必须挂在 resolve-library-id 上——query-docs 必填 libraryId，一点头就是缺参失败");
  assert.equal(String(run._depDocsCandidate.args?.libraryName || ""), "react",
    "预填参数必须是 schema 的真实必填字段 libraryName");
  assert.ok(!("query" in (run._depDocsCandidate.args || {})), "不许预填 schema 之外的猜测字段");
  assert.match(out, /mcp__context7__resolve-library-id/, "note 要告诉模型候选挂在哪个工具上");
  assert.match(out, /query-docs/, "note 要写明第二步：拿到 libraryId 后查细节");
  assert.match(out, /react@\^18\.2\.0/, "第二步的查询要点名该依赖该版本");
  assert.match(out, /空参数/, "点头动作（空参数调用）必须写明，弱模型才接得住");
});

test("同一 (名字,主版本) 第二次写入一个字不说；换主版本重新提示", () => {
  const storage = memStorage();
  const note = loadNote(storage);
  const before = '{\n  "dependencies": {\n  }\n}';
  const after17 = '{\n  "dependencies": {\n    "react": "^17.0.2"\n  }\n}';
  const after18 = '{\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}';
  assert.notEqual(note({}, "/w/package.json", before, after17), "", "首见要说话");
  assert.equal(note({}, "/w/package.json", before, after17), "", "跨 run（新 run 对象）同主版本必须闭嘴——缓存在 localStorage 不在 run 上");
  assert.notEqual(note({}, "/w/package.json", before, after18), "", "17→18 是主版本跳变，坑最密，重新提示");
});

test("每轮最多 2 条：预算从 run 上取，超出的既不说也不写缓存（下轮还有机会）", () => {
  const storage = memStorage();
  const note = loadNote(storage);
  const run = {};
  const before = '{\n  "dependencies": {\n  }\n}';
  const after = '{\n  "dependencies": {\n    "aaa": "1.0.0",\n    "bbb": "2.0.0",\n    "ccc": "3.0.0"\n  }\n}';
  const out = note(run, "/w/package.json", before, after);
  assert.match(out, /aaa@1\.0\.0/);
  assert.match(out, /bbb@2\.0\.0/);
  assert.doesNotMatch(out, /ccc/, "第 3 条超出每轮预算");
  assert.equal(run._depHintBudget, 0, "预算被消费到 0");
  const stored = JSON.parse(storage._dump()["michael-ide.dep-pitfalls-seen"] || "[]");
  assert.ok(!stored.some((k) => k.includes("ccc")), "没说出口的依赖不许写进「已见过」——否则它永远没机会被提示");
  // 预算耗尽后同轮再写 manifest：闭嘴，但依赖也不进缓存。
  assert.equal(note(run, "/w/package.json", before, '{\n  "dependencies": {\n    "ddd": "4.0.0"\n  }\n}'), "");
  // 下一轮（主循环重置预算）ccc/ddd 还能被提示。
  run._depHintBudget = 2;
  const out2 = note(run, "/w/package.json", before, after);
  assert.match(out2, /ccc@3\.0\.0/, "下一轮预算刷新后，上轮没说的依赖要补上");
});

test("主循环每轮把 run._depHintBudget 重置为 2（挂在本轮起点锚位上）", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  const floorAt = loop.indexOf("_nudgeTurnFloor = messages.length");
  assert.ok(floorAt > 0, "本轮起点锚没了");
  const seg = loop.slice(floorAt, floorAt + 400);
  assert.match(seg, /run\._depHintBudget = 2/,
    "每轮不重置预算，「每轮最多 2 条」就退化成「每 run 最多 2 条」——第 3 个新依赖永远没人提");
});

test("基线优先取 checkpoint（run 起点快照）：起点就有的依赖行不算这次新增", () => {
  const note = loadNote(memStorage());
  const withDep = '{\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}';
  const run = { checkpoint: new Map([["/w/package.json", { existed: true, content: withDep, current: withDep }]]) };
  // 传入的 oldText 是空（伪装成新建），但 checkpoint 基线里 react 早就在——不许提示。
  assert.equal(note(run, "/w/package.json", "", withDep), "",
    "「checkpoint 基线相减」才是任务判据；只看本次写前内容会把已有依赖当新增");
});

// ---- ④ 点头代填器：_verifyCandidateFill 的同款先例 ----

test("_depDocsCandidateFill：空参数 + 候选匹配 → 代填并一次性消费；自带参数一个字不动", () => {
  const fill = load("_depDocsCandidateFill");
  const cand = { mcpName: "mcp__context7__query-docs", args: { query: "react@18 pitfalls" } };
  // 空参数点头 → 填入 + 消费。
  const run = { _depDocsCandidate: { ...cand, args: { ...cand.args } } };
  const call = { type: "mcp", mcpName: "mcp__context7__query-docs", args: {} };
  assert.deepEqual(fill(run, call), { query: "react@18 pitfalls" });
  assert.equal(call.args.query, "react@18 pitfalls");
  assert.equal(run._depDocsCandidate, null, "候选必须一次性消费，陈旧候选不许常驻");
  // 模型自带参数 → 它在查自己的问题，不覆盖、不消费。
  const run2 = { _depDocsCandidate: { ...cand, args: { ...cand.args } } };
  const call2 = { type: "mcp", mcpName: "mcp__context7__query-docs", args: { query: "vue router" } };
  assert.equal(fill(run2, call2), null);
  assert.equal(call2.args.query, "vue router");
  assert.ok(run2._depDocsCandidate, "自带参数的调用不消耗候选");
  // 别的 MCP 工具 / 非 MCP 调用 / 没候选：都不碰。
  assert.equal(fill({ _depDocsCandidate: { ...cand } }, { type: "mcp", mcpName: "mcp__other__t", args: {} }), null);
  assert.equal(fill({ _depDocsCandidate: { ...cand } }, { type: "cmd", command: "" }), null);
  assert.equal(fill({}, { type: "mcp", mcpName: "mcp__context7__query-docs", args: {} }), null);
  assert.equal(fill(null, { type: "mcp", mcpName: "mcp__context7__query-docs", args: {} }), null);
});

test("点头入口接在 _executeToolStep 里，且在唯一授权检查点之前", () => {
  const wrapper = fnSource("_executeToolStep", { code: true });
  const fillAt = wrapper.indexOf("_depDocsCandidateFill(run, call)");
  const approveAt = wrapper.indexOf("_approveToolCall(call, run)");
  assert.ok(fillAt > 0, "代填器没接进执行包装器——候选武装了也没人消费");
  assert.ok(approveAt > 0 && fillAt < approveAt,
    "代填要发生在授权检查之前，否则用户确认框里看到的是一条空查询");
});

test("所有点头入口都在授权检查之前，且这份名单是全的", () => {
  // 这条守两件事。一是**位置**：任何一口落在授权检查之后，用户确认框里看到的就是
  // 一条空参数调用。二是**清点**：原来只逐个断言已有的那几口，于是第五口可以悄悄
  // 插在授权检查后面而没人发现。名单从源码现取再对数，漏跟一次当场红。
  const wrapper = fnSource("_executeToolStep", { code: true });
  const approveAt = wrapper.indexOf("_approveToolCall(call, run)");
  assert.ok(approveAt > 0, "唯一授权检查点不见了，这条断言失去落点");
  const mouths = [...wrapper.matchAll(/_(\w+CandidateFill)\(run, call\)/g)].map((m) => m[1]);
  const uniq = [...new Set(mouths)];
  // 2026-09-05：调研门的候选口（researchGateCandidateFill）随 TECH_RESEARCH 闸门瘦身一起删了——
  // 那道门现在只回一句事实，不再替模型武装一条候选调用。
  assert.deepEqual(uniq.sort(), [
    "browserVerifyCandidateFill",
    "depDocsCandidateFill",
    "verifyCandidateFill",
  ], "点头入口的数量变了——加口子要连这条一起改，否则新口子可以落在授权检查后面");
  for (const name of uniq) {
    assert.ok(wrapper.indexOf(`_${name}(run, call)`) < approveAt,
      `${name} 落在授权检查之后了——确认框里给用户看的会是一条空参数调用`);
  }
});

// ---- ⑤ 通道与红线：走写工具返回值；IDE 绝不自己发网络请求 ----

test("三条写入路径都接了依赖事实：write/edit 一处、multiedit 一处", () => {
  assert.match(CODE, /_depPitfallNote\(run, fp, existed \? old : "", newContent\)/,
    "write/edit 分支没接——manifest 多数就是被 write_file/edit_file 改的");
  assert.match(CODE, /\+ _depPitfallNote\(run, fp, old, newContent\)/,
    "multiedit 分支没接");
});

test("红线：预取本体绝不自动发网络请求——note/解析器/代填器里没有任何取数调用", () => {
  for (const name of ["_depPitfallNote", "_manifestDepAdditions", "_depDocsCandidateFill", "_depSeenTouch"]) {
    const body = fnSource(name, { code: true });
    assert.doesNotMatch(body, /fetch\(|_invokeCapped\(|invoke\(|XMLHttpRequest|WebSocket/,
      `${name} 里出现了网络/后端调用——预取只许「预填候选等点头」或「指路事实」，IDE 不代跑`);
  }
});
