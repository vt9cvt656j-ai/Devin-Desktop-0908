//! 线路号池（计划 §2-M6 / §9-A A1 / Phase 2）。
//!
//! 一条线路（`models` 行 = 站点 + 协议）下面多把 key。备注随 key，
//! 同一线路下非空备注唯一、同一把 key 只留一份。列表从不回明文。
//!
//! 旧派单仍读 `models.api_key`：写入号池后把第一把仍启用的 key 回写过去，
//! 折叠在这里做，不改派单热路径。

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::models::MODEL_KEY_CTX;
use crate::route_endpoints::key_fingerprint;
use crate::AppState;

const MAX_LABEL: usize = 80;

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

fn clean_label(raw: &str) -> String {
    raw.trim().chars().take(MAX_LABEL).collect()
}

fn mask_key(plain: &str) -> String {
    let t = plain.trim();
    if t.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= 8 {
        let head: String = chars.iter().take(2).collect();
        return format!("{head}****");
    }
    let head: String = chars.iter().take(3).collect();
    let tail: String = chars.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}******{tail}")
}

fn map_write_error(error: sqlx::Error) -> AppError {
    if error
        .as_database_error()
        .and_then(|e| e.code())
        .as_deref()
        == Some("23505")
    {
        let constraint = error
            .as_database_error()
            .and_then(|e| e.constraint())
            .unwrap_or("");
        if constraint.contains("label") {
            AppError::bad("同一线路下备注不能重复")
        } else {
            AppError::bad("同一线路下已有这把密钥")
        }
    } else {
        error.into()
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct CredRow {
    id: uuid::Uuid,
    route_id: uuid::Uuid,
    label: String,
    api_key_enc: String,
    api_key_fp: Option<String>,
    active: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct Credential {
    pub id: uuid::Uuid,
    pub route_id: uuid::Uuid,
    pub label: String,
    pub api_key_fp: Option<String>,
    pub api_key_masked: String,
    pub active: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl Credential {
    fn from_row(row: CredRow) -> Self {
        let plain = crate::field_crypto::decrypt(&row.api_key_enc, MODEL_KEY_CTX).unwrap_or_default();
        Self {
            id: row.id,
            route_id: row.route_id,
            label: row.label,
            api_key_fp: row.api_key_fp,
            api_key_masked: mask_key(&plain),
            active: row.active,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CredReq {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AffectedRoute {
    pub group: String,
    pub route_label: String,
}

#[derive(Debug, Serialize)]
pub struct LineImpact {
    pub routes: i64,
    pub endpoints: i64,
    pub affected: Vec<AffectedRoute>,
    pub total: i64,
}

/// 停用/删除护栏共用：X 个路由、Y 个出口、明细前 5 条。
/// 路由 = `route_endpoints` 行；出口优先数 `endpoint_model_prices`，表空则与路由同数。
pub async fn line_impact(
    db: &sqlx::PgPool,
    route_id: uuid::Uuid,
) -> Result<LineImpact, sqlx::Error> {
    let routes: i64 = sqlx::query_scalar("SELECT count(*) FROM route_endpoints WHERE route_id = $1")
        .bind(route_id)
        .fetch_one(db)
        .await?;
    let endpoints: i64 = match sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM endpoint_model_prices p \
         JOIN route_endpoints e ON e.id = p.endpoint_id \
         WHERE e.route_id = $1",
    )
    .bind(route_id)
    .fetch_one(db)
    .await
    {
        Ok(n) => n,
        Err(_) => routes,
    };
    let affected: Vec<AffectedRoute> = sqlx::query_as(
        "SELECT COALESCE(g.name, '') AS \"group\", \
                COALESCE(NULLIF(TRIM(m.label), ''), '') AS route_label \
         FROM route_endpoints e \
         LEFT JOIN model_groups g ON g.id = e.group_id \
         LEFT JOIN models m ON m.id = e.route_id \
         WHERE e.route_id = $1 \
         ORDER BY g.seq NULLS LAST, e.id \
         LIMIT 5",
    )
    .bind(route_id)
    .fetch_all(db)
    .await?;
    Ok(LineImpact {
        routes,
        endpoints,
        total: routes,
        affected,
    })
}

async fn require_route(db: &sqlx::PgPool, route_id: uuid::Uuid) -> ApiResult<()> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM models WHERE id = $1")
        .bind(route_id)
        .fetch_one(db)
        .await?;
    if n == 0 {
        return Err(AppError::bad("线路不存在"));
    }
    Ok(())
}

async fn backfill_fps(db: &sqlx::PgPool, route_id: uuid::Uuid) -> Result<(), sqlx::Error> {
    let rows: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, api_key_enc FROM route_credentials \
         WHERE route_id = $1 AND (api_key_fp IS NULL OR api_key_fp = '')",
    )
    .bind(route_id)
    .fetch_all(db)
    .await?;
    for (id, enc) in rows {
        let plain = crate::field_crypto::decrypt(&enc, MODEL_KEY_CTX).unwrap_or_default();
        let fp = key_fingerprint(&plain);
        if fp.is_empty() {
            continue;
        }
        let _ = sqlx::query("UPDATE route_credentials SET api_key_fp = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(&fp)
            .execute(db)
            .await;
    }
    Ok(())
}

/// 把号池里第一把仍启用的 key 回写 `models.api_key`，旧派单继续能读到。
pub async fn sync_primary_key(
    db: &sqlx::PgPool,
    route_id: uuid::Uuid,
) -> Result<(), sqlx::Error> {
    let enc: Option<String> = sqlx::query_scalar(
        "SELECT api_key_enc FROM route_credentials \
         WHERE route_id = $1 AND active = true \
         ORDER BY created_at, id LIMIT 1",
    )
    .bind(route_id)
    .fetch_optional(db)
    .await?;
    if let Some(enc) = enc {
        sqlx::query("UPDATE models SET api_key = $2, updated_at = now() WHERE id = $1")
            .bind(route_id)
            .bind(&enc)
            .execute(db)
            .await?;
    }
    Ok(())
}

/// 线路刚创建/改 key 时，保证号池里有对应的一把（按指纹 upsert）。
pub async fn upsert_from_model(
    db: &sqlx::PgPool,
    route_id: uuid::Uuid,
    label: &str,
    api_key_plain: &str,
    active: bool,
) -> Result<(), sqlx::Error> {
    let plain = api_key_plain.trim();
    if plain.is_empty() {
        return Ok(());
    }
    let fp = key_fingerprint(plain);
    let enc = crate::field_crypto::encrypt(plain, MODEL_KEY_CTX);
    let label = clean_label(label);
    sqlx::query(
        "INSERT INTO route_credentials (route_id, label, api_key_enc, api_key_fp, active) \
         VALUES ($1,$2,$3,$4,$5) \
         ON CONFLICT (route_id, api_key_fp) WHERE api_key_fp IS NOT NULL AND api_key_fp <> '' \
         DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, active = EXCLUDED.active, \
                       label = CASE WHEN route_credentials.label = '' THEN EXCLUDED.label \
                                    ELSE route_credentials.label END, \
                       updated_at = now()",
    )
    .bind(route_id)
    .bind(&label)
    .bind(&enc)
    .bind(&fp)
    .bind(active)
    .execute(db)
    .await?;
    Ok(())
}

/// GET /api/admin/models/:id/credentials
pub async fn admin_list(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<Vec<Credential>>> {
    admin_only(&claims)?;
    require_route(&state.db, id).await?;
    let _ = backfill_fps(&state.db, id).await;
    let rows: Vec<CredRow> = sqlx::query_as(
        "SELECT id, route_id, label, api_key_enc, api_key_fp, active, created_at, updated_at \
         FROM route_credentials WHERE route_id = $1 ORDER BY created_at, id",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Credential::from_row).collect()))
}

/// POST /api/admin/models/:id/credentials
pub async fn admin_create(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<CredReq>,
) -> ApiResult<Json<Credential>> {
    admin_only(&claims)?;
    require_route(&state.db, id).await?;
    let plain = req.api_key.as_deref().unwrap_or("").trim().to_string();
    if plain.is_empty() {
        return Err(AppError::bad("请填写 API Key"));
    }
    let label = clean_label(req.label.as_deref().unwrap_or(""));
    let active = req.active.unwrap_or(true);
    let fp = key_fingerprint(&plain);
    let enc = crate::field_crypto::encrypt(&plain, MODEL_KEY_CTX);
    let row: CredRow = sqlx::query_as(
        "INSERT INTO route_credentials (route_id, label, api_key_enc, api_key_fp, active) \
         VALUES ($1,$2,$3,$4,$5) \
         RETURNING id, route_id, label, api_key_enc, api_key_fp, active, created_at, updated_at",
    )
    .bind(id)
    .bind(&label)
    .bind(&enc)
    .bind(&fp)
    .bind(active)
    .fetch_one(&state.db)
    .await
    .map_err(map_write_error)?;
    let _ = sync_primary_key(&state.db, id).await;
    Ok(Json(Credential::from_row(row)))
}

/// POST /api/admin/models/:id/credentials/:cid
pub async fn admin_update(
    State(state): State<AppState>,
    claims: Claims,
    Path((id, cid)): Path<(uuid::Uuid, uuid::Uuid)>,
    Json(req): Json<CredReq>,
) -> ApiResult<Json<Credential>> {
    admin_only(&claims)?;
    require_route(&state.db, id).await?;
    let cur: CredRow = sqlx::query_as(
        "SELECT id, route_id, label, api_key_enc, api_key_fp, active, created_at, updated_at \
         FROM route_credentials WHERE id = $1 AND route_id = $2",
    )
    .bind(cid)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::bad("号池成员不存在"))?;
    let label = req
        .label
        .as_deref()
        .map(clean_label)
        .unwrap_or(cur.label);
    let (enc, fp) = match req.api_key.as_deref().map(str::trim) {
        Some(plain) if !plain.is_empty() => {
            (
                crate::field_crypto::encrypt(plain, MODEL_KEY_CTX),
                Some(key_fingerprint(plain)),
            )
        }
        _ => (cur.api_key_enc, cur.api_key_fp),
    };
    let active = req.active.unwrap_or(cur.active);
    let row: CredRow = sqlx::query_as(
        "UPDATE route_credentials SET label = $3, api_key_enc = $4, api_key_fp = $5, \
                active = $6, updated_at = now() \
         WHERE id = $1 AND route_id = $2 \
         RETURNING id, route_id, label, api_key_enc, api_key_fp, active, created_at, updated_at",
    )
    .bind(cid)
    .bind(id)
    .bind(&label)
    .bind(&enc)
    .bind(&fp)
    .bind(active)
    .fetch_optional(&state.db)
    .await
    .map_err(map_write_error)?
    .ok_or_else(|| AppError::bad("号池成员不存在"))?;
    let _ = sync_primary_key(&state.db, id).await;
    Ok(Json(Credential::from_row(row)))
}

/// DELETE /api/admin/models/:id/credentials/:cid
pub async fn admin_delete(
    State(state): State<AppState>,
    claims: Claims,
    Path((id, cid)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    require_route(&state.db, id).await?;
    let done = sqlx::query("DELETE FROM route_credentials WHERE id = $1 AND route_id = $2")
        .bind(cid)
        .bind(id)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::bad("号池成员不存在"));
    }
    let _ = sync_primary_key(&state.db, id).await;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_never_echoes_plain() {
        let m = mask_key("sk-abcdefghijklmnopqrstuvwxyz");
        assert!(!m.contains("abcdefgh"));
        assert!(m.contains("******"));
        assert!(m.starts_with("sk-"));
    }

    #[test]
    fn every_write_path_is_admin_gated() {
        let src = include_str!("route_credentials.rs");
        for handler in [
            "pub async fn admin_create(",
            "pub async fn admin_update(",
            "pub async fn admin_delete(",
            "pub async fn admin_list(",
        ] {
            let body = src.split(handler).nth(1).expect(handler);
            let head = &body[..body.find("\n}").unwrap_or(body.len())];
            assert!(
                head.contains("admin_only(&claims)?"),
                "{handler} 没查管理员"
            );
        }
    }

    #[test]
    fn list_response_has_no_enc_field() {
        let src = include_str!("route_credentials.rs");
        let cred = src.split("pub struct Credential {").nth(1).expect("Credential");
        let head = &cred[..cred.find("}").unwrap_or(cred.len())];
        assert!(!head.contains("api_key_enc"), "对外结构不能带密文列");
        assert!(head.contains("api_key_masked"), "必须脱敏");
    }
}
