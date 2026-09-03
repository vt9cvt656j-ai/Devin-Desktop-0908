// ── 弱模型韧性（sp.json weak-models 第 5/6/7/8 条）────────────────────────────
//
// 贯穿性的病根：这套系统里防糊弄的机制大多要先让模型答出一份结构化 JSON，再按答案
// 开门。弱模型既答不出，门就全松。这里的四条修复全都不要求模型多声明任何东西：
//   5. _isWeakModel 从模型名正则改成执行事实账本（每模型大表 JSON 成/败/零字节）；
//   6. 收尾评审拆两问（3 字段核心半 + findings/direction/tools 观察半），null 不再静默；
//   7. 验证提醒带预填 run_cmd 候选——命令由代码算好，模型空参数调用即点头，IDE 不代跑；
//   8. 盲写事前拦截——没读过 + 行数骤减的整文件覆写不落盘，失败结果带当前真实内容。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SRC, CODE, fnSource, load, loadConst } from "./helpers/source.mjs";

// ===========================================================================
// 第 5 条：每模型能力账本
// ===========================================================================

test("模型能力账本：大表回执足量后覆盖名称初值，小表回执不稀释", () => {
  let store = {};
  const capLoad = () => store;
  const capSave = (c) => { store = c; };
  const record = load("_recordModelJsonOutcome", {
    _modelCapLoad: capLoad, _modelCapSave: capSave, _MODEL_CAP_RING: 20,
  });
  const isWeak = load("_isWeakModel", {
    _modelCapLoad: capLoad, _MODEL_CAP_MIN_SAMPLES: 4, _MODEL_CAP_RING: 20,
  });

  // 名称初值（无回执时）：旧正则的两处实测误判照旧存在——这正是账本要覆盖的对象。
  assert.equal(isWeak("stealth/ox-alpha"), false, "实测唯一的弱模型被名称正则判为强");
  assert.equal(isWeak("gemini-2.0-flash"), true, "能力充足的模型被名称正则判为弱");

  // 执行事实覆盖初值：大表 JSON 连续产不出 → 判弱。
  for (const o of ["fail", "empty", "fail", "fail"]) record("stealth/ox-alpha", "big", o);
  assert.equal(isWeak("stealth/ox-alpha"), true, "有真实回执后必须以回执为准");

  // 反向：名称像弱、大表实测全成 → 判强（大小写归一）。
  for (let i = 0; i < 4; i++) record("Gemini-2.0-Flash", "big", "ok");
  assert.equal(isWeak("gemini-2.0-flash"), false, "回执为准，正则只是首见初值");

  // 小表回执不进大表判据：弱模型的实测特征正是「小 JSON 行、大 JSON 产不出」。
  store = {};
  for (let i = 0; i < 8; i++) record("some-model", "small", "fail");
  assert.equal(isWeak("some-model"), false, "小 JSON 成败不得稀释大表判据");

  // 样本不足（<4）仍用名称初值。
  store = {};
  record("gpt-4o-mini", "big", "ok");
  record("gpt-4o-mini", "big", "ok");
  assert.equal(isWeak("gpt-4o-mini"), true, "回执不足时保留名称初值");

  // 失败率恰 50%（2/4）落在弱侧：这道门只用来收敛工具窗口，保守侧代价小。
  store = {};
  for (const o of ["ok", "ok", "fail", "empty"]) record("m3", "big", o);
  assert.equal(isWeak("m3"), true);

  // 滚动上界：账本不无限增长。
  store = {};
  for (let i = 0; i < 50; i++) record("m2", "big", "ok");
  assert.equal(store["m2"].big.length, 20);

  // 新桶名必须真的落进它自己的抽屉。写侧的桶名白名单漏一个，记录会静默掉进 small 桶，
  // 读侧永远看不到——账本看着在记，判据却一直饿着（源码断言量不到这一层）。
  for (let i = 0; i < 6; i++) record("m3", "big_eng", "fail");
  record("m3", "big_sem", "ok");
  assert.equal(store["m3"].big_eng?.length, 6, "big_eng 没落进自己的抽屉");
  assert.equal(store["m3"].big_sem?.length, 1, "big_sem 没落进自己的抽屉");
  assert.equal(isWeak("m3"), true, "工程半连续 fail，却没被判成弱模型");
  // 反向：语义半再好也不改变结论——产得出小的不代表扛得住大表。
  for (let i = 0; i < 20; i++) record("m3", "big_sem", "ok");
  assert.equal(isWeak("m3"), true, "语义半的成绩把工程半的结论盖过去了");

  // 畸形输入不抛。
  record("", "big", "ok");
  record(null, "big", "ok");
  assert.equal(isWeak(""), false);
  assert.equal(isWeak(null), false);
});

