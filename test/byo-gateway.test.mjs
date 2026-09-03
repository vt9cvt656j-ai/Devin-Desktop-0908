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

// inTauri 是本函数的第一道门（网页版没有那三个 byo 头，见函数注释），所以要注入。
// 默认注入 true = 桌面端，下面那组地址判据测的就是桌面端的行为。
const byoViaGateway = (tauri = true) => load("_byoViaGateway", { inTauri: tauri });

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

test("**网页版一律不走代发**——那三个 byo 头只有 Rust 那侧在发", () => {
  // 网页版走 main.js 的 _realAiFetch 装配请求头，里面一个 x-ide-byo-* 都没有。
  // 少了头，网关 byo_upstream::from_headers 直接 return Ok(None)，于是拿着已被改写成
  // 上游真名的 model 去查**我们自己的** models 表 → 走我们的线路、按我们的价钱计费，
  // 而卡片上写着「用你自己的密钥计费」。这道门把网页版挡在代发之外，恢复浏览器直连。
  const web = byoViaGateway(false);
  for (const good of ["https://api.teamorouter.cn/v1", "https://polly.modelbridge.cc/v1"]) {
    assert.equal(web({ baseUrl: good }), false,
      `${good} 在网页版上不该走代发 —— 头发不出去，网关会把它当成我们自己的模型`);
  }
  // 桌面端同一个地址必须仍然走：这条反向断言防止有人把门加宽成"谁都不走"。
  assert.equal(byoViaGateway(true)({ baseUrl: "https://api.teamorouter.cn/v1" }), true,
    "桌面端也被挡住了 —— 那等于把整个代发功能关掉");
});

test("要放开网页版，必须先把三个 byo 头补进 _realAiFetch", () => {
  // 这条守的是「门和头一起动」。哪天有人把 inTauri 那道门去掉，却没补头，
  // 就会重演今天这个形态：L0 剥了提示词、网关不知道要转发、用户被按我们的价钱计费。
  // **两处都必须传 {code:true}**：fnSource 默认切的是含注释的源文本，而这个函数里
  // `x-ide-byo` 今天**只存在于注释**。不剥注释的话有两条假绿：删掉门只留一行
  // `// if (!inTauri) return false;` → 下面那个 if 认为门还在、整条断言被跳过；
  // 或者在 _realAiFetch 里写任何提到 x-ide-byo-base 的注释 → sends 为真、断言通过。
  const gate = fnSource("_byoViaGateway", { code: true });
  const sends = /x-ide-byo-base/.test(fnSource("_realAiFetch", { code: true }));
  if (!/if \(!inTauri\) return false;/.test(gate)) {
    assert.ok(sends,
      "_byoViaGateway 放开了网页版，但 _realAiFetch 里没有 x-ide-byo-base —— "
      + "请求会打到网关而网关不知道要转发出去，用户会被按我们的价钱计费");
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

test("直连第三方端点时不许发 x-ide-* —— 我们自己的头会把对方的预检打挂", () => {
  // 实测（2026-09-02，真发 OPTIONS）：
  //   api.moonshot.cn  只带 authorization,content-type → 204 且回显 → 预检通过
  //                    再带上 x-ide-run-id/session-id/session-goal → **不回显** → 浏览器拒绝，
  //                    整条请求发不出去。同一家、同一条路径，差别只在我们多发的头。
  //   api.deepseek.com 原样回显，放行；open.bigmodel.cn 两种都 405（和我们无关）。
  // 这些头是发给**我们网关**的遥测，第三方端点一个都用不上。
  //
  // 另外它们还带着用户内容：x-ide-session-goal 是会话开场那句的 base64（至多 4000 字），
  // 在 _readyAiConfig 里无条件设，不走 L0 那道门 —— 直连时会跟着发给第三方。
  // （工具名清单 x-ide-tools 和模式 x-ide-mode 在 L0 块里设，直连时压根不设，不受影响。）
  const fetchFn = fnSource("_realAiFetch", { code: true });
  assert.match(fetchFn, /if \(!_isGatewayConfig\(config\)\)[\s\S]{0,120}startsWith\("x-ide-"\)[\s\S]{0,40}delete/,
    "直连线路没有清掉 x-ide-* —— Moonshot 那类只回显自己认识的头的端点会整条请求发不出去");
  // 门必须在**所有** x-ide-* 都写完之后：早了就漏掉后面新加的头。
  const gateAt = fetchFn.indexOf('startsWith("x-ide-")');
  const lastHeader = fetchFn.lastIndexOf('_h["x-ide-');
  assert.ok(gateAt > lastHeader && lastHeader > 0,
    "清理放在了最后一个 x-ide-* 赋值之前 —— 后面那些仍会发出去");
});

test("角色声明了别的模型时，byo 三件套必须一起丢掉", () => {
  // `_subConfig = { ...config, model: _roleModel, customModelId: undefined }` 只清了
  // customModelId。而角色声明的是**我们目录里**的模型（判据就是 MODEL_NAMES[_roleModel]），
  // 带着 byoBase 会让 Rust 照发 x-ide-byo-base → 网关把我们的模型名转发到**用户自己的
  // 端点**去要 —— 静默换成了另一个模型、另一份账，而上面那句注释担心的正是这个。
  //
  // 这是本仓库反复出现的形状：新加了一个字段（byoBase），而「重置连接」的地方只清旧字段。
  const src = fnSource("_runSubAgent", { code: true });
  const at = src.indexOf("_subConfig = { ...config, model: _roleModel");
  assert.ok(at > 0, "角色换模型那处改写了，这条守卫要跟着改");
  const line = src.slice(at, src.indexOf("\n", at));
  for (const f of ["customModelId", "byoBase", "byoKey", "byoProto"]) {
    assert.match(line, new RegExp(`${f}: undefined`),
      `换模型时没清 ${f} —— 连接身份要整套丢，漏一个就会带着旧线路跑新模型`);
  }
});

test("byoBase 只有一个写入点，且没有别的地方在悄悄设它", () => {
  // 它决定「这一轮走不走代发」，多一个写入点就多一条没人审过的路。
  const code = CODE;
  const writes = (code.match(/\.byoBase = /g) || []).length;
  assert.equal(writes, 1, `byoBase 有 ${writes} 个写入点 —— 代发选路要能一眼看全`);
});
