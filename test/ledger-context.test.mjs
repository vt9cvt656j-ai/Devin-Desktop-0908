// 需求账本与开场上下文：三条「测试全绿、功能是死的」。
//
// 1. 折叠开场消息时，保留段按一个已改名的标题找账本——永远找不到，账本整段被切掉。
//    账本压根不在磁盘上，折掉就再也回不来；用户看到的是长 run 前面听话、折叠之后像换了个人。
// 2. 「只发已掉出历史的」差集，两侧空白处理不一致：入账压成单空格，比对拿历史原文。
//    前 40 字里有一个换行（分行写需求、贴报错），这条明明还在对话里也被每轮重列一遍。
// 3. 冷启动首轮：MCP 名录在「等预热 1.5 秒」之前就算完了，等完也不重算——白等。
//
// 这里守的是行为：用源码里真实的装配表达式、真实的保留段、真实的差集判据跑一遍，
// 不手抄任何标题。
import test from "node:test";
import { failedWritePaths as _failedWritePaths } from "../src/agent/write-ledger.js";
import assert from "node:assert/strict";
// 按名字取真源码 / 取顶层常量的值，只有一份实现：test/helpers/source.mjs。
// 这个文件的源码断言历来跑在**原文**上（下面自己剥注释），所以 SRC 绑定 main.js 原文。
import { SRC, fnSource as extractFn, loadConst, load } from "./helpers/source.mjs";
import { repairToolPairing } from "../src/agent/tool-pairing.js";

