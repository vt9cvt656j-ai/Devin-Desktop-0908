use std::io::{Read, Seek, SeekFrom, Write};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::{Regex, RegexBuilder};
use serde::Serialize;

/// Maximum size of a file we will load into the editor (5 MiB).
const MAX_FILE: u64 = 5 * 1024 * 1024;

/// Files larger than this are skipped during project search (2 MiB).
const SEARCH_MAX_FILE: u64 = 2 * 1024 * 1024;
/// Hard cap on the total number of matches returned by a single search.
const SEARCH_MAX_RESULTS: usize = 2000;
/// Cap on matches reported per file so one file can't drown the results.
const SEARCH_MAX_PER_FILE: usize = 50;
/// Bound directory walks even when a query has no matches.
const SEARCH_MAX_SCANNED_FILES: usize = 20_000;
/// Display lines are truncated to this many characters in search results.
const SEARCH_MAX_LINE_CHARS: usize = 500;
const INSPECT_FULL_PARSE_MAX: u64 = 64 * 1024 * 1024;
const INSPECT_HEX_BYTES: usize = 16 * 1024;
const INSPECT_STRING_SCAN_BYTES: usize = 1024 * 1024;

/// Directories that are never descended into during search (build output,
/// vendored deps, VCS metadata). Dot-directories are skipped separately.
/// 点号开头的目录里，真正只有噪声的那几个。
///
/// 这里原来根本没有名单：search / replace 两处都是 `if name.starts_with('.') { continue; }`
/// ——一刀切跳过**所有**点号条目。于是 `.github/`、`.env`、`.eslintrc`、`.gitignore`、
/// `.dockerignore` 全是盲区：模型搜 "workflow_dispatch" 得到 0 命中，而文件就在
/// `.github/workflows/` 下面躺着；搜索面板同理。IGNORED_DIRS 上面那句注释写的是
/// 「dot-dirs like .next/.gradle/.venv are already skipped separately」——意图只是跳掉这几个
/// 生成物目录，实现却把所有点号条目一起跳了。
///
/// 更要命的是同一个模型用 find_files **能**找到 `.github/workflows/ci.yml`
/// （src/main.js 的 _agentFindFiles 早就改成具名黑名单了），却 search 不到里面的内容——
/// 两个工具对同一个仓库给出互相矛盾的答案，模型无从判断哪个是真的。
/// 这份名单刻意和 _agentFindFiles 里那份对齐。
const IGNORED_DOT_DIRS: &[&str] = &[
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".venv",
    ".download-venv",
    ".gradle",
    ".idea",
    ".vscode",
    // Visual Studio 的工程缓存目录，几百 MB 全是二进制中间产物。
    // 名单里有 .idea/.vscode 却独独漏了它 —— 于是 Windows 上用 VS 的仓库，
    // 索引和搜索会被这一堆东西灌满，真代码被挤出结果。
    ".vs",
    ".cache",
    ".turbo",
    ".vite",
    ".parcel-cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".terraform",
    ".yarn",
    ".pnpm-store",
    ".angular",
    ".dart_tool",
    ".swiftpm",
    ".bundle",
    ".sass-cache",
    ".nyc_output",
    ".serverless",
    ".vercel",
    ".netlify",
    ".DS_Store",
];

/// 工作区根 → 该根的 .gitignore 匹配器。
///
/// 用 ripgrep 同款的 `ignore` crate，而不是手搓正则：gitignore 的语义（否定 `!`、
/// 锚定 `/a`、目录限定 `a/`、`**`、字符类）细节很多，写错的方向是**把用户自己的源码
/// 误藏**——那比多显示一个 node_modules 严重得多。
///
/// 只读工作区根那一份 .gitignore（外加 .git/info/exclude），**不递归读子目录里的**。
/// 这是有意的取舍：漏读嵌套规则的后果是"显示得比 git 多一点"，属于安全方向；而为了
/// 嵌套规则在每个目录重建匹配器，会让搜索那种上万次目录遍历慢得没法用。
static GITIGNORE_CACHE: Lazy<Mutex<HashMap<PathBuf, (std::time::Instant, Arc<ignore::gitignore::Gitignore>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const GITIGNORE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// 这个路径落在哪个已注册的工作区根下面（取最深的那个，多根嵌套时才对得上）。
fn workspace_root_for(path: &Path) -> Option<PathBuf> {
    let roots = ALLOWED_ROOTS.lock().ok()?;
    roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.components().count())
        .cloned()
}

fn gitignore_for_root(root: &Path) -> Arc<ignore::gitignore::Gitignore> {
    if let Ok(cache) = GITIGNORE_CACHE.lock() {
        if let Some((at, gi)) = cache.get(root) {
            if at.elapsed() < GITIGNORE_TTL {
                return Arc::clone(gi);
            }
        }
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    // add() 返回 Option<Error>：解析不了就当没有这条规则，绝不能因此 panic 或
    // 把整棵树判成 ignored。
    let _ = builder.add(root.join(".gitignore"));
    let _ = builder.add(root.join(".git/info/exclude"));
    let gi = Arc::new(builder.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty()));
    if let Ok(mut cache) = GITIGNORE_CACHE.lock() {
        cache.insert(root.to_path_buf(), (std::time::Instant::now(), Arc::clone(&gi)));
    }
    gi
}

/// 这个路径被它所属工作区的 .gitignore 排除了吗。
///
/// 找不到所属工作区、或没有 .gitignore 时一律返回 false —— 判不出来就**不标记**，
/// 宁可多显示也不要藏掉用户要找的东西。
fn path_is_git_ignored(path: &Path, is_dir: bool) -> bool {
    let Some(root) = workspace_root_for(path) else { return false };
    let gi = gitignore_for_root(&root);
    matches!(gi.matched_path_or_any_parents(path, is_dir), ignore::Match::Ignore(_))
}

/// 遍历时要不要跳过这个条目。目录看名单，文件一律保留。
///
/// 文件不过滤是有意的：`.env`、`.eslintrc`、`.gitignore`、`.prettierrc` 恰恰是最常被搜的
/// 那批配置。唯一的例外 `.DS_Store` 已经在上面的名单里（它既可能是目录名也可能是文件名，
/// 统一挡掉）。
fn skip_walk_entry(name: &str, is_dir: bool) -> bool {
    if IGNORED_DOT_DIRS.contains(&name) {
        return true;
    }
    is_dir && IGNORED_DIRS.contains(&name)
}

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    "coverage",
    // Additional universally-vendored / generated trees so search returns signal,
    // not noise (dot-dirs like .next/.gradle/.venv are already skipped separately).
    "bower_components",
    "Pods",
    "venv",
];

/// Workspace roots that have been opened by the user via the native folder
/// dialog.  Every file-system command that operates on arbitrary paths
/// (read / write / delete / rename / search / replace) checks that the target
/// path falls inside one of these roots, blocking path-traversal attacks from
/// XSS or extension sandbox escapes.
static ALLOWED_ROOTS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
/// Serialize IDE-originated workspace mutations. Conditional agent writes hold
/// this lock across their final read/compare/write sequence, so two concurrent
/// agent runs cannot both validate the same old version and silently overwrite
/// one another.
static FILE_MUTATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Stage complete, durable contents beside `path`. Callers publish the staged
/// inode with either replace or no-clobber semantics, then remove its temp name.
fn stage_text_file(
    path: &Path,
    content: &str,
    permissions: Option<std::fs::Permissions>,
) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("cannot determine parent directory for '{}'", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create parent directory '{}': {e}", parent.display()))?;

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("invalid file path '{}'", path.display()))?
        .to_string_lossy();

    let mut staged = None;
    let mut last_error = None;
    for _ in 0..8 {
        let candidate = parent.join(format!(
            ".{file_name}.michael-write-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                staged = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(format!(
                    "cannot stage write for '{}': {error}",
                    path.display()
                ));
            }
        }
    }

    let (temporary_path, mut temporary_file) = staged.ok_or_else(|| {
        format!(
            "cannot allocate a temporary file for '{}': {}",
            path.display(),
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "temporary-name collision".into())
        )
    })?;

    let stage_result = (|| -> Result<(), String> {
        temporary_file
            .write_all(content.as_bytes())
            .map_err(|e| format!("cannot write staged contents for '{}': {e}", path.display()))?;
        temporary_file
            .flush()
            .map_err(|e| format!("cannot flush staged write for '{}': {e}", path.display()))?;
        if let Some(permissions) = permissions {
            temporary_file.set_permissions(permissions).map_err(|e| {
                format!("cannot preserve permissions for '{}': {e}", path.display())
            })?;
        }
        temporary_file
            .sync_all()
            .map_err(|e| format!("cannot sync staged write for '{}': {e}", path.display()))
    })();
    drop(temporary_file);

    if let Err(error) = stage_result {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(temporary_path)
}

fn sync_parent_directory(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

/// Replace `path` only after the complete new contents have been staged and
/// synced in the same directory. Keeping the temporary file beside the target
/// makes the final rename atomic on the target filesystem, so an interrupted or
/// failed write cannot leave the original file truncated or partially written.
fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    let original_permissions = std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.permissions());
    let temporary_path = stage_text_file(path, content, original_permissions)?;
    if let Err(error) = atomic_replace_file(&temporary_path, path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(format!(
            "cannot atomically replace '{}': {error}",
            path.display()
        ));
    }

    // The staged file itself is already durable. Syncing the directory also
    // persists the rename on filesystems that support directory fsync; failure
    // here is deliberately best-effort because the replacement has committed.
    sync_parent_directory(path);
    Ok(())
}

/// Publish a fully staged file only if `path` still does not exist. A hard link
/// is an atomic no-clobber operation on the same filesystem: either the complete
/// staged inode appears at `path`, or an independently-created target wins and
/// remains untouched.
fn atomic_create_text(path: &Path, content: &str) -> Result<(), String> {
    let temporary_path = stage_text_file(path, content, None)?;
    if let Err(error) = std::fs::hard_link(&temporary_path, path) {
        let _ = std::fs::remove_file(&temporary_path);
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return Err("[CONFLICT] file was created by another task".into());
        }
        return Err(format!(
            "cannot atomically create '{}': {error}",
            path.display()
        ));
    }

    let cleanup = std::fs::remove_file(&temporary_path).map_err(|error| {
        format!(
            "file was created at '{}' but its staged link '{}' could not be removed: {error}",
            path.display(),
            temporary_path.display()
        )
    });
    sync_parent_directory(path);
    cleanup
}

#[cfg(not(windows))]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let from_wide = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to_wide = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        // MoveFileExW 失败之后再走一次 std 的 rename —— 它比这里多做两件事，而这两件事
        // 正好各对应一类真实失败：
        // ① ACCESS_DENIED 时它会用 SetFileInformationByHandle(FileRenameInfoEx,
        //    POSIX_SEMANTICS) 兜底（std 注释原文：ignore the readonly attribute）——
        //    治 `attrib +R` 和 Perforce 类仓库的只读文件；
        // ② 它会加 `\\?\` 长路径前缀（maybe_verbatim），而这里喂的是**裸路径**，
        //    且应用清单里没有 longPathAware —— 治 208~259 字符那一段
        //    「能打开、能读、一保存就失败」（暂存文件名比目标长约 52 字符）。
        // 一行同时解决两件事，且不改变成功路径的行为。
        return std::fs::rename(from, to);
    }
    Ok(())
}

/// Pre-register the user's HOME directory so files are accessible before any
/// folder is explicitly opened.  Called from `lib.rs` during app setup.
pub fn bootstrap_home_root() {
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let home_path = PathBuf::from(&home);
        if let Ok(canonical) = std::fs::canonicalize(&home_path) {
            if let Ok(mut roots) = ALLOWED_ROOTS.lock() {
                if !roots.contains(&canonical) {
                    roots.push(canonical);
                }
                let raw = home_path;
                if !roots.contains(&raw) {
                    roots.push(raw);
                }
            }
        } else if let Ok(mut roots) = ALLOWED_ROOTS.lock() {
            if !roots.contains(&home_path) {
                roots.push(home_path);
            }
        }
    }
}

/// 新建一个项目目录并把它注册成工作区根。
///
/// # 为什么需要一个专用命令
///
/// `create_dir` 走 `require_inside_workspace`，也就是"必须先有工作区才能建目录"——而这里要解决的
/// 恰恰是**一个工作区都还没有**的情况。用户说「帮我写个 telegram 机器人」而左边没打开任何文件夹时，
/// 智能体以前只能把问题退回给用户：它自己开不了工。这是它唯一真正缺的能力，不是策略问题。
///
/// # 边界
///
/// 位置**不由调用方决定**。模型只能给一个名字，目录一律建在 `~/MrDayOne/<name>` 下：
/// - 名字过一遍白名单（字母数字、`.`、`_`、`-`），任何分隔符和 `..` 直接拒——所以拼不出逃逸路径；
/// - 建完仍然走 `register_workspace_root` 的全部守卫（规范化、深度 ≤2 拒绝、系统目录黑名单）；
/// - 已存在同名目录时**不覆盖**，直接复用并注册——重复调用是幂等的，不会悄悄清空谁的代码。
///
/// 换句话说：它能创造的最坏结果，是在用户自己的主目录下多出一个空文件夹。
#[tauri::command(async)]
pub fn create_project_dir(name: String) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("project name is empty".into());
    }
    // 单段名字，白名单字符。`/`、`\`、`..` 一律不在表内，所以拼不出逃逸路径。
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        || trimmed.starts_with('.')
        || trimmed.contains("..")
    {
        return Err(format!(
            "invalid project name '{trimmed}': use letters, digits, '.', '_' or '-' only, and not starting with '.'"
        ));
    }
    if trimmed.len() > 64 {
        return Err("project name is too long (max 64)".into());
    }
    let home = home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let base = PathBuf::from(home).join("MrDayOne");
    std::fs::create_dir_all(&base).map_err(|e| friendly_write_error("创建目录", &base.to_string_lossy(), &e))?;
    let target = base.join(trimmed);
    if !target.exists() {
        std::fs::create_dir_all(&target)
            .map_err(|e| friendly_write_error("创建目录", &target.to_string_lossy(), &e))?;
    } else if !target.is_dir() {
        return Err(format!("{} already exists and is not a directory", target.display()));
    }
    // 复用同一套注册守卫——这里不另开一条路径。
    let canonical = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    register_workspace_root(canonical.to_string_lossy().into_owned())?;
    // 剥掉 verbatim 前缀再交给前端；登记那份仍用未剥的 canonical（黑名单依赖它）。
    Ok(strip_verbatim(&canonical.to_string_lossy()))
}

/// Register a workspace root that the user explicitly opened.
/// Called from the frontend after a successful folder-open dialog.
#[tauri::command(async)]
pub fn register_workspace_root(path: String) -> Result<(), String> {
    let raw_path = PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    // Block overly broad roots that would defeat the workspace boundary.
    let depth = canonical.components().count();
    if depth <= 2 {
        return Err(format!(
            "refusing to register '{}' as a workspace root: path is too broad (depth {depth}).",
            canonical.display()
        ));
    }
    // Depth alone is not a safety property. `/etc` and `/Users` are depth 2 and were
    // caught, but `/usr/local`, `/private/etc`, `/etc/ssl` and `/Library/LaunchAgents`
    // are all depth >= 3 and registered cleanly — each one granting write access to a
    // directory that can change what the machine executes on next login. Name the
    // system trees explicitly instead of inferring safety from a component count.
    if let Some(blocked) = blocked_root_prefix(&canonical) {
        return Err(format!(
            "refusing to register '{}' as a workspace root: '{}' is a system directory.",
            canonical.display(),
            blocked
        ));
    }
    if !canonical.is_dir() {
        return Err("workspace root must be a directory".into());
    }
    let mut roots = ALLOWED_ROOTS.lock().map_err(|e| e.to_string())?;
    if !roots.contains(&canonical) {
        roots.push(canonical);
    }
    if raw_path != *roots.last().unwrap_or(&PathBuf::new()) && !roots.contains(&raw_path) {
        roots.push(raw_path);
    }
    bootstrap_home_root_inner(&mut roots);
    Ok(())
}

fn bootstrap_home_root_inner(roots: &mut Vec<PathBuf>) {
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let home_path = PathBuf::from(&home);
        if let Ok(home_canonical) = std::fs::canonicalize(&home_path) {
            if !roots.contains(&home_canonical) {
                roots.push(home_canonical);
            }
        }
        if !roots.contains(&home_path) {
            roots.push(home_path);
        }
    }
}

/// System trees that must never become a workspace root. Registering one grants write
/// access to everything under it, and each of these can change what the machine runs:
/// launch agents/daemons, shell profiles, PAM/sudo config, CA trust stores, package
/// prefixes that sit on PATH. Compared component-wise via `Path::starts_with`, so
/// `/usr/locale` does not match `/usr/local`.
#[cfg(not(windows))]
const BLOCKED_ROOT_PREFIXES: &[&str] = &[
    "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys",
    "/etc", "/private/etc",
    "/usr", "/opt",
    "/var", "/private/var",
    "/Library", "/System", "/Applications",
];
#[cfg(windows)]
const BLOCKED_ROOT_PREFIXES: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
];

