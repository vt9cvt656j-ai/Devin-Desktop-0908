//! 网关适配器的同步与看守：**定时认一遍每家中转、拉真实价、抓涨价、盯记账能不能做。**
//!
//! # 看守的判据是「亏不亏」，不是「涨了几个百分点」
//!
//! **这一版推翻了上一版。** 上一版按涨幅百分比停用、默认关、并且永不停用某个模型的
//! 最后一条线路。两条都改了，理由分别是：
//!
//! · **百分比是错的判据。** 涨 200% 的模型如果毛利有 10 倍，照样赚钱；涨 20% 的薄利
//!   模型可能当场变亏本。按百分比停既误杀又漏杀 —— 而误杀会停掉一条正在赚钱的线路。
//!   换成「按新价重算真实用量，和同期实收比」之后，「不是恶意涨价的就没事」不再需要
//!   一条额外规则：一次不威胁毛利的涨价按定义就不触发。
//!
//! · **负毛利时照停，哪怕是最后一条线路。** 上一版的理由是「停用可能断服，取舍该由人做」。
//!   那个理由在负毛利下不成立：每一次调用都在赔钱时，不停才是持续伤害。断服你当天
//!   就会发现，慢性失血不会。
//!
//! 免费模型（实收为 0）不参与看守 —— 它的成本该不该花是运营决策，不是这个判据
//! 能回答的问题。
//!
//! # 「记账做不到」是一等公民
//!
//! 有些中转把价目接口关了（实测线上 zyz 和 polly 就把模型广场关了），有些家族
//! 上游根本没有公开价目（one-api）。这时候对账页那一行的成本**永远**是未知。
//!
//! 这件事不能只体现为「那一格是横杠」—— 它要有名字、有原因、能被数出来，
//! 否则它会一直存在而没有人把它当成待办。所以 `accounting_ready` 是一个落库的字段。

use axum::extract::{Query, State};
use axum::Json;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::models::Model;
use crate::relay_adapter::{self, Detection, Family};
use crate::AppState;

/// 多久同步一轮。
///
/// 6 小时：中转改倍率是人工操作，不会分钟级变动；而每一轮要打十几个上游请求，
/// 太密只是给对方添压力。抓涨价靠的是**每一轮都和上一轮比**，不是靠轮次密。
const SYNC_EVERY: Duration = Duration::from_secs(6 * 3600);

/// 亏本看守按新进价重算多久的真实用量。
///
/// 提成常量是因为它有**三个**引用：这里的 SQL、下发给控制台的字段、以及控制台表头
/// 那句「按新进价把最近 N 天的真实用量重算一遍」。原来后两处各抄了一个 7 ——
/// 窗口改成 14 的话页面会继续宣称是 7 天，而那句话是运维判断「为什么这条被停/没被停」
/// 时唯一的判据说明。
const MARGIN_WINDOW_DAYS: i64 = 7;

/// 涨多少算「值得报警」。
///
/// 30%：低于这个数的波动可能只是中转在调汇率或者我们分组变了，天天报会被静音；
/// 而恶意涨价通常是成倍的。这个阈值宁可粗一点 —— 报少了会漏，报多了会被忽略，
/// 后者更难修，因为它会训练人忽略这类告警。
const ALARM_PCT: f64 = 30.0;

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

/// 抓来的价过多久就不算数。
///
/// **拉空时刻意不删库**（上面 `!prices.is_empty()` 那道闸：中转临时抽风回个空清单，
/// 清库是我们自己制造的事故）。对一次抖动这是对的；对**永久失效**就不是了 ——
/// 那批价会以最后一次抓到的数字永远留着，而且不报错。
///
/// 线上实拍 2026-09-01：Claude 自带地址那家换了牌子，适配器认不出来了
/// （`family=未知`、`priced_models=0`），同步每几分钟仍在跑、每次都拉空，于是它那
/// 40 条价停在一天前一动不动 —— 而对账正拿它们当真实进价算成本。
///
/// **7 天，不是 24 小时。** 第一版定的 24 小时，上线当轮就把 Claude 自带地址那 40 条
/// 价扫掉了 —— 而它们只超期 **1 小时**（最后一次成功抓取 25 小时前）。代价是一条主力
/// 线路的成本侧当场变空，而那批价大概率仍然是对的：价目表按月变，适配器认不出牌子
/// 只说明我们读不到，不说明它变了。
///
/// 判据应该是「这家是不是不再维护了」，不是「今天有没有拉到」。价目表按月变，
/// 连着 7 天一次都没拉到才谈得上废弃；而一次改版、一次人机校验、一次证书过期
/// 都能让适配器断几个小时到一天。
///
/// 另一侧的保护是独立的：一次成功的抓取会把「上游目录里已经没有的模型」逐条删掉
/// （见下面那条 DELETE），所以 ox-alpha 那种「下架之后价冻结在 $0」不靠这个阈值兜。
pub const PRICE_FRESH_SECS: i64 = 7 * 24 * 3600;

/// 每百万 token 的美元价（库里的单位）。适配器给的是每 token，这里统一乘上去。
fn per_mtok(v: f64) -> f64 {
    v * 1_000_000.0
}

/// 把中转报的模型名对齐到**我们卖的那个拼写**。
///
/// 抓来的价按 `model_id` 存，而所有下游（对账的成本侧、比价屏、缺价提示）都是拿
/// **我们的**模型名去 join —— 而 SQL 的 join 是大小写敏感的。实测智普那家报的是
/// `GLM-5.2` / `GLM-5.3`，我们卖的是 `glm-5.2` / `glm-5.3`：价抓到了、一条都对不上，
/// 表现是「这个模型算不出成本」，和「上游真的不给价」长得一模一样。
///
/// 只在**大小写不同**时改写，别做更聪明的模糊匹配：`deepseek-v4-pro` 和
/// `deepseek-v4-flash` 差一个词就是两款货、两个价，猜错的代价是按错的价算钱。
///
/// `reported_set` 是这一轮上游报的**全部**名字。它只用来挡一种情况：上游同时报了
/// 两种拼写（`GLM-5.2` 和 `glm-5.2` 都在），那我们那个拼写的那一条才是权威，
/// 另一条别改写过去 —— 否则两条会挤进同一个主键，后写的盖掉先写的，而哪一条后写
/// 取决于上游数组的顺序。
///
/// **第一版这里写反了**：判据是 `if reported_set.contains(reported) { return reported }`，
/// 而 reported 必然在它自己的集合里 —— 于是这个函数恒等，改写一次都不会发生，
/// 而它看起来完全正常。是下面那条行为测试当场抓出来的。
fn canonicalise<'a>(
    reported: &'a str,
    ours: &'a HashMap<String, String>,
    reported_set: &HashSet<String>,
) -> &'a str {
    match ours.get(&reported.to_ascii_lowercase()) {
        // 拼写本来就一样，不用动。
        Some(canon) if canon == reported => reported,
        // 上游把我们那个拼写也报了 → 让那一条去占坑，这一条保持原样。
        Some(canon) if reported_set.contains(canon.as_str()) => reported,
        Some(canon) => canon.as_str(),
        None => reported,
    }
}

