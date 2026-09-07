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
    "[model-refusal] 这个模型自身的安全限制拦住了这次请求，不是你的问题（分类：cyber）。模型说：涉及攻击性网络工具。可以换一个限制更少的模型重试。",
    "[model-refusal] 这个模型自身的安全限制拦住了这次请求，不是你的问题（分类：cyber）。可以换一个限制更少的模型重试。",
    "[model-refusal] 这个模型自身的安全限制拦住了这次请求，不是你的问题。可以换一个限制更少的模型重试。",
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
  assert.match(CODE, /err = "\[model-refusal\] 这个模型自身的安全限制拦住了这次请求/,
    "拒答没有自己的标记");
  // 零产出那条必须还在（这道修复不能把线路抖动的兜底一起干掉）。
  assert.match(CODE, /\[model-empty-output\] 模型这一轮没有返回任何内容/,
    "零产出兜底被误删了 —— 真的线路抖动会整轮判死");
  // 拒答有自己的独立重试路径（限一次），不会被 _emptyOut 那条路捞进去反复重试。
  assert.match(CODE, /const _emptyOut = \/\^\\\[model-empty-output\\\]\/i\.test\(_turnErrTag\);/,
    "零产出重试闸的判据变了");
  assert.match(CODE, /const _refusal = \/\^\\\[model-refusal\\\]\/i\.test\(_turnErrTag\);/,
    "拒答没有自己的独立检测");
  assert.match(CODE, /_refusal && \(run\._refusalRetries \|\| 0\) < 2/,
    "拒答重试没有限制为两次 —— 不限次就会反复烧钱");
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

test("断流时真实原因要一路带到用户眼前", () => {
  // 在这之前：网关判定协议不合格 → 直接中止响应体，原因只进它自己的日志；
  // 桌面端拿到一个传输层错误 → 显示成常量「连接中断（网络波动）」。
  // 线上实测过同一秒的两行：网关写着「上游的流没有终止标记就结束了」，
  // 用户看到的是「网络波动」。于是「老是断线」这个报障在产品里无法定位。
  // **先剥注释再断言。** 下面那条 doesNotMatch 找的是旧写法，而解释这次改动的
  // 注释里恰好逐字引用了它 —— 不剥的话断言会匹配到自己的说明文字，恒红。
  // （这个仓库为「断言匹配到自己的注释」栽过好几次，判据一律先剥。）
  const rs = fs.readFileSync("src-tauri/src/ai.rs", "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  // ① 传输层错误不再丢掉 —— 那个 `_e` 曾经绑定后一次都没被用过。
  assert.doesNotMatch(rs, /Ok\(Some\(Err\(_e\)\)\)/,
    "传输层错误又被丢掉了（`_e` 绑定后不用），界面会退回成一句常量");
  assert.match(rs, /Ok\(Some\(Err\(e\)\)\)[\s\S]{0,160}stream_break_message\(&e\)/,
    "断流错误没有走带原因的那条");

  // ② 网关中途发的 error 帧要被认出来。
  assert.match(rs, /pointer\("\/error\/message"\)/,
    "桌面端不认网关中途发的 error 帧 —— 那帧带着唯一能定位的原因");
  assert.match(rs, /"gateway" \{ "网关" \} else \{ "上游" \}|side == "gateway"/,
    "没有区分「断在网关」还是「断在上游」");

  // ③ 「连接中断」这几个字必须留着：可重试判据和断点续传判据按它匹配。
  for (const m of rs.matchAll(/message: format!\("连接中断[^"]*"/g)) {
    assert.ok(m[0].includes("连接中断"), "");
  }
  assert.match(rs, /连接中断（网络波动），已保留生成的部分。/,
    "兜底文案没了 —— 拿不到原因时用户会以为内容丢了");
});
