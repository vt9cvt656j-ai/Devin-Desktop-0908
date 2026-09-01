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

test("半透明色一律走变量，且先有 rgba 兜底——老引擎认不出 color-mix 会让整条声明作废", () => {
  // 作废的后果不是"退回默认色"，是那一格干脆**没有底色**：整块浅灰行变白底，卡片散架。
  const blk = CSS.slice(CSS.indexOf("/* ── ask_user card ── */"), CSS.indexOf(".au-done {"));
  // @supports 那一行自己也含 color-mix（它就是探测句），不算声明。
  const decls = blk.split("\n").filter((l) => /color-mix\(/.test(l) && !/^@supports/.test(l.trim()));
  assert.ok(decls.length >= 4, "找不到 color-mix 声明，这条判据会变成恒真");
  const supportsAt = blk.indexOf("@supports (background: color-mix(");
  assert.ok(supportsAt > 0, "没有 @supports 兜底块");
  // 判据是「落在 @supports 的花括号**里面**」，不是「排在它后面」——整段卡片样式都排在
  // 它后面，只比位置的话，把 color-mix 写回任何一条普通规则都验不出来。
  let depth = 0, supportsEnd = -1;
  for (let k = blk.indexOf("{", supportsAt); k < blk.length; k++) {
    if (blk[k] === "{") depth++;
    else if (blk[k] === "}" && --depth === 0) { supportsEnd = k; break; }
  }
  assert.ok(supportsEnd > supportsAt, "@supports 块没有闭合");
  for (const d of decls) {
    const at = blk.indexOf(d);
    assert.ok(at > supportsAt && at < supportsEnd,
      `这条 color-mix 在 @supports 之外，老引擎会让它整条作废：${d.trim()}`);
  }
  // 兜底那一份必须真的定义了同名变量，否则 @supports 之外什么都没有。
  for (const v of ["--au-row", "--au-row-hi", "--au-line", "--au-mute", "--au-pick"]) {
    assert.match(blk.slice(0, supportsAt), new RegExp(`${v}:\\s*(rgba|var\\(--sel)`), `${v} 没有 rgba 兜底`);
  }
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
