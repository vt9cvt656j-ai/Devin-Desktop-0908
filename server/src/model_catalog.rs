//! 模型能力目录：**实时抓**每个模型真正的上下文档位和推理档位，取代代码里手写的那张表。
//!
//! # 为什么需要它
//!
//! `models.rs::official_contexts` 是一张按模型名做字符串匹配的硬编码表，注释自己写着
//! "Keep in sync with provider docs"——也就是靠人记得去同步。实测对账（2026-08-16，
//! 拿本网关在售的 13 款逐个比）结果是 **6 款错**，而且不是小错：
//!
//! | 模型 | 表里写死 | 真实 | |
//! |---|---|---|---|
//! | deepseek-v4-flash | 128K | 1.05M | 少 88% |
//! | qwen3.8-max | 128K | 1M | 少 87% |
//! | kimi-k3 | 256K | 1.05M | 少 76% |
//! | gpt-5.5 / gpt-5.4 | 400K | 1.05M | 少 62% |
//! | glm-5 | 128K | 205K | 少 38% |
//!
//! 低估上下文不是"保守一点更安全"：客户端的上下文表和压缩阈值都读这个数，把 1M 的模型
//! 当 128K 用，等于把用户买到的窗口砍掉八分之七，长任务提前触发压缩甚至装不下。
//!
//! 推理档位同样：代码里只认 low/medium/high/max，而实际上新模型普遍还有 `xhigh`，
//! GPT 系列有 `none`/`minimal`，glm-5 **完全不支持档位**，deepseek-v4-flash 只支持
//! xhigh/high。给一个模型发它不支持的档位，要么被上游拒，要么被静默降级——两种都查不出来。
//!
//! # 数据从哪来
//!
//! 不是从本网关的上游（Sub2API）来的：那是个计费网关，`/api/v1/model-plaza` 只返回价格、
//! 倍率、计费模式，没有任何能力字段（而且那个部署还把它关了）。实测确认过。
//!
//! 用的是 OpenRouter 的**公开**模型目录，不需要 API key：
//!   * `GET /api/v1/models` —— 每个模型的 `reasoning.supported_efforts` 和默认 context。
//!   * `GET /api/v1/models/{id}/endpoints` —— 每个承载端点的 `context_length`，**去重后
//!     就是这个模型真正提供的全部档位**（Sonnet 4 → [200K, 1M]）。推理档位在这个接口里
//!     是 null，所以两个接口都要拉，各取各的那一半。
//!
//! endpoints 要按模型逐个拉，所以**只拉本网关在售的那些**（models 表的 enabled_models），
//! 十几次请求，而不是给整个目录 400 多个模型每个来一发。
//!
//! # 它不负责什么
//!
//! **beta header 仍然由硬编码表提供**（Sonnet 4 的 1M 要 `context-1m-2025-08-07`）。
//! 目录源只说"这个窗口存在"，不说"要带哪个头才拿得到"。这个分工是刻意的：窗口大小变化快
//! 且经常错，正是要实时化的东西；beta header 是协议细节，只有 Anthropic 那几个，几乎不动。
//!
//! # 降级
//!
//! 三级，任何一级挂了都不影响网关工作，只是退回今天的行为：
//!   1. 内存缓存（进程内，启动时从库预热）
//!   2. 库里上一次抓到的值（目录源不可达 / 网关重启）
//!   3. `official_contexts` 的硬编码表（全新部署且目录源不可达，或目录源没收录这个模型）

use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

const CATALOG_URL: &str = "https://openrouter.ai/api/v1/models";
const ENDPOINTS_URL: &str = "https://openrouter.ai/api/v1/models";
/// 目录变化以"厂商发新模型"为单位，是天级的，不是分钟级。抓太勤只是给别人的免费接口添堵。
const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
/// 单次 HTTP 的上限。目录抓不到不是故障，等下一轮就行，绝不能把启动或请求线程拖住。
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 一轮最多为多少个在售模型拉 endpoints。挡住"某天 enabled_models 被填了几百个"的情况。
const MAX_ENDPOINT_FETCHES: usize = 60;

#[derive(Clone, Debug, Default)]
pub struct Entry {
    /// 目录里这个模型挂在哪个厂商名下（`anthropic/claude-opus-5` 的 `anthropic`）。
    ///
    /// **归一化把前缀丢掉了**（`normalize` 取 `rsplit('/')`），而那个前缀正是「这是谁家的
    /// 模型」最可靠的一份答案 —— 每半小时刷新，覆盖四百多个模型，比手写正则表宽得多。
    /// 所以这里单独把它留下来，给厂商图标判定用（见 `route_endpoints::vendor_of`）。
    ///
    /// 空串 = 目录里那条没有前缀（少见），调用方当作「不知道」。
    pub vendor: String,
    /// 全部原生上下文档位，升序去重。
    pub contexts: Vec<i64>,
    /// 支持的推理档位。空 = 该模型不吃档位这个概念。
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub max_output: Option<i64>,
    /// 以下四项单位统一是 **USD / 1M tokens**，和 `models` 表、`official_price` 一致。
    /// 目录源给的是 USD/token 的字符串，解析时乘 1e6——单位错一位就是计费差一百万倍，
    /// 所以换算只在 `price_per_million` 一处发生。
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// 上游**此刻挂牌**的价（可能是活动价）。计费不用它 —— 计费用上面那两个（官方价）。
    ///
    /// 分开存是为了让「现在在打折」在后台看得见：合成一个数的话，运营只会看到一个数字，
    /// 看不出它是不是被活动价拉下来的，也就无从判断该不该跟。
    pub spot_input_price: Option<f64>,
    pub spot_output_price: Option<f64>,
    /// 缓存**读**的真实价。以前是 `input_price * 0.1` 推算的，实测偏得很远：
    /// deepseek-v4-flash 真实 0.0123 而推算 0.0061，glm-5 真实 0.12 而推算 0.06——
    /// 都少算一半，也就是按更便宜的价算成本、实际多付。
    pub cache_read_price: Option<f64>,
    /// 缓存**写**的真实价（以前按 `input_price * 1.25` 推算）。
    pub cache_write_price: Option<f64>,
    /// 这个模型**能接收**哪些模态（text/image/file/video…）。
    /// `needs_vision_help` 以前靠模型名里有没有 gpt/claude/vision/-vl 来猜"能不能看图"，
    /// 实测 qwen3.8-max 和 kimi-k3 都真的能看图、名字里却一个关键词都没有——于是网关
    /// 判它们不能，白做一次视觉辅助转换：多一次调用，质量还更差。
    pub input_modalities: Vec<String>,
    /// 这个模型**能产出**哪些模态。output 含 image = 它是画图模型
    /// （`is_image_gen_model` 以前靠名字里有没有 `-image`/`dall-e` 猜）。
    pub output_modalities: Vec<String>,
}

/// 一组模态里有没有 image。
///
/// **空必须是 `None` 而不是 `Some(false)`**：空的意思是"目录没给这一项"，得让调用方回落
/// 到按名字猜；当成 `false` 就是拿"我不知道"去断言"它不能看图"，结果是每次带图请求都白
/// 走一次代看图（$5/M 输入的额外调用 + 二手描述）。这两种空的区别是这一族函数的全部意义，
/// 所以单独抽出来让它可测——挂在全局缓存上的 accepts_image 测不到这一点。
fn image_capability(modalities: &[String]) -> Option<bool> {
    if modalities.is_empty() {
        return None;
    }
    Some(modalities.iter().any(|m| m == "image"))
}

/// 目录是否明确说这个模型支持某个思考档位。
///
/// 用来取代"每条线路手工开 effort_passthrough"：网关默认把 xhigh / max 封顶成 high，
/// 理由是"转卖渠道可能不认识这个词、会返回空 completion"——而那条理由，两个仓库的注释
/// 互相引用了很久，**从来没有人真的探测过**。2026-08-16 实测（直连本网关在用的上游，
/// claude-opus-4-8）：xhigh 和 max 都 HTTP 200、thinking 块正常返回。推断是错的。
///
/// 所以判据改成事实：目录说这个模型支持这一档，就照发。目录没收录的模型仍然走手工开关，
/// 行为不变。
/// 记住每个 `(模型, 档位)` 见过的「目录说支持」。**只记 true，从不记 false。**
///
/// 目录每 6 小时刷新一次，收尾是 `*CATALOG.write() = map` **整表替换**。某一轮上游没
/// 返回这个模型、或它的 `efforts` 少了一项，`supports_effort` 就翻成 false —— 同一段
/// 对话里 `output_config.effort` 于是从 `"max"` 掉成 `"high"`。
///
/// 而按 Anthropic 的缓存失效规则，**改 effort 总是作废整个 messages 缓存**（官方
/// prompt-caching 文档的失效表，2026-09 核对）。也就是说：目录抖一下，所有进行中的
/// 长对话前缀全部重写一遍，按 1.25~2 倍写入价。这是「一次外部抖动 = 全站缓存清空」。
///
/// 「这一轮没查到」和「这个模型不支持」是两件事，而它们在这里返回同一个值。记住正面
/// 答案就把这两件事分开了。方向是刻意的单向：记错的代价是发一个上游可能不认的档位词
/// （2026-08-16 实测过 xhigh / max 都 HTTP 200，从没发生过），记漏的代价是上面那条。
static EFFORT_SEEN: std::sync::Mutex<Option<std::collections::HashSet<(String, String)>>> =
    std::sync::Mutex::new(None);

