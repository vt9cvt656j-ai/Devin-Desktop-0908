//! 套餐额度体检 —— 「这个套餐给多少额度合适」的数据底座。
//!
//! # 它替掉了什么
//!
//! 老的「定价试算」是**正向**的：运营输入「给多少额度 + 卖多少钱」，它算保本倍率。
//! 问题是它要人先猜一个额度，而且成本那一步要人**手选一个渠道**——于是随手选中一个
//! 便宜渠道，算出来的成本就漂亮得不像话。线上真实情况是：60% 的流量跑在 usd_per_cny=1
//! 的站上，而页面默认那条是 usd_per_cny=10，两者差十倍。
//!
//! 这里反过来：把**真实用量**和**真实渠道构成**都从库里算出来，然后回答
//! 「现有这几个套餐，额度是偏紧还是偏大方、按现在的价卖亏不亏」。
//!
//! # 三个数据源，都不是假设
//!
//! * `model_usage` —— 每一次真实请求扣了多少真实分。用来算「一个付费用户一天烧多少」。
//! * `models` × `channel_rates` —— 每条连接指向哪个中转、那个中转 ¥1 买多少美元额度。
//!   用来把真实分折成人民币。
//! * `plan_quotas` × `prices` —— 每个套餐给多少额度、卖多少钱。
//!
//! # 单位链（错一位就差一百倍，所以写在这里）
//!
//! `plan_quotas.total_cents`、`users.quota_total_cents`、`model_usage.cost_cents` 是**同一个单位**：
//! 真实计费分。面值额度（用户看到的那个 $）= 真实分 ÷ `raw_cents_per_credit_usd`（默认 663，
//! 从 app_settings 取，本文件不许出现这个字面量）。人民币成本 = 真实分 ÷ 100 ÷ usd_per_cny。
//!
//! 实测对得上线上那张截图：面值 $271 × 663 / 100 = $1796.73 真实，÷10 = ¥179.67。

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::json;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::AppState;

/// 用量画像取最近多少天。两个月是这套库现在全部的数据量，再长没有意义；
/// 再短则赶上「大部分用户只活跃两天」这个分布，样本会碎掉。
const WINDOW_DAYS: i64 = 60;

/// 一个「有效样本」至少要有多少个付费用户。低于它就不给百分位——三五个人的
/// p90 是噪声，把它印在定价页上比不印更糟。
const MIN_PAYERS: i64 = 5;

#[derive(Serialize)]
struct Burn {
    p50: f64,
    p75: f64,
    p90: f64,
    max: f64,
    active_days_p50: f64,
    payers: i64,
    requests: i64,
}

#[derive(Serialize)]
struct ChannelMix {
    name: String,
    host: String,
    usd_per_cny: f64,
    /// 这条连接的倍率。**它夹在「用户被扣的额度」和「我们付给中转的钱」中间**：
    /// 扣用户的 = 上游价 × 倍率，所以我们的成本 = 扣用户的 ÷ 倍率。
    /// 漏掉这一步，倍率 8 的连接成本会被算高 8 倍，倍率 0.2 的会被算低 5 倍。
    rate: f64,
    requests: i64,
    /// 这条渠道这段时间的**售价合计，美元**（含线路倍率，不含汇率）。
    ///
    /// 原来叫 `raw_cents`、装的是「真实计费分」。那一列在 2026-08-28 从美元分变成了
    /// 人民币分，跨那一天求和等于把两种差 7.1 倍的单位相加，所以数据源换成了
    /// `model_usage.sell_micro_usd`。**名字必须跟着换**：留着 `raw_cents` 而里面装
    /// 美元，前端那一列的表头会继续写「真实分」，屏幕上出现一个大一万倍的数而没有
    /// 任何地方报错 —— 正是这轮审计要清掉的那种形状。
    sell_usd: f64,
    cny: Option<f64>,
    /// 这条渠道占总真实消耗的比例。定价要看它：一条 usd_per_cny=1 的线只要占了
    /// 六成流量，整体成本就跟着它走，而不是跟着最便宜那条走。
    share: f64,
}

