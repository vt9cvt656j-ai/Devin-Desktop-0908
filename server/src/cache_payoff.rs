//! 缓存写入划不划算 —— 按**这条线路自己的执行事实**判，不按厂商名单。
//!
//! # 为什么需要它
//!
//! Anthropic 的提示词缓存要**付费写入**：写一次按输入价的 1.25 倍收，读回来只要 0.025 倍。
//! 所以写进去从来读不到，比压根不缓存还贵 25% —— 这是唯一一种「优化」把钱做多的形状。
//!
//! 而线上这类中转的缓存**在负载均衡后面是每实例一份**。本仓库早就实测过：
//! 连续 16 次调用，`[tools+system]` 前缀的指纹逐字节相同（sys_hash + tools_hash 一致），
//! 中转商却几乎每次都收缓存写入、读取只偶尔命中。用户侧看到的正是上游那句
//! 「本条请求疑似协议和模型不匹配导致 cache 异常」——它把「你写了但我这台没有」
//! 归因成了协议不匹配。
//!
//! OpenAI / xAI 那两条线有解：发 `prompt_cache_key` / `x-grok-conv-id`，负载均衡按这个键
//! 把同一段对话钉在同一台机器上。**Anthropic 协议没有对应字段**，钉不住。
//!
//! 于是 Anthropic 这条线只剩一个办法：**不划算就别写**。
//!
//! # 判据是算术，不是名单
//!
//! 写入多花 `0.25 × 输入价 × 写入量`，读回省下 `0.975 × 输入价 × 读取量`。
//! 所以「继续写」当且仅当
//!
//! ```text
//! 0.975 × 读取量  >=  0.25 × 写入量
//! ```
//!
//! 两边同乘输入价即为真实金额，**倍率约掉**，所以这条判据对所有模型、所有定价都成立，
//! 不需要知道任何一家的价目表，也不需要维护厂商名单（名单一定会漂，本仓库为此吃过好几次亏）。
//!
//! # 三个必须有的保护
//!
//! · **样本不够就继续写。** 新线路、刚重启、冷启动时计数都是 0，此时默认开着 ——
//!   宁可多花那 25%，也不能把一条本来命中良好的线路误关掉。
//! · **会自己恢复。** 关掉之后写入量归零、读取量也归零，光看计数会永远关着。
//!   所以计数**随时间半衰**：一段时间不写之后样本掉回门槛以下，判据自动放行去再试一次。
//!   这是探索/利用的最小实现，不需要定时器，也不需要额外状态。
//! · **只影响写入，不影响读取。** 关掉之后请求里不再带断点，但上游若仍有可用前缀照样
//!   会命中并按读取价收 —— 我们只是不再**付钱去建**它。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 读取省下的比例 = `1 - 缓存读倍率`。
///
/// **倍率从计费那份取，不在这里自己写一个数。** 这两处各写一遍的后果实测过：
/// 这里一度写成 0.025（读价 = 输入价的 2.5%），而计费用的是 0.1 —— 判据因此比该有的
/// 松一档，读写比落在 0.256~0.278 之间时，它说「划算」而实际每一笔都在亏。
/// 一个只在窄区间里错、且永远不报错的数，靠读代码是发现不了的。
const READ_SAVING: f64 = 1.0 - crate::models::CACHE_READ_FACTOR;
/// 5 分钟档写入多付的比例 = `1.25 - 1`。
const WRITE_PREMIUM: f64 = crate::models::CACHE_WRITE_FACTOR - 1.0;
/// 1 小时档写入多付的比例 = `2.0 - 1`。**是 5 分钟档的四倍**，所以两档不能混成一个数。
///
/// 为什么必须按上游**实际报回来的分档**算，而不是按「我们请求里发了什么」：
/// 中转可能把 `ttl:"1h"` 剥掉再转发，那时上游按 5 分钟收我们（1.25×），而回执里
/// `ephemeral_1h_input_tokens` 就是 0。用「我们发了 1h」去算溢价，会把一条**本来划算**
/// 的线路误判成亏本并关掉缓存 —— 而关掉缓存是这里最贵的一种错。
const WRITE_PREMIUM_1H: f64 = crate::models::CACHE_WRITE_FACTOR_1H - 1.0;

/// 攒够这么多写入 token 才允许判「不划算」。
///
/// 取 20 万：一条 agent 线路上大约十几轮的量级，足以看出「读得回来吗」这件事，
/// 又不至于让一条刚上线的线路因为头几次没命中就被关掉。
const MIN_SAMPLE_WRITES: f64 = 200_000.0;

