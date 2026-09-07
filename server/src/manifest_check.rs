//! 「线路声明开放的模型，上游是不是每一款都真有」。
//!
//! # 探活为什么发现不了这件事
//!
//! `route_health::canary_once` 只探 `allowed_ids(m).first()` —— 一条线路声明五款、
//! 第四款上游没有，探活照样报绿。生产实测：GPT 线路探活 `ok=true status=200`，
//! 而 `gpt-5.6-luna` 每次请求都撞 404（`model "gpt-5.6-luna" is not supported by any
//! configured account in this group`），六小时二十六次，没有任何东西报警。
//!
//! 下架机制也接不住：`Delisted` 只有 `OutOfQuota` 和 `AuthRejected` 两种理由，没有
//! 「这款货这家没有」。所以那条线路永远不会因此被下架，每个请求照旧往它身上撞，
//! 白烧掉两次尝试机会里的一次。
//!
//! # 为什么单独一个任务，而不是塞进 canary
//!
//! canary 花的是**真钱**（一次最小真实推理请求），所以它有开关、有每轮条数上限、
//! 有「最近有真实流量就跳过」。清单比对只是一个 `GET /models`，不花 token。
//! 混在一起的话，便宜的那个会被贵的那个的节流一起拖住 —— 而这正是要跑得勤的那个。
//!
//! # 判据：只报「声明了但上游没有」
//!
//! 反过来那一半（上游有、我们没声明）**不是问题**，那是 `admin_available` 的 `extra`
//! 在管的事，是机会不是故障。混在一起报会让这条告警每天响，然后被静音。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::AppState;

/// 多久比对一轮。
///
/// 10 分钟：它不花钱，但也不必更快 —— 中转商上下架模型是人工操作，分钟级足够。
/// 比 canary 的 15 分钟略快一档，这样「线路通但少货」总是先于「线路不通」被看见。
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// 单次拉清单的耐心。只是一个 GET，给 15 秒足够；再长会让一轮拖很久。
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// 同一个出口两次告警之间至少隔多久 —— 否则一个配错的模型会每 10 分钟发一封。
const ALARM_COOLDOWN_SECS: i64 = 6 * 3600;

/// 一个出口的比对结果。
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Report {
    /// 我们声明开放、而上游清单里没有的。**这就是会撞 404 的那些。**
    pub missing: Vec<String>,
    /// 上游一共报了多少款。0 且 `note` 非空 = 没问成，不是「一款都没有」。
    pub upstream_total: usize,
    /// 没问成时的原因。空 = 问成了。
    ///
    /// 「没问成」和「没有」必须分开：有些中转根本不提供 `/models`，把它报成
    /// 「全部缺货」会让整块面板变成红的，然后没人再看它。
    pub note: String,
    /// unix 秒。0 = 从没比对过。
    pub checked_at: i64,
}

impl Report {
    /// 这次比对**得出了结论**吗（而不是没问成）。
    pub fn conclusive(&self) -> bool {
        self.note.is_empty()
    }
}

fn store() -> &'static Mutex<HashMap<uuid::Uuid, Report>> {
    static S: OnceLock<Mutex<HashMap<uuid::Uuid, Report>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 上次告警时间，按出口。只在进程内 —— 重启后重发一次是可以接受的，
/// 而为它建一张表意味着「告警冷却」这件事能因为写库失败而丢。
fn alarmed_at() -> &'static Mutex<HashMap<uuid::Uuid, i64>> {
    static S: OnceLock<Mutex<HashMap<uuid::Uuid, i64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这个出口最近一次比对的结果。`None` = 还没轮到它。
pub fn report_for(id: uuid::Uuid) -> Option<Report> {
    store().lock().ok().and_then(|g| g.get(&id).cloned())
}

/// 现在一共有多少个出口缺货 —— 面板顶部那个数字。
pub fn missing_endpoint_count() -> usize {
    store()
        .lock()
        .map(|g| g.values().filter(|r| r.conclusive() && !r.missing.is_empty()).count())
        .unwrap_or(0)
}