test("账本的三个事实源都真的在记：意图裁决、快通道、收尾评审两半", () => {
  const fast = fnSource("_fastRoutingFlags", { code: true });
  assert.match(fast, /_recordModelJsonOutcome\(cfg\.model, "small"/,
    "快通道的回执没进账——账本会一直饿着");
  const intent = fnSource("_aiIntentProfile", { code: true });
  // 桶名从一个 "big" 拆成 big_sem / big_eng：同一个桶里记两半，结构上就分不出是哪一半
  // 失败——而弱模型最常见的形状恰恰是「语义半到、工程半空」，两半的修法完全不同。
  assert.match(intent, /_recordModelJsonOutcome\(intentConfig\.model, "big_sem"/,
    "意图裁决语义半的回执没进账");
  assert.match(intent, /_recordModelJsonOutcome\(intentConfig\.model, "big_eng"/,
    "意图裁决工程半（16 枚举 + 4 数组，弱模型最常出不来的那半）的回执没进账");
  // 判据必须是「这一半被 normalize 接住了」，不是「解析器抠到了东西」——后者比 normalize
  // 早一行，数组和落错层的字段都会被记成 ok，方向正好是高估模型能力。
  assert.match(intent, /_halves\?\.semantic === true/, "语义半的判据没挪到 normalize 之后");
  assert.match(intent, /_halves\?\.engineering === true/, "工程半的判据没挪到 normalize 之后");
  const critic = fnSource("_wrapUpCritic", { code: true });
  assert.match(critic, /_recordModelJsonOutcome\(reviewModel, "small"/,
    "评审核心半的回执没进账");
  assert.match(critic, /_recordModelJsonOutcome\(reviewModel, "big"/,
    "评审观察半（findings 嵌套数组）的回执没进账");
  // 消费点仍在：弱模型工具窗口收敛。
  assert.match(CODE, /_isWeakModel\(config\?\.model\)/);
  // 账本用全局键、不吃 root 路径参数（_recordEpisode 的 root 参数踩过传错的坑）。
  const rec = fnSource("_recordModelJsonOutcome", { code: true });
  assert.doesNotMatch(rec, /\broot\b/, "模型能力是整机事实，不该按工作区分抽屉");
  // 判据读的是执行事实账本，且回执不足时才落名称启发。
  const weak = fnSource("_isWeakModel", { code: true });
  assert.match(weak, /_MODEL_CAP_MIN_SAMPLES/);
  assert.match(weak, /bad \* 2 >= recent\.length/, "失败率判据没了");
  // 读侧必须指向**工程半**：那才是「产不产得出大表」的判据。语义半是小的，产得出并不
  // 说明它扛得住大表。旧的 "big" 桶要一起算，否则升级当天账被清空，而空账退回名称初值
  // ——那个初值把 stealth/ox-alpha 判成**强**。
  assert.match(weak, /caps\.big_eng/, "读侧还在读旧桶——新记录进不了判据");
  assert.match(weak, /caps\.big\b/, "旧记录被丢了：升级当天这本账会清空");
});

// ===========================================================================
// 第 6 条：收尾评审拆问 + null 兜底
// ===========================================================================

const _mkCritic = (responder, calls = []) => load("_wrapUpCritic", {
  // 预算同源改造后新增的真实依赖：普通模型 2000（核心半外推为 400）。
  _criticMaxTokens: () => 2000,
  _cognitiveLegDeadlineMs: () => 60_000,
  _cognitiveLegEffort: () => ({}),
  _executionEvidenceReviewBlock: () => "",
  _criticToolCatalog: () => [],
  _criticRequestedToolSchemas: (names) => (Array.isArray(names) ? names : [])
    .filter((n) => n === "run_cmd").map((n) => ({ function: { name: n } })),
  _chatCompletionsUrl: () => "https://x/v1/chat/completions",
  _safeJsonLoose: (t) => { try { return JSON.parse(t); } catch { return null; } },
  _recordModelJsonOutcome: (...a) => calls.push(a),
  // 收尾评审改走 _cognitiveLegComplete：请求体从第三个参数挪到第二个。
  _cognitiveLegComplete: async (_cfg, payload) => responder(payload),
});
const _CRITIC_CFG = { baseUrl: "https://x", apiKey: "k", model: "m" };
// 两半靠系统提示词区分：观察半带 findings 规则与工具目录，核心半没有。
const _isAuxPayload = (p) => /findings/.test(p.messages[0].content);

test("收尾评审拆问：核心半到手、观察半失败 → done/verified 照常，findings 按缺省", async () => {
  const calls = [];
  const critic = _mkCritic((p) => _isAuxPayload(p)
    ? "这不是 JSON"
    : '{"done":false,"verified":false,"instruction":"补上登录分支"}', calls);
  const v = await critic({ config: _CRITIC_CFG, task: "t", toolRegistry: {} });
  assert.equal(v.done, false);
  assert.equal(v.verified, false);
  assert.equal(v.instruction, "补上登录分支");
  assert.deepEqual(v.findings, []);
  assert.equal(v.direction, "");
  // 回执进账：核心半 small=ok、观察半 big=fail。
  assert.ok(calls.some((c) => c[0] === "m" && c[1] === "small" && c[2] === "ok"));
  assert.ok(calls.some((c) => c[0] === "m" && c[1] === "big" && c[2] === "fail"));
});

test("收尾评审拆问：核心半失败、观察半到手 → findings 不再整份丢弃，done 保持缺席", async () => {
  const critic = _mkCritic((p) => _isAuxPayload(p)
    ? '{"findings":[{"where":"a.js:1","what":"硬编码密钥","why":"会泄漏"}],"direction":"你要的是整条链路","tools":["run_cmd","ghost"]}'
    : "垃圾");
  const v = await critic({ config: _CRITIC_CFG, task: "t", toolRegistry: {} });
  assert.ok(v, "弱模型少产一个布尔时，那几条真实缺陷不许连坐丢弃");
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].what, "硬编码密钥");
  assert.equal(v.direction, "你要的是整条链路");
  assert.deepEqual(v.tools, ["run_cmd"], "未注册工具照旧被过滤");
  assert.ok(!("done" in v), "核心半缺席时 done 不得被编造——所有读者都按 typeof 判布尔");
  assert.ok(!("verified" in v), "verified 同理：缺席不是 false");
});

test("收尾评审拆问：两半都失败 → null；零字节按 empty 进账", async () => {
  const calls = [];
  const critic = _mkCritic(() => "", calls);
  assert.equal(await critic({ config: _CRITIC_CFG, task: "t", toolRegistry: {} }), null);
  assert.ok(calls.some((c) => c[1] === "small" && c[2] === "empty"));
  assert.ok(calls.some((c) => c[1] === "big" && c[2] === "empty"));
});

test("评审 null 不再静默：调用点记账，收尾退到代码算好的执行事实，且有用户出口", () => {
  // 调用点：null / 抛异常都记「这轮没评审过」。
  const at = CODE.indexOf("await _wrapUpCritic({");
  assert.ok(at > 0);
  // 窗口 2600 → 3600：评审 2026-09-02 改成并发（正文写完就收尾，不等这次付费调用），
  // 多出的注释把外层 catch 顶到了 2910。固定窗口是这条断言的已知弱点。
  const site = CODE.slice(at, at + 3600);
  assert.match(site, /else run\._wrapUpReviewFailed = \(run\._wrapUpReviewFailed \|\| 0\) \+ 1;/,
    "null 又被静默吞了——用户分不清「评审通过」和「评审压根没跑成」");
  assert.match(site, /catch \{ run\._wrapUpReviewFailed = \(run\._wrapUpReviewFailed \|\| 0\) \+ 1;/,
    "异常路径也要记同一笔账");
  // 并发之后 reject 不再落进外层 try/catch：那条路必须自己接住并记同一笔账，
  // 否则既漏账、又会变成一条用户看得见的 "Unhandled:" 红字。
  assert.match(site, /\)\(\)\.catch\(\(\) => \{ run\._wrapUpReviewFailed = \(run\._wrapUpReviewFailed \|\| 0\) \+ 1;/,
    "并发的评审没接住 reject——漏账，且会弹一条用户看得见的报错");

  // 落盘兜底真的跑一遍（和 logic.test.mjs 同一套抠法：三个闭包变量）。
  const expr = /wrapUp: (\(\(\) => \{[\s\S]*?\}\)\(\)),/.exec(SRC);
  assert.ok(expr, "落盘那一步不见了");
  const persist = new Function("run", "verificationPassed", "didMutate", `return ${expr[1]};`);
  // 没发起过评审 → null（纯问答轮不受打扰，老行为不变）。
  assert.equal(persist({ _wrapUpVerdict: null }, true, true), null);
  // 发起了、整份 null、这轮改过代码 → 代码事实兜底（执行记录，不是模型意见）。
  const fb = persist(
    { _wrapUpVerdict: null, _wrapUpReviewFailed: 1, _incompleteReason: "code_delivered_unverified" },
    false, true,
  );
  assert.equal(fb.reviewUnavailable, true);
  assert.equal(fb.codeUnverified, true, "「改了源码、零验证证据」这条已算好的事实必须进卡片");
  assert.equal(fb.codeVerified, false);
  assert.equal(fb.instruction, "", "兜底不许编造评审指令");
  assert.deepEqual(fb.findings, []);
  // 验证记账通过时兜底照样出声：没有人复核 diff 这件事本身要让用户看见。
  const fb2 = persist({ _wrapUpVerdict: null, _wrapUpReviewFailed: 1 }, true, true);
  assert.equal(fb2.reviewUnavailable, true);
  assert.equal(fb2.codeVerified, true);
  // 没改过东西 → 不打扰。
  assert.equal(persist({ _wrapUpVerdict: null, _wrapUpReviewFailed: 1 }, true, false), null);

  // 用户出口：建议卡。
  const gen = load("_runStateNextActionSuggestions", {
    _INCOMPLETE_LABELS: loadConst("_INCOMPLETE_LABELS"),
    _projectStacks: new Map(),
  });
  const mkChips = (wrapUp) => gen({ _lastRunState: {
    outcome: "success", task: "x", updatedAt: Date.now(), wrapUp,
  } });
  const chips = mkChips({ reviewUnavailable: true, codeVerified: false, codeUnverified: true,
    instruction: "", direction: "", findings: [], falseGreen: false });
  const chip = chips.find((c) => /评审没跑成/.test(c.label));
  assert.ok(chip, "评审缺席没有用户出口——静默丢弃换了个地方继续静默");
  assert.match(chip.send, /没有任何验证证据/, "卡片要带上代码算好的那条执行事实");
  const chips2 = mkChips({ reviewUnavailable: true, codeVerified: true, codeUnverified: false,
    instruction: "", direction: "", findings: [], falseGreen: false });
  const chip2 = chips2.find((c) => /评审没跑成/.test(c.label));
  assert.ok(chip2);
  assert.match(chip2.send, /验证命令退出 0/);
  // 评审正常跑成的轮不冒这张卡。
  assert.ok(!mkChips({ instruction: "", direction: "", findings: [], falseGreen: false })
    .some((c) => /评审没跑成/.test(c.label)));
});

// ===========================================================================
// 第 7 条：验证候选——预填参数，模型点头
// ===========================================================================

test("验证提醒带预填 run_cmd 候选：命令由代码算好，空参数调用即点头，IDE 不代跑", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  // 锚点换了（2026-09-02）：verifyNow 不再单独推一条 nudge，文本追加到本轮那条
  // [本轮交付事实] 上了。**预填候选那半是机制不是文本**，原样留在原处 —— 这条断言守的
  // 就是它还在，所以只换锚点，窗口和断言都不动。
  const at = loop.indexOf("[未验证] 刚改了");
  assert.ok(at > 0, "验证事实的文本不见了 —— 这条断言的锚点没了");
  const armWindow = loop.slice(Math.max(0, at - 2000), at);
  assert.match(armWindow, /run\._verifyCandidate = \{ command: _cmd, cwd: root \}/,
    "候选没武装——「预填好参数」就无从发生，提醒退化回劝诫");

  // 代填器：空命令 + 有候选 → 填入并一次性消费。
  const fill = load("_verifyCandidateFill");
  const run = { _verifyCandidate: { command: "npm test", cwd: "/w" } };
  const call = { type: "cmd", command: "" };
  assert.equal(fill(run, call), "npm test");
  assert.equal(call.command, "npm test");
  assert.equal(call.purpose, "verify", "不声明 purpose=verify 拿不到验证学分");
  assert.equal(run._verifyCandidate, null, "候选必须一次性消费，陈旧候选不许常驻");

  // 模型自己带了命令 → 一个字不动，也不消耗候选。
  const c2 = { type: "cmd", command: "ls" };
  const r2 = { _verifyCandidate: { command: "npm test", cwd: "/w" } };
  assert.equal(fill(r2, c2), null);
  assert.equal(c2.command, "ls");
  assert.ok(r2._verifyCandidate, "带命令的调用不消耗候选");

  // 没候选的空命令照旧走原报错路径；非 cmd 不碰。
  assert.equal(fill({}, { type: "cmd", command: "" }), null);
  assert.equal(fill(null, { type: "cmd", command: "" }), null);
  assert.equal(fill({ _verifyCandidate: { command: "npm test" } }, { type: "write", path: "a" }), null);

  // 模型已声明的 purpose 不被覆盖。
  const c3 = { type: "cmd", command: "", purpose: "run" };
  fill({ _verifyCandidate: { command: "npm test" } }, c3);
  assert.equal(c3.purpose, "run");

  // 接入点必须在唯一授权检查点之前：确认框里给用户看的得是真实命令，不是空串。
  const wrapper = fnSource("_executeToolStep", { code: true });
  const fillAt = wrapper.indexOf("_verifyCandidateFill(run, call)");
  const approveAt = wrapper.indexOf("_approveToolCall(call, run)");
  assert.ok(fillAt > 0 && approveAt > 0 && fillAt < approveAt,
    "代填要发生在授权检查之前，否则用户批的是一条空命令");

  // 那句零调用点的死劝诫已删：机制取代祈使句。
  assert.doesNotMatch(CODE, /_CODE_VERIFY_NUDGE/,
    "死劝诫又回来了——要么接上要么删掉，别留一句没人推送的话");

  // 红线仍在：发起方永远是模型，IDE 不代跑（与 logic.test.mjs 那两条禁令同向）。
  assert.doesNotMatch(loop, /_runApprovedVerification\(/);
});

// ===========================================================================
// 第 8 条：盲写事前拦截
// ===========================================================================

const _mkBlindGate = (records = [], over = {}) => load("_blindOverwritePrecheck", {
  _runHasCurrentRead: () => false,
  _writeGateBypass: load("_writeGateBypass"),
  _readCoverageImpossible: load("_readCoverageImpossible", { _READ_SLICE_CHAR_CAP: 55000 }),
  _redactSecrets: (t) => t,
  _runRedactionMap: () => new Map(),
  _recordRunKnownContent: (...a) => { records.push(["known", ...a]); return true; },
  _recordRunRedactedRead: (...a) => { records.push(["redacted", ...a]); },
  _contentSignature: () => "sig",
  _readBeforeEditCoverageHint: () => "下一步先 read_file(offset=1, limit=…) 完整读取当前版本",
  _READ_SLICE_CHAR_CAP: 55000,
  ...over,
});

test("盲写事前拦截：没读过 + 行数骤减 → 不落盘，失败结果带当前真实内容并记账", () => {
  const records = [];
  const gate = _mkBlindGate(records);
  const old = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  const call = { type: "write", path: "a.js", content: "short\n" };
  const blocked = gate({}, "/w", call, "/w/a.js", old, false);
  assert.ok(blocked, "三判据齐（已存在/没读过/骤减）必须在落盘前拦下");
  assert.match(blocked.content, /^\[BLOCKED\]/);
  assert.equal(blocked.recoverable, true);
  assert.match(blocked.content, /现有 100 行/, "行数事实要摆出来");
  assert.match(blocked.content, /line42/, "失败结果必须带当前磁盘真实内容——拦下不是死胡同");
  assert.ok(records.some((r) => r[0] === "known"),
    "回带的内容要按 read_file 同一套记账，下一轮的合法重写才有通路");
  assert.ok(records.some((r) => r[0] === "redacted"), "打码状态也要同步记账，写回还原才走得通");
});

test("盲写事前拦截：不误伤——读过、小文件、非 write 都放行；但缩不缩水一律拦", () => {
  const gate = _mkBlindGate();
  const old = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  const shrink = { type: "write", path: "a.js", content: "short\n" };
  // 读过当前版本 → 放行（合法整文件重写、有意大幅删减都走这条）。
  const gateRead = _mkBlindGate([], { _runHasCurrentRead: () => true });
  assert.equal(gateRead({}, "/w", shrink, "/w/a.js", old, false), null);
  // 小文件（<40 行）→ 放行：整份都摆在 diff 里，用户一眼能看见。
  assert.equal(gate({}, "/w", shrink, "/w/a.js", "a\nb\nc", false), null);
  // 非 write 不碰。
  assert.equal(gate({}, "/w", { type: "edit", path: "a.js" }, "/w/a.js", old, false), null);
  assert.equal(gate(null, "/w", shrink, "/w/a.js", old, false), null);

  // ── 缩幅判据 2026-09-02 拆掉了 ──
  // 原判据是「没读过 **且** 缩掉一半」，于是恰好放过最难发现的那一种：拿记忆里的
  // 480 行整份换掉磁盘上的 500 行，破坏一样大，但从行数上看不出来，工具结果只报「已修改」。
  // Claude Code 的规则本来就只有一条：没读过就不许覆写已有文件。
  const sixty = Array.from({ length: 60 }, () => "x").join("\n");
  const forty = { type: "write", path: "a.js", content: Array.from({ length: 40 }, () => "y").join("\n") };
  const mild = gate({}, "/w", forty, "/w/a.js", sixty, false);
  assert.ok(mild, "缩幅不足一半也是没读过就覆写，一样要拦");
  const grown = { type: "write", path: "a.js", content: Array.from({ length: 80 }, () => "y").join("\n") };
  const bigger = gate({}, "/w", grown, "/w/a.js", sixty, false);
  assert.ok(bigger, "写得比原文还长照样是拿记忆换掉磁盘");
  assert.match(bigger.content, /凭记忆整份覆写/, "非缩水那一路要有自己的说法，不能沿用「差额会被静默删掉」");
  assert.match(mild.content, /差额会被静默删掉/, "缩水那一路仍然说差额");
});

test("盲写事前拦截：_writeGateBypass 的两条豁免从死代码接活", () => {
  const gate = _mkBlindGate();
  const old = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  // 打码写回：模型读过打码副本，content 带占位符 → 放行（它确实持有当前版本证据）。
  const redactedCall = { type: "write", path: "a.js", content: "key = [REDACTED_API_KEY]\n" };
  assert.equal(gate({}, "/w", redactedCall, "/w/a.js", old, true), null);
  // 但打码读不豁免不带占位符的覆写。
  const plainCall = { type: "write", path: "a.js", content: "short\n" };
  assert.ok(gate({}, "/w", plainCall, "/w/a.js", old, true));
  // 超长单行（压缩产物）：读覆盖机械不可能 → 放行，CAS+Undo 仍在。
  const minified = ["x".repeat(60000)].concat(Array.from({ length: 50 }, () => "y")).join("\n");
  assert.equal(gate({}, "/w", plainCall, "/w/a.js", minified, false), null);
});

test("盲写事前拦截：大文件不附全文，改带精确补读指令与结构化失败码", () => {
  const gate = _mkBlindGate();
  const huge = Array.from({ length: 3000 }, (_, i) => `${"x".repeat(30)}-${i}`).join("\n");
  const blocked = gate({}, "/w", { type: "write", path: "a.js", content: "short\n" }, "/w/a.js", huge, false);
  assert.ok(blocked);
  assert.equal(blocked.failure?.code, "read_before_edit",
    "大文件分支要复用 read_before_edit 那族恢复指令（write → retry_complete_write_existing）");
  assert.ok(blocked.content.length < 5000, "大文件不许把全文塞进失败结果");
  assert.match(blocked.content, /read_file\(offset=1, limit=/, "要带上覆盖提示的精确补读指令");
});

test("盲写事前拦截：带回模型的内容必须先打码，真实密钥不出机", () => {
  const gate = _mkBlindGate([], {
    _redactSecrets: (t) => t.replace(/SECRETTOKEN/g, "[REDACTED_API_KEY#1]"),
  });
  const oldSec = Array.from({ length: 60 }, () => "line").join("\n") + "\nkey = SECRETTOKEN\n";
  const blocked = gate({}, "/w", { type: "write", path: "a.js", content: "short\n" }, "/w/a.js", oldSec, false);
  assert.ok(blocked);
  assert.doesNotMatch(blocked.content, /SECRETTOKEN/, "真实密钥跟着失败结果泄给模型了");
  assert.match(blocked.content, /已对你打码/);
});

test("盲写事前拦截接在写入执行器里、落盘之前；事后 linesLost 记账原样保留", () => {
  const inner = fnSource("_executeToolStepInner", { code: true });
  // 锚定完整形状：调用直接赋给 _blindBlock（不许被 `x && …` 之类短路架空），
  // 且拦下时把结果原样 return（真的阻断这次落盘）。
  assert.match(inner,
    /const _blindBlock = _blindOverwritePrecheck\(run, root, call, fp, old, redactedRead\);[\s\S]{0,400}?if \(_blindBlock\) \{[\s\S]{0,300}?return _blindBlock;/,
    "helper 没接进执行器（或接了但不 return）——判据齐了也拦不住任何一次落盘");
  const at = inner.indexOf("const _blindBlock = _blindOverwritePrecheck(");
  const writeAt = inner.indexOf("writeTextFileIfUnchanged(fp, existed ? old : null, newContent)");
  assert.ok(at > 0 && writeAt > at, "拦截必须发生在 CAS 落盘之前，事后才说就是原来的病");
  // 事后那条「只报事实、不拦截」的 linesLost 记账保留：它管的是读过之后的合法重写告知。
  assert.match(CODE, /const _lostLines = existed && _oldLines >= 40 && _newLines < _oldLines \* 0\.5/);
});
