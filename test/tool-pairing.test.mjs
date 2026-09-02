// tool_call ↔ tool_result 配对：**真往返**，不查源码文本。
//
// 旧的守卫（test/interrupt-transcript.test.mjs）通篇是源码正则，而且断的是「至少三个
// 调用点」——一个数够三个的断言，结构上不可能发现缺的是第四条路。这一组换成对着
// 真实的消息数组跑，「assistant 带 2 个 tool_call、只有 1 条结果」这种形状直接构造出来。
import test from "node:test";
import assert from "node:assert/strict";
import { repairToolPairing, MISSING_TOOL_RESULT } from "../src/agent/tool-pairing.js";
import { SRC } from "./helpers/source.mjs";

const call = (id, name = "read_file") => ({ id, type: "function", function: { name, arguments: "{}" } });
const asst = (...ids) => ({ role: "assistant", content: "", tool_calls: ids.map((i) => call(i)) });
const res = (id, content = "ok") => ({ role: "tool", tool_call_id: id, content });
/**
 * 这一次修复**新补了**哪些 id。从修复前后的差集算，不另设一个诊断函数
 * （那个函数在生产里没有消费者，会被「死函数只减不增」那条闸拦下）。
 */
const newlyFilled = (msgs) => {
  const before = new Set((msgs || []).filter((m) => m?.role === "tool").map((m) => m.tool_call_id));
  return repairToolPairing(msgs)
    .filter((m) => m?.role === "tool" && !before.has(m.tool_call_id))
    .map((m) => m.tool_call_id);
};

test("配好的原样返回——连数组都不重建（这条跑在每一次请求的出线口上）", () => {
  const msgs = [{ role: "user", content: "hi" }, asst("a", "b"), res("a"), res("b")];
  assert.equal(repairToolPairing(msgs), msgs, "本来就齐却重建了数组");
  assert.deepEqual(newlyFilled(msgs), []);
});

test("assistant 带 2 个调用、只回来 1 条结果 —— 补齐缺的那条", () => {
  // 这正是「用户在工具批次执行途中按停」留下的形状。
  const msgs = [asst("a", "b"), res("a", "第一条跑完了")];
  assert.deepEqual(newlyFilled(msgs), ["b"]);

  const out = repairToolPairing(msgs);
  const tools = out.filter((m) => m.role === "tool");
  assert.equal(tools.length, 2, "没补齐");
  assert.equal(tools[1].tool_call_id, "b");
  assert.equal(tools[0].content, "第一条跑完了", "把真实结果覆盖掉了");
  assert.deepEqual(newlyFilled(out), [], "补完再跑一遍还在补 —— 不幂等");
});

test("补进去的话必须**明说没执行**，不能让模型当成成功", () => {
  const out = repairToolPairing([asst("x")]);
  const filled = out.find((m) => m.role === "tool");
  assert.equal(filled.content, MISSING_TOOL_RESULT);
  assert.match(filled.content, /不要把它当成已完成/,
    "补的这条没有明说「别当成完成」—— 模型看到调用没有结果反驳它，默认就是成功");
  assert.match(filled.content, /没有产生任何结果/, "没有否认它产生过效果");
});

test("补在**发起它的那条 assistant 之后**，不是甩到数组末尾", () => {
  // 协议要求工具结果紧跟发起方；模型读到的顺序也就是它推理这一步时的顺序。
  const msgs = [asst("a"), { role: "user", content: "插了一句" }, asst("b"), res("b")];
  const out = repairToolPairing(msgs);
  const i = out.findIndex((m) => m.role === "tool" && m.tool_call_id === "a");
  assert.equal(i, 1, `补错位置（在第 ${i} 位）—— 应该紧跟第 0 条 assistant`);
  assert.equal(out[2].role, "user", "把后面的消息顺序打乱了");
});

test("幂等：补过的再跑一遍不变", () => {
  const once = repairToolPairing([asst("a", "b"), res("a")]);
  const twice = repairToolPairing(once);
  assert.equal(twice, once, "第二遍又重建了数组（说明它认为还缺）");
  assert.deepEqual(newlyFilled(twice), []);
});

test("并发批次：结果顺序和调用顺序不一致也算配上了", () => {
  // 分区并发执行器不保证回来的顺序，只看紧邻的下一条会误判成缺席、白补一条。
  const msgs = [asst("a", "b", "c"), res("c"), res("a"), res("b")];
  assert.equal(repairToolPairing(msgs), msgs, "把乱序的结果误判成缺席了");
});

test("**孤儿结果一律不动**——那是证据，不是协议噪声", () => {
  // 正常来源是历史从前面被压缩掉了：assistant 没了，tool 结果还在。
  // 为了让协议好看就把它删掉，等于丢用户的内容。要修该在压缩那侧保住成对关系。
  const msgs = [res("gone", "这条结果里有真实证据"), asst("a"), res("a")];
  const out = repairToolPairing(msgs);
  assert.equal(out, msgs, "动了孤儿结果");
  assert.ok(out.some((m) => m.content === "这条结果里有真实证据"), "证据被删了");
});

test("脏数据不崩：空 id、非数组 tool_calls、null 元素", () => {
  const msgs = [
    null,
    { role: "assistant", tool_calls: "不是数组" },
    { role: "assistant", tool_calls: [{ id: "" }, { id: null }, call("ok")] },
    { role: "tool", tool_call_id: "" },
  ];
  const out = repairToolPairing(msgs);
  const filled = out.filter((m) => m?.role === "tool" && m.content === MISSING_TOOL_RESULT);
  assert.equal(filled.length, 1, "空 id 也被当成待补的调用了");
  assert.equal(filled[0].tool_call_id, "ok");
  assert.deepEqual(repairToolPairing([]), []);
  assert.deepEqual(repairToolPairing(null), []);
});

test("接线：两条请求路径共同的出线口上真的调了它", () => {
  // 光有纯函数不算数。_sanitizeProviderMessages 是 chat / agent 两条路的最后一道出线口。
  assert.match(SRC, /const source = repairToolPairing\(Array\.isArray\(messages\) \? messages : \[\]\);/,
    "出线口没有做配对修复 —— 循环里逐条 break 路径漏掉的空洞就会一路发到上游");
});
