//! Windows 平台特定实现

use crate::error::{Error, Result};
use crate::platform::WindowControl;
use crate::types::{ScreenInfo, WindowInfo};
use windows::Win32::Foundation::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use std::mem;

pub struct WindowsControl;

impl WindowsControl {
    pub fn new() -> Self {
        Self
    }
}

impl WindowControl for WindowsControl {
    fn enumerate_windows(&self) -> Result<Vec<WindowInfo>> {
        let mut windows = Vec::new();
        
        unsafe {
            EnumWindows(
                Some(enum_windows_callback),
                LPARAM(&mut windows as *mut _ as isize),
            )
            .map_err(|e| Error::System(format!("枚举窗口失败: {:?}", e)))?;
        }
        
        Ok(windows)
    }
    
    fn find_window(&self, title: &str) -> Result<Option<WindowInfo>> {
        let windows = self.enumerate_windows()?;
        Ok(windows.into_iter().find(|w| w.title.contains(title)))
    }
    
    /// 按窗口标题或应用名激活。名字怎么认见 windows_tree::resolve_app（可执行名 / 窗口标题一次全认）；
    /// 按标题命中的还会把那扇窗口本身提到最前。抢前台的四级升级和回读在 windows_tree::activate。
    fn activate_window(&self, title: &str) -> Result<()> {
        let m = crate::platform::windows_tree::resolve_app(title)
            .map_err(|c| Error::ElementNotFound(crate::platform::windows_tree::no_such_app(title, &c)))?;
        if m.via == "window_title" && crate::platform::windows_tree::raise_window(m.pid, title) {
            return Ok(());
        }
        crate::platform::windows_tree::activate(m.pid).map_err(Error::System)
    }

    fn activate_pid(&self, pid: i32) -> Result<()> {
        crate::platform::windows_tree::activate(pid).map_err(Error::System)
    }

    fn minimize_window(&self, title: &str) -> Result<()> {
        let hwnd = match find_hwnd_by_title(title) {
            Ok(h) => h,
            Err(e) => {
                // 标题找不到就按应用名找（可执行名 / 窗口标题一次全认）。
                return match crate::platform::windows_tree::resolve_app(title) {
                    Ok(m) => crate::platform::windows_tree::set_minimized(m.pid, true).map(|_| ()).map_err(Error::System),
                    Err(_) => Err(e),
                };
            }
        };
        
        unsafe {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
        }
        
        await_window_state(
            hwnd,
            |h| unsafe { IsIconic(h).as_bool() },
            2000,
            &format!("发出了最小化请求，但「{}」还没有收起来。", title),
        )
    }
    
    fn restore_window(&self, title: &str) -> Result<()> {
        let hwnd = match find_hwnd_by_title(title) {
            Ok(h) => h,
            Err(e) => {
                return match crate::platform::windows_tree::resolve_app(title) {
                    Ok(m) => crate::platform::windows_tree::set_minimized(m.pid, false).map(|_| ()).map_err(Error::System),
                    Err(_) => Err(e),
                };
            }
        };
        
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        
        await_window_state(
            hwnd,
            |h| unsafe { !IsIconic(h).as_bool() },
            2000,
            &format!("发出了还原请求，但「{}」还是最小化状态。", title),
        )
    }
    
    fn maximize_window(&self, title: &str) -> Result<()> {
        let hwnd = find_hwnd_by_title(title)?;
        
        unsafe {
            let _ = ShowWindow(hwnd, SW_MAXIMIZE);
        }
        
        await_window_state(
            hwnd,
            |h| unsafe { IsZoomed(h).as_bool() },
            2000,
            &format!("发出了最大化请求，但「{}」没有铺满。有些窗口自己禁用了最大化。", title),
        )
    }
    
    fn close_window(&self, title: &str) -> Result<()> {
        let hwnd = find_hwnd_by_title(title)?;
        
        unsafe {
            PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0))
                .map_err(|e| Error::System(format!("关闭窗口失败: {:?}", e)))?;
        }
        
        Ok(())
    }
    
    fn get_screen_info(&self) -> Result<ScreenInfo> {
        unsafe {
            let width = GetSystemMetrics(SM_CXSCREEN) as u32;
            let height = GetSystemMetrics(SM_CYSCREEN) as u32;
            
            // 获取 DPI 缩放
            let hdc = GetDC(HWND(std::ptr::null_mut()));
            let dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
            let scale_factor = dpi_x as f64 / 96.0;
            ReleaseDC(HWND(std::ptr::null_mut()), hdc);
            
            Ok(ScreenInfo {
                width,
                height,
                scale_factor,
            })
        }
    }
}

