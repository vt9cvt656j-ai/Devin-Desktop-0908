//! 运营参数的唯一真相。
//!
//! 在这个模块之前，三个数字散在四个文件里：`models.rs` 的面值分母 6.63、
//! `models.rs` 的 `FREE_POINTS_DAILY`、`codes.rs` 的 `plan_spec`；面值分母另有三份
//! 前端副本（`Customers.tsx`、`Billing.tsx`、`static/admin.html`）和一份客户端副本
//! （`ide/src/main.js`）。其中三份在写路径上——管理员输入的美元由前端乘 663 变成
//! 存库的真实分，服务端不做二次换算。只把其中一处改成可配置，等于让"发出去多少"
//! 和"显示多少"当场对不上，而且对不上的地方没有任何报错。
//!
//! 所以这里的规则是：数据库是唯一定义，Rust 启动时读一次进内存，写入后失效重载，
//! 所有前端从接口取值。任何一处再出现字面量 663 都是 bug。
//!
//! 为什么用内存缓存而不是每次查库：面值分母被展示路径大量使用，套餐额度在发放路径
//! 上使用，而中转请求本身已经有三次同步数据库往返。多一次 SELECT 不会压垮它，但也
//! 没有必要——这些值一天改不了一次。缓存用的是本仓库既有的写法
//! （`update.rs`、`knowledge.rs`、`agent_trace.rs` 都是 `LazyLock<RwLock<..>>` 静态量）。

use std::sync::{LazyLock, RwLock};

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::AppState;

/// 面值分母的合法区间，与迁移里的 CHECK 一致。下限是 1 而不是 0：这个数在展示路径上
/// 做除数，0 会把每一个余额变成除零。
pub const MIN_RAW_CENTS_PER_CREDIT_USD: i64 = 1;
pub const MAX_RAW_CENTS_PER_CREDIT_USD: i64 = 100_000;
pub const MIN_FREE_POINTS_DAILY: i64 = 0;
pub const MAX_FREE_POINTS_DAILY: i64 = 1_000_000;

/// 兜底值。逐字对应落库前 `models.rs` 里的常量，所以在迁移跑完之前（或数据库暂时读
/// 不到时）读到的行为与改造前完全一致——这次改造本身不改变任何金额。
pub const DEFAULT_RAW_CENTS_PER_CREDIT_USD: i64 = 663;
pub const DEFAULT_FREE_POINTS_DAILY: i64 = 40;
/// 7.10 CNY/USD。只用于把人民币销售折成美元记佣金，不参与任何展示。
pub const DEFAULT_USD_PER_CNY_BPS: i64 = 1408;
pub const MIN_USD_PER_CNY_BPS: i64 = 100;
pub const MAX_USD_PER_CNY_BPS: i64 = 10_000;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Settings {
    pub raw_cents_per_credit_usd: i64,
    pub free_points_daily: i64,
    /// 会员那一档的每日赠送点数。`None` = **没单独配**，跟随 `free_points_daily`。
    ///
    /// 这里是 `Option` 而不是「另给一个默认数」：线上非会员档已经是 100，给会员一个
    /// 独立的默认值（比如 40）等于在迁移那一刻把会员降到 40 —— 没人要求过，也不报错。
    /// `None` 让「没配」逐字等于今天的行为，同时盖住「列还没加 / 这一列读不到」两个窗口。
    /// 解析成实际点数只走 [`free_points_daily_member`] 一个出口，调用处不许各自 unwrap_or。
    pub free_points_daily_member: Option<i64>,
    /// 1 人民币分 折合多少美元分，万分比。佣金账本以美元计量，人民币销售在记账时折一次。
    pub usd_per_cny_bps: i64,
    /// 官方价锚定的窗口天数。`None` = 没配，用默认 30。`Some(0)` = 关掉锚定。
    ///
    /// OpenRouter 的挂牌价会因为活动、促销、某家承载商临时降价而下调，而它是计费的
    /// **兜底价**（每模型没单独配价时就用它）。目录一降，我们对用户的收费当场跟着降，
    /// 而付给上游的钱没降。锚定的做法是取窗口内观测到的最高价：活动期的低价进不了账，
    /// 真正的永久降价在窗口走完之后自动生效，不需要任何人记得去改。
    pub official_price_window_days: Option<i64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            raw_cents_per_credit_usd: DEFAULT_RAW_CENTS_PER_CREDIT_USD,
            free_points_daily: DEFAULT_FREE_POINTS_DAILY,
            // 没有 DEFAULT_..._MEMBER 常量：默认就是「跟随非会员档」，多一个数字常量
            // 只会多一份会和它漂开的真相。
            free_points_daily_member: None,
            usd_per_cny_bps: DEFAULT_USD_PER_CNY_BPS,
            official_price_window_days: None,
        }
    }
}

/// 套餐额度。字段单位与 `users.quota_*_cents` 一致：真实计费分。
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PlanQuota {
    pub plan: String,
    pub total_cents: i64,
    pub window_cents: i64,
    pub weekly_cents: i64,
    pub days: i32,
    pub rank: i32,
}

/// 兜底套餐表，逐字对应改造前的 `plan_spec`。
fn default_plans() -> Vec<PlanQuota> {
    [
        ("trial", 5_000, 5_000, 500, 1, 1),
        ("basic", 33_000, 3_000, 5_000, 30, 2),
        ("pro", 65_000, 6_000, 10_000, 30, 3),
        ("power", 180_000, 15_000, 30_000, 30, 4),
        ("ultra", 500_000, 30_000, 80_000, 30, 5),
    ]
    .into_iter()
    .map(
        |(plan, total_cents, window_cents, weekly_cents, days, rank)| PlanQuota {
            plan: plan.to_string(),
            total_cents,
            window_cents,
            weekly_cents,
            days,
            rank,
        },
    )
    .collect()
}

static CACHE: LazyLock<RwLock<Settings>> = LazyLock::new(|| RwLock::new(Settings::default()));
/// 新装客户端开箱选哪个模型。空串 = 不指定，客户端沿用「取列表第一个」的旧行为。
///
/// 单独放一个静态量而不是塞进 `Settings`：那个结构是 `Copy` 的，加一个 String 会把
/// 它整个降级，而它被逐字段拷贝的地方不少。
static DEFAULT_MODEL: LazyLock<RwLock<String>> = LazyLock::new(|| RwLock::new(String::new()));
static PLANS: LazyLock<RwLock<Vec<PlanQuota>>> = LazyLock::new(|| RwLock::new(default_plans()));

