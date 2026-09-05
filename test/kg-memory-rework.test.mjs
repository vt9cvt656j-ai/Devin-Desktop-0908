// 记忆重做（2026-09-05）里落在 main.js 上的那几处行为：分类、检索、工作流去重、自适应块。
// 都用 load() 按名抠取产品函数跑真行为；数据形状照抄盘上的真实笔记。
// 背景读数（产品所有者的机器）：136 条笔记 60 条被判 pitfall（抽样多为「已完成交付」「项目环境:」），
// 每轮注入 1.8 条相关 + 4.7 条无条件常驻 + 1.6 条顺链，39% 的轮次相关命中为 0。
import test from "node:test";
import assert from "node:assert/strict";
import { load, loadConst } from "./helpers/source.mjs";
import { extractExplicitCorrection } from "../src/conversation-memory.js";
import { judgeDurableUtterance } from "../src/agent/memory-signals.js";

const KG_TOKENS = load("_kgTokens", { _KG_STOP: loadConst("_KG_STOP") });
const classify = load("_kgClassify", {});
const retrieveWith = (notes, extra = {}) => load("_kgRetrieve", {
  _kgSupersededIds: () => new Set(),
  _kgLoad: () => notes,
  _kgTokens: KG_TOKENS,
  _kgKey: () => "k",
  _kgCacheStore: () => {},
  _perfPhase: () => {},
  localStorage: { setItem: () => {} },
  ...extra,
});

test("分类：交付/状态/档案记录是 fact，不再冒充 pitfall 抢常驻名额；偏好排在 pitfall 前面", () => {
  assert.equal(classify("订阅转换中转站项目已完成：后端 Express API 支持 SS/VMess，别的坑都修了"), "fact");
  assert.equal(classify("项目环境: Python venv 在 .venv/；已装依赖: certifi（可能已变动，装包前核实）"), "fact");
  assert.equal(classify("项目档案: Node 项目「x」；npm 脚本: build"), "fact");
  assert.equal(classify("以后一律用 pnpm，别用 npm"), "preference");
  assert.equal(classify("组件统一放在 src/components 目录，命名用 kebab-case"), "convention");
  assert.equal(classify("用 sed 改这个项目的 JSON 会报错，必须先用 node 读一遍"), "pitfall");
  assert.equal(classify("cargo build 之后再 cargo test"), "command");
});

test("检索：常驻名额 ≤4，且已升进核心记忆的（core:true）不再当常驻带——同一句话不进两次", () => {
  const notes = [{ id: "hit", content: "构建用 vite", tags: ["vite", "构建"], type: "fact", created: 1, links: [] }];
  for (let i = 0; i < 6; i++) notes.push({ id: "p" + i, content: "偏好第 " + i, tags: ["偏好" + i], type: "preference", created: 10 + i, links: [] });
  notes.push({ id: "core1", content: "回复用中文", tags: ["中文"], type: "preference", created: 99, links: [], core: true });
  const out = retrieveWith(notes)("/repo", "vite 构建怎么配");
  const carried = out.filter((n) => !out.relevantIds.has(n.id)).map((n) => n.id);
  assert.ok(carried.length <= 4, `常驻带了 ${carried.length} 条：${carried.join(",")}`);
  assert.ok(!carried.includes("core1"), "已在核心块里的偏好又被当常驻带了一遍");
  assert.ok(out.some((n) => n.id === "hit"));
});

test("检索：tag 重合按 IDF 加权——只和一条笔记共享的稀有词，压过满库都有的常见词", () => {
  const notes = [
    { id: "specific", content: "vite 里配 proxy 转发到 8080", tags: ["proxy", "项目"], type: "fact", created: 1, links: [] },
    { id: "generic1", content: "项目是一个电影站", tags: ["项目", "电影"], type: "fact", created: 5, links: [] },
    { id: "generic2", content: "项目用 pnpm", tags: ["项目", "pnpm"], type: "fact", created: 6, links: [] },
    { id: "generic3", content: "项目要部署到 fly", tags: ["项目", "fly"], type: "fact", created: 7, links: [] },
  ];
  // query 同时含「项目」（四条都有）和「proxy」（只有一条有）：按个数四条并列 1 分，按 IDF specific 必须第一。
  const out = retrieveWith(notes)("/repo", "项目 proxy 怎么配");
  assert.equal(out[0].id, "specific", `稀有词没有压过常见词：${out.map((n) => n.id).join(",")}`);
});

