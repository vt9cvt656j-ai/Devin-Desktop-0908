use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

const RESPONSE_HEADERS_TIMEOUT_SECS: u64 = 60;
const STANDARD_FIRST_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const STANDARD_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const STANDARD_STREAM_STALL_TIMEOUT_SECS: u64 = 60;
const HIGH_FIRST_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const HIGH_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const HIGH_STREAM_STALL_TIMEOUT_SECS: u64 = 90;
const EXTENDED_FIRST_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const EXTENDED_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS: u64 = 60;
const EXTENDED_STREAM_STALL_TIMEOUT_SECS: u64 = 120;
/// 「连接还活着，但模型半天不吐字」时的兜底上限。
///
/// 上面那些 stall 档位回答的是**连接是不是死了**，而这个问题只有在一个字节都收不到时才
/// 成立。网关每 15 秒推一次 SSE 心跳（`: ping`）正是为了穿过运营商 NAT——心跳照常到达时，
/// 连接显然是好的，模型只是在憋一段长输出或在想。此时用 90 秒把它掐掉，等于客户端替
/// 网关做了它做不了的判断：只有网关分得清"上游沉默"和"连接断了"，也只有它能给出真实
/// 原因（`upstream stream stalled for N seconds`）。客户端抢先开枪，那句诊断就永远到不了
/// 用户手里，用户看到的是一句无从下手的"连接中断"。
///
/// 所以有字节在流动时改用这一档。取值高于网关对普通请求的空闲守卫（180s），
/// 让网关先说话；思考类请求网关给到 600s，但让用户对着一个没有任何输出的界面等十分钟
/// 同样不可接受，所以这里封在 300 秒——一个"连接活着却五分钟零产出"的请求，客户端有理由
/// 自己收手。这是刻意的取舍，不是照抄网关的数。
const STANDARD_CONTENT_BACKSTOP_SECS: u64 = 200;
const THINKING_CONTENT_BACKSTOP_SECS: u64 = 300;
/// 多久收不到任何字节就认定连接真的没了。网关心跳 15 秒一次，连丢 4 次不是抖动。
const STREAM_LIVENESS_SECS: u64 = 60;

const FIRST_STREAM_PROGRESS_TIMEOUT_ENV: &str = "MICHAEL_AI_FIRST_PROGRESS_TIMEOUT_SECS";
const EMPTY_STREAM_PROGRESS_TIMEOUT_ENV: &str = "MICHAEL_AI_EMPTY_STREAM_TIMEOUT_SECS";
const STREAM_STALL_TIMEOUT_ENV: &str = "MICHAEL_AI_STREAM_STALL_TIMEOUT_SECS";

const FIRST_STREAM_PROGRESS_TIMEOUT_MIN_SECS: u64 = 60;
const FIRST_STREAM_PROGRESS_TIMEOUT_MAX_SECS: u64 = 60;
const EMPTY_STREAM_PROGRESS_TIMEOUT_MIN_SECS: u64 = 60;
const EMPTY_STREAM_PROGRESS_TIMEOUT_MAX_SECS: u64 = 60;
const STREAM_STALL_TIMEOUT_MIN_SECS: u64 = 15;
const STREAM_STALL_TIMEOUT_MAX_SECS: u64 = 300;
const STREAM_READ_POLL: Duration = Duration::from_secs(2);
const INCOMPLETE_SSE_STREAM_ERROR: &str = "AI stream closed before data: [DONE]（连接提前结束）；响应可能被截断，已拒绝本轮结果，请重试。";
const AI_ERROR_BODY_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_AI_ERROR_BODY_BYTES: usize = 64 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(100);
const CANCELLED_AI_REQUEST: &str = "AI request cancelled";
const RESPONSE_DEADLINE_HEADER: &str = "x-ide-response-deadline-ms";
/// 同一个截止时间的相对说法，和上面那个一起发。
///
/// 绝对时间戳是**本机墙上时钟**的值，网关要减自己的时钟才能算出"还剩多久"。机器时钟
/// 慢上一两分钟（NTP 被挡、虚拟机休眠唤醒、装机没对时），这个差就永远是负的，网关算出
/// 的预算恒为零 —— 那台机器上每一次请求都在发往上游之前就被判死，而且永远如此，两边
/// 日志里都看不出为什么。相对预算不牵涉时钟比对，网关优先采信它。
const RESPONSE_BUDGET_HEADER: &str = "x-ide-response-budget-ms";
const MICHAEL_GATEWAY_HEALTH_URL: &str = "https://code.mrday.one/health";
const GATEWAY_TRANSPORT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(50);
const GATEWAY_TRANSPORT_WARMUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Shared HTTP client. The agentic loop fires many sequential requests; a single
/// pooled client reuses TCP+TLS connections (keep-alive) instead of doing a fresh
/// handshake on every turn — the main source of "backend feels laggy" between
/// turns. No total `.timeout()` is set because chat responses stream open-ended;
/// connection setup is bounded here and each streaming request separately bounds
/// the wait for response headers.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .tcp_keepalive(Duration::from_secs(20))
        // Prefer one multiplexed gateway connection and keep it alive while the
        // user is thinking between Agent turns. The startup HEAD below covers a
        // cold connection; HTTP/2 PINGs avoid paying that handshake again later.
        .http2_keep_alive_interval(Some(GATEWAY_TRANSPORT_KEEPALIVE_INTERVAL))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        // The IDE↔LLM-gateway link must NEVER route through the macOS system proxy. Otherwise a
        // capture/MITM proxy the user (or the agent) set up — and left dangling on a dead port —
        // silently kills all AI requests ("无法连接服务器"). Talk to our gateway directly, always.
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

async fn warm_gateway_transport_once(client: &reqwest::Client, url: &str) {
    let _ = client
        .head(url)
        .timeout(GATEWAY_TRANSPORT_WARMUP_TIMEOUT)
        .send()
        .await;
}

/// Warm and retain the desktop AI client's own gateway connection. Frontend
/// fetches use WebKit's separate pool, so they cannot prepay this TCP+TLS setup.
pub(crate) fn start_gateway_transport_warmup() {
    tauri::async_runtime::spawn(async {
        loop {
            warm_gateway_transport_once(&HTTP, MICHAEL_GATEWAY_HEALTH_URL).await;
            tokio::time::sleep(GATEWAY_TRANSPORT_KEEPALIVE_INTERVAL).await;
        }
    });
}

/// In-flight request cancellation. The JS side passes a unique physical `cancel_id`
/// (falling back to `request_id` for older callers) and calls `cancel_ai(id)` when the user hits Stop —
/// the streaming loop polls this flag and ends the turn immediately, closing the
/// upstream connection and stopping token generation. (Stop used to only mute the
/// UI while the backend kept generating + billing.)
static CANCELS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_cancel(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = CANCELS.lock() {
        m.insert(id.to_string(), flag.clone());
    }
    flag
}

/// RAII: drop removes the cancel flag from the registry on EVERY exit path of the
/// turn (normal end, error, stall, cancel) — so the map never leaks entries.
struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = CANCELS.lock() {
            m.remove(&self.0);
        }
    }
}

/// Flip the cancel flag for an in-flight request (called from JS on Stop). No-op
/// if the request already finished (its id is no longer registered).
#[tauri::command]
pub fn cancel_ai(request_id: String) {
    if let Ok(m) = CANCELS.lock() {
        if let Some(flag) = m.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn cancellation_id(config: &AiConfig) -> Option<String> {
    config
        .cancel_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .or_else(|| config.request_id.as_deref().filter(|id| !id.is_empty()))
        .map(str::to_string)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 自定义模型的**上游线协议**：`openai` / `anthropic` / `xai_responses`。
    ///
    /// 缺省（存量的自定义模型记录里没有这个字段）和任何未知值一律落 OpenAI 兼容，
    /// 那条路上的 URL、请求体、鉴权头、SSE 解析和这个字段存在之前逐字一致。
    /// 网关线路永远不带它。判据与翻译全在 `crate::protocol`。
    #[serde(default)]
    pub protocol: Option<String>,
    /// 用户自带上游（自定义模型走网关代发时才有）。
    ///
    /// 这三样一起出现：`base_url` 指向**网关**，而请求最终要转发到的是 `byo_base`，
    /// 用 `byo_key` 鉴权、按 `byo_proto` 翻译。这样走一趟网关，是为了让服务端把完整的
    /// 系统提示词和工具描述装配进去（自定义端点原来是客户端直连，那条路上拿不到，
    /// 智能体因此一直弱一截）—— 而提示词和工具描述**始终不进客户端**。
    ///
    /// 这里只负责原样转成三个请求头；地址合法性（只收 https、DNS 解析之后逐个查网段、
    /// 连接钉在验过的 IP 上）由网关的 `byo_upstream` 判，那是唯一一道 SSRF 防线。
    /// 客户端不做这个判断：客户端的校验对攻击者是可绕过的。
    #[serde(default)]
    pub byo_base: Option<String>,
    #[serde(default)]
    pub byo_key: Option<String>,
    #[serde(default)]
    pub byo_proto: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// "max" thinking-budget hint (in tokens). Relays that support extended thinking
    /// budgets honor this; others ignore it. Set together with reasoning_effort="high"
    /// when the user picks the "极限/max" tier in the model hover card.
    #[serde(default)]
    pub thinking_budget: Option<u32>,
    /// UI 档位原值（off/low/medium/high/xhigh/max）。前端对每个模型都会带上它（包括那些
    /// 只发 thinking/thinkingConfig 而不发 reasoning_effort 的家族），本字段只用于本地
    /// 看门狗分档，绝不写进上游请求体。
    #[serde(default)]
    pub thinking_effort: Option<String>,
    #[serde(default)]
    pub thinking: Option<serde_json::Value>,
    #[serde(default)]
    pub thinking_config: Option<serde_json::Value>,
    /// Gateway settlement identity. It is relayed as `x-ide-request-id` and may cover
    /// multiple physical model calls belonging to one user-visible run.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Physical request identity used only by the local cancellation registry. This
    /// keeps Stop from cancelling another request that shares the settlement ID.
    #[serde(default)]
    pub cancel_id: Option<String>,
    /// Correlates the individual model request with the user-visible Agent run.
    /// These values are diagnostic metadata only and are strictly filtered before
    /// becoming HTTP headers.
    #[serde(default)]
    pub ide_run_id: Option<String>,
    /// 会话级亲和键，见发头处的注释。
    pub ide_session_id: Option<String>,
    /// 会话开场那句用户请求，base64(UTF-8)。网关压缩时用它当「原始目标」，
    /// 而不是从已被截断的请求体里现算（那样第二个压缩轮起就指着一句半路的话）。
    pub ide_session_goal: Option<String>,
    #[serde(default)]
    pub ide_step_index: Option<i64>,
    #[serde(default)]
    pub ide_step_kind: Option<String>,
    /// L0 server-side assembly (anti-reverse), default-off on the JS side. When set,
    /// the client ships the mode NAME + the static tool NAMES instead of the system
    /// prompt and the tool schemas; ai.rs relays them as `x-ide-mode` / `x-ide-tools`
    /// headers and the gateway injects the real prompt + schemas before proxying
    /// upstream — so neither the bundle nor the request carries that IP. Absent →
    /// byte-for-byte unchanged behavior.
    #[serde(default)]
    pub ide_mode: Option<String>,
    /// 用户在模型卡片上选中的上下文窗口（token）。目录查不到窗口的模型在客户端和网关**两边**
    /// 都退回同一个猜测（128k），于是那个滑块拖了不算数。把选中的值原样带过去，网关的压缩
    /// 就按它切 —— 用户的原话是"我想调到用哪个就用哪个"。
    #[serde(default)]
    pub ide_context_window: Option<u64>,
    #[serde(default)]
    pub ide_tools: Option<String>,
    /// Versioned semantic routing decisions produced by the IDE's model-backed engineering
    /// classifier. The gateway uses these flags to select Prompt Graph modules without parsing
    /// the user's prose a second time.
    #[serde(default)]
    pub ide_semantic_profile: Option<String>,
    /// ISO 3166-1 alpha-2 region code (lowercase) resolved by the IDE from the user's real
    /// IP egress (Cloudflare trace) with timezone fallback. The gateway uses it to inject
    /// region-appropriate package mirror guidance (e.g. npmmirror for mainland China).
    #[serde(default)]
    pub ide_region: Option<String>,
    /// 用户在 Claude 模型卡片右上角打开了「强力版」。为 true 时网关只会把这一轮派到
    /// 后台勾了「Claude 强力版」的线路上；一条都没勾时网关明确报错，而不是悄悄退回
    /// 普通线路 —— 用户点了强力版还给他普通线路，等于把他的选择改掉了。
    #[serde(default)]
    pub ide_power_route: Option<bool>,
    /// 用户在模型列表里点的是哪一组 —— 即那条线路的 id。
    ///
    /// 同一个模型挂在两条线路上时，IDE 里是两个分组、显示的价还不一样，而在这之前
    /// 两组点下去发出去的请求逐字相同，网关只能按 sort 取第一条。于是用户看到便宜的那个价、
    /// 按贵的那条扣。和 ide_power_route 走同一条通道。
    pub ide_route_id: Option<String>,
    /// michael-compression 的档位（"1m"/"2m"/"5m"），由 /api/me 下发、客户端原样回传。
    ///
    /// 这个字段此前**不存在**：JS 侧设了 `config.michaelCompression`，serde 默认忽略
    /// 未知字段，于是被静默丢弃 —— 桌面版永远发不出档位头。而客户端因为从 /api/me
    /// 看到了档位，已经关掉了自己的本地压缩和棘轮裁剪。净效果是三处压缩全不生效，
    /// 原始历史每轮整份上传，长会话必然撞穿模型窗口。
    #[serde(default)]
    pub michael_compression: Option<String>,
    /// 上一轮网关签发的前缀引用，本轮原样回发。
    ///
    /// 这条腿决定 2m/5m 能不能真的达到：有它，线路体积正比于**新增内容**；没有它，
    /// 客户端每轮都得上传完整历史，被 `_MODEL_REQUEST_BODY_BYTE_CAP`（3.5MB，约
    /// 875k token）卡死，5M 档在物理上不可达。
    #[serde(default)]
    pub mc_prefix: Option<String>,
    /// 与 mc_prefix 一起回发的覆盖条数，服务端用它校验客户端裁剪口径。
    #[serde(default)]
    pub mc_prefix_covered: Option<usize>,
    /// User-local wall-clock context. The IANA name is a label; the bounded
    /// offset is the source of truth for the current instant (including DST).
    #[serde(default)]
    pub ide_timezone: Option<String>,
    #[serde(default)]
    pub ide_utc_offset_minutes: Option<i16>,
}

/// Streamed back to the frontend over a Tauri channel as the model responds.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Token {
        delta: String,
    },
    /// Streamed model "thinking" (reasoning_content) — shown as a collapsible card.
    Reasoning {
        delta: String,
    },
    /// `index` lets the frontend reassemble a tool call whose `id`/`name` arrive
    /// in the first delta while `arguments` stream across later deltas (the
    /// OpenAI streaming contract). Multiple parallel tool calls are told apart
    /// by their index.
    ToolCall {
        index: u32,
        id: String,
        name: String,
        arguments: String,
    },
    /// 网关本轮签发的 michael-compression 前缀引用。前端存下来，下一轮通过
    /// `config.mcPrefix` 回发，从而只上传新增消息。
    CompressionPrefix {
        token: String,
        /// 开头 system 块**之后**已被摘要覆盖的消息条数。
        ///
        /// 少了这个数客户端就不知道该省略前几条，只能整份重传 —— 既撞 3.5MB 字节上限
        /// （5M 档因此不可达），又会让早期内容同时以摘要和原文出现、上下文重复膨胀。
        covered: usize,
    },
    /// Internal timing breadcrumbs for diagnosing "not really streaming" reports.
    /// These are separate from real progress: response headers and raw chunks can
    /// prove the transport is alive without proving the model has emitted usable
    /// reasoning/content/tool arguments yet.
    StreamMetric {
        phase: String,
        elapsed_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
    /// Why the model stopped generating, normalized onto the OpenAI vocabulary
    /// (`stop` | `length` | `tool_calls` | `content_filter` | …).
    ///
    /// This is the ONLY authoritative signal that a response was cut off by the
    /// output-token limit. It was previously never parsed at all, which left the
    /// client's truncation guard with nothing but a JSON-shape heuristic — and that
    /// heuristic cannot tell a tool-call argument object that was cut mid-stream from
    /// one that is genuinely complete, because a truncated object can still be a valid
    /// JSON *prefix*. A `write_file` whose `content` was severed by `max_tokens` is
    /// exactly the case that must never reach execution.
    FinishReason {
        reason: String,
    },
    Done,
    /// Token accounting from the final stream chunk — lets the UI show how much of
    /// the prompt was served from cache (the payoff of the prompt-cache work).
    ///
    /// `prompt_tokens` is normalized to the tokens the model actually read this turn,
    /// cache included, so the frontend can use it as the context reading without
    /// knowing which provider shape produced it. `cached_tokens`/`cache_creation_tokens`
    /// are the breakdown of that total, not extras to be added to it.
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        cached_tokens: u32,
        cache_creation_tokens: u32,
        /// 这一轮模型**真的**花在思考上的 token 数。
        ///
        /// 前端一直有消费方（_recordUsage 读 completion_tokens_details.reasoning_tokens，
        /// 上下文环里显示「思考 高 · 推理 1.2k」），但这个字段从来没被传上去过——于是
        /// 那半句永远不显示，用户拨了深度也看不到任何回执，"思考深度都和假的一样"这句
        /// 抱怨里有一半是这么来的：不是没生效，是没有任何东西证明它生效了。
        /// 0 表示上游没报这个数（≠ 一定没思考）。
        reasoning_tokens: u32,
        /// 网关在 Anthropic 线路上补的思考**字符**数。那条路的上游根本不报思考 token
        /// （思考算进 output_tokens），所以 reasoning_tokens 恒为 0；字符数是那边唯一
        /// 真实可核对的思考量。两个数各显示各的，前端不拿它冒充 token。
        thinking_chars: u32,
    },
    Error {
        message: String,
    },
}

/// Call any OpenAI-compatible `/chat/completions` endpoint with streaming.
///
/// Tokens are pushed to `on_event` as they arrive so the UI can render the
/// answer incrementally. Works with OpenAI, Azure/OpenAI-compatible gateways,
/// and local servers such as Ollama (`http://localhost:11434/v1`).
#[tauri::command]
pub async fn ai_chat(
    config: AiConfig,
    messages: Vec<serde_json::Value>,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    // `messages` is forwarded verbatim, so a user turn's `content` may be a plain
    // string or a multimodal array (`[{type:"text",...},{type:"image_url",...}]`).
    ai_chat_inner(config, messages, None, on_event).await
}

/// One-shot, non-streaming completion for in-editor AI (the Cmd+K inline editor).
/// Returns the assistant message content as a plain string. `max_tokens` is
/// bounded by the caller so the rewrite stays fast.
#[tauri::command]
pub async fn ai_complete(
    config: AiConfig,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
) -> Result<serde_json::Value, String> {
    let wire = crate::protocol::Wire::of(config.protocol.as_deref());
    let url = crate::protocol::endpoint_url(wire, &config.base_url)?;
    let cancel_id = cancellation_id(&config);
    let cancel_flag = cancel_id.as_deref().map(register_cancel);
    let _cancel_guard = cancel_id.map(CancelGuard);
    // 一律走 SSE。中转对**同步**请求是整段生成完才回：用户控制台里这些请求的类型写着
    // "同步"，网关日志侧量到 upstream_header_ms 8~40 秒、而 headers 一到正文就全在——
    // 正是那个形状。这条路径每轮要跑好几次（意图裁决、快速路由、工具重排），是等待的大头。
    let payload = serde_json::json!({
        "model": config.model,
        "stream": true,
        "max_tokens": max_tokens,
        "temperature": config.temperature.unwrap_or(0.1),
        "messages": messages,
    });
    // 非 OpenAI 协议下形状要翻；默认 openai 时 translate_request 是恒等变换。
    let payload = crate::protocol::translate_request(wire, &payload)?;

    let client = &*HTTP;
    let completion_timeout = StreamTimeouts::for_config(&config).response_headers;
    let resp = post_chat_once(
        client,
        &url,
        &config,
        &payload,
        completion_timeout,
        cancel_flag.as_deref(),
    )
    .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = read_ai_error_body_cancellable(resp, cancel_flag.as_deref()).await?;
        return Err(format_ai_http_error(status, &text));
    }

    // 流式回来的是一串增量，拼回完整文本再返回。
    //
    // 返回值从裸字符串改成 { text, finishReason }：finish_reason 是**唯一**能分清
    // 「模型什么都没产出」和「产到一半被预算截断」的信号，而这两种在能力账本上都记成
    // fail、修法却完全不同（前者切小输入面，后者补齐收尾）。带工具的那条流早就在解析
    // 它了，只有这条一直把它扔掉。客户端两种形状都认（旧构建回字符串），所以这是加法。
    let (content, finish) = read_sse_text(
        resp,
        StreamTimeouts::for_config(&config).stall.max(Duration::from_secs(120)),
        cancel_flag.as_deref(),
    )
    .await?;
    Ok(serde_json::json!({ "text": content, "finishReason": finish }))
}

/// Tool-enabled chat. `messages` is forwarded verbatim to the provider, so the
/// frontend can send the full OpenAI shape — assistant turns carrying
/// `tool_calls` and `{"role":"tool","tool_call_id":...}` results — which is what
/// makes a real multi-turn agent loop possible.
#[tauri::command]
pub async fn ai_chat_with_tools(
    config: AiConfig,
    messages: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    ai_chat_inner(config, messages, Some(tools), on_event).await
}

/// 自定义模型能选的协议，连同**每条协议翻译不了的能力**。
///
/// 界面的协议下拉必须从这里取，而不是自己再抄一份字符串：抄一份的下场是新增协议时
/// 只改一半，而「下拉里有、后端不认」的表现是静默退回 OpenAI —— 用户填了 Anthropic
/// 地址，请求却打到 /chat/completions，报回来的是一句 404，看着像地址填错了。
///
/// `unsupported` 是「不许假装支持」那条铁律的落点：这几句要原样显示在下拉旁边。
#[tauri::command]
pub fn ai_protocols() -> Vec<serde_json::Value> {
    crate::protocol::PROTOCOLS
        .iter()
        .map(|id| {
            let wire = crate::protocol::Wire::of(Some(id));
            serde_json::json!({
                "id": wire.id(),
                "label": wire.label(),
                "unsupported": wire.unsupported(),
            })
        })
        .collect()
}

fn ai_error_detail_from_body(body: &str) -> String {
    let raw = body.trim();
    if raw.is_empty() {
        return "empty response body".into();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(s) = v.get("error").and_then(|e| e.as_str()) {
            return s.trim().to_string();
        }
        if let Some(s) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return s.trim().to_string();
        }
        if let Some(s) = v.get("message").and_then(|m| m.as_str()) {
            return s.trim().to_string();
        }
        if let Some(s) = v.get("detail").and_then(|m| m.as_str()) {
            return s.trim().to_string();
        }
        if let Some(code) = v
            .get("error")
            .and_then(|e| e.get("code"))
            .or_else(|| v.get("code"))
            .and_then(|c| {
                c.as_str()
                    .map(str::to_string)
                    .or_else(|| c.as_i64().map(|n| n.to_string()))
            })
        {
            return format!("error code: {code}");
        }
    }
    raw.to_string()
}

