use serde::Serialize;
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

// Chat history is local-first. The snapshot is only compact prompt/session state;
// exact transcript records are append-only, per-session events grouped into small
// segments. This keeps a long chat from rewriting its entire lifetime on every turn.
static POOL: LazyLock<Mutex<Option<SqlitePool>>> = LazyLock::new(|| Mutex::new(None));
const SNAPSHOT_SCOPE: &str = "main";
const HISTORY_REVISIONS: i64 = 3;
const MAX_EVENTS_PER_SEGMENT: i64 = 256;
const MAX_SEGMENT_BYTES: i64 = 4 * 1024 * 1024;
// These are storage and rendering boundaries, not prompt-routing rules. They keep
// a single model response from becoming one giant SQLite cell or one giant DOM node.
const INLINE_EVENT_CONTENT_BYTES: usize = 192 * 1024;
const EVENT_CONTENT_CHUNK_BYTES: usize = 256 * 1024;
const EVENT_CONTENT_PREVIEW_BYTES: usize = 48 * 1024;
const TRANSCRIPT_WINDOW_MAX_EVENTS: i64 = 128;
const TRANSCRIPT_CONTENT_SLICE_MAX_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub revision: i64,
    pub snapshot: Value,
    pub recovered_from_backup: bool,
    /// 这份快照是什么时候写下的（unix 毫秒）。
    ///
    /// 表里一直有 `updated_at`，只是从没返回给前端。而前端恢复时是「SQLite → session.json
    /// → localStorage 依次尝试，谁先有内容用谁」，**不比新旧**。退出路径里只有
    /// `onCloseRequested` 会 await 快照写完；`beforeunload` / `pagehide`（Tauri 直接
    /// destroy webview、强杀、更新重启走的就是这几条）跑不了异步，只来得及同步写
    /// localStorage。于是「旧快照 + 新镜像」时旧的赢，用户看到的就是「没关的会话不见了」。
    /// 把时间戳带出去，前端才有判据去比。
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshotSave {
    pub revision: i64,
    pub unchanged: bool,
    pub bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTranscriptAppend {
    pub session_id: String,
    pub sequence: i64,
    pub segment: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTranscriptLoad {
    pub session_id: String,
    pub length: i64,
    pub messages: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTranscriptWindow {
    pub session_id: String,
    pub start: i64,
    pub end: i64,
    pub total: i64,
    pub messages: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTranscriptContentSlice {
    pub session_id: String,
    pub sequence: i64,
    pub offset: i64,
    pub next_offset: i64,
    pub total_bytes: i64,
    pub complete: bool,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTranscriptTruncate {
    pub session_id: String,
    pub length: i64,
    pub removed: u64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

// FNV-1a is a compact corruption check, not a security primitive.
fn checksum(payload: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in payload.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn checked_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn utf8_boundary_before(value: &str, offset: usize) -> usize {
    let mut index = offset.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn utf8_boundary_after(value: &str, offset: usize) -> usize {
    let mut index = offset.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn utf8_chunks(value: &str, chunk_bytes: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let end = utf8_boundary_before(value, start.saturating_add(chunk_bytes));
        let end = if end <= start {
            utf8_boundary_after(value, start.saturating_add(1))
        } else {
            end
        };
        chunks.push(value[start..end].to_string());
        start = end;
    }
    chunks
}

fn content_preview(value: &str) -> String {
    if value.len() <= EVENT_CONTENT_PREVIEW_BYTES {
        return value.to_string();
    }
    let head_bytes = EVENT_CONTENT_PREVIEW_BYTES / 2;
    let tail_bytes = EVENT_CONTENT_PREVIEW_BYTES - head_bytes;
    let head_end = utf8_boundary_before(value, head_bytes);
    let tail_start = utf8_boundary_after(value, value.len().saturating_sub(tail_bytes));
    format!(
        "{}\n\n[... full local content is chunked; {} UTF-8 bytes total ...]\n\n{}",
        &value[..head_end],
        value.len(),
        &value[tail_start..]
    )
}

struct StoredEvent {
    payload: String,
    checksum: String,
    byte_len: i64,
    large_content: bool,
    content_len: i64,
    content_chunks: Vec<String>,
}

fn seal_field(plaintext: &str, table: &str) -> String {
    if crate::local_crypto::enabled() {
        crate::local_crypto::seal(plaintext, table).unwrap_or_else(|_| plaintext.to_string())
    } else {
        plaintext.to_string()
    }
}

fn open_field(stored: &str, table: &str) -> String {
    crate::local_crypto::open(stored, table).unwrap_or_else(|_| stored.to_string())
}

fn stored_event(message: &Value) -> Result<StoredEvent, String> {
    let original = serde_json::to_string(message)
        .map_err(|error| format!("conversation event serialization failed: {error}"))?;
    let byte_len = checked_i64(original.len());
    let checksum = checksum(&original);
    let Some(content) = message.get("content").and_then(Value::as_str) else {
        return Ok(StoredEvent {
            payload: original,
            checksum,
            byte_len,
            large_content: false,
            content_len: 0,
            content_chunks: Vec::new(),
        });
    };
    if content.len() <= INLINE_EVENT_CONTENT_BYTES {
        return Ok(StoredEvent {
            payload: original,
            checksum,
            byte_len,
            large_content: false,
            content_len: 0,
            content_chunks: Vec::new(),
        });
    }
    let mut compact = message.clone();
    compact["content"] = Value::String(content_preview(content));
    let payload = serde_json::to_string(&compact)
        .map_err(|error| format!("conversation event preview serialization failed: {error}"))?;
    Ok(StoredEvent {
        payload,
        checksum,
        byte_len,
        large_content: true,
        content_len: checked_i64(content.len()),
        content_chunks: utf8_chunks(content, EVENT_CONTENT_CHUNK_BYTES),
    })
}

fn session_id(session: &Value) -> Result<String, String> {
    let id = session
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 160)
        .ok_or_else(|| "conversation session is missing a valid id".to_string())?;
    Ok(id.to_string())
}

fn memory_mut(session: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let object = session
        .as_object_mut()
        .ok_or_else(|| "conversation session must be an object".to_string())?;
    let memory = object
        .entry("memory")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    memory
        .as_object_mut()
        .ok_or_else(|| "conversation memory must be an object".to_string())
}

fn transcript(session: &Value) -> Vec<Value> {
    session
        .get("memory")
        .and_then(|memory| memory.get("transcript"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let mut guard = POOL.lock().await;
    if let Some(pool) = guard.as_ref() {
        return Ok(pool.clone());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("conversation storage directory unavailable: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create conversation storage directory: {error}"))?;
    let database = dir.join("conversations.sqlite3");
    let url = format!("sqlite://{}?mode=rwc", database.to_string_lossy());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .map_err(|error| format!("conversation database open failed: {error}"))?;

    for statement in [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = FULL",
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 10000",
        "CREATE TABLE IF NOT EXISTS conversation_state (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS conversation_state_history (scope TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY (scope, revision))",
        "CREATE TABLE IF NOT EXISTS conversation_sessions (session_id TEXT PRIMARY KEY, session_json TEXT NOT NULL, is_closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS conversation_transcript_segments (session_id TEXT NOT NULL, segment_no INTEGER NOT NULL, start_sequence INTEGER NOT NULL, end_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL, byte_len INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, segment_no), FOREIGN KEY(session_id) REFERENCES conversation_sessions(session_id) ON DELETE CASCADE)",
        "CREATE TABLE IF NOT EXISTS conversation_transcript_events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, segment_no INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, large_content INTEGER NOT NULL DEFAULT 0, content_len INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, sequence), FOREIGN KEY(session_id) REFERENCES conversation_sessions(session_id) ON DELETE CASCADE)",
        "CREATE TABLE IF NOT EXISTS conversation_transcript_content_chunks (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, chunk_no INTEGER NOT NULL, content TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, PRIMARY KEY (session_id, sequence, chunk_no), FOREIGN KEY(session_id, sequence) REFERENCES conversation_transcript_events(session_id, sequence) ON DELETE CASCADE)",
        "CREATE INDEX IF NOT EXISTS conversation_transcript_events_segment_idx ON conversation_transcript_events(session_id, segment_no, sequence)",
    ] {
        sqlx::query(statement)
            .execute(&pool)
            .await
            .map_err(|error| format!("conversation database setup failed: {error}"))?;
    }
    ensure_event_column(&pool, "large_content").await?;
    ensure_event_column(&pool, "content_len").await?;
    *guard = Some(pool.clone());
    Ok(pool)
}

async fn ensure_event_column(pool: &SqlitePool, name: &str) -> Result<(), String> {
    let columns = sqlx::query("PRAGMA table_info(conversation_transcript_events)")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("conversation event schema inspection failed: {error}"))?;
    if columns
        .iter()
        .any(|row| row.get::<String, _>("name") == name)
    {
        return Ok(());
    }
    let statement = match name {
        "large_content" => "ALTER TABLE conversation_transcript_events ADD COLUMN large_content INTEGER NOT NULL DEFAULT 0",
        "content_len" => "ALTER TABLE conversation_transcript_events ADD COLUMN content_len INTEGER NOT NULL DEFAULT 0",
        _ => return Err("conversation event schema migration is unsupported".to_string()),
    };
    sqlx::query(statement)
        .execute(pool)
        .await
        .map_err(|error| format!("conversation event schema migration failed: {error}"))?;
    Ok(())
}

fn decode_snapshot(payload: String, expected_checksum: String) -> Option<Value> {
    let plain = open_field(&payload, "state");
    (checksum(&plain) == expected_checksum)
        .then(|| serde_json::from_str(&plain).ok())
        .flatten()
}

async fn upsert_session_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session: &Value,
    is_closed: bool,
    now: i64,
) -> Result<(), String> {
    let id = session_id(session)?;
    let mut metadata = session.clone();
    if let Ok(memory) = memory_mut(&mut metadata) {
        memory.remove("transcript");
    }
    let payload = serde_json::to_string(&metadata)
        .map_err(|error| format!("conversation session metadata serialization failed: {error}"))?;
    sqlx::query(
        "INSERT INTO conversation_sessions (session_id, session_json, is_closed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_json = excluded.session_json, is_closed = excluded.is_closed, updated_at = excluded.updated_at",
    )
    .bind(id)
    .bind(seal_field(&payload, "sessions"))
    .bind(if is_closed { 1_i64 } else { 0_i64 })
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation session metadata write failed: {error}"))?;
    Ok(())
}

async fn seal_segment_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    segment_no: i64,
    now: i64,
) -> Result<(), String> {
    let rows = sqlx::query(
        "SELECT checksum FROM conversation_transcript_events WHERE session_id = ? AND segment_no = ? ORDER BY sequence",
    )
    .bind(session_id)
    .bind(segment_no)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("conversation segment checksum read failed: {error}"))?;
    let digest = checksum(
        &rows
            .iter()
            .map(|row| row.get::<String, _>("checksum"))
            .collect::<Vec<_>>()
            .join(":"),
    );
    sqlx::query(
        "UPDATE conversation_transcript_segments SET sealed = 1, checksum = ?, updated_at = ? WHERE session_id = ? AND segment_no = ?",
    )
    .bind(digest)
    .bind(now)
    .bind(session_id)
    .bind(segment_no)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation segment seal failed: {error}"))?;
    Ok(())
}

async fn active_segment_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    sequence: i64,
    incoming_bytes: i64,
    now: i64,
) -> Result<(i64, i64, i64), String> {
    let active = sqlx::query(
        "SELECT segment_no, event_count, byte_len FROM conversation_transcript_segments WHERE session_id = ? AND sealed = 0 ORDER BY segment_no DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("conversation active segment read failed: {error}"))?;
    if let Some(row) = active {
        let segment = row.get::<i64, _>("segment_no");
        let count = row.get::<i64, _>("event_count");
        let bytes = row.get::<i64, _>("byte_len");
        if count > 0
            && (count >= MAX_EVENTS_PER_SEGMENT
                || bytes.saturating_add(incoming_bytes) > MAX_SEGMENT_BYTES)
        {
            seal_segment_tx(tx, session_id, segment, now).await?;
        } else {
            return Ok((segment, count, bytes));
        }
    }
    let next = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(segment_no) + 1, 0) FROM conversation_transcript_segments WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| format!("conversation next segment read failed: {error}"))?;
    sqlx::query(
        "INSERT INTO conversation_transcript_segments (session_id, segment_no, start_sequence, end_sequence, event_count, byte_len, sealed, checksum, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, '', ?, ?)",
    )
    .bind(session_id)
    .bind(next)
    .bind(sequence)
    .bind(sequence.saturating_sub(1))
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation segment create failed: {error}"))?;
    Ok((next, 0, 0))
}

async fn insert_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    sequence: i64,
    message: &Value,
    now: i64,
) -> Result<i64, String> {
    let stored = stored_event(message)?;
    if let Some(row) = sqlx::query(
        "SELECT event.segment_no, event.checksum, event.byte_len, segment.sealed FROM conversation_transcript_events AS event JOIN conversation_transcript_segments AS segment ON segment.session_id = event.session_id AND segment.segment_no = event.segment_no WHERE event.session_id = ? AND event.sequence = ?",
    )
    .bind(session_id)
    .bind(sequence)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| format!("conversation event lookup failed: {error}"))? {
        let segment = row.get::<i64, _>("segment_no");
        let was_sealed = row.get::<i64, _>("sealed") != 0;
        if row.get::<String, _>("checksum") == stored.checksum {
            return Ok(segment);
        }
        let prior_bytes = row.get::<i64, _>("byte_len");
        sqlx::query(
            "UPDATE conversation_transcript_events SET payload = ?, checksum = ?, byte_len = ?, large_content = ?, content_len = ?, created_at = ? WHERE session_id = ? AND sequence = ?",
        )
        .bind(seal_field(&stored.payload, "events"))
        .bind(&stored.checksum)
        .bind(stored.byte_len)
        .bind(if stored.large_content { 1_i64 } else { 0_i64 })
        .bind(stored.content_len)
        .bind(now)
        .bind(session_id)
        .bind(sequence)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation event update failed: {error}"))?;
        replace_event_content_chunks_tx(tx, session_id, sequence, &stored.content_chunks).await?;
        sqlx::query(
            "UPDATE conversation_transcript_segments SET byte_len = MAX(0, byte_len + ?), checksum = '', updated_at = ? WHERE session_id = ? AND segment_no = ?",
        )
        .bind(stored.byte_len.saturating_sub(prior_bytes))
        .bind(now)
        .bind(session_id)
        .bind(segment)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation segment update failed: {error}"))?;
        if was_sealed {
            seal_segment_tx(tx, session_id, segment, now).await?;
        }
        return Ok(segment);
    }

    let (segment, count, segment_bytes) =
        active_segment_tx(tx, session_id, sequence, stored.byte_len, now).await?;
    sqlx::query(
        "INSERT INTO conversation_transcript_events (session_id, sequence, segment_no, payload, checksum, byte_len, large_content, content_len, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(sequence)
    .bind(segment)
    .bind(seal_field(&stored.payload, "events"))
    .bind(&stored.checksum)
    .bind(stored.byte_len)
    .bind(if stored.large_content { 1_i64 } else { 0_i64 })
    .bind(stored.content_len)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation event append failed: {error}"))?;
    replace_event_content_chunks_tx(tx, session_id, sequence, &stored.content_chunks).await?;
    sqlx::query(
        "UPDATE conversation_transcript_segments SET end_sequence = MAX(end_sequence, ?), event_count = event_count + 1, byte_len = byte_len + ?, checksum = '', updated_at = ? WHERE session_id = ? AND segment_no = ?",
    )
    .bind(sequence)
    .bind(stored.byte_len)
    .bind(now)
    .bind(session_id)
    .bind(segment)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation segment append update failed: {error}"))?;
    if count + 1 >= MAX_EVENTS_PER_SEGMENT
        || segment_bytes.saturating_add(stored.byte_len) >= MAX_SEGMENT_BYTES
    {
        seal_segment_tx(tx, session_id, segment, now).await?;
    }
    Ok(segment)
}

async fn replace_event_content_chunks_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    sequence: i64,
    chunks: &[String],
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence = ?",
    )
    .bind(session_id)
    .bind(sequence)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation content chunk cleanup failed: {error}"))?;
    for (chunk_no, content) in chunks.iter().enumerate() {
        let sealed = seal_field(content, "chunks");
        sqlx::query(
            "INSERT INTO conversation_transcript_content_chunks (session_id, sequence, chunk_no, content, checksum, byte_len) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(sequence)
        .bind(checked_i64(chunk_no))
        .bind(&sealed)
        .bind(checksum(content))
        .bind(checked_i64(content.len()))
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation content chunk append failed: {error}"))?;
    }
    Ok(())
}

async fn replace_transcript_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    messages: &[Value],
    now: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM conversation_transcript_content_chunks WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation content chunk replace cleanup failed: {error}"))?;
    sqlx::query("DELETE FROM conversation_transcript_events WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation transcript replace cleanup failed: {error}"))?;
    sqlx::query("DELETE FROM conversation_transcript_segments WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation segment replace cleanup failed: {error}"))?;
    for (index, message) in messages.iter().enumerate() {
        insert_event_tx(tx, session_id, checked_i64(index), message, now).await?;
    }
    Ok(())
}

