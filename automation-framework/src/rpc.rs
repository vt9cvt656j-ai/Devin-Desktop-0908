//! JSON-RPC 服务层 - 让 AI agent 可以通过 HTTP 调用自动化框架
//! 
//! 这个模块提供了一个简单的 HTTP 服务器，接收 JSON-RPC 格式的请求

use crate::agent::Agent;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub method: String,
    pub params: serde_json::Value,
    pub id: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    pub id: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// JSON-RPC 服务器
pub struct RpcServer {
    agent: Arc<Mutex<Agent>>,
    port: u16,
    /// 与父进程共享的一次性密钥（`MICHAEL_AUTOMATION_TOKEN`）。
    ///
    /// None 表示未配置：此时保持旧行为（方便单独跑 sidecar 调试），但浏览器来源的请求
    /// 依然一律拒绝。
    token: Option<String>,
}

/// 常量时间比较，避免用响应时间逐字节试出 token。
/// `/health` 挑战应答：SHA-256("<token>:<nonce>") 的十六进制。
///
/// 用意是让**持有 token 的一方证明自己持有它**，而调用方不必先把 token 交出去。
/// nonce 每次现生成，所以观察到一次应答也没法拿去冒充下一次。
pub fn health_challenge_response(token: &str, nonce: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(b":");
    hasher.update(nonce.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 合成按键只会投给**当前前台应用**，而前台随时可能被用户、对话框或另一个
/// 应用抢走。回执里不带这个，一次打进错误窗口和一次正常输入长得一模一样——
/// 调用方拿到的都是 {"status":"ok"}。
#[cfg(feature = "system")]
fn frontmost_now() -> Option<String> {
    crate::platform::get_window_controller()
        .enumerate_windows()
        .ok()?
        .into_iter()
        .find(|w| w.is_frontmost)
        .map(|w| w.title)
}

/// 注入型按键动作的回执：**动作前后各采一次前台**，两个都回出去。
///
/// 原来只在动作完成后采一次 delivered_to。可合成按键投给的是**投递那一刻**的前台：
/// 打一段长文本期间弹窗 / 通知把焦点抢走再还回来，前半截字进了别的窗口，事后采到的
/// 却还是目标窗口——回执和一次正常输入长得一模一样。CGEventPost 还是异步投递，
/// 单点事后采样连「事件已消化」都证明不了。前后两次给的是一个**可判定**的信号：
/// 两次不一致就一定有按键进了别处；一致至少说明起点和终点都是它。
#[cfg(feature = "system")]
fn focus_receipt(before: Option<String>, after: Option<String>) -> serde_json::Value {
    let mut v = serde_json::json!({
        "status": "ok",
        "focus_before": before,
        "delivered_to": after,
    });
    match (&before, &after) {
        (Some(b), Some(a)) if b == a => {
            v["focus_changed"] = serde_json::Value::Bool(false);
        }
        (Some(b), Some(a)) => {
            v["focus_changed"] = serde_json::Value::Bool(true);
            v["focus_changed_hint"] = serde_json::Value::String(format!(
                "输入开始时前台是「{b}」，结束时是「{a}」：至少有一部分按键进了另一个窗口。\
                 先 read_screen / screen.capture 看目标里实际收到了什么，再决定补发哪一段。"
            ));
        }
        // 读不到前台就是**不知道**，不能报成「没变」——那和报成功是同一种假话。
        _ => {
            v["focus_changed"] = serde_json::Value::Null;
            v["focus_changed_hint"] = serde_json::Value::String(
                "没读到前台窗口，无法判定按键是否进了目标；用 read_screen / screen.capture 验证后再继续。".into(),
            );
        }
    }
    v
}

/// 把一个注入动作夹在两次前台采样之间。采样器注入进来是为了能在没有窗口系统的
/// 环境里测「先采再动」这个顺序本身。
#[cfg(feature = "system")]
fn focus_bracketed_with(
    sample: impl Fn() -> Option<String>,
    act: impl FnOnce() -> Result<()>,
) -> Result<serde_json::Value> {
    let before = sample();
    act()?;
    Ok(focus_receipt(before, sample()))
}

/// 生产用法：动作持着 agent 锁跑，锁随闭包结束释放，后一次采样不持锁。
#[cfg(feature = "system")]
fn focus_bracketed(
    agent: std::sync::MutexGuard<'_, Agent>,
    act: impl FnOnce(&mut Agent) -> Result<()>,
) -> Result<serde_json::Value> {
    focus_bracketed_with(frontmost_now, move || {
        let mut agent = agent;
        act(&mut agent)
    })
}

/// 逐条回放一串 {method, params}。分发器注入进来，回放本身不关心方法是怎么执行的。
///
/// 一句描述**某个 profile 本身**的话。回执里凡是谈 cookie / 登录态的部分都从这里来，
/// 而参数只有 profile —— 也就是说它永远只可能描述真正在跑的那套身份。
#[cfg(feature = "browser")]
fn profile_note(profile: crate::browser::BrowserProfile) -> &'static str {
    match profile {
        crate::browser::BrowserProfile::Session =>
            "Persistent profile: cookies and logins from earlier runs are available, and anything you sign into here stays signed in. \
If a site still shows a login wall, call browser.close first and then browser.start with headless=false, so the user can sign in once.",
        crate::browser::BrowserProfile::Isolated =>
            "Clean isolated profile: no cookies, no logins. If the task needs the user's own account, call browser.close first and then browser.start with profile=session.",
    }
}

#[cfg(feature = "browser")]
fn profile_name(profile: crate::browser::BrowserProfile) -> &'static str {
    match profile {
        crate::browser::BrowserProfile::Session => "session",
        crate::browser::BrowserProfile::Isolated => "isolated",
    }
}

/// browser.start 的回执。**只看 outcome，不看请求参数**——除了在参数没生效时把它们
/// 原样回显，好让调用方看出自己要的和实际跑的不是一回事。
///
/// 之前 profile 字段和整段 note 都是由本次请求的 params 生成的：浏览器已经在跑时，
/// 一句 `if self.browser.is_some() { return Ok(()) }` 把参数全丢了，回执却照样按参数
/// 宣布「持久 profile、登录态可用」。模型据此往下走，必撞登录墙，而 note 给的补救
/// （headless=false 让用户登录）方向也是错的：登录进的是那只隔离实例的临时目录。
#[cfg(feature = "browser")]
fn browser_start_receipt(
    outcome: crate::agent::BrowserStartOutcome,
    requested: crate::browser::BrowserIdentity,
) -> serde_json::Value {
    use crate::agent::BrowserStartOutcome as O;
    let actual = match outcome {
        O::Started(id) | O::AlreadyRunning(id) | O::Restarted(id) => id,
    };
    let mut v = serde_json::json!({
        "status": "ok",
        "profile": profile_name(actual.profile),
        "headless": actual.headless,
    });
    let obj = v.as_object_mut().expect("json! 建的就是对象");
    let mut note = String::new();
    match outcome {
        O::Started(_) => {}
        O::Restarted(_) => {
            obj.insert("restarted".into(), serde_json::json!(true));
            note.push_str(
                "The browser that was running had stopped responding (it crashed, or its window was closed), \
so it was discarded and a fresh one was started with the settings you asked for. ",
            );
        }
        O::AlreadyRunning(_) => {
            obj.insert("already_running".into(), serde_json::json!(true));
            if actual == requested {
                note.push_str("A browser was already running with exactly these settings; this call changed nothing. ");
            } else {
                // 参数没生效——这是**唯一**该回显请求参数的地方，而且必须说清出路。
                obj.insert("requested_profile".into(), serde_json::json!(profile_name(requested.profile)));
                obj.insert("requested_headless".into(), serde_json::json!(requested.headless));
                note.push_str(&format!(
                    "A browser was already running and this call changed NOTHING: it is still profile={}, headless={}. \
browser.start cannot switch a running browser's identity. To get profile={}, headless={}, call browser.close first and then browser.start again. ",
                    profile_name(actual.profile), actual.headless,
                    profile_name(requested.profile), requested.headless,
                ));
            }
        }
    }
    note.push_str(profile_note(actual.profile));
    obj.insert("note".into(), serde_json::json!(note));
    v
}

/// browser.close 的回执。flushed 是这里唯一重要的事实。
///
/// 之前无论发生了什么都是 {"status":"ok"}：Browser.close 没被接受、或者进程 8 秒内没
/// 自己退出而被 Drop 强杀（cookie 没写进 profile），在调用方眼里和一次干净的关闭完全
/// 一样。持久 profile 下这正是「登录一次长期有效」失守的那一刻，而它要到下一次运行
/// 才会以「怎么又要登录」的形式冒出来。
#[cfg(feature = "browser")]
fn browser_close_receipt(outcome: crate::agent::BrowserCloseOutcome) -> serde_json::Value {
    use crate::agent::BrowserCloseOutcome as O;
    match outcome {
        O::NotRunning => serde_json::json!({ "status": "ok", "was_running": false }),
        O::Closed { identity, flushed } => {
            let mut v = serde_json::json!({
                "status": "ok",
                "was_running": true,
                "flushed": flushed,
            });
            let obj = v.as_object_mut().expect("json! 建的就是对象");
            if let Some(id) = identity {
                obj.insert("profile".into(), serde_json::json!(profile_name(id.profile)));
            }
            let persistent = matches!(
                identity.map(|id| id.profile),
                // 身份读不出来时按最坏情况说话：宁可让调用方多验一次，也不要漏报丢失。
                None | Some(crate::browser::BrowserProfile::Session)
            );
            let note = if flushed {
                if persistent {
                    "The browser exited on its own, so cookies and logins were written to disk. \
Whatever you signed into will still be signed in the next time you start with profile=session."
                } else {
                    "The browser exited cleanly. This was a throwaway isolated profile, so nothing was meant to persist."
                }
            } else if persistent {
                "The browser did NOT exit on its own and had to be killed, so cookies and logins from this run \
may never have reached disk. Do not assume a sign-in made during this run survived — check it on the next start."
            } else {
                "The browser did NOT exit on its own and had to be killed. This was a throwaway isolated profile, \
so nothing was lost."
            };
            obj.insert("note".into(), serde_json::json!(note));
            v
        }
    }
}

/// 第 N 步失败时前面的点击 / 输入已经落到桌面上了。原来这里一个 `?` 把底层错误
/// （比如 "Missing 'x' parameter"）原样上抛，位置和已执行步数随之丢掉——调用方既不
/// 知道停在哪，也不知道整条重放会不会把已发生的副作用再来一遍。位置信息放最前面：
/// IDE 侧只保留错误文案的前 300 字，底层错误可以被截，位置不能。
fn replay_steps(
    steps: &[serde_json::Value],
    delay_ms: u64,
    mut dispatch: impl FnMut(&str, serde_json::Value) -> Result<serde_json::Value>,
) -> Result<serde_json::Value> {
    let total = steps.len();
    let mut done = 0u64;
    for (i, step) in steps.iter().enumerate() {
        let m = step.get("method").and_then(|v| v.as_str()).unwrap_or("");
        if m.is_empty() { continue; }
        let p = step.get("params").cloned().unwrap_or_else(|| serde_json::json!({}));
        dispatch(m, p).map_err(|e| Error::Other(anyhow::anyhow!(
            "recorder.replay 在第 {}/{} 步（{}）失败；之前已执行 {} 步，它们的副作用已经发生。\
             续作从第 {} 步开始（steps[{}..]），逐条重发。底层错误：{}",
            i + 1, total, m, done, i + 1, i, e
        )))?;
        done += 1;
        if delay_ms > 0 { std::thread::sleep(Duration::from_millis(delay_ms)); }
    }
    Ok(serde_json::json!({ "status": "ok", "replayed": done }))
}

