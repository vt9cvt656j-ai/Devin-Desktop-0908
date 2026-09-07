//! Windows 的读屏族：UI Automation 读树 / 按 ref 操作 / 按名字找应用 / 前台判定 / 抢前台 / OCR。
//!
//! 这是 macos_tree 的孪生：**同一组函数名、同一组返回类型**（见 tree_types.rs），rpc.rs 只认
//! `platform::tree`。原来 Windows 上这一整族 RPC 都不存在——`screen.elements / screen.act /
//! screen.marked / app.resolve` 统统回「只在 macOS 可用」，Tauri 那边只能每次起一个 PowerShell
//! 跑 UIA 脚本（起进程半秒、8 秒上限、每个动作重新枚举整棵树）。这里是进程内 COM 调用：
//! 一次 `FindAllBuildCache` 把整棵子树连同要读的属性一趟拉回来，几十到几百毫秒。
//!
//! 坐标：全部是**物理像素**。进程一启动就声明 per-monitor DPI 感知（`ensure_dpi_aware`），
//! 于是 UIA 的 BoundingRectangle、GetWindowRect、GDI 抓屏、SetCursorPos 四者同一套单位——
//! 不声明的话系统会按 96 DPI 给本进程「虚拟化」坐标，125% 缩放的屏上每一次点击都偏四分之一。
//!
//! 线程：sidecar 把读屏族挪到 accept 线程之外跑，所以每条线程各自 `CoInitializeEx(MTA)`；
//! UIA 客户端对象是自由线程的，元素句柄跨 MTA 线程用是允许的（句柄表里存的就是它们）。

use crate::platform::tree_types::{
    describe_candidates, rank_app_match, role_for_control_type,
    signature_drift, AppCandidate, AppDetails, AppMatch, AxNode, ListenPort, PageState, WinTitle,
};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Mutex;
use windows::core::{Interface, BSTR, VARIANT};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_MENU,
    VK_RETURN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetCursorPos,
    SetForegroundWindow, ShowWindow, SwitchToThisWindow, GWL_EXSTYLE, GW_OWNER, SW_MINIMIZE, SW_RESTORE,
    WS_EX_TOOLWINDOW,
};

pub use crate::platform::tree_types::no_such_app;

// ── 进程级：DPI 感知、COM、UIA 实例 ─────────────────────────────────────────────

/// 进程启动时调一次。失败（已经声明过、老系统没有这个 API）就算了：那时坐标可能差一个缩放比，
/// 但不能因此不起服务。
pub fn ensure_dpi_aware() {
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

thread_local! {
    static COM_READY: Cell<bool> = const { Cell::new(false) };
    static UIA: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

fn ensure_com() {
    COM_READY.with(|c| {
        if !c.get() {
            // 已经按别的模式初始化过（RPC_E_CHANGED_MODE）也没关系：UIA 在 STA / MTA 下都能同步调。
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            c.set(true);
        }
    });
}

/// 本线程的 IUIAutomation。优先 CUIAutomation8（能设超时：卡死的应用不能把一次读屏拖到天荒地老）。
fn uia() -> Result<IUIAutomation, String> {
    ensure_com();
    UIA.with(|slot| {
        if let Some(a) = slot.borrow().as_ref() {
            return Ok(a.clone());
        }
        let created: IUIAutomation = unsafe {
            match CoCreateInstance::<_, IUIAutomation2>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) {
                Ok(a2) => {
                    let _ = a2.SetConnectionTimeout(3000);
                    let _ = a2.SetTransactionTimeout(2500);
                    a2.cast::<IUIAutomation>().map_err(|e| format!("UI Automation 接口不可用：{e}"))?
                }
                Err(_) => CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("创建 UI Automation 失败：{e}"))?,
            }
        };
        *slot.borrow_mut() = Some(created.clone());
        Ok(created)
    })
}

// ── 窗口枚举 ────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct TopWindow {
    hwnd: HWND,
    pid: i32,
    title: String,
    class: String,
    rect: RECT,
    minimized: bool,
    tool: bool,
    owned: bool,
}

unsafe extern "system" fn collect_top_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<TopWindow>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    // cloaked：切走的虚拟桌面、挂起的 UWP——IsWindowVisible 为真、矩形正常，屏幕上却没有它。
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut std::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return true.into();
    }
    let mut pid_raw = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid_raw));
    if pid_raw == 0 {
        return true.into();
    }
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    let mut cbuf = [0u16; 128];
    let cn = GetClassNameW(hwnd, &mut cbuf);
    let class = String::from_utf16_lossy(&cbuf[..cn.max(0) as usize]);
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    let tool = ex_style & WS_EX_TOOLWINDOW.0 != 0;
    let owned = GetWindow(hwnd, GW_OWNER).map(|h| !h.is_invalid()).unwrap_or(false);
    let minimized = IsIconic(hwnd).as_bool();
    // 优先 DWM 的可见边界：Win10 起 GetWindowRect 会把看不见的 7px 阴影边也算进去，
    // 拿它判遮挡会把邻窗边缘的元素错判成被盖住。
    let mut rect = RECT::default();
    let mut ext = RECT::default();
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut ext as *mut RECT as *mut std::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
    )
    .is_ok()
        && ext.right > ext.left
    {
        rect = ext;
    } else if GetWindowRect(hwnd, &mut rect).is_err() {
        rect = RECT::default();
    }
    if minimized {
        // 最小化的窗口 GetWindowRect 给的是 (-32000,-32000) 哨兵，不是几何。
        rect = RECT::default();
    }
    out.push(TopWindow { hwnd, pid: pid_raw as i32, title, class, rect, minimized, tool, owned });
    true.into()
}

