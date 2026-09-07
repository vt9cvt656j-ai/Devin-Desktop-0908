// Tests for the tool policy registry.
//
// Note what these DON'T do: no `extractFn`, no `assert.match(SRC, /regex/)`. The module is
// pure, so it is imported and called like ordinary code. That is the whole point of moving it
// out of main.js — 1,221 assertions in logic.test.mjs are welded to the SHAPE of the source
// and break whenever the code is improved. Nothing here can break for that reason.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_POLICY,
  allPolicies,
  approvalTypes,
  blockedInReadOnlyMode,
  defineTool,
  fileEditTypes,
  fileMutationTypes,
  hookedTypes,
  isFileMutation,
  mutatesWorkspace,
  needsApproval,
  needsApprovalFor,
  BROWSER_OBSERVE_ACTIONS,
  AUTOMATION_OBSERVE_METHODS,
  PARALLEL_SAFE_READS,
  parallelSafeTypes,
  readOnlyBlockedTypes,
  toolPolicy,
  workerScopeField,
  workerScopeTarget,
  workspaceMutatingTypes,
} from "../src/agent/tool-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `MAIN` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as MAIN, SRC as RAW_SRC } from "./helpers/source.mjs";

const sorted = (set) => [...set].sort();

// ── The pinning tests ───────────────────────────────────────────────────────
//
// These encode "this refactor changed nothing". Each asserts the derived set has EXACTLY the
// membership the hand-written literal had before the registry existed. Without them, a
// migration like this is a leap of faith; with them it is verifiable.
//
// The expected lists are transcribed from the pre-refactor source and must never be "fixed"
// to match the code — if one fails, either the registry is wrong or a deliberate behaviour
// change is being made, and the second case belongs in its own commit with this list updated
// as part of it.

test("workspace-mutating set matches the pre-refactor literal exactly", () => {
  assert.deepEqual(sorted(workspaceMutatingTypes()), sorted(new Set([
    "write", "edit", "multiedit", "delete", "move", "mkdir", "copy", "format",
    "game_scaffold", "web_scaffold", "download", "download_asset", "genimage", "generate_3d",
    "generate_sound", "generate_music", "generate_voice", "auto_rig", "generate_motion",
    "generate_texture",
    // Office 文档落盘（xlsx / docx / pptx）。
    "office_write", "office_edit",
    // 新增：真的会在磁盘上建目录（~/MrDayOne/<name>）并切换工作区。
    "createproject",
    // 新增：git worktree。它在 <root>/.mrdayone/worktrees/ 下面建目录、建分支，remove
    // 还会连未提交的改动一起删。原来完全没登记，拿的是默认策略。
    "worktree",
    // 新增（2026-08-25）：learndesign —— 它真的往工作区写两个文件
    //（reference/<slug>-design-system.md 和 <slug>-tokens.css），却一直没登记，
    // 于是只读三模式下照写不误、审批也不弹。
    "learndesign",
    // 新增（2026-08-30 审计）：worker —— run_worker 派的是 mode 被改写成 "agent" 的**可写**
    // 子体，main.js 有四处已经把它当改工作区的动作在记账（_toolMutatesWorkspace 周边），
    // 唯独这张判定表里从没登记过。和上面 learndesign / worktree 是同一种漏法。
    "worker",
    // 新增（2026-09-04 审计）：visual_explain → explain 和 genimage 走同一个后端把 png 落进
    // <root>/.mrdayone-images/；stop_demo → demostop 把录像写成 HTML（路径由模型给）。
    // 两个都真的往工作区写文件，此前一条声明都没有。
    "explain", "demostop",
  ])));
  // The subtle one: a shell command may change the workspace but never REPORTS it, so it is
  // not in this set. Adding it would make `mutated === false` look like proof of a no-op.
  assert.equal(mutatesWorkspace("cmd"), false);
  assert.equal(mutatesWorkspace("termtask"), false);
  /*
   * saveskill 曾在这张表里（"在 <root>/.mrdayone/skills/<名字>/ 下落一个 SKILL.md"）。
   * 2026-08-22 落点改成家目录技能库 `~/.mrdayone/skills/` —— 技能是跨项目复用的能力，
   * 跟着人走不跟着项目走。它现在一个工作区文件都不碰，留在这张表里会把一次不碰工作区的
   * 写入报成"改了工作区"，`mutated` 这个字段就不再是证据。
   */
  assert.equal(mutatesWorkspace("saveskill"), false);
});

