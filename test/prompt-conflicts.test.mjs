// 同时到场、方向相反的指令。判据严格：必须是**同一次请求里会同时出现**的两处，
// 且**方向相反**（不是详略不同）。解法一律是删掉/改写其中一条、或合成一条带判据的，
// 不是再加一句「注意不要……」——那正是本仓库第一原则「修机制不是加劝诫」。
//
// 这批来自一次 20 智能体的排查 + 逐条对抗验证，22 条候选、11 条高危。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, SRC as RAW_SRC } from "./helpers/source.mjs";
import { readFileSync } from "node:fs";
const P = (n) => readFileSync(new URL(`../../server/prompts/${n}.txt`, import.meta.url), "utf8");

// ── 仪式与格式强制族（用户反复投诉的那段模板的直接来源）─────────────
test("小任务律不再无条件要求「验证/未验证」两段", () => {
  // 「完成后给结果和真实验证/未验证边界」是无条件的，而 answer_quality.txt:33 把
  // 「a rundown of what you checked」按**形状**禁掉、只有 FAILED check 才值一行。
  // 一边强制两段、一边按形状禁止，模型只能照强制的做——那正是投诉里的前两节。
  assert.match(SRC, /小任务律：直接用最短证据链完成；能一两个工具搞定就别升级成长流程。/,
    "尾巴又回来了");
  assert.doesNotMatch(SRC, /完成后给结果和真实验证\/未验证边界/, "无条件的验证两段又回来了");
});

test("不再强制把话拆成 bullet", () => {
  // answer_quality.txt:27「Turn two sentences into a bulleted list … do not」，
  // 而客户端两处风格块写着「要点用短 bullet，别用大段连续文字」。方向相反。
  assert.doesNotMatch(SRC, /结构化代替啰嗦/, "「用 bullet 别用连续文字」又回来了");
  assert.doesNotMatch(SRC, /正文用 Markdown 结构化/, "同上，第二处");
  assert.doesNotMatch(SRC, /能列表别长段/, "同上，第三处");
  // 留下的必须是**有判据**的版本，不是删干净
  assert.match(SRC, /只有条目\*\*真的平行\*\*时才用列表/, "删了却没留判据，模型会退回默认排版");
});

test("reviewer 的覆盖面说明挪到开头，不做仪式性收尾", () => {
  const r = P("reviewer");
  assert.doesNotMatch(r, /Finish with a one-line overview/,
    "又变回收尾行了——answer_quality.txt:33 里 a rundown of what you checked 就是这一行");
  assert.match(r, /Open with one line/, "挪走了却没给新位置");
  assert.match(r, /not in a closing summary/, "没说清为什么不能放结尾");
});

test("chat 模式结尾不再强制「给一两条下一步」", () => {
  assert.doesNotMatch(P("chat"), /finish by offering one or two things/,
    "一边 answer_quality 按形状禁止仪式结尾，一边 chat.txt 强制要求");
});

// ── 过度设计与范围蔓延族 ─────────────────────────────────────────
test("默认可维护不等于默认造扩展点", () => {
  // agent_engineering.txt:7「This is not a licence to build for imagined futures」，
  // 抽象层要等第三处真的需要时才抽；而可维护升级律写着默认就要「扩展点可替换」。
  const laws = SRC;
  assert.doesNotMatch(laws, /组件\/服务可复用、扩展点可替换/,
    "「默认就要可扩展」又回来了——单调用点的功能会被抽出接口 + 注册表 + 配置项");
  assert.match(laws, /可维护升级律/, "整条律被误删了——配置集中和禁止硬编码还要留");
  assert.match(laws, /禁止把业务规则、颜色、端口、密钥、路径和魔法值散落硬编码/,
    "该留的那半句丢了");
});

test("业务逻辑做扎实 ≠ 顺手多写三个功能", () => {
  // agent_engineering.txt:5「Commercial grade is a quality standard — it is not licence to
  // expand the feature scope」；而业务逻辑律写着「必须覆盖取消、退款、…审计记录」。
  assert.doesNotMatch(SRC, /必须覆盖取消、退款、重复提交、超时、并发、历史数据和审计记录/,
    "扩范围那句又回来了——用户只要下单接口，会顺手把取消/退款/审计一起写了");
  assert.match(SRC, /\*\*你这次要写的那条流程上\*\*的重复提交、超时、并发、幂等/,
    "收窄到本次流程的那句没了");
  assert.match(SRC, /取消、退款、历史数据迁移、审计记录是另外的功能面/,
    "没说清哪些属于别的功能面，模型无从划界");
});

