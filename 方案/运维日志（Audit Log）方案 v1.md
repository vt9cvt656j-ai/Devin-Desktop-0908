# 运维管理后台 · 运维日志（Audit Log）方案 v1

> 适用范围：`server/`（Rust + Axum 后端）+ `server/admin-ui/`（React 19 + Vite + Tailwind 4 + Radix UI 控制台）
> 文档状态：**评审稿**，不涉及代码改动
> 目标：把「**谁**、在 **什么时间**、因为 **什么原因**、对 **谁**、做了 **什么**、结果怎样」留成可查询、可统计、可导出的结构化记录，作为后续所有「出事了要溯源」「年底要统计额度变更总量」的唯一可信源

---

## 0. 阅读对象与术语

| 术语 | 含义 |
|---|---|
| **Audit Log** | 运维日志。一条不可篡改的结构化记录，描述一次由人或自动任务发起的、对生产数据产生副作用的操作 |
| **Actor** | 操作发起方。可能是管理员账户、智能员工、外部回调（Stripe webhook）或系统定时任务 |
| **Target** | 操作作用对象。可能是某个用户、某个订单、某条路由、某笔提现 |
| **Reason** | 操作原因。管理员手动操作时**强制要求填写**的字符串字段；自动任务则是机器可读的事件名 |
| **Diff (before / after)** | 关键字段变更前后的快照。JSONB，只记**真正变化的字段**，避免记录整行 |
| **Append-only** | 表只允许 `INSERT`，不允许 `UPDATE / DELETE`。审计日志不是工作流状态机，是「发生过什么」的事实陈述 |
| **Cursor-based pagination** | 游标分页。比 `OFFSET/LIMIT` 在大表上稳定得多（O(log n) vs O(n)），且新插入不会让用户看到重复或漏页 |
| **SOX / 4-eye principle** | 部分高敏操作（改定价、批量加额度、强制提现）需要第二个管理员在界面上**确认**后才能落库，记录里同时留 `actor` 和 `approver` |
| **PII redaction** | 在列表 / 导出里对邮箱、手机号、Stripe 账户 ID 等做脱敏；详情查看走单独鉴权 |
| **JWT Claims** | 现存 `sub / email / role / sid`（auth.rs:99）。本方案不引入新的 token，只复用其作为 actor 标识 |
| **events 表** | 现有 `events(user_id, kind, data, created_at)`，原用于实时推送的扁平事件流（realtime.rs:18）。**本方案不替换它**，但加日志表后，建议前端「客户时间线」改为读 audit log，events 表仅保留为实时事件 |

---

## 1. 现状摘要（基线）

| 维度 | 当前实现 | 问题 |
|---|---|---|
| 管理员操作记录 | 仅在 `events.data` JSONB 里塞一段 `{"by": claims.email, "action": "...", ...}`（codes.rs:466、codes.rs:498、payout.rs 若干处） | 没有专门表、没有索引、没法定类型、跨表 join 困难 |
| 加额度（grant / set_credits / set_plan） | `codes::admin_grant`、`codes::admin_set_credits`、`codes::admin_set_plan` 在 commit 后调一次 `record_event` | **没有 reason 字段**；admin 给某个用户加 1000 元，没办法事后回答「为什么」 |
| 充值（Stripe webhook） | `stripe.rs` 入账时调 `record_event` | 来源、订单号、Stripe charge id 都散落在 JSONB 里，统计当月实收要全文检索 |
| 提现（手动） | `withdraw()` 标 `paid_by_admin` 但没记 reason | 财务对账时「这 10000 是谁批的」要靠口口相传 |
| 定价变更（prices CRUD） | `pay::admin_create_price` / `admin_update_price` / `admin_toggle_price` 无记录 | 上个月某个套餐涨价了，没人能说清谁定的 |
| 群发邮件 | `email.rs` 仅记 `email_campaigns` 内容，**不记**「谁点了发送」「收件人筛选条件」 | 一年发了多少封、给谁发的，没有结构化答案 |
| 推荐人开通 | `referral::admin_grant` 不入 `events` | 直接裸调用 |
| 智能员工执行 | `employee_actions` 已经结构化（capability, args, result, decided_by），是现有体系里**做得最好的** | 但没有把它和其他管理员动作放在一起看 |
| 入口（侧栏） | `admin-ui/src/components/Shell.tsx` 已规划 28 个 NavKey，**没有 audit 类** | 新页面要新增顶级或二级入口 |
| 数据迁移体系 | 已上到 `20260873`，命名规范 `YYYYMMDD_描述.sql` | 新增迁移 `2026MMDD_admin_audit_log` |
| 角色模型 | 只有 `role = "admin"` 与非 admin | 现有权限粒度太粗，本方案**不引入 RBAC**，但日志要能区分「super admin」与「普通 admin」——理由见 §3.5 |

**核心痛点**：所有「为什么」「谁批的」「改了多少钱」都丢在 JSONB 里，没人能回答，**只有出问题那一刻大家才去找答案**。本方案要做的事不是「再加几张表」，而是**让任何一个动作发生后 30 秒内，能在前端搜索框里查到它，并且能看到变更前后的真实差异**。

