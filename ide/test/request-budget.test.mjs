// 请求预算（src/agent/request-budget.js）的真往返：字节上限下按优先级裁、📌 边界保住、最新报错豁免、
// 裁不下就抛终态错误；上下文溢出的硬挤压幂等。
import assert from "node:assert/strict";
import test from "node:test";
import {
  _REQUEST_MARKERS, _MODEL_REQUEST_BODY_BYTE_CAP, _enforceModelRequestBudget, _isContextOverflowAiError, _squeezeMessagesForContext,
} from "../src/agent/request-budget.js";

const bytesOf = (messages, tools = []) => Buffer.byteLength(JSON.stringify({ messages, tools }), "utf8");
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("两种请求边界标记都在；默认上限是个真数字", () => {
  assert.ok(_REQUEST_MARKERS.some((m) => m.includes("This turn's user request")));
  assert.ok(_REQUEST_MARKERS.some((m) => m.includes("用户本次请求")));
  assert.ok(_MODEL_REQUEST_BODY_BYTE_CAP > 1_000_000);
});

test("预算内：返回的是请求专用副本，内容逐字节相同，tool_calls 的 function 对象也是拷贝", () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "assistant", content: "", tool_calls: [call("c1", "read_file", { path: "a.js" })] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", content: "next" },
  ];
  const out = _enforceModelRequestBudget(messages, [], 10_000);
  assert.notEqual(out, messages);
  assert.deepEqual(out, messages);
  assert.notEqual(out[1].tool_calls[0].function, messages[1].tool_calls[0].function);
});

test("超限先换掉历史 write_file 的大参数（保留 path），源消息不动", () => {
  const big = { path: "src/a.js", content: "x".repeat(6000) };
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [call("c1", "write_file", big)] },
    { role: "tool", tool_call_id: "c1", content: "written" },
    { role: "user", content: "next" },
  ];
  const cap = bytesOf(messages) - 1000;
  const out = _enforceModelRequestBudget(messages, [], cap);
  const args = JSON.parse(out[2].tool_calls[0].function.arguments);
  assert.equal(args.path, "src/a.js");
  assert.match(args.content, /^\[historical write_file argument omitted; original UTF-8 bytes: \d+\]$/);
  assert.equal(JSON.parse(messages[2].tool_calls[0].function.arguments).content.length, 6000, "源消息被改了");
  assert.ok(bytesOf(out) <= cap);
});

test("带 📌 边界的旧消息只压边界之前的动态前导，边界起的正文整段保住", () => {
  const marker = _REQUEST_MARKERS[0];
  const content = "A".repeat(3000) + "\n" + "━".repeat(10) + "\n" + marker + "do X\n" + "B".repeat(2000);
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
  ];
  const cap = bytesOf(messages) - 1500;
  const out = _enforceModelRequestBudget(messages, [], cap);
  assert.ok(out[1].content.length < content.length);
  assert.ok(out[1].content.startsWith("AAAA"));
  assert.ok(out[1].content.includes(marker + "do X"), "边界被折掉了：网关 latest_user_request 会漂到编排提示上");
  assert.ok(out[1].content.endsWith("B".repeat(2000)));
});

test("最新一条带报错的工具结果豁免对折，旧的长结果照常裁", () => {
  const plain = "p".repeat(3000);
  const err = "Error: boom\n" + "e".repeat(3000);
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [call("c1", "run_cmd", { command: "a" }), call("c2", "run_cmd", { command: "b" })] },
    { role: "tool", tool_call_id: "c1", content: plain },
    { role: "tool", tool_call_id: "c2", content: err },
    { role: "user", content: "next" },
  ];
  const cap = bytesOf(messages) - 1000;
  const out = _enforceModelRequestBudget(messages, [], cap);
  assert.ok(out[3].content.length < plain.length, "旧的长结果该被裁");
  assert.equal(out[4].content, err, "模型即将思考的那条报错必须全量在场");
});

test("怎么裁都放不下：抛 MODEL_REQUEST_TOO_LARGE，这一轮是终态", () => {
  const messages = [{ role: "user", content: "z".repeat(50_000) }];
  assert.throws(() => _enforceModelRequestBudget(messages, [], 1024), (e) => e instanceof RangeError && e.code === "MODEL_REQUEST_TOO_LARGE" && e.byteCap === 1024);
});

test("_isContextOverflowAiError：只认上下文溢出，不认 413 和网络抖动", () => {
  assert.equal(_isContextOverflowAiError("400 context_length_exceeded"), true);
  assert.equal(_isContextOverflowAiError("prompt is too long: 210000 tokens"), true);
  assert.equal(_isContextOverflowAiError("413 payload too large"), false);
  assert.equal(_isContextOverflowAiError("socket hang up"), false);
});

test("_squeezeMessagesForContext：旧 tool_calls 大参数换桩（最后一组不动）、旧长结果硬截断、幂等", () => {
  const bigArgs = { path: "src/big.js", content: "y".repeat(3000) };
  const messages = [
    { role: "user", content: "u0" },
    { role: "assistant", content: "", tool_calls: [call("c1", "write_file", bigArgs)] },
    { role: "tool", tool_call_id: "c1", content: "r".repeat(2000), _ideMeta: { kind: "read" } },
    { role: "user", content: "u1" },
    { role: "assistant", content: "", tool_calls: [call("c2", "write_file", bigArgs)] },
    { role: "tool", tool_call_id: "c2", content: "short" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `u${i + 2}` })),
  ];
  assert.equal(_squeezeMessagesForContext(messages), true);
  const stub = JSON.parse(messages[1].tool_calls[0].function.arguments);
  assert.equal(stub.path, "src/big.js");
  assert.match(stub._summarized, /已省略/);
  assert.equal(JSON.parse(messages[4].tool_calls[0].function.arguments).content.length, 3000, "最后一组 assistant+tool 配对不动，模型要靠它接续");
  assert.ok(messages[2].content.length < 2000 && messages[2].content.endsWith("需要就重新获取）"));
  assert.equal(messages[2]._ideMeta.contextAvailable, false, "读取结果被截了就要标成上下文里不再有全文");
  assert.equal(messages[5].content, "short");
  assert.equal(_squeezeMessagesForContext(messages), false, "第二次没有可压的：幂等");
});
