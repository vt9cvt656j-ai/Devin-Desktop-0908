// 工具卡上写给用户的**理由**必须对得上事实。
//
// 2026-08-23 用户现场（他自己的 AICode 项目，一个 agent 回合）：
//   · 编辑 README.md          → 红徽章「先查一下再选」
//   · 运行 chmod +x …（删除线）→ 红徽章「前项真实失败 · 后续已停止」
//   · 知识检索 ×3             → 红徽章「无可用命中」
// 三张卡的理由全是错的：
//   ① 拦住那次编辑的是**计划门**（[BLOCKED_PLAN_FIRST]，要求先写计划），不是调研门。
//      两道门共用一句文案和同一个失败码，于是用户被告知去做一件他根本没被要求做的事。
//   ② 「前项真实失败」——前项是被门在运行前拦下的，一个字节都没写，没有任何失败输出可读。
//   ③ 红色只可能来自 `[失败]` 开头的正文，也就是说那三次是**真失败**（HTTP/异常），
//      却被写成「无可用命中」；模型据此会把「没拿到」当成「库里确实没有」写进交付说明。
//
// 拦截本身**不改**：门是「一个 run 只拦一次」，放行后续等于让那道要求彻底落空
// （logic.test.mjs 正面钉着前项 [BLOCKED] 时后续必须停）。这里改的只有「理由」。
import { test } from "node:test";
import { failedWritePaths as _failedWritePaths } from "../src/agent/write-ledger.js";
import assert from "node:assert/strict";
import { CODE as SRC, load, fnSource } from "./helpers/source.mjs";

const succeeded = load("_toolExecutionSucceeded", {
  _WORKSPACE_MUTATING_TYPES: new Set(["write", "edit", "multiedit"]),
  _toolFailureMatch: load("_toolFailureMatch"),
  _toolFailureMarkerAtHead: load("_toolFailureMarkerAtHead"),
});

// ── ① 两道门必须各说各的 ──────────────────────────────────────────────
const dispatch = fnSource("_runAgenticLoop", { code: true }) || SRC;

test("计划门和调研门给的是两句不同的话", () => {
  assert.match(SRC, /const _planFirst = techIssue\.startsWith\("\[BLOCKED_PLAN_FIRST\]"\)/,
    "两道门又合流了——用户会被告知去做一件他没被要求做的事");
  assert.match(SRC, /_planFirst \? "先写计划再动手" : "先查一下再选"/,
    "徽章文案没有按门分开");
  assert.match(SRC, /code: _planFirst \? "plan_first" : "tech_research"/,
    "失败码没有按门分开——恢复指令会走错分支");
});

test("拦截本身一个都没被放行（改文案不许顺带把门改松）", () => {
  // 这条是反向断言。只钉「文案分开了」是绿的摆设：把整段拦截删掉它照样绿。
  assert.match(SRC, /const techIssue = _planBeforeBuildIssue\(run, it\.call\) \|\| _newTechResearchIssue\(run, it\.call\)/,
    "门的调用点没了");
  assert.match(SRC, /if \(_planFirst\) run\._planStopUsed = true;\s*\n\s*else run\._techResearchStopUsed = true;/,
    "「一个 run 只拦一次」的记号没置——门会反复拦同一轮");
  assert.match(SRC, /it\.rawResult = blocked;/, "拦截结果没有落到 item 上");
});

// ── ② 「真实失败」要对得上事实 ────────────────────────────────────────
const isPreBlock = load("_isPreExecutionBlock", {
  _PRE_EXECUTION_BLOCK_CODES: new Set([
    "plan_first", "tech_research", "read_before_edit", "mutation_batch", "command_batch",
  ]),
});