---

## 2. 目标与边界

### 2.1 必须达成（Must-have）

1. **结构化记录全部高敏感操作**：加额度 / 改定价 / 强制提现 / 群发邮件 / 推荐人授权 / 智能员工决策 / 管理员登录登出
2. **每条记录含 5 要素 + 2 选**：`actor / action / target / reason / created_at` 必填；`before / after` 在字段变化时必填
3. **可查询**：按时间、actor、target、action 类型、关键字（reason / target email）筛选
4. **可分页**：cursor-based，单页 50 条，按时间倒序，深翻 1000 条仍稳定
5. **可导出**：CSV / JSONL 一次性导出（带筛选条件），用于财务对账
6. **不可篡改**：表层无 UPDATE / DELETE 权限；删除走「GDPR 删除」专用流程（写新行 + 软删除标记）
7. **完整 Diff**：金额字段变更前 + 变更后 + 差额，存为 `numeric(20,4)` 而非字符串
8. **前端一等公民**：独立顶级入口 `运维日志`，与「智能员工」「更新日志」并列

### 2.2 不在本期范围（Out-of-scope）

- **不引入完整 RBAC**：不实现「财务 / 客服 / 运维」三角色拆分，仅在日志里区分现有 admin 账户
- **不做实时大屏 / WebSocket 推送**：与现有 `realtime::record_event` 体系共存但解耦；日志查询走 REST + 分页
- **不做日志归档到 S3 / OSS**：本期全部留在 Postgres（容量预估见 §6.2）
- **不替换 `events` 表**：保留作为实时事件流
- **不实现 4-eye 强制审批**：本期先把日志记下来；UI 上的二次确认弹窗作为 P2

---

## 3. 数据模型

### 3.1 主表：`admin_audit_log`

```sql
-- migrations/20260907_admin_audit_log.sql (新增)

CREATE TABLE admin_audit_log (
    id              BIGSERIAL PRIMARY KEY,                -- 自增，保证全局单调；不暴露
    -- 时间：服务端 UTC，落地后任何人不能改
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 谁：管理员 id / 员工 id / 系统 actor。永远 nullable 但至少有一个非空
    actor_kind      TEXT NOT NULL CHECK (actor_kind IN
                        ('admin', 'employee', 'system', 'stripe', 'cron')),
    actor_id        UUID,                                 -- admin users.id 或 employees.id
    actor_email     TEXT,                                 -- 冗余存：管理员可能改名/删号，原文要留
    -- 干了什么：用稳定枚举 + 文本双轨，枚举给聚合，文本给人看
    action          TEXT NOT NULL,                        -- 例: "billing.grant.credits"
    action_category TEXT NOT NULL,                        -- 例: "billing"（用于侧栏分组）
    -- 对谁：target 表 + id 是稳定的，但用户删号/订单归档时 id 没了，要冗余存"当时的样子"
    target_kind     TEXT,                                 -- 例: "user" / "order" / "price" / "withdrawal"
    target_id       TEXT,                                 -- 用 TEXT 而非 UUID：跨表聚合时方便
    target_label    TEXT,                                 -- 例: "alice@example.com" / "Order #1F2K"
    -- 为什么：自动任务可为空；管理员手动操作**强制**要求
    reason          TEXT,
    -- 改了什么：before/after JSONB；NULL 表示该操作无结构化字段变更（例：纯触发）
    diff            JSONB,                                -- {"credits_cents": {"before": -1000, "after": 9000}, ...}
    -- 上下文：ip / ua / sid，方便溯源"是谁的那台机器上的哪个浏览器"
    source_ip       INET,
    user_agent      TEXT,
    session_id      TEXT,                                 -- Claims.sid
    -- 关联：让日志能反向跳回被操作的对象
    request_id      TEXT,                                 -- trace id，与 nginx access log 对齐
    -- 风险与审批：四眼原则时使用
    approver_id     UUID,                                 -- 第二个管理员（可空）
    approver_email  TEXT,
    risk_level      SMALLINT NOT NULL DEFAULT 0           -- 0=读 / 1=可逆运维 / 2=影响用户 / 3=危险
) PARTITION BY RANGE (occurred_at);

-- 按月分区（自动滚 12 个月分区，无需手动管理旧分区）
CREATE TABLE admin_audit_log_2026_09 PARTITION OF admin_audit_log
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
-- ... 部署时一次性建好当年到次年 12 个月的分区

-- 索引：覆盖所有筛选组合
CREATE INDEX ON admin_audit_log (occurred_at DESC, id DESC);                       -- 时间分页主键
CREATE INDEX ON admin_audit_log (actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX ON admin_audit_log (target_id, occurred_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX ON admin_audit_log (action_category, occurred_at DESC);
CREATE INDEX ON admin_audit_log (action, occurred_at DESC);
CREATE INDEX ON admin_audit_log (risk_level, occurred_at DESC);

-- 全文检索：reason 和 target_label 一起（GIN，中文用 simple 词典；英文用 english）
CREATE INDEX ON admin_audit_log
    USING gin (to_tsvector('simple', coalesce(reason,'') || ' ' || coalesce(target_label,'')));

-- 防篡改：拒绝任何 UPDATE / DELETE（除运维删除专用函数外）
REVOKE UPDATE, DELETE ON admin_audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON admin_audit_log FROM michael_app;  -- 应用账号也不给
-- 唯一允许的"删除"是软删：往同表 INSERT 一条 action='gdpr.erase' 的记录，标记原行
-- 不暴露给前端的 DELETE 角色

COMMENT ON TABLE admin_audit_log IS '所有对生产数据产生副作用的管理员/员工/系统操作的不可篡改日志';
COMMENT ON COLUMN admin_audit_log.diff IS '结构化 diff：{field: {before, after}}；只在字段真变化时记录';
```

