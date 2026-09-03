// 安全分类器拒答 ≠ 上游抖了一下。
//
// 拒答走 HTTP 200 + stop_reason="refusal"，正文确实是空的 —— 形状和「什么都没回」
// 一模一样。以前整条链把它折成 finish_reason="stop"，于是三层后果叠起来：
//   ① 用户只看到一次空回复，理由完全不可见；
//   ② 客户端的零产出兜底自动重开两轮 —— 同一次拒答付费执行三次，每次都被同一个
//      分类器拒，三次都是空的；
//   ③ 拒答前开过思考块的话，网关的「中转丢块」判据（saw_thinking && !saw_answer &&
//      stop_reason=="stop"）命中，把这条**健康**线路的思考深度按 30 分钟压到 medium
//      —— 伤的是这条线路上所有用户。
//
// 网关那半边（映射 + 不再误诊）在 server 里跑真往返。这里守客户端这半边。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { _isRetryableAiError } from "../src/agent/ai-errors.js";
import { CODE } from "./helpers/source.mjs";

test("拒答文案不会被通用重试判据捞回去（真跑，不是看源码）", () => {
  // 这条最容易悄悄失效：文案里只要出现 "try again"、"超时"、"网络波动" 之类的词，
  // 通用判据就会把它判成可重试，自动重开两轮又回来了。
  for (const msg of [
    "[model-refusal] 模型拒绝了这次请求（cyber）：涉及攻击性网络工具。",
    "[model-refusal] 模型拒绝了这次请求（cyber）。换个说法或换个模型再试。",
    "[model-refusal] 模型拒绝了这次请求。换个说法或换个模型再试。",
  ]) {
    assert.equal(_isRetryableAiError(msg, 0), false,
      `拒答被判成可重试 —— 同一次拒答会被付费执行三次：${msg}`);
  }
  // 对照：真正的线路抖动仍然要重试，别把这道闸修成一律不重试。
  assert.equal(_isRetryableAiError("upstream 503 service unavailable", 0), true);
});

test("拒答走自己那条分支，不打 [model-empty-output] 标记", () => {
  assert.match(CODE, /if \(finishReason === "content_filter"\) \{/,
    "没有按 content_filter 分叉 —— 拒答仍然会落进零产出那条自动重试的路");
  assert.match(CODE, /err = "\[model-refusal\] 模型拒绝了这次请求"/,
    "拒答没有自己的标记");
  // 零产出那条必须还在（这道修复不能把线路抖动的兜底一起干掉）。
  assert.match(CODE, /\[model-empty-output\] 模型这一轮没有返回任何内容/,
    "零产出兜底被误删了 —— 真的线路抖动会整轮判死");
  // 重试闸只认 empty-output，不认 refusal。
  assert.match(CODE, /const _emptyOut = \/\^\\\[model-empty-output\\\]\/i\.test\(_turnErrTag\);/,
    "重试闸的判据变了，拒答可能又被捞进去");
});

test("拒答理由从上游一路带到用户眼前", () => {
  // 理由在 stop_details 里，是这一轮唯一能说清「为什么什么都没说」的东西。
  const rs = fs.readFileSync("src-tauri/src/ai.rs", "utf8");
  assert.match(rs, /StopDetails \{\s*details: serde_json::Value,\s*\}/,
    "桌面端没有承载拒答理由的事件 —— 理由到不了前端");
  assert.match(rs, /"refusal" => "content_filter"/,
    "桌面端仍然把拒答折成别的词");
  assert.match(CODE, /ev\.kind === "stopDetails"/, "前端没接这个事件");
  assert.match(CODE, /_stopDetails && \(_stopDetails\.category \|\| _stopDetails\.type\)/,
    "拿到了理由却没用在给用户的话里");
});

test("思考签名的通道在桌面端也接上了（之前只改到了网页版那条）", () => {
  // 桌面端的流式是 Rust 侧发事件，和网页版那个模拟壳里的 SSE 解析是两条路。
  // 只改后者的话，真正的产品一个字节都拿不到。
  const rs = fs.readFileSync("src-tauri/src/ai.rs", "utf8");
  assert.match(rs, /ReasoningBlocks \{\s*blocks: Vec<serde_json::Value>,\s*\}/,
    "桌面端没有承载思考签名的事件");
  assert.match(rs, /delta\["reasoning_blocks"\]\.as_array\(\)/,
    "桌面端的流式解析没收签名 —— 桌面端的模型仍然看不见自己上一轮的推理");
});