impl RpcServer {
    /// 创建新的 RPC 服务器
    pub fn new(port: u16) -> Result<Self> {
        let agent = Agent::new()?;

        Ok(Self {
            agent: Arc::new(Mutex::new(agent)),
            port,
            token: std::env::var("MICHAEL_AUTOMATION_TOKEN")
                .ok()
                .filter(|t| !t.trim().is_empty()),
        })
    }
    
    /// 处理 RPC 请求
    pub fn handle_request(&self, req: RpcRequest) -> RpcResponse {
        let result = self.execute_method(&req.method, req.params);
        
        match result {
            Ok(value) => RpcResponse {
                jsonrpc: "2.0".to_string(),
                result: Some(value),
                error: None,
                id: req.id,
            },
            Err(e) => RpcResponse {
                jsonrpc: "2.0".to_string(),
                result: None,
                error: Some(RpcError {
                    code: -32603,
                    message: e.to_string(),
                }),
                id: req.id,
            },
        }
    }
    
    /// 带了 {x,y} 就先把指针移过去再点。
    ///
    /// 之所以做成"有就用、没有就保持原样"，是因为 mouse.click 的老语义是"在当前位置点"，
    /// 有脚本依赖它；而两个工具 schema 又都对外声明可以带坐标。两边都认账。
    #[cfg(feature = "system")]
    /// 这次点击要按住哪些修饰键。keys / modifiers / with 三种写法都收——
    /// 模型是从工具目录里学写法的，认死一种等于逼它猜。
    #[cfg(feature = "system")]
    fn modifiers_of(params: &serde_json::Value) -> Vec<String> {
        for k in ["keys", "modifiers", "with"] {
            if let Some(v) = params.get(k) {
                if let Some(arr) = v.as_array() {
                    return arr.iter().filter_map(|x| x.as_str()).map(str::to_string).collect();
                }
                if let Some(s) = v.as_str() {
                    // "cmd+shift" / "cmd shift" / "cmd,shift" 都当成两个键
                    return s
                        .split(|c: char| c == '+' || c == ',' || c.is_whitespace())
                        .map(str::trim)
                        .filter(|x| !x.is_empty())
                        .map(str::to_string)
                        .collect();
                }
            }
        }
        Vec::new()
    }

    /// 连点 n 次，可带修饰键，可带落点。三个 click 方法共用。
    #[cfg(feature = "system")]
    fn click_n(
        agent: &mut crate::agent::Agent,
        params: &serde_json::Value,
        times: u32,
    ) -> Result<serde_json::Value> {
        Self::click_at_if_given(agent, params)?;
        let button = params.get("button").and_then(|v| v.as_str()).map(str::to_string);
        let mods = Self::modifiers_of(params);
        if mods.is_empty() {
            agent.mouse_click_times(button.as_deref(), times)?;
        } else {
            agent.with_modifiers(&mods, |a| a.mouse_click_times(button.as_deref(), times))?;
        }
        let mut out = Self::acted_at(agent);
        // 回执带上真的按了哪些修饰键：写错键名时静默降级成普通点击是最难查的一种。
        if !mods.is_empty() {
            out["modifiers"] = serde_json::json!(mods);
        }
        out["clicks"] = serde_json::json!(times);
        Ok(out)
    }

    fn click_at_if_given(
        agent: &mut crate::agent::Agent,
        params: &serde_json::Value,
    ) -> Result<()> {
        let x = Self::coord(params, "x");
        let y = Self::coord(params, "y");
        if let (Some(x), Some(y)) = (x, y) {
            agent.mouse_move(x as i32, y as i32)?;
        }
        Ok(())
    }

    /// 坐标解析。工具 schema 里坐标是 number，模型给 100.0 或 "100" 都合法，
    /// 而 as_i64() 对这两种都返回 None——于是坐标被当成"没传"，静默丢弃。
    #[cfg(feature = "system")]
    fn coord(params: &serde_json::Value, key: &str) -> Option<f64> {
        let v = params.get(key)?;
        v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
    }

    /// 回执带上动作后的真实落点。只回 {"status":"ok"} 的话，"坐标被忽略"这类 bug
    /// 在调用方眼里完全不可见——它正是这么潜伏下来的。
    #[cfg(feature = "system")]
    fn acted_at(agent: &mut crate::agent::Agent) -> serde_json::Value {
        match agent.mouse_location() {
            Ok((x, y)) => serde_json::json!({"status": "ok", "x": x, "y": y, "coordinate_space": "screen_points_top_left"}),
            Err(_) => serde_json::json!({"status": "ok"}),
        }
    }

    /// 屏幕相关的三个方法：不碰 agent，所以在拿锁之前就地处理掉。
    ///
    /// **先把上一版注释的错更正掉。** 那一版写着「一次挂住的 browser.* 整场握着这把锁，
    /// 把 screen.* 堵在门外，分流之后这两条就不再受浏览器影响」——**这句话是假的**，
    /// 而且它假得很危险：下一个人会照它把浏览器排除掉，去别处找卡死的原因。
    ///
    /// 真相是这个服务**根本没有并发**：`serve_http_blocking` 是
    /// `for stream in listener.incoming() { handle_conn(&s) }`，单线程、一次一条连接，
    /// 整个 crate 一个 `thread::spawn` 都没有（Agent 带 macOS !Send 句柄，本来就必须
    /// 钉在一条线程上）。于是这把 Mutex 从来只有一个线程去 lock，**从来没有被争用过**。
    /// 排队发生在比锁早一层的地方：内核的 accept 队列——第二个请求连从 socket 读出来
    /// 都还没有，谈不上等锁。所以「先分流再拿锁」对那个症状是个空动作。
    ///
    /// **队头阻塞已经在 accept 那一层修掉了**（见 serve_http_blocking）：/health 和
    /// screen.* 读完鉴权完就被丢到另一条线程上跑，accept 循环立刻回去接下一个连接。
    /// 所以浏览器再慢也不会再堵住读屏和按 ref 操作。
    ///
    /// 那这里的分流为什么还留着？因为 screen.* **还有第二条进来的路**：
    /// `recorder.replay` 会把录制里的每一步 re-dispatch 回 `execute_method`。走那条路时
    /// 请求本来就在持锁线程上，分流让它至少不必再等一次锁，也躲开 mutex 中毒
    /// （`lock().unwrap()` 在中毒时 panic，而中毒会连环杀掉整个 sidecar）。
    #[cfg(all(feature = "system", target_os = "macos"))]
    fn screen_method(method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        match method {
            #[cfg(all(feature = "system", target_os = "macos"))]
            "screen.elements" | "screen.probe" => {
                let cap = params.get("cap").and_then(|v| v.as_u64()).unwrap_or(500) as usize;
                // probe = 只看一眼，**不换句柄表**。轮询式的屏幕检查（background_monitor
                // 的 screen 类型）必须走这条：普通读屏每次都会 CFRelease 掉上一批句柄，
                // 于是模型上一次 read_screen 拿到的 ref 会被后台轮询悄悄作废。
                let probe = method == "screen.probe";
                // 目标解析：pid 最准，app 是给调用方按名字指的（模型只知道名字）。
                // 两者都没有才读前台——那是九成的用法，省一次 window.list 往返。
                let pid = Self::resolve_ax_pid(&params)?;
                let t0 = std::time::Instant::now();
                let (nodes, page) = if probe {
                    crate::platform::macos_tree::snapshot_probe(pid, cap)
                } else {
                    crate::platform::macos_tree::snapshot(pid, cap)
                };
                // pid 和应用名要一起回：调用方（read_screen）拿它装 ref 表，
                // 没有身份就没法在动作时校验「读的还是不是同一个 app」。
                //
                // 名字必须**按刚才真正读的那个 pid 反查**。原来这里取的是
                // enumerate_windows() 里 is_frontmost 那一条的标题——只读前台时碰巧
                // 总是对的，一旦支持指定目标就成了系统性的假话：读的是 A，回执说是 B，
                // 而下游正是拿这个名字当身份去做「还是不是同一个 app」的校验。
                let app_name = crate::platform::macos_tree::name_of(pid).unwrap_or_default();
                Ok(serde_json::json!({
                    "elements": nodes,
                    "count": nodes.len(),
                    "truncated": nodes.len() >= cap,
                    "took_ms": t0.elapsed().as_millis() as u64,
                    "pid": pid,
                    "app": app_name,
                    // 明说这次读有没有动过句柄表，调用方不用靠方法名去猜。
                    "refs_installed": !probe,
                    // 前台是浏览器时才有。没有它，一个加载了一半的页面和一个加载完的
                    // 短页面在调用方眼里长得一模一样，模型会把「还没渲染出来」当成
                    // 「这页没有这个按钮」。JXA 老路一直在给，快路上线时漏了。
                    "page": page,
                }))
            }
            // 对上一次 screen.elements 里的某个 ref 执行 AX 动作。用的是**留下来的句柄**，
            // 不重跑枚举——老路那种「点的时候再枚举一遍按下标取第 N 个」既慢又会下标错位。
            #[cfg(all(feature = "system", target_os = "macos"))]
            "screen.act" => {
                let r = params.get("ref").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("press");
                let value = params.get("value").and_then(|v| v.as_str());
                if r == 0 {
                    return Err(Error::Other(anyhow::anyhow!(
                        "screen.act 需要 ref（screen.elements 结果里的序号）"
                    )));
                }
                // pid 是调用方（read_screen 时记下的身份）传下来的，可选：不给就不校验，
                // 给了就必须对得上。见 macos_tree::act 里那段说明。
                let want_pid = params.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32);
                crate::platform::macos_tree::act(r, action, value, want_pid)
                    .map_err(|e| Error::Other(anyhow::anyhow!(e)))
            }
            // 截屏（新口径）：在壳里缩到模型建议的尺寸并回传精确换算关系。
            // 老口径（原图 + 一句「除以 2」的提示）仍在 agent.screen_capture 里给 Windows 用；
            // macOS 走这里，不碰 Agent，所以可以挂在 accept 线程之外。
            "screen.capture" => {
                let num = |k: &str| params.get(k).and_then(|v| v.as_f64()).map(|n| n as i32);
                let region = match (num("x"), num("y"), num("width"), num("height")) {
                    (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
                    (None, None, None, None) => None,
                    _ => return Err(crate::error::Error::System(
                        "区域截图要同时给 x/y/width/height 四个参数；一个都不给就是整屏".into(),
                    )),
                };
                let max_side = capture_max_side(&params);
                let png = crate::system::capture_screen_png(region)?;
                let screen = crate::system::main_display_points()
                    .ok_or_else(|| Error::System("读不到主屏尺寸".into()))?;
                let prepared = crate::vision::prepare(&png, max_side, region, screen).map_err(Error::System)?;
                let out = crate::vision::encode_png(&prepared.image).map_err(Error::System)?;
                Ok(capture_json(&prepared.geometry, &out, region, None))
            }
            // Set-of-Marks：可访问性树 + 截图叠在一起。编号 = read_screen 的 ref（下标 + 1），
            // 快照同时装好句柄表，所以模型认出 ⑦ 就能直接 screen.act ref:7。
            // 静态文本和分组不画框：它们不可点，画上只会把真正的控件糊住。
            "screen.marked" => {
                let cap = params.get("cap").and_then(|v| v.as_u64()).unwrap_or(500) as usize;
                let max_marks = params.get("max_marks").and_then(|v| v.as_u64())
                    .map(|n| n as usize).unwrap_or(crate::vision::DEFAULT_MAX_MARKS);
                let max_side = capture_max_side(&params);
                let pid = Self::resolve_ax_pid(&params)?;
                let t0 = std::time::Instant::now();
                let (nodes, page) = crate::platform::macos_tree::snapshot(pid, cap);
                let app_name = crate::platform::macos_tree::name_of(pid).unwrap_or_default();
                let base = |v: &mut serde_json::Value| {
                    v["elements"] = serde_json::json!(nodes);
                    v["count"] = serde_json::json!(nodes.len());
                    v["truncated"] = serde_json::json!(nodes.len() >= cap);
                    v["took_ms"] = serde_json::json!(t0.elapsed().as_millis() as u64);
                    v["pid"] = serde_json::json!(pid);
                    v["app"] = serde_json::json!(app_name);
                    v["refs_installed"] = serde_json::json!(true);
                    v["page"] = serde_json::json!(page);
                    if crate::system::screen_locked() {
                        v["screen_locked"] = serde_json::json!(true);
                    }
                };
                // **目标在屏幕上一扇窗口都没有就不出图。** 可访问性树读的是那个进程自己的界面，
                // 截图拍的是屏幕——它最小化了、在别的桌面上，图里就没有它，框只会画在别的应用上。
                // 这时只回元素（ref 照样能用，AX 动作不要求可见），把「谁在前面」作为事实交回去，
                // 话由调用方拼。窗口在但被部分盖住的情况在下面逐元素判。
                let stack = crate::system::window_stack();
                if !stack.iter().any(|w| w.pid == pid) {
                    let front = crate::platform::macos_tree::frontmost_pid();
                    let mut v = serde_json::json!({
                        "image": serde_json::Value::Null,
                        "occluded": {
                            "target_pid": pid,
                            "front_pid": front,
                            "front_app": front.and_then(crate::platform::macos_tree::name_of),
                            "reason": "no_onscreen_window",
                        },
                    });
                    base(&mut v);
                    return Ok(v);
                }
                let png = crate::system::capture_screen_png(None)?;
                let screen = crate::system::main_display_points()
                    .ok_or_else(|| Error::System("读不到主屏尺寸".into()))?;
                let mut prepared = crate::vision::prepare(&png, max_side, None, screen).map_err(Error::System)?;
                // 只给**可交互的叶子控件**画框。容器（Window / SplitGroup / ScrollArea / Outline /
                // Table / Toolbar…）和静态文本一律不画：它们不是点击目标，画上只会盖住真正的控件；
                // 单元格（Cell）也不画——它总在一个 Row 里，Row 才是被选中的那一级。
                const MARKABLE: &[&str] = &[
                    "Button", "Link", "TextField", "SecureTextField", "TextArea", "SearchField",
                    "CheckBox", "RadioButton", "PopUpButton", "MenuButton", "MenuItem", "MenuBarItem",
                    "Tab", "Slider", "Incrementor", "ComboBox", "DisclosureTriangle", "Row",
                    "ColorWell", "Switch", "Toggle", "Stepper", "ScrollBar",
                ];
                // Image 只在**带名字**时才标（桌面图标、带标签的图片按钮）：没名字的图标几乎都躺在
                // 按钮 / 行里，它自己不是目标，标了只是一行三个号。
                // 被别的窗口盖住的元素也不标（按元素中心点对 z 序判），数出来告诉调用方。
                let mut hidden = 0usize;
                let marks = crate::vision::marks_for(
                    &prepared.geometry,
                    nodes.iter().enumerate()
                        .filter(|(_, n)| MARKABLE.contains(&n.role.as_str()) || (n.role == "Image" && !n.text.trim().is_empty()))
                        .filter(|(_, n)| {
                            let seen = crate::vision::point_visible(
                                pid, &stack, n.x as f64 + n.w as f64 / 2.0, n.y as f64 + n.h as f64 / 2.0,
                            );
                            if !seen { hidden += 1; }
                            seen
                        })
                        .map(|(i, n)| (i, (n.x, n.y, n.w, n.h))),
                    max_marks,
                );
                crate::vision::draw_marks(&mut prepared.image, &marks);
                let out = crate::vision::encode_png(&prepared.image).map_err(Error::System)?;
                let mut v = capture_json(&prepared.geometry, &out, None, Some(marks.len()));
                v["image"] = v["data_url"].take();
                v["marks_hidden"] = serde_json::json!(hidden);
                // 排查遮挡判断用：把参与判断的窗口栈（前→后）原样交出去。
                if params.get("debug").and_then(|v| v.as_bool()).unwrap_or(false) {
                    v["window_stack"] = serde_json::json!(stack.iter().map(|w| serde_json::json!({
                        "pid": w.pid, "x": w.x, "y": w.y, "w": w.w, "h": w.h,
                    })).collect::<Vec<_>>());
                }
                base(&mut v);
                Ok(v)
            }
            _ => unreachable!("screen_method 只处理 needs_no_agent 里列出的方法"),
        }
    }