// gh 新增（2026-08-25）：它改的不是工作区，是**外部世界**——在 GitHub 上开 PR、回评论，
// 不可逆。所以进审批集合而不是 workspaceMutating 集合。
test("approval set matches the pre-refactor literal exactly", () => {
  assert.deepEqual(sorted(approvalTypes()), sorted(new Set([
    "write", "edit", "multiedit", "delete", "move", "mkdir", "copy", "format",
    "cmd", "termtask", "automation", "uiclick", "download", "db", "mcp",
    // 新增：remote。它把 backend 的读/写/删/建目录/改名/复制/搜索/跑命令**整体重定向**
    // 到模型指定的另一台机器（connect 还会把守护进程 token POST 过去），此前根本没进过
    // 策略表 → 拿默认值 needsApproval:false → 「改动前审批」开着也零弹框。判据在
    // _toolMayProduceExternalEffect 里早就写对了，只是审批门那条腿没走到它。
    "remote",
    // 新增：用户自己声明接进来的 HTTP 能力。它能往任意 http(s) 地址发请求，而声明可能
    // 来自 clone 来的仓库，所以和 mcp 同级——一律要审批。
    "userhttp",
    // 新增：用户接进来的本地知识库检索。读的是用户机器上的目录，所以要审批。
    "userfolder",
    // 新增：会在用户主目录下真的建出 ~/MrDayOne/<name>，并把左侧文件树整个切过去——
    // 用户原来打开的项目就这么被顶掉。此前一条声明都没有。
    // 新增：定时任务。它排下的是一条**将来在没人看着时执行**的常驻指令，和 mcpconfig
    // 同级——网页正文、仓库文件、命令输出都可能诱导模型偷偷排一条。list 只读不弹框，
    // add/remove 一律要用户点头，只读模式下同样挡住。
    "schedule",
    "createproject",
    // 新增：mode='system' / system_proxy=true 会改掉**操作系统级**代理，整台机器的
    // 流量都走本地 mitmproxy，接着还要用户 sudo 装根证书。
    "capture_start",
    // 新增（2026-09-04 审计）：explain / demostop 写盘（见上面 mutating 集合）；http / tor
    // 按 method 判——非 GET/HEAD/OPTIONS 才问。审批门对 http/tor 本来就有特判走
    // _toolMayProduceExternalEffect，这里让声明和特判说同一句话（同时补上只读门那一半）。
    "explain", "demostop", "http", "tor",
    // 新增：这一族全都真的往工作区写文件（web_scaffold / game_scaffold 更是直接铺
    // 一整棵项目树），此前一个都不问——等于「改动前审批」这个开关对十种写盘方式
    // 整体失效，而用户看不出来。
    "genimage", "generate_3d", "generate_sound", "generate_music", "generate_voice",
    "generate_motion", "generate_texture", "auto_rig",
    "game_scaffold", "web_scaffold", "download_asset",
    "office_write", "office_edit",
    // 新增（2026-08-17 审计）：这四个有真实外部副作用，却从来没登记进 REGISTRY——
    // 没登记 = 策略全取默认值 = needsApproval 恒 false，「改动前审批」开着也一次框都不弹。
    // browser 能跑任意 JS、读会话 cookie / localStorage、上传**本机绝对路径**的文件、
    // 替用户填表并按下提交；docker_compose_up 直接 `docker compose up -d` 起一整套容器；
    // capture_replay 能指定任意 method/url/body 直发，是 http 那道门的完整旁路；
    // system 能开 App、切前台窗口、触发任意 App 的菜单项。
    "browser", "docker_compose_up", "capture_replay", "system",
    "debug",  // 按 op 判：status / await_stop 是纯观察，evaluate / continue 才弹框
      // save_skill 在用户家目录的技能库里建文件；mcp_server 改**持久化配置**并注册一条
    // 可执行命令行（list 是只读的，按调用逐次判，见下面的细则断言）。
    "saveskill", "mcpconfig",
    // 新增（2026-08-23 审计）：subagent。它这一族里有一个会**真的写工作区文件**的——
    // generate_wiki 把报告落成 dest 指定的那个文件，路径由模型给（默认 PRODUCT_WIKI.md，
    // 传 "README.md" 就覆盖 README）。那次落盘发生在主循环的结果处理里、不在工具执行器
    // 里，于是两道门从头到尾没被问过。它是**逐次**判定：纯调研的 run_subagent /
    // research_project / design_research 照常放行（只读模式本来就靠它们干活），只有带
    // _wiki 的那次落盘被挡；出现在这个集合里只表示「至少有一种调用会被挡」。
    "subagent",
      // 新增（2026-08-25）：gh —— 在 GitHub 上开 PR / 回评论，改的是外部世界且不可逆。
    "gh",
    // 新增（2026-08-25）：learndesign —— 它真的往工作区写两个文件
    //（reference/<slug>-design-system.md 和 <slug>-tokens.css），却一直没登记，
    // 于是只读三模式下照写不误、审批也不弹。
    "learndesign",
    // 新增（2026-08-25）：git —— 按 op 判，commit/push/stash/clone 要问，status/diff/log 不问。
    // 「会改工作区就必须能问」那条不变量只豁免 worktree 一个，所以 git 登记了
    // mutatesWorkspace 就必须同时登记 needsApproval。
    "git",
    // 新增（2026-08-30 审计）：background_monitor —— 它的 check_type:"command" 支路把模型
    // 给的 pattern **原样交给 shell**，还按轮询节奏重复跑几十上百次，而整条授权链一次都
    // 没看见过它（_callIsDangerousCommand 只认 cmd/termtask，这张表里根本没注册）。于是
    // deny 名单、只读模式、审批开关三道门同时失效——和上面 termtask 那条注释记的是同一个
    // 坑的第三种形状：同一件事换个工具名就绕过去。**逐次**判定：其余 check_type
    //（file/port/url/screen/capture/manual）是纯观察，只读模式里正该放行，不能一刀切；
    // 出现在这个集合里只表示「至少有一种调用会被挡」。
    // 新增（2026-08-30 审计）：worker —— run_worker 派的是一个 mode 被改写成 "agent" 的
    // **可写**子体。main.js 有四处把它当改工作区的动作在记账，唯独这张判定表里从没登记过，
    // 于是三道门全取默认值：只读不拦、审批不弹、mutatesWorkspace 恒 false。用户亲手选了
    // Plan / Explorer / Reviewer，模型照样能派子体改文件。和 subagent 是同一族的漏。
    "worker",
    "background_monitor",
  ])));
  // 逐次判定的细则：只有跑 shell 的那一种被挡，纯观察的六种照常放行。
  // 光断言它在集合里不够——把 needsApproval 写成恒 true 也能让上面那条绿，
  // 而那会把「等文件出现」「等端口监听」这类纯观察也拖进审批弹窗。
  for (const ct of ["file", "port", "url", "screen", "capture", "manual"]) {
    assert.equal(needsApprovalFor("background_monitor", { type: "background_monitor", checkType: ct }), false,
      `check_type=${ct} 是纯观察，不该弹审批`);
  }
  assert.equal(needsApprovalFor("background_monitor", { type: "background_monitor", checkType: "command" }), true,
    "check_type=command 会跑 shell，必须审批");
  // worktree 是**有意**不问的：它只在 <root>/.mrdayone/worktrees/ 下动，是 IDE 自己的
  // 目录，best-of-N 每建一个候选弹一次窗就没法用了。这条豁免要留着，也要看得见。
  assert.equal(approvalTypes().has("worktree"), false, "worktree 的豁免是有意的，见 tool-policy 里的说明");
});

test("hooked set matches the pre-refactor literal exactly, including format's absence", () => {
  assert.deepEqual(sorted(hookedTypes()), sorted(new Set([
    "write", "edit", "multiedit", "cmd", "termtask", "delete", "move", "mkdir", "copy",
    // docker_compose_up 借用 EXEC（needsApproval + hooked）：它和 cmd 一样是把一串命令
    // 交给 shell，钩子该看得到它。另三个不是 shell 执行，不进这个集合。
    "docker_compose_up",
      // 改的是磁盘上的用户 MCP 配置，钩子该看得到。
    "mcpconfig",
  ])));
  // `format` writes content but is intentionally NOT hooked. It is the single element that
  // makes this set differ from the file-mutation family, and it was easy to lose.
  assert.equal(fileEditTypes().has("format"), true);
  assert.equal(toolPolicy("format").hooked, false);
  /*
   * saveskill 曾和 mcpconfig 并列在这里。落点改成 `~/.mrdayone/skills/` 之后摘掉：
   * pre_tool_use 钩子是**当前工作区**配的（<root>/.mrdayone/hooks），对一个不落在这个
   * 项目里的写入没有管辖权——换个项目开着，同一次存技能会被另一套钩子拦，那不是判据。
   * 它仍然要审批、只读模式仍然挡住（见上下两条名单），那两道才是它该过的门。
   */
  assert.equal(toolPolicy("saveskill").hooked, false);
  assert.equal(approvalTypes().has("saveskill"), true, "存技能在用户家目录建文件，审批不许丢");
  assert.equal(readOnlyBlockedTypes().has("saveskill"), true, "只读模式不许留下持久化写入");
});

