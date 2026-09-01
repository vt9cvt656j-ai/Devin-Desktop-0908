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
  // 但能力缺口必须留着——它是「不许假装支持」在界面上的唯一落点。
  assert.match(d, /id="cmGapsProto"/, "能力缺口被一起删了：那是唯一告诉用户「这个协议不支持什么」的地方");
});

test("标题水平居中，关闭按钮不参与排版", () => {
  // 关闭按钮若还在流里，标题会被它挤得偏左半个按钮宽——那种"差一点"比明显不居中更难看。
  const head = CSS.slice(CSS.indexOf(".cm-head {"), CSS.indexOf(".cm-body"));
  assert.match(head, /\.cm-title \{[^}]*text-align: center/, "标题没居中");
  assert.match(head, /\.cm-close \{[^}]*position: absolute/, "关闭按钮还在流里，标题会被挤偏");
});
