//! 前台应用的可访问性树快照——**原生 AX API 版本**。
//!
//! 为什么要有这个：原来读屏走的是 JXA / System Events，而 JXA 每访问一次属性就是
//! 一次独立的 Apple Event 往返。实测（本机 M 芯片、Chrome 一个真实窗口）：
//!   · entireContents() 拿到 6701 个元素，2.0 秒
//!   · 只读其中 500 个元素的 5 个属性：**95 秒**，平均每个元素 190 毫秒
//! 而读屏的超时上限是 6 秒——也就是说在任何真实应用上它**必然超时**。用户看到的
//! 「read_screen 一直超时、智能体在那儿发呆」就是这么来的。
//!
//! 换成原生 AX：AXUIElementCopyAttributeValue 是进程内的 C 调用，同一棵树几十毫秒。
//!
//! 两个坑写在这里，省得下次再踩：
//!   1. AXPosition / AXSize 返回的是 **AXValueRef**，不是 CFDictionary。必须用
//!      AXValueGetValue 按 CGPoint / CGSize 取出来，downcast 成字典会静默失败。
//!   2. AX 调用会阻塞在没响应的应用上。AXUIElementSetMessagingTimeout 必须设，
//!      否则一个卡死的窗口能把整次读取拖死。

#![cfg(target_os = "macos")]

use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFRelease, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use std::ptr;

/// 两个平台共用的数据形状和纯逻辑（见 tree_types.rs）。
pub use super::tree_types::{
    no_such_app, signature_drift, AppDetails, AppMatch, AxNode, ListenPort, PageState, WinTitle,
};

#[repr(C)]
struct __AXUIElement(std::ffi::c_void);
type AXUIElementRef = *const __AXUIElement;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

const K_AXVALUE_CGPOINT: u32 = 1;
const K_AXVALUE_CGSIZE: u32 = 2;

extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> i32;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, out: *mut std::ffi::c_void) -> bool;
}



unsafe fn attr_f64(el: AXUIElementRef, name: &str) -> Option<f64> {
    let v = copy_attr(el, name)?;
    v.downcast::<CFNumber>().and_then(|n| n.to_f64())
}

unsafe fn copy_attr(el: AXUIElementRef, name: &str) -> Option<CFType> {
    let key = CFString::new(name);
    let mut out: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out) == 0 && !out.is_null()
    {
        Some(CFType::wrap_under_create_rule(out))
    } else {
        None
    }
}

unsafe fn attr_string(el: AXUIElementRef, name: &str) -> Option<String> {
    let v = copy_attr(el, name)?;
    v.downcast::<CFString>().map(|s| s.to_string())
}

unsafe fn attr_bool(el: AXUIElementRef, name: &str) -> Option<bool> {
    let v = copy_attr(el, name)?;
    v.downcast::<CFBoolean>().map(|b| b.into())
}

unsafe fn attr_point(el: AXUIElementRef, name: &str) -> Option<(i32, i32)> {
    let v = copy_attr(el, name)?;
    let mut p = CGPoint::default();
    if AXValueGetValue(
        v.as_CFTypeRef(),
        K_AXVALUE_CGPOINT,
        &mut p as *mut _ as *mut std::ffi::c_void,
    ) {
        Some((p.x as i32, p.y as i32))
    } else {
        None
    }
}

unsafe fn attr_size(el: AXUIElementRef, name: &str) -> Option<(i32, i32)> {
    let v = copy_attr(el, name)?;
    let mut s = CGSize::default();
    if AXValueGetValue(
        v.as_CFTypeRef(),
        K_AXVALUE_CGSIZE,
        &mut s as *mut _ as *mut std::ffi::c_void,
    ) {
        Some((s.width as i32, s.height as i32))
    } else {
        None
    }
}

/// 元素的可读文本。AXTitle 最准，没有就退到 AXDescription，再退到 AXValue 的字符串形态。
unsafe fn node_text(el: AXUIElementRef) -> String {
    for k in ["AXTitle", "AXDescription", "AXLabel"] {
        if let Some(s) = attr_string(el, k) {
            if !s.trim().is_empty() {
                return s.chars().take(120).collect();
            }
        }
    }
    String::new()
}

/// 开发者起的稳定标识（accessibilityIdentifier）。自研应用靠它按名字点，不靠文案和坐标。
unsafe fn node_id(el: AXUIElementRef) -> String {
    attr_string(el, "AXIdentifier")
        .map(|s| s.trim().chars().take(80).collect())
        .unwrap_or_default()
}

unsafe fn node_value(el: AXUIElementRef) -> String {
    match copy_attr(el, "AXValue") {
        Some(v) => {
            if let Some(s) = v.clone().downcast::<CFString>() {
                s.to_string().chars().take(140).collect()
            } else if let Some(b) = v.downcast::<CFBoolean>() {
                let on: bool = b.into();
                (if on { "true" } else { "false" }).to_string()
            } else {
                String::new()
            }
        }
        None => String::new(),
    }
}