test("read-only-mode block matches the pre-refactor chain, plus the closed termtask gap", () => {
  assert.deepEqual(sorted(readOnlyBlockedTypes()), sorted(new Set([
    "write", "edit", "multiedit", "cmd", "delete", "move", "mkdir", "copy", "format",
    "uiclick", "mcp", "termtask",
    // 新增：remote(connect)。把整台机器的读写和命令切走，在只读模式里显然不是"只读"。
    // disconnect 不挡——那是**退回本机**，挡住反而把人锁在远端。
    "remote",
    // 新增：只读模式里也能建目录并把用户当前工作区顶掉——模式标签写着「只读」。
    // 新增：定时任务。它排下的是一条**将来在没人看着时执行**的常驻指令，和 mcpconfig
    // 同级——网页正文、仓库文件、命令输出都可能诱导模型偷偷排一条。list 只读不弹框，
    // add/remove 一律要用户点头，只读模式下同样挡住。
    "schedule",
    "createproject",
    // 新增：用户 HTTP 能力。和 mcp 一样是**逐次**判定（下面那条测试钉住细则），
    // 所以它出现在这个集合里只表示「默认挡住」，不表示一刀切。
    "userhttp",
    // 新增：worktree。同样是**逐次**判定——list 放行（只读模式最需要"先看看有哪些候选"），
    // add / remove 挡住。出现在这个集合里只表示「至少有一种调用会被挡」。
    "worktree",
    // 新增（2026-08-17 审计）：browser 是**逐次**判定——看页面（navigate/screenshot/read）
    // 是观察，只读模式该放行；动会话、传文件、执行 JS、按提交才是副作用。另三个一刀切挡住：
    // 起容器、发任意 HTTP、开 App 切窗口，没有一种能叫"只读"。
    "browser", "docker_compose_up", "capture_replay", "system",
    "debug",  // 按 op 判：status / await_stop 是纯观察，evaluate / continue 才弹框
      // 新增：只读模式里不许存技能、不许改 MCP 配置（mcp_server 的 list 仍放行，逐次判）。
    "saveskill", "mcpconfig",
    // 新增（2026-08-23 审计）：subagent。它这一族里有一个会**真的写工作区文件**的——
    // generate_wiki 把报告落成 dest 指定的那个文件，路径由模型给（默认 PRODUCT_WIKI.md，
    // 传 "README.md" 就覆盖 README）。那次落盘发生在主循环的结果处理里、不在工具执行器
    // 里，于是两道门从头到尾没被问过。它是**逐次**判定：纯调研的 run_subagent /
    // research_project / design_research 照常放行（只读模式本来就靠它们干活），只有带
    // _wiki 的那次落盘被挡；出现在这个集合里只表示「至少有一种调用会被挡」。
    "subagent",
      // 新增（2026-08-25）：git / gh 按调用判 op —— 两个类型底下读写混装
    //（git_diff 和 git_commit 同为 type "git"，gh_pr_view 和 gh_pr_create 同为 type "gh"）。
    // 它们此前完全没登记，于是这道门对整个 git/gh 族从来没生效过：走自定义模型时
    // 网关那份拒绝清单不参与，Explorer/Plan/Reviewer 下能真的开 PR。
    "git", "gh",
    // 新增（2026-08-25）：learndesign —— 它真的往工作区写两个文件
    //（reference/<slug>-design-system.md 和 <slug>-tokens.css），却一直没登记，
    // 于是只读三模式下照写不误、审批也不弹。
    "learndesign",
    // 新增（2026-08-30 审计）：background_monitor 的 check_type:"command" 是把模型给的
    // pattern 原样交给 shell，还按轮询节奏重复跑几十上百次。同样是**逐次**判定：
    // file/port/url/screen/capture/manual 六种是纯观察，只读模式正靠它们干活，照常放行。
    // 新增（2026-08-30 审计）：worker —— run_worker 派的是一个 mode 被改写成 "agent" 的
    // **可写**子体。main.js 有四处把它当改工作区的动作在记账，唯独这张判定表里从没登记过，
    // 于是三道门全取默认值：只读不拦、审批不弹、mutatesWorkspace 恒 false。用户亲手选了
    // Plan / Explorer / Reviewer，模型照样能派子体改文件。和 subagent 是同一族的漏。
    "worker",
    "background_monitor",
    // 新增（2026-09-04 审计）。判据一条：只读模式不许留下持久化写入、不许动进程、不许发写请求。
    //   memory      remember 写 <root>/.mrdayone/memory.md（不弹审批：IDE 自己的目录，worktree 的先例）
    //   explain / demostop  真的写工作区文件（见 mutating 集合）
    //   termstop    杀掉任务终端里的进程
    //   http / tor  按 method 逐次判：GET/HEAD/OPTIONS 照常放行（Plan 模式查接口正靠它）
    //   capture_start  改写操作系统级代理
    //   download + 十一个生成器  往工作区落文件——原来只有审批一道门，审批关掉的用户在只读模式里什么都拦不住
    //   automation  按方法逐次判：观察类放行，合成键鼠挡下
    //   db          按这一条语句逐次判：SELECT 放行，DROP 挡下（原来平铺 needsApproval:true、只读不挡）
    "memory", "explain", "demostop", "termstop", "http", "tor", "capture_start",
    "download", "download_asset", "genimage", "generate_3d", "generate_sound", "generate_music",
    "generate_voice", "generate_motion", "generate_texture", "auto_rig", "game_scaffold", "web_scaffold",
    "office_write", "office_edit",
    "automation", "db",
  ])));
  // 逐次细则：只挡跑 shell 的那一种。写成一刀切会把「等端口起来」这类观察也挡掉，
  // 而那正是 Plan 模式最需要的能力。
  for (const ct of ["file", "port", "url", "screen", "capture", "manual"]) {
    assert.equal(blockedInReadOnlyMode("background_monitor", { type: "background_monitor", checkType: ct }), false,
      `check_type=${ct} 是纯观察，只读模式不该挡`);
  }
  assert.equal(blockedInReadOnlyMode("background_monitor", { type: "background_monitor", checkType: "command" }), true,
    "check_type=command 是任意 shell —— 只读模式必须挡，否则换个工具名就绕过 cmd/termtask 两道闸");
  // 上一版这里断言的是 `false`，并写着「补掉的时候这一行要在同一个提交里翻成 true」——
  // 这就是那个提交。termtask 就是 run_in_terminal，命令串由模型给出、原样执行，和 cmd
  // 是同一类能力；cmd 在只读模式被挡而它不被挡，等于换个工具名就绕过去了。
  assert.equal(blockedInReadOnlyMode("termtask"), true,
    "run_in_terminal is arbitrary shell — a read-only mode must not be able to start one");
});