/// 屏幕上的顶层窗口，z 序从前到后（EnumWindows 就按这个顺序回调）。含对话框 / 菜单 / 工具窗。
fn top_windows() -> Vec<TopWindow> {
    let mut out: Vec<TopWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_top_windows), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

fn rect_w(r: &RECT) -> i32 {
    r.right - r.left
}
fn rect_h(r: &RECT) -> i32 {
    r.bottom - r.top
}

/// 屏幕上正在显示的普通窗口（有标题、非工具窗、非附属窗、至少 40×40），z 序从前到后。
pub fn window_titles() -> Vec<WinTitle> {
    top_windows()
        .into_iter()
        .filter(|w| !w.tool && !w.owned && !w.minimized && rect_w(&w.rect) >= 40 && rect_h(&w.rect) >= 40)
        .map(|w| WinTitle { pid: w.pid, owner: process_stem(w.pid).unwrap_or_default(), title: w.title })
        .collect()
}

/// 前台窗口的主人。读的是 GetForegroundWindow，活的。
pub fn front_app() -> Option<WinTitle> {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(h, &mut buf);
        Some(WinTitle {
            pid: pid as i32,
            owner: process_stem(pid as i32).unwrap_or_default(),
            title: String::from_utf16_lossy(&buf[..n.max(0) as usize]),
        })
    }
}

pub fn frontmost_pid() -> Option<i32> {
    front_app().map(|w| w.pid)
}

/// 目标在不在前台。Windows 上这是确定的（GetForegroundWindow），没有「查不到」。
pub fn is_frontmost(pid: i32) -> Option<bool> {
    Some(frontmost_pid() == Some(pid))
}

/// 遮挡判断用的窗口栈：普通层级、可见、未最小化，z 序从前到后。
pub fn window_stack() -> Vec<crate::vision::WinRect> {
    top_windows()
        .into_iter()
        .filter(|w| !w.minimized && !w.tool && rect_w(&w.rect) >= 2 && rect_h(&w.rect) >= 2)
        .map(|w| crate::vision::WinRect {
            pid: w.pid,
            x: w.rect.left as f64,
            y: w.rect.top as f64,
            w: rect_w(&w.rect) as f64,
            h: rect_h(&w.rect) as f64,
        })
        .collect()
}

// ── 进程 ────────────────────────────────────────────────────────────────────

/// 可执行文件完整路径。系统进程 / 更高完整性级别的进程会拒绝 OpenProcess——那是正常的。
pub fn exe_path_of(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || size == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

/// 可执行文件名去掉 .exe（chrome.exe → chrome）。
fn process_stem(pid: i32) -> Option<String> {
    exe_path_of(pid).and_then(|p| crate::platform::exe_stem(&p))
}

struct Proc {
    pid: i32,
    parent: i32,
    exe: String,
}

/// 全部进程（Toolhelp 快照）。只有可执行文件名，没有路径——路径要 OpenProcess 逐个问。
fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                out.push(Proc {
                    pid: entry.th32ProcessID as i32,
                    parent: entry.th32ParentProcessID as i32,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..end]),
                });
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// 按进程号反查应用名：可执行名去后缀，拿不到就用它的窗口标题。
pub fn name_of(pid: i32) -> Option<String> {
    if let Some(s) = process_stem(pid) {
        return Some(s);
    }
    if let Some(p) = processes().into_iter().find(|p| p.pid == pid) {
        if let Some(s) = crate::platform::exe_stem(&p.exe) {
            return Some(s);
        }
    }
    top_windows().into_iter().find(|w| w.pid == pid && !w.title.is_empty()).map(|w| w.title)
}

/// 按名字找运行中的应用：可执行名（带不带 .exe）/ **窗口标题** 一次全认。排序规则见 tree_types。
pub fn resolve_app(query: &str) -> Result<AppMatch, Vec<String>> {
    let want = query.trim();
    if want.is_empty() {
        return Err(Vec::new());
    }
    let wins = top_windows();
    let front = frontmost_pid();
    let mut by_pid: HashMap<i32, AppCandidate> = HashMap::new();
    let mut order: Vec<i32> = Vec::new();
    for p in processes() {
        if p.pid <= 0 {
            continue;
        }
        let stem = crate::platform::exe_stem(&p.exe).unwrap_or_else(|| p.exe.clone());
        by_pid.insert(
            p.pid,
            AppCandidate {
                pid: p.pid,
                name: stem,
                aliases: vec![p.exe.clone()],
                titles: Vec::new(),
                has_ui: false,
                frontmost: front == Some(p.pid),
            },
        );
        order.push(p.pid);
    }
    for w in wins.iter().filter(|w| !w.tool && !w.minimized && rect_w(&w.rect) >= 40 && rect_h(&w.rect) >= 40) {
        let c = by_pid.entry(w.pid).or_insert_with(|| {
            order.push(w.pid);
            AppCandidate {
                pid: w.pid,
                name: process_stem(w.pid).unwrap_or_else(|| format!("pid {}", w.pid)),
                aliases: Vec::new(),
                titles: Vec::new(),
                has_ui: false,
                frontmost: front == Some(w.pid),
            }
        });
        c.has_ui = true;
        if !w.title.is_empty() && !c.titles.iter().any(|t| t == &w.title) {
            c.titles.push(w.title.clone());
        }
    }
    // 有界面的在前（z 序），后台进程在后，按名字找时同名优先命中开着窗口的那个。
    let mut cands: Vec<AppCandidate> = Vec::new();
    for w in &wins {
        if let Some(c) = by_pid.remove(&w.pid) {
            cands.push(c);
        }
    }
    for pid in order {
        if let Some(c) = by_pid.remove(&pid) {
            cands.push(c);
        }
    }
    match rank_app_match(want, &cands) {
        Some((i, via)) => {
            let c = &cands[i];
            Ok(AppMatch {
                pid: c.pid,
                name: c.name.clone(),
                bundle: c.aliases.first().cloned().unwrap_or_default(),
                exe: exe_path_of(c.pid).unwrap_or_default(),
                via,
            })
        }
        None => Err(describe_candidates(&cands)),
    }
}

