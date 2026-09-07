// 内置提示词和工具知识**不出网关**。
//
// 用户 2026-08-27 立的铁律：「千万不要让用户能拿走我的提示词和工具，不然的话，我的软件
// 就基本完了，他们逆向很厉害。」
//
// 这里守的是**主动外发**那一半：走用户自己的中转时，请求体会原样躺在他的服务器日志里。
// 实测发现四条腿（意图裁决器 7.1KB / 工具编排器 2.1KB / 收尾评审员 4.0KB / 离线蒸馏）
// 外加 system 里的工具直觉表 + 能力名录（4.9KB），此前**一条线路判断都没有**。
//
// 另一半（「躺在发布包里等人拆」）由 build/ 的剥离脚本 + 产物断言管，不在这个文件里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, fnSource as extractFn, load } from "./helpers/source.mjs";

const GATEWAY = { baseUrl: "https://code.mrday.one", apiKey: "tok", model: "grok-4.6" };
const CUSTOM = { baseUrl: "https://relay.example/v1", apiKey: "sk-x", model: "m",
                 customModelId: "custom:abc", protocol: "openai" };

test("判据是「对端是不是我们自己的网关」，不是协议、不是地址", () => {
  const f = load("_ipSafeRoute", {});
  assert.equal(f(GATEWAY), true, "网关线路被判成不安全 —— 那会把自己的功能也砍掉");
  assert.equal(f(CUSTOM), false, "自定义端点被判成安全 —— 提示词会发到用户的服务器");
  assert.equal(f({ ...CUSTOM, protocol: "anthropic" }), false, "换个协议就绕过去了");
  assert.equal(f({ ...CUSTOM, baseUrl: "https://code.mrday.one" }), false,
    "地址伪装成网关就绕过去了 —— 判据必须是 customModelId，不是 baseUrl");
  assert.equal(f(null), true, "拿不到配置时按网关算（保守：宁可少发一次，不要误伤自己的线路）");
});

test("三条认知腿在自定义端点上一个字都不发", async () => {
  const calls = [];
  const f = load("_cognitiveLegComplete", {
    _ipSafeRoute: load("_ipSafeRoute", {}),
    cmProtocol: (p) => String(p || "openai"),
    _legBareCap: (_m, n) => n,
    _ideAuxValue: (k, n) => `${k}-c${n}`,
    _fetchCompletionText: (...a) => { calls.push(["直发", a[0]]); return Promise.resolve("{}"); },
    _chatCompletionsUrl: (b) => b + "/chat/completions",
    _billableAiComplete: (c) => { calls.push(["走Rust", c.protocol]); return Promise.resolve("{}"); },
  });
  const body = { model: "m", messages: [{ role: "system", content: "内置提示词" }] };

  calls.length = 0;
  const out = await f(CUSTOM, body, 100);
  assert.equal(out, null, "自定义端点上必须返回 null，让调用方走兜底");
  assert.deepEqual(calls, [], "自定义端点上仍然发了请求 —— 内置提示词进了用户的日志");

  calls.length = 0;
  await f(GATEWAY, body, 100);
  assert.equal(calls.length, 1, "网关线路被误伤了 —— 那会把自己的功能砍掉");
});

test("意图裁决器、下一句预测、工具直觉表三处也各自闸上", () => {
  // 这三处不共用 _cognitiveLegComplete，各有各的发送口，必须逐个守。
  const intent = extractFn("_aiIntentProfile", { code: true });
  assert.match(intent, /if \(!_ipSafeRoute\(config\)\) return null;/,
    "意图裁决器没闸 —— 每一轮都把 7KB 的决策器提示词发到用户端点");
  const i = intent.indexOf("_ipSafeRoute");
  const j = intent.indexOf("_billableAiComplete");
  assert.ok(i > 0 && i < j, "闸排在发送之后，等于没闸");

  const predict = extractFn("_predictNextAsk", { code: true });
  assert.match(predict, /if \(_cm\) \{[\s\S]{0,160}?return;/,
    "预测没有对自定义端点整体闸上 —— OpenAI 兼容的中转同样是用户的服务器");

  assert.match(SRC, /_ipSafeRoute\(config\) \? _toolHint : ""/,
    "工具直觉表 + 完整能力名录仍然发到自定义端点");
});
