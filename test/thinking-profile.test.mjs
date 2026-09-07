// 推理档位（src/agent/thinking-profile.js）的真往返：内置表 → 实时目录合并 → 用户偏好 → 请求字段。
// 直接 import 产品模块，不抠源码；它要的三个 main.js 事实（图像模型判定 / 实时目录 / 自定义条目）用桩注入。
import assert from "node:assert/strict";
import test from "node:test";
import {
  configureThinkingProfile, _THINK_LEVELS, _thinkLabels, _claudeGeneration, _liveThinkingLevels, _effortIsSendable,
  _thinkingProfileFor, _builtinThinkingProfileFor, _supportsThinking, _thinkingPrefFor, _setThinkingPref,
  _applyThinkingToConfig, _isAnthropicWireFamily, _loadThinkingPrefs,
} from "../src/agent/thinking-profile.js";

// 偏好走 localStorage；Node 里没有，挂一个内存版。挂不上的话「存了再读」那条会当场红，不会静默变成空表。
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
});
const catalog = new Map();   // 模型 id → { supportedEfforts }
const customs = new Map();   // "custom:x" → { name }
const deps = {
  _isImageModel: (id) => /image|图像/i.test(String(id || "")),
  _modelCatalogEntry: (id) => catalog.get(id) || null,
  _customModelById: (id) => customs.get(id) || null,
};
configureThinkingProfile(deps);
const kindOf = (id) => _builtinThinkingProfileFor(id).kind;

test("内置表按模型家族给出旋钮形状（kind），未知的一律 none 而不是乱发字段", () => {
  assert.equal(kindOf("gpt-5.6-sol"), "reasoning_effort");
  assert.equal(_builtinThinkingProfileFor("gpt-5.6-sol").defaultLevel, "xhigh", "gpt-5.6 默认 xhigh 是实测过的");
  assert.deepEqual(_builtinThinkingProfileFor("o3-mini").levels, ["off", "low", "medium", "high"]);
  assert.equal(kindOf("claude-opus-5"), "adaptive_thinking");
  assert.ok(_builtinThinkingProfileFor("claude-opus-5").levels.includes("off"));
  assert.equal(kindOf("claude-fable-5-1"), "adaptive_thinking");
  assert.ok(!_builtinThinkingProfileFor("claude-fable-5-1").levels.includes("off"), "Fable 思考常开，不该摆一个关不掉的按钮");
  assert.equal(kindOf("claude-sonnet-4-5"), "thinking_budget");
  assert.equal(_builtinThinkingProfileFor("claude-sonnet-4-5").budgets.high, 24000);
  assert.equal(_builtinThinkingProfileFor("claude-3-7-sonnet-20250219").budgets.high, 12000);
  assert.equal(kindOf("claude-haiku-4-5"), "none");
  assert.equal(kindOf("gemini-3-pro"), "thinking_level");
  assert.deepEqual(_builtinThinkingProfileFor("gemini-3-flash").levels, ["minimal", "low", "medium", "high"]);
  assert.equal(kindOf("gemini-2.5-flash"), "gemini_budget");
  assert.equal(_builtinThinkingProfileFor("gemini-2.5-flash").budgets.off, 0);
  assert.equal(kindOf("kimi-k2.5"), "kimi-toggle");
  assert.equal(_builtinThinkingProfileFor("kimi-k2.5").booleanToggle, true);
  assert.equal(kindOf("glm-5.2"), "kimi-toggle");
  assert.equal(kindOf("deepseek-v4"), "none");
  assert.equal(kindOf("grok-4.6"), "reasoning_effort");
  assert.equal(_builtinThinkingProfileFor("grok-4.6").noOff, true);
  assert.equal(kindOf("some-unknown-model"), "none");
  assert.equal(_builtinThinkingProfileFor("some-unknown-model").configurable, false);
});

test("图像模型是本地事实：注入的 _isImageModel 说是图像，就没有思考档位", () => {
  assert.equal(kindOf("gpt-image-1"), "none");
  // 目录哪怕声明了档位也不覆盖（画图模型没有推理档位这回事）。
  catalog.set("gpt-image-1", { supportedEfforts: ["high", "xhigh"] });
  assert.equal(_thinkingProfileFor("gpt-image-1").configurable, false);
  catalog.delete("gpt-image-1");
});

test("自定义条目按真实上游名判能力；Claude 别名猜不出代次时不猜（发错形状是硬 400）", () => {
  customs.set("custom:aa", { name: "sonnet-latest" });
  customs.set("custom:bb", { name: "gpt-5.6-sol" });
  assert.equal(kindOf("custom:aa"), "none");
  assert.match(_builtinThinkingProfileFor("custom:aa").disabledReason, /代次/);
  assert.equal(kindOf("custom:bb"), "reasoning_effort");
  assert.equal(_builtinThinkingProfileFor("custom:bb").defaultLevel, "xhigh");
});