pub fn pid_of(title: &str) -> Option<i32> {
    resolve_app(title).ok().map(|m| m.pid)
}

/// 一个进程「是什么」：可执行路径、目录、是不是 Chromium 内核（Electron / Chrome / Edge / CEF /
/// WebView2 宿主）、本进程和子进程监听的端口。自研应用带 `--remote-debugging-port` 启动时，
/// 调试端口就在 ports 里——WebView2 的端口挂在子进程 msedgewebview2.exe 上，所以要连子进程一起查。
pub fn app_details(pid: i32) -> AppDetails {
    let mut d = AppDetails::default();
    d.exe = exe_path_of(pid).unwrap_or_default();
    if let Some(dir) = std::path::Path::new(&d.exe).parent() {
        d.bundle_path = dir.to_string_lossy().to_string();
        let has = |name: &str| dir.join(name).exists();
        d.chromium = has("chrome_elf.dll")
            || has("libEGL.dll") && has("resources")
            || dir.join("resources").join("app.asar").exists()
            || dir.join("resources").join("electron.asar").exists();
    }
    let procs = processes();
    let lower = d.exe.to_lowercase();
    let mut family = vec![pid];
    for p in &procs {
        if p.parent == pid {
            family.push(p.pid);
            let low = p.exe.to_lowercase();
            if low.contains("msedgewebview2") || low.contains("electron") || low.contains("chrome") {
                d.chromium = true;
            }
        }
    }
    // 孙进程（WebView2 宿主 → msedgewebview2 → 浏览器进程）也算一层。
    let children: Vec<i32> = family[1..].to_vec();
    for p in &procs {
        if children.contains(&p.parent) && !family.contains(&p.pid) {
            family.push(p.pid);
        }
    }
    if !d.chromium {
        d.chromium = ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe", "electron.exe", "msedgewebview2.exe"]
            .iter()
            .any(|k| lower.ends_with(k));
    }
    d.ports = listen_ports(&family);
    d
}

/// 这些进程正在监听的 IPv4 TCP 端口（GetExtendedTcpTable，一次系统调用）。
fn listen_ports(pids: &[i32]) -> Vec<ListenPort> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    let mut out = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if size == 0 {
            return out;
        }
        let mut buf = vec![0u8; size as usize + 64];
        let rc = GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if rc != 0 {
            return out;
        }
        let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let rows = std::slice::from_raw_parts(
            table.table.as_ptr() as *const MIB_TCPROW_OWNER_PID,
            table.dwNumEntries as usize,
        );
        for r in rows {
            let pid = r.dwOwningPid as i32;
            if !pids.contains(&pid) {
                continue;
            }
            let port = u16::from_be((r.dwLocalPort & 0xffff) as u16);
            if port != 0 && !out.iter().any(|p: &ListenPort| p.port == port) {
                out.push(ListenPort { port, pid });
            }
        }
    }
    out
}

// ── 前台切换 ─────────────────────────────────────────────────────────────────

fn windows_of(pid: i32) -> Vec<TopWindow> {
    top_windows().into_iter().filter(|w| w.pid == pid).collect()
}

/// 这个进程的主窗口：z 序最前、有标题、非工具窗的那扇；都没有就退到任何一扇。
fn main_window(pid: i32) -> Option<TopWindow> {
    let wins = windows_of(pid);
    wins.iter()
        .find(|w| !w.tool && !w.owned && !w.title.is_empty())
        .or_else(|| wins.iter().find(|w| !w.tool && !w.title.is_empty()))
        .or_else(|| wins.first())
        .cloned()
}

fn poll(ms: u64, done: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        if done() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

/// 把一扇窗口抢到前台并**回读确认**。Windows 只允许「当前前台进程」换前台，SetForegroundWindow
/// 被拒时只是返回 false 不报错——所以按四级升级，每级都用 GetForegroundWindow 回读：
/// 直接请求 → AttachThreadInput（把自己接到前台线程的输入队列上）→ 模拟一次 Alt 键
/// （系统据此认为本进程正在处理用户输入）→ SwitchToThisWindow（Alt-Tab 同一条路）。
fn bring_to_front(hwnd: HWND, pid: i32) -> bool {
    let confirmed = || unsafe {
        let fg = GetForegroundWindow();
        if fg == hwnd {
            return true;
        }
        let mut p = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut p));
        p as i32 == pid
    };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
        if poll(400, confirmed) {
            return true;
        }
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        if fg_thread != 0 && fg_thread != me {
            let _ = AttachThreadInput(me, fg_thread, true);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(me, fg_thread, false);
            if poll(400, confirmed) {
                return true;
            }
        }
        keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        let _ = SetForegroundWindow(hwnd);
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        if poll(400, confirmed) {
            return true;
        }
        SwitchToThisWindow(hwnd, true);
        poll(700, confirmed)
    }
}

