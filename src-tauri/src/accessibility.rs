//! macOS-only: read the frontmost app's interactive UI elements via the System
//! Events accessibility API, driven through `osascript` (JavaScript for
//! Automation). No unsafe FFI and no extra crates — the Rust side is just a
//! bounded subprocess + JSON parse, so it compiles and is checkable everywhere.
//!
//! Best-effort and TIME-BOUNDED: if Accessibility permission is off, the app
//! doesn't expose a tree, or enumeration is slow, it returns nothing and the
//! caller falls back to the coordinate grid (no regression, never hangs).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct AccessibilityTarget {
    pid: i64,
    #[serde(default)]
    name: String,
}

/// 前台窗口里那块网页的加载状态。路线 B（操作用户自己那个浏览器）原本没有任何
/// 「页面加载完了没有」的信号——可访问性树只反映**此刻**渲染出来的东西，页面还在
/// 加载时读到的就是半个页面。模型看不出区别，于是把「还没渲染出来」当成「这页
/// 没有这个按钮」，然后基于这句假话往下决策。
#[derive(Debug, Clone, Default, Deserialize)]
struct PageState {
    #[serde(default)]
    title: String,
    #[serde(default)]
    loaded: bool,
    #[serde(default)]
    progress: f64,
}

#[derive(Debug, Default, Deserialize)]
struct UiSnapshot {
    target: Option<AccessibilityTarget>,
    elements: Vec<UiElement>,
    /// 前台是浏览器时才有；见 PageState。
    #[serde(default)]
    page: Option<PageState>,
    /// 这次**读取本身**为什么没完成（超时 / 起不来 / 输出不是合法 JSON）。
    ///
    /// 没有这个字段之前，三种失败都返回一个空快照，然后被下游断言成「权限没问题，
    /// 这个 app 就是不暴露辅助功能树，重试没有意义」——而超时恰恰是复杂界面最常见的
    /// 结果，重试或先把窗口切到前台往往就成了。模型被明确告知「重试没用」，于是转去
    /// OCR 拿一堆不可操作的坐标，然后基于「这个界面没有可点的元素」做后续决定。
    read_error: Option<String>,
    /// 快路顺路带回的标注截图（data URL）与它的几何：只有调用方要图、且 sidecar 出了图时才有。
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    image_meta: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct AxElementSignature {
    role: String,
    text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    value: String,
    enabled: bool,
}

impl From<&UiElement> for AxElementSignature {
    fn from(element: &UiElement) -> Self {
        Self {
            role: element.role.clone(),
            text: element.text.clone(),
            x: element.x,
            y: element.y,
            w: element.w,
            h: element.h,
            value: element.value.clone(),
            enabled: element.enabled,
        }
    }
}

#[derive(Clone, Debug)]
struct AxRefBinding {
    raw_ref: u32,
    signature: AxElementSignature,
    /// 这个 ref 是**哪条读屏路**发的。两条路的编号语义根本不同，动作必须走回同一条：
    ///   · 快路（sidecar screen.elements）：raw_ref 是句柄表的编号，1 起步，深度优先序。
    ///   · 老路（JXA）：raw_ref 是重排后数组的下标，0 起步，按控件类型分四桶重排。
    /// 拿快路的号去老路取，差的不止一位——两份清单的顺序压根不是一回事，取回来的
    /// 几乎必然是另一个元素，然后被签名校验拒掉，回一句「界面变了，重新读」的假话。
    native: bool,
}

#[derive(Default)]
struct AxRefState {
    target: Option<AccessibilityTarget>,
    refs: std::collections::HashMap<u32, AxRefBinding>,
}

static LATEST_AX_REFS: once_cell::sync::Lazy<std::sync::Mutex<AxRefState>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(AxRefState::default()));
static NEXT_AX_REF: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn clear_latest_ax_refs() -> Result<(), String> {
    let mut latest = LATEST_AX_REFS
        .lock()
        .map_err(|_| "accessibility target state is unavailable".to_string())?;
    *latest = AxRefState::default();
    Ok(())
}

fn install_ax_snapshot(snapshot: &mut UiSnapshot, native: bool) -> Result<(), String> {
    let mut latest = LATEST_AX_REFS
        .lock()
        .map_err(|_| "accessibility target state is unavailable".to_string())?;
    *latest = AxRefState::default();
    let Some(target) = snapshot.target.clone() else {
        return Ok(());
    };
    for element in &mut snapshot.elements {
        let binding = AxRefBinding {
            raw_ref: element.ref_,
            signature: AxElementSignature::from(&*element),
            native,
        };
        let opaque_ref = loop {
            let candidate = NEXT_AX_REF.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if candidate != 0 && !latest.refs.contains_key(&candidate) {
                break candidate;
            }
        };
        element.ref_ = opaque_ref;
        latest.refs.insert(opaque_ref, binding);
    }
    latest.target = Some(target);
    Ok(())
}

// 两个平台共用：macOS 走 AX，Windows 走 UI Automation，但"ref 是谁"这件事
// 由同一张表回答。Windows 侧以前根本不查表（直接把 ref 当索引传下去），
// 于是元素在两次调用之间变了也无从发现。
fn resolve_ax_ref(reference: u32) -> Result<(AxRefBinding, AccessibilityTarget), String> {
    let latest = LATEST_AX_REFS
        .lock()
        .map_err(|_| "accessibility target state is unavailable".to_string())?;
    let target = latest.target.clone().ok_or_else(|| {
        "no actionable accessibility snapshot; run read_screen for the current foreground app"
            .to_string()
    })?;
    let binding =
        latest.refs.get(&reference).cloned().ok_or_else(|| {
            "stale or unknown accessibility ref; run read_screen again".to_string()
        })?;
    Ok((binding, target))
}

fn default_true() -> bool {
    true
}

/// One UI element from the accessibility tree, positions in SCREEN POINTS
/// (top-left origin). The caller maps these into the screenshot's space.
#[derive(Debug, Deserialize, Serialize)]
pub struct UiElement {
    #[serde(rename = "ref")]
    pub ref_: u32,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ReadScreenResponse {
    pub source: String,
    pub elements: Vec<UiElement>,
    pub limitations: Vec<String>,
    /// 标注截图（data URL）：红框编号 = 上面元素的 ref。没图时整个字段不出现。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// 图的几何（image_px / points_origin / points_per_image_px / marks…），或没出图的结构化原因（occluded）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_meta: Option<serde_json::Value>,
}

/// Read the frontmost application's accessibility tree. OCR is an explicit
/// fallback for self-drawn interfaces; OCR refs are informational because they
/// do not correspond to an accessibility node that can receive AX actions.
/// 走 sidecar 的原生 AX 快照。失败就返回 None，让调用方退回 JXA 那条。
///
/// 为什么值得多这一跳：JXA 每读一个属性就是一次 Apple Event 往返，实测本机一个真实
/// 窗口下 500 个元素要 **95 秒**，而这里的上限是 6 秒——在任何真实应用上都必然超时，
/// 用户看到的就是「读屏一直超时、智能体在发呆」。原生那条同一批 500 个元素 **184 毫秒**，
/// 而且网页内容照样在（WebArea、按钮、正文都读得到）。
/// 读屏 / 操作的目标应用。两个字段都不给就是「最前面那个」——九成的用法。
///
/// **为什么要有这个**：read_screen 和 ui_click 原来都硬绑前台应用。于是「一边看着
/// 参考资料一边操作另一个窗口」这种最普通的桌面任务做不了，而且智能体自己干活时
/// 前台往往就是 Mr. Day One，读回来的是自己。
#[derive(Debug, Clone, Default)]
pub struct AxTarget {
    pub pid: Option<i64>,
    pub app: Option<String>,
}

impl AxTarget {
    fn is_explicit(&self) -> bool {
        self.pid.map(|p| p > 0).unwrap_or(false)
            || self.app.as_deref().map(|a| !a.trim().is_empty()).unwrap_or(false)
    }
    fn describe(&self) -> String {
        match (self.pid, self.app.as_deref()) {
            (Some(p), _) if p > 0 => format!("pid {p}"),
            (_, Some(a)) if !a.trim().is_empty() => format!("名字含「{}」的应用", a.trim()),
            _ => "最前面的应用".to_string(),
        }
    }
}

/// 把 app 名字解析成 pid，让下游只需要处理一种目标形态。
///
/// 名字→pid 有两个可能的解析者（sidecar 的 `pid_of` 用子串匹配，JXA 这条也用子串），
/// **必须用同一条规则**：否则读屏解析到 A、动作解析到 B，签名校验会过（元素长得一样），
/// 点中的却是另一个应用的同名按钮。所以这里统一在 Tauri 层解析一次，
/// 往下一律只传 pid。
#[cfg(target_os = "macos")]
async fn resolve_target_pid(target: &AxTarget) -> Result<Option<i64>, String> {
    if let Some(p) = target.pid {
        if p > 0 {
            return Ok(Some(p));
        }
    }
    let Some(name) = target.app.as_deref().map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(None); // 前台
    };
    // 快路：sidecar 的 app.resolve —— 进程内 NSWorkspace，毫秒级，显示名 / 可执行名 / bundle id /
    // **窗口标题**一次全认，找不到时把屏幕上有窗口的应用列回来。下面那条 JXA 老路要枚举 System
    // Events 的全部进程（每个 4 次 Apple Event），本机 300 个进程时 4 秒必超时——所有者今天那次
    // 「解析应用名「Electron」超时」就是它。老路只在 sidecar 起不来时兜底。
    match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        crate::automation::automation_call("app.resolve".into(), serde_json::json!({ "name": name })),
    )
    .await
    {
        Ok(Ok(v)) => {
            if let Some(pid) = v.get("pid").and_then(|p| p.as_i64()).filter(|p| *p > 0) {
                return Ok(Some(pid));
            }
        }
        // sidecar 真找过了（回的是「没有找到…」这种业务错误）：原话交回去，里面带候选名单。
        Ok(Err(e)) if e.contains("没有找到") => return Err(e),
        _ => {}
    }
    // 三种名字都要认，因为它们**互不相同**而且模型只知道其中一种：
    //   · System Events 的 name() 给的是可执行名（Finder / WeChat）
    //   · 用户屏幕上看到的是 localizedName（访达 / 微信）——中文系统上和上面完全不同
    //   · bundle id（com.apple.finder）是最稳的一种，模型有时会给它
    // 只认第一种的话，在中文系统上用户说「访达」永远找不到；只认第二种的话，
    // 模型说「Finder」永远找不到。实测本机两边都会发生。
    let script = format!(
        r##"(function(){{
  try {{
    var want = {};
    var lw = want.toLowerCase();
    var se = Application('System Events');
    var ps = se.applicationProcesses();
    var exact = null, sub = null, names = [];
    for (var i=0;i<ps.length;i++) {{
      var n=''; try{{n=String(ps[i].name()||'');}}catch(e){{continue;}}
      var pid=0; try{{pid=Number(ps[i].unixId());}}catch(e){{}}
      if(!isFinite(pid)||pid<=0) continue;
      var d=''; try{{d=String(ps[i].displayedName()||'');}}catch(e){{}}
      var b=''; try{{b=String(ps[i].bundleIdentifier()||'');}}catch(e){{}}
      // 只把「有窗口的」列进候选名单：几十个后台守护进程对模型毫无用处，
      // 而它拿这份名单是为了重发一次调用。
      var hasWin=false; try{{hasWin=ps[i].windows.length>0;}}catch(e){{}}
      if(hasWin && names.length<14) names.push(d && d!==n ? (n+'（'+d+'）') : n);
      if(n===want || d===want) {{ exact={{pid:pid,name:n}}; break; }}
      if(!sub && (n.toLowerCase().indexOf(lw)>=0 || d.toLowerCase().indexOf(lw)>=0
                  || (b && b.toLowerCase().indexOf(lw)>=0))) sub={{pid:pid,name:n}};
    }}
    var hit = exact || sub;
    return JSON.stringify(hit ? {{ok:true,pid:hit.pid,name:hit.name}} : {{ok:false,names:names}});
  }} catch(e) {{ return JSON.stringify({{ok:false,err:String(e)}}); }}
}})()"##,
        serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into())
    );
    let out = run_osa(&script, 4000)
        .ok_or_else(|| format!("解析应用名「{name}」超时或没有辅助功能权限"))?;
    let v: serde_json::Value = serde_json::from_str(&out)
        .map_err(|e| format!("解析应用名「{name}」时返回的不是合法 JSON: {e}"))?;
    if v.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(v.get("pid").and_then(serde_json::Value::as_i64).filter(|p| *p > 0));
    }
    // 找不到就**报错**，绝不悄悄退回读前台：那会让模型以为读的是 A，
    // 实际读的是别的应用，然后基于这份内容去点。
    //
    // 报错时把**当前有窗口的应用名**一并给出来。只说一句「没找到，去 window.list 看」
    // 是在把一次可以当场纠正的失败变成两个来回，而且 window.list 只列**屏幕上**的窗口，
    // 后台应用（实测 Finder 就不在里面）根本不会出现——照它给的名单找会二次落空。
    let candidates = v
        .get("names")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    Err(if candidates.is_empty() {
        format!("没有找到名字里含「{name}」的运行中应用。给 pid 更准。")
    } else {
        format!(
            "没有找到名字里含「{name}」的运行中应用。当前有窗口的是：{candidates}。\
             名字三种写法都认（可执行名 Finder / 屏幕上的名字 访达 / bundle id com.apple.finder），挑一个重发，或者直接给 pid。"
        )
    })
}

#[cfg(not(target_os = "macos"))]
async fn resolve_target_pid(target: &AxTarget) -> Result<Option<i64>, String> {
    // **给了 app 却按名字找不到，必须硬报错，不能静默忽略。**
    // 上一版直接 `Ok(target.pid.filter(...))` —— app 参数整个被丢掉，然后底层无条件读
    // **前台窗口**（很可能就是 IDE 自己）。macOS 那一支同样的调用是硬报错，
    // 而这里返回的是一个「看起来完全正常的错误答案」：回执里连目标名字都不出现，
    // 模型无从察觉，接着就拿这批元素去 ui_click —— 点在另一个应用上。
    // 宁可让它响地失败，也不要给一份安静的假数据。
    if target.pid.filter(|p| *p > 0).is_none() {
        if let Some(name) = target.app.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // 补救必须**真的能清掉这条错**。上一版写的是「先 activate 再读，或者直接传 pid」——
            // 两条都走不通：再发一次同样的调用命中同一个 if、报同一条错，构成确定性重试死循环；
            // 而 pid 这条路上 read_ui_snapshot 在非 mac 平台的签名就是 `_pid: Option<i64>`，
            // 参数被下划线丢掉，且 system windows / system_app_windows 两个出口都只给标题
            // 和进程名、不给 pid —— 模型根本拿不到它。
            // 唯一能执行的那条是「切到前台之后**不带 app 参数**重发」。
            return Err(format!(
                "这个平台上不能按名字（「{name}」）定位窗口，只能读**当前前台窗口**。\
                 请先用 system 的 focus/open 把「{name}」切到前台，然后**去掉 app 参数**\
                 重发一次 read_screen —— 带着 app 重发会撞同一条错。"
            ));
        }
    }
    Ok(target.pid.filter(|p| *p > 0))
}

