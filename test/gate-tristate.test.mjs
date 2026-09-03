// 闸门的第三态：「裁决还没到」不等于「裁决说了不」。
//
// 2026-08-17 实测：完整意图裁决要 19.8 秒（生产网关 upstream_header_ms=19836），而第一个模型
// 回合往往在它之前就结束了。也就是说 run.engineering 为空是**常态**，不是边缘情况。
//
// 那天最贵的一个 bug 就长在这里：初始工具编排的闸门写的是 `!run.engineering?.applies`，
// 画像为空时为真 → 整轮工具编排不启动 → 128 个工具一个都进不来（没有 web_search、
// knowledge_search、git、db_query、browser）。用户的原话是「我让他干什么他什么都不知道」。
//
// 全量对账之后的结论值得写下来：**剩下的否决位全都倒向「少一道仪式」，而不是「少一样能力」**
// ——不要求计划、不注入验收契约、不算复杂任务。那个方向是对的，不该改。这个文件的作用不是
// 把它们全翻过来，而是把这一类**变成显式清单**：新长出来的否决位、或者改了形状的旧位，
// 都必须先在下面写清它往哪个方向倒，才能通过。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `SRC` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as SRC, SRC as RAW_SRC, fnSource } from "./helpers/source.mjs";

// 按**代码文本**登记，不按行号：这个文件几万行，行号每天都在漂，按行号钉的清单第二天就是
// 一堆假红。改了那一行的文本 = 改了那处判断，本来就该重新过一遍。
//
// direction 只有两个值：
//   "ceremony" —— 裁决缺席时少做一道仪式（不要求计划、不注入契约……）。能力不受影响，方向正确。
//   "capability" —— 裁决缺席时**夺走一样能力**。这是那天那个 bug 的形状，一律要 intentSource 守卫。
const REVIEWED = new Map([
  ["const readOnly = !!run.engineering?.explicitReadOnly;",
    { direction: "ceremony", why: "缺席 → 不视为只读 → 允许更多动作，倒向放行" }],
  ["const complexReadOnly = !!run.engineering?.projectScope;",
    { direction: "ceremony", why: "缺席 → 不算复杂只读任务 → 少一道计划仪式，不影响能力" }],
  ["return !!run.engineering?.requiresPlan;",
    { direction: "ceremony", why: "缺席 → 不强制先出计划 → 少一道仪式，倒向放行" }],
  ["const _quick = () => task.trim().length < 80 && !run.engineering?.applies && !_mustUseWorkspaceToolsNow();",
    { direction: "ceremony", why: "缺席 + 短消息 → 走轻量路径，不注入验收契约；只影响仪式" }],
  ["if (!run.engineering?.designKnowledgeRequired || !preflight.required) return false;",
    { direction: "ceremony", why: "这是**消费**预取结果的一侧；预取本身由正向闸门启动，缺席时压根没启动，这里返回 false 是自洽的" }],
  ["run._steeredWorkspaceRequired = !!run.engineering.explicitWorkspaceMutation;",
    { direction: "ceremony", why: "缺席 → 不额外声明写入义务；赋值而非否决" }],
  // 下面两条是 2026-08-20 扩了扫描器（按 .applies 认）之后才浮出来的。同一天修掉的那两处
  // 夺能力的判断（代码检索、当前打开文件正文）已经各自加了 intentSource 守卫，不在这张表里。
  ["if (profile.applies) {",
    { direction: "ceremony", why: "现在它只包着「所有模型共用的工程约束」那段散文和外部参考预取；"
      + "缺席 → 少发一段仪式性说明，能力不受影响。真正的证据（BM25 命中的代码片段）已经挪到"
      + "上面那个带 _verdictLanded 守卫的分支里，裁决没回来照给" }],
  ["if (_finishChecks.length || p.applies) {",
    { direction: "ceremony", why: "缺席 → 少列一份收尾自检清单；不夺任何能力" }],
]);