/// 把一个进程切到前台（主窗口）。
pub fn activate(pid: i32) -> Result<(), String> {
    if is_frontmost(pid) == Some(true) {
        return Ok(());
    }
    let w = main_window(pid).ok_or_else(|| format!("pid {pid} 在屏幕上没有窗口（可能只在托盘，或还没画出窗口）"))?;
    if bring_to_front(w.hwnd, pid) {
        return Ok(());
    }
    let front = front_app().map(|f| f.owner).unwrap_or_else(|| "（读不到）".into());
    Err(format!(
        "已用四种方式请求把「{}」切到前台，它仍不在前台，当前前台是「{front}」。\
         合成按键和点击只进前台应用。多半是一个模态框、UAC 提示或全屏应用挡着；用 read_screen 看它此刻在显示什么。",
        name_of(pid).unwrap_or_else(|| pid.to_string())
    ))
}

/// 和 macos_tree 同名：让目标自己到前台；成功与否按回读。
pub fn set_frontmost(pid: i32) -> bool {
    activate(pid).is_ok()
}

/// 把 pid 的某扇窗口（标题含 query，不分大小写）提到最前。
pub fn raise_window(pid: i32, query: &str) -> bool {
    let lw = query.trim().to_lowercase();
    if lw.is_empty() {
        return false;
    }
    match windows_of(pid).into_iter().find(|w| w.title.to_lowercase().contains(&lw)) {
        Some(w) => bring_to_front(w.hwnd, pid),
        None => false,
    }
}

/// 最小化 / 还原主窗口；回读确认，返回窗口标题。
pub fn set_minimized(pid: i32, minimized: bool) -> Result<String, String> {
    let wins = windows_of(pid);
    let target = if minimized {
        wins.iter().find(|w| !w.minimized && !w.tool && !w.title.is_empty())
    } else {
        wins.iter().find(|w| w.minimized)
    };
    let Some(w) = target else {
        return Err(if minimized { "这个应用没有可最小化的窗口".into() } else { "这个应用没有最小化的窗口".into() });
    };
    unsafe {
        let _ = ShowWindow(w.hwnd, if minimized { SW_MINIMIZE } else { SW_RESTORE });
    }
    let h = w.hwnd;
    if poll(2000, || unsafe { IsIconic(h).as_bool() == minimized }) {
        Ok(w.title.clone())
    } else {
        Err(format!("发出了{}请求，但「{}」没有变", if minimized { "最小化" } else { "还原" }, w.title))
    }
}

/// Windows 没有「叫醒可访问性树」的属性：Chromium / Electron 在收到第一次 UIA 查询时自己开启，
/// 所以叫醒发生在 snapshot 里（读到半棵就等一拍再读）。
pub fn wake_ax(_pid: i32) -> bool {
    false
}

// ── 读树 ────────────────────────────────────────────────────────────────────

const CACHED_PROPS: &[UIA_PROPERTY_ID] = &[
    UIA_NamePropertyId,
    UIA_ControlTypePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId,
    UIA_IsPasswordPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_ValueValuePropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
];

fn cache_request(uia: &IUIAutomation) -> Result<IUIAutomationCacheRequest, String> {
    unsafe {
        let cache = uia.CreateCacheRequest().map_err(|e| format!("建缓存请求失败：{e}"))?;
        for p in CACHED_PROPS {
            let _ = cache.AddProperty(*p);
        }
        // 控件视图：跳过纯布局节点，和辅助工具看到的一样。
        if let Ok(cond) = uia.ControlViewCondition() {
            let _ = cache.SetTreeFilter(&cond);
        }
        Ok(cache)
    }
}

fn bstr_text(r: windows::core::Result<BSTR>, max: usize) -> String {
    r.map(|b| b.to_string()).unwrap_or_default().trim().chars().take(max).collect()
}

fn variant_string(v: windows::core::Result<VARIANT>) -> Option<String> {
    let v = v.ok()?;
    BSTR::try_from(&v).ok().map(|b| b.to_string())
}
fn variant_i32(v: windows::core::Result<VARIANT>) -> Option<i32> {
    let v = v.ok()?;
    i32::try_from(&v).ok()
}
fn variant_bool(v: windows::core::Result<VARIANT>) -> Option<bool> {
    let v = v.ok()?;
    bool::try_from(&v).ok()
}
fn variant_f64(v: windows::core::Result<VARIANT>) -> Option<f64> {
    let v = v.ok()?;
    f64::try_from(&v).ok()
}

/// 值：文本框的内容、勾选状态、选中状态、滑块的数、展开状态——只在有意义时给，没有就空。
unsafe fn cached_value(el: &IUIAutomationElement, role: &str) -> String {
    if let Some(s) = variant_string(el.GetCachedPropertyValue(UIA_ValueValuePropertyId)) {
        if !s.trim().is_empty() {
            return s.trim().chars().take(140).collect();
        }
    }
    if matches!(role, "CheckBox" | "RadioButton" | "Button" | "MenuItem") {
        if let Some(t) = variant_i32(el.GetCachedPropertyValue(UIA_ToggleToggleStatePropertyId)) {
            return match t {
                0 => "unchecked".into(),
                1 => "checked".into(),
                _ => "mixed".into(),
            };
        }
    }
    if matches!(role, "Row" | "Tab" | "RadioButton" | "MenuItem") {
        if variant_bool(el.GetCachedPropertyValue(UIA_SelectionItemIsSelectedPropertyId)) == Some(true) {
            return "selected".into();
        }
    }
    if matches!(role, "Slider" | "Incrementor" | "ProgressIndicator" | "ScrollBar") {
        if let Some(n) = variant_f64(el.GetCachedPropertyValue(UIA_RangeValueValuePropertyId)) {
            return format!("{}", n);
        }
    }
    if let Some(s) = variant_i32(el.GetCachedPropertyValue(UIA_ExpandCollapseExpandCollapseStatePropertyId)) {
        return match s {
            0 => "collapsed".into(),
            1 => "expanded".into(),
            2 => "partially expanded".into(),
            _ => String::new(),
        };
    }
    String::new()
}