test("「先写红测试」要有判据，不是无条件", () => {
  // agent_engineering.txt:22 写的是 reproduce **or** read the real error。
  assert.match(SRC, /\*\*项目已经有测试体系、而这个 bug 落在它覆盖得到的范围里时\*\*/,
    "又变回无条件了——没有测试体系的项目会被逼着为一个空值判断从零搭一套");
  assert.match(SRC, /reproduce \*\*or\*\* read/, "没说清另一条路同样算数");
  assert.match(SRC, /先看着它红，再动手修/, "有体系时的先红后绿被误删了");
});

// ── 想 vs 干 ────────────────────────────────────────────────────
test("催写文件要看计划落地了没有", () => {
  // 同一份上下文里有两条会打架的话：「计划落地前不写文件」和「别想太多，赶紧动手」。
  // 无条件催写文件时，需要计划的任务会被逼在没计划的情况下开写 —— 而计划门那边还会
  // 因为「从零建的第一次落盘没有计划」把这次写入硬拦回去，两头空转。
  //
  // 载体换了（2026-09-02）：循环里那条 emptyBuildAct 注入删掉了，它两支说的都搬进了
  // 常驻层 agent_core §3。**但冲突的解法必须跟着搬** —— 第一版削提示词时把
  // 「需要计划就同一轮里 update_plan + 落第一批文件」削没了，只剩「赶紧动手」，
  // 正是这条测试抓出来的。所以这里改成钉提示词那一侧。
  const c = P("agent_core");
  assert.match(c, /A warranted plan lands before the first file you write/,
    "「计划在第一个文件之前」这条没了 —— 会被逼着无计划开写");
  assert.match(c, /only update_plan is/, "「散文方案不算计划」没了，弱模型会用一屏字代替 update_plan");
  assert.match(c, /if the task needs a plan, call update_plan and land the first files in that same turn/,
    "两句话的**冲突解法**没了：只剩「赶紧动手」和「先有计划」各说各的，模型会卡在中间");
  // 反向：防「只思考不写代码」那条原意不能丢
  assert.match(c, /An empty workspace has nothing to discover: stop probing/,
    "催动手那句被整条删了 —— 空目录会被无休止地探测");
});

test("从零建系统类项目要先读真实实现，建应用则直接开工", () => {
  // reasoning.txt 是基座、无条件挂载，原来无条件说「不要去查有没有人做过」；
  // 而外部知识律要求从零写版本控制/编译器/数据库时第一份代码前先查。合成一条带判据的。
  const r = P("reasoning");
  assert.match(r, /application-shaped/, "没有区分应用型和系统型");
  // 钉判据本身，不钉措辞：这段为了塞进注意力预算被压过一次，
  // 「systems artifact whose…」缩成了「When the design trade-offs are…」，
  // 判据一个字没少而测试却红了。所以只钉那句判词和两个落地例子。
  assert.match(r, /design trade-offs are the work itself/,
    "系统型那一档的判据没了——没有判据的枚举恒等于默认值");
  assert.match(r, /compiler/, "没给具体例子，判据落不了地");
  assert.match(r, /database/, "没给具体例子，判据落不了地");
  // 反向：应用型仍然直接开工，不许退回「先比较一圈技术选型」
  assert.match(r, /pick the mainstream stack from what you already know and start building/,
    "把「直接开建」也删了——那会让每个待办应用都先做一轮选型调研");
});

// ── 执行前提族 ──────────────────────────────────────────────────
test("用户说「这轮只出计划」时也不催他去做第一步", () => {
  assert.match(SRC, /run\.engineering\?\.explicitReadOnly === true/,
    "agent 模式里明说只规划时仍被催着执行——agent_core.txt:6：A plan request ends at the plan");
});