/// 一个出口同步一轮。
async fn sync_endpoint(
    state: &AppState,
    endpoint_id: uuid::Uuid,
    route_id: uuid::Uuid,
    base_url: &str,
    api_key: &str,
    console_token: &str,
    // 小写 → 我们卖的那个拼写。见 [`canonicalise`]。
    ours: &HashMap<String, String>,
) {
    let det = relay_adapter::detect(base_url).await;
    let (prices, price_why) = relay_adapter::fetch_pricing(&det, base_url, api_key, console_token).await;
    let balance = relay_adapter::fetch_balance(&det, base_url, api_key, console_token).await;

    // 先把变动抓出来，再覆盖 —— 顺序反了就再也比不出涨没涨。
    let old = sqlx::query_as::<_, (String, f64, f64)>(
        "SELECT model_id, input_per_mtok, output_per_mtok FROM endpoint_auto_price \
         WHERE endpoint_id = $1",
    )
    .bind(endpoint_id)
    .fetch_all(&state.db)
    .await;
    // **查库失败必须整轮放弃，不能当成「没有旧价」。**
    //
    // 压成空表的话有两层伤害，而且都是静默的：
    //   · 每个模型都走下面的 `else { continue }`，这一轮一个涨价都抓不到；
    //   · 紧接着新价会**无条件覆盖**，于是下一轮的比对基线也没了 —— 一次查库抖动
    //     能让一次真实涨价永远消失在数据里。
    // 空表本身是合法的（第一次同步），所以「Ok(空)」和「Err」必须分开。
    let old = match old {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, %endpoint_id, "读旧价失败，本轮跳过 —— 硬覆盖会连比对基线一起毁掉");
            return;
        }
    };
    let old: HashMap<String, (f64, f64)> =
        old.into_iter().map(|(m, i, o)| (m, (i, o))).collect();

    // **比对也要用对齐后的名字。**
    //
    // `old` 是从 `endpoint_auto_price` 读的，而那张表的 model_id 是写入时经
    // `canonicalise` 改写过的（下面那个 upsert）。这里如果拿上游的**原始**名字去查，
    // 恰恰是「需要改写大小写」的那批模型永远查不到旧价 → `continue` → 它们的涨价
    // 一次都比不出来。而涨价比对是全系统唯一会自动停线路止血的那条链的入口
    // （见 `check_margin_after_change`），对这些模型等于把它关掉了。
    //
    // 实测受影响的有真金额：hanhegufei 报的是 GLM-5.2 / GLM-5.3 / MiniMax-M3，
    // 没有小写孪生，而我们卖的全是小写。
    let reported_set: HashSet<String> = prices.iter().map(|p| p.model.clone()).collect();
    let mut worst: Option<(String, f64, f64, f64, f64, f64)> = None; // (model, oi, ni, oo, no, pct)
    for p in &prices {
        let model_id = canonicalise(&p.model, ours, &reported_set);
        let (ni, no) = (per_mtok(p.prices.input), per_mtok(p.prices.output));
        let Some(&(oi, oo)) = old.get(model_id) else { continue };
        // 涨幅按输入输出里涨得更狠的那个算。只看其中一个的话，一家把输出价翻倍、
        // 输入价不动，就完全抓不到 —— 而输出恰恰是贵的那一半。
        let pct_of = |o: f64, n: f64| if o > 0.0 { (n - o) / o * 100.0 } else { 0.0 };
        let pct = pct_of(oi, ni).max(pct_of(oo, no));
        if pct.abs() < 0.01 {
            continue;
        }
        // 降价和涨价在处置上是**两件事**：降价根本不触发毛利重算，
        // 而涨价会。两者都存 'none' 的话，界面只能给一个统称，
        // 于是一行降价会被标成「重算后仍在赚钱」—— 一句声称做过、实际没做的事。
        let _ = sqlx::query(
            "INSERT INTO endpoint_price_change \
               (endpoint_id, model_id, old_input, new_input, old_output, new_output, pct, acted) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(endpoint_id)
        // 和查旧价、和写新价用**同一个**名字。只改查询不改这里的话，历史行会按上游
        // 拼写落库、join 不上任何东西，控制台的涨价历史里会冒出一个我们不卖的模型名。
        .bind(model_id)
        .bind(oi)
        .bind(ni)
        .bind(oo)
        .bind(no)
        .bind(pct)
        .bind(if pct < 0.0 { "drop" } else { "none" })
        .execute(&state.db)
        .await;
        if worst.as_ref().is_none_or(|w| pct > w.5) {
            worst = Some((model_id.to_string(), oi, ni, oo, no, pct));
        }
    }

    // 覆盖当前价。**拉到空就什么都不动** —— 中转临时抽风回了个空清单时，
    // 清库会让对账页突然全变未知，而那是我们自己造成的，不是中转涨价。
    if !prices.is_empty() {
        for p in &prices {
            let model_id = canonicalise(&p.model, ours, &reported_set);
            let _ = sqlx::query(
                "INSERT INTO endpoint_auto_price \
                   (endpoint_id, model_id, input_per_mtok, output_per_mtok, cached_per_mtok, \
                    cache_write_per_mtok, per_request, group_name, group_multiplier, source, fetched_at) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) \
                 ON CONFLICT (endpoint_id, model_id) DO UPDATE SET \
                   input_per_mtok = EXCLUDED.input_per_mtok, \
                   output_per_mtok = EXCLUDED.output_per_mtok, \
                   cached_per_mtok = EXCLUDED.cached_per_mtok, \
                   cache_write_per_mtok = EXCLUDED.cache_write_per_mtok, \
                   per_request = EXCLUDED.per_request, \
                   group_name = EXCLUDED.group_name, \
                   group_multiplier = EXCLUDED.group_multiplier, \
                   source = EXCLUDED.source, fetched_at = now()",
            )
            .bind(endpoint_id)
            .bind(model_id)
            .bind(per_mtok(p.prices.input))
            .bind(per_mtok(p.prices.output))
            .bind(p.prices.cache_read.map(per_mtok))
            .bind(p.prices.cache_write.map(per_mtok))
            .bind(p.prices.per_request)
            .bind(p.group.clone().unwrap_or_default())
            .bind(p.group_multiplier)
            .bind(&p.source)
            .execute(&state.db)
            .await;
        }

        // **上游目录里已经没有的模型，那条价必须删掉。**
        //
        // 不删的话它会以最后一次抓到的价永远留在库里，而且不报错。线上实拍
        // （2026-08-26）：`stealth/ox-alpha` 被 OpenRouter 下架，我们那条 `$0` 的价
        // 停在 11:50 一动不动 —— 而那条线路 6924 次调用全跑在这个模型上。
        // 一个冻结在「免费」的价，正好是最危险的那种陈旧：它不会让任何数字变红，
        // 只会让成本永远算成 0。
        //
        // 删掉之后它变成「待录单价」，对账那页会明说这个模型算不出成本 ——
        // 「不知道」比「一个过期的零」有用得多。
        //
        // 只在**这一轮真的拉到了东西**时才删（上面那个 `!prices.is_empty()`）：
        // 一次抽风回空清单就清库，是我们自己制造的事故，不是上游下架。
        // **和上面写进去的用同一套名字。** 拿原始名字来删的话，刚刚对齐写入的
        // `glm-5.2` 会因为「不在 seen（里面是 GLM-5.2）里」当场被删掉 —— 每一轮
        // 同步都自己把自己的成果清空，而且不报错。
        let seen: Vec<String> = prices
            .iter()
            .map(|p| canonicalise(&p.model, ours, &reported_set).to_string())
            .collect();
        match sqlx::query(
            "DELETE FROM endpoint_auto_price \
             WHERE endpoint_id = $1 AND model_id <> ALL($2)",
        )
        .bind(endpoint_id)
        .bind(&seen)
        .execute(&state.db)
        .await
        {
            Ok(r) if r.rows_affected() > 0 => tracing::info!(
                endpoint = %endpoint_id,
                gone = r.rows_affected(),
                "上游目录里已经没有这些模型，对应的价已删（它们会变成待录单价）"
            ),
            Ok(_) => {}
            // 删不掉只是留了陈旧行，不该让整轮同步失败 —— 但必须留痕，
            // 否则「价为什么还是老的」永远查不出来。
            Err(e) => tracing::warn!(error = %e, endpoint = %endpoint_id, "清理下架模型的价失败"),
        }
    }

    // 充值套餐：拿得到就存，拿不到（没令牌 / 这家没开充值）就不动库存的。
    // **空手回不清表** —— 和价目同一条规矩：一次拉不到不该把已知的事实抹掉。
    let (plans, topup_reason) = relay_adapter::fetch_topup_plans(&det, base_url, console_token).await;
    if !topup_reason.is_empty() {
        tracing::debug!(endpoint = %endpoint_id, host = %base_url, reason = %topup_reason, "充值套餐没拉到");
    }
    for p in &plans {
        let _ = sqlx::query(
            "INSERT INTO endpoint_topup_plan \
               (endpoint_id, plan_key, plan_name, price, currency, granted, rate, raw, fetched_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) \
             ON CONFLICT (endpoint_id, plan_key) DO UPDATE SET \
               plan_name = EXCLUDED.plan_name, price = EXCLUDED.price, \
               currency = EXCLUDED.currency, granted = EXCLUDED.granted, \
               rate = EXCLUDED.rate, raw = EXCLUDED.raw, fetched_at = now()",
        )
        .bind(endpoint_id)
        .bind(&p.key)
        .bind(&p.name)
        .bind(p.price)
        .bind(&p.currency)
        .bind(p.granted)
        .bind(p.rate())
        .bind(&p.raw)
        .execute(&state.db)
        .await;
    }

    let ready = !prices.is_empty();
    // 没拿到价时，通用退路的原因**一定要接到最后**。
    //
    // 下面第三支（`det.note` 非空）会把探测阶段那句话直接当成结论，而自研网关、
    // 被挡住的面板恰好都走这一支 —— 于是「密钥被拒」和「回了 40 个模型但没有 pricing
    // 字段」这种能直接指路的信息全被盖掉，页面上只剩一句「只能手工录」。
    let with_why = |base: String| -> String {
        if ready || price_why.is_empty() || base.contains(&price_why) {
            return base;
        }
        if base.is_empty() { price_why.clone() } else { format!("{base}；{price_why}") }
    };
    let note = if ready {
        det.note.clone()
    } else if det.family == Family::Unknown {
        with_why(det.note.clone())
    } else if !det.note.is_empty() {
        with_why(det.note.clone())
    } else if det.family.can_fetch_pricing() {
        // 「要手工录」这句话 2026-08-26 起不再成立：抓不到价目时对账会按
        // **OpenRouter 官方价 × 这个出口的倍率**推算（见 reconcile::derived_price）。
        // 留着旧文案会让人以为这几个出口的成本是空的，而实际上它们已经有数了 ——
        // 一句过期的待办比没有待办更糟。
        format!(
            "专用价目接口没拉到（多半是站长把它关了）；{price_why} —— \
             对账已按 OpenRouter 官方价 × 倍率推算；把倍率填准，或手工录真价会更准"
        )
    } else {
        // 这里说「没有专用接口」而不是「没有价目接口」：通用那条路
        // （带密钥问 /v1/models 读 pricing）**每一家都试过了**，这句话必须如实反映
        // 试过什么，否则运维会以为还有一条没试的路。
        format!(
            "{} 没有专用价目接口；{price_why} —— \
             对账按 OpenRouter 官方价 × 倍率推算；把倍率填准，或手工录真价会更准",
            det.family.label()
        )
    };

    let _ = sqlx::query(
        "INSERT INTO endpoint_adapter \
           (endpoint_id, route_id, family, matched_by, note, quota_per_unit, priced_models, \
            balance_ok, balance_text, accounting_ready, topup_reason, synced_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now()) \
         ON CONFLICT (endpoint_id) DO UPDATE SET \
           route_id = EXCLUDED.route_id, family = EXCLUDED.family, \
           matched_by = EXCLUDED.matched_by, note = EXCLUDED.note, \
           quota_per_unit = EXCLUDED.quota_per_unit, priced_models = EXCLUDED.priced_models, \
           balance_ok = EXCLUDED.balance_ok, balance_text = EXCLUDED.balance_text, \
           accounting_ready = EXCLUDED.accounting_ready, \
           topup_reason = EXCLUDED.topup_reason, synced_at = now(), updated_at = now()",
    )
    .bind(endpoint_id)
    .bind(route_id)
    .bind(det.family.label())
    .bind(&det.matched_by)
    .bind(&note)
    .bind(det.quota_per_unit)
    .bind(prices.len() as i32)
    .bind(balance.is_some())
    .bind(balance.as_ref().map(|b| b.text.clone()).unwrap_or_default())
    .bind(ready)
    .bind(&topup_reason)
    .execute(&state.db)
    .await;

    // 有任何涨价就重算一次毛利。**不设百分比门槛** —— 薄利模型涨 5% 也可能翻负，
    // 而重算只是一次本地查询，便宜到不值得为它设阈值。
    if let Some((model, _, _, _, _, pct)) = worst {
        if pct > 0.0 {
            if pct >= ALARM_PCT {
                tracing::warn!(model, pct, %route_id, "进价明显上涨");
            }
            check_margin_after_change(state, endpoint_id, route_id).await;
        }
    }
}

