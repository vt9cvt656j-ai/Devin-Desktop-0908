// 思考签名的跨轮回传 —— 两端必须用同一个字段名，且这条链一处都不能断。
//
// 为什么要有这个文件：这条链断掉的时候**什么都不会报错**。网关照样回思考文字、
// 客户端照样出思考卡、上游照样返 200。唯一的症状是模型每调一次工具就看不见自己
// 上一轮的推理 —— 一个只能从「它怎么越做越笨」反推的故障。以前它就是这么断着的
// （`signature_delta` 事件在网关落到 `_ => {}` 被静默吞掉，全链路搜 signature 零命中）。
//
// 网关那半边的判据在 server 里跑真往返（models.rs::a_thinking_signature_survives_...
// 和 thinking_replay 那 8 条）。这里只守**跨语言的那道握手**：字段名是两个仓库各写
// 一次的字符串常量，改一边另一边静默失效，没有任何编译器或类型能发现。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CODE } from "./helpers/source.mjs";

// 读在 test 体内：worktree 里读不到仓库外的文件会 ENOENT，放在模块顶层会让**整个文件
// 一条断言都不跑**却看着像通过（本仓库为此吃过一次亏）。放这里至少是响亮地红。
function gatewayField() {
  const rs = fs.readFileSync("../server/src/thinking_replay.rs", "utf8");
  const m = rs.match(/pub\(crate\) const FIELD: &str = "([a-z_]+)";/);
  assert.ok(m, "网关侧的 FIELD 常量不见了或改了形状");
  return m[1];
}

test("两端用的是同一个字段名，而且客户端四处都接上了", () => {
  const F = gatewayField();

  // ① 流式 delta 里把签名块收下来。
  //
  // **注意这里守的是网页版那条路**（_realAiFetch 里的 SSE 解析）。桌面端的流式是
  // Rust 侧发事件，是**另一条独立的路** —— 只改这一条的话真正的产品一个字节都拿不到
  // （这个坑真的踩了一次）。桌面端那条由 test/refusal-is-not-a-blip.test.mjs 守。
  assert.match(CODE, new RegExp(`Array\\.isArray\\(d\\.${F}\\)`),
    `网页版没从流式 delta 里读 ${F} —— 签名到不了客户端，这条链的第一段就断了`);

  // ② 攒进这一轮的累加器
  assert.match(CODE, /kind: "reasoningBlocks", blocks: d\.reasoning_blocks/,
    "收到了但没派发成事件");
  assert.match(CODE, /ev\.kind === "reasoningBlocks"[\s\S]{0,200}reasoningBlocks\.push\(b\)/,
    "事件没被消费 —— 签名收到了又扔了");

  // ③ 跟着 turn 返回
  assert.match(CODE, /^\s*reasoningBlocks,$/m, "turn 的返回值里没带上");

  // ④ 挂到发回上游的助手消息上（主循环 + 子智能体，两条路都要）
  const attaches = CODE.match(new RegExp(`\\.${F} = turn\\.reasoningBlocks`, "g")) || [];
  assert.equal(attaches.length, 2,
    `助手消息上挂签名的地方有 ${attaches.length} 处，应该是 2 处（主循环和子智能体）——`
    + "少一处就是那条路上的模型仍然看不见自己的推理");
});

test("这一次响应作废时，它的签名不能带到下一次", () => {
  // 重试和续传都会重开一次响应。上一次的思考块属于上一次那个助手轮，混进新的一轮
  // 里就是「签名和文字对不上」——上游判 400，比不带还糟。
  const resets = CODE.match(/(?<!let )reasoningBlocks = \[\];/g) || [];
  assert.equal(resets.length, 2,
    `重置点有 ${resets.length} 处，应该是 2 处（断流重来、工具参数修复重试）`);

  // 两处重置都必须和其它累加器的重置贴在一起 —— 分开写迟早漏掉一个。
  assert.equal(
    [...CODE.matchAll(/reasoningAll = "";[\s\S]{0,180}?(?<!let )reasoningBlocks = \[\];/g)].length,
    2,
    "有重置点没和 reasoningAll 的重置放在一起 —— 下次加累加器时必漏");
});

test("签名不当正文渲染，也不算「这一轮有动静」", () => {
  // 它是不透明凭据，不是内容。当成可见进度会让一轮只有思考签名的响应被记成有产出，
  // 空转检测就废了。
  assert.match(CODE, /ev\.kind === "reasoningBlocks"\)\s*\{[\s\S]{0,200}?return false;/,
    "reasoningBlocks 事件返回了 true —— 它会被算成可见进度");
});

test("自定义端点上必须把签名剥掉", () => {
  // 签名是**我们这条线路的上游**签的，别家既验不了也用不上；而消息里多一个未知字段，
  // 严格校验的端点会直接 400 —— 等于这个功能把一条本来能用的自定义端点弄坏了。
  assert.match(CODE, /const _outMsgs = isGateway \? messages : messages\.map\(/,
    "没有按「是不是我们的网关」分叉");
  assert.match(CODE, /reasoning_blocks: _drop, \.\.\.rest \} = m;\s*return rest;/,
    "剥的方式不对 —— 必须返回不含该字段的新对象，不能原地删（那会把网关那条路的凭据也弄没）");
  assert.match(CODE, /const payload = \{ model: config\.model, messages: _outMsgs,/,
    "剥完了没用上，payload 还是发的原数组");
});
