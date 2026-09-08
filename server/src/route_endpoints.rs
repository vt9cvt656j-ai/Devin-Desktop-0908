//! 多路由：一条线路挂多个上游出口，按进价从便宜到贵用，坏的自动排后面。
//!
//! # 它和 models 那张表的分工
//!
//! `models` 里一行是**一条线路**：一个身份。用户在 IDE 里看到的名字、开放哪些模型、
//! 按什么价扣钱、用量算到谁头上，全在那一行。
//!
//! 这张表一行是**一个出口**：往哪个地址发、用哪个密钥、我进价几折。仅此而已。
//!
//! 这么切不是为了整洁，是因为计费读的是**真正答复的那一行**（`models.rs` 里
//! `match (success, selected_conn)`）。要是多个上游各占一行 `models`，价格字段就各有
//! 一份，同一个模型用户被扣多少钱要看当时哪家转卖商先答；运维每加一个上游，就多一次
//! 悄悄按另一个价计费的机会。出口换来换去换不动账单，靠的是账单字段根本不在这张表里，
//! 而不是靠运维记得把几行价格填成一样。
//!
//! # 为什么排序是「进价升序」而不是让运维排
//!
//! 线路之间的次序（`models.sort`）是运维的意图：它决定用户看到哪个名字、按哪个价。
//! 但同一条线路下的几个出口对用户是**完全等价**的 —— 同样的模型、同样的账单，
//! 只有我的进价不同。既然等价，就没有任何理由让人手排：便宜的先用是唯一正确答案。
//!
//! **倍率**（0.3 = 官方价的 0.3 倍）而不是绝对价：转卖商就是这么报价的，而且对全部
//! 模型同时成立，一个数就够。它只进排序，不进账单。
//!
//! 是倍率，不是折扣。两者在 0<v<1 这一段数值相同，但「折扣」自带一条上限 1.0 ——
//! 而一个比原价贵的替补出口是合法配置（排在直连后面，只有便宜的都坏了才轮到它）。
//! 词错了，校验就会跟着错，把它在保存时拒掉。
//!
//! # 「自动测」为什么是发一次真请求
//!
//! `health.rs` 那个探针的教训就在隔壁：它对 `base_url` 发一个不带凭据的 GET，任何回应
//! 都算健康 —— 于是十条线路共用一个域名时，它把同一次 TCP 握手做了十遍、全绿，而一条
//! 连续 44 小时零成功的线路从头到尾报 `ok=t 1ms`。
//!
//! 一个出口会坏在四个地方：域名没了、密钥不对、这家没有这个模型、能连但不出货。
//! 只有前一个能靠握手看出来。所以这里发一次**真的**对话请求（`max_tokens` 取 1），
//! 看它是不是回了一个形状对的响应。烧的 token 是个位数，但它是唯一能同时验到那四件事
//! 的办法。
//!
//! # 探测失败为什么只是排后面，不是停用
//!
//! 一次探测是一个样本，不是判决 —— 上游抖一下、我这边网络抖一下，都会得到失败。
//! 拿一个样本去停用出口，就是把「可能还能用」变成「肯定不能用」；而如果所有出口
//! 恰好在同一分钟各抖了一次，整条线路就没有出口可用了。所以探测结果只改次序：
//! 没问题的排前面，有问题的留在后面兜底。真正确定坏了的（密钥被拒）由
//! `models.rs` 里已有的 `mark_route_cooldown_auth` 冷却掉，那是**执行事实**，不是探测。
//!
//! # 一个必须知道的上限
//!
//! `CHAT_UPSTREAM_MAX_ROUTES_WHEN_ANSWERED = 2`：一个请求最多换两个出口就收手（再多
//! 客户端就等不起了）。所以挂十个上游不等于有十次机会 —— **只有排在最前面的两个真的
//! 会被用到**。这正是排序必须同时看进价和健康的原因：排序不对，多挂的那八个就只是
//! 躺在库里。

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::models::Model;
use crate::AppState;

/// 探测的死线。比 chat 的表头预算短得多：探测是运维在后台等一个结果，不是用户在等回答，
/// 而一个要 20 秒才回表头的出口，本来就不该排在前面。
const PROBE_TIMEOUT_SECS: u64 = 20;

/// 后台自动重测的间隔。
///
/// 取 15 分钟而不是 1 分钟：每次探测烧真 token，而出口的状态不会分钟级变化。
/// 真正的实时判据是 `route_health` 那套（真实流量的结局），探测只负责覆盖
/// 「这个出口今天还没人用过，我不知道它行不行」。
const PROBE_EVERY_SECS: u64 = 15 * 60;

const MAX_LABEL: usize = 60;
const MAX_NOTE: usize = 200;
const MAX_URL: usize = 400;

pub(crate) fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

#[derive(sqlx::FromRow, Clone)]
pub struct Endpoint {
    pub id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub label: String,
    pub base_url: String,
    pub api_key: String,
    pub cost_ratio: f64,
    pub active: bool,
    pub note: String,
    /// 这个出口实际有哪些模型。空 = 线路的全部。
    #[sqlx(default)]
    pub enabled_models: Vec<String>,
    /// 这个出口说什么协议。空 = 跟线路一样。
    #[sqlx(default)]
    pub protocol: String,
    /// 这个出口能扛多少（相对值，同线路下用同一把尺）。None = 没填。
    /// 只在「首选被限流、要挑替补」时参与权重，平时一点作用都没有。
    #[sqlx(default)]
    pub capacity: Option<f64>,
    pub probe_ok: Option<bool>,
    pub probe_at: Option<chrono::DateTime<chrono::Utc>>,
    pub probe_ms: Option<i32>,
    pub probe_note: String,
    /// 查余额用的凭据（加密存）。空 = 没配，退回去用调用密钥试。
    ///
    /// 和 api_key 分开是因为它们是**两套凭据**：余额接口要的是控制台登录令牌，
    /// 而 api_key 是 `sk-` 开头的调用密钥。实测线上三家中转都是这个情况。
    #[sqlx(default)]
    pub balance_token: String,
    /// 最近一次**真实成功**／**真实失败**的时刻，从 `route_attempt` 连出来的，
    /// 不是这张表自己的列。排序拿它当「执行事实」用，见 `availability_tier`。
    #[sqlx(default)]
    pub last_ok_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(default)]
    pub last_fail_at: Option<chrono::DateTime<chrono::Utc>>,
    /// 最近 7 天**真实成功**请求的首字毫秒累加值和样本数。
    /// 和 `last_*_at` 一样是从 `route_attempt` 连出来的，不是这张表自己的列。
    ///
    /// 存「和 + 个数」而不是算好的平均：`SUM()` 在 Postgres 里回的是 NUMERIC，
    /// 再做除法还是 NUMERIC，而这一行按 `i64` 解码 —— 类型对不上时
    /// `load_for_routes` 的兜底是**返回空**，于是所有出口凭空消失、多路由整个静默
    /// 关掉，界面上什么都不报，只有一行 WARN。踩过一次，真上线了才发现。
    /// 所以这个文件里每一处 `SUM(` 都必须显式 `::bigint`，有测试守着。
    #[sqlx(default)]
    pub real_sum: Option<i64>,
    #[sqlx(default)]
    pub real_n: Option<i64>,
    /// 最近这段时间的**真实成败次数**。选路的第三个维度：成功率。
    ///
    /// 窗口是「最近 24 小时，样本不够就退回 7 天」—— 一天一刷，昨天的坏运气不会
    /// 压着今天，而流量稀的出口也不会因为样本太少被一两次失败判死。
    #[sqlx(default)]
    pub real_ok: Option<i64>,
    #[sqlx(default)]
    pub real_bad: Option<i64>,
}

/// 算成功率**惩罚**（不是那道可靠性闸）要几个样本才作数。
///
/// 一两次失败说明不了什么 —— 不设门槛的话，一个刚上线、第一发正好撞上上游抖动的
/// 出口会被打成 0% 然后再也拿不到流量，也就永远翻不了身。
///
/// 那道闸走的是另一套判据（`is_reliable` 的置信上界），它自带小样本保护，
/// 不需要这个常量。
pub const MIN_RATE_SAMPLES: i64 = 8;

/// 成功率再低也按这个数算惩罚。
///
/// 不封底的话，一个 2% 成功率的出口惩罚是 50 倍，而它可能只是刚好赶上一次上游全挂；
/// 封在 20% 上，最狠也就是 5 倍 —— 足够把它排到后面，又不至于永久除名
/// （真的死了会被 tier 挡在最后，那是另一道闸）。
pub const MIN_RATE: f64 = 0.2;

/// 慢惩罚的上限。四倍慢 → 两倍惩罚（开方），再慢也不超过这个数。
pub const MAX_SLOW_PENALTY: f64 = 3.0;

/// 「这个出口基本靠谱」的线。低于它的一律排到靠谱的那批**后面**，价钱再便宜也不行。
///
/// # 为什么是闸，不是乘数
///
/// 纯按钱算，先撞便宜的那个是划算的：失败不花钱，只花时间。线上那组真数字 ——
/// 自带地址 ¥0.10 / 73%，寒鹤 ¥0.20 / 99% —— 先撞前者的期望花费是 ¥0.127，
/// 比一直用后者的 ¥0.20 省。乘法惩罚（1/成功率）算出来也是前者胜。
///
/// **但那笔账没算用户的时间。** 那 27% 的失败在日志里是「上游卡满整段预算才失败」
/// （`upstream stalled before response headers`），不是秒失败。为省几分钱让四分之一
/// 的请求先卡一次，这个交易对一个卖流畅体验的产品是亏的。
///
/// 所以低于这条线的出口整体靠后：十次里坏一次以上，用户是能感觉到的；
/// 高于这条线，差异已经是噪声，让价钱去决定。
///
/// 它**不是**除名 —— 靠谱的那批全打不通时，它们照样会被用到。
pub const RELIABLE_FLOOR: f64 = 0.9;

/// 这个出口靠不靠谱。`false` = 排到靠谱的那批后面。
///
/// # 判的是「有把握它不行」，不是「这次算出来不行」
///
/// 直接拿 `成功数 / 总数 >= 0.9` 判会被小样本的噪声牵着走：线上真出现过
/// **deepseek 自带地址 8/9 = 89%** 被判成不靠谱 —— 九次里错一次而已，那是噪声，
/// 不是证据。而被判一次的后果是拿不到流量，也就更难攒出样本翻身。
///
/// 判据见 `confidently_below_floor`：只有当「它其实是好的、只是运气差」这个解释
/// 站不住时，才降级。这和这个文件里那条一贯的规矩是同一件事：
/// **没有证据不构成降级理由。**
pub fn is_reliable(ok: i64, bad: i64) -> bool {
    let total = ok.saturating_add(bad);
    if total <= 0 {
        return true;
    }
    !confidently_below_floor(ok, total)
}

/// 「有把握它的真实成功率低于 `RELIABLE_FLOOR`」吗。
///
/// 精确的**单侧二项检验**：假设真实成功率就是那条线（90%），算出「跑 n 次、成功不超过
/// 观察到的这么少次」的概率。这个概率小于 5% 才算有把握 —— 也就是说，只有当
/// 「它其实是好的、只是运气差」这个解释站不住时，才降级。
///
/// # 为什么不用置信区间
///
/// 试过 Wilson 上界，它在 p̂ 贴 0 的那一端过激：0 成 1 败算出来的上界是 0.79，
/// 于是**第一发就失败的新出口当场被判死**。而真实成功率哪怕是 90%，错一次的概率
/// 也有 10% —— 那不是证据。精确检验给的是 P=0.1，不判，这才对。
///
/// 实际效果（都是线上真数字）：
/// ```text
///   0/1           P=0.10   → 靠谱（错一次说明不了什么）
///   0/3           P=0.001  → 不靠谱（真是 90% 的话连错三次几乎不可能）
///   8/9   = 89%   P=0.61   → 靠谱（九次错一次是噪声）
///   80/90 = 89%   P=0.36   → 靠谱（离 90% 不够远，样本再多也没意义）
///   32/44 = 73%   P≈1e-5   → 不靠谱
///   54/81 = 67%   P≈1e-12  → 不靠谱
///   190/192= 99%  P≈1.0    → 靠谱
/// ```
///
/// 小样本天然被放过，不用另拍一个「至少几次」的门槛。这就是
/// **没有证据不构成降级理由** 在数字上的样子。
pub fn confidently_below_floor(ok: i64, total: i64) -> bool {
    if total <= 0 || ok < 0 {
        return false;
    }
    let n = total as f64;
    let k = ok.min(total) as f64;
    let p = RELIABLE_FLOOR;
    // 观察到的比例已经不低于那条线 → 尾概率至少一半，怎么都算不出「有把握」。
    if k / n >= p {
        return false;
    }
    // **全程在对数空间算。**
    //
    // 直接递推 pmf 会在 n 一大就死：pmf(0) = (1-p)^n，n=1000 时是 1e-1000，
    // f64 下溢成 0，之后每一项乘什么都还是 0，尾概率算出来是 0 ——
    // 于是 890/1000（89%，统计上和 90% 没有显著差别）会被判成「有把握它不行」。
    // 而这个系统里几百上千的样本几天就攒到了，不是理论问题。
    let logp = p.ln();
    let logq = (1.0 - p).ln();
    let step = |i: f64| ((n - i + 1.0) / i).ln() + logp - logq;

    // 第一遍找最大项，第二遍以它为基准求和（log-sum-exp）——
    // 这样每一项都在 exp 表示得下的范围里。
    let mut lp = n * logq;
    let mut max_lp = lp;
    let mut i = 1.0;
    while i <= k {
        lp += step(i);
        if lp > max_lp {
            max_lp = lp;
        }
        i += 1.0;
    }
    let mut lp = n * logq;
    let mut sum = (lp - max_lp).exp();
    let mut i = 1.0;
    while i <= k {
        lp += step(i);
        sum += (lp - max_lp).exp();
        i += 1.0;
    }
    let log_tail = max_lp + sum.ln();
    log_tail < 0.05f64.ln()
}

/// 一个出口的综合得分：**越小越先用**。
///
/// # 为什么不是「便宜的先用」
///
/// 线上实测（grok-4.6，同一天）：
/// ```text
///   寒鹤的小破站   149 成 / 2 败 = 99%   ¥0.20
///   Grok 自带地址   32 成 /12 败 = 73%   ¥0.10
/// ```
/// 老排序只看「能用档 / 慢不慢 / 便宜」，而「能用档」判的是**最近一次**是成是败 ——
/// 它分不出 99% 和 73%，两个都算活着。于是便宜的自带地址排在前面，每四发废一发，
/// 那一发的时间用户白等。用户最早提的就是这件事：分不清谁稳。
///
/// # 三个维度怎么合成一个数
///
/// ```text
///   得分 = 进价 × (1 / 成功率) × √(首字延迟 / 同线路最快)
/// ```
///
/// * `1 / 成功率`：一次失败的代价是**白等一个来回**。平均要发两次才成的出口，
///   等同于把一次请求的代价翻倍 —— 所以它必须便宜一半才值得排在前面。
/// * `√(延迟倍数)`：慢要罚，但不该压过价钱。四倍慢罚两倍，八倍慢罚 2.8 倍。
///   用开方而不是线性，是因为首字延迟本身抖动很大，线性会让排序天天翻烧饼。
///
/// 两个惩罚都有**证据门槛**：样本不够就不罚（`MIN_RATE_SAMPLES`），也都有上限，
/// 免得一次抖动把一个好出口永久除名。这和这个文件里其它地方一条规矩：
/// **没有证据不构成降级理由**。
///
/// 这个得分只在**同一个可靠性档内**决定先后 —— 跨档由 `is_reliable` 那道闸说了算，
/// 理由见它自己那段：便宜换来的是用户多卡一次，那笔账不划算。
pub fn endpoint_score(cost: f64, ok: i64, bad: i64, ms: Option<i32>, best_ms: Option<f64>) -> f64 {
    let mut score = if cost.is_finite() && cost > 0.0 { cost } else { 1.0 };

    let total = ok.saturating_add(bad);
    if total >= MIN_RATE_SAMPLES {
        let rate = (ok as f64 / total as f64).clamp(MIN_RATE, 1.0);
        score /= rate;
    }

    if let (Some(ms), Some(best)) = (ms, best_ms) {
        if ms > 0 && best > 0.0 {
            let ratio = (ms as f64 / best).max(1.0);
            score *= ratio.sqrt().min(MAX_SLOW_PENALTY);
        }
    }
    score
}

impl Endpoint {
    /// 真实成功请求的平均首字毫秒。样本为 0 就是没有。
    pub fn real_ttfb_ms(&self) -> Option<i64> {
        match (self.real_sum, self.real_n) {
            (Some(sum), Some(n)) if n > 0 => Some(sum / n),
            _ => None,
        }
    }
}

/// 判「慢不慢」该拿哪个耗时。**有真实流量就用真实的。**
///
/// 探测只发一句 `hi`、只用一个模型、一轮一个样本；真实流量量的是用户实际等的那一段。
/// 线上这两个数差得很远：Grok 那个 0.005 倍的出口探测 19551ms、真实 27556ms。
///
/// 样本少于 `MIN_REAL_SAMPLES` 就不算数 —— 一两次的均值被一个离群值就能拽走，
/// 而这个数会决定一个出口要不要被降级。宁可退回探测，也不拿噪声当证据。
pub const MIN_REAL_SAMPLES: i64 = 5;

pub fn effective_ms(real_ms: Option<i64>, real_n: Option<i64>, probe_ms: Option<i32>) -> Option<i32> {
    if real_n.unwrap_or(0) >= MIN_REAL_SAMPLES {
        if let Some(ms) = real_ms.filter(|v| *v > 0) {
            return Some(ms.min(i32::MAX as i64) as i32);
        }
    }
    probe_ms
}

/// 探测结论的保质期。
///
/// 探测每 15 分钟一轮（`PROBE_EVERY_SECS`），2 小时 = 连着八轮没跑成。超过就当
/// **没测过**，而不是继续拿着那个「测通了」用 —— 陈旧的好消息不是好消息。
/// 这和 `route_health::classify` 里「上次成功已经旧了就退回不知道」是同一条规矩。
pub const PROBE_FRESH_SECS: i64 = 2 * 60 * 60;

/// 「慢得离谱」的判据，两个条件**必须同时**成立。
///
/// 只看相对倍数：全场都 3 秒的时候，一个 4.5 秒的会被无谓降级，而它其实没问题。
/// 只看绝对毫秒：整条线路都慢的时候所有人一起降级，等于没降。
/// 两个一起才只抓住真正该抓的那种 —— 明显比同线路最快的那个慢一大截，而且慢到
/// 用户能感觉出来。
pub const SLOW_FACTOR: f64 = 3.0;
pub const SLOW_FLOOR_MS: f64 = 5_000.0;

/// 可用性档：**能用的在前**。小的先用。
///
/// 反过来（先便宜）会让一个已知打不通的便宜出口稳定占掉两个尝试位里的一个 ——
/// 每个请求都先去撞它一次，用户每次都多等一个来回。便宜是省钱，能用是前提。
///
/// `None`（还没测过）排在「测过并且成功」之后、「测过并且失败」之前：没有证据不等于
/// 坏，但也不该越过有证据能用的那个。这和 `route_health` 里「绝不因为没有证据就报绿」
/// 是同一条规矩。
///
/// 「测通了但那是三天前的事」也算没证据 —— 见 `PROBE_FRESH_SECS`。
///
/// **真实流量的结果盖过探测的结论。** 探测是合成的：它拿一个模型发一句话，
/// 20 秒不回就判死（`PROBE_TIMEOUT_SECS`）。可 20 秒超时和「这个出口打不通」
/// 根本是两件事 —— 线上实测「梦幻API」三个出口探测全部 20001ms 判死，同一天
/// 它接了 241 次真实请求并且都成功了。而它们恰好是最便宜的几个（进价系数
/// 0.15 / 0.24，还活着的那些是 0.6），于是多路由省钱的效果基本没兑现。
///
/// 所以只要**新鲜的真实结果**在，就按真实结果排：最近一次是成功 → 最好档，
/// 最近一次是失败 → 最差档。真实失败同样算数 —— 只认成功的话，出口一失败被埋
/// 就再也拿不到流量、也就再也刷新不了成功记录，永远埋着。
pub fn availability_tier(
    probe_ok: Option<bool>,
    probe_at: Option<chrono::DateTime<chrono::Utc>>,
    last_ok_at: Option<chrono::DateTime<chrono::Utc>>,
    last_fail_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> u8 {
    // 真实结果和探测结论用同一把保质期的尺：过期的真实成功也不算数。
    let fresh_real = |t: Option<chrono::DateTime<chrono::Utc>>| {
        t.filter(|t| now.signed_duration_since(*t).num_seconds() <= PROBE_FRESH_SECS)
    };
    match (fresh_real(last_ok_at), fresh_real(last_fail_at)) {
        // 两边都有：听**较晚**的那个 —— 它才是这个出口现在的样子。
        (Some(ok), Some(fail)) => return if ok >= fail { 0 } else { 2 },
        (Some(_), None) => return 0,
        (None, Some(_)) => return 2,
        // 没有真实流量可依据（新出口、或者太久没人走）→ 照旧看探测。
        (None, None) => {}
    }
    match probe_ok {
        Some(false) => 2,
        None => 1,
        Some(true) => {
            let fresh = probe_at
                .map(|t| now.signed_duration_since(t).num_seconds() <= PROBE_FRESH_SECS)
                // 测通了却没记时间：当成新鲜。这一列是后加的，老行没有它，
                // 把老行一律打成「不新鲜」等于在升级那一刻把所有出口降一档。
                .unwrap_or(true);
            if fresh {
                0
            } else {
                1
            }
        }
    }
}

/// 这个出口是不是**慢得离谱**。`best_ms` 是同一条线路上还活着的候选里最快的那个。
///
/// 没有 `probe_ms`（没测过、或者线路自带地址根本不在这张表里）→ **不降级**。
/// 没有证据不构成降级理由，这和上面那一档是同一条规矩。
pub fn is_egregiously_slow(ms: Option<i32>, best_ms: Option<f64>) -> bool {
    let (Some(ms), Some(best)) = (ms, best_ms) else {
        return false;
    };
    let ms = ms as f64;
    ms >= SLOW_FLOOR_MS && best > 0.0 && ms >= SLOW_FACTOR * best
}

/// 线路自带地址的排序键。
///
/// 它不能走 `order_key(None, 1.0)`。那样它会永远停在「还没测过」那一档 —— 这张表里
/// 没有它的行，探测结论无处可存，所以它**结构上**升不到第 0 档。后果是：加一个原价的
/// 备用中转，只要它测通，就会把直连整个顶掉 —— 同样的价钱，凭空多一跳、多一个第三方。
///
/// 直连是**在任的那个**，不是一个待评估的候选：今天所有流量都从它走。所以它按第 0 档算，
/// 和同价位测通的出口打平，稳定排序让它留在前面；真比它便宜的出口照样越过它。
///
/// 这不违反「没有证据不报绿」—— 那条规矩管的是面板和告警怎么**说**，不是先敲哪扇门。
/// 直连真坏了的时候，冷却、卡顿、连败那套（`route_goes_to_the_back`）会把它往后压，
/// 那走的是执行事实，比任何探测都硬。
pub fn own_order_key() -> (u8, u8, f64) {
    (0, 0, 1.0)
}

/// 这条线路**连同它的出口**一共能提供哪些模型。
///
/// 出口可以带来线路本身没有的模型：你新挂一个中转，它那儿多了两款货，那两款就该出现在
/// IDE 的模型列表里。所以这里是**并集**，不是线路自己那一份。
///
/// 但有一条闸：能不能开放给用户，还要看这个模型**算不算得出价格**（见 `priceable`）。
/// 算不出价格的模型如果开放出去，用户被扣 0、上游照收你的钱 —— 那不是功能，是漏洞。
pub fn effective_models(route: &Model, outlets: &[Endpoint]) -> Vec<String> {
    let mut all = crate::models::allowed_ids(route);
    for e in outlets.iter().filter(|e| e.active) {
        for m in &e.enabled_models {
            if !all.iter().any(|x| x == m) {
                all.push(m.clone());
            }
        }
    }
    all
}

/// 出口带来的模型 → 带来它的出口（备注，没备注就用地址的主机名）。
///
/// 只算在轮转里的出口，和 `effective_models` 同一口径：停用的出口带不来任何模型。
pub fn carried_by(route: &Model, outlets: &[Endpoint]) -> serde_json::Value {
    let own = crate::models::allowed_ids(route);
    let mut map = serde_json::Map::new();
    for e in outlets.iter().filter(|e| e.active) {
        let who = if e.label.trim().is_empty() { host_of(&e.base_url) } else { e.label.trim().to_string() };
        for m in &e.enabled_models {
            if own.iter().any(|x| x == m) {
                continue;
            }
            let entry = map.entry(m.clone()).or_insert_with(|| serde_json::Value::Array(Vec::new()));
            if let Some(arr) = entry.as_array_mut() {
                if !arr.iter().any(|v| v.as_str() == Some(&who)) {
                    arr.push(serde_json::Value::String(who.clone()));
                }
            }
        }
    }
    serde_json::Value::Object(map)
}

fn host_of(url: &str) -> String {
    let s = url.trim();
    let s = s.split("://").nth(1).unwrap_or(s);
    s.split('/').next().unwrap_or(s).to_string()
}

/// 线路上取消勾选了某个模型之后，这个出口的名单该变成什么。
///
/// `None` = 不用动：名单本来就是空（空 = 跟线路，线路那边已经改了），或者它本来就不带这个模型。
/// `orphaned` = 拿掉之后一个都不剩。**不能**存成空名单 —— 空的意思是「跟线路」，
/// 而这个出口之前明明只承载那几款，跟线路等于把它没有的货派给它撞 404。这时停用它，
/// 备注里写明为什么，运维在「多路由」里看得见。
pub struct Retire {
    pub remaining: Vec<String>,
    pub orphaned: bool,
}

pub fn retire_from_outlet(enabled: &[String], retired: &[String]) -> Option<Retire> {
    if enabled.is_empty() {
        return None;
    }
    let remaining: Vec<String> = enabled.iter().filter(|m| !retired.contains(m)).cloned().collect();
    if remaining.len() == enabled.len() {
        return None;
    }
    Some(Retire { orphaned: remaining.is_empty(), remaining })
}

/// 线路那页取消勾选的模型，从这条线路的每个出口上也拿掉。返回改了几个出口。
pub async fn retire_models(
    state: &AppState,
    route_id: uuid::Uuid,
    retired: &[String],
) -> Result<usize, AppError> {
    if retired.is_empty() {
        return Ok(0);
    }
    let eps: Vec<(uuid::Uuid, Vec<String>, String)> = sqlx::query_as(
        "SELECT id, enabled_models, note FROM route_endpoints WHERE route_id = $1",
    )
    .bind(route_id)
    .fetch_all(&state.db)
    .await?;
    let mut touched = 0usize;
    for (id, enabled, note) in eps {
        let Some(r) = retire_from_outlet(&enabled, retired) else {
            continue;
        };
        if r.orphaned {
            let note = if note.trim().is_empty() {
                "线路已不再开放它承载的模型，自动停用".to_string()
            } else {
                format!("{note} · 线路已不再开放它承载的模型，自动停用")
            };
            sqlx::query(
                "UPDATE route_endpoints SET enabled_models = '{}', active = false, note = $2 WHERE id = $1",
            )
            .bind(id)
            .bind(&note)
            .execute(&state.db)
            .await?;
        } else {
            sqlx::query("UPDATE route_endpoints SET enabled_models = $2 WHERE id = $1")
                .bind(id)
                .bind(&r.remaining)
                .execute(&state.db)
                .await?;
        }
        tracing::info!(route = %route_id, endpoint = %id, retired = ?retired, orphaned = r.orphaned, "出口名单随线路收缩");
        touched += 1;
    }
    Ok(touched)
}

/// 这个模型在这条线路上算不算得出价格。
///
/// 三条来源，任一条有就行：每模型覆盖 → 实时目录 → 线路自己的兜底价。
/// 三条都没有时 `compute_cost` 会算出 0 —— 用户一分不付，而上游照收你的钱。
/// 所以算不出价的模型**不开放**，宁可它不出现在列表里，也不能让它静默地白送。
pub fn priceable(route: &Model, model_id: &str) -> bool {
    let (mi, mo) = crate::models::model_price_override(&route.model_prices, model_id);
    if mi > 0.0 || mo > 0.0 {
        return true;
    }
    if crate::models::official_price(model_id).is_some() {
        return true;
    }
    // 线路兜底价。实测线上这几条都是 0，所以这一支基本等于「没有」，
    // 但配了的话就该认。
    route.input_price > 0.0 || route.output_price > 0.0
}

/// 把「线路」展开成「实际要发请求的出口」。
///
/// 每条线路自带的 `base_url` / `api_key` 也算一个出口，而且是**倍率 1.0 的那个**：
/// 它是原价直连，运维加的转卖出口只要倍率小于 1 就自动排到它前面。这样「不配任何多路由」
/// 与今天的行为完全一致 —— 一条线路展开成一个出口，顺序不变。
///
/// 展开出来的每一项都是线路本身的克隆，只换了 `base_url`、`api_key`，并记下
/// `endpoint_id`。所以价格、开放模型、协议、计费模式全部原样跟着线路走：
/// **换出口换不动账单**。
pub fn expand(
    routes: &[Model],
    by_route: &HashMap<uuid::Uuid, Vec<Endpoint>>,
    // 线路**自带地址**最近的成败数，键是线路 id。
    //
    // 它的成败记在 `route_attempt` 里、用的是 `health_id()`（自带地址 = 线路 id），
    // 而 `load_for_routes` 只连了出口那张表 —— 不单独取一次的话，自带地址永远是
    // 「没有样本」，也就永远算靠谱。而线上最初暴露这个问题的恰好就是它：
    // Grok 自带地址 73%，比同线路 99% 的出口还便宜，于是稳稳排第一、每四发废一发。
    own_rates: &HashMap<uuid::Uuid, (i64, i64)>,
    model_id: &str,
) -> Vec<Model> {
    let mut out = Vec::with_capacity(routes.len());
    for r in routes {
        // (排序键, 探测毫秒, 线路克隆)。
        //
        // 排序键三级：**能用 → 不慢 → 便宜**。多带一个 probe_ms 是因为「慢不慢」
        // 是**相对同线路最快的那个**说的，一个候选自己看不出来 —— 要等这一条线路
        // 的候选都收齐了才算得出。
        let now = chrono::Utc::now();
        let mut targets: Vec<((u8, u8, f64), Option<i32>, Model)> = Vec::new();

        // 线路自带的地址只在**它自己**有这个模型时才算候选。
        //
        // 出口能带来线路本身没有的模型（新挂的中转多了两款货）。那种模型的请求派给
        // 线路自带地址只会撞一个 404 —— 而每个请求只有两次机会，白撞一次就浪费掉一半。
        let own_has = model_id.is_empty()
            || crate::models::allowed_ids(r).iter().any(|x| x == model_id);
        // 线路自带的地址：在任的那个。见 own_order_key —— 同价位它留在前面，
        // 真便宜的出口才越得过它。
        let mut own = r.clone();
        own.endpoint_id = None;
        own.endpoint_label = String::new();
        own.endpoint_cost = Some(1.0);
        // 每个候选最近的真实成败次数，和 targets 一一对应（算成功率惩罚要它）。
        let mut rate_of: Vec<(i64, i64)> = Vec::new();
        if own_has {
            // 线路自带地址在 route_endpoints 表里没有行，探测结论无处可存，
            // 所以它没有 probe_ms —— 于是它永远不会被判「慢」。那是对的：
            // 没有证据不构成降级理由。
            //
            targets.push((own_order_key(), None, own));
            // 自带地址的成败从 `own_rates` 取（键是线路 id）。取不到才按「没有样本」
            // 算 —— 那是「没有证据」，不是「零成功」。
            rate_of.push(own_rates.get(&r.id).copied().unwrap_or((0, 0)));
        }

        for e in by_route.get(&r.id).into_iter().flatten() {
            if !e.active || e.base_url.trim().is_empty() {
                continue;
            }
            // 这个出口没有这个模型就别派给它。
            //
            // 转卖商之间的货不一样：同一条 Claude 线路的三个出口，可能只有一个真有 opus-5。
            // 不筛的话，opus-5 的请求会被派到没有它的出口上撞一个 404 —— 而每个请求只有
            // 两次机会（CHAT_UPSTREAM_MAX_ROUTES_WHEN_ANSWERED），这一撞就浪费掉一半。
            //
            // 空 = 承载线路的全部模型，也就是不填时和以前完全一样。
            // 空 = 承载**线路自己**开放的那些（不是并集 —— 别的出口带来的货，
            // 这个出口未必有）。非空 = 就这几款。
            let serves = if e.enabled_models.is_empty() {
                crate::models::allowed_ids(r).iter().any(|x| x == model_id)
            } else {
                e.enabled_models.iter().any(|x| x == model_id)
            };
            if !model_id.is_empty() && !serves {
                continue;
            }
            let mut m = r.clone();
            m.base_url = e.base_url.clone();
            // 协议是「这条线怎么说话」，可以和线路不同：官方直连走 Anthropic 原生，
            // 而最便宜的那批转卖往往只提供 OpenAI 兼容。
            if !e.protocol.trim().is_empty() {
                m.protocol = e.protocol.clone();
            }
            // 出口没填密钥就沿用线路的：同一家转卖商换个入口地址是常见配置，
            // 逼人把同一个密钥抄一遍只会抄错。
            if !e.api_key.trim().is_empty() {
                m.api_key = e.api_key.clone();
            }
            m.endpoint_id = Some(e.id);
            m.endpoint_label = e.label.clone();
            m.endpoint_cost = Some(e.cost_ratio);
            m.endpoint_capacity = e.capacity;
            targets.push((
                (
                    availability_tier(e.probe_ok, e.probe_at, e.last_ok_at, e.last_fail_at, now),
                    0, // 可靠性档，等候选收齐（拿到成败数）再填
                    e.cost_ratio,
                ),
                effective_ms(e.real_ttfb_ms(), e.real_n, e.probe_ms),
                m,
            ));
            rate_of.push((e.real_ok.unwrap_or(0), e.real_bad.unwrap_or(0)));
        }

        // 快慢这一维必须在**候选收齐之后**才算得出来，因为它是相对的：
        // 快慢只有拿同一条线路上最快的那个当基准才有意义。
        //
        // 基准只取还活着的候选（tier < 2）：一个已知打不通的出口的耗时没有意义，
        // 拿它当基准会让所有人显得「不慢」。
        //
        // 用的是 `effective_ms`：有足够真实样本就是真实首字延迟，没有才退回探测。
        // 基准和被比的那个必须同源，否则是拿真实首字去比探测耗时 —— 两把尺。
        let best_ms = targets
            .iter()
            .filter(|((tier, _, _), _, _)| *tier < 2)
            .filter_map(|(_, ms, _)| ms.map(|v| v as f64))
            .filter(|v| *v > 0.0)
            .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |a: f64| a.min(v))));

        // 跨中转比价：把「相对官方价的倍数」换成「每一美元官方价实际花多少人民币」。
        //
        // 倍率只在同一家中转内部可比 —— 它的单位是那家中转的余额单位，而一块钱余额
        // 值多少人民币各家差几十倍。线上就有这个形状：梦幻API 的出口 0.05 倍、
        // hanhegufei 的自带地址 1.0 倍，看倍率是二十倍差距，换算之后完全可能反过来。
        //
        // **全有全无**：只要有一个候选的站没填汇率，整条线路退回按倍率排（＝旧行为）。
        // 把没填的当成 1.0 顶上去是最糟的选择 —— 那会让一个纯粹「没填」的站
        // 凭空排到前面，而且没有任何地方会报错。这和「没查到 ≠ 没有」是同一条规矩。
        //
        // endpoint_cost 一起换：它唯一的去处是 `overflow_weight`（首选被限流时挑替补
        // 的权重），那也是一个跨出口的比较，同样不能拿两种货币比。
        let converted: Option<Vec<f64>> = targets
            .iter()
            .map(|(k, _, m)| {
                crate::relay_rates::usd_per_cny(&m.base_url)
                    .and_then(|r| crate::relay_rates::cny_per_official_usd(k.2, r))
            })
            .collect();
        if let Some(cny) = converted.filter(|v| !v.is_empty()) {
            for ((k, _, _), c) in targets.iter_mut().zip(cny) {
                k.2 = c;
            }
        }

        // 最后一步：把「进价」换成**综合得分**（进价 × 成功率惩罚 × 慢惩罚）。
        //
        // 换算必须在这之后做，因为得分是拿换算后的人民币成本当底的 —— 倍率跨站不可比。
        // 上面那段换算已经把 k.2 变成「每一美元官方价花多少人民币」了。
        for ((k, ms, m), rates) in targets.iter_mut().zip(rate_of.iter()) {
            let (ok, bad) = *rates;
            // 中间那一位现在是**可靠性档**：不靠谱的整体排到靠谱的后面，价钱再便宜也不行。
            // 它替掉了原来那个二值的「慢」—— 快慢已经并进得分里，而「稳不稳」
            // 是用户真正能感觉到的那一维，值得单占一级。
            k.1 = u8::from(!is_reliable(ok, bad));
            k.2 = endpoint_score(k.2, ok, bad, *ms, best_ms);
            // endpoint_cost 是给 `overflow_weight`（首选被限流时挑替补）用的，
            // 那也是一次跨出口比较，得用同一把尺，否则两处对「谁更划算」的判断会打架。
            m.endpoint_cost = Some(k.2);
        }

        // 稳定排序：得分相同时保持「线路自带的在前、其余按建立次序」，
        // 免得每次请求随机换一个出口 —— 那会把上游的提示词缓存全部打散。
        targets.sort_by(|a, b| {
            a.0 .0
                .cmp(&b.0 .0) // 还活着的在前（真死的排最后）
                .then(a.0 .1.cmp(&b.0 .1)) // 靠谱的在前
                .then(a.0 .2.partial_cmp(&b.0 .2).unwrap_or(std::cmp::Ordering::Equal)) // 得分小的在前
        });
        out.extend(targets.into_iter().map(|(_, _, m)| m));
    }
    out
}

