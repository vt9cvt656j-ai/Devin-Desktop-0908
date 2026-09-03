// 模型名和所选协议对不上 —— 只提示，不拦截。
//
// 用户实际撞到的上游报错原文：「本条请求疑似协议和模型不匹配导致 cache 异常，
// 调用 claude-fable-5-1 模型请使用 Anthropic 协议。」界面上此前没有任何提示：
// 协议默认 OpenAI 兼容，填个 Claude 模型名照样保存成功、照样发得出去 ——
// 直到上游回一句看不懂的错，或者更糟：不报错，只是缓存全程不命中。
// 而 Anthropic 缓存写入按输入价 1.25 倍收，写了从来读不到比不缓存还贵 25%。

import test from "node:test";
import assert from "node:assert/strict";
import { protocolMismatchHint } from "../src/agent/wire-protocol.js";
import { SRC } from "./helpers/source.mjs";

test("Claude 名字配非 Anthropic 协议 → 提示", () => {
  for (const n of ["claude-fable-5-1", "claude-opus-5", "anthropic/claude-sonnet-5", "my-claude-proxy"]) {
    assert.match(protocolMismatchHint(n, "openai"), /Anthropic 协议/, `${n} 没提示`);
  }
  assert.match(protocolMismatchHint("claude-opus-5", "xai_responses"), /Anthropic 协议/);
});

test("选对了就不吭声", () => {
  assert.equal(protocolMismatchHint("claude-fable-5-1", "anthropic"), "");
  assert.equal(protocolMismatchHint("gpt-5.6-luna", "openai"), "");
  assert.equal(protocolMismatchHint("deepseek-v4-pro", "openai"), "");
  assert.equal(protocolMismatchHint("", "openai"), "");
});

test("Grok 配 Anthropic 协议 → 反向也提示", () => {
  assert.match(protocolMismatchHint("grok-4.6", "anthropic"), /Grok/);
  assert.equal(protocolMismatchHint("grok-4.6", "openai"), "");
});

test("不做模糊匹配 —— 宁可漏提示，也别对着正常名字瞎报", () => {
  // 「claude」必须是被分隔符界定的一段，不能是任意子串。
  for (const n of ["exclaudement", "declauded-model", "gpt-claudius"]) {
    assert.equal(protocolMismatchHint(n, "openai"), "", `${n} 被误报了`);
  }
});

test("提示里必须说清「可以忽略」—— 确实有用 OpenAI 协议转发 Claude 的中转", () => {
  // 判据是用户自己填的**名字**，不是执行事实。拿它拦人会拦掉真实存在的用法。
  assert.match(protocolMismatchHint("claude-opus-5", "openai"), /忽略这条/);
});

test("对话框真的接上了：换协议和改名字两处都会刷新", () => {
  assert.match(SRC, /protocolMismatchHint\(inName\.value, readProto\(\)\)/,
    "提示没接进协议切换 —— 用户改了协议看不到变化");
  assert.match(SRC, /inName\.addEventListener\("input", \(\) => \{[^}]*syncProto\(\);/,
    "改模型名时不刷新 —— 先填名字再选协议的用户永远看不到这条");
  assert.match(SRC, /class="cm-field__err cm-proto-mismatch"/, "提示没有落点元素");
});
