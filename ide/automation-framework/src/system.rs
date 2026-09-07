//! 系统级自动化模块
//!
//! 跨平台鼠标、键盘和窗口控制

use crate::error::{Error, Result};
use crate::types::*;
use enigo::{
    Button as EnigoButton, Coordinate, Direction, Enigo, Keyboard, Mouse, 
    Settings as EnigoSettings,
};
use tracing::{debug, info};

/// 系统自动化控制器
pub struct SystemAutomation {
    enigo: Enigo,
}

/// PNG 头 IHDR 里的真实像素尺寸。只读前 33 字节，不解码整张图。
fn png_pixel_size(buf: &[u8]) -> Option<(u32, u32)> {
    // 8 字节签名 + 4 长度 + 4 "IHDR" + 4 width + 4 height
    if buf.len() < 24 || &buf[0..8] != b"\x89PNG\r\n\x1a\n" || &buf[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    if w == 0 || h == 0 { None } else { Some((w, h)) }
}

/// 抓屏成 PNG 字节（macOS，`screencapture` CLI）。**不碰 Agent**——截屏是只读能力，
/// 不需要辅助功能权限，也不需要 enigo。抽成自由函数是为了让 `screen.capture` /
/// `screen.marked` 能挂在 accept 线程之外跑，不再排在浏览器动作后面。
/// `region` 是**点**坐标（`screencapture -R` 收的就是点）；出来的 PNG 在 Retina 上是 2× 像素。
#[cfg(target_os = "macos")]
pub fn capture_screen_png(region: Option<(i32, i32, i32, i32)>) -> Result<Vec<u8>> {
    use std::io::Read;
    let dir = std::env::temp_dir().join("mrdayone-screen");
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::System(format!("建临时目录失败：{e}")))?;
    // 截图可能含密码、私信、密钥。0700：同机其他账户读不到。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(format!(
        "shot-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let mut cmd = std::process::Command::new("screencapture");
    cmd.arg("-x"); // 不发快门音
    if let Some((x, y, w, h)) = region {
        if w <= 0 || h <= 0 {
            return Err(Error::System("截图区域的宽高必须为正".into()));
        }
        cmd.arg("-R").arg(format!("{x},{y},{w},{h}"));
    }
    let status = cmd
        .arg(&path)
        .status()
        .map_err(|e| Error::System(format!("screencapture 起不来：{e}")))?;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        // 没授权"屏幕录制"时 screencapture 也会失败。这句必须说清是权限，否则模型会
        // 反复重试一个永远不会成功的调用。
        return Err(Error::System(
            "截屏失败（退出码非 0）。最常见的原因是没给「屏幕录制」权限：                 系统设置 → 隐私与安全性 → 屏幕录制，勾上本应用后需要重启它。"
                .into(),
        ));
    }
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| Error::System(format!("读截图失败：{e}")))?;
    let _ = std::fs::remove_file(&path); // 图已经在内存里，别把它留在盘上
    if buf.is_empty() {
        return Err(Error::System("截屏得到 0 字节——多半是屏幕录制权限没给".into()));
    }
    Ok(buf)
}

/// 主屏的**点**尺寸（不是像素）。鼠标坐标、AX 树坐标、`screencapture -R` 用的都是这一套。
/// CGDisplay 那两个叫 pixels_wide/high 的方法在 Retina 上返回的其实是点（实测 1728×1117），
/// Windows：GDI 抓屏成 PNG 字节（物理像素）。`region` 不给就抓**整个虚拟桌面**（多显示器时
/// 副屏在里面，坐标可能是负数）；给了就抓那块（全局坐标）。不碰 Agent。
#[cfg(target_os = "windows")]
pub fn capture_screen_png(region: Option<(i32, i32, i32, i32)>) -> Result<Vec<u8>> {
    let (x, y, w, h) = match region {
        Some((rx, ry, rw, rh)) => {
            if rw <= 0 || rh <= 0 {
                return Err(Error::System("截图区域的宽高必须为正".into()));
            }
            (rx, ry, rw, rh)
        }
        None => virtual_screen_rect().ok_or_else(|| Error::System("拿不到屏幕尺寸（虚拟桌面宽高为 0）".into()))?,
    };
    gdi_capture(x, y, w, h)
}