/// 深度优先遍历。cap 是硬上限；深度也限，防止病态深树。
///
/// 子元素**就地递归**，不把引用带出数组的生命周期：CFArrayGetValueAtIndex 返回的是
/// 借用引用，数组一释放它们就悬空。要带出去就得逐个 CFRetain，而那既麻烦又容易漏放。
unsafe fn walk(
    el: AXUIElementRef,
    depth: usize,
    cap: usize,
    out: &mut Vec<AxNode>,
    handles: &mut Vec<(u32, AXUIElementRef, AxNode)>,
    page: &mut Option<PageState>,
) {
    // 深度上限只防病态树，不能拦住正常网页：React 应用的 DOM 三四十层是常态（Claude 桌面端实测
    // 最深 39 层、613 个节点，上限 24 时只读出 86 个，看起来像「这应用没内容」）。节点总数另有 cap 兜底。
    if out.len() >= cap || depth > 80 {
        return;
    }
    let role = attr_string(el, "AXRole").unwrap_or_default();
    // 加载状态挂在 AXWebArea 上，顺路读掉——只读第一个，不为它额外遍历一遍树。
    // 放在尺寸过滤**之前**：WebArea 本身可能被判成尺寸退化而不进清单，但它的
    // 加载状态照样有效，漏在过滤后面会让整条提醒在部分页面上静默消失。
    if page.is_none() && role == "AXWebArea" {
        *page = Some(PageState {
            title: attr_string(el, "AXTitle").unwrap_or_default().chars().take(120).collect(),
            loaded: attr_bool(el, "AXLoaded").unwrap_or(false),
            progress: attr_f64(el, "AXLoadingProgress").unwrap_or(0.0),
        });
    }
    let (x, y) = attr_point(el, "AXPosition").unwrap_or((0, 0));
    let (w, h) = attr_size(el, "AXSize").unwrap_or((0, 0));
    // 尺寸退化的元素点不到，收进来只会挤掉真能点的（末尾有 cap 截断）。
    if w >= 2 && h >= 2 && !role.is_empty() {
        let node = AxNode {
            role: role.trim_start_matches("AX").to_string(),
            text: node_text(el),
            value: node_value(el),
            x,
            y,
            w,
            h,
            enabled: attr_bool(el, "AXEnabled").unwrap_or(true),
            id: node_id(el),
        };
        // ref 就是它在这一份结果里的序号。句柄一起留下来，点的时候直接用，
        // 不必重跑一遍枚举——那正是老路又慢又会下标错位的原因。
        //
        // **必须在这里 retain**：CFArrayGetValueAtIndex 给的是借用引用，出了这一层
        // 数组的作用域（下面那句 CFRelease）它就是野指针。等遍历结束再统一 retain
        // 会 retain 到已释放的对象上——直接 SIGTRAP（踩过一次）。
        core_foundation::base::CFRetain(el as CFTypeRef);
        let id = out.len() as u32 + 1;
        handles.push((id, el, node.clone()));
        out.push(node);
    }
    let key = CFString::new("AXChildren");
    let mut raw: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut raw) == 0 && !raw.is_null()
    {
        let arr = raw as CFArrayRef;
        let n = CFArrayGetCount(arr);
        for i in 0..n {
            let c = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
            if !c.is_null() {
                walk(c, depth + 1, cap, out, handles, page);
            }
            if out.len() >= cap {
                break;
            }
        }
        CFRelease(raw);
    }
}

/// 当前前台应用的进程号。调用方不必先跑一次 window.list 再把 pid 传回来——
/// 少一次往返，而「读前台」正是这个方法九成的用法。
///
/// **不能**只问 NSWorkspace.frontmostApplication / NSRunningApplication.isActive：这两个值靠本进程的
/// 主事件循环收 LaunchServices 通知来刷新，而 sidecar 主线程一直阻塞在 accept() 上，没有事件循环，
/// 于是它们永远停在进程启动那一刻的快照。实测：`open -b com.apple.finder` 之后 lsappinfo 说访达在前，
/// sidecar 还咬定 Claude 在前——激活明明成功，却回「2.5 秒后它仍不在前台」。窗口服务器的 z 序
/// （CGWindowList 前到后）是活的，第一扇普通层级的窗口归谁，谁就在前台。
pub fn frontmost_pid() -> Option<i32> {
    if let Some(w) = front_app() {
        return Some(w.pid);
    }
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: id = msg_send![workspace, frontmostApplication];
        if app == nil {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        if pid > 0 { Some(pid) } else { None }
    }
}

/// 屏幕上最前面那扇普通窗口（z 序第一）：它的主人就是前台应用。读的是窗口服务器，不经 NSWorkspace。
pub fn front_app() -> Option<WinTitle> {
    window_titles().into_iter().next()
}


/// 屏幕上正在显示的普通窗口（层级 0、至少 40×40），z 序从前到后。
/// 标题（kCGWindowName）在没有屏幕录制权限时对别家应用读不到，会是空串——主人和 pid 照样有。
pub fn window_titles() -> Vec<WinTitle> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };
    let mut out = Vec::new();
    let Some(list) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return out;
    };
    for item in list.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as *const _) };
        let n_of = |key: &str| -> f64 {
            dict.find(&CFString::new(key))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|v| v.to_f64())
                .unwrap_or(0.0)
        };
        let s_of = |key: &str| -> String {
            dict.find(&CFString::new(key))
                .and_then(|v| v.downcast::<CFString>())
                .map(|v| v.to_string())
                .unwrap_or_default()
        };
        if n_of("kCGWindowLayer") != 0.0 {
            continue;
        }
        let pid = n_of("kCGWindowOwnerPID") as i32;
        if pid <= 0 {
            continue;
        }
        let (w, h) = dict
            .find(&CFString::new("kCGWindowBounds"))
            .map(|v| unsafe {
                let b: CFDictionary<CFString, CFType> =
                    CFDictionary::wrap_under_get_rule(v.as_CFTypeRef() as *const _);
                let g = |k: &str| {
                    b.find(&CFString::new(k))
                        .and_then(|n| n.downcast::<CFNumber>())
                        .and_then(|n| n.to_f64())
                        .unwrap_or(0.0)
                };
                (g("Width"), g("Height"))
            })
            .unwrap_or((0.0, 0.0));
        // 40×40 以下是阴影 / 输入法 / 状态条这类附属层，既不是窗口也没有像样的标题。
        if w < 40.0 || h < 40.0 {
            continue;
        }
        out.push(WinTitle { pid, owner: s_of("kCGWindowOwnerName"), title: s_of("kCGWindowName") });
    }
    out
}