async fn refresh_segments_after_truncate_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    now: i64,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM conversation_transcript_segments WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM conversation_transcript_events WHERE conversation_transcript_events.session_id = conversation_transcript_segments.session_id AND conversation_transcript_events.segment_no = conversation_transcript_segments.segment_no)",
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| format!("conversation empty segment cleanup failed: {error}"))?;
    let segments = sqlx::query(
        "SELECT segment_no FROM conversation_transcript_segments WHERE session_id = ? ORDER BY segment_no",
    )
    .bind(session_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| format!("conversation segment refresh read failed: {error}"))?;
    let last = segments.last().map(|row| row.get::<i64, _>("segment_no"));
    for row in segments {
        let segment = row.get::<i64, _>("segment_no");
        let totals = sqlx::query(
            "SELECT MIN(sequence) AS start_sequence, MAX(sequence) AS end_sequence, COUNT(*) AS event_count, COALESCE(SUM(byte_len), 0) AS byte_len FROM conversation_transcript_events WHERE session_id = ? AND segment_no = ?",
        )
        .bind(session_id)
        .bind(segment)
        .fetch_one(&mut **tx)
        .await
        .map_err(|error| format!("conversation segment refresh totals failed: {error}"))?;
        sqlx::query(
            "UPDATE conversation_transcript_segments SET start_sequence = ?, end_sequence = ?, event_count = ?, byte_len = ?, sealed = 0, checksum = '', updated_at = ? WHERE session_id = ? AND segment_no = ?",
        )
        .bind(totals.get::<i64, _>("start_sequence"))
        .bind(totals.get::<i64, _>("end_sequence"))
        .bind(totals.get::<i64, _>("event_count"))
        .bind(totals.get::<i64, _>("byte_len"))
        .bind(now)
        .bind(session_id)
        .bind(segment)
        .execute(&mut **tx)
        .await
        .map_err(|error| format!("conversation segment refresh update failed: {error}"))?;
        if Some(segment) != last {
            seal_segment_tx(tx, session_id, segment, now).await?;
        }
    }
    Ok(())
}

