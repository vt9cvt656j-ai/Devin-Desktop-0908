import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acorn from "acorn";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * main.js 的尺寸闸。
 *
 * # 为什么要有它
 *
 * 实测增长：30 天前 52,537 行 → 7 天前 72,066 行 → 今天 83,384 行。**一个月 +59%**。
 * 这个文件里已经装着智能体主循环、141 个工具的 schema、全部工具执行分支、UI 渲染、
 * 会话管理、计费、终端、编辑器接线……任何一次排查都要先在五兆文本里定位。
 *
 * 这个仓库已经反复证明「往提示词里写劝诫」不解决结构问题——注意力预算那几条线用的是
 * **同一种机制**：钉一条线，撞线时必须给出理由才能抬，而抬线的注释本身成为账本。
 * 这条闸照抄那套：**要加东西可以，但得先腾出地方**。
 *
 * # 怎么用
 *
 * 撞线时不要直接抬数字。先问：这次新增的东西**能不能放进 src/agent/ 的一个模块**？
 * 判据是「边界干不干净」——只依赖参数、没有 DOM、没有模块级可变状态的，一律该搬。
 * 已经搬出去的：tool-policy / capabilities / shared-store / collaboration-engine /
 * job-queue / ansi / diff-view / escape / language / mainlink。
 *
 * 搬不动、又确实必须加在 main.js 里的（比如某个执行分支必须紧挨着主循环），
 * 才抬线，并在下面按格式补一行：日期、新值、实测值、**这一笔买到了什么**。
 * 抬线记录本身就是这个文件在长胖的证据链。
 *
 * # 抬线记录
 *
 * · 83_968（2026-09-02）：实测 83,966 行。**这一笔不是我加的**：本次改动净减 115 行
 *   （删掉 123 行「🎯 指元素给 AI」的死代码 —— 按钮撤掉之后 _attachElementPicker 和
 *   _renderPickPanel 都到不了了，连同那条只剩它在用的 _PICK_ELEMENT_JS 导入一起清掉；
 *   浏览器 URL 卡改成 Telegram 那种「站点名在上、标题在下」的写法 +8 行）。
 *   超线来自并行会话在同一时间往 main.js 里加的约 130 行 —— 记在这里是因为闸门按文件计，
 *   不按作者计。下一个人看到这条不必去找「谁把它撑大了」：本次的净变化是负的。
 *
 * · 83_835（2026-09-02）：实测 83,834 行，抬了 1 行 —— 而这一笔其实是**净减**：
 *   加了排队卡片的「删除」按钮（+ 一个只动队列的小函数），同时把「插话作废整批工具」
 *   那 40 行连同它的补账（结算流式落盘、补记 didMutate/_implOps、归零 quietTurns、
 *   单独保留正文）整块删掉了。删得掉是因为不再丢弃：手上这批照跑完，用户的消息随
 *   下一批工具结果一起递给模型 —— 对齐 Claude Code 的
 *   "Address the message above as you continue this turn"。插一句话的代价从「本轮全部
 *   返工」变成「下一轮开始调整」，而那一整套补账复杂度本来就是「丢弃」这个决定的连带成本。
 *
 * · 83_707（2026-09-02）：实测 83,706 行，抬了 2 行。买到的是**智能体写文件时不再抢走
 *   用户的插入点**。链路是：agent 要写文件 → 自动把它打开给用户看（这是「实时跟随」
 *   的本意，没错）→ 而 `activate()` 里那句 `monacoEditor.focus()` 是无条件的 —— 焦点从
 *   聊天输入框/终端/搜索框被夺进编辑器，插入点落在文件末尾，用户下一个字就打进了代码里。
 *   跟随策略里本来就有「任何时候都不许动光标」，但那一条只挡住了 setPosition；
 *   抢焦点是同一件事的另一条路，而且更狠。策略模块补了第四条（takeFocus 恒 false），
 *   留在这里的 2 行是接线：activate 的可选参数 + openFile 把它透传下去 ——
 *   这两处必须在 main.js，因为 activate 有 12 个调用点，默认必须保持「用户点开＝给焦点」。
 *
 * · 83_176（2026-09-02）：实测 83,175 行，抬了 1 行。买到的是自定义端点上「模型名和
 *   协议对不上」的提示。用户实际撞到的上游报错原文：「本条请求疑似协议和模型不匹配
 *   导致 cache 异常，调用 claude-fable-5-1 模型请使用 Anthropic 协议。」——界面上此前
 *   没有任何东西提醒：协议默认 OpenAI 兼容，填个 Claude 模型名照样保存成功、照样发得
 *   出去，直到上游回一句看不懂的错，或者更糟：不报错、只是缓存全程不命中，而
 *   Anthropic 的缓存写入按输入价 1.25 倍收，写了从来读不到比不缓存还贵 25%。
 *   判据与全部说明在 src/agent/wire-protocol.js（只提示不拦截：确实存在用 OpenAI
 *   兼容协议转发 Claude 的中转，而判据是用户自己填的名字，不是执行事实）。
 *
 * · 83_175（2026-09-02）：实测 83,173 行，抬了 2 行。买到的是**指令层级真的能发出去**。
 *   在这之前，全系统唯一一句说明「几种指令谁大谁小」的话写在 `_userRulesBlock()` 里，
 *   整段包在 `if (rules)` 内 —— 所有者本人的 rules.md 是 0 字节，那句话**一次都没进过
 *   提示词**；而项目约定、用户习惯、检索到的资料这些照样在场，冲突时纯靠谁排后面谁响。
 *   层级正文与全部说明都在 src/agent/prompt-layers.js（权威那份在网关的
 *   system_invariants.txt，是每个模式的第一块）；留在这里的 2 行是那个可选参数本身 ——
 *   它必须在这个函数里，因为「这一路收不收得到网关那份」只有调用点知道。
 *
 * · 83_100（2026-09-02）：实测 83,099 行。买到的是**子智能体一轮里的纯读工具真的并发**。
 *   主循环早有并发调度器，而子体走的是另一条完整的模型循环，里面是
 *   `for (const tc of turn.toolCalls) { … await … }`，严格串行 —— 偏偏「一轮发三个 read」
 *   最常出现的就是子体（research_project / run_worker / spawn_multiple_agents 全由它承载，
 *   这些角色的活基本就是读和搜）。判据（哪些批次能整批起跑、为什么必须**整批**而不能
 *   挑着起跑）已经搬进 src/agent/subagent-batch.js，8 条真往返测试守着；留在这里的是接线：
 *   建工具卡、起 promise、在原位取用 —— 这三件都必须贴着那个循环，因为工具卡要 append
 *   进子体自己的视口，而 tool 结果必须与声明它们的 assistant 消息连续相邻且同序。
 *
 * · 83_081（2026-09-02 第 N 次）：实测 83,081 行，只抬了 3 行。买到的是**空转断路器不再
 *   同时犯两个方向相反的错**。判据本身已经搬进 src/agent/idle-progress.js（纯函数、8 条真
 *   往返测试），留在 main.js 的只有接线——它必须紧挨着主循环，因为三个信号源
 *   （运行期证据、外部证据、产出）都是在那一轮的收尾现场才成形的。两个错分别是：
 *   ① **拦不住**：run_cmd 的「改了工作区」可以只来自模型自填的 purpose（_toolMutatesWorkspace
 *      对 cmd/termtask 是「事实 OR 声明」），于是一轮一轮重跑 `npm install` 每轮都记一次产出、
 *      每轮把空转计数清零 —— 断路器在它自己的目标场景里永远不触发。
 *   ② **误杀**：每记一次产出会故意删掉 build/test/run/package 四类验证凭据（凭据随产物过期，
 *      这是对的），而空转判据直接数那个集合的 size，于是「改代码 → 跑测试 → 改代码」这种
 *      正常节奏净变化可能是 -3，水位线不升，反倒记一次空转。
 *
 * · 82_180（2026-08-31 第十四次）：实测 82,122 行。买到的是「上下文来源」活过重启——分项是
 *   发送那一刻才算得出来的（规则/技能/语言块/工具 schema/对话历史都在那步成形），本地重算
 *   不出来，和上下文读数同一个性质，所以搭同一班车塞进 ctxFloor（写点读点各两个、四条路
 *   都是通的）。留在 main.js 的是序列化那一小段和两处回灌，它们必须待在读写现场；另外
 *   分项还得进落盘指纹，否则快照走缓存、它永远落不了盘（那段注释里已为 ctxFloor 记过这个坑）。
 *
 * · 82_100（2026-08-31 第十三次）：实测 82,048 行。买到的是两件事：
 *   ① 上下文环**真的点得开**——上一版把接线写进了 `if (!el)`，而 #tokenMeter 是 Shell.jsx
 *      静态渲染的，那个分支一次都不会进；连 role=button 和 cursor:pointer 都没生效。
 *      改成拿到元素之后按 dataset 标记一次性绑定，并按本仓惯例用 pointerdown（WKWebView
 *      在渲染繁忙时吞 click）。
 *   ② 面板第二段「来源」：发送那一刻把客户端真拼过的几块（用户规则 / 技能 / 语言与鉴权块 /
 *      工具 schema / 对话历史）逐块估下来记在 session 上，量不到的那部分（网关注入的系统
 *      提示词与内置工具定义）按「上游真实读数 − 这些」倒推。判据在
 *      src/agent/context-parts.js，纯函数；留在 main.js 的是三处**记录点**——它们必须待在
 *      拼装现场（fullPrompt / messages / _toolSchemas 各自成形的那一行），搬走就只能改成
 *      "把整套拼装再传一遍"。
 *
 * · 82_020（2026-08-31 第十二次）：实测 81,956 行。买到的是「点上下文环弹出用量面板」——
 *   原来这些数只在 hover 的 tooltip 里，要把鼠标悬在一个 22px 的小圆环上不动，读到的还是
 *   一段没有结构的文本。判据和排版全在 src/agent/context-usage.js（纯函数，真跑）；
 *   留在 main.js 的是弹层：要 getBoundingClientRect 定位、要往 body 上挂、要挂
 *   document 级的"点外面就关"，搬出去只会变成把这些再传回来的假模块。
 *
 * · 81_960（2026-08-31 第十一次）：实测 81,891 行。这一轮买到的是两件事：会话标签页的标题
 *   取自第一句话（纯逻辑在 src/agent/chat-title.js，main.js 里只有 sendPrompt 里那一小段
 *   接线），以及回复底下那个计时器**自己会停**——原来它靠"每条收尾路径都记得调 stop()"，
 *   而收尾段里 stop() 前面排着一串会抛的活，任何一处抛出来计时器就永远转下去（用户实拍
 *   「任务都结束了却还一直在数」）。判据改成每一跳自问「这一轮还活着吗」，加上把 stop 挪到
 *   finally 的第一行。这几段都要读 session.streaming、要动 DOM、要停 setInterval，搬不出去。
 *
 * · 81_900（2026-08-31 第十次）：实测 81,847 行。买到的是悬浮说明（鼠标停在函数/变量上那块）
 *   三件事：内容显示全（出厂那档高度会把文档字符串切在半句话上）、配色进主题、以及**文档
 *   按用户选的语言自动翻**——用户原话「对每个开发者都能很友好」。
 *   纯的那些全在 src/agent/hover-doc.js（切代码围栏、判值不值得翻、拼回去、整段走一遍，
 *   翻译器从参数进，真跑）；i18n 那边加了个带超时的 translateNow，复用临时翻译的缓存。
 *   留在 main.js 的只有两处：defineTheme 里的 editorHoverWidget.* 几个键，和把这条流程注入
 *   给 lsp-client 的那一行——lsp-client 是被测试用 new Function 直接跑的，多一条静态 import
 *   就整份加载不了，所以只能从外面注入。
 *
 * · 81_860（2026-08-31 第九次）：实测 81,834 行。买到的是 Peek 浮层（⌘+单击落在定义自己
 *   身上时弹的「引用 (N)」）不再是 Monaco 的出厂样子——亮蓝粗边 + 浅灰列表贴在这个应用的
 *   编辑器上像另一个软件的窗口。配色走主题键（peekView*），而不是拿 CSS 去盖 Monaco 的
 *   内部类名：类名升级一次就可能对不上，而那时是**静默**退回出厂配色。
 *   浅色为此要有自己的主题（原来直接用内置的 "vs"，一个键都设不上），rules 为空、只补
 *   colors，语法着色一个字不动。这两段是 defineTheme 的调用，天然只能在这儿。
 *
 * · 81_800（2026-08-31 第八次）：实测 81,791 行。买到的是「语言服务没起来时状态栏要说出来」
 *   ——原来一个服务都没起来就 removeStatusBarItem("lsp")，屏幕上干干净净，用户看到的是补全、
 *   ⌘+单击跳转、鼠标悬浮说明同时消失而没有任何解释，于是问「这个 IDE 没有跳转功能吗」。
 *   现在写明「LSP: <语言> 未启动」，带上上次的停止原因，点一下重试。
 *   这一段搬不出去：它要读 monacoEditor 的当前 model、要调 lspManager、要写状态栏 DOM。
 *
 * · 81_760（2026-08-31 第七次）：实测 81,696 行。买到的是「在编辑器里选中一段代码，
 *   按住拖进对话框」（用户原话：「我鼠标选中的内容 要能够直接拖拽到对话框那里 使用」）。
 *   落下去是一枚片，发送时展开成带出处的代码块——出处不是装饰，模型得知道是哪个文件的
 *   哪几行才能改它。
 *   纯的那一半进了 src/agent/selection-drag.js（标签怎么写、正文怎么围栏、超长怎么明说
 *   截断，全部从参数进，真跑）。留在 main.js 的是鼠标那一半：要 getBoundingClientRect
 *   判落点、要 Monaco 的 getTargetAtClientPoint 判「按下的地方在不在选区里」、要往
 *   document.body 上挂那个跟手的幽灵——三样都是 DOM 和编辑器实例，搬出去只会变成把它们
 *   再传回来的假模块。和文件树那条拖拽没有合并也是有意的：树里那条还要画目标目录、还要
 *   真的移动文件，合在一起会让它的每个判据都多出一支「这次不是文件」。
 *
 * · 81_640（2026-08-30 第六次）：实测 81,584 行。买到的是输入框里那些内联「片」
 *   （@文件 / @github:owner/repo）真正能用：方向键跨过去、退格一次只删一个、相邻两片之间
 *   垫真空格。这三件都不是锦上添花——片是 contentEditable=false 的原子节点，WKWebView 在
 *   这种结构上**不给可用的默认行为**：光标跨不过去、一次退格把三个片全删了、两片贴在一起
 *   没有可编辑位置。三条都是用户实拍报回来的。
 *   纯判断都进了 src/agent/explorer-drop.js（chipBeside / chipSpacers，节点从参数进，
 *   用假 DOM 真跑）；留在 main.js 的是两个键盘处理器和一个三行的插入垫片，
 *   它们要读 promptEl、window.getSelection、document.createRange —— 搬出去只会变成
 *   把这些再传回来的假模块。
 *
 * · 81_560（2026-08-30 第五次）：实测 81,510 行。买到的是右键菜单里的「移除文件 / 移除目录」
 *   ——把条目从文件树里藏起来，**磁盘上原样不动**（用户原话：「不是移除到废纸篓，而是移除
 *   让用户看不见 而不是真正的删除，我这里写了删除按钮了都」）。隐藏清单按项目分开存，
 *   隐藏一个目录会连同它底下的东西一起藏，并且必须给一条回头路（「恢复已移除的 N 项」），
 *   否则它就是个单向操作。
 *   能进模块的都进了：清单的增删查、判定某条路径要不要藏、以及存取的薄包装（storage 从
 *   参数传），全在 src/agent/explorer-drop.js。留在 main.js 的是读 rootPath、改 _treeSel、
 *   reloadDir 和 toast —— 都要模块级可变状态或 DOM，搬出去只会变成把变量再传回来的假模块。
 *   同期还**删了**东西：拖项目文件夹到根改成直接换项目之后，那个三按钮弹框和它的文案函数
 *   rootDropQuestion 一起去掉了。
 *
 * · 81_500（2026-08-30 第四次）：实测 81,431 行。用户两句：「不能替换整体目录了」「完全和
 *   vscode 不一样，好好学些 vscode」。于是去读了 VS Code 的真实实现（Cursor 是它的分支，
 *   读的是打包产物），按读到的代码对齐，顺带修掉四个照着它才发现的真 bug：
 *     · 落点反馈只染一行 —— VS Code 是 `feedback: L6(u, u+getListRenderCount)`，覆盖目标行
 *       **连同整棵已渲染子树**，同色。只染一行说不清「东西进的是这个容器」。
 *     · 悬停自动展开对**折叠的工作区根**是死的：根走 collapsedWorkspaceRoots，而
 *       _treeSetExpanded / expandDir 对根都直接 return。
 *     · 根落框只认活动根；多根工作区里往另一个根上放文件夹会被静默复制（VS Code 的判据
 *       是 e.isRoot，任意根都问）。
 *     · 拖多个文件夹时 `for (p of paths) await openFolder(p)` 后一个把前一个换掉，只剩最后
 *       一个；「打开为新项目」那条同样把多余的丢了。VS Code 是 1 个→打开、多个→建多根。
 *   能进模块的都进了（rootDropQuestion 的文案计算）；剩下的四段全要 DOM 或 workspaceRoots
 *   这类模块级可变状态，搬出去只会变成把变量再传回来的假模块。
 *   **同期还删了不少**：上一版自创的 drop-chip / editor-dropzone / 侧栏压暗 / dropFeedback
 *   已随「照 VS Code 重做」那一笔净减 92 行，这次是在那之上再加。
 *
 * · 81_400（2026-08-30 第三次，**往上抬**）：实测 81,350 行。买到的是「拖文件/文件夹到
 *   文件树 = 复制进工作区」（VS Code 的分工）。在此之前拖到侧栏一律走「打开」：文件夹
 *   直接 openFolder() 换掉整个工作区——用户拖一个子文件夹进来，项目被重新打开了。
 *
 *   能搬的都搬了：目标目录解析、重名让路（Finder 的 `notes 2.txt`）、**把文件夹拖进它
 *   自己的防护**（后端 copy_dir_recursive 会一边读一边往里写，无限长出嵌套目录）、整批
 *   投放计划，全部在 `src/agent/explorer-drop.js`（95 行，纯函数，8 条真往返测试）。
 *   留在 main.js 的四段按这条闸的判据是搬不动的：`_dropPointIn` 要 getBoundingClientRect
 *   和 devicePixelRatio、`_dropDirAt` 要 elementFromPoint 命中树行、`_dragTargetAt` 要读
 *   实时的 rootPath、`_copyIntoWorkspace` 要调 backend 并刷新树/Git——DOM 与模块级可变
 *   状态各占一头，搬出去只能变成「把 main.js 的变量再传回来」的假模块。
 *
 *   **同一条线的续账（同日）**：实测 81,393 行，余 7。用户报「看不出会落进哪个文件夹，
 *   还是替换整个工作区」，于是补了行级高亮 + 跟随光标的目标标签 + 编辑器区那档自己的
 *   投放框。这一笔顺带修了四个真 bug，都不是视觉问题：反馈画在了错的面板上（光标在
 *   编辑器、亮的是侧栏）、Git 视图下 #tree 塌成 0 导致往侧栏拖文件夹会换掉项目、拖放
 *   事件用全局 listen 让两个窗口各执行一遍、浏览器路径的 CSS 坐标没乘回 dpr。
 *   文案与语义判断（dropFeedback）在 explorer-drop.js，视觉全在 CSS；留在 main.js 的
 *   只有 DOM 命中与贴类。**余量只剩 7 行，下一个人先搬再加。**
 *
 * · 81_300（2026-08-30 第二次，**仍在往下**）：实测 81,264 行。抽出
 *   `src/agent/approval-label.js`（`_approvalLabel` 的 166 行 switch）。判据照 mainlink
 *   那次：唯一的外部依赖（MCP 快照表 `_mcpStates`）改成**从参数传**，main.js 侧留四行薄壳。
 *
 *   这一笔是被一次安全修复逼出来的，值得记：background_monitor 的 check_type:"command"
 *   会把模型给的串原样交给 shell 并重复跑几十次，而它**四道门一道都没登记过**
 *   （tool-policy 未注册 → 只读不拦、审批不弹；_PERM_TOOL_ALIASES.bash 不含它 → 用户的
 *   deny 规则连工具名都匹配不上；_permRuleSubject 取到空串 → 没有命令可比；
 *   _callIsDangerousCommand 只认 cmd/termtask → 危险命令不弹框）。run_worker 的 type
 *   "worker" 是同一种漏法：main.js 有四处把它当"改工作区"记账，判定表里却没有它，
 *   于是 Plan/Explorer/Reviewer 三个只读模式能派出会写文件的子体。补这两处要新增
 *   审批文案和判据分支，正好撞线——按这条闸的用法，先腾地方再加。
 *
 *   **抽完把线收回来。** 剩 36 行余量，留给在飞的活。
 *
 * · 81_400（2026-08-30，**往下收**）：实测 81,361 行。抽出 `src/agent/verification-evidence.js`
 *   （`freshBuildFailure` 发红灯、`evidenceCertifies` 发绿灯，连注释 103 行）。判据照旧：
 *   两个都只读传进来的 run/记录和一个数字，无 DOM、无模块级状态。
 *
 *   这两个是「已完成」判断的地基，而住在 main.js 里的时候**一条行为测试都没有**：
 *   版本钉（防「一次 npm test 替后面十二次编辑作证」）、按命令键控（防「另一条无关命令的绿
 *   替红作证」）、退出码 127/126 不算构建失败——三条都是踩过的坑，三条都只有源码断言。
 *   搬出去之后 12 处 `load()/fnSource()` 抠源码改成直接 import 产品代码，
 *   另有两处 `SRC.slice(indexOf(...), +1800)` 的固定窗口改成按 AST 取。
 *
 *   留 39 行余量：另一个会话的方案页签实时更新正在飞行中。余量给在飞的活，不给新功能。
 *
 * · 83_600（2026-08-25 首次设闸）：实测 83,384 行。同日刚把主↔子实时通道
 *   （_smRunToken / _drainSubAgentCollaborationInbox / _broadcastMainAgentFinding，
 *   101 行）搬进 src/agent/mainlink.js，作为「边界干净就该搬」的样板：那三个函数
 *   只依赖注入的 store 和一个 run 对象，搬完之后 agent-mainlink 那组测试从
 *   「用 acorn 抠源码文本再 new Function」改成**直接 import 产品代码**——
 *   前者验得到行为，验不到「这个函数还在不在真实调用链上」，而本仓库真出过
 *   「实现写好了、零调用点」。留 216 行余量给正在进行的修复，不是给新功能。
 * · 83_500（2026-08-25 第二次调整，**这次是往下调**）：实测 83,435 行。抽出第二块
 *   `src/agent/subagent-roles.js`（角色的工具矩阵 + 轮数预算，106 行）。判据和第一块
 *   一样：纯数据 + 纯函数、没有 DOM、没有模块级可变状态；唯一的外部依赖（用户自声明的
 *   角色表，它要读工具注册表）改成**从参数传**，和 mainlink 把 store 当参数是同一个规矩。
 *
 *   **抽完就把线收回来，这是这条闸的用法。** 抽出去腾的地方如果留着不收，下一次新增就
 *   直接填进去，等于白抽。所以规矩是：抬线要写清买到了什么，收线不用——收线永远是对的。
 *
 * 搬迁的附带收益（两次都一样，值得记）：原本靠「从 main.js 抠函数文本再 new Function」
 * 跑的测试可以改成直接 import 产品代码。抠源码验得到行为，验不到「这个函数在真实调用链上
 * 还在不在」——而本仓库真出过「实现写好了、零调用点」。这次改了三组、五处。
 * · 83_400（2026-08-25 第三次，仍在往下）：实测 83,3xx。抽出 `src/agent/paths.js`
 *   （路径规范化与比较，六个函数被引用近 250 次）。这一块比前两块难，两个教训值得记：
 *
 *   **判据要真的过一遍，不能看着像纯的就搬。** `pathIdentity` 读 `_remote` 全局、
 *   `coherentFilePath` 读编辑器打开的文件表——第一次搬进去两个都带着自由变量。
 *   前者改成从参数传（main.js 侧留薄壳），后者**退回 main.js**：模块里只放
 *  「给它字符串就能算出答案」的东西。
 *
 *   **而那条"没有未声明标识符"的守卫当时没抓到**，因为它的文件名单是手抄的、
 *   不含 src/agent/——每抽出去一个模块就逃出守卫一次。已改成自动发现该目录，
 *   加一行名单救不了下一个模块。
 *
 * · 82_250（2026-08-31，抬 70 行）：实测 82,244 行。买到的是**多标签页 AI 会话的八处
 *   跨会话串台修复**——用户报「持续性不行、容易中断、卡顿」，逐条钉住的是：后台标签
 *   的容器离开 document 导致收尾清理整段跳过（跑完的回合长得像断了）、发送键打开点
 *   没判 session（前台空闲标签按钮变「停止」且点了没反应）、跟随滚动 22 个调用点漏传
 *   归属（后台每 90ms 把前台拽到底）、代码上色的闸门查的是"任何会话"、清洗与分段的
 *   记忆化是单槽（两标签交替 flush 命中率归零）、本轮模式与 steer 配置取的是前台全局、
 *   并发命令超限时编一条假的执行失败喂给模型。
 *
 *   **新增的 97 行里 69 行是注释**，而且已经压过一轮。剩下的是判据本身（几个
 *   `sess === _currentSession()` 和一个等位队列），全部长在 DOM 绑定的函数体内——
 *   `_setStreaming` / `_chatFollow` / `sendPrompt` / `highlightCode` 一个都不满足
 *   「只依赖参数、没有 DOM、没有模块级可变状态」，搬不进 src/agent/。
 *
 *   为什么注释值这个位置：这八条没有一条能从代码本身看出来——它们全是「这个判据写成
 *   全局，症状出现在另一个标签页上」。不写清楚，下一个人会照着"看起来更简单"的写法
 *   改回去，而测试红了他也不知道为什么。
 * · 82_270（2026-08-31，抬 20 行，**这一笔不是本会话的**）：实测 82,263 行。多出来的 14 行
 *   来自 e1c4bd3「同一个分组里两行同名时，点哪一行都发去了靠前的那条线路」——那是另一
 *   条会话落的账单正确性修复（把被点中那行的 connId 一路传下去，否则用户点便宜那行、
 *   账单按贵的线路出）。它落的时候没跟着抬线，也没人看见红；我在核对「本会话有没有把
 *   别人的提交碾掉」时把它整笔恢复回来，顺手补上这条记录。
 * · 82_380（2026-08-31，抬 110 行）：实测 82,377 行。买到的是**终端里选中的输出可以拖进
 *   输入框**（用户点名要的，和编辑器选区那条对齐）。纯逻辑已经抽走了——命中判定、片标签、
 *   发送时展开的正文全在 src/agent/term-drag.js（有真跑的测试）。留在 main.js 的是
 *   `_wireTermDragToComposer`：mousedown/mousemove/mouseup 三个监听、拖影的 DOM、
 *   xterm 实例和 .xterm-screen 的 getBoundingClientRect——判据里那三条（依赖参数 / 没有
 *   DOM / 没有模块级可变状态）一条都不满足，搬不动；快照仓库 _termPicked 同理，它和
 *   _previewPicked 是同一种东西，放在一起才看得出这两条路子是一套。
 * · 82_420（2026-08-31，抬 40 行）：实测 82,415 行。买到的是**拖选区的时候编辑器不再自己
 *   滚**（用户实拍：往输入框拖，代码一下滑到最底或最顶）。真凶在 Monaco 的 mouseHandler：
 *   指针一离开内容区就启动 DragScrolling，边滚边把选区朝指针方向拉长。摁住后果的那一段
 *   （冻结滚动 + 松手时还原选区）全在 _wireSelectionDragToComposer 的闭包里，读的是
 *   monacoEditor 实例和 getBoundingClientRect，判据三条一条都不满足，搬不进 src/agent/。
 *   行为由 test/selection-drag.test.mjs 里那个假编辑器**真跑**出来，四条变异验过。
 * · 82_440（2026-08-31，抬 20 行）：实测 82,437 行。买到的是**输入框内容一多就卡顿**那条
 *   的修复：_ceSerialize 原本 `out += …` 配 `out.endsWith("\n")`，每遇到一个块级元素就把
 *   正在生长的绳索字符串摊平一次——二次复杂度。在真浏览器里量的每次按键耗时：
 *   500 行 14ms / 1000 行 31ms / 2000 行 181ms / 3000 行 528ms，改完是 4/4.6/10.7/12ms。
 *   多出来的 20 行几乎全是那段注释（把三档实测数字钉在代码旁边，免得有人"顺手简化"回去）；
 *   函数体本身只多了一个 push 辅助和一个 last 变量。它读 DOM，搬不进 src/agent/。
 * · 82_460（2026-08-31，抬 20 行）：实测 82,458 行。买到的是**把长对话那道优化放回 mac**：
 *   content-visibility: auto（跳过视口外消息的布局与绘制）此前按「是不是 WebKit」一刀切地
 *   关掉，而 macOS 上这个应用只能跑 WKWebView——app.css 自己写着它是「长对话跑着跑着就卡
 *   的根因」的解药，而 mac 用户从来没拿到过。判据换成能力探测（和 content-visibility 直接
 *   相关的那个 API，Safari 17.4 才有，那批渲染缺陷正是 17.x 修掉的），老引擎行为不变。
 *   多出来的 20 行是那段判据的来龙去脉 + 一个可直接跑的小函数（_engineRenderClasses，
 *   它就是为了让这道判据能被测试真跑而拆出来的）。
 * · 82_500（2026-09-01，抬 40 行）：实测 82,493 行。买到的是**「明明做完了还一直在运行中」
 *   那条彻底封掉**——用户原话「你修复十几次了都没修复好」。三条收尾路径（智能体循环 /
 *   纯对话 / 生图）形状一样：finally 里排着一串裸语句，然后才轮到 _setStreaming(x, false)。
 *   finally 保证「进入」不保证「跑完」，任意一句抛出，停止按钮和实时计时器就一起卡死，
 *   而且一个字都不报。纯对话那条尤其致命——夹在中间的是两个网络往返（等计费落定、
 *   向网关取结算），网关抖一下就 reject。之前那次「计时器自停」的修复读的是
 *   session.streaming，而它正是被跳过的那一行置回的，等于依赖着自己要绕开的东西。
 *   这次三条全部把记账包进 try，另给智能体那条加了第二道判据 run._loopExitedAt
 *   （finally 头两句之一，前面没有任何可抛的东西）。多出来的行几乎全是这段来龙去脉 +
 *   三处 try 的缩进；判据本身是 AST 扫描的测试，不是注释。
 * · 82_720（2026-09-01，抬 220 行）：实测 82,713 行。买到的是**「自定义软件皮肤」这个功能**：
 *   用户传一张图铺在整个 IDE 后面，外框按浓度半透让它透出来，代码区始终实底。
 *   能搬的已经搬了 —— 校验、夹取、以及"图层浓度"和"面板保留多少不透明度"那两条算式
 *   都在 src/agent/app-skin.js（纯函数，测试真跑，含 62% 的可读性下限）。
 *   留在 main.js 的 213 行是搬不动的那部分：设置页那一节的 DOM 构造（预览块、上传、
 *   浓度滑块、拖动时实时预览而松手才落盘）、canvas 缩放编码、以及把结果挂到根元素上。
 *   判据就是这条测试自己写的那个 ——「只依赖参数、没有 DOM、没有模块级可变状态」。
 * · 82_740（2026-09-01，抬 20 行）：实测 82,725 行。买到的是 `/` 命令弹窗**贴着输入条对齐**：
 *   左缘、宽度、上沿三个值改成同源地按 .composer__box 算（原来按文本区算、还封在 380px，
 *   于是它比下面那条窄一截）。多出来的行是那段说明加两行取值。同一笔里还把弹层底色从
 *   --panel-solid 换成 --popover-surface —— 那部分在 CSS 和主题桥里，不占 main.js。
 * · 82_820（2026-09-01，抬 80 行）：实测 82,803 行。买到的是自定义模型弹窗的**拉取模型**：
 *   「模型名称」从要用户手打改成从端点拉一份列表点着选，字段也从最上面挪到地址/密钥之后
 *   （顺序即前提：拉取要先有那两样）。同一笔里删掉了会员徽章和协议地址说明。
 *   能搬的搬了 —— 拼地址、拼鉴权头、解析各家返回形状（三个函数）都在
 *   src/agent/wire-protocol.js，测试真跑。留在 main.js 的是 DOM 那半边：胶囊列表的
 *   增删、选中态回写输入框、走 Rust http_request 发请求（浏览器直连第三方端点撞 CORS，
 *   本机 Ollama 在 WKWebView 里连协议都不允许）。
 * · 82_880（2026-09-01，抬 60 行）：实测 82,854 行。买到的是**把两处披露搬走而不是删掉**：
 *   用户要求删掉弹窗顶部那段说明和协议下面的缺口清单。两样都不能直接删 —— 前者是
 *   「走自己的端点会弱一些」（它已经从 toast 搬进弹窗一次了，再删就真成了悄悄变弱），
 *   后者是「这个协议不支持什么」。所以：前者搬进自定义模型的悬浮卡（按模型、选用之前
 *   就看得到、不占表单），后者收进默认折叠的 <details>（合上时只有一行字）。
 *   多出来的行是这两段来龙去脉 + 悬浮卡那一格的分流。同一笔里还给模型选择器的自定义
 *   分组标题加了直达管理的齿轮（用户问「以后怎么找到编辑/删除」）。
 * · 82_920（2026-09-01，抬 40 行）：实测 82,882 行。买到的是「实时跟随」那个开关**真的
 *   管住了它该管的东西**，以及开着时不再抢用户的光标和标签。开关原来只管住 _stageForTool
 *   一条路，而编辑器里的流式写入预览是另一条：它自己读盘、建模型、开标签、activate() 切走
 *   当前标签，全程没看过开关。判据抽进 src/agent/live-follow.js（纯函数，测试真跑）：
 *   关掉什么都不做、光标永远不动、人在打字时不抢标签也不滚视口。留在 main.js 的是
 *   _followOk 那个取上下文的壳（要问 Monaco 的 hasTextFocus）和八个接入点。
 * · 82_990（2026-09-01，抬 70 行）：实测 82,948 行。买到的是**自定义模型也能跑完整的
 *   智能体和工具**。原来那条路是客户端直连用户填的第三方地址，而完整系统提示词和 142 个
 *   工具描述由网关在服务端注入（`prompts::assemble_into`）、长上下文压缩也在网关侧 ——
 *   直连全都拿不到，所以自定义模型的智能体一直弱一截。
 *   改法不是把提示词发给客户端（那等于把产品 IP 放进每个人的机器），而是让**远程**自定义
 *   端点的请求走一趟网关：网关照常装配，再转发到用户填的地址、用用户自己的密钥，计费置零。
 *   本机端点（localhost）维持直连 —— 网关转发到 localhost 打的是服务器自己的 localhost，
 *   这是结构性的，不是待办。
 *   留在 main.js 的是选路判据 `_byoViaGateway`、覆写那一支、两道闸的让开、以及三处文案
 *   （「密钥仅保存在本机」对远程端点不再成立，不改就是骗人）。SSRF 校验、合成线路、
 *   钉 IP 的连接全在 server/src/byo_upstream.rs（11 条 Rust 测试）。
 * · 82_996（2026-09-01，抬 6 行）：实测 82,996 行。买到的是**开场消息折叠的幂等标记**。
 *   那道折叠原本永不收敛：替换文案自己含「项目上下文」四个字，判据折完仍为真；抽保留块时
 *   最后一段又会切到 `_head.length`，把上一轮那句文案吞成"要保留的内容"，于是开场消息
 *   每轮被就地重写、每轮长 66 个字。它是系统消息之后的第一条，一变就让 OpenAI/xAI 的
 *   严格前缀缓存从第 1 条起全部作废 —— 线上表现是"缓存量恒定、不随请求增长"
 *   （56k→24k / 105k→42k / 165k→36k）。五行注释解释的就是这个非局部后果。
 *   守卫在 test/opener-fold-idempotent.test.mjs：按 AST 取真源码跑，两条变异都测红。
 * · 83_002（2026-09-01，抬 6 行）：实测 83,002 行。同一类病的第二处 —— 读取去重的桩
 *   每轮被重刷。桩文本里带着「覆盖它的那次读取的行号段」，每来一次范围更大的覆盖读取
 *   行号就变；原来只有 `content.length > 90` 这条长度启发式挡着，而桩自己的长度取决于
 *   路径长短，monorepo 的深路径打出来正好 100 字 > 90，闸形同虚设。实测同一文件读四次，
 *   最早那条消息四轮里三轮内容不同，而它躺在历史很靠前的位置。
 *   改成显式的 `prevMeta?.contextAvailable !== false`。守卫在
 *   test/read-stub-idempotent.test.mjs：把长度闸放到 0 它仍绿，说明幂等判据独立顶住。
 * · 83_023（2026-09-02，抬几行）：回复正文里的文件路径变成可点击链接。markdown.js 标
 *   .md-filelink + data-filepath，main.js 的 chatEl 点击委托里 _resolveRel + openFile 打开。
 *   守卫 test/markdown-media.test.mjs：路径识别 + 标识符/口令/命令不误判。
 * · 83_078（2026-09-02）：回复里的文件路径点开时按 basename 在项目里找一遍（模型常
 *   只写 basename 或漏子目录，`openai_adapter.py` 其实在 cursor_proxy/ 下）。_fileExistsOnDisk
 *   + _findFileInProjectByName，有扫描上界。
 * · 83_007（2026-09-02，抬 4 行）：实测    83006 行。买到的是**修掉模型悬浮卡一渲染就崩**。
 *   自定义端点那段披露搬过两次家、CSS 也删过一次，落点元素 `.mic-note` 忘了加进
 *   showModelInfoCard 的 innerHTML 模板；`querySelector(".mic-note")` 回 null，三个分支
 *   每一个都是 `null.remove()`/`null.textContent=`，hover 任意模型名就 TypeError。
 *   补上模板元素（4 行含注释）。守卫在 test/model-info-card-elements.test.mjs：函数里每个
 *   querySelector(".X") 的目标，模板都必须真的建了那个元素——挡的是整整一类 bug。
 * · 83_009（2026-09-02，抬 2 行）：实测 83,007 行。买到的是**被截断的工具结果能被取回来**。
 *   投递层原本只做到「知道」（首尾预览 + 「原始结果共 N 字」），收尾却是「换更窄的查询
 *   重取」——而 run_cmd 这类**不可重取**的工具（重跑命令有副作用，刻意排除在 _REFETCHABLE
 *   之外）上那句是空话：模型只能对着缺一大块的内容往下猜，或者再跑一遍命令，而后者正是
 *   长任务里 run_cmd 每任务 10.5 次那个循环的燃料。现在超阈值的结果落进用户本机的临时
 *   目录，正文给出**绝对路径**，模型用 read_file(offset/limit) 取回任意一段。
 *   **实质逻辑全在 src/agent/tool-output.js**（makeOverflowSink，纯同步、可真往返测试）；
 *   main.js 这 2 行是搬不走的接线：收集器构造（目录启动时解析一次）+ 投递层调用点。
 *   import 并进了已有的两行，净增 0。守卫在 test/tool-output.test.mjs：6 条真往返，
 *   含「写不出去就不许承诺路径」和「喂的必须是 rawMessage 而不是裁剪后的 message」。
 */