/// 半衰期。超过这个时长没有新观测，样本减半 —— 既让判据跟着上游的变化走
/// （中转换实例、换负载策略是常事），也提供了自动重试的路径。
const HALF_LIFE: Duration = Duration::from_secs(30 * 60);

/// 纯判据：给定这条线路累计的读/写量，还该不该继续付钱写缓存。
///
/// 样本不足一律返回 true（继续写）——「没观测到」和「观测到不划算」是两件事。
pub(crate) fn cache_write_pays_off(reads: f64, writes: f64, writes_1h: f64) -> bool {
    if !(writes.is_finite() && reads.is_finite() && writes_1h.is_finite()) {
        return true;
    }
    if writes < MIN_SAMPLE_WRITES {
        return true;
    }
    // 1 小时那部分按它自己的溢价算，剩下的按 5 分钟档。`clamp` 挡中转报出分档大于总量。
    let hour = writes_1h.clamp(0.0, writes);
    let paid = (writes - hour) * WRITE_PREMIUM + hour * WRITE_PREMIUM_1H;
    reads * READ_SAVING >= paid
}

#[derive(Clone, Copy)]
struct Tally {
    reads: f64,
    writes: f64,
    /// `writes` 里按 1 小时 TTL 写入的部分。溢价是 5 分钟档的四倍，必须分开记。
    writes_1h: f64,
    at: Instant,
}

impl Tally {
    /// 按经过的时间做指数衰减。半衰期一到，样本减半。
    fn decayed(self, now: Instant) -> Self {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        let half = HALF_LIFE.as_secs_f64().max(1.0);
        let factor = 0.5_f64.powf(elapsed / half);
        Self {
            reads: self.reads * factor,
            writes: self.writes * factor,
            writes_1h: self.writes_1h * factor,
            at: now,
        }
    }
}

static TALLIES: Mutex<Option<HashMap<uuid::Uuid, Tally>>> = Mutex::new(None);

/// 记一次真实回执的缓存读/写量。**只接受上游报回来的数**，不接受任何估算值。
pub(crate) fn observe(
    route: uuid::Uuid,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    cache_write_1h_tokens: i64,
) {
    if cache_read_tokens <= 0 && cache_write_tokens <= 0 {
        return; // 这一笔和缓存无关，别拿它稀释样本
    }
    let now = Instant::now();
    let Ok(mut guard) = TALLIES.lock() else { return };
    let map = guard.get_or_insert_with(HashMap::new);
    let entry = map.entry(route).or_insert(Tally {
        reads: 0.0,
        writes: 0.0,
        writes_1h: 0.0,
        at: now,
    });
    let mut cur = entry.decayed(now);
    cur.reads += cache_read_tokens.max(0) as f64;
    cur.writes += cache_write_tokens.max(0) as f64;
    cur.writes_1h += cache_write_1h_tokens.max(0) as f64;
    *entry = cur;
}

