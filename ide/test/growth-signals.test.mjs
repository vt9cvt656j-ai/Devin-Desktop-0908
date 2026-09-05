// 成长模型（src/growth.js）的信号改成执行事实之后的行为往返。
// 背景（2026-09-05 实测产品所有者的档案）：6 项能力 4 项钉在地板 0.14，"未看就接受率" 70%，
// 平均掌握度 0.42 → 被判新手、拿最窄工具窗口。病在信号是界面事件，不在 BKT。
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true, writable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
});
const growth = await import("../src/growth.js");
const KEY = "michael-ide.learner-model.v1";
const st = () => JSON.parse(store.get(KEY));
function reset() { store.clear(); growth._resetForTests(); }

test("验证过的运行里没点开 diff 不算闭眼；没验证过才算", () => {
  reset();
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a", projectName: "a" });
  growth.signal("edit-applied", {}); growth.signal("edit-applied", {});
  growth.signal("run-complete", { verified: true, outcome: "success", wroteFiles: true, asked: 0 });
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a" });   // 对账上一轮
  assert.equal(st().stats.blind, 0, "验证过的改动被记成了闭眼接受");
  const pAfterVerified = st().skills.reviewing.p;
  assert.ok(pAfterVerified > 0.25, `干净的一轮该是审查的正证据，现在 p=${pAfterVerified}`);

  reset();
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a", projectName: "a" });
  growth.signal("edit-applied", {}); growth.signal("edit-applied", {});
  growth.signal("run-complete", { verified: false, outcome: "success", wroteFiles: true });
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a" });
  assert.equal(st().stats.blind, 2, "没验证过、也没看，就是闭眼");
});

test("返工是审查和表达的负证据；问 0 次做成是表达的正证据，问 ≥2 次是负证据", () => {
  reset();
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a", projectName: "a" });
  const p0 = st().skills.reviewing.p;
  growth.signal("run-complete", { verified: true, outcome: "success", reworked: true });
  assert.ok(st().skills.reviewing.p < p0, "返工没有压低审查估计");
  assert.equal(st().stats.reworks, 1);

  reset();
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a", projectName: "a" });
  const q0 = st().skills.prompting.p;
  growth.signal("run-complete", { verified: true, outcome: "success", asked: 0 });
  assert.ok(st().skills.prompting.p > q0, "一次问清、做成，表达估计没涨");
  growth.signal("run-complete", { verified: true, outcome: "partial", asked: 3 });
  assert.equal(st().stats.asked, 3);
});

test("字数不再决定「表达需求」：20 字的指令不扣分", () => {
  reset();
  growth.signal("message-sent", { mode: "agent", len: 20, project: "/a", projectName: "a" });
  assert.equal(st().skills.prompting.n, 0, "按字数判表达的老规则还在");
});

test("经验档位只看用量和项目广度：862 轮 / 32 个项目的人是 seasoned，不管 BKT 怎么说", () => {
  reset();
  for (let i = 0; i < 61; i++) growth.signal("message-sent", { mode: "agent", len: 10, project: i % 2 ? "/a" : "/b", projectName: "x" });
  assert.equal(growth.getExperienceTier(), "seasoned");
  reset();
  for (let i = 0; i < 61; i++) growth.signal("message-sent", { mode: "agent", len: 10, project: "/a", projectName: "x" });
  assert.equal(growth.getExperienceTier(), "new", "只在一个项目里用过，广度不够");
});

test("factsFromRun：问几次 / 上一条被返工 / 改没改文件，全从账本和档案读", () => {
  const run = {
    _toolLedger: { entries: [{ tool: "read_file", ok: true }, { tool: "ask_user", ok: true }, { tool: "ask_user", ok: true }] },
    recording: [{ type: "read", label: "读取 a" }, { type: "edit", label: "编辑 b" }],
  };
  const eps = [{ ts: "2026-09-05T10:00:00", outcome: "success", reworkedAt: "2026-09-05T10:10:00" }, { ts: "2026-09-05T10:10:00", outcome: "success" }];
  assert.deepEqual(growth.factsFromRun(run, eps, "success"), { asked: 2, reworked: true, wroteFiles: true, outcome: "success" });
  assert.deepEqual(growth.factsFromRun({ recording: [] }, [], "partial"), { asked: 0, reworked: false, wroteFiles: false, outcome: "partial" });
  // 上一条虽有 reworkedAt 但不是被这一条返工的（时间对不上）→ 不算
  assert.equal(growth.factsFromRun(run, [{ ts: "a", reworkedAt: "x" }, { ts: "b" }], "success").reworked, false);
});