async fn reconcile_snapshot_array(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &mut Value,
    key: &str,
    is_closed: bool,
    now: i64,
) -> Result<(), String> {
    let mut entries = snapshot
        .as_object_mut()
        .and_then(|object| object.remove(key))
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if let Some(array) = entries.as_array_mut() {
        for session in array.iter_mut() {
            let id = session_id(session)?;
            let checkpoint = session
                .get("memory")
                .and_then(|memory| memory.get("transcriptCheckpoint"))
                .and_then(Value::as_i64);
            let externalized = checkpoint.is_some();
            let messages = transcript(session);
            upsert_session_tx(tx, session, is_closed, now).await?;
            if !externalized {
                replace_transcript_tx(tx, &id, &messages, now).await?;
            } else {
                let stored = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM conversation_transcript_events WHERE session_id = ?",
                )
                .bind(&id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|error| {
                    format!("conversation transcript checkpoint validation failed: {error}")
                })?;
                if stored < checkpoint.unwrap_or(0) {
                    return Err(format!(
                        "conversation transcript journal for {id} is behind its checkpoint"
                    ));
                }
            }
            let memory = memory_mut(session)?;
            memory.insert("transcript".to_string(), Value::Array(Vec::new()));
            memory.insert(
                "transcriptCheckpoint".to_string(),
                Value::from(checkpoint.unwrap_or_else(|| checked_i64(messages.len()))),
            );
            upsert_session_tx(tx, session, is_closed, now).await?;
        }
    }
    snapshot
        .as_object_mut()
        .ok_or_else(|| "conversation snapshot must be an object".to_string())?
        .insert(key.to_string(), entries);
    Ok(())
}

async fn migrate_legacy_transcripts(pool: &SqlitePool, snapshot: &Value) -> Result<(), String> {
    let mut migrations = Vec::new();
    for (key, is_closed) in [("sessions", false), ("closedSessions", true)] {
        for session in snapshot
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let has_checkpoint = session
                .get("memory")
                .and_then(|memory| memory.get("transcriptCheckpoint"))
                .is_some();
            let messages = transcript(session);
            if !has_checkpoint && !messages.is_empty() {
                migrations.push((session.clone(), is_closed, messages));
            }
        }
    }
    if migrations.is_empty() {
        return Ok(());
    }
    let now = now_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("legacy transcript migration start failed: {error}"))?;
    for (session, is_closed, messages) in migrations {
        let id = session_id(&session)?;
        upsert_session_tx(&mut tx, &session, is_closed, now).await?;
        // A new event can land after a legacy snapshot but before its first
        // checkpoint. Merge by sequence so migration never drops that turn.
        let rows = sqlx::query(
            "SELECT sequence, payload, checksum, large_content, content_len FROM conversation_transcript_events WHERE session_id = ? ORDER BY sequence",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(|error| format!("legacy transcript event merge read failed: {error}"))?;
        let mut merged = messages;
        for row in rows {
            let payload: String = open_field(&row.get::<String, _>("payload"), "events");
            let expected: String = row.get("checksum");
            let sequence = row.get::<i64, _>("sequence");
            let index = usize::try_from(sequence)
                .map_err(|_| "legacy transcript event sequence is invalid".to_string())?;
            let mut message: Value = serde_json::from_str(&payload)
                .map_err(|error| format!("legacy transcript event decode failed: {error}"))?;
            if row.get::<i64, _>("large_content") != 0 {
                let chunks = sqlx::query(
                    "SELECT chunk_no, content, checksum, byte_len FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence = ? ORDER BY chunk_no",
                )
                .bind(&id)
                .bind(sequence)
                .fetch_all(&mut *tx)
                .await
                .map_err(|error| format!("legacy transcript content merge read failed: {error}"))?;
                let mut content = String::new();
                for (expected_chunk, chunk_row) in chunks.into_iter().enumerate() {
                    let chunk: String = open_field(&chunk_row.get::<String, _>("content"), "chunks");
                    if chunk_row.get::<i64, _>("chunk_no") != checked_i64(expected_chunk)
                        || chunk_row.get::<i64, _>("byte_len") != checked_i64(chunk.len())
                        || chunk_row.get::<String, _>("checksum") != checksum(&chunk)
                    {
                        return Err(
                            "legacy transcript migration found a corrupt content chunk".to_string()
                        );
                    }
                    content.push_str(&chunk);
                }
                if checked_i64(content.len()) != row.get::<i64, _>("content_len") {
                    return Err(
                        "legacy transcript migration found a content size mismatch".to_string()
                    );
                }
                message["content"] = Value::String(content);
                let canonical = serde_json::to_string(&message).map_err(|error| {
                    format!("legacy transcript event reconstruction failed: {error}")
                })?;
                if checksum(&canonical) != expected {
                    return Err("legacy transcript migration found a corrupt event".to_string());
                }
            } else if checksum(&payload) != expected {
                return Err("legacy transcript migration found a corrupt event".to_string());
            }
            if index < merged.len() {
                merged[index] = message;
            } else if index == merged.len() {
                merged.push(message);
            }
        }
        replace_transcript_tx(&mut tx, &id, &merged, now).await?;
    }
    tx.commit()
        .await
        .map_err(|error| format!("legacy transcript migration commit failed: {error}"))
}

async fn transcript_lengths(pool: &SqlitePool) -> Result<HashMap<String, i64>, String> {
    let rows = sqlx::query(
        "SELECT session_id, COUNT(*) AS event_count FROM conversation_transcript_events GROUP BY session_id",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation transcript length load failed: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("session_id"), row.get::<i64, _>("event_count")))
        .collect())
}

async fn event_content(
    pool: &SqlitePool,
    session_id: &str,
    sequence: i64,
) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT chunk_no, content, checksum, byte_len FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence = ? ORDER BY chunk_no",
    )
    .bind(session_id)
    .bind(sequence)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation content chunk load failed: {error}"))?;
    let mut content = String::new();
    for (expected_chunk, row) in rows.into_iter().enumerate() {
        if row.get::<i64, _>("chunk_no") != checked_i64(expected_chunk) {
            return Err(format!(
                "conversation content chunk gap in session {session_id}"
            ));
        }
        let chunk: String = open_field(&row.get::<String, _>("content"), "chunks");
        if row.get::<i64, _>("byte_len") != checked_i64(chunk.len())
            || row.get::<String, _>("checksum") != checksum(&chunk)
        {
            return Err(format!(
                "conversation content chunk checksum mismatch in session {session_id}"
            ));
        }
        content.push_str(&chunk);
    }
    Ok(content)
}

