import test from "node:test";
import assert from "node:assert/strict";

import { ansiToHtml, ansiToText, xterm256Hex } from "../src/agent/ansi.js";

const E = "\x1b";

test("SGR 颜色变成语义 class，而不是原样打出 [31m", () => {
  const html = ansiToHtml(`${E}[31m错误${E}[0m 正常`);
  assert.equal(html, '<span class="ansi-fg-red">错误</span> 正常');
  assert.ok(!html.includes("[31m"), "转义码不能作为可见文本漏出来");
});

test("亮色、加粗、下划线各自有 class", () => {
  assert.match(ansiToHtml(`${E}[91mx`), /ansi-fg-bred/);
  assert.match(ansiToHtml(`${E}[1mx`), /ansi-bold/);
  assert.match(ansiToHtml(`${E}[4mx`), /ansi-underline/);
  assert.match(ansiToHtml(`${E}[42mx`), /ansi-bg-green/);
  assert.match(ansiToHtml(`${E}[100mx`), /ansi-bg-bblack/);
});

test("同一段样式只开一个 span，不是每个字符一个", () => {
  const html = ansiToHtml(`${E}[32m通过通过通过${E}[0m`);
  assert.equal(html.match(/<span/g).length, 1);
});

test("256 色与真彩色走内联样式", () => {
  assert.match(ansiToHtml(`${E}[38;5;208m橙`), /style="color:#ff8700"/);
  assert.match(ansiToHtml(`${E}[38;2;18;52;86m色`), /style="color:#123456"/);
  assert.match(ansiToHtml(`${E}[48;2;255;0;0m底`), /style="background-color:#ff0000"/);
});

test("256 色的前 16 个索引仍然用主题 class（跟着深浅色走）", () => {
  assert.match(ansiToHtml(`${E}[38;5;1mx`), /ansi-fg-red/);
  assert.match(ansiToHtml(`${E}[38;5;9mx`), /ansi-fg-bred/);
});

test("xterm256Hex 覆盖立方体与灰阶两段", () => {
  assert.equal(xterm256Hex(16), "#000000");
  assert.equal(xterm256Hex(231), "#ffffff");
  assert.equal(xterm256Hex(232), "#080808");
  assert.equal(xterm256Hex(255), "#eeeeee");
  assert.equal(xterm256Hex(15), null, "0-15 该走主题 class，不是硬编码 hex");
  assert.equal(xterm256Hex(256), null);
});

test("参数不全的 38 不会把后面的数字当成新的 SGR 码", () => {
  // `38;5` 少一个索引：整条丢掉，后面的 31 也不该被当成红色。
  const html = ansiToHtml(`${E}[38;5m文字`);
  assert.equal(html, "文字");
});

test("光标移动、清屏、隐藏光标这些非 SGR 序列直接丢掉", () => {
  assert.equal(ansiToText(`${E}[2J${E}[H${E}[?25l干净${E}[?25h`), "干净");
  assert.equal(ansiToText(`${E}[1A${E}[2K重画`), "重画");
});

test("OSC（改窗口标题 / 超链接）被丢掉，不会把标题打进正文", () => {
  assert.equal(ansiToText(`${E}]0;某个标题\x07正文`), "正文");
  assert.equal(ansiToText(`${E}]8;;https://x.dev${E}\\链接${E}]8;;${E}\\`), "链接");
});

test("\\r 是回到行首覆盖写，不是换行——进度条只留最后一帧", () => {
  assert.equal(ansiToText("下载 10%\r下载 100%"), "下载 100%");
  assert.equal(ansiToText("abcdef\rXY"), "XYcdef");
  // \r\n 是普通换行，不能把上一行清掉。
  assert.equal(ansiToText("第一行\r\n第二行"), "第一行\n第二行");
});

test("退格键回退一格", () => {
  assert.equal(ansiToText("abc\b\bX"), "aXc");
});