fn format_ai_http_error(status: reqwest::StatusCode, body: &str) -> String {
    format!(
        "AI request failed ({status}): {}",
        ai_error_detail_from_body(body)
    )
}

async fn read_ai_error_body(response: reqwest::Response) -> String {
    read_ai_error_body_with_limits(
        response,
        AI_ERROR_BODY_READ_TIMEOUT,
        MAX_AI_ERROR_BODY_BYTES,
    )
    .await
}

async fn read_ai_error_body_cancellable(
    response: reqwest::Response,
    cancel: Option<&AtomicBool>,
) -> Result<String, String> {
    let read = read_ai_error_body(response);
    tokio::pin!(read);
    loop {
        if request_was_cancelled(cancel) {
            return Err(CANCELLED_AI_REQUEST.to_string());
        }
        match tokio::time::timeout(CANCEL_POLL, &mut read).await {
            Ok(body) => return Ok(body),
            Err(_) => continue,
        }
    }
}

/// 读一条 **SSE** 流并拼回完整文本。
///
/// 为什么不再用同步（`stream:false`）请求：中转（Sub2API 这类）对同步请求是**整段生成完
/// 才回**——用户的控制台里这些请求类型写着"同步"，而网关日志量到的 upstream_header_ms
/// 是 8~40 秒，`first_upstream_chunk_after_headers_ms` 恒为 0，正是这个形状。改成 SSE 之后
/// 首字节由上游边生成边发，同一批调用的等待肉眼可见地短。
///
/// 两种帧都要认：走 OpenAI 形状的中转发 `choices[0].delta.content`，走原生 Anthropic 的
/// 发 `content_block_delta` + `delta.text`（网关对 Claude 路由用的就是后者）。只认一种，
/// 另一种就会拼出空字符串——而且不报错，表现成"模型什么都没回"。
async fn read_sse_text(
    response: reqwest::Response,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<(String, String), String> {
    use futures_util::StreamExt;
    let deadline = Instant::now() + timeout;
    let mut stream = response.bytes_stream();
    // 按**原始字节**攒，不按解码后的字符串：一个多字节 UTF-8 字符可能被切在两个网络包
    // 之间，逐包解码会把它变成 �。SSE 以 '\n' 分行，而这个字节不会出现在多字节序列内部。
    let mut buf: Vec<u8> = Vec::new();
    let mut out = String::new();
    let mut saw_done = false;
    // 顺带把 finish_reason 带回去。它是**唯一**能分清「模型什么都没产出」和「产到一半被
    // 预算截断」的信号——这两种在账本上都表现为 fail，可修法完全不同：前者要切小输入面，
    // 后者要补齐收尾。这条流本来就在逐行解析 SSE，取它零成本；带工具的那条流早就在解析
    // 它了，只有 ai_complete 这条一直把它扔掉。
    let mut finish: String = String::new();
    // 兜底用的原文副本：有的中转**无视 stream:true**，直接回一个普通 JSON body。没有这条
    // 兜底，那些线路会整条失效（报"流提前结束"），而用户看到的是这个模型彻底不能用。
    let mut raw: Vec<u8> = Vec::new();
    const MAX_RAW_FALLBACK: usize = 512 * 1024;
    loop {
        if request_was_cancelled(cancel) {
            return Err(CANCELLED_AI_REQUEST.to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("AI stream timed out".to_string());
        }
        let next = match tokio::time::timeout(remaining.min(CANCEL_POLL), stream.next()).await {
            Ok(next) => next,
            Err(_) => continue, // 只是轮询取消用的短超时，不是真超时
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| error.to_string())?;
        buf.extend_from_slice(&chunk);
        if raw.len() < MAX_RAW_FALLBACK {
            let room = MAX_RAW_FALLBACK - raw.len();
            raw.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
        let mut consumed = 0usize;
        while let Some(rel) = buf[consumed..].iter().position(|&b| b == b'\n') {
            let line_end = consumed + rel;
            let line_bytes = &buf[consumed..=line_end];
            consumed = line_end + 1;
            let Ok(line) = std::str::from_utf8(line_bytes) else {
                return Err("AI stream contains invalid UTF-8 SSE data".to_string());
            };
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                saw_done = true;
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue; // 心跳/注释/半截帧：跳过，别把整轮判失败
            };
            if let Some(fr) = v["choices"][0]["finish_reason"].as_str() {
                if !fr.is_empty() {
                    finish = normalize_finish_reason(fr).to_string();
                }
            }
            if v["type"] == "message_delta" {
                // Anthropic 原生把停止原因放在这里，不在 choices 里。少了这一句，走原生
                // 端点的 Cmd+K 分不清「模型没产出」和「被 max_tokens 砍断」。
                if let Some(sr) = v["delta"]["stop_reason"].as_str().filter(|s| !s.is_empty()) {
                    finish = normalize_finish_reason(sr).to_string();
                }
            }
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                out.push_str(t);
            } else if v["type"] == "content_block_delta" {
                if let Some(t) = v["delta"]["text"].as_str() {
                    out.push_str(t);
                }
            } else if v["type"] == "response.output_text.delta" {
                // xAI Responses 的正文增量。不认它，这条路上的一次性补全会拼出空串 ——
                // 而且不报错，表现成「模型什么都没回」。
                if let Some(t) = v["delta"].as_str() {
                    out.push_str(t);
                }
            }
            // Anthropic 用 message_stop、xAI Responses 用 response.completed 收流，两者都
            // **不发 `[DONE]`**。少了这一句，唯一的完整性判据是下面那句 `!saw_done &&
            // out.is_empty()` —— 它只在**空**的时候报错，于是一段被中途截断的非空回答会被
            // 当成一次完整的短回答，交给 Cmd+K / 意图裁决 / 快速路由。不报错，只是答得短。
            if v["type"] == "message_stop"
                || v["type"] == "response.completed"
                || v["type"] == "response.incomplete"
            {
                // xAI Responses 的停止原因既不在 choices 里也不在 delta 里，而在这一帧的
                // response.status / incomplete_details.reason 上。不认它，这条路上的
                // finishReason 恒为空串 —— 而它是**唯一**能分清「模型什么都没产出」和
                // 「产到一半被输出预算截断」的信号，_billableAiComplete 的补余量重试
                // （_finish(out) === "length"）就永远不触发，表现成「这个模型答得就是短」。
                //
                // 判据和 protocol.rs 那条流式解码逐字同源（见
                // xai_truncated_response_reports_length_not_stop）：先看
                // incomplete_details.reason == "max_output_tokens"，再退到帧类型本身。
                if finish.is_empty() {
                    if v.pointer("/response/incomplete_details/reason").and_then(serde_json::Value::as_str)
                        == Some("max_output_tokens")
                        || v["type"] == "response.incomplete"
                    {
                        finish = "length".to_string();
                    } else if v["type"] == "response.completed" {
                        finish = "stop".to_string();
                    }
                }
                saw_done = true;
            }
        }
        if consumed > 0 {
            buf.drain(..consumed);
        }
        if saw_done {
            break;
        }
    }
    if !saw_done && out.is_empty() {
        // 一帧 SSE 都没有 → 大概率是中转把 stream 忽略了，按普通补全响应再解一次。
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
            if let Some(t) = v["choices"][0]["message"]["content"].as_str() {
                return Ok((t.to_string(), String::new()));
            }
            if let Some(t) = v["content"][0]["text"].as_str() {
                return Ok((t.to_string(), String::new()));
            }
        }
        return Err(INCOMPLETE_SSE_STREAM_ERROR.to_string());
    }
    Ok((out, finish))
}

async fn read_ai_completion_body(
    response: reqwest::Response,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + timeout;
    let read = response.json::<serde_json::Value>();
    tokio::pin!(read);
    loop {
        if request_was_cancelled(cancel) {
            return Err(CANCELLED_AI_REQUEST.to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("AI completion timed out reading the response body".to_string());
        }
        match tokio::time::timeout(remaining.min(CANCEL_POLL), &mut read).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) if deadline.saturating_duration_since(Instant::now()).is_zero() => {
                return Err("AI completion timed out reading the response body".to_string());
            }
            Err(_) => continue,
        }
    }
}

async fn read_ai_error_body_with_limits(
    mut response: reqwest::Response,
    timeout: Duration,
    max_bytes: usize,
) -> String {
    let read = async move {
        let capacity = response
            .content_length()
            .unwrap_or_default()
            .min(max_bytes as u64) as usize;
        let mut body = Vec::with_capacity(capacity);
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            let remaining = max_bytes.saturating_sub(body.len());
            if chunk.len() > remaining {
                body.extend_from_slice(&chunk[..remaining]);
                break;
            }
            body.extend_from_slice(&chunk);
        }
        Ok::<Vec<u8>, String>(body)
    };

    match tokio::time::timeout(timeout, read).await {
        Ok(Ok(body)) => String::from_utf8_lossy(&body).into_owned(),
        Ok(Err(error)) => format!("failed to read AI error response body: {error}"),
        Err(_) => format!(
            "timed out reading AI error response body after {} seconds",
            duration_seconds_label(timeout)
        ),
    }
}

/// Normalize an OpenAI-compatible chat endpoint. Users usually paste a base URL
/// such as `https://api.openai.com/v1`, but many paste the provider root
/// (`https://api.openai.com`) or a full `/chat/completions` URL. Accept all three
/// shapes so BYOK does not fail for a harmless missing `/v1`.
fn chat_completions_url(base_url: &str) -> Result<String, String> {
    // 归一化逻辑整段搬进了 protocol.rs 的 OpenAI 分支（一个分支都没改），这样
    // 「协议 → 端点」只有一处判据。下面那几条既有断言现在钉的就是那一段。
    crate::protocol::endpoint_url(crate::protocol::Wire::OpenAi, base_url)
}

/// Relay the optional L0 server-side-assembly headers. When the JS side set
/// `ideMode`/`ideTools` (the default-off anti-reverse path), the gateway reads these
/// and injects the system prompt + tool schemas itself; when unset, the builder is
/// returned untouched so the request is byte-for-byte identical to before.
fn with_ide_headers(rb: reqwest::RequestBuilder, config: &AiConfig) -> reqwest::RequestBuilder {
    let mut rb = rb;
    // 自带上游：原样转成三个头。合法性由网关判（见 AiConfig::byo_base 的说明）。
    // 密钥只在这一跳的头里出现，不落日志、不落盘。
    if let Some(base) = config.byo_base.as_deref().filter(|v| !v.trim().is_empty()) {
        rb = rb.header("x-ide-byo-base", base.trim());
        if let Some(key) = config.byo_key.as_deref().filter(|v| !v.trim().is_empty()) {
            rb = rb.header("x-ide-byo-key", key.trim());
        }
        if let Some(proto) = config.byo_proto.as_deref().filter(|v| !v.trim().is_empty()) {
            rb = rb.header("x-ide-byo-proto", proto.trim());
        }
    }
    if let Some(request_id) = config.request_id.as_deref().filter(|value| {
        (8..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        rb = rb.header("x-ide-request-id", request_id);
    }
    if let Some(run_id) = config.ide_run_id.as_deref().filter(|value| {
        (8..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        rb = rb.header("x-ide-run-id", run_id);
    }
    // 会话级亲和键。网关拿它把同一段对话路由回同一台上游机器 —— run id 是每条用户
    // 消息新造的，只有它稳得住整段会话。校验和 run id 逐字一致。
    if let Some(session_id) = config.ide_session_id.as_deref().filter(|value| {
        (8..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        rb = rb.header("x-ide-session-id", session_id);
    }
    // 只校验它是合法 base64 字符集且有界：内容是用户原话，网关那边解码后自己再截。
    if let Some(goal) = config.ide_session_goal.as_deref().filter(|value| {
        !value.is_empty()
            && value.len() <= 8192
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    }) {
        rb = rb.header("x-ide-session-goal", goal);
    }
    if let Some(step_index) = config
        .ide_step_index
        .filter(|value| (0..=10_000).contains(value))
    {
        rb = rb.header("x-ide-step-index", step_index.to_string());
    }
    if let Some(step_kind) = config.ide_step_kind.as_deref().filter(|value| {
        matches!(
            *value,
            "intent" | "main" | "aux" | "subagent" | "repair" | "learning" | "chat"
        )
    }) {
        rb = rb.header("x-ide-step-kind", step_kind);
    }
    if config.ide_power_route == Some(true) {
        rb = rb.header("x-ide-power-route", "1");
    }
    if let Some(rid) = config
        .ide_route_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 64)
    {
        rb = rb.header("x-ide-route", rid);
    }
    if let Some(w) = config
        .ide_context_window
        .filter(|n| (1_000..=20_000_000).contains(n))
    {
        rb = rb.header("x-ide-context-window", w.to_string());
    }
    if let Some(m) = config.ide_mode.as_deref().filter(|s| !s.is_empty()) {
        rb = rb.header("x-ide-mode", m);
    }
    if let Some(t) = config.ide_tools.as_deref().filter(|s| !s.is_empty()) {
        rb = rb.header("x-ide-tools", t);
    }
    if let Some(profile) = config.ide_semantic_profile.as_deref().filter(|profile| {
        profile.starts_with("2.5:")
            && profile.len() <= 1024
            && profile.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b':' | b',' | b'_')
            })
    }) {
        rb = rb.header("x-ide-semantic-profile", profile);
    }
    if let Some(region) = config.ide_region.as_deref().filter(|region| {
        (2..=8).contains(&region.len()) && region.bytes().all(|byte| byte.is_ascii_lowercase())
    }) {
        rb = rb.header("x-ide-region", region);
    }
    // 只放行已知档位。网关侧还会按会员套餐再钳一次，这里的白名单是防止把任意字符串
    // 当档位发出去。
    if let Some(tier) = config
        .michael_compression
        .as_deref()
        .map(str::trim)
        .filter(|s| matches!(*s, "1m" | "2m" | "5m"))
    {
        rb = rb.header("x-michael-compression", tier);
    }
    if let Some(zone) = config.ide_timezone.as_deref().filter(|zone| {
        !zone.is_empty()
            && zone.len() <= 64
            && zone.bytes().all(|ch| {
                ch.is_ascii_alphanumeric() || matches!(ch, b'/' | b'_' | b'-' | b'+' | b'.')
            })
    }) {
        rb = rb.header("x-ide-timezone", zone);
    }
    if let Some(offset) = config
        .ide_utc_offset_minutes
        .filter(|offset| (-840..=840).contains(offset))
    {
        rb = rb.header("x-ide-utc-offset-minutes", offset.to_string());
    }
    rb
}

#[derive(Debug, Clone, Copy)]
struct ResponseHeadersDeadline {
    started: Instant,
    at: Instant,
    budget: Duration,
    unix_ms: u64,
}

impl ResponseHeadersDeadline {
    fn new(started: Instant, budget: Duration) -> Self {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .saturating_add(budget.as_millis())
            .min(u64::MAX as u128) as u64;
        Self {
            started,
            at: started + budget,
            budget,
            unix_ms,
        }
    }

    fn remaining(self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    fn timeout_error(self) -> String {
        response_headers_timeout_error(self.budget, self.started.elapsed())
    }
}

fn with_response_deadline_header(
    request: reqwest::RequestBuilder,
    deadline: ResponseHeadersDeadline,
) -> reqwest::RequestBuilder {
    request
        .header(RESPONSE_DEADLINE_HEADER, deadline.unix_ms.to_string())
        .header(
            RESPONSE_BUDGET_HEADER,
            deadline
                .budget
                .as_millis()
                .min(u64::MAX as u128)
                .to_string(),
        )
}

fn request_was_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::SeqCst))
}

/// Send one physical model request and return its first HTTP response or transport
/// error. A failure is terminal for this turn; the desktop and browser paths never
/// replay the same prompt automatically.
async fn post_chat_once(
    client: &reqwest::Client,
    url: &str,
    config: &AiConfig,
    payload: &serde_json::Value,
    response_headers_timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<reqwest::Response, String> {
    if request_was_cancelled(cancel) {
        return Err(CANCELLED_AI_REQUEST.to_string());
    }
    let deadline = ResponseHeadersDeadline::new(Instant::now(), response_headers_timeout);
    let mut request = with_response_deadline_header(
        with_ide_headers(client.post(url).bearer_auth(&config.api_key), config),
        deadline,
    );
    // 协议要求的**附加**鉴权头。OpenAI（默认，含全部存量自定义模型）返回空表 ——
    // 上面那行 `.bearer_auth()` 一个字节不动，请求逐字节和以前相同。
    // Anthropic 要 x-api-key + anthropic-version：少了后者是硬 400，而只发
    // Authorization 会让认 anthropic 口径的中转报「密钥被拒」，看着像密钥坏了。
    for (name, value) in crate::protocol::extra_auth_headers(
        crate::protocol::Wire::of(config.protocol.as_deref()),
        &config.api_key,
    ) {
        request = request.header(name, value);
    }
    send_with_response_headers_deadline(request.json(payload), deadline, cancel).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StreamTimeouts {
    response_headers: Duration,
    first_progress: Duration,
    empty_stream: Duration,
    stall: Duration,
    /// 有字节在流动时的内容停滞上限，见 STANDARD_CONTENT_BACKSTOP_SECS。
    content_backstop: Duration,
}

impl StreamTimeouts {
    fn for_config(config: &AiConfig) -> Self {
        Self::for_config_with_env(config, |name| std::env::var(name).ok())
    }

    fn for_config_with_env<F>(config: &AiConfig, read_env: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        let effort = config
            .reasoning_effort
            .as_deref()
            .unwrap_or_default()
            .trim();
        // UI 档位原值：Gemini-3/Kimi/GLM 等家族只发 thinking/thinkingConfig 不发
        // reasoning_effort，此前 serde 直接丢掉 thinkingEffort → 全部掉进 35s/18s 标准窗。
        let ui_effort = config.thinking_effort.as_deref().unwrap_or_default().trim();
        let thinking_enabled = config
            .thinking
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(|value| value.as_str())
            .is_some_and(|kind| {
                kind.eq_ignore_ascii_case("enabled") || kind.eq_ignore_ascii_case("adaptive")
            })
            || config.thinking_config.is_some();
        let has_thinking_budget = config.thinking_budget.is_some_and(|budget| budget > 0);
        let deep =
            |value: &str| value.eq_ignore_ascii_case("max") || value.eq_ignore_ascii_case("xhigh");
        // xhigh 与 max 同档：gpt-5.6 系把 xhigh 原样透传，此前它掉进 35s 标准窗——深度思考
        // 本身就是长时间无输出，窗口太短会被无进度看门狗掐掉再重试，用户设的思考深度形同虚设。
        let defaults = if has_thinking_budget || deep(effort) || deep(ui_effort) {
            (
                RESPONSE_HEADERS_TIMEOUT_SECS,
                EXTENDED_FIRST_STREAM_PROGRESS_TIMEOUT_SECS,
                EXTENDED_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS,
                EXTENDED_STREAM_STALL_TIMEOUT_SECS,
                THINKING_CONTENT_BACKSTOP_SECS,
            )
        } else if effort.eq_ignore_ascii_case("high")
            || ui_effort.eq_ignore_ascii_case("high")
            || thinking_enabled
        {
            (
                RESPONSE_HEADERS_TIMEOUT_SECS,
                HIGH_FIRST_STREAM_PROGRESS_TIMEOUT_SECS,
                HIGH_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS,
                HIGH_STREAM_STALL_TIMEOUT_SECS,
                THINKING_CONTENT_BACKSTOP_SECS,
            )
        } else {
            (
                RESPONSE_HEADERS_TIMEOUT_SECS,
                STANDARD_FIRST_STREAM_PROGRESS_TIMEOUT_SECS,
                STANDARD_EMPTY_STREAM_PROGRESS_TIMEOUT_SECS,
                STANDARD_STREAM_STALL_TIMEOUT_SECS,
                STANDARD_CONTENT_BACKSTOP_SECS,
            )
        };

        Self {
            response_headers: Duration::from_secs(defaults.0),
            first_progress: bounded_timeout_from_env(
                read_env(FIRST_STREAM_PROGRESS_TIMEOUT_ENV),
                defaults.1,
                FIRST_STREAM_PROGRESS_TIMEOUT_MIN_SECS,
                FIRST_STREAM_PROGRESS_TIMEOUT_MAX_SECS,
            ),
            empty_stream: bounded_timeout_from_env(
                read_env(EMPTY_STREAM_PROGRESS_TIMEOUT_ENV),
                defaults.2,
                EMPTY_STREAM_PROGRESS_TIMEOUT_MIN_SECS,
                EMPTY_STREAM_PROGRESS_TIMEOUT_MAX_SECS,
            ),
            stall: bounded_timeout_from_env(
                read_env(STREAM_STALL_TIMEOUT_ENV),
                defaults.3,
                STREAM_STALL_TIMEOUT_MIN_SECS,
                STREAM_STALL_TIMEOUT_MAX_SECS,
            ),
            content_backstop: Duration::from_secs(defaults.4),
        }
    }
}

fn bounded_timeout_from_env(
    raw: Option<String>,
    default_secs: u64,
    min_secs: u64,
    max_secs: u64,
) -> Duration {
    let seconds = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(min_secs, max_secs))
        .unwrap_or(default_secs);
    Duration::from_secs(seconds)
}

fn duration_seconds_label(duration: Duration) -> String {
    if duration.subsec_nanos() == 0 {
        return duration.as_secs().to_string();
    }
    let seconds = format!("{:.3}", duration.as_secs_f64());
    seconds
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn response_headers_timeout_error(timeout: Duration, elapsed: Duration) -> String {
    format!(
        "AI request timed out waiting for response headers after {} seconds (per-attempt {}-second deadline)",
        duration_seconds_label(elapsed.min(timeout)),
        duration_seconds_label(timeout),
    )
}

#[cfg(test)]
async fn send_with_response_headers_timeout(
    request: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let deadline = ResponseHeadersDeadline::new(Instant::now(), timeout);
    send_with_response_headers_deadline(request, deadline, None).await
}

async fn send_with_response_headers_deadline(
    request: reqwest::RequestBuilder,
    deadline: ResponseHeadersDeadline,
    cancel: Option<&AtomicBool>,
) -> Result<reqwest::Response, String> {
    let send = request.send();
    tokio::pin!(send);
    loop {
        if request_was_cancelled(cancel) {
            return Err(CANCELLED_AI_REQUEST.to_string());
        }
        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return Err(deadline.timeout_error());
        }
        match tokio::time::timeout(remaining.min(CANCEL_POLL), &mut send).await {
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) if deadline.remaining().is_zero() => return Err(deadline.timeout_error()),
            Err(_) => continue,
        }
    }
}

