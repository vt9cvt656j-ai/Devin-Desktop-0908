//! Generic web tools for the agent — call ANY HTTP API and download files. This
//! is what lets the agent use "online tools": REST APIs (GitHub, weather, public
//! data), webhooks, and crucially the local dev server it just started.
//!
//! Security (grounded in SSRF best practice): reject non-http(s) schemes, disable
//! redirects (a 3xx can't bounce us somewhere internal), and bound time + size.
//! Unlike web_fetch (public-only), http_request INTENTIONALLY allows loopback /
//! LAN — the agent's main use is hitting the server it just built — but it still
//! BLOCKS link-local / cloud-metadata (169.254.0.0/16, fe80::/10), which have no
//! legitimate agent use and are the classic SSRF target.

use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

const MAX_BODY: usize = 5 * 1024 * 1024; // cap on the response body we buffer
const MAX_DOWNLOAD: usize = 200 * 1024 * 1024; // cap on a downloaded file
const DNS_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);
// Generated images are sent back through IPC as data URLs. Keep their raw size
// aligned with the file-to-data-URL tool rather than allowing a 200 MiB image to
// turn into a roughly 267 MiB renderer payload.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_API_JSON_BYTES: usize = MAX_IMAGE_BYTES * 4 / 3 + 64 * 1024;
const MAX_IMAGE_ERROR_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    ok: bool,
    status_text: String,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    redirect_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    redirect_url: Option<String>,
    body: String,
    truncated: bool,
    content_type: String,
    body_encoding: String,
}

/// Block only the SSRF-only targets (link-local / cloud-metadata, multicast,
/// broadcast, unspecified). Loopback + private are allowed on purpose so the
/// agent can hit its own dev server and LAN services.
fn addr_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local() || v4.is_broadcast() || v4.is_multicast() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_multicast() || v6.is_unspecified() || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Validate a URL for both tools: http/https only, host resolvable, and no
/// resolved address is a blocked (link-local/metadata) one.
async fn validate(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "无效的 URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("只允许 http/https 链接".into()),
    }
    let host = parsed.host_str().ok_or("URL 缺少主机名")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(80);
    // `ToSocketAddrs` uses the platform's blocking resolver. Running it directly
    // in a Tauri async command can pin a runtime worker behind a stalled DNS
    // lookup, so isolate it and put an IPC-visible deadline around the wait.
    let lookup = tauri::async_runtime::spawn_blocking(move || {
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|addrs| addrs.collect::<Vec<_>>())
            .map_err(|error| format!("DNS 解析失败: {error}"))
    });
    let lookup = tokio::time::timeout(DNS_RESOLUTION_TIMEOUT, lookup)
        .await
        .map_err(|_| format!("DNS 解析超时（{} 秒）", DNS_RESOLUTION_TIMEOUT.as_secs()))?;
    let addrs = lookup.map_err(|error| format!("DNS 解析任务失败: {error}"))??;
    if addrs.is_empty() {
        return Err("无法解析主机".into());
    }
    for a in &addrs {
        if addr_blocked(a.ip()) {
            return Err("拒绝访问链路本地/云元数据地址(如 169.254.169.254)".into());
        }
    }
    Ok(parsed)
}

async fn response_bytes_limited(
    mut response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            return Err(format!(
                "{label}响应过大（{length} 字节，上限 {limit} 字节）"
            ));
        }
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取{label}响应失败: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!("{label}响应超过 {limit} 字节上限"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn response_text_limited(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<String, String> {
    let bytes = response_bytes_limited(response, limit, label).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn response_json_limited<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<T, String> {
    let bytes = response_bytes_limited(response, limit, label).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析{label}响应失败: {error}"))
}

async fn generated_image_response(
    response: reqwest::Response,
    label: &str,
) -> Result<(Vec<u8>, String), String> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response_bytes_limited(response, MAX_IMAGE_BYTES, label).await?;
    Ok((
        bytes,
        if content_type.starts_with("image/") {
            content_type
        } else {
            "image/png".into()
        },
    ))
}

fn download_temporary_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "目标路径缺少文件名".to_string())?;
    Ok(parent.join(format!(
        ".{file_name}.michael-download-{}.part",
        uuid::Uuid::new_v4()
    )))
}

async fn stream_response_to_path(
    mut response: reqwest::Response,
    target: &Path,
    limit: usize,
    too_large_message: &str,
) -> Result<u64, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(too_large_message.to_string());
    }

    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("建目录失败: {error}"))?;
    let temporary = download_temporary_path(target)?;
    let download = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|error| format!("创建临时文件失败: {error}"))?;
        let mut written = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("下载读取失败: {error}"))?
        {
            let next = written.saturating_add(chunk.len() as u64);
            if next > limit as u64 {
                return Err(too_large_message.to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入临时文件失败: {error}"))?;
            written = next;
        }
        file.flush()
            .await
            .map_err(|error| format!("刷新临时文件失败: {error}"))?;
        drop(file);
        // The temporary file is in the target directory, so rename replaces the
        // prior file atomically on the project's supported filesystems.
        tokio::fs::rename(&temporary, target)
            .await
            .map_err(|error| format!("保存下载文件失败: {error}"))?;
        Ok(written)
    }
    .await;

    if download.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    download
}

