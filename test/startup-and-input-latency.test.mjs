// 首屏契约 + 输入路径上的几道闸。
//
// 这些是**调用点顺序**类的不变量：谁排在谁前面、某个常数有没有真的被引用。
// 它们跑不起来（要整个 React + Monaco + Tauri），所以只能做源码断言 ——
// 但一律跑在**剥掉注释**的源文本上（helpers/source.mjs 的 CODE / fnSource({code:true})）：
// 本仓的注释里写满了「_COMPLETION_DEBOUNCE」「isComposing」这类词，
// 拿原文匹配的话，把实现删光、只留注释，断言照样是绿的。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fnSource, stripComments, blockFrom, at } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// boot.jsx 是 JSX，helpers 里那个基于 acorn 的 stripComments 解析不了它，
// 所以这里自带一个朴素剥注释器。朴素版的已知边界：字符串里出现 `//` 会被误伤 ——
// 下面 BOOT_SANE 那条自检就是防止它哪天真剥坏了还闷声跑绿。
const BOOT_RAW = readFileSync(join(HERE, "../src/boot.jsx"), "utf8");
const BOOT = BOOT_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const I18N = stripComments(readFileSync(join(HERE, "../src/i18n.js"), "utf8"));
// CSS 只有块注释；用 JS 解析器去剥它会直接解析失败。
const CSS = readFileSync(join(HERE, "../src/styles/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** 从剥过注释的源文本里按花括号配对取一个函数体。 */
function fnIn(text, decl) {
  const i = text.indexOf(decl);
  if (i < 0) throw new Error(`找不到声明：${decl}`);
  let d = 0;
  for (let j = text.indexOf("{", i); j < text.length; j++) {
    if (text[j] === "{") d++;
    else if (text[j] === "}" && --d === 0) return text.slice(i, j + 1);
  }
  throw new Error(`花括号没配上：${decl}`);
}

// ---------------------------------------------------------------------------
// 首屏契约：缩放/密度/语言必须在第一帧之前生效
// ---------------------------------------------------------------------------

test("剥注释器本身是好的——否则下面几条会退化成拿原文匹配", () => {
  // 本文件的注释里写满了 initLocale / flushSync / --ui-zoom 这些被断言的词。
  // 剥注释器一旦失效，下面几条即使把实现全删光也照样绿。
  assert.ok(BOOT_RAW.includes("首屏契约"), "boot.jsx 里应该有那段中文注释（锚点用）");
  assert.ok(!BOOT.includes("首屏契约"), "块注释没被剥掉：下面的断言会被注释喂绿");
  assert.ok(!BOOT.includes("语言要排在 flushSync 之后"), "行注释没被剥掉");
  // 剥完之后真代码必须还在（别剥过头把代码也吃了）。
  assert.ok(BOOT.includes("flushSync(") && BOOT.includes("createRoot("), "剥过头了，代码被吃掉");
});

test("语言在 flushSync 之后、main.js 之前就初始化", () => {
  const flush = BOOT.indexOf("flushSync(");
  const locale = BOOT.indexOf("initLocale()");
  const main = BOOT.indexOf('import("./main.js")');
  assert.ok(flush > 0 && locale > 0 && main > 0, "三个锚点都要在 boot.jsx 里");
  // applyToDOM 是遍历已有 DOM 做替换的，元素没进文档就是空跑 —— 必须在 flushSync 之后。
  assert.ok(locale > flush, "initLocale 排到了 flushSync 前面：DOM 还没提交，翻译是空跑");
  // 排在 main.js 之后就退回原样：8.3 万行跑完才翻译，用户先看到一屏英文。
  assert.ok(locale < main, "initLocale 排到了 main.js 后面：首屏又会先闪一屏英文");
});

test("缩放和布局密度在 flushSync 之前就写到根元素上", () => {
  const flush = BOOT.indexOf("flushSync(");
  const zoom = BOOT.indexOf("ui-zoom");
  const density = BOOT.indexOf("applyLayoutDensity(");
  assert.ok(zoom > 0 && zoom < flush, "缩放没有排在首帧之前：启动时界面会跳一下");
  assert.ok(density > 0 && density < flush, "布局密度没有排在首帧之前：启动时布局会跳一下");
});

test("缩放要连 --ui-zoom 一起设，否则第一帧红绿灯错位", () => {
  const zoomBlock = BOOT.slice(BOOT.indexOf("ui-zoom"), BOOT.indexOf("flushSync("));
  assert.match(zoomBlock, /style\.zoom\s*=/, "要设 documentElement.style.zoom");
  assert.match(zoomBlock, /setProperty\("--ui-zoom"/,
    "只设 zoom 不设 --ui-zoom：标题栏用 calc(84px / var(--ui-zoom)) 给原生红绿灯留位，第一帧会错位");
});

test("initLocale 是幂等的——它现在被调两次", () => {
  // boot.jsx 调一次（首帧），main.js 末尾再调一次（那时它的 onLocaleChange 才注册上，
  // 语言包异步到货的通知得有人接）。第二次必须不重装 observer、不重跑清理名单。
  const fn = fnIn(I18N, "export function initLocale()");
  assert.match(fn, /_localeInitDone/, "initLocale 没有幂等闸：会装两次 MutationObserver");
  // 用 at()：indexOf 在缺失时返回 -1，而 `-1 < 任何下标` 恒成立 —— 那条顺序断言
  // 就挡不住「把幂等闸整个删掉」，而那正是重构时真会发生的那种。
  assert.ok(at(fn, "_localeInitDone") < at(fn, "installLocaleObserver()"),
    "幂等闸要排在 installLocaleObserver 之前");
  assert.match(fn, /_localePackLoaded/,
    "语言包到货的通知可能早于 main.js 注册监听器，必须记下来由第二次调用补发");
});

// ---------------------------------------------------------------------------
// 输入路径
// ---------------------------------------------------------------------------

test("行内补全的 400ms 防抖真的被引用了，不是个死常量", () => {
  // 这个常量声明了却从没被用过，实际生效的是 Monaco 写死的那几十毫秒 ——
  // 于是连续打字时每一次按键都发一次真实 LLM 请求再立刻取消：两次 IPC、逐字符计费，
  // 而且因为下一键马上取消，用户几乎永远看不到那行灰字。
  const fn = fnSource("initInlineCompletion", { code: true });
  assert.match(fn, /setTimeout\([^)]*,\s*_COMPLETION_DEBOUNCE\)/,
    "provideInlineCompletions 里没有用 _COMPLETION_DEBOUNCE 做等待");
  assert.match(fn, /token\.isCancellationRequested/,
    "等完必须查 token：Monaco 会在下一次按键时取消，不查就等于没防抖");
  // 顺序要紧：先等再查，且都要排在真正发请求之前。
  const wait = fn.indexOf("_COMPLETION_DEBOUNCE)");
  const check = fn.indexOf("token.isCancellationRequested");
  assert.ok(wait < check, "要先等再查取消状态");
});

test("两个 composer input 监听器都有中文输入法闸", () => {
  // **按 AST 取整个回调体**，不切固定字符窗口：helpers 的 stripComments 是拿空格
  // 替换注释（保持偏移量），固定窗口会被空格占满，断言从此守的是一片空白。
  const ANCHOR = 'promptEl.addEventListener("input", (e) => {';
  for (const nth of [0, 1]) {
    const body = blockFrom(ANCHOR, { code: true, nth });
    assert.match(body, /if \(e\.isComposing\)/,
      `第 ${nth + 1} 个 input 监听器没有 isComposing 早退：敲一个汉字的每次 compositionupdate 都会把整棵 DOM 重新序列化好几遍`);
    // 组字过程中占位符仍要同步，否则打拼音时「输入消息…」还挂在那儿。
    const branch = body.slice(at(body, "e.isComposing"), body.indexOf("return;", at(body, "e.isComposing")));
    assert.match(branch, /_cePlaceholder\(\)/,
      `第 ${nth + 1} 个监听器的组字分支必须仍然同步占位符`);
  }
});

test("写文件预览卡：先量距底再写内容", () => {
  const fn = fnSource("_scheduleWritePreviewFlush", { code: true });
  const measure = fn.indexOf("_wasAtBottom");
  const write = fn.indexOf("codeEl.textContent =");
  assert.ok(measure > 0 && write > 0, "两个锚点都要在");
  assert.ok(measure < write,
    "写完再量，量到的是「新内容有多高」而不是「用户往上翻了多远」：一帧新增超过 48px 就判定用户滚开了，从此单向闩死不再跟随");
  assert.match(fn, /if \(_wasAtBottom && pre\) pre\.scrollTop = pre\.scrollHeight;/,
    "要用写之前量到的那个判据来决定跟不跟随");
});

test("思考框没有 scroll-behavior: smooth（自动跟随会被它闩死）", () => {
  assert.doesNotMatch(CSS, /scroll-behavior:\s*smooth/,
    "有 scroll-behavior: smooth：流式时每 ~90ms 一次的 scrollTop 赋值会被变成 ~300ms 的动画并被下一发打断，永远追不上底部，越过 48px 阈值后单向闩死");
});
