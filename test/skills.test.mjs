// Skills：让模型知道有哪些技能，并且能按需读正文。
//
// 症结不是"技能没实现"，是**模型看不见它们**。在此之前技能只有一条路进上下文：用户在面板里
// 手动打开开关，然后那个技能的正文被塞进系统提示词。没打开的技能，模型从头到尾不知道存在。
//
// 拿这台机器的真实情况量过：~/.cursor/skills 下 11 个技能，
//   · 目录（每个技能一行 name + description）= 3108 字符 ≈ 970 token
//   · 全部正文加起来          = 105247 字符 ≈ 33k token
// 差 34 倍。所以目录常驻、正文按需——这正是 Anthropic Agent Skills 的渐进式披露。
import test from "node:test";
// 2026-08-26 搬进了 src/agent/skill-doc.js —— 直接 import 真模块，不再抠源码
// （抠源码验得到行为，验不到它在真实调用链上还在不在）。
import { parseSkillDocument as _parseSkillDoc } from "../src/agent/skill-doc.js";
import assert from "node:assert/strict";
import fs from "node:fs";
// 按名字取真源码 + 注入依赖跑起来，只有一份实现：test/helpers/source.mjs。
import { fnSource as extractFn, load, SRC } from "./helpers/source.mjs";

// SRC 来自共享的 helpers/source.mjs：它把 main.js 和 **src/agent/ 下的每一个模块**
// 拼起来。这里原来手抄了一份「main.js + tool-catalog.js」的拼接，于是每从 main.js
// 搬出一块新模块，这个文件就会以「这段代码不见了」的形式假红一次——2026-08-26 搬
// _TOOL_ALIASES 时就是这样：别名表还在，只是搬进了 src/agent/tool-aliases.js。
// 手抄的拼接名单必须跟着每次搬家改，共享的那份不用。


const SKILLS = [
  { id: "file:/s/a/SKILL.md", name: "ui-ux-pro-max", desc: "UI/UX design intelligence: styles, palettes, font pairings.", prompt: "A".repeat(44_000) },
  { id: "file:/s/b/SKILL.md", name: "systematic-debugging", desc: "Root-cause a failure instead of guessing.", prompt: "B".repeat(9_000) },
  { id: "file:/s/c/SKILL.md", name: "writing-plans", desc: "", prompt: "C".repeat(500) },
];

const catalog = (active = []) => load("_skillCatalogBlock", {
  _loadSkillsLocal: () => [],
  _fileSkills: SKILLS,
  _isSkillActive: (s) => new Set(active).has(typeof s === "string" ? s : s?.id),
})();

const TOOL_ICONS_SRC = fs.readFileSync(new URL("../src/agent/tool-icons.js", import.meta.url), "utf8");

test("模型不用任何手动操作就能看到全部技能——这是缺的那一半", () => {
  const out = catalog();
  for (const s of SKILLS) assert.ok(out.includes(s.name), `目录里少了 ${s.name}`);
  assert.match(out, /read_skill/, "要告诉模型正文怎么取");
});

test("目录只放 name + description，不放正文——正文贵 34 倍", () => {
  const out = catalog();
  assert.ok(!out.includes("A".repeat(200)), "正文不该出现在目录里");
  assert.ok(out.length < 1200, `目录不该这么大：${out.length}`);
  assert.match(out, /UI\/UX design intelligence/);
});

test("常驻技能在目录里标出来，免得模型再去读一遍它已经拿到的东西", () => {
  const out = catalog(["file:/s/b/SKILL.md"]);
  assert.match(out, /systematic-debugging（常驻）/);
  assert.ok(!/ui-ux-pro-max（常驻）/.test(out), "没常驻的不该带这个标记");
});

test("没写 description 的技能也列出来，不能因为缺字段就从清单里消失", () => {
  assert.match(catalog(), /writing-plans：（没写说明）/);
});

test("一个技能都没有时目录是空串，不往提示词里塞一个空标题", () => {
  assert.equal(load("_skillCatalogBlock", { _loadSkillsLocal: () => [], _fileSkills: [], _isSkillActive: () => false })(), "");
});