fn header_value(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn redirect_target(base: &reqwest::Url, location: Option<&str>) -> Option<String> {
    let location = location?.trim();
    if location.is_empty() {
        return None;
    }
    base.join(location).ok().map(|url| url.to_string())
}

fn charset_from_content_type(content_type: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        let part = part.trim();
        if let Some((key, value)) = part.split_once('=') {
            if key.trim().eq_ignore_ascii_case("charset") {
                let value = value.trim().trim_matches('"').trim_matches('\'').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn charset_from_meta(bytes: &[u8]) -> Option<String> {
    let sample = &bytes[..bytes.len().min(4096)];
    let lower = String::from_utf8_lossy(sample).to_lowercase();
    let idx = lower.find("charset")?;
    let tail = &lower[idx + "charset".len()..];
    let eq = tail.find('=')?;
    let mut value = tail[eq + 1..].trim_start();
    if let Some(stripped) = value.strip_prefix('"').or_else(|| value.strip_prefix('\'')) {
        value = stripped;
    }
    let charset: String = value
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if charset.is_empty() {
        None
    } else {
        Some(charset)
    }
}

fn is_probably_textual(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("xml")
        || ct.contains("html")
        || ct.contains("javascript")
        || ct.contains("x-www-form-urlencoded")
}

fn decode_body_text(buf: Vec<u8>, content_type: &str) -> (String, String) {
    let label = charset_from_content_type(content_type).or_else(|| charset_from_meta(&buf));
    if let Some(label) = label {
        if let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            let (decoded, _, had_errors) = encoding.decode(&buf);
            let name = if had_errors {
                format!("{} (lossy)", encoding.name())
            } else {
                encoding.name().to_string()
            };
            return (decoded.into_owned(), name);
        }
    }
    match String::from_utf8(buf) {
        Ok(text) => (text, "UTF-8".into()),
        Err(error) => {
            let bytes = error.into_bytes();
            if is_probably_textual(content_type) {
                (
                    String::from_utf8_lossy(&bytes).into_owned(),
                    "UTF-8 (lossy)".into(),
                )
            } else {
                (
                    format!("[二进制响应，{} 字节，未作为文本返回]", bytes.len()),
                    "binary".into(),
                )
            }
        }
    }
}

/// Call any HTTP API. `method` = GET/POST/PUT/PATCH/DELETE/HEAD. Optional headers
/// and request body. Returns status + headers + body (text, truncated to 5 MB).
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<HttpResponse, String> {
    let parsed = validate(&url).await?;
    let m = method.trim().to_uppercase();
    let method = reqwest::Method::from_bytes(m.as_bytes())
        .map_err(|_| format!("不支持的 HTTP 方法: {m}"))?;
    let to = timeout_secs.unwrap_or(30).clamp(1, 120);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(to))
        .build()
        .map_err(|e| e.to_string())?;

    let request_url = parsed.clone();
    let mut req = client
        .request(method, parsed)
        .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0");
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let redirect_location = header_value(resp.headers(), reqwest::header::LOCATION);
    let redirect_url = redirect_target(&request_url, redirect_location.as_deref());
    let mut hmap = HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            hmap.insert(k.as_str().to_string(), s.to_string());
        }
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if buf.len() + chunk.len() > MAX_BODY {
            let take = MAX_BODY.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    let (body_text, body_encoding) = decode_body_text(buf, &content_type);

    Ok(HttpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: hmap,
        redirect_location,
        redirect_url,
        body: body_text,
        truncated,
        content_type,
        body_encoding,
    })
}

/// 下载不覆盖已有文件。
///
/// dest 到这一步为止完全是模型给的一个路径，而下载走的**不是**结构化写入那条路：没有
/// "先读再写"的下限、没有 diff、没有 checkpoint 里的旧副本。于是
/// `download_file(url, "src/main.js")` 就是把那个文件原地换掉——无声、撤不回来，返回的
/// 还是"已下载 N 字节"。一个笔误的 dest，或者一段诱导模型的网页内容，就够了。
///
/// 目录不挡：`create_dir_all` 本来就允许已存在，这里只挡真正会被顶掉的文件。
fn refuse_existing_download_target(target: &Path) -> Result<(), String> {
    if target.is_file() {
        return Err(format!(
            "{} 已经存在，没有下载——下载会把它整个换掉，而这一步没有旧内容备份、撤不回来。\
             要替换就先 delete_path 删掉它（那一步会留 checkpoint），或者换一个目标文件名。",
            target.display()
        ));
    }
    Ok(())
}


/// 把 `dest`（相对 `root` 或绝对）解析成一个**确认落在工作区内**的绝对路径。
///
/// 抽出来是为了能拿真实符号链接测它 —— download_file 本身要联网，测不动。
fn resolve_download_target(root: &str, dest: &str) -> Result<std::path::PathBuf, String> {
    let base = std::path::Path::new(root);
    let d = std::path::Path::new(dest);
    let target = if d.is_absolute() { d.to_path_buf() } else { base.join(d) };
    if target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("目标路径不能包含 ..".into());
    }
    // 边界必须在**解析完符号链接之后**判，不能拿字面路径比前缀。
    //
    // 原来是 `target.starts_with(base)` —— 纯粹的字符串式组件比较。工作区里只要有一个
    // 指向外部的目录符号链接（git 能原样存任意 symlink 目标，clone 一个仓库就带进来了），
    // 比如 `assets -> ~/Library/LaunchAgents`，那么 `<root>/assets/x.plist` 字面上就在
    // root 底下、两道检查全过，而写下去落在工作区之外。这是仓库内容就能诱导的越界写。
    //
    // require_inside_workspace 是这个进程里唯一一份做对了的边界：它先 canonicalize（对
    // 还不存在的目标会解析到最深的已存在祖先再拼回去）、处理 macOS 的 firmlink，
    // 并且对写操作要求落在**已打开的工作区**内而不只是 HOME 底下。它的注释原话就是
    // 「拿原始路径比对会让工作区内的符号链接授权它指向的外部目标」。
    // 不在这里另写一份 —— 两份边界迟早漂开，而漂开的那一刻没有任何东西会报警。
    crate::files::require_inside_workspace(&target.to_string_lossy(), true)
}

/// Download a file from a URL into the workspace. `dest` is resolved relative to
/// `root` (or absolute) and MUST stay inside `root`. Bounded to 200 MB.
#[tauri::command]
pub async fn download_file(root: String, url: String, dest: String) -> Result<String, String> {
    let parsed = validate(&url).await?;

    let target = resolve_download_target(&root, &dest)?;

    refuse_existing_download_target(&target)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let n = stream_response_to_path(resp, &target, MAX_DOWNLOAD, "文件过大(>200MB)").await?;
    Ok(format!("已下载 {n} 字节到 {}", target.display()))
}

