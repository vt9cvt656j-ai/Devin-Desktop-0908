//! 读屏那一族方法在两个平台上**共用**的数据形状。
//!
//! macOS（AX）和 Windows（UI Automation）各有一套原生 API，但交给调用方的东西必须一模一样：
//! Tauri 那边按字段名装 ref 表、JS 那边按 role 决定画不画框——任何一个平台多一个字段少一个
//! 字段，下游就得按平台写两套判据，而那正是「mac 能用、Windows 不能用」的来路。

/// 一个可访问性节点。`x/y/w/h` 是屏幕坐标：macOS 上是点，Windows 上是物理像素——两边都和
/// `mouse.move` 收的单位一致，调用方不必换算。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AxNode {
    pub role: String,
    pub text: String,
    pub value: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub enabled: bool,
    /// 开发者给控件起的稳定标识（macOS accessibilityIdentifier / Windows AutomationId /
    /// Chromium 里 HTML 的 id）。**自研应用**靠它：源码在自己手里时给控件加上标识，读屏就能按
    /// 名字点到，不用再靠坐标或者会变的文案。没有就不输出。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
}

/// 网页容器（AXWebArea / UIA Document）的加载状态。前台是浏览器或 Electron 时才有。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PageState {
    pub title: String,
    pub loaded: bool,
    pub progress: f64,
}

/// 按名字找应用的结果：pid 之外把「凭什么认定的」也交回去，模型看得懂自己是按标题还是按名字命中的。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppMatch {
    pub pid: i32,
    pub name: String,
    /// macOS 是 bundle id，Windows 是可执行文件名（chrome.exe）。
    pub bundle: String,
    /// 可执行文件的完整路径。调用方拿它判「这是不是用户正在开发的那个应用」（路径落在工作区里）。
    pub exe: String,
    pub via: &'static str,
}

/// 一个正在监听的本机 TCP 端口，属于目标进程或它的子进程。
/// 自研 Electron / WebView2 应用带 `--remote-debugging-port` 启动时，调试端口就在这里面。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ListenPort {
    pub port: u16,
    pub pid: i32,
}

/// 一个进程「是什么」：可执行文件在哪、是不是 Chromium 内核、开着哪些监听端口。
/// `app.resolve` 把它交回去，调用方据此判「这是不是用户自己正在开发的应用」以及
/// 「能不能用 browser 直接接管（调试端口）」。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AppDetails {
    pub exe: String,
    /// macOS 是 .app 包的路径；Windows 是可执行文件所在目录。
    pub bundle_path: String,
    /// Electron / Chrome / Edge / CEF / WebView2 宿主——网页内核，`--remote-debugging-port` 对它有效。
    pub chromium: bool,
    pub ports: Vec<ListenPort>,
}

/// 屏幕上的一扇窗口：主人进程、主人名、标题。按 z 序从前到后。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WinTitle {
    pub pid: i32,
    pub owner: String,
    pub title: String,
}

/// 签名变了就说它变了，不要闷头去点。两个平台同一把尺子。
pub fn signature_drift(a: &AxNode, b: &AxNode) -> Option<String> {
    if a.role != b.role {
        return Some(format!("role {} → {}", a.role, b.role));
    }
    if a.text != b.text {
        return Some("文案变了".into());
    }
    if (a.x - b.x).abs() > 4 || (a.y - b.y).abs() > 4 {
        return Some(format!("位置从 {},{} 移到 {},{}", a.x, a.y, b.x, b.y));
    }
    None
}

/// 「没找到这个应用」的那句话。候选是屏幕上有窗口的应用（附标题），让模型一步改对，不用继续猜。
pub fn no_such_app(query: &str, candidates: &[String]) -> String {
    if candidates.is_empty() {
        format!("没有找到名字里含「{query}」的运行中应用（显示名 / 可执行名 / bundle id / 窗口标题都试过了）；用 window.list 看，或直接给 pid")
    } else {
        format!(
            "没有找到名字里含「{query}」的运行中应用（显示名 / 可执行名 / bundle id / 窗口标题都试过了）。屏幕上有窗口的是：{}。挑一个重发，或直接给 pid",
            candidates.join("、")
        )
    }
}