/// 从缓存里拼一个节点。尺寸退化（不在屏上）的回 None。
unsafe fn node_from_cached(el: &IUIAutomationElement) -> Option<AxNode> {
    let ct = el.CachedControlType().map(|c| c.0).unwrap_or(0);
    let password = el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
    let role = role_for_control_type(ct, password);
    let rect = el.CachedBoundingRectangle().unwrap_or_default();
    let (w, h) = (rect_w(&rect), rect_h(&rect));
    if w < 2 || h < 2 {
        return None;
    }
    if el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    Some(AxNode {
        role: role.to_string(),
        text: bstr_text(el.CachedName(), 120),
        value: cached_value(el, role),
        x: rect.left,
        y: rect.top,
        w,
        h,
        enabled: el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
        id: bstr_text(el.CachedAutomationId(), 80),
    })
}

/// 活读一个元素的签名（不走缓存）。元素没了就 None。
unsafe fn live_node(el: &IUIAutomationElement) -> Option<AxNode> {
    let ct = el.CurrentControlType().ok()?.0;
    let password = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
    let role = role_for_control_type(ct, password);
    let rect = el.CurrentBoundingRectangle().unwrap_or_default();
    Some(AxNode {
        role: role.to_string(),
        text: bstr_text(el.CurrentName(), 120),
        value: variant_string(el.GetCurrentPropertyValue(UIA_ValueValuePropertyId))
            .unwrap_or_default()
            .chars()
            .take(140)
            .collect(),
        x: rect.left,
        y: rect.top,
        w: rect_w(&rect),
        h: rect_h(&rect),
        enabled: el.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
        id: bstr_text(el.CurrentAutomationId(), 80),
    })
}

/// 拍一份某个进程的可访问性树。
///
/// 只走用户真看得见的窗口：前台的排最前，然后按 z 序；最小化的和尺寸退化的跳过；对话框 /
/// 弹出菜单（它们是独立的顶层窗口，有属主）**要**算进来——模态框弹出来时它才是要点的东西。
pub fn snapshot(pid: i32, cap: usize) -> (Vec<AxNode>, Option<PageState>) {
    let (nodes, page, chromium_shallow) = snapshot_inner(pid, cap, true);
    if chromium_shallow {
        // Chromium / Electron 收到第一次 UIA 查询才开始建树，建好要一小会儿：第一遍只有壳就等一拍再读。
        std::thread::sleep(std::time::Duration::from_millis(400));
        let (n2, p2, _) = snapshot_inner(pid, cap, true);
        if n2.len() > nodes.len() {
            return (n2, p2);
        }
    }
    (nodes, page)
}

/// 只看一眼，**不动句柄表**（后台轮询用）。
pub fn snapshot_probe(pid: i32, cap: usize) -> (Vec<AxNode>, Option<PageState>) {
    let (n, p, _) = snapshot_inner(pid, cap, false);
    (n, p)
}

fn snapshot_inner(pid: i32, cap: usize, keep_handles: bool) -> (Vec<AxNode>, Option<PageState>, bool) {
    let mut out: Vec<AxNode> = Vec::new();
    let mut page: Option<PageState> = None;
    let mut handles: Vec<(u32, IUIAutomationElement, AxNode)> = Vec::new();
    let mut chromium = false;
    let Ok(uia) = uia() else {
        return (out, page, false);
    };
    let Ok(cache) = cache_request(&uia) else {
        return (out, page, false);
    };
    let mut wins: Vec<TopWindow> = windows_of(pid)
        .into_iter()
        .filter(|w| !w.minimized && rect_w(&w.rect) >= 40 && rect_h(&w.rect) >= 40)
        .collect();
    // 前台的那扇排最前（被 cap 截断时先留它）。
    let fg = unsafe { GetForegroundWindow() };
    wins.sort_by_key(|w| if w.hwnd == fg { 0 } else { 1 });
    unsafe {
        let cond = uia.ControlViewCondition().or_else(|_| uia.CreateTrueCondition());
        let Ok(cond) = cond else {
            return (out, page, false);
        };
        for w in wins.into_iter().take(6) {
            if w.class.starts_with("Chrome_WidgetWin") {
                chromium = true;
            }
            let Ok(root) = uia.ElementFromHandleBuildCache(w.hwnd, &cache) else {
                continue;
            };
            let mut push = |el: IUIAutomationElement, out: &mut Vec<AxNode>| -> bool {
                if let Some(node) = node_from_cached(&el) {
                    if page.is_none() && node.role == "Document" {
                        page = Some(PageState { title: node.text.clone(), loaded: true, progress: 1.0 });
                    }
                    let id = out.len() as u32 + 1;
                    handles.push((id, el, node.clone()));
                    out.push(node);
                }
                out.len() >= cap
            };
            if push(root.clone(), &mut out) {
                break;
            }
            let Ok(arr) = root.FindAllBuildCache(TreeScope_Descendants, &cond, &cache) else {
                continue;
            };
            let n = arr.Length().unwrap_or(0);
            let mut full = false;
            for i in 0..n {
                if let Ok(el) = arr.GetElement(i) {
                    if push(el, &mut out) {
                        full = true;
                        break;
                    }
                }
            }
            if full {
                break;
            }
        }
    }
    let shallow = chromium && out.len() < 12;
    if keep_handles {
        store_handles(pid, handles);
    }
    (out, page, shallow)
}

// ── 句柄表 ──────────────────────────────────────────────────────────────────

