//! macOS 平台特定实现

use crate::error::{Error, Result};
use crate::platform::WindowControl;
use crate::types::{ScreenInfo, WindowInfo};
use cocoa::base::{id, nil};
use core_graphics::display::CGDisplay;
use objc::{class, msg_send, sel, sel_impl};

pub struct MacOSControl;

impl MacOSControl {
    pub fn new() -> Self {
        Self
    }
}

    /// 按应用名找进程号。activate_window 里那段遍历做的是同一件事。
unsafe fn pid_of_app(title: &str) -> Option<i32> {
    // 和读屏 / 激活是同一条规则（macos_tree::resolve_app），不许各认各的。
    crate::platform::macos_tree::pid_of(title)
}

/// 当前前台应用的显示名。先读窗口服务器的 z 序（活的），读不到再问 NSWorkspace——后者在这个
/// 没有事件循环的进程里是启动时的旧快照（见 macos_tree::frontmost_pid 的说明）。
fn frontmost_app_name() -> Option<String> {
    if let Some(w) = crate::platform::macos_tree::front_app() {
        if !w.owner.is_empty() {
            return Some(w.owner);
        }
    }
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: id = msg_send![workspace, frontmostApplication];
        if app == nil {
            return None;
        }
        let name: id = msg_send![app, localizedName];
        if name == nil {
            return None;
        }
        let ptr: *const i8 = msg_send![name, UTF8String];
        Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().to_string())
    }
}

/// 把某个进程切到前台并**回读确认**。activateWithOptions 只是发请求：被 Space、对话框、权限提示挡住时
/// 它照样返回，而合成按键只进前台应用——不确认就往下打字，字就打进别的应用里。
///
/// 确认必须问活的来源（目标应用自己的 AXFrontmost，其次窗口服务器的 z 序）。NSRunningApplication.isActive
/// 在这个没有事件循环的进程里永远是旧值：老实现拿它回读，激活明明成功也报「2.5 秒后仍不在前台」，
/// 模型就此停手——这是所有者「动不动报错」里实测到的一条。
///
/// 三级升级：NSRunningApplication 请求 → AX 让它自己 activate（macOS 14+ 协作式激活拒绝前者时这条仍通）
/// → LaunchServices（/usr/bin/open -b，和用户点 Dock 是同一条路）。每级都回读，切到了就立刻返回。
fn activate_running_app(pid: i32, name: &str) -> Result<()> {
    use std::time::{Duration, Instant};
    let confirmed = || -> bool {
        match crate::platform::macos_tree::is_frontmost(pid) {
            Some(v) => v,
            None => crate::platform::macos_tree::frontmost_pid() == Some(pid),
        }
    };
    let wait = |ms: u64| -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            if confirmed() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    if confirmed() {
        return Ok(());
    }
    let bundle = unsafe {
        let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if app == nil {
            return Err(Error::ElementNotFound(format!("没有 pid 为 {pid} 的运行中应用")));
        }
        // 1 = ActivateAllWindows，2 = ActivateIgnoringOtherApps：两个都带，最小化以外的窗口一起提前。
        let _: bool = msg_send![app, activateWithOptions: 3usize];
        let bid: id = msg_send![app, bundleIdentifier];
        if bid == nil {
            String::new()
        } else {
            let ptr: *const i8 = msg_send![bid, UTF8String];
            std::ffi::CStr::from_ptr(ptr).to_string_lossy().to_string()
        }
    };
    if wait(900) {
        return Ok(());
    }
    if crate::platform::macos_tree::set_frontmost(pid) && wait(700) {
        return Ok(());
    }
    if !bundle.is_empty() {
        let _ = std::process::Command::new("/usr/bin/open").arg("-b").arg(&bundle).status();
        if wait(900) {
            return Ok(());
        }
    }
    let front = frontmost_app_name().unwrap_or_else(|| "（读不到）".to_string());
    Err(Error::Timeout(format!(
        "已用三种方式请求把「{name}」切到前台（激活请求 / 辅助功能 / LaunchServices），2.5 秒后它仍不在前台，\
当前前台是「{front}」。合成按键和点击只进前台应用，此刻继续 keyboard.type / mouse.click 会打进「{front}」。\
先处理挡在前面的东西（模态对话框、权限提示、另一个 Space、全屏应用），或用 read_screen 看它此刻在显示什么。"
    )))
}

