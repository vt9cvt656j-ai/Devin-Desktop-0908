// `/` 命令弹窗：颜色和宽度。
//
// 用户实拍两条：「把 / 命令这个弹窗也要做成浅色、深色风格」「宽度要和下面的对话框对齐」。
// 第一条的真因不是"没做深色"——它一直走 var(--panel-solid)，明暗都跟着变。问题是
// **助手栏本身就是那个色**，弹窗压上去和背景同色，只剩一圈边框。同一个毛病在工具卡上
// 已经犯过一次（见 test/ask-user-card.test.mjs 里那条底色断言）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE, SRC as RAW_SRC } from "./helpers/source.mjs";

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

// ── 2026-09-07：面板挡视野、描述看不全、命令太少 ────────────────────────────
//
// 用户实拍：装了三十个技能之后按 `/`，面板一路长到屏幕顶把编辑器整个盖住；而每一行的
// 描述是截断的，想看全只能猜。三件事一起修，各留一条守卫。
const JSX = readFileSync(new URL("../src/ui/slash-menu.jsx", import.meta.url), "utf8");
// 剥掉注释再断言：修这个 bug 时留下的说明里**原样写着**那个坏选择器，不剥的话反向断言
// 会匹配到解释它的那段话，红在一个已经修好的地方。恒真守卫的第四种形状（匹配到自己的注释），
// 这里是它的镜像：不是恒真，是恒假。
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

test("面板有高度上限，而且那条 CSS 规则真的能匹配上", () => {
  // 上一版写的是 `.slashmenu-host .ui-island` —— **后代**选择器，而 `ui-island` 是
  // mountIsland 加在宿主**自己**身上的（两个类在同一个元素上）。那条限高从来没匹配过。
  // 这是恒真守卫的一种：规则写了、测试也可以写得很像样，而它守的是一个空集。
  assert.doesNotMatch(CSS_CODE, /\.slashmenu-host\s+\.ui-island/,
    "又写成后代选择器了：ui-island 和 slashmenu-host 在同一个元素上，这条规则永远不匹配");
  assert.match(CSS_CODE, /\.slashmenu-host\s+\.slashmenu-scroll\s*\{[^}]*max-height/,
    "行容器没有高度上限 —— 面板会一直长到屏幕顶");
  assert.match(CSS_CODE, /\.slashmenu-host\s+\.slashmenu-scroll\s*\{[^}]*overflow-y:\s*auto/,
    "超出高度之后不能滚 —— 后面的命令就永远选不到了");
  assert.match(JSX, /className="slashmenu-scroll/,
    "组件里没有这个滚动容器，上面那条 CSS 规则落空");
});

