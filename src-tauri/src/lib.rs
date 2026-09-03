// Platform accessibility helpers are retained as a fallback for the desktop
// automation bridge; not every target currently wires each helper into a command.
#[allow(dead_code)]
mod accessibility;
mod preview_bridge;
mod permissions;
mod archive;
mod repos;
mod tabular;
mod ui_clone;
mod ai;
mod auth;
mod automation;
mod browser;
mod cleanup;
mod capture;
mod content_length_frame;
mod conversation_store;
mod db;
mod debug;
mod env_probe;
mod extensions;
mod files;
mod game;
mod game_assets;
mod git;
mod handoff;
mod human_input;
mod image_location;
mod knowledge;
mod local_discovery;
mod location;
mod lint;
mod lsp;
mod marketplace;
mod mcp;
mod net;
mod process_util;
// 自定义模型的上游线协议翻译（openai / anthropic / xai_responses）。
mod protocol;
mod proxy;
mod public_data;
mod qr;
#[macro_use]
mod safelog;
mod sandbox;
mod shell_env;
mod sysctl;
mod tasks;
mod terminal;
/// 进程级环境变量在测试里只有一把锁：`auth` 和 `mcp` 曾各写各的 `ENV_LOCK`，
/// 于是一边改 HOME、另一边正在读 HOME，红的每次都不是同一条。见 test_env.rs。
#[cfg(test)]
mod test_env;
mod watcher;
mod web_scaffold;

// DevTools remain compiled in for manual use, but the application window must
// stay focused on startup instead of forcing the inspector open.
#[cfg(desktop)]
fn should_open_devtools_on_startup() -> bool {
    false
}

/// Reap any backend processes left over from a previous page session. The
/// frontend calls this once on startup, so a webview reload (common during dev)
/// no longer orphans the old terminals / LSP servers / debug adapters — the main
/// cause of "the IDE gets slower and freezes after running a while".
#[tauri::command]
fn cleanup_stale(
    app: tauri::AppHandle,
    term: tauri::State<terminal::TerminalState>,
    lsp: tauri::State<lsp::LspManager>,
    dap: tauri::State<debug::DebugManager>,
) {
    // 这里收的是**进程级**的孤儿：终端、语言服务器、调试子进程都不记录自己属于哪个窗口。
    // 单窗口 reload 后收尸是对的；但只要还有第二个窗口开着，收尸就会把它正在用的终端、
    // LSP、调试会话一并杀掉。前端已有守卫，这里再兜一层：多窗口时直接不做。
    if tauri::Manager::webview_windows(&app).len() > 1 {
        tracing_ignore_multiwindow();
        return;
    }
    term.reset_all();
    lsp.stop_all();
    dap.stop_all();
    mcp::stop_all();
    browser::close_all();
}

/// 多窗口时跳过 cleanup_stale 的说明位（保持函数体简单，便于将来换成真正的日志）。
fn tracing_ignore_multiwindow() {
    elog!("[cleanup_stale] 检测到多个窗口，跳过进程回收以免杀掉其它窗口正在用的会话");
}

/// Entry point shared by the binary and (potentially) mobile targets.
/// Crash reporting: append every Rust panic (message + location + backtrace + timestamp)
/// to `~/.mrdayone/crash.log`, so a crash on a user's machine leaves a trace we can ask
/// them for — instead of the window just vanishing with nothing to go on. Chains the
/// previous hook so normal panic printing still happens.
fn install_panic_logger() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            // 和 mcp.rs::app_dir 一致：新目录优先，只有它不存在而老目录在时才退回老的。
            // 这里**不做搬迁**——panic hook 跑在最早期，此刻做文件系统改动风险太高；
            // 搬迁交给 app_dir 那一次，这里只负责把日志写到正确的那一个。
            let base = std::path::PathBuf::from(home);
            let dir = if base.join(".mrdayone").is_dir() || !base.join(".michael-ide").is_dir() {
                base.join(".mrdayone")
            } else {
                base.join(".michael-ide")
            };
            let _ = std::fs::create_dir_all(&dir);
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let loc = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_default();
            let msg = format!(
                "\n===== PANIC (unix {ts}) =====\n{info}\nat: {loc}\n{:#?}\n",
                std::backtrace::Backtrace::force_capture()
            );
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = f.write_all(msg.as_bytes());
            }
            // macOS 标准日志位置再落一份，方便用户直接在 Console.app 里找到尸检记录。
            #[cfg(target_os = "macos")]
            {
                let logs = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join("Library/Logs");
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(logs.join("michael-ide-panic.log"))
                {
                    let _ = f.write_all(msg.as_bytes());
                }
            }
        }
        prev(info);
    }));
}