    /// 读屏类方法的目标进程：pid > app 名（精确优先于子串）> 前台。三个方法共用这一份，
    /// 不然「同一个 app 参数在 elements 找得到、在 marked 找不到」这种事迟早发生。
    /// 名字对不上就**报错**，绝不"退回读前台"：那会让模型以为自己读的是 A，实际读的是别的应用。
    #[cfg(all(feature = "system", target_os = "macos"))]
    fn resolve_ax_pid(params: &serde_json::Value) -> Result<i32> {
        Ok(match params.get("pid").and_then(|v| v.as_i64()) {
            Some(p) if p > 0 => p as i32,
            _ => match params.get("app").and_then(|v| v.as_str()).map(str::trim) {
                Some(a) if !a.is_empty() => crate::platform::macos_tree::pid_of(a)
                    .ok_or_else(|| {
                        Error::Other(anyhow::anyhow!(
                            "没有找到名字里含「{a}」的运行中应用；用 window.list 看准确名字，或直接给 pid"
                        ))
                    })?,
                _ => crate::platform::macos_tree::frontmost_pid().ok_or_else(|| {
                    Error::Other(anyhow::anyhow!("读不到当前前台应用；给 app 或 pid 参数指定目标"))
                })?,
            },
        })
    }

    fn execute_method(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        // 分流放在拿锁之前。走到这里的 screen.* 只可能来自 recorder.replay 的
        // re-dispatch（正常路径在 accept 那一层就被挪走了）。详见 screen_method 上面那段。
        #[cfg(all(feature = "system", target_os = "macos"))]
        if matches!(method, "screen.elements" | "screen.probe" | "screen.act" | "screen.capture" | "screen.marked") {
            return Self::screen_method(method, params);
        }
        let mut agent = self.agent.lock().unwrap();
        
        match method {
            // 浏览器方法
            #[cfg(feature = "browser")]
            "browser.start" => {
                let headless = params.get("headless").and_then(|v| v.as_bool()).unwrap_or(false);
                // profile 决定这次自动化用谁的身份。默认隔离（干净、安全）；
                // 任务需要用户已登录的会话时传 session——否则必定撞登录墙。
                let profile = match params.get("profile").and_then(|v| v.as_str()).unwrap_or("isolated") {
                    "session" | "user" | "persistent" | "logged_in" => crate::browser::BrowserProfile::Session,
                    _ => crate::browser::BrowserProfile::Isolated,
                };
                let outcome = agent.browser_start_with_profile(headless, profile)?;
                Ok(browser_start_receipt(
                    outcome,
                    crate::browser::BrowserIdentity::new(headless, profile),
                ))
            }
            
            #[cfg(feature = "browser")]
            "browser.goto" => {
                let url = params.get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'url' parameter")))?;
                agent.browser_goto(url)?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            #[cfg(feature = "browser")]
            "browser.click" => {
                let selector = params.get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'selector' parameter")))?;
                agent.browser_click(selector)?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            #[cfg(feature = "browser")]
            "browser.type" => {
                let selector = params.get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'selector' parameter")))?;
                let text = params.get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'text' parameter")))?;
                agent.browser_type(selector, text)?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            #[cfg(feature = "browser")]
            "browser.wait" => {
                let selector = params.get("selector")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'selector' parameter")))?;
                let timeout = params.get("timeout")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(5000);
                agent.browser_wait(selector, timeout)?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            #[cfg(feature = "browser")]
            "browser.eval" => {
                let script = params.get("script")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'script' parameter")))?;
                let result = agent.browser_eval(script)?;
                Ok(result)
            }
            
            #[cfg(feature = "browser")]
            "browser.screenshot" => {
                let path = params.get("path").and_then(|v| v.as_str());
                let png = agent.browser_screenshot(path)?;
                // 回 data_url，和 screen.capture 同形——上层（main.js 的 automation 分支）
                // 只在 r.data_url 存在时才把图走 image 通道喂给模型。原来这里只回
                // `{"status":"ok"}`，于是「截了一张图」变成了「什么都没看到但显示成功」。
                Ok(serde_json::json!({
                    "data_url": format!("data:image/png;base64,{}", crate::system::base64_encode(&png)),
                    "bytes": png.len(),
                    "path": path,
                }))
            }
            
            #[cfg(feature = "browser")]
            "browser.content" => {
                let content = agent.browser_content()?;
                Ok(serde_json::json!({"content": content}))
            }
            
            #[cfg(feature = "browser")]
            "browser.close" => {
                Ok(browser_close_receipt(agent.browser_close()?))
            }
            
            // 系统方法
            #[cfg(feature = "system")]
            "system.init" => {
                agent.system_init()?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            // 屏幕像素。这是整套系统里唯一能"看一眼真实桌面"的通路 —— 在它之前，
            // screenshot 工具只会用无头浏览器渲染一个网址，模型对任何原生应用都是全盲的，
            // 而工具描述还在教它"用 screenshot 验证结果"。
            // 列出**全部**显示器及各自在全局坐标里的矩形。
            //
            // screen.info 只回主屏，于是副屏在模型眼里不存在：落在副屏上的窗口坐标
            //（x 可能是负数，也可能大于主屏宽度）会被判成"屏幕外"，它要么不敢点，
            // 要么把坐标夹回主屏点在错的地方。而 window.list 给的就是全局坐标，
            // 本来就会包含副屏上的窗口——两边对不上，模型无从判断谁是对的。
            //
            // 区域截图那条链早就支持副屏（screencapture -R 收的是全局坐标），
            // 缺的只是"告诉它副屏在哪"。
            #[cfg(all(feature = "system", target_os = "macos"))]
            "screen.displays" => {
                drop(agent);
                let list: Vec<serde_json::Value> = crate::platform::macos::list_displays()
                    .into_iter()
                    .map(|(id, x, y, w, h, is_main)| {
                        serde_json::json!({
                            "id": id, "x": x, "y": y, "width": w, "height": h, "is_main": is_main
                        })
                    })
                    .collect();
                Ok(serde_json::json!({
                    "displays": list,
                    "count": list.len(),
                    "coordinate_space": "screen_points_top_left",
                    "note": "这些矩形是**全局坐标**，和 mouse.move / window.list / screen.capture 的 x,y 同一套。\
                             要拍副屏就把那块的 x/y/width/height 传给 screen.capture。",
                }))
            }

            #[cfg(feature = "system")]
            "screen.capture" => {
                let num = |k: &str| params.get(k).and_then(|v| v.as_f64()).map(|n| n as i32);
                // 四个都给才算区域；给一半是参数写错了，宁可报错也别悄悄拍整屏。
                let region = match (num("x"), num("y"), num("width"), num("height")) {
                    (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
                    (None, None, None, None) => None,
                    _ => return Err(crate::error::Error::System(
                        "区域截图要同时给 x/y/width/height 四个参数；一个都不给就是整屏".into(),
                    )),
                };
                let (data_url, scale_note) = agent.screen_capture(region)?;
                // 坐标系和 mouse.move / screen.info 是同一套（屏幕点、左上原点），
                // 一并回给调用方，免得它再去猜要不要乘 scale_factor。
                Ok(serde_json::json!({
                    "data_url": data_url,
                    "region": region.map(|(x, y, w, h)| serde_json::json!({"x": x, "y": y, "width": w, "height": h})),
                    "coordinate_space": "screen_points_top_left",
                    // Retina 上图是像素、鼠标收的是点，比值在这里说清楚，
                    // 免得模型拿图上量到的坐标直接去点，点到屏幕外。
                    "scale_note": scale_note
                }))
            }

            #[cfg(feature = "system")]
            "mouse.position" => {
                let (x, y) = agent.mouse_location()?;
                Ok(serde_json::json!({"x": x, "y": y, "coordinate_space": "screen_points_top_left"}))
            }

            #[cfg(feature = "system")]
            "mouse.move" => {
                let x = Self::coord(&params, "x")
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'x' parameter")))? as i32;
                let y = Self::coord(&params, "y")
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'y' parameter")))? as i32;
                agent.mouse_move(x, y)?;
                Ok(Self::acted_at(&mut agent))
            }
            
            #[cfg(feature = "system")]
            "mouse.click" => {
                // 两个工具入口（automation / computer）都对外声明可以传 {x,y}，而这里以前只读
                // button——多余的键被 serde 静默忽略，于是"带坐标的点击"实际点在光标上次停留的
                // 位置上，还回一个 ok。不传坐标时保持原地点击的老行为。
                Self::click_n(&mut agent, &params, 1)
            }

            #[cfg(feature = "system")]
            "mouse.double_click" => Self::click_n(&mut agent, &params, 2),

            // 三连击：整段选中一行/一段。文本编辑里的常用动作，此前完全不存在。
            #[cfg(feature = "system")]
            "mouse.triple_click" => Self::click_n(&mut agent, &params, 3),

            // 按住 / 松开。拖滑块、框选、跨应用拖放靠这两条；底层早就有，一直没暴露。
            #[cfg(feature = "system")]
            "mouse.down" => {
                Self::click_at_if_given(&mut agent, &params)?;
                agent.mouse_button_down(params.get("button").and_then(|v| v.as_str()))?;
                Ok(Self::acted_at(&mut agent))
            }

            #[cfg(feature = "system")]
            "mouse.up" => {
                Self::click_at_if_given(&mut agent, &params)?;
                agent.mouse_button_up(params.get("button").and_then(|v| v.as_str()))?;
                Ok(Self::acted_at(&mut agent))
            }
            
            #[cfg(feature = "system")]
            "mouse.drag" => {
                // 四个键各吃一组别名。这条方法在清单里一直是**裸的**（同一行的
                // mouse.scroll{delta_y}、keyboard.down{key} 都带了参数标注），所以模型
                // 只能照它见过的唯一坐标约定写 {x,y,to_x,to_y}，或者照 browser 那套写
                // {x,y,toX,toY}。原来只认 from_x/from_y/to_x/to_y，于是每错一个键就多一个
                // 来回：Missing 'from_x' → 改 → Missing 'from_y' → 再改。
                // 清单已经补上参数名，这里再兜一层，三种常见写法都一次成。
                let pick = |names: &[&str]| names.iter().find_map(|k| Self::coord(&params, k));
                let from_x = pick(&["from_x", "x", "start_x", "startX", "fromX"])
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "mouse.drag 需要起点和终点四个坐标：{{from_x,from_y,to_x,to_y}}（也接受 x/y + toX/toY）")))? as i32;
                let from_y = pick(&["from_y", "y", "start_y", "startY", "fromY"])
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "mouse.drag 需要起点和终点四个坐标：{{from_x,from_y,to_x,to_y}}（也接受 x/y + toX/toY）")))? as i32;
                let to_x = pick(&["to_x", "toX", "end_x", "endX"])
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "mouse.drag 需要起点和终点四个坐标：{{from_x,from_y,to_x,to_y}}（也接受 x/y + toX/toY）")))? as i32;
                let to_y = pick(&["to_y", "toY", "end_y", "endY"])
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "mouse.drag 需要起点和终点四个坐标：{{from_x,from_y,to_x,to_y}}（也接受 x/y + toX/toY）")))? as i32;
                agent.mouse_drag(from_x, from_y, to_x, to_y)?;
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            #[cfg(feature = "system")]
            "mouse.scroll" => {
                // delta_x 原来用 as_i64 取：模型给 3.0（JSON 里是浮点）或 "3"（字符串）
                // 都会拿到 None → **静默当成 0**，水平滚动就这么一声不响地没了。
                // delta_y 早就用 coord 了，两边不一致本身就是信号。
                let delta_x = Self::coord(&params, "delta_x").unwrap_or(0.0) as i32;
                let delta_y = Self::coord(&params, "delta_y")
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "mouse.scroll 需要 delta_y（正数向下、负数向上）；delta_x 可选")))? as i32;
                // 滚动作用在**指针所在的那个区域**上，不是"当前窗口"。想滚某个面板就得先把
                // 指针移进去——而这件事描述里从没说过，模型只能在整页上滚然后发现没动。
                // 收下 x/y，语义和 click 一致：给了就先移过去。
                Self::click_at_if_given(&mut agent, &params)?;
                agent.mouse_scroll(delta_x, delta_y)?;
                let mut out = Self::acted_at(&mut agent);
                out["scrolled"] = serde_json::json!({"delta_x": delta_x, "delta_y": delta_y});
                Ok(out)
            }
            
            #[cfg(feature = "system")]
            "keyboard.type" => {
                let text = params.get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'text' parameter")))?;
                focus_bracketed(agent, |a| a.keyboard_type(text))
            }
            
            // 长按。keyboard.down 之后没有任何合法的等待手段——computer 拿不到 sleep，
            // 而两次 RPC 之间的间隔完全不可控。空格长按跳跃、方向键长按连续滚动、
            // 长按呼出菜单，全卡在这一条上。
            #[cfg(feature = "system")]
            "keyboard.hold" => {
                let key = params.get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!(
                        "keyboard.hold 需要 key（要按住的键）和可选的 ms（毫秒，默认 500，上限 10000）")))?;
                let ms = Self::coord(&params, "ms")
                    .or_else(|| Self::coord(&params, "duration_ms"))
                    .or_else(|| Self::coord(&params, "millis"))
                    .unwrap_or(500.0)
                    .max(1.0) as u64;
                let key = key.to_string();
                focus_bracketed(agent, |a| a.keyboard_hold(&key, ms))?;
                Ok(serde_json::json!({"status": "ok", "key": key, "held_ms": ms.min(10_000)}))
            }

            #[cfg(feature = "system")]
            "keyboard.press" => {
                let key = params.get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'key' parameter")))?;
                focus_bracketed(agent, |a| a.keyboard_press(key))
            }
            
            #[cfg(feature = "system")]
            "keyboard.down" => {
                let key = params.get("key").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'key' parameter")))?;
                let mut receipt = focus_bracketed(agent, |a| a.keyboard_down(key))?;
                receipt["note"] = serde_json::Value::String(
                    "这个键现在是按住状态，用完必须 keyboard.up 松开，否则它会一直卡住影响之后所有输入。".into(),
                );
                Ok(receipt)
            }
            #[cfg(feature = "system")]
            "keyboard.up" => {
                let key = params.get("key").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'key' parameter")))?;
                focus_bracketed(agent, |a| a.keyboard_up(key))
            }
            #[cfg(feature = "system")]
            "keyboard.combo" => {
                // 模型从同一份工具目录的 browser 那里学到的写法是 "Meta+K" 这种整串，
                // 而这里要的是数组、且每个元素是**单个**键名。原来只认数组，字符串
                // 一律回同一句 "Missing 'keys' parameter (array)"——模型明明传了 keys，
                // 于是判定这是工具的 bug；就算它套上方括号，["Meta+S"] 又会在 parse_key
                // 炸成 "Unknown key: Meta+S"，那句话读起来是「没有这个键」而不是
                // 「要拆成两个」，于是它转去试 Command+S、⌘S、cmd s，全军覆没。
                // 这里直接吃下整串写法：按 + 或空格拆开，"Meta+S" 等价于 ["meta","s"]。
                let owned: Vec<String> = match params.get("keys").or_else(|| params.get("key")) {
                    Some(v) if v.is_array() => v.as_array().unwrap().iter()
                        .filter_map(|x| x.as_str()).map(|s| s.to_string()).collect(),
                    Some(v) if v.is_string() => v.as_str().unwrap()
                        .split(|c| c == '+' || c == ' ')
                        .map(|s| s.trim()).filter(|s| !s.is_empty())
                        .map(|s| s.to_string()).collect(),
                    _ => return Err(Error::Other(anyhow::anyhow!(
                        "keyboard.combo 需要 keys：可以是数组 [\"mod\",\"s\"]，也可以直接写 \"mod+s\"。mod = 本平台主修饰键（mac=Cmd，Windows=Ctrl），\"cmd\" 等价；真要按 Windows 键写 \"win\"。每个元素必须是**单个**键名（cmd/ctrl/alt/shift/enter/tab/esc/f1-f12/单个字符），不是整条快捷键。"))),
                };
                let key_strs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
                focus_bracketed(agent, |a| a.keyboard_combo(key_strs))
            }
            
            #[cfg(feature = "system")]
            "sleep" => {
                let ms = params.get("ms")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'ms' parameter")))?;
                drop(agent);
                std::thread::sleep(Duration::from_millis(ms));
                Ok(serde_json::json!({"status": "ok"}))
            }
            
            // ── 录制回放：一条 recording = 一串 {method, params} 步骤，回放即逐条 re-dispatch ──
            "recorder.save" => {
                let name = params.get("name").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'name'")))?;
                let steps = params.get("steps").cloned().unwrap_or_else(|| serde_json::json!([]));
                drop(agent);
                let dir = recordings_dir();
                std::fs::create_dir_all(&dir).ok();
                let path = dir.join(format!("{}.json", sanitize_name(name)));
                let doc = serde_json::json!({ "name": name, "steps": steps });
                std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default())
                    .map_err(|e| Error::Other(anyhow::anyhow!("save recording failed: {}", e)))?;
                Ok(serde_json::json!({ "status": "ok", "path": path.to_string_lossy() }))
            }
            "recorder.list" => {
                drop(agent);
                let mut names = vec![];
                if let Ok(rd) = std::fs::read_dir(recordings_dir()) {
                    for e in rd.flatten() {
                        if let Some(n) = e.path().file_stem().and_then(|s| s.to_str()) { names.push(n.to_string()); }
                    }
                }
                Ok(serde_json::json!({ "recordings": names }))
            }
            "recorder.replay" => {
                // 回放：优先用传入的 steps，否则按 name 从盘上加载；逐条 re-dispatch，步间可选延时。
                drop(agent); // 释放锁，下面每步 execute_method 会重新加锁
                let steps: Vec<serde_json::Value> = if let Some(arr) = params.get("steps").and_then(|v| v.as_array()) {
                    arr.clone()
                } else if let Some(name) = params.get("name").and_then(|v| v.as_str()) {
                    let path = recordings_dir().join(format!("{}.json", sanitize_name(name)));
                    let data = std::fs::read_to_string(&path)
                        .map_err(|e| Error::Other(anyhow::anyhow!("load recording '{}' failed: {}", name, e)))?;
                    serde_json::from_str::<serde_json::Value>(&data).ok()
                        .and_then(|v| v.get("steps").and_then(|s| s.as_array()).cloned())
                        .ok_or_else(|| Error::Other(anyhow::anyhow!("recording '{}' has no steps", name)))?
                } else {
                    return Err(Error::Other(anyhow::anyhow!("recorder.replay needs 'steps' or 'name'")));
                };
                let delay = params.get("delay_ms").and_then(|v| v.as_u64()).unwrap_or(250);
                // 复用同一套分发；失败时带上停在第几步、已执行几步
                replay_steps(&steps, delay, |m, p| self.execute_method(m, p))
            }

            // ── 窗口/屏幕：平台层早就有（enumerate/activate/screen_info），此前一直没暴露给 RPC，
            //    AI 桌面自动化最需要的"激活目标应用再操作"因此做不了。补齐。 ──
            // 原生 AX 快照。JXA 那条路每读一个属性就是一次 Apple Event 往返，
            // 实测真实窗口下 500 个元素要 95 秒，而读屏的上限是 6 秒——必然超时。
            // 这里是进程内 C 调用。
            #[cfg(feature = "system")]
            "window.list" => {
                drop(agent);
                let ctrl = crate::platform::get_window_controller();
                let wins = ctrl.enumerate_windows()?;
                // macOS 这一侧枚举的是**正在运行的应用**，不是窗口：几何四个字段在
                // 平台层就是硬编码的 0，is_visible 装的其实是 NSRunningApplication.isActive
                // （是否前台），is_minimized 恒 false。
                //
                // 照原样把 x/y/width/height 报成 0 是最坏的一种错：模型会拿它算窗口中心、
                // 发 mouse.click{x:0,y:0}，点在屏幕左上角的苹果菜单上，而回执是个漂亮的
                // {"status":"ok","x":0,"y":0}——静默的错答案，没有任何一步会触发重试。
                // 缺字段会让模型换个地方找，值为 0 的字段会让它拿去算。所以宁可不给。
                // 按**实际数据**判，不按平台猜。
                //
                // 这里原来写死 `cfg!(not(target_os = "macos"))`——在 macOS 那条枚举还走
                // NSWorkspace.runningApplications（应用列表、几何硬写 0）的时候是对的。
                // 现在那条已经换成 CGWindowListCopyWindowInfo，几何是真的了，
                // 再硬说「这条路拿不到窗口几何」就成了反方向的假话：模型会以为拿不到坐标，
                // 转而去做多余的前置+read_screen。
                // 判据改成「这批里有没有非零矩形」——哪天枚举又退化回全 0，它自己会说回去。
                let geometry_real = wins.iter().any(|w| w.width > 0 && w.height > 0);
                let list: Vec<serde_json::Value> = wins.iter().map(|w| {
                    let mut o = serde_json::Map::new();
                    o.insert("title".into(), serde_json::json!(w.title));
                    o.insert("process".into(), serde_json::json!(w.process_name));
                    // isActive 唯一诚实的读法就是「是不是前台」，只报这一个。
                    o.insert("frontmost".into(), serde_json::json!(w.is_frontmost));
                    // geometry_real 是**批级**判据：这一批里只要有一个窗口有真矩形，
                    // 它就是 true。但单条仍可能是 0——Windows 上最小化的窗口
                    // （GetWindowRect 给的是 -32000 哨兵）和取矩形失败的窗口，
                    // 平台层都归零了。批级判据挡不住这些，照发就等于告诉模型
                    // "这个窗口在屏幕左上角、160x160"，它会拿去算点击位置。
                    // 所以最终还得逐条看：这一条自己有没有非零矩形。
                    if geometry_real && w.width > 0 && w.height > 0 {
                        o.insert("x".into(), serde_json::json!(w.x));
                        o.insert("y".into(), serde_json::json!(w.y));
                        o.insert("width".into(), serde_json::json!(w.width));
                        o.insert("height".into(), serde_json::json!(w.height));
                        o.insert("visible".into(), serde_json::json!(w.is_visible));
                    }
                    // minimized 要**无条件**报（只要这批的几何是真的）。最小化恰恰是
                    // 单条没有几何的主要原因，而它同时也是解法：先 window.restore
                    // 再操作。跟着几何一起被藏掉的话，模型只看到"这条没坐标"，
                    // 不知道下一步该干什么。
                    if geometry_real {
                        o.insert("minimized".into(), serde_json::json!(w.is_minimized));
                    }
                    serde_json::Value::Object(o)
                }).collect();
                if geometry_real {
                    Ok(serde_json::json!({ "windows": list }))
                } else {
                    // 不给坐标就必须说去哪儿拿，否则模型只会以为这次查询失败了。
                    Ok(serde_json::json!({
                        "windows": list,
                        "note": "这一批没有拿到窗口矩形，所以没有 x/y/width/height（给 0 会让你照着点到屏幕左上角）。要元素坐标就把目标切到前台再用 read_screen，它给的每个元素都带真实屏幕坐标；frontmost 是这里唯一可信的状态位，合成按键只会进入 frontmost 为 true 的那个应用。",
                    }))
                }
            }
            #[cfg(feature = "system")]
            "window.activate" => {
                let title = params.get("title").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'title' parameter")))?;
                drop(agent);
                crate::platform::get_window_controller().activate_window(title)?;
                // 到这里才代表**回读确认过**目标真在前台了（见 platform 层的轮询）。
                // 把实际前台一并回出去，调用方不必再信一个光秃秃的 ok。
                Ok(serde_json::json!({ "status": "ok", "frontmost": frontmost_now() }))
            }
            #[cfg(feature = "system")]
            "window.minimize" => {
                let title = params.get("title").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'title' parameter")))?;
                drop(agent);
                crate::platform::get_window_controller().minimize_window(title)?;
                // 到这里代表**回读确认过**它真的最小化了（平台层轮询到位才返回 Ok）。
                Ok(serde_json::json!({ "status": "ok", "minimized": title }))
            }
            // 只有最小化没有还原等于半条路：模型把一个窗口收起来之后就再也拿不回来，
            // 只能去点 Dock——而那要坐标、要截图、要猜。
            // 原来这条只编进 macOS，而工具清单在 Windows 上照样列着它——模型收起
            // 一个窗口之后想还原，收到的是「Unknown method」。那句话读起来像是它
            // 方法名拼错了，于是换着参数重试，而不是去找别的路。还原在 Windows 上
            // 本来就是现成的（ShowWindow + SW_RESTORE），缺的只是没接上来。
            #[cfg(feature = "system")]
            "window.restore" => {
                let title = params.get("title").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'title' parameter")))?;
                drop(agent);
                crate::platform::get_window_controller().restore_window(title)?;
                Ok(serde_json::json!({ "status": "ok", "restored": title }))
            }
            #[cfg(feature = "system")]
            // screen.info 报的 width/height 来自 CGDisplay::pixels_wide()——名字叫 pixels，
            // 返回的其实是**点**（本机实测 1728x1117，而物理像素是 3456x2234）。合成事件的
            // enigo、read_screen 的 AX 树、window.list 用的也都是点。曾经的提示词教模型
            // "坐标要乘 scale_factor"，于是每一次坐标点击都打在两倍的位置上。
            // 让接口自己把坐标空间说清楚，比在提示词里反复叮嘱可靠。
            "screen.info" => {
                drop(agent);
                let info = crate::platform::get_window_controller().get_screen_info()?;
                Ok(serde_json::json!({
                    "width": info.width,
                    "height": info.height,
                    "scale_factor": info.scale_factor,
                    // 自描述：别让调用方猜。width/height 和 mouse.move / read_screen /
                    // window.list 是同一套坐标；scale_factor 只说明像素密度，不是换算系数。
                    "coordinate_space": "screen_points_top_left",
                    "note": "width/height are already in the units mouse.move accepts. Never multiply coordinates by scale_factor.",
                    // 先告诉调用方能不能注入事件，省得它点了十次才发现系统压根没收到
                    "input_permission": if crate::agent::input_permission_granted() { "granted" } else { "denied" },
                    "input_permission_hint": if crate::agent::input_permission_granted() {
                        ""
                    } else {
                        "Accessibility permission is missing: synthetic mouse/keyboard events are discarded by macOS. Use browser automation, shell, or file tools instead, and tell the user to grant it in System Settings > Privacy & Security > Accessibility, then fully restart the app."
                    }
                }))
            }

            // ── 剪贴板：agent.rs 早就实现（clipboard_get/set、quick_paste 粘贴长文本比逐键快百倍），补暴露。 ──
            #[cfg(feature = "system")]
            "clipboard.get" => {
                let text = agent.clipboard_get_text()?;
                Ok(serde_json::json!({ "text": text }))
            }
            #[cfg(feature = "system")]
            "clipboard.set" => {
                let text = params.get("text").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'text' parameter")))?;
                agent.clipboard_set_text(text)?;
                Ok(serde_json::json!({ "status": "ok" }))
            }
            #[cfg(feature = "system")]
            "keyboard.paste" => {
                let text = params.get("text").and_then(|v| v.as_str())
                    .ok_or_else(|| Error::Other(anyhow::anyhow!("Missing 'text' parameter")))?;
                focus_bracketed(agent, |a| a.quick_paste(text))
            }
            _ => Err(Error::Other(anyhow::anyhow!("Unknown method: {}", method))),
        }
    }

    /// 启动 HTTP-RPC 服务器（axum）——把这一个**有状态**的 RpcServer 通过 `POST /rpc` 暴露出去。
    /// 浏览器会话 + 录制状态在整个进程生命周期常驻；任何自动化引擎都能 POST /rpc 调它。
    /// 极简阻塞式 HTTP-RPC 服务（std only）。`POST /rpc` body=JSON-RPC → JSON-RPC 响应；`GET /health`→ok。
    ///
    /// **碰 Agent 的活串行，不碰的并发。** Agent 含 macOS !Send 句柄，必须全程钉在这条线程上，
    /// 所以 browser.* / mouse.* / keyboard.* / recorder.* 一律 inline 跑。
    ///
    /// 但「整个服务单线程」曾经是个真问题：读请求本身在 accept 队列里排队，于是一次
    /// browser.goto（最坏一分钟）期间，read_screen / ui_click / 甚至 /health 的连接连从
    /// socket 读出来都还没有。症状是「整个自动化都卡住了」，而且它还会把父进程的健康探测
    /// 拖超时——那边的看门狗一度会据此 SIGKILL 掉整个进程组，连浏览器一起。
    ///
    /// 现在读+鉴权仍在这条线程（很快，且有 15 秒 IO 上限），**执行**按碰不碰 Agent 分流。
    pub fn serve_http_blocking(&self) -> Result<()> {
        let addr = format!("127.0.0.1:{}", self.port);
        let listener = std::net::TcpListener::bind(&addr)
            .map_err(|e| Error::Other(anyhow::anyhow!("bind {} failed: {}", addr, e)))?;
        eprintln!("🚀 automation server on http://{}/rpc", addr);
        for stream in listener.incoming() {
            match stream {
                Ok(mut s) => {
                    // 读请求 + 鉴权仍然在这条线程上做：它们很快，而且有 15 秒 IO 上限。
                    // **执行**才分流。
                    match self.read_and_auth(&mut s) {
                        Ok(Some(job)) => {
                            if job.offloadable() {
                                // 不碰 Agent 的活（/health 和 screen.*）另开线程跑，
                                // accept 循环立刻回去接下一个连接。
                                //
                                // 这才是「浏览器不再堵读屏」的**真正**修法。之前那次把
                                // screen.* 挪到 agent 锁前面是无效的：这个服务从来只有
                                // 一条线程，锁根本没被争用过，排队发生在比锁早一层的
                                // accept 队列里——第二个请求连从 socket 读出来都还没有。
                                //
                                // 只有这两族能这样搬：它们不碰 Agent（含 macOS !Send 句柄，
                                // 必须钉在一条线程上）。screen.* 的共享状态只有 HANDLES，
                                // 而它自带 Mutex，act 整个动作期间都握着那把锁，
                                // 和并发的读屏之间不会撕裂。
                                let token = self.token.clone();
                                std::thread::spawn(move || {
                                    let _ = Self::finish_offloaded(&mut s, job, token.as_deref());
                                });
                            } else {
                                let _ = self.finish_inline(&mut s, job);
                            }
                        }
                        // 鉴权失败/格式错的响应已经在 read_and_auth 里写回去了。
                        Ok(None) | Err(_) => {}
                    }
                }
                Err(_) => continue,
            }
        }
        Ok(())
    }

    /// 读请求 + 鉴权。**不执行**。
    ///
    /// 拆出来是为了让 accept 循环能尽快回去接下一个连接：读和鉴权都很快（而且有 15 秒
    /// IO 上限），真正会花时间的是执行。返回 None 表示已经把 401/413 写回去了。
    fn read_and_auth(&self, stream: &mut std::net::TcpStream) -> std::io::Result<Option<Job>> {
        use std::io::{Read, Write, BufRead, BufReader};
        // 读写都要超时：一个连上来却不发数据的连接会把读这一步堵死。
        // 本机任意进程都能连上 127.0.0.1，成本极低。
        let io_timeout = std::time::Duration::from_secs(15);
        let _ = stream.set_read_timeout(Some(io_timeout));
        let _ = stream.set_write_timeout(Some(io_timeout));
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let mut parts = line.split_whitespace();
        let http_method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        // 读到空行为止，抓 Content-Length + 鉴权/来源判定所需的头
        let mut content_len = 0usize;
        let mut token: Option<String> = None;
        let mut nonce: Option<String> = None;
        let mut browser_origin = false;
        loop {
            let mut h = String::new();
            let n = reader.read_line(&mut h)?;
            if n == 0 || h == "\r\n" || h == "\n" { break; }
            let low = h.to_ascii_lowercase();
            if let Some(v) = low.strip_prefix("content-length:") {
                content_len = v.trim().parse().unwrap_or(0);
            }
            if let Some(v) = low.strip_prefix("x-automation-token:") {
                token = Some(v.trim().to_string());
            }
            // 挑战应答的随机数（见下面 /health）。它不是凭据，明文即可。
            if let Some(v) = low.strip_prefix("x-automation-nonce:") {
                nonce = Some(v.trim().to_string());
            }
            // 浏览器一定会带上这些头之一；本地父进程（reqwest）一个都不带。
            if low.starts_with("origin:")
                || low.starts_with("referer:")
                || low.starts_with("sec-fetch-site:")
                || low.starts_with("sec-fetch-mode:")
            {
                browser_origin = true;
            }
        }

        // ── 鉴权 ──────────────────────────────────────────────────────────────
        //
        // 这个服务能合成**真实的鼠标键盘事件**（mouse.click / keyboard.type /
        // keyboard.combo），也就是说能打开终端敲任意命令。它监听 127.0.0.1 上一个固定
        // 端口、随签名安装包分发，且此前对每个响应都回 `Access-Control-Allow-Origin: *`。
        //
        // 后果：用户只要用过一次桌面自动化，之后在**普通浏览器里打开的任意网页**（包括
        // 第三方广告 iframe）就能 fetch 到这里 —— `text/plain` 属于 CORS 安全列表内容
        // 类型、不触发预检，请求直达，零用户交互拿到本机代码执行。
        //
        // 两道闸：
        // 1. 共享密钥走**自定义请求头**。自定义头会强制浏览器发 CORS 预检，而我们不响应
        //    OPTIONS —— 于是浏览器永远发不出这个头，网页被物理挡在门外；本地父进程
        //    （reqwest）不受影响。
        // 2. 只要出现任何浏览器指纹头（Origin / Referer / Sec-Fetch-*）就直接拒绝。
        //
        // ACAO 头也一并删掉：它此前额外解锁了「读回响应」的能力（browser.content 等），
        // 让攻击从盲写升级成可读写。注意只删 ACAO 不能修掉 RCE —— 写侧根本不需要读响应。
        // `/health` 是**挑战应答**，不要求调用方出示 token —— 恰恰相反，它必须**不出示**。
        //
        // 这个端点的用途是回答「占着这个端口的，是不是我自己刚起的那个 sidecar」。
        // 原来的做法是客户端把 token 放在请求头里发过去、只看 HTTP 200 —— 两头都错：
        //   · 只看 200：冒充者不运行我们的代码，它想回什么状态码就回什么；
        //   · 发 token：请求是发给**尚未验明身份**的一方的，等于把一次性密钥直接
        //     交到冒充者手上，它随后可以拿着这个 token 去满足任何后续校验。
        // 于是「先占住 127.0.0.1:3037 就能接管全部桌面自动化」这条路一直是通的，
        // 而后续流过去的包括 keyboard.type 的正文（用户密码）、剪贴板、网页正文。
        //
        // 改成：客户端发一个随机 nonce（明文，不是凭据），我们回 SHA-256(token:nonce)。
        // 只有真的持有 token 的一方算得出来，而 token 从不离开本进程。
        let health_probe = path == "/health";
        let authed = if health_probe {
            true
        } else {
            match (&self.token, &token) {
                (Some(expected), Some(got)) => constant_time_eq(expected.as_bytes(), got.as_bytes()),
                // 没配 token 时保持旧行为（本地开发直接跑 sidecar），但依然拒绝浏览器来源。
                (None, _) => true,
                (Some(_), None) => false,
            }
        };
        if !authed || browser_origin {
            let body = b"{\"error\":\"unauthorized\"}";
            let header = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes())?;
            stream.write_all(body)?;
            stream.flush()?;
            return Ok(None);
        }

        // 鉴权之后才读 body。原来读在鉴权**之前**：一个未鉴权的连接报一个撒谎的
        // Content-Length，就能让我们在验明身份前先按它说的大小申请内存。
        const MAX_BODY: usize = 8 * 1024 * 1024;
        if content_len > MAX_BODY {
            let body = b"{\"error\":\"payload too large\"}";
            let header = format!(
                "HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes())?;
            stream.write_all(body)?;
            stream.flush()?;
            return Ok(None);
        }
        let body = if content_len > 0 {
            let mut buf = vec![0u8; content_len];
            reader.read_exact(&mut buf)?;
            buf
        } else { Vec::new() };

        // 方法名要在这里就取出来：分流判据靠它，而分流发生在执行之前。
        let rpc_method = if http_method == "POST" && path == "/rpc" {
            serde_json::from_slice::<RpcRequest>(&body).ok().map(|r| r.method)
        } else {
            None
        };

        Ok(Some(Job { health_probe, nonce, http_method, path, body, rpc_method }))
    }

    /// 把响应写回去。
    fn write_ok(stream: &mut std::net::TcpStream, resp_body: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            resp_body.len()
        );
        stream.write_all(header.as_bytes())?;
        stream.write_all(resp_body)?;
        stream.flush()
    }

    fn parse_error_body(e: impl std::fmt::Display) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0", "id": serde_json::Value::Null,
            "error": { "code": -32700, "message": format!("parse error: {}", e) }
        })).unwrap_or_default()
    }

    /// 不碰 Agent 的活：/health 和 screen.*。在另一条线程上跑。
    fn finish_offloaded(
        stream: &mut std::net::TcpStream,
        job: Job,
        token: Option<&str>,
    ) -> std::io::Result<()> {
        let resp_body: Vec<u8> = if job.health_probe {
            // 持有 token 才算得出这个值；没配 token（本地开发）时维持旧的 "ok"。
            match (token, &job.nonce) {
                (Some(tok), Some(n)) => health_challenge_response(tok, n).into_bytes(),
                _ => b"ok".to_vec(),
            }
        } else {
            match serde_json::from_slice::<RpcRequest>(&job.body) {
                Ok(req) => {
                    #[cfg(all(feature = "system", target_os = "macos"))]
                    let result = Self::screen_method(&req.method, req.params);
                    #[cfg(not(all(feature = "system", target_os = "macos")))]
                    let result: Result<serde_json::Value> = Err(Error::Other(anyhow::anyhow!(
                        "screen.* 只在 macOS 上可用"
                    )));
                    let resp = match result {
                        Ok(value) => RpcResponse {
                            jsonrpc: "2.0".to_string(), result: Some(value), error: None, id: req.id,
                        },
                        Err(e) => RpcResponse {
                            jsonrpc: "2.0".to_string(), result: None,
                            error: Some(RpcError { code: -32603, message: e.to_string() }), id: req.id,
                        },
                    };
                    serde_json::to_vec(&resp).unwrap_or_default()
                }
                Err(e) => Self::parse_error_body(e),
            }
        };
        Self::write_ok(stream, &resp_body)
    }

    /// 要用 Agent 的活。必须留在 accept 那条线程上：Agent 含 macOS !Send 句柄。
    fn finish_inline(&self, stream: &mut std::net::TcpStream, job: Job) -> std::io::Result<()> {
        let resp_body: Vec<u8> = if job.http_method == "POST" && job.path == "/rpc" {
            match serde_json::from_slice::<RpcRequest>(&job.body) {
                Ok(req) => serde_json::to_vec(&self.handle_request(req)).unwrap_or_default(),
                Err(e) => Self::parse_error_body(e),
            }
        } else {
            b"{\"error\":\"not found\"}".to_vec()
        };
        Self::write_ok(stream, &resp_body)
    }
}

