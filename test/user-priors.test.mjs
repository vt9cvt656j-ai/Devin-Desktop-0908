// 用户先验 —— 「这个人这么说话时通常想干什么」。
//
// 所有者：「要完全完全能够预判用户要做的事情，而不是瞎猜，也不是瞎搞」。
// 这两句话对应两组断言：**不瞎猜**＝支持度是数出来的、结论只能落在有限字段上；
// **不瞎搞**＝先验不夺任何能力、判歪了自己会静音、整套学歪了自己会关掉。
//
// 纯模块直接 import 跑真函数，不抠源码；只有「可达性」那一条必须看 main.js，
// 因为它守的正是「这东西不许出现在别的地方」。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  configureUserPriors, PRIOR_FIELDS, MIN_SUPPORT, MAX_INJECT, MAX_INJECT_BYTES,
  shapeOf, lenBucket, isBadTurn, verdictMismatch, recordTurnSignal, loadSignals,
  applyDistilledPriors, loadPriors, statisticalPriors, pickUserPriors, scorePriors,
  priorsArm, setPriorsMode, userPriorReadout, autoDisableIfHarmful,
  distillUserPriorsInput, distillDue, markDistilled,
} from "../src/agent/user-priors.js";
import { stripComments } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(join(HERE, "../src/main.js"), "utf8");
// 只看 main.js，**不能用 helpers 的 CODE**：那份是 main.js 和 src/agent 各模块拼起来的，
// 会把 user-priors.js 自己的常量也扫进来，下面两条断言就恒红。
const MAIN_CODE = stripComments(MAIN);

const DAY = 86400000;
let clock = 1788000000000;
function fresh() {
  const store = new Map();
  configureUserPriors({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    taskWords: (s) => String(s || "").toLowerCase().split(/\W+/).filter(Boolean),
    taskSim: (a, b) => {
      const A = new Set(a), B = new Set(b);
      let hit = 0; for (const x of A) if (B.has(x)) hit++;
      return hit / Math.max(1, Math.min(A.size, B.size));
    },
    now: () => clock,
  });
  return store;
}
const ep = (over = {}) => ({
  vd: { src: "ai", act: "create", cont: "new", amb: 0, ws: "inspect", rm: "none", om: "solo", plan: false },
  outcome: "success", files: [], steps: 5, walls: [], dispatch: [], ...over,
});

test("表达形状只由裁决自己的输出坐标 + 一个物理量组成，一个词表都不用", () => {
  fresh();
  assert.equal(shapeOf({ act: "create", cont: "new", amb: 0 }, "做个登录页"), "create/new:S");
  assert.equal(shapeOf({ act: "modify", cont: "continue", amb: 2 }, "x".repeat(30)), "modify/continue+amb:M");
  assert.equal(lenBucket("短"), "S");
  assert.equal(lenBucket("x".repeat(61)), "L");
  // 形状里不许出现用户原话的任何片段——那是「抄词表」的另一种写法。
  assert.ok(!shapeOf({ act: "create", cont: "new" }, "做成 apple 官网那种").includes("apple"));
});

test("判错的四个来源全是执行事实，没有一处靠猜", () => {
  fresh();
  assert.equal(isBadTurn(ep()), false);
  assert.equal(isBadTurn(ep({ reworkedAt: "2026-09-08T10:00:00" })), true, "半小时内又提同一件事");
  assert.equal(isBadTurn(ep({ steer: 1 })), true, "中途被插话纠正");
  assert.equal(isBadTurn(ep({ mm: ["ws_none_but_wrote"] })), true, "声明与执行不符");
  assert.equal(isBadTurn(ep({ outcome: "failed" })), true, "压根没成功");
});