/// 测试专用：换掉套餐缓存的那把串行锁。
///
/// 存在的理由很具体：`plan_quotas` 是运营在后台加套餐的地方，而校验一度查的是代码里
/// 写死的五元组。两者在**默认配置下恰好相等**，所以任何不改这份缓存的测试都无法区分
/// 「按配置校验」和「按硬编码校验」——测试会两种实现都通过，等于没守。
/// 换过 PLANS 的测试和读 PLANS 的测试必须串行。
///
/// PLANS 是**进程级**缓存，而 cargo 默认并行跑测试：一个测试把它换成一组只含
/// "yunying-xinzeng" 的假配置期间，另外几个正在读真配置的测试就会 unwrap 到 None。
/// 症状是这几条时红时绿、每次红的还不一定是同一条——最难查的那种。
/// 中毒了也照用（`into_inner`）：一次 panic 不该让后面每条都变成"锁中毒"。
///
/// 只读用例拿 [`plans_test_guard`]；要换表的用例拿 [`swap_plans_for_test`]，它自己
/// 持有这把锁，别再在外面套一层（std 的 Mutex 不可重入，套了就是死锁）。
#[cfg(test)]
pub static PLANS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub fn plans_test_guard() -> std::sync::MutexGuard<'static, ()> {
    PLANS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 换表期间的持有凭证：旧表和串行锁绑在同一个值的生命周期上，`Drop` 时写回。
///
/// 之前是「换表返回旧表，用例末尾手工写回」——中间任何一条断言一红，写回那行就永远
/// 到不了，假表留给后面所有读 PLANS 的用例，报出来的是三条红、真正的根因淹在后两条
/// 的 unwrap panic 里。绑到 `Drop` 上之后，正常返回和 panic 展开走的是同一条还原路。
///
/// 字段顺序即析构顺序：先在 `drop` 里写回旧表，再释放 `_serial`，还原始终在锁内完成。
#[cfg(test)]
pub struct PlansSwap {
    previous: Option<Vec<PlanQuota>>,
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for PlansSwap {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            // 展开路径上 PLANS 可能已经中毒；还原比保持中毒更重要。
            let mut guard = PLANS.write().unwrap_or_else(|e| e.into_inner());
            *guard = previous;
        }
    }
}

/// 把套餐缓存换成给定的一组，直到返回值离开作用域——失败、panic 也一样还原。
#[cfg(test)]
pub fn swap_plans_for_test(plans: Vec<PlanQuota>) -> PlansSwap {
    let serial = plans_test_guard();
    let previous = {
        let mut guard = PLANS.write().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *guard, plans)
    };
    PlansSwap {
        previous: Some(previous),
        _serial: serial,
    }
}

/// 运营参数缓存的对应物：同一把锁的思路，只是换的是 `CACHE`。
#[cfg(test)]
static SETTINGS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 只读地看 `CACHE` 时拿这把锁，别拿 swap——swap 会先写一次再让你读。
#[cfg(test)]
pub fn settings_test_guard() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
pub struct SettingsSwap {
    previous: Option<Settings>,
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for SettingsSwap {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            let mut guard = CACHE.write().unwrap_or_else(|e| e.into_inner());
            *guard = previous;
        }
    }
}

/// 把运营参数缓存换成给定值，直到返回值离开作用域——失败、panic 也一样还原。
#[cfg(test)]
pub fn swap_settings_for_test(settings: Settings) -> SettingsSwap {
    let serial = settings_test_guard();
    let previous = {
        let mut guard = CACHE.write().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *guard, settings)
    };
    SettingsSwap {
        previous: Some(previous),
        _serial: serial,
    }
}

/// 读缓存。锁中毒时退回默认值而不是 panic——这些是展示与发放参数，让整个网关因为一把
/// 读锁挂掉是更坏的结果。
pub fn current() -> Settings {
    CACHE.read().map(|g| *g).unwrap_or_default()
}

/// 面值分母：多少真实计费分等于客户看到的 $1.00 额度。
pub fn raw_cents_per_credit_usd() -> i64 {
    current()
        .raw_cents_per_credit_usd
        .clamp(MIN_RAW_CENTS_PER_CREDIT_USD, MAX_RAW_CENTS_PER_CREDIT_USD)
}

/// 1 人民币分 折合多少美元分，万分比。夹在合理区间内：这个数是佣金的乘数，
/// 一个离谱的值会静默地把每一笔中国销售的佣金放大或抹平。
pub fn usd_per_cny_bps() -> i64 {
    current()
        .usd_per_cny_bps
        .clamp(MIN_USD_PER_CNY_BPS, MAX_USD_PER_CNY_BPS)
}

/// **美元分 → 用户钱包口径的分。**
///
/// `compute_cost` 全程按**美元**单价算（目录价、每模型覆盖、连接价，单位都是
/// 「美元 / 百万 token」），返回的是美元分。而用户的钱包/额度是人民币口径。
/// 直接拿美元分去减 `credits_cents`，等于按 1 美元 = 1 元扣 —— 实测差 7.1 倍：
/// 一笔算出 $0.039 的调用，只从用户账上扣掉 ¥0.039，而中转按美元实收。
///
/// 汇率取后台设置的 `usd_per_cny_bps`（1 人民币分折合多少美元分，万分比），
/// 不写死：汇率变了改一个数字就行，不用改代码重新发版。
/// **micro-USD → 用户钱包口径的人民币分。** 只取整一次。
///
/// `usd_cents_to_wallet_cents` 收的是**已经取整到整美分**的数，而 `compute_cost` 正是在那一步
/// `(usd * 100 * rate).round()` 把精度扔了：人民币分比美分细 7.1 倍（bps=1408），于是
/// **乘上线路倍率后不到半美分的调用全部被四舍五入成 0 —— 白送，而且没有任何日志**。
/// 生产实测（2026-09-03，24 小时）：
///   deepseek-v4-flash-vision-exp 235 次里 228 次收 0（平均 0.50 美分），1700 万 token
///   claude-sonnet-5 收 0 那组平均 0.43 美分；deepseek-v4-pro 收 0 那组 0.14 美分
///   而同一模型「收到钱」那组平均都在 1.2 美分以上 —— 分界线正好在半美分。
///
/// 换算恒等式：美分 = micro ÷ 10000，人民币分 = 美分 × 10000 ÷ bps，约掉就是 **micro ÷ bps**。
/// （`realtime.rs` 里那句 `cny_cents = micro / bps` 是同一式子的独立印证。）
///
/// **向上取整**：花了真钱就至少收 1 人民币分（¥0.01）。和 `free_points_needed` 的地板同一条
/// 纪律 —— 宁可多收一厘，也不能让一次真实调用变成静默免费。
pub fn usd_micro_to_wallet_cents(usd_micro: i64) -> i64 {
    if usd_micro <= 0 {
        return 0;
    }
    let bps = usd_per_cny_bps();
    if bps <= 0 {
        return usd_micro / 10_000; // 夹过区间了，理论到不了；退回美分口径
    }
    ((usd_micro as i128 + bps as i128 - 1) / bps as i128) as i64
}