/* 2026-09-02 · 83_871 → 83_827 · 实测 83_826 行 · 这一笔是**往下**扳的
 *   harness 注入向 Claude Code 形状收敛：25 个注入点 → 18 个，20 类 → 15 类。
 *   删掉的都先搬了家（工具描述 / 工具结果 /〔执行状态〕块），每一条都有变异测试守着
 *   「真的搬过去了」而不是「删干净了」。搬出去的新模块：src/agent/spin-target.js。
 *   往下扳是为了把这次腾出来的地方锁住——不然下一次新增会悄悄把它吃回去。
 */
/* 2026-09-02 · 83_827 → 83_833 · 实测 83_832 行 · 还 greenfield 判定那笔债
 *   +6 行：fromZeroUiProject 多认一条腿（architectureMode === "design_new"）。
 *   这笔债在 server/src/prompts.rs 的字节闸注释里被点名三次没还，因为一直往提示词那边
 *   找解法；缺口其实在客户端这一行——原判据只认 projectState，而它说的是工作区长什么样，
 *   于是"仓库已有后端、现在建第一个网站"被判成 existing，scaffold 那层一次都不加载。
 *   守卫在 test/logic.test.mjs（三条腿逐个变异都要变红）。
 */
/* 2026-09-02 · 83_835 → 83_857 · 实测 83_856 行 · 两条真缺陷的修复
 *   ① chat 模式下 ask_user 必崩：那条路是 `_executeToolStep(step, call, _agentRoot)`——
 *      只传三个参，run 是 undefined，而 `run._lastToolWasAsk` 是裸解引用。chat 侧那个
 *      p.then(...) 没有 .catch，所以表现不是报错，是**卡片永远停在「执行中」**。
 *      上一次修这个坑只改对了三行里的一行，所以这次把「为什么这条路 run 是 undefined」
 *      写进注释。守卫 test/ask-user-card.test.mjs 按 AST 全查该分支里的裸解引用。
 *   ② 纯正文被上游按输出上限砍断（finish_reason=length 且本轮零工具调用）时，整轮落进
 *      「模型自己决定收尾」：无错误、无重试、无标记，收尾还记成 success——用户报的
 *      「没回答完内容会结束」。正文照常保留，另记 output_truncated 让收尾不撒谎。
 *   注：上一笔 83_833 → 83_835 没有留记录（不是这条会话改的）；这里如实记下，
 *      免得下一个人以为 833→857 全是这一笔的。
 */