test("命令根本不存在时，不许指示去改代码", () => {
  // agent_engineering.txt:32：a verifier that cannot run asserts nothing about the code。
  //
  // 载体换了（2026-09-02）：循环里那条 `_pushNudge("cmdFail", …)` 删掉了 —— 它是**同一句话
  // 的第二次投递**（paths 取自 it.rawResult.commandFailure，正是生成 `[失败诊断]` note 的
  // 同一个对象，而那条 note 在 run_cmd 失败时就已经拼进工具结果正文了）。
  // 这条断言守的**能力没变**，只是改成钉活着的那个载体：_commandFailureDiagnostics。
  // 那份实现比删掉的那条更强 —— 同样点明「环境问题，不是代码错误」，还多给四步取证链。
  assert.match(SRC, /command not found\|not recognized as an internal or external command/,
    "又不分「代码错了」和「命令没找到」了");
  assert.match(SRC, /命令\/可执行文件不存在（环境问题，不是代码错误）/,
    "认出来了却没说清它不是代码错误 —— 模型会去改一行都没被执行过的代码");
  assert.match(SRC, /先调 probe_env/,
    "命令不存在时没给确定性取证链，模型会连猜命令变体");
  // 反向：真报错时那条正确的指示不许丢
  assert.match(SRC, /不要只看 exit code；按上面真实输出和日志定位根因，修完再重跑验证/,
    "真失败时的正确指示被整条删了");
});

test("不许默默把用户要的东西换成自己认定的真问题", () => {
  // truthfulness.txt:18 要求说清问题所在、**然后照用户要的做**，并把默默替换叫
  // silently implementing something else；而 agent_core.txt:5 原来允许
  // 「solve the real problem and say why」。用户的选择权不能被一句推断夺走。
  const c = P("agent_core");
  assert.doesNotMatch(c, /solve the real problem and say why/,
    "又允许默默换掉用户要的东西了");
  assert.match(c, /then build what they asked for/, "没说清正确做法是「说明 + 照做」");
  // 同上：这句被压缩过，钉动作+判据，不钉整句。
  assert.match(c, /substituting[^.]{0,60}without saying so/,
    "没点名「不说一声就替换」这个动作本身");
});

// ── 死副本里那些「活版本确实缺」的规则，接回来了没有 ────────────────
//
// 8 个 .txt 在服务端躺着，客户端 _P() 查找键 100% 落空（接口只对 admin 且 ?full=1 返回正文，
// IDE 从不这么请求；生产 3495 次请求每次 body 恰好 54 字节，prompts 恒为空对象）。
// 于是永远回落到 main.js 的内联版——而那份**不是死副本的超集**，两边各有独家内容。
// 这里钉住的是「.txt 独有、活版本确实缺、且现在仍然正确」的那些，已经接进活版本。
const inlineOf = (name) => {
  const m = new RegExp("_P\\(\"" + name + "\",\\s*`([\\s\\S]*?)`\\)").exec(RAW_SRC);
  assert.ok(m, `${name} 的内联版定位不到了`);
  return m[1];
};

test("压缩摘要不再写死中文——它会替换掉真实历史成为之后每轮的上下文", () => {
  const t = inlineOf("compact");
  assert.doesNotMatch(t, /中文、分条/,
    "写死中文：一场英文对话被压缩后，历史里躺着一段中文，直接顶撞 agent_core 和五个模式提示词里"
    + "各写了一遍的「用与用户相同的语言，不要默认中文」");
  assert.match(t, /用这段对话本身的语言/, "改了却没给替代说法");
});

test("worker 人格补上它此前一条都没有的操作规则", () => {
  const t = inlineOf("worker_system");
  // worker 拿到的只有 _WORKER_SYSTEM + scope，拿不到主智能体的决策框，所以这些必须写在人格里
  assert.match(t, /Do not emit a huge file in one shot/, "死锁保护没了");
  assert.match(t, /never to one that already exists/,
    "少了那个关键区分——对已存在的文件「先写骨架」会把用户正在工作的代码截断成几十行");
  assert.match(t, /carry on from it rather than/, "没说要承接主智能体已有的上下文");
  assert.match(t, /watch for when integrating/, "交付里没有集成交接");
  assert.match(t, /comes back as \[BLOCKED\]/, "没说清越界写会怎样");
  assert.match(t, /run_cmd is not scope-limited/,
    "没堵住用命令绕过 scope——这是唯一一条能绕开作用域的路");
  assert.match(t, /belong to the main agent after every worker is done/,
    "没说跨模块接线和最终集成归谁");
});