/// 问目标应用自己「你在前台吗」（AXFrontmost，由它进程内的 AX 服务回答，活的）。
/// 读不到（没权限 / 应用卡死 / 不是 GUI 进程）回 None——「没查成」不能说成「不在」。
pub fn is_frontmost(pid: i32) -> Option<bool> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(app, 0.8);
        let v = attr_bool(app, "AXFrontmost");
        CFRelease(app as CFTypeRef);
        v
    }
}

/// 通过 AX 让目标应用自己切到前台（AXFrontmost = true）。NSRunningApplication 的激活请求在
/// macOS 14+ 的「协作式激活」下可能被静默拒绝，而 AX 这条路是应用在自己进程里执行 activate，
/// 没有这层限制；它和读屏用的是同一份辅助功能授权，不会多弹一个权限框。
pub fn set_frontmost(pid: i32) -> bool {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return false;
        }
        AXUIElementSetMessagingTimeout(app, 1.0);
        let key = CFString::new("AXFrontmost");
        let v = CFBoolean::true_value();
        let ok = AXUIElementSetAttributeValue(app, key.as_concrete_TypeRef(), v.as_CFTypeRef()) == 0;
        CFRelease(app as CFTypeRef);
        ok
    }
}

/// 拍一份前台应用的可访问性树。
///
/// 只走用户真看得见、真点得到的窗口：跳过最小化的和尺寸退化的（浏览器会挂 1x1 的
/// 隐藏工具窗），主窗口排最前——被 cap 截断时先留它。
pub fn snapshot(pid: i32, cap: usize) -> (Vec<AxNode>, Option<PageState>) {
    // 刚被叫醒的 Chromium / Electron / WebKit 要一小会儿才把树建出来，而且是**渐进**的：第一遍
    // 读到的往往是半棵（不只是「壳」），拿节点数当判据会把半棵当整棵。所以只要这次真叫醒了它，
    // 就等一拍再读；只在叫醒的那一次多等，之后每次读都不多花一毫秒。
    if wake_ax(pid) {
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
    snapshot_inner(pid, cap, true)
}

/// 只看一眼，**不动句柄表**。
///
/// background_monitor 的 screen 检查要每隔几秒读一次屏，而 `snapshot` 每次都会
/// `store_handles` 换掉整张表并 CFRelease 掉旧句柄 —— 也就是说轮询会把模型上一次
/// read_screen 拿到的 ref **全部作废**。模型手里于是攥着一把废数字，`act` 只会回
/// 「ref 不在最近一次读屏结果里」，而它根本不知道是谁弄没的。
///
/// 这条路走同一套遍历，末尾把 walk 里 retain 过的句柄逐个放掉（不放就是泄漏），
/// 只交出可读文本。**它不产生 ref，也不销毁 ref。**
pub fn snapshot_probe(pid: i32, cap: usize) -> (Vec<AxNode>, Option<PageState>) {
    wake_ax(pid);
    snapshot_inner(pid, cap, false)
}

fn snapshot_inner(pid: i32, cap: usize, keep_handles: bool) -> (Vec<AxNode>, Option<PageState>) {
    let mut out = Vec::new();
    let mut page: Option<PageState> = None;
    let mut handles: Vec<(u32, AXUIElementRef, AxNode)> = Vec::new();
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return (out, page);
        }
        // 卡死的应用不能把整次读取拖死。
        AXUIElementSetMessagingTimeout(app, 2.0);

        // 窗口引用同样是数组的借用引用，所以整段筛选 + 遍历都在数组存活期内做完。
        let key = CFString::new("AXWindows");
        let mut raw: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(app, key.as_concrete_TypeRef(), &mut raw) == 0
            && !raw.is_null()
        {
            let arr = raw as CFArrayRef;
            let n = CFArrayGetCount(arr);
            // 先按「主窗口优先」排出下标顺序，再按这个顺序遍历。
            let mut order: Vec<isize> = Vec::new();
            for i in 0..n {
                let w = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                if w.is_null() {
                    continue;
                }
                let (ww, wh) = attr_size(w, "AXSize").unwrap_or((0, 0));
                if ww < 40 || wh < 40 {
                    continue;
                }
                if attr_bool(w, "AXMinimized").unwrap_or(false) {
                    continue;
                }
                if attr_bool(w, "AXMain").unwrap_or(false) {
                    order.insert(0, i);
                } else {
                    order.push(i);
                }
            }
            // 一个都没留下时不要直接交空。
            //
            // 有的应用（托盘类的、比如 Clash Verge）会把自己**看得见的**窗口报成
            // AXMinimized=true——JXA 那边读到的也是 true，所以这不是读错，是这个
            // 应用就这么报的。但据此返回空，下游只有一条解释路径，会说成
            // 「这个应用不暴露可访问性树」，模型于是断定它没法自动化。
            // 宁可退回去读所有尺寸够大的窗口：坐标可能不准，但至少是真的有东西，
            // 而「点了没反应」比「这应用没法自动化」好排查得多。
            if order.is_empty() {
                for i in 0..n {
                    let w = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                    if w.is_null() {
                        continue;
                    }
                    let (ww, wh) = attr_size(w, "AXSize").unwrap_or((0, 0));
                    if ww >= 40 && wh >= 40 {
                        order.push(i);
                    }
                }
            }
            for i in order.into_iter().take(5) {
                let w = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                if !w.is_null() {
                    walk(w, 0, cap, &mut out, &mut handles, &mut page);
                }
                if out.len() >= cap {
                    break;
                }
            }
            CFRelease(raw);
        }
        CFRelease(app as CFTypeRef);
    }
    if keep_handles {
        store_handles(pid, handles);
    } else {
        // 探查路径：walk 里 retain 过的句柄这里全部放掉。既不换表也不泄漏，
        // 上一次 read_screen 发出去的 ref 原封不动地继续有效。
        for (_, el, _) in handles {
            unsafe { CFRelease(el as CFTypeRef) };
        }
    }
    (out, page)
}

