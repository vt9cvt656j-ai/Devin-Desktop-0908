// 「那些报错不用管」不能被变成一条「没做到就不许说完成」的交付项。
//
// 验收契约的条目有两个来源：意图裁决声明的 successCriteria/constraints，
// 以及裁决没给时按标点切用户原话的正则兜底。两者此前用同一份表头，都带着
// 「未满足的条目不得声称完成」这条硬规则。而切出来的东西经常是**排除项**：
//   「把登录页做出来，然后 lsp 172 个报错那些属于正常的没影响，不用管」
//     → ["把登录页做出来，", "lsp 172 个报错那些属于正常的没影响，不用管"]
// 第二条被当成必须满足的交付项 —— 一句「不用管」变成了「必须做到」。
//
// **来源必须按条目记，不能按轮记。** 清单是跨轮合并的，而等裁决的窗口每会话只付
// 一次，第二轮起裁决常常赶不上。按轮记一个布尔的话，第一轮真正声明出来的判据会
// 连坐被降级，收尾评审还会拿到空契约 —— 那比不分来源更糟（这个回归真的发生过）。

import test from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, load, fnSource } from "./helpers/source.mjs";
import { acceptanceContractBlock, extractRequirementsChecklist as _extractRequirementsChecklist, mergeRequirementsChecklist as _mergeRequirementsChecklist } from "../src/agent/acceptance-contract.js";

const block = acceptanceContractBlock;
const split = _extractRequirementsChecklist;

const DECL = ["登录接口返回真实鉴权结果", "不要动 payments 模块"];
const SOFT = "lsp 172 个报错那些属于正常的没影响，不用管";

test("正则确实会把一句「不用管」切成一条独立条目（这是问题的起点）", () => {
  const items = split("把登录页做出来，然后 lsp 172 个报错那些属于正常的没影响，不用管");
  assert.equal(items.length, 2);
  assert.match(items[1], /不用管/,
    "切分行为变了 —— 下面几条断言的前提没了，重新确认这个修复还有没有必要");
});

test("声明的是硬验收项，切出来的降级成「用户原话」，两段同时在场", () => {
  const out = block([...DECL, SOFT], 900, { declared: DECL });
  assert.match(out, /验收契约/, "声明的条目没走验收契约表头");
  assert.match(out, /未满足的条目不得声称完成/, "硬规则被一起删掉了 —— 那会给假完成开正门");
  assert.match(out, /不是逐条验收项/, "切出来的没有降级");
  assert.match(out, /排除项/, "没提醒里面可能是排除项，模型还是会把它当待办去做");
  // 硬规则不能落在原话那一段上。
  const softAt = out.indexOf("用户原话");
  assert.ok(out.indexOf("未满足的条目不得声称完成") < softAt,
    "原话那一段也带上了硬规则");
});

test("**跨轮不连坐**：这一轮没有新声明，往轮声明过的条目仍是硬验收项", () => {
  // 这正是按轮记布尔时的回归：第二轮裁决赶不上 → 整份清单被降级 → 评审裸评。
  const out = block([...DECL, "继续"], 900, { declared: DECL });
  assert.match(out, /验收契约/, "往轮声明过的判据被连坐降级了");
  assert.match(out, /登录接口返回真实鉴权结果/);
  // 「继续」是这一轮切出来的，它才该降级。
  assert.match(out, /用户原话/);
});

test("评审只拿声明出来的那一份", () => {
  const only = block([...DECL, SOFT], 900, { declared: DECL, contractOnly: true });
  assert.match(only, /未满足的条目不得声称完成/);
  assert.doesNotMatch(only, /不用管/, "排除项进了评审的契约 —— 它会判「没做完」");
  assert.doesNotMatch(only, /用户原话/);
  // 一条声明的都没有 → 空契约，而不是拿原话去凑。
  assert.equal(block([SOFT], 900, { declared: [], contractOnly: true }), "",
    "没有声明判据时给评审塞了原话 —— 那是语义相反的清单");
});

test("不传 declared 时沿用历史语义（全按声明），靠守卫保证调用点都传", () => {
  // 既有测试钉着这个默认（格式契约：固定前缀 + 硬规则尾注），不该顺手翻掉。
  // 真正的风险是「调用点忘了传来源」，那由下面那条守卫盯着，不靠默认值兜。
  const out = block([SOFT], 500);
  assert.match(out, /未满足的条目不得声称完成/, "默认语义被改了 —— 会打翻既有的格式契约");
});

test("空清单返回空串，不留一个孤零零的表头", () => {
  assert.equal(block([], 500, { declared: DECL }), "");
  assert.equal(block(null, 500, {}), "");
});

test("来源按条目在会话上累积，且换任务时清空", () => {
  assert.match(SRC, /session\._acceptanceDeclaredItems = \[\.\.\.new Set\(\[\.\.\._declaredSeen, \.\.\._declared\]\)\]/,
    "声明过的条目没有跨轮累积 —— 第二轮裁决赶不上就会连坐降级");
  assert.match(SRC, /_rel0 === "new" \|\| _rel0 === "replace"\)\s*\?\s*\[\]/,
    "换任务时没有清空旧判据 —— 上一个任务的验收项会挟持新任务");
});

test("两处评审调用点都只传声明出来的那一份", () => {
  const loop = fnSource("_runAgenticLoop");
  const hits = loop.match(/contractOnly: true/g) || [];
  assert.ok(hits.length >= 2,
    "收尾评审/方向检查里还有调用点在传完整清单 —— 排除项会让它判「没做完」");
  assert.doesNotMatch(loop, /contract: _acceptanceContractBlock\(run\._requirementsChecklist\),/,
    "还有调用点在无条件传契约");
});
