// 任务契约的耐久一半 → 项目核心（src/agent/core-capture.js promoteContractGoal）。
// 一轮的目标不等于项目的目标：只有裁决判成项目级交付、且做成的那轮才升；目标演进时替换不并存。
import test from "node:test";
import assert from "node:assert/strict";
import { configureCoreMemory, coreActive } from "../src/agent/core-memory.js";
import { promoteContractGoal } from "../src/agent/core-capture.js";

function fresh() { const m = new Map(); configureCoreMemory({ storage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }, mirror: async () => {} }); }

test("项目级交付 + 做成 → 目标进项目核心；非项目级 / 没做成 / 太短 都不进", () => {
  fresh();
  assert.ok(promoteContractGoal("/r", { projectScope: true }, { goal: "做一个二手书交易网站" }, "success"));
  assert.deepEqual(coreActive("/r").map((e) => [e.kind, e.text, e.source]), [["goal", "目标：做一个二手书交易网站", "agent"]]);
  assert.equal(promoteContractGoal("/r", { bug: true }, { goal: "修复登录页在 Safari 上报错" }, "success"), null, "一轮的目标被当成了项目目标");
  assert.equal(promoteContractGoal("/r", { fullWebsite: true }, { goal: "做一个博客站" }, "partial"), null, "没做成的不升");
  assert.equal(promoteContractGoal("/r", { fullWebsite: true }, { goal: "改一下" }, "success"), null, "太短的不升");
  assert.equal(coreActive("/r").length, 1);
});

test("目标演进：相似的旧目标被替换，不并存；不相似的另起一条", () => {
  fresh();
  promoteContractGoal("/r", { projectScope: true }, { goal: "做一个二手书交易网站" }, "success");
  promoteContractGoal("/r", { projectScope: true }, { goal: "做一个二手书交易网站，先做首页和搜索" }, "success");
  let goals = coreActive("/r").filter((e) => e.kind === "goal").map((e) => e.text);
  assert.deepEqual(goals, ["目标：做一个二手书交易网站，先做首页和搜索"], `目标该被替换而不是并存：${goals.join(" | ")}`);
  promoteContractGoal("/r", { websiteDelivery: true }, { goal: "把管理后台也做出来" }, "success");
  goals = coreActive("/r").filter((e) => e.kind === "goal").map((e) => e.text);
  assert.equal(goals.length, 2, "不相似的目标该另起一条");
});