test("技能特别多时目录有上限，并说清楚少列了几个", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `file:/s/${i}`, name: `skill-${i}`, desc: "X".repeat(400), prompt: "p",
  }));
  const out = load("_skillCatalogBlock", { _loadSkillsLocal: () => [], _fileSkills: many, _isSkillActive: () => false })();
  assert.ok(out.length <= 6_400, `目录超预算：${out.length}`);
  assert.match(out, /另有 \d+ 个技能未列出/);
});

test("单条 description 再长也会被截住——有人写了 914 字符的", () => {
  const out = load("_skillCatalogBlock", {
    _loadSkillsLocal: () => [], _isSkillActive: () => false,
    _fileSkills: [{ id: "x", name: "n", desc: "Z".repeat(3000), prompt: "p" }],
  })();
  assert.ok(out.length < 700, `单条没截住：${out.length}`);
});

// ── read_skill：按需取正文 ────────────────────────────────────────────────

test("按名字找技能：大小写、空格、连字符、斜杠都不挑", () => {
  const find = load("_findSkillByName");
  const hit = (q) => find(SKILLS, q)?.name || null;
  assert.equal(hit("ui-ux-pro-max"), "ui-ux-pro-max");
  assert.equal(hit("UI UX Pro Max"), "ui-ux-pro-max", "模型多半会照着说话的习惯写");
  assert.equal(hit("UI/UX_Pro_Max"), "ui-ux-pro-max");
  assert.equal(hit("debugging"), "systematic-debugging", "记住半个名字也该找得到");
});

test("找不到就是找不到，不能随便糊一个给模型", () => {
  const find = load("_findSkillByName");
  assert.equal(find(SKILLS, "根本不存在的技能"), null);
  assert.equal(find(SKILLS, ""), null);
  assert.equal(find(SKILLS, "u"), null, "一个字母不该命中 ui-ux-pro-max，那样等于乱猜");
  assert.equal(find([], "ui-ux-pro-max"), null);
});