#[cfg(test)]
mod tests {
    /// 手动基准：对着一个真实运行的应用测一次，和 JXA 那条路对照。
    /// 默认 ignore——它依赖本机有那个应用在跑，且需要辅助功能权限。
    ///   cargo test --all-features bench_snapshot -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_snapshot() {
        let pid: i32 = std::env::var("AX_PID").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        assert!(pid > 0, "用 AX_PID=<进程号> 指定目标");
        let t = std::time::Instant::now();
        let (nodes, _page) = super::snapshot(pid, 500);
        let ms = t.elapsed().as_millis();
        println!("原生 AX：{} 个元素，{} 毫秒", nodes.len(), ms);
        let mut roles: std::collections::BTreeMap<&str, usize> = Default::default();
        for n in &nodes { *roles.entry(n.role.as_str()).or_default() += 1; }
        println!("角色分布：{:?}", roles);
        println!("有没有 WebArea：{}", nodes.iter().any(|n| n.role == "WebArea"));
        for n in nodes.iter().filter(|n| n.role == "Link" || n.role == "Button").take(4) {
            println!("  {} @{},{}  {}", n.role, n.x, n.y, n.text);
        }
    }
}

// ── 元素句柄表：读和点必须共用同一批句柄 ──────────────────────────────────
//
// 原来那条 JXA 路是「点的时候重跑一遍枚举，再按下标取第 N 个」。这有两个后果：
// 一是点一次和读一次一样贵（同样几十秒），二是两次枚举之间界面只要动过，下标就错位。
// 它靠元素签名比对来兜底，所以不会点错，但会直接失败。
//
// 原生这条把句柄本身留下来（CFRetain），点的时候直接对着那个元素发动作——不用重枚举，
// 快得多，也不存在下标错位。签名仍然存：界面变了要能说出「这个 ref 过期了，重读」，
// 而不是闷头点一个已经变成别的东西的位置。
use std::collections::HashMap;
use std::sync::Mutex;

extern "C" {
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
}

struct Held {
    el: AXUIElementRef,
    sig: AxNode,
    pid: i32,
}
// AXUIElementRef 是不可变的 CF 对象，跨线程持有是安全的；这里用互斥量保证表本身的独占。
unsafe impl Send for Held {}

static HANDLES: Mutex<Option<HashMap<u32, Held>>> = Mutex::new(None);

/// 句柄在 walk 里就已经 retain 过了（那时数组还活着），这里只负责换表和放掉旧的。
fn store_handles(pid: i32, items: Vec<(u32, AXUIElementRef, AxNode)>) {
    let mut map = HashMap::new();
    for (id, el, sig) in items {
        map.insert(id, Held { el, sig, pid });
    }
    if let Ok(mut g) = HANDLES.lock() {
        if let Some(old) = g.take() {
            for (_, h) in old {
                unsafe { CFRelease(h.el as CFTypeRef) };
            }
        }
        *g = Some(map);
    }
}


/// 发一个 AX 动作；AXError 0 才算成功。
///
/// 不能只看「没抛错」：AXUIElementPerformAction 对不支持这个动作的元素会返回非 0 而不是
/// 崩溃，把返回码丢掉就等于把「这个元素根本按不动」报成成功。
unsafe fn perform(el: AXUIElementRef, name: &str) -> bool {
    let a = CFString::new(name);
    AXUIElementPerformAction(el, a.as_concrete_TypeRef()) == 0
}

