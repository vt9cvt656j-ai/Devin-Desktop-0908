//! 一条线路是不是真的在工作 —— 用**真实流量的结局**说话，而不是敲上游的前门。
//!
//! ## 它要修的东西
//!
//! `health.rs` 的探针对线路的 `base_url` 发一个不带凭据的 GET，任何回应都算健康。而十条
//! 线路共用同一个上游域名，所以它其实是把同一次 TCP 握手做了十遍，记录 1–10ms、全绿。
//! 2026-08-19 那次事故里，「Claude 强力版」连续 44 小时零成功，面板从头到尾报 `ok=t 1ms`,
//! **监控一次都没响过**。
//!
//! ## 为什么不是「成功率 + 时间窗」
//!
//! 这是设计里最要紧的一处，第一版就栽在这儿。按成功率判定需要样本量，而这台机器实测
//! 约 1,540 次成功/天，摊到 8–9 条有流量的线路上，**平均每条每小时只有个位数**。于是
//! 「近 60 分钟至少 20 个样本」这类门槛几乎永远够不到，判定只能退到更长的窗；而回退窗
//! 里装的是**故障之前**的成功，它只会把结论往好看的方向拉。按那套规则算一遍这次事故：
//! 一条彻底死掉的线路要 1.2 小时才离开绿色、12 小时才跌破告警线。那不是修好监控，
//! 是把 44 小时换成 12 小时。
//!
//! 所以这里换了口径：**连败次数** 和 **上一次真正成功是什么时候**。这两个量与样本量无关，
//! 每天 4 次请求也能定性 —— 强力版当时是 34 连败，第 5 次就该报出来。
//!
//! ## 为什么放 Redis 而不是建表
//!
//! 需要的状态是「每条线路一行」，不是流水：连败数、上次成功时刻、上次尝试时刻。
//! 十个键，Redis 的 INCR/SET 是原子的、亚毫秒、不占连接池、没有行锁 —— 而这个项目
//! 有过教训：门禁往 users 表写，36 万次 UPDATE 把同一用户的并发请求串行化了。
//! 观测不该和计费（`bill_inner` 跨 BEGIN/UPDATE/COMMIT 持一条连接，失败就是真金）
//! 抢同一个连接池。也不需要保留期、不需要清理、不占盘 —— 这台机器有过被构建塞满盘的
//! 记录，而盘满时 Postgres 拒写等于每个 chat 请求都失败。
//!
//! ## 为什么没有 Drop guard
//!
//! 用 Drop 落库的话，客户端在 `req.send()` 期间断开时 handler future 被丢弃、guard 带着
//! 一个**没查明的初值**落库：记成失败就是把「用户点了停止」算成线路故障，记成成功就是
//! 重新造出这里要杀掉的假绿灯。这里只在**结局确实已知**的四个点显式记一次，客户端取消
//! 时什么都不执行 —— 不写，就不会写错。

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::AppState;

/// 连续多少次非成功就判定这条线路坏了。
///
/// 与样本量无关，这正是它在「每天 4 次请求」的量级上仍然管用的原因。
///
/// 取 5 而不是 3：这台机器的硬失败率常态在 16–20%，3 连败的自然概率约 0.6%（每 170 组
/// 就撞一次），会造成误报；5 连败约 0.02%，而真坏掉的线路一分钟内就能攒够。
const FAILING_STREAK: i64 = 5;

/// 成功多久之内才算「现在是好的」。
///
/// 超过这个时间没有新的成功，并不代表坏了 —— 也可能只是没人用。所以它不产生「坏」，
/// 只是让状态退回「不知道」。**绝不能因为没有证据就报绿**，那正是探针在做的事。
const OK_FRESH_SECS: i64 = 15 * 60;

/// 键的存活期。线路被删或长期不用时不留垃圾；30 天远长于任何判定窗口。
const KEY_TTL_SECS: i64 = 30 * 24 * 3600;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn key(route_id: Uuid, field: &str) -> String {
    format!("rh:{route_id}:{field}")
}

/// 一条线路当前的健康事实。全部来自真实流量。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RouteHealth {
    /// 连续非成功次数。一次成功清零。
    pub consecutive_failures: i64,
    /// 上一次拿到成功响应的 unix 秒。None = 有记录以来从没成功过。
    pub last_ok_at: Option<i64>,
    /// 上一次**结局已知**的尝试。None = 这条线路根本没被真实流量碰过。
    pub last_attempt_at: Option<i64>,
    /// 上一次失败时上游给的状态码，便于面板直接说清原因。
    pub last_fail_status: Option<i64>,
}

/// 把事实翻译成面板上的状态词。
///
/// **刻意只用 health.rs 现有的那四个词**（ok / degraded / error / unknown）。前端把状态词
/// 查一张四键表来上色，多一个词就是一颗无字无色的空药丸；而且这一屏挂在 /dashboard 上、
/// 所有登录用户都看得到，内部诊断词不该漏给客户。要表达的东西这四个词够用。
///
/// 顺序是判定的一部分，有测试正面钉着：**先判坏，再判好**。反过来的话，小样本全失败
/// 会被「样本不足」一类的中性结论吞掉 —— 那恰好是这次事故的形态。
pub fn classify(h: &RouteHealth, now: i64) -> &'static str {
    // 1) 连败达标 → 坏。与样本量、时间窗都无关，这是唯一能在低流量下有界时间内定性的规则。
    if h.consecutive_failures >= FAILING_STREAK {
        return "error";
    }
    // 2) 试过、但从来没成功过 → 坏。强力版就是这个形状：34 次尝试、0 次成功。
    if h.last_attempt_at.is_some() && h.last_ok_at.is_none() {
        return "error";
    }
    // 3) 根本没被碰过 → 不知道。**不是绿**。
    //    这是真实流量口径的固有盲区：没有请求就没有证据。宁可说不知道，也不要替它担保。
    let Some(last_ok) = h.last_ok_at else {
        return "unknown";
    };
    // 4) 最近成功过，且没在连败 → 好。
    if now.saturating_sub(last_ok) <= OK_FRESH_SECS {
        return if h.consecutive_failures > 0 { "degraded" } else { "ok" };
    }
    // 5) 上次成功已经旧了：坏消息新于好消息就报降级，否则只是没人用 → 不知道。
    if h.consecutive_failures > 0 {
        return "degraded";
    }
    "unknown"
}

/// 记一次**成功**：上游收下请求并开始回话。
///
/// 口径是「这条线路接得通、认得了凭据、开始出字」，不是「这一轮流式完整结束」。
/// 两者刻意分开：流中途断掉在一个 agentic IDE 里多半是用户按了停止，把它算成线路故障
/// 会把好线路刷成红的，然后告警疲劳 —— 那是这次事故的真正成因，不能用另一种方式复制。
pub async fn record_ok(state: &AppState, route_id: Uuid) {
    let mut conn = state.redis.clone();
    let now = now_secs();
    let _: Result<(), _> = redis::pipe()
        .cmd("SET").arg(key(route_id, "ok_at")).arg(now).arg("EX").arg(KEY_TTL_SECS).ignore()
        .cmd("SET").arg(key(route_id, "last_at")).arg(now).arg("EX").arg(KEY_TTL_SECS).ignore()
        .cmd("DEL").arg(key(route_id, "fails")).ignore()
        .query_async(&mut conn)
        .await;
}

/// 记一次**失败**：上游明确报错、卡死不回话、或传输层出错。
///
/// 客户端主动取消**不走这里**：那种情况下 handler future 直接被丢弃，这个函数根本不会被
/// 调用。不写就不会写错，这是不用 Drop guard 换来的。
pub async fn record_fail(state: &AppState, route_id: Uuid, status: u16) {
    let mut conn = state.redis.clone();
    let now = now_secs();
    let _: Result<(), _> = redis::pipe()
        .cmd("INCR").arg(key(route_id, "fails")).ignore()
        .cmd("EXPIRE").arg(key(route_id, "fails")).arg(KEY_TTL_SECS).ignore()
        .cmd("SET").arg(key(route_id, "last_at")).arg(now).arg("EX").arg(KEY_TTL_SECS).ignore()
        .cmd("SET").arg(key(route_id, "fail_status")).arg(status as i64).arg("EX").arg(KEY_TTL_SECS).ignore()
        .query_async(&mut conn)
        .await;
}

/// 把这一次尝试的**真实结果**记进库：哪条线路、哪个模型、成没成、多快。
///
/// # 和 model_health / Redis 连败计数的区别
///
/// `model_health` 探的是不带凭据的 GET —— 「门在不在」，密钥过期和额度用尽它一律报绿
/// （实测「Claude 强力版」前门可达 99.93%，而真实成功在 43 小时前）。
/// Redis 那个连败计数按线路、没有模型维度、没有历史，算不出成功率。
///
/// 这里记的是**真实流量的结果**，而且成功和失败记在同一张表里 —— 成功那一半原本就有
/// （model_usage 每次扣费写一行），缺的一直是失败，于是分母永远少一块。
///
/// # 不等它写完
///
/// 和 `spawn_ok` 一样 tokio::spawn 出去。派单路径上一个 await 都不加：
/// 观测失败绝不能让用户多等一毫秒。写不进去的后果只是这一格「不知道」，
/// 而「不知道」不会被判成绿。
pub fn spawn_attempt(
    state: &AppState,
    endpoint_id: Uuid,
    model_id: &str,
    ok: bool,
    status: Option<u16>,
    ttfb_ms: Option<u64>,
) {
    if model_id.trim().is_empty() {
        return;
    }
    let st = state.clone();
    let model = model_id.to_string();
    // 成功才累加耗时：失败那次的耗时是「等超时等了多久」，混进平均值会让一条
    // 一直超时的线路看起来「很慢但在服务」，而它其实一次都没成。
    let (ms_sum, ms_n) = match (ok, ttfb_ms) {
        (true, Some(ms)) => (ms.min(600_000) as i64, 1i64),
        _ => (0, 0),
    };
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO route_attempt \
               (day, endpoint_id, model_id, ok_calls, fail_calls, last_status, ttfb_ms_sum, ttfb_ms_n, last_ok_at, last_fail_at) \
             VALUES (current_date, $1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (day, endpoint_id, model_id) DO UPDATE SET \
               ok_calls    = route_attempt.ok_calls   + EXCLUDED.ok_calls, \
               fail_calls  = route_attempt.fail_calls + EXCLUDED.fail_calls, \
               last_status = COALESCE(EXCLUDED.last_status, route_attempt.last_status), \
               ttfb_ms_sum = route_attempt.ttfb_ms_sum + EXCLUDED.ttfb_ms_sum, \
               ttfb_ms_n   = route_attempt.ttfb_ms_n   + EXCLUDED.ttfb_ms_n, \
               last_ok_at   = GREATEST(route_attempt.last_ok_at,   EXCLUDED.last_ok_at), \
               last_fail_at = GREATEST(route_attempt.last_fail_at, EXCLUDED.last_fail_at), \
               updated_at  = now()",
        )
        .bind(endpoint_id)
        .bind(&model)
        .bind(if ok { 1i64 } else { 0 })
        .bind(if ok { 0i64 } else { 1 })
        .bind(status.map(|s| s as i32))
        .bind(ms_sum)
        .bind(ms_n)
        // 成功写一列、失败写另一列，各记各的时刻。排序读的是**较晚的那个** ——
        // 也就是这个出口最近一次真实结果到底是活是死。
        .bind(if ok { Some(chrono::Utc::now()) } else { None })
        .bind(if ok { None } else { Some(chrono::Utc::now()) })
        .execute(&st.db)
        .await;
    });
}

