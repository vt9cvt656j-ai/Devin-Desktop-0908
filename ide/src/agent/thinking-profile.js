// 推理档位（thinking profile）：每个模型家族的思考旋钮长什么样、哪些档位真发得出去、
// 用户选了哪档、最后落到请求体上是什么字段。整族从 main.js 搬出来，一行逻辑没改。
//
// 分工（踩出来的，别合并）：
//   · _builtinThinkingProfileFor —— 按模型名猜的内置表：kind（reasoning_effort / adaptive_thinking /
//     thinking_budget / gemini_budget / thinking_level / kimi-toggle / kimi-forced / none）+ 档位 + 参数映射；
//   · _liveThinkingLevels —— 实时目录声明的档位名单（只给名单，不给 profile）；
//   · _thinkingProfileFor —— 两者合并：名单以目录为准，每一档都要过 _effortIsSendable；
//   · _thinkingPrefFor / _setThinkingPref —— 用户偏好（localStorage，按模型 id 存）；
//   · _applyThinkingToConfig —— 用户选什么就发什么，按 kind 构造请求字段。
//
// 三个 main.js 事实（图像模型判定、实时目录、自定义模型表）由 configureThinkingProfile 注入：
// 模块不能反向 import main.js。**标识符名字原样保留**（含注入进来的三个）——test/ 里
// 有几十处 load("_thinkingProfileFor", { _builtinThinkingProfileFor: … }) 按名字抠函数、按名字
// 注入依赖，改名等于让那些测试集体 ReferenceError。
import { t } from "../i18n.js";

let _isImageModel = () => false;
let _modelCatalogEntry = () => null;
let _customModelById = () => null;
/** main.js 启动时调用一次；测试里用桩。三个都可选，没给的保持默认（不认图像模型 / 目录为空 / 没有自定义条目）。 */
export function configureThinkingProfile(deps = {}) {
  if (typeof deps._isImageModel === "function") _isImageModel = deps._isImageModel;
  if (typeof deps._modelCatalogEntry === "function") _modelCatalogEntry = deps._modelCatalogEntry;
  if (typeof deps._customModelById === "function") _customModelById = deps._customModelById;
}

// ---- Per-model thinking effort -------------------------------------------
// Persisted choice per model id. This is deliberately NOT a one-size-fits-all
// `reasoning_effort` switch: each provider exposes different real knobs.
// Examples:
// - OpenAI / xAI: `reasoning_effort` (specific enums per model family)
// - Anthropic: `thinking: { type:"enabled", budget_tokens }`
// - Gemini: `thinking_config` / `thinkingBudget` or `thinkingLevel`
// - Kimi: `thinking.type` enable/disable for K2.5/K2.6; some code models are forced on
// Unknown models default to NO thinking parameter instead of sending fake fields.
export const _THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const _THINK_LABELS = {
  off: "关闭",
  minimal: "极轻",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "极限",
};
export const _THINK_TIPS = {
  off: "关闭/不发送可调思考参数；若模型本身强制内置推理，则仍按模型默认策略运行。",
  minimal: "Minimal：极轻推理，只适合非常简单的问题（仅支持部分模型）。",
  low: "Low：浅思考，权衡速度和质量。",
  medium: "Medium（推荐默认）：中等深度推理。",
  high: "High：深度推理，多数难题解得开。",
  xhigh: "XHigh：超高推理（仅支持明确有该档位的模型）。",
  max: "Max（极限）：最大预算档（仅支持明确接受 thinking budget 的模型）。慢且贵。",
};
export function _thinkLabel(level) {
  return t(`model.thinking.level.${level}`) || _THINK_LABELS[level] || String(level || "");
}
export function _thinkLabels(extra = {}) {
  const out = {};
  for (const lvl of _THINK_LEVELS) out[lvl] = _thinkLabel(lvl);
  return { ...out, ...(extra || {}) };
}
export function _thinkTip(level) {
  return t(`model.thinking.tip.${level}`) || _THINK_TIPS[level] || "";
}
const _THINK_KEY = "michael_thinking_effort_v1";
export function _loadThinkingPrefs() {
  try { return JSON.parse(localStorage.getItem(_THINK_KEY) || "{}") || {}; } catch { return {}; }
}
export function _saveThinkingPrefs(map) {
  try { localStorage.setItem(_THINK_KEY, JSON.stringify(map || {})); } catch {}
}