pub fn usd_cents_to_wallet_cents(usd_cents: i64) -> i64 {
    let bps = usd_per_cny_bps();
    if bps <= 0 {
        return usd_cents; // 夹过区间了，理论到不了；到了也宁可少收不要乱收
    }
    // 用 i128 中转：usd_cents 最大到成本上限 5000，乘 10000 不会溢出，但写死安全边界。
    ((usd_cents as i128 * 10_000) / bps as i128) as i64
}

/// **用户钱包口径的分 → 美元分。** [`usd_cents_to_wallet_cents`] 的逆。
///
/// 只有一个用途，但那个用途是钱：结算入队的快照存的是**折算前的美元分**（重放时
/// 会再折一次），而免费池部分覆盖时，池子已经付掉的那一份是**人民币分**。要把它从
/// 快照里减掉，就得先折回美元分——两边同口径才能相减。
///
/// 不这么做的后果是一个双扣：池子出了一部分、随后事务开启或认领失败 → 整笔按**原始
/// 全额**入队 → 恢复重跑时 `from_recovery=true` 跳过免费分支 → 池子付过的那一份被向
/// 钱包再收一次，而扣掉的点数不回滚。
pub fn wallet_cents_to_usd_cents(wallet_cents: i64) -> i64 {
    let bps = usd_per_cny_bps();
    if bps <= 0 {
        return wallet_cents;
    }
    // 正向是 usd * 10000 / bps，逆向就是 wallet * bps / 10000。
    ((wallet_cents as i128 * bps as i128) / 10_000) as i64
}

/// **一个钱包分值多少美元。** [`wallet_cents_to_usd_cents`] 的浮点形式，同一个 bps。
///
/// 为什么要有它：损益那几处（`plan_health`、定价试算）算的是比值和毛利率，整数版本
/// 会在小额上截断——一个 39780 分的套餐折过去还剩 5600 美分是够用的，但一条只跑了
/// 几十分的线路折完就是 0，于是那条线路的成本凭空消失、毛利显示 100%。
///
/// **口径必须和整数版一模一样**：`wallet_cents_to_usd_cents` 是 `wallet × bps / 10000`
/// （得美元分），再 ÷100 得美元，约掉就是 `wallet × bps / 1e6`。两处各写一遍的话，
/// 「扣钱按哪把尺子」和「报表按哪把尺子」会不声不响地分家，而那正是 2026-08-28
/// 之后 plan_health 一直在犯的错。
pub fn usd_per_wallet_cent() -> f64 {
    let bps = usd_per_cny_bps();
    if bps <= 0 {
        // 夹过区间了，理论到不了。退回「1 钱包分 = 1 美分」，也就是 08-28 之前的口径。
        return 0.01;
    }
    bps as f64 / 1_000_000.0
}

/// 官方价锚定的窗口天数。默认 30，`0` = 关掉锚定（直接用当天目录价）。
///
/// 30 天是这么定的：比任何一次常见促销都长，而比「厂商真降价了」的容忍期短。
/// 想跟着活动价走就填 0，那时行为逐字回到加这个功能之前。
pub fn official_price_window_days() -> i64 {
    current().official_price_window_days.unwrap_or(30).clamp(0, 365)
}

/// **一个「面值美元」实际值多少美元。** 所有利润测算的换算锚点。
///
/// 原来写的是 `raw_cents_per_credit_usd() / 100.0`（= 6.63），那在 2026-08-28 之前是对的：
/// 那时用户被扣的「真实计费分」就是美元分，663 分自然等于 $6.63。
///
/// c387e33 之后扣的是**人民币分**（`usd_micro_to_wallet_cents`），663 分变成 ¥6.63，
/// 而这个函数仍然按美元下发给三处利润测算（`project_quota_package` 的 `quota_raw_usd`
/// 与 `safe_visible_quota_usd`、`admin_model_estimate` 的 `visible_quota_usd`）——
/// 供应商容量因此被高估 7.1 倍，反推出来的「安全额度」也跟着虚高。四个读者都在这一个
/// 函数下面，所以**改这一处就够了**，不要去各个调用点各修一遍（那必然漂开）。
///
/// 现在的口径：面值 $1 = `raw_cents_per_credit_usd` 个钱包分，每个钱包分值
/// `usd_per_wallet_cent()` 美元。汇率 1408 时 = 663 × 0.001408 ≈ $0.933。
pub fn raw_usd_per_visible_usd() -> f64 {
    raw_cents_per_credit_usd() as f64 * usd_per_wallet_cent()
}

/// 每日赠送点数（整点）。
pub fn free_points_daily() -> i64 {
    current()
        .free_points_daily
        .clamp(MIN_FREE_POINTS_DAILY, MAX_FREE_POINTS_DAILY)
}

/// 每日赠送的毫点。池子按毫点存储，见 `models.rs::MILLI` 的说明。
pub fn free_milli_points_daily() -> i64 {
    free_points_daily() * crate::models::MILLI
}

/// 会员档配了没有，以及配的是多少（整点）。`None` = 没单独配。
///
/// 只有后台展示需要区分「没配」和「配了个恰好相等的数」；发放和展示分母一律走
/// [`free_points_daily_member`]。
pub fn free_points_daily_member_raw() -> Option<i64> {
    current()
        .free_points_daily_member
        .map(|v| v.clamp(MIN_FREE_POINTS_DAILY, MAX_FREE_POINTS_DAILY))
}

/// 会员今天实际拿多少点（整点）。**没单独配就等于非会员档** —— 「新设置项缺省时行为
/// 一个字不变」这条铁律就落在这一行，别在调用处各自 `unwrap_or`，那是让它分叉的写法。
pub fn free_points_daily_member() -> i64 {
    free_points_daily_member_raw().unwrap_or_else(free_points_daily)
}

/// 会员那一档的每日赠送毫点。没配时逐字等于 [`free_milli_points_daily`]。
pub fn free_milli_points_daily_member() -> i64 {
    free_points_daily_member() * crate::models::MILLI
}

pub fn plans() -> Vec<PlanQuota> {
    PLANS
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| default_plans())
}

/// 与改造前的 `codes::plan_spec` 同签名同语义：(总额度, 时段上限, 周上限, 天数)。
pub fn plan_spec(plan: &str) -> Option<(i64, i64, i64, i32)> {
    plans()
        .into_iter()
        .find(|p| p.plan == plan)
        .map(|p| (p.total_cents, p.window_cents, p.weekly_cents, p.days))
}

/// 套餐高低次序，未知套餐为 0。
pub fn plan_rank(plan: &str) -> i32 {
    plans()
        .into_iter()
        .find(|p| p.plan == plan)
        .map(|p| p.rank)
        .unwrap_or(0)
}

