// 语义画像必须真的到达网关。
//
// 生产实测（近 24 小时、46 次 agent 模式请求）：
//     prompt_blocks = ["agent_core","reasoning","truthfulness","answer_quality"]
//     semantic_profile_seen = []
// 46/46 画像为空，agent_engineering 装载 0 次。而 prompt_graph.json 里 agent.base 恰好就是
// 那四块——也就是说整个「按任务加载」的层一次都没挂上过：engineering / research /
// automation / collaboration / defect_hunting / design_* 全家。
//
// 会话画像是**单调并集**（_sessionStableSemanticProfile），一旦某轮落地过旗标，之后每轮都
// 会带上。46/46 全空因此不是「偶尔迟到」，是**一次都没落地过**。
//
// 根因（本文件逐条钉住）：
//   ① 快通道（_fastRoutingFlags）的结果原来只有一个读者——发车前那一行同步的
//      `_fastRouteProfile || _turnEngineeringResolved`。它跑在一个 6 秒 race 之后，而快通道
//      自己是一次完整的模型调用（生产首响应头 8~18 秒），结构上赢不了。赢不了 = 结果无人读。
//   ② 快通道的启动判据挂在 `!sess._intentWaitPaid` 上，而那个标志记的是「等过一次」——
//      于是一条会话总共只有一次机会，还被关在赢不了的窗口里。
//   ③ 完整裁决迟到有 _applyLateIntentIfLanded 兜底，快通道**没有对应的落地点**，
//      执行事实也没有任何下限。三个洞叠起来，画像恒空。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SRC, CODE, fnSource, load } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_RS = readFileSync(join(HERE, "../../server/src/prompts.rs"), "utf8");
const PROMPT_GRAPH = JSON.parse(readFileSync(join(HERE, "../../server/prompts/prompt_graph.json"), "utf8"));
const AI_RS = readFileSync(join(HERE, "../src-tauri/src/ai.rs"), "utf8");

const semanticProfile = load("_ideSemanticProfile", ["_ideSemanticProfile"]);
const stable = load("_sessionStableSemanticProfile", ["_sessionStableSemanticProfile"]);
const applyFast = load("_applyFastRouteProfileIfLanded",
  ["_ideSemanticProfile", "_sessionStableSemanticProfile", "_applyFastRouteProfileIfLanded"]);
const execFacts = load("_executionFactSemanticFlags", ["_executionFactSemanticFlags"]);
const applyExec = load("_applyExecutionFactProfile",
  ["_ideSemanticProfile", "_sessionStableSemanticProfile", "_executionFactSemanticFlags", "_applyExecutionFactProfile"]);

/**
 * 桌面端把 config.ideSemanticProfile 变成 x-ide-semantic-profile 的那道校验，
 * 逐字来自 src-tauri/src/ai.rs::with_ide_headers。不满足就**整个头不发**，
 * 网关那边看到的就是 semantic_profile_seen=[]。
 */
function transportAccepts(header) {
  const value = String(header || "");
  return value.startsWith("2.5:")
    && value.length <= 1024
    && /^[a-z0-9.:,_]*$/.test(value);
}

/** 网关的选块判据：mode == "agent" && semantic_profile 里有 "engineering"。 */
function gatewayBlocksFor(mode, header) {
  const flags = new Set(String(header || "").replace(/^2\.5:/, "").split(",").filter(Boolean));
  const blocks = [...PROMPT_GRAPH.agent.base];
  if (mode === "agent" && flags.has("engineering")) blocks.push(...PROMPT_GRAPH.agent.engineering);
  return blocks;
}