#[cfg(target_os = "macos")]
async fn native_snapshot_via_sidecar(pid: Option<i64>, want_image: bool) -> Option<UiSnapshot> {
    let mut args = serde_json::json!({ "cap": 500 });
    if let Some(p) = pid.filter(|p| *p > 0) {
        args["pid"] = serde_json::json!(p);
    }
    if want_image {
        args["max_side"] = serde_json::json!(1280);
    }
    // 快路也要自带上限，理由和动作那条一样：automation_call 的 HTTP 客户端给的是
    // **120 秒**（为 browser.* 等页面准备的）。读一棵树是百毫秒级的事，真等到几十秒
    // 只意味着 sidecar 排在别的调用后面——而 sidecar 是单线程串行的，一次 browser.goto
    // 最坏能占住一分钟。没有这一层，一次读屏会把整个智能体循环挂住两分钟。
    //
    // 超时按「快路没跑成」处理，自动落回 JXA 老路——那条路自己有 6 秒预算，
    // 而且它是独立的 osascript 子进程，不排 sidecar 这条队。
    const READ_BUDGET: std::time::Duration = std::time::Duration::from_secs(8);
    let call = |method: &str, args: serde_json::Value| {
        tokio::time::timeout(READ_BUDGET, crate::automation::automation_call(method.to_string(), args))
    };
    // 要图就走 screen.marked：同一棵树、同一批 ref，外加一张按 ref 编号的标注截图。
    // 老 sidecar 没有这个方法，退回 screen.elements——树照样有，只是没图。
    let out = if want_image {
        match call("screen.marked", args.clone()).await.ok()? {
            Ok(v) => v,
            Err(_) => call("screen.elements", args).await.ok()?.ok()?,
        }
    } else {
        call("screen.elements", args).await.ok()?.ok()?
    };
    let arr = out.get("elements")?.as_array()?;
    let pid = out.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
    if pid <= 0 {
        return None;
    }
    let name = out
        .get("app")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let mut elements = Vec::with_capacity(arr.len());
    for (i, e) in arr.iter().enumerate() {
        elements.push(UiElement {
            // 序号要和 sidecar 那边发出来的 ref 对上（它从 1 开始）：动作是按这个号
            // 回到句柄表里找元素的，错一位就点到别的东西上。
            ref_: i as u32 + 1,
            role: e.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            text: e.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            x: e.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
            y: e.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            w: e.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0),
            h: e.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0),
            value: e.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            enabled: e.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        });
    }
    Some(UiSnapshot {
        target: Some(AccessibilityTarget { pid, name }),
        elements,
        // 前台是浏览器时 sidecar 会顺路带回 AXWebArea 的加载状态。
        // 这里原来硬写 None——于是「页面还在加载」那条提醒在快路上结构性失效，
        // 而快路是 macOS 的默认路：模型读到半渲染的页面，却收不到任何提示，
        // 于是把「还没渲染出来」当成「这页没有这个按钮」。
        page: out.get("page").and_then(|v| serde_json::from_value(v.clone()).ok()),
        read_error: None,
        image: out.get("image").and_then(|v| v.as_str()).map(str::to_string),
        image_meta: {
            let mut meta = serde_json::Map::new();
            for k in ["image_px", "points_origin", "points_per_image_px", "points_size", "coordinate_space", "marks", "marks_hidden", "occluded", "screen_locked"] {
                if let Some(v) = out.get(k) {
                    meta.insert(k.to_string(), v.clone());
                }
            }
            if meta.is_empty() { None } else { Some(serde_json::Value::Object(meta)) }
        },
    })
}

#[cfg(not(target_os = "macos"))]
async fn native_snapshot_via_sidecar(_pid: Option<i64>, _want_image: bool) -> Option<UiSnapshot> {
    None
}

#[tauri::command]
pub async fn read_screen(
    ocr: Option<bool>,
    app: Option<String>,
    pid: Option<i64>,
    image: Option<bool>,
) -> Result<ReadScreenResponse, String> {
    let use_ocr = ocr.unwrap_or(false);
    // 要不要顺路带一张按 ref 编号的标注截图。OCR 路径本来就是拍像素，没有这一说。
    let want_image = image.unwrap_or(false) && !use_ocr;
    let target = AxTarget { pid, app };
    let target_explicit = target.is_explicit();
    // 名字在这里就解析成 pid，往下一律只有 pid：读和点必须用**同一条**解析规则，
    // 否则读屏解析到 A、动作解析到 B，签名校验还会过（同名按钮长得一样）。
    // OCR 那条诊断必须排在 resolve_target_pid **之前**。它在后面的话，非 mac 平台上
    // 「ocr=true + app=…」会先撞上下面那条「不能按名字定位」的错，模型拿到的是一条
    // 和它真正问题无关的诊断（它的问题是 OCR 压根不支持指定目标）。
    // OCR 拍的是屏幕像素，压根没有"目标应用"这个概念——它只能拍最前面那个。
    // 静默忽略 app/pid 会让模型以为自己 OCR 了后台窗口，然后基于别的应用的文字往下做。
    if use_ocr && target_explicit {
        return Err(format!(
            "ocr=true 读的是屏幕像素，只能覆盖最前面那个窗口，没法指定{}。要么去掉 app/pid 用 OCR 读前台，要么去掉 ocr 用可访问性树读指定应用。",
            target.describe()
        ));
    }
    let target_pid = resolve_target_pid(&target).await?;
    // Invalidate old refs before starting a new read. A failed or concurrent read
    // must never leave a ref from an older foreground process actionable.
    clear_latest_ax_refs()?;
    // 先走**原生 AX**（sidecar 里的 screen.elements）。
    //
    // JXA 每读一个属性就是一次 Apple Event 往返：实测本机一个真实 Chrome 窗口，
    // 只读 500 个元素的 5 个属性就要 **95 秒**，而这里的上限是 6 秒——也就是说在任何
    // 真实应用上它必然超时。原生那条同一棵树 **106 毫秒**，还照样看得到网页内容
    // （WebArea、链接、按钮、正文都在）。
    //
    // JXA 那条留着兜底：sidecar 没起来、权限没给、或者哪天原生这条读回空的时候，
    // 至少还有一条路，而不是直接把「读不到」交给模型。
    //
    // 快路产出的是**同一个 UiSnapshot 结构**，然后走完全相同的下游：装 ref 表、
    // 拼限制说明。绝不能在这里提前 return——ui_click 靠 install_ax_snapshot 记下的
    // pid 和元素签名来定位，跳过它等于把「按 ref 操作」整条功能弄坏。
    let fast = if use_ocr { None } else { native_snapshot_via_sidecar(target_pid, want_image).await };
    // 走没走成快路，决定了这批 ref 的编号语义，也决定了 ui_click 该往哪条路发动作。
    // 判据必须和下面那个 match 的条件**逐字一致**：读回空清单时会落回老路，
    // 那种情况下 ref 是 JXA 的下标，按快路发就点错元素了。
    let native_refs = fast.as_ref().is_some_and(|s| !s.elements.is_empty());
    let mut snapshot = match fast {
        Some(s) if !s.elements.is_empty() => s,
        _ => tauri::async_runtime::spawn_blocking(move || {
            if use_ocr {
                UiSnapshot {
                    target: None,
                    elements: read_ocr_elements(),
                    page: None, // OCR 看的是像素，读不到网页的加载状态
                    read_error: None, // OCR 路径不经过 AX 读取，没有「读取没完成」这回事
                    ..Default::default()
                }
            } else {
                read_ui_snapshot(target_pid)
            }
        })
        .await
        .map_err(|error| format!("screen reader task failed: {error}"))?,
    };
    // 指定了目标，就必须**确认读回来的真是它**。
    //
    // 两条读取路径都有可能悄悄给回前台那个：sidecar 拿不到目标时会回落，JXA 的
    // whose() 查不到就返回空 procs（于是 target 为 None）。任何一种情况下把结果照发，
    // 模型都会以为自己读的是指定的那个应用，然后拿这些 ref 去点——点中的是别人。
    // 身份对不上宁可报错。
    if let Some(want) = target_pid {
        match snapshot.target.as_ref() {
            Some(t) if t.pid == want => {}
            Some(t) => {
                return Err(format!(
                    "要读的是 pid {want}，实际读到的是「{}」(pid {})——没有按目标读，结果已丢弃。目标窗口可能已经退出，或那个应用不暴露可访问性树。",
                    t.name, t.pid
                ));
            }
            None if !snapshot.elements.is_empty() => {
                return Err(format!(
                    "读到了元素但认不出是哪个应用，无法确认就是 pid {want}——结果已丢弃，不给你可能点错对象的 ref。"
                ));
            }
            None => {}
        }
    }
    let image = snapshot.image.take();
    let image_meta = snapshot.image_meta.take();
    install_ax_snapshot(&mut snapshot, native_refs)?;
    let elements = snapshot.elements;

    let mut limitations = Vec::new();
    if use_ocr {
        limitations.push(
            "OCR text boxes are observations, not actionable AX refs; use their coordinates only through an explicitly approved automation action."
                .into(),
        );
        // 明说读的是哪一块。收窄到前台窗口后，"没读到某段文字"往往是因为它在别的窗口
        // 里，而不是 OCR 失败——不写清楚会让模型反复重试同一个 read_screen。
        limitations.push(
            "OCR covers the frontmost window only — never the whole screen. Menu bar, dock, and background windows are excluded, and if the frontmost app has no ordinary window the result is empty rather than a whole-screen capture. Coordinates are global screen points."
                .into(),
        );
    }
    if elements.is_empty() {
        // 以前这里把「辅助功能」和「屏幕录制」并列念一遍就完事。两个问题：AX 树这条路
        // 根本用不到屏幕录制，把它写进来会把用户引到错的那一页去查（实际发生过）；而且
        // 权限到底缺不缺是可以问系统的，不该让用户去猜。现在先问 API 再说话。
        let ax = crate::permissions::accessibility_granted();
        let ae = crate::permissions::apple_events_granted();
        if !ax || !ae {
            limitations.push(format!(
                "Blocked by a missing macOS permission — this is NOT about Screen Recording (reading the UI tree captures no pixels). Reading an app's UI tree needs Accessibility AND Automation (Apple Events → System Events). {}",
                crate::permissions::advice_text(ax, true, ae, crate::permissions::identity_pinned_to_build())
            ));
        } else if let Some(reason) = snapshot.read_error.as_deref() {
            // 读取本身没完成 ≠ 这个 app 没有辅助功能树。
            //
            // 超时、osascript 起不来、输出不是合法 JSON——三种失败原来都返回空快照，然后
            // 落到下面那段「权限没问题，就是不暴露 AX 树，重试没有意义」。而超时恰恰是复杂
            // 界面最常见的结果，重试或先把目标窗口切到前台往往就成了。模型被明确告知
            // 「重试没用」，于是转去 OCR 拿一堆不可操作的坐标，再基于「这个界面没有可点的
            // 元素」做后续决定——整条链建立在一句假话上。
            limitations.push(format!(
                "The UI-tree read DID NOT COMPLETE ({reason}). This says NOTHING about whether the app exposes an accessibility tree, and it is NOT a permission problem. Bring the target window to the front (system open / window.activate) and call read_screen again — a retry often succeeds on complex UIs. Do NOT switch to ocr=true on this basis, and do not conclude the app has no clickable elements."
            ));
        } else {
            // 权限齐全时空结果通常另有原因，而且是很具体的一个：这里读的是**前台**应用，
            // 而 agent 干活时前台往往就是 Mr. Day One 自己（WebView 内容对 AX 不可见）。
            // 不写清楚，模型会把它当权限问题反复上报。
            limitations.push(
                format!(
                    "No elements were returned, and permissions ARE granted — so this is not a permission problem. Two ordinary causes: (1) read_screen reads the FRONTMOST app, which is often Mr. Day One itself — bring the target to the front first with system open / window.activate, then read again; (2) the app draws its own UI and exposes no accessibility tree (games, Electron canvases, remote desktops) — {}. Retrying the same call unchanged will not help.",
                    // 两处平台差异，都会让这句建议变成假话：
                    //  · 已经在 ocr 里读空的时候，再建议「用 ocr=true」等于建议它用正在用的那个；
                    //  · OCR 只有 macOS 有实现，非 macOS 上它恒返回空——把模型指过去等于送进死路。
                    if use_ocr && !cfg!(target_os = "macos") {
                        // 这里以前和 macOS 共用一句「OCR 也读空了，所以屏幕上没有文字」。
                        // 在非 macOS 上 read_ocr_elements() 是个恒返回空 Vec 的实现——
                        // 空结果跟屏幕上有没有字毫无关系。模型据此断定「这个界面没有可读的
                        // 内容」，然后放弃整条任务，而真实原因只是这个平台没写 OCR。
                        "there is NO OCR implementation on this platform — ocr=true returned empty because nothing ran, not because the screen is blank. Use computer's screen.capture to look at the real pixels instead"
                    } else if use_ocr {
                        "OCR also came back empty, so there is no text on screen to read either — this is not something a different flag fixes"
                    } else if cfg!(target_os = "macos") {
                        "read it with ocr=true instead"
                    } else {
                        "there is no OCR fallback on this platform — use computer's screen.capture to look at the real pixels instead"
                    }
                ),
            );
        }
    } else if !use_ocr {
        // 实测过的事实，不是猜的：浏览器把可访问性几何裁到可见区，折叠以下的内容
        // 要么不出现，要么被压扁成零高度容器（然后被尺寸过滤掉）——所以这份清单等于
        // 「这一屏上有什么」，不等于「这个页面有什么」。
        //
        // 不说清楚，模型读完没找到目标按钮，就会断言这页没有这个功能，然后基于这句
        // 假话往下做决定。它其实只需要滚一下再读一次。
        limitations.push(
            "This is the frontmost window's CURRENTLY VISIBLE area — an accessibility tree reports what is on screen, not the whole document. In a browser or any scrollable view, anything below the fold is simply absent from this list. So \"the element I need is not here\" usually means \"it has not been scrolled into view\", NOT \"it does not exist\": scroll and read again before concluding a control is missing."
                .into(),
        );
        // 前台是浏览器时，把「这一屏是在页面的哪个阶段读到的」说出来。可访问性树
        // 反映的是**此刻**渲染出来的东西：页面还在加载，读到的就是半个页面，而它
        // 和一个加载完的短页面长得一模一样。不说，模型就会把「还没渲染出来」当成
        // 「这页没有这个按钮」。
        if let Some(pg) = snapshot.page.as_ref() {
            if !pg.loaded || pg.progress < 1.0 {
                limitations.push(format!(
                    "这一屏是在网页**还没加载完**的时候读到的（进度 {:.0}%{}）。现在找不到的元素很可能只是还没渲染出来 —— 等一下再 read_screen 一次，别据此断定页面上没有它。",
                    pg.progress * 100.0,
                    if pg.title.is_empty() { String::new() } else { format!("，页面「{}」", pg.title) }
                ));
            } else if !pg.title.is_empty() {
                limitations.push(format!("读到的是已经加载完成的网页「{}」。", pg.title));
            }
        }
        // 截断必须说出来。500 上限静默生效时，一份被砍掉一半的清单看起来和一份完整的
        // 清单一模一样，模型没有任何办法察觉自己看到的是残缺的。
        if elements.len() >= 500 {
            limitations.push(format!(
                "The element list hit its {} cap and WAS TRUNCATED — what you see is not everything this window exposes. Interactive controls are kept first and plain text is dropped first, so a missing label may still be on screen. Narrow the view (scroll to the region you care about) and read again rather than assuming the rest is empty.",
                elements.len()
            ));
        }
    }
    Ok(ReadScreenResponse {
        source: if use_ocr {
            "screen_ocr"
        } else {
            "accessibility_tree"
        }
        .into(),
        elements,
        limitations,
        image,
        image_meta,
    })
}

