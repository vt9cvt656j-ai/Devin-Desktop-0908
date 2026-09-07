// 我们自己的并发闸不是上游限流，客户端不该为它干等 45 秒。
//
// 两者的状态码都是 429，而失败分类器只看状态码（`case 429 => "rate"`）。于是撞到
// 这道**我们自己的**闸时，客户端按真限流处理：等 15 秒、再等 30 秒。
//
// 可两者性质相反：
//   · 真限流 —— 上游让我们慢下来，长退避是对的，也确实在省配额；
//   · 这道闸 —— 请求**根本没发出去**，不烧任何配额，位子在用户自己那 8 个在跑的
//     请求里任何一个结束时就腾出来了。干等 45 秒纯属浪费。
//
// 线上量级（工作流实测）：nginx 侧 14 天 3294 个 429，占聊天请求 8.2%；字节级证据是
// 响应体长度恒为 48 字节 —— 08-28 那天 883 个 429 里 883 个都是这一条，不是上游限流。
//
// 判据全部真跑：ai-errors.js 是纯函数模块，不需要源码断言。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { _aiFailureKind, _isRateLimitedAiError, _isRetryableAiError } from "../src/agent/ai-errors.js";

const GATE = "[gateway-inflight] 你同时进行的请求过多（本网关上限 8 个），等前面的跑完就会自动继续";

test("自家并发闸走普通重试（2 秒起步），不走限流的长退避", () => {
  assert.equal(_aiFailureKind(GATE, 429), "gateway_busy");
  assert.equal(_isRateLimitedAiError(GATE, 429), false,
    "自家的闸被判成上游限流 —— 客户端会白等 15 秒再等 30 秒");
  assert.equal(_isRetryableAiError(GATE, 429), true,
    "判成不可重试的话，一次自家排队会被当成整轮失败");
});

test("真的上游限流一个字都不能变 —— 那条长退避是有理由的", () => {
  // 它每发一次都带完整上下文，既加深限流又实打实烧配额，历史上出过 25 秒 18 发的
  // 请求风暴。这次改动绝不能顺手把它也放进快重试。
  for (const msg of [
    "Rate limit exceeded, please try again later",
    "429 Too Many Requests",
    "请求过于频繁",
  ]) {
    assert.equal(_aiFailureKind(msg, 429), "rate", msg);
    assert.equal(_isRateLimitedAiError(msg, 429), true, msg);
    assert.equal(_isRetryableAiError(msg, 429), false,
      `${msg} 掉进了快重试 —— 那会造出请求风暴`);
  }
});

test("标记压过状态码 —— 排到后面它就永远轮不到", () => {
  // 分类器是 `if (kind) ...` 的形状：状态码那一支一旦先命中，标记就再也不会被看见。
  // 判据用行为不用源码顺序：拿一批**本来会被分成别的类**的状态码，带上标记之后
  // 必须全部变成 gateway_busy。任何一个没变，就说明标记排在了它后面。
  for (const st of [0, 400, 401, 402, 424, 429, 500, 502, 503, 504]) {
    assert.equal(_aiFailureKind(GATE, st), "gateway_busy",
      `状态码 ${st} 压过了标记 —— 标记排到了状态码判断后面，形同虚设`);
  }
  // 反向：没有标记的同一个码要保持原来的分类，别把这道闸做成「什么都算自家忙」。
  assert.equal(_aiFailureKind("并发请求过多，请稍后再试", 429), "rate",
    "旧文案（没有标记）应该仍然按上游限流处理");
});

test("网关发出去的文案确实带着这个标记（两端得对得上）", () => {
  // 标记是两个仓库各写一次的字符串。改一边另一边静默失效：客户端又开始为自家的闸
  // 等 45 秒，而且不会有任何报错。
  const rs = fs.readFileSync("../server/src/models.rs", "utf8");
  assert.match(rs, /\[gateway-inflight\]/,
    "网关不再发这个标记了 —— 客户端认不出自家的闸");
  assert.doesNotMatch(rs, /msg: "并发请求过多，请稍后再试"\.into\(\)/,
    "旧文案回来了，它会被客户端判成上游限流");
});
