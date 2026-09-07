import test from "node:test";
import assert from "node:assert";
import { CODE } from "./helpers/source.mjs";
import { withRoleNote } from "../src/agent/subagent-roles.js";
const NOTE = "[role:security] 声明的模型 x 不在可用清单里，已继承父体的模型";

test("换模型的注记不许把状态前缀挤出第 0 位", () => {
  const err = withRoleNote("[ERROR] 上游 429\n详情若干", NOTE);
  assert.match(err, /^\[ERROR\]/, "报错前缀被挤走，四处消费方全部落空");
  assert.ok(err.includes("[role:security]"), "注记丢了——父体就无从解释简报口吻为何变了");
  // 只有一行的报错同样要成立：没有 \n 可插的时候不能退回前置。
  assert.match(withRoleNote("[ERROR] 就一行", NOTE), /^\[ERROR\]/);
  assert.match(withRoleNote("[轮次用尽·未完成] 截断了", NOTE), /^\[轮次用尽·未完成\]/);
  // 没有前缀的正常简报仍然前置——注记要在最显眼的位置。
  assert.ok(withRoleNote("一份正常简报", NOTE).startsWith(NOTE));
  // 幂等：这条会在重试路径上被走到不止一次。
  assert.equal(withRoleNote(err, NOTE), err);
});

test("四处消费方确实锚在开头——本测试的前提（用剥掉注释的 CODE 数，否则会数到自己写的注释）", () => {
  // 前提没了这条测试就是空守。这四处任何一处改成 includes，都该在这里被看见。
  const anchored = [...CODE.matchAll(/\/\^\\\[ERROR\\\]\//g)].length;
  assert.ok(anchored >= 3, `锚在开头的 [ERROR] 判据只剩 ${anchored} 处`);
  assert.match(CODE, /job\.status = "failed"/);
  assert.match(CODE, /it\.call\._wiki && report && !\/\^\\\[ERROR\\\]\/\.test\(report\) && root/,
    "wiki 落盘闸变了——报错正文会被当成 wiki 写进磁盘，dest 由模型给");
});

test("调用点接的是这个函数，不是原来的无条件前置", () => {
  assert.match(CODE, /report = _withRoleNote\(report, _roleModelNote\)/);
  assert.doesNotMatch(CODE, /report = `\$\{_roleModelNote\}\\n\\n\$\{report\}`/,
    "无条件前置回来了");
});
