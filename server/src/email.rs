//! Outbound mail: one-off transactional messages, and broadcasts to the customer base.
//!
//! Two things share this file and must not share behaviour. `send_mail` is the low-level
//! send used by verification codes — it asks nobody's permission, because a code is the
//! reply to an action the person just took. Everything below `Segment` is the broadcast
//! side, which honours opt-out, carries an unsubscribe link, and is recorded as a campaign.
//!
//! **Why sending happens off the request.** The previous version looped over recipients
//! inside the handler. A thousand addresses at a fifth of a second each is over three
//! minutes of held-open connection, and the timeout that eventually killed it told the
//! operator nothing about how far it had got — or whether it was still going. The handler
//! now writes a row, spawns the work, and returns; the console reads progress off that row.

use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Claims;
use crate::config::Config;
use crate::error::{ApiResult, AppError};
use crate::AppState;

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

/// Pause between sends in a campaign.
///
/// Not politeness — providers rate-limit, and a burst that trips the limit turns into a
/// run of failures partway down the list, which is the worst outcome: some people get the
/// message twice when it is retried, and some never get it at all.
const SEND_GAP: Duration = Duration::from_millis(120);

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Plain text → the HTML the Worker wants, still reading as the text it was: escaped, one
/// `<br>` per newline (pre-wrap alone is lost in clients that strip styles).
fn text_to_html(text: &str) -> String {
    format!(
        "<div style=\"white-space:pre-wrap;font:15px/1.6 system-ui,sans-serif;color:#18181b\">{}</div>",
        escape_html(text).replace('\n', "<br>")
    )
}

/// The Worker's `POST /api/notify` body. Its field names are the Worker's (`to` / `title` /
/// `content`), and `content` is always HTML on that side.
fn worker_notify_payload(to: &str, subject: &str, body: &str, html: bool) -> serde_json::Value {
    json!({
        "to": to,
        "title": subject,
        "content": if html { body.to_string() } else { text_to_html(body) },
    })
}

/// Cloudflare Worker `mrday-email-sender` (`EMAIL_WORKER_URL` / `EMAIL_WORKER_KEY`): sends as
/// noreply@mrday.one, free tier 1000 messages a day. A 2xx whose body says `success:false`
/// (its own rate limit / quota) is a failure too — it is the Worker saying so, not a transport.
async fn send_via_worker(cfg: &Config, to: &str, subject: &str, body: &str, html: bool) -> ApiResult<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    let resp = client
        .post(format!("{}/api/notify", cfg.email_worker_url.trim_end_matches('/')))
        .bearer_auth(&cfg.email_worker_key)
        .header("accept", "application/json")
        .json(&worker_notify_payload(to, subject, body, html))
        .send()
        .await
        .map_err(|e| AppError::internal(format!("邮件 Worker 请求失败: {e}")))?;
    let status = resp.status();
    let txt = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let brief: String = txt.chars().take(300).collect();
        return Err(AppError::internal(format!("邮件 Worker 返回 {}: {brief}", status.as_u16())));
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
        if v.get("success").and_then(|s| s.as_bool()) == Some(false) {
            let why = v.get("message").or_else(|| v.get("error")).and_then(|m| m.as_str()).unwrap_or("unknown");
            return Err(AppError::internal(format!("邮件 Worker 拒绝: {why}")));
        }
    }
    Ok(())
}

/// Brevo's transactional HTTP API (`BREVO_API_KEY` / `MAIL_FROM`).
async fn send_via_brevo(cfg: &Config, to: &str, subject: &str, body: &str, html: bool) -> ApiResult<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    let mut payload = json!({
        "sender": { "name": cfg.mail_from_name, "email": cfg.mail_from },
        "to": [ { "email": to } ],
        "subject": subject,
    });
    payload[if html { "htmlContent" } else { "textContent" }] = json!(body);
    let resp = client
        .post("https://api.brevo.com/v3/smtp/email")
        .header("api-key", &cfg.brevo_api_key)
        .header("accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::internal(format!("邮件发送失败: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::internal(format!("邮件服务返回 {code}: {txt}")));
    }
    Ok(())
}

