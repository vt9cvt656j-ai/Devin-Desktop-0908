/**
 * Single source of truth for what a tool IS, so the harness stops re-deciding it.
 *
 * # The problem this replaces
 *
 * Every property the harness needs to know about a tool before running it — does it change
 * the workspace, does it need approval, may a read-only mode run it, does a worker's scope
 * apply, do repository hooks fire — was written as a literal list at the point of use. The
 * mutation family alone (`["write","edit","multiedit","delete","move","mkdir","copy","format"]`)
 * appeared **eleven times** in `main.js`, each an independent copy.
 *
 * That is the growth tax. Adding one tool meant finding eleven places and remembering the
 * right subset for each. Missing one is silent: a tool left out of the read-only-mode list is
 * quietly executable in Explorer/Plan/Reviewer, and nothing fails until a user notices.
 *
 * # The model
 *
 * A tool declares capability FLAGS once. Every named set the harness used to hard-code is a
 * derived query over those flags, so the sets can never disagree with each other again.
 *
 * Only tools whose policy differs from the default are listed. The default — read-only, no
 * approval, no hooks, runnable in every mode — is correct for the large majority of the
 * catalogue (every `*_search`, every lookup, every inspection tool), so listing them would be
 * noise that rots. A tool type that is not registered gets the default, which is also what
 * makes adding a read-only tool a zero-edit operation.
 *
 * # Adding a tool
 *
 *   defineTool("my_tool", { mutatesWorkspace: true, needsApproval: true });
 *
 * That is the whole change. No list hunting.
 *
 * This module is pure data + pure functions with no DOM, no I/O and no imports, so its tests
 * `import` it directly instead of scraping source text out of `main.js`.
 */

/** Policy for a tool type nobody has registered: safe, inert, universally available. */
export const DEFAULT_POLICY = Object.freeze({
  /**
   * The tool's result carries a trustworthy `mutated` boolean, so `mutated === false` is
   * evidence it really changed nothing (rather than absence of information).
   *
   * Deliberately NOT true for `cmd`/`termtask`: a shell command may well change the
   * workspace, but it does not report whether it did, and treating a missing flag as
   * "no-op" would mark every command as neutral.
   */
  mutatesWorkspace: false,
  /** One of the structured file operations (the family that shares read-before-edit, path
   *  binding, conflict handling). A generator that emits files mutates the workspace but is
   *  NOT a file operation, which is exactly the distinction the old lists kept blurring. */
  fileMutation: false,
  /** Writes file CONTENT specifically (write/edit/multi_edit/format) — the subset that
   *  participates in diagnostics and diff review. */
  fileEdit: false,
  /** Needs user approval when "approve before changes" is on. */
  needsApproval: false,
  /** Repository `pre_tool_use` / `post_tool_use` hooks fire around it. */
  hooked: false,
  /** Refused in the read-only modes (Explorer / Plan / Reviewer). */
  readOnlyModeBlocked: false,
  /**
   * 只读模式挡下来时，告诉模型「禁止**什么**」的那个动词短语。
   *
   * 空串 = 用默认的「修改文件」。这个字段存在的理由：那句话原来是执行器里一条七分支的
   * `?:` 阶梯，只认得 cmd / termtask / mcp / userhttp / userfolder / createproject /
   * worktree，其余 20 个会被只读模式挡下的类型**全部**落到默认分支。于是 Plan 模式下
   * 读一眼用户开着哪些标签页（browser mytabs）、看一眼 GitHub PR、开个 App 看看，
   * 收到的都是「Plan 模式下禁止修改文件」——模型据此以为自己碰了文件，然后去改别的路子。
   *
   * 放在声明里而不是执行器里，是为了让「加了新的只读禁令却忘了配话术」当场可查：
   * tool-policy.test.mjs 有一条断言要求 readOnlyBlockedTypes() 里每一个类型，要么属于
   * 文件族（默认话术就是对的），要么在这里写明动词。
   */
  readOnlyBlockedVerb: "",
  /** Which argument carries the path a worker sub-agent's scope is checked against.
   *  Empty string = this tool is not scope-checked. */
  scopeField: "",
  /** A [BLOCKED]/[CONFLICT] result is a recoverable policy stop rather than a hard failure,
   *  so it must not count toward the three-strike tool lockout. */
  recoverableBlock: false,
  /**
   * 同一轮里能和别的只读调用**并行**跑。布尔，或按调用判的函数（git 只有读 op 能并行）。
   *
   * 这是 Claude Code 每个工具自己声明的 isConcurrencySafe 那一位。此前它在 main.js 里是一份
   * 手写名单 `_READ_ONLY_TYPES`，和子体的 `_READ_TYPES` 各抄一份，漂过不止一次（那段注释
   * 自己记着「两份手写名单漂了，这是第 N 次」）。声明放在这里之后，名单成了推导物；
   * tool-policy.test.mjs 有一条断言把 main.js 那份文本和 parallelSafeTypes() 逐个对账。
   *
   * 默认 false：没有证据说它不动东西，就不并行——和只读模式那道门同一条纪律。
   */
  parallelSafe: false,
});