/// The blocked system prefix `path` sits under, if any.
///
/// Temp directories are carved back out: on macOS `std::env::temp_dir()` lives under
/// `/var/folders`, and on Linux under `/tmp` — both inside blocked trees, and both
/// legitimate scratch space that `SAFE_PREFIXES` already grants.
/// Windows 前缀比对的纯字符串逻辑。**不带 cfg**，所以 macOS 上也编译、也被测试覆盖。
///
/// 这一步不是可选的。`std::fs::canonicalize` 在 Windows 上返回 verbatim 形式
/// （`\\?\C:\Windows\System32`），而 `Path::starts_with` 是按**组件**比的：verbatim 路径的
/// 首组件是 `Prefix::VerbatimDisk('C')`，和字面量 `C:\Windows` 里的 `Prefix::Disk('C')`
/// 不相等 —— 于是整张系统目录黑名单一条都匹配不上，`C:\Windows` 能被登记成工作区根，
/// 而这道闸门在界面上、日志里都不会有任何异样。加上 Windows 路径不区分大小写，
/// `c:\windows` 同样要能命中。
/// 把 `canonicalize` 产出的 **verbatim** 前缀剥掉，再交给前端。
///
/// Windows 上 `std::fs::canonicalize` 返回 `\\?\C:\Users\me\proj`（同文件
/// windows_prefix_match_form 的注释就写着这一点）。原样交出去，前端 _toPosix 之后
/// 变成 `//?/C:/...`，然后至少三处会坏：
///
/// · **语言服务全死**：monaco 的 `URI.file("//?/C:/…").toString()` 会把 `?` 当成
///   authority，产出 `file://%3F/c%3A/…`；Rust 侧剥 `file://` 之后拿到 `?/c:/…`，
///   normalize_uri_path 只认「/ + 盘符」这一种形状、原样返回，
///   于是 `builder.current_dir(ws_dir)` 拿到一个不存在的相对路径，
///   每个语言服务器 spawn 当场失败 —— 补全/跳转/悬停/诊断全部消失且不报错。
/// · **同一个文件开出两个页签**：_pathIdentity 只做小写化、不剥前缀，
///   `//?/c:/proj/a.py` 和 `c:/proj/a.py` 归并不了 → 两个独立 model，各自保存互相覆盖。
///   （文件树走的是 read_dir，用的是**原始** path，所以树和 ⌘P 给的是同一个文件的两个字符串。）
/// · **cwd**：portable-pty 不剥 verbatim 前缀，而 std 会剥 —— std 自己的注释就是判据
///   （"the current directory does not support verbatim paths"）。
///
/// **登记工作区根用的那份必须保持 canonical 原样**：黑名单比对依赖 verbatim 形式。
/// 这个函数只用在**返回给前端**的路径上。
fn strip_verbatim(raw: &str) -> String {
    raw.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| raw.to_string())
}

fn windows_prefix_match_form(raw: &str) -> String {
    let stripped = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| raw.to_string());
    // **去掉尾部分隔符再比。** Windows 的 `std::env::temp_dir()` 返回的是
    // `C:\Users\x\AppData\Local\Temp\` —— **带尾部反斜杠**。而下面
    // windows_starts_with_prefix 的判据是「相等，或者剥掉前缀之后剩下的以 \ 开头」，
    // 拿一个自带尾巴的前缀去比，两条都不可能成立 → 临时目录豁免在 Windows 上**恒假**。
    // 后果是「写被拒、读没事」，而拒绝文案还写着「临时目录仍然可用」；
    // 同时它让 Windows 上的 the_systems_own_temp_dir_is_always_writable 这条测试
    // **现在就是红的** —— 也就是 Rust 测试从没在 Windows 上跑通过一次。
    let lowered = stripped.replace('/', "\\").to_lowercase();
    let trimmed = lowered.trim_end_matches('\\');
    // 纯盘符根（`c:\`）整个 trim 掉会变成 `c:`，那反而匹配不上，留一份保底。
    if trimmed.is_empty() { lowered } else { trimmed.to_string() }
}

/// 仍然按组件边界判，别让 `C:\Windowsfoo` 命中 `C:\Windows`。
fn windows_starts_with_prefix(raw: &str, prefix: &str) -> bool {
    let p = windows_prefix_match_form(raw);
    let want = windows_prefix_match_form(prefix);
    p == want || p.strip_prefix(&want).is_some_and(|rest| rest.starts_with('\\'))
}

#[cfg(windows)]
fn starts_with_prefix(path: &Path, prefix: &str) -> bool {
    windows_starts_with_prefix(&path.to_string_lossy(), prefix)
}

#[cfg(not(windows))]
fn starts_with_prefix(path: &Path, prefix: &str) -> bool {
    path.starts_with(Path::new(prefix))
}

fn blocked_root_prefix(path: &Path) -> Option<&'static str> {
    if has_safe_prefix(path) {
        return None;
    }
    BLOCKED_ROOT_PREFIXES
        .iter()
        .copied()
        .chain(extra_blocked_root_prefixes().iter().copied())
        .find(|prefix| starts_with_prefix(path, prefix))
}

/// Windows 上系统不一定装在 C 盘。
///
/// BLOCKED_ROOT_PREFIXES 里四条全把盘符写死成 `C:` —— 系统装在 D 盘时整张黑名单
/// **一条都命中不了**，那道"不许把系统目录登记成工作区根"的保护静默失效。
/// 这里按 `SystemDrive`（Windows 一定会设）把同样四条在真实系统盘上再生成一份。
/// 泄漏一次拿 'static：这是进程生命周期的常量表，不是每次调用都分配。
/// 非 Windows 上返回空切片，行为一个字不变。
fn extra_blocked_root_prefixes() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        static EXTRA: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
        EXTRA.get_or_init(|| {
            let drive = std::env::var("SystemDrive").unwrap_or_default();
            let drive = drive.trim_end_matches('\\');
            // 已经是 C: 就不用再加一份（下面的比对本来就不区分大小写，但省一次分配）。
            if drive.is_empty() || drive.eq_ignore_ascii_case("C:") {
                return Vec::new();
            }
            ["Windows", "Program Files", "Program Files (x86)", "ProgramData"]
                .iter()
                .map(|tail| {
                    let s: &'static str =
                        Box::leak(format!("{drive}\\{tail}").into_boxed_str());
                    s
                })
                .collect()
        })
    }
    #[cfg(not(windows))]
    {
        &[]
    }
}

/// Paths always allowed regardless of workspace roots (temp dirs, macOS firmlinks).
const SAFE_PREFIXES: &[&str] = &[
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
];

fn has_safe_prefix(path: &Path) -> bool {
    if SAFE_PREFIXES
        .iter()
        .any(|prefix| starts_with_prefix(path, prefix))
    {
        return true;
    }
    // SAFE_PREFIXES 是四条 POSIX 字面量，Windows 上一条都不可能命中——那儿的临时目录是
    // `%LOCALAPPDATA%\Temp`。平时看不出来（Windows 的黑名单里恰好没有它的父目录），
    // 但只要用户把 TEMP 指到一个被挡的树下（受管电脑上常见），写入就会被拒，
    // 而拒绝信息还在说「临时目录仍然可用」——一句当场就不成立的话。
    //
    // 判据换成**系统真实的临时目录**，不再靠猜它在哪儿：三个平台都自动对。
    let tmp = std::env::temp_dir();
    if tmp.as_os_str().is_empty() {
        return false;
    }
    starts_with_prefix(path, &tmp.to_string_lossy())
}

fn is_within_allowed_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Verify `target` is inside an allowed workspace root.  Resolves symlinks and
/// normalises components so that `../../etc/passwd` tricks are caught even when
/// intermediate directories exist.
/// Require that a target path is inside one of the registered workspace roots, or (for
/// read-only operations) under the user's home directory. Write/delete/rename operations
/// must stay strictly within workspace to prevent writing ~/.ssh/id_rsa, etc.
pub fn require_inside_workspace(target: &str, is_write_op: bool) -> Result<PathBuf, String> {
    let target_path = Path::new(target);
    let raw_target = target.to_string();

    // For paths that don't exist yet (create_file, create_dir), resolve the
    // deepest existing ancestor and append the remaining components.
    let resolved = if target_path.exists() {
        std::fs::canonicalize(target_path).map_err(|e| e.to_string())?
    } else {
        let mut base = target_path.to_path_buf();
        let mut pending: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if base.exists() {
                break;
            }
            if let Some(name) = base.file_name() {
                pending.push(name.to_os_string());
            } else {
                break;
            }
            match base.parent() {
                Some(p) => base = p.to_path_buf(),
                None => break,
            }
        }
        let mut resolved = std::fs::canonicalize(&base).map_err(|e| e.to_string())?;
        for seg in pending.into_iter().rev() {
            let comp = Path::new(&seg);
            for c in comp.components() {
                match c {
                    Component::Normal(s) => resolved.push(s),
                    Component::CurDir => {}
                    _ => return Err("path contains disallowed components".into()),
                }
            }
        }
        resolved
    };

    let resolved_str = resolved.to_string_lossy().to_string();

    // Post-canonicalize safe-prefix check (handles firmlinks like /tmp → /private/tmp).
    // Temp dirs are deliberate scratch space — staging, atomic writes, archive
    // extraction — and stay available whether or not a workspace is open. This is an
    // explicit, narrow allowance, not the general boundary.
    if has_safe_prefix(&resolved) {
        return Ok(resolved);
    }

    let roots = ALLOWED_ROOTS.lock().map_err(|e| e.to_string())?;
    // Fail CLOSED. This used to `return Ok(resolved)` on an empty root list, which
    // handed out unrestricted read AND write access to the entire filesystem the moment
    // the list happened to be empty. `bootstrap_home_root` normally fills it during
    // `setup()`, but it is best-effort: if HOME/USERPROFILE is unset or canonicalize
    // fails, the list stays empty — and the security boundary silently disappeared in
    // exactly the degraded environment where it matters most. A missing boundary must
    // deny, never allow.
    if roots.is_empty() {
        return Err(format!(
            "access denied: no workspace root is registered yet, so '{}' cannot be \
             {}. Open a folder first (temp directories remain available).",
            raw_target,
            if is_write_op { "written" } else { "read" }
        ));
    }

    // Compare only canonicalized paths. Checking the raw user-supplied path here
    // would let a symlink inside a workspace authorize its target outside it.
    if is_within_allowed_root(&resolved, &roots) {
        if is_write_op {
            // HOME is in ALLOWED_ROOTS for read convenience, but write/delete/rename
            // must only succeed when the path is under an explicitly opened workspace
            // root — not just under ~/. Otherwise ~/.ssh, ~/.bashrc etc. are writable.
            let home_raw = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .ok()
                .map(PathBuf::from);
            let home_canonical = home_raw
                .as_ref()
                .and_then(|h| std::fs::canonicalize(h).ok());
            #[cfg(unix)]
            let home_meta = home_canonical
                .as_ref()
                .and_then(|h| std::fs::metadata(h).ok());
            let is_home = |root: &PathBuf| -> bool {
                // String comparison catches the common case.
                if home_canonical.as_ref().map_or(false, |h| root == h)
                    || home_raw.as_ref().map_or(false, |h| root == h)
                {
                    return true;
                }
                // On macOS, firmlinks (e.g. /System/Volumes/Data/Users/X vs /Users/X)
                // produce different canonical paths for the same inode. Compare by
                // device + inode to defeat that aliasing.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if let (Some(hm), Ok(rm)) = (&home_meta, std::fs::metadata(root)) {
                        if hm.dev() == rm.dev() && hm.ino() == rm.ino() {
                            return true;
                        }
                    }
                }
                false
            };
            let under_workspace = roots
                .iter()
                .any(|root| resolved.starts_with(root) && !is_home(root));
            if !under_workspace {
                return Err(format!(
                    "write denied: '{}' is under HOME but not inside any opened workspace.",
                    raw_target
                ));
            }
        }
        return Ok(resolved);
    }

    // For read-only operations, allow paths under HOME as a fallback (useful for
    // reading logs, config files, etc. when HOME was evicted from ALLOWED_ROOTS).
    if !is_write_op {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            if let Ok(home_canonical) = std::fs::canonicalize(&home) {
                if resolved.starts_with(home_canonical) {
                    return Ok(resolved);
                }
            }
        }
    }

    let root_list: Vec<String> = roots
        .iter()
        .map(|r| r.to_string_lossy().to_string())
        .collect();
    Err(format!(
        "access denied: path '{}' (resolved '{}') is outside all workspace roots. Allowed: [{}].",
        raw_target,
        resolved_str,
        root_list.join(", ")
    ))
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// 这一项属于「构建产物 / 依赖目录」这类噪声（判据和搜索用的是同一份
    /// `skip_walk_entry`，此前文件树一份都不用，三处忽略规则各自为政）。
    ///
    /// 只**标记**、不过滤：打开 Node 项目第一眼就是几万条 node_modules 确实难用，但直接
    /// 在这里删掉更糟——没有「显示隐藏文件」开关，`.vscode/`、`dist/` 会变得完全够不到，
    /// 而合法提交 `dist/` 的项目是存在的。让前端把它们置灰、排到最后，用户仍然点得进去。
    ignored: bool,
}

/// List the immediate children of a directory, directories first, then by name.
/// Dotfiles are hidden by default to keep the tree tidy.
// These commands perform synchronous filesystem work. Tauri's async execution
// context keeps slow disks, network mounts, recursive walks, and large files
// away from the native window event thread without changing their IPC contract.
#[tauri::command(async)]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    require_inside_workspace(&path, false)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let p = entry.path();
        // 用 metadata() 而不是 file_type()：前者跟随符号链接，后者不跟。
        // 不跟随的后果是**软链目录被当成文件**——点开是空的、也展不开，而 pnpm 的
        // node_modules、monorepo 的 packages 链接、`~/src` 之类的惯用软链全是这种。
        // 失败时回落到 file_type()（断链的软链 metadata 会 Err，此时按非目录处理是对的）。
        let is_dir = std::fs::metadata(&p)
            .map(|m| m.is_dir())
            .or_else(|_| entry.file_type().map(|t| t.is_dir()))
            .unwrap_or(false);
        // 两个来源取并集：写死的噪声名单（.git / node_modules / target …）+ **项目自己的
        // .gitignore**。后者才是真正的判据——合法提交 dist/ 的项目不会把它写进 .gitignore，
        // 于是它不会被压暗；反过来项目自己声明忽略的 build_out/、*.generated.ts 也能跟着灰下去，
        // 而这些是写死名单永远猜不到的。
        let ignored = skip_walk_entry(&name, is_dir) || path_is_git_ignored(&p, is_dir);
        entries.push(DirEntry {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir,
            ignored,
        });
    }
    // 噪声排最后：目录优先的规则之上再叠一层「被忽略的沉底」，于是打开 Node 项目
    // 第一眼看到的是自己的代码，而不是 node_modules。它们仍然在列表里、仍然点得进去。
    entries.sort_by(|a, b| match (a.ignored, b.ignored) {
        (false, true) => std::cmp::Ordering::Less,
        (true, false) => std::cmp::Ordering::Greater,
        _ => match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        },
    });
    Ok(entries)
}

/// 列出工作区里「人会想打开」的文件，供 ⌘P 快速打开用。
///
/// 替掉前端原来那套：从 rootPath 开始逐目录 `readDir`，**每个目录一次 IPC 往返**、
/// 串行、无缓存、上限 5000，而且带着全仓第 4 份写死的忽略名单（10 项，和搜索那份、
/// 文件树那份、TS 预加载那份互不相同）。大仓里第一次按 ⌘P 要等上千次往返。
///
/// 这里用 ignore crate 的 WalkBuilder 一次走完：它**原生支持嵌套 .gitignore**
/// （read_dir 那条路为了性能只读根目录那份，这里没有这个限制，因为只走一次），
/// 顺带把 .git 之类也排掉。于是 ⌘P 的候选里不再混进 node_modules 的几万个文件。
///
/// `limit` 是硬上限，触到就停并回报 truncated——和搜索那条一样，**截断必须说出来**，
/// 否则用户搜不到一个确实存在的文件，会以为它不在项目里。
#[tauri::command(async)]
pub fn list_project_files(root: String, limit: Option<usize>) -> Result<ProjectFileList, String> {
    let root_path = require_inside_workspace(&root, false)?;
    let cap = limit.unwrap_or(20_000).min(200_000);
    let mut files = Vec::new();
    let mut truncated = false;

    let walker = ignore::WalkBuilder::new(&root_path)
        .hidden(false)          // 点号文件自己判断：.github/.env 是要能搜到的
        .git_ignore(true)       // 跟随项目自己的 .gitignore（含嵌套）
        .git_global(false)      // 不吃用户全局配置——同一个仓库在两台机器上结果要一致
        .git_exclude(true)      // .git/info/exclude
        // 没有 .git 目录也照样认 .gitignore。ignore crate 默认 require_git=true——
        // 只在 git 仓库里才应用忽略规则。而 IDE 打开的目录不一定是仓库（下载的源码包、
        // 还没 git init 的新项目），那些目录里的 .gitignore 同样代表用户的意图。
        .require_git(false)
        .parents(true)
        .follow_links(false)    // 软链不跟进：monorepo 里会绕成环、也会把同一批文件列两遍
        // 名单里的目录要在**遍历时剪掉**，不能只在产出时过滤：只过滤的话 walker 照样会
        // 走进 node_modules 把里面几万个文件一个个 yield 出来（它们自己的名字不在名单里），
        // 既慢又会挤满候选。没有 .gitignore 的项目全靠这一层。
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            !skip_walk_entry(&name, is_dir)
        })
        .build();

    for entry in walker {
        if files.len() >= cap {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        // 写死名单仍然叠一层：.gitignore 不写 .git/ 自己，也有项目根本没有 .gitignore。
        if skip_walk_entry(&name, is_dir) {
            continue;
        }
        if is_dir {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(&root_path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push(ProjectFile {
            path: strip_verbatim(&path.to_string_lossy()),
            name,
            rel,
        });
    }
    Ok(ProjectFileList { files, truncated })
}

#[derive(Serialize)]
pub struct ProjectFile {
    path: String,
    name: String,
    rel: String,
}

#[derive(Serialize)]
pub struct ProjectFileList {
    files: Vec<ProjectFile>,
    truncated: bool,
}

/// Translate a raw IO error into a friendly, actionable message instead of
/// leaking `os error N` straight to the UI (see PATH_RESOLUTION_DIAGNOSIS.md).
fn friendly_read_error(path: &str, e: &std::io::Error) -> String {
    match e.kind() {
        // Human-facing only. This string is rendered as a UI toast, so it must not carry
        // agent coaching ("先用 list_dir/find_files 确认真实路径…"): the user is not the one
        // guessing paths, and the toast covered the terminal to say so. The model gets that
        // guidance on its own channel — the tool result — from `pathGuidance` in main.js.
        std::io::ErrorKind::NotFound => format!("文件不存在：{}", path),
        std::io::ErrorKind::PermissionDenied => format!("没有读取权限：{}", path),
        std::io::ErrorKind::IsADirectory => {
            format!("{} 是目录不是文件，请用 read_dir 查看其内容", path)
        }
        std::io::ErrorKind::NotADirectory => format!(
            "路径中间有一段不是目录：{}（可能把某个文件当成了目录）",
            path
        ),
        kind => format!("读取失败：{}（{}）", path, kind),
    }
}

fn friendly_write_error(op: &str, path: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "{}失败：路径不存在：{}（请先用 list_dir 确认父目录存在）",
            op, path
        ),
        std::io::ErrorKind::PermissionDenied => format!("{}失败：没有写入权限：{}", op, path),
        std::io::ErrorKind::AlreadyExists => format!("{}失败：目标已存在：{}", op, path),
        std::io::ErrorKind::IsADirectory => format!("{}失败：{} 是目录", op, path),
        std::io::ErrorKind::NotADirectory => {
            format!("{}失败：路径中间有一段不是目录：{}", op, path)
        }
        std::io::ErrorKind::DirectoryNotEmpty => format!("{}失败：目录不为空：{}", op, path),
        // 兜底分支打的是 e.kind()（分类名）而不是 e 本身。Windows 上**最常见**的写失败
        // ——文件被别的程序占着（ERROR_SHARING_VIOLATION 32 / ERROR_LOCK_VIOLATION 33）
        // ——在 std 里映射成 Uncategorized，于是模型看到的是一句
        // 「写入失败：a.txt（uncategorized）」：没有原因，也没有下一步。
        // 打 e 本身才会带上系统那句「另一个程序正在使用此文件」和错误号。
        kind => {
            let raw = e.to_string();
            let locked = cfg!(windows)
                && matches!(e.raw_os_error(), Some(32) | Some(33));
            if locked {
                format!(
                    "{}失败：{} 正被另一个程序占用（{}）。Windows 的文件锁是强制的——\
先关掉占着它的程序（编辑器、预览、杀毒扫描、还在跑的进程），或者换个文件名写。",
                    op, path, raw
                )
            } else {
                format!("{}失败：{}（{}）", op, path, raw)
            }
        }
    }
}

