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

/// 读回所有会话的在途草稿，各自按**最新一轮**把 delta 拼成全量。
/// 返回 [{sessionId, gen, text, reasoning}]。给恢复流程用。
#[tauri::command]
pub fn stream_draft_read_all(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = drafts_dir(&app)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ndjson") {
            continue;
        }
        let sid = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (gen, text, reasoning) = reconstruct(&content);
        if !text.trim().is_empty() || !reasoning.trim().is_empty() {
            out.push(serde_json::json!({
                "sessionId": sid,
                "gen": gen,
                "text": text,
                "reasoning": reasoning,
            }));
        }
    }
    Ok(out)
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
    let path = drafts_dir(&app)?.join(format!("{sid}.ndjson"));
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{reconstruct, safe_name};

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
