//! 平台特定功能模块

pub mod desktop_element;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub mod windows_ui_automation;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub mod macos_accessibility;
/// 前台应用可访问性树的**原生**快照。JXA 那条路每读一个属性就是一次 Apple Event
/// 往返，实测真实窗口下 500 个元素要 95 秒，而读屏上限是 6 秒——必然超时。
#[cfg(target_os = "macos")]
pub mod macos_tree;

use crate::error::Result;
use crate::types::{ScreenInfo, WindowInfo};

/// 从可执行文件的完整路径里取出应用名，比如
/// `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe` → `chrome`。
///
/// 为什么单独抽出来：Windows 的窗口枚举以前把 `process_name` 填成
/// `format!("process_{}", pid)`，模型拿到一串 `process_7314` 根本认不出
/// 哪个窗口是 Chrome、哪个是编辑器，"切到某个应用"这类活直接没法做。
/// 而 Windows 专属代码在 mac 上不参与编译、测不到，所以把这段纯逻辑
/// 放在跨平台模块里，两个平台都能跑它的测试。
pub(crate) fn exe_stem(path: &str) -> Option<String> {
    let tail = path
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or(path)
        .trim();
    if tail.is_empty() {
        return None;
    }
    // 只削掉结尾的 `.exe`，别碰 `node.js.exe` 这种名字中间的点。
    let stem = tail
        .strip_suffix(".exe")
        .or_else(|| tail.strip_suffix(".EXE"))
        .unwrap_or(tail);
    if stem.is_empty() { None } else { Some(stem.to_string()) }
}

/// 平台特定窗口操作接口
pub trait WindowControl {
    /// 枚举所有窗口
    fn enumerate_windows(&self) -> Result<Vec<WindowInfo>>;
    
    /// 查找窗口（根据标题）
    fn find_window(&self, title: &str) -> Result<Option<WindowInfo>>;
    
    /// 激活窗口（按窗口标题或应用名，平台层自己认）
    fn activate_window(&self, title: &str) -> Result<()>;

    /// 按进程号激活。read_screen / app.resolve 回来的就是 pid，不必再翻译成名字。
    /// 默认不支持（Windows 那边还是按标题走），macOS 覆盖。
    fn activate_pid(&self, pid: i32) -> Result<()> {
        Err(crate::error::Error::Other(anyhow::anyhow!("activate by pid is not supported on this platform (pid {pid}); use title")))
    }
    
    /// 最小化窗口
    fn minimize_window(&self, title: &str) -> Result<()>;
    
    /// 还原（取消最小化）窗口。
    ///
    /// 只有最小化没有还原等于半条路：模型把窗口收起来之后就再也拿不回来，
    /// 只能去点任务栏/Dock——而那要坐标、要截图、要猜。还原这一侧以前只在
    /// macOS 的 RPC 分支里实现，Windows 上连方法都没有。
    fn restore_window(&self, title: &str) -> Result<()>;
    
    /// 最大化窗口
    fn maximize_window(&self, title: &str) -> Result<()>;
    
    /// 关闭窗口
    fn close_window(&self, title: &str) -> Result<()>;
    
    /// 获取屏幕信息
    fn get_screen_info(&self) -> Result<ScreenInfo>;
}

/// 获取平台特定的窗口控制器
#[cfg(target_os = "windows")]
pub fn get_window_controller() -> Box<dyn WindowControl> {
    Box::new(windows::WindowsControl::new())
}

#[cfg(target_os = "macos")]
pub fn get_window_controller() -> Box<dyn WindowControl> {
    Box::new(macos::MacOSControl::new())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn get_window_controller() -> Box<dyn WindowControl> {
    compile_error!("当前平台不支持窗口控制功能");
}

#[cfg(test)]
mod exe_stem_tests {
    use super::exe_stem;

    #[test]
    fn it_takes_the_file_name_off_a_windows_path() {
        assert_eq!(
            exe_stem("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").as_deref(),
            Some("chrome")
        );
    }

    #[test]
    fn it_handles_forward_slashes_and_bare_names() {
        assert_eq!(exe_stem("C:/Windows/System32/notepad.exe").as_deref(), Some("notepad"));
        assert_eq!(exe_stem("Code.exe").as_deref(), Some("Code"));
        assert_eq!(exe_stem("devenv").as_deref(), Some("devenv"));
    }

    #[test]
    fn it_only_strips_a_trailing_exe() {
        assert_eq!(exe_stem("C:\\apps\\node.js.exe").as_deref(), Some("node.js"));
        assert_eq!(exe_stem("C:\\apps\\my.exe.tool").as_deref(), Some("my.exe.tool"));
    }

    #[test]
    fn it_gives_nothing_for_empty_or_trailing_separator() {
        assert_eq!(exe_stem(""), None);
        assert_eq!(exe_stem("C:\\apps\\"), None);
        assert_eq!(exe_stem("   "), None);
    }

    /// 反漂移：进程名不许再退回 `process_<pid>` 这种占位。模型靠它认应用。
    #[test]
    fn windows_enumeration_does_not_ship_a_pid_placeholder() {
        let src = include_str!("windows.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("format!(\"process_{}\""),
            "windows.rs 又把进程名填成了 process_<pid> 占位"
        );
        assert!(
            code.contains("exe_stem"),
            "windows.rs 应该走 exe_stem 取真实程序名"
        );
    }
}
