//! Autonomous browser control for the AI agent: a persistent headless Chrome it
//! can drive end-to-end — navigate, click, type, run JS — and SEE (every action
//! returns a fresh screenshot + the page's visible text). This is what lets the
//! agent test the web apps it builds, fill forms, and browse on its own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// Whether to draw the visible Set-of-Mark number badges. ON for normal agent
/// browsing (visual grounding), but turned OFF while recording a user-facing demo
/// so the captured frames stay clean (refs are still tagged for click-by-index).
static DRAW_MARKS: AtomicBool = AtomicBool::new(true);

use headless_chrome::protocol::cdp::{
    Emulation::SetDeviceMetricsOverride,
    Page::{AddScriptToEvaluateOnNewDocument, CaptureScreenshotFormatOption},
    Performance::{Enable as EnablePerformanceMetrics, GetMetrics},
};
use crate::human_input;
use headless_chrome::browser::tab::point::Point;
use headless_chrome::{Browser, LaunchOptionsBuilder, Tab};
use serde::{Deserialize, Serialize};

/// 上一次鼠标落点（页面坐标）。人类化点击从这里起手画一条轨迹到目标，而不是瞬移。
/// 进程内所有 tab 共用——够用，因为一次只有一个当前 tab 在被驱动。
static LAST_MOUSE: LazyLock<Mutex<Option<(f64, f64)>>> = LazyLock::new(|| Mutex::new(None));

struct Session {
    _browser: Browser, // kept alive so the child process & connection survive
    tab: Arc<Tab>,
}

/// The state lock protects only which browser session is current. It must never
/// cover CDP calls, screenshots, or process teardown: all of those can block for
/// seconds. `generation` prevents a launch that began before a concurrent close
/// from installing a session after that close has already completed.
#[derive(Default)]
struct BrowserStore {
    session: Option<Session>,
    generation: u64,
}

impl BrowserStore {
    fn invalidate(&mut self) -> Option<Session> {
        self.generation = self.generation.wrapping_add(1);
        self.session.take()
    }

    fn launch_is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }
}

static BROWSER: LazyLock<Mutex<BrowserStore>> =
    LazyLock::new(|| Mutex::new(BrowserStore::default()));

// CDP actions mutate one persistent tab and therefore need serialization, but
// this separate mutex lets close/reload take the browser state immediately.
static BROWSER_OPERATION: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Pending "which browser did you get" note, produced when a session is established
/// and consumed by the first `snapshot` after it. `Option` rather than a plain
/// String so it is delivered exactly once instead of on every action.
static SESSION_NOTE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn set_session_note(note: String) {
    if let Ok(mut slot) = SESSION_NOTE.lock() {
        *slot = Some(note);
    }
}

// Installed before any page script runs. The frontend's browser check reads these
// two arrays, so recording at document creation time preserves boot-time failures
// that would otherwise be gone by the time the agent asks for a health check.
// Keep this deliberately narrow: status/error summaries only, never request or
// response headers/bodies. URLs are stripped of query strings and fragments.
const PAGE_OBSERVER_SCRIPT: &str = r#"(() => {
  try {
    if (window.__MICHAEL_IDE_OBSERVER__) return;
    Object.defineProperty(window, '__MICHAEL_IDE_OBSERVER__', { value: true });
    var MAX_EVENTS = 80;
    var queue = function(name) {
      var items = Array.isArray(window[name]) ? window[name] : [];
      window[name] = items;
      return function(entry) {
        try {
          items.push(entry);
          if (items.length > MAX_EVENTS) items.splice(0, items.length - MAX_EVENTS);
        } catch (_) {}
      };
    };
    var safeText = function(value) {
      try {
        if (value == null) return String(value);
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, 280);
        if (value instanceof Error) return ((value.name || 'Error') + ': ' + (value.message || '')).slice(0, 280);
        return Object.prototype.toString.call(value).slice(0, 80);
      } catch (_) { return '[unavailable]'; }
    };
    var safeArgs = function(args) {
      try { return Array.prototype.map.call(args, safeText).join(' ').slice(0, 280); }
      catch (_) { return '[unavailable]'; }
    };
    var safeUrl = function(value) {
      try {
        var parsed = new URL(String(value || ''), location.href);
        return (parsed.origin + parsed.pathname).slice(0, 240);
      } catch (_) {
        return String(value || '').split('#')[0].split('?')[0].slice(0, 240);
      }
    };
    var clock = function() { try { return performance.now(); } catch (_) { return 0; } };
    var errors = queue('__MERR__');
    var network = queue('__MNET__');

    try {
      var originalError = console.error;
      console.error = function() {
        errors({ level: 'error', msg: safeArgs(arguments) });
        return originalError.apply(console, arguments);
      };
      var originalWarn = console.warn;
      console.warn = function() {
        errors({ level: 'warn', msg: safeArgs(arguments) });
        return originalWarn.apply(console, arguments);
      };
    } catch (_) {}
    try {
      window.addEventListener('error', function(event) {
        errors({
          level: 'error',
          msg: safeText((event && (event.message || (event.error && event.error.message))) || 'script error'),
          src: event && event.filename ? safeUrl(event.filename) + ':' + (event.lineno || '?') : ''
        });
      }, true);
      window.addEventListener('unhandledrejection', function(event) {
        var reason = event && event.reason;
        errors({ level: 'error', msg: ('unhandledrejection: ' + safeText(reason && (reason.message || reason))).slice(0, 280) });
      });
    } catch (_) {}

    try {
      if (window.fetch && !window.fetch.__michaelObserverWrapped) {
        var originalFetch = window.fetch;
        var observedFetch = function(input, init) {
          var started = clock();
          var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase().slice(0, 12);
          var url = safeUrl(typeof input === 'string' ? input : (input && input.url));
          return originalFetch.apply(this, arguments).then(function(response) {
            if (!response.ok) network({ kind: 'fetch', method: method, url: url, status: response.status, ok: false, ms: Math.round(clock() - started) });
            return response;
          }, function(error) {
            network({ kind: 'fetch', method: method, url: url, status: 0, ok: false, ms: Math.round(clock() - started), error: safeText(error) });
            throw error;
          });
        };
        Object.defineProperty(observedFetch, '__michaelObserverWrapped', { value: true });
        window.fetch = observedFetch;
      }
    } catch (_) {}

    try {
      var Xhr = window.XMLHttpRequest;
      if (Xhr && Xhr.prototype && !Xhr.prototype.__michaelObserverWrapped) {
        var meta = new WeakMap();
        var originalOpen = Xhr.prototype.open;
        var originalSend = Xhr.prototype.send;
        Xhr.prototype.open = function(method, url) {
          meta.set(this, { method: String(method || 'GET').toUpperCase().slice(0, 12), url: safeUrl(url) });
          return originalOpen.apply(this, arguments);
        };
        Xhr.prototype.send = function() {
          var xhr = this;
          var started = clock();
          var details = meta.get(xhr) || { method: 'GET', url: '' };
          var reported = false;
          xhr.addEventListener('loadend', function() {
            if (reported) return;
            reported = true;
            if (xhr.status === 0 || xhr.status >= 400) network({ kind: 'xhr', method: details.method, url: details.url, status: xhr.status || 0, ok: false, ms: Math.round(clock() - started) });
          }, { once: true });
          return originalSend.apply(this, arguments);
        };
        Object.defineProperty(Xhr.prototype, '__michaelObserverWrapped', { value: true });
      }
    } catch (_) {}
  } catch (_) {}
})();"#;

fn configure_new_tab(tab: &Tab) -> Result<(), String> {
    tab.set_default_timeout(Duration::from_secs(30));
    tab.call_method(AddScriptToEvaluateOnNewDocument {
        source: PAGE_OBSERVER_SCRIPT.to_string(),
        world_name: None,
        include_command_line_api: None,
        run_immediately: Some(true),
    })
    .map_err(|e| format!("安装页面错误观测器失败: {e}"))?;
    Ok(())
}

/// One interactive element on the page, with a stable `ref` the agent uses to
/// act on it (click/type by number) instead of guessing a CSS selector — the
/// Playwright-MCP / browser-use approach. Matched by `[data-mref="<ref>"]`.
#[derive(Serialize, Deserialize)]
pub struct BrowserElement {
    #[serde(rename = "ref")]
    ref_: u32,
    tag: String,
    #[serde(rename = "type", default)]
    type_: String,
    #[serde(default)]
    text: String,
}

/// What every browser action returns: the page state AFTER the action, so the
/// agent always sees the result of what it just did.
#[derive(Serialize)]
pub struct BrowserState {
    title: String,
    url: String,
    /// Visible text of the page (truncated) — cheap, searchable context.
    text: String,
    /// `data:image/png;base64,...` — fed back to the model as an image.
    screenshot: String,
    /// Interactive elements (with refs) — the agent clicks/types by ref, and the
    /// screenshot has matching numbered marks (Set-of-Mark) for visual grounding.
    elements: Vec<BrowserElement>,
    /// Optional extra (e.g. a JS eval result).
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    /// Set when the page we landed on is a human-verification / bot wall rather than
    /// the content that was asked for (reCAPTCHA, Cloudflare challenge, "unusual
    /// traffic"). Names which wall it is.
    ///
    /// This exists so the agent STOPS instead of scraping the challenge page and
    /// retrying it forever. The window is visible by design: the human can clear the
    /// check themselves and the run continues. Nothing here tries to defeat, evade or
    /// solve the challenge — announcing the wall is the opposite of hiding from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked: Option<String>,
    /// One-shot note about WHICH browser this session is (attached to an existing one
    /// vs. freshly launched, and with which profile). Delivered on the first action
    /// after the browser comes up, so "why is there a second Chrome icon" is answered
    /// where it happens instead of being a mystery.
    #[serde(skip_serializing_if = "Option::is_none")]
    session_note: Option<String>,
}

/// 用户此刻是不是正开着这个浏览器（macOS）。
///
/// 进程名由 `BrowserKind` 给，不再写死 "Google Chrome"：选了 Edge 却拿 Chrome 的
/// 进程名去问，答案永远是错的，跟着错的是「真实 profile 能不能共享」这个判断。
#[cfg(target_os = "macos")]
fn is_browser_running(process_name: &str) -> bool {
    // 「用户开着浏览器吗」问的是**他自己那个**，不能把我们自己起的实例算进去。
    //
    // 原来是 `pgrep -x "Google Chrome"`：-x 比的是进程**名**，而我们的自动化实例进程名
    // 一模一样。于是这个函数在一台只开着自动化窗口、用户自己一个 Chrome 都没开的机器上
    // 照样返回 true。答错的代价是给用户一句假话——"你现在确实开着 Chrome，只是没开调试
    // 端口"，而他压根没开，多出来那个正是我们自己的孤儿。
    //
    // 改成读全命令行，把带我们 profile 标记的那些剔掉（判据和孤儿清理共用同一条，
    // 两处不会漂）。ps 拿不到时返回 false：宁可少说一句，也不说错。
    let Ok(out) = std::process::Command::new("ps").args(["-Ao", "args="]).output() else {
        return false;
    };
    let Ok(re) = regex::Regex::new(ORPHAN_PROFILE_PATTERN) else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout).lines().any(|line| {
        line.contains(process_name)
            // 只认主进程：helper 走的是 Contents/Frameworks/ 下的可执行文件。
            && !line.contains("Contents/Frameworks/")
            && !re.is_match(line)
    })
}

/// Windows：同一个问题的 CIM 版本。
///
/// 这里原来是个恒 false 的桩（连同 Linux 一起）。调用方拿它当**已核实的事实**用：
/// 「你现在没开着 Chrome」——而实际上一次都没查过。用户明明开着浏览器，
/// 却被告知没开，然后被引去做一堆不该做的事。
///
/// 判据和 discover_debuggable_browsers 保持一致：读完整命令行，
/// 剔掉带我们 profile 标记的（那是自动化自己起的实例）和 `--type=` 的子进程。
#[cfg(windows)]
fn is_browser_running(process_name: &str) -> bool {
    let Ok(out) = crate::process_util::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe' or Name='chromium.exe'\" | ForEach-Object { $_.CommandLine }",
        ])
        .output()
    else {
        // 查不到就返回 false，和 macOS 那支同一条原则：宁可少说一句，也不说错。
        return false;
    };
    let Ok(re) = regex::Regex::new(ORPHAN_PROFILE_PATTERN) else {
        return false;
    };
    // process_name 在 macOS 上是 "Google Chrome" 这种展示名，Windows 上命令行里
    // 出现的是 chrome.exe。两边都比一遍，取不区分大小写——Windows 路径大小写不敏感。
    let needle = process_name.to_lowercase();
    let exe = match needle.as_str() {
        n if n.contains("chrome") && !n.contains("chromium") => "chrome.exe",
        n if n.contains("chromium") => "chromium.exe",
        n if n.contains("edge") => "msedge.exe",
        n if n.contains("brave") => "brave.exe",
        _ => "",
    };
    String::from_utf8_lossy(&out.stdout).lines().any(|line| {
        let low = line.to_lowercase();
        (!exe.is_empty() && low.contains(exe))
            // 渲染进程 / GPU 进程不算"用户开着浏览器"，它们跟着主进程走。
            && !low.contains("--type=")
            && !re.is_match(line)
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn is_browser_running(_process_name: &str) -> bool {
    false
}

/// 这个浏览器**用户本人**那份配置目录在哪（macOS）。只有显式开了共享才会走到这里。
#[cfg(target_os = "macos")]
fn real_profile_dir(kind_id: &str) -> Option<std::path::PathBuf> {
    let rel = match kind_id {
        "chrome" => "Library/Application Support/Google/Chrome",
        "edge" => "Library/Application Support/Microsoft Edge",
        "brave" => "Library/Application Support/BraveSoftware/Brave-Browser",
        "chromium" => "Library/Application Support/Chromium",
        _ => return None,
    };
    std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join(rel))
        .filter(|p| p.join("Default").exists())
}

#[cfg(not(target_os = "macos"))]
fn real_profile_dir(_kind_id: &str) -> Option<std::path::PathBuf> {
    None
}

/// 每个浏览器自己的独立配置目录名（在 `~/.mrdayone/` 下）。
///
/// **不能共用一个目录**：Chrome 和 Edge 的 profile 格式并不互通，同一个目录轮流被两个
/// 浏览器打开会把它写坏，代价是里面攒的全部登录态一起没。
///
/// chrome 保留原来那个不带后缀的名字——已经在自动化窗口里登录过的人不该因为这次改动
/// 平白丢一次登录态。
fn profile_dir_name(kind_id: &str) -> String {
    if kind_id == "chrome" {
        "browser-profile".to_string()
    } else {
        format!("browser-profile-{kind_id}")
    }
}

/// 用户配置要加载的浏览器扩展目录（未打包的目录，不是 .crx）。
static EXTENSION_DIRS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// 设定要加载的扩展目录列表。只保留真实存在的目录——传进来一个不存在的路径，
/// 浏览器要么整个启动失败、要么默默忽略，两种都比在这里先筛掉更难查。
pub fn set_extension_dirs(dirs: Vec<String>) {
    let kept: Vec<String> = dirs
        .into_iter()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
        .collect();
    if let Ok(mut slot) = EXTENSION_DIRS.lock() {
        *slot = kept;
    }
}

fn extension_dirs() -> Vec<String> {
    if let Ok(slot) = EXTENSION_DIRS.lock() {
        if !slot.is_empty() {
            return slot.clone();
        }
    }
    std::env::var("MICHAEL_BROWSER_EXTENSIONS")
        .ok()
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && std::path::Path::new(s).is_dir())
                .collect()
        })
        .unwrap_or_default()
}