/// 只看一眼屏幕上有什么文字/控件，**不发 ref、也不作废任何 ref**。
///
/// 这是 background_monitor 的 `screen` 检查类型专用的读法。为什么不能直接用
/// read_screen 轮询：`read_screen` 每次开头都会 `clear_latest_ax_refs()`，sidecar 那侧
/// `snapshot` 也会换掉整张句柄表并释放旧句柄。也就是说一个每几秒读一次屏的后台监视器，
/// 会把模型上一次 read_screen 拿到的 ref **持续作废**——模型攥着一把废数字，
/// ui_click 只会回「ref 已过期」，而它根本不知道是谁弄没的。
///
/// 这条路走 sidecar 的 `screen.probe`：同一套遍历，末尾把句柄放掉而不是存起来。
/// 没有 ref 进出，所以对模型手里那批 ref 完全没有副作用。
#[tauri::command]
pub async fn probe_screen(
    app: Option<String>,
    pid: Option<i64>,
) -> Result<serde_json::Value, String> {
    let target = AxTarget { pid, app };
    let target_pid = resolve_target_pid(&target).await?;
    let mut args = serde_json::json!({ "cap": 400 });
    if let Some(p) = target_pid.filter(|p| *p > 0) {
        args["pid"] = serde_json::json!(p);
    }
    // 这里**没有 JXA 兜底**，是刻意的：JXA 那条一次读要几十秒，做成每几秒一轮的
    // 轮询等于把机器压死。sidecar 不可用时如实说不可用，让监视器报错退场，
    // 而不是变成一个永远超时的假等待。
    let out = crate::automation::automation_call("screen.probe".into(), args)
        .await
        .map_err(|e| format!("屏幕探查不可用（自动化子进程没起来？）：{e}"))?;
    // sidecar 明说了这次读有没有动过句柄表。**必须真的查**：
    // 这条路存在的全部理由就是「轮询不作废模型手里的 ref」，而一旦哪天 sidecar 那侧
    // 把 screen.probe 的语义改了、或者有人图省事把它接回 screen.elements，句柄表被悄悄
    // 换掉这件事在这里是唯一能被发现的地方。发现了就报错——宁可这条监视器不可用，
    // 也不能让它在后台默默地把模型的 ref 一批批毁掉。
    if out.get("refs_installed").and_then(|v| v.as_bool()) == Some(true) {
        return Err(
            "屏幕探查返回 refs_installed=true：这次读**动了句柄表**，会作废 read_screen 发出去的 ref。已中止，不做这次探查。".into(),
        );
    }
    let elements = out.get("elements").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    // 只交出匹配要用的东西：角色、文字、值。坐标和 ref 一概不给——给了就会有人
    // 拿去点，而这条路的元素**没有对应的句柄**，点不了。
    let text: Vec<String> = elements
        .iter()
        .filter_map(|e| {
            let role = e.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let t = e.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let v = e.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let joined = format!("{role} {t} {v}").trim().to_string();
            if joined.is_empty() { None } else { Some(joined) }
        })
        .collect();
    Ok(serde_json::json!({
        "app": out.get("app").and_then(|v| v.as_str()).unwrap_or_default(),
        "pid": out.get("pid").and_then(|v| v.as_i64()).unwrap_or(0),
        "count": text.len(),
        "lines": text,
    }))
}

/// Perform a real accessibility action against an opaque ref from the latest
/// UI-tree read. The target PID and original node index are both resolved from
/// that snapshot; callers must read again whenever the target UI changes.
/// 目标**不必在前台**——身份由快照里记下的 pid + 应用名保证，不由「谁在最前面」保证。
#[tauri::command]
pub async fn ui_click(
    reference: u32,
    action: String,
    value: Option<String>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        action.as_str(),
        "press"
            | "set_value"
            | "focus"
            | "increment"
            | "decrement"
            | "show_menu"
            | "confirm"
            | "cancel"
            | "pick"
            | "scroll_to"
    ) {
        return Err(
            "action must be press, set_value, focus, increment, decrement, show_menu, confirm, cancel, pick, or scroll_to"
                .into(),
        );
    }
    if action == "set_value" && value.is_none() {
        return Err("set_value requires value".into());
    }
    // 非 macOS 上原来这里现造一个空签名的 binding：raw_ref 直接等于模型传来的 ref，
    // 签名八个字段全是零值。也就是说 Windows 上"这个 ref 还指着刚才那个元素吗"
    // 从来没有被检查过——而它恰恰是按 ref 操作能不能信的全部依据。
    let (binding, expected_target) = resolve_ax_ref(reference)?;
    // 快路读来的 ref 就走快路的动作：sidecar 在读屏时按 ref 把元素句柄 CFRetain 留下了，
    // 动作直接对着那个句柄发，**不重跑枚举**，成本是常数级的几次 C 调用。
    //
    // 底下那条 JXA 老路每执行一次动作都要把整棵树重新枚举一遍（最多 5 个窗口
    // entireContents + 逐元素读 role/位置/尺寸/标题/值/可用性），实测轻应用约 1 秒、
    // Chrome 5.3 秒、日历 20.8 秒——而它的预算只有 6 秒，重界面上必然被掐断，
    // 回一句「辅助功能操作超时或无权限」，一个和真实原因毫无关系的理由。
    // 老路只在快路没跑成（sidecar 没起来 / 没权限 / 读回空）时才用得上。
    if binding.native {
        return native_ax_action(&binding, &action, value.as_deref(), &expected_target).await;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        perform_ax_action(&binding, &action, value.as_deref(), &expected_target)
    })
    .await
    .map_err(|error| format!("accessibility action task failed: {error}"))??;
    parse_action_result(&result)
}

/// 按 ref 走 sidecar 的句柄表执行动作（快路）。
///
/// 身份校验在 sidecar 那边做：句柄表是**上一次 screen.elements 留下的**，读别的应用会
/// 整张换掉，所以句柄天然属于最近读过的那个应用；元素本身还是不是原来那个，由 act()
/// 里的签名比对负责。这里不再重复校验 pid/应用名——那是老路因为要按下标回查才需要的。
async fn native_ax_action(
    binding: &AxRefBinding,
    action: &str,
    value: Option<&str>,
    expected_target: &AccessibilityTarget,
) -> Result<serde_json::Value, String> {
    // pid 一起发下去。工具描述向模型保证「身份由快照里记下的 pid 保证，目标不必在前台」，
    // 而 sidecar 那边的 Held.pid 此前只存不读——这句保证一直是空的。
    let mut args = serde_json::json!({
        "ref": binding.raw_ref, "action": action, "pid": expected_target.pid,
    });
    if let Some(v) = value {
        args["value"] = serde_json::json!(v);
    }
    // 必须自己带上限。automation_call 的 HTTP 客户端给的是 **120 秒**——那是为
    // browser.* 那种真的要等页面的调用准备的。按句柄发一个 AX 动作只有几毫秒，
    // 真等到几十秒只意味着对面卡住了，而不是这一步还有希望。
    // 没有这一层的话，换到快路反而会把老路原有的 6 秒上限放大成两分钟的假死。
    const ACT_BUDGET: std::time::Duration = std::time::Duration::from_secs(6);
    match tokio::time::timeout(
        ACT_BUDGET,
        crate::automation::automation_call("screen.act".into(), args),
    )
    .await
    {
        Ok(r) => r,
        // 超时只取消**我们这一头**。请求早就发出去了，sidecar 收到之后照样会执行——
        // 所以不能说「没执行」，更不能建议直接重试：那会把同一个动作做第二遍
        // （点两次、写两次值）。措辞必须把这件事说出来，模型才能决定是先去看结果还是重来。
        //
        // 超时的原因几乎总是**队头阻塞**而不是崩溃：sidecar 的 HTTP 服务单线程串行，
        // 一次慢调用（browser.goto 最坏 60 秒、模型自己给毫秒数的 sleep、长回放）期间
        // 后面全部排队。说成「服务卡住了」会把模型引向重启/重读，而正确的动作是等或者查。
        Err(_) => Err(format!(
            "按 ref 操作等了 {} 秒还没轮到——自动化服务是单线程的，多半正在处理另一个\
             自动化调用（浏览器导航、回放、sleep 都会占住它）。\
             **这个动作可能已经执行了**：请求已经发出去，超时只是我们这头不等了。\
             先 read_screen 看一眼界面现在是什么样，再决定要不要重发——直接重发会做第二遍。",
            ACT_BUDGET.as_secs()
        )),
    }
}

fn parse_action_result(result: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(result)
        .map_err(|error| format!("invalid accessibility result: {error}"))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(value);
    }
    let reason = value
        .get("err")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("accessibility action failed");
    Err(reason.to_string())
}

#[cfg(target_os = "macos")]
const AX_SIGNATURE_BUILDERS_JS: &str = r#"var axLabel = function(el){
  var t='';
  try{t=el.title()||'';}catch(e){}
  if(!t){try{t=el.description()||'';}catch(e){}}
  if(!t){try{t=el.help()||'';}catch(e){}}
  if(!t){try{var v=el.value();if(typeof v==='string')t=v;}catch(e){}}
  return String(t).slice(0,80);
};
var axValue = function(el){try{var v=el.value();return v!=null?String(v).slice(0,120):'';}catch(e){return '';}};
var axEnabled = function(el){try{return el.enabled()!==false;}catch(e){return true;}};
var axElementSignature = function(el,role,p,s){
  return {role:role.replace('AX',''),text:axLabel(el),x:p[0],y:p[1],w:s[0],h:s[1],value:axValue(el),enabled:axEnabled(el)};
};
var axMenuSignature = function(el,p,s){
  var t='';try{t=el.title()||'';}catch(e){}
  return {role:'MenuBarItem',text:String(t).slice(0,80),x:p[0],y:p[1],w:s[0],h:s[1],value:'',enabled:true};
};"#;

/// 选目标进程的那一小段 JXA。不给 pid 就是前台——保持原行为。
///
/// 用 `whose({unixId: N})` 而不是先枚举再逐个读属性：whose 是 System Events 侧的
/// 查询，一次 Apple Event 就回来；在 JXA 里逐个读 unixId 是每个进程一次往返。
#[cfg(target_os = "macos")]
fn ax_target_pick_js(pid: Option<i64>) -> String {
    match pid.filter(|p| *p > 0) {
        Some(p) => format!("se.applicationProcesses.whose({{ unixId: {p} }})"),
        None => "se.applicationProcesses.whose({ frontmost: true })".to_string(),
    }
}

#[cfg(target_os = "macos")]
fn read_ui_snapshot(pid: Option<i64>) -> UiSnapshot {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    // DEEP JXA: enumerate ALL accessibility elements from the frontmost app —
    // every role, all windows (up to 5), with value + enabled state.
    // Priority tiers: interactive controls → text labels → structural containers → rest.
    // This captures elements that the old 24-role filter missed (AXStaticText labels,
    // AXGroup containers, AXToolbar, AXTable, etc.). Cap 500, timeout 6s.
    let script = r##"(function () {
  try {
    __SIGNATURE_BUILDERS__
    var se = Application('System Events');
    var procs = __TARGET_PICK__;
    if (!procs.length) return JSON.stringify({target:null,elements:[]});
    var proc = procs[0];
    var pid=0,pname='';
    try{pid=Number(proc.unixId());}catch(e){}
    try{pname=String(proc.name()||'').slice(0,120);}catch(e){}
    if(!isFinite(pid)||pid<=0) return JSON.stringify({target:null,elements:[]});
    var CAP = 500;
    var T1 = { AXButton:1,AXTextField:1,AXTextArea:1,AXCheckBox:1,AXRadioButton:1,AXPopUpButton:1,AXMenuButton:1,AXComboBox:1,AXLink:1,AXSlider:1,AXDisclosureTriangle:1,AXSegmentedControl:1,AXTabGroup:1,AXSearchField:1,AXStepper:1,AXIncrementor:1,AXColorWell:1,AXMenuItem:1,AXTab:1,AXDateField:1,AXSecureTextField:1 };
    var T2 = { AXStaticText:1,AXHeading:1 };
    var T3 = { AXGroup:1,AXScrollArea:1,AXSplitGroup:1,AXToolbar:1,AXList:1,AXTable:1,AXOutline:1,AXSheet:1,AXDialog:1,AXBrowser:1,AXDrawer:1,AXLayoutArea:1,AXMatte:1,AXRuler:1,AXSplitter:1,AXGrowArea:1 };
    var a1=[],a2=[],a3=[],a4=[];
    var take = function(el,role){
      var p,s; try{p=el.position();s=el.size();}catch(e){return;}
      if(!p||!s||s[0]<2||s[1]<2) return;
      var rec=axElementSignature(el,role,p,s);
      if(T1[role])a1.push(rec);else if(T2[role])a2.push(rec);else if(T3[role])a3.push(rec);else a4.push(rec);
    };
    var pageState=null;
    var wins; try{wins=proc.windows;}catch(e){wins=[];}
    // 只走用户真看得见、真点得到的窗口。浏览器这类应用会挂一个 1x1 的隐藏工具窗，
    // 而最小化的窗口交出来的是失效坐标——照着点会落在空处，就是「点了没反应」。
    // 这些元素混进来还会在末尾的截断里，把真窗口中能点的元素挤掉。
    // 主窗口排最前，保证被截断时先留它。
    var usable=[];
    for(var wq=0;wq<wins.length;wq++){
      var w=wins[wq],ws;
      try{ws=w.size();}catch(e){continue;}
      if(!ws||ws[0]<40||ws[1]<40) continue;
      var hidden=false; try{hidden=!!w.attributes.byName('AXMinimized').value();}catch(e){}
      if(hidden) continue;
      var isMain=false; try{isMain=!!w.attributes.byName('AXMain').value();}catch(e){}
      if(isMain) usable.unshift(w); else usable.push(w);
    }
    for(var wi=0;wi<usable.length&&wi<5;wi++){
      var all; try{all=usable[wi].entireContents();}catch(e){all=[];}
      for(var k=0;k<all.length;k++){
        if(a1.length+a2.length+a3.length+a4.length>=CAP*3) break;
        var el=all[k],role; try{role=el.role();}catch(e){continue;}
        take(el,role);
        // 网页的加载状态就挂在 AXWebArea 上（AXLoaded / AXLoadingProgress），
        // 顺路读掉，不为它额外遍历一遍树。
        if(!pageState && role==='AXWebArea'){
          var gv=function(n){try{return el.attributes.byName(n).value();}catch(e){return null;}};
          var ttl=''; try{ ttl=String(gv('AXTitle')||''); }catch(e){}
          var lp=gv('AXLoadingProgress');
          pageState={title:ttl.slice(0,120), loaded:(gv('AXLoaded')===true),
                     progress:(typeof lp==='number'?lp:(lp===null?0:Number(lp)||0))};
        }
      }
    }
    try{
      var items=proc.menuBars[0].menuBarItems;
      for(var m=0;m<items.length;m++){
        var mi=items[m],p,s; try{p=mi.position();s=mi.size();}catch(e){continue;}
        if(!p||!s||s[0]<2) continue;
        a1.push(axMenuSignature(mi,p,s));
      }
    }catch(e){}
    var merged=a1.concat(a2).concat(a3).concat(a4).slice(0,CAP);
    for(var n=0;n<merged.length;n++) merged[n].ref=n;
    // 窗口都在、但一个都不可用（全最小化）时，空结果不是「没权限」也不是「这个应用不暴露树」，
    // 而是唯一能补救的那种空。不说清楚，模型就会照描述里那两条去断言重试没意义。
    var allHidden=(wins.length>0&&usable.length===0);
    return JSON.stringify({target:{pid:pid,name:pname},elements:merged,page:pageState,
      read_error: allHidden ? '这个应用的窗口当前全部处于最小化（或尺寸为零）状态，屏幕上没有可点的元素。先把它切到前台或还原窗口再读一次即可——这不是权限问题，也不是它不暴露辅助功能树。' : undefined});
  }catch(e){return JSON.stringify({target:null,elements:[]});}
})()"##
        .replace("__SIGNATURE_BUILDERS__", AX_SIGNATURE_BUILDERS_JS)
        .replace("__TARGET_PICK__", &ax_target_pick_js(pid));

    let mut child = match crate::process_util::command("osascript")
        .args(["-l", "JavaScript", "-e", script.as_str()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return UiSnapshot { read_error: Some("osascript 启动失败".into()), ..Default::default() },
    };

    // 6s for complex apps (all windows, all roles, more elements).
    // **读管道必须和等待并行。** 先轮询等它退出、退出后才 read_to_string 的写法，
    // 在管道缓冲被写满时会死锁：子进程阻塞在写上、永远不退出，于是必然走到超时分支。
    // Windows 的匿名管道默认只有 4096 字节（Unix 是 65536，所以 mac 上看不出这个病），
    // 大约 40 个 UI 元素就写满 —— 稍微复杂一点的窗口结构性读不出来，而超时文案还会
    // 把模型引向「这个应用没有可访问性树」这个错误结论。写法照 tasks.rs 那份：
    // 读端丢线程，主循环只管等和超时。
    let (tx_out, rx_out) = std::sync::mpsc::channel::<String>();
    if let Some(mut so) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut b = String::new();
            let _ = so.read_to_string(&mut b);
            let _ = tx_out.send(b);
        });
    }
    let deadline = Instant::now() + Duration::from_millis(6000);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return UiSnapshot { read_error: Some("读取超时（6 秒）".into()), ..Default::default() };
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return UiSnapshot { read_error: Some("等待 osascript 时出错".into()), ..Default::default() },
        }
    }

    // 进程已经退出（上面的循环只在退出时 break），读线程随即收到 EOF。给一个短等待上界
    // 而不是无限 recv：读线程理论上不会卡，但一个卡住的线程不该让整个调用挂死。
    let s = rx_out
        .recv_timeout(Duration::from_millis(2000))
        .unwrap_or_default();
    serde_json::from_str::<UiSnapshot>(s.trim()).unwrap_or(UiSnapshot {
        read_error: Some("osascript 输出不是合法快照 JSON".into()),
        ..Default::default()
    })
}