// ---------------------------------------------------------------- 分配

/// 粘性键：同一个用户（同一段对话）稳定地映射到同一个出口。
///
/// # 为什么必须带 uid，而且带盐
///
/// 这个键只在**溢出**时用（首选出口被限流了，得挑一个替补）。它要满足两件事：
/// 同一段对话每次挑到同一个替补（否则每换一次出口，上游那份提示词缓存就全部重来，
/// 而那笔钱是**用户**在付 —— `effective_cache_prices` 把缓存折扣直接算进了用户账单）；
/// 不同用户挑到不同替补（否则替补立刻变成下一个热点）。
///
/// 阶梯：会话 id → run id → 只有 uid。**每一级都掺 uid**，因为 run id 是客户端给的，
/// 不掺的话两个用户可以撞同一个键、被钉在同一个出口上。
///
/// 掺服务端盐：不掺的话，任何持 API key 的人都能离线枚举 run id，把自己钉在最便宜的
/// 出口上。收益不大但成本更小，掺上。
///
/// **不复用 `openai_prompt_cache_key`**：那个函数在没有 run id 时退回「模型 + 首条 system」，
/// 键里根本没有 uid —— 拿它做分配会把所有用户的同类请求钉在同一个出口上，
/// 正好是这里要避免的事。
pub fn sticky_key(uid: &uuid::Uuid, scopes: &[Option<&str>], secret: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(secret);
    h.update([0u8]);
    h.update(uid.as_bytes());
    // 第一个通过归一化的 scope 胜出；一个都没有就只用 uid。
    for (level, scope) in scopes.iter().enumerate() {
        if let Some(v) = scope.and_then(|v| normalise_scope(v)) {
            h.update([0u8, level as u8 + 1]);
            h.update(v.as_bytes());
            break;
        }
    }
    h.finalize().into()
}

/// 客户端给的 scope 得先洗一遍。
///
/// 客户端那道白名单不合法时是**静默不发**，所以网关不能假设收到的一定合法 ——
/// 一个带空格或超长的值混进哈希，效果等同于「这个用户每次都换一个键」，粘性直接失效。
fn normalise_scope(v: &str) -> Option<&str> {
    let t = v.trim();
    let ok = (8..=128).contains(&t.len())
        && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then_some(t)
}

/// 溢出时每个出口该分到多少。**只看进价，不看健康。**
///
/// 健康信号（探测结论、连败、冷却、卡顿）一律不进权重，全部留在选完之后那道重排里。
/// 理由是那些信号都是**阶跃**的：探测是单样本 0/1、`classify` 是四值词、进程内的记号
/// 在发版后全空。把阶跃量折进连续权重，一次抖动就会让过半在途对话集体迁走，
/// 而这正是粘性要防的事。排除坏出口是排除，不是降权。
///
/// γ 取 2 而不是更大：溢出集合里最便宜那个已经被摘掉了，剩下的价差本来就小；
/// γ 太大会退化成「第二便宜的吃全部」，也就是把雪崩推到下一跳。
pub fn overflow_weight(cost_ratio: f64, capacity: f64) -> f64 {
    const GAMMA: f64 = 2.0;
    const MIN: f64 = 1e-6;
    if !cost_ratio.is_finite() || cost_ratio <= 0.0 || !capacity.is_finite() || capacity <= 0.0 {
        return MIN;
    }
    let w = capacity * (1.0 / cost_ratio).powf(GAMMA);
    if w.is_finite() && w > MIN {
        w
    } else {
        MIN
    }
}

/// 把一池出口的容量补齐：没填的按**已填里的最小值**算，全没填就一律 1。
///
/// 不补的话会出一个很难查的错：一个填了 600（RPM）、一个没填按 1 算，
/// 后者拿到的溢出是前者的六百分之一 —— 运维只是"没填"，却等于把那个出口关掉了。
///
/// 补成最小值是保守方向：不知道能扛多少，就当它是最不能扛的那个。反过来（补成最大）
/// 会让一个没人填过的出口吃掉全部溢出，而那正是容量这一列想避免的事。
pub fn fill_capacities(declared: &[Option<f64>]) -> Vec<f64> {
    let floor = declared
        .iter()
        .filter_map(|c| c.filter(|v| v.is_finite() && *v > 0.0))
        .fold(f64::INFINITY, f64::min);
    let floor = if floor.is_finite() { floor } else { 1.0 };
    declared
        .iter()
        .map(|c| match c {
            Some(v) if v.is_finite() && *v > 0.0 => *v,
            _ => floor,
        })
        .collect()
}

/// 加权 rendezvous：在幸存出口里稳定地挑一个，命中概率正比于权重。
///
/// 用 `w / -ln(u)` 这个形式（u 是 (0,1) 上的均匀量），它的最大值恰好以 wᵢ/Σw 的概率
/// 落在第 i 个 —— 这是加权 rendezvous 的标准构造。
///
/// 它比「按权重划分区间」多一条要紧的性质：**集合变化时扰动最小**。移走一个出口，
/// 只有原本落在它上面的那些对话会重新分配，其余一个都不动 —— 而按区间划分会让所有人
/// 集体平移，也就是所有人的缓存同时作废。
///
/// 哈希必须是 SHA-256，不能用 `DefaultHasher`：Rust 保留跨版本换算法的权利，
/// 换一次全网粘性静默清零，而且不报错。
pub fn hrw_pick(key: &[u8; 32], set: &[(uuid::Uuid, f64, f64)]) -> Option<usize> {
    use sha2::{Digest, Sha256};
    let mut best: Option<(f64, uuid::Uuid, usize)> = None;
    for (i, (id, cost, cap)) in set.iter().enumerate() {
        let mut h = Sha256::new();
        h.update(key);
        h.update(id.as_bytes());
        let d: [u8; 32] = h.finalize().into();
        // 取高 53 位映射到 (0,1)：+0.5 保证严格大于 0，-ln(u) 因而不会是 inf。
        let bits = u64::from_be_bytes(d[..8].try_into().unwrap()) >> 11;
        let u = (bits as f64 + 0.5) / (1u64 << 53) as f64;
        let score = overflow_weight(*cost, *cap) / -u.ln();
        // 分数相同时按 uuid 定，保证同一份输入永远得到同一个答案。
        let better = match best {
            None => true,
            Some((bs, bid, _)) => score > bs || (score == bs && *id > bid),
        };
        if better && score.is_finite() {
            best = Some((score, *id, i));
        }
    }
    // 全部非有限（理论上到不了，overflow_weight 有下限）时退回第一个，绝不返回空。
    best.map(|(_, _, i)| i).or(if set.is_empty() { None } else { Some(0) })
}

/// 取一批线路的出口，按 `route_id` 分好。
/// 线路**自带地址**最近的成败数，键是线路 id。窗口和出口那边逐字一致：
/// 今天，样本不够退回 7 天。
///
/// 单独一次查询而不是并进 `load_for_routes`：那个查的是 route_endpoints，
/// 自带地址在那张表里根本没有行。
pub async fn load_own_rates(
    db: &sqlx::PgPool,
    route_ids: &[uuid::Uuid],
    // 只统计这个模型的成败。`None` = 全模型合计（给没有单一模型语境的调用方）。
    //
    // **加这一位是在修一个正在花钱的 bug。** `route_attempt` 按
    // (day, endpoint_id, model_id) 分行（写入见 route_health.rs 的 ON CONFLICT），
    // 而这里原来 `GROUP BY endpoint_id` 把模型维整个丢掉了 —— 于是一个出口在**别的
    // 模型**上的战绩，决定了它在**这个模型**上要不要被跳过、要不要被判不可靠、
    // 要不要吃最多 5 倍的价格惩罚。
    //
    // 2026-09-01 线上实测 deepseek 线路（查的是 deepseek-v4-flash）：
    //     出口        进价   合并口径   该模型真值
    //     梦幻API     0.24   0/13       67/88  (76%)
    //     OHub        0.6    0/12       98/112 (88%)
    //     mixtoken    1.0    12/26      4/4
    //     teamorouter 1.0    226/245    554/571
    // 两个**最便宜且在这个模型上工作良好**的出口被判成「试过、从来没成过」，起因是
    // deepseek-v4-pro 当天撞的 404。流量被推给贵 4 倍的那两个。
    //
    // 更隐蔽的一层：SQL 里「今天样本 >= 8 就只看今天」的那个总数原来也是跨模型合计的，
    // 所以某个模型当天猛失败会把整个出口切成「只看今天」，把被查模型自己 7 天的成功
    // 记录整段丢掉 —— 合并不只是掩盖，它还会**诬告**。
    //
    // 查不到这个模型的行时结果是**没有样本**（不是退回全模型合计）：本文件一以贯之的
    // 规矩是「没有证据不构成降级理由」，而退回合计等于把要修的污染又请回来。代价是
    // 冷门模型的降级会比现在迟钝一些 —— 那一侧的兜底是探测（探测是按出口的，
    // 「这个出口还活着吗」照样答得出）。
    model_id: Option<&str>,
) -> HashMap<uuid::Uuid, (i64, i64)> {
    if route_ids.is_empty() {
        return HashMap::new();
    }
    let rows: Vec<(uuid::Uuid, i64, i64)> = sqlx::query_as(
        "SELECT endpoint_id, \
                CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                     THEN COALESCE(SUM(ok_calls) FILTER (WHERE day = current_date), 0)::bigint \
                     ELSE COALESCE(SUM(ok_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                END, \
                CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                     THEN COALESCE(SUM(fail_calls) FILTER (WHERE day = current_date), 0)::bigint \
                     ELSE COALESCE(SUM(fail_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                END \
         FROM route_attempt WHERE endpoint_id = ANY($1) \
           AND ($2::text IS NULL OR model_id = $2) GROUP BY endpoint_id",
    )
    .bind(route_ids)
    .bind(model_id)
    .fetch_all(db)
    .await
    .unwrap_or_else(|e| {
        // 取不到就当没有样本 —— 也就是不罚。缺证据不构成降级理由，
        // 而让整轮派单失败的代价比少一个惩罚大得多。
        tracing::warn!(error = %e, "自带地址成败数读取失败，本轮不按成功率降级");
        Vec::new()
    });
    rows.into_iter().map(|(id, ok, bad)| (id, (ok, bad))).collect()
}

/// 全模型合计。给没有单一模型语境的调用方（后台列表、对账、同步、清单核对）。
///
/// **派单路径别用这个** —— 用 [`load_for_routes_for_model`]，理由见 [`load_own_rates`]
/// 的注释：合并跨模型的成败会让一个出口在别的模型上的战绩决定它在这个模型上的命运。
pub async fn load_for_routes(
    db: &sqlx::PgPool,
    route_ids: &[uuid::Uuid],
) -> HashMap<uuid::Uuid, Vec<Endpoint>> {
    load_for_routes_for_model(db, route_ids, None).await
}

/// 同上，但成败数/首字延迟/最近成败时刻只统计 `model_id` 这一个模型。
pub async fn load_for_routes_for_model(
    db: &sqlx::PgPool,
    route_ids: &[uuid::Uuid],
    model_id: Option<&str>,
) -> HashMap<uuid::Uuid, Vec<Endpoint>> {
    if route_ids.is_empty() {
        return HashMap::new();
    }
    let rows: Vec<Endpoint> = sqlx::query_as(
        // 连 route_attempt 是为了把「最近一次真实成功／失败」带出来给排序用。
        // 那张表按 (天, 出口, 模型) 分行；`$2` 非空时只统计那一个模型 —— 派单必须走
        // 这一支，理由见 `load_own_rates` 上面那段（跨模型合并会让一个出口在别的模型
        // 上的战绩决定它在这个模型上的命运，实测正在把最便宜且可用的出口挤掉）。
        // LEFT JOIN 保证没有流量记录的出口照样出现 —— 缺证据不构成排除理由。
        //
        // `MAX(last_ok_at)/MAX(last_fail_at)` 同样跟着 $2 收窄：它们喂的是排序**第一键**
        // `availability_tier`，跨模型取最大等于拿别的模型的成败给这个模型定档。
        "SELECT e.*, a.last_ok_at, a.last_fail_at, a.real_sum, a.real_n, a.real_ok, a.real_bad FROM route_endpoints e \
         LEFT JOIN (SELECT endpoint_id, MAX(last_ok_at) AS last_ok_at, \
                           MAX(last_fail_at) AS last_fail_at, \
                           COALESCE(SUM(ttfb_ms_sum) FILTER (WHERE day >= current_date - 6), 0)::bigint AS real_sum, \
                           COALESCE(SUM(ttfb_ms_n)   FILTER (WHERE day >= current_date - 6), 0)::bigint AS real_n, \
                           -- 成功率的窗口是「今天，样本不够退回 7 天」：一天一刷，
                           -- 昨天的坏运气不压着今天；而流量稀的出口也不会因为样本太少
                           -- 被一两次失败判死。判据 MIN_RATE_SAMPLES 在 Rust 那边。
                           CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                                THEN COALESCE(SUM(ok_calls) FILTER (WHERE day = current_date), 0)::bigint \
                                ELSE COALESCE(SUM(ok_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                           END AS real_ok, \
                           CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                                THEN COALESCE(SUM(fail_calls) FILTER (WHERE day = current_date), 0)::bigint \
                                ELSE COALESCE(SUM(fail_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                           END AS real_bad \
                    FROM route_attempt \
                    WHERE ($2::text IS NULL OR model_id = $2) \
                    GROUP BY endpoint_id) a ON a.endpoint_id = e.id \
         WHERE e.route_id = ANY($1) AND e.active = true \
         ORDER BY e.cost_ratio, e.created_at",
    )
    .bind(route_ids)
    .bind(model_id)
    .fetch_all(db)
    .await
    .unwrap_or_else(|e| {
        // 取不到出口不该让请求失败：退回「只用线路自带的地址」就是今天的行为。
        // 多路由是加成，不是依赖。
        tracing::warn!(error = %e, "route_endpoints 读取失败，本轮只用线路自带地址");
        Vec::new()
    });
    let mut map: HashMap<uuid::Uuid, Vec<Endpoint>> = HashMap::new();
    for r in rows {
        map.entry(r.route_id).or_default().push(r);
    }
    map
}

// ---------------------------------------------------------------- 观测

/// 记一次出口用量。**火后不管**：丢几条对看板毫无影响，而阻塞一次真实回答的代价是实打实的。
///
/// 归属用 `health_id`（出口，或线路自带地址），和计费的 `model_id`（线路）刻意分开 ——
/// 计费归属换不得，那会让用量静默记成 NULL。
pub fn note_endpoint_usage(
    state: &AppState,
    endpoint_id: uuid::Uuid,
    route_id: uuid::Uuid,
    // 模型名（`claude-opus-5` 这种），**不是线路 id**。真实成本是 token × 该模型的
    // 单价，而同一个出口上不同模型的单价能差两个量级 —— 没有这一维，混在一起的
    // 总 token 乘任何一个单价都得不到真数。
    model: &str,
    cost_cents: i64,
    // 直接收三个数，不收计费那边的内部类型 —— 观测不该有能力碰到计费的结构。
    prompt: i64,
    completion: i64,
    cached: i64,
    // 写进缓存的 token。**成本大头，而且以前根本没记。**上游按输入价的 1.25 倍收它，
    // 实测一次调用里它能是新鲜输入的一百六十倍（381 vs 61,634）。不记的话对账
    // 只能把它当 0 —— 「中转收了」低估、毛利高估，而且缓存命中率越高错得越多。
    cache_creation: i64,
    // `prompt` 含不含 `cached`。**只有收到回执的那一刻知道**，事后从数字反推不出来
    // （cached < prompt 时两种形状完全同形）。不带过来的话，对账只能硬夹一刀
    // `min(cached, prompt)`，把 Anthropic 那边超出的缓存读整段丢掉 —— 成本单向低估。
    prompt_includes_cached: bool,
) {
    let db = state.db.clone();
    // 分转微美元。看板要看得见「三分钱」这种量级，按分存会全是 0。
    let micro = cost_cents.max(0).saturating_mul(10_000);
    let model = model.to_string();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO endpoint_usage \
               (day, endpoint_id, route_id, calls, cost_micro_usd, \
                prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens) \
             VALUES (current_date, $1, $2, 1, $3, $4, $5, $6, $7) \
             ON CONFLICT (day, endpoint_id) DO UPDATE SET \
               calls = endpoint_usage.calls + 1, \
               cost_micro_usd = endpoint_usage.cost_micro_usd + EXCLUDED.cost_micro_usd, \
               prompt_tokens = endpoint_usage.prompt_tokens + EXCLUDED.prompt_tokens, \
               completion_tokens = endpoint_usage.completion_tokens + EXCLUDED.completion_tokens, \
               cached_tokens = endpoint_usage.cached_tokens + EXCLUDED.cached_tokens, \
               cache_creation_tokens = endpoint_usage.cache_creation_tokens \
                 + EXCLUDED.cache_creation_tokens, \
               updated_at = now()",
        )
        .bind(endpoint_id)
        .bind(route_id)
        .bind(micro)
        .bind(prompt)
        .bind(completion)
        .bind(cached)
        .bind(cache_creation)
        .execute(&db)
        .await;

        // 同一批数字再按模型分开记一份。对账要按模型乘单价，健康面板要按出口求和 ——
        // 两种问法，一个来源。分两张表而不是让健康面板改查这张：那块屏幕在正常工作，
        // 而且旧表有历史，为一个新报表去动它不划算（这一段的代价只是一次 upsert）。
        if !model.is_empty() {
            // **不吞错误。** 这条写失败的话，对账页的真实成本会永远没有数据源，
            // 而表现只是「那一页没有数」—— 和「还没有流量」长得一模一样。
            // 今天就因为这个把一次「还没跑过流量」误判成「写不进去」。
            let r = sqlx::query(
                "INSERT INTO endpoint_model_usage \
                   (day, endpoint_id, route_id, model_id, calls, revenue_micro_usd, \
                    prompt_includes_cached, \
                    prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens) \
                 VALUES (current_date, $1, $2, $3, 1, $4, $5, $6, $7, $8, $9) \
                 ON CONFLICT (day, endpoint_id, model_id) DO UPDATE SET \
                   calls = endpoint_model_usage.calls + 1, \
                   revenue_micro_usd = endpoint_model_usage.revenue_micro_usd + EXCLUDED.revenue_micro_usd, \
                   prompt_tokens = endpoint_model_usage.prompt_tokens + EXCLUDED.prompt_tokens, \
                   completion_tokens = endpoint_model_usage.completion_tokens + EXCLUDED.completion_tokens, \
                   cached_tokens = endpoint_model_usage.cached_tokens + EXCLUDED.cached_tokens, \
                   cache_creation_tokens = endpoint_model_usage.cache_creation_tokens \
                     + EXCLUDED.cache_creation_tokens, \
                   -- 一天一行会聚合多次调用。只要有一次是 Anthropic 形状就整行按
                   -- Anthropic 算（bool_and），和 models.rs 里那句
                   -- `COALESCE(bool_and(prompt_includes_cached), true)` 同一个口径。
                   -- 反过来会把混合情况判成「含缓存」，又回到低估成本那个方向。
                   prompt_includes_cached = \
                     COALESCE(endpoint_model_usage.prompt_includes_cached, true) \
                     AND EXCLUDED.prompt_includes_cached, \
                   updated_at = now()",
            )
            .bind(endpoint_id)
            .bind(route_id)
            .bind(&model)
            .bind(micro)
            .bind(prompt_includes_cached)
            .bind(prompt)
            .bind(completion)
            .bind(cached)
            .bind(cache_creation)
            .execute(&db)
            .await;
            if let Err(e) = r {
                tracing::warn!(error = %e, model = %model, "按模型用量写失败 —— 对账的真实成本会缺这一笔");
            }
        }
    });
}

/// 问一个中转「我还剩多少额度」。
///
/// # 没有标准，所以是尽力而为
///
/// 各家中转的余额接口互不相同，也没有任何一个标准。这里按三种线上最常见的形态各试一次：
///   · One API / New API 那一族（国内转卖用得最多）：`/api/user/self` → `quota`/`used_quota`
///   · OpenRouter：`/api/v1/auth/key` → `limit_remaining`
///   · OpenAI 官方那套：`/dashboard/billing/subscription`
///
/// **查不到就明确回「查不到」，绝不猜、绝不填 0。** 一个显示成 0 的余额会让人以为
/// 没钱了去充值，而实际可能只是这家没有这个接口 —— 报错的信息量为零，误导的代价却是真的。
/// 一次余额读数。
///
/// `text` 是给人看的，`remaining_usd` / `used_usd` 是给对账算的。两者必须同源 ——
/// 面板显示一个数、成本按另一个数算，是最难发现的一类错。
#[derive(Clone, Debug)]
pub struct BalanceReading {
    pub text: String,
    /// 还剩多少美元。None = 这家只给了「已用」或只给了上限。
    pub remaining_usd: Option<f64>,
    /// 累计已用多少美元。None = 这家不给。
    ///
    /// **算成本时优先用它**：余额会被充值打断（充一次就变成负成本），
    /// 而「已用」是单调递增的，充值不影响。
    pub used_usd: Option<f64>,
}

// 「问一个中转还剩多少额度」的实现**不在这里**。
//
// 它曾经在，而且和 relay_adapter 那份并存过一段时间 —— 两份对 sub2api 的做法不同，
// 于是同一批线路在「网关适配器」页有余额、在「健康」页显示「查不到」。
// 现在唯一的入口是 `relay_sync::balance_now`，它按识别出的家族分派。
//
// 要加一家新中转的余额支持，改 `relay_adapter::fetch_balance`，别在这里再开一份。

// ---------------------------------------------------------------- 调度

/// 下架的持久化前缀。和让位分开存：两者的恢复方式完全不同 ——
/// 让位是**到点自己回来**（时长由上游给），下架是**试通了才回来**（时长不知道）。
const DELIST_KEY_PREFIX: &str = "rh:delist:";
/// 下架状态在 Redis 里最多留多久。比最长退避（1 小时）长一截，
/// 但不能无限 —— 一个被删掉的出口不该在库里留一辈子。
const DELIST_TTL_SECS: i64 = 6 * 3600;

/// 调度器多久扫一轮。
///
/// 30 秒：最短的退避是 60 秒，扫得比它快一档就够，再快只是空转。
/// 它不发请求，只是看一眼有没有到点的 —— 到点了才去探。
const SCHEDULER_TICK: Duration = Duration::from_secs(30);

/// 把下架落一份到 Redis，发版后能承接。火后不管。
pub fn persist_delisting(state: &AppState, id: uuid::Uuid, why: crate::models::Delisted) {
    let mut conn = state.redis.clone();
    let word = why.word().to_string();
    tokio::spawn(async move {
        let key = format!("{DELIST_KEY_PREFIX}{id}");
        let _: Result<(), _> = redis::cmd("SET")
            .arg(&key)
            .arg(&word)
            .arg("EX")
            .arg(DELIST_TTL_SECS)
            .query_async(&mut conn)
            .await;
    });
}

async fn forget_delisting(state: &AppState, id: uuid::Uuid) {
    let mut conn = state.redis.clone();
    let _: Result<(), _> = redis::cmd("DEL")
        .arg(format!("{DELIST_KEY_PREFIX}{id}"))
        .query_async(&mut conn)
        .await;
}

/// 启动时承接上一个进程的下架名单。
///
/// 不承接的话，发版后第一批请求会把流量铺回一个明知道没额度的出口，
/// 每个都白烧一个来回 —— 而蓝绿切换那几秒正好是流量最集中的时候。
pub async fn restore_delisting(state: &AppState) {
    let mut conn = state.redis.clone();
    let mut cursor: u64 = 0;
    let mut n = 0usize;
    loop {
        let res: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{DELIST_KEY_PREFIX}*"))
            .arg("COUNT")
            .arg(200)
            .query_async(&mut conn)
            .await;
        let (next, keys) = match res {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "下架名单没读回来，本进程从空名单开始");
                return;
            }
        };
        for key in keys {
            let word: Option<String> = redis::cmd("GET").arg(&key).query_async(&mut conn).await.ok();
            let Some(id) = key
                .strip_prefix(DELIST_KEY_PREFIX)
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            else {
                continue;
            };
            let why = match word.as_deref() {
                Some("auth") => crate::models::Delisted::AuthRejected,
                Some("no_quota") => crate::models::Delisted::OutOfQuota,
                _ => continue,
            };
            crate::models::delist_endpoint(id, why);
            n += 1;
        }
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    if n > 0 {
        tracing::info!(delisted = n, "下架名单已从上一个进程承接");
    }
}

/// 调度器：什么时候该动什么。
///
/// # 它只管一件事：把下架的出口试回来
///
/// 别的状态都有自己的到期机制，不需要人管：
///   · **让位**（429）—— 上游在 Retry-After 里说了多久，到点自己回来；
///   · **冷却**（502/503/504）—— 20 秒后自然过期；
///   · **卡死** —— 120 秒记号 + 已有的 `spawn_stall_recovery` 探针，通了自己撤记号。
///
/// 只有**下架**不一样：没额度、密钥被拒，都不知道什么时候好，时间到了也不会自己好。
/// 所以只有这一种需要「定期去敲门」，也就是这个调度器存在的全部理由。
///
/// # 为什么用真请求去试，而不是等下一个用户去撞
///
/// 等用户撞的代价是：恢复判定由用户的请求付费（他多等一个来回），而且流量越少
/// 恢复越慢 —— 一个半夜充了钱的出口可能到早上才被发现能用。
/// 主动探一次只花个位数 token。
pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        // 起步先让服务起完；也避开部署瞬间那段状态刚承接完的窗口。
        tokio::time::sleep(Duration::from_secs(45)).await;
        let mut tick = tokio::time::interval(SCHEDULER_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = sweep_delisted(&state).await {
                tracing::warn!(error = %e, "下架恢复这一轮没跑完");
            }
        }
    });
}

async fn sweep_delisted(state: &AppState) -> anyhow::Result<()> {
    let due = crate::models::delisted_due(std::time::Instant::now());
    if due.is_empty() {
        return Ok(());
    }
    // 出口和线路一次性取回来，别在循环里逐个查库。
    let eps: Vec<Endpoint> = sqlx::query_as("SELECT * FROM route_endpoints")
        .fetch_all(&state.db)
        .await?;
    let routes: Vec<Model> = sqlx::query_as("SELECT * FROM models")
        .fetch_all(&state.db)
        .await?;
    let by_route: HashMap<uuid::Uuid, &Model> = routes.iter().map(|m| (m.id, m)).collect();
    let by_ep: HashMap<uuid::Uuid, &Endpoint> = eps.iter().map(|e| (e.id, e)).collect();

    for (id, why) in due {
        // id 可能是一个出口，也可能是线路自带的地址（health_id 两者共用一个命名空间）。
        let (route, base, key_raw, proto, only) = if let Some(e) = by_ep.get(&id) {
            let Some(r) = by_route.get(&e.route_id) else {
                // 线路没了 → 这条下架记录也没意义了。
                crate::models::relist_endpoint(id);
                forget_delisting(state, id).await;
                continue;
            };
            let k = if e.api_key.trim().is_empty() { &r.api_key } else { &e.api_key };
            (*r, e.base_url.clone(), k.clone(), e.protocol.clone(), e.enabled_models.clone())
        } else if let Some(r) = by_route.get(&id) {
            (*r, r.base_url.clone(), r.api_key.clone(), String::new(), Vec::new())
        } else {
            crate::models::relist_endpoint(id);
            forget_delisting(state, id).await;
            continue;
        };

        let out = probe_once(
            &probe_client(),
            route,
            &base,
            &crate::models::model_key(&key_raw),
            &proto,
            &only,
        )
        .await;
        if out.ok {
            crate::models::relist_endpoint(id);
            forget_delisting(state, id).await;
            tracing::info!(
                endpoint = %id,
                why = why.word(),
                ms = out.ms,
                "下架的出口试通了，已恢复"
            );
        } else {
            crate::models::defer_relist(id);
            tracing::info!(
                endpoint = %id,
                why = why.word(),
                note = %out.note,
                "下架的出口还是不通，退避加长"
            );
        }
        // 别把一堆探测同时打到同一家转卖商头上。
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(())
}

/// 让位状态的跨进程承接。
///
/// # 为什么要落 Redis，又为什么**不在派单路径读**
///
/// 让位状态活在进程内（一次哈希、一把短锁，派单路径上零 I/O，这是刻意的）。代价是
/// 发版后新进程那张表是空的 —— 它会把流量直接铺回一个可能还在限流窗口里的出口，
/// 撞一次 429 才重新学到。蓝绿切换那几秒正好是流量最集中的时候。
///
/// 所以写一份到 Redis（火后不管，不阻塞请求），**启动时读回来**一次。
/// 读只发生在启动，派单路径一个 await 都没加。
///
/// TTL 就设成让位时长本身：到期键自己没了，不需要任何人去清，也不会有陈旧值。
const SAT_KEY_PREFIX: &str = "rh:sat:";

/// 记一次让位到 Redis。调用方已经在进程内记过了，这里只管持久化，失败就算了 ——
/// 掉一次的后果是「发版后可能多撞一个 429」，不值得为它让用户的请求等。
pub fn persist_saturation(state: &AppState, id: uuid::Uuid, how_long: std::time::Duration) {
    let mut conn = state.redis.clone();
    let secs = how_long.as_secs().max(1) as i64;
    tokio::spawn(async move {
        let key = format!("{SAT_KEY_PREFIX}{id}");
        let _: Result<(), _> = redis::cmd("SET")
            .arg(&key)
            .arg(secs)
            .arg("EX")
            .arg(secs)
            .query_async(&mut conn)
            .await;
    });
}

/// 启动时把还没到期的让位读回进程内。
///
/// 用 SCAN 而不是 KEYS：KEYS 在大库上会阻塞整个 Redis，而这台机器上 Redis 还扛着
/// 会话和健康数据。这里的键最多几十个，SCAN 一轮就完。
pub async fn restore_saturation(state: &AppState) {
    let mut conn = state.redis.clone();
    let mut cursor: u64 = 0;
    let mut restored = 0usize;
    loop {
        let res: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(format!("{SAT_KEY_PREFIX}*"))
            .arg("COUNT")
            .arg(200)
            .query_async(&mut conn)
            .await;
        let (next, keys) = match res {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "让位状态没读回来，本进程从空表开始");
                return;
            }
        };
        for key in keys {
            // 剩余 TTL 才是真正还要让位多久 —— 存进去的那个时长早就走掉一截了。
            let ttl: Option<i64> = redis::cmd("TTL").arg(&key).query_async(&mut conn).await.ok();
            let Some(ttl) = ttl.filter(|t| *t > 0) else { continue };
            let Some(id) = key
                .strip_prefix(SAT_KEY_PREFIX)
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            else {
                continue;
            };
            crate::models::mark_endpoint_saturated(id, std::time::Duration::from_secs(ttl as u64));
            restored += 1;
        }
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    if restored > 0 {
        tracing::info!(restored, "让位状态已从上一个进程承接");
    }
}

// ---------------------------------------------------------------- 探测