#[derive(Debug)]
struct StreamProgressDeadline {
    last_progress: Instant,
    /// 最后一次收到任何字节的时刻（含心跳）。区分"连接死了"和"模型没在吐字"。
    last_byte: Instant,
    first_activity: Option<Instant>,
    has_progress: bool,
    timeouts: StreamTimeouts,
}

impl StreamProgressDeadline {
    fn new(now: Instant, timeouts: StreamTimeouts) -> Self {
        Self {
            last_progress: now,
            last_byte: now,
            first_activity: None,
            has_progress: false,
            timeouts,
        }
    }

    fn record_activity(&mut self, now: Instant) {
        if self.first_activity.is_none() {
            self.first_activity = Some(now);
        }
    }

    /// 任何原始字节——**包括 SSE 心跳注释**。它只回答"连接还通不通"，
    /// 不回答"模型有没有在产出"，这正是它和 record() 的分工。
    fn record_bytes(&mut self, now: Instant) {
        self.last_byte = now;
    }

    fn record(&mut self, now: Instant) {
        self.last_progress = now;
        self.has_progress = true;
    }

    fn record_delta(&mut self, delta: &serde_json::Value, now: Instant) -> bool {
        if !delta_has_real_progress(delta) {
            return false;
        }
        self.record(now);
        true
    }

    fn limit_and_anchor(&self, now: Instant) -> (Duration, Instant) {
        if self.has_progress {
            // 活性和产出是两个问题，混成一个就会掐掉健康的流。
            //
            // 网关每 15 秒推一次 SSE 心跳，而心跳是 SSE **注释**、没有 data 负载，永远走不到
            // record()。于是一个正在憋大段 write_file 参数、或者单纯在想的模型，会被客户端
            // 判成"连接中断"——而字节其实一直在到。浏览器那条路早就修过这一层
            // （main.js 的 LIVENESS_MS / CONTENT_BACKSTOP_MS），桌面端这条一直没有，
            // 用户实拍的 90 秒掐断走的正是这里。
            let heartbeat_alive =
                now.duration_since(self.last_byte) < Duration::from_secs(STREAM_LIVENESS_SECS);
            let limit = if heartbeat_alive {
                self.timeouts.stall.max(self.timeouts.content_backstop)
            } else {
                self.timeouts.stall
            };
            (limit, self.last_progress)
        } else {
            // Response headers, SSE comments, and empty control frames do not buy
            // another timeout window. One physical attempt has sixty seconds from
            // request start to its first real reasoning/text/tool event.
            (self.timeouts.first_progress, self.last_progress)
        }
    }

    fn remaining(&self, now: Instant) -> Option<Duration> {
        let (limit, anchor) = self.limit_and_anchor(now);
        let elapsed = now.duration_since(anchor);
        (elapsed < limit).then(|| limit - elapsed)
    }

    fn error_message(&self, now: Instant) -> String {
        let (limit, _) = self.limit_and_anchor(now);
        let seconds = duration_seconds_label(limit);
        if self.has_progress {
            format!("模型连续 {seconds} 秒没有继续生成有效内容，已停止本轮，请重试。")
        } else if self.first_activity.is_some() {
            format!("上游已开始流式传输，但 {seconds} 秒内没有生成有效内容，已停止本轮，请重试。")
        } else {
            format!("模型在 {seconds} 秒内没有生成有效内容，已停止本轮，请重试。")
        }
    }
}

fn delta_has_real_progress(delta: &serde_json::Value) -> bool {
    // 思考形状走同一个取文本函数（见 reasoning_text_from_delta）。
    //
    // 这里原来也是「只认两个字符串字段」。它比渲染那处更隐蔽：这个谓词喂的是**停滞
    // 看门狗**——上游正一段段回思考、但形状是对象或 reasoning_details 数组时，
    // 这里判成"没有有效内容"，看门狗数着秒把一条**正在正常思考**的流掐掉，
    // 报给用户的是「模型在 N 秒内没有生成有效内容」。两处必须用同一份判据。
    reasoning_text_from_delta(delta).is_some_and(|text| !text.is_empty())
        || delta["content"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        || delta["tool_calls"].as_array().is_some_and(|calls| {
            calls.iter().any(|call| {
                call["id"].as_str().is_some_and(|value| !value.is_empty())
                    || call["function"]["name"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
                    || call["function"]["arguments"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            })
        })
}

/// Anthropic's native Messages stream uses top-level event objects instead of
/// OpenAI's `choices[].delta`. A gateway normally converts these, but accepting
/// the native events here keeps a direct Anthropic-compatible route from losing
/// the visible reasoning/text stream.
fn native_anthropic_event_has_real_progress(event: &serde_json::Value) -> bool {
    match event["type"].as_str() {
        Some("content_block_start") => {
            event["content_block"]["type"].as_str() == Some("tool_use")
                && (event["content_block"]["id"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                    || event["content_block"]["name"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty()))
        }
        Some("content_block_delta") => match event["delta"]["type"].as_str() {
            Some("thinking_delta") => event["delta"]["thinking"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            Some("text_delta") => event["delta"]["text"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            Some("input_json_delta") => event["delta"]["partial_json"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            _ => false,
        },
        _ => false,
    }
}
/// 从一个 OpenAI 风格的 `delta` 里取思考文本，认全已知的几种载荷形状。
///
/// 返回 `None` = 这一帧没有思考内容（不是"取不出来"）。调用方据此决定发不发事件。
fn reasoning_text_from_delta(delta: &serde_json::Value) -> Option<String> {
    /// 一个值里的思考文本：字符串直接用；对象取 text/content/reasoning/summary；
    /// 数组按元素拼接（分片推理）。递归深度天然有界——载荷就这三层。
    fn text_of(v: &serde_json::Value) -> String {
        match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(items) => items.iter().map(text_of).collect(),
            serde_json::Value::Object(map) => ["text", "content", "reasoning", "summary"]
                .iter()
                .find_map(|k| map.get(*k).map(text_of).filter(|s| !s.is_empty()))
                .unwrap_or_default(),
            _ => String::new(),
        }
    }
    for key in ["reasoning_content", "reasoning", "reasoning_details"] {
        let v = &delta[key];
        if v.is_null() {
            continue;
        }
        let t = text_of(v);
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}


/// Map each provider's "why generation stopped" vocabulary onto the OpenAI spelling
/// so the client has exactly one set of values to reason about. Anthropic's native
/// stream reports `max_tokens` / `end_turn` / `tool_use` / `stop_sequence`; everything
/// OpenAI-compatible already uses the target vocabulary and passes through unchanged.
fn normalize_finish_reason(raw: &str) -> &str {
    match raw {
        "max_tokens" => "length",
        "end_turn" | "stop_sequence" => "stop",
        "tool_use" => "tool_calls",
        other => other,
    }
}

fn streamed_tool_call_index(call: &serde_json::Value) -> Result<u32, String> {
    let raw = call["index"]
        .as_u64()
        .ok_or_else(|| "streamed tool call is missing its numeric index".to_string())?;
    u32::try_from(raw).map_err(|_| "streamed tool call index is out of range".to_string())
}

fn elapsed_ms_since(started: Instant) -> u64 {
    let ms = started.elapsed().as_millis();
    u64::try_from(ms).unwrap_or(u64::MAX)
}

fn send_stream_metric(
    on_event: &Channel<AiEvent>,
    started: Instant,
    phase: &str,
    bytes: Option<u64>,
) {
    let _ = on_event.send(AiEvent::StreamMetric {
        phase: phase.to_string(),
        elapsed_ms: elapsed_ms_since(started),
        bytes,
        attempt: None,
        status: None,
    });
}

#[cfg(test)]
mod ide_header_tests {
    use super::*;
    use std::io::{Read, Write};

    fn config() -> AiConfig {
        AiConfig {
            base_url: "https://example.invalid/v1".into(),
            api_key: "test".into(),
            model: "test-model".into(),
            max_tokens: None,
            temperature: None,
            protocol: None,
            // 上一次给 AiConfig 加字段时没跟上，HEAD 的 lib test 整个编不过。
            ide_context_window: None,
            ide_session_id: None,
            ide_session_goal: None,
            reasoning_effort: None,
            thinking_budget: None,
            thinking_effort: None,
            thinking: None,
            thinking_config: None,
            request_id: None,
            cancel_id: None,
            ide_power_route: None,
            ide_route_id: None,
            ide_run_id: None,
            ide_step_index: None,
            ide_step_kind: None,
            ide_mode: Some("agent".into()),
            ide_tools: None,
            ide_semantic_profile: Some("2.5:engineering,design,existing_project".into()),
            ide_region: None,
            michael_compression: None,
            mc_prefix: None,
            mc_prefix_covered: None,
            ide_timezone: Some("America/Los_Angeles".into()),
            ide_utc_offset_minutes: Some(-420),
        }
    }

    #[test]
    fn relays_bounded_user_timezone_headers() {
        let mut cfg = config();
        cfg.request_id = Some("req_12345678".into());
        cfg.ide_run_id = Some("run_12345678".into());
        cfg.ide_step_index = Some(7);
        cfg.ide_step_kind = Some("subagent".into());
        let request = with_ide_headers(reqwest::Client::new().get("https://example.invalid"), &cfg)
            .build()
            .unwrap();
        assert_eq!(request.headers()["x-ide-request-id"], "req_12345678");
        assert_eq!(request.headers()["x-ide-run-id"], "run_12345678");
        assert_eq!(request.headers()["x-ide-step-index"], "7");
        assert_eq!(request.headers()["x-ide-step-kind"], "subagent");
        assert_eq!(
            request.headers()["x-ide-semantic-profile"],
            "2.5:engineering,design,existing_project"
        );
        assert_eq!(request.headers()["x-ide-timezone"], "America/Los_Angeles");
        assert_eq!(request.headers()["x-ide-utc-offset-minutes"], "-420");
    }

    #[test]
    fn cancellation_id_is_independent_from_gateway_settlement_id() {
        let decoded: AiConfig = serde_json::from_value(serde_json::json!({
            "baseUrl": "https://example.invalid/v1",
            "apiKey": "test",
            "model": "test-model",
            "requestId": "req_settlement_123",
            "cancelId": "req_physical_456"
        }))
        .unwrap();
        assert_eq!(decoded.request_id.as_deref(), Some("req_settlement_123"));
        assert_eq!(decoded.cancel_id.as_deref(), Some("req_physical_456"));

        let mut cfg = config();
        cfg.request_id = Some("req_settlement_123".into());
        cfg.cancel_id = Some("req_physical_456".into());

        assert_eq!(cancellation_id(&cfg).as_deref(), Some("req_physical_456"));
        let request = with_ide_headers(reqwest::Client::new().get("https://example.invalid"), &cfg)
            .build()
            .unwrap();
        assert_eq!(request.headers()["x-ide-request-id"], "req_settlement_123");
        assert!(!request.headers().contains_key("x-ide-cancel-id"));

        cfg.cancel_id = None;
        assert_eq!(cancellation_id(&cfg).as_deref(), Some("req_settlement_123"));
    }

    #[test]
    fn drops_invalid_timezone_headers() {
        let mut cfg = config();
        cfg.request_id = Some("bad\nrequest".into());
        cfg.ide_run_id = Some("bad\nrun".into());
        cfg.ide_step_index = Some(-1);
        cfg.ide_step_kind = Some("unknown".into());
        cfg.ide_timezone = Some("bad\ntimezone".into());
        cfg.ide_utc_offset_minutes = Some(900);
        let request = with_ide_headers(reqwest::Client::new().get("https://example.invalid"), &cfg)
            .build()
            .unwrap();
        assert!(!request.headers().contains_key("x-ide-timezone"));
        assert!(!request.headers().contains_key("x-ide-utc-offset-minutes"));
        assert!(!request.headers().contains_key("x-ide-request-id"));
        assert!(!request.headers().contains_key("x-ide-run-id"));
        assert!(!request.headers().contains_key("x-ide-step-index"));
        assert!(!request.headers().contains_key("x-ide-step-kind"));
    }

    #[test]
    fn normalizes_chat_completion_endpoint_shapes() {
        assert_eq!(
            chat_completions_url("https://api.openai.com").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://gateway.example/v1/chat/completions").unwrap(),
            "https://gateway.example/v1/chat/completions"
        );
        assert!(chat_completions_url("api.openai.com/v1").is_err());
    }

    #[test]
    fn ai_http_error_prefers_gateway_json_error_message() {
        let message = format_ai_http_error(
            reqwest::StatusCode::BAD_GATEWAY,
            r#"{"error":"【claude-opus-4-6】上游暂时不可用，请换个模型或稍后再试。"}"#,
        );
        assert_eq!(
            message,
            "AI request failed (502 Bad Gateway): 【claude-opus-4-6】上游暂时不可用，请换个模型或稍后再试。"
        );
    }

    #[test]
    fn ai_http_error_keeps_provider_code_when_no_message_exists() {
        let message = format_ai_http_error(reqwest::StatusCode::BAD_GATEWAY, r#"{"code":502}"#);
        assert_eq!(
            message,
            "AI request failed (502 Bad Gateway): error code: 502"
        );
    }

    #[test]
    fn gateway_transport_keepalive_stays_in_the_background_window() {
        assert!(GATEWAY_TRANSPORT_KEEPALIVE_INTERVAL >= Duration::from_secs(45));
        assert!(GATEWAY_TRANSPORT_KEEPALIVE_INTERVAL <= Duration::from_secs(60));
        assert_eq!(MICHAEL_GATEWAY_HEALTH_URL, "https://code.mrday.one/health");
    }

    #[test]
    fn desktop_reqwest_keeps_http2_enabled() {
        let manifest = include_str!("../Cargo.toml");
        let reqwest = manifest
            .lines()
            .find(|line| line.trim_start().starts_with("reqwest ="))
            .expect("reqwest dependency");
        assert!(reqwest.contains("\"http2\""));
    }

    #[tokio::test]
    async fn gateway_transport_warmup_is_an_anonymous_head_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let read = socket.read(&mut request).unwrap();
            tx.send(String::from_utf8_lossy(&request[..read]).to_string())
                .unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
                )
                .unwrap();
            socket.flush().unwrap();
        });

        let client = reqwest::Client::builder().build().unwrap();
        warm_gateway_transport_once(&client, &format!("http://{address}/health")).await;
        server.join().unwrap();

        let request = rx.recv().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("head /health http/1.1\r\n"));
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("content-length:"));
    }

    #[tokio::test]
    async fn ai_error_body_read_obeys_the_byte_cap() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            let body = "x".repeat(128);
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).unwrap();
            socket.flush().unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        let body = read_ai_error_body_with_limits(response, Duration::from_secs(1), 16).await;
        assert_eq!(body, "x".repeat(16));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn ai_error_body_read_obeys_the_total_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            socket
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 4\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            socket.flush().unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        let started = Instant::now();
        let body = read_ai_error_body_with_limits(response, Duration::from_millis(20), 64).await;
        assert_eq!(
            body,
            "timed out reading AI error response body after 0.02 seconds"
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn non_streaming_completion_relays_request_id() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 32 * 1024];
            let read = socket.read(&mut request).unwrap();
            tx.send(String::from_utf8_lossy(&request[..read]).to_string())
                .unwrap();
            let body = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).unwrap();
            socket.flush().unwrap();
        });

        let mut cfg = config();
        cfg.base_url = format!("http://{address}");
        cfg.request_id = Some("req_nonstream_123".into());
        let result = ai_complete(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            32,
        )
        .await
        .unwrap();
        server.join().unwrap();

        // ai_complete 现在回 { text, finishReason }：finish_reason 是唯一能分清
        // 「模型什么都没产出」和「产到一半被截断」的信号，而这两种的修法完全相反。
        // 这条用例守的是**请求头透传**，那条契约没变；顺带把新形状一起钉住。
        assert_eq!(result["text"], "ok");
        assert!(result.get("finishReason").is_some(), "新形状少了 finishReason 字段");
        let request = rx.recv().unwrap().to_ascii_lowercase();
        assert!(request.contains("x-ide-request-id: req_nonstream_123\r\n"));
    }

    #[tokio::test]
    async fn non_streaming_completion_cancellation_interrupts_header_wait() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(600));
        });

        let request_id = "req_nonstream_cancel_headers_123".to_string();
        let mut cfg = config();
        cfg.base_url = format!("http://{address}");
        cfg.request_id = Some(request_id.clone());
        let task = tokio::spawn(ai_complete(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            32,
        ));
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
            .await
            .unwrap()
            .unwrap();
        let started = Instant::now();
        cancel_ai(request_id.clone());
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, Err(CANCELLED_AI_REQUEST.to_string()));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!CANCELS.lock().unwrap().contains_key(&request_id));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn non_streaming_completion_cancellation_interrupts_body_read() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            let partial = r#"{"choices":["#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: keep-alive\r\n\r\n{partial}"
            );
            socket.write_all(response.as_bytes()).unwrap();
            socket.flush().unwrap();
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(600));
        });

        let request_id = "req_nonstream_cancel_body_123".to_string();
        let mut cfg = config();
        cfg.base_url = format!("http://{address}");
        cfg.request_id = Some(request_id.clone());
        let task = tokio::spawn(ai_complete(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            32,
        ));
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
            .await
            .unwrap()
            .unwrap();
        let started = Instant::now();
        cancel_ai(request_id.clone());
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, Err(CANCELLED_AI_REQUEST.to_string()));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!CANCELS.lock().unwrap().contains_key(&request_id));
        server.join().unwrap();
    }
}

