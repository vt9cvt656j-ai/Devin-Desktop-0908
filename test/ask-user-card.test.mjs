// ask_user 那张卡片：样式照 Claude Code、**没有倒计时**、多选是真的多选，
// 而且单选/多选什么时候触发写在判据里、不靠调用方各自记。
//
// 用户实拍那张卡片下面写着「109s 后自动继续」——它在催用户，而它催的那件事
// （超时替他决定）恰恰是这张卡片存在的理由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeAskOptions, askMode, askAnswerText, askAnswerLabel, ASK_MAX_OPTIONS } from "../src/agent/ask-user.js";
import { blockFrom, CODE } from "./helpers/source.mjs";

const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const CATALOG = readFileSync(new URL("../src/agent/tool-catalog.js", import.meta.url), "utf8");
const GATEWAY = readFileSync(new URL("../../server/prompts/tools.json", import.meta.url), "utf8");
const CARD = blockFrom('} else if (call.type === "askuser") {');

test("选项两种写法都收：纯字符串，和带说明的对象", () => {
  assert.deepEqual(normalizeAskOptions(["批量测试", { label: "加代理池", description: "让上游走 socks5 轮换" }]),
    [{ label: "批量测试" }, { label: "加代理池", description: "让上游走 socks5 轮换" }]);
  // 空标签要丢掉——画出来是一个点不动的空按钮。
  assert.deepEqual(normalizeAskOptions(["", null, { label: "  " }, "ok"]), [{ label: "ok" }]);
  assert.equal(normalizeAskOptions(Array.from({ length: 20 }, (_, i) => "o" + i)).length, ASK_MAX_OPTIONS);
  assert.deepEqual(normalizeAskOptions(null), []);
});

test("单选 / 多选 / 只给输入框：判据写在一处", () => {
  assert.equal(askMode({ options: [1, 2, 3], multiSelect: true }), "multi");
  assert.equal(askMode({ options: [1, 2, 3] }), "single", "没声明就该是单选");
  assert.equal(askMode({ options: [1, 2], multiSelect: false }), "single");
  // 一个选项的「选择」不是选择。
  assert.equal(askMode({ options: [1], multiSelect: true }), "text", "只有一项还画成多选");
  assert.equal(askMode({ options: [] }), "text");
  assert.equal(askMode(), "text");
});

test("默认必须是单选——两个方向的代价不对称", () => {
  // 把互斥问题画成多选，用户能同时勾上「原地迁移」和「推倒重建」，模型收到一个
  // 无法同时满足的答案；反过来他至少还能用输入框补一句。所以多选必须模型显式要。
  for (const v of [undefined, null, 0, "", false]) {
    assert.equal(askMode({ options: [1, 2], multiSelect: v }), "single", `multiSelect=${JSON.stringify(v)} 被当成了多选`);
  }
});

test("交回给模型的那句话要说清是哪一种选择", () => {
  assert.match(askAnswerText("single", { label: "甲" }), /用户选择了：「甲」/);
  const multi = askAnswerText("multi", { labels: ["甲", "乙"] });
  assert.match(multi, /「甲」「乙」/);
  assert.match(multi, /每一项都要做/, "多选没说清是「都要」——模型会只挑第一项做");
  assert.match(multi, /不要只挑其中一项/);
  assert.match(askAnswerText("custom", { text: "自己写的" }), /用户输入了具体需求：自己写的/);
  assert.match(askAnswerText("auto", {}), /自行判断/);
  assert.match(askAnswerText("cancel"), /^\[已取消\]/, "取消那句要带标记，否则模型会把它当成真答案");
  assert.equal(askAnswerLabel("multi", { labels: ["甲", "乙"] }), "你选了：甲、乙");
});

test("卡片上没有倒计时，一个字都不许剩", () => {
  assert.doesNotMatch(CARD, /setInterval/, "倒计时又回来了——它在催用户替自己做决定");
  assert.doesNotMatch(CARD, /_auTimer|_auCountdown|_auTimeout|后自动继续/, "倒计时的残留");
  assert.doesNotMatch(CODE, /au-timer/, "倒计时的类名还留着");
  assert.doesNotMatch(CSS, /\.au-timer/, "倒计时的样式还留着");
  // 不再有「超时替他决定」这条路：等不到答案就一直等，直到用户回答或任务被停掉。
  assert.match(CARD, /_registerRunInteraction\(run, \(\) => finish\("cancel"\)\)/,
    "停止任务时不再收掉这张卡——那会让整轮永远挂着");
});

test("多选要在问题旁写一句「可多选」——不然它和单选长得一模一样", () => {
  // 原卡没有「单选/多选」那种说明胶囊，所以只在多选时挂一句轻提示，跟在问题后面。
  assert.match(CARD, /_auMulti \? `<span class="au-multi-hint">可多选<\/span>` : ""/,
    "多选没有任何提示——用户会当成单选，点一项就走");
  assert.doesNotMatch(CARD, /class="au-kind"/, "又加回了原卡没有的说明胶囊");
});