// Read only the chunk rows which overlap one visible content page. A previous
// implementation rebuilt the whole message before slicing it, which made a
// single multi-megabyte response defeat transcript paging.
async fn event_content_slice(
    pool: &SqlitePool,
    session_id: &str,
    sequence: i64,
    offset: usize,
    limit: usize,
    expected_total: usize,
) -> Result<(usize, usize, String), String> {
    let metadata = sqlx::query(
        "SELECT COUNT(*) AS count, MIN(chunk_no) AS first_chunk, MAX(chunk_no) AS last_chunk, COALESCE(SUM(byte_len), 0) AS byte_len FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence = ?",
    )
    .bind(session_id)
    .bind(sequence)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("conversation content chunk metadata failed: {error}"))?;
    let count = metadata.get::<i64, _>("count");
    let first = metadata.get::<Option<i64>, _>("first_chunk");
    let last = metadata.get::<Option<i64>, _>("last_chunk");
    let actual_total = usize::try_from(metadata.get::<i64, _>("byte_len").max(0))
        .map_err(|_| "conversation content is too large to page".to_string())?;
    if count <= 0
        || first != Some(0)
        || last != Some(count.saturating_sub(1))
        || actual_total != expected_total
    {
        return Err(format!(
            "conversation content chunk layout mismatch in session {session_id}"
        ));
    }

    let requested_start = offset.min(expected_total);
    if requested_start >= expected_total {
        return Ok((expected_total, expected_total, String::new()));
    }
    // UTF-8 can move a requested boundary forward by at most three bytes. Query
    // that small extra range so the returned page can still contain its final
    // character without fetching any unrelated large chunks.
    let requested_end = requested_start
        .saturating_add(limit)
        .saturating_add(4)
        .min(expected_total);
    let rows = sqlx::query(
        "WITH ordered AS (\
             SELECT chunk_no, content, checksum, byte_len, \
                    COALESCE(SUM(byte_len) OVER (ORDER BY chunk_no ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS start_offset \
             FROM conversation_transcript_content_chunks \
             WHERE session_id = ? AND sequence = ?\
         ) \
         SELECT chunk_no, content, checksum, byte_len, start_offset \
         FROM ordered \
         WHERE start_offset < ? AND start_offset + byte_len > ? \
         ORDER BY chunk_no",
    )
    .bind(session_id)
    .bind(sequence)
    .bind(checked_i64(requested_end))
    .bind(checked_i64(requested_start))
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation content page load failed: {error}"))?;
    if rows.is_empty() {
        return Err(format!(
            "conversation content page is missing in session {session_id}"
        ));
    }

    let mut content = String::new();
    let mut actual_start = None;
    let mut end = requested_start;
    let mut expected_chunk = None;
    for row in rows {
        let chunk_no = row.get::<i64, _>("chunk_no");
        if let Some(previous) = expected_chunk {
            if chunk_no != previous + 1 {
                return Err(format!(
                    "conversation content chunk gap in session {session_id}"
                ));
            }
        }
        expected_chunk = Some(chunk_no);
        let chunk: String = open_field(&row.get::<String, _>("content"), "chunks");
        if row.get::<i64, _>("byte_len") != checked_i64(chunk.len())
            || row.get::<String, _>("checksum") != checksum(&chunk)
        {
            return Err(format!(
                "conversation content chunk checksum mismatch in session {session_id}"
            ));
        }
        let chunk_start = usize::try_from(row.get::<i64, _>("start_offset").max(0))
            .map_err(|_| "conversation content offset is invalid".to_string())?;
        let chunk_end = chunk_start.saturating_add(chunk.len());
        let start = actual_start.get_or_insert_with(|| {
            let local = requested_start.saturating_sub(chunk_start).min(chunk.len());
            chunk_start.saturating_add(utf8_boundary_after(&chunk, local))
        });
        let target_end = (*start).saturating_add(limit).min(expected_total);
        if chunk_end <= *start || chunk_start >= target_end {
            continue;
        }
        let local_start = if *start > chunk_start {
            utf8_boundary_after(&chunk, *start - chunk_start)
        } else {
            0
        };
        let local_end = utf8_boundary_before(
            &chunk,
            target_end.saturating_sub(chunk_start).min(chunk.len()),
        );
        if local_end > local_start {
            content.push_str(&chunk[local_start..local_end]);
            end = chunk_start.saturating_add(local_end);
        }
    }
    let actual_start = actual_start.unwrap_or(requested_start);
    if content.is_empty() && actual_start < expected_total {
        // A page shorter than the next multi-byte character must still make
        // progress. The first selected chunk always contains that character.
        let row = sqlx::query(
            "WITH ordered AS (\
                 SELECT content, COALESCE(SUM(byte_len) OVER (ORDER BY chunk_no ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS start_offset \
                 FROM conversation_transcript_content_chunks \
                 WHERE session_id = ? AND sequence = ?\
             ) SELECT content, start_offset FROM ordered WHERE start_offset <= ? ORDER BY start_offset DESC LIMIT 1",
        )
        .bind(session_id)
        .bind(sequence)
        .bind(checked_i64(actual_start))
        .fetch_one(pool)
        .await
        .map_err(|error| format!("conversation content progress page failed: {error}"))?;
        let chunk: String = open_field(&row.get::<String, _>("content"), "chunks");
        let chunk_start = usize::try_from(row.get::<i64, _>("start_offset").max(0))
            .map_err(|_| "conversation content offset is invalid".to_string())?;
        let local_start = actual_start.saturating_sub(chunk_start).min(chunk.len());
        let local_end = utf8_boundary_after(&chunk, local_start.saturating_add(1));
        if local_end > local_start {
            content.push_str(&chunk[local_start..local_end]);
            end = chunk_start.saturating_add(local_end);
        }
    }
    Ok((actual_start, end.min(expected_total), content))
}

async fn event_message(
    pool: &SqlitePool,
    session_id: &str,
    sequence: i64,
    raw_payload: String,
    expected_checksum: String,
    large_content: bool,
    content_len: i64,
    preview_only: bool,
) -> Result<Value, String> {
    let payload = open_field(&raw_payload, "events");
    let mut message: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("conversation event decode failed: {error}"))?;
    if !large_content {
        if checksum(&payload) != expected_checksum {
            return Err(format!(
                "conversation event checksum mismatch in session {session_id}"
            ));
        }
        return Ok(message);
    }
    if preview_only {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "_michaelTranscript".to_string(),
                json!({"sequence": sequence, "contentBytes": content_len, "chunked": true}),
            );
        }
        return Ok(message);
    }
    let content = event_content(pool, session_id, sequence).await?;
    if checked_i64(content.len()) != content_len {
        return Err(format!(
            "conversation content size mismatch in session {session_id}"
        ));
    }
    message["content"] = Value::String(content);
    let canonical = serde_json::to_string(&message)
        .map_err(|error| format!("conversation event reconstruction failed: {error}"))?;
    if checksum(&canonical) != expected_checksum {
        return Err(format!(
            "conversation event checksum mismatch in session {session_id}"
        ));
    }
    Ok(message)
}