/// Send a single email. Two transports, both over HTTPS/443 (so they work even when the
/// host's outbound SMTP ports are blocked), chosen from the environment at send time:
///   · the Cloudflare Worker when `EMAIL_WORKER_URL` + `EMAIL_WORKER_KEY` are set — preferred;
///   · Brevo when `BREVO_API_KEY` + `MAIL_FROM` are set — the only transport if the Worker is
///     not configured, and the fallback when a Worker send fails (network, 5xx, its quota).
///
/// Deliberately unaware of `email_opt_out`: this is the path a login code takes, and
/// someone who unsubscribed from announcements has not asked to be locked out of their
/// account. Only the campaign sender filters recipients.
pub async fn send_mail(
    cfg: &Config,
    to: &str,
    subject: &str,
    body: &str,
    html: bool,
) -> ApiResult<()> {
    if cfg.worker_enabled() {
        match send_via_worker(cfg, to, subject, body, html).await {
            Ok(()) => return Ok(()),
            Err(e) if cfg.brevo_enabled() => {
                tracing::warn!("邮件 Worker 发送失败，退回 Brevo：{}", e.msg);
            }
            Err(e) => return Err(e),
        }
    }
    send_via_brevo(cfg, to, subject, body, html).await
}

async fn log_email(
    state: &AppState,
    to: &str,
    subject: &str,
    status: &str,
    error: Option<&str>,
    by: &str,
) {
    let _ = sqlx::query("INSERT INTO email_logs (to_email, subject, status, error, sent_by) VALUES ($1,$2,$3,$4,$5)")
        .bind(to)
        .bind(subject)
        .bind(status)
        .bind(error)
        .bind(by)
        .execute(&state.db)
        .await;
}

/// 别的模块（管理员通知那条路）往 email_logs 记一笔。`by` 写来源（如 "alarm"），
/// 控制台的「邮件日志」页据此能分出告警和群发——以前告警发没发、发了几封，没有任何地方留痕。
pub(crate) async fn log_send(state: &AppState, to: &str, subject: &str, status: &str, error: Option<&str>, by: &str) {
    log_email(state, to, subject, status, error, by).await;
}

// ---------------------------------------------------------------------------------------
// Unsubscribing
// ---------------------------------------------------------------------------------------

/// The signature on an unsubscribe link.
///
/// Derived rather than stored: an unguessable value keyed to the account already exists in
/// the signing secret, so a token table would be a second thing to keep and expire for no
/// gain. Truncated to 16 bytes — this guards against someone unsubscribing a stranger, not
/// against forging a session, and a full-length tag in a URL is just noise.
/// Takes the secret rather than the whole `Config` so the rule can be tested without
/// standing up every unrelated setting the service happens to carry.
fn unsub_token(secret: &str, user_id: uuid::Uuid) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    // Domain-separated: the same secret signs session tokens, and a tag minted here must
    // never be meaningful anywhere else.
    mac.update(b"unsubscribe:");
    mac.update(user_id.as_bytes());
    let tag = mac.finalize().into_bytes();
    tag.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn unsub_link(cfg: &Config, user_id: uuid::Uuid) -> String {
    format!(
        "{}/api/unsubscribe?u={}&t={}",
        cfg.public_base.trim_end_matches('/'),
        user_id,
        unsub_token(&cfg.jwt_secret, user_id)
    )
}

/// Every broadcast carries a way out of the next one.
///
/// Appended by the sender rather than typed by the author, so it cannot be forgotten on the
/// one message that most needed it. Transactional mail does not go through here.
fn with_unsubscribe(body: &str, link: &str, html: bool) -> String {
    if html {
        format!(
            "{body}<hr style=\"margin:32px 0;border:none;border-top:1px solid #e5e5e5\">\
             <p style=\"font:13px sans-serif;color:#777\">\
             You are receiving this because you have a Mr. Day One account. \
             <a href=\"{link}\" style=\"color:#777\">Unsubscribe</a>.</p>"
        )
    } else {
        format!(
            "{body}\n\n—\nYou are receiving this because you have a Mr. Day One account.\n\
             Unsubscribe: {link}\n"
        )
    }
}

