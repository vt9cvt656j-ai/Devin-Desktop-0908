// 自定义模型弹窗：拉取模型、去掉的那两处、标题居中。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE } from "./helpers/source.mjs";
import { cmModelsUrl, cmModelsHeaders, cmParseModels } from "../src/agent/wire-protocol.js";

const CSS = readFileSync(new URL("../src/styles/custom-models.css", import.meta.url), "utf8");
const dialog = () => {
  const i = CODE.indexOf('ov.innerHTML = `<div class="cm-card"');
  const j = CODE.indexOf('document.querySelectorAll(".cm-ov")', i);
  assert.ok(i > 0 && j > i, "弹窗 markup 没切出来，锚点漂了");
  return CODE.slice(i, j);
};

test("列模型的地址：Anthropic 的基址不带 /v1，要自己补；末尾斜杠不能拼出 //", () => {
  assert.equal(cmModelsUrl("https://api.example.com/v1", "openai"), "https://api.example.com/v1/models");
  assert.equal(cmModelsUrl("https://api.example.com/v1/", "openai"), "https://api.example.com/v1/models");
  assert.equal(cmModelsUrl("https://api.anthropic.com", "anthropic"), "https://api.anthropic.com/v1/models");
  // 已经带了 /v1 的不重复补 —— 中转站常把 Anthropic 也架在 /v1 后面。
  assert.equal(cmModelsUrl("https://relay.cc/v1", "anthropic"), "https://relay.cc/v1/models");
  assert.equal(cmModelsUrl("http://localhost:11434/v1", "openai"), "http://localhost:11434/v1/models");
  assert.equal(cmModelsUrl("", "openai"), "", "空地址不该拼出一个假 URL");
});

test("鉴权头按协议分，空密钥不发头（本机 Ollama 没有密钥）", () => {
  const o = cmModelsHeaders("sk-1", "openai");
  assert.equal(o.Authorization, "Bearer sk-1");
  assert.ok(!("x-api-key" in o));
  const a = cmModelsHeaders("sk-2", "anthropic");
  assert.equal(a["x-api-key"], "sk-2");
  assert.equal(a["anthropic-version"], "2023-06-01");
  assert.ok(!("Authorization" in a), "Anthropic 发 Bearer 会被当成没带密钥");
  const empty = cmModelsHeaders("  ", "openai");
  assert.ok(!("Authorization" in empty), "空密钥还发 Bearer，本机服务会 401");
});

test("各家返回形状都认得，认不出时返回空而不是猜", () => {
  assert.deepEqual(cmParseModels({ data: [{ id: "b" }, { id: "a" }] }), ["a", "b"], "要按名字排序");
  assert.deepEqual(cmParseModels({ models: [{ name: "llama3" }] }), ["llama3"]);
  assert.deepEqual(cmParseModels(["x", "x", "y"]), ["x", "y"], "要去重");
  for (const junk of [null, undefined, {}, { data: "nope" }, { error: "unauthorized" }, 42]) {
    assert.deepEqual(cmParseModels(junk), [], `${JSON.stringify(junk)} 该判成拉不到`);
  }
});

test("模型名称排在地址和密钥之后——拉取要先有那两样", () => {
  const d = dialog();
  const at = (cls) => d.indexOf(cls);
  assert.ok(at("cm-in-base") > 0 && at("cm-in-key") > 0 && at("cm-in-name") > 0, "三个输入框有缺");
  assert.ok(at("cm-in-name") > at("cm-in-key"), "模型名称又跑到密钥前面了：那时还拉不了");
  assert.ok(at("cm-in-key") > at("cm-in-base"), "密钥跑到地址前面了");
  assert.match(d, /class="cm-pull__btn"/, "拉取按钮没了");
  assert.match(d, /id="cmModelList"/, "拉回来的模型没有地方放");
});

test("删掉的两处不许回来：会员徽章、协议地址说明", () => {
  const d = dialog();
  // 徽章本来就是过期信息：代码里写着「配置自定义端点不再要求会员」。
  assert.doesNotMatch(d, /cm-vip|会员专属/, "会员徽章又回来了");
  assert.doesNotMatch(d, /会员到期后/, "同一条过期声明在顶部说明里又回来了");
  assert.doesNotMatch(CSS, /\.cm-vip/, "徽章的死样式还留着");
  assert.doesNotMatch(d, /id="cmHintProto"/, "协议那段地址说明又回来了");
});

test("协议限制收进折叠行：表单里只占一行，信息不丢", () => {
  // 用户两次说这些提示字占地方要删。但这些限制**本身成立**（温度/top_p 不发、
  // 思考开关按模型名猜、max_tokens 默认 32000），直接删掉就是「悄悄不支持」——
  // 这个仓库为「只删显示」付过账。折叠是两件事的交点：合上时只有一行字。
  const d = dialog();
  assert.match(d, /<details class="cm-gapsbox" hidden>/, "缺口不再是折叠的了：要么占一屏，要么就该没了");
  assert.match(d, /id="cmGapsProto"/, "缺口列表没了");
  assert.match(CODE, /gapsBox\.open = false/, "换协议后不收起来：上一个协议展开过它就一直是开的");
  assert.match(CODE, /ui\.gaps = r\.unsupported\.map\(String\)/, "不再从 Rust 同步缺口：前端那份会漂");
  // 数据也必须还在，否则折叠框永远是空的。
  const wire = readFileSync(new URL("../src/agent/wire-protocol.js", import.meta.url), "utf8");
  assert.match(wire, /^\s*gaps: \[$/m, "CM_PROTOCOL_UI 里的缺口文案被删空了");
});

test("已添加的那一列有标题，用户才知道去哪里编辑/删除", () => {
  const d = dialog();
  assert.match(d, /class="cm-form-title cm-list-title"[^>]*>已添加</, "「已添加」标题没了：两行模型悬在中间，看不出那是编辑入口");
  assert.match(d, /class="cm-list"/, "列表容器没了");
});

test("模型选择器里，自定义分组标题上有直达管理的入口", () => {
  // 底部那条「⚙ 自定义模型」是对的，但用户找"我加的那个怎么改"时，眼睛在自己那个
  // 分组标题上，不在菜单底部。就近再给一个。
  assert.match(CODE, /menu__group menu__group--custom/, "自定义分组的标题行没有单独的类");
  assert.match(CODE, /menu__group-edit[\s\S]{0,400}showCustomModelsDialog\(\)/,
    "分组标题上的齿轮没接上管理弹窗");
  // 光有类名和监听器不算数——它得**真的挂到标题行上**。少了这一句，把 append 删掉
  // 上面两条照样绿：类名还在、监听器还在，只是那个按钮永远不进 DOM。
  assert.match(CODE, /g\.append\(gname, gedit\)/, "齿轮建出来了却没挂进分组标题行");
  // 底部那条也必须还在：一个自定义模型都没有时，它是唯一的入口。
  assert.match(CODE, /cfg\.addEventListener\("click"[\s\S]{0,120}showCustomModelsDialog\(\)/,
    "菜单底部那条入口被删了：没有自定义模型时就完全进不去了");
});

test("标题水平居中，关闭按钮不参与排版", () => {
  // 关闭按钮若还在流里，标题会被它挤得偏左半个按钮宽——那种"差一点"比明显不居中更难看。
  const head = CSS.slice(CSS.indexOf(".cm-head {"), CSS.indexOf(".cm-body"));
  assert.match(head, /\.cm-title \{[^}]*text-align: center/, "标题没居中");
  assert.match(head, /\.cm-close \{[^}]*position: absolute/, "关闭按钮还在流里，标题会被挤偏");
});