test("检索：顺链扩展只从相关命中出发，不从常驻条出发——常驻条的邻居和本轮同样无关", () => {
  const notes = [
    { id: "hit", content: "构建用 vite", tags: ["vite", "构建"], type: "fact", created: 1, links: ["hitnb"] },
    { id: "hitnb", content: "vite 的 proxy 配置", tags: ["proxy"], type: "fact", created: 2, links: ["hit"] },
    { id: "carry", content: "别用黄色", tags: ["黄色"], type: "preference", created: 9, links: ["carrynb"] },
    { id: "carrynb", content: "上次聊到的配色表", tags: ["配色"], type: "fact", created: 3, links: ["carry"] },
  ];
  const ids = retrieveWith(notes)("/repo", "vite 构建怎么配").map((n) => n.id);
  assert.ok(ids.includes("hitnb"), "相关命中的邻居该带上");
  assert.ok(!ids.includes("carrynb"), "常驻条的邻居被顺链带进来了——它和本轮毫无关系");
});

test("工作流：名字不同但步骤几乎一样的合并成一条，保留命中多的；幂等", () => {
  const words = load("_taskWords", { _EP_STOP: loadConst("_EP_STOP") });
  const dedup = load("_wfDedup", { _wmTaskSim: load("_taskSim", { _taskWords: words }), _wmTaskWords: words });
  const steps = ["list_dir 看目录结构", "read_file 读 README 和 package.json", "总结项目用途和技术栈"];
  const wfs = [
    { id: "a", name: "项目探索与远程连接", when: "用户要求查看项目内容时", steps, hits: 1, ts: "2026-08-01" },
    { id: "b", name: "代码库探索与分析", when: "用户要求了解项目结构时", steps: [...steps], hits: 5, ts: "2026-08-02" },
    { id: "c", name: "部署到服务器", when: "用户要求上线时", steps: ["rsync 到服务器", "重启 nginx"], hits: 0, ts: "2026-08-03" },
  ];
  const once = dedup(wfs);
  assert.equal(once.length, 2, `近义工作流没合并：${once.map((w) => w.name).join(" / ")}`);
  assert.equal(once.find((w) => w.steps.length === 3)?.id, "b", "合并时该留命中多的那条");
  assert.equal(once.find((w) => w.id === "b")?.hits, 6, "合并要把命中数累起来");
  assert.deepEqual(dedup(once).map((w) => w.id), once.map((w) => w.id), "去重不幂等");
});

test("自适应块：默认旋钮一行都不写；核心记忆排在最前；规则文本仍在", () => {
  const DEF = loadConst("DEFAULT_ADAPTIVE_PROFILE");
  const knobs = load("_adaptiveKnobLines", { _apDefaults: DEF, _apOptionLabel: (g, v) => `${g}=${v}` });
  assert.equal(knobs({ ...DEF }), "", "全默认还在往系统提示里塞旋钮行");
  assert.match(knobs({ ...DEF, tone: "warm" }), /回答风格：tone=warm/);
  assert.doesNotMatch(knobs({ ...DEF, tone: "warm" }), /细节密度/, "没改的旋钮也被写出来了");
  const block = load("_adaptivePromptBlock", {
    _apLoadProfile: () => ({ ...DEF, enabled: true }),
    _adaptiveCoreBlock: () => "\n\n【核心记忆·用户】\n- 回复用中文\n",
    _adaptiveKnobLines: () => "",
  })();
  assert.ok(block.indexOf("【核心记忆·用户】") < block.indexOf("【自适应用户档案】已开启"), "核心记忆该在自适应说明前面");
  assert.match(block, /用户表达很短、很乱、带情绪/, "自适应理解规则丢了");
  assert.doesNotMatch(block, /用户熟练度：/, "默认档位下不该出现旋钮行");
  assert.equal(load("_adaptivePromptBlock", { _apLoadProfile: () => ({ enabled: false }), _adaptiveCoreBlock: () => "x", _adaptiveKnobLines: () => "" })(), "", "关掉自适应时整块该为空");
});