const MAIN_JS_MAX_LINES = 83_968;
/* ↑ 83_939 → 83_961 · 实测 83_960 行 · 第十、十一条
 *   ⑩ _lintCommand 的调用点漏传 root：模块里 _relativeTo 那段专门防「传进来是绝对路径」，
 *      而阻断门喂的就是 _resolvedPath。go vet 吃包模式，`./` + 绝对路径 = `.//Users/…`，
 *      go 直接 lstat 失败 —— 整条项目 linter 腿在所有 Go 仓库上恒不可用，而且失败长得像
 *      「跑了、没问题」。少传一个参数，那段防护代码就是在空转。（+4 行说明）
 *   ⑪ 验证命令白名单认不出真实项目跑的那条：实测 `npm run test:unit` / `make check` /
 *      `python -m pytest` / `mix test` / `swift test` / `pnpm -F web test` 全部落空，
 *      而 run_cmd 的描述里白纸黑字写着「跑项目真实的检查就拿到验证学分」。
 *      顺带堵掉一个反向的洞：watch 模式（`npm run test:watch`、`vitest --watch`）
 *      原来被当成一次性检查 —— 它们跑起来就不停，那个作为结论的退出码永远不会来。
 */
/* ↑ 83_932 → 83_939 · 实测 83_938 行 · 第九条：诊断门漏掉 json/css/scss/less/html
 *   Monaco **自带**这三个 worker（文件顶部就 import 着，MonacoEnvironment 里接着），
 *   装都不用装、免费就能查，却一直不在 _LINTABLE_EXT 里。于是模型写坏一个
 *   package.json / tsconfig.json（整个项目当场跑不起来）、写出不闭合的 CSS，
 *   诊断门一个字都不说 —— 而这几种恰恰是「坏了整个项目就起不来」的那一类。
 */