test("用户声明的 HTTP 能力：GET 类在只读模式可用，写类照旧挡住", () => {
  // 判据来自用户自己写下的方法（GET/HEAD → 只读），不是我们去猜接口语义。
  // 这样 Plan / Explorer 这些只读模式里，「查一下我们内网的工单」照样做得了，
  // 而 POST 到内部系统仍然被挡在门外。
  assert.equal(blockedInReadOnlyMode("userhttp", { type: "userhttp", userReadOnly: true }), false);
  assert.equal(blockedInReadOnlyMode("userhttp", { type: "userhttp", userReadOnly: false }), true);
  assert.equal(blockedInReadOnlyMode("userhttp", { type: "userhttp" }), true, "没声明时按有副作用处理");
  // 放行只读，不等于不用审批——两道门是独立的。
  assert.ok(needsApproval("userhttp"), "用户 HTTP 能力不再需要审批了");
});

test("file-mutation and file-edit families match their pre-refactor literals", () => {
  assert.deepEqual(sorted(fileMutationTypes()), sorted(new Set([
    "write", "edit", "multiedit", "delete", "move", "mkdir", "copy", "format",
  ])));
  assert.deepEqual(sorted(fileEditTypes()), sorted(new Set([
    "write", "edit", "multiedit", "format",
  ])));
  // A generator lands files in the workspace but is not a structured file operation — the
  // distinction the flat lists kept blurring.
  assert.equal(mutatesWorkspace("genimage"), true);
  assert.equal(isFileMutation("genimage"), false);
});

test("worker scope targets match the pre-refactor list", () => {
  const scoped = sorted(new Set(Object.keys(allPolicies()).filter((t) => workerScopeField(t))));
  assert.deepEqual(scoped, sorted(new Set([
    "write", "edit", "multiedit", "mkdir", "copy", "format",
  ])));
  // delete/move are refused for workers outright rather than scope-checked.
  assert.equal(workerScopeField("delete"), "");
  assert.equal(workerScopeField("move"), "");
  /*
   * saveskill 曾在这张表里（"落的是文件，worker 的 scope 要照着 path 收"）。落点改成
   * 家目录技能库之后必须摘掉：worker 的 scope 是**工作区内的相对路径清单**，而技能库是
   * HOME 底下的绝对路径，必然落在任何 scope 之外——子智能体收尾时存技能会被
   * `[BLOCKED] 路径「…」不在你这个 worker 的负责范围(scope)内` 整条拒掉。
   */
  assert.equal(workerScopeField("saveskill"), "");
  // The helper returns the concrete path, so the executor never re-derives "which field".
  assert.equal(workerScopeTarget({ type: "write", path: "src/a.ts" }), "src/a.ts");
  assert.equal(workerScopeTarget({ type: "copy", path: "", to: "src/b.ts" }), "src/b.ts");
  assert.equal(workerScopeTarget({ type: "read", path: "src/a.ts" }), "", "reads are unscoped");
  assert.equal(workerScopeTarget(null), "");
});

// 这条守的是一次真实的作用域逃逸，不是命名口味。
//
// copy 原本继承了 FILE_OP 里 write/edit 的 scopeField:"path"。对那几个工具 path 就是被
// 改的文件，对 copy 不是：`copy_path(from,to)` 映射成 `{path: from, to}`，写落在 `to`。
// 于是 worker A（scope=["src/a/"]）调 copy_path(from:"src/a/template.js",
// to:"src/b/injected.js")：main.js 的 worker 门取 workerScopeTarget(call) 得到**源**，
// 源在 A 的 scope 里 → 放行；文件却建到了并行的 worker B 的地盘上。并行 worker 的安全
// 前提就是 _scopesOverlap 保证的互不相交，delete/move 被整个禁掉正是为了它。
//
// 注意上面那条老断言（path 为空、只有 to）**挡不住这个回归**：scopeField 退回 "path"
// 时它照样绿，因为 workerScopeTarget 会 `call[field] || call.dest || call.to` 兜到 to。
// 所以这里必须给出**两个字段都非空且不同**的调用——那才是逃逸的真实形状。
test("a worker's copy is scope-checked at the destination, not the source", () => {
  assert.equal(workerScopeField("copy"), "to");
  assert.equal(
    workerScopeTarget({ type: "copy", path: "src/a/template.js", to: "src/b/injected.js" }),
    "src/b/injected.js",
    "copy 按源判作用域 —— worker 可以把文件写进别的 worker 的 scope",
  );
});

// ── Behaviour of the registry itself ────────────────────────────────────────

test("an unregistered tool gets the safe default, so read-only tools need no declaration", () => {
  // The large majority of the 126 call types are read-only lookups. Requiring a declaration
  // for each would be a list that rots; the default IS their policy.
  for (const t of ["npm_search", "arxiv_search", ""]) {
    assert.deepEqual(toolPolicy(t), DEFAULT_POLICY, `${t || "(empty)"} should default`);
  }
  // 纯读工具唯一声明的是「能并行」（parallelSafe），三道门一个都不声明——门的部分仍然
  // 就是默认值。这条守的是「读工具不需要为门写声明」，不是「读工具不许出现在注册表里」。
  for (const t of ["read", "list", "current_time", "think"]) {
    assert.deepEqual(toolPolicy(t), { ...DEFAULT_POLICY, parallelSafe: true }, `${t} 除了并行声明之外应当全是默认值`);
  }
  assert.equal(needsApproval("some_tool_invented_tomorrow"), false);
  assert.equal(blockedInReadOnlyMode("some_tool_invented_tomorrow"), false);
});

test("adding a tool is one call, and it is reflected in every derived set at once", () => {
  // This is the property the whole module exists for: one declaration, not eleven edits.
  defineTool("__test_tool__", { mutatesWorkspace: true, needsApproval: true, readOnlyModeBlocked: true });
  assert.ok(workspaceMutatingTypes().has("__test_tool__"));
  assert.ok(approvalTypes().has("__test_tool__"));
  assert.ok(readOnlyBlockedTypes().has("__test_tool__"));
  assert.equal(hookedTypes().has("__test_tool__"), false, "unspecified flags stay at the default");
  // Re-declaring replaces cleanly, so a plugin can override a built-in.
  defineTool("__test_tool__", { needsApproval: true });
  assert.equal(mutatesWorkspace("__test_tool__"), false);
});

test("a typo'd policy field is rejected at declaration instead of silently doing nothing", () => {
  // A misspelled flag would be the exact bug class this module removes — a policy that looks
  // set and isn't. Fail loudly, at startup, where it is cheap to notice.
  assert.throws(() => defineTool("__bad__", { mutatesWorkspce: true }), /unknown tool policy field/);
  assert.throws(() => defineTool("", {}), /requires a tool type/);
});

test("policies are frozen so a call site cannot mutate shared policy by accident", () => {
  const p = toolPolicy("write");
  assert.throws(() => { "use strict"; p.needsApproval = false; }, TypeError);
  // allPolicies hands out copies, so diagnostics can't corrupt the registry either.
  const snapshot = allPolicies();
  snapshot.write.needsApproval = false;
  assert.equal(needsApproval("write"), true);
});

// ── The anti-drift test ─────────────────────────────────────────────────────

