// 裁决与闸门：弱模型不许把自己身上的安全带解开。
//
// 四件事，对应 weak-models 诊断的 1/2/3/4：
//   ① 半份裁决不许冒充完整裁决——intentSource 三值化（"ai"/"partial"/"pending"），
//      缓存与会话状态的准入同判。弱模型最常见的失败形状是【语义半到、工程半空】：
//      语义块小（6 个自由文本字段），工程块大（16 个枚举/数组 + 73 键维度表）。
//      OR 判据下这份半成品会以完整裁决的身份落定：维度全灭、枚举全默认，
//      闸门读到的是「裁决到了且说不适用」，迟到补救路径被 `=== "ai"` 早返回永久关闭，
//      还要被缓存 15 分钟。
//   ② 取证门从「画像开启」改成「画像豁免」——门内判据本来就全是执行事实
//      （读没读过、根目录空不空），画像只是被当成了开关；模型越弱表越空，门越全开。
//   ③ 快通道拿受限行为写入权——只驱动「多一道取证/仪式」方向的门（方向表 =
//      gate-tristate 的 ceremony/capability 清单），夺能力的门全是 `=== "ai"` 精确比较，
//      "fast" 够不到；硬拦回合的计划门显式排除 "fast"。
//   ④ web 构建整套画像机器的门槛从 inTauri 改成「有没有可用补全通道」
//      （config.baseUrl && config.apiKey，与 _wrapUpCritic 同源判据）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE, fnSource, load, loadConst } from "./helpers/source.mjs";
import { auxEffortFor as _auxEffortFor } from "../src/agent/aux-effort.js";

const intentText = load("_aiIntentText");
const intentList = load("_aiIntentList", { _aiIntentText: intentText });
const DIMS = loadConst("_AI_INTENT_DIMENSIONS");

const KNOWLEDGE_DOMAIN = load("_aiIntentKnowledgeDomain", { _AI_KNOWLEDGE_DOMAINS: loadConst("_AI_KNOWLEDGE_DOMAINS") });

function normalizeDeps() {
  return {
    _AI_INTENT_DIMENSIONS: DIMS,
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
    _EXTERNAL_OBLIGATION_ORDER: ["commit", "push", "sync", "pr", "deploy", "upload", "download", "database", "automation", "external"],
    _aiIntentEnum: load("_aiIntentEnum"),
    // 领域字段走独立的白名单归一（目录名带连字符，_aiIntentEnum 不认下划线写法）。
    _aiIntentKnowledgeDomain: KNOWLEDGE_DOMAIN,
    _aiIntentText: intentText,
    _aiIntentList: intentList,
    _userRoleMap: () => new Map(),
  };
}

const normalize = load("_normalizeAiIntentVerdict", normalizeDeps());
const merge = load("_mergeAiIntentProfile", { _AI_INTENT_DIMENSIONS: DIMS, _aiIntentKnowledgeDomain: KNOWLEDGE_DOMAIN });

const FULL_RAW = {
  semantic: { goal: "修复登录", action: "debug", target: "登录请求", continuation: "new", confidence: 0.9, ambiguities: [] },
  engineering: {
    projectState: "existing", deliverySurface: "backend", changeScope: "module",
    architectureMode: "extend_existing", dataStrategy: "none", researchMode: "none",
    designMode: "none", workspaceAction: "modify", captureMode: "none", browserGoal: "none",
    runtimeActions: ["test"], externalActions: [], researchTopics: [], rationale: [],
  },
  dimensions: { bug: true, implementation: true },
};
const SEMANTIC_ONLY_RAW = {
  semantic: { goal: "修复登录", action: "debug", target: "登录请求", continuation: "new", confidence: 0.9, ambiguities: [] },
};

// ── ① 三值化 ────────────────────────────────────────────────────────────────