pub fn supports_effort(model_id: &str, effort: &str) -> bool {
    let live = match lookup(model_id) {
        Some(e) => e.efforts.iter().any(|x| x == effort),
        None => false,
    };
    let Ok(mut guard) = EFFORT_SEEN.lock() else {
        return live;
    };
    let seen = guard.get_or_insert_with(std::collections::HashSet::new);
    if live {
        seen.insert((model_id.to_string(), effort.to_string()));
        return true;
    }
    seen.contains(&(model_id.to_string(), effort.to_string()))
}

/// 这个模型能不能自己看图。`None` = 目录里没有它/没给模态，调用方回落按名字猜。
pub fn accepts_image(model_id: &str) -> Option<bool> {
    image_capability(&lookup(model_id)?.input_modalities)
}

/// 这个模型是不是产出图片的。`None` 同上。
pub fn generates_image(model_id: &str) -> Option<bool> {
    image_capability(&lookup(model_id)?.output_modalities)
}

/// 目录源的价格是 "USD per token" 的字符串。转成本仓库统一的 USD/1M。
///
/// `-1`（以及负数、空串、非数字）表示"这个模型没有这一项"，必须返回 None 而不是 0.0：
/// 0.0 会被下游当成"免费"，把一个未知价悄悄变成不收钱。
fn price_per_million(pricing: Option<&serde_json::Value>, key: &str) -> Option<f64> {
    let raw = pricing?.get(key)?.as_str()?;
    let v: f64 = raw.trim().parse().ok()?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    // 舍入到 6 位小数（USD/1M 上这已经是 1e-12 USD/token 的分辨率，远超计费需要）。
    // 不舍入的话浮点残留会直接进库、再原样显示给人看：0.0000002 × 1e6 落成
    // 0.1999999992，0.0000001 落成 0.09999999。不影响计费（相对误差 5e-8），
    // 但后台和模型卡片上摆着这种数字，看的人第一反应是"这系统算错了"。
    Some(((v * 1_000_000.0) * 1e6).round() / 1e6)
}