test("_claudeGeneration：按代次比较，不是逐个版本串", () => {
  assert.equal(_claudeGeneration("claude-opus-4-8"), 4.8);
  assert.equal(_claudeGeneration("claude-sonnet-5"), 5);
  assert.equal(_claudeGeneration("claude-3-7-sonnet-20250219"), 3.7);
  assert.equal(_claudeGeneration("sonnet-latest"), 0);
});

test("_effortIsSendable：档位能不能被这个 kind 变成请求字段", () => {
  assert.equal(_effortIsSendable({ kind: "none" }, "off"), true, "off 永远发得出去（就是不发）");
  assert.equal(_effortIsSendable({ kind: "none" }, "high"), false);
  assert.equal(_effortIsSendable({ kind: "reasoning_effort" }, "banana"), true, "effort 族直接发档位名");
  assert.equal(_effortIsSendable({ kind: "thinking_budget", budgets: { high: 24000 } }, "high"), true);
  assert.equal(_effortIsSendable({ kind: "thinking_budget", budgets: { high: 24000 } }, "xhigh"), false, "查不到预算数字的档位摆出来就是骗人");
  assert.equal(_effortIsSendable({ kind: "kimi-toggle" }, "xhigh"), true, "布尔开关族现在开关和档位一起发");
});

test("_liveThinkingLevels：目录只给名单；none→off；没这一款或不吃档位都交还内置表", () => {
  catalog.set("m1", { supportedEfforts: ["none", "high"] });
  catalog.set("m2", { supportedEfforts: [] });
  assert.deepEqual(_liveThinkingLevels("m1"), ["off", "high"]);
  assert.equal(_liveThinkingLevels("m2"), null);
  assert.equal(_liveThinkingLevels("never-heard-of"), null);
  configureThinkingProfile({ _modelCatalogEntry: () => { throw new Error("目录炸了"); } });
  assert.equal(_liveThinkingLevels("m1"), null, "目录抛错时不能把整个档位表拖垮");
  configureThinkingProfile(deps);
});

test("合并：内置表说没档位而目录明确列了 → 以目录为准（deepseek-v4-flash 那次事故）", () => {
  catalog.set("deepseek-v4-flash", { supportedEfforts: ["xhigh", "high"] });
  const p = _thinkingProfileFor("deepseek-v4-flash");
  assert.equal(p.configurable, true);
  assert.equal(p.kind, "reasoning_effort");
  assert.deepEqual(p.levels, ["off", "high", "xhigh"], "按本地既有顺序排、off 永远保留");
  assert.equal(p.defaultLevel, "high");
});

test("合并：可调模型的名单以目录为准，但每一档都要先过 _effortIsSendable", () => {
  catalog.set("gpt-5.6-sol", { supportedEfforts: ["low", "high"] });
  const p = _thinkingProfileFor("gpt-5.6-sol");
  assert.deepEqual(p.levels, ["off", "low", "high"]);
  assert.equal(p.defaultLevel, "high", "内置默认 xhigh 不在名单里 → 取名单最深一档");
  catalog.delete("gpt-5.6-sol");
  // thinking_budget 族：目录给了 xhigh 但没有预算数字 → 一档都发不出去 → 内置表原样
  catalog.set("claude-sonnet-4-5", { supportedEfforts: ["xhigh"] });
  assert.deepEqual(_thinkingProfileFor("claude-sonnet-4-5"), _builtinThinkingProfileFor("claude-sonnet-4-5"));
  catalog.delete("claude-sonnet-4-5");
  // 布尔开关族：目录给了不止一档，两态开关的断言就不再成立
  catalog.set("glm-5.2", { supportedEfforts: ["high", "xhigh"] });
  const g = _thinkingProfileFor("glm-5.2");
  assert.deepEqual(g.levels, ["off", "high", "xhigh"]);
  assert.equal(g.booleanToggle, false, "多出来的档位不能被两态开关吞掉");
});

test("偏好：没选过取默认（默认不缩水），选过的只要还在名单里就永远优先；存了真能读回来", () => {
  store.clear();
  assert.equal(_thinkingPrefFor("gpt-5.6-sol"), "xhigh");
  assert.equal(_thinkingPrefFor("deepseek-v4"), "off");
  _setThinkingPref("gpt-5.6-sol", "low");
  assert.equal(_thinkingPrefFor("gpt-5.6-sol"), "low");
  assert.deepEqual(_loadThinkingPrefs(), { "gpt-5.6-sol": "low" }, "偏好没落到存储里（localStorage 桩没挂上？）");
  _setThinkingPref("o3-mini", "xhigh");   // o3-mini 没有 xhigh 这一档：拒绝写入
  assert.equal(_thinkingPrefFor("o3-mini"), "high");
  assert.equal(_supportsThinking("gpt-5.6-sol"), true);
  assert.equal(_supportsThinking("deepseek-v4"), false);
});