/* ↑ 83_921 → 83_932 · 实测 83_931 行 · 第八条：无人值守时 ask_user 挂死整个调度器
 *   那个等待 promise 只有「用户点按钮」一个出口。定时任务（_unattendedRun）跑到这里
 *   永远不 resolve —— 调度器挂在这一格，界面上没有任何东西、日志里也没有。
 *   权限弹框那一层早就有同源出口，ask_user 这条一直没接上。+16 行（出口 + 措辞说明：
 *   要说「没人能点」不是「用户拒绝」，后者会让模型转头去找绕过确认的路）。
 *   顺带：_joinReasoningDelta 整段搬进 src/agent/reasoning-join.js，那边净减了 20 行。
 */
/* ↑ 83_895 → 83_921 · 实测 83_920 行 · 第六、七条：两处工具描述和行为对不上
 *   ⑥ list_dir 的 schema 写着「0 = recurse all the way down」，而 `Number(0) || 1`
 *      把 0 变成 1（只列当前层）。模型按描述传 0，拿回一层目录，看不出任何异常，
 *      只会以为这个目录就这么点东西。（真正的递归开关是**负数**，schema 里没写。）
 *   ⑦ search 静默跳过 >2 MiB 的文件 —— 本仓库自己的 src/main.js 就是 4.9 MB，
 *      在这个项目里搜任何东西主文件永远搜不到，而且返回的结果和「里面确实没有」
 *      一模一样。跳过是对的，但跳过了就得说：后端记 size_skipped，
 *      前端两条包装摊出来，回执里点名（和已有的 truncated 同一条路子）。
 */