async fn session_transcript(pool: &SqlitePool, session_id: &str) -> Result<Vec<Value>, String> {
    let rows = sqlx::query(
        "SELECT sequence, payload, checksum, large_content, content_len FROM conversation_transcript_events WHERE session_id = ? ORDER BY sequence",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation transcript load failed: {error}"))?;
    let mut messages = Vec::with_capacity(rows.len());
    for (expected_sequence, row) in rows.into_iter().enumerate() {
        let sequence = row.get::<i64, _>("sequence");
        if sequence != checked_i64(expected_sequence) {
            return Err(format!(
                "conversation event sequence gap in session {session_id}"
            ));
        }
        messages.push(
            event_message(
                pool,
                session_id,
                sequence,
                row.get("payload"),
                row.get("checksum"),
                row.get::<i64, _>("large_content") != 0,
                row.get("content_len"),
                false,
            )
            .await?,
        );
    }
    Ok(messages)
}

async fn transcript_window(
    pool: &SqlitePool,
    session_id: &str,
    start: i64,
    limit: i64,
) -> Result<ConversationTranscriptWindow, String> {
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM conversation_transcript_events WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("conversation transcript window count failed: {error}"))?;
    let start = start.clamp(0, total);
    let limit = limit.clamp(1, TRANSCRIPT_WINDOW_MAX_EVENTS);
    let rows = sqlx::query(
        "SELECT sequence, payload, checksum, large_content, content_len FROM conversation_transcript_events WHERE session_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?",
    )
    .bind(session_id)
    .bind(start)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation transcript window load failed: {error}"))?;
    let mut messages = Vec::with_capacity(rows.len());
    for (offset, row) in rows.into_iter().enumerate() {
        let sequence = row.get::<i64, _>("sequence");
        if sequence != start.saturating_add(checked_i64(offset)) {
            return Err(format!(
                "conversation event sequence gap in session {session_id}"
            ));
        }
        messages.push(
            event_message(
                pool,
                session_id,
                sequence,
                row.get("payload"),
                row.get("checksum"),
                row.get::<i64, _>("large_content") != 0,
                row.get("content_len"),
                true,
            )
            .await?,
        );
    }
    let end = start.saturating_add(checked_i64(messages.len()));
    Ok(ConversationTranscriptWindow {
        session_id: session_id.to_string(),
        start,
        end,
        total,
        messages,
    })
}

fn content_slice(value: &str, offset: usize, limit: usize) -> (usize, usize, String) {
    let start = utf8_boundary_after(value, offset);
    let target_end = start.saturating_add(limit).min(value.len());
    let end = utf8_boundary_before(value, target_end);
    (start, end, value[start..end].to_string())
}

async fn transcript_content_slice(
    pool: &SqlitePool,
    session_id: &str,
    sequence: i64,
    offset: i64,
    limit: i64,
) -> Result<ConversationTranscriptContentSlice, String> {
    let row = sqlx::query(
        "SELECT payload, large_content, content_len FROM conversation_transcript_events WHERE session_id = ? AND sequence = ?",
    )
    .bind(session_id)
    .bind(sequence)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("conversation content slice lookup failed: {error}"))?
    .ok_or_else(|| "conversation event does not exist".to_string())?;
    let payload: String = open_field(&row.get::<String, _>("payload"), "events");
    let large_content = row.get::<i64, _>("large_content") != 0;
    let total_bytes = if large_content {
        row.get::<i64, _>("content_len").max(0)
    } else {
        serde_json::from_str::<Value>(&payload)
            .ok()
            .and_then(|message| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|content| checked_i64(content.len()))
            })
            .unwrap_or(0)
    };
    let offset = offset.clamp(0, total_bytes);
    let limit = usize::try_from(limit.max(1))
        .unwrap_or(TRANSCRIPT_CONTENT_SLICE_MAX_BYTES)
        .min(TRANSCRIPT_CONTENT_SLICE_MAX_BYTES);
    let (actual_offset, end, content) = if large_content {
        event_content_slice(
            pool,
            session_id,
            sequence,
            usize::try_from(offset).unwrap_or(0),
            limit,
            usize::try_from(total_bytes).unwrap_or(0),
        )
        .await?
    } else {
        let content = serde_json::from_str::<Value>(&payload)
            .map_err(|error| format!("conversation event decode failed: {error}"))?
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        content_slice(&content, usize::try_from(offset).unwrap_or(0), limit)
    };
    Ok(ConversationTranscriptContentSlice {
        session_id: session_id.to_string(),
        sequence,
        offset: checked_i64(actual_offset),
        next_offset: checked_i64(end),
        total_bytes,
        complete: checked_i64(end) >= total_bytes,
        content,
    })
}

fn externalize_transcript_metadata(
    session: &mut Value,
    lengths: &HashMap<String, i64>,
) -> Result<(), String> {
    let id = session_id(session)?;
    let memory = memory_mut(session)?;
    memory.insert("transcript".to_string(), Value::Array(Vec::new()));
    memory.insert(
        "transcriptCheckpoint".to_string(),
        Value::from(*lengths.get(&id).unwrap_or(&0)),
    );
    Ok(())
}

// Startup restores only compact session state. Exact messages are read lazily for
// the active tab (or when a tab is opened), so one huge archived chat cannot make
// every IDE launch decode every other conversation as well.
async fn hydrate_snapshot(pool: &SqlitePool, snapshot: &mut Value) -> Result<(), String> {
    let lengths = transcript_lengths(pool).await?;
    let mut present = HashSet::new();
    for key in ["sessions", "closedSessions"] {
        if let Some(entries) = snapshot.get_mut(key).and_then(Value::as_array_mut) {
            for session in entries {
                let id = session_id(session)?;
                externalize_transcript_metadata(session, &lengths)?;
                present.insert(id);
            }
        }
    }
    // DESC: this backfill is a recovery backstop, and if it must be capped (it must — see
    // BACKFILL_APPEND_CAP below) the rows worth keeping are the most recently touched ones.
    // Ascending order meant a cap would have preserved the oldest conversations in the table.
    let rows = sqlx::query(
        "SELECT session_id, session_json, is_closed FROM conversation_sessions ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("conversation session registry load failed: {error}"))?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| "conversation snapshot must be an object".to_string())?;
    object
        .entry("sessions")
        .or_insert_with(|| Value::Array(Vec::new()));
    object
        .entry("closedSessions")
        .or_insert_with(|| Value::Array(Vec::new()));
    // Nothing ever deletes from `conversation_sessions` (see the note below), so this backfill
    // was unbounded: every conversation ever created was decoded, re-serialized, sent across
    // IPC and re-parsed by the webview on EVERY launch — while the frontend keeps only the
    // newest 80 recoverable closed sessions (src/main.js `_closedChatSessions ... .slice(0, 80)`)
    // and throws the rest away. Bound the APPENDS rather than the SELECT: a LIMIT on the query
    // would be spent on rows that are already in the snapshot and get skipped below.
    // The cap is well above the webview's 80 because it filters these again on arrival
    // (_sessionHasRecoverableMemory), so a tight 80 here could starve it.
    const BACKFILL_APPEND_CAP: usize = 200;
    let mut appended = 0usize;
    for row in rows {
        if appended >= BACKFILL_APPEND_CAP {
            break;
        }
        let id: String = row.get("session_id");
        if present.contains(&id) {
            continue;
        }
        let mut session: Value = serde_json::from_str(&open_field(&row.get::<String, _>("session_json"), "sessions"))
            .map_err(|error| format!("conversation session registry decode failed: {error}"))?;
        {
            let memory = memory_mut(&mut session)?;
            memory
                .entry("recent".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            memory
                .entry("summaries".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
        }
        externalize_transcript_metadata(&mut session, &lengths)?;
        // A row missing from the snapshot is restored as CLOSED, never as an open tab.
        //
        // This registry is a durability backstop: it exists so a conversation is never lost,
        // not so it is reopened. Which sessions are OPEN is the snapshot's call, and this row
        // is by definition absent from it. Resurrecting into "sessions" made absence mean
        // "the snapshot must be incomplete" when it usually means "the user closed this".
        //
        // `is_closed` cannot be trusted to tell those apart. Nothing ever deletes from this
        // table, and the flag is only set when a save happens to carry the session inside
        // `closedSessions` — and that array is produced by a *budgeted* serializer that drops
        // entries under quota pressure. So a closed session that got trimmed from one save
        // keeps is_closed = 0 forever and came back as an open tab on every single launch.
        //
        // Restoring it closed keeps the conversation fully recoverable from history while
        // never reopening a tab the user deliberately shut.
        let key = "closedSessions";
        object
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .expect("session arrays are initialized")
            .push(session);
        appended += 1;
    }
    Ok(())
}

#[tauri::command]
pub async fn conversation_transcript_append(
    app: AppHandle,
    session: Value,
    message: Value,
    sequence: i64,
) -> Result<ConversationTranscriptAppend, String> {
    if sequence < 0 {
        return Err("conversation event sequence must be non-negative".to_string());
    }
    let id = session_id(&session)?;
    let pool = pool(&app).await?;
    let now = now_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("conversation event transaction start failed: {error}"))?;
    upsert_session_tx(&mut tx, &session, session.get("closedAt").is_some(), now).await?;
    let segment = insert_event_tx(&mut tx, &id, sequence, &message, now).await?;
    tx.commit()
        .await
        .map_err(|error| format!("conversation event transaction commit failed: {error}"))?;
    Ok(ConversationTranscriptAppend {
        session_id: id,
        sequence,
        segment,
    })
}

#[tauri::command]
pub async fn conversation_transcript_load(
    app: AppHandle,
    session_id: String,
) -> Result<ConversationTranscriptLoad, String> {
    let id = session_id.trim();
    if id.is_empty() || id.len() > 160 {
        return Err("conversation transcript load arguments are invalid".to_string());
    }
    let pool = pool(&app).await?;
    let messages = session_transcript(&pool, id).await?;
    Ok(ConversationTranscriptLoad {
        session_id: id.to_string(),
        length: checked_i64(messages.len()),
        messages,
    })
}

#[tauri::command]
pub async fn conversation_transcript_window(
    app: AppHandle,
    session_id: String,
    start: i64,
    limit: i64,
) -> Result<ConversationTranscriptWindow, String> {
    let id = session_id.trim();
    if id.is_empty() || id.len() > 160 || start < 0 {
        return Err("conversation transcript window arguments are invalid".to_string());
    }
    let pool = pool(&app).await?;
    transcript_window(&pool, id, start, limit).await
}

#[tauri::command]
pub async fn conversation_transcript_content_slice(
    app: AppHandle,
    session_id: String,
    sequence: i64,
    offset: i64,
    limit: i64,
) -> Result<ConversationTranscriptContentSlice, String> {
    let id = session_id.trim();
    if id.is_empty() || id.len() > 160 || sequence < 0 || offset < 0 {
        return Err("conversation transcript content slice arguments are invalid".to_string());
    }
    let pool = pool(&app).await?;
    transcript_content_slice(&pool, id, sequence, offset, limit).await
}

#[tauri::command]
pub async fn conversation_transcript_truncate(
    app: AppHandle,
    session_id: String,
    length: i64,
) -> Result<ConversationTranscriptTruncate, String> {
    let id = session_id.trim();
    if id.is_empty() || id.len() > 160 || length < 0 {
        return Err("conversation transcript truncate arguments are invalid".to_string());
    }
    let pool = pool(&app).await?;
    let now = now_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("conversation truncate transaction start failed: {error}"))?;
    sqlx::query(
        "DELETE FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence >= ?",
    )
    .bind(id)
    .bind(length)
    .execute(&mut *tx)
    .await
    .map_err(|error| format!("conversation transcript content truncate failed: {error}"))?;
    let deleted = sqlx::query(
        "DELETE FROM conversation_transcript_events WHERE session_id = ? AND sequence >= ?",
    )
    .bind(id)
    .bind(length)
    .execute(&mut *tx)
    .await
    .map_err(|error| format!("conversation transcript truncate failed: {error}"))?
    .rows_affected();
    refresh_segments_after_truncate_tx(&mut tx, id, now).await?;
    tx.commit()
        .await
        .map_err(|error| format!("conversation truncate transaction commit failed: {error}"))?;
    Ok(ConversationTranscriptTruncate {
        session_id: id.to_string(),
        length,
        removed: deleted,
    })
}

/// 会话清单里的一行。**故意只带列表要用的那点东西**，不带 recent/transcript。
///
/// 存在的理由：`conversation_sessions` 表永不删除，每个开过的会话都在里面；但快照里的
/// `closedSessions` 数组在 Rust 侧封顶 200、到了前端又被 `.slice(0, 80)` 砍一刀，
/// 于是「关掉的会话过一阵就从 /sessions 里消失了」——数据还在，只是清单看不见。
///
/// 把清单和负载分开：一行索引几十字节，全量返回也不贵；真要恢复某个会话时再按 id
/// 去取它的完整 JSON（conversation_session_load）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIndexRow {
    pub session_id: String,
    pub name: String,
    pub project: String,
    pub mode: String,
    pub created: i64,
    pub closed_at: i64,
    pub updated_at: i64,
    pub is_closed: bool,
    pub total_turns: i64,
    /// 最后一条消息的开头，够在列表里认出是哪段对话就行。
    pub preview: String,
}