### 3.2 为什么用 `BIGSERIAL` 而非 UUID

- 分页 cursor = `(occurred_at DESC, id DESC)`，自增 id 提供严格单调，是 cursor 稳定的根本
- UUID 在大表 + 高并发下 INSERT 性能差、占用大（16B vs 8B），且对日志「不暴露给前端」的属性没有价值
- id 永远不会暴露给前端 API

### 3.3 为什么用 `PARTITION BY RANGE`

- 月分区让 12 个月前的旧数据可整分区 detach → 离线归档（与备份策略对齐，OPERATIONS.md 提到的 14 天保留）
- 单分区 ≤ 300 万行时索引深度可控，B-tree 不会膨胀
- 旧分区可设 `ALTER TABLE ... SET (TOAST_AUTORECOMPRESS)`，节省 60% 空间
- 注意：分区表上不能加外键，这是有意为之——审计日志**不该**有 CASCADE 关系

### 3.4 Action 命名规范（强约束）

```
<domain>.<verb>.<noun>         例: billing.grant.credits
                                例: routing.toggle.endpoint
                                例: mail.send.broadcast
                                例: employee.decide.approve
                                例: auth.login.admin
```

| 域 | 例 |
|---|---|
| `billing` | `billing.grant.plan` / `billing.grant.credits` / `billing.set.credits` / `billing.set.plan` / `billing.refund` |
| `routing` | `routing.toggle.endpoint` / `routing.update.endpoint` / `routing.reorder` |
| `pricing` | `pricing.create` / `pricing.update` / `pricing.toggle` |
| `mail` | `mail.send.broadcast` / `mail.send.single` |
| `referral` | `referral.grant.recruit` / `referral.revoke.recruit` |
| `payout` | `payout.mark.paid` / `payout.approve.withdrawal` / `payout.batch.run` |
| `employee` | `employee.create` / `employee.update` / `employee.enable` / `employee.decide.approve` / `employee.decide.reject` |
| `auth` | `auth.login.admin` / `auth.logout.admin` / `auth.session.revoke` |
| `settings` | `settings.update.app` / `settings.update.email_template` |
| `docs` / `changelog` | `changelog.publish` / `docs.publish` |
| `system` | `system.cron.sweep` / `system.batch.settle` |

新动作**只允许**追加，不允许修改既有名字（删了就找不回记录）。命名变更时记一条 `action='meta.action.renamed'` 的指针。

### 3.5 Actor 区分

- `actor_kind = 'admin'`：`actor_id = claims.sub`，`actor_email = claims.email`
- `actor_kind = 'employee'`：`actor_id = employees.id`，`actor_email = NULL`，**同时**把操作触发者管理员记到 `actor_email` 旁的 `triggered_by_admin_id` 字段（P2 阶段补；本期不加字段，记到 `diff` 里）
- `actor_kind = 'stripe'`：填 `triggered_by_admin_id` / `actor_id = NULL`，从 webhook payload 提 idempotency_key 写进 `request_id`
- `actor_kind = 'cron'` / `'system'`：填 `request_id` = 调用点的 trace id，方便追到日志

本期**不引入** super_admin 角色区分，理由：现有 admin 数量极少（< 5），区分角色是 P2 议题。本期日志只解决「记得住」问题，不解决「谁能干」问题。

---

## 4. 后端实现（Rust + Axum）

### 4.1 新模块：`src/audit.rs`