test("subagent 人格补上能力边界与检索纪律", () => {
  const t = inlineOf("subagent_system");
  assert.match(t, /two independent pieces of evidence/, "关键结论只要一条证据就下了");
  assert.match(t, /Do not restate the task/, "没禁复述任务和开场白");
  // 2026-08-26：原来钉的是「you do not have the browser tool」。那句话写的时候是真的，
  // 后来 ROLE_CAPABILITIES_READ 给 frontend / design / test 三个只读角色配了 browser，
  // 它就变成假话了——工具在窗口里，提示词说没有，模型于是不用。
  assert.doesNotMatch(t, /you do not have (?:the )?`?browser/i,
    "角色矩阵已经给了三个只读角色 browser，这句话是假的");
  assert.match(t, /when your role brief carries it/,
    "得说清「按角色给」，否则拿到 browser 的角色也不会用它");
  assert.match(t, /Think, then look/, "缺了「先想清楚缺哪一块再检索」");
  assert.match(t, /Follow the thread/, "缺了「顺着 import/调用/定义逐层追」");
});

test("项目摸底子体拿到可执行的判据和输出模板", () => {
  const t = inlineOf("research_prompt");
  assert.match(t, /技术栈只认清单文件和真实代码/, "技术栈还可以靠猜");
  assert.match(t, /读全/, "关键文件可以只读开头几行");
  assert.match(t, /## 目录地图/, "没有固定输出模板，交付形状随机");
  assert.match(t, /## 常见改动入口/, "同上，六段模板不全");
  assert.match(t, /不要只列文件名/, "会交回一份文件名清单");
});

// ── 注释族 ─────────────────────────────────────────────────────────
//
// 2026-08-25：用户报「写代码不写注释」。直接原因不是模型的毛病，是我们自己下的指令——
// agent_engineering.txt:16 逐字写着 "Do not write comments by default."，而它是网关那
// 40 份提示词里**唯一**给注释下默认策略的地方，客户端没有兜底副本。
//
// 客户端唯一的反向压力（main.js 的 _missingWhyInWrite）是**一条注释的地板**：全文
// 有任意一条非空注释就永久静音。所以它拉不动默认值。
//
// 这一组守两件事：策略本身是「写为什么」，以及客户端那条工程律和网关这条**同向**。
// 两边同向很重要——自定义端点不走网关，那条路只有客户端这份。

test("网关的注释策略是「写为什么」，不是「默认别写」", () => {
  const e = P("agent_engineering");
  assert.doesNotMatch(e, /Do not write comments by default/,
    "「默认别写注释」回来了——用户报的就是这条的直接后果");
  assert.match(e, /Every non-trivial function, class, and module gets a short doc comment/,
    "文档注释的下限没了，回到「看心情写」");
  // 质量那半条必须留下：翻转默认值不等于要噪音注释。
  assert.match(e, /do not restate what the next line does/,
    "复述下一行的禁令被顺手删了——那会换来一堆噪音注释");
  assert.match(e, /heading-style/, "标题式注释的禁令被顺手删了");
  // 真正的漏洞是新文件：原文最后一句「密度跟随所在文件的既有风格」在新项目里没有落点，
  // 于是默认那半句赢。改法必须把这个洞点名堵上。
  assert.match(e, /In a new file there is no existing style to follow/,
    "新文件那个洞没堵——那正是「新项目一条注释都没有」的成因");
});

test("客户端那条工程律和网关同向（自定义端点只有客户端这份）", () => {
  assert.match(SRC, /可维护升级律：/, "整条律被删了");
  const law = /lines\.push\("可维护升级律：([^"]*)"\)/.exec(SRC);
  assert.ok(law, "可维护升级律的形状变了，这条断言失去落点");
  assert.match(law[1], /注释按「为什么」写/,
    "客户端这条一个字都没提注释——而自定义端点不走网关，那条路只有它");
  assert.match(law[1], /不要复述下一行在干什么/, "客户端这份少了质量那半条，会换来噪音注释");
  assert.match(law[1], /新文件没有既有风格可跟/, "客户端这份没堵新文件那个洞");
  // 反向：客户端不许出现「默认别写注释」这类和网关反向的措辞。
  assert.doesNotMatch(SRC, /默认不写注释|不要写注释/,
    "客户端出现了和网关反向的注释指令");
});

test("Ctrl-K 转写那条「不要注释」不受影响——它说的是别的事", () => {
  // edit_transform.txt:1 的 "no comments about changes" 指的是「别输出解释改动的话」，
  // 不是「别在代码里写注释」。它和上面这组不冲突，删掉反而会让转写结果带一堆说明文字。
  assert.match(P("edit_transform"), /no comments about changes/,
    "把 Ctrl-K 的「别输出改动说明」当成注释策略删掉了——那是两件事");
});
