// 22 个专业语料域里，21 个曾经是**路由孤儿**。
//
// 实测到的形状（2026-08-22）：
//   · server/knowledge/ 下有 22 个域、4.3MB 已蒸馏的专业语料，可其中只有 michael-design
//     有专属触发路径。另外 21 个没有任何旗标能把一个任务指过去——语料在盘上，路由是零。
//   · 意图裁决的工程半里没有领域维度（只有 deliverySurface / dataStrategy 这类"做什么形态"
//     的字段），所以画像里也没有领域旗标，网关侧无从按领域挂任何东西。
//   · `knowledge_search`（查自家语料）不在 agent 开局工具窗口里，而 web_search /
//     github_search / github_repo / developer_community_search / package_search 这些查外部的
//     全在。两条路结果差不多时模型走零成本的那条——**弱模型最不肯付「先花一轮 search_tools
//     取 schema」的绕路成本**，于是结构上永远查 GitHub、永远不查自家语料。
//   · michael-design 之所以对弱模型仍然有效，靠的不是语料更好，而是 _runMichaelDesignPreflight
//     在模型规划**之前**就真跑了检索，把命中抽成结构化 brief 喂进去——嚼碎的小抄，不是散文。
//
// 这个文件守三件机制，每件都必须能被反向破坏逮住：
//   ① knowledge_search 进开局窗口（检索自家语料的成本必须和检索外部对等）；
//   ② 领域维度：裁决多一个平字段 domain（白名单归一）→ 画像多一条 domain_<name> 旗标；
//   ③ 专业域小抄：带 domain_* 旗标（且不是 michael-design）时，首个模型回合前把该域语料
//      嚼成结构化小抄注入。有界预算、有上限的等待、每 run 每域一次、零关键词正则。
//
// 全离线：知识库回执用夹具，不发任何网络请求。
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
// 2026-08-30 这三样搬进 src/agent/domain-knowledge-brief.js —— 直接 import 真模块。
import { domainKnowledgeBullets, domainKnowledgeBrief, DOMAIN_KNOWLEDGE_BRIEF_BUDGET } from "../src/agent/domain-knowledge-brief.js";

// 正向源码断言跑在**剥掉注释**的源码上：把一条契约从代码里删掉、只在注释里留一句，
// assert.match 照样绿（本仓库已经这样漏过一整组模型可见的工具契约）。
import { CODE as SRC, fnSource, load, loadConst } from "./helpers/source.mjs";
import { createPreflightCard, settlePreflightCard } from "../src/agent/knowledge-preflight-card.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(HERE, "..", "..", "server", "knowledge");

const DOMAINS = loadConst("_AI_KNOWLEDGE_DOMAINS");
const knowledgeDomain = load("_aiIntentKnowledgeDomain", { _AI_KNOWLEDGE_DOMAINS: DOMAINS });
const semanticProfile = load("_ideSemanticProfile");
const flagDomains = load("_domainKnowledgeFlagDomains", {
  _AI_KNOWLEDGE_DOMAINS: DOMAINS,
  _DOMAIN_KNOWLEDGE_MAX_DOMAINS: loadConst("_DOMAIN_KNOWLEDGE_MAX_DOMAINS"),
});

// ═══════════════════════════════════════════════════════════════════════════
// ① knowledge_search 必须在 agent 开局工具窗口里
// ═══════════════════════════════════════════════════════════════════════════

const schema = (name) => ({ type: "function", function: { name } });
// 一份"什么都有"的注册表：核心表挑得出来的都在里面，挑不出来的用来验证窗口没被撑大。
const FULL_CATALOG = [
  "read_file", "list_dir", "search", "find_files", "update_plan", "ask_user", "think",
  "write_file", "edit_file", "multi_edit", "run_cmd", "run_in_terminal", "read_logs",
  "save_skill", "mcp_server",
  "web_search", "web_fetch", "github_search", "github_repo",
  "developer_community_search", "package_search", "knowledge_search",
  // 以下都不该进开局窗口
  "browser", "screenshot", "db_query", "http_request", "learn_design", "local_discovery",
].map(schema);