struct Held {
    el: IUIAutomationElement,
    sig: AxNode,
    pid: i32,
}
// UIA 客户端元素是自由线程的 COM 对象；表本身用互斥量保护。
unsafe impl Send for Held {}

static HANDLES: Mutex<Option<HashMap<u32, Held>>> = Mutex::new(None);

fn store_handles(pid: i32, items: Vec<(u32, IUIAutomationElement, AxNode)>) {
    ensure_com();
    let mut map = HashMap::new();
    for (id, el, sig) in items {
        map.insert(id, Held { el, sig, pid });
    }
    if let Ok(mut g) = HANDLES.lock() {
        *g = Some(map); // 旧表在这里 drop，COM 引用随之释放
    }
}

// ── 动作 ────────────────────────────────────────────────────────────────────

unsafe fn send_mouse(flags_down: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, flags_up: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) {
    let mk = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let inputs = [mk(flags_down), mk(flags_up)];
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// 在屏幕点（物理像素）上点一下。SetCursorPos 在 DPI 感知的进程里收物理像素，且跨显示器可用。
unsafe fn click_at(x: i32, y: i32, right: bool) {
    let _ = SetCursorPos(x, y);
    std::thread::sleep(std::time::Duration::from_millis(30));
    if right {
        send_mouse(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP);
    } else {
        send_mouse(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
    }
}

unsafe fn key_tap(vk: VIRTUAL_KEY, with_ctrl: bool) {
    let mk = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let mut seq = Vec::new();
    if with_ctrl {
        seq.push(mk(VK_CONTROL, false));
    }
    seq.push(mk(vk, false));
    seq.push(mk(vk, true));
    if with_ctrl {
        seq.push(mk(VK_CONTROL, true));
    }
    SendInput(&seq, std::mem::size_of::<INPUT>() as i32);
}

/// 逐字打 Unicode（KEYEVENTF_UNICODE），不依赖键盘布局，中文也直接进。
unsafe fn type_unicode(text: &str) {
    let mut seq = Vec::new();
    for unit in text.encode_utf16() {
        for up in [false, true] {
            seq.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: unit,
                        dwFlags: if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    if !seq.is_empty() {
        SendInput(&seq, std::mem::size_of::<INPUT>() as i32);
    }
}

fn center(n: &AxNode) -> (i32, i32) {
    (n.x + n.w / 2, n.y + n.h / 2)
}

/// 「按下」的升级序列：Invoke → Toggle → 选中 → 展开/收起 → 旧接口的默认动作 → 按中心点点击。
/// 返回用了哪一条。
unsafe fn press(el: &IUIAutomationElement, live: &AxNode) -> Result<&'static str, String> {
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
        if p.Invoke().is_ok() {
            return Ok("Invoke");
        }
    }
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
        if p.Toggle().is_ok() {
            return Ok("Toggle");
        }
    }
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
        if p.Select().is_ok() {
            return Ok("Select");
        }
    }
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
        let expanded = p.CurrentExpandCollapseState().map(|s| s == ExpandCollapseState_Expanded).unwrap_or(false);
        let ok = if expanded { p.Collapse().is_ok() } else { p.Expand().is_ok() };
        if ok {
            return Ok(if expanded { "Collapse" } else { "Expand" });
        }
    }
    if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
        if p.DoDefaultAction().is_ok() {
            return Ok("DoDefaultAction");
        }
    }
    // 没有任何模式：按中心点点。前提是它在屏幕上（尺寸非零）。
    if live.w > 0 && live.h > 0 {
        let (x, y) = center(live);
        click_at(x, y, false);
        return Ok("click");
    }
    Err(format!("「{}」不响应任何 UIA 动作，也不在屏幕上（role={}）", live.text, live.role))
}

