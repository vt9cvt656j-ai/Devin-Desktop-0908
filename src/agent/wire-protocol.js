// 自定义模型的上游线协议：取值、归一化、地址写法、能力缺口文案。
//
// 单独成模块（同 src/agent/ 里其它纯函数模块的判据）：只依赖参数，没有 DOM，没有模块级
// 可变状态。于是测试可以直接 import 产品代码验行为，而不是抠 main.js 的源码文本 —— 抠源码
// 验得到「代码长这样」，验不到「它还在不在真实调用链上」。同时不占 main.js 的尺寸闸余量。
//
// **取值必须是 Rust 侧 crate::protocol::PROTOCOLS 的逐字子集。** 两边各起一套名字这个仓库
// 吃过亏；更糟的是不一致时**没有任何报错**：Wire::of 认不出的字符串一律落 openai，表现成
// 「界面选了 Anthropic，请求打到 /chat/completions」，回来一句 404，看着像地址填错了。
// test/wire-protocol.test.mjs 直接读 protocol.rs 的源码钉住这个集合。

export const CM_PROTOCOLS = ["openai", "anthropic", "xai_responses"];
export const CM_PROTOCOL_DEFAULT = "openai";

/**
 * 每条协议的界面文案。
 *
 * `gaps` 是「不许假装支持」的落点：弹窗必须把它原样显示在下拉旁边，让用户在填之前就知道
 * 哪几个旋钮在这条路上不起作用，而不是发出去之后表现成「设了没用」。
 *
 * `desktopOnly`：网页构建（/app/）没有 Rust 那条协议分叉 —— _realAiFetch 自己拼 OpenAI
 * 形状的请求体、端点和鉴权头。而且浏览器直连 api.anthropic.com 还会被 CORS 挡。所以网页上
 * 这两条协议**不可选**，且要说清为什么，而不是让它变成一个看不懂的网络错误。
 */
// ⚠️ 这份里的 `gaps` 是**兜底副本**，不是权威。权威在 Rust：protocol.rs 的
// `Wire::unsupported()`，经 `ai_protocols` 命令下发；main.js 打开自定义模型面板时会拉一次
// 并覆盖这里的 gaps/label（拉不到——比如网页版没有 Tauri——才用这份）。
//
// 为什么要这样：手抄必漂，而且已经漂过。这里 anthropic 那条一度把中间整句
//「3.7/4.x 收 thinking.budget_tokens，4.7 之后只收 adaptive + output_config.effort，
// 两套互不兼容、发错是硬 400」丢掉，只剩后半截，旁边却还写着「protocol.rs 的 anthropic 臂
// 逐字如此」——那句话在它被写下之后就不成立了。改这里的 gaps 之前先问：Rust 那边改了吗。
// ph / hint / desktopOnly 是纯 UI 字段，本来就该住在前端，不跟 Rust 走。
export const CM_PROTOCOL_UI = {
  openai: {
    label: "OpenAI 兼容",
    ph: "https://api.example.com/v1",
    hint: "地址填到 /v1 为止，自动拼成 /v1/chat/completions；密钥走 Authorization: Bearer。OpenAI、Gemini（兼容端点）、DeepSeek、Kimi、GLM、Qwen、OpenRouter、one-api 全家、Azure v1、本地 Ollama / LM Studio 都走这条。",
    desktopOnly: false,
    gaps: [],
  },
  anthropic: {
    label: "Anthropic 协议",
    ph: "https://api.anthropic.com",
    hint: "自动拼成 /v1/messages，密钥走 x-api-key。工具调用、流式思考、图片、停止序列都支持。",
    desktopOnly: true,
    gaps: [
      "温度 / top_p 不会发送：新一代 Claude 即使关掉思考也拒收这两个参数，发了整轮 400。",
      "思考开关的形状按你填的模型名猜：名字带版本号（claude-sonnet-4-5）才猜得准；写成 sonnet-latest 这类别名时认不出代次，这条模型上一律不发思考参数。",
      "不报推理 token 数：Anthropic 把思考算进输出 token，结构上就没有这个数，界面只能显示思考字数。",
      "最深的两档（极限 / xhigh）会被折成「高」：本机没有模型目录，赌错是整轮 400。",
      "不设提示词缓存断点：长会话每轮全价重算，缓存创建量会显示为 0。",
      "最大输出没填时按 32000 发：模型上限低于这个数的（例如 Haiku 一族）请自己填，否则上游 400。",
      "输入框的「下一句预测」不出现：那条路自己拼 /chat/completions，不经过协议翻译。宁可不预测，也不发一个必然 404 的请求。",
      "只在桌面版可用：网页版没有协议翻译，浏览器也直连不了 Anthropic。",
    ],
  },
  xai_responses: {
    label: "xAI Responses",
    ph: "https://api.x.ai",
    hint: "自动拼成 /v1/responses，密钥走 Authorization: Bearer。选它的唯一理由是拿思考正文 —— xAI 在 /chat/completions 上结构性不返回思考内容。",
    desktopOnly: true,
    gaps: [
      "最深的两档（极限 / xhigh）会被折成「高」：哪些模型收这两个词是按模型定的，本机没有模型目录，赌错是整轮 400。",
      "缓存明细只有读命中数：Responses 不报缓存写入量，缓存计量会比实际少一半。",
      "输入框的「下一句预测」不出现：那条路自己拼 /chat/completions，不经过协议翻译。宁可不预测，也不发一个必然 404 的请求。",
      "只在桌面版可用：网页版没有协议翻译。",
    ],
  },
};