/// 一次探测的结论。
pub struct ProbeOutcome {
    pub ok: bool,
    pub ms: i32,
    pub note: String,
}

/// 对一个出口发一次最小的真实请求。
///
/// `base_url` / `api_key` 由调用方给出（可能来自出口，也可能是线路自带的）。
///
/// `protocol` 空 = 跟线路一样。`only_models` 空 = 线路的全部 —— 探一个只有 sonnet 的
/// 出口时必须拿 sonnet 去探，拿线路的第一个模型（可能是 opus）去探会得到一个 404，
/// 然后把一个好出口判成坏的。
/// 这段响应体**真的是一次对话结果**吗，还是一个用 200 包起来的错误页。
///
/// # 为什么 2xx 不够
///
/// 转卖网关会用 200 包一个错误体，也会回空壳。model_probe.rs 里记着这条教训：
/// 拿「没报错」当「能用」会得出荒唐的结论。
///
/// # 为什么是 pub(crate)
///
/// 这个判据曾经只长在 `probe_once` 里，而 `route_health::canary_once` 打的是
/// **同一个地址、同一个模型、同一个密钥**，判成功却只看 `status().is_success()`。
/// 于是一个「200 + 错误体」的上游：出口页显示「回了 200 但不是对话响应」，
/// 而健康页、状态药丸和邮件告警把它记成一次成功、清零连败、点亮绿灯 ——
/// 正是这套监控要消灭的那件事，发生在它自己身上。
///
/// 判据只许有一份。要放宽或收紧改这里，两边一起变。
pub(crate) fn looks_like_a_real_completion(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|v| {
            v.get("content").is_some_and(|c| c.is_array())
                || v.get("choices").is_some_and(|c| c.is_array())
                || v.get("usage").is_some()
        })
}

/// SSE 的**第一帧**看着像不像一个真的对话流。
///
/// 和非流式那个是两种形状，不能混用：流式第一帧是 `data: {...}` 包着一个 delta
/// （OpenAI 系）或者 `event: message_start`（Anthropic 系），拿
/// `looks_like_a_real_completion` 去判它一律不通过。
///
/// 依然判形状而不是「有回应就算通」：转卖网关的错误页也会回 200，只认「有字节」
/// 的话那种站会被探成绿灯，然后接管真实流量、每一发都失败。
pub(crate) fn looks_like_a_real_stream(head: &str) -> bool {
    if head.contains("event: message_start") || head.contains("event: response.created") {
        return true;
    }
    head.split("data:").skip(1).any(|frame| {
        let line = frame.trim().lines().next().unwrap_or("").trim();
        // `[DONE]` 这一支是显式写出来的意图，不是承重墙：下面 JSON 解析失败后的
        // 兜底本来也挡得住它（变异测过，删掉这行测试不红）。留着是为了让「结束帧
        // 不算生成过内容」这件事在代码里看得见。
        if line.is_empty() || line.starts_with("[DONE]") {
            return false;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => {
                v.get("choices").is_some_and(|c| c.is_array())
                    || v.get("delta").is_some()
                    || v.get("type").is_some()
                    || v.get("usage").is_some()
            }
            // 第一个 chunk 不保证切在帧边界上，半截 JSON 解析不出来很正常。
            // 解析失败不等于假，退回认这几个键出现过。
            Err(_) => {
                line.contains("\"choices\"") || line.contains("\"delta\"") || line.contains("\"type\"")
            }
        }
    })
}

/// 流式探的结论：要么定了，要么这家压根不认流式、得退回非流式再试一遍。
enum StreamProbe {
    Decided(ProbeOutcome),
    Unsupported,
}

/// 发一个流式请求，只等**第一帧**，拿到就断开。
///
/// 超时单独用 `tokio::time::timeout` 圈住每一步，而不是靠 client 上的整体超时：
/// 整体超时管的是「整个响应读完」，那正是这里不想等的那段。
async fn probe_streaming(req: reqwest::RequestBuilder, started: std::time::Instant) -> StreamProbe {
    let ms = |s: std::time::Instant| s.elapsed().as_millis().min(i32::MAX as u128) as i32;
    let dur = std::time::Duration::from_secs(PROBE_TIMEOUT_SECS);

    let mut resp = match tokio::time::timeout(dur, req.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            // 连不上／TLS 坏了是**这个出口**的毛病，不是流式的毛病，就地定案。
            // 错误原文不能进 note：reqwest 的错误链会带完整 URL，查询串里可能有密钥。
            let why = if e.is_connect() {
                "连不上（域名或端口不对）".to_string()
            } else if e.is_timeout() {
                format!("超过 {PROBE_TIMEOUT_SECS} 秒没有回应")
            } else {
                "请求没发出去".to_string()
            };
            return StreamProbe::Decided(ProbeOutcome { ok: false, ms: ms(started), note: why });
        }
        Err(_) => {
            return StreamProbe::Decided(ProbeOutcome {
                ok: false,
                ms: ms(started),
                note: format!("超过 {PROBE_TIMEOUT_SECS} 秒没有回应"),
            })
        }
    };

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        // 这几个码有可能是「不认 stream 这个参数」，也有可能是请求体本身不对。
        // 分不出来，所以退回非流式再判一次，让原来那套给结论，不在这儿猜。
        if matches!(status, 400 | 404 | 422 | 501) {
            return StreamProbe::Unsupported;
        }
        let why = match status {
            401 | 403 => "密钥被拒（401/403）".to_string(),
            429 => "被限流（429）".to_string(),
            402 => "余额不足（402）".to_string(),
            500..=599 => format!("上游自己出错（{status}）"),
            _ => format!("上游返回 {status}"),
        };
        return StreamProbe::Decided(ProbeOutcome { ok: false, ms: ms(started), note: why });
    }

    // 攒到看得出形状为止。第一个 chunk 可能只是几个字节的心跳（有的网关先发一个
    // `: ping`），所以不能拿到一个 chunk 就下结论。上限保证不会把整段生成读完。
    let mut head = String::new();
    loop {
        match tokio::time::timeout(dur, resp.chunk()).await {
            Ok(Ok(Some(b))) => {
                head.push_str(&String::from_utf8_lossy(&b));
                if looks_like_a_real_stream(&head) {
                    return StreamProbe::Decided(ProbeOutcome {
                        ok: true,
                        ms: ms(started),
                        note: String::new(),
                    });
                }
                if head.len() > 8 * 1024 {
                    break;
                }
            }
            // 流走完了还没出现对话的形状 —— 回了 200 却不是 SSE，多半是转卖网关的
            // 错误页。这种最该拦：探绿之后它会接管真实流量，然后每一发都失败。
            Ok(Ok(None)) => break,
            Ok(Err(_)) => break,
            Err(_) => {
                return StreamProbe::Decided(ProbeOutcome {
                    ok: false,
                    ms: ms(started),
                    note: format!("超过 {PROBE_TIMEOUT_SECS} 秒没有回应"),
                })
            }
        }
    }

    // 200 但一帧对话形状都没有：如果它压根不是 SSE（比如回了一整个 JSON），
    // 那有可能只是这家不认 stream 参数、把它当普通请求处理了 —— 交给非流式那套
    // 去判，它认得完整响应的形状。
    if looks_like_a_real_completion(head.trim()) {
        return StreamProbe::Unsupported;
    }
    StreamProbe::Decided(ProbeOutcome {
        ok: false,
        ms: ms(started),
        note: "回了 200 但不是对话响应（可能是转卖网关的错误页）".into(),
    })
}

pub async fn probe_once(
    http: &reqwest::Client,
    route: &Model,
    base_url: &str,
    api_key_plain: &str,
    protocol: &str,
    only_models: &[String],
) -> ProbeOutcome {
    let started = std::time::Instant::now();
    let ms = |s: std::time::Instant| s.elapsed().as_millis().min(i32::MAX as u128) as i32;

    let pool: Vec<String> = if only_models.is_empty() {
        crate::models::allowed_ids(route)
    } else {
        only_models.to_vec()
    };
    let Some(model_id) = pool.into_iter().next() else {
        return ProbeOutcome {
            ok: false,
            ms: 0,
            note: "这条线路一个开放模型都没配，没有可探的模型".into(),
        };
    };

    // 出口协议覆盖线路协议；出口没填就跟线路。判据只此一处，URL 和请求体都从它来。
    let wire = crate::models::Wire::of(if protocol.is_empty() {
        &route.protocol
    } else {
        protocol
    });
    let anthropic = wire == crate::models::Wire::Anthropic;
    let base = crate::models::api_base(base_url);
    let url = format!("{base}{}", wire.path());
    // max_tokens 取 1：验的是「这条路通不通」，不是它会说什么。
    //
    // Responses 的最小请求体是**另一套名字**（input / max_output_tokens）。用
    // chat/completions 那套去探，上游要么 400 要么把这条从没验证过的出口探成绿灯——
    // 后者更糟：探绿之后它会被排到前面接管真实流量，然后每一发都失败。
    let body = match wire {
        crate::models::Wire::XaiResponses => serde_json::json!({
            "model": model_id,
            "max_output_tokens": 1,
            "input": [{ "role": "user", "content": "hi" }],
        }),
        _ => serde_json::json!({
            "model": model_id,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "hi" }],
        }),
    };

    let build = |body: &serde_json::Value| {
        let r = http.post(&url).json(body);
        if anthropic {
            r.header("x-api-key", api_key_plain)
                .header("anthropic-version", "2023-06-01")
        } else {
            r.header("authorization", format!("Bearer {api_key_plain}"))
        }
    };

    // **先流式探，只等第一帧。**
    //
    // 非流式探推理模型是探不出来的：`max_tokens: 1` 拦不住思考，模型要把整段思考
    // 走完才吐第一个字节，20 秒（`PROBE_TIMEOUT_SECS`）根本不够。线上实测「梦幻API」
    // 三个出口（探的是 gpt-5.6-sol / deepseek-v4-flash / claude-fable-5）全部卡在
    // 20001ms 判死，而同一天它接了 241 次真实请求全部成功 —— 探测在说假话，且假红的
    // 正好是最便宜的那几个出口，于是多路由该省的钱一分没省。
    //
    // 顺带让「多快」这个数变得有意义：量到的是首字延迟，就是用户真正等的那一段，
    // 而不是「生成完一整句要多久」。
    let mut streamed = body.clone();
    if let Some(o) = streamed.as_object_mut() {
        o.insert("stream".into(), serde_json::Value::Bool(true));
    }
    match probe_streaming(build(&streamed), started).await {
        StreamProbe::Decided(o) => return o,
        // 这家不认流式（有的转卖网关只转发非流式）。退回原来那套走一遍 ——
        // 拿「不支持流式」当「打不通」会把一个好出口判死。
        StreamProbe::Unsupported => {}
    }

    let resp = match build(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            // 连不上／超时／TLS 坏了。这里**不能**把错误原文塞进 note：reqwest 的错误链
            // 会带上完整 URL，而查询串里可能有人把密钥写在了地址上。
            let why = if e.is_timeout() {
                format!("超过 {PROBE_TIMEOUT_SECS} 秒没有回应")
            } else if e.is_connect() {
                "连不上（域名或端口不对）".to_string()
            } else {
                "请求没发出去".to_string()
            };
            return ProbeOutcome { ok: false, ms: ms(started), note: why };
        }
    };

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let elapsed = ms(started);

    if !(200..300).contains(&status) {
        let why = match status {
            401 | 403 => "密钥被拒（401/403）".to_string(),
            404 => format!("这家没有 {model_id}（404）"),
            429 => "被限流（429）".to_string(),
            402 => "余额不足（402）".to_string(),
            500..=599 => format!("上游自己出错（{status}）"),
            _ => format!("上游返回 {status}"),
        };
        return ProbeOutcome { ok: false, ms: elapsed, note: why };
    }

    let looks_real = looks_like_a_real_completion(&text);
    if !looks_real {
        return ProbeOutcome {
            ok: false,
            ms: elapsed,
            note: "回了 200 但不是对话响应（可能是转卖网关的错误页）".into(),
        };
    }
    ProbeOutcome { ok: true, ms: elapsed, note: String::new() }
}

fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// 探一个出口并把结论写回库。
async fn probe_and_store(state: &AppState, ep: &Endpoint, route: &Model) -> ProbeOutcome {
    let key = if ep.api_key.trim().is_empty() {
        crate::models::model_key(&route.api_key)
    } else {
        crate::models::model_key(&ep.api_key)
    };
    let out = probe_once(
        &probe_client(),
        route,
        &ep.base_url,
        &key,
        &ep.protocol,
        &ep.enabled_models,
    )
    .await;
    let _ = sqlx::query(
        "UPDATE route_endpoints SET probe_ok = $2, probe_at = now(), probe_ms = $3, \
         probe_note = $4, updated_at = now() WHERE id = $1",
    )
    .bind(ep.id)
    .bind(out.ok)
    .bind(out.ms)
    .bind(&out.note)
    .execute(&state.db)
    .await;
    out
}

/// 后台自动重测。
///
/// 只测「最近没有真实流量证明过」的出口：真实流量的结局比探测更准，也不花钱。
/// 这既省钱，也避免把探测流量算进上游的限流额度。
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 启动后先等一会儿：刚起来时迁移、连接池、缓存都在忙，探测不着急。
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        loop {
            if let Err(e) = sweep(&state).await {
                tracing::warn!(error = %e, "多路由自动探测这一轮没跑完");
            }
            tokio::time::sleep(std::time::Duration::from_secs(PROBE_EVERY_SECS)).await;
        }
    });
}

async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let eps: Vec<Endpoint> =
        sqlx::query_as("SELECT * FROM route_endpoints WHERE active = true ORDER BY created_at")
            .fetch_all(&state.db)
            .await?;
    if eps.is_empty() {
        return Ok(());
    }
    let routes: Vec<Model> = sqlx::query_as("SELECT * FROM models WHERE active = true")
        .fetch_all(&state.db)
        .await?;
    let by_id: HashMap<uuid::Uuid, Model> = routes.into_iter().map(|m| (m.id, m)).collect();

    let mut probed = 0usize;
    for ep in eps {
        let Some(route) = by_id.get(&ep.route_id) else {
            continue;
        };
        // 真实流量最近成功过就别浪费 token —— 那是比探测更硬的证据。
        let health = crate::route_health::snapshot(state, ep.id).await;
        let now = chrono::Utc::now().timestamp();
        if crate::route_health::classify(&health, now) == "ok" {
            continue;
        }
        probe_and_store(state, &ep, route).await;
        probed += 1;
        // 别把一堆探测同时打到同一家转卖商头上。
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
    if probed > 0 {
        tracing::info!(probed, "多路由自动探测完成");
    }
    Ok(())
}

/// 这条线路是哪家的模型，用来给后台挑一个厂商图标。
///
/// **判据是模型 id，不是 `provider` 列。** 线上实测那一列并不可靠：「免费智普」和「Grok」
/// 的 provider 都填的是 `other`，而它们的模型 id（`glm-5.3` / `grok-4.6`）一眼就能认出来。
/// `protocol` 更不能用 —— 它是传输协议，deepseek、智谱、Grok 三条线路都写着 `openai`。
///
/// 放服务端算而不是让前端猜：判据只有一份，改一次两边都对，而且能测。
/// 认不出来就回空串，前端画一个中性图标 —— 猜错一个厂商比不猜更糟。
///
/// # 次序就是判据
///
/// 这张表**从上往下**匹配，所以排在前面的必须更 specific。两处真实的坑：
///   · `claude` 要在 `bedrock` / `vertex` 前面 —— AWS 上的 id 是
///     `anthropic.claude-3-5-sonnet`，那确实是 Claude，画 Claude 的标才对；
///   · `gpt` 要靠后 —— 一堆转卖商会把别家模型起名成 `xxx-gpt-*`。
///
/// 短词一律不用（`yi`、`nova` 这种），它们会撞进别人的模型名里。宁可漏认一家画中性图标，
/// 也不能给智谱画上 OpenAI 的标。
pub fn vendor_of(provider: &str, models: &[String], base_url: &str) -> &'static str {
    let hay = format!(
        "{} {}",
        provider.to_ascii_lowercase(),
        models.join(" ").to_ascii_lowercase()
    );
    for (needle, vendor) in NEEDLES {
        if hay.contains(needle) {
            return vendor;
        }
    }
    // 手写表认不出来时，问**实时目录**。
    //
    // 目录里每个 id 都是 `厂商/模型` 的形状，那份映射每半小时刷新、覆盖四百多个模型 ——
    // 比上面那张 58 条的手写表宽得多。图标库有 149 家，而手写表只够触发其中 43 家；
    // 剩下 106 个图标一直躺在库里没人用得上，因为没有任何模型名能命中它们。
    //
    // 放在手写表**之后**：那张表里的次序是刻意的（claude 要在 bedrock 前面、gpt 要靠后），
    // 那些判断目录给不出来。目录只负责补它没覆盖到的那一大片。
    for m in models {
        let pref = crate::model_catalog::lookup(m)
            .map(|e| e.vendor)
            .filter(|v| !v.is_empty());
        let Some(pref) = pref else { continue };
        // 别名优先：`mistralai` 要变成 `mistral`。再直查：`nvidia` 这类本来就同名。
        if let Some((_, key)) = VENDOR_ALIASES.iter().find(|(from, _)| *from == pref) {
            return key;
        }
        if let Some(k) = ICON_KEYS.iter().find(|k| **k == pref) {
            return k;
        }
        // 目录知道它属于谁，但我们没有这家的图 —— 回空串走中性图标，
        // 而不是回一个画不出来的名字。继续看下一个模型。
    }

    // 模型名和目录都认不出来时，再看这条线路指向哪儿。
    //
    // 次序不能反：模型比管道重要。一条指向 openrouter 但跑 claude-opus 的线路该显示
    // Claude —— 运维想知道的是「这条线路卖的是谁家的模型」，不是「它从哪个中间商买的」。
    // 反过来，「牛来」那种自起名字的（stealth/ox-alpha）模型名什么都说明不了，
    // 这时它的地址 openrouter.ai 就是唯一有信息量的东西。
    let host = base_url.to_ascii_lowercase();
    for (needle, vendor) in HOSTS {
        if host.contains(needle) {
            return vendor;
        }
    }
    ""
}

/// 图标库里**确实有图**的全部厂商键，和 `ide/src/brand-sprite.js` 的 `BRANDS` 一一对应
/// （有测试守着，改一边不改另一边会红）。
///
/// 为什么服务端要留一份：`vendor_of` 回的是 `&'static str`，而目录给的厂商前缀是运行时
/// 字符串 —— 得在这张表里对上，才能变成一个静态引用。顺带它也是一道闸：目录里那些
/// 没有图的小微调作者（poolside、sao10k、undi95…）对不上，于是回空串、前端画中性图标，
/// 而不是回一个画不出来的名字。
const ICON_KEYS: &[&str] = &[
    "ai2", "ai21", "ai302", "ai360", "aihubmix", "akashchat", "alephalpha", "alibaba",
    "alibabacloud", "anspire", "anthropic", "anyscale", "apple", "arcee", "atlascloud", "aws",
    "azure", "azureai", "baai", "baichuan", "baidu", "baiducloud", "bailian", "baseten",
    "bedrock", "bfl", "bilibiliindex", "burncloud", "bytedance", "centml", "cerebras",
    "cloudflare", "codegeex", "cohere", "cometapi", "crusoe", "dbrx", "deepcogito", "deepinfra",
    "deepmind", "deepseek", "doubao", "elevenlabs", "featherless", "fireworks", "fishaudio",
    "flux", "friendli", "gemma", "giteeai", "glama", "google", "googlecloud", "groq", "hailuo",
    "huawei", "huaweicloud", "huggingface", "hunyuan", "hyperbolic", "ibm", "ideogram",
    "iflytekcloud", "infermatic", "infinigence", "inflection", "internlm", "jimeng", "jina",
    "kling", "kluster", "kwaipilot", "lambda", "leptonai", "lg", "liquid", "llmapi", "lmstudio",
    "longcat", "luma", "meta", "microsoft", "midjourney", "minimax", "mistral", "modelscope",
    "monica", "moonshot", "nebius", "newapi", "novita", "nplcloud", "nvidia", "ollama",
    "openai", "openchat", "openrouter", "parasail", "perplexity", "pika", "poe", "ppio",
    "qingyan", "qiniu", "qwen", "recraft", "replicate", "runway", "rwkv", "sambanova",
    "sensenova", "siliconcloud", "skywork", "snowflake", "sophnet", "spark", "stability",
    "statecloud", "stepfun", "straico", "streamlake", "submodel", "suno", "targon", "tencent",
    "tencentcloud", "tii", "together", "udio", "upstage", "venice", "vertexai", "vidu", "vllm",
    "volcengine", "voyage", "wenxin", "workersai", "worldrouter", "xai", "xiaomimimo",
    "xinference", "xuanyuan", "yandex", "yuanbao", "zai", "zenmux", "zeroone", "zhipu"
];

/// 目录的厂商前缀 → 图标库的键。**只收手工确认过的**。
///
/// 不按字符串相似度自动认：`anthracite-org` 和 `anthropic` 前七个字母一样，而前者是个
/// 微调组织，跟 Anthropic 没关系。给一家画上别人的标，比不画糟得多 —— 这条规矩
/// 和 `NEEDLES` 那张表是同一条。
const VENDOR_ALIASES: &[(&str, &str)] = &[
    ("mistralai", "mistral"),
    ("z-ai", "zai"),
    ("moonshotai", "moonshot"),
    ("meta-llama", "meta"),
    ("bytedance-seed", "bytedance"),
    ("x-ai", "xai"),
    ("ibm-granite", "ibm"),
    ("xiaomi", "xiaomimimo"),
    ("arcee-ai", "arcee"),
    ("amazon", "aws"),
    // AI2 就是 Allen Institute for AI，目录里写作 `allenai`，图标键写作 `ai2`。
    ("allenai", "ai2"),
];

/// (出现在 base_url 里的片段, 厂商)。只在模型名认不出来时才轮到它。
const HOSTS: &[(&str, &str)] = &[
    ("openrouter", "openrouter"),
    ("siliconflow", "siliconcloud"),
    ("siliconcloud", "siliconcloud"),
    ("deepinfra", "deepinfra"),
    ("groq.com", "groq"),
    ("together.", "together"),
    ("fireworks", "fireworks"),
    ("replicate", "replicate"),
    ("huggingface", "huggingface"),
    ("novita", "novita"),
    ("hyperbolic", "hyperbolic"),
    ("cerebras", "cerebras"),
    ("sambanova", "sambanova"),
    ("baseten", "baseten"),
    ("nebius", "nebius"),
    ("featherless", "featherless"),
    ("lepton", "leptonai"),
    ("ppio", "ppio"),
    ("gitee", "giteeai"),
    ("aihubmix", "aihubmix"),
    ("burncloud", "burncloud"),
    ("cometapi", "cometapi"),
    ("302.ai", "ai302"),
    ("poe.com", "poe"),
    ("monica", "monica"),
    ("venice", "venice"),
    ("zenmux", "zenmux"),
    ("sophnet", "sophnet"),
    ("straico", "straico"),
    ("qiniu", "qiniu"),
    ("jina.ai", "jina"),
    ("voyageai", "voyage"),
    ("dashscope", "bailian"),
    ("aliyuncs", "alibabacloud"),
    ("volces", "volcengine"),
    ("volcengine", "volcengine"),
    ("bigmodel", "zhipu"),
    ("moonshot", "moonshot"),
    ("baidubce", "baiducloud"),
    ("tencentcloudapi", "tencentcloud"),
    ("myhuaweicloud", "huaweicloud"),
    ("xf-yun", "iflytekcloud"),
    ("azure", "azure"),
    ("amazonaws", "bedrock"),
    ("googleapis", "googlecloud"),
    ("cloudflare", "cloudflare"),
    ("localhost", "ollama"),
    ("127.0.0.1", "ollama"),
    ("11434", "ollama"),
];

/// (在模型 id 或 provider 里出现的片段, 厂商)。从上往下匹配。
const NEEDLES: &[(&str, &str)] = &[
    ("claude", "anthropic"),
    ("anthropic", "anthropic"),
    ("deepseek", "deepseek"),
    ("glm", "zhipu"),
    ("chatglm", "zhipu"),
    ("zhipu", "zhipu"),
    ("grok", "xai"),
    ("gemini", "google"),
    ("gemma", "google"),
    ("qwen", "qwen"),
    ("qwq", "qwen"),
    ("kimi", "moonshot"),
    ("moonshot", "moonshot"),
    ("llama", "meta"),
    ("mistral", "mistral"),
    ("mixtral", "mistral"),
    ("magistral", "mistral"),
    // 小米 MiMo。图标库里那家的键是 `xiaomimimo`，不是 `mimo` —— 这两个不对齐的话，
    // `hasBrandMark` 会说「没有这家」，前端画中性图标，而图其实躺在 sprite 里。
    // 放在 minimax 前后都安全：`minimax-m2` 不含 `mimo`。
    ("mimo", "xiaomimimo"),
    ("xiaomi", "xiaomimimo"),
    ("minimax", "minimax"),
    ("abab", "minimax"),
    // 下面这几家都在图标库里，只是判定表一直没收。挑的都是**不会撞进别人名字**的长词
    // —— 短词（`yi`、`nova`、`seed`）一律不收，给智谱画上别家的标比不画糟得多。
    ("longcat", "longcat"),
    ("kwaipilot", "kwaipilot"),
    ("hailuo", "hailuo"),
    ("codegeex", "codegeex"),
    ("falcon", "tii"),
    ("dbrx", "dbrx"),
    ("rwkv", "rwkv"),
    ("baichuan", "baichuan"),
    ("hunyuan", "hunyuan"),
    ("doubao", "doubao"),
    ("volc", "volcengine"),
    ("ernie", "wenxin"),
    ("wenxin", "wenxin"),
    ("internlm", "internlm"),
    ("sensechat", "sensenova"),
    ("sensenova", "sensenova"),
    ("skywork", "skywork"),
    ("command-r", "cohere"),
    ("cohere", "cohere"),
    ("jamba", "ai21"),
    ("sonar", "perplexity"),
    ("perplexity", "perplexity"),
    ("nemotron", "nvidia"),
    ("nvidia", "nvidia"),
    ("phi-", "microsoft"),
    ("openrouter", "openrouter"),
    ("fireworks", "fireworks"),
    ("groq", "groq"),
    ("together", "together"),
    ("ollama", "ollama"),
    ("bedrock", "bedrock"),
    ("vertex", "vertexai"),
    ("azure", "azure"),
    // 「01.AI / 零一万物」的 id 是 yi-large / yi-lightning 这一族。
    // 只写 "yi" 会撞进一堆别的名字里（例如任何含 "yi" 的拼音品牌），所以逐个列。
    ("yi-large", "zeroone"),
    ("yi-lightning", "zeroone"),
    ("yi-vision", "zeroone"),
    ("yi-medium", "zeroone"),
    ("zeroone", "zeroone"),
    // 讯飞星火。放在最后是因为 "spark" 也可能出现在别的地方（如 sparkdesk 之外的品牌名）。
    ("sparkdesk", "spark"),
    ("spark-", "spark"),
    ("step-", "stepfun"),
    ("stepfun", "stepfun"),
    ("gpt", "openai"),
    ("o3-", "openai"),
    ("o4-", "openai"),
    ("openai", "openai"),
];

/// 「能不能服务」的排序：越小越好。
///
/// 用 `route_health::classify` 那套词（ok / degraded / unknown / error），不新造词 ——
/// 面板和告警都按那几个词分支，多一个词就是一条走不到的分支。
fn serve_rank(word: &str) -> u8 {
    match word {
        "ok" => 0,
        "degraded" => 1,
        // 「不知道」排在 error 前面：没有证据不等于坏。它不会触发告警，
        // 也不会让一条真坏了的线路显示成绿的 —— 两头都不冤枉。
        "unknown" => 2,
        _ => 3,
    }
}

/// 这条线路所有出口里**最好**的那个结论，以及它是谁。
///
/// 加多路由之前，「线路健康」和「那个地址健康」是同一件事。现在不是了：健康按出口记
/// （一个坏出口不该拖垮同线路的好出口），而流量大多走最便宜那个出口 —— 只看线路自带
/// 地址的记录，面板上最忙的线路反而会显示成「不知道」，**告警更是永远看不到出口的连败**。
/// 那正好是这台机器出过的那次事故的形状：面板全绿、监控一次没响、44 小时。
///
/// 取「最好」而不是「最坏」，是因为这两处要回答的都是**用户此刻能不能用**：只要还有一个
/// 出口能服务，请求就会成功，不该报警、也不该标红。全部出口都判坏了才是真的坏了。
///
/// 返回的第二个值是判据来自哪个出口：`None` = 线路自带地址。告警文案要指名道姓，
/// 否则运维收到「线路 X 坏了」却发现直连是好的，下一次就不看告警了。
pub async fn best_word(
    state: &AppState,
    route_id: uuid::Uuid,
    now: i64,
) -> (&'static str, Option<uuid::Uuid>, crate::route_health::RouteHealth) {
    let own = crate::route_health::snapshot(state, route_id).await;
    let mut best = (
        crate::route_health::classify(&own, now),
        None::<uuid::Uuid>,
        own,
    );
    if serve_rank(best.0) == 0 {
        return best;
    }
    let ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM route_endpoints WHERE route_id = $1 AND active = true",
    )
    .bind(route_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for id in ids {
        let h = crate::route_health::snapshot(state, id).await;
        let w = crate::route_health::classify(&h, now);
        if serve_rank(w) < serve_rank(best.0) {
            best = (w, Some(id), h);
            if serve_rank(w) == 0 {
                break;
            }
        }
    }
    best
}

/// 面板上那一格。`best_word` 的第一个值。
pub async fn aggregate_live(state: &AppState, route_id: uuid::Uuid, now: i64) -> &'static str {
    best_word(state, route_id, now).await.0
}

// ---------------------------------------------------------------- 后台接口

#[derive(Serialize)]
pub struct EndpointOut {
    pub id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub label: String,
    pub base_url: String,
    /// 只回「有没有配密钥」，永远不回密钥本身 —— 后台页面也不例外。
    pub has_key: bool,
    pub cost_ratio: f64,
    pub active: bool,
    pub note: String,
    pub probe_ok: Option<bool>,
    pub probe_at: Option<chrono::DateTime<chrono::Utc>>,
    pub probe_ms: Option<i32>,
    pub probe_note: String,
    /// 这个出口实际有哪些模型。空 = 线路的全部。
    pub enabled_models: Vec<String>,
    /// 这个出口的协议。空 = 跟线路一样。
    pub protocol: String,
    /// 能扛多少（相对值）。null = 没填。
    pub capacity: Option<f64>,
    /// 调度器眼里它现在是什么状态：live / saturated / no_quota / auth。
    pub sched: &'static str,
    /// 下架的话，还有多少秒去试下一次。
    pub retry_in: Option<u64>,
    /// 最近 7 天的**真实**成绩：成功数、失败数、成功那些的平均首字毫秒。
    ///
    /// 探测会说假话 —— 它 20 秒不回就判死，而慢不等于打不通。线上实测「梦幻API」
    /// 三个出口探测全部超时判死，同一天接了 241 次真实请求全部成功，而它们正是
    /// 最便宜的几个。红徽章旁边必须同时看得见真实成绩，否则那个红是误导。
    pub real_ok: i64,
    pub real_fail: i64,
    pub real_ms: Option<i64>,
    /// 换算成「每一美元官方价实际花多少人民币」。**排序真正比的是这个数，不是倍率。**
    ///
    /// 倍率只在同一家中转内部可比 —— 它的单位是那家中转的余额单位，而一块钱能买到
    /// 多少余额各家差几十倍。线上就有这个形状：GPT 线路上「梦幻API 0.15 倍」看着比
    /// 「WE API 0.16 倍」便宜，换算之后是 ¥0.15 对 ¥0.016 —— 差十倍，而且方向反了。
    ///
    /// None = 这家站没填充值汇率，算不出来。这条线路上只要有一个算不出来，整条线路
    /// 就退回按倍率排（服务端的**全有全无**规则），前端也必须照做。
    pub cost_cny: Option<f64>,
    /// 真实耗时的样本数。前端判「慢不慢」要它 —— 样本不够就退回看探测。
    pub real_n: i64,
    /// **派单那个窗口**的成败数（今天，样本不够退回 7 天）。
    ///
    /// 和上面 `real_ok`/`real_fail` 那两个 7 天的数**不是一回事**：那两个是给人看的
    /// 成绩单，这两个是排序真正读的。不分开的话，这一屏画出来的顺序和真正发生的
    /// 会在「今天刚变坏」的出口上对不上，而且看不出来。
    pub rate_ok: i64,
    pub rate_bad: i64,
    /// 最近一次真实成功／失败的时刻。排序真正读的是这两个，见 `availability_tier`。
    pub last_ok_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_fail_at: Option<chrono::DateTime<chrono::Utc>>,
    /// 真实流量的结论：ok / degraded / error / unknown。和探测是两个来源，都要看得见。
    pub live: String,
}

#[derive(Serialize)]
pub struct RouteOut {
    pub id: uuid::Uuid,
    pub label: String,
    pub protocol: String,
    /// 厂商标识（anthropic / openai / deepseek / …），前端据此挑图标。空 = 认不出来。
    pub vendor: &'static str,
    pub base_url: String,
    /// 线路自带地址换算后的「每一美元官方价花多少人民币」。倍率固定按 1.0 算
    /// （它是在任的那个，`own_order_key` 也是这么定的）。None = 这家站没填汇率。
    pub own_cost_cny: Option<f64>,
    pub active: bool,
    pub model_count: usize,
    /// 这条线路**自己**开放的模型 id（`allowed_ids`）。
    pub models: Vec<String>,
    /// 派单真正拿来匹配的那一份：线路自己的 ∪ 各出口 `enabled_models` 的并集。
    ///
    /// 两者会不一样，而且不一样的时候正是要看的时候：一个出口可以带来线路本身没有的
    /// 模型（`effective_models`，刻意设计）。屏上的模型选择器必须用这一份，否则那些
    /// 「只由出口带进来」的模型在选择器里根本不存在，而它们恰恰是排序最容易出错的。
    pub effective_models: Vec<String>,
    /// 线路自带地址最近的成败（窗口和出口那边逐字一致）。前端排序要用 —— 它此前
    /// 只能硬写 0/0，于是自带地址在屏上永远算靠谱。
    pub own_rate_ok: i64,
    pub own_rate_bad: i64,
    /// 这条线路怎么计费。出口窗口里**只读显示** —— 加一个出口时你要知道它的流量
    /// 会被按什么价计费，但计费是线路的属性，不能在出口这一层改。
    pub billing_mode: String,
    pub rate: f64,
    pub cache_disabled: bool,
    /// 单模型定价和显示名（线路上的那一份），出口窗口里可以就地编辑。
    pub model_prices: serde_json::Value,
    pub model_names: serde_json::Value,
    /// 每个模型此刻的目录现价（含出口带来的），出口窗口里摆在价格框旁边：留空 = 按它收。
    pub catalog_prices: serde_json::Value,
    /// 人民币口径的换算，和「线路」页同源。
    pub cny_per_usd: f64,
    /// 线路自带那个地址的调度状态（它也是一个出口）。
    pub sched: &'static str,
    pub retry_in: Option<u64>,
    pub live: String,
    pub endpoints: Vec<EndpointOut>,
}