/// 一次已经读完并通过鉴权、但**还没执行**的请求。
struct Job {
    health_probe: bool,
    nonce: Option<String>,
    http_method: String,
    path: String,
    body: Vec<u8>,
    /// POST /rpc 时解析出来的方法名。分流判据靠它。
    rpc_method: Option<String>,
}

impl Job {
    /// 这次活碰不碰 Agent。不碰的才能挪到别的线程上跑。
    ///
    /// 判据必须**保守**：多算一个进来就等于把 Agent 从"永远单线程"变成"可能并发"，
    /// 而它带的是 macOS !Send 句柄。只有这两族确定不碰：
    ///   · /health —— 只做一次 SHA-256；
    ///   · screen.elements / screen.probe / screen.act —— 走 macos_tree，
    ///     共享状态只有自带 Mutex 的 HANDLES。
    fn offloadable(&self) -> bool {
        if self.health_probe {
            return true;
        }
        #[cfg(all(feature = "system", target_os = "macos"))]
        {
            if matches!(
                self.rpc_method.as_deref(),
                Some("screen.elements") | Some("screen.probe") | Some("screen.act")
                    | Some("screen.capture") | Some("screen.marked")
            ) {
                return true;
            }
        }
        false
    }
}

/// 截图最长边。`raw:true` 或 `max_side:0` = 原图（要真实像素做 OCR/取证时用）；默认 1280。
/// 上限 4096：再大既超各家视觉 API 的预算，也没有任何模型在那个尺寸上更准。
#[cfg(all(feature = "system", target_os = "macos"))]
fn capture_max_side(params: &serde_json::Value) -> u32 {
    if params.get("raw").and_then(|v| v.as_bool()).unwrap_or(false) {
        return 0;
    }
    match params.get("max_side").and_then(|v| v.as_u64()) {
        Some(n) => n.min(4096) as u32,
        None => crate::vision::DEFAULT_MAX_SIDE,
    }
}