fn launch() -> Result<Session, String> {
    let (kind, path, missing_pref) = crate::capture::resolve_browser(
        crate::capture::browser_pref().as_deref(),
    )
    .ok_or("未找到 Chrome / Edge / Brave / Chromium，无法启动浏览器自动化。请先安装其一。")?;
    let exts = extension_dirs();
    // Make intranet/localhost dev servers reachable: ignore self-signed certs and
    // bypass any system/corporate proxy for private addresses (so "内网不能访问"
    // doesn't happen), while still letting public sites use the proxy.
    let proxy_bypass = "--proxy-bypass-list=localhost;127.0.0.1;[::1];0.0.0.0;\
        10.*;192.168.*;169.254.*;\
        172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;\
        172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;\
        *.local;<local>";
    let mut extra: Vec<std::ffi::OsString> = vec![
        "--ignore-certificate-errors".into(),
        "--allow-insecure-localhost".into(),
        "--disable-background-networking".into(),
        "--disable-dev-shm-usage".into(),
        // Kill the nag bubbles that made every automation launch look broken: "个人资料出了点问题",
        // "Chrome 未正确关闭 / 恢复页面", first-run, default-browser, translate/infobars. A controlled
        // browser must start clean.
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-session-crashed-bubble".into(),
        "--hide-crash-restore-bubble".into(),
        "--disable-infobars".into(),
        // 这一条要**同时**带上 headless_chrome 默认参数里那份的值（TranslateUI /
        // BlinkGenPropertyTrees），并在下面把默认那条摘掉。
        //
        // 原来是两条 --disable-features 一起传，靠「Chromium 对重复开关只认最后一次」
        // 让我们这条覆盖掉默认那条——也就是默认那份的值被静默丢掉了。之前没出问题只是
        // 因为那两个值本来就不重要；但现在开始用 ignore_default_args 管理默认参数，
        // 再留着这种靠拼接顺序生效的隐式行为，出问题时根本没法推理。
        "--disable-features=Translate,TranslateUI,BlinkGenPropertyTrees,InfobarScreenshot,MediaRouter,OptimizationHints".into(),
        "--disable-backgrounding-occluded-windows".into(),
        proxy_bypass.into(),
    ];
    // If the 抓包 capture proxy is running, route this browser THROUGH it so capture_flows sees the
    // browser's traffic — this is what makes "抓包 + browser 走一遍登录" actually combine.
    // --ignore-certificate-errors (above) makes Chrome accept mitmproxy's MITM cert, so the user
    // doesn't even need to trust the CA for the automation browser.
    if let Some(port) = crate::proxy::active_proxy_port() {
        extra.push(format!("--proxy-server=127.0.0.1:{port}").into());
    }
    let extra_ref: Vec<&std::ffi::OsStr> = extra.iter().map(|s| s.as_os_str()).collect();
    // 真实 Chrome profile = 用户的全部 cookie、登录态、保存的密码和扩展。要不要把它交给
    // 自动化，必须是一个**显式选择**。
    //
    // 之前的判据是「Chrome 此刻没在跑」—— 一个偶发状态。同一句话让 AI 去访问某个网站，
    // 你的浏览器开着就是隔离 profile，关着就是把全部登录态交出去，用户完全无从预期；
    // 而恶意网页只要能让自动化访问它，就能顺着这份登录态操作你已登录的任何站点。
    //
    // 现在改成显式开关 `MICHAEL_BROWSER_USE_REAL_PROFILE=1`。能力完整保留，只是要你自己
    // 点头；不设时一律用 ~/.mrdayone/browser-profile 这份独立 profile。
    let use_real_profile = std::env::var("MICHAEL_BROWSER_USE_REAL_PROFILE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    // 浏览器在跑时它的 profile 是锁着的，共享不了——即使显式开了也只能退回独立 profile。
    let browser_running = is_browser_running(kind.process_name);
    let real_profile = if use_real_profile && !browser_running {
        real_profile_dir(kind.id)
    } else {
        None
    };
    let used_real_profile = real_profile.is_some();
    let profile_name = profile_dir_name(kind.id);
    let profile_dir = real_profile.or_else(|| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join(crate::mcp::app_dir_name())
                    .join(&profile_name)
            })
    });
    // Say which browser this is and why, once, on the first action after it opens.
    // The separate Dock icon is not a bug to be hidden — it is a real second Chrome,
    // and the only honest thing to do is name the reason it had to be started.
    let mut note = if used_real_profile {
        format!(
            "已用你本人的 {} 配置启动自动化浏览器（登录态/cookie 都在），但它是一个独立进程，所以 Dock 里会多一个图标。",
            kind.label
        )
    } else {
        // 这里只说**已经证实**的原因，不推荐没验证过的开关。
        // 真实 profile 那条路（MICHAEL_BROWSER_USE_REAL_PROFILE）在浏览器运行时必定
        // 失败（配置目录被 SingletonLock 锁着），所以它不是一条能推荐的路，别写成建议。
        // 这句话要**分情况**说，因为用户问的正是「我明明开着浏览器，你为什么不用」。
        //
        // 原来不管开没开，说的都是同一句泛泛的"接管已开实例需要调试端口"。开着的人觉得
        // 答非所问（我开着啊），没开的人更莫名其妙（我没开你解释什么）。而这两件事我们
        // 是**测得出来**的：is_browser_running 看进程、try_connect_existing 已经扫过端口。
        // 有事实就别说套话。
        let why = if use_real_profile && browser_running {
            format!("你已开着 {}，它把配置目录锁住了，共享不了", kind.label)
        } else if browser_running {
            format!(
                "你现在确实开着 {}，但那个实例启动时没有带 --remote-debugging-port，\
而调试端口是**启动期**参数、进程跑起来之后加不上，所以它接管不了——这不是没去找，是找了、够不着。\
\n\n**但「够不着」只是指 CDP 这条路。** 你那个浏览器仍然可以被完全自动化，走的是另一条：\
用 `system open` 把它切到前台，`read_screen` 读它的可访问性树（macOS 上浏览器会把渲染出来的\
网页内容——链接、按钮、输入框、文本——连同坐标一起暴露给 AX，所以这不是截图猜测，是结构化元素），\
然后 `computer` 按坐标点击和输入。这条路的登录态就是你自己的，不需要重新登录。\
\n两条路的取舍：CDP 那条给的是 DOM 选择器、能跑 JS、能断言，精确但只能作用在它自己启动的实例上；\
桌面这条作用在**你正在用的那个浏览器**上，代价是要靠坐标、窗口必须在前台、拿不到 DOM。\
要操作你已登录的账号，走桌面这条；要做可重复的页面验收，走 CDP 那条",
                kind.label
            )
        } else {
            format!("本机当前没有开着的 {}，没有可接管的实例", kind.label)
        };
        // Dock 里两个一模一样的图标——这件事在只装了一个 Chromium 浏览器时，从图标上
        // 解决不了：macOS 同一个 App 的多个实例共用一个 Dock 图标，除非换个 App。
        // 所以别装作能解决，而是把**能照做的两条**说清楚，并且只在真的会混淆时才说
        // （用户此刻确实开着同一个牌子）。窗口里那条黄条「Chrome 正受到自动测试软件的控制」
        // 是它唯一稳定的身份标记，先指给用户看。
        let others: Vec<&str> = crate::capture::installed_browsers()
            .into_iter()
            .map(|(k, _)| k.label)
            .filter(|l| *l != kind.label)
            .collect();
        let tell_apart = if browser_running {
            format!(
                "\n\n**怎么分清哪个是你自己的**：自动化那个窗口顶部有一条黄色提示「Chrome 正受到自动测试软件的控制」，\
你自己的没有。Dock 图标分不开是 macOS 的限制——同一个 App 的多个实例共用一个图标。\
真要一眼分清，{}",
                if others.is_empty() {
                    "装一个别的 Chromium 浏览器（Edge / Brave / Chromium 任一），在设置里把自动化指过去，两个图标就彻底分开了。".to_string()
                } else {
                    format!("在设置里把自动化改用 {}——本机已经装了。", others.join(" 或 "))
                }
            )
        } else {
            String::new()
        };
        format!(
            "自动化用的是 **{}**，是新起的一个实例（Dock 里多出来的那个图标就是它）。\
原因：先扫了 9222-9229 调试端口没找到可接管的实例——{why}。\
它用的是独立配置 ~/.mrdayone/{profile_name}：全新、没登录过，\
所以像 Google 这类站点更容易弹人机验证。\
**在这个窗口里登录一次会被记住**，下次直接就是登录态——这是让它少弹验证的正路。\
{tell_apart}",
            kind.label
        )
    };
    // 选了一个没装的浏览器，不能默默换一个了事——那是这套代码以前最让人困惑的地方。
    if let Some(ref want) = missing_pref {
        let have = crate::capture::installed_browsers()
            .iter()
            .map(|(k, _)| k.id)
            .collect::<Vec<_>>()
            .join(" / ");
        note = format!(
            "你指定的浏览器「{want}」没装，这次改用了 {}。本机装了：{}。\n{note}",
            kind.label,
            if have.is_empty() { "无".into() } else { have }
        );
    }
    // 扩展：Chrome 137 起彻底不理 --load-extension（实测 151 连坏 manifest 都不报错，
    // 加 --disable-features=DisableLoadExtensionCommandLineSwitch 也救不回来）。
    // 配了却不生效必须当场说清楚，不然用户会以为是自己路径写错了。
    if !exts.is_empty() && kind.id == "chrome" {
        note = format!(
            "{note}\n注意：配了 {} 个浏览器扩展，但 Chrome 从 137 起已经不再接受命令行加载扩展，这些扩展**不会生效**。要用扩展得把自动化浏览器换成 Edge / Brave / Chromium（本机没装的话要先装）。",
            exts.len()
        );
    }
    set_session_note(note);
    if let Some(ref p) = profile_dir {
        let _ = std::fs::create_dir_all(p);
        // Remove stale singleton locks left by a previous crash / navigation timeout —
        // otherwise Chrome refuses to reuse the profile and EVERY later browser action
        // fails ("profile in use"). This makes the persistent profile crash-robust.
        // Remove ALL singleton lock/socket files (they're symlinks on macOS). ANY leftover makes
        // Chrome think the profile is "in use" → "个人资料出了点问题". A hard-coded list missed
        // variants; sweep every file whose name starts with "Singleton".
        if let Ok(rd) = std::fs::read_dir(p) {
            for ent in rd.flatten() {
                if ent.file_name().to_string_lossy().starts_with("Singleton") {
                    let _ = std::fs::remove_file(ent.path());
                }
            }
        }
        // Mark the profile as cleanly exited so Chrome doesn't nag "个人资料出了点问题 / 未正确关闭 /
        // 恢复页面" after a previous kill/crash. KEY FIX: if a state file is CORRUPT (unparseable
        // JSON — a real cause of the "profile problem" dialog), the old code silently skipped it and
        // the dialog kept showing. Now we DELETE the corrupt file so Chrome regenerates a pristine one
        // (cookies live in Default/Cookies + Keychain, not these files, so login persistence survives).
        let prefs = p.join("Default").join("Preferences");
        match std::fs::read_to_string(&prefs)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        {
            Some(mut json) => {
                if let Some(prof) = json.get_mut("profile").and_then(|v| v.as_object_mut()) {
                    prof.insert(
                        "exit_type".into(),
                        serde_json::Value::String("Normal".into()),
                    );
                    prof.insert("exited_cleanly".into(), serde_json::Value::Bool(true));
                }
                let _ = std::fs::write(&prefs, json.to_string());
            }
            None if prefs.exists() => {
                let _ = std::fs::remove_file(&prefs); // corrupt → let Chrome rebuild it clean
            }
            None => {}
        }
        // A corrupt root "Local State" ALSO triggers "个人资料出了点问题"; drop it if unreadable
        // (on macOS it holds no cookie key, so this is safe — Chrome rebuilds it).
        let local_state = p.join("Local State");
        if let Ok(txt) = std::fs::read_to_string(&local_state) {
            if serde_json::from_str::<serde_json::Value>(&txt).is_err() {
                let _ = std::fs::remove_file(&local_state);
            }
        }
    }
    // VISIBLE by default — the user must actually SEE the browser being controlled
    // (headless felt "根本没在控制电脑" because nothing showed on screen). A real Chrome
    // window opens and the agent drives it (fast, node-based). Set MICHAEL_BROWSER_HEADLESS=1
    // to force headless for pure background scraping where no window is wanted.
    let headless = std::env::var("MICHAEL_BROWSER_HEADLESS").ok().as_deref() == Some("1");
    // 扩展要生效，两件事缺一不可：把扩展目录交给浏览器，**并且**把这个库默认加的
    // `--disable-extensions` 摘掉——只做前一半的话浏览器照样一个扩展都不加载。
    //
    // 只摘 `--disable-extensions` 这一个。`--enable-automation` 同在那份默认参数里，
    // 摘掉它就是**隐藏自动化身份**，也就是反检测——这个产品不做，由测试钉住。
    let ext_os: Vec<std::ffi::OsString> = exts.iter().map(std::ffi::OsString::from).collect();
    let ext_ref: Vec<&std::ffi::OsStr> = ext_os.iter().map(|s| s.as_os_str()).collect();
    let mut drop_defaults: Vec<&std::ffi::OsStr> = vec![
        // 我们自己那条 --disable-features 已经把默认那条的值并进去了，摘掉默认的，
        // 让命令行上只剩一条——不再依赖「重复开关取最后一次」这种隐式覆盖。
        std::ffi::OsStr::new("--disable-features=TranslateUI,BlinkGenPropertyTrees"),
    ];
    if !ext_ref.is_empty() {
        drop_defaults.push(std::ffi::OsStr::new("--disable-extensions"));
    }
    let opts = LaunchOptionsBuilder::default()
        .path(Some(std::path::PathBuf::from(&path)))
        // 空闲多久就当浏览器死了。**这一行以前不存在**，于是吃的是 headless_chrome 的默认
        // 30 秒（process.rs:187），而那 30 秒是这样花掉的：transport 用
        // `messages_rx.recv_timeout(idle_browser_timeout)` 等 CDP 入站消息，超时就 break；
        // 而 configure_new_tab 一个事件域都没 enable，一个静止的页面几乎零入站消息。
        //
        // 结果：模型点一下浏览器 → 转头去读代码/跑测试（超过 30 秒是常态）→ 回来再点，
        // 连接已经断了 → is_dead_browser 命中 → close_on_drop 把进程杀掉 → 重开一个新窗口，
        // 当前页面连同登录态一起丢。用户看到的就是"它老是自己弹一个新的调试浏览器出来"。
        //
        // 30 分钟：远长于任何一次合理的动作间隔，又仍然有界（真被遗忘的实例不会永远挂着，
        // 而且孤儿清理那条也修好了）。真正的掉线不靠这个超时发现——进程退出、websocket
        // 关闭都会立刻报错，那些才是"浏览器真的没了"的信号。
        .idle_browser_timeout(std::time::Duration::from_secs(30 * 60))
        .headless(headless)
        .sandbox(false)
        .ignore_certificate_errors(true)
        .user_data_dir(profile_dir.clone())
        .window_size(Some((1280, 900)))
        .args(extra_ref.clone())
        .extensions(ext_ref.clone())
        .ignore_default_args(drop_defaults.clone())
        .build()
        .map_err(|e| e.to_string())?;
    let browser = match Browser::new(opts) {
        Ok(b) => b,
        Err(_) => {
            // The persistent profile is unusable (corrupt / created by a different Chrome version /
            // still locked by a leftover instance). Fall back to a FRESH throwaway profile so the
            // automation browser ALWAYS launches instead of dying on "个人资料出了点问题". We only lose
            // this run's saved cookies, never the agent's ability to drive the browser.
            let fresh =
                std::env::temp_dir().join(format!("michael-ide-browser-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&fresh);
            let opts2 = LaunchOptionsBuilder::default()
                .path(Some(std::path::PathBuf::from(&path)))
                // 这一行以前**只有上面那条主路径有**，回退路径漏了，于是它吃的是
                // headless_chrome 的默认 30 秒空闲超时。症状和上面注释描述的一模一样：
                // 起了窗口 → 模型转头去读代码/跑测试（超过 30 秒是常态）→ 回来连接已断
                // → 杀掉进程 → 重开一个新窗口，什么都没操作。
                //
                // 而且它会**自我循环**：被杀掉的进程留下 profile 锁 → 下一次启动又落到这条
                // 回退路径 → 又没有超时 → 又被杀。用户看到的就是「打开窗口卡在那里，
                // 过一会开新的，就是不操作」，一直转圈出不来。
                .idle_browser_timeout(std::time::Duration::from_secs(30 * 60))
                .headless(headless)
                .sandbox(false)
                .ignore_certificate_errors(true)
                .user_data_dir(Some(fresh))
                .window_size(Some((1280, 900)))
                .args(extra_ref.clone())
                .build()
                .map_err(|e| e.to_string())?;
            set_session_note(
                "上一份浏览器配置用不了（损坏或被残留进程锁住），已改用一次性临时配置启动。\
本次的登录态不会保留，但自动化不会因此中断。"
                    .into(),
            );
            Browser::new(opts2).map_err(|e| e.to_string())?
        }
    };
    let tab = browser.new_tab().map_err(|e| e.to_string())?;
    // Slow intranet pages need more headroom than the old 15s. Install the
    // document observer before this new tab navigates anywhere.
    configure_new_tab(&tab)?;
    Ok(Session {
        _browser: browser,
        tab,
    })
}

/// 一个**正在跑**、而且开着调试端口的浏览器实例。
#[derive(Debug, Clone)]
struct LiveBrowser {
    pid: u32,
    port: u16,
    /// 是不是我们自己起的（profile 目录带我们的标记）。用户自己那个优先接管。
    ours: bool,
}

/// 找出本机所有开着调试端口的浏览器实例。
///
/// 为什么不能只扫 9222-9229：那六个端口是**约定**，不是事实。真实情况里
///   · 用户自己带 `--remote-debugging-port=9333` 起的浏览器 → 扫不到
///   · `--remote-debugging-port=0`（让系统随便挑一个，很多工具的默认做法）→ 扫不到，
///     实测本机两个实例就是这样，分别落在 63180 和 53130
/// 于是「先试着接管已开实例」这一步在绝大多数真实场景里是空转，直接掉进"新开一个"。
/// 用户看到的就是"它老是弹自己那个调试浏览器"。
///
/// 改成从进程本身读：命令行里写着端口，`port=0` 时再去它的 user-data-dir 读
/// `DevToolsActivePort`（Chromium 自己就是这么把真实端口告诉外界的）。
#[cfg(not(windows))]
fn discover_debuggable_browsers() -> Vec<LiveBrowser> {
    let Ok(out) = std::process::Command::new("ps").args(["-Ao", "pid=,args="]).output() else {
        return Vec::new();
    };
    let ours_re = regex::Regex::new(ORPHAN_PROFILE_PATTERN).ok();
    let mut found = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim_start();
        let Some((pid_str, args)) = line.split_once(char::is_whitespace) else { continue };
        let Ok(pid) = pid_str.trim().parse::<u32>() else { continue };
        // 只看主进程。helper（GPU/渲染/网络）走的是 Contents/Frameworks/ 下的可执行文件，
        // 它们继承了同一份命令行，不剔掉就会把同一个实例数出七八遍。
        if args.contains("Contents/Frameworks/") || args.contains("--type=") {
            continue;
        }
        if !crate::capture::BROWSER_KINDS.iter().any(|k| args.contains(k.process_name)) {
            continue;
        }
        let Some(port) = debug_port_from_args(args) else { continue };
        if port == 0 {
            continue;
        }
        // 端口上的监听者必须**就是这个进程**。没有这一步，本机任意程序抢先占住一个端口
        // 就能把整套浏览器自动化接过去（同 get_cdp_ws_url 那段注释说的威胁，这里是
        // 在更前面一层堵住它）。查不出来就跳过——判据拿不到时宁可不接管。
        if !listener_belongs_to(pid, port) {
            continue;
        }
        let ours = ours_re.as_ref().map(|re| re.is_match(args)).unwrap_or(true);
        found.push(LiveBrowser { pid, port, ours });
    }
    // 用户自己那个排前面：接管它才是"用你正开着的浏览器做事"。
    found.sort_by_key(|b| b.ours);
    found
}

#[cfg(windows)]
fn discover_debuggable_browsers() -> Vec<LiveBrowser> {
    // Windows 上没有 ps；用 CIM 拿命令行。拿不到就返回空，回落到端口扫描那条老路。
    let Ok(out) = crate::process_util::command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe' or Name='chromium.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ])
        .output()
    else {
        return Vec::new();
    };
    let ours_re = regex::Regex::new(ORPHAN_PROFILE_PATTERN).ok();
    let mut found = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        let Some((pid_str, args)) = line.split_once(' ') else { continue };
        let Ok(pid) = pid_str.parse::<u32>() else { continue };
        if args.contains("--type=") {
            continue;
        }
        let Some(port) = debug_port_from_args(args) else { continue };
        if port == 0 || !listener_belongs_to(pid, port) {
            continue;
        }
        let ours = ours_re.as_ref().map(|re| re.is_match(args)).unwrap_or(true);
        found.push(LiveBrowser { pid, port, ours });
    }
    found.sort_by_key(|b| b.ours);
    found
}

/// 从命令行里取调试端口。`--remote-debugging-port=0` 表示"系统随便挑一个"，
/// 真实端口写在 user-data-dir 下的 `DevToolsActivePort` 第一行——不读它就等于没发现。
fn debug_port_from_args(args: &str) -> Option<u16> {
    let raw = args
        .split_whitespace()
        .find_map(|t| t.strip_prefix("--remote-debugging-port="))?;
    let port: u16 = raw.trim().parse().ok()?;
    if port != 0 {
        return Some(port);
    }
    let dir = args.split_whitespace().find_map(|t| {
        t.strip_prefix("--user-data-dir=")
            .or_else(|| t.strip_prefix("user-data-dir="))
    })?;
    let text = std::fs::read_to_string(std::path::Path::new(dir).join("DevToolsActivePort")).ok()?;
    text.lines().next()?.trim().parse().ok()
}