/// 把这一条流**吐得多快**记进库：吐了多少 token、流了多少毫秒。
///
/// # 和 `spawn_attempt` 的分工
///
/// `spawn_attempt` 在**响应头到手**那一刻就记了，它答的是「接不接得通、多久开口」。
/// 这个函数在**流结束**才记，答的是另一半：开口之后，一个字一个字吐完要多久。
///
/// 两半必须分开记，因为它们在时间上就是分开的 —— 响应头那一刻还不知道会吐多少。
/// 落库落在同一行（day, endpoint_id, model_id），只是这一次只碰吐字那三列。
///
/// # 为什么这一半才是用户等的大头
///
/// 线上实测（2026-09-08，主对话）：一步的墙钟里首字约 5 秒、吐字 60~70 秒，
/// 吐字占 93%。而派单得分原来只看首字 —— 它在优化那 7%，对 93% 完全瞎。
///
/// # 什么样的观测才算数
///
/// 只在**流完整结束**且真的吐出了内容时记。中途断掉的那些一律不记：在 agentic IDE 里
/// 流中断多半是用户按了停止，那一段「时长」量的是用户什么时候改的主意，不是出口的速度。
/// 太短的流也不记（`MIN_STREAM_MS`）—— 一次几百毫秒的回答里，首块抖动就能让算出来的
/// 速度翻倍，这种样本进了平均值只会让排序天天翻烧饼。
///
/// 和 `spawn_ok` 一样 tokio::spawn 出去，派单路径上一个 await 都不加。
pub fn spawn_throughput(
    state: &AppState,
    endpoint_id: Uuid,
    model_id: &str,
    out_tokens: u64,
    stream_ms: u64,
) {
    if model_id.trim().is_empty() || out_tokens == 0 || stream_ms < MIN_STREAM_MS {
        return;
    }
    let st = state.clone();
    let model = model_id.to_string();
    // 上限和 ttfb 那边同一个量级：一条流不可能真的跑十分钟还算正常样本，
    // 真跑了也说明它慢到不该拿来定义「正常速度」。
    let tokens = out_tokens.min(1_000_000) as i64;
    let ms = stream_ms.min(600_000) as i64;
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO route_attempt \
               (day, endpoint_id, model_id, out_tokens_sum, stream_ms_sum, stream_n) \
             VALUES (current_date, $1, $2, $3, $4, 1) \
             ON CONFLICT (day, endpoint_id, model_id) DO UPDATE SET \
               out_tokens_sum = route_attempt.out_tokens_sum + EXCLUDED.out_tokens_sum, \
               stream_ms_sum  = route_attempt.stream_ms_sum  + EXCLUDED.stream_ms_sum, \
               stream_n       = route_attempt.stream_n       + 1, \
               updated_at     = now()",
        )
        .bind(endpoint_id)
        .bind(&model)
        .bind(tokens)
        .bind(ms)
        .execute(&st.db)
        .await;
    });
}

/// 短于这个的流不进吐字速度的样本。见 `spawn_throughput` 里那段。
pub const MIN_STREAM_MS: u64 = 1_500;

/// 记一次成功，**不等它写完**。
///
/// 派单路径上一个 await 都不加：观测失败绝不能让用户多等一毫秒，也绝不能把一次请求
/// 拖垮。Redis 写不进去的后果只是这条线路暂时"不知道"——而"不知道"不会被判成绿。
pub fn spawn_ok(state: &AppState, route_id: Uuid) {
    let st = state.clone();
    tokio::spawn(async move { record_ok(&st, route_id).await });
}

/// 记一次失败，同样不等。
pub fn spawn_fail(state: &AppState, route_id: Uuid, status: u16) {
    let st = state.clone();
    tokio::spawn(async move { record_fail(&st, route_id, status).await });
}

// ── 派单侧的读取口 ────────────────────────────────────────────────────────────
//
// # 为什么要有这一段
//
// 这个模块本来**只有写入方**。`models.rs` 里 `route_health::` 出现十处，全是
// spawn_ok / spawn_fail / spawn_attempt —— 派单一次都没读过自己的裁决。于是整套
// 「连败 5 次判死」「试过但从没成功过判死」只喂了面板和告警邮件，**对流量没有任何影响**。
//
// 派单实际依据的是 `route_goes_to_the_back` 里那三个**进程内**的短期标记
// （cooled / mutes / stalled），它们随重启清零、也不跨实例共享。后果是生产实测
// 2026-08-28 当日：`Claude` 0 成功 / 25 失败、`优惠 Claude` 0 成功 / 24 失败，
// 两条彻底不工作的线路仍被派了 49 次真实请求。每撞一次就是一次换线，而换线要把
// 上游那份提示词缓存整份重写（写价是读价的 12.5 倍）。
//
// 所以补上读取口。三条纪律：
//
//   · **只降权，不排除。** 和冷却、静音思考一样 —— 全部线路都判死时还得有东西可发，
//     而且降权之后它靠探活自己走回来（探活对非 ok 线路一律全速，见
//     `canary_fresh_window_secs`）。这两处必须一起看：降权断了真实流量，
//     探活就是它唯一的恢复通道，两边同时省钱就等于把线路永久静音。
//   · **热路径不查 Redis。** 派单是每请求都走的，`snapshot` 是一次 MGET 网络往返。
//     这里只读进程内缓存，缺了就当「不知道」放行，同时丢一个后台任务去刷。
//   · **缺省放行。** 缓存没有、Redis 挂了、刚重启 —— 一律不降权。宁可多试一条坏线路，
//     也不要因为读不到裁决把好线路排到后面：那是拿「没查到」当「有问题」。

static VERDICT_CACHE: LazyLock<Mutex<std::collections::HashMap<Uuid, (bool, Instant)>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 裁决在派单侧的保鲜期。短到线路恢复后一分钟内就能重新拿到流量，
/// 长到不会让每个请求都去敲 Redis。
const VERDICT_TTL: Duration = Duration::from_secs(30);

/// 这条线路当前是不是被判死了。**派单热路径专用：不查 Redis、不阻塞、缺省返回 false。**
///
/// 返回 false 的三种情形是同一个意思——「还不知道」：缓存里没有、已经过期、
/// 或者后台那次刷新还没回来。
pub fn looks_broken_cached(state: &AppState, route_id: Uuid) -> bool {
    let now = Instant::now();
    if let Some(broken) = verdict_cached_at(route_id, now) {
        return broken;
    }
    // 先占位再刷新：占位本身会让接下来 VERDICT_TTL 内的请求不再重复丢任务。
    // 占的是 false —— 结论没回来之前不许降权。
    verdict_remember(route_id, false, now);
    let st = state.clone();
    tokio::spawn(async move {
        let h = snapshot(&st, route_id).await;
        let broken = classify(&h, now_secs()) == "error";
        verdict_remember(route_id, broken, Instant::now());
    });
    false
}

/// 缓存里还新鲜的裁决。`None` = 没有、或者已经过期 —— 两种都叫「还不知道」。
fn verdict_cached_at(route_id: Uuid, now: Instant) -> Option<bool> {
    let m = VERDICT_CACHE.lock().ok()?;
    let (broken, at) = m.get(&route_id)?;
    // `saturating_duration_since`：测试里会传一个比写入时刻**早**的 now，
    // `duration_since` 在那种情况下会 panic。
    (now.saturating_duration_since(*at) < VERDICT_TTL).then_some(*broken)
}

fn verdict_remember(route_id: Uuid, broken: bool, at: Instant) {
    if let Ok(mut m) = VERDICT_CACHE.lock() {
        m.insert(route_id, (broken, at));
    }
}

