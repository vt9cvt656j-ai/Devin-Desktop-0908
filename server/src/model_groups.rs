//! 模型分组（计划 §3.2 / M1）。
//!
//! 和 `models.group_into` 不是一回事：那个只改 IDE 选择器的显示名。这里是真正可管理的
//! 分组——品牌锁图标、筛选字段收窄可拉模型、出口挂在组下、删除前先数路由。

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Claims;
use crate::error::{ApiResult, AppError};
use crate::AppState;

const MAX_NAME: usize = 80;
const MAX_FILTER: usize = 32;
const MAX_FILTER_CHARS: usize = 40;

/// 对齐 `route_endpoints::vendor_of` / 前端 VendorMark。未知品牌会画成空白。
const BRANDS: [&str; 10] = [
    "claude", "gpt", "deepseek", "gemini", "minimax", "glm", "grok", "qwen", "kimi", "other",
];

fn admin_only(claims: &Claims) -> ApiResult<()> {
    if claims.role != "admin" {
        return Err(AppError::forbidden("需要管理员权限"));
    }
    Ok(())
}

fn clean(raw: &str, max: usize) -> String {
    raw.trim().chars().take(max).collect()
}

fn brand_of(raw: &str) -> ApiResult<String> {
    let b = raw.trim().to_ascii_lowercase();
    if BRANDS.contains(&b.as_str()) {
        Ok(b)
    } else {
        Err(AppError::bad("品牌只能是 claude/gpt/deepseek/gemini/minimax/glm/grok/qwen/kimi/other"))
    }
}

fn filters_of(raw: Option<Vec<String>>) -> Vec<String> {
    let mut out: Vec<String> = raw
        .unwrap_or_default()
        .into_iter()
        .map(|s| clean(&s, MAX_FILTER_CHARS))
        .filter(|s| !s.is_empty())
        .take(MAX_FILTER)
        .collect();
    out.sort();
    out.dedup();
    out
}