```rust
//! 运维操作的结构化日志。
//!
//! 设计原则（与 events 表的关系）：
//! - events 表是**实时事件流**，给前端 WebSocket 推；数据扁平
//! - admin_audit_log 是**事实日志**，给后台查询 / 导出 / 财务对账；结构化、可聚合
//! - 两者由 audit::record 一次写入；不要求强一致（events 失败不影响 audit 落地，反之亦然）

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::Value;
use std::net::SocketAddr;

use crate::auth::Claims;
use crate::AppState;

#[derive(Debug, Clone, Copy)]
pub enum ActorKind { Admin, Employee, System, Stripe, Cron }

impl ActorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Employee => "employee",
            Self::System => "system",
            Self::Stripe => "stripe",
            Self::Cron => "cron",
        }
    }
}

/// 单条记录的最小输入。`before/after` 是 `serde_json::Value::Object`，记录人员只用
/// 把真正变化的字段传进来；库会自动 diff。
#[derive(Debug)]
pub struct Record<'a> {
    pub actor_kind: ActorKind,
    pub actor_id: Option<uuid::Uuid>,
    pub actor_email: Option<&'a str>,
    pub action: &'a str,                  // 例: "billing.grant.credits"
    pub target_kind: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub target_label: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub before: Option<Value>,            // 原始行快照（可选；强烈建议每次都传）
    pub after: Option<Value>,             // 变更后行快照（可选）
    pub risk_level: i16,                  // 0..=3
    pub session_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

pub async fn record(
    state: &AppState,
    headers: Option<&HeaderMap>,
    peer: Option<SocketAddr>,
    r: Record<'_>,
) {
    // 计算 diff：只保留 before/after 中真正变化且可序列化的字段
    let diff = compute_diff(r.before.as_ref(), r.after.as_ref());
    let ip = peer.map(|a| a.ip().to_string());

    let res: Result<_, sqlx::Error> = sqlx::query(
        "INSERT INTO admin_audit_log
            (actor_kind, actor_id, actor_email, action,
             target_kind, target_id, target_label, reason,
             diff, source_ip, user_agent, session_id, request_id, risk_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::inet,$11,$12,$13,$14)"
    )
    .bind(r.actor_kind.as_str())
    .bind(r.actor_id)
    .bind(r.actor_email)
    .bind(r.action)
    .bind(r.target_kind)
    .bind(r.target_id)
    .bind(r.target_label)
    .bind(r.reason)
    .bind(&diff)
    .bind(ip)
    .bind(headers.and_then(|h| h.get("user-agent").and_then(|v| v.to_str().ok())))
    .bind(r.session_id)
    .bind(r.request_id)
    .bind(r.risk_level)
    .execute(&state.db)
    .await;

    if let Err(e) = res {
        // 日志失败不阻塞主请求：tracing + 走兜底 events 表，保证至少有扁平记录
        tracing::error!(action = r.action, error = %e, "admin_audit_log insert failed");
        let _ = crate::realtime::record_event(
            state, None, "audit_log_fallback",
            serde_json::json!({"action": r.action, "target": r.target_id, "error": e.to_string()}),
        ).await;
    }
}

/// 计算结构化 diff。只保留前后不同、且值是 number / bool / string / null 的字段。
/// 数组和嵌套对象按"完整替换"处理（diff 字段标 `_replaced: true`），避免海量噪音。
fn compute_diff(before: Option<&Value>, after: Option<&Value>) -> Option<Value> {
    let (Some(b), Some(a)) = (before, after) else { return None; };
    let (Value::Object(b), Value::Object(a)) = (b, a) else { return None; };
    let mut diff = serde_json::Map::new();
    for (k, av) in a {
        let bv = b.get(k);
        if bv != Some(av) {
            diff.insert(
                k.clone(),
                serde_json::json!({"before": bv, "after": av, "_changed": true}),
            );
        }
    }
    if diff.is_empty() { None } else { Some(Value::Object(diff)) }
}

/// 从 Claims 提取 actor 元信息，消减每个 endpoint 的样板代码。
pub fn actor_from_claims(claims: &Claims) -> (ActorKind, Option<uuid::Uuid>, String) {
    let uid = uuid::Uuid::parse_str(&claims.sub).ok();
    (ActorKind::Admin, uid, claims.email.clone())
}
```

### 4.2 改造现有 admin endpoint

| 现有位置 | 调用方式 |
|---|---|
| `codes::admin_grant` (codes.rs:434) | 在 `tx.commit().await?` **之前**算 `before` (调 `user_summary` 拿快照)，commit 后 `audit::record` |
| `codes::admin_set_credits` (codes.rs:482) | 同上 |
| `codes::admin_set_plan` (codes.rs:534附近) | 同上 |
| `pay::admin_create_price` / `admin_update_price` / `admin_toggle_price` | 读 old row → 改 → 写 audit |
| `referral::admin_grant` (referral.rs:2133) | 简短：只记 action + target + reason |
| `payout::admin_withdraw_status` | reason **强制**填，记 actor + approver |
| `email` 群发 | 发完后批量写 N 条 audit (`mail.send.single`)，target_label 写每个收件人邮箱 |
| `employees::decide` (employees.rs:850) | 沿用现有 `employee_actions` 表；**额外**写一条 `employee.decide.approve/reject` 进 audit |
| `auth::login_admin` / `auth::logout_admin` | 写 `auth.login.admin` / `auth.logout.admin` |
| Stripe webhook | 写 `billing.charge.succeeded` / `billing.refund.issued` 等 |

#### 强制 reason 的实现