/// 虚拟桌面矩形（全部显示器的并集），物理像素、全局坐标。
#[cfg(target_os = "windows")]
pub fn virtual_screen_rect() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };
    let (x, y, w, h) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if w <= 0 || h <= 0 { None } else { Some((x, y, w, h)) }
}

/// 整屏截图实际覆盖的矩形：macOS 抓主屏、原点 (0,0)，用 None 让 vision::prepare 按主屏算；
/// Windows 抓整个虚拟桌面，原点可能不是 (0,0)，必须把矩形交给 prepare，否则副屏上的坐标全错。
#[cfg(target_os = "macos")]
pub fn full_capture_rect() -> Option<(i32, i32, i32, i32)> {
    None
}
#[cfg(target_os = "windows")]
pub fn full_capture_rect() -> Option<(i32, i32, i32, i32)> {
    virtual_screen_rect()
}

#[cfg(target_os = "windows")]
fn gdi_capture(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::*;
    let pixels = unsafe {
        let screen_dc = GetDC(HWND(std::ptr::null_mut()));
        if screen_dc.is_invalid() {
            return Err(Error::System("拿不到屏幕设备上下文（GetDC 失败）".into()));
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
            return Err(Error::System("建内存设备上下文失败".into()));
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
            return Err(Error::System("建位图失败（截图区域可能过大）".into()));
        }
        let old = SelectObject(mem_dc, bitmap);
        // CAPTUREBLT：不加的话分层窗口（输入法候选框、Electron 的阴影圆角、半透明浮层）整块缺失。
        let blt_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 负高度 = 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let got = if blt_ok {
            GetDIBits(screen_dc, bitmap, 0, h as u32, Some(buf.as_mut_ptr() as *mut std::ffi::c_void), &mut info, DIB_RGB_COLORS)
        } else {
            0
        };
        SelectObject(mem_dc, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
        if !blt_ok {
            return Err(Error::System("BitBlt 抓屏失败。受保护内容（DRM 播放器、部分远程桌面会话）会拒绝被截。".into()));
        }
        if got == 0 {
            return Err(Error::System("GetDIBits 读不出像素".into()));
        }
        buf
    };
    let mut rgba = pixels;
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
        .ok_or_else(|| Error::System("像素数据长度和图像尺寸对不上".into()))?;
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| Error::System(format!("PNG 编码失败：{e}")))?;
    Ok(png.into_inner())
}

/// Windows：主显示器的物理像素尺寸（进程已声明 DPI 感知，不会被虚拟化）。
#[cfg(target_os = "windows")]
pub fn main_display_points() -> Option<(u32, u32)> {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if w > 0 && h > 0 { Some((w as u32, h as u32)) } else { None }
}

/// Windows 锁屏时桌面根本抓不到（安全桌面），BitBlt 会失败而不是回黑图，所以这里恒 false。
#[cfg(target_os = "windows")]
pub fn screen_locked() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub use crate::platform::windows_tree::{window_stack, window_titles};
#[cfg(target_os = "windows")]
pub use crate::platform::tree_types::WinTitle;

/// 见 rpc.rs `screen.info` 那段说明。走 CoreGraphics 而不是 enigo，是为了不碰 Agent。
#[cfg(target_os = "macos")]
pub fn main_display_points() -> Option<(u32, u32)> {
    let d = core_graphics::display::CGDisplay::main();
    let (w, h) = (d.pixels_wide() as u32, d.pixels_high() as u32);
    if w > 0 && h > 0 { Some((w, h)) } else { None }
}

/// 屏幕是不是锁着。锁屏时 screencapture 出来的是一张全黑图、CGWindowList 一扇窗口都没有，
/// 而 AX 树照样读得到——不说出来，模型会把黑图当成「这个应用什么都没显示」。
#[cfg(target_os = "macos")]
pub fn screen_locked() -> bool {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }
    unsafe {
        let raw = CGSessionCopyCurrentDictionary();
        if raw.is_null() {
            return false;
        }
        let dict: CFDictionary<CFString, CFType> = CFDictionary::wrap_under_create_rule(raw);
        dict.find(&CFString::new("CGSSessionScreenIsLocked"))
            .and_then(|v| v.downcast::<CFBoolean>())
            .map(|b| b.into())
            .unwrap_or(false)
    }
}

