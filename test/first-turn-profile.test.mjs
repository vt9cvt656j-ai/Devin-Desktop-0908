// 会话第一轮的第一发模型调用，语义画像是空的——而那正是决定技术栈和目录结构的一发。
//
// 后果不是"少挂一个模块"：画像空掉时同时丢掉
//   · IDE 侧 2000 多字符的工程决策律（交付规格 / 先读懂再动手 / 变更半径 / 可维护升级）；
//   · 网关侧 agent_engineering 整块 13KB——里面逐字写着模块边界、反硬编码，以及
//     「Prefer a mature, mainstream solution over building your own」；
//   · 按领域限定的语料检索与专业域小抄。
// 等第二轮补上时，模型已经把栈和目录写死了。用户看到的就是「不懂架构、不用主流库」。
//
// 两处成因都是**时序**，不是缺规则：
//   一、打字空闲时的预热对「本进程第一条消息」永远不跑（凭证只在 sendPrompt 内部写）；
//   二、（2026-09-05 已换掉）原来第一发要在一个 6 秒窗口里等裁决：等到的很少，每个新会话
//       却固定多付几秒静默。现在第一发不等，预热是它带上完整画像的唯一途径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, fnSource as topLevelFn } from "./helpers/source.mjs";

const PREFETCH = topLevelFn("_prefetchIntentFromComposer", { code: true });

// ── 一、预热必须对第一条消息生效 ────────────────────────────────────────
test("预热不再只认「跑过一轮才有」的那份凭证", () => {
  // _lastGoodAiConfig 全仓只有一处写入，在 sendPrompt 内部。只认它 = 应用启动后的
  // 第一条消息一次都不预热，而那是唯一一条要付等待窗口的消息。
  assert.doesNotMatch(PREFETCH, /if \(!inTauri \|\| !_lastGoodAiConfig\) return;/,
    "还是只认跑过一轮才有的凭证——第一条消息永远不预热，而它恰恰是唯一需要预热的那条");
  assert.match(PREFETCH, /loadConfig\(\)/,
    "没有回落到持久化配置，第一条消息仍然拿不到凭证");
});

test("预热用的是纯读配置，绝不能走会弹登录门的那条", () => {
  // _readyAiConfig 会调 michaelAccessGate()。挂在「用户正在打字」这条空闲路径上，
  // 等于随时可能在打字中途弹一个登录框出来。
  assert.doesNotMatch(PREFETCH, /_readyAiConfig/,
    "预热走了会触发登录门的配置入口——用户打字打到一半会被弹框打断");
  assert.doesNotMatch(PREFETCH, /michaelAccessGate/, "同上");
});

test("凭证不全就不发：缺一样这次请求必然失败", () => {
  assert.match(PREFETCH, /baseUrl && [\w.]*\.?apiKey && [\w.]*\.?model|c\.baseUrl && c\.apiKey && c\.model/,
    "没检查三件套就发预热——凭证不全时是白发一次");
});

test("发出去的是新解析的那份凭证，不是原来那个只在跑过一轮后才有的变量", () => {
  // 只加了回落却仍然把 _lastGoodAiConfig 传下去，等于回落白做——这是最容易漏的一半。
  const call = /_aiIntentProfile\(t, ([A-Za-z_$][\w$]*), sess, ctx\)/.exec(PREFETCH);
  assert.ok(call, "预热的发起调用不见了");
  assert.notEqual(call[1], "_lastGoodAiConfig",
    "回落算出来的凭证没被用上——第一条消息仍然预热不了");
});

test("预热不额外多发一次请求", () => {
  // 单飞去重 + 同键缓存是这条改动「零成本」的全部依据。它们没了，预热就变成每次打字
  // 都多打一次付费请求。
  assert.match(PREFETCH, /_aiIntentCache\.get\(key\) \|\| _aiIntentInflight\.get\(key\)/,
    "去重那道判据没了——预热会变成额外的付费请求");
  assert.match(PREFETCH, /if \(t === _intentPrefetchedText\) return;/, "同一句话被重复预取");
});

// ── 二、第一发不等裁决 ──────────────────────────────────────────────
const SEND = topLevelFn("sendPrompt", { code: true });

test("第一发不等裁决：预热命中就同步采纳，没命中就带 unjudged 发车", () => {
  // 2026-09-05 起 sendPrompt 里没有等待窗口：快通道和完整裁决都在后台跑，落定由循环边界补。
  // 于是预热成了第一发能带上完整画像的**唯一**途径——它命中时 _engineeringProfileWithAiIntent
  // 同步就从 _aiIntentCache 取到裁决；没命中时请求头带 unjudged，网关按工程任务默认挂块。
  assert.doesNotMatch(SEND, /_intentWaitPaid|_FIRST_TURN_INTENT_WAIT_MS|_waitStartedAt|_restTimer/,
    "等待窗口回来了——它每个新会话固定多付 4~6 秒静默，而生产里它想等的裁决中位 80 秒才到");
  assert.match(SEND, /const _fastRoute = /, "快通道的起跑点没了——画像还空时它仍然要后台跑");
  assert.match(topLevelFn("_engineeringProfileWithAiIntent", { code: true }), /_aiIntentCache\.get\(/,
    "同步取画像那条路不读缓存了——预热命中也带不上画像，第一发又裸着出门");
  assert.match(SRC, /_applyLateIntentIfLanded\(run, config, task, session, body, _live, messages\);/,
    "迟到裁决的补录路径没了——不等之后它是完整裁决唯一的落地点");
});

// ── 三、行为闸门的边界不许被这次改动动到 ────────────────────────────────
test("请求头可以用快通道，行为闸门仍然只认完整裁决", () => {
  // 这是本仓库写死的一条边界（test/intent-timing.test.mjs 正面守着）：
  // 给模型的**信息**可以走快通道，harness 自己的**闸门**只认完整裁决。
  assert.doesNotMatch(SRC, /_uiTurnEngineering = _fastRouteProfile|run\.engineering = _fastRouteProfile/,
    "快通道的结果被当成行为闸门的依据了");
});