/// 从 session_json 里抠出清单需要的字段。抠不到就给空值——**绝不因为某一条解析不出来
/// 就让整个清单少一行**，那正是现在这个 bug 的形状。
fn index_row_from_json(session_id: String, raw: &str, is_closed: bool, updated_at: i64) -> ConversationIndexRow {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let get_str = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let get_i64 = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let memory = v.get("memory");
    let total_turns = memory
        .and_then(|m| m.get("totalTurns"))
        .and_then(|x| x.as_i64())
        .unwrap_or_else(|| {
            memory
                .and_then(|m| m.get("transcript"))
                .and_then(|x| x.as_array())
                .map(|a| a.len() as i64)
                .unwrap_or(0)
        });
    // 预览取 recent 的最后一条；content 可能是字符串，也可能是分块数组。
    let preview = memory
        .and_then(|m| m.get("recent"))
        .and_then(|x| x.as_array())
        .and_then(|a| a.last())
        .map(|msg| {
            let c = msg.get("content");
            let text = match c {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            text.chars().take(160).collect::<String>()
        })
        .unwrap_or_default();
    ConversationIndexRow {
        session_id,
        name: get_str("name"),
        project: get_str("project"),
        mode: get_str("mode"),
        created: get_i64("created"),
        closed_at: get_i64("closedAt"),
        updated_at,
        is_closed,
        total_turns,
        preview,
    }
}

/// 全部会话的轻量清单，最近更新的排前面。
///
/// 不设上限：一行只有几十到两百字节，一万条也就一两 MB，而且只在打开 /sessions 时取一次。
/// 真正贵的是转录，那个留在 conversation_transcript_events 里按需取。
#[tauri::command]
pub async fn conversation_sessions_index(
    app: AppHandle,
) -> Result<Vec<ConversationIndexRow>, String> {
    let pool = pool(&app).await?;
    let rows = sqlx::query(
        "SELECT session_id, session_json, is_closed, updated_at FROM conversation_sessions ORDER BY updated_at DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("conversation session index load failed: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id: String = row.get("session_id");
            let raw: String = open_field(&row.get::<String, _>("session_json"), "sessions");
            let closed: i64 = row.get("is_closed");
            let updated: i64 = row.get("updated_at");
            index_row_from_json(id, &raw, closed != 0, updated)
        })
        .collect())
}

/// 按 id 取回一个会话的完整 JSON（清单里点进去要恢复时才调）。
#[tauri::command]
pub async fn conversation_session_load(
    app: AppHandle,
    session_id: String,
) -> Result<Option<Value>, String> {
    let pool = pool(&app).await?;
    let row = sqlx::query("SELECT session_json FROM conversation_sessions WHERE session_id = ?")
        .bind(&session_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("conversation session load failed: {error}"))?;
    let Some(row) = row else { return Ok(None) };
    let raw: String = open_field(&row.get::<String, _>("session_json"), "sessions");
    let mut value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("conversation session decode failed: {error}"))?;
    // 和快照回填走同一套：把转录长度信息补上，前端才知道要不要按需拉取。
    let lengths = transcript_lengths(&pool).await?;
    externalize_transcript_metadata(&mut value, &lengths)?;
    Ok(Some(value))
}

