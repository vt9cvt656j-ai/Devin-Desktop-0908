// 官网「下载 Mac 版」到底该给哪个包 —— 判断逻辑的行为测试。
//
// 为什么值得一个测试文件：这段逻辑**一旦判错，页面上什么都不会报错**。用户拿到一个
// 装不上的 DMG（arm64 包在 Intel 机器上直接「不支持此类 Mac」），或者悄悄拿到一个
// 靠 Rosetta 翻译执行的包。两种都不会有任何日志、任何异常、任何红色。
//
// 这里用的字符串都是**真实浏览器在真实机器上会给出的原文**，不是随手编的样例 ——
// 编出来的样例只能测到我以为的形状，测不到实际形状。
//
// 只测纯函数那一半（lib/mac-arch.js）。取信号那一半要浏览器，在 Node 里跑不了，
// 但它只有取值没有判断，出错方式是"取不到"，会退化成 null 而不是判错。
import test from "node:test";
import assert from "node:assert/strict";
import {
  archFromClientHint,
  archFromRenderer,
  pickMacArch,
} from "../website/src/lib/mac-arch.js";

test("客户端提示：Chromium 给的 architecture 直接映射", () => {
  assert.equal(archFromClientHint("arm"), "arm64");
  assert.equal(archFromClientHint("x86"), "x64");
  // 没有这个 API、或者提示被拒 —— 都不是「Intel」，是「不知道」。
  assert.equal(archFromClientHint(undefined), null);
  assert.equal(archFromClientHint(""), null);
  assert.equal(archFromClientHint("x86_64"), null, "没见过的值不许瞎猜");
});

test("GPU 字符串：M 系机器上各浏览器的真实原文都判成 arm64", () => {
  for (const gpu of [
    "Apple GPU", // Safari,M 系上是这个通用串
    "Apple M1",
    "Apple M2 Pro",
    "ANGLE (Apple, Apple M1, OpenGL 4.1 Metal - 76.3)", // Chrome
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)",
  ]) {
    assert.equal(archFromRenderer(gpu), "arm64", gpu);
  }
});

test("GPU 字符串：Intel 机器上的真实原文都判成 x64", () => {
  for (const gpu of [
    "Intel(R) Iris(TM) Plus Graphics 655",
    "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)",
    "AMD Radeon Pro 5500M OpenGL Engine",
    "ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)",
    "NVIDIA GeForce GT 750M OpenGL Engine",
  ]) {
    assert.equal(archFromRenderer(gpu), "x64", gpu);
  }
});

test("GPU 判据的顺序：含 Intel/AMD/NVIDIA 的一律 x64,哪怕串里也有 Apple", () => {
  // Intel Mac 上出现过同时带两边字样的写法。厂商名是硬事实,"Apple" 可能只是
  // 「Apple 出的这台机器」的意思 —— 所以厂商名优先,不能反过来。
  assert.equal(archFromRenderer("Apple Intel(R) Iris(TM) Graphics"), "x64");
  assert.equal(archFromRenderer("ANGLE (Apple, AMD Radeon Pro 560X, OpenGL 4.1)"), "x64");
});

test("GPU 取不到时不下结论", () => {
  assert.equal(archFromRenderer(""), null);
  assert.equal(archFromRenderer(undefined), null);
  assert.equal(archFromRenderer("WebKit WebGL"), null, "被抹成通用串 = 不知道");
  assert.equal(archFromRenderer("Mesa/X.org llvmpipe"), null);
});

test("Rosetta:M 系上跑的 x86 Chrome —— GPU 赢,给 arm64 包", () => {
  // 这是这个顺序存在的全部理由。客户端提示读的是**当前进程**架构,Rosetta 下的
  // Chrome 老实报 "x86";但 GPU 不经 Rosetta 翻译,它说这台机器是 Apple 的。
  // 按提示走会把一台 M 系 Mac 判成 Intel,用户拿到翻译执行的包还不知道。
  assert.equal(
    pickMacArch({ architecture: "x86", renderer: "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)" }),
    "arm64",
  );
});

test("真 Intel Mac:两个信号一致,不会被上面那条规则误伤", () => {
  assert.equal(
    pickMacArch({
      architecture: "x86",
      renderer: "ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1)",
    }),
    "x64",
  );
});

test("GPU 没结论时退回客户端提示", () => {
  assert.equal(pickMacArch({ architecture: "arm", renderer: "" }), "arm64");
  assert.equal(pickMacArch({ architecture: "x86", renderer: "WebKit WebGL" }), "x64");
});

test("两个信号都没有 = null,页面必须自己准备出路", () => {
  assert.equal(pickMacArch({}), null);
  assert.equal(pickMacArch({ architecture: undefined, renderer: undefined }), null);
});

test("Safari on M 系:没有客户端提示,只靠 GPU 也能判对", () => {
  assert.equal(pickMacArch({ renderer: "Apple GPU" }), "arm64");
});