/**
 * The Claude generation in a model id, as a number: `claude-opus-4-8` → 4.8, `claude-sonnet-5` → 5.
 *
 * The thinking switch changed shape at 4.7 — everything from there on rejects `budget_tokens` and
 * everything before it requires one — so the split has to be a comparison, not a list of version
 * strings. Matching versions one at a time is what left Sonnet 4.5, Opus 4.5 and Opus 4.1 being
 * sent a wire shape none of them accept: only 4.6 was named, and the rest fell through to the
 * modern branch. An unrecognised id returns 0, which reads as "newer than the table" and lands on
 * the adaptive shape — the direction the API has been moving, and the safer guess for a model
 * released after this line was written.
 */
export function _claudeGeneration(id = "") {
  const m = String(id).toLowerCase()
    .match(/(?:opus|sonnet|haiku|fable|mythos|claude)[-_.]?(\d{1,2})(?:[-_.](\d{1,2}))?(?![\d.])/);
  if (!m) return 0;
  const minor = m[2] == null ? 0 : Number(m[2]) || 0;
  return (Number(m[1]) || 0) + minor / 10;
}

/**
 * 这个模型实时目录里给出的思考档位。`null` = 目录没有它/没给档位 → 用内置表原样。
 *
 * 只返回**档位名单**，不返回 profile：档位怎么变成请求参数由内置表的 kind 决定，
 * 这里越权替换掉整个 profile 正是"开了思考却不思考"那次事故的原因。
 */
export function _liveThinkingLevels(modelId) {
  let entry = null;
  try { entry = _modelCatalogEntry(modelId); } catch { return null; }
  const efforts = entry?.supportedEfforts;
  // null = 目录里没这一款；空数组 = 有这一款但它不吃档位，两种都交还内置表
  // （"没有深度档位"不等于"不能开思考"，GLM 就是有开关没档位）。
  if (!Array.isArray(efforts) || !efforts.length) return null;
  // 上游的 `none`（不推理）对应本地的 `off`，本地档位表里没有 `none` 这个名字。
  return efforts.map((e) => (e === "none" ? "off" : String(e)));
}

/**
 * 一个档位能不能被这个 profile 的 kind 构造成请求参数。
 *
 * 这是实时档位和内置表之间唯一的接缝：目录知道"这个模型有哪些档位"，**不知道档位怎么
 * 变成请求字段**——那是 kind 管的。按 kind 分类：
 *   · reasoning_effort / adaptive_thinking / thinking_level：映射表缺项时直接发档位名，
 *     所以目录给什么都发得出去；
 *   · thinking_budget / gemini_budget：必须在 budgets 里查到数字，查不到就发不出去，
 *     摆出来只会让用户选一个静默失效的按钮；
 *   · kimi-toggle / kimi-forced / none：本地事实（只有开关、或强制开），目录不该改它。
 */
export function _effortIsSendable(base, level) {
  if (level === "off") return true;
  switch (base?.kind) {
    case "reasoning_effort":
    case "adaptive_thinking":
    case "thinking_level":
      return true;
    case "thinking_budget":
    case "gemini_budget":
      return !!(base.budgets && Number(base.budgets[level]) > 0);
    case "kimi-toggle":
      // 布尔开关族现在**开关和档位一起发**（见 _thinkingRequestParams 的 kimi-toggle 分支），
      // 所以目录声明的档位是真发得出去的，不再是"摆出来骗人的按钮"。
      // 这一条以前落在 default 返回 false：glm-5.2 和 deepseek-v4-pro 在目录里的声明一模一样
      // （都是 xhigh/high），前者被这里过滤成只剩开/关，后者拿到三档——同一份声明两种结果，
      // 而且 GLM 的 xhigh 永远选不到。
      return true;
    default:
      return false;
  }
}

/**
 * 最终档位 = **实时目录的名单** + 内置表的 kind 与参数映射。
 *
 * 这个分工是踩出来的。第一版让实时 profile 整个顶替内置 profile、还自造了 `kind:"live"`，
 * 而请求参数是**按 kind 分派**构造的，"live" 一个分支都不匹配 → 整轮一个思考参数都不发：
 * 用户界面上拨到"极限"，线上日志却是 reasoning_effort="absent"，表现就是"开了思考却没思考"。
 *
 * 现在名单以目录为准（代码里不再写死哪几档），但每一档都要先过 `_effortIsSendable`——
 * 摆出来的按钮必须真的能变成请求字段，否则就是换一种方式骗用户。
 */