/** 任何来源的协议值 → 白名单内的一个。不认识的、空的、存量条目缺字段的，一律 openai。 */
export function cmProtocol(raw) {
  const p = String(raw ?? "").trim().toLowerCase();
  return CM_PROTOCOLS.includes(p) ? p : CM_PROTOCOL_DEFAULT;
}

/**
 * 一条存储条目 → 规范形状。
 *
 * 抽出来是因为 _loadCustomModels 里那个 `.map` 是**定形**的：不在里面列出来的字段每次读取
 * 都被静默丢掉。只在保存侧写 protocol 而不改读取侧，表现是「弹窗选了 Anthropic、提示保存
 * 成功、列表也刷新了，发出去的还是 /chat/completions」，**全程零报错**。
 */
export function normalizeCustomModel(it) {
  return {
    id: it.id,
    group: String(it.group || "").trim() || "自定义模型",
    name: it.name.trim(),
    baseUrl: it.baseUrl.trim(),
    apiKey: String(it.apiKey || ""),
    protocol: cmProtocol(it.protocol),
  };
}

/*
 * ── 拉取模型列表 ────────────────────────────────────────────────────────────
 *
 * 「模型名称」原来要用户手打，还得记住逗号分隔。而这三种协议**都**有列模型的接口，
 * 地址和鉴权头各不相同 —— 那正是该由代码知道、不该由用户记住的东西。
 *
 * 下面三个函数是纯的（拼地址、拼头、解析返回），真正发请求在 main.js 那半边走
 * Rust 的 http_request：浏览器直连第三方端点会撞 CORS，而用户的本机 Ollama
 * （http://localhost:11434/v1）在 WKWebView 里连协议都不允许。
 */

/** 列模型的地址。基址末尾的斜杠要吃掉，否则会拼出 //models。 */
export function cmModelsUrl(base, protocol) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  // Anthropic 的基址按约定**不带** /v1（占位符就是 https://api.anthropic.com），
  // 所以这里补上；已经带了的不重复补。
  if (cmProtocol(protocol) === "anthropic") return /\/v1$/.test(b) ? `${b}/models` : `${b}/v1/models`;
  return `${b}/models`;
}

/** 列模型的鉴权头。空密钥不发头 —— 本机 Ollama / LM Studio 没有密钥。 */
export function cmModelsHeaders(key, protocol) {
  const k = String(key || "").trim();
  const h = { Accept: "application/json" };
  if (cmProtocol(protocol) === "anthropic") {
    if (k) h["x-api-key"] = k;
    h["anthropic-version"] = "2023-06-01";
    return h;
  }
  if (k) h.Authorization = `Bearer ${k}`;
  return h;
}

/**
 * 从返回体里挑出模型名。
 *
 * 各家形状不一样，而且中转站尤其乱：OpenAI 是 `{data:[{id}]}`，Anthropic 也是 `data`
 * 但字段可能叫 `id` 或 `display_name`，Ollama 的 /v1/models 是 OpenAI 形状但有些版本
 * 直接回 `{models:[{name}]}`，还有的中转站直接回一个字符串数组。
 * 认不出来时返回空数组，让界面说"没拉到"，**不要**猜一个假的列表出来。
 */
export function cmParseModels(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const id = typeof r === "string" ? r : String(r?.id ?? r?.name ?? r?.model ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  // 名字排序：中转站回来的顺序常常是入库顺序，同一家的模型会散在列表各处。
  return out.sort((a, b) => a.localeCompare(b));
}