test("main.js no longer hand-maintains the tool family lists", () => {
  // The literal that appeared ELEVEN times. Once the call sites are derived, a new copy
  // appearing is a regression toward the thing this module replaced — so fail on it.
  const literalCopies = (MAIN.match(/"write",\s*"edit",\s*"multiedit",\s*"delete",\s*"move",\s*"mkdir",\s*"copy",\s*"format"/g) || []).length;
  assert.equal(literalCopies, 0,
    "the mutation-family list must come from tool-policy.js, not be re-typed at the call site");
  // The eleven-term read-only chain likewise.
  assert.doesNotMatch(MAIN, /readOnlyMode && \(call\.type === "write" \|\| call\.type === "edit"/,
    "the read-only-mode rule must come from blockedInReadOnlyMode()");
  // And main.js must actually be importing the module rather than keeping a parallel copy.
  assert.match(MAIN, /import \{[^}]*\} from "\.\/agent\/tool-policy\.js"/,
    "main.js must consume the registry");
});

// ── 只读模式里的 MCP：按服务自己的声明逐次判，不整类一刀切 ────────────────────
//
// 以前 mcp 类型是 readOnlyModeBlocked: true，于是 Plan / Explorer / Reviewer 里
// 用户装的 MCP 服务一个都用不了。可"查官方文档、读表结构、看 issue"恰恰是
// 先调研再动手最需要的东西——调研这一半反而没工具。
// 但也不能反过来全放：MCP 规范里 readOnlyHint 是**可选**的，多数服务不写；
// 缺声明时必须按"可能有副作用"处理，否则只读模式会替用户改了东西。
test("只读门必须收到整个 call——少传一个实参，MCP 又被一刀切挡回去而且全绿", () => {
  // 这里破例用源码断言（本文件开头反对钉源码形状，但 anti-drift 小节是它自己写明的例外）：
  // MCP 的只读判定是**逐次**的，policy 里是个 lambda。调用点写成 blockedInReadOnlyMode(call.type)
  // 的话，lambda 收到 undefined → !undefined === true → 只读模式里所有 MCP 全被挡，
  // 而下面那些直接调函数的行为测试照样通过。钉的是元数，不是变量名。
  assert.doesNotMatch(MAIN, /blockedInReadOnlyMode\(\s*[A-Za-z_$][\w$]*\.type\s*\)/,
    "只读门只收到了 type，MCP 的逐次判定退化成一刀切");
  assert.match(MAIN, /blockedInReadOnlyMode\(\s*[A-Za-z_$][\w$]*\.type\s*,\s*[A-Za-z_$][\w$]*\s*\)/,
    "main.js 必须把整个 call 交给只读门");
});

test("声明了只读的 MCP 工具，在只读模式里可以用", () => {
  assert.equal(blockedInReadOnlyMode("mcp", { type: "mcp", mcpReadOnly: true }), false);
});

test("没声明只读的 MCP 工具照旧挡住——缺声明按有副作用处理", () => {
  assert.equal(blockedInReadOnlyMode("mcp", { type: "mcp", mcpReadOnly: false }), true);
  assert.equal(blockedInReadOnlyMode("mcp", { type: "mcp" }), true, "没有这个字段时必须挡");
  assert.equal(blockedInReadOnlyMode("mcp", undefined), true, "连 call 都没有时必须挡");
});

test("其它类型不受影响：写文件和跑命令在只读模式里照旧禁止", () => {
  for (const t of ["write", "edit", "multiedit", "cmd"]) {
    assert.equal(blockedInReadOnlyMode(t), true, `${t} 不该在只读模式里放行`);
  }
  assert.equal(blockedInReadOnlyMode("read"), false);
});

test("MCP 在只读模式里放行，不等于不用审批", () => {
  // 两道门是独立的：readOnlyModeBlocked 管"这个模式能不能做这件事"，
  // needsApproval 管"要不要问用户"。放行第一道不该顺手关掉第二道。
  assert.ok(needsApproval("mcp"), "mcp 不再需要审批了");
});

// ── worktree ────────────────────────────────────────────────────────────────
// 这个工具一直**完全没登记**，拿的是默认策略（不审批、只读模式不挡）。它在磁盘上建目录、
// 删目录（remove 连未提交的改动一起删），却能在 Plan / Explorer / Reviewer 这三个声称
// 只读的模式里跑。和当初 termtask 是同一类漏登记。

test("worktree list 在只读模式里能用——「先看看有哪些候选」正是 Plan 要做的事", () => {
  assert.equal(blockedInReadOnlyMode("worktree", { type: "worktree", action: "list" }), false);
});

test("worktree add / remove 在只读模式里挡住——它们动磁盘", () => {
  for (const action of ["add", "remove"]) {
    assert.equal(blockedInReadOnlyMode("worktree", { type: "worktree", action }), true, action);
  }
});

test("worktree 没带 action 时按 list 处理（工具定义里 list 就是默认动作）", () => {
  assert.equal(blockedInReadOnlyMode("worktree", { type: "worktree" }), false);
});

test("worktree 算改动工作区——它在 <root>/.mrdayone/worktrees 下面造东西", () => {
  assert.equal(mutatesWorkspace("worktree"), true);
  assert.ok(workspaceMutatingTypes().has("worktree"));
});

// 上面那条守卫有个它自己看不见的盲区：`workspaceMutatingTypes()` 只枚举**已经登记进
// REGISTRY 的**类型。一个工具压根没 defineTool 过，它的策略就全取默认值（needsApproval
// 是 false），既不在 approvalTypes 里也不在 workspaceMutatingTypes 里 —— 两个集合相减
// 恒等于空，守卫永远绿。2026-08-17 的审计就是这么挖出 browser / docker_compose_up /
// capture_replay / system 四个的：全都有真实外部副作用（任意 JS、读会话 cookie、上传本机
// 绝对路径文件、起容器、发任意 HTTP、开 App 切窗口），"改动前审批"开着也一次框都不弹，
// 而同类的 uiclick / automation 早就登记了。漏登记不报错，是这个盲区唯一的症状。
//
// 所以这条守卫换个方向：从 **_mapToolCall 真正会产出的 call.type** 出发反过来查。
// 每一种都必须被归类——要么进 REGISTRY（有策略），要么写进下面这张"确认无需审批"的
// 明单。新加一个工具时两边都不写，这条就红。
//
// 明单是**棘轮，不是体检报告**：这些是审计当天的既有状态。2026-09-04 又逐个打开执行分支
// 核了一遍，从这里摘走六个登记进策略表：memory（写盘）、explain / demostop（写盘）、
// termstop（杀进程）、http / tor（按 method 判）。仍留在这里、值得单独判的：preview /
// demostart 会起服务，subagent / spawnmulti 会派出子智能体。
// 它们留在这里只表示"今天不问"，不表示"已确认不该问"。
const NO_APPROVAL_TODAY = new Set([
  // office_read 只读 Office 文件的结构，不落盘、不联网。
  "office_read",
  "arxiv_search", "askuser", "awaitsubagent", "awwwards_search", "background_monitor",
  "bundlephobia_search", "capture_flows", "capture_stop", "clinical_trials_search",
  "codeberg_repo", "codrops_search", "crossref_search", "current_time", "cve_search", "debate",
  "demostart", "designboard", "developer_community_search", "diag",
  "figma", "find", "findsymbol", "gh", "git", "gitee_repo", "github_repo", "github_search",
  "gitlab_repo", "hackernews_search", "iconify_search", "knowledge", "learndesign",
  "list", "liveenvironment", "localdiscovery", "logs", "lsp", "mdn_search",
  "openalex_search", "openapi_parser", "package_search", "package_source",
  "performance_profile", "plan", "preview", "probeenv", "pubchem_search", "pubmed_search",
  "qr", "read", "readscreen", "realtime_news_feed", "recall", "screenshot", "search",
  "search_game_assets", "search_tools", "semsearch", "skill",
  // load_guide：客户端只回一句「已附上」，指南正文由网关按对话内容贴上；不落盘不联网。
  "guide", "smashingmag_search",
  "spawnmulti", "stackoverflow_search", "steam_search", "subagent", "termlist", "termread",
  "think", "uiextract", "viewimage", "vizcompare", "web", "websearch",
  "wiki_search", "worker",
]);