// 注释里会引用被修掉的旧代码，所以凡是对源码文本的断言都先剥注释。按上下文逐字符扫，
// 认得字符串 / 模板串 / 正则字面量（两条正则式的剥法会把 `/\//` 当成行注释吃掉真代码）。
function stripJsComments(source) {
  const s = String(source);
  let out = "", i = 0, prev = "";
  const regexCanStart = (p) => !/[A-Za-z0-9_$)\]]/.test(p);
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; out += c; i++;
      while (i < s.length) {
        const ch = s[i]; out += ch;
        if (ch === "\\") { i++; if (i < s.length) out += s[i]; i++; continue; }
        i++;
        if (ch === q) break;
      }
      prev = q; continue;
    }
    if (c === "/" && regexCanStart(prev)) {
      out += c; i++;
      let inClass = false;
      while (i < s.length) {
        const ch = s[i]; out += ch;
        if (ch === "\\") { i++; if (i < s.length) out += s[i]; i++; continue; }
        i++;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break;
      }
      prev = "/"; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const CODE = stripJsComments(SRC);
const HEAD = loadConst("_DEMAND_LEDGER_HEAD");
const SEND = extractFn("sendPrompt");
const TRIM = extractFn("_trimMessagesIfHuge");
const norm = new Function(`${extractFn("_ledgerNorm")}\n;return _ledgerNorm;`)();
const MODES_WITH_TOOLS = loadConst("_MODES_WITH_TOOLS");

/** 用 sendPrompt 里真实的装配表达式拼出账本块——不手抄标题。 */
function ledgerBlockOf(faded) {
  const expr = /const _demandLedgerBlock = _fadedDemands\.length[\s\S]*?: "";/.exec(SEND);
  assert.ok(expr, "找不到账本块的装配表达式");
  return new Function("_fadedDemands", "_DEMAND_LEDGER_HEAD", `${expr[0]}\nreturn _demandLedgerBlock;`)(faded, HEAD);
}

/** _trimMessagesIfHuge 里真实的保留段（从 _head 到 _kept），按源码原样执行。 */
function keepOf(content) {
  const seg = /const _head = m\.content\.slice\(0, mk\);[\s\S]*?const _kept = [^\n]*\n/.exec(TRIM);
  assert.ok(seg, "保留段那块不见了，这条断言失去落点");
  // 边界的算法跟源码一致：网关按「━━━…\n📌」定位真实用户请求。
  const bk = content.search(/━{8,}\s*\n\s*📌/);
  const mk = bk >= 0 ? bk : content.indexOf("📌");
  return new Function("m", "mk", "_DEMAND_LEDGER_HEAD", `${seg[0]}\nreturn _kept;`)({ content }, mk, HEAD);
}

// ═══ 1. 折叠保留段认得账本的真实标题 ════════════════════════════════════════════

test("折叠开场消息时，账本按它真实的标题被原样带走（装配端 → 折叠端全链）", () => {
  const ledger = ledgerBlockOf(["帮我修登录", "记住：回复一律用中文"]);
  assert.ok(ledger.startsWith(HEAD), "账本块不以共享常量开头——折叠端就没有可对齐的标记");
  const dump = "X".repeat(500);
  const head = "操作系统：macOS 15\n\n" + ledger
    + "--- 项目上下文 ---\n--- 目录树 ---\nsrc/\n  a.ts\n--- 当前文件 ---\n" + dump + "\n";
  const kept = keepOf(head + "━━━━━━━━━━━━\n📌 用户请求：继续");
  assert.match(kept, /回复一律用中文/, "需求账本被折没了——账本压根不在磁盘上，折掉就再也回不来");
  assert.ok(kept.includes(HEAD), "账本的表头没跟着一起保留，模型不知道那几行是什么");
  // 目录树和当前文件转储**应该**被折掉：替换文案承诺的 list_dir / read_file 正是为它们写的。
  assert.ok(!kept.includes(dump), "当前文件转储没被折掉，这一刀就白挥了");
  assert.ok(!kept.includes("  a.ts"), "目录树没被折掉");
  // 没有账本的开场消息，不许凭空多出一段空壳。
  assert.equal(keepOf("操作系统：macOS\n--- 目录树 ---\nsrc/\n" + dump + "\n━━━━━━━━━━━━\n📌 继续"), "");
});

test("折叠时记忆 / 项目日志 / 纠错账本一并带走——它们同样回不来", () => {
  // 这三段和需求账本是同一条判据下的漏网：替换文案许诺「要项目结构或文件内容就
  // list_dir / read_file」，那对目录树和当前文件转储成立，对它们一个字都不成立——
  // 模型甚至不知道它们存在过。纠错账本更隐蔽：它是**记忆块的一个子段**
  //（`[纠错账本·优先于普通记忆]`），记忆被折掉时它跟着一起没。
  const dump = "X".repeat(500);
  const head = "操作系统：macOS 15\n"
    + "\n--- 全局记忆（跨所有项目·用户级：身份/偏好/通用经验，每个项目每次都自动带上）---\n"
    + "（按记录时间从新到旧）\n"
    + "\n[纠错账本·优先于普通记忆]\n- 已作废「用 npm」；当前有效「用 pnpm」\n"
    + "- 用户是美国人，在美国学中文，回复用中文\n"
    + "\n--- 项目记忆（你之前用 remember 记的，跨会话保留）---\n- 网关在 8090 不是 8080\n"
    + "\n--- 项目日志（本项目最近干过的活，以工作区文件实况为准）---\n- 2026-08-25 ✅ 修 Windows 全屏\n"
    + "--- 项目上下文 ---\n--- 目录树 ---\nsrc/\n  a.ts\n--- 当前文件 ---\n" + dump + "\n";
  const kept = keepOf(head + "━━━━━━━━━━━━\n📌 用户请求：继续");
  assert.match(kept, /用 pnpm/, "纠错账本被折没了 —— 模型会继续照着已作废的那条做");
  assert.match(kept, /在美国学中文/, "全局记忆被折没了 —— 长 run 后半段就像换了个人");
  assert.match(kept, /网关在 8090/, "项目记忆被折没了 —— remember 记的东西撑不过一次折叠");
  assert.match(kept, /修 Windows 全屏/, "项目日志被折没了");
  // 该折的照折。
  assert.ok(!kept.includes(dump), "当前文件转储没被折掉，这一刀就白挥了");
  assert.ok(!kept.includes("  a.ts"), "目录树没被折掉");
});

test("折叠 marker 列表里的每个前缀，源码里都有对应的装配端——改名只改一头就会红", () => {
  const trim = stripJsComments(TRIM);
  const list = /for \(const marker of (\[[^\]]*\])\)/.exec(trim);
  assert.ok(list, "找不到保留段的 marker 列表");
  const items = list[1].slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
  assert.ok(items.length >= 3, "约定、子目录约定、账本三类至少要齐");
  for (const item of items) {
    if (/^["']/.test(item)) {
      const lit = new Function(`return ${item};`)();
      // 字面量 marker：装配端要么以 `\n<marker>` 起一段，要么以 `<marker>` 开模板。
      assert.ok(CODE.includes("\\n" + lit) || CODE.includes("`" + lit),
        `marker ${item} 在源码里找不到装配端——它只会保住一段从来不存在的分段`);
    } else {
      // 标识符 marker：装配端必须把同一个常量写进模板开头。
      assert.ok(CODE.includes("`${" + item + "}"),
        `marker ${item} 没有被任何模板当作分段起始——装配端另写了一份字面量就是漂移`);
    }
  }
  assert.ok(items.includes("_DEMAND_LEDGER_HEAD"), "账本那一类必须引用共享常量，不许手抄标题");
  // 标题字面量全源码只许出现一次（常量定义处）：第二份字面量就是下一次漂移的种子。
  assert.equal(CODE.split(HEAD).length - 1, 1, "账本标题在源码里有第二份手抄，改名时必然只改一头");
});

// ═══ 2. 差集两侧同一个归一化 ══════════════════════════════════════════════════════

/**
 * sendPrompt 里真实的差集判据：_visibleRecent + _recentText + _fadedDemands。
 *
 * 从 `_visibleRecent` 起切，不是从 `_recentText` 起 —— 「模型真正会看到哪几条」这件事
 * 就发生在前者里，只切后者等于把被测判据的一半留在窗口外。
 *
 * `gateway` / `coveredUserSigs` 是判据的**外部输入**（网关档位开没开、哪几条用户原话
 * 已被折进摘要），不是判据本身，所以按参数注入；判据的形状仍然逐字来自源码。
 *
 * 注意这里是**内容**不是下标：`covered` 数的是请求数组（含 assistant(tool_calls) 和
 * tool 两类消息），而 memory.recent 只有 user 和每轮最终的 assistant —— 拿前者当后者的
 * 下标，工具重的一轮会把 recent 整个切空，台账于是每轮全量重列（正是本该消除的那件事）。
 */
function fadedOf(sess, effectiveMode = "agent", { gateway = false, coveredUserSigs = [] } = {}) {
  const start = SEND.indexOf("const _visibleRecent = (() => {");
  const fadedAt = SEND.indexOf("const _fadedDemands = (", start);
  const end = SEND.indexOf("\n    : [];", fadedAt);
  assert.ok(start > 0 && fadedAt > start && end > fadedAt, "找不到差集判据那段");
  const body = SEND.slice(start, end + "\n    : [];".length);
  return new Function(
    "sess", "effectiveMode", "_MODES_WITH_TOOLS", "_ledgerNorm",
    "config", "_gatewayHandlesCompression", "_mcPrefixGet",
    `${body}\nreturn _fadedDemands;`,
  )(
    sess, effectiveMode, MODES_WITH_TOOLS, norm,
    {}, () => gateway, () => ({ coveredUserSigs }),
  );
}

/** sendPrompt 里真实的入账段：从 _lt 到 if (!_isFiller) {...} 收尾。 */
function pushOf(text, sess) {
  const start = SEND.indexOf("const _lt = text.trim();");
  const tail = SEND.indexOf("_autoMemoryCapture(_identityRoot, _lt);", start);
  const end = SEND.indexOf("\n    }", tail);
  assert.ok(start > 0 && tail > start && end > tail, "找不到入账那段");
  const body = SEND.slice(start, end + "\n    }".length);
  // 「这句话算不算没内容」的判据已经抽成了 `_isFillerUtterance`（预热那边也要用同一份，
  // 两份各自演化的话，同一句话在两处会给出不同答案）。这个沙箱只 eval 入账那一段，
  // 所以要把它按**真实实现**注进来 —— 在这里手写一份等价物就等于测试台自编形状，
  // 实现改了它还绿。
  const isFiller = load("_isFillerUtterance");
  new Function("text", "sess", "_ledgerNorm", "_applyExplicitMemoryCorrection", "_autoMemoryCapture", "_identityRoot", "_isFillerUtterance", body)(
    text, sess, norm, () => true, () => {}, "", isFiller,
  );
}

const MULTILINE_TEXTS = [
  // 分行写需求——最常见：第一行是要求，第二行是证据。
  "帮我修登录页的卡死\n报错是 TypeError: Cannot read properties of undefined (reading 'id')",
  // 贴的报错里带制表符。
  "修掉这个：\n\tat login.ts:42\n\tat app.ts:7，改完跑一下测试",
  // Windows 换行 + 连续空格。
  "先把  登录页\r\n的卡死修掉，再跑回归，别动现有视觉",
];

test("还在对话里的多行消息不再被当成「已折叠」每轮重列", () => {
  for (const text of MULTILINE_TEXTS) {
    const sess = { memory: { recent: [] }, _demandLedger: [] };
    pushOf(text, sess);
    assert.equal(sess._demandLedger.length, 1, `这条实质要求没入账：${JSON.stringify(text)}`);
    // 历史里存的是原文（conversation-memory 原样 push），不是入账时压过空白的那份。
    sess.memory.recent.push({ role: "user", content: text });
    for (const mode of MODES_WITH_TOOLS) {
      assert.deepEqual(fadedOf(sess, mode), [],
        `${mode} 模式下，明明还在对话里的多行消息被列进了「已折叠掉的历次要求」：${JSON.stringify(text)}`);
    }
  }
});

test("真正掉出历史的那条照样捞回来——差集不是被关掉了", () => {
  const text = MULTILINE_TEXTS[0];
  const sess = { memory: { recent: [] }, _demandLedger: [] };
  pushOf(text, sess);
  // 历史被压缩：这条不在 recent 里了。
  sess.memory.recent = [{ role: "user", content: "继续" }];
  const faded = fadedOf(sess, "agent");
  assert.equal(faded.length, 1, "掉出历史的要求没被捞回来");
  assert.equal(faded[0], norm(text).slice(0, 240));
  // 历史里被 _lexCompress 改过的消息（行尾空白被删）也算「还在」。
  sess.memory.recent = [{ role: "user", content: text.replace(/[ \t]+\n/g, "\n") + "   " }];
  assert.deepEqual(fadedOf(sess, "agent"), []);
});

test("网关压缩档位：按服务端报的 covered 判「已掉出历史」，不按本地存了什么", () => {
  // 网关档位下 memory.recent 从不收缩（_compactHistoryIfNeeded 第一行就 return），
  // 压缩发生在服务端。旧判据拿本地 recent 做差集，于是在**唯一会失忆的那条路上恒为空**。
  const text = MULTILINE_TEXTS[0];
  const sess = { memory: { recent: [] }, _demandLedger: [] };
  pushOf(text, sess);
  // 本地历史一条没少，但服务端已经把前 1 条折进摘要了。
  sess.memory.recent = [
    { role: "user", content: text },
    { role: "assistant", content: "改好了" },
    { role: "user", content: "继续" },
  ];

  const sig = norm(text).slice(0, 40);
  assert.deepEqual(
    fadedOf(sess, "agent", { gateway: true, coveredUserSigs: [] }), [],
    "服务端还没折叠任何一条时不该重列",
  );
  const faded = fadedOf(sess, "agent", { gateway: true, coveredUserSigs: [sig] });
  assert.equal(faded.length, 1,
    "服务端已经把这条折进摘要了，本地却因为 recent 没收缩而认定「还在历史里」——反健忘那块整条路上都不触发");
  assert.equal(faded[0], norm(text).slice(0, 240));

  // **不许按条数切。** 一轮工具往返在请求数组里是 2T+2 条、在 recent 里只有 2 条，
  // 拿前者当后者的下标必然超切，recent 变空 → 台账每一条都被判成「已折叠」→ 全量重列。
  const many = fadedOf(sess, "agent", { gateway: true, coveredUserSigs: ["不匹配任何一条的指纹"] });
  assert.deepEqual(many, [], "指纹对不上就不该判成已折叠（说明判据退回了按条数切）");

  // 网关档位关掉时行为不变：本地会真的裁 recent，这份指纹不该被拿来用。
  assert.deepEqual(
    fadedOf(sess, "agent", { gateway: false, coveredUserSigs: [sig] }), [],
    "本地压缩那条路不该受服务端指纹影响",
  );
});

test("入账两条路（sendPrompt / 插话）和比对走的是同一个归一化函数", () => {
  assert.equal(norm("a\n\tb  c\r\n"), "a b c");
  assert.equal(norm(null), "");
  const send = stripJsComments(SEND);
  assert.match(send, /sess\._demandLedger\.push\(_ledgerNorm\(_lt\)\.slice\(0, 240\)\)/,
    "sendPrompt 入账没走 _ledgerNorm");
  assert.match(send, /\.map\(\(m\) => _ledgerNorm\(m\.content\)\)\.join\("\\n"\)/,
    "历史那一侧没走 _ledgerNorm——差集又回到单边归一化");
  assert.match(send, /const key = _ledgerNorm\(d\)\.slice\(0, 40\);/,
    "账本那一侧没走 _ledgerNorm");
  const loop = stripJsComments(extractFn("_runAgenticLoop"));
  assert.match(loop, /const _sl = _ledgerNorm\(steerText\);/, "插话入账没走 _ledgerNorm");
  // 不许再出现第三种空白处理：任何 _demandLedger.push 的参数里都不能自带 replace(/\s+/g)。
  assert.doesNotMatch(CODE, /_demandLedger\.push\([^\n]*\.replace\(\/\\s\+\/g/,
    "又有一处入账自己压空白了——归一化必须只有 _ledgerNorm 一份");
});

// ═══ 3. 冷启动首轮：名录在预热等待之后算 ════════════════════════════════════════

/**
 * 跑 sendPrompt 里从诊断块之后到技能块之前的那一段真实代码：冷启动等待 + MCP 名录。
 * 返回拼完的 contextBlock。
 */
async function contextAfterWarmup(deps) {
  const anchor = "if (diagBlock) contextBlock += `\\n\\n${diagBlock}`;";
  const start = SEND.indexOf(anchor);
  const end = SEND.indexOf("const skillsBlock =", start);
  assert.ok(start > 0 && end > start, "找不到「诊断块 … 技能块」这段");
  const body = SEND.slice(start + anchor.length, end);
  const keys = Object.keys(deps);
  return new Function(...keys, `return (async () => { let contextBlock = ""; ${body}\nreturn contextBlock; })();`)(
    ...keys.map((k) => deps[k]),
  );
}

function mcpDeps({ effectiveMode = "agent", cacheKey = "", warm } = {}) {
  const state = { loaded: false, warmCalls: 0 };
  const deps = {
    effectiveMode,
    inTauri: true,
    _fileSkillsCacheKey: cacheKey,
    _curRoot: "/repo",
    _scheduleWorkspaceAgentWarmup: () => {},
    _refreshFileSkills: async () => {},
    _warmMcpTools: warm || (async () => { state.warmCalls++; await new Promise((r) => setTimeout(r, 5)); state.loaded = true; }),
    // 预热没落地时就是空快照——与 _readyMcpSnapshot 的真实行为一致。
    _readyMcpSnapshot: () => state.loaded
      ? { failed: [["broken", "connect ECONNREFUSED"]], toolCache: [{ function: { name: "mcp__svc__t" } }] }
      : { failed: [], toolCache: [] },
    _mcpAvailabilitySystemContext: (snap) => (snap.toolCache.length ? "【MCP 名录】" : ""),
    _mcpFailureSystemContext: (failed) => (failed?.length ? "【MCP 失败诊断】" : ""),
  };
  return { deps, state };
}

test("冷启动首轮：等完预热之后才算 MCP 名录，首轮就能看见有哪些服务", async () => {
  const { deps, state } = mcpDeps();
  const ctx = await contextAfterWarmup(deps);
  assert.equal(state.warmCalls, 1, "冷启动首轮没等 MCP 预热");
  assert.match(ctx, /【MCP 名录】/, "名录在预热之前就算完了——等到了也没人回头重算，这 1.5 秒对 MCP 是白等");
  assert.match(ctx, /【MCP 失败诊断】/, "连不上的服务同样要在等完之后才报得出来");
});

test("不是冷启动（已扫过）就不等，也不多一次预热；名录照常", async () => {
  const { deps, state } = mcpDeps({ cacheKey: "\0/Users/me" });
  state.loaded = true;
  const ctx = await contextAfterWarmup(deps);
  assert.equal(state.warmCalls, 0, "非首轮不该再等预热");
  assert.match(ctx, /【MCP 名录】/);
});

test("聊天模式移过去之后仍然不发名录、不发失败诊断", async () => {
  const { deps, state } = mcpDeps({ effectiveMode: "chat" });
  state.loaded = true;
  const ctx = await contextAfterWarmup(deps);
  assert.doesNotMatch(ctx, /【MCP 名录】|【MCP 失败诊断】/, "聊天模式收到了 MCP 名录——那段话会指使模型编造它做过的操作");
});

test("预热挂住也只等有上界的那一次：名录为空但这一轮照常发出", async () => {
  const never = new Promise(() => {});
  const { deps } = mcpDeps({ warm: () => never });
  const t0 = Date.now();
  const ctx = await Promise.race([
    contextAfterWarmup(deps),
    new Promise((_, reject) => setTimeout(() => reject(new Error("等待没有上界")), 4000)),
  ]);
  assert.ok(Date.now() - t0 < 4000);
  assert.doesNotMatch(ctx, /【MCP 名录】/, "预热没落地却凭空有了名录");
});

test("源码顺序：名录的计算点在冷启动等待之后、技能块之前", () => {
  const send = stripJsComments(SEND);
  const wait = send.indexOf("_warmMcpTools(_curRoot");
  const roster = send.indexOf("_mcpAvailabilitySystemContext(mcpSnapshot)");
  const skills = send.indexOf("const skillsBlock =");
  assert.ok(wait > 0 && roster > 0 && skills > 0, "锚点缺失");
  assert.ok(roster > wait, "MCP 名录在预热等待之前就算完了");
  assert.ok(roster < skills, "MCP 名录必须仍然在 contextBlock 收口之前拼进去");
  // 名录那行自己不许 await：预热拿不到就算了，下一轮自然就有。
  const line = send.slice(roster, send.indexOf("\n", roster));
  assert.doesNotMatch(line, /await/);
});

// ── 压缩摘要：模型对被压掉那段历史的**唯一**替代物 ────────────────────────────
//
// 同一个 bug 已经在这里被逮到过一次（multi_edit 不在那张手抄名单里，改过的文件从
// Files: 静默消失）。下面两条守的是它的两个同门。

test("摘要的 Files: 不许漏掉 move/copy —— 那两个的参数叫 from/to，不叫 path", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory();
  const tc = (name, args) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
  const out = m._summarizeBatch([
    tc("multi_edit", { path: "src/pay.ts" }),
    tc("move_path", { from: "src/old.ts", to: "src/new.ts" }),
    tc("copy_path", { from: "a/x.ts", to: "b/x.ts" }),
  ]);
  // 它们**既**不在名单里、就算加进来 `a.path` 也取不到——两层都漏。修之前的实测输出是
  // 「Actions: multi_edit, move_path, copy_path」配「Files: src/pay.ts」：
  // 摘要说"做过一次移动"，却说不出移的是什么，比不记还误导。
  for (const f of ["src/pay.ts", "src/old.ts", "src/new.ts", "a/x.ts", "b/x.ts"]) {
    assert.ok(out.includes(f), `压缩摘要丢了 ${f}——模型再也想不起来动过它`);
  }
});

test("工具结果截断要掐中间，不能把末尾的根因砍掉", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory();
  // 报错的价值分布在两头：第一行说"是什么错"，最后几行说"根因"，中间的 stack frame 是噪音。
  // 而 slice(0, 320) 砍的正是末尾。实测这条 491 字符的 pg 连接失败，修之前模型看到
  // 首行 + 五行 node_modules 栈，最后那句根因被截掉——于是压缩后它知道"连不上库"，
  // 却不知道自己上一轮已经查出为什么，只能从头再查一遍。
  const stack = [
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)",
    "    at Protocol._enqueue (/app/node_modules/pg/lib/protocol.js:144:48)",
    "    at Connection.connect (/app/node_modules/pg/lib/connection.js:109:18)",
    "    at Pool._acquireClient (/app/node_modules/pg-pool/index.js:271:12)",
    "    at async initDatabase (/app/src/db/index.ts:42:3)",
    "    at async bootstrap (/app/src/main.ts:18:5)",
    "根因：DATABASE_URL 指向 5432，而 docker-compose 里 postgres 映射的是 5433",
  ].join("\n");
  const line = m._summarizeBatch([{ role: "tool", content: stack }])
    .split("\n").find((l) => l.startsWith("[tool]")) || "";
  assert.ok(line.includes("ECONNREFUSED"), "首行的错误类型没保住");
  assert.ok(line.includes("根因"), "末尾的根因被截掉了——模型只好重新查一遍");
  // 预算不许因此失控：仍然在 320 上下（加上 "[tool] " 前缀）。
  assert.ok(line.length <= 360, `摘要行涨到 ${line.length} 字符，预算失守`);
  // 用户/助手的正文是连贯叙述，从头读就行，不该被掐中间。
  const userLine = m._summarizeBatch([{ role: "user", content: "a".repeat(900) }])
    .split("\n").find((l) => l.startsWith("[user]")) || "";
  assert.ok(!userLine.includes("…"), "用户正文不该掐中间");
});