/// 问一个地址「你有哪些模型」。
///
/// 和 `route_endpoints::admin_available` 拉的是同一个接口，但**不共用代码**：那个是
/// 管理员点一下、要把失败原因原样讲给人听的交互路径；这个是后台轮询，只需要
/// 「拿到清单」或「一句话说明为什么没拿到」。合并会让其中一个的错误处理迁就另一个。
async fn fetch_ids(http: &reqwest::Client, base_url: &str, key: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/models", crate::models::api_base(base_url));
    let resp = http
        .get(&url)
        .header("authorization", format!("Bearer {key}"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        // 不回显 reqwest 的原文：它带完整 URL，而有些转卖商要求密钥写在查询串里。
        .map_err(|_| "连不上".to_string())?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(match status {
            401 | 403 => "密钥被拒".into(),
            404 => "这家不提供 /models".into(),
            _ => format!("上游返回 {status}"),
        });
    }
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "返回的不是 JSON".to_string())?;
    let ids: Vec<String> = crate::models::parse_model_ids(&v);
    if ids.is_empty() {
        // 200 但一款都没有：多半是返回结构不一样，不是真的空。当作没问成。
        return Err("清单是空的（返回结构可能不同）".into());
    }
    Ok(ids)
}

/// 比对一轮：每条线路自带地址 + 它挂的每个出口。
pub async fn check_once(state: &AppState) {
    let Ok(http) = reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() else {
        return;
    };
    let routes: Vec<crate::models::Model> =
        match sqlx::query_as("SELECT * FROM models WHERE active = true ORDER BY sort, created_at")
            .fetch_all(&state.db)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "模型清单比对：线路读不出来，本轮跳过");
                return;
            }
        };
    let eps = crate::route_endpoints::load_for_routes(
        &state.db,
        &routes.iter().map(|m| m.id).collect::<Vec<_>>(),
    )
    .await;

    let now = chrono::Utc::now().timestamp();
    for r in &routes {
        let declared = crate::models::allowed_ids(r);
        if declared.is_empty() {
            continue;
        }

        // (出口 id, 展示名, 地址, 密钥, 这个出口该有哪些)
        let mut targets: Vec<(uuid::Uuid, String, String, String, Vec<String>)> = vec![(
            r.id,
            format!("{}（自带地址）", r.label),
            r.base_url.clone(),
            r.api_key.clone(),
            declared.clone(),
        )];
        for e in eps.get(&r.id).into_iter().flatten().filter(|e| e.active) {
            let key = if e.api_key.trim().is_empty() { r.api_key.clone() } else { e.api_key.clone() };
            // 出口没填 enabled_models 就等于「承载线路开放的那些」，和 `expand` 同口径。
            let want = if e.enabled_models.is_empty() { declared.clone() } else { e.enabled_models.clone() };
            let label = if e.label.trim().is_empty() { "未命名出口".to_string() } else { e.label.clone() };
            targets.push((e.id, format!("{} / {}", r.label, label), e.base_url.clone(), key, want));
        }

        for (id, label, base, key, want) in targets {
            if base.trim().is_empty() || key.trim().is_empty() {
                continue;
            }
            let report = match fetch_ids(&http, &base, &crate::models::model_key(&key)).await {
                Ok(ids) => {
                    let missing: Vec<String> =
                        want.iter().filter(|m| !ids.contains(m)).cloned().collect();
                    Report { missing, upstream_total: ids.len(), note: String::new(), checked_at: now }
                }
                Err(note) => Report { missing: Vec::new(), upstream_total: 0, note, checked_at: now },
            };

            if report.conclusive() && !report.missing.is_empty() {
                tracing::warn!(
                    endpoint = %id,
                    route = %label,
                    missing = %report.missing.join(","),
                    upstream_total = report.upstream_total,
                    "声明开放的模型上游没有 —— 这些请求会撞 404，而线路探活照样报绿"
                );
                maybe_alarm(state, id, &label, &report).await;
            }
            if let Ok(mut g) = store().lock() {
                g.insert(id, report);
            }
        }
    }
}