/* ↑ 83_884 → 83_895 · 实测 83_894 行 · 第五条：危险操作确认被提问预算拦掉（安全缺陷）
 *   confirm_text 那一支不是「收集信息」，是动手之前的安全闸（删库 / force push /
 *   批量覆盖）。而提问预算（本轮第 3 次、连着问两次）和跨轮去重原来一视同仁地拦它，
 *   拦下之后返回的话是「下一步：**按最合理的方案直接做下去**」——
 *   模型问「真的要删吗」，系统答「删吧」，用户一个字都没看到。
 *   两道门各加一条豁免（+11 行，绝大部分是说明为什么这两类不是同一件事）。
 */
/* ↑ 83_873 → 83_884 · 实测 83_883 行 · 第四条真缺陷：空转断路器在 plan 模式下结构性哑掉
 *   `else if (run.mode === "agent") _idleIters++` —— 非 agent 模式下计数器恒为 0，
 *   而这条 break 是循环里**唯一一条 harness 主动叫停的路**（其余 break 要么是用户按停、
 *   要么是模型自己不再调工具）。默认没设 token 预算时，plan 模式重复读同一批文件可以
 *   一直转下去，每转一圈一次完整的付费调用，只能等用户按停止。
 *   钉住它的理由（「规划本来就不产出」）只解释了 implOps 那一项，而这道闸用的
 *   `_progress.total(n)` 里含 novelEvidenceCount —— 那恰恰是规划模式唯一的产出，
 *   一个真在取证的 plan run 结构上不可能被误杀。+11 行全是这段说明。
 */