test("模型把工具名写错也认——别让它卡在一个纯命名问题上", () => {
  // 切到声明结束为止，别用固定字符数——这张表的每一行都塞了十几个别名，很长。
  const aliasStart = SRC.indexOf("const _TOOL_ALIASES");
  const aliases = SRC.slice(aliasStart, SRC.indexOf("\n};", aliasStart));
  for (const alias of ["skill", "load_skill", "use_skill", "get_skill", "open_skill", "readskill"]) {
    assert.ok(aliases.includes(alias + ': "read_skill"'), `缺别名 ${alias}`);
  }
  assert.match(SRC, /case "read_skill": return \{ type: "skill", name:/);
});

test("read_skill 是只读工具：不弹审批，只读模式里也能用", () => {
  const readOnly = SRC.slice(SRC.indexOf("const _READ_ONLY_TYPES"), SRC.indexOf("const _READ_ONLY_TYPES") + 600);
  assert.match(readOnly, /"skill"/, "skill 类型必须在只读白名单里，否则 explorer/plan 模式用不了");
  const readTools = SRC.slice(SRC.indexOf("const _READ_TOOLS ="), SRC.indexOf("const _READ_TOOLS =") + 600);
  assert.match(readTools, /"read_skill"/, "子智能体也该能照着团队规范做事");
});

test("客户端和网关两份工具目录都得有 read_skill——只改一边等于没改", () => {
  assert.match(SRC, /name: "read_skill"/);
  const gateway = JSON.parse(fs.readFileSync("../server/prompts/tools.json", "utf8"));
  assert.ok(gateway.some((t) => t?.function?.name === "read_skill"),
    "网关 prompts/tools.json 里没有 read_skill：L0 模式下工具描述以网关那份为准");
});

test("技能被截断时要指出完整内容怎么取，不能只说一句「已截断」", () => {
  const block = load("_activeSkillsBlock", {
    _activeSkillIds: new Set(["big"]),
    _fileSkills: [],
    _loadSkillsLocal: () => [{ id: "big", name: "ui-ux-pro-max", prompt: "A".repeat(44_000) }],
    parentDir: (p) => p,
  })();
  assert.match(block, /read_skill/);
  assert.match(block, /ui-ux-pro-max/);
});

test("组合块 = 目录 + 常驻全文，两个注入点用的都是它", () => {
  assert.match(SRC, /function _skillsSystemBlock\(\) \{\s*return _skillCatalogBlock\(\) \+ _activeSkillsBlock\(\);/);
  assert.match(SRC, /run\?\.skillsBlock \?\? _skillsSystemBlock\(\)/);
});

test("聊天模式只给常驻技能的正文，不给指向 read_skill 的目录", () => {
  // 聊天那条路径不执行工具：模型吐出来的调用会被当成 [TOOL:…] 文本渲染掉。
  // 给它一份写着「需要哪个就用 read_skill 读」的目录，等于指着一条死路。
  // 常驻技能的正文不需要任何工具，所以照给。
  assert.match(SRC, /const skillsBlock = effectiveMode === "chat" \? _activeSkillsBlock\(\) : _skillsSystemBlock\(\)/,
    "聊天模式还在收整份技能目录");
});

test("聊天模式不发 MCP 名录——那段话会直接指使模型编造它做过的操作", () => {
  const at = SRC.indexOf("const mcpBlock = _mcpAvailabilitySystemContext(mcpSnapshot)");
  assert.ok(at > 0, "找不到 MCP 名录的注入点");
  const before = SRC.slice(Math.max(0, at - 400), at);
  assert.match(before, /effectiveMode !== "chat"/,
    "聊天模式仍在收 MCP 名录，而那段话写着「按名字直接调用」「别回复用户说做不到」");
  // 失败诊断和名录在同一个 chat 闸门后面：聊天模式不执行工具，说"某个服务连不上"
  // 对它没有任何可操作性，只是白占上下文。
  const block = SRC.slice(at, at + 1400);
  assert.match(block, /_mcpFailureSystemContext\(mcpSnapshot\?\.failed\)/,
    "连不上的服务没告诉模型——它只会回一句「我做不到」，说不出为什么");
});

test("冷启动首轮不会漏掉磁盘上的技能", () => {
  // 文件技能靠 _idleRun 异步发现。开完工作区立刻提问时它还没跑完，技能目录里就只剩
  // localStorage 那批——模型看不见的技能等于不存在，且没有任何报错。这条钉住首轮的等待。
  const send = extractFn("sendPrompt");
  const at = send.indexOf("const skillsBlock =");
  assert.ok(at > 0, "找不到技能块的构建点");
  const before = send.slice(0, at);
  assert.match(before, /_fileSkillsCacheKey/,
    "构建技能块之前必须判断磁盘技能是否已经发现过");
  assert.match(before, /await Promise\.race\(\[[\s\S]{0,400}_refreshFileSkills\(/,
    "首轮必须等一次目录扫描，且要带超时——不能无限期阻塞这一轮");
  // MCP 预热和技能扫描共用这一次等待：名录（_mcpAvailabilitySystemContext）是在这之后、
  // run 开始之前算的，预热没落地它就是空串——首轮模型连"有哪些服务"都不知道。
  assert.match(before, /await Promise\.race\(\[[\s\S]{0,400}_warmMcpTools\(/,
    "首轮没等 MCP 预热，冷启动第一轮的服务名录会是空的");
  // 等了还得算在等之后：名录曾经写在这次等待**之前**，等到了也没人回头重算，白等。
  assert.ok(before.indexOf("_mcpAvailabilitySystemContext(mcpSnapshot)") > before.indexOf("_warmMcpTools(_curRoot"),
    "MCP 名录在预热等待之前就算完了——冷启动首轮等到了也是空名录");
  assert.match(before, /setTimeout\(resolve, \d+\)/,
    "等待必须有上界");
});

// ── read_skill 必须真的在开局工具窗口里 ───────────────────────────────────────
//
// 上面那些测试保证了「模型看得见有哪些技能」。但看得见不等于读得到：技能清单里写着
// 「需要哪个就用 `read_skill` 读它的完整内容再照做」，而 read_skill 不在任何一个
// roleCoreMap 里、末尾也没人推它——那句话指向一个从没声明过的函数。工具调用是按声明
// 列表出的，模型只能先花一轮 search_tools 把 schema 取回来（提示词里从没提过要这么做），
// 或者干脆放弃、凭记忆自己写。清单列了 28 个技能却一个都读不到，就是这一环断的。
function selectWith({ skills = [], mode = "agent", includeWrite = true } = {}) {
  const READ_SKILL = { type: "function", function: { name: "read_skill", parameters: {} } };
  const CORE = ["read_file", "list_dir", "search", "find_files", "update_plan", "ask_user",
                "write_file", "edit_file", "multi_edit", "run_cmd", "get_diagnostics", "git_diff"]
    .map((n) => ({ type: "function", function: { name: n, parameters: {} } }));
  const fn = load("_selectInitialTools", {
    _buildAgentToolSchemas: () => [...CORE, READ_SKILL],
    _mcpServersForInitialWindow: () => new Map(),
    _SEARCH_TOOLS_SCHEMA: { type: "function", function: { name: "search_tools", parameters: {} } },
    _fileSkills: skills,
    _loadSkillsLocal: () => [],
  });
  return fn(includeWrite, "", [], mode).map((t) => t.function.name);
}

const ONE_SKILL = [{ id: "file:/s/a/SKILL.md", name: "pdf", desc: "PDF 处理", prompt: "做 PDF" }];

for (const mode of ["agent", "plan", "explorer", "reviewer"]) {
  test(`装了技能，${mode} 模式的开局窗口里就有 read_skill——否则提示词在指一个没声明的函数`, () => {
    const names = selectWith({ skills: ONE_SKILL, mode, includeWrite: mode === "agent" });
    assert.ok(names.includes("read_skill"),
      `${mode} 模式没把 read_skill 放进窗口，技能清单里那句「用 read_skill 读」就是空头支票`);
  });
}

test("一个技能都没有时不放 read_skill——不给模型一个永远返回空的工具", () => {
  const names = selectWith({ skills: [], mode: "agent" });
  assert.ok(!names.includes("read_skill"), "没有技能却把 read_skill 塞进了窗口");
});

test("只有名字没有正文的技能不算数——它读回来也是空的", () => {
  const names = selectWith({ skills: [{ id: "x", name: "空的", desc: "", prompt: "   " }] });
  assert.ok(!names.includes("read_skill"), "空技能不该让 read_skill 进窗口");
});

test("判据必须便宜——不能在开局选工具时去拼整份技能目录", () => {
  // _selectInitialTools 每次 _syncAgentToolWindowToProfile 都会重跑；_skillCatalogBlock()
  // 会加载全部技能、去重、拼最多 6KB 字符串。在这里调它等于每轮多付一次全量扫描。
  // 只看代码，不看注释——注释里提到这个名字是解释「为什么不用它」，不是调用。
  const src = extractFn("_selectInitialTools")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/_skillCatalogBlock\s*\(/.test(src),
    "开局选工具里不该调 _skillCatalogBlock——只该问「有没有技能」");
});

test("read_skill 的 schema 取自已构建的目录，不另写一份字面量", () => {
  // 发布构建会剥掉描述、L0 网关会回填描述。自己拼一份就会和其余工具走两条路，
  // 出现「别的工具没描述、就它有」这种不一致。
  const src = extractFn("_selectInitialTools");
  assert.match(src, /all\.find\(\(t\) => t\?\.function\?\.name === "read_skill"\)/,
    "read_skill 的 schema 必须从 all 里取");
});

// ── SKILL.md 的 YAML 折叠标量 ────────────────────────────────────────────────
//
// Anthropic 官方那批技能大量这么写描述：
//     description: >-
//       Use this skill when the user wants to create, read or edit Word documents.
// 逐行抠 `description:` 后面那截，抠到的是指示符本身 ">-"。它非空，于是被当成描述用了，
// 连带「没写描述就退回一级标题」也永远不触发。模型看到的清单是 `- docx：>-`——
// 它据此判断这个技能干什么用，什么也判断不出来。
const parseSkill = _parseSkillDoc;

test("description: >- 的正文在后面几行，要接着读完", () => {
  const s = parseSkill(`---
name: docx
description: >-
  Use this skill when the user wants to create,
  read or edit Word documents.
---
正文`, "/s/docx/SKILL.md");
  assert.equal(s.desc, "Use this skill when the user wants to create, read or edit Word documents.");
});

test("| 保留换行，> 折成空格——两种指示符行为不同", () => {
  const folded = parseSkill(`---
description: >
  一行
  两行
---
x`, "/s/a/SKILL.md");
  assert.equal(folded.desc, "一行 两行");
  const literal = parseSkill(`---
description: |
  一行
  两行
---
x`, "/s/b/SKILL.md");
  // 清单那边会把空白压平，所以这里断言两个词都在、且没粘成一个。
  assert.match(literal.desc, /一行 两行/);
});

test("指示符可以带显式缩进位和行尾注释：|2 # 说明", () => {
  const s = parseSkill(`---
description: |2 # 这是注释
  真正的描述
---
x`, "/s/c/SKILL.md");
  assert.equal(s.desc, "真正的描述");
  assert.ok(!s.desc.includes("#"), "把行尾注释当成描述了");
});

test("嵌在别的键下面的块标量不会把后面的内容一起吞掉", () => {
  const s = parseSkill(`---
name: real-name
metadata:
  description: >-
    嵌套的说明
---
x`, "/s/d/SKILL.md");
  assert.equal(s.name, "real-name", "嵌套块把后面的 name 吞了");
});

test("写坏的块标量退回一级标题，而不是把 >- 当描述", () => {
  const s = parseSkill(`---
description: >-
---
# 这个技能是干这个的`, "/s/e/SKILL.md");
  assert.equal(s.desc, "这个技能是干这个的");
});

test("allowed-tools 两种写法都解析出来：行内和列表", () => {
  const inline = parseSkill(`---
allowed-tools: read_file, run_cmd
---
x`, "/s/f/SKILL.md");
  assert.deepEqual(inline.tools, ["read_file", "run_cmd"]);
  const listed = parseSkill(`---
allowed-tools:
  - read_file
  - write_file
---
x`, "/s/g/SKILL.md");
  assert.deepEqual(listed.tools, ["read_file", "write_file"]);
});

test("没写 allowed-tools 就不带这个字段——不是空数组", () => {
  const s = parseSkill(`---
name: x
---
y`, "/s/h/SKILL.md");
  assert.ok(!("tools" in s), "没声明工具却带了 tools 字段");
});

// ── 登录不能吞掉离线攒的技能 ─────────────────────────────────────────────────
//
// 服务端对「这个账号从没同步过」和「这个账号把技能全删了」返回的是同一个 []。
// 照单全收就等于：离线用了半年的自定义技能，登录那一刻全没，本地缓存也被写成空的。
function skillsSync({ remote, local, syncedAccounts = [], account = "me@x.com" }) {
  const store = new Map([
    ["michael-ide.skills.v1", JSON.stringify(local)],
    ["michael-ide.skills.synced.v1", JSON.stringify(syncedAccounts)],
  ]);
  const puts = [];
  const deps = {
    _skillsApi: async (method, body) => { if (method === "GET") return remote; puts.push(body); return true; },
    _loadSkillsLocal: () => JSON.parse(store.get("michael-ide.skills.v1") || "[]"),
    _saveSkillsLocal: (l) => store.set("michael-ide.skills.v1", JSON.stringify(l)),
    _saveSkills: async (l) => { puts.push(l); store.set("michael-ide.skills.v1", JSON.stringify(l)); },
    _loggedInEmail: account,
    _SKILLS_SYNCED_KEY: "michael-ide.skills.synced.v1",
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  deps._skillsSyncedAccounts = load("_skillsSyncedAccounts", deps);
  deps._markSkillsSynced = load("_markSkillsSynced", deps);
  return { run: load("_loadSkills", deps), puts, store };
}

test("首次登录时服务端的空清单不能抹掉本地技能——反而要把本地那份传上去", async () => {
  const mine = [{ id: "a", name: "我的技能", prompt: "x" }];
  const s = skillsSync({ remote: [], local: mine });
  const got = await s.run();
  assert.deepEqual(got, mine, "登录把离线攒的技能吞了");
  assert.deepEqual(JSON.parse(s.store.get("michael-ide.skills.v1")), mine, "本地缓存也被写空了");
  assert.deepEqual(s.puts.at(-1), mine, "没有把本地那份认领到账号上");
});

test("已经同步过的账号，服务端的空清单就是真的「我删光了」——这时它该赢", async () => {
  // 不然在另一台设备上删技能永远同步不过来。
  const s = skillsSync({ remote: [], local: [{ id: "a", name: "旧的", prompt: "x" }], syncedAccounts: ["me@x.com"] });
  assert.deepEqual(await s.run(), []);
  assert.deepEqual(JSON.parse(s.store.get("michael-ide.skills.v1")), []);
});

test("服务端有内容就整份替换，不按 id 合并", async () => {
  // 合并的话，在另一台设备上删掉的那个会从本地缓存里复活。
  const s = skillsSync({ remote: [{ id: "b", name: "服务端的", prompt: "y" }], local: [{ id: "a", name: "本地的", prompt: "x" }] });
  assert.deepEqual((await s.run()).map((v) => v.id), ["b"]);
});

test("没登录 / 请求失败时用本地那份，不动缓存", async () => {
  const mine = [{ id: "a", name: "我的", prompt: "x" }];
  const s = skillsSync({ remote: null, local: mine });
  assert.deepEqual(await s.run(), mine);
  assert.equal(s.puts.length, 0, "失败路径不该发起写入");
});

// ── 同名技能的优先级必须确定 ─────────────────────────────────────────────────

test("扫描按来源分桶收集，再按来源顺序拼接——不是共用一个数组抢先到先得", () => {
  const src = extractFn("_refreshFileSkills");
  assert.match(src, /const perBase = bases\.map\(\(\) => \[\]\)/,
    "还在共用一个 found 数组：同名技能谁生效取决于哪次磁盘读先返回");
  assert.match(src, /perBase\.flat\(\)/, "没有按来源顺序拼接");
  const at = src.indexOf("perBase.flat()");
  const after = src.slice(at);
  assert.match(after, /\.sort\(/, "拼接之后要靠稳定排序保住来源优先级");
});

test("扫描预算用尽时丢掉的数量要记下来，并算进清单的「另有 N 个」", () => {
  assert.match(extractFn("_refreshFileSkills"), /_fileSkillsDropped = dropped/,
    "扫描丢了技能却没记账");
  const cat = extractFn("_skillCatalogBlock");
  assert.match(cat, /_fileSkillsDropped/, "清单没有把扫描丢掉的算进去");
  assert.match(cat, /typeof _fileSkillsDropped === "number"/,
    "要用 typeof 守卫，否则被单独 eval 时会抛 ReferenceError 并被吞成空清单");
});

// ── 技能卡：让用户看得出用了哪个技能，以及**为什么** ─────────────────────────
//
// 用户的原话：「用到技能这些功能的时候，也要说明理由，现在的理由感觉很差」。
// 查下来是两件事叠在一起：
//   1. skill 不在标签表里 → 行里直接显示 "skill"；typeIcons 也没有 skill 键 →
//      回落成**读文件**那张纸。界面上和"读了个文件"完全无法区分。
//   2. 「为什么用它」这个信息**根本不存在**——read_skill 只有一个 name 参数。
// 所以理由必须由模型声明出来，而不是我们从它的措辞里去猜（那正是这个项目
// 明确不做的事）。

test("read_skill 必须让模型声明 why——不然「理由」这个信息压根不存在", () => {
  const i = SRC.indexOf('name: "read_skill"');
  const schema = SRC.slice(i, i + 2200);
  assert.match(schema, /why: \{ type: "string"/, "没有 why 参数，卡片上永远不会有理由");
  assert.match(schema, /required: \["name", "why"\]/, "why 不是必填，模型多半就不写了");
});

test("why 的说明要教模型写给用户看，而不是复述技能自己的介绍", () => {
  // 这段描述就是整个机制本身——写得含糊，模型就会回一句「为了更好地完成任务」。
  const i = SRC.indexOf('why: { type: "string", description: "');
  const desc = SRC.slice(i, SRC.indexOf('" } }', i));
  assert.match(desc, /shown to the user verbatim/, "没告诉模型这句会原样给用户看");
  assert.match(desc, /Never restate the skill's own description/, "没禁止复述技能自述");
  assert.match(desc, /为了更好地完成任务/, "没有把套话作为反例点名");
});

test("客户端和网关两份都要有 why——L0 模式下模型看的是网关那份", () => {
  const gateway = JSON.parse(fs.readFileSync("../server/prompts/tools.json", "utf8"));
  const rs = gateway.find((t) => t?.function?.name === "read_skill");
  assert.ok(rs, "网关里没有 read_skill");
  assert.ok(rs.function.parameters?.properties?.why,
    "网关那份没有 why：L0 下模型看不到这个字段，用户永远等不到理由");
  assert.deepEqual(rs.function.parameters.required, ["name", "why"]);
});

test("模型写了 why 就用它；没写才退回技能自述，而且要标明这是两个作者", () => {
  const why = load("_toolStepWhyLine", {
    _findSkillByName: () => ({ name: "docx", desc: "处理 Word 文档" }),
    _loadSkillsLocal: () => [], _fileSkills: [],
  });
  const declared = why({ type: "skill", name: "docx", why: "用户要把周报导出成 .docx" });
  assert.equal(declared.k, "为什么");
  assert.equal(declared.self, false, "模型声明的理由不该被标成第三方自述");
  assert.match(declared.text, /周报/);

  const fallback = why({ type: "skill", name: "docx" });
  assert.equal(fallback.k, "技能自述", "退回自述时必须换眉标——两句话不是一个作者写的");
  assert.equal(fallback.self, true);
});

test("既没声明也没自述时，这一行整个不画——不留空标题，也不写「未说明原因」", () => {
  const why = load("_toolStepWhyLine", {
    _findSkillByName: () => null, _loadSkillsLocal: () => [], _fileSkills: [],
  });
  assert.equal(why({ type: "skill", name: "x" }), null);
});

test("技能卡不拿技能自述去顶「模型声明的选用理由」那一栏", () => {
  const card = load("_skillToolCardHtml", { _escHtml: (s) => String(s), _isSkillActive: () => false });
  const html = card({ type: "skill", name: "docx" },
    { name: "docx", desc: "处理 Word 文档", sourcePath: "/s/SKILL.md", baseDir: "/s" },
    { shown: 10, total: 10, excerpt: "x" });
  assert.ok(!html.includes("模型声明的选用理由"), "没有声明却画出了理由段——空标题比没有更像坏了");
  assert.ok(html.includes("处理 Word 文档"), "技能自述该在，但只能在它自己那一栏");
});

test("技能卡在行上有专属图标和中文标签，不再和「读文件」长一个样", () => {
  // 图标表已搬进 src/agent/tool-icons.js（整套换成描边图形）。判据不变：技能得有自己的图形。
  assert.match(TOOL_ICONS_SRC, /\n  skill: '/, "图标表里没有 skill —— 会回落成兜底的文件图");
  assert.match(SRC, /skill: "读取技能"/, "labels 表没有 skill，行里会直接显示 skill");
  assert.match(SRC, /: call\.type === "skill"\s*\n\s*\/\/[^\n]*\n\s*\? String\(call\.name \|\| ""\)/,
    "技能名没进路径位——行里显示的还是那一长串 sourcePath");
});