#[cfg(test)]
mod stream_timeout_tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};

    fn config(reasoning_effort: Option<&str>, thinking_budget: Option<u32>) -> AiConfig {
        AiConfig {
            base_url: "https://example.invalid/v1".into(),
            api_key: "test".into(),
            model: "test-model".into(),
            max_tokens: None,
            temperature: None,
            protocol: None,
            // 上一次给 AiConfig 加字段时没跟上，HEAD 的 lib test 整个编不过。
            ide_context_window: None,
            ide_session_id: None,
            ide_session_goal: None,
            reasoning_effort: reasoning_effort.map(str::to_string),
            thinking_budget,
            thinking_effort: None,
            thinking: None,
            thinking_config: None,
            request_id: None,
            cancel_id: None,
            ide_power_route: None,
            ide_route_id: None,
            ide_run_id: None,
            ide_step_index: None,
            ide_step_kind: None,
            ide_mode: None,
            ide_tools: None,
            ide_semantic_profile: None,
            ide_region: None,
            michael_compression: None,
            mc_prefix: None,
            mc_prefix_covered: None,
            ide_timezone: None,
            ide_utc_offset_minutes: None,
        }
    }

    fn timeouts(reasoning_effort: Option<&str>, thinking_budget: Option<u32>) -> StreamTimeouts {
        StreamTimeouts::for_config_with_env(&config(reasoning_effort, thinking_budget), |_| None)
    }

    fn read_http_request(socket: &mut std::net::TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 4096];
            let read = socket.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .or_else(|| line.strip_prefix("Content-Length:"))
                    })
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or_default();
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    /// 把一段 SSE 原文喂给 read_sse_text，拿回它拼出来的完整文本。
    async fn run_sse_text(body: Vec<u8>) -> Result<String, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = socket.read(&mut request);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
            let _ = socket.flush();
        });
        let resp = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        // read_sse_text 现在同时带回 finish_reason；这个夹具只关心正文，取第一项即可。
        read_sse_text(resp, Duration::from_secs(5), None).await.map(|(text, _finish)| text)
    }

    /// 同 run_sse_text，但把 finish_reason 也带回来。
    async fn run_sse_finish(body: Vec<u8>) -> Result<(String, String), String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = socket.read(&mut request);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
            let _ = socket.flush();
        });
        let resp = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        read_sse_text(resp, Duration::from_secs(5), None).await
    }

    /// xAI Responses 的停止原因在 response.status / incomplete_details 上，既不在 choices
    /// 里也不在 delta 里。不认它，finishReason 恒为空串 —— 而 _billableAiComplete 的
    /// 「补余量重试」只认 "length"，于是被输出预算截断的辅助回答永远不会被重试，
    /// 表现成「这个模型答得就是短」，不报错。
    #[tokio::test]
    async fn xai_responses_completion_reports_length_when_truncated() {
        let truncated = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"半截\"}\n\n",
            "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n",
        );
        let (text, finish) = run_sse_finish(truncated.as_bytes().to_vec()).await.unwrap();
        assert_eq!(text, "半截");
        assert_eq!(finish, "length", "被截断却报不出 length —— 补余量重试永远不会触发");

        let done = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"整段\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
        );
        let (text2, finish2) = run_sse_finish(done.as_bytes().to_vec()).await.unwrap();
        assert_eq!(text2, "整段");
        assert_eq!(finish2, "stop", "正常收尾要报 stop，否则和「什么都没产出」分不开");
    }

    /// Anthropic 的 stop_reason 在 message_delta 上，**先到**、message_stop 后到。
    /// 新加的收尾判据不许把它覆盖掉。
    #[tokio::test]
    async fn anthropic_completion_keeps_the_stop_reason_it_already_saw() {
        let body = concat!(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"话\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let (text, finish) = run_sse_finish(body.as_bytes().to_vec()).await.unwrap();
        assert_eq!(text, "话");
        assert_eq!(finish, "length", "message_stop 把先到的 stop_reason 覆盖成了别的");
    }

    /// 走 OpenAI 形状的中转：增量在 choices[0].delta.content。
    #[tokio::test]
    async fn sse_text_assembles_openai_deltas() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();
        assert_eq!(run_sse_text(body).await.unwrap(), "你好，世界");
    }

    /// 走原生 Anthropic 的路由：增量在 content_block_delta.delta.text。
    /// 只认 OpenAI 那一种的话，这里会拼出空串——而且不报错，表现成"模型什么都没回"。
    #[tokio::test]
    async fn sse_text_assembles_native_anthropic_deltas() {
        let body = concat!(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"abc\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"def\"}}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();
        assert_eq!(run_sse_text(body).await.unwrap(), "abcdef");
    }

    /// 心跳注释和半截 JSON 不能把整轮判失败——中转经常插这些。
    #[tokio::test]
    async fn sse_text_skips_heartbeats_and_malformed_frames() {
        let body = concat!(
            ": ping\n\n",
            "data: {malformed\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();
        assert_eq!(run_sse_text(body).await.unwrap(), "ok");
    }

    /// 一个多字节字符被切在两个网络包之间时不能变成 �：所以要按原始字节攒、按行解码。
    #[tokio::test]
    async fn sse_text_survives_multibyte_split_across_frames() {
        // "中" = E4 B8 AD；把 JSON 拆成两半，中间那个字被切开。
        let full = "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\ndata: [DONE]\n\n";
        let bytes = full.as_bytes().to_vec();
        assert_eq!(run_sse_text(bytes).await.unwrap(), "中文");
    }

    async fn run_raw_sse_body(body: Vec<u8>) -> (Result<(), String>, Vec<serde_json::Value>) {
        // 不带协议 = 存量路径。这个文件里既有的每一条流式断言都还跑在它上面。
        run_raw_sse_body_on_protocol(body, None).await
    }

    async fn run_raw_sse_body_on_protocol(
        body: Vec<u8>,
        protocol: Option<&str>,
    ) -> (Result<(), String>, Vec<serde_json::Value>) {
        let protocol = protocol.map(str::to_string);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = socket.read(&mut request);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
            socket.flush().unwrap();
        });

        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let channel: Channel<AiEvent> = Channel::new(move |body| {
            captured
                .lock()
                .unwrap()
                .push(body.deserialize::<serde_json::Value>().unwrap());
            Ok(())
        });
        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        cfg.protocol = protocol;
        let result = ai_chat_inner(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "write it"})],
            Some(vec![]),
            channel,
        )
        .await;
        server.join().unwrap();
        let captured = events.lock().unwrap().clone();
        (result, captured)
    }

    fn non_metric_kinds(events: &[serde_json::Value]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| event["kind"].as_str())
            .filter(|kind| *kind != "streamMetric")
            .map(str::to_string)
            .collect()
    }

    fn first_event_of_kind<'a>(
        events: &'a [serde_json::Value],
        kind: &str,
    ) -> &'a serde_json::Value {
        events
            .iter()
            .find(|event| event["kind"] == kind)
            .unwrap_or_else(|| panic!("missing event kind {kind}"))
    }

    #[test]
    fn every_attempt_gets_sixty_seconds_before_first_progress() {
        let standard = StreamTimeouts {
            response_headers: Duration::from_secs(60),
            first_progress: Duration::from_secs(60),
            empty_stream: Duration::from_secs(60),
            stall: Duration::from_secs(60),
            content_backstop: Duration::from_secs(STANDARD_CONTENT_BACKSTOP_SECS),
        };
        assert_eq!(timeouts(Some("medium"), None), standard);
        assert_eq!(timeouts(Some("low"), None), standard);
        assert_eq!(timeouts(None, None), standard);
    }

    #[test]
    fn high_max_and_thinking_budget_get_longer_deadlines() {
        assert_eq!(
            timeouts(Some("high"), None),
            StreamTimeouts {
                response_headers: Duration::from_secs(60),
                first_progress: Duration::from_secs(60),
                empty_stream: Duration::from_secs(60),
                stall: Duration::from_secs(90),
                content_backstop: Duration::from_secs(THINKING_CONTENT_BACKSTOP_SECS),
            }
        );
        let extended = StreamTimeouts {
            response_headers: Duration::from_secs(60),
            first_progress: Duration::from_secs(60),
            empty_stream: Duration::from_secs(60),
            stall: Duration::from_secs(120),
            content_backstop: Duration::from_secs(THINKING_CONTENT_BACKSTOP_SECS),
        };
        assert_eq!(timeouts(Some("max"), None), extended);
        // gpt-5.6 系把 xhigh 原样透传——它必须和 max 同档。
        assert_eq!(timeouts(Some("xhigh"), None), extended);
        assert_eq!(timeouts(Some("XHigh"), None), extended); // 大小写不敏感
        assert_eq!(timeouts(Some("high"), Some(32_000)), extended);
        assert_eq!(timeouts(Some("medium"), Some(1)), extended);
    }

    #[test]
    fn adaptive_thinking_uses_high_deadlines_without_a_legacy_budget() {
        let mut cfg = config(Some("medium"), None);
        cfg.thinking = Some(serde_json::json!({"type": "adaptive"}));

        assert_eq!(
            StreamTimeouts::for_config_with_env(&cfg, |_| None),
            StreamTimeouts {
                response_headers: Duration::from_secs(60),
                first_progress: Duration::from_secs(60),
                empty_stream: Duration::from_secs(60),
                stall: Duration::from_secs(90),
                content_backstop: Duration::from_secs(THINKING_CONTENT_BACKSTOP_SECS),
            },
            "adaptive Claude thinking gets the same full per-attempt pre-progress window"
        );
    }

    #[test]
    fn environment_overrides_are_independent_and_clamped() {
        let values = HashMap::from([
            (FIRST_STREAM_PROGRESS_TIMEOUT_ENV, "9999".to_string()),
            (EMPTY_STREAM_PROGRESS_TIMEOUT_ENV, "3".to_string()),
            (STREAM_STALL_TIMEOUT_ENV, "61".to_string()),
        ]);
        let overridden = StreamTimeouts::for_config_with_env(&config(Some("high"), None), |name| {
            values.get(name).cloned()
        });
        assert_eq!(
            overridden,
            StreamTimeouts {
                response_headers: Duration::from_secs(60),
                first_progress: Duration::from_secs(60),
                empty_stream: Duration::from_secs(60),
                stall: Duration::from_secs(61),
                content_backstop: Duration::from_secs(THINKING_CONTENT_BACKSTOP_SECS),
            }
        );

        let invalid = HashMap::from([
            (FIRST_STREAM_PROGRESS_TIMEOUT_ENV, "".to_string()),
            (
                EMPTY_STREAM_PROGRESS_TIMEOUT_ENV,
                "not-a-number".to_string(),
            ),
            (STREAM_STALL_TIMEOUT_ENV, "-10".to_string()),
        ]);
        assert_eq!(
            StreamTimeouts::for_config_with_env(&config(Some("medium"), None), |name| {
                invalid.get(name).cloned()
            }),
            timeouts(Some("medium"), None),
            "invalid overrides must preserve the selected profile defaults"
        );
    }

    #[test]
    fn uses_separate_first_progress_and_stall_deadlines() {
        let timeouts = timeouts(Some("medium"), None);

        let started = Instant::now();
        let mut progress = StreamProgressDeadline::new(started, timeouts);
        assert_eq!(
            progress.remaining(started + Duration::from_secs(59)),
            Some(Duration::from_secs(1))
        );
        assert_eq!(progress.remaining(started + timeouts.first_progress), None);

        progress.record(started + Duration::from_secs(20));
        assert_eq!(
            progress.remaining(started + Duration::from_secs(79)),
            Some(Duration::from_secs(1))
        );
        assert_eq!(progress.remaining(started + Duration::from_secs(80)), None);
    }

    #[test]
    fn raw_stream_activity_without_real_delta_keeps_the_full_attempt_window() {
        let timeouts = timeouts(Some("high"), None);
        let started = Instant::now();
        let mut progress = StreamProgressDeadline::new(started, timeouts);

        assert_eq!(
            progress.remaining(started + Duration::from_secs(40)),
            Some(Duration::from_secs(20)),
            "before any bytes arrive, high reasoning may still wait for first progress"
        );

        let first_raw_chunk = started + Duration::from_secs(2);
        progress.record_activity(first_raw_chunk);
        assert_eq!(
            progress.remaining(started + timeouts.first_progress - Duration::from_secs(1)),
            Some(Duration::from_secs(1)),
            "raw bytes and heartbeats do not shorten the fixed pre-progress attempt window"
        );
        assert_eq!(progress.remaining(started + timeouts.first_progress), None);

        progress.record(first_raw_chunk + Duration::from_secs(4));
        assert_eq!(
            progress.remaining(first_raw_chunk + Duration::from_secs(4) + timeouts.stall),
            None,
            "real progress switches back to the normal stall deadline"
        );
    }

    /// 用户实拍：模型在写一份长文档，连接一直好好的（网关每 15 秒推心跳），桌面端却在
    /// 90 秒时单方面宣布「连接中断」，然后续传三次、每次再空烧 90 秒，7 分钟零产出。
    ///
    /// 活性（连接通不通）和产出（模型吐不吐字）是两个问题。心跳是 SSE 注释、没有 data
    /// 负载，永远走不到 record()，所以只看 stall 的话，一个正在憋长输出的模型和一条死掉的
    /// 连接长得一模一样。浏览器那条路早就分开了，桌面端这条一直没有。
    #[test]
    fn heartbeats_keep_a_live_stream_from_being_called_a_disconnect() {
        let timeouts = timeouts(Some("medium"), None); // stall 60s / backstop 200s
        let started = Instant::now();
        let mut progress = StreamProgressDeadline::new(started, timeouts);
        progress.record(started); // 出过字了，进入 stall 判据

        // 心跳每 15 秒一次，一直在到 —— 连接是好的，不许按 60 秒掐。
        for tick in 1..=8 {
            progress.record_bytes(started + Duration::from_secs(15 * tick));
        }
        let now = started + Duration::from_secs(120);
        assert!(
            progress.remaining(now).is_some(),
            "心跳还在到就说明连接是通的，120 秒不该被判成掉线",
        );
        // 但兜底仍然有界：不是无限等。
        assert_eq!(
            progress.remaining(started + timeouts.content_backstop),
            None,
            "兜底档到期照样收手，别变成无限等",
        );

        // 对照：心跳停了 → 连接真的没了 → 回到 stall 那一档，早点告诉用户。
        // 注意判死时刻要真的越过活性窗（最后一个字节 + 60s），否则测的还是心跳活着那条路。
        let mut dead = StreamProgressDeadline::new(started, timeouts);
        dead.record(started);
        dead.record_bytes(started + Duration::from_secs(5));
        assert!(
            dead.remaining(started + Duration::from_secs(50)).is_some(),
            "字节刚断 5 秒还在活性窗内，不该这么早判死",
        );
        assert_eq!(
            dead.remaining(started + Duration::from_secs(70)),
            None,
            "超过 60 秒一个字节都没有 = 连接真没了，按 stall 判死，不能用兜底档拖着",
        );
    }

    /// 活性和产出必须在**调用点**就分开，不只是在结构体里分开。
    ///
    /// 原始 chunk 那一行如果写成 record() 而不是 record_bytes()，心跳就变成了"模型在产出"：
    /// last_progress 每 15 秒被刷新一次，停滞看门狗永远打不响，一条真的挂死的流会一直挂着，
    /// 而且 has_progress 会被心跳提前置真、跳过 first_progress 那一档。
    /// 结构体的单元测试看不见这个错误——它发生在流循环里，所以这条钉源码。
    #[test]
    fn raw_chunks_record_liveness_not_progress() {
        const SRC: &str = include_str!("ai.rs");
        // 需要的串一律**拼**出来：include_str! 读的是整个文件，包含本测试模块自己。
        // 写成字面量的话，find 会先命中这段测试代码，窗口取到的是测试自己而不是生产代码
        // ——断言照样绿，却什么都没守住。（同文件里另一条源码断言的注释已经记过这个坑。）
        let needle = format!("raw_stream_bytes = raw_stream_bytes.{}(chunk.len() as u64);", "saturating_add");
        let at = SRC.find(&needle).expect("原始 chunk 计数点不见了");
        let window = &SRC[at..(at + 400).min(SRC.len())];
        let liveness = format!("progress.{}(", "record_bytes");
        let productivity = format!("progress.{}(", "record");
        assert!(
            window.contains(&liveness),
            "每个原始 chunk（含心跳）都要记活性，否则心跳豁免拿不到信号",
        );
        assert!(
            !window.contains(&productivity),
            "心跳不是产出：写成 record() 会让停滞看门狗永远打不响",
        );
    }

    #[test]
    fn only_non_empty_model_deltas_reset_progress() {
        let timeouts = timeouts(Some("medium"), None);
        let started = Instant::now();
        let mut progress = StreamProgressDeadline::new(started, timeouts);

        for non_progress in [
            serde_json::json!({}),
            serde_json::json!({"role": "assistant"}),
            serde_json::json!({"content": ""}),
            serde_json::json!({"reasoning_content": ""}),
            serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": ""}}]}),
        ] {
            assert!(!progress.record_delta(&non_progress, started + Duration::from_secs(24)));
        }
        assert_eq!(
            progress.remaining(started + timeouts.first_progress),
            None,
            "heartbeats, role-only events, and empty deltas must not extend the deadline"
        );

        for real_progress in [
            serde_json::json!({"reasoning_content": "thinking"}),
            serde_json::json!({"content": "token"}),
            serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": "{"}}]}),
        ] {
            let mut candidate = StreamProgressDeadline::new(started, timeouts);
            assert!(candidate.record_delta(&real_progress, started + Duration::from_secs(1)));
            assert!(candidate.has_progress);
        }
    }

    /// 思考载荷不止字符串一种形状。四种都要认，认不出的那一种会**静默**消失：
    /// 事件不发、卡片不出、日志不留，和「模型压根没思考」完全同形。
    ///
    /// reasoning_details 是 OpenRouter 现行的规范载荷，而本仓库的模型目录正是抓
    /// OpenRouter 的（server/src/model_catalog.rs 的 CATALOG_URL），却一直没认过。
    #[test]
    fn reasoning_text_is_read_from_every_known_payload_shape() {
        use serde_json::json;
        let cases: Vec<(&str, serde_json::Value, Option<&str>)> = vec![
            ("字符串 reasoning_content", json!({"reasoning_content": "想"}), Some("想")),
            ("字符串 reasoning", json!({"reasoning": "想"}), Some("想")),
            ("对象 {text}", json!({"reasoning": {"text": "想"}}), Some("想")),
            ("对象 {content}", json!({"reasoning": {"content": "想"}}), Some("想")),
            ("对象 {summary}", json!({"reasoning": {"summary": "想"}}), Some("想")),
            (
                "OpenRouter 的 reasoning_details 数组",
                json!({"reasoning_details": [
                    {"type": "reasoning.text", "text": "想"},
                    {"type": "reasoning.text", "text": "了"},
                ]}),
                Some("想了"),
            ),
            ("空字符串不算思考", json!({"reasoning_content": ""}), None),
            ("没有思考字段", json!({"content": "答案"}), None),
            ("认不出的形状不 panic", json!({"reasoning": 42}), None),
        ];
        for (label, delta, want) in cases {
            let got = reasoning_text_from_delta(&delta);
            assert_eq!(got.as_deref(), want, "{label}");
        }
    }

    /// 停滞看门狗的进展谓词必须用同一份判据：形状不认 → 判成「没有有效内容」→
    /// 看门狗把一条正在正常思考的流掐掉，报「模型在 N 秒内没有生成有效内容」。
    #[test]
    fn object_shaped_reasoning_counts_as_progress() {
        use serde_json::json;
        assert!(delta_has_real_progress(&json!({"reasoning": {"text": "想"}})));
        assert!(delta_has_real_progress(&json!({
            "reasoning_details": [{"type": "reasoning.text", "text": "想"}]
        })));
        assert!(!delta_has_real_progress(&json!({"reasoning": {"text": ""}})));
    }

    #[test]
    fn streamed_tool_calls_require_an_explicit_index() {
        assert_eq!(
            streamed_tool_call_index(&serde_json::json!({"index": 3})).unwrap(),
            3
        );
        assert!(streamed_tool_call_index(&serde_json::json!({})).is_err());
        assert!(streamed_tool_call_index(&serde_json::json!({"index": "0"})).is_err());
    }

    #[test]
    fn timeout_errors_report_the_configured_duration() {
        let timeouts = StreamTimeouts {
            response_headers: Duration::from_secs(73),
            first_progress: Duration::from_secs(81),
            empty_stream: Duration::from_secs(17),
            stall: Duration::from_secs(97),
            content_backstop: Duration::from_secs(THINKING_CONTENT_BACKSTOP_SECS),
        };
        assert_eq!(
            response_headers_timeout_error(timeouts.response_headers, Duration::from_secs(73)),
            "AI request timed out waiting for response headers after 73 seconds (per-attempt 73-second deadline)"
        );

        let started = Instant::now();
        let mut progress = StreamProgressDeadline::new(started, timeouts);
        assert_eq!(
            progress.error_message(started),
            "模型在 81 秒内没有生成有效内容，已停止本轮，请重试。"
        );
        progress.record_activity(started + Duration::from_secs(1));
        assert_eq!(
            progress.error_message(started + Duration::from_secs(1)),
            "上游已开始流式传输，但 81 秒内没有生成有效内容，已停止本轮，请重试。"
        );
        progress.record(started + Duration::from_secs(1));
        // 心跳早就断了（last_byte 还停在 started）→ 报的是"连接死了"那一档：stall。
        assert_eq!(
            progress.error_message(started + Duration::from_secs(200)),
            "模型连续 97 秒没有继续生成有效内容，已停止本轮，请重试。"
        );
        // 心跳还在到 → 连接是好的，只是模型没吐字，这时报的必须是兜底那一档，
        // 而不是把一个健康的流说成"连接中断"。
        progress.record_bytes(started + Duration::from_secs(190));
        assert_eq!(
            progress.error_message(started + Duration::from_secs(200)),
            "模型连续 300 秒没有继续生成有效内容，已停止本轮，请重试。"
        );
    }

    #[tokio::test]
    async fn response_header_wait_is_bounded() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });

        let error = send_with_response_headers_timeout(
            reqwest::Client::new().get(format!("http://{address}/chat/completions")),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            "AI request timed out waiting for response headers after 0.02 seconds (per-attempt 0.02-second deadline)"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn modern_claude_adaptive_thinking_is_forwarded_without_legacy_budget() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_http_request(&mut socket);
            request_tx.send(request).unwrap();

            let body =
                b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
            socket.flush().unwrap();
        });

        let channel: Channel<AiEvent> = Channel::new(|_| Ok(()));
        let mut cfg = config(Some("high"), None);
        cfg.base_url = format!("http://{address}");
        cfg.model = "claude-opus-4-8".into();
        cfg.thinking = Some(serde_json::json!({"type": "adaptive"}));

        ai_chat_inner(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            Some(vec![]),
            channel,
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        server.join().unwrap();
        let body = request.split_once("\r\n\r\n").unwrap().1;
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(payload["reasoning_effort"], "high");
        assert_eq!(payload["thinking"]["type"], "adaptive");
        assert!(payload.get("thinking_budget").is_none());
        assert!(payload["thinking"].get("budget_tokens").is_none());
    }

    #[tokio::test]
    async fn native_anthropic_sse_relays_thinking_text_and_tool_json_in_order() {
        let frames = [
            serde_json::json!({
                "type": "message_start",
                "message": {"id": "msg_native", "type": "message"}
            }),
            serde_json::json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking", "thinking": ""}
            }),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "check project"}
            }),
            serde_json::json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "text", "text": ""}
            }),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "text_delta", "text": "Done."}
            }),
            serde_json::json!({
                "type": "content_block_start",
                "index": 2,
                "content_block": {"type": "tool_use", "id": "toolu_native", "name": "read_file"}
            }),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"src/main.js\"}"}
            }),
            serde_json::json!({"type": "message_stop"}),
        ];
        let body = frames
            .iter()
            .map(|frame| {
                format!(
                    "event: {}\ndata: {}\n\n",
                    frame["type"].as_str().unwrap(),
                    frame
                )
            })
            .collect::<String>()
            .into_bytes();

        let (result, events) = run_raw_sse_body(body).await;

        result.unwrap();
        let kinds = non_metric_kinds(&events);
        assert_eq!(
            kinds,
            ["reasoning", "token", "toolCall", "toolCall", "done"]
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event["kind"] == "reasoning")
                .unwrap()["delta"],
            "check project"
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event["kind"] == "token")
                .unwrap()["delta"],
            "Done."
        );
        let tool_calls = events
            .iter()
            .filter(|event| event["kind"] == "toolCall")
            .collect::<Vec<_>>();
        assert_eq!(tool_calls[0]["index"], 2);
        assert_eq!(tool_calls[0]["id"], "toolu_native");
        assert_eq!(tool_calls[0]["name"], "read_file");
        assert_eq!(tool_calls[0]["arguments"], "");
        assert_eq!(tool_calls[1]["arguments"], "{\"path\":\"src/main.js\"}");
    }

    #[test]
    fn finish_reasons_are_normalized_onto_one_vocabulary() {
        // Anthropic native -> OpenAI spelling
        assert_eq!(normalize_finish_reason("max_tokens"), "length");
        assert_eq!(normalize_finish_reason("end_turn"), "stop");
        assert_eq!(normalize_finish_reason("stop_sequence"), "stop");
        assert_eq!(normalize_finish_reason("tool_use"), "tool_calls");
        // Already-OpenAI values pass through untouched
        assert_eq!(normalize_finish_reason("length"), "length");
        assert_eq!(normalize_finish_reason("tool_calls"), "tool_calls");
        assert_eq!(normalize_finish_reason("content_filter"), "content_filter");
    }

    // `finish_reason` was never parsed at all, so a response cut off by the output-token
    // limit looked identical to a complete one. That left the client's truncation guard
    // with only a JSON-shape heuristic — which cannot detect a tool-call argument object
    // that was severed at a point where it is still a valid JSON *prefix*.
    #[tokio::test]
    async fn openai_stream_reports_a_length_cutoff_to_the_client() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",",
            "\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"a.js\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();

        let (result, events) = run_raw_sse_body(body).await;

        result.unwrap();
        let finish = events
            .iter()
            .find(|event| event["kind"] == "finishReason")
            .expect("a length cutoff must reach the client");
        assert_eq!(finish["reason"], "length");
    }

    #[tokio::test]
    async fn anthropic_stream_reports_a_max_tokens_cutoff_to_the_client() {
        let frames = [
            serde_json::json!({"type": "message_start", "message": {"id": "m", "type": "message"}}),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "partial"}
            }),
            serde_json::json!({"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}),
            serde_json::json!({"type": "message_stop"}),
        ];
        let body = frames
            .iter()
            .map(|frame| format!("event: {}\ndata: {}\n\n", frame["type"].as_str().unwrap(), frame))
            .collect::<String>()
            .into_bytes();

        let (result, events) = run_raw_sse_body(body).await;

        result.unwrap();
        let finish = events
            .iter()
            .find(|event| event["kind"] == "finishReason")
            .expect("Anthropic's max_tokens must reach the client");
        assert_eq!(finish["reason"], "length", "normalized to the OpenAI spelling");
    }

    #[tokio::test]
    async fn explicit_stream_options_rejection_is_not_replayed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let first_request = read_http_request(&mut first);
            let error_body =
                r#"{"error":{"message":"Unsupported parameter: stream_options is not supported"}}"#;
            let error_response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                error_body.len(),
                error_body
            );
            first.write_all(error_response.as_bytes()).unwrap();
            first.flush().unwrap();

            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_millis(150);
            let mut served = 1;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut replay, _)) => {
                        let _ = read_http_request(&mut replay);
                        served += 1;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("gateway test listener failed: {error}"),
                }
            }
            request_tx.send((first_request, served)).unwrap();
        });

        let channel: Channel<AiEvent> = Channel::new(|_| Ok(()));
        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        let error = ai_chat_inner(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            Some(vec![]),
            channel,
        )
        .await
        .unwrap_err();

        let (first_request, served) = request_rx.recv().unwrap();
        assert!(first_request.contains("\"stream_options\""));
        assert!(error.contains("stream_options is not supported"));
        assert_eq!(served, 1);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn ordinary_client_error_does_not_retry_the_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (count_tx, count_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let _ = read_http_request(&mut first);
            let body = r#"{"error":{"message":"invalid api key"}}"#;
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            first.write_all(response.as_bytes()).unwrap();
            first.flush().unwrap();

            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_millis(150);
            let mut served = 1;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let _ = read_http_request(&mut socket);
                        served += 1;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("gateway test listener failed: {error}"),
                }
            }
            count_tx.send(served).unwrap();
        });

        let channel: Channel<AiEvent> = Channel::new(|_| Ok(()));
        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        let error = ai_chat_inner(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "hello"})],
            Some(vec![]),
            channel,
        )
        .await
        .unwrap_err();
        assert!(error.contains("invalid api key"));
        assert_eq!(count_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn gateway_http_error_response_is_not_retried() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (count_tx, count_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            socket
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            socket.flush().unwrap();
            count_tx.send(1).unwrap();
        });

        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        let response = post_chat_once(
            &reqwest::Client::new(),
            &format!("http://{address}/v1/chat/completions"),
            &cfg,
            &serde_json::json!({"model": "test", "stream": true, "messages": []}),
            Duration::from_secs(1),
            None,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
        assert_eq!(count_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn gateway_response_header_timeout_is_single_shot() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (count_tx, count_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            std::thread::sleep(Duration::from_millis(35));
            drop(socket);

            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_millis(100);
            let mut served = 1;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut replay, _)) => {
                        let _ = replay.read(&mut [0_u8; 4096]);
                        served += 1;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("gateway test listener failed: {error}"),
                }
            }
            count_tx.send(served).unwrap();
        });

        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        let started = Instant::now();
        let error = post_chat_once(
            &reqwest::Client::new(),
            &format!("http://{address}/v1/chat/completions"),
            &cfg,
            &serde_json::json!({"model": "test", "stream": true, "messages": []}),
            Duration::from_millis(15),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("timed out waiting for response headers"));
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "response-header wait exceeded its configured bound"
        );
        assert_eq!(count_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn response_header_deadline_is_applied_once() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.contains("x-ide-response-deadline-ms:"));
            assert!(
                request.contains("x-ide-response-budget-ms:"),
                "相对预算头必须和绝对时间戳一起上线，否则时钟不准的机器仍然没有出路"
            );
            std::thread::sleep(Duration::from_millis(100));
        });

        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");
        let started = Instant::now();
        let error = post_chat_once(
            &reqwest::Client::new(),
            &format!("http://{address}/v1/chat/completions"),
            &cfg,
            &serde_json::json!({"model": "test", "stream": true, "messages": []}),
            Duration::from_millis(80),
            None,
        )
        .await
        .unwrap_err();
        let elapsed = started.elapsed();
        assert!(error.contains("timed out waiting for response headers"));
        assert!(
            elapsed >= Duration::from_millis(70) && elapsed < Duration::from_millis(150),
            "response-header deadline was not applied once: {elapsed:?}"
        );
        server.join().unwrap();
    }

    /// 相对预算头的值只由本地定时器决定，和本机时钟对不对完全无关。
    ///
    /// 这是"时钟慢两分钟的机器一次请求都发不出去"那条故障的根治点：绝对时间戳仍然发
    /// （网关在时钟对得上时用它收紧预算，因为它把上传耗时也算了进去），但网关不再**只有**
    /// 它可用。
    #[test]
    fn the_budget_header_does_not_depend_on_the_local_clock() {
        let budget = Duration::from_secs(60);
        let deadline = ResponseHeadersDeadline::new(Instant::now(), budget);
        let request = with_response_deadline_header(
            reqwest::Client::new().post("http://127.0.0.1:1/v1/chat/completions"),
            deadline,
        )
        .build()
        .expect("request builds");

        let sent = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };

        assert_eq!(
            sent(RESPONSE_BUDGET_HEADER).as_deref(),
            Some("60000"),
            "相对预算必须就是本地定时器用的那个数"
        );
        // 绝对时间戳照旧发出：网关拿它和相对预算互相印证，两者一致时用更紧的那个。
        let absolute: u64 = sent(RESPONSE_DEADLINE_HEADER)
            .expect("绝对时间戳仍然要发")
            .parse()
            .expect("是一个毫秒时间戳");
        assert_eq!(absolute, deadline.unix_ms);
    }

    #[tokio::test]
    async fn cancellation_interrupts_response_header_wait() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            std::thread::sleep(Duration::from_millis(200));
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_task = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel_task.store(true, Ordering::SeqCst);
        });

        let cfg = config(None, None);
        let started = Instant::now();
        let error = post_chat_once(
            &reqwest::Client::new(),
            &format!("http://{address}/v1/chat/completions"),
            &cfg,
            &serde_json::json!({"model": "test", "stream": true, "messages": []}),
            Duration::from_secs(1),
            Some(cancel.as_ref()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, CANCELLED_AI_REQUEST);
        assert!(
            started.elapsed() < Duration::from_millis(180),
            "cancel did not interrupt the header wait"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn clean_eof_without_done_rejects_partial_tool_arguments() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let partial_args = r#"{"path":"src/main.js","content":"partial"#;
        let data = serde_json::json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_partial",
                        "function": {
                            "name": "write_file",
                            "arguments": partial_args,
                        }
                    }]
                }
            }]
        });
        let body = format!("data: {data}\n\n");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = socket.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).unwrap();
            socket.flush().unwrap();
        });

        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = events.clone();
        let channel: Channel<AiEvent> = Channel::new(move |body| {
            captured
                .lock()
                .unwrap()
                .push(body.deserialize::<serde_json::Value>().unwrap());
            Ok(())
        });
        let mut cfg = config(None, None);
        cfg.base_url = format!("http://{address}");

        let error = ai_chat_inner(
            cfg,
            vec![serde_json::json!({"role": "user", "content": "write it"})],
            Some(vec![]),
            channel,
        )
        .await
        .unwrap_err();
        server.join().unwrap();

        assert_eq!(error, INCOMPLETE_SSE_STREAM_ERROR);
        let events = events.lock().unwrap();
        let kinds = non_metric_kinds(&events);
        assert_eq!(kinds, ["toolCall", "error"]);
        assert_eq!(
            first_event_of_kind(&events, "toolCall")["arguments"],
            partial_args
        );
        assert_eq!(
            first_event_of_kind(&events, "error")["message"],
            INCOMPLETE_SSE_STREAM_ERROR
        );
        assert!(!events.iter().any(|event| event["kind"] == "done"));
    }

    /// 真抓包形状的原生 Anthropic 流，走 `protocol: "anthropic"` 这条路，一路到前端
    /// 事件。这条断言同时钉住三件此前不成立的事：
    ///   1. 这条路上**没有 `data: [DONE]`** —— 收尾判据只能来自 `message_stop`，
    ///      否则整轮会被判成"连接提前结束"并作废。
    ///   2. 工具的 content block 下标是 2（思考 0、正文 1），而前端拿到的必须是 0。
    ///   3. Anthropic 的 input_tokens **不含**缓存，上下文读数要把缓存加回去。
    #[tokio::test]
    async fn anthropic_native_stream_arrives_as_ordinary_frontend_events() {
        let body = include_str!("../testdata/anthropic_tool_call.sse")
            .as_bytes()
            .to_vec();
        let (result, events) = run_raw_sse_body_on_protocol(body, Some("anthropic")).await;
        assert!(result.is_ok(), "没有 [DONE] 也必须算收全: {result:?}");
        assert_eq!(
            non_metric_kinds(&events),
            [
                "reasoning",
                "reasoning",
                "token",
                "toolCall",
                "toolCall",
                "toolCall",
                "finishReason",
                "usage",
                "done"
            ]
        );
        let reasoning: String = events
            .iter()
            .filter(|e| e["kind"] == "reasoning")
            .map(|e| e["delta"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(reasoning, "用户问东京时间，应该调用 get_time。");
        assert_eq!(first_event_of_kind(&events, "token")["delta"], "我查一下。");

        let calls: Vec<&serde_json::Value> =
            events.iter().filter(|e| e["kind"] == "toolCall").collect();
        assert!(
            calls.iter().all(|c| c["index"] == 0),
            "content block 下标不能透传成 tool_calls 下标"
        );
        assert_eq!(calls[0]["id"], "tooluse_1");
        assert_eq!(calls[0]["name"], "get_time");
        let arguments: String = calls
            .iter()
            .map(|c| c["arguments"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(arguments, r#"{"tz": "Asia/Tokyo"}"#);
        serde_json::from_str::<serde_json::Value>(&arguments).unwrap();

        assert_eq!(
            first_event_of_kind(&events, "finishReason")["reason"],
            "tool_calls"
        );
        // 变体名是 camelCase（enum 上的 rename_all 只改变体名），**字段名仍是 snake_case**。
        let usage = first_event_of_kind(&events, "usage");
        assert_eq!(usage["prompt_tokens"], 61); // 15 输入 + 46 缓存读：原生 input_tokens 不含缓存
        assert_eq!(usage["cached_tokens"], 46);
        assert_eq!(usage["completion_tokens"], 18);
        assert_eq!(usage["cache_creation_tokens"], 0);
        // Anthropic 把思考算进 output_tokens，不单独报思考 token —— 字符数是这条线路上
        // 唯一真实可核对的思考量，不拿它冒充 token。
        assert_eq!(usage["reasoning_tokens"], 0);
        assert_eq!(usage["thinking_chars"], 22);
    }

    /// 铁律：**没有协议字段的存量自定义模型，行为逐字不变。**
    /// 同一段 OpenAI SSE，三种 protocol 取值（缺省 / "openai" / 一个无意义的字符串）
    /// 必须产生完全相同的一串前端事件。
    #[tokio::test]
    async fn absent_and_unknown_protocol_behave_exactly_like_today() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec();
        let strip = |events: Vec<serde_json::Value>| {
            events
                .into_iter()
                .filter(|e| e["kind"] != "streamMetric")
                .collect::<Vec<_>>()
        };
        let (baseline_result, baseline) = run_raw_sse_body(body.clone()).await;
        let (openai_result, openai) =
            run_raw_sse_body_on_protocol(body.clone(), Some("openai")).await;
        let (unknown_result, unknown) =
            run_raw_sse_body_on_protocol(body, Some("не-протокол")).await;
        assert!(baseline_result.is_ok());
        assert_eq!(openai_result, baseline_result);
        assert_eq!(unknown_result, baseline_result);
        let baseline = strip(baseline);
        assert!(!baseline.is_empty());
        assert_eq!(strip(openai), baseline);
        assert_eq!(strip(unknown), baseline);
    }

    #[tokio::test]
    async fn malformed_json_before_done_rejects_complete_tool_argument_prefix() {
        let arguments = r#"{"path":"src/main.js","content":"prefix"}"#;
        let first = serde_json::json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_prefix",
                        "function": {"name": "write_file", "arguments": arguments}
                    }]
                }
            }]
        });
        let body = format!("data: {first}\n\ndata: {{malformed\n\ndata: [DONE]\n\n").into_bytes();

        let (result, events) = run_raw_sse_body(body).await;

        let error = result.unwrap_err();
        assert!(error.contains("malformed SSE JSON"));
        let kinds = non_metric_kinds(&events);
        assert_eq!(kinds, ["toolCall", "error"]);
        assert_eq!(
            first_event_of_kind(&events, "toolCall")["arguments"],
            arguments
        );
        assert!(!events.iter().any(|event| event["kind"] == "done"));
    }

    #[tokio::test]
    async fn invalid_utf8_frame_before_done_rejects_the_stream() {
        let mut body = b"data: {\"choices\":[{\"delta\":{\"content\":\"".to_vec();
        body.push(0xff);
        body.extend_from_slice(
            b"\"}}]}

data: [DONE]

",
        );

        let (result, events) = run_raw_sse_body(body).await;

        let error = result.unwrap_err();
        assert!(error.contains("invalid UTF-8 SSE data"));
        let kinds = non_metric_kinds(&events);
        assert_eq!(kinds, ["error"]);
        assert!(!events.iter().any(|event| event["kind"] == "done"));
    }
}