/// 这条线路现在还该不该注入缓存断点。没有任何观测时返回 true。
pub(crate) fn should_write_cache(route: uuid::Uuid) -> bool {
    let now = Instant::now();
    let Ok(guard) = TALLIES.lock() else { return true };
    let Some(map) = guard.as_ref() else { return true };
    let Some(t) = map.get(&route) else { return true };
    let t = t.decayed(now);
    cache_write_pays_off(t.reads, t.writes, t.writes_1h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_that_reads_back_what_it_writes_keeps_caching() {
        // 线上 claude-opus-5 的真实形状：14 天读 1.41 亿、写 4828 万 —— 净赚。
        assert!(cache_write_pays_off(141_344_219.0, 48_280_616.0, 0.0));
        // 刚好打平的边界：0.9×R = 0.25×W → R/W = 5/18 ≈ 0.27778。
        // 这两条同时钉住**倍率本身**：把 READ_SAVING 改回 0.975，下面那条就会翻绿。
        assert!(cache_write_pays_off(277_800.0, 1_000_000.0, 0.0));
        assert!(!cache_write_pays_off(277_700.0, 1_000_000.0, 0.0),
            "打平点算错了 —— 判据用的缓存读倍率和计费那份对不上");
    }

    #[test]
    fn a_route_that_only_ever_writes_stops_paying_the_premium() {
        // gpt-5.6-luna 的真实形状：33 轮写了 21 万、读 0。
        // 样本刚好卡在门槛上，多一点就该关。
        assert!(!cache_write_pays_off(0.0, 210_981.0 + MIN_SAMPLE_WRITES, 0.0));
        // 只写不读、但样本还不够 → 继续写。「没观测到」不等于「不划算」。
        assert!(cache_write_pays_off(0.0, 1_000.0, 0.0));
        assert!(cache_write_pays_off(0.0, MIN_SAMPLE_WRITES - 1.0, 0.0));
    }

    #[test]
    fn a_one_hour_write_has_to_earn_four_times_as_much_back() {
        // 1 小时写入是 2× 输入价、5 分钟是 1.25×，溢价 1.0 vs 0.25 —— 差四倍。
        // 混成一个数的后果是单向的：按 5 分钟算，一条只写 1 小时缓存又读不回来的线路
        // 会被判成「划算」，一直付四倍的溢价。
        let w = 1_000_000.0;
        // 全 5 分钟：打平点 R/W = 0.25/0.9 ≈ 0.2778
        assert!(cache_write_pays_off(277_800.0, w, 0.0));
        assert!(!cache_write_pays_off(277_700.0, w, 0.0));
        // 全 1 小时：打平点 R/W = 1.0/0.9 ≈ 1.1112
        assert!(cache_write_pays_off(1_111_200.0, w, w));
        assert!(!cache_write_pays_off(1_111_100.0, w, w),
            "1 小时的写入按 5 分钟的溢价算了 —— 四倍的钱被当成四分之一");
        // 一半一半：打平点落在两者中间。
        assert!(cache_write_pays_off(694_500.0, w, w / 2.0));
        assert!(!cache_write_pays_off(694_400.0, w, w / 2.0));
    }

    #[test]
    fn a_relay_that_strips_the_ttl_must_not_get_the_route_switched_off() {
        // 中转把请求里的 ttl:"1h" 剥掉再转发时，上游按 5 分钟收我们（1.25×），
        // 回执里的 1 小时分档就是 0。若判据按「我们请求里发了 1h」去算溢价，
        // 一条读写比 0.5 的线路会被误判成亏本并关掉缓存 —— 而关掉缓存是这里最贵的错。
        let w = 1_000_000.0;
        assert!(
            cache_write_pays_off(500_000.0, w, 0.0),
            "回执说是 5 分钟档，判据却按 1 小时的溢价算，把一条划算的线路关掉了"
        );
        // 分档比总量还大（中转报出自相矛盾的数）不能把判据算爆。
        assert!(cache_write_pays_off(1_200_000.0, w, 9.9e9));
    }

    #[test]
    fn nonsense_numbers_never_turn_caching_off() {
        assert!(cache_write_pays_off(f64::NAN, 1e9, 0.0));
        assert!(cache_write_pays_off(0.0, f64::INFINITY, 0.0));
        assert!(cache_write_pays_off(0.0, 0.0, 0.0));
        assert!(cache_write_pays_off(-1.0, -1.0, 0.0));
        assert!(cache_write_pays_off(0.0, 1e9, f64::NAN));
    }

    // 计数表是进程级共享的，而 cargo 并行跑测试 —— 所以**每条测试用各自的线路 id**，
    // 绝不清空整张表。（先前用过一个 reset_for_test()：单跑全绿，进全量套件就翻红，
    // 因为它把并行跑的另一条测试刚攒的样本一起清掉了。）
    #[test]
    fn an_unseen_route_is_allowed_to_cache() {
        assert!(should_write_cache(uuid::Uuid::from_u128(1)));
    }

    #[test]
    fn observations_accumulate_and_flip_the_decision() {
        let route = uuid::Uuid::from_u128(2);
        assert!(should_write_cache(route), "没观测过就该放行");

        // 只写不读，攒过门槛 → 关掉。
        for _ in 0..30 {
            observe(route, 0, 10_000, 0);
        }
        assert!(!should_write_cache(route), "只写不读攒够了样本，还在付写入溢价");

        // 换一条线路互不影响 —— 判据是**每条线路自己的**事实。
        assert!(should_write_cache(uuid::Uuid::from_u128(3)));
    }

    #[test]
    fn reads_bring_a_route_back() {
        let route = uuid::Uuid::from_u128(4);
        for _ in 0..30 {
            observe(route, 0, 10_000, 0);
        }
        assert!(!should_write_cache(route));
        // 上游恢复正常之后读回来的量足够，判据自己放行 —— 不需要人工干预。
        observe(route, 2_000_000, 0, 0);
        assert!(should_write_cache(route), "读回来了却还关着 —— 这条闸只能单向关，等于永久降级");
    }

    #[test]
    fn a_call_with_no_cache_activity_does_not_dilute_the_sample() {
        let route = uuid::Uuid::from_u128(5);
        for _ in 0..30 {
            observe(route, 0, 10_000, 0);
        }
        assert!(!should_write_cache(route));
        // 一堆与缓存无关的调用不该把判据洗回去。
        for _ in 0..1000 {
            observe(route, 0, 0, 0);
        }
        assert!(!should_write_cache(route), "无关调用把样本冲淡了");
    }
}