test("预执行拦截这一族认得全，且不误收跑过之后才有的结局", () => {
  for (const code of ["plan_first", "tech_research", "read_before_edit", "mutation_batch", "command_batch"]) {
    assert.equal(isPreBlock({ failure: { code } }), true, `${code} 应算门拦`);
  }
  // 这两个是**跑过了**才有的结局：请求发出去了、监控起来了。把它们算成「没跑过」，
  // 卡片就会对一次真实的重定向/不可核查说「前项被门拦下」。
  for (const code of ["http_redirect", "monitor_uncheckable"]) {
    assert.equal(isPreBlock({ failure: { code } }), false, `${code} 不是预执行拦截`);
  }
  assert.equal(isPreBlock({ ok: false, content: "[BLOCKED]" }), false,
    "没有结构化失败码时不许靠猜——那会把真失败也说成门拦");
  assert.equal(isPreBlock(null), false);
  assert.equal(isPreBlock({}), false);
});

test("预执行拦截这一族的成员是钉死的", () => {
  // 上面那条行为断言吃的是**注入进去的**集合，改真集合它不会红（变异实测：往真集合里
  // 加 http_redirect，11 条测试全绿）。成员表必须对着源码本身钉。
  const m = SRC.match(/const _PRE_EXECUTION_BLOCK_CODES = new Set\(\[([\s\S]{0,400}?)\]\)/);
  assert.ok(m, "_PRE_EXECUTION_BLOCK_CODES 不见了");
  const codes = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(codes,
    ["command_batch", "mutation_batch", "plan_first", "read_before_edit", "tech_research"],
    "成员变了。每一个进来的都必须满足「门在运行前拦下、磁盘一个字节都没写」——"
    + "http_redirect / monitor_uncheckable 是**跑过了**才有的结局，收进来就会把一次真实结局"
    + "说成「前项被门拦下」，用户又一次读到错的理由");
});

const blockedEarlier = load("_preExecutionBlockedEarlier", { _isPreExecutionBlock: isPreBlock });

test("同批更早的门拦认得出来", () => {
  const items = [
    { rawResult: { ok: false, failure: { code: "plan_first" } } },
    { call: { type: "cmd" } },
  ];
  assert.equal(blockedEarlier(items, 1), true);
  assert.equal(blockedEarlier([{ rawResult: { ok: false, code: 1, content: "npm ERR!" } }, {}], 1), false,
    "真跑过并失败的前项不该被说成门拦");
  assert.equal(blockedEarlier(items, 0), false, "第一项前面没有任何项");
  assert.equal(blockedEarlier(null, 1), false);
});

test("批量停止的徽章按前项性质分成两句", () => {
  assert.match(SRC, /_preExecutionBlockedEarlier\(items, index\) \? "前项被门拦下 · 后续已停止" : "前项真实失败 · 后续已停止"/,
    "又变回一句「真实失败」了——用户会去找一个并不存在的失败输出");
});

// ── ③ 知识检索：零命中 ≠ 检索失败 ─────────────────────────────────────
const label = load("_knowledgeSettleLabel", { _toolExecutionSucceeded: succeeded });
const CALL = { type: "knowledge", domain: "michael-design", query: "卡片布局" };

test("有命中时照常报条数", () => {
  assert.equal(label(CALL, { knowledge: { hitCount: 3 }, content: "…" }, "3 段 · 已注入"), "3 段 · 已注入");
});

test("真零命中说「无可用命中」——那是一个结论", () => {
  const zero = { type: "knowledge", knowledge: { hitCount: 0, domains: [] },
    content: "知识库的「michael-design」这一个域里没有「卡片布局」相关的内容。确认该主题确实不可用后，基于用户明确要求与项目证据继续。" };
  assert.equal(label(CALL, zero, ""), "无可用命中");
  // 顺带钉住：这段正文里有「不可用」三个字，而失败判据的词表里也有它。
  // 判据要求它出现在**方括号内**，所以这段正文不该被判成失败——一旦哪天判据放宽成裸词，
  // 每一次正常的零命中都会被涂红。
  assert.equal(succeeded(CALL, zero), true, "零命中被判成失败了——正常检索会整片变红");
});