/// macOS 侧的便捷包装：给不关心失败原因的调用方用，保持只返回元素。
/// Windows 侧那个返回 (元素, 失败原因)，因为它三种失败原来全都静默变空。
#[cfg(target_os = "macos")]
pub fn read_ui_elements() -> Vec<UiElement> {
    read_ui_snapshot(None).elements
}

// Windows: the UI Automation twin of the macOS AX walk above — enumerate the foreground
// window's interactive elements (buttons / edits / checkboxes / menu items / list & tree
// rows …) with on-screen rects, via PowerShell. Controls before bulk rows, cap 120, time-
// bounded → falls back to the coordinate grid on permission/slow/no-tree (no hang). Same
// JSON shape as macOS so the caller is platform-agnostic.
#[cfg(target_os = "windows")]
pub fn read_ui_elements() -> (Vec<UiElement>, Option<AccessibilityTarget>, Option<String>) {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    // DEEP Windows UI Automation: ALL control types, priority-tiered, cap 500, with value + enabled.
    let script = r#"$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;using System.Runtime.InteropServices;
public class _AW{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}
"@
$h=[_AW]::GetForegroundWindow()
if($h -eq [IntPtr]::Zero){'{"elements":[]}';exit}
$tp=0;[void][_AW]::GetWindowThreadProcessId($h,[ref]$tp)
$tn='';try{$tn=(Get-Process -Id $tp).ProcessName}catch{}
$AE=[System.Windows.Automation.AutomationElement]
$root=$AE::FromHandle($h)
if($root -eq $null){'{"elements":[],"pid":'+$tp+',"app":"'+$tn+'"}';exit}
$t1=@{'Button'=1;'Edit'=1;'CheckBox'=1;'RadioButton'=1;'ComboBox'=1;'Hyperlink'=1;'Slider'=1;'SplitButton'=1;'Spinner'=1;'MenuItem'=1;'TabItem'=1}
$t2=@{'Text'=1}
$t3=@{'Group'=1;'Pane'=1;'ToolBar'=1;'StatusBar'=1;'ScrollBar'=1;'Table'=1;'DataGrid'=1;'Document'=1;'Window'=1;'Header'=1}
$a1=@();$a2=@();$a3=@();$a4=@()
$els=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $els){
  if(($a1.Count+$a2.Count+$a3.Count+$a4.Count) -ge 1500){break}
  $ct='';try{$ct=$e.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''}catch{continue}
  $r=$null;try{$r=$e.Current.BoundingRectangle}catch{continue}
  if($r -eq $null -or [double]::IsInfinity([double]$r.X) -or $r.Width -lt 2 -or $r.Height -lt 2){continue}
  $nm='';try{$nm=''+$e.Current.Name}catch{}
  if($nm.Length -gt 80){$nm=$nm.Substring(0,80)}
  $val='';try{$vp=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$val=''+$vp.Current.Value;if($val.Length -gt 120){$val=$val.Substring(0,120)}}catch{}
  $en=$true;try{$en=$e.Current.IsEnabled}catch{}
  $rec=@{role=$ct;text=$nm;x=[double]$r.X;y=[double]$r.Y;w=[double]$r.Width;h=[double]$r.Height;value=$val;enabled=$en}
  if($t1.ContainsKey($ct)){$a1+=$rec}
  elseif($t2.ContainsKey($ct)){$a2+=$rec}
  elseif($t3.ContainsKey($ct)){$a3+=$rec}
  else{$a4+=$rec}
}
$all=@($a1)+@($a2)+@($a3)+@($a4)
$out=@();for($i=0;$i -lt [Math]::Min($all.Count,500);$i++){$m=$all[$i];$m.ref=$i;$out+=$m}
ConvertTo-Json -Compress -Depth 4 -InputObject @{pid=$tp;app=$tn;elements=@($out)}"#;

    let mut child = match crate::process_util::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return (Vec::new(), None, Some("powershell 起不来".into())),
    };
    // **读管道必须和等待并行。** 先轮询等它退出、退出后才 read_to_string 的写法，
    // 在管道缓冲被写满时会死锁：子进程阻塞在写上、永远不退出，于是必然走到超时分支。
    // Windows 的匿名管道默认只有 4096 字节（Unix 是 65536，所以 mac 上看不出这个病），
    // 大约 40 个 UI 元素就写满 —— 稍微复杂一点的窗口结构性读不出来，而超时文案还会
    // 把模型引向「这个应用没有可访问性树」这个错误结论。写法照 tasks.rs 那份：
    // 读端丢线程，主循环只管等和超时。
    let (tx_out, rx_out) = std::sync::mpsc::channel::<String>();
    if let Some(mut so) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut b = String::new();
            let _ = so.read_to_string(&mut b);
            let _ = tx_out.send(b);
        });
    }
    let deadline = Instant::now() + Duration::from_millis(6000);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 这是 Windows 上最常见的一种空结果（Explorer / Office / Electron
                    // 很容易撞到），而它**不是**「这个应用没有可访问性树」。不区分的话，
                    // 下游会照 macOS 那套说「权限没问题、重试没意义、改用 ocr」——而 ocr
                    // 在 Windows 上恒返回空，模型绕一圈后断定「这个应用没法自动化」，
                    // 把一句假话报给用户。
                    return (Vec::new(), None, Some("UI Automation 读取超时（6 秒）".into()));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return (Vec::new(), None, Some("等待 powershell 时出错".into())),
        }
    }
    // 进程已经退出（上面的循环只在退出时 break），读线程随即收到 EOF。给一个短等待上界
    // 而不是无限 recv：读线程理论上不会卡，但一个卡住的线程不该让整个调用挂死。
    let s = rx_out
        .recv_timeout(Duration::from_millis(2000))
        .unwrap_or_default();
    let t = s.trim();
    // 脚本现在固定回一个 {pid, app, elements} 的对象。以前回的是裸数组，还得靠
    // 「开头是不是 {」来猜 PowerShell 有没有把单元素数组塌成对象——那个启发式
    // 一旦猜错就把整棵树当成一个元素。现在形状是固定的，不用猜。
    //
    // pid/app 不是装饰：install_ax_snapshot 靠它判断「这次读的还是不是同一个应用」，
    // 没有身份它会直接早退，ref 表一条都不存——于是 ui_click 拿到的 ref 无从校验。
    #[derive(serde::Deserialize)]
    struct WinRead {
        #[serde(default)]
        pid: i64,
        #[serde(default)]
        app: String,
        #[serde(default)]
        elements: Vec<UiElement>,
    }
    match serde_json::from_str::<WinRead>(t) {
        Ok(r) => {
            let target = if r.pid > 0 {
                Some(AccessibilityTarget { pid: r.pid, name: r.app })
            } else {
                None
            };
            (r.elements, target, None)
        }
        // 解析失败以前是 unwrap_or_default() 静默变空——和「这个应用真没有元素」
        // 长得一模一样，而这两件事该走完全不同的处置。
        Err(_) => (Vec::new(), None, Some("powershell 输出不是合法 JSON".into())),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn read_ui_elements() -> (Vec<UiElement>, Option<AccessibilityTarget>, Option<String>) {
    (Vec::new(), None, Some("这个平台没有可访问性树读取实现".into()))
}

#[cfg(not(target_os = "macos"))]
fn read_ui_snapshot(_pid: Option<i64>) -> UiSnapshot {
    // 上面那句注释以前说「这条路径没有独立的失败信号」——不对：起不来、超时、
    // 输出不是合法 JSON，三种失败都存在，只是原来全都静默返回了空。空结果因此和
    // 「这个应用真的没有可访问性树」长得一模一样，而下游对这两件事的处置完全相反
    // （一个该重试或切前台，一个该换别的手段）。现在各自报出来。
    let (elements, target, read_error) = read_ui_elements();
    UiSnapshot {
        // 以前这里硬写 None。后果不是"少一个字段"：install_ax_snapshot 见到
        // target 为 None 就整段早退，一条 ref 都不入表——而它同时也是把
        // element.ref_ 换成不透明序号的地方。于是 Windows 上读屏发出去的 ref
        // 既没被登记、也没被改写，ui_click 拿着它无从校验元素还是不是原来那个。
        target,
        elements,
        page: None,
        read_error,
        ..Default::default()
    }
}

// ===== Direct accessibility ACTION on a node by ref (AXPress / set value) =====
// "把软件转成节点、直接点" — instead of vision (screenshot → locate → pixel-click), perform
// a real accessibility action on the enumerated element. The opaque `ref` is mapped back
// to its node index, then the same deterministic enumeration is repeated (cap 500), so
// ref→element is stable as long as the UI didn't change. Returns a small JSON
// {ok, role, name, value} for text-only verification (no screenshot needed).

#[cfg(target_os = "macos")]
fn run_osa(script: &str, ms: u64) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = crate::process_util::command("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }
    let mut s = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut s);
    }
    let t = s.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

#[cfg(target_os = "macos")]
const AX_SIGNATURE_HELPER_JS: &str = r#"var axSignatureChanges = function(expected, actual) {
  var fields = ['role','text','x','y','w','h','value','enabled'];
  var changed = [];
  for (var i=0;i<fields.length;i++) {
    var field=fields[i];
    if (actual[field] !== expected[field]) changed.push(field);
  }
  return changed;
};"#;

