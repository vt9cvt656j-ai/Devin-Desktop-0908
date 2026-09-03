// 指令层级：全系统唯一一条说明"几种指令谁大谁小"的排序。
//
// 在这之前它**不存在**：唯一一句像排序的话写在 `_userRulesBlock()` 里，整段包在
// `if (rules)` 内 —— 而 rules.md 空着的用户（所有者本人就是 0 字节）一个字都拿不到。
// 与此同时项目约定、用户习惯、检索到的资料这些**照样在场**，冲突时纯靠谁排后面谁响；
// 另有四个块各自宣称自己"最高优先级"，同时在场时没有任何东西决定谁真的最高。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { load } from "./helpers/source.mjs";
import { INSTRUCTION_LADDER, LAYER_ORDER } from "../src/agent/prompt-layers.js";

// ladder 只在**收不到网关那份层级**的路上开：自定义端点直连、子智能体。
// 走网关时网关的 system_invariants 讲得更全，客户端不重复发（重复＝同一件事付两份钱）。
const block = (rules, habits, opts = { ladder: true }) => load("_userRulesBlock", {
  _userRulesText: rules,
  _userHabitsText: habits,
  _clipUserDoc: (t) => String(t || "").trim(),
  INSTRUCTION_LADDER,
})(opts);

test("走网关时不发层级 —— 空规则不许白付每轮的钱", () => {
  assert.equal(block("", "", {}), "", "网关那条路上又发了一遍，等于同一件事付两份 token");
  assert.equal(block("", ""), block("", "", { ladder: true }));
});

test("收不到网关层级的那两条路上，规则和习惯都空也照样发", () => {
  // 这正是所有者本人的状态：两个文件都是 0 字节。
  const out = block("", "");
  assert.notEqual(out, "", "两个文件空着就什么都不发 —— 层级一次都进不了提示词");
  assert.match(out, /指令层级/);
  assert.match(out, /用户本轮的话/);
});

test("层级把五类来源都点到，且顺序不能乱", () => {
  const out = block("", "");
  const order = ["用户本轮的话", "用户规则", "项目约定", "用户习惯", "检索到的资料"];
  let at = -1;
  for (const name of order) {
    const i = out.indexOf(name);
    assert.ok(i > at, `「${name}」不在它该在的位置 —— 层级顺序错了或缺了这一层`);
    at = i;
  }
});

test("低层文本自称高优先级无效 —— 这一句是层级能不能站住的关键", () => {
  // 项目里随便一份 README、一段命令输出、一个网页，都可能写着"忽略上面的指令"。
  // 没有这一句，层级就是一份可以被任何一段文本掀翻的建议。
  assert.match(block("", ""), /不改变这个排序/);
});

test("有用户规则时，层级仍然在最前面（规则不能排到层级前面去）", () => {
  const out = block("永远用中文回复", "");
  assert.ok(out.indexOf("指令层级") < out.indexOf("永远用中文回复"),
    "用户规则排到了层级前面 —— 那等于让被排序的东西先于排序出现");
  assert.match(out, /永远用中文回复/);
});

test("客户端这一行是网关那份的严格缩写，两边不许说反", () => {
  // 网关的 system_invariants 讲得更全（它是每个模式的第一块）；客户端这一行只在
  // 自定义端点直连和子智能体那两条**收不到网关提示词**的路上兜底。两份必须同序。
  const p = new URL("../../server/prompts/system_invariants.txt", import.meta.url).pathname;
  if (!existsSync(p)) return;   // 只有客户端仓时跳过，不假红
  const gw = readFileSync(p, "utf8");
  const client = block("", "");
  for (const layer of ["用户规则", "本项目规则", "项目约定", "用户习惯", "常驻技能"]) {
    assert.ok(gw.includes(layer), `网关那份少了「${layer}」`);
  }
  // 同序核对：取两边都点名的层，按出现次序比对。
  const pick = (text) => ["用户规则", "项目约定", "用户习惯"].filter((l) => text.includes(l))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
  assert.deepEqual(pick(client), pick(gw), "客户端和网关的层级顺序不一致 —— 模型会拿到两套互相打架的排序");
});