/// 这个端口上监听的，是不是就是这个进程。
///
/// 判据拿不到时返回 **false**（fail closed）：接管一个来路不明的调试端口，代价是
/// 对方看得到之后每一个页面、每一次输入。宁可多开一个自己的窗口。
#[cfg(not(windows))]
fn listener_belongs_to(pid: u32, port: u16) -> bool {
    std::process::Command::new("lsof")
        .args([
            "-nP",
            "-p",
            &pid.to_string(),
            "-a",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
        ])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

#[cfg(windows)]
fn listener_belongs_to(pid: u32, port: u16) -> bool {
    let Ok(out) = crate::process_util::command("netstat").args(["-ano"]).output() else {
        return false;
    };
    let needle = format!(":{port}");
    String::from_utf8_lossy(&out.stdout).lines().any(|l| {
        l.contains(&needle)
            && l.to_ascii_uppercase().contains("LISTENING")
            && l.split_whitespace().last() == Some(pid.to_string().as_str())
    })
}

/// Try to attach to a user's already-running Chrome that has remote debugging
/// enabled (e.g. launched with `--remote-debugging-port=9222`).  This lets the
/// agent drive the user's REAL browser — with all their cookies, logged-in
/// sessions, and extensions — instead of a separate automation instance.
fn try_connect_existing() -> Option<Session> {
    // 候选顺序：**先按进程发现**（用户自己那个排最前），再退回固定端口扫描。
    //
    // 固定端口那条以前是唯一的判据，而它只是个约定：真实实例常跑在别的端口上，
    // `--remote-debugging-port=0` 更是让系统随便挑（实测本机两个实例落在 63180/53130）。
    // 于是"先试着接管已开实例"这一步在真实场景里几乎必然空转，直接掉进"新开一个"——
    // 用户看到的就是"它老是弹自己那个调试浏览器"。老那条留着当兜底，不删。
    let discovered: Vec<u16> = discover_debuggable_browsers().into_iter().map(|b| b.port).collect();
    let mut candidates = discovered;
    for p in [9222u16, 9223, 9224, 9225, 9226, 9229] {
        if !candidates.contains(&p) {
            candidates.push(p);
        }
    }
    for port in candidates {
        let (ws_url, brand) = match get_cdp_ws_url(port) {
            Some(pair) => pair,
            None => continue,
        };
        let browser = match Browser::connect_with_timeout(ws_url, Duration::from_secs(120)) {
            Ok(b) => b,
            Err(_) => continue,
        };
        match browser.new_tab() {
            Ok(tab) => {
                if configure_new_tab(&tab).is_err() {
                    continue;
                }
                tracing::info!("[browser] attached to existing {brand} on port {port}");
                set_session_note(format!(
                    "已接管你已经开着的 {brand}（调试端口 {port}），没有另起浏览器——用的是你本人的登录态、cookie 和扩展。"
                ));
                return Some(Session {
                    _browser: browser,
                    tab,
                });
            }
            Err(_) => continue,
        }
    }
    None
}

/// Query Chrome's `/json/version` endpoint to get the DevTools WebSocket URL.
fn get_cdp_ws_url(port: u16) -> Option<(String, String)> {
    use std::io::{Read, Write};
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut stream =
        std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1000)))
        .ok()?;
    let req = format!("GET /json/version HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(2048);
    let _ = stream.read_to_end(&mut buf);
    let text = std::str::from_utf8(&buf).ok()?;
    let body = text.split("\r\n\r\n").nth(1)?;
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    // **重建**地址，而不是照用返回值里的那个。
    //
    // 我们只是"探到 127.0.0.1:<port> 上有个 /json/version 能回 JSON"就连过去，而回什么
    // 完全由那个进程说了算 —— 本机任意程序（含被装上的恶意 npm 包）抢先占住 9222-9229
    // 里的一个端口，就能把 webSocketDebuggerUrl 指向别处，从而接管全部浏览器自动化：
    // 看到你访问的每个页面、每次输入。
    //
    // 真实 Chrome/Edge 返回的就是 ws://127.0.0.1:<同一端口>/devtools/browser/<uuid>，
    // 所以只取 path 重新拼是无损的。
    let raw = json.get("webSocketDebuggerUrl")?.as_str()?;
    let after_scheme = raw
        .strip_prefix("ws://")
        .or_else(|| raw.strip_prefix("wss://"))?;
    let path = after_scheme.find('/').map(|i| &after_scheme[i..])?;
    if !path.starts_with("/devtools/") {
        return None;
    }
    // 这个端口后面到底是谁。以前这个字段被丢掉了，于是接管了 Edge 也照样告诉用户
    // 「已接管你的 Chrome」——而那正是用户唯一能拿来核对「接管的是不是我那个窗口」
    //   的信息。认不出来就说「浏览器」，别默认叫 Chrome。
    let brand = brand_from_version(json.get("Browser").and_then(|v| v.as_str()));
    Some((format!("ws://127.0.0.1:{port}{path}"), brand))
}

/// `/json/version` 的 `Browser` 字段（形如 `Chrome/151.0` 或 `Edg/126.0`）→ 人话牌子名。
///
/// 认不出来就说「浏览器」，**不默认叫 Chrome**：这句话是用户唯一能拿来核对
/// 「接管的到底是不是我那个窗口」的信息，说错了比不说更糟。
fn brand_from_version(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return "浏览器".to_string();
    };
    match raw.split('/').next().unwrap_or(raw).trim() {
        "Edg" | "Edge" => "Microsoft Edge".to_string(),
        "Chrome" | "HeadlessChrome" => "Google Chrome".to_string(),
        "Brave" => "Brave".to_string(),
        "Chromium" => "Chromium".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "浏览器".to_string(),
    }
}

/// Enumerate the visible, in-viewport interactive elements: tag each with a
/// `data-mref` ref (so click/type can target `[data-mref="N"]`), draw a numbered
/// Set-of-Mark badge on each (so the screenshot shows which is which), and return
/// the compact list. This is what lets the agent act precisely by number instead
/// of guessing selectors — far more reliable and ~20-50x cheaper than pixels.
fn enumerate_elements(tab: &Tab) -> Vec<BrowserElement> {
    // `__DRAW__` is replaced with 1/0 — controls only the VISIBLE badge; refs are
    // always tagged so click-by-index works even with marks off (demo recording).
    let raw = r##"(() => { try {
  document.querySelectorAll('[data-mref]').forEach(e => e.removeAttribute('data-mref'));
  document.querySelectorAll('.__mcp_som').forEach(e => e.remove());
  const DRAW = __DRAW__;
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[onclick],[contenteditable=""],[contenteditable=true]';
  const els = Array.from(document.querySelectorAll(sel));
  const out = []; let i = 0;
  for (const el of els) {
    if (i >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    el.setAttribute('data-mref', i);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').slice(0, 20);
    let text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    out.push({ ref: i, tag: tag, type: type, text: text });
    if (DRAW) {
      const b = document.createElement('div');
      b.className = '__mcp_som';
      b.textContent = String(i);
      b.style.cssText = 'position:absolute;z-index:2147483647;background:#d93025;color:#fff;font:bold 11px monospace;padding:0 3px;border-radius:3px;pointer-events:none;line-height:15px;box-shadow:0 0 0 1px #fff;';
      b.style.left = (r.left + window.scrollX) + 'px';
      b.style.top = (r.top + window.scrollY) + 'px';
      document.body.appendChild(b);
    }
    i++;
  }
  try { var ifs=document.querySelectorAll('iframe');
    for(var fi=0;fi<ifs.length&&i<60;fi++){try{
      var idoc=ifs[fi].contentDocument; if(!idoc) continue;
      idoc.querySelectorAll('[data-mref]').forEach(function(e){e.removeAttribute('data-mref')});
      var ifr=ifs[fi].getBoundingClientRect();
      var iels=Array.from(idoc.querySelectorAll(sel));
      for(var ie=0;ie<iels.length&&i<60;ie++){
        var iel=iels[ie]; var ir=iel.getBoundingClientRect();
        if(ir.width<1||ir.height<1) continue;
        var at=ifr.top+ir.top,al=ifr.left+ir.left;
        if(at+ir.height<0||al+ir.width<0||at>innerHeight||al>innerWidth) continue;
        try{var ics=idoc.defaultView.getComputedStyle(iel);
          if(ics.visibility==='hidden'||ics.display==='none'||ics.opacity==='0') continue;
        }catch(_){}
        iel.setAttribute('data-mref',i);
        var itag=iel.tagName.toLowerCase();
        var itype=(iel.getAttribute('type')||'').slice(0,20);
        var itext=(iel.innerText||iel.value||iel.getAttribute('aria-label')||iel.getAttribute('placeholder')||iel.getAttribute('title')||iel.getAttribute('name')||'').trim().replace(/\s+/g,' ').slice(0,60);
        out.push({ref:i,tag:itag,type:itype,text:itext});
        if(DRAW){var ib=document.createElement('div');ib.className='__mcp_som';ib.textContent=String(i);
          ib.style.cssText='position:absolute;z-index:2147483647;background:#d93025;color:#fff;font:bold 11px monospace;padding:0 3px;border-radius:3px;pointer-events:none;line-height:15px;box-shadow:0 0 0 1px #fff;';
          ib.style.left=(al+window.scrollX)+'px';ib.style.top=(at+window.scrollY)+'px';
          document.body.appendChild(ib);}
        i++;
      }
    }catch(e2){}}
  }catch(e3){}
  return JSON.stringify(out);
} catch (e) { return '[]'; } })()"##;
    let js = raw.replace(
        "__DRAW__",
        if DRAW_MARKS.load(Ordering::Relaxed) {
            "1"
        } else {
            "0"
        },
    );
    match tab.evaluate(&js, false) {
        Ok(ro) => {
            let s = ro
                .value
                .and_then(|v| v.as_str().map(|x| x.to_string()))
                .unwrap_or_else(|| "[]".to_string());
            serde_json::from_str::<Vec<BrowserElement>>(&s).unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

/// Name the human-verification wall this page is, if it is one.
///
/// Detection only. There is deliberately no counterpart that solves, bypasses or
/// hides from these checks — the agent's correct move on hitting one is to stop and
/// hand the visible window back to the person driving it, which it cannot do while
/// it thinks a challenge page is the article it asked for.
///
/// Both halves matter: the DOM probe catches the widget even when the challenge is
/// embedded in an otherwise normal-looking page, and the URL/title check catches the
/// walls that ship no widget at all (a bare 403, Google's `/sorry/` redirect).
fn detect_wall(tab: &Tab, title: &str, url: &str, text: &str) -> Option<String> {
    let probe = r#"(function(){try{
  var hit=[];
  var q=function(s){try{return !!document.querySelector(s)}catch(e){return false}};
  if(q('iframe[src*="recaptcha/api2"],iframe[src*="recaptcha/enterprise"],.g-recaptcha,#recaptcha,#captcha-form')) hit.push('reCAPTCHA');
  if(q('iframe[src*="hcaptcha.com"],.h-captcha')) hit.push('hCaptcha');
  if(q('iframe[src*="challenges.cloudflare.com"],.cf-turnstile,#cf-challenge-running,#challenge-form,#challenge-stage')) hit.push('Cloudflare 验证');
  if(q('#px-captcha,#px-captcha-wrapper')) hit.push('PerimeterX');
  if(q('iframe[src*="arkoselabs"],iframe[src*="funcaptcha"]')) hit.push('Arkose/FunCaptcha');
  return hit.join('、');
}catch(e){return ''}})()"#;
    let mut found = tab
        .evaluate(probe, false)
        .ok()
        .and_then(|ro| ro.value)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    if found.is_empty() {
        found = detect_wall_static(title, url, text).unwrap_or_default();
    }
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

/// The half of wall detection that needs no page access: walls that ship no widget
/// at all (a bare 403, Google's `/sorry/` redirect, Cloudflare's interstitial).
///
/// Split out from `detect_wall` because it is pure and therefore testable, and
/// because a false positive here is expensive in a specific way: it would tell the
/// user to go clear a verification on a page that has none. So the signals are
/// graded. Only endpoints that exist *solely* to serve a challenge count on their
/// own; every keyword that could plausibly appear in ordinary content ("captcha",
/// "access denied", "unusual traffic") additionally requires a nearly empty page —
/// an interstitial has almost no text, an article about CAPTCHAs has plenty.
fn detect_wall_static(title: &str, url: &str, text: &str) -> Option<String> {
    let lower_url = url.to_ascii_lowercase();
    let lower_title = title.to_ascii_lowercase();
    let lower_text = text.to_ascii_lowercase();
    // Paths that are challenge endpoints and nothing else.
    let strong_url = ["/sorry/index", "/cdn-cgi/challenge-platform/", "/recaptcha/api2/"]
        .iter()
        .any(|needle| lower_url.contains(needle));
    // Titles a real page does not carry.
    let strong_title = ["just a moment", "attention required", "人机身份验证"]
        .iter()
        .any(|needle| lower_title.contains(needle));
    if strong_url || strong_title {
        return Some("人机验证 / 反爬拦截".to_string());
    }
    // An interstitial is a nearly empty page. Below this threshold the weaker
    // keywords stop being ambiguous; above it, the page has real content and the
    // same words are just words.
    let thin = text.chars().count() < 400;
    if !thin {
        return None;
    }
    let weak = ["captcha", "验证码"]
        .iter()
        .any(|needle| lower_url.contains(needle) || lower_title.contains(needle))
        || [
            "unusual traffic",
            "verify you are human",
            "are you a robot",
            "access denied",
            "异常流量",
            "检测到异常",
        ]
        .iter()
        .any(|needle| lower_title.contains(needle) || lower_text.contains(needle));
    if weak {
        Some("人机验证 / 反爬拦截".to_string())
    } else {
        None
    }
}

/// Capture the current page state (title / url / visible text / elements / shot).
fn snapshot(tab: &Tab, result: Option<String>) -> Result<BrowserState, String> {
    let title = tab.get_title().unwrap_or_default();
    let url = tab.get_url();
    let text = tab
        .find_element("body")
        .ok()
        .and_then(|e| e.get_inner_text().ok())
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(3000)
        .collect::<String>();
    // Tag + mark interactive elements BEFORE the screenshot so the numbered marks
    // appear in the captured image (Set-of-Mark grounding).
    let elements = enumerate_elements(tab);
    std::thread::sleep(Duration::from_millis(60)); // let the marks paint
    let png = tab
        .capture_screenshot(CaptureScreenshotFormatOption::Png, None, None, true)
        .map_err(|e| e.to_string())?;
    // Compact JPEG so the screenshot data URL doesn't blow the AI body limit (413).
    let screenshot = crate::capture::bytes_to_jpeg_data_url(&png, 1280, 68)?;
    let blocked = detect_wall(tab, &title, &url, &text);
    let session_note = SESSION_NOTE.lock().ok().and_then(|mut slot| slot.take());
    Ok(BrowserState {
        title,
        url,
        text,
        screenshot,
        elements,
        result,
        blocked,
        session_note,
    })
}

fn current_or_launch_tab() -> Result<Arc<Tab>, String> {
    let generation = {
        let state = BROWSER.lock().map_err(|_| "browser state poisoned")?;
        if let Some(session) = state.session.as_ref() {
            return Ok(session.tab.clone());
        }
        state.generation
    };

    // Launching Chrome can be slow. Keep the state lock free so close/reload can
    // invalidate this attempt while the browser process is coming up.
    let launched = match try_connect_existing() {
        Some(session) => session,
        None => launch()?,
    };
    let mut launched = Some(launched);
    let tab = {
        let mut state = BROWSER.lock().map_err(|_| "browser state poisoned")?;
        if !state.launch_is_current(generation) {
            None
        } else if let Some(session) = state.session.as_ref() {
            Some(session.tab.clone())
        } else {
            state.session = launched.take();
            state.session.as_ref().map(|session| session.tab.clone())
        }
    };

    // A close won the race or another session was installed. The unused browser
    // is intentionally dropped after releasing the state lock.
    drop(launched);
    tab.ok_or_else(|| "browser was closed while starting".to_string())
}

/// Remove a dead session only when it still owns the tab that failed. A newer
/// launch or a concurrent close must not be torn down by an older request.
fn take_current_session_for_tab(tab: &Arc<Tab>) -> Result<Option<Session>, String> {
    let mut state = BROWSER.lock().map_err(|_| "browser state poisoned")?;
    if state
        .session
        .as_ref()
        .is_some_and(|session| Arc::ptr_eq(&session.tab, tab))
    {
        Ok(state.session.take())
    } else {
        Ok(None)
    }
}

/// Remove the visible session and invalidate in-flight launches. The caller must
/// drop the returned session outside `BROWSER` and preferably under the operation
/// lock so an active CDP request is allowed to finish first.
fn take_browser_session() -> Option<Session> {
    let mut state = BROWSER.lock().ok()?;
    state.invalidate()
}