/// 截图回执。**坐标空间是图上像素**，换算关系一并给出，壳按它换算，模型不换算。
#[cfg(all(feature = "system", target_os = "macos"))]
fn capture_json(
    g: &crate::vision::Geometry,
    png: &[u8],
    region: Option<(i32, i32, i32, i32)>,
    marks: Option<usize>,
) -> serde_json::Value {
    let mut v = serde_json::json!({
        "data_url": format!("data:image/png;base64,{}", crate::system::base64_encode(png)),
        "image_px": { "width": g.image_w, "height": g.image_h },
        "points_origin": { "x": g.origin_x, "y": g.origin_y },
        "points_size": { "width": g.points_w, "height": g.points_h },
        "points_per_image_px": g.points_per_image_px,
        "coordinate_space": "image_px_top_left",
        "region": region.map(|(x, y, w, h)| serde_json::json!({"x": x, "y": y, "width": w, "height": h})),
        "marks": marks,
        "note": "Coordinates read off this image are IMAGE PIXELS with origin top-left. The host converts them to screen points as point = points_origin + px × points_per_image_px; do not convert them yourself.",
    });
    // 锁屏时这张图是全黑的，说出来（JS 拼话）。
    if crate::system::screen_locked() {
        v["screen_locked"] = serde_json::json!(true);
    }
    v
}