/// UI Automation 的 ControlType → 和 macOS 同一套 role 词汇。
///
/// 为什么要翻译而不是原样交出去：Tauri / JS / 提示词里所有按 role 做的判断（画不画框、
/// 算不算可点、错误提示怎么说）都是按 macOS 的词写的。Windows 交出 "ListItem"、"Hyperlink"
/// 这些原词，那些判断就整组失效，模型在 Windows 上看到的就是「没有一个可点的元素」。
/// 纯函数，两个平台都参与编译，测试在 mac 上就能跑。
pub fn role_for_control_type(control_type: i32, is_password: bool) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => {
            if is_password {
                "SecureTextField"
            } else {
                "TextField"
            }
        }
        50005 => "Link",
        50006 => "Image",
        50007 => "Row",   // ListItem
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressIndicator",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Incrementor", // Spinner
        50017 => "StatusBar",
        50018 => "TabGroup",
        50019 => "Tab", // TabItem
        50020 => "StaticText",
        50021 => "Toolbar",
        50022 => "HelpTag", // ToolTip
        50023 => "Outline", // Tree
        50024 => "Row",     // TreeItem
        50025 => "Group",   // Custom
        50026 => "Group",
        50027 => "Thumb",
        50028 => "Table", // DataGrid
        50029 => "Row",   // DataItem
        50030 => "Document",
        50031 => "MenuButton", // SplitButton
        50032 => "Window",
        50033 => "Group", // Pane
        50034 => "Group", // Header
        50035 => "Button", // HeaderItem：列头可点（排序），按可点的算
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "Group", // SemanticZoom
        50040 => "Toolbar", // AppBar
        _ => "Group",
    }
}

/// 按名字找应用的**排序规则**，两个平台共用（平台层只负责把候选收集起来）。
///
/// 顺序：三种名字精确相等 > 窗口标题精确 > 窗口标题子串 > 名字子串；同一档里有界面的排前面、
/// 前台的排最前。返回命中的候选下标和「凭什么」。
pub struct AppCandidate {
    pub pid: i32,
    /// 显示名（macOS localizedName / Windows 可执行名去后缀）。
    pub name: String,
    /// 别名：可执行名、bundle id / 文件名——都算「名字」。
    pub aliases: Vec<String>,
    pub titles: Vec<String>,
    pub has_ui: bool,
    pub frontmost: bool,
}

pub fn rank_app_match(query: &str, cands: &[AppCandidate]) -> Option<(usize, &'static str)> {
    let want = query.trim().to_lowercase();
    if want.is_empty() {
        return None;
    }
    // 去掉 .exe / .app 后缀和空格，让 "chrome.exe"、"Google Chrome"、"googlechrome" 都认得。
    let strip = |s: &str| -> String {
        let s = s.trim().to_lowercase();
        let s = s.strip_suffix(".exe").or_else(|| s.strip_suffix(".app")).map(|x| x.to_string()).unwrap_or(s);
        s
    };
    let squash = |s: &str| -> String { strip(s).chars().filter(|c| !c.is_whitespace()).collect() };
    let want_s = strip(&want);
    let want_sq = squash(&want);
    let order = |i: usize| -> (u8, u8) {
        let c = &cands[i];
        (if c.frontmost { 0 } else { 1 }, if c.has_ui { 0 } else { 1 })
    };
    let pick = |pred: &dyn Fn(&AppCandidate) -> bool| -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, c) in cands.iter().enumerate() {
            if pred(c) && best.map(|b| order(i) < order(b)).unwrap_or(true) {
                best = Some(i);
            }
        }
        best
    };
    let names = |c: &AppCandidate| -> Vec<String> {
        std::iter::once(c.name.clone()).chain(c.aliases.iter().cloned()).collect()
    };
    if let Some(i) = pick(&|c| names(c).iter().any(|n| strip(n) == want_s || squash(n) == want_sq)) {
        return Some((i, "name"));
    }
    if let Some(i) = pick(&|c| c.titles.iter().any(|t| t.trim().to_lowercase() == want)) {
        return Some((i, "window_title"));
    }
    if let Some(i) = pick(&|c| c.titles.iter().any(|t| t.to_lowercase().contains(&want))) {
        return Some((i, "window_title"));
    }
    if let Some(i) = pick(&|c| names(c).iter().any(|n| strip(n).contains(&want_s) || squash(n).contains(&want_sq))) {
        return Some((i, "name"));
    }
    None
}