/// 从数据库装载进缓存。启动时调用一次，每次写入后再调用一次。
/// 读不到就保留当前缓存（首次即默认值），不让网关起不来。
/// 运维指定的开箱默认模型。空串表示没指定 —— 客户端沿用「取列表第一个」的旧行为。
pub fn default_model() -> String {
    DEFAULT_MODEL
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

pub async fn load(db: &sqlx::PgPool) {
    match sqlx::query_as::<_, (String,)>("SELECT default_model FROM app_settings WHERE id = 1")
        .fetch_optional(db)
        .await
    {
        Ok(Some((model,))) => {
            if let Ok(mut g) = DEFAULT_MODEL.write() {
                *g = model.trim().to_owned();
            }
        }
        Ok(None) => {}
        // 这一列是后加的：老库还没跑迁移时读它会报错，那就沿用空串（＝旧行为），
        // 不能让整个设置加载因此中断。
        Err(e) => tracing::warn!("default_model 读取失败，沿用「取列表第一个」的旧行为: {e}"),
    }

    // 会员那一档是后加的列，所以**单独一条 SELECT**，理由和 default_model 一模一样：
    // 并进下面那条 3 列 SELECT 的话，老库（还没跑 20260869）读它会让整条 SELECT 报错，
    // 于是**非会员档也**一起退回默认 40 —— 线上是 100，那是一次全员静默降级。
    //
    // 读进局部变量、由下面那一次写锁**一起**落进 CACHE，而不是读完先写一次：
    // load() 不只在启动时跑，admin_put 每次保存末尾都会再跑一次，那时网关正在对外服务。
    // 若先把这一格清成 None 再回填，中间隔着一次数据库往返；任何会员的当日首次调用落进
    // 这个窗口就按普通档发放，而懒发放当天只写一次 —— 他这一整天都停在普通档，不报错。
    let member_daily: Option<i64> = match sqlx::query_as::<_, (Option<i32>,)>(
        "SELECT free_points_daily_member FROM app_settings WHERE id = 1",
    )
    .fetch_optional(db)
    .await
    {
        Ok(Some((v,))) => v.map(|n| (n as i64).clamp(MIN_FREE_POINTS_DAILY, MAX_FREE_POINTS_DAILY)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("free_points_daily_member 读取失败，会员档跟随普通档: {e}");
            None
        }
    };

    // 和上面那一格同样的理由，单独读：这一列是后加的，老库还没跑迁移时并进下面那条
    // SELECT 会让**整条**报错，于是汇率和赠送额度一起退回默认值。
    let price_window: Option<i64> = match sqlx::query_as::<_, (Option<i32>,)>(
        "SELECT official_price_window_days FROM app_settings WHERE id = 1",
    )
    .fetch_optional(db)
    .await
    {
        Ok(Some((v,))) => v.map(|n| (n as i64).clamp(0, 365)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("official_price_window_days 读取失败，用默认窗口: {e}");
            None
        }
    };

    match sqlx::query_as::<_, (i32, i32, i32)>(
        "SELECT raw_cents_per_credit_usd, free_points_daily, usd_per_cny_bps \
         FROM app_settings WHERE id = 1",
    )
    .fetch_optional(db)
    .await
    {
        Ok(Some((raw, free, fx))) => {
            let next = Settings {
                raw_cents_per_credit_usd: (raw as i64)
                    .clamp(MIN_RAW_CENTS_PER_CREDIT_USD, MAX_RAW_CENTS_PER_CREDIT_USD),
                free_points_daily: (free as i64)
                    .clamp(MIN_FREE_POINTS_DAILY, MAX_FREE_POINTS_DAILY),
                free_points_daily_member: member_daily,
                usd_per_cny_bps: (fx as i64).clamp(MIN_USD_PER_CNY_BPS, MAX_USD_PER_CNY_BPS),
                official_price_window_days: price_window,
                };
            if let Ok(mut g) = CACHE.write() {
                *g = next;
            }
        }
        Ok(None) => tracing::warn!("app_settings 无数据行，沿用默认值"),
        Err(e) => tracing::warn!("app_settings 读取失败，沿用当前值: {e}"),
    }

    match sqlx::query_as::<_, PlanQuota>(
        "SELECT plan, total_cents, window_cents, weekly_cents, days, rank \
         FROM plan_quotas ORDER BY rank",
    )
    .fetch_all(db)
    .await
    {
        Ok(rows) if !rows.is_empty() => {
            if let Ok(mut g) = PLANS.write() {
                *g = rows;
            }
        }
        Ok(_) => tracing::warn!("plan_quotas 为空，沿用默认套餐"),
        Err(e) => tracing::warn!("plan_quotas 读取失败，沿用当前值: {e}"),
    }
}

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

/// 套餐列表，外加一个 `is_default`：这一行是否还等于代码里的出厂值。
///
/// 加这个字段是因为一次真实的误会：设置页把种子值填进可编辑输入框里，看上去就像是
/// 运营自己配过的数字，于是「我从没设过这么高的值」变成了一句无法自证的话。标出哪些
/// 行没人动过，这个问题就不会再出现。
fn plans_json() -> Vec<serde_json::Value> {
    let defaults = default_plans();
    plans()
        .into_iter()
        .map(|p| {
            let is_default = defaults.iter().any(|d| {
                d.plan == p.plan
                    && d.total_cents == p.total_cents
                    && d.window_cents == p.window_cents
                    && d.weekly_cents == p.weekly_cents
                    && d.days == p.days
            });
            json!({
                "plan": p.plan,
                "total_cents": p.total_cents,
                "window_cents": p.window_cents,
                "weekly_cents": p.weekly_cents,
                "days": p.days,
                "rank": p.rank,
                "is_default": is_default,
            })
        })
        .collect()
}

pub async fn admin_get(claims: Claims) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let s = current();
    Ok(Json(json!({
        "raw_cents_per_credit_usd": s.raw_cents_per_credit_usd,
        "free_points_daily": s.free_points_daily,
        "plans": plans_json(),
        "limits": {
            "raw_cents_per_credit_usd": [MIN_RAW_CENTS_PER_CREDIT_USD, MAX_RAW_CENTS_PER_CREDIT_USD],
            "free_points_daily": [MIN_FREE_POINTS_DAILY, MAX_FREE_POINTS_DAILY],
        },
        // 只读：由**后台设定**推导，不是编译期常量。100 积分 = ¥1，所以 1 点 = 1 人民币分，
        // 折成真实计费分要过 usd_per_cny_bps —— 改那一格，这个数自动跟上。
        "raw_cents_per_point": crate::models::raw_cents_per_point(),
        "micro_usd_per_point": crate::models::micro_usd_per_point(),
        "cny_cents_per_point": crate::models::CNY_CENTS_PER_POINT,
    })))
}