/// 录制文件目录：~/.michael-automation/recordings/
fn recordings_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join(".michael-automation").join("recordings")
}

/// 清洗录制名为安全文件名（防路径穿越）。
fn sanitize_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() { "recording".into() } else { s.chars().take(80).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_rpc_request_parsing() {
        let json = r#"{
            "jsonrpc": "2.0",
            "method": "browser.goto",
            "params": {"url": "https://example.com"},
            "id": 1
        }"#;
        
        let req: RpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "browser.goto");
        assert_eq!(req.params["url"], "https://example.com");
    }

    fn job(method: Option<&str>, health: bool) -> Job {
        Job {
            health_probe: health,
            nonce: None,
            http_method: "POST".into(),
            path: if health { "/health".into() } else { "/rpc".into() },
            body: Vec::new(),
            rpc_method: method.map(str::to_string),
        }
    }

    /// 分流判据必须**保守**。
    ///
    /// 多算一族进来，就等于把 Agent 从「永远只有一条线程碰它」变成「可能并发」——
    /// 而它带的是 macOS !Send 句柄，那不是数据竞争的风险，是未定义行为。
    /// 所以这条测试钉的是白名单本身：只有 /health 和三个 screen.* 能挪走。
    #[test]
    fn only_agent_free_work_leaves_the_accept_thread() {
        assert!(job(None, true).offloadable(), "/health 必须能挪走——它只做一次 SHA-256");

        for m in ["browser.goto", "browser.click", "mouse.click", "keyboard.type",
                  "recorder.replay", "window.list", "sleep", "system.open"] {
            assert!(
                !job(Some(m), false).offloadable(),
                "{m} 被判成可以挪走——它会碰 Agent，而 Agent 必须钉在一条线程上"
            );
        }

        #[cfg(all(feature = "system", target_os = "macos"))]
        for m in ["screen.elements", "screen.probe", "screen.act", "screen.capture", "screen.marked"] {
            assert!(
                job(Some(m), false).offloadable(),
                "{m} 没能挪走——浏览器一忙就会把读屏和按 ref 操作重新堵死"
            );
        }
    }

    /// accept 循环真的把可挪的活丢出去了，而不是只定义了一个没人用的判据。
    ///
    /// 判据是源码文本：这条链要跑起来得有真实的 TCP 服务和 macOS 授权，单元测试里
    /// 验不了行为，但「判据存在却没接线」恰恰是这个仓库反复出过的事（screen.act 当初
    /// 写好了零调用点）。所以至少钉住接线本身。
    #[test]
    fn the_accept_loop_actually_offloads() {
        let src = include_str!("rpc.rs");
        let at = src.find("pub fn serve_http_blocking").expect("服务入口不见了");
        // 按字符取，不按字节切：这份源码全是中文注释，按字节加偏移会切在多字节字符
        // 中间直接 panic（踩了一次）。
        let end = src[at..].find("\n    fn read_and_auth").unwrap_or(4000);
        let body: String = src[at..at + end].chars().collect();
        let body = body.as_str();
        assert!(body.contains("read_and_auth"), "accept 循环没有先读+鉴权再分流");
        assert!(body.contains("offloadable()"), "accept 循环没有用分流判据");
        assert!(body.contains("std::thread::spawn"), "可挪的活没有真的挪出这条线程");
        assert!(body.contains("finish_inline"), "碰 Agent 的活没有留在这条线程上");
    }
}

