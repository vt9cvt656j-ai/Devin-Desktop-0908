//! 自定义模型的**上游线协议**（wire protocol）。
//!
//! # 为什么这一层在客户端，而不在网关
//!
//! 自定义模型是**绕开网关直连第三方端点**的：`_isGatewayConfig` 认 `config.customModelId`，
//! 为真时不注入 L0 提示词、不走 michael-compression。网关里那三条成熟的协议桥
//! （`server/src/models.rs` 的 `Wire` / `oai_to_anthropic_with_cache` / `AnthSse` /
//! `oai_to_xai_responses` / `XaiRespSse`）**只服务网关线路**，这条路上一个字节都到不了。
//! 所以要让用户填一个 Anthropic 端点，翻译必须发生在这里。
//!
//! # 铁律：默认 openai 时一行行为都不能变
//!
//! 存量自定义模型的本地记录（`michael_custom_models_v1`）里没有协议字段，反序列化出来是
//! `None` → [`Wire::of`] 落 [`Wire::OpenAi`] → [`endpoint_url`] 走的是从 `ai.rs` 原样搬过来
//! 的那段代码、[`translate_request`] 是**恒等变换**、[`extra_auth_headers`] 返回空表、
//! [`StreamDecoder::for_wire`] 返回 `None`（调用方于是把上游帧原样交给既有的 OpenAI 解析块）。
//! 这四条加起来是「结构上不可能变」，不是「我们小心地没改」。测试 `openai_*` 一族钉着它。
//!
//! # 这些形状是哪来的
//!
//! 请求侧照着网关那两个翻译函数的**判据**重写（去掉缓存标记、计费、多线路失败转移——
//! 客户端一个都不需要）；响应侧照着 `AnthSse` / `XaiRespSse` 的事件表重写。它们注释里
//! 记的上游真实行为（事件名、工具参数的分片方式、思考块形状、usage 在哪一帧）是硬知识，
//! 逐条吸收在下面对应位置的注释里。

use serde_json::{json, Value};
use std::collections::HashMap;

/// 用户在自定义模型里能选的协议。**只此一处**——界面下拉、校验、`Wire::of` 都从这里读。
pub const PROTOCOLS: [&str; 3] = ["openai", "anthropic", "xai_responses"];

/// 上游的线协议。
///
/// **未知字符串一律落 `OpenAi`**，和这个枚举存在之前逐字一致：存量记录没有这个字段，
/// 而一个手工改过 localStorage 的值不该让整个模型不能用。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Wire {
    #[default]
    OpenAi,
    Anthropic,
    XaiResponses,
}

impl Wire {
    pub fn of(protocol: Option<&str>) -> Self {
        match protocol.map(str::trim).unwrap_or("") {
            "anthropic" => Wire::Anthropic,
            // 三种写法都认：下拉框存的是 `xai_responses`，但用户手填/导入的配置里
            // 见过另外两种。认错的表现是静默退回 OpenAI —— 思考卡从此不出现，
            // 而这正是 xAI 那条路存在的唯一理由。
            "xai_responses" | "xai-responses" | "responses" => Wire::XaiResponses,
            _ => Wire::OpenAi,
        }
    }

    /// 协议标识（存进本地记录 / 回读）。
    pub fn id(self) -> &'static str {
        match self {
            Wire::OpenAi => "openai",
            Wire::Anthropic => "anthropic",
            Wire::XaiResponses => "xai_responses",
        }
    }

    /// 拼在 api_base 后面的路径后缀。
    pub fn path(self) -> &'static str {
        match self {
            Wire::OpenAi => "/chat/completions",
            Wire::Anthropic => "/messages",
            Wire::XaiResponses => "/responses",
        }
    }

    /// 界面上给用户看的名字。
    pub fn label(self) -> &'static str {
        match self {
            Wire::OpenAi => "OpenAI 兼容（/v1/chat/completions）",
            Wire::Anthropic => "Anthropic 原生（/v1/messages）",
            Wire::XaiResponses => "xAI Responses（/v1/responses）",
        }
    }

    /// **这条协议上翻译不了的能力。**
    ///
    /// 存在的理由是「不许假装支持」：界面必须把这几句原样显示在协议下拉旁边，让用户
    /// 在填之前就知道哪几个旋钮在这条路上不起作用，而不是发出去以后表现成「设了没用」。
    /// 返回空表 = 这条协议上没有已知的能力缺口。
    pub fn unsupported(self) -> &'static [&'static str] {
        match self {
            Wire::OpenAi => &[],
            Wire::Anthropic => &[
                "温度 / top_p 不会发送：新一代 Claude 即使关掉思考也会拒绝这两个参数，发了整轮 400。",
                "思考开关的形状是按你填的模型名猜的：3.7/4.x 收 thinking.budget_tokens，4.7 之后只收 thinking.type=adaptive + output_config.effort，两套互不兼容、发错是硬 400。名字带版本号（claude-sonnet-4-5）才猜得准；写成 sonnet-latest 这类别名时本机认不出代次，这条模型上就一律不发思考参数。",
                "最大输出必须有个数：Anthropic 要求 max_tokens，没填时按 32000 发；模型上限低于这个数的（例如 Haiku 一族 64000/8192）请自己填，否则上游会 400。",
            ],
            Wire::XaiResponses => &[
                "最深的两档（xhigh / max）会被折成 high：能不能收这两个词是按模型定的，本机没有模型目录。",
                "缓存明细只有读命中数：Responses 不报缓存写入量，缓存计量会比实际少一半。",
            ],
        }
    }
}

/// 归一化用户填的接入地址，拼出这条协议的端点。
///
/// 用户粘的东西有三种：厂商根（`https://api.anthropic.com`）、带 `/v1` 的 base、
/// 以及**某个协议的完整端点**。第三种是这里唯一麻烦的：粘了
/// `https://x.com/v1/chat/completions` 又把协议选成 anthropic，直接往后拼会得到
/// `.../chat/completions/v1/messages`，而报错是上游给的 404，看着像地址填错了。
pub fn endpoint_url(wire: Wire, base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("AI base URL must start with http:// or https://".into());
    }
    if wire == Wire::OpenAi {
        // ↓↓ 从 ai.rs::chat_completions_url **逐字**搬来，一个分支都没动。存量自定义模型
        // 和网关线路全部落这里，URL 因此不可能变。ai.rs 里那三条既有断言现在钉的是这段。
        if base.ends_with("/chat/completions") {
            return Ok(base.to_string());
        }
        let api_base = if base.ends_with("/v1") || base.contains("/v1/") {
            base.to_string()
        } else {
            format!("{base}/v1")
        };
        return Ok(format!("{api_base}/chat/completions"));
    }
    for suffix in ["/chat/completions", "/messages", "/responses"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            return Ok(format!("{stripped}{}", wire.path()));
        }
    }
    let api_base = if base.ends_with("/v1") || base.contains("/v1/") {
        base.to_string()
    } else {
        format!("{base}/v1")
    };
    Ok(format!("{api_base}{}", wire.path()))
}

/// 在 `Authorization: Bearer …` **之外**还要加的鉴权头。
///
/// OpenAI / xAI 返回空表 —— 调用方那行 `.bearer_auth()` 一个字节不动，这是「默认路径
/// 不变」的结构保证。
///
/// Anthropic 双头一起发：官方 `api.anthropic.com` 只认 `x-api-key`，而一大批中转只认
/// `Authorization`。网关那三处实现都是双头，其中一处曾经漏了，表现是「同一个密钥在这一页
/// 401、在另一页好用」，运维会以为线路密钥坏了。`anthropic-version` 是必填头，不发直接 400。
pub fn extra_auth_headers(wire: Wire, api_key: &str) -> Vec<(&'static str, String)> {
    match wire {
        Wire::OpenAi | Wire::XaiResponses => Vec::new(),
        Wire::Anthropic => vec![
            ("x-api-key", api_key.to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
            // `output_config.effort`（adaptive 一族的深度旋钮）由 `effort-2025-11-24` 开门；
            // `interleaved-thinking-2025-05-14` 让「思考—工具—再思考」在同一轮里交错，不开
            // 的话带工具那一轮的思考会被截在第一个工具调用之前。
            //
            // **只发这两个**，不发网关那份全量集合（23 个）：网关注释里记着「多余的 beta 会
            // 让某些中转商直接 503」。这两个都在 Claude Code 发给中转商的精简集合里
            // （server/src/models.rs::ANTHROPIC_BETA_HEADER_THIRD_PARTY），所以进中转的门槛
            // 不会比 Claude Code 自己更高。
            //
            // **这个组合没有对真端点实测过**。若某个中转对它 400/503，第一步是整个去掉这个
            // 头 **并同时停发 output_config** —— 只砍一半会变成「发了 effort 但没有开门的
            // beta」，那是更糟的组合。
            (
                "anthropic-beta",
                "effort-2025-11-24,interleaved-thinking-2025-05-14".to_string(),
            ),
        ],
    }
}

/// OpenAI 形状的请求体 → 目标协议的请求体。**纯函数，不碰网络。**
pub fn translate_request(wire: Wire, body: &Value) -> Result<Value, String> {
    match wire {
        // 恒等变换。不是「大概一样」，是同一个值。
        Wire::OpenAi => Ok(body.clone()),
        Wire::Anthropic => oai_to_anthropic(body),
        Wire::XaiResponses => oai_to_xai_responses(body),
    }
}

// ───────────────────────── 请求：OpenAI → Anthropic ─────────────────────────

/// 取 OpenAI `content` 里的纯文本（字符串直接用，数组只取 text 分片）。
fn oai_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(Value::as_str) == Some("text") {
                    p.get("text").and_then(Value::as_str).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// OpenAI 的 user `content` → Anthropic content（纯字符串，或含图片的块数组）。
fn oai_content_to_anthropic(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(parts)) => {
            let mut blocks: Vec<Value> = Vec::new();
            for p in parts {
                match p.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            blocks.push(json!({"type":"text","text":t}));
                        }
                    }
                    Some("image_url") => {
                        if let Some(u) = p.pointer("/image_url/url").and_then(Value::as_str) {
                            // data: URI 要拆成 base64 source；远程 URL 直接给 url source。
                            if let Some(rest) = u.strip_prefix("data:") {
                                if let Some((meta, data)) = rest.split_once(',') {
                                    let media = meta.split(';').next().unwrap_or("image/png");
                                    blocks.push(json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}}));
                                }
                            } else {
                                blocks.push(json!({"type":"image","source":{"type":"url","url":u}}));
                            }
                        }
                    }
                    _ => {}
                }
            }
            if blocks.is_empty() {
                json!("")
            } else {
                json!(blocks)
            }
        }
        Some(Value::String(s)) => json!(s.clone()),
        _ => json!(""),
    }
}