/// 取一个字符串数组字段。缺失/类型不对一律返回空 —— 空在上面被当成"未知"，
/// 会让调用方回落按名字猜，而不是断言"这个模型没有任何模态"。
fn string_list(obj: Option<&serde_json::Value>, key: &str) -> Vec<String> {
    obj.and_then(|o| o.get(key))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

static CATALOG: LazyLock<RwLock<HashMap<String, Entry>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// 归一化模型名，用来跨命名体系对齐。
///
/// 中转商和目录源的写法对不齐：我们卖 `claude-opus-4-6`，目录源叫
/// `anthropic/claude-opus-4.6`。去掉 provider 前缀、去掉 `-` `.` `_` 再小写之后两边一致。
/// 实测本网关在售的 13 款用这一条规则全部命中。
pub fn normalize(model_id: &str) -> String {
    let bare = model_id.rsplit('/').next().unwrap_or(model_id);
    // `:batch` / `:free` 这类后缀是同一个模型的计费变体，能力一致。
    let bare = bare.split(':').next().unwrap_or(bare);
    bare.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// 从目录的原始 id 里取厂商前缀。
///
/// `anthropic/claude-opus-5` → `anthropic`。OpenRouter 用 `~` 开头表示变体命名空间
/// （`~anthropic/…`），那仍然是同一家，去掉波浪号。没有斜杠就是没有前缀，回空串 ——
/// **空串是「不知道」，不是某一家**。
pub fn catalog_vendor_prefix(source_id: &str) -> String {
    match source_id.split_once('/') {
        Some((v, _)) => v.trim_start_matches('~').trim().to_ascii_lowercase(),
        None => String::new(),
    }
}

/// 查一个模型的实时能力。`None` = 目录里没有它，调用方回落硬编码表。
pub fn lookup(model_id: &str) -> Option<Entry> {
    let key = normalize(model_id);
    CATALOG.read().ok()?.get(&key).cloned()
}

/// 只给测试用的注入口：把一批已知能力塞进目录。
///
/// 生产代码里已经没有任何硬编码的能力表了（那张表实测 13 款错 6 款，是负资产）。
/// 但计费、上下文预算这些逻辑的**单元测试**需要一个已知输入——那属于测试夹具，
/// 写在测试里是对的，写回生产代码就又变成了"记得手工同步"的债。
#[cfg(test)]
pub fn seed_for_test(rows: &[(&str, Entry)]) {
    if let Ok(mut c) = CATALOG.write() {
        for (id, e) in rows {
            c.insert(normalize(id), e.clone());
        }
    }
}

/// 构造一条只有价格的测试夹具。
#[cfg(test)]
pub fn priced(input: f64, output: f64, max_output: i64, contexts: Vec<i64>) -> Entry {
    Entry {
        contexts,
        max_output: Some(max_output),
        input_price: Some(input),
        output_price: Some(output),
        cache_read_price: None,
        cache_write_price: None,
        ..Entry::default()
    }
}

/// 目前缓存了多少条（供 /api/admin 观察，也让"抓到了没有"这件事可见）。
pub fn len() -> usize {
    CATALOG.read().map(|c| c.len()).unwrap_or(0)
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 先用库里的旧值把内存缓存暖起来：这一步没有网络依赖，所以即使目录源当时不可达，
        // 重启后也立刻是"上一次抓到的真实值"，而不是退回硬编码表。
        if let Err(e) = warm_from_db(&state).await {
            tracing::warn!(error = %e, "模型目录：预热失败，本轮先用硬编码表");
        } else if len() > 0 {
            tracing::info!(models = len(), "模型目录：已从库中预热");
        }
        // 让迁移和主要初始化先过去。它不急。
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        loop {
            match refresh(&state).await {
                Ok(n) => tracing::info!(models = n, "模型目录：已刷新"),
                // 抓不到不是故障：三级降级顶着，下一轮再来。
                Err(e) => tracing::warn!(error = %e, "模型目录：刷新失败，继续用上一次的值"),
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    });
}

async fn warm_from_db(state: &AppState) -> anyhow::Result<()> {
    type Row = (
        String,
        // source_id：原始的 `厂商/模型`。前缀是「这是谁家的模型」最可靠的一份答案。
        String,
        serde_json::Value,
        serde_json::Value,
        Option<String>,
        Option<i64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        serde_json::Value,
        serde_json::Value,
        Option<f64>,
        Option<f64>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT norm_id, source_id, contexts, efforts, default_effort, max_output,
                input_price, output_price, cache_read_price, cache_write_price,
                input_modalities, output_modalities,
                spot_input_price, spot_output_price
         FROM model_catalog",
    )
    .fetch_all(&state.db)
    .await?;
    let mut map = HashMap::new();
    for (
        norm_id,
        source_id,
        contexts,
        efforts,
        default_effort,
        max_output,
        input_price,
        output_price,
        cache_read_price,
        cache_write_price,
        input_modalities,
        output_modalities,
        spot_input_price,
        spot_output_price,
    ) in rows
    {
        map.insert(
            norm_id,
            Entry {
                vendor: catalog_vendor_prefix(&source_id),
                contexts: serde_json::from_value(contexts).unwrap_or_default(),
                efforts: serde_json::from_value(efforts).unwrap_or_default(),
                default_effort,
                max_output,
                input_price,
                output_price,
                spot_input_price,
                spot_output_price,
                cache_read_price,
                cache_write_price,
                input_modalities: serde_json::from_value(input_modalities).unwrap_or_default(),
                output_modalities: serde_json::from_value(output_modalities).unwrap_or_default(),
            },
        );
    }
    if let Ok(mut c) = CATALOG.write() {
        *c = map;
    }
    Ok(())
}

/// 本网关在售的模型名（models 表的 enabled_models 并集）。只给这些拉 endpoints。
async fn enabled_model_ids(state: &AppState) -> anyhow::Result<Vec<String>> {
    let rows: Vec<(Vec<String>,)> =
        sqlx::query_as("SELECT enabled_models FROM models WHERE active = true")
            .fetch_all(&state.db)
            .await?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (list,) in rows {
        for m in list {
            let m = m.trim().to_string();
            if !m.is_empty() && seen.insert(normalize(&m)) {
                out.push(m);
            }
        }
    }
    Ok(out)
}

/// 把目录响应的 `data` 数组解析成 {归一化名 → 能力}，外加 {归一化名 → 目录源原始 id}。
///
/// 抽成纯函数是为了能拿**真实响应**测：这一段是整个特性的判断力所在，混在 async fn 里
/// 就只能靠上线后看日志，而它错了的表现是"某个模型悄悄用了别人的上下文"。
fn parse_catalog(
    items: &[serde_json::Value],
) -> (HashMap<String, Entry>, HashMap<String, String>) {
    let mut map: HashMap<String, Entry> = HashMap::new();
    let mut source_ids: HashMap<String, String> = HashMap::new();
    // **本体先于计费变体**。`:batch` 走的是批处理折扣（通常半价），归一化后和本体同一个
    // key，而下面是"先到先占"。目录返回顺序不保证，所以不排这一下的话，某天 opus-5 的
    // 单价会静默变成 batch 的半价——计费错了不会报错，只会少收钱。
    let mut ordered: Vec<&serde_json::Value> = items.iter().collect();
    ordered.sort_by_key(|item| {
        item.get("id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| id.contains(':'))
    });
    for item in ordered {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let key = normalize(id);
        let reasoning = item.get("reasoning");
        let efforts: Vec<String> = reasoning
            .and_then(|r| r.get("supported_efforts"))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let default_effort = reasoning
            .and_then(|r| r.get("default_effort"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let ctx = item.get("context_length").and_then(|v| v.as_i64());
        let max_output = item
            .get("top_provider")
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(|v| v.as_i64());
        // `:batch` 之类的变体和本体归一化到同一个 key。先到的先占，本体通常排在前面；
        // 真正重要的字段（档位、窗口）在变体之间是一致的。
        let entry = map.entry(key.clone()).or_default();
        if entry.contexts.is_empty() {
            if let Some(c) = ctx {
                entry.contexts = vec![c];
            }
        }
        if entry.efforts.is_empty() {
            entry.efforts = efforts;
        }
        if entry.default_effort.is_none() {
            entry.default_effort = default_effort;
        }
        if entry.max_output.is_none() {
            entry.max_output = max_output;
        }
        let pricing = item.get("pricing");
        if entry.input_price.is_none() {
            entry.input_price = price_per_million(pricing, "prompt");
        }
        if entry.output_price.is_none() {
            entry.output_price = price_per_million(pricing, "completion");
        }
        if entry.cache_read_price.is_none() {
            entry.cache_read_price = price_per_million(pricing, "input_cache_read");
        }
        if entry.cache_write_price.is_none() {
            entry.cache_write_price = price_per_million(pricing, "input_cache_write");
        }
        let arch = item.get("architecture");
        if entry.input_modalities.is_empty() {
            entry.input_modalities = string_list(arch, "input_modalities");
        }
        if entry.output_modalities.is_empty() {
            entry.output_modalities = string_list(arch, "output_modalities");
        }
        source_ids.entry(key).or_insert_with(|| id.to_string());
    }
    (map, source_ids)
}

/// 相邻档位差在这个比例以内，就当成同一档。
///
/// 1_000_000 / 1_024_000 / 1_048_575 / 1_048_576 是同一个"1M"在不同承载端点上的四种写法
/// （10^6、1024×1000、1024²−1、1024²），最大差 4.9%。而真正不同的档位差得远得多
/// （384K→1M 是 160%，200K→1M 是 400%），10% 把两者分得很开。
const CONTEXT_TIER_TOLERANCE: f64 = 0.10;

/// 一个模型最多给几个上下文档位。
///
/// 合并近重复之后仍然可能偏多（glm-5.2 实测剩 6 档），而档位是给人**点**的：选项一多，
/// 每一个的意义就被稀释，用户只会挑最大那个，中间几档白占位置。
const MAX_CONTEXT_TIERS: usize = 5;

/// 超过上限时均匀抽稀，**首尾必须保住**。
///
/// 两端是真正会被选的：最小的那档最便宜最快，最大的那档是"能装下我这个项目吗"的答案。
/// 砍掉两端去保中间是没有意义的。中间按四舍五入均匀取，于是被丢掉的总是和邻居挨得最近、
/// 区分度最低的那一档（glm-5.2 的 202752 夹在 163840 和 262144 中间，正是它被丢掉）。
fn cap_context_tiers(sorted: Vec<i64>) -> Vec<i64> {
    let n = sorted.len();
    if n <= MAX_CONTEXT_TIERS {
        return sorted;
    }
    let last = MAX_CONTEXT_TIERS - 1;
    let mut out: Vec<i64> = (0..MAX_CONTEXT_TIERS)
        // +last/2 是四舍五入。用整数截断的话采样会整体偏向小端，实测会把 512000 丢掉
        // 而留下和邻居几乎重合的 202752 —— 抽稀的意义正好反了。
        .map(|i| sorted[(i * (n - 1) + last / 2) / last])
        .collect();
    out.dedup();
    out
}

/// 把"其实是同一档"的上下文合并掉，每组**保留最小值**。
///
/// 不合并的后果是用户在四个看起来一模一样的「1M」里挑：后台的能力摘要写成
/// `1M / 1M / 1M / 1M`，IDE 的上下文选择器也列四个同名选项——它按原始数字去重，而这四个
/// 数字确实不同，去重不掉。
///
/// **保留最小而不是最大**：这个列表是给用户**选**的，选中的值会当成真实上限用。同一组里
/// 挑最大的话，一旦这次请求落到只支持 1_000_000 的那条线路上就直接超限报错；挑最小的
/// 最坏只是少用几万 token，不会把请求打死。少一点窗口是可以接受的，硬报错不行。
fn merge_near_duplicate_contexts(sorted: Vec<i64>) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::with_capacity(sorted.len());
    for value in sorted {
        if value <= 0 {
            continue;
        }
        match out.last() {
            // sorted 升序，所以 kept 一定 <= value，这里就是"同一档"的判定。
            Some(&kept) if (value - kept) as f64 <= kept as f64 * CONTEXT_TIER_TOLERANCE => {}
            _ => out.push(value),
        }
    }
    out
}

/// 从端点明细里取出**全部**上下文档位和输出上限。
///
/// 顶层 `context_length` 只是一个代表值；同一个模型在不同承载端点上真的不一样
/// （Sonnet 4：Bedrock 200K / Google 1M），塌缩成一个数就把一个真实的选择藏掉了。
fn parse_endpoints(eps: &[serde_json::Value]) -> (Vec<i64>, Option<i64>) {
    let mut ctxs: Vec<i64> = eps
        .iter()
        .filter_map(|e| e.get("context_length").and_then(|v| v.as_i64()))
        .collect();
    ctxs.sort_unstable();
    ctxs.dedup();
    ctxs = cap_context_tiers(merge_near_duplicate_contexts(ctxs));
    // 输出上限取各端点里**最小**的，和上下文同一个理由，我一开始写反了。
    //
    // 端点之间差得离谱（实测：kimi-k3 的 18 个端点是 16384~1048576，deepseek-v4-flash
    // 是 32768~1048576，glm-5 是 16384~202752）。取最大的话，库里 kimi-k3 的输出上限
    // 会变成 1048576——声称它单次能吐 100 万 token。那个数其实等于它的**上下文**长度，
    // 是部分端点把字段填错了；而这个值会被拿去 clamp 请求的 max_tokens，真按它发就会
    // 撞上只支持 16384 的线路然后被拒。
    //
    // 两种错的代价不对称：设大了是硬错误（请求直接失败），设小了只是这次少输出一点。
    // 所以取最小——和上下文档位保留最小值是同一条原则。
    let max_out = eps
        .iter()
        .filter_map(|e| {
            let out = e.get("max_completion_tokens").and_then(|v| v.as_i64())?;
            let ctx = e.get("context_length").and_then(|v| v.as_i64());
            if out <= 0 {
                return None;
            }
            // **输出上限恰好等于上下文长度 = 这个端点把上下文填进了输出字段。**
            //
            // 物理上不可能：输出是上下文的一部分，占满整个窗口就没有输入的位置了。
            // 实测 glm-5.2 的 33 个端点里有一整批这样（AkashML 96890/96890、
            // Ambient 202752/202752、Inceptron 1048576/1048576），而填对的那些
            // （Baidu / Alibaba / Z.AI / Novita，全是 ctx 1048576 → out 131072）
            // 才是真值。
            //
            // 这类脏数据取最大会被大的污染，取最小同样会被小的污染——只是方向反了。
            // 先按物理约束把它们剔掉，剩下的再取最小，才既干净又保守。
            if Some(out) == ctx {
                return None;
            }
            Some(out)
        })
        .min();
    (ctxs, max_out)
}


/// 某个模型挂在哪条线路上（base_url + 解密后的 key）。探测要用真实凭据直连上游。
/// 探测要用的线路坐标。**协议必须一起带上**：探测打错端点的话，上游 404，而探测
/// 把任何非 2xx 都读成「这个长度装不下」—— 于是一条 Anthropic 线路上的模型会被探成
/// 「一档都过不了」，客户端的上下文预算和压缩阈值全按这个错数走，且不报错。
async fn route_for_model(state: &AppState, model_id: &str) -> Option<(String, String, String)> {
    let row: (String, String, String) = sqlx::query_as(
        "SELECT base_url, api_key, protocol FROM models
         WHERE active = true AND $1 = ANY(enabled_models)
         ORDER BY sort LIMIT 1",
    )
    .bind(model_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()?;
    let (base_url, api_key, protocol) = row;
    let key = crate::models::model_key(&api_key);
    if key.is_empty() {
        return None;
    }
    Some((base_url, key, protocol))
}

async fn refresh(state: &AppState) -> anyhow::Result<usize> {
    let http = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;

    // 第一趟：整份目录。推理档位只有这里有（endpoints 接口里 reasoning 是 null）。
    let catalog: serde_json::Value = http.get(CATALOG_URL).send().await?.json().await?;
    let items = catalog
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| anyhow::anyhow!("目录响应里没有 data 数组"))?;

    let (mut map, mut source_ids) = parse_catalog(items);

    // 第二趟：只给在售模型拉 endpoints，把**全部**上下文档位补齐。
    // 顶层 context_length 只是一个代表值；同一个模型在不同承载端点上真的不一样
    // （Sonnet 4：Bedrock 200K / Google 1M），塌缩成一个数就把真实选择藏掉了。
    let wanted = enabled_model_ids(state).await.unwrap_or_default();
    let mut fetched = 0usize;
    for model in wanted.iter().take(MAX_ENDPOINT_FETCHES) {
        let key = normalize(model);
        let Some(source_id) = source_ids.get(&key).cloned() else {
            continue; // 目录源没收录（中转商私有命名）→ 留给硬编码表兜底
        };
        let url = format!("{ENDPOINTS_URL}/{source_id}/endpoints");
        let resp = match http.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(model = %model, error = %e, "模型目录：端点明细抓取失败，保留代表值");
                continue;
            }
        };
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(eps) = body
            .get("data")
            .and_then(|d| d.get("endpoints"))
            .and_then(|e| e.as_array())
        else {
            continue;
        };
        let (ctxs, max_out) = parse_endpoints(eps);
        if let Some(entry) = map.get_mut(&key) {
            if !ctxs.is_empty() {
                entry.contexts = ctxs;
            }
            if let Some(max_out) = max_out {
                entry.max_output = Some(max_out);
            }
        }
        fetched += 1;
    }
    tracing::info!(
        in_catalog = map.len(),
        enabled = wanted.len(),
        endpoint_details = fetched,
        "模型目录：抓取完成"
    );

    // 目录没收录的在售模型：直接问上游要真值。
    //
    // 这是"不让人手填"的那一步。公开目录不可能收全（实测 glm-5.3 就不在 OpenRouter 里），
    // 而真值本来就在上游那儿。判据是**召回**不是 HTTP 200——转卖网关会悄悄截断：实测给
    // glm-5.3 发 300 万字符照样返回 200，拿"没报错"当"装得下"会得出荒唐的窗口。
    //
    // 只探"目录没有 **且** 库里也还没探到过"的：探测烧真 token，探过一次就长期用着，
    // 不必每轮重来。
    let mut probed = 0usize;
    for model in &wanted {
        if probed >= crate::model_probe::MAX_PROBES_PER_ROUND {
            break;
        }
        let key = normalize(model);
        if map.contains_key(&key) {
            continue; // 目录里有，用目录的（免费而且更准）
        }
        // 「长期沿用」必须真的把它**写进这一轮的新表**。
        //
        // 这里原来只是 continue：不重探是对的（探测烧真 token），但整轮结束时是
        // `*c = map` **整表替换**，而这条沿用的记录从没进过 map —— 于是每 6 小时刷新一次，
        // 上一轮探到的窗口就被抹一次。同一个模型今天是 200K、明天是「不知道」，
        // 客户端的上下文预算和压缩阈值跟着抖。注释写的是「长期沿用」，代码干的是每轮丢弃。
        if let Some(prev) = lookup(model).filter(|e| !e.contexts.is_empty()) {
            source_ids
                .entry(key.clone())
                .or_insert_with(|| format!("probed:{model}"));
            map.insert(key, prev);
            continue;
        }
        let Some((base_url, api_key, protocol)) = route_for_model(state, model).await else {
            continue;
        };
        if let Some(entry) =
            crate::model_probe::probe_context(&base_url, &api_key, &protocol, model).await
        {
            source_ids.insert(key.clone(), format!("probed:{model}"));
            map.insert(key, entry);
            probed += 1;
        }
    }
    if probed > 0 {
        tracing::info!(probed, "模型目录：为目录未收录的模型探到了真实窗口");
    }

    persist(state, &mut map, &source_ids).await?;
    let n = map.len();
    if let Ok(mut c) = CATALOG.write() {
        *c = map;
    }
    Ok(n)
}

/// 官方价 = 当天挂牌价 和 窗口内最高价 里的**较大者**。
///
/// 只抬不降，因为这个函数的全部意义就是「不跟着上游搞活动往下走」。
/// 三种边界都要答对：
///   · 挂牌价缺失、窗口有价 → 用窗口价（目录临时不回价，不该让计费退到「没有价」，
///     那会一路掉到 `compute_cost` 返回 0，也就是白送）；
///   · 窗口没有价（第一次见这个模型）→ 用挂牌价；
///   · 挂牌价更高（真涨价了）→ 用挂牌价，立刻生效。涨价没有理由拖。
pub(crate) fn anchor_price(spot: Option<f64>, window_high: Option<f64>) -> Option<f64> {
    match (spot, window_high) {
        (Some(c), Some(h)) if h > c => Some(h),
        (None, Some(h)) => Some(h),
        (c, _) => c,
    }
}

/// 落库，并把**官方价锚定**应用到 `map`（就地抬价）。
///
/// 锚定要同时作用在库和内存上：`refresh` 收尾是 `*CATALOG.write() = map` 整表替换，
/// 只更新库的话，这一轮进程里 `official_price()` 读到的仍然是当天的活动价，要等到
/// 下次重启才对 —— 而计费每一秒都在读它。
async fn persist(
    state: &AppState,
    map: &mut HashMap<String, Entry>,
    source_ids: &HashMap<String, String>,
) -> anyhow::Result<()> {
    for (key, entry) in map.iter() {
        // 只落有内容的行。整份目录 400+ 条里大多数这个网关根本不卖，落库只是噪音。
        if entry.contexts.is_empty() && entry.efforts.is_empty() && entry.input_price.is_none() {
            continue;
        }
        let source = source_ids.get(key).cloned().unwrap_or_else(|| key.clone());
        sqlx::query(
            "INSERT INTO model_catalog (norm_id, source_id, contexts, efforts, default_effort, max_output,
                                        input_price, output_price, cache_read_price, cache_write_price,
                                        input_modalities, output_modalities, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
             ON CONFLICT (norm_id) DO UPDATE SET
               source_id = EXCLUDED.source_id, contexts = EXCLUDED.contexts,
               efforts = EXCLUDED.efforts, default_effort = EXCLUDED.default_effort,
               max_output = EXCLUDED.max_output, input_price = EXCLUDED.input_price,
               output_price = EXCLUDED.output_price, cache_read_price = EXCLUDED.cache_read_price,
               cache_write_price = EXCLUDED.cache_write_price,
               input_modalities = EXCLUDED.input_modalities,
               output_modalities = EXCLUDED.output_modalities, updated_at = now()",
        )
        .bind(key)
        .bind(source)
        .bind(serde_json::to_value(&entry.contexts).unwrap_or_default())
        .bind(serde_json::to_value(&entry.efforts).unwrap_or_default())
        .bind(entry.default_effort.as_deref())
        .bind(entry.max_output)
        .bind(entry.input_price)
        .bind(entry.output_price)
        .bind(entry.cache_read_price)
        .bind(entry.cache_write_price)
        .bind(serde_json::to_value(&entry.input_modalities).unwrap_or_default())
        .bind(serde_json::to_value(&entry.output_modalities).unwrap_or_default())
        .execute(&state.db)
        .await?;

        // 今天观测到的价，记一笔。一天一行（同一天刷新多次就覆盖），锚定从这张表取。
        let _ = sqlx::query(
            "INSERT INTO model_catalog_price_log (day, norm_id, input_price, output_price) \
             VALUES (current_date, $1, $2, $3) \
             ON CONFLICT (day, norm_id) DO UPDATE SET \
               input_price = EXCLUDED.input_price, output_price = EXCLUDED.output_price",
        )
        .bind(key)
        .bind(entry.input_price)
        .bind(entry.output_price)
        .execute(&state.db)
        .await;
    }

    // ── 官方价锚定 ────────────────────────────────────────────────────────
    //
    // 取窗口内观测到的**最高**价当官方价。活动期的低价进不了账（窗口里还压着活动前的
    // 高价），而真正的永久降价会在窗口走完之后自动生效 —— 没有任何人需要记得去改。
    //
    // 只抬不降（`max`）：这一步的全部意义就是不跟着活动价往下走。
    // 窗口填 0 = 关掉锚定，行为逐字回到加这个功能之前。
    let window = crate::settings::official_price_window_days();
    if window > 0 {
        let anchors: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
            "SELECT norm_id, max(input_price), max(output_price) \
             FROM model_catalog_price_log \
             WHERE day >= current_date - $1::int \
             GROUP BY norm_id",
        )
        .bind(window as i32)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

        let mut raised = 0usize;
        for (norm_id, hi_in, hi_out) in &anchors {
            let Some(entry) = map.get_mut(norm_id) else { continue };
            // 抬价**之前**先把此刻的挂牌价留下来，否则抬完就分不出哪个是哪个了。
            entry.spot_input_price = entry.input_price;
            entry.spot_output_price = entry.output_price;
            let ni = anchor_price(entry.input_price, *hi_in);
            let no = anchor_price(entry.output_price, *hi_out);
            if ni != entry.input_price || no != entry.output_price {
                raised += 1;
                tracing::info!(
                    model = %norm_id,
                    spot_in = ?entry.input_price, spot_out = ?entry.output_price,
                    official_in = ?ni, official_out = ?no,
                    "目录价低于窗口内最高价，按官方价计费（多半是上游在搞活动）"
                );
            }
            entry.input_price = ni;
            entry.output_price = no;
        }
        if raised > 0 {
            tracing::info!(raised, window, "模型目录：这些模型的挂牌价当前低于官方价");
        }

        // 库里也抬一次，并把当天挂牌价单独存进 spot_*（后台要能看出「现在在打折」）。
        let _ = sqlx::query(
            "UPDATE model_catalog c SET \
               spot_input_price = c.input_price, \
               spot_output_price = c.output_price, \
               input_price = GREATEST(c.input_price, a.hi_in), \
               output_price = GREATEST(c.output_price, a.hi_out) \
             FROM (SELECT norm_id, max(input_price) AS hi_in, max(output_price) AS hi_out \
                   FROM model_catalog_price_log WHERE day >= current_date - $1::int \
                   GROUP BY norm_id) a \
             WHERE a.norm_id = c.norm_id",
        )
        .bind(window as i32)
        .execute(&state.db)
        .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// 目录抖一下，不能把进行中对话的思考档位改掉。
    ///
    /// 判据是**行为**：先让目录说支持，再把这个模型从目录里抹掉（模拟整表替换时它没
    /// 被返回），答案必须不变。改 effort 会作废整个 messages 缓存 —— 一次目录抖动
    /// 就是所有长对话的前缀全部按 1.25~2 倍写入价重写一遍。
    #[test]
    fn a_catalog_refresh_that_loses_a_model_does_not_change_its_effort() {
        // 进程级共享状态 + cargo 并行跑测试 → 用一个这条测试独占的模型名。
        let id = "test-only/effort-stickiness-probe";
        assert!(!super::supports_effort(id, "max"), "没见过就不该说支持");

        super::seed_for_test(&[(
            id,
            super::Entry { efforts: vec!["high".into(), "max".into()], ..Default::default() },
        )]);
        assert!(super::supports_effort(id, "max"));
        assert!(!super::supports_effort(id, "xhigh"), "目录没给的档位不许凭空说支持");

        // 整表替换的一轮里这个模型没回来。
        if let Ok(mut c) = super::CATALOG.write() {
            c.remove(&super::normalize(id));
        }
        assert!(
            super::supports_effort(id, "max"),
            "目录抖一下就把档位从 max 降成 high —— 所有进行中长对话的缓存当场作废"
        );
        // 反向仍然是错的：从没见过的档位不会因为记忆而变成 true。
        assert!(!super::supports_effort(id, "xhigh"));
    }

    use super::*;

    #[test]
    fn 归一化把两套命名体系对齐() {
        // 本网关卖的名字 → 目录源的名字。这一条规则实测覆盖在售的全部 13 款；
        // 对不上就意味着那款静默回落硬编码表（而硬编码表 6 款是错的）。
        for (mine, theirs) in [
            ("claude-opus-4-6", "anthropic/claude-opus-4.6"),
            ("claude-opus-5", "anthropic/claude-opus-5"),
            ("claude-fable-5", "anthropic/claude-fable-5"),
            ("gpt-5.4-mini", "openai/gpt-5.4-mini"),
            ("qwen3.8-max", "qwen/qwen3.8-max"),
            ("kimi-k3", "moonshotai/kimi-k3"),
            ("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
            ("glm-5", "z-ai/glm-5"),
        ] {
            assert_eq!(
                normalize(mine),
                normalize(theirs),
                "{mine} 对不上 {theirs}，这款会静默回落到硬编码表"
            );
        }
    }

    #[test]
    fn 计费变体和本体归一化到一起() {
        // `:batch` / `:free` 是同一个模型的计费变体，能力一致，不该占两条目录项。
        assert_eq!(
            normalize("anthropic/claude-opus-5:batch"),
            normalize("anthropic/claude-opus-5")
        );
    }

    /// 真实抓下来的目录响应（2026-08-16）。用真数据而不是手编的 JSON：手编的会不自觉地
    /// 按代码的想象来写，于是测试和实现一起错，而真实响应里藏着 `reasoning: null`、
    /// `:batch` 变体这些实现最容易漏的形状。
    ///
    /// 边界：这是静态快照，所以它验证的是"解析逻辑对当时的真实契约是对的"，
    /// **不能**发现上游未来改格式。格式漂移由线上 `capability_source=static` 的比例暴露。
    const MODELS_FIXTURE: &str = include_str!("../testdata/openrouter_models.json");
    const ENDPOINTS_FIXTURE: &str =
        include_str!("../testdata/openrouter_endpoints_sonnet4.json");

    fn parsed() -> HashMap<String, Entry> {
        let v: serde_json::Value = serde_json::from_str(MODELS_FIXTURE).unwrap();
        let items = v["data"].as_array().unwrap().clone();
        parse_catalog(&items).0
    }

    #[test]
    fn 从真实响应里解析出推理档位() {
        let map = parsed();
        let opus = map.get(&normalize("claude-opus-5")).expect("opus-5 应当在目录里");
        assert_eq!(
            opus.efforts,
            vec!["max", "xhigh", "high", "medium", "low"],
            "代码里原本只认 low/medium/high/max —— xhigh 是实测存在、但从来发不出去的一档"
        );
        assert_eq!(opus.default_effort.as_deref(), Some("high"));

        // 只支持两档。给它发 medium/low 会被上游拒或静默降级，两种都查不出来。
        let ds = map.get(&normalize("deepseek-v4-flash")).unwrap();
        assert_eq!(ds.efforts, vec!["xhigh", "high"]);

        // GPT 系列有 `none`，这是"关掉推理"，和"不支持推理"是两回事。
        let gpt = map.get(&normalize("gpt-5.4")).unwrap();
        assert!(gpt.efforts.contains(&"none".to_string()));
    }

    #[test]
    fn 不支持档位的模型给出空列表而不是猜一个默认() {
        // glm-5 真的不吃推理档位。空列表是**有意义的答案**：客户端据此不给它显示档位选择器。
        // 早期实现容易在这里塞一个 ["low","medium","high"] 的默认，那等于凭空发明能力。
        let map = parsed();
        let glm = map.get(&normalize("glm-5")).expect("glm-5 应当在目录里");
        assert!(
            glm.efforts.is_empty(),
            "给一个不支持档位的模型编出了档位：{:?}",
            glm.efforts
        );
        assert_eq!(glm.contexts, vec![204_800], "上下文本身还是要有");
    }

    #[test]
    fn 计费变体不会在目录里占两条() {
        // opus-5 和 opus-5:batch 都在 fixture 里。归一化后必须合成一条，
        // 否则同一个模型出现两份能力，谁生效取决于遍历顺序。
        let map = parsed();
        let hits: Vec<_> = map
            .keys()
            .filter(|k| k.starts_with("claudeopus5"))
            .collect();
        assert_eq!(hits.len(), 1, "opus-5 的计费变体没有合并：{hits:?}");
    }

    #[test]
    fn 端点明细给出全部上下文档位而不是一个代表值() {
        // 这是"上下文要全部获取"的核心。Sonnet 4 在 Bedrock 上是 200K、在 Google 上是 1M，
        // 顶层 context_length 只报了其中一个（1M）。只取顶层就把另一档藏掉了。
        let v: serde_json::Value = serde_json::from_str(ENDPOINTS_FIXTURE).unwrap();
        let eps = v["data"]["endpoints"].as_array().unwrap();
        let (ctxs, max_out) = parse_endpoints(eps);
        assert_eq!(
            ctxs,
            vec![200_000, 1_000_000],
            "没把这个模型真正提供的全部窗口取出来"
        );
        assert!(max_out.is_some(), "输出上限也该一并取到");

        // 顶层代表值确实只有一个 —— 这条断言说明为什么非要再拉一次端点明细。
        let top = parsed();
        let sonnet = top.get(&normalize("claude-sonnet-4")).unwrap();
        assert_eq!(sonnet.contexts.len(), 1, "顶层本来就只给一个代表值");
    }

    #[test]
    fn 价格换算成每百万_单位不能错() {
        // 目录源给的是 USD/token 的字符串，本仓库统一用 USD/1M。这一步错一位就是计费
        // 差一百万倍，所以拿手写表里已知正确的几项来对：opus-5 就是 5/25。
        let map = parsed();
        let opus = map.get(&normalize("claude-opus-5")).unwrap();
        assert_eq!(opus.input_price, Some(5.0));
        assert_eq!(opus.output_price, Some(25.0));

        // sonnet-5 是手写表**写错**的那一款：表里 3/15，真实 2/10，多算 50%。
        let sonnet5 = map.get(&normalize("claude-sonnet-5")).unwrap();
        assert_eq!(sonnet5.input_price, Some(2.0));
        assert_eq!(sonnet5.output_price, Some(10.0));
    }

    #[test]
    fn 计费变体的半价不能盖掉本体单价() {
        // `:batch` 是批处理折扣（opus-5 本体 5/25，batch 2.5/12.5），归一化后和本体同一个
        // key，而写入是"先到先占"。目录返回顺序不保证，不把本体排前面的话，某天 opus-5 的
        // 单价会静默变成半价——计费错了不报错，只是少收钱，而且账面看不出来。
        //
        // **必须把变体构造在前面**：fixture 里本体恰好排在前，照原顺序跑的话，把排序保护
        // 整段删掉测试也照样绿。第一版就是这么写的，变异测试当场抓出来——一条测不到东西
        // 的断言比没有更糟，因为它让人以为这里有保护。
        let v: serde_json::Value = serde_json::from_str(MODELS_FIXTURE).unwrap();
        let all = v["data"].as_array().unwrap();
        let pick = |id: &str| {
            all.iter()
                .find(|m| m["id"] == id)
                .unwrap_or_else(|| panic!("fixture 里缺 {id}"))
                .clone()
        };
        let reversed = vec![
            pick("anthropic/claude-opus-5:batch"),
            pick("anthropic/claude-opus-5"),
        ];
        let (map, _) = parse_catalog(&reversed);
        let opus = map.get(&normalize("claude-opus-5")).unwrap();
        assert_eq!(
            opus.input_price,
            Some(5.0),
            "本体单价被 :batch 的半价盖掉了（取到 {:?}，应为 5.0）",
            opus.input_price
        );
        assert_eq!(opus.output_price, Some(25.0));
    }

    #[test]
    fn 缓存价取真实值而不是按输入价推算() {
        // 推算是 input×0.1 / input×1.25，曾经是唯一来源。实测偏得很远：
        // deepseek-v4-flash 缓存读真实 0.012292，推算只有 0.006146——少算一半。
        let map = parsed();
        let ds = map.get(&normalize("deepseek-v4-flash")).unwrap();
        let real = ds.cache_read_price.expect("目录里有这一项");
        let guessed = ds.input_price.unwrap() * 0.1;
        assert!(
            (real - 0.012292).abs() < 1e-9,
            "缓存读真实价没取到：{real}"
        );
        assert!(
            real > guessed * 1.5,
            "真实值 {real} 和推算值 {guessed} 差距没体现出来——这条测试就白写了"
        );
    }

    #[test]
    fn 缺失的价格项必须是_none_不能变成零() {
        // 目录源用 `-1`/缺字段表示"这个模型没有这一项"。返回 0.0 会被下游当成**免费**，
        // 把一个未知价悄悄变成不收钱——比报错严重得多，因为它只体现在月底的账上。
        let map = parsed();
        let gpt = map.get(&normalize("gpt-5.4")).unwrap();
        assert_eq!(gpt.cache_write_price, None, "缺失项被填成了 0 或别的数");
        assert_eq!(gpt.input_price, Some(2.5), "有的项照常要取到");

        // 直接测换算函数对各种脏值的处理
        let dirty = serde_json::json!({"a": "-1", "b": "", "c": "abc", "d": "0.000001"});
        assert_eq!(price_per_million(Some(&dirty), "a"), None, "-1 表示不适用");
        assert_eq!(price_per_million(Some(&dirty), "b"), None);
        assert_eq!(price_per_million(Some(&dirty), "c"), None);
        assert_eq!(price_per_million(Some(&dirty), "missing"), None);
        assert_eq!(price_per_million(None, "a"), None);
        assert_eq!(price_per_million(Some(&dirty), "d"), Some(1.0));

        // 浮点残留要被舍掉：0.0000002 USD/token = 0.2 USD/1M，不能落成 0.1999999992
        let fp = serde_json::json!({"p": "0.0000002", "q": "0.0000001"});
        assert_eq!(price_per_million(Some(&fp), "p"), Some(0.2));
        assert_eq!(price_per_million(Some(&fp), "q"), Some(0.1));
    }

    #[test]
    fn 能不能看图要看目录_不要从名字猜() {
        // 缺陷形状：`needs_vision_help` 靠模型名里有没有 gpt/gemini/claude/vision/-vl/image
        // 来判"原生支持视觉"。qwen3.8-max 和 kimi-k3 的 input_modalities 实测都含 image，
        // 名字里却一个关键词都没有——于是网关判它们不能看图，每次带图请求都多走一次
        // 代看图（用 gpt-5.5 描述图片、按 $5/M 输入计价），拿到的还是二手描述。
        let map = parsed();
        for id in ["qwen3.8-max", "kimi-k3"] {
            let e = map.get(&normalize(id)).unwrap();
            assert!(
                e.input_modalities.iter().any(|m| m == "image"),
                "{id} 实测能看图，目录没解析出来"
            );
            // 同时确认那张名字表确实判错——否则这条测试没有存在的理由
            let m = id.to_lowercase();
            let by_name = m.contains("gpt")
                || m.contains("gemini")
                || m.contains("claude")
                || m.contains("vision")
                || m.contains("-vl")
                || m.contains("image");
            assert!(!by_name, "{id} 按名字也能判对的话，这条测试就该删掉");
        }
        // 纯文本模型不能被误判成能看图
        let ds = map.get(&normalize("deepseek-v4-flash")).unwrap();
        assert!(!ds.input_modalities.iter().any(|m| m == "image"));
        assert!(!ds.input_modalities.is_empty(), "空 = 未知，会回落名字表");
    }

    #[test]
    fn 产出模态决定是不是画图模型() {
        // 目录里这几款的 output_modalities 都只有 text —— 一个画图模型都不是。
        // 名字表的问题是反的：`-image` 这种子串会把"看图"的误判成"画图"的。
        let map = parsed();
        for id in ["claude-opus-5", "qwen3.8-max", "gpt-5.4"] {
            let e = map.get(&normalize(id)).unwrap();
            assert!(
                !e.output_modalities.iter().any(|m| m == "image"),
                "{id} 被当成画图模型了"
            );
            assert!(!e.output_modalities.is_empty(), "空 = 未知，会回落名字表");
        }
    }

    #[test]
    fn 同一档的多种写法要合并成一条() {
        // 缺陷形状（2026-08-16，用户一眼看出来的）：deepseek-v4-flash 的端点里有
        // 1000000 / 1024000 / 1048575 / 1048576 —— 同一个"1M"的四种写法。不合并的话
        // 后台摘要显示成 `1M / 1M / 1M / 1M`，IDE 的上下文选择器也列四个同名选项，
        // 用户要在四个看起来一模一样的东西里挑一个。
        assert_eq!(
            merge_near_duplicate_contexts(vec![384_000, 1_000_000, 1_024_000, 1_048_575, 1_048_576]),
            vec![384_000, 1_000_000],
            "同一档的多种写法没合并干净"
        );
        // 真正不同的档位一个都不能被吃掉
        assert_eq!(
            merge_near_duplicate_contexts(vec![200_000, 1_000_000]),
            vec![200_000, 1_000_000],
            "200K 和 1M 是两个真档位，被误合并了"
        );
        // glm-5.2 的真实八连：只有末尾三个是同一档
        assert_eq!(
            merge_near_duplicate_contexts(vec![
                96_890, 163_840, 202_752, 262_144, 512_000, 1_000_000, 1_024_000, 1_048_576
            ]),
            vec![96_890, 163_840, 202_752, 262_144, 512_000, 1_000_000],
        );
    }

    #[test]
    fn 端点解析必须真的走了合并这一步() {
        // 上一条测的是 merge_near_duplicate_contexts 自己。但把 parse_endpoints 里那句调用
        // 删掉，上一条**照样绿**——变异测试当场证明了这一点。函数对不对和有没有人调它是
        // 两件事，而这个仓库栽过的坑几乎全是后者。所以这条断言的是**连接**：
        // 端点里进去四个近重复，出来必须只剩一个。
        let eps = vec![
            serde_json::json!({"context_length": 384_000,   "max_completion_tokens": 64_000}),
            serde_json::json!({"context_length": 1_000_000, "max_completion_tokens": 64_000}),
            serde_json::json!({"context_length": 1_024_000, "max_completion_tokens": 64_000}),
            serde_json::json!({"context_length": 1_048_575, "max_completion_tokens": 64_000}),
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 128_000}),
        ];
        let (ctxs, max_out) = parse_endpoints(&eps);
        assert_eq!(
            ctxs,
            vec![384_000, 1_000_000],
            "parse_endpoints 没有走合并——后台会显示成 1M / 1M / 1M，IDE 会列四个同名选项"
        );
        assert_eq!(
            max_out,
            Some(64_000),
            "输出上限要取各端点里**最小**的——取最大会把某些端点填错的\"输出=上下文\"当真，\
             得到一个发出去就被拒的数"
        );

        // 抽稀也必须在这条链路上。**合并和抽稀各自的单元测试都覆盖不到"有没有人调它"**——
        // 这个坑在同一个文件里踩了两次（先是合并，后是抽稀），两次都是变异测试抓出来的。
        // 用 glm-5.2 的真实八连：合并后剩 6 档，再抽稀到 5 档。
        let many: Vec<serde_json::Value> = [
            96_890, 163_840, 202_752, 262_144, 512_000, 1_000_000, 1_024_000, 1_048_576,
        ]
        .iter()
        .map(|c| serde_json::json!({"context_length": c, "max_completion_tokens": 32_000}))
        .collect();
        let (capped, _) = parse_endpoints(&many);
        assert_eq!(
            capped,
            vec![96_890, 163_840, 262_144, 512_000, 1_000_000],
            "parse_endpoints 没有走抽稀——档位会超过 5 个"
        );
        assert!(capped.len() <= 5);
    }

    #[test]
    fn 输出上限取最小_不能被填错的端点抬上去() {
        // 事故形状（2026-08-16，用户质疑"为什么单次输出上限是 128K"查出来的）：
        // 原来取各端点最大值，于是 kimi-k3 的输出上限被存成 1048576——正好等于它的
        // **上下文**长度，是部分端点把 max_completion_tokens 填成了上下文。这个值会被
        // 拿去 clamp 请求的 max_tokens，真按它发就会撞上只支持 16384 的线路然后被拒。
        let eps = vec![
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 16_384}),
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 65_536}),
            // 这一条就是把上下文误填进输出上限的那种端点
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 1_048_576}),
        ];
        let (_, max_out) = parse_endpoints(&eps);
        assert_eq!(
            max_out,
            Some(16_384),
            "被填错的端点把输出上限抬上去了——这个数发出去会被拒"
        );

        // 0 / 负数是"没有这一项"，不能被当成最小值把上限压成 0（那样一个 token 都发不出去）
        let with_zero = vec![
            serde_json::json!({"max_completion_tokens": 0}),
            serde_json::json!({"max_completion_tokens": 32_000}),
        ];
        assert_eq!(parse_endpoints(&with_zero).1, Some(32_000), "0 被当成了真实上限");
    }

    #[test]
    fn 把上下文填进输出字段的端点要剔掉() {
        // 事故形状（2026-08-16，用户看到 glm-5.2 "单次输出上限 96.9k" 觉得不对而查出来的）：
        // 它 33 个端点里有一整批把 max_completion_tokens 填成了等于 context_length
        // （AkashML 96890/96890、Ambient 202752/202752、Inceptron 1048576/1048576），
        // 而填对的那些（Baidu/Alibaba/Z.AI，ctx 1048576 → out 131072）才是真值。
        //
        // 这类脏数据取最大会被大的污染，取最小同样会被小的污染。判据只能是物理约束：
        // 输出是上下文的一部分，不可能占满整个窗口——相等就一定是填错了。
        let eps = vec![
            // 填错的：out == ctx，必须剔掉，否则最小值会变成 96890
            serde_json::json!({"context_length": 96_890,    "max_completion_tokens": 96_890}),
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 1_048_576}),
            // 填对的
            serde_json::json!({"context_length": 1_048_576, "max_completion_tokens": 131_072}),
            serde_json::json!({"context_length": 1_024_000, "max_completion_tokens": 128_000}),
        ];
        let (_, max_out) = parse_endpoints(&eps);
        assert_eq!(
            max_out,
            Some(128_000),
            "把上下文填进输出字段的端点没被剔掉——用户会看到一个荒唐的输出上限"
        );

        // 全都填错时宁可返回 None（回落硬编码表），也不要拿一个明知是错的数当真
        let all_bad = vec![
            serde_json::json!({"context_length": 200_000, "max_completion_tokens": 200_000}),
        ];
        assert_eq!(parse_endpoints(&all_bad).1, None, "没有可信值时应当交还给兜底表");
    }

    #[test]
    fn 档位最多五个_且首尾必须保住() {
        // 合并近重复之后仍可能偏多（glm-5.2 实测剩 6 档）。档位是给人点的，选项一多每个
        // 的意义就被稀释。上限 5，超了均匀抽稀。
        //
        // 首尾是真正会被选的：最小那档最便宜最快，最大那档是"装不装得下我的项目"的答案，
        // 砍掉两端保中间毫无意义。
        let glm = vec![96_890, 163_840, 202_752, 262_144, 512_000, 1_000_000];
        let capped = cap_context_tiers(glm);
        assert_eq!(capped.len(), 5, "没收到 5 档以内");
        assert_eq!(capped.first(), Some(&96_890), "最小档被砍了");
        assert_eq!(capped.last(), Some(&1_000_000), "最大档被砍了——那是用户最关心的一档");
        // 被丢掉的应当是区分度最低的那个（202752 夹在 163840 和 262144 中间）
        assert_eq!(capped, vec![96_890, 163_840, 262_144, 512_000, 1_000_000]);

        // 不超上限时原样返回，一个都不能少
        let two = vec![384_000, 1_000_000];
        assert_eq!(cap_context_tiers(two.clone()), two);
        let five = vec![1, 2, 3, 4, 5];
        assert_eq!(cap_context_tiers(five.clone()), five);
    }

    #[test]
    fn 抽稀不能整体偏向小端() {
        // 用整数截断而不是四舍五入的话，采样会偏向小端：glm-5.2 会保下和邻居几乎重合的
        // 202752，反而把 512000 这个真正独立的一档丢掉——抽稀的意义正好反了。
        let capped = cap_context_tiers(vec![96_890, 163_840, 202_752, 262_144, 512_000, 1_000_000]);
        assert!(capped.contains(&512_000), "512K 这个独立档位被丢了");
        assert!(!capped.contains(&202_752), "留下了和邻居几乎重合的那一档");
    }

    #[test]
    fn 合并同一档时保留最小值() {
        // 保留最大值会让用户选到一个可能超限的数：同一组里如果这次请求落到只支持
        // 1_000_000 的线路上，按 1_048_576 发就直接报错。少几万 token 可以接受，硬报错不行。
        let merged = merge_near_duplicate_contexts(vec![1_000_000, 1_048_576]);
        assert_eq!(merged, vec![1_000_000], "保留的不是最小值，用户会选到超限的数");
    }

    #[test]
    fn 模态未知必须是_none_不能当成不能看图() {
        // 这条守的是整族函数的要害：`Some(false)`（我确定它不能看图）和 `None`（我不知道）
        // 在下游是两条完全不同的路——后者会回落到按名字猜，前者会直接判定"要代看图"。
        // 把空当成 false，等于拿"没数据"当成了"确定不行"，每次带图请求都多烧一次 gpt-5.5。
        assert_eq!(image_capability(&[]), None, "空 = 未知，不是「不能看图」");
        assert_eq!(
            image_capability(&["text".to_string()]),
            Some(false),
            "明确只有 text = 确定不能看图"
        );
        assert_eq!(
            image_capability(&["text".to_string(), "image".to_string()]),
            Some(true)
        );
    }

    #[test]
    fn 模态字段缺失时返回空_让调用方回落名字表() {
        // 空**不是**"这个模型没有任何模态"，而是"目录没给"。必须让调用方回落到名字表，
        // 否则一个目录没收录的模型会被断言成"不能看图"，白白多走一次代看图。
        let empty = serde_json::json!({"id": "x/y"});
        let (map, _) = parse_catalog(std::slice::from_ref(&empty));
        let e = map.get("y").unwrap();
        assert!(e.input_modalities.is_empty());
        assert!(e.output_modalities.is_empty());
        // 类型不对也要当成缺失，不能 panic
        let bad = serde_json::json!({"id": "a/b", "architecture": {"input_modalities": "text"}});
        let (map2, _) = parse_catalog(std::slice::from_ref(&bad));
        assert!(map2.get("b").unwrap().input_modalities.is_empty());
    }

    #[test]
    fn 不同模型不能被归一化撞到一起() {
        // 归一化会丢掉分隔符，所以必须确认它没把不同的型号抹平——撞了就会把
        // A 的上下文和档位安到 B 头上，而且完全没有报错。
        let ids = [
            "claude-opus-5",
            "claude-opus-4-5",
            "claude-sonnet-5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.5",
            "qwen3.8-max",
            "kimi-k3",
            "glm-5",
            "deepseek-v4-flash",
        ];
        let mut seen = std::collections::HashMap::new();
        for id in ids {
            if let Some(prev) = seen.insert(normalize(id), id) {
                panic!("{id} 和 {prev} 归一化后撞成同一个 key");
            }
        }
    }
}


