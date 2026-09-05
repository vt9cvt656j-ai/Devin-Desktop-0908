// automation / computer 两个入口的合法方法表。从 main.js 原样搬出来（尺寸闸），
// 名字不变：映射层的校验、报错清单、以及测试里按名抠取都还认它们。

// computer 工具的合法动作。**唯一一份**：schema 的 enum、映射层的白名单、以及报错时
// 那句「可用的是：…」以前是三处手抄，漏了 mouse.position——模型照 schema 调，撞一句
// 「不支持的动作」，还附一份同样漏掉它的清单，于是认定读不到指针位置。
// sidecar（automation-framework/src/rpc.rs）**真正实现**的方法全集。
//
// automation 此前零校验直通后端：方法名写错会一路打到 sidecar 才失败，而那边回的是
// 一句底层错误，模型拿不到"可用的是这些"这份清单，只能猜下一个名字再来一轮。
// computer 走 _COMPUTER_METHODS 校验、不认识就报 invalidMethod（全文件唯一产地），
// 于是同一个笔误在两个入口上的代价差着好几轮往返。
//
// 这份是**超集**：computer 是它里面挑出来的、不含 browser.* / recorder.* / sleep 的
// 那一档（那几族有自己的专用工具，或者会让模型拿它当 sleep 用）。
export const _AUTOMATION_METHODS = [
  "mouse.click", "mouse.double_click", "mouse.triple_click", "mouse.down", "mouse.up",
  "mouse.move", "mouse.position", "mouse.drag", "mouse.scroll",
  "keyboard.type", "keyboard.press", "keyboard.combo", "keyboard.down", "keyboard.up",
  "keyboard.hold", "keyboard.paste",
  "screen.info", "screen.displays", "screen.capture", "screen.elements", "screen.probe", "screen.act",
  "clipboard.get", "clipboard.set",
  "window.list", "window.activate", "window.minimize", "window.restore",
  "recorder.save", "recorder.list", "recorder.replay",
  "browser.start", "browser.goto", "browser.click", "browser.type", "browser.wait",
  "browser.eval", "browser.content", "browser.screenshot", "browser.close",
  "system.init", "system.open", "sleep",
];

export const _COMPUTER_METHODS = [
  "mouse.click", "mouse.double_click", "mouse.triple_click", "mouse.down", "mouse.up", "mouse.move", "mouse.position", "mouse.drag", "mouse.scroll",
  "keyboard.type", "keyboard.press", "keyboard.combo", "keyboard.down", "keyboard.up", "keyboard.hold", "keyboard.paste",
  // screen.capture：**真的拍屏幕像素**。在它之前整套系统没有任何一条通路能看到桌面
  // ——screenshot 工具只会用无头浏览器渲染一个 http(s) 网址，于是模型对任何原生应用、
  // 游戏、Canvas、视频、PDF 都是全盲的：动完手没法看一眼确认自己做成没有。
  // 不给 x/y/width/height 就是整屏；四个要么都给要么都不给。
  "screen.info", "screen.displays", "screen.capture", "clipboard.get", "clipboard.set",
  "window.list", "window.activate", "window.minimize", "window.restore",
];