async fn ai_chat_inner(
    config: AiConfig,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let timeouts = StreamTimeouts::for_config(&config);
    let wire = crate::protocol::Wire::of(config.protocol.as_deref());
    let url = crate::protocol::endpoint_url(wire, &config.base_url)?;
    let stream_started = Instant::now();
    // Register cancellation before DNS/connect/header wait. Previously registration
    // happened only after headers arrived, so Stop could not interrupt the exact hang
    // this watchdog is meant to bound.
    let cancel_id = cancellation_id(&config);
    let cancel_flag = cancel_id.as_deref().map(register_cancel);
    let _cancel_guard = cancel_id.map(CancelGuard);
    send_stream_metric(&on_event, stream_started, "requestStarted", None);
    let mut payload = serde_json::json!({
        "model": config.model,
        "stream": true,
        "messages": messages,
        // Ask the provider to emit a final `usage` chunk (incl. cached-prompt
        // tokens) during streaming — without this most OpenAI-compatible providers
        // send NO usage, so the cache meter has nothing to show ("缓存看不到").
        "stream_options": { "include_usage": true },
    });
    if let Some(max_tokens) = config.max_tokens {
        payload["max_tokens"] = serde_json::json!(max_tokens);
    }
    if let Some(temp) = config.temperature {
        payload["temperature"] = serde_json::json!(temp);
    }
    // 回发上一轮的前缀引用。网关据此从 Redis 取回历史摘要，客户端就只需要上传新增
    // 消息 —— 这是 2m/5m 档能真正达到的唯一途径。
    if let Some(tok) = config
        .mc_prefix
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 200)
    {
        payload["mc_prefix"] = serde_json::json!(tok);
        if let Some(covered) = config.mc_prefix_covered.filter(|covered| *covered > 0) {
            payload["mc_prefix_covered"] = serde_json::json!(covered);
        }
    }
    if let Some(ref t) = tools {
        if !t.is_empty() {
            payload["tools"] = serde_json::json!(t);
        }
    }
    if let Some(ref effort) = config.reasoning_effort {
        if !effort.is_empty() {
            payload["reasoning_effort"] = serde_json::json!(effort);
        }
    }
    if let Some(budget) = config.thinking_budget {
        if budget > 0 {
            payload["thinking_budget"] = serde_json::json!(budget);
            // Anthropic-native shape for relays that route via /v1/messages.
            payload["thinking"] = serde_json::json!({"type": "enabled", "budget_tokens": budget});
        }
    }
    if let Some(ref thinking) = config.thinking {
        payload["thinking"] = thinking.clone();
    }
    if let Some(ref thinking_config) = config.thinking_config {
        payload["thinking_config"] = thinking_config.clone();
    }

    // Prompt-cache breakpoints are route capabilities. The Michael gateway adds them only after
    // selecting a native Anthropic connection; the desktop does not guess from model names or
    // mutate the stable prefix.

    // 上面这一整段构造出来的是 **OpenAI 形状**的请求体。自定义模型选了别的协议时，
    // 在这里翻一次形状 —— 而 `Wire::OpenAi` 下 translate_request 是恒等变换，
    // 存量路径发出去的字节和以前完全一样。
    let payload = match crate::protocol::translate_request(wire, &payload) {
        Ok(payload) => payload,
        Err(message) => {
            // 翻译失败最常见的原因是历史里有一个参数坏掉的工具调用。宁可在这里说清楚，
            // 也不要把一个残缺的请求发出去换回一句上游的通用 400。
            let _ = on_event.send(AiEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };

    let client = &*HTTP;
    let resp_result = post_chat_once(
        client,
        &url,
        &config,
        &payload,
        timeouts.response_headers,
        cancel_flag.as_deref(),
    )
    .await;
    let resp = match resp_result {
        Ok(response) => response,
        Err(error) if error == CANCELLED_AI_REQUEST => {
            let _ = on_event.send(AiEvent::Done);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = read_ai_error_body(resp).await;
        let message = format_ai_http_error(status, &text);
        let _ = on_event.send(AiEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    }
    send_stream_metric(&on_event, stream_started, "responseHeaders", None);

    // 网关本轮签发的前缀引用。必须在消费 body 之前把响应头读出来。前端存下来，下一轮
    // 通过 config.mcPrefix 回发 —— 没有这一步，网关每轮签的令牌都进了垃圾桶，客户端
    // 只能整份上传历史。
    if let Some(tok) = resp
        .headers()
        .get("x-michael-compression-prefix")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .map(str::to_string)
    {
        // 覆盖条数缺失或解析失败时按 0 处理：宁可这一轮整份重传，也不能凭一个错的
        // 条数去裁历史 —— 裁错了模型收到的是错位的上下文，而且不会有任何报错。
        let covered = resp
            .headers()
            .get("x-michael-compression-covered")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if covered > 0 {
            let _ = on_event.send(AiEvent::CompressionPrefix {
                token: tok,
                covered,
            });
        }
    }

    let mut stream = resp.bytes_stream();
    // Accumulate RAW BYTES, not lossily-decoded strings: a multibyte UTF-8 char
    // (e.g. a Chinese character) can be split across two network chunks, and
    // decoding each chunk on its own would turn the split char into a `�`
    // replacement char — visible mojibake in the streamed answer. SSE lines are
    // delimited by '\n' (0x0A), a byte that never appears inside a multibyte
    // UTF-8 sequence, so splitting on the byte and decoding each *complete* line
    // is always valid.
    let mut buf: Vec<u8> = Vec::new();
    // A transport heartbeat is not model progress. The first non-empty
    // reasoning/token/tool-call delta must arrive promptly; after that, each real
    // delta gets a longer stall window. SSE comments, empty deltas, usage-only
    // chunks and arbitrary response bytes never extend either deadline.
    let mut progress = StreamProgressDeadline::new(stream_started, timeouts);
    let mut raw_stream_bytes: u64 = 0;
    let mut sent_first_chunk_metric = false;
    let mut sent_first_progress_metric = false;
    // A native Anthropic `tool_use` sends identity in `content_block_start` and
    // JSON fragments later in `input_json_delta`. Retain it so every fragment is
    // a complete ToolCall event for both the agent and ordinary-chat consumers.
    let mut native_anthropic_tools: HashMap<u32, (String, String)> = HashMap::new();
    // 上游线协议解码器。OpenAI 兼容（网关线路 + 所有存量自定义模型）→ None，
    // 下面的帧一律原样进既有解析块。
    let mut decoder = crate::protocol::StreamDecoder::for_wire(wire);
    // 首个有效输出前持续上报字节心跳：只发一次 firstChunk 会让前端永远显示首包字节数，
    // 用户无法区分"上游断了"和"模型还在深思/排队"（prefill 阶段不吐任何 token）。
    let mut last_bytes_metric_at = Instant::now();
    loop {
        // User hit Stop → cancel_ai flipped this flag: end the turn now so the
        // upstream connection closes and token generation stops
        // (at most STREAM_READ_POLL latency).
        if let Some(f) = &cancel_flag {
            if f.load(Ordering::SeqCst) {
                let _ = on_event.send(AiEvent::Done);
                return Ok(());
            }
        }
        let Some(remaining) = progress.remaining(Instant::now()) else {
            let _ = on_event.send(AiEvent::Error {
                message: progress.error_message(Instant::now()),
            });
            let _ = on_event.send(AiEvent::Done);
            return Ok(());
        };
        let chunk = match tokio::time::timeout(remaining.min(STREAM_READ_POLL), stream.next()).await
        {
            Ok(Some(Ok(c))) => c,
            // A mid-stream read error means the connection dropped partway (common
            // on cross-border / lossy links — "error decoding response body"). Keep
            // what we've already streamed and end the turn gracefully.
            Ok(Some(Err(_e))) => {
                let _ = on_event.send(AiEvent::Error {
                    message: "连接中断（网络波动），已保留生成的部分。".to_string(),
                });
                let _ = on_event.send(AiEvent::Done);
                return Ok(());
            }
            Ok(None) => {
                // OpenAI-compatible SSE is complete only after the explicit [DONE]
                // sentinel. A clean TCP EOF can still be a proxy/upstream truncation;
                // treating it as Done would authorize partially streamed tool arguments.
                let message = INCOMPLETE_SSE_STREAM_ERROR.to_string();
                let _ = on_event.send(AiEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
            Err(_elapsed) => {
                if progress.remaining(Instant::now()).is_none() {
                    let _ = on_event.send(AiEvent::Error {
                        message: progress.error_message(Instant::now()),
                    });
                    let _ = on_event.send(AiEvent::Done);
                    return Ok(());
                }
                continue;
            }
        };
        // 只统计字节；activity 的判定放到 SSE 行解析处——`: ping` 心跳注释和
        // 空 role 预热帧不能算"开始输出"，否则 first_progress 大窗会被降级成 empty_stream 小窗。
        raw_stream_bytes = raw_stream_bytes.saturating_add(chunk.len() as u64);
        // 心跳也算——它证明的是连接还通，正是 limit_and_anchor 要的那个信号。
        progress.record_bytes(Instant::now());
        if !sent_first_chunk_metric {
            sent_first_chunk_metric = true;
            last_bytes_metric_at = Instant::now();
            send_stream_metric(
                &on_event,
                stream_started,
                "firstChunk",
                Some(raw_stream_bytes),
            );
        } else if !sent_first_progress_metric
            && last_bytes_metric_at.elapsed() >= Duration::from_secs(3)
        {
            // 心跳注释/预热帧也是字节：定期把累计字节数送给前端，停顿提示才能说清
            // "连接活着、模型还没开口"。不影响任何超时判定。
            last_bytes_metric_at = Instant::now();
            send_stream_metric(
                &on_event,
                stream_started,
                "streaming",
                Some(raw_stream_bytes),
            );
        }
        buf.extend_from_slice(&chunk);

        // Server-sent events are newline-delimited `data: {...}` lines. Scan with a
        // cursor and compact once per network chunk; draining the Vec for every SSE
        // line repeatedly shifted the remaining bytes when providers emitted a burst.
        let mut consumed = 0usize;
        while let Some(relative_pos) = buf[consumed..].iter().position(|&b| b == b'\n') {
            let line_end = consumed + relative_pos;
            let line_bytes = &buf[consumed..=line_end];
            consumed = line_end + 1;
            let line = match std::str::from_utf8(line_bytes) {
                Ok(line) => line.trim(),
                Err(error) => {
                    let message = format!("AI stream contains invalid UTF-8 SSE data: {error}");
                    let _ = on_event.send(AiEvent::Error {
                        message: message.clone(),
                    });
                    return Err(message);
                }
            };
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            progress.record_activity(Instant::now()); // 真正的 data 帧才算上游开始流式输出
            if data == "[DONE]" {
                send_stream_metric(&on_event, stream_started, "done", Some(raw_stream_bytes));
                let _ = on_event.send(AiEvent::Done);
                return Ok(());
            }
            if data.is_empty() {
                continue;
            }
            let v = match serde_json::from_str::<serde_json::Value>(data) {
                Ok(value) => value,
                Err(error) => {
                    let message = format!("AI stream contains malformed SSE JSON: {error}");
                    let _ = on_event.send(AiEvent::Error {
                        message: message.clone(),
                    });
                    return Err(message);
                }
            };
            // ── 上游线协议翻译 ───────────────────────────────────────────────
            //
            // decoder 为 None（OpenAI 兼容 —— 网关线路和所有存量自定义模型）时这里是
            // `vec![v]`，也就是把上游帧原样交给下面那个解析块，中间没有任何代码：
            // 「默认 openai 一行行为都不变」是结构上成立的，不是靠小心。
            //
            // 非 OpenAI 协议：原生帧被翻成零或多个 OpenAI chunk 再进同一个块，于是新协议
            // 白拿这一整套 —— 正文 / 四种形状的思考 / 工具分片重组 / usage 归一化 /
            // finish_reason 归一化 / 停滞看门狗。翻译本身是纯函数，测试在 protocol.rs 里
            // 按输入断言输出，不碰网络。
            //
            // 顺带解释下面那个块里的原生 Anthropic 分支为什么不用关掉：翻出来的 chunk
            // 只有 `object`/`choices`，没有 `type` 键，那些分支对它天然不成立。走
            // Wire::OpenAi 的中转若真发原生帧，仍旧由那些分支接住 —— 和今天一样。
            let frames: Vec<serde_json::Value> = match decoder.as_mut() {
                None => vec![v],
                Some(decoder) => match decoder.push_event(&v) {
                    Ok(frames) => frames,
                    Err(message) => {
                        let _ = on_event.send(AiEvent::Error {
                            message: message.clone(),
                        });
                        return Err(message);
                    }
                },
            };
            for v in frames {
                // Usage normally rides the FINAL chunk (choices may be empty there).
                // Cached-prompt tokens are reported differently per provider — take
                // whichever field is present: OpenAI/DeepSeek `prompt_tokens_details
                // .cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, or Anthropic-
                // style `cache_read_input_tokens`.
                if let Some(usage) = v.get("usage").filter(|u| u.is_object()) {
                    let completion = usage["completion_tokens"]
                        .as_u64()
                        .or_else(|| usage["output_tokens"].as_u64()) // Anthropic
                        .unwrap_or(0);
                    let cache_read = usage["cache_read_input_tokens"].as_u64(); // Anthropic
                    let cache_creation = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                    let cached = usage["prompt_tokens_details"]["cached_tokens"]
                        .as_u64()
                        .or_else(|| usage["prompt_cache_hit_tokens"].as_u64()) // DeepSeek
                        .or_else(|| usage["cached_content_token_count"].as_u64()) // Gemini (OpenAI-compat)
                        .or_else(|| usage["cachedContentTokenCount"].as_u64()) // Gemini (native)
                        .or(cache_read)
                        .unwrap_or(0);
                    let prompt_raw = usage["prompt_tokens"]
                        .as_u64()
                        .or_else(|| usage["input_tokens"].as_u64()) // Anthropic
                        .unwrap_or(0);
                    // OpenAI/DeepSeek: `prompt_tokens` already INCLUDES cached tokens.
                    // Anthropic: `input_tokens` EXCLUDES cached (reported separately),
                    // so add them — otherwise `cached / prompt` reads as >100%.
                    let prompt = if cache_read.is_some() {
                        prompt_raw + cached + cache_creation
                    } else {
                        prompt_raw
                    };
                    // 思考 token 的字段名各家不一样，全都认一遍：
                    //   OpenAI / 兼容渠道 → completion_tokens_details.reasoning_tokens
                    //   Anthropic 原生    → output_tokens_details.reasoning_tokens
                    //   部分聚合渠道会平铺成顶层 reasoning_tokens
                    let reasoning = usage["completion_tokens_details"]["reasoning_tokens"]
                        .as_u64()
                        .or_else(|| usage["output_tokens_details"]["reasoning_tokens"].as_u64())
                        .or_else(|| usage["reasoning_tokens"].as_u64())
                        .unwrap_or(0);
                    let thinking_chars = usage["thinking_chars"].as_u64().unwrap_or(0);
                    if prompt > 0 || completion > 0 {
                        let _ = on_event.send(AiEvent::Usage {
                            prompt_tokens: prompt as u32,
                            completion_tokens: completion as u32,
                            cached_tokens: cached as u32,
                            cache_creation_tokens: cache_creation as u32,
                            reasoning_tokens: reasoning as u32,
                            thinking_chars: thinking_chars as u32,
                        });
                    }
                }
                // Direct Anthropic Messages API streaming uses native event objects.
                // The gateway generally normalizes them to OpenAI chunks, but direct
                // routes must not discard visible thinking/text merely because they
                // bypass that normalization. `message_stop` is Anthropic's [DONE].
                if v["type"].as_str() == Some("message_stop") {
                    send_stream_metric(&on_event, stream_started, "done", Some(raw_stream_bytes));
                    let _ = on_event.send(AiEvent::Done);
                    return Ok(());
                }
                if native_anthropic_event_has_real_progress(&v) && !sent_first_progress_metric {
                    progress.record(Instant::now());
                    sent_first_progress_metric = true;
                    send_stream_metric(
                        &on_event,
                        stream_started,
                        "firstProgress",
                        Some(raw_stream_bytes),
                    );
                } else if native_anthropic_event_has_real_progress(&v) {
                    progress.record(Instant::now());
                }
                match v["type"].as_str() {
                    Some("content_block_start")
                        if v["content_block"]["type"].as_str() == Some("tool_use") =>
                    {
                        if let Some(index) = v["index"].as_u64().and_then(|raw| u32::try_from(raw).ok())
                        {
                            let id = v["content_block"]["id"].as_str().unwrap_or("").to_string();
                            let name = v["content_block"]["name"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            native_anthropic_tools.insert(index, (id.clone(), name.clone()));
                            if !id.is_empty() || !name.is_empty() {
                                let _ = on_event.send(AiEvent::ToolCall {
                                    index,
                                    id,
                                    name,
                                    arguments: String::new(),
                                });
                            }
                        }
                    }
                    Some("content_block_delta") => match v["delta"]["type"].as_str() {
                        Some("thinking_delta") => {
                            if let Some(thinking) = v["delta"]["thinking"]
                                .as_str()
                                .filter(|text| !text.is_empty())
                            {
                                let _ = on_event.send(AiEvent::Reasoning {
                                    delta: thinking.to_string(),
                                });
                            }
                        }
                        Some("text_delta") => {
                            if let Some(text) =
                                v["delta"]["text"].as_str().filter(|text| !text.is_empty())
                            {
                                let _ = on_event.send(AiEvent::Token {
                                    delta: text.to_string(),
                                });
                            }
                        }
                        Some("input_json_delta") => {
                            if let (Some(index), Some(arguments)) = (
                                v["index"].as_u64().and_then(|raw| u32::try_from(raw).ok()),
                                v["delta"]["partial_json"]
                                    .as_str()
                                    .filter(|text| !text.is_empty()),
                            ) {
                                let (id, name) = native_anthropic_tools
                                    .get(&index)
                                    .cloned()
                                    .unwrap_or_default();
                                let _ = on_event.send(AiEvent::ToolCall {
                                    index,
                                    id,
                                    name,
                                    arguments: arguments.to_string(),
                                });
                            }
                        }
                        _ => {}
                    },
                    // Anthropic reports why it stopped on `message_delta`, using its own
                    // vocabulary (`max_tokens` / `end_turn` / `tool_use` / `stop_sequence`).
                    Some("message_delta") => {
                        if let Some(reason) = v["delta"]["stop_reason"]
                            .as_str()
                            .filter(|reason| !reason.is_empty())
                        {
                            let _ = on_event.send(AiEvent::FinishReason {
                                reason: normalize_finish_reason(reason).to_string(),
                            });
                        }
                    }
                    _ => {}
                }
                let delta = &v["choices"][0]["delta"];
                if progress.record_delta(delta, Instant::now()) && !sent_first_progress_metric {
                    sent_first_progress_metric = true;
                    send_stream_metric(
                        &on_event,
                        stream_started,
                        "firstProgress",
                        Some(raw_stream_bytes),
                    );
                }
                // Thinking / reasoning stream. **形状不止一种，字符串只是其中最简单的那种。**
                //
                // 原来这里是 `delta["reasoning_content"].as_str().or_else(|| delta["reasoning"].as_str())`
                // ——两处都是 as_str()、没有 else 分支、不打日志。于是任何非字符串形状都被
                // 静默丢弃：事件不发、卡片不出、日志不留，和"模型压根没思考"长得一模一样。
                //
                // 真实存在的另外三种形状：
                //   · `reasoning: { text: "…" }` / `{ content: "…" }` —— 部分中转把它包成对象
                //   · `reasoning_details: [{ type:"reasoning.text", text:"…" }, …]` —— 这是
                //     **OpenRouter 现行的规范载荷**，而本仓库的模型目录正是抓 OpenRouter 的
                //     （见 server/src/model_catalog.rs 的 CATALOG_URL），却全仓一个字都没认过
                //   · 上面两者的数组形式（分片推理）
                //
                // 认全它们不需要按厂商分叉：按形状取文本，取不到就当没有。
                if let Some(rt) = reasoning_text_from_delta(delta) {
                    if !rt.is_empty() {
                        let _ = on_event.send(AiEvent::Reasoning { delta: rt });
                    }
                }
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        let _ = on_event.send(AiEvent::Token {
                            delta: text.to_string(),
                        });
                    }
                }
                if let Some(tcs) = delta["tool_calls"].as_array() {
                    for tc in tcs {
                        let index = match streamed_tool_call_index(tc) {
                            Ok(index) => index,
                            Err(message) => {
                                let _ = on_event.send(AiEvent::Error { message });
                                let _ = on_event.send(AiEvent::Done);
                                return Ok(());
                            }
                        };
                        let id = tc["id"].as_str().unwrap_or("").to_string();
                        let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                        let args = tc["function"]["arguments"]
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        if !id.is_empty() || !name.is_empty() || !args.is_empty() {
                            let _ = on_event.send(AiEvent::ToolCall {
                                index,
                                id,
                                name,
                                arguments: args,
                            });
                        }
                    }
                }
                // Sibling of `delta`, not part of it: it arrives on the final chunk, where
                // `delta` is typically `{}`. `length` here is the provider telling us the
                // response was cut off — the client rejects any tool call in that turn.
                if let Some(reason) = v["choices"][0]["finish_reason"]
                    .as_str()
                    .filter(|reason| !reason.is_empty())
                {
                    let _ = on_event.send(AiEvent::FinishReason {
                        reason: normalize_finish_reason(reason).to_string(),
                    });
                }
            }
            // Anthropic 用 message_stop、xAI Responses 用 response.completed 收流 ——
            // **两者都不发 `data: [DONE]`**。上面那个哨兵分支等不到它，于是这条流会一路
            // 走到 TCP EOF，被判成「连接提前结束」并整轮作废。收尾判据只能由解码器给。
            if decoder
                .as_ref()
                .is_some_and(crate::protocol::StreamDecoder::stream_complete)
            {
                send_stream_metric(&on_event, stream_started, "done", Some(raw_stream_bytes));
                let _ = on_event.send(AiEvent::Done);
                return Ok(());
            }
        }
        if consumed > 0 {
            buf.drain(..consumed);
        }

        // Continuous heartbeat chunks may prevent the read timeout from firing, so
        // enforce the same real-progress deadline after every parsed network chunk.
        if progress.remaining(Instant::now()).is_none() {
            let _ = on_event.send(AiEvent::Error {
                message: progress.error_message(Instant::now()),
            });
            let _ = on_event.send(AiEvent::Done);
            return Ok(());
        }
    }
}

/// SSRF policy for this single-user, on-device dev IDE. The user explicitly wants
/// to fetch their own intranet / localhost dev servers, so loopback and private
/// LAN are ALLOWED (matches the `net.rs` http_request tool). What stays blocked is
/// what's never a legitimate fetch target and is the real danger: link-local
/// (169.254/16 and fe80::/10 — i.e. the cloud-metadata 169.254.169.254 endpoint),
/// plus unspecified / multicast / broadcast / documentation junk.
fn ip_fetch_allowed(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_link_local()        // 169.254/16 — blocks cloud metadata
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || v4.is_multicast()
                || o[0] == 0)
        }
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            !(v6.is_unspecified()
                || v6.is_multicast()
                // link-local fe80::/10
                || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    }
}

/// Best-effort HTML → readable text: drop `<script>`/`<style>` blocks and tags,
/// decode a few common entities, collapse whitespace.
fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase(); // ASCII-only fold preserves byte length & boundaries
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n / 2);
    let mut i = 0usize;
    while i < n {
        if bytes[i] == b'<' {
            if lower[i..].starts_with("<script") {
                match lower[i..].find("</script>") {
                    Some(rel) => {
                        i += rel + 9;
                    }
                    None => break,
                }
                out.push(' ');
                continue;
            }
            if lower[i..].starts_with("<style") {
                match lower[i..].find("</style>") {
                    Some(rel) => {
                        i += rel + 8;
                    }
                    None => break,
                }
                out.push(' ');
                continue;
            }
            match html[i..].find('>') {
                Some(rel) => {
                    i += rel + 1;
                }
                None => break,
            }
            out.push(' ');
            continue;
        }
        let l = utf8_len(bytes[i]).min(n - i);
        out.push_str(&html[i..i + l]);
        i += l;
    }
    let out = decode_html_entities(&out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 整页正文提取：**保留段落结构**，并丢掉导航/页脚这类样板。
///
/// 和 `html_to_text` 分开写，不是重复：那个是给**行内片段**用的（链接文字、搜索结果摘要，
/// 见 `s.find("</a>").map(|e| html_to_text(&s[..e]))` 那几处），调用点期望**单行**，
/// 它最后那句 `split_whitespace().join(" ")` 正是为此。
///
/// 但整页正文走同一条就毁了：一篇文章的所有换行、段落、列表项被压成一行，
/// 抓回来是一堵没有任何结构的墙 —— 界面上没法读，**喂给模型的也是同一堵墙**。
///
/// 这里做三件事：
///   1. 整块跳过 script/style/nav/footer/aside/noscript/svg/form/template/iframe。
///      截图里那串「Claude Platform Docs Messages Managed Agents Admin Resources…」
///      就是 `<nav>` 的内容，它对读者和模型都是纯噪声，还占着上下文预算。
///      **`<header>` 不跳** —— 很多文章把标题放在 `<article><header>` 里，跳了会丢标题。
///   2. 块级标签边界产出换行（p / div / h1-6 / li / br / tr / section / article /
///      blockquote / pre / ul / ol / table / hr），行内标签产出空格。
///   3. 逐行收拢空白，连续空行压成一个。
fn html_to_article_text(html: &str) -> String {
    const SKIP: [&str; 10] = [
        "script", "style", "nav", "footer", "aside", "noscript", "svg", "form", "template",
        "iframe",
    ];
    const BLOCK: [&str; 16] = [
        "p", "div", "br", "li", "tr", "section", "article", "blockquote", "pre", "ul", "ol",
        "table", "hr", "h1", "h2", "h3",
    ];
    const BLOCK2: [&str; 3] = ["h4", "h5", "h6"];

    let lower = html.to_ascii_lowercase(); // ASCII 折叠，字节长度与边界不变
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n / 2);
    let mut i = 0usize;
    'outer: while i < n {
        if bytes[i] == b'<' {
            let rest = &lower[i..];
            for tag in SKIP {
                // `<tag>` / `<tag ...>`，别把 <script> 和 <section> 弄混。
                let open = format!("<{tag}");
                if rest.starts_with(&open)
                    && rest[open.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c == '>' || c == ' ' || c == '/' || c == '\n' || c == '\t')
                {
                    let close = format!("</{tag}>");
                    match rest.find(&close) {
                        Some(rel) => i += rel + close.len(),
                        None => break 'outer,
                    }
                    out.push('\n');
                    continue 'outer;
                }
            }
            let is_block = BLOCK.iter().chain(BLOCK2.iter()).any(|tag| {
                let a = format!("<{tag}");
                let b = format!("</{tag}");
                for pre in [a, b] {
                    if rest.starts_with(&pre)
                        && rest[pre.len()..]
                            .chars()
                            .next()
                            .is_some_and(|c| c == '>' || c == ' ' || c == '/' || c == '\n' || c == '\t')
                    {
                        return true;
                    }
                }
                false
            });
            match html[i..].find('>') {
                Some(rel) => i += rel + 1,
                None => break,
            }
            out.push(if is_block { '\n' } else { ' ' });
            continue;
        }
        let l = utf8_len(bytes[i]).min(n - i);
        out.push_str(&html[i..i + l]);
        i += l;
    }
    let decoded = decode_html_entities(&out);
    // 逐行收拢：行内空白压成单空格，连续空行压成一个。
    let mut lines: Vec<String> = Vec::new();
    let mut blank = 0usize;
    for raw_line in decoded.lines() {
        let line = raw_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank == 1 && !lines.is_empty() {
                lines.push(String::new());
            }
        } else {
            blank = 0;
            lines.push(line);
        }
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Fetch a public web page for the agent. Guards against SSRF (public IPs only,
/// redirects are followed but **re-validated on every hop**), bounds time/size, and returns readable text.
#[tauri::command]
pub async fn web_fetch(url: String) -> Result<String, String> {
    use std::net::ToSocketAddrs;

    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "无效的 URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("只允许 http/https 链接".into()),
    }
    let host = parsed.host_str().ok_or("URL 缺少主机名")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(80);

    // Resolve and require every resolved address to be public (SSRF guard). getaddrinfo is
    // BLOCKING — on Windows a degraded network makes it serially probe DNS→LLMNR→NetBIOS and
    // block 10-30s+, which (run directly on a Tokio worker) freezes that thread and can starve
    // the whole IPC/UI ("联网搜索卡死"). Run it on a blocking thread with a hard 5s cap so a
    // wedged resolver can never freeze the app.
    let host_c = host.clone();
    let addrs: Vec<std::net::SocketAddr> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            (host_c.as_str(), port)
                .to_socket_addrs()
                .map(|it| it.collect::<Vec<_>>())
        }),
    )
    .await
    .map_err(|_| "DNS 解析超时（网络异常，请重试）".to_string())?
    .map_err(|_| "DNS 解析任务失败".to_string())?
    .map_err(|e| format!("DNS 解析失败: {e}"))?;
    if addrs.is_empty() {
        return Err("无法解析主机".into());
    }
    for a in &addrs {
        if !ip_fetch_allowed(a.ip()) {
            return Err("拒绝访问该地址（link-local / 元数据 / 多播等）".into());
        }
    }

    // 重定向必须**逐跳重新校验**，否则上面那圈 IP 检查等于没做。
    //
    // 原来是 `Policy::limited(5)`——只在**第一个** URL 上校验过 IP，之后 5 跳全部放行。
    // 攻击者页面回一个 302 指向 169.254.169.254（云元数据端点），web_fetch 就直接跟过去，
    // 整道检查形同虚设。这个文件上面的注释写的是「no redirects」，和代码已经对不上了；
    // 而同类的 net.rs 用的是 `Policy::none()`，注释还专门写着「3xx 不能把我们弹到内网」。
    //
    // 但不能简单关掉：web_fetch 抓的是真实网页，短链和 http→https 跳转太常见，
    // 一关就大面积失效。所以用自定义策略——每一跳都把目标主机解析一遍，
    // 解析出来的任何一个地址不合格就当场掐断。
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            let Some(host) = attempt.url().host_str() else {
                return attempt.stop();
            };
            // 重定向发生在 reqwest 的同步回调里，做不了异步 DNS；这里用阻塞解析。
            // 代价是一次重定向多一次同步查询（本地缓存命中时几乎为零），
            // 换来的是"每一跳都校验"——这个交换在安全上是必须的。
            let port = attempt.url().port_or_known_default().unwrap_or(80);
            match (host, port).to_socket_addrs() {
                Ok(addrs) => {
                    let mut any = false;
                    for a in addrs {
                        any = true;
                        if !ip_fetch_allowed(a.ip()) {
                            return attempt.error("redirect target is link-local / metadata / multicast");
                        }
                    }
                    // 一个都解析不出来时不放行：宁可失败，也不跟一个没验过的地址。
                    if !any {
                        return attempt.error("redirect target did not resolve");
                    }
                    attempt.follow()
                }
                Err(_) => attempt.error("redirect target did not resolve"),
            }
        }))
        .connect_timeout(std::time::Duration::from_secs(6))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36")
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        // **不要手设 Accept-Encoding。**
        //
        // 这里原来声明 "gzip, deflate, br"，而 Cargo.toml 里 reqwest 的特性集只有 gzip ——
        // 没有 brotli、没有 deflate。更要命的是：**手设这个 header 会关掉 reqwest 的自动解压**
        // （它只对自己加的那个头负责）。于是 Cloudflare 那类默认用 br 的站点，抓回来的是
        // 原始压缩字节 —— 模型拿到一段乱码，而不是正文。
        // 交给 reqwest 自己加：它会按已编译进来的特性声明（gzip），并透明解压。
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Fetch-User", "?1")
        .header("Upgrade-Insecure-Requests", "1")
        .header("Cache-Control", "max-age=0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let code = status.as_u16();

    // Anti-bot wall (403/503/429): fall back to headless Chrome which has a real
    // TLS fingerprint and runs JS — bypasses Dianping/Meituan/etc. cookie walls.
    if code == 403 || code == 503 || code == 429 {
        if let Some(browser) = crate::capture::find_headless_browser() {
            let url_str = url.trim().to_string();
            let rendered = tokio::time::timeout(
                std::time::Duration::from_secs(16),
                tauri::async_runtime::spawn_blocking(move || render_dom(&browser, &url_str)),
            )
            .await;
            if let Ok(Ok(Some(html))) = rendered {
                let text = html_to_article_text(&html);
                if text.len() > 100 {
                    return {
        // 截断必须留痕。原来直接 take(24_000) 就返回，正文在半句话处结束、没有省略号、
        // 没有字数——模型据此得出「这个页面没有提到 X」，而 X 就在第 24001 个字符之后。
        let total = text.chars().count();
        if total > 24_000 {
            let head: String = text.chars().take(24_000).collect();
            Ok(format!(
                "{head}\n\n[已截断] 本页正文共 {total} 字符，这里只给了前 24000 字符——**后面还有内容，不要当成全文**。需要后文就带上更具体的锚点重新抓取。"
            ))
        } else {
            Ok(text)
        }
    };
                }
            }
        }
        return Err(format!(
            "HTTP {} (反爬拦截，无头浏览器也未能获取内容)",
            code
        ));
    }

    if !status.is_success() {
        return Err(format!("HTTP {}", code));
    }
    // 204/205 属于 2xx，但按定义**没有正文**。当成成功会返回空串，界面渲染成绿色的
    // 「0 chars」，模型据此认为「这一页就是空的」—— 而真实原因往往是这个 URL 是个跳转壳
    // （Bing 结果链接就是），或者服务端拒绝给内容。说出来，别装成成功。
    if code == 204 || code == 205 {
        return Err(format!(
            "HTTP {code}（服务端明确表示没有正文）。这多半是个跳转/追踪链接，不是文章页 —— \
             换成真实站点的地址再抓；如果这条 URL 来自搜索结果，用结果里给出的原始域名。"
        ));
    }

    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let max = 800_000usize;
    let mut response = resp;
    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(max as u64) as usize);
    while bytes.len() < max {
        let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? else {
            break;
        };
        let remaining = max - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() >= remaining {
            break;
        }
    }
    let raw = String::from_utf8_lossy(&bytes).to_string();

    let text = if ct.contains("html") || raw.trim_start().starts_with('<') {
        html_to_article_text(&raw)
    } else {
        raw
    };
    {
        // 截断必须留痕。原来直接 take(24_000) 就返回，正文在半句话处结束、没有省略号、
        // 没有字数——模型据此得出「这个页面没有提到 X」，而 X 就在第 24001 个字符之后。
        let total = text.chars().count();
        if total > 24_000 {
            let head: String = text.chars().take(24_000).collect();
            Ok(format!(
                "{head}\n\n[已截断] 本页正文共 {total} 字符，这里只给了前 24000 字符——**后面还有内容，不要当成全文**。需要后文就带上更具体的锚点重新抓取。"
            ))
        } else {
            Ok(text)
        }
    }
}