/// Run a closure against the (lazily-launched) shared tab, on a blocking thread.
async fn with_tab<F>(f: F) -> Result<BrowserState, String>
where
    F: Fn(&Tab) -> Result<Option<String>, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || -> Result<BrowserState, String> {
        // The operation lock preserves the single-tab action order without making
        // close/reload wait on the browser-state mutex.
        let _operation = BROWSER_OPERATION
            .lock()
            .map_err(|_| "browser operation state poisoned")?;
        // Run against the shared tab. If the cached browser's CDP connection is DEAD
        // (it timed out / crashed / was closed — "underlying connection is closed"),
        // toss the stale session, relaunch a fresh browser, and retry ONCE. Without
        // this, a single navigation timeout bricks the browser for the whole session.
        let mut last_err = String::new();
        for attempt in 0..2 {
            let tab = current_or_launch_tab()?;
            // CDP calls, the performance-sampling sleep, and screenshots run
            // without BROWSER locked. The operation lock above still serializes
            // mutations of the persistent tab.
            let outcome = f(&tab).and_then(|result| snapshot(&tab, result));
            match outcome {
                Ok(state) => return Ok(state),
                Err(e) => {
                    last_err = e;
                    if attempt == 0 && is_dead_browser(&last_err) {
                        // Do not tear down a replacement session that was installed
                        // after this tab failed. Drop the stale process outside the
                        // state lock while the operation remains serialized.
                        drop(take_current_session_for_tab(&tab)?);
                        continue;
                    }
                    return Err(last_err);
                }
            }
        }
        Err(last_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Does this error mean the browser's CDP connection died (so we should relaunch a
/// fresh browser instead of surfacing a dead-connection error to the user)?
fn is_dead_browser(e: &str) -> bool {
    let s = e.to_lowercase();
    // 先排除**页面层**的错误。它们读起来都像"没了"，但没了的是一个节点、一个执行上下文，
    // 不是浏览器。判错的代价极大：这个函数返回 true 就会把整个浏览器杀掉重开，
    // 用户当前那一页、滚动位置、填了一半的表单全没，Dock 里还多一个新窗口。
    //
    // 用户的原话：「如果做错一步 我的浏览器就会被关闭 他又重新开新的 没必要」。
    // 成因就在下面两条裸匹配上：
    //   · `no longer`  → 命中 "Node is no longer attached to the DOM"。页面刚重绘之后点击
    //                    几乎必然报这句，是最普通不过的一次重试，却被当成"浏览器死了"。
    //   · `channel`    → 谁的错误文本里带这个词都算，包括页面自己的报错、URL 里的
    //                    /channel/、eval 出来的业务异常。
    // 两条都收紧成它们**真正想匹配的那句整话**。
    if s.contains("no longer attached")
        || s.contains("node with given id")
        || s.contains("could not find node")
        || s.contains("cannot find context")
        || s.contains("execution context was destroyed")
        || s.contains("execution context is not available")
    {
        return false;
    }
    s.contains("underlying connection is closed")
        || s.contains("connection is closed")
        || s.contains("connection closed")
        || s.contains("not connected")
        || s.contains("websocket connection closed")   // 原来是裸的 "websocket"
        || s.contains("channel closed")                // 原来是裸的 "channel"
        || s.contains("no longer connected")           // 原来是裸的 "no longer"
        || s.contains("session with given id not found")
        || s.contains("target closed")
        || s.contains("browser process")
}

fn is_navigation_wait_timeout(e: &str) -> bool {
    let s = e.to_lowercase();
    s.contains("event waited for never came")
        || s.contains("waited for never came")
        || s.contains("timed out waiting")
        || s.contains("timeout while waiting")
        || s.contains("navigation timeout")
}

fn normalize_navigation_url(url: &str) -> String {
    let url = url.trim();
    // Preserve URLs that already carry a scheme. Local HTML and data documents
    // are first-class preview targets for the IDE, so they must reach Chrome
    // unchanged instead of being rewritten as https://file:///... .
    if url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("file://")
        || url.starts_with("about:")
        || url.starts_with("data:")
    {
        url.to_string()
    } else if url.len() >= 2 && url.as_bytes()[1] == b':' && url.as_bytes()[0].is_ascii_alphabetic()
    {
        // Windows drive path (D:\... or D:/...) -> local file URL.
        format!("file:///{}", url.replace('\\', "/"))
    } else if url.starts_with('/') {
        // Unix absolute path (/Users/.../index.html) -> local file URL.
        format!("file://{url}")
    } else {
        // Bare host / domain defaults to HTTPS.
        format!("https://{url}")
    }
}

/// Open a URL (launches the browser on first use).
#[tauri::command]
pub async fn browser_navigate(url: String) -> Result<BrowserState, String> {
    let url = normalize_navigation_url(&url);
    with_tab(move |tab| {
        tab.navigate_to(&url).map_err(|e| e.to_string())?;
        match tab.wait_until_navigated() {
            Ok(_) => Ok(None),
            Err(e) => {
                let msg = e.to_string();
                if is_navigation_wait_timeout(&msg) {
                    // Old / redirected / non-UTF8 pages sometimes never emit the lifecycle event
                    // headless_chrome waits for, even though Chrome has a usable DOM. Returning a
                    // snapshot is far better evidence than failing the whole card and making the
                    // model retry random URLs.
                    std::thread::sleep(Duration::from_millis(900));
                    Ok(Some(format!(
                        "[NAVIGATION_WAIT_TIMEOUT] 页面没有发出完整导航完成事件，已改为读取当前 DOM/截图继续验证；不要把这当成 URL 错误，先看当前 url/title/text/nodes。原始错误: {}",
                        msg.chars().take(180).collect::<String>()
                    )))
                } else {
                    Err(msg)
                }
            }
        }
    })
    .await
}

/// Click an element via JS eval — works inside iframes (same-origin) where
/// CDP's `DOM.querySelector` can't reach. Last-resort fallback.
/// 元素**找到了但当前动不了**时的诊断。三种形状（disabled / not_visible / covered by）
/// 各自指向完全不同的下一步，所以必须把原文带回给模型，而不是笼统说一句"没找到"——
/// 否则模型会去换五种选择器重试，而真正该做的是先关掉遮罩 / 先满足启用条件。
///
/// 这段话原来在 browser_click / browser_type 里**抄了三份**（人类化路径、两条 eval 兜底），
/// 改一处就会漂三份。收成一个函数：措辞只有一份，三个调用点共用。
fn unactionable_reason(selector: &str, reason: &str) -> Option<String> {
    let r = reason.trim();
    if !(r.starts_with("disabled") || r.starts_with("not_visible") || r.starts_with("covered by")) {
        return None;
    }
    Some(format!(
        "[失败] 操作不到「{selector}」：{r}。这不是选择器写错——元素找到了。covered by 说明它被别的元素盖住（先关掉那个遮罩/弹层），not_visible 说明它在页面上不可见，disabled 说明它当前不可操作（先满足启用它的前置条件）。"
    ))
}

/// 解析出一个**真实可点**的页面坐标，供 CDP 人类化点击用。复用 click_via_eval 的定位/
/// 可见性/遮挡判定，但**不派发任何事件**——只回一个点或一句诊断。iframe-aware。
/// 成功返回 (x, y)（视口坐标）；失败的 Err 文本沿用同一套词：
/// "no"（没找到）/ "disabled …" / "not_visible …" / "covered by …"。
fn resolve_click_point(tab: &Tab, selector: &str) -> Result<(f64, f64), String> {
    let sel_js = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        r#"(()=>{{var s={sel_js};
function docs(){{var out=[document],fs=document.querySelectorAll('iframe');for(var k=0;k<fs.length;k++){{try{{if(fs[k].contentDocument)out.push(fs[k].contentDocument)}}catch(e){{}}}}return out}}
function find(){{var ds=docs();for(var d=0;d<ds.length;d++){{try{{var el=ds[d].querySelector(s);if(el)return el}}catch(e){{}}}}return null}}
function visible(el){{try{{var r=el.getBoundingClientRect(),cs=(el.ownerDocument.defaultView||window).getComputedStyle(el);return r.width>1&&r.height>1&&cs.visibility!=='hidden'&&cs.display!=='none'&&Number(cs.opacity||1)>0.01}}catch(e){{return false}}}}
function disabled(el){{try{{return !!(el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[disabled],[aria-disabled="true"]'))}}catch(e){{return false}}}}
function brief(el){{try{{if(!el)return'';var t=String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,60);return el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(t?' "'+t+'"':'')}}catch(e){{return'element'}}}}
function clickable(el){{try{{var q='a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick],label,summary';return el.matches(q)?el:(el.closest(q)||el)}}catch(e){{return el}}}}
function point(el){{var doc=el.ownerDocument||document,win=doc.defaultView||window,r=el.getBoundingClientRect(),pts=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]];for(var i=0;i<pts.length;i++){{var x=Math.max(1,Math.min((win.innerWidth||1)-2,r.left+r.width*pts[i][0])),y=Math.max(1,Math.min((win.innerHeight||1)-2,r.top+r.height*pts[i][1])),top=null;try{{top=doc.elementFromPoint(x,y)}}catch(e){{}}if(top&&(top===el||el.contains(top)))return{{ok:true,x:x,y:y}};}}return{{ok:false,top:top}}}}
var raw=find();if(!raw)return JSON.stringify({{ok:false,reason:'no'}});
var el=clickable(raw);if(disabled(el))return JSON.stringify({{ok:false,reason:'disabled '+brief(el)}});
try{{el.scrollIntoView({{block:'center',inline:'center',behavior:'instant'}})}}catch(e){{try{{el.scrollIntoView({{block:'center',inline:'center'}})}}catch(e2){{}}}}
if(!visible(el))return JSON.stringify({{ok:false,reason:'not_visible '+brief(el)}});
var p=point(el);if(!p.ok)return JSON.stringify({{ok:false,reason:'covered by '+brief(p.top)}});
return JSON.stringify({{ok:true,x:p.x,y:p.y}})}})()"#
    );
    let ro = tab.evaluate(&js, false).map_err(|e| e.to_string())?;
    let raw = ro.value.as_ref().and_then(|v| v.as_str()).unwrap_or("");
    let parsed: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    if parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let x = parsed.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = parsed.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if x > 0.0 && y > 0.0 {
            return Ok((x, y));
        }
        return Err("no".into());
    }
    Err(parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("no")
        .to_string())
}

/// 人类化地移动指针到 (x, y) 并点一下：从上次落点沿 ease_path 走一串 mouseMoved（trusted），
/// 到位停一拍，再 click_point（press+release，trusted）。曲线/时长来自 human_input（有单测）。
fn human_click(tab: &Tab, x: f64, y: f64) -> Result<(), String> {
    let from = { *LAST_MOUSE.lock().unwrap() }.unwrap_or((x - 40.0, y - 60.0));
    let seed = x.to_bits().wrapping_mul(0x0100_0000_01b3) ^ y.to_bits();
    for (px, py) in human_input::ease_path(from, (x, y), seed) {
        tab.move_mouse_to_point(Point { x: px, y: py })
            .map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(human_input::move_step_delay_ms(
            seed ^ px.to_bits(),
        )));
    }
    std::thread::sleep(Duration::from_millis(human_input::move_step_delay_ms(seed)));
    tab.click_point(Point { x, y }).map_err(|e| e.to_string())?;
    *LAST_MOUSE.lock().unwrap() = Some((x, y));
    Ok(())
}

/// 聚焦并清空目标输入框（复用 eval 那套 iframe-aware 定位，保证 React 受控组件也被真正清掉），
/// 好让随后的 CDP 逐字符敲从空开始、落在正确元素上。成功即 Ok（元素已聚焦）。
fn focus_and_clear(tab: &Tab, selector: &str) -> Result<(), String> {
    let sel_js = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        r#"(()=>{{var s={sel_js};
function docs(){{var out=[document],fs=document.querySelectorAll('iframe');for(var k=0;k<fs.length;k++){{try{{if(fs[k].contentDocument)out.push(fs[k].contentDocument)}}catch(e){{}}}}return out}}
function find(){{var ds=docs();for(var d=0;d<ds.length;d++){{try{{var el=ds[d].querySelector(s);if(el)return el}}catch(e){{}}}}return null}}
function target(el){{try{{if(el.tagName==='LABEL'&&el.control)return el.control;if(el.matches('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'))return el;return el.querySelector('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]')||el}}catch(e){{return el}}}}
function fire(el,name){{try{{el.dispatchEvent(new Event(name,{{bubbles:true,cancelable:true}}))}}catch(e){{}}}}
var raw=find();if(!raw)return'no';var el=target(raw);
try{{el.scrollIntoView({{block:'center',inline:'center',behavior:'instant'}})}}catch(e){{}}
try{{el.focus({{preventScroll:true}})}}catch(e){{try{{el.focus()}}catch(e2){{}}}}
try{{if(el.isContentEditable){{el.textContent='';}}else if('value'in el){{var proto=Object.getPrototypeOf(el),base=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,desc=Object.getOwnPropertyDescriptor(proto,'value')||Object.getOwnPropertyDescriptor(base,'value');(desc&&desc.set?desc.set:function(v){{el.value=v}}).call(el,'');}}fire(el,'input');fire(el,'change')}}catch(e){{}}
return document.activeElement===el||(el.ownerDocument&&el.ownerDocument.activeElement===el)?'ok':'ok_maybe'}})()"#
    );
    let ro = tab.evaluate(&js, false).map_err(|e| e.to_string())?;
    let v = ro.value.as_ref().and_then(|v| v.as_str()).unwrap_or("");
    if v == "ok" || v == "ok_maybe" {
        Ok(())
    } else {
        Err(format!("focus_failed:{v}"))
    }
}

/// 逐字符按人类 cadence 敲入（CDP key events，trusted），字符之间停顿来自 human_input。
/// 前置：目标已聚焦（见 focus_and_clear）。
fn human_type(tab: &Tab, text: &str) -> Result<(), String> {
    let seed = text.len() as u64;
    let delays = human_input::keystroke_delays(text, seed);
    for (ch, d) in text.chars().zip(delays) {
        let mut buf = [0u8; 4];
        tab.type_str(ch.encode_utf8(&mut buf))
            .map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(d));
    }
    Ok(())
}

fn click_via_eval(tab: &Tab, selector: &str) -> Result<(), String> {
    let sel_js = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        r#"(()=>{{var s={sel_js};
function docs(){{var out=[document],fs=document.querySelectorAll('iframe');for(var k=0;k<fs.length;k++){{try{{if(fs[k].contentDocument)out.push(fs[k].contentDocument)}}catch(e){{}}}}return out}}
function find(){{var ds=docs();for(var d=0;d<ds.length;d++){{try{{var el=ds[d].querySelector(s);if(el)return el}}catch(e){{}}}}return null}}
function visible(el){{try{{var r=el.getBoundingClientRect(),cs=(el.ownerDocument.defaultView||window).getComputedStyle(el);return r.width>1&&r.height>1&&cs.visibility!=='hidden'&&cs.display!=='none'&&Number(cs.opacity||1)>0.01}}catch(e){{return false}}}}
function disabled(el){{try{{return !!(el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[disabled],[aria-disabled="true"]'))}}catch(e){{return false}}}}
function brief(el){{try{{if(!el)return'';var t=String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,60);return el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(t?' "'+t+'"':'')}}catch(e){{return'element'}}}}
function clickable(el){{try{{var q='a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick],label,summary';return el.matches(q)?el:(el.closest(q)||el)}}catch(e){{return el}}}}
function point(el){{var doc=el.ownerDocument||document,win=doc.defaultView||window,r=el.getBoundingClientRect(),pts=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]];for(var i=0;i<pts.length;i++){{var x=Math.max(1,Math.min((win.innerWidth||1)-2,r.left+r.width*pts[i][0])),y=Math.max(1,Math.min((win.innerHeight||1)-2,r.top+r.height*pts[i][1])),top=null;try{{top=doc.elementFromPoint(x,y)}}catch(e){{}}if(top&&(top===el||el.contains(top)))return{{ok:true,x:x,y:y,top:top}};}}return{{ok:false,top:top}}}}
function ptr(el,name,p,down){{var w=el.ownerDocument.defaultView||window,c={{bubbles:true,cancelable:true,composed:true,view:w,clientX:p.x,clientY:p.y,screenX:p.x,screenY:p.y,button:0,buttons:down?1:0}};try{{if(/^pointer/.test(name)&&typeof PointerEvent!=='undefined'){{var pi=Object.assign({{}},c,{{pointerId:1,pointerType:'mouse',isPrimary:true,pressure:down?0.5:0}});el.dispatchEvent(new PointerEvent(name,pi));return}}}}catch(e){{}}try{{el.dispatchEvent(new MouseEvent(name.replace(/^pointer/,'mouse'),c))}}catch(e){{}}}}
var raw=find();if(!raw)return'no';
var el=clickable(raw);if(disabled(el))return'disabled '+brief(el);
try{{el.scrollIntoView({{block:'center',inline:'center',behavior:'instant'}})}}catch(e){{try{{el.scrollIntoView({{block:'center',inline:'center'}})}}catch(e2){{}}}}
if(!visible(el))return'not_visible '+brief(el);
var p=point(el);if(!p.ok)return'covered by '+brief(p.top);
ptr(el,'pointerover',p,false);ptr(el,'pointermove',p,false);ptr(el,'mouseover',p,false);ptr(el,'mousemove',p,false);ptr(el,'pointerdown',p,true);ptr(el,'mousedown',p,true);
try{{el.focus({{preventScroll:true}})}}catch(e){{try{{el.focus()}}catch(e2){{}}}}
ptr(el,'pointerup',p,false);ptr(el,'mouseup',p,false);
try{{el.click()}}catch(e){{try{{el.dispatchEvent(new MouseEvent('click',{{bubbles:true,cancelable:true,composed:true,view:el.ownerDocument.defaultView||window,clientX:p.x,clientY:p.y,button:0}}))}}catch(e2){{return String(e2&&e2.message||e2)}}}}
return'ok'}})()"#
    );
    let ro = tab.evaluate(&js, false).map_err(|e| e.to_string())?;
    let v = ro.value.as_ref().and_then(|v| v.as_str()).unwrap_or("");
    if v == "ok" {
        Ok(())
    } else {
        Err(format!("元素不可点击或未找到: {selector} ({v})"))
    }
}

/// Type into an element via JS eval — iframe-aware fallback.
fn type_via_eval(tab: &Tab, selector: &str, text: &str) -> Result<(), String> {
    let sel_js = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let txt_js = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        r#"(()=>{{var s={sel_js},t={txt_js};
function docs(){{var out=[document],fs=document.querySelectorAll('iframe');for(var k=0;k<fs.length;k++){{try{{if(fs[k].contentDocument)out.push(fs[k].contentDocument)}}catch(e){{}}}}return out}}
function find(){{var ds=docs();for(var d=0;d<ds.length;d++){{try{{var el=ds[d].querySelector(s);if(el)return el}}catch(e){{}}}}return null}}
function target(el){{try{{if(el.tagName==='LABEL'&&el.control)return el.control;if(el.matches('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'))return el;return el.querySelector('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]')||el}}catch(e){{return el}}}}
function fire(el,name,data){{try{{if(name==='input'&&typeof InputEvent!=='undefined')el.dispatchEvent(new InputEvent('input',{{bubbles:true,cancelable:true,inputType:'insertText',data:data||t}}));else el.dispatchEvent(new Event(name,{{bubbles:true,cancelable:true}}))}}catch(e){{try{{el.dispatchEvent(new Event(name,{{bubbles:true}}))}}catch(e2){{}}}}}}
function nativeSet(el,val){{if(el.isContentEditable){{try{{el.focus()}}catch(e){{}}el.textContent=val;fire(el,'input',val);fire(el,'change',val);return true}}
 if(el.tagName==='SELECT'){{var opts=Array.prototype.slice.call(el.options||[]),hit=opts.find(function(o){{return String(o.value)===String(val)}})||opts.find(function(o){{return String(o.textContent||'').trim()===String(val).trim()}});if(hit)val=hit.value;try{{var sd=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');if(sd&&sd.set)sd.set.call(el,val);else el.value=val}}catch(e){{el.value=val}}fire(el,'input',val);fire(el,'change',val);return true}}
 if('value'in el){{try{{var proto=Object.getPrototypeOf(el),desc=proto&&Object.getOwnPropertyDescriptor(proto,'value'),base=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,desc2=Object.getOwnPropertyDescriptor(base,'value');(desc&&desc.set?desc:desc2).set.call(el,val)}}catch(e){{el.value=val}}fire(el,'beforeinput',val);fire(el,'input',val);fire(el,'change',val);return true}}return false}}
var raw=find();if(!raw)return'no';var el=target(raw);
try{{el.scrollIntoView({{block:'center',inline:'center',behavior:'instant'}})}}catch(e){{try{{el.scrollIntoView({{block:'center',inline:'center'}})}}catch(e2){{}}}}
try{{el.focus()}}catch(e){{}}try{{el.click()}}catch(e){{}}
if(!nativeSet(el,t))return'not_editable';
var actual=el.isContentEditable?String(el.textContent||''):String(el.value||'');
return actual===String(t)||actual.indexOf(String(t))>=0?'ok':'value_not_applied '+actual.slice(0,80)}})()"#
    );
    let ro = tab.evaluate(&js, false).map_err(|e| e.to_string())?;
    let v = ro.value.as_ref().and_then(|v| v.as_str()).unwrap_or("");
    if v == "ok" {
        Ok(())
    } else {
        Err(format!("输入未生效或未找到: {selector} ({v})"))
    }
}