/* ↑ 83_857 → 83_873 · 实测 83_872 行 · 第三条真缺陷
 *   turn.error / 按停 两条早退路整本遍历写入账本，而账本是整个 run 累积、从不清空的：
 *   只要之前任何一轮写成功过，这两条路每走一次就白加一次 _implOps。模型轮撞上一次
 *   **可重试**的线路抖动时这一轮结构上零写入（byIndex 空、流式即写没触发），却照样 +1，
 *   于是 _verifiedAtImplOps 与执行证据的 implementationVersion 全部错位、真绿的验证被判废，
 *   一次跑过测试的干净交付被记成 partial 并传给下一轮当「上次没做完」。
 *   改成按本轮水位线 _ledgerAtTurnStart 切片（+16 行注释，代码本身是等量替换）。
 *   顺带：那条水位线在别的会话删掉「插话作废这批工具」之后变成了死变量，这一改把它接活。
 */

test("main.js 不许再长胖——要加东西先腾地方", () => {
  const src = readFileSync(join(ROOT, "src/main.js"), "utf8");
  const lines = src.split("\n").length;
  assert.ok(
    lines <= MAIN_JS_MAX_LINES,
    `main.js 现在 ${lines} 行，超过上限 ${MAIN_JS_MAX_LINES}（超出 ${lines - MAIN_JS_MAX_LINES} 行）。\n`
      + "先看这次新增的东西能不能搬进 src/agent/ 的模块——判据是「只依赖参数、没有 DOM、\n"
      + "没有模块级可变状态」。确实搬不动才抬这条线，并在测试文件顶部按格式补一条抬线记录\n"
      + "（日期 / 新值 / 实测 / 这一笔买到了什么）。直接改数字不写理由的，下一个人无从判断。",
  );
});