#[derive(Debug, Deserialize)]
pub struct PlanPatch {
    pub plan: String,
    pub total_cents: i64,
    pub window_cents: i64,
    pub weekly_cents: i64,
    pub days: i32,
}

#[derive(Debug, Deserialize)]
pub struct SettingsPatch {
    pub raw_cents_per_credit_usd: Option<i64>,
    pub free_points_daily: Option<i64>,
    /// 会员那一档每天赠送多少点。不传 = 这一项不改。
    pub free_points_daily_member: Option<i64>,
    /// true = **清掉**会员档，回到「跟随普通用户」。
    ///
    /// 为什么要这个额外的布尔：「没传这一项」和「传了个清除」在 JSON 和 SQL 里都是
    /// null，而两者意思相反。裸的 `Option<Option<i64>>` 解不出这个区别（本仓库没有
    /// serde_with，显式 null 会被解成 `None`，和「没传」撞车）。
    #[serde(default)]
    pub free_points_daily_member_clear: bool,
    /// 新装客户端开箱选哪个模型。空串 = 不指定（客户端沿用「取列表第一个」）。
    pub default_model: Option<String>,
    pub plans: Option<Vec<PlanPatch>>,
}

pub async fn admin_put(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<SettingsPatch>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;

    // 先把范围校验做在这里，让管理员看到中文原因，而不是数据库 CHECK 冒出来的 500。
    if let Some(v) = req.raw_cents_per_credit_usd {
        if !(MIN_RAW_CENTS_PER_CREDIT_USD..=MAX_RAW_CENTS_PER_CREDIT_USD).contains(&v) {
            return Err(AppError::bad(format!(
                "面值分母需在 {MIN_RAW_CENTS_PER_CREDIT_USD}~{MAX_RAW_CENTS_PER_CREDIT_USD} 之间"
            )));
        }
    }
    if let Some(v) = req.free_points_daily {
        if !(MIN_FREE_POINTS_DAILY..=MAX_FREE_POINTS_DAILY).contains(&v) {
            return Err(AppError::bad(format!(
                "每日赠送需在 {MIN_FREE_POINTS_DAILY}~{MAX_FREE_POINTS_DAILY} 之间"
            )));
        }
    }
    if let Some(v) = req.free_points_daily_member {
        if !(MIN_FREE_POINTS_DAILY..=MAX_FREE_POINTS_DAILY).contains(&v) {
            return Err(AppError::bad(format!(
                "会员每日赠送需在 {MIN_FREE_POINTS_DAILY}~{MAX_FREE_POINTS_DAILY} 之间"
            )));
        }
    }
    // 同时「清除」和「设成某个值」是自相矛盾的。默默让其中一个赢，就是让后台上看到的
    // 和库里存的对不上。
    if req.free_points_daily_member_clear && req.free_points_daily_member.is_some() {
        return Err(AppError::bad("会员档不能同时「清除」和「设为某个值」，二选一"));
    }
    // 故意**不**校验「会员档必须 >= 普通档」：运营可能就是想「普通 0、会员 300」，
    // 也可能反过来拿免费额度当拉新钩子（会员本来就有套餐额度）。那是产品决定，不是错误。
    if let Some(v) = &req.default_model {
        let v = v.trim();
        // 模型 id 的字符集就这些（目录里 52 个用过的名字全部符合）。收紧不是为了防注入
        // （参数是绑定的），是为了让填错的人当场看到原因，而不是等到某个新用户开箱时
        // 客户端匹配不上、静默退回字母序第一个。
        if !v.is_empty()
            && (v.len() > 64
                || !v
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/')))
        {
            return Err(AppError::bad(
                "默认模型只能填模型 id（字母数字和 . - _ : /），留空表示不指定",
            ));
        }
    }
    if let Some(list) = &req.plans {
        for p in list {
            if p.total_cents < 0 || p.weekly_cents < 0 {
                return Err(AppError::bad(format!("{}：额度不能为负", p.plan)));
            }
            // 0 时段上限不是"不限"，是把套餐锁死——quota_ok 要求 q_window > 0。
            if p.window_cents <= 0 {
                return Err(AppError::bad(format!(
                    "{}：时段上限必须大于 0，填 0 会让这个套餐永远刷不出额度",
                    p.plan
                )));
            }
            if p.days <= 0 {
                return Err(AppError::bad(format!("{}：有效天数必须大于 0", p.plan)));
            }
        }
    }

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| AppError::internal(format!("开启事务失败: {e}")))?;

    if req.raw_cents_per_credit_usd.is_some()
        || req.free_points_daily.is_some()
        || req.default_model.is_some()
        // 新增的两条必须在这里。前端按「只提交改过的那一档」发请求，「只改会员档」是
        // 运营最常见的动作，body 里只有新字段；漏这两行 = UPDATE 整条不执行、接口返回
        // 200、后台绿横幅照出，而库里一个字没写。
        || req.free_points_daily_member.is_some()
        || req.free_points_daily_member_clear
    {
        sqlx::query(
            "UPDATE app_settings SET \
               raw_cents_per_credit_usd = COALESCE($1, raw_cents_per_credit_usd), \
               free_points_daily = COALESCE($2, free_points_daily), \
               default_model = COALESCE($4, default_model), \
               free_points_daily_member = CASE WHEN $5 THEN NULL \
                                               ELSE COALESCE($6, free_points_daily_member) END, \
               updated_at = now(), updated_by = $3 \
             WHERE id = 1",
        )
        .bind(req.raw_cents_per_credit_usd.map(|v| v as i32))
        .bind(req.free_points_daily.map(|v| v as i32))
        .bind(&claims.sub)
        .bind(req.default_model.as_ref().map(|v| v.trim().to_owned()))
        // $5 清除标志、$6 新值。三态：清除 → NULL（跟随普通档）；给了值 → 用它；
        // 都没有 → COALESCE 保持原样。
        .bind(req.free_points_daily_member_clear)
        .bind(req.free_points_daily_member.map(|v| v as i32))
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::internal(format!("写入设置失败: {e}")))?;
    }

    if let Some(list) = &req.plans {
        for p in list {
            // 只更新既有套餐，不新增：套餐名散在兑换码、订单、compression 分级里，
            // 从这一屏凭空造一个新名字出来只会得到一个没人认识的套餐。
            sqlx::query(
                "UPDATE plan_quotas SET total_cents = $2, window_cents = $3, \
                   weekly_cents = $4, days = $5, updated_at = now() WHERE plan = $1",
            )
            .bind(&p.plan)
            .bind(p.total_cents)
            .bind(p.window_cents)
            .bind(p.weekly_cents)
            .bind(p.days)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::internal(format!("写入套餐 {} 失败: {e}", p.plan)))?;
        }
    }

    tx.commit()
        .await
        .map_err(|e| AppError::internal(format!("提交失败: {e}")))?;

    load(&state.db).await;

    let s = current();
    tracing::info!(
        admin = %claims.sub,
        raw_cents_per_credit_usd = s.raw_cents_per_credit_usd,
        free_points_daily = s.free_points_daily,
        "运营参数已更新"
    );

    Ok(Json(json!({
        "ok": true,
        "raw_cents_per_credit_usd": s.raw_cents_per_credit_usd,
        "free_points_daily": s.free_points_daily,
        "plans": plans_json(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 兜底值必须逐字等于改造前 models.rs / codes.rs 里的常量，否则"迁移前后行为不变"
    /// 这句话就是假的。
    ///
    /// weekly_cents 是迁移之后才加的周上限，不在"行为不变"这句话的范围里，所以它钉的是
    /// 这一列自己该有的值。这个测试之前一直红着：周上限上线时没有人回来改这里，于是
    /// 它从"迁移守卫"变成了"套餐表被人动过就报错"的噪音——两个失败的测试摆在那里，
    /// 只会教人把整个套件的红色当背景。走库里的 plans 表时这些值用不上；它们是查库
    /// 失败时的兜底，所以必须是真能收费的数字，不能是 0。
    #[test]
    fn defaults_match_the_constants_they_replaced() {
        assert_eq!(DEFAULT_RAW_CENTS_PER_CREDIT_USD, 663);
        assert_eq!(DEFAULT_FREE_POINTS_DAILY, 40);
        assert_eq!(
            default_plans()
                .into_iter()
                .map(|p| (p.plan, p.total_cents, p.window_cents, p.weekly_cents, p.days))
                .collect::<Vec<_>>(),
            vec![
                ("trial".to_string(), 5_000, 5_000, 500, 1),
                ("basic".to_string(), 33_000, 3_000, 5_000, 30),
                ("pro".to_string(), 65_000, 6_000, 10_000, 30),
                ("power".to_string(), 180_000, 15_000, 30_000, 30),
                ("ultra".to_string(), 500_000, 30_000, 80_000, 30),
            ]
        );
    }

    /// 每一个兜底套餐的时段上限都必须 > 0。0 会让 quota_ok 永远为假，用户被锁在一个
    /// 刷不出额度的提示里——这是 plan_spec 原注释专门警告过的事。
    #[test]
    fn default_plan_window_caps_are_never_zero() {
        for p in default_plans() {
            assert!(p.window_cents > 0, "{} 的时段上限为 0", p.plan);
        }
    }

    /// 面值分母永远不会返回 0，即使缓存被写进了非法值——它在展示路径上是除数。
    #[test]
    fn denominator_is_never_zero() {
        let _swap = swap_settings_for_test(Settings {
            raw_cents_per_credit_usd: 0,
            ..Settings::default()
        });
        assert!(raw_cents_per_credit_usd() >= MIN_RAW_CENTS_PER_CREDIT_USD);
        assert!(raw_usd_per_visible_usd() > 0.0);
    }

    fn plan_rows(plans: &[PlanQuota]) -> Vec<(String, i64, i64, i64, i32, i32)> {
        plans
            .iter()
            .map(|p| {
                (
                    p.plan.clone(),
                    p.total_cents,
                    p.window_cents,
                    p.weekly_cents,
                    p.days,
                    p.rank,
                )
            })
            .collect()
    }

    /// 换表用例中途 panic，PLANS 也必须回到换表前的样子。
    ///
    /// 这正是 RAII 要守的那条路：手工「末尾写回」在断言一红时永远到不了，假表会留给
    /// 后面所有读 PLANS 的用例。这里故意在换表后 panic，展开完再看缓存。
    #[test]
    fn swap_plans_restores_even_when_the_body_panics() {
        let before = {
            let _g = plans_test_guard();
            plan_rows(&plans())
        };
        assert!(
            plan_spec("trial").is_some(),
            "前置：换表前 trial 必须在表里，否则这条验不出东西"
        );

        let fake = PlanQuota {
            plan: "panic-only".to_string(),
            total_cents: 1,
            window_cents: 1,
            weekly_cents: 0,
            days: 1,
            rank: 1,
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _swap = swap_plans_for_test(vec![fake]);
            // 换表确实生效——不然「还原」无从谈起。
            assert!(plan_spec("trial").is_none(), "换表没生效");
            assert!(plan_spec("panic-only").is_some(), "换表没生效");
            panic!("故意：模拟用例中途断言失败");
        }));
        assert!(outcome.is_err(), "闭包本该 panic");

        let _g = plans_test_guard();
        assert_eq!(
            plan_rows(&plans()),
            before,
            "panic 展开后 PLANS 没有还原：假表会漏给后面所有读 PLANS 的用例"
        );
        assert!(plan_spec("panic-only").is_none());
        assert!(plan_spec("trial").is_some());
    }

    /// 运营参数缓存同理：中途 panic 也要把 CACHE 还原。
    #[test]
    fn swap_settings_restores_even_when_the_body_panics() {
        let before = {
            let _g = settings_test_guard();
            current()
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _swap = swap_settings_for_test(Settings {
                raw_cents_per_credit_usd: MAX_RAW_CENTS_PER_CREDIT_USD,
                free_points_daily: MAX_FREE_POINTS_DAILY,
                // 会员档：测试里显式给 None = 「跟随普通档」，也就是今天的行为。
                free_points_daily_member: None,
                usd_per_cny_bps: MAX_USD_PER_CNY_BPS,
                // 官方价窗口：None = 用默认 30 天，也就是加这个功能之后的常规行为。
                official_price_window_days: None,
            });
            assert_eq!(
                current().raw_cents_per_credit_usd,
                MAX_RAW_CENTS_PER_CREDIT_USD
            );
            panic!("故意：模拟用例中途断言失败");
        }));
        assert!(outcome.is_err(), "闭包本该 panic");

        let _g = settings_test_guard();
        let after = current();
        assert_eq!(
            after.raw_cents_per_credit_usd,
            before.raw_cents_per_credit_usd
        );
        assert_eq!(after.free_points_daily, before.free_points_daily);
        assert_eq!(after.usd_per_cny_bps, before.usd_per_cny_bps);
    }

    /// 面值分母只能有一个真相。
    ///
    /// 这个数曾经在四个文件里各有一份副本，其中三份在写路径上——管理员输入的美元乘以
    /// 它变成存库的真实分，服务端不做二次换算。任何一份重新变回硬编码，"发出去多少额度"
    /// 就会和"显示多少"对不上，而且不会有任何报错，只能靠对账发现。
    ///
    /// 所以这里逐个文件检查两件事：拿到了服务端下发的值，且没有自己声明一份常量。
    #[test]
    fn the_credit_denominator_has_exactly_one_source() {
        // 第四份副本原本在 static/admin.html 里。那个旧后台已经整个删掉了 —— 它是第二套
        // 能改余额的界面，对匿名访客公开，而且面值分母在里面又是一份独立硬编码。删掉比
        // 接上服务端更彻底，所以这里连带钉死"它不能回来"。
        assert!(
            !std::path::Path::new("static/admin.html").exists(),
            "旧管理后台 static/admin.html 又出现了：它是第二套能改余额的界面，\
             面值分母在里面是独立的一份，留着就迟早和服务端对不上"
        );

        // (文件, 必须存在的"从服务端取值"的写法)
        let wired = [
            ("admin-ui/src/lib/settings.ts", "raw_cents_per_credit_usd"),
            ("admin-ui/src/pages/Customers.tsx", "creditCentsFromRaw"),
            ("admin-ui/src/pages/Billing.tsx", "creditCentsFromRaw"),
            ("../ide/src/main.js", "_setCreditDenominator(_michaelUser"),
        ];
        for (path, needle) in wired {
            let src = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("读不到 {path}: {e}"));
            assert!(
                src.contains(needle),
                "{path} 不再从服务端取面值分母（缺少 `{needle}`）"
            );
        }

        // 只有明确标注为兜底的那一行可以出现字面量；其余一律不许再声明常量。
        // 这些文件里连兜底都不该有——它们全部经由 lib/settings.ts 取值。
        for path in [
            "admin-ui/src/pages/Customers.tsx",
            "admin-ui/src/pages/Billing.tsx",
        ] {
            let src = std::fs::read_to_string(path).unwrap();
            for (i, line) in src.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                assert!(
                    !code.contains("= 663"),
                    "{path}:{} 又硬编码了一份面值分母：{}",
                    i + 1,
                    line.trim()
                );
            }
        }
    }

    /// 未知套餐既没有额度也没有等级，和改造前一致。
    #[test]
    fn unknown_plan_has_no_spec_and_rank_zero() {
        let _g = super::plans_test_guard();
        assert!(plan_spec("no-such-plan").is_none());
        assert_eq!(plan_rank("no-such-plan"), 0);
        assert_eq!(plan_rank("basic"), 2);
        // 第三位是周上限，0 表示不限；basic 是 5_000。codes.rs 的 0 == 不限那条规则，
        // 意味着把它写回 0 不会让测试失败，只会悄悄给所有 basic 用户解除周上限。
        assert_eq!(plan_spec("basic"), Some((33_000, 3_000, 5_000, 30)));
    }

    /// 会员档**没配**时必须逐字等于普通档。
    ///
    /// 这是「新设置项缺省时行为一个字不变」那条铁律的落点。写成一个独立的默认数字
    /// （比如 40）就会在迁移跑完的那一刻，把线上已经是 100 的会员降到 40 —— 没人
    /// 「保存了但一个字没写」——写入条件漏掉新字段的经典症状。
    ///
    /// `admin_put` 只有在「至少一个字段被传了」时才执行那条 UPDATE。前端按
    /// 「只提交改过的那一档」发请求，而**只改会员档**是运营最常见的动作 ——
    /// body 里只有会员那两个键。写入条件漏掉它们的后果不是报错：
    /// UPDATE 整条不执行、接口返回 200、后台绿横幅照出，而库里一个字没写。
    ///
    /// 判据从源文本取，因为这是个纯粹的「有没有写进去」问题，跑不出来。
    /// 用 `include_str!` 而不是运行时读文件：这条断言的目标就在本文件里，
    /// 编译期嵌入和它是同一份字节。
    #[test]
    fn the_save_gate_covers_the_member_tier() {
        let src = include_str!("settings.rs");
        let cut = src.find("\nmod tests").unwrap_or(src.len());
        let code = &src[..cut];
        let at = code
            .find("if req.raw_cents_per_credit_usd.is_some()")
            .expect("找不到写入条件 —— 判据失效了");
        let gate = &code[at..at + 600.min(code.len() - at)];
        assert!(
            gate.contains("req.free_points_daily_member.is_some()"),
            "写入条件漏了会员档：只改会员档时 UPDATE 不会执行，而接口照样返回 200",
        );
        assert!(
            gate.contains("req.free_points_daily_member_clear"),
            "写入条件漏了「清除」标志：把会员档改回「跟随」会静默失败",
        );
        // 反恒真：切片真的切到那段条件了，不是空串。
        assert!(gate.len() > 200, "切出来只有 {} 字节，锚点漂了", gate.len());
    }
    /// 要求过，也不报错。同一个不变量还盖住「列还没加 / 这一列读不到」两个窗口。
    #[test]
    fn an_unset_member_tier_follows_the_ordinary_one() {
        assert!(
            Settings::default().free_points_daily_member.is_none(),
            "会员档有了独立默认值 —— 迁移那一刻会静默改变会员拿到的额度",
        );
        let _swap = swap_settings_for_test(Settings {
            free_points_daily: 100,
            free_points_daily_member: None,
            ..Settings::default()
        });
        assert_eq!(free_points_daily(), 100);
        assert_eq!(free_points_daily_member(), 100, "没配就该跟随普通档");
        assert_eq!(free_milli_points_daily_member(), free_milli_points_daily());
        assert!(free_points_daily_member_raw().is_none(), "「没配」这件事本身要留得住");
    }

    /// 把普通档改成 0（＝关掉免费额度）**不会**把会员那档一起带走。
    ///
    /// 这正是会员档做成绝对值而不是倍数的理由：倍数下 `0 × K = 0`，运营一关免费额度
    /// 就把会员福利也静默关掉，而后台上会员那格还写着「×3」，看不出来。
    #[test]
    fn turning_the_ordinary_tier_off_does_not_take_the_member_tier_with_it() {
        let _swap = swap_settings_for_test(Settings {
            free_points_daily: 0,
            free_points_daily_member: Some(300),
            ..Settings::default()
        });
        assert_eq!(free_points_daily(), 0);
        assert_eq!(free_points_daily_member(), 300);
        assert_eq!(free_milli_points_daily(), 0);
        assert_eq!(free_milli_points_daily_member(), 300 * crate::models::MILLI);
    }

}