test("归档的工具结果也要掐中间——否则 recall 连搜都搜不到", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory({ summarize: async () => "S" });
  // 归档不是"留个念想"：searchArchive 就在这段文本上做关键词检索。从头截断同时毁掉
  // 两件事——回忆到的内容缺结论，以及**只出现在尾部的关键词整条搜不到**。
  // 这条 npm 输出修之前归档成 700 字满屏 PASS，末尾那行 FAIL 被砍掉：模型事后回忆
  // 「ECONNREFUSED」拿到 0 条，而 0 条读起来是"这事没发生过"，于是当成测试全过了。
  const noise = "npm test 输出：" + "PASS test/foo.test.mjs 全部通过。".repeat(60);
  const toolResult = noise + " FAIL: Error: ECONNREFUSED 127.0.0.1:8090 网关没起来";
  m.push({ role: "user", content: "跑一下测试" });
  m.push({ role: "assistant", content: "好", tool_calls: [{ id: "t1", type: "function", function: { name: "run_cmd", arguments: "{}" } }] });
  m.push({ role: "tool", tool_call_id: "t1", content: toolResult });
  for (let i = 0; i < 130; i++) m.push({ role: "user", content: `后续第 ${i} 轮` });
  await m.maybeCompress?.();
  await new Promise((r) => setTimeout(r, 60));

  const archived = m.archive.find((e) => e.role === "tool");
  assert.ok(archived, "工具结果压根没进归档");
  assert.ok(/ECONNREFUSED/.test(archived.text), "末尾的 FAIL 被砍掉了——归档里只剩满屏 PASS，主动误导");
  assert.ok(/npm test/.test(archived.text), "开头也要在：得知道这条是什么");
  assert.ok(archived.text.length <= 700, `归档条目涨到 ${archived.text.length} 字符，预算失守`);
  // 真正的后果面：模型事后回忆搜得到。
  assert.equal(m.searchArchive("ECONNREFUSED").length, 1, "recall 搜不到 → 模型以为这事没发生过");
  assert.equal(m.searchArchive("网关没起来").length, 1, "尾部的中文关键词同样要能搜到");
});