/// Read a UTF-8 text file. Rejects directories, oversized and binary files so
/// the editor never tries to render garbage.
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    let resolved = require_inside_workspace(&path, false)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| friendly_read_error(&path, &e))?;
    if meta.is_dir() {
        return Err(format!(
            "'{}' is a directory, not a file. Use read_dir to list its contents.",
            path
        ));
    }
    if meta.len() > MAX_FILE {
        return Err("file is too large to open in the editor (> 5 MB)".into());
    }
    let bytes = std::fs::read(&resolved).map_err(|e| friendly_read_error(&path, &e))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("cannot open a binary file in the editor".into());
    }
    String::from_utf8(bytes)
        .map_err(|_| format!("cannot open '{}': file is not valid UTF-8 text", path))
}

/// Read the tail of a log-like text file, including common logs under the user's
/// home directory (npm debug logs, app logs, temp logs). Unlike `read_text_file`,
/// this does not load the entire file, so a large debug log can still be used as
/// evidence by the agent without opening it in the editor.
#[tauri::command(async)]
pub fn read_log_tail(
    path: String,
    lines: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let path = if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "cannot expand ~/ because HOME is not set".to_string())?;
        Path::new(&home).join(rest).to_string_lossy().to_string()
    } else {
        path
    };
    let resolved = require_inside_workspace(&path, false)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| friendly_read_error(&path, &e))?;
    if meta.is_dir() {
        return Err(format!("'{}' is a directory, not a log file.", path));
    }
    let name = resolved
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = resolved
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let log_like = matches!(ext.as_str(), "log" | "out" | "err")
        || name.ends_with("-debug.log")
        || name.contains("debug") && name.ends_with(".txt");
    if !log_like {
        return Err("read_log_tail only reads log-like files (.log/.out/.err/debug*.txt)".into());
    }

    let line_limit = lines.unwrap_or(200).clamp(1, 2000);
    let byte_limit = max_bytes
        .unwrap_or(512 * 1024)
        .clamp(4 * 1024, 2 * 1024 * 1024) as u64;
    let file_len = meta.len();
    let start = file_len.saturating_sub(byte_limit);
    let mut file = std::fs::File::open(&resolved).map_err(|e| friendly_read_error(&path, &e))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((file_len - start).min(byte_limit) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| friendly_read_error(&path, &e))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("cannot read log tail: file appears to be binary".into());
    }
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if start > 0 {
        if let Some(idx) = text.find('\n') {
            text = text[idx + 1..].to_string();
        }
    }
    let mut tail_lines: Vec<&str> = text.lines().rev().take(line_limit).collect();
    tail_lines.reverse();
    let mut out = tail_lines.join("\n");
    if start > 0 {
        out = format!(
            "…（日志较大，仅读取最后约 {} KB / {} 行）\n{}",
            byte_limit / 1024,
            line_limit,
            out
        );
    }
    Ok(out)
}

/// Read any (binary) file as a `data:<mime>;base64,...` URL. Used to render images in the
/// chat (e.g. `design_board` wardrobe previews) WITHOUT the Tauri asset protocol, whose glob
/// scope rejects hidden directories like `.wardrobe/` → the `<img>` stays blank. Reusing the
/// genimage `data_url` is the fast path; this is the universal fallback (works for pre-existing
/// images, cross-session, any path inside the workspace).
fn data_url_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        _ => "application/octet-stream",
    }
}

#[tauri::command(async)]
pub fn read_file_data_url(path: String) -> Result<String, String> {
    require_inside_workspace(&path, false)?;
    let meta = std::fs::metadata(&path).map_err(|e| friendly_read_error(&path, &e))?;
    if meta.is_dir() {
        return Err(format!("'{}' is a directory, not a file.", path));
    }
    if meta.len() > 25 * 1024 * 1024 {
        return Err(format!(
            "file too large ({} bytes) for a data URL",
            meta.len()
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| friendly_read_error(&path, &e))?;
    let mime = data_url_mime(std::path::Path::new(&path));
    Ok(format!(
        "data:{};base64,{}",
        mime,
        crate::capture::b64(&bytes)
    ))
}

#[derive(Serialize)]
pub struct HexRow {
    offset: u64,
    hex: String,
    ascii: String,
}

#[derive(Serialize)]
pub struct SqlitePreview {
    page_size: u32,
    page_count: u32,
    schema_format: u32,
    text_encoding: String,
    tables: Vec<SqliteTablePreview>,
}

#[derive(Serialize)]
pub struct SqliteColumnPreview {
    name: String,
    decl_type: String,
    not_null: bool,
    primary_key: bool,
}

#[derive(Serialize)]
pub struct SqliteTablePreview {
    name: String,
    table_type: String,
    row_count: Option<i64>,
    columns: Vec<SqliteColumnPreview>,
    sample_rows: Vec<serde_json::Value>,
}

#[derive(Serialize)]
pub struct ImagePreviewInfo {
    width: u32,
    height: u32,
}

#[derive(Serialize)]
pub struct TrainedDataComponentPreview {
    type_index: usize,
    name: String,
    offset: u64,
    size: u64,
    hex_prefix: String,
    text_preview: Option<String>,
}

#[derive(Serialize)]
pub struct TrainedDataPreview {
    entry_count: usize,
    present_count: usize,
    version: Option<String>,
    components: Vec<TrainedDataComponentPreview>,
}

#[derive(Serialize)]
pub struct FileInspection {
    path: String,
    name: String,
    extension: String,
    kind: String,
    mime: String,
    size: u64,
    modified_ms: Option<u64>,
    readonly: bool,
    sampled: bool,
    signature: String,
    summary: Vec<String>,
    text_preview: Option<String>,
    hex_rows: Vec<HexRow>,
    strings: Vec<String>,
    traineddata: Option<TrainedDataPreview>,
    archive: Option<crate::archive::ArchiveListing>,
    sqlite: Option<SqlitePreview>,
    image: Option<ImagePreviewInfo>,
}

fn file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

fn read_prefix(path: &Path, len: usize) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| friendly_read_error(&path.display().to_string(), &e))?;
    let mut bytes = vec![0u8; len];
    let n = file
        .read(&mut bytes)
        .map_err(|e| friendly_read_error(&path.display().to_string(), &e))?;
    bytes.truncate(n);
    Ok(bytes)
}

fn hex_prefix(bytes: &[u8], len: usize) -> String {
    bytes
        .iter()
        .take(len)
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_hex_rows(bytes: &[u8]) -> Vec<HexRow> {
    let take = bytes.len().min(INSPECT_HEX_BYTES);
    bytes[..take]
        .chunks(16)
        .enumerate()
        .map(|(idx, chunk)| HexRow {
            offset: (idx * 16) as u64,
            hex: chunk
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" "),
            ascii: chunk
                .iter()
                .map(|&b| {
                    if (0x20..=0x7e).contains(&b) {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect(),
        })
        .collect()
}

fn clean_preview_text(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.replace('\0', "").chars() {
        if out.chars().count() >= max_chars {
            out.push('…');
            break;
        }
        if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn text_preview(bytes: &[u8]) -> Option<String> {
    let take = bytes.len().min(64 * 1024);
    let sample = &bytes[..take];
    if sample.iter().take(8000).any(|&b| b == 0) {
        return None;
    }
    let text = std::str::from_utf8(sample).ok()?;
    let cleaned = clean_preview_text(text, 5000);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn printable_preview(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let take = bytes.len().min(4096);
    let sample = &bytes[..take];
    let text = std::str::from_utf8(sample).ok()?;
    let printable = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\r' || *c == '\t')
        .count();
    let total = text.chars().count().max(1);
    if printable * 100 / total < 70 {
        return None;
    }
    let cleaned = clean_preview_text(text, 1200);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn extract_ascii_strings(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut run = Vec::new();
    let scan = &bytes[..bytes.len().min(INSPECT_STRING_SCAN_BYTES)];
    let flush = |run: &mut Vec<u8>, out: &mut Vec<String>| {
        if run.len() >= 4 {
            let text = String::from_utf8_lossy(run).trim().to_string();
            if !text.is_empty()
                && out.last().map(|prev| prev != &text).unwrap_or(true)
                && !out.contains(&text)
            {
                out.push(text.chars().take(160).collect());
            }
        }
        run.clear();
    };
    for &b in scan {
        if b == b'\t' || b == b' ' || (0x21..=0x7e).contains(&b) {
            run.push(b);
        } else {
            flush(&mut run, &mut out);
            if out.len() >= 120 {
                return out;
            }
        }
    }
    flush(&mut run, &mut out);
    out.truncate(120);
    out
}

fn read_be_u16(bytes: &[u8], start: usize) -> Option<u16> {
    let slice = bytes.get(start..start + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_be_u32(bytes: &[u8], start: usize) -> Option<u32> {
    let slice = bytes.get(start..start + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn quote_sqlite_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn sqlite_value_to_json(row: &sqlx::sqlite::SqliteRow, index: usize) -> serde_json::Value {
    use sqlx::Row;
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(index) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(index) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return v
            .map(|bytes| {
                serde_json::json!({
                    "blob_bytes": bytes.len(),
                    "preview": hex_prefix(&bytes, 16)
                })
            })
            .unwrap_or(serde_json::Value::Null);
    }
    serde_json::Value::Null
}

fn inspect_sqlite_tables(path: &Path) -> Vec<SqliteTablePreview> {
    let path = path.to_path_buf();
    // 这里原来直接 `tauri::async_runtime::block_on(...)`。
    //
    // 调用它的 `inspect_file` 标着 `#[tauri::command(async)]`，而它本身是同步函数——
    // Tauri 于是把整个命令 spawn 到 tokio 运行时上跑。在 tokio 的 worker 线程里再
    // `block_on` 另一个 future，tokio 会直接 panic（"Cannot start a runtime from within
    // a runtime"）。表现就是：双击一个 .db / .sqlite 文件，invoke 再也不返回，前端那句
    // await 永远挂着，文件预览转圈转到天荒地老，而且没有任何错误弹出来。
    //
    // 换到一个**没有环境运行时**的独立线程上跑那个 future，然后同步等它。等待期间确实
    // 占着一个 tokio worker，但 inspect_file 本来就是同步命令、读文件那部分也是这么占的；
    // 这是把「必 panic」换成「和其它同步命令一样阻塞」，方向是对的。
    std::thread::spawn(move || inspect_sqlite_tables_blocking(path))
        .join()
        .unwrap_or_default()
}

fn inspect_sqlite_tables_blocking(path: std::path::PathBuf) -> Vec<SqliteTablePreview> {
    tauri::async_runtime::block_on(async move {
        use sqlx::{Column, Connection, Row};
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true)
            .create_if_missing(false);
        let mut conn = match sqlx::SqliteConnection::connect_with(&options).await {
            Ok(conn) => conn,
            Err(_) => return Vec::new(),
        };
        let objects = match sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name LIMIT 40",
        )
        .fetch_all(&mut conn)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };

        let mut tables = Vec::new();
        for object in objects {
            let name = object.try_get::<String, _>("name").unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let table_type = object
                .try_get::<String, _>("type")
                .unwrap_or_else(|_| "table".to_string());
            let pragma_name = name.replace('\'', "''");
            let column_rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                "PRAGMA table_info('{pragma_name}')"
            )))
            .fetch_all(&mut conn)
            .await
            .unwrap_or_default();
            let columns = column_rows
                .into_iter()
                .map(|row| SqliteColumnPreview {
                    name: row.try_get::<String, _>("name").unwrap_or_default(),
                    decl_type: row.try_get::<String, _>("type").unwrap_or_default(),
                    not_null: row.try_get::<i64, _>("notnull").unwrap_or(0) != 0,
                    primary_key: row.try_get::<i64, _>("pk").unwrap_or(0) != 0,
                })
                .collect::<Vec<_>>();
            let quoted = quote_sqlite_ident(&name);
            let row_count = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) AS count FROM {quoted}"
            )))
            .fetch_one(&mut conn)
            .await
            .ok()
            .and_then(|row| row.try_get::<i64, _>("count").ok());
            let sample_rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT * FROM {quoted} LIMIT 20"
            )))
            .fetch_all(&mut conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|row| {
                let mut object = serde_json::Map::new();
                for (index, column) in row.columns().iter().enumerate().take(16) {
                    object.insert(column.name().to_string(), sqlite_value_to_json(&row, index));
                }
                serde_json::Value::Object(object)
            })
            .collect::<Vec<_>>();
            tables.push(SqliteTablePreview {
                name,
                table_type,
                row_count,
                columns,
                sample_rows,
            });
        }
        tables
    })
}

fn sqlite_preview(bytes: &[u8], path: &Path) -> Option<SqlitePreview> {
    if !bytes.starts_with(b"SQLite format 3\0") || bytes.len() < 100 {
        return None;
    }
    let raw_page_size = read_be_u16(bytes, 16)?;
    let page_size = if raw_page_size == 1 {
        65536
    } else {
        raw_page_size as u32
    };
    let page_count = read_be_u32(bytes, 28).unwrap_or(0);
    let schema_format = read_be_u32(bytes, 44).unwrap_or(0);
    let encoding = match read_be_u32(bytes, 56).unwrap_or(0) {
        1 => "UTF-8",
        2 => "UTF-16le",
        3 => "UTF-16be",
        _ => "unknown",
    }
    .to_string();
    Some(SqlitePreview {
        page_size,
        page_count,
        schema_format,
        text_encoding: encoding,
        tables: inspect_sqlite_tables(path),
    })
}

fn traineddata_component_name(index: usize) -> &'static str {
    match index {
        0 => "lang_config",
        1 => "unicharset",
        2 => "ambigs",
        3 => "inttemp",
        4 => "pffmtable",
        5 => "normproto",
        6 => "punc-dawg",
        7 => "system-dawg",
        8 => "number-dawg",
        9 => "freq-dawg",
        10 => "fixed-length-dawgs",
        11 => "cube-unicharset",
        12 => "cube-system-dawg",
        13 => "shape-table",
        14 => "bigram-dawg",
        15 => "unambig-dawg",
        16 => "params-model",
        17 => "lstm",
        18 => "lstm-punc-dawg",
        19 => "lstm-system-dawg",
        20 => "lstm-number-dawg",
        21 => "lstm-unicharset",
        22 => "lstm-recoder",
        23 => "version",
        _ => "unknown",
    }
}

