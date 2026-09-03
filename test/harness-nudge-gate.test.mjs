// harness 提醒的总闸和计数。
//
// 这套提醒有 34 个类别、40 个注入点，每一条都是往上下文里塞一段「你还应该再做点什么」。
// 每条当初都为修一个真实事故而加，但叠在一起就是用户报的三样：
// 简单事情也长篇大论、一个任务跑 27 步、190 万输入 token（实测最慢那次）。
// 而 **Claude Code 的循环里 harness 对模型说的话是 0 条** —— 行为只由提示词和模型塑造。
//
// 这一版不删任何一条：**从来没人量过它们帮了多少、害了多少**，没有数据就删是拍脑袋。
// 先让它可数、可关，同一个任务开着跑一遍、关掉跑一遍，用数据决定哪几条该留。
// 这个文件守住那个开关和那份计数真的成立。
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers/source.mjs";
// 豁免名单从**源码那一份**来，测试不自己再抄一遍：抄了就会出现「改了源码没改测试、
// 两边说法不同却全绿」的假绿（本仓库栽过好几次）。
import { NUDGE_GATE_EXEMPT, TOOL_WINDOW_NUDGES, USER_VOICE_NUDGES } from "../src/agent/nudge-gate.js";
import { SRC } from "./helpers/source.mjs";
import * as acorn from "acorn";

const mk = (on) => {
  const messages = [{ role: "user", content: "u0" }, { role: "assistant", content: "a0" }];
  const run = {};
  const push = load("_pushNudge", {
    messages, run, _nudgeReg: new Map(), _nudgeRank: () => 1, _ORCH_NOTE: "〔编排〕",
    _nudgeTurnFloor: 0, _harnessNudgesEnabled: () => on, _NUDGE_GATE_EXEMPT: NUDGE_GATE_EXEMPT,
  });
  return { messages, run, push };
};

test("闸开着：提醒照常进上下文", () => {
  const { messages, push } = mk(true);
  const before = messages.length;
  push("verifyNow", "去验证");
  assert.equal(messages.length, before + 1);
  assert.match(messages.at(-1).content, /去验证/);
});

test("闸关掉：一条都不进上下文", () => {
  const { messages, push } = mk(false);
  const before = messages.length;
  for (const c of ["verifyNow", "investigate", "planFirst", "blindEdit"]) push(c, "x");
  assert.equal(messages.length, before, "关掉之后还有提醒被塞进上下文");
});

test("计数在闸门之前——关掉之后「本来会推几条」照样有数（否则 A/B 没法比）", () => {
  const { run, push } = mk(false);
  push("verifyNow", "x"); push("verifyNow", "x"); push("investigate", "x");
  assert.equal(run._nudgeAttempts, 3, "关掉就不记账了，那这个开关自己没法评估");
  assert.equal(run._nudgeSuppressed, 3);
  assert.deepEqual({ ...run._nudgeCounts }, { verifyNow: 2, investigate: 1 });
});

test("steer 不受闸门管——那是用户自己的实时插话，不是 harness 的话", () => {
  const { messages, run, push } = mk(false);
  const before = messages.length;
  push("steer", "用户刚说的新要求");
  assert.equal(messages.length, before + 1, "把用户自己的插话也关掉了");
  assert.equal(run._nudgeSuppressed, undefined);
});

test("闸开着时也照样计数（两边用同一套读数才比得了）", () => {
  const { run, push } = mk(true);
  push("verifyNow", "x"); push("diag", "x");
  assert.equal(run._nudgeAttempts, 2);
  assert.equal(run._nudgeSuppressed, undefined);
});

test("默认是开的——这一版不改任何人的行为", async () => {
  const { fnSource } = await import("./helpers/source.mjs");
  const fn = fnSource("_harnessNudgesEnabled", { code: true });
  assert.match(fn, /!== "off"/, "默认值反了：没设过这个键的用户会被静默改掉行为");
});

// ── 闸只挡劝诫，不许顺手把动态工具编排打断 ─────────────────────────────────
test("装了工具的那几条不受闸门管——只挡消息的话工具进了窗口却没人说为什么", () => {
  const { messages, push } = mk(false);   // 闸关掉
  const before = messages.length;
  for (const c of TOOL_WINDOW_NUDGES) push(c, `${c}-说明`);
  assert.equal(messages.length, before + TOOL_WINDOW_NUDGES.length,
    "这四条旁边都跟着 _applyToolPayloadWindow：工具已经进了这一轮的窗口。"
    + "只挡消息，模型就会看到工具数组里凭空多出 web_search / package_search 而没有任何理由——"
    + "那不是少了一条提醒，是动态工具编排整条哑掉。");
  // 而纯劝诫照旧被挡住：这道开关还是那道开关。
  const n = messages.length;
  for (const c of ["stuck", "diag", "buildFix"]) push(c, "x");
  assert.equal(messages.length, n, "纯劝诫不该跟着一起豁免，否则这个开关就没有意义了");
});

test("TOOL_WINDOW_NUDGES 这份名单必须对得上 main.js 里真实的装载点", () => {
  // 手工维护的名单会漂：少一条 → 工具进窗口没人说话；多一条 → 开关关不干净。
  // 所以拿 **main.js 的 AST** 反过来算一遍，两个方向都比。
  //
  // 作用域必须收到「这条注入自己那个块」：第一版按「最近的外层函数」找，而
  // _runAgenticLoop 本身某处就有 _applyToolPayloadWindow，于是 13 个类别**全部**命中，
  // 断言是恒真的。判据改成：往外走到最大的、里面仍然只有这一条 _pushNudge 的语句。
  const ast = acorn.parse(SRC, { ecmaVersion: "latest", sourceType: "module" });
  const hits = [];
  (function walk(n, anc) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, anc));
    if (n.type === "CallExpression" && n.callee?.name === "_pushNudge") { hits.push({ n, anc: [...anc] }); return; }
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k], [...anc, n]);
  })(ast, []);
  const loadsTools = new Set();
  for (const h of hits) {
    const cat = h.n.arguments[0]?.type === "Literal" ? h.n.arguments[0].value : null;
    if (!cat) continue;
    const stmts = h.anc.filter((x) => /Statement|Declaration/.test(x.type));
    let site = h.n;
    for (let i = stmts.length - 1; i >= 0; i--) {
      const t = SRC.slice(stmts[i].start, stmts[i].end);
      if ((t.match(/_pushNudge\(/g) || []).length !== 1) break;
      site = stmts[i];
    }
    if (/_applyToolPayloadWindow\(/.test(SRC.slice(site.start, site.end))) loadsTools.add(cat);
  }
  assert.ok(loadsTools.size > 0, "一个都没认出来 = 判据本身坏了，下面两条断言会一起变成恒真");
  // ← 名单不许少：源码里装了工具的，必须全在名单里（漏一条 = 工具进窗口没人说明）。
  assert.deepEqual([...loadsTools].sort(), [...TOOL_WINDOW_NUDGES].sort(),
    "名单和 main.js 里真实的装载点对不上：少了就是工具白装，多了就是这个开关关不干净");
  // ← 名单不许多：除了装工具那几条，只允许用户自己的话。
  assert.deepEqual([...NUDGE_GATE_EXEMPT].filter((c) => !TOOL_WINDOW_NUDGES.includes(c)),
    USER_VOICE_NUDGES, "豁免名单里除了装工具那几条，只允许用户自己的话");
});