#[cfg(target_os = "macos")]
const AX_ACTION_JS: &str = r##"(function(){
  try {
    __SIGNATURE_BUILDERS__
    __SIGNATURE_HELPER__
    var CTX = __CONTEXT__;
    var REF = CTX.reference; var ACT = CTX.action; var VAL = CTX.value;
    // Perform a named AX action (AXIncrement/AXShowMenu/AXPick/…) by scanning the
    // element's action list — this is how you drive steppers, popups, disclosure
    // rows and dialogs that don't respond to a plain AXPress.
    var axPerform = function(elm, axName){
      try { var acts = elm.actions();
        for (var ai=0; ai<acts.length; ai++){ var an=''; try{an=acts[ai].name();}catch(e){} if(an===axName){ acts[ai].perform(); return true; } }
      } catch(e){}
      return false;
    };
    var se = Application('System Events');
    // 按 **pid** 定位，不再要求目标在最前面。
    //
    // 原来这里是 whose({frontmost:true})：也就是说即便 read_screen 读到了一个后台
    // 应用，动作也必然被这句拒掉（"frontmost app changed"）——读得到、点不了，
    // 「指定目标」等于只做了半个。
    //
    // 那句 frontmost 检查真正在防的是「在 A 上读的 ref 被拿到 B 上执行」，而防住它的
    // 是下面 pid + 应用名这两道身份校验，不是「必须在前台」。按 pid 定位之后这两道
    // 照样跑，防护一点没少，只是不再顺带禁止操作后台窗口。
    var procs = se.applicationProcesses.whose({ unixId: CTX.pid });
    if (!procs.length) return JSON.stringify({ok:false, err:'target app (pid '+CTX.pid+') is gone; run read_screen again'});
    var proc = procs[0];
    var actualPid=0; try{actualPid=Number(proc.unixId());}catch(e){}
    if(!isFinite(actualPid)||actualPid<=0) return JSON.stringify({ok:false, err:'could not identify target process'});
    if(actualPid!==CTX.pid) return JSON.stringify({ok:false, err:'target app changed; run read_screen again', expectedPid:CTX.pid, actualPid:actualPid});
    // 名字要**两个空间都认**，因为读屏那两条路记下的身份不在同一个空间里：
    //   · 快路（sidecar）记的是 NSRunningApplication.localizedName —— 屏幕上的名字
    //   · 慢路（JXA）记的是 System Events 的 name() —— 可执行名
    // 英文系统上两者恰好相同，所以这个错藏得住；中文系统上 Finder 的显示名是「访达」，
    // 只比 name() 的话每一次按 ref 点击都会被这道校验硬拒，而回执说的是
    // 「应用身份变了」——一句和真实原因毫无关系的话。
    var actualAppName=''; try{actualAppName=String(proc.name()||'').slice(0,120);}catch(e){}
    var actualShown=''; try{actualShown=String(proc.displayedName()||'').slice(0,120);}catch(e){}
    if(actualAppName!==CTX.appName && actualShown!==CTX.appName) return JSON.stringify({ok:false, err:'target app identity changed (pid reused); run read_screen again', expected:CTX.appName, actual:actualAppName});
    var CAP = 500;
    var T1 = { AXButton:1,AXTextField:1,AXTextArea:1,AXCheckBox:1,AXRadioButton:1,AXPopUpButton:1,AXMenuButton:1,AXComboBox:1,AXLink:1,AXSlider:1,AXDisclosureTriangle:1,AXSegmentedControl:1,AXTabGroup:1,AXSearchField:1,AXStepper:1,AXIncrementor:1,AXColorWell:1,AXMenuItem:1,AXTab:1,AXDateField:1,AXSecureTextField:1 };
    var T2 = { AXStaticText:1,AXHeading:1 };
    var T3 = { AXGroup:1,AXScrollArea:1,AXSplitGroup:1,AXToolbar:1,AXList:1,AXTable:1,AXOutline:1,AXSheet:1,AXDialog:1,AXBrowser:1,AXDrawer:1,AXLayoutArea:1,AXMatte:1,AXRuler:1,AXSplitter:1,AXGrowArea:1 };
    var a1=[],a2=[],a3=[],a4=[];
    var wins; try{wins=proc.windows;}catch(e){wins=[];}
    // 只走用户真看得见、真点得到的窗口。浏览器这类应用会挂一个 1x1 的隐藏工具窗，
    // 而最小化的窗口交出来的是失效坐标——照着点会落在空处，就是「点了没反应」。
    // 这些元素混进来还会在末尾的截断里，把真窗口中能点的元素挤掉。
    // 主窗口排最前，保证被截断时先留它。
    var usable=[];
    for(var wq=0;wq<wins.length;wq++){
      var w=wins[wq],ws;
      try{ws=w.size();}catch(e){continue;}
      if(!ws||ws[0]<40||ws[1]<40) continue;
      var hidden=false; try{hidden=!!w.attributes.byName('AXMinimized').value();}catch(e){}
      if(hidden) continue;
      var isMain=false; try{isMain=!!w.attributes.byName('AXMain').value();}catch(e){}
      if(isMain) usable.unshift(w); else usable.push(w);
    }
    for(var wi=0;wi<usable.length&&wi<5;wi++){
      var all; try{all=usable[wi].entireContents();}catch(e){all=[];}
      for(var k=0;k<all.length;k++){
        if(a1.length+a2.length+a3.length+a4.length>=CAP*3) break;
        var el=all[k],role; try{role=el.role();}catch(e){continue;}
        var p,s; try{p=el.position();s=el.size();}catch(e){continue;}
        if(!p||!s||s[0]<2||s[1]<2) continue;
        var entry={el:el,signature:axElementSignature(el,role,p,s)};
        if(T1[role])a1.push(entry);else if(T2[role])a2.push(entry);else if(T3[role])a3.push(entry);else a4.push(entry);
      }
    }
    try{
      var items=proc.menuBars[0].menuBarItems;
      for(var m=0;m<items.length;m++){var mi=items[m],pp,ss;try{pp=mi.position();ss=mi.size();}catch(e){continue;}if(!pp||!ss||ss[0]<2)continue;a1.push({el:mi,signature:axMenuSignature(mi,pp,ss)});}
    }catch(e){}
    var merged=a1.concat(a2).concat(a3).concat(a4).slice(0,CAP);
    if(REF<0||REF>=merged.length) return JSON.stringify({ok:false, err:'ref out of range (0..'+merged.length+')', n:merged.length});
    var candidate=merged[REF];
    var changed=axSignatureChanges(CTX.signature,candidate.signature);
    if(changed.length) return JSON.stringify({ok:false, err:'accessibility ref is stale; element signature changed ('+changed.join(', ')+'); run read_screen again'});
    var el=candidate.el;
    var role=candidate.signature.role;
    var name=candidate.signature.text;
    if (ACT === 'set_value') {
      try { el.value = VAL; } catch(e) {
        return JSON.stringify({ok:false, err:'AX set_value failed: '+String(e), action:'set_value', role:role, name:String(name).slice(0,60)});
      }
      var nv;
      try { nv = el.value(); } catch(e) {
        return JSON.stringify({ok:false, err:'AX set_value could not be verified: '+String(e), action:'set_value', role:role, name:String(name).slice(0,60)});
      }
      if(String(nv)!==String(VAL)) {
        return JSON.stringify({ok:false, err:'AX set_value did not apply the requested value', action:'set_value', role:role, name:String(name).slice(0,60), value:String(nv).slice(0,140)});
      }
      return JSON.stringify({ok:true, action:'set_value', role:role, name:String(name).slice(0,60), value:String(nv).slice(0,140)});
    } else if (ACT === 'focus') {
      // 赋值没抛异常 != 焦点真的落到这个元素上。紧挨着的 set_value 是回读比对过的，
      // 只有 focus 这一支光看抛不抛——而很多元素会接受赋值却根本拿不到焦点
      // （不可聚焦的容器、被遮挡的输入框、跨窗口的元素）。焦点没到却报成功，
      // 后面那次 keyboard.type 就打进了别的地方，而且全链路一路 ok。
      try { el.focused = true; } catch(e) {
        return JSON.stringify({ok:false, err:'AX focus was rejected: '+String(e), action:'focus', role:role, name:String(name).slice(0,60)});
      }
      var got=false;
      try { got = !!el.focused(); } catch(e) {
        return JSON.stringify({ok:false, err:'AX focus could not be verified: '+String(e), action:'focus', role:role, name:String(name).slice(0,60)});
      }
      if(!got) {
        return JSON.stringify({ok:false, err:'element accepted the assignment but did not take focus', action:'focus', role:role, name:String(name).slice(0,60)});
      }
      return JSON.stringify({ok:true, action:'focus', role:role, name:String(name).slice(0,60)});
    } else if (ACT === 'press') {
      var pressed=false;
      try { el.click(); pressed=true; } catch(e) {}
      // Rows, disclosure triangles and popup buttons often expose AXOpen/AXPick
      // instead of AXPress — fall through those before giving up.
      if(!pressed) pressed = axPerform(el,'AXPress')||axPerform(el,'AXOpen')||axPerform(el,'AXPick');
      if(!pressed) return JSON.stringify({ok:false, err:'element does not respond to press/open/pick', role:role, name:String(name).slice(0,60)});
      var nv2=''; try { var vv=el.value(); if(typeof vv==='string') nv2=vv; } catch(e) {}
      return JSON.stringify({ok:true, action:'press', role:role, name:String(name).slice(0,60), value:String(nv2).slice(0,140)});
    } else if (ACT === 'scroll_to') {
      // 可访问性树只覆盖可见的那一屏，折叠以下的元素压根不在清单里。没有这个动作，
      // 「滚下去再点」只能靠盲滚坐标，而坐标滚动量和目标位置之间没有任何对应关系。
      // 注意滚动之后位置全变了：ref 签名里含 x/y，所以旧 ref 会全部作废，必须重读。
      if(!axPerform(el,'AXScrollToVisible')) {
        return JSON.stringify({ok:false, err:'element does not support scroll_to (AXScrollToVisible)', role:role, name:String(name).slice(0,60)});
      }
      var np=[0,0]; try { np=el.position(); } catch(e) {}
      return JSON.stringify({ok:true, action:'scroll_to', role:role, name:String(name).slice(0,60),
        x:np[0], y:np[1],
        note:'滚动后这一屏的元素位置全变了，之前那批 ref 已经作废——先重新 read_screen 再操作。'});
    } else {
      var axName = ({increment:'AXIncrement',decrement:'AXDecrement',show_menu:'AXShowMenu',confirm:'AXConfirm',cancel:'AXCancel',pick:'AXPick'})[ACT];
      if(!axName) return JSON.stringify({ok:false, err:'unsupported action: '+String(ACT)});
      if(!axPerform(el,axName)) return JSON.stringify({ok:false, err:'element does not support '+axName+' ('+ACT+')', role:role, name:String(name).slice(0,60)});
      var nv3=''; try { var vv3=el.value(); if(vv3!=null) nv3=String(vv3); } catch(e) {}
      return JSON.stringify({ok:true, action:ACT, role:role, name:String(name).slice(0,60), value:String(nv3).slice(0,140)});
    }
  } catch(e) { return JSON.stringify({ok:false, err:String(e)}); }
})()"##;

#[cfg(target_os = "macos")]
fn build_ax_action_script(
    binding: &AxRefBinding,
    action: &str,
    value: Option<&str>,
    expected_target: &AccessibilityTarget,
) -> Result<String, String> {
    // 这份白名单必须覆盖 ui_click 放行的**全部**动作，否则脚本里写好的实现根本走不到。
    // scroll_to 就漏在这里过：AX_ACTION_JS 里那段 AXScrollToVisible 实现完整写着，
    // 但请求先被这里拦成 "unsupported accessibility action" —— 读起来是「这个动作不存在」，
    // 而模型刚被工具描述告知 scroll_to 是把折叠以下的元素滚进视区的唯一手段。
    // 于是它断定这个界面滚不动，转去盲滚坐标。走到这条兜底路的四种情形
    //（sidecar 没起来 / 没编出来 / 没权限 / 快路读回空）恰恰是最需要它能用的时候。
    let act = match action {
        "set_value" | "focus" | "press" | "increment" | "decrement" | "show_menu" | "confirm"
        | "cancel" | "pick" | "scroll_to" => action,
        _ => return Err("unsupported accessibility action".to_string()),
    };
    let context = serde_json::json!({
        "reference": binding.raw_ref,
        "action": act,
        "value": value.unwrap_or(""),
        "pid": expected_target.pid,
        "appName": &expected_target.name,
        "signature": &binding.signature,
    });
    let context_json = serde_json::to_string(&context)
        .map_err(|error| format!("could not encode accessibility action: {error}"))?;
    Ok(AX_ACTION_JS
        .replace("__SIGNATURE_BUILDERS__", AX_SIGNATURE_BUILDERS_JS)
        .replace("__SIGNATURE_HELPER__", AX_SIGNATURE_HELPER_JS)
        .replace("__CONTEXT__", &context_json))
}

#[cfg(target_os = "macos")]
fn perform_ax_action(
    binding: &AxRefBinding,
    action: &str,
    value: Option<&str>,
    expected_target: &AccessibilityTarget,
) -> Result<String, String> {
    let script = build_ax_action_script(binding, action, value, expected_target)?;
    run_osa(&script, 6000).ok_or_else(|| "辅助功能操作超时或无权限".to_string())
}

/// Windows：按 ref 在 UI Automation 上真的执行动作。
///
/// 这条以前是一句硬 Err「当前平台暂不支持节点直接操作，请改用坐标点击」。
/// 读屏那条路在 Windows 上是真的（PowerShell + UIA，分层取控件），但读完之后
/// 唯一能"动"的方式是坐标点击——而坐标点击对滚动、缩放、DPI 变化毫无抵抗力，
/// 也没法读回"点完变成什么样了"。读和动之间是断的。
///
/// 做法和 macOS 那侧对齐：重跑**同一套确定性枚举**，按序号取回元素，
/// 先用 read_screen 时记下的签名核对它还是不是原来那个，再执行动作。
#[cfg(target_os = "windows")]
fn perform_ax_action(
    binding: &AxRefBinding,
    action: &str,
    value: Option<&str>,
    expected_target: &AccessibilityTarget,
) -> Result<String, String> {
    fn ps_lit(v: &str) -> String {
        // PowerShell 单引号字符串里只有单引号需要转义（写成两个）。
        format!("'{}'", v.replace('\'', "''"))
    }
    let sig = &binding.signature;
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;using System.Runtime.InteropServices;
public class _AX{{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}}
"@
function Fail($m){{ConvertTo-Json -Compress -InputObject @{{ok=$false;err=$m}};exit}}
$h=[_AX]::GetForegroundWindow()
if($h -eq [IntPtr]::Zero){{Fail 'no foreground window'}}
$tp=0;[void][_AX]::GetWindowThreadProcessId($h,[ref]$tp)
# 前台换了应用就直接停手。不核对的话，模型在 A 应用上读的 ref 会被拿到
# 刚弹出来的 B 应用上执行——点中的是完全不相干的东西，而回执照样是 ok。
if({pid} -gt 0 -and $tp -ne {pid}){{Fail ('foreground app changed (was pid {pid}, now '+$tp+'); run read_screen again')}}
$AE=[System.Windows.Automation.AutomationElement]
$root=$AE::FromHandle($h)
if($root -eq $null){{Fail 'no automation root'}}
$t1=@{{'Button'=1;'Edit'=1;'CheckBox'=1;'RadioButton'=1;'ComboBox'=1;'Hyperlink'=1;'Slider'=1;'SplitButton'=1;'Spinner'=1;'MenuItem'=1;'ListItem'=1;'TreeItem'=1;'TabItem'=1;'Custom'=1}}
$t2=@{{'Text'=1}}
$t3=@{{'Group'=1;'Pane'=1;'ToolBar'=1;'StatusBar'=1;'ScrollBar'=1;'Table'=1;'DataGrid'=1;'Document'=1;'Window'=1;'Header'=1}}
$a1=@();$a2=@();$a3=@();$a4=@()
$els=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $els){{
  if(($a1.Count+$a2.Count+$a3.Count+$a4.Count) -ge 1500){{break}}
  $ct='';try{{$ct=$e.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''}}catch{{continue}}
  $r=$null;try{{$r=$e.Current.BoundingRectangle}}catch{{continue}}
  if($r -eq $null -or [double]::IsInfinity([double]$r.X) -or $r.Width -lt 2 -or $r.Height -lt 2){{continue}}
  $nm='';try{{$nm=''+$e.Current.Name}}catch{{}}
  if($nm.Length -gt 80){{$nm=$nm.Substring(0,80)}}
  $rec=@{{role=$ct;text=$nm;x=[double]$r.X;y=[double]$r.Y;w=[double]$r.Width;h=[double]$r.Height;el=$e}}
  if($t1.ContainsKey($ct)){{$a1+=$rec}}
  elseif($t2.ContainsKey($ct)){{$a2+=$rec}}
  elseif($t3.ContainsKey($ct)){{$a3+=$rec}}
  else{{$a4+=$rec}}
}}
$all=@($a1)+@($a2)+@($a3)+@($a4)
$idx={idx}
if($idx -lt 0 -or $idx -ge [Math]::Min($all.Count,500)){{Fail ('ref out of range (tree now has '+$all.Count+' elements); run read_screen again')}}
$m=$all[$idx];$e=$m.el
# 签名核对：读屏那一刻记下的 role/text/矩形，现在还对不对得上。
# 界面动过（滚动、切页、弹窗）之后同一个序号会落到别的元素上，而那种误点
# 是完全静默的——回执一样是 ok，只是点错了东西。
$changed=@()
if({rolechk} -and $m.role -ne {role}){{$changed+='role'}}
if({textchk} -and $m.text -ne {text}){{$changed+='text'}}
if([Math]::Abs($m.x-{x}) -gt 6 -or [Math]::Abs($m.y-{y}) -gt 6){{$changed+='position'}}
if([Math]::Abs($m.w-{w}) -gt 8 -or [Math]::Abs($m.h-{h}) -gt 8){{$changed+='size'}}
if($changed.Count -gt 0){{Fail ('element changed since read_screen ('+($changed -join ', ')+'); run read_screen again')}}
$P=[System.Windows.Automation]
$act={action}
$val={value}
$done=$false
try{{
  switch($act){{
    'focus'      {{ $e.SetFocus(); $done=$true }}
    'scroll_to'  {{ $e.GetCurrentPattern($P.ScrollItemPattern::Pattern).ScrollIntoView(); $done=$true }}
    'set_value'  {{ $e.GetCurrentPattern($P.ValuePattern::Pattern).SetValue($val); $done=$true }}
    'show_menu'  {{ $e.GetCurrentPattern($P.ExpandCollapsePattern::Pattern).Expand(); $done=$true }}
    'pick'       {{ $e.GetCurrentPattern($P.SelectionItemPattern::Pattern).Select(); $done=$true }}
    {{'increment','decrement' -contains $_}} {{
      $rv=$e.GetCurrentPattern($P.RangeValuePattern::Pattern)
      $step=$rv.Current.SmallChange; if($step -eq 0){{$step=1}}
      $nv=if($act -eq 'increment'){{$rv.Current.Value+$step}}else{{$rv.Current.Value-$step}}
      $rv.SetValue([Math]::Min($rv.Current.Maximum,[Math]::Max($rv.Current.Minimum,$nv))); $done=$true
    }}
    default {{
      # press / confirm / cancel：UIA 里没有独立的"确认/取消"，它们就是按下那个按钮。
      # Invoke 是主路；开关类控件只实现 Toggle，列表项只实现 SelectionItem，
      # 展开箭头只实现 ExpandCollapse —— 挨个退，全不认才算失败。
      try{{ $e.GetCurrentPattern($P.InvokePattern::Pattern).Invoke(); $done=$true }}catch{{}}
      if(-not $done){{ try{{ $e.GetCurrentPattern($P.TogglePattern::Pattern).Toggle(); $done=$true }}catch{{}} }}
      if(-not $done){{ try{{ $e.GetCurrentPattern($P.SelectionItemPattern::Pattern).Select(); $done=$true }}catch{{}} }}
      if(-not $done){{ try{{ $e.GetCurrentPattern($P.ExpandCollapsePattern::Pattern).Expand(); $done=$true }}catch{{}} }}
    }}
  }}
}}catch{{ Fail ($act+' failed: '+$_.Exception.Message) }}
if(-not $done){{Fail ($m.role+' does not support '+$act+' (no matching UI Automation pattern)')}}
# 动作之后回读一次：value 变没变、还 enabled 吗。光说 ok 等于让模型自己再去看一眼。
$nv='';try{{$nv=''+$e.GetCurrentPattern($P.ValuePattern::Pattern).Current.Value}}catch{{}}
$en=$true;try{{$en=$e.Current.IsEnabled}}catch{{}}
ConvertTo-Json -Compress -InputObject @{{ok=$true;role=$m.role;name=$m.text;value=$nv;enabled=$en}}"#,
        pid = expected_target.pid,
        idx = binding.raw_ref,
        role = ps_lit(&sig.role),
        text = ps_lit(&sig.text),
        rolechk = if sig.role.is_empty() { "$false" } else { "$true" },
        textchk = if sig.text.is_empty() { "$false" } else { "$true" },
        x = sig.x,
        y = sig.y,
        w = sig.w,
        h = sig.h,
        action = ps_lit(action),
        value = ps_lit(value.unwrap_or("")),
    );
    run_powershell(&script, 8000)
        .ok_or_else(|| "UI Automation 动作超时（8 秒）或 powershell 起不来".to_string())
}