/// 涨价之后：**按新价把真实用量重算一遍，看这条线路现在还赚不赚钱。**
///
/// # 判据是「亏不亏」，不是「涨了几个百分点」
///
/// 涨 200% 的模型如果毛利有 10 倍，照样赚钱；涨 20% 的薄利模型可能当场变亏本。
/// 按百分比停既误杀又漏杀 —— 而误杀的代价是停掉一条本来在赚钱的线路。
///
/// 换成这个判据之后，「不是恶意涨价的就没事」不需要额外规则：一次不威胁毛利的
/// 涨价按定义就不会触发。
///
/// # 为什么用**历史真实用量**重算，而不是拿单价直接比
///
/// 一条线路上不同模型的用量差几个数量级，缓存命中率也差很远。拿单价平均去比，
/// 得到的是一个和实际账单无关的数字。用过去 7 天的真实 token 按新价重算，
/// 算出来的就是「如果价格昨天就是这个数，我这周会付多少」。
async fn check_margin_after_change(
    state: &AppState,
    endpoint_id: uuid::Uuid,
    route_id: uuid::Uuid,
) {
    #[derive(sqlx::FromRow)]
    struct Row {
        revenue_micro: i64,
        prompt_tokens: i64,
        completion_tokens: i64,
        cached_tokens: i64,
        /// 写进缓存的 token。**单价最贵的一类**（输入价的 1.25 倍），而这道闸此前
        /// 一条都没算 —— 缓存命中率越高，它越乐观地说「还在赚」。
        cache_write_tokens: i64,
        input_per_mtok: f64,
        output_per_mtok: f64,
        cached_per_mtok: Option<f64>,
        cache_write_per_mtok: Option<f64>,
        per_request: Option<f64>,
        calls: i64,
    }
    // 只算**这个出口**过去 7 天真的跑过、而且现在有自动价的模型。
    // 没跑过的模型涨价不影响任何东西，把它算进来只会稀释判据。
    let rows: Vec<Row> = sqlx::query_as(
        // **「新鲜输入」按天算好再求和，不要先把 token 加总再夹一刀。**
        //
        // prompt 含不含 cached 是**逐条回执**的属性（Anthropic 单列上报、prompt 不含它；
        // OpenAI/DeepSeek/GLM 的 prompt 含）。原来的写法是先把整窗口的 token 加总，再在
        // Rust 里 `cached.min(prompt)` 无条件按「含」处理 —— 对 Anthropic 形状那一刀会把
        // 超出 prompt 的缓存读整段砍掉，成本被**低估**。
        //
        // 也**不能**照抄对账那边的 `bool_and(prompt_includes_cached)`：那个是刻意朝
        // 「高估成本」偏的，对报表无害，挂到**自动停用线路**上就是误杀。实测有出口
        // 六天里五天是 t、一天 f，bool_and 会把整窗判成 Anthropic 形状，算出 −1.7% 毛利，
        // 而真实是 +68.2%。按天/按模型逐行判，再求和，两种形状都不吃亏。
        //
        // 老行没有这一位（NULL）时的兜底和对账同源：`cached > prompt` 就说明 prompt 不含它。
        "SELECT u.revenue_micro_usd AS revenue_micro, u.prompt_tokens, u.completion_tokens, \
                u.cached_tokens, u.cache_write_tokens, \
                p.input_per_mtok, p.output_per_mtok, p.cached_per_mtok, p.cache_write_per_mtok, \
                p.per_request, u.calls \
         FROM ( \
             SELECT endpoint_id, model_id, SUM(revenue_micro_usd)::bigint AS revenue_micro_usd, \
                    SUM(CASE WHEN COALESCE(prompt_includes_cached, \
                                           NOT (cached_tokens > prompt_tokens)) \
                             THEN GREATEST(prompt_tokens - cached_tokens, 0) \
                             ELSE GREATEST(prompt_tokens, 0) END)::bigint AS prompt_tokens, \
                    SUM(completion_tokens)::bigint AS completion_tokens, \
                    SUM(cached_tokens)::bigint AS cached_tokens, \
                    SUM(cache_creation_tokens)::bigint AS cache_write_tokens, \
                    COUNT(*)::bigint AS calls \
             FROM endpoint_model_usage WHERE day > current_date - $2::int GROUP BY endpoint_id, model_id \
         ) u \
         JOIN endpoint_auto_price p \
           ON p.endpoint_id = u.endpoint_id AND p.model_id = u.model_id \
         WHERE u.endpoint_id = $1",
    )
    .bind(endpoint_id)
    .bind(MARGIN_WINDOW_DAYS as i32)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    if rows.is_empty() {
        return; // 没有可比的用量，任何结论都是编的
    }
    let mut revenue = 0.0_f64;
    let mut cost = 0.0_f64;
    for r in &rows {
        revenue += r.revenue_micro as f64 / 1_000_000.0;
        // `prompt_tokens` 这一列**已经是「新鲜输入」**了（上面 SQL 里按天逐行减过），
        // 所以这里不能再减一次。四项都要算，缺一项就是系统性地把成本往低了报，
        // 而这道闸的后果是「要不要自动停掉这条线路」。
        let fresh = r.prompt_tokens.max(0) as f64;
        let cache_read_price = r.cached_per_mtok.unwrap_or(r.input_per_mtok);
        // 缓存写入没单独录价时按输入价的 1.25 倍算 —— 和 20260864 那次迁移、
        // 以及 reconcile 的成本公式同一个兜底倍数。
        let cache_write_price = r
            .cache_write_per_mtok
            .unwrap_or(r.input_per_mtok * 1.25);
        cost += (fresh * r.input_per_mtok
            + r.cached_tokens.max(0) as f64 * cache_read_price
            + r.cache_write_tokens.max(0) as f64 * cache_write_price
            + r.completion_tokens.max(0) as f64 * r.output_per_mtok)
            / 1_000_000.0
            // 上游**按次**收的钱。单位是美元/次，不除以一百万。
            // 不读这一位的话，一条 input/output 都是 0、只按次计价的出口成本恒为 0 →
            // 毛利恒等于收入的 100% → 这道自动止血闸对它**结构性哑掉**：亏到底也不会停。
            // 线上 366 条自动价里有 32 条正是这种形状。
            + r.calls.max(0) as f64 * r.per_request.unwrap_or(0.0);
    }

    let (guard, floor): (bool, f64) = sqlx::query_as(
        "SELECT auto_guard, margin_floor_pct FROM endpoint_adapter WHERE endpoint_id = $1",
    )
    .bind(endpoint_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    // 读不到就按「开、下限 0」：这是保钱的方向。读库失败不该变成「不保护」。
    .unwrap_or((true, 0.0));

    let margin = revenue - cost;
    // 收入是 0 时毛利率没有意义（免费模型）。那种线路不参与看守 ——
    // 它的成本该不该花是运营决策，不是这个判据能回答的。
    if revenue <= 0.0 {
        return;
    }
    let pct = margin / revenue * 100.0;
    if pct >= floor {
        // 算过了、还在赚。**要留痕** —— 和「压根没算」在界面上必须能分开，
        // 否则那一列会把两种情况说成同一句话，而其中一句是假的。
        let _ = sqlx::query(
            "UPDATE endpoint_price_change SET acted = 'profitable' \
             WHERE id = (SELECT id FROM endpoint_price_change WHERE endpoint_id = $1 \
                         ORDER BY at DESC LIMIT 1) AND acted = 'none'",
        )
        .bind(endpoint_id)
        .execute(&state.db)
        .await;
        return;
    }

    let reason = format!(
        "按新进价重算最近 7 天：实收 ${revenue:.2}，中转要收 ${cost:.2}，\
         毛利 {pct:.0}%（低于下限 {floor:.0}%）"
    );
    let mut acted = "alarm";
    if guard {
        // **停用是这整套看守里唯一真正止血的动作，所以它成没成功必须是执行事实，
        // 不能是意图。** 丢掉这个 Result 的话：写失败 → 线路照常接单、每次调用都在
        // 赔钱，而日志、后台处置列、管理员邮件全都写着「已自动停用」，四处证据
        // 没有一处来自真实执行。这个模块自己的注释就写过这条规矩 ——
        // 「一个声称做过、实际没做的说明比没有说明更糟」。
        let done = sqlx::query("UPDATE models SET active = false WHERE id = $1")
            .bind(route_id)
            .execute(&state.db)
            .await;
        match done {
            Ok(r) if r.rows_affected() == 1 => {
                acted = "disabled";
                tracing::warn!(%route_id, revenue, cost, pct, "按新价重算已是负毛利，已停用线路");
            }
            // 停不掉比停掉更紧急：它还在赔钱，而且没有任何东西会再试一次
            // （新价已经覆盖，下一轮 pct 是 0，重算不会再被触发）。
            other => {
                acted = "disable_failed";
                let why = match &other {
                    Ok(r) => format!("影响了 {} 行（应为 1）", r.rows_affected()),
                    Err(e) => e.to_string(),
                };
                tracing::error!(%route_id, revenue, cost, pct, why = %why,
                    "负毛利，但**停用没成功** —— 线路仍在接单");
            }
        }
        let _ = sqlx::query(
            "UPDATE endpoint_adapter SET blocked_reason = $2, updated_at = now() \
             WHERE endpoint_id = $1",
        )
        .bind(endpoint_id)
        .bind(if acted == "disabled" { reason.clone() } else { format!("{reason}；**自动停用没成功，线路仍在接单**") })
        .execute(&state.db)
        .await;
    }

    let _ = sqlx::query(
        "UPDATE endpoint_price_change SET acted = $2 \
         WHERE id = (SELECT id FROM endpoint_price_change WHERE endpoint_id = $1 \
                     ORDER BY at DESC LIMIT 1)",
    )
    .bind(endpoint_id)
    .bind(acted)
    .execute(&state.db)
    .await;

    let (subject, body) = match acted {
        "disabled" => (
            "进价涨到亏本，已自动停用",
            format!(
                "一条线路的进价涨到亏本，已自动停用。\n\n{reason}\n\n\
                 判据不是「涨了百分之多少」，是**按新价把你最近 7 天的真实用量重算了一遍**。\n\
                 涨价但仍然赚钱的不会被停。\n\n后台 → 模型线路 → 网关适配器 看是哪一条。"
            ),
        ),
        // 这一封比「已停用」那封更紧急：钱还在流，而且没有任何东西会自己重试。
        "disable_failed" => (
            "⚠ 进价涨到亏本，但停用没成功",
            format!(
                "一条线路的进价涨到亏本，看守想停用它但**写库没成功，线路仍在接单**。\n\n\
                 {reason}\n\n请立刻去后台手动停用：模型线路 → 线路 → 停用。\n\n\
                 （不会自动重试：新价已经覆盖，下一轮算不出涨幅，重算不会再被触发。）"
            ),
        ),
        _ => (
            "进价涨到亏本",
            format!("一条线路的进价涨到亏本，但这个出口的自动停用是关的，没有动它。\n\n{reason}"),
        ),
    };
    crate::route_health::notify_admins(state, subject, &body).await;
}

/// 同步一轮：所有在转线路 + 它们的出口。
/// 每轮同步前清一次抓价表：**过期的**和**孤儿的**。
///
/// 两种都不是理论问题，线上各有一批：
///
/// · **过期**：拉空时刻意不删库（`!prices.is_empty()` 那道闸，防止上游抽风清库）。
///   对一次抖动这是对的；对永久失效就不是了 —— 那批价会以最后一次抓到的数字永远留着。
///   实拍 2026-09-01：Claude 自带地址那家换了牌子、适配器认不出了（family=未知、
///   priced_models=0），同步每几分钟仍在跑、每次拉空，它那 40 条价停在一天前一动不动，
///   而对账正拿它们当真实进价算成本。清掉之后那些模型会如实显示「算不出成本」——
///   「不知道」比「一个冻结的旧价」有用得多，这和 ox-alpha 那次的教训是同一条。
///
/// · **孤儿**：出口或线路被删了，它的价还挂在那儿。实测 1082 条挂在 11 个已删对象下，
///   最近一次更新是三天前。今天它们被各处的 JOIN 挡在外面，所以没造成错数 ——
///   但那是靠每一处都记得 JOIN，而不是靠数据本身干净。
///
/// **清理只放在这一处**（唯一的写入方）。读这张表的有五个地方，五份手写的新鲜度
/// 过滤器必然会漂，而漂掉的那一处会安静地继续拿旧价算钱。
async fn sweep(state: &AppState) {
    match sqlx::query(
        "DELETE FROM endpoint_auto_price WHERE fetched_at < now() - make_interval(secs => $1)",
    )
    .bind(PRICE_FRESH_SECS as f64)
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => tracing::info!(
            removed = r.rows_affected(),
            days = PRICE_FRESH_SECS / 86400,
            "抓价表：清掉过期的价（这些出口已经连着这么多天拉不到价了，别再拿它们算成本）"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "抓价表：过期清理没跑成"),
    }

    match sqlx::query(
        "DELETE FROM endpoint_auto_price p \
         WHERE NOT EXISTS (SELECT 1 FROM models m WHERE m.id = p.endpoint_id) \
           AND NOT EXISTS (SELECT 1 FROM route_endpoints e WHERE e.id = p.endpoint_id)",
    )
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => tracing::info!(
            removed = r.rows_affected(),
            "抓价表：清掉挂在已删线路/出口下的孤儿价"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "抓价表：孤儿清理没跑成"),
    }
}