test("检索失败必须说失败，并带上真实原因", () => {
  for (const [content, want] of [
    ["[失败] 知识库查询 HTTP 429: rate limited", /^检索失败 · HTTP 429/],
    ["[失败] 知识库查询 HTTP 401: unauthorized", /^检索失败 · HTTP 401/],
    ["[失败] michael-design 预取异常: fetch failed", /^检索失败 · michael-design 预取异常/],
  ]) {
    const got = label(CALL, { type: "knowledge", content }, "");
    assert.match(got, want, `失败被写成了别的：${got}`);
    assert.doesNotMatch(got, /无可用命中/,
      "一次真实失败仍被写成「没查到内容」——模型会把「没拿到」当成「库里确实没有」");
  }
});

test("两个检索落定点都走同一个判据（漏一个就还有半边是错的）", () => {
  // 只数**调用点**：`_knowledgeSettleLabel(call, result,` 也会匹配到函数自己的定义行
  // （这条断言第一次写就被自己的定义喂到 3）。
  // 领域知识那一处搬进了 src/agent/knowledge-preflight-card.js（四张卡合成一张时），
  // 那边的形参没有下划线前缀，所以两种拼法都数。守的性质一个字没变：
  // **两个落定点都必须经过 knowledgeSettleLabel**，它是全系统唯一区分
  // 「检索失败」与「零命中」的地方；谁绕过去，谁那半边就会把失败说成「库里没有」。
  // 2026-08-30：michael-design 那条路也改走融合卡之后，两个落定点**共用**了
  // knowledge-preflight-card.js 里的同一次结算。这比"两处各自记得调"更强：判据从
  // 「两个地方都别忘」变成「只有一个地方能调」，漏一个在结构上就不可能了。
  // 所以这里改成钉那个性质本身，而不是数出现次数。
  const judged = (SRC.match(/settleToolStep\(step, result,\s*\n?\s*(?:typeof )?_?knowledgeSettleLabel\b/g) || []).length;
  assert.equal(judged, 1,
    `唯一判据点应当只有一处（在 knowledge-preflight-card.js 的 settlePreflightCard 里），实际 ${judged} 处`);
  // 而两条预检路都必须落到那一处去——否则"只有一个地方能调"就成了"有一条路根本不调"。
  for (const [fn, name] of [["_runDomainKnowledgePreflight", "领域知识预检"],
                            ["_runMichaelDesignPreflight", "michael-design 预检"]]) {
    const body = fnSource(fn, { code: true }) || "";
    assert.ok(body.length > 300, `取不到 ${fn} 正文`);
    assert.match(body, /_settlePreflightCard\(/,
      `${name}没有走融合卡的结算——它那半边会绕过唯一的失败/零命中判据`);
  }
  assert.doesNotMatch(SRC, /_settleToolStep\(step, result, evidence \? [^\n]*: "无可用命中"\)/,
    "michael-design 那处还在直接写死「无可用命中」");
});

// ── ④ 简报里对模型说的话 ─────────────────────────────────────────────
test("检索失败时，简报不许对模型说「知识库没有」", () => {
  const brief = fnSource("_michaelDesignBrief", { code: true });
  assert.match(brief, /const _failedTracks = \(Array\.isArray\(results\) \? results : \[\]\)\.filter\(\(item\) => item\?\.failed\)/,
    "简报没有区分「失败」和「零命中」");
  assert.match(brief, /\*\*这不等于知识库里没有内容\*\*/,
    "失败时给模型的话里没有把这条说穿——它会把「没拿到」写成「库里没有」");
  assert.match(brief, /\$\{excerpts \|\| _noHitNote\}/, "兜底句没有接上");
});

test("「这次是失败还是零命中」用结构字段判，不用文案匹配", () => {
  const pre = fnSource("_runMichaelDesignPreflight", { code: true });
  assert.match(pre, /failed: !result\?\.knowledge/,
    "判据不是结构字段了——文案一改，这条链就静默失效");
  // 反向：确认这个结构差别真的存在于生产方
  const search = fnSource("_searchKnowledgeBase", { code: true });
  assert.match(search, /knowledge: \{ hitCount: 0, domains: \[\] \}/, "零命中分支不再带 knowledge 字段");
  assert.match(search, /content: `\[失败\] 知识库查询 HTTP \$\{response\.status\}/, "HTTP 失败分支变了");
});

// ── ⑤ 被门拦下的写入必须留下痕迹 ────────────────────────────────────
//
// 实测（2026-08-23，用户的 AICode）：09:03:31 模型回复里写着「README.md 已更新」，
// 而磁盘上那个文件直到 09:20:23 才第一次被真正写入——中间 17 分钟里它一个字节没变。
// 那次编辑正是截图里被门拦下的那张卡。
//
// 拦下它是对的。**但拦下的写入必须仍然留下痕迹**，否则整条对账链没有输入：
//   门拦 → it.rawResult = blocked → 那一遍 `for (const it of items)` 照样处理它
//        → 写盘台账 {path, ok:false}
//        → 模型侧：_deliveryFactsLine 说「这些文件此刻不在磁盘上，不要说它们已保存/已生成」
//        → 用户侧：run._incompleteReason = writes_failed:N，结局卡片上看得到
// 这条链断在任何一环，「已保存」那句话就没有任何机器事实与之矛盾。
const deliveryLine = load("_deliveryFactsLine", {
    _failedWritePaths,
  _deliveryFacts: () => ({ code: [], tests: [], ran: [], verifiers: [] }),
  _strayScratchFiles: () => [],
  _projectStacks: new Map(),
});

test("台账里有落空的写入时，模型会被当面告知别说「已保存」", () => {
  const said = deliveryLine({ _writeLedger: [{ path: "/p/README.md", ok: false }] });
  assert.match(said, /没有落盘/);
  assert.match(said, /不要说它们已保存\/已生成/,
    "只报了数字没说清后果——模型照样会在总结里写「已更新」");
  assert.match(said, /README\.md/, "没点名是哪个文件，模型无从对照");
  assert.equal(deliveryLine({ _writeLedger: [] }), "",
    "没有落空写入时也说话——纯问答的回合会被平白打扰");
  assert.equal(deliveryLine({ _writeLedger: [{ path: "/p/a.ts", ok: true }] }), "",
    "成功的写入被当成落空的报了");
});

test("门拦的写入不许把自己标成「没尝试过」（标了就从台账里消失）", () => {
  const at = SRC.indexOf("const _planFirst = techIssue.startsWith");
  assert.ok(at > 0, "门的分支不见了");
  const gate = SRC.slice(at, at + 600);
  assert.doesNotMatch(gate, /attempted:\s*false/,
    "门拦把结果标成没尝试过——_toolExecutionAttempted 会把它从写盘台账里摘掉，"
    + "于是「已保存」那句话再没有任何事实与之矛盾");
  // 台账的第二个写入点（对所有 item 的那一遍）是门拦唯一能进账的路径。
  // 判据搬进了 src/agent/write-ledger.js 的 writeAttemptEntry，记账时刻也提前到了
  // 每一项结算的那一刻（原来它在「批次中途按停」那条 break 下面 466 行，中途按停
  // = 已落盘的 edit 一条账都没有 = 下一轮模型从头重写）。这里钉两个写入点都还在。
  assert.match(SRC, /if \(_wl\) \{ \(run\._writeLedger = run\._writeLedger \|\| \[\]\)\.push\(_wl\);/,
    "每项结算时的台账写入点没了");
  assert.match(SRC, /if \(_wl2\) \{ \(run\._writeLedger = run\._writeLedger \|\| \[\]\)\.push\(_wl2\);/,
    "那一遍的台账写入点没了——门拦的写入不会留下任何痕迹");
});

// ── ⑥ 给模型看的正文也要分开（这一半才影响它的下一步动作）─────────────
//
// 徽章是给用户看的；tool result 正文是给模型看的。原来两条批次停止门都无条件写着
// 「先读上面那条失败的真实输出 / 先根据前一项真实错误修正方案」——前项是门拦时，
// 那份输出**根本不存在**。模型被指去找一个不存在的东西，找不到就只能猜，一轮白烧。
const PRE_BLOCK = load("_isPreExecutionBlock", {
  _PRE_EXECUTION_BLOCK_CODES: new Set([
    "plan_first", "tech_research", "read_before_edit", "mutation_batch", "command_batch",
  ]),
});
const cmdBatch = load("_commandBatchBlockResult", {
  _toolExecutionSucceeded: (call, res) => !!res && res.ok !== false && res.code !== 1,
  _callIsReadOnlyCommand: (c) => /^(?:which|ls|cat|echo|pwd)\b/.test(String(c.command || "")),
  _isPreExecutionBlock: PRE_BLOCK,
});
const mutBatch = load("_implementationMutationBatchBlockResult", {
  _implementationMutationCandidate: (c) => ["write", "edit", "multiedit"].includes(c?.type)
    || (c?.type === "cmd" && /^chmod\b/.test(String(c.command || ""))),
  _toolExecutionSucceeded: (call, res) => !!res && res.ok !== false && res.code !== 1,
  _isPreExecutionBlock: PRE_BLOCK,
});
const RUN = { mode: "agent" };

test("前项是门拦时，不许叫模型去读一份不存在的失败输出（命令批次）", () => {
  const items = [
    { call: { type: "cmd", command: "npm run build" }, rawResult: { ok: false, failure: { code: "command_batch" } } },
    { call: { type: "cmd", command: "npm test" } },
  ];
  const out = cmdBatch(RUN, items, 1);
  assert.ok(out, "门拦的前项之后不再停止后续命令了——那道门就白设了");
  assert.equal(out.failure.code, "command_batch", "失败码变了，恢复指令会走错分支");
  assert.match(out.content, /\[BLOCKED_COMMAND_BATCH\]/, "标记不能变，别处按它识别");
  assert.match(out.content, /没有产生任何失败输出/,
    "还在叫模型去找失败输出——门拦下的那条根本没跑过");
  assert.doesNotMatch(out.content, /先读上面那条失败的真实输出/,
    "真失败那套指示漏到门拦分支上了");
});

test("前项真跑过并失败时，原来那套指示一个字不变（命令批次）", () => {
  // 反向断言。只钉「门拦分支说了新话」是绿的摆设：把两个分支合并成新话它也绿，
  // 而那会让真失败的回合失去「去读 exit code 和 stderr」这条唯一正确的指示。
  const items = [
    { call: { type: "cmd", command: "npm run build" }, rawResult: { ok: false, code: 1, content: "npm ERR! build failed" } },
    { call: { type: "cmd", command: "npm test" } },
  ];
  const out = cmdBatch(RUN, items, 1);
  assert.ok(out);
  assert.match(out.content, /先读上面那条失败的真实输出/, "真失败的指示被冲掉了");
  assert.match(out.content, /npm run build/, "要指名道姓是哪条挂了");
  assert.doesNotMatch(out.content, /没有产生任何失败输出/, "真失败被说成了门拦");
});

test("写入批次同理，而且要说清是哪道门", () => {
  const blocked = (code) => [
    { call: { type: "edit", path: "README.md" }, rawResult: { ok: false, failure: { code } } },
    { call: { type: "cmd", command: "chmod +x examples/*.sh" } },
  ];
  const planFirst = mutBatch(RUN, blocked("plan_first"), 1);
  assert.ok(planFirst, "门拦的前项之后不再停止后续写入了");
  assert.equal(planFirst.failure.code, "mutation_batch");
  assert.match(planFirst.content, /\[BLOCKED_MUTATION_BATCH\]/);
  assert.match(planFirst.content, /计划门/, "没说清是哪道门，模型不知道该去补哪一步");
  assert.match(planFirst.content, /没有产生任何失败输出/);
  assert.doesNotMatch(planFirst.content, /前一项真实错误/, "真失败那套话漏过来了");

  const techFirst = mutBatch(RUN, blocked("tech_research"), 1);
  assert.match(techFirst.content, /依赖调研门/, "两道门给了同一句话——又合流了");

  // 真失败：原文一个字不变
  const real = mutBatch(RUN, [
    { call: { type: "write", path: "a.ts" }, rawResult: { ok: false, code: 1, content: "EACCES" } },
    { call: { type: "write", path: "b.ts" } },
  ], 1);
  assert.match(real.content, /先根据前一项真实错误修正方案/, "真失败的指示被冲掉了");
  assert.doesNotMatch(real.content, /没有产生任何失败输出/);
});

test("留住肇事前项用的是 find 不是 some（否则说不出是哪道门）", () => {
  const src = fnSource("_implementationMutationBatchBlockResult", { code: true });
  assert.match(src, /const priorFailed = previous\.find\(/,
    "换回 some 了——拿不到肇事项，就只能说一句笼统的话");
  assert.match(src, /item\.rawResult\.mutated !== false/,
    "幂等空操作的豁免没了——[create_dir 已存在, write_file] 会被当成前项失败硬拦");
});

// ── ⑦ 计划门不该武装在写文档上 ────────────────────────────────────────
//
// _planBeforeBuildIssue 是全系统**唯一一道硬拦回合**的门，而且「一个 run 只拦一次」
// （run._planStopUsed）。它的 docstring 写着「改已有代码一概不拦」，可判据里对
// fileEditTypes() 一律放行进门、没有任何路径过滤——于是 edit_file(README.md) 反倒成了
// 它最容易触发的形态。
//
// 真损失不是误拦本身（那只白烧一轮），是**那一次配额被用掉了**：真正需要拦的那次从零
// 动工就再也拦不住。同胞取证门 _implementationMutationGroundingIssue 在同一件事上早就
// 写了排除（注释原话「写 README/素材不拦」），计划门漏了这一条。
const planGate = load("_planBeforeBuildIssue", {
  _implementationGroundingCandidate: () => true,
  _introducesNewTech: () => false,
  fileEditTypes: () => new Set(["write", "edit", "multiedit", "format"]),
  _implementationGroundingFilePath: load("_implementationGroundingFilePath"),
});
const zeroRun = { mode: "agent", engineering: { projectScope: true, intentSource: "ai" }, _planSteps: [] };

test("写文档/素材不再武装那道唯一的硬拦门", () => {
  for (const path of ["README.md", "DEMO.md", "docs/guide.md", "demo.txt", "demo-output.txt", "notes.rst"]) {
    assert.equal(planGate(zeroRun, { type: "edit", path }), "",
      `${path} 仍然武装了硬拦门——那一个 run 只有一次的配额会被一次写文档用掉`);
  }
});

test("真该拦的一个都没漏（反向断言，否则上面那条是绿的摆设）", () => {
  // 只钉「文档不拦」是摆设：把整道门 return "" 它也绿。
  for (const path of ["src/app.ts", "src/main.py", "examples/auto-edit.sh", "package.json",
    "Cargo.toml", "index.html", "styles/app.css", "vite.config.ts"]) {
    assert.ok(planGate(zeroRun, { type: "write", path }),
      `${path} 不拦了——这道门被拆松了，不是收窄`);
  }
  // 判据必须和取证门同源，不许另立一份名单（两份必然漂开）
  const src = fnSource("_planBeforeBuildIssue", { code: true });
  assert.match(src, /_implementationGroundingFilePath\(call\?\.path\)/,
    "另写了一份路径名单——它和取证门那份必然漂开，且漂开时没有任何报错");
});

test("门拦的正文要当场堵住「已保存」那句话", () => {
  const blocked = planGate(zeroRun, { type: "write", path: "src/app.ts" });
  assert.match(blocked, /\[BLOCKED_PLAN_FIRST\]/, "标记不能变");
  assert.match(blocked, /这次调用没有执行，磁盘一个字节都没改/,
    "没当场说清这次没写成——模型会照着说「已更新」（用户现场实拍：文件 17 分钟后才第一次被写入）");
  assert.match(blocked, /原样重发/, "没说清补完之后该怎么办，模型只能猜");
  const techGate = load("_newTechResearchIssue", {
    _introducesNewTech: () => true,
    _addedPackageNames: () => [],
  });
  const tech = techGate({ mode: "agent", _toolTypesUsed: [], _researchQueries: [] }, { type: "write", path: "package.json", content: "{}" });
  assert.match(tech, /这次调用没有执行，磁盘一个字节都没改/, "调研门漏了同一句");
});

// ── ⑧ 三道门的恢复指令不再落 generic 兜底 ─────────────────────────────
test("plan_first / tech_research / command_batch 各有确定的下一步", () => {
  // generic 兜底那支引用 _CAPABILITY_ROUTES；下面的反向用例会走到它，不注入就是 ReferenceError。
  const recover = load("_blockedToolRecoveryInstruction", { _CAPABILITY_ROUTES: "（能力路由清单）" });
  for (const [code, want] of [
    ["plan_first", /update_plan/],
    ["tech_research", /package_search/],
    ["command_batch", /前提/],
  ]) {
    const r = recover("[BLOCKED] x", { type: "write", path: "a.ts" }, { failure: { code } });
    assert.ok(r, `${code} 没有恢复指令`);
    assert.equal(r.kind, code, `${code} 的 kind 变了，别处按它识别`);
    assert.match(r.text, want, `${code} 落到了 generic 兜底——模型拿到的是泛泛的「先判断真实原因」`);
  }
  // 反向：真正未知的码仍要走兜底，不许被这三条顺手吞掉
  const unknown = recover("[BLOCKED] x", { type: "write", path: "a.ts" }, { failure: { code: "no_such_code_xyz" } });
  assert.notEqual(unknown?.kind, "plan_first", "未知失败码被错认成了计划门");
});

test("cmd 在写入批次里要有主语", () => {
  const out = mutBatch(RUN, [
    { call: { type: "edit", path: "README.md" }, rawResult: { ok: false, failure: { code: "plan_first" } } },
    { call: { type: "cmd", command: "chmod +x examples/*.sh" } },
  ], 1);
  assert.equal(out.path, "chmod +x examples/*.sh",
    "cmd 没有 path，此前这里落空串——卡片上就是一条没有主语的记录");
});

// ── ⑨ 知识检索的超时必须对齐它自己那个端点 ─────────────────────────────
//
// 用户现场那三张红色「无可用命中」既不是零命中、也不是网关报错，是**客户端 9 秒超时把请求
// 掐了**：_searchKnowledgeBase 调 _fetchWithTimeout 时没传第三个参数，吃了默认 9000ms。
// 而非设计域的 knowledge_search 在网关侧要并上 code_corpus 那条腿（295 万行表上的多词
// OR-tsquery + 两次 ts_rank）。实测：michael-design 1.79s，ui-ux 9.00s，7 路并发下
// 4.67 / 8.01 / 9.07 / 14.34 秒。网关那边每条都有 6 段命中在等着——零命中一次都没发生过。
test("knowledge_search 不许吃 9 秒默认超时", () => {
  const fn = fnSource("_searchKnowledgeBase", { code: true });
  const m = fn.match(/api\/knowledge\/search`[\s\S]{0,400}?\}, (\d[\d_]*)\)/);
  assert.ok(m, "knowledge/search 的 fetch 又没传超时了——它会吃 9 秒默认值，"
    + "而这个端点在非设计域上实测中位数就 7~9 秒，慢的那几条 14.3 秒");
  const ms = Number(String(m[1]).replace(/_/g, ""));
  assert.ok(ms >= 20_000, `超时给了 ${ms}ms，低于实测最慢那条（14.3s）的安全余量`);
  assert.ok(ms <= 60_000, `超时给了 ${ms}ms，真挂掉时用户要干等这么久`);
});