#[cfg(all(test, feature = "system"))]
mod coord_tests {
    use super::RpcServer;

    // 工具 schema 把坐标声明成 number，模型给 100.0 完全合法；而 as_i64() 对它返回 None，
    // 于是坐标被当成"根本没传"——RPC 照样回 ok，点击落在光标上次停留的地方。
    #[test]
    fn 小数与字符串坐标不再被当成没传() {
        let p = serde_json::json!({"x": 100.0, "y": 200.5, "sx": "512", "bad": "abc", "nil": null});
        assert_eq!(RpcServer::coord(&p, "x"), Some(100.0));
        assert_eq!(RpcServer::coord(&p, "y"), Some(200.5));
        assert_eq!(RpcServer::coord(&p, "sx"), Some(512.0));
        assert_eq!(RpcServer::coord(&p, "bad"), None, "非数字文本不能被当成坐标");
        assert_eq!(RpcServer::coord(&p, "nil"), None);
        assert_eq!(RpcServer::coord(&p, "missing"), None, "真的没传要如实报缺参");
    }

    #[test]
    fn 整数坐标保持原样() {
        let p = serde_json::json!({"x": 0, "y": -3, "big": 1728});
        assert_eq!(RpcServer::coord(&p, "x"), Some(0.0));
        assert_eq!(RpcServer::coord(&p, "y"), Some(-3.0), "负坐标是合法的多显示器坐标");
        assert_eq!(RpcServer::coord(&p, "big"), Some(1728.0));
    }
}

#[cfg(test)]
mod health_challenge_tests {
    use super::health_challenge_response;

    /// `/health` 必须是**挑战应答**，不能只回一个固定串。
    ///
    /// 修复前客户端只看 HTTP 200，而且还把 token 放在请求头里发给尚未验明身份的一方。
    /// 于是本机任意进程抢先占住 127.0.0.1:3037，对任何请求回 200 就能冒充 sidecar，
    /// 接管之后流过去的包括 keyboard.type 的正文（用户密码）、剪贴板、网页正文——
    /// 而这一层能合成真实键鼠，也就是能开终端敲任意命令。
    #[test]
    fn response_depends_on_both_token_and_nonce() {
        let a = health_challenge_response("tok", "n1");
        // 同 token 换 nonce → 不同（否则观察一次应答就能重放）
        assert_ne!(a, health_challenge_response("tok", "n2"), "换了 nonce 应答却不变，可被重放");
        // 同 nonce 换 token → 不同（否则不知道 token 的人也能算出来）
        assert_ne!(a, health_challenge_response("other", "n1"), "换了 token 应答却不变");
        // 稳定可复现（客户端和服务端各算一次要对得上）
        assert_eq!(a, health_challenge_response("tok", "n1"));
        // 就是 SHA-256("tok:n1") 的十六进制，两侧实现必须逐字节一致
        assert_eq!(a.len(), 64, "应当是 32 字节 SHA-256 的十六进制");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // 固定串（冒充者最容易回的那个）绝不可能命中
        assert_ne!(a, "ok");
    }
}

#[cfg(test)]
mod window_list_geometry_tests {
    /// `geometry_real` 必须按**实际数据**判，不能按平台猜。
    ///
    /// 它原来写死 `cfg!(not(target_os = "macos"))`——在 macOS 那条枚举还走
    /// NSWorkspace.runningApplications（应用列表、几何硬写 0）的时候是对的。
    /// 换成 CGWindowListCopyWindowInfo 之后几何是真的了，再硬说「这条路拿不到窗口几何」
    /// 就成了反方向的假话：模型会以为拿不到坐标，转而去做多余的前置 + read_screen。
    /// 实测（重编 sidecar 后真调 window.list）：2 个真窗口、几何真实、note 自动消失。
    #[test]
    fn geometry_availability_is_decided_by_the_data() {
        let src = include_str!("rpc.rs");
        let at = src.find("let geometry_real").expect("geometry_real 不见了");
        let end = src[at..].find("\n            }").map(|e| at + e).unwrap_or(src.len());
        let body: String = src[at..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            body.contains("wins.iter().any(|w| w.width > 0 && w.height > 0)"),
            "又按平台硬判了 —— 枚举修好之后它会反过来说假话"
        );
        assert!(
            !body.contains(r#"cfg!(not(target_os = "macos"))"#),
            "旧的平台判据还在"
        );
        // 那句说明也不能再点名 macOS——它现在描述的是「这一批数据没有矩形」。
        // 只扫**生产代码**：这条断言自己的字符串字面量就是那句话，扫整份文件会自己喂饱自己。
        let whole: String = src
            .split("\n#[cfg(test)]")
            .next()
            .unwrap_or(src)
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !whole.contains("macOS 这条路拿不到窗口几何"),
            "又把「拿不到几何」写死成平台事实了"
        );
    }
}

#[cfg(all(test, feature = "system"))]
mod focus_receipt_tests {
    use super::{focus_bracketed_with, focus_receipt};
    use std::cell::Cell;

    /// 前台必须在**动作之前**就采过一次，而不是只在事后采。
    ///
    /// 修复前 keyboard.type/press/down/up/combo/paste 六条都是动作完成后采一次
    /// frontmost 当 delivered_to：打长文本期间焦点被弹窗抢走又还回来，前半截进了
    /// 别的窗口，事后采到的仍是目标——回执和一次正常输入完全一样。
    #[test]
    fn samples_focus_before_the_action_not_only_after() {
        let calls = Cell::new(0u32);
        let sample = || {
            calls.set(calls.get() + 1);
            Some(if calls.get() == 1 { "目标编辑器" } else { "更新弹窗" }.to_string())
        };
        let v = focus_bracketed_with(&sample, || {
            assert_eq!(calls.get(), 1, "动作开始前必须已经采过一次前台");
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.get(), 2, "动作前后各一次，总共两次");
        assert_eq!(v["status"], "ok");
        assert_eq!(v["focus_before"], "目标编辑器");
        assert_eq!(v["delivered_to"], "更新弹窗");
        assert_eq!(v["focus_changed"], true);
        let hint = v["focus_changed_hint"].as_str().expect("前后不一致必须带可读的说明");
        assert!(hint.contains("目标编辑器") && hint.contains("更新弹窗"), "说明里要点名两个窗口: {hint}");
    }

    #[test]
    fn unchanged_focus_is_reported_as_unchanged_without_a_hint() {
        let v = focus_receipt(Some("A".into()), Some("A".into()));
        assert_eq!(v["status"], "ok");
        assert_eq!(v["focus_before"], "A");
        assert_eq!(v["delivered_to"], "A");
        assert_eq!(v["focus_changed"], false);
        assert!(v.get("focus_changed_hint").is_none(), "没变就别多一句话");
    }

    /// 读不到前台 = 不知道，不能报成 false。
    #[test]
    fn unknown_focus_is_null_not_false() {
        for (b, a) in [(None, Some("A".to_string())), (Some("A".to_string()), None), (None, None)] {
            let v = focus_receipt(b, a);
            assert!(v["focus_changed"].is_null(), "{v}");
            assert!(!v["focus_changed_hint"].as_str().unwrap_or("").is_empty(), "{v}");
        }
    }

    #[test]
    fn a_failed_action_yields_no_receipt() {
        let r = focus_bracketed_with(|| Some("A".into()), || Err(crate::error::Error::System("x".into())));
        assert!(r.is_err());
    }

    /// 六条注入型按键方法都必须走 focus_bracketed，不能有任何一条退回「事后采一次」。
    #[test]
    fn every_keyboard_method_is_focus_bracketed() {
        let src = include_str!("rpc.rs");
        let prod = src.split("\n#[cfg(test)]").next().unwrap_or(src);
        for m in ["keyboard.type", "keyboard.press", "keyboard.down", "keyboard.up", "keyboard.combo", "keyboard.paste"] {
            let pat = format!("\"{m}\" => {{");
            let at = prod.find(&pat).unwrap_or_else(|| panic!("{m} 这条分发不见了"));
            let rest = &prod[at + pat.len()..];
            // 下一条 match 分支从 12 空格缩进的 `"` 或 `_ =>` 或 `#[cfg` 开始
            let end = ["\n            \"", "\n            _ =>", "\n            #[cfg"]
                .iter()
                .filter_map(|p| rest.find(p))
                .min()
                .unwrap_or(rest.len());
            let body: String = rest[..end]
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(body.contains("focus_bracketed("), "{m} 没走前后双采样: {body}");
            assert!(!body.contains("\"delivered_to\": frontmost_now()"), "{m} 又退回只在事后采一次了");
        }
    }
}

#[cfg(test)]
mod replay_context_tests {
    use super::replay_steps;
    use crate::error::Error;
    use serde_json::json;

