// 会话标签页的标题从第一句话里取，而不是固定的 Chat 1 / Chat 2 / Chat 3。
//
// 用户：「要弄成 cursor 那种 tab 标题的，而不是我这种固定的 Chat 1、Chat 2、Chat 3」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatTitleFrom, isDefaultChatName } from "../src/agent/chat-title.js";
import { SRC } from "./helpers/source.mjs";

test("标题就是第一句话，按显示宽度截断", () => {
  assert.equal(chatTitleFrom("fix the bug in parse()"), "fix the bug in parse()");
  // 中日韩按两格算：按字符数截的话，中文标题会比英文长出一倍，把后面的文件夹标签挤没。
  const zh = chatTitleFrom("解释 debug_field10.py：整体职责、关键函数、数据流，以及它在项目里扮演的角色。");
  assert.ok(zh.endsWith("…"), "长标题没截断");
  let w = 0; for (const ch of zh) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  assert.ok(w <= 22, `截断后仍然太宽：${w}`);
  // 截断不能把多字节字符切坏。
  assert.doesNotMatch(zh, /�/);
});

test("附件不是标题：代码块、@ 引用、引用出处那行都不算", () => {
  // 拖进来的选区、粘贴的报错都在代码块里，拿它当标题看不出这一轮在聊什么。
  assert.equal(chatTitleFrom("```py\nx = 1\n```\n帮我改成异步的"), "帮我改成异步的");
  assert.equal(chatTitleFrom("@code:a.py#1-2 这段在干嘛？"), "这段在干嘛？");
  assert.equal(chatTitleFrom("@github:owner/repo 这个项目是干嘛的"), "这个项目是干嘛的");
  // 「引用 x.py 第 1-2 行：」是我们自己拼的出处行，不是用户说的话。
  assert.equal(chatTitleFrom("引用 a.py 第 1-2 行：\n```py\nx=1\n```\n看看这段"), "看看这段");
  // markdown 的行首标记不进标题。
  assert.equal(chatTitleFrom("## 标题\n正文"), "标题");
  assert.equal(chatTitleFrom("- 第一条\n- 第二条"), "第一条");
});

test("取不出名字就返回空串——调用方据此保留原名，标签不能变空", () => {
  for (const bad of ["", "   ", "\n\n", "```py\nonly code\n```", "@a.py @b.py", null, undefined]) {
    assert.equal(chatTitleFrom(bad), "", `${JSON.stringify(bad)} 应该取不出标题`);
  }
});

test("默认名认得出来——包括各种语言下建的那些", () => {
  // 「Chat」会跟着界面语言翻，于是同一排标签会出现 Chat 1 / 聊天 2 / Chat 3
  //（它们是在不同语言下建出来的）。这些都算"还没被内容命名过"。
  for (const n of ["Chat 1", "chat 12", "聊天 2", " 聊天 3 ", "チャット 1", "채팅 4"]) {
    assert.equal(isDefaultChatName(n), true, `${n} 应该算默认名`);
  }
  for (const n of ["解释 quota.py", "Chat about auth", "1", "", null]) {
    assert.equal(isDefaultChatName(n), false, `${n} 不该被当成默认名——会把用户的标题冲掉`);
  }
});

test("接线：第一句话落地时改名，只改一次，且不叫模型", () => {
  assert.match(SRC, /import \{ chatTitleFrom as _chatTitleFrom, isDefaultChatName as _isDefaultChatName \}/,
    "main.js 没有引入起标题的模块");
  const i = SRC.indexOf("if (sess && !sess._titled && _isDefaultChatName(sess.name))");
  assert.ok(i > 0, "sendPrompt 里没有按「还叫默认名」门控——会把用户已有的标题反复冲掉");
  const blk = SRC.slice(i, i + 400);
  assert.match(blk, /sess\._titled = true;/, "改完没有标记，后面每一句话都会再改一次标题");
  assert.match(blk, /_renderChatTabs\(\);\s*saveChatHistory\(\);/, "改完没有重绘 / 没有存盘");
  assert.match(blk, /if \(_autoTitle\)/, "取不出标题时也照改——标签会变成空白");
});