function selectInitial(mode = "agent", includeWrite = true) {
  const select = load("_selectInitialTools", {
    activePath: "",
    _SEARCH_TOOLS_SCHEMA: schema("search_tools"),
    _buildAgentToolSchemas: () => FULL_CATALOG,
    // 这条路径上还有「小体量 MCP 服务整服务放行」那一段。上限从源码读，不在这里复述数字。
    _INITIAL_MCP_MAX_TOOLS: loadConst("_INITIAL_MCP_MAX_TOOLS"),
    _INITIAL_MCP_MAX_BYTES: loadConst("_INITIAL_MCP_MAX_BYTES"),
    _utf8ByteLength: load("_utf8ByteLength"),
    _mcpServersForInitialWindow: load("_mcpServersForInitialWindow", {
      _INITIAL_MCP_MAX_TOOLS: loadConst("_INITIAL_MCP_MAX_TOOLS"),
      _INITIAL_MCP_MAX_BYTES: loadConst("_INITIAL_MCP_MAX_BYTES"),
      _utf8ByteLength: load("_utf8ByteLength"),
    }),
    _fileSkills: [],
    _loadSkillsLocal: () => [],
  });
  return select(includeWrite, "随便什么任务", [], mode).map((t) => t.function.name);
}

test("knowledge_search 在 agent 开局窗口里——否则查自家语料永远比查外部贵一轮", () => {
  const names = selectInitial("agent");
  assert.ok(names.includes("knowledge_search"),
    "knowledge_search 不在开局窗口：它要先花一轮 search_tools 取 schema，"
    + "而查外部的那六个零成本可调——模型于是结构性地永远选外部");
});

test("检索成本对等律：窗口里有查外部的，就必须有查自家语料的", () => {
  // 这条才是机制本身。上面那条钉的是结果，这条钉的是**为什么**：不是"多加一个工具好用"，
  // 而是"两条路结果差不多时模型走便宜的那条"这句话不能只朝一个方向生效。哪天有人把
  // knowledge_search 撤出去而外部那批还在，这条会精确地说出代价。
  const names = new Set(selectInitial("agent"));
  const external = ["web_search", "web_fetch", "github_search", "github_repo",
                    "developer_community_search", "package_search"].filter((n) => names.has(n));
  assert.ok(external.length >= 3, "外部检索工具已经不在窗口里了，这条对等断言失去落点");
  assert.ok(names.has("knowledge_search"),
    `窗口里有 ${external.length} 个查外部的工具（${external.join(", ")}），却没有查自家语料的 —— `
    + "同样办得成的两条路，一条零成本、一条要多花一轮，模型永远不会选贵的那条");
});

test("扩的只是这一个，窗口没有被顺手撑大", () => {
  const names = selectInitial("agent");
  for (const deferred of ["browser", "db_query", "http_request", "learn_design", "local_discovery", "screenshot"]) {
    assert.ok(!names.includes(deferred), `${deferred} 被顺手塞进了开局窗口——扩的是一个，不是把目录敞开`);
  }
});