#[tauri::command]
pub async fn conversation_snapshot_save(
    app: AppHandle,
    mut snapshot: Value,
) -> Result<ConversationSnapshotSave, String> {
    let pool = pool(&app).await?;
    let now = now_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("conversation transaction start failed: {error}"))?;
    reconcile_snapshot_array(&mut tx, &mut snapshot, "sessions", false, now).await?;
    reconcile_snapshot_array(&mut tx, &mut snapshot, "closedSessions", true, now).await?;
    snapshot
        .as_object_mut()
        .ok_or_else(|| "conversation snapshot must be an object".to_string())?
        .insert("version".to_string(), Value::from(3));
    let payload_plain = serde_json::to_string(&snapshot)
        .map_err(|error| format!("conversation snapshot serialization failed: {error}"))?;
    let digest = checksum(&payload_plain);
    let bytes = payload_plain.len();
    let payload = seal_field(&payload_plain, "state");
    let current = sqlx::query(
        "SELECT revision, payload, checksum, byte_len FROM conversation_state WHERE scope = ?",
    )
    .bind(SNAPSHOT_SCOPE)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| format!("conversation snapshot read failed: {error}"))?;
    if let Some(row) = current.as_ref() {
        let revision: i64 = row.get("revision");
        if row.get::<String, _>("checksum") == digest {
            tx.commit()
                .await
                .map_err(|error| format!("conversation transaction commit failed: {error}"))?;
            return Ok(ConversationSnapshotSave {
                revision,
                unchanged: true,
                bytes,
            });
        }
    }
    let previous = current.map(|row| {
        (
            row.get::<i64, _>("revision"),
            row.get::<String, _>("payload"),
            row.get::<String, _>("checksum"),
            row.get::<i64, _>("byte_len"),
        )
    });
    let revision = previous.as_ref().map(|entry| entry.0 + 1).unwrap_or(1);
    if let Some((old_revision, old_payload, old_checksum, old_bytes)) = previous {
        sqlx::query("INSERT INTO conversation_state_history (scope, revision, payload, checksum, byte_len, saved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, revision) DO NOTHING")
            .bind(SNAPSHOT_SCOPE).bind(old_revision).bind(old_payload).bind(old_checksum).bind(old_bytes).bind(now)
            .execute(&mut *tx).await
            .map_err(|error| format!("conversation backup write failed: {error}"))?;
    }
    sqlx::query("INSERT INTO conversation_state (scope, revision, payload, checksum, byte_len, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, checksum = excluded.checksum, byte_len = excluded.byte_len, updated_at = excluded.updated_at")
        .bind(SNAPSHOT_SCOPE).bind(revision).bind(&payload).bind(&digest).bind(checked_i64(bytes)).bind(now)
        .execute(&mut *tx).await
        .map_err(|error| format!("conversation snapshot write failed: {error}"))?;
    sqlx::query("DELETE FROM conversation_state_history WHERE scope = ? AND revision NOT IN (SELECT revision FROM conversation_state_history WHERE scope = ? ORDER BY revision DESC LIMIT ?)")
        .bind(SNAPSHOT_SCOPE).bind(SNAPSHOT_SCOPE).bind(HISTORY_REVISIONS)
        .execute(&mut *tx).await
        .map_err(|error| format!("conversation backup cleanup failed: {error}"))?;
    tx.commit()
        .await
        .map_err(|error| format!("conversation transaction commit failed: {error}"))?;
    Ok(ConversationSnapshotSave {
        revision,
        unchanged: false,
        bytes,
    })
}

#[tauri::command]
pub async fn conversation_snapshot_load(
    app: AppHandle,
) -> Result<Option<ConversationSnapshot>, String> {
    let pool = pool(&app).await?;
    let primary = sqlx::query(
        "SELECT revision, payload, checksum, updated_at FROM conversation_state WHERE scope = ?",
    )
    .bind(SNAPSHOT_SCOPE)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("conversation snapshot load failed: {error}"))?;
    let mut selected = primary.and_then(|row| {
        let revision: i64 = row.get("revision");
        let updated_at: i64 = row.get("updated_at");
        decode_snapshot(row.get("payload"), row.get("checksum"))
            .map(|snapshot| (revision, snapshot, false, updated_at))
    });
    if selected.is_none() {
        let backups = sqlx::query("SELECT revision, payload, checksum, saved_at FROM conversation_state_history WHERE scope = ? ORDER BY revision DESC")
            .bind(SNAPSHOT_SCOPE).fetch_all(&pool).await
            .map_err(|error| format!("conversation backup load failed: {error}"))?;
        selected = backups.into_iter().find_map(|row| {
            let revision: i64 = row.get("revision");
            let saved_at: i64 = row.get("saved_at");
            decode_snapshot(row.get("payload"), row.get("checksum"))
                .map(|snapshot| (revision, snapshot, true, saved_at))
        });
    }
    let (revision, mut snapshot, recovered_from_backup, updated_at) = selected.unwrap_or((
        0,
        json!({"version": 3, "sessions": [], "closedSessions": [], "activeIdx": 0}),
        false,
        0,
    ));
    migrate_legacy_transcripts(&pool, &snapshot).await?;
    hydrate_snapshot(&pool, &mut snapshot).await?;
    let has_chats = snapshot
        .get("sessions")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        || snapshot
            .get("closedSessions")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
    if !has_chats {
        return Ok(None);
    }
    Ok(Some(ConversationSnapshot {
        revision,
        snapshot,
        recovered_from_backup,
        updated_at,
    }))
}

#[cfg(test)]
mod session_index_tests {
    use super::*;

