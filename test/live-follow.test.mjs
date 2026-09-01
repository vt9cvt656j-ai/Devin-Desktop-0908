// 「实时跟随」这个开关到底管住了什么。
//
// 用户实拍两条：「这里按钮关闭的话，这个功能也还是生效的」「实时跟随过程中不要影响
// 右边用户或者左边工作目录用户的操作，光标不要被乱移动走」。
//
// 第一条的根因：开关只管住了 _stageForTool 一条路。而**编辑器里的流式写入预览**是
// 另一条完全独立的路 —— 它自己读盘、建模型、开标签、activate(path) 切走用户的当前
// 标签，全程没看过这个开关。
import { test } from "node:test";
import assert from "node:assert/strict";
// 按 AST 取函数体，不手工切 —— 手工切靠的是"下一个函数在后面"，
// 而 _streamWritePath 恰好排在 _ensureLiveEditorWritePreview **前面**，切出来是空的。
import { fnSource } from "./helpers/source.mjs";
import { followAllows } from "../src/agent/live-follow.js";

test("关掉就什么都不做——不是少做一点", () => {
  // 关掉的语义是「视图由我控制」，不是「少打扰一些」。
  for (const a of ["openFile", "openTerminal", "revealInTree", "activateTab", "revealLine", "moveCursor"]) {
    assert.equal(followAllows(a, { on: false }), false, `关掉之后还允许 ${a}`);
    assert.equal(followAllows(a, { on: false, editorFocused: false }), false, `关掉之后还允许 ${a}`);
  }
});

test("光标永远不许动——开着也不行", () => {
  // 滚走了可以滚回来；光标被拽到别处，下一个字就打错地方，那个回不来。
  // 两者代价不对称，所以这一条不看开关也不看焦点。
  for (const ctx of [{ on: true }, { on: true, editorFocused: false }, { on: false }]) {
    assert.equal(followAllows("moveCursor", ctx), false, `${JSON.stringify(ctx)} 下还允许移动光标`);
  }
});

test("人正在编辑器里打字时，不抢标签也不滚视口", () => {
  const typing = { on: true, editorFocused: true };
  assert.equal(followAllows("activateTab", typing), false, "用户在打字还把标签切走");
  assert.equal(followAllows("revealLine", typing), false, "用户在打字还把视口滚走");
  // 但「打开一个还没开的文件」不受影响：那不动他当前在看的东西。
  assert.equal(followAllows("openFile", typing), true, "开文件被误伤了");
  assert.equal(followAllows("revealInTree", typing), true, "在树里高亮被误伤了");
});

test("开着且人没在打字时，该做的都做", () => {
  const idle = { on: true, editorFocused: false };
  for (const a of ["openFile", "openTerminal", "revealInTree", "activateTab", "revealLine"]) {
    assert.equal(followAllows(a, idle), true, `${a} 该做却没做`);
  }
});

test("认不出的动作一律不做", () => {
  // 新增一种跟随动作却忘了在这里定规矩时，默认是"不打扰用户"，不是"随便动"。
  assert.equal(followAllows("somethingNew", { on: true }), false);
  assert.equal(followAllows(undefined, { on: true }), false);
});

test("编辑器流式预览这条路也被开关管住了", () => {
  // 这条是用户实际撞到的那个 bug：它和 _stageForTool 是两条独立的路。
  const fn = fnSource("_ensureLiveEditorWritePreview", { code: true });
  assert.ok(fn.length > 400, "_ensureLiveEditorWritePreview 没切出来，锚点漂了");
  assert.match(fn, /_followOk\("openFile"\)/,
    "关掉开关之后，智能体照样会在用户的编辑器里开标签、一行行写字");
});

test("setPosition 不许回到流式刷新里", () => {
  // 那一句是每次刷新都把用户的光标拽到写入末尾。删掉它是这次修复的核心，
  // 而它长得很像"顺手带上"的一句，最容易被后来的人加回来。
  const fn = fnSource("_flushLiveEditorWritePreview", { code: true });
  assert.ok(fn.length > 400, "_flushLiveEditorWritePreview 没切出来，锚点漂了");
  assert.doesNotMatch(fn, /setPosition/, "又在流式刷新里移动用户的光标了");
  assert.match(fn, /_followOk\("revealLine"\)/, "滚动没有让路给正在打字的用户");
});

test("切标签那一句也让路", () => {
  const fn = fnSource("_installLiveEditorWritePreview", { code: true });
  assert.match(fn, /_followOk\("activateTab"\)/, "装预览时无条件把用户的标签切走了");
});

test("三个自动打开的动作各自判，不是笼统一个开关", () => {
  const fn = fnSource("_stageForTool", { code: true });
  assert.ok(fn.length > 400, "_stageForTool 没切出来");
  for (const a of ["openTerminal", "openFile", "revealInTree"]) {
    assert.match(fn, new RegExp(`_followOk\\("${a}"\\)`), `${a} 没有单独判`);
  }
  // 笼统那句要没了：它挡不住"人在打字时别抢标签"这一类更细的规矩。
  assert.doesNotMatch(fn, /if \(!call \|\| !_liveStageOn\(\)\) return;/, "又退回笼统一个开关了");
});