/// Click the first element matching a CSS selector.
#[tauri::command]
pub async fn browser_click(selector: String) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        // ① 人类化 CDP 点击优先：trusted 事件 + 真实轨迹 + 按住时长，比合成 el.click() 像真人得多。
        //    只在两种情形收口：成功；或元素找到但当前不可点（disabled/covered/not_visible，返回
        //    和下方同一套富诊断）。其余情况（没找到、派发失败）静默落到原有兜底链路，行为不变。
        match resolve_click_point(tab, &selector) {
            Ok((x, y)) => {
                if human_click(tab, x, y).is_ok() {
                    std::thread::sleep(Duration::from_millis(140));
                    let _ = tab.wait_until_navigated();
                    return Ok(None);
                }
            }
            Err(reason) => {
                if let Some(msg) = unactionable_reason(&selector, &reason) {
                    return Err(msg);
                }
            }
        }
        // ② 兜底：原有 eval 合成事件 + 原生 CDP click 链路（下面原封不动）。
        match click_via_eval(tab, &selector) {
            Ok(_) => {
                std::thread::sleep(Duration::from_millis(260));
                let _ = tab.wait_until_navigated();
                return Ok(None);
            }
            Err(first_err)
                if selector.starts_with("[data-mref=") || selector.starts_with("[data-mnode=") =>
            {
                enumerate_elements(tab);
                std::thread::sleep(Duration::from_millis(80));
                if click_via_eval(tab, &selector).is_ok() {
                    std::thread::sleep(Duration::from_millis(260));
                    let _ = tab.wait_until_navigated();
                    return Ok(None);
                }
                let _ = first_err;
            }
            Err(reason) => {
                // 只有「真找不到元素」才允许降级到坐标兜底。
                //
                // click_via_eval / type 的失败是有内容的：disabled …／not_visible …／covered by …，
                // 而这里原来是 `Err(_) => {}` 全吞掉，然后照样按坐标操作——被 cookie 横幅或模态
                // 遮罩盖住时，那一下作用在遮罩上，工具却报成功。模型于是换五种选择器重试，
                // 而真正该做的是先关掉遮罩；disabled 时该做的是先满足启用它的前置条件。
                // 把原文带回去，这三种情形模型自己就判得出下一步。
                if let Some(msg) = unactionable_reason(&selector, &reason) {
                    return Err(msg);
                }
            }
        }
        let el = match tab.find_element(&selector) {
            Ok(el) => el,
            Err(_)
                if selector.starts_with("[data-mref=") || selector.starts_with("[data-mnode=") =>
            {
                enumerate_elements(tab);
                std::thread::sleep(Duration::from_millis(150));
                match tab.find_element(&selector) {
                    Ok(el) => el,
                    Err(_) => {
                        click_via_eval(tab, &selector)?;
                        std::thread::sleep(Duration::from_millis(400));
                        let _ = tab.wait_until_navigated();
                        return Ok(None);
                    }
                }
            }
            Err(_) => {
                click_via_eval(tab, &selector).map_err(|_| format!("找不到元素: {selector}"))?;
                std::thread::sleep(Duration::from_millis(400));
                let _ = tab.wait_until_navigated();
                return Ok(None);
            }
        };
        el.click().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(400));
        let _ = tab.wait_until_navigated();
        Ok(None)
    })
    .await
}

/// Type text into the element matching a CSS selector (clicks it first).
#[tauri::command]
pub async fn browser_type(selector: String, text: String) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        // ① 人类化输入优先：先聚焦+清空（复用 eval 定位，React 受控组件也真被清掉），
        //    再用 CDP 逐字符按 cadence 敲（trusted key events）。成功即返回；任何一步不成
        //    静默落到原有 type_via_eval 兜底（它按整段 native-set，幂等，能兜住半成品状态）。
        if focus_and_clear(tab, &selector).is_ok() && human_type(tab, &text).is_ok() {
            return Ok(None);
        }
        match type_via_eval(tab, &selector, &text) {
            Ok(_) => return Ok(None),
            Err(first_err)
                if selector.starts_with("[data-mref=") || selector.starts_with("[data-mnode=") =>
            {
                enumerate_elements(tab);
                std::thread::sleep(Duration::from_millis(80));
                if type_via_eval(tab, &selector, &text).is_ok() {
                    return Ok(None);
                }
                let _ = first_err;
            }
            Err(reason) => {
                // 只有「真找不到元素」才允许降级到坐标兜底。
                //
                // click_via_eval / type 的失败是有内容的：disabled …／not_visible …／covered by …，
                // 而这里原来是 `Err(_) => {}` 全吞掉，然后照样按坐标操作——被 cookie 横幅或模态
                // 遮罩盖住时，那一下作用在遮罩上，工具却报成功。模型于是换五种选择器重试，
                // 而真正该做的是先关掉遮罩；disabled 时该做的是先满足启用它的前置条件。
                // 把原文带回去，这三种情形模型自己就判得出下一步。
                if let Some(msg) = unactionable_reason(&selector, &reason) {
                    return Err(msg);
                }
            }
        }
        let el = match tab.find_element(&selector) {
            Ok(el) => el,
            Err(_)
                if selector.starts_with("[data-mref=") || selector.starts_with("[data-mnode=") =>
            {
                enumerate_elements(tab);
                std::thread::sleep(Duration::from_millis(150));
                match tab.find_element(&selector) {
                    Ok(el) => el,
                    Err(_) => {
                        type_via_eval(tab, &selector, &text)?;
                        return Ok(None);
                    }
                }
            }
            Err(_) => {
                type_via_eval(tab, &selector, &text)
                    .map_err(|_| format!("找不到输入框: {selector}"))?;
                return Ok(None);
            }
        };
        el.click().map_err(|e| e.to_string())?;
        el.type_into(&text).map_err(|e| e.to_string())?;
        Ok(None)
    })
    .await
}

/// 标签页管理：list / new / switch / close。
///
/// 会话里一直只有**一个**当前 tab（`Session.tab`），所有动作都打在它上面。跨站流程
/// （在邮箱里读验证码再回到登录页、对照两个页面）以前只能在同一个 tab 里来回 navigate，
/// 登录表单一回来就重置。这里让模型开第二个 tab、在 tab 之间切换；`with_tab` 之后照常
/// 作用于"当前 tab"，所以 switch 之后的 click/type/observe 不用改写法。
/// 回执是结构化事实（tabs 数组 + current 下标），给模型的话在 JS 侧拼。
#[tauri::command]
pub async fn browser_tab(
    op: String,
    index: Option<usize>,
    url: Option<String>,
) -> Result<BrowserState, String> {
    tauri::async_runtime::spawn_blocking(move || tab_op(&op, index, url.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// browser_tab 的同步核心：作用于全局会话（BROWSER）。拆出来是为了能在测试里对着一只
/// 临时 profile 的无头 Chrome 真跑一遍（见 tab_ops_real_chrome，`--ignored`）。
fn tab_op(op: &str, index: Option<usize>, url: Option<&str>) -> Result<BrowserState, String> {
    {
        let _operation = BROWSER_OPERATION
            .lock()
            .map_err(|_| "browser operation state poisoned")?;
        let current = current_or_launch_tab()?;
        let browser = {
            let state = BROWSER.lock().map_err(|_| "browser state poisoned")?;
            state
                .session
                .as_ref()
                .map(|s| s._browser.clone())
                .ok_or_else(|| "浏览器已关闭".to_string())?
        };
        let all: Vec<Arc<Tab>> = browser
            .get_tabs()
            .lock()
            .map_err(|_| "tab list poisoned")?
            .iter()
            .cloned()
            .collect();
        let op = op.trim().to_ascii_lowercase();
        let target_of = |i: Option<usize>| -> Result<Arc<Tab>, String> {
            let i = i.ok_or_else(|| format!("browser tab op={op} 需要 tab（下标，从 list 里拿）"))?;
            all.get(i)
                .cloned()
                .ok_or_else(|| format!("没有第 {i} 个标签页（现在共 {} 个，下标从 0 起）", all.len()))
        };
        let (tab, tabs_after): (Arc<Tab>, Vec<Arc<Tab>>) = match op.as_str() {
            "list" => (current.clone(), all.clone()),
            "new" => {
                let tab = browser.new_tab().map_err(|e| e.to_string())?;
                configure_new_tab(&tab)?;
                if let Some(u) = url.filter(|u| !u.trim().is_empty()) {
                    tab.navigate_to(u.trim()).map_err(|e| e.to_string())?;
                    let _ = tab.wait_until_navigated();
                }
                let mut after = all.clone();
                after.push(tab.clone());
                set_current_tab(tab.clone())?;
                (tab, after)
            }
            "switch" => {
                let tab = target_of(index)?;
                let _ = tab.activate();
                set_current_tab(tab.clone())?;
                (tab, all.clone())
            }
            "close" => {
                let victim = target_of(index)?;
                let was_current = victim.get_target_id() == current.get_target_id();
                let after: Vec<Arc<Tab>> = all
                    .iter()
                    .filter(|t| t.get_target_id() != victim.get_target_id())
                    .cloned()
                    .collect();
                if after.is_empty() {
                    return Err("这是最后一个标签页，关它等于关浏览器：要关浏览器用 close".into());
                }
                let _ = victim.close(true);
                let next = if was_current { after[0].clone() } else { current.clone() };
                if was_current {
                    let _ = next.activate();
                    set_current_tab(next.clone())?;
                }
                (next, after)
            }
            other => return Err(format!("browser tab 不认识 op「{other}」；可用：list / new / switch / close")),
        };
        let rows: Vec<(String, String, String)> = tabs_after
            .iter()
            .map(|t| (t.get_target_id().to_string(), t.get_title().unwrap_or_default(), t.get_url()))
            .collect();
        let result = tab_rows_json(&op, &rows, tab.get_target_id());
        snapshot(&tab, Some(result))
    }
}

/// 把当前 tab 换成 `tab`；会话已经没了就报错（close 与本操作并发时会这样）。
fn set_current_tab(tab: Arc<Tab>) -> Result<(), String> {
    let mut state = BROWSER.lock().map_err(|_| "browser state poisoned")?;
    match state.session.as_mut() {
        Some(session) => {
            session.tab = tab;
            Ok(())
        }
        None => Err("浏览器已关闭".into()),
    }
}

/// 标签页清单的结构化回执：`{op, current, tabs:[{tab,title,url,current}]}`。纯函数，有单测。
fn tab_rows_json(op: &str, rows: &[(String, String, String)], current_id: &str) -> String {
    let mut current = 0usize;
    let tabs: Vec<serde_json::Value> = rows
        .iter()
        .enumerate()
        .map(|(i, (id, title, url))| {
            let is_current = id == current_id;
            if is_current {
                current = i;
            }
            serde_json::json!({ "tab": i, "title": title, "url": url, "current": is_current })
        })
        .collect();
    serde_json::json!({ "op": op, "current": current, "count": tabs.len(), "tabs": tabs }).to_string()
}

/// Set the file(s) of a <input type=file> matching a CSS selector — so the agent can
/// automate upload forms (which plain typing can't do). `paths` are absolute local paths.
#[tauri::command]
pub async fn browser_upload_file(
    selector: String,
    paths: Vec<String>,
) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        let el = tab
            .find_element(&selector)
            .map_err(|_| format!("找不到文件输入框: {selector}（要选中一个 <input type=file>）"))?;
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        el.set_input_files(&refs)
            .map_err(|e| format!("设置上传文件失败: {e}"))?;
        Ok(None)
    })
    .await
}

/// Press a key on the page (e.g. "Enter" to submit a form, "Tab", "Escape").
#[tauri::command]
pub async fn browser_press(key: String) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        // 按键要报**它落在了谁身上**。原来只说"按了"，而按键有没有生效完全取决于焦点：
        // 焦点在 body 上时 Enter 什么也不会提交，模型却以为提交了，接着去 assert 结果页。
        // 前后各取一次 activeElement，两边都摆出来，模型自己就能判断要不要先 click 聚焦。
        let focus_js = r#"(()=>{try{var a=document.activeElement;if(!a)return'(none)';
var t=String(a.value||a.innerText||a.textContent||a.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,40);
return a.tagName.toLowerCase()+(a.id?'#'+a.id:'')+(t?' "'+t+'"':'')}catch(e){return'(unknown)'}})()"#;
        let focus_of = |t: &Tab| -> String {
            t.evaluate(focus_js, false)
                .ok()
                .and_then(|v| v.value.and_then(|x| x.as_str().map(String::from)))
                .unwrap_or_default()
        };
        let before = focus_of(tab);
        tab.press_key(&key).map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(400));
        let _ = tab.wait_until_navigated();
        let after = focus_of(tab);
        let note = if before.is_empty() && after.is_empty() {
            String::new()
        } else {
            format!(
                "{{\"key\":\"{}\",\"focusBefore\":\"{}\",\"focusAfter\":\"{}\"{}}}",
                key.replace('"', "'"),
                before.replace('"', "'"),
                after.replace('"', "'"),
                if before.starts_with("body") || before == "(none)" {
                    ",\"warn\":\"按键时焦点在 body/无焦点上——按键多半没落到任何输入框或按钮上；先 click 目标再按\""
                } else { "" }
            )
        };
        Ok(if note.is_empty() { None } else { Some(note) })
    })
    .await
}

fn stringify_eval_result(value: Option<serde_json::Value>, description: Option<String>) -> String {
    value
        .map(|value| match value {
            serde_json::Value::String(text) => text,
            other => other.to_string(),
        })
        .or(description)
        .unwrap_or_default()
}

/// 页内 UI 规格提取器。
///
/// 不是"把 DOM 全吐出来"——那既超上限又没用。1:1 还原真正需要的是**这个页面实际用了
/// 哪些设计决定**：真在用的配色（按覆盖面积排序，不是声明里出现过就算）、字体组合、
/// 间距刻度、圆角、阴影，加上可见元素的盒模型骨架。
///
/// 这份东西是**读出来的事实**，不是看着截图猜的——所以"从网站还原"能做到接近 1:1，
/// 而"只给一张图"不能。两者的差别就在这里。
const UI_EXTRACT_JS: &str = r####"
(() => {
  const MAX_NODES = __MAX_NODES__;
  const px = (v) => Math.round(parseFloat(v) || 0);
  const seenBg = new Map();
  const seenText = new Map();
  const seenType = new Map();
  const spacing = new Map();
  const radii = new Map();
  const shadows = new Map();
  const nodes = [];
  const assets = [];

  const norm = (c) => {
    if (!c) return "";
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return String(c);
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length >= 4 && p[3] === 0) return "";
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return "#" + h(p[0]) + h(p[1]) + h(p[2]);
  };
  const bump = (map, key, weight) => { if (key) map.set(key, (map.get(key) || 0) + weight); };

  const vw = window.innerWidth, vh = window.innerHeight;
  // 必须把 html 和 body 自己算进去。
  //
  // 原来只走 body.querySelectorAll("*")——那**不含 body 和 html 自身**，于是页面真正的
  // 底色一次都没被采到。在 example.com 上实测：背景是白的，提取出来的主色却是文字的
  // #000000。照这份规格还原会做出一个黑底页面，而且模型没有任何依据察觉不对。
  const roots = [document.documentElement, document.body].filter(Boolean);
  const all = document.body ? [...roots, ...document.body.querySelectorAll("*")] : roots;
  for (const el of all) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!r || r.width < 1 || r.height < 1) continue;
    if (r.bottom < -50 || r.top > vh + 400) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    const area = r.width * r.height;

    // 背景色和文字色分开统计。混在一张表里模型分不清"这是底色"还是"这是字色"——
    // 而这两者在还原时是完全不同的用途，搞反了整页观感就反了。
    bump(seenBg, norm(cs.backgroundColor), area);
    const text = (el.childElementCount === 0 ? (el.textContent || "") : "").trim();
    if (text) {
      bump(seenText, norm(cs.color), Math.max(area, 400));
      const key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, norm(cs.color)].join("|");
      const prev = seenType.get(key);
      if (prev) { prev.count += 1; }
      else {
        seenType.set(key, {
          family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight,
          lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
          color: norm(cs.color), count: 1, sample: text.slice(0, 40)
        });
      }
    }
    const spaceKeys = ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "gap", "rowGap", "columnGap"];
    for (const k of spaceKeys) {
      const v = px(cs[k]);
      if (v > 0 && v <= 200) bump(spacing, v, 1);
    }
    if (cs.borderRadius && cs.borderRadius !== "0px") bump(radii, cs.borderRadius, 1);
    if (cs.boxShadow && cs.boxShadow !== "none") bump(shadows, cs.boxShadow, 1);

    if (el.tagName === "IMG" && el.currentSrc) {
      assets.push({ type: "img", src: String(el.currentSrc).slice(0, 300), alt: (el.alt || "").slice(0, 60),
        x: px(r.left), y: px(r.top), w: px(r.width), h: px(r.height) });
    }
    const bg = cs.backgroundImage;
    if (bg && bg !== "none" && bg.indexOf("url(") === 0) {
      assets.push({ type: "bg", src: bg.slice(4, 200), x: px(r.left), y: px(r.top), w: px(r.width), h: px(r.height) });
    } else if (bg && bg.indexOf("gradient") >= 0) {
      assets.push({ type: "gradient", src: bg.slice(0, 200), x: px(r.left), y: px(r.top), w: px(r.width), h: px(r.height) });
    }

    nodes.push({
      _area: area,
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 3).join(" "),
      text: text.slice(0, 60),
      x: px(r.left), y: px(r.top), w: px(r.width), h: px(r.height),
      bg: norm(cs.backgroundColor),
      color: text ? norm(cs.color) : "",
      font: text ? (cs.fontSize + "/" + cs.fontWeight) : "",
      display: cs.display,
      dir: cs.display.indexOf("flex") >= 0 ? cs.flexDirection : (cs.display.indexOf("grid") >= 0 ? String(cs.gridTemplateColumns || "").slice(0, 60) : ""),
      pad: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)].join(" "),
      radius: cs.borderRadius === "0px" ? "" : cs.borderRadius,
      border: cs.borderTopWidth === "0px" ? "" : (cs.borderTopWidth + " " + cs.borderTopStyle + " " + norm(cs.borderTopColor)),
      shadow: cs.boxShadow === "none" ? "" : String(cs.boxShadow).slice(0, 80)
    });
  }

  nodes.sort((a, b) => b._area - a._area);
  const top = nodes.slice(0, MAX_NODES).map((n) => { delete n._area; return n; });
  const rank = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);

  const fonts = [];
  try { document.fonts.forEach((f) => { if (fonts.indexOf(f.family) < 0) fonts.push(f.family); }); } catch (e) {}

  return JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1 },
    pageHeight: Math.round(document.documentElement.scrollHeight),
    pageBackground: (() => {
      // 页面底色：body → html 往上找第一个不透明的；都透明就是浏览器默认白。
      for (const el of roots) {
        try { const c = norm(getComputedStyle(el).backgroundColor); if (c) return c; } catch (e) {}
      }
      return "#ffffff";
    })(),
    palette: rank(seenBg, 10).map((e) => ({ hex: e[0], role: "background", coverage: Math.round(e[1]) }))
      .concat(rank(seenText, 6).map((e) => ({ hex: e[0], role: "text", coverage: Math.round(e[1]) }))),
    typography: Array.from(seenType.values()).sort((a, b) => b.count - a.count).slice(0, 12),
    spacingScale: rank(spacing, 10).map((e) => e[0]).sort((a, b) => a - b),
    radii: rank(radii, 6).map((e) => e[0]),
    shadows: rank(shadows, 5).map((e) => e[0]),
    fonts: fonts.slice(0, 8),
    assets: assets.slice(0, 30),
    nodes: top,
    nodeTotal: nodes.length
  });
})()
"####;

