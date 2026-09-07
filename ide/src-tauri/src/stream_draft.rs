//! 流式草稿的**增量追加日志**：进程被强杀（杀毒软件、崩溃、突然关闭）也能保住已生成内容。
//!
//! 为什么不用现有的两条路：
//!  · localStorage 每 2s 写全量 —— WKWebView 由引擎异步落盘，SIGKILL 时最近的覆写没进磁盘；
//!  · Tauri store 的耐久镜像只在优雅退出（CloseRequested / 更新重启 / 隐藏窗口）时写，SIGKILL 跳过它。
//! 两条都指望"还有机会跑代码"，而 kill -9 一行代码都不给跑。
//!
//! 这里反过来：流式过程中就把**每一小段 delta** 追加进真文件（append + flush，已返回的 write
//! 进了 OS，进程被杀但系统还在时就活得下来），恢复时把同一轮的 delta 拼回来。追加是 O(delta)，
//! 不碰 O(n²) 的整段 flatten。每会话一个文件；每行一条 JSON：{g:轮次, t:正文delta, r:思考delta}。
//! 换了一轮（g 变大）就在读取时丢弃旧轮的行，收尾时删文件。
//! 另有 `<sid>.snap.json`：在途消息的 DOM 快照（整份覆盖，临时文件 + rename 保证要么旧要么新）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 草稿日志目录：和 conversations.sqlite3 同处（app_data_dir/stream-drafts）。
fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir 不可用: {e}"))?
        .join("stream-drafts");
    fs::create_dir_all(&dir).map_err(|e| format!("建不了草稿目录: {e}"))?;
    Ok(dir)
}

/// 会话 id → 安全文件名。只留字母数字和 -_，截断 64，杜绝路径穿越。
fn safe_name(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

/// 追加一段 delta。text / reasoning 传的是**增量**，不是全量。
#[tauri::command]
pub fn stream_draft_append(
    app: AppHandle,
    session_id: String,
    gen: u64,
    text: String,
    reasoning: String,
) -> Result<(), String> {
    if text.is_empty() && reasoning.is_empty() {
        return Ok(());
    }
    let sid = safe_name(&session_id);
    if sid.is_empty() {
        return Ok(());
    }
    let path = drafts_dir(&app)?.join(format!("{sid}.ndjson"));
    // t/r 用 serde 转义，保证是合法单行 JSON（内容里的换行/引号不会破坏行结构）。
    let rec = serde_json::json!({ "g": gen, "t": text, "r": reasoning }).to_string();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打不开草稿日志: {e}"))?;
    f.write_all(rec.as_bytes()).map_err(|e| format!("写草稿失败: {e}"))?;
    f.write_all(b"\n").map_err(|e| format!("写草稿失败: {e}"))?;
    // flush 到 OS：进程被杀但系统还在时，已 flush 的 write 就保住了。断电级别（要 fsync）
    // 不是本命令的目标威胁（那需要每条 fsync，太贵），这里针对的是 SIGKILL / 崩溃 / 强关。
    let _ = f.flush();
    Ok(())
}

/// 在途消息的 DOM 快照：整份覆盖。先写临时文件再 rename，进程死在写一半时磁盘上留的是上一份完整的。
#[tauri::command]
pub fn stream_draft_snapshot(
    app: AppHandle,
    session_id: String,
    gen: u64,
    at: u64,
    html: String,
) -> Result<(), String> {
    let sid = safe_name(&session_id);
    if sid.is_empty() || html.is_empty() {
        return Ok(());
    }
    let dir = drafts_dir(&app)?;
    let tmp = dir.join(format!("{sid}.snap.json.tmp"));
    let path = dir.join(format!("{sid}.snap.json"));
    let body = serde_json::json!({ "gen": gen, "at": at, "html": html }).to_string();
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("建不了快照文件: {e}"))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("写快照失败: {e}"))?;
        let _ = f.flush();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("换入快照失败: {e}"))?;
    Ok(())
}

/// 读回所有会话的在途草稿：delta 日志按**最新一轮**拼成全量，DOM 快照原样带上。
/// 返回 [{sessionId, gen, text, reasoning, html, htmlAt}]。给恢复流程用。
#[tauri::command]
pub fn stream_draft_read_all(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = drafts_dir(&app)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    let mut sids: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let stem = name
            .strip_suffix(".ndjson")
            .or_else(|| name.strip_suffix(".snap.json"))
            .map(str::to_string);
        if let Some(sid) = stem {
            if !sid.is_empty() && !sids.contains(&sid) {
                sids.push(sid);
            }
        }
    }
    for sid in sids {
        let (gen, text, reasoning) = fs::read_to_string(dir.join(format!("{sid}.ndjson")))
            .map(|c| reconstruct(&c))
            .unwrap_or((0, String::new(), String::new()));
        let snap = fs::read_to_string(dir.join(format!("{sid}.snap.json")))
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| {
                let html = v.get("html")?.as_str()?.to_string();
                Some((
                    v.get("gen").and_then(|g| g.as_u64()).unwrap_or(0),
                    v.get("at").and_then(|a| a.as_u64()).unwrap_or(0),
                    html,
                ))
            });
        if let Some(entry) = combine(&sid, gen, text, reasoning, snap) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// 同一会话的 delta 日志与 DOM 快照合成一条恢复记录。两边轮次不同时只认新的那一轮：