/// 对一个 ref 执行 AX 动作。
///
/// 支持的动作必须和 `ui_click` 放行的那一批**完全一致**。少一个的后果不是「那个动作用不了」，
/// 而是它会退回 JXA 老路，而老路的 ref 是另一套编号（0 基、按控件类型分桶重排），
/// 退回去必然点到别的元素上——比慢更糟。
pub fn act(
    reference: u32,
    action: &str,
    value: Option<&str>,
    expect_pid: Option<i32>,
) -> Result<serde_json::Value, String> {
    let g = HANDLES.lock().map_err(|_| "句柄表不可用".to_string())?;
    let map = g.as_ref().ok_or("还没有读过屏；先调 screen.elements")?;
    let held = map
        .get(&reference)
        .ok_or_else(|| format!("ref {reference} 不在最近一次读屏结果里；重新读一次"))?;

    // 身份校验。`Held.pid` 一直存着却从没被读过，而 ui_click 的工具描述向模型明确保证
    // 「目标不必在前台，身份由快照里记下的 pid 保证」。承诺落空的后果不是抽象的：
    // 读屏读的是 A，中间句柄表被别的读屏换成了 B，动作就落到 B 的同序号元素上——
    // 而签名校验拦不住（同名同位置的按钮在两个应用里长得一样），操作会静默打到别处。
    if let Some(want) = expect_pid {
        if want != held.pid {
            return Err(format!(
                "这个 ref 属于进程 {}，而这次动作要操作的是进程 {want}——中间有过一次\
                 读屏把句柄表换掉了。重新 read_screen 再操作。",
                held.pid
            ));
        }
    }

    unsafe {
        // 先确认它还是原来那个东西。
        let mut now = Vec::new();
        walk_one(held.el, &mut now);
        let live = now
            .into_iter()
            .next()
            .ok_or("这个元素已经不存在了；重新读一次屏")?;
        if let Some(d) = signature_drift(&held.sig, &live) {
            return Err(format!(
                "ref {reference} 已经过期（{d}）——界面变过了。重新 screen.elements 再操作。"
            ));
        }

        match action {
            "press" => {
                for name in ["AXPress", "AXOpen", "AXPick", "AXConfirm"] {
                    if perform(held.el, name) {
                        return Ok(serde_json::json!({
                            "ok": true, "action": "press", "used": name,
                            "role": live.role, "text": live.text,
                        }));
                    }
                }
                Err(format!(
                    "「{}」不响应 press/open/pick（role={}）",
                    live.text, live.role
                ))
            }
            "focus" => {
                let attr = CFString::new("AXFocused");
                let t = CFBoolean::true_value();
                let rc = AXUIElementSetAttributeValue(
                    held.el,
                    attr.as_concrete_TypeRef(),
                    t.as_CFTypeRef(),
                );
                if rc != 0 {
                    return Err(format!("聚焦被拒（AXError {rc}）"));
                }
                // 赋值不抛错 != 焦点真的到了。回读。
                let got = attr_bool(held.el, "AXFocused").unwrap_or(false);
                if !got {
                    return Err("赋值被接受，但焦点没落到这个元素上".into());
                }
                Ok(serde_json::json!({"ok": true, "action": "focus", "role": live.role}))
            }
            "set_value" => {
                let v = value.ok_or("set_value 需要 value")?;
                let attr = CFString::new("AXValue");
                let s = CFString::new(v);
                let rc = AXUIElementSetAttributeValue(
                    held.el,
                    attr.as_concrete_TypeRef(),
                    s.as_CFTypeRef(),
                );
                if rc != 0 {
                    return Err(format!("写入被拒（AXError {rc}）"));
                }
                let back = node_value(held.el);
                if back != v {
                    return Err(format!("写进去了但读回来是「{back}」，不是要写的值"));
                }
                Ok(serde_json::json!({"ok": true, "action": "set_value", "value": back}))
            }
            // 滚到可见。可访问性树只覆盖**可见的那一屏**，折叠以下的元素压根不在清单里，
            // 没有这个动作，「滚下去再点」就只能盲滚坐标，而滚动量和目标位置之间没有任何
            // 对应关系。滚完这一屏的几何全变，而 ref 的签名里含 x/y ——旧 ref 随之全部作废，
            // 所以这句话必须跟着回执一起带回去，否则模型会拿着一批已失效的 ref 接着点。
            "scroll_to" => {
                if !perform(held.el, "AXScrollToVisible") {
                    return Err(format!(
                        "「{}」不支持 scroll_to（AXScrollToVisible）",
                        live.text
                    ));
                }
                let (x, y) = attr_point(held.el, "AXPosition").unwrap_or((live.x, live.y));
                Ok(serde_json::json!({
                    "ok": true, "action": "scroll_to",
                    "role": live.role, "text": live.text, "x": x, "y": y,
                    "note": "滚动后这一屏的元素位置全变了，之前那批 ref 已经作废——先重新 read_screen 再操作。",
                }))
            }
            other => {
                let ax = match other {
                    "increment" => "AXIncrement",
                    "decrement" => "AXDecrement",
                    "show_menu" => "AXShowMenu",
                    "confirm" => "AXConfirm",
                    "cancel" => "AXCancel",
                    "pick" => "AXPick",
                    _ => {
                        return Err(format!(
                            "不支持的动作「{other}」；可用：press / focus / set_value / scroll_to / \
                             increment / decrement / show_menu / confirm / cancel / pick"
                        ))
                    }
                };
                if !perform(held.el, ax) {
                    return Err(format!(
                        "「{}」不响应 {ax}（role={}）",
                        live.text, live.role
                    ));
                }
                Ok(serde_json::json!({
                    "ok": true, "action": other,
                    "role": live.role, "text": live.text, "value": node_value(held.el),
                }))
            }
        }
    }
}

/// 只读**这一个**元素的签名，不递归。
unsafe fn walk_one(el: AXUIElementRef, out: &mut Vec<AxNode>) {
    let role = attr_string(el, "AXRole").unwrap_or_default();
    if role.is_empty() {
        return;
    }
    let (x, y) = attr_point(el, "AXPosition").unwrap_or((0, 0));
    let (w, h) = attr_size(el, "AXSize").unwrap_or((0, 0));
    out.push(AxNode {
        role: role.trim_start_matches("AX").to_string(),
        text: node_text(el),
        value: node_value(el),
        x,
        y,
        w,
        h,
        enabled: attr_bool(el, "AXEnabled").unwrap_or(true),
        id: node_id(el),
    });
}

/// 一个进程「是什么」：可执行文件、.app 包、是不是 Chromium 内核、开着哪些监听端口。
///
/// Chromium 判据是包里有没有 Electron / Chrome / Edge / CEF 的 Framework——这些应用带
/// `--remote-debugging-port` 启动就能被 browser 工具按 CDP 接管，比走可访问性树省得多。
/// 端口用 lsof 查本进程和它的直接子进程（只在 app.resolve 时查一次，几十毫秒）。
pub fn app_details(pid: i32) -> AppDetails {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    let mut d = AppDetails::default();
    unsafe {
        let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if app != nil {
            let read = |obj: id| -> String {
                if obj == nil {
                    return String::new();
                }
                let ptr: *const i8 = msg_send![obj, UTF8String];
                if ptr.is_null() { String::new() } else { std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned() }
            };
            let exe: id = msg_send![app, executableURL];
            d.exe = if exe == nil { String::new() } else { read(msg_send![exe, path]) };
            let bundle: id = msg_send![app, bundleURL];
            d.bundle_path = if bundle == nil { String::new() } else { read(msg_send![bundle, path]) };
        }
    }
    if !d.bundle_path.is_empty() {
        let frameworks = std::path::Path::new(&d.bundle_path).join("Contents").join("Frameworks");
        if let Ok(rd) = std::fs::read_dir(&frameworks) {
            d.chromium = rd.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.contains("electron framework") || n.contains("chromium embedded") || n.contains("chrome framework")
                    || n.contains("edge framework") || n.contains("brave browser framework") || n.contains("chromium framework")
            });
        }
    }
    if !d.chromium {
        let lower = d.exe.to_lowercase();
        d.chromium = ["google chrome", "microsoft edge", "chromium", "brave browser", "electron"].iter().any(|k| lower.contains(k));
    }
    d.ports = listen_ports(pid);
    d
}

