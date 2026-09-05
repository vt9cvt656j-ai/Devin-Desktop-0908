// 崩溃恢复的提示语与「思考默认展开」：纯函数真行为测试（src/agent/draft-recovery.js）。
// 复现用户报的 bug：被打断在写正文之前时，提示语不能再指着空白说「以下为已生成的部分」。
import test from "node:test";
import assert from "node:assert/strict";
import { recoveredDraftNotice, recoveredThinkingOpen } from "../src/agent/draft-recovery.js";

test("被打断在写正文之前（只有思考）：不再说「已生成的部分」在下面，改为指向上方已思考", () => {
  const n = recoveredDraftNotice({ hasText: false, hasReason: true, hasSteps: false });
  assert.doesNotMatch(n, /以下为已生成的部分/, "这句会指着空白骗人——正是本次要根除的");
  assert.match(n, /写出正文之前/);
  assert.match(n, /上方「已思考」/, "得告诉用户实质内容(思考)在上面那张卡里");
  assert.doesNotMatch(n, /下面是这轮做过的步骤/, "没有步骤时不能说下面有步骤");
});

test("被打断在写正文之前、且有工具步骤：思考指上方、步骤指下方，两条都摆明", () => {
  const n = recoveredDraftNotice({ hasText: false, hasReason: true, hasSteps: true });
  assert.match(n, /上方「已思考」/);
  assert.match(n, /下面是这轮做过的步骤/);
});

test("只有步骤、没思考没正文：只指步骤，不谎称有思考", () => {
  const n = recoveredDraftNotice({ hasText: false, hasReason: false, hasSteps: true });
  assert.match(n, /下面是这轮已经做过的步骤/);
  assert.doesNotMatch(n, /已思考/);
});

test("确实写出了正文：说「下面是已经写出的部分」，因为正文真的接在后面", () => {
  const n = recoveredDraftNotice({ hasText: true, hasReason: true, hasSteps: true });
  assert.match(n, /下面是已经写出的部分/);
  assert.doesNotMatch(n, /写出正文之前/);
});

test("三通道都空这种不该发生的情形也不吹牛", () => {
  assert.match(recoveredDraftNotice({ hasText: false, hasReason: false, hasSteps: false }), /没有可恢复的正文内容/);
});

test("思考默认展开：只有正文为空且有思考时才展开；有正文时按普通历史折叠", () => {
  assert.equal(recoveredThinkingOpen({ hasText: false, hasReason: true }), true, "思考是唯一实质内容时必须默认展开");
  assert.equal(recoveredThinkingOpen({ hasText: true, hasReason: true }), false, "有正文就别改变普通历史的折叠观感");
  assert.equal(recoveredThinkingOpen({ hasText: false, hasReason: false }), false, "没思考就没什么可展开");
});