/** _mapToolCall 会产出的全部 call.type。剥注释再取，免得被注释里引用的旧类型名喂到。 */
function mappedCallTypes() {
  const at = RAW_SRC.indexOf("function _mapToolCall(");
  assert.ok(at > 0, "_mapToolCall 改名了，这条守卫要跟着改");
  let depth = 0, end = MAIN.length;
  for (let i = RAW_SRC.indexOf("{", RAW_SRC.indexOf(")", at)); i < MAIN.length; i++) {
    if (MAIN[i] === "{") depth++;
    else if (MAIN[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const body = MAIN.slice(at, end).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...body.matchAll(/\btype:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))].sort();
}

test("每一种工具调用类型都必须被归类——没登记也算漏，不是默认放行", () => {
  const types = mappedCallTypes();
  assert.ok(types.length > 100, `只解析出 ${types.length} 种类型，取法多半坏了`);
  const classified = (t) => {
    const p = toolPolicy(t);
    return p.needsApproval || p.mutatesWorkspace || p.readOnlyModeBlocked || NO_APPROVAL_TODAY.has(t);
  };
  const orphans = types.filter((t) => !classified(t)).sort();
  assert.deepEqual(orphans, [],
    "这些工具类型既没登记策略、也没写进「确认无需审批」的明单，于是默认无声放行：\n  "
    + orphans.join(", ")
    + "\n把它 defineTool 进 tool-policy.js，或者写进 NO_APPROVAL_TODAY 并说明为什么不用问。");
});

// ── 2026-09-04 审计：按调用判的那几类，细则逐条钉住 ─────────────────────────

test("db 按这一条语句判：SELECT 不弹框、只读模式放行、可并行；会写的三道门全关", () => {
  // 判据不在策略表里算：main.js 的 _dbCallMayMutate 判完把结论标到 call.dbMayMutate 上
  //（_requiresApproval 和 _executeToolStepInner 两处都标），策略表只读那一位。
  const sel = { type: "db", dbMayMutate: false };
  const drop = { type: "db", dbMayMutate: true };
  assert.equal(needsApprovalFor("db", sel), false, "SELECT 不该弹审批");
  assert.equal(blockedInReadOnlyMode("db", sel), false, "Plan 模式看一眼表结构是它最该干的事");
  assert.equal(toolPolicy("db").parallelSafe(sel), true);
  assert.equal(needsApprovalFor("db", drop), true);
  assert.equal(blockedInReadOnlyMode("db", drop), true, "只读模式里 DROP TABLE 照跑——这条原来就是这样");
  assert.equal(toolPolicy("db").parallelSafe(drop), false);
  // 没标注（不经 _mapToolCall 构造的调用）按会写处理：宁可多问，不能替用户 DROP。
  assert.equal(needsApprovalFor("db", { type: "db" }), true);
  assert.equal(blockedInReadOnlyMode("db", { type: "db" }), true);
  assert.equal(toolPolicy("db").parallelSafe({ type: "db" }), false);
});

test("automation 按方法判：观察类不弹框不挡，合成键鼠 / 写剪贴板要问且只读模式挡", () => {
  // 名单照 main.js 那条正则来（下一条测试对账）：browser.content 这类读页面正文的动作
  // 不在观察名单里——它跑在共享的自动化浏览器上，main.js 把它算成副作用，这里不另立判据。
  for (const m of ["screen.capture", "screen.info", "mouse.position", "clipboard.get", "window.list", "browser.nodes", "app.status", "wait"]) {
    assert.equal(needsApprovalFor("automation", { type: "automation", method: m }), false, `${m} 是观察`);
    assert.equal(blockedInReadOnlyMode("automation", { type: "automation", method: m }), false, `${m} 只读模式该能用`);
  }
  for (const m of ["mouse.click", "keyboard.type", "keyboard.combo", "clipboard.set", "window.activate", "app.open"]) {
    assert.equal(needsApprovalFor("automation", { type: "automation", method: m }), true, `${m} 动真格`);
    assert.equal(blockedInReadOnlyMode("automation", { type: "automation", method: m }), true, `${m} 只读模式必须挡`);
  }
  // 没给 method 按动真格处理。
  assert.equal(needsApprovalFor("automation", { type: "automation" }), true);
});

test("automation 的观察正则和 main.js 副作用判定里那条**逐字相同**", () => {
  // 两处对同一件事说不同的话就是事故：这边放行、那边判成副作用（或反过来）。
  const m = /if \(call\.type === "automation"\) return !\/(.+?)\/i\.test\(String\(call\.method \|\| ""\)\);/.exec(MAIN);
  assert.ok(m, "main.js 里 automation 那条副作用判定改了形状，这条对账要跟着改");
  assert.equal(m[1], AUTOMATION_OBSERVE_METHODS.source, "策略表和 main.js 的 automation 观察正则漂了");
});

test("http / tor 按 method 判：GET/HEAD/OPTIONS 放行且 GET/HEAD 可并行，写方法要问且只读模式挡", () => {
  for (const t of ["http", "tor"]) {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      assert.equal(blockedInReadOnlyMode(t, { type: t, method }), false, `${t} ${method} 只读模式该能用`);
      assert.equal(needsApprovalFor(t, { type: t, method }), false, `${t} ${method} 不该弹框`);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(blockedInReadOnlyMode(t, { type: t, method }), true, `${t} ${method} 只读模式必须挡`);
      assert.equal(needsApprovalFor(t, { type: t, method }), true, `${t} ${method} 必须问`);
    }
    assert.equal(toolPolicy(t).parallelSafe({ type: t, method: "GET" }), true);
    assert.equal(toolPolicy(t).parallelSafe({ type: t, method: "POST" }), false);
    assert.equal(blockedInReadOnlyMode(t, { type: t }), false, "没给 method 按 GET（和 _mapToolCall 的默认一致）");
  }
});