/// 本进程及其直接子进程正在监听的 TCP 端口（lsof）。查不到就是空，不猜。
fn listen_ports(pid: i32) -> Vec<ListenPort> {
    let mut pids = vec![pid];
    if let Ok(out) = std::process::Command::new("/usr/bin/pgrep").arg("-P").arg(pid.to_string()).output() {
        pids.extend(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<i32>().ok()));
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let Ok(out) = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &list, "-Fpn"])
        .output()
    else {
        return Vec::new();
    };
    let mut ports = Vec::new();
    let mut cur_pid = pid;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            cur_pid = p.trim().parse().unwrap_or(pid);
        } else if let Some(n) = line.strip_prefix('n') {
            if let Some(port) = n.rsplit(':').next().and_then(|s| s.trim().parse::<u16>().ok()) {
                if !ports.iter().any(|p: &ListenPort| p.port == port) {
                    ports.push(ListenPort { port, pid: cur_pid });
                }
            }
        }
    }
    ports
}

/// 全部显示器：(id, x, y, w, h, is_main)。实现在 platform::macos，这里转发一下让两个平台同名。
pub fn list_displays() -> Vec<(u32, i32, i32, u32, u32, bool)> {
    super::macos::list_displays()
}

/// 可执行文件完整路径（NSRunningApplication.executableURL）。
pub fn exe_path_of(pid: i32) -> Option<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if app == nil {
            return None;
        }
        let url: id = msg_send![app, executableURL];
        if url == nil {
            return None;
        }
        let path: id = msg_send![url, path];
        if path == nil {
            return None;
        }
        let ptr: *const i8 = msg_send![path, UTF8String];
        if ptr.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

/// 按进程号反查应用名。
///
/// screen.elements 原来是拿 `enumerate_windows()` 里 `is_frontmost` 那一条的标题当
/// 应用名回给调用方的 —— 只读前台时碰巧总是对的。一旦支持读**非前台**的应用，
/// 这个名字就成了系统性的假话：读的是 A，回执说是 B。而 read_screen 正是拿这个名字
/// 装进 ref 表当身份，ui_click 再用它校验「读的还是不是同一个 app」——错的身份会让
/// 这道校验形同虚设。按 pid 反查是唯一诚实的读法。
/// 叫醒 Chromium / Electron / WebKit 的可访问性树。
///
/// 这几家默认**不建**树：没有辅助工具在问的时候，Chrome、Electron 应用（所有者自己做的那些）、
/// 甚至 WKWebView 只交出 Window + 几个空 Group，看起来就像「这个应用不暴露可访问性」——实测
/// Claude 桌面端只读出 13 个节点。VoiceOver 的做法是给应用元素写 AXEnhancedUserInterface = true，
/// Electron 另认 AXManualAccessibility = true；写上以后它们才开始把网页内容翻成 AX 树。
/// 返回「这次是不是真把它叫醒的」：之前就是 true 的不算，调用方据此决定要不要多等一拍。
pub fn wake_ax(pid: i32) -> bool {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return false;
        }
        AXUIElementSetMessagingTimeout(app, 1.0);
        let already = attr_bool(app, "AXEnhancedUserInterface").unwrap_or(false);
        let mut set_any = false;
        for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            let key = CFString::new(name);
            let v = CFBoolean::true_value();
            if AXUIElementSetAttributeValue(app, key.as_concrete_TypeRef(), v.as_CFTypeRef()) == 0 {
                set_any = true;
            }
        }
        CFRelease(app as CFTypeRef);
        set_any && !already
    }
}


