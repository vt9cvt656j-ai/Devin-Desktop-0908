// 核心记忆（src/agent/core-memory.js）的真往返：写 / 判重 / 作废 / 上限 / 渲染 / 升格 / 文件往返。
// 直接 import 模块，存储用内存桩。每条断言对应文件头注释里的一条线。
import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCoreMemory, coreUpsert, coreActive, coreSupersede, coreReplaceAll,
  renderCoreBlock, corePromoteNote, shouldPromote, coreMarkdownSection, coreImportMarkdown,
  coreStats, CORE_LIMITS, CORE_AGENT_MARK, coreKey, coreSimilarity,
} from "../src/agent/core-memory.js";

function fresh() {
  const m = new Map();
  const mirrored = [];
  configureCoreMemory({
    storage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) },
    mirror: async (k, v) => { mirrored.push([k, v.length]); },
  });
  return { m, mirrored };
}

test("写入 → 现役；同义（≥0.8）不重复只计 seen；用户重申模型记的会升格为用户的", () => {
  fresh();
  const a = coreUpsert("", { text: "回复用中文", kind: "preference", source: "agent" });
  assert.ok(a && a.id);
  const b = coreUpsert("", { text: "回复用中文。", kind: "preference", source: "user" });
  assert.equal(b.id, a.id, "同一句话记成了两条");
  const [only] = coreActive("");
  assert.equal(only.source, "user", "用户亲口重申之后仍被当成模型记的");
  assert.equal(only.seen, 1);
});

test("supersede：旧条不再现役但还在（审计），新条接替；面板清空同理", () => {
  fresh();
  const old = coreUpsert("/repo", { text: "包管理器用 npm", kind: "rule", source: "user" });
  const nu = coreSupersede("/repo", old.id, "包管理器用 pnpm，别用 npm", "user");
  assert.ok(nu);
  assert.deepEqual(coreActive("/repo").map((e) => e.text), ["包管理器用 pnpm，别用 npm"]);
  assert.equal(coreStats("/repo").superseded, 1, "被作废的应留作审计");
  // 删除走面板重建那条路（没有单独的 remove：一条路，少一个入口少一处漂）
  assert.equal(coreReplaceAll("/repo", []), 0);
  assert.equal(coreActive("/repo").length, 0);
});

test("上限：先淘汰模型记的，用户说的最后才轮到；条数和字数任一超都淘汰", () => {
  fresh();
  const lim = CORE_LIMITS.project;
  // 夹具的句子必须真的各不相同：模板句只换一个数字会被判重合并（那是对的行为，不是这条要测的）。
  const TOPICS = ["日志走 pino", "接口前缀 /api/v2", "金额用分存", "构建用 vite", "测试用 vitest", "样式用 tailwind",
    "状态用 zustand", "路由用 react-router", "数据库用 postgres", "缓存用 redis", "队列用 bullmq", "部署到 fly"];
  for (let i = 0; i < lim.entries; i++) coreUpsert("/p", { text: `模型笔记：${TOPICS[i]}`, source: "agent", created: 1000 + i });
  coreUpsert("/p", { text: "用户亲口说的：接口前缀 /api/v2", source: "user", created: 5 });
  coreUpsert("/p", { text: "又一条新的模型笔记，会把最老的模型笔记挤掉", source: "agent", created: 9999 });
  const active = coreActive("/p");
  assert.ok(active.length <= lim.entries, "超上限了");
  assert.ok(active.some((e) => e.text.startsWith("用户亲口说的")), "用户说的被淘汰了，而模型记的还在");
  assert.ok(!active.some((e) => e.text === "模型笔记：日志走 pino"), "最老的模型笔记该先走");
  // 字数上限：一条超长的也不能让整块超预算
  fresh();
  for (let i = 0; i < 8; i++) coreUpsert("/q", { text: `${i} ` + "很长的约束".repeat(40), source: "agent" });
  const chars = coreActive("/q").reduce((n, e) => n + e.text.length, 0);
  assert.ok(chars <= CORE_LIMITS.project.chars + 220, `字数没被压住：${chars}`);
});