// ── 压缩摘要的 Files: 行，在出货路径上到底有没有内容 ──────────────────────
// 样板那条 bug（「压缩会忘掉 multi_edit 改过的文件」）的根因比名单更深一层：
// _summarizeBatch 的 Files:/Actions: 读的是 msg.tool_calls，而全仓 memory.push
// **没有一个**带 tool_calls（收尾处注释原话 "Text-only (no tool_calls…)"，
// 且这条限制必须保持——assistant 带 tool_calls 却无配套 tool 回复是非法请求体）。
// 于是那两行恒为空：不是漏了某个工具，是一个文件都没有。
test("压缩摘要的 Files: 有内容——执行事实走 _ideMeta，不靠 tool_calls", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory({ summarize: async () => "S" });
  m.push({ role: "user", content: "把 auth 模块重构一下" });
  m.push({ role: "assistant", content: "已按你的要求完成 auth 模块重构。", model: "claude",
    _ideMeta: { files: ["src/auth/session.ts", "src/auth/token.ts", "src/app/login/page.tsx"], filesTotal: 3 } });
  for (let i = 0; i < 130; i++) m.push({ role: "user", content: `第 ${i} 轮` });
  await m.maybeCompress?.();
  await new Promise((r) => setTimeout(r, 60));
  const sum = m.prefixMessages().find((x) => String(x.content).includes("[对话上下文摘要]"))?.content || "";
  assert.ok(/(^|\n)Files: /.test(sum), "摘要里没有 Files: 行——压缩后模型对「我改过什么」完全失忆");
  assert.ok(sum.includes("src/auth/session.ts"), "改过的文件没进摘要");
  // 全路径，不是 basename：同名文件（page.tsx）不带目录等于没说。
  assert.ok(sum.includes("src/app/login/page.tsx"), "只剩文件名的话，Next.js 那种一堆 page.tsx 的项目里定位不到");
});