/// 在同一扇窗口里找一个按钮并按下（confirm / cancel 用）。
unsafe fn press_button_named(el: &IUIAutomationElement, names: &[&str]) -> Option<String> {
    let uia = uia().ok()?;
    // 先找它所在的顶层窗口元素：沿 raw 视图往上走到 ControlType=Window。
    let walker = uia.RawViewWalker().ok()?;
    let mut cur = el.clone();
    let mut window: Option<IUIAutomationElement> = None;
    for _ in 0..40 {
        if cur.CurrentControlType().map(|c| c.0 == 50032).unwrap_or(false) {
            window = Some(cur.clone());
            break;
        }
        match walker.GetParentElement(&cur) {
            Ok(p) => cur = p,
            Err(_) => break,
        }
    }
    let scope = window.unwrap_or_else(|| el.clone());
    let cond = uia
        .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(50000i32))
        .ok()?;
    let arr = scope.FindAll(TreeScope_Descendants, &cond).ok()?;
    let n = arr.Length().unwrap_or(0);
    for i in 0..n {
        let Ok(b) = arr.GetElement(i) else { continue };
        let name = bstr_text(b.CurrentName(), 60);
        let lname = name.trim().trim_end_matches(['(', '（']).to_lowercase();
        if names.iter().any(|w| lname == *w || lname.starts_with(&format!("{w}(")) || lname.starts_with(&format!("{w}（"))) {
            if let Ok(p) = b.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                if p.Invoke().is_ok() {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// 对一个 ref 执行动作。动作名和 macOS 那边**完全一致**（ui_click 放行的那一批）。
pub fn act(
    reference: u32,
    action: &str,
    value: Option<&str>,
    expect_pid: Option<i32>,
) -> Result<serde_json::Value, String> {
    ensure_com();
    let g = HANDLES.lock().map_err(|_| "句柄表不可用".to_string())?;
    let map = g.as_ref().ok_or("还没有读过屏；先调 screen.elements")?;
    let held = map
        .get(&reference)
        .ok_or_else(|| format!("ref {reference} 不在最近一次读屏结果里；重新读一次"))?;
    if let Some(want) = expect_pid {
        if want != held.pid {
            return Err(format!(
                "这个 ref 属于进程 {}，而这次动作要操作的是进程 {want}——中间有过一次读屏把句柄表换掉了。重新 read_screen 再操作。",
                held.pid
            ));
        }
    }
    unsafe {
        let live = live_node(&held.el).ok_or("这个元素已经不存在了；重新读一次屏")?;
        if let Some(d) = signature_drift(&held.sig, &live) {
            return Err(format!("ref {reference} 已经过期（{d}）——界面变过了。重新 screen.elements 再操作。"));
        }
        let el = &held.el;
        match action {
            "press" => {
                let used = press(el, &live)?;
                Ok(serde_json::json!({ "ok": true, "action": "press", "used": used, "role": live.role, "text": live.text }))
            }
            "focus" => {
                el.SetFocus().map_err(|e| format!("聚焦被拒（{e}）"))?;
                let got = poll(300, || el.CurrentHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false));
                if !got {
                    return Err("请求被接受，但焦点没落到这个元素上".into());
                }
                Ok(serde_json::json!({ "ok": true, "action": "focus", "role": live.role }))
            }
            "set_value" => {
                let v = value.ok_or("set_value 需要 value")?;
                if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                    if p.SetValue(&BSTR::from(v)).is_ok() {
                        let back = bstr_text(p.CurrentValue(), 4000);
                        if back == v {
                            return Ok(serde_json::json!({ "ok": true, "action": "set_value", "value": back, "used": "ValuePattern" }));
                        }
                    }
                }
                // 没有 Value 模式（很多自绘输入框、部分网页控件）：聚焦、全选、逐字打。
                el.SetFocus().map_err(|e| format!("这个控件不支持直接写值，聚焦以便打字也失败了（{e}）"))?;
                std::thread::sleep(std::time::Duration::from_millis(60));
                key_tap(VIRTUAL_KEY(0x41), true); // Ctrl+A
                type_unicode(v);
                std::thread::sleep(std::time::Duration::from_millis(80));
                let back = variant_string(el.GetCurrentPropertyValue(UIA_ValueValuePropertyId)).unwrap_or_default();
                Ok(serde_json::json!({
                    "ok": true, "action": "set_value", "used": "type",
                    "value": if back.is_empty() { serde_json::Value::Null } else { serde_json::json!(back) },
                    "note": if back.is_empty() { "这个控件不回显值，请 read_screen 确认打进去的内容" } else { "" },
                }))
            }
            "scroll_to" => {
                let p = el
                    .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                    .map_err(|_| format!("「{}」不支持 scroll_to（ScrollItem）", live.text))?;
                p.ScrollIntoView().map_err(|e| format!("滚动被拒（{e}）"))?;
                let r = el.CurrentBoundingRectangle().unwrap_or_default();
                Ok(serde_json::json!({
                    "ok": true, "action": "scroll_to", "role": live.role, "text": live.text, "x": r.left, "y": r.top,
                    "note": "滚动后这一屏的元素位置全变了，之前那批 ref 已经作废——先重新 read_screen 再操作。",
                }))
            }
            "increment" | "decrement" => {
                if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId) {
                    let cur = p.CurrentValue().unwrap_or(0.0);
                    let step = p.CurrentSmallChange().unwrap_or(1.0).max(f64::EPSILON);
                    let target = if action == "increment" { cur + step } else { cur - step };
                    p.SetValue(target).map_err(|e| format!("设值被拒（{e}）"))?;
                    let now = p.CurrentValue().unwrap_or(target);
                    return Ok(serde_json::json!({ "ok": true, "action": action, "value": now.to_string() }));
                }
                el.SetFocus().map_err(|e| format!("「{}」没有范围值模式，聚焦以便按方向键也失败了（{e}）", live.text))?;
                key_tap(if action == "increment" { VIRTUAL_KEY(0x26) } else { VIRTUAL_KEY(0x28) }, false); // Up / Down
                Ok(serde_json::json!({ "ok": true, "action": action, "used": "arrow-key", "role": live.role }))
            }
            "show_menu" => {
                let (x, y) = center(&live);
                click_at(x, y, true);
                Ok(serde_json::json!({ "ok": true, "action": "show_menu", "role": live.role, "text": live.text, "note": "弹出菜单是一扇新窗口，read_screen 才看得到它的项" }))
            }
            "pick" => {
                if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                    if p.Select().is_ok() {
                        return Ok(serde_json::json!({ "ok": true, "action": "pick", "used": "Select", "text": live.text }));
                    }
                }
                if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                    if p.Expand().is_ok() {
                        return Ok(serde_json::json!({ "ok": true, "action": "pick", "used": "Expand", "text": live.text }));
                    }
                }
                let used = press(el, &live)?;
                Ok(serde_json::json!({ "ok": true, "action": "pick", "used": used, "text": live.text }))
            }
            "confirm" | "cancel" => {
                let names: &[&str] = if action == "confirm" {
                    &["ok", "确定", "确认", "是", "yes", "confirm", "apply", "应用", "save", "保存", "open", "打开", "next", "下一步", "finish", "完成", "install", "安装"]
                } else {
                    &["cancel", "取消", "否", "no", "close", "关闭", "dismiss", "不保存", "don't save"]
                };
                if let Some(pressed) = press_button_named(el, names) {
                    return Ok(serde_json::json!({ "ok": true, "action": action, "pressed": pressed }));
                }
                // 找不到按钮：用键盘的确认 / 取消。
                let _ = el.SetFocus();
                key_tap(if action == "confirm" { VK_RETURN } else { VK_ESCAPE }, false);
                Ok(serde_json::json!({ "ok": true, "action": action, "used": if action == "confirm" { "Enter" } else { "Escape" } }))
            }
            other => Err(format!(
                "不支持的动作「{other}」；可用：press / focus / set_value / scroll_to / increment / decrement / show_menu / confirm / cancel / pick"
            )),
        }
    }
}