#[cfg(test)]
mod console_reads_the_server_tests {
    /// 控制台不许自己写一份套餐清单。
    ///
    /// 运营能在后台新建套餐 —— 线上 `plan_quotas` 现在有 6 个（trial/basic/pro/power/ultra/ceshi），
    /// 而三个页面里各自写死的那份数组只有 5 个，漏的正是运营自己建的那个。
    /// 症状不是报错，是**下拉框里没有那一档**：邮件群发筛不到那批用户、客户页筛选看不到、
    /// 收款页发不出那一档的兑换码。运营会以为「这个套餐坏了」。
    ///
    /// 服务端一直在 `plans_json()` 里下发这份清单，前端只是没用。
    #[test]
    fn no_page_writes_its_own_plan_list() {
        for (name, src) in [
            ("客户", include_str!("../admin-ui/src/pages/Customers.tsx")),
            ("邮件", include_str!("../admin-ui/src/pages/Mail.tsx")),
            ("收款", include_str!("../admin-ui/src/pages/Billing.tsx")),
        ] {
            let code: String = src
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
                })
                .collect::<Vec<_>>()
                .join("\n");
            // 写死清单的形状：把两个以上的等级 key 并排写在一处。
            let hardcoded = code.contains("\"trial\"") && code.contains("\"ultra\"");
            assert!(
                !hardcoded,
                "{name}页又把套餐清单写死了 —— 运营新建的套餐会从下拉框里消失",
            );
            assert!(
                code.contains("planKeys"),
                "{name}页没有从服务端取套餐清单",
            );
        }
    }

    /// 控制台不许自己抄服务端的枚举值、阈值和窗口。
    ///
    /// 这一类漂移的共同点是**不报错**：服务端把 `official_catalog` 改成 `catalog`，
    /// 页面就把英文原词显示出来；窗口从 7 天改成 14 天，页面继续宣称是 7 天。
    /// 两边都不会红，只有看的人被误导。
    #[test]
    fn the_console_never_copies_a_server_enum_or_window() {
        // 价格来源：服务端 effective_token_prices 回这三个值。
        let models = include_str!("models.rs");
        for key in ["\"model_override\"", "\"catalog\"", "\"backend\""] {
            assert!(models.contains(key), "服务端的价格来源枚举变了：{key}");
        }
        // 剥注释：解释这次修复的那段注释里就写着旧枚举名，不剥的话这条断言永远红
        // （变异测试之前，我自己先被它绊了一次）。
        let strip = |src: &str| -> String {
            src.lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let pricing = strip(include_str!("../admin-ui/src/pages/Pricing.tsx"));
        let pricing = pricing.as_str();
        for key in ["model_override:", "catalog:", "backend:"] {
            assert!(pricing.contains(key), "控制台的价格来源对照表没跟上：{key}");
        }
        assert!(
            !pricing.contains("official_catalog") && !pricing.contains("connection_fallback"),
            "控制台还留着 2026-08-20 之前的旧枚举名",
        );

        // 两个统计窗口：服务端提了常量，页面必须读下发的字段而不是自己写数字。
        let sync = include_str!("relay_sync.rs");
        assert!(sync.contains("const MARGIN_WINDOW_DAYS"), "亏本看守的窗口没提成常量");
        let rates = include_str!("relay_rates.rs");
        assert!(rates.contains("const MIX_WINDOW_DAYS"), "混合配比的窗口没提成常量");
        let adapters = strip(include_str!("../admin-ui/src/pages/Adapters.tsx"));
        let adapters = adapters.as_str();
        // 判据是**渲染出来的那句话**里不许出现写死的天数 —— 只断言字段名出现过是没用的，
        // 类型声明里那一行就含它，把渲染处改回 7 照样绿（变异测试翻出来的）。
        let relay_ui = strip(include_str!("../admin-ui/src/pages/RelayRates.tsx"));
        let relay_ui = relay_ui.as_str();
        assert!(
            adapters.contains("margin_window_days") && !adapters.contains("最近 7 天"),
            "适配器页还在自己写 7 天",
        );
        assert!(
            relay_ui.contains("mix_window_days") && !relay_ui.contains("最近 30 天"),
            "模型汇率页还在自己写 30 天",
        );

        // 「认出来了没有」「差不差一个令牌」都由服务端判，不许拿中文字面量去比。
        assert!(
            !adapters.contains("!== \"未知\"") && !adapters.contains("=== \"未知\""),
            "适配器页还在拿中文字面量比家族名",
        );
        assert!(adapters.contains("family_known") && adapters.contains("topup_needs_token"));
    }

    /// 分母没读到时，**不许写钱**。
    ///
    /// 显示路径用兜底值是对的（否则每个金额都变成 Infinity），但写路径不是：
    /// 运营输入的美元 × 分母 = 存库的真实分，而分母是运营可改的（服务端允许 1~100000）。
    /// 改过之后一旦这次设置拉取失败，「发放 $50」会按 663 折算 —— 发出去的额度直接是错的，
    /// 而页面上没有任何痕迹（loadSettings 的 .catch 把错误整个吞掉，App 那边又是 fire-and-forget）。
    #[test]
    fn money_is_never_written_with_a_fallback_denominator() {
        let lib = include_str!("../admin-ui/src/lib/settings.ts");
        assert!(
            lib.contains("export function settingsLoaded()"),
            "没有「设置到货了没有」这个判据，写路径就分不清兜底和真值",
        );
        let ui = include_str!("../admin-ui/src/pages/Customers.tsx");
        let code: String = ui
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("settingsLoaded()"), "客户页没问过设置到货没有");
        // 两个写钱的按钮都得挂上这道闸：充值（发放额度）和改写余额。
        assert_eq!(
            code.matches("denomReady").count(),
            3,
            "写钱的按钮少挂了这道闸（定义 1 处 + 充值和改余额各 1 处）",
        );
    }

    /// 面值分母只能有一处。
    ///
    /// 它曾经在四个文件里各有一份副本，其中三份在**写路径**上（运营输入的美元乘分母存库）。
    /// 收进 `lib/settings.ts` 之后，`Settings.tsx` 里又冒出来一句 `savedDenom || 663` ——
    /// 修完之后自己添了第四份。分母不一致的直接后果是发出去的额度就是错的。
    #[test]
    fn the_denominator_literal_lives_in_exactly_one_place() {
        for (name, src) in [
            ("设置", include_str!("../admin-ui/src/pages/Settings.tsx")),
            ("客户", include_str!("../admin-ui/src/pages/Customers.tsx")),
            ("收款", include_str!("../admin-ui/src/pages/Billing.tsx")),
        ] {
            let code: String = src
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !t.starts_with("//") && !t.starts_with('*') && !t.starts_with("/*")
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code.contains("663"),
                "{name}页把面值分母又抄了一份 —— 它只该出现在 lib/settings.ts 的 FALLBACK 里",
            );
        }
        // 唯一那一份还在。
        let lib = include_str!("../admin-ui/src/lib/settings.ts");
        assert!(
            lib.contains("raw_cents_per_credit_usd: 663"),
            "lib/settings.ts 里那份兜底没了，页面拿不到分母时会除以 0",
        );
    }
}
