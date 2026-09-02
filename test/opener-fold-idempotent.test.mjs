// 开场消息的折叠必须是**一次性**的。
//
// # 为什么这条测试存在
//
// 线上实测（2026-09-02）：同一模型请求 56k→缓存 24k、105k→缓存 42k、165k→缓存 36k。
// **缓存量恒定、不随请求增长**，且与请求间隔无关。= 只有系统消息进了缓存，
// 开场消息之后的几万 token 一条都没进。
//
// 真因：折叠的替换文案「[较早的项目上下文 / 当前文件已折叠省上下文……]」自己就含
// 「项目上下文」四个字，而判据是 `m.content.includes("项目上下文")` —— 折完仍为真。
// 加上抽保留块时最后一段找不到下一个 "\n--- " 会一路切到 `_head.length`，把上一轮那句
// 文案吞成"要保留的内容"，于是每轮重写一次、每轮长 66 个字，永不收敛。
// 开场消息是系统消息之后的第一条，它一变，严格前缀缓存从第 1 条起全丢。
//
// # 这条测试怎么写的
//
// 守卫原文既当**锚点**又当**要执行的代码**：改了它，blockFrom 找不到锚点会当场抛错，
// 所以跑的那份和 main.js 里的那份逐字节相同 —— 不是在测试里另抄一遍（那是恒真守卫
// 的第三种形状：测试台自己编的形状和生产不一致）。块按 AST 取，不按字符数开窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SRC, blockFrom } from "./helpers/source.mjs";

const GUARD = 'if (mk > 400 && m.content.includes("项目上下文") && !_raw._ideMeta?.openerFolded) {';
const IF_BODY = blockFrom(GUARD);
assert.ok(IF_BODY.length < 4000, `块取出来 ${IF_BODY.length} 字，锚点不对`);
assert.ok(IF_BODY.includes("_foldMeta"), "块里没有幂等标记的写回");

// mk 的算法在测试这边现算（生成代码里放正则会被模板字符串二次转义弄坏）。
// 钉住它和源码一致，改了这两行就红。
const MK_LINES = [
  'const bk = m.content.search(/━{8,}\\s*\\n\\s*📌/);',
  'const mk = bk >= 0 ? bk : m.content.indexOf("📌");',
];
for (const line of MK_LINES) {
  assert.ok(SRC.includes(line), `main.js 里找不到这一行，mk 的算法变了：${line}`);
}

const _DEMAND_LEDGER_HEAD = "--- 已从对话中折叠掉的历次要求（";
const runFold = new Function(
  "_raw", "m", "mk", "messages", "i", "_DEMAND_LEDGER_HEAD", "_msgSize", "run",
  // 这段原文躺在 `for (let i = …)` 里，块尾有 break —— 用一次性 for 包住它，
  // 让 break/continue 合法，语义仍是"跑一遍这个块"。
  "let readContextChanged = false; let total = 0;\nfor (let _once = 0; _once < 1; _once++) {\n"
  + GUARD + IF_BODY.slice(1) + "\n}\nreturn messages[i];",
);

/** 一条真实形状的开场消息：目录树 + 项目约定 + 项目记忆，然后是 ━━━/📌 用户请求。 */
function opener() {
  return "--- 项目上下文 ---\n" + "src/foo.js\n".repeat(300)
    + "--- 项目约定 (AGENTS.md) ---\n" + "务必先跑测试再提交。\n".repeat(40)
    + "--- 项目记忆（用户 remember 的）---\n" + "他偏好中文回复。\n".repeat(40)
    + "\n━━━━━━━━━━━━━━━━\n📌 用户请求：帮我改一下缓存";
}

function fold(msg) {
  const _openerText = typeof msg.content === "string"
    ? msg.content
    : String(msg.content?.[0]?.text || "");
  const m = typeof msg.content === "string" ? msg : { ...msg, content: _openerText };
  const bk = m.content.search(/━{8,}\s*\n\s*📌/);
  const mk = bk >= 0 ? bk : m.content.indexOf("📌");
  const messages = [{ role: "system", content: "sys" }, msg];
  return runFold(msg, m, mk, messages, 1, _DEMAND_LEDGER_HEAD, () => 0, {});
}

test("开场消息折叠一次之后，后面每一轮都必须一字不动", () => {
  const first = fold({ role: "user", content: opener() });
  assert.ok(first.content.length < opener().length, "第一轮就该真的折下去");

  let cur = first;
  for (let t = 2; t <= 8; t++) {
    const next = fold(cur);
    assert.equal(next.content, cur.content,
      `第 ${t} 轮又把开场消息改了（${next.content.length - cur.content.length} 字）——`
      + "它是系统消息后的第一条，一变就等于整条历史退出缓存");
    cur = next;
  }
});

test("幂等标记不会被发到线上", () => {
  const folded = fold({ role: "user", content: opener() });
  assert.equal(folded._ideMeta?.openerFolded, true, "标记没打上，下一轮还会再折一次");
  assert.ok(!String(folded.content).includes("openerFolded"), "标记漏进了正文");
  assert.match(SRC, /const \{ reasoning, _ideMeta, model: _uiModelTag/,
    "出线口不再剥 _ideMeta 了——这个标记会被发给模型，白白打断前缀");
});

test("折叠仍然保住用户自己写的规矩", () => {
  const folded = fold({ role: "user", content: opener() });
  assert.ok(folded.content.includes("--- 项目约定 (AGENTS.md) ---"), "项目约定被折没了");
  assert.ok(folded.content.includes("--- 项目记忆（用户 remember 的）---"), "项目记忆被折没了");
  assert.ok(folded.content.includes("📌 用户请求"), "用户请求被折没了");
  assert.ok(!folded.content.includes("src/foo.js\nsrc/foo.js"), "目录树没被折掉，等于没省");
});