/** file-mutation defaults, shared by the eight structured file operations. */
const FILE_OP = {
  mutatesWorkspace: true,
  fileMutation: true,
  needsApproval: true,
  hooked: true,
  readOnlyModeBlocked: true,
  recoverableBlock: true,
};
/** the four that write content (and therefore reach diagnostics + diff review). */
const FILE_CONTENT_OP = { ...FILE_OP, fileEdit: true, scopeField: "path" };
/** a generator that lands assets in the workspace: mutating, but not a file operation. */
// 只读模式也要挡：它们真的往工作区写文件（genimage 落 png、web_scaffold 铺一整棵项目树），
// 此前 readOnlyModeBlocked 取默认 false，于是 Plan / Explorer / Reviewer 里生成一张图、
// 铺一个脚手架都畅通无阻——而同一时刻 write_file 写一个字节都被挡。审批开着时还有审批
// 兜着；审批关掉的用户在只读模式里什么都拦不住。
const GENERATOR = { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "生成素材并写进工作区" };
/** an execution tool: side effects the harness cannot verify, but no `mutated` report. */
const EXEC = { needsApproval: true, hooked: true };
/**
 * browser 工具里**纯观察**的动作：看页面、量视口、截图、读网络面板、滚动、悬停。
 * 它们不改页面状态、不动会话、不碰本机文件，所以只读模式该放行、审批门也不必拦。
 *
 * 其余动作都算副作用，要过审批、只读模式挡下：click / type / fill / autofill 这类替用户
 * 按下按钮的，eval 任意 JS，upload 传**本机绝对路径**的文件，cookies / storage 直接读走
 * 登录态，batch 一次跑一串（里面可以是任何动作）。
 *
 * 名单必须照着 schema 里 action 的枚举写——手打会漏，上一版就漏了一半还多写了四个
 * 不存在的动作。ide/test/tool-policy.test.mjs 有断言比对两边。
 */
export const BROWSER_OBSERVE_ACTIONS = new Set([
  // mytabs 读的是**用户自己浏览器**已经开着的标签页标题和 URL（macOS，不起自动化窗口）。
  // 它三条都不沾：不改页面状态、不动会话、不碰本机文件——按上面那条判据它就是观察。
  // 漏了它的代价恰好落在最需要它的地方：Explorer / Plan / Reviewer 三个只看不动的模式里
  // 问不出「用户现在开着什么页面」，而那正是这三个模式做判断的起点。
  // （`open` 不进：它在用户机器上**启动一个外部应用**，工作区没变不等于现实世界没变。）
  "mytabs",
  // read（把页面当文档分页读）/ find（按文字 / 正则 / 角色定位）：只读 DOM，不改页面状态。
  "read", "find",
  "navigate", "observe", "viewport", "screenshot", "design", "network", "inspect",
  "nodes", "assert", "check", "wait", "scroll", "wheel", "swipe", "hover", "focus", "blur", "close",
]);

const REGISTRY = new Map();

/**
 * Register or override a tool's policy. Unspecified fields fall back to the default, so a
 * declaration states only what is unusual about the tool.
 */
export function defineTool(type, policy = {}) {
  const name = String(type || "").trim();
  if (!name) throw new Error("defineTool requires a tool type");
  const unknown = Object.keys(policy).filter((k) => !(k in DEFAULT_POLICY));
  // A typo'd flag would silently do nothing — exactly the class of bug this module exists to
  // remove — so refuse it at declaration time instead of at 3am.
  if (unknown.length) throw new Error(`unknown tool policy field(s) for "${name}": ${unknown.join(", ")}`);
  REGISTRY.set(name, Object.freeze({ ...DEFAULT_POLICY, ...policy }));
  return REGISTRY.get(name);
}

/**
 * automation 里**纯观察**的方法名（按 `.` 分段的最后一段）：拍屏、问指针、读页面、读剪贴板。
 * 和 main.js `_toolMayProduceExternalEffect` 里那条正则**必须**逐字相同——那边是外部副作用
 * 判定，这边是审批 / 只读门，两处对同一件事说不同的话就是事故。tool-policy.test.mjs 对账。
 */
export const AUTOMATION_OBSERVE_METHODS = /(?:^|\.)(?:get|read|list|status|inspect|nodes|check|screenshot|capture|position|info|wait)$/i;

/**
 * 能和别的只读调用并行的纯读类型。四个执行体都核过：无写盘、无建目录、无删除、
 * 不碰共享的自动化浏览器。`*_search` 一族由 main.js 按后缀放行，不逐个列。
 */
export const PARALLEL_SAFE_READS = Object.freeze([
  "read", "list", "search", "find", "web", "websearch", "lsp", "screenshot", "diag", "think",
  "recall", "termread", "termlist", "logs", "search_tools", "skill", "guide", "current_time",
  "localdiscovery", "liveenvironment", "github_repo", "gitlab_repo", "gitee_repo", "codeberg_repo",
  "semsearch", "findsymbol", "viewimage", "probeenv", "readscreen",
  "search_game_assets", "package_source", "openapi_parser", "qr", "realtime_news_feed",
]);

/** system 工具里**纯读**的那几个动作。取自 tools.json 的 action 枚举
 *  （open / menu / menu_items / apps / windows / focus / frontmost），读的是
 *  apps、windows、frontmost、menu_items；open / focus / menu 会动真格。 */
const SYSTEM_READ_OPS = new Set(["apps", "windows", "frontmost", "menu_items"]);