#[derive(Deserialize)]
pub struct UnsubQuery {
    u: String,
    t: String,
}

/// `GET /api/unsubscribe?u=<id>&t=<sig>` — public, because it is reached from an email.
///
/// A GET that changes state, which is the one place that is right: mail clients cannot POST,
/// and the alternative is a page with a button that half of recipients never reach. The
/// signature is what keeps it from being an open endpoint for unsubscribing other people.
pub async fn unsubscribe(
    State(state): State<AppState>,
    Query(q): Query<UnsubQuery>,
) -> impl IntoResponse {
    let page = |msg: &str| {
        Html(format!(
            "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">\
             <title>Mr. Day One</title>\
             <div style=\"font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;color:#18181b\">\
             <p style=\"font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#71717a\">Mr. Day One</p>\
             <p>{msg}</p></div>"
        ))
    };

    let Ok(id) = uuid::Uuid::parse_str(q.u.trim()) else {
        return page("That link is not valid.");
    };
    // Constant-time-ish by construction: both sides are fixed-length hex of the same
    // length, and a mismatch reveals only that the tag was wrong.
    if unsub_token(&state.cfg.jwt_secret, id) != q.t.trim().to_ascii_lowercase() {
        return page("That link is not valid.");
    }

    let done = sqlx::query("UPDATE users SET email_opt_out = true, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await;

    match done {
        Ok(r) if r.rows_affected() > 0 => page(
            "You have been unsubscribed from announcements. \
             You will still receive sign-in codes and receipts, because those answer \
             something you asked for.",
        ),
        _ => page("We could not find that account."),
    }
}

// ---------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------

/// Who a campaign goes to.
///
/// `Members` is "has a plan that has not run out" rather than "has ever paid": a lapsed
/// account is a different audience with a different message, and conflating the two is how
/// a renewal reminder ends up in the inbox of someone who already renewed.
enum Segment {
    All,
    Members,
    Plan(String),
    One(String),
}

impl Segment {
    fn parse(target: &str, plan: Option<&str>, email: Option<&str>) -> ApiResult<Self> {
        match target {
            "all" => Ok(Segment::All),
            "members" => Ok(Segment::Members),
            "plan" => {
                let p = plan.unwrap_or("").trim();
                if p.is_empty() {
                    return Err(AppError::bad("请选择套餐"));
                }
                Ok(Segment::Plan(p.to_string()))
            }
            "one" => {
                let e = email.unwrap_or("").trim();
                if !e.contains('@') || e.len() < 3 {
                    return Err(AppError::bad("请填写有效的收件邮箱"));
                }
                Ok(Segment::One(e.to_string()))
            }
            _ => Err(AppError::bad("收件人范围只能是 all/members/plan/one")),
        }
    }

    fn key(&self) -> &'static str {
        match self {
            Segment::All => "all",
            Segment::Members => "members",
            Segment::Plan(_) => "plan",
            Segment::One(_) => "one",
        }
    }

    /// A test to a single address is not a broadcast: it goes to whoever the operator
    /// typed, opt-out and all, because the address they type is usually their own.
    fn is_broadcast(&self) -> bool {
        !matches!(self, Segment::One(_))
    }
}

/// One recipient: the id is needed to sign their unsubscribe link.
type Recipient = (uuid::Uuid, String);