/// 读一条线路的当前事实。Redis 读不到就返回全空 —— 全空经 `classify` 得到 "unknown"，
/// 不会变成绿灯。
pub async fn snapshot(state: &AppState, route_id: Uuid) -> RouteHealth {
    let mut conn = state.redis.clone();
    let got: Result<(Option<i64>, Option<i64>, Option<i64>, Option<i64>), _> = redis::cmd("MGET")
        .arg(key(route_id, "fails"))
        .arg(key(route_id, "ok_at"))
        .arg(key(route_id, "last_at"))
        .arg(key(route_id, "fail_status"))
        .query_async(&mut conn)
        .await;
    match got {
        Ok((fails, ok_at, last_at, fail_status)) => RouteHealth {
            consecutive_failures: fails.unwrap_or(0),
            last_ok_at: ok_at,
            last_attempt_at: last_at,
            last_fail_status: fail_status,
        },
        Err(err) => {
            tracing::warn!(%err, %route_id, "线路健康读取失败，按「不知道」处理");
            RouteHealth::default()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 金丝雀：给**没有真实流量**的线路一个证据来源
// ─────────────────────────────────────────────────────────────────────────────
//
// 真实流量口径有一个固有盲区：没有请求就没有证据，那条线路只能显示「不知道」。
// 这比原来的假绿灯诚实，但覆盖不到事故里最危险的一类 —— 实测「Claude 强力版」168 小时里
// 只有 3 小时有流量，Kimi 建库至今零调用。它们坏了也没人会知道，直到某个用户点中它。
//
// 所以对**近期没有证据**的线路，自己发一次最小的真实请求：max_tokens=1、两个 token 的提示。
// 三条纪律：
//   · 只探没有新鲜证据的线路 —— 忙碌的线路本来就有真实流量，一分钱都不该花；
//   · 每轮有条数上限，避免某天多配了几十条线路时一次烧穿；
//   · 有开关（ROUTE_CANARY=0），因为它花的是真钱。
//
// **必须按线路的协议分支。** 直接照 model_probe.rs 那样只发 OpenAI 形状的话，所有
// anthropic 线路都会探测失败 —— 而假红比假绿更糟：它会把好线路报成坏的，然后告警被静音。

/// 多久跑一轮。
const CANARY_EVERY: Duration = Duration::from_secs(15 * 60);
/// 这条线路多久之内有过证据就不探 —— 有真实流量时一分钱都不花。
const CANARY_SKIP_IF_FRESH_SECS: i64 = 15 * 60;
/// 一轮最多探几条。防止线路数量变多时一次烧穿。
const CANARY_MAX_PER_ROUND: usize = 4;
/// 单次探测的耐心。远短于派单路径的 57 秒：这里只问「接不接得通」，不等模型思考。
const CANARY_TIMEOUT: Duration = Duration::from_secs(20);

/// 每条线路每分钟最多花在「你还活着吗」上的输入 token。
///
/// # 为什么频率要按价定，而不是所有线路一个数
///
/// 探活发的是同一件东西：`"hi"` + `max_tokens=1`，两个 token 的提示。老实的上游就
/// 照这个记账 —— 生产 `endpoint_probe_usage` 七天实测，Claude 强力版每发 **8** 个
/// token、智普 **13**、Claude **36**。但同一发请求：
///
/// ```text
///   GPT / gpt-5.6-sol        4,555 / 发
///   deepseek / v4-flash      2,685 / 发
///   Grok / grok-4.5          1,343 / 发
/// ```
///
/// 中转给两个字的提示词计了四千多个 token。这不是我们能改的事实，但**可以不按同一个
/// 频率去撞它**：这三条一周烧掉 897K 输入 token，占全部探活开销的 93%。
///
/// 所以「多久算有新鲜证据」不再是一个常数，而是由这条线路自己的报价决定：
/// 便宜的线路一点不受影响（8 token/发 的线路要 32 秒才用掉这份预算，远短于基础间隔），
/// 贵的线路自动探得稀 —— 稀到和便宜线路花一样的钱为止。
const CANARY_TOKENS_PER_MIN: f64 = 15.0;

/// 再贵也不能稀到没意义。
///
/// 这个上限只对**当前判定为 ok** 的线路生效（见 `canary_fresh_window_secs`）。坏的、
/// 降级的、没被碰过的线路一律走基础间隔 —— 需要探活的时候恰恰就是这些时候，
/// 省这笔钱等于把监控关掉。
const CANARY_MAX_FRESH_SECS: i64 = 6 * 60 * 60;

/// 每条线路一发探活实际被计了多少输入 token（指数滑动平均）。
///
/// 只在**上游真的回了 usage** 时更新（见 `note_probe_usage` 的零值早退）。失败的探活
/// 拿不到 usage，记 0 会把一条贵线路洗成便宜的，然后它又开始每 15 分钟被探一次。
static ROUTE_PROBE_COST_EWMA: LazyLock<Mutex<std::collections::HashMap<Uuid, f64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
const PROBE_COST_ALPHA: f64 = 0.3;

fn record_probe_cost(route_id: Uuid, prompt_tokens: i64) {
    if prompt_tokens <= 0 {
        return;
    }
    if let Ok(mut m) = ROUTE_PROBE_COST_EWMA.lock() {
        let e = m.entry(route_id).or_insert(prompt_tokens as f64);
        *e = *e * (1.0 - PROBE_COST_ALPHA) + (prompt_tokens as f64) * PROBE_COST_ALPHA;
    }
}

fn probe_cost(route_id: Uuid) -> Option<f64> {
    let m = ROUTE_PROBE_COST_EWMA.lock().ok()?;
    m.get(&route_id).copied()
}

/// 这条线路多久之内有过证据就不用再探。
///
/// **进程刚起来时表是空的 —— 这时退回基础间隔**，也就是改动前的行为。宁可多探几发，
/// 也不要凭一个还不存在的报价把线路静音。
fn canary_fresh_window_secs(route_id: Uuid, state_word: &str) -> i64 {
    // 只有「确实还好」的线路才配省这笔钱。degraded / error / unknown 一律全速探。
    if state_word != "ok" {
        return CANARY_SKIP_IF_FRESH_SECS;
    }
    let Some(cost) = probe_cost(route_id) else {
        return CANARY_SKIP_IF_FRESH_SECS;
    };
    let secs = (cost / CANARY_TOKENS_PER_MIN * 60.0).round() as i64;
    secs.clamp(CANARY_SKIP_IF_FRESH_SECS, CANARY_MAX_FRESH_SECS)
}

fn canary_enabled() -> bool {
    std::env::var("ROUTE_CANARY").ok().as_deref() != Some("0")
}

/// 把一次探活烧掉的 token 记下来。
///
/// **火后不管**：丢一笔对反推单价的影响远小于让探活阻塞在写库上。但和别处的
/// 「火后不管」不同，这里**不吞错误** —— 这张表少了数据的后果是反推出来的单价偏高，
/// 而那个数字看起来完全正常，没有任何迹象说它被污染了。
fn note_probe_usage(
    state: &AppState,
    route_id: uuid::Uuid,
    model_id: &str,
    tokens: ProbeTokens,
) {
    if model_id.is_empty() || (tokens.prompt == 0 && tokens.completion == 0) {
        return; // 上游没回 usage —— 记一行全 0 只会稀释判据
    }
    // 这条线路每发探活到底要多少钱 —— 下一轮据此决定还探不探（见 CANARY_TOKENS_PER_MIN）。
    record_probe_cost(route_id, tokens.prompt);
    let db = state.db.clone();
    let model = model_id.to_string();
    tokio::spawn(async move {
        let r = sqlx::query(
            "INSERT INTO endpoint_probe_usage \
               (day, endpoint_id, route_id, model_id, calls, prompt_tokens, completion_tokens) \
             VALUES (current_date, $1, $1, $2, 1, $3, $4) \
             ON CONFLICT (day, endpoint_id, model_id) DO UPDATE SET \
               calls = endpoint_probe_usage.calls + 1, \
               prompt_tokens = endpoint_probe_usage.prompt_tokens + EXCLUDED.prompt_tokens, \
               completion_tokens = endpoint_probe_usage.completion_tokens + EXCLUDED.completion_tokens, \
               updated_at = now()",
        )
        .bind(route_id)
        .bind(&model)
        .bind(tokens.prompt)
        .bind(tokens.completion)
        .execute(&db)
        .await;
        if let Err(e) = r {
            tracing::warn!(error = %e, model = %model,
                "探活用量写失败 —— 按余额差反推单价时会把这笔摊到用户 token 上，算高");
        }
    });
}

/// 对一条线路发一次最小真实请求。
///
/// 返回 `None` = **这一次没有产生任何证据**，调用方必须什么都不记。
///
/// 这个区分是必须显式表达的：第一版这里在「无从探起」时返回了 `(true, 0)`，而调用方看到
/// `ok=true` 就 `record_ok` —— 凭空造了一次成功、把连败计数清零、点亮绿灯。注释当时写的是
/// 「不产生证据，也不产生结论」，代码做的却是相反的事。这正是这套监控要消灭的东西
/// （没有证据不许报绿），结果在它自己身上重演了一遍。
///
/// 探哪个模型要和**派单口径一致**（`allowed_ids`）：`enabled_models` 为空时派单会回落到
/// `model_id`，那种线路照样在接真实流量，不能因为第一个字段是空的就当它不存在。
/// 一次探活烧掉的 token。
///
/// 探活发的是**真实推理请求**，所以它真的花钱。不把这个数带出来的话，那笔钱在账上
/// 完全不存在 —— 而它会以「余额对不上」的形式出现在对账页，看起来像别处出了问题。
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ProbeTokens {
    pub prompt: i64,
    pub completion: i64,
}

/// 上游用这个码说的是「**这个模型**不在这」，不是「这个出口不在这」。
///
/// 400 = 请求里有它不认的东西（最常见就是模型名），404 = 找不到这个模型。
/// 两者都只否定一个模型；401/403（密钥）、5xx、超时才是否定整个出口的。
fn rejects_only_this_model(status: u16) -> bool {
    matches!(status, 400 | 404)
}

async fn canary_once(m: &crate::models::Model) -> Option<(bool, u16, ProbeTokens, String)> {
    let ids = crate::models::allowed_ids(m);
    // **一个下线的型号不该判死整个出口。**
    //
    // 这里原来是 `ids.first()?` —— 拿启用列表里的第一个去探，探不通就整个出口报红。
    // 线上实测：`Claude` 线路的列表第一个是 `claude-fable-5`，那是 8/30 之后再没被
    // 用过的旧型号（现在是 `claude-fable-5-1`）。polly 这个出口不提供它 → 400 →
    // 整个出口被探成死的。而它 14 天里真实跑了 1171 次成功、95 次失败，是 Claude 上
    // 量最大的出口之一。
    //
    // 后果是自我强化的：真实流量的保质期是 2 小时（`PROBE_FRESH_SECS`），一旦超过就
    // 改按探测结论排序 → 这个出口掉到最差档 → 更拿不到流量 → 更没有新鲜的真实记录 →
    // 一直压着。
    //
    // 所以：400/404 只否定**这一个模型**，换下一个接着探；把整个出口判死，必须是
    // 所有允许的模型都被否定，或者遇到密钥/连接层的错（那些和模型无关）。
    // 代价是最多几发 1-token 的探测，而且只在第一个模型就 400 的时候才会发生。
    probe_until_decisive(&ids, |id| canary_once_with(m, id.clone()), |r| r.1).await
}

/// 逐个模型探，直到拿到一个**和模型无关**的结论。
///
/// · 探通了，或者失败的原因和模型无关（密钥、连接层、5xx）→ 就是这个出口的结论，立即返回，
///   不再多发探测；
/// · 「这个模型不在这」（400/404）→ 换下一个接着探；
/// · 每一个允许的模型都被否掉了 → 采信最后一个，那才是出口真的不可用。
///
/// 抽成独立函数不是为了整洁，是为了**这条判据能在测试里真跑**：上面那个循环里唯一的
/// 判断就是「什么时候停」，而它以前只能靠扫源码来守 —— 而源码断言守不住 `.take(1)`
/// 这种改动（实测：加上 `.take(1)` 之后断言照样绿）。
async fn probe_until_decisive<R, F, Fut>(
    ids: &[String],
    mut probe: F,
    status_of: impl Fn(&R) -> u16,
) -> Option<R>
where
    F: FnMut(&String) -> Fut,
    Fut: std::future::Future<Output = Option<R>>,
{
    let mut last: Option<R> = None;
    for id in ids.iter() {
        let r = probe(id).await?;
        if !rejects_only_this_model(status_of(&r)) {
            return Some(r);
        }
        last = Some(r);
    }
    last
}

async fn canary_once_with(
    m: &crate::models::Model,
    model_id: String,
) -> Option<(bool, u16, ProbeTokens, String)> {
    let model_id = &model_id;
    let http = reqwest::Client::builder().timeout(CANARY_TIMEOUT).build().ok()?;
    let key = crate::models::model_key(&m.api_key);
    let base = crate::models::api_base(&m.base_url);
    let wire = crate::models::Wire::of(&m.protocol);
    // xAI Responses：端点和请求体都是另一套名字。用 chat/completions 那套去探，
    // 一条从没验证过的线路会被探成绿灯、排到前面接管流量，然后每一发都失败。
    let req = if wire == crate::models::Wire::XaiResponses {
        http.post(format!("{base}/responses"))
            .header("Authorization", format!("Bearer {key}"))
            .json(&serde_json::json!({
                "model": model_id,
                "max_output_tokens": 1,
                "input": [{ "role": "user", "content": "hi" }],
            }))
    } else if wire == crate::models::Wire::Anthropic {
        http.post(format!("{base}/messages"))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({
                "model": model_id,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "hi" }],
            }))
    } else {
        http.post(format!("{base}/chat/completions"))
            .header("Authorization", format!("Bearer {key}"))
            .json(&serde_json::json!({
                "model": model_id,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "hi" }],
            }))
    };
    match req.send().await {
        Ok(r) => {
            let s = r.status().as_u16();
            if !r.status().is_success() {
                return Some((false, s, ProbeTokens::default(), model_id.clone()));
            }
            // 2xx 还不够，判据和出口探测共用一份。
            //
            // 这里曾经只看 `status().is_success()`，而 route_endpoints 那边打**同一个
            // 地址、同一个模型、同一个密钥**却要求响应里真的有 content/choices/usage。
            // 于是一个「200 + 错误体」的上游（转卖网关的常见形态）会在出口页报红、
            // 在健康页和邮件告警里报绿 —— 而告警侧用的恰好是宽的那一份。
            //
            // 「没有证据不许报绿」是这套监控的立身之本，它却在自己身上破了功。
            let body = r.text().await.unwrap_or_default();
            // 顺手把 usage 抠出来 —— 这一发请求的钱已经花了，不记下来它就只会
            // 以「余额对不上」的形式出现在别处。两家协议的字段名不同，都认。
            let tokens = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    let u = v.get("usage")?.clone();
                    let g = |names: &[&str]| -> i64 {
                        names
                            .iter()
                            .find_map(|n| u.get(*n).and_then(|x| x.as_i64()))
                            .unwrap_or(0)
                    };
                    Some(ProbeTokens {
                        prompt: g(&["prompt_tokens", "input_tokens"]),
                        completion: g(&["completion_tokens", "output_tokens"]),
                    })
                })
                .unwrap_or_default();
            Some((
                crate::route_endpoints::looks_like_a_real_completion(&body),
                s,
                tokens,
                model_id.clone(),
            ))
        }
        // 超时/连不上：和派单路径上的卡死是同一种坏，用同一个码，面板上读起来一致。
        Err(_) => Some((false, 504, ProbeTokens::default(), model_id.clone())),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 卡死恢复探针：停机期间不让用户当探针
// ─────────────────────────────────────────────────────────────────────────────
//
// 派单路径上一条线路卡满表头预算后会记一个 120 秒的卡死记号（`models::mark_route_stall`）。
// 在这之前，记号只有两种退出方式：用户的真实请求真的拿到表头，或者 120 秒自然过期。
// 两种都由用户付费：记号在世时每个落上去的请求挂 25 秒；过期后下一个用户再挂满 57 秒；
// 停机持续多久就循环多久 —— 44 小时事故就是这个形状。而上面的巡检金丝雀反而不探它：
// 每次失败都刷新 last_attempt_at，被当成「有新鲜证据」跳过。
//
// 对用户请求做并发赛马是不行的：首字节=全文的中转在回表头前已经在跑模型，双发就是
// 双计费（models.rs 里「一次用户发送只对应一次上游调用」那条不变量）。所以赛的是探针：
// 卡死后按线路起一个后台任务，每 30 秒发一次 1-token 的最小真实请求（复用 `canary_once`
// 的协议分支）。失败就把记号续上 —— 停机期间线路持续降权、持续短预算，而不是 120 秒后
// 让用户去撞；成功就撤记号、撤冷却、记一次真实成功，任务退出。
//
// 纪律：
//   · 只对有记号的线路跑，记号一消失（真实流量拿到表头、或兜底过期）任务立刻停；
//   · 同一条线路只有一个任务；并发任务总数有上限 —— 超出的线路退回 120 秒过期的老路；
//   · 受同一个 ROUTE_CANARY 开关约束，因为它花的也是真钱；
//   · 「无从探起」（None）什么都不记、任务退出，和巡检金丝雀一样不伪造证据。

/// 两次恢复探测之间的间隔。必须明显短于卡死记号的有效期，否则记号会在两次探测之间
/// 过期、线路回到排头、用户又成了探针。
const STALL_RECOVERY_EVERY: Duration = Duration::from_secs(30);
/// 同时在跑的恢复任务上限。一次把整批线路都卡死（上游整体故障）时，不让探针本身
/// 变成一次小型压测；超出上限的线路退回 120 秒自然过期那条老路。
const STALL_RECOVERY_MAX_CONCURRENT: usize = 4;

/// 正在跑恢复任务的线路。进程内存即可：记号本身也在进程内存里，发版两边一起清零。
static STALL_RECOVERY_ACTIVE: LazyLock<Mutex<HashSet<Uuid>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// 这条线路现在能不能起一个恢复任务。返回 true 表示**已经占了名额**，调用方必须保证
/// 任务结束时 `stall_recovery_release`。
fn stall_recovery_admit(route_id: Uuid) -> bool {
    let Ok(mut active) = STALL_RECOVERY_ACTIVE.lock() else {
        return false;
    };
    if active.contains(&route_id) || active.len() >= STALL_RECOVERY_MAX_CONCURRENT {
        return false;
    }
    active.insert(route_id);
    true
}

fn stall_recovery_release(route_id: Uuid) {
    if let Ok(mut active) = STALL_RECOVERY_ACTIVE.lock() {
        active.remove(&route_id);
    }
}