export function _thinkingProfileFor(id) {
  const base = _builtinThinkingProfileFor(id);
  const live = _liveThinkingLevels(id);
  // 内置表说"这个模型没有可调档位"，但实时目录**明确列出了档位** → 以目录为准。
  //
  // 实测 deepseek-v4-flash 就是这样：目录说它支持 xhigh/high，而内置表把它归进了
  // "原生推理、没有公开旋钮"那一类，于是界面上只剩一个"关闭"——用户根本调不了深度。
  // 内置表是按模型名猜的，目录是厂商声明的，冲突时该信后者。
  //
  // 但**图像模型除外**：那是本地事实（画图模型没有推理档位这回事），不该被目录覆盖。
  if (base && base.configurable !== true && live && live.length && base.kind !== "kimi-forced" && !_isImageModel(String(id || "").toLowerCase())) {
    const allowed = new Set(live);
    const levels = _THINK_LEVELS.filter((l) => allowed.has(l));
    if (levels.length) {
      if (!levels.includes("off")) levels.unshift("off");
      return {
        kind: "reasoning_effort",
        configurable: true,
        levels,
        defaultLevel: levels.includes("high") ? "high" : levels[levels.length - 1],
      };
    }
  }
  if (!base || base.configurable !== true) return base; // 图像模型/强制开：本地事实优先
  if (!live || !live.length) return base;
  const usable = live.filter((l) => _effortIsSendable(base, l));
  if (!usable.length) return base;
  const allowed = new Set(usable);
  // 按本地既有顺序排，UI 的档位次序不因目录返回顺序而抖动；off 永远保留，
  // 用户任何时候都要能把思考关掉。
  const levels = _THINK_LEVELS.filter((l) => allowed.has(l) || (l === "off" && (base.levels || []).includes("off")));
  if (!levels.filter((l) => l !== "off").length) return base;
  const defaultLevel = levels.includes(base.defaultLevel)
    ? base.defaultLevel
    : levels[levels.length - 1];
  // booleanToggle 是"这个模型只有开/关"的断言，UI 据此渲染成两态开关（方案D）。目录一旦
  // 给出不止一档，这个断言就不再成立——留着它，多出来的档位会被开关吞掉，用户还是只看到开/关。
  const graded = levels.filter((l) => l !== "off").length;
  return { ...base, levels, defaultLevel, booleanToggle: !!base.booleanToggle && graded <= 1 };
}

/**
 * 这个模型的「关思考」在线上是不是 Anthropic 那种形状。
 *
 * 网关是按**线路协议**分叉的，不是按模型名：`let anthropic = conn.protocol == "anthropic"`。
 * 走 anthropic 桥的请求会被翻译成 Anthropic body（thinking 形状、max_tokens 地板都长在
 * 那条路上）；其余协议的线路**原样透传** body —— 客户端塞什么枚举，上游就收到什么枚举。
 *
 * 名字是客户端能拿到的最接近的判据：Claude 一族基本只挂在 anthropic 线路上。
 * 不能改用 `_thinkingProfileFor().kind` —— Haiku 那一族的 kind 是 "none"（没有可调档位），
 * 但它照样走 anthropic 桥，按 kind 判会把它整族漏掉。
 *
 * 仓库里眼下有三处同样的名单（这里、`_modelSupportsPowerRoute`、`_builtinThinkingProfileFor`
 * 的 Claude 分支），**刻意不合并**：三处问的是三个不同的问题 —— 功能资格、露出哪种思考
 * 旋钮、线材是什么形状。合成一个判据等于断言它们永远同进同退，哪天强力版名单收窄，
 * 就会顺手把线材形状也改掉，而那种改动在测试里是看不见的。
 */
export function _isAnthropicWireFamily(id = "") {
  return /claude|opus|sonnet|haiku|fable|mythos/i.test(String(id || ""));
}