/// 按名字找运行中的应用：显示名 / 可执行名 / bundle id（整个或最后一段）/ **窗口标题**，一次全认。
///
/// 为什么要认窗口标题：所有者的 Electron 应用进程叫 Electron、窗口叫「ZipMate 压缩助手」，模型
/// 眼里只有后者——原来只按应用名找，回一句「未找到窗口」，模型就此放弃整条自动化。
/// 顺序：三种名字精确相等 > 窗口标题精确 > 窗口标题子串 > 名字子串；同一档里带界面的应用
/// （activationPolicy regular）排在后台代理前面。找不到时把「屏幕上有窗口的应用（附标题）」交回去，
/// 让模型一步就能改对，而不是继续猜。
pub fn resolve_app(query: &str) -> Result<AppMatch, Vec<String>> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    let want = query.trim();
    if want.is_empty() {
        return Err(Vec::new());
    }
    let lw = want.to_lowercase();
    struct App { pid: i32, name: String, bundle: String, exe: String, exe_path: String, regular: bool }
    let mut apps: Vec<App> = Vec::new();
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let list: id = msg_send![workspace, runningApplications];
        let count: usize = msg_send![list, count];
        let read = |obj: id| -> String {
            if obj == nil {
                return String::new();
            }
            let ptr: *const i8 = msg_send![obj, UTF8String];
            if ptr.is_null() {
                return String::new();
            }
            std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
        };
        for i in 0..count {
            let app: id = msg_send![list, objectAtIndex: i];
            let pid: i32 = msg_send![app, processIdentifier];
            if pid <= 0 {
                continue;
            }
            let url: id = msg_send![app, executableURL];
            let exe = if url == nil { String::new() } else { read(msg_send![url, lastPathComponent]) };
            let exe_path = if url == nil { String::new() } else { read(msg_send![url, path]) };
            let policy: isize = msg_send![app, activationPolicy];
            apps.push(App {
                pid,
                name: read(msg_send![app, localizedName]),
                bundle: read(msg_send![app, bundleIdentifier]),
                exe,
                exe_path,
                regular: policy == 0,
            });
        }
    }
    // 带界面的排前面：同名时（比如 Electron 的辅助进程）优先命中真正开着窗口的那个。
    apps.sort_by_key(|a| !a.regular);
    let eq = |s: &str| !s.is_empty() && s.to_lowercase() == lw;
    let found = |a: &App, via: &'static str| AppMatch { pid: a.pid, name: a.name.clone(), bundle: a.bundle.clone(), exe: a.exe_path.clone(), via };
    if let Some(a) = apps.iter().find(|a| {
        eq(&a.name) || eq(&a.bundle) || eq(a.bundle.rsplit('.').next().unwrap_or("")) || eq(&a.exe)
    }) {
        return Ok(found(a, "name"));
    }
    let windows = crate::system::window_titles();
    for exact in [true, false] {
        if let Some(w) = windows.iter().find(|w| {
            let t = w.title.to_lowercase();
            !t.is_empty() && if exact { t == lw } else { t.contains(&lw) }
        }) {
            if let Some(a) = apps.iter().find(|a| a.pid == w.pid) {
                return Ok(found(a, "window_title"));
            }
            return Ok(AppMatch { pid: w.pid, name: w.owner.clone(), bundle: String::new(), exe: String::new(), via: "window_title" });
        }
    }
    if let Some(a) = apps.iter().find(|a| {
        a.name.to_lowercase().contains(&lw) || a.bundle.to_lowercase().contains(&lw) || a.exe.to_lowercase().contains(&lw)
    }) {
        return Ok(found(a, "substring"));
    }
    let mut candidates: Vec<String> = Vec::new();
    for a in apps.iter().filter(|a| a.regular) {
        let titles: Vec<&str> = windows
            .iter()
            .filter(|w| w.pid == a.pid && !w.title.is_empty() && w.title != a.name)
            .map(|w| w.title.as_str())
            .take(3)
            .collect();
        if windows.iter().any(|w| w.pid == a.pid) {
            candidates.push(if titles.is_empty() { a.name.clone() } else { format!("{}（{}）", a.name, titles.join(" / ")) });
        }
        if candidates.len() >= 14 {
            break;
        }
    }
    Err(candidates)
}


pub fn name_of(pid: i32) -> Option<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let cls = class!(NSRunningApplication);
        let app: id = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app == nil {
            return None;
        }
        let name_obj: id = msg_send![app, localizedName];
        if name_obj == nil {
            return None;
        }
        let ptr: *const i8 = msg_send![name_obj, UTF8String];
        if ptr.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

/// 按应用名找进程号。window.restore 要用，和 macos.rs 里那个是同一件事。
pub fn pid_of(title: &str) -> Option<i32> {
    // 和 resolve_app 是同一条规则：读屏解析到谁、动作就打谁，两边不许各认各的。
    resolve_app(title).ok().map(|m| m.pid)
}

/// 最小化 / 还原某个应用的窗口。
///
/// 平台层那两个（minimize_window / maximize_window）在 macOS 上一直是只会返回
/// UnsupportedPlatform 的空实现，而 window.minimize 就写在工具目录的 enum 里——
/// 模型照着调必然报错。而 AX 侧本来就有 AXMinimized 这个可写属性，几行就能实现。
///
/// 按应用名匹配（和 window.activate 一致），只动第一个尺寸够大的窗口。
/// 把 pid 的某扇窗口（标题含 query，不分大小写）提到最前。应用切到前台只保证它的**某个**窗口在前，
/// 模型点名的那扇可能还压在同一应用的别的窗口下面。找不到匹配的窗口就什么都不做（返回 false）。
pub fn raise_window(pid: i32, query: &str) -> bool {
    let lw = query.trim().to_lowercase();
    if lw.is_empty() {
        return false;
    }
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return false;
        }
        AXUIElementSetMessagingTimeout(app, 1.0);
        let key = CFString::new("AXWindows");
        let mut raw: CFTypeRef = ptr::null();
        let mut raised = false;
        if AXUIElementCopyAttributeValue(app, key.as_concrete_TypeRef(), &mut raw) == 0 && !raw.is_null() {
            let arr = raw as CFArrayRef;
            let n = CFArrayGetCount(arr);
            for i in 0..n {
                let w = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                if w.is_null() {
                    continue;
                }
                let title = attr_string(w, "AXTitle").unwrap_or_default().to_lowercase();
                if !title.is_empty() && title.contains(&lw) {
                    let action = CFString::new("AXRaise");
                    raised = AXUIElementPerformAction(w, action.as_concrete_TypeRef()) == 0;
                    break;
                }
            }
            CFRelease(raw);
        }
        CFRelease(app as CFTypeRef);
        raised
    }
}

