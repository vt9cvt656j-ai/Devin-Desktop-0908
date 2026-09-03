// 循环里每轮重铺思考配置时，**语义画像不许被盖回发车快照**。
//
// 机制：`_applyThinkingToConfig(cfg)` 返回的是 `{ ...cfg }` —— 整份展开。所以循环里那句
// `Object.assign(config, _applyThinkingToConfig(_rawConfig, …))` 会把 _rawConfig 上的每一个键
// 写回 config，包括 20 行前刚由 `_applyFastRouteProfileIfLanded` / `_applyExecutionFactProfile`
// 算出来的 `ideSemanticProfile`（它们写在 config 上，_rawConfig 里是发车时那一份）。
//
// 后果不是"功能没生效"——请求头一直在发（发车前就写好了），而且
// `_sessionStableSemanticProfile` 把旗标并进 session._semanticProfileFlags（单调并集），
// 下一轮会带上。真实缺陷是**晚一个用户轮**：网关按 x-ide-semantic-profile 决定往系统提示里
// 拼哪几层领域提示，而完整裁决实测 6.9~19.8 秒、几乎总是迟到，于是「本轮补上的领域层」
// 几乎总是白算。
//
// 这条守两件事：① 那个映射器确实是整份展开（不是只回思考字段——如果哪天改了，这道保护
// 就多余但无害）；② 循环里那句 assign 前后确实保住了画像。
import assert from "node:assert/strict";
import test from "node:test";
import { fnSource, load } from "./helpers/source.mjs";

test("映射器返回整份展开——这正是画像会被盖掉的原因", () => {
  const src = fnSource("_applyThinkingToConfig", { code: true });
  assert.match(src, /const out = \{ \.\.\.cfg \};/,
    "映射器不再整份展开了？那这道保护的前提变了，回去重读循环里那句 assign");
  // 它删的是思考字段，不碰画像 —— 所以「保住画像」不会破坏它的本意。
  for (const f of ["reasoningEffort", "thinkingBudget", "thinking", "thinkingConfig", "thinkingEffort"]) {
    assert.match(src, new RegExp("delete out\\." + f + ";"), `映射器不再重建 ${f} 了`);
  }
  assert.doesNotMatch(src, /delete out\.ideSemanticProfile/, "映射器不该碰画像");
});

test("真跑一遍：整份展开确实会把循环内算出的画像盖回发车快照", () => {
  // load 的依赖清单是手工的：函数体里的自由标识符一个都不能漏，漏了是 ReferenceError
  // 而不是断言失败（这一轮已经踩过好几次）。这两个是 grep 出来的实际调用。
  const apply = load("_applyThinkingToConfig", {
    _thinkingProfileFor: () => ({ family: "openai", effort: "off" }),
    _thinkingPrefFor: () => "off",
  });
  const raw = { model: "m", ideSemanticProfile: "2.5:engineering" };
  const config = { ...raw };
  config.ideSemanticProfile = "2.5:engineering,domain_web,design";   // 循环内补上的
  Object.assign(config, apply(raw, { agentTurn: true }));
  assert.equal(config.ideSemanticProfile, "2.5:engineering",
    "如果这里不再被盖回去，说明映射器变了 —— 循环里那道保护可以撤，但要先确认");
});

test("循环里那句 assign 前后保住了画像", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  // 锚点跟着改法走：现在是先算出 _thinkRebuilt、摘掉画像、再 assign。
  const at = loop.indexOf("const _thinkRebuilt = _applyThinkingToConfig(_rawConfig");
  assert.ok(at > 0, "每轮重铺思考配置那句不见了");
  const seg = loop.slice(Math.max(0, at - 300), at + 300);
  assert.match(seg, /delete _thinkRebuilt\.ideSemanticProfile;/,
    "没把画像从这次重铺的源里摘掉 —— 循环内补上的领域旗标会被盖回发车快照，领域提示层晚一个用户轮才生效");
  // **必须先摘再 assign**：反过来就是先覆盖再删，画像已经没了。
  const del = seg.indexOf("delete _thinkRebuilt.ideSemanticProfile");
  const assign = seg.indexOf("Object.assign(config, _thinkRebuilt)");
  assert.ok(del > 0 && assign > del, "摘和覆盖的顺序错了，保护无效");
  // 做法上刻意**不做**「存下来再写回」：那会构成一次对 config.ideSemanticProfile 的直接赋值，
  // 绕过 _sessionStableSemanticProfile 的单调并集（有两条测试正面守着那条不变量）。
  assert.doesNotMatch(seg, /config\.ideSemanticProfile = /,
    "又变回直接赋值了 —— 会绕过画像的单调并集");
});

test("从没算过画像时也不会凭空多出一个键", () => {
  // 缺键和空串对网关是不同的：缺键 = 不路由领域层；空串 = 路由一个空画像。
  // 「从源里摘掉」这个做法天然不会造键 —— 循环内没算过画像时，config 上就还是没有它。
  const loop = fnSource("_runAgenticLoop", { code: true });
  const at = loop.indexOf("delete _thinkRebuilt.ideSemanticProfile");
  assert.ok(at > 0);
  assert.doesNotMatch(loop.slice(at, at + 300), /config\.ideSemanticProfile\s*=/,
    "又出现直接赋值了 —— 没算过画像时会凭空造一个键");
});