fn percent_decode_str(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// DuckDuckGo wraps result links as `//duckduckgo.com/l/?uddg=<encoded>&...`.
fn ddg_unwrap(href: &str) -> String {
    if let Some(p) = href.find("uddg=") {
        let enc = href[p + 5..].split('&').next().unwrap_or("");
        percent_decode_str(enc)
    } else if href.starts_with("http") {
        href.to_string()
    } else {
        String::new()
    }
}

/// HTML 实体解码。**一趟扫完**，不做顺序 replace。
///
/// 原来 html_to_text 只认 6 个具名实体，于是 `&#8217;`（右单引号）、`&mdash;`、
/// `&rsquo;`、`&hellip;` 这些原样漏进模型读到的正文——`Don&#8217;t` 这种。
/// 更糟的是它是顺序 replace：先把 `&amp;` 换成 `&`，再把 `&lt;` 换成 `<`，
/// 于是页面上真实存在的字面量 `&amp;lt;` 被**二次解码**成了 `<`。
/// 一趟扫描顺带修掉这条：每个实体只解一次。
///
/// 认不出来的实体原样留着（`AT&T is great;` 里的 `&T is great;` 不是实体）。
pub(crate) fn decode_html_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        // 实体没有很长的。限个窗口，别把整篇正文当成一个实体去扫。
        let semi = tail
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        match semi.and_then(|e| html_entity_value(&tail[1..e])) {
            Some(text) => {
                out.push_str(&text);
                rest = &tail[semi.unwrap_or(0) + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn html_entity_value(body: &str) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    if let Some(num) = body.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse::<u32>().ok()?,
        };
        return char::from_u32(code).map(|c| c.to_string());
    }
    let named = match body {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" | "ensp" | "emsp" | "thinsp" => " ",
        "mdash" => "—",
        "ndash" => "–",
        "hellip" => "…",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "bull" => "•",
        "middot" => "·",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "frac12" => "½",
        "laquo" => "«",
        "raquo" => "»",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "dagger" => "†",
        "Dagger" => "‡",
        "permil" => "‰",
        "larr" => "←",
        "rarr" => "→",
        "harr" => "↔",
        "infin" => "∞",
        "ne" => "≠",
        "le" => "≤",
        "ge" => "≥",
        // 零宽 / 软连字：删掉，留着会把词切开。
        "shy" | "zwnj" | "zwj" | "lrm" | "rlm" => "",
        _ => return None,
    };
    Some(named.to_string())
}

/// Bing 的结果链接是跳转壳，不是真实站点。
///
/// 形如 `https://www.bing.com/ck/a?!&&&p=…&u=a1<base64url>&ntb=1`，而且 href 在 HTML 里是
/// 实体转义过的（`&amp;`）。直接把它交给 web_fetch：实测 **HTTP 204、0 字节、0 次重定向**，
/// 前端还把它渲染成绿色的 `0 chars` —— 模型以为「这一页就是空的」，整条
/// 「搜索 → 打开原文」的链在这里断掉。
///
/// 只做实体解码也不够：解码后能拿到 200，但正文是一句 JS 跳转提示（65 字符），
/// 过不了下游的长度门。必须把 `u=a1` 后面那段 base64url 解出来才是真实 URL。
/// 实测：实时 HTML 里 10 条结果 10 条都是壳，解码后 10/10 全部还原成真实站点。
///
/// 解不出来时**回落到实体解码后的原 href，绝不返回空串** —— 调用处后面有
/// `starts_with("http")` 过滤，返回空会把整条结果丢掉，比不解还糟。
fn html_unescape_attr(s: &str) -> String {
    decode_html_entities(s)
}

/// base64url 解码（无填充，`-`/`_` 字母表）。不引新依赖。
fn base64url_decode(input: &str) -> Option<String> {
    let mut bits: u32 = 0;
    let mut nbits: u32 = 0;
    let mut out: Vec<u8> = Vec::new();
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        bits = (bits << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push(((bits >> nbits) & 0xFF) as u8);
        }
    }
    String::from_utf8(out).ok()
}