/// Generate an image through the user's OpenAI-compatible gateway.
/// Dedicated image-generation models (gpt-image-*, dall-e-*) → /images/generations API.
/// Chat-based image models (gpt-4o-image, gemini-flash-image, etc.) → /chat/completions.
/// Saves to the workspace → {path, bytes, data_url}.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_image_chat(
    root: String,
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    dest: String,
    width: Option<u32>,
    height: Option<u32>,
    request_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("缺少图像描述 prompt".into());
    }
    if model.trim().is_empty() {
        return Err("缺少图像模型名".into());
    }
    let b = base_url.trim().trim_end_matches('/');
    if !(b.starts_with("http://") || b.starts_with("https://")) {
        return Err("图像模型 base_url 无效".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let size_str = image_size_for_model(&model, width, height);

    // Try THREE endpoints in sequence so this works on real OpenAI AND 中转站:
    //   1. /v1/images/generations (standard OpenAI Images API — the image-form request;
    //      relay gateways like Sub2API document exactly this shape: model/prompt/size)
    //   2. /v1/responses with image_generation tool (Codex GPT Image route)
    //   3. /v1/chat/completions (chat-wrapped image gen, last resort)
    // The Images API goes first: text-input routes (responses/chat) on relay gateways
    // often degrade to a text answer instead of an image.
    let (bytes, mime): (Vec<u8>, String) = match try_images_api(
        &client,
        b,
        &api_key,
        &model,
        prompt,
        &size_str,
        request_id.as_deref(),
    )
    .await
    {
        Ok(ok) => ok,
        // 只有在**上游肯定还没画**的时候才换下一条路。
        //
        // 三条端点是给中转站兜底的：有的只实现 /v1/images/generations，有的只走
        // chat。但原来的写法是「上一条 Err 就试下一条」，而 Err 里混着一大类
        // **200 已经回来、只是解析不出图**的情况（data 里没有 b64_json / 下载失败 /
        // 轮询超时 / base64 坏了）。那些情况上游已经画完并计费了，再换端点就是
        // 让用户为一次生图付两次、三次钱，最坏还要等 180s×3。
        Err(e0) if e0.billed => return Err(e0.msg),
        Err(e0) => {
            match try_responses_api(
                &client,
                b,
                &api_key,
                &model,
                prompt,
                &size_str,
                request_id.as_deref(),
            )
            .await
            {
                Ok(ok) => ok,
                Err(e1) if e1.billed => {
                    return Err(format!("images: {e0} ｜responses: {e1}"));
                }
                Err(e1) => match try_chat_image_api(
                    &client,
                    b,
                    &api_key,
                    &model,
                    prompt,
                    request_id.as_deref(),
                )
                .await
                {
                    Ok(ok) => ok,
                    Err(e2) => return Err(format!("images: {e0} ｜responses: {e1} ｜chat: {e2}")),
                },
            }
        }
    };

    if bytes.is_empty() {
        return Err("生成结果为空".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("生成的图过大".into());
    }
    let basep = std::path::Path::new(&root);
    let target = {
        let d = std::path::Path::new(&dest);
        if d.is_absolute() {
            d.to_path_buf()
        } else {
            basep.join(d)
        }
    };
    if target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("目标路径不能包含 ..".into());
    }
    if !basep.as_os_str().is_empty() && !target.starts_with(basep) {
        return Err("只能存到工作区目录内".into());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    let data_url = format!("data:{};base64,{}", mime, crate::capture::b64(&bytes));
    Ok(
        serde_json::json!({ "path": dest, "bytes": bytes.len(), "data_url": data_url, "via": model.trim() }),
    )
}

fn with_ide_request_id(
    request: reqwest::RequestBuilder,
    request_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let Some(value) = request_id.filter(|value| {
        (8..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) else {
        return request;
    };
    request.header("x-ide-request-id", value)
}

/// Try /v1/responses with the image_generation built-in tool. This is the modern
/// OpenAI Codex / 中转站 (LaoZhang etc.) route — relay stations wrap gpt-image-2
/// behind ChatGPT Plus accounts via this endpoint. The mainline `model` field is
/// what the relay routes on; the image model itself is fixed by the tool.
/// 200 响应里的 `error` 字段到底算不算一次失败。
///
/// **不能只看字段在不在**。很多中转站成功时也带一个 `"error": null`，而
/// `Value::get("error")` 对 null 返回 `Some(&Value::Null)`——原来的
/// `if let Some(err) = v.get("error")` 于是把一次**成功的生图**判成「上游报错:
/// unknown」，把图扔掉、再去下一个端点画一张。既丢结果又多花一份钱。
/// `"error": {}` 同理。
///
/// 判据改成「能不能取出一条**非空的错误消息**」：取不出来就当它没报错，
/// 继续往下找图。
fn upstream_error_message(v: &serde_json::Value) -> Option<String> {
    let e = v.get("error")?;
    if e.is_null() {
        return None;
    }
    let msg = e["message"]
        .as_str()
        .or_else(|| e["msg"].as_str())
        .or_else(|| e["detail"].as_str())
        .or_else(|| e.as_str())
        .map(str::trim)
        .filter(|m| !m.is_empty());
    if let Some(m) = msg {
        return Some(m.to_string());
    }
    // 没有可读的 message 时，只有对象里**确实还带着别的东西**才算报错。
    // `{"message":"   "}` 不算（只有一个空白消息，等于什么都没说），
    // `{"code":42}` 算（上游确实标了点什么）。空对象、空串一律不算。
    let obj = e.as_object()?;
    let informative = obj.values().any(|v| match v {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.trim().is_empty(),
        _ => true,
    });
    if informative {
        Some(e.to_string())
    } else {
        None
    }
}

/// 一次生图尝试的失败，带一条**关键的**信息：上游有没有可能已经画了。
///
/// generate_image_chat 依次试三个端点（images / responses / chat），本意是照顾
/// 那些只实现了其中一条路的中转站。问题在于原来三个函数都返回 `String`，调用方
/// 分不出「这条路在这台中转站上不存在」和「200 回来了但我解析不出图」——后者
/// 意味着**上游已经画完并计费**，而代码照样换个端点再画一次、再一次。
/// 用户按一次生图，账单上是三张；最坏情况下还要等 180s×3。
///
/// `billed = true` 表示请求已经打进上游、图很可能已经出了，绝不能再换端点重画。
#[derive(Debug)]
pub(crate) struct ImageAttemptError {
    pub(crate) billed: bool,
    pub(crate) msg: String,
}

impl ImageAttemptError {
    /// 这条路在这台中转站上走不通，换下一条是安全的（没画，没计费）。
    fn route(msg: impl Into<String>) -> Self {
        Self { billed: false, msg: msg.into() }
    }
    /// 上游可能已经出图并计费——到此为止，别再换端点。
    fn billed(msg: impl Into<String>) -> Self {
        Self { billed: true, msg: msg.into() }
    }
}

impl std::fmt::Display for ImageAttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

/// 发请求这一步失败了。
///
/// 连不上 = 这个端点在这台中转站上根本不存在，换下一个是对的。
/// **超时不一样**：请求已经打进去了，上游很可能正在画——这时候换端点重来
/// 就是花两份钱等两遍。网关那边的计费路径也是按这条规矩写的。
///
/// 实测过 reqwest 0.12 的分类边界（2026-08-20，本机）：
///   NXDOMAIN            → is_connect = true
///   连接被拒            → is_connect = true
///   连上了但不回        → is_connect = false, is_timeout = true
///   主机不可达超时      → is_connect = false, is_timeout = true   ← 和上一条无法区分
/// 最后两条在客户端这边长得**完全一样**，所以这里判断不了「到底画没画」。
/// 试过给客户端加 connect_timeout 想把连接阶段单独分出来——**更糟**：两种情况
/// 双双塌成 `connect=false, timeout=false` 的 "connection closed before message
/// completed"，连 is_timeout 都不再触发。所以不加，别再往这个方向改。
///
/// 分不出来的时候按「可能已计费」处理（宁可少画一张，不肯多收一次钱），
/// 但**文案不能把猜测说成事实**：不知道就说不知道。
fn image_send_error(stage: &str, e: reqwest::Error) -> ImageAttemptError {
    if e.is_connect() {
        ImageAttemptError::route(format!("{stage} 请求失败（没连上，上游没收到这次请求）: {e}"))
    } else {
        ImageAttemptError::billed(format!(
            "{stage} 请求发出后没拿到完整响应，**判断不了上游有没有出图**\
             （连接阶段就超时、和上游正在画，在客户端这边长得一样）。\
             按可能已计费处理，不再换端点重画: {e}"
        ))
    }
}

/// 非 2xx。4xx = 请求被挡在出图之前（路由不存在、模型名不认、鉴权、限流），
/// 换端点安全。5xx 说不准，上游可能画完了才炸——宁可不重画。
fn image_http_error(stage: &str, status: reqwest::StatusCode, text: &str) -> ImageAttemptError {
    let msg = format!(
        "{stage} HTTP {}: {}",
        status.as_u16(),
        text.chars().take(200).collect::<String>()
    );
    if status.is_client_error() {
        ImageAttemptError::route(msg)
    } else {
        ImageAttemptError::billed(msg)
    }
}

async fn try_responses_api(
    client: &reqwest::Client,
    b: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    size: &str,
    request_id: Option<&str>,
) -> Result<(Vec<u8>, String), ImageAttemptError> {
    let url = if b.ends_with("/v1") {
        format!("{b}/responses")
    } else {
        format!("{b}/v1/responses")
    };
    let body = serde_json::json!({
        "model": model.trim(),
        "input": prompt,
        "tools": [{
            "type": "image_generation",
            "size": size,
            "quality": "high",
            "output_format": "png",
        }],
    });
    let resp = with_ide_request_id(client.post(&url).bearer_auth(api_key.trim()), request_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| image_send_error("responses", e))?;
    let status = resp.status();
    let text = response_text_limited(
        resp,
        if status.is_success() {
            MAX_IMAGE_API_JSON_BYTES
        } else {
            MAX_IMAGE_ERROR_BYTES
        },
        "responses",
    )
    .await
    // 读响应体失败。4xx 时读的是错误体（没出图）；否则 200 已经回来了。
    .map_err(|e| if status.is_client_error() {
        ImageAttemptError::route(e)
    } else {
        ImageAttemptError::billed(format!("{e}（响应已开始返回，上游可能已出图）"))
    })?;
    if !status.is_success() {
        return Err(image_http_error("responses", status, &text));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ImageAttemptError::billed(format!("responses 解析失败（200 已回，上游可能已出图）: {e}")))?;
    // 有一条**非空**的错误消息才算上游拒了——`"error": null` / `"error": {}` 是
    // 成功响应里的常见噪声，当成报错会把已经出好的图扔掉并去下一个端点重画。
    if let Some(msg) = upstream_error_message(&v) {
        // 上游明确拒了这次请求，通常在出图之前（模型名不认、内容策略、参数不合法）。
        // 这种可以换端点：同一个模型在中转站上往往只有某一条路支持。
        return Err(ImageAttemptError::route(format!(
            "responses 上游报错: {}",
            msg.chars().take(200).collect::<String>()
        )));
    }
    // Walk the output array for an image_generation_call item with a base64 result.
    let output = v.get("output").and_then(|o| o.as_array());
    if let Some(arr) = output {
        for item in arr {
            if item["type"] == "image_generation_call" {
                if let Some(b64) = item["result"].as_str().or(item["b64_json"].as_str()) {
                    let raw = if b64.contains(',') {
                        b64.split_once(',').map(|x| x.1).unwrap_or(b64)
                    } else {
                        b64
                    };
                    let bytes = b64_decode_limited(raw, MAX_IMAGE_BYTES)
                        .map_err(|error| ImageAttemptError::billed(format!("responses base64 解码失败（图已生成但取不出来）: {error}")))?;
                    return Ok((bytes, "image/png".into()));
                }
                if let Some(raw_url) = item["url"].as_str() {
                    let img_url = if raw_url.starts_with('/') {
                        format!("{}{}", b.trim_end_matches("/v1"), raw_url)
                    } else {
                        raw_url.to_string()
                    };
                    let r = client
                        .get(&img_url)
                        .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0")
                        .send()
                        .await
                        .map_err(|e| ImageAttemptError::billed(format!("下载生成图失败（图已生成）: {e}")))?;
                    if !r.status().is_success() {
                        return Err(ImageAttemptError::billed(format!("下载生成图 HTTP {}（图已生成）", r.status().as_u16())));
                    }
                    return generated_image_response(r, "下载生成图")
                        .await
                        .map_err(|e| ImageAttemptError::billed(format!("{e}（图已生成）")));
                }
            }
            // Some relays return image as a message-content image_url instead.
            if item["type"] == "message" {
                if let Some(content) = item["content"].as_array() {
                    for part in content {
                        if part["type"] == "output_image" || part["type"] == "image" {
                            if let Some(b64) = part["b64_json"].as_str().or(part["image"].as_str())
                            {
                                let raw = if b64.contains(',') {
                                    b64.split_once(',').map(|x| x.1).unwrap_or(b64)
                                } else {
                                    b64
                                };
                                let bytes =
                                    b64_decode_limited(raw, MAX_IMAGE_BYTES).map_err(|error| {
                                        ImageAttemptError::billed(format!(
                                            "responses base64 解码失败（图已生成但取不出来）: {error}"
                                        ))
                                    })?;
                                return Ok((bytes, "image/png".into()));
                            }
                        }
                    }
                }
            }
        }
    }
    Err(ImageAttemptError::billed(format!(
        "responses 响应里没有 image_generation_call 结果（200 已回，上游可能已出图）。片段：{}",
        text.chars().take(150).collect::<String>()
    )))
}

/// gpt-image / dall-e only accept a fixed size set — an unsupported size makes the
/// Images API 400 and the whole call degrade to the flaky text routes. Snap to the
/// nearest supported size (landscape/portrait/square) instead of passing raw pixels.
fn image_size_for_model(model: &str, width: Option<u32>, height: Option<u32>) -> String {
    match (width, height) {
        (Some(w), Some(h)) => {
            let m = model.to_lowercase();
            if m.contains("gpt-image") || m.contains("dall-e") || m.contains("dall_e") {
                if w > h {
                    "1536x1024".to_string()
                } else if h > w {
                    "1024x1536".to_string()
                } else {
                    "1024x1024".to_string()
                }
            } else {
                format!("{w}x{h}")
            }
        }
        _ => "auto".to_string(),
    }
}

/// Try /v1/images/generations. Returns (bytes, mime) or an error string.
async fn try_images_api(
    client: &reqwest::Client,
    b: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    size: &str,
    request_id: Option<&str>,
) -> Result<(Vec<u8>, String), ImageAttemptError> {
    let url = if b.ends_with("/v1") {
        format!("{b}/images/generations")
    } else {
        format!("{b}/v1/images/generations")
    };
    let m_lower = model.to_lowercase();
    let mut body = serde_json::json!({
        "model": model.trim(),
        "prompt": prompt,
        "n": 1,
        "size": size,
        "quality": "high",
        "response_format": "b64_json",
    });
    if m_lower.contains("gpt-image") {
        // gpt-image-* uses output_format instead of response_format, and returns b64 by default
        body.as_object_mut().unwrap().remove("response_format");
        body.as_object_mut()
            .unwrap()
            .insert("output_format".into(), serde_json::json!("png"));
    }
    let resp = with_ide_request_id(client.post(&url).bearer_auth(api_key.trim()), request_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| image_send_error("images-api", e))?;
    let status = resp.status();
    let text = response_text_limited(
        resp,
        if status.is_success() {
            MAX_IMAGE_API_JSON_BYTES
        } else {
            MAX_IMAGE_ERROR_BYTES
        },
        "images-api",
    )
    .await
    // 读响应体失败。4xx 时读的是错误体（没出图）；否则 200 已经回来了。
    .map_err(|e| if status.is_client_error() {
        ImageAttemptError::route(e)
    } else {
        ImageAttemptError::billed(format!("{e}（响应已开始返回，上游可能已出图）"))
    })?;
    if !status.is_success() {
        return Err(image_http_error("images-api", status, &text));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ImageAttemptError::billed(format!("images-api 响应解析失败（200 已回，上游可能已出图）: {e}")))?;
    // 有一条**非空**的错误消息才算上游拒了——`"error": null` / `"error": {}` 是
    // 成功响应里的常见噪声，当成报错会把已经出好的图扔掉并去下一个端点重画。
    if let Some(msg) = upstream_error_message(&v) {
        // 上游明确拒了这次请求，通常在出图之前（模型名不认、内容策略、参数不合法）。
        // 这种可以换端点：同一个模型在中转站上往往只有某一条路支持。
        return Err(ImageAttemptError::route(format!(
            "images-api 上游报错: {}",
            msg.chars().take(200).collect::<String>()
        )));
    }
    let item = &v["data"][0];
    if let Some(b64) = item["b64_json"].as_str().or(item["image"].as_str()) {
        let raw = if b64.contains(',') {
            b64.split_once(',').map(|x| x.1).unwrap_or(b64)
        } else {
            b64
        };
        let bytes = b64_decode_limited(raw, MAX_IMAGE_BYTES)
            .map_err(|error| ImageAttemptError::billed(format!("images-api base64 解码失败（图已生成但取不出来）: {error}")))?;
        Ok((bytes, "image/png".into()))
    } else if let Some(raw_url) = item["url"].as_str() {
        let img_url = if raw_url.starts_with('/') {
            format!("{}{}", b.trim_end_matches("/v1"), raw_url)
        } else {
            raw_url.to_string()
        };
        let r = client
            .get(&img_url)
            .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0")
            .send()
            .await
            .map_err(|e| ImageAttemptError::billed(format!("下载生成图失败（图已生成）: {e}")))?;
        if !r.status().is_success() {
            return Err(ImageAttemptError::billed(format!("下载生成图 HTTP {}（图已生成）", r.status().as_u16())));
        }
        generated_image_response(r, "下载生成图")
            .await
            .map_err(|e| ImageAttemptError::billed(format!("{e}（图已生成）")))
    } else if let Some(task_id) = v.get("task_id").and_then(|t| t.as_str()) {
        // Async task (custom sizes) — poll until completed.
        let poll_url = if b.ends_with("/v1") {
            format!("{b}/images/generations/{task_id}")
        } else {
            format!("{b}/v1/images/generations/{task_id}")
        };
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let pr = client
                .get(&poll_url)
                .bearer_auth(api_key.trim())
                .send()
                .await
                .map_err(|e| ImageAttemptError::billed(format!("轮询生图任务失败（任务已提交）: {e}")))?;
            if !pr.status().is_success() {
                continue;
            }
            let pt: serde_json::Value =
                response_json_limited(pr, MAX_IMAGE_API_JSON_BYTES, "生图轮询")
                    .await
                    .map_err(|e| ImageAttemptError::billed(format!("{e}（任务已提交）")))?;
            let status = pt["status"].as_str().unwrap_or("");
            if status == "failed" {
                // 任务已经排进去跑过了才报 failed——多数中转仍然计费。不换端点重画。
                return Err(ImageAttemptError::billed(format!(
                    "生图任务失败（任务已提交）: {}",
                    pt["error"].as_str().unwrap_or("unknown")
                )));
            }
            if status != "completed" {
                continue;
            }
            if let Some(arr) = pt.get("data").and_then(|d| d.as_array()) {
                if let Some(first) = arr.first() {
                    if let Some(u) = first["url"].as_str() {
                        let full_url = if u.starts_with('/') {
                            format!("{}{}", b.trim_end_matches("/v1"), u)
                        } else {
                            u.to_string()
                        };
                        let dr = client
                            .get(&full_url)
                            .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0")
                            .send()
                            .await
                            .map_err(|e| ImageAttemptError::billed(format!("下载生成图失败（图已生成）: {e}")))?;
                        if !dr.status().is_success() {
                            return Err(ImageAttemptError::billed(format!("下载生成图 HTTP {}（图已生成）", dr.status().as_u16())));
                        }
                        return generated_image_response(dr, "下载生成图")
                            .await
                            .map_err(|e| ImageAttemptError::billed(format!("{e}（图已生成）")));
                    }
                }
            }
            return Err(ImageAttemptError::billed(
                "生图任务报了 completed 却没有图片数据（已计费）".to_string(),
            ));
        }
        Err(ImageAttemptError::billed(
            "生图任务超时（轮询 3 分钟未完成；任务已提交并计费，不再换端点重画）".to_string(),
        ))
    } else {
        Err(ImageAttemptError::billed(format!(
            "images-api 返回的 data 里没有 b64_json 或 url（200 已回，上游可能已出图）。响应片段：{}",
            text.chars().take(150).collect::<String>()
        )))
    }
}

/// Try /v1/chat/completions for chat-wrapped image gen (中转站 routes ChatGPT Plus
/// account image generation through this endpoint).
async fn try_chat_image_api(
    client: &reqwest::Client,
    b: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    request_id: Option<&str>,
) -> Result<(Vec<u8>, String), ImageAttemptError> {
    let url = if b.ends_with("/v1") {
        format!("{b}/chat/completions")
    } else {
        format!("{b}/v1/chat/completions")
    };
    let body = serde_json::json!({
        "model": model.trim(),
        // 一律走 SSE：中转对同步请求是整段生成完才回（用户控制台里这些请求类型写着"同步"）。
        // 出图本身耗时在生成，不在传输，但同步请求在这条中转上还要额外排队。
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 1500,
    });
    let resp = with_ide_request_id(client.post(&url).bearer_auth(api_key.trim()), request_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| image_send_error("chat", e))?;
    let status = resp.status();
    let text = response_text_limited(
        resp,
        if status.is_success() {
            MAX_IMAGE_API_JSON_BYTES
        } else {
            MAX_IMAGE_ERROR_BYTES
        },
        "chat",
    )
    .await
    // 读响应体失败。4xx 时读的是错误体（没出图）；否则 200 已经回来了。
    .map_err(|e| if status.is_client_error() {
        ImageAttemptError::route(e)
    } else {
        ImageAttemptError::billed(format!("{e}（响应已开始返回，上游可能已出图）"))
    })?;
    if !status.is_success() {
        return Err(image_http_error("chat", status, &text));
    }
    // SSE 回来的是一串增量。**不能只拼文本**：extract_image_ref 还要读 message.images
    // 这类非文本字段，只拼字符串会把图丢掉、然后报"回复里没找到图片"。所以把增量合并回
    // 一个完整的 choices[0].message 再交给它。中转若无视 stream:true 直接回 JSON，
    // merge_sse_chat_message 返回 None，走下面原来的整体解析。
    let v: serde_json::Value = match merge_sse_chat_message(&text) {
        Some(merged) => merged,
        None => serde_json::from_str(&text).map_err(|e| ImageAttemptError::billed(format!("chat 响应解析失败（200 已回，上游可能已出图）: {e}")))?,
    };
    let img = extract_image_ref(&v).ok_or_else(|| {
        let snippet: String = v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(150)
            .collect();
        // 200 回来了、只是没在里面找到图——上游多半已经画了并计费，不换端点重画。
        ImageAttemptError::billed(format!("chat 回复里没找到图片（200 已回）：{snippet}"))
    })?;
    if img.starts_with("data:") {
        let comma = img
            .find(',')
            .ok_or_else(|| ImageAttemptError::billed("data URL 无效（图已生成）".to_string()))?;
        let meta = &img[5..comma];
        let m = meta.split(';').next().unwrap_or("image/png").to_string();
        let data = &img[comma + 1..];
        Ok((
            b64_decode_limited(data, MAX_IMAGE_BYTES)
                .map_err(|error| ImageAttemptError::billed(format!("base64 解码失败（图已生成但取不出来）: {error}")))?,
            m,
        ))
    } else if img.starts_with("http://") || img.starts_with("https://") {
        let r = client
            .get(&img)
            .header(reqwest::header::USER_AGENT, "Michael-IDE-Agent/1.0")
            .send()
            .await
            .map_err(|e| ImageAttemptError::billed(format!("下载生成图失败（图已生成）: {e}")))?;
        if !r.status().is_success() {
            return Err(ImageAttemptError::billed(format!("下载生成图 HTTP {}（图已生成）", r.status().as_u16())));
        }
        generated_image_response(r, "下载生成图")
            .await
            .map_err(|e| ImageAttemptError::billed(format!("{e}（图已生成）")))
    } else {
        Err(ImageAttemptError::billed(
            "无法识别模型返回的图片引用（200 已回，上游可能已出图）".to_string(),
        ))
    }
}

/// Pull an image reference out of a chat-completions response (string content with
/// markdown/URL/data-URL, multimodal image_url parts, or an `images[]` field).
/// 把一段 SSE 原文合并回 `{"choices":[{"message":{...}}]}` 的形状。
///
/// 只拼 `delta.content` 是不够的：出图的中转经常把图片放在 `images`、或者把 content 发成
/// 分片数组。丢了那些字段的表现是"回复里没找到图片"——看起来像模型没出图，其实是解析丢了。
/// 不是 SSE（中转无视了 stream:true）时返回 None，让调用方按普通 JSON 解析。
fn merge_sse_chat_message(text: &str) -> Option<serde_json::Value> {
    let mut saw_frame = false;
    let mut content = String::new();
    let mut message = serde_json::Map::new();
    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            saw_frame = true;
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        saw_frame = true;
        let delta = &v["choices"][0]["delta"];
        if let Some(t) = delta["content"].as_str() {
            content.push_str(t);
        }
        // 文本以外的字段（images / 分片数组形式的 content / tool 之类）原样保留：
        // 后到的覆盖先到的，缺省不动。
        if let Some(obj) = delta.as_object() {
            for (k, val) in obj {
                if k == "content" && val.is_string() {
                    continue;
                }
                if !val.is_null() {
                    message.insert(k.clone(), val.clone());
                }
            }
        }
    }
    if !saw_frame {
        return None;
    }
    if !content.is_empty() {
        message.insert("content".into(), serde_json::Value::String(content));
    }
    Some(serde_json::json!({ "choices": [{ "message": serde_json::Value::Object(message) }] }))
}

fn extract_image_ref(v: &serde_json::Value) -> Option<String> {
    let msg = &v["choices"][0]["message"];
    if let Some(s) = msg["content"].as_str() {
        if let Some(u) = find_image_in_text(s) {
            return Some(u);
        }
    }
    if let Some(arr) = msg["content"].as_array() {
        for part in arr {
            if part["type"] == "image_url" {
                if let Some(u) = part["image_url"]["url"].as_str() {
                    return Some(u.to_string());
                }
            }
            if let Some(s) = part["text"].as_str() {
                if let Some(u) = find_image_in_text(s) {
                    return Some(u);
                }
            }
        }
    }
    if let Some(arr) = msg["images"].as_array() {
        if let Some(f) = arr.first() {
            if let Some(u) = f.as_str() {
                return Some(u.to_string());
            }
            if let Some(u) = f["url"].as_str() {
                return Some(u.to_string());
            }
            if let Some(u) = f["image_url"]["url"].as_str() {
                return Some(u.to_string());
            }
        }
    }
    None
}

fn find_image_in_text(s: &str) -> Option<String> {
    if let Some(i) = s.find("data:image/") {
        let rest = &s[i..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }
    if let Some(i) = s.find("](") {
        let rest = &s[i + 2..];
        if let Some(end) = rest.find(')') {
            let u = rest[..end].trim();
            if u.starts_with("http") || u.starts_with("data:") {
                return Some(u.to_string());
            }
        }
    }
    if let Some(i) = s.find("http") {
        let rest = &s[i..];
        if rest.starts_with("http://") || rest.starts_with("https://") {
            let end = rest
                .find(|c: char| {
                    c.is_whitespace()
                        || c == ')'
                        || c == '"'
                        || c == '\''
                        || c == '>'
                        || c == ']'
                        || c == '('
                })
                .unwrap_or(rest.len());
            return Some(rest[..end].to_string());
        }
    }
    None
}

/// Minimal standard-base64 decoder (no external crate; capture.rs only has an encoder).
/// The permissive handling of non-base64 characters matches the prior decoder, but
/// the output limit prevents a large data URL from allocating without bound.
fn b64_decode_limited(s: &str, limit: usize) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> i16 {
        match c {
            b'A'..=b'Z' => (c - b'A') as i16,
            b'a'..=b'z' => (c - b'a' + 26) as i16,
            b'0'..=b'9' => (c - b'0' + 52) as i16,
            b'+' => 62,
            b'/' => 63,
            _ => -1,
        }
    }
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.trim().as_bytes() {
        if c == b'=' {
            break;
        }
        let dv = val(c);
        if dv < 0 {
            continue;
        }
        buf = (buf << 6) | dv as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if out.len() >= limit {
                return Err(format!("解码结果超过 {limit} 字节上限"));
            }
            out.push((buf >> bits) as u8);
        }
    }
    if out.is_empty() {
        Err("解码结果为空".into())
    } else {
        Ok(out)
    }
}

#[cfg(test)]
mod img_tests {
    /// 工作区里一个指向外部的目录符号链接，不许把下载写到工作区外面。
    ///
    /// 原来的边界是 `target.starts_with(base)` —— 纯字符串比较。git 能原样存任意 symlink
    /// 目标，所以 clone 一个仓库就能把 `assets -> ~/Library/LaunchAgents` 带进来；
    /// 之后仓库里的文本诱导模型 `download_file(dest:"assets/x.plist")`，字面上它就在
    /// root 底下、两道检查全过，写下去却落在工作区之外。这是仓库内容就能诱导的越界写。
    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_workspace_cannot_redirect_a_download_outside_it() {
        use std::os::unix::fs::symlink;

        // **不能用临时目录做逃逸目标。** 临时目录是刻意放行的暂存空间
        // （files.rs 的 has_safe_prefix 会提前返回 Ok），拿它当"外面"测不出任何东西。
        // 真实场景逃向的是 ~/Library/LaunchAgents 这类地方，所以这里两边都放在仓库的
        // target/ 下面：它在 HOME 之内（读可以）但不在任何**已打开的工作区**里，
        // 正是写操作该被拒的那种位置。
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("mi-dl-escape-{}", std::process::id()));
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        let _ = std::fs::remove_dir_all(&parent);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("assets")).unwrap();

        crate::files::register_workspace_root(root.to_string_lossy().into_owned()).unwrap();

        // 穿过符号链接 → 必须被拒。
        let escaped = super::resolve_download_target(
            &root.to_string_lossy(),
            "assets/evil.plist",
        );
        assert!(
            escaped.is_err(),
            "符号链接把下载引到了工作区外面：{:?}",
            escaped.map(|p| p.display().to_string()),
        );

        // 正常的工作区内路径仍然放行，别把边界收得连自己都用不了。
        let ok = super::resolve_download_target(&root.to_string_lossy(), "sub/fine.txt");
        assert!(ok.is_ok(), "工作区内的正常目标被误拒：{ok:?}");

        // `..` 仍然当场拒绝，给的是更清楚的那条错。
        assert!(super::resolve_download_target(&root.to_string_lossy(), "../evil").is_err());

        let _ = std::fs::remove_dir_all(&parent);
    }


    /// SSE 合并不能只拼文本：出图的中转常把图片放在 images 字段或分片 content 里，
    /// 丢了它们的表现是"回复里没找到图片"——看着像模型没出图，其实是解析把它扔了。
    #[test]
    fn sse_merge_keeps_non_text_fields() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"生成好了：\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"images\":[{\"url\":\"https://x.test/a.png\"}]}}]}\n",
            "data: [DONE]\n",
        );
        let merged = merge_sse_chat_message(body).expect("应认出这是 SSE");
        assert_eq!(merged["choices"][0]["message"]["content"], "生成好了：");
        assert_eq!(
            extract_image_ref(&merged).as_deref(),
            Some("https://x.test/a.png")
        );
    }

    /// 中转无视 stream:true、直接回 JSON 时返回 None，让调用方按整体 JSON 解析——
    /// 没有这条兜底，那些线路会整个用不了。
    #[test]
    fn sse_merge_returns_none_for_plain_json() {
        let body = r#"{"choices":[{"message":{"content":"https://x.test/b.png"}}]}"#;
        assert!(merge_sse_chat_message(body).is_none());
    }

    /// 纯文本增量：图片地址写在正文里的那种中转。
    #[test]
    fn sse_merge_assembles_text_only_frames() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"https://x.test/\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"c.png\"}}]}\n",
            "data: [DONE]\n",
        );
        let merged = merge_sse_chat_message(body).unwrap();
        assert_eq!(
            extract_image_ref(&merged).as_deref(),
            Some("https://x.test/c.png")
        );
    }
    use super::*;
    use serde_json::json;

    fn response_with_body(body: Vec<u8>) -> reqwest::Response {
        reqwest::Response::from(http::Response::new(body))
    }

    fn response_with_streamed_body(body: Vec<u8>) -> reqwest::Response {
        let stream = futures_util::stream::iter([Ok::<Vec<u8>, std::io::Error>(body)]);
        reqwest::Response::from(http::Response::new(reqwest::Body::wrap_stream(stream)))
    }

    fn test_directory(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("michael-ide-net-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[tokio::test]
    async fn response_bytes_limited_reads_normal_body_and_rejects_oversized_body() {
        let body = b"normal body".to_vec();
        assert_eq!(
            response_bytes_limited(response_with_body(body.clone()), body.len(), "测试")
                .await
                .unwrap(),
            body
        );

        let response = response_with_streamed_body(vec![7; 17]);
        assert_eq!(response.content_length(), None);
        let error = response_bytes_limited(response, 16, "测试")
            .await
            .unwrap_err();
        assert!(error.contains("16 字节"), "{error}");
    }

    #[tokio::test]
    async fn streaming_download_replaces_target_after_complete_body() {
        let directory = test_directory("replace");
        let target = directory.join("download.bin");
        std::fs::write(&target, b"old").unwrap();
        let body = b"new download".to_vec();

        let written =
            stream_response_to_path(response_with_body(body.clone()), &target, 1024, "too large")
                .await
                .unwrap();

        assert_eq!(written, body.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), body);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn streaming_download_preserves_existing_target_and_cleans_temp_on_overflow() {
        let directory = test_directory("overflow");
        let target = directory.join("download.bin");
        std::fs::write(&target, b"old").unwrap();

        let error = stream_response_to_path(
            response_with_streamed_body(vec![9; 17]),
            &target,
            16,
            "too large",
        )
        .await
        .unwrap_err();

        assert_eq!(error, "too large");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        let has_temporary_file = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".michael-download-")
            });
        assert!(!has_temporary_file);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn b64_decode_limited_rejects_output_over_limit() {
        assert_eq!(b64_decode_limited("TWFu", 3).unwrap(), b"Man");
        assert!(b64_decode_limited("TWFu", 2)
            .unwrap_err()
            .contains("超过 2 字节上限"));
    }

    #[tokio::test]
    async fn validate_accepts_loopback_without_blocking_the_async_command() {
        let url = validate("http://127.0.0.1:3000").await.unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
    }

    #[test]
    fn image_size_snaps_to_supported_set_for_gpt_image() {
        assert_eq!(
            image_size_for_model("gpt-image-2", Some(2048), Some(2048)),
            "1024x1024"
        );
        assert_eq!(
            image_size_for_model("gpt-image-2", Some(1920), Some(1080)),
            "1536x1024"
        );
        assert_eq!(
            image_size_for_model("dall-e-3", Some(800), Some(1200)),
            "1024x1536"
        );
    }

    #[test]
    fn image_size_passes_through_for_other_models_and_defaults_to_auto() {
        assert_eq!(
            image_size_for_model("flux-pro", Some(1920), Some(1080)),
            "1920x1080"
        );
        assert_eq!(image_size_for_model("gpt-image-2", None, None), "auto");
    }

    #[test]
    fn extract_markdown_url() {
        let v = json!({"choices":[{"message":{"content":"好的，这是图：\n![mockup](https://cdn.example.com/a/b.png)"}}]});
        assert_eq!(
            extract_image_ref(&v).as_deref(),
            Some("https://cdn.example.com/a/b.png")
        );
    }
    #[test]
    fn extract_bare_url() {
        let v =
            json!({"choices":[{"message":{"content":"生成完成 https://img.test/xyz.jpg 请查收"}}]});
        assert_eq!(
            extract_image_ref(&v).as_deref(),
            Some("https://img.test/xyz.jpg")
        );
    }
    #[test]
    fn extract_multimodal_image_url() {
        let v = json!({"choices":[{"message":{"content":[{"type":"text","text":"done"},{"type":"image_url","image_url":{"url":"https://m.test/i.webp"}}]}}]});
        assert_eq!(
            extract_image_ref(&v).as_deref(),
            Some("https://m.test/i.webp")
        );
    }
    #[test]
    fn extract_data_url() {
        let v = json!({"choices":[{"message":{"content":"data:image/png;base64,iVBORw0KG=="}}]});
        assert_eq!(
            extract_image_ref(&v).as_deref(),
            Some("data:image/png;base64,iVBORw0KG==")
        );
    }
    #[test]
    fn extract_images_field() {
        let v = json!({"choices":[{"message":{"content":"","images":[{"url":"https://x.test/p.png"}]}}]});
        assert_eq!(
            extract_image_ref(&v).as_deref(),
            Some("https://x.test/p.png")
        );
    }
    #[test]
    fn no_image_in_plain_text() {
        let v = json!({"choices":[{"message":{"content":"我没法生成图片。"}}]});
        assert_eq!(extract_image_ref(&v), None);
    }
    #[test]
    fn b64_roundtrip() {
        // "Man" → "TWFu"
        assert_eq!(b64_decode_limited("TWFu", 3).unwrap(), b"Man");
        assert_eq!(b64_decode_limited("aGVsbG8=", 5).unwrap(), b"hello");
    }

    #[test]
    fn redirect_target_resolves_relative_location() {
        let base = reqwest::Url::parse("https://www.4399.com/flash/5.htm").unwrap();
        assert_eq!(
            redirect_target(&base, Some("/flash/5_1.htm")).as_deref(),
            Some("https://www.4399.com/flash/5_1.htm")
        );
        assert_eq!(
            redirect_target(&base, Some("https://www.taptap.cn/app/1")).as_deref(),
            Some("https://www.taptap.cn/app/1")
        );
    }

    #[test]
    fn decode_legacy_chinese_charsets() {
        let (text, enc) =
            decode_body_text(vec![0xD6, 0xD0, 0xCE, 0xC4], "text/html; charset=gb2312");
        assert_eq!(text, "中文");
        assert!(enc.contains("GB"));
    }

    #[test]
    fn decode_charset_from_html_meta() {
        let mut body = b"<html><head><meta charset=\"gbk\"></head><body>".to_vec();
        body.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]);
        body.extend_from_slice(b"</body></html>");
        let (text, enc) = decode_body_text(body, "text/html");
        assert!(text.contains("中文"));
        assert!(enc.contains("GB"));
    }
}