/// Anthropic 的 `input_schema` **顶层**不接受 `oneOf`/`allOf`/`anyOf`，请求会被 400 掉
/// （原文：`input_schema does not support oneof, allof, or anyof at the top level`）。
/// 而工具目录里确实有几个这么写的，用它表达「这几个参数二选一」。别的上游照单全收，
/// 所以这个问题**只在原生 Anthropic 上炸** —— 同一份目录换条线就好了，最难查的那种。
///
/// 不能从目录里删（客户端拿它生成工具指引、做本地参数校验），所以在**发出去的这一层**
/// 剥掉，把它表达的意思生成一句话补进 description。只动顶层：嵌套在 `properties.*.items`
/// 里的 anyOf 是合法的，碰它反而会把能用的东西弄坏。
fn strip_top_level_schema_branches(schema: &mut Value) -> Option<String> {
    let obj = schema.as_object_mut()?;
    let mut notes: Vec<String> = Vec::new();
    for key in ["anyOf", "oneOf", "allOf"] {
        let Some(branches) = obj.remove(key) else {
            continue;
        };
        let Some(arr) = branches.as_array() else {
            continue;
        };
        let mut groups: Vec<String> = Vec::new();
        for branch in arr {
            let required: Vec<&str> = branch
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            // 分支里若还带 `properties: { k: { enum: [...] } }`，那是「k 取这些值时」的
            // 条件必填 —— 条件也要写出来，否则生成的话是错的。
            let condition = branch
                .get("properties")
                .and_then(Value::as_object)
                .and_then(|props| {
                    props.iter().find_map(|(name, spec)| {
                        let values: Vec<&str> = spec
                            .get("enum")?
                            .as_array()?
                            .iter()
                            .filter_map(Value::as_str)
                            .collect();
                        if values.is_empty() {
                            None
                        } else {
                            Some(format!("{name}={}", values.join("/")))
                        }
                    })
                });
            match (condition, required.is_empty()) {
                (Some(cond), false) => groups.push(format!("{cond} → {}", required.join(" + "))),
                (Some(cond), true) => groups.push(format!("{cond} → no extra fields")),
                (None, false) => groups.push(required.join(" + ")),
                (None, true) => {}
            }
        }
        if !groups.is_empty() {
            notes.push(format!("Provide exactly one of: {}.", groups.join("  |  ")));
        }
    }
    if notes.is_empty() {
        None
    } else {
        Some(notes.join(" "))
    }
}