impl WindowControl for MacOSControl {
    /// 枚举**真窗口**，不是运行中的应用。
    ///
    /// 原来这里走 `NSWorkspace.runningApplications`——那是应用列表，不是窗口列表：
    /// x/y/width/height 全部硬写 0，还会混进 universalaccessd / talagentd 这类
    /// 根本没有窗口的后台守护进程（实测本机 99 条，几何全 0）。
    /// 而工具描述教模型「先用 window.list 找到窗口，再把它前置/按坐标点进去」——
    /// 拿到的坐标永远是 0,0,0×0，回执里一句说明都没有。
    ///
    /// 改用 CGWindowListCopyWindowInfo（core-graphics 已经是依赖，同文件 150 行
    /// 就在用 CGDisplay）：只取屏幕上真实存在的窗口层，带真实几何。
    fn enumerate_windows(&self) -> Result<Vec<WindowInfo>> {
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_graphics::window::{
            copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
            kCGWindowListOptionOnScreenOnly,
        };

        // 前台 = z 序第一扇普通窗口的主人。NSWorkspace.frontmostApplication 在这个没有事件循环的
        // 进程里是旧快照，拿它标 is_frontmost 会让 keyboard.type 的回执把字说成进了别的窗口。
        let mut front_pid: Option<i32> = None;

        let mut windows = Vec::new();
        let Some(list) = copy_window_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        ) else {
            return Ok(windows);
        };

        for item in list.iter() {
            let dict: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as *const _) };
            let s_of = |key: &str| -> String {
                dict.find(&CFString::new(key))
                    .and_then(|v| v.downcast::<CFString>())
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            };
            let n_of = |key: &str| -> f64 {
                dict.find(&CFString::new(key))
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|v| v.to_f64())
                    .unwrap_or(0.0)
            };
            // layer != 0 是菜单栏 / Dock / 悬浮面板这类系统层，不是可操作的应用窗口。
            if n_of("kCGWindowLayer") != 0.0 {
                continue;
            }
            // kCGWindowBounds 是个嵌套字典；CFDictionary 没实现 ConcreteCFType，
            // 不能走 downcast，按引用重新包一层。
            let (x, y, w, h) = dict
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
                    (g("X"), g("Y"), g("Width"), g("Height"))
                })
                .unwrap_or((0.0, 0.0, 0.0, 0.0));
            // 2×2 以下是阴影 / 输入法之类的附属层，点不到也没意义。
            if w < 2.0 || h < 2.0 {
                continue;
            }
            let owner = s_of("kCGWindowOwnerName");
            if owner.is_empty() {
                continue;
            }
            let pid = n_of("kCGWindowOwnerPID") as i32;
            let front_pid = *front_pid.get_or_insert(pid);
            let title = s_of("kCGWindowName");
            windows.push(WindowInfo {
                title: if title.is_empty() { owner.clone() } else { title },
                process_name: owner.clone(),
                x: x as i32,
                y: y as i32,
                width: w.max(0.0) as u32,
                height: h.max(0.0) as u32,
                is_visible: true,
                is_frontmost: pid == front_pid,
                is_minimized: false,
            });
        }

        Ok(windows)
    }
    fn find_window(&self, title: &str) -> Result<Option<WindowInfo>> {
        let windows = self.enumerate_windows()?;
        Ok(windows.into_iter().find(|w| w.title.contains(title)))
    }
    
    /// 按窗口标题或应用名激活。名字怎么认见 macos_tree::resolve_app（显示名 / 可执行名 / bundle id /
    /// 窗口标题一次全认）；按标题命中的还会把那扇窗口本身提到最前，不只是把应用切到前台。
    fn activate_window(&self, title: &str) -> Result<()> {
        let m = crate::platform::macos_tree::resolve_app(title)
            .map_err(|c| Error::ElementNotFound(crate::platform::macos_tree::no_such_app(title, &c)))?;
        activate_running_app(m.pid, &m.name)?;
        if m.via == "window_title" {
            crate::platform::macos_tree::raise_window(m.pid, title);
        }
        Ok(())
    }

    fn activate_pid(&self, pid: i32) -> Result<()> {
        let name = crate::platform::macos_tree::name_of(pid)
            .ok_or_else(|| Error::ElementNotFound(format!("没有 pid 为 {pid} 的运行中应用")))?;
        activate_running_app(pid, &name)
    }
    
    fn minimize_window(&self, title: &str) -> Result<()> {
        // 以前这里是个只会返回 UnsupportedPlatform 的空实现，而 window.minimize
        // 就写在工具目录的 enum 里——模型照着调必然报错，等于清单在说谎。
        // AX 侧本来就有 AXMinimized 这个可写属性，实现在 macos_tree.rs。
        let pid = unsafe { pid_of_app(title) }
            .ok_or_else(|| Error::ElementNotFound(format!("没找到叫「{title}」的应用")))?;
        crate::platform::macos_tree::set_minimized(pid, true)
            .map(|_| ())
            .map_err(Error::System)
    }
    
    fn restore_window(&self, title: &str) -> Result<()> {
        let pid = unsafe { pid_of_app(title) }
            .ok_or_else(|| Error::ElementNotFound(format!("没找到叫「{title}」的应用")))?;
        crate::platform::macos_tree::set_minimized(pid, false)
            .map(|_| ())
            .map_err(Error::System)
    }
    
    fn maximize_window(&self, _title: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform(
            "macOS 平台暂不支持最大化指定窗口".to_string()
        ))
    }
    
    fn close_window(&self, _title: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform(
            "macOS 平台暂不支持关闭指定窗口".to_string()
        ))
    }
    
    fn get_screen_info(&self) -> Result<ScreenInfo> {
        let display = CGDisplay::main();
        let width = display.pixels_wide() as u32;
        let height = display.pixels_high() as u32;
        
        let scale_factor = unsafe {
            let screen: id = msg_send![class!(NSScreen), mainScreen];
            let backing_scale: f64 = msg_send![screen, backingScaleFactor];
            backing_scale
        };
        
        Ok(ScreenInfo {
            width,
            height,
            scale_factor,
        })
    }
}