/// 跑一段 PowerShell 并收走 stdout，超时就杀掉。和 macOS 那侧的 run_osa 一个形状。
#[cfg(target_os = "windows")]
fn run_powershell(script: &str, ms: u64) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = crate::process_util::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // 读端和等待必须并行（同 read_ui_elements / sysctl / env_probe 那几处）。
    // **这一处的后果比那几处都重**：调用方 perform_ax_action 已经把 UIA 动作
    // 执行完了（Invoke / Toggle / SetValue 都已发出），才在写回执时卡住 → 8 秒超时 →
    // 返回「动作超时」→ 模型重发 ui_click → **同一个按钮点两次、同一个表单提交两次**。
    // 那几处最坏是读不到东西，这一处是已生效的副作用被报成没生效。
    //
    // 「输出通常小于 4KB 所以不会撑满管道」这个理由不成立：读屏那支脚本对 value 做了
    // 120 字符截断，而这支动作回读**没有任何截断**（$nv 是控件的全部文本）。
    let (tx_o, rx_o) = std::sync::mpsc::channel::<Vec<u8>>();
    match child.stdout.take() {
        Some(mut so) => {
            std::thread::spawn(move || {
                let mut b = Vec::new();
                let _ = so.read_to_end(&mut b);
                let _ = tx_o.send(b);
            });
        }
        None => drop(tx_o),
    }
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }
    // 读字节再解码，不用 read_to_string：非 UTF-8 时 std 会把已读字节**整个回滚**，
    // 拿到的是空串而不是乱码 —— 中文 Windows 上控件文本走 CP936 出管道，
    // 于是一次成功的动作会被报成「没有输出」。decode_process_output 先按 UTF-8 严格解，
    // 解不动才按系统代码页解（tasks.rs:600 那份现成经验的另一半）。
    let raw = rx_o
        .recv_timeout(Duration::from_millis(2000))
        .unwrap_or_default();
    let t = crate::process_util::decode_process_output(&raw).trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn perform_ax_action(
    _binding: &AxRefBinding,
    _action: &str,
    _value: Option<&str>,
    _expected_target: &AccessibilityTarget,
) -> Result<String, String> {
    Err("当前平台暂不支持节点直接操作，请改用坐标点击".to_string())
}

// ===== Apple Vision OCR: extract visible text from ANY app via VNRecognizeTextRequest =====
// Self-drawn apps (WeChat, QQ, games) don't expose AX trees. Vision OCR reads text
// directly from screen pixels — returns text + bounding boxes in screen-point coords,
// same space as AX elements. Compiled once to a cached binary; ~200-500ms per call.

#[cfg(target_os = "macos")]
const VISION_OCR_SWIFT: &str = r#"import Foundation
import Vision
import AppKit

// 只拍**前台窗口**，不拍整屏。整屏 OCR 会把背景里其它 App 的窗口内容一起读出来
// （聊天、邮件、密码管理器都可能在后面开着），而 AX 路径本来就只读前台 App —— 两条
// 路径语义必须一致。
func frontmostWindow() -> (CGWindowID, CGRect)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
    // 列表是从前到后排的，第一个命中的就是该 App 最前面那个窗口。
    for info in infos {
        guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { continue }
        guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let wid = info[kCGWindowNumber as String] as? CGWindowID else { continue }
        guard let bd = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bd) else { continue }
        if rect.width < 1 || rect.height < 1 { continue }
        return (wid, rect)
    }
    return nil
}

// 拿不到前台窗口就**直接返回空**，不退回整屏。
//
// 整屏兜底看着稳妥，实际有两处硬伤：① 它悄悄推翻了"只读前台窗口"这个对模型的承诺，
// 背景窗口内容照样被读走；② 它的坐标根本不是全局屏幕坐标 —— CGRect.null +
// optionOnScreenOnly 返回的是所有在屏窗口外接框的并集，**含窗口阴影**，实测比屏幕
// 宽 48pt（最左侧窗口的阴影越过 x=0）。模型照着这个 x/y 去点会静默点偏。
// 宁可如实返回"没读到"，也不要给一份看着能用、其实点不准又越界的结果。
guard let (wid, rect) = frontmostWindow(),
      let img = CGWindowListCreateImage(CGRect.null, [.optionIncludingWindow], wid,
                                        [.bestResolution, .boundsIgnoreFraming]),
      rect.width >= 1 else { print("[]"); exit(0) }
let originX = Double(rect.origin.x)
let originY = Double(rect.origin.y)
// 比例按**这个窗口**实测，而不是 NSScreen.main —— 窗口在副屏（缩放可能不同）时
// main 的 backingScaleFactor 是错的。
let derivedScale = Double(img.width) / Double(rect.width)
let sc = (derivedScale > 0.1 && derivedScale < 10.0)
    ? derivedScale
    : Double(NSScreen.main?.backingScaleFactor ?? 2.0)
guard sc > 0 else { print("[]"); exit(0) }

let pw = Double(img.width), ph = Double(img.height)
let handler = VNImageRequestHandler(cgImage: img, options: [:])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"]
req.usesLanguageCorrection = true
do { try handler.perform([req]) } catch { print("[]"); exit(0) }
let observations = req.results ?? []
var out = [[String: Any]]()
var idx = 0
for obs in observations {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    // x/y 始终是**全局屏幕坐标（点）**：窗口内偏移 + 窗口在屏幕上的原点。下游点击
    // 用的就是全局坐标，这里若返回窗口相对坐标，点击会静默点错地方。
    let x = originX + b.origin.x * pw / sc
    let y = originY + (1.0 - b.origin.y - b.height) * ph / sc
    let w = b.width * pw / sc
    let h = b.height * ph / sc
    if w < 3 || h < 3 { continue }
    out.append(["ref": idx, "role": "OCRText", "text": String(top.string.prefix(80)),
                "x": (x * 10).rounded() / 10, "y": (y * 10).rounded() / 10,
                "w": (w * 10).rounded() / 10, "h": (h * 10).rounded() / 10,
                "value": "", "enabled": true])
    idx += 1
}
if let j = try? JSONSerialization.data(withJSONObject: out),
   let s = String(data: j, encoding: .utf8) { print(s) } else { print("[]") }
"#;

/// 编译产物的文件名。**版本号是强制重编的唯一开关**：缓存命中只看"文件在不在、
/// 可不可信"，不看内容。改了 `VISION_OCR_SWIFT` 却不改这个名字，老用户跑的永远是
/// 上一版二进制——改动静默失效，而且没有任何报错。
///
/// v2：OCR 从整屏收窄到前台窗口。
/// v3：去掉整屏兜底 —— 它的坐标不是全局屏幕坐标（含窗口阴影，实测越界 48pt）。
///
/// 下面的 `ocr_helper_version_tracks_the_swift_source` 测试把二者钉死，改了源码
/// 不改版本号就会红。
const OCR_HELPER_NAME: &str = "vision-ocr-v3";

/// 已被取代、启动时顺手删掉的历史文件名。
const OCR_HELPER_SUPERSEDED: &[&str] = &["vision-ocr-v2"];

/// v1 的真实残留路径。它当年就放在全局可写的 `/tmp` 下（正是后来搬进 `$HOME` 的原因），
/// 所以清理必须按绝对路径来 —— 按新目录里的文件名删等于什么都没删。
///
/// `remove_file` 不跟随符号链接（删的是链接本身），所以对着 `/tmp` 这种全局可写路径
/// 调用它不会被预置软链骗去删别处的文件。
const OCR_HELPER_LEGACY_ABS: &[&str] = &[
    "/tmp/michael_ide_vision_ocr_v1",
    "/tmp/michael_ide_vision_ocr_v1.swift",
];

/// OCR 辅助程序的私有目录：`$HOME/.mrdayone/bin`，权限 0700。
#[cfg(target_os = "macos")]
fn ocr_helper_dir() -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home)
        .join(crate::mcp::app_dir_name())
        .join("bin");
    std::fs::create_dir_all(&dir).ok()?;
    // 只有自己能进：即使别人猜到路径也放不进文件。
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    Some(dir)
}

/// 这个二进制是不是我们自己编出来的、且没被别人动过手脚。
///
/// 判据：存在、**不是符号链接**、属主是当前用户、且组/其他人都没有写权限。任何一条不满足
/// 都当作不可信 —— "存在即信任"正是这条漏洞的核心。
#[cfg(target_os = "macos")]
fn ocr_helper_is_trustworthy(bin: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    // symlink_metadata 不跟随软链——用 metadata 的话软链会伪装成正常文件。
    let Ok(meta) = std::fs::symlink_metadata(bin) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return false;
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        return false;
    }
    meta.permissions().mode() & 0o022 == 0
}