/// 提取当前页面的 UI 规格（配色 / 字体 / 间距 / 圆角 / 阴影 / 可见元素盒模型 / 资源）。
///
/// 和 `browser_eval` 的区别不只是脚本：那个函数把结果砍在 8000 字符，对整页规格远远不够，
/// 而且砍完恰好是半截 JSON。这里给 60000，并且**超了如实说**——一份被截断的规格如果冒充
/// 完整，模型会照着它还原，然后对着缺失的部分反复困惑。
#[tauri::command]
pub async fn browser_extract_ui(max_nodes: Option<u32>) -> Result<BrowserState, String> {
    let n = max_nodes.unwrap_or(120).clamp(10, 400);
    let script = UI_EXTRACT_JS.replace("__MAX_NODES__", &n.to_string());
    with_tab(move |tab| {
        let ro = tab.evaluate(&script, true).map_err(|e| e.to_string())?;
        let val = stringify_eval_result(ro.value, ro.description);
        let total = val.chars().count();
        if total > 60000 {
            let head: String = val.chars().take(60000).collect();
            return Ok(Some(format!(
                "{head}\n\n[已截断] UI 规格共 {total} 字符，只返回了前 60000——**上面的 JSON 是半截的**。把 max_nodes 调小（如 60）重取，或者先只还原首屏。"
            )));
        }
        Ok(Some(val))
    })
    .await
}

/// Run JavaScript in the page and return its (stringified) result.
#[tauri::command]
pub async fn browser_eval(script: String) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        let ro = tab.evaluate(&script, true).map_err(|e| e.to_string())?;
        let val = stringify_eval_result(ro.value, ro.description);
        // 8000 chars (~2.7k tokens worst case) so structured tools — network 抓包,
        // inspect 视觉解析, design — can return their full JSON without truncating
        // mid-string (which would hand the model invalid JSON).
        //
        // 注释的意图是「8000 够用所以不会截断」，但代码里没有任何判断——超了就直接砍，
        // 而且恰恰砍出注释自己担心的那种半截 JSON。调用方看到「整页节点清单」，相信
        // nodes[] 是全集；中等复杂度的页面上 JSON 早就超过 8000，后半截连同结构一起没了，
        // 而它无从察觉。截断本身可以接受，**不说**不行。
        let total = val.chars().count();
        if total > 8000 {
            let head: String = val.chars().take(8000).collect();
            return Ok(Some(format!(
                "{head}\n\n[已截断] 本次页面求值结果共 {total} 字符，只返回了前 8000——**上面的 JSON 很可能是半截的，不要当成完整结构**。缩小选择器范围或分批取。"
            )));
        }
        Ok(Some(val))
    })
    .await
}

fn metric_values(
    metrics: &[headless_chrome::protocol::cdp::Performance::Metric],
) -> std::collections::HashMap<&str, f64> {
    metrics
        .iter()
        .filter(|metric| metric.value.is_finite())
        .map(|metric| (metric.name.as_str(), metric.value))
        .collect()
}

fn non_negative_delta(
    before: &std::collections::HashMap<&str, f64>,
    after: &std::collections::HashMap<&str, f64>,
    name: &str,
) -> Option<f64> {
    let delta = after.get(name)? - before.get(name)?;
    (delta >= 0.0 && delta.is_finite()).then_some(delta)
}

/// Sample Chrome's CDP Performance domain over a bounded interval. `TaskDuration`
/// and `Timestamp` are cumulative seconds, so their delta gives real main-thread
/// busy time rather than an event-loop-delay approximation.
#[tauri::command]
pub async fn browser_performance_sample(sample_ms: Option<u64>) -> Result<BrowserState, String> {
    let sample_ms = sample_ms.unwrap_or(750).clamp(250, 5_000);
    with_tab(move |tab| {
        tab.call_method(EnablePerformanceMetrics { time_domain: None })
            .map_err(|e| format!("启用 Chrome 性能指标失败: {e}"))?;
        let first = tab
            .call_method(GetMetrics(None))
            .map_err(|e| format!("读取第一次 Chrome 性能指标失败: {e}"))?;
        std::thread::sleep(Duration::from_millis(sample_ms));
        let second = tab
            .call_method(GetMetrics(None))
            .map_err(|e| format!("读取第二次 Chrome 性能指标失败: {e}"))?;

        let before = metric_values(&first.metrics);
        let after = metric_values(&second.metrics);
        let timestamp_seconds = non_negative_delta(&before, &after, "Timestamp");
        let task_seconds = non_negative_delta(&before, &after, "TaskDuration");
        let busy_percent = match (task_seconds, timestamp_seconds) {
            (Some(task), Some(elapsed)) if elapsed > 0.0 => {
                Some((task / elapsed * 100.0).min(100.0))
            }
            _ => None,
        };
        let milliseconds =
            |name: &str| non_negative_delta(&before, &after, name).map(|seconds| seconds * 1_000.0);
        let count = |name: &str| non_negative_delta(&before, &after, name);
        let value = serde_json::json!({
            "sampleWindowMs": sample_ms,
            "cpu": {
                "source": "Chrome CDP Performance.getMetrics",
                "metric": "TaskDuration / Timestamp",
                "busyPercent": busy_percent,
                "elapsedMs": timestamp_seconds.map(|seconds| seconds * 1_000.0),
                "taskDurationMs": task_seconds.map(|seconds| seconds * 1_000.0),
                "scriptDurationMs": milliseconds("ScriptDuration"),
                "layoutDurationMs": milliseconds("LayoutDuration"),
                "recalcStyleDurationMs": milliseconds("RecalcStyleDuration"),
                "layoutCount": count("LayoutCount"),
                "recalcStyleCount": count("RecalcStyleCount"),
            }
        });
        Ok(Some(value.to_string()))
    })
    .await
}

/// Re-screenshot the current page (no action) — just look again.
#[tauri::command]
pub async fn browser_screenshot() -> Result<BrowserState, String> {
    with_tab(move |_tab| Ok(None)).await
}

fn validate_viewport(
    width: u32,
    height: u32,
    device_scale_factor: Option<f64>,
    mobile: Option<bool>,
) -> Result<(u32, u32, f64, bool), String> {
    if !(240..=7680).contains(&width) || !(240..=7680).contains(&height) {
        return Err("viewport 宽高必须在 240..=7680 像素之间".into());
    }
    let scale = device_scale_factor.unwrap_or(1.0);
    if !scale.is_finite() || !(0.5..=4.0).contains(&scale) {
        return Err("device_scale_factor 必须是 0.5..=4.0 的有限数值".into());
    }
    // CDP screenshots are rendered at device pixels. A legal CSS viewport such
    // as 7680x7680 at scale 4 needs nearly 1 GiB for one RGBA frame and can
    // freeze the entire desktop process while it is encoded and sent over IPC.
    const MAX_VIEWPORT_DEVICE_PIXELS: f64 = 24_000_000.0;
    let device_pixels = width as f64 * height as f64 * scale * scale;
    if device_pixels > MAX_VIEWPORT_DEVICE_PIXELS {
        return Err("viewport 与 device_scale_factor 的组合过大（最多 2400 万设备像素）".into());
    }
    Ok((width, height, scale, mobile.unwrap_or(false)))
}

/// Override the persistent browser tab's viewport through CDP Emulation. This
/// changes CSS media-query/layout metrics as well as the following screenshot,
/// enabling deterministic desktop/mobile checks without launching another browser.
#[tauri::command]
pub async fn browser_set_viewport(
    width: u32,
    height: u32,
    device_scale_factor: Option<f64>,
    mobile: Option<bool>,
) -> Result<BrowserState, String> {
    let (width, height, device_scale_factor, mobile) =
        validate_viewport(width, height, device_scale_factor, mobile)?;
    with_tab(move |tab| {
        tab.call_method(SetDeviceMetricsOverride {
            width,
            height,
            device_scale_factor,
            mobile,
            scale: None,
            screen_width: Some(width),
            screen_height: Some(height),
            position_x: Some(0),
            position_y: Some(0),
            dont_set_visible_size: None,
            screen_orientation: None,
            viewport: None,
            display_feature: None,
            device_posture: None,
        })
        .map_err(|e| format!("设置浏览器 viewport 失败: {e}"))?;
        std::thread::sleep(Duration::from_millis(150));
        Ok(None)
    })
    .await
}

/// Scroll the page vertically (positive = down, negative = up), then re-snapshot —
/// so off-screen interactive elements come into view and get fresh refs/marks.
/// Without this, the agent could only ever act on what was in the first viewport.
#[tauri::command]
pub async fn browser_scroll(amount: i32) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        // 滚动要报**实际滚了多少**。原来是 `let _ = tab.evaluate(...)`——结果整个丢掉，
        // 于是「已经到底了」「页面根本不滚、真正滚的是某个 overflow 容器」「元素在模态里」
        // 三种情形和成功滚动长得一模一样。模型据此以为内容已经翻过去了，接着去找下面的元素。
        //
        // 这里只报事实，不拦截：滚不动有时是正常的（内容本来就一屏）。
        let js = format!(
            r#"(()=>{{
function box(){{var d=document.scrollingElement||document.documentElement||document.body;
  if(d&&d.scrollHeight>d.clientHeight+1)return{{el:d,name:'document'}};
  var all=[];try{{all=document.querySelectorAll('*')}}catch(e){{}}
  for(var i=0;i<all.length;i++){{var e=all[i];try{{var cs=getComputedStyle(e);
    if(/(auto|scroll)/.test(cs.overflowY)&&e.scrollHeight>e.clientHeight+1&&e.clientHeight>120)
      return{{el:e,name:e.tagName.toLowerCase()+(e.id?'#'+e.id:'')}}}}catch(e2){{}}}}
  return{{el:d,name:'document'}}}}
var b=box(),el=b.el,before=el.scrollTop;
try{{el.scrollBy?el.scrollBy(0,{amount}):(el.scrollTop=before+({amount}))}}catch(e){{el.scrollTop=before+({amount})}}
var after=el.scrollTop;
return JSON.stringify({{container:b.name,delta:after-before,scrollTop:after,
  atTop:after<=0,atBottom:after+el.clientHeight>=el.scrollHeight-1,
  scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}})}})()"#
        );
        let report = tab
            .evaluate(&js, false)
            .ok()
            .and_then(|v| v.value.and_then(|x| x.as_str().map(String::from)))
            .unwrap_or_default();
        std::thread::sleep(Duration::from_millis(350)); // let lazy content / sticky bars settle
        // with_tab 的 Ok(Some(..)) 就是走 BrowserState.result 那条额外结果通道，
        // 不需要全局变量。delta 为 0 时模型一眼能看出「这一下什么都没滚动」。
        Ok(if report.is_empty() { None } else { Some(report) })
    })
    .await
}

/// Wait for the page to settle: either until a CSS `selector` appears (polled, up
/// to ~8s) or for a fixed `ms`. Lets the agent act on a LOADED page instead of a
/// transient one (the #1 cause of flaky automation on SPAs / AJAX).
#[tauri::command]
pub async fn browser_wait(
    selector: Option<String>,
    ms: Option<u64>,
) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        // borrow (don't move) selector — the closure is Fn (may run twice on relaunch)
        match selector.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(sel) => {
                // 等待要等出**结论**。原来三个问题叠在一起：
                //   · 期限写死 8 秒，调用方传的 ms 根本不读；
                //   · 判据是 tab.find_element —— 只查主文档，而且只判「存在」不判「可见」，
                //     于是 display:none 的骨架屏、还没渲染完的容器都算命中；
                //   · **超时也 break 出来返回 Ok** —— 超时和命中长得一模一样。
                // 于是慢接口上这一步随机「成功」，模型接着去 assert 然后失败，
                // 它无从判断是选择器写错了还是等得不够久，只能瞎换定位。
                let deadline_ms = ms.unwrap_or(8000).clamp(100, 30000);
                let started = std::time::Instant::now();
                let sel_js = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into());
                // 可见性判据和 click 那条路对齐：穿透同源 iframe 与 shadow root，
                // 要求真实占位（宽高 > 1）且非 hidden/display:none。
                let probe = format!(
                    r#"(()=>{{var s={sel_js};
function roots(){{var out=[document],q=[document];while(q.length){{var d=q.shift();var fs=[];try{{fs=d.querySelectorAll('iframe')}}catch(e){{}}for(var k=0;k<fs.length;k++){{try{{if(fs[k].contentDocument){{out.push(fs[k].contentDocument);q.push(fs[k].contentDocument)}}}}catch(e){{}}}}var all=[];try{{all=d.querySelectorAll('*')}}catch(e){{}}for(var j=0;j<all.length;j++){{if(all[j].shadowRoot)out.push(all[j].shadowRoot)}}}}return out}}
function vis(el){{try{{var r=el.getBoundingClientRect(),w=(el.ownerDocument&&el.ownerDocument.defaultView)||window,cs=w.getComputedStyle(el);return r.width>1&&r.height>1&&cs.visibility!=='hidden'&&cs.display!=='none'&&Number(cs.opacity||1)>0.01}}catch(e){{return false}}}}
var rs=roots();for(var i=0;i<rs.length;i++){{try{{var el=rs[i].querySelector(s);if(el&&vis(el))return 'found'}}catch(e){{}}}}
return 'no|'+(document.readyState||'')+'|'+(location.href||'')}})()"#
                );
                let mut last = String::new();
                loop {
                    if let Ok(v) = tab.evaluate(&probe, false) {
                        let got = v.value.and_then(|x| x.as_str().map(String::from)).unwrap_or_default();
                        if got == "found" {
                            return Ok(None);
                        }
                        last = got;
                    }
                    if started.elapsed() >= Duration::from_millis(deadline_ms) {
                        let mut parts = last.splitn(3, '|');
                        let _ = parts.next();
                        let ready = parts.next().unwrap_or("").to_string();
                        let url = parts.next().unwrap_or("").to_string();
                        return Err(format!(
                            "[失败] 等待「{sel}」超时：实际等了 {} ms 仍没有**可见**的匹配元素（readyState={ready}，url={url}）。这是时序或渲染问题，不是选择器写错——先用 nodes 看它到底渲染出来没有，再决定是加长 ms 还是换定位方式。",
                            started.elapsed().as_millis()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(120));
                }
            }
            None => {
                let d = ms.unwrap_or(1500).clamp(100, 15000);
                std::thread::sleep(Duration::from_millis(d));
            }
        }
        Ok(None)
    })
    .await
}

/// 自动化用哪个浏览器 + 要加载哪些扩展。
///
/// 做成命令而不是只认环境变量：面向用户的能力要能在界面里选，改一个开关不该等于
/// 改代码重新发版。`browser` 传 "" 表示自动选。返回本机实际装了哪些，界面据此列选项
/// ——不然用户只能对着一个下拉框猜哪个真的能用。
#[tauri::command]
pub fn browser_set_preference(
    browser: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    crate::capture::set_browser_pref(browser);
    if let Some(dirs) = extensions {
        set_extension_dirs(dirs);
    }
    Ok(browser_state_json())
}

/// 只读当前状态。和 setter 分开，因为 setter 传空就是「自动选」——拿它来读会把用户
/// 刚选的浏览器清掉，而这种 bug 只在「打开面板看一眼再关掉」时才出现，最难查。
#[tauri::command]
pub fn browser_get_preference() -> Result<serde_json::Value, String> {
    Ok(browser_state_json())
}

fn browser_state_json() -> serde_json::Value {
    let installed: Vec<serde_json::Value> = crate::capture::installed_browsers()
        .iter()
        .map(|(k, path)| serde_json::json!({ "id": k.id, "label": k.label, "path": path }))
        .collect();
    serde_json::json!({
        "installed": installed,
        "active": crate::capture::browser_pref(),
        "extensions": extension_dirs(),
        // Chrome 从 137 起彻底不理 --load-extension（实测 151 连坏 manifest 都不报错）。
        // 界面据此告诉用户「选了 Chrome 的话扩展这栏是白填的」，而不是让他自己撞。
        "extensionsWorkOn": ["edge", "brave", "chromium"],
    })
}

/// Toggle the visible Set-of-Mark number badges. The frontend turns them OFF
/// while recording a user-facing demo (clean frames) and back ON after.
#[tauri::command]
pub fn browser_set_marks(on: bool) {
    DRAW_MARKS.store(on, Ordering::Relaxed);
}

/// Return ALL cookies (including HttpOnly) for the current page via CDP.
#[tauri::command]
pub async fn browser_cookies(domain: Option<String>) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        let all = tab
            .get_cookies()
            .map_err(|e| format!("获取 cookies 失败: {e}"))?;
        let result = serde_json::to_string_pretty(&all).unwrap_or_else(|_| "[]".into());
        if let Some(ref d) = domain {
            let filtered: Vec<serde_json::Value> =
                serde_json::from_str::<Vec<serde_json::Value>>(&result)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| {
                        c.get("domain")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .contains(d.as_str())
                    })
                    .collect();
            Ok(Some(
                serde_json::to_string_pretty(&filtered).unwrap_or_else(|_| "[]".into()),
            ))
        } else {
            Ok(Some(result))
        }
    })
    .await
}

/// Read localStorage / sessionStorage from the current page.
#[tauri::command]
pub async fn browser_storage(storage_type: Option<String>) -> Result<BrowserState, String> {
    with_tab(move |tab| {
        let st = storage_type.as_deref().unwrap_or("local");
        let obj = if st == "session" {
            "sessionStorage"
        } else {
            "localStorage"
        };
        let js = format!(
            r#"(() => {{
            try {{
                const s = {obj};
                const out = {{}};
                for (let i = 0; i < s.length; i++) {{
                    const k = s.key(i);
                    out[k] = s.getItem(k);
                }}
                return JSON.stringify(out);
            }} catch(e) {{ return JSON.stringify({{ error: e.message }}); }}
        }})()"#
        );
        let ro = tab.evaluate(&js, false).map_err(|e| e.to_string())?;
        let s = ro
            .value
            .and_then(|v| v.as_str().map(|x| x.to_string()))
            .unwrap_or_else(|| "{}".into());
        Ok(Some(s))
    })
    .await
}