pub async fn admin_plan_health(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<serde_json::Value>> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }

    // 面值分母只有一个源（settings.rs），本文件不许出现那个字面量 ——
    // 有一条测试在守它（the_credit_denominator_has_exactly_one_source）。
    let denominator = crate::settings::raw_cents_per_credit_usd();

    // ---- 1. 付费用户的真实日耗 ----
    //
    // 判据是「付过费」而不是「现在挂着套餐」：套餐会过期，而过期用户当时的用量
    // 同样是付费用户的用量。只看当前挂套餐的，样本会少掉一大半。
    //
    // 按「用户 × 有活跃的那一天」聚合再取百分位，而不是直接对请求取百分位：
    // 定价关心的是「一个人一天烧多少」，不是「一次请求花多少」。
    //
    // 滤掉走免费池的那些行（free_milli_points_spent > 0）：它们的 cost_cents 记的是
    // requested_cost，**没有从任何余额里扣走**。算「额度能撑多久」时把它们算进来，
    // 等于让免费额度去消耗套餐额度，撑用天数会被系统性低估。线上占 1.8% 的行。
    let burn = sqlx::query_as::<_, (Option<i64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<i64>)>(
        "WITH payer AS ( \
           SELECT DISTINCT u.id FROM users u \
           WHERE (u.plan <> '' AND u.plan <> 'none') \
              OR EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') \
         ), d AS ( \
           SELECT m.user_id, m.created_at::date AS day, sum(m.cost_cents) AS c, count(*) AS reqs \
           FROM model_usage m JOIN payer p ON p.id = m.user_id \
           WHERE m.created_at > now() - ($1 || ' days')::interval \
             AND m.free_milli_points_spent = 0 \
             AND m.sell_micro_usd IS NOT NULL \
           GROUP BY 1, 2 \
         ), pu AS ( \
           SELECT user_id, count(*)::float8 AS active_days, avg(c)::float8 AS per_day, sum(reqs) AS reqs \
           FROM d GROUP BY 1 \
         ) \
         SELECT count(*)::bigint, \
                percentile_cont(0.5) WITHIN GROUP (ORDER BY per_day), \
                percentile_cont(0.75) WITHIN GROUP (ORDER BY per_day), \
                percentile_cont(0.9) WITHIN GROUP (ORDER BY per_day), \
                max(per_day), \
                percentile_cont(0.5) WITHIN GROUP (ORDER BY active_days), \
                sum(reqs)::bigint \
         FROM pu",
    )
    .bind(WINDOW_DAYS.to_string())
    .fetch_one(&state.db)
    .await?;

    let payers = burn.0.unwrap_or(0);
    let enough = payers >= MIN_PAYERS;
    let burn = Burn {
        p50: burn.1.unwrap_or(0.0),
        p75: burn.2.unwrap_or(0.0),
        p90: burn.3.unwrap_or(0.0),
        max: burn.4.unwrap_or(0.0),
        active_days_p50: burn.5.unwrap_or(0.0),
        payers,
        requests: burn.6.unwrap_or(0),
    };

    // ---- 2. 真实流量落在哪些渠道上 ----
    //
    // 这一段是整个页面的关键。成本不该由「运营手选的那个渠道」决定，而该由
    // **流量实际落在哪** 决定。join 走 base_url 的 host —— 和 channel_rates.host 同一个键。
    // **金额一律取 `sell_micro_usd`，不取 `cost_cents`。**
    //
    // `cost_cents` 的单位在 2026-08-28（c387e33）变过：那之前是美元分，那之后是
    // `usd_micro_to_wallet_cents` 折出来的人民币分，两者差 7.1 倍，而库里没有任何一列
    // 能把它们分开。这个页面的窗口是 60 天，横跨那一天 —— 直接 `sum(cost_cents)` 等于
    // 把两种单位相加，然后再当美元解释一遍，成本因此整体偏 7 倍，毛利结论会反向。
    //
    // `sell_micro_usd`（20260875）记的是这一笔的售价，micro-USD，含线路倍率、不含汇率，
    // **单位永不随汇率漂**。它只从本迁移上线之后才有值，所以旧行会被这条 WHERE 排除掉；
    // 这不是丢数据，是把「口径不明的行」和「能算的行」分开 —— 下面 `usable_rows`
    // 会把样本量如实报出去，页面照着说「统计了几行」，不假装窗口是满的 60 天。
    let mix = sqlx::query_as::<_, (String, Option<String>, Option<f64>, f64, i64, Option<i64>)>(
        "WITH u AS ( \
           SELECT mu.sell_micro_usd, m.label, m.rate, \
                  substring(m.base_url from '://([^/]+)') AS host \
           FROM model_usage mu JOIN models m ON m.id::text = mu.model_id::text \
           WHERE mu.created_at > now() - ($1 || ' days')::interval \
             AND mu.sell_micro_usd IS NOT NULL \
         ) \
         SELECT u.label, u.host, max(cr.usd_per_cny), u.rate, count(*)::bigint, \
                sum(u.sell_micro_usd)::bigint \
         FROM u LEFT JOIN channel_rates cr ON cr.host = u.host \
         GROUP BY 1, 2, 4 ORDER BY 6 DESC NULLS LAST",
    )
    .bind(WINDOW_DAYS.to_string())
    .fetch_all(&state.db)
    .await?;

    // 单位是 micro-USD（售价，含线路倍率）。局部变量名沿用 `raw` 只是懒得改一串，
    // 下发出去的字段已经跟着单位改了名（`sell_usd` / `unpriced_sell_usd`）。
    let total_raw: i64 = mix.iter().map(|r| r.5.unwrap_or(0)).sum();
    // 折人民币时**只算得出价的那部分**：一条没填购买价的线，它的消耗不能当成 0 块钱，
    // 否则整体成本会被系统性低估。它单独计数，前端要把这个缺口说出来。
    let mut priced_raw: i64 = 0;
    let mut priced_cny = 0.0_f64;
    let channels: Vec<ChannelMix> = mix
        .iter()
        .map(|(label, host, buy, mult, reqs, raw)| {
            let raw = raw.unwrap_or(0);
            // 先 ÷ 倍率还原成**我们真正付给中转的美元**，再 ÷ 购买价折人民币。
            // 这两步的顺序和 models.rs 的 project_quota_package 一致：
            // provider_usd = 售价美元 / multiplier; cny = provider_usd / usd_per_cny。
            //
            // 分子已经是 micro-USD 了（见上面那条 SQL 的注释），所以只除 1e6，
            // **不再乘任何汇率** —— 汇率那一步早在 `sell_micro_usd` 之前就没有了。
            let upstream = if *mult > 0.0 { raw as f64 / 1_000_000.0 / mult } else { 0.0 };
            let cny = buy
                .filter(|r| *r > 0.0)
                .filter(|_| *mult > 0.0)
                .map(|r| upstream / r);
            if let Some(c) = cny {
                priced_raw += raw;
                priced_cny += c;
            }
            ChannelMix {
                name: label.clone(),
                host: host.clone().unwrap_or_default(),
                usd_per_cny: buy.unwrap_or(0.0),
                rate: *mult,
                requests: *reqs,
                sell_usd: raw as f64 / 1_000_000.0,
                cny,
                share: if total_raw > 0 { raw as f64 / total_raw as f64 } else { 0.0 },
            }
        })
        .collect();

    // 综合购买价：真实消耗的美元额度 ÷ 真实花掉的人民币。它才是「¥1 实际买到多少美元额度」。
    // 综合购买价：**¥1 实际买到多少「用户额度美元」**。分子是扣用户的额度，分母是我们
    // 真花掉的人民币（已经过了倍率和各站购买价）。套餐额度是用「用户额度」计的，
    // 所以拿它去折算套餐成本，单位才对得上。
    let blended =
        if priced_cny > 0.0 { Some(priced_raw as f64 / 1_000_000.0 / priced_cny) } else { None };
    // 「最好 / 最差」也走同一个口径：¥1 买到多少用户额度美元 = 购买价 × 倍率。
    // 只比购买价是不够的 —— 倍率 8 的连接哪怕挂在最贵的站上，单位额度也很便宜。
    let effective = |c: &ChannelMix| {
        if c.usd_per_cny > 0.0 && c.rate > 0.0 { Some(c.usd_per_cny * c.rate) } else { None }
    };
    let best = channels.iter().filter_map(effective).fold(0.0_f64, f64::max);
    let worst = channels.iter().filter_map(effective).fold(f64::INFINITY, f64::min);

    // ---- 3. 套餐表：额度、售价、成本、能撑多久 ----
    let plans = sqlx::query_as::<_, (String, i64, i64, i32, Option<i64>, Option<String>)>(
        "SELECT q.plan, q.total_cents, q.window_cents, q.days, \
                (SELECT p.amount_cents FROM prices p \
                  WHERE p.plan = q.plan AND p.kind = 'plan' \
                  ORDER BY p.active DESC, p.sort LIMIT 1), \
                (SELECT p.label FROM prices p \
                  WHERE p.plan = q.plan AND p.kind = 'plan' \
                  ORDER BY p.active DESC, p.sort LIMIT 1) \
         FROM plan_quotas q ORDER BY q.rank, q.total_cents",
    )
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<serde_json::Value> = plans
        .iter()
        .map(|(plan, total, window, days, price_fen, label)| {
            // `total` 是 plan_quotas 的额度，单位和用户钱包一样（2026-08-28 起是人民币分）。
            // `rate` 这里是「¥1 买到多少**用户额度美元**」，分子必须先折成美元 ——
            // 直接 ÷100 当美元用，正是 08-28 之后这个页面成本偏 7 倍的那一步。
            let cost_at = |rate: f64| {
                if rate > 0.0 {
                    Some(*total as f64 * crate::settings::usd_per_wallet_cent() / rate)
                } else {
                    None
                }
            };
            let cost_blended = blended.and_then(cost_at);
            let price_cny = price_fen.map(|f| f as f64 / 100.0);
            // 「能撑几个活跃日」：额度 ÷ 这一档用户的日耗。样本不够就不给数，
            // 三五个人的 p90 是噪声，印在定价页上比不印更糟。
            let lasts = |per_day: f64| {
                if enough && per_day > 0.0 { Some(*total as f64 / per_day) } else { None }
            };
            json!({
                "plan": plan,
                "label": label,
                "total_cents": total,
                "window_cents": window,
                "days": days,
                "visible_usd": *total as f64 / denominator as f64,
                "price_cny": price_cny,
                "cost_best": cost_at(best),
                "cost_blended": cost_blended,
                "cost_worst": if worst.is_finite() { cost_at(worst) } else { None },
                "margin_blended": match (price_cny, cost_blended) {
                    (Some(p), Some(c)) if p > 0.0 => Some((p - c) / p * 100.0),
                    _ => None,
                },
                "lasts_p50_days": lasts(burn.p50),
                "lasts_p90_days": lasts(burn.p90),
            })
        })
        .collect();

    // 记成 0 分的请求占多少。这不是噪声，是**日耗被系统性低估**的度量：
    // 线路被删、模型在该线路没有价目条目、以及订阅用户额度见底后由运营吸收的超支，
    // 三种都会让这一行记 0 分而 token 照跑。线上实测 20.9%。
    let zero_cost_share: Option<f64> = sqlx::query_scalar(
        "SELECT count(*) FILTER (WHERE cost_cents = 0)::float8 / NULLIF(count(*), 0) \
         FROM model_usage WHERE created_at > now() - ($1 || ' days')::interval",
    )
    .bind(WINDOW_DAYS.to_string())
    .fetch_one(&state.db)
    .await?;

    let measured = measured_upstream_per_visible_usd(&state).await?;

    // **样本量要如实报出去。** 上面每一处金额都加了 `sell_micro_usd IS NOT NULL`
    // （单位可辨的那一批，见 mix 查询的注释），所以窗口写着 60 天、实际能算的可能只有
    // 几天。不把这两个数一起给出去的话，页面会拿一个几百行的样本画出「60 天画像」，
    // 而这正是控制台审计里反复出现的那种形状：一个确定的数，来源却是残缺的。
    let (usable_rows, total_rows, usable_since): (i64, i64, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT count(*) FILTER (WHERE sell_micro_usd IS NOT NULL), \
                    count(*), \
                    min(created_at) FILTER (WHERE sell_micro_usd IS NOT NULL) \
             FROM model_usage WHERE created_at > now() - ($1 || ' days')::interval",
        )
        .bind(WINDOW_DAYS.to_string())
        .fetch_one(&state.db)
        .await?;

    Ok(Json(json!({
        "denominator": denominator,
        "zero_cost_share": zero_cost_share,
        // 「这个页面的金额是拿多少行算出来的」。usable < total 说明窗口里还有一批
        // 2026-08-28 单位切换之前的旧行被排除在外 —— 那不是丢数据，是不混加。
        "usable_rows": usable_rows,
        "total_rows": total_rows,
        "usable_since": usable_since,
        "measured": measured,
        "window_days": WINDOW_DAYS,
        "enough_sample": enough,
        "min_payers": MIN_PAYERS,
        "burn": burn,
        "channels": channels,
        "blended_usd_per_cny": blended,
        "best_usd_per_cny": if best > 0.0 { Some(best) } else { None },
        "worst_usd_per_cny": if worst.is_finite() { Some(worst) } else { None },
        // 跑在「没填购买价」的中转上的那部分消耗，**美元**（和 channels[].sell_usd 同单位）。
        // 名字从 unpriced_raw_cents 改过来，理由见 ChannelMix.sell_usd 的注释。
        "unpriced_sell_usd": (total_raw - priced_raw) as f64 / 1_000_000.0,
        "plans": rows,
    })))
}