test("_applyThinkingToConfig：用户选什么就发什么，按 kind 构造字段；旧字段先清空", () => {
  store.clear();
  const gpt = _applyThinkingToConfig({ model: "gpt-5.6-sol", other: "keep" });
  assert.equal(gpt.reasoningEffort, "xhigh");
  assert.equal(gpt.thinkingEffort, "xhigh");
  assert.equal(gpt.other, "keep", "整份展开：别的键必须原样带过去（semantic-profile 靠这个活）");
  assert.ok(!("thinking" in gpt));
  _setThinkingPref("gpt-5.6-sol", "off");
  const gptOff = _applyThinkingToConfig({ model: "gpt-5.6-sol", reasoningEffort: "high", thinkingBudget: 5 });
  assert.equal(gptOff.thinkingEffort, "off");
  assert.ok(!("reasoningEffort" in gptOff) && !("thinkingBudget" in gptOff), "off 时不发 effort，且旧字段不能残留");

  const opus = _applyThinkingToConfig({ model: "claude-opus-5" });
  assert.equal(opus.reasoningEffort, "high");
  assert.deepEqual(opus.thinking, { type: "adaptive" });
  _setThinkingPref("claude-opus-5", "off");
  assert.deepEqual(_applyThinkingToConfig({ model: "claude-opus-5" }).thinking, { type: "disabled" },
    "adaptive 族的 off 必须显式发 disabled：不发字段等于默认开到最深");

  _setThinkingPref("claude-sonnet-4-5", "medium");
  const s45 = _applyThinkingToConfig({ model: "claude-sonnet-4-5" });
  assert.equal(s45.thinkingBudget, 12000);
  assert.deepEqual(s45.thinking, { type: "enabled", budget_tokens: 12000 });
  assert.equal(s45.reasoningEffort, "medium", "双保险：网关桥没有 effort 时会把一切 thinking 推断成 high");

  _setThinkingPref("gemini-2.5-flash", "off");
  const gemOff = _applyThinkingToConfig({ model: "gemini-2.5-flash" });
  assert.equal(gemOff.thinkingBudget, 0);
  assert.deepEqual(gemOff.thinkingConfig, { thinkingBudget: 0 });
  assert.ok(!("thinking" in gemOff));

  _setThinkingPref("gemini-3-flash", "minimal");
  const g3 = _applyThinkingToConfig({ model: "gemini-3-flash" });
  assert.deepEqual(g3.thinkingConfig, { thinkingLevel: "minimal" });
  assert.equal(g3.reasoningEffort, "low", "minimal 映射成标准字段的 low，聚合渠道只认 reasoning_effort");

  const kimi = _applyThinkingToConfig({ model: "kimi-k2.5" });
  assert.deepEqual(kimi.thinking, { type: "enabled" });
  assert.ok(!("reasoningEffort" in kimi), "只有开关的模型不平白多一个字段");
  catalog.set("glm-5.2", { supportedEfforts: ["high", "xhigh"] });
  _setThinkingPref("glm-5.2", "xhigh");
  const glm = _applyThinkingToConfig({ model: "glm-5.2" });
  assert.deepEqual(glm.thinking, { type: "enabled" });
  assert.equal(glm.reasoningEffort, "xhigh", "目录真给了多档时档位额外带一份，否则拨到超高和拨到高发出去的请求逐字节相同");
});

test("自定义连接：能力看真实上游名，偏好按选择器 id 存——两个身份不能混", () => {
  store.clear();
  customs.set("custom:bb", { name: "gpt-5.6-sol" });
  _setThinkingPref("custom:bb", "low");
  const out = _applyThinkingToConfig({ model: "gpt-5.6-sol", customModelId: "custom:bb" });
  assert.equal(out.reasoningEffort, "low");
  assert.equal(_thinkingPrefFor("gpt-5.6-sol"), "xhigh", "选择器上的偏好不能串到同名的网关模型上");
});

test("标签 / 线材家族 / 档位表", () => {
  assert.deepEqual(Object.keys(_thinkLabels()), _THINK_LEVELS);
  assert.equal(_thinkLabels({ high: "X" }).high, "X");
  assert.equal(_isAnthropicWireFamily("claude-haiku-4-5"), true, "Haiku 没档位但照样走 anthropic 桥");
  assert.equal(_isAnthropicWireFamily("gpt-5.6-sol"), false);
  assert.deepEqual(_THINK_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});