// 回调函数：枚举窗口
/// 查 pid 对应的可执行文件名（不带 `.exe`）。
///
/// 拿不到就返回 None——系统进程和更高完整性级别的进程会拒绝 OpenProcess，
/// 这是正常的，不是错误；调用方会退回到 `pid <n>`，那样至少不会假装
/// 自己知道这是什么程序。
fn process_name_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || size == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        crate::platform::exe_stem(&full)
    }
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    
    // 只收集可见的顶层窗口。
    //
    // 光看 IsWindowVisible 不够，三类窗口会混进来，而它们对模型都是噪音甚至陷阱：
    //  · WS_EX_TOOLWINDOW：浮动工具条、输入法候选框。用户不会说"切到那个窗口"。
    //  · DWM cloaked：切走的虚拟桌面上的窗口、以及挂起的 UWP 应用。它们
    //    IsWindowVisible 为真、GetWindowRect 给的是正常矩形——完全看不出异样，
    //    但屏幕上根本没有这个东西，照着点就是点到底下别的窗口上。
    //  · 有属主的窗口（GW_OWNER 非空）：对话框、气泡提示，跟着主窗口走，
    //    自己不是一个独立目标。
    // macOS 那侧靠 kCGWindowLayer==0 一次筛掉这一整类，Windows 得逐项来。
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return true.into();
    }
    if !GetWindow(hwnd, GW_OWNER).unwrap_or_default().is_invalid() {
        return true.into();
    }
    {
        let mut cloaked: u32 = 0;
        let ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok();
        if ok && cloaked != 0 {
            return true.into();
        }
    }
    
    // 获取窗口标题
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    
    if title_len == 0 {
        return true.into();
    }
    
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
    
    // 获取进程名
    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    // 以前这里是 `format!("process_{}", pid)`，于是 window.list 在 Windows 上
    // 回给模型的是一串 `process_7314`——没法据此认出哪个窗口是浏览器、哪个是
    // 终端，"切到某个应用"这类任务只能靠标题猜。改成读真实的可执行文件名。
    let process_name = process_name_of(process_id)
        .unwrap_or_else(|| format!("pid {}", process_id));
    
    let is_minimized = IsIconic(hwnd).as_bool();
    
    // 获取窗口位置。
    //
    // 两处会给出**看着像真值的假坐标**，而下游会拿它去算点击位置：
    //  · 最小化的窗口，GetWindowRect 返回的是 (-32000, -32000) 这个哨兵值，
    //    宽高算出来还是正的 160x160 —— 完全通得过「宽高大于 0」的检查，
    //    然后模型照着去点屏幕外的坐标，一声不响地点空。
    //  · GetWindowRect 本身会失败（窗口正在销毁），原来是 `let _ =` 吞掉，
    //    留下一个全 0 的 RECT，同样是一份能通过检查的假几何。
    // 两种情况都归零，由上层统一按「这条没有几何」处理，而不是发一个假的出去。
    let mut rect = RECT::default();
    let rect_ok = GetWindowRect(hwnd, &mut rect).is_ok() && !is_minimized;
    let (x, y, width, height) = if rect_ok {
        (
            rect.left,
            rect.top,
            (rect.right - rect.left).max(0) as u32,
            (rect.bottom - rect.top).max(0) as u32,
        )
    } else {
        (0, 0, 0, 0)
    };
    
    windows.push(WindowInfo {
        title,
        process_name,
        x,
        y,
        width,
        height,
        is_visible: true,
        // 真正的前台判据。GetForegroundWindow 已经在作用域里（文件头的 glob 导入）。
        is_frontmost: hwnd == GetForegroundWindow(),
        is_minimized,
    });
    
    true.into()
}

// 辅助函数：根据标题查找窗口句柄
fn find_hwnd_by_title(title: &str) -> Result<HWND> {
    // FindWindowW 要求标题**完全相等**，而同一个文件里的 find_window 用的是
    // `w.title.contains(title)`。于是 activate_window 会先用子串匹配确认窗口存在、
    // 再用精确匹配去拿句柄，然后报「未找到窗口」——同一次调用里两条判据打架。
    //
    // 而且窗口标题几乎都是动态的（"文件名 — 应用名"、带未读数的、带进度的），
    // 模型只可能拿到它读到的那一瞬间的标题。要求完全相等等于要求它猜中一个会变的字符串。
    //
    // 先试精确（有同名窗口时这是最不意外的一个），再退到子串。
    let title_wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    unsafe {
        if let Ok(h) = FindWindowW(PCWSTR::null(), PCWSTR(title_wide.as_ptr())) {
            if !h.is_invalid() {
                return Ok(h);
            }
        }
    }
    
    let mut hits: Vec<(HWND, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect_titled_windows),
            LPARAM(&mut hits as *mut _ as isize),
        );
    }
    // 前台的那个优先——用户说「那个 Chrome」时指的通常是刚才在看的那个。
    let fg = unsafe { GetForegroundWindow() };
    let mut matched: Vec<&(HWND, String)> = hits.iter().filter(|(_, t)| t.contains(title)).collect();
    matched.sort_by_key(|(h, _)| if *h == fg { 0 } else { 1 });
    match matched.first() {
        Some((h, _)) => Ok(*h),
        None => Err(Error::ElementNotFound(format!(
            "未找到标题里含有「{}」的窗口。window.list 能列出当前所有窗口的真实标题。",
            title
        ))),
    }
}

/// 轮询等一个窗口状态变成预期值。
///
/// Windows 上 ShowWindow / SetForegroundWindow 都是**发消息**：函数返回不代表
/// 窗口已经变了，甚至不代表请求会被接受（前台锁、窗口自己拒绝最大化都是常见的）。
/// 不回读的话，回执里那句「已确认」就是编的。
fn await_window_state<F>(hwnd: HWND, done: F, budget_ms: u64, failure: &str) -> Result<()>
where
    F: Fn(HWND) -> bool,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    loop {
        if done(hwnd) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(Error::System(failure.to_string()));
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

/// 收集所有带标题的顶层窗口，给 find_hwnd_by_title 的子串回退用。
unsafe extern "system" fn collect_titled_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let hits = &mut *(lparam.0 as *mut Vec<(HWND, String)>);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        hits.push((hwnd, String::from_utf16_lossy(&buf[..len as usize])));
    }
    true.into()
}