/// 旧轮的快照配新轮的正文会把上一轮的工具卡塞进这一轮。三样全空就不产出。纯函数，可单测。
fn combine(
    sid: &str,
    gen: u64,
    text: String,
    reasoning: String,
    snap: Option<(u64, u64, String)>,
) -> Option<serde_json::Value> {
    let snap_gen = snap.as_ref().map(|s| s.0).unwrap_or(0);
    let latest = gen.max(snap_gen);
    let (text, reasoning) = if gen == latest { (text, reasoning) } else { (String::new(), String::new()) };
    let (html, html_at) = match snap {
        Some((g, at, html)) if g == latest && !html.is_empty() => (Some(html), Some(at)),
        _ => (None, None),
    };
    if text.trim().is_empty() && reasoning.trim().is_empty() && html.is_none() {
        return None;
    }
    Some(serde_json::json!({
        "sessionId": sid,
        "gen": latest,
        "text": text,
        "reasoning": reasoning,
        "html": html,
        "htmlAt": html_at,
    }))
}

/// 把一份 ndjson 日志按最新一轮拼回 (gen, text, reasoning)。纯函数，可单测。
/// 逐行累加；遇到更大的 gen（新一轮）就清空重来——即使收尾删文件没跑成、文件里混着旧轮的行，
/// 也只会恢复出最新那一轮。
fn reconstruct(content: &str) -> (u64, String, String) {
    let mut gen: u64 = 0;
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut seen = false;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // 半行（被杀在写一半）跳过，不毁掉整份
        };
        let g = v.get("g").and_then(|x| x.as_u64()).unwrap_or(0);
        if !seen || g > gen {
            gen = g;
            text.clear();
            reasoning.clear();
            seen = true;
        }
        if g == gen {
            if let Some(t) = v.get("t").and_then(|x| x.as_str()) {
                text.push_str(t);
            }
            if let Some(r) = v.get("r").and_then(|x| x.as_str()) {
                reasoning.push_str(r);
            }
        }
    }
    (gen, text, reasoning)
}

/// 收尾：这一轮已落账、已渲染，删掉它的草稿日志。
#[tauri::command]
pub fn stream_draft_clear(app: AppHandle, session_id: String) -> Result<(), String> {
    let sid = safe_name(&session_id);
    if sid.is_empty() {
        return Ok(());
    }
    let dir = drafts_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{sid}.ndjson")));
    let _ = fs::remove_file(dir.join(format!("{sid}.snap.json")));
    let _ = fs::remove_file(dir.join(format!("{sid}.snap.json.tmp")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{combine, reconstruct, safe_name};

    #[test]
    fn 快照和日志同一轮_两样都带上() {
        let v = combine("s", 3, "正文".into(), String::new(), Some((3, 99, "<div>x</div>".into()))).unwrap();
        assert_eq!(v["text"], "正文");
        assert_eq!(v["html"], "<div>x</div>");
        assert_eq!(v["htmlAt"], 99);
    }

    #[test]
    fn 旧轮的快照不配新轮的正文() {
        let v = combine("s", 4, "新轮正文".into(), String::new(), Some((3, 1, "<div>旧</div>".into()))).unwrap();
        assert_eq!(v["text"], "新轮正文");
        assert!(v["html"].is_null(), "上一轮的工具卡不许塞进这一轮");
    }

    #[test]
    fn 新轮只有快照_旧轮正文丢弃() {
        let v = combine("s", 3, "旧".into(), String::new(), Some((4, 1, "<div>新</div>".into()))).unwrap();
        assert_eq!(v["text"], "");
        assert_eq!(v["gen"], 4);
        assert_eq!(v["html"], "<div>新</div>");
    }

    #[test]
    fn 只有快照没有正文也算有内容_全空不产出() {
        assert!(combine("s", 0, String::new(), String::new(), Some((2, 1, "<div/>".into()))).is_some());
        assert!(combine("s", 0, "  ".into(), String::new(), None).is_none());
    }

    #[test]
    fn 按最新一轮拼回_旧轮的行被丢弃() {
        // 第 1 轮两段，然后第 2 轮开始——只应恢复第 2 轮
        let log = concat!(
            "{\"g\":1,\"t\":\"旧\",\"r\":\"\"}\n",
            "{\"g\":1,\"t\":\"内容\",\"r\":\"思考A\"}\n",
            "{\"g\":2,\"t\":\"新的\",\"r\":\"\"}\n",
            "{\"g\":2,\"t\":\"回答\",\"r\":\"思考B\"}\n",
        );
        let (g, t, r) = reconstruct(log);
        assert_eq!(g, 2);
        assert_eq!(t, "新的回答");
        assert_eq!(r, "思考B");
    }

    #[test]
    fn 被杀在写一半的坏行不毁掉整份() {
        let log = "{\"g\":1,\"t\":\"完整\",\"r\":\"\"}\n{\"g\":1,\"t\":\"再来\",\"r\":\"\"}\n{\"g\":1,\"t\":\"半行没写完";
        let (_g, t, _r) = reconstruct(log);
        assert_eq!(t, "完整再来", "坏行跳过，前面已 flush 的照常拼回");
    }

    #[test]
    fn 只有思考没正文也算有内容() {
        let (_g, t, r) = reconstruct("{\"g\":3,\"t\":\"\",\"r\":\"只思考了\"}\n");
        assert_eq!(t, "");
        assert_eq!(r, "只思考了");
    }

    #[test]
    fn 文件名防穿越() {
        assert_eq!(safe_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_name("sess_ABC-123"), "sess_ABC-123");
        assert_eq!(safe_name("会话/x"), "x");
    }
}