    async fn pool_with(rows: &[(&str, i64, i64, &str)]) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE conversation_sessions (session_id TEXT PRIMARY KEY, session_json TEXT NOT NULL, is_closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)")
            .execute(&pool).await.unwrap();
        for (id, closed, updated, json) in rows {
            sqlx::query("INSERT INTO conversation_sessions (session_id, session_json, is_closed, updated_at) VALUES (?, ?, ?, ?)")
                .bind(id).bind(json).bind(closed).bind(updated)
                .execute(&pool).await.unwrap();
        }
        pool
    }

    /// 清单不设上限——这正是 bug 的形状：快照封顶 200、前端再 slice(0,80)，
    /// 于是超出的历史会话"消失"了，而表里一直都在。
    #[tokio::test]
    async fn the_index_returns_every_session_not_just_the_newest_eighty() {
        let json: Vec<String> = (0..300)
            .map(|i| format!(r#"{{"id":"s{i}","name":"会话{i}","project":"/w/p","mode":"agent","created":1,"memory":{{"totalTurns":{},"recent":[{{"role":"user","content":"第 {i} 段对话"}}]}}}}"#, i + 1))
            .collect();
        let rows: Vec<(&str, i64, i64, &str)> = (0..300)
            .map(|i| (Box::leak(format!("s{i}").into_boxed_str()) as &str, 1i64, i as i64, json[i].as_str()))
            .collect();
        let pool = pool_with(&rows).await;

        let fetched = sqlx::query(
            "SELECT session_id, session_json, is_closed, updated_at FROM conversation_sessions ORDER BY updated_at DESC",
        ).fetch_all(&pool).await.unwrap();
        let out: Vec<ConversationIndexRow> = fetched
            .into_iter()
            .map(|row| {
                let id: String = row.get("session_id");
                let raw: String = row.get("session_json");
                let closed: i64 = row.get("is_closed");
                let updated: i64 = row.get("updated_at");
                index_row_from_json(id, &raw, closed != 0, updated)
            })
            .collect();

        assert_eq!(out.len(), 300, "300 个会话必须一个不少地出现在清单里");
        assert_eq!(out[0].session_id, "s299", "最近更新的排最前");
        assert_eq!(out[0].total_turns, 300);
        assert!(out[0].preview.contains("第 299 段对话"));
        assert!(out.iter().all(|r| r.is_closed));
    }

    /// 单条解析失败不能连累整张清单——那就是把这个 bug 换了个形状再犯一次。
    #[tokio::test]
    async fn a_row_that_cannot_be_parsed_still_takes_its_place_in_the_list() {
        let bad = index_row_from_json("broken".into(), "{ this is not json", false, 7);
        assert_eq!(bad.session_id, "broken");
        assert_eq!(bad.total_turns, 0);
        assert_eq!(bad.name, "");
        assert_eq!(bad.updated_at, 7);
    }

    /// content 有两种形状（字符串 / 分块数组），预览两种都要认。
    #[tokio::test]
    async fn preview_reads_both_content_shapes_and_falls_back_to_transcript_length() {
        let blocks = r#"{"name":"n","memory":{"recent":[{"role":"user","content":[{"type":"text","text":"分块内容"}]}],"transcript":[1,2,3,4]}}"#;
        let r = index_row_from_json("a".into(), blocks, true, 1);
        assert!(r.preview.contains("分块内容"), "{:?}", r.preview);
        assert_eq!(r.total_turns, 4, "没有 totalTurns 时用 transcript 长度兜底");

        let plain = r#"{"name":"n","memory":{"totalTurns":9,"recent":[{"role":"user","content":"纯字符串"}]}}"#;
        let r2 = index_row_from_json("b".into(), plain, true, 1);
        assert_eq!(r2.preview, "纯字符串");
        assert_eq!(r2.total_turns, 9);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in [
            "CREATE TABLE conversation_sessions (session_id TEXT PRIMARY KEY, session_json TEXT NOT NULL, is_closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
            "CREATE TABLE conversation_transcript_segments (session_id TEXT NOT NULL, segment_no INTEGER NOT NULL, start_sequence INTEGER NOT NULL, end_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL, byte_len INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, checksum TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, segment_no))",
            "CREATE TABLE conversation_transcript_events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, segment_no INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, large_content INTEGER NOT NULL DEFAULT 0, content_len INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, sequence))",
            "CREATE TABLE conversation_transcript_content_chunks (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, chunk_no INTEGER NOT NULL, content TEXT NOT NULL, checksum TEXT NOT NULL, byte_len INTEGER NOT NULL, PRIMARY KEY (session_id, sequence, chunk_no))",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    #[test]
    fn checksum_is_stable_and_detects_a_changed_snapshot() {
        assert_eq!(checksum("{\"sessions\":[]}"), checksum("{\"sessions\":[]}"));
        assert_ne!(
            checksum("{\"sessions\":[]}"),
            checksum("{\"sessions\":[1]}")
        );
    }

    #[test]
    fn segment_limits_are_positive_and_bound_one_hot_write_batch() {
        assert!(MAX_EVENTS_PER_SEGMENT >= 64);
        assert!(MAX_SEGMENT_BYTES >= 1024 * 1024);
    }

    #[tokio::test]
    async fn segment_rollover_and_truncate_preserve_the_retained_prefix() {
        let pool = test_pool().await;
        let session = json!({"id": "large-session", "memory": {}});
        let mut tx = pool.begin().await.unwrap();
        upsert_session_tx(&mut tx, &session, false, 1)
            .await
            .unwrap();
        for sequence in 0..=MAX_EVENTS_PER_SEGMENT {
            insert_event_tx(
                &mut tx,
                "large-session",
                sequence,
                &json!({"role": "user", "content": format!("turn-{sequence}")}),
                1,
            )
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();

        let segments = sqlx::query(
            "SELECT segment_no, event_count, sealed FROM conversation_transcript_segments WHERE session_id = ? ORDER BY segment_no",
        )
        .bind("large-session")
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(
            segments[0].get::<i64, _>("event_count"),
            MAX_EVENTS_PER_SEGMENT
        );
        assert_eq!(segments[0].get::<i64, _>("sealed"), 1);
        assert_eq!(segments[1].get::<i64, _>("event_count"), 1);

        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "DELETE FROM conversation_transcript_events WHERE session_id = ? AND sequence >= ?",
        )
        .bind("large-session")
        .bind(128_i64)
        .execute(&mut *tx)
        .await
        .unwrap();
        refresh_segments_after_truncate_tx(&mut tx, "large-session", 2)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let messages = session_transcript(&pool, "large-session").await.unwrap();
        assert_eq!(messages.len(), 128);
        assert_eq!(messages[0]["content"], "turn-0");
        assert_eq!(messages[127]["content"], "turn-127");
    }

    #[tokio::test]
    async fn giant_message_content_is_chunked_previewed_and_reassembled_exactly() {
        let pool = test_pool().await;
        let session = json!({"id": "giant-session", "memory": {}});
        let content = "x".repeat(INLINE_EVENT_CONTENT_BYTES + EVENT_CONTENT_CHUNK_BYTES + 1024);
        let mut tx = pool.begin().await.unwrap();
        upsert_session_tx(&mut tx, &session, false, 1)
            .await
            .unwrap();
        insert_event_tx(
            &mut tx,
            "giant-session",
            0,
            &json!({"role": "assistant", "content": content.clone()}),
            1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let row = sqlx::query(
            "SELECT payload, large_content, content_len FROM conversation_transcript_events WHERE session_id = ? AND sequence = 0",
        )
        .bind("giant-session")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("large_content"), 1);
        assert!(row.get::<String, _>("payload").len() < EVENT_CONTENT_PREVIEW_BYTES * 2);
        assert_eq!(row.get::<i64, _>("content_len"), checked_i64(content.len()));
        let chunk_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM conversation_transcript_content_chunks WHERE session_id = ? AND sequence = 0",
        )
        .bind("giant-session")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(chunk_count >= 2);

        let window = transcript_window(&pool, "giant-session", 0, 1)
            .await
            .unwrap();
        assert_eq!(window.total, 1);
        assert_eq!(window.messages[0]["_michaelTranscript"]["chunked"], true);
        assert!(window.messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("full local content is chunked"));
        let full = session_transcript(&pool, "giant-session").await.unwrap();
        assert_eq!(full[0]["content"].as_str().unwrap(), content);
        let slice = transcript_content_slice(&pool, "giant-session", 0, 0, 4096)
            .await
            .unwrap();
        assert_eq!(slice.content, "x".repeat(4096));
        assert!(!slice.complete);
    }

    #[tokio::test]
    async fn giant_utf8_content_pages_forward_without_skipping_characters() {
        let pool = test_pool().await;
        let session = json!({"id": "utf8-session", "memory": {}});
        let content = "界".repeat(400_000);
        let mut tx = pool.begin().await.unwrap();
        upsert_session_tx(&mut tx, &session, false, 1)
            .await
            .unwrap();
        insert_event_tx(
            &mut tx,
            "utf8-session",
            0,
            &json!({"role": "assistant", "content": content.clone()}),
            1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let mut offset = 0_i64;
        let mut assembled = String::new();
        loop {
            let page = transcript_content_slice(&pool, "utf8-session", 0, offset, 64 * 1024)
                .await
                .unwrap();
            assert!(
                page.next_offset > offset,
                "content paging must always progress"
            );
            assert_eq!(
                page.content.len(),
                (page.next_offset - page.offset) as usize
            );
            assembled.push_str(&page.content);
            offset = page.next_offset;
            if page.complete {
                break;
            }
        }
        assert_eq!(assembled, content);
    }

    /// A session the user CLOSED must not come back as an open tab.
    ///
    /// Nothing ever deletes from `conversation_sessions`, and `is_closed` only flips to 1 when
    /// a save happens to carry that session inside `closedSessions` — an array built by a
    /// budgeted serializer that drops entries under quota pressure. So a closed session whose
    /// row still reads `is_closed = 0` is the NORMAL case, not an edge case, and hydration used
    /// to push exactly those rows back into `"sessions"` on every single launch.
    #[tokio::test]
    async fn hydration_never_reopens_a_session_the_snapshot_left_out() {
        let pool = test_pool().await;
        for id in ["kept_open", "user_closed_it"] {
            sqlx::query("INSERT INTO conversation_sessions (session_id, session_json, is_closed, updated_at) VALUES (?, ?, 0, 1)")
                .bind(id)
                .bind(format!(r#"{{"id":"{id}","memory":{{}}}}"#))
                .execute(&pool)
                .await
                .unwrap();
        }

        // The frontend still lists one session as open; the other it dropped, because the user
        // closed it. Both rows say is_closed = 0.
        let mut snapshot = json!({
            "sessions": [{"id": "kept_open", "memory": {}}],
            "closedSessions": [],
            "activeIdx": 0,
        });
        hydrate_snapshot(&pool, &mut snapshot).await.unwrap();

        let open: Vec<&str> = snapshot["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            open,
            ["kept_open"],
            "hydration must not add tabs the snapshot omitted"
        );

        // ...but the conversation itself is preserved, just closed — never silently dropped.
        let closed: Vec<&str> = snapshot["closedSessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            closed,
            ["user_closed_it"],
            "the omitted session must survive as closed"
        );
    }

    #[tokio::test]
    async fn snapshot_hydration_is_metadata_only_and_checks_each_transcript_on_demand() {
        let pool = test_pool().await;
        for id in ["active", "dormant"] {
            sqlx::query("INSERT INTO conversation_sessions (session_id, session_json, is_closed, updated_at) VALUES (?, ?, 0, 1)")
                .bind(id)
                .bind(format!(r#"{{"id":"{id}","memory":{{}}}}"#))
                .execute(&pool)
                .await
                .unwrap();
        }
        let active_payload = r#"{"role":"user","content":"keep"}"#;
        sqlx::query("INSERT INTO conversation_transcript_events (session_id, sequence, segment_no, payload, checksum, byte_len, created_at) VALUES (?, 0, 0, ?, ?, ?, 1)")
            .bind("active")
            .bind(active_payload)
            .bind(checksum(active_payload))
            .bind(checked_i64(active_payload.len()))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversation_transcript_events (session_id, sequence, segment_no, payload, checksum, byte_len, created_at) VALUES (?, 0, 0, ?, 'bad', ?, 1)")
            .bind("dormant")
            .bind(active_payload)
            .bind(checked_i64(active_payload.len()))
            .execute(&pool)
            .await
            .unwrap();

        let mut snapshot = json!({
            "sessions": [{"id": "active", "memory": {"transcript": [{"stale": true}]}}],
            "closedSessions": [],
            "activeIdx": 0,
        });
        hydrate_snapshot(&pool, &mut snapshot).await.unwrap();
        let memory = &snapshot["sessions"][0]["memory"];
        assert_eq!(memory["transcript"], json!([]));
        assert_eq!(memory["transcriptCheckpoint"], 1);
        assert_eq!(
            session_transcript(&pool, "active").await.unwrap()[0]["content"],
            "keep"
        );
        assert!(session_transcript(&pool, "dormant").await.is_err());
    }
}