test("半份裁决记 partial，两半都到才是 ai，缺席仍是 pending", () => {
  const full = normalize(FULL_RAW, {});
  assert.deepEqual(full._halves, { semantic: true, engineering: true },
    "完整裁决的两半到场情况没有被记录——三值化没有判据");
  assert.equal(merge({}, full, "修登录").intentSource, "ai");

  const half = normalize(SEMANTIC_ONLY_RAW, {});
  assert.ok(half, "语义半是真实内容，不能整份丢弃");
  assert.deepEqual(half._halves, { semantic: true, engineering: false },
    "工程半（16 个枚举 + 73 键维度表）缺席必须被如实记为缺席");
  const merged = merge({}, half, "修登录");
  assert.equal(merged.intentSource, "partial",
    "半份裁决冒充了完整裁决——维度全灭、枚举全默认的画像会让闸门读到「裁决说了不适用」");
  // partial 对所有 `=== "ai"` 的读者等同「未落地」：不夺能力、不关补救路径。
  assert.notEqual(merged.intentSource, "ai");

  // 只回了维度表、没有语义半的也一样是半份。
  const dimsOnly = normalize({ dimensions: { bug: true } }, {});
  assert.deepEqual(dimsOnly._halves, { semantic: false, engineering: true });
  assert.equal(merge({}, dimsOnly, "x").intentSource, "partial");

  // 会话状态/缓存重建出的 verdict 不带 _halves——那两处准入只收完整裁决，按完整算。
  assert.equal(merge({}, { implementation: true, engineering: {} }, "x").intentSource, "ai");
  assert.equal(merge({}, null, "x").intentSource, "pending");
});