fn bing_unwrap(href: &str) -> String {
    let decoded = html_unescape_attr(href);
    if let Some(p) = decoded.find("u=a1") {
        let enc = decoded[p + 4..].split('&').next().unwrap_or("");
        if let Some(real) = base64url_decode(enc) {
            if real.starts_with("http") {
                return real;
            }
        }
    }
    decoded
}

fn parse_ddg_results(html: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find("result__a") {
        rest = &rest[pos + 9..];
        let href = rest
            .find("href=\"")
            .and_then(|h| {
                let s = &rest[h + 6..];
                s.find('"').map(|e| s[..e].to_string())
            })
            .unwrap_or_default();
        let url = ddg_unwrap(&href);
        let title = rest
            .find('>')
            .and_then(|g| {
                let s = &rest[g + 1..];
                s.find("</a>").map(|e| html_to_text(&s[..e]))
            })
            .unwrap_or_default();
        let snippet = rest
            .find("result__snippet")
            .and_then(|sp| {
                let s = &rest[sp..];
                s.find('>').and_then(|g| {
                    let s2 = &s[g + 1..];
                    s2.find("</a>")
                        .or_else(|| s2.find("</div>"))
                        .map(|e| html_to_text(&s2[..e]))
                })
            })
            .unwrap_or_default();
        if !url.is_empty() && !title.is_empty() && !out.iter().any(|(_, u, _)| u == &url) {
            out.push((title, url, snippet));
        }
        if out.len() >= 10 {
            break;
        }
    }
    out
}

/// Web search (Google, Bing, and DuckDuckGo scraping, no API key) so the agent can FIND docs/articles,
/// then `web_fetch` the ones it wants. Returns title + real URL + snippet.
#[tauri::command]
pub async fn web_search(query: String) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("空搜索词".into());
    }
    // The old code hit ONE DuckDuckGo endpoint with no fallback — it gets rate-
    // limited / blocked a lot, which is exactly why search "搜不到". Now we try the
    // html endpoint then fall back to the lite endpoint (lighter, far less blocked),
    // each with a rotated UA, returning the first non-empty result set.
    // Hard OVERALL deadline: a wedged network or a run of blocked engines must never hang the
    // agent turn. The fast scrape race (~8s cap) → headless-browser fallback all live inside 30s;
    // if even that blows through, return "no results" so the agent gets a graceful message, not a
    // frozen tool call.
    let (results, ok_sources, empty_sources) = tokio::time::timeout(Duration::from_secs(30), async {
        let (mut r, mut ok, mut empty) = ddg_search_multi(q).await;
        if r.is_empty() {
            // The bare HTTP scrape got blocked (anti-bot walls fingerprint reqwest's TLS / reject
            // its UA). Fall back to a REAL headless-browser render — the agent's own Chrome does the
            // search (real TLS fingerprint + JS + UA), getting through where the scrape can't.
            r = browser_render_search(q).await;
            if !r.is_empty() {
                ok.push("headless-browser");
                empty.retain(|s| *s != "headless-browser");
            }
        }
        (r, ok, empty)
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), Vec::new(), Vec::new()));
    if results.is_empty() {
        return Ok(format!(
            "「{q}」这次没搜到结果（搜索引擎可能限流、反爬，或当前关键词没有索引结果）。不要原样重发或只换近义词反复搜索：已有明确官方 URL 就直接 web_fetch；只有出现新的具体假设时才换一次真正不同的来源或检索方式。仍无新增证据就停止，并如实说明这次没有检索到可验证结果。"
        ));
    }
    // 表头不能写死「三引擎合并」——每个抓取器失败都是 `Err(_) => Vec::new()`，
    // 三个全挂也照样这么写，于是「三大引擎都没搜到」和「三个抓取器全被拦了」同形。
    // 抬头要报**这次到底有几路回了东西**。
    //
    // 原来只写一句「多来源合并去重；某个来源被拦截时结果会少于预期」——听起来像
    // 偶发。而实测（2026-08-20）五路里三路是**结构性**失效：google 只回 JS 壳页、
    // duckduckgo 两路回 202 反爬挑战页。于是「结果少」到底是这个词冷门，还是三路
    // 常年挂着，模型分不出来，只能猜——正是「感觉在瞎猜」的一种。
    let src_note = format!(
        "本次 {}/{} 个来源返回了结果（有结果：{}；空手：{}）",
        ok_sources.len(),
        ok_sources.len() + empty_sources.len(),
        if ok_sources.is_empty() { "无".to_string() } else { ok_sources.join("、") },
        if empty_sources.is_empty() { "无".to_string() } else { empty_sources.join("、") },
    );
    let mut out = if results.is_empty() {
        format!("搜索「{q}」：**没有任何来源返回结果**——{src_note}。这更可能是抓取器被拦截/限流，而不是这个词没有结果。换个词再试，或改用 web_fetch 直接抓已知地址。\n")
    } else {
        format!("搜索「{q}」的结果（多来源合并去重，共 {} 条）。{src_note}——**空手的那几个是常年被反爬拦着，不是这个词冷门**，别据此判断「这个话题没资料」。\n", results.len())
    };
    for (i, (title, url, snippet)) in results.iter().take(12).enumerate() {
        out.push_str(&format!(
            "\n{}. {}\n   {}\n   {}\n",
            i + 1,
            title,
            url,
            snippet.chars().take(240).collect::<String>()
        ));
    }
    out.push_str("\n（用 web_fetch 打开上面任意 URL 读全文）");
    Ok(out)
}

/// Run ALL search engines concurrently, MERGE and deduplicate results.
/// Google goes first in merge order, followed by Bing, DuckDuckGo HTML, then DDG Lite.
/// Each engine has its own 8s timeout so the
/// total wall-clock is max ~8s (all run in parallel).
/// 返回 (合并结果, 有结果的来源名, 空手而归的来源名)。
///
/// 后两个不是装饰：实测五路里三路已经结构性失效（google 只回 JS 壳页、
/// ddg 两路回 202 挑战页），而回执原来只说一句「多来源合并去重」——
/// 于是「结果少」到底是这个词冷门、还是三个来源全挂了，模型分不出来，
/// 只能猜。把事实报出去。
async fn ddg_search_multi(q: &str) -> (Vec<(String, String, String)>, Vec<&'static str>, Vec<&'static str>) {
    let (google, bing, ddg, lite, brave) = tokio::join!(
        scrape_google(q.to_string()),
        scrape_bing(q.to_string()),
        scrape_ddg_html(q.to_string()),
        scrape_ddg_lite(q.to_string()),
        scrape_brave(q.to_string()),
    );
    let sources: [(&'static str, Vec<(String, String, String)>); 5] = [
        ("bing", bing),
        ("brave", brave),
        ("google", google),
        ("duckduckgo", ddg),
        ("duckduckgo-lite", lite),
    ];
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    let mut ok = Vec::new();
    let mut empty = Vec::new();
    for (name, rows) in sources {
        if rows.is_empty() {
            empty.push(name);
            continue;
        }
        ok.push(name);
        for r in rows {
            if seen.insert(r.1.clone()) {
                merged.push(r);
            }
        }
    }
    (merged, ok, empty)
}

const SEARCH_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_SEARCH_RESPONSE_BYTES: usize = 800_000;

/// A search should be fast; bound it much tighter than a page fetch. A source that hasn't
/// answered in 8s is treated as blocked/dead so the race can settle on a working one.
fn search_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .ok()
}