/** Every declaration whose policy differs from the default. */
function seed() {
  // ── structured file operations ────────────────────────────────────────────
  for (const t of ["write", "edit", "multiedit"]) defineTool(t, FILE_CONTENT_OP);
  /*
   * `subagent` 这一类里有一个会**写工作区文件**的：generate_wiki（带 _wiki）把报告落成
   * dest 指定的那个文件，路径由模型给，默认 PRODUCT_WIKI.md，但传 "README.md" 就覆盖
   * README。落盘发生在主循环的结果处理里、不在工具执行器里，于是这道门从头到尾没被
   * 问过：Explorer / Plan / Reviewer 三个只读模式下它照样写盘，开着「改动前审批」时
   * 也一框不弹——而隔壁 write_file 写一个字节就要弹。
   *
   * 其余的 run_subagent / research_project / design_research 是纯调研，只读模式必须
   * 照常放行（只读模式本来就靠它们干活），所以按 call 判、不按类型判。
   *
   * 光声明还不够：真正的检查点要写在那次落盘前面（见 main.js 里 it.call._wiki 那段），
   * 因为那条路径压根不经过工具执行器。这里的声明是让「这个工具的策略」有一个唯一出处。
   */
  const isWikiWrite = (call) => !!call?._wiki;
  defineTool("subagent", { needsApproval: isWikiWrite, readOnlyModeBlocked: isWikiWrite, readOnlyBlockedVerb: "派会写文件的子智能体" });
  // `format` writes content like the other three, but repository hooks deliberately do NOT
  // fire for it: formatting is a mechanical rewrite of code the hooks already saw, and firing
  // a lint hook on every auto-format was noise.
  defineTool("format", { ...FILE_CONTENT_OP, hooked: false });
  defineTool("mkdir", { ...FILE_OP, scopeField: "path" });
  /*
   * 存技能落的是 `~/.mrdayone/skills/<名字>/SKILL.md`——**家目录技能库，不在工作区里**。
   *
   * 于是三条登记跟着变（2026-08-22 落点从工作区改到家目录）：
   *   · 去掉 mutatesWorkspace：它一个工作区文件都不碰。留着会把一次不碰工作区的写入
   *     报成"改了工作区"，`mutated` 这个字段就不再是证据。
   *   · 去掉 scopeField：worker 的 scope 是工作区内的相对路径清单，而技能库是绝对路径，
   *     必然落在任何 scope 之外——子智能体收尾时存技能会被"超出 scope"整条拒掉。
   *   · 去掉 hooked：工作区的 pre_tool_use hook 是这个仓库配的，对一个不落在这个项目里
   *     的写入没有管辖权。
   * 保留的是 needsApproval（它在用户家目录里建文件）和 readOnlyModeBlocked（只读模式
   * 不许留下任何持久化写入）。语义上它现在和 mcpconfig 同类：改的是**跨项目的持久化
   * 配置**，不是工作区内容。
   */
  defineTool("saveskill", { needsApproval: true, readOnlyModeBlocked: true, recoverableBlock: true, readOnlyBlockedVerb: "把技能写进技能库" });
  // 改 MCP 配置：不是工作区文件改动，但是**持久化配置** + 注册一条可执行命令行。
  // list 是只读的，不该弹框；其余四个动作一律要用户点头。只读模式下一概不许改配置。
  defineTool("mcpconfig", {
    needsApproval: (call) => String(call?.action || "list").trim().toLowerCase() !== "list",
    hooked: true,
    readOnlyModeBlocked: (call) => String(call?.action || "list").trim().toLowerCase() !== "list",
    readOnlyBlockedVerb: "改 MCP 配置",
    recoverableBlock: true,
  });
  // 定时任务和 mcpconfig 是同一类东西：**它改变的是将来的自主行为**，而不是当下这一步。
  // 一条排好的任务会在没人看着的时候把智能体重新拉起来，所以建/删必须由用户点头——
  // 网页正文、仓库文件、命令输出里的内容都可能诱导模型偷偷排一条常驻指令，那是这个
  // 项目一直在防的注入面。list 只是读，不弹框。
  //
  // 顺带说明这道门在无人值守下的效果：定时任务跑起来的那一轮里 add/remove 会被自动
  // 拒绝（审批门的无人值守分支），也就是说定时任务不能自己给自己续命或者繁殖。
  defineTool("schedule", {
    needsApproval: (call) => String(call?.action || "list").trim().toLowerCase() !== "list",
    readOnlyModeBlocked: (call) => String(call?.action || "list").trim().toLowerCase() !== "list",
    readOnlyBlockedVerb: "建 / 改定时任务",
    recoverableBlock: true,
  });
  // copy 的 scope 字段是 `to`，不是 `path`。
  //
  // 它原来抄了 FILE_OP 里 write/edit 那一套的 `scopeField:"path"`——对那几个工具是对的，
  // 因为它们的 path 就是被改的那个文件。copy 不是：`copy_path(from,to)` 映射成
  // `{path: from, to}`（main.js 的 _mapToolCall），**落笔的地方是 to**，path 只是被读的源。
  // 于是 worker A（scope=src/a/）调 copy_path(from:"src/a/t.js", to:"src/b/x.js") 时，
  // 作用域门拿源去比，比中了自己的 scope，放行——文件却建在了 worker B 的地盘上。
  // 并行 worker 之所以安全，全靠 _scopesOverlap 保证的「各改各的、互不相交」；
  // 隔壁 delete/move 干脆整个禁掉正是为了这个不变量，而 copy 用错字段等于从旁边开了个口子。
  //
  // 只卡目的地、不卡来源：worker 读任何地方都是允许的（执行器注释里写明了「may read
  // anywhere」），copy 的读那一半不该比 read_file 更严。变化在于：worker 现在不能把
  // scope 内的文件复制到 scope 外——这正是要挡的那件事。
  defineTool("copy", { ...FILE_OP, scopeField: "to" });
  // delete/move are refused outright for workers rather than scope-checked (a parallel child
  // deleting or relocating files is a conflict source no scope can make safe), so they carry
  // no scopeField — the executor's own worker guard rejects them earlier.
  defineTool("delete", FILE_OP);
  defineTool("move", FILE_OP);

  // ── command execution ─────────────────────────────────────────────────────
  defineTool("cmd", { ...EXEC, readOnlyModeBlocked: true });
  // 缺口已补（原来这里留着一段注释说"故意先不改，behaviour fix 该单独一个提交"——
  // 这就是那个提交）。`termtask` 就是 run_in_terminal：命令串由模型给出、原样执行，
  // 和 `cmd` 是同一类能力，只是多了个长驻终端。它不在只读封禁名单里，意味着
  // Explorer / Plan / Reviewer 这三个**声称只读**的模式可以起任意 shell——
  // 而 `cmd` 在它们那儿是被挡住的。同一件事换个工具名就绕过去了，那道门等于虚设。
  defineTool("termtask", { ...EXEC, readOnlyModeBlocked: true });

  // ── other side-effecting tools ────────────────────────────────────────────
  // 只读模式里按**单次调用**判：服务自己声明了 readOnlyHint 的放行，没声明的照挡。
  // 每一次调用仍然过 needsApproval 那道门，所以放行的也不是无人看管。
  // run_worker（内部 type "worker"）：派一个 mode 被改写成 "agent" 的**可写**子体去改工作区。
  // main.js 有四处（_toolMutatesWorkspace 周边、40237/40308/40337/40356）都把它当成改工作区
  // 的动作在记账，唯独这张**判定用**的表里从没登记过它——于是三道门全取默认值：
  // 只读模式不拦、审批不弹、mutatesWorkspace 恒 false。用户在模式选择器上亲手选了
  // Plan / Explorer / Reviewer，模型照样能派子体改文件。
  // 走默认网关线路时网关的拒绝清单会兜住 schema；但自定义端点 / 自带 key 那条路（_l0On=false）
  // 由客户端自己拼 body，兜底就没了。「会改工作区就必须能问」那条不变量只豁免 worktree 一个。
  // 它和 subagent 是同一族（那条也是逐次判、也补过同样的漏），这里对齐。
  defineTool("worker", {
    mutatesWorkspace: true,
    needsApproval: true,
    readOnlyModeBlocked: true,
    readOnlyBlockedVerb: "派一个会写文件的 worker 子体",
  });

  // background_monitor 的 check_type:"command" 支路会拿模型给的 pattern **原样跑 shell**
  // （main.js 那处 `backend.taskRunCapture(bmCwd, bmPat, …)`），而且按轮询节奏重复跑几十
  // 上百次。它一直没在这张表里注册过，于是 deny 名单、只读模式、审批开关三道门同时失效：
  // Plan / Explorer / Reviewer 这三个**声称只读**的模式里，一句
  // background_monitor(check_type:"command", pattern:"…") 就能绕过 cmd/termtask 那两道闸。
  // 这和上面 termtask 那条注释记的是同一个坑的第三种形状——同一件事换个工具名就绕过去。
  // 按**单次调用**判：其余 check_type（file/port/url/screen/capture/manual）是纯观察，
  // 只读模式里正是最该放行的，不能一刀切。
  const _bmRunsShell = (call) => String(call?.checkType || "") === "command";
  defineTool("background_monitor", {
    needsApproval: _bmRunsShell,
    readOnlyModeBlocked: _bmRunsShell,
    readOnlyBlockedVerb: "用后台监控跑 shell 命令",
  });
  defineTool("mcp", { needsApproval: true, readOnlyModeBlocked: (call) => !call?.mcpReadOnly, readOnlyBlockedVerb: "执行 MCP 工具" });
  // 用户自己声明接进来的 HTTP 能力。一律要审批，和 MCP 同级——声明可能来自 clone 来的
  // 仓库，而它能往任意 http(s) 地址发请求。只读判定同样**逐次**看这一次调用：声明里写的
  // 方法是 GET/HEAD 就当只读（那是用户自己写下的事实，不是我们猜的），于是 Plan /
  // Explorer 这些只读模式里，「查一下我们内网的工单」这类事照样能做。
  defineTool("userhttp", { needsApproval: true, readOnlyModeBlocked: (call) => !call?.userReadOnly });
  // 用户接进来的本地知识库。检索永远是只读的，所以只读模式一律放行——「先查资料再动手」
  // 恰恰是 Plan / Explorer 最需要的事。仍然要审批：它读的是用户机器上的一个目录。
  defineTool("userfolder", { needsApproval: true });
  // git worktree：add 在磁盘上建目录并新建分支，remove 连未提交的改动一起删。它一直
  // **完全没登记**，于是拿的是默认值（不审批、只读模式不挡）——Plan / Explorer / Reviewer
  // 这三个声称只读的模式里，模型可以建目录、删目录。这是漏登记，不是有意放行。
  //
  // 只读判定按**这一次调用**来：list 是纯读取，只读模式里该能用（"先看看有哪些候选"正是
  // Plan 要做的事）；add / remove 动磁盘，挡住。
  // 不设 needsApproval：它只在 <root>/.mrdayone/worktrees/ 下面动，是 IDE 自己的目录，
  // 每建一个候选都弹一次窗会把 best-of-N 这件事变得没法用。真正的数据风险（重名时
  // --force 销毁上一个候选）已经在 git.rs 的 git_worktree_add 里从根上去掉了。
  defineTool("worktree", {
    mutatesWorkspace: true,
    readOnlyModeBlocked: (call) => String(call?.action || "list") !== "list",
    readOnlyBlockedVerb: "建 / 删工作树",
  });
  /**
   * git / gh 一直**没有登记**，于是这道门对它们从来没生效过。
   *
   * 两个类型底下都是读写混装的（git_diff 和 git_commit 同为 type "git"，
   * gh_pr_view 和 gh_pr_create 同为 type "gh"），所以必须按调用判 op。
   *
   * git 的写操作**碰巧**够不着：它们躲在 `if (includeWrite)` 里，只读模式的注册表
   * 里压根没有。但 **gh_pr_create / gh_pr_reply 在 includeWrite 之外**，是只读模式
   * 87 条注册表里的正式成员，search_tools 装得进来。于是两种坏结局二选一：
   *   · 走网关（默认）：网关的只读拒绝清单里有它们，于是它们从请求里**彻底消失**，
   *     而模型上一轮刚被 search_tools 告知「已加载 gh_pr_create」——白烧一轮，
   *     且模型无从得知发生了什么；
   *   · 不走网关（自定义模型 / 自带 key）：客户端自己把 schema 塞进 body.tools，
   *     网关那份清单完全不参与，而客户端这道门又不认 gh —— Explorer/Plan/Reviewer 下
   *     模型可以**真的在 GitHub 上开 PR、回评论**，不可逆。
   *
   * 只读 op 照常放行：只读模式的价值就在于取证能力完整。
   */
  const GIT_READ_OPS = new Set(["status", "diff", "show", "log", "blame", "stash_list", "conflicts"]);
  // `branch` 不带名字是**列分支**（纯读），带名字或 create 才是切/建分支（动工作树）。
  // 判据和 main.js 的 _toolMutatesWorkspace / _isReadOnlyParallel 对齐——原来这里把所有
  // branch 一律当写，于是只读模式里连「有哪些分支」都问不出来。
  const gitWrites = (call) => {
    const op = String(call?.op || "status");
    if (op === "branch") return !!call?.branch || !!call?.create;
    return !GIT_READ_OPS.has(op);
  };
  defineTool("git", {
    parallelSafe: (call) => !gitWrites(call),
    // **不登记 mutatesWorkspace。** 那个字段是 type 级的布尔，而 git 这个 type 底下
    // 一多半是纯读取——把整个类型标成"会改工作区"，`git_status` 也会被算成一次改动，
    // 于是 _toolMutatesWorkspace 对 `{op:"branch"}`（列分支）返回 true，
    // 并行只读判定和验证义务全都跟着错。已有测试正面钉着这一点，试过一次，它是对的。
    // "git branch 带名字才算动工作树" 这种粒度只能按调用判，_toolMutatesWorkspace
    // 里本来就有那条规则。
    needsApproval: gitWrites,
    readOnlyModeBlocked: gitWrites,
    readOnlyBlockedVerb: "改仓库状态（提交 / 切分支 / 暂存 / 打标签）",
  });
  const GH_READ_OPS = new Set(["pr_view", "pr_checks", "actions_log", "pr_review_comments"]);
  const ghWrites = (call) => !GH_READ_OPS.has(String(call?.op || ""));
  defineTool("gh", {
    // 不是改工作区，是改**外部世界**（GitHub 上的 PR 和评论），而且不可逆。
    // 审批也按 op 判：看一个 PR、读 CI 日志是纯读，原来一刀切 true 让「看一眼」也弹框
    //（审批门对 gh 有特判走 _toolMayProduceExternalEffect，那条早就按 op 判了；这里对齐，
    // 让声明和特判说同一句话）。
    needsApproval: ghWrites,
    readOnlyModeBlocked: ghWrites,
    parallelSafe: (call) => !ghWrites(call),
    readOnlyBlockedVerb: "改 GitHub 上的东西（建 PR / 回复评论）",
  });
  // learn_design 一直没登记，于是三道门同时哑掉，它在 Plan / Explorer / Reviewer 里
  // **真的往工作区写两个文件**（reference/<slug>-design-system.md 和 <slug>-tokens.css），
  // 还会清掉「空工作区」标记。只读模式的注册表里也留着它（可见性判据是 `=== true`），
  // search_tools 取得回；网关那份拒绝清单里同样没有它。
  defineTool("learndesign", { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "学习并落盘设计资产" });
  defineTool("uiclick", { needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "点用户屏幕上的界面" });
  /*
   * `remote` 把 backend 的读 / 写 / 删 / 建目录 / 改名 / 复制 / 搜索 / 跑命令**整体重定向**
   * 到模型指定的另一台机器（connect 时还会把用户给的守护进程 token POST 过去）。
   * 而它此前**根本没进过这张表** —— 于是拿 DEFAULT_POLICY，needsApproval:false，
   * 「改动前审批」开着也零弹框。
   *
   * 判据其实早就写对了：`_toolMayProduceExternalEffect` 里那行
   * `if (call.type === "remote") return ["connect","disconnect"].includes(call.op);`。
   * 只是审批门只对 gh / http / tor 三个特判去问它，remote 走兜底 needsApprovalFor()，
   * 而兜底读的正是这张表。同一个函数里紧挨着的第三条判据，那条腿从来没走到 ——
   * 补上这一条，判据仍然只有一份出处。
   *
   * status 之类的查询免打扰；只读模式只挡 connect（disconnect 是**退回本机**，
   * 在只读模式里挡它反而把人锁在远端）。
   */
  const _remoteSwitchesHost = (call) => ["connect", "disconnect"].includes(String(call?.op || "status"));
  defineTool("remote", {
    needsApproval: _remoteSwitchesHost,
    readOnlyModeBlocked: (call) => String(call?.op || "status") === "connect",
    readOnlyBlockedVerb: "把文件读写和命令整体切到另一台机器",
  });
  // automation：按**方法**判，不是整个工具一刀切。capture / position / info / get / read /
  // list / status / inspect / nodes / check / screenshot 是纯观察（拍一眼、问指针在哪、读
  // 页面正文）；其余（click / type / key / app.* / clipboard.set …）合成真实键鼠，能开终端
  // 敲任意命令。原来 needsApproval 平铺 true 让「看一眼」也弹框，而只读模式**根本不挡**——
  // Plan 模式里合成键鼠畅通无阻。判据和 main.js `_toolMayProduceExternalEffect` 那条正则
  // 同一份（tool-policy.test.mjs 有断言把两处的正则文本对账，漂了会红）。
  const automationActs = (call) => !AUTOMATION_OBSERVE_METHODS.test(String(call?.method || ""));
  defineTool("automation", {
    needsApproval: automationActs,
    readOnlyModeBlocked: automationActs,
    readOnlyBlockedVerb: "合成键鼠 / 操作应用（点击、输入、切窗口、写剪贴板）",
  });
  // db：按**这一条语句**判。判据不在这里算——SQL 会不会写（含 WITH 可写 CTE、PRAGMA 赋值、
  // EXPLAIN ANALYZE、Redis 写命令）由 main.js 的 _dbCallMayMutate 判，它在执行前把结论标到
  // call.dbMayMutate 上（和 mcp 的 mcpReadOnly、userhttp 的 userReadOnly 同一种做法）。
  // 没标（不经 _mapToolCall 构造的调用）按会写处理：宁可多问，不能在只读模式里替用户 DROP。
  // 原来平铺 needsApproval:true、不挡只读：SELECT 也弹框，而 Plan 模式里 DROP TABLE 照跑。
  const dbWrites = (call) => call?.dbMayMutate !== false;
  defineTool("db", {
    needsApproval: dbWrites,
    readOnlyModeBlocked: dbWrites,
    parallelSafe: (call) => !dbWrites(call),
    readOnlyBlockedVerb: "改数据库（写 / 删 / 建表 / 改结构）",
  });
  // download 落的是工作区文件，只读模式同样要挡（和 GENERATOR 同一个理由）。
  defineTool("download", { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "下载文件到工作区" });
  // create_project 一直没有声明：它会在用户主目录下真的建出 ~/MrDayOne/<name>，
  // 并把左侧文件树整个切到那个新目录——只读模式里也能干，"改动前审批"也不弹。
  // 用户原来打开的项目就这么被顶掉，而模式标签一直写着「只读」。
  defineTool("createproject", { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "新建项目目录" });
  // capture_start：mode='system' / system_proxy=true 会改掉**操作系统级**代理设置，
  // 整台机器的流量（浏览器、邮件、其他 App）一起被切到本地 mitmproxy 上，接着还要
  // 用户 sudo 装一张根证书。这不该是一句「我顺手开了抓包」就发生的事。
  defineTool("capture_start", { needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "开启抓包并改写系统代理" });

  // ── 2026-09-04 审计补登记：会写盘 / 杀进程 / 发写请求，却一直拿默认策略的 ──────────
  //
  // 判据和上面每一条一样：策略表只枚举**已登记**的类型，没登记 = 三道门全默认 =
  // 不审批、只读不拦、mutatesWorkspace 恒 false。这批是逐个打开执行分支核出来的。
  //
  // remember → memory：写 <root>/.mrdayone/memory.md。落在 IDE 自己的目录里，按 worktree
  //   的先例不弹审批（每记一条弹一次框没法用），但只读模式不许留下持久化写入（saveskill 的先例）。
  defineTool("memory", { readOnlyModeBlocked: true, readOnlyBlockedVerb: "写项目记忆文件" });
  // visual_explain → explain：和 genimage 走同一个 generate_image_chat 后端，把 png 落到
  //   <root>/.mrdayone-images/。同一个动作，隔壁登记了它没登记。
  defineTool("explain", { ...GENERATOR, readOnlyBlockedVerb: "生成讲解图片并写进工作区" });
  // stop_demo → demostop：把录制结果写成 HTML，路径由模型给（允许绝对路径，create-only）。
  defineTool("demostop", { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "把演示录像写成文件" });
  // stop_terminal → termstop：结束一个任务终端里的进程。只读模式起不了终端，也不该杀终端；
  //   不弹审批——和 browser 的 close 同类（收尾动作，不是新的副作用）。
  defineTool("termstop", { readOnlyModeBlocked: true, readOnlyBlockedVerb: "停掉任务终端里的进程" });
  // http_request / tor_request：审批门对它们有特判（非 GET/HEAD/OPTIONS 才问），但只读门
  //   从来没看过它们——Plan 模式里 POST / DELETE 打到任意地址畅通无阻，而隔壁 userhttp
  //   早就按方法判了。这里让声明和特判说同一句话。
  const httpWrites = (call) => !["GET", "HEAD", "OPTIONS"].includes(String(call?.method || "GET").toUpperCase());
  for (const t of ["http", "tor"]) {
    defineTool(t, {
      needsApproval: httpWrites,
      readOnlyModeBlocked: httpWrites,
      parallelSafe: (call) => /^(get|head)$/i.test(String(call?.method || "GET").trim()),
      readOnlyBlockedVerb: "发出会改变服务端状态的 HTTP 请求（POST / PUT / DELETE …）",
    });
  }
  // mcp 的并行判据：服务自己声明了 readOnlyHint 的才并行（和只读门同一个信号）。
  // 声明本身在上面 defineTool("mcp") 里，这里只补 parallelSafe 一位。
  defineTool("mcp", { ...toolPolicy("mcp"), parallelSafe: (call) => !!call?.mcpReadOnly });

  // ── 能和别的只读调用并行的纯读工具 ─────────────────────────────────────────
  //
  // 这份名单就是 main.js `_READ_ONLY_TYPES` 那一份（tool-policy.test.mjs 逐个对账）。
  // 故意**不含** uiextract：它会 browser_navigate 到模型给的 URL，用的是那一个共享的
  // 自动化浏览器——两个并发的 uiextract 互相把对方的页面导航走。原名单里有它，是漏。
  for (const t of PARALLEL_SAFE_READS) defineTool(t, { parallelSafe: true });

  // ── 有真实外部副作用、却一直没登记的四个 ──────────────────────────────────
  //
  // 这四个是审计（2026-08-17）挖出来的：它们和上面 uiclick / automation 是同一类东西
  // （越过工作区去动真实世界），但从来没进过这张表。没进表 = needsApproval 取默认值
  // false = 「改动前审批」开着也一次框都不弹，只读模式也不拦。而防漂移守卫只看得见
  // **已登记且 mutatesWorkspace** 的类型，对完全没登记的工具恒绿——所以漏了很久没人发现。
  //
  // browser：跑在一个常驻登录态的自动化 profile 上。action:"eval" 是任意 JS，
  //   "cookies"/"storage" 直接读走会话，"upload" 收的是**本机绝对路径**（模型可以填
  //   ~/.ssh/id_rsa），"autofill"+提交能替用户按下不可撤销的按钮。同一时刻写一个文件
  //   要弹框，这些不弹——这不是权衡，是漏登记。只读模式下同样要拦：读 cookie 不是"只读"。
  defineTool("browser", {
    // 按**动作**分辨，不是整个工具一刀切。上一版这里写死了一份手打的名单，里面
    // `read` / `text` / `back` / `forward` 四个动作**在 schema 里根本不存在**，而真正的
    // 观察动作 observe / inspect / network / nodes 一个都没列进去——于是只读模式下它连
    // 看一眼页面都被拦，审批模式下看一眼也要弹框。名单改成照着 schema 的 action 枚举来。
    needsApproval: (call) => !BROWSER_OBSERVE_ACTIONS.has(String(call?.action || "")),
    readOnlyModeBlocked: (call) => !BROWSER_OBSERVE_ACTIONS.has(String(call?.action || "")),
    readOnlyBlockedVerb: "驱动浏览器做交互（点击 / 输入 / 读 cookie / 上传 / 跑 JS）",
  });
  // docker_compose_up：直接起一整套容器（`docker compose up -d`），占端口、挂卷、
  //   长期后台运行，停不停得掉不归本轮管。这是执行，不是读。
  defineTool("docker_compose_up", { ...EXEC, readOnlyModeBlocked: true, readOnlyBlockedVerb: "起容器" });
  // capture_replay：可以指定任意 method / url / body 直接发出去，而且**不要求真有一条
  //   抓包记录**——等于绕开 http_request 那道审批门的一条完整旁路。同门同待遇。
  defineTool("capture_replay", { needsApproval: true, readOnlyModeBlocked: true, readOnlyBlockedVerb: "重放抓到的请求" });

// debug：会话由用户按 F5 起，模型只驱动。status / await_stop 是纯观察（"停了没、停在哪"），
// evaluate 会在真实栈帧里执行一段表达式、continue 会让进程接着跑——那两个才有副作用。
// 一刀切 true 会让"快速试一个表达式"每次都弹框，观察动作立刻变贵；照 browser / system 的
// 按动作判形状来。
const DEBUG_OBSERVE_OPS = new Set(["status", "await_stop"]);
defineTool("debug", {
  needsApproval: (call) => !DEBUG_OBSERVE_OPS.has(String(call?.op || "status")),
  readOnlyModeBlocked: (call) => !DEBUG_OBSERVE_OPS.has(String(call?.op || "status")),
  readOnlyBlockedVerb: "驱动调试器（在真实栈帧里求值 / 放行进程）",
});
  // system：开 App、切前台窗口、触发任意 App 的菜单项 —— 那几个确实是副作用。
  //   但 apps / windows / frontmost / menu_items 是**纯读**：它们回答的是"现在开着什么、
  //   哪个在前台、这个 App 有哪些菜单项"。一刀切成"要审批 + 只读模式拦"之后，
  //   Explorer / Plan / Reviewer 这三个**本来就只看不动**的模式里，连"现在开着什么"
  //   都问不出来 —— 恰恰把"了如指掌"卡死在最需要它的地方。
  //   隔壁 browser 已经按 action 拆过，注释里还记着上次踩这个坑的事故；system 漏了。
  defineTool("system", {
    needsApproval: (call) => !SYSTEM_READ_OPS.has(String(call?.op || call?.action || "frontmost").toLowerCase()),
    readOnlyModeBlocked: (call) => !SYSTEM_READ_OPS.has(String(call?.op || call?.action || "frontmost").toLowerCase()),
    readOnlyBlockedVerb: "操作系统里的应用（开 App / 切窗口 / 点菜单）",
  });

  // ── generators that land assets in the workspace ──────────────────────────
  for (const t of [
    "game_scaffold", "web_scaffold", "download_asset", "genimage", "generate_3d",
    "generate_sound", "generate_music", "generate_voice", "auto_rig", "generate_motion",
    "generate_texture",
  ]) defineTool(t, GENERATOR);
  // Office 文档：office_write / office_edit 真的往工作区落 xlsx / docx / pptx（edit 默认覆盖原文件），
  // 和 genimage 同一族——审批一道门、只读模式一道门。office_read 纯读，走默认策略。
  defineTool("office_write", { ...GENERATOR, readOnlyBlockedVerb: "生成 Office 文档并写进工作区" });
  defineTool("office_edit", { ...GENERATOR, readOnlyBlockedVerb: "修改工作区里的 Office 文档" });
}
seed();