/// 任务无论怎么结束（正常退出、panic、运行时关闭时被丢弃）都把名额还回去。
struct StallRecoverySlot(Uuid);
impl Drop for StallRecoverySlot {
    fn drop(&mut self) {
        stall_recovery_release(self.0);
    }
}

/// 一条线路刚刚卡满表头预算 —— 起一个后台任务替用户去探它什么时候恢复。
///
/// 调用时机是派单路径上 `mark_route_stall` 之后。派单路径上一个 await 都不加：这里只
/// 占名额、spawn，立刻返回。
pub fn spawn_stall_recovery(state: &AppState, m: crate::models::Model) {
    if !canary_enabled() {
        return;
    }
    if !stall_recovery_admit(m.health_id()) {
        return;
    }
    let st = state.clone();
    tokio::spawn(async move {
        let _slot = StallRecoverySlot(m.health_id());
        loop {
            tokio::time::sleep(STALL_RECOVERY_EVERY).await;
            // 记号没了 —— 要么真实流量已经拿到表头（clear_route_stall），要么兜底过期。
            // 两种都不该再花钱探。
            if !crate::models::route_recently_stalled(m.health_id(), Instant::now()) {
                tracing::info!(route = %m.label, "卡死记号已撤，恢复探针退出");
                return;
            }
            match canary_once(&m).await {
                Some((true, status, _, _)) => {
                    crate::models::clear_route_stall(m.health_id());
                    crate::models::clear_route_cooldown(m.health_id());
                    record_ok(&st, m.health_id()).await;
                    tracing::info!(route = %m.label, status, "卡死线路已由后台探针确认恢复，回到轮换");
                    return;
                }
                Some((false, status, _, _)) => {
                    // 还没好：把记号续上，让它在停机期间持续降权、持续短预算。
                    crate::models::mark_route_stall(m.health_id());
                    record_fail(&st, m.health_id(), status).await;
                    tracing::warn!(route = %m.label, status, "卡死线路仍未恢复（后台探针）");
                }
                // 无从探起（没有任何可用模型 id）：什么都不记，退出。记号按 120 秒自然过期。
                None => {
                    tracing::warn!(route = %m.label, "恢复探针无从探起：这条线路没有任何可用模型 id");
                    return;
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 告警：坏了要有人知道
// ─────────────────────────────────────────────────────────────────────────────
//
// 这次事故里监控从头到尾没报过警，而全仓搜不到任何针对健康的阈值或通知代码 ——
// 不是阈值设错，是**根本没有**。面板改准了，如果没人去看，44 小时还是 44 小时。
//
// 收件人取 `role='admin'` 的邮箱，不新造一个密钥：自配置、可发现，加一个运维进来就自动
// 收到。邮件开着却一个管理员都没有时，启动会明确报错 —— 一个没有收件人的告警系统，
// 和没有告警系统是一回事，但更危险，因为它看起来像有。

/// 连续判坏多久才发。给一次抖动留出自愈的时间，也避免部署瞬间的空窗触发。
const ALARM_AFTER_SECS: i64 = 5 * 60;
/// 同一条线路两次通知之间的最小间隔。告警疲劳是这次事故没人看的真正成因。
const ALARM_COOLDOWN_SECS: i64 = 6 * 3600;

/// 收件人只认**看起来像邮箱**的那些。
///
/// `users.email` 这一列并不保证是邮箱：线上实测有一个 admin 的值是 `fendoushaonian`
/// —— 一个用户名，14 个字符、连 @ 都没有。原来不筛就直接发，结果每一轮巡检都往
/// 邮件服务打一次必然失败的请求，日志里稳定刷 `email is not valid in to`，
/// 真正的发送失败反而被埋在这堆噪声里。
fn looks_like_email(s: &str) -> bool {
    let s = s.trim();
    let Some((user, domain)) = s.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && s.len() <= 254
        && !s.contains(char::is_whitespace)
        && s.matches('@').count() == 1
}

async fn alarm_recipients(state: &AppState) -> Vec<String> {
    let all = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE role = 'admin'")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let (good, bad): (Vec<_>, Vec<_>) = all.into_iter().partition(|e| looks_like_email(e));
    if !bad.is_empty() {
        // 不打印地址本身，只报数量：这行会进日志，而管理员的联系方式不该躺在那里。
        tracing::warn!(
            skipped = bad.len(),
            usable = good.len(),
            "有 admin 账号的 email 字段不是邮箱地址，已跳过（那是用户名，不是收件人）"
        );
    }
    good
}

/// 给管理员发一封。别的模块要发告警时走这里，**不要**去改 `notify` 的签名 ——
/// 下面有一条源码断言逐字钉着那一行（它守的是「告警必须真发出去才算发过」）。
pub(crate) async fn notify_admins(state: &AppState, subject: &str, body: &str) -> bool {
    notify(state, subject, body).await
}

// ---------------------------------------------------------------------------------------
// 管理员通知：攒一个窗口，合并成一封（2026-09-07）
//
// 三个来源（线路告警 / 恢复、出口缺货、进价亏本）都经 `notify` 这一个口。此前每一条都当场
// 单独发给每个管理员：线路和多路由一抖，十来条线路的告警在同一分钟里各发一封、五个管理员
// 各收一份 —— 所有者原话「明明不能用的却同一时间发了许多重复的，给了不同管理员」。
//
// 现在 `notify` 只往 Redis 队列里放；后台每 ALARM_BATCH_WINDOW_SECS（默认 5 分钟）把队列里攒到
// 的全部合并成**一封**发出去，同一主题只留最新一条。状态在 Redis：蓝绿两个进程共用同一个
// 队列，发版不丢，也不会两边各发一份（发送权用 SET NX 抢）。
// 同一条线路 6 小时内最多一对「告警 / 恢复」，见 evaluate_alarm 里恢复分支的说明。
// ---------------------------------------------------------------------------------------

fn alarm_key(field: &str) -> String {
    format!("rh:alarm:{field}")
}

/// 一条待发的管理员通知。排队时以 JSON 存进 Redis 列表。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct AlarmItem {
    at: i64,
    subject: String,
    body: String,
}

/// 把几条通知并成一封：同主题只留最新的一条，按时间排序。一条就原样。
fn digest(mut items: Vec<AlarmItem>) -> (String, String) {
    items.sort_by_key(|i| i.at);
    let mut latest: Vec<AlarmItem> = Vec::new();
    for it in items {
        if let Some(pos) = latest.iter().position(|x| x.subject == it.subject) {
            latest.remove(pos);
        }
        latest.push(it);
    }
    if latest.len() == 1 {
        let only = latest.remove(0);
        return (only.subject, only.body);
    }
    let n = latest.len();
    let first = latest.first().map(|i| i.subject.clone()).unwrap_or_default();
    let mut body = format!("以下 {n} 条通知在同一个窗口内先后触发，合并成一封（时间为 UTC）：\n");
    for it in &latest {
        let when = chrono::DateTime::from_timestamp(it.at, 0)
            .map(|t| t.format("%m-%d %H:%M").to_string())
            .unwrap_or_else(|| it.at.to_string());
        body.push_str(&format!("\n── {when}  {}\n{}\n", it.subject, it.body));
    }
    (format!("[汇总] {n} 条管理员通知：{first} 等"), body)
}

async fn queue_push(state: &AppState, items: &[AlarmItem]) {
    let mut conn = state.redis.clone();
    for it in items {
        if let Ok(js) = serde_json::to_string(it) {
            let _: Result<(), _> = redis::cmd("RPUSH").arg(alarm_key("queue")).arg(js).query_async(&mut conn).await;
        }
    }
    let _: Result<(), _> = redis::cmd("EXPIRE").arg(alarm_key("queue")).arg(2 * 86_400).query_async(&mut conn).await;
}

async fn queue_drain(state: &AppState) -> Vec<AlarmItem> {
    let mut conn = state.redis.clone();
    let raw: Vec<String> = redis::cmd("LRANGE").arg(alarm_key("queue")).arg(0).arg(-1).query_async(&mut conn).await.unwrap_or_default();
    if raw.is_empty() {
        return Vec::new();
    }
    let _: Result<(), _> = redis::cmd("DEL").arg(alarm_key("queue")).query_async(&mut conn).await;
    raw.iter().filter_map(|s| serde_json::from_str(s).ok()).collect()
}

/// 真把一封（通常是汇总）发给全部收件人，每一封都进 email_logs（来源 alarm）。
/// 返回是否至少发出去一封。
async fn deliver(state: &AppState, to: &[String], subject: &str, body: &str) -> bool {
    let mut any_ok = false;
    for addr in to {
        match crate::email::send_mail(&state.cfg, addr, subject, body, false).await {
            Ok(()) => {
                any_ok = true;
                crate::email::log_send(state, addr, subject, "sent", None, "alarm").await;
            }
            // 发不出去也要留痕：静默失败等于没有告警，而这正是要修的东西。
            Err(err) => {
                tracing::error!(reason = %err.msg, subject, "线路告警发送失败");
                crate::email::log_send(state, addr, subject, "failed", Some(err.msg.as_str()), "alarm").await;
            }
        }
    }
    any_ok
}

/// 发送权：蓝绿重叠那几十秒里两个进程只有一个抢得到，队列不会被发两遍。
async fn claim_send(state: &AppState) -> bool {
    let mut conn = state.redis.clone();
    let got: Option<String> = redis::cmd("SET").arg(alarm_key("lock")).arg(1).arg("NX").arg("EX").arg(60).query_async(&mut conn).await.unwrap_or(None);
    got.is_some()
}

async fn release_send(state: &AppState) {
    let mut conn = state.redis.clone();
    let _: Result<(), _> = redis::cmd("DEL").arg(alarm_key("lock")).query_async(&mut conn).await;
}

/// 每个窗口一次：队列里有东西就合并成一封发出去。
async fn flush_alarm_queue(state: &AppState) {
    if !state.cfg.mail_enabled() || !claim_send(state).await {
        return;
    }
    let items = queue_drain(state).await;
    if !items.is_empty() {
        let to = alarm_recipients(state).await;
        if to.is_empty() {
            tracing::error!(queued = items.len(), "管理员通知无处可发：没有 email 字段是有效邮箱的 admin 账号");
        }
        let (subject, body) = digest(items.clone());
        // 一封都没发出去 → 塞回队列，下一个窗口再试，别丢。
        if to.is_empty() || !deliver(state, &to, &subject, &body).await {
            queue_push(state, &items).await;
        }
    }
    release_send(state).await;
}

/// 收下一条通知：只进队列，由后台按窗口合并成一封发。返回「已收下」——
/// 调用方靠它决定要不要保留冷却；邮件未配置 / 没收件人时回 false，让调用方下一轮再试。
async fn notify(state: &AppState, subject: &str, body: &str) -> bool {
    if !state.cfg.mail_enabled() {
        tracing::error!(subject, "线路告警无法发出：邮件未配置（EMAIL_WORKER_* / BREVO_API_KEY+MAIL_FROM 都为空）");
        return false;
    }
    if alarm_recipients(state).await.is_empty() {
        tracing::error!(subject, "线路告警无处可发：没有 email 字段是有效邮箱的 admin 账号");
        return false;
    }
    let item = AlarmItem { at: now_secs(), subject: subject.to_string(), body: body.to_string() };
    queue_push(state, std::slice::from_ref(&item)).await;
    tracing::info!(subject, "管理员通知已收进队列，窗口一到与同批通知合并成一封发出");
    true
}

/// `POST /api/admin/route-health/test-alarm` —— 往真实收件人发一封测试告警。
///
/// # 为什么需要这个按钮
///
/// 「地址在收件人列表里」和「这封信真能到」是两件事。QQ 邮箱对陌生发件域尤其严 ——
/// 可能静默丢掉，也可能进垃圾箱，而两种在服务端看都是「已发送」。线路真挂掉那天
/// 才发现收不到，就晚了。
///
/// 所以这里发一封真的：走和真告警**完全同一条路**（同一个收件人清单、同一个发信通道），
/// 只是内容写明是测试。它逐个报告每个地址成没成功，失败原因原样带出来。
pub async fn test_alarm(
    axum::extract::State(state): axum::extract::State<AppState>,
    claims: crate::auth::Claims,
) -> crate::error::ApiResult<axum::Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(crate::error::AppError::forbidden("需要管理员权限"));
    }
    if !state.cfg.mail_enabled() {
        return Err(crate::error::AppError::bad(
            "邮件没配置（brevo_api_key / mail_from 为空），任何告警都发不出去",
        ));
    }
    let all = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE role = 'admin'")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let (good, bad): (Vec<_>, Vec<_>) = all.into_iter().partition(|e| looks_like_email(e));
    if good.is_empty() {
        return Err(crate::error::AppError::bad(
            "没有一个 admin 账号的 email 字段是邮箱地址 —— 线路挂了不会有任何人收到通知",
        ));
    }

    let mut results = Vec::new();
    for addr in &good {
        let r = crate::email::send_mail(
            &state.cfg,
            addr,
            "[测试] Mr. Day One 线路告警自检",
            "这是一封测试信，用来确认线路告警发得到你这儿。\n\n             收到了就说明真出问题时你也会收到。没收到的话先翻垃圾箱；\n             还是没有的话，是发件域在这家邮箱那边没过，得去配 SPF/DKIM。",
            false,
        )
        .await;
        results.push(serde_json::json!({
            "to": addr,
            "ok": r.is_ok(),
            "error": r.err().map(|e| e.msg),
        }));
    }
    Ok(axum::Json(serde_json::json!({
        "sent": results,
        // 填了用户名而不是邮箱的那些：它们永远收不到，得让人看见。
        "skipped": bad.len(),
    })))
}

/// 判定一条线路要不要发告警 / 恢复通知。状态存 Redis，不存进程内存。/// 判定一条线路要不要发告警 / 恢复通知。状态存 Redis，不存进程内存。
///
/// 进程内存在这里是错的：发一次版就清零，而蓝绿切换时新旧两版还会各记各的 ——
/// 一次部署就能把「已经坏了 30 分钟」重置成「刚刚开始坏」，告警永远攒不满。
async fn evaluate_alarm(state: &AppState, route_id: Uuid, label: &str, word: &str, h: &RouteHealth) {
    let mut conn = state.redis.clone();
    let since_key = key(route_id, "alarm_since");
    let now = now_secs();

    if word != "error" {
        // 恢复了：只有真发过通知才补一封「恢复」，否则一次短暂抖动会产生一封莫名其妙的邮件。
        let had: Option<i64> = redis::cmd("GET").arg(&since_key).query_async(&mut conn).await.unwrap_or(None);
        if had.is_some() {
            let sent: Option<i64> = redis::cmd("GET")
                .arg(key(route_id, "alarm_sent"))
                .query_async(&mut conn)
                .await
                .unwrap_or(None);
            // 只清「坏了多久」的起点，**不清发送权**：alarm_sent 的 TTL 就是这条线路的再告警冷却。
            // 原来恢复时把它一起删了，于是一条抖动的线路每二十分钟就能来一对「告警 / 恢复」，
            // 一天上百封。现在同一条线路 6 小时内最多一封告警 + 一封恢复，抖动期间的反复只进日志。
            let _: Result<(), _> = redis::cmd("DEL").arg(&since_key).query_async(&mut conn).await;
            if sent.is_some() {
                let first_recovery: Option<String> = redis::cmd("SET")
                    .arg(key(route_id, "alarm_recovered"))
                    .arg(now)
                    .arg("NX")
                    .arg("EX")
                    .arg(ALARM_COOLDOWN_SECS)
                    .query_async(&mut conn)
                    .await
                    .unwrap_or(None);
                if first_recovery.is_some() {
                    let _ = notify(
                        state,
                        &format!("[恢复] 线路「{label}」又能用了"),
                        &format!("线路：{label}\n当前判定：{word}\n连败计数已清零。"),
                    )
                    .await;
                } else {
                    tracing::info!(route = label, "线路恢复通知在冷却期内已发过一次，这次只记日志");
                }
            }
        }
        return;
    }

    // 第一次判坏：记下起点，先不发 —— 给抖动留 ALARM_AFTER_SECS 的自愈时间。
    // NX 让「起点」只被写一次：后续每一轮都读回同一个值，所以「已经坏了多久」是连续的，
    // 不会被每轮刷新重置成 0（那样告警永远攒不满 5 分钟，一封都发不出去）。
    let claimed_start: Option<String> = redis::cmd("SET")
        .arg(&since_key)
        .arg(now)
        .arg("NX")
        .arg("EX")
        .arg(KEY_TTL_SECS)
        .query_async(&mut conn)
        .await
        .unwrap_or(None);
    let started = if claimed_start.is_some() {
        now
    } else {
        redis::cmd("GET")
            .arg(&since_key)
            .query_async(&mut conn)
            .await
            .unwrap_or(None)
            .unwrap_or(now)
    };
    if now.saturating_sub(started) < ALARM_AFTER_SECS {
        return;
    }

    // 抢占发送权。SET NX 是原子的，蓝绿重叠那几十秒里两个进程只有一个抢得到，
    // 所以不会两边各发一封；冷却期同时由这把锁的 TTL 表达。
    let claimed: Option<String> = redis::cmd("SET")
        .arg(key(route_id, "alarm_sent"))
        .arg(now)
        .arg("NX")
        .arg("EX")
        .arg(ALARM_COOLDOWN_SECS)
        .query_async(&mut conn)
        .await
        .unwrap_or(None);
    if claimed.is_none() {
        return;
    }

    let last_ok = h
        .last_ok_at
        .map(|t| format!("{:.1} 小时前", (now - t) as f64 / 3600.0))
        .unwrap_or_else(|| "有记录以来从未成功".into());
    let delivered = notify(
        state,
        &format!("[告警] 线路「{label}」判定为不可用"),
        &format!(
            "线路：{label}\n\
             判定：error（连续 {} 次非成功）\n\
             上次成功：{last_ok}\n\
             上次失败状态码：{}\n\
             已持续：{} 分钟\n\n\
             判据是真实流量的结局（连败次数 + 上次成功时刻），不是探针 —— 探针只测上游前门，\n\
             十条线路共用同一个域名，它测不出这条线路能不能用。",
            h.consecutive_failures,
            h.last_fail_status.map(|s| s.to_string()).unwrap_or_else(|| "—".into()),
            (now - started) / 60,
        ),
    )
    .await;

    // 一封都没发出去 → **把发送权还回去**，让下一轮再试。
    //
    // 原来是「先抢占再发」，发失败了冷却照样挂满 6 小时 —— 于是一次投递故障就能让这条
    // 线路静音一整个冷却期，而运维那边什么都收不到。那正是这套东西要修的形态
    //（「看起来有告警、其实一封都发不出」），不能在告警自己身上再造一遍。
    if !delivered {
        let _: Result<(), _> = redis::cmd("DEL")
            .arg(key(route_id, "alarm_sent"))
            .query_async(&mut conn)
            .await;
        tracing::error!(route = label, "线路告警一封都没送达，已释放冷却，下一轮重试");
    }
}

/// 后台任务：给没有证据的线路补一次真实探测，然后评估告警。
///
/// **单独一个任务，不挂在 health.rs 的探针 tick 上。** 那个循环是串行的、每条线路
/// 10 秒超时，一轮最坏 100 秒；把探测和告警叠上去会让两件事互相拖延，而告警恰恰是
/// 最不能被拖的那个。
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 起步先让服务把自己启动完，也避开部署瞬间那段必然「没有证据」的窗口。
        tokio::time::sleep(Duration::from_secs(90)).await;

        if state.cfg.mail_enabled() && alarm_recipients(&state).await.is_empty() {
            tracing::error!(
                "线路告警没有收件人：邮件已配置但没有 role='admin' 的用户。\
                 现在的状态是「看起来有告警，实际一封都发不出去」——比没有告警更危险。"
            );
        }

        // 队列里的通知由这个小循环按窗口合并成一封发出去（notify 只往队列里放）。
        {
            let flusher = state.clone();
            let window = state.cfg.alarm_batch_window_secs.max(10) as u64;
            tokio::spawn(async move {
                let mut t = tokio::time::interval(Duration::from_secs(window));
                t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    t.tick().await;
                    flush_alarm_queue(&flusher).await;
                }
            });
        }

        let mut tick = tokio::time::interval(CANARY_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let routes = match sqlx::query_as::<_, crate::models::Model>(
                "SELECT * FROM models WHERE active = true ORDER BY sort, created_at",
            )
            .fetch_all(&state.db)
            .await
            {
                Ok(r) => r,
                Err(err) => {
                    tracing::warn!(%err, "线路健康巡检：读线路失败，这一轮跳过");
                    continue;
                }
            };

            let mut probed = 0usize;
            for m in &routes {
                let h = snapshot(&state, m.id).await;
                let now = now_secs();
                // 窗口按这条线路自己的探活报价定：贵的探得稀，便宜的和以前一样。
                let window = canary_fresh_window_secs(m.id, classify(&h, now));
                let fresh = h
                    .last_attempt_at
                    .is_some_and(|t| now.saturating_sub(t) < window);

                // 有新鲜的真实流量就不探 —— 那是免费且更真实的证据。
                if !fresh && canary_enabled() && probed < CANARY_MAX_PER_ROUND {
                    probed += 1;
                    match canary_once(m).await {
                        Some((ok, status, tokens, model_id)) => {
                            if ok {
                                record_ok(&state, m.id).await;
                            } else {
                                record_fail(&state, m.id, status).await;
                            }
                            // 这一发请求的钱已经花了 —— 记下来，否则它只会以
                            // 「余额对不上」的形式出现在对账页，看起来像别处出了问题。
                            // 失败的探活也照记：请求发出去了，上游多半也计了费。
                            note_probe_usage(&state, m.id, &model_id, tokens);
                            tracing::info!(route = %m.label, ok, status,
                                probe_prompt = tokens.prompt, probe_completion = tokens.completion,
                                "线路探活（最小真实请求）");
                            // 探活的结果不用在这儿回读：下面的 best_word 会重新取一次
                            // 快照（它还要同时看这条线路挂的多路由出口）。
                        }
                        // 无从探起（这条线路一个模型都没开）——什么都不记。
                        // 记成功就是伪造证据，记失败就是诬告一条没被用到的线路。
                        None => tracing::warn!(
                            route = %m.label,
                            "线路探活跳过：这条线路没有任何可用模型 id，本轮不产生证据"
                        ),
                    }
                }

                // 告警看的是「这条线路还能不能服务」，所以要把它挂的多路由出口一起算进来。
                //
                // 健康是按出口记的（一个坏出口不该拖垮同线路的好出口），而流量大多走最便宜
                // 那个出口 —— 只看线路自带地址的记录，出口连败就永远进不了告警。那正是这次
                // 事故的形状：面板全绿、监控一次没响、44 小时。
                //
                // 取所有出口里**最好**的结论：还有一个能服务就不该报警，全坏了才是真坏了。
                let (word, which, h) =
                    crate::route_endpoints::best_word(&state, m.id, now_secs()).await;
                // 指名道姓：收到「线路 X 坏了」却发现直连是好的，下一次就没人看告警了。
                let label = match which {
                    Some(ep) => format!("{}（出口 {})", m.label, &ep.to_string()[..8]),
                    None => m.label.clone(),
                };
                evaluate_alarm(&state, m.id, &label, word, &h).await;
            }
        }
    });
}