function denialSites(src) {
  const out = [];
  src.split("\n").forEach((line, index) => {
    const s = line.trim();
    if (!s || s.startsWith("//") || s.startsWith("*")) return;
    // 按名字认会漏：同一份工程画像在别处叫 profile / _turnEngineeringResolved / p，
    // 于是「裁决没回来就扣掉代码检索」和「扣掉当前打开文件的正文」两处夺能力的判断，
    // 从立这条守卫那天起就没被看见过（2026-08-20 查出并修掉）。
    // 所以再按**字段名**认一道：`.applies` 是那道能力闸的关键字段，谁持有它都算。
    // 不放宽到裸 `profile.*`——这个仓库里 profile 还指思考档位画像和自适应画像，会淹掉。
    if (!/run\.engineering\??\.[a-zA-Z]|\w\??\.applies\b/.test(s)) return;
    // 否决形状：对画像取非，或者拿画像字段做三元降级。
    const denies = /!\s*run\.engineering/.test(s) || /run\.engineering\??\.\w+\s*\?/.test(s)
      || /!\s*\w+\??\.applies\b/.test(s) || /\w\??\.applies\s*\?/.test(s)
      || /(?:if|&&|\|\|)\s*\(?\s*\w+\??\.applies\b/.test(s);
    if (!denies) return;
    out.push({ line: index + 1, text: s.replace(/\s+/g, " "),
      guarded: /intentSource|_verdictLanded|_ctxVerdictLanded/.test(s) });
  });
  return out;
}

test("每一处「按画像否决」都要写明：裁决缺席时它倒向哪边", () => {
  const sites = denialSites(SRC);
  assert.ok(sites.length >= 5,
    `只扫出 ${sites.length} 处否决位——正则失效了，这条断言等于没跑`);

  const unreviewed = sites.filter((site) => !site.guarded && !REVIEWED.has(site.text));
  assert.deepEqual(unreviewed.map((s) => `${s.line}: ${s.text}`), [],
    "这些「按画像否决」的判断既没有 intentSource 守卫，也没登记方向。\n"
    + "完整裁决实测 19.8 秒，画像为空是常态——先想清楚它缺席时你希望倒向哪边：\n"
    + "  · 少一道仪式（不要求计划、不注入契约）→ 登记进 REVIEWED，direction: \"ceremony\"\n"
    + "  · 夺走一样能力（工具、检索、知识）→ 必须加 intentSource 守卫，不许登记");

  // 清单不能变成谎言：登记了却已经不在代码里的条目要删掉，否则下一个人以为它还在守着。
  const present = new Set(sites.map((s) => s.text));
  for (const [text, meta] of REVIEWED) {
    assert.ok(present.has(text), `REVIEWED 里这条已经不在代码里了，删掉它：\n  ${text}`);
    assert.equal(meta.direction, "ceremony",
      `direction 只允许 "ceremony"。倒向 "capability" 的判断不该靠登记放行，必须加 intentSource 守卫：\n  ${text}`);
    assert.ok(meta.why && meta.why.length >= 12, `这条要写清为什么这个方向是安全的：\n  ${text}`);
  }
});

test("工具编排的闸门必须区分「裁决未到」和「裁决说不适用」", () => {
  // 这是那天那个 bug 的原位，单独钉一条：它是**唯一**一处倒向 capability 的否决，
  // 也是「我让他干什么他什么都不知道」的直接成因。回退它不该只让上面那条泛化断言变红。
  // 区间按 AST 取整条声明，不再是「从锚点起数 1400 个字」。
  //
  // 原来两行：`SRC.slice(RAW_SRC.indexOf("const _startInitialToolRoutingAfterFirstTurn"))`
  // 再 `.slice(0, 1400)`。它当时还抓得住回归，但余量薄得只剩一次改动：
  //   · 声明真身 1012 字，窗口 1400——余量 388 字；而这 1012 字里有 600 字是复盘那次事故的
  //     注释（CODE 把注释置换成**等量空格**，长度不变、照样占偏移）。往这段注释里再补
  //     623 字说明（实测：声明涨到 1635 字），末尾的代码就滑出窗口——两条 assert.match 仍
  //     落在 1000/1162 偏移上、照样绿，而下面那条 assert.doesNotMatch（正是拦「旧的无条件
  //     否决又长回来」的那条）从此恒真。实测过这个变异：把 `|| !run.engineering?.applies ||`
  //     追加到声明末尾（偏移 1424，窗口外），整个文件 8/8 全绿，一声不吭。
  //   · 反过来，那 388 字余量今天已经越过声明尾部，doesNotMatch 正管着声明**后面**一段
  //     不相干的代码——那边写出这个形状会假红。
  // fnSource 按 AST 节点边界切：声明长成什么样都盖得住，也一个字都不会盖到声明外面。
  const gate = fnSource("_startInitialToolRoutingAfterFirstTurn", { code: true });
  assert.match(gate, /const _verdictLanded = run\.engineering\?\.intentSource === "ai";/,
    "工具编排闸门不再区分「裁决未到」——画像为空时整轮 128 个工具都进不来");
  assert.match(gate, /\(_verdictLanded && !run\.engineering\.applies\)/,
    "只有**裁决真的到了且说不适用**才拦；「还没到」必须放行");
  assert.doesNotMatch(gate, /\|\|\s*!run\.engineering\?\.applies\s*\|\|/,
    "旧的无条件否决又长回来了");
});

// ── 提醒的淘汰顺序 ───────────────────────────────────────────────────────
//
// 同轮挂太多提醒，模型会逐条表态，输出又长又自我横跳——所以要有上限。但"总数 ≤2"把病治过
// 头了：一条 [BUILD_FAILED]、一条"你改了从没读过的文件"、一条子智能体带回来的结论，是三份
// 互不替代的**现场**，丢哪一条模型都会照着错误的图景继续干活；而"逐条表态"的病根在建议类。
// 所以建议只留 1 条、总额 4 条，超额时按重要性挑（先建议、再最旧的事实）。
test("提醒按重要性淘汰，不是按先来后到", () => {
  const factsSrc = /const _NUDGE_FACTS = new Set\(\[[\s\S]*?\]\);/.exec(SRC);
  const onceSrc = /const _NUDGE_ONCE = new Set\(\[[\s\S]*?\]\);/.exec(SRC);
  const rankSrc = /const _nudgeRank =\s*\n?\s*\(cat\) =>[\s\S]*?;/.exec(SRC);
  assert.ok(factsSrc && onceSrc && rankSrc, "分级表或 _nudgeRank 被改名/挪走了——淘汰会退回按先来后到");
  const rank = new Function(`${factsSrc[0]}\n${onceSrc[0]}\n${rankSrc[0]}\nreturn _nudgeRank;`)();

  assert.equal(rank("steer"), 0, "用户实时插话必须永远最高优先级");

  // ── 一次性档（2026-08-26）─────────────────────────────────────────────
  // 判据是**结构性**的，不是重要性：这几条的推送点都由一个 run 级标记守着（读了就置位），
  // 所以淘汰它们和淘汰 toolReminder / planStale 那种「12 轮后还会再来」的完全不是一回事——
  // 后者挤掉只是晚几轮再说，前者挤掉就是这一整个 run 再也不会有第二次提起。
  //
  // researchFirst 已经因为这条道理从建议类升过一次事实类，但事实类内部仍按「最旧的先走」
  // 淘汰，而它偏偏是**第一次写入**那一刻推的——四条事实一凑齐，第一个被踢的还是它。
  // 同一个病，低一层。
  // emptyHistoryFact 从这张表里移走了（2026-09-02）：它连同注入一起删了 ——
  // 原则搬进常驻层 truthfulness（「Earlier conversation is not evidence about the current
  // disk … the disk wins」），事实那半由环境块每轮承载（「🚫 现场已替你实探：当前工作区
  // 是**空目录**」，main.js 里 parts.unshift，每轮都在）。两侧都在，注入是第三遍。
  // websiteContent 也移出了（2026-09-02）：和 verifyNow/uiLook/browserVerify 一样，
  // 文本并进了 [本轮交付事实] —— 那块每轮无条件推、推前 splice 掉上一份，
  // **完全不参与同轮淘汰**，「一次性提醒被挤掉就永久失去」这个风险因此不存在了。
  for (const once of ["researchFirst", "planFinish"]) {
    assert.equal(rank(once), 1, `${once} 是一次性提醒，挤掉就是整个 run 永久失去`);
  }
  // researchFirst 2026-08-22 从建议类改判事实类：它陈述的是执行事实（"这次工程语义要求
  // 外部参考，而取证账本是空的"，由 _missingResearchEvidence 按台账算出来），和 websiteContent
  // 是同一个判据的两半。而它偏偏只在**第一次写入**推一次（researchGateNudges < 1，整个 run
  // 就这一次机会），留在建议类里就意味着任何一条更晚的建议都能把它永久挤掉。
  // recovery 从这张表里移走了（2026-09-02）：它连同注入一起删了 —— 那是**同一段文字的
  // 第二次投递**（_toolMsgForModel 生成失败工具结果时就把 [RECOVERY:…] 拼进正文了）。
  // subagentResult 同理：并进了那条完整报告事实消息。
  for (const fact of ["buildFix", "diag", "blindEdit", "toolRepair", "turnRetry"]) {
    assert.equal(rank(fact), 2, `${fact} 是事实类，丢了模型会按错误图景干活`);
  }
  // midSummary 已删（它自称[事实]，陈述的却是模型自己刚发那条消息的重述；规则在 agent_core）。
  for (const advice of ["planNudge", "stuck", "askBudget"]) {
    assert.equal(rank(advice), 3, `${advice} 是建议类，可以被事实挤掉`);
  }
  assert.equal(rank("someBrandNewNudge"), 3,
    "没登记的新提醒必须默认按建议类——要保命就得显式登记，不能靠默认捡到便宜");
  // 一次性档必须保持短：它挡在 ≤4 的名额前面，列进来的越多，上限越接近失效。
  const onceCount = [...onceSrc[0].matchAll(/"[a-zA-Z]+"/g)].length;
  assert.ok(onceCount <= 4,
    `一次性档有 ${onceCount} 条，已经吃掉 ≤4 名额的大半 —— 加之前先确认它真的被 run 级一次性标记守着`);

  // 拿**源码里真实的那段淘汰循环**跑，不照抄一份：照抄的话我改了源码它照样绿。
  // 拿**源码里真实的那段淘汰逻辑**跑，不照抄一份：照抄的话我改了源码它照样绿。
  const loopSrc = /const _dropNudge = \(victim\) => \{[\s\S]*?\n    \}\n/.exec(SRC);
  assert.ok(loopSrc, "淘汰逻辑的形状变了，这条断言失去落点");
  assert.match(loopSrc[0], /_nudgeRank\(key\) > _nudgeRank\(worst\)/,
    "超额淘汰没有按 _nudgeRank 挑——又回到了按先来后到");

  // _nudgeTurnFloor = 0：这个测试台里全部消息就是那几条提醒本身，索引 0 起，
  // 也就是「都在本轮尾部」。棘轮（只在尾部才真删）在这里恒真，被测的收敛行为一字不变。
  const evict = new Function("_nudgeReg", "messages", "cat", "_nudgeRank", "_nudgeTurnFloor", `${loopSrc[0]}\nreturn [..._nudgeReg.keys()];`).bind(null);
  const _evict0 = evict;
  const evictWrap = (reg, msgs, c, rank) => _evict0(reg, msgs, c, rank, 0);
  const mk = (names) => {
    const reg = new Map(names.map((n) => [n, { c: n }]));
    return { reg, msgs: names.map((n) => reg.get(n)) };
  };

  // ① 事实不再被事实挤掉：三条事实 + 一条建议，第四条事实进来时该走的是建议。
  const a = mk(["buildFix", "diag", "blindEdit", "askBudget"]);
  assert.deepEqual(evictWrap(a.reg, a.msgs, "subagentResult", rank),
    ["buildFix", "diag", "blindEdit"],
    "第四条事实到达时挤掉的必须是建议——构建失败、盲改警告、子智能体结论互不替代");
  assert.equal(a.msgs.length, 3, "被淘汰的那条也要从消息列表里摘掉，不能只从注册表删");

  // ② 总额仍然有界：全是事实且已满额时，最旧的那条事实才让位。
  const b = mk(["buildFix", "diag", "blindEdit", "turnRetry"]);  // cmdFail 已删（重复投递），换一条同为事实类的
  assert.deepEqual(evictWrap(b.reg, b.msgs, "subagentResult", rank),
    ["diag", "blindEdit", "turnRetry"], "满额时让位的是最旧的事实，且总数收敛");

  // ③ 建议同时只留 1 条（正在推入的那条就是这 1 条），事实不受牵连。
  const c = mk(["buildFix", "askBudget"]);
  assert.deepEqual(evictWrap(c.reg, c.msgs, "planNudge", rank), ["buildFix"],
    "两条建议不能同时挂着，而事实要留下");

  // ④ steer 永远不被挤。
  const d = mk(["steer", "buildFix", "diag", "blindEdit", "turnRetry"]);
  assert.deepEqual(evictWrap(d.reg, d.msgs, "subagentResult", rank),
    ["steer", "diag", "blindEdit", "turnRetry"], "用户实时插话被挤掉了");
});

test("默认完整交付、先读懂再动手、每一步先想", () => {
  // 用户的原话：「随便写 MVP 结构糊弄用户」「动不动就把别人代码写烂」「必须先把全部项目读懂
  // ……才能去修改代码」「每写一个文件每做一步就需要去思考」。
  // 补之前全仓搜 MVP / 最小可用 / 糊弄，服务端提示词和客户端**零命中**——从来没有任何一条
  // 规则要求它别缩水。没有规则，模型缩到能跑就交，而且缩水本身不会被说出来。
  // 按 AST 取整个函数，不要 `开放式切片 + slice(0, 8000)`：这个函数实测 18041 字，
  // 8000 的窗口只盖住 44%。正向断言落在 3470–4889，都在窗口内所以照常工作；而**反向**
  // 断言（下面那条「降级那条路不许回来」）对窗口外的后 56% 天然恒真——正向断言失效会
  // 吵，反向断言失效是哑的，而这条守的正是最高优先级的产品约束。
  const laws = fnSource("_agentDecisionFrameBlock", { code: true });

  // ① 不降级。需求大就拆切片，不是砍功能。
  assert.match(laws, /交付规格律：默认按\*\*完整可用\*\*交付，不降级、不做演示版/,
    "交付规格律不见了——没有它，模型默认就是能跑就交");
  assert.match(laws, /需求过大就拆成\*\*有序的完整切片\*\*逐个交付/,
    "缺了「拆切片而不是砍功能」——否则「完整」遇到大需求就没法执行");
  for (const banned of ["TODO", "占位实现", "假数据"]) {
    assert.ok(laws.includes(banned), `禁止项少了「${banned}」——"完整"没有具体所指就会被解释掉`);
  }
  // ask_user 的用途被写死：问不懂的地方，不是拿来推卸交付标准。
  assert.match(laws, /ask_user 只在你真的读不懂用户要什么时才用/,
    "ask_user 的用途没写死，模型会拿它去问「要不要先做个简版」");
  // 只禁**肯定式**的那条路径。律文里那句「不要拿它去问『要不要先做个简版』」本身含这个词，
  // 按裸词去禁会把禁令自己判红（第一版就是这么误伤的）。
  assert.doesNotMatch(laws, /用 ask_user 把「完整实现」和「先做最小可用版」两条路/,
    "降级那条路又回来了——用户明确说过不需要降级");
  assert.match(laws, /不要拿它去问「要不要先做个简版」/,
    "要把这条路显式堵死，光不提它模型还是会自己想出来");

  // ② 先读懂再动手：依赖、入口、边界、真实成因，且要改的文件必须先读过。
  assert.match(laws, /先读懂再动手律/, "缺了「先读懂再动手」");
  assert.match(laws, /bug 的\*\*真实成因\*\*（不是症状）/, "要求找真实成因，不是照着症状改");
  assert.match(laws, /必须先 read_file 读过，不靠记忆和猜测下手/,
    "「要改的文件必须先读过」是「把别人代码写烂」的直接对策");

  // 反推理：读懂之后要推出用户没说的需求、牵连面、以及顺手发现的其它真实缺陷。
  assert.match(laws, /读懂之后\*\*反推一遍\*\*/, "缺了反推理——只按字面做，用户没说的部分永远不会被发现");
  assert.match(laws, /超出范围的在收尾时一句话点出来，别装作没看见/,
    "反推出来的东西要有出口：属于本次的做掉，超范围的说出来，而不是默默丢掉");
  // 改完之后旧快照过期——机制层已经会作废读取证据，这里把它写成模型侧的明确要求。
  assert.match(laws, /不拿旧快照当现状，也不沿用已经被替换掉的老文件/,
    "缺了「别用旧内容」——用户明确抱怨过它傻咧咧拿旧文件用");

  // ③ 每一步先想 + 立刻验证 + 自己写测试真跑。
  assert.match(laws, /逐步思考律/, "缺了「每一步先想」");
  assert.match(laws, /光看代码不算验证/, "「验证」不写死就会退化成肉眼看一遍代码");
  assert.match(laws, /自己写一个测试文件或临时脚本\*\*去真跑一遍/,
    "缺了「没测试就自己写一个」——用户点名要 Claude Code 那种自主写测试验证");
  assert.match(laws, /一次性验证脚本用完\*\*当轮就删掉\*\*/,
    "要区分临时脚本和该留下的测试，否则项目里会堆满一次性文件");
  // 实证（用户的 ThesisX）：项目有标准 pytest 套件 tests/，模型却在根目录留下
  // _temp_test.py / simple_test.py / run_final_test.py / verify_optimization.py，
  // 一个都没进套件、一个都没删。所以"写到哪去"必须和"用完要删"一起说。
    assert.match(laws, /新测试沿用它的组织方式，别在根目录另起散文件/,
      "只说了要写测试、没说写到哪，模型就会在根目录另起散文件");
    // 修 bug 的正确顺序：先红后绿。没红过的测试证明不了修的是这个 bug。
    // **但这条要有判据**：原来是无条件的「修 bug 时先写一个能复现它的测试」，而
    // agent_engineering.txt:22 写的是 reproduce **or** read the real error。无条件那版的
    // 实测形状：用户贴一条 stack trace、报错指向一处漏写的空值判断，模型却要先去项目里
    // 新建一个测试文件——而那个项目可能根本没有测试体系。
    assert.match(laws, /\*\*项目已经有测试体系、而这个 bug 落在它覆盖得到的范围里时\*\*/,
      "「先写红测试」又变回无条件了——没有测试体系的项目会被逼着从零搭一套");
    assert.match(laws, /reproduce \*\*or\*\* read/,
      "没说清另一条路（读懂真实报错 + 走一遍失败路径）同样算数");
  assert.match(laws, /先看着它红，再动手修/);
  // 最危险的一条：删测试让构建变绿。不写死就没有任何东西拦。
  assert.match(laws, /永远不许删掉或注释掉既有测试来让构建变绿/,
    "缺这条红线，「让构建绿」最省事的做法就是把失败的测试删了");
  assert.match(laws, /写完立刻用真实结果（诊断\/命令退出码\/真实输出）验证再走下一步/,
    "想完还要立刻验证，否则「思考」落不到地");

  // 已有代码的写法要沿用——用户抱怨的另一半。
  assert.match(laws, /沿用现存的分层、命名、错误处理和测试方式/, "缺了「沿用现有约定」");
});

// ── 项目本地记忆落到文件 ───────────────────────────────────────────────────
//
// 用户："能创建 Mr. Day One 项目本地记忆……可以实时扶正项目内容、锁定项目目标不偏航、
// 也能把遇到的错误放进去保持自己不会再犯。"
//
// 目录按产品名 .mrdayone/（对应 Claude Code 的 .claude/）。
// 补之前：记忆只活在 localStorage（key = michael-ide.kg:<root>）——**不在项目里**。用户看不见、
// 改不动、换台机器就没了、清一次应用数据就丢，而里面存的恰恰是最不该丢的那些东西。
test("项目记忆要落到项目里的文件，而不是只活在浏览器存储里", () => {
  assert.match(SRC, /const _PROJECT_MEMORY_REL = "\.mrdayone\/memory\.md";/,
    "项目记忆没有对应的文件——清一次应用数据就全丢了");

  // 分节沿用已有的 _kgClassify，不新造一套分类：两套分类必然漂。
  const sections = /const _PM_SECTIONS = \[([\s\S]*?)\];/.exec(SRC);
  assert.ok(sections, "分节表不见了");
  for (const must of ["锁定，防偏航", "实时扶正", "不再犯"]) {
    assert.ok(sections[1].includes(must), `分节少了「${must}」——那是用户点名要的三件事之一`);
  }
  assert.match(sections[1], /"pitfall"/, "「踩过的坑」要接到 _kgClassify 已有的 pitfall 分类上");

  // 渲染：只写活的笔记，被作废的不能再出现在文件里（否则手改文件的人会照着过期结论走）。
  const md = /function _projectMemoryMarkdown\(root\)[\s\S]*?\n\}/.exec(SRC);
  assert.ok(md, "渲染函数不见了");
  assert.match(md[0], /superseded\.has\(note\.id\)/, "被纠错作废的笔记不该写进文件");

  // 写入：记完就落盘，但不 await——落盘失败不该让「已记住」变成失败。
  assert.match(SRC, /if \(ok && !isGlobal\) void _mirrorProjectMemoryFile\(root\);/,
    "项目记忆写入后没有落盘");

  // 读回：只在本地存储确实为空时导入，否则一份旧文件会把刚记的东西抹掉。
  const imp = /async function _importProjectMemoryFile\(root\)[\s\S]*?\n\}/.exec(SRC);
  assert.ok(imp, "读回函数不见了");
  // 钉判据，不钉写法：这段后来加了「本地有、文件没有 → 反向补一次」那一半，
  // 原来那句一行式的 `if (_kgLoad(root).length) return 0;` 被拆成了变量 + 分支，
  // 行为一个字没变（本地有记忆就绝不导入），断言却红了。
  assert.match(imp[0], /_kgLoad\(root\)/, "不再读本地记忆，就无从判断该不该导入");
  assert.match(imp[0], /if \(_localNotes\.length\)[\s\S]{0,1200}?return 0;/,
    "必须只在本地记忆为空时导入——否则旧文件会静默回退掉新记的内容，那是最难查的一类问题");
  // 反向那半也钉住：本地有、文件没有时要补写，否则存量项目永远不会产出 memory.md。
  assert.match(imp[0], /_mirrorProjectMemoryFile\(root\)/,
    "本地有记忆而文件不存在时没有补写——存量项目永远导不出 memory.md");
  assert.match(imp[0], /if \(!line\.startsWith\("- "\)\) continue;/,
    "只认列表项：标题和注释不是记忆");
  assert.match(SRC, /void _importProjectMemoryFile\(path\);/, "打开项目时没有读回");
});