/// 屏幕上的窗口标题清单：实现在 platform::macos_tree（那边不受 `system` 特性门控，按名字找应用要用它）。
#[cfg(target_os = "macos")]
pub use crate::platform::macos_tree::{window_titles, WinTitle};

/// 屏幕上普通层的窗口，按 z 序**从前到后**（CGWindowList 就按这个顺序给），带所属进程。
/// `screen.marked` 靠它判「这个元素在截图上看不看得见」；不碰 Agent，不需要辅助功能权限。
#[cfg(target_os = "macos")]
pub fn window_stack() -> Vec<crate::vision::WinRect> {
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
        // layer != 0 是菜单栏 / Dock / 悬浮面板，不参与遮挡判断（菜单栏项照样要标）。
        if n_of("kCGWindowLayer") != 0.0 {
            continue;
        }
        let pid = n_of("kCGWindowOwnerPID") as i32;
        let Some((x, y, w, h)) = dict.find(&CFString::new("kCGWindowBounds")).map(|v| unsafe {
            let b: CFDictionary<CFString, CFType> =
                CFDictionary::wrap_under_get_rule(v.as_CFTypeRef() as *const _);
            let g = |k: &str| {
                b.find(&CFString::new(k))
                    .and_then(|n| n.downcast::<CFNumber>())
                    .and_then(|n| n.to_f64())
                    .unwrap_or(0.0)
            };
            (g("X"), g("Y"), g("Width"), g("Height"))
        }) else {
            continue;
        };
        if pid <= 0 || w < 2.0 || h < 2.0 {
            continue;
        }
        out.push(crate::vision::WinRect { pid, x, y, w, h });
    }
    out
}

impl SystemAutomation {
    /// 屏幕的**点**尺寸（不是像素）。鼠标坐标用的就是这套单位。
    fn screen_size_points(&self) -> Option<(u32, u32)> {
        // enigo 的 main_display 返回的是**点**——和 mouse.move 收的坐标同一套单位。
        use enigo::Mouse;
        self.enigo
            .main_display()
            .ok()
            .and_then(|(w, h)| if w > 0 && h > 0 { Some((w as u32, h as u32)) } else { None })
    }

    /// 创建新的系统自动化实例
    pub fn new() -> Result<Self> {
        info!("初始化系统自动化");
        let enigo = Enigo::new(&EnigoSettings::default())
            .map_err(|e| Error::System(format!("初始化失败: {:?}", e)))?;
        
        Ok(Self { enigo })
    }