pub async fn sync_once(state: &AppState) {
    let routes: Vec<Model> =
        match sqlx::query_as("SELECT * FROM models WHERE active = true ORDER BY sort, created_at")
            .fetch_all(&state.db)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "适配器同步：线路读不出来，本轮跳过");
                return;
            }
        };
    let eps = crate::route_endpoints::load_for_routes(
        &state.db,
        &routes.iter().map(|m| m.id).collect::<Vec<_>>(),
    )
    .await;

    // 我们**自己**卖的模型名，按小写索引。抓来的价要对齐到这个拼写，否则下游 join
    // 不上（SQL 大小写敏感）。见 `canonicalise`。
    //
    // 小写形式重名的一律**不收**：真出现两条线路一个卖 `Foo`、一个卖 `foo` 时，
    // 对齐到哪一个都是猜，而猜错就是按错的价算钱。宁可这两个继续按原样存。
    let mut seen_lower: HashMap<String, Option<String>> = HashMap::new();
    for name in routes
        .iter()
        .flat_map(|r| crate::models::allowed_ids(r))
        .chain(eps.values().flatten().flat_map(|e| e.enabled_models.clone()))
    {
        let k = name.to_ascii_lowercase();
        match seen_lower.get(&k) {
            Some(Some(prev)) if *prev != name => {
                seen_lower.insert(k, None); // 同名不同拼写 → 弃权
            }
            Some(_) => {}
            None => {
                seen_lower.insert(k, Some(name));
            }
        }
    }
    let ours: HashMap<String, String> = seen_lower
        .into_iter()
        .filter_map(|(k, v)| v.map(|n| (k, n)))
        .collect();

    sweep(state).await;

    let mut n = 0usize;
    for r in &routes {
        sync_endpoint(
            state,
            r.id,
            r.id,
            &r.base_url,
            &crate::models::model_key(&r.api_key),
            &crate::models::model_key(&r.balance_token),
            &ours,
        )
        .await;
        n += 1;
        for e in eps.get(&r.id).into_iter().flatten().filter(|e| e.active) {
            let key = if e.api_key.trim().is_empty() { r.api_key.clone() } else { e.api_key.clone() };
            // 同上：令牌只在线路那一级。
            let tok = r.balance_token.clone();
            sync_endpoint(
                state,
                e.id,
                r.id,
                &e.base_url,
                &crate::models::model_key(&key),
                &crate::models::model_key(&tok),
                &ours,
            )
            .await;
            n += 1;
        }
    }
    tracing::info!(endpoints = n, "网关适配器同步完成");
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 开机等一会：启动那一刻别和探活、余额快照抢同一批上游。
        tokio::time::sleep(Duration::from_secs(120)).await;
        loop {
            sync_once(&state).await;
            tokio::time::sleep(SYNC_EVERY).await;
        }
    });
}