    /// 第 N 步失败时前 N-1 步的副作用已经落到桌面上；错误必须说清停在哪、已执行几步。
    #[test]
    fn a_mid_replay_failure_names_the_step_and_the_count_already_executed() {
        let steps = vec![
            json!({"method": "a.one", "params": {}}),
            json!({"method": ""}), // 空 method 跳过，不计入已执行
            json!({"method": "b.two", "params": {"x": 1}}),
            json!({"method": "c.three"}),
        ];
        let mut seen = vec![];
        let err = replay_steps(&steps, 0, |m, _p| {
            seen.push(m.to_string());
            if m == "b.two" {
                Err(Error::Other(anyhow::anyhow!("Missing 'y' parameter")))
            } else {
                Ok(json!({"status": "ok"}))
            }
        })
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("第 3/4 步"), "{msg}");
        assert!(msg.contains("b.two"), "{msg}");
        assert!(msg.contains("已执行 1 步"), "{msg}");
        assert!(msg.contains("steps[2..]"), "{msg}");
        assert!(msg.contains("Missing 'y' parameter"), "底层错误不能丢: {msg}");
        assert!(
            msg.find("第 3/4 步").unwrap() < msg.find("Missing 'y'").unwrap(),
            "位置信息要排在底层错误前面——IDE 侧只保留前 300 字: {msg}"
        );
        assert_eq!(seen, vec!["a.one", "b.two"], "失败之后不能继续执行后面的步骤");
    }

    #[test]
    fn a_clean_replay_keeps_the_old_receipt_shape() {
        let steps = vec![json!({"method": "a"}), json!({"method": ""}), json!({"method": "b"})];
        let v = replay_steps(&steps, 0, |_m, _p| Ok(json!({}))).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["replayed"], 2);
    }
}

#[cfg(all(test, feature = "browser"))]
mod browser_receipt_tests {
    use super::{browser_close_receipt, browser_start_receipt, profile_note};
    use crate::agent::{BrowserCloseOutcome, BrowserStartOutcome};
    use crate::browser::{BrowserIdentity, BrowserProfile};

    const ISO_HEADLESS: BrowserIdentity = BrowserIdentity {
        headless: true,
        profile: BrowserProfile::Isolated,
    };
    const SESSION_HEADED: BrowserIdentity = BrowserIdentity {
        headless: false,
        profile: BrowserProfile::Session,
    };

    /// 回执必须描述**跑着的那只**，不能描述这次请求的参数。
    ///
    /// 触发路径是工具描述亲自教的：先用默认 isolated 起过浏览器，撞了登录墙，于是带
    /// profile="session" 再 start 一次。修复前收到的是「持久 profile、登录态可用」，
    /// 而真正在跑的还是那只无 cookie 的隔离实例——接下来每一步都建立在这句假话上。
    #[test]
    fn already_running_describes_the_running_browser_not_the_requested_one() {
        let v = browser_start_receipt(
            BrowserStartOutcome::AlreadyRunning(ISO_HEADLESS),
            SESSION_HEADED,
        );
        assert_eq!(v["profile"], "isolated", "报的是请求的身份，不是跑着的：{v}");
        assert_eq!(v["headless"], true, "headless 同样被吞掉了：{v}");
        assert_eq!(v["already_running"], true, "「这次调用什么都没做」必须是结构化字段");
        // 参数没生效时才回显请求值，好让调用方看出差在哪。
        assert_eq!(v["requested_profile"], "session");
        assert_eq!(v["requested_headless"], false);

        let note = v["note"].as_str().expect("note");
        assert!(
            note.contains(profile_note(BrowserProfile::Isolated)),
            "没有描述真正在跑的那套身份: {note}"
        );
        assert!(
            !note.contains(profile_note(BrowserProfile::Session)),
            "又在描述一套根本没在跑的身份: {note}"
        );
        assert!(
            note.contains("browser.close"),
            "没给出路——模型只会一遍遍再 start，那正是它出不来的那个环: {note}"
        );
    }

    /// 请求和实际一致时不回显请求值（没有差异可说），但仍要说清这次没做任何事。
    #[test]
    fn a_matching_already_running_call_still_says_it_changed_nothing() {
        let v = browser_start_receipt(
            BrowserStartOutcome::AlreadyRunning(SESSION_HEADED),
            SESSION_HEADED,
        );
        assert_eq!(v["already_running"], true);
        assert_eq!(v["profile"], "session");
        assert_eq!(v["headless"], false);
        assert!(v.get("requested_profile").is_none(), "没有差异就别多两个字段: {v}");
        assert!(v.get("requested_headless").is_none(), "{v}");
    }

    #[test]
    fn a_fresh_start_reports_what_it_started_and_claims_nothing_else() {
        let v = browser_start_receipt(BrowserStartOutcome::Started(SESSION_HEADED), SESSION_HEADED);
        assert_eq!(v["status"], "ok");
        assert_eq!(v["profile"], "session");
        assert_eq!(v["headless"], false);
        assert!(v.get("already_running").is_none(), "{v}");
        assert!(v.get("restarted").is_none(), "{v}");
        assert_eq!(
            v["note"].as_str().unwrap(),
            profile_note(BrowserProfile::Session),
            "全新启动时 note 就该只有那套身份的说明"
        );
    }

    /// 死浏览器被换掉这件事必须看得见：否则「重启」和「什么都没做」在回执里一模一样。
    #[test]
    fn a_restart_after_a_dead_browser_is_visible() {
        let v = browser_start_receipt(BrowserStartOutcome::Restarted(ISO_HEADLESS), ISO_HEADLESS);
        assert_eq!(v["restarted"], true, "{v}");
        assert!(v.get("already_running").is_none(), "重启不是「已在运行」: {v}");
        assert_eq!(v["profile"], "isolated");
        assert_eq!(v["headless"], true);
    }

    /// 全组合扫一遍：任何一条回执都不许描述一套没在跑的身份。
    #[test]
    fn no_receipt_ever_describes_a_profile_that_is_not_running() {
        let ids = [
            ISO_HEADLESS,
            SESSION_HEADED,
            BrowserIdentity::new(false, BrowserProfile::Isolated),
            BrowserIdentity::new(true, BrowserProfile::Session),
        ];
        for actual in ids {
            for requested in ids {
                for outcome in [
                    BrowserStartOutcome::Started(actual),
                    BrowserStartOutcome::AlreadyRunning(actual),
                    BrowserStartOutcome::Restarted(actual),
                ] {
                    let v = browser_start_receipt(outcome, requested);
                    assert_eq!(v["profile"], super::profile_name(actual.profile), "{v:?}");
                    assert_eq!(v["headless"], actual.headless, "{v:?}");
                    let note = v["note"].as_str().expect("note");
                    let other = match actual.profile {
                        BrowserProfile::Session => BrowserProfile::Isolated,
                        BrowserProfile::Isolated => BrowserProfile::Session,
                    };
                    assert!(note.contains(profile_note(actual.profile)), "{note}");
                    assert!(!note.contains(profile_note(other)), "{note}");
                }
            }
        }
    }

    /// 本来就没浏览器 ≠ 关掉了一个。
    #[test]
    fn closing_nothing_is_not_reported_as_a_close() {
        let v = browser_close_receipt(BrowserCloseOutcome::NotRunning);
        assert_eq!(v["was_running"], false);
        assert!(v.get("flushed").is_none(), "什么都没关，flushed 无从谈起: {v}");
    }

    /// 强杀（没等到进程自己退出）和干净关闭必须能分开。
    ///
    /// 修复前两者都是 {"status":"ok"}：持久 profile 的 cookie 没落盘这件事完全不可见，
    /// 要到下一次运行才以「怎么又要登录」的形式冒出来。
    #[test]
    fn a_killed_browser_is_not_reported_like_a_clean_close() {
        let clean = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: Some(SESSION_HEADED),
            flushed: true,
        });
        let killed = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: Some(SESSION_HEADED),
            flushed: false,
        });
        assert_eq!(clean["flushed"], true);
        assert_eq!(killed["flushed"], false);
        assert_eq!(clean["was_running"], true);
        assert_eq!(killed["was_running"], true);
        assert_eq!(clean["profile"], "session");
        assert_ne!(clean["note"], killed["note"], "两种结局说了同一句话");
    }

    /// 隔离 profile 被强杀无所谓（本来就要丢），持久 profile 被强杀是丢登录态。
    /// 两者说的不能是同一句。
    #[test]
    fn a_throwaway_profile_and_a_persistent_one_do_not_share_the_kill_note() {
        let iso = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: Some(ISO_HEADLESS),
            flushed: false,
        });
        let sess = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: Some(SESSION_HEADED),
            flushed: false,
        });
        assert_eq!(iso["profile"], "isolated");
        assert_ne!(iso["note"], sess["note"]);
    }

    /// 连身份都读不出来时按最坏情况说话——漏报「登录可能没了」比多验一次贵得多。
    #[test]
    fn an_unknown_identity_is_treated_as_the_worst_case() {
        let unknown = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: None,
            flushed: false,
        });
        let persistent = browser_close_receipt(BrowserCloseOutcome::Closed {
            identity: Some(SESSION_HEADED),
            flushed: false,
        });
        assert!(unknown.get("profile").is_none(), "不知道就别编一个: {unknown}");
        assert_eq!(unknown["flushed"], false);
        assert_eq!(unknown["note"], persistent["note"], "身份不明时必须按持久 profile 报警");
    }

    /// browser.start 那条分发不许再自己拿 params 编 profile / note。
    ///
    /// 这是「假回执」的原始形状：`if profile == Session { "Persistent profile…" }`。
    /// 只要它还在，前面所有单元测试都可以照样绿，而线上回执照旧说反。
    #[test]
    fn the_start_arm_builds_its_receipt_from_the_outcome_not_from_the_params() {
        let src = include_str!("rpc.rs");
        let prod = src.split("\n#[cfg(test)]").next().unwrap_or(src);
        let pat = "\"browser.start\" => {";
        let at = prod.find(pat).expect("browser.start 这条分发不见了");
        let rest = &prod[at + pat.len()..];
        let end = ["\n            \"", "\n            _ =>", "\n            #[cfg"]
            .iter()
            .filter_map(|p| rest.find(p))
            .min()
            .unwrap_or(rest.len());
        let body: String = rest[..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            body.contains("browser_start_receipt("),
            "回执又不是从 outcome 生成的了: {body}"
        );
        assert!(
            !body.contains("Persistent profile"),
            "又在这条分发里按请求参数编 note 了: {body}"
        );
    }
}
