/**
 * 「实时跟随」到底允许动什么。
 *
 * 这个开关的文案是「智能体干活时会自动打开相关文件、终端或面板，让你看到每一步」。
 * 它原来只管住了一条路（_stageForTool），而**编辑器里的流式写入预览**是另一条：
 * 它自己读盘、建模型、开标签、`activate(path)` 切走用户的当前标签，全程没看过这个开关。
 * 用户实拍：「这里按钮关闭的话，这个功能也还是生效的」。
 *
 * 这里把「允许做什么」变成一个可测的判断，而不是散在各处的 if。三条判据，各自的理由：
 *
 *  ① **关掉就什么都不做。** 不是"少做一点"——关掉的语义是"视图由我控制"。
 *  ② **开着也不许抢当前标签**，只要用户此刻正在编辑器里打字。焦点在编辑器＝人在工作，
 *     这时候把标签切走是直接打断他。
 *  ③ **任何时候都不许动光标。** 跟随是"把视图滚过去给你看"，`setPosition` 动的是
 *     **用户的光标**——他在别处写字，光标被拽到智能体写入的末尾，下一个字就打错地方了。
 *     滚动可以撤销（滚回去就行），光标被移走造成的误输入不能。
 */

/** 关掉时一律不做。判据本身在调用方（读 localStorage），这里只做纯判断。 */
export function followAllows(action, ctx = {}) {
  const { on = true, editorFocused = false } = ctx;
  if (!on) return false;
  switch (action) {
    // 开标签、切标签、开终端：都是"自动打开"，开关开着才做。
    case "openFile":
    case "openTerminal":
    case "revealInTree":
      return true;
    // 切走用户当前正在编辑的标签：人在打字时不做。
    case "activateTab":
      return !editorFocused;
    // 滚动到写入位置：同上，人在打字时不抢他的视口。
    case "revealLine":
      return !editorFocused;
    // 移动光标：**永远不**。见上面 ③。
    case "moveCursor":
      return false;
    default:
      return false;
  }
}
