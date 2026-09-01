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

test("抬头要写明这是单选还是多选", () => {
  // 用户实测：多选卡片长得和单选一模一样，于是点了第一项就走，多选的语义完全没被读出来。
  assert.match(CARD, /多选 · 可以勾多项，选好后提交/);
  assert.match(CARD, /单选 · 点一项即可/);
  assert.match(CARD, /危险操作 · 需要输入确认文本/);
  // 算出来还不够，得**画出来**：只断言那几句文案存在，把渲染那一行删掉照样绿。
  assert.match(CARD, /class="au-kind">\$\{_escHtml\(kindHint\)\}/,
    "抬头那一行没有真的渲染 kindHint——文案算了却没画出来");
});

test("多选的选中态在样式上要一眼看得出来", () => {
  // 选项列表是一整块（行间只有发丝线），所以选中态靠**底色 + 标记上色**，不是给单行加边框。
  assert.match(CSS, /\.au-opt--checked \{ background: var\(--sel\); \}/, "勾选的行没有底色");
  assert.match(CSS, /\.au-opt--checked \.au-mark \{[^}]*background: var\(--accent\)/, "标记选中了却不上色");
  assert.match(CSS, /\.au-opt\[role="checkbox"\]\.au-opt--checked \.au-mark::after \{[^}]*scale\(1\)/, "多选方框里没有勾");
  assert.match(CSS, /\.au-opt__desc \{[^}]*color: var\(--text-dim\)/, "选项的说明行样式没了");
  assert.match(CSS, /\.au-submit:disabled/, "提交按钮没有禁用态——一项没勾也能点");
  // Claude Code 那张卡的关键长相：选项是**一整块列表**，不是各自带边框、互相隔开的胶囊。
  assert.match(CSS, /\.au-opts \{[^}]*border: 1px solid var\(--line\)[^}]*overflow: hidden/, "选项列表不再是一整块");
  assert.match(CSS, /\.au-opt \+ \.au-opt \{ border-top: 1px solid var\(--line\); \}/, "行与行之间的发丝线没了");
  assert.doesNotMatch(CSS, /\.au-badge/, "蓝色号码块又回来了——序号该退到右边当键盘提示");
});

test("「其他」是选项列表里的一行，不在底下另起一块", () => {
  // 自己写和选一项是同一层的选择。摆成两块，用户会以为得先选一项、再顺便写点什么。
  assert.match(CARD, /class="au-opt au-opt--other"/, "「其他」不在列表里了");
  assert.match(CARD, /\$\{btns\}\$\{otherRow\}/, "「其他」没有接在选项后面");
});

test("提交所选要显示已选了几项，且一项没勾时点不动", () => {
  assert.match(CARD, /sub\.disabled = _auSelected\.size === 0;/, "一项没勾也能提交");
  assert.match(CARD, /提交所选（\$\{_auSelected\.size\}）/, "按钮上没显示已选几项");
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