#[cfg(test)]
mod carry_forward_tests {
    /// 计费的兜底价不许跟着上游搞活动往下走。
    ///
    /// `official_price()` 读的就是目录里这一列，而每模型没单独配价时 `compute_cost` 用的
    /// 就是它。OpenRouter 的挂牌价会因为活动、促销、某家承载商临时降价而下调 ——
    /// 目录一降，我们对用户的收费当场跟着降，而付给上游的钱没降。
    ///
    /// 锚定 = 取窗口内观测到的最高价。四种情形分别是四种不同的错误后果，逐条钉：
    #[test]
    fn the_billing_fallback_price_never_follows_a_promo_down() {
        use super::anchor_price;

        // ① 上游在搞活动（挂牌 1.0，窗口里有过 5.0）→ 按 5.0 收。这是这个功能本体。
        assert_eq!(anchor_price(Some(1.0), Some(5.0)), Some(5.0));

        // ② 真涨价了（挂牌 8.0 高于窗口最高 5.0）→ 立刻按 8.0。涨价没有理由拖 ——
        //    拖着就是我们自己吃掉差价。
        assert_eq!(anchor_price(Some(8.0), Some(5.0)), Some(8.0));

        // ③ 目录临时不回价了（挂牌 None，窗口有 5.0）→ 仍按 5.0。
        //    退回「没有价」的话 compute_cost 会返回 0 —— 那是白送，不是保守。
        assert_eq!(anchor_price(None, Some(5.0)), Some(5.0));

        // ④ 第一次见这个模型（窗口里什么都没有）→ 用挂牌价，不许凭空造一个。
        assert_eq!(anchor_price(Some(2.0), None), Some(2.0));
        assert_eq!(anchor_price(None, None), None);

        // 相等时不抖：返回哪一个都一样，但不能返回 None。
        assert_eq!(anchor_price(Some(3.0), Some(3.0)), Some(3.0));

        // ── 接线 ──────────────────────────────────────────────────────────
        // 纯函数对了不等于刷新用了它，也不等于**内存**目录跟着抬了。
        // `refresh` 收尾是 `*CATALOG.write() = map` 整表替换，只更新库的话这一轮进程里
        // official_price() 读到的仍是活动价，要等下次重启才对 —— 而计费每秒都在读它。
        let src = include_str!("model_catalog.rs");
        // 从 `refresh` 切到它后面第一个测试模块。**不能**从文件头切到第一个
        // `#[cfg(test)]` —— 这个文件第一个 `#[cfg(test)]` 在第 206 行，比要检查的代码
        // 还靠前，那样切出来的 prod 里什么都没有，四条断言全部假红（刚踩过）。
        let from = src.find("async fn refresh(").expect("refresh 改名了");
        let prod = &src[from..];
        let prod = &prod[..prod.find("\n#[cfg(test)]").unwrap_or(prod.len())];
        // 阳性对照：切片必须真的含着要查的代码，且不能把这条测试自己包进来 ——
        // 包进来的话下面每一条都在读自己写的字面量，变异之后照样全绿。
        assert!(prod.contains("async fn persist("), "切片里没有 persist —— 切坏了，下面不作数");
        assert!(
            !prod.contains("fn the_billing_fallback_price"),
            "切片把这条测试自己包进去了 —— 断言会匹配到自己写的字面量",
        );
        assert!(
            prod.contains("persist(state, &mut map, &source_ids).await?;"),
            "persist 拿的不再是 &mut map —— 锚定只能落到库里，这一轮进程仍按活动价计费",
        );
        assert!(
            prod.contains("let ni = anchor_price(entry.input_price, *hi_in);")
                && prod.contains("let no = anchor_price(entry.output_price, *hi_out);"),
            "内存目录没有按锚定价抬上去",
        );
        assert!(
            prod.contains("INSERT INTO model_catalog_price_log"),
            "没有记录每天的挂牌价 —— 没有历史就算不出窗口内最高价，锚定恒等于当天价",
        );
        assert!(
            prod.contains("let window = crate::settings::official_price_window_days();")
                && prod.contains("if window > 0 {"),
            "窗口天数没走设置，或者关不掉 —— 运营要能把它调回「跟着挂牌价走」",
        );
    }