/// 调度器眼里这个出口现在是什么状态。
///
/// 三个词各对应一种「现在别用它」的理由，恢复方式完全不同 —— 所以界面上必须分开显示，
/// 混成一个「不可用」的话，运维看到红点不知道该去充值、去换密钥、还是什么都不用做。
fn sched_word(id: uuid::Uuid) -> &'static str {
    if let Some(r) = crate::models::endpoint_delisted(id) {
        return r.why.word();
    }
    if crate::models::endpoint_saturated(id, std::time::Instant::now(), Duration::ZERO) {
        return "saturated";
    }
    "live"
}

fn retry_in_secs(id: uuid::Uuid) -> Option<u64> {
    crate::models::endpoint_delisted(id).map(|r| {
        r.next_probe
            .saturating_duration_since(std::time::Instant::now())
            .as_secs()
    })
}

/// `POST /api/admin/route-endpoints/:id/relist` —— 手动把一个下架的出口放回去。
///
/// 充完钱不想等调度器那一轮时用。放回去之后它就是普通候选，真不行会立刻再被下架 ——
/// 所以这个按钮不会造成任何持久的坏状态。
pub async fn admin_relist(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let was = crate::models::relist_endpoint(id);
    if was {
        forget_delisting(&state, id).await;
    }
    Ok(Json(serde_json::json!({ "relisted": was })))
}

#[derive(Serialize)]
pub struct HealthRow {
    pub endpoint_id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub route_label: String,
    pub vendor: &'static str,
    /// 出口备注；线路自带地址回「直连」。
    pub label: String,
    pub base_url: String,
    pub is_own: bool,
    pub active: bool,
    pub cost_ratio: f64,
    pub capacity: Option<f64>,
    /// 调度状态：live / saturated / no_quota / auth
    pub sched: &'static str,
    pub retry_in: Option<u64>,
    /// 真实流量的结论：ok / degraded / error / unknown
    pub live: String,
    pub consecutive_failures: i64,
    pub last_ok_secs_ago: Option<i64>,
    /// 最近一次主动探测
    pub probe_ok: Option<bool>,
    pub probe_ms: Option<i32>,
    pub probe_note: String,
    /// 用量：今天 / 最近 7 天
    pub calls_today: i64,
    pub cost_today_usd: f64,
    pub calls_7d: i64,
    pub cost_7d_usd: f64,
    pub cached_tokens_7d: i64,
    /// 余额。null = 这家没有可识别的余额接口，或者查失败 —— **不是 0**。
    pub balance: Option<String>,
    /// 我们声明开放、而上游清单里没有的模型。这些请求会撞 404。
    ///
    /// 空数组和 `manifest_note` 非空是两件事：前者是「比对过，没缺货」，
    /// 后者是「没比对成」。都塌成空数组的话，一家不提供 /models 的中转
    /// 看起来会和一家完全正常的一模一样。
    pub missing_models: Vec<String>,
    /// 没比对成时的原因。空 = 比对出结论了。
    pub manifest_note: String,
}

#[derive(sqlx::FromRow)]
struct UsageRow {
    endpoint_id: uuid::Uuid,
    calls_today: i64,
    cost_today: i64,
    calls_7d: i64,
    cost_7d: i64,
    cached_7d: i64,
}

/// `GET /api/admin/route-health` —— 健康面板要的全部事实。
///
/// 一次把「它现在什么状态、最近成不成、花了多少、还剩多少钱」凑齐。分散在几个接口里
/// 的话，页面要串行等好几轮，而这一页的用途正是「出事时快速看一眼」。
///
/// `?balance=1` 才去问上游余额 —— 那是几个网络往返，不该让每次刷新都付这个钱。
pub async fn admin_health(
    State(state): State<AppState>,
    claims: Claims,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let want_balance = q.get("balance").map(|v| v == "1").unwrap_or(false);

    let routes: Vec<Model> = sqlx::query_as("SELECT * FROM models ORDER BY sort, created_at")
        .fetch_all(&state.db)
        .await?;
    let eps: Vec<Endpoint> = sqlx::query_as("SELECT * FROM route_endpoints ORDER BY cost_ratio")
        .fetch_all(&state.db)
        .await?;
    // 用量一次查完，别在循环里逐个查。
    let usage: Vec<UsageRow> = sqlx::query_as(
        "SELECT endpoint_id, \
            COALESCE(SUM(calls) FILTER (WHERE day = current_date), 0)::bigint AS calls_today, \
            COALESCE(SUM(cost_micro_usd) FILTER (WHERE day = current_date), 0)::bigint AS cost_today, \
            COALESCE(SUM(calls), 0)::bigint AS calls_7d, \
            COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost_7d, \
            COALESCE(SUM(cached_tokens), 0)::bigint AS cached_7d \
         FROM endpoint_usage WHERE day >= current_date - 6 GROUP BY endpoint_id",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let by_ep: HashMap<uuid::Uuid, &UsageRow> =
        usage.iter().map(|u| (u.endpoint_id, u)).collect();

    let now_ts = chrono::Utc::now().timestamp();
    let http = probe_client();
    let mut rows: Vec<HealthRow> = Vec::new();

    for r in &routes {
        let vendor = vendor_of(&r.provider, &crate::models::allowed_ids(r), &r.base_url);
        // 线路自带的地址也是一个出口，必须出现在面板里 —— 它往往是最常出问题的那个。
        // 最后两个 String 是「调用密钥」和「余额令牌」—— 两套凭据，见 read_balance。
        let mut entries: Vec<(uuid::Uuid, String, String, bool, f64, Option<f64>, bool, Option<bool>, Option<i32>, String, String, String)> =
            vec![(
                r.id,
                "直连".into(),
                r.base_url.clone(),
                true,
                1.0,
                None,
                r.active,
                None,
                None,
                String::new(),
                r.api_key.clone(),
                r.balance_token.clone(),
            )];
        for e in eps.iter().filter(|e| e.route_id == r.id) {
            let key = if e.api_key.trim().is_empty() { r.api_key.clone() } else { e.api_key.clone() };
            entries.push((
                e.id,
                if e.label.trim().is_empty() { "未命名出口".into() } else { e.label.clone() },
                e.base_url.clone(),
                false,
                e.cost_ratio,
                e.capacity,
                e.active,
                e.probe_ok,
                e.probe_ms,
                e.probe_note.clone(),
                key,
                // 出口没配令牌就用线路的：同一个中转账号下挂几个入口地址是常见配置，
                // 逼人把同一个令牌抄几遍只会抄错。
                if e.balance_token.trim().is_empty() { r.balance_token.clone() } else { e.balance_token.clone() },
            ));
        }

        for (id, label, base, is_own, cost, cap, active, pok, pms, pnote, key, btok) in entries {
            let h = crate::route_health::snapshot(&state, id).await;
            let u = by_ep.get(&id);
            let mf = crate::manifest_check::report_for(id);
            // 走**和网关适配器同一个入口**。这里曾经有自己的一份实现，对 sub2api
            // 打的是要控制台令牌的那条路，于是适配器页有余额、这一页显示「查不到」，
            // 而两页说的是同一件事。那份已经删掉了。
            let balance = if want_balance && !(key.trim().is_empty() && btok.trim().is_empty()) {
                crate::relay_sync::balance_now(
                    &state,
                    id,
                    &base,
                    &crate::models::model_key(&key),
                    &crate::models::model_key(&btok),
                )
                .await
                .map(|b| b.text)
            } else {
                None
            };
            rows.push(HealthRow {
                endpoint_id: id,
                route_id: r.id,
                route_label: r.label.clone(),
                vendor,
                label,
                base_url: base,
                is_own,
                active,
                cost_ratio: cost,
                capacity: cap,
                sched: sched_word(id),
                retry_in: retry_in_secs(id),
                live: crate::route_health::classify(&h, now_ts).to_string(),
                consecutive_failures: h.consecutive_failures,
                last_ok_secs_ago: h.last_ok_at.map(|t| now_ts.saturating_sub(t)),
                probe_ok: pok,
                probe_ms: pms,
                probe_note: pnote,
                calls_today: u.map(|x| x.calls_today).unwrap_or(0),
                cost_today_usd: u.map(|x| x.cost_today as f64 / 1_000_000.0).unwrap_or(0.0),
                calls_7d: u.map(|x| x.calls_7d).unwrap_or(0),
                cost_7d_usd: u.map(|x| x.cost_7d as f64 / 1_000_000.0).unwrap_or(0.0),
                cached_tokens_7d: u.map(|x| x.cached_7d).unwrap_or(0),
                balance,
                missing_models: mf.as_ref().map(|r| r.missing.clone()).unwrap_or_default(),
                // 还没轮到它比对时，note 说清楚是「还没测」，而不是留空冒充「没问题」。
                manifest_note: match &mf {
                    Some(r) => r.note.clone(),
                    None => "还没比对过".to_string(),
                },
            });
        }
    }

    // 告警收件人：一个 admin 把 email 填成用户名，就永远收不到线路告警，
    // 而这件事只在启动日志里闪一下。放到面板上。
    let admins = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE role = 'admin'")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let usable = admins.iter().filter(|e| e.contains('@') && e.len() > 3).count();

    Ok(Json(serde_json::json!({
        "rows": rows,
        "alarm": { "usable": usable, "total": admins.len() },
        "balance_included": want_balance,
        // 有几个出口正在缺货。只数「比对出结论且真的缺」的，没比对成的不算。
        "missing_endpoints": crate::manifest_check::missing_endpoint_count(),
    })))
}

/// `GET /api/admin/route-endpoints` —— 每条线路 + 它挂了哪些出口。
///
/// `?model=<模型 id>`：把成败数/首字延迟/最近成败时刻收窄到**这一个模型**，和派单
/// 那一侧（`load_for_routes_for_model`）同口径。不带这个参数时是全模型合计。
///
/// **为什么需要这个参数。** 这一屏画的是「谁会先被派到」，而派单是**逐模型**决定的：
/// 出口按 `enabled_models` 筛（`expand()` 里那两处 continue），成败数也按模型统计。
/// 屏幕上只画一份「这条线路的顺序」，等于把所有模型的答案糊成一个 —— 实测 GPT 线路上
/// 屏上第 1 名的出口对 `gpt-5.6-luna` 根本不是候选，近 7 天一次都没被派到过。
pub async fn admin_list(
    State(state): State<AppState>,
    claims: Claims,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let want_model: Option<String> = q
        .get("model")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let routes: Vec<Model> =
        sqlx::query_as("SELECT * FROM models ORDER BY sort, created_at").fetch_all(&state.db).await?;
    let eps: Vec<Endpoint> = sqlx::query_as(
        "SELECT * FROM route_endpoints ORDER BY cost_ratio, created_at",
    )
    .fetch_all(&state.db)
    .await?;
    let now = chrono::Utc::now().timestamp();

    // 每个出口最近 7 天的真实成绩。7 天而不是当天：出口多了以后单日样本很薄，
    // 一天只走了三次的出口算不出成功率。时刻列不设窗口 —— 「最近一次成功」本来
    // 就该是最近一次，由 `availability_tier` 那把保质期的尺去判它算不算数。
    #[allow(clippy::type_complexity)]
    let attempts: Vec<(uuid::Uuid, i64, i64, i64, i64, Option<i64>, Option<i64>, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as(
            "SELECT endpoint_id, \
                    COALESCE(SUM(ok_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint, \
                    COALESCE(SUM(fail_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint, \
                    CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                         THEN COALESCE(SUM(ok_calls) FILTER (WHERE day = current_date), 0)::bigint \
                         ELSE COALESCE(SUM(ok_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                    END, \
                    CASE WHEN COALESCE(SUM(ok_calls + fail_calls) FILTER (WHERE day = current_date), 0)::bigint >= 8 \
                         THEN COALESCE(SUM(fail_calls) FILTER (WHERE day = current_date), 0)::bigint \
                         ELSE COALESCE(SUM(fail_calls) FILTER (WHERE day >= current_date - 6), 0)::bigint \
                    END, \
                    COALESCE(SUM(ttfb_ms_sum) FILTER (WHERE day >= current_date - 6), 0)::bigint, \
                    COALESCE(SUM(ttfb_ms_n)   FILTER (WHERE day >= current_date - 6), 0)::bigint, \
                    MAX(last_ok_at), MAX(last_fail_at) \
             FROM route_attempt \
             WHERE ($1::text IS NULL OR model_id = $1) \
             GROUP BY endpoint_id",
        )
        .bind(want_model.as_deref())
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    #[allow(clippy::type_complexity)]
    let real: HashMap<uuid::Uuid, (i64, i64, i64, i64, Option<i64>, i64, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>)> = attempts
        .into_iter()
        .map(|(id, ok, fail, rok, rbad, sum, n, ok_at, fail_at)| {
            // 平均只在成功那些里算 —— 失败的耗时压根没累加（超时的 20 秒混进来
            // 会把一个健康出口的均值直接拉成「慢得离谱」）。分母为 0 就是没有。
            let ms = match (sum, n) {
                (Some(sum), Some(n)) if n > 0 => Some(sum / n),
                _ => None,
            };
            (id, (ok, fail, rok, rbad, ms, n.unwrap_or(0), ok_at, fail_at))
        })
        .collect();

    // 线路自带地址的成败。**前端此前把它硬写成 (0, 0)**，旁边的注释还说「和服务端一致」——
    // 那句是假的：服务端 `expand()` 从 `load_own_rates` 真读得到这一对数，并据此判它的
    // 可靠性档（`route_endpoints.rs` 里 `rate_of.push(own_rates...)` 那一行）。
    // 于是屏幕上自带地址永远算「没有样本 = 靠谱」，而派单可能正把它整档往后压。
    let own_rates = load_own_rates(
        &state.db,
        &routes.iter().map(|r| r.id).collect::<Vec<_>>(),
        want_model.as_deref(),
    )
    .await;

    let mut by_route: HashMap<uuid::Uuid, Vec<Endpoint>> = HashMap::new();
    for e in eps {
        by_route.entry(e.route_id).or_default().push(e);
    }

    let mut out = Vec::with_capacity(routes.len());
    for r in &routes {
        // 被分组到别处的线路仍然是独立线路（分组只动显示），所以照样列出来 ——
        // 它有自己的密钥和账单，也就该能挂自己的出口。
        let outlets = by_route.remove(&r.id).unwrap_or_default();
        // 先算并集再进循环：下面会把 `e` 的字段搬进 EndpointOut，之后就取不到了。
        // 调**同一个** `effective_models`，不在这儿重抄一份并集逻辑 —— 抄一份就会和
        // 派单那侧漂，而这一屏的全部意义就是「照实画出派单会怎么做」。
        let eff = effective_models(r, &outlets);
        let mut list = Vec::new();
        for e in outlets {
            let h = crate::route_health::snapshot(&state, e.id).await;
            let cost_cny = crate::relay_rates::usd_per_cny(&e.base_url)
                .and_then(|r| crate::relay_rates::cny_per_official_usd(e.cost_ratio, r));
            let (real_ok, real_fail, rate_ok, rate_bad, real_ms, real_n, last_ok_at, last_fail_at) =
                real.get(&e.id).copied().unwrap_or((0, 0, 0, 0, None, 0, None, None));
            list.push(EndpointOut {
                id: e.id,
                route_id: e.route_id,
                label: e.label,
                base_url: e.base_url,
                has_key: !e.api_key.trim().is_empty(),
                cost_ratio: e.cost_ratio,
                active: e.active,
                note: e.note,
                probe_ok: e.probe_ok,
                probe_at: e.probe_at,
                probe_ms: e.probe_ms,
                probe_note: e.probe_note,
                real_ok,
                real_fail,
                real_ms,
                real_n,
                rate_ok,
                rate_bad,
                cost_cny,
                last_ok_at,
                last_fail_at,
                enabled_models: e.enabled_models,
                protocol: e.protocol,
                capacity: e.capacity,
                sched: sched_word(e.id),
                retry_in: retry_in_secs(e.id),
                live: crate::route_health::classify(&h, now).to_string(),
            });
        }
        out.push(RouteOut {
            id: r.id,
            label: r.label.clone(),
            protocol: r.protocol.clone(),
            vendor: vendor_of(&r.provider, &crate::models::allowed_ids(r), &r.base_url),
            base_url: r.base_url.clone(),
            own_cost_cny: crate::relay_rates::usd_per_cny(&r.base_url)
                .and_then(|rate| crate::relay_rates::cny_per_official_usd(1.0, rate)),
            active: r.active,
            model_count: crate::models::allowed_ids(r).len(),
            models: crate::models::allowed_ids(r),
            // 先算价再把 eff 搬进去（字段按书写顺序求值）。
            catalog_prices: serde_json::Value::Object(crate::models::catalog_price_map(&eff)),
            effective_models: eff,
            own_rate_ok: own_rates.get(&r.id).map(|(ok, _)| *ok).unwrap_or(0),
            own_rate_bad: own_rates.get(&r.id).map(|(_, bad)| *bad).unwrap_or(0),
            billing_mode: r.billing_mode.clone(),
            rate: r.rate,
            cache_disabled: r.cache_disabled,
            model_prices: r.model_prices.clone(),
            model_names: r.model_names.clone(),
            cny_per_usd: 10_000.0 / crate::settings::usd_per_cny_bps() as f64,
            sched: sched_word(r.id),
            retry_in: retry_in_secs(r.id),
            live: aggregate_live(&state, r.id, now).await.to_string(),
            endpoints: list,
        });
    }
    Ok(Json(serde_json::json!({ "routes": out })))
}

/// 前端送来的保存请求。
///
/// # 每个字段都要能吃 `null`
///
/// `#[serde(default)]` 只管**字段缺失**，管不了字段在、值是 `null`。而前端里
/// `x ? f(x) : null`、以及 `Number(...)` 出 NaN 被 `JSON.stringify` 写成 `null`，
/// 都太常见了 —— 一个显式 null 打在 `String` 或 `f64` 上，请求会在**进入处理函数
/// 之前**被提取器拒掉，报一句英文 serde 错，服务端一行日志都没有。
///
/// 那正是「点保存没反应、查不出原因」的形状。所以这里一律用 `null_as_*`：
/// null 一律当成没填，真正的校验交给下面那几个 `clean_*`，它们会说人话。
#[derive(Deserialize)]
pub struct SaveReq {
    #[serde(default)]
    pub id: Option<uuid::Uuid>,
    pub route_id: uuid::Uuid,
    #[serde(default, deserialize_with = "null_as_default")]
    pub label: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub base_url: String,
    /// 空字符串 = 不改（改地址时不用把密钥再抄一遍）。
    #[serde(default, deserialize_with = "null_as_default")]
    pub api_key: String,
    #[serde(default = "one", deserialize_with = "null_as_one")]
    pub cost_ratio: f64,
    #[serde(default = "yes", deserialize_with = "null_as_yes")]
    pub active: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub note: String,
    /// 这个出口实际有哪些模型。空数组 = 线路的全部。
    #[serde(default, deserialize_with = "null_as_default")]
    pub enabled_models: Vec<String>,
    /// 空串 = 跟线路一样。只收 anthropic / openai。
    #[serde(default, deserialize_with = "null_as_default")]
    pub protocol: String,
    /// 查余额用的控制台令牌。空串 = **不改**（和 api_key 同一规矩：改地址时
    /// 不用把令牌再抄一遍）。要清空得另外做一个动作，别让「没填」等于「清掉」。
    #[serde(default, deserialize_with = "null_as_default")]
    pub balance_token: String,
    /// 能扛多少（相对值）。None / 0 = 不填。
    #[serde(default)]
    pub capacity: Option<f64>,
    /// 顺手改的单模型定价，形状 `{ "模型id": {"in": 3.0, "out": 15.0} }`。
    ///
    /// **写到线路上，不写到出口上。** 价格是线路的属性，同一条线路的几个出口共用一份。
    /// 放在这个窗口里只是因为「发现新模型」和「给它定价」是同一件事的两半 ——
    /// 让人跑去另一页再回来，多数人会直接放弃，然后那个模型就永远开放不了。
    #[serde(default)]
    pub model_prices: Option<serde_json::Value>,
    /// 单模型显示名，同上，也写到线路。
    #[serde(default)]
    pub model_names: Option<serde_json::Value>,
}

/// 把 `null` 当成「没填」。见 SaveReq 上面那段。
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

fn null_as_one<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(1.0))
}

fn null_as_yes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(true))
}

fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

/// 进价**倍率**的合理区间。
///
/// 上一版的上限是 1.0，理由写的是「比原价还贵的转卖没有存在意义」。那条上限是从
/// **错词**里推出来的，不是从事实里：这个数是倍率不是折扣，而倍率没有 1.0 这条天花板。
/// 比原价贵的替补出口是合法配置 —— 它排在直连后面，只有便宜的那些都坏了才轮到它，
/// 恰恰是「贵一点也比断服强」。按折扣建模，保存时就会把它拒掉，而拒绝的理由
/// （「不能大于原价」）在事实层面根本不成立。
///
/// 上限 10 留着，但它只是**点错小数点**的护栏（想写 1.0 手滑成 10），不是语义上限：
/// 现实里的分组倍率没有到十倍的。它只影响先敲哪扇门，不进任何一笔账单 ——
/// `endpoint_cost` 唯一的去处是 `overflow_weight`，那是让位时的挑替补权重。
///
/// 下限不设 0：`cost_ratio > 0` 由表上的 CHECK 兜着，而 0 会让「免费」永远排第一，
/// 那反而是对的 —— 真有免费额度的出口就该先用。
fn clean_ratio(v: f64) -> ApiResult<f64> {
    if !v.is_finite() || v <= 0.0 {
        return Err(AppError::bad(
            "进价倍率要是个大于 0 的数（0.3 = 按官方价的 0.3 倍进货）",
        ));
    }
    if v >= 10.0 {
        return Err(AppError::bad(
            "进价倍率到 10 倍了 —— 这个数多半是小数点点错（1.0 写成了 10）",
        ));
    }
    Ok(v)
}

/// 协议只认这两个。
///
/// 不认识的字符串会一路带到发请求那一步，然后走进「不是 anthropic 就当 openai」的分支 ——
/// 拼出一个 /chat/completions 打给一个只认 /v1/messages 的上游，报一个看不懂的 404。
/// 在入口挡住，错误就停在填表的人面前。
fn clean_protocol(v: &str) -> ApiResult<String> {
    let p = v.trim().to_ascii_lowercase();
    if p.is_empty() || crate::models::PROTOCOLS.contains(&p.as_str()) {
        Ok(p)
    } else {
        Err(AppError::bad(format!(
            "上游协议只能是 {}（留空 = 跟线路一样）",
            crate::models::PROTOCOLS.join(" / ")
        )))
    }
}

/// 容量的合理区间。
///
/// 只做「是不是个正常的正数」这一层校验，不猜单位 —— 算法只看同一条线路下几个出口
/// 之间的比值，填 RPM、并发数还是 1/2/3 都行。0 和负数拒掉：那该用「停用」表达。
fn clean_capacity(v: Option<f64>) -> ApiResult<Option<f64>> {
    match v {
        None => Ok(None),
        // 前端空输入会送 0 过来，当成「没填」而不是报错。
        Some(x) if x == 0.0 => Ok(None),
        Some(x) if !x.is_finite() || x < 0.0 => {
            Err(AppError::bad("容量要是个大于 0 的数，留空表示不填"))
        }
        Some(x) if x > 1_000_000.0 => Err(AppError::bad("容量填得太大了，检查一下是不是多打了几个零")),
        Some(x) => Ok(Some(x)),
    }
}

fn clean_url(v: &str) -> ApiResult<String> {
    let u = v.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err(AppError::bad("中转地址不能为空"));
    }
    if u.len() > MAX_URL {
        return Err(AppError::bad("中转地址太长了"));
    }
    // 只收 http(s)。别的协议进到这里只会在发请求时报一个看不懂的错。
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AppError::bad("中转地址要以 http:// 或 https:// 开头"));
    }
    Ok(u)
}