test("渲染是纯函数：同一份条目逐字节相同；空的返回空串；用户条在前、模型条带标记在后", () => {
  fresh();
  assert.equal(renderCoreBlock(""), "", "没内容也在付每轮的钱");
  coreUpsert("", { text: "不要用黄色", source: "user", created: 2 });
  coreUpsert("", { text: "读不到文件就用 rg 找", source: "agent", created: 1 });
  const r1 = renderCoreBlock("");
  const r2 = renderCoreBlock("");
  assert.equal(r1, r2);
  assert.ok(r1.includes("【核心记忆·用户】"));
  assert.ok(r1.indexOf("- 不要用黄色") < r1.indexOf(`- ${CORE_AGENT_MARK} 读不到文件就用 rg 找`), "模型记的排到用户前面了");
  assert.doesNotMatch(r1, /\d{10,}|c[a-z0-9]{8,}/, "渲染里混进了时间戳或 id，前缀缓存每轮都会破");
  // 组内按种类：目标最前，其次规矩、偏好、事实——目标是框架，读的人该第一眼看到。
  coreUpsert("", { text: "金额用分存", kind: "fact", source: "user", created: 3 });
  coreUpsert("", { text: "目标：做一个电影站", kind: "goal", source: "user", created: 4 });
  const r3 = renderCoreBlock("");
  assert.ok(r3.indexOf("目标：做一个电影站") < r3.indexOf("不要用黄色") && r3.indexOf("不要用黄色") < r3.indexOf("金额用分存"), `种类排序不对：\n${r3}`);
  // 项目块标题不同
  coreUpsert("/r", { text: "目标：做一个电影站", source: "user" });
  assert.ok(renderCoreBlock("/r").includes("【核心记忆·本项目】"));
});

test("升格：只有偏好/约定类且不是机器档案的 KG 笔记进核心；被升格的能在核心里找到", () => {
  fresh();
  assert.equal(shouldPromote({ type: "pitfall", content: "别用 sed 改 JSON" }), false);
  assert.equal(shouldPromote({ type: "preference", content: "项目环境: Python venv 在 .venv" }), false);
  assert.equal(shouldPromote({ type: "preference", content: "〔跨轮规律〕xxx" }), false);
  assert.ok(shouldPromote({ type: "convention", content: "组件放 src/components" }));
  const e = corePromoteNote("/repo", { type: "preference", content: "[运行中记下] 按钮统一圆角", created: 7 });
  assert.ok(e);
  assert.equal(e.text, "按钮统一圆角", "升格时没把来源戳剥掉");
  assert.equal(e.kind, "preference");
  assert.equal(coreActive("/repo")[0].created, 7, "升格应保留原笔记的时间，否则排序会乱");
});

test("面板整体重建：文本没变的保留 id 和来源，删掉的作废，新行按用户来源新增", () => {
  fresh();
  const a = coreUpsert("/repo", { text: "接口前缀 /api/v2", source: "agent" });
  coreUpsert("/repo", { text: "金额用分存", source: "user" });
  const n = coreReplaceAll("/repo", ["接口前缀 /api/v2", "- 新加的一条：日志走 pino"]);
  assert.equal(n, 2);
  const act = coreActive("/repo");
  assert.equal(act.find((e) => e.text === "接口前缀 /api/v2")?.id, a.id, "没变的行换了 id");
  assert.equal(act.find((e) => e.text === "接口前缀 /api/v2")?.source, "agent", "没变的行被洗成了用户说的");
  assert.ok(!act.some((e) => e.text === "金额用分存"), "删掉的行还现役");
  assert.equal(act.find((e) => e.text.includes("pino"))?.source, "user");
});

test("memory.md 往返：写出一节、读回同样的条目；模型记的标记在往返里保留", () => {
  fresh();
  coreUpsert("/repo", { text: "目标：电影站", source: "user" });
  coreUpsert("/repo", { text: "读不到就用 rg", source: "agent" });
  const md = "# 项目记忆\n\n" + coreMarkdownSection("/repo") + "\n\n## 项目事实（实时扶正）\n\n- 别的东西\n";
  fresh();
  assert.equal(coreImportMarkdown("/repo", md), 2);
  const act = coreActive("/repo");
  assert.equal(act.find((e) => e.text === "读不到就用 rg")?.source, "agent");
  assert.equal(act.find((e) => e.text === "目标：电影站")?.source, "user");
  assert.ok(!act.some((e) => e.text === "别的东西"), "读到别的节去了");
});

test("镜像：每次持久化都调宿主的 mirror，键和 localStorage 一致；坏 JSON 当空表", () => {
  const { m, mirrored } = fresh();
  coreUpsert("", { text: "回复用中文", source: "user" });
  assert.ok(mirrored.length >= 1 && mirrored[0][0] === coreKey(""));
  m.set(coreKey(""), "{not json");
  assert.deepEqual(coreActive(""), []);
});

test("coreSimilarity 和内部判重同一把尺子：同义高、换话题低", () => {
  assert.ok(coreSimilarity("回复用中文", "回复用中文。") >= 0.8);
  assert.ok(coreSimilarity("目标：做一个二手书交易网站", "目标：做一个二手书交易网站，先做首页") >= 0.5, "目标演进应判成同一件事");
  assert.ok(coreSimilarity("目标：做一个电影站", "金额用分存") < 0.2);
});