test("缓存与会话状态的准入同判：半份裁决既不缓存也不落语义帧", async () => {
  const mkProfile = (response) => {
    const cache = new Map();
    const commits = [];
    const profile = load("_aiIntentProfile", {
      // 档位封顶搬进了 src/agent/aux-effort.js —— load() 把模块包进块作用域，
      // 里面的符号看不见，必须显式注进来（本仓库为这类注入清单栽过）。
      auxEffortFor: _auxEffortFor,
    // 2026-08-27 新增的线路闸：内置提示词不出网关（见 test/ip-does-not-leave-gateway.test.mjs）。
    // 这里桩成恒真，把这条测试隔离在它本来要测的那一层上。
    _ipSafeRoute: () => true,
      _AI_INTENT_DIMENSIONS: DIMS,
      _aiIntentCache: cache,
      _aiIntentInflight: new Map(),
      _aiIntentCacheKey: load("_aiIntentCacheKey"),
      _aiIntentContextFingerprint: () => "ctx",
      _normalizeAiIntentVerdict: normalize,
      _safeJsonLoose: load("_safeJsonLoose"),
      _commitAiIntentState: load("_commitAiIntentState", {
        _AI_INTENT_DIMENSIONS: DIMS,
        _aiIntentText: intentText,
        _aiIntentContextFingerprint: () => "ctx",
        _aiIntentVerdictComplete: load("_aiIntentVerdictComplete"),
      }),
      _newIdeRequestId: () => `req_verdict_${Math.random().toString(36).slice(2, 10)}`,
      _billableAiComplete: async () => JSON.stringify(response),
      _userRoleEnumSuffix: () => "",
      _INTENT_FOREGROUND_WAIT_MS: 200,
      __commits: commits,
    });
    return { profile, cache };
  };

  const half = mkProfile(SEMANTIC_ONLY_RAW);
  const session = { id: "s1", _cancelIds: new Set() };
  const halfVerdict = await half.profile("修登录", { model: "m", baseUrl: "https://gw", apiKey: "k" }, session, { sessionId: "s1", currentMessage: "修登录" });
  assert.ok(halfVerdict, "半份裁决照样返回给本轮（partial 身份随 _halves 带出去）");
  assert.equal(half.cache.size, 0,
    "半份裁决被缓存了——同一句话会在 15 分钟内一直「看着懂了、纪律全没有」");
  assert.equal(session._intentState, undefined,
    "半份裁决落进了会话语义帧——状态重建不带 _halves，下一轮它就会冒充完整裁决");

  const full = mkProfile(FULL_RAW);
  const session2 = { id: "s2", _cancelIds: new Set() };
  await full.profile("修登录", { model: "m", baseUrl: "https://gw", apiKey: "k" }, session2, { sessionId: "s2", currentMessage: "修登录" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(full.cache.size, 1, "完整裁决必须照常缓存");
  assert.ok(session2._intentState, "完整裁决必须照常落会话语义帧");
});

test("partial 不关闭迟到补救：完整裁决落定后照样整体覆盖", () => {
  const full = normalize(FULL_RAW, {});
  const applyLate = load("_applyLateIntentIfLanded", {
    _semanticEngineeringEvidence: load("_semanticEngineeringEvidence"),
    _mergeAiIntentProfile: merge,
    _engineeringProfileWithAiIntent: () => null,
    _sessionStableSemanticProfile: (s, h) => h,
    _ideSemanticProfile: () => "2.5:",
    _startMichaelDesignPreflight: () => null,
    // 专业域小抄的起跑点，和设计预检并列挂在同一条迟到裁决路径上；这里只关心契约注入。
    _startDomainKnowledgePreflight: () => null,
    _agentIntentExecutionBlock: () => "",
    _ORCH_NOTE: "",
  });
  const run = {
    mode: "agent",
    engineering: { intentSource: "partial" },
    _intentState: { settled: true, verdict: full },
  };
  assert.equal(applyLate(run, {}, "修登录", {}, null, () => true, []), true,
    "run 里挂着 partial 时，迟到的完整裁决必须还能补进来——这正是三值化的意义");
  assert.equal(run.engineering.intentSource, "ai");

  // 已经是完整裁决时保持早返回（一个 run 最多注一次的既有不变式）。
  const landed = { mode: "agent", engineering: { intentSource: "ai" }, _intentState: { settled: true, verdict: full } };
  assert.equal(applyLate(landed, {}, "修登录", {}, null, () => true, []), false);
});

// ── ② 取证门：画像豁免制 ──────────────────────────────────────────────────

test("取证门默认开门：画像是豁免不是开关", () => {
  const groundingPath = load("_implementationGroundingFilePath");
  const NORMALIZE_PATH = (p) => String(p || "").replace(/\\/g, "/");
  const issue = load("_implementationMutationGroundingIssue", {
    _implementationGroundingCandidate: (c) => c && ["write", "edit", "cmd"].includes(String(c.type || ""))
      && (c.type !== "cmd" || c.purpose === "scaffold"),
    _runRootConfirmedEmptyForImplementation: load("_runRootConfirmedEmptyForImplementation", {
      _normalizeFsPath: NORMALIZE_PATH,
      _pathIdentity: (p) => p,
    }),
    _runHasImplementationGrounding: load("_runHasImplementationGrounding", {
      _normalizeFsPath: NORMALIZE_PATH,
      _pathIdentity: (p) => p,
      _implementationGroundingFilePath: groundingPath,
      _readRangeCovered: () => true,
    }),
    _implementationGroundingFilePath: groundingPath,
    fileEditTypes: () => new Set(["write", "edit", "multiedit", "format"]),
  });
  const mkRun = (engineering = {}) => ({
    mode: "agent", root: "/repo", engineering,
    _toolBatch: 3, _toolLedger: { turnIndex: 2, entries: [] }, _contextReadEvidence: [],
  });
  const writeSrc = { type: "write", path: "src/app.ts", content: "x" };

  // 画像全空（pending 常态：完整裁决实测 8–20 秒）→ 门在位。这就是修复本身：
  // 以前这里因为画像位没亮而直接放行，弱模型答不出画像 = 所有安全带解开。
  assert.match(issue(mkRun({}), writeSrc, "/repo"), /BLOCKED_IMPLEMENTATION_GROUNDING/,
    "画像为空时取证门不在位——模型越弱表越空，门越全开，正是被修掉的那个形状");

  // 范围由执行事实收窄：写的不是源码/清单/配置就不拦（README、素材）。
  assert.equal(issue(mkRun({}), { type: "write", path: "README.md", content: "x" }, "/repo"), "");
  assert.equal(issue(mkRun({}), { type: "write", path: "assets/logo.svg.txt", content: "x" }, "/repo"), "");
  // scaffold 命令照旧受门（不是文件写入，不走路径收窄）。
  assert.match(issue(mkRun({}), { type: "cmd", purpose: "scaffold", command: "npx create-x ." }, "/repo"),
    /BLOCKED_IMPLEMENTATION_GROUNDING/);

  // 豁免只认**落了地的**裁决明确说这轮只读。
  assert.equal(issue(mkRun({ intentSource: "ai", explicitReadOnly: true }), writeSrc, "/repo"), "");
  assert.match(issue(mkRun({ intentSource: "partial", explicitReadOnly: true }), writeSrc, "/repo"),
    /BLOCKED_IMPLEMENTATION_GROUNDING/, "半份裁决不配豁免");
  assert.match(issue(mkRun({ intentSource: "fast", explicitReadOnly: true }), writeSrc, "/repo"),
    /BLOCKED_IMPLEMENTATION_GROUNDING/, "快通道判断不配豁免");

  // 执行事实照常开门：已确认的空根 / 本 run 已有真实取证。
  const empty = mkRun({});
  empty._emptyWorkspaceRootsAtStart = new Set(["/repo"]);
  assert.equal(issue(empty, writeSrc, "/repo"), "");
  const grounded = mkRun({});
  grounded._contextReadEvidence = [{ root: "/repo", path: "src/main.ts", complete: true }];
  assert.equal(issue(grounded, writeSrc, "/repo"), "");
});

// ── ③ 快通道的受限行为写入权 ──────────────────────────────────────────────

function loadApplyFastBehavior() {
  return load("_applyFastRouteBehaviorIfLanded", {
    _FAST_ROUTING_KEYS: loadConst("_FAST_ROUTING_KEYS"),
    _AI_INTENT_DIMENSIONS: DIMS,
    _AI_WORKSPACE_ACTIONS: loadConst("_AI_WORKSPACE_ACTIONS"),
    _AI_DESIGN_MODES: loadConst("_AI_DESIGN_MODES"),
    _AI_ORCHESTRATION_MODES: loadConst("_AI_ORCHESTRATION_MODES"),
    _AI_CHANGE_SCOPES: loadConst("_AI_CHANGE_SCOPES"),
    _semanticEngineeringEvidence: load("_semanticEngineeringEvidence"),
    _mergeAiIntentProfile: merge,
  });
}

test("快通道落地成受限行为画像：取证方向的门被武装，夺能力的门够不到", () => {
  const applyBehavior = loadApplyFastBehavior();
  const run = {
    mode: "agent", _originalText: "深挖一下这个项目的 bug",
    engineering: { intentSource: "pending" },
    _intentState: { fastProfile: { debugProject: true, implementation: true, workspaceAction: "modify", changeScope: "module" } },
  };
  assert.equal(applyBehavior(run), true);
  assert.equal(run.engineering.intentSource, "fast",
    "快通道画像必须带自己的身份——冒充 ai 会打开夺能力的门");
  assert.equal(run.engineering.debugProject, true);
  assert.equal(run.engineering.implementation, true);
  assert.equal(run.engineering.applies, true);

  // 被武装的门（多一道取证方向）：debug 证据链现在认得这个 run。
  const debugCase = load("_debugCaseForRun");
  assert.ok(debugCase(run), "fast 画像声明 debugProject 后，debug 证据门必须开——这是唯一在弱模型上跑得通的腿");

  // 幂等 + 不清洗后到的完整裁决。
  assert.equal(applyBehavior(run), false);
  const landed = { mode: "agent", engineering: { intentSource: "ai" }, _intentState: { fastProfile: { implementation: true } } };
  assert.equal(applyBehavior(landed), false, "完整裁决在场时快通道不许覆盖");
  const partial = { mode: "agent", engineering: { intentSource: "partial" }, _intentState: { fastProfile: { implementation: true } } };
  assert.equal(applyBehavior(partial), false);
});

test("快通道永远拿不到只读身份：explicitReadOnly 被剥掉", () => {
  const applyBehavior = loadApplyFastBehavior();
  const run = {
    mode: "agent", _originalText: "看看就好",
    engineering: { intentSource: "pending" },
    _intentState: { fastProfile: { explicitReadOnly: true, workspaceAction: "inspect" } },
  };
  assert.equal(applyBehavior(run), true);
  assert.equal(run.engineering.explicitReadOnly, false,
    "快通道判断把一轮标成只读是夺能力方向（写入被拒），也会误触发取证门的只读豁免");
});

test("快通道禁入硬拦回合的计划门", () => {
  const applyBehavior = loadApplyFastBehavior();
  const run = {
    mode: "agent", _originalText: "做个完整网站",
    engineering: { intentSource: "pending" },
    _intentState: { fastProfile: { fullWebsite: true, uiProject: true, ui: true, implementation: true, workspaceAction: "modify", changeScope: "project" } },
  };
  assert.equal(applyBehavior(run), true);
  assert.equal(run.engineering.fullWebsite, true);

  // 唯一硬拦回合的门：fast 不许驱动。
  const planGate = load("_planBeforeBuildIssue", {
    // 计划门现在复用同胞取证门那条路径过滤（写 README/素材不武装硬拦）。
    // 注入清单是手工的：漏一处就是运行时 ReferenceError，不是断言失败。
    fileEditTypes: () => new Set(["write", "edit", "multiedit", "format"]),
    _implementationGroundingFilePath: load("_implementationGroundingFilePath"),
    _implementationGroundingCandidate: () => true,
    _introducesNewTech: () => false,
  });
  const call = { type: "write", path: "src/a.ts" };
  assert.equal(planGate(run, call), "",
    "快通道画像驱动了 BLOCKED_PLAN_FIRST——精简判断误报一次，整轮被打回");
  assert.ok(planGate({ ...run, engineering: { ...run.engineering, intentSource: "ai" } }, call),
    "同样的画像换成完整裁决身份必须照拦——排除的是 fast，不是把门拆了");

  const needsPlanNow = load("_runNeedsPlanGateNow", {
    _runRequiresPlan: () => true,
    _planGateGrandProject: load("_planGateGrandProject"),
    _callCanBypassPlanGate: () => false,
  });
  assert.equal(needsPlanNow(run, call), false,
    "快通道画像驱动了计划硬闸（_runNeedsPlanGateNow）");
  assert.equal(needsPlanNow({ ...run, engineering: { ...run.engineering, intentSource: "ai" } }, call), true);
});

test("每个收快通道旗标的循环边界都要同时收行为画像", () => {
  const header = (CODE.match(/_applyFastRouteProfileIfLanded\(run, config, session\);/g) || []).length;
  const behavior = (CODE.match(/_applyFastRouteBehaviorIfLanded\(run\);/g) || []).length;
  assert.ok(header >= 3, "快通道头部落地点少了");
  assert.equal(behavior, header,
    "有边界只收请求头旗标、不收行为画像——弱模型上行为闸门又回到全空");
});

// ── ④ web 构建：门槛是补全通道，不是平台 ──────────────────────────────────

test("画像机器的门槛不许写 inTauri：web 构建照样有画像", () => {
  for (const name of ["_aiIntentProfile", "_fastRoutingFlags"]) {
    assert.doesNotMatch(fnSource(name, { code: true }), /\binTauri\b/,
      `${name} 又挂回 inTauri 了——web 构建整套画像机器（含全部闸门）会再次永不启动`);
  }
});

test("补全通道缺席才返回 null；工作区取证拿不到就降级成 hasWorkspace:false", async () => {
  const fast = load("_fastRoutingFlags", {
    // 档位封顶搬进了 src/agent/aux-effort.js —— load() 把模块包进块作用域，
    // 里面的符号看不见，必须显式注进来（本仓库为这类注入清单栽过）。
    auxEffortFor: _auxEffortFor,
    // 快通道现在也判 domain（路由旗标的最后一块）：提示词要展开语料域名单，解析侧要
    // 对着真实目录名归一。注入清单是**手工**维护的，漏一个就是整段 ReferenceError——
    // 表现成"这个测试挂了"，而不是"少测一项"。
    _AI_KNOWLEDGE_DOMAINS: loadConst("_AI_KNOWLEDGE_DOMAINS"),
    _aiIntentKnowledgeDomain: load("_aiIntentKnowledgeDomain", {
      _AI_KNOWLEDGE_DOMAINS: loadConst("_AI_KNOWLEDGE_DOMAINS"),
    }),
    _FAST_ROUTING_KEYS: loadConst("_FAST_ROUTING_KEYS"),
    _AI_AGENT_ROLES: loadConst("_AI_AGENT_ROLES"),
    _aiIntentContextForTurn: () => ({}),
    _safeJsonLoose: load("_safeJsonLoose"),
    _newIdeRequestId: () => "req_fastroute_test_1",
    _billableAiComplete: async () => '{"implementation":true,"workspaceAction":"modify","designMode":"none","orchestrationMode":"solo","changeScope":"module"}',
  });
  assert.equal(await fast("写个功能", { model: "m" }, null, {}), null,
    "没有补全通道时快通道必须安静返回 null");
  const flags = await fast("写个功能", { model: "m", baseUrl: "https://gw", apiKey: "k" }, null, {});
  assert.equal(flags?.implementation, true,
    "有补全通道（web 构建同样满足）时快通道必须工作");

  // 工作区取证的判据是「这个工作区扫过没有」，**不是**「是不是桌面端」。
  //
  // 上一版按 inTauri 判，于是网页版每一轮 hasWorkspace 恒 false、topLevel/stack 恒空。
  // 那个前提是错的：填 _agentContextCache / _projectStacks 的是 _gatherAgentContext，
  // 它一个 inTauri 都没有，走的是 backend.readDir/readTextFile，而 mockBackend 两个都实现了
  // （网页版是一整套模拟工程）。分类器因此在网页版上看不见语言/框架/测试命令。
  const evidence = (cache, stacks) => load("_aiIntentWorkspaceEvidence", {
    _normalizeFsPath: (p) => String(p || ""),
    _agentContextCache: cache,
    _projectStacks: stacks,
    _aiIntentText: intentText,
  });
  const _scanned = { root: "/repo", ts: Date.now(), rootFp: "src | package.json | test" };
  const _stacks = new Map([["/repo", { lang: "TypeScript", framework: "React", test: "vitest" }]]);
  // 真的没打开文件夹：两端都如实降级，这条路不变。
  assert.deepEqual(evidence({}, new Map())(""),
    { hasWorkspace: false, snapshotReady: false, topLevel: [], stack: {} },
    "没打开文件夹时必须如实说没有，而不是报假证据");
  // 扫过的工作区：不管在哪个构建上，扫出来的事实都要交出去。
  const got = evidence(_scanned, _stacks)("/repo");
  assert.equal(got.hasWorkspace, true);
  assert.equal(got.snapshotReady, true, "扫过就是扫过——快照状态不该被构建类型抹掉");
  assert.deepEqual(got.topLevel, ["src", "package.json", "test"],
    "顶层文件名没交出去，分类器只能从一句话里猜项目长什么样");
  assert.equal(got.stack.lang, "TypeScript");
  assert.equal(got.stack.framework, "React");
  assert.equal(got.stack.test, "vitest");
});