fn anthropic_stop_sequences(stop: Option<&Value>) -> Option<Vec<String>> {
    let seqs: Vec<String> = match stop? {
        Value::String(s) => vec![s.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => return None,
    };
    let seqs: Vec<String> = seqs.into_iter().filter(|s| !s.is_empty()).collect();
    if seqs.is_empty() { None } else { Some(seqs) }
}

/// Anthropic 要求 `max_tokens`，没有它直接 400。客户端没有模型目录，所以这里的默认值
/// 是**明说的猜测**：32000。
///
/// 为什么不是 8192：网关那份注释记着这个数是凭空发明的，发给能写 128000 的模型时长回答
/// 被拦腰截断且不报任何错。为什么不是 128000：Haiku 一族上限 64000/8192，超了会被 400。
/// 32000 是「大多数模型收得下、又不会把长回答砍半」的折中，而真正的解法是让用户在这个
/// 模型上自己填一个数 —— 见 `Wire::unsupported`，界面必须把这句话显示出来。
const ANTHROPIC_DEFAULT_MAX_TOKENS: i64 = 32000;

/// 这条工具结果是不是 harness 自己判的**失败**。
///
/// 只认 harness 会写在**整条正文第一位**的那几个标记。锚在开头不是为了省事：
/// `[ERROR]` 出现在正文中间的情况太多了——README 讲错误处理、日志文件、测试自己打的错误行——
/// 而那些是**工具成功取回的材料**。以〔外部数据〕抬头开始的正文一律不算：那个抬头说的
/// 正是「下面是别人写的内容」，内容里带什么标记都不是 harness 的判决。
fn harness_error_prefix(text: &str) -> bool {
    let t = text.trim_start();
    if t.starts_with('〔') {
        return false;
    }
    const MARKS: [&str; 10] = [
        "[ERROR]",
        "[BLOCKED",
        "[DENIED",
        "[interrupted]",
        "[未执行]",
        "[失败]",
        "[不可用]",
        "[TIMEOUT]",
        "[WORKSPACE_GONE]",
        "[tool-args-invalid]",
    ];
    MARKS.iter().any(|m| t.starts_with(m))
}

fn oai_to_anthropic(body: &Value) -> Result<Value, String> {
    let mut system_parts: Vec<Value> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    if let Some(msgs) = body.get("messages").and_then(Value::as_array) {
        for m in msgs {
            match m.get("role").and_then(Value::as_str).unwrap_or("user") {
                // Anthropic 的 system 不是一条消息，是顶层字段。
                "system" | "developer" => {
                    let s = oai_content_text(m.get("content"));
                    if !s.is_empty() {
                        system_parts.push(json!({"type":"text","text":s}));
                    }
                }
                // OpenAI 的工具结果是 role=tool；Anthropic 是 user 轮里的 tool_result 块，
                // 且**连续的工具结果必须并进同一个 user 轮**（Anthropic 的硬要求）。
                // 不合并的表现是 400 或者模型看不见后面几个结果。
                "tool" => {
                    let tcid = m
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let text = oai_content_text(m.get("content"));
                    // 工具结果的成败原来只活在正文前缀里（[ERROR] / [BLOCKED] / [interrupted]…），
                    // 翻成 Anthropic 形状时 `is_error` 一直没带上——模型分不清「工具跑了、
                    // 打印了 [ERROR]」和「harness 没跑成」。判据见 harness_error_prefix。
                    let mut block = json!({
                        "type":"tool_result",
                        "tool_use_id": tcid,
                        "content": text,
                    });
                    if harness_error_prefix(&block["content"].as_str().unwrap_or("")) {
                        block["is_error"] = json!(true);
                    }
                    let can_group = messages.last().is_some_and(|last| {
                        last.get("role").and_then(Value::as_str) == Some("user")
                            && last
                                .get("content")
                                .and_then(Value::as_array)
                                .is_some_and(|a| {
                                    a.iter().all(|b| {
                                        b.get("type").and_then(Value::as_str)
                                            == Some("tool_result")
                                    })
                                })
                    });
                    if can_group {
                        if let Some(arr) = messages
                            .last_mut()
                            .and_then(|l| l.get_mut("content"))
                            .and_then(Value::as_array_mut)
                        {
                            arr.push(block);
                        }
                    } else {
                        messages.push(json!({"role":"user","content":[block]}));
                    }
                }
                "assistant" => {
                    let mut blocks: Vec<Value> = Vec::new();
                    let s = oai_content_text(m.get("content"));
                    if !s.is_empty() {
                        blocks.push(json!({"type":"text","text":s}));
                    }
                    if let Some(tcs) = m.get("tool_calls").and_then(Value::as_array) {
                        for tc in tcs {
                            let id = tc.get("id").and_then(Value::as_str).unwrap_or("");
                            let name = tc
                                .pointer("/function/name")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            // OpenAI 侧的参数是**字符串**，Anthropic 侧是**对象**。
                            // 解不出来就报错，不要塞个空对象糊过去：那等于把一次
                            // 「参数坏了」变成一次「模型莫名其妙地不带参数调用」。
                            let args = tc.pointer("/function/arguments").ok_or_else(|| {
                                format!("助手轮的工具调用 {name:?}（id {id:?}）缺少 function.arguments")
                            })?;
                            let input: Value = match args {
                                Value::String(s) if s.trim().is_empty() => json!({}),
                                Value::String(s) => serde_json::from_str(s).map_err(|err| {
                                    format!("助手轮的工具调用 {name:?}（id {id:?}）的 function.arguments 不是合法 JSON：{err}")
                                })?,
                                Value::Object(_) => args.clone(),
                                _ => {
                                    return Err(format!(
                                        "助手轮的工具调用 {name:?}（id {id:?}）的 function.arguments 不是对象"
                                    ));
                                }
                            };
                            if !input.is_object() {
                                return Err(format!(
                                    "助手轮的工具调用 {name:?}（id {id:?}）的 function.arguments 必须解成 JSON 对象"
                                ));
                            }
                            blocks.push(json!({"type":"tool_use","id":id,"name":name,"input":input}));
                        }
                    }
                    // Anthropic 拒绝空 content 的 assistant 轮。
                    if blocks.is_empty() {
                        blocks.push(json!({"type":"text","text":"(no content)"}));
                    }
                    messages.push(json!({"role":"assistant","content":blocks}));
                }
                _ => messages
                    .push(json!({"role":"user","content":oai_content_to_anthropic(m.get("content"))})),
            }
        }
    }

    // **白名单式重建**：`out` 从零建起，只有被显式搬过去的键才会到达上游。
    // clone-then-delete 的写法每加一个我们没想到的键都要追着删，漏一个就是一次 400 ——
    // 而官方 api.anthropic.com 对未知顶层键是严格拒绝的（`extra inputs are not permitted`）。
    // 这条路上要被挡掉的现成例子：stream_options、mc_prefix、reasoning_effort、thinking_budget。
    let mut out = serde_json::Map::new();
    if let Some(model) = body.get("model") {
        out.insert("model".into(), model.clone());
    }
    out.insert("messages".into(), json!(messages));
    if !system_parts.is_empty() {
        out.insert("system".into(), json!(system_parts));
    }

    // 思考：**只在客户端显式给了 `thinking` 对象时才发**。
    //
    // 开启方式按模型代际分两套：3.7 一族收 `{"type":"enabled","budget_tokens":N}`，
    // 4.7 之后只收 `{"type":"adaptive"}` + `output_config.effort`，把对方那一套发过去是
    // 硬 400。网关能分是因为它有模型目录，客户端没有 —— 所以这里不猜。
    // `reasoning_effort` / `thinking_budget` 是 OpenAI 侧和本仓自造的键，一律不外发。
    let mut max_tokens = body
        .get("max_tokens")
        .and_then(Value::as_i64)
        .or_else(|| body.get("max_completion_tokens").and_then(Value::as_i64))
        .filter(|n| *n > 0)
        .unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS);
    if let Some(t) = body.get("thinking").filter(|t| t.is_object()) {
        let enabled = t.get("type").and_then(Value::as_str) != Some("disabled");
        if enabled {
            out.insert("thinking".into(), t.clone());
            // budget_tokens ≥ max_tokens 是**保证 400** 的组合（思考预算必须留在输出额度
            // 之内）。用户填的 max_tokens 太小时，抬到预算之上而不是让它必然失败。
            if let Some(budget) = t.get("budget_tokens").and_then(Value::as_i64) {
                if max_tokens <= budget {
                    max_tokens = budget + 4096;
                }
            }
            // adaptive 一族的深度旋钮在 output_config.effort 上；没有它 adaptive 每轮
            // 只想一点点，用户看到的就是「思考没有实质内容」。只在客户端明确给了档位
            // 且这一族确实收它时才发。
            if t.get("type").and_then(Value::as_str) == Some("adaptive") {
                if let Some(effort) = body
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|e| !e.is_empty() && *e != "off")
                {
                    let effort = match effort {
                        // 目录不在手上，最深的两档折成 Anthropic 一定认的 high。
                        "xhigh" | "max" => "high",
                        other => other,
                    };
                    out.insert("output_config".into(), json!({ "effort": effort }));
                }
            }
        }
    }
    out.insert("max_tokens".into(), json!(max_tokens.max(1)));

    // 采样参数**不外发**。新一代 Claude 即使思考关着也会拒绝 temperature/top_p，
    // 而省略它们对每一代模型都等于「用提供方默认值」。见 Wire::unsupported。
    if let Some(v) = body.get("stream") {
        out.insert("stream".into(), v.clone());
    }
    // OpenAI 叫 `stop`，Anthropic 叫 `stop_sequences`。名字不翻的两种后果都不好看：
    // 官方 400（而失败分类会把 400 判成「换线路也一样」直接放弃整轮），宽松中转则默默
    // 忽略 —— 用户要的截断点从来没生效过。
    if let Some(stops) = anthropic_stop_sequences(body.get("stop")) {
        out.insert("stop_sequences".into(), json!(stops));
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut atools: Vec<Value> = Vec::new();
        for t in tools {
            let Some(f) = t.get("function") else { continue };
            let Some(name) = f.get("name").and_then(Value::as_str) else {
                continue;
            };
            let mut a = serde_json::Map::new();
            a.insert("name".into(), json!(name));
            if let Some(d) = f.get("description") {
                a.insert("description".into(), d.clone());
            }
            let mut input_schema = f
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{}}));
            if let Some(note) = strip_top_level_schema_branches(&mut input_schema) {
                let merged = match a.get("description").and_then(Value::as_str) {
                    Some(existing) if !existing.trim().is_empty() => {
                        format!("{existing}\n\n{note}")
                    }
                    _ => note,
                };
                a.insert("description".into(), json!(merged));
            }
            a.insert("input_schema".into(), input_schema);
            // 细粒度工具流式。**不设它，Anthropic 会把工具入参的 JSON 攒完、校验合法之后
            // 才发** —— 对 write_file 这种把整份文件塞在 `content` 里的调用，用户就是盯着
            // 一张空卡片等几十秒到几分钟。这不是我们的 bug，是它的默认行为。打开之后
            // input_json_delta 逐段发，下面的 AnthropicDecoder 原样转成 tool_calls 增量。
            // 代价是中途 JSON 不合法 —— 客户端本来就按这个前提写的，而
            // AnthropicDecoder 在 content_block_stop 那一刻会校验它最终是完整 JSON。
            a.insert("eager_input_streaming".into(), json!(true));
            atools.push(Value::Object(a));
        }
        if !atools.is_empty() {
            out.insert("tools".into(), json!(atools));
        }
    }
    if let Some(tc) = body.get("tool_choice") {
        let atc = match tc.as_str() {
            Some("auto") => Some(json!({"type":"auto"})),
            Some("required") => Some(json!({"type":"any"})),
            Some("none") => None,
            _ => tc
                .pointer("/function/name")
                .and_then(Value::as_str)
                .map(|n| json!({"type":"tool","name":n})),
        };
        if let Some(v) = atc {
            out.insert("tool_choice".into(), v);
        }
    }
    Ok(Value::Object(out))
}

// ─────────────────── 请求：OpenAI → xAI Responses ───────────────────

/// | OpenAI chat            | Responses                                          |
/// |------------------------|----------------------------------------------------|
/// | `messages`             | `input`（同一个数组形状，含 role=system）           |
/// | `max_tokens`           | `max_output_tokens`                                 |
/// | `tools[].function.{…}` | `tools[].{…}` —— **扁平**，包一层会 400             |
/// | `reasoning_effort`     | `reasoning: { effort }`                             |
/// | assistant.tool_calls   | `{type:"function_call", call_id, name, arguments}`  |
/// | role=tool 的结果       | `{type:"function_call_output", call_id, output}`    |
/// | `stream_options`       | **不存在**，带上去是未知参数                        |
fn oai_to_xai_responses(body: &Value) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    if let Some(model) = body.get("model") {
        out.insert("model".into(), model.clone());
    }

    let mut input: Vec<Value> = Vec::new();
    let msgs = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "请求体缺少 messages 数组".to_string())?;
    for m in msgs {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "tool" {
            let call_id = m
                .get("tool_call_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "role=tool 的消息缺少 tool_call_id".to_string())?;
            let output = match m.get("content") {
                Some(Value::String(t)) => t.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            input.push(json!({"type":"function_call_output","call_id":call_id,"output":output}));
            continue;
        }
        if role == "assistant" {
            // Responses 的 item 是**扁平并列**的，不像 OpenAI 那样把 content 和
            // tool_calls 塞进同一个对象。
            if let Some(text) = m
                .get("content")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                input.push(json!({"role":"assistant","content":text}));
            }
            if let Some(calls) = m.get("tool_calls").and_then(Value::as_array) {
                for c in calls {
                    let name = c
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .filter(|n| !n.is_empty())
                        .ok_or_else(|| "助手轮的工具调用缺少 function.name".to_string())?;
                    let call_id = c
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "助手轮的工具调用缺少 id".to_string())?;
                    // 参数原样带走。**空串补成 `{}`**：Responses 侧要求合法 JSON，
                    // 而 OpenAI 侧的无参调用常见就是空串。
                    let args = c
                        .pointer("/function/arguments")
                        .and_then(Value::as_str)
                        .filter(|a| !a.trim().is_empty())
                        .unwrap_or("{}");
                    input.push(json!({"type":"function_call","call_id":call_id,"name":name,"arguments":args}));
                }
            }
            continue;
        }
        input.push(json!({
            "role": role,
            "content": m.get("content").cloned().unwrap_or_else(|| json!("")),
        }));
    }
    if input.is_empty() {
        return Err("没有可用的输入条目".into());
    }
    out.insert("input".into(), json!(input));

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut flat: Vec<Value> = Vec::new();
        for t in tools {
            // 只翻 function 工具；xAI 自带的 web_search / x_search 这类原样带过去。
            let Some(f) = t.get("function") else {
                flat.push(t.clone());
                continue;
            };
            let name = f
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .ok_or_else(|| "工具缺少 function.name".to_string())?;
            let mut params = f.get("parameters").cloned().unwrap_or_else(|| json!({}));
            // 同一个理由：xAI 也不收顶层 anyOf/oneOf/allOf。判据函数是共用的。
            let note = strip_top_level_schema_branches(&mut params);
            let mut desc = f
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(n) = note {
                if !desc.is_empty() {
                    desc.push('\n');
                }
                desc.push_str(&n);
            }
            flat.push(json!({"type":"function","name":name,"description":desc,"parameters":params}));
        }
        if !flat.is_empty() {
            out.insert("tools".into(), json!(flat));
        }
    }
    if let Some(tc) = body.get("tool_choice") {
        out.insert("tool_choice".into(), tc.clone());
    }

    // Responses 收的是 `reasoning: { effort }`。摘要不需要任何开关：grok-4.6 默认就回
    // summary。最深的两档能不能收是按模型定的，本机没有目录 → 折成 high，别拿一个上游
    // 可能不认的词赌整轮。
    if let Some(effort) = body
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty() && *e != "off")
    {
        let effort = match effort {
            "xhigh" | "max" => "high",
            other => other,
        };
        out.insert("reasoning".into(), json!({ "effort": effort }));
    }

    if let Some(v) = body.get("stream") {
        out.insert("stream".into(), v.clone());
    }
    // OpenAI 叫 max_tokens，Responses 叫 max_output_tokens。实测两个名字都收，但只发
    // 规范的那个 —— 发两个等于把「上游按哪个算」交给运气。
    if let Some(v) = body
        .get("max_tokens")
        .or_else(|| body.get("max_output_tokens"))
    {
        out.insert("max_output_tokens".into(), v.clone());
    }
    for key in ["temperature", "top_p", "user", "prompt_cache_key"] {
        if let Some(v) = body.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    // **stream_options 不搬**：Responses 上没有这个参数，usage 恒在 response.completed
    // 事件里。带上去就是一个未知参数。
    Ok(Value::Object(out))
}