export function _builtinThinkingProfileFor(id) {
  // Custom entries use an internal selector id, but thinking capability belongs
  // to the real upstream model name. Preferences remain keyed by the selector id.
  let capabilityId = String(id || "");
  // 自定义条目的模型名是**用户手打的**，下面 Claude 分支按代次分流靠的是对它做正则。
  // 猜不出代次时不能掉进 adaptive —— 见该分支里的别名保护。
  const _fromCustom = capabilityId.startsWith("custom:");
  if (capabilityId.startsWith("custom:") && typeof _customModelById === "function") {
    try {
      const custom = _customModelById(capabilityId);
      if (custom?.name) capabilityId = String(custom.name);
    } catch {}
  }
  const s = capabilityId.toLowerCase();
  const none = (reason) => ({
    kind: "none",
    configurable: false,
    levels: ["off"],
    defaultLevel: "off",
    disabledReason: reason || t("model.thinking.reason.noPublic"),
    hint: reason || t("model.thinking.reason.noPublic"),
  });
  if (!s) return none(t("model.thinking.reason.notSelected"));
  if (_isImageModel(s)) return none(t("model.thinking.reason.image"));

  // Moonshot/Kimi: public K2.5/K2.6 thinking models expose a boolean thinking.type;
  // they do not expose low/medium/high budgets. K2.7 code models are forced-on.
  if (/kimi|moonshot/.test(s)) {
    if (/k2\.7.*code|k2-?7.*code/.test(s)) {
      return {
        kind: "kimi-forced",
        configurable: false,
        levels: ["high"],
        defaultLevel: "high",
        labels: { high: t("model.thinking.level.alwaysOn") },
        disabledReason: t("model.thinking.reason.kimiForced"),
        hint: t("model.thinking.reason.kimiForcedHint"),
      };
    }
    if (/k2\.(5|6)|k2-?(5|6)|thinking/.test(s)) {
      return {
        kind: "kimi-toggle",
        configurable: true,
        booleanToggle: true, // 方案D：能力表事实——只有布尔开关，UI 不得渲染深度档位话术
        levels: ["off", "high"],
        defaultLevel: "high",
        labels: { high: t("model.thinking.level.enabled") },
        hint: t("model.thinking.reason.kimiToggleHint"),
      };
    }
    return none(t("model.thinking.reason.kimiNormal"));
  }

  // xAI Grok: newer reasoning models expose reasoning_effort, but Grok 4.5 has
  // no off tier and defaults to high when omitted.
  if (/grok/.test(s)) {
    if (/grok[-_.]?4\.5|grok[-_.]?45/.test(s)) {
      return {
        kind: "reasoning_effort",
        configurable: true,
        levels: ["low", "medium", "high"],
        defaultLevel: "high",
        noOff: true,
        hint: t("model.thinking.reason.grok45"),
      };
    }
    if (/grok[-_.]?4\.3|grok[-_.]?43/.test(s)) {
      return {
        kind: "reasoning_effort",
        configurable: true,
        levels: ["off", "low", "medium", "high"],
        defaultLevel: "high",
        effortMap: { off: "none", low: "low", medium: "medium", high: "high" },
        hint: t("model.thinking.reason.grok43"),
      };
    }
    /*
     * **grok 4 以上一律按可调推理，不再逐个版本写死**——grok-4.6 发布后一条都不匹配，
     * 落到 none()：转盘全灰、reasoning_effort 一个字不发。4.7 会重犯。
     *
     * 平时救得回来：_thinkingProfileFor 会拿实时目录（网关抓 OpenRouter）覆盖内置表。
     * 但目录不是随时都在——刚启动模型表还没到、自定义端点、网页版，这三种只剩内置表。
     *
     * 档位取 4.5 和 4.6 的交集（不含 xhigh）：内置表分不出版本，目录在场时会把 xhigh
     * 补进来；宁可少一档，也不要让用户选个上游可能不认的档位然后静默降级。
     * noOff 跟着 4 系走——xAI 那一族推理是强制开的（OpenRouter reasoning.mandatory）。
     */
    if (/grok[-_.]?([4-9]|\d{2,})/.test(s) || /reason|think|mini/.test(s)) {
      return {
        kind: "reasoning_effort",
        configurable: true,
        levels: ["low", "medium", "high"],
        defaultLevel: "high",
        noOff: /grok[-_.]?([4-9]|\d{2,})/.test(s),
        hint: t("model.thinking.reason.grokReasoning"),
      };
    }
    return none(t("model.thinking.reason.grokNone"));
  }

  // OpenAI reasoning families. The gateway is Chat-Completions compatible, so use
  // the `reasoning_effort` field and do not emit Responses-only `reasoning`.
  if (/^(o[1-9](?:[-_.]|$))|(^|[-_.])o[1-9](?:[-_.]|$)|gpt[-_.]?5/i.test(s)) {
    if (/gpt[-_.]?5\.6|gpt[-_.]?56/.test(s)) {
      return {
        kind: "reasoning_effort",
        configurable: true,
        levels: ["off", "low", "medium", "high", "xhigh", "max"],
        // 默认 xhigh，不是 high。**2026-08-13 对真实上游实测过**，不是照着文档猜的。
        //
        // 这一族在 GPT 线路上是 protocol="openai"，网关原样透传 reasoning_effort
        // （effort 天花板只在 Claude 那条 anthropic 桥里）。直接打上游 zyz：
        //
        //   low   输出 929 tok / 22s      xhigh 输出 1695 tok / 40s
        //   medium 输出 938 tok / 26s     max   输出 2123 tok / 49s
        //   high  输出 1917 tok / 52s
        //   zzzz / 12345 → 明确报错：level "zzzz" not supported, valid levels: low, …
        //
        // 两件事同时成立：档位是**被校验**的（乱填会被拒，所以 xhigh 确实在合法集里），
        // 而且深浅**真的有梯度**（low/medium 只有 high 一档的一半输出量）。
        // 对照之下 Claude 那条线路连 banana 都照收不误、也没有梯度——那边的 xhigh 是假档位，
        // 所以那边不加按钮。同一个词在两条线路上一真一假，只能分开处理。
        //
        // 那为什么要动默认值：线上三天遥测里 gpt-5.6-sol 共 44 次请求，35 次 high、
        // 9 次没带档位，xhigh **零次**——转盘上摆着这一档，实际没有一个人用到。
        // 用户拿 opencode 跑同一个模型、同一段提示词时用的正是 xhigh。
        defaultLevel: "xhigh",
        effortMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        hint: t("model.thinking.reason.gpt56"),
      };
    }
    return {
      kind: "reasoning_effort",
      configurable: true,
      levels: ["off", "low", "medium", "high"],
      defaultLevel: "high",
      effortMap: { off: "none", low: "low", medium: "medium", high: "high" },
      hint: t("model.thinking.reason.openai"),
    };
  }

  // Anthropic Claude — the knob differs BY FAMILY, and pretending otherwise is exactly the
  // bug that froze production: 4.7+/5/Fable reject {"type":"enabled","budget_tokens":N} with
  // a hard 400 ("use thinking.type.adaptive"), while 3.7/4.6 still require the explicit
  // budget. One hardcoded budget table for every Claude was both dishonest UI and a broken
  // wire shape on aggregator (OpenAI-protocol) routes that forward the body verbatim.
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(s)) {
    if (/haiku/.test(s)) return none(t("model.thinking.reason.claudeHaiku"));
    // 别名保护。`sonnet-latest` / `claude-latest` 这类名字匹配不出代次（_claudeGeneration
    // → 0），旧代码会让它掉进下面的 adaptive 分支，于是给一个可能是 4.5 的模型发
    // {"type":"adaptive"} + output_config.effort —— 硬 400，而界面上「保存成功、档位可调」，
    // 用户看到的只是整轮失败。猜不出来就不猜。
    // 只对自定义条目生效：网关模型有实时目录兜底，不吃这个坑。
    if (_fromCustom && _claudeGeneration(s) === 0) {
      return none("这个名字看不出 Claude 代次（例如 sonnet-latest 这类别名）。思考开关的形状按代次分两套、发错是硬 400，所以这条模型上不发思考参数。把模型名写成带版本号的形式（例如 claude-sonnet-4-5）即可开启。");
    }
    if (/3[-_.]?5(?!\d)/.test(s)) return none("Claude 3.5 系列无扩展思考能力。");
    if (/3[-_.]?7(?!\d)/.test(s)) {
      return {
        kind: "thinking_budget",
        configurable: true,
        levels: ["off", "low", "medium", "high"],
        defaultLevel: "high",
        // Matches the gateway's own 3.7 mapping (anthropic_thinking): low 4000 / mid 8000 /
        // high 12000. No separate max — the gateway maps max to the same 12000.
        budgets: { low: 4000, medium: 8000, high: 12000 },
        hint: "Claude 3.7 使用显式 thinking budget_tokens：低/中/高分别发送 4000/8000/12000。",
      };
    }
    // 4.6 及更早（4.0–4.6）：仍然接受、并且**需要**显式 budget_tokens。以前这里只认 4.6，
    // 于是 Sonnet 4.5 / Opus 4.5 / 4.1 / 4.0 全都掉进了下面的 adaptive 分支——给一族根本
    // 不支持 adaptive 的模型发 {"type":"adaptive"}，而它们真正的开关是 budget_tokens；
    // Sonnet 4.5 连 effort 都直接报错。按代次分流而不是按单个版本号匹配。
    const _gen = _claudeGeneration(s);
    if (_gen > 0 && _gen <= 4.6) {
      return {
        kind: "thinking_budget",
        configurable: true,
        levels: ["off", "low", "medium", "high", "max"],
        // 默认 high：用户没选过档位时不拿 medium 偷深度；显式选择永远优先。
        defaultLevel: "high",
        budgets: { low: 4096, medium: 12000, high: 24000, max: 32000 },
        hint: "Claude 4.6 及更早使用显式 thinking budget_tokens：低/中/高/极限分别发送 4096/12000/24000/32000。",
      };
    }
    // 4.7 / 4.8 / Opus 5 / Sonnet 5 / Fable / Mythos: adaptive thinking. These models REFUSE
    // budget_tokens outright, so send the native adaptive switch plus reasoning_effort. The
    // explicit switch keeps thinking enabled on both native and OpenAI-compatible routes.
    //
    // Fable/Mythos have no off switch at all — thinking is always on there, and an explicit
    // {"type":"disabled"} is a 400. Offering the button would be a tier that cannot exist.
    const _alwaysThinks = /fable|mythos/.test(s);
    return {
      kind: "adaptive_thinking",
      configurable: true,
      // `low` is a real tier and reaches the model as effort=low — it was dropped back when the
      // client sent no effort at all and every level below `high` collapsed to the same request.
      // Anthropic's ladder also has `xhigh` between high and max, and it is deliberately absent:
      // this route is a reseller, and an effort word it does not accept returns an EMPTY
      // completion rather than a clean error. Adding the button means first probing the live
      // route with effort=xhigh and confirming real content comes back.
      // xhigh 在这一族**仍然不摆按钮**，而且理由现在是实测的而不是推断的。
      //
      // 2026-08-16 我一度把它加了回来，依据是"上游不报错"：直连本网关在用的转卖上游发
      // xhigh/max，都 HTTP 200、thinking 块正常返回。但"不报错"不等于"生效"——同一次
      // 实测取三轮中位数：high 942 字符、xhigh 447、max 683，**没有梯度**。这正好印证了
      // 这一族原本就记着的那条结论：这条线路连 banana 这种胡编的 effort 词都照收不误。
      // 上游收下了、然后忽略它。
      //
      // 摆一个照收不误却没有实际效果的按钮，不是"把参数发出去"，是换一种方式骗用户。
      // 网关那边的直通已经改成看实时目录（models.rs 的 supports_effort），等哪天换了真正
      // 认这个词的线路，按钮和这条注释一起改。
      levels: _alwaysThinks ? ["low", "medium", "high", "max"] : ["off", "low", "medium", "high", "max"],
      defaultLevel: "high",
      levelTips: {
        low: "自适应思考 · effort=low：短任务与低延迟场景，深度仍由模型按需决定。",
        medium: "自适应思考 · effort=medium：日常任务的性价比档。",
        high: "自适应思考 · effort=high + 更大输出余量（max_tokens ≥ 40k）与更宽的流式超时。",
        max: "自适应思考 + 最大输出余量（64k）+ 深思考超时档。慢且贵。",
      },
      hint: _alwaysThinks
        ? "Fable/Mythos 5 的思考常开且无法关闭；档位通过 output_config.effort 控制深度，不发送 budget_tokens（该系列会直接拒绝）。"
        : "Claude 4.7+/5 为 adaptive thinking：不发送 budget_tokens（该系列会直接拒绝），档位通过 output_config.effort 送到模型，同时决定输出余量与超时分级。",
    };
  }

  // Gemini 3 exposes thinking levels; Gemini 2.5 uses thinkingBudget. Image-gen
  // variants were already filtered by _isImageModel above.
  if (/gemini/.test(s)) {
    if (/gemini[-_.]?3/.test(s)) {
      return {
        kind: "thinking_level",
        configurable: true,
        levels: /flash/.test(s) ? ["minimal", "low", "medium", "high"] : ["low", "medium", "high"],
        defaultLevel: "high",
        levelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
        hint: t("model.thinking.reason.gemini3"),
      };
    }
    if (/gemini[-_.]?2\.5|gemini[-_.]?25/.test(s)) {
      const _isFlash = /flash/.test(s);
      return {
        kind: "gemini_budget",
        configurable: true,
        levels: _isFlash ? ["off", "low", "medium", "high", "max"] : ["low", "medium", "high", "max"],
        // Pro 官方默认是动态思考（常远超 4096）——默认 medium=4096 等于反手给它加低帽偷深度；
        // Pro 的 max 上限也是 32768 而不是 Flash 的 24576。Flash 同样默认 high 不偷深度。
        defaultLevel: "high",
        budgets: _isFlash
          ? { off: 0, low: 1024, medium: 4096, high: 8192, max: 24576 }
          : { off: 0, low: 2048, medium: 8192, high: 16384, max: 32768 },
        hint: t("model.thinking.reason.gemini25"),
      };
    }
    return none(t("model.thinking.reason.geminiUnknown"));
  }

  // DeepSeek R/QwQ 等会原生输出 reasoning_content，但没有统一公开“调深度”
  // 参数；显示成不可调，比乱发 reasoning_effort 更真实。
  if (/deepseek|qwq|qwen.*(think|reason)/.test(s)) {
    return none(t("model.thinking.reason.nativeReasoning"));
  }

  // MiniMax M2/M2.7/M3 当前公开 OpenAI-compatible 目录没有可靠的 low/medium/high
  // 思考参数；过去把它们当 reasoning_effort 是假的，所以这里默认不发。
  if (/minimax/.test(s)) {
    return none(t("model.thinking.reason.minimax"));
  }

  // GLM 4.5+/5.x 是混合推理模型：Z.ai OpenAI-compat 公开 thinking:{type:"enabled"|"disabled"}
  // 布尔开关（与 Kimi 同构）。此前没有这个分支 → 落到"不可调"，IDE 从不发任何 thinking
  // 字段，开没开思考全看聚合渠道的默认值——用户档位彻底失联。老 GLM-4 非推理型保持不可调。
  if (/glm|zhipu/.test(s)) {
    if (/glm[-_.]?(?:4\.[5-9]|4[5-9]|5)/.test(s)) {
      return {
        kind: "kimi-toggle",
        configurable: true,
        booleanToggle: true, // 方案D：GLM 只有 thinking.type 布尔开关——UI 如实显示开/关两态
        levels: ["off", "high"],
        defaultLevel: "high",
        labels: { high: t("model.thinking.level.enabled") },
        hint: t("model.thinking.reason.glmToggleHint"),
      };
    }
    return none(t("model.thinking.reason.unknown"));
  }

  return none(t("model.thinking.reason.unknown"));
}