#[cfg(test)]
mod real_outcome_tests {
    /// 一个下线的型号不该判死整个出口。
    ///
    /// 线上实测：`Claude` 线路的启用列表第一个是 `claude-fable-5`（8/30 之后再没被
    /// 用过的旧型号），polly 这个出口不提供它 → 400 → 整个出口被探成死的。而它 14 天里
    /// 真实跑了 1171 次成功，是 Claude 上量最大的出口之一。而且这个错是自我强化的：
    /// 真实流量的保质期只有 2 小时，一过就改按探测结论排序，出口掉到最差档、更拿不到
    /// 流量、更没有新鲜记录。
    #[test]
    fn a_retired_model_must_not_condemn_the_whole_outlet() {
        // 只否定这一个模型的：换下一个接着探。
        assert!(super::rejects_only_this_model(400), "400 多半就是「不认识这个模型名」");
        assert!(super::rejects_only_this_model(404), "404 就是「找不到这个模型」");
        // 否定整个出口的：不用再换模型了，换了也一样。
        for s in [200_u16, 401, 403, 429, 500, 502, 503, 504] {
            assert!(
                !super::rejects_only_this_model(s),
                "{s} 被当成了「只是这个模型不在」—— 会白白多发几次探测"
            );
        }
    }

    /// 「什么时候换下一个模型、什么时候收手」—— 真跑，不扫源码。
    ///
    /// 这条最初写成源码断言（查循环里有没有 `for ... ids.iter()`），**变异测试当场
    /// 证明它是恒真的**：把循环改成 `.take(1)`（也就是退回老行为）之后断言照样绿。
    /// 这是这个仓库反复栽的那一类，判据一律改成能在进程里跑一遍的。
    #[tokio::test]
    async fn the_probe_walks_past_models_the_outlet_does_not_serve() {
        let ids: Vec<String> = ["retired", "current", "third"].iter().map(|s| s.to_string()).collect();
        // 记录实际探了哪几个，用来证明短路真的短路了。
        async fn run(
            ids: &[String],
            plan: Vec<(bool, u16)>,
        ) -> (Option<(bool, u16)>, Vec<String>) {
            let seen = std::cell::RefCell::new(Vec::<String>::new());
            let out = super::probe_until_decisive(
                ids,
                |id| {
                    seen.borrow_mut().push(id.clone());
                    let i = seen.borrow().len() - 1;
                    let hit = plan[i];
                    async move { Some(hit) }
                },
                |r: &(bool, u16)| r.1,
            )
            .await;
            (out, seen.into_inner())
        }

        // ① 第一个模型 400（下线的型号）→ 换下一个，第二个通了就收手。
        let (out, seen) = run(&ids, vec![(false, 400), (true, 200), (false, 500)]).await;
        assert_eq!(out, Some((true, 200)), "第一个模型 400 就把整个出口判死了");
        assert_eq!(seen, vec!["retired", "current"], "探通之后还在继续发探测（白烧钱）");

        // ② 密钥被拒和模型无关 —— 立刻收手，别拿同一把坏钥匙再试三次。
        let (out, seen) = run(&ids, vec![(false, 401), (true, 200), (true, 200)]).await;
        assert_eq!(out, Some((false, 401)));
        assert_eq!(seen, vec!["retired"], "401 之后还在换模型重试");

        // ③ 每一个都说「没有这个模型」→ 这个出口确实不可用，采信最后一个。
        let (out, seen) = run(&ids, vec![(false, 400), (false, 404), (false, 400)]).await;
        assert_eq!(out, Some((false, 400)));
        assert_eq!(seen.len(), 3, "没有把允许的模型走完就下结论");
    }

