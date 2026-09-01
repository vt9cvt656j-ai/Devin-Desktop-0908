import { Button } from "../ui/components/button.jsx";
import { Input } from "../ui/components/input.jsx";

/**
 * 应用外壳 —— 由 index.html 的 markup 机械转换而来（build/html-to-jsx.mjs）。
 *
 * ## 这层的契约
 *
 * main.js 用 `const $ = (id) => document.getElementById(id)` 抓 **159 个 ID**，其中
 * `const treeEl = $("tree")` 这类是**模块顶层**执行的。所以这个组件有两条硬约束：
 *
 *   1. **159 个 ID 一个都不能少。** 少一个的表现是某个按钮静默失灵——不抛错、不红。
 *      test/logic.test.mjs 里有一条测试逐个比对，漏了就红。
 *   2. **必须在 main.js 之前 commit 到 DOM。** 见 src/boot.jsx 的 flushSync。
 *
 * 结构、class、属性都逐字保留，所以 14,111 行 app.css 继续生效，布局不变。
 * shadcn 的升级在这之上单独做——改哪一处，diff 里一目了然。
 */
export function Shell() {
  return (
    <>

        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar__lead">
            <img className="brandmark" src="/logo.png" alt="" aria-hidden="true" />
          </div>
          <nav className="titlebar__menu" id="menubar" aria-label="Main menu"></nav>
          <div className="titlebar__title" id="windowTitle">Mr. Day One</div>
          <div className="titlebar__actions">
            <button id="openFolderBtn" hidden></button>
            <button id="saveBtn" hidden></button>
            <div className="titlebar__action-group titlebar__action-group--panel" aria-label="面板">
              <button className="tbtn tbtn--icon" id="toggleAssistantBtn" type="button" title="隐藏 AI 助手" aria-pressed="true">
                <svg className="ic"><use href="#i-sidebar-right-on" id="toggleAssistantIcon" /></svg>
              </button>
            </div>
            <div className="titlebar__action-group titlebar__action-group--run" data-i18n-aria-label="debug.runGroup" aria-label="运行与调试">
              <button className="tbtn tbtn--icon" id="debugBtn" data-i18n-title="debug.title" data-i18n-aria-label="debug.aria" title="调试 / Debugger (断点、单步、变量)" aria-label="调试">
                <svg className="ic"><use href="#i-bug" /></svg>
                <span data-i18n="debug.aria">Debug</span>
              </button>
              <button className="tbtn tbtn--icon" id="runBtn" data-i18n-title="menu.runCurrentFile" data-i18n-aria-label="menu.runCurrentFile" title="运行当前文件" aria-label="运行当前文件" disabled>
                <svg className="ic"><use href="#i-play" /></svg>
                <span data-i18n="menu.runCurrentFile">Run</span>
              </button>
            </div>
            <div className="titlebar__action-group titlebar__action-group--tools" data-i18n-aria-label="menu.tools" aria-label="工具">
              <button className="tbtn tbtn--icon tbtn--premium" id="michaelPremiumBtn" data-i18n-title="premiumDb.title" data-i18n-aria-label="premiumDb.title" title="Michael Premium — 数据库工具" aria-label="Michael Premium — 数据库工具">
                <svg className="ic"><use href="#i-premiumdb" /></svg>
              </button>
              <button className="tbtn tbtn--icon" id="terminalBtn" title="Toggle terminal">
                <svg className="ic"><use href="#i-terminal" /></svg>
              </button>
              <button className="tbtn tbtn--icon" id="extensionsBtn" data-i18n-title="ext.title" title="Extensions" hidden>
                <svg className="ic"><use href="#i-ext" /></svg>
              </button>
              <button className="tbtn tbtn--icon notif-bell" id="notifBellBtn" data-i18n-title="notifications.title" title="Notifications">
                <svg className="ic"><use href="#i-bell" /></svg>
                <span className="notif-badge" id="notifBadge" hidden></span>
              </button>
              <button className="tbtn tbtn--icon ide-update-btn" id="ideUpdateBtn" type="button" hidden data-i18n-title="updates.check" title="Check for updates" aria-label="Check for updates">
                <span className="ide-update-btn__brand" aria-hidden="true">
                  <img className="ide-update-btn__logo" src="/logo.png" alt="" />
                  <span className="ide-update-btn__new">NEW</span>
                </span>
              </button>
              <div className="settings-wrap">
                <button className="tbtn tbtn--icon" id="settingsBtn" data-i18n-title="feature.settings.title" title="设置">
                  <svg className="ic"><use href="#i-gear" /></svg>
                </button>
                <div className="settings-dropdown" id="settingsDropdown" hidden>
                  <button className="settings-dropdown__header" data-action="login">
                    <svg className="settings-dropdown__avatar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 20c0-3.3 2.7-6 6-6h4c3.3 0 6 2.7 6 6" strokeLinecap="round" />
                    </svg>
                    <div className="settings-dropdown__account">
                      <div className="settings-dropdown__name" data-i18n="account.notSignedIn">未登录</div>
                      <div className="settings-dropdown__hint" data-i18n="account.signInHint">点击登录</div>
                    </div>
                  </button>
                  <div className="settings-dropdown__divider"></div>
                  <button className="settings-dropdown__item" data-action="profile" id="profileBtn" hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="8" r="3" /><path d="M6 18c0-2.5 2-5 6-5s6 2.5 6 5" /></svg>
                    <span data-i18n="account.profile">个人资料</span>
                  </button>
                  <button className="settings-dropdown__item" data-action="billing" id="billingBtn" hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <path d="M2 10h20" />
                      <path d="M6 15h4" />
                      <path d="M14 15h4" />
                    </svg>
                    <span data-i18n="account.billing">账单</span>
                  </button>
                  <div className="settings-dropdown__divider" id="accountActionsDivider" hidden></div>
                  <button className="settings-dropdown__item" data-action="general-settings">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span data-i18n="account.generalSettings">通用设置</span>
                  </button>
                  <button className="settings-dropdown__item" data-action="shortcuts">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="3" />
                      <rect x="5" y="7" width="3" height="3" rx=".5" opacity=".6" />
                      <rect x="10" y="7" width="4" height="3" rx=".5" opacity=".6" />
                      <rect x="16" y="7" width="3" height="3" rx=".5" opacity=".6" />
                      <rect x="5" y="12" width="4" height="3" rx=".5" opacity=".6" />
                      <rect x="11" y="12" width="3" height="3" rx=".5" opacity=".6" />
                      <rect x="16" y="12" width="3" height="3" rx=".5" opacity=".6" />
                      <rect x="7" y="17" width="10" height="2.5" rx=".5" opacity=".4" />
                    </svg>
                    <span data-i18n="account.shortcuts">快捷键</span>
                  </button>
                  <div className="settings-dropdown__divider" id="logoutDivider" hidden></div>
                  <button className="settings-dropdown__item settings-dropdown__item--danger" data-action="logout" id="logoutBtn" hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                    <span data-i18n="account.logout">退出登录</span>
                  </button>
                </div>
              </div>
            </div>
                      {/*
              Windows 的窗口按钮。Windows 版关掉了原生标题栏（tauri.windows.conf.json 的
              decorations:false）——不关的话原生那条会压在这条 44px 的标题栏上面，两条叠着、
              同一个标题显示两遍，那是「Windows 上界面很丑」最直接的原因。关了就得自己画这
              三个键，否则窗口没法最小化/关闭。
              只在 Windows 上显示（body.is-win 控制），macOS 的红绿灯照旧由系统画。
            */}
            <div className="titlebar__winctl" aria-label="窗口控制">
              <button className="winctl" id="winMinimize" type="button" title="最小化" aria-label="最小化">
                <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="1" /></svg>
              </button>
              <button className="winctl" id="winMaximize" type="button" title="最大化" aria-label="最大化">
                <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" fill="none" strokeWidth="1" stroke="currentColor" /></svg>
              </button>
              <button className="winctl winctl--close" id="winClose" type="button" title="关闭" aria-label="关闭">
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" strokeWidth="1.2" stroke="currentColor" fill="none" /></svg>
              </button>
            </div>
</div>
        </div>

        <main className="layout">
          {/* Left: file explorer + search */}
          <aside className="panel explorer" id="explorer">
            <header className="panel__head">
              <div className="seg" id="sideTabs" role="tablist">
                <button className="seg__btn is-active" id="tabExplorer" type="button" role="tab" data-i18n-title="sidebar.explorer" title="文件">
                  <svg className="ic"><use href="#i-files" /></svg><span data-i18n="sidebar.explorer">Explorer</span>
                </button>
                <button className="seg__btn" id="tabGit" type="button" role="tab" title="Git">
                  <svg className="ic"><use href="#i-git" /></svg><span data-i18n="sidebar.source">Source</span>
                </button>
                {/* 调试会话期间才出现。以前调试侧栏是借「测试」页签显示的，
                    测试页签移除后它需要自己的落脚点，否则调试变量/调用栈/断点都没地方放。 */}
                <button className="seg__btn" id="tabDebug" type="button" role="tab" title="调试" hidden>
                  <svg className="ic"><use href="#i-bug" /></svg><span data-i18n="sidebar.debug">调试</span>
                </button>
              </div>
            </header>

            {/* Explorer view */}
            <div className="side-view" id="viewExplorer">
              <div className="explorer__bar">
                <span className="explorer__root" id="rootName" title="" data-i18n="explorer.noFolder">No folder</span>
                <span className="explorer__tools">
                  <button className="iconbtn" id="newFileBtn" type="button" data-i18n-title="explorer.newFile" title="New File" disabled><svg className="ic"><use href="#i-new-file" /></svg></button>
                  <button className="iconbtn" id="newFolderBtn" type="button" data-i18n-title="explorer.newFolder" title="New Folder" disabled><svg className="ic"><use href="#i-new-folder" /></svg></button>
                  <button className="iconbtn" id="refreshTreeBtn" type="button" data-i18n-title="explorer.refresh" title="Refresh" disabled><svg className="ic"><use href="#i-refresh" /></svg></button>
                </span>
              </div>
              <div className="tree" id="tree">
                <div className="empty">
                  <svg className="empty__art" viewBox="0 0 120 96"><use href="#art-folder" /></svg>
                  <p data-i18n="explorer.openHint">Open a folder to get started.</p>
                  <Button id="emptyOpenBtn" data-i18n="explorer.openBtn">Open folder…</Button>
                </div>
              </div>
            </div>

            {/* Search view */}
            <div className="side-view" id="viewSearch" hidden>
              <div className="search-box">
                <div className="search-input">
                  <svg className="ic"><use href="#i-search" /></svg>
                  <input id="searchInput" type="text" data-i18n-placeholder="search.placeholder" placeholder="Search in folder…" spellCheck="false" autoComplete="off" />
                  <button className="iconbtn search-case" id="searchCaseBtn" type="button" data-i18n-title="search.matchCase" title="Match Case" aria-pressed="false">Aa</button>
                </div>
                <div className="search-meta" id="searchMeta"></div>
              </div>
              <div className="search-results" id="searchResults"></div>
            </div>

            {/* Source Control (Git) view */}
            <div className="side-view" id="viewGit" hidden>
              <div className="git-bar">
                <button className="git-branch" id="gitBranchBtn" type="button" data-i18n-title="git.branchHint" title="Current branch — click to switch" aria-haspopup="true" aria-expanded="false">
                  <svg className="ic"><use href="#i-git" /></svg>
                  <span id="gitBranchName">—</span>
                  <svg className="ic git-branch__caret"><use href="#i-chevron" /></svg>
                </button>
                <button className="iconbtn" id="gitPullBtn" type="button" data-i18n-title="git.pull" title="Pull"><svg className="ic"><use href="#i-arrow-down" /></svg></button>
                <button className="iconbtn" id="gitPushBtn" type="button" data-i18n-title="git.push" title="Push"><svg className="ic"><use href="#i-arrow-up" /></svg></button>
                <button className="iconbtn" id="gitStashBtn" type="button" data-i18n-title="git.stash" title="Stash changes"><svg className="ic"><use href="#i-archive" /></svg></button>
                <button className="iconbtn" id="gitRefreshBtn" type="button" data-i18n-title="explorer.refresh" title="Refresh"><svg className="ic"><use href="#i-refresh" /></svg></button>
                <div className="git-branch-menu" id="gitBranchMenu" hidden></div>
              </div>
              <div className="git-commit">
                <textarea id="gitCommitMsg" className="git-commit__msg" rows="1" data-i18n-placeholder="git.commitPlaceholder" placeholder="Message (commit staged changes)"></textarea>
                <button className="git-commit__btn" id="gitCommitBtn" type="button" title="Commit staged changes">
                  <svg className="ic"><use href="#i-check" /></svg><span data-i18n="git.commit">Commit</span>
                </button>
              </div>
              <div className="git-list" id="gitList"></div>
              <div className="git-section-title git-stash-title" style={{ display: "none" }} id="gitStashTitle">
                <span data-i18n="git.stashes">Stashes</span>
                <button className="git-section-act" id="gitStashToggle" type="button" data-i18n-title="git.toggleStashes" title="Toggle stashes">
                  <svg className="ic"><use href="#i-chevron" /></svg>
                </button>
              </div>
              <div className="git-stash-list" id="gitStashList" hidden></div>
              <div className="git-section-title git-log-title" style={{ display: "none" }} id="gitLogTitle">
                <span data-i18n="git.history">History</span>
                <button className="git-section-act" id="gitLogToggle" type="button" data-i18n-title="git.toggleHistory" title="Toggle history">
                  <svg className="ic"><use href="#i-chevron" /></svg>
                </button>
              </div>
              <div className="git-log" id="gitLog" hidden></div>

              {/* 时间线：当前编辑器里这个文件的提交历史（--follow，改过名也接得上）。
                  上面的「历史」是整个仓库的，这里回答的是"这个文件都经历了什么"。 */}
              <div className="git-section-title git-timeline-title" id="gitTimelineTitle">
                <span data-i18n="git.timeline">时间线</span>
                <button className="git-section-act" id="gitTimelineToggle" type="button" data-i18n-title="git.toggleTimeline" title="折叠时间线">
                  <svg className="ic"><use href="#i-chevron" /></svg>
                </button>
              </div>
              <div className="git-timeline" id="gitTimeline"></div>
            </div>

            {/* 大纲 / 测试 两个面板已移除（页签也一并去掉）。大纲里那块时间线
                原本是没有任何代码填充的空壳，现在真正实现了，位置在上面的 Git 面板里。 */}

            {/* Debug view — the 测试 tab turns into this while a debug session is active */}
            <div className="side-view dbg-side" id="viewDebug" hidden>
              <div className="dbg-side__sec">
                <div className="dbg-side__title" data-i18n="debug.variables">变量</div>
                <div className="dbg-side__body" id="dbgSideVars"></div>
              </div>
              <div className="dbg-side__sec">
                <div className="dbg-side__title" data-i18n="debug.callStack">调用栈</div>
                <div className="dbg-side__body" id="dbgSideStack"></div>
              </div>
              <div className="dbg-side__sec">
                <div className="dbg-side__title" data-i18n="debug.breakpoints">断点</div>
                <div className="dbg-side__body" id="dbgSideBps"></div>
              </div>
            </div>
          </aside>

          <div className="panel-sash panel-sash--left" id="sashLeft"></div>

          {/* Center: tabs + editor */}
          <section className="editorwrap">
            <div className="tabs" id="tabs"></div>
            <div className="editor-container" id="editorContainer">
              <div className="editor" id="editor"></div>
            </div>
            <div className="diff-view" id="diffView" hidden>
              <div className="diff-view__head">
                <span className="diff-view__title">
                  <svg className="ic"><use href="#i-git" /></svg>
                  <span id="diffTitle" data-i18n="diff.title">Diff</span>
                  <span className="diff-view__sub" data-i18n="diff.sub">HEAD ↔ Working Tree</span>
                </span>
                <button className="diff-view__close" id="diffClose" type="button" data-i18n-title="diff.close" data-i18n-aria-label="diff.close" title="Close diff" aria-label="Close diff">
                  <svg className="ic"><use href="#i-close" /></svg>
                </button>
              </div>
              <div className="diff-view__body" id="diffBody"></div>
            </div>
            <div className="welcome" id="welcome">
              <h1 data-i18n="welcome.title">Mr. Day One</h1>
              <p data-i18n="welcome.desc">A macOS-style editor with a built-in AI assistant. Open a folder, pick a file, and ask the assistant on the right for help.</p>
              <div className="welcome__actions">
                <Button size="lg" className="welcome__btn welcome__btn--primary" id="welcomeOpenBtn" type="button">
                  <svg className="ic"><use href="#i-folder" /></svg>
                  <span data-i18n="explorer.openBtn">打开文件夹</span>
                </Button>
              </div>
              <div className="welcome__recent" id="welcomeRecent" hidden>
                <h3 data-i18n="welcome.recent">最近项目</h3>
                <ul className="welcome__recent-list" id="recentList"></ul>
              </div>
              <div className="welcome__tips">
                <span className="kbd-tip"><kbd>Ctrl</kbd><kbd>O</kbd> <span data-i18n="explorer.openBtn">打开文件夹</span></span>
                <span className="kbd-tip"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd> <span data-i18n="menu.commandPalette">命令面板</span></span>
                <span className="kbd-tip" data-kbd-combo="enter"><span data-i18n="welcome.tipAsk">询问助手</span></span>
              </div>
              <div className="welcome__copyright">© 2026 Digital Bang Intelligence LLC. All rights reserved.</div>
            </div>
            <div className="problems-panel" id="problemsPanel" hidden>
              <div className="problems-panel__head">
                <span className="problems-panel__title">
                  <svg className="ic" aria-hidden="true"><use href="#i-error" /></svg>
                  <span data-i18n="problems.title">Problems</span>
                  <span className="problems-panel__counts" id="problemsPanelCounts"></span>
                </span>
                <button className="problems-panel__close" id="problemsClose" type="button" data-i18n-title="problems.close" title="Close panel" aria-label="Close problems">
                  <svg className="ic"><use href="#i-close" /></svg>
                </button>
              </div>
              <div className="problems-panel__body" id="problemsBody"></div>
            </div>
            <div className="terminal-panel" id="terminalPanel" hidden>
              <div className="terminal-panel__resize" id="terminalResize"></div>
              <div className="terminal-panel__head">
                <div className="term-tabs" id="termTabBar"></div>
                <div className="terminal-panel__actions">
                  <button className="terminal-panel__action" id="termSplitBtn" type="button" data-i18n-title="terminal.split" title="Split Terminal">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5" /><line x1="8" y1="2" x2="8" y2="14" /></svg>
                  </button>
                  <button className="terminal-panel__action" id="termNewBtn" type="button" data-i18n-title="terminal.new" title="新建终端">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                  </button>
                  <button className="terminal-panel__action" id="termMaxBtn" type="button" title="Maximize Panel">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
                  </button>
                  <button className="terminal-panel__action" id="terminalClose" type="button" title="Close panel" aria-label="Close panel">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
                  </button>
                </div>
              </div>
              <div className="terminal-panel__body" id="terminalBody"></div>
            </div>
            <div className="output-panel" id="outputPanel" hidden>
              <div className="output-panel__head">
                <span className="output-panel__title" data-i18n="output.title">输出</span>
                <select className="output-panel__channel" id="outputChannel">
                  <option value="lsp" data-i18n="output.channel.lsp">语言服务</option>
                  <option value="tasks" data-i18n="output.channel.tasks">任务</option>
                  <option value="extensions" data-i18n="output.channel.extensions">扩展</option>
                </select>
                <div className="output-panel__actions">
                  <button className="terminal-panel__action" id="outputClearBtn" type="button" title="Clear Output"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 3l10 10M13 3l-10 10" /></svg></button>
                  <button className="terminal-panel__action" id="outputCloseBtn" type="button" data-i18n-title="terminal.closeTab" title="Close"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button>
                </div>
              </div>
              <pre className="output-panel__body" id="outputBody"></pre>
            </div>
          </section>

          <div className="panel-sash panel-sash--right" id="sashRight"></div>

          {/* Right: AI assistant */}
          <aside className="panel assistant" id="assistant">
            <header className="panel__head panel__head--assistant">
              <span className="assistant__brand">
                <span className="assistant__avatar assistant__avatar--logo">
                  <img className="assistant-logo" src="/logo.png" alt="" aria-hidden="true" />
                </span>
                <span className="assistant__name" data-i18n="assistant.name">Assistant</span>
                <span id="ipcPeerCount"></span>
              </span>
              <span className="assistant__actions">
                <span className="assistant-capability" id="capabilitiesMenuWrap">
                  <button className="assistant__action assistant__action--capabilities" id="capabilitiesBtn" type="button" data-i18n-title="assistant.capabilities" data-i18n-aria-label="assistant.capabilities.open" title="能力菜单" aria-label="打开用户习惯和用户规则菜单" aria-haspopup="menu" aria-expanded="false"></button>
                  {/* 每项只有一行：图标 + 一个词。副标题删掉了——那两句本来就是错的
                      （技能面板同时装项目技能，"所有项目通用"是假话），而且这个应用里
                      别的下拉全是单行，两行排版只有这一处，显得又高又空。 */}
                  <span className="assistant-capability__menu" id="capabilitiesMenu" role="menu" hidden>
                    <button className="assistant-capability__item" id="capabilityHabitsItem" type="button" role="menuitem">
                      <span className="assistant-capability__item-icon"></span>
                      <span data-i18n="assistant.capability.habits">用户习惯</span>
                    </button>
                    <button className="assistant-capability__item" id="capabilityRulesItem" type="button" role="menuitem">
                      <span className="assistant-capability__item-icon"></span>
                      <span data-i18n="assistant.capability.rules">用户规则</span>
                    </button>
                    {/* 自动化用哪个浏览器。放这里而不是只留一个环境变量：装了 Chrome
                        就只能用 Chrome 是以前的实际行为，而"把自己的 Chrome 留给自己、
                        让自动化去用 Edge"恰恰能让两个一模一样的图标从根上消失。 */}
                    <button className="assistant-capability__item" id="capabilityBrowserItem" type="button" role="menuitem">
                      <span className="assistant-capability__item-icon"></span>
                      <span data-i18n="assistant.capability.browser">浏览器</span>
                    </button>
                    {/* 用户自己接进来的工具、知识库、角色、命令。带一个出错角标——声明写错
                        时以前是彻底静默的，用户只能怀疑自己路径写错了。 */}
                    <button className="assistant-capability__item" id="capabilityCapsItem" type="button" role="menuitem">
                      <span className="assistant-capability__item-icon"></span>
                      <span data-i18n="assistant.capability.caps">我的能力</span>
                      <span className="assistant-capability__badge" id="capabilityCapsBadge" hidden></span>
                    </button>
                  </span>
                </span>
              </span>
            </header>
            <div id="chatTabBar"></div>
            <div className="chat" id="chat"></div>
            <form className="composer" id="composer">
              {/* 「回到最新」。放在 composer 里而不是 #chat 里：切标签时 chatEl 的子节点
                  会被整个清空（main.js 的 removeChild 循环），放进去第一次切标签就没了。 */}
              <button type="button" id="chatJump" className="chat-jump" hidden
                data-i18n-title="assistant.jumpToLatest" title="回到最新">
                <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3v9m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span data-i18n="assistant.jumpToLatest">回到最新</span>
              </button>
              <div className="composer__box">
                <div id="prompt" contentEditable="true" role="textbox" aria-multiline="true" data-i18n-placeholder="assistant.placeholder" data-placeholder="询问关于当前文件的问题…"></div>
                <div className="composer__bar">
                  <div className="mode-picker" id="modePicker">
                    <button className="mode-picker__btn" id="modePickerBtn" type="button" data-i18n-title="assistant.mode.switch" title="切换 AI 模式">
                      <svg className="ic mode-picker__icon" id="modeIcon" viewBox="0 0 16 16"><circle cx="8" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3 14c0-3 2-5 5-5s5 2 5 5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M11 3l2-1m-2 1l2 1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>
                      <span id="modeLabel" data-i18n="assistant.mode.agent">Agent</span>
                      <svg className="ic mode-picker__caret" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <div className="mode-menu" id="modeMenu" hidden></div>
                  </div>
                  <div className="model-picker" id="modelPicker">
                    <button className="model-picker__btn" id="modelPickerBtn" type="button" data-i18n-title="assistant.switchModel" title="切换模型" aria-haspopup="listbox" aria-expanded="false">
                      <svg className="ic"><use href="#i-cpu" /></svg>
                      <span className="model-picker__label" id="modelPickerLabel" data-i18n="assistant.selectModel">选择模型</span>
                      <svg className="ic model-picker__caret"><use href="#i-caret" /></svg>
                    </button>
                    <div className="menu" id="modelMenu" role="listbox" hidden></div>
                  </div>
                  <span className="cache-ring" id="tokenMeter" role="status" aria-label="上下文 0%" data-tooltip="上下文占用：0 tokens">
                    <svg className="cache-ring__svg" viewBox="0 0 36 36" aria-hidden="true">
                      <circle className="cache-ring__track" cx="18" cy="18" r="15.5"></circle>
                      <circle className="cache-ring__progress" cx="18" cy="18" r="15.5" pathLength="100"></circle>
                    </svg>
                    <span className="cache-ring__label">0</span>
                  </span>
                  <button className="voice-btn" id="voiceBtn" type="button" data-i18n-title="voice.input" data-i18n-aria-label="voice.input" title="语音输入" aria-label="语音输入">
                    <svg className="voice-btn__mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /><path d="M12 19v3" /></svg>
                    <span className="voice-btn__wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
                  </button>
                  <span className="composer__hint"></span>
                  {/* 首屏这一份要和 main.js 的 _SEND_ICON 一模一样：不一致的话，第一次
                      发送前后箭头会换一种画法。 */}
                  <button className="send" id="sendBtn" type="submit" data-i18n-title="assistant.send" title="发送">
                    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M5.5 11.5L12 5l6.5 6.5" /></svg>
                  </button>
                </div>
              </div>
            </form>
          </aside>
        </main>

        {/* Status bar */}
        <footer className="statusbar" id="statusbar">
          <div className="statusbar__left">
            <button className="statusbar__item statusbar__item--btn" id="paletteBtn" data-i18n-title="menu.commandPalette" title="命令面板">
              <svg className="ic"><use href="#i-command" /></svg>
              <span data-i18n="statusbar.commands">Commands</span>
            </button>
            <button className="statusbar__item statusbar__item--btn" id="problemsBtn" title="Problems" aria-label="Problems">
              <span className="statusbar__diag"><svg className="ic"><use href="#i-error" /></svg><span id="problemsErrCount">0</span></span>
              <span className="statusbar__diag"><svg className="ic"><use href="#i-warn" /></svg><span id="problemsWarnCount">0</span></span>
            </button>
          </div>
          <div className="statusbar__right" id="statusbarRight"></div>
        </footer>

        {/* Login dialog */}
        <dialog className="sheet login-sheet" id="loginDialog">
          <div className="sheet__body login-body">
            <button className="login-close" type="button" id="loginCloseBtn">✕</button>
            <div className="login-logo" id="loginLogo"></div>
            <h2 className="login-title" data-i18n="login.title">欢迎使用 Mr. Day One</h2>
            {/* Step 1: email */}
            <div className="login-step" id="loginStep1">
              <p className="login-sub" data-i18n="login.subtitle">输入邮箱即可登录，新用户自动创建账号</p>
              <div className="login-field">
                <Input id="loginEmail" type="email" placeholder="your@email.com" />
              </div>
              <Button className="w-full" type="button" id="loginNextBtn" data-i18n="login.next">继续</Button>
              <p className="login-agree"><input type="checkbox" defaultChecked /><span data-i18n="login.agreePrefix">我已阅读并同意</span><a href="#" data-i18n="login.terms">服务条款</a><span data-i18n="login.and">和</span><a href="#" data-i18n="login.privacy">隐私政策</a></p>
            </div>
            {/* Step 2: password or code */}
            <div className="login-step" id="loginStep2" hidden>
              <p className="login-sub" id="loginStep2Hint"></p>
              <div className="login-field">
                <Input id="loginPassword" type="password" data-i18n-placeholder="login.passwordPlaceholder" placeholder="输入密码" />
              </div>
              <div className="login-field login-otp-field" id="loginCodeField" hidden>
                <p className="login-otp-hint" data-i18n="login.codeHint">输入发送到邮箱的 6 位验证码</p>
                <div className="login-otp" id="loginOtp" role="group" aria-label="6 位验证码">
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" autoComplete="one-time-code" aria-label="第 1 位" />
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" aria-label="第 2 位" />
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" aria-label="第 3 位" />
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" aria-label="第 4 位" />
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" aria-label="第 5 位" />
                  <input className="login-otp__box" inputMode="numeric" maxLength="1" aria-label="第 6 位" />
                </div>
                <input id="loginCode" type="hidden" />
                <button className="login-link login-resend" type="button" id="loginResendBtn" data-i18n="login.resend">重新发送验证码</button>
              </div>
              <Button className="w-full" type="button" id="loginSubmitBtn" data-i18n="login.submit">登录</Button>
              <div className="login-alt">
                <button className="login-link" type="button" id="loginUseCodeBtn" data-i18n="login.useCode">使用验证码登录</button>
                <button className="login-link" type="button" id="loginBackBtn" data-i18n="login.back">返回</button>
              </div>
            </div>
          </div>
        </dialog>

        {/* Settings dialog */}
        <dialog className="sheet" id="settings">
          <form method="dialog" className="sheet__body" id="settingsForm">
            <div className="sheet__icon"><svg viewBox="0 0 24 24"><use href="#i-sparkle" /></svg></div>
            <h2 data-i18n="settings.title">AI 模型</h2>
            <p className="sheet__sub" data-i18n="settings.sub">模型请求固定走 Michael 网关，统一账号额度、计费、模型目录和线路容灾；用户无需配置任何第三方供应商。</p>
            <div className="ai-provider-form ai-provider-form--locked">
              <div className="ai-provider-option ai-provider-option--locked">
                <span><strong data-i18n="settings.gatewayTitle">Michael 网关</strong><small data-i18n="settings.gatewayEnabled">已启用：所有 AI 模型请求都会通过你的网关转发。</small></span>
              </div>
            </div>
            <div className="settings-figma">
              <label className="settings-figma__label" htmlFor="figmaTokenInput">Figma 访问令牌 <small>（可选，用于把 Figma 设计转成代码/配色）</small></label>
              <div className="settings-figma__row">
                <input id="figmaTokenInput" className="settings-figma__input" type="password" autoComplete="off" autoCapitalize="off" spellCheck="false" placeholder="figd_…" />
                <Button variant="outline" className="settings-figma__test" type="button" id="figmaTokenTest">测试</Button>
              </div>
              <div className="settings-figma__hint" id="figmaTokenHint">figma.com → Settings → Security → Personal access tokens（勾 File content 读权限）。只存在本机，供 <code>figma</code> 工具读取你的设计文件。</div>
            </div>
            {/* Code hosts, alongside Figma: same shape, same storage, same promise — the token
                stays on this machine and goes straight to the provider, never to the gateway. */}
            <div className="settings-figma">
              <label className="settings-figma__label" htmlFor="githubTokenInput">GitHub 访问令牌 <small>（可选，用于在 @ 里直接选择仓库）</small></label>
              <div className="settings-figma__row">
                <input id="githubTokenInput" className="settings-figma__input" type="password" autoComplete="off" autoCapitalize="off" spellCheck="false" placeholder="github_pat_… / ghp_…" />
              </div>
              <div className="settings-figma__hint">github.com → Settings → Developer settings → Personal access tokens（只读 repo 权限即可）。只存在本机。</div>
            </div>
            <div className="settings-figma">
              <label className="settings-figma__label" htmlFor="gitlabTokenInput">GitLab 访问令牌 <small>（可选，用于在 @ 里直接选择仓库）</small></label>
              <div className="settings-figma__row">
                <input id="gitlabTokenInput" className="settings-figma__input" type="password" autoComplete="off" autoCapitalize="off" spellCheck="false" placeholder="glpat-…" />
              </div>
              <div className="settings-figma__hint">gitlab.com → 用户设置 → 访问令牌（read_api 即可）。只存在本机。</div>
            </div>
            {/* 单次运行的 token 天花板。这个机制一直都在（_readTokenCap → 超限就不再硬扩
                步数、并在收尾提醒），但**从来没有任何界面能填它**——localStorage 那个键
                全仓只有读、没有一处写，于是 cap 恒为 0（=不限），而代码里两处注释写着
                「烧钱由用户自设的 token 预算兜住」。它是整个智能体循环唯一的数值天花板。 */}
            <div className="settings-figma">
              <label className="settings-figma__label" htmlFor="tokenBudgetInput">单次运行 token 预算 <small>（可选，0 或留空 = 不限）</small></label>
              <div className="settings-figma__row">
                <input id="tokenBudgetInput" className="settings-figma__input" type="number" min="0" step="1000" inputMode="numeric" autoComplete="off" placeholder="例如 200000" />
              </div>
              <div className="settings-figma__hint">一次运行累计消耗超过这个数之后，不再自动扩展步数，并在收尾时提醒你。只存在本机。</div>
            </div>
            <div className="sheet__actions">
              <Button variant="outline" value="cancel" formNoValidate data-i18n="dialog.cancel">取消</Button>
              <Button id="settingsSaveBtn" value="default" data-i18n="settings.gotIt">知道了</Button>
            </div>
          </form>
        </dialog>

        {/* Devin API key dialog */}
        <dialog className="sheet" id="devinKeyDialog">
          <form method="dialog" className="sheet__body" id="devinKeyForm">
            <div className="sheet__icon"><svg viewBox="0 0 24 24"><use href="#i-sparkle" /></svg></div>
            <h2 data-i18n="devin.title">连接 Devin</h2>
            <p className="sheet__sub"><span data-i18n="devin.subPrefix">输入你的 Devin API Key（以</span> <code>apk_</code> <span data-i18n="devin.subSuffix">开头），助手将直接对接真实的 Devin 会话。密钥只保存在本地。</span></p>
            <Input id="devinKeyInput" type="password" placeholder="apk_..." autoComplete="off" spellCheck="false" />
            <div className="sheet__actions">
              <Button variant="outline" value="cancel" formNoValidate data-i18n="dialog.cancel">取消</Button>
              <Button value="save" data-i18n="settings.save">保存</Button>
            </div>
          </form>
        </dialog>

        {/* File-operation dialog (prompt / confirm) */}
        <dialog className="sheet sheet--io" id="ioDialog">
          <form method="dialog" className="sheet__body" id="ioForm">
            <h2 id="ioTitle">Rename</h2>
            <p className="sheet__sub" id="ioMessage" hidden></p>
            <label id="ioInputWrap">
              <input id="ioInput" type="text" spellCheck="false" autoComplete="off" />
            </label>
            <div className="sheet__actions">
              <Button variant="outline" type="button" id="ioCancel" data-i18n="dialog.cancel">Cancel</Button>
              <Button id="ioOk" value="ok" data-i18n="dialog.ok">OK</Button>
            </div>
          </form>
        </dialog>

        <div className="toast" id="toast"></div>
    </>
  );
}