    /// 移动鼠标到指定位置
    pub fn move_mouse(&mut self, x: i32, y: i32) -> Result<()> {
        debug!("移动鼠标到 ({}, {})", x, y);
        // Windows：enigo 的绝对移动把坐标按**主屏**尺寸归一化成 0..65535，副屏上的点全部落错；
        // SetCursorPos 收的是全局物理像素（进程已声明 DPI 感知），多显示器直接可用。
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
            unsafe { SetCursorPos(x, y) }
                .map_err(|e| Error::System(format!("移动鼠标失败: {:?}", e)))?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        {
            self.enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| Error::System(format!("移动鼠标失败: {:?}", e)))?;
            Ok(())
        }
    }

    /// 相对移动鼠标
    /// 指针当前位置。此前整个框架只能"盲发"移动和点击，无从确认落点——
    /// 出了偏差既查不出来，模型也没法自我纠正。
    /// 拍下屏幕像素，回 PNG 的 data URL。
    ///
    /// 这是整套系统里**唯一**能拿到真实桌面像素的通路。在它之前，`screenshot` 工具只会用
    /// 无头浏览器渲染一个 http(s) 网址 —— 也就是说模型对任何原生应用、游戏、Canvas、视频、
    /// PDF 都是全盲的：动完手没法看一眼确认自己做成没有。而工具描述还在教它"用 screenshot
    /// 验证结果"，那条路必然报错。
    ///
    /// 三件事是刻意的：
    /// · **不移动鼠标**。crate 里原有的 screenshot_region 会先把指针挪到区域起点，那会改变
    ///   悬停态——截图本该是纯观察，不该顺手改变被观察的东西。（那个函数零调用点，从没跑过。）
    /// · **落私有临时目录再删**，不是相对路径。原来写的是 `format!("region_{}...png")`，
    ///   相对当前工作目录，落在哪儿完全不确定。
    /// · **回 data URL 而不是路径**。路径对模型没用——它要的是图本身。
    #[cfg(target_os = "macos")]
    /// 返回 (PNG data URL, 像素↔点的换算说明)。第二项在 Retina 上非空——
    /// 图是像素尺寸而鼠标收的是点，不说清楚模型就会拿图上量的坐标直接去点，点到屏幕外。
    pub fn screen_capture(&self, region: Option<(i32, i32, i32, i32)>) -> Result<(String, Option<String>)> {
        // 抓屏本身在自由函数里（不碰 Agent）；这个方法只负责老口径的回执：原图 + 换算提示。
        // 新口径（缩图 + 精确换算）在 rpc.rs 的 screen.capture / screen.marked 里走 vision::prepare。
        let buf = capture_screen_png(region)?;
        // Retina 上 screencapture 出的是**像素**尺寸（2x），而鼠标要的是**点**坐标。
        // 此前这个差别一个字都没告诉模型：它在图上量出按钮在 (1200, 800)，直接传给
        // mouse.move —— 实际点在 (2400, 1600)，屏幕外。「看一眼再动手」这条链从来没成立过。
        // 这里不改图（缩放会糊，且 OCR 更难认），改成把换算关系如实报出来：
        // 图的像素尺寸、屏幕的点尺寸、两者的比值。模型除一下就能用。
        let scale_note = {
            let px = png_pixel_size(&buf);
            match (px, self.screen_size_points()) {
                (Some((pw, ph)), Some((sw, sh))) if sw > 0 && sh > 0 => {
                    let fx = pw as f64 / sw as f64;
                    Some(format!(
                        "image_px={pw}x{ph}; screen_points={sw}x{sh}; pixels_per_point={:.2}。\
图上量到的坐标要除以 {:.2} 再传给 mouse.move —— 那个接口收的是点，不是像素。",
                        fx, fx
                    ))
                    .filter(|_| (fx - 1.0).abs() > 0.01 || (ph as f64 / sh as f64 - 1.0).abs() > 0.01)
                }
                _ => None,
            }
        };
        Ok((format!("data:image/png;base64,{}", base64_encode(&buf)), scale_note))
    }

    /// Windows：GDI 抓屏（BitBlt + GetDIBits），编成 PNG data URL。
    ///
    /// 这条以前是一句硬 Err——"这个平台还没有实现屏幕截图"。后果不只是少一个功能：
    /// read_screen 读空时，非 macOS 分支明确把模型指向 `screen.capture`，
    /// 工具目录也把它写成"唯一能看见原生应用的办法"。也就是说 Windows 上
    /// 唯一的兜底路是死的，而所有指路牌都指着它。
    ///
    /// 用 GDI 而不是起 PowerShell：截图在"看一眼再动手"的循环里会被反复调用，
    /// 每次多花半秒起一个 PowerShell 是实打实的代价。
    #[cfg(target_os = "windows")]
    pub fn screen_capture(&self, region: Option<(i32, i32, i32, i32)>) -> Result<(String, Option<String>)> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::*;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };

        // 不给 region 就抓**整个虚拟桌面**，不是主屏：多显示器下窗口经常在副屏，
        // 只抓主屏会得到一张"什么都没有"的图，而模型无从分辨那是空桌面还是抓错了屏。
        let (x, y, w, h) = match region {
            Some((rx, ry, rw, rh)) => {
                if rw <= 0 || rh <= 0 {
                    return Err(Error::System("截图区域的宽高必须为正".into()));
                }
                (rx, ry, rw, rh)
            }
            None => unsafe {
                (
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                )
            },
        };
        if w <= 0 || h <= 0 {
            return Err(Error::System("拿不到屏幕尺寸（虚拟桌面宽高为 0）".into()));
        }

        let pixels = unsafe {
            let screen_dc = GetDC(HWND(std::ptr::null_mut()));
            if screen_dc.is_invalid() {
                return Err(Error::System("拿不到屏幕设备上下文（GetDC 失败）".into()));
            }
            // 下面每一步失败都要把已经拿到的资源还回去，否则每次失败泄漏一个 DC/位图，
            // 而截图是会被反复调用的。
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc.is_invalid() {
                ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
                return Err(Error::System("建内存设备上下文失败".into()));
            }
            let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem_dc);
                ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
                return Err(Error::System("建位图失败（截图区域可能过大）".into()));
            }
            let old = SelectObject(mem_dc, bitmap);

            // CAPTUREBLT 是必须的：不加的话分层窗口（很多输入法候选框、部分
            // Electron 应用的阴影和圆角、以及半透明浮层）会整块缺失。
            let blt_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY | CAPTUREBLT).is_ok();

            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    // 负高度 = 自上而下。正数的话拿到的是上下颠倒的图，
                    // 而颠倒的截图看着"像是"能用，模型据此算出来的 y 全是反的。
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let got = if blt_ok {
                GetDIBits(
                    screen_dc,
                    bitmap,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            SelectObject(mem_dc, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);

            if !blt_ok {
                return Err(Error::System(
                    "BitBlt 抓屏失败。受保护内容（DRM 播放器、部分远程桌面会话）会拒绝被截。".into(),
                ));
            }
            if got == 0 {
                return Err(Error::System("GetDIBits 读不出像素".into()));
            }
            buf
        };

        // GDI 给的是 BGRA，而且 BitBlt 出来的 alpha 通道是 0（它不管透明度）。
        // 照原样编码会得到一张全透明的 PNG——打开是空白，但字节数看着完全正常。
        let mut rgba = pixels;
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or_else(|| Error::System("像素数据长度和图像尺寸对不上".into()))?;
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| Error::System(format!("PNG 编码失败：{e}")))?;
        let png = png.into_inner();
        if png.is_empty() {
            return Err(Error::System("截屏得到 0 字节".into()));
        }

        // 和 macOS 那支同一个约定：图是像素，鼠标收的是点，不一致就说出来。
        // Windows 上进程如果不是 per-monitor DPI aware，这两者也会差一个缩放比。
        let scale_note = match self.screen_size_points() {
            Some((sw, sh)) if sw > 0 && sh > 0 && region.is_none() => {
                let fx = w as f64 / sw as f64;
                if (fx - 1.0).abs() > 0.01 || (h as f64 / sh as f64 - 1.0).abs() > 0.01 {
                    Some(format!(
                        "image_px={w}x{h}; screen_points={sw}x{sh}; pixels_per_point={:.2}。\
图上量到的坐标要除以 {:.2} 再传给 mouse.move —— 那个接口收的是点，不是像素。",
                        fx, fx
                    ))
                } else {
                    None
                }
            }
            _ => None,
        };

        Ok((
            format!("data:image/png;base64,{}", base64_encode(&png)),
            scale_note,
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn screen_capture(&self, _region: Option<(i32, i32, i32, i32)>) -> Result<(String, Option<String>)> {
        Err(Error::System("这个平台还没有实现屏幕截图".into()))
    }

    pub fn mouse_location(&self) -> Result<(i32, i32)> {
        self.enigo.location()
            .map_err(|e| Error::System(format!("读取指针位置失败: {}", e)))
    }

    pub fn move_mouse_relative(&mut self, dx: i32, dy: i32) -> Result<()> {
        debug!("相对移动鼠标 ({}, {})", dx, dy);
        self.enigo
            .move_mouse(dx, dy, Coordinate::Rel)
            .map_err(|e| Error::System(format!("相对移动鼠标失败: {:?}", e)))?;
        Ok(())
    }

    /// 鼠标点击
    pub fn click(&mut self, button: MouseButton) -> Result<()> {
        debug!("点击鼠标按钮: {:?}", button);
        let enigo_button = Self::convert_button(button);
        self.enigo
            .button(enigo_button, Direction::Click)
            .map_err(|e| Error::System(format!("点击失败: {:?}", e)))?;
        Ok(())
    }

    /// 鼠标按下
    pub fn mouse_down(&mut self, button: MouseButton) -> Result<()> {
        debug!("鼠标按下: {:?}", button);
        let enigo_button = Self::convert_button(button);
        self.enigo
            .button(enigo_button, Direction::Press)
            .map_err(|e| Error::System(format!("鼠标按下失败: {:?}", e)))?;
        Ok(())
    }

    /// 鼠标释放
    pub fn mouse_up(&mut self, button: MouseButton) -> Result<()> {
        debug!("鼠标释放: {:?}", button);
        let enigo_button = Self::convert_button(button);
        self.enigo
            .button(enigo_button, Direction::Release)
            .map_err(|e| Error::System(format!("鼠标释放失败: {:?}", e)))?;
        Ok(())
    }

    /// 连点 n 次。双击、三连击共用这一条。
    ///
    /// 间隔 50ms 是有讲究的：系统判定「这是一次双击/三连击」靠的是**相邻两次点击的
    /// 时间差和位置差**，不是我们说它是。太快某些工具包会丢事件，太慢就被判成两次单击。
    /// 三连击（整段选中一行/一段）在文本编辑里是常用动作，而它此前完全不存在。
    pub fn click_times(&mut self, button: MouseButton, times: u32) -> Result<()> {
        debug!("连点 {} 次: {:?}", times, button);
        for i in 0..times.max(1) {
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            self.click(button)?;
        }
        Ok(())
    }

    /// 鼠标双击
    pub fn double_click(&mut self, button: MouseButton) -> Result<()> {
        self.click_times(button, 2)
    }

    /// 鼠标滚动
    pub fn scroll(&mut self, delta_x: i32, delta_y: i32) -> Result<()> {
        debug!("滚动: x={}, y={}", delta_x, delta_y);
        if delta_y != 0 {
            self.enigo
                .scroll(delta_y, enigo::Axis::Vertical)
                .map_err(|e| Error::System(format!("垂直滚动失败: {:?}", e)))?;
        }
        if delta_x != 0 {
            self.enigo
                .scroll(delta_x, enigo::Axis::Horizontal)
                .map_err(|e| Error::System(format!("水平滚动失败: {:?}", e)))?;
        }
        Ok(())
    }

    /// 拖拽操作
    pub fn drag(&mut self, from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> Result<()> {
        debug!("拖拽: ({}, {}) -> ({}, {})", from_x, from_y, to_x, to_y);
        
        // 拖拽必须是**连续**的，不能瞬移。
        //
        // 原来是：移到起点 → 按下 → **一步瞬移**到终点 → 松开。绝大多数应用识别不了——
        // HTML5 的 dragover、原生列表的重排、滑块的 value 更新，全都靠中间那一连串
        // mouse-moved 事件驱动；只有首尾两个点时它们收到的是"按下然后在别处松开"，
        // 于是滑块不动、拖文件失败、列表顺序没变，而这里一路返回 ok。
        // 插值 16 步、每步约 12ms（总计约 200ms，接近真人拖动速度）。
        self.move_mouse(from_x, from_y)?;
        std::thread::sleep(std::time::Duration::from_millis(60));

        self.mouse_down(MouseButton::Left)?;
        std::thread::sleep(std::time::Duration::from_millis(90));

        const STEPS: i32 = 16;
        for i in 1..=STEPS {
            let t = i as f64 / STEPS as f64;
            // 缓入缓出：匀速直线在某些手势识别里也会被当成程序化输入。
            let e = if t < 0.5 { 2.0 * t * t } else { 1.0 - 2.0 * (1.0 - t) * (1.0 - t) };
            let x = from_x + ((to_x - from_x) as f64 * e).round() as i32;
            let y = from_y + ((to_y - from_y) as f64 * e).round() as i32;
            self.move_mouse(x, y)?;
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        // 终点再停一拍：拖放的目标高亮/吸附往往有动画，立刻松手会落在上一个位置。
        std::thread::sleep(std::time::Duration::from_millis(80));

        self.mouse_up(MouseButton::Left)?;

        Ok(())
    }

    /// 输入文本
    /// 输入文本。**换行按真的回车发出去**，不能原样丢给 text()。
    ///
    /// `enigo.text("a\nb")` 在 macOS 上走的是 Unicode 直接投递：`\n` 作为一个字符送出去，
    /// 多数原生控件对它没有反应——于是"输入两行"变成输入一行，中间那次换行**静默消失**，
    /// 而回执照样 ok。多行输入是最常见的用法之一（写提交信息、填地址、聊天发多段），
    /// 这个坑一直在。中文没问题（Unicode 投递本来就对），只有回车会失效。
    ///
    /// `\r\n` 当成一次换行，别按两下。
    pub fn type_text(&mut self, text: &str) -> Result<()> {
        debug!("输入文本: {} 字符", text.len());
        if !text.contains('\n') {
            return self
                .enigo
                .text(text)
                .map_err(|e| Error::System(format!("输入文本失败: {:?}", e)));
        }
        let normalized = text.replace("\r\n", "\n");
        let mut first = true;
        for line in normalized.split('\n') {
            if !first {
                self.press_key(Key::Return)?;
            }
            first = false;
            if !line.is_empty() {
                self.enigo
                    .text(line)
                    .map_err(|e| Error::System(format!("输入文本失败: {:?}", e)))?;
            }
        }
        Ok(())
    }

    /// 按下并释放按键
    pub fn press_key(&mut self, key: Key) -> Result<()> {
        debug!("按键: {:?}", key);
        let enigo_key = Self::convert_key(&key)?;
        self.enigo
            .key(enigo_key, Direction::Click)
            .map_err(|e| Error::System(format!("按键失败: {:?}", e)))?;
        Ok(())
    }

    /// 按下按键
    pub fn key_down(&mut self, key: Key) -> Result<()> {
        debug!("按下按键: {:?}", key);
        let enigo_key = Self::convert_key(&key)?;
        self.enigo
            .key(enigo_key, Direction::Press)
            .map_err(|e| Error::System(format!("按下按键失败: {:?}", e)))?;
        Ok(())
    }

    /// 释放按键
    pub fn key_up(&mut self, key: Key) -> Result<()> {
        debug!("释放按键: {:?}", key);
        let enigo_key = Self::convert_key(&key)?;
        self.enigo
            .key(enigo_key, Direction::Release)
            .map_err(|e| Error::System(format!("释放按键失败: {:?}", e)))?;
        Ok(())
    }

    /// 组合键（如 Ctrl+C）
    pub fn key_combination(&mut self, keys: Vec<Key>) -> Result<()> {
        debug!("组合键: {:?}", keys);
        
        // 按下所有键
        for key in &keys {
            self.key_down(key.clone())?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // 释放所有键（逆序）
        for key in keys.iter().rev() {
            self.key_up(key.clone())?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        
        Ok(())
    }

    /// 执行鼠标操作
    pub fn execute_mouse_action(&mut self, action: MouseAction) -> Result<ExecutionResult> {
        match action {
            MouseAction::Move { x, y, mode } => {
                match mode {
                    CoordinateMode::Absolute => self.move_mouse(x, y)?,
                    CoordinateMode::Relative => self.move_mouse_relative(x, y)?,
                }
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("鼠标移动到 ({}, {})", x, y)),
                    data: None,
                })
            }
            MouseAction::Click { button } => {
                self.click(button)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("点击 {:?}", button)),
                    data: None,
                })
            }
            MouseAction::DoubleClick { button } => {
                self.double_click(button)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("双击 {:?}", button)),
                    data: None,
                })
            }
            MouseAction::Down { button } => {
                self.mouse_down(button)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("按下 {:?}", button)),
                    data: None,
                })
            }
            MouseAction::Up { button } => {
                self.mouse_up(button)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("释放 {:?}", button)),
                    data: None,
                })
            }
            MouseAction::Scroll { delta_x, delta_y } => {
                self.scroll(delta_x, delta_y)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("滚动 x={}, y={}", delta_x, delta_y)),
                    data: None,
                })
            }
            MouseAction::Drag { from_x, from_y, to_x, to_y } => {
                self.drag(from_x, from_y, to_x, to_y)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("拖拽完成")),
                    data: None,
                })
            }
        }
    }

    /// 执行键盘操作
    pub fn execute_keyboard_action(&mut self, action: KeyboardAction) -> Result<ExecutionResult> {
        match action {
            KeyboardAction::Text(text) => {
                self.type_text(&text)?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("输入文本: {} 字符", text.len())),
                    data: None,
                })
            }
            KeyboardAction::Press(key) => {
                self.press_key(key.clone())?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("按键: {:?}", key)),
                    data: None,
                })
            }
            KeyboardAction::Down(key) => {
                self.key_down(key.clone())?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("按下: {:?}", key)),
                    data: None,
                })
            }
            KeyboardAction::Up(key) => {
                self.key_up(key.clone())?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("释放: {:?}", key)),
                    data: None,
                })
            }
            KeyboardAction::Combination(keys) => {
                self.key_combination(keys.clone())?;
                Ok(ExecutionResult {
                    success: true,
                    message: Some(format!("组合键: {:?}", keys)),
                    data: None,
                })
            }
        }
    }

    // 辅助函数：转换按钮类型
    fn convert_button(button: MouseButton) -> EnigoButton {
        match button {
            MouseButton::Left => EnigoButton::Left,
            MouseButton::Right => EnigoButton::Right,
            MouseButton::Middle => EnigoButton::Middle,
        }
    }

    // 辅助函数：转换按键类型
    fn convert_key(key: &Key) -> Result<enigo::Key> {
        use enigo::Key as EK;
        
        let enigo_key = match key {
            Key::Character(c) => EK::Unicode(*c),
            Key::String(_) => return Err(Error::System(
                "字符串类型应使用 type_text 方法".to_string()
            )),
            Key::Return => EK::Return,
            Key::Tab => EK::Tab,
            Key::Space => EK::Space,
            Key::Backspace => EK::Backspace,
            Key::Escape => EK::Escape,
            Key::Delete => EK::Delete,
            Key::Home => EK::Home,
            Key::End => EK::End,
            Key::PageUp => EK::PageUp,
            Key::PageDown => EK::PageDown,
            Key::LeftArrow => EK::LeftArrow,
            Key::RightArrow => EK::RightArrow,
            Key::UpArrow => EK::UpArrow,
            Key::DownArrow => EK::DownArrow,
            Key::F1 => EK::F1,
            Key::F2 => EK::F2,
            Key::F3 => EK::F3,
            Key::F4 => EK::F4,
            Key::F5 => EK::F5,
            Key::F6 => EK::F6,
            Key::F7 => EK::F7,
            Key::F8 => EK::F8,
            Key::F9 => EK::F9,
            Key::F10 => EK::F10,
            Key::F11 => EK::F11,
            Key::F12 => EK::F12,
            Key::Control => EK::Control,
            Key::Shift => EK::Shift,
            Key::Alt => EK::Alt,
            Key::Meta => EK::Meta,
        };
        
        Ok(enigo_key)
    }
}

/// 标准 base64（RFC 4648），只为把截图变成 data URL。
///
/// 不引 base64 crate：sidecar 是独立编译、独立分发的二进制，为一个 20 行的编码器多一条
/// 依赖不划算，而且这条链路上任何一次 `cargo update` 都可能让二进制和源码悄悄对不上
/// （本仓库记录过：Tauri 不会自动重编这个 crate）。
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod screen_capture_tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_the_reference_vectors() {
        // RFC 4648 的测试向量。自己写的编码器必须对着标准验，不然 data URL 会静默损坏，
        // 而模型只会说"这张图看不清"。
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 二进制字节（PNG 头）必须原样编出来，别被当成 UTF-8。
        assert_eq!(base64_encode(&[0x89, 0x50, 0x4E, 0x47]), "iVBORw==");
    }
}