test("HTML 被转义——命令输出是不可信内容", () => {
  assert.equal(ansiToHtml("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  const img = ansiToHtml('<img src=x onerror="alert(1)">');
  assert.ok(!img.includes("<img"), img);
  assert.ok(img.startsWith("&lt;img"), img);
});

test("即使颜色码把 span 属性拼出来，注入的也只能是我们自己的 class", () => {
  // 攻击面：SGR 参数只允许数字，正则不接受引号，拼不出属性来。
  const html = ansiToHtml(`${E}[31;"onload=alert(1)"m x`);
  assert.ok(!html.includes("onload"), html);
});

test("maxChars 按可见字符截断，转义码不占额度", () => {
  const long = `${E}[31m` + "字".repeat(50);
  const out = ansiToText(long, { maxChars: 10 });
  assert.ok(out.startsWith("字".repeat(10)), out);
  assert.match(out, /输出已截断/);
  // 没超过就不该有截断提示。
  assert.equal(ansiToText("短", { maxChars: 10 }), "短");
});

test("中文、emoji、制表符原样保留", () => {
  const s = "中文\t测试 ✅ 🚀";
  assert.equal(ansiToText(s), s);
});

test("空输入不炸", () => {
  assert.equal(ansiToHtml(""), "");
  assert.equal(ansiToHtml(null), "");
  assert.equal(ansiToHtml(undefined), "");
  assert.equal(ansiToText(""), "");
});

test("反显（ESC[7m）会交换前景背景", () => {
  const html = ansiToHtml(`${E}[7m反显`);
  assert.match(html, /ansi-fg-default/);
  assert.match(html, /ansi-bg-default/);
  const swapped = ansiToHtml(`${E}[31;7m反显`);
  assert.match(swapped, /ansi-bg-red/, "31 是前景红，反显后应该变成背景红");
});

test("真实的 cargo/pytest 片段整段渲染得出来", () => {
  const real =
    `${E}[0m${E}[1m${E}[32m   Compiling${E}[0m michael-ide v0.3.94\n` +
    `${E}[0m${E}[1m${E}[33mwarning${E}[0m${E}[0m${E}[1m: unused variable\n` +
    `${E}[0m${E}[1m${E}[31merror${E}[0m: 1 个错误\n`;
  const text = ansiToText(real);
  assert.ok(text.includes("Compiling"), text);
  assert.ok(text.includes("1 个错误"), text);
  assert.ok(!text.includes("\x1b"), "不能有转义字节残留");
  const html = ansiToHtml(real);
  assert.match(html, /ansi-fg-green/);
  assert.match(html, /ansi-fg-yellow/);
  assert.match(html, /ansi-fg-red/);
});

test("纯文本走短路快路径，结果和全解析一致", () => {
  const plain = "line one\nline two\t中文 ✅";
  assert.equal(ansiToText(plain), plain);
  assert.equal(ansiToHtml(plain), plain);
  // 快路径也要转义。
  assert.equal(ansiToHtml("a<b>c"), "a&lt;b&gt;c");
  // 快路径的截断行为要和慢路径一样。
  assert.match(ansiToText("x".repeat(50), { maxChars: 10 }), /^x{10}\n… 输出已截断$/);
  assert.match(ansiToHtml("x".repeat(50), { maxChars: 10 }), /输出已截断/);
});

test("2MB 构建日志不会把界面卡住", () => {
  const big = ("cargo: compiling crate number 12345\n").repeat(60000);
  const t0 = process.hrtime.bigint();
  const out = ansiToText(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(out.length, big.length);
  assert.ok(ms < 200, `纯文本 ${(big.length / 1e6).toFixed(1)}MB 花了 ${ms.toFixed(0)}ms`);
});

// ── 擦行 / 光标定位 ──────────────────────────────────────────────────
// 进度条的标准写法是「擦行 + 回车 + 写新的一帧」。第一版只认 \r 不认 EL，把清空
// 那一半吞了，于是新帧短于旧帧时旧帧的尾巴留在原地，拼出屏幕上从来没有过的字符串
// ——而这些伪造的 token 会一路进模型上下文。

test("ESC[K 擦到行尾——新帧比旧帧短时不会留下旧帧的尾巴", () => {
  assert.equal(ansiToText(`Downloading 50%\r${E}[KDone`), "Done");
  assert.equal(ansiToText(`abcdef\rXY${E}[0K`), "XY");
});

test("ESC[2K 擦整行——cargo 风格的重画不会拼出假版本号", () => {
  assert.equal(
    ansiToText(`  Compiling serde v1.0.200${E}[2K\r    Finished dev profile`),
    "    Finished dev profile",
  );
  // 这条是回归的原样本：修之前得到的是 "    Finished dev profile00"
  assert.ok(!ansiToText(`  Compiling serde v1.0.200${E}[2K\r    Finished`).includes("00"));
});

test("ESC[1K 擦到行首——光标不动，前面变成空白", () => {
  assert.equal(ansiToText(`abcdef${E}[1K`), "      ");
});

test("ESC[1G 回到第一列——npm/yarn 的 spinner 不再堆成一行", () => {
  const spinner = `⠋ Installing${E}[1G${E}[0K⠙ Installing${E}[1G${E}[0K✔ Installed`;
  assert.equal(ansiToText(spinner), "✔ Installed");
  assert.equal(
    ansiToText(`sill resolveWithNewModule${E}[2K${E}[1Gadded 412 packages`),
    "added 412 packages",
  );
});

test("ESC[nC / ESC[nD 前后移动光标", () => {
  assert.equal(ansiToText(`ab${E}[2Ccd`), "ab  cd");
  assert.equal(ansiToText(`abcd${E}[2DXY`), "abXY");
});

test("裸 \\r 仍然只回列、不清行——没有 EL 就不该擅自清空", () => {
  assert.equal(ansiToText("abcdef\rXY"), "XYcdef");
});

test("私有序列（ESC[?25l）不会被当成 EL/CHA 执行", () => {
  assert.equal(ansiToText(`abc${E}[?2Kdef`), "abcdef");
  assert.equal(ansiToText(`${E}[?25l隐藏光标${E}[?25h`), "隐藏光标");
});

test("清屏（ESC[2J）不擦掉已经产出的行——捕获的是流水不是屏幕", () => {
  assert.equal(ansiToText(`第一行\n${E}[2J${E}[H第二行`), "第一行\n第二行");
});

test("maxChars 也约束换行——几十万个空行不能整段穿过去", () => {
  const many = `${E}[0m` + "\n".repeat(200_000) + "x".repeat(50);
  const out = ansiToText(many, { maxChars: 10 });
  assert.ok(out.length < 40, `实际长度 ${out.length}`);
  assert.match(out, /输出已截断/);
  assert.ok(ansiToHtml(many, { maxChars: 10 }).length < 200, "HTML 侧同样要被约束住");
});

test("离谱的光标列数撑不爆行数组", () => {
  const out = ansiToText(`a${E}[100000Cb`);
  assert.ok(out.length <= 4100, `实际长度 ${out.length}`);
  const back = ansiToText(`a${E}[999999Db`);
  assert.equal(back, "b");
});

// ── ansi.js 产出的 class，样式表里必须真的给得出颜色 ──────────────────────────
//
// 这两条守的是一种**不报错的失效**：`.ansi-fg-red { color: var(--ansi-red) }` 里的变量
// 一旦没有定义，那条声明整条作废，文字静默退回继承色 —— 屏幕上看起来只是「这条命令
// 没输出颜色」，没有任何一处会喊。
//
// 它真的发生过：这组变量原来挂在 `.agent-term-output`（那张已被删掉的终端大卡）上，
// 卡片删掉时定义跟着走了，而消费它们的 16 条 `.ansi-fg-*` 规则留在原地，于是从那以后
// 所有带色输出都是哑的。现在定义挂在 `.atc-term-out` 自己身上——变量和用它的元素同生共死。
import { readFileSync } from "node:fs";

const APP_CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("每个 ansi-fg-* / ansi-bg-* 用到的变量，样式表里都定义得出来", () => {
  // 消费方：`color: var(--ansi-xxx)` 这一族。
  const consumed = new Set(
    [...APP_CSS.matchAll(/var\((--ansi-[a-z]+)\)/g)].map((m) => m[1]),
  );
  assert.ok(consumed.size >= 16, `只找到 ${consumed.size} 个消费点，选择器改名了？`);

  // 定义方：`--ansi-xxx: #hex`。注释里出现的不算，所以要求后面跟着冒号和颜色值。
  const defined = new Set(
    [...APP_CSS.matchAll(/(--ansi-[a-z]+)\s*:\s*#[0-9a-fA-F]{3,8}/g)].map((m) => m[1]),
  );

  const missing = [...consumed].filter((v) => !defined.has(v));
  assert.deepEqual(
    missing,
    [],
    `这些变量有人用、没人定义，带色输出会静默变成继承色：${missing.join(", ")}`,
  );
});

test("ANSI 色板明暗各一套，深色那套挂在 data-theme=\"dark\" 下", () => {
  // 一套色板必然有一边糊在背景里：浅色底上要暗一档，深色底上要亮一档。
  const darkBlock = APP_CSS.match(
    /:root\[data-theme="dark"\]\s+\.atc-term-out\s*\{[^}]*\}/,
  );
  assert.ok(darkBlock, "深色那套 ANSI 色板不见了");
  assert.match(darkBlock[0], /--ansi-red\s*:/, "深色块里没有重新给色");

  // 浅色那套必须是**基色**（不带 data-theme 前缀）：main.js 要等 setTheme 跑完才挂属性，
  // 在那之前没有属性，基色写成深色会让每次启动先闪一下黑块。
  const base = APP_CSS.match(/(?<!\])\n\.atc-term-out\s*\{[^}]*--ansi-red[^}]*\}/);
  assert.ok(base, "浅色那套 ANSI 色板不是基色（或者被挂到了某个主题选择器下面）");
});

test("命令输出的底色跟随主题，浅色下不许是深色", () => {
  // 用户实拍否掉过一版：浅色主题下一张白卡中间嵌一块纯黑。深色留给主题，不留给内容类型。
  const rules = [...APP_CSS.matchAll(/^[^\n{}]*\.atc-term-out[^\n{}]*\{([^}]*)\}/gm)];
  assert.ok(rules.length >= 3, `.atc-term-out 的规则只找到 ${rules.length} 条，锚点漂了`);

  for (const [whole, body] of rules) {
    const selector = whole.slice(0, whole.indexOf("{"));
    const bg = body.match(/(?:^|;)\s*background\s*:\s*([^;]+)/);
    if (!bg) continue;
    const value = bg[1].trim();
    const isDarkTheme = selector.includes('data-theme="dark"');
    if (isDarkTheme) continue;
    assert.doesNotMatch(
      value,
      /#(0|1|2)[0-9a-fA-F]{5}\b/,
      `浅色/基色规则又把命令输出写死成深底了：${selector.trim()} → ${value}`,
    );
  }
});