test("_ideMeta 只在本机用，绝不发给上游", async () => {
  // _sanitizeProviderMessages 是**排除法不是白名单**（它自己的注释写着「未知字段会
  // 原样发给上游」）。挂执行事实的通道必须是已经在那份解构里的 _ideMeta，
  // 否则用户的文件路径会跟着每一次请求送到第三方端点去。
  const san = load("_sanitizeProviderMessages", {
    _withoutLegacyReasoningSummary: (c) => c,
    _wellFormedContent: (c) => c,
    _stripLoneSurrogates: (s) => s,
    // 出线口第一句就做 tool_call ↔ tool_result 的配对修复。用**真实现**不用桩：
    // 桩掉它就等于这条测试不再经过出线口真正会跑的那条路。
    repairToolPairing,
  });
  const out = san([{ role: "assistant", content: "完成了", model: "claude",
    _ideMeta: { files: ["src/auth/session.ts"], filesTotal: 1 } }]);
  assert.ok(!("_ideMeta" in out[0]), "_ideMeta 漏给了上游");
  assert.ok(!JSON.stringify(out).includes("session.ts"), "用户的文件路径跟着请求发出去了");
});

test("attachExecutionFacts 真的把改过的文件挂成 _ideMeta（全路径、带总数）", async () => {
  const { attachExecutionFacts } = await import("../src/agent/execution-facts-meta.js");
  const msg = attachExecutionFacts({ role: "assistant", content: "完成了" },
    new Set(["src/app/dashboard/page.tsx", "src/app/settings/page.tsx"]));
  assert.deepEqual(msg._ideMeta.files, ["src/app/dashboard/page.tsx", "src/app/settings/page.tsx"],
    "必须是全路径——同名的 page.tsx 只留 basename 等于没说");
  assert.equal(msg._ideMeta.filesTotal, 2);
  // 没改文件就别挂空壳，省得摘要里多一行空的 Files:。
  assert.equal(attachExecutionFacts({ role: "assistant", content: "只是回答了个问题" }, new Set())._ideMeta, undefined);
  // 截断要报总数，别让「只改了 60 个」看起来像全部。
  const many = attachExecutionFacts({ role: "assistant", content: "x" },
    new Set(Array.from({ length: 75 }, (_, i) => `src/f${i}.ts`)));
  assert.equal(many._ideMeta.files.length, 60);
  assert.equal(many._ideMeta.filesTotal, 75, "总数丢了的话，模型会以为自己只改了 60 个");
});

