// 自定义模型走网关代发：路由判据 + 两道闸对这条路让开。
//
// 用户要的是「他们用自定义模型也能跑我的工具和智能体那些」。原来那条路是客户端直连
// 用户填的第三方地址 —— 完整系统提示词和工具描述由网关按需注入，直连拿不到；长上下文
// 压缩也在网关侧。所以自定义模型的智能体一直弱一截，弹窗里也是这么写的。
//
// 改法不是把提示词发给客户端（那等于把产品 IP 放进每个人的机器），而是**让这条请求
// 也走一趟网关**：网关装配好再转发到用户填的地址、用用户自己的密钥。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE, fnSource, load } from "./helpers/source.mjs";

const byoViaGateway = () => load("_byoViaGateway", {});

test("远程 https 端点走代发；本机和明文一律不走", () => {
  const f = byoViaGateway();
  assert.equal(f({ baseUrl: "https://api.teamorouter.cn/v1" }), true);
  assert.equal(f({ baseUrl: "https://polly.modelbridge.cc/v1" }), true);

  // 本机走不通：网关转发到 localhost 打的是**服务器自己的** localhost。
  // 这不是"以后修一修"，是结构性的。
  for (const bad of ["http://localhost:11434/v1", "https://localhost:8443/v1",
                     "http://127.0.0.1:1234/v1", "https://[::1]:8443/v1",
                     "https://mac.local/v1", "https://box.localhost/v1"]) {
    assert.equal(f({ baseUrl: bad }), false, `${bad} 不该走代发`);
  }
  // 明文到第三方＝密钥裸奔，和网关侧的判据一致。
  assert.equal(f({ baseUrl: "http://api.example.com/v1" }), false);
  // 私网字面量：网关那边会拒，这里先不发，省一次必然失败的往返。
  for (const lan of ["https://10.0.0.5/v1", "https://192.168.1.9/v1", "https://172.20.3.4/v1"]) {
    assert.equal(f({ baseUrl: lan }), false, `${lan} 不该走代发`);
  }
  // 填得不成样子的一律不走，不抛。
  for (const junk of [undefined, null, {}, { baseUrl: "" }, { baseUrl: "不是地址" }]) {
    assert.equal(f(junk), false);
  }
});

test("172.16/12 的边界不能多也不能少", () => {
  // 私网是 172.16–172.31，不是整个 172.*。多挡一格就把一批正常的中转拒在门外。
  const f = byoViaGateway();
  assert.equal(f({ baseUrl: "https://172.15.0.1/v1" }), true, "172.15 是公网");
  assert.equal(f({ baseUrl: "https://172.16.0.1/v1" }), false);
  assert.equal(f({ baseUrl: "https://172.31.255.1/v1" }), false);
  assert.equal(f({ baseUrl: "https://172.32.0.1/v1" }), true, "172.32 是公网");
});

test("走代发时改指网关，并把用户的端点和密钥挂成 byo 三件套", () => {
  const fn = fnSource("_readyAiConfig", { code: true });
  assert.match(fn, /_byoViaGateway\(_custom\)/, "没有按远程/本机分叉");
  assert.match(fn, /config\.baseUrl = MICHAEL_API/, "代发时没改指网关");
  assert.match(fn, /config\.byoBase = _custom\.baseUrl/, "没带上用户的端点");
  assert.match(fn, /config\.byoKey = _custom\.apiKey/, "没带上用户的密钥");
  assert.match(fn, /config\.byoProto = cmProtocol\(_custom\.protocol\)/, "没带上线协议");
  // 到网关这一跳永远是 OpenAI 形状；翻译成用户那家的协议在网关侧按 byoProto 做。
  assert.match(fn, /config\.protocol = "openai"/, "对网关这一跳发了别的协议形状");
  // 本机那一支必须还在，且仍然直连。
  assert.match(fn, /\} else if \(_custom\) \{[\s\S]{0,400}config\.baseUrl = _custom\.baseUrl/,
    "本机端点那一支没了：它只能直连，网关够不着用户的 localhost");
});

test("两道闸都要对这条路让开，否则代发也拿不到东西", () => {
  // _isGatewayConfig 决定 L0 注入头发不发；_ipSafeRoute 决定那几条会带提示词文本的腿
  // 走不走。少放一道，这条路就白搭了 —— 提示词照样不注入，或者编排照样退化。
  for (const name of ["_isGatewayConfig", "_ipSafeRoute"]) {
    const fn = fnSource(name, { code: true });
    assert.match(fn, /if \(config && config\.byoBase\) return true;/, `${name} 没有对代发让开`);
    // 判据必须是 byoBase，不是地址：按地址判会误伤「遗留直连配置」，
    // 那条既有测试当场否过一次。
    assert.doesNotMatch(fn, /baseUrl\s*[!=]==?\s*MICHAEL_API/, `${name} 改成按地址判了`);
  }
});

test("真正的校验接在网关的请求路径上", () => {
  // 客户端那道判断对攻击者一律可绕过（改本地配置即可），所以它只是选路。
  // 唯一的 SSRF 防线在网关：解析 DNS 之后逐个查网段、连接钉在验过的 IP 上。
  // 这条测试守的是「它确实被接进了请求主路径」——只写了模块没接上，等于没有。
  const models = readFileSync(new URL("../../server/src/models.rs", import.meta.url), "utf8");
  assert.match(models, /byo_upstream::from_headers_async\(&headers\)/, "网关请求路径上没有调校验");
  assert.match(models, /byo_upstream::pinned_client\(b\)/,
    "转发没有用钉住 IP 的客户端——那样 DNS 重绑定的第二步就没挡");
  // 校验不过要当场 400，不能回落到网关自己的付费线路（那会花掉用户的额度）。
  assert.match(models, /from_headers_async\(&headers\)[\s\S]{0,120}map_err\(AppError::bad\)/,
    "校验失败没有当场报错");
  assert.match(models, /if byo\.is_none\(\) && want_power/, "自带上游还在走强力版线路筛选");
});

test("三个字段要真的发出去（桌面走 Rust 侧的头）", () => {
  const ai = readFileSync(new URL("../src-tauri/src/ai.rs", import.meta.url), "utf8");
  for (const h of ["x-ide-byo-base", "x-ide-byo-key", "x-ide-byo-proto"]) {
    assert.ok(ai.includes(h), `Rust 侧没转发 ${h}`);
  }
  // 没有 base 就一个头都不发：只发 key 或只发 proto 会让网关走进半配置的状态。
  assert.match(ai, /if let Some\(base\) = config\.byo_base[\s\S]{0,600}x-ide-byo-key/,
    "key 的转发不在 base 的条件里");
});