    /// 真实结果必须**成功和失败都记**，否则成功率的分母永远缺一块。
    ///
    /// 在这之前：成功那一半有（model_usage 每次扣费写一行），失败只进 Redis 的一个
    /// 按线路连败计数 —— 没有模型维度、没有历史、30 天 TTL。于是「这条线路好不好」
    /// 只能问 model_health，而它探的是**不带凭据的 GET**：密钥过期、额度用尽、模型下架
    /// 一律报绿。实测「Claude 强力版」前门可达 99.93%，真实成功在 43 小时前。
    #[test]
    fn every_attempt_lands_in_the_table_win_or_lose() {
        let src = include_str!("models.rs");
        let at = src.find("\n        'routes: for candidate in ordered_candidates").expect("换线循环没了");
        // 终点必须是**真的存在**的锚点。上一版写的是 `\n    let (mut resp`，
        // 而 models.rs 里根本没有那一行 —— 于是切片一路切到文件尾，
        // 只是碰巧后面没有别的记录点，这条测试才一直是绿的。
        // 换成循环后面紧跟的那个 match，并且**找不到就当场失败**，不再默默滑到文件尾。
        let end = src[at + 1..]
            .find("\n        match (success, selected_conn) {")
            .map(|i| at + 1 + i)
            .expect("换线循环的结尾锚点不见了 —— 切片会一路滑到文件尾，这条测试就废了");
        let body: String = src[at..end]
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
            })
            .collect::<Vec<_>>()
            .join("\n");

        // 一个成功点 + 三个失败点，四处都得记。少一处，成功率就偏。
        // 用**这一处特有的形状**去数，不要数裸的 "false," —— 那一大段里到处都是它，
        // 第一版就是这么把 3 数成 8 的。
        let fails = body.matches("&model_id, false,").count();
        assert_eq!(
            body.matches("spawn_attempt(").count(),
            4,
            "尝试结果的记录点不是 4 个了 —— 成功 1 处、失败 3 处，少一处成功率就算偏",
        );
        assert_eq!(fails, 3, "失败那三处不是都记成 false 了");
        assert!(
            body.contains("Some(send_started.elapsed().as_millis() as u64)"),
            "成功时没记耗时 —— 那「哪条快」就还是没有数据",
        );

        // 失败不许带耗时：那是「等超时等了多久」，混进平均会让一条一次都没成的线路
        // 看起来「只是慢」。
        // 只看**生产代码**那一段：下面两条断言的字面量就写在本文件的测试模块里，
        // 不切掉的话把真正的代码改坏它照样绿（变异测试第五次抓到同一个形状）。
        let whole = include_str!("route_health.rs");
        let me = whole
            .split_once("\n#[cfg(test)]")
            .map(|(head, _)| head)
            .expect("route_health.rs 里应该有测试模块");
        assert!(
            me.contains("(true, Some(ms)) => (ms.min(600_000) as i64, 1i64)"),
            "耗时不再是只在成功时累加",
        );
        // 写入不许挡住派单。**断言要切到 spawn_attempt 自己的函数体里** ——
        // 隔壁 spawn_ok 里有一模一样的 `tokio::spawn(async move {`，
        // 只在全文件里找的话，把这一处改成同步照样绿（变异测试抓到的）。
        let f = me
            .split_once("pub fn spawn_attempt(")
            .map(|(_, rest)| rest)
            .expect("spawn_attempt 改名了");
        let f = &f[..f.find("\n}").unwrap_or(f.len())];
        assert!(
            f.contains("tokio::spawn(async move {"),
            "落库写成同步的了 —— 观测绝不能让用户多等",
        );
        assert!(
            !f.contains("await;\n    let"),
            "派单路径上多了 await",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    /// 这一组的验收标准就是那次真实事故：强力版 44 小时零成功、34 次尝试。
    #[test]
    fn the_incident_route_is_called_broken() {
        // 34 次尝试、一次都没成功过 —— 无论连败阈值定多少都必须判坏。
        let never_worked = RouteHealth {
            consecutive_failures: 34,
            last_ok_at: None,
            last_attempt_at: Some(NOW - 60),
            last_fail_status: Some(504),
        };
        assert_eq!(classify(&never_worked, NOW), "error");

        // 更早的形态：它曾经好过（44 小时前），之后一路失败。
        let died_after_working = RouteHealth {
            consecutive_failures: 34,
            last_ok_at: Some(NOW - 44 * 3600),
            last_attempt_at: Some(NOW - 60),
            last_fail_status: Some(504),
        };
        assert_eq!(classify(&died_after_working, NOW), "error");

        // 关键：第 5 次就要报，不能等到攒够统计样本。
        let just_broke = RouteHealth {
            consecutive_failures: FAILING_STREAK,
            last_ok_at: Some(NOW - 120),
            last_attempt_at: Some(NOW - 5),
            last_fail_status: Some(502),
        };
        assert_eq!(
            classify(&just_broke, NOW),
            "error",
            "连败达标就该报，哪怕两分钟前还成功过 —— 这正是低流量下唯一有界的判据",
        );
    }

    /// **没有证据不许报绿。** 这是整套东西存在的理由：探针的病就是拿「敲得通前门」
    /// 冒充「模型能用」。
    #[test]
    fn absence_of_evidence_is_never_green() {
        assert_eq!(classify(&RouteHealth::default(), NOW), "unknown", "从没被碰过 ≠ 健康");

        // 曾经成功，但已经很久没有新证据了 —— 只是没人用，不能继续挂绿灯。
        let stale = RouteHealth {
            consecutive_failures: 0,
            last_ok_at: Some(NOW - OK_FRESH_SECS - 1),
            last_attempt_at: Some(NOW - OK_FRESH_SECS - 1),
            last_fail_status: None,
        };
        assert_eq!(classify(&stale, NOW), "unknown");
    }

    /// 判定顺序：先判坏、再判好。反过来的话小样本全失败会被中性结论吞掉。
    #[test]
    fn bad_news_is_evaluated_before_good_news() {
        // 刚成功过，但紧接着连败达标 → 仍然是坏。
        let fresh_ok_then_broke = RouteHealth {
            consecutive_failures: FAILING_STREAK + 3,
            last_ok_at: Some(NOW - 1),
            last_attempt_at: Some(NOW),
            last_fail_status: Some(503),
        };
        assert_eq!(classify(&fresh_ok_then_broke, NOW), "error");

        // 少量失败 + 新鲜成功 → 降级，不是绿。
        let flaky = RouteHealth {
            consecutive_failures: 1,
            last_ok_at: Some(NOW - 30),
            last_attempt_at: Some(NOW),
            last_fail_status: Some(502),
        };
        assert_eq!(classify(&flaky, NOW), "degraded");

        // 干净且新鲜 → 绿。这是唯一一条通往绿灯的路。
        let healthy = RouteHealth {
            consecutive_failures: 0,
            last_ok_at: Some(NOW - 30),
            last_attempt_at: Some(NOW - 30),
            last_fail_status: None,
        };
        assert_eq!(classify(&healthy, NOW), "ok");
    }

    /// 状态词必须落在 health.rs 前端已经认识的那四个里 —— 多一个就是一颗空药丸。
    #[test]
    fn only_the_four_words_the_frontend_knows() {
        let allowed = ["ok", "degraded", "error", "unknown"];
        let cases = [
            RouteHealth::default(),
            RouteHealth { consecutive_failures: 99, last_ok_at: None, last_attempt_at: Some(NOW), last_fail_status: Some(500) },
            RouteHealth { consecutive_failures: 0, last_ok_at: Some(NOW), last_attempt_at: Some(NOW), last_fail_status: None },
            RouteHealth { consecutive_failures: 2, last_ok_at: Some(NOW - 99_999), last_attempt_at: Some(NOW), last_fail_status: Some(429) },
            RouteHealth { consecutive_failures: 1, last_ok_at: Some(NOW - 10), last_attempt_at: Some(NOW), last_fail_status: Some(502) },
        ];
        for c in cases {
            let w = classify(&c, NOW);
            assert!(allowed.contains(&w), "冒出了前端不认识的状态词：{w}");
        }
    }

    /// 金丝雀**必须按线路协议分支**。
    ///
    /// 照 model_probe.rs 那样只发 OpenAI 形状的话，所有 anthropic 线路（Claude 一族、
    /// 免费智普、Kimi）都会探测失败 —— 而假红比假绿更糟：它把好线路报成坏的，
    /// 运维几次之后就把告警静音，下一次真事故照样没人看。
    #[test]
    fn the_canary_speaks_both_protocols() {
        // 锚点是 `canary_once_with` 而不是 `canary_once`：协议分支住在前者里，
        // 后者只是「逐个模型探到有结论为止」的分派。按 `canary_once` 切会切到分派那段，
        // 于是下面每一条都找不到，断言变成恒红（改完这次分拆时当场撞到）。
        let src = include_str!("route_health.rs");
        let body = src
            .split("async fn canary_once_with(")
            .nth(1)
            .and_then(|s| s.split("\n}").next())
            .expect("canary_once_with 不见了");
        assert!(body.contains("anthropic"), "没有按协议分支");
        assert!(body.contains("x-api-key") && body.contains("anthropic-version"),
            "anthropic 分支缺鉴权头，那条路上的线路会被全部误判成坏的");
        assert!(
            body.contains("/messages")
                && body.contains("/chat/completions")
                && body.contains("/responses"),
            "三种协议的端点必须各走各的 —— 少一条就是「拿另一套请求体去探，探绿了却根本不通」",
        );
        assert!(
            body.contains("max_output_tokens") && body.contains("\"input\""),
            "Responses 的最小请求体是另一套名字（input / max_output_tokens），照抄 chat 那套探不出真相",
        );
        // 最小请求：只问「接不接得通」，不让它真去生成。
        assert!(body.contains("\"max_tokens\": 1"), "探测请求不是最小的，会白烧 token");
    }



    /// 花钱的东西必须能关，而且默认不该在忙碌线路上花。
    #[test]
    fn the_canary_is_cheap_by_construction() {
        assert!(
            CANARY_SKIP_IF_FRESH_SECS > 0,
            "没有「有新鲜证据就跳过」的话，忙碌线路也会被白探一遍",
        );
        assert!(CANARY_MAX_PER_ROUND <= 8, "一轮探太多，线路变多时会一次烧穿");
        assert!(
            CANARY_TIMEOUT < Duration::from_secs(60),
            "探活只问接不接得通，不该等模型思考",
        );
        // 开关存在，且默认开（用户要的是覆盖零流量线路）。
        let src = include_str!("route_health.rs");
        assert!(src.contains("ROUTE_CANARY"), "没有关掉它的开关，而它花的是真钱");
    }

    /// 告警的两个时间常数必须站得住：够久到不被抖动触发，够短到还有意义。
    #[test]
    fn alarm_timing_is_neither_jumpy_nor_useless() {
        assert!(
            ALARM_AFTER_SECS >= 60,
            "太短的话一次部署空窗就会发一封，几次之后告警就被静音——那正是这次事故没人看的成因",
        );
        assert!(
            ALARM_AFTER_SECS <= 30 * 60,
            "太长的话它救不了这次事故（44 小时里前半小时就该有人知道）",
        );
        assert!(
            ALARM_COOLDOWN_SECS > ALARM_AFTER_SECS,
            "冷却必须长于判定时长，否则同一次故障会连着发",
        );
        // 巡检间隔要能在判定时长内至少跑到两轮，否则「持续 5 分钟」这句话没有测量精度。
        assert!(
            CANARY_EVERY.as_secs() as i64 <= ALARM_AFTER_SECS * 3,
            "巡检太稀疏，「已经坏了多久」量不准",
        );
    }

    /// 「坏了多久」的起点必须只写一次。
    ///
    /// 每轮都刷新起点的话，`now - started` 永远接近 0，5 分钟的门槛**永远攒不满**，
    /// 一封都发不出去 —— 而那正是这次事故的形态，不能用另一种方式复制。
    #[test]
    fn the_alarm_clock_is_not_reset_every_round() {
        let src = include_str!("route_health.rs");
        let body = src
            .split("async fn evaluate_alarm")
            .nth(1)
            .expect("evaluate_alarm 不见了");
        let head = &body[..body.find("fn ").unwrap_or(body.len().min(4000))];
        assert!(
            head.contains("alarm_since"),
            "起点没有落到持久存储上；存进程内存的话，发一次版就清零、蓝绿两版还各记各的",
        );
        assert!(head.contains("\"NX\""), "起点不是用 NX 写的，会被每轮刷新重置");
    }

    /// 「没东西可探」绝不能被记成一次成功。
    ///
    /// 第一版在这里返回 `(true, 0)`，调用方看到 ok=true 就 record_ok —— 凭空造一次成功、
    /// 把连败清零、点亮绿灯。而 `enabled_models` 为空的线路**照样在接真实流量**
    /// （派单的 allowed_ids 会回落到 model_id），所以它可以是真坏的。
    /// 这正是这套监控要消灭的东西（没有证据不许报绿），当时在它自己身上重演了一遍。
    #[test]
    fn nothing_to_probe_must_not_be_recorded_as_success() {
        let src = include_str!("route_health.rs");
        let body = src
            .split("async fn canary_once")
            .nth(1)
            .and_then(|s| s.split("\n// ").next())
            .expect("canary_once 不见了");

        // 钉住**承载语义的那部分**，不钉元组的完整形状。
        //
        // 这里原本写死 `-> Option<(bool, u16)>`。后来为了把探活烧掉的 token 记进账，
        // 返回值多带了两个字段 —— 语义一个字没变（还是 Option，None 仍然表示
        // 「这一次没有证据」），但断言当场红了。
        //
        // 逐字钉签名的守卫会把「加了一个字段」和「把 Option 拆了」判成同一件事，
        // 而它们一个是无害的、一个是这条守卫真正要防的。所以只钉两件：
        // 是 Option（能表达无证据），前两位仍是 (成功与否, 状态码)。
        assert!(
            body.contains("-> Option<(bool, u16"),
            "返回类型必须是 Option 且前两位是 (ok, status) —— \
             不是 Option 的话，调用方只能在成功和失败里二选一，「无从探起」就没地方放了",
        );
        assert!(
            !body.contains("return (true,"),
            "又把「无从探起」当成功返回了——那是伪造证据",
        );
        // 探的模型必须和派单口径一致，否则会漏掉 enabled_models 为空、但正在接流量的线路。
        assert!(
            body.contains("allowed_ids"),
            "探测用的模型 id 和派单不是同一个口径",
        );

        // 调用方必须对 None 什么都不记。
        let loop_src = src
            .split("pub fn spawn(")
            .nth(1)
            .expect("spawn 不见了");
        assert!(
            loop_src.contains("None =>") && !loop_src.contains("None => record_ok"),
            "调用方没有为「没有证据」留一条什么都不做的分支",
        );
    }

    /// 卡死线路的恢复判定由后台探针接管，用户的真实请求不再当探针。
    ///
    /// 节奏必须钉住：探测间隔短于记号有效期，否则记号在两次探测之间过期、线路回到排头、
    /// 下一个用户又去撞满 57 秒 —— 正是这条要消灭的形态。
    #[test]
    fn stall_recovery_probes_faster_than_the_mark_expires() {
        assert!(
            STALL_RECOVERY_EVERY * 2 <= crate::models::CHAT_UPSTREAM_STALL_MEMORY,
            "探测间隔 {STALL_RECOVERY_EVERY:?} 太稀疏，记号会在两次探测之间过期",
        );
        assert!(STALL_RECOVERY_EVERY >= Duration::from_secs(10), "探得太密，停机期间白烧钱");
        assert!(
            CANARY_TIMEOUT <= STALL_RECOVERY_EVERY,
            "单次探测耐心超过间隔，探针会自己叠自己",
        );
        assert!(STALL_RECOVERY_MAX_CONCURRENT >= 1 && STALL_RECOVERY_MAX_CONCURRENT <= 8);
    }

    /// 同一条线路只许一个任务，总数有上限，名额用完能还。
    #[test]
    fn stall_recovery_admission_is_bounded() {
        // 别的测试也可能占着名额：先把这组用到的 id 清干净，结束时再还回去。
        let ids: Vec<Uuid> = (0..STALL_RECOVERY_MAX_CONCURRENT + 1).map(|_| Uuid::new_v4()).collect();
        let baseline = STALL_RECOVERY_ACTIVE.lock().map(|a| a.len()).unwrap_or(0);
        let room = STALL_RECOVERY_MAX_CONCURRENT.saturating_sub(baseline);
        if room == 0 {
            // 并发跑的别的用例把名额占满了，本用例的判定没意义；只验证拒绝。
            assert!(!stall_recovery_admit(ids[0]));
            return;
        }
        assert!(stall_recovery_admit(ids[0]), "空闲时必须放行");
        assert!(!stall_recovery_admit(ids[0]), "同一条线路第二次必须拒绝 —— 一条线一个任务");
        for id in ids.iter().skip(1).take(room - 1) {
            assert!(stall_recovery_admit(*id));
        }
        assert!(
            !stall_recovery_admit(ids[room]),
            "超过 {STALL_RECOVERY_MAX_CONCURRENT} 个并发任务必须拒绝",
        );
        stall_recovery_release(ids[0]);
        assert!(stall_recovery_admit(ids[room]), "释放后名额要能再用");
        for id in ids.iter().take(room + 1) {
            stall_recovery_release(*id);
        }
        assert!(!STALL_RECOVERY_ACTIVE.lock().unwrap().contains(&ids[0]));
    }

    /// 任务的结构必须是：只对有记号的线路跑、恢复即停、失败续记号、受开关约束、None 不记账。
    ///
    /// 钉的是实现特征（调用点），不是文案。需要的串拼出来找，避免本测试自己喂绿自己。
    #[test]
    fn stall_recovery_task_stops_when_the_mark_is_gone_and_refreshes_it_on_failure() {
        let src = include_str!("route_health.rs");
        let body = src
            .split("pub fn spawn_stall_recovery(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("spawn_stall_recovery 不见了");
        let stalled_read = format!("{}(m.health_id(), Instant::now())", "route_recently_stalled");
        assert!(
            body.contains(&format!("if !crate::models::{stalled_read}")),
            "任务没有在每轮前检查记号是否还在 —— 线路恢复后探针不会停",
        );
        assert!(
            body.contains(&format!("{}(m.health_id())", "clear_route_stall"))
                && body.contains(&format!("{}(m.health_id())", "clear_route_cooldown")),
            "探通之后没有撤记号/撤冷却，线路回不到排头",
        );
        assert!(
            body.contains(&format!("{}(m.health_id())", "mark_route_stall")),
            "失败没有续记号 —— 120 秒后记号过期，用户又成了探针",
        );
        assert!(body.contains("canary_enabled()"), "恢复探针花的是真钱，必须受 ROUTE_CANARY 约束");
        assert!(body.contains("stall_recovery_admit(m.health_id())"), "没有并发上限");
        assert!(
            body.contains("None =>") && !body.contains("None => record_ok"),
            "「无从探起」必须什么都不记",
        );
        // record_ok 只能出现在探针成功那一支里。
        let ok_arm = body.split("Some((true,").nth(1).and_then(|s| s.split("Some((false,").next()).unwrap_or("");
        assert!(ok_arm.contains("record_ok("), "探通了却不记成功，面板看不到恢复");
        let fail_arm = body.split("Some((false,").nth(1).unwrap_or("");
        assert!(!fail_arm.contains("record_ok("), "失败支里记了成功");
        // 派单路径必须真的起它 —— 写好了零调用点是这个仓库反复出现的失败模式。
        let models_src = include_str!("models.rs");
        let stall_site = models_src
            .split(&format!("{}(candidate.health_id());", "mark_route_stall"))
            .nth(1)
            .expect("派单路径上的 mark_route_stall 不见了");
        // 按**结构**取，不按固定字节数。原来是 `.min(600)`，而这个块里后来又插了一次
        // 「把结果落库」的调用，600 字节就把 spawn_stall_recovery 挤出了窗口 ——
        // 测试红在一个它并不关心的位置上（今天就这么翻了一次）。
        // 固定窗口更坏的一面是**静默**：代码变长之后它会悄悄守不到尾部。
        let after = &stall_site[..stall_site
            .find("route_failed_transient = true;")
            .unwrap_or_else(|| stall_site.len())];
        assert!(
            after.contains("spawn_stall_recovery(&state, candidate.clone())"),
            "卡死之后没有起恢复探针，恢复判定仍由用户的真实请求付费",
        );
    }

    /// `users.email` 并不保证是邮箱 —— 线上有个 admin 的值是用户名。
    #[test]
    fn only_real_addresses_are_treated_as_recipients() {
        assert!(looks_like_email("ops@example.com"));
        assert!(looks_like_email("a.b+tag@mail.co.uk"));
        // 线上实测的那一个：14 个字符、没有 @。往它发就是每轮白打一次必然失败的请求，
        // 而真正的发送失败会被埋在这堆噪声里。
        assert!(!looks_like_email("fendoushaonian"));
        assert!(!looks_like_email(""));
        assert!(!looks_like_email("@example.com"));
        assert!(!looks_like_email("ops@localhost"));
        assert!(!looks_like_email("ops@ example.com"));
        assert!(!looks_like_email("a@b@c.com"));
    }

    /// 发送失败必须把冷却还回去。
    ///
    /// 原来是「先抢占再发」：一次投递故障就让这条线路静音整整 6 小时，而运维什么都收不到
    /// —— 正是这套东西要修的那个形态，不能在告警自己身上再造一遍。
    #[test]
    fn a_failed_send_releases_the_cooldown() {
        let src = include_str!("route_health.rs");
        let body = src
            .split("async fn evaluate_alarm")
            .nth(1)
            .expect("evaluate_alarm 不见了");
        assert!(
            body.contains("if !delivered {"),
            "没有「一封都没送达就释放冷却」的分支",
        );
        let release = body.split("if !delivered {").nth(1).unwrap_or("");
        assert!(
            release.contains("DEL") && release.contains("alarm_sent"),
            "释放分支没有真的把发送权删掉，冷却仍然会挂满",
        );
        // notify 必须回报结果，否则上面那个判断永远拿不到真相。
        assert!(
            src.contains("async fn notify(state: &AppState, subject: &str, body: &str) -> bool"),
            "notify 不回报是否送达，调用方只能假设成功",
        );
    }

    /// 阈值本身要站得住：3 连败在 16–20% 的常态失败率下会误报，5 连败不会。
    #[test]
    fn the_streak_threshold_survives_the_background_failure_rate() {
        let background = 0.20_f64;
        let false_alarm = background.powi(FAILING_STREAK as i32);
        assert!(
            false_alarm < 0.001,
            "连败阈值 {FAILING_STREAK} 在 20% 的常态失败率下误报概率 {false_alarm:.4}，太高了",
        );
        assert!(FAILING_STREAK >= 3, "太小的话一次偶发抖动就报警，几次之后告警就被静音");
    }

    // ── 探活按价定频（2026-08-28）──────────────────────────────────────────────
    //
    // 起因是生产 endpoint_probe_usage 的七天实测：同一发 `"hi"` + max_tokens=1，
    // 老实的上游记 8–36 个 token，GPT 线路记 4,555、deepseek 记 2,685、Grok 记 1,343。
    // 三条线路占掉全部探活开销的 93%。

    fn rid(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    /// 贵的线路必须探得比便宜的稀 —— 这是整个改动的目的。
    #[test]
    fn an_expensive_route_is_probed_less_often_than_a_cheap_one() {
        let cheap = rid(11);
        let dear = rid(12);
        // 生产实测的两端：Claude 强力版 8 / 发，GPT 4,555 / 发。
        for _ in 0..8 {
            super::record_probe_cost(cheap, 8);
        }
        for _ in 0..8 {
            super::record_probe_cost(dear, 4_555);
        }

        let cheap_w = super::canary_fresh_window_secs(cheap, "ok");
        let dear_w = super::canary_fresh_window_secs(dear, "ok");

        assert_eq!(
            cheap_w, CANARY_SKIP_IF_FRESH_SECS,
            "便宜线路的节奏被动了 —— 这个改动不该让老实的上游探得更少",
        );
        assert!(
            dear_w > cheap_w * 4,
            "4,555 token 一发的线路和 8 token 一发的线路探得一样勤（{dear_w}s vs {cheap_w}s）\
             —— 那 93% 的开销一分没省",
        );
        assert!(
            dear_w <= CANARY_MAX_FRESH_SECS,
            "再贵也不能稀到没意义：{dear_w}s 超过了上限",
        );
    }

    /// **只有确实还好的线路才配省这笔钱。**
    ///
    /// 反过来做的话就是把监控关掉：一条正在坏的贵线路会因为「探它太贵」而几小时不被碰，
    /// 而需要证据的时刻恰恰就是这时候。恢复也一样探不出来。
    #[test]
    fn only_a_healthy_route_may_skip_probes() {
        let r = rid(13);
        for _ in 0..8 {
            super::record_probe_cost(r, 4_555);
        }
        assert!(
            super::canary_fresh_window_secs(r, "ok") > CANARY_SKIP_IF_FRESH_SECS,
            "前提没成立：这条线路本来就该被拉长窗口，否则下面三条断言是恒真的",
        );
        for word in ["degraded", "error", "unknown"] {
            assert_eq!(
                super::canary_fresh_window_secs(r, word),
                CANARY_SKIP_IF_FRESH_SECS,
                "状态是 {word} 的线路被省掉了探活 —— 正在坏/正在恢复的时候反而不看了",
            );
        }
    }

    /// 进程刚起来时报价表是空的 —— 必须退回改动前的节奏，不能凭一个还不存在的
    /// 报价把线路静音。这是「没查到」不等于「很便宜」的同一条老规矩。
    #[test]
    fn an_unpriced_route_keeps_the_old_cadence() {
        assert_eq!(
            super::canary_fresh_window_secs(rid(14), "ok"),
            CANARY_SKIP_IF_FRESH_SECS,
            "没有任何报价样本时窗口被改了 —— 重启后的第一轮会按一个凭空的数决定探不探",
        );
    }

    /// 失败的探活拿不到 usage。把它当成 0 记进去，会把一条贵线路一路洗成便宜的，
    /// 然后它又回到每 15 分钟一发 —— 省钱的机制被自己的失败样本吃掉。
    #[test]
    fn a_failed_probe_must_not_wash_an_expensive_route_cheap() {
        let r = rid(15);
        for _ in 0..8 {
            super::record_probe_cost(r, 4_555);
        }
        let before = super::canary_fresh_window_secs(r, "ok");
        for _ in 0..40 {
            super::record_probe_cost(r, 0);
        }
        assert_eq!(
            super::canary_fresh_window_secs(r, "ok"),
            before,
            "40 次失败探活（usage 为 0）把这条线路的报价冲淡了",
        );
    }

    /// 上面四条测的都是函数本身，而它们自己往表里塞样本、自己调用窗口函数。
    /// 生产里那两个调用点如果不存在，四条**照样全绿**：一个没人调的省钱机制省不下一分钱。
    /// 所以这一条钉的是调用点确实在。
    #[test]
    fn the_probe_loop_and_the_usage_hook_are_actually_wired_in() {
        let src = include_str!("route_health.rs");
        // **先把测试模块整块切掉。** 变异实测：不切的话，下面那句 contains 的窗口是
        // `&code[loop_at..]` —— 一路吃到文件末尾，于是它匹配到的是**这个测试自己**写
        // 的那串字面量。把生产代码里的调用整个换掉，断言照样绿。
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        // 断言跑的是源文本，而注释里会引用被改掉的旧代码 —— 先把注释剥掉。
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        let loop_at = code
            .find("let mut tick = tokio::time::interval(CANARY_EVERY);")
            .expect("巡检循环不见了");
        let loop_body = &code[loop_at..];
        assert!(
            loop_body.contains("canary_fresh_window_secs(m.id, classify(&h, now))"),
            "巡检循环没有按线路取窗口 —— 定价函数写了但没人用，贵线路照旧每 15 分钟一发",
        );

        let hook_at = code.find("fn note_probe_usage(").expect("用量钩子不见了");
        let hook_body = &code[hook_at..hook_at + 1_200];
        assert!(
            hook_body.contains("record_probe_cost(route_id, tokens.prompt)"),
            "没人把探活的实际报价喂回去 —— 表永远是空的，窗口函数永远退回基础间隔",
        );
    }

    // ── 派单读得到裁决（2026-08-28）────────────────────────────────────────────
    //
    // 起因：`route_health::` 在 models.rs 里出现十处，全是写入。生产实测当日
    // `Claude` 0 成功 / 25 失败、`优惠 Claude` 0 成功 / 24 失败，两条彻底不工作的
    // 线路仍被派了 49 次真实请求 —— 裁决建好了，没人读。

    /// 判死的线路必须能从缓存里读出来，而「没查到」必须读成「不知道」。
    #[test]
    fn an_unknown_verdict_reads_as_not_broken() {
        assert_eq!(
            super::verdict_cached_at(rid(21), Instant::now()),
            None,
            "没有任何裁决样本时读出了结论 —— 那是拿「没查到」当「有问题」",
        );
    }

    /// 裁决会过期。线路修好之后必须能在**有界时间内**重新拿到流量 ——
    /// 降权断掉的是它的真实流量，过期是它走回来的路之一。
    #[test]
    fn a_stale_verdict_stops_counting() {
        let r = rid(22);
        let t0 = Instant::now();
        super::verdict_remember(r, true, t0);
        assert_eq!(
            super::verdict_cached_at(r, t0),
            Some(true),
            "刚写进去的裁决读不出来",
        );
        assert_eq!(
            super::verdict_cached_at(r, t0 + VERDICT_TTL + Duration::from_secs(1)),
            None,
            "裁决永不过期 —— 一条已经修好的线路会被这份记忆一直压在后面",
        );
        assert!(
            VERDICT_TTL <= Duration::from_secs(5 * 60),
            "保鲜期太长，恢复要等太久",
        );
    }

    /// **降权之后，探活是这条线路唯一的恢复通道。**
    ///
    /// 两个改动必须一起看：派单不再给判死的线路真实流量，那它就永远攒不出成功记录；
    /// 而同一天加的探活省钱机制如果也把它跳过，这条线路就被**永久静音**了 ——
    /// 面板上永远红着，谁都不去碰它。所以非 ok 的线路一律全速探。
    #[test]
    fn a_deprioritised_route_still_gets_probed_at_full_speed() {
        let r = rid(23);
        for _ in 0..8 {
            super::record_probe_cost(r, 4_555); // 最贵的那条也一样
        }
        assert_eq!(
            super::canary_fresh_window_secs(r, "error"),
            CANARY_SKIP_IF_FRESH_SECS,
            "判死的线路连探活都被省掉了 —— 派单不给它流量、探活也不碰它，永久静音",
        );
    }

    /// 上面三条测的都是这个模块自己。派单那边如果不调用，整套东西一分钱都省不下、
    /// 一次切换都少不了 —— 而三条**照样全绿**。所以这一条钉的是 models.rs 真的读了。
    #[test]
    fn the_dispatcher_actually_reads_the_verdict() {
        let src = include_str!("models.rs");
        // 先切掉测试模块：否则窗口会一路吃到文件末尾，匹配到测试里自己写的字面量。
        let cut = src.find("mod audit_20260822_tests").unwrap_or(src.len());
        let prod = &src[..cut];
        let code: String = prod
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("route_health::looks_broken_cached(&state, candidate.health_id())"),
            "派单没读 route_health 的裁决 —— 连败 25 次的线路照样排在前面接客",
        );
        assert!(
            code.contains("cooled || mutes || stalled || broken"),
            "读了裁决但没接进排序判据 —— 读到一个没人用的布尔值",
        );
    }


    // ── 管理员通知：攒一窗口、合并成一封（2026-09-07）────────────────────────────

    #[test]
    fn a_digest_keeps_one_per_subject_in_time_order_and_leaves_a_single_notice_alone() {
        let one = digest(vec![AlarmItem { at: 5, subject: "[告警] a".into(), body: "b1".into() }]);
        assert_eq!(one, ("[告警] a".to_string(), "b1".to_string()), "一条就原样，不套汇总的壳");
        let (subject, body) = digest(vec![
            AlarmItem { at: 30, subject: "[告警] a".into(), body: "a-new".into() },
            AlarmItem { at: 10, subject: "[告警] a".into(), body: "a-old".into() },
            AlarmItem { at: 20, subject: "线路缺货：x".into(), body: "x".into() },
        ]);
        assert!(subject.starts_with("[汇总] 2 条管理员通知"), "{subject}");
        assert!(body.contains("a-new") && !body.contains("a-old"), "同主题只留最新：{body}");
        assert!(body.find("线路缺货").unwrap() < body.find("[告警] a").unwrap(), "按时间排序：{body}");
        assert!(body.contains("── "), "每条要有分隔：{body}");
    }

    /// 三个来源都走 notify，而 notify 只许进队列——任何一处当场单独发，就又是「同一时间许多重复的」。
    #[test]
    fn every_admin_notice_is_batched_not_sent_on_the_spot() {
        let src = include_str!("route_health.rs");
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let notify = src.split("async fn notify(state: &AppState, subject: &str, body: &str) -> bool").nth(1).expect("notify");
        let notify = &notify[..notify.find("\n}\n").unwrap_or(notify.len())];
        assert!(notify.contains("queue_push("), "notify 没进队列——那就是当场发");
        assert!(!notify.contains("send_mail(") && !notify.contains("deliver("), "notify 当场发信，合并就没有意义了");
        let flush = src.split("async fn flush_alarm_queue(").nth(1).expect("flush_alarm_queue");
        let flush = &flush[..flush.find("\n}\n").unwrap_or(flush.len())];
        assert!(flush.contains("digest(") && flush.contains("deliver("), "冲队列时没有合并成一封");
        let deliver = src.split("async fn deliver(").nth(1).expect("deliver");
        let deliver = &deliver[..deliver.find("\n}\n").unwrap_or(deliver.len())];
        assert!(deliver.contains("log_send("), "每一封都要进 email_logs，否则发了几封没人知道");
        // 队列要有人按窗口冲：spawn 里必须起那个小循环，间隔读的是配置里的窗口。
        let spawn = src.split("pub fn spawn(state: AppState)").nth(1).expect("spawn");
        assert!(spawn.contains("flush_alarm_queue(") && spawn.contains("alarm_batch_window_secs"), "没有按窗口冲队列的循环，排队的通知永远发不出去");
        // 缺货和亏本两个来源没有绕开 notify 自己发信。
        for (file, body) in [("manifest_check.rs", include_str!("manifest_check.rs")), ("relay_sync.rs", include_str!("relay_sync.rs"))] {
            assert!(!body.contains("email::send_mail("), "{file} 绕开了 notify 直接发信，节流对它无效");
        }
    }

    /// 恢复不再清发送权：同一条线路 6 小时内最多一对「告警 / 恢复」。
    #[test]
    fn a_flapping_route_gets_one_alarm_and_one_recovery_per_cooldown() {
        let src = include_str!("route_health.rs");
        let body = src.split("async fn evaluate_alarm").nth(1).expect("evaluate_alarm");
        let recovery = &body[..body.find("// 第一次判坏").expect("恢复分支后面是首次判坏")];
        let del = recovery.split("redis::cmd(\"DEL\")").nth(1).expect("恢复分支要清起点");
        let del = &del[..del.find(".query_async").unwrap_or(del.len())];
        assert!(del.contains("since_key") && !del.contains("alarm_sent"), "恢复时又把发送权删了——抖动的线路会每 20 分钟来一对邮件");
        assert!(recovery.contains("alarm_recovered") && recovery.contains("ALARM_COOLDOWN_SECS"), "恢复通知没有自己的冷却");
    }

    #[test]
    fn the_batch_window_is_documented_for_the_operator() {
        let env = include_str!("../.env.example");
        assert!(env.contains("ALARM_BATCH_WINDOW_SECS="), ".env.example 没写合并窗口这个旋钮");
    }
}