test("收尾入账处真的调用了它，且喂的是 run._mutatedFiles（调用点，跑不动只能守源码）", () => {
  const src = stripJsComments(SRC);
  const at = src.indexOf('const _record = String(summaryText || "").trim();');
  assert.ok(at > 0, "收尾入账处的锚点没了——这条守卫已经在守空气，重新定位");
  const win = src.slice(at, at + 600);
  assert.match(win, /_attachExecutionFacts\(\s*_msg\s*,\s*run\?\._mutatedFiles\s*\)/,
    "收尾入账没把本轮改过的文件挂上去，Files: 行又会变空");
});

test("自动压缩只压摘要器真看过的那些——装不下的不许一起删掉", async () => {
  const { buildCompactionTranscript } = await import("../src/agent/compaction-window.js");
  // 实测形状：120 条各约 3400 字。原来整份拼完再 slice(0, 80000)，摘要器只看到前 24 条，
  // 却按 snapshot.length 删掉 114 条——90 条从没进过转录。它们还在 archive 里，
  // 但摘要顶头写着「turns 1–114」，模型没有理由去 recall 那 90 轮。
  const recent = Array.from({ length: 120 }, (_, i) => ({ role: "user", content: `第${i}轮 ` + "x".repeat(3400) }));
  const { transcript, fitCount } = buildCompactionTranscript(recent, 80_000);
  assert.ok(fitCount > 0 && fitCount < recent.length, `fitCount=${fitCount}，应当是「装下了一部分」`);
  assert.ok(transcript.length <= 80_000, "预算失守");
  // 关键不变量：fitCount 之外的消息，一个字都不在转录里 —— 于是调用方按它算删除范围就是安全的。
  assert.ok(transcript.includes(`第${fitCount - 1}轮`), "最后装进去的那条应当在转录里");
  assert.ok(!transcript.includes(`第${fitCount}轮`), "fitCount 之外的消息出现在转录里——两个数不同源了");
  // 一定有进展：每条上限 4000 字，80000 的预算至少装得下 20 条，压缩不会卡死。
  assert.ok(fitCount >= 20, `只装下 ${fitCount} 条，压缩推不动`);
  // 单条超预算也得装，否则永远压不动。
  assert.equal(buildCompactionTranscript([{ role: "user", content: "y".repeat(50_000) }], 100).fitCount, 1);
});

test("压缩的删除范围被 fitCount 夹住（调用点）", () => {
  const loop = extractFn("_compactHistoryIfHuge");
  assert.match(loop, /buildCompactionTranscript\(mem\.recent\)/, "转录不是从共享实现来的，两个数会再次不同源");
  assert.match(loop, /covered = Math\.min\(covered, _fitCount\)/,
    "删除范围没有被摘要器实际看过的条数夹住——装不下的那些又会被悄悄删掉");
});

test("上下文摘要不许被 Tier 3 当成「模型自己写太长的回复」对折", () => {
  // Tier 3 折的是「长的 assistant 正文」，而摘要形状上完全符合（assistant / 无
  // tool_calls / >600 字）且坐在 i=1。实测 3893 → 400：被压掉那段历史唯一的替代物
  // 就这么没了。而且 _foldAssistantText 贴的话对摘要三项全错（不是「你早先的回复」、
  // 结尾不是「当时的结论」、也不是「无法取回」——archive 里还在）。
  const trim = load("_trimMessagesIfHuge", {
    _gatewayHandlesCompression: () => false,
    _mcPrefixInvalidate: () => {},
    _msgSize: (m) => String(m?.content || "").length,
    _estTokens: (msgs) => msgs.reduce((n, m) => n + String(m?.content || "").length, 0),
    _readEvidenceCovers: () => false,
    _REFETCHABLE: new Set(),
    _IMPORTANT_LINE: /error/i,
    _smartCompress: (s) => s,
    _syncRunReadCoverageFromMessages: () => {},
    _foldAssistantText: () => "FOLDED",
    _lexCompress: (s) => s,
  });
  const summary = { role: "assistant", _ideMeta: { kind: "context_summary" },
    content: "[对话上下文摘要]\n接口前缀 /api/v2；金额用 amountCents 存。" + "x".repeat(4000) };
  const plain = { role: "assistant", content: "我分析下来根因是 X。" + "y".repeat(4000) };
  const msgs = [{ role: "system", content: "s" }, summary, plain,
    ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "z".repeat(4000) + i }))];
  trim(msgs, { model: "gpt-4o-mini" });
  assert.ok(!String(msgs[1].content).includes("FOLDED"), "摘要被对折了——压缩的成果整份丢掉");
  assert.ok(String(msgs[1].content).includes("/api/v2"), "用户定下的硬约束没保住");
  // 反向：普通的长 assistant 正文照旧要被折，别把这条守卫修成「Tier 3 整个失效」。
  assert.ok(String(msgs[2].content).includes("FOLDED"), "Tier 3 对普通长正文失效了");
});

test("工具成败台账：只失败没成功的工具不许被截断掉——这本账就是为失败存在的", async () => {
  const { toolLedgerStats } = await import("../src/agent/tool-ledger.js");
  // 原来按 okCount 降序再 slice(0, 20)：0✓/4✗ 的工具结构性地永远排最末、必被截掉。
  // 三个消费方全部面向模型，其中两个的标题正是「避开已知失败路径，复用已验证工具」。
  const entries = [];
  for (let i = 0; i < 21; i++) for (let k = 0; k < 9; k++) entries.push({ tool: `ok_tool_${i}`, category: "file", ok: true });
  for (const t of ["run_in_terminal", "browser", "db_query"])
    for (let k = 0; k < 4; k++) entries.push({ tool: t, category: "other", ok: false, reason: "端口被占用 EADDRINUSE" });
  const out = toolLedgerStats(entries);
  for (const t of ["run_in_terminal", "browser", "db_query"])
    assert.ok(out.includes(t), `连败的 ${t} 被截掉了——模型会照旧去撞同一堵墙`);
  assert.ok(out.includes("EADDRINUSE"), "最近失败原因也要留着，否则只知道失败不知道为什么");
  // 预算不许失控：仍是 20 行（外加类别汇总头和截断尾注）。
  assert.ok(out.split("\n").length <= 23, `涨到 ${out.split("\n").length} 行，预算失守`);
  // 截断要说出来，否则读起来像「本 run 只用过这些工具」。
  assert.match(out, /其余 \d+ 个工具全部成功，未列出。/, "静默截断——被丢掉的那些无声无息");
  // 反向：没有失败时不许硬塞尾注/失败行。
  const clean = toolLedgerStats([{ tool: "read_file", category: "file", ok: true }]);
  assert.ok(!/其余/.test(clean), "没截断却挂了截断尾注");
});