```rust
// codes.rs:434 改造示意
pub async fn admin_grant(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<GrantReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    // ... 业务校验 ...

    // 快照（commit 之前）
    let before = user_summary(&state, id).await.ok();

    let mut tx = state.db.begin().await?;
    match req.kind.as_str() {
        "plan" => { /* ... */ }
        "credits" => { /* ... */ }
        _ => return Err(AppError::bad("类型只能是 plan 或 credits")),
    }
    tx.commit().await?;

    let after = user_summary(&state, id).await?;

    // 关键：reason 从前端 body 来，admin 手动操作必填
    audit::record(&state, Some(&headers), Some(peer), audit::Record {
        actor_kind: audit::ActorKind::Admin,
        actor_id: uuid::Uuid::parse_str(&claims.sub).ok(),
        actor_email: Some(&claims.email),
        action: match req.kind.as_str() {
            "plan" => "billing.grant.plan",
            "credits" => "billing.grant.credits",
            _ => unreachable!(),
        },
        target_kind: Some("user"),
        target_id: Some(&id.to_string()),
        target_label: after.as_ref().and_then(|u| u.get("email")).and_then(|e| e.as_str()),
        reason: req.reason.as_deref(),       // 前端必填
        before: before.map(|v| serde_json::to_value(v).unwrap()),
        after: Some(serde_json::to_value(&after).unwrap()),
        risk_level: 2,
        session_id: claims.sid.as_deref(),
        request_id: None,
    }).await;

    Ok(Json(json!({ "ok": true, "user": after })))
}
```

`GrantReq` 增加 `reason: String` 字段（required）。前端表单 `<Input required />`，不填不让提交。

### 4.3 HTTP API（控制台专用）

```
GET  /api/admin/audit
  Query:
    cursor      string?    // 第一次为空，响应 next_cursor 即下次传
    actor_id    UUID?      // 按操作人筛选
    target_id   string?    // 按目标对象筛选
    action      string?    // 精确匹配
    category    string?    // billing / routing / mail …
    q           string?    // 全文检索：reason + target_label
    since       ISO8601?
    until       ISO8601?
    risk_min    0..=3?     // 默认 0
    limit       1..200?    // 默认 50
  Response:
    {
      "items": [
        {
          "id": "1691500001234-2026-09-07T08:23:14Z",   // 编码后 cursor
          "occurred_at": "2026-09-07T08:23:14.512Z",
          "actor": { "kind": "admin", "id": "...", "email": "alice@..." },
          "action": "billing.grant.credits",
          "category": "billing",
          "target": { "kind": "user", "id": "...", "label": "bob@..." },
          "reason": "用户报障补偿 7 日误扣",
          "diff": {
            "credits_cents": { "before": -1500, "after": 8500, "_changed": true },
            "plan": { "before": "free", "after": "free" }      // 与 before 同值的不进 diff
          },
          "risk_level": 2,
          "source_ip": "1.2.3.4",
          "session_id": "..."
        }
      ],
      "next_cursor": "1691500000876-2026-09-07T08:15:00Z"
    }

GET  /api/admin/audit/export
  Query: 同上（除 cursor）
  Response: text/csv 或 application/x-ndjson，按 ?format= 选；文件名 audit-YYYYMMDD-HHMM.csv
  实现：流式 COPY (服务端用 sqlx::query_as + chunked response，不要一次读全表)
  限额：默认 10000 行封顶；超额返回 413 + 提示用户缩小范围

GET  /api/admin/audit/stats
  Query: since / until
  Response:
    {
      "by_action": [ {"action": "billing.grant.credits", "count": 47, "sum_delta_credits_cents": 2345000}, ... ],
      "by_actor":  [ {"actor_email": "alice@...", "count": 312}, ... ],
      "by_day":     [ {"day": "2026-09-01", "count": 88}, ... ],
      "total_amount_changed_credits_cents": 12345678    // 跨所有加/扣额度操作
    }
  实现：服务端聚合查询，结果缓存 60s（Redis key: `audit:stats:<since>:<until>`）

GET  /api/admin/audit/users/:id     // 单个用户被操作的全历史（自动联 target_id 过滤 + email 显示）
```

**鉴权**：全部 `/api/admin/audit*` 走 `admin_only(&claims)?`（已有 auth.rs:10 helper）。

### 4.4 Cursor 分页实现

```rust
// 服务端：cursor 是 base64url(occurred_at_rfc3339|id)
fn encode_cursor(occurred_at: chrono::DateTime<chrono::Utc>, id: i64) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(format!("{}|{}", occurred_at.to_rfc3339(), id).as_bytes())
}

fn decode_cursor(s: &str) -> Result<(chrono::DateTime<chrono::Utc>, i64), AppError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let raw = URL_SAFE_NO_PAD.decode(s).map_err(|_| AppError::bad("cursor"))?;
    let s = std::str::from_utf8(&raw).map_err(|_| AppError::bad("cursor"))?;
    let (ts, id) = s.split_once('|').ok_or(AppError::bad("cursor"))?;
    let ts = chrono::DateTime::parse_from_rfc3339(ts)
        .map_err(|_| AppError::bad("cursor"))?
        .with_timezone(&chrono::Utc);
    let id: i64 = id.parse().map_err(|_| AppError::bad("cursor"))?;
    Ok((ts, id))
}

// 查询：
// WHERE (occurred_at, id) < ($cursor_ts, $cursor_id)  -- 复合比较，单 B-tree 索引
// ORDER BY occurred_at DESC, id DESC LIMIT $limit
```

**为什么用复合比较而非 `occurred_at < $1 OR (occurred_at = $1 AND id < $2)`**：前者走单次 index seek，性能差距在 50ms vs 5ms 量级。