/// `POST /api/admin/route-endpoints` —— 新增或修改一个出口。
pub async fn admin_save(
    State(state): State<AppState>,
    claims: Claims,
    // 收原始字节自己解，不用 `Json<SaveReq>`。
    //
    // 这是被一次真实故障逼出来的：控制台连着 5 次 400，而 axum 的提取器在字段类型
    // 对不上时**先于处理函数**就把请求拒了 —— 那种 400 是英文的 serde 报错、不进
    // 任何日志、也不经过这里加的任何一行代码。于是「它到底为什么不让我存」在服务端
    // 一点线索都没有，只能靠猜。
    //
    // 自己解之后：解不出来是一句说得清的中文 + 一条带字段名的日志。多一次
    // from_slice 的开销，换掉一整类查不出来的失败。
    body: axum::body::Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let req: SaveReq = serde_json::from_slice(&body).map_err(|e| {
        tracing::warn!(
            error = %e,
            bytes = body.len(),
            "出口保存：请求体解不出来（字段类型对不上，或者前端发了个意外的形状）"
        );
        AppError::bad(format!("请求格式不对：{e}"))
    })?;

    // 被拒的保存要留痕。
    //
    // 这一段是真实故障逼出来的：控制台连着 5 次 400，而 400 不进错误日志、响应又走
    // MSE 加密（nginx 记的是密文长度），于是「它到底为什么不让我存」在服务端**一点
    // 线索都没有**。校验失败是运维每天都会撞到的事，不是异常，所以它该有日志 ——
    // 带够定位用的字段，唯独不带密钥。
    let reject = |why: AppError| -> AppError {
        tracing::warn!(
            route_id = %req.route_id,
            base_url = %req.base_url,
            models = req.enabled_models.len(),
            protocol = %req.protocol,
            editing = req.id.is_some(),
            reason = %why.msg,
            "出口没存成"
        );
        why
    };

    let base_url = clean_url(&req.base_url).map_err(reject)?;
    let cost_ratio = clean_ratio(req.cost_ratio).map_err(reject)?;
    let label: String = req.label.trim().chars().take(MAX_LABEL).collect();
    let note: String = req.note.trim().chars().take(MAX_NOTE).collect();
    let protocol = clean_protocol(&req.protocol).map_err(reject)?;
    let capacity = clean_capacity(req.capacity).map_err(reject)?;

    let route: Option<Model> = sqlx::query_as("SELECT * FROM models WHERE id = $1")
        .bind(req.route_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(route) = route else {
        return Err(reject(AppError::bad("线路不存在")));
    };

    // 先把这次顺手填的定价并进线路，再做价格闸校验。
    //
    // 顺序不能反：新模型的价就是在这个窗口里填的，先校验的话它永远查不到价、永远存不上，
    // 而报错还让人「去线路那页填」—— 那页根本没有这个模型。
    let mut route = route;
    if req.model_prices.is_some() || req.model_names.is_some() {
        merge_route_pricing(&state, &mut route, &req).await?;
    }

    // 出口可以带来线路本身没有的模型 —— 新挂一个中转，它那儿多了两款货，
    // 那两款就该出现在 IDE 的列表里。
    //
    // 但有一条闸：**算不出价格的不许开放**。价格有三条来源（每模型覆盖 → 实时目录 →
    // 线路兜底价），三条都没有时 `compute_cost` 会算出 0，用户一分不付而上游照收你的钱。
    // 那不是功能，是漏洞。所以这里拒掉，并在报错里说清楚该去哪儿补价。
    let allowed = crate::models::allowed_ids(&route);
    let mut enabled_models: Vec<String> = req
        .enabled_models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    enabled_models.sort();
    enabled_models.dedup();
    if let Some(bad) = enabled_models
        .iter()
        .find(|m| !allowed.contains(m) && !priceable(&route, m))
    {
        return Err(reject(AppError::bad(format!(
            "「{bad}」是这条线路没有的新模型，但算不出它的价格 —— 开放出去用户一分不付、\
             上游照收你的钱。去线路那页给它填一个单模型价，或者先别勾它。"
        ))));
    }
    // 「正好等于线路那一份」和「不选」是同一件事，都存成空：这样以后线路加了新模型，
    // 出口会自动跟着有，而不是停在保存那天的那一份名单上。
    //
    // 判据必须是**集合相等**，不能是长度相等。出口现在能带来线路没有的模型 ——
    // 线路有 6 个，勾了 4 个原有 + 2 个新的也是 6 个，按长度判会把整份选择清空，
    // 那两个新模型**静默消失**：存的时候不报错，只是它们再也不会被派到这个出口。
    let is_exactly_the_routes_own = enabled_models.len() == allowed.len()
        && enabled_models.iter().all(|m| allowed.contains(m));
    if is_exactly_the_routes_own {
        enabled_models.clear();
    }

    let id = match req.id {
        Some(id) => {
            // 密钥空着 = 沿用原值。这一步必须在 UPDATE 之外先取出来，
            // 不然一次「只改地址」的保存会把密钥清成空。
            let keep: Option<(String, String, String)> = sqlx::query_as(
                "SELECT api_key, balance_token, key_fp FROM route_endpoints WHERE id = $1",
            )
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
            let Some((keep, keep_tok, keep_fp)) = keep else {
                return Err(AppError::bad("这个出口不存在"));
            };
            // 指纹必须和密钥同进同退：密钥沿用原值时指纹也沿用，否则一次「只改地址」的
            // 保存会把指纹清空，这一行就变成「空密钥」参与去重 —— 而它其实有密钥。
            let key_fp = if req.api_key.trim().is_empty() {
                keep_fp
            } else {
                key_fingerprint(&req.api_key)
            };
            let stored = if req.api_key.trim().is_empty() {
                keep
            } else {
                crate::field_crypto::encrypt(req.api_key.trim(), crate::models::MODEL_KEY_CTX)
            };
            // 令牌和密钥同一条规矩：空 = 沿用。一次「只改地址」的保存不该把它清掉。
            let stored_tok = if req.balance_token.trim().is_empty() {
                keep_tok
            } else {
                crate::field_crypto::encrypt(req.balance_token.trim(), crate::models::MODEL_KEY_CTX)
            };
            sqlx::query(
                "UPDATE route_endpoints SET route_id = $2, label = $3, base_url = $4, \
                 api_key = $5, cost_ratio = $6, active = $7, note = $8, \
                 enabled_models = $9, protocol = $10, capacity = $11, \
                 balance_token = $12, key_fp = $13, updated_at = now() \
                 WHERE id = $1",
            )
            .bind(id)
            .bind(req.route_id)
            .bind(&label)
            .bind(&base_url)
            .bind(&stored)
            .bind(cost_ratio)
            .bind(req.active)
            .bind(&note)
            .bind(&enabled_models)
            .bind(&protocol)
            .bind(capacity)
            .bind(&stored_tok)
            .bind(&key_fp)
            .execute(&state.db)
            .await
            .map_err(dup_url)?;
            id
        }
        None => {
            let stored =
                crate::field_crypto::encrypt(req.api_key.trim(), crate::models::MODEL_KEY_CTX);
            // 新建时空令牌就存空串，**不能**走 encrypt —— 没配 FIELD_ENC_KEY 时它是
            // passthrough，配了则会把空串加密成一段密文，那段密文解出来不是空，
            // 于是「没配令牌」会被后面的 `trim().is_empty()` 判成「配了」。
            let stored_tok = if req.balance_token.trim().is_empty() {
                String::new()
            } else {
                crate::field_crypto::encrypt(req.balance_token.trim(), crate::models::MODEL_KEY_CTX)
            };
            sqlx::query_scalar(
                "INSERT INTO route_endpoints (route_id, label, base_url, api_key, cost_ratio, \
                 active, note, enabled_models, protocol, capacity, balance_token, key_fp) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
            )
            .bind(req.route_id)
            .bind(&label)
            .bind(&base_url)
            .bind(&stored)
            .bind(cost_ratio)
            .bind(req.active)
            .bind(&note)
            .bind(&enabled_models)
            .bind(&protocol)
            .bind(capacity)
            .bind(&stored_tok)
            .bind(key_fingerprint(&req.api_key))
            .fetch_one(&state.db)
            .await
            .map_err(dup_url)?
        }
    };

    // 存完立刻探一次。加一个出口最想知道的就是「这个密钥对不对」，
    // 而等 15 分钟后的后台轮次才告诉你填错了，那期间它一直在候选池里。
    let ep: Option<Endpoint> = sqlx::query_as("SELECT * FROM route_endpoints WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let probe = match &ep {
        Some(e) => {
            let out = probe_and_store(&state, e, &route).await;
            serde_json::json!({ "ok": out.ok, "ms": out.ms, "note": out.note })
        }
        None => serde_json::Value::Null,
    };

    tracing::info!(route_id = %req.route_id, endpoint = %id, "出口已保存");
    Ok(Json(serde_json::json!({ "id": id, "probe": probe })))
}

/// 把这次填的单模型定价合并进**线路**。
///
/// # 为什么不存到出口上
///
/// 价格是线路的属性 —— 同一条线路的几个出口对用户完全等价，只有我的进价不同。
/// 要是每个出口各存一份价，同一个模型用户被扣多少钱就要看当时哪家先答；这正是整套
/// 多路由设计第一天就堵死的那个洞，不能从这个窗口再开一次。
///
/// 所以这里是「在出口窗口里编辑线路的定价」，不是「给出口定价」。合并而不是覆盖：
/// 这个窗口只列了这一家有的那些模型，整份覆盖会把线路上别的模型的价抹掉。
async fn merge_route_pricing(
    state: &AppState,
    route: &mut Model,
    req: &SaveReq,
) -> ApiResult<()> {
    fn merge(base: &serde_json::Value, patch: &serde_json::Value) -> serde_json::Value {
        let mut out = base.as_object().cloned().unwrap_or_default();
        if let Some(p) = patch.as_object() {
            for (k, v) in p {
                // null / 空对象 = 把这一条删掉，而不是写一个空进去。
                if v.is_null() {
                    out.remove(k);
                } else {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        serde_json::Value::Object(out)
    }

    // **每条价必须两个数都带齐。**
    //
    // 每模型价在 `effective_token_prices` 里是第一优先级 —— 它一旦存在就**盖掉实时目录价**，
    // 所以一条 `{"in": 0, "out": 75}` 不是「输入价还没填」，而是「输入永久免费」。
    // 后果不止输入那一条腿：`effective_cache_prices` 在有每模型覆盖时按 `输入价 × 倍率`
    // 算缓存读/写，输入价 0 → 缓存两条腿一起归零，而缓存是 Claude 这类模型账单里最大的一项。
    // 反过来只填输入价的话，输出按 0 白送，而各家出价是入价的 3~5 倍。
    //
    // 前端已经收紧了（`RouteEndpoints.tsx` / `Routing.tsx` 都要求两个框都填），这里是第二道：
    // 「只填一边」这种形状不许再有第二个入口。**显式填 0 照旧放行** —— 那是一种有意的定价。
    if let Some(p) = &req.model_prices {
        for (model, v) in p.as_object().into_iter().flatten() {
            if v.is_null() {
                continue; // null = 删掉这一条覆盖，退回目录价
            }
            let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|n| n.is_finite() && *n >= 0.0);
            if num("in").is_none() || num("out").is_none() {
                return Err(AppError::bad(format!(
                    "模型 {model} 的单价只填了一半：输入价和输出价必须同时给出（都填 0 = 这个模型免费，是允许的）。                     只给一边会把另一边按 0 永久覆盖掉目录价，连缓存价也一起归零。"
                )));
            }
        }
    }
    let prices = match &req.model_prices {
        Some(p) => merge(&route.model_prices, p),
        None => route.model_prices.clone(),
    };
    let names = match &req.model_names {
        Some(n) => merge(&route.model_names, n),
        None => route.model_names.clone(),
    };
    sqlx::query("UPDATE models SET model_prices = $2, model_names = $3 WHERE id = $1")
        .bind(route.id)
        .bind(&prices)
        .bind(&names)
        .execute(&state.db)
        .await?;
    route.model_prices = prices;
    route.model_names = names;
    Ok(())
}

/// 唯一索引撞了就说人话。原始报错里有表名、索引名和列值，对运维没用。
fn dup_url(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &e {
        if db.code().as_deref() == Some("23505") {
            // 判据是「地址 **且** 密钥都一样」——同地址不同密钥是正当的（同一家转卖商的
            // 几个账号，各有各的余额和限速），所以话要说准，不然运维会以为同址账号
            // 根本挂不上去，而那正是故障转移最有价值的一种。
            return AppError::bad(
                "这条线路下已经有一个地址和密钥都相同的出口了。\
                 同一个地址挂多个账号是可以的——换一把密钥即可；\
                 两个都不填密钥（沿用线路自己那把）算同一个上游。",
            );
        }
    }
    AppError::from(e)
}

/// 密钥的**确定性指纹**，用于「同地址同密钥算重复」这条唯一约束。
///
/// 为什么不能直接对 `api_key` 列建唯一索引：那一列是密文，而 field_crypto 每次加密都用
/// 新的随机 nonce，同一把密钥两次写入得到两段不同的密文 —— 索引永远不会命中，
/// 等于没有约束。
///
/// 存的是哈希不是明文：这一列会出现在备份、日志和 `SELECT *` 里，而 API 密钥是高熵
/// 随机串，sha256 不可逆。域分隔前缀防的是拿别处同样算法的哈希来比对。
///
/// 空密钥（= 沿用线路自己那把）映射成空串，**不是**空串的哈希：这样「同地址 + 两边都
/// 不填密钥」仍然撞唯一索引 —— 那确实是同一个上游粘了两遍。
pub fn key_fingerprint(plaintext: &str) -> String {
    let key = plaintext.trim();
    if key.is_empty() {
        return String::new();
    }
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let mut h = Sha256::new();
    h.update(b"mrday-route-endpoint-key/v1\n");
    h.update(key.as_bytes());
    let digest = h.finalize();
    // 取前 16 字节 = 32 位十六进制。128 位对「同一条线路下有没有撞上」这件事绰绰有余，
    // 而列短一点，索引和备份都省事。
    let mut out = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 存量行的指纹回填。
///
/// 迁移建完索引时所有旧行的 `key_fp` 都是空串（SQL 解不了密）。它们两两之间地址本就
/// 不同，所以那一刻不会误判；但**新加**一个同址同密钥的出口时，`''` 和真指纹不相等，
/// 重复就漏过去了。所以要把旧行补齐。
///
/// 幂等、逐行条件更新，和 field_backfill 同一套路数。只补「有密钥但还没指纹」的行；
/// 空密钥的行 key_fp 本来就该是空串，不动。
pub fn spawn_key_fp_backfill(state: AppState) {
    tokio::spawn(async move {
        // 让迁移和主要初始化先过去。它不急。
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let rows: Vec<(uuid::Uuid, String)> = match sqlx::query_as(
            "SELECT id, api_key FROM route_endpoints WHERE key_fp = '' AND api_key <> ''",
        )
        .fetch_all(&state.db)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!(error = %e, "出口密钥指纹回填：读不出来（下次启动再试）");
                return;
            }
        };
        let mut done = 0u64;
        for (id, stored) in rows {
            // 走 model_key，和这张表所有别的解密同一条路（它内部就是 MODEL_KEY_CTX）。
            //
            // 刻意**不用** decrypt_or_raw：那个在解不开时返回**密文本身**，于是会算出一个
            // 稳定但错误的指纹并永久存进库 —— 同一把密钥的两行密文不同、指纹也就不同，
            // 重复照样漏过去，而且再也没有征兆。model_key 解不开返回空串，
            // 下面那句 `fp.is_empty()` 直接跳过，留到下次启动（密钥修好之后）再补。
            // 遗留明文行不受影响：decrypt 对没有 fc1: 前缀的值原样返回 Ok。
            let plain = crate::models::model_key(&stored);
            let fp = key_fingerprint(&plain);
            if fp.is_empty() {
                continue;
            }
            // 条件更新：只在仍然是空指纹时写，避免和正常的保存路径打架。
            match sqlx::query("UPDATE route_endpoints SET key_fp = $2 WHERE id = $1 AND key_fp = ''")
                .bind(id)
                .bind(&fp)
                .execute(&state.db)
                .await
            {
                Ok(r) => done += r.rows_affected(),
                Err(e) => tracing::warn!(error = %e, %id, "出口密钥指纹回填：这一行没写进去"),
            }
        }
        if done > 0 {
            tracing::info!(rows = done, "出口密钥指纹回填完成");
        }
    });
}

/// `POST /api/admin/route-endpoints/:id/probe` —— 手动测一个出口。
pub async fn admin_probe(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let ep: Option<Endpoint> = sqlx::query_as("SELECT * FROM route_endpoints WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some(ep) = ep else {
        return Err(AppError::not_found("这个出口不存在"));
    };
    let route: Option<Model> = sqlx::query_as("SELECT * FROM models WHERE id = $1")
        .bind(ep.route_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(route) = route else {
        return Err(AppError::bad("这个出口挂的线路已经不在了"));
    };
    let out = probe_and_store(&state, &ep, &route).await;
    Ok(Json(
        serde_json::json!({ "ok": out.ok, "ms": out.ms, "note": out.note }),
    ))
}

/// `POST /api/admin/route-endpoints/:id/probe-route` —— 测线路自带的那个地址。
///
/// 线路自带的地址也是一个出口，而且是默认那个。只能测转卖出口、测不了它，
/// 等于最常出问题的那个反而看不见。它的结论不落 `route_endpoints`（那里没有它的行），
/// 只即时回给页面。
pub async fn admin_probe_route(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let route: Option<Model> = sqlx::query_as("SELECT * FROM models WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some(route) = route else {
        return Err(AppError::not_found("线路不存在"));
    };
    let key = crate::models::model_key(&route.api_key);
    // 线路自带的地址：协议和模型都用线路自己的。
    let out = probe_once(&probe_client(), &route, &route.base_url, &key, "", &[]).await;
    Ok(Json(
        serde_json::json!({ "ok": out.ok, "ms": out.ms, "note": out.note }),
    ))
}

#[derive(Deserialize)]
pub struct AvailableReq {
    pub route_id: uuid::Uuid,
    /// 还没保存的出口也要能拉 —— 否则运维得先存一个可能是错的配置才知道它有什么货。
    pub base_url: String,
    /// 空 = 用这个出口已存的密钥（改地址时不用重抄），再空 = 用线路的。
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub id: Option<uuid::Uuid>,
}

/// `POST /api/admin/route-endpoints/available` —— 问这个中转「你有哪些模型」。
///
/// 和线路那边的「拉取可用模型」是同一件事，但这里必须能在**保存之前**拉：出口的价值
/// 就在于「这家有没有我要的那几个模型」，先存再看等于先把一个不知道行不行的出口放进
/// 候选池。
///
/// 回四组，不是交集。**这里曾经只回交集，后来推翻了**：出口的价值有一半就在于
/// 「这家多了两款线路没有的货」，只回交集等于把那一半藏起来，运维在界面上永远勾不到。
///
///   · `here`           —— 线路开放 ∩ 这家有
///   · `missing`        —— 线路开放，但这家没有（派过去只会撞 404）
///   · `extra`          —— 这家有、线路没有，且**算得出价格** → 勾上就新增到 IDE 列表
///   · `extra_no_price` —— 同上但算不出价格
///
/// `extra` 和 `extra_no_price` 分两堆，是因为算不出价的开放出去等于白送：用户一分不付，
/// 上游照收你的钱（见 `priceable`）。分好之后界面把后者标红、勾不动，并在同一行给一个
/// 填价框 —— 而不是等运维保存时才报一句错，或者更糟：让那个模型凭空消失。
pub async fn admin_available(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<AvailableReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let base_url = clean_url(&req.base_url)?;
    let route: Option<Model> = sqlx::query_as("SELECT * FROM models WHERE id = $1")
        .bind(req.route_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(route) = route else {
        return Err(AppError::bad("线路不存在"));
    };

    let key = if !req.api_key.trim().is_empty() {
        req.api_key.trim().to_string()
    } else {
        let stored: Option<String> = match req.id {
            Some(id) => sqlx::query_scalar("SELECT api_key FROM route_endpoints WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.db)
                .await?,
            None => None,
        };
        match stored.filter(|k| !k.trim().is_empty()) {
            Some(k) => crate::models::model_key(&k),
            None => crate::models::model_key(&route.api_key),
        }
    };

    let url = format!("{}/models", crate::models::api_base(&base_url));
    let resp = probe_client()
        .get(&url)
        .header("authorization", format!("Bearer {key}"))
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        // 和探测同一条规矩：不回显 reqwest 的错误原文，它带完整 URL，
        // 而有些转卖商要求把密钥写在查询串里。
        .map_err(|_| AppError::bad("连不上这个地址（域名、端口或网络不对）"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(AppError::bad(match status {
            401 | 403 => "密钥被拒（401/403）".to_string(),
            404 => "这个地址没有 /models 接口（有些中转不提供，可以直接手动勾选）".to_string(),
            _ => format!("上游返回 {status}"),
        }));
    }
    let data: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let ids: Vec<String> = crate::models::parse_model_ids(&data);
    let allowed = crate::models::allowed_ids(&route);
    let here: Vec<String> = allowed.iter().filter(|m| ids.contains(m)).cloned().collect();
    let missing: Vec<String> = allowed.iter().filter(|m| !ids.contains(m)).cloned().collect();
    // 这家有、而线路没有的 —— 勾上就会**新增**到 IDE 的模型列表里。
    //
    // 分成能开放和不能开放两堆：算不出价格的开放出去，用户一分不付而上游照收你的钱。
    // 所以这里先替运维把这件事分好，而不是等他保存时才报错。
    let (extra_ok, extra_no_price): (Vec<String>, Vec<String>) = ids
        .iter()
        .filter(|m| !allowed.contains(m))
        .cloned()
        .partition(|m| priceable(&route, m));
    Ok(Json(serde_json::json!({
        "here": here,
        "missing": missing,
        "extra": extra_ok,
        "extra_no_price": extra_no_price,
        "upstream_total": ids.len(),
    })))
}

/// `DELETE /api/admin/route-endpoints/:id`
pub async fn admin_delete(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let n = sqlx::query("DELETE FROM route_endpoints WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    Ok(Json(serde_json::json!({ "deleted": n })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一个中转地址挂多个账号，必须能各挂一个出口。
    ///
    /// 原来的唯一索引是 `(route_id, lower(base_url))`，把「同地址、不同密钥」也一起挡了。
    /// 那是完全正当的用法：同一家转卖商开几个账号是常态，每个账号有自己的余额、限速、
    /// 封禁状态 —— 而且恰恰是故障转移最有价值的那种（额度耗尽、密钥失效都是**按密钥**
    /// 发生的，换密钥能救、换地址救不了）。运维手上几个同址账号一个都用不上。
    #[test]
    fn the_same_relay_with_different_keys_is_not_a_duplicate() {
        let a = key_fingerprint("sk-account-one");
        let b = key_fingerprint("sk-account-two");
        assert_ne!(a, b, "两把不同的密钥指纹相同 —— 同址多账号还是挂不上");
        assert!(!a.is_empty());
        assert_eq!(a.len(), 32, "指纹长度不该变（列宽和索引都按它算）");

        // 确定性：同一把密钥两次算出来必须一样，否则唯一约束永远不命中。
        // 这正是不能直接对密文列建索引的原因 —— field_crypto 每次用新的随机 nonce。
        assert_eq!(a, key_fingerprint("sk-account-one"));
        // 前后空白不算差别（表单里粘贴常带一个换行）。
        assert_eq!(a, key_fingerprint("  sk-account-one\n"));

        // 真正的重复仍然要拦：同地址 + 都不填密钥 = 同一个上游粘了两遍。
        assert_eq!(key_fingerprint(""), "");
        assert_eq!(key_fingerprint("   "), "");

        // 存的是哈希不是明文：这一列会进备份、日志和 SELECT *。
        assert!(!a.contains("sk-"), "指纹里带上了密钥原文");
    }

    /// 唯一约束、写入路径、回填三处必须说的是同一件事。
    ///
    /// 少任何一处这道约束就静默失效：索引还在「地址」上 → 同址多账号仍然挂不上；
    /// 写入不算指纹 → 所有行都是空指纹，同址同密钥反而挡不住；
    /// 不回填 → 存量行永远是空指纹，拿它去和新行的真指纹比，重复漏过去。
    #[test]
    fn the_uniqueness_criterion_is_wired_in_all_three_places() {
        let migration = include_str!("../migrations/20260870_route_endpoint_key_fp.sql");
        assert!(
            migration.contains("(route_id, lower(base_url), key_fp)"),
            "唯一索引没把密钥指纹算进去 —— 同址多账号仍然挂不上"
        );
        assert!(
            migration.contains("DROP INDEX IF EXISTS idx_route_endpoints_unique_url"),
            "旧的「只按地址」那条索引没删 —— 它还在，新索引救不了"
        );

        let raw = include_str!("route_endpoints.rs");
        // 边界按**行首的那个属性**找，不用 rfind("#[cfg(test)]")：那个字符串在本测试
        // 自己的源码里也出现（就是这一行），rfind 会锚到它身上，于是切出来的"产品代码"
        // 反而把整段测试包了进去 —— 下面每一条反向断言都会被自己的文本喂到。
        let src = &raw[..raw.find("\n#[cfg(test)]\nmod ").map(|i| i + 1).unwrap_or(raw.len())];
        assert!(
            src.contains("key_fp) \\\n                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)"),
            "新建出口没写指纹 —— 所有新行都是空指纹，同址同密钥反而挡不住"
        );
        assert!(src.contains("key_fp = $13"), "改出口没写指纹");
        // SQL 里有这一列，不等于**绑进去的是指纹**。绑一个空串同样编译、同样通过列名
        // 断言，而结果是所有行都空指纹 —— 同址同密钥反而挡不住，方向正好反了。
        assert!(
            src.contains(".bind(key_fingerprint(&req.api_key))"),
            "新建出口那一处绑的不是指纹"
        );
        assert!(
            src.contains(".bind(&key_fp)"),
            "改出口那一处绑的不是指纹"
        );
        // 改出口时「密钥空着 = 沿用原值」，指纹必须跟着沿用，否则一次「只改地址」的保存
        // 会把指纹清空，这一行就变成「空密钥」参与去重 —— 而它其实有密钥。
        assert!(
            src.contains("let key_fp = if req.api_key.trim().is_empty() {\n                keep_fp\n            } else {\n                key_fingerprint(&req.api_key)\n            };"),
            "指纹没和密钥同进同退 —— 一次「只改地址」的保存会把它清成空"
        );
        assert!(
            src.contains("pub fn spawn_key_fp_backfill"),
            "没有存量回填 —— 旧行永远是空指纹，和新行的真指纹比不出重复"
        );
        // 回填必须用 decrypt_or_raw：FIELD_ENC_KEY 是后配的，库里明文密文混着，
        // 用 decrypt 的话明文行直接报错跳过，永远补不上。
        // 回填的解密必须走 model_key：decrypt_or_raw 在解不开时返回**密文本身**，
        // 会算出一个稳定但错误的指纹并永久存进库 —— 同一把密钥的两行密文不同、指纹
        // 也就不同，重复照样漏过去，而且再也没有征兆。
        assert!(
            src.contains("let plain = crate::models::model_key(&stored);"),
            "回填没走 model_key"
        );
        // 钉的是**调用形式**（带括号），不是这个名字：产品代码和这条断言自己的注释里
        // 都逐字写着这个名字（在解释为什么不用它），按名字断言会被自己的注释喂到。
        assert!(
            !src.contains("decrypt_or_raw("),
            "回填用了解不开就返回密文的那个 —— 会把密文的指纹永久存进库"
        );
        // 回填要挂在启动上，不然它存在也白存在。
        let main_rs = include_str!("main.rs");
        assert!(
            main_rs.contains("route_endpoints::spawn_key_fp_backfill(state.clone());"),
            "回填没有调用点"
        );
    }

    /// 撞了唯一约束时，那句话必须说清「同址不同密钥是可以的」。
    ///
    /// 原文案是「这条线路下已经有同样的中转地址了」—— 运维照字面读会以为同址账号根本
    /// 挂不上去，然后放弃，而那正是故障转移最有价值的一种配置。
    #[test]
    fn the_duplicate_message_says_a_different_key_is_allowed() {
        let raw = include_str!("route_endpoints.rs");
        // 边界按**行首的那个属性**找，不用 rfind("#[cfg(test)]")：那个字符串在本测试
        // 自己的源码里也出现（就是这一行），rfind 会锚到它身上，于是切出来的"产品代码"
        // 反而把整段测试包了进去 —— 下面每一条反向断言都会被自己的文本喂到。
        let src = &raw[..raw.find("\n#[cfg(test)]\nmod ").map(|i| i + 1).unwrap_or(raw.len())];
        // 按**结构边界**取函数体，不用固定窗口：固定窗口在函数变长时会静静地不再覆盖
        // 被断言的那几行（而且中文会切在字符中间直接 panic）。
        let at = src.find("fn dup_url").expect("dup_url 还在吧");
        let end = src[at..].find("\n}\n").map(|o| at + o).unwrap_or(src.len());
        let body = &src[at..end];
        assert!(body.contains("地址和密钥都相同"), "没说清判据是「地址 + 密钥」");
        assert!(body.contains("换一把密钥即可"), "没告诉运维下一步怎么办");
        assert!(
            !body.contains("已经有同样的中转地址了"),
            "还是旧文案 —— 会让人以为同址账号挂不上"
        );
    }

    /// 这个模块的源码（不含测试），用来钉住那些「读起来对、但一改就静默失效」的地方。
    fn src() -> String {
        let all = include_str!("route_endpoints.rs");
        // 断言字面量本身出现在测试里，扫描时必须先把测试段切掉，否则测试在自我印证。
        all.split("\n#[cfg(test)]").next().unwrap().to_string()
    }

    fn model(protocol: &str) -> Model {
        // 只填排序和展开会读到的字段，其余走 Default —— 这里测的是选路，不是计费。
        Model {
            id: uuid::Uuid::new_v4(),
            base_url: "https://own.example.com".into(),
            api_key: "own-key".into(),
            protocol: protocol.into(),
            enabled_models: vec!["claude-opus-5".into()],
            ..Model::blank()
        }
    }

    fn ep(cost: f64, probe: Option<bool>, url: &str) -> Endpoint {
        Endpoint {
            id: uuid::Uuid::new_v4(),
            balance_token: String::new(),
            last_ok_at: None,
            last_fail_at: None,
            real_sum: None,
            real_n: None,
            real_ok: None,
            real_bad: None,
            route_id: uuid::Uuid::nil(),
            label: String::new(),
            base_url: url.into(),
            api_key: "ep-key".into(),
            cost_ratio: cost,
            active: true,
            note: String::new(),
            probe_ok: probe,
            probe_at: None,
            probe_ms: None,
            probe_note: String::new(),
            enabled_models: Vec::new(),
            protocol: String::new(),
            capacity: None,
        }
    }

    /// 跨中转比价必须按**人民币**，不是按倍率。
    ///
    /// 线上现成的形状：Grok 这条线路的自带地址在 hanhegufei（倍率 1.0），挂的出口
    /// 在梦幻API（倍率 0.05）。按倍率排，梦幻便宜二十倍、稳排第一。但一块钱在两家
    /// 买到的余额差七十倍 —— 换算成人民币之后**顺序反过来**。
    ///
    /// 这条钉的就是这个反转：同一份配置，不填汇率是一个顺序，填了是另一个。
    /// 它同时钉住第三种情况——只填了一半时**不许**混着算。
    #[test]
    fn cross_relay_ranking_follows_real_money_not_the_multiplier() {
        let mut r = model("openai");
        r.base_url = "https://api.hanhegufei.online".into();
        let mut map = HashMap::new();
        map.insert(r.id, vec![ep(0.05, Some(true), "https://mhapi.net")]);
        let first = |routes: &[Model]| -> String {
            expand(routes, &map, &HashMap::new(), "claude-opus-5")
                .into_iter()
                .map(|m| m.base_url)
                .next()
                .expect("展开出来一个都没有")
        };

        // ① 一个都没填 —— 沿用旧行为，按倍率排，0.05 倍排第一。
        crate::relay_rates::set_for_test(&[]);
        assert_eq!(
            first(std::slice::from_ref(&r)),
            "https://mhapi.net",
            "没有汇率时必须和改造前一模一样（按倍率排）",
        );

        // ② 两家都填了。hanhegufei ¥1 买 10 额度、梦幻 ¥1 买 0.14 美元：
        //      hanhegufei: 1.0  / 10   = ¥0.100 每官方美元
        //      梦幻:       0.05 / 0.14 = ¥0.357 每官方美元
        //    真实成本差三倍半，而且和倍率给出的结论**相反**。
        crate::relay_rates::set_for_test(&[
            ("api.hanhegufei.online", 10.0),
            ("mhapi.net", 0.14),
        ]);
        assert_eq!(
            first(std::slice::from_ref(&r)),
            "https://api.hanhegufei.online",
            "换算成人民币之后自带地址才是便宜的那个，顺序必须反过来",
        );

        // ③ 只填了一半 —— 整条线路退回按倍率排。
        //    把没填的那家当成 1.0 顶上去是最糟的：那是拿「不知道」当「一比一」，
        //    而且不会有任何地方报错。
        //
        //    这里的 0.01 是**挑出来的**，不是随手写的。第一版用的是 0.14，那个数
        //    让「退回按倍率排」和「缺失当 1.0」给出同一个顺序 —— 于是这条断言
        //    在两种实现下都通过，等于什么都没测。故意把代码改坏跑一遍才看出来。
        //    0.01 让两者分叉：兜底成 1.0 的话梦幻算出 5.0、自带地址 1.0，自带地址排前面；
        //    而正确行为是整条退回按倍率排，梦幻（0.05 倍）排前面。
        crate::relay_rates::set_for_test(&[("mhapi.net", 0.01)]);
        assert_eq!(
            first(std::slice::from_ref(&r)),
            "https://mhapi.net",
            "缺一家汇率就该整条退回按倍率排，不许拿默认值把缺口补上",
        );

        crate::relay_rates::set_for_test(&[]);
    }

    /// 换算是**全有全无**的，缺一个不许拿默认值补。
    ///
    /// 上一条测的是行为，这一条钉的是写法：`Option<Vec<f64>>` 那个 collect 一旦被
    /// 改成逐个 `unwrap_or(1.0)`，行为退化得非常隐蔽 —— 排序照常有结果，只是把
    /// 「没填汇率」的站当成了一个极好的汇率，凭空排到前面。
    #[test]
    fn a_missing_exchange_rate_is_never_defaulted() {
        let me = src();
        assert!(
            me.contains("let converted: Option<Vec<f64>> = targets"),
            "全有全无那个 collect 没了 —— 换算很可能变成逐个兜底",
        );
        for banned in [
            "usd_per_cny(&m.base_url).unwrap_or(",
            "usd_per_cny(&m.base_url).unwrap_or_default()",
            "usd_per_cny(&m.base_url).unwrap_or_else(",
        ] {
            assert!(
                !me.contains(banned),
                "汇率缺失被兜底了（{banned}）—— 没填汇率的站会凭空排到最前面",
            );
        }
    }

    #[test]
    fn cheaper_endpoint_goes_first_but_only_when_it_works() {
        let now = chrono::Utc::now();
        // 派单真正用的排序键是 **(能用档, 综合得分)** —— 不是「档 / 慢 / 价」三级。
        // 这条测试跟着改了：拿旧三元组测出来的顺序和真正发生的不是一回事，
        // 而它照样会绿。
        let k = |ok, cost: f64| {
            (
                availability_tier(ok, Some(now), None, None, now),
                endpoint_score(cost, 0, 0, None, None),
            )
        };
        let lt = |a: (u8, f64), b: (u8, f64)| a.0 < b.0 || (a.0 == b.0 && a.1 < b.1);

        // 便宜且能用 → 排第一。
        assert!(lt(k(Some(true), 0.3), k(None, 1.0)));
        // 便宜但已知打不通 → 排到没测过的后面。这是最要紧的一条：反过来的话，
        // 每个请求都会先去撞那个便宜的死出口。
        assert!(lt(k(None, 1.0), k(Some(false), 0.1)));
        assert!(lt(k(Some(true), 1.0), k(Some(false), 0.1)));
        // 同一档里才比得分。没有任何样本时得分就是进价本身。
        assert!(lt(k(Some(true), 0.3), k(Some(true), 0.5)));
        // 得分再差也压不过「档」：一个慢又不稳的活出口仍然好过一个已知打不通的。
        let slow_flaky = (0u8, endpoint_score(0.9, 5, 45, Some(30_000), Some(1_000.0)));
        assert!(lt(slow_flaky, k(Some(false), 0.1)));
    }

    /// 成功率必须参与选路，而且是**闸**不是乘数。这是线上实测出来的缺陷。
    ///
    /// 2026-08-27 的 grok-4.6：
    /// ```text
    ///   寒鹤的小破站   149 成 / 2 败 = 99%   ¥0.20
    ///   Grok 自带地址   32 成 /12 败 = 73%   ¥0.10
    /// ```
    /// 老排序只看「能用档」，而那一档判的是**最近一次**是成是败 —— 分不出 99% 和 73%，
    /// 两个都算活着。于是便宜的自带地址排前面，每四发废一发，那一发用户白等
    /// （日志里那是「上游卡满整段预算才失败」，不是秒失败）。
    ///
    /// 纯按钱算先撞便宜的是划算的（期望 ¥0.127 对 ¥0.20），乘法惩罚也是这个结论 ——
    /// 所以这里必须是闸：那笔账没算用户的时间，而这个产品卖的就是流畅。
    #[test]
    fn a_flaky_endpoint_loses_to_a_reliable_one() {
        // 就是上面那组真实数字。
        assert!(is_reliable(149, 2), "99% 被判成不靠谱了");
        assert!(!is_reliable(32, 12), "73% 被判成靠谱了 —— 每四发白等一发");
        // 检验本身也要对，不然上面两条可能是碰巧的。
        assert!(confidently_below_floor(32, 44), "73% 没被判显著");
        assert!(!confidently_below_floor(149, 151), "99% 被判成显著偏低");
        assert!(!confidently_below_floor(8, 9), "8/9 被判成显著偏低");
        assert!(!confidently_below_floor(0, 0), "零样本被判成显著偏低");
        assert!(!confidently_below_floor(10, 10), "全成功被判成显著偏低");
        // 线上那两条真数字。
        assert!(confidently_below_floor(54, 81));
        assert!(confidently_below_floor(5, 11));

        // **大样本不能因为浮点下溢被判死。** 直接递推 pmf 时 (1-p)^n 在 n≈300 以上
        // 就下溢成 0，尾概率算成 0 —— 于是下面这些统计上完全正常的成绩会被判成
        // 「有把握它不行」。这个系统几百上千的样本几天就攒到了。
        assert!(!confidently_below_floor(890, 1000), "89%/1000 次被浮点下溢判死了");
        assert!(!confidently_below_floor(4900, 5000), "98%/5000 次被判死了");
        assert!(!confidently_below_floor(2900, 3000), "97%/3000 次被判死了");
        // 但大样本里**真的**偏低的还是要判出来。
        assert!(confidently_below_floor(800, 1000), "80%/1000 次没被判出来");
        assert!(confidently_below_floor(850, 1000), "85%/1000 次没被判出来");

        // 便宜十倍也翻不过这道闸：省下的那点钱换的是用户多卡一次。
        assert!(!is_reliable(32, 12));

        // **小样本一律算靠谱。** 判据是置信上界：证据不足时区间宽、上界高，
        // 自然判不动。这就是「没有证据不构成降级理由」在数字上的样子。
        assert!(is_reliable(0, 0), "一次都没跑过的被判成不靠谱");
        assert!(is_reliable(0, 1), "一次失败就把新出口判死了 —— 真是 90% 也有一成概率错一次");
        // 连错两次就够显著了：真是 90% 的话概率只有 1%。这是判据算出来的，不是拍的。
        // 而且它是**降级**不是除名 —— 靠谱的那批不行时照样会走到它，
        // 拿到一次成功（2/4）就自己恢复。
        assert!(!is_reliable(0, 2), "连错两次还算靠谱");
        assert!(!is_reliable(0, 3));
        // 恢复：错二成二之后，四次里成两次就重新算靠谱了。
        assert!(is_reliable(2, 2), "拿到成功之后没能恢复 —— 那会变成永久除名");
        // 线上真出现过的那条：8/9 = 89%，九次错一次，是噪声不是证据。
        assert!(is_reliable(8, 1), "8/9 = 89% 被判死了 —— 那是噪声，不是证据");
        // 89% 离 90% 太近，样本再多也判不出差别 —— 这是对的，它本来就没差多少。
        assert!(is_reliable(80, 10), "89% 被当成显著低于 90% 了");
        assert!(!is_reliable(0, 30), "三十次全败还算靠谱");
        // 但**同一档之内**由价钱和快慢说了算。
        let a = endpoint_score(0.20, 149, 2, None, None);
        let b = endpoint_score(0.50, 149, 2, None, None);
        assert!(a < b, "同样靠谱时便宜的没排前面");
    }

    /// 这道闸是「靠后」，不是「除名」。
    ///
    /// 靠谱的那批全打不通时，不靠谱的照样得能被用到 —— 否则一次上游集体抖动
    /// 会让整条线路直接没得走，那比慢一点糟得多。
    #[test]
    fn the_reliability_gate_only_demotes_never_removes() {
        // 排序键是三级的：(能用档, 可靠性档, 得分)。不靠谱只动第二级。
        let reliable_dead = (2u8, 0u8, 0.1_f64);
        let flaky_alive = (0u8, 1u8, 9.9_f64);
        assert!(flaky_alive < reliable_dead, "不靠谱但活着的，排到了已知打不通的后面");
        // 而且第二级压不过第一级 —— 「死」永远比「不稳」严重。
        let flaky = (0u8, 1u8, 0.1_f64);
        let dead_cheap = (2u8, 0u8, 0.001_f64);
        assert!(flaky < dead_cheap);
    }

    /// 样本不够就**不罚**，而且惩罚有上限。
    ///
    /// 不设门槛的话，一个刚上线、第一发正好撞上上游抖动的出口会被打成 0%，
    /// 然后再也拿不到流量，也就永远翻不了身。这和这个文件里那条一贯的规矩一样：
    /// 没有证据不构成降级理由。
    #[test]
    fn a_thin_sample_never_condemns_an_endpoint() {
        // 一成一败：样本不够，得分就是进价本身，一点不罚。
        assert_eq!(endpoint_score(0.5, 1, 1, None, None), 0.5);
        assert_eq!(endpoint_score(0.5, 0, MIN_RATE_SAMPLES - 1, None, None), 0.5);
        // 刚够门槛才开始罚。
        assert!(endpoint_score(0.5, 0, MIN_RATE_SAMPLES, None, None) > 0.5);
        // 罚有上限：全败也只按 MIN_RATE 算，不是无穷大。
        let worst = endpoint_score(0.5, 0, 100, None, None);
        assert!((worst - 0.5 / MIN_RATE).abs() < 1e-9, "全败的惩罚没有封底：{worst}");
        // 慢惩罚也有上限，而且是开方的：四倍慢罚两倍。
        let four_x = endpoint_score(1.0, 0, 0, Some(4_000), Some(1_000.0));
        assert!((four_x - 2.0).abs() < 1e-9, "四倍慢没有罚成两倍：{four_x}");
        let insane = endpoint_score(1.0, 0, 0, Some(10_000_000), Some(1.0));
        assert!((insane - MAX_SLOW_PENALTY).abs() < 1e-9, "慢惩罚没有封顶：{insane}");
        // 没有耗时证据 → 不罚。
        assert_eq!(endpoint_score(1.0, 0, 0, None, Some(1_000.0)), 1.0);
        assert_eq!(endpoint_score(1.0, 0, 0, Some(9_999), None), 1.0);
    }

    /// 派单排序真的读到了这个得分 —— 不然上面几条只是在测一个没人调用的函数。
    #[test]
    fn the_dispatch_order_uses_the_score() {
        let me = src();
        assert!(
            me.contains("k.2 = endpoint_score(k.2, ok, bad, *ms, best_ms);"),
            "派单排序没在用综合得分",
        );
        // 排序只比两级了：档 + 得分。中间那个二值的「慢」已经并进得分。
        // 三级：能用档 → 可靠性档 → 得分。少任何一级都会让某一维静默失效。
        assert!(
            me.contains(".then(a.0 .1.cmp(&b.0 .1)) // 靠谱的在前")
                && me.contains(".then(a.0 .2.partial_cmp(&b.0 .2).unwrap_or(std::cmp::Ordering::Equal)) // 得分小的在前"),
            "排序少了一级 —— 那一维不会起作用",
        );
        assert!(
            me.contains("k.1 = u8::from(!is_reliable(ok, bad));"),
            "可靠性档没在填 —— 那一级恒等于 0，等于没有",
        );
        // 得分要拿**换算后**的人民币成本当底：倍率跨站不可比。
        let at = me.find("k.2 = endpoint_score(").expect("得分那一步不见了");
        let conv = me.find("k.2 = c;").expect("换算那一步不见了");
        assert!(conv < at, "得分算在了汇率换算之前 —— 那是拿两种货币的数在比");
    }

    /// 每一处 `SUM(` 都必须显式 `::bigint`。
    ///
    /// Postgres 的 `SUM(bigint)` 回的是 **NUMERIC**，不是 bigint。按 `i64` 解码就会
    /// 报类型不符，而这个文件里两处查询的兜底都是「当作没有」：
    ///   - `load_for_routes` → 返回空 → **所有出口消失、多路由整个静默关掉**
    ///   - `admin_list`      → 空表 → 控制台每个出口都显示「无真实流量」
    /// 两处都不报错、不影响请求、只留一行 WARN。实测就是这么上线的，是从服务器日志里
    /// 才发现的 —— 没有任何测试会红，因为它是运行期解码失败，不是编译期。
    ///
    /// 所以这道闸按**源文本**判：带 `SUM(` 的行必须同时带 `::bigint`。文件里原有的
    /// 每一处本来就是这么写的，这条只是把已有的约定钉住。
    #[test]
    fn every_sum_is_cast_to_bigint() {
        let me = src();
        let bad: Vec<&str> = me
            .lines()
            .filter(|l| l.contains("SUM(") && !l.trim_start().starts_with("//"))
            .filter(|l| !l.contains("::bigint"))
            .collect();
        assert!(
            bad.is_empty(),
            "有 SUM() 没转成 bigint，解码会失败而调用处会静默当作「没有数据」：\n  {}",
            bad.join("\n  "),
        );
        // 判据得真的有东西可判 —— 查询被挪走或改写法的话这条会变成恒真。
        assert!(
            me.lines().filter(|l| l.contains("SUM(")).count() >= 8,
            "文件里几乎没有 SUM( 了，这道闸多半已经空转",
        );
    }

    /// 「慢不慢」也该拿真实流量说话，不是拿探测。
    ///
    /// 探测一轮只有一个样本、只发一句 hi、只用一个模型。真实流量量的是用户实际等的
    /// 那一段。线上这两个数差得很远：Grok 那个 0.005 倍的出口探测 19551ms、真实 27556ms
    /// —— 而这个数决定它要不要被降级，也就决定最便宜的出口能不能排到前面。
    #[test]
    fn the_slow_check_prefers_real_latency() {
        // 样本够 → 用真实的，哪怕探测数字好看得多。
        assert_eq!(effective_ms(Some(27556), Some(29), Some(19551)), Some(27556));
        // 样本不够 → 退回探测。一两次的均值不足以拿来降级一个出口。
        assert_eq!(effective_ms(Some(300), Some(MIN_REAL_SAMPLES - 1), Some(19551)), Some(19551));
        assert_eq!(effective_ms(Some(300), None, Some(19551)), Some(19551));
        // 一个真实样本都没有 → 探测是唯一的证据。
        assert_eq!(effective_ms(None, None, Some(4375)), Some(4375));
        // 两边都没有 → 就是不知道，**不降级**。没有证据不构成降级理由。
        assert_eq!(effective_ms(None, None, None), None);
        assert!(!is_egregiously_slow(effective_ms(None, None, None), Some(1000.0)));
        // 真实均值是 0（不该出现，但别让它变成「快得离谱」把别人全比下去）。
        assert_eq!(effective_ms(Some(0), Some(99), Some(4375)), Some(4375));

        // 排序真的读到了它 —— 不然上面几条只是在测一个没人调用的函数。
        let me = src();
        assert!(
            me.contains("effective_ms(e.real_ttfb_ms(), e.real_n, e.probe_ms),"),
            "派单排序还在直接用 probe_ms —— 真实耗时算了也没人用",
        );
    }

    /// 探测必须走流式，而且只等第一帧。
    ///
    /// 非流式探推理模型永远探不出来：`max_tokens: 1` 拦不住思考，模型把整段思考走完
    /// 才吐第一个字节，20 秒不够。这条一旦被改回非流式，症状是**探测全线变红**而
    /// 代码毫无报错 —— 而且假红的是最便宜那几个出口，钱就是从这儿漏的。
    #[test]
    fn the_probe_streams_and_stops_at_the_first_frame() {
        let me = src();
        assert!(
            me.contains(r#"o.insert("stream".into(), serde_json::Value::Bool(true));"#),
            "探测的请求体没开流式 —— 推理模型会被一律探成超时",
        );
        assert!(
            me.contains("tokio::time::timeout(dur, resp.chunk()).await"),
            "探测没在按帧读 —— 一旦改回整段读完，等的就是「生成完要多久」而不是首字",
        );
        // 拿到形状就走人，不把整段生成读完。
        assert!(
            me.contains("if looks_like_a_real_stream(&head) {"),
            "第一帧到了没有立刻定案",
        );
        // 不认流式的站必须退回非流式，不能判死。
        assert!(
            me.contains("StreamProbe::Unsupported => {}"),
            "不支持流式的出口会被当成打不通判死 —— 那是把好出口错杀",
        );
        // 退路要真的走得通：这几个码分不出「不认 stream 参数」和「请求体本身不对」，
        // 必须退回非流式让原来那套给结论。少了这一行，一个只转发非流式的中转会被
        // 判成「上游返回 400」永远红着 —— 而它其实好好的。
        assert!(
            me.contains("if matches!(status, 400 | 404 | 422 | 501) {"),
            "流式被拒时没有退回非流式 —— 只转发非流式的中转会被永久判死",
        );
    }

    /// 流式第一帧照样要判**形状**，不能「有字节就算通」。
    ///
    /// 转卖网关的错误页也回 200。只认「有回应」的话那种站会被探成绿灯，然后按最好档
    /// 接管真实流量，每一发都失败 —— 比探成红灯糟得多。
    #[test]
    fn a_200_that_is_not_a_stream_is_not_a_pass() {
        // 真的流：OpenAI 系的 delta、Anthropic 系的事件名。
        assert!(looks_like_a_real_stream(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"
        ));
        assert!(looks_like_a_real_stream("event: message_start\ndata: {\"type\":\"message_start\"}\n"));
        // 半截 JSON（chunk 不保证切在帧边界上）也得认，否则健康的站被随机判死。
        assert!(looks_like_a_real_stream("data: {\"id\":\"x\",\"choices\":[{\"delta\""));

        // 不是流的一律不通过。
        assert!(!looks_like_a_real_stream(""));
        assert!(!looks_like_a_real_stream("<html><body>502 Bad Gateway</body></html>"));
        assert!(!looks_like_a_real_stream("{\"error\":\"insufficient balance\"}"));
        // 只有结束帧 = 一个字都没生成出来，不算通。
        assert!(!looks_like_a_real_stream("data: [DONE]\n\n"));
        // 心跳注释不是数据帧。
        assert!(!looks_like_a_real_stream(": ping\n\n"));
    }

    /// 真实流量的结果盖过探测的结论。
    ///
    /// 线上实测的形状：「梦幻API」三个出口探测全部 20001ms 超时被判死，同一天却
    /// 接了 241 次真实请求全部成功。它们又恰好是最便宜的（进价系数 0.15 / 0.24，
    /// 还活着的那些是 0.6）—— 于是多路由该省的钱一分没省。合成探测超时和
    /// 「这个出口打不通」是两件事，真实成功才是执行事实。
    #[test]
    fn a_real_success_outranks_a_failed_probe() {
        let now = chrono::Utc::now();
        let ago = |sec: i64| Some(now - chrono::Duration::seconds(sec));
        let t = |ok, real_ok, real_fail| availability_tier(ok, Some(now), real_ok, real_fail, now);

        // 探测判死、但刚刚真的成功过 → 最好档。这一条就是线上那个形状。
        assert_eq!(t(Some(false), ago(60), None), 0, "探测判死盖不过真实成功");
        // 探测没测过、真实成功过 → 一样进最好档。
        assert_eq!(t(None, ago(60), None), 0);

        // 真实失败同样算数，而且盖得过「探测说通了」—— 真实结果两个方向都硬。
        assert_eq!(t(Some(true), None, ago(60)), 2, "真实失败盖不过探测说通了");

        // 两边都有真实记录 → 听较晚的那个：它才是这个出口现在的样子。
        assert_eq!(t(Some(false), ago(60), ago(600)), 0, "较新的真实成功该说了算");
        assert_eq!(t(Some(true), ago(600), ago(60)), 2, "较新的真实失败该说了算");

        // 真实记录过期就不算数，退回看探测 —— 和探测结论用的是同一把保质期的尺。
        let old = Some(now - chrono::Duration::seconds(PROBE_FRESH_SECS + 60));
        assert_eq!(t(Some(false), old, None), 2, "三小时前的成功不能继续顶着");
        assert_eq!(t(Some(true), None, old), 0, "三小时前的失败也不该继续压着");
    }

    /// 只认真实成功会变成棘轮，所以真实失败也得记。
    ///
    /// 假如只有 `last_ok_at`：出口失败一次被埋到最差档 → 拿不到流量 → 刷新不了
    /// 成功记录 → 永远埋着，连自我恢复的机会都没有。两列都在，最近一次真实结果
    /// 才说得出它此刻是活是死。
    #[test]
    fn a_recovered_endpoint_can_climb_back_out() {
        let now = chrono::Utc::now();
        let ago = |sec: i64| Some(now - chrono::Duration::seconds(sec));
        // 十分钟前失败过，一分钟前又成功了 → 回到最好档，不是永远背着那次失败。
        assert_eq!(availability_tier(Some(false), Some(now), ago(60), ago(600), now), 0);

        // 写法闸：两列必须都落库、都读出来。少一列就是上面那个棘轮。
        let hs = std::fs::read_to_string("src/route_health.rs").unwrap();
        assert!(
            hs.contains("last_fail_at") && hs.contains("last_ok_at"),
            "route_attempt 没在记真实成功/失败的时刻 —— 排序会退回只信探测",
        );
        let me = src();
        assert!(
            me.contains("SELECT e.*, a.last_ok_at, a.last_fail_at, a.real_sum, a.real_n"),
            "派单装载出口时没把真实流量证据连出来 —— 那几列写了也没人读。\
             （断言钉的是装载那句 SELECT 本身：`MAX(last_ok_at)` 在 admin_list 里也有一份，\
             拿它当锚点的话，把装载这边删干净了测试照样绿。）",
        );
    }

    /// 陈旧的「测通了」不是「测通了」。
    ///
    /// 探测每 15 分钟一轮。三天前那次成功不能继续把这个出口钉在第一档 ——
    /// 那和 `route_health::classify` 里「上次成功已经旧了就退回不知道」是同一条规矩。
    /// 没记时间的老行按新鲜处理：把它们一律降档等于在升级那一刻把所有出口降一级。
    #[test]
    fn a_stale_probe_stops_counting_as_evidence() {
        let now = chrono::Utc::now();
        let fresh = now - chrono::Duration::seconds(PROBE_FRESH_SECS / 2);
        let stale = now - chrono::Duration::seconds(PROBE_FRESH_SECS + 60);
        assert_eq!(availability_tier(Some(true), Some(fresh), None, None, now), 0);
        assert_eq!(availability_tier(Some(true), Some(stale), None, None, now), 1, "陈旧的好消息不是好消息");
        assert_eq!(availability_tier(Some(true), None, None, None, now), 0, "没记时间的老行不该被降档");
        // 失败就是失败，不看新鲜度：坏消息过期不会自己变好。
        assert_eq!(availability_tier(Some(false), Some(stale), None, None, now), 2);
        assert_eq!(availability_tier(None, None, None, None, now), 1);
    }

    /// 前端那份判据必须和这边**逐字**对齐。
    ///
    /// 多路由那一屏不是显示服务端排好的顺序，而是拿同一套判据**自己重算**一遍
    /// （为了在保存之前就能看到「改成 0.3 倍会排第几」）。也就是说那里有一份
    /// TypeScript 副本。两边一旦分叉，那一屏显示的顺序就不是真正会发生的顺序 ——
    /// 而它看起来完全正常，没有任何地方会报错。
    #[test]
    fn the_console_mirrors_the_same_ranking_criteria() {
        let ui = include_str!("../admin-ui/src/pages/RouteEndpoints.tsx");
        // 两边的数必须同时改。只断言前端有这一行、不断言后端的值，
        // 改了后端就照样漏过去。
        assert_eq!(PROBE_FRESH_SECS, 2 * 60 * 60);
        assert!(
            ui.contains("const PROBE_FRESH_SECS = 2 * 60 * 60;"),
            "前端的探测保质期和服务端对不上了",
        );
        assert_eq!(SLOW_FACTOR, 3.0);
        assert!(ui.contains("const SLOW_FACTOR = 3;"), "前端的慢速倍数对不上了");
        assert_eq!(SLOW_FLOOR_MS, 5_000.0);
        assert!(ui.contains("const SLOW_FLOOR_MS = 5000;"), "前端的慢速地板对不上了");

        // 三级排序，不是两级。少一级的话前端画出来的顺序里「慢」这一档不存在。
        assert!(
            ui.contains("a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]"),
            "前端还在按两级排 —— 它显示的顺序和真正发生的不是一回事",
        );

        // 「一个请求最多换 2 个出口」那道闸已经拆了。前端只要还留着这个常量，
        // 界面上就还写着那句话，而那句话现在是**假的** —— 用户会照着它只配两个。
        assert!(
            !ui.contains("TRIED_PER_REQUEST"),
            "前端还留着「最多试两个」的常量和文案，而那道闸已经不存在了",
        );

        // 「真实结果盖过探测」这一条也必须两边一致。它是最容易悄悄分叉的一块 ——
        // 后端改完排序，前端那一屏照旧按探测画，于是界面上一个红徽章的出口
        // 稳稳排在第一位，看着像排序坏了，其实是两份判据不是一份。
        //
        // 断言挑的是实现形状不是说明词：这段的注释里就写着 last_ok_at，
        // 拿词去匹配会匹配到注释本身，删掉实现照样绿。
        let code = {
            let mut out = String::new();
            let mut rest = ui;
            while let Some(a) = rest.find("/*") {
                out.push_str(&rest[..a]);
                rest = match rest[a..].find("*/") {
                    Some(b) => &rest[a + b + 2..],
                    None => "",
                };
            }
            out.push_str(rest);
            out
        };
        for shape in [
            "const ok = freshReal(e.last_ok_at);",
            "const fail = freshReal(e.last_fail_at);",
            "if (ok != null && fail != null) return ok >= fail ? 0 : 2;",
        ] {
            assert!(
                code.contains(shape),
                "前端的档位判据没在看真实流量（缺 `{shape}`）—— 它画的顺序和真正会发生的不是一回事",
            );
        }
        // 可靠性那道闸和综合得分也必须两边一致。这一屏就是运维判断「谁会被先用」
        // 的地方，判据分叉了它画的顺序就不是真正会发生的 —— 而它看起来完全正常。
        assert_eq!(MIN_RATE_SAMPLES, 8);
        assert_eq!(RELIABLE_FLOOR, 0.9);
        assert_eq!(MIN_RATE, 0.2);
        assert_eq!(MAX_SLOW_PENALTY, 3.0);
        for shape in [
            "const MIN_RATE_SAMPLES = 8;",
            "const RELIABLE_FLOOR = 0.9;",
            "const MIN_RATE = 0.2;",
            "const MAX_SLOW_PENALTY = 3;",
            "return !confidentlyBelowFloor(e.rate_ok, e.rate_ok + e.rate_bad);",
            "if (k / n >= p) return false;",
            "const step = (i: number) => Math.log((n - i + 1) / i) + logp - logq;",
            "return maxLp + Math.log(sum) < Math.log(0.05);",
            "score /= Math.min(1, Math.max(MIN_RATE, e.rate_ok / total));",
            "score *= Math.min(MAX_SLOW_PENALTY, Math.sqrt(Math.max(1, ms / bestMs)));",
            "isReliable(e) ? 0 : 1,",
            "endpointScore(cost.of(e), e, bestMs),",
        ] {
            assert!(
                code.contains(shape),
                "前端的选路判据和服务端对不上了（缺 `{shape}`）—— 它画的顺序不是真正会发生的",
            );
        }
        // 前端必须读**派单窗口**那两个数，不能拿 7 天的成绩单去算排序。
        assert!(
            code.contains("rate_ok: number;") && code.contains("rate_bad: number;"),
            "前端没接派单窗口的成败数 —— 会拿另一个窗口的数画顺序",
        );

        // 「便宜」这一维比的是**换算后的人民币成本**，不是倍率。这一条前端原来是错的：
        // 它按 cost_ratio 排，而服务端按换算值排，于是 GPT 线路上界面说首选是
        // 「梦幻API 0.15 倍」，真正走的却是 WE API（换算后 ¥0.016 对 ¥0.15，差十倍
        // 且方向相反）。这一屏就是运维用来判断「哪个便宜」的地方，排错了等于没有。
        assert!(
            code.contains("if (all.every((v): v is number => v != null && Number.isFinite(v))) {"),
            "前端没在按换算后的成本排 —— 倍率跨站不可比，它画的顺序会是错的",
        );
        assert!(
            code.contains("return { own: 1, of: (e) => e.cost_ratio };"),
            "前端缺少「有一个站没填汇率就整条退回按倍率排」的退路 —— 服务端是全有全无的",
        );
        // 成本项要走换算（`cost.of(e)`），而且要包在得分里 —— 两件事一句钉住。
        assert!(
            code.contains("        endpointScore(cost.of(e), e, bestMs),"),
            "前端排序键里的成本项没走换算或没进得分 —— 它画的顺序不是真正会发生的",
        );
        // 自带地址：成本项要换算，可靠性档要用**真实成败**。
        //
        // 这条原来钉的是字面量 `{ k: [0, 0, cost.own], v: null }`。它的本意（看失败文案）
        // 是「自带地址也要换算」，可它顺带把中间那个 0 一起锁死了 —— 而那个 0 是错的：
        // 服务端 `expand()` 从 `load_own_rates` 真读得到自带地址的成败并据此判它的可靠性档
        // （`rate_of.push(own_rates...)` 那一行），前端却只能硬写 0 = 永远算靠谱。
        // 于是屏上自带地址满亮度排在前面，而派单可能正把它整档往后压。
        // 现在服务端把 own_rate_ok/own_rate_bad 一起下发，前端按同一个 `isReliable` 判。
        assert!(
            code.contains("cost.own"),
            "线路自带地址还按常量 1 参与比价 —— 它也要换算，否则和出口不是一把尺",
        );
        assert!(
            code.contains("isReliable({ rate_ok: r.own_rate_ok, rate_bad: r.own_rate_bad })"),
            "自带地址的可靠性档还是硬写的 —— 它在屏上会永远算靠谱，而派单未必这么看",
        );
        // 服务端得真把这两个数下发出去，否则上面那一行只是读到两个 undefined。
        // 这个测试模块里 `src` 是个辅助函数（取源码文本），不是变量。
        let whole = src();
        let prod = &whole[..whole.find("\nmod tests").unwrap_or(whole.len())];
        assert!(
            prod.contains("pub own_rate_ok: i64,") && prod.contains("pub own_rate_bad: i64,"),
            "RouteOut 没下发自带地址的成败，前端那条判据会读到 undefined",
        );
        assert!(
            prod.contains("pub effective_models: Vec<String>,"),
            "RouteOut 没下发 effective_models —— 模型选择器里会缺掉「只由出口带进来」的那些，\
             而它们恰恰是排序最容易出错的",
        );
        // 这一屏必须能按模型看：派单是逐模型决定的（出口按 enabled_models 筛），
        // 只画一份「这条线路的顺序」等于把所有模型的答案糊成一个。
        assert!(
            code.contains("function ordered(r: Route, modelId = \"\")")
                && code.contains("function servesModel(r: Route, e: Endpoint, modelId: string)"),
            "前端排序不按模型筛 —— 屏上会混进对这个模型根本不是候选的出口，名次的分母也是错的",
        );

        // 「慢不慢」用哪个耗时也必须两边一致，否则这一屏画的降级和真正发生的对不上。
        assert_eq!(MIN_REAL_SAMPLES, 5);
        assert!(
            code.contains("const MIN_REAL_SAMPLES = 5;"),
            "前端的真实样本门槛和服务端对不上了",
        );
        assert!(
            code.contains("if (e.real_n >= MIN_REAL_SAMPLES && e.real_ms != null && e.real_ms > 0) return e.real_ms;"),
            "前端判快慢还在用探测耗时 —— 它画的降级和真正发生的不是一回事",
        );

        // 真实证据也要过保质期这道尺，和服务端同一个常量。
        assert!(
            code.contains("now - t > PROBE_FRESH_SECS * 1000) return null;"),
            "前端的真实证据没设保质期 —— 三天前成功过的出口会一直顶在第一档",
        );
    }

    /// 「慢得离谱」两个条件必须同时成立。
    #[test]
    fn only_egregiously_slow_outlets_are_demoted() {
        // 比最快的慢 3.2 倍，而且自己 8 秒 → 降级。这就是线上梦幻API 那条 7994ms
        // 和 2943ms 并存的形状。
        assert!(is_egregiously_slow(Some(8000), Some(2500.0)));
        // 慢三倍多，但自己才 3 秒 —— 用户根本感觉不出来，不该为此让出首选。
        assert!(!is_egregiously_slow(Some(3000), Some(900.0)));
        // 自己 8 秒，但全场最快的也要 6 秒 —— 整条线路就是慢，降级等于没降。
        assert!(!is_egregiously_slow(Some(8000), Some(6000.0)));
        // 没有证据不构成降级理由（线路自带地址在探测表里没有行）。
        assert!(!is_egregiously_slow(None, Some(1000.0)));
        assert!(!is_egregiously_slow(Some(9000), None));
    }

    /// 同价位时直连要留在前面。
    ///
    /// 这一条钉的是一个真出现过的判据错误：线路自带地址在这张表里没有行，探测结论
    /// 无处可存，于是它曾经永远停在「还没测过」那一档 —— 加一个**原价**的备用中转，
    /// 只要它测通就把直连整个顶掉，白多一跳、多一个第三方，而界面上看不出为什么。
    #[test]
    fn a_same_price_relay_does_not_displace_the_direct_connection() {
        let r = model("anthropic");
        let mut map = HashMap::new();
        map.insert(
            r.id,
            vec![
                // 原价、测通 —— 不该越过直连。
                ep(1.0, Some(true), "https://same-price.example.com"),
                // 便宜、测通 —— 应该越过直连。
                ep(0.4, Some(true), "https://cheaper.example.com"),
            ],
        );
        let urls: Vec<String> = expand(&[r], &map, &HashMap::new(), "claude-opus-5").into_iter().map(|m| m.base_url).collect();
        assert_eq!(
            urls,
            vec![
                "https://cheaper.example.com",   // 真便宜，越过直连
                "https://own.example.com",       // 直连：同价位在任者优先
                "https://same-price.example.com" // 原价转卖：没有理由排到直连前面
            ]
        );
    }

    /// **线路自带地址的成功率也要算。** 最初暴露这个问题的就是它。
    ///
    /// 它的成败记在 `route_attempt` 里、键是线路 id，而装载出口那张表连不到它。
    /// 不单独取一次的话，自带地址永远「没有样本」＝永远算靠谱 —— 于是线上
    /// Grok 自带地址（73%，比同线路 99% 的出口便宜一半）稳稳排第一，每四发废一发。
    /// 这条测的就是那个形状。
    #[test]
    fn the_direct_connection_is_judged_on_its_success_rate_too() {
        let r = model("anthropic");
        let mut map = HashMap::new();
        // 贵一倍、但很稳的出口。
        map.insert(r.id, vec![ep(2.0, Some(true), "https://reliable.example.com")]);

        // 没有成绩时：自带地址便宜，排第一。这是改动前后都该成立的。
        let urls: Vec<String> = expand(&[r.clone()], &map, &HashMap::new(), "claude-opus-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(urls[0], "https://own.example.com", "没有成绩时便宜的自带地址就该排第一");

        // 给自带地址一份 73% 的成绩（线上那个真实数字）→ 它该让位给稳的那个。
        let mut own_rates = HashMap::new();
        own_rates.insert(r.id, (32i64, 12i64));
        let urls: Vec<String> = expand(&[r.clone()], &map, &own_rates, "claude-opus-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(
            urls[0], "https://reliable.example.com",
            "自带地址 73% 还排在 99% 的出口前面 —— 它的成绩根本没被读到",
        );

        // 样本不够时不许判：一两次失败不构成降级理由。
        let mut thin = HashMap::new();
        thin.insert(r.id, (0i64, 1i64));
        let urls: Vec<String> = expand(&[r], &map, &thin, "claude-opus-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(urls[0], "https://own.example.com", "一次失败就把自带地址判死了");
    }

    /// 派单那一处真的把自带地址的成绩取出来并传进去了。
    ///
    /// 上面那条测的是 `expand` 收到成绩后的行为；这条钉的是**调用点真的去取了** ——
    /// 少了这一步，上面那条照样全绿，而线上自带地址永远是「没有样本」。
    #[test]
    fn the_dispatch_path_loads_the_direct_connection_rates() {
        let m = include_str!("models.rs");
        assert!(
            m.contains("let own_rates = crate::route_endpoints::load_own_rates("),
            "派单时没去取自带地址的成绩 —— 它会永远算靠谱",
        );
        assert!(
            m.contains("crate::route_endpoints::expand(&candidates, &endpoint_map, &own_rates, &model_id)"),
            "取了成绩却没传给 expand",
        );
    }

    /// 直连不会因为「没测过」就被判到失败出口后面。
    #[test]
    fn the_direct_connection_outranks_a_broken_relay_however_cheap() {
        let r = model("anthropic");
        let mut map = HashMap::new();
        map.insert(r.id, vec![ep(0.05, Some(false), "https://broken-but-cheap.example.com")]);
        let urls: Vec<String> = expand(&[r], &map, &HashMap::new(), "claude-opus-5").into_iter().map(|m| m.base_url).collect();
        assert_eq!(urls[0], "https://own.example.com", "一折但打不通的出口抢到了第一位");
    }

    /// 成败数必须按**模型**统计，不能按出口合并。
    ///
    /// 合并的后果不是「不够精确」，是**诬告**：一个出口在别的模型上撞的 404，会让它在
    /// 这个模型上被判「试过、从来没成过」（`narrow_to_one_route` 据此跳过整条线路）、
    /// 被 `is_reliable` 整档后置、再吃最多 5 倍的价格惩罚 —— 三处都读这一对数。
    ///
    /// 2026-09-01 线上实测 deepseek 线路，查 `deepseek-v4-flash`（进价从便宜到贵）：
    ///
    ///     出口          进价   合并口径            该模型真值
    ///     (nvidia)      0.1    0/13               0/9      ← 真的坏
    ///     梦幻API       0.24   0/13               67/88   (76.1%)
    ///     OHub          0.6    0/12               98/112  (87.5%)
    ///     mixtoken      1.0    12/26              4/4
    ///     teamorouter   1.0    226/245            35/36   (97.2%)
    ///
    /// 修好之后的**准确**效果（不是「全都放行」）：
    ///   · OHub 从不可靠档升进可靠档 —— 它是第二便宜的，此前排在两个 1.0 倍的后面；
    ///   · 梦幻API 仍然判不可靠（76% 确实低于 90% 底线，那是产品判断，不是这条要改的），
    ///     但它不再是 `never_worked`，于是不会再让整条线路被跳过；
    ///   · 真的坏的那个（该模型 0/9）两项都照旧按住。
    /// 只断言「不再判死」会被一个「一律返回 true」的改动骗过去，所以三种方向都钉。
    #[test]
    fn success_rates_must_be_counted_per_model_not_merged_across_models() {
        // 合并口径：两个能用的出口都被判死。
        for (ok, bad) in [(0i64, 13i64), (0, 12)] {
            assert!(!super::is_reliable(ok, bad), "合并口径下 {ok}/{} 被判不可靠", ok + bad);
            assert!(ok == 0 && bad > 0, "合并口径下它还是 never_worked");
        }
        // 按模型统计之后。
        assert!(super::is_reliable(98, 14), "OHub 在 v4-flash 上 98/112(87.5%) 必须升进可靠档");
        assert!(
            !super::is_reliable(67, 21),
            "梦幻API 76% 确实低于 90% 底线 —— 这一条**故意**保持不可靠。\
             它要是变成可靠了，说明有人把可靠性判据一起改松了，而那是另一件事",
        );
        assert!(!super::is_reliable(0, 9), "该模型上 0 成 9 败的出口必须仍然判不可靠");

        // never_worked（narrow_to_one_route 的判据）：两个能用的不再是死的，坏的还是死的。
        let never_worked = |ok: i64, bad: i64| ok == 0 && bad > 0;
        assert!(!never_worked(67, 21) && !never_worked(98, 14), "按模型看它们都成功过");
        assert!(never_worked(0, 9), "真的坏的那个仍然是 never_worked");

        // ── 接线：纯函数对了不等于查询用了它 ──────────────────────────────
        // 两条 SQL 各要带模型闸，两个派单调用点各要把模型传下去。缺一处 bug 原样回来。
        let src = include_str!("route_endpoints.rs");
        let prod = &src[..src.find("\nmod tests").unwrap_or(src.len())];
        for (f, what) in [
            ("pub async fn load_own_rates(", "自带地址"),
            ("pub async fn load_for_routes_for_model(", "出口"),
        ] {
            let at = prod.find(f).unwrap_or_else(|| panic!("{f} 改名了"));
            let rest = &prod[at..];
            let end = rest
                .find("\npub async fn ")
                .or_else(|| rest.find("\npub fn "))
                .unwrap_or(rest.len());
            assert!(
                rest[..end].contains("($2::text IS NULL OR model_id = $2)"),
                "{what}那条查询丢了模型闸 —— 又变回跨模型合并了",
            );
        }
        let m = include_str!("models.rs");
        let mprod = &m[..m.find("\nmod billing_tests").unwrap_or(m.len())];
        assert!(
            mprod.contains("crate::route_endpoints::load_for_routes_for_model("),
            "派单没走 _for_model：查询修好了但调用点还在用全模型合计的那一版",
        );
        assert_eq!(
            mprod.matches("Some(&model_id),").count(),
            2,
            "派单路径上应当恰好有两处把模型传进成败统计（出口一处、自带地址一处）",
        );
    }

    #[test]
    fn expanding_a_route_without_endpoints_changes_nothing() {
        // 没配多路由的线路必须和今天一模一样：展开成一个出口，就是它自己。
        let r = model("anthropic");
        let out = expand(&[r.clone()], &HashMap::new(), &HashMap::new(), "claude-opus-5");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].base_url, "https://own.example.com");
        assert_eq!(out[0].api_key, "own-key");
        assert!(out[0].endpoint_id.is_none());
    }

    #[test]
    fn endpoints_never_change_the_price_fields() {
        // 这是整张表存在的理由：换出口不能换账单。
        let mut r = model("anthropic");
        r.input_price = 3.0;
        r.output_price = 15.0;
        r.rate = 2.0;
        r.billing_mode = "rate".into();
        r.per_call_cents = 7;
        let mut map = HashMap::new();
        map.insert(r.id, vec![ep(0.2, Some(true), "https://cheap.example.com")]);

        for m in expand(&[r.clone()], &map, &HashMap::new(), "claude-opus-5") {
            assert_eq!(m.input_price, 3.0, "出口改动了输入价");
            assert_eq!(m.output_price, 15.0, "出口改动了输出价");
            assert_eq!(m.rate, 2.0, "出口改动了倍率");
            assert_eq!(m.billing_mode, "rate", "出口改动了计费模式");
            assert_eq!(m.per_call_cents, 7, "出口改动了每次调用价");
            assert_eq!(m.id, r.id, "出口把线路身份换掉了——用量会记到别处");
            assert_eq!(m.enabled_models, r.enabled_models, "出口改动了开放模型");
        }
    }

    #[test]
    fn cheap_working_endpoint_outranks_the_routes_own_address() {
        let r = model("anthropic");
        let mut map = HashMap::new();
        map.insert(
            r.id,
            vec![
                ep(0.5, Some(true), "https://mid.example.com"),
                ep(0.2, Some(true), "https://cheap.example.com"),
                ep(0.1, Some(false), "https://broken.example.com"),
            ],
        );
        let out = expand(&[r], &map, &HashMap::new(), "claude-opus-5");
        let urls: Vec<&str> = out.iter().map(|m| m.base_url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://cheap.example.com",  // 最便宜且测过能用
                "https://mid.example.com",    // 次便宜且能用
                "https://own.example.com",    // 线路自带，没测过
                "https://broken.example.com", // 最便宜但测过是坏的 → 兜底
            ]
        );
    }

    #[test]
    fn an_endpoint_without_its_own_key_borrows_the_routes() {
        let r = model("anthropic");
        let mut e = ep(0.2, Some(true), "https://cheap.example.com");
        e.api_key = "   ".into();
        let mut map = HashMap::new();
        map.insert(r.id, vec![e]);
        let out = expand(&[r], &map, &HashMap::new(), "claude-opus-5");
        let cheap = out.iter().find(|m| m.base_url.contains("cheap")).unwrap();
        assert_eq!(cheap.api_key, "own-key");
    }

    /// 出口只承载它真有的那几个模型。
    ///
    /// 转卖商之间的货不一样。不筛的话，opus 的请求会被派到一个只有 sonnet 的出口上
    /// 撞 404 —— 而每个请求只有两次机会，这一撞就浪费掉一半，用户看到的是变慢。
    #[test]
    fn an_endpoint_only_serves_the_models_it_actually_has() {
        let mut r = model("anthropic");
        r.enabled_models = vec!["claude-opus-5".into(), "claude-sonnet-5".into()];
        let mut only_sonnet = ep(0.2, Some(true), "https://sonnet-only.example.com");
        only_sonnet.enabled_models = vec!["claude-sonnet-5".into()];
        let mut map = HashMap::new();
        map.insert(r.id, vec![only_sonnet]);

        // 要 sonnet：那个便宜出口能用，排第一。
        let urls: Vec<String> = expand(&[r.clone()], &map, &HashMap::new(), "claude-sonnet-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(urls[0], "https://sonnet-only.example.com");

        // 要 opus：它根本不该出现在候选里。
        let urls: Vec<String> = expand(&[r], &map, &HashMap::new(), "claude-opus-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(
            urls,
            vec!["https://own.example.com"],
            "一个没有 opus 的出口被派了 opus 的请求"
        );
    }

    /// 出口可以带来线路本身没有的模型。
    #[test]
    fn an_endpoint_can_bring_models_the_route_never_had() {
        let mut r = model("anthropic");
        r.enabled_models = vec!["claude-opus-5".into()];
        let mut e = ep(0.3, Some(true), "https://extra.example.com");
        e.enabled_models = vec!["claude-opus-5".into(), "claude-haiku-9".into()];
        let all = effective_models(&r, &[e]);
        assert!(all.contains(&"claude-haiku-9".to_string()), "出口带来的新模型没进并集");
        assert!(all.contains(&"claude-opus-5".to_string()));
        assert_eq!(all.len(), 2, "并集里出现了重复");
        // 停用的出口不该贡献模型。
        let mut off = ep(0.3, Some(true), "https://off.example.com");
        off.enabled_models = vec!["ghost-model".into()];
        off.active = false;
        assert!(!effective_models(&r, &[off]).contains(&"ghost-model".to_string()));
    }

    /// 线路自带的地址没有那款货时，不能把请求派给它。
    ///
    /// 派过去只会撞一个 404，而每个请求只有两次机会 —— 白撞一次就浪费掉一半。
    #[test]
    fn the_direct_address_is_skipped_for_a_model_it_does_not_have() {
        let mut r = model("anthropic");
        r.enabled_models = vec!["claude-opus-5".into()];
        let mut e = ep(0.3, Some(true), "https://extra.example.com");
        e.enabled_models = vec!["claude-haiku-9".into()];
        let mut map = HashMap::new();
        map.insert(r.id, vec![e]);

        // 只有出口有的那款：候选里不该出现线路自带地址
        let urls: Vec<String> = expand(&[r.clone()], &map, &HashMap::new(), "claude-haiku-9")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(urls, vec!["https://extra.example.com"], "把新模型派给了没有它的直连");

        // 线路自己那款：出口没有它，所以只剩直连
        let urls: Vec<String> = expand(&[r], &map, &HashMap::new(), "claude-opus-5")
            .into_iter()
            .map(|m| m.base_url)
            .collect();
        assert_eq!(urls, vec!["https://own.example.com"]);
    }

    /// 算不出价格的模型不许开放。
    ///
    /// 价格有三条来源：每模型覆盖 → 实时目录 → 线路兜底价。三条都没有时
    /// `compute_cost` 会算出 0 —— 用户一分不付，而上游照收你的钱。这不是少收了点钱，
    /// 是每一次调用都在白送，而且账面上完全看不出来。
    #[test]
    fn a_model_with_no_resolvable_price_is_refused() {
        let mut r = model("anthropic");
        // 线路兜底价为 0（线上实测就是这样），目录里也没有这个自造的名字
        r.input_price = 0.0;
        r.output_price = 0.0;
        assert!(!priceable(&r, "some-relay-private-name-v9"), "查不到价却说能开放");

        // 填了单模型价就能开放
        r.model_prices = serde_json::json!({ "some-relay-private-name-v9": { "in": 3.0, "out": 15.0 } });
        assert!(priceable(&r, "some-relay-private-name-v9"));

        // 线路兜底价也算一条来源
        let mut r2 = model("anthropic");
        r2.input_price = 2.0;
        assert!(priceable(&r2, "anything-at-all"));
    }

    /// 「全选归一成空」的判据必须是集合相等，不能是长度相等。
    ///
    /// 出口能带来线路没有的模型之后，长度判就错了：线路 6 个，勾 4 个原有 + 2 个新的
    /// 也是 6 个 —— 按长度判会把整份选择清空，那两个新模型**静默消失**。
    /// 保存不报错，只是它们再也不会被派到这个出口，而界面上还显示勾着。
    #[test]
    fn the_normalise_to_empty_rule_compares_sets_not_lengths() {
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let body = &s[i..];
        assert!(
            body.contains("enabled_models.iter().all(|m| allowed.contains(m))"),
            "还在按长度判：勾了同样多但含新模型时，那几个新模型会被静默清掉"
        );
        // 纯逻辑复现一遍，防止实现改成别的等价写法后这条断言失去意义。
        let allowed = vec!["a".to_string(), "b".into(), "c".into()];
        let same_len_but_different = vec!["a".to_string(), "b".into(), "新模型".into()];
        let exactly = vec!["a".to_string(), "b".into(), "c".into()];
        let judge = |sel: &Vec<String>| {
            sel.len() == allowed.len() && sel.iter().all(|m| allowed.contains(m))
        };
        assert!(!judge(&same_len_but_different), "含新模型的选择被当成了「就是线路那一份」");
        assert!(judge(&exactly));
    }

    /// 在出口窗口里填的价，必须写到**线路**上，不能写到出口上。
    ///
    /// 这是新开的一条写入路径，也是最容易把不变量弄丢的地方：每个出口各存一份价的话，
    /// 同一个模型用户被扣多少钱就要看当时哪家先答 —— 那正是整套多路由第一天堵死的洞。
    #[test]
    fn prices_edited_in_the_outlet_dialog_are_stored_on_the_route() {
        let s = src();
        let i = s.find("async fn merge_route_pricing(").expect("合并函数不见了");
        let body = &s[i..s[i..].find("\n/// 唯一索引").map(|j| i + j).unwrap_or(s.len())];
        assert!(
            body.contains("UPDATE models SET model_prices"),
            "定价没写到 models 表 —— 写到出口上就等于每个出口一份价"
        );
        assert!(
            !body.contains("UPDATE route_endpoints"),
            "定价被写到出口表上了：同一个模型的账单会随出口变"
        );
        // route_endpoints 表结构里也不许出现价格列。
        for mig in [
            include_str!("../migrations/20260851_route_endpoints.sql"),
            include_str!("../migrations/20260852_route_endpoint_scope.sql"),
            include_str!("../migrations/20260853_route_endpoint_capacity.sql"),
        ] {
            for col in ["input_price", "output_price", "model_prices", "rate ", "billing_mode"] {
                assert!(
                    !mig.contains(&format!("ADD COLUMN IF NOT EXISTS {col}"))
                        && !mig.contains(&format!("    {col}")),
                    "出口表上出现了计价列 {col} —— 换出口就会换账单"
                );
            }
        }
    }

    /// 合并，不是覆盖。
    ///
    /// 出口窗口只列了这一家有的那几个模型。整份覆盖会把线路上别的模型的价**抹掉**，
    /// 而那个后果要等到别人用那个模型时才显现：突然一分钱不收。
    #[test]
    fn merging_prices_never_wipes_the_rest() {
        let s = src();
        let i = s.find("async fn merge_route_pricing(").expect("合并函数不见了");
        let body = &s[i..];
        assert!(
            body.contains("fn merge(base: &serde_json::Value, patch: &serde_json::Value)"),
            "不是合并了 —— 整份覆盖会把线路上别的模型的价抹掉"
        );
        assert!(
            body.contains("out.remove(k)"),
            "没有删除语义：想去掉某个模型的价就只能留一个空对象在那儿"
        );
    }

    /// 先合并定价，再做价格闸校验。
    ///
    /// 顺序反了的话，新模型的价明明就在这次请求里，却因为「查不到价」被拒 ——
    /// 而报错还让人去线路那页填，那页根本没有这个模型。死循环。
    #[test]
    fn pricing_is_merged_before_the_price_gate_runs() {
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let body = &s[i..];
        let merged = body.find("merge_route_pricing(&state, &mut route, &req)").expect("没合并定价");
        let gate = body.find("!allowed.contains(m) && !priceable(&route, m)").expect("价格闸不见了");
        assert!(
            merged < gate,
            "价格闸跑在合并之前：这次填的价还没落库，新模型必然被判成「查不到价」"
        );
    }

    /// 保存出口时，新模型必须先有价格。
    #[test]
    fn saving_an_unpriceable_new_model_is_rejected() {
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let body = &s[i..];
        assert!(
            body.contains("!allowed.contains(m) && !priceable(&route, m)"),
            "价格闸没了 —— 出口能开放一个用户不付钱、你照付的模型"
        );
    }

    /// 不填模型 = 承载线路的全部。不填时行为必须和加这个功能之前一模一样。
    #[test]
    fn an_endpoint_with_no_model_list_serves_everything() {
        let mut r = model("anthropic");
        r.enabled_models = vec!["a".into(), "b".into()];
        let mut map = HashMap::new();
        map.insert(r.id, vec![ep(0.2, Some(true), "https://all.example.com")]);
        for want in ["a", "b"] {
            let urls: Vec<String> = expand(&[r.clone()], &map, &HashMap::new(), want)
                .into_iter()
                .map(|m| m.base_url)
                .collect();
            assert_eq!(urls[0], "https://all.example.com", "模型 {want} 漏了这个出口");
        }
    }

    /// 出口可以用另一种协议，而且换协议不能顺带换掉别的。
    #[test]
    fn an_endpoint_can_speak_a_different_protocol() {
        let r = model("anthropic");
        let mut e = ep(0.2, Some(true), "https://openai-style.example.com");
        e.protocol = "openai".into();
        let mut map = HashMap::new();
        map.insert(r.id, vec![e]);
        let out = expand(&[r.clone()], &map, &HashMap::new(), "claude-opus-5");
        let relay = out.iter().find(|m| m.base_url.contains("openai-style")).unwrap();
        assert_eq!(relay.protocol, "openai", "出口的协议没生效");
        assert_eq!(relay.input_price, r.input_price, "换协议顺带改了价");
        assert_eq!(relay.id, r.id, "换协议顺带换了线路身份");
        // 线路自带的那份不受影响。
        let own = out.iter().find(|m| m.base_url.contains("own")).unwrap();
        assert_eq!(own.protocol, "anthropic");
    }

    /// 协议只认两个值。
    #[test]
    fn protocol_is_one_of_the_known_words() {
        assert_eq!(clean_protocol("").ok(), Some(String::new()));
        assert_eq!(clean_protocol(" Anthropic ").ok(), Some("anthropic".into()));
        assert_eq!(clean_protocol("openai").ok(), Some("openai".into()));
        assert_eq!(clean_protocol("xai_responses").ok(), Some("xai_responses".into()));
        // 不认识的值会一路带到发请求那步，走进「不是 anthropic 就当 openai」的分支，
        // 拼出一个 /chat/completions 打给只认 /v1/messages 的上游，报一个看不懂的 404。
        assert!(clean_protocol("gemini").is_err());
        assert!(clean_protocol("anthropic-v2").is_err());
        assert!(clean_protocol("responses").is_err(), "别让半个名字也过 —— 它和 xai_responses 是两回事");

        // **两侧白名单必须是同一份**。出口协议会覆盖线路协议（见 effective 协议那处），
        // 只放行线路那一侧的话，表现是「线路设成新协议了，走的还是老的那条路」——
        // 而这种错不会报任何错，只会安静地走错。所以两边都从 PROTOCOLS 读。
        for p in crate::models::PROTOCOLS {
            assert_eq!(clean_protocol(p).ok(), Some(p.to_string()), "{p} 在出口这侧被挡住了");
        }
        let src = include_str!("route_endpoints.rs");
        assert!(
            src.contains("crate::models::PROTOCOLS.contains(&p.as_str())"),
            "出口校验又手抄了一份取值清单 —— 下次加协议只会改一半",
        );
    }

    /// 全选要归一成空。
    ///
    /// 不归一的话，线路以后加了新模型，这个出口会停在保存那天的名单上 —— 而运维
    /// 当初勾的是「全部」，不是「这七个」。
    #[test]
    fn selecting_everything_is_stored_as_empty() {
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let body = &s[i..];
        assert!(
            body.contains("if is_exactly_the_routes_own {"),
            "全选没有归一成空 —— 线路以后加了新模型，这个出口会停在保存那天的名单上"
        );
    }

    #[test]
    fn inactive_endpoints_are_not_expanded() {
        let r = model("anthropic");
        let mut e = ep(0.1, Some(true), "https://off.example.com");
        e.active = false;
        let mut map = HashMap::new();
        map.insert(r.id, vec![e]);
        let out = expand(&[r], &map, &HashMap::new(), "claude-opus-5");
        assert_eq!(out.len(), 1);
        assert!(out[0].base_url.contains("own"));
    }

    #[test]
    fn ratio_is_a_multiplier_not_a_discount() {
        assert!(clean_ratio(0.3).is_ok());
        assert!(clean_ratio(1.0).is_ok());
        // 大于 1 必须能存。这条曾经被拒，理由是「折扣不能大于 1.0」——
        // 而这个数不是折扣。比原价贵的替补出口排在直连后面，只在便宜的都坏了
        // 才轮到它；拒掉它等于把「贵一点也比断服强」这个选项从产品里删了。
        assert!(clean_ratio(1.5).is_ok());
        assert!(clean_ratio(9.99).is_ok());
        // 小数点点错成 10（想写 1.0）仍然不能进库：它会让这个出口永远排最后，
        // 而运维以为自己配的是「十倍便宜」。这是护栏，不是语义上限。
        assert!(clean_ratio(10.0).is_err());
        assert!(clean_ratio(0.0).is_err());
        assert!(clean_ratio(-1.0).is_err());
        assert!(clean_ratio(f64::NAN).is_err());
        // NaN 尤其要挡：它参与排序时所有比较都返回 false，会让次序变成
        // 「取决于库里的行序」——一个看起来随机、永远查不出来的 bug。
    }

    /// 进价倍率在任何一处**会被人看见的文字**里都不许被说成「折」。
    ///
    /// 这条不是措辞洁癖，它守的是一条真实发生过的因果链：**词错 → 校验跟着错 →
    /// 合法配置被拒**。「折」是十分制、只在 0<v<1 这一段说得通；一旦用它说话，
    /// 1.5 就无话可说，而 `v >= 1 → "进价原价"` 那种分支会把 1.2 一并说成原价 ——
    /// 一句关于钱的假话。上一版正是从这个词推出了「不能大于 1.0」的上限，
    /// 把「比原价贵的替补出口」整个拒在了门外。
    ///
    /// **先剥注释再断言**：解释「为什么不说折」的注释本身必然含「折」字，
    /// 照着源文本硬断言的话，这条测试第一天就会红在它自己的说明上。
    #[test]
    fn the_cost_ratio_is_never_worded_as_a_discount() {
        // 块注释（JSX 的 {/* ... */} 也是这个形状）+ 整行 `//`。
        fn strip_comments(s: &str) -> String {
            let mut out = String::new();
            let mut rest = s;
            while let Some(a) = rest.find("/*") {
                out.push_str(&rest[..a]);
                rest = match rest[a..].find("*/") {
                    Some(b) => &rest[a + b + 2..],
                    None => "",
                };
            }
            out.push_str(rest);
            out.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }

        let mut bad: Vec<String> = Vec::new();
        for (name, raw) in [
            ("server/src/route_endpoints.rs", src()),
            (
                "admin-ui/src/pages/RouteEndpoints.tsx",
                include_str!("../admin-ui/src/pages/RouteEndpoints.tsx").to_string(),
            ),
            (
                "admin-ui/src/pages/RouteHealth.tsx",
                include_str!("../admin-ui/src/pages/RouteHealth.tsx").to_string(),
            ),
        ] {
            // 「折算 / 折合 / 折叠」是别的意思，先摘掉，别把它们当成回潮。
            let code = strip_comments(&raw)
                .replace("折算", "")
                .replace("折合", "")
                .replace("折叠", "");
            for l in code.lines() {
                if l.contains('折') {
                    bad.push(format!("  {name}: {}", l.trim()));
                }
            }
        }
        assert!(
            bad.is_empty(),
            "进价倍率又被说成「折」了 —— 这个数是倍率，可以大于 1：\n{}",
            bad.join("\n"),
        );
    }

    /// 前端真实发出的那个载荷，必须能反序列化。
    ///
    /// 这一条钉的是一个真实故障：控制台点「保存」连着 5 次 400，而 `admin_save` 自己的
    /// 任何一条校验文案都对不上响应体长度 —— 说明请求**在进入处理函数之前**就被
    /// 提取器拒了。这种 400 不进错误日志、文案是英文的 serde 报错，最难查。
    ///
    /// 载荷逐字抄自 admin-ui 的 save()：新建时 `id` 是 undefined，JSON.stringify 会
    /// 把这个键整个丢掉。
    #[test]
    fn the_exact_payload_the_console_sends_deserialises() {
        // 新建：没有 id，capacity 是 null
        let create = serde_json::json!({
            "route_id": "11111111-1111-1111-1111-111111111111",
            "label": "转卖A",
            "base_url": "https://relay.example.com/v1",
            "api_key": "sk-test",
            "cost_ratio": 0.3,
            "note": "",
            "protocol": "",
            "active": true,
            "enabled_models": ["claude-opus-5"],
            "capacity": serde_json::Value::Null,
        });
        let got = serde_json::from_value::<SaveReq>(create);
        assert!(got.is_ok(), "新建的载荷反序列化失败：{:?}", got.err().map(|e| e.to_string()));

        // 编辑：带 id，capacity 是个数
        let update = serde_json::json!({
            "id": "22222222-2222-2222-2222-222222222222",
            "route_id": "11111111-1111-1111-1111-111111111111",
            "label": "", "base_url": "https://relay.example.com/v1", "api_key": "",
            "cost_ratio": 1, "note": "", "protocol": "openai", "active": true,
            "enabled_models": [], "capacity": 600,
        });
        assert!(
            serde_json::from_value::<SaveReq>(update).is_ok(),
            "编辑的载荷反序列化失败"
        );

        // 最小载荷：只有必填的两个。其余都该有默认值，
        // 否则一个旧版前端就会把整条链路打成 400。
        let minimal = serde_json::json!({
            "route_id": "11111111-1111-1111-1111-111111111111",
            "base_url": "https://relay.example.com/v1",
        });
        let got = serde_json::from_value::<SaveReq>(minimal);
        assert!(got.is_ok(), "最小载荷反序列化失败：{:?}", got.err().map(|e| e.to_string()));
    }

    /// 每个字段被显式打成 `null` 时都不能把请求打死。
    ///
    /// 这一条钉的是「点保存没反应、服务端查不出原因」那类故障的根：`#[serde(default)]`
    /// 只管字段**缺失**，管不了值是 `null`。而前端里 `x ? f(x) : null`、以及
    /// `Number("abc")` 出 NaN 被 JSON.stringify 写成 `null`，随手就会产生一个显式 null。
    /// 那种请求在**进入处理函数之前**就被提取器拒了，报英文 serde 错、不进任何日志。
    #[test]
    fn an_explicit_null_on_any_field_never_kills_the_request() {
        let fields = [
            "id", "label", "base_url", "api_key", "cost_ratio", "active", "note",
            "enabled_models", "protocol", "capacity", "model_prices", "model_names",
        ];
        for f in fields {
            let mut v = serde_json::json!({
                "route_id": "11111111-1111-1111-1111-111111111111",
                "base_url": "https://relay.example.com/v1",
            });
            v[f] = serde_json::Value::Null;
            let got = serde_json::from_value::<SaveReq>(v);
            assert!(
                got.is_ok(),
                "字段 {f} 被打成 null 就解不出来了：{:?}",
                got.err().map(|e| e.to_string())
            );
        }
        // null 要落到「没填」，不是落到别的值上。
        let v = serde_json::json!({
            "route_id": "11111111-1111-1111-1111-111111111111",
            "base_url": "https://a.example.com/v1",
            "cost_ratio": serde_json::Value::Null,
            "active": serde_json::Value::Null,
            "protocol": serde_json::Value::Null,
        });
        let r = serde_json::from_value::<SaveReq>(v).expect("解不出来");
        assert_eq!(r.cost_ratio, 1.0, "null 倍率该落到默认的 1.0（原价）");
        assert!(r.active, "null 该落到「投入轮转」");
        assert_eq!(r.protocol, "", "null 协议该落到「跟线路一样」");
    }

    /// 请求体由处理函数自己解，不交给提取器。
    ///
    /// 交给 `Json<SaveReq>` 的话，解析失败是一句英文 serde 错，发生在这个函数之前 ——
    /// 服务端没有任何日志，运维只能看到一个 400。这一整类失败查不出来。
    #[test]
    fn the_handler_parses_the_body_itself_so_failures_are_visible() {
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let head = &s[i..s[i..].find("admin_only").map(|j| i + j).unwrap_or(s.len())];
        assert!(
            head.contains("body: axum::body::Bytes"),
            "又交回给提取器了：解析失败会变成一个查不出原因的 400"
        );
        let body = &s[i..];
        assert!(
            body.contains("请求格式不对："),
            "解析失败没有转成中文报错"
        );
    }

    #[test]
    fn url_must_be_http() {
        assert!(clean_url("https://a.example.com/v1/").is_ok());
        // AppError 没实现 Debug，所以不能 unwrap。
        assert_eq!(
            clean_url("https://a.example.com/v1/").ok().as_deref(),
            Some("https://a.example.com/v1"),
            "结尾的斜杠没削掉：拼出来会是 //messages",
        );
        assert!(clean_url("a.example.com").is_err());
        assert!(clean_url("file:///etc/passwd").is_err());
        assert!(clean_url("  ").is_err());
    }

    #[test]
    fn probe_never_reports_ok_on_a_bare_200() {
        // 这一条钉的是 model_probe.rs 里记着的那条教训：转卖网关会用 200 包错误页。
        let s = src();
        // 判据本体现在是共用函数。**两个调用方都要检查** —— 只钉 probe_once 的话，
        // 告警那侧退回「只看状态码」是发现不了的（这正是刚修的那个 bug）。
        assert!(
            s.contains("pub(crate) fn looks_like_a_real_completion(")
                && s.contains(r#"v.get("content")"#)
                && s.contains(r#"v.get("choices")"#),
            "响应形状的共用判据不见了或被改窄了",
        );
        let i = s.find("pub async fn probe_once(").expect("探测函数不见了");
        assert!(
            s[i..].contains("looks_like_a_real_completion(&text)"),
            "出口探测不再检查响应形状了——那就退回成「只要不报错就算好」",
        );
        let health = include_str!("route_health.rs");
        assert!(
            health.contains("looks_like_a_real_completion("),
            "告警那侧（canary_once）没用同一个判据 —— 一个「200 + 错误体」的上游\
             会在出口页报红、在健康页报绿，而两边打的是同一个地址",
        );
    }

    #[test]
    fn the_probe_error_path_never_echoes_the_url() {
        // reqwest 的错误链带完整 URL，而有些转卖商要求把密钥写在查询串里。
        let s = src();
        let i = s.find("pub async fn probe_once(").expect("探测函数不见了");
        let body = &s[i..s[i..].find("fn probe_client").map(|j| i + j).unwrap_or(s.len())];
        assert!(
            !body.contains("{e}") && !body.contains("e.to_string()"),
            "把 reqwest 的错误原文放进了 note —— 那可能把密钥写进后台页面和日志"
        );
    }

    #[test]
    fn the_key_is_never_returned_to_the_browser() {
        let s = src();
        let i = s.find("pub struct EndpointOut").expect("出参结构不见了");
        // 按**结构体边界**切，不用定长窗口：这个结构会长，而定长窗口既会把新字段挤出
        // 检查范围（漏判），也会在中文注释上切到半个汉字里直接 panic —— 两种都发生过。
        let body = &s[i..s[i..].find("\n}").map(|j| i + j).unwrap_or(s.len())];
        assert!(body.contains("has_key"), "改成回密钥本身了");
        assert!(
            !body.contains("pub api_key"),
            "EndpointOut 带上了 api_key —— 后台页面也不该拿到密钥"
        );
    }

    #[test]
    fn saving_without_a_key_keeps_the_old_one() {
        // 「只改地址」的保存必须留住密钥，否则一次改地址就把出口打瘸，
        // 而错误要等到下一个请求打过去才出现。
        let s = src();
        let i = s.find("pub async fn admin_save(").expect("保存入口不见了");
        let body = &s[i..];
        assert!(
            body.contains("SELECT api_key FROM route_endpoints WHERE id = $1"),
            "不再先取旧密钥了"
        );
        assert!(
            body.contains("if req.api_key.trim().is_empty()"),
            "空密钥的分支没了 —— 会把密钥清空"
        );
    }

    #[test]
    fn keys_use_the_same_crypto_context_as_route_keys() {
        // 用另一个 context 存的话，密钥轮换会漏掉这张表，而症状是「某天所有多路由同时挂」。
        let s = src();
        // 按判据数，不按次数数：每一处加密都得带这个 context，一处都不能漏。
        assert_eq!(
            s.matches("crate::field_crypto::encrypt(").count(),
            s.matches("crate::models::MODEL_KEY_CTX").count(),
            "有加密调用没带线路那套 context —— 密钥轮换会漏掉这张表，\
             症状是「某天所有多路由同时挂」"
        );
        assert!(
            s.contains("crate::field_crypto::encrypt("),
            "端点密钥不再加密存了"
        );
        // 解密只许走 model_key（它内部就是这个 context），不许自己再拼一个。
        assert!(
            s.contains("crate::models::model_key(") && !s.contains("field_crypto::decrypt("),
            "端点密钥的解密绕开了 model_key"
        );
        assert!(
            !s.contains("route_endpoints.api_key\""),
            "给端点密钥另起了一个加密 context"
        );
    }

    /// 「还能不能服务」的排序：好的在前，`unknown` 必须排在 `error` 前面。
    ///
    /// 反了会同时造出两种错：把没人用过的出口当成坏的报警（告警疲劳，正是上次事故里
    /// 没人看告警的成因），或者把真坏了的出口当成不知道而不报警。
    /// 厂商判定要认得出线上那七条线路。
    ///
    /// 这七组是从生产库里抄出来的真值，不是我编的形状 —— 其中两条（智谱、Grok）的
    /// `provider` 列填的都是 `other`，正是「不能信那一列」的证据。
    #[test]
    fn the_real_routes_are_all_recognised() {
        let cases: [(&str, &[&str], &str); 7] = [
            ("claude", &["claude-opus-5", "claude-fable-5"], "anthropic"),
            ("gpt", &["gpt-5.6-sol", "gpt-5.6-terra"], "openai"),
            ("deepseek", &["deepseek-v4-flash"], "deepseek"),
            // provider = other，只能靠模型 id 认出来。
            ("other", &["glm-5.2", "glm-5.3"], "zhipu"),
            ("other", &["grok-4.6", "grok-4.5"], "xai"),
            // 自起的名字，模型名什么都说明不了 —— 这一条靠域名兜底，见下面那个测试。
            ("other", &["stealth/ox-alpha"], ""),
            ("", &[], ""),
        ];
        for (provider, models, want) in cases {
            let owned: Vec<String> = models.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                vendor_of(provider, &owned, ""),
                want,
                "provider={provider} models={models:?}"
            );
        }
    }

    /// 一大批真实模型 id 各自该认成谁。
    ///
    /// 这张表钉的是**次序**。厂商表是从上往下匹配的，加一条短词就可能把后面几家全抢走，
    /// 而症状只是「某条线路的图标变了」—— 没有任何测试会自然发现。所以每加一家，
    /// 就往这里加一行。
    #[test]
    fn a_pile_of_real_model_ids_map_to_the_right_vendor() {
        let cases: &[(&str, &str)] = &[
            ("claude-opus-5", "anthropic"),
            // AWS 上的 Claude：id 带 anthropic. 前缀，认成 Claude 才对，不是 bedrock。
            ("anthropic.claude-3-5-sonnet-v2", "anthropic"),
            ("gpt-5.6-sol", "openai"),
            ("o3-mini", "openai"),
            ("deepseek-v4-pro", "deepseek"),
            ("glm-5.3", "zhipu"),
            ("grok-4.6", "xai"),
            ("gemini-3-pro", "google"),
            ("gemma-3-27b", "google"),
            ("qwen3-max", "qwen"),
            ("qwq-32b", "qwen"),
            ("kimi-k2", "moonshot"),
            ("moonshot-v1-128k", "moonshot"),
            ("llama-4-scout", "meta"),
            ("mistral-large-2411", "mistral"),
            ("abab6.5s-chat", "minimax"),
            ("minimax-m2", "minimax"),
            ("baichuan4-turbo", "baichuan"),
            ("hunyuan-turbos", "hunyuan"),
            ("doubao-pro-32k", "doubao"),
            ("ernie-4.5-turbo", "wenxin"),
            ("internlm3-8b", "internlm"),
            ("sensechat-5", "sensenova"),
            ("skywork-13b", "skywork"),
            ("command-r-plus", "cohere"),
            ("jamba-1.5-large", "ai21"),
            ("sonar-pro", "perplexity"),
            ("nemotron-4-340b", "nvidia"),
            ("phi-4", "microsoft"),
            ("yi-lightning", "zeroone"),
            ("sparkdesk-v4", "spark"),
            ("step-2-16k", "stepfun"),
        ];
        for (id, want) in cases {
            assert_eq!(
                vendor_of("", &[id.to_string()], ""),
                *want,
                "{id} 认错了厂商"
            );
        }
    }

    /// 每一家都得有图标，否则判定认出来了、界面还是画中性图。
    ///
    /// 两边是两个文件（Rust 的厂商表、前端的图标表），加一家很容易只加一边 ——
    /// 而漏的那一边不会报错，只是图标默默变回灰色。
    #[test]
    fn every_vendor_has_an_icon_on_the_front_end() {
        let icons = include_str!("../admin-ui/src/components/VendorMark.tsx");
        let mut missing = Vec::new();
        for (_, vendor) in NEEDLES.iter().chain(HOSTS.iter()) {
            if !icons.contains(&format!("\n  {vendor}: {{")) {
                missing.push(*vendor);
            }
        }
        missing.sort_unstable();
        missing.dedup();
        assert!(missing.is_empty(), "这些厂商在前端没有图标：{missing:?}");
    }

    /// 模型名认不出来时，看这条线路指向哪儿。
    ///
    /// 线上「牛来」那条就是这个形状：模型 id 是 `stealth/ox-alpha`（自起的名字，
    /// 什么都说明不了），而它的地址是 openrouter.ai —— 那才是唯一有信息量的东西。
    #[test]
    fn the_address_is_the_fallback_when_the_model_name_says_nothing() {
        assert_eq!(
            vendor_of("other", &["stealth/ox-alpha".into()], "https://openrouter.ai/api/v1"),
            "openrouter"
        );
        assert_eq!(vendor_of("", &[], "https://api.siliconflow.cn/v1"), "siliconcloud");
        assert_eq!(vendor_of("", &[], "http://localhost:11434/v1"), "ollama");
        // 两边都认不出来，还是不猜。
        assert_eq!(vendor_of("", &["mystery".into()], "https://relay.example.com"), "");
    }

    /// 模型比管道重要：地址只在模型名说不清时才轮到。
    ///
    /// 一条指向 openrouter 但跑 claude-opus 的线路该显示 Claude —— 运维想知道的是
    /// 「这条线路卖的是谁家的模型」，不是「从哪个中间商买的」。次序反了就全反了。
    #[test]
    fn the_model_wins_over_the_pipe() {
        assert_eq!(
            vendor_of("", &["claude-opus-5".into()], "https://openrouter.ai/api/v1"),
            "anthropic"
        );
        assert_eq!(
            vendor_of("", &["deepseek-v4".into()], "https://api.siliconflow.cn/v1"),
            "deepseek"
        );
    }

    /// 不认识就回空串，绝不猜。
    ///
    /// 给一条智谱线路画上 OpenAI 的标，比不画标糟得多：不画只是朴素，画错是错误信息，
    /// 而运维扫一眼图标就以为自己看懂了这条线路是谁家的。
    /// 手写表认不出来的模型，实时目录得能顶上。
    ///
    /// # 这道口子原本堵在哪
    ///
    /// 图标库里有 149 家，而 `NEEDLES` 只有 67 条、够触发其中 43 家。剩下一百来个图标
    /// 一直躺在库里没人用得上 —— 不是没画，是没有任何模型名能命中它们。表现就是
    /// qwen / minimax / mimo 这些在列表里显示成中性图标。
    ///
    /// 目录那边每半小时刷新、四百多个模型，每条 id 都带着 `厂商/模型` 的形状，
    /// 本来就有答案。
    ///
    /// # 为什么探针名里不写厂商
    ///
    /// 写成 `nvidia/xxx` 的话 `NEEDLES` 自己就答得出来，这个测试会**静音**——
    /// 把目录那段整段删掉它照样绿（实测过）。所以探针用不带厂商的裸名，
    /// 并且先断言「没种进目录之前谁也答不出」，那之后的任何答案就只可能来自目录。
    /// 中转商本来也大量卖裸名（`kimi-k2` 而不是 `moonshotai/kimi-k2`），这正是目录顶上的那一片。
    #[test]
    fn the_live_catalog_fills_in_vendors_the_needles_never_knew() {
        use crate::model_catalog::Entry;
        const URL: &str = "https://probe.invalid";
        fn ask(id: &str) -> &'static str {
            vendor_of("", &[id.to_string()], URL)
        }
        fn seed(id: &str, vendor: &str) {
            crate::model_catalog::seed_for_test(&[(
                id,
                Entry { vendor: vendor.to_string(), ..Default::default() },
            )]);
        }

        // 自检：种进目录之前，这三个名字对手写表和域名表都是隐形的。
        for id in ["probe-x1", "probe-x2", "probe-x3"] {
            assert_eq!(ask(id), "", "{id} 已经能被别的路答出来了，这个测试测不到目录");
        }

        // 目录前缀和图标键同名：直查。
        seed("probe-x1", "nvidia");
        assert_eq!(ask("probe-x1"), "nvidia");

        // 目录前缀和图标键不同名：走别名。`mistralai` 的图标键是 `mistral`。
        seed("probe-x2", "mistralai");
        assert_eq!(ask("probe-x2"), "mistral");

        // 目录知道它属于谁，但我们没有这家的图：回空串走中性图标，
        // **不能**回一个前端画不出来的名字。
        seed("probe-x3", "poolside");
        assert_eq!(
            ask("probe-x3"),
            "",
            "没有图的厂商必须回空串，否则前端拿到一个画不出来的键",
        );

        // 手写表的次序是刻意的，目录不许把它顶掉：bedrock 上的 claude 仍然算 Anthropic。
        seed("probe-x4-claude", "amazon");
        assert_eq!(
            vendor_of("bedrock", &["probe-x4-claude".into()], URL),
            "anthropic",
            "NEEDLES 里 claude 排在 bedrock 前面，这个次序不能被目录改写",
        );
    }

    /// 名字像，不等于是同一家。
    ///
    /// `anthracite-org` 和 `anthropic` 前七个字母一样，而前者是个做微调的小组织。
    /// 这个测试存在的原因是：给图标表挑别名时，任何「按相似度自动补全」的做法
    /// 第一个撞上的就是这一对 —— 我自己写这张表时也是先被它绊了一下。
    /// 给一家画上另一家的标，比不画糟得多，所以它必须停在中性图标上。
    #[test]
    fn a_lookalike_name_never_borrows_someone_elses_logo() {
        use crate::model_catalog::Entry;
        crate::model_catalog::seed_for_test(&[(
            "probe-x5",
            Entry { vendor: "anthracite-org".into(), ..Default::default() },
        )]);
        assert_eq!(
            vendor_of("", &["probe-x5".into()], "https://probe.invalid"),
            "",
            "anthracite-org 不是 Anthropic",
        );
    }

    /// 服务端认得出的厂商键，必须和 IDE 的图标库**一一对应**。
    ///
    /// # 为什么两边都要有这张表
    ///
    /// `vendor_of` 回的是 `&'static str`，而实时目录给的厂商前缀是运行时字符串 ——
    /// 得在 `ICON_KEYS` 里对上才能变成静态引用。于是这份键表在服务端有一份、
    /// 在 `ide/src/brand-sprite.js` 的 `BRANDS` 里有一份。
    ///
    /// 两份必然会漂，而漂了**不会报错**：表现只是某一家的图标突然变成中性图标，
    /// 或者判定回了一个前端画不出来的名字。所以这里逐字对。
    #[test]
    fn the_icon_key_table_matches_the_ide_sprite() {
        let sprite = include_str!("../../ide/src/brand-sprite.js");
        let at = sprite
            .find("export const BRANDS = new Set([")
            .expect("brand-sprite.js 里找不到 BRANDS —— 它的形状变了");
        let line = &sprite[at..sprite[at..].find('\n').map(|i| at + i).unwrap_or(sprite.len())];
        let in_sprite: std::collections::BTreeSet<&str> = line
            .split('"')
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        let ours: std::collections::BTreeSet<&str> = ICON_KEYS.iter().copied().collect();
        assert!(in_sprite.len() > 100, "只从 sprite 里认出 {} 个键", in_sprite.len());
        let missing: Vec<_> = in_sprite.difference(&ours).collect();
        let extra: Vec<_> = ours.difference(&in_sprite).collect();
        assert!(missing.is_empty(), "sprite 有而服务端没有：{missing:?}");
        assert!(extra.is_empty(), "服务端有而 sprite 没有（会回一个画不出来的名字）：{extra:?}");
    }

    /// 图标页上的那几个数，必须真的是「全集」。
    ///
    /// `VendorMark.tsx` 里有**两份**厂商清单：`MARKS`（真的有图形的那份，已经被
    /// ICON_KEYS 和 brand-sprite.js 两头钉住）和 `VENDOR_GROUPS`（页面拿来分组渲染、
    /// 数出「图标 149」那个数的那份）。后者没人钉。
    ///
    /// 两份漂开的症状：页面说「这一页就是全集，搜不到就是确实没有这家的图标」，
    /// 而实际上有图的那家只是没被编进分组里 —— 一个自称全集的列表少了一项，
    /// 比没有这句话糟。
    #[test]
    fn the_icon_page_lists_every_mark_there_is() {
        let src = include_str!("../admin-ui/src/components/VendorMark.tsx");
        let marks_at = src.find("const MARKS: Record<string, Mark> = {").expect("MARKS 改名了");
        let groups_at = src.find("export const VENDOR_GROUPS").expect("VENDOR_GROUPS 改名了");
        assert!(marks_at < groups_at, "两份清单的次序变了，下面的切片会取错");

        // MARKS 的键：`  anthropic: {` 这种形状，取到 VENDOR_GROUPS 之前为止。
        // MARKS 的键单独占一行、形如 `  anthropic: {`（值是多行对象，不在同一行）。
        let marks: std::collections::BTreeSet<&str> = src[marks_at..groups_at]
            .lines()
            .filter_map(|l| {
                let t = l.trim_end();
                let k = t.strip_suffix(": {")?.trim_start();
                (!k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric())).then_some(k)
            })
            .collect();
        // VENDOR_GROUPS 的项：`{ vendor: "anthropic", name: "…" }`
        let listed: std::collections::BTreeSet<&str> = src[groups_at..]
            .split("vendor: \"")
            .skip(1)
            .filter_map(|t| t.split('"').next())
            .collect();

        assert!(marks.len() > 100, "只从 MARKS 里认出 {} 个，解析规则该改了", marks.len());
        let missing: Vec<_> = marks.difference(&listed).collect();
        let extra: Vec<_> = listed.difference(&marks).collect();
        assert!(missing.is_empty(), "有图却没进图标页的分组：{missing:?}");
        assert!(extra.is_empty(), "图标页列了没有图的厂商：{extra:?}");
    }

    /// 别名只许指向**真的有图**的那些键。
    ///
    /// 别名指向一个不存在的键，等于把这一家从「中性图标」变成「一个画不出来的名字」——
    /// 前端两种都退回中性图标，所以**不会报错**，只是白写一条别名。
    ///
    /// 另一半更要紧：别名**不许按字符串相似度自动生成**。`anthracite-org` 和 `anthropic`
    /// 前七个字母一样，而前者是个微调组织，跟 Anthropic 没关系 —— 给一家画上别人的标，
    /// 比不画糟得多。
    #[test]
    fn vendor_aliases_point_at_icons_that_exist() {
        for (from, to) in VENDOR_ALIASES {
            assert!(
                ICON_KEYS.contains(to),
                "别名 {from} → {to}，而 {to} 没有图标",
            );
            assert!(
                !ICON_KEYS.contains(from),
                "{from} 本身就有图标，不该再给它配别名（直查就够了）",
            );
        }
    }

    /// 线上**每一个正在开放的模型**都得认得出厂商。
    ///
    /// # 为什么用真实 id 而不是造几个
    ///
    /// 造出来的 id 只能证明判定表自洽。这条钉的是「用户在 IDE 里到底看不看得到图标」，
    /// 而那取决于他**实际配了什么**。2026-08-26 实测：`mimo-v2.5` 判不出来 ——
    /// 判定表里没有这一家，而图标库里明明有（键叫 `xiaomimimo`，不叫 `mimo`）。
    ///
    /// 两边的键必须逐字对齐。前端 `hasBrandMark(vendor)` 查的就是这个字符串，
    /// 对不上就画中性图标，而且**不报错** —— 表现只是「这家没有图」，
    /// 让人以为图标库缺货，其实是判定表没收。
    #[test]
    fn every_live_model_resolves_to_a_vendor_with_an_icon() {
        // 2026-08-26 线上九条线路开放的全部模型。
        let live: &[(&str, &str, &str)] = &[
            ("claude-opus-5", "https://api.hanhegufei.online", "anthropic"),
            ("claude-sonnet-5", "https://api.hanhegufei.online", "anthropic"),
            ("claude-fable-5", "https://api.hanhegufei.online", "anthropic"),
            ("gpt-5.6-sol", "https://zyz.qingyanzhiying.top", "openai"),
            ("gpt-5.6-luna", "https://zyz.qingyanzhiying.top", "openai"),
            ("gpt-5.6-terra", "https://zyz.qingyanzhiying.top", "openai"),
            ("deepseek-v4-pro", "https://api.hanhegufei.online", "deepseek"),
            ("deepseek-v4-flash", "https://api.hanhegufei.online", "deepseek"),
            ("glm-5.2", "https://api.hanhegufei.online", "zhipu"),
            ("glm-5.3", "https://api.hanhegufei.online", "zhipu"),
            ("grok-4.5", "https://api.hanhegufei.online", "xai"),
            ("grok-4.6", "https://api.hanhegufei.online", "xai"),
            ("qwen3.7-max", "https://llm.ohub.vip", "qwen"),
            ("qwen3.7-plus", "https://llm.ohub.vip", "qwen"),
            ("qwen3.8-max", "https://llm.ohub.vip", "qwen"),
            ("mimo-v2.5", "https://llm.ohub.vip", "xiaomimimo"),
            ("mimo-v2.5-pro", "https://llm.ohub.vip", "xiaomimimo"),
            // 「牛来」自起的名字，模型名什么都说明不了 —— 这时地址是唯一有信息量的东西。
            ("stealth/ox-alpha", "https://openrouter.ai/api/v1", "openrouter"),
        ];
        for (id, base, want) in live {
            let got = vendor_of("other", &[id.to_string()], base);
            assert_eq!(
                got, *want,
                "{id} 判成了 {got:?}，期望 {want:?} —— IDE 里这个模型会没有图标",
            );
        }

        // 判定表回的每一个厂商，图标库里都必须真的有。两边对不上时前端不报错，
        // 只是画一个中性图标 —— 看起来像「图标库缺这家」，其实是键不一致。
        let sprite = include_str!("../../ide/src/brand-sprite.js");
        for (_, _, want) in live {
            // 查 sprite 导出的 BRANDS 集合，不去匹配 symbol 标签里那串被转义的引号 ——
            // 那种写法转义一错就静默失效（第一版就把字符串提前闭合了，直接编译不过）。
            assert!(
                sprite.contains(&format!("\"{want}\"")),
                "图标库里没有 {want} 这个 symbol -- 判定认出来了但画不出来",
            );
        }
    }

    #[test]
    fn an_unknown_vendor_is_never_guessed() {
        assert_eq!(vendor_of("some-reseller", &["mystery-model-v9".into()], ""), "");
        assert_eq!(vendor_of("other", &["ox-alpha".into()], ""), "");
    }

    fn uid() -> uuid::Uuid {
        uuid::Uuid::from_u128(7)
    }

    /// 粘性键每一级都必须带 uid。
    ///
    /// run id 是客户端给的。不掺 uid 的话，两个用户完全可以撞同一个 run id，
    /// 被钉在同一个出口上 —— 那正好是这个键要避免的事。
    #[test]
    fn the_sticky_key_always_carries_the_uid() {
        let a = uuid::Uuid::from_u128(1);
        let b = uuid::Uuid::from_u128(2);
        let same_scope = [Some("run-abcdefgh")];
        assert_ne!(
            sticky_key(&a, &same_scope, b"salt"),
            sticky_key(&b, &same_scope, b"salt"),
            "两个用户带同一个 run id 得到了同一个键"
        );
        // 没有任何 scope 时也要能用（只靠 uid），不能退化成常量。
        assert_ne!(sticky_key(&a, &[None], b"salt"), sticky_key(&b, &[None], b"salt"));
        // 盐要真的起作用。
        assert_ne!(sticky_key(&a, &[None], b"s1"), sticky_key(&a, &[None], b"s2"));
    }

    /// 不合法的 scope 要掉级，而不是原样进哈希。
    ///
    /// 客户端那道白名单不合法时是静默不发，所以网关收到什么都有可能。一个带空格或
    /// 超长的值混进去，效果等同于「这个用户每次换一个键」—— 粘性直接没了，
    /// 而且不会有任何报错。
    #[test]
    fn a_malformed_scope_falls_through_instead_of_poisoning_the_key() {
        let u = uid();
        let bare = sticky_key(&u, &[None], b"salt");
        for bad in ["", "  ", "short", "has space", &"x".repeat(200), "semi;colon"] {
            assert_eq!(
                sticky_key(&u, &[Some(bad)], b"salt"),
                bare,
                "不合法的 scope「{bad}」没有掉级"
            );
        }
        // 合法的要真的参与。
        assert_ne!(sticky_key(&u, &[Some("run-abcdefgh")], b"salt"), bare);
    }

    /// 同一个键永远挑到同一个出口。
    #[test]
    fn one_conversation_always_lands_on_the_same_endpoint() {
        let pool: Vec<(uuid::Uuid, f64, f64)> = (1..=4)
            .map(|i| (uuid::Uuid::from_u128(i), 0.2 * i as f64, 1.0))
            .collect();
        let k = sticky_key(&uid(), &[Some("run-abcdefgh")], b"salt");
        let first = hrw_pick(&k, &pool).unwrap();
        for _ in 0..200 {
            assert_eq!(hrw_pick(&k, &pool).unwrap(), first, "同一个键挑出了不同的出口");
        }
    }

    /// 移走一个**没被选中**的出口，选择不变。
    ///
    /// 这是加权 rendezvous 相对「按权重划分区间」的关键优势：集合变化时扰动最小。
    /// 区间划分会让所有人集体平移 —— 也就是所有人的上游缓存同时作废。
    #[test]
    fn removing_an_unchosen_endpoint_moves_nobody() {
        let pool: Vec<(uuid::Uuid, f64, f64)> = (1..=5)
            .map(|i| (uuid::Uuid::from_u128(i), 0.15 * i as f64, 1.0))
            .collect();
        let mut unchanged = 0;
        for n in 0..400u128 {
            let k = sticky_key(&uuid::Uuid::from_u128(n), &[None], b"salt");
            let chosen = pool[hrw_pick(&k, &pool).unwrap()].0;
            // 去掉一个不是它选中的出口
            let drop = pool.iter().find(|(id, _, _)| *id != chosen).unwrap().0;
            let smaller: Vec<_> = pool.iter().filter(|(id, _, _)| *id != drop).cloned().collect();
            if smaller[hrw_pick(&k, &smaller).unwrap()].0 == chosen {
                unchanged += 1;
            }
        }
        assert_eq!(unchanged, 400, "移走一个没被选中的出口，却有人被迫换了地方");
    }

    /// 溢出时按权重铺开，便宜的分得多 —— 但不是全拿。
    #[test]
    fn overflow_spreads_by_price_not_winner_take_all() {
        // 三折 vs 六折：γ=2 → 权重比 (1/0.3)² : (1/0.6)² = 4:1
        let pool = vec![
            (uuid::Uuid::from_u128(11), 0.3, 1.0),
            (uuid::Uuid::from_u128(22), 0.6, 1.0),
        ];
        let mut cheap = 0;
        const N: u128 = 4000;
        for n in 0..N {
            let k = sticky_key(&uuid::Uuid::from_u128(n), &[None], b"salt");
            if pool[hrw_pick(&k, &pool).unwrap()].0 == uuid::Uuid::from_u128(11) {
                cheap += 1;
            }
        }
        let share = cheap as f64 / N as f64;
        assert!(
            (0.76..0.84).contains(&share),
            "三折应拿到约 80%（4:1），实际 {share:.3} —— 权重函数被改动了"
        );
    }

    /// 垃圾进价不能让排序 panic。
    ///
    /// Rust 1.81 起，不自洽的比较器是 **panic** 而不是乱序 —— 一个 NaN 进到权重里，
    /// 整个网关的选路会直接崩。
    #[test]
    fn garbage_prices_never_panic_the_picker() {
        let pool = vec![
            (uuid::Uuid::from_u128(1), f64::NAN, 1.0),
            (uuid::Uuid::from_u128(2), 0.0, 1.0),
            (uuid::Uuid::from_u128(3), -1.0, 1.0),
            (uuid::Uuid::from_u128(4), f64::INFINITY, 1.0),
            (uuid::Uuid::from_u128(5), 0.5, 1.0),
        ];
        let k = sticky_key(&uid(), &[None], b"salt");
        let got = hrw_pick(&k, &pool);
        assert!(got.is_some(), "全是垃圾价时没挑出任何出口");
        for bad in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
            // 价格和容量两边各喂一遍垃圾，都不许产出非有限权重。
            assert!(overflow_weight(bad, 1.0).is_finite() && overflow_weight(bad, 1.0) > 0.0);
            assert!(overflow_weight(0.5, bad).is_finite() && overflow_weight(0.5, bad) > 0.0);
        }
        assert!(hrw_pick(&k, &[]).is_none(), "空集合应当回 None");
    }

    /// 没填容量的按池内最小值兜底，不是按 1。
    ///
    /// 按 1 的话，「一个填了 600、一个没填」会差六百倍 —— 运维只是没填，
    /// 却等于把那个出口关掉了，而且完全看不出来。
    #[test]
    fn an_undeclared_capacity_falls_back_to_the_smallest_declared_one() {
        assert_eq!(fill_capacities(&[None, None]), vec![1.0, 1.0], "全没填该一律 1");
        assert_eq!(
            fill_capacities(&[Some(600.0), None]),
            vec![600.0, 600.0],
            "只有一个填了，没填的该跟它齐平，而不是掉到 1"
        );
        assert_eq!(
            fill_capacities(&[Some(600.0), Some(20.0), None]),
            vec![600.0, 20.0, 20.0],
            "没填的该按已填里的最小值 —— 不知道能扛多少就当它最不能扛"
        );
        // 垃圾值当成没填。
        assert_eq!(
            fill_capacities(&[Some(f64::NAN), Some(50.0), Some(-3.0)]),
            vec![50.0, 50.0, 50.0]
        );
    }

    /// 容量真的参与溢出分配。
    #[test]
    fn a_bigger_endpoint_takes_more_of_the_overflow() {
        // 同价，容量 10:1 → 份额也该接近 10:1
        let pool = vec![
            (uuid::Uuid::from_u128(11), 0.5, 10.0),
            (uuid::Uuid::from_u128(22), 0.5, 1.0),
        ];
        let mut big = 0;
        const N: u128 = 4000;
        for n in 0..N {
            let k = sticky_key(&uuid::Uuid::from_u128(n), &[None], b"salt");
            if pool[hrw_pick(&k, &pool).unwrap()].0 == uuid::Uuid::from_u128(11) {
                big += 1;
            }
        }
        let share = big as f64 / N as f64;
        assert!(
            (0.87..0.95).contains(&share),
            "容量 10:1 应拿到约 91%，实际 {share:.3} —— 容量没进权重"
        );
    }

    /// 承接只在启动时做，派单路径上一个 await 都不许加。
    ///
    /// 这是整套设计的地基：让位判定必须是纯内存的一次哈希 + 一把短锁。往里加一次
    /// Redis 往返，几千 QPS 下就是几千次网络等待 —— 而这个功能的目的正是不卡顿。
    #[test]
    fn saturation_is_restored_at_boot_never_on_the_dispatch_path() {
        let s = src();
        // 写是火后不管（tokio::spawn），不阻塞请求。
        let i = s.find("pub fn persist_saturation(").expect("持久化函数不见了");
        let body = &s[i..s[i..].find("\n/// 启动时").map(|j| i + j).unwrap_or(s.len())];
        assert!(
            body.contains("tokio::spawn("),
            "落 Redis 变成同步的了 —— 每个 429 都会让用户多等一次网络往返"
        );
        assert!(
            body.contains("EX"),
            "没设 TTL：键会永远留着，出口再也回不来"
        );
        // 读只在启动。派单路径（chat_completions）里不许出现承接调用。
        let gw = include_str!("models.rs");
        let prod = gw.split("\n#[cfg(test)]").next().unwrap();
        assert!(
            !prod.contains("restore_saturation("),
            "承接跑进派单路径了 —— 那是一次 SCAN，绝不能在每个请求上做"
        );
    }

    /// 承接读的是**剩余** TTL，不是当初写进去的时长。
    #[test]
    fn restore_uses_the_remaining_ttl_not_the_original_window() {
        let s = src();
        let i = s.find("pub async fn restore_saturation(").expect("承接函数不见了");
        let body = &s[i..];
        assert!(
            body.contains("redis::cmd(\"TTL\")"),
            "没读剩余 TTL：一个写的时候是 300 秒、已经走了 290 秒的键，会被当成又要让位 300 秒"
        );
        assert!(
            body.contains("redis::cmd(\"SCAN\")") && !body.contains("redis::cmd(\"KEYS\")"),
            "用了 KEYS —— 它会阻塞整个 Redis，而这台机器上 Redis 还扛着会话和健康数据"
        );
    }

    /// 权重里不许出现任何健康信号。
    ///
    /// 健康是阶跃量（探测是单样本 0/1、进程内记号发版后全空）。折进连续权重的话，
    /// 一次抖动就让过半在途对话集体迁走 —— 而粘性存在的意义正是防这件事。
    /// 排除坏出口是**排除**，在选完之后那道重排里做，不是降权。
    #[test]
    fn the_overflow_weight_never_looks_at_health() {
        let s = src();
        let i = s.find("pub fn overflow_weight(").expect("权重函数不见了");
        let body = &s[i..s[i..].find("\npub fn hrw_pick").map(|j| i + j).unwrap_or(s.len())];
        for banned in [
            "route_cooldown_remaining",
            "route_recently_stalled",
            "route_mutes_thinking",
            "probe_ok",
            "route_health::",
        ] {
            assert!(
                !body.contains(banned),
                "权重里读了 {banned} —— 阶跃信号折进连续权重会让粘性在抖动时集体失效"
            );
        }
    }

    /// 哈希必须是 SHA-256。
    #[test]
    fn the_hash_is_stable_across_rust_versions() {
        // 先剥注释：这个文件的注释里就写着「不能用 DefaultHasher」，不剥的话
        // 断言会被说明文字喂绿（或者像这次一样，被喂红）。
        let s: String = src()
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") { "" } else { l }
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !s.contains("DefaultHasher"),
            "用了 DefaultHasher —— Rust 保留换算法的权利，换一次全网粘性静默清零且不报错"
        );
        // 按判据数，不按次数数：两个函数各自都得用 SHA-256。
        for (name, end) in [
            ("pub fn sticky_key(", "\nfn normalise_scope"),
            ("pub fn hrw_pick(", "\n/// 取一批线路的出口"),
        ] {
            let i = s.find(name).unwrap_or_else(|| panic!("{name} 不见了"));
            let body = &s[i..s[i..].find(end).map(|j| i + j).unwrap_or(s.len())];
            assert!(body.contains("Sha256"), "{name} 没用 SHA-256");
        }
    }

    #[test]
    fn serving_rank_puts_no_evidence_before_bad_evidence() {
        assert!(serve_rank("ok") < serve_rank("degraded"));
        assert!(serve_rank("degraded") < serve_rank("unknown"));
        assert!(serve_rank("unknown") < serve_rank("error"));
        // 词表之外的一律当最坏，不会被当成绿的。
        assert_eq!(serve_rank("随便什么"), serve_rank("error"));
    }

    /// 聚合出来的词必须还在 `route_health::classify` 那套词表里。
    ///
    /// 自己编一个新词（比如 "bad"）不会报错，只会让面板和告警落进各自的 `_ =>` 分支：
    /// 一个显示成灰点，一个当成「不是 error」而永远不报警。
    #[test]
    fn the_aggregate_never_invents_a_new_word() {
        let s = src();
        let i = s.find("pub async fn best_word(").expect("聚合函数不见了");
        let body = &s[i..s[i..].find("\n/// 面板上那一格").map(|j| i + j).unwrap_or(s.len())];
        assert!(
            !body.contains("\"bad\"") && !body.contains("\"down\""),
            "聚合造了一个 classify 里没有的词"
        );
        assert!(
            body.contains("crate::route_health::classify("),
            "聚合不再用 classify 定词了 —— 两套词表迟早对不上"
        );
    }

    /// 告警必须把多路由出口算进去。
    ///
    /// 健康是按出口记的，而流量大多走最便宜那个出口。告警要是只看线路自带地址的记录，
    /// 出口连败就永远进不了告警 —— 面板全绿、监控一次没响，正是这台机器出过的那次事故。
    #[test]
    fn the_alarm_sees_endpoint_failures_too() {
        let health = include_str!("route_health.rs");
        let prod = health.split("\n#[cfg(test)]").next().unwrap();
        assert!(
            prod.contains("crate::route_endpoints::best_word(&state, m.id, now_secs())"),
            "告警又只看线路自带地址了：挂在它下面的出口全坏光也不会有人知道"
        );
        assert!(
            !prod.contains("let word = classify(&h, now_secs());"),
            "告警绕开聚合，直接拿线路自己那条记录定词了"
        );
    }

    #[test]
    fn the_background_sweep_skips_endpoints_real_traffic_already_proved() {
        let s = src();
        let i = s.find("async fn sweep(").expect("轮次函数不见了");
        let body = &s[i..];
        assert!(
            body.contains(r#"classify(&health, now) == "ok""#),
            "自动探测不再跳过真实流量证明过的出口 —— 白烧 token，还占上游限流额度"
        );
    }

    /// 前端在「加一个出口」里发的那份 JSON，后端必须原样解得出来。
    ///
    /// 这条是踩出来的，不是防御性的：出口保存连着 5 次 400，而 400 是 axum 的
    /// **提取器**在进 handler 之前吐的 —— handler 里一行日志都不会打，网关日志干干净净，
    /// 从服务端完全看不出发生过什么。查了很久才定位到「前端多发/少发了一个字段」这一类。
    ///
    /// 所以判据要跨语言对齐：直接读前端源码里那个对象字面量的键，逐个查后端认不认。
    /// 手写一份期望清单没用 —— 它和真正被发出去的东西是两个东西，会各自漂移。
    #[test]
    fn 前端发的每个字段后端都认识() {
        let ui = include_str!("../admin-ui/src/pages/RouteEndpoints.tsx");
        // 定位真正的保存调用，而不是同文件里别的 post。
        let at = ui
            .find(r#""/api/admin/route-endpoints",
        {"#)
            .expect("保存调用的形状变了 —— 这条测试已经不在看真正发出去的东西了");
        let body = &ui[at..];
        let end = body.find("\n      );").expect("找不到调用的收尾");
        let body = &body[..end];

        // 对象字面量的顶层键：行首缩进恰好 10 空格的 `名字:`。
        let sent: Vec<&str> = body
            .lines()
            .filter_map(|l| {
                let k = l.strip_prefix("          ")?;
                if k.starts_with(' ') || k.starts_with("//") {
                    return None;
                }
                let name = k.split(':').next()?.trim();
                (!name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit()))
                .then_some(name)
            })
            .collect();
        assert!(
            sent.len() >= 12,
            "只认出 {} 个字段（{sent:?}）—— 解析规则和前端排版对不上了，\
             这时候测试会**恒真**，比失败还危险",
            sent.len()
        );

        // 后端认识的字段：SaveReq 里的 `pub 名字:`。
        let me = include_str!("route_endpoints.rs");
        let sat = me.find("pub struct SaveReq {").expect("SaveReq 改名了");
        let sblock = &me[sat..sat + me[sat..].find("\n}").expect("SaveReq 没有收尾")];
        let known: Vec<&str> = sblock
            .lines()
            .filter_map(|l| l.trim().strip_prefix("pub "))
            .filter_map(|l| l.split(':').next())
            .map(str::trim)
            .collect();
        assert!(known.len() >= 12, "SaveReq 的字段没解出来：{known:?}");

        let unknown: Vec<&&str> = sent.iter().filter(|k| !known.contains(k)).collect();
        assert!(
            unknown.is_empty(),
            "前端发了后端不认识的字段：{unknown:?}。\n\
             serde 默认会忽略多余字段，所以这**不一定**报错 —— 更常见的是静默丢掉，\
             用户填了东西、保存成功、结果没生效。"
        );
    }

    /// 新建出口那一发（没有 id、capacity 显式 null、两个空对象）必须能解开。
    ///
    /// `#[serde(default)]` 治的是「字段缺失」，治不了「字段是 null」—— 这两件事在
    /// serde 里是两条不同的路径，而前端 `capacity: x.trim() ? Number(x) : null`
    /// 发的恰好是后者。
    #[test]
    fn 新建出口的那份请求体解得开() {
        let rid = uuid::Uuid::new_v4();
        let raw = format!(
            r#"{{"route_id":"{rid}","label":"","base_url":"https://x.com/v1",
               "api_key":"sk-1","cost_ratio":1,"note":"","protocol":"",
               "active":true,"enabled_models":[],"capacity":null,
               "model_prices":{{}},"model_names":{{}}}}"#
        );
        let got: SaveReq = serde_json::from_str(&raw)
            .expect("新建出口的请求体解不开 —— 这就是那 5 次 400 的形状");
        assert_eq!(got.route_id, rid);
        assert_eq!(got.id, None, "没带 id 应该当成新建");
        assert_eq!(got.cost_ratio, 1.0);
        assert!(got.active);
        assert_eq!(got.capacity, None, "显式 null 必须当成没填，而不是解析失败");
    }

    /// 每个可空字段单独喂 null，逐个确认。
    ///
    /// 上面那条只覆盖了「前端今天恰好这么发」。前端改一行、或者中间层把空串规整成
    /// null，就会换成别的组合 —— 而每一种组合都是一次 400，症状还是同一个「点了没反应」。
    #[test]
    fn 任何一个字段是null都不会让请求失败() {
        let rid = uuid::Uuid::new_v4();
        let nullable = [
            "id",
            "label",
            "base_url",
            "api_key",
            "cost_ratio",
            "active",
            "note",
            "enabled_models",
            "protocol",
            "capacity",
            "model_prices",
            "model_names",
        ];
        for f in nullable {
            let raw = format!(r#"{{"route_id":"{rid}","{f}":null}}"#);
            let got: Result<SaveReq, _> = serde_json::from_str(&raw);
            assert!(
                got.is_ok(),
                "字段 `{f}` 是 null 就整发请求失败 —— 用户看到的是「点了没反应」，\
                 而 400 由提取器吐出，服务端不留任何日志"
            );
        }
        // 反面：route_id 是**唯一**必须有的字段，缺了就该失败。
        // 没有这一半的话，上面那圈断言用「什么都接受」也能全过。
        assert!(
            serde_json::from_str::<SaveReq>(r#"{"label":"x"}"#).is_err(),
            "route_id 都没有也能解开 —— 那这个结构体就不再校验任何东西了"
        );
    }
}

/// 改一个**已经上线跑过**的迁移文件 = 后端起不来。
///
/// sqlx 启动时拿文件内容算 sha384 和库里的比，对不上就拒绝启动 —— 不是跳过、
/// 不是警告，是反复重启：
///   `Error: migration 20260866 was previously applied but has been modified`
///
/// 实测踩过一次：往一个已上线的迁移末尾追加两句 ALTER，整个部署被打回，backend-green
/// 起不来被删掉。要加列就**新开一个文件**。
///
/// 清单由部署脚本在部署成功后刷新，所以它记的就是线上真正跑过的那一版。
#[cfg(test)]
mod applied_migrations {
    #[test]
    fn the_applied_migrations_are_never_edited() {
        let manifest = include_str!("../migrations/APPLIED.txt");
        let mut bad = Vec::new();
        let mut checked = 0usize;
        for line in manifest.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut it = line.split_whitespace();
            let (Some(_ver), Some(want), Some(file)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let path = format!("migrations/{file}");
            let Ok(bytes) = std::fs::read(&path) else {
                // 删掉一个已上线的迁移和改它一样糟：库里那条还在，文件没了，
                // sqlx 同样拒绝启动。
                bad.push(format!("{file}：文件没了，而它已经在线上跑过"));
                continue;
            };
            checked += 1;
            let got = {
                use sha2::Digest;
                use std::fmt::Write;
                sha2::Sha384::digest(&bytes).iter().fold(String::new(), |mut a, b| {
                    let _ = write!(a, "{b:02x}");
                    a
                })
            };
            if got != want {
                bad.push(format!("{file}：内容被改了（线上那版算出来是 {want}）"));
            }
        }
        assert!(
            checked > 50,
            "清单里只核到 {checked} 个迁移 —— 它多半是空的或者格式变了，这道闸等于没有",
        );
        assert!(
            bad.is_empty(),
            "有已上线的迁移被改动了，部署会让后端起不来。要加列请新开一个文件：\n  {}",
            bad.join("\n  "),
        );
    }
}

#[cfg(test)]
mod retire_tests {
    use super::*;

    fn ep(enabled: &[&str], active: bool, label: &str, url: &str) -> Endpoint {
        Endpoint {
            id: uuid::Uuid::new_v4(),
            balance_token: String::new(),
            last_ok_at: None,
            last_fail_at: None,
            real_sum: None,
            real_n: None,
            real_ok: None,
            real_bad: None,
            route_id: uuid::Uuid::nil(),
            label: label.into(),
            base_url: url.into(),
            api_key: String::new(),
            cost_ratio: 1.0,
            active,
            note: String::new(),
            probe_ok: None,
            probe_at: None,
            probe_ms: None,
            probe_note: String::new(),
            enabled_models: enabled.iter().map(|s| s.to_string()).collect(),
            protocol: String::new(),
            capacity: None,
        }
    }
    fn route(models: &[&str]) -> Model {
        Model {
            id: uuid::Uuid::new_v4(),
            enabled_models: models.iter().map(|s| s.to_string()).collect(),
            ..Model::blank()
        }
    }
    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    /// 所有者「我没用的模型了，他还保存着」：线路取消勾选，出口那份名单要跟着收。
    #[test]
    fn unchecking_on_the_route_retires_the_model_from_its_outlets() {
        let r = retire_from_outlet(&v(&["a", "b", "c"]), &v(&["b"])).expect("有变化");
        assert_eq!(r.remaining, v(&["a", "c"]));
        assert!(!r.orphaned);
    }

    /// 空名单 = 跟线路，线路那边已经改了，这里不用动；本来就不带这个模型的也不动。
    #[test]
    fn outlets_that_follow_the_route_or_never_carried_it_are_left_alone() {
        assert!(retire_from_outlet(&[], &v(&["b"])).is_none());
        assert!(retire_from_outlet(&v(&["a"]), &v(&["b"])).is_none());
    }

    /// 拿掉之后一个都不剩：**不能**存成空名单（空 = 跟线路 = 把它没有的货派给它撞 404），要停用。
    #[test]
    fn an_outlet_left_with_nothing_is_orphaned_not_emptied() {
        let r = retire_from_outlet(&v(&["b"]), &v(&["b"])).expect("有变化");
        assert!(r.orphaned);
        assert!(r.remaining.is_empty());
    }

    /// 线路那页要知道「这个模型是哪个出口带来的」；停用的出口带不来任何模型。
    #[test]
    fn carried_by_names_the_outlet_and_skips_inactive_ones() {
        let r = route(&["a"]);
        let eps = vec![
            ep(&["a", "x"], true, "转卖A", "https://a.example/v1"),
            ep(&["x", "y"], true, "", "https://relay.example.com/v1"),
            ep(&["z"], false, "停用的", "https://z.example/v1"),
        ];
        let m = carried_by(&r, &eps);
        assert_eq!(m["x"], serde_json::json!(["转卖A", "relay.example.com"]));
        assert_eq!(m["y"], serde_json::json!(["relay.example.com"]));
        assert!(m.get("a").is_none(), "线路自己的模型不算「带来的」");
        assert!(m.get("z").is_none(), "停用的出口带不来模型");
    }
}