test("高度按输入条上方的真实空间算，而且这段必须自足", () => {
  const fn = CODE.slice(CODE.indexOf("function _updateSlashMenu"), CODE.indexOf("function _pickSlash"));
  assert.match(fn, /setProperty\("--slash-max-h"/, "算出来的高度没有交给 CSS");
  assert.match(fn, /b\.top/,
    "高度没跟着输入条的位置算 —— 写死一个像素值，矮窗口上照样顶出屏幕");
  // 这个函数会被 test/mcp.test.mjs 整段抠出来**单独求值**：引用任何模块级的新符号，
  // 在那个环境里都是 ReferenceError。所以高度这段只能内联，不许抽常量或辅助函数。
  assert.doesNotMatch(fn, /_SLASH_MENU_[A-Z_]+|_slashMenuMaxHeight/,
    "又把常量/辅助函数引进来了 —— 被抠出来单独求值的那条路会整组 ReferenceError");
});

test("每一行都能悬停看全文——描述那一列本来就是截断的", () => {
  assert.match(JSX, /truncate/, "描述不截断的话这条守卫没有意义，先确认它确实会截");
  assert.match(JSX, /<TooltipTrigger asChild>/, "行上没挂 tooltip 触发器");
  assert.match(JSX, /<TooltipContent[^>]*max-w-/, "tooltip 没有宽度上限，长描述会拉成一条线");
  assert.match(JSX, /whitespace-normal/, "tooltip 里不换行，等于还是看不全");
  assert.match(JSX, /scrollIntoView\(\{ block: "nearest" \}\)/,
    "键盘选中的行不会滚进可见区 —— 有了高度上限之后按方向键看着像没反应");
});

test("内置命令指向的动作必须真的存在", () => {
  const at = CODE.indexOf("const _SLASH = [");
  assert.notStrictEqual(at, -1, "_SLASH 找不到了");
  const block = CODE.slice(at, CODE.indexOf("];", at));
  const cmds = [...block.matchAll(/cmd:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(cmds.length >= 18, `内置命令只剩 ${cmds.length} 条，之前补齐的那批被删了`);
  for (const must of ["new", "sessions", "memory", "terminal", "skills", "mcp", "shortcuts", "settings", "cost", "model",
                      "init", "review", "commit", "security-review", "todos", "research", "explain", "bugs", "refactor", "tests", "docs"]) {
    assert.ok(cmds.includes(must), `内置命令少了 /${must}`);
  }
  // 这几条是**刻意不收**的，别再顺手加回来：模式切换在输入条上已经有选择器（同一件事两个
  // 入口只是把列表撑长），appearance / remote 在设置里点得到（所有者 2026-09-07：没啥用）。
  for (const never of ["agent", "chat", "plan", "appearance", "remote"]) {
    assert.ok(!cmds.includes(never), `/${never} 又回到命令表里了 —— 它是被明确删掉的，不是漏了`);
  }
  assert.equal(new Set(cmds).size, cmds.length, "有重名的内置命令，后一条永远选不到");
  // action 里调到的每个函数，main.js 里都得真的定义过。**一个打不开任何东西的命令比没有
  // 这个命令更糟**：用户敲了没反应，会以为整个斜杠功能坏了。
  const called = [...new Set([...block.matchAll(/\b(_?[a-zA-Z][\w$]*)\(/g)].map((m) => m[1]))];
  // 「定义过」有两种：本文件里的函数，或者从别的模块 import 进来的（`t` 就是后者）。
  // 只认前一种的话，任务类命令用的 t() 会被误报成不存在的函数。
  const defined = (f) => new RegExp(`(?:async )?function ${f}\\(`).test(CODE)
    || new RegExp(`^import \\{[^}]*\\b${f}\\b[^}]*\\} from`, "m").test(RAW_SRC);
  const missing = called.filter((f) => !defined(f));
  assert.deepEqual(missing, [], `这些命令调的函数在 main.js 里不存在：${missing.join(", ")}`);
});

// 模式切换的那条守卫连同 `/agent` `/chat` `/plan` 一起撤了：命令删掉之后模式只剩**一个**
// 入口（输入条上的选择器），当初把它抽成 _setAiMode 的理由（两个入口会漂）不再成立，
// 抽取也一并还原了。留一段理由已经不成立的抽象，比不抽更容易误导下一个人。

test("任务类命令复用已有的提示词，而不是另写一套", () => {
  // 输入框上方那排快捷动作用的就是 assistant.prompt.*，而它们**只在对话是空的时候**出现。
  // 任务类斜杠命令补的正是那一半入口，所以必须指向同一批 key：另写一套文案，两边迟早漂开。
  const at = CODE.indexOf("const _SLASH = [");
  const block = CODE.slice(at, CODE.indexOf("];", at));
  const keys = [...block.matchAll(/t\("(assistant\.prompt\.[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10, `任务类命令只剩 ${keys.length} 条`);
  const i18n = readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8");
  for (const k of new Set(keys)) {
    // EN 和 ZH_CN 各一条。少一边不会报错，只会在那个语种下把 key 本身当文案显示出来。
    assert.equal((i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) || []).length, 2,
      `${k} 在 i18n 里不是恰好两条（EN + ZH_CN 各一条）`);
  }
  // 跟当前文件有关的那几条（/explain /bugs /tests …）必须在**选中的那一刻**取路径。
  assert.match(block, /_slashPromptTarget\(\)/, "文件相关的命令没有动态取当前文件");
  const pickAt = CODE.indexOf("function _pickSlash");
  assert.match(CODE.slice(pickAt, pickAt + 900), /typeof s\.prompt === "function" \? s\.prompt\(\)/,
    "_pickSlash 不认函数形式的 prompt —— 那几条会把一个 function 对象塞进输入框");
  // 取的必须和那排快捷动作是同一个值，否则界面上看不出来、只有模型读到才发现指错了文件。
  const target = CODE.slice(CODE.indexOf("function _slashPromptTarget"), CODE.indexOf("function _updateSlashMenu"));
  assert.match(target, /_realFilePath\(activePath\)/, "取的不是当前打开的文件");
  assert.match(target, /_pathToRel\(/, "没转成相对路径 —— 绝对路径进提示词会带上用户的home目录");
});