### 4.5 不在本期做（但记录到 §10 P2）

- 4-eye approval：UI 上二次确认弹窗，audit 记录 `approver_id`
- Webhook 入站的事件签名校验（Stripe 已有，本方案不加）
- 全文检索改用 `pg_trgm` 或专门的 ES 索引（当前 GIN 足够应付 1000 万行）

---

## 5. 前端（admin-ui）实现

### 5.1 依赖（全部最新稳定版）

| 包 | 版本 | 用途 |
|---|---|---|
| `react` | `19.2.0` | 已装 |
| `lucide-react` | `0.548.0` | 已装；新增 `ClipboardList / ScrollText / UserPlus / Coins / Mail / Route / Eye` |
| `tailwindcss` | `4.3.3` | 已装 |
| `@radix-ui/react-tooltip` | `1.2.7` | 已装 |
| `@radix-ui/react-dialog` | `1.1.14` | 已装（详情弹窗） |
| `@radix-ui/react-dropdown-menu` | `^2.1.x` | **新增**：行级操作菜单 |
| `@radix-ui/react-select` | `^2.1.x` | **新增**：筛选条件下拉（替代原生 `<select>`） |
| `date-fns` | `^4.1.x` | **新增**：时间格式化 / 区间选择 |
| （不引入） TanStack Query | — | 控制台体量小，fetch 集中在 `lib/api.ts` |

不引入 chart 库；统计图用纯 SVG 自绘（§5.5）。

### 5.2 入口：顶级「运维日志」

在 `Shell.tsx` 的 `NAV` 数组中插入：

```ts
// 放在「智能员工」之后、「模型汇率」之前（运维动作归在一起）
{ key: "audit-log", label: "运维日志", icon: ClipboardList },
```

并在 `NavKey` 联合类型追加 `"audit-log"`。

### 5.3 页面文件：`admin-ui/src/pages/AuditLog.tsx`

**布局参考**：Google Cloud Console > IAM & Admin > Audit Logs；Apple Business Manager > Activity。共同特征：

1. **顶栏**：左侧标题 + 今日/本周/本月动作数；右侧刷新按钮 + 导出按钮（次级）
2. **筛选条**（sticky top）：时间范围选择器 + 操作人搜索 + 动作类别 select + 风险等级多选 + 关键字搜索
3. **结果列表**：表格行，左侧时间列 + 主体动作列 + 右侧 actor 列
4. **行点击**：打开右侧 **Side Sheet**（宽度 480px），展示完整 diff
5. **空状态**：EmptyState 组件（已有）

**色彩**：沿用现有 zinc 调性

| 用途 | 颜色 token |
|---|---|
| risk=0 读 | `text-muted-foreground` |
| risk=1 可逆运维 | `text-blue-600 dark:text-blue-400` |
| risk=2 影响用户 | `text-amber-600 dark:text-amber-400` |
| risk=3 危险 | `text-red-600 dark:text-red-400` |
| 金额正向（+） | `text-emerald-600` |
| 金额负向（−） | `text-red-600` |

**禁止 emoji**。所有状态徽章用 Radix + 自定义 SVG 图标（§5.5）。

### 5.4 关键交互

```tsx
// 行点击 → Side Sheet 展示 diff
<Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
  <SheetContent side="right" className="w-full sm:max-w-[480px]">
    <SheetHeader>
      <SheetTitle>{selected.action}</SheetTitle>
      <SheetDescription>{when(selected.occurred_at)} · {selected.actor.email}</SheetDescription>
    </SheetHeader>

    {selected.diff && <DiffView diff={selected.diff} />}
    {/* DiffView：横向两列 before / after，红/绿高亮差异行 */}
    {selected.reason && (
      <div>
        <div className="text-xs text-muted-foreground">原因</div>
        <div className="text-sm">{selected.reason}</div>
      </div>
    )}

    <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
      <div>来源 IP: {selected.source_ip || "—"}</div>
      <div>会话: {selected.session_id?.slice(0,8) || "—"}</div>
    </div>
  </SheetContent>
</Sheet>
```

```tsx
// 筛选条：受控 + URL 同步（分享筛选链接）
const [filters, setFilters] = useFiltersFromUrl();  // 自定义 hook
// 任何变更 → router.replace(`?${qs}`)，刷新页面不丢状态
```

```tsx
// 无限滚动加载下一页（IntersectionObserver 触发）
// 第一次进入用 fetch("/api/admin/audit?limit=50")
// 滚到底触发 fetch("?cursor=<...>&limit=50")，append
// 直到 next_cursor 为空
```

### 5.5 自绘 SVG 图标（不引入 emoji）

放在 `admin-ui/src/assets/audit/`：

- `risk-0.svg` — 眼睛轮廓（read-only）
- `risk-1.svg` — 扳手（可逆运维）
- `risk-2.svg` — 用户轮廓 + 星号（影响用户）
- `risk-3.svg` — 警告三角（danger）
- `diff-add.svg` — 绿色 `+` 圆角方块
- `diff-remove.svg` — 红色 `−` 圆角方块
- `reason-tag.svg` — 引号

所有 SVG 遵循：