/// 探针每轮采样之间，同一个站的余额掉了多少 —— **实测**，不经过任何价目表。
///
/// # 为什么这个数比推算的可信
///
/// 页面另一处的成本是推出来的：面值 × 663 ÷ 线路倍率。那条链子里的 `off_in/off_out`
/// 是**你挂出去的售价**，不是中转的进价（线上有目录 $5、你挂 $15 的），所以 ÷倍率 只除掉了
/// 两层加价里的一层。而余额掉账是钱真的从账户里少掉的数，没有这一层偏差。
///
/// # 三个必须做对的地方，做错任何一个数就完全不能看
///
/// 1. **同一个站的多个令牌共用一个钱包。** 实测 hanhegufei 5 个 key、mhapi 4 个 key，
///    余额逐位相同。所以一个站只能取**一条**序列，否则消耗会翻 4-5 倍。
/// 2. **不能按 taken_at 去重。** 同站各路由各自打时间戳，差 1-2 秒，按时间分组根本合不到
///    一起 —— 第一版就是这么算出 8 倍的。这里改成先给每个站钉死一个 endpoint_id。
/// 3. **只累加下降的那一段。** 中途充值会让余额跳上去，`GREATEST(prev - cur, 0)` 把充值
///    排除在外；反过来累加上升段就得到充值额，用来交叉验算。
///
/// # 只回总量，不回分站
///
/// 分站的比值是**污染的**：额度按线路的 base_url 归属，而请求会 failover 到别的站的出口去，
/// 于是「这个站掉的钱」和「归到这个站的额度」不是同一批请求。实测 mhapi 掉了 $21.84 却
/// 一分额度都没归到它名下。总量上这些错配互相抵消，分站不行。
pub(crate) async fn measured_upstream_per_visible_usd(
    state: &AppState,
) -> Result<Option<serde_json::Value>, AppError> {
    // 探针**串过台**：开头两轮（2026-08-25 22:13 和 22:24）里，hanhegufei 的 Claude 路由和
    // zyz 的 GPT 路由报了**一模一样**的余额 162.35690952 —— 小数点后八位相同，不可能是巧合，
    // 是探针刚起来时把一家的余额安到了另一家头上。
    //
    // 这种读数一旦被选中当基线，会凭空多出一大截"掉账"（那两条序列的真实起点差 73 美元）。
    // `dup` 把"同一轮里被两个不同站同时报出的余额"整个剔掉 —— 判据是现象本身，
    // 不用去猜是哪一家串到哪一家。
    //
    // 顺带给挑序列补一个确定的次序：同一个站下五条路由的快照数经常打平（都是 70），
    // 只按 n DESC 的话选中哪条是随机的 —— 而其中一条恰好是被串台污染的那条。
    // 今天碰巧选的是干净的 deepseek，那是运气，不是设计。
    //
    // 窗口不能对**所有**站取交集：探针上线时间不一样，一个几乎不跑量的站晚开 16 小时，
    // 就会把公共窗口从 21 小时压成 5.6 小时（实测踩过，压完还触发了下面的最短窗口闸，
    // 于是整块数字消失）。所以先按掉账额把占比不到 1% 的站剔掉，再对剩下的取交集，
    // 并把剔掉的份额回报出去 —— 剔掉多少必须看得见，不能悄悄扔。
    let row: Option<(f64, f64, i64, f64, f64)> = sqlx::query_as(
        "WITH ep AS ( \
           SELECT substring(COALESCE(e.base_url, m.base_url) from 'https?://([^/]+)') AS host, \
                  b.endpoint_id, b.taken_at, b.remaining_usd, \
                  lag(b.remaining_usd) OVER (PARTITION BY b.endpoint_id ORDER BY b.taken_at) AS prev \
           FROM endpoint_balance b \
           LEFT JOIN route_endpoints e ON e.id = b.endpoint_id \
           LEFT JOIN models m ON m.id = b.endpoint_id \
           WHERE COALESCE(e.base_url, m.base_url) IS NOT NULL \
         ), host_span AS ( \
           SELECT host, min(taken_at) AS lo, max(taken_at) AS hi, \
                  count(DISTINCT endpoint_id) AS series \
           FROM ep GROUP BY host HAVING count(*) >= 8 \
         ), per_ep AS ( \
           SELECT host, endpoint_id, \
                  COALESCE(sum(GREATEST(prev - remaining_usd, 0)), 0) AS drawn \
           FROM ep GROUP BY host, endpoint_id HAVING count(*) >= 8 \
         ), per_host AS ( \
           SELECT p.host, \
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY p.drawn) AS drawn, \
                  s.lo, s.hi \
           FROM per_ep p JOIN host_span s ON s.host = p.host \
           GROUP BY p.host, s.lo, s.hi \
         ), tot AS (SELECT NULLIF(sum(drawn), 0) AS all_drawn FROM per_host), \
         big AS (SELECT h.* FROM per_host h, tot WHERE h.drawn >= 0.01 * tot.all_drawn), \
         span AS (SELECT max(lo) AS lo, min(hi) AS hi FROM big), \
         win_ep AS ( \
           SELECT e.host, e.endpoint_id, \
                  COALESCE(sum(GREATEST(e.prev - e.remaining_usd, 0)), 0) AS drawn \
           FROM ep e JOIN big g ON g.host = e.host, span s \
           WHERE e.taken_at BETWEEN s.lo AND s.hi \
           GROUP BY e.host, e.endpoint_id \
         ), up AS ( \
           SELECT COALESCE(sum(d), 0) AS usd FROM ( \
             SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY drawn) AS d \
             FROM win_ep GROUP BY host \
           ) z \
         ), q AS ( \
           SELECT COALESCE(sum(u.cost_cents), 0)::float8 AS raw_cents, count(*) AS reqs \
           FROM model_usage u, span s WHERE u.created_at BETWEEN s.lo AND s.hi \
         ) \
         SELECT up.usd, q.raw_cents, q.reqs, \
                (EXTRACT(epoch FROM (s.hi - s.lo)) / 3600.0)::float8, \
                COALESCE((SELECT sum(drawn) FROM big) / NULLIF((SELECT all_drawn FROM tot), 0), 0) \
         FROM up, q, span s",
    )
    .fetch_optional(&state.db)
    .await?;

    let Some((upstream_usd, raw_cents, reqs, hours, covered_share)) = row else {
        return Ok(None);
    };
    // 窗口太短或者这段时间根本没人用，算出来的比值是噪声，不如不给。
    // 探针 2026-08-25 才上线，所以这个 None 会持续到攒够一天为止 —— 那是对的，
    // 拿 3 小时的样本去定套餐额度比没有更糟。
    let denominator = crate::settings::raw_cents_per_credit_usd() as f64;
    let visible_usd = raw_cents / denominator.max(1.0);
    if hours < 6.0 || visible_usd <= 0.0 || upstream_usd <= 0.0 {
        return Ok(None);
    }
    Ok(Some(json!({
        "upstream_usd": upstream_usd,
        "visible_usd": visible_usd,
        "requests": reqs,
        "hours": hours,
        // 参与计算的那些站占全部掉账的多少。剔掉的是不到 1% 的小站，但份额要看得见。
        "covered_share": covered_share,
        // 每 1 美元面值额度，真的从中转账户里掉了多少上游美元。
        "upstream_per_visible_usd": upstream_usd / visible_usd,
    })))
}

