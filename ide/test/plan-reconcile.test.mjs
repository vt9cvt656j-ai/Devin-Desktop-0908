// update_plan 交上来的状态要过两条结构性底线：一次只做一步、没做完不许勾。
//
// 用户实拍（2026-09-05）：计划本身列得挺准，执行时「没完成的就勾住了」、「第二个和第四个
// 同时在做」。两种形状都是声明守不住、只能由结构守住的。真往返，不查源码文本。
import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePlanUpdate } from "../src/agent/plan-reconcile.js";

const st = (content, status = "pending", extra = {}) => ({ content, status, ...extra });
const statuses = (steps) => steps.map((s) => s.status);

test("交上来两步同时进行中：只留一步，其余退回待办，并把话说明白", () => {
  const prev = [st("调研", "in_progress", { startedAt: { iter: 0, evidence: 0 } }), st("确定路径"), st("写爬虫"), st("实跑")];
  const next = [st("调研", "completed"), st("确定路径", "in_progress"), st("写爬虫"), st("实跑", "in_progress")];
  const out = reconcilePlanUpdate({ prev, next, iter: 2, evidence: 3 });
  assert.deepEqual(statuses(out.steps), ["completed", "in_progress", "pending", "pending"]);
  assert.ok(out.changed);
  assert.match(out.notes.join("\n"), /一次只做一步/);
  assert.match(out.notes.join("\n"), /「实跑」退回待办/);
});

test("两步都新进入进行中时，保留上一版就在进行中的那一步（连续性）", () => {
  const prev = [st("a"), st("b", "in_progress", { startedAt: { iter: 1, evidence: 1 } }), st("c")];
  const next = [st("a", "in_progress"), st("b", "in_progress"), st("c")];
  const out = reconcilePlanUpdate({ prev, next, iter: 2, evidence: 2 });
  assert.deepEqual(statuses(out.steps), ["pending", "in_progress", "pending"]);
});

test("没经过进行中就标完成 → 退回待办（这就是「没完成的就勾住了」）", () => {
  const prev = [st("调研", "in_progress", { startedAt: { iter: 0, evidence: 0 } }), st("确定路径"), st("写爬虫"), st("实跑")];
  const next = [st("调研", "completed"), st("确定路径", "completed"), st("写爬虫", "in_progress"), st("实跑")];
  const out = reconcilePlanUpdate({ prev, next, iter: 3, evidence: 4 });
  assert.deepEqual(statuses(out.steps), ["completed", "pending", "in_progress", "pending"],
    "第 2 步从没进入过进行中，不能直接勾掉；第 1 步是当前步、有证据，照收");
  assert.match(out.notes.join("\n"), /「确定路径」没经过进行中就被标成完成/);
});

test("刚标进行中、同一轮一次工具都没跑就标完成 → 留在进行中", () => {
  const prev = [st("调研", "in_progress", { startedAt: { iter: 2, evidence: 5 } }), st("写爬虫")];
  const next = [st("调研", "completed"), st("写爬虫", "in_progress")];
  const out = reconcilePlanUpdate({ prev, next, iter: 2, evidence: 5 });
  assert.deepEqual(statuses(out.steps), ["in_progress", "pending"],
    "当前步没有新证据就不能完成；下一步也不能同时进行中");
  assert.match(out.notes.join("\n"), /这之后一次工具都没跑/);
});

test("当前步之后跑过工具（证据涨了）或跨过一轮，就照收完成，并让下一步进入进行中", () => {
  const prev = [st("调研", "in_progress", { startedAt: { iter: 2, evidence: 5 } }), st("写爬虫")];
  const byEvidence = reconcilePlanUpdate({ prev, next: [st("调研", "completed"), st("写爬虫", "in_progress")], iter: 2, evidence: 6 });
  assert.deepEqual(statuses(byEvidence.steps), ["completed", "in_progress"]);
  assert.equal(byEvidence.changed, false);
  assert.deepEqual(byEvidence.notes, []);
  const byTurn = reconcilePlanUpdate({ prev, next: [st("调研", "completed"), st("写爬虫", "in_progress")], iter: 3, evidence: 5 });
  assert.deepEqual(statuses(byTurn.steps), ["completed", "in_progress"]);
  // 新进入进行中的那一步记下起点，下一次「有没有做过事」就按它算。
  assert.deepEqual(byTurn.steps[1].startedAt, { iter: 3, evidence: 5 });
});

test("第一份计划：开局前做过的事列成 completed 是记账，本轮有证据就照收；没有证据就退回", () => {
  const first = [st("看了项目结构", "completed"), st("写爬虫", "in_progress"), st("实跑")];
  const withEvidence = reconcilePlanUpdate({ prev: [], next: first, iter: 1, evidence: 2 });
  assert.deepEqual(statuses(withEvidence.steps), ["completed", "in_progress", "pending"]);
  const noEvidence = reconcilePlanUpdate({ prev: [], next: first, iter: 0, evidence: 0 });
  assert.deepEqual(statuses(noEvidence.steps), ["pending", "in_progress", "pending"]);
  assert.match(noEvidence.notes.join("\n"), /本轮还没有任何执行证据/);
});

test("没有任何一步在进行中时，把第一个待办提成当前步并记起点", () => {
  const out = reconcilePlanUpdate({ prev: [], next: [st("a"), st("b")], iter: 0, evidence: 0 });
  assert.deepEqual(statuses(out.steps), ["in_progress", "pending"]);
  assert.deepEqual(out.steps[0].startedAt, { iter: 0, evidence: 0 });
});

test("上一版的记账（起点、证据数）跟着步骤文字带到新版；早就完成的原样", () => {
  const prev = [st("a", "completed", { advancedBy: { tool: "write", iter: 3 } }), st("b", "in_progress", { startedAt: { iter: 4, evidence: 7 }, evidence: 2 })];
  const out = reconcilePlanUpdate({ prev, next: [st("a", "completed"), st("b", "in_progress")], iter: 5, evidence: 9 });
  assert.equal(out.changed, false);
  assert.deepEqual(out.steps[0].advancedBy, { tool: "write", iter: 3 });
  assert.deepEqual(out.steps[1].startedAt, { iter: 4, evidence: 7 });
  assert.equal(out.steps[1].evidence, 2);
});

test("纯函数：不改传进来的对象", () => {
  const prev = [st("a", "in_progress", { startedAt: { iter: 0, evidence: 0 } })];
  const next = [st("a", "completed"), st("b", "completed")];
  const snap = JSON.stringify({ prev, next });
  reconcilePlanUpdate({ prev, next, iter: 0, evidence: 0 });
  assert.equal(JSON.stringify({ prev, next }), snap);
});

test("脏输入不崩：非数组、空元素", () => {
  assert.deepEqual(reconcilePlanUpdate({ prev: null, next: null }).steps, []);
  assert.deepEqual(statuses(reconcilePlanUpdate({ prev: [null], next: [null, st("x")] }).steps), ["in_progress"]);
});