#[cfg(test)]
mod download_overwrite_tests {
    use super::*;

    #[test]
    fn download_refuses_to_replace_an_existing_file() {
        let dir = std::env::temp_dir().join("mrday-dl-guard");
        let _ = std::fs::create_dir_all(&dir);
        let existing = dir.join("main.js");
        std::fs::write(&existing, "// 用户的代码").unwrap();

        let err = refuse_existing_download_target(&existing).unwrap_err();
        assert!(err.contains("已经存在"), "{err}");
        // 报错必须说清下一步怎么办，否则模型只会换个工具再试一次同一件事。
        assert!(err.contains("delete_path"), "{err}");
        // 文件必须原样还在。
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "// 用户的代码");

        // 不存在的路径照旧放行——这道闸只挡覆盖，不挡下载。
        refuse_existing_download_target(&dir.join("new.bin")).unwrap();
        // 目录不挡：create_dir_all 本来就允许它已存在。
        refuse_existing_download_target(&dir).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod image_billing_tests {
    use super::{image_http_error, ImageAttemptError};

    /// 4xx = 请求在出图之前就被挡了（路由不存在、模型名不认、鉴权、限流）——
    /// 换端点安全，这正是三端点级联存在的理由。
    #[test]
    fn client_errors_may_fall_through_to_the_next_endpoint() {
        for code in [400u16, 401, 403, 404, 405, 429] {
            let e = image_http_error(
                "images-api",
                reqwest::StatusCode::from_u16(code).unwrap(),
                "nope",
            );
            assert!(!e.billed, "HTTP {code} 被当成已计费，级联白白断了");
        }
    }

    /// 5xx 说不准：上游可能画完了才炸。宁可不重画。
    #[test]
    fn server_errors_do_not_trigger_a_redraw() {
        for code in [500u16, 502, 503, 504] {
            let e = image_http_error(
                "images-api",
                reqwest::StatusCode::from_u16(code).unwrap(),
                "boom",
            );
            assert!(e.billed, "HTTP {code} 会去换端点重画一次");
        }
    }

    /// 这条是审计里那一条的核心：级联必须看 billed，不能「上一条 Err 就试下一条」。
    /// 生成路径没法在单测里发真请求，所以钉住级联那段源码的结构。
    #[test]
    fn the_cascade_stops_on_a_billed_failure() {
        let src = include_str!("net.rs");
        let body = src
            .split("pub async fn generate_image_chat(")
            .nth(1)
            .and_then(|s| s.split("\n    if bytes.is_empty()").next())
            .expect("generate_image_chat 的级联段不见了");
        assert!(
            body.contains("Err(e0) if e0.billed => return Err(e0.msg)"),
            "第一条端点算过账了还会去试第二条 —— 用户一次生图付两次钱"
        );
        assert!(
            body.contains("Err(e1) if e1.billed =>"),
            "第二条端点算过账了还会去试第三条"
        );
    }

    /// 200 之后的每一种解析失败都必须算「可能已计费」。
    #[test]
    fn post_two_hundred_failures_are_all_billed() {
        let src = include_str!("net.rs");
        for needle in [
            "images-api 响应解析失败（200 已回",
            "images-api 返回的 data 里没有 b64_json 或 url（200 已回",
            "responses 响应里没有 image_generation_call 结果（200 已回",
            "chat 回复里没找到图片（200 已回",
            "生图任务超时（轮询 3 分钟未完成",
        ] {
            let at = src.find(needle).unwrap_or_else(|| panic!("{needle} 不见了"));
            let before = &src[at.saturating_sub(220)..at];
            assert!(
                before.contains("ImageAttemptError::billed"),
                "「{needle}」没被算成可能已计费 —— 会触发换端点重画"
            );
        }
    }

    /// 超时**不是**免费的重试机会：请求已经打进去了，上游很可能正在画。
    /// 构造不出真的 reqwest::Error，就钉住分支结构——只有「连不上」那一支
    /// 允许换端点。网关那边的计费路径也是按同一条规矩写的。
    #[test]
    fn a_timeout_is_not_a_free_retry() {
        let src = include_str!("net.rs");
        let body = src
            .split("fn image_send_error(")
            .nth(1)
            .and_then(|s| s.split("\n}\n").next())
            .expect("image_send_error 的函数体不见了");
        let (connect_arm, rest) = body
            .split_once("} else {")
            .expect("is_connect 的分支结构变了，这条断言的前提得重算");
        assert!(
            connect_arm.contains("if e.is_connect() {")
                && connect_arm.contains("ImageAttemptError::route"),
            "连不上不再算「这条路不存在」，级联白白断了"
        );
        assert!(
            rest.contains("ImageAttemptError::billed") && !rest.contains("ImageAttemptError::route"),
            "超时 / 读响应体失败被当成可以免费换端点重试 —— 那是让用户为一次生图付两次钱"
        );
        // 分不出来就不能把猜测说成事实：主机不可达的连接超时，和上游正在画，
        // 在 reqwest 这边长得完全一样（实测见函数文档）。这时候说「上游可能已经
        // 出图并计费」，对一个域名都没连上的失败来说就是一句假话。
        assert!(
            rest.contains("判断不了上游有没有出图"),
            "分不出来的情况被写成了断言式的「已经出图并计费」"
        );
        assert!(
            !rest.contains("上游可能已经出图并计费"),
            "又把猜测写成了结论"
        );
    }

    /// `"error": null` 是成功响应里的常见噪声。原来 `if let Some(err) = v.get("error")`
    /// 对它返回 Some，于是一次**成功的生图**被判成「上游报错: unknown」，图被扔掉，
    /// 再去下一个端点画一张——既丢结果又多花一份钱。
    #[test]
    fn a_null_error_field_is_not_an_error() {
        let ok = serde_json::json!({"error": null, "data": [{"b64_json": "AAA"}]});
        assert_eq!(super::upstream_error_message(&ok), None, "error:null 被当成了报错");
        let empty = serde_json::json!({"error": {}, "data": [{"b64_json": "AAA"}]});
        assert_eq!(super::upstream_error_message(&empty), None, "空 error 对象被当成了报错");
        let blank = serde_json::json!({"error": {"message": "   "}});
        assert_eq!(super::upstream_error_message(&blank), None, "空白 message 被当成了报错");
        let none = serde_json::json!({"data": []});
        assert_eq!(super::upstream_error_message(&none), None);

        // 真的报错要认出来，消息要取到。
        assert_eq!(
            super::upstream_error_message(&serde_json::json!({"error": {"message": "bad model"}})),
            Some("bad model".to_string())
        );
        assert_eq!(
            super::upstream_error_message(&serde_json::json!({"error": "quota exceeded"})),
            Some("quota exceeded".to_string())
        );
        assert!(super::upstream_error_message(
            &serde_json::json!({"error": {"code": 42}})
        )
        .is_some(), "对象里有东西却没被当成报错");

        // 接线：两条 200 路径都必须走这个判据，不能再裸用 v.get("error")。
        // **先剥注释**——上面那段文档注释里就原样引着 `v.get("error")`，
        // 不剥的话这条负向断言会被自己要守的那段代码的注释喂饱（刚踩过一次）。
        let src = include_str!("net.rs");
        let code_only: String = src
            .split("#[cfg(test)]")
            .next()
            .unwrap_or(src)
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let prod = code_only.as_str();
        assert_eq!(
            prod.matches("if let Some(msg) = upstream_error_message(&v)").count(),
            2,
            "有 200 路径没接上这个判据"
        );
        assert!(
            !prod.contains("if let Some(err) = v.get(\"error\")"),
            "又裸用 v.get(\"error\") 了 —— error:null 会把成功的图扔掉"
        );
    }

    #[test]
    fn display_keeps_the_message() {
        assert_eq!(ImageAttemptError::route("x").to_string(), "x");
    }
}