// ───────────────────────── 响应：目标协议 → OpenAI chunk ─────────────────────────

/// 把上游的一帧原生 SSE 事件翻成**零或多个 OpenAI `chat.completion.chunk`**。
///
/// 为什么产出 OpenAI chunk 而不是直接产出内部事件：`ai.rs` 里那段 OpenAI 解析块已经把
/// 正文 / 思考（含 OpenRouter 的 reasoning_details 等四种形状）/ 工具分片 / usage 归一化 /
/// finish_reason 归一化 / 停滞看门狗全都做完了，而且它是**存量路径**。让翻译结果流回同一个
/// 块，等于新协议白拿这一整套，也等于「默认 openai 一行不变」是结构上成立的：
/// `for_wire(OpenAi)` 返回 `None`，调用方把上游帧原样交给那个块，中间没有任何代码。
#[derive(Debug)]
pub enum StreamDecoder {
    Anthropic(AnthropicDecoder),
    XaiResponses(XaiResponsesDecoder),
}

impl StreamDecoder {
    /// `None` = 这条线路不需要翻译（OpenAI 兼容）。
    pub fn for_wire(wire: Wire) -> Option<Self> {
        match wire {
            Wire::OpenAi => None,
            Wire::Anthropic => Some(StreamDecoder::Anthropic(AnthropicDecoder::default())),
            Wire::XaiResponses => Some(StreamDecoder::XaiResponses(XaiResponsesDecoder::default())),
        }
    }

    /// 喂一帧已经解析好的 JSON，拿回要交给 OpenAI 解析块的 chunk 列表。
    ///
    /// 看到本协议的**终止事件**时，返回的列表末尾会带上收尾帧（finish_reason + usage），
    /// 并且 [`Self::stream_complete`] 从此为真 —— 调用方据此收流，不必再等 `[DONE]`
    /// （Anthropic 和 Responses 都不发那个哨兵）。
    pub fn push_event(&mut self, ev: &Value) -> Result<Vec<Value>, String> {
        match self {
            StreamDecoder::Anthropic(d) => d.push_event(ev),
            StreamDecoder::XaiResponses(d) => d.push_event(ev),
        }
    }

    pub fn stream_complete(&self) -> bool {
        match self {
            StreamDecoder::Anthropic(d) => d.complete,
            StreamDecoder::XaiResponses(d) => d.complete,
        }
    }
}

/// `{"choices":[{"index":0,"delta":<delta>,"finish_reason":null}]}`
fn delta_chunk(delta: Value) -> Value {
    json!({
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": delta, "finish_reason": Value::Null}],
    })
}

/// 收尾帧。`reason` 用**上游的原词**（`max_tokens` / `end_turn` / `tool_use`…）：
/// `ai.rs::normalize_finish_reason` 已经在归一化它们，在这里先翻一遍等于两处判据。
fn finish_chunk(reason: &str) -> Value {
    json!({
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
    })
}

fn tool_chunk(index: u32, id: Option<&str>, name: Option<&str>, arguments: &str) -> Value {
    let mut function = serde_json::Map::new();
    if let Some(name) = name {
        function.insert("name".into(), json!(name));
    }
    function.insert("arguments".into(), json!(arguments));
    let mut call = serde_json::Map::new();
    // index 是必需的：`ai.rs::streamed_tool_call_index` 没有它会把整轮判失败 —— 而那是
    // 对的，分片重组全靠它。
    call.insert("index".into(), json!(index));
    if let Some(id) = id {
        call.insert("id".into(), json!(id));
    }
    call.insert("type".into(), json!("function"));
    call.insert("function".into(), Value::Object(function));
    delta_chunk(json!({ "tool_calls": [Value::Object(call)] }))
}

#[derive(Debug)]
struct ToolBlock {
    slot: u32,
    name: String,
    arguments: String,
    stopped: bool,
}

#[derive(Debug, Default)]
pub struct AnthropicDecoder {
    /// 上游 content block 下标 → OpenAI 侧 tool_calls 下标。
    ///
    /// 两套下标必须桥接：Anthropic 的 index 把 thinking / text 块也各算一格（思考在 0、
    /// 第一个工具在 1 很常见），而 OpenAI 的 tool_calls 下标必须从 0 连续排。直接透传的
    /// 表现是前端看到一个跳号的数组，第一个工具调用凭空多出一个空位。
    tool_blocks: HashMap<i64, ToolBlock>,
    next_slot: u32,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_create: u64,
    thinking_chars: u64,
    stop_reason: Option<String>,
    complete: bool,
}

impl AnthropicDecoder {
    /// 从**任何**事件上收 token 数，不只 `message_delta`。
    ///
    /// Anthropic 自家规范把最终数放在 `message_delta`，但中转不都照办：有的挂在
    /// `message_stop`，有的挂在别的事件的顶层 `usage`。网关那边只认规范位置时，生产上
    /// 约 18% 的 Claude 调用因此**按 0 计费**。只增不减：中转可能多次上报滚动值，
    /// 最后那个（最大的）不能被早先的部分值盖掉。
    fn harvest_usage(&mut self, ev: &Value) {
        for pointer in ["/usage", "/message/usage"] {
            let Some(u) = ev.pointer(pointer).filter(|u| u.is_object()) else {
                continue;
            };
            let read = |key: &str| u.get(key).and_then(Value::as_u64);
            if let Some(v) = read("input_tokens") {
                self.input_tokens = self.input_tokens.max(v);
            }
            if let Some(v) = read("output_tokens") {
                self.output_tokens = self.output_tokens.max(v);
            }
            if let Some(v) = read("cache_read_input_tokens") {
                self.cache_read = self.cache_read.max(v);
            }
            if let Some(v) = read("cache_creation_input_tokens") {
                self.cache_create = self.cache_create.max(v);
            }
        }
    }