test("声明 vs 执行事实的不符：六条判据，全部就地算，不调模型", () => {
  fresh();
  assert.deepEqual(verdictMismatch(ep({ vd: { ws: "inspect" }, files: ["a.js"] })), ["ws_none_but_wrote"]);
  assert.deepEqual(verdictMismatch(ep({ vd: { ws: "modify" }, files: [], outcome: "success" })), ["ws_mod_no_write"]);
  assert.deepEqual(verdictMismatch(ep({ vd: { rm: "none" }, walls: ["web_search [timeout]"] })), ["rm_none_but_searched"]);
  assert.deepEqual(verdictMismatch(ep({ vd: { plan: true }, steps: 2 })), ["plan_on_tiny"]);
  assert.deepEqual(verdictMismatch(ep({ vd: { om: "council" }, dispatch: [] })), ["orch_declared_not_dispatched"]);
  // 判对的那一轮不许无中生有
  assert.deepEqual(verdictMismatch(ep({ vd: { ws: "modify", om: "solo" }, files: ["a.js"] })), []);
});

test("支持度是数出来的：格子按「形状 + 当时判成的值」计数", () => {
  fresh();
  for (let i = 0; i < 6; i++) {
    recordTurnSignal({ text: "做成 apple 官网那种", ep: ep({ outcome: i < 4 ? "partial" : "success" }) });
  }
  const s = loadSignals();
  const key = "create/new:S|ws=inspect";  // 「做成 apple 官网那种」13 字 → S 桶
  assert.ok(s.cells[key], `没有这个格子：${Object.keys(s.cells).join(" ")}`);
  assert.equal(s.cells[key].n, 6);
  assert.equal(s.cells[key].bad, 4, "判错次数必须是数出来的");
  assert.equal(s.shapes["create/new:S"], 6);
  // 没有裁决结果的轮次不入账：配不上「判成了什么」的样本是噪音
  const before = loadSignals().ring.length;
  recordTurnSignal({ text: "随便说说", ep: { outcome: "success" } });
  assert.equal(loadSignals().ring.length, before, "没有 vd 的轮次不该入账");
});

test("样本不足不下结论；ring 里只留 40 字线索，不整句落盘", () => {
  fresh();
  for (let i = 0; i < 3; i++) recordTurnSignal({ text: "做个东西", ep: ep({ outcome: "failed" }) });
  assert.equal(statisticalPriors().length, 0, `只有 3 条样本就出结论了（门槛 ${MIN_SUPPORT}）`);
  recordTurnSignal({ text: "做个东西", ep: ep({ outcome: "failed" }) });
  assert.ok(statisticalPriors().length > 0, "够 4 条了还不出");
  const long = "这是一句很长的话".repeat(20);
  recordTurnSignal({ text: long, ep: ep() });
  for (const r of loadSignals().ring) assert.ok(r.q.length <= 40, `落盘了 ${r.q.length} 字的原话`);
});

test("结论只能落在 6 个字段上：落不进白名单的整条丢掉", () => {
  fresh();
  const r = applyDistilledPriors([
    { when: "很短的新话题", then: "多半要先看现有代码", field: "ws", support: "6 次中 4 次" },
    { when: "模仿某个网站", then: "先真的打开那个站看", field: "rm", support: "6 次中 4 次" },
    { when: "空话一条", then: "多理解用户的需求", field: "attitude", support: "很多次" },
    { when: "短", then: "x", field: "ws" },
  ]);
  assert.equal(r.added, 2);
  assert.equal(r.dropped, 2, "非法 field 和过短的都要丢");
  assert.deepEqual(loadPriors().map((p) => p.field).sort(), ["rm", "ws"]);
  for (const f of loadPriors().map((p) => p.field)) assert.ok(PRIOR_FIELDS.includes(f));
});

test("注入量的上界由裁决的输出空间钉死，与库存量无关", () => {
  fresh();
  // 塞满：每个字段各 20 条，共 120 条候选
  const many = [];
  for (const field of PRIOR_FIELDS) {
    for (let i = 0; i < 20; i++) {
      many.push({ when: `形状 ${field} 第 ${i} 种说法`, then: `该判成 ${field} 的某个值，若干次里若干次返工`, field, support: "6 次中 4 次" });
    }
  }
  applyDistilledPriors(many);
  const picked = pickUserPriors("做成 apple 官网那种");
  assert.ok(picked.length <= MAX_INJECT, `注了 ${picked.length} 条，上限 ${MAX_INJECT}`);
  const bytes = JSON.stringify(picked.map(({ when, then, n }) => ({ when, then, n }))).length;
  assert.ok(bytes <= MAX_INJECT_BYTES + 40, `注入 ${bytes} 字节，超了 ${MAX_INJECT_BYTES}`);
  // 同一个字段只出一条：第二条只会稀释
  const fields = picked.map((p) => loadPriors().find((x) => x.id === p.id)?.field);
  assert.equal(new Set(fields).size, fields.length, "同一个字段注了两条");
});