/// Everyone a segment resolves to, right now.
///
/// No LIMIT. The old version capped at 2000 and said nothing, so an operator with more
/// customers than that would have seen "sent" and been wrong about who received it. If the
/// list is ever genuinely too big to hold, that is a reason to page through it, not to
/// silently drop the tail.
async fn resolve(state: &AppState, seg: &Segment) -> ApiResult<Vec<Recipient>> {
    let rows: Vec<Recipient> = match seg {
        Segment::One(email) => {
            // Looked up so a test send still gets a working unsubscribe link when the
            // address belongs to a real account; an address that does not is still sent to.
            let found: Option<Recipient> =
                sqlx::query_as("SELECT id, email FROM users WHERE lower(email) = lower($1)")
                    .bind(email)
                    .fetch_optional(&state.db)
                    .await?;
            return Ok(vec![found.unwrap_or((uuid::Uuid::nil(), email.clone()))]);
        }
        Segment::All => {
            sqlx::query_as(
                "SELECT id, email FROM users \
                 WHERE NOT email_opt_out AND email <> '' ORDER BY created_at DESC",
            )
            .fetch_all(&state.db)
            .await?
        }
        Segment::Members => {
            sqlx::query_as(
                "SELECT id, email FROM users \
                 WHERE NOT email_opt_out AND email <> '' \
                   AND plan <> 'none' \
                   AND (plan_expires_at IS NULL OR plan_expires_at > now()) \
                 ORDER BY created_at DESC",
            )
            .fetch_all(&state.db)
            .await?
        }
        Segment::Plan(plan) => {
            sqlx::query_as(
                "SELECT id, email FROM users \
                 WHERE NOT email_opt_out AND email <> '' AND plan = $1 \
                 ORDER BY created_at DESC",
            )
            .bind(plan)
            .fetch_all(&state.db)
            .await?
        }
    };
    Ok(rows)
}

#[derive(Deserialize)]
pub struct AudienceReq {
    pub target: String,
    pub plan: Option<String>,
    pub email: Option<String>,
}

/// `POST /api/admin/email/audience` — how many people a segment currently reaches.
///
/// Its own endpoint so the console can show a number before anything is sent. "Send to
/// everyone" is a very different decision at 12 recipients and at 12,000, and an operator
/// should not have to find out which one it was afterwards.
pub async fn audience(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<AudienceReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let seg = Segment::parse(&req.target, req.plan.as_deref(), req.email.as_deref())?;
    let people = resolve(&state, &seg).await?;

    // Reported alongside the count so "why is this smaller than my customer list" has an
    // answer on the screen rather than in the schema.
    let opted_out: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email_opt_out")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    Ok(Json(json!({
        "count": people.len(),
        "opted_out": opted_out,
        "mail_configured": state.cfg.mail_enabled(),
    })))
}

#[derive(Deserialize)]
pub struct SendReq {
    pub target: String,
    pub plan: Option<String>,
    pub email: Option<String>,
    pub subject: String,
    pub body: String,
    pub html: Option<bool>,
}

/// `POST /api/admin/email/send` — start a campaign.
///
/// Returns as soon as the row exists. The response is a receipt for work that has begun,
/// not a report that it finished, and the console polls the campaign for the rest.
pub async fn send(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<SendReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    if req.subject.trim().is_empty() || req.body.trim().is_empty() {
        return Err(AppError::bad("主题和内容不能为空"));
    }
    let seg = Segment::parse(&req.target, req.plan.as_deref(), req.email.as_deref())?;
    let people = resolve(&state, &seg).await?;
    if people.is_empty() {
        return Err(AppError::bad("没有匹配的收件人"));
    }

    let html = req.html.unwrap_or(false);
    let dev = !state.cfg.mail_enabled();
    let status = if dev { "dev" } else { "running" };

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO email_campaigns (segment, plan, subject, body, html, total, status, created_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    )
    .bind(seg.key())
    .bind(req.plan.clone().unwrap_or_default())
    .bind(&req.subject)
    .bind(&req.body)
    .bind(html)
    .bind(people.len() as i32)
    .bind(status)
    .bind(&claims.email)
    .fetch_one(&state.db)
    .await?;

    crate::realtime::record_event(
        &state,
        None,
        "notify",
        json!({ "by": claims.email, "segment": seg.key(), "total": people.len(), "campaign": id }),
    )
    .await;

    let total = people.len();
    let broadcast = seg.is_broadcast();
    let worker = state.clone();
    let subject = req.subject.clone();
    let body = req.body.clone();
    let by = claims.email.clone();
    tokio::spawn(async move {
        run_campaign(worker, id, people, subject, body, html, broadcast, by).await;
    });

    Ok(Json(json!({
        "id": id,
        "total": total,
        // Surfaced rather than swallowed: with no provider configured nothing is sent, and
        // the console says so instead of showing a campaign that appears to have worked.
        "dev": dev,
    })))
}