/**
 * 闸不能只挡 main.js，否则会被"搬进另一个大文件"绕过去。
 *
 * 抽出去的模块要真的是**模块**：一个文件一件事。所以给 src/agent/ 下每个文件也设一条
 * 松得多的线——它挡的不是增长，是「把 main.js 的问题原样搬到隔壁」。
 */
const MODULE_MAX_LINES = 1_200;

test("抽出去的模块本身也不许长成第二个 main.js", () => {
  const dir = join(ROOT, "src/agent");
  const oversized = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const n = readFileSync(full, "utf8").split("\n").length;
    if (n > MODULE_MAX_LINES) oversized.push(`${name}: ${n} 行`);
  }
  assert.deepEqual(
    oversized,
    [],
    `src/agent/ 下这些文件超过 ${MODULE_MAX_LINES} 行：\n  ${oversized.join("\n  ")}\n`
      + "拆成更小的模块，别把 main.js 的问题原样搬到隔壁。",
  );
});

/**
 * 这条闸本身要有效——数字得贴着现实，不能松到永远撞不上。
 *
 * 一条设在两倍现值的上限等于没有：它永远绿，而文件照样翻倍。所以反过来钉一条：
 * 上限不许比实际大太多。这条红了说明有人抬线抬过头了，或者刚做完一次大清理
 * 忘了把线收回来（那种情况把线收到新的实测值附近即可）。
 */
test("尺寸闸贴着现实，不是一条永远撞不上的线", () => {
  const lines = readFileSync(join(ROOT, "src/main.js"), "utf8").split("\n").length;
  const slack = MAIN_JS_MAX_LINES - lines;
  assert.ok(
    slack <= 3_000,
    `上限比实际大 ${slack} 行，这条闸基本不起作用了。`
      + `把 MAIN_JS_MAX_LINES 收到 ${lines + 500} 附近——闸的价值在于"下一次新增就会撞上"。`,
  );
});

/**
 * 抽出去的模块不许搬回 main.js。
 *
 * 上面那条闸的用法是「撞线就抽模块」。抽完之后没有任何东西盯着它别回流 —— 而本仓库
 * 几乎所有源码断言用的是 helpers/source.mjs 的 SRC（main.js + src/agent/* 拼接），
 * 代码搬回 main.js 一样全绿，尺寸闸要等到下一次撞线才会哭。
 *
 * 判据从**两端**取，两端都是产品代码，没有一端是这个测试自己编的形状：
 *   · 模块那一端：直接 import() 真模块，问它导没导出这些名字（不抠源码文本）；
 *   · main.js 那一端：acorn 解析 src/main.js **本身**（不是拼接后的 SRC），
 *     要求这些名字只以 ImportSpecifier 出现、没有同名顶层声明。
 * 全程走 AST，不切字符串窗口，也不做正文正则匹配 —— 所以既不需要先剥注释
 * （注释里提名字不产生 FunctionDeclaration），也不会因为函数变长而失效。
 * 顶层声明数另有一条下限断言兜着，避免解析坏掉时整条变成恒真。
 */
const EXTRACTED_TO_AGENT = {
  "delivery-scan.js": [
    "_removedDeclarationsUnchecked", "_sinkRiskAdvice", "_stubDeliveryFindings",
    "_staleCommentFindings", "_hardcodedDeliveryFindings", "_touchedExportedDecls",
  ],
  // _importRegistryUrl 故意不列：它没有块外调用点，留作模块私有。
  "dep-manifest.js": [
    "_manifestDepAdditions", "_undeclaredImportAdditions", "_declaredDepsFromFileMap",
  ],
  "ai-errors.js": [
    "_stripAiRetryPrefix", "_aiFailureKind", "_isProviderGatewayStatusError",
    "_isRateLimitedAiError", "_isRetryableAiError", "_isCompressionPrefixInvalidError",
    "_isStalledAiError", "_modelEventHasProgress", "_streamResumeMode",
  ],
};