test("用户原话进核心：普通偏好新增；「以后不是 X，是 Y」把核心里说 X 的那条换掉，旧条不再现役", () => {
  const core = new Map();   // scope → entries
  const active = (scope) => (core.get(scope) || []).filter((e) => !e.gone);
  const calls = { upsert: [], supersede: [], stat: [] };
  const capture = load("_coreCaptureUtterance", {
    judgeDurableUtterance,
    extractExplicitCorrection,
    coreActive: active,
    coreUpsert: (scope, e) => { const r = { id: "c" + calls.upsert.length, ...e }; core.set(scope, [...(core.get(scope) || []), r]); calls.upsert.push([scope, e.text]); return r; },
    coreSupersede: (scope, id, text) => { const old = active(scope).find((e) => e.id === id); old.gone = true; calls.supersede.push([scope, id, text]); const r = { id: "s", text }; core.set(scope, [...core.get(scope), r]); return r; },
    memStat: (k) => calls.stat.push(k),
    _kgMarkCore: () => {},
  });
  assert.ok(capture("/repo", "回复用中文"), "跨项目偏好没进核心");
  assert.deepEqual(calls.upsert, [["", "回复用中文"]]);
  assert.equal(capture("/repo", "帮我修一下登录页"), null, "一次性任务进了核心");
  // 明确纠正：核心里有「用中文」→ 换成新的；不是新增第二条
  const r = capture("/repo", "以后回复不是用中文，是用英文");
  assert.ok(r);
  assert.equal(calls.supersede.length, 1, "明确纠正没有走替换路径");
  assert.equal(calls.upsert.length, 1, "明确纠正被当成了新增一条——旧条会和新条并排出现");
  assert.deepEqual(active("").map((e) => e.text), ["以后回复不是用中文，是用英文"]);
  assert.ok(calls.stat.includes("capture.core.superseded"));
});

test("情景提示事实优先：没 insight 就给改了哪些文件；只读探索轮在有更有料的候选时不露面，单候选照旧", () => {
  const hint = (eps) => load("_episodeHintBlock", { _retrieveEpisodes: () => eps })("改登录页", "/r");
  const files = { outcome: "success", task: "改登录页", insight: "", files: ["/Users/x/proj/src/Login.tsx", "src/api/auth.ts"], approach: "读取 a → 读取 b → 编辑 c → 运行 $ npm test" };
  const readOnly = { outcome: "success", task: "看看登录页", insight: "", approach: "读取 /Users/x/proj/src/App.tsx → 读取 README.md → list src" };
  const withInsight = { outcome: "partial", task: "改登录页样式", insight: "先跑 npm test 再改样式", approach: "…" };
  let out = hint([files]);
  assert.match(out, /改了 Login\.tsx, src\/api\/auth\.ts/, "没 insight 时该给文件，不给动作序列");
  assert.doesNotMatch(out, /读取 a → 读取 b/, "动作序列还是被注入了");
  assert.doesNotMatch(out, /\/Users\//);
  out = hint([readOnly, files, withInsight]);
  assert.doesNotMatch(out, /看看登录页/, "有更有料的候选时，只读探索轮不该占位置");
  assert.match(out, /先跑 npm test 再改样式/);
  out = hint([readOnly]);
  assert.match(out, /App\.tsx/, "单候选时只读轮照旧渲染（现有契约）");
  assert.doesNotMatch(out, /\/Users\//);
  // 撞墙也是事实
  out = hint([{ outcome: "failed", task: "部署", insight: "", walls: ["run_cmd [timeout] ssh 连不上", "x"], approach: "…" }]);
  assert.match(out, /撞墙：run_cmd \[timeout\] ssh 连不上/);
});