test("转运层与网关判据没有漂：本文件模拟的那两道门就是生产里的那两道", () => {
  // ① 桌面端的头校验（ai.rs）。
  assert.match(AI_RS, /config\s*\.\s*ide_semantic_profile\s*\.as_deref\(\)\s*\.filter\(\|profile\|\s*\{\s*profile\.starts_with\("2\.5:"\)/,
    "ai.rs 里那道 2.5: 前缀校验变了——本文件的 transportAccepts 就不再代表真实转运层");
  assert.match(AI_RS, /rb = rb\.header\("x-ide-semantic-profile", profile\)/,
    "桌面端不再发 x-ide-semantic-profile 头了");

  // ② 网关的选块判据（prompts.rs）。这是「agent_engineering 到底什么时候挂」的唯一真源。
  assert.match(GATEWAY_RS, /let engineering_intent = mode == "agent" && semantic\("engineering"\);/,
    "网关的 engineering 判据变了——客户端发的旗标名必须跟着改，否则整层又是黑的");
  assert.match(GATEWAY_RS, /append_prompt_modules\(&graph\.agent\.engineering, &mut sys, &mut prompt_blocks\)\?;/,
    "engineering 分支不再装载 graph.agent.engineering");

  // ③ 生产日志里那四块，就是 graph 里的 agent.base——「画像空 = 只剩基础四块」得到复核。
  // system_invariants 是**指令层级**，2026-09-02 加的，排在每个模式的第一块：
  // 它是全系统唯一一条说明"几种指令谁大谁小"的排序，客户端任何文本都不该排到它前面。
  assert.deepEqual(PROMPT_GRAPH.agent.base,
    ["system_invariants", "agent_core", "reasoning", "truthfulness", "answer_quality"]);
  assert.deepEqual(PROMPT_GRAPH.agent.engineering, ["agent_engineering"]);
});

test("端到端：快通道旗标落地 → 请求头 → 网关真的挂上 agent_engineering", () => {
  // 一条**全新会话**，画像还是空的——生产里 46 次请求全部处在这个状态。
  const session = {};
  const config = {};
  // 出发时：没有任何旗标。这正是坏掉的那一版每一轮的样子。
  const atSend = stable(session, semanticProfile({ intentSource: "pending" }));
  assert.equal(atSend, "2.5:");
  assert.deepEqual(gatewayBlocksFor("agent", atSend), PROMPT_GRAPH.agent.base,
    "空画像下网关只挂基础四块——这就是生产日志里的那一行");

  // 快通道在第一个模型回合期间落定（模型自己声明的旗标，不是词表猜的）。
  const run = {
    _intentState: { fastProfile: { implementation: true, workspaceAction: "modify", changeScope: "module" } },
  };
  assert.equal(applyFast(run, config, session), true, "快通道落地后必须写请求头");

  // 落地后：头能通过桌面端的转运校验，且网关按它挂上 agent_engineering。
  assert.ok(transportAccepts(config.ideSemanticProfile),
    `头没通过 ai.rs 的校验，等于整个头不发：${config.ideSemanticProfile}`);
  const blocks = gatewayBlocksFor("agent", config.ideSemanticProfile);
  assert.ok(blocks.includes("agent_engineering"),
    `agent_engineering 仍然没挂上：profile=${config.ideSemanticProfile} blocks=${blocks.join(",")}`);

  // 幂等：同一个 run 只写一次，不会每个循环边界都重算一遍。
  assert.equal(applyFast(run, config, session), false);

  // 粘性：会话拿到过一次，之后每一轮（哪怕那一轮画像算出来是空的）都还带着。
  const laterTurn = stable(session, semanticProfile({ intentSource: "pending" }));
  assert.ok(gatewayBlocksFor("agent", laterTurn).includes("agent_engineering"),
    "会话级单调并集断了——第二轮又掉回基础四块");
});

test("快通道的结果必须有落地点，不能只被那一行同步表达式读一次", () => {
  const send = fnSource("sendPrompt", { code: true });
  const then = send.slice(send.indexOf("_fastRoutingFlags(text, config, sess"));
  assert.ok(then.length > 0, "sendPrompt 里找不到快通道的启动点");

  // 结果必须写进**跨越这一轮的**状态里：_turnIntentState 会随 run 一起走到循环边界，
  // 而 sess 的旗标是会话级单调并集。只写局部变量 _fastRouteProfile 等于没有读者。
  const head = then.slice(0, 900);
  assert.match(head, /_turnIntentState\.fastProfile = p/,
    "快通道的结果没有交给 _turnIntentState——它就到不了循环边界，赢不了那 6 秒 race 就等于白跑");
  assert.match(head, /config\.ideSemanticProfile = _sessionStableSemanticProfile\(sess, _ideSemanticProfile\(p\)\)/,
    "快通道落定时没有并进会话画像");

  // 启动判据不许再挂在「等过一次」上：那个标志一置真，整条会话就再也不发快通道了。
  const start = send.slice(send.indexOf("const _fastRoute = "), send.indexOf("const _fastRoute = ") + 200);
  assert.doesNotMatch(start, /_intentWaitPaid/,
    "快通道又被挂回 _intentWaitPaid 上了：那记的是「等过一次」，一条会话只剩一次机会，"
    + "而那次机会关在一个它结构上赢不了的 6 秒窗口里");
  assert.match(start, /!_sessionFlags\.length|_profileStillEmpty/,
    "启动判据应当是「会话画像还空」——空才值得再花一次 200 token 的快通道");

  // 两条腿仍然并行 race（第一轮能赶上就直接带上旗标出门，这条没变）。
  assert.match(CODE, /Promise\.race\(\[\s*_turnIntentExactPromise,\s*_fastRoute,/,
    "两条腿必须在同一个 race 里");
});

test("每个采纳迟到裁决的循环边界，都必须同时收快通道和执行事实", () => {
  const late = (CODE.match(/_applyLateIntentIfLanded\(run, config, task, session, body, _live, messages\);/g) || []).length;
  const fast = (CODE.match(/_applyFastRouteProfileIfLanded\(run, config, session\);/g) || []).length;
  const facts = (CODE.match(/_applyExecutionFactProfile\(run, config, session\);/g) || []).length;
  assert.ok(late >= 3, "迟到裁决的采纳点少了");
  assert.equal(fast, late,
    "有边界只采纳完整裁决、不收快通道——而完整裁决实测 19.8 秒且在生产里从未落地过，"
    + "只靠它就是回到画像恒空");
  assert.equal(facts, late, "执行事实的下限没有覆盖每一个边界");
});

test("执行事实给的是下限，且一个字的用户措辞都不看", () => {
  // 什么都没发生 → 什么都不发。绝不凭空造旗标。
  assert.deepEqual(execFacts(null), {});
  assert.deepEqual(execFacts({}), {});
  assert.deepEqual(execFacts({ _writeLedger: [] }), {});

  // 这一轮真的往工作区落过盘 → 这一轮就是工程活。这不是预测，是已经发生的执行事实。
  assert.deepEqual(execFacts({ _writeLedger: [{ path: "src/a.js", ok: true }] }), { implementation: true });
  assert.ok(semanticProfile(execFacts({ _writeLedger: [{ path: "src/a.js", ok: true }] })).includes("engineering"));

  // 工作区根有 ready 的顶层快照 → 磁盘上确实有一个已有项目。
  const withWorkspace = execFacts({
    _intentState: { context: { workspaceEvidence: { hasWorkspace: true, snapshotReady: true, topLevel: ["package.json"] } } },
  });
  assert.deepEqual(withWorkspace, { existingProject: true });
  // 快照没就绪就不算数——「打开了一个目录」本身不构成「这是个已有项目」。
  assert.deepEqual(execFacts({
    _intentState: { context: { workspaceEvidence: { hasWorkspace: true, snapshotReady: false, topLevel: [] } } },
  }), {});

  // 判据里不许出现任何读用户原文的东西：正则只允许用于权限与地板。
  const fn = fnSource("_executionFactSemanticFlags", { code: true });
  assert.doesNotMatch(fn, /\/[^/\n]+\/[gimsuy]*\.test\(|\.match\(|includes\("|toLowerCase\(\)/,
    "执行事实的判据里出现了文本匹配——那就是词表兜底又回来了");
  assert.doesNotMatch(fn, /\btask\b|\btext\b|_originalText|lastUserText/,
    "执行事实不许读用户这一轮说了什么，它只看真的发生了什么");
});

test("执行事实同样走单调并集，且没有新事实时不重写请求头", () => {
  const session = {};
  const config = {};
  // 没有事实 → 一个字都不写（不要每个边界都刷一次 byte 0，那正是前缀缓存要防的事）。
  assert.equal(applyExec({}, config, session), false);
  assert.equal(config.ideSemanticProfile, undefined);

  const run = { _writeLedger: [{ path: "src/a.js", ok: true }] };
  assert.equal(applyExec(run, config, session), true);
  assert.ok(gatewayBlocksFor("agent", config.ideSemanticProfile).includes("agent_engineering"),
    "落过盘的一轮仍然没能让 agent_engineering 挂上");
  assert.ok(transportAccepts(config.ideSemanticProfile));
  // 同样的事实第二次不再重写——旗标已经在并集里了。
  assert.equal(applyExec(run, config, session), false);
});

test("画像的每一次写入仍然只经由单调并集", () => {
  const assignments = SRC.match(/config\.ideSemanticProfile\s*=\s*[^;]+;/g) || [];
  assert.ok(assignments.length >= 5, "画像的写入点少了——新加的落地点是不是被摘了");
  for (const line of assignments) {
    assert.match(line, /_sessionStableSemanticProfile\(/, `未经并集的画像写入：${line}`);
  }
});