/// 「屏幕上有窗口的应用（附标题）」清单，给找不到时报回去。
pub fn describe_candidates(cands: &[AppCandidate]) -> Vec<String> {
    cands
        .iter()
        .filter(|c| c.has_ui)
        .take(12)
        .map(|c| {
            let titles: Vec<&str> = c.titles.iter().map(|s| s.as_str()).filter(|s| !s.is_empty()).take(2).collect();
            if titles.is_empty() {
                c.name.clone()
            } else {
                format!("{}（{}）", c.name, titles.join(" / "))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(pid: i32, name: &str, aliases: &[&str], titles: &[&str], has_ui: bool, frontmost: bool) -> AppCandidate {
        AppCandidate {
            pid,
            name: name.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            titles: titles.iter().map(|s| s.to_string()).collect(),
            has_ui,
            frontmost,
        }
    }

    #[test]
    fn control_types_map_to_the_mac_vocabulary() {
        assert_eq!(role_for_control_type(50000, false), "Button");
        assert_eq!(role_for_control_type(50004, false), "TextField");
        assert_eq!(role_for_control_type(50004, true), "SecureTextField");
        assert_eq!(role_for_control_type(50005, false), "Link");
        assert_eq!(role_for_control_type(50007, false), "Row");
        assert_eq!(role_for_control_type(50019, false), "Tab");
        assert_eq!(role_for_control_type(50020, false), "StaticText");
        assert_eq!(role_for_control_type(50035, false), "Button");
        assert_eq!(role_for_control_type(99999, false), "Group");
    }

    /// 所有者那台 Electron 应用：进程叫 Electron、窗口叫「ZipMate 压缩助手」。模型说的是后者。
    #[test]
    fn window_title_is_recognised_as_an_app_name() {
        let c = vec![
            cand(1, "Electron", &["electron.exe"], &["ZipMate 压缩助手"], true, false),
            cand(2, "chrome", &["chrome.exe", "Google Chrome"], &["GitHub - Google Chrome"], true, true),
        ];
        assert_eq!(rank_app_match("ZipMate 压缩助手", &c), Some((0, "window_title")));
        assert_eq!(rank_app_match("zipmate", &c), Some((0, "window_title")));
        assert_eq!(rank_app_match("Google Chrome", &c), Some((1, "name")));
        assert_eq!(rank_app_match("chrome.exe", &c), Some((1, "name")));
        assert_eq!(rank_app_match("googlechrome", &c), Some((1, "name")));
        assert_eq!(rank_app_match("Electron", &c), Some((0, "name")));
        assert_eq!(rank_app_match("nothing like this", &c), None);
    }

    /// 同名进程（比如两个 Chrome）：前台的、有界面的排前面。
    #[test]
    fn frontmost_and_ui_processes_win_ties() {
        let c = vec![
            cand(10, "chrome", &["chrome.exe"], &[], false, false),
            cand(11, "chrome", &["chrome.exe"], &["Docs - Google Chrome"], true, false),
            cand(12, "chrome", &["chrome.exe"], &["Mail - Google Chrome"], true, true),
        ];
        assert_eq!(rank_app_match("chrome", &c).map(|m| c[m.0].pid), Some(12));
    }

    #[test]
    fn candidates_list_only_apps_with_windows() {
        let c = vec![
            cand(1, "svchost", &[], &[], false, false),
            cand(2, "notepad", &["notepad.exe"], &["Untitled - Notepad"], true, false),
        ];
        assert_eq!(describe_candidates(&c), vec!["notepad（Untitled - Notepad）".to_string()]);
        assert!(no_such_app("x", &describe_candidates(&c)).contains("notepad（Untitled - Notepad）"));
    }

    #[test]
    fn drift_tolerates_small_moves_only() {
        let a = AxNode { role: "Button".into(), text: "OK".into(), x: 10, y: 10, w: 5, h: 5, enabled: true, ..Default::default() };
        let mut b = a.clone();
        b.x = 13;
        assert!(signature_drift(&a, &b).is_none());
        b.x = 20;
        assert!(signature_drift(&a, &b).is_some());
        b = a.clone();
        b.text = "Cancel".into();
        assert_eq!(signature_drift(&a, &b).as_deref(), Some("文案变了"));
    }
}
