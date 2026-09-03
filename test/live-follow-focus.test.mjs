// 智能体写文件时，绝不把用户的插入点抢走。
//
// 用户实拍：「写完代码后，我的光标被移到左边打开的文件末尾」。链路是
//   agent 要写文件 → 自动打开它给用户看（这是「实时跟随」的本意，没错）
//   → activate() 里那句 monacoEditor.focus() 是**无条件**的
//   → 焦点从聊天输入框/终端/搜索框被夺进编辑器，插入点落在文件末尾
//   → 用户下一个字打进了代码里。
//
// 跟随策略本来就有「任何时候都不许动光标」，但那一条只挡住了 setPosition。
// 抢焦点是同一件事的另一条路，而且更狠：setPosition 至少还在同一个编辑器里，
// 抢焦点是跨控件把人从他正在打字的地方拽走。

import test from "node:test";
import assert from "node:assert/strict";
import { followAllows } from "../src/agent/live-follow.js";
import { SRC } from "./helpers/source.mjs";

test("抢焦点：任何情况下都不允许", () => {
  for (const on of [true, false]) {
    for (const editorFocused of [true, false]) {
      assert.equal(followAllows("takeFocus", { on, editorFocused }), false,
        `on=${on} editorFocused=${editorFocused} 时把焦点抢走了`);
    }
  }
});

test("「不抢当前标签」那条拦不住抢焦点 —— 所以必须单独有一条", () => {
  // 这是这个 bug 能存在的原因：activateTab 只看「用户是不是正在**编辑器里**打字」，
  // 而人在聊天框里打字时它是 false，于是一路放行。
  assert.equal(followAllows("activateTab", { on: true, editorFocused: false }), true,
    "样本前提变了：activateTab 在编辑器无焦点时本来就该放行");
  assert.equal(followAllows("takeFocus", { on: true, editorFocused: false }), false,
    "同样的条件下抢焦点必须仍被拒 —— 否则这个 bug 原样回来");
});

test("自动打开文件本身照旧允许（跟随的本意没被改掉）", () => {
  assert.equal(followAllows("openFile", { on: true, editorFocused: false }), true);
  assert.equal(followAllows("openFile", { on: true, editorFocused: true }), true);
  assert.equal(followAllows("openFile", { on: false }), false, "开关关掉就什么都不做");
});

test("认不出的动作一律拒绝（新增动作必须显式表态）", () => {
  assert.equal(followAllows("steal-everything", { on: true }), false);
  assert.equal(followAllows(undefined, { on: true }), false);
});

test("接线：activate 的焦点是可选的，且跟随那条路把它关掉", () => {
  assert.match(SRC, /function activate\(path, \{ focus = true \} = \{\}\)/,
    "activate 不接受 focus 选项 —— 那就没有「打开但不抢焦点」这条路");
  assert.match(SRC, /if \(focus\) monacoEditor\.focus\(\);/,
    "activate 里的 focus() 还是无条件的 —— 插入点照样被夺走");
  assert.match(SRC, /_followOk\("openFile"\)[\s\S]{0,220}focus: _followOk\("takeFocus"\)/,
    "跟随打开文件时没把 focus 交给策略判 —— 加了策略却没接上等于没改");
});

test("用户自己点开文件时**要**给焦点（别把 bug 修成另一个 bug）", () => {
  // activate 的默认值必须是 true：它有十几个调用点，绝大多数是用户点击标签、
  // 点搜索结果、点问题面板 —— 那些场景不给焦点会让「点开了却不能打字」。
  assert.match(SRC, /function activate\(path, \{ focus = true \}/,
    "默认值不是 true —— 用户点开文件后光标不在编辑器里");
});