test("腾出来的三族必须住在 src/agent/，不许搬回 main.js", async () => {
  const problems = [];

  for (const [file, names] of Object.entries(EXTRACTED_TO_AGENT)) {
    let mod = null;
    try {
      mod = await import(new URL(`../src/agent/${file}`, import.meta.url).href);
    } catch (e) {
      problems.push(`src/agent/${file} 导不进来：${String(e.message).split("\n")[0]}`);
      continue;
    }
    for (const n of names) {
      if (typeof mod[n] === "undefined") problems.push(`src/agent/${file} 没有导出 ${n}`);
    }
  }

  const mainSrc = readFileSync(join(ROOT, "src/main.js"), "utf8");
  const ast = acorn.parse(mainSrc, {
    ecmaVersion: "latest", sourceType: "module",
    allowAwaitOutsideFunction: true, allowHashBang: true,
  });
  const declaredAtTop = new Set();
  const importedFrom = new Map();
  for (const stmt of ast.body) {
    if (stmt.type === "ImportDeclaration") {
      for (const s of stmt.specifiers) {
        if (s.type === "ImportSpecifier") importedFrom.set(s.local.name, String(stmt.source.value));
      }
      continue;
    }
    const node = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!node) continue;
    if (node.type === "FunctionDeclaration" && node.id) declaredAtTop.add(node.id.name);
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id?.type === "Identifier") declaredAtTop.add(d.id.name);
      }
    }
  }
  // 反恒真：解析坏了就直接说，别让上面两个集合空着把判据喂绿。（实测 3141 / 115）
  assert.ok(declaredAtTop.size > 500,
    `main.js 只解析出 ${declaredAtTop.size} 个顶层声明——AST 那一端坏了，这条等于没跑`);
  assert.ok(importedFrom.size > 50,
    `main.js 只解析出 ${importedFrom.size} 个具名 import——AST 那一端坏了，这条等于没跑`);

  for (const [file, names] of Object.entries(EXTRACTED_TO_AGENT)) {
    for (const n of names) {
      if (declaredAtTop.has(n)) problems.push(`${n} 仍然声明在 src/main.js 顶层`);
      const from = importedFrom.get(n);
      if (from === undefined) problems.push(`${n} 没有从任何模块 import 进 main.js`);
      else if (!from.endsWith(`/agent/${file}`)) {
        problems.push(`${n} 是从 ${from} import 的，应为 ./agent/${file}`);
      }
    }
  }

  assert.deepEqual(problems, [],
    "src/main.js 的尺寸闸靠「抽模块」腾地方，抽完没人盯着它别搬回来"
    + "（源码断言用的是 helpers/source.mjs 拼接后的 SRC，搬回 main.js 一样全绿）：\n  "
    + problems.join("\n  "));
});

/**
 * 测试的**跑法**本身也要被守着。
 *
 * 上一版 CI 里那一步写的是 `node --test test/*.test.mjs`。mac/Linux 上它能跑，靠的是
 * shell 先把通配符展开成 106 个文件名；而 Windows runner 的默认外壳是 pwsh，
 * pwsh 给原生程序传参**不做通配符展开**，加上仓库钉的 node 20 的 `--test` 不认通配符
 * （自带 glob 是 node 21 才加的）—— 结果是 `Could not find '…/test/*.test.mjs'`、exit 1，
 * **一条测试都没跑**。再配上当时那个 continue-on-error，它显示成「带警告的通过」：
 * 所有人以为 Windows 上跑了 2749 条，实际是 0 条。**一个坏掉的门禁比没有门禁更糟。**
 *
 * 所以这条钉三件事：跑法没被改回通配符、收集判据还在、下限哨兵还在。
 */
test("测试的跑法必须是跨平台的，且收集不到文件时要报错而不是「全绿」", () => {
  const runner = readFileSync(join(ROOT, "scripts/run-tests.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs",
    "npm test 改回通配符了 —— Windows 上 cmd.exe 不展开它，会一条测试都不跑");

  // 收集判据：必须在 JS 里自己列文件，不能依赖 shell 或 node 的 glob。
  assert.match(runner, /readdirSync\(/,
    "不再自己列文件了 —— 依赖 shell/node 展开通配符的写法在 Windows 上收集不到任何文件");
  assert.match(runner, /endsWith\("\.test\.mjs"\)/,
    "收集判据变了；注意别改成整个 test/ 目录 —— 那会把 helpers 和 e2e 脚本也当测试跑");

  // 下限哨兵：收集不到 = 报错，而不是「跑了 0 个、全部通过」。
  assert.match(runner, /files\.length === 0/, "收集到 0 个文件时没有报错 —— 那会显示成全绿");
  assert.match(runner, /files\.length < \d+/, "没有下限哨兵 —— 判据被改坏时会静默少跑一大片");

  // 真跑一遍收集逻辑，确认它现在确实能收到全部文件。
  const files = readdirSync(join(ROOT, "test"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.mjs"));
  assert.ok(files.length >= 100,
    `只收集到 ${files.length} 个测试文件 —— 这条断言本身在守一个空窗口`);
});

/**
 * 「自定义模型」弹窗的样式必须走令牌，不许写死颜色。
 *
 * 这个弹窗以前自带一整块运行时注入的 CSS，颜色全是 Google Material 的字面量
 * （#fff / #1a73e8 / #202124 / #5f6368…），**一条 [data-theme="dark"] 覆盖都没有** ——
 * 于是暗色主题下整个弹窗仍然是白底黑字，和 IDE 其余部分不是一套语言。
 *
 * 判据是「剥掉注释之后还有没有颜色字面量」：注释里会引用旧的硬编码值来解释历史
 * （"原来的 #1a73e8 on #e8f0fe 只有 3.93:1"），那是**说明**不是**样式**，
 * 拿原文直接 grep 会把自己的解释文字判成违规（本仓库踩过六次的那个坑）。
 *
 * 同时钉住两套 :root 都有那五个新令牌：CSS 变量少定义一套不会报错，
 * 只会让引用它的那条声明在该主题下**静默作废**。
 */
test("自定义模型弹窗的样式全部走令牌，且新令牌浅色暗色两套都在", () => {
  const css = readFileSync(join(ROOT, "src/styles/custom-models.css"), "utf8");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hard = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\(/g) || [];
  assert.deepEqual(hard, [],
    "样式里出现了硬编码颜色 —— 暗色主题下这些位置会变成白斑：\n  " + hard.join("\n  "));

  // 反恒真：剥完注释不能把整份文件也剥没了。
  assert.ok(code.split("{").length > 40,
    `剥注释后只剩 ${code.split("{").length - 1} 条规则 —— 判据在守一个空文件`);
  assert.match(code, /var\(--/, "一个令牌都没引用，这份样式没接进体系");

  // 运行时注入的那一整块必须已经删掉，否则等于两套样式并存、后者盖前者。
  const main = readFileSync(join(ROOT, "src/main.js"), "utf8");
  assert.ok(!main.includes("cm-style"),
    "main.js 里还留着运行时注入的 cm-style —— 它会盖掉走令牌的那份");
  assert.match(main, /import "\.\/styles\/custom-models\.css"/,
    "样式文件没被 import，弹窗会完全没有样式");

  // 五个新令牌：浅色和暗色两套都必须有。少一套 = 该主题下静默作废。
  const app = readFileSync(join(ROOT, "src/styles/app.css"), "utf8");
  const lines = app.split("\n");
  const blockAt = (startIdx) => {
    const end = lines.findIndex((l, i) => i > startIdx && l.trimEnd() === "}");
    return lines.slice(startIdx, end).join("\n");
  };
  const lightStart = lines.findIndex((l) => l.trim() === ":root {");
  const darkStart = lines.findIndex((l) => l.trim().startsWith(':root[data-theme="dark"]'));
  assert.ok(lightStart >= 0 && darkStart > lightStart, "找不到两套 :root —— 判据失效");
  const light = blockAt(lightStart);
  const dark = blockAt(darkStart);
  for (const tok of ["--scrim", "--accent-solid", "--accent-on", "--destructive", "--field-line"]) {
    assert.ok(light.includes(`${tok}:`), `${tok} 只在暗色里定义了，浅色下引用它的声明会静默作废`);
    assert.ok(dark.includes(`${tok}:`), `${tok} 只在浅色里定义了，暗色下引用它的声明会静默作废`);
  }
});