test("草稿纸的「已改文件」按全路径记——同名文件不许互相覆盖", () => {
  // _pad.modified 是 Map，原来按 basename 建键：Next.js 那种 3 个 page.tsx + 2 个
  // layout.tsx 的项目改完 6 个文件，纸上只剩 3 条「page.tsx(编辑)」。历史压缩之后
  // 这张纸就是模型对「我改过什么」的唯一记忆——它既说不出改的是哪个目录下的，
  // 也数不对改了几个；同一份还随 _sharedCtxDigest 发给每个子体。
  const src = stripJsComments(SRC);
  for (const bad of [/_pad\.modified\.set\([^)]*\.split\("\/"\)\.pop\(\)/,
                     /run\.ctx\.modified\.set\([^)]*\.split\("\/"\)\.pop\(\)/]) {
    assert.doesNotMatch(src, bad, "又改回按 basename 建键了——同名文件会互相覆盖");
  }
  const fmt = load("_fmtModified");
  const two = fmt(new Map([["src/app/dashboard/page.tsx", "编辑"], ["src/app/settings/page.tsx", "编辑"]]), ", ");
  assert.ok(two.includes("dashboard/page.tsx") && two.includes("settings/page.tsx"),
    "两个同名 page.tsx 必须都在，而且看得出是哪个目录下的");
  // 全路径会变长，所以要有上界；但截断必须说出来，别读成「这一轮只改了这 40 个」。
  const many = fmt(new Map(Array.from({ length: 45 }, (_, i) => [`src/f${i}.ts`, "编辑"])), ", ");
  assert.match(many, /…等共 45 个/, "静默截断——被丢掉的那些无声无息");
});

test("知识库检索成功了就别判成失败——正文本来就是别人写的文档", () => {
  // _toolExecutionSucceeded 对多数工具按**全文**匹配 [失败]/[ERROR] 这类标记。knowledge
  // 的正文就是语料原文，一句普通的 markdown 链接「参见 [Error handling](…)」就会命中。
  // 代价不是记一笔错账：_domainKnowledgeBrief 拿它当闸门，判失败就把命中的语料整段丢掉，
  // 还当面告诉模型「本轮检索没有拿到结果（检索链路失败）」。重试也没用——触发条件是
  // 语料自己的正文，每次都在。
  const f = load("_toolExecutionSucceeded", {
    _WORKSPACE_MUTATING_TYPES: new Set(),
    _toolFailureMatch: load("_toolFailureMatch"),
    _toolFailureMarkerAtHead: load("_toolFailureMarkerAtHead"),
  });
  const hit = "知识库命中 2 条：\n1. 幂等：所有写接口必须支持 Idempotency-Key。"
    + "\n2. 分页：参见 [Error handling](https://example.com/errors) 一节。";
  assert.equal(f({ type: "knowledge" }, { content: hit }), true,
    "命中的语料里有 [Error handling] 就被判失败——两段真事实一个字都进不了上下文");
  // 真失败必须照旧认得出，否则这条守卫是把闸门整个拆了。
  for (const bad of ["[失败] michael-design 预取异常: timeout", "[ERROR/UNREADABLE] 语料读不出来",
                     "〔外部数据〕[失败] 检索链路异常"])
    assert.equal(f({ type: "knowledge" }, { content: bad }), false, `真失败 ${bad.slice(0, 12)} 漏判了`);
});

test("查过引用之后，「删了没查引用的声明」这条事实要能撤掉", () => {
  // 两个写回点原来都是 `if (_gone.length) run._removedDecls = _gone`，而全仓没有任何
  // 一处清零。模型第 4 轮真的跑了 lsp_references 确认没人再用，扫描结果已经是 []，
  // 但 run._removedDecls 还留着上一轮的值——_deliveryFactsLine 从第 5 轮到 run 结束
  // 每轮都还在说「这一轮删掉了 1 个还没查过引用的声明」。同门的 _stubFindings 两处
  // 都已经改成无条件写回，这一对被漏了。
  const src = stripJsComments(SRC);
  assert.doesNotMatch(src, /if \(_wfGone\.length\) run\._removedDecls = _wfGone;/,
    "空数组仍然不写回——已经不成立的事实会每轮重播");
  assert.match(src, /run\._removedDecls = _wfGone;/, "写回点没了");
  assert.match(src, /run\._removedDecls = _gone;\s*\n\s*if \(_gone\.length\) \{/,
    "收尾那处也要无条件写回，只有 _incompleteReason 才按非空挂");
  // 行为面：事实行本身在空数组时必须是空的。
  const facts = load("_deliveryFactsLine", {
    _failedWritePaths,
    _CODE_FILE_RE: loadConst("_CODE_FILE_RE"),
    _looksLikeTestFile: load("_looksLikeTestFile"),
    _deliveryFacts: load("_deliveryFacts", {
      _CODE_FILE_RE: loadConst("_CODE_FILE_RE"), _looksLikeTestFile: load("_looksLikeTestFile"),
    }),
    _strayScratchFiles: load("_strayScratchFiles"),
    _projectStacks: new Map(),
  });
  const run = { _mutatedFiles: new Set(["src/plan.ts"]), _executionEvidence: [], _removedDecls: [] };
  assert.doesNotMatch(facts(run), /还没查过引用的声明/, "空数组还在报——说明这条事实撤不掉");
  run._removedDecls = [{ path: "src/plan.ts", name: "renderPlan" }];
  assert.match(facts(run), /还没查过引用的声明/, "真有未查引用的删除时必须报出来");
});

test("调度器留下的空洞不算失败——否则「重新发起」和「别再重试」正面对撞", () => {
  // 补空洞那段只写消息、**不写 rawResult**，而 _toolExecutionAttempted(undefined) 是
  // true（判据是 result?.failure?.attempted !== false），所以光靠它排不掉。台账那处
  // （_recordToolCall）早就一起排除了 _notAttempted，注释里点名说的正是死循环检测
  // 这个消费方，而它自己漏了。
  //
  // 撞上了模型会同时收到两条相反的指令：4 条「[未执行] 这次调用没有被执行……仍然
  // 需要的话，重新发起这次调用」，以及同一轮的「你在重复同样的动作/连续失败，看起来
  // 卡住了。别再原样重试，换一种真正不同的策略」。后一条更强、更晚到，于是它不去重发
  // 那几次读取，改去「换个思路」或者 ask_user 问一件自己 read_file 就能知道的事。
  const loop = extractFn("_runAgenticLoop");
  const at = loop.indexOf("Stuck / loop detection");
  assert.ok(at > 0, "死循环检测的锚点没了——这条守卫在守空气，重新定位");
  assert.match(loop.slice(at, at + 1200), /items\[i\]\._notAttempted/,
    "死循环检测没排除「根本没执行」的调用，会把调度器的空洞算成连续失败");
  // 台账那处必须一直是排除的（两个消费方判据要一致）。
  assert.match(loop, /!it\._skipped && !it\._notAttempted && _toolExecutionAttempted\(it\.rawResult\)/,
    "台账那处的排除被改掉了");
});

test("附件压缩后要留下文件名和路径，不能只剩「1 item(s): image」", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory({ summarize: async () => "S" });
  // 用户把构建报错截图拖进来、一个字没打。压缩之后他问「刚才那个报错是哪个文件报的」，
  // 摘要里只写着「1 item(s): image」——模型既没有文件名也没有磁盘路径，连重新看一眼
  // 都做不到，只能反问「你说的是哪个报错」，而用户觉得自己十分钟前才给过。
  m.push({ role: "user", content: "看下这张截图里的报错",
    attachments: [{ kind: "image", name: "checkout-500.png", path: "/Users/m/Desktop/checkout-500.png" }] });
  for (let i = 0; i < 130; i++) m.push({ role: "user", content: `第 ${i} 轮` });
  await m.maybeCompress?.();
  await new Promise((r) => setTimeout(r, 60));
  const sum = m.prefixMessages().find((x) => String(x.content).includes("[对话上下文摘要]"))?.content || "";
  // 断言写成 `image:checkout-500.png`，不是光找 "checkout-500.png"——后者会被下面
  // 那半句括号里的路径顺带满足，于是「标签退回只剩 kind」这种回归照样绿着。
  assert.match(sum, /image:checkout-500\.png/, "文件名没了——模型说不出用户给的是哪张图");
  assert.ok(sum.includes("/Users/m/Desktop/checkout-500.png"), "磁盘路径没了——重新看一眼都做不到");
});