test("挑选必须是确定性的：它会进裁决的缓存指纹", () => {
  fresh();
  applyDistilledPriors(PRIOR_FIELDS.map((field, i) => ({
    when: `第 ${i} 种说法`, then: `该判成 ${field}，6 次里 4 次返工`, field, support: "6 次中 4 次",
  })));
  const a = JSON.stringify(pickUserPriors("做个登录页"));
  clock += 1234; // 时间往前走
  const b = JSON.stringify(pickUserPriors("做个登录页"));
  assert.equal(a, b, "同一轮内两次挑选结果不同——裁决的 15 分钟缓存会整个失效");
  clock -= 1234;
});

test("冷启动：一条都没有时，注入的字节严格为零", () => {
  fresh();
  assert.deepEqual(pickUserPriors("做个登录页"), []);
  // 主循环那侧用展开注入，空数组时连键都不出现
  assert.match(MAIN, /if \(!picked\.length\) return \{\};/,
    "空的时候没有早返回，boundedContext 会多出一个空键，冷启动的字节数就变了");
});

test("判歪了自己静音：连输 3 次且没赢过 → 14 天不再被选，但不删除", () => {
  fresh();
  applyDistilledPriors([{ when: "某种说法", then: "该判成 modify，6 次里 4 次返工", field: "ws", support: "6 次中 4 次" }]);
  const id = loadPriors()[0].id;
  for (let i = 0; i < 3; i++) scorePriors([id], true);
  const p = loadPriors()[0];
  assert.equal(p.losses, 3);
  assert.ok(p.mutedUntil > 0, "连输三次还没静音");
  assert.equal(loadPriors().length, 1, "静音不等于删除——原始记忆绝不删");
  assert.deepEqual(pickUserPriors("某种说法"), [], "静音了还在被选");
  // 静音是天粒度的，不是毫秒：毫秒会让缓存指纹每次都变
  clock += 15 * DAY;
  assert.ok(pickUserPriors("某种说法").length > 0, "过了静音期还不放出来");
  clock -= 15 * DAY;
  // 赢过一次就不会因为累计三负被静音
  fresh();
  applyDistilledPriors([{ when: "另一种说法", then: "该判成 inspect，6 次里 4 次返工", field: "ws", support: "6 次中 4 次" }]);
  const id2 = loadPriors()[0].id;
  scorePriors([id2], false);
  for (let i = 0; i < 3; i++) scorePriors([id2], true);
  assert.equal(loadPriors()[0].mutedUntil, 0, "赢过的条目不该被自动静音");
});

test("A/B 按会话分组，同一个会话恒定；样本不足不给百分比", () => {
  fresh();
  setPriorsMode("ab");
  const a = priorsArm("session-abc");
  for (let i = 0; i < 5; i++) assert.equal(priorsArm("session-abc"), a, "同一个会话分组变了，读数会串味");
  setPriorsMode("on"); assert.equal(priorsArm("whatever"), 1);
  setPriorsMode("off"); assert.equal(priorsArm("whatever"), 0);
  setPriorsMode("ab");
  const few = userPriorReadout([{ pab: 1, steer: 1 }, { pab: 0 }]);
  assert.equal(few.enough, false, "两条样本就敢给结论了");
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ pab: 1, steer: i < 4 ? 1 : 0 }, { pab: 0, steer: i < 12 ? 1 : 0 });
  const r = userPriorReadout(many);
  assert.equal(r.enough, true);
  assert.equal(r.on.n, 40); assert.equal(r.off.n, 40);
  assert.ok(r.on.steer < r.off.steer, "构造的数据就是开着那边更好");
});