pub fn set_minimized(pid: i32, minimized: bool) -> Result<String, String> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Err("拿不到这个应用的可访问性入口".into());
        }
        AXUIElementSetMessagingTimeout(app, 2.0);
        let key = CFString::new("AXWindows");
        let mut raw: CFTypeRef = ptr::null();
        let rc = AXUIElementCopyAttributeValue(app, key.as_concrete_TypeRef(), &mut raw);
        if rc != 0 || raw.is_null() {
            CFRelease(app as CFTypeRef);
            return Err(format!("这个应用没有交出窗口（AXError {rc}）"));
        }
        let arr = raw as CFArrayRef;
        let n = CFArrayGetCount(arr);
        let mut done: Option<String> = None;
        for i in 0..n {
            let w = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
            if w.is_null() {
                continue;
            }
            // 尺寸过滤只在**最小化**时用（挑一个真窗口下手，别去动 1x1 的隐藏工具窗）。
            // 还原时不能用：已经最小化的窗口尺寸就是不正常的，按尺寸筛会把唯一那个
            // 要还原的窗口挡在外面——实测就是这么失败的（最小化成功、还原报「没找到」）。
            if minimized {
                let (ww, wh) = attr_size(w, "AXSize").unwrap_or((0, 0));
                if ww < 40 || wh < 40 {
                    continue;
                }
            } else if !attr_bool(w, "AXMinimized").unwrap_or(false) {
                // 还原时只找当前确实是最小化的那些。
                continue;
            }
            let attr = CFString::new("AXMinimized");
            let v = if minimized { CFBoolean::true_value() } else { CFBoolean::false_value() };
            let src = AXUIElementSetAttributeValue(w, attr.as_concrete_TypeRef(), v.as_CFTypeRef());
            if src != 0 {
                continue;
            }
            // 赋值不抛错 != 真的生效了。回读——这个项目里所有「发出请求」都要回读，
            // 否则就是又一个「一路 ok、屏幕上什么都没发生」。
            //
            // 要**轮询**不能只读一次：最小化那一下回读立刻就对，还原却有动画，
            // 立刻读到的还是 true。实测就是这么失败的（最小化成功、还原报没找到）。
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            let mut got = attr_bool(w, "AXMinimized").unwrap_or(!minimized);
            while got != minimized && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
                got = attr_bool(w, "AXMinimized").unwrap_or(!minimized);
            }
            if got == minimized {
                done = Some(attr_string(w, "AXTitle").unwrap_or_default());
                break;
            }
        }
        CFRelease(raw);
        CFRelease(app as CFTypeRef);
        match done {
            Some(t) => Ok(t),
            None => Err(format!(
                "没能{}任何窗口——可能这个应用不允许（AXMinimized 只读），或者它没有普通窗口",
                if minimized { "最小化" } else { "还原" }
            )),
        }
    }
}

#[cfg(test)]
mod act_tests {
    /// 句柄表和 ref 解析的端到端验证——不真的按下去，但把 act 在动作**之前**做的
    /// 每一步都跑一遍：查表、拿句柄、回读元素、比签名。
    ///
    /// 为什么值得单独测：这条路是「读一次留下句柄，点的时候直接用」，而老路是
    /// 「点的时候重跑一遍枚举按下标取」。下标那套一旦界面动过就错位，句柄这套不会——
    /// 但句柄如果没 retain 住，用的时候就是野指针（已经踩过一次 SIGTRAP）。
    ///   cargo test --all-features act_ref -- --ignored --nocapture
    #[test]
    #[ignore]
    fn act_ref_resolves_and_detects_staleness() {
        let pid: i32 = std::env::var("AX_PID").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        assert!(pid > 0, "用 AX_PID=<进程号> 指定目标");
        let (nodes, _page) = super::snapshot(pid, 200);
        assert!(!nodes.is_empty(), "先得读到东西");

        // 不存在的 ref 要说清楚，而不是崩或者点到别的东西上。
        let bad = super::act(999_999, "press", None, None).unwrap_err();
        assert!(bad.contains("不在最近一次读屏结果里"), "越界 ref 的说法不对：{bad}");

        // 不支持的动作同样要点名可用的是哪几个。
        let wrong = super::act(1, "click", None, None).unwrap_err();
        assert!(wrong.contains("press") && wrong.contains("focus"), "不支持的动作没列出可用的：{wrong}");

        // 真正要验的：ref 1 的句柄还活着，回读得到、签名对得上。
        // 走 set_value 到一个多半不可写的元素上——它会在**签名比对之后**才失败，
        // 所以只要报的不是「过期」就说明句柄和签名这一段是通的。
        let r = super::act(1, "set_value", Some("__probe__"), None);
        match r {
            Ok(_) => println!("ref 1 可写，句柄链路通"),
            Err(e) => {
                assert!(!e.contains("已经过期"), "句柄没留住或签名对不上：{e}");
                assert!(!e.contains("不存在"), "句柄失效了：{e}");
                println!("ref 1 不可写（预期内），但签名比对通过：{e}");
            }
        }
        println!("句柄表 {} 个元素，ref 解析与签名比对正常", nodes.len());
    }
}

#[cfg(test)]
mod minimize_tests {
    /// 真的最小化再还原一次。这个项目里「发出请求」和「真发生了」是两回事，
    /// 而 minimize_window 以前就是个只会报 UnsupportedPlatform 的空实现，
    /// 却写在工具目录的 enum 里——清单在说谎。
    ///   AX_PID=<pid> cargo test --all-features minimize_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn minimize_roundtrip() {
        let pid: i32 = std::env::var("AX_PID").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        assert!(pid > 0, "用 AX_PID=<进程号> 指定目标");
        let title = super::set_minimized(pid, true).expect("最小化应当成功");
        println!("已最小化：{title}");
        std::thread::sleep(std::time::Duration::from_millis(600));
        let back = super::set_minimized(pid, false).expect("还原应当成功");
        println!("已还原：{back}");
    }
}