fn read_le_i64(bytes: &[u8], start: usize) -> Option<i64> {
    let slice = bytes.get(start..start + 8)?;
    Some(i64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

fn inspect_traineddata(bytes: &[u8], file_size: u64) -> Option<TrainedDataPreview> {
    let count_bytes = bytes.get(0..4)?;
    let entry_count = u32::from_le_bytes([
        count_bytes[0],
        count_bytes[1],
        count_bytes[2],
        count_bytes[3],
    ]) as usize;
    if entry_count == 0 || entry_count > 128 {
        return None;
    }
    let table_len = 4usize.checked_add(entry_count.checked_mul(8)?)?;
    if bytes.len() < table_len {
        return None;
    }
    let mut present = Vec::new();
    for i in 0..entry_count {
        let offset = read_le_i64(bytes, 4 + i * 8)?;
        if offset >= table_len as i64 && (offset as u64) < file_size {
            present.push((i, offset as u64));
        } else if offset != -1 {
            return None;
        }
    }
    if present.is_empty() {
        return None;
    }
    let mut by_offset = present.clone();
    by_offset.sort_by_key(|(_, offset)| *offset);
    if by_offset.windows(2).any(|w| w[0].1 >= w[1].1) {
        return None;
    }

    let mut components = Vec::new();
    for (pos, (type_index, offset)) in by_offset.iter().enumerate() {
        let next = by_offset
            .get(pos + 1)
            .map(|(_, next_offset)| *next_offset)
            .unwrap_or(file_size);
        if next <= *offset {
            continue;
        }
        let size = next - *offset;
        let local = if (*offset as usize) < bytes.len() {
            let end = ((*offset + size).min(bytes.len() as u64)) as usize;
            &bytes[*offset as usize..end]
        } else {
            &[]
        };
        components.push(TrainedDataComponentPreview {
            type_index: *type_index,
            name: traineddata_component_name(*type_index).to_string(),
            offset: *offset,
            size,
            hex_prefix: hex_prefix(local, 24),
            text_preview: printable_preview(local),
        });
    }
    if components.is_empty() {
        return None;
    }
    components.sort_by_key(|component| component.type_index);
    let version = components
        .iter()
        .find(|component| component.type_index == 23)
        .and_then(|component| component.text_preview.clone());
    Some(TrainedDataPreview {
        entry_count,
        present_count: components.len(),
        version,
        components,
    })
}

fn detect_kind_and_mime(ext: &str, bytes: &[u8], traineddata: bool) -> (String, String) {
    if traineddata || ext == "traineddata" {
        return (
            "tesseract_traineddata".into(),
            "application/x-tesseract-traineddata".into(),
        );
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return ("image".into(), "image/png".into());
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return ("image".into(), "image/jpeg".into());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return ("image".into(), "image/gif".into());
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return ("image".into(), "image/webp".into());
    }
    if bytes.starts_with(b"%PDF-") {
        return ("pdf".into(), "application/pdf".into());
    }
    if bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
    {
        return ("archive".into(), "application/zip".into());
    }
    if bytes.starts_with(b"SQLite format 3\0") {
        return ("sqlite_database".into(), "application/vnd.sqlite3".into());
    }
    if bytes.starts_with(b"\x7FELF") {
        return ("executable".into(), "application/x-elf".into());
    }
    if bytes.starts_with(b"MZ") {
        return (
            "executable".into(),
            "application/vnd.microsoft.portable-executable".into(),
        );
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return ("archive".into(), "application/gzip".into());
    }
    if bytes.starts_with(b"7z\xBC\xAF\x27\x1C") {
        return ("archive".into(), "application/x-7z-compressed".into());
    }
    if bytes.starts_with(b"Rar!\x1A\x07") {
        return ("archive".into(), "application/vnd.rar".into());
    }
    match ext {
        "mp3" => ("audio".into(), "audio/mpeg".into()),
        "wav" => ("audio".into(), "audio/wav".into()),
        "flac" => ("audio".into(), "audio/flac".into()),
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" => ("video".into(), "video/*".into()),
        "onnx" | "pt" | "pth" | "bin" | "dat" => {
            ("model_or_binary".into(), "application/octet-stream".into())
        }
        "sqlite" | "sqlite3" | "db" | "db3" | "sdb" => {
            ("sqlite_database".into(), "application/vnd.sqlite3".into())
        }
        "duckdb" => ("database_file".into(), "application/x-duckdb".into()),
        "mdb" | "accdb" => ("database_file".into(), "application/x-msaccess".into()),
        "dbf" => ("database_file".into(), "application/x-dbf".into()),
        "ibd" | "frm" | "myd" | "myi" => {
            ("database_file".into(), "application/x-mysql-table".into())
        }
        "zip" | "jar" | "war" | "apk" | "docx" | "pptx" | "xlsx" | "odt" => {
            ("archive".into(), "application/zip".into())
        }
        _ => {
            if text_preview(bytes).is_some() {
                ("text".into(), "text/plain; charset=utf-8".into())
            } else {
                ("binary".into(), "application/octet-stream".into())
            }
        }
    }
}

#[tauri::command(async)]
pub fn inspect_file(path: String, max_bytes: Option<u64>) -> Result<FileInspection, String> {
    let resolved = require_inside_workspace(&path, false)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| friendly_read_error(&path, &e))?;
    if meta.is_dir() {
        return Err(format!("'{}' is a directory, not a file.", path));
    }

    let sample_limit = max_bytes
        .unwrap_or(INSPECT_STRING_SCAN_BYTES as u64)
        .clamp(4096, INSPECT_STRING_SCAN_BYTES as u64) as usize;
    let bytes = read_prefix(&resolved, sample_limit)?;
    let sampled = meta.len() > bytes.len() as u64 || meta.len() > INSPECT_FULL_PARSE_MAX;
    let ext = file_extension(&resolved);
    let traineddata = inspect_traineddata(&bytes, meta.len());
    let (kind, mime) = detect_kind_and_mime(&ext, &bytes, traineddata.is_some());
    // Every container format goes through one reader, which sniffs the real bytes rather than
    // trusting the extension. It is given the path, not the sampled prefix: ZIP and 7z keep their
    // index in a footer, so reading only the head of a 2 GB archive can never find it.
    let archive = if matches!(kind.as_str(), "archive")
        || matches!(
            ext.as_str(),
            "zip" | "jar" | "war" | "apk" | "aar" | "ipa" | "whl" | "egg" | "nupkg"
                | "docx" | "pptx" | "xlsx" | "odt" | "ods" | "odp" | "epub" | "crx" | "vsix"
                | "xpi" | "tar" | "tgz" | "tbz" | "tbz2" | "txz" | "tzst" | "gz" | "bz2"
                | "xz" | "zst" | "zstd" | "7z" | "rar"
        )
        || crate::archive::looks_like_compressed_tar(&resolved)
    {
        let listing = crate::archive::read_listing(&resolved);
        // Nothing found and nothing to say means it was not a container after all.
        (!listing.entries.is_empty() || listing.note.is_some()).then_some(listing)
    } else {
        None
    };
    let sqlite = sqlite_preview(&bytes, &resolved);
    let image = if kind == "image" {
        image::image_dimensions(&resolved)
            .ok()
            .map(|(width, height)| ImagePreviewInfo { width, height })
    } else {
        None
    };

    let modified_ms = meta.modified().ok().and_then(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
    });
    let mut summary = Vec::new();
    summary.push(format!("类型：{}", kind));
    summary.push(format!("大小：{} bytes", meta.len()));
    // The sample bound applies to the RAW-BYTES views — hex, strings, text preview. It says
    // nothing about an archive, whose index is read in full from the file itself however large it
    // is. Printing it beside "1652 entries" read as "and it gave up after 1 MB", which is exactly
    // backwards: those 1652 entries are the complete listing of a 2 GB archive.
    let archive_read_in_full = archive
        .as_ref()
        .is_some_and(|listing| !listing.count_is_partial && !listing.entries.is_empty());
    if sampled && !archive_read_in_full {
        summary.push(format!(
            "文件超过 {}MB，当前只解析前 {} bytes",
            INSPECT_FULL_PARSE_MAX / 1024 / 1024,
            bytes.len()
        ));
    } else if sampled {
        summary.push(format!(
            "压缩包目录已完整读取；下面的十六进制/字符串预览只取了前 {} bytes",
            bytes.len()
        ));
    }
    if let Some(info) = &traineddata {
        summary.push(format!(
            "Tesseract traineddata：{}/{} 个组件",
            info.present_count, info.entry_count
        ));
        if let Some(version) = &info.version {
            summary.push(format!("版本：{}", version));
        }
    }
    if let Some(listing) = &archive {
        // The count is the archive's, never the preview's. Saying "200 (max 200 shown)" for an
        // archive of fifty thousand files is the bug this whole path was rewritten for.
        let approx = if listing.count_is_partial { "至少 " } else { "" };
        summary.push(format!(
            "{} 压缩包：{}{} 个条目",
            listing.format, approx, listing.total
        ));
        if listing.truncated && !listing.entries.is_empty() {
            summary.push(format!("列表只显示前 {} 个", listing.entries.len()));
        }
        if listing.total_size > 0 {
            summary.push(format!("解压后共 {} bytes", listing.total_size));
        }
        if listing.metadata_entries > 0 {
            summary.push(format!(
                "另有 {} 个 macOS 扩展属性附属条目（._* / __MACOSX），未计入上面的数量",
                listing.metadata_entries
            ));
        }
        if listing.encrypted {
            summary.push("包含加密条目：文件名可读，内容需要密码".into());
        }
        if let Some(note) = &listing.note {
            summary.push(note.clone());
        }
    }
    if let Some(sqlite) = &sqlite {
        summary.push(format!(
            "SQLite：{} 页 × {} bytes，编码 {}",
            sqlite.page_count, sqlite.page_size, sqlite.text_encoding
        ));
    }
    if let Some(image) = &image {
        summary.push(format!("图片尺寸：{} × {}", image.width, image.height));
    }

    Ok(FileInspection {
        path,
        name: file_name(&resolved),
        extension: ext,
        kind,
        mime,
        size: meta.len(),
        modified_ms,
        readonly: meta.permissions().readonly(),
        sampled,
        signature: hex_prefix(&bytes, 32),
        summary,
        text_preview: text_preview(&bytes),
        hex_rows: build_hex_rows(&bytes),
        strings: extract_ascii_strings(&bytes),
        traineddata,
        archive,
        sqlite,
        image,
    })
}

/// Extract readable TEXT from a document (PDF / Word / Excel / PowerPoint), so the agent
/// can read specs / papers / manuals that `read_text_file` would otherwise return as
/// binary garbage. Office formats are ZIP+XML (reuses the existing `zip` dep); PDF uses
/// `pdf-extract` (pure Rust). The agent's read_file routes here automatically by extension.
#[tauri::command(async)]
pub fn read_document(path: String) -> Result<String, String> {
    require_inside_workspace(&path, false)?;
    let meta = std::fs::metadata(&path).map_err(|e| friendly_read_error(&path, &e))?;
    if meta.is_dir() {
        return Err(format!("'{}' is a directory", path));
    }
    if meta.len() > 50 * 1024 * 1024 {
        return Err("文档过大（>50MB），无法解析".into());
    }
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let text = match ext.as_str() {
        "pdf" => pdf_extract::extract_text(&path).map_err(|e| format!("PDF 解析失败: {e}"))?,
        "docx" | "odt" => extract_office(&path, |n| n == "word/document.xml" || n == "content.xml")?,
        "pptx" => extract_office(&path, |n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))?,
        // 只抽 sharedStrings 是**去重后的字符串池**：没有行列、没有 sheet 名，而且数值单元格
        // 根本不在这个文件里（数字存在 worksheet XML 的 <v> 里）。纯数字表抽出来是空的。
        // 把 worksheet 一起抽出来，至少单元格引用和数值在场，模型能对上号；结构化读取仍然
        // 要靠 run_cmd + python，下面的抬头会说明这一点。
        "xlsx" => {
            let text = extract_office(&path, |n| {
                n == "xl/sharedStrings.xml"
                    || (n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml"))
            })?;
            format!(
                "【注意：这是 Excel 的**文本层抽取**，不是结构化表格】共享字符串与单元格内容\
                 被拼在一起，行列关系、sheet 名、公式与格式都不在其中，数值与文本的对应关系\
                 需要自行对照单元格引用。要按行列读真实数据，用 run_cmd 跑 python\
                 （openpyxl / pandas.read_excel），不要凭下面的文本推断表结构。\n\n{text}"
            )
        }
        other => {
            return Err(format!(
                "read_document 不支持 .{other}（支持 pdf/docx/pptx/xlsx/odt）；普通文本文件用 read_file 即可"
            ))
        }
    };
    let t = text.trim();
    if t.is_empty() {
        return Err(
            "没从文档里提取到文本（可能是扫描件/纯图片 PDF——需要 OCR，本工具只读文本层）".into(),
        );
    }
    Ok(t.to_string())
}

/// Pull the text out of the ZIP entries an Office doc keeps its content in.
fn extract_office(path: &str, want: impl Fn(&str) -> bool) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 Office 文档(zip): {e}"))?;
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let mut out: Vec<String> = Vec::new();
    for name in names {
        if want(&name) {
            if let Ok(mut f) = zip.by_name(&name) {
                let mut xml = String::new();
                if f.read_to_string(&mut xml).is_ok() {
                    out.push(strip_xml(&xml));
                }
            }
        }
    }
    Ok(out.join("\n"))
}

/// Turn an Office XML part into plain text: paragraph/row/break tags → newlines, strip the
/// rest of the tags, decode the common entities, collapse blank-line runs.
fn strip_xml(xml: &str) -> String {
    let mut s = xml.to_string();
    for tag in [
        "</w:p>",
        "</a:p>",
        "</text:p>",
        "</si>",
        "</row>",
        "<w:br/>",
        "<w:br></w:br>",
    ] {
        s = s.replace(tag, "\n");
    }
    s = s.replace("<w:tab/>", "\t");
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // docx / xlsx 的正文。同样两个老毛病：数字实体只认 &#10;，别的（&#8217; 这类
    // 智能引号在 Word 文档里满地都是）原样漏给模型；顺序 replace 还会把真实存在的
    // `&amp;lt;` 二次解码成 `<`。统一走 ai.rs 那份一趟扫完的解码器。
    let out = crate::ai::decode_html_entities(&out);
    let mut res = String::new();
    let mut blank = 0;
    for l in out.lines().map(|l| l.trim_end()) {
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        res.push_str(l);
        res.push('\n');
    }
    res
}

/// Overwrite a file with new text content.
#[tauri::command(async)]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = require_inside_workspace(&path, true)?;
    atomic_write_text(&resolved, &content)
}

/// Write only if the file still has the exact version the caller read. `None`
/// means the caller observed no file and therefore uses a filesystem-level
/// atomic no-clobber create. Existing-file compare-and-replace is serialized
/// across IDE writers by FILE_MUTATION_LOCK; external processes do not share
/// that lock and can still race in the small interval after the comparison.
#[tauri::command(async)]
pub fn write_text_file_if_unchanged(
    path: String,
    expected_content: Option<String>,
    content: String,
) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = require_inside_workspace(&path, true)?;
    match expected_content {
        Some(expected) => {
            if !resolved.exists() {
                return Err("[CONFLICT] file was deleted after it was read".into());
            }
            let current = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
            if current != expected {
                return Err("[CONFLICT] file changed after it was read".into());
            }
            atomic_write_text(&resolved, &content)
        }
        None => atomic_create_text(&resolved, &content),
    }
}

/// sha256 → 小写 hex。
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `write_text_file_if_unchanged` 的省流量版本：调用方只送**它读到的那一版的 sha256**，
/// 不送那一版的全文。返回刚写下去那份内容的 sha256。
///
/// 为什么要有它：编辑器自动保存原本一次 invoke 要带「磁盘旧全文 + 新全文」两份原文，
/// 5MB 的文件就是 ~8.6MB JSON（还要按 JSON 规则逐字转义再解析），序列化本身比写盘还贵，
/// 大文件里连续打字时肉眼可见地卡。
///
/// 为什么不用 mtime/size 这种更省事的判据：原子写是「同目录暂存 + rename」，inode 会换、
/// mtime 粒度只到秒，同秒内的外部改动会整个漏掉——CAS 的全部价值就在于不漏。
///
/// 老命令 `write_text_file_if_unchanged` 原样保留，判据语义和错误串（`[CONFLICT] …`）与
/// 这里逐字一致：没更新的调用方（远程守护进程、网页壳、旧的前端 bundle）继续走老命令，
/// 不会因为多出这个命令而失败，也不需要同步升级。
#[tauri::command(async)]
pub fn write_text_file_if_unchanged_hashed(
    path: String,
    expected_sha256: Option<String>,
    content: String,
) -> Result<String, String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = require_inside_workspace(&path, true)?;
    match expected_sha256 {
        Some(expected) => {
            if !resolved.exists() {
                return Err("[CONFLICT] file was deleted after it was read".into());
            }
            // 仍然走 read_to_string 而不是按字节 read：老命令比的是 read_to_string 的结果，
            // 非 UTF-8 文件在那条路上是**报错**而不是「内容不等」。改成字节读会把这类文件
            // 从「报错」悄悄变成「CAS 通过并覆盖」，那是行为回退，不是优化。
            let current = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
            if !sha256_hex(current.as_bytes()).eq_ignore_ascii_case(expected.trim()) {
                return Err("[CONFLICT] file changed after it was read".into());
            }
            atomic_write_text(&resolved, &content)?;
        }
        None => atomic_create_text(&resolved, &content)?,
    }
    Ok(sha256_hex(content.as_bytes()))
}

/// Delete a text file only if it still contains the version the caller last
/// wrote. This is the deletion counterpart to `write_text_file_if_unchanged`
/// and keeps Undo/revert from removing a newer IDE edit. External processes do
/// not share FILE_MUTATION_LOCK and can still race after the content comparison.
#[tauri::command(async)]
pub fn delete_text_file_if_unchanged(path: String, expected_content: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = require_inside_workspace(&path, true)?;
    let meta = std::fs::symlink_metadata(&resolved).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("[CONFLICT] path is no longer the expected text file".into());
    }
    let current = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
    if current != expected_content {
        return Err("[CONFLICT] file changed after it was written".into());
    }
    std::fs::remove_file(resolved).map_err(|e| e.to_string())
}

/// 往系统临时目录写一个文件（内部工具用，不受工作区限制）。
///
/// 这里以前写死 `/tmp`。Windows 上那个路径会被解析成**当前盘根目录下的 `\tmp`**，默认
/// 根本不存在，于是 `fs::write` 直接失败——依赖它的功能（HTML/CSS 实时预览的临时
/// dev server 脚本等）在 Windows 上一律起不来。`std::env::temp_dir()` 两个平台都对。
#[tauri::command(async)]
pub fn write_tmp_file(name: String, content: String) -> Result<String, String> {
    // 只取文件名，去掉任何目录成分——`../etc/x` 这种逃不出临时目录。
    let safe = Path::new(&name)
        .file_name()
        .ok_or("invalid temp file name")?;
    let dir = std::env::temp_dir();
    // 临时目录理论上一定在，但 Windows 上 TEMP 指向一个已被删掉的目录并不罕见。
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(safe);
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tmp_file_tests {
    /// `/tmp` 在 Windows 上被解析成**当前盘根目录下的 `\tmp`**，默认根本不存在，
    /// 于是写入直接失败——依赖它的功能（HTML/CSS 实时预览的临时脚本等）一律起不来。
    #[test]
    /// Windows 的 temp_dir() **带尾部反斜杠**，前缀比对必须先把它去掉。
    ///
    /// 这两个函数**故意不带 cfg**，所以 mac 上也编译、也被这条测试跑到 —— 否则这个
    /// 判据只能等到有人在 Windows 上跑测试时才发现，而 Rust 测试从没在 Windows 上
    /// 跑通过一次（正是这个 bug 让 the_systems_own_temp_dir_is_always_writable 在
    /// Windows 上是红的）。
    #[test]
    fn a_windows_prefix_with_a_trailing_separator_still_matches() {
        // temp_dir() 的真实形状：结尾带一个反斜杠。
        let tmp = r"C:\Users\me\AppData\Local\Temp\";
        assert!(
            super::windows_starts_with_prefix(r"C:\Users\me\AppData\Local\Temp\build\a.txt", tmp),
            "带尾部分隔符的前缀匹配不上 —— 临时目录豁免在 Windows 上会恒假"
        );
        assert!(super::windows_starts_with_prefix(r"C:\Users\me\AppData\Local\Temp", tmp));
        // 不许因为去尾巴而放宽成「前缀字符串包含」：Temp2 不在 Temp 底下。
        assert!(!super::windows_starts_with_prefix(r"C:\Users\me\AppData\Local\Temp2\a.txt", tmp));
        // 盘符根整个 trim 会变成 `c:`，那反而匹配不上，保底分支守着它。
        assert!(super::windows_starts_with_prefix(r"C:\proj\a.txt", r"C:\"));
        // verbatim 前缀和正斜杠仍然照常归一。
        assert!(super::windows_starts_with_prefix(r"\\?\C:\Users\me\proj\a.txt", "C:/Users/me/proj"));
    }

    fn a_temp_file_lands_in_the_systems_temp_dir_not_a_hardcoded_slash_tmp() {
        let name = format!("michael-tmp-probe-{}.txt", std::process::id());
        let written = super::write_tmp_file(name.clone(), "x".into()).expect("写临时文件");
        let path = std::path::Path::new(&written);
        assert!(path.is_file(), "没写出来：{written}");
        assert!(
            path.starts_with(std::env::temp_dir()),
            "临时文件没落在系统临时目录里：{written}",
        );
        // 目录成分要被剥掉，`../` 逃不出去。
        let escaped = super::write_tmp_file("../escaped.txt".into(), "x".into()).expect("写");
        assert!(std::path::Path::new(&escaped).starts_with(std::env::temp_dir()), "{escaped}");
        let _ = std::fs::remove_file(&written);
        let _ = std::fs::remove_file(&escaped);
    }
}

/// The current user's home directory, used as the default tree root.
#[tauri::command]
pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}

/// Create a new empty file. Errors if anything already exists at `path`.
#[tauri::command(async)]
pub fn create_file(path: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let resolved = require_inside_workspace(&path, true)?;
    atomic_create_text(&resolved, "")
}

/// Create a new directory (including any missing parents).
#[tauri::command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    require_inside_workspace(&path, true)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    std::fs::create_dir_all(p).map_err(|e| friendly_write_error("创建目录", &path, &e))
}

/// Rename or move a file/folder. Errors if the destination already exists.
#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    require_inside_workspace(&from, true)?;
    require_inside_workspace(&to, true)?;
    let to_p = Path::new(&to);
    if to_p.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| friendly_write_error("创建目录", &to, &e))?;
    }
    std::fs::rename(&from, &to).map_err(|e| friendly_write_error("重命名", &from, &e))
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else if ft.is_file() {
            std::fs::copy(entry.path(), &dest)?;
        }
        // symlinks / special files are skipped for safety
    }
    Ok(())
}

/// 拖放专用：只回「这个路径是什么」，不列内容、不回名字。
///
/// 为什么要单开一个：判断「拖进来的是文件还是文件夹」原本借的是 `read_dir`，那有两个毛病——
///   ① `read_dir` 要求路径在工作区内，而用户从 Finder 拖进来的东西按定义就在外面
///      （/Volumes 上的挂载盘、/Applications），于是**文件夹一律被误判成文件**；
///   ② `read_dir` 会把整个目录枚举一遍（还带 gitignore 标注），拿它当类型探针，
///      拖一个大文件夹进来光探测就要好几秒 —— 用户报的「松手卡顿几秒」就是这个。
/// 这里只做一次 stat，O(1)，且只吐一个类型码，不泄漏目录内容。
///
/// 返回值与 paths 一一对应：0 = 不存在 / 读不到，1 = 文件，2 = 目录。
#[tauri::command(async)]
pub fn path_kinds(paths: Vec<String>) -> Vec<u8> {
    paths
        .iter()
        .take(512)
        .map(|p| match std::fs::metadata(p) {
            Ok(m) if m.is_dir() => 2u8,
            Ok(_) => 1u8,
            Err(_) => 0u8,
        })
        .collect()
}

/// 把工作区**外面**的文件/目录复制进工作区（拖放导入专用）。
///
/// 和 `copy_path` 的唯一区别是**不要求源在工作区内**：用户从 Finder 把东西拖进窗口，
/// 这个动作本身就是授权，正如任何文件管理器。写入侧的边界一点没松——`to` 仍然必须落在
/// 已打开的工作区根里，复制策略、重名报错、递归拷贝全部复用 `copy_path`。
///
/// 注意：这个命令只给拖放落地用，没有接进任何智能体工具；智能体那条路仍然走 `copy_path`，
/// 两端都受工作区约束。
#[tauri::command(async)]
pub fn import_path(from: String, to: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let to_path = require_inside_workspace(&to, true)?;
    let from_p = Path::new(&from);
    if !from_p.exists() {
        return Err("source does not exist".into());
    }
    if to_path.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| friendly_write_error("创建目录", &to, &e))?;
    }
    let meta = std::fs::symlink_metadata(from_p)
        .map_err(|e| friendly_write_error("读取源文件", &from, &e))?;
    if meta.is_dir() {
        copy_dir_recursive(from_p, &to_path)
            .map_err(|e| friendly_write_error("复制目录", &from, &e))
    } else {
        std::fs::copy(from_p, &to_path)
            .map(|_| ())
            .map_err(|e| friendly_write_error("复制文件", &from, &e))
    }
}

/// Copy a file, or a directory and all of its contents, to `to`. Errors if the
/// destination already exists. Both endpoints must be inside the workspace.
#[tauri::command(async)]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    require_inside_workspace(&from, false)?;
    let to_path = require_inside_workspace(&to, true)?;
    let from_p = Path::new(&from);
    if !from_p.exists() {
        return Err("source does not exist".into());
    }
    if to_path.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| friendly_write_error("创建目录", &to, &e))?;
    }
    let meta = std::fs::symlink_metadata(from_p)
        .map_err(|e| friendly_write_error("读取源文件", &from, &e))?;
    if meta.is_dir() {
        copy_dir_recursive(from_p, &to_path)
            .map_err(|e| friendly_write_error("复制目录", &from, &e))
    } else {
        std::fs::copy(from_p, &to_path)
            .map(|_| ())
            .map_err(|e| friendly_write_error("复制文件", &from, &e))
    }
}

/// Delete a file, or a directory and all of its contents.
#[tauri::command(async)]
pub fn delete_path(path: String) -> Result<(), String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    require_inside_workspace(&path, true)?;
    let p = Path::new(&path);
    let meta = std::fs::symlink_metadata(p).map_err(|e| friendly_write_error("删除", &path, &e))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| friendly_write_error("删除目录", &path, &e))
    } else {
        std::fs::remove_file(p).map_err(|e| friendly_write_error("删除文件", &path, &e))
    }
}

/// A single matching location within a file.
#[derive(Serialize)]
pub struct SearchMatch {
    /// 1-based line number.
    line: usize,
    /// 1-based column (in characters) of the match start.
    column: usize,
    /// The (possibly truncated) text of the matching line.
    text: String,
    /// Character offset of the match start within `text`.
    start: usize,
    /// Character offset of the match end within `text`.
    end: usize,
}

/// All matches found within a single file.
#[derive(Serialize)]
pub struct FileMatches {
    path: String,
    name: String,
    /// Path relative to the search root, for compact display.
    rel: String,
    matches: Vec<SearchMatch>,
}

fn build_search_matcher(
    query: &str,
    case_sensitive: bool,
    mode: Option<&str>,
) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("[INVALID_SEARCH_QUERY] search query cannot be empty".into());
    }

    let pattern = match mode
        .unwrap_or("literal")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "literal" => regex::escape(query),
        "regex" => query.to_string(),
        other => {
            return Err(format!(
                "[INVALID_SEARCH_MODE] unsupported search mode '{other}'; expected 'literal' or 'regex'"
            ));
        }
    };

    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("[INVALID_SEARCH_PATTERN] invalid regex: {error}"))
}

fn find_matches_in_line<'a>(
    line: &'a str,
    matcher: &'a Regex,
) -> impl Iterator<Item = (usize, usize, usize)> + 'a {
    matcher.find_iter(line).map(|matched| {
        let start = line[..matched.start()].chars().count();
        let end = line[..matched.end()].chars().count();
        (start, start, end)
    })
}

struct ProjectSearch {
    files: Vec<FileMatches>,
    scanned_files: usize,
    /// 这次搜索是不是**没搜完**就被上限截断了。
    ///
    /// 遍历会在 `SEARCH_MAX_RESULTS`(2000) 或 `SEARCH_MAX_SCANNED_FILES`(20000) 处 break。
    /// 在这之前这个事实没有任何出口——调用方拿到的和"整个仓库就这些命中"长得一模一样。
    /// 于是在大仓里搜一个符号、扫到第两万个文件就停，界面照常显示「N 个结果」，
    /// 开发者据此得出"项目里没有这个"的**错误结论**。搜索给出假阴性比搜索慢严重得多。
    truncated: bool,
    /// 因为**体积**被跳过的文件数（> SEARCH_MAX_FILE，2 MiB）。
    ///
    /// 和 `truncated` 完全同一性质的第二种假阴性，而且更隐蔽：它不是"没搜完"，
    /// 是"这几个文件从头到尾没被看过"，而调用方拿到的结果和"这些文件里确实没有"
    /// 长得一模一样。本仓库自己的 src/main.js 就是 4.9 MB —— 在这个项目里搜任何东西，
    /// 主文件永远搜不到，而且没有任何提示。跳过是对的（2 MiB 以上多半是压缩产物、
    /// 锁文件、数据），但**跳过了就得说**。
    size_skipped: usize,
}

fn search_project_scope(
    root: &str,
    query: &str,
    case_sensitive: bool,
    mode: Option<&str>,
) -> Result<ProjectSearch, String> {
    let matcher = build_search_matcher(query, case_sensitive, mode)?;

    // Keep the search confined to a registered workspace root and validate the
    // resolved scope before traversal. `read_dir` on a file and `os.walk` on a
    // missing path previously looked exactly like a legitimate no-match result.
    let root_path = require_inside_workspace(root, false)?;
    let root_meta = std::fs::symlink_metadata(&root_path).map_err(|error| {
        format!(
            "[INVALID_SEARCH_SCOPE] cannot inspect search scope '{}': {error}",
            root_path.display()
        )
    })?;
    if !root_meta.is_dir() && !root_meta.is_file() {
        return Err(format!(
            "[INVALID_SEARCH_SCOPE] search scope '{}' is neither a file nor a directory",
            root_path.display()
        ));
    }

    let root_is_file = root_meta.is_file();
    let relative_base = if root_is_file {
        root_path.parent().unwrap_or(&root_path)
    } else {
        &root_path
    };
    let mut results: Vec<FileMatches> = Vec::new();
    let mut total = 0usize;
    let mut scanned_files = 0usize;
    let mut size_skipped = 0usize;
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root_path.clone()];

    while let Some(path) = stack.pop() {
        if total >= SEARCH_MAX_RESULTS || scanned_files >= SEARCH_MAX_SCANNED_FILES {
            // 提前收工 = 结果不完整。记下来，别让它和"搜完了，就这些"长一个样。
            // `stack` 里还剩东西也算——那些目录一个字节都没读过。
            truncated = true;
            break;
        }

        let md = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if md.file_type().is_symlink() {
            continue;
        }
        if md.is_dir() {
            if path != root_path
                && path
                    .file_name()
                    .is_some_and(|name| IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()))
            {
                continue;
            }
            let rd = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            let mut children: Vec<PathBuf> = rd.flatten().map(|entry| entry.path()).collect();
            children.sort_by(|a, b| b.cmp(a));
            for child in children {
                let Some(name) = child.file_name().map(|name| name.to_string_lossy()) else {
                    continue;
                };
                if skip_walk_entry(name.as_ref(), child.is_dir()) {
                    continue;
                }
                stack.push(child);
            }
            continue;
        }
        if !md.is_file() {
            continue;
        }
        if md.len() > SEARCH_MAX_FILE {
            // 跳过是对的，但要记一笔：调用方必须能分清「这些文件里没有」和「这些文件没看过」。
            size_skipped += 1;
            continue;
        }

        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.iter().take(8000).any(|&byte| byte == 0) {
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => continue,
        };
        scanned_files += 1;

        let mut file_matches: Vec<SearchMatch> = Vec::new();
        for (line_index, line) in content.lines().enumerate() {
            if file_matches.len() >= SEARCH_MAX_PER_FILE || total >= SEARCH_MAX_RESULTS {
                // 这个文件（或整次搜索）的命中没列全。只在 while 循环顶部标记是不够的：
                // 那里只有「还有下一个目录要弹栈」时才会被执行，而命中上限最常见的触发点
                // 恰恰在文件**内部**——单文件命中爆表、或者刚好在栈空时触顶，两种情况
                // 都会绕过顶部那道判断，于是又变回"谎称搜完了"。
                truncated = true;
                break;
            }
            let mut hits = find_matches_in_line(line, &matcher).peekable();
            if hits.peek().is_none() {
                continue;
            }
            let display = if line.chars().count() > SEARCH_MAX_LINE_CHARS {
                let mut truncated: String = line.chars().take(SEARCH_MAX_LINE_CHARS).collect();
                truncated.push('\u{2026}');
                truncated
            } else {
                line.to_string()
            };
            for (column, start, end) in hits {
                if file_matches.len() >= SEARCH_MAX_PER_FILE || total >= SEARCH_MAX_RESULTS {
                    truncated = true;
                    break;
                }
                file_matches.push(SearchMatch {
                    line: line_index + 1,
                    column: column + 1,
                    text: display.clone(),
                    start,
                    end,
                });
                total += 1;
            }
        }

        if !file_matches.is_empty() {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel = path
                .strip_prefix(relative_base)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            results.push(FileMatches {
                path: strip_verbatim(&path.to_string_lossy()),
                name,
                rel,
                matches: file_matches,
            });
        }
    }

    if scanned_files == 0 {
        return Err(format!(
            "[NO_SEARCHABLE_FILES] search scope '{}' contained no readable UTF-8 text files",
            root_path.display()
        ));
    }

    // Rank most-relevant files first: more matches = more likely what the caller
    // wants, alphabetical rel path as a stable tiebreaker. (Was pure alphabetical,
    // which buried a 30-hit file below an incidental 1-hit one.)
    results.sort_by(|a, b| {
        b.matches
            .len()
            .cmp(&a.matches.len())
            .then_with(|| a.rel.cmp(&b.rel))
    });
    Ok(ProjectSearch {
        files: results,
        scanned_files,
        truncated,
        size_skipped,
    })
}

/// Search one file, or recursively search a directory, for `query`.
///
/// `mode` defaults to literal matching for compatibility and accepts `regex`
/// explicitly. Dot-entries, common build/dependency directories, oversized
/// files, and binary files are skipped. Results and traversal are bounded.
#[tauri::command(async)]
pub fn search_in_project(
    root: String,
    query: String,
    case_sensitive: bool,
    mode: Option<String>,
) -> Result<SearchResponse, String> {
    let search = search_project_scope(&root, &query, case_sensitive, mode.as_deref())?;
    debug_assert!(search.scanned_files > 0);
    Ok(SearchResponse {
        files: search.files,
        scanned_files: search.scanned_files,
        truncated: search.truncated,
        size_skipped: search.size_skipped,
    })
}

/// `search_in_project` 的返回值。
///
/// 以前直接返回 `Vec<FileMatches>`，于是「搜完了」和「扫到两万个文件就不搜了」在调用方
/// 眼里**完全一样**——大仓里搜一个真实存在的符号，可能返回 0 命中，而界面照常显示
/// 「没有结果」。那不是慢，那是**假阴性**，开发者会据此得出"项目里没有这个"的错误判断。
///
/// 前端包装函数会把 `files` 摊回数组（数组也是对象，truncated 挂在上面），
/// 所以既有调用方一行都不用改。
#[derive(Serialize)]
pub struct SearchResponse {
    files: Vec<FileMatches>,
    scanned_files: usize,
    truncated: bool,
    /// 因为体积（> 2 MiB）被整份跳过的文件数。和 truncated 同一性质的假阴性，
    /// 前端会把它拼进给模型的搜索结果里 —— 跳过了就得说。
    size_skipped: usize,
}

#[derive(Serialize)]
pub struct ReplaceResult {
    files_changed: usize,
    replacements: usize,
}

/// If the case-insensitive lowercasing of a leading run of chars in `s` equals
/// `needle_lower` exactly (ending on a char boundary of `s`), return how many
/// bytes of `s` that run occupies; otherwise `None`. `needle_lower` must already
/// be lowercased and non-empty. Operating on the original `s` keeps the returned
/// length a valid byte offset into `s` even when case folding changes length.
fn ci_prefix_len(s: &str, needle_lower: &str) -> Option<usize> {
    if needle_lower.is_empty() {
        return None;
    }
    let mut lowered = String::new();
    for (off, ch) in s.char_indices() {
        for lc in ch.to_lowercase() {
            lowered.push(lc);
        }
        if lowered.len() >= needle_lower.len() {
            // Accept only an exact match ending on this char boundary. If the last
            // char's lowercase expansion overshot the needle, reject — advancing
            // by a partial char would not be byte-accurate.
            return if lowered == needle_lower {
                Some(off + ch.len_utf8())
            } else {
                None
            };
        }
        // Bail early once the lowercased prefix can no longer lead to the needle.
        if !needle_lower.starts_with(&lowered) {
            return None;
        }
    }
    None
}

/// Replace all occurrences of `query` with `replacement` in `file_path`.
/// Returns the number of replacements made.
#[tauri::command(async)]
pub fn replace_in_file(
    file_path: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<usize, String> {
    let _guard = FILE_MUTATION_LOCK.lock().map_err(|e| e.to_string())?;
    // Same workspace boundary every other mutating fs command enforces — without
    // it this is an arbitrary-file-write primitive.
    let resolved = require_inside_workspace(&file_path, true)?;
    let file_path = resolved.to_string_lossy().to_string();
    let metadata = std::fs::metadata(&file_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE {
        return Err("file is too large to replace (> 5 MB)".into());
    }
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("cannot replace in binary files".into());
    }
    // 只在能**无损**表示这份内容时才动它。
    //
    // 这里原来是 `String::from_utf8_lossy(&bytes).to_string()`。上面那道二进制闸门只在
    // 前 8000 字节里找 NUL，而 GBK / Big5 / Latin-1 的正文一个 NUL 都没有，照样过闸；
    // 接着 from_utf8_lossy 把每一段非法多字节序列换成 U+FFFD，而下面 `count > 0` 时写回去
    // 的是**整个缓冲区**。于是替掉一个 ASCII 词的代价是整份中文/带重音的正文变成一串 �，
    // 工具还回报「替换成功 N 处」。replace_in_project 会拿整棵树逐个文件调这里，
    // 所以工作区里只要有一个 GBK 源文件就够。
    //
    // read_text_file（本文件里 `file is not valid UTF-8 text` 那处）早就立了同一条契约：
    // 读不懂的编码宁可拒绝，也不静默转码。这里跟上——**能读的才准写**。
    // 对 replace_in_project 的影响是「跳过这个文件」而不是中断整轮扫描：那边对 Err
    // 的分支是 `_ => {}`。少替一处远好过毁掉一整个文件。
    let content = String::from_utf8(bytes).map_err(|_| {
        format!("cannot replace in '{file_path}': file is not valid UTF-8 text")
    })?;
    let (new_content, count) = if case_sensitive {
        let c = content.matches(&query).count();
        (content.replace(&query, &replacement), c)
    } else {
        // Case-insensitive literal replace. Match positions MUST be byte offsets
        // into the original `content`, never into its lowercased copy: a path like
        // 'İ' lowercases to two chars, so offsets taken from the lowercased string
        // would land mid-char in the original — corrupting output and panicking on
        // a non-char-boundary slice. Walk the original by char boundary instead.
        let needle = query.to_lowercase();
        let mut result = String::with_capacity(content.len());
        let mut found = 0usize;
        let mut i = 0usize;
        while i < content.len() {
            match ci_prefix_len(&content[i..], &needle) {
                Some(consumed) if consumed > 0 => {
                    result.push_str(&replacement);
                    i += consumed;
                    found += 1;
                }
                _ => {
                    // Not a match here — copy one whole char and advance.
                    let ch_len = content[i..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(1);
                    result.push_str(&content[i..i + ch_len]);
                    i += ch_len;
                }
            }
        }
        (result, found)
    };
    if count > 0 {
        // 走原子写，不用 std::fs::write。后者是 O_TRUNC：先把原文件清零，再流式写入新内容；
        // 中间被杀 / 断电 / 磁盘写满，用户的源文件就停在截断或全空的状态，原内容没处找。
        // atomic_write_text（本文件里那个"staged temp + fsync + rename"）的文档注释写得
        // 很清楚，它存在就是为了让"写到一半"永远不可见——工作区里别的写路径
        // （write_text_file / write_text_file_if_unchanged / create_file）全走它，
        // 只有这里绕开了，而 replace_in_project 一轮能重写上百个文件，正是窗口最大的那条。
        //
        // `resolved` 是 require_inside_workspace 规范化后的路径（软链已经解开），
        // 所以 rename 替换的就是 std::fs::write 会写到的那个真实 inode，落点没变。
        //
        // 但**权限语义确实变了**，写在这儿免得下一个人把它当成新 bug：
        // `std::fs::write` 要的是**文件**的写权限，rename 要的是**目录**的写权限。
        // 实测（macOS，普通用户）：对一个 0o444 的文件直接写 → EACCES；把临时文件
        // rename 到同一个 0o444 目标上 → 成功，且目标仍是 0o444（atomic_write_text 先把
        // 原文件的权限抄到临时文件上再换）。所以只读文件从"替换失败"变成了"替换成功、
        // 权限不变"，replace_in_project 那边也从静默跳过（对 Err 的分支是 `_ => {}`，
        // 既不计数也不报错）变成计进 files_changed / replacements。
        //
        // 这是**对齐**，不是放宽：write_text_file / write_text_file_if_unchanged /
        // create_file 一直就是这个语义——在编辑器里打开同一个 0o444 文件按保存本来就成功，
        // 只有查找替换会失败。「能编辑却替换不了」才是说不通的那一半。
        // 真正锁死的树照样失败：临时文件是在**同一个目录**里 create_new 出来的，
        // 目录不可写就在暂存那一步报错，一个字节都不会动。
        // 另一处代价：rename 换的是 inode，指向老 inode 的硬链接不会跟着变（这一条
        // 同样是本模块所有写路径的既有行为）。
        atomic_write_text(&resolved, &new_content)?;
    }
    Ok(count)
}

/// Replace all occurrences of `query` with `replacement` across the project.
#[tauri::command(async)]
pub fn replace_in_project(
    root: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Ok(ReplaceResult {
            files_changed: 0,
            replacements: 0,
        });
    }
    // Confine the whole sweep to the workspace (each write is also guarded by
    // replace_in_file, but this stops us from even scanning arbitrary trees).
    let root_path = require_inside_workspace(&root, true)?;
    let mut files_changed = 0usize;
    let mut replacements = 0usize;
    let mut stack: Vec<PathBuf> = vec![root_path];

    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut children: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        children.sort();
        for path in children {
            let name = match path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            let is_dir = path.is_dir();
            if skip_walk_entry(&name, is_dir) {
                continue;
            }
            if is_dir {
                stack.push(path);
                continue;
            }
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > SEARCH_MAX_FILE {
                continue;
            }
            let path_str = path.to_string_lossy().to_string();
            match replace_in_file(path_str, query.clone(), replacement.clone(), case_sensitive) {
                Ok(c) if c > 0 => {
                    files_changed += 1;
                    replacements += c;
                }
                _ => {}
            }
        }
    }

    Ok(ReplaceResult {
        files_changed,
        replacements,
    })
}

#[cfg(test)]
mod replace_in_file_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mrday-replace-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// GBK 正文 `中文` = D6 D0 CE C4：**没有 NUL**，所以 8000 字节查 NUL 的二进制闸门放它过。
    /// 从这里往下就是那个 bug 的全部条件。
    fn gbk_line() -> Vec<u8> {
        let mut v = b"// TODO_TOKEN ".to_vec();
        v.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]); // “中文”，GBK
        v.push(b'\n');
        v
    }

    /// 一次替换不该把整个文件重新编码。
    ///
    /// 事故形状：工作区里有一份 GBK 的 .po / .csv / 老源码（中文用户很常见）。模型替一个
    /// 纯 ASCII 的词，from_utf8_lossy 把每个 GBK 汉字变成 U+FFFD，而 count>0 时**整份**
    /// 缓冲区被写回去——那个词是替掉了，全文的中文一起变成 ���，工具还报"成功替换 1 处"。
    /// 现在按 read_text_file 的同一条契约办：读不懂就拒绝，一个字节都不许动。
    #[test]
    fn a_non_utf8_file_is_refused_instead_of_being_rewritten_as_replacement_chars() {
        let dir = scratch("gbk");
        let f = dir.join("legacy.po");
        let original = gbk_line();
        std::fs::write(&f, &original).unwrap();

        let err = replace_in_file(
            f.to_string_lossy().to_string(),
            "TODO_TOKEN".into(),
            "DONE".into(),
            true,
        )
        .expect_err("非 UTF-8 的文件必须被拒绝，而不是顺手转码写回去");
        assert!(
            err.contains("not valid UTF-8"),
            "拒绝的理由要说清是编码问题（和 read_text_file 同一口径）：{err}"
        );

        // 关键的一条：磁盘上的字节要**一个都没变**。
        assert_eq!(
            std::fs::read(&f).unwrap(),
            original,
            "文件被改写了 —— 那 4 个 GBK 字节就是被 U+FFFD 吃掉的中文"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 整棵树扫描时，读不懂的那一个文件只是**被跳过**，不能拖垮其余文件的替换。
    /// （replace_in_project 对 Err 的分支是 `_ => {}`，这条把那个前提钉住。）
    #[test]
    fn a_project_sweep_skips_the_undecodable_file_and_still_fixes_the_utf8_ones() {
        let dir = scratch("sweep");
        let legacy = dir.join("legacy.po");
        let modern = dir.join("modern.rs");
        let original = gbk_line();
        std::fs::write(&legacy, &original).unwrap();
        std::fs::write(&modern, "let x = TODO_TOKEN;\n").unwrap();

        let out = replace_in_project(
            dir.to_string_lossy().to_string(),
            "TODO_TOKEN".into(),
            "DONE".into(),
            true,
        )
        .expect("扫描本身不该失败");

        assert_eq!(
            (out.files_changed, out.replacements),
            (1, 1),
            "只有那个 UTF-8 文件该被改，GBK 的那个只是跳过"
        );
        assert_eq!(
            std::fs::read_to_string(&modern).unwrap(),
            "let x = DONE;\n",
            "合法 UTF-8 的文件没被替换 —— 修法不能把正常路径一起关掉"
        );
        assert_eq!(
            std::fs::read(&legacy).unwrap(),
            original,
            "扫描顺手毁掉了那个 GBK 文件"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 新内容必须靠**原子替换**落盘，不是 O_TRUNC 就地重写。
    ///
    /// std::fs::write 先把原文件清零再流式写入；中途被杀 / 断电 / 写满，用户的源文件就停在
    /// 截断状态，原内容没处找 —— 而 replace_in_project 一轮能重写上百个文件。
    /// atomic_write_text 的做法是「同目录暂存 + fsync + rename」，所以**inode 会换**：
    /// 那就是"没有就地截断这个窗口"唯一能在进程内观察到的证据（真去 kill 进程没法写成测试）。
    /// 退回 std::fs::write，inode 不变，这条立刻变红。
    #[cfg(unix)]
    #[test]
    fn the_new_content_arrives_by_atomic_rename_not_by_truncating_in_place() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("atomic");
        let f = dir.join("app.rs");
        std::fs::write(&f, "let x = TODO_TOKEN;\n").unwrap();
        // 权限也要跟着走：原子替换换的是 inode，忘了搬权限的话可执行脚本会在替换后失去 +x。
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o640)).unwrap();
        let before = std::fs::metadata(&f).unwrap();

        let n = replace_in_file(
            f.to_string_lossy().to_string(),
            "TODO_TOKEN".into(),
            "DONE".into(),
            true,
        )
        .expect("替换应当成功");
        assert_eq!(n, 1);

        let after = std::fs::metadata(&f).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "let x = DONE;\n");
        assert_ne!(
            before.ino(),
            after.ino(),
            "inode 没变 —— 说明还是就地 truncate 重写，崩在中间就把用户的文件清空了"
        );
        assert_eq!(
            after.permissions().mode() & 0o777,
            0o640,
            "原子替换把文件权限丢了"
        );
        // 暂存文件必须已经被 rename 走，不能在工作区里留下 .app.rs.michael-write-*.tmp
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("michael-write"))
            .collect();
        assert!(leftovers.is_empty(), "暂存文件被落在了工作区里：{leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 走原子替换之后，**只读文件（0o444）也会被改写，且权限保持不变**。
    ///
    /// 这不是顺带的副作用，是换写法必然带来的一条行为变化，所以钉在这里：
    /// `std::fs::write` 要文件的写权限，rename 要**目录**的写权限。以前 replace_in_file
    /// 对 0o444 返回 EACCES，replace_in_project 那边被 `_ => {}` 静默吃掉——不报错、
    /// 也不计进 files_changed，用户只看到「替换了 N 处」里少了这一个文件，无从追查。
    /// 现在两边都算数。判它是对的：同一个文件在编辑器里保存一直是成功的
    /// （write_text_file 系列本来就走原子替换），"能编辑却替换不了"才是那半边说不通。
    /// 目录不可写的树不受影响——暂存文件就建在同目录，那一步会先失败。
    ///
    /// 退回 `std::fs::write(&resolved, &new_content)`，这条立刻变红（EACCES）。
    #[cfg(unix)]
    #[test]
    fn a_read_only_file_is_rewritten_and_keeps_its_read_only_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("readonly");
        let locked = dir.join("locked.txt");
        let plain = dir.join("plain.txt");
        std::fs::write(&locked, "let x = TODO_TOKEN;\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o444)).unwrap();

        let n = replace_in_file(
            locked.to_string_lossy().to_string(),
            "TODO_TOKEN".into(),
            "DONE".into(),
            true,
        )
        .expect("0o444 的文件现在应当能替换 —— rename 要的是目录写权限，不是文件写权限");
        assert_eq!(n, 1);
        assert_eq!(std::fs::read_to_string(&locked).unwrap(), "let x = DONE;\n");
        assert_eq!(
            std::fs::metadata(&locked).unwrap().permissions().mode() & 0o777,
            0o444,
            "只读位被替换掉了 —— 改内容可以，悄悄把文件变成可写不行"
        );

        // 整棵树扫描时它必须**计进结果**，不能像以前那样在 `_ => {}` 里静默消失。
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(&locked, "SWEEP_TOKEN\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o444)).unwrap();
        std::fs::write(&plain, "SWEEP_TOKEN\n").unwrap();

        let out = replace_in_project(
            dir.to_string_lossy().to_string(),
            "SWEEP_TOKEN".into(),
            "OK".into(),
            true,
        )
        .expect("扫描本身不该失败");
        assert_eq!(
            (out.files_changed, out.replacements),
            (2, 2),
            "只读的那个文件没被计进来 —— 用户看到的「替换 N 处」少了它，而且一句错都没有"
        );
        assert_eq!(std::fs::read_to_string(&locked).unwrap(), "OK\n");
        assert_eq!(std::fs::read_to_string(&plain).unwrap(), "OK\n");
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod archive_summary_tests {
    use super::*;
    use std::io::Write;

    /// The sample bound describes the hex/strings preview, not the archive. Shown next to the
    /// entry count it read as "it only got through 1 MB of your zip", which is the opposite of
    /// what happened — and it is why a working build looked like an old one.
    #[test]
    fn a_fully_read_archive_is_not_labelled_as_truncated() {
        let dir = std::env::temp_dir().join("michael-inspect-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.zip");

        // Comfortably past the sampling threshold, so `sampled` is true.
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let blob = vec![b'x'; 256 * 1024];
        for i in 0..8 {
            zip.start_file(format!("payload{i}.bin"), opts).unwrap();
            zip.write_all(&blob).unwrap();
        }
        zip.finish().unwrap();

        let inspection = inspect_file(path.to_string_lossy().into_owned(), Some(64 * 1024)).unwrap();
        let summary = inspection.summary.join("\n");
        assert!(
            !summary.contains("当前只解析前"),
            "a complete archive listing must not carry the raw-bytes truncation notice:\n{summary}"
        );
        assert!(
            summary.contains("8 个条目"),
            "and it must still report the real entry count:\n{summary}"
        );
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod tests {
    /// 工具输出溢出时会把完整结果落到**系统临时目录**，再让模型用 read_file 取回。
    /// 这条链的全部前提是：临时目录下的路径，读和写**都**能过这道闸 ——
    /// 而且在**没有任何工作区根**的时候也能过（闸门对空根表是 fail-closed 的）。
    ///
    /// 这条不变量此前只有注释在说，没有任何测试正面验过。它一旦破了，
    /// 表现不是报错，是模型收到一句「完整内容在 /var/folders/…」然后读回来一个拒绝 ——
    /// 一个凭空承诺的路径，比直接截断更糟。
    #[test]
    fn temp_dir_paths_pass_the_workspace_gate_for_both_read_and_write() {
        let file = std::env::temp_dir()
            .join(format!("mrdayone-overflow-gate-{}.txt", std::process::id()));
        std::fs::write(&file, "x").expect("写临时文件");
        let path = file.to_string_lossy().to_string();

        // 空根表：闸门对普通路径此时是 fail-closed 的，临时目录必须**照样**放行。
        {
            let mut roots = super::ALLOWED_ROOTS.lock().expect("lock");
            roots.clear();
        }
        assert!(
            super::require_inside_workspace(&path, false).is_ok(),
            "临时目录读被拒了 —— 溢出落盘的那句「完整内容在 …」会变成假话"
        );
        assert!(
            super::require_inside_workspace(&path, true).is_ok(),
            "临时目录写被拒了 —— 文件根本不会存在，而正文已经承诺了路径"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[tokio::test]
    async fn inspecting_a_sqlite_file_from_inside_the_async_runtime_returns_instead_of_blowing_up() {
        // inspect_file 标着 #[tauri::command(async)] 而本身是同步函数，Tauri 会把它 spawn
        // 到 tokio 运行时上跑。原来 inspect_sqlite_tables 在那儿直接 block_on 另一个 future
        // —— 在运行时线程里再起一个运行时，tokio 直接炸。表现是：双击一个 .db 文件，
        // invoke 再也不返回，前端那句 await 永远挂着，也没有任何错误弹出来。
        //
        // 这条测试就跑在 tokio 运行时里（#[tokio::test]），复现的正是那个上下文。
        let dir = std::env::temp_dir().join(format!("mrday-sqlite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("app.db");
        // 一个合法的空 SQLite 文件：头 16 字节是魔数，其余按页补零。
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.resize(4096, 0);
        std::fs::write(&db, &bytes).unwrap();

        // 只要求它**返回**。内容对不对不是这条测试的事——这里测的是"会不会挂死/炸掉"。
        let tables = inspect_sqlite_tables(&db);
        assert!(tables.is_empty() || !tables.is_empty(), "只要能走到这一行就说明没炸");

        // 不存在的文件同样要老老实实返回空，而不是把命令拖死。
        let missing = inspect_sqlite_tables(&dir.join("nope.db"));
        assert!(missing.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_can_see_dotfiles_like_github_workflows_but_still_skips_dot_noise() {
        // 原来 search / replace 两处都是 `if name.starts_with('.') { continue; }`，
        // 于是 .github/、.env、.eslintrc 全是盲区：模型搜 "workflow_dispatch" 得到 0 命中，
        // 而文件就躺在 .github/workflows/ 里。同一个模型用 find_files **能**看见那个文件
        // （前端那份早改成具名黑名单了）——两个工具对同一个仓库给出互相矛盾的答案。
        let root = std::env::temp_dir().join(format!("mrday-dotsearch-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "on: workflow_dispatch\n").unwrap();
        std::fs::write(root.join(".env"), "API_BASE=needle_here\n").unwrap();
        std::fs::write(root.join(".eslintrc"), "{ \"rules\": { \"needle_here\": 0 } }").unwrap();
        std::fs::write(root.join("src/app.ts"), "// needle_here\n").unwrap();
        // 这两个必须仍然被跳过，否则搜索会被生成物淹没
        std::fs::write(root.join(".git/COMMIT_EDITMSG"), "needle_here\n").unwrap();
        std::fs::write(root.join("node_modules/dep.js"), "needle_here\n").unwrap();

        let rootstr = root.to_string_lossy().to_string();
        register_workspace_root(rootstr.clone()).ok();
        let found = search_project_scope(&rootstr, "needle_here", true, None).expect("搜索应当成功");
        let hits: Vec<String> = found
            .files
            .iter()
            .map(|f| f.path.replace('\\', "/"))
            .collect();
        let has = |frag: &str| hits.iter().any(|h| h.contains(frag));

        assert!(has(".env"), "看不见 .env —— 点号开头的配置是最常被搜的那批。命中: {hits:?}");
        assert!(has(".eslintrc"), "看不见 .eslintrc。命中: {hits:?}");
        assert!(has("app.ts"), "连普通文件都没搜到，说明测试本身写坏了。命中: {hits:?}");
        assert!(!has("/.git/"), ".git 里的东西不该进搜索结果。命中: {hits:?}");
        assert!(!has("node_modules"), "node_modules 不该进搜索结果。命中: {hits:?}");

        // 目录层：.github/ 必须能走进去
        let wf = search_project_scope(&rootstr, "workflow_dispatch", true, None).expect("搜索应当成功");
        assert!(
            wf.files.iter().any(|f| f.path.replace('\\', "/").contains(".github/workflows/ci.yml")),
            "走不进 .github/ 目录——CI 配置对模型永远不可见"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dot_noise_directories_are_named_not_guessed_by_the_leading_dot() {
        // 判据必须是"这个名字在名单里"，而不是"以点开头"。
        assert!(skip_walk_entry(".git", true));
        assert!(skip_walk_entry(".venv", true));
        assert!(skip_walk_entry("node_modules", true));
        assert!(!skip_walk_entry(".github", true), ".github 是源码，不是噪声");
        assert!(!skip_walk_entry(".env", false));
        assert!(!skip_walk_entry(".eslintrc", false));
        assert!(!skip_walk_entry(".gitignore", false));
        // 同名的普通目录不能因为出现在 IGNORED_DIRS 里就连文件也一起挡掉
        assert!(!skip_walk_entry("build", false), "叫 build 的文件不该被当成 build 目录");
    }

    #[test]
    fn creating_a_project_binds_it_as_a_workspace_root() {
        // 真跑一次：建目录 → 注册成工作区根 → 目录里能写文件。
        // 只断言"参数校验能拒"是不够的——这个工具存在的意义是让没有工作区的智能体开得了工。
        let name = format!("mrday-test-{}", std::process::id());
        let abs = create_project_dir(name.clone()).expect("应当建成");
        let p = std::path::Path::new(&abs);
        assert!(p.is_dir(), "目录要真的存在");
        assert!(abs.contains("MrDayOne"), "位置固定在 ~/MrDayOne 下，不由调用方决定");
        assert!(abs.ends_with(&name));
        // 注册成功之后，工作区边界应当放行这个目录里的写入——这正是"开得了工"的定义。
        let inside = p.join("bot.py").to_string_lossy().into_owned();
        assert!(require_inside_workspace(&inside, true).is_ok(), "建完就该能在里面写文件");
        // 重复调用是幂等的：复用同名目录，不覆盖。
        std::fs::write(p.join("keep.txt"), b"user code").unwrap();
        let again = create_project_dir(name).expect("重复调用应当复用");
        assert_eq!(again, abs);
        assert!(p.join("keep.txt").exists(), "绝不能清空已有目录");
        std::fs::remove_dir_all(p).ok();
    }

    #[test]
    fn project_name_cannot_escape_the_base_directory() {
        // 位置不由调用方决定：模型只能给一个名字，目录固定建在 ~/MrDayOne/<name> 下。
        // 名字过白名单是这条边界的**唯一**依赖，所以逃逸形状要逐个测到。
        for bad in [
            "../../etc",       // 相对路径上跳
            "a/b",             // 正斜杠
            "a\\b",            // 反斜杠
            "..",              // 纯上跳
            ".ssh",            // 隐藏目录（点开头一律拒）
            "",                // 空
            "   ",             // 全空白
            "a..b",            // 内嵌 ..
        ] {
            assert!(create_project_dir(bad.to_string()).is_err(), "应当拒绝: {bad:?}");
        }
        // 长度上限也要守住，免得拼出病态路径。
        assert!(create_project_dir("x".repeat(65)).is_err());
    }

    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "michael-ide-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn data_url_mime_recognizes_common_video_formats() {
        assert_eq!(data_url_mime(Path::new("clip.mp4")), "video/mp4");
        assert_eq!(data_url_mime(Path::new("clip.WEBM")), "video/webm");
        assert_eq!(data_url_mime(Path::new("clip.ogv")), "video/ogg");
        assert_eq!(data_url_mime(Path::new("clip.ogg")), "video/ogg");
        assert_eq!(data_url_mime(Path::new("clip.mov")), "video/quicktime");
        assert_eq!(data_url_mime(Path::new("clip.m4v")), "video/x-m4v");
    }

    #[test]
    fn data_url_mime_keeps_known_images_and_rejects_unknown_types() {
        assert_eq!(data_url_mime(Path::new("frame.png")), "image/png");
        assert_eq!(data_url_mime(Path::new("frame.jpeg")), "image/jpeg");
        assert_eq!(
            data_url_mime(Path::new("payload.html")),
            "application/octet-stream"
        );
    }

    fn staged_files_for(path: &Path) -> Vec<PathBuf> {
        let Some(parent) = path.parent() else {
            return Vec::new();
        };
        let prefix = format!(
            ".{}.michael-write-",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        std::fs::read_dir(parent)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            })
            .collect()
    }

    #[test]
    fn safe_prefixes_require_a_path_component_boundary() {
        assert!(has_safe_prefix(Path::new("/tmp/project/file.txt")));
        assert!(has_safe_prefix(Path::new(
            "/private/var/folders/session/file.txt"
        )));
        assert!(!has_safe_prefix(Path::new("/tmp-evil/file.txt")));
        assert!(!has_safe_prefix(Path::new("/tmpfoo/file.txt")));
        assert!(!has_safe_prefix(Path::new(
            "/private/var/folders_evil/file.txt"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn safe_prefix_check_happens_after_parent_components_are_resolved() {
        let escaped = std::fs::canonicalize("/tmp/../etc").unwrap();

        assert!(!has_safe_prefix(&escaped));
    }

    // `require_inside_workspace` used to `return Ok(resolved)` whenever ALLOWED_ROOTS was
    // empty — handing out unrestricted read AND write access to the whole filesystem in
    // exactly the degraded startup where the boundary matters most. It must deny instead.
    #[cfg(unix)]
    #[test]
    fn an_empty_root_list_denies_instead_of_allowing_everything() {
        let roots: Vec<PathBuf> = Vec::new();
        // The property under test is the one the old code got backwards: "not inside any
        // root" must never be satisfiable by an empty root list.
        assert!(!is_within_allowed_root(Path::new("/etc/ssh/sshd_config"), &roots));
        assert!(!is_within_allowed_root(Path::new("/Users/someone/.ssh/id_rsa"), &roots));
        // …while temp scratch space stays reachable through its own explicit allowance.
        assert!(has_safe_prefix(&std::fs::canonicalize(std::env::temp_dir()).unwrap()));
    }

    // Depth alone was the only check: `/etc` and `/Users` (depth 2) were rejected, but
    // `/usr/local`, `/private/etc` and `/Library/LaunchAgents` all sailed through at depth
    // >= 3 — each granting write access to a tree that decides what the machine executes.
    #[cfg(not(windows))]
    #[test]
    fn system_directories_are_rejected_as_workspace_roots_regardless_of_depth() {
        for path in [
            "/usr/local",
            "/usr/local/share/very/deep/path",
            "/private/etc",
            "/etc/ssl/certs",
            "/Library/LaunchAgents",
            "/var/db",
            "/System/Library",
            "/opt/homebrew",
        ] {
            assert!(
                blocked_root_prefix(Path::new(path)).is_some(),
                "{path} must be refused as a workspace root"
            );
        }
        // Ordinary project locations stay registrable.
        for path in ["/Users/tester/code/app", "/home/tester/src/app", "/data/projects/x"] {
            assert!(
                blocked_root_prefix(Path::new(path)).is_none(),
                "{path} must remain a valid workspace root"
            );
        }
        // Component-wise matching: a prefix must not match a longer sibling name.
        assert!(blocked_root_prefix(Path::new("/usrlocal/project")).is_none());
        assert!(blocked_root_prefix(Path::new("/etcetera/project")).is_none());
        // Temp dirs live under blocked trees (/var/folders, /tmp) but are legitimate
        // scratch space and are carved back out.
        assert!(blocked_root_prefix(Path::new("/tmp/scratch")).is_none());
        assert!(blocked_root_prefix(Path::new("/private/var/folders/ab/session")).is_none());
    }

    /// 两个匹配点必须走 `starts_with_prefix`，不能直接 `Path::starts_with`。
    ///
    /// 上面那条测试在 macOS 上验的是纯字符串逻辑；而"这段逻辑到底有没有被用上"
    /// 在 macOS 上验不了——非 Windows 分支本来就是 `Path::starts_with`，改回去也一样绿。
    /// 所以这里钉源码：谁把调用改回裸的 `path.starts_with`，Windows 上就又空转了。
    #[test]
    fn blocklist_routes_through_the_windows_aware_matcher() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/files.rs"))
            .expect("read files.rs");
        let cut = src.find("mod tests").unwrap_or(src.len());
        let code = &src[..cut];
        // **按函数边界取，不用固定字符窗口。** 原来写的是 `&code[at..at + 400]` ——
        // 两个毛病：① 函数一长（比如加了几行注释）目标就被推出窗口，断言静默失效；
        // ② 400 字节可能落在一个多字节汉字**中间**，切片直接 panic（实测就是这么炸的）。
        // 改成从函数头切到下一个列 0 的 `}`，长度上下界兜着解析坏掉的情况。
        let body_of = |name: &str| -> String {
            let at = code.find(name).unwrap_or_else(|| panic!("{name} 必须存在"));
            let rest = &code[at..];
            let end = rest.find("\n}\n").map(|e| e + 2).unwrap_or(rest.len());
            let body = rest[..end].to_string();
            assert!(
                body.len() > 80 && body.len() < 4000,
                "{name} 切出来 {} 字节 —— 边界找错了，这条断言在守一个空窗口",
                body.len()
            );
            body
        };
        assert!(
            body_of("fn blocked_root_prefix(").contains("starts_with_prefix(path, prefix)"),
            "系统目录黑名单没走 Windows 感知的匹配器，Windows 上会整张空转"
        );
        assert!(
            body_of("fn has_safe_prefix(").contains("starts_with_prefix(path, prefix)"),
            "临时目录豁免同样要按同一条规则匹配"
        );
    }

    /// Windows 的系统目录黑名单此前**整张都是空转的**。
    ///
    /// `std::fs::canonicalize` 在 Windows 上返回 verbatim 形式（`\\?\C:\Windows`），
    /// 而 `Path::starts_with` 按组件比：verbatim 的首组件是 `Prefix::VerbatimDisk`，和字面量
    /// 里的 `Prefix::Disk` 不相等 —— 一条都匹配不上，`C:\Windows` 能被登记成工作区根，
    /// 界面上和日志里都没有任何异样。这段逻辑只在 Windows 生效但**不带 cfg**，
    /// 所以 macOS 上照样编译、照样跑得到。
    /// 临时目录豁免必须按**系统真实的**临时目录判，不是四条 POSIX 字面量。
    ///
    /// 原来只有 /tmp、/private/tmp、/var/folders、/private/var/folders 四条，
    /// Windows 上一条都不可能命中（那儿是 %LOCALAPPDATA%\Temp）。平时看不出来，
    /// 但用户把 TEMP 指到受管目录下时写入会被拒，而拒绝信息还说"临时目录仍然可用"。
    #[test]
    fn the_systems_own_temp_dir_is_always_writable() {
        let tmp = std::env::temp_dir();
        assert!(
            has_safe_prefix(&tmp),
            "系统临时目录 {} 没有被豁免",
            tmp.display()
        );
        assert!(
            has_safe_prefix(&tmp.join("mrdayone-probe").join("a.txt")),
            "临时目录下的子路径没有被豁免"
        );
        // 反向：普通目录不该因为这条变成"安全"。
        assert!(
            !has_safe_prefix(std::path::Path::new("/definitely/not/temp/x")),
            "豁免放得太宽了"
        );
    }

    /// .vs 是 Visual Studio 的工程缓存，只在 Windows 上出现——四份忽略名单
    /// 都收了 .idea/.vscode，独独漏了它，于是 Windows 上用 VS 的仓库，
    /// 索引会被几百 MB 二进制中间产物灌满。
    #[test]
    fn visual_studio_cache_is_ignored_like_its_siblings() {
        for name in [".idea", ".vscode", ".vs"] {
            assert!(
                IGNORED_DOT_DIRS.contains(&name),
                "忽略名单里少了 {name}"
            );
        }
    }

    #[test]
    fn windows_prefix_match_handles_verbatim_and_case() {
        // verbatim 前缀要被剥掉
        assert!(windows_starts_with_prefix(r"\\?\C:\Windows\System32", r"C:\Windows"));
        assert!(windows_starts_with_prefix(r"\\?\C:\Program Files\x", r"C:\Program Files"));
        // 大小写不敏感
        assert!(windows_starts_with_prefix(r"c:\windows\system32", r"C:\Windows"));
        assert!(windows_starts_with_prefix(r"C:/Windows/System32", r"C:\Windows"));
        // 根目录本身也算命中
        assert!(windows_starts_with_prefix(r"C:\Windows", r"C:\Windows"));
        // 但必须卡在组件边界上：C:\Windowsfoo 不是 C:\Windows 底下的东西
        assert!(!windows_starts_with_prefix(r"C:\Windowsfoo\x", r"C:\Windows"));
        assert!(!windows_starts_with_prefix(r"D:\Windows\x", r"C:\Windows"));
        assert!(!windows_starts_with_prefix(r"C:\Users\m\proj", r"C:\Windows"));
        // UNC 的 verbatim 形式还原成 \\server\share
        assert_eq!(
            windows_prefix_match_form(r"\\?\UNC\server\share\p"),
            r"\\server\share\p"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_root_check_rejects_a_symlink_target_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let parent = temp_file("symlink-root-check");
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();

        let canonical_root = std::fs::canonicalize(&root).unwrap();
        let escaped = std::fs::canonicalize(root.join("escape/secret.txt")).unwrap();

        assert!(!is_within_allowed_root(&escaped, &[canonical_root]));
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn text_read_rejects_invalid_utf8_without_changing_the_file() {
        let path = temp_file("invalid-utf8");
        let original = [b'v', b'a', b'l', 0x80, b'e'];
        std::fs::write(&path, original).unwrap();

        let error = read_text_file(path.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("not valid UTF-8"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn atomic_create_paths_never_clobber_an_existing_target() {
        let path = temp_file("existing-create-target");
        std::fs::write(&path, "keep me").unwrap();

        let create_error = create_file(path.to_string_lossy().into_owned()).unwrap_err();
        assert!(create_error.contains("[CONFLICT]"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");
        assert!(staged_files_for(&path).is_empty());

        let conditional_error = write_text_file_if_unchanged(
            path.to_string_lossy().into_owned(),
            None,
            "replacement".into(),
        )
        .unwrap_err();
        assert!(conditional_error.contains("[CONFLICT]"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");
        assert!(staged_files_for(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn atomic_create_commands_publish_complete_new_files() {
        let empty_path = temp_file("create-empty-file");
        create_file(empty_path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(std::fs::read(&empty_path).unwrap(), b"");
        assert!(staged_files_for(&empty_path).is_empty());

        let content_path = temp_file("conditional-create-file");
        write_text_file_if_unchanged(
            content_path.to_string_lossy().into_owned(),
            None,
            "complete contents".into(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&content_path).unwrap(),
            "complete contents"
        );
        assert!(staged_files_for(&content_path).is_empty());

        let _ = std::fs::remove_file(empty_path);
        let _ = std::fs::remove_file(content_path);
    }

    #[test]
    fn concurrent_atomic_creates_publish_one_complete_winner() {
        let path = temp_file("concurrent-atomic-create");
        let first = "a".repeat(2 * 1024 * 1024);
        let second = "b".repeat(2 * 1024 * 1024);
        let barrier = Arc::new(Barrier::new(4));

        let mut writers = Vec::new();
        for content in [first.clone(), second.clone()] {
            let writer_path = path.clone();
            let writer_barrier = Arc::clone(&barrier);
            writers.push(std::thread::spawn(move || {
                writer_barrier.wait();
                atomic_create_text(&writer_path, &content)
            }));
        }

        let reader_path = path.clone();
        let reader_barrier = Arc::clone(&barrier);
        let expected_first = first.clone();
        let expected_second = second.clone();
        let reader = std::thread::spawn(move || {
            reader_barrier.wait();
            loop {
                match std::fs::read_to_string(&reader_path) {
                    Ok(observed) => {
                        assert!(observed == expected_first || observed == expected_second);
                        return observed;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        std::thread::yield_now();
                    }
                    Err(error) => panic!("cannot observe atomic create: {error}"),
                }
            }
        });

        barrier.wait();
        let results = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>();
        let observed = reader.join().unwrap();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), observed);
        assert!(staged_files_for(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unconditional_write_allows_intentional_empty_content() {
        let path = temp_file("empty-write");
        std::fs::write(&path, "previous contents").unwrap();

        write_text_file(path.to_string_lossy().into_owned(), String::new()).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        assert!(staged_files_for(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn atomic_write_never_exposes_truncated_or_partial_content() {
        let path = temp_file("atomic-visibility");
        let first = "a".repeat(2 * 1024 * 1024);
        let second = "b".repeat(2 * 1024 * 1024);
        std::fs::write(&path, &first).unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let started = Arc::new(Barrier::new(2));
        let reader_done = Arc::clone(&done);
        let reader_started = Arc::clone(&started);
        let reader_path = path.clone();
        let reader_first = first.clone();
        let reader_second = second.clone();
        let reader = std::thread::spawn(move || {
            let initial = std::fs::read_to_string(&reader_path).unwrap();
            assert_eq!(initial, reader_first);
            let mut observations = 1;
            reader_started.wait();
            while !reader_done.load(Ordering::Acquire) {
                let observed = std::fs::read_to_string(&reader_path).unwrap();
                assert!(observed == reader_first || observed == reader_second);
                observations += 1;
            }
            observations
        });

        started.wait();
        for index in 0..6 {
            let content = if index % 2 == 0 { &second } else { &first };
            write_text_file(path.to_string_lossy().into_owned(), content.clone()).unwrap();
        }
        done.store(true, Ordering::Release);

        assert!(reader.join().unwrap() > 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert!(staged_files_for(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_atomic_replace_keeps_target_and_cleans_staged_file() {
        let path = temp_file("atomic-replace-failure");
        std::fs::create_dir(&path).unwrap();

        let error =
            write_text_file(path.to_string_lossy().into_owned(), "content".into()).unwrap_err();

        assert!(error.contains("atomically replace"));
        assert!(path.is_dir());
        assert!(staged_files_for(&path).is_empty());
        let _ = std::fs::remove_dir(path);
    }

    #[cfg(unix)]
    #[test]
    fn unconditional_write_uses_the_resolved_symlink_target() {
        use std::os::unix::fs::symlink;

        let target = temp_file("resolved-target");
        let link = temp_file("resolved-link");
        std::fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();

        write_text_file(link.to_string_lossy().into_owned(), "new".into()).unwrap();

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "new");
        assert!(staged_files_for(&target).is_empty());
        let _ = std::fs::remove_file(link);
        let _ = std::fs::remove_file(target);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_existing_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let path = temp_file("preserve-permissions");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();

        write_text_file(path.to_string_lossy().into_owned(), "new".into()).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o751);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn conditional_write_rejects_stale_content() {
        let path = temp_file("stale-write");
        std::fs::write(&path, "v1").unwrap();
        write_text_file_if_unchanged(
            path.to_string_lossy().into_owned(),
            Some("v1".into()),
            "v2".into(),
        )
        .unwrap();
        let error = write_text_file_if_unchanged(
            path.to_string_lossy().into_owned(),
            Some("v1".into()),
            "stale".into(),
        )
        .unwrap_err();
        assert!(error.contains("[CONFLICT]"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v2");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn concurrent_conditional_writes_allow_only_one_winner() {
        let path = temp_file("concurrent-write");
        std::fs::write(&path, "v1").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for value in ["from-a", "from-b"] {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                write_text_file_if_unchanged(
                    path.to_string_lossy().into_owned(),
                    Some("v1".into()),
                    value.into(),
                )
            }));
        }
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        let final_value = std::fs::read_to_string(&path).unwrap();
        assert!(final_value == "from-a" || final_value == "from-b");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn conditional_delete_preserves_a_newer_edit() {
        let path = temp_file("conditional-delete");
        std::fs::write(&path, "agent").unwrap();
        std::fs::write(&path, "user").unwrap();
        let error =
            delete_text_file_if_unchanged(path.to_string_lossy().into_owned(), "agent".into())
                .unwrap_err();
        assert!(error.contains("[CONFLICT]"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user");

        delete_text_file_if_unchanged(path.to_string_lossy().into_owned(), "user".into()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn project_search_defaults_to_literal_and_supports_regex_for_file_scope() {
        let path = temp_file("search-single-file");
        std::fs::write(&path, "alpha[1]\nALPHA 42\nalpha111\n").unwrap();

        let literal =
            search_project_scope(&path.to_string_lossy(), "alpha[1]", false, None).unwrap();
        assert_eq!(literal.scanned_files, 1);
        assert_eq!(literal.files.len(), 1);
        assert_eq!(
            literal.files[0].rel,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(literal.files[0].matches.len(), 1);
        assert_eq!(literal.files[0].matches[0].line, 1);

        let regex = search_project_scope(
            &path.to_string_lossy(),
            r"alpha(?:\[\d+\]|\s+\d+)",
            false,
            Some("regex"),
        )
        .unwrap();
        assert_eq!(regex.scanned_files, 1);
        assert_eq!(regex.files[0].matches.len(), 2);
        assert_eq!(regex.files[0].matches[0].line, 1);
        assert_eq!(regex.files[0].matches[1].line, 2);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn project_search_reports_invalid_mode_pattern_and_scope() {
        let path = temp_file("search-errors");
        std::fs::write(&path, "content\n").unwrap();

        let bad_mode = search_project_scope(&path.to_string_lossy(), "x", false, Some("glob"))
            .err()
            .expect("glob mode must be rejected");
        assert!(bad_mode.contains("[INVALID_SEARCH_MODE]"));

        let bad_pattern = search_project_scope(&path.to_string_lossy(), "[", false, Some("regex"))
            .err()
            .expect("invalid regex must be rejected");
        assert!(bad_pattern.contains("[INVALID_SEARCH_PATTERN]"));

        let missing = temp_file("missing-search-scope");
        let bad_scope = search_project_scope(&missing.to_string_lossy(), "x", false, None)
            .err()
            .expect("missing scope must be rejected");
        assert!(bad_scope.contains("[INVALID_SEARCH_SCOPE]"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn project_search_distinguishes_no_matches_from_zero_scanned_files() {
        let root = temp_file("search-directory");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("one.txt"), "first\n").unwrap();
        std::fs::write(root.join("two.txt"), "second\n").unwrap();

        let no_match =
            search_project_scope(&root.to_string_lossy(), "absent", false, None).unwrap();
        assert_eq!(no_match.scanned_files, 2);
        assert!(no_match.files.is_empty());

        let empty = temp_file("empty-search-directory");
        std::fs::create_dir(&empty).unwrap();
        let no_files = search_project_scope(&empty.to_string_lossy(), "anything", false, None)
            .err()
            .expect("empty scope must be rejected");
        assert!(no_files.contains("[NO_SEARCHABLE_FILES]"));

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(empty);
    }

    #[test]
    /// ⌘P 的候选列表要跟随 .gitignore，并且截断必须上报。
    ///
    /// 原来前端逐目录 readDir、带一份自己的 10 项写死名单，于是 node_modules 里的几万个
    /// 文件会挤满候选；而上限 5000 是**静默**的——搜不到一个确实存在的文件时，用户会
    /// 以为它不在项目里（和搜索那条假阴性是同一类问题）。
    fn list_project_files_follows_gitignore_and_reports_truncation() {
        let root = temp_file("qo-list");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(".gitignore"), "build_out/\n*.log\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::create_dir(root.join("build_out")).unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("src/main.ts"), "x").unwrap();
        std::fs::write(root.join("build_out/bundle.js"), "x").unwrap();
        std::fs::write(root.join("node_modules/dep.js"), "x").unwrap();
        std::fs::write(root.join("debug.log"), "x").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();

        register_workspace_root(root.to_string_lossy().to_string()).ok();
        let out = list_project_files(root.to_string_lossy().to_string(), None).unwrap();
        let rels: Vec<&str> = out.files.iter().map(|f| f.rel.as_str()).collect();

        assert!(rels.contains(&"src/main.ts"), "自己的源码没被列出来");
        assert!(rels.contains(&"README.md"));
        assert!(!rels.iter().any(|r| r.starts_with("build_out/")), "项目自己 gitignore 的目录进了候选");
        assert!(!rels.contains(&"debug.log"), "gitignore 的通配规则没生效");
        assert!(!rels.iter().any(|r| r.starts_with("node_modules/")), "node_modules 挤进了候选");
        assert!(!out.truncated, "没触到上限却报告成截断");

        // 触到上限必须**说出来**，不能静默返回一份不完整的列表。
        let small = list_project_files(root.to_string_lossy().to_string(), Some(1)).unwrap();
        assert_eq!(small.files.len(), 1);
        assert!(small.truncated, "截断了却没上报——用户会以为项目里就这么几个文件");
    }

    #[test]
    /// 文件树的忽略判据要跟着**项目自己的 .gitignore**走，而不是只认写死的名单。
    ///
    /// 写死名单永远猜不到项目自己的产物目录（build_out/、*.generated.ts），
    /// 也会冤枉那些合法提交 dist/ 的项目。gitignore 才是用户自己的声明。
    fn read_dir_marks_entries_the_project_itself_gitignores() {
        let root = temp_file("read-dir-gitignore");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(".gitignore"), "build_out/\n*.generated.ts\n!keep.generated.ts\n").unwrap();
        std::fs::create_dir(root.join("build_out")).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("api.generated.ts"), "x").unwrap();
        std::fs::write(root.join("keep.generated.ts"), "x").unwrap();
        std::fs::write(root.join("main.ts"), "x").unwrap();

        register_workspace_root(root.to_string_lossy().to_string()).ok();
        let out = read_dir(root.to_string_lossy().to_string()).unwrap();
        let ig = |n: &str| out.iter().find(|e| e.name == n).expect(n).ignored;

        assert!(ig("build_out"), "项目自己 gitignore 的目录没有被标记");
        assert!(ig("api.generated.ts"), "gitignore 的通配规则没生效");
        // 否定规则必须被尊重——手写正则最容易在这儿把用户明确要留的文件也藏掉。
        assert!(!ig("keep.generated.ts"), "!否定规则没生效，用户明确要留的文件被标成噪声了");
        assert!(!ig("src"), "src 被误标");
        assert!(!ig("main.ts"), "main.ts 被误标");
    }

    #[test]
    /// 文件树：软链目录要认得出来，噪声目录要沉底但**不能消失**。
    ///
    /// 软链——原来用 entry.file_type()，它不跟随符号链接，于是软链目录被当成文件：
    /// 点开是空的、也展不开。pnpm 的 node_modules、monorepo 的 packages 链接全中招。
    ///
    /// 噪声——文件树此前一份忽略规则都不用（搜索用 skip_walk_entry、TS 预加载用另一份），
    /// 打开 Node 项目第一眼就是几万条 node_modules。现在标记 + 沉底，但仍然在列表里：
    /// 直接删掉会让 `.vscode/`、`dist/` 完全够不到，而合法提交 dist 的项目是存在的。
    fn read_dir_follows_symlinked_dirs_and_sinks_noise_without_hiding_it() {
        let root = temp_file("read-dir-tree");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::create_dir(root.join("real_pkg")).unwrap();
        std::fs::write(root.join("README.md"), "hi").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real_pkg"), root.join("linked_pkg")).unwrap();

        register_workspace_root(root.to_string_lossy().to_string()).ok();
        let out = read_dir(root.to_string_lossy().to_string()).unwrap();
        let by = |n: &str| out.iter().find(|e| e.name == n).expect(n).clone();

        #[cfg(unix)]
        assert!(by("linked_pkg").is_dir, "软链目录被当成了文件——展不开，pnpm/monorepo 直接废");

        assert!(by("node_modules").ignored, "node_modules 没有被标成噪声");
        assert!(!by("src").ignored, "src 被误标成噪声了");

        // 噪声仍然在列表里（不是删掉），但排在所有非噪声之后。
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"node_modules"), "噪声目录被直接删掉了——用户再也点不进去");
        let nm = names.iter().position(|n| *n == "node_modules").unwrap();
        let src = names.iter().position(|n| *n == "src").unwrap();
        let readme = names.iter().position(|n| *n == "README.md").unwrap();
        assert!(nm > src && nm > readme, "噪声没有沉底：第一眼看到的还是 node_modules");
    }

    #[test]
    /// 截断必须**被报告出来**，而不是和「搜完了」长成一个样。
    ///
    /// 守的是一个假阴性：遍历在 SEARCH_MAX_RESULTS / SEARCH_MAX_SCANNED_FILES 处 break，
    /// 而在加上 `truncated` 之前，调用方拿到的结果和「整个仓库就这些命中」无法区分。
    /// 大仓里搜一个确实存在的符号，可能只返回前 2000 条，界面照常说「N 个结果」——
    /// 开发者据此以为自己看到了全部。
    fn project_search_reports_early_stop_instead_of_pretending_it_finished() {
        let root = temp_file("search-truncation-hit");
        std::fs::create_dir(&root).unwrap();
        let mut body = String::new();
        for _ in 0..(SEARCH_MAX_RESULTS + 500) {
            body.push_str("needle\n");
        }
        std::fs::write(root.join("many.txt"), &body).unwrap();
        let hit = search_project_scope(&root.to_string_lossy(), "needle", false, Some("literal")).unwrap();
        assert!(hit.truncated, "命中数超过上限却报告成搜完了——这正是假阴性的来源");

        // 反过来：没触到上限时不能谎报截断，否则提示常亮，然后就没人看了。
        let small = temp_file("search-truncation-none");
        std::fs::create_dir(&small).unwrap();
        std::fs::write(small.join("a.txt"), "needle once\n").unwrap();
        let ok = search_project_scope(&small.to_string_lossy(), "needle", false, Some("literal")).unwrap();
        assert!(!ok.truncated, "搜完了却报告成截断——提示会常亮，然后就没人看了");
        assert_eq!(ok.files.len(), 1);
    }

    #[test]
    fn project_search_ranks_files_by_match_count() {
        let root = temp_file("search-ranking");
        std::fs::create_dir(&root).unwrap();
        // `low.txt` sorts first alphabetically but has one hit; `zzz.txt` sorts
        // last yet has three. Ranking by match count must surface zzz.txt first.
        std::fs::write(root.join("low.txt"), "needle here\nnothing\n").unwrap();
        std::fs::write(root.join("zzz.txt"), "needle\nneedle\nneedle\n").unwrap();

        let ranked = search_project_scope(&root.to_string_lossy(), "needle", false, None).unwrap();
        assert_eq!(ranked.files.len(), 2);
        assert_eq!(
            ranked.files[0].rel, "zzz.txt",
            "the file with more matches must rank first, not the alphabetical one"
        );
        assert_eq!(ranked.files[0].matches.len(), 3);
        assert_eq!(ranked.files[1].rel, "low.txt");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_search_skips_expanded_vendored_dirs() {
        let root = temp_file("search-ignore-expanded");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("app.js"), "token\n").unwrap();
        for noise in ["bower_components", "Pods", "venv"] {
            let d = root.join(noise);
            std::fs::create_dir(&d).unwrap();
            std::fs::write(d.join("dep.js"), "token\n").unwrap();
        }
        let out = search_project_scope(&root.to_string_lossy(), "token", false, None).unwrap();
        assert_eq!(
            out.files.len(),
            1,
            "vendored dirs must be skipped so only app.js matches"
        );
        assert_eq!(out.files[0].rel, "app.js");

        let _ = std::fs::remove_dir_all(root);
    }
}