    fn push_event(&mut self, ev: &Value) -> Result<Vec<Value>, String> {
        self.harvest_usage(ev);
        let mut out: Vec<Value> = Vec::new();
        match ev.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                if ev.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
                    let idx = ev
                        .get("index")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| "Anthropic content_block_start 缺少数字 index".to_string())?;
                    if self.tool_blocks.contains_key(&idx) {
                        return Err(format!("Anthropic tool_use 重复占用 content block {idx}"));
                    }
                    let slot = self.next_slot;
                    self.next_slot += 1;
                    let id = ev
                        .pointer("/content_block/id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let name = ev
                        .pointer("/content_block/name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    // 有的上游把完整 input 直接放在 start 里（此后不再发 input_json_delta）。
                    // 空对象要当成「没有」，否则会先发一个 "{}" 再接上真正的分片，拼出
                    // `{}{"path":…` 这种解不开的东西。
                    let initial = match ev.pointer("/content_block/input") {
                        None | Some(Value::Null) => String::new(),
                        Some(Value::Object(m)) if m.is_empty() => String::new(),
                        Some(v @ Value::Object(_)) => v.to_string(),
                        Some(_) => {
                            return Err(format!(
                                "Anthropic tool_use {name:?} 的 input 不是 JSON 对象"
                            ));
                        }
                    };
                    self.tool_blocks.insert(
                        idx,
                        ToolBlock {
                            slot,
                            name: name.to_string(),
                            arguments: initial.clone(),
                            stopped: false,
                        },
                    );
                    out.push(tool_chunk(slot, Some(id), Some(name), &initial));
                }
            }
            Some("content_block_delta") => match ev.pointer("/delta/type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(t) = ev
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                    {
                        out.push(delta_chunk(json!({ "content": t })));
                    }
                }
                Some("thinking_delta") => {
                    if let Some(t) = ev
                        .pointer("/delta/thinking")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                    {
                        self.thinking_chars += t.chars().count() as u64;
                        out.push(delta_chunk(json!({ "reasoning_content": t })));
                    }
                }
                Some("input_json_delta") => {
                    let idx = ev.get("index").and_then(Value::as_i64).ok_or_else(|| {
                        "Anthropic input_json_delta 缺少数字 index".to_string()
                    })?;
                    let pj = ev
                        .pointer("/delta/partial_json")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            format!("Anthropic input_json_delta（index {idx}）缺少 partial_json")
                        })?;
                    let block = self.tool_blocks.get_mut(&idx).ok_or_else(|| {
                        format!("Anthropic input_json_delta 指向未知的 content block {idx}")
                    })?;
                    if block.stopped {
                        return Err(format!(
                            "Anthropic input_json_delta 在 content_block_stop 之后到达（index {idx}）"
                        ));
                    }
                    if !pj.is_empty() {
                        block.arguments.push_str(pj);
                        let slot = block.slot;
                        out.push(tool_chunk(slot, None, None, pj));
                    }
                }
                _ => {}
            },
            Some("content_block_stop") => {
                if let Some(idx) = ev.get("index").and_then(Value::as_i64) {
                    if let Some(block) = self.tool_blocks.get_mut(&idx) {
                        if block.stopped {
                            return Err(format!("Anthropic content block {idx} 被结束了两次"));
                        }
                        block.stopped = true;
                        let (slot, name) = (block.slot, block.name.clone());
                        let arguments = block.arguments.clone();
                        if arguments.trim().is_empty() {
                            // 无参工具：补一个空对象，别让前端拿到空串去 JSON.parse。
                            out.push(tool_chunk(slot, None, None, "{}"));
                        } else if serde_json::from_str::<Value>(&arguments).is_err() {
                            // 块已经收尾，参数却拼不成合法 JSON —— 这是**被截断的工具调用**，
                            // 绝不能让它走到执行。开着 eager_input_streaming 时中途不合法是
                            // 正常的，收尾时不合法不是。
                            return Err(format!(
                                "Anthropic 工具调用 {name:?} 的参数在收尾时仍不是合法 JSON（很可能被截断），本轮已拒绝"
                            ));
                        }
                    }
                }
            }
            Some("message_delta") => {
                if let Some(sr) = ev
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.stop_reason = Some(sr.to_string());
                    out.push(finish_chunk(sr));
                }
            }
            Some("message_stop") => {
                out.extend(self.finish()?);
            }
            Some("error") => {
                let message = ev
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知的 Anthropic 流式错误");
                return Err(format!("Anthropic 流式错误：{message}"));
            }
            // ping / message_start / text 块的 start-stop：不产出任何 chunk。
            _ => {}
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<Value>, String> {
        for block in self.tool_blocks.values() {
            if !block.stopped {
                return Err(format!(
                    "Anthropic 流在工具调用 {:?} 收尾之前就结束了，本轮已拒绝",
                    block.name
                ));
            }
        }
        self.complete = true;
        let mut out = Vec::new();
        if self.stop_reason.is_none() {
            out.push(finish_chunk("end_turn"));
        }
        // usage 终帧。**字段名照抄 Anthropic 原生**：`ai.rs` 里的归一化只在
        // `cache_read_input_tokens` 这个键存在时才做 `prompt = input + cached + created`
        // 的加法（Anthropic 的 input_tokens 不含缓存），所以这个键必须发，哪怕是 0。
        // reasoning_tokens 不发：Anthropic 把思考算进 output_tokens，没有这一层，
        // 报 0 会被当成「没思考」。thinking_chars 是这条线路上唯一真实可核对的思考量。
        out.push(json!({
            "object": "chat.completion.chunk",
            "choices": [],
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "cache_read_input_tokens": self.cache_read,
                "cache_creation_input_tokens": self.cache_create,
                "prompt_tokens": self.input_tokens,
                "completion_tokens": self.output_tokens,
                "thinking_chars": self.thinking_chars,
            },
        }));
        Ok(out)
    }
}

#[derive(Debug, Default)]
pub struct XaiResponsesDecoder {
    /// 上游 output_index → OpenAI 侧 tool_calls 下标。理由同 Anthropic 那份：Responses
    /// 的 output_index 把思考块也算一格（实测思考是 0、第一个工具是 1）。
    tool_slots: HashMap<i64, u32>,
    next_slot: u32,
    saw_tool_call: bool,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    reasoning_tokens: u64,
    complete: bool,
}

impl XaiResponsesDecoder {
    fn slot_for(&mut self, output_index: i64) -> u32 {
        match self.tool_slots.get(&output_index) {
            Some(slot) => *slot,
            None => {
                let slot = self.next_slot;
                self.next_slot += 1;
                self.tool_slots.insert(output_index, slot);
                slot
            }
        }
    }