#[cfg(test)]
mod tests {
    use super::{MIN_PAYERS, WINDOW_DAYS};

    /// 生产代码那一段的源文本。断言必须切掉测试模块 —— 否则断言会匹配到自己写的
    /// 字面量，整条测试恒真或恒假（本会话已经踩过一次）。
    fn prod_src() -> &'static str {
        let whole = include_str!("plan_health.rs");
        whole
            .split_once("\n#[cfg(test)]")
            .map(|(head, _)| head)
            .expect("plan_health.rs 应该有测试模块")
    }

    /// 面值分母全站只有一个源（settings.rs 的 DEFAULT_RAW_CENTS_PER_CREDIT_USD）。
    ///
    /// 这里再写一份 663 不会报错，只会让「运营在后台把分母改了」这件事对这一屏无效 ——
    /// 于是定价页算出来的面值额度和用户实际看到的对不上，而两边都不报错。
    #[test]
    fn the_denominator_is_never_written_down_here() {
        let src = prod_src();
        for (i, line) in src.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            assert!(
                !code.contains("663"),
                "plan_health.rs:{} 又硬编码了一份面值分母：{}",
                i + 1,
                line.trim(),
            );
        }
        assert!(
            src.contains("crate::settings::raw_cents_per_credit_usd()"),
            "没有从 settings 取分母",
        );
    }

    /// 人民币成本 = 真实分 ÷ 100 ÷ usd_per_cny。**除，不是乘。**
    ///
    /// usd_per_cny 的含义是「¥1 能买到多少美元额度」，所以它越大越便宜。写成乘法的话，
    /// 最便宜的渠道会算出最高的成本，整张表的结论正好反过来 —— 而且数字看着依然「合理」，
    /// 不会有任何地方报错。
    #[test]
    fn cost_divides_by_the_purchase_rate_never_multiplies() {
        let src = prod_src();
        // **先剥注释再断言。** 下面几条是「不许再出现旧写法」，而这个文件的注释里就在
        // 讲那些旧写法长什么样 —— 不剥的话断言会匹配到自己的说明文字，恒绿。
        let code: String = src
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        // 套餐额度是**钱包单位**（2026-08-28 起是人民币分），折成美元必须过汇率。
        // ÷100 当美元用是 c387e33 之后一直在犯的错，成本整体偏 7.1 倍且方向是「更赚钱」。
        assert!(
            code.contains("*total as f64 * crate::settings::usd_per_wallet_cent() / rate"),
            "套餐成本没过汇率——又回到「真实分 ÷ 100」了",
        );
        assert!(
            !code.contains("*total as f64 / 100.0 / rate"),
            "旧的 ÷100 口径又回来了",
        );

        // 渠道成本要走两步：先 ÷ 倍率还原成我们付给中转的美元，再 ÷ 购买价折人民币。
        // 漏掉倍率那一步，倍率 8 的连接成本会被算高 8 倍、倍率 0.2 的会被算低 5 倍，
        // 而两种都不会报错 —— 只是定价结论整个反过来。
        //
        // 分子现在取 sell_micro_usd（micro-USD，售价，不含汇率），所以是 ÷1e6 不是 ÷100。
        assert!(
            code.contains("raw as f64 / 1_000_000.0 / mult"),
            "渠道成本漏了「÷ 倍率」那一步，或者分子的单位换了没跟着改除数",
        );
        assert!(code.contains(".map(|r| upstream / r)"), "还原成上游美元之后没有再 ÷ 购买价");

        // 金额一律取 sell_micro_usd，不取 cost_cents：后者跨 08-28 是两种单位，
        // 而这个页面的窗口是 60 天，横跨那一天。
        assert!(
            code.contains("mu.sell_micro_usd IS NOT NULL"),
            "金额又回去读 cost_cents 了——那一列跨 2026-08-28 是两种单位",
        );
        assert!(
            code.contains("AND m.sell_micro_usd IS NOT NULL"),
            "日耗画像没过滤单位可辨的那一批行",
        );

        // 和 models.rs 那份权威实现同一个顺序，别让两处漂开。
        let authoritative = include_str!("models.rs");
        assert!(
            authoritative.contains("let provider_usd_capacity = quota_raw_usd / multiplier;")
                && authoritative.contains("let channel_cost_cny = provider_usd_capacity / usd_per_cny;"),
            "models.rs 的成本口径变了，plan_health 得跟着改",
        );
        // 综合购买价是「买到的美元额度 ÷ 花掉的人民币」，方向和上面一致。
        assert!(
            code.contains("priced_raw as f64 / 1_000_000.0 / priced_cny"),
            "综合购买价的方向或单位变了",
        );
    }

    /// 样本量必须和金额一起下发。
    ///
    /// 上面每一处金额都只统计 `sell_micro_usd IS NOT NULL` 的行（单位可辨的那一批），
    /// 所以窗口写着 60 天、实际能算的可能只有几天。不把样本量一起给出去的话，页面会
    /// 拿几百行画出一个「60 天画像」——一个确定的数，来源却是残缺的，而这正是控制台
    /// 审计里反复出现的那种形状。
    #[test]
    fn the_sample_size_travels_with_the_money() {
        let src = prod_src();
        for key in ["usable_rows", "total_rows", "usable_since"] {
            assert!(src.contains(key), "响应里少了 {key}，前端说不出这些数是拿多少行算的");
        }
    }

    /// 样本不够就**不给百分位**，而不是给一个看着像数的噪声。
    ///
    /// 这一屏是拿来定价的：三五个人的 p90 会让运营按一个不存在的规律去调额度。
    /// 「不知道」必须显示成不知道。
    #[test]
    fn a_thin_sample_never_pretends_to_be_a_distribution() {
        assert!(MIN_PAYERS >= 5, "样本下限太低，p90 会是噪声");
        assert!(WINDOW_DAYS >= 14, "窗口太短，撑不起「一个付费用户一天烧多少」");
        let src = prod_src();
        assert!(
            src.contains("if enough && per_day > 0.0"),
            "「能撑几天」没有被样本量闸住",
        );
        assert!(
            src.contains("\"enough_sample\": enough"),
            "前端拿不到样本够不够这个事实，就没法把「不知道」显示成不知道",
        );
    }

    /// 「能撑几天」是**活跃日**，套餐是**自然日**，两者不能直接比。
    ///
    /// 线上付费用户的活跃天数中位数只有个位数，而套餐是 30 天的 —— 直接比的话
    /// 几乎每一档都被判成「偏紧」，而那个判定会直接推着人去加额度（这一屏正是给人
    /// 定额度用的）。所以前端必须先按占空比折算成自然日。
    #[test]
    fn days_are_compared_in_the_same_unit() {
        let ui = include_str!("../admin-ui/src/components/PlanHealthTab.tsx");
        let code: String = ui
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("toCalendarDays("),
            "少了活跃日→自然日的换算",
        );
        assert!(
            !code.contains("p.lasts_p50_days < p.days")
                && !code.contains("p.lasts_p90_days > p.days * 2"),
            "还在拿活跃日直接和自然日比",
        );
        // 换算要用到的两个数服务端得下发。
        let src = prod_src();
        assert!(src.contains("\"active_days_p50\"") || src.contains("active_days_p50"));
        assert!(src.contains("\"window_days\": WINDOW_DAYS"));
    }

    /// 实测口径的三个坑，每一个做错都会让数字整体翻倍，而且不会报错。
    ///
    /// 这三条都是真踩出来的：第一版按 `taken_at` 去重，算出 8 倍；发现同站多令牌共用一个
    /// 钱包（hanhegufei 5 个 key、mhapi 4 个 key 余额逐位相同）之后才改成一站一条序列。
    #[test]
    fn the_measured_cost_counts_each_wallet_once() {
        let src = prod_src();
        let at = src
            .find("async fn measured_upstream_per_visible_usd")
            .expect("实测口径的函数没了");
        let end = src[at..].find("\n#[cfg(test)]").map(|i| at + i).unwrap_or(src.len());
        let body = &src[at..end];

        // 一个站一个数，取**这个站各条探针序列的中位数**。
        //
        // 不能挑一条了事：实测 hanhegufei 五条序列里，智普/Grok/deepseek 都是 98.09，
        // 而 Claude 那条是 171.28 —— 它开头两轮报的是 zyz 的余额（162.35690952，
        // 小数点后八位和 zyz 逐位相同），探针刚起来时串了台。五条序列快照数还打平，
        // 挑哪条全看排序的运气，选中被污染那条就多算 73 美元。
        // 中位数对「五条里坏一条」是稳的，也不用去猜是哪一家串到哪一家。
        assert!(
            body.contains("percentile_cont(0.5) WITHIN GROUP (ORDER BY drawn)"),
            "没有按站取中位数 —— 挑单条序列会被串台的那条带偏，而挑中哪条是随机的",
        );
        // 充值不能算成消耗，只累加下降段。
        assert!(
            body.contains("GREATEST(prev - remaining_usd, 0)"),
            "把充值也累加进消耗了",
        );
        // 样本太短就不给数，而不是给一个噪声。
        assert!(body.contains("hours < 6.0"), "没有最短窗口闸，3 小时的样本会被当成结论");
        // 分站比值是污染的（额度按线路归属、请求会 failover 到别站出口），只回总量。
        assert!(
            !body.contains("\"per_host\""),
            "回了分站数据 —— 那个比值是污染的，实测 mhapi 掉了钱却一分额度都没归到它名下",
        );

        let ui = include_str!("../admin-ui/src/components/PlanHealthTab.tsx");
        assert!(ui.contains("upstream_per_visible_usd"), "页面没用实测值");
        assert!(ui.contains("不经过任何价目表"), "页面没说清实测和推算的区别");
    }

    /// 两个方向相反的偏差必须一起下发，页面才说得清「这是区间不是准数」。
    ///
    /// * 日耗**偏低**：20% 的请求记 0 分（线路已删 / 该线路没配这个模型的价 /
    ///   订阅用户额度见底后超支由运营吸收），token 照跑但不计入。
    /// * 成本**偏高**：扣用户的额度里含两层加价（线路倍率 + 每个模型自己挂的单价，
    ///   线上有目录 $5 挂 $15 的），这里只除掉了倍率那一层。
    ///
    /// 只披露一边比两边都不披露更糟 —— 那会让人以为另一边是准的。
    #[test]
    fn both_biases_are_reported_not_just_the_convenient_one() {
        let src = prod_src();
        assert!(
            src.contains("\"zero_cost_share\": zero_cost_share"),
            "没有下发「记 0 分的请求占多少」，页面就说不出日耗是下限",
        );
        let ui = include_str!("../admin-ui/src/components/PlanHealthTab.tsx");
        assert!(ui.contains("日耗是下限") && ui.contains("成本是上限"), "页面没有把两个偏差都说出来");
        assert!(ui.contains("zero_cost_share"), "页面没有用那个占比");
    }

    /// 没填购买价的那部分消耗**不能当成 0 块钱**。
    ///
    /// 把它算进分母会系统性低估成本：一条没填价的线跑了三成流量，整体成本就凭空少三成，
    /// 而页面上不会有任何异样。所以它单独计数，并且要下发给前端去说明。
    #[test]
    fn traffic_without_a_price_is_reported_not_counted_as_free() {
        let src = prod_src();
        assert!(
            src.contains("\"unpriced_sell_usd\": (total_raw - priced_raw)"),
            "没有把「没填价的那部分消耗」单独下发",
        );
        assert!(
            src.contains("if let Some(c) = cny {") && src.contains("priced_raw += raw;"),
            "折人民币时没有只累加得出价的那部分",
        );
    }
}