/// The send loop, off the request.
#[allow(clippy::too_many_arguments)]
async fn run_campaign(
    state: AppState,
    id: i64,
    people: Vec<Recipient>,
    subject: String,
    body: String,
    html: bool,
    broadcast: bool,
    by: String,
) {
    let dev = !state.cfg.mail_enabled();
    let mut sent = 0i32;
    let mut failed = 0i32;

    for (i, (user_id, to)) in people.iter().enumerate() {
        if dev {
            log_email(&state, to, &subject, "dev", Some("邮件服务未配置"), &by).await;
        } else {
            // A nil id means the address has no account behind it — a hand-typed test —
            // so there is nothing to sign an unsubscribe link with and none is added.
            let payload = if broadcast && !user_id.is_nil() {
                with_unsubscribe(&body, &unsub_link(&state.cfg, *user_id), html)
            } else {
                body.clone()
            };
            match send_mail(&state.cfg, to, &subject, &payload, html).await {
                Ok(()) => {
                    sent += 1;
                    log_email(&state, to, &subject, "sent", None, &by).await;
                }
                Err(e) => {
                    failed += 1;
                    log_email(&state, to, &subject, "failed", Some(e.msg.as_str()), &by).await;
                }
            }
            tokio::time::sleep(SEND_GAP).await;
        }

        // Written every ten so the console has something to show on a long run, without a
        // round trip to the database for each recipient.
        if i % 10 == 9 {
            let _ = sqlx::query("UPDATE email_campaigns SET sent = $2, failed = $3 WHERE id = $1")
                .bind(id)
                .bind(sent)
                .bind(failed)
                .execute(&state.db)
                .await;
        }
    }

    let _ = sqlx::query(
        "UPDATE email_campaigns \
         SET sent = $2, failed = $3, status = $4, finished_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(sent)
    .bind(failed)
    .bind(if dev { "dev" } else { "done" })
    .execute(&state.db)
    .await;
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Campaign {
    pub id: i64,
    pub segment: String,
    pub plan: String,
    pub subject: String,
    pub html: bool,
    pub total: i32,
    pub sent: i32,
    pub failed: i32,
    pub status: String,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// `GET /api/admin/email/campaigns` — what has been sent, and what is being sent now.
///
/// The body is deliberately not selected: the list is a status board, and a hundred rows
/// each carrying a full message makes it a slow one.
pub async fn campaigns(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<Vec<Campaign>>> {
    admin_only(&claims)?;
    let rows = sqlx::query_as::<_, Campaign>(
        "SELECT id, segment, plan, subject, html, total, sent, failed, status, created_by, \
                created_at, finished_at \
         FROM email_campaigns ORDER BY id DESC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct EmailLog {
    pub id: i64,
    pub to_email: String,
    pub subject: String,
    pub status: String,
    pub error: Option<String>,
    pub sent_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/admin/email-logs — recent outbound mail (admin only).
pub async fn logs(State(state): State<AppState>, claims: Claims) -> ApiResult<Json<Vec<EmailLog>>> {
    admin_only(&claims)?;
    let rows = sqlx::query_as::<_, EmailLog>("SELECT * FROM email_logs ORDER BY id DESC LIMIT 300")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_refuses_what_it_cannot_act_on() {
        assert!(Segment::parse("all", None, None).is_ok());
        assert!(Segment::parse("members", None, None).is_ok());
        // A tier send with no tier would quietly resolve to nobody.
        assert!(Segment::parse("plan", None, None).is_err());
        assert!(Segment::parse("plan", Some("  "), None).is_err());
        assert!(Segment::parse("plan", Some("pro"), None).is_ok());
        // A single send with no usable address.
        assert!(Segment::parse("one", None, None).is_err());
        assert!(Segment::parse("one", None, Some("not-an-address")).is_err());
        assert!(Segment::parse("one", None, Some("a@b.co")).is_ok());
        // Anything invented.
        assert!(Segment::parse("everyone", None, None).is_err());
        assert!(Segment::parse("", None, None).is_err());
    }

    /// Opt-out is a promise. It applies to every broadcast segment and to none of the
    /// transactional path — a login code must still arrive.
    #[test]
    fn every_broadcast_honours_opt_out() {
        let src = include_str!("email.rs");
        let resolve = src.split("async fn resolve").nth(1).expect("resolve");
        let resolve = &resolve[..resolve.find("\n#[derive").unwrap_or(resolve.len())];
        // Three broadcast branches, each filtered.
        assert_eq!(
            resolve.matches("NOT email_opt_out").count(),
            3,
            "all / members / plan must each exclude people who unsubscribed"
        );

        let send_mail = src.split("pub async fn send_mail").nth(1).expect("send_mail");
        let send_mail = &send_mail[..send_mail.find("\nasync fn log_email").unwrap_or(200)];
        assert!(
            !send_mail.contains("email_opt_out"),
            "a verification code must not be suppressed by a marketing preference"
        );
    }

    /// The tail of a recipient list is the part nobody notices is missing.
    #[test]
    fn a_broadcast_is_never_silently_truncated() {
        let src = include_str!("email.rs");
        let resolve = src.split("async fn resolve").nth(1).expect("resolve");
        let resolve = &resolve[..resolve.find("\n#[derive").unwrap_or(resolve.len())];
        assert!(
            !resolve.to_uppercase().contains("LIMIT "),
            "capping the audience without saying so reports a send that did not happen"
        );
    }

    /// Whoever holds a link must not be able to unsubscribe somebody else.
    #[test]
    fn an_unsubscribe_link_is_signed_per_account() {
        let a = uuid::Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let b = uuid::Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();

        // Holding your own link must not let you unsubscribe anyone else.
        assert_ne!(unsub_token("secret-a", a), unsub_token("secret-a", b));
        // Stable, or the link in an email stops working the moment it is sent.
        assert_eq!(unsub_token("secret-a", a), unsub_token("secret-a", a));
        assert_eq!(unsub_token("secret-a", a).len(), 32); // 16 bytes as hex
        // Rotating the signing secret invalidates every outstanding link, which is what
        // rotating it is for.
        assert_ne!(unsub_token("secret-a", a), unsub_token("secret-b", a));
    }

    /// Plain text through the Worker must arrive as HTML that still reads as the text it was,
    /// under the Worker's own field names.
    #[test]
    fn worker_payload_uses_the_workers_field_names_and_escapes_text() {
        let p = worker_notify_payload("a@b.co", "Hi <you>", "line 1\nline 2 & <b>", false);
        assert_eq!(p["to"], "a@b.co");
        assert_eq!(p["title"], "Hi <you>");
        let content = p["content"].as_str().unwrap();
        assert!(content.contains("line 1<br>line 2 &amp; &lt;b&gt;"), "{content}");
        assert!(p.get("ctaUrl").is_none(), "no call-to-action unless someone asks for one");
        // HTML bodies (the login code template) pass through untouched.
        let h = worker_notify_payload("a@b.co", "s", "<p>x</p>", true);
        assert_eq!(h["content"], "<p>x</p>");
    }

    /// The Worker is the preferred transport and Brevo the fallback — in that order, and the
    /// fallback only when Brevo is actually configured (otherwise a Worker failure is the answer).
    #[test]
    fn send_mail_prefers_the_worker_and_falls_back_to_brevo() {
        let src = include_str!("email.rs");
        let f = src.split("pub async fn send_mail").nth(1).expect("send_mail");
        let f = &f[..f.find("\nasync fn log_email").expect("log_email follows send_mail")];
        let worker = f.find("worker_enabled()").expect("send_mail must ask for the Worker first");
        let brevo = f.find("send_via_brevo(").expect("send_mail must be able to fall back to Brevo");
        assert!(worker < brevo, "the Worker is preferred; Brevo is the fallback");
        assert!(f.contains("brevo_enabled()"), "the fallback must be gated on Brevo being configured");
    }

    #[test]
    fn a_broadcast_always_carries_a_way_out() {
        let text = with_unsubscribe("Hello.", "https://x.test/u", false);
        assert!(text.contains("https://x.test/u"));
        assert!(text.starts_with("Hello."));

        let html = with_unsubscribe("<p>Hello.</p>", "https://x.test/u", true);
        assert!(html.contains("href=\"https://x.test/u\""));
        assert!(html.starts_with("<p>Hello.</p>"));
    }
}