pub fn run() {
    install_panic_logger();
    browser::kill_orphaned_browsers();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // mrday:// —— 网页登录页靠它唤起本 App 完成登录交接。
        .plugin(tauri_plugin_deep_link::init())
        // 实时预览的调试桥。注入到**所有帧**，所以任何本地 dev server 起的页面
        // 一嵌进来就自带 console 转发和「指元素」，用户不用改自己的项目。
        .plugin(preview_bridge::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_fps::init());
    }

    builder
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // open_devtools only exists in debug builds or with the opt-in `devtools`
            // feature — release builds no longer compile the inspector in at all, so a
            // shipped app can't be opened up to read code / watch authorized requests.
            #[cfg(all(desktop, any(debug_assertions, feature = "devtools")))]
            if should_open_devtools_on_startup() {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }

            files::bootstrap_home_root();

            // Loopback listener the web sign-in page uses to adopt this app's session.
            // It starts signed-out; the frontend fills it in via handoff_set_session.
            //
            // 留着是因为它对**同机的非浏览器调用方**仍然有效（也仍然只认白名单来源）。
            // 浏览器那条路已经不走它了：HTTPS 页面打明文 loopback 端口会被 Chrome 直接
            // 拒绝，改走 mrday:// 深链 —— 见下面的 on_open_url。
            handoff::start();

            /*
             * 深链：mrday://signin?nonce=…
             *
             * 网页登录页打开它，操作系统把本 App 拉到前台（没运行会被一并启动），我们把
             * nonce 转交给前端，由前端拿自己的登录令牌去网关认领 —— 认领成功网关就替这个
             * 账号签一张网页会话，登录页那边轮询取走。
             *
             * 这里只做搬运：不解析令牌、不碰会话，身份完全由前端那张令牌决定。
             */
            {
                use tauri::{Emitter, Manager};
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.scheme() != "mrday" {
                            continue;
                        }
                        let nonce = url
                            .query_pairs()
                            .find(|(k, _)| k == "nonce")
                            .map(|(_, v)| v.to_string())
                            .unwrap_or_default();
                        // 只放行十六进制，长度也卡住：这串会被原样发回网关。
                        let ok = !nonce.is_empty()
                            && nonce.len() <= 64
                            && nonce.chars().all(|c| c.is_ascii_hexdigit());
                        if !ok {
                            continue;
                        }
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.set_focus();
                            let _ = w.emit("michael://handoff-signin", nonce);
                        }
                    }
                });
            }

            // WebKit fetches do not share the Rust AI client's connection pool. Warm
            // that pool in the background so the first model turn does not pay a cold
            // gateway TCP+TLS handshake, then retain it across idle agent/tool work.
            ai::start_gateway_transport_warmup();

            // 这里原来 spawn 一个 auth::init_db()，在每台机器的 ~/.michael_ide/auth.db 里建
            // users（bcrypt 密码库）和 marketplace_extensions 两张表。两张都没人读：
            // 真正的登录走网关 HTTP（前端 fetch /api/auth/*），扩展列表走 ext_available_builtin。
            // 实测本机 auth.db 的 users 表 0 行——它从建出来那天起就是空的。
            // 连同上面那 8 条只在注释里被提过的 auth_* / db_marketplace_* 命令一起摘掉：
            // 一个能在本机被任意调用、会做密码哈希的命令面，不该为了一条没人走的路留着。
            // 已存在的 auth.db 不删（不动用户机器上的文件），只是不再创建、不再暴露。

            Ok(())
        })
        // 窗口关掉 = 它拉起来的 MCP 服务该收了。
        //
        // 在这之前整个 App 一个窗口事件监听都没注册：关掉一个副窗口，它那些 MCP 子进程
        // （node / uvx / mcp-remote）会一直活到退出 App，用户开开关关几次项目窗口，机器上就
        // 堆着一串没人用的进程。`cleanup_stale` 补不了这个洞——它是按进程收尸的，多窗口时会
        // 把别的窗口正在用的一起杀掉，所以那边多窗口直接跳过（见上面的说明）。MCP 会话现在
        // 按 (窗口, 根目录, 服务名) 分区，只有这里能做到「只收这一个窗口的」。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                mcp::stop_window(window.label());
            }
        })
        .manage(terminal::TerminalState::default())
        .manage(lsp::LspManager::default())
        .manage(debug::DebugManager::default())
        .manage(proxy::ProxyState::default())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            cleanup::cleanup_scan,
            cleanup::cleanup_apply,
            files::register_workspace_root,
            files::create_project_dir,
            files::read_dir,
            files::read_text_file,
            files::read_log_tail,
            files::read_file_data_url,
            files::inspect_file,
            archive::extract_archive,
            archive::read_archive_entry,
            tabular::read_table_file,
            repos::list_repositories,
            files::write_text_file,
            files::write_text_file_if_unchanged,
            files::write_text_file_if_unchanged_hashed,
            files::delete_text_file_if_unchanged,
            files::write_tmp_file,
            files::home_dir,
            files::create_file,
            files::create_dir,
            files::rename_path,
            files::copy_path,
            files::path_kinds,
            files::import_path,
            files::delete_path,
            files::search_in_project,
            files::list_project_files,
            files::replace_in_file,
            files::replace_in_project,
            conversation_store::conversation_snapshot_save,
            conversation_store::conversation_snapshot_load,
            conversation_store::conversation_sessions_index,
            conversation_store::conversation_session_load,
            conversation_store::conversation_transcript_append,
            conversation_store::conversation_transcript_load,
            conversation_store::conversation_transcript_window,
            conversation_store::conversation_transcript_content_slice,
            conversation_store::conversation_transcript_truncate,
            git::git_status,
            git::git_worktree_add,
            git::git_worktree_list,
            git::git_worktree_remove,
            git::git_file_head,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_push,
            git::git_clone,
            git::git_branches,
            git::git_checkout,
            git::git_pull,
            git::git_conflicts,
            git::git_merge_versions,
            git::git_resolve_conflict,
            git::git_log,
            git::git_file_log,
            git::git_file_at,
            git::git_show,
            ui_clone::ui_diff,
            env_probe::probe_env,
            lint::project_lint_run,
            git::git_stash,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_stash_list,
            git::git_blame,
            ai::ai_chat,
            ai::ai_chat_with_tools,
            ai::ai_complete,
            ai::ai_protocols,
            ai::cancel_ai,
            ai::web_fetch,
            ai::web_search,
            net::http_request,
            net::tor_request,
            net::download_file,
            net::generate_image_chat,
            proxy::proxy_available,
            proxy::proxy_status,
            proxy::proxy_start,
            proxy::proxy_stop,
            proxy::proxy_ca_path,
            proxy::proxy_set_system_proxy,
            qr::decode_qr,
            image_location::reverse_geocode_coordinates,
            location::request_current_location,
            db::db_query,
            mcp::mcp_connect,
            mcp::mcp_connect_full,
            mcp::mcp_call,
            mcp::mcp_call_full,
            mcp::mcp_read_resource,
            mcp::mcp_get_prompt,
            mcp::mcp_status,
            mcp::mcp_disconnect,
            mcp::mcp_cancel,
            mcp::mcp_take_changes,
            mcp::mcp_rediscover,
            mcp::mcp_server_log,
            mcp::mcp_pending_auth,
            mcp::mcp_pending_elicitation,
            mcp::mcp_elicit_respond,
            mcp::mcp_user_config,
            mcp::mcp_save_user_config,
            mcp::user_rules_read,
            mcp::user_rules_save,
            // 跨项目技能库（~/.mrdayone/skills）。走独立命令而不是 write_text_file：
            // 那条路的 require_inside_workspace 明确拒绝 HOME 底下的写入。
            mcp::skills_dir,
            mcp::skills_write_file,
            mcp::skills_delete,
            capture::capture_url,
            capture::capture_url_frames,
            browser::browser_navigate,
            browser::browser_click,
            browser::browser_type,
            files::read_document,
            browser::browser_press,
            browser::browser_upload_file,
            browser::browser_eval,
            browser::browser_performance_sample,
            browser::browser_screenshot,
            browser::browser_set_viewport,
            browser::browser_set_marks,
            browser::browser_set_preference,
            browser::browser_get_preference,
            browser::browser_scroll,
            browser::browser_wait,
            browser::browser_cookies,
            browser::browser_storage,
            browser::browser_close,
            browser::browser_user_tabs,
            browser::browser_extract_ui,
            sysctl::system_open_app,
            sysctl::system_list_apps,
            sysctl::system_app_windows,
            sysctl::system_focus_window,
            sysctl::system_menu,
            sysctl::system_menu_items,
            sysctl::system_frontmost,
            extensions::ext_list_installed,
            extensions::ext_read_asset,
            extensions::ext_set_enabled,
            extensions::ext_uninstall,
            extensions::ext_available_builtin,
            extensions::ext_install_builtin,
            extensions::ext_install_from_path,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            terminal::term_running_ids,
            terminal::term_list_commands,
            terminal::term_history,
            shell_env::env_refresh,
            shell_env::shell_plan,
            process_util::shell_env_probe,
            process_util::which_command,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_list,
            lsp::lsp_check_available,
            lsp::lsp_detect_python,
            lsp::lsp_python_env_symbols,
            lsp::lsp_node_env_symbols,
            lsp::lsp_go_env_symbols,
            lsp::lsp_lang_env_symbols,
            debug::dap_start,
            debug::dap_send,
            debug::dap_stop,
            debug::dap_list,
            marketplace::marketplace_list,
            marketplace::marketplace_install,
            marketplace::marketplace_search,
            tasks::tasks_list,
            tasks::task_run_capture,
            watcher::fs_watch,
            watcher::fs_unwatch,
            handoff::handoff_set_session,
            accessibility::read_screen,
            accessibility::probe_screen,
            accessibility::ui_click,
            permissions::permission_status,
            permissions::permission_advice,
            permissions::request_accessibility,
            automation::automation_call,
            knowledge::package_search,
            knowledge::github_search,
            knowledge::github_repo,
            knowledge::gitlab_repo,
            knowledge::gitee_repo,
            knowledge::codeberg_repo,
            knowledge::cve_search,
            knowledge::wiki_search,
            knowledge::stackoverflow_search,
            knowledge::hackernews_search,
            knowledge::developer_community_search,
            knowledge::dockerhub_search,
            knowledge::pubmed_search,
            knowledge::arxiv_search,
            knowledge::crossref_search,
            knowledge::openalex_search,
            knowledge::pubchem_search,
            knowledge::clinical_trials_search,
            knowledge::gitlab_search,
            knowledge::gitee_search,
            knowledge::maven_search,
            knowledge::packagist_search,
            knowledge::rubygems_search,
            knowledge::nuget_search,
            knowledge::homebrew_search,
            knowledge::mdn_search,
            knowledge::cdnjs_search,
            knowledge::bundlephobia_search,
            knowledge::devto_search,
            knowledge::steam_search,
            knowledge::iconify_search,
            knowledge::juejin_search,
            knowledge::codrops_search,
            knowledge::smashingmag_search,
            knowledge::awwwards_search,
            knowledge::v2ex_search,
            knowledge::segmentfault_search,
            knowledge::github_discussions_search,
            knowledge::github_trending,
            knowledge::infoq_search,
            knowledge::codeberg_search,
            knowledge::sourcegraph_search,
            local_discovery::local_discovery,
            public_data::live_environment,
            game::game_scaffold,
            web_scaffold::web_scaffold,
            game_assets::generate_3d,
            game_assets::generate_sound,
            game_assets::generate_music,
            game_assets::generate_voice,
            game_assets::auto_rig,
            game_assets::generate_motion,
            game_assets::generate_texture,
            game_assets::search_game_assets,
            game_assets::download_asset,
            cleanup_stale,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mr. Day One")
        .run(|handle, event| {
            // On app exit, kill every child process (shells / LSP servers / debug
            // adapters) so nothing is left running after the window closes.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                use tauri::Manager;
                handle.state::<terminal::TerminalState>().reset_all();
                handle.state::<lsp::LspManager>().stop_all();
                handle.state::<debug::DebugManager>().stop_all();
                proxy::stop_all(&handle.state::<proxy::ProxyState>()); // reap the mitmdump proxy
                mcp::stop_all(); // reap MCP servers on quit (global map, not Tauri State)
                automation::stop(); // reap the desktop-automation server
                // 浏览器一直不在这张单子上：退出 App 之后无头 Chrome 的整棵进程树还活着，
                // 而它是这堆子进程里最重的一个。cleanup_stale（重载那条路）早就收它了，
                // 只有退出这条漏了。必须用 blocking 版：close_all 把 drop 丢进后台线程，
                // 而这时候进程马上就没了，那个线程根本来不及跑。
                browser::close_all_blocking(std::time::Duration::from_secs(3));
            }
        });
}