1. 24×24 viewBox，`stroke-width: 1.5`，`stroke-linecap: round`
2. 单色 `currentColor`（便于深浅色模式自适应）
3. 不在 SVG 内嵌 `<style>`，避免 Tailwind purge 失效
4. 提供 React 组件包装（接受 `className` / `size` props）

参考：Lucide 图标风格（已有依赖，可借鉴其比例与描边），但**本方案不直接用 Lucide**——Lucide 的 risk 徽章图标不精确表达「影响用户 / 危险」语义，自绘更稳。

### 5.6 适配既有 Shell / Panel / EmptyState

完全复用现有组件（`Shell.tsx`、`PageHeader.tsx`、`Panel.tsx`、`Stat.tsx`、`EmptyState.tsx`、`TableSkeleton.tsx`、`Toolbar.tsx`、`Pager.tsx`）。不引入新样式系统；所有颜色 token 沿用 Tailwind 4 主题 + `bg-card / text-muted-foreground` 等语义类。

### 5.7 不做的（避免过度设计）

- ❌ 实时 WebSocket 推送（与现有 realtime.rs 重复，本期拉一次刷新）
- ❌ 拖拽列排序（运维日志时间倒序是固定业务约束）
- ❌ 多语言（中英对照就够，复用现有 i18n 模式若有；当前 admin-ui 是中文优先，本期不强制双语）

---

## 6. 部署与迁移

### 6.1 迁移文件命名

`migrations/20260907_admin_audit_log.sql`

按现有命名规范 `YYYYMMDD_描述.sql`。**与上次提到的 `20260873` 不冲突**——下一个迁移就是本次的。

迁移内容：

1. CREATE TABLE + 分区（建当年到次年 12 个分区）
2. CREATE INDEX
3. REVOKE 权限
4. COMMENT ON 注释
5. INSERT 一条 `system.bootstrap.audit_log_table` 记录（actor=system，action=`system.bootstrap.audit_log`），让管理员能在 UI 上看到「表刚建好」

### 6.2 容量预估

| 场景 | 估算 |
|---|---|
| 日均 admin 操作 | 50–200 条（保守 500 条） |
| 单条平均大小 | ~1.5 KB（含 diff JSONB） |
| 月增量 | 500 × 30 × 1.5KB ≈ 22 MB |
| 年增量 | ≈ 260 MB |
| 月分区单分区 | 22 MB（远低于 300 万行警戒线） |
| GIN 全文索引膨胀 | ~3 倍（约 70 MB / 月分区） |

**结论**：5 年内无需归档。

### 6.3 灰度上线步骤

| 步骤 | 描述 | 验收 |
|---|---|---|
| 1. 应用迁移 | `bash deploy.sh` 走正常流程 | `\d admin_audit_log` 可见，索引齐全 |
| 2. 后端灰度 | 新模块 `audit.rs` 编入，新 endpoint **未上线**（仅 `record` 函数可用） | `cargo build` 通过 |
| 3. 改造 grant / set_credits | 在 `codes::admin_grant` 加 `audit::record` 调用 | 跑一次真实加额度，audit 表出现记录 |
| 4. 改造其余 endpoint | 按 §4.2 表逐个改 | 每个动作类型有 ≥1 条记录 |
| 5. 上线 `/api/admin/audit` 查询端点 | 前端页面提前一周可用，**只读** | 列表能看见最近 7 天记录 |
| 6. 上线 export / stats | 与前端「导出」按钮对齐 | CSV 可下载、stats 卡片显示正确 |
| 7. 文档与回滚预案 | 更新 `docs/OPERATIONS.md`，加入回滚步骤 | 文档评审通过 |

### 6.4 回滚

- 表 DROP（无外键依赖，可直接 DROP TABLE）
- 移除 Rust 代码（git revert commit）
- 前端页面路由移除 `audit-log` NavKey
- **不需要**回填数据——回滚意味着承认本次失败，丢几天日志可接受

---

## 7. 测试

### 7.1 后端单测（参照 employees.rs 测试惯例）

```rust
#[cfg(test)]
mod tests {
    // 断言：grant 操作一定产生一条 audit
    #[tokio::test]
    async fn grant_writes_audit_record() { ... }

    // 断言：diff 只记录真正变化的字段
    #[test]
    fn compute_diff_keeps_only_changed() { ... }

    // 断言：cursor 编解码对称且拒绝非法输入
    #[test]
    fn cursor_roundtrip() { ... }

    // 断言：reason 为空时管理员手动操作返回 400
    #[tokio::test]
    async fn admin_grant_requires_reason() { ... }

    // 断言：diff 不存敏感字段（password_hash / api_key_ciphertext）
    #[test]
    fn diff_strips_sensitive_fields() { ... }   // 白名单字段：credits_cents / plan / quota_* / role
}
```

### 7.2 集成测试（已有 testdata + scripts/）

加 `server/testdata/audit/`：

- `seed.sql`：插入 100 条覆盖各种 action 的样本
- `query_smoke.sh`：curl 各 endpoint 验证返回结构

### 7.3 前端

不单独加测试框架。手动验收清单见 §9.3。

---

## 8. 安全与合规