test("只读角色不受影响：plan / explorer / reviewer 的窗口没变", () => {
  // knowledge_search 加在 agent 那一条里。只读角色的窗口是另一份纪律，不能被这次改动带偏。
  for (const mode of ["plan", "explorer", "reviewer"]) {
    const names = selectInitial(mode, false);
    assert.ok(!names.includes("knowledge_search"),
      `${mode} 的开局窗口被这次改动带上了 knowledge_search`);
    assert.ok(!names.includes("write_file"), `${mode} 必须保持只读`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 领域维度：模型声明的 domain 字段 + 画像旗标
// ═══════════════════════════════════════════════════════════════════════════

test("领域白名单逐字等于 server/knowledge 的目录名——两边分叉就是悄悄不路由", () => {
  const dirs = readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(dirs.length >= 20, `只扫到 ${dirs.length} 个语料目录——路径变了，这条断言等于没跑`);
  assert.deepEqual([...DOMAINS].sort(), dirs,
    "枚举和真实语料目录分叉了。多出来的域检索回来永远是空，少掉的域则是又一个路由孤儿——"
    + "两种错都不报错，只表现为「它怎么不查」");
});

test("裁决里的 domain 按白名单归一，编出来的域名一律归空", () => {
  for (const name of DOMAINS) assert.equal(knowledgeDomain(name), name, `${name} 应原样通过`);
  // 模型写下划线/大写/带空格的概率至少和写对一样高，那是同一个域的不同写法，要接住。
  assert.equal(knowledgeDomain("reverse_engineering"), "reverse-engineering");
  assert.equal(knowledgeDomain("PENETRATION_TESTING"), "penetration-testing");
  assert.equal(knowledgeDomain("  data_ml  "), "data-ml");
  assert.equal(knowledgeDomain("iot embedded"), "iot-embedded");
  // 编出来的一律归空。放它过去只会让预检拿一个不存在的域去检索，然后给模型一份
  // 「本域无命中」的空小抄——比没有更糟，因为它看起来像查过了。
  for (const fake of ["frontend", "ai", "web3-security", "michael design 2.5", "", null, undefined, 42, {}]) {
    assert.equal(knowledgeDomain(fake), "", `${JSON.stringify(fake)} 不在白名单里，必须归空`);
  }
});

function normalizeVerdict() {
  const intentText = load("_aiIntentText");
  const intentList = load("_aiIntentList", { _aiIntentText: intentText });
  return load("_normalizeAiIntentVerdict", {
    _AI_INTENT_DIMENSIONS: loadConst("_AI_INTENT_DIMENSIONS"),
    _AI_ENGINEERING_FIELDS: loadConst("_AI_ENGINEERING_FIELDS"),
    _AI_INTENT_RELATIONS: loadConst("_AI_INTENT_RELATIONS"),
    _AI_PROJECT_STATES: loadConst("_AI_PROJECT_STATES"),
    _AI_DELIVERY_SURFACES: loadConst("_AI_DELIVERY_SURFACES"),
    _AI_CHANGE_SCOPES: loadConst("_AI_CHANGE_SCOPES"),
    _AI_ARCHITECTURE_MODES: loadConst("_AI_ARCHITECTURE_MODES"),
    _AI_DATA_STRATEGIES: loadConst("_AI_DATA_STRATEGIES"),
    _AI_RESEARCH_MODES: loadConst("_AI_RESEARCH_MODES"),
    _AI_DESIGN_MODES: loadConst("_AI_DESIGN_MODES"),
    _AI_WORKSPACE_ACTIONS: loadConst("_AI_WORKSPACE_ACTIONS"),
    _AI_CAPTURE_MODES: loadConst("_AI_CAPTURE_MODES"),
    _AI_BROWSER_GOALS: loadConst("_AI_BROWSER_GOALS"),
    _AI_ORCHESTRATION_MODES: loadConst("_AI_ORCHESTRATION_MODES"),
    _AI_AGENT_ROLES: loadConst("_AI_AGENT_ROLES"),
    _RUNTIME_OBLIGATION_ORDER: ["build", "run", "test", "install", "package"],
    _EXTERNAL_OBLIGATION_ORDER: ["commit", "push", "deploy"],
    _aiIntentEnum: load("_aiIntentEnum"),
    _aiIntentKnowledgeDomain: knowledgeDomain,
    _aiIntentText: intentText,
    _aiIntentList: intentList,
    _userRoleMap: () => new Map(),
  });
}

test("domain 走完整条裁决归一路径，且它自己就足以证明工程半到场了", () => {
  const normalize = normalizeVerdict();
  const got = normalize({ engineering: { domain: "healthcare" } }, {});
  assert.equal(got.engineering.domain, "healthcare");
  // 工程半的到场判据里必须认这个字段。不认的话，一份只答出 domain 的工程块会被当成
  // 「模型什么都没说」整个丢掉——而弱模型产出的恰恰是这种小块。
  assert.equal(got._halves.engineering, true,
    "只带 domain 的工程块没被算作工程半到场，整块会被丢掉");
  // 编出来的域名不许落进画像。
  assert.equal(normalize({ engineering: { domain: "quantum-alchemy" } }, {}).engineering.domain, "");
  // 没给就是空串，不是 undefined——下游按 `if (p.domain)` 判。
  assert.equal(normalize({ engineering: { workspaceAction: "modify" } }, {}).engineering.domain, "");
});

test("裁决的 domain 会落到画像上（否则旗标那一层永远看不到它）", () => {
  const merge = load("_mergeAiIntentProfile", {
    _AI_INTENT_DIMENSIONS: [],
    _aiIntentKnowledgeDomain: knowledgeDomain,
  });
  const base = { _isAgentMode: true };
  const withDomain = merge(base, { engineering: { domain: "penetration-testing" }, semantic: {} }, "查一下这个站", null);
  assert.equal(withDomain.domain, "penetration-testing");
  // 裁决没到（verdict 为空）时画像必须是空串，不是 undefined 也不是某个默认域。
  const pending = merge(base, null, "随便什么", null);
  assert.equal(pending.domain, "", "裁决没到时画像不该凭空带上一个领域");
});

test("画像旗标 domain_<name>：目录名的 `-` 换成 `_`，只在 domain 非空时出现", () => {
  assert.match(semanticProfile({ domain: "healthcare" }), /(^|,|:)domain_healthcare(,|$)/);
  assert.match(semanticProfile({ domain: "reverse-engineering" }), /(^|,|:)domain_reverse_engineering(,|$)/);
  assert.match(semanticProfile({ domain: "penetration-testing" }), /(^|,|:)domain_penetration_testing(,|$)/);
  assert.match(semanticProfile({ domain: "iot-embedded" }), /(^|,|:)domain_iot_embedded(,|$)/);
  // 空 / 缺失 → 一个 domain_ 旗标都不许出现。判不出领域就是判不出，别点亮任何东西。
  assert.doesNotMatch(semanticProfile({ domain: "" }), /domain_/);
  assert.doesNotMatch(semanticProfile({}), /domain_/);
  assert.equal(semanticProfile({}), "2.5:");
  // 每个目录名都能拼出一条合法旗标（旗标名只允许 [a-z0-9_]）。
  for (const name of DOMAINS) {
    const flag = semanticProfile({ domain: name }).split(":")[1];
    assert.match(flag, /^domain_[a-z0-9_]+$/, `${name} 拼出的旗标不合法：${flag}`);
  }
});

test("领域旗标跟着会话级单调并集走，和其它旗标同一条路", () => {
  const stable = load("_sessionStableSemanticProfile");
  // 裁决还没落定的会话，请求头最前面多一位 unjudged（不粘：模型判过就没了）——网关据此兜底挂工程块。
  const session = {};
  assert.equal(stable(session, semanticProfile({ applies: true, domain: "finance" })),
    "2.5:unjudged,engineering,domain_finance");
  // 第二轮换了话题、旗标算不出来了，并集也不许把它丢掉——粘性是这套画像的既有设计
  // （丢了就等于每轮重写请求头的第 0 字节，把整条缓存前缀作废）。
  assert.equal(stable(session, semanticProfile({ applies: true })),
    "2.5:unjudged,engineering,domain_finance");
  // 新领域是并进去，不是替换。
  assert.equal(stable(session, semanticProfile({ domain: "security" })),
    "2.5:unjudged,engineering,domain_finance,domain_security");
  // 模型裁决落定：unjudged 消失，且它从不进粘性并集。
  session._semanticProfileFromModel = true;
  assert.equal(stable(session, semanticProfile({ domain: "security" })),
    "2.5:engineering,domain_finance,domain_security");
  assert.ok(!session._semanticProfileFlags.includes("unjudged"), "unjudged 不许粘进会话并集");
});

test("裁决提示词必须把 domain 讲清楚并出现在输出形状里，否则模型永远不会填它", () => {
  // 字段只加在归一器里是没用的：模型看不到的字段等于不存在。它必须同时出现在
  // ①工程字段说明、②合成输出形状、③拆问后工程半那一发的输出形状里——拆问那一发才是
  // 生产路径（合成那份 43 字段的 JSON 在弱模型上直接产不出来）。
  const ask = SRC.slice(SRC.indexOf("工程字段（全部必填）"));
  assert.ok(ask.length > 0, "找不到工程字段说明段落");
  assert.match(ask.slice(0, 4000), /domain=/, "工程字段说明里没有 domain，模型不知道要填什么");
  for (const name of ["healthcare", "reverse-engineering", "michael-design"]) {
    assert.ok(ask.slice(0, 4000).includes(name), `domain 的枚举说明里缺 ${name}`);
  }
  // 定位锚是工程对象的开头，不是示例里某个字段的取值：示例 2026-09-06 改成了中性形状
  // （designMode none / solo），弱模型照抄示例时抄到的才不是整套设计律。
  const shapes = [...SRC.matchAll(/"engineering":\{"projectState":"existing","deliverySurface":"[^}]*/g)].map((m) => m[0]);
  assert.ok(shapes.length >= 2, `只找到 ${shapes.length} 份输出形状——合成那份和拆问工程半那份都要有`);
  for (const shape of shapes) {
    assert.match(shape, /"domain":"/, "有一份输出形状里没有 domain，模型照着它输出就永远不带这个字段");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 专业域小抄：预检嚼碎
// ═══════════════════════════════════════════════════════════════════════════

// 知识库回执夹具：逐字照 _searchKnowledgeBase 拼出来的那个格式
// （抬头 + 【序号·来源｜域/主题 · 小节】+ 正文，段间用 \n\n———\n\n 分隔）。
function knowledgeHit(domain, sections) {
  const body = sections.map((s, i) =>
    `【${i + 1}·经验｜${domain}/${s.topic} · ${s.section}】\n${s.text}`).join("\n\n———\n\n");
  return {
    type: "knowledge",
    path: "q",
    knowledge: { hitCount: sections.length, domains: [domain] },
    content: `📚 专业知识库「q」 [${domain}] 检索到 ${sections.length} 段最佳实践：\n\n${body}`,
  };
}

const LONG = (tag) => `${tag} 这一条要长过二十四个字符才会被小抄收下，短行是小节标题不是要点。`;

function preflightDeps({ search, calls = [] } = {}) {
  return {
    _DOMAIN_KNOWLEDGE_RUBRICS: loadConst("_DOMAIN_KNOWLEDGE_RUBRICS"),
    _DOMAIN_KNOWLEDGE_BRIEF_BUDGET: DOMAIN_KNOWLEDGE_BRIEF_BUDGET,
    _DOMAIN_KNOWLEDGE_MAX_DOMAINS: loadConst("_DOMAIN_KNOWLEDGE_MAX_DOMAINS"),
    _AI_KNOWLEDGE_DOMAINS: DOMAINS,
    _domainKnowledgeFlagDomains: flagDomains,
    _domainKnowledgeResearchPlan: load("_domainKnowledgeResearchPlan", {
      _DOMAIN_KNOWLEDGE_RUBRICS: loadConst("_DOMAIN_KNOWLEDGE_RUBRICS"),
    }),
    _domainKnowledgeBullets: domainKnowledgeBullets,
    _domainKnowledgeBrief: domainKnowledgeBrief,
    _toolExecutionSucceeded: (_call, result) => !String(result?.content || "").startsWith("[失败]"),
    _createToolStep: () => null,
    _settleToolStep: () => {},
    // 四张卡合成一张之后，建卡/结算搬进了 src/agent/knowledge-preflight-card.js。
    // 用**真模块**，不打桩：它的兜底（body 为空、step 为 null 时安静返回而不是抛）
    // 正是这里要跑到的路径——预检在无 UI 的场景（子智能体、后台补跑）本来就没有 body。
    _createPreflightCard: createPreflightCard,
    _settlePreflightCard: settlePreflightCard,
    _knowledgeSettleLabel: () => "",
    _escHtml: (x) => String(x),
    _searchKnowledgeBase: async (call) => {
      calls.push(call);
      return search ? search(call) : knowledgeHit(call.domain, [
        { topic: "t", section: `S-${call.query.split(" ")[1]}`, text: LONG("要点") },
      ]);
    },
  };
}

const runPreflight = (opts) => load("_runDomainKnowledgePreflight", preflightDeps(opts));

test("触发判据只有画像旗标：没有 domain_* 就一次检索都不发", async () => {
  const calls = [];
  const run = { mode: "agent", _originalText: "帮我做一个给医院用的排班系统，涉及病历和用药" };
  const out = await runPreflight({ calls })({ run, profile: "2.5:engineering,design" });
  assert.equal(out.required, false, "没有领域旗标却起跑了预检");
  assert.equal(calls.length, 0,
    "没有旗标却发了检索——那只可能是从用户文字里猜的领域，而那正是这套机制拒绝做的事");
});

test("michael-design 走它自己那条既有预检，不进通用小抄", async () => {
  const calls = [];
  const run = { mode: "agent", _originalText: "重做官网" };
  const out = await runPreflight({ calls })({ run, profile: "2.5:design,domain_michael_design" });
  assert.equal(out.required, false);
  assert.equal(calls.length, 0,
    "michael-design 被通用小抄接管了——同一轮会出两份互相打架的设计指令");
});

test("带 domain_healthcare 就在开跑前按四条 rubric 真检索该域", async () => {
  const calls = [];
  const run = { mode: "agent", _originalText: "给医院做排班系统" };
  const out = await runPreflight({ calls })({ run, profile: "2.5:engineering,domain_healthcare" });
  assert.equal(out.required, true);
  assert.equal(calls.length, 4, `应该是四条 rubric 各一次检索，实际 ${calls.length} 次`);
  for (const call of calls) {
    assert.equal(call.domain, "healthcare", "检索没有限定在声明的那个域上");
    assert.equal(call.type, "knowledge");
    assert.ok(call.query.includes("healthcare"), "query 里没有域名");
  }
  // 四条 rubric 必须真的不同——压成一条泛 query 就退回"贴散文"了。
  assert.equal(new Set(calls.map((c) => c.query)).size, 4, "四条 rubric 的 query 撞车了");
});

test("小抄是条目化的四栏，不是把原文散文倒进去", async () => {
  const run = { mode: "agent", _originalText: "给医院做排班系统" };
  const search = (call) => knowledgeHit("healthcare", [
    { topic: "phi", section: `节-${call.query.split(" ")[1]}`, text: LONG("要点甲") },
    { topic: "phi", section: "第二节", text: LONG("要点乙") },
  ]);
  const out = await runPreflight({ search })({ run, profile: "2.5:domain_healthcare" });
  const brief = out.briefs[0].brief;
  for (const heading of ["适用条件", "硬性约束", "常见坑", "必须做的检查"]) {
    assert.ok(brief.includes(`【${heading}】`), `小抄缺了「${heading}」这一栏`);
  }
  assert.match(brief, /^- .+ → /m, "要点没有条目化，也没有标出来源小节");
  assert.ok(brief.includes("healthcare"), "小抄没说清这是哪个域的");
  assert.ok(out.briefs[0].hitCount > 0, "命中条数没记账");
});

test("小抄有界：总预算 2500 字符，超了截断并说清截了多少", async () => {
  const budget = DOMAIN_KNOWLEDGE_BRIEF_BUDGET;
  assert.equal(budget, 2500, "预算不是 2500 了——这条断言和实现要一起改");
  const run = { mode: "agent", _originalText: "x" };
  // 每条 rubric 都塞满命中，把小抄撑爆。
  const search = () => knowledgeHit("finance", Array.from({ length: 12 }, (_, i) => ({
    topic: "t",
    section: `一个长得过分的小节标题第 ${i} 号，用来把预算撑爆`,
    text: `${"要点".repeat(200)}${i}`,
  })));
  const out = await runPreflight({ search })({ run, profile: "2.5:domain_finance" });
  const brief = out.briefs[0].brief;
  assert.ok(brief.length <= budget, `小抄 ${brief.length} 字符，超出预算 ${budget}——弱模型会被淹没`);
  assert.match(brief, /已截断 (\d+) 字符/, "截断了却没记账，模型会把这份小抄当成全部");
  const dropped = Number(/已截断 (\d+) 字符/.exec(brief)[1]);
  assert.ok(dropped > 0, "记的截断量是 0，那就不是真账");
});

test("每个 run 每个域只做一次", async () => {
  const calls = [];
  const runner = runPreflight({ calls });
  const run = { mode: "agent", _originalText: "x" };
  const first = await runner({ run, profile: "2.5:domain_devops" });
  assert.equal(first.required, true);
  const before = calls.length;
  const second = await runner({ run, profile: "2.5:domain_devops" });
  assert.equal(second.required, false, "同一个 run 同一个域嚼了第二遍");
  assert.equal(calls.length, before, "第二次又发了检索");
});

test("会话并集攒出一堆领域时有上限，不会在开跑前打十几次检索", async () => {
  const calls = [];
  const run = { mode: "agent", _originalText: "x" };
  const out = await runPreflight({ calls })({
    run,
    profile: "2.5:domain_finance,domain_security,domain_devops,domain_database,domain_gaming",
  });
  const max = loadConst("_DOMAIN_KNOWLEDGE_MAX_DOMAINS");
  assert.equal(out.briefs.length, max, `一轮嚼了 ${out.briefs.length} 个域，上限是 ${max}`);
  assert.equal(calls.length, max * 4);
});

test("检索炸了也只是没有小抄，不炸整轮", async () => {
  const run = { mode: "agent", _originalText: "x" };
  const out = await runPreflight({ search: () => { throw new Error("network down"); } })({
    run, profile: "2.5:domain_legal",
  });
  assert.equal(out.required, true);
  const brief = out.briefs[0].brief;
  // 2026-08-30：这里断言的从「没有返回任何可用命中」改成失败态的措辞。
  // 原因不是措辞变了，是这个夹具本来就是**检索抛异常**（search 里 throw），
  // 而那属于「没拿到结论」，不是「库里确实没有」——两者对模型的含义相反：
  // 后者可以据此往下走，前者不行。旧断言正好把这两种压成了同一句。
  assert.ok(brief.includes("没有拿到结果"), "检索炸了要说成「没拿到」，不能说成「库里没有」");
  assert.ok(brief.includes("不等于") && brief.includes("库里没有"),
    "必须点明「没拿到 ≠ 库里没有」，否则模型会断言这个领域没有规则");
  assert.ok(/不要据此断言|不要编造|不要凭印象/.test(brief), "没拦住「凭印象补」，那比不查更糟");
});

test("单飞：一个 run 只起一条预检 promise；没有旗标时连 promise 都不建", async () => {
  let started = 0;
  const start = load("_startDomainKnowledgePreflight", {
    _domainKnowledgeFlagDomains: flagDomains,
    _runDomainKnowledgePreflight: async () => { started += 1; return { required: true, briefs: [] }; },
  });
  const run = { mode: "agent" };
  const a = start({ run, profile: "2.5:domain_mobile" });
  const b = start({ run, profile: "2.5:domain_mobile" });
  assert.ok(a && typeof a.then === "function");
  assert.equal(a, b, "同一个 run 起了两条预检");
  await a;

  // 没有旗标 → null，不建 promise。下面那个有上限的等待因此一秒都不必付。
  assert.equal(start({ run: { mode: "agent" }, profile: "2.5:engineering" }), null);
  assert.equal(start({ run: { mode: "agent" }, profile: "2.5:" }), null);
  // 只读模式不做这件事（它整轮不该发起检索）。
  assert.equal(start({ run: { mode: "explorer" }, profile: "2.5:domain_mobile" }), null);
  assert.equal(started, 1);
});

test("等待有上限，而且和设计预检共用同一条截止线", () => {
  const waitMs = load("_domainKnowledgePreflightWaitMs", {
    _DOMAIN_KNOWLEDGE_PREFLIGHT_WAIT_MS: 6000,
  });
  assert.equal(waitMs({}), 6000, "没起跑过就是完整上限");
  assert.ok(waitMs({ _domainKnowledgePreflightStartedAt: Date.now() - 5000 }) <= 1000,
    "设计预检已经烧掉 5 秒，这里还要再等满 6 秒——同一轮付了两次等待");
  assert.equal(waitMs({ _domainKnowledgePreflightStartedAt: Date.now() - 60_000 }), 0,
    "早就超时了还在等，首个 token 被卡死在网络上");
});

test("小抄赶在第一个模型回合之前注入，且这次等待是有上限的", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  const start = loop.indexOf("_startDomainKnowledgePreflight({ run, profile: config.ideSemanticProfile, body, isLive: _live });");
  assert.ok(start > 0, "找不到专业域预检的起跑点");
  const consume = loop.indexOf("_consumeDomainKnowledgePreflight();", start);
  assert.ok(consume > start, "找不到消费点");
  const between = loop.slice(start, consume);
  assert.match(between, /await Promise\.race\(/,
    "起跑和消费之间没有等待——小抄最早只能在第二个回合到场，这一轮等于白做");
  assert.match(between, /_domainKnowledgePreflightPromise/, "等的不是预检那个 promise");
  assert.match(between, /setTimeout\(resolve, _domainKnowledgePreflightWaitMs\(run\)\)/,
    "等待没有上界，或者没走那条共用截止线");
  const firstTurn = loop.indexOf("let turn = await _agentModelTurn", consume);
  assert.ok(firstTurn > consume, "注入排在第一个模型回合之后了");
});

test("只有同步的边界消费者能改动 provider 消息，而且必须戴编排信封", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  assert.match(loop, /const _consumeDomainKnowledgePreflight = \(\) =>/);
  assert.match(loop, /messages\.push\(\{ role: "user", content: _ORCH_NOTE \+ item\.brief \}\)/,
    "小抄没戴编排信封——它坐在用户请求后面，不戴就长得像用户刚说的话");
  // 异步回调绝不能在请求途中改消息数组。
  const runner = fnSource("_runDomainKnowledgePreflight", { code: true });
  assert.doesNotMatch(runner, /messages\.push/,
    "预检自己往消息数组里塞东西了——异步回调可能落在一次请求的中途");
  // 后台检索知识库 ≠ 模型读过这个项目的代码。给它记 didInvestigate 就是替模型记一笔
  // 它没做过的功，那道「没读过相关代码就动手改」的闸门会被架空。
  const consumer = loop.slice(loop.indexOf("const _consumeDomainKnowledgePreflight"));
  assert.doesNotMatch(consumer.slice(0, 1600), /didInvestigate/,
    "把知识库预检记成了「读过代码」，那道写入前的取证闸门会一次都不响");
});

test("零关键词正则：触发链上不许出现按用户文字判路的东西", () => {
  // 判据只有旗标这一个，而旗标来自模型自己的领域声明。触发链上任何一处开始扫用户文字，
  // 这套机制就退回成关键词路由——那正是它要取代的东西。
  for (const name of ["_domainKnowledgeFlagDomains", "_startDomainKnowledgePreflight"]) {
    const src = fnSource(name, { code: true });
    assert.doesNotMatch(src, /_originalText|taskText|run\.task/,
      `${name} 读了用户文字——触发判据必须只有画像旗标`);
  }
  // 反过来钉正面：判定入口只吃旗标串这一个参数。
  assert.match(fnSource("_domainKnowledgeFlagDomains", { code: true }),
    /^function _domainKnowledgeFlagDomains\(profileHeader\) \{/,
    "触发判定的入参不再只是那串旗标了");
  // michael-design 那条路径上有一张 _michaelDesignCategoryTerms 关键词表（按"电商/博客/
  // 游戏"之类的词猜品类）。通用小抄不许复制它：域已经由模型声明了，再猜一次只会覆盖声明。
  const plan = fnSource("_domainKnowledgeResearchPlan", { code: true });
  assert.doesNotMatch(plan, /_michaelDesignCategoryTerms|rules\.filter/,
    "把 michael-design 的品类关键词表抄过来了");
  assert.doesNotMatch(plan, /\/\(\?:/, "研究计划里出现了关键词分支正则");
});

test("旗标 → 域名的反向映射不会拼出目录外的东西", () => {
  assert.deepEqual(flagDomains("2.5:engineering,domain_data_ml"), ["data-ml"]);
  assert.deepEqual(flagDomains("2.5:domain_systems_programming"), ["systems-programming"]);
  assert.deepEqual(flagDomains("2.5:domain_iot_embedded,domain_michael_design"), ["iot-embedded"]);
  // 污染进来的假旗标要被白名单挡住。
  assert.deepEqual(flagDomains("2.5:domain_quantum_alchemy,domain_,domainfinance"), []);
  assert.deepEqual(flagDomains(""), []);
  assert.deepEqual(flagDomains(null), []);
  // 22 个目录名全都能来回一趟不丢字（目录名里一个下划线都没有，所以这个来回是无损的）。
  for (const name of DOMAINS) {
    if (name === "michael-design") continue;
    const header = semanticProfile({ domain: name });
    assert.deepEqual(flagDomains(header), [name], `${name} 的旗标来回丢了字`);
  }
});

test("设计已经在场时不再发 michael-design 域旗标——同一份语料不注两遍", () => {
  // michael-design 有自己的专属通道（design 旗标 → design_knowledge_block + 客户端设计预检）。
  // 域旗标再报一次，网关会按域限定检索**同一份**语料并二次注入：网关侧实测系统提示
  // 42KB → 69KB，纯重复。抑制必须在 IDE 侧做——网关无从知道 design 通道已经注了什么。
  const profile = load("_ideSemanticProfile");
  const withDesign = profile({ ui: true, domain: "michael-design", applies: true });
  assert.ok(withDesign.includes("design"), "设计通道本身要在");
  assert.ok(!withDesign.includes("domain_michael_design"),
    "设计在场时还发域旗标 → 同一份语料被注两遍");
  // 设计不在场时（例如只读地问设计规范），域旗标仍要发——那时它是唯一的通道。
  const noDesign = profile({ domain: "michael-design", applies: true });
  assert.ok(noDesign.includes("domain_michael_design"),
    "设计通道不在场时，域旗标是这份语料唯一的入口，不能一并抑制");
  // 其余 21 个专业域不受影响。
  const health = profile({ ui: true, domain: "healthcare", applies: true });
  assert.ok(health.includes("domain_healthcare"),
    "抑制只针对 michael-design，专业域和设计可以同时在场");
});


// 两份工具目录里 knowledge_search 的 domain 说明。取的是**真文件**，不是复述——
// 复述一份就等于又造了第三处会漂的副本。
function localDomainDescription() {
  const m = /name: "knowledge_search"[\s\S]*?domain: \{ type: "string", description: "((?:[^"\\]|\\.)*)"/.exec(SRC);
  assert.ok(m, "main.js 里 knowledge_search 的 domain 说明取不到——这两条断言失去落点");
  // 比的是**字符串的值**，不是源码里的写法：main.js 里破折号写成 \u2014 转义，
  // tools.json 里是字面量，两者语义相同。不解转义的话这条会一直红在一个假差异上。
  return JSON.parse(`"${m[1]}"`);
}
function cloudDomainDescription() {
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../server/prompts/tools.json"), "utf8");
  const list = JSON.parse(raw);
  const tools = Array.isArray(list) ? list : (list.tools || []);
  const hit = tools.map((t) => t.function || t).find((f) => f?.name === "knowledge_search");
  assert.ok(hit, "网关目录里没有 knowledge_search");
  return hit.parameters.properties.domain.description;
}

// 22 个域里，工具说明原来只列了 8 个。另外 13 个——healthcare / finance / legal / gaming /
// data-ml / blockchain / iot-embedded / mobile / saas / ecommerce / education / marketing /
// systems-programming——模型一个字都收不到，于是永远不会点名去查它们。
//
// 这不是一道墙（网关的 domain 过滤是松解析的：猜错了会回落成全库搜，而不是返回空），
// 是一个**文档缺口**：模型不知道有这些域可以点名。而这里守的是它别再缺回去。
test("工具说明里列的可选域，必须是语料域的全集", () => {
  const desc = localDomainDescription();
  const missing = [...DOMAINS].filter((d) => !desc.includes(d));
  assert.deepEqual(missing, [],
    `这些域模型一个字都收不到，于是永远不会点名去查：${missing.join(" / ")}`);
});

test("两份工具目录里那段域说明逐字一致——运行时以网关那份为准", () => {
  // 只改 main.js 等于改了个不生效的副本，而且两份会静静地越漂越远。
  assert.equal(localDomainDescription(), cloudDomainDescription(),
    "本地副本和网关目录的域说明漂了——运行时生效的是网关那份");
});