#[cfg(target_os = "macos")]
pub fn read_ocr_elements() -> Vec<UiElement> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    // 私有目录，不用 /tmp。
    //
    // `/tmp` 是全局可写的固定路径：任何本机进程（包括某个依赖的 postinstall 脚本）都能
    // 预先放一个同名二进制，而这里只判 `exists()` 就直接执行它 —— 于是它继承了 IDE 的
    // **屏幕录制权限**，能拍到你整个屏幕。同理 `fs::write` 会跟随符号链接，预置一个软链
    // 就能让我们把内容写到任意可写位置。
    //
    // 换成 $HOME 下的 0700 目录后，别的用户进不来；再加执行前校验，同用户下的其它进程
    // 也没法用预置文件骗我们执行。
    let Some(dir) = ocr_helper_dir() else {
        return Vec::new();
    };
    let bin = dir.join(OCR_HELPER_NAME);
    // 清掉历史版本，别在用户目录里留一堆再也不会用的二进制。
    for stale in OCR_HELPER_SUPERSEDED {
        let _ = std::fs::remove_file(dir.join(stale));
        let _ = std::fs::remove_file(dir.join(format!("{stale}.swift")));
    }
    for legacy in OCR_HELPER_LEGACY_ABS {
        let _ = std::fs::remove_file(legacy);
    }

    if !ocr_helper_is_trustworthy(&bin) {
        // 存在但不可信（是软链、属主不对、或组/其他人可写）→ 删掉重编，绝不执行。
        let _ = std::fs::remove_file(&bin);
        let src_path = dir.join(format!("{OCR_HELPER_NAME}.swift"));
        let _ = std::fs::remove_file(&src_path);
        let src = match src_path.to_str() {
            Some(s) => s.to_string(),
            None => return Vec::new(),
        };
        if std::fs::write(&src, VISION_OCR_SWIFT).is_err() {
            return Vec::new();
        }
        let arch = std::env::consts::ARCH;
        let target = format!(
            "{}-apple-macos14.0",
            if arch == "aarch64" { "arm64" } else { "x86_64" }
        );
        let ok = crate::process_util::command("swiftc")
            .args([
                "-O",
                "-target",
                &target,
                "-o",
                bin.to_str().unwrap_or(""),
                &src,
            ])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Vec::new();
        }
    }

    let mut child = match crate::process_util::command(&bin)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let deadline = Instant::now() + Duration::from_millis(5000);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Vec::new();
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Vec::new(),
        }
    }

    let mut s = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut s);
    }
    serde_json::from_str::<Vec<UiElement>>(s.trim()).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub fn read_ocr_elements() -> Vec<UiElement> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    fn element(raw_ref: u32) -> UiElement {
        UiElement {
            ref_: raw_ref,
            role: "Button".to_string(),
            text: "Save".to_string(),
            x: 0.0,
            y: 0.0,
            w: 20.0,
            h: 20.0,
            value: String::new(),
            enabled: true,
        }
    }

    #[cfg(target_os = "macos")]
    fn signature_gate_result(
        expected: &AxElementSignature,
        actual: &AxElementSignature,
    ) -> serde_json::Value {
        let context = serde_json::json!({"expected": expected, "actual": actual});
        let context_json = serde_json::to_string(&context).expect("test signatures should encode");
        let script = r#"(function(){
__SIGNATURE_HELPER__
var ctx=__CONTEXT__;
var operated=false;
var changed=axSignatureChanges(ctx.expected,ctx.actual);
if(changed.length) return JSON.stringify({operated:operated,changed:changed});
operated=true;
return JSON.stringify({operated:operated,changed:changed});
})()"#
            .replace("__SIGNATURE_HELPER__", AX_SIGNATURE_HELPER_JS)
            .replace("__CONTEXT__", &context_json);
        let output = run_osa(&script, 1000).expect("signature gate JXA should run");
        serde_json::from_str(&output).expect("signature gate should return JSON")
    }

    #[test]
    fn failed_action_result_is_an_error() {
        let error = parse_action_result(r#"{"ok":false,"err":"AX set_value failed"}"#)
            .expect_err("a failed AX result must not resolve as a successful command");
        assert_eq!(error, "AX set_value failed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refs_are_invalidated_when_a_new_snapshot_is_installed() {
        clear_latest_ax_refs().expect("state should be writable");
        let mut first = UiSnapshot {
            target: Some(AccessibilityTarget {
                pid: 101,
                name: "First".to_string(),
            }),
            elements: vec![element(7)],
            page: None,
            read_error: None,
            ..Default::default()
        };
        install_ax_snapshot(&mut first, true).expect("first snapshot should install");
        let first_ref = first.elements[0].ref_;
        let (binding, target) = resolve_ax_ref(first_ref).expect("first ref should resolve");
        assert_eq!(binding.raw_ref, 7);
        assert!(binding.native, "快路装进去的 binding 必须记着自己是快路来的");
        assert_eq!(
            binding.signature,
            AxElementSignature::from(&first.elements[0])
        );
        assert_eq!(target.pid, 101);

        let mut second = UiSnapshot {
            target: Some(AccessibilityTarget {
                pid: 202,
                name: "Second".to_string(),
            }),
            elements: vec![element(3)],
            page: None,
            read_error: None,
            ..Default::default()
        };
        install_ax_snapshot(&mut second, false).expect("second snapshot should install");
        assert_ne!(first_ref, second.elements[0].ref_);
        assert!(resolve_ax_ref(first_ref).is_err());
        let (second_binding, _) =
            resolve_ax_ref(second.elements[0].ref_).expect("second ref should resolve");
        assert!(
            !second_binding.native,
            "老路装进去的 binding 不能被当成快路——那会拿 JXA 的下标去查句柄表"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn windows_read_reports_why_it_came_back_empty() {
        // Windows 上读屏有三种失败：powershell 起不来、UIA 超时、输出不是合法 JSON。
        // 原来三种全都静默 return 空——于是「读失败了」和「这个应用真的没有可访问性树」
        // 长得一模一样，而下游对这两件事的处置完全相反（一个该重试或切前台，
        // 一个该换手段）。空结果因此被包装成一句假话交给模型。
        //
        // 只在 mac 上跑 cargo check 是发现不了这类问题的——Windows 那条分支根本不参与
        // 编译。这条改动就是靠 `cargo xwin check --target x86_64-pc-windows-msvc`
        // 才发现签名没改全、编不过的。断言源码，因为这里编不出 Windows 的运行时。
        let src: String = include_str!("accessibility.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // 第三项是失败原因，第二项是目标应用身份（后加的，见
        // windows_read_reports_the_target_app）。needle 拼出来，别写成完整字面量——
        // 否则这个断言会被它自己喂饱。
        let win_sig = format!(
            "{} -> (Vec<UiElement>, Option<AccessibilityTarget>, Option<String>)",
            "pub fn read_ui_elements()"
        );
        assert!(
            src.contains(&win_sig),
            "Windows 的 read_ui_elements 必须把失败原因带出来，不能只返回元素"
        );
        for reason in ["powershell 起不来", "UI Automation 读取超时", "不是合法 JSON"] {
            assert!(src.contains(reason), "少了一种失败原因：{reason}");
        }
        // OCR 兜底只有 macOS 有实现；在别的平台上把模型指过去是送进死路。
        assert!(
            src.contains("no OCR fallback on this platform"),
            "非 macOS 平台不能建议用 ocr=true —— 那条路在那儿恒返回空"
        );
    }

    #[test]
    fn a_successful_read_still_says_what_it_could_not_see() {
        // AX 树只覆盖可见的那一屏（实测：浏览器把几何裁到可见区，折叠以下的内容
        // 不出现或被压扁成零高度然后被过滤）。而 500 上限是静默生效的——被砍过的
        // 清单和完整的清单长得一模一样。这两件事不说，模型会把「没滚到」和「被截断」
        // 都读成「这东西不存在」，然后基于假话往下决策。
        // needle 拼出来，否则这个测试自己会被数进去。
        let src: String = include_str!("accessibility.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let viewport = format!("{} VISIBLE", "CURRENTLY");
        let truncated = format!("{} TRUNCATED", "WAS");
        let cap_check = format!("elements.len() {} 500", ">=");
        assert_eq!(
            src.matches(&viewport).count(),
            1,
            "成功读取时必须说明这只是可见的那一屏"
        );
        assert_eq!(
            src.matches(&truncated).count(),
            1,
            "触到上限时必须说明清单被截断了"
        );
        assert_eq!(
            src.matches(&cap_check).count(),
            1,
            "截断说明要真的按元素数判断，不能写死"
        );
    }

    /// 产品代码那一段（切掉 #[cfg(test)] 往后）。
    ///
    /// 必须切：`include_str!` 读的是整个文件，**包含这些测试自己**。于是
    /// `src.contains("if let Some(want) = target_pid {")` 会被断言里的那个字面量喂饱——
    /// 把实现整个删掉它还是绿的。这个仓库已经踩过好几次，实测本轮又逃掉两条。
    fn prod_src() -> String {
        let all = include_str!("accessibility.rs");
        let end = all.find("#[cfg(test)]").unwrap_or(all.len());
        all[..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 快路读来的 ref，动作也必须走快路。
    ///
    /// 这两条路的 ref 编号语义不同（快路是句柄表编号、1 起步、深度优先；老路是重排后
    /// 数组的下标、0 起步、按控件类型分四桶），互相拿错就是点到别的元素上。而且症状
    /// 极具误导性：签名校验会把它拒成「界面变了，重新 read_screen」，模型于是重读重试，
    /// 陷进一个理由是假的死循环里。
    ///
    /// 曾经的实际状态是**动作侧压根没有分流**：读屏已经换成原生 AX，ui_click 却仍然
    /// 无条件走 JXA，于是每点一次都要把整棵树重新枚举一遍（实测 Chrome 5.3 秒、
    /// 日历 20.8 秒，而预算只有 6 秒），慢和点错同时发生。
    #[test]
    fn native_refs_act_through_the_native_path() {
        let src = prod_src();
        let start = src
            .find("pub async fn ui_click(")
            .expect("ui_click 不见了");
        let end = src[start..]
            .find("\nfn parse_action_result")
            .map(|i| start + i)
            .unwrap_or(src.len());
        let body = &src[start..end];

        let dispatch = body
            .find("if binding.native")
            .expect("ui_click 没有按 ref 的来路分流——快路的 ref 会被送进 JXA 老路");
        let jxa = body
            .find("spawn_blocking")
            .expect("JXA 兜底那条不见了；快路跑不成时就没有退路了");
        assert!(
            dispatch < jxa,
            "分流判断排在 JXA 调用后面，等于没分流"
        );
        assert!(
            body.contains("native_ax_action"),
            "分流之后没有走原生动作"
        );

        // 快路动作必须真的发 screen.act。写成别的方法名（比如复用 screen.elements）
        // 会把句柄表整张换掉，正在操作的那批 ref 当场全废。
        let act_start = src
            .find("async fn native_ax_action(")
            .expect("native_ax_action 不见了");
        let act_end = src[act_start..]
            .find("\nfn ")
            .map(|i| act_start + i)
            .unwrap_or(src.len());
        assert!(
            src[act_start..act_end].contains("\"screen.act\""),
            "原生动作没走 screen.act"
        );

        // read_screen 判「这次算不算快路」的条件，必须和它选快照的条件一致。
        // 不一致的表现是静默的：读回空清单时会落回老路，而 ref 仍被标成快路来的。
        let rs = src
            .find("pub async fn read_screen(")
            .expect("read_screen 不见了");
        let rs_end = src[rs..]
            .find("\nfn ")
            .map(|i| rs + i)
            .unwrap_or(src.len());
        let rs_body = &src[rs..rs_end];
        assert!(
            rs_body.contains("is_some_and(|s| !s.elements.is_empty())"),
            "快路判据和选快照的条件不再一致——读回空清单时会把 JXA 的 ref 标成快路来的"
        );
    }

    /// 「页面还在加载」这条提醒，两条读屏路都必须给得出来。
    ///
    /// 它防的是一个很具体的错判：可访问性树只反映**此刻**渲染出来的东西，一个加载了
    /// 一半的页面和一个加载完的短页面在结果里长得一模一样。没有这条提醒，模型会把
    /// 「还没渲染出来」当成「这页没有这个按钮」，然后基于这句假话往下决策——而在浏览器上
    /// 做自动化正是这条链最主要的用法。
    ///
    /// 曾经的实际状态：JXA 老路一直顺路读 AXWebArea 的 AXLoaded/AXLoadingProgress，
    /// 而快路上线时把 page 硬写成了 None——于是这道防线在**默认路径**上静默失效，
    /// 旁边的注释却还在描述它仍然生效。所以这里钉的是"快路没有把它写死成 None"。
    #[cfg(target_os = "macos")]
    #[test]
    fn both_read_paths_can_report_page_loading() {
        let src = prod_src();
        let at = src
            .find("async fn native_snapshot_via_sidecar(")
            .expect("快路读屏不见了");
        let end = src[at..]
            .find("\n#[cfg(not(target_os = \"macos\"))]")
            .map(|i| at + i)
            .unwrap_or(src.len());
        let body = &src[at..end];
        assert!(
            !body.contains("page: None"),
            "快路又把 page 写死成 None 了——浏览器上读到半渲染页面时模型收不到任何提示"
        );
        assert!(
            body.contains("get(\"page\")"),
            "快路没有从 sidecar 的回执里取 page"
        );

        // 对端要真的发这个字段。只看本地这一半的话，sidecar 哪天不发了这边照样绿。
        let rpc = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../automation-framework/src/rpc.rs"),
        )
        .expect("读不到 sidecar 的 rpc.rs");
        assert!(
            rpc.contains("\"page\": page,"),
            "sidecar 的 screen.elements 回执里没有 page 字段"
        );
    }

    /// 快路必须认得 `ui_click` 放行的**每一个**动作。
    ///
    /// 这两份清单在两个 crate 里各写一份（本文件的 `matches!` 和 automation-framework 的
    /// `macos_tree::act`），中间没有任何类型把它们绑在一起——正是最容易悄悄漂开的形状。
    /// 漂开的后果不是"那个动作报不支持"：快路认不得就退回 JXA 老路，而老路的 ref 是另一套
    /// 编号（0 起步、按控件类型分四桶重排），退回去会**点到别的元素上**，还慢几秒。
    /// 加这个动作的人多半只改一边，所以判据放在这里，红了就知道另一边也要补。
    #[cfg(target_os = "macos")]
    #[test]
    fn the_fast_path_knows_every_action_ui_click_allows() {
        let src = prod_src();
        let at = src.find("pub async fn ui_click(").expect("ui_click 不见了");
        let list_start = src[at..].find("matches!(").expect("放行清单不见了") + at;
        // 收尾必须钉 `matches!` 那个括号本身。钉 ")\n" 会一路吃到底下那句错误文案里，
        // 于是整句提示被当成一个"动作名"，测试红得莫名其妙（实测踩过一次）。
        let list_end = src[list_start..]
            .find("\n    ) {")
            .expect("放行清单没有收尾")
            + list_start;
        let allowed: Vec<String> = src[list_start..list_end]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect();
        assert!(
            allowed.len() >= 10,
            "只解析出 {} 个动作，清单的写法大概变了：{allowed:?}",
            allowed.len()
        );

        let act_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../automation-framework/src/platform/macos_tree.rs");
        let act_src = std::fs::read_to_string(&act_path)
            .unwrap_or_else(|e| panic!("读不到 {}：{e}", act_path.display()));
        let at = act_src.find("pub fn act(").expect("act() 不见了");
        // 必须**切到 act() 结束**，不能一路取到文件尾。取到文件尾的话，同一文件里
        // `#[cfg(test)] mod tests` 中的 `super::act(999_999, "press", None)` 之类会把
        // 断言喂绿：删掉 act() 里的 "press" 分支，测试代码里那个字符串仍在，门照样过。
        // 实测过——show_menu 只在实现里出现，删了会红；press/focus/set_value 在测试里
        // 也出现，删了不红。同一个测试对最常用的三个动作是瞎的，那才是最坏的一种。
        let body_end = act_src[at..]
            .find("\n#[cfg(test)]")
            .or_else(|| act_src[at..].find("\n/// 只读**这一个**元素的签名"))
            .map(|i| at + i)
            .expect("找不到 act() 的结尾；切片判据要跟着代码结构改");
        let body = &act_src[at..body_end];

        // 老路（JXA）那份白名单也要覆盖全部动作。漏一个的后果和快路漏一个不同但一样坏：
        // 请求在 build_ax_action_script 里就被拦成 "unsupported accessibility action"，
        // 而脚本里的实现明明写着——模型收到的是「这个动作不存在」这句假话。
        // scroll_to 就这么漏了一段时间。
        let wl_start = src
            .find("let act = match action {")
            .expect("JXA 那份动作白名单不见了");
        let wl_end = src[wl_start..].find("};").expect("白名单没有收尾") + wl_start;
        let whitelist = &src[wl_start..wl_end];
        for action in &allowed {
            assert!(
                whitelist.contains(&format!("\"{action}\"")),
                "JXA 兜底路的白名单漏了「{action}」——脚本里有实现也走不到，\
                 模型会收到一句「这个动作不存在」的假话"
            );
        }

        for action in &allowed {
            // 钉的是**match 分支的形状**（`"press" =>`），不是"这个字符串在 act() 里出现过"。
            // 后者是空门：每个分支的回执 JSON 里都写着 `"action": "press"`，把分支删掉
            // 那个字符串照样在，断言照样绿。实测过——只删 `"press" => {` 这一行，
            // 旧判据一声不吭。直接分支和映射表（`"increment" => "AXIncrement"`）都是这个形状。
            assert!(
                body.contains(&format!("\"{action}\" =>")),
                "快路的 act() 不认得「{action}」——这个动作会退回 JXA 老路，\
                 而老路的 ref 是另一套编号，退回去会点到别的元素上"
            );
        }
    }

    /// 探查读法**不许**碰 ref 表。
    ///
    /// background_monitor 的 screen 检查每几秒读一次屏。read_screen 每次开头都
    /// `clear_latest_ax_refs()`、结尾 `install_ax_snapshot()` 换掉整张表，所以只要
    /// probe_screen 哪天图省事复用了那条路（或者有人把它接回 screen.elements），
    /// 后台轮询就会把模型上一次读屏拿到的 ref 一批批作废——而模型只会看到
    /// 「ref 已过期」，根本不知道是谁弄没的。这是这条功能唯一要防的事。
    #[test]
    fn probe_never_touches_the_ref_table() {
        let src = prod_src();
        let start = src
            .find("pub async fn probe_screen(")
            .expect("probe_screen 不见了");
        let end = src[start..]
            .find("\npub async fn ")
            .map(|i| start + i)
            .unwrap_or(src.len());
        let body = &src[start..end];
        assert!(
            !body.contains("clear_latest_ax_refs"),
            "probe_screen 清了 ref 表——每轮轮询都会作废模型手里的 ref"
        );
        assert!(
            !body.contains("install_ax_snapshot"),
            "probe_screen 装了新 ref 表——旧 ref 会被顶掉"
        );
        assert!(
            body.contains("screen.probe"),
            "probe_screen 没走 sidecar 的探查方法；screen.elements 会换掉句柄表"
        );
        // sidecar 特意回了 refs_installed 说明这次读动没动句柄表，这里必须真的**查**它。
        // 钉的是那个判断表达式，不是这三个字母：错误文案里也有 refs_installed，
        // 只钉字符串的话把 if 改成 `if false` 照样绿（实测逃掉过一次）。
        let needle = format!("get(\"refs_{}\").and_then(|v| v.as_bool()) == Some(true)", "installed");
        assert!(
            body.contains(&needle),
            "没有真的校验 sidecar 回的 refs_installed——对端语义变了这边发现不了"
        );
    }

    /// 动作不再要求目标在最前面，但身份校验一道都不能少。
    ///
    /// 原来 JXA 动作脚本用 `whose({frontmost:true})`：于是即便 read_screen 读到了一个
    /// 后台应用，动作也必然被拒——读得到、点不了。那句 frontmost 真正在防的是
    /// 「在 A 上读的 ref 被拿到 B 上执行」，防住它的是 pid + 应用名两道校验。
    #[test]
    fn action_targets_by_pid_not_by_who_is_in_front() {
        let src = prod_src();
        let start = src.find("const AX_ACTION_JS").expect("动作脚本不见了");
        let end = start + src[start..].find("})()").expect("动作脚本没结尾");
        let js = &src[start..end];
        assert!(
            js.contains("whose({ unixId: CTX.pid })"),
            "动作脚本没有按 pid 定位目标"
        );
        assert!(
            !js.contains("whose({ frontmost: true })"),
            "动作脚本又绑回前台了——指定目标读得到却点不了"
        );
        // 两道身份校验一道都不能少：pid 会被复用，名字单独也不够。
        assert!(js.contains("actualPid!==CTX.pid"), "少了 pid 回读校验");
        assert!(
            js.contains("actualAppName!==CTX.appName"),
            "少了应用名校验——pid 复用时会点到新进程上"
        );
        // 两个名字空间都要认：快路记显示名（访达），慢路记可执行名（Finder）。
        // 只认一个的话，中文系统上按 ref 点击会被这道校验全部硬拒。
        assert!(
            js.contains("actualShown!==CTX.appName"),
            "只认一个名字空间——中文系统上按 ref 点击会被身份校验全部拒掉"
        );
        assert!(
            js.contains("proc.displayedName()"),
            "没读显示名，没法和快路记下的身份对上"
        );
    }

    /// 目标读回来的必须**真是它**，对不上宁可报错。
    #[test]
    fn a_mismatched_target_is_an_error_not_a_silent_fallback() {
        let src = prod_src();
        assert!(
            src.contains("if let Some(want) = target_pid {"),
            "read_screen 没有校验读回来的是不是指定的那个应用"
        );
        assert!(
            src.contains("结果已丢弃"),
            "身份对不上时没有丢弃结果——模型会拿别的应用的 ref 去点"
        );
        // 名字解析不到也必须报错，不能悄悄退回读前台。
        assert!(
            src.contains("没有找到名字里含"),
            "应用名找不到时没有报错——静默读前台是最坏的一种失败"
        );
    }

    #[test]
    fn both_ax_scans_skip_windows_the_user_cannot_click() {
        // 最小化的窗口交出来的是失效坐标，照着点会落在空处；浏览器还会挂 1x1 的隐藏工具窗。
        // 两处扫描都必须先筛窗口再取内容，否则末尾的截断会拿点不到的元素挤掉真元素。
        // 断言实现特征而不是说明词，并且 needle 要拼出来——写成完整字面量的话，
        // 这个测试自己就会被数进去，两处变成三处。
        let src: String = include_str!("accessibility.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let minimized = format!("{}{}", "AX", "Minimized");
        let filtered = format!("usable[wi].{}()", "entireContents");
        let raw = format!("wins[wi].{}()", "entireContents");
        assert_eq!(src.matches(&minimized).count(), 2, "两处 JXA 扫描都要跳过最小化窗口");
        assert_eq!(src.matches(&filtered).count(), 2, "取内容必须走筛过的窗口列表");
        assert_eq!(src.matches(&raw).count(), 0, "还有地方在直接遍历未筛选的窗口");
    }

    // 这条用的 element / signature_gate_result 两个辅助函数都带 macOS 门，
    // 而它自己没有——于是 `cargo test` 在 Windows 上根本编不过（E0425）。
    // 补上门，让 Windows 也能跑测试。
    /// 反漂移：Windows 的按 ref 操作不许退回成一句 Err。
    ///
    /// 它以前就是「当前平台暂不支持节点直接操作，请改用坐标点击」——读屏在
    /// Windows 上是真的，但读完之后动不了，读和动之间是断的。
    /// 断言实现特征（UIA 模式名、签名核对、前台身份核对），不断言说明词，
    /// 并且先剥掉注释——注释里会引用被修掉的旧写法，能把断言喂饱。
    #[test]
    fn windows_ref_actions_are_implemented_not_stubbed() {
        let src: String = include_str!("accessibility.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // 老的桩：整个函数体就是这一句 Err。Windows 分支里不该再有它。
        // 锚到动作函数本身，而不是"第一个 Windows 块"——第一个是读屏。
        let at = src
            .find("fn perform_ax_action(\n    binding: &AxRefBinding,")
            .expect("应该有 Windows 版的 perform_ax_action（带实名参数，不是 _binding 的桩）");
        let win = &src[at..];
        assert!(
            win.contains("InvokePattern"),
            "Windows 的按 ref 操作没走 UI Automation 的 Invoke"
        );
        for pat in ["TogglePattern", "SelectionItemPattern", "ValuePattern", "ExpandCollapsePattern"] {
            assert!(src.contains(pat), "少了 {pat} 这条退路——只认 Invoke 的话开关和列表项都点不动");
        }
        assert!(
            src.contains("element changed since read_screen"),
            "Windows 动作前必须核对签名，否则界面动过之后同一个序号会落到别的元素上"
        );
        assert!(
            src.contains("foreground app changed"),
            "Windows 动作前必须核对前台还是不是读屏时那个应用"
        );
    }

    /// 反漂移：Windows 的读屏必须把前台应用身份一起带回来。
    ///
    /// 少了它，install_ax_snapshot 见 target 为 None 直接早退，ref 表一条不存，
    /// 于是 ui_click 拿到的 ref 没有任何可校验的东西——而这个失效是完全静默的。
    #[test]
    fn windows_read_reports_the_target_app() {
        let src: String = include_str!("accessibility.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            src.contains("GetWindowThreadProcessId"),
            "Windows 读屏脚本没有取前台窗口的 pid"
        );
        // needle 拼出来：写成完整字面量的话，这个断言自己就会成为它要找的东西。
        let three = format!("let (elements, {}, read_error) = {}", "target", "read_ui_elements();");
        assert!(
            src.contains(&three),
            "read_ui_snapshot 应该接收并透传 target；不透传的话 install_ax_snapshot 会早退，ref 表一条不存"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn same_pid_reordering_fails_signature_gate_before_operation() {
        let expected = AxElementSignature::from(&element(0));
        let mut replacement = element(0);
        replacement.text = "Delete".to_string();
        replacement.x = 100.0;
        replacement.value = "danger".to_string();
        replacement.enabled = false;
        let actual = AxElementSignature::from(&replacement);

        let rejected = signature_gate_result(&expected, &actual);
        assert_eq!(rejected["operated"], false);
        let changed = rejected["changed"]
            .as_array()
            .expect("changed fields should be an array");
        for field in ["text", "x", "value", "enabled"] {
            assert!(changed.iter().any(|changed| changed == field));
        }

        let accepted = signature_gate_result(&expected, &expected);
        assert_eq!(accepted["operated"], true);
        assert_eq!(accepted["changed"], serde_json::json!([]));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn action_script_checks_full_signature_without_keyboard_fallback() {
        let target = AccessibilityTarget {
            pid: 4242,
            name: "Target".to_string(),
        };
        let source = element(9);
        let binding = AxRefBinding {
            raw_ref: 9,
            signature: AxElementSignature::from(&source),
            // 这条测的是 JXA 脚本生成器，也就是**老路**：老路的 ref 才是下标语义。
            native: false,
        };
        let script = build_ax_action_script(
            &binding,
            "set_value",
            Some("literal __PID__ and \"quotes\""),
            &target,
        )
        .expect("valid action should produce a script");

        assert!(script.contains("\"pid\":4242"));
        assert!(script.contains("\"reference\":9"));
        assert!(script.contains("actualPid!==CTX.pid"));
        assert!(script.contains("axElementSignature(el,role,p,s)"));
        assert!(script.contains("axSignatureChanges(CTX.signature,candidate.signature)"));
        assert!(script.contains(r#"literal __PID__ and \"quotes\""#));
        assert!(!script.contains("keystroke"));
        assert!(!script.contains("__SIGNATURE_BUILDERS__"));
        assert!(!script.contains("__SIGNATURE_HELPER__"));
        assert!(!script.contains("__CONTEXT__"));

        let gate = script
            .find("if(changed.length)")
            .expect("signature gate should exist");
        for operation in ["el.value = VAL", "el.focused = true", "el.click()"] {
            assert!(gate < script.find(operation).expect("AX operation should exist"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn action_script_supports_extended_ax_actions() {
        let target = AccessibilityTarget {
            pid: 7,
            name: "App".to_string(),
        };
        let binding = AxRefBinding {
            raw_ref: 3,
            signature: AxElementSignature::from(&element(3)),
            native: false,
        };
        // Every extended action must be accepted by the builder and map to a real AX verb.
        for (action, ax_verb) in [
            ("increment", "AXIncrement"),
            ("decrement", "AXDecrement"),
            ("show_menu", "AXShowMenu"),
            ("confirm", "AXConfirm"),
            ("cancel", "AXCancel"),
            ("pick", "AXPick"),
        ] {
            let script = build_ax_action_script(&binding, action, None, &target)
                .unwrap_or_else(|_| panic!("action {action} should build a script"));
            assert!(
                script.contains(ax_verb),
                "{action} must map to {ax_verb} in the action script"
            );
            // The named-action executor and its signature gate must both be present.
            assert!(script.contains("var axPerform = function"));
            assert!(script.contains("axSignatureChanges(CTX.signature,candidate.signature)"));
        }
        // Unknown actions are still rejected before ever reaching osascript.
        assert!(build_ax_action_script(&binding, "nuke", None, &target).is_err());
    }

    /// 自己实现 FNV-1a 而不是用 `DefaultHasher`：后者的输出不保证跨 Rust 版本稳定，
    /// 拿它钉常量会在某次工具链升级后毫无理由地变红。
    #[cfg(target_os = "macos")]
    fn fnv1a(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h
    }

    /// 改了 `VISION_OCR_SWIFT` 就必须 bump `OCR_HELPER_NAME` 的版本号。
    ///
    /// 为什么值得一个测试：缓存命中只看文件在不在，不看内容。改了源码不改名字，
    /// 用户机器上那个旧二进制会被一直复用——**没有任何报错**，只是新逻辑永远不生效。
    /// 这类"静默不生效"是最难在自测里发现的，所以在编译期就钉死。
    ///
    /// 红了怎么办：确认 `OCR_HELPER_NAME` 版本号已 +1、旧名字已进
    /// `OCR_HELPER_SUPERSEDED`，然后把下面两个常量更新成报错里给出的新值。
    #[cfg(target_os = "macos")]
    #[test]
    fn ocr_helper_version_tracks_the_swift_source() {
        const EXPECTED_SWIFT_HASH: u64 = 16_520_559_861_853_164_212;
        const EXPECTED_HELPER_NAME: &str = "vision-ocr-v3";

        let actual = fnv1a(VISION_OCR_SWIFT.as_bytes());
        assert_eq!(
            OCR_HELPER_NAME, EXPECTED_HELPER_NAME,
            "改了 OCR_HELPER_NAME 就要同步这里的 EXPECTED_HELPER_NAME"
        );
        assert_eq!(
            actual, EXPECTED_SWIFT_HASH,
            "VISION_OCR_SWIFT 变了。必须把 OCR_HELPER_NAME 的版本号 +1、\
             把旧名字加进 OCR_HELPER_SUPERSEDED，再把 EXPECTED_SWIFT_HASH 改成 {actual}；\
             否则用户机器上的旧二进制会被继续复用，改动静默失效。"
        );
    }

    /// Swift 源码的几个**语义**不变量。哈希只能告诉你"变了"，说不出"变坏了"；
    /// 这些断言盯的是一旦丢掉就会静默出错的东西。
    #[cfg(target_os = "macos")]
    #[test]
    fn ocr_swift_stays_scoped_to_the_frontmost_window_in_global_coordinates() {
        let src = VISION_OCR_SWIFT;
        assert!(
            src.contains("frontmostApplication"),
            "必须按前台 App 挑窗口，否则又变回整屏 OCR（会读到背景窗口内容）"
        );
        assert!(src.contains("optionIncludingWindow"), "必须只截目标窗口");
        assert!(
            src.contains("boundsIgnoreFraming"),
            "少了它截图会带窗口阴影，比例推导和坐标偏移全部偏掉"
        );
        // 坐标必须叠回窗口原点。丢了这两个加法，返回的就是窗口相对坐标，
        // 而下游点击用的是全局坐标——点击会静默点错位置，不报任何错。
        assert!(
            src.contains("originX + b.origin.x"),
            "x 必须叠加窗口原点，保持全局屏幕坐标"
        );
        assert!(
            src.contains("originY + (1.0 - b.origin.y"),
            "y 必须叠加窗口原点，保持全局屏幕坐标"
        );
        // 反过来：**不允许**存在整屏兜底。
        //
        // 兜底看着稳妥，实测有两处硬伤：它悄悄推翻了"只读前台窗口"这个对模型的承诺；
        // 而且 CGRect.null + optionOnScreenOnly 返回的是所有在屏窗口外接框的并集、
        // 含窗口阴影，比屏幕宽 48pt —— 吐出的 x/y 根本不是全局屏幕坐标，模型照着点
        // 会静默点偏。拿不到前台窗口就如实返回空。
        assert!(
            !src.contains("optionOnScreenOnly, kCGNullWindowID"),
            "不能退回整屏抓取：它的坐标不是全局屏幕坐标，而且会读到背景窗口"
        );
    }
}