#[cfg(all(test, desktop))]
mod tests {

    /// 反漂移：Windows 的应用清单**只能有一份**。
    ///
    /// 踩过的坑：build.rs 为了补 DPI 感知，自己写了一份只含 dpiAwareness 的清单，
    /// 用 `/MANIFESTINPUT` + `/MANIFEST:EMBED` 交给链接器；而 tauri-build 本来就会
    /// 嵌一份自己的。两份 MANIFEST 都是 id 1，链接期直接失败：
    ///   CVTRES : fatal error CVT1100: duplicate resource. type:MANIFEST, name:1
    /// 结果是那次修复让 **Windows 整个编不出来**，而 `cargo xwin check` 是绿的——
    /// check 不做链接，冲突只在链接期出现，一直到 CI 才炸。
    ///
    /// 正确做法：把要加的东西并进 tauri-build 要嵌的那一份里（app_manifest）。
    #[test]
    fn windows_app_manifest_is_embedded_exactly_once() {
        let src = include_str!("../build.rs");
        let code: String = src
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("MANIFESTINPUT"),
            "build.rs 又自己往链接器塞了一份清单 —— 和 tauri-build 嵌的那份撞车，Windows 链接会失败"
        );
        assert!(
            code.contains("app_manifest(WINDOWS_APP_MANIFEST)"),
            "清单没有交给 tauri-build 嵌 —— 要加的东西必须并进它那一份里"
        );
        // 替换掉默认清单之后，默认里那些该有的都得带上，缺一样都是回归。
        for needle in [
            "Microsoft.Windows.Common-Controls",
            "compatibility.v1",
            "asInvoker",
            "PerMonitorV2",
        ] {
            assert!(
                code.contains(needle),
                "清单里少了 {needle} —— 它替换了 tauri-build 的默认清单，默认里有的不能丢"
            );
        }
    }
    use super::should_open_devtools_on_startup;

    #[test]
    fn devtools_stay_closed_on_startup() {
        assert!(!should_open_devtools_on_startup());
    }
}