/** Resolved policy for a tool type. Never throws; unknown types get the safe default. */
export function toolPolicy(type) {
  return REGISTRY.get(String(type || "")) || DEFAULT_POLICY;
}

/** Every registered type whose policy satisfies `predicate`. Internal: the derived
 *  views below are the public surface. */
function typesWhere(predicate) {
  const out = new Set();
  for (const [type, policy] of REGISTRY) if (predicate(policy, type)) out.add(type);
  return out;
}

// ── The named sets the harness used to hard-code, now derived ───────────────
// Exported as live getters rather than frozen constants so a `defineTool` call at startup
// (a plugin, a future MCP-backed tool) is reflected everywhere instead of only in the
// call sites that happened to be evaluated after it.
export const workspaceMutatingTypes = () => typesWhere((p) => p.mutatesWorkspace);
export const fileMutationTypes = () => typesWhere((p) => p.fileMutation);
export const fileEditTypes = () => typesWhere((p) => p.fileEdit);
export const approvalTypes = () => typesWhere((p) => p.needsApproval);
export const hookedTypes = () => typesWhere((p) => p.hooked);
export const readOnlyBlockedTypes = () => typesWhere((p) => p.readOnlyModeBlocked);
/**
 * 类型级恒可并行的那些（声明为 true 的）。按调用判的（git / gh / http / db / mcp 的函数值）
 * 不在这里——它们由 `toolPolicy(type).parallelSafe(call)` 逐次问。
 *
 * 主循环的 `_isReadOnlyParallel` 暂时还读 main.js 里那份手写名单（三处测试用 load() 抠它跑，
 * 注入表里就是那份名单，多一个自由标识符就 ReferenceError）；子体的预起跑已经改读这里。
 * tool-policy.test.mjs 有一条把两份逐个对账，任何一边单独改都会红。
 */
