// Plan 模式 → 用户放行 → 自动切回 Agent。所有者（2026-09-07）：「如果我用 plan 模式的话，那么他只能
// 写出计划给我，如果用户点击执行那些的话，记得下面 plan 模式自动切换成 agent 模式」。
// 判据（agent/plan-mode-offer.js 的 planExecuteIntent）真跑；main.js 的接线只钉调用点。
import test from "node:test";
import assert from "node:assert/strict";
import { CODE } from "./helpers/source.mjs";
import { planExecuteIntent } from "../src/agent/plan-mode-offer.js";

const go = (t) => planExecuteIntent(t).execute;

test("放行：单纯点头 / 短祈使 / 明确的执行动词", () => {
  for (const t of ["执行", "执行吧", "开始做吧", "动手", "开干", "就这么办", "就按这个方案做", "按上面的方案执行", "照这个计划来",
    "可以了，开始吧", "好的", "ok", "OK go", "没问题", "go ahead", "do it", "let's build it", "implement the plan", "proceed",
    "looks good, ship it", "实施吧", "落地", "就按这个来", "开始写代码吧"]) {
    assert.equal(go(t), true, `「${t}」该放行（${planExecuteIntent(t).reason}）`);
  }
});

test("不放行：还在问 / 在改方案 / 否定 / 新需求——判错成「切了」会把想讨论的人推去动手改文件", () => {
  for (const t of ["执行吗？", "可以执行吗", "为什么第三步要用 redis", "第三步改成 postgres", "把第二步去掉", "再详细说说第一步",
    "先别执行", "不要执行", "等一下再做", "换个方案", "重新规划一下", "帮我写个官网", "这个方案的风险是什么？",
    "explain step 2", "change step 3 to use redis", "don't do it yet", "hold on", "帮我实现一个登录页", "go ahead and change step 3"]) {
    assert.equal(go(t), false, `「${t}」不该放行（${planExecuteIntent(t).reason}）`);
  }
});

test("长段落是新需求，不是放行；裸调用不抛", () => {
  assert.equal(go("执行" + "，还有很多别的要求".repeat(40)), false);
  assert.equal(planExecuteIntent().execute, false);
  assert.equal(planExecuteIntent("").reason, "empty");
});

// ── 接线 ─────────────────────────────────────────────────────────────────────
test("三个入口都走同一条放行 _planExecute；用户打字那条在 sendPrompt 定本轮模式之前", () => {
  const code = CODE;
  const hook = code.indexOf("_planExecuteIntent(text).execute");
  const eff = code.indexOf("const effectiveMode = _normalizeAiMode(sess?.mode || _currentAiMode);");
  assert.ok(hook > 0, "sendPrompt 里没有「用户说执行」的判据");
  assert.ok(eff > hook, "判据必须在这一轮定模式之前跑，否则这一轮还是只读、模型只能再写一份方案");
  assert.match(code, /!opts\.notice && _normalizeAiMode\(sess\?\.mode \|\| _currentAiMode\) === "plan"/, "IDE 自己续上的一轮不算用户说话");
  assert.match(code, /&& _planDelivered\(sess\) && _planExecuteIntent\(text\)\.execute/, "没交付过方案时不该因为一句「执行」就切模式");
  assert.match(code, /_planExecute\(sess, \{ via: "typed" \}\);/);
  assert.match(code, /onAccept: \(\) => \{ _planExecute\(_currentSession\(\), \{ via: "plan_tab" \}\); \}/, "方案页签那颗按钮没走同一条放行");
  assert.match(code, /_planExecute\(sess \|\| _currentSession\(\), \{ via: "button" \}\);\s*sendPrompt\("按上面给出的方案逐步实施/, "回复末尾那颗按钮没走同一条放行");
});

test("放行时底部选择器和会话一起切到 Agent", () => {
  const fn = CODE.slice(CODE.indexOf("function _planExecute("), CODE.indexOf("function _planExecButton("));
  assert.match(fn, /s\.mode = "agent";/);
  assert.match(fn, /if \(s === _currentSession\(\)\) \{ _currentAiMode = "agent"; try \{ _updateModeUI\(\); \} catch \{\} \}/, "底部那个选择器没跟着切——机制变了界面没变");
  assert.match(fn, /_renderChatTabs\(\); saveChatHistory\(\{ immediate: true \}\);/);
});

test("方案消息打 planOffer 标记；重画历史时按钮画回来；放行后标记清掉并落盘", () => {
  const code = CODE;
  assert.match(code, /if \(run\.mode === "plan" && !finalErr\) \{ _planOfferClear\(session, "superseded"\); _msg\._ideMeta = \{ \.\.\.\(_msg\._ideMeta \|\| \{\}\), planOffer: true \}; \}/,
    "方案消息没打标记——重开软件、重画历史，那颗按钮就没了，剩下的入口只有打字");
  assert.match(code, /m\.role === "assistant" && m\._ideMeta\?\.planOffer === true && typeof _planExecButton === "function"/, "重画历史时没把按钮画回来");
  assert.match(code, /planOffer: false, planExecutedVia: via/, "放行后标记没清，做完的方案还挂着「执行」");
  assert.match(code, /_queueTranscriptMutation\(sess, \{ kind: "append", sequence: offset \+ i, message: m \}\)/, "清标记只改了内存没落盘——重开软件按钮又回来了");
  assert.match(code, /用 Agent 执行此方案/, "按钮上的文案是用户认得的那句");
});