test("照原卡的构成：浅灰块、无边框、无圆点方框、序号在右", () => {
  // 前两版错在同一个地方——加了原卡**根本没有**的东西。这条守的就是"别再加回来"。
  assert.doesNotMatch(CSS, /\.au-mark\b/, "又加回了原卡没有的单选圆点 / 复选方框");
  assert.doesNotMatch(CSS, /\.au-badge\b/, "又加回了蓝色号码块");
  assert.doesNotMatch(CSS, /\.au-opt \+ \.au-opt \{ border-top/, "又把选项串成带分隔线的列表了");
  assert.doesNotMatch(CARD, /class="au-mark"/, "标记元素还在渲染");
  // 行是浅灰填充 + 圆角，没有边框。
  assert.match(CSS, /\.au-opt \{[\s\S]{0,400}border: 0; border-radius: 8px;/, "选项行不再是无边框的圆角块");
  assert.match(CSS, /\.au-opts \{ display: flex; flex-direction: column; gap: 4px; \}/, "选项之间的 4px 间距没了");
  // 序号在右边一个描边小方块里。
  assert.match(CSS, /\.au-key \{[\s\S]{0,300}border: 1px solid/, "序号不再是描边小方块");
  // 选中态：这是全卡唯一用到主色的地方。
  assert.match(CSS, /\.au-opt--checked[^{]*\{[\s\S]{0,220}inset 0 0 0 1\.5px var\(--accent\)/, "选中态没有主色内描边");
  assert.match(CSS, /\.au-opt__desc \{[^}]*color: var\(--text-dim\)/, "选项的说明行样式没了");
});

test("明暗两套走仓库自己的成对变量，不在这一块里现调颜色", () => {
  // 上一版用 color-mix 现调，还得配 @supports 兜底——那是在重造一份仓库已经有的东西：
  // --hover / --active / --sel / --text / --panel-solid / --line-strong 在 :root 和
  // :root[data-theme="dark"] 里本来就一一对应，用它们，明暗自动成立。
  const blk = CSS.slice(CSS.indexOf("/* ── ask_user card ── */"), CSS.indexOf(".au-done {"));
  assert.doesNotMatch(blk, /color-mix\(/, "又在这一块里现调颜色了——那样还得自己配兜底，而且明暗两套要各写一遍");
  assert.doesNotMatch(blk, /rgba\(\s*(128|255|0)\s*,/, "写死了 rgba——深色和浅色不可能同时对");
  assert.match(blk, /\.au-opt \{[\s\S]{0,300}background: var\(--hover\)/, "选项底色不再走主题变量");
  assert.match(blk, /\.au-opt:hover \{ background: var\(--active\); \}/, "悬停底色不再走主题变量");
  assert.match(blk, /\.au-submit \{[\s\S]{0,220}background: var\(--text\); color: var\(--panel-solid\)/,
    "提交按钮没有用会随主题翻转的那一对——深色下会变成白底白字或黑底黑字");
  // 两份调色板里这几个必须都在，缺一个那条声明整条作废且不报错。
  // 首个 :root[data-theme="dark"] 出现在**注释里**（第 73 行那段说明），不是调色板本身。
  // 按「后面紧跟 {」找真正那条规则，再取它的花括号范围。
  const darkAt = CSS.search(/:root\[data-theme="dark"\]\s*\{/);
  assert.ok(darkAt > 0, "找不到深色调色板");
  const dark = CSS.slice(darkAt, CSS.indexOf("\n}", darkAt));
  for (const v of ["--hover", "--active", "--sel", "--text", "--panel-solid", "--line-strong"]) {
    assert.match(dark, new RegExp(v.replace(/-/g, "\\-") + ":"), `深色调色板里没有 ${v}`);
  }
});

test("跳过 / 提交两个按钮在底部水平居中", () => {
  const blk = CSS.slice(CSS.indexOf("/* ── ask_user card ── */"), CSS.indexOf(".au-done {"));
  assert.match(blk, /\.au-foot \{[^}]*justify-content: center;/, "按钮又贴回右下角了");
  // 未拿到答案时提交退成描边灰，不是实心灰——深色下实心灰会比卡片本身还亮。
  assert.match(blk, /\.au-submit:disabled \{[\s\S]{0,160}background: transparent;/, "禁用态是实心的，深色下会发亮");
});

test("「其他」是列表里的最后一块，里面套一个整宽输入框", () => {
  assert.match(CARD, /class="au-opt au-opt--other"/, "「其他」不在列表里了");
  assert.match(CARD, /\$\{btns\}\$\{otherRow\}/, "「其他」没有接在选项后面");
  assert.match(CARD, /class="au-opt__head"[\s\S]{0,160}class="au-custom _auCustom"/,
    "「其他」里不再是「一行标题 + 下面一个输入框」的构成");
  assert.match(CSS, /\.au-opt--other \{ flex-direction: column;/, "「其他」那块没有竖排");
});

test("点一下是选中，按提交才交——单选多选同一套，和原卡一致", () => {
  assert.match(CARD, /vp\.querySelectorAll\("\._auOpt"\)\.forEach\(\(b\) => b\.addEventListener\("click", \(\) => _auPick\(/,
    "点选项不再是「选中」");
  assert.doesNotMatch(CARD, /addEventListener\("click", \(\) => \{ const i = \+b\.dataset\.i; finish\("single"/,
    "点一下就直接提交了——原卡是选完再按提交");
  // 提交按钮的可用性只有一个判据：有没有拿到答案（勾了选项，或者「其他」里写了字）。
  assert.match(CARD, /_auSubmitEl\.disabled = _auSelected\.size === 0 && !\(_auCustomEl && _auCustomEl\.value\.trim\(\)\)/,
    "提交按钮的可用判据不对——没答案也能点，或者写了字却点不动");
  // 单选要真的只留一个。
  assert.match(CARD, /else \{ const had = _auSelected\.has\(i\); _auSelected\.clear\(\); if \(!had\) _auSelected\.add\(i\); \}/,
    "单选没有互斥——点第二项会变成两项都选中");
  assert.match(CSS, /\.au-submit:disabled/, "提交按钮没有禁用态");
});

test("单选/多选的判据也要写给模型看——两份目录都要有", () => {
  // 目录有两份：客户端这份，和网关那份（运行时以网关为准）。只改一边等于一半用户看不到。
  for (const [name, src] of [["tool-catalog.js", CATALOG], ["server/prompts/tools.json", GATEWAY]]) {
    assert.match(src, /MUTUALLY EXCLUSIVE/, `${name} 里没写清什么时候用单选`);
    assert.match(src, /can hold AT THE SAME TIME/, `${name} 里没写清什么时候用多选`);
    assert.match(src, /when unsure leave it off/, `${name} 没说清拿不准时该怎么选`);
    assert.match(src, /Single vs multi/, `${name} 的工具描述正文里没有这条`);
  }
});


// 工具卡那条主规则的正文。两个锚点都要从 --atc-mono 那一行**往后**找：文件里另有一条
// 更早的 `.agent-tool-step { overflow: hidden; }` 和一条更早的 `.agent-tool-row {`，
// 按选择器直接找会切到它们，测出来的是别的规则（固定窗口切源码这个坑本仓栽过好几次）。
const cardBlock = () => {
  const i = CSS.indexOf("  --atc-mono: var(--mono);");
  return CSS.slice(i, CSS.indexOf(".agent-tool-row {", i));
};

// ── 工具卡：一列扁平的行，不是一摞浮起的卡片 ──────────────────────────────
//
// 用户实拍一轮跑十来个工具，说「展示的内容很杂乱……做的和 windsurf、cursor 那种大气
// 高端点」。原因有三，都在样式里：每张卡带分层阴影 + 悬停上浮 + 滑入动画；图标按类型
// 分了 43 种粉彩底；成功状态也做成填色药丸。三样叠起来，一屏就是一堆各自发光的彩色板。
test("工具卡不再浮起来：没有阴影、不上浮、不滑入", () => {
  // 锚点用 --atc-mono 那一行：文件里另有一条更早的 `.agent-tool-step { overflow: hidden; }`，
  // 按选择器找会切到它，测出来的是别的规则（这个仓库固定窗口切源码栽过好几次）。
  const card = cardBlock();
  assert.doesNotMatch(card, /box-shadow/, "阴影又回来了——十个工具就是十块浮板");
  assert.doesNotMatch(card, /animation:/, "滑入动画又回来了");
  assert.doesNotMatch(card, /transform: translateY/, "悬停上浮又回来了");
  // 间距压到个位数，连着几个工具读起来才是一份清单。
  assert.match(card, /margin: 3px 0;/, "卡间距又被撑开了");
});

test("配色从主题变量推导，不再手工同步两份调色板", () => {
  const card = cardBlock();
  for (const [name, token] of [["--atc-bg", "--panel-solid"], ["--atc-border", "--line"],
                               ["--atc-text", "--text"], ["--atc-dim", "--text-dim"], ["--atc-accent", "--accent"]]) {
    assert.match(card, new RegExp(`${name}: var\\(${token}\\)`), `${name} 没有从 ${token} 推导`);
  }
  // 深色那份手工同步的覆盖删掉了：留着会把亮色下刚统一好的灰阶按住。
  assert.doesNotMatch(CSS, /\[data-theme="dark"\] \.agent-tool-step,\s*\n\.dark \.agent-tool-step \{[^}]*--atc-bg/,
    "深色那份 --atc-* 覆盖又回来了——两份手工同步的调色板必然漂移");
});

test("状态只在需要回头看时才上色：成功走灰，失败才红", () => {
  assert.match(CSS, /\.atc-result--ok \{ color: var\(--atc-dim\); background: transparent; \}/,
    "成功又变回绿色药丸了——一屏十个绿药丸，成功被喊得比失败还响");
  assert.match(CSS, /\.atc-result--err \{ color: var\(--atc-danger\); background: transparent; \}/,
    "失败要么没上色、要么又加回了填色底");
  // 药丸本身也不要：padding/圆角都归零，剩下的是一行字。
  const base = CSS.slice(CSS.indexOf("\n.atc-result {"), CSS.indexOf(".atc-result svg"));
  assert.match(base, /padding: 0; border-radius: 0; background: transparent;/, "状态又变回填色药丸");
});