// Predicate: should the thinking-effort control be shown for this model?
export function _supportsThinking(id) {
  return _thinkingProfileFor(id).configurable === true;
}
// User's saved choice, or a sensible default for this model.
export function _thinkingPrefFor(id) {
  const profile = _thinkingProfileFor(id);
  const prefs = _loadThinkingPrefs();
  const levels = profile.levels || [];
  const saved = prefs[id];
  // 用户显式选过的档位（含「off」）始终生效；没选过时默认开启思考。
  if (saved && levels.includes(saved)) return saved;
  const dflt = profile.defaultLevel || "off";
  if (!profile.configurable || dflt !== "off") return dflt;
  // 无默认档时优先最深可用档：推理/思考能力不默认缩水（用户显式选择永远优先）。
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return levels.find((l) => l !== "off") || dflt;
}
export function _setThinkingPref(id, level) {
  const profile = _thinkingProfileFor(id);
  const prefs = _loadThinkingPrefs();
  if (!(profile.levels || _THINK_LEVELS).includes(level)) return;
  prefs[id] = level;
  _saveThinkingPrefs(prefs);
}
// Apply a model's chosen thinking effort to a config object for outgoing API
// calls. Unsupported models strip all thinking fields; supported models emit the
// provider-appropriate field shape.
export function _applyThinkingToConfig(cfg, opts = {}) {
  const out = { ...cfg };
  delete out.reasoningEffort;
  delete out.thinkingBudget;
  delete out.thinking;
  delete out.thinkingConfig;
  delete out.thinkingEffort;
  const model = cfg.model || "";
  // A custom connection is selected and persisted as `custom:<id>`, then
  // `_readyAiConfig` replaces `model` with the real upstream name before the
  // Agent loop starts. Capability belongs to that real model, but the user's
  // explicit effort choice belongs to the custom selector entry. Keep those two
  // identities separate so every Agent iteration reads the same preference as
  // the model card and the initial chat request.
  const preferenceId = cfg.customModelId || model;
  const profile = _thinkingProfileFor(model);
  let pref = _thinkingPrefFor(preferenceId);
  // **不再按轮次类型改写用户选的档位。** 这里原来有两道自动降档，现在都去掉了：
  //
  //   1. 轻量轮（判定为"纯问答、不动工作区"）把档位压到最浅的一档；
  //   2. agent 轮在非复杂任务时把 `max` 压成 `high`。
  //
  // 去掉的理由，那段代码自己的注释里就写着：**它的前提已经不存在了**。那两条是在
  // "客户端还发不出 effort"的年代写的——当时 Claude 走 budget_tokens=24000，一轮闷头
  // 想四分钟不动手是真的（实测）。现在这一族是 adaptive + output_config.effort，想多深
  // 由模型每轮自己定、并且和工具调用交错展开。前提没了，留下的只有副作用：
  // 用户在转盘上选了一个档位，实际发出去的却是另一个，而界面上不会有任何提示。
  //
  // 省下来的那点钱也不值：闲聊轮本来就已经在省系统提示词、跳过技能块和工作区预热了，
  // 而"这题简不简单"是模型自己该判断的事——adaptive 的全部意义就在于此。harness 替它
  // 提前拍板，正是这个代码库反复要避免的"拿预测去代替事实"。
  //
  // 现在的规则只有一条：**用户选什么就发什么**。opts 里的 lightTurn / agentTurn /
  // isComplexTask 不再参与档位决策（调用方仍然传，其它用途不受影响）。
  out.thinkingEffort = pref || "off";
  if (!profile.configurable || !pref) return out;

  if (pref === "off") {
    if (profile.kind === "kimi-toggle") out.thinking = { type: "disabled" };
    else if (profile.kind === "gemini_budget") {
      out.thinkingBudget = 0;
      out.thinkingConfig = { thinkingBudget: 0 };
    } else if (profile.kind === "adaptive_thinking") {
      // Dropping the field is not the same as asking for off here. Opus 5 and Sonnet 5 run
      // adaptive thinking when nothing is said, so silence made the cheapest setting the deepest
      // and most expensive one — and the gateway's output headroom is granted only to turns that
      // announce thinking, so that turn also ran on the bare default and truncated mid-answer.
      out.thinking = { type: "disabled" };
    }
    return out;
  }

  if (profile.kind === "reasoning_effort" || profile.kind === "adaptive_thinking") {
    const effort = (profile.effortMap && profile.effortMap[pref]) || pref;
    if (effort && effort !== "none") {
      out.reasoningEffort = effort;
      if (profile.kind === "adaptive_thinking") out.thinking = { type: "adaptive" };
    }
    return out;
  }

  if (profile.kind === "thinking_budget") {
    const budget = profile.budgets && profile.budgets[pref];
    if (budget > 0) {
      out.thinkingBudget = budget;
      out.thinking = { type: "enabled", budget_tokens: budget };
      // 双保险：同时带上标准档位字段。网关的 Anthropic 桥在没有 reasoning_effort 时
      // 会把一切 thinking 一律推断成 high——用户选的 low/medium/max 全被压平；zyz 等
      // 按 reasoning_effort 转换的聚合渠道也拿不到真实档位。带上它,两条路都能对上。
      out.reasoningEffort = pref;
    }
    return out;
  }

  if (profile.kind === "gemini_budget") {
    const budget = profile.budgets && profile.budgets[pref];
    if (budget >= 0) {
      out.thinkingBudget = budget;
      out.thinkingConfig = { thinkingBudget: budget };
      if (budget > 0) out.thinking = { type: "enabled", budget_tokens: budget };
    }
    return out;
  }

  if (profile.kind === "thinking_level") {
    const level = (profile.levelMap && profile.levelMap[pref]) || pref;
    if (level) {
      out.thinkingConfig = { thinkingLevel: level };
      out.thinking = { type: "enabled", level, thinking_level: level };
      // 同时带标准字段：thinkingConfig/thinking 都不是 OpenAI-compat 标准字段，
      // Google 官方兼容端点和多数聚合渠道只认 reasoning_effort——不带它，用户拨的
      // 档位大概率根本没到模型（Gemini-3 一直在跑渠道默认档）。
      out.reasoningEffort = level === "minimal" ? "low" : level;
    }
    return out;
  }

  if (profile.kind === "kimi-toggle") {
    out.thinking = { type: "enabled" };
    // 双保险，和 thinking_budget / thinking_level 两支同理：布尔开关只说"想"，不说"想多深"。
    // 目录明确给出档位的模型（实测 glm-5.2 声明 xhigh/high）如果只发这个开关，用户拨到
    // "超高"和拨到"高"发出去的请求逐字节相同——档位是个装饰。开关照旧发（今天能思考靠的
    // 就是它，不能动），档位额外带一份：上游不认就当没有，认了用户才第一次调得动深度。
    // 只在目录真给了多档时才带，免得给只有开关的模型（Kimi K2.5/K2.6）平白多一个字段。
    if ((profile.levels || []).filter((l) => l !== "off").length > 1) out.reasoningEffort = pref;
  }
  return out;
}