/// 缺货时给管理员发一封，带冷却。
async fn maybe_alarm(state: &AppState, id: uuid::Uuid, label: &str, report: &Report) {
    let now = chrono::Utc::now().timestamp();
    {
        let Ok(mut g) = alarmed_at().lock() else { return };
        if g.get(&id).is_some_and(|t| now - *t < ALARM_COOLDOWN_SECS) {
            return;
        }
        // 先占住冷却再发信。反过来的话，一次发信要几秒，这几秒里下一轮就能挤进来发第二封。
        g.insert(id, now);
    }
    let body = format!(
        "出口「{label}」声明开放但上游没有的模型：\n\n  {}\n\n\
         上游一共报了 {} 款。这些模型的请求会撞 404，而线路探活只探第一款、照样报绿。\n\n\
         处理：去后台「模型线路 → 多路由」，要么把这几款从这个出口的开放清单里去掉，\n\
         要么换一个真有它们的出口。",
        report.missing.join("\n  "),
        report.upstream_total,
    );
    let sent = crate::route_health::notify_admins(state, &format!("线路缺货：{label}"), &body).await;
    if !sent {
        // 没发出去就把冷却退回去，下一轮再试 —— 否则一次邮件故障会静默吃掉六小时。
        if let Ok(mut g) = alarmed_at().lock() {
            g.remove(&id);
        }
    }
}

/// 起一个后台任务，定期比对。
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // 开机先等一会：启动那一刻线路刚读进来，而且和 canary 抢同一批上游没必要。
        tokio::time::sleep(Duration::from_secs(90)).await;
        loop {
            check_once(&state).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> String {
        let all = include_str!("manifest_check.rs");
        all.split("\n#[cfg(test)]").next().unwrap().to_string()
    }

    /// 「没问成」和「没有」不能是同一个值。
    ///
    /// 这是这个模块最容易塌的地方：`fetch_ids` 失败时如果回一个空 Vec，
    /// 下面的 `want.filter(|m| !ids.contains(m))` 会把**全部**声明模型判成缺货，
    /// 于是一家不提供 `/models` 的中转会让整条线路报成全红，然后告警被静音。
    #[test]
    fn a_failed_fetch_is_not_an_empty_catalog() {
        let unreachable = Report { missing: vec![], upstream_total: 0, note: "连不上".into(), checked_at: 1 };
        assert!(!unreachable.conclusive(), "没问成却被当成了有结论");
        assert!(unreachable.missing.is_empty(), "没问成不许产出缺货名单");

        let real = Report { missing: vec!["a".into()], upstream_total: 3, note: String::new(), checked_at: 1 };
        assert!(real.conclusive());

        // 计数只数有结论的那些。
        let s = src();
        assert!(
            s.contains("filter(|r| r.conclusive() && !r.missing.is_empty())"),
            "面板计数没有排掉「没问成」的出口 —— 那会把连不上报成缺货",
        );
    }

    /// 空清单必须当成「没问成」，不能当成「一款都没有」。
    #[test]
    fn an_empty_list_counts_as_a_failure_not_an_empty_shop() {
        let s = src();
        let i = s.find("async fn fetch_ids(").expect("拉清单的函数不见了");
        let body = &s[i..];
        assert!(
            body.contains("if ids.is_empty() {") && body.contains("清单是空的"),
            "200 但空清单被当成了真的空 —— 那会把这家的全部声明模型报成缺货",
        );
    }

    /// 只报「声明了但上游没有」，反方向不报。
    #[test]
    fn only_the_missing_half_is_reported() {
        let want = ["a".to_string(), "b".to_string()];
        let upstream = ["b".to_string(), "c".to_string()];
        let missing: Vec<&String> = want.iter().filter(|m| !upstream.contains(m)).collect();
        assert_eq!(missing, vec!["a"], "缺货判据算错了");
        // c 是上游多出来的货，那是 admin_available 的 extra 在管的机会，不是故障。
        assert!(!missing.iter().any(|m| *m == "c"), "把「上游多的货」也报成故障了");
    }

    /// 发信失败必须把冷却退回去。
    #[test]
    fn a_failed_alarm_does_not_burn_the_cooldown() {
        let s = src();
        let i = s.find("async fn maybe_alarm(").expect("告警函数不见了");
        let body = &s[i..];
        assert!(
            body.contains("if !sent {") && body.contains("g.remove(&id);"),
            "发信失败没有退回冷却 —— 一次邮件故障会静默吃掉六小时的告警",
        );
        // 冷却要在发信**之前**占住，否则一轮发信的几秒里下一轮能挤进来。
        let insert = body.find("g.insert(id, now);").expect("没占冷却");
        let send = body.find("notify_admins").expect("没发信");
        assert!(insert < send, "先发信后占冷却 —— 并发时会发出两封");
    }
}