test("默认值本身没被顺手调大（那会影响所有别的调用）", () => {
  // 反向断言。把 _fetchWithTimeout 的默认值从 9000 改成 30000 也能让上面那条过，
  // 但那是把整个 app 的每一次带超时的请求都放宽——治标且波及面极大。
  assert.match(SRC, /async function _fetchWithTimeout\(url, options = \{\}, timeoutMs = 9000\)/,
    "改的是默认值而不是这一个调用点——所有别的请求跟着一起被放宽了");
});

test("晚到的域小抄仍有消费点（所以不必为它加长用户等待）", () => {
  // 修完超时后这几条要 4.4~14.3 秒才回，而预检的等待预算是 6 秒。
  // 之所以不必把预算调大：循环边界上有消费点，晚到的那份会在下一步被注入，
  // 用户不用干等。这条钉住那个前提——它一旦没了，超时改大就变成纯粹的延迟。
  const loop = fnSource("_runAgenticLoop", { code: true });
  const hits = (loop.match(/_consumeDomainKnowledgePreflight\(\)/g) || []).length;
  assert.ok(hits >= 2,
    `循环里只有 ${hits} 个消费点：晚到的域小抄将被丢弃，那超时改大就只剩延迟没有收益`);
});

// ── ⑩ 域小抄不该把散文查询发给代码语料库 ───────────────────────────────
//
// 那四条 rubric 问的是「适用条件 / 硬性约束 / 常见坑 / 必须做的检查」，答案在 893 段手写
// 语料里。带上语料腿的代价与回报实测（2026-08-23 生产库，295 万行 code_corpus）：
//   · 12 个 OR 词 → 匹配 124,042 行 → 每行两次 ts_rank + 全排序 → 单条 2.8~8.5 秒
//   · 捞回来的前六条：metagit-cli「Pattern categories」、两条重复的 next-pwa「Tips」、
//     selenium-devtools「Reference」——对「ui-ux 常见坑」一条都不沾边
//   · 对照：标识符查询 useEffect 匹配 353 行、28 毫秒
// 一轮 4 条 × 最多 2 个域 = 8 条这样的重查询，正是那三张红卡超时的成因。
//
// 判别不能用超时：实测「zustand create store selector」这种**有用**的多词技术查询要 3.5 秒，
// 比散文查询还慢，按时长切会误伤真内容。只有调用方知道自己问的是散文小抄还是 API 核对。
test("域小抄预检声明不要代码语料腿", () => {
  const pre = fnSource("_runDomainKnowledgePreflight", { code: true });
  assert.match(pre, /corpus: false/,
    "域小抄又把 rubric 散文查询发给 295 万行签名表了——一轮 8 条重查询，且回来的是噪声");
  assert.match(pre, /topK: 4/, "topK 变了，代价估算要重算");
});

test("模型自己调 knowledge_search 时那条腿照旧（反向断言）", () => {
  // 只钉「域小抄关掉了」是绿的摆设：把开关写死成恒 false 它也绿，
  // 而那会把「写第三方调用之前核对真实 API」唯一够得着的事实源整个关掉。
  const fn = fnSource("_searchKnowledgeBase", { code: true });
  assert.match(fn, /corpus: call\.corpus === false \? false : undefined/,
    "开关不是按调用方声明转发的——要么恒开要么恒关，两种都错");
  assert.doesNotMatch(fn, /corpus: false[,\s]/,
    "_searchKnowledgeBase 里写死了 corpus:false——所有 knowledge_search 都会丢掉语料腿");
  // michael-design 预检不传这个开关（网关侧本来就对该域关着，客户端不必重复判）
  const md = fnSource("_runMichaelDesignPreflight", { code: true });
  assert.doesNotMatch(md, /corpus:/,
    "michael-design 预检也去传这个开关了——那是两处判据，会漂");
});