export const parallelSafeTypes = () => typesWhere((p) => p.parallelSafe === true);

// ── Predicates: what call sites should actually use ─────────────────────────
export const mutatesWorkspace = (type) => toolPolicy(type).mutatesWorkspace;
export const isFileMutation = (type) => toolPolicy(type).fileMutation;
// 没有 isFileEdit 的单数版：`fileEdit` 这个属性活着（fileEditTypes() 在 main.js 有五个
// 消费点），但按单个 type 问它的谓词从来没人调过。它的双胞胎 isFileMutation 有四个
// 调用点，所以这不是「批量导出的一套」——就是个孤儿，2026-08-26 删掉。
export const needsApproval = (type) => toolPolicy(type).needsApproval;
/*
 * 只读模式（Plan / Explorer / Reviewer）里这个调用要不要挡。
 *
 * `call` 是可选的第二个参数，为的是让 MCP 能按**这一次调用**判断，而不是整个类型
 * 一刀切。一刀切的代价是：用户装的 MCP 服务在只读模式里全都用不了——查文档、读数据库
 * 结构这类纯读取的事，恰恰是 Plan 模式最需要的，而它们和"写文件"被归成了同一类。
 *
 * 判据用调用上带的 mcpReadOnly（来自服务自己声明的 readOnlyHint）。声明缺失时按
 * **可能有副作用**处理——MCP 规范里这个提示是可选的，多数服务不写，宁可挡住也不能
 * 在只读模式里替用户改了东西。
 */