test("整套学歪了自己关掉：开着那半反而被纠正得更多就降到 off", () => {
  fresh();
  setPriorsMode("ab");
  const harmful = [];
  for (let i = 0; i < 40; i++) harmful.push({ pab: 1, steer: i < 20 ? 1 : 0 }, { pab: 0, steer: i < 5 ? 1 : 0 });
  assert.equal(autoDisableIfHarmful(harmful), true);
  assert.equal(priorsArm("any"), 0, "判定说该关，却没真关");
  // 样本不够时绝不擅自关闭
  fresh(); setPriorsMode("ab");
  assert.equal(autoDisableIfHarmful([{ pab: 1, steer: 1 }, { pab: 0 }]), false);
});

test("归纳喂的是统计不是流水，两块各 ≤20 行", () => {
  fresh();
  for (let i = 0; i < 60; i++) {
    recordTurnSignal({ text: `第 ${i} 句话`, ep: ep({ outcome: i % 2 ? "failed" : "success", mm: i % 2 ? ["ws_none_but_wrote"] : [] }) });
  }
  const chunks = distillUserPriorsInput();
  assert.ok(chunks.length <= 2, `切出 ${chunks.length} 块，应当最多 2 块`);
  for (const c of chunks) {
    assert.ok(c.split("\n").length <= 20, "一块超过 20 行——实测超了模型产出为 0");
  }
  // 每一行都必须带得出数，这是「不瞎猜」的底座
  assert.match(chunks[chunks.length - 1], /\d+ 次里 \d+ 次/);
  const due = distillDue();
  assert.ok(due > 0, "攒够了却不触发");
  markDistilled(due);
  assert.equal(distillDue(), 0, "记账后不该立刻又触发——那是重试风暴");
});

test("可达性：先验只进裁决的输入，不进任何 harness 闸门", () => {
  // 这条是「不瞎搞」的结构保证。先验判歪的最坏后果必须只是「裁决多考虑了一个错的先验」，
  // 不可能是「某个工具被直接夺走」——那正是这个项目在别处踩过的、代价最大的那类事故。
  // 只允许两处：注入点，以及裁决提示词里那条告诉模型「它是统计不是规矩」的律。
  // 多出任何一处都意味着有人拿它去驱动别的判断了。
  const hits = [...MAIN_CODE.matchAll(/userPriors/g)].length;
  assert.equal(hits, 2, `main.js 里 userPriors 出现了 ${hits} 次，只允许两处（注入点 + 提示词里那条律）`);
  assert.match(MAIN, /userPriors（如果有）是\*\*这台机器上这个用户\*\*过去的执行统计/,
    "那条告诉模型「先验是统计不是规矩」的律不见了——没有它，模型会把统计当成硬规则");
  const at = MAIN_CODE.indexOf("userPriors: picked");
  const ctx = MAIN_CODE.slice(Math.max(0, at - 1400), at);
  assert.ok(ctx.includes("_aiIntentContextForTurn") || ctx.includes("attachments: _aiIntentList"),
    "userPriors 不在 _aiIntentContextForTurn 里——它跑到别的地方去了");
  // 挑选和记账都只能通过模块，不许在 main.js 里现场手写第二套判据
  assert.ok(!/MIN_SUPPORT|MIN_BAD_RATE|mutedUntil/.test(MAIN_CODE),
    "main.js 里出现了先验的门槛常量——判据必须只有模块里那一份");
});

test("两条腿的作用域物理隔离：项目规律不进裁决，用户规律不进主上下文", () => {
  // 项目腿的提示词必须明说「换个仓库也成立的不要写」，否则两条腿会互相抄。
  assert.match(MAIN, /只写\*\*这个项目\*\*的规律：换个仓库也成立的话不要写/,
    "项目腿没有作用域约束，项目库会堆满「用户喜欢简洁」这类跨项目的话");
  // 用户腿的键不带 root：它是这台机器上关于这个人的事实。
  assert.ok(!/user-priors[^"']*:\s*\+|user-priors" \+ /.test(MAIN),
    "用户先验的键拼上了 root——那就变成项目作用域了");
  // 用户腿的归纳提示词必须禁止抄用户原话（原话可能带项目名、路径、人名）
  assert.match(MAIN, /不要抄用户原话/);
});