    fn harvest_usage(&mut self, u: &Value) {
        if let Some(v) = u.get("input_tokens").and_then(Value::as_u64) {
            self.input_tokens = self.input_tokens.max(v);
        }
        if let Some(v) = u.get("output_tokens").and_then(Value::as_u64) {
            self.output_tokens = self.output_tokens.max(v);
        }
        if let Some(v) = u
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
        {
            self.cache_read = self.cache_read.max(v);
        }
        if let Some(v) = u
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64)
        {
            self.reasoning_tokens = self.reasoning_tokens.max(v);
        }
    }

    fn push_event(&mut self, ev: &Value) -> Result<Vec<Value>, String> {
        let mut out: Vec<Value> = Vec::new();
        match ev.get("type").and_then(Value::as_str).unwrap_or("") {
            // 两个事件名都认。实测这条线走 reasoning_summary_text.delta，但 xAI 文档把
            // reasoning_text.delta 和它并列，中转也可能只转发其中一个。同一次响应里只会
            // 来一种（真抓包 35 帧里 23 条全是 summary 那一种），所以两个灌进同一个出口
            // 不会翻倍。
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(t) = ev
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    out.push(delta_chunk(json!({ "reasoning_content": t })));
                }
            }
            "response.output_text.delta" => {
                if let Some(t) = ev
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    out.push(delta_chunk(json!({ "content": t })));
                }
            }
            // 工具调用开始：名字和 call_id 在这里，参数在后面的 delta 里。
            "response.output_item.added" => {
                if ev.pointer("/item/type").and_then(Value::as_str) == Some("function_call") {
                    let output_index = ev.get("output_index").and_then(Value::as_i64).unwrap_or(0);
                    // 同一个 output_index 只开一格：中转重发同一条 added 时不该多开一个空工具。
                    let known = self.tool_slots.contains_key(&output_index);
                    let slot = self.slot_for(output_index);
                    self.saw_tool_call = true;
                    if !known {
                        let call_id = ev.pointer("/item/call_id").and_then(Value::as_str).unwrap_or("");
                        let name = ev.pointer("/item/name").and_then(Value::as_str).unwrap_or("");
                        out.push(tool_chunk(slot, Some(call_id), Some(name), ""));
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(t) = ev
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                {
                    let output_index = ev.get("output_index").and_then(Value::as_i64).unwrap_or(0);
                    // 参数先到、added 没到（中转乱序）时也要有个格子，否则整串参数丢掉。
                    let slot = self.slot_for(output_index);
                    self.saw_tool_call = true;
                    out.push(tool_chunk(slot, None, None, t));
                }
            }
            // 收尾：usage **只在**这里。
            ty @ ("response.completed" | "response.incomplete" | "response.failed") => {
                if let Some(u) = ev.pointer("/response/usage").filter(|u| u.is_object()) {
                    self.harvest_usage(u);
                }
                if ty == "response.failed" {
                    let message = ev
                        .pointer("/response/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("未知的 xAI Responses 流式错误");
                    return Err(format!("xAI Responses 流式错误：{message}"));
                }
                // 截断要如实说出来。`incomplete_details.reason == "max_output_tokens"` 是
                // 「输出额度用光了」的唯一权威信号，而客户端的截断守卫只认 finish_reason
                // 是不是 "length" —— 报成 "stop" 等于把一次半截的工具调用批准执行。
                let reason = if ev.pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    == Some("max_output_tokens")
                {
                    "length"
                } else if ty == "response.incomplete" {
                    "length"
                } else if self.saw_tool_call {
                    "tool_calls"
                } else {
                    "stop"
                };
                out.push(finish_chunk(reason));
                self.complete = true;
                // xAI 的 input_tokens **含**缓存（和 OpenAI 一致，和 Anthropic 相反），
                // 所以这里用 OpenAI 的字段名，`ai.rs` 那边就不会去做那个加法。
                out.push(json!({
                    "object": "chat.completion.chunk",
                    "choices": [],
                    "usage": {
                        "prompt_tokens": self.input_tokens,
                        "completion_tokens": self.output_tokens,
                        "prompt_tokens_details": {"cached_tokens": self.cache_read},
                        "completion_tokens_details": {"reasoning_tokens": self.reasoning_tokens},
                    },
                }));
            }
            _ => {}
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把一段 SSE 原文按行喂给解码器，收集它吐出的所有 OpenAI chunk。
    ///
    /// 只做「切行 + 解 JSON」——**不**在这里复刻 ai.rs 的抽取逻辑。测试台一旦自己实现一份
    /// 「正确答案」，钉住的就是测试台自己的形状，而不是真实消费方的形状。
    fn replay(decoder: &mut StreamDecoder, sse: &str) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        for line in sse.lines() {
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let ev: Value = serde_json::from_str(data).expect("fixture line must be JSON");
            out.extend(decoder.push_event(&ev)?);
        }
        Ok(out)
    }

    /// 按 ai.rs 那段 OpenAI 解析块的读法，把 chunk 流拼回「一次回答」。
    /// 字段路径逐字对应 ai.rs（`choices[0].delta.content` / `.reasoning_content` /
    /// `.tool_calls[]` / `choices[0].finish_reason` / 顶层 `usage`）。
    #[derive(Default, Debug)]
    struct Assembled {
        content: String,
        reasoning: String,
        /// index → (id, name, 拼起来的 arguments)
        tools: Vec<(u32, String, String, String)>,
        finish: Vec<String>,
        usage: Option<Value>,
    }

    fn assemble(chunks: &[Value]) -> Assembled {
        let mut a = Assembled::default();
        for v in chunks {
            let delta = &v["choices"][0]["delta"];
            if let Some(t) = delta["content"].as_str() {
                a.content.push_str(t);
            }
            if let Some(t) = delta["reasoning_content"].as_str() {
                a.reasoning.push_str(t);
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for c in calls {
                    let idx = c["index"].as_u64().expect("tool call needs an index") as u32;
                    let slot = match a.tools.iter().position(|(i, ..)| *i == idx) {
                        Some(p) => p,
                        None => {
                            a.tools
                                .push((idx, String::new(), String::new(), String::new()));
                            a.tools.len() - 1
                        }
                    };
                    if let Some(id) = c["id"].as_str().filter(|s| !s.is_empty()) {
                        a.tools[slot].1 = id.to_string();
                    }
                    if let Some(n) = c["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                        a.tools[slot].2 = n.to_string();
                    }
                    if let Some(args) = c["function"]["arguments"].as_str() {
                        a.tools[slot].3.push_str(args);
                    }
                }
            }
            if let Some(f) = v["choices"][0]["finish_reason"]
                .as_str()
                .filter(|f| !f.is_empty())
            {
                a.finish.push(f.to_string());
            }
            if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                a.usage = Some(u.clone());
            }
        }
        a
    }

    /// 存量自定义模型的请求体的形状（含所有只属于 OpenAI 的键）。
    fn fat_openai_body() -> Value {
        json!({
            "model": "gpt-5",
            "stream": true,
            "stream_options": {"include_usage": true},
            "messages": [
                {"role": "system", "content": "你是一个编码智能体。"},
                {"role": "user", "content": [
                    {"type": "text", "text": "看这张图"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "assistant", "content": "好的", "tool_calls": [
                    {"id": "call_1", "type": "function",
                     "function": {"name": "read_file", "arguments": "{\"path\":\"a.js\"}"}},
                    {"id": "call_2", "type": "function",
                     "function": {"name": "list_dir", "arguments": ""}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "file a"},
                {"role": "tool", "tool_call_id": "call_2", "content": "dir b"},
                {"role": "user", "content": "继续"}
            ],
            "tools": [{"type": "function", "function": {
                "name": "run_subagent",
                "description": "跑一个子智能体。",
                "parameters": {
                    "type": "object",
                    "properties": {"mode": {"type": "string", "enum": ["one", "many"]},
                                   "task": {"type": "string"},
                                   "tasks": {"type": "array"}},
                    "anyOf": [
                        {"properties": {"mode": {"enum": ["one"]}}, "required": ["task"]},
                        {"properties": {"mode": {"enum": ["many"]}}, "required": ["tasks"]}
                    ]
                }
            }}],
            "tool_choice": "auto",
            "max_tokens": 4096,
            "temperature": 0.3,
            "top_p": 0.9,
            "stop": ["</done>"],
            "reasoning_effort": "xhigh",
            "thinking_budget": 20000,
            "mc_prefix": "mcp_abc"
        })
    }

    // ───────────────── 铁律：默认 openai 一行行为都不变 ─────────────────

    #[test]
    fn absent_or_unknown_protocol_is_openai() {
        assert_eq!(Wire::of(None), Wire::OpenAi);
        assert_eq!(Wire::of(Some("")), Wire::OpenAi);
        assert_eq!(Wire::of(Some("openai")), Wire::OpenAi);
        assert_eq!(Wire::of(Some("OPENAI")), Wire::OpenAi); // 大小写不匹配 → 退回默认
        assert_eq!(Wire::of(Some("who-knows")), Wire::OpenAi);
        assert_eq!(Wire::of(Some(" anthropic ")), Wire::Anthropic);
        assert_eq!(Wire::of(Some("xai_responses")), Wire::XaiResponses);
    }

    /// 这四条断言和 ai.rs 里 `chat_completions_url` 的既有断言逐字相同，外加两个
    /// 存量用户真的会粘的形状。改坏了这段，存量自定义模型全都会打到错误的 URL 上。
    #[test]
    fn openai_endpoint_url_is_byte_for_byte_what_it_was() {
        let u = |b: &str| endpoint_url(Wire::OpenAi, b).unwrap();
        assert_eq!(u("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(u("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(
            u("https://gateway.example/v1/chat/completions"),
            "https://gateway.example/v1/chat/completions"
        );
        assert_eq!(u("http://localhost:11434/v1/"), "http://localhost:11434/v1/chat/completions");
        assert_eq!(
            u("https://relay.example/v1/openai/"),
            "https://relay.example/v1/openai/chat/completions"
        );
        assert!(endpoint_url(Wire::OpenAi, "api.openai.com/v1").is_err());
    }

    #[test]
    fn openai_request_translation_is_the_identity() {
        let body = fat_openai_body();
        assert_eq!(translate_request(Wire::OpenAi, &body).unwrap(), body);
    }

    #[test]
    fn openai_adds_no_auth_headers_and_needs_no_decoder() {
        assert!(extra_auth_headers(Wire::OpenAi, "sk-secret").is_empty());
        assert!(StreamDecoder::for_wire(Wire::OpenAi).is_none());
    }

    // ───────────────────────── Anthropic：请求 ─────────────────────────

    #[test]
    fn anthropic_endpoint_and_auth_headers() {
        let u = |b: &str| endpoint_url(Wire::Anthropic, b).unwrap();
        assert_eq!(u("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
        assert_eq!(u("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
        // 用户粘了 OpenAI 的完整端点又选了 anthropic：不能拼成 .../chat/completions/v1/messages
        assert_eq!(u("https://relay.example/v1/chat/completions"), "https://relay.example/v1/messages");
        assert_eq!(u("https://relay.example/v1/messages"), "https://relay.example/v1/messages");

        let headers = extra_auth_headers(Wire::Anthropic, "sk-ant-123");
        assert_eq!(headers[0], ("x-api-key", "sk-ant-123".to_string()));
        assert_eq!(headers[1], ("anthropic-version", "2023-06-01".to_string()));
        assert_eq!(
            headers[2],
            (
                "anthropic-beta",
                "effort-2025-11-24,interleaved-thinking-2025-05-14".to_string()
            )
        );
        assert_eq!(headers.len(), 3, "多发一个 beta 就可能被中转 503，加之前先想清楚");

    }

    #[test]
    fn anthropic_lifts_system_and_groups_consecutive_tool_results() {
        let out = translate_request(Wire::Anthropic, &fat_openai_body()).unwrap();
        // system 是顶层字段，不是一条消息
        assert_eq!(out["system"][0]["text"], "你是一个编码智能体。");
        assert!(
            out["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["role"] != "system"),
            "system 不能留在 messages 里"
        );
        // 图片翻成 base64 source
        assert_eq!(out["messages"][0]["content"][1]["type"], "image");
        assert_eq!(out["messages"][0]["content"][1]["source"]["media_type"], "image/png");
        assert_eq!(out["messages"][0]["content"][1]["source"]["data"], "AAAA");
        // assistant 的 tool_calls → tool_use 块，arguments 字符串解成对象
        assert_eq!(out["messages"][1]["role"], "assistant");
        assert_eq!(out["messages"][1]["content"][0]["type"], "text");
        assert_eq!(out["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(out["messages"][1]["content"][1]["input"]["path"], "a.js");
        // 空 arguments 补成空对象，而不是留一个字符串
        assert_eq!(out["messages"][1]["content"][2]["input"], json!({}));
        // **两条连续的 tool 结果必须并进同一个 user 轮** —— Anthropic 的硬要求
        assert_eq!(out["messages"][2]["role"], "user");
        assert_eq!(out["messages"][2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(out["messages"][2]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(out["messages"][2]["content"][1]["tool_use_id"], "call_2");
        // 后面那条普通 user 另起一轮
        assert_eq!(out["messages"][3]["role"], "user");
        assert_eq!(out["messages"][3]["content"], "继续");
    }

    #[test]
    fn anthropic_drops_every_key_the_native_api_rejects() {
        let out = translate_request(Wire::Anthropic, &fat_openai_body()).unwrap();
        for forbidden in [
            "stream_options",   // 官方严格拒绝未知顶层键
            "mc_prefix",        // 网关私有协议，第三方端点不认识
            "reasoning_effort", // OpenAI 的说法
            "thinking_budget",  // 本仓自造的键
            "temperature",      // 新一代 Claude 即使关思考也拒收
            "top_p",
            "stop",             // 名字要翻成 stop_sequences
            "tool_choice_x",
        ] {
            assert!(
                out.get(forbidden).is_none(),
                "{forbidden} 不该出现在原生 Anthropic 请求体里"
            );
        }
        assert_eq!(out["stop_sequences"], json!(["</done>"]));
        assert_eq!(out["tool_choice"], json!({"type": "auto"}));
        assert_eq!(out["stream"], json!(true));
        assert_eq!(out["max_tokens"], json!(4096));
    }

    #[test]
    fn anthropic_tools_are_flat_and_lose_their_top_level_branches() {
        let out = translate_request(Wire::Anthropic, &fat_openai_body()).unwrap();
        let tool = &out["tools"][0];
        assert_eq!(tool["name"], "run_subagent");
        assert!(tool.get("function").is_none(), "Anthropic 的工具是扁平的");
        assert!(
            tool["input_schema"].get("anyOf").is_none(),
            "顶层 anyOf 会被 Anthropic 400 掉，必须剥掉"
        );
        let desc = tool["description"].as_str().unwrap();
        assert!(desc.contains("mode=one → task"), "剥掉的分支要补进描述：{desc}");
        assert!(desc.contains("mode=many → tasks"), "{desc}");
        // 不开这个，工具入参会攒完才发 —— write_file 的实时预览就永远是空的
        assert_eq!(tool["eager_input_streaming"], json!(true));
    }

    #[test]
    fn anthropic_refuses_a_tool_call_whose_arguments_are_not_json() {
        let body = json!({"model":"claude","messages":[
            {"role":"assistant","tool_calls":[{"id":"c1","type":"function",
             "function":{"name":"write_file","arguments":"{\"path\":\"a.js\",\"conte"}}]}
        ]});
        let err = translate_request(Wire::Anthropic, &body).unwrap_err();
        assert!(err.contains("write_file"), "{err}");
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn anthropic_max_tokens_is_required_and_stays_above_the_thinking_budget() {
        // 没填就得有个数，否则上游直接 400
        let bare = translate_request(Wire::Anthropic, &json!({"model":"claude","messages":[]})).unwrap();
        assert_eq!(bare["max_tokens"], json!(ANTHROPIC_DEFAULT_MAX_TOKENS));
        // budget >= max_tokens 是保证 400 的组合
        let thinking = translate_request(
            Wire::Anthropic,
            &json!({"model":"claude-3-7-sonnet","messages":[],"max_tokens":4096,
                    "thinking":{"type":"enabled","budget_tokens":10000}}),
        )
        .unwrap();
        assert_eq!(thinking["thinking"], json!({"type":"enabled","budget_tokens":10000}));
        assert_eq!(thinking["max_tokens"], json!(14096));
        assert!(thinking.get("output_config").is_none(), "旧家族不能发 effort");
        // adaptive 一族：深度旋钮在 output_config.effort 上；xhigh 折成 high
        let adaptive = translate_request(
            Wire::Anthropic,
            &json!({"model":"claude-sonnet-5","messages":[],"thinking":{"type":"adaptive"},
                    "reasoning_effort":"xhigh"}),
        )
        .unwrap();
        assert_eq!(adaptive["output_config"], json!({"effort":"high"}));
        // **没给 thinking 就一个字都不发** —— 猜错代际就是硬 400
        let no_thinking = translate_request(
            Wire::Anthropic,
            &json!({"model":"claude-sonnet-5","messages":[],"reasoning_effort":"high"}),
        )
        .unwrap();
        assert!(no_thinking.get("thinking").is_none());
        assert!(no_thinking.get("output_config").is_none());
    }

    // ───────────────────────── Anthropic：响应 ─────────────────────────

    const ANTHROPIC_FIXTURE: &str = include_str!("../testdata/anthropic_tool_call.sse");

    #[test]
    fn anthropic_stream_yields_thinking_text_and_one_whole_tool_call() {
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let chunks = replay(&mut d, ANTHROPIC_FIXTURE).unwrap();
        assert!(d.stream_complete(), "message_stop 之后必须收流（这条路上没有 [DONE]）");
        let a = assemble(&chunks);
        assert_eq!(a.reasoning, "用户问东京时间，应该调用 get_time。");
        assert_eq!(a.content, "我查一下。");
        // **分片必须还原成一个完整的工具调用**
        assert_eq!(a.tools.len(), 1);
        let (index, id, name, arguments) = &a.tools[0];
        // content block 下标是 2（思考 0、正文 1），OpenAI 侧的 tool_calls 下标必须是 0
        assert_eq!(*index, 0, "tool_calls 下标必须从 0 连续排，不能透传 content block 下标");
        assert_eq!(id, "tooluse_1");
        assert_eq!(name, "get_time");
        assert_eq!(arguments, r#"{"tz": "Asia/Tokyo"}"#);
        serde_json::from_str::<Value>(arguments).expect("还原出来的参数必须是合法 JSON");
        // 停止原因用上游原词，交给 ai.rs::normalize_finish_reason 归一
        assert_eq!(a.finish, ["tool_use"]);
        // usage：Anthropic 的 input_tokens 不含缓存，所以 cache_read_input_tokens 这个键
        // 必须在，ai.rs 才会去做那个加法
        let usage = a.usage.expect("收尾必须带 usage");
        assert_eq!(usage["input_tokens"], json!(15));
        assert_eq!(usage["output_tokens"], json!(18));
        assert_eq!(usage["cache_read_input_tokens"], json!(46));
        assert_eq!(usage["prompt_tokens"], json!(15));
        // Anthropic 不报思考 token，字符数是这条线路上唯一真实可核对的思考量
        assert_eq!(usage["thinking_chars"], json!(22));
        assert!(usage.get("reasoning_tokens").is_none());
    }

    #[test]
    fn anthropic_stream_refuses_a_tool_call_truncated_at_the_block_stop() {
        let truncated = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"w1\",\"name\":\"write_file\",\"input\":{}}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.js\\\",\\\"conte\"}}\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let err = replay(&mut d, truncated).unwrap_err();
        assert!(err.contains("write_file"), "{err}");
        assert!(err.contains("截断"), "{err}");
    }

    #[test]
    fn anthropic_stream_refuses_a_message_stop_with_an_unfinished_tool_call() {
        let cut = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"w1\",\"name\":\"write_file\",\"input\":{}}}\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let err = replay(&mut d, cut).unwrap_err();
        assert!(err.contains("write_file"), "{err}");
    }

    #[test]
    fn anthropic_two_parallel_tool_calls_get_distinct_consecutive_slots() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"read_file\",\"input\":{}}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"p\\\":1}\"}}\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"b\",\"name\":\"list_dir\",\"input\":{}}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"p\\\":2}\"}}\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        assert_eq!(a.tools.len(), 2);
        assert_eq!((a.tools[0].0, a.tools[0].3.as_str()), (0, r#"{"p":1}"#));
        assert_eq!((a.tools[1].0, a.tools[1].3.as_str()), (1, r#"{"p":2}"#));
        // 没有 message_delta 时也要给一个停止原因，否则前端的截断守卫无从判断
        assert_eq!(a.finish, ["end_turn"]);
    }

    #[test]
    fn anthropic_tool_call_with_no_arguments_becomes_an_empty_object() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"n\",\"name\":\"noop\",\"input\":{}}}\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        assert_eq!(a.tools[0].3, "{}", "空串会让前端 JSON.parse 直接抛");
    }

    /// 中转把最终 usage 挂在 `message_stop` 上（不按规范挂 `message_delta`）。网关那边
    /// 只认规范位置时，生产上约 18% 的 Claude 调用按 0 计费。
    #[test]
    fn anthropic_usage_is_harvested_from_wherever_it_lands() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n",
            "data: {\"type\":\"message_stop\",\"usage\":{\"input_tokens\":900,\"output_tokens\":7}}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        let usage = a.usage.expect("挂在 message_stop 上的 usage 也要收");
        assert_eq!(usage["input_tokens"], json!(900));
        assert_eq!(usage["output_tokens"], json!(7));
    }

    #[test]
    fn anthropic_error_event_fails_the_turn_loudly() {
        let mut d = StreamDecoder::for_wire(Wire::Anthropic).unwrap();
        let err = replay(
            &mut d,
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n",
        )
        .unwrap_err();
        assert!(err.contains("Overloaded"), "{err}");
    }

    // ───────────────────────── xAI Responses ─────────────────────────

    const XAI_FIXTURE: &str = include_str!("../testdata/xai_responses_tool_call.sse");

    #[test]
    fn xai_endpoint_and_no_extra_auth_headers() {
        assert_eq!(
            endpoint_url(Wire::XaiResponses, "https://api.x.ai").unwrap(),
            "https://api.x.ai/v1/responses"
        );
        assert_eq!(
            endpoint_url(Wire::XaiResponses, "https://relay.example/v1/chat/completions").unwrap(),
            "https://relay.example/v1/responses"
        );
        assert!(extra_auth_headers(Wire::XaiResponses, "xai-1").is_empty());
    }

    #[test]
    fn xai_request_reshapes_history_and_flattens_tools() {
        let out = translate_request(Wire::XaiResponses, &fat_openai_body()).unwrap();
        assert!(out.get("messages").is_none(), "Responses 叫 input");
        let input = out["input"].as_array().unwrap();
        // system 保留成一条普通 item（形状一致）
        assert_eq!(input[0]["role"], "system");
        // assistant 的正文和每个 tool_call 是**并列的独立 item**
        assert_eq!(input[2]["role"], "assistant");
        assert_eq!(input[3]["type"], "function_call");
        assert_eq!(input[3]["call_id"], "call_1");
        assert_eq!(input[3]["arguments"], "{\"path\":\"a.js\"}");
        // 空参数补成 {}，Responses 要求合法 JSON
        assert_eq!(input[4]["arguments"], "{}");
        // 工具结果是独立 item，不是 role=tool
        assert_eq!(input[5]["type"], "function_call_output");
        assert_eq!(input[5]["call_id"], "call_1");
        // 工具是扁平的
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["name"], "run_subagent");
        assert!(out["tools"][0].get("function").is_none(), "包一层会 400");
        assert!(out["tools"][0]["parameters"].get("anyOf").is_none());
        // max_tokens → max_output_tokens；stream_options 不存在于这个协议
        assert_eq!(out["max_output_tokens"], json!(4096));
        assert!(out.get("max_tokens").is_none());
        assert!(out.get("stream_options").is_none());
        assert!(out.get("mc_prefix").is_none());
        // 深度：没有模型目录，xhigh 折成一定认的 high
        assert_eq!(out["reasoning"], json!({"effort": "high"}));
        assert!(out.get("reasoning_effort").is_none());
        // 这两个 Responses 是收的，别顺手一起丢了
        assert_eq!(out["temperature"], json!(0.3));
        assert_eq!(out["top_p"], json!(0.9));
    }

    /// 夹具是**生产线路的真抓包**（server/testdata/xai_responses_b.sse 的原样副本）。
    #[test]
    fn xai_stream_from_a_real_capture_yields_thinking_and_a_whole_tool_call() {
        let mut d = StreamDecoder::for_wire(Wire::XaiResponses).unwrap();
        let chunks = replay(&mut d, XAI_FIXTURE).unwrap();
        assert!(d.stream_complete(), "response.completed 之后必须收流");
        let a = assemble(&chunks);
        assert_eq!(
            a.reasoning,
            "The user is asking about the weather in Beijing right now, and they want me to use the tool to check.\n"
        );
        assert_eq!(a.content, "", "这一轮没有正文，只有思考 + 工具调用");
        assert_eq!(a.tools.len(), 1);
        let (index, id, name, arguments) = &a.tools[0];
        // 上游的 output_index 是 1（思考占了 0），OpenAI 侧必须是 0
        assert_eq!(*index, 0);
        assert_eq!(id, "call-702f91f8-a4be-4f6c-81f8-7b36038524d0-0");
        assert_eq!(name, "get_weather");
        assert_eq!(arguments, "{\"city\":\"北京\"}");
        assert_eq!(a.finish, ["tool_calls"]);
        let usage = a.usage.expect("usage 只在 response.completed 里");
        // xAI 的 input_tokens **含**缓存，所以用 OpenAI 的字段名，ai.rs 就不会去做加法
        assert_eq!(usage["prompt_tokens"], json!(730));
        assert_eq!(usage["completion_tokens"], json!(89));
        assert_eq!(usage["prompt_tokens_details"]["cached_tokens"], json!(512));
        assert_eq!(usage["completion_tokens_details"]["reasoning_tokens"], json!(77));
    }

    /// 输出额度用光要如实报 "length"。报成 "stop" 等于把一次半截的工具调用批准执行。
    #[test]
    fn xai_truncated_response_reports_length_not_stop() {
        let sse = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"half\",\"output_index\":0}\n",
            "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::XaiResponses).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        assert_eq!(a.content, "half");
        assert_eq!(a.finish, ["length"]);
    }

    #[test]
    fn xai_arguments_split_across_frames_are_rejoined() {
        // 真抓包里参数只有一帧，那是巧合不是保证：入参一长，上游一定会切。
        // 切开之后拼不回来的表现是 JSON.parse 失败 → 工具卡带着半截参数落地。
        let sse = concat!(
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_x\",\"name\":\"write_file\"}}\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"path\\\":\",\"output_index\":0}\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"\\\"a.rs\\\"}\",\"output_index\":0}\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::XaiResponses).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        assert_eq!(a.tools.len(), 1);
        assert_eq!(a.tools[0].1, "call_x");
        assert_eq!(a.tools[0].2, "write_file");
        assert_eq!(a.tools[0].3, "{\"path\":\"a.rs\"}");
        serde_json::from_str::<serde_json::Value>(&a.tools[0].3).expect("拼回来必须是合法 JSON");
    }

    #[test]
    fn xai_arguments_arriving_before_the_item_still_get_a_slot() {
        // 中转乱序：参数先到、output_item.added 没到。丢掉的话整串参数就没了。
        let sse = concat!(
            "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"a\\\":1}\",\"output_index\":3}\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n",
        );
        let mut d = StreamDecoder::for_wire(Wire::XaiResponses).unwrap();
        let a = assemble(&replay(&mut d, sse).unwrap());
        assert_eq!(a.tools.len(), 1);
        assert_eq!(a.tools[0].3, "{\"a\":1}");
        assert_eq!(a.finish, ["tool_calls"]);
    }

    #[test]
    fn xai_failed_response_fails_the_turn_loudly() {
        let mut d = StreamDecoder::for_wire(Wire::XaiResponses).unwrap();
        let err = replay(
            &mut d,
            "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"quota exceeded\"}}}\n",
        )
        .unwrap_err();
        assert!(err.contains("quota exceeded"), "{err}");
    }

    // ───────────────────────── 不许假装支持 ─────────────────────────

    /// 每个协议都必须**要么**支持一项能力，**要么**在这里说清它不支持。
    /// 空表只允许出现在 OpenAI 上（那是基准）。
    #[test]
    fn every_non_default_protocol_declares_its_gaps() {
        assert!(Wire::OpenAi.unsupported().is_empty());
        for wire in [Wire::Anthropic, Wire::XaiResponses] {
            let gaps = wire.unsupported();
            assert!(!gaps.is_empty(), "{:?} 必须声明它翻译不了的能力", wire);
            for gap in gaps {
                assert!(gap.chars().count() > 12, "「{gap}」太短，说不清用户会看到什么");
            }
        }
        for id in PROTOCOLS {
            assert_eq!(Wire::of(Some(id)).id(), id, "PROTOCOLS 里的 {id} 解析不回自己");
        }
    }
}

#[cfg(test)]
mod harness_error_prefix_tests {
    use super::{harness_error_prefix, oai_to_anthropic};
    use serde_json::json;

    #[test]
    fn harness_markers_at_line_start_are_errors() {
        for m in [
            "[ERROR] 这个工具执行时抛出异常",
            "[BLOCKED] 只读模式",
            "[BLOCKED_COMMAND_BATCH] 这条没有执行",
            "[interrupted]",
            "[未执行]",
            "[失败] 没找到可停止的任务终端",
            "[不可用] 桌面专用",
            "[TIMEOUT] 子智能体超时",
            "[WORKSPACE_GONE] 工作目录不存在",
            "[tool-args-invalid] 参数缺失",
            "   [ERROR] 前面有空白也算",
        ] {
            assert!(harness_error_prefix(m), "{m:?} 该判成 harness 失败");
        }
    }

    #[test]
    fn material_that_merely_contains_markers_is_not_an_error() {
        for m in [
            "文件 README.md:\n[ERROR] 这一节讲错误处理",
            "命令输出:\n[ERROR] 程序自己打的日志",
            "〔外部数据〕\n[ERROR] 网页里写的一句",
            "〔外部数据〕[失败] 别人的文案",
            "ok",
            "",
        ] {
            assert!(!harness_error_prefix(m), "{m:?} 是材料，不是 harness 的判决");
        }
    }

    #[test]
    fn tool_role_gets_is_error_only_for_harness_failures() {
        let body = json!({
            "messages": [
                {"role": "tool", "tool_call_id": "a", "content": "[ERROR] 这个工具执行时抛出异常，未能完成：boom"},
                {"role": "tool", "tool_call_id": "b", "content": "文件 x.js:\n[ERROR] 文件里的内容"},
                {"role": "tool", "tool_call_id": "c", "content": "〔外部数据〕\n[BLOCKED] 网页里写的"}
            ]
        });
        let out = oai_to_anthropic(&body).expect("翻译不该失败");
        let blocks = out["messages"][0]["content"].as_array().expect("连续的工具结果并进同一个 user 轮");
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["is_error"], json!(true), "harness 报的失败要带 is_error");
        assert!(blocks[1].get("is_error").is_none(), "正文里含 [ERROR] 的成功读取不许被标成失败");
        assert!(blocks[2].get("is_error").is_none(), "〔外部数据〕抬头之后的标记是别人写的");
        assert_eq!(blocks[0]["tool_use_id"], json!("a"));
    }
}
