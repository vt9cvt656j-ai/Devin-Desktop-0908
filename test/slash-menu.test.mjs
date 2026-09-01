// `/` 命令弹窗：颜色和宽度。
//
// 用户实拍两条：「把 / 命令这个弹窗也要做成浅色、深色风格」「宽度要和下面的对话框对齐」。
// 第一条的真因不是"没做深色"——它一直走 var(--panel-solid)，明暗都跟着变。问题是
// **助手栏本身就是那个色**，弹窗压上去和背景同色，只剩一圈边框。同一个毛病在工具卡上
// 已经犯过一次（见 test/ask-user-card.test.mjs 里那条底色断言）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE } from "./helpers/source.mjs";

const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const TW = readFileSync(new URL("../src/ui/tailwind.css", import.meta.url), "utf8");

const varsIn = (block) => {
  const m = {};
  for (const [, k, v] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) m[k] = v.trim();
  return m;
};
const blockOf = (src, sel) => {
  const i = src.indexOf(sel);
  assert.notStrictEqual(i, -1, `找不到 ${sel}`);
  return src.slice(src.indexOf("{", i) + 1, src.indexOf("}", i));
};

test("弹层不许和它盖住的面板同色——明暗都要", () => {
  assert.match(TW, /--color-popover: var\(--popover-surface\)/,
    "--color-popover 又指回 --panel-solid 了：弹窗会整个融进助手栏，只剩一圈边框");
  for (const [theme, anchor] of [["浅色", ":root {"], ["深色", '[data-theme="dark"] {']]) {
    const v = varsIn(blockOf(CSS, anchor));
    const pop = (v["--popover-surface"] || "").toLowerCase();
    const panel = (v["--panel-solid"] || "").toLowerCase();
    assert.ok(pop, `${theme}没有定义 --popover-surface`);
    assert.notStrictEqual(pop, panel, `${theme}下弹层 ${pop} 和面板 ${panel} 同色`);
  }
});

test("弹窗左缘和宽度跟着输入条那个盒子，且没有宽度上限", () => {
  const fn = CODE.slice(CODE.indexOf("function _updateSlashMenu"), CODE.indexOf("function _pickSlash"));
  assert.ok(fn.length > 300, "_updateSlashMenu 没切出来，锚点漂了");
  assert.match(fn, /promptEl\.closest\("\.composer__box"\)/,
    "又按文本区算了——文本区比那个圆角盒子窄，弹窗右边会差出一块");
  assert.doesNotMatch(fn, /Math\.min\([^)]*\d{3}\)/,
    "宽度又被封了一个上限——用户要的是和下面对齐，不是「差不多宽」");
  // 三个值同源，菜单才是"贴在这条输入条上面"，而不是三个各算各的。
  for (const prop of ["left", "width", "bottom"]) {
    assert.match(fn, new RegExp(`style\\.${prop} = [^\\n]*\\bb\\.`), `${prop} 没有跟着盒子算`);
  }
});