/// **全仓唯一的「现在查一次这个出口的余额」入口。**
///
/// 在这之前有两份实现：`route_endpoints::read_balance`（健康面板在用）和
/// `relay_adapter::fetch_balance`（适配器在用）。两份对 sub2api 的做法不同 ——
/// 老的打 `/api/v1/auth/me`（要控制台令牌，拿不到），新的打 `/v1/usage`
/// （调用密钥就行，拿得到）。结果是同一批线路在适配器页有余额、在健康页显示
/// 「查不到」，而两页说的都是同一件事。老的那份已经删掉了。
///
/// 家族优先从库里读同步任务已经探好的结果：省两个往返，更重要的是保证
/// **两个页面认的是同一个家族**。库里没有（还没同步过）才现探一次。
pub async fn balance_now(
    state: &AppState,
    endpoint_id: uuid::Uuid,
    base_url: &str,
    api_key: &str,
    console_token: &str,
) -> Option<relay_adapter::Balance> {
    let stored: Option<(String, Option<f64>)> = sqlx::query_as(
        "SELECT family, quota_per_unit FROM endpoint_adapter WHERE endpoint_id = $1",
    )
    .bind(endpoint_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let det = match stored {
        Some((fam, qpu)) if !fam.is_empty() && fam != "未知" => Detection {
            family: Family::from_label(&fam),
            matched_by: "沿用同步任务的识别结果".into(),
            note: String::new(),
            quota_per_unit: qpu,
            detected_at: 0,
        },
        _ => relay_adapter::detect(base_url).await,
    };
    relay_adapter::fetch_balance(&det, base_url, api_key, console_token).await
}

// ---------------------------------------------------------------- 接口

#[derive(sqlx::FromRow, serde::Serialize)]
pub struct AdapterRow {
    pub endpoint_id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub family: String,
    pub matched_by: String,
    pub note: String,
    pub quota_per_unit: Option<f64>,
    pub priced_models: i32,
    pub balance_ok: bool,
    pub balance_text: String,
    pub accounting_ready: bool,
    pub blocked_reason: String,
    /// 充值套餐为什么没拉到。空 = 拉到了。
    ///
    /// 有它才分得清「这家没配控制台令牌」（运营去填一下）和「这家接口变了」（我们改代码）——
    /// 在这之前两者都只表现为一张空表。而没有充值套餐就没有真实进价，人民币成本只能手填。
    pub topup_reason: String,
    pub auto_guard: bool,
    pub margin_floor_pct: f64,
    pub synced_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(sqlx::FromRow, serde::Serialize)]
pub struct ChangeRow {
    pub endpoint_id: uuid::Uuid,
    pub model_id: String,
    pub old_input: Option<f64>,
    pub new_input: Option<f64>,
    pub old_output: Option<f64>,
    pub new_output: Option<f64>,
    pub pct: f64,
    pub acted: String,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// `GET /api/admin/relay-adapters`
pub async fn admin_list(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let rows: Vec<AdapterRow> = sqlx::query_as("SELECT * FROM endpoint_adapter")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let by_id: HashMap<uuid::Uuid, &AdapterRow> =
        rows.iter().map(|r| (r.endpoint_id, r)).collect();

    let routes: Vec<Model> =
        sqlx::query_as("SELECT * FROM models ORDER BY sort, created_at").fetch_all(&state.db).await?;
    let eps = crate::route_endpoints::load_for_routes(
        &state.db,
        &routes.iter().map(|m| m.id).collect::<Vec<_>>(),
    )
    .await;

    // 每条线路/出口一行，**没同步过的也要出现** —— 只列同步过的，
    // 一个从没被认出来的中转就永远不会出现在这一页上。
    let mut out = Vec::new();
    for r in &routes {
        let mut targets = vec![(r.id, format!("{}（自带地址）", r.label), r.base_url.clone(), r.active)];
        for e in eps.get(&r.id).into_iter().flatten() {
            let l = if e.label.trim().is_empty() { "未命名出口".into() } else { e.label.clone() };
            targets.push((e.id, format!("{} / {}", r.label, l), e.base_url.clone(), e.active));
        }
        for (id, label, base, active) in targets {
            let a = by_id.get(&id);
            out.push(serde_json::json!({
                "endpoint_id": id,
                "route_id": r.id,
                "label": label,
                "base_url": base,
                "active": active,
                "rate": r.rate,
                "vendor": crate::route_endpoints::vendor_of(
                    &r.provider, &crate::models::allowed_ids(r), &r.base_url),
                "family": a.map(|x| x.family.clone()).unwrap_or_default(),
                "matched_by": a.map(|x| x.matched_by.clone()).unwrap_or_default(),
                "note": a.map(|x| x.note.clone()).unwrap_or_else(|| "还没同步过".into()),
                "priced_models": a.map(|x| x.priced_models).unwrap_or(0),
                "balance_ok": a.map(|x| x.balance_ok).unwrap_or(false),
                "balance_text": a.map(|x| x.balance_text.clone()).unwrap_or_default(),
                "accounting_ready": a.map(|x| x.accounting_ready).unwrap_or(false),
                "blocked_reason": a.map(|x| x.blocked_reason.clone()).unwrap_or_default(),
                "topup_reason": a.map(|x| x.topup_reason.clone()).unwrap_or_default(),
                // 判据留在服务端。前端原来拿 `family !== "未知"` 和
                // `topup_reason.includes("控制台令牌")` 去比中文字面量 —— 服务端把
                // Family::Unknown 的显示名改一个字，或者把「令牌被拒」那句措辞调一下，
                // 页面上的计数就静默错位，而两边都不会报错。
                "family_known": a.map(|x| x.family != crate::relay_adapter::Family::Unknown.label()).unwrap_or(false),
                "topup_needs_token": a
                    .map(|x| x.topup_reason.starts_with("没配控制台令牌"))
                    .unwrap_or(false),
                // 没同步过的行也按默认值报「开」—— 库里那一行还不存在，
                // 但看守确实是开的，报「关」会让人以为没在保护。
                "auto_guard": a.map(|x| x.auto_guard).unwrap_or(true),
                "margin_floor_pct": a.map(|x| x.margin_floor_pct).unwrap_or(0.0),
                "synced_at": a.and_then(|x| x.synced_at),
                "quota_per_unit": a.and_then(|x| x.quota_per_unit),
            }));
        }
    }

    // 取最近 60 条给页面画，**同时**把真实总数一起下发。
    //
    // 原来只给这 60 条，页面拿 `changes.length` 当「价格异动 N」的指标 —— 那不是条数，
    // 是 LIMIT 撞出来的天花板。线上真实是 11666 条，页面一直写着 60，而且翻页条也说「共 60 条」，
    // 一页就翻完，看起来像「最近没什么异动」。
    const CHANGE_LIMIT: i64 = 60;
    let changes: Vec<ChangeRow> = sqlx::query_as(
        "SELECT endpoint_id, model_id, old_input, new_input, old_output, new_output, pct, acted, at \
         FROM endpoint_price_change ORDER BY at DESC LIMIT $1",
    )
    .bind(CHANGE_LIMIT)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let changes_total: i64 = sqlx::query_scalar("SELECT count(*) FROM endpoint_price_change")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    #[derive(sqlx::FromRow, serde::Serialize)]
    struct PlanRow {
        endpoint_id: uuid::Uuid,
        plan_key: String,
        plan_name: String,
        price: f64,
        currency: String,
        granted: Option<f64>,
        rate: Option<f64>,
        raw: String,
    }
    let plans: Vec<PlanRow> = sqlx::query_as(
        "SELECT endpoint_id, plan_key, plan_name, price, currency, granted, rate, raw \
         FROM endpoint_topup_plan ORDER BY price",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    #[derive(sqlx::FromRow, serde::Serialize)]
    struct TopupRow {
        endpoint_id: uuid::Uuid,
        granted: f64,
        matched_plan: String,
        price: Option<f64>,
        currency: String,
        at: chrono::DateTime<chrono::Utc>,
    }
    let topups: Vec<TopupRow> = sqlx::query_as(
        "SELECT endpoint_id, granted, matched_plan, price, currency, at \
         FROM endpoint_topup_event ORDER BY at DESC LIMIT 30",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    Ok(Json(serde_json::json!({
        "rows": out,
        "changes": changes,
        // 真实总数，不是上面那 60 条的长度 —— 页面拿 length 当指标会把 LIMIT 说成事实。
        "changes_total": changes_total,
        "change_limit": CHANGE_LIMIT,
        // 亏本看守的窗口。页面表头那句说明照它写，别再各抄一个 7。
        "margin_window_days": MARGIN_WINDOW_DAYS,
        "topup_plans": plans,
        "topups": topups,
    })))
}

#[derive(serde::Deserialize)]
pub struct GuardReq {
    pub endpoint_id: uuid::Uuid,
    pub auto_guard: bool,
}

/// `POST /api/admin/relay-adapters/guard` —— 开关某个出口的涨价自动停用。
pub async fn admin_guard(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<GuardReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    sqlx::query(
        "INSERT INTO endpoint_adapter (endpoint_id, route_id, auto_guard) \
         VALUES ($1, $1, $2) \
         ON CONFLICT (endpoint_id) DO UPDATE SET auto_guard = EXCLUDED.auto_guard, updated_at = now()",
    )
    .bind(req.endpoint_id)
    .bind(req.auto_guard)
    .execute(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
pub struct SyncQuery {
    #[serde(default)]
    pub endpoint_id: Option<uuid::Uuid>,
}

/// `POST /api/admin/relay-adapters/sync` —— 立刻同步一轮（整轮，或只同步一个出口）。
pub async fn admin_sync(
    State(state): State<AppState>,
    claims: Claims,
    Query(q): Query<SyncQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    // 整轮同步要打十几个上游、可能几十秒。**不能在请求里干等** ——
    // 前端会超时，而用户会以为失败了再点一次，于是同一轮跑好几遍。
    let st = state.clone();
    tokio::spawn(async move { sync_once(&st).await });
    let _ = q;
    Ok(Json(serde_json::json!({ "started": true })))
}

#[cfg(test)]
mod tests {
    /// 冻结的旧价不许继续被当成真实进价。
    ///
    /// 拉空时刻意不删库（防止上游抽风清库）。对一次抖动这是对的；对**永久失效**就不是：
    /// 那批价会以最后一次抓到的数字永远留着，而且不报错。实拍 2026-09-01：Claude 自带
    /// 地址那家换了牌子（family=未知、priced_models=0），同步每几分钟仍在跑、每次拉空，
    /// 它那 40 条价停在一天前一动不动 —— 而对账正拿它们当真实进价算成本。
    ///
    /// 清理放在**唯一的写入方**，不是在五处读取各挂一个过滤器：五份手写的天数必然会漂，
    /// 而漂掉的那一处会安静地继续拿旧价算钱。所以这条既钉「清了」也钉「在哪儿清」。
    #[test]
    fn frozen_prices_are_swept_at_the_one_writer_not_filtered_at_five_readers() {
        let src = include_str!("relay_sync.rs");
        let at = src.find("async fn sweep(").expect("sweep 不见了 —— 过期和孤儿价会永远留着");
        let body = &src[at..];
        let body = &body[..body.find("\npub async fn ").unwrap_or(body.len())];
        assert!(
            !body.contains("fn frozen_prices_are_swept"),
            "切片把这条测试自己包进来了 —— 断言会读到自己写的字面量",
        );
        // 两件事各一条 DELETE：过期的、孤儿的。
        assert!(
            body.contains("WHERE fetched_at < now() - make_interval(secs => $1)")
                && body.contains(".bind(PRICE_FRESH_SECS as f64)"),
            "过期清理没了，或者新鲜度不再走那个共用常量（另写一个天数就会和别处漂）",
        );
        assert!(
            body.contains("NOT EXISTS (SELECT 1 FROM models m WHERE m.id = p.endpoint_id)")
                && body.contains("NOT EXISTS (SELECT 1 FROM route_endpoints e WHERE e.id = p.endpoint_id)"),
            "孤儿清理没了 —— 出口一删，它的价还挂在表里（线上量到过 1082 条）",
        );

        // **必须在写新价之前跑。** 放在循环后面的话，这一轮里读价的人仍然读得到旧价；
        // 而同步是每几分钟一轮，那等于永远慢一轮。
        let once = src.find("pub async fn sync_once(").expect("sync_once 改名了");
        let tail = &src[once..];
        let sweep_at = tail.find("sweep(state).await;").expect("sync_once 里没调 sweep");
        let loop_at = tail.find("for r in &routes {").expect("同步循环不见了");
        assert!(sweep_at < loop_at, "sweep 跑在写新价之后了 —— 这一轮读到的还是旧价");

        // 读取方**不该**再各写一份新鲜度过滤器，否则就是在重新制造那种漂移。
        let rec = include_str!("reconcile.rs");
        assert!(
            !rec.contains("FROM endpoint_auto_price \\\n         WHERE fetched_at"),
            "对账那边又挂了一个自己的新鲜度过滤器 —— 五份判据必然漂，清理只该有一处",
        );
    }

    /// 抓来的价必须能按**我们卖的那个拼写**被 join 到，否则等于没抓。
    ///
    /// 所有下游（对账成本侧、比价屏、缺价提示）都是拿我们的模型名去 join
    /// `endpoint_auto_price.model_id`，而 SQL 的 join 大小写敏感。线上实测：智普那家
    /// 报的是 `GLM-5.2` / `GLM-5.3`，我们卖 `glm-5.2` / `glm-5.3` —— 价抓到了 40 条、
    /// 一条都对不上，表现是「这个模型算不出成本」，和「上游根本不给价」长得一模一样。
    #[test]
    fn scraped_prices_are_stored_under_the_name_we_actually_sell() {
        use std::collections::{HashMap, HashSet};
        let ours: HashMap<String, String> = [
            ("glm-5.2".to_string(), "glm-5.2".to_string()),
            ("glm-5.3".to_string(), "glm-5.3".to_string()),
            ("minimax-m3".to_string(), "minimax-m3".to_string()),
        ]
        .into_iter()
        .collect();

        // ① 只差大小写 → 对齐到我们的拼写。这是这个函数存在的理由。
        let reported: HashSet<String> =
            ["GLM-5.2".to_string(), "GLM-5.3".to_string(), "MiniMax-M3".to_string()]
                .into_iter()
                .collect();
        assert_eq!(super::canonicalise("GLM-5.2", &ours, &reported), "glm-5.2");
        assert_eq!(super::canonicalise("MiniMax-M3", &ours, &reported), "minimax-m3");

        // ② 我们不卖的模型原样存 —— 别乱猜。
        assert_eq!(super::canonicalise("GLM-4.7-FlashX", &ours, &reported), "GLM-4.7-FlashX");

        // ③ 上游**同时**报了两种拼写：我们那个拼写的那条才是权威，另一条别改写过去，
        //    否则两条挤进同一个主键，谁赢取决于上游数组的顺序。
        let both: HashSet<String> =
            ["GLM-5.2".to_string(), "glm-5.2".to_string()].into_iter().collect();
        assert_eq!(super::canonicalise("GLM-5.2", &ours, &both), "GLM-5.2");
        assert_eq!(super::canonicalise("glm-5.2", &ours, &both), "glm-5.2");

        // ④ 拼写本来就一样，原样返回。
        assert_eq!(super::canonicalise("glm-5.3", &ours, &reported), "glm-5.3");

        // ── 接线 ──────────────────────────────────────────────────────────
        // 纯函数对了不等于写库用了它，**也不等于删除用的名单跟着换了**。
        // 拿原始名字去删的话，刚刚对齐写入的那条会因为「不在 seen 里」当场被删掉 ——
        // 每一轮同步自己清空自己的成果，而且不报错。
        let src = include_str!("relay_sync.rs");
        let from = src.find("async fn sync_endpoint(").expect("sync_endpoint 改名了");
        let body = &src[from..];
        let body = &body[..body.find("\npub async fn ").unwrap_or(body.len())];
        assert!(
            body.contains("INSERT INTO endpoint_auto_price"),
            "切片没切到 sync_endpoint 的正文 —— 切坏了，下面的断言不作数",
        );
        assert!(
            !body.contains("fn scraped_prices_are_stored_under"),
            "切片把这条测试自己包进来了 —— 断言会读到自己写的字面量",
        );
        assert!(
            body.contains("let model_id = canonicalise(&p.model, ours, &reported_set);")
                && body.contains(".bind(model_id)"),
            "写库没走对齐后的名字",
        );
        assert!(
            body.contains(".map(|p| canonicalise(&p.model, ours, &reported_set).to_string())"),
            "删除用的名单还是原始名字 —— 会把刚对齐写进去的那条当场删掉",
        );
        // **涨价比对也要用对齐后的名字。** `old` 是从库里读的（里面是对齐后的拼写），
        // 拿上游原始名字去查的话，恰恰是需要改写大小写的那批模型永远查不到旧价 →
        // continue → 它们的涨价一次都比不出来。而涨价比对是全系统唯一会自动停线路
        // 止血的那条链的入口，对这些模型等于把它关掉了 —— 这个回归被引入过一次。
        assert!(
            body.contains("let Some(&(oi, oo)) = old.get(model_id) else { continue };"),
            "涨价比对又拿上游原始名字去查旧价了 —— 需要改写大小写的模型从此比不出涨价",
        );
        // 历史表也要落对齐后的名字，否则历史行 join 不上任何东西，控制台的涨价历史里
        // 会冒出一个我们不卖的模型名。
        let ins = body
            .find("INSERT INTO endpoint_price_change")
            .expect("涨价历史那条 INSERT 不见了");
        let ins: String = body[ins..].chars().take(700).collect();
        assert!(
            ins.contains(".bind(model_id)") && !ins.contains(".bind(&p.model)"),
            "涨价历史落的还是上游原始名字 —— 和另外三处用的不是同一个名字",
        );
    }

    use super::*;

    fn src() -> String {
        let all = include_str!("relay_sync.rs");
        all.split("\n#[cfg(test)]").next().unwrap().to_string()
    }

    /// 取一个函数的正文。**配平时要跳过字符串字面量和行注释里的花括号。**
    ///
    /// 不跳的话它会冲出函数末尾：`tracing::warn!("… {model} …")` 这种内联捕获在字面量里
    /// 就有 `{`，只有开没有闭，配平永远回不到 0，于是切片一路吃到文件后面 ——
    /// 包括**调用它的那条测试自己**。后果是断言在读自己写的字面量：
    /// `assert!(body.contains("…"))` 恒真、`assert!(!body.contains("…"))` 恒假。
    /// 本文件有 16 处用它，本轮实测被这个坑绊了一次（一条 `!contains(bool_and)` 的
    /// 断言无故变红，因为 body 里有的是测试自己写的那个词）。
    fn fn_body(src: &str, sig: &str) -> String {
        let at = src.find(sig).unwrap_or_else(|| panic!("找不到 {sig}"));
        let open = at + src[at..].find('{').expect("函数没有花括号");
        let b = src.as_bytes();
        let (mut d, mut i) = (0i32, open);
        // 只需要认三种会藏花括号的地方：普通字符串、原始字符串、行注释。
        // 字符字面量 '{' 在本仓的 Rust 里不出现，不额外处理。
        while i < b.len() {
            match b[i] {
                b'"' => {
                    i += 1;
                    while i < b.len() {
                        if b[i] == b'\\' {
                            i += 2;
                            continue;
                        }
                        if b[i] == b'"' {
                            break;
                        }
                        i += 1;
                    }
                }
                b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'{' => d += 1,
                b'}' => {
                    d -= 1;
                    if d == 0 {
                        return src[open..=i].to_string();
                    }
                }
                _ => {}
            }
            i += 1;
        }
        panic!("{sig} 花括号没配平");
    }

    /// 看守判据必须是「按新价重算的毛利」，不是涨幅百分比。
    ///
    /// 这条守的是这个模块最核心的一次修正：上一版按百分比停用，会把一条
    /// 涨了 200% 但仍有 10 倍毛利的线路误杀，同时漏掉一条涨 20% 就翻负的薄利线路。
    #[test]
    fn the_guard_fires_on_margin_not_on_percentage() {
        let body = fn_body(&src(), "async fn check_margin_after_change(");
        assert!(
            body.contains("endpoint_model_usage") && body.contains("endpoint_auto_price"),
            "没有按真实用量 × 新价重算 —— 那样算出来的数字和实际账单无关",
        );
        assert!(body.contains("let pct = margin / revenue * 100.0;"), "没算毛利率");
        assert!(
            body.contains("if pct >= floor {") && body.contains("return;"),
            "毛利仍在下限之上时没有直接放行 —— 那会把正常涨价也停掉",
        );
        // 触发点不许再挂百分比门槛。
        let sync = fn_body(&src(), "async fn sync_endpoint(");
        assert!(
            sync.contains("check_margin_after_change(state, endpoint_id, route_id).await"),
            "涨价之后没有重算毛利",
        );
    }

    /// 停用线路那道闸的成本公式，四项都要算，而且形状要按天逐行判。
    ///
    /// **这条断言 2026-09-01 改写过，原来的写法把一个 bug 钉死了。**
    /// 它原文钉的是 `let cached = r.cached_tokens.max(0).min(r.prompt_tokens.max(0));`，
    /// 理由写着「不减的话成本被高估，会误杀赚钱的线路」。方向的顾虑是对的，
    /// 但那个夹刀对 **Anthropic 形状**恰恰反了：那边 cached 是单列上报、prompt 不含它，
    /// 而且可以远大于 prompt，一刀夹下去把超出的缓存读整段砍掉 —— 成本被**低估**。
    ///
    /// 更严重的是它压根没算**缓存写入**：单价是输入价的 1.25 倍，是最贵的一类 token，
    /// 而这道闸一条都没算。方向固定：缓存命中率越高，它越乐观地说「还在赚」。
    /// 实测 mhapi.net 的 claude-opus-5，7 天真实用量下这道闸算 $3.28、对账算 $32.90，
    /// **差 10 倍**；整个出口它报 97.0% 毛利，实际 68.7%。
    ///
    /// 形状判定**不能**照抄对账那边的 `bool_and(prompt_includes_cached)`：那个是刻意朝
    /// 「高估成本」偏的，对报表无害，挂到自动停用上就是误杀（实测有出口六天五天 t、
    /// 一天 f，bool_and 会把整窗判成 Anthropic 形状，算出 −1.7% 而真实 +68.2%）。
    #[test]
    fn the_shutdown_guard_counts_all_four_cost_terms() {
        let raw = fn_body(&src(), "async fn check_margin_after_change(");
        // **先剥注释。** 下面几条是「不许出现某个词」的否定断言，而这个函数的注释里
        // 正解释着「不能照抄对账那边的 bool_and」—— 不剥的话断言被自己的说明喂饱，
        // 恒红。这是本仓反复出现的一种失效形状，只是这次方向反了（恒红而不是恒绿）。
        let body: String = raw
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let body = body.as_str();
        // 阳性对照：剥完还得剩下要查的代码。
        assert!(
            body.contains("FROM endpoint_model_usage"),
            "剥注释之后把代码也剥没了 —— 下面的断言不作数",
        );
        // 缓存写入：取数和计价两处都要有。
        assert!(
            body.contains("SUM(cache_creation_tokens)::bigint AS cache_write_tokens"),
            "取数里没有缓存写入 —— 最贵的那类 token 在停用判据里贡献 0",
        );
        assert!(
            body.contains("r.cache_write_tokens.max(0) as f64 * cache_write_price"),
            "成本公式里没算缓存写入",
        );
        assert!(
            body.contains(".unwrap_or(r.input_per_mtok * 1.25)"),
            "缓存写入没录价时的兜底倍数不见了 —— 要和 20260864 迁移、reconcile 同源",
        );
        // 形状按天逐行判，不是加总之后夹一刀，也不是 bool_and 整窗塌缩。
        assert!(
            body.contains("COALESCE(prompt_includes_cached, \\\n                                           NOT (cached_tokens > prompt_tokens))"),
            "形状判定没有按行做（或者兜底判据变了）—— 加总后再夹一刀会低估 Anthropic 形状",
        );
        assert!(
            !body.contains("bool_and(prompt_includes_cached)"),
            "照抄了对账那边的 bool_and —— 它刻意朝高估成本偏，挂在自动停用上就是误杀",
        );
        assert!(
            !body.contains("r.cached_tokens.max(0).min(r.prompt_tokens.max(0))"),
            "那个无条件夹刀回来了 —— 它对 Anthropic 形状是低估，正是这条要防的",
        );
        // 减法只该发生一次（在 SQL 里）。Rust 侧再减一次就是把新鲜输入又砍一刀。
        assert!(
            body.contains("let fresh = r.prompt_tokens.max(0) as f64;"),
            "Rust 侧又减了一次缓存 —— SQL 里已经减过，这里再减就是双重扣减",
        );
    }

    /// 抓不到价目的出口，**不许再说「成本只能手工录」**。
    ///
    /// 那句话 2026-08-26 之前是真的，之后不是：对账会按 OpenRouter 官方价 ×
    /// 这个出口的倍率推算（`reconcile::derived_price`），实测覆盖线上全部 10 个
    /// 待录模型。留着旧文案，用户会以为这几个出口的成本是空的，而它们已经有数了。
    ///
    /// **一句过期的待办比没有待办更糟** —— 它会让人去做一件已经不需要做的事，
    /// 而且会让人不信任旁边那些还准的提示。
    #[test]
    fn a_missing_catalog_no_longer_claims_the_cost_must_be_typed_in() {
        let me = src();
        assert!(
            !me.contains("成本要手工录") && !me.contains("成本只能手工录"),
            "还在说「成本只能手工录」—— 抓不到价目的出口现在会按官方价 × 倍率推算，\
             这句话已经是假的",
        );
        // 新文案必须说清楚成本从哪来，否则只是把一句假话换成一句空话。
        assert!(
            me.matches("按 OpenRouter 官方价 × 倍率推算").count() >= 2,
            "两条分支（有价目接口但没拉到 / 根本没有价目接口）都要说明成本怎么来的",
        );
    }

    /// 上游下架的模型，它的价必须删掉 —— 而且只在**这一轮真拉到东西**时才删。
    ///
    /// # 冻结在「免费」是最危险的陈旧
    ///
    /// 不删的话，一条价会以最后一次抓到的数字永远留在库里，不报错、不变红。
    /// 线上实拍（2026-08-26）：`stealth/ox-alpha` 被 OpenRouter 下架，我们那条
    /// `$0` 的价停在 11:50 一动不动，而那条线路 **6924 次调用全跑在这个模型上**。
    /// 成本于是永远算成 0 —— 一个看起来很健康的数字。
    ///
    /// 删掉之后它变成「待录单价」，对账明说算不出成本。**「不知道」比「过期的零」
    /// 有用得多**，这和这个模块里「没录价不按 0 算」是同一条规矩。
    ///
    /// 另一半同样要紧：**空手回来不许清库**。中转抽风回一个空清单时清库，
    /// 会让对账页突然全变未知，而那是我们自己造成的，不是上游下架。
    #[test]
    fn prices_for_delisted_models_are_removed_but_never_on_an_empty_fetch() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        let del = body
            .find("DELETE FROM endpoint_auto_price")
            .expect("下架模型的价不会被清理 —— 它会以最后一次的数字永远留着");
        // 判据是「不在这一轮抓到的名单里」。
        assert!(
            body[del..].contains("model_id <> ALL($2)"),
            "清理的判据不是「这一轮没见到」—— 换个判据很容易把还在的价一起删掉",
        );
        // 清理必须在 `!prices.is_empty()` 那道闸**里面**。
        //
        // 判据是**包含**，不是先后。第一版写的是 `guard < del`（闸的位置在删除之前），
        // 而把删除整段挪到闸的**后面**时那个不等式照样成立 —— 故意改坏跑一遍，
        // 测试绿得毫无察觉。顺序不等于包含，得按花括号把闸的范围切出来。
        let guard = body
            .find("if !prices.is_empty() {")
            .expect("空手回来不清库那道闸没了");
        let open = guard + body[guard..].find('{').unwrap();
        let bytes = body.as_bytes();
        let (mut depth, mut i) = (0i32, open);
        let close = loop {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break i;
                    }
                }
                _ => {}
            }
            i += 1;
        };
        assert!(
            del > open && del < close,
            "清理跑到空清单闸之外了 —— 上游抽风回个空的就会把整张价目表清空",
        );
        // 删不掉要留痕，不能吞。
        assert!(
            body[del..].contains("清理下架模型的价失败"),
            "清理失败被吞了 —— 「价为什么还是老的」就永远查不出来",
        );
    }

    /// 降价和「涨价但重算后没事」在处置上必须是两个值。
    ///
    /// 两者都记 'none' 的话，界面只能给一个统称，于是一行降价会被标成
    /// 「重算后仍在赚钱」—— 而降价根本不触发重算。**一个声称做过、实际没做的
    /// 说明比没有说明更糟**：它会让人以为看守在工作。线上第一轮同步就撞上了
    /// 这个（gpt-5.6 那一批全是降价）。
    #[test]
    fn a_price_drop_is_not_labelled_as_a_passed_margin_check() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        assert!(
            body.contains(r#"if pct < 0.0 { "drop" } else { "none" }"#),
            "降价没有单独的处置值 —— 界面会把它说成「重算后仍在赚钱」",
        );
        let margin = fn_body(&src(), "async fn check_margin_after_change(");
        assert!(
            margin.contains("SET acted = 'profitable'"),
            "重算通过之后没留痕 —— 和「压根没算」在界面上就分不开了",
        );
        // 只改还是 'none' 的那一行，别把 drop / disabled 覆盖掉。
        assert!(
            margin.contains("AND acted = 'none'"),
            "留痕时没限定只改 none 的行 —— 会把别的处置结果覆盖掉",
        );

        // 界面那张表必须两个键都认。
        let ui = include_str!("../admin-ui/src/pages/Adapters.tsx");
        for k in ["drop:", "profitable:", "disabled:", "alarm:"] {
            assert!(ui.contains(k), "处置文案表里缺 {k}");
        }
    }

    /// 查余额**只许有一份实现**。
    ///
    /// 这条守的是一次真实事故：`route_endpoints` 里曾经有自己的 read_balance，
    /// 对 sub2api 打 `/api/v1/auth/me`（要控制台令牌，拿不到）；而 relay_adapter
    /// 那份打 `/v1/usage`（调用密钥就行，拿得到）。于是同一批线路在「网关适配器」
    /// 页有余额、在「健康」页显示「查不到」，两页说的却是同一件事。
    ///
    /// 两份实现里**用得少的那份不会被发现坏了** —— 它只在某个页面上表现为一格空白。
    #[test]
    fn there_is_exactly_one_balance_implementation() {
        let ep = include_str!("route_endpoints.rs");
        let ep_code = ep.split("\n#[cfg(test)]").next().unwrap();
        for banned in ["fn read_balance(", "fn query_balance(", "fn pick_balance("] {
            assert!(
                !ep_code.contains(banned),
                "route_endpoints 里又长出了一份查余额的实现（{banned}）—— \
                 两份必然分叉，而用得少的那份只会表现为某个页面上的一格空白",
            );
        }

        // 三个调用点必须都走同一个入口。
        let me = src();
        assert!(me.contains("pub async fn balance_now("), "统一入口不见了");
        for (file, code) in [
            ("route_endpoints.rs", ep),
            ("reconcile.rs", include_str!("reconcile.rs")),
        ] {
            assert!(
                code.contains("relay_sync::balance_now("),
                "{file} 没走统一入口 —— 它会再长出一份自己的实现",
            );
        }
    }

    /// 家族优先从库里读，不是每次现探。
    ///
    /// 现探不只是慢：两个页面各探一次，探测结果可能不一致，
    /// 于是同一条线路在两个页面上显示成两个家族。
    #[test]
    fn the_family_is_reused_from_storage_not_reprobed_each_time() {
        let body = fn_body(&src(), "pub async fn balance_now(");
        assert!(
            body.contains("SELECT family, quota_per_unit FROM endpoint_adapter"),
            "每次查余额都重新探测 —— 慢，而且两个页面可能探出不同的家族",
        );
        assert!(
            body.contains("_ => relay_adapter::detect(base_url).await"),
            "库里没有记录时没有兜底探测 —— 还没同步过的线路会永远查不到余额",
        );
    }

    /// 「已自动停用」这句话必须来自**执行事实**，不能来自意图。
    ///
    /// 原来这里是 `let _ = sqlx::query("UPDATE models SET active = false ...")`，
    /// 随后**无条件**把 acted 置成 disabled、打日志「已自动停用」、发邮件「已自动停用」。
    /// 写失败的话：线路照常接单、每次调用都在赔钱，而四处证据没有一处来自真实执行。
    ///
    /// 而且没有自愈 —— 新价在毛利重算之前就已经覆盖，下一轮算出的涨幅是 0，
    /// 重算根本不会再被触发。停不掉比停掉更紧急，所以它有自己的处置值和自己的邮件。
    #[test]
    fn a_failed_shutdown_is_never_reported_as_a_successful_one() {
        let body = fn_body(&src(), "async fn check_margin_after_change(");
        assert!(
            !body.contains(r#"let _ = sqlx::query("UPDATE models SET active = false"#),
            "停用又变回丢弃 Result 了 —— 写失败时全链路会说「已停用」而线路还在接单",
        );
        assert!(
            body.contains("r.rows_affected() == 1"),
            "没有按真实影响行数判定 —— 「更新了 0 行」和「停用成功」会同值",
        );
        assert!(
            body.contains("disable_failed"),
            "没有「停用失败」这个处置值 —— 它会被并进 disabled 或 alarm，两种都在说谎",
        );
        // 失败那封邮件必须比成功那封更急，而且要说清楚不会自动重试。
        assert!(
            body.contains("停用没成功") && body.contains("不会自动重试"),
            "停用失败的告警没有说清楚「线路仍在接单」和「不会自己重试」",
        );
        // 界面上的原因也要带上，不能只在日志里。
        assert!(
            body.contains("自动停用没成功，线路仍在接单"),
            "后台那一行不会显示停用失败 —— 页面只渲染 blocked_reason 和处置文案",
        );
    }

    /// 读旧价失败必须整轮放弃，不能当成「没有旧价」。
    ///
    /// 压成空表有两层静默伤害：这一轮所有模型都走 `else { continue }`，一个涨价都
    /// 抓不到；而且紧接着新价**无条件覆盖**，把下一轮的比对基线也毁了 ——
    /// 一次查库抖动能让一次真实涨价永远消失在数据里。
    ///
    /// 「Ok(空)」是合法的（第一次同步），必须和 Err 分开。
    #[test]
    fn a_failed_baseline_read_aborts_the_round_instead_of_pretending_it_is_empty() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        assert!(
            !body.contains("FROM endpoint_auto_price \\\n         WHERE endpoint_id = $1\",\n    )\n    .bind(endpoint_id)\n    .fetch_all(&state.db)\n    .await\n    .unwrap_or_default()"),
            "读旧价又变回 unwrap_or_default 了",
        );
        assert!(
            body.contains("Err(e) => {") && body.contains("读旧价失败，本轮跳过"),
            "查库失败没有整轮跳过 —— 会把比对基线一起覆盖掉",
        );
        // 跳过必须发生在覆盖新价**之前**。
        let at_abort = body.find("读旧价失败，本轮跳过").expect("没有跳过分支");
        let at_write = body.find("INSERT INTO endpoint_auto_price").expect("没有写新价");
        assert!(at_abort < at_write, "跳过发生在覆盖之后 —— 基线照样被毁");
    }

    /// 免费模型不参与看守。
    #[test]
    fn a_zero_revenue_line_is_left_alone() {
        let body = fn_body(&src(), "async fn check_margin_after_change(");
        assert!(
            body.contains("if revenue <= 0.0 {"),
            "实收为 0 时还去算毛利率 —— 除零，而且免费模型该不该花钱不是这个判据能答的",
        );
    }

    /// 读不到看守配置时，默认按「保钱」的方向走。
    ///
    /// 上一版这里默认「关」，理由是读库失败不该变成停服。现在方向反过来了：
    /// 判据已经精确到「真的在亏」，这时候不保护才是伤害。**但下限默认 0** ——
    /// 只在真亏了才动手，薄利不动。
    #[test]
    fn a_failed_config_read_defaults_to_protecting_money() {
        let body = fn_body(&src(), "async fn check_margin_after_change(");
        assert!(
            body.contains(".unwrap_or((true, 0.0))"),
            "读不到看守配置时的默认值变了 —— 这一步决定「读库抖一下」会不会关掉保护",
        );
        let m = include_str!("../migrations/20260860_margin_guard.sql");
        assert!(
            m.contains("ALTER COLUMN auto_guard SET DEFAULT true"),
            "看守没有默认打开",
        );
        assert!(
            m.contains("margin_floor_pct DOUBLE PRECISION NOT NULL DEFAULT 0"),
            "毛利下限默认值不是 0 —— 默认就该是「只在真亏了才动手」",
        );
    }

    /// 空价目不许清库。
    ///
    /// 中转临时抽风回一个空清单是常事。清了的话对账页会突然全变未知，
    /// 而那是我们自己造成的，看起来却像中转出了问题。
    #[test]
    fn an_empty_fetch_never_wipes_the_stored_prices() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        assert!(
            body.contains("if !prices.is_empty() {"),
            "拉到空清单也会去覆盖库 —— 一次上游抽风会把所有价清掉",
        );
    }

    /// 涨幅要按输入输出里更狠的那个算。
    #[test]
    fn the_jump_is_measured_on_whichever_side_rose_more() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        assert!(
            body.contains("pct_of(oi, ni).max(pct_of(oo, no))"),
            "只看了一侧的涨幅 —— 一家把输出价翻倍、输入不动就完全抓不到，而输出是贵的那一半",
        );
        // 除零保护：老价是 0 时算不出百分比。
        assert!(body.contains("if o > 0.0"), "老价为 0 时会算出 inf 涨幅");
    }

    /// 变动必须先记再覆盖。
    #[test]
    fn changes_are_recorded_before_the_overwrite() {
        let body = fn_body(&src(), "async fn sync_endpoint(");
        let read_old = body.find("SELECT model_id, input_per_mtok").expect("没读旧价");
        let write_new = body.find("INSERT INTO endpoint_auto_price").expect("没写新价");
        assert!(read_old < write_new, "先覆盖后比对 —— 那样永远比不出涨没涨");
    }

    /// 整轮同步不能在请求里干等。
    #[test]
    fn a_manual_sync_returns_immediately() {
        let body = fn_body(&src(), "pub async fn admin_sync(");
        assert!(
            body.contains("tokio::spawn"),
            "同步在请求里同步跑 —— 十几个上游几十秒，前端会超时然后用户重复点",
        );
    }

    /// 拉不到价时，**为什么**拉不到必须传到界面上。
    ///
    /// 「密钥被拒(401)」「回了 40 个模型但一个 pricing 字段都没有」「有 pricing 但
    /// 数字对不上每 token 的量级」是三件完全不同的事：第一件去换密钥、第二件去
    /// 手工录、第三件是解析要改。压成一句「只能手工录」就只能瞎试。
    ///
    /// 尤其是 `det.note` 非空那一支 —— 自研网关和被挡住的面板都走它，
    /// 如果它直接当结论返回，原因就永远出不来。
    #[test]
    fn the_reason_pricing_failed_reaches_the_console() {
        let me = include_str!("relay_sync.rs");
        let at = me.find("let ready = !prices.is_empty();").expect("说明那段不见了");
        // 结构边界，不是固定窗口。按 `at + N` 切会两头出事：函数一变长就不再守住尾部
        // （而且照样是绿的），中文源码里还会直接切在汉字中间 panic —— 两样都踩过。
        let end = me[at..].find("\n    let _ = sqlx::query(").expect("说明那段的结尾不见了");
        let seg = &me[at..at + end];
        // 三条分支都要接上原因，一条都不能直接把 det.note 当结论。
        // 四条分支各有各的接法：两条把 det.note 包进 with_why，另两条直接把
        // {price_why} 插进自己的 format!。**四条都要接**，漏一条就有一族出口
        // 永远看不到原因，而且看不出来漏了。
        assert_eq!(
            seg.matches("with_why(det.note.clone())").count(),
            2,
            "有分支把 det.note 直接当结论了 —— 那一支上的出口永远看不到原因",
        );
        // 3 = 两条 format! 分支各一处，加上 with_why 闭包自己拼接那一处。
        assert_eq!(
            seg.matches("{price_why}").count(),
            3,
            "有 format! 分支没把原因插进去",
        );
        // 已经拿到价时不许再拼原因（那时候没有原因可言）。
        assert!(
            seg.contains("if ready || price_why.is_empty() || base.contains(&price_why) {"),
            "拿到价了还在往说明里拼原因",
        );
        // 原因必须真的是从取价那边回来的，不是这边编的。
        assert!(
            me.contains("let (prices, price_why) = relay_adapter::fetch_pricing("),
            "没有从取价那边把原因接出来",
        );
    }
}