/**
 * 这一次调用要不要过审批门。`needsApproval` 可以是布尔，也可以是按 call 判定的函数
 * （browser 就是后者：看页面不必弹框，替用户按按钮必须）。
 *
 * 注意别拿 `approvalTypes()` 当这个用：那份集合只回答"这个工具**有可能**需要审批"，
 * 函数值在它眼里恒为真，于是纯观察动作也会被判成要审批。
 */
export const needsApprovalFor = (type, call) => {
  const need = toolPolicy(type).needsApproval;
  if (typeof need === "function") return !!need(call);
  return !!need;
};

export const blockedInReadOnlyMode = (type, call) => {
  const blocked = toolPolicy(type).readOnlyModeBlocked;
  if (typeof blocked === "function") return blocked(call);
  return blocked;
};

/**
 * Which argument of `call` a worker sub-agent's scope is checked against, or "" when the tool
 * is not scope-checked. Returning the FIELD rather than a boolean keeps the executor from
 * re-deriving "which property holds the path for this tool", which is the same duplication in
 * a different costume.
 */
export const workerScopeField = (type) => toolPolicy(type).scopeField;

/** The concrete path a worker's scope applies to, or "" when the tool is unscoped. */
export function workerScopeTarget(call) {
  if (!call) return "";
  const field = workerScopeField(call.type);
  if (!field) return "";
  return String(call[field] || call.dest || call.to || "");
}

/** Snapshot of every declaration — for diagnostics and for the drift test. */
export function allPolicies() {
  return Object.fromEntries([...REGISTRY].map(([type, policy]) => [type, { ...policy }]));
}