test("摘要要标出它覆盖了第几轮到第几轮", async () => {
  const { ConversationMemory } = await import("../src/conversation-memory.js");
  const m = new ConversationMemory({ summarize: async () => "S" });
  m.push({ role: "user", content: "端口是 5433 不是 5432" });
  for (let i = 0; i < 130; i++) m.push({ role: "user", content: `第 ${i} 轮` });
  await m.maybeCompress?.();
  await new Promise((r) => setTimeout(r, 60));
  // range 从两个写入点、一个合并点一路维护下来，却在唯一通往模型的出口被丢掉：
  // 摘要里的话和 recent 里的话谁先谁后，模型判断不了；而 searchArchive 的条目带 turn。
  assert.ok(m.summaries[0]?.range, "range 本来就没存下来，先修存的那一头");
  const sum = m.prefixMessages().find((x) => String(x.content).includes("[对话上下文摘要]"))?.content || "";
  assert.ok(sum.includes(m.summaries[0].range),
    `摘要里没有轮次区间（${m.summaries[0].range}）——先后顺序对不上号`);
});

test("草稿纸只进不出——40 轮攒出 25 份，占掉一半以上的请求体", () => {
  // 注入时前面拼了 _ORCH_NOTE（71 字信封），而删除判据写的是
  // `content.startsWith("[运行进度草稿纸")` —— 内容开头是「〔系统编排提示…」，
  // 所以恒为 false，一份都删不掉。注入排期是 iter>=6 && (iter%3===0 || iter>=20)，
  // 第 20 轮之后每轮一份。线上实测同一个 run 第 47 步累计 497,109 字节 = 请求体的 53.2%，
  // 那 247k prompt token 原样进了模型——同时解释了「慢」和「笨」。
  const ORCH = loadConst("_ORCH_NOTE");
  const TAG = loadConst("_PAD_TAG");
  const inject = (msgs, iter, dedupe) => {
    if (!(iter >= 6 && (iter % 3 === 0 || iter >= 20))) return;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user" && typeof msgs[i].content === "string" && dedupe(msgs[i].content)) {
        msgs.splice(i, 1);
      }
    }
    msgs.push({ role: "user", content: ORCH + `${TAG}——你在长任务第 ${iter} 步]\n已改文件: a.ts(编辑)` });
  };
  const count = (msgs) => msgs.filter((m) => String(m.content).includes(TAG)).length;

  // 旧判据（startsWith）：一份都删不掉。
  const oldWay = [];
  for (let i = 1; i <= 40; i++) inject(oldWay, i, (c) => c.startsWith(TAG));
  assert.ok(count(oldWay) >= 20, `旧判据本该攒一堆，只攒了 ${count(oldWay)} 份，用例前提不成立`);

  // 新判据（includes）：任何时候都只留一份。
  const newWay = [];
  for (let i = 1; i <= 40; i++) inject(newWay, i, (c) => c.includes(TAG));
  assert.equal(count(newWay), 1, `草稿纸又开始堆积了：留下 ${count(newWay)} 份`);
  // 留下的必须是**最新**那一份，不能是第一份。
  assert.match(String(newWay[newWay.length - 1].content), /第 40 步/, "留下的不是最新那份");
});

test("生产代码里草稿纸的去重用 includes，不是 startsWith（守调用点）", () => {
  // 上面那条只证明「includes 对、startsWith 错」，不证明生产代码用的是哪个——
  // 把生产那行改回 startsWith，上面那条照样绿。所以这一条钉调用点。
  const src = stripJsComments(SRC);
  const at = src.indexOf("_padInjectedThisTurn = false;");
  assert.ok(at > 0, "草稿纸注入段的锚点没了，这条守卫失去落点");
  const seg = src.slice(at, at + 900);
  assert.match(seg, /content\.includes\(_PAD_TAG\)/,
    "草稿纸去重又变回按前缀匹配了——注入时前面拼了 _ORCH_NOTE，前缀判据恒为 false，会只进不出");
  assert.doesNotMatch(seg, /startsWith\("\[运行进度草稿纸/, "旧的前缀判据回来了");
});