test("harness 注入的消息都要戴信封，否则会被当成用户说的话", () => {
  // 用户实拍：让它 clone 一个仓库 → git_clone 因缺必填字段失败 → 修复指令被当成**裸的**
  // role:"user" 消息追加在最后 → 模型在思考里写下「只有系统提示和错误通知，没有用户的实际
  // 请求」，开始怀疑自己是不是不该 clone。网关字节数对得上：请求正文=113（用户的话在），
  // 末条用户=1469 且 orch_msg_count=0（最后那条既不是用户的话、也没戴信封）。
  //
  // 信封是模块级常量：修复指令在 _agentModelTurn 里注入，拿不到 _runAgenticLoop 的局部变量
  // ——这就是它一直裸着的原因。戴上之后网关的 orch_bytes 统计也能覆盖到它。
  assert.match(SRC, /^const _ORCH_NOTE = "〔系统编排提示/m,
    "_ORCH_NOTE 必须是模块级常量，否则跨函数注入的消息戴不上信封");
  assert.doesNotMatch(SRC, /^  const _ORCH_NOTE = /m,
    "又变回局部常量了——那么 _agentModelTurn 里的注入会重新裸奔");

  assert.match(SRC, /_argRepairMsg = \{ role: "user", content: `\$\{_ORCH_NOTE\}\[工具参数校验失败\]/,
    "工具参数修复指令没戴信封——它会被模型当成用户发言，并把用户真正的请求顶走");
});

test("schema 不许比实现更严——模型不填就整轮失败", () => {
  // 用户："估计许多工具有这种 bug 问题。" 对了：机械扫描发现 9 处 schema 标必填、而实现里
  // 本来就有**有意义的默认值**。git_clone 是被实拍到的那个——required:["source","target"]，
  // 而「把这个仓库拉下来」本不该逼模型编一个落地目录。
  const catalog = JSON.parse(readFileSync(join(HERE, "..", "..", "server", "prompts", "tools.json"), "utf8"));
  const req = (name) => {
    const tool = catalog.find((t) => t?.function?.name === name);
    assert.ok(tool, `目录里没有 ${name}`);
    return (tool.function.parameters || {}).required || [];
  };

  // git_clone：target 改成可选，并且实现要能从仓库地址推出落地目录名。
  assert.deepEqual(req("git_clone"), ["source"], "git_clone 的 target 又变成必填了");
  // 不钉源变量名：推断的输入现在是**清洗过**的地址（粘网页链接时先截回 owner/repo），
  // 名字还会再变。守的是「有这一步、且会剥掉 .git」。行为断言在
  // test/tool-contract-sweep.test.mjs 里，那边是真把参数喂进归一化去比结果。
  assert.match(SRC, /const _inferred = \([\w$]+\.replace\(\/\\\.git\$\/i, ""\)/,
    "缺了「从仓库地址推目录名」——只放宽 schema 而不给默认值，落地目录会是空字符串");

  // 其余几处：实现有真实默认值的字段不该拦在 schema 上。
  for (const [name, field] of [
    ["browser", "action"], ["ui_extract", "source"], ["worktree", "action"],
    ["ui_click", "action"], ["visual_explain", "title"], ["background_monitor", "message"],
    ["run_worker", "description"],
  ]) {
    assert.ok(!req(name).includes(field),
      `${name}.${field} 仍是必填，而实现里有默认值——模型不填就白费一整轮`);
  }

  // 反过来：description 是 run_subagent 的**任务本身**，不是标签。默认值是占位符，
  // 不填就派出一个不知道要干什么的子智能体——这里保持严格是对的，别被上面那条扫描带走。
  assert.ok(req("run_subagent").includes("description"),
    "run_subagent 的 description 是任务本身，必须保持必填");
});

// 登记表按**文本**认，拦不住「这行没变、但它里面装的东西变了」。
// 实测：把代码检索挪回 `if (profile.applies) {` 里面，上面那条守卫一声不响——因为那行文本
// 已经登记成「仪式」。所以对**具体那件能力**再钉一条：证据必须在带裁决守卫的分支里取。
test("代码检索是能力不是仪式：裁决没回来时照给", () => {
  // 认 `await …` 那处**调用**，别撞上同名的函数定义（定义在前，indexOf 会先命中它）。
  const at = RAW_SRC.indexOf("await _buildRetrievedCodeContext(query, root");
  assert.ok(at > 0, "首答路径上的代码检索调用不见了");
  // 往上找最近的那个 if，必须带裁决守卫。
  const before = SRC.slice(Math.max(0, at - 600), at);
  const lastIf = before.lastIndexOf("if (");
  assert.ok(lastIf >= 0, "取不到它所在的分支");
  const branch = before.slice(lastIf, before.indexOf("\n", lastIf) + 1 || undefined);
  assert.match(branch, /_verdictLanded/,
    "代码检索又被裸 applies 包住了 —— 裁决实测 8–20 秒、前台只等 6 秒，"
    + "那意味着「裁决还没回来」的常态下就把已经在内存里的证据扣着不给。"
    + "gate-tristate 的规矩写着：夺走一样能力（工具、**检索**、知识）必须加 intentSource 守卫");
  // 守卫的语义也要对：是「没落地就照给」，不是「没落地就不给」。
  assert.match(branch, /!_verdictLanded \|\|/,
    "守卫方向反了 —— 应该是「裁决没落地 → 照给」，不是「落地了才给」");
});