// ── 显示器 ──────────────────────────────────────────────────────────────────

/// 全部显示器：(id, x, y, w, h, is_main)，物理像素，全局坐标（副屏可能是负数）。
pub fn list_displays() -> Vec<(u32, i32, i32, u32, u32, bool)> {
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW};
    use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;
    unsafe extern "system" fn cb(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(u32, i32, i32, u32, u32, bool)>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            let r = info.monitorInfo.rcMonitor;
            let id = out.len() as u32 + 1;
            out.push((
                id,
                r.left,
                r.top,
                (r.right - r.left).max(0) as u32,
                (r.bottom - r.top).max(0) as u32,
                info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            ));
        }
        true.into()
    }
    let mut out: Vec<(u32, i32, i32, u32, u32, bool)> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(HDC::default(), None, Some(cb), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

// ── OCR（WinRT Windows.Media.Ocr，系统自带，按已装的语言包识别）────────────────────

/// 一块识别出来的文字：屏幕坐标（物理像素）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrBox {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 对屏幕上一块区域做 OCR。`png` 是这块区域的截图（物理像素），`origin` 是它左上角的屏幕坐标。
/// 系统 OCR 的图像边长上限通常是 2600：超了就先缩小，坐标再乘回去。
pub fn ocr_png(png: &[u8], origin: (i32, i32)) -> Result<Vec<OcrBox>, String> {
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    ensure_com();
    let decoded = image::load_from_memory(png).map_err(|e| format!("截图解码失败：{e}"))?;
    let mut rgba = decoded.to_rgba8();
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600).max(64);
    let (pw, ph) = rgba.dimensions();
    let mut scale = 1.0f64;
    if pw > max || ph > max {
        scale = (max as f64 / pw as f64).min(max as f64 / ph as f64);
        let nw = ((pw as f64 * scale).floor() as u32).max(1);
        let nh = ((ph as f64 * scale).floor() as u32).max(1);
        rgba = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
    }
    let (w, h) = rgba.dimensions();
    let mut bgra = rgba.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .ok()
        .or_else(|| {
            ["zh-Hans", "en-US", "zh-Hant", "ja"].iter().find_map(|tag| {
                let lang = Language::CreateLanguage(&windows::core::HSTRING::from(*tag)).ok()?;
                OcrEngine::TryCreateFromLanguage(&lang).ok()
            })
        })
        .ok_or_else(|| "系统没有可用的 OCR 语言包（设置 → 时间和语言 → 语言，给当前语言装上「光学字符识别」）".to_string())?;
    let writer = DataWriter::new().map_err(|e| e.to_string())?;
    writer.WriteBytes(&bgra).map_err(|e| e.to_string())?;
    let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        w as i32,
        h as i32,
        BitmapAlphaMode::Ignore,
    )
    .map_err(|e| format!("建位图失败：{e}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| format!("OCR 失败：{e}"))?;
    let mut out = Vec::new();
    let lines = result.Lines().map_err(|e| e.to_string())?;
    let count = lines.Size().unwrap_or(0);
    for i in 0..count {
        let Ok(line) = lines.GetAt(i) else { continue };
        let words = line.Words().map_err(|e| e.to_string())?;
        let wc = words.Size().unwrap_or(0);
        // 按行聚合：一行的框 = 各词框的并集；只给词太碎，模型要的是「这句话在哪」。
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        let mut text = String::new();
        for j in 0..wc {
            let Ok(word) = words.GetAt(j) else { continue };
            let r = word.BoundingRect().unwrap_or_default();
            x0 = x0.min(r.X);
            y0 = y0.min(r.Y);
            x1 = x1.max(r.X + r.Width);
            y1 = y1.max(r.Y + r.Height);
            let t = word.Text().map(|s| s.to_string()).unwrap_or_default();
            if !text.is_empty() && !t.chars().next().map(|c| c.is_ascii_punctuation()).unwrap_or(false) {
                // 中日文之间不加空格；拉丁词之间加。
                let last_latin = text.chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                let first_latin = t.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                if last_latin || first_latin {
                    text.push(' ');
                }
            }
            text.push_str(&t);
        }
        if text.trim().is_empty() || x1 <= x0 || y1 <= y0 {
            continue;
        }
        out.push(OcrBox {
            text,
            x: origin.0 + (x0 as f64 / scale).round() as i32,
            y: origin.1 + (y0 as f64 / scale).round() as i32,
            w: ((x1 - x0) as f64 / scale).round() as i32,
            h: ((y1 - y0) as f64 / scale).round() as i32,
        });
    }
    Ok(out)
}

/// 某个进程主窗口的屏幕矩形（物理像素），给 OCR 截取用。
pub fn main_window_rect(pid: i32) -> Option<(i32, i32, i32, i32)> {
    let w = main_window(pid)?;
    if w.minimized || rect_w(&w.rect) < 2 || rect_h(&w.rect) < 2 {
        return None;
    }
    Some((w.rect.left, w.rect.top, rect_w(&w.rect), rect_h(&w.rect)))
}

#[allow(dead_code)]
fn _unused_handle(_h: HANDLE) {}