fn map_write_error(error: sqlx::Error) -> AppError {
    if error
        .as_database_error()
        .and_then(|e| e.code())
        .as_deref()
        == Some("23505")
    {
        AppError::bad("分组名称已存在")
    } else {
        error.into()
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModelGroup {
    pub id: uuid::Uuid,
    pub seq: i32,
    pub name: String,
    pub brand: String,
    pub active: bool,
    pub filter_fields: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    /// 该分组下有多少出口。列表用，删除护栏也用同一口径。
    #[sqlx(default)]
    pub route_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct GroupReq {
    pub name: String,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub filter_fields: Option<Vec<String>>,
    #[serde(default)]
    pub seq: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderReq {
    pub ids: Vec<uuid::Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct MoveReq {
    /// -1 = 上移，+1 = 下移。
    pub dir: i32,
}

/// GET /api/admin/model-groups
pub async fn admin_list(
    State(state): State<AppState>,
    claims: Claims,
) -> ApiResult<Json<Vec<ModelGroup>>> {
    admin_only(&claims)?;
    let rows = sqlx::query_as::<_, ModelGroup>(
        "SELECT g.*, \
                (SELECT count(*) FROM route_endpoints e WHERE e.group_id = g.id)::bigint AS route_count \
         FROM model_groups g \
         ORDER BY g.seq, g.created_at",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// POST /api/admin/model-groups
pub async fn admin_create(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<GroupReq>,
) -> ApiResult<Json<ModelGroup>> {
    admin_only(&claims)?;
    let name = clean(&req.name, MAX_NAME);
    if name.is_empty() {
        return Err(AppError::bad("请填写分组名称"));
    }
    let brand = brand_of(req.brand.as_deref().unwrap_or("other"))?;
    let active = req.active.unwrap_or(true);
    let filters = filters_of(req.filter_fields);
    let seq = match req.seq {
        Some(s) => s,
        None => sqlx::query_scalar::<_, i32>(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM model_groups",
        )
        .fetch_one(&state.db)
        .await
        .unwrap_or(0),
    };
    let row = sqlx::query_as::<_, ModelGroup>(
        "INSERT INTO model_groups (seq, name, brand, active, filter_fields) \
         VALUES ($1,$2,$3,$4,$5) \
         RETURNING *, 0::bigint AS route_count",
    )
    .bind(seq)
    .bind(&name)
    .bind(&brand)
    .bind(active)
    .bind(&filters)
    .fetch_one(&state.db)
    .await
    .map_err(map_write_error)?;
    Ok(Json(row))
}

/// POST /api/admin/model-groups/:id
pub async fn admin_update(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<GroupReq>,
) -> ApiResult<Json<ModelGroup>> {
    admin_only(&claims)?;
    let name = clean(&req.name, MAX_NAME);
    if name.is_empty() {
        return Err(AppError::bad("请填写分组名称"));
    }
    let brand = brand_of(req.brand.as_deref().unwrap_or("other"))?;
    let active = req.active.unwrap_or(true);
    let filters = filters_of(req.filter_fields);
    let row = sqlx::query_as::<_, ModelGroup>(
        "UPDATE model_groups SET name = $2, brand = $3, active = $4, filter_fields = $5, \
                seq = COALESCE($6, seq), updated_at = now() \
         WHERE id = $1 \
         RETURNING *, \
           (SELECT count(*) FROM route_endpoints e WHERE e.group_id = model_groups.id)::bigint AS route_count",
    )
    .bind(id)
    .bind(&name)
    .bind(&brand)
    .bind(active)
    .bind(&filters)
    .bind(req.seq)
    .fetch_optional(&state.db)
    .await
    .map_err(map_write_error)?
    .ok_or_else(|| AppError::bad("分组不存在"))?;
    Ok(Json(row))
}

/// DELETE /api/admin/model-groups/:id
///
/// 分组下还有路由 → 400「请先删除该分组下的所有路由」。FK 是 ON DELETE SET NULL，
/// 这道闸在应用层，避免出口被静默摘组。
pub async fn admin_delete(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM route_endpoints WHERE group_id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    if n > 0 {
        return Err(AppError::bad("请先删除该分组下的所有路由"));
    }
    let done = sqlx::query("DELETE FROM model_groups WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::bad("分组不存在"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/admin/model-groups/reorder
pub async fn admin_reorder(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<ReorderReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    if req.ids.is_empty() {
        return Err(AppError::bad("排序列表不能为空"));
    }
    let mut tx = state.db.begin().await?;
    for (i, id) in req.ids.iter().enumerate() {
        sqlx::query("UPDATE model_groups SET seq = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/admin/model-groups/:id/move
pub async fn admin_move(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<MoveReq>,
) -> ApiResult<Json<serde_json::Value>> {
    admin_only(&claims)?;
    if req.dir != 1 && req.dir != -1 {
        return Err(AppError::bad("dir 只能是 -1 或 1"));
    }
    let rows: Vec<(uuid::Uuid, i32)> = sqlx::query_as(
        "SELECT id, seq FROM model_groups ORDER BY seq, created_at",
    )
    .fetch_all(&state.db)
    .await?;
    let pos = rows
        .iter()
        .position(|(row_id, _)| *row_id == id)
        .ok_or_else(|| AppError::bad("分组不存在"))?;
    let other = pos as i32 + req.dir;
    if other < 0 || other as usize >= rows.len() {
        return Ok(Json(json!({ "ok": true, "moved": false })));
    }
    let a = rows[pos];
    let b = rows[other as usize];
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE model_groups SET seq = $2, updated_at = now() WHERE id = $1")
        .bind(a.0)
        .bind(b.1)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE model_groups SET seq = $2, updated_at = now() WHERE id = $1")
        .bind(b.0)
        .bind(a.1)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "moved": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brands_are_the_vendor_mark_set() {
        assert_eq!(
            BRANDS,
            ["claude", "gpt", "deepseek", "gemini", "minimax", "glm", "grok", "qwen", "kimi", "other"]
        );
        assert!(brand_of("Claude").is_ok());
        assert!(brand_of("nope").is_err());
    }

    #[test]
    fn delete_counts_endpoints_before_touching_the_row() {
        let src = include_str!("model_groups.rs");
        let body = src
            .split("pub async fn admin_delete(")
            .nth(1)
            .expect("admin_delete");
        let head = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert!(
            head.contains("SELECT count(*) FROM route_endpoints WHERE group_id"),
            "删分组没先数路由"
        );
        assert!(
            head.contains("请先删除该分组下的所有路由"),
            "护栏文案必须是文档原话，前端弹窗靠它"
        );
        assert!(
            head.find("SELECT count(*)").unwrap() < head.find("DELETE FROM model_groups").unwrap(),
            "必须先数再删，不然护栏是空的"
        );
    }

    #[test]
    fn every_write_path_is_admin_gated() {
        let src = include_str!("model_groups.rs");
        for handler in [
            "pub async fn admin_create(",
            "pub async fn admin_update(",
            "pub async fn admin_delete(",
            "pub async fn admin_list(",
            "pub async fn admin_reorder(",
            "pub async fn admin_move(",
        ] {
            let body = src.split(handler).nth(1).expect(handler);
            let head = &body[..body.find("\n}").unwrap_or(body.len())];
            assert!(
                head.contains("admin_only(&claims)?"),
                "{handler} 没查管理员"
            );
        }
    }
}