/// Search result pages are only parsed for a few short result cards. Do not let
/// an upstream error page or an accidentally unbounded response consume the
/// process heap before the 8-second search deadline can take effect.
async fn read_search_response_text(response: reqwest::Response) -> Result<String, reqwest::Error> {
    // is_success() 放行整个 2xx，而 DuckDuckGo 的**反爬挑战页**回的是 202 —— 它有正文、
    // 有 HTML，只是里面一条结果都没有。当成正常结果页去解析，得到 0 条，
    // 和「这个词真的没搜到」不可区分。202/204/205 一律不当结果页。
    let st = response.status().as_u16();
    if !response.status().is_success() || st == 202 || st == 204 || st == 205 {
        return Ok(String::new());
    }

    let mut response = response;
    let capacity = response
        .content_length()
        .unwrap_or_default()
        .min(MAX_SEARCH_RESPONSE_BYTES as u64) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    while bytes.len() < MAX_SEARCH_RESPONSE_BYTES {
        let Some(chunk) = response.chunk().await? else {
            break;
        };
        let remaining = MAX_SEARCH_RESPONSE_BYTES - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() >= remaining {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn scrape_ddg_html(q: String) -> Vec<(String, String, String)> {
    let client = match search_client() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let resp = client
        .post("https://html.duckduckgo.com/html/")
        .header(reqwest::header::USER_AGENT, SEARCH_UA)
        .form(&[("q", q.as_str()), ("kl", "wt-wt")])
        .send()
        .await;
    match resp {
        Ok(r) => read_search_response_text(r)
            .await
            .map(|h| parse_ddg_results(&h))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn scrape_bing(q: String) -> Vec<(String, String, String)> {
    let client = match search_client() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let has_cjk = q.chars().any(|c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3040}'..='\u{30ff}').contains(&c)
            || ('\u{ac00}'..='\u{d7af}').contains(&c)
    });
    let (domain, lang) = if has_cjk {
        ("cn.bing.com", "zh-CN,zh;q=0.9,en;q=0.8")
    } else {
        ("www.bing.com", "en-US,en;q=0.9")
    };
    let url = format!("https://{domain}/search?q={}", urlencoding(&q));
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, SEARCH_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, lang)
        .send()
        .await;
    match resp {
        Ok(r) => read_search_response_text(r)
            .await
            .map(|h| parse_bing(&h))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn scrape_google(q: String) -> Vec<(String, String, String)> {
    let client = match search_client() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let url = format!(
        "https://www.google.com/search?q={}&num=10&hl=zh-CN",
        urlencoding(&q)
    );
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, SEARCH_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await;
    match resp {
        Ok(r) => read_search_response_text(r)
            .await
            .map(|h| parse_google(&h))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn parse_google(html: &str) -> Vec<(String, String, String)> {
    let mut results = Vec::new();
    let mut pos = 0;
    while let Some(div_start) = html[pos..].find("<div class=\"g\"") {
        let abs = pos + div_start;
        let chunk_end = html[abs..]
            .find("</div>")
            .map(|e| abs + e + 6)
            .unwrap_or(html.len().min(abs + 3000));
        let chunk = &html[abs..chunk_end];

        let title = extract_between(chunk, "<h3", "</h3>")
            .map(strip_tags)
            .unwrap_or_default();
        let url = extract_between(chunk, "<a href=\"/url?q=", "&")
            .map(|s| s.to_string())
            .or_else(|| extract_between(chunk, "<a href=\"http", "\"").map(|u| format!("http{u}")))
            .unwrap_or_default();
        // 抓下来的 href 同样要走统一解码：只换 &amp; 的话，`&#38;` / `&#x26;`
        // 这类数字实体会原样留在 URL 里，打开就是 404。
        let url = decode_html_entities(&url);
        let snippet = extract_between(chunk, "<span class=\"", "</span>")
            .map(|s| {
                let inner = s.find('>').map(|i| &s[i + 1..]).unwrap_or(s);
                strip_tags(inner)
            })
            .unwrap_or_default();

        if !title.is_empty() && (url.starts_with("http://") || url.starts_with("https://")) {
            results.push((title, url, snippet));
        }
        pos = chunk_end;
        if results.len() >= 10 {
            break;
        }
    }
    if results.is_empty() {
        let mut pos2 = 0;
        while let Some(a_start) = html[pos2..].find("<a href=\"/url?q=") {
            let abs2 = pos2 + a_start + 16;
            if let Some(end) = html[abs2..].find('&') {
                let raw = &html[abs2..abs2 + end];
                let url = percent_decode_str(raw);
                if url.starts_with("http")
                    && !url.contains("google.com")
                    && !url.contains("accounts.google")
                {
                    let title = extract_between(&html[abs2..], ">", "</a>")
                        .map(strip_tags)
                        .unwrap_or_else(|| url.clone());
                    if !title.is_empty() {
                        results.push((title, url, String::new()));
                    }
                }
            }
            pos2 = abs2 + 10;
            if results.len() >= 10 {
                break;
            }
        }
    }
    results
}

fn extract_between<'a>(hay: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = hay.find(open)? + open.len();
    let end = hay[start..].find(close)? + start;
    Some(&hay[start..end])
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    out.trim().to_string()
}

async fn scrape_ddg_lite(q: String) -> Vec<(String, String, String)> {
    let client = match search_client() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let resp = client
        .post("https://lite.duckduckgo.com/lite/")
        .header(reqwest::header::USER_AGENT, SEARCH_UA)
        .form(&[("q", q.as_str())])
        .send()
        .await;
    match resp {
        Ok(r) => read_search_response_text(r)
            .await
            .map(|h| parse_ddg_lite(&h))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Brave Search —— 第五路，也是实测下来**唯一还能和 Bing 并肩**的裸抓来源。
///
/// 为什么要加它（2026-08-20 实测，同一台机、同一个 UA）：
///   google      200 / 92KB  但整页**零个 `<h3>`** —— 现在只回一个 JS 壳页
///                （有 noscript / enablejs），parse_google 永远拿不到东西
///   ddg html    202 / 14KB  反爬挑战页（read_search_response_text 已按 202 丢弃）
///   ddg lite    202 / 14KB  同上
///   bing        200 / 125KB 30 条 —— 唯一活着的
///   brave       200 / 293KB 20 条 —— 结构稳定，标题和链接都能干净抽出
/// 四路里死了三路，`web_search` 实际是单点。再挂一路，Bing 哪天也被拦时不至于归零。
async fn scrape_brave(q: String) -> Vec<(String, String, String)> {
    let client = match search_client() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let url = format!("https://search.brave.com/search?q={}", urlencoding(&q));
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, SEARCH_UA)
        .send()
        .await;
    match resp {
        Ok(r) => read_search_response_text(r)
            .await
            .map(|h| parse_brave(&h))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 从 Brave 的结果卡里抽 (标题, 链接, 摘要)。
///
/// 卡片形状：`<a href="URL" …> … <div class="…title…">标题</div> … </a>`，
/// 摘要在同一张卡后面的 `<div class="snippet-description">`（拿不到就留空——
/// 标题和链接才是必需的，摘要缺失不该让整条结果消失）。
fn parse_brave(html: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = html;
    while let Some(a) = rest.find("<a href=\"http") {
        let tail = &rest[a + 9..];
        let Some(qend) = tail.find('"') else { break };
        let url = &tail[..qend];
        let card_end = tail.find("</a>").unwrap_or(tail.len());
        let card = &tail[..card_end];
        // 标题：卡片里第一个 class 含 "title" 的块
        let title = card
            .find("title")
            .and_then(|t| card[t..].find('>').map(|g| t + g + 1))
            .and_then(|st| card[st..].find("</").map(|e| &card[st..st + e]))
            .map(strip_tags)
            .unwrap_or_default();
        let title = title.trim().to_string();
        if !title.is_empty()
            && title.chars().count() >= 3
            && !url.contains("brave.com")
            && seen.insert(url.to_string())
        {
            out.push((title, url.to_string(), String::new()));
        }
        rest = &tail[card_end.min(tail.len())..];
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// Last-resort search via a REAL headless-browser render (`chrome --dump-dom`).
/// A real Chrome (genuine TLS fingerprint, runs JS, real UA) gets through the
/// anti-bot walls that block the bare reqwest scrape — i.e. the agent's own
/// browser performs the search. Bounded by a hard timeout so a wedged Chrome
/// can't hang the turn; on timeout we just return what we have (often nothing).
/// `pub(crate)` 而非私有：knowledge.rs 的 ddg_surface_checked 在被反爬拦下时
/// 降级到这里 —— 那边是裸 reqwest，穿不过 202 挑战页，而这里是真 Chrome。
pub(crate) async fn browser_render_search(q: &str) -> Vec<(String, String, String)> {
    let browser = match crate::capture::find_headless_browser() {
        Some(b) => b,
        None => return Vec::new(),
    };
    // (url, parser-kind): 0 = Bing b_algo, 1 = DDG html result__a.
    let targets = [
        (
            format!(
                "https://www.bing.com/search?q={}&setlang=en",
                urlencoding(q)
            ),
            0u8,
        ),
        (
            format!("https://html.duckduckgo.com/html/?q={}", urlencoding(q)),
            1u8,
        ),
    ];
    for (url, kind) in targets {
        let browser2 = browser.clone();
        let url2 = url.clone();
        let rendered = tokio::time::timeout(
            std::time::Duration::from_secs(14), // was 28s ×2 targets = up to 56s; keep the fallback snappy
            tauri::async_runtime::spawn_blocking(move || render_dom(&browser2, &url2)),
        )
        .await;
        if let Ok(Ok(Some(html))) = rendered {
            let r = if kind == 0 {
                parse_bing(&html)
            } else {
                parse_ddg_results(&html)
            };
            if !r.is_empty() {
                return r;
            }
        }
    }
    Vec::new()
}

/// Render `url` in headless Chrome and return its fully-rendered DOM (stdout of
/// `--dump-dom`). Chrome exits on its own after `--virtual-time-budget`, so this
/// doesn't hang; the caller still wraps it in a timeout as a backstop.
fn render_dom(browser: &str, url: &str) -> Option<String> {
    let out = crate::process_util::command(browser)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            "--disable-extensions",
            "--disable-background-networking",
            "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "--virtual-time-budget=9000",
            "--dump-dom",
            url,
        ])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if out.stdout.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Minimal percent-encoding for a query string (no extra crate).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Parse Bing's organic results (`<li class="b_algo"> … <h2><a href>title</a> … <p>snippet</p>`).
fn parse_bing(html: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut from = 0;
    while let Some(rel) = html[from..].find("b_algo") {
        let abs = from + rel;
        from = abs + 6;
        let mut end = (abs + 4000).min(html.len());
        // A byte limit can land in the middle of a multi-byte character. Check
        // the original string before slicing; slicing first is itself a panic.
        while end > abs && !html.is_char_boundary(end) {
            end -= 1;
        }
        let region = &html[abs..end];
        let (href, title) = region
            .find("<a ")
            .and_then(|a| {
                let s = &region[a..];
                let href = s.find("href=\"").and_then(|h| {
                    let s2 = &s[h + 6..];
                    s2.find('"').map(|e| s2[..e].to_string())
                })?;
                let title = s.find('>').and_then(|g| {
                    let s2 = &s[g + 1..];
                    s2.find("</a>").map(|e| html_to_text(&s2[..e]))
                })?;
                // 解壳 + 实体解码：拿到真实站点 URL，否则整条「搜索 → 打开原文」的链是断的。
                Some((bing_unwrap(&href), title))
            })
            .unwrap_or_default();
        let snippet = region
            .find("<p")
            .and_then(|p| {
                let s = &region[p..];
                s.find('>').and_then(|g| {
                    let s2 = &s[g + 1..];
                    s2.find("</p>").map(|e| html_to_text(&s2[..e]))
                })
            })
            .unwrap_or_default();
        if href.starts_with("http") && !title.is_empty() && !out.iter().any(|(_, u, _)| u == &href)
        {
            out.push((title, href, snippet));
        }
        if out.len() >= 10 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod search_result_parser_tests {
    use super::{parse_bing, read_search_response_text, MAX_SEARCH_RESPONSE_BYTES};
    use std::io::{Read, Write};

    #[test]
    fn bing_region_limit_never_slices_inside_utf8() {
        let mut html = String::from(
            r#"<li class="b_algo"><h2><a href="https://example.com">中文标题</a></h2><p>中文摘要</p>"#,
        );
        let result_start = html.find("b_algo").unwrap();
        let byte_limit = result_start + 4000;
        html.push_str(&"x".repeat(byte_limit - 1 - html.len()));
        html.push('中');
        html.push_str("</li>");

        assert!(!html.is_char_boundary(byte_limit));
        let results = parse_bing(&html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "中文标题");
        assert_eq!(results[0].1, "https://example.com");
        assert_eq!(results[0].2, "中文摘要");
    }

    #[tokio::test]
    async fn search_response_read_stops_at_the_page_cap() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0_u8; 4096]);
            let body = "x".repeat(MAX_SEARCH_RESPONSE_BYTES + 64);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(body.as_bytes());
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        let body = read_search_response_text(response).await.unwrap();
        assert_eq!(body.len(), MAX_SEARCH_RESPONSE_BYTES);
        server.join().unwrap();
    }
}

/// Parse the simple `lite.duckduckgo.com/lite/` results table.
fn parse_ddg_lite(html: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut from = 0;
    while let Some(rel) = html[from..].find("result-link") {
        let abs = from + rel;
        from = abs + 11;
        // The enclosing <a ...> starts before "result-link"; grab its href + text.
        let a_start = html[..abs].rfind("<a").unwrap_or(abs);
        let tag = &html[a_start..];
        let href = tag
            .find("href=\"")
            .and_then(|h| {
                let s = &tag[h + 6..];
                s.find('"').map(|e| s[..e].to_string())
            })
            .unwrap_or_default();
        let url = ddg_unwrap(&href);
        let title = tag
            .find('>')
            .and_then(|g| {
                let s = &tag[g + 1..];
                s.find("</a>").map(|e| html_to_text(&s[..e]))
            })
            .unwrap_or_default();
        // Snippet: the next `result-snippet` cell after this link.
        let snippet = html[abs..]
            .find("result-snippet")
            .and_then(|sp| {
                let s = &html[abs + sp..];
                s.find('>').and_then(|g| {
                    let s2 = &s[g + 1..];
                    s2.find("</td>")
                        .or_else(|| s2.find("</a>"))
                        .map(|e| html_to_text(&s2[..e]))
                })
            })
            .unwrap_or_default();
        if !url.is_empty() && !title.is_empty() && !out.iter().any(|(_, u, _)| u == &url) {
            out.push((title, url, snippet));
        }
        if out.len() >= 10 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod article_text_tests {
    use super::*;

    /// 抓回来的内容此前是**一堵墙**：`html_to_text` 最后一句
    /// `split_whitespace().join(" ")` 把整页的换行和段落全压成一行空格。
    /// 界面上没法读，而**喂给模型的是同一堵墙**。
    #[test]
    fn 整页正文要保留段落结构() {
        let html = "<h1>标题</h1><p>第一段。</p><p>第二段。</p><ul><li>要点一</li><li>要点二</li></ul>";
        let out = html_to_article_text(html);
        assert!(out.contains('\n'), "整页正文被压成一行了：{out:?}");
        let lines: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
        assert!(lines.len() >= 5, "段落没有分开，只有 {} 行：{out:?}", lines.len());
        assert!(lines.contains(&"标题"), "标题丢了");
        assert!(lines.contains(&"第一段。"), "段落丢了");
        assert!(lines.contains(&"要点一"), "列表项丢了");
    }

    /// 导航/页脚是纯噪声：读者不看，而它还占着模型的上下文预算。
    /// 用户截图里那串「Claude Platform Docs Messages Managed Agents Admin Resources…」
    /// 就是 <nav> 的内容。
    #[test]
    fn 导航页脚这类样板要整块丢掉() {
        let html = "<nav>Docs Messages Managed Agents Admin Resources</nav>\
                    <article><p>真正的正文。</p></article>\
                    <footer>版权所有</footer><aside>相关阅读</aside>";
        let out = html_to_article_text(html);
        assert!(out.contains("真正的正文。"), "正文丢了：{out:?}");
        for noise in ["Managed Agents", "版权所有", "相关阅读"] {
            assert!(!out.contains(noise), "{noise} 没被丢掉：{out:?}");
        }
    }

    /// `<header>` **不能**跳：很多文章把标题放在 `<article><header>` 里，跳了会丢标题。
    #[test]
    fn header_不跳过_否则文章标题会丢() {
        let out = html_to_article_text("<article><header><h1>文章标题</h1></header><p>正文</p></article>");
        assert!(out.contains("文章标题"), "文章标题被当成样板丢掉了：{out:?}");
    }

    /// 跳过判定必须认**标签边界**，不能只比前缀。
    ///
    /// 用 `<section>` / `<article>` 试是试不出来的 —— 它们和 `<script>` / `<aside>`
    /// 第三个字母就分岔，裸前缀也不会混（第一版就这么写的，变异实测漏网）。
    /// 真正只有边界判定挡得住的是**自定义元素**：`<nav-bar>` / `<form-field>` 这类
    /// 在组件化站点里很常见，裸前缀会把它们整块吞掉，正文跟着一起没。
    #[test]
    fn 跳过判定要认标签边界_不是前缀() {
        let out = html_to_article_text("<nav-bar><p>组件里的正文要留下</p></nav-bar>");
        assert!(out.contains("组件里的正文要留下"), "<nav-bar> 被当成 <nav> 整块吞了：{out:?}");
        let out2 = html_to_article_text("<form-field><p>也要留下</p></form-field>");
        assert!(out2.contains("也要留下"), "<form-field> 被当成 <form> 整块吞了：{out2:?}");
        // 顺带确认真正的 <nav> 仍然被丢掉 —— 放宽不是拆掉。
        let out3 = html_to_article_text("<nav>导航噪声</nav><p>正文</p>");
        assert!(!out3.contains("导航噪声") && out3.contains("正文"), "真 <nav> 没被丢：{out3:?}");
    }

    /// script/style 仍要整块丢（这条是从 html_to_text 继承来的行为，不能丢）。
    #[test]
    fn 脚本和样式仍然整块丢掉() {
        let out = html_to_article_text("<style>.a{color:red}</style><script>var x=1;</script><p>正文</p>");
        assert!(out.contains("正文"));
        assert!(!out.contains("color:red") && !out.contains("var x"), "脚本/样式漏出来了：{out:?}");
    }

    /// 连续空行压成一个，别把墙换成一片空白。
    #[test]
    fn 连续空行要压成一个() {
        let out = html_to_article_text("<p>一</p><div></div><div></div><div></div><p>二</p>");
        assert!(!out.contains("\n\n\n"), "出现了三连空行：{out:?}");
    }

    /// **行内片段那条路不能被带偏。** html_to_text 的调用点（链接文字、摘要）期望单行。
    #[test]
    fn 行内提取仍然是单行() {
        let out = html_to_text("<a href=\"#\">点<b>这</b>里</a>");
        assert!(!out.contains('\n'), "行内提取混进了换行：{out:?}");
    }
}

#[cfg(test)]
mod web_fetch_redirect_tests {
    use super::ip_fetch_allowed;

    /// 云元数据端点（169.254.169.254）是 SSRF 的经典目标：AWS/GCP/Azure 上一个 GET
    /// 就能拿到实例凭据。这条守的是判据本身。
    #[test]
    fn the_cloud_metadata_endpoint_is_refused() {
        for bad in [
            "169.254.169.254", // 云元数据
            "169.254.1.1",     // link-local 其余部分
            "0.0.0.0",         // Linux 上连它就是连本机
            "255.255.255.255", // 广播
            "224.0.0.1",       // 多播
            "192.0.2.1",       // TEST-NET-1，文档保留段
        ] {
            let ip: std::net::IpAddr = bad.parse().unwrap();
            assert!(!ip_fetch_allowed(ip), "{bad} 应当被拒绝");
        }
        for good in ["93.184.216.34", "1.1.1.1", "8.8.8.8"] {
            let ip: std::net::IpAddr = good.parse().unwrap();
            assert!(ip_fetch_allowed(ip), "{good} 是正常公网地址，不该被拒");
        }
        // IPv6 的 link-local 同样是元数据入口（fe80::/10）
        let v6: std::net::IpAddr = "fe80::1".parse().unwrap();
        assert!(!ip_fetch_allowed(v6));
    }

    /// 真正的洞不在判据，在**只校验第一跳**。
    #[test]
    fn redirects_are_revalidated_on_every_hop_not_just_the_first() {
        let raw = include_str!("ai.rs");
        // 剥注释再断言：修复的说明里原样引用了旧写法（Policy::limited），
        // 不剥的话断言匹配的是注释而不是代码。这个坑本轮已经踩过五次。
        let src: String = raw
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let src = src.as_str();
        // 原来只在第一个 URL 校验过 IP，之后 5 跳全部放行。攻击者页面回一个 302
        // 指向云元数据端点，整道检查就形同虚设。
        // 拼出来找，不要写成字面量——include_str! 读的是**整个文件**（含本测试模块），
        // 断言自己的字符串字面量会匹配它自己。剥注释救不了这一层，因为它是代码。
        let banned = format!("redirect(reqwest::redirect::Policy::{}(5))", "limited");
        assert!(!src.contains(&banned), "又变回只校验第一跳了");
        assert!(src.contains("Policy::custom(|attempt|"), "重定向必须走自定义策略");
        // 策略里必须真的调判据，而不是只数跳数
        let policy_start = src.find("Policy::custom(|attempt|").unwrap();
        let policy = &src[policy_start..policy_start + 1600];
        assert!(policy.contains("ip_fetch_allowed(a.ip())"), "每一跳都要过 IP 判据");
        assert!(policy.contains("attempt.previous().len() >= 5"), "跳数上限不能丢");
        // 解析不出地址时**不能**放行——宁可失败也别跟一个没验过的地址
        assert!(
            policy.contains("redirect target did not resolve"),
            "解析失败必须掐断，不能默认 follow"
        );
        // 注释和代码要对得上：原来写着 "no redirects" 而代码在跟 5 跳（这条对**原文**判断）
        let stale_doc = format!("/// no {}), bounds time/size", "redirects");
        assert!(!raw.contains(&stale_doc), "注释还在说不跟重定向");
    }
}


#[cfg(test)]
mod bing_unwrap_tests {
    use super::{base64url_decode, bing_unwrap, html_unescape_attr};

    /// Bing 的结果链接是跳转壳。直接交给 web_fetch 得到 HTTP 204 / 0 字节，
    /// 整条「搜索 → 打开原文」的链在这里断掉。
    #[test]
    fn bing_wrapper_urls_unwrap_to_the_real_site() {
        // 真实形态：href 在 HTML 里是实体转义的，u=a1 后面是无填充的 base64url。
        let real = "https://doc.rust-lang.org/book/ch10-01-syntax.html";
        let enc = {
            // 就地编码一份，避免把长串写死进测试
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let b = real.as_bytes();
            let mut o = String::new();
            for c in b.chunks(3) {
                let n = (c[0] as u32) << 16
                    | (*c.get(1).unwrap_or(&0) as u32) << 8
                    | (*c.get(2).unwrap_or(&0) as u32);
                let take = c.len() + 1;
                for i in 0..take {
                    o.push(T[((n >> (18 - i * 6)) & 63) as usize] as char);
                }
            }
            o
        };
        let href = format!("https://www.bing.com/ck/a?!&amp;&amp;&amp;p=abc&amp;u=a1{enc}&amp;ntb=1");
        assert_eq!(bing_unwrap(&href), real, "跳转壳没解开 —— web_fetch 会拿到 204 / 0 字节");

        // 解不出来时回落到实体解码后的原 href，**绝不返回空串**：
        // 调用处后面有 starts_with("http") 过滤，返回空会把整条结果整个丢掉，比不解还糟。
        let bad = "https://www.bing.com/ck/a?p=1&amp;u=a1@@@notbase64@@@&amp;ntb=1";
        let got = bing_unwrap(bad);
        assert!(got.starts_with("http"), "解不出来时返回了空串，整条结果会被丢掉");
        assert!(!got.contains("&amp;"), "实体没解码");

        // 本来就是真实 URL 的（有些结果不走壳）原样通过。
        assert_eq!(bing_unwrap("https://example.com/a?x=1&amp;y=2"), "https://example.com/a?x=1&y=2");
    }

    /// 别声明自己解不了的内容编码。
    ///
    /// 手设 Accept-Encoding 会**关掉 reqwest 的自动解压**（它只对自己加的那个头负责），
    /// 而 Cargo.toml 的特性集里只有 gzip —— 声明 br 的结果是：Cloudflare 那类默认用 br 的
    /// 站点抓回来是原始压缩字节，模型拿到一段乱码而不是正文。
    #[test]
    fn never_advertise_an_encoding_we_cannot_decode() {
        let whole = include_str!("ai.rs");
        let src = match whole.find("mod bing_unwrap_tests") {
            Some(i) => &whole[..i],
            None => whole,
        };
        assert!(
            !src.contains("ACCEPT_ENCODING"),
            "又手设了 Accept-Encoding —— 那会关掉自动解压；\
             要支持 br/deflate 得先给 Cargo.toml 的 reqwest 加上对应特性"
        );
    }

    #[test]
    fn base64url_decoder_handles_unpadded_and_rejects_garbage() {
        assert_eq!(base64url_decode("aGVsbG8").as_deref(), Some("hello"), "无填充要能解");
        assert_eq!(base64url_decode("aGVsbG8=").as_deref(), Some("hello"), "带填充也要能解");
        assert!(base64url_decode("@@@").is_none(), "垃圾输入必须返回 None，不能吐半截字符串");
        assert_eq!(html_unescape_attr("a&amp;b&quot;c"), "a&b\"c");
    }
}

#[cfg(test)]
mod html_entity_tests {
    use super::decode_html_entities;

    /// 原来 html_to_text 只认 6 个具名实体，数字实体全部原样漏进模型读到的正文。
    #[test]
    fn numeric_entities_are_decoded() {
        assert_eq!(decode_html_entities("Don&#8217;t"), "Don\u{2019}t");
        assert_eq!(decode_html_entities("&#x27;quoted&#x27;"), "'quoted'");
        assert_eq!(decode_html_entities("&#39;"), "'");
        assert_eq!(decode_html_entities("caf&#233;"), "café");
    }

    #[test]
    fn common_named_entities_are_decoded() {
        assert_eq!(
            decode_html_entities("a &mdash; b &hellip; c&rsquo;s"),
            "a — b … c\u{2019}s"
        );
        assert_eq!(decode_html_entities("&amp;&lt;&gt;&quot;&nbsp;x"), "&<>\" x");
    }

    /// 顺序 replace 的老毛病：先 &amp;→& 再 &lt;→<，页面上真实存在的字面量
    /// `&amp;lt;` 被二次解码成了 `<`。一趟扫描每个实体只解一次。
    #[test]
    fn no_double_decoding() {
        assert_eq!(decode_html_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_html_entities("&amp;amp;"), "&amp;");
    }

    /// 认不出来的原样留着 —— `AT&T is great;` 里那段不是实体。
    #[test]
    fn non_entities_are_left_alone() {
        assert_eq!(decode_html_entities("AT&T is great; really"), "AT&T is great; really");
        assert_eq!(decode_html_entities("a & b"), "a & b");
        assert_eq!(decode_html_entities("&notarealentity;"), "&notarealentity;");
        // 没有分号的 & 不吃掉后面的内容。
        assert_eq!(decode_html_entities("x&y&z"), "x&y&z");
        assert_eq!(decode_html_entities("no ampersand here"), "no ampersand here");
    }

    /// 窗口是按**字符**数的，多字节字符不能把切片切在半个字符上。
    #[test]
    fn multibyte_text_does_not_panic() {
        assert_eq!(decode_html_entities("中文&中文中文中文中文中文;后面"), "中文&中文中文中文中文中文;后面");
        assert_eq!(decode_html_entities("表格&nbsp;里的中文"), "表格 里的中文");
    }

    /// 零宽 / 软连字要删掉，留着会把词切开。
    #[test]
    fn zero_width_entities_are_removed() {
        assert_eq!(decode_html_entities("Java&shy;Script"), "JavaScript");
        assert_eq!(decode_html_entities("a&zwnj;b"), "ab");
    }

    /// 全仓的手写实体解码必须**一份都不剩**。
    ///
    /// 上一版只钉了两个函数名，于是 knowledge.rs 的 strip_html（11 个调用点，
    /// 各社区/资讯源的正文摘要）和 files.rs 的 strip_xml（docx/xlsx 正文）
    /// 都还带着这次要修的两个毛病：数字实体漏给模型、顺序 replace 把
    /// `&amp;lt;` 二次解码成 `<`。这条改成**扫全仓**，谁再手写第五份都会红。
    #[test]
    fn no_hand_rolled_entity_table_survives_anywhere() {
        for (name, src) in [
            ("ai.rs", include_str!("ai.rs")),
            ("knowledge.rs", include_str!("knowledge.rs")),
            ("files.rs", include_str!("files.rs")),
        ] {
            // 只看代码，不看注释——注释里会原样引着这些片段（刚踩过）。
            let code: String = src
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for needle in ["\"&amp;\"", "\"&lt;\"", "\"&nbsp;\"", "\"&#39;\"", "\"&#8217;\""] {
                assert!(
                    !code.contains(&format!(".replace({needle}")),
                    "{name} 里又出现了手写的实体 replace（{needle}）—— 统一走 decode_html_entities"
                );
            }
        }

        // 两个曾经漏网的函数，单独钉一遍它们真的改走统一解码了。
        for (name, src, func) in [
            ("knowledge.rs", include_str!("knowledge.rs"), "fn strip_html("),
            ("files.rs", include_str!("files.rs"), "fn strip_xml("),
        ] {
            let body = src
                .split(func)
                .nth(1)
                .and_then(|s| s.split("\n}\n").next())
                .unwrap_or_else(|| panic!("{name} 里 {func} 不见了"));
            assert!(
                body.contains("crate::ai::decode_html_entities"),
                "{name} 的 {func} 没走统一解码 —— 数字实体照样漏、&amp;lt; 照样二次解码"
            );
        }
    }

    /// 三份手写解码器已经并成一份 —— 名单漂了就是三种不同的漏法。
    #[test]
    fn the_three_decoders_are_one() {
        let ai = include_str!("ai.rs");
        let attr = ai
            .split("fn html_unescape_attr(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("html_unescape_attr 不见了");
        assert!(
            attr.contains("decode_html_entities(s)") && !attr.contains(".replace("),
            "html_unescape_attr 又自己手写了一份实体名单"
        );
        let knowledge = include_str!("knowledge.rs");
        let decode = knowledge
            .split("fn html_decode(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("html_decode 不见了");
        assert!(
            decode.contains("crate::ai::decode_html_entities") && !decode.contains(".replace("),
            "knowledge 的 html_decode 又自己手写了一份实体名单"
        );
    }
}

#[cfg(test)]
mod web_search_sources_tests {
    use super::parse_brave;

    /// 实测（2026-08-20，同机同 UA）：web_search 的四路抓取里三路已经结构性失效——
    /// google 只回 JS 壳页（整页零个 `<h3>`）、duckduckgo html/lite 回 202 反爬挑战页。
    /// 只剩 bing 一路撑着。加 brave 是为了不让它变成单点。
    #[test]
    fn brave_cards_parse_into_title_and_url() {
        let html = r#"
          <div data-type="web">
            <a href="https://doc.rust-lang.org/book/ch04-00.html" class="card">
              <div class="title">Understanding Ownership - The Rust Programming Language</div>
            </a>
          </div>
          <div data-type="web">
            <a href="https://example.com/x" class="card"><div class="title">Second Result</div></a>
          </div>
          <a href="https://search.brave.com/settings" class="card"><div class="title">Settings</div></a>
        "#;
        let rows = parse_brave(html);
        assert_eq!(rows.len(), 2, "解析出来的条数不对: {rows:?}");
        assert_eq!(rows[0].1, "https://doc.rust-lang.org/book/ch04-00.html");
        assert!(rows[0].0.contains("Understanding Ownership"));
        assert!(
            rows.iter().all(|r| !r.1.contains("brave.com")),
            "把 Brave 自己的站内链接当成结果了"
        );
    }

    /// 同一个 URL 出现两次只算一条。
    #[test]
    fn duplicate_urls_collapse() {
        let html = r#"<a href="https://a.test/1" class="c"><div class="title">A</div></a>
                      <a href="https://a.test/1" class="c"><div class="title">A again</div></a>"#;
        assert_eq!(parse_brave(html).len(), 1);
    }

    /// 标题空的卡片不要——留一条只有链接的结果，模型没法判断值不值得点。
    #[test]
    fn cards_without_a_title_are_dropped() {
        let html = r#"<a href="https://a.test/2" class="c"><div class="title">  </div></a>"#;
        assert!(parse_brave(html).is_empty());
    }

    /// 接线：五路都要并进去，且回执要报「几路返回了结果」。
    #[test]
    fn all_five_sources_are_raced_and_reported() {
        let src = include_str!("ai.rs");
        // ai.rs 里有**多个** #[cfg(test)] 模块，而且有的排在 ddg_search_multi 之前——
        // 按第一个截断会把要查的函数一起切掉（第一版就是这么假红的）。
        // 改成：从函数所在位置起，切到它**之后**的第一个测试模块。
        let at = src.find("async fn ddg_search_multi").expect("ddg_search_multi 不见了");
        let end = src[at..].find("\n#[cfg(test)]").map(|e| at + e).unwrap_or(src.len());
        let code: String = src[..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let multi = code
            .split("async fn ddg_search_multi")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("ddg_search_multi 不见了");
        for name in ["scrape_google", "scrape_bing", "scrape_ddg_html", "scrape_ddg_lite", "scrape_brave"] {
            assert!(multi.contains(name), "{name} 没进这一轮并发");
        }
        assert!(
            code.contains("本次 {}/{} 个来源返回了结果"),
            "回执没报「几路返回了结果」—— 结果少到底是词冷门还是三路挂了，模型分不出来"
        );
        assert!(
            code.contains("空手的那几个是常年被反爬拦着，不是这个词冷门"),
            "没告诉模型空手是常态，它会据此判断「这个话题没资料」"
        );
    }
}