test("gh 的读 op 不弹框；git branch 不带名字是列分支，只读模式放行且可并行", () => {
  for (const op of ["pr_view", "pr_checks", "actions_log", "pr_review_comments"]) {
    assert.equal(needsApprovalFor("gh", { type: "gh", op }), false, `gh ${op} 是读`);
    assert.equal(toolPolicy("gh").parallelSafe({ type: "gh", op }), true);
  }
  for (const op of ["pr_create", "pr_reply"]) {
    assert.equal(needsApprovalFor("gh", { type: "gh", op }), true, `gh ${op} 不可逆，必须问`);
    assert.equal(toolPolicy("gh").parallelSafe({ type: "gh", op }), false);
  }
  assert.equal(blockedInReadOnlyMode("git", { type: "git", op: "branch" }), false, "列分支是纯读");
  assert.equal(toolPolicy("git").parallelSafe({ type: "git", op: "branch" }), true);
  assert.equal(blockedInReadOnlyMode("git", { type: "git", op: "branch", branch: "feat" }), true, "切/建分支动工作树");
  assert.equal(blockedInReadOnlyMode("git", { type: "git", op: "branch", create: true }), true);
  assert.equal(toolPolicy("git").parallelSafe({ type: "git", op: "commit" }), false);
  assert.equal(toolPolicy("git").parallelSafe({ type: "git", op: "diff" }), true);
});

test("补登记的四个：memory / termstop 只读模式挡但不弹框；explain / demostop 写盘、要问、只读挡", () => {
  for (const t of ["memory", "termstop"]) {
    assert.equal(blockedInReadOnlyMode(t), true, `${t} 只读模式要挡`);
    assert.equal(needsApproval(t), false, `${t} 不该弹框（收尾 / IDE 自己的目录）`);
    assert.equal(mutatesWorkspace(t), false, `${t} 不报 mutated，不能进 mutating 集合`);
  }
  for (const t of ["explain", "demostop"]) {
    assert.equal(mutatesWorkspace(t), true);
    assert.equal(needsApproval(t), true);
    assert.equal(blockedInReadOnlyMode(t), true);
  }
  // 十一个生成器 + download：只读模式挡。原来只有审批一道门。
  for (const t of ["genimage", "generate_3d", "generate_sound", "generate_music", "generate_voice", "auto_rig", "generate_motion", "generate_texture", "game_scaffold", "web_scaffold", "download_asset", "download", "office_write", "office_edit"]) {
    assert.equal(blockedInReadOnlyMode(t), true, `${t} 往工作区落文件，只读模式必须挡`);
  }
  assert.equal(blockedInReadOnlyMode("capture_start"), true, "改写系统代理不是只读");
});

test("并行安全性是声明出来的：main.js 那份 _READ_ONLY_TYPES 名单和 parallelSafeTypes() 逐个对账", () => {
  // main.js 那份文本暂时留着（三处测试用 load() 抠 _isReadOnlyParallel 跑，注入表里就是它），
  // 但它必须和声明**一致**——这条守卫让两边任何一边单独改都会红。
  const m = /const _READ_ONLY_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(MAIN);
  assert.ok(m, "main.js 里 _READ_ONLY_TYPES 的形状变了");
  const inMain = new Set([...m[1].matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]));
  const declared = parallelSafeTypes();
  // 已知的一处分歧，理由写在 PARALLEL_SAFE_READS 上：uiextract 会导航那一个共享的自动化浏览器，
  // 不该并行；但它同时在子体的 _READ_TYPES 里，logic.test.mjs 有一条「两份只读名单不许漂」
  // 的守卫要求它留在 main.js 那份里。那条守卫松绑之后把它一起摘掉。
  const KNOWN_DIVERGENCE = new Set(["uiextract"]);
  const onlyMain = [...inMain].filter((t) => !declared.has(t) && !KNOWN_DIVERGENCE.has(t)).sort();
  const onlyDeclared = [...declared].filter((t) => !inMain.has(t)).sort();
  assert.deepEqual(onlyMain, [], `main.js 认为可并行、策略表没声明：${onlyMain.join(", ")}`);
  assert.deepEqual(onlyDeclared, [], `策略表声明可并行、main.js 名单里没有：${onlyDeclared.join(", ")}`);
  assert.deepEqual([...declared].sort(), [...PARALLEL_SAFE_READS].sort(), "声明的集合就是 PARALLEL_SAFE_READS，别在别处再登记");
  // 类型级声明为 true 的是布尔；没声明的默认假——「没有证据说它不动东西就不并行」。
  assert.equal(toolPolicy("read").parallelSafe, true);
  assert.equal(toolPolicy("write").parallelSafe, false);
  assert.equal(toolPolicy("完全不存在").parallelSafe, false);
});

test("四个有外部副作用的工具已经在审批门内——它们曾经整整一轮都在门外", () => {
  for (const t of ["docker_compose_up", "capture_replay"]) {
    assert.equal(needsApproval(t), true, `${t} 又掉出审批门了`);
  }
  // browser 和 system 都是按动作判的，所以 needsApproval 是函数而不是 true。
  for (const t of ["browser", "system"]) {
    assert.equal(typeof needsApproval(t), "function",
      `${t} 又变回一刀切了——看一眼/问一句也要弹框，用起来就是「做点事就撞门」`);
  }
  // system 的纯读动作：问"现在开着什么、哪个在前台、这个 App 有哪些菜单项"不该弹框，
  // 更不该在 Explorer / Plan / Reviewer 里被挡 —— 那三个模式本来就只看不动，
  // 一刀切正好把「了如指掌」卡死在最需要它的地方。
  for (const op of ["apps", "windows", "frontmost", "menu_items"]) {
    const call = { type: "system", op };
    assert.equal(needsApprovalFor("system", call), false, `system.${op} 是纯读，不该弹框`);
    assert.equal(blockedInReadOnlyMode("system", call), false, `system.${op} 在只读模式里该能用`);
  }
  for (const op of ["open", "focus", "menu"]) {
    const call = { type: "system", op };
    assert.equal(needsApprovalFor("system", call), true, `system.${op} 会动真格，必须问`);
    assert.equal(blockedInReadOnlyMode("system", call), true);
  }

  // 真有副作用的动作：审批门要问，只读模式要挡。
  for (const action of ["eval", "cookies", "storage", "upload", "autofill", "click", "type", "fill", "batch"]) {
    const call = { type: "browser", action };
    assert.equal(needsApprovalFor("browser", call), true, `${action} 该问却没问`);
    assert.equal(blockedInReadOnlyMode("browser", call), true, `${action} 在只读模式该挡`);
  }
  // 纯观察：两道门都不该拦。observe / inspect / network 是"看页面"的主力动作，
  // 上一版把它们漏在名单外，于是 Plan / Explorer 里连看都看不了。
  for (const action of ["navigate", "observe", "inspect", "network", "nodes", "screenshot", "scroll", "close"]) {
    const call = { type: "browser", action };
    assert.equal(needsApprovalFor("browser", call), false, `${action} 是观察，不该弹框`);
    assert.equal(blockedInReadOnlyMode("browser", call), false, `${action} 是观察，只读模式不该挡`);
  }
});