| 维度 | 措施 |
|---|---|
| 鉴权 | 全部 `/api/admin/audit*` 走 `admin_only`（已有 helper） |
| 越权 | admin 之间看不到对方独有的 client_secret（diff 白名单） |
| 防注入 | 全文搜索走 `to_tsvector` + 参数化，不拼字符串 |
| PII 脱敏 | 列表展示 target_label 时邮箱打码 `alice@***.com`；详情弹窗点 Eye 图标才显示完整（一次性 5 秒展示） |
| 防泄露 | export 文件走临时签名 URL，30 分钟失效；记录里 audit 自身留 `export.requested_by` / `export.row_count` |
| GDPR | 用户行使删除权时，**不**物理删除 audit 行；改为 INSERT 一条 `action='gdpr.erase'` 记录，正文存「原 PII 已按用户请求清除，原行 diff 字段已置 NULL」；后台脚本扫描该用户 90 天前的 audit 行，将 diff / target_label 中可识别字段设为 `'[redacted]'` |
| 表防篡改 | 应用账号 REVOKE UPDATE/DELETE；唯一写入路径是 audit::record 函数 |
| 备份 | `backup.sh` 已覆盖；审计日志在 pg_dump 全量备份里 |

---

## 9. 验收清单

### 9.1 数据库

- [ ] `admin_audit_log` 表已创建，12 个月分区齐全
- [ ] 全部索引存在，EXPLAIN 走索引
- [ ] 应用账号对表无 UPDATE/DELETE 权限

### 9.2 后端

- [ ] `cargo test -p server` 全绿
- [ ] `cargo clippy --all-targets -- -D warnings` 无新增警告
- [ ] 现有 14 个 admin endpoint 每个至少有 1 条 audit 记录（人工跑一遍）
- [ ] `GET /api/admin/audit` 返回结构与 §4.3 一致
- [ ] `GET /api/admin/audit/export?format=csv` 流式下载 10000 行不超时
- [ ] cursor 分页：连续请求 20 次无重复无丢失

### 9.3 前端

- [ ] 侧栏出现「运维日志」入口，点击进入
- [ ] 默认列表展示最近 50 条，按时间倒序
- [ ] 筛选：选 `category=billing` + `actor=alice@…` + 时间区间，结果精准
- [ ] 行点击侧边抽屉显示完整 diff，金额变更红绿色高亮
- [ ] 风险等级徽章颜色正确（蓝/黄/红）
- [ ] 「导出 CSV」按钮下载文件，Excel 可打开无乱码（UTF-8 BOM）
- [ ] 深色模式 + 浅色模式均通过
- [ ] 全部按钮、徽章、状态使用 SVG 图标，无 emoji

### 9.4 运维

- [ ] `docs/OPERATIONS.md` 增加「运维日志」一节
- [ ] 回滚步骤写明
- [ ] 上线后一周内监控 `audit_log_fallback` 事件数（兜底触发）

---

## 10. 后续迭代（P2，不在本次范围）

1. **4-eye 强制审批**：高风险操作（risk=2/3）前端必须弹出二次确认；audit 记录 `approver` 字段启用
2. **审计日志的实时大屏**：单独路由 `/admin/audit/live`，WebSocket 推送最近 60 秒动作
3. **离线归档到 OSS**：超过 12 月的分区 detach → COPY TO → S3-compatible storage
4. **admin 角色细分**：引入 `super_admin / finance / support / ops` 四角色
5. **基于 audit 的告警**：例如「同一 actor 1 小时内 grant 超过 10000 元」触发邮件给 super admin
6. **ELK / ClickHouse 镜像**：当日志 > 5000 万行时迁移到专用分析库
7. **智能员工的审计与人工审计合并视图**：`employee_actions` 表保留，但前端合并到 audit 日志时间线，按 actor_kind 分色

---

## 11. 决策记录（ADR-style）

### ADR-1：为何不替换 `events` 表

- `events` 是**实时事件流**，给前端 WebSocket 推；扁平、量小、不要求强 schema
- `admin_audit_log` 是**事实日志**，给后台查询/导出/对账；结构化、可聚合、有索引
- 两套并存：性能、关注点、保留期都不一样
- `audit::record` 失败时兜底写 `events.kind='audit_log_fallback'`，保证审计不丢

### ADR-2：为何 `BIGSERIAL` 而非 UUID

- cursor 分页的稳定基础是「严格单调 + 8B 紧凑」
- 自增 id 不暴露给前端，无安全顾虑
- 节省 50% 索引空间

### ADR-3：为何分区

- 月分区让大表 dump / restore / detach 不阻塞主库
- 旧分区单独 TOAST 压缩，节省 60% 空间
- 不影响业务；查询时 PG 自动选分区

### ADR-4：为何本月不上 RBAC

- 现有 admin 数量 < 5，引入 4 角色带来 4 倍权限矩阵维护成本，得不偿失
- 先把日志记下来，下个迭代再细化角色

---

> **方案作者**：本方案遵循现有 `server/` 代码风格（中文注释、明确理由前置、避免过度工程），所有路径与现有实现对齐。评审通过后再开始落地。