/// Close the browser and free the session.
/// 用户**自己那个**浏览器里现在开着什么。
///
/// 为什么需要它：CDP 接管不了一个没带调试端口启动的浏览器（端口是启动期参数，进程跑起来
/// 加不上）——这条已经查证过两次，绕不过去。但用户问的不是"接管"，是
/// 「我自己开着浏览器，你也不判断内容，也不判断要用哪个」。**看一眼**和**接管**是两件事，
/// 而看一眼在 macOS 上根本不需要 CDP：Chrome 的 AppleScript 字典直接给标签页、标题和 URL。
///
/// 实测（2026-08-19，Chrome 151，用户日常那个从 Dock 起的实例）：
///   · 窗口数 / 标签页 / 标题 / URL / 哪个是当前标签 —— **开箱可读，不需要任何设置**
///   · 页面正文（execute javascript）—— 被 Chrome 挡着，要用户在
///     「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」里打开一次
/// 所以这里只做能稳定拿到的那部分，并在读不到正文时**说清楚那一步怎么开**，
/// 而不是假装拿不到就是没有。
///
/// 拿不到就返回空列表，绝不阻断：这只是给模型多一份判断依据。
#[tauri::command]
pub async fn browser_user_tabs() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let mut browsers = Vec::new();
        for kind in crate::capture::BROWSER_KINDS {
            // 只问**正在跑**的，否则 AppleScript 会把没开的那个也启动起来——
            // 一个"看看你开着什么"的调用把浏览器开起来，比不看还糟。
            if !is_browser_running(kind.process_name) {
                continue;
            }
            let script = format!(
                r#"tell application "{}"
  set out to ""
  repeat with w from 1 to (count of windows)
    set aidx to 0
    try
      set aidx to active tab index of window w
    end try
    repeat with t from 1 to (count of tabs of window w)
      set act to "0"
      if t = aidx then set act to "1"
      set out to out & w & tab & t & tab & act & tab & (title of tab t of window w) & tab & (URL of tab t of window w) & linefeed
    end repeat
  end repeat
  return out
end tell"#,
                kind.process_name
            );
            let Ok(out) = std::process::Command::new("osascript")
                .args(["-e", &script])
                .output()
            else {
                continue;
            };
            if !out.status.success() {
                continue;
            }
            let mut tabs = Vec::new();
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let cols: Vec<&str> = line.split('\t').collect();
                if cols.len() < 5 {
                    continue;
                }
                // 「哪个是用户正在看的那一页」——同一个 AppleScript 里 active tab index
                // 一直读得到，却从来没读。少了它，一份十几个标签页的平铺清单里，
                // 模型没有任何依据挑出用户说的「这一页」，只能靠标题猜。
                // window 1 在 AppleScript 的顺序里就是该应用的最前窗口。
                tabs.push(serde_json::json!({
                    "window": cols[0].trim(),
                    "tab": cols[1].trim(),
                    "active": cols[2].trim() == "1",
                    "front_window": cols[0].trim() == "1",
                    "title": cols[3],
                    "url": cols[4],
                }));
            }
            if !tabs.is_empty() {
                browsers.push(serde_json::json!({ "browser": kind.label, "tabs": tabs }));
            }
        }
        return Ok(serde_json::json!({ "browsers": browsers }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux 没有等价的、开箱可用的进程外读法（UIA/AT-SPI 拿得到标题但拿不到 URL，
        // 而 URL 才是这件事的价值所在）。诚实返回空，别给一份半真的清单。
        Ok(serde_json::json!({ "browsers": [], "unsupported": true }))
    }
}