test("browser 的观察动作名单必须来自 schema 的 action 枚举，不能手打", () => {
  // 上一版就是手打的：里面 read / text / back / forward 四个动作**在 schema 里根本不存在**，
  // 而真正的 observe / inspect / network / nodes 一个都没列——名单写错了不会有任何报错，
  // 只会表现成"只读模式下它连页面都看不了"和"看一眼也弹框"。
  const raw = JSON.parse(readFileSync(join(HERE, "../../server/prompts/tools.json"), "utf8"));
  const list = Array.isArray(raw) ? raw : (raw.tools || Object.values(raw)[0]);
  const fn = list.map((e) => e.function || e).find((f) => f.name === "browser");
  assert.ok(fn, "tools.json 里找不到 browser——这条断言失去落点");
  const actions = new Set(fn.parameters?.properties?.action?.enum || []);
  assert.ok(actions.size > 20, `action 枚举只剩 ${actions.size} 个，正则或 schema 变了`);

  const ghosts = [...BROWSER_OBSERVE_ACTIONS].filter((a) => !actions.has(a));
  assert.deepEqual(ghosts, [], "观察名单里这些动作 schema 里不存在（写了也永远不会命中）");
});

test("mytabs 算观察动作 —— 只读模式最需要它", () => {
  // mytabs 读的是**用户自己浏览器**已经开着的标签页标题和 URL（macOS，不起自动化窗口）。
  // 按 BROWSER_OBSERVE_ACTIONS 自己的判据——不改页面状态、不动会话、不碰本机文件——
  // 它三条都不沾。漏了它的代价恰好落在最需要它的地方：Explorer / Plan / Reviewer 三个
  // 只看不动的模式里问不出「用户现在开着什么页面」，而那正是这三个模式做判断的起点；
  // 更糟的是被挡下来时的话术会把它说成「禁止修改文件」。
  assert.ok(BROWSER_OBSERVE_ACTIONS.has("mytabs"),
    "mytabs 出了观察集 —— 只读模式会挡掉「看一眼用户开着什么」");
  assert.equal(toolPolicy("browser").readOnlyModeBlocked({ type: "browser", action: "mytabs" }), false,
    "只读模式挡住了 mytabs");
  assert.equal(toolPolicy("browser").needsApproval({ type: "browser", action: "mytabs" }), false,
    "读一眼标签页还要弹框");
  // `open` 故意不进：它在用户机器上**启动一个外部应用**，工作区没变不等于现实世界没变。
  assert.ok(!BROWSER_OBSERVE_ACTIONS.has("open"),
    "open 会在用户机器上起一个外部应用，不是纯观察");
});

test("会改工作区的工具，开了审批就必须问——豁免只能是有名有姓的那一个", () => {
  // 这条比上面那张字面量清单更耐用：新加一个写盘工具时，清单可以忘了改，这条不会。
  // 它抓到过一整族——出图/出模型/出音/出声/建脚手架/下载素材十个工具都写工作区，
  // 却一个都不问，等于「改动前审批」这个开关对十种写盘方式整体失效，而用户看不出来。
  const ask = approvalTypes();
  const gaps = [...workspaceMutatingTypes()].filter((t) => !ask.has(t)).sort();
  assert.deepEqual(gaps, ["worktree"],
    "这些工具会往工作区写东西，但开了「改动前审批」也不问：" + gaps.join(", ")
    + "\n（worktree 是唯一有意的豁免：只动 IDE 自己的 .mrdayone/worktrees/，"
    + "best-of-N 每建一个候选弹一次窗就没法用了。）");
});

// mcp_server 是**逐次**判定：list 只是读自己的配置，弹框纯属摩擦；其余四个动作都在改
// 持久化配置、而一条 MCP 配置就是一条会被执行的命令行，必须让用户点头。
test("mcp_server：list 只读不弹框，改配置的四个动作一律要用户点头", () => {
  assert.equal(needsApprovalFor("mcpconfig", { action: "list" }), false, "只看一眼配置也要弹框，用户会把审批直接关掉");
  for (const action of ["add", "remove", "enable", "disable"]) {
    assert.equal(needsApprovalFor("mcpconfig", { action }), true, `${action} 没要审批——它在改会被执行的配置`);
  }
  // 缺 action 时按最严处理：默认值是 list，但拼错/漏填不能顺势变成免审批。
  assert.equal(needsApprovalFor("mcpconfig", { action: "LIST" }), false, "大小写要归一，否则用户看到无意义的弹框");
  assert.equal(needsApprovalFor("mcpconfig", { action: "adD" }), true, "大小写混写就绕过了审批");
  // 只读模式同理：看得，改不得。
  assert.equal(blockedInReadOnlyMode("mcpconfig", { action: "list" }), false);
  assert.equal(blockedInReadOnlyMode("mcpconfig", { action: "add" }), true);
});

test("remote 切换主机要过审批门，查询不打扰", () => {
  // 用户实拍不到这一条，因为它**从来不弹框**：`remote(connect)` 把 backend 的读/写/删/
  // 建目录/改名/复制/搜索/跑命令整体重定向到模型给的地址，并把守护进程 token POST 过去。
  // 而 type "remote" 此前根本没进过策略表 → DEFAULT_POLICY → needsApproval:false。
  // 判据在 _toolMayProduceExternalEffect 里早就写对了（connect/disconnect），
  // 只是审批门只对 gh/http/tor 三个特判去问它，remote 走的兜底读的正是这张表。
  const ask = (op) => needsApprovalFor("remote", { type: "remote", op });
  assert.equal(ask("connect"), true, "切到另一台机器竟然不用问");
  assert.equal(ask("disconnect"), true);
  assert.equal(ask("status"), false, "查一下连没连也弹框，就是「做点事就撞门」");
  assert.equal(ask(undefined), false, "没给 op 默认按查询算");

  // 只读模式只挡 connect：disconnect 是退回本机，挡住反而把人锁在远端。
  assert.equal(blockedInReadOnlyMode("remote", { type: "remote", op: "connect" }), true);
  assert.equal(blockedInReadOnlyMode("remote", { type: "remote", op: "disconnect" }), false);
  assert.equal(blockedInReadOnlyMode("remote", { type: "remote", op: "status" }), false);
  assert.match(String(toolPolicy("remote").readOnlyBlockedVerb || ""), /另一台机器/);
});