/// 枚举**全部**在用的显示器，带各自在全局坐标里的矩形。
///
/// 为什么需要它：`get_screen_info` 只回 `CGDisplay::main()`，于是副屏在模型眼里
/// 根本不存在——它看到一块 1728×1117 的屏，任何落在副屏上的窗口坐标（x 可能是负数，
/// 也可能大于主屏宽度）都会被判成"在屏幕外"，于是它要么不敢点，要么把坐标夹回主屏
/// 然后点在错误的地方。而 window.list 给的几何是全局坐标，本来就会包含副屏上的窗口。
///
/// 区域截图那条链其实早就支持副屏了（`screencapture -R` 收的就是全局坐标），
/// 缺的只是"告诉模型副屏在哪"。所以这里只补枚举，不动截图。
pub fn list_displays() -> Vec<(u32, i32, i32, u32, u32, bool)> {
    let main_id = CGDisplay::main().id;
    let ids = match CGDisplay::active_displays() {
        Ok(v) => v,
        Err(_) => vec![main_id],
    };
    ids.into_iter()
        .map(|id| {
            let d = CGDisplay::new(id);
            let b = d.bounds();
            (
                id,
                b.origin.x as i32,
                b.origin.y as i32,
                b.size.width as u32,
                b.size.height as u32,
                id == main_id,
            )
        })
        .collect()
}

#[cfg(test)]
mod window_enumeration_tests {
    /// window.list 原来枚举的是 `NSWorkspace.runningApplications`——**应用**不是窗口：
    /// x/y/width/height 全部硬写 0，还混进 universalaccessd / talagentd 这类根本没有
    /// 窗口的后台守护进程（实测本机 99 条，几何全 0）。而工具描述教模型「先用
    /// window.list 找到窗口，再按坐标点进去」，拿到的坐标永远是 0,0,0×0。
    /// 换成 CGWindowListCopyWindowInfo 之后实测 2 个真窗口、几何全部真实。
    #[test]
    fn enumerates_real_windows_not_running_applications() {
        let src = include_str!("macos.rs");
        let at = src
            .find("fn enumerate_windows(&self) -> Result<Vec<WindowInfo>>")
            .expect("enumerate_windows 不见了");
        let end = src[at..].find("\n    fn ").map(|e| at + e).unwrap_or(src.len());
        let body: String = src[at..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            body.contains("copy_window_info"),
            "又回到枚举应用了 —— 拿到的几何会全是 0，模型按坐标点会点到屏幕外"
        );
        assert!(
            !body.contains("runningApplications"),
            "还在用 runningApplications 枚举「窗口」"
        );
        // 几何必须来自 kCGWindowBounds，不能再硬写 0。
        assert!(body.contains("kCGWindowBounds"), "没读真实窗口几何");
        assert!(
            !body.contains("x: 0,\n                    y: 0,"),
            "几何又被硬写成 0 了"
        );
        // 系统层和附属层要滤掉，否则列表里全是菜单栏和阴影。
        assert!(body.contains("kCGWindowLayer"), "没滤掉菜单栏 / Dock 这类系统层");
        assert!(body.contains("w < 2.0 || h < 2.0"), "没滤掉 2x2 以下的附属层");
    }
}