    /// 探到的窗口必须**跨刷新存活**。
    ///
    /// 刷新一轮结束时是 `*c = map` 整表替换。「上一轮探到过就跳过重探」如果只是 continue，
    /// 那条记录根本没进新表 —— 每 6 小时抹一次，同一个模型今天 200K、明天「不知道」，
    /// 客户端的上下文预算和压缩阈值跟着抖。注释写的是「长期沿用」，代码得真的沿用。
    ///
    /// 刷新本身要打网络，测不了；这里钉的是**那一步有没有写回新表**这个形状。
    #[test]
    fn probed_windows_survive_a_catalog_refresh() {
        let whole = include_str!("model_catalog.rs");
        let src = match whole.find("mod carry_forward_tests") {
            Some(i) => &whole[..i],
            None => whole,
        };
        assert!(
            src.contains("if let Some(prev) = lookup(model).filter(|e| !e.contexts.is_empty()) {"),
            "沿用分支不见了"
        );
        assert!(
            src.contains("map.insert(key, prev);"),
            "跳过重探却没把上一轮的结果写进新表 —— 整表替换时会被抹掉，每 6 小时丢一次"
        );
        // 反向：不许退回成「只 continue，不写回」。
        assert!(
            !src.contains("if lookup(model).is_some_and(|e| !e.contexts.is_empty()) {\n            continue;"),
            "又退回成只跳过不写回了"
        );
    }
}