#[tauri::command]
pub async fn browser_close() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let session = take_browser_session();
        if let Some(session) = session {
            // Let an in-flight CDP call finish before tearing down its Browser.
            // The state has already been cleared, so new close/reload calls do
            // not wait for Chrome's process tree to exit.
            let _operation = BROWSER_OPERATION
                .lock()
                .map_err(|_| "browser operation state poisoned")?;
            drop(session);
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/// Synchronous close — called from cleanup_stale on webview reload / app exit.
/// 退出 App 时**同步**收掉浏览器。
///
/// `close_all` 把 drop 丢进后台线程，为的是不让 Chrome 的进程树拖住 Tauri 的事件线程——
/// 那对 cleanup_stale（重载）是对的。退出时不行：进程马上就没了，那个后台线程根本来不及跑，
/// Chrome 于是成了孤儿留在机器上。终端、LSP、调试适配器、代理、MCP、自动化服务在退出那条
/// 分支里全都收了，唯独浏览器没有——而它是这堆里最重的一个。
///
/// 所以在当前线程上 drop，并给操作锁一个上限：一次卡住的 CDP 调用不该把「退出」变成
/// 退不出去。等不到就照样 drop——留一个跑着的 Chrome，比让用户按了退出没反应要好。
pub fn close_all_blocking(wait: std::time::Duration) {
    let Some(session) = take_browser_session() else {
        return;
    };
    let deadline = std::time::Instant::now() + wait;
    loop {
        match BROWSER_OPERATION.try_lock() {
            // 拿到锁：在锁的保护下 drop，让在途的 CDP 调用先收尾。
            Ok(_operation) => {
                drop(session);
                return;
            }
            // 锁中毒说明持有者 panic 过，等下去没有意义。
            Err(std::sync::TryLockError::Poisoned(_)) => {
                drop(session);
                return;
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    drop(session);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}

pub fn close_all() {
    let session = take_browser_session();
    if let Some(session) = session {
        // Dropping a headless Chrome session can wait for its process tree.
        // cleanup_stale calls this from the Tauri event thread, so take state
        // synchronously then wait for any current CDP operation in the background.
        std::thread::spawn(move || {
            let _operation = BROWSER_OPERATION.lock();
            drop(session);
        });
    }
}

/// 认「这个浏览器进程是我们造的」的判据：命令行里出现我们自己造的 profile 目录。
///
/// 每一条都独特到不可能撞上用户自己的浏览器——他的 profile 在
/// `~/Library/Application Support/Google/Chrome`（macOS）/ `%LOCALAPPDATA%\Google\Chrome`
/// （Windows）下，不含这里任何一个词。杀进程的判据宁可漏，不可错。
const ORPHAN_PROFILE_PATTERN: &str = concat!(
    "rust-headless-chrome-profile",          // headless_chrome 老版本的临时名
    "|michael-ide-browser",                  // browser.rs 的兜底临时 profile
    // 两处都不能写死：**分隔符**在 Windows 命令行里是反斜杠（`C:\Users\x\.mrdayone\browser-profile`），
    // **目录名**在老用户那儿是 legacy 的 `.michael-ide`（app_dir_name() 会返回它）。
    // 匹配不上的后果有三个，而且都是「响亮地说假话」：孤儿浏览器杀不掉（下次启动
    // SingletonLock 全线冲突）；is_browser_running 剔不掉自己的实例，用户一个浏览器
    // 都没开却被告知「你确实开着 Chrome」；discover 会优先去接管自己的孤儿。
    // 注意 legacy 名让**老 macOS 用户今天也已经中招**，不只是 Windows。
    "|\\.(mrdayone|michael-ide)[/\\\\]browser-profile", // 持久 profile（主力，含 -edge/-brave/-chromium）
    "|rust_automation_browser_",             // automation-framework 的临时 profile
    "|\\.mrday-browser-session",              // automation-framework 的持久 profile
);

/// Kill orphaned Chrome processes from previous IDE sessions.
/// headless_chrome spawns a process tree (main + GPU + renderer + utility); if the IDE
/// crashes or the webview reloads without dropping the Session, the children become
/// permanent zombies. We sweep for any Chrome whose profile dir matches our temp/persistent
/// patterns and was NOT launched by the current process.
pub fn kill_orphaned_browsers() {
    std::thread::spawn(|| {
        #[cfg(not(windows))]
        {
            let my_pid = std::process::id().to_string();
            // 匹配模式必须覆盖**我们实际会造出来的每一种** profile 目录，否则清理是空转。
            //
            // 原来只有两条：`rust-headless-chrome-profile`（headless_chrome 老版本的临时名，
            // 现在这条路径压根不产生它）和 `michael-ide-browser`（只对得上 browser.rs:570
            // 那个兜底临时 profile）。真正天天在用的三种一条都没覆盖：
            //   · ~/.mrdayone/browser-profile[-edge|-brave|-chromium]  ← 持久 profile，主力
            //   · <tmp>/rust_automation_browser_<pid>                 ← automation-framework
            //   · ~/.mrday-browser-session                            ← automation-framework 持久
            // 于是孤儿从来没被清掉过。实测这台机器上挂着两个，分别跑了 1 天和 5 天——
            // 每一个都是 Dock 里一个多出来的图标，也是用户说"老是弹自己那个浏览器"的一部分。
            //
            // 每一条都带着足够独特的路径片段（.mrdayone/ 、rust_automation_browser_、
            // .mrday-browser-session），不可能撞上用户自己的 Chrome——他的 profile 在
            // ~/Library/Application Support/Google/Chrome 下，不含这里任何一个词。
            let out = match std::process::Command::new("pgrep")
                .args(["-f", ORPHAN_PROFILE_PATTERN])
                .output()
            {
                Ok(o) => o,
                Err(_) => return,
            };
            let pids: Vec<&str> = std::str::from_utf8(&out.stdout)
                .unwrap_or("")
                .lines()
                .filter(|p| !p.is_empty() && *p != my_pid)
                .collect();
            for pid in &pids {
                let _ = std::process::Command::new("kill")
                    .args(["-9", pid])
                    .output();
            }
            if !pids.is_empty() {
                crate::elog!(
                    "[browser] killed {} orphaned Chrome process(es)",
                    pids.len()
                );
            }
        }
        #[cfg(windows)]
        {
            // 判据必须是 **profile 目录**，不是窗口标题。
            //
            // 原来是 `taskkill /FI "WINDOWTITLE eq rust-headless*"`，两处都不成立：
            //  · 我们起的实例窗口标题是页面标题，不叫 rust-headless；
            //  · headless 实例根本没有窗口，而 taskkill 的 WINDOWTITLE 过滤器
            //    对无窗口进程永远不匹配。
            // 于是这段清理是**恒空转**的：孤儿一个都没杀过，它们继续占着 profile
            // 目录，下一次启动全线失败——而日志里看不出任何异常。
            //
            // 换成和非 Windows 那支同一条判据（ORPHAN_PROFILE_PATTERN 匹配完整命令行），
            // 先用 CIM 找出 pid，再按 pid 杀。同时改走 process_util::command：
            // 直接 std::process::Command 起 taskkill 会在 Windows 上闪一个黑窗，
            // 仓库里专门写了静默 spawn 助手就是为了这个。
            let my_pid = std::process::id();
            let out = match crate::process_util::command("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe' or Name='chromium.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
                ])
                .output()
            {
                Ok(o) => o,
                Err(_) => return,
            };
            let Ok(re) = regex::Regex::new(ORPHAN_PROFILE_PATTERN) else {
                return;
            };
            let mut killed = 0usize;
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let line = line.trim();
                let Some((pid_str, args)) = line.split_once(' ') else { continue };
                let Ok(pid) = pid_str.parse::<u32>() else { continue };
                if pid == my_pid || !re.is_match(args) {
                    continue;
                }
                // /T 连子进程一起收：Chromium 的渲染/GPU 进程是主进程的子进程，
                // 只杀主进程会留下一地孤儿孙子。
                let _ = crate::process_util::command("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
                killed += 1;
            }
            if killed > 0 {
                crate::elog!("[browser] killed {} orphaned browser process(es)", killed);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反漂移：Windows 侧的两处「浏览器还在不在」都必须真的去查，不能是桩，
    /// 也不能用窗口标题当判据。
    ///
    /// 断言源码而不是行为——Windows 分支在 mac 上不参与编译，跑不起来。
    /// 先剥注释：上面那几段解释里就引用了被修掉的旧写法，不剥的话断言会被自己喂饱。
    #[test]
    fn windows_browser_liveness_is_queried_not_assumed() {
        let src: String = include_str!("browser.rs")
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///")
            })
            .collect::<Vec<_>>()
            .join("\n");

        // ① 孤儿清理的判据是 profile 目录（和非 Windows 那支同一条），不是窗口标题。
        let title_filter = format!("WINDOWTITLE {} rust-headless", "eq");
        assert!(
            !src.contains(&title_filter),
            "Windows 孤儿清理还在按窗口标题过滤——headless 实例没有窗口，这条永远不匹配"
        );
        assert!(
            src.contains("taskkill") && src.contains("/PID"),
            "孤儿清理应该按 CIM 查出来的 pid 杀，而不是按镜像名整片杀"
        );

        // ② is_browser_running 在 Windows 上不再是恒 false 的桩。
        let stub = format!("fn is_browser_running(_process_name: &str) -> bool {{\n    {}\n}}", "false");
        assert_eq!(
            src.matches(&stub).count(),
            1,
            "恒 false 的桩应该只剩「既不是 macOS 也不是 Windows」那一份"
        );
        assert!(
            src.contains("#[cfg(windows)]\nfn is_browser_running(process_name: &str)"),
            "Windows 上 is_browser_running 应该是真实现（实名参数），不是下划线桩"
        );

        // ③ 两处都要走静默 spawn 助手，否则 Windows 上每次清理闪一个黑窗。
        assert!(
            !src.contains("std::process::Command::new(\"taskkill\")"),
            "taskkill 绕过了仓库的静默 spawn 助手，会在 Windows 上闪黑窗"
        );
    }

    // 一篇长文，用来喂「正文足够长 → 弱信号不算数」那条规则。
    const ARTICLE: &str = "x的正文很长，足够长到不像一张过渡页。这一段会被重复很多遍以越过阈值。";

    fn long_body() -> String {
        ARTICLE.repeat(40)
    }

    #[test]
    fn 挡在验证墙上要认出来_不管它带不带控件() {
        // 只用来提供挑战的端点：单凭 URL 就该判定，正文再长也一样。
        assert!(detect_wall_static("Google", "https://www.google.com/sorry/index?continue=x", "").is_some());
        assert!(detect_wall_static("", "https://例子.com/cdn-cgi/challenge-platform/h/b/x", "").is_some());
        // 正常页面不会顶着这些标题。
        assert!(detect_wall_static("Just a moment...", "https://例子.com/a", "").is_some());
        assert!(detect_wall_static("Attention Required! | Cloudflare", "https://例子.com/a", "").is_some());
    }

    #[test]
    fn 一篇讲验证码的文章不能被当成验证墙() {
        // 这是这个函数最容易犯、代价也最高的错：误判会让用户跑去一个根本没有验证的页面
        // 上「点一下」。所以凡是正常内容里也会出现的词，都必须再满足「页面几乎没正文」。
        let body = long_body();
        assert_eq!(detect_wall_static("reCAPTCHA 是怎么工作的", "https://blog.example.com/how-captcha-works", &body), None);
        assert_eq!(detect_wall_static("如何应对 access denied 报错", "https://example.com/faq", &body), None);
        assert_eq!(detect_wall_static("聊聊 unusual traffic 告警", "https://example.com/ops", &body), None);
        // 普通页面完全不该触发。
        assert_eq!(detect_wall_static("首页", "https://example.com/", &body), None);
    }

    #[test]
    fn 弱信号加上几乎空白的正文_才算撞墙() {
        // 过渡页的共同点是「没有内容」——弱信号只在这种页面上才不再有歧义。
        assert!(detect_wall_static("", "https://example.com/captcha", "请完成验证").is_some());
        assert!(detect_wall_static(
            "",
            "https://example.com/x",
            "Our systems have detected unusual traffic from your computer network."
        )
        .is_some());
        // 同样的词，配上真实正文，就只是词而已。
        assert_eq!(
            detect_wall_static("", "https://example.com/x", &format!("unusual traffic {}", long_body())),
            None
        );
    }

    #[test]
    fn 每个浏览器一份独立配置_chrome_保留原路径() {
        // 共用一个目录会把 profile 写坏（Chrome 和 Edge 的格式不互通），
        // 而给 chrome 也加后缀则会让已经登录过的人平白丢一次登录态。
        // 调试端口要从**进程自己**读，不能只认约定的 9222-9229。
        //
        // `--remote-debugging-port=0` 是"系统随便挑一个"，很多工具的默认做法——真实端口写在
        // user-data-dir 下的 DevToolsActivePort 第一行。不读它，这类实例就等于不存在，
        // 「先试着接管已开的浏览器」这一步在真实场景里必然空转，直接掉进"新开一个"。
        // 实测这台机器上两个实例正是这样，端口落在 63180 和 53130。
        {
            assert_eq!(
                debug_port_from_args("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222"),
                Some(9222),
            );
            // 没有这个参数 = 接管不了，必须是 None 而不是猜一个默认值
            assert_eq!(
                debug_port_from_args("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                None,
                "用户日常那个浏览器没带端口，不能凭空当成能接管",
            );
            // port=0 且拿不到 user-data-dir → 只能是 None，不许瞎猜
            assert_eq!(debug_port_from_args("chrome --remote-debugging-port=0"), None);
            // port=0 + DevToolsActivePort：真实端口读得出来
            let dir = std::env::temp_dir().join(format!("mrday-devtools-probe-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("DevToolsActivePort"), "63180\n/devtools/browser/abc\n");
            let d = dir.display();
            // 两种写法都要认：实测 automation-framework 那条命令行里是**不带 -- 的** user-data-dir=
            assert_eq!(
                debug_port_from_args(&format!("chrome --remote-debugging-port=0 --user-data-dir={d}")),
                Some(63180),
            );
            assert_eq!(
                debug_port_from_args(&format!("chrome --remote-debugging-port=0 user-data-dir={d}")),
                Some(63180),
                "实测的命令行里没有前导 --，只认带 -- 的写法就等于认不出来",
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        // 空闲超时必须被显式配置。不配就是 headless_chrome 的默认 30 秒，而 30 秒是
        // 「模型点一下浏览器、转头去读代码、回来再点」的常态间隔——连接死掉、进程被杀、
        // 窗口重开、当前页面丢失，用户看到的就是"它老是自己弹一个新的调试浏览器"。
        // 这条钉源码：这个调用埋在一个上千行的函数里，抽不出来单测。
        {
            const SRC: &str = include_str!("browser.rs");
            // 需要的串拼出来找：include_str! 读的是整个文件、包含本测试模块自己，
            // 写成字面量的话断言会匹配到自己，永远绿。
            let needle = format!(".{}(", "idle_browser_timeout");
            assert!(
                SRC.contains(&needle),
                "LaunchOptions 没有配 idle_browser_timeout —— 会退回默认 30 秒，浏览器会被反复杀掉重开",
            );
            // **每一处** LaunchOptions 都要配，不是有一处就算数。
            //
            // 这条断言原来只查「文件里出现过一次」，于是回退路径（profile 被残留进程锁住时
            // 走的那条）漏配了它整整一直没被发现：那条路吃默认 30 秒，起了窗口就断，
            // 断了杀进程、杀完留下锁、下次又落回退路径——自我循环，用户看到的是
            // 「打开窗口卡在那里，过一会开新的，就是不操作」。
            // 同上：拼出来找，别写成字面量——否则会匹配到本测试自己，把 2 处数成 3 处。
            let builder_needle = format!("{}::default()", "LaunchOptionsBuilder");
            let builders = SRC.matches(&builder_needle).count();
            let configured = SRC.matches(&needle).count();
            assert!(
                configured >= builders,
                "有 {builders} 处 LaunchOptions，只有 {configured} 处配了空闲超时——漏配的那条会退回默认 30 秒",
            );
            // 而且每一处都必须明显长于一次动作间隔。30 秒那一档等于没配。
            for (at, _m) in SRC.match_indices(&needle) {
                let call = &SRC[at..(at + 120).min(SRC.len())];
                assert!(
                    call.contains("60") || call.contains("min"),
                    "位置 {at} 处的空闲超时看起来还是秒级；这道门要的是分钟级：{call}",
                );
            }
        }

        // 孤儿清理的判据要覆盖**每一种**我们会造出来的 profile 目录，
        // 又绝不能匹配用户自己的浏览器——这是个 kill -9 的判据，错一次就是杀掉用户的窗口。
        {
            let pat = ORPHAN_PROFILE_PATTERN;
            let re = regex::Regex::new(pat).expect("孤儿判据不是合法正则");
            // 我们自己造的，每一种都必须认得
            for ours in [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.mrdayone/browser-profile",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.mrdayone/browser-profile-edge",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/T/rust_automation_browser_2811",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.mrday-browser-session",
                "/tmp/michael-ide-browser-123",
                "/tmp/rust-headless-chrome-profile-abc",
            ] {
                assert!(re.is_match(ours), "认不出自己造的 profile：{ours}");
            }
            // 用户自己的，一个都不许匹配
            for theirs in [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/Library/Application Support/Google/Chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default",
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            ] {
                assert!(!re.is_match(theirs), "会误杀用户自己的浏览器：{theirs}");
            }
        }
        assert_eq!(profile_dir_name("chrome"), "browser-profile");
        assert_eq!(profile_dir_name("edge"), "browser-profile-edge");
        assert_eq!(profile_dir_name("brave"), "browser-profile-brave");
        let all: Vec<String> = ["chrome", "edge", "brave", "chromium"]
            .iter()
            .map(|k| profile_dir_name(k))
            .collect();
        let uniq: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(uniq.len(), all.len(), "两个浏览器指向了同一个配置目录");
    }

    /// 「我自己开着浏览器，你也不判断内容，也不判断要用哪个」。
    ///
    /// 看一眼和接管是两件事。接管确实做不到（调试端口是启动期参数），但**看一眼**在 macOS 上
    /// 根本不需要 CDP——Chrome 的 AppleScript 字典直接给标签页、标题和 URL，实测开箱可读。
    /// 这条钉住这个能力真的接出去了，别又变成"写好了、零调用点"。
    #[test]
    fn 读用户自己浏览器这条命令要真的接进命令表() {
        const SRC: &str = include_str!("browser.rs");
        const LIB: &str = include_str!("lib.rs");
        // 需要的串拼出来找：include_str! 读的是整个文件、包含本测试模块自己。
        let cmd = format!("pub async fn {}(", "browser_user_tabs");
        assert!(SRC.contains(&cmd), "命令没了");
        let reg = format!("browser::{},", "browser_user_tabs");
        assert!(
            LIB.contains(&reg),
            "命令没注册进 invoke_handler —— 前端调它只会拿到 'command not found'"
        );
        // 只问**正在跑**的浏览器：AppleScript 对一个没开的应用发指令会把它**启动起来**，
        // 一个"看看你开着什么"的调用反而开出一个浏览器，比不看还糟。
        let guard = format!("if !{}(kind.process_name)", "is_browser_running");
        assert!(
            SRC.contains(&guard),
            "少了「只问正在跑的」这道判据 —— 会把没开的浏览器启动起来",
        );
        // 拿不到就返回空，绝不阻断：这只是给模型多一份判断依据，不是必需品。
        assert!(
            SRC.contains("\"unsupported\": true"),
            "非 macOS 要诚实返回空 + 标记，不能假装拿到了",
        );
    }

    /// 「做错一步，浏览器就被关掉重开」——判死判得太宽。
    ///
    /// 这个函数返回 true 的后果是把整个浏览器杀掉重开：当前页、滚动位置、填了一半的表单
    /// 全没，Dock 里再多一个新窗口。所以它只该认**传输层真的断了**，不能认页面层的错误。
    #[test]
    fn 页面层的错误不许被判成浏览器死了() {
        // 日常操作里再普通不过的错误，重试一下就好，绝不该导致重开浏览器
        for page_level in [
            "Node is no longer attached to the DOM",
            "element is no longer attached to the document",
            "Could not find node with given id",
            "Cannot find context with specified id",
            "Execution context was destroyed, most likely because of a navigation",
            // 页面自己的报错顺着 eval 冒上来——以前裸的 "websocket" / "channel" 会全部命中
            "Uncaught Error: WebSocket handshake failed on /api/channel/42",
            "TypeError: channel is undefined",
            // "no longer" 的其它说法：排除清单里没有它们，靠的是把裸匹配收成
            // "no longer connected"。少了这几条，裸匹配放回去测试也不会红。
            "the element is no longer visible",
            "target frame no longer exists",
            "this handle is no longer valid",
            "navigation to https://example.com/channel/live timed out",
        ] {
            assert!(!is_dead_browser(page_level), "页面层错误被判成浏览器死了：{page_level}");
        }
        // 真的断了还得认得出来，别把闸收过头
        for really_dead in [
            "The underlying connection is closed",
            "connection closed before message could be sent",
            "WebSocket connection closed unexpectedly",
            "channel closed",
            "the browser is no longer connected",
            "Not connected to the browser",
            "session with given id not found",
            "Target closed",
            "browser process exited",
        ] {
            assert!(is_dead_browser(really_dead), "真的掉线没被认出来：{really_dead}");
        }
    }
    #[test]
    fn 接管到谁就说谁_认不出来也不许默认说成_chrome() {
        assert_eq!(brand_from_version(Some("Edg/126.0.2592.87")), "Microsoft Edge");
        assert_eq!(brand_from_version(Some("Chrome/151.0.7922.138")), "Google Chrome");
        assert_eq!(brand_from_version(Some("HeadlessChrome/151.0")), "Google Chrome");
        assert_eq!(brand_from_version(Some("Brave/1.68")), "Brave");
        // 这条是重点：说错牌子比不说更糟——它是用户唯一能核对「接管的是不是我那个
        // 窗口」的信息。
        assert_eq!(brand_from_version(None), "浏览器");
        assert_eq!(brand_from_version(Some("")), "浏览器");
    }

    #[test]
    fn 摘默认参数只摘该摘的两个_绝不摘自动化标志() {
        // `--enable-automation` 和 `--disable-extensions` 同在这个库的默认参数里。
        // 摘掉前者就是隐藏自动化身份，也就是反检测——这个产品不做，这条钉死它。
        let src = include_str!("browser.rs");
        assert!(
            src.contains("OsStr::new(\"--disable-extensions\")"),
            "扩展要生效必须摘掉 --disable-extensions"
        );
        assert!(
            !src.contains("OsStr::new(\"--enable-automation\")"),
            "不许把 --enable-automation 摘掉：那是反检测"
        );
    }

    #[test]
    fn 命令行上只能有一条_disable_features() {
        // 以前两条一起传，靠「Chromium 对重复开关只认最后一次」让我们这条覆盖默认那条，
        // 于是默认那份的值被静默丢掉。现在默认那条被显式摘掉，我们这条必须把它的值
        // 并进来——否则这个"合并"是假的，只是把丢弃换了个写法。
        let src = include_str!("browser.rs");
        let ours = src
            .lines()
            .find(|l| l.contains("\"--disable-features=Translate,"))
            .expect("找不到我们那条 --disable-features");
        for inherited in ["TranslateUI", "BlinkGenPropertyTrees"] {
            assert!(ours.contains(inherited), "默认参数里的 {inherited} 没并进来");
        }
        assert!(
            src.contains("OsStr::new(\"--disable-features=TranslateUI,BlinkGenPropertyTrees\")"),
            "默认那条 --disable-features 必须被显式摘掉，不能靠拼接顺序覆盖"
        );
    }

    #[test]
    fn 会话说明只发一次_不是每个动作都重复() {
        // 「为什么 Dock 里多了一个 Chrome」只需要在浏览器起来的那一次说清楚。
        // 每个动作都带一遍的话，模型上下文会被同一段话反复占满。
        *SESSION_NOTE.lock().unwrap() = None;
        set_session_note("另起了一个自动化浏览器".into());
        let first = SESSION_NOTE.lock().unwrap().take();
        assert_eq!(first.as_deref(), Some("另起了一个自动化浏览器"));
        let second = SESSION_NOTE.lock().unwrap().take();
        assert_eq!(second, None, "同一条说明不该被重复投递");
    }

    #[test]
    fn viewport_validation_applies_defaults_and_preserves_mobile() {
        assert_eq!(
            validate_viewport(390, 844, None, Some(true)).unwrap(),
            (390, 844, 1.0, true)
        );
        assert_eq!(
            validate_viewport(1440, 900, Some(2.0), None).unwrap(),
            (1440, 900, 2.0, false)
        );
    }

    #[test]
    fn viewport_validation_rejects_unsafe_metrics() {
        assert!(validate_viewport(0, 900, None, None).is_err());
        assert!(validate_viewport(390, 9000, None, None).is_err());
        assert!(validate_viewport(390, 844, Some(f64::NAN), None).is_err());
        assert!(validate_viewport(390, 844, Some(4.1), None).is_err());
        assert!(validate_viewport(7680, 7680, Some(4.0), None).is_err());
    }

    #[test]
    fn page_observer_is_bounded_and_does_not_capture_payloads() {
        assert!(PAGE_OBSERVER_SCRIPT.contains("MAX_EVENTS = 80"));
        assert!(PAGE_OBSERVER_SCRIPT.contains("__MERR__"));
        assert!(PAGE_OBSERVER_SCRIPT.contains("__MNET__"));
        assert!(!PAGE_OBSERVER_SCRIPT.contains("reqHeaders"));
        assert!(!PAGE_OBSERVER_SCRIPT.contains("reqBody"));
        assert!(!PAGE_OBSERVER_SCRIPT.contains("responseText"));
        assert!(!PAGE_OBSERVER_SCRIPT.contains("setRequestHeader"));
    }

    #[test]
    fn eval_result_does_not_double_encode_json_strings() {
        let json = r#"{"healthy":true,"errors":[]}"#;
        assert_eq!(
            stringify_eval_result(Some(serde_json::Value::String(json.into())), None),
            json
        );
        assert_eq!(
            stringify_eval_result(Some(serde_json::json!({"healthy": true})), None),
            r#"{"healthy":true}"#
        );
    }

    #[test]
    fn navigation_wait_timeout_is_recoverable() {
        assert!(is_navigation_wait_timeout(
            "The event waited for never came"
        ));
        assert!(is_navigation_wait_timeout(
            "navigation timeout after 30000 ms"
        ));
        assert!(!is_navigation_wait_timeout("DNS resolution failed"));
    }

    #[test]
    fn navigation_url_preserves_preview_targets_and_normalizes_paths() {
        assert_eq!(
            normalize_navigation_url(" file:///tmp/site/index.html "),
            "file:///tmp/site/index.html"
        );
        assert_eq!(
            normalize_navigation_url("/tmp/site/index.html"),
            "file:///tmp/site/index.html"
        );
        assert_eq!(
            normalize_navigation_url(r"C:\site\index.html"),
            "file:///C:/site/index.html"
        );
        assert_eq!(
            normalize_navigation_url("data:text/html,<h1>Preview</h1>"),
            "data:text/html,<h1>Preview</h1>"
        );
        assert_eq!(
            normalize_navigation_url("localhost:5174"),
            "https://localhost:5174"
        );
    }

    #[test]
    fn cdp_metric_delta_rejects_missing_and_regressing_counters() {
        let before =
            std::collections::HashMap::from([("Timestamp", 100.0), ("TaskDuration", 42.0)]);
        let after =
            std::collections::HashMap::from([("Timestamp", 100.75), ("TaskDuration", 42.15)]);
        assert!(
            (non_negative_delta(&before, &after, "Timestamp").unwrap() - 0.75).abs() < f64::EPSILON
        );
        assert!((non_negative_delta(&before, &after, "TaskDuration").unwrap() - 0.15).abs() < 1e-9);
        assert_eq!(non_negative_delta(&before, &after, "LayoutDuration"), None);

        let regressed = std::collections::HashMap::from([("TaskDuration", 41.9)]);
        assert_eq!(
            non_negative_delta(&before, &regressed, "TaskDuration"),
            None
        );
    }

    #[test]
    fn 点击输入走人类化cdp路径_合成事件只做兜底() {
        // 点击/输入的**主路径**必须是 CDP 人类化输入（trusted 事件 + 轨迹 + cadence），
        // 合成 JS 事件（el.click / native value-set）只在解析不到坐标或派发失败时兜底。
        // 钉源码：这些函数埋在 with_tab 闭包里、要真起浏览器才跑得动，抽不出来单测；
        // 拼串找，避免匹配到本测试自己。
        const SRC: &str = include_str!("browser.rs");
        // 人类化点击/输入的 CDP 入口存在且真的被 browser_click / browser_type 调用。
        for needle in [
            format!("fn {}(", "human_click"),
            format!("fn {}(", "human_type"),
            format!("fn {}(", "resolve_click_point"),
            format!("fn {}(", "focus_and_clear"),
        ] {
            assert!(SRC.contains(&needle), "缺少人类化输入函数: {needle}");
        }
        // 轨迹与节奏来自有单测的纯模块，不是就地瞎写的魔法数。
        assert!(
            SRC.contains(&format!("human_input::{}(", "ease_path")),
            "human_click 没有用 ease_path 画轨迹",
        );
        assert!(
            SRC.contains(&format!("human_input::{}(", "keystroke_delays")),
            "human_type 没有用 keystroke_delays 定节奏",
        );
        // 主路径在前、兜底在后：browser_click 里 resolve_click_point 必须出现在
        // 兜底的 click_via_eval 之前，否则「人类化优先」是空话。
        let click_body = &SRC[SRC.find("pub async fn browser_click").expect("browser_click 不见了")..];
        let click_body = &click_body[..click_body.find("pub async fn browser_type").unwrap_or(click_body.len())];
        let p_human = click_body.find("resolve_click_point").expect("browser_click 没走人类化解析");
        let p_fallback = click_body.find("click_via_eval").expect("browser_click 没有 eval 兜底");
        assert!(p_human < p_fallback, "人类化点击不是主路径——它排在 eval 兜底后面了");
    }

    #[test]
    fn close_invalidates_a_concurrent_browser_launch_generation() {
        let store = Arc::new(Mutex::new(BrowserStore::default()));
        let launch_generation = store.lock().unwrap().generation;
        let closer = Arc::clone(&store);

        std::thread::spawn(move || {
            closer.lock().unwrap().invalidate();
        })
        .join()
        .unwrap();

        assert!(!store.lock().unwrap().launch_is_current(launch_generation));
    }
}

#[cfg(test)]
mod tab_rows_tests {
    use super::tab_rows_json;

    #[test]
    fn 标签页回执_下标从零_当前那一个标出来() {
        let rows = vec![
            ("A".to_string(), "登录".to_string(), "https://x.io/login".to_string()),
            ("B".to_string(), "邮箱".to_string(), "https://mail.io/".to_string()),
        ];
        let v: serde_json::Value = serde_json::from_str(&tab_rows_json("switch", &rows, "B")).unwrap();
        assert_eq!(v["op"], "switch");
        assert_eq!(v["current"], 1);
        assert_eq!(v["count"], 2);
        assert_eq!(v["tabs"][0]["tab"], 0);
        assert_eq!(v["tabs"][0]["current"], false);
        assert_eq!(v["tabs"][1]["title"], "邮箱");
        assert_eq!(v["tabs"][1]["current"], true);
    }
}

#[cfg(test)]
mod tab_ops_real_chrome {
    //! `cargo test --lib -- --ignored tab_ops_real_chrome`：起一只临时 profile 的无头 Chrome，
    //! 装进全局会话，把 list / new / switch / close 走一遍。默认 ignored：CI 上没有 Chrome。
    use super::*;
    use headless_chrome::LaunchOptionsBuilder;

    fn install(browser: Browser, tab: Arc<Tab>) {
        let mut state = BROWSER.lock().unwrap();
        state.session = Some(Session { _browser: browser, tab });
    }

    fn parsed(state: &BrowserState) -> serde_json::Value {
        serde_json::from_str(state.result.as_deref().unwrap_or("{}")).unwrap()
    }

    #[test]
    #[ignore]
    fn 标签页_开_切_关_全走一遍() {
        let path = crate::capture::find_headless_browser().expect("本机没有 Chromium 系浏览器");
        let dir = std::env::temp_dir().join(format!("mrday-tab-test-{}", std::process::id()));
        let opts = LaunchOptionsBuilder::default()
            .path(Some(std::path::PathBuf::from(&path)))
            .headless(true)
            .sandbox(false)
            .user_data_dir(Some(dir.clone()))
            .window_size(Some((1280, 900)))
            .build()
            .unwrap();
        let browser = Browser::new(opts).expect("起不来无头 Chrome");
        let tab = browser.new_tab().unwrap();
        tab.navigate_to("about:blank").unwrap();
        install(browser, tab);

        let list = parsed(&tab_op("list", None, None).unwrap());
        assert_eq!(list["count"], 2, "headless_chrome 起来自带一个 about:blank，再加我们开的那个：{list}");
        let opened = parsed(&tab_op("new", None, Some("data:text/html,<title>second</title>hi")).unwrap());
        assert_eq!(opened["count"], 3);
        let cur = opened["current"].as_u64().unwrap() as usize;
        assert_eq!(opened["tabs"][cur]["title"], "second", "新开的要成为当前：{opened}");
        let back = parsed(&tab_op("switch", Some(1), None).unwrap());
        assert_eq!(back["current"], 1);
        let closed = parsed(&tab_op("close", Some(cur), None).unwrap());
        assert_eq!(closed["count"], 2, "{closed}");
        let err = tab_op("close", Some(99), None).err().expect("关不存在的标签页应当失败");
        assert!(err.contains("没有第 99 个"), "{err}");
        let err2 = tab_op("frob", None, None).err().expect("不认识的 op 应当失败");
        assert!(err2.contains("list / new / switch / close"), "{err2}");
        let _ = BROWSER.lock().unwrap().invalidate();
        let _ = std::fs::remove_dir_all(dir);
    }
}
