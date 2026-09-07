// 命令面板的匹配与排序。这几个是纯函数，所以这里一律真跑真比对，不做源码文本断言。
//
// 上一版的匹配是 `("分类 标题 id").indexOf(查询)` —— 打字必须**连着**才有结果：
// 想找「视图: 打开终端」，打 "打开终端" 能中，打 "视终" 一条都不出。下面第一条守的就是这个。

import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, isWordStart, matchCommand } from "../src/ext/palette.js";

/** positions 必须真的指向命中的那几个字符——只看 score 的话，下标算错了也发现不了。 */
function charsAt(text, positions) {
  return positions.map((i) => text[i]).join("");
}

test("模糊匹配：字符不连着也能命中，且下标真指向命中的字符", () => {
  const m = fuzzyMatch("Toggle Terminal", "tgltm");
  assert.ok(m, "不连着就匹配不到——这正是上一版 indexOf 的毛病");
  assert.equal(charsAt("Toggle Terminal", m.positions).toLowerCase(), "tgltm");
  for (let i = 1; i < m.positions.length; i++) {
    assert.ok(m.positions[i] > m.positions[i - 1], "下标必须严格递增，否则是同一个字符被重复计入");
  }
});

test("模糊匹配：不是子序列就返回 null", () => {
  assert.equal(fuzzyMatch("Toggle Terminal", "zzz"), null);
  assert.equal(fuzzyMatch("Toggle Terminal", "lagoT"), null, "顺序反了不算子序列");
});

test("模糊匹配：优先命中词首", () => {
  const m = fuzzyMatch("Open Folder", "of");
  assert.deepEqual(m.positions, [0, 5], "f 应该落在 Folder 的词首，而不是随便一个 f");
});

test("模糊匹配：连续命中比分散命中分高", () => {
  const near = fuzzyMatch("terminal", "te").score;
  const far = fuzzyMatch("terminal", "tl").score;
  assert.ok(near > far, `连续(${near}) 应该高于分散(${far})`);
});

test("词首判据认中英交界，否则中文标题只有第一个字算词首", () => {
  const s = "新建窗口 New Window";
  assert.ok(isWordStart(s, 0));
  assert.ok(isWordStart(s, s.indexOf("New")), "空格后是词首");
  assert.ok(isWordStart(s, s.indexOf("Window")), "空格后是词首");
  assert.ok(!isWordStart("窗口", 1), "汉字连着写，中间不该算词首");
  assert.ok(isWordStart("AI助手", 2), "英文转汉字算词首");
});

test("空查询：不筛不排，分数为 0 且没有高亮", () => {
  const m = fuzzyMatch("任意标题", "");
  assert.deepEqual(m, { score: 0, positions: [] });
  assert.deepEqual(matchCommand({ id: "x", title: "任意标题", category: "工具" }, ""),
    { score: 0, title: [], cat: [] });
});

test("命令匹配：分类在前和标题在前两种打法都认，高亮各归各段", () => {
  const cmd = { id: "git.stash", title: "Stash", category: "Git" };

  const byCat = matchCommand(cmd, "git stash");
  assert.ok(byCat, "「分类 标题」这种照屏幕念的打法必须能中");
  assert.equal(charsAt("Git", byCat.cat).toLowerCase(), "git");
  assert.equal(charsAt("Stash", byCat.title).toLowerCase(), "stash");

  const byTitle = matchCommand(cmd, "stash");
  assert.ok(byTitle);
  assert.equal(charsAt("Stash", byTitle.title).toLowerCase(), "stash");
  assert.deepEqual(byTitle.cat, [], "只打标题时不该在分类上乱标高亮");
});

test("命令匹配：命中标题排在只命中 id 之前", () => {
  const q = "settings";
  const onTitle = matchCommand({ id: "a.b", title: "Settings", category: "Preferences" }, q);
  const onId = matchCommand({ id: "pref.settings", title: "偏好", category: "工具" }, q);
  assert.ok(onTitle && onId, "两条都该能搜到");
  assert.ok(onTitle.score > onId.score,
    `标题命中(${onTitle.score}) 必须排在只有 id 命中(${onId.score}) 前面，否则搜出来的第一条是个看不出为什么中的命令`);
});

test("排序：打 term 时「打开终端」类的命令排在前面", () => {
  const cmds = [
    { id: "view.terminal", title: "打开终端 Toggle Terminal", category: "视图" },
    { id: "terminal.new", title: "新建终端", category: "终端" },
    { id: "git.stash", title: "Stash", category: "Git" },
    { id: "view.zenMode", title: "Toggle Zen Mode", category: "视图" },
  ];
  const ranked = cmds
    .map((c) => ({ c, m: matchCommand(c, "term") }))
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.c.id);
  assert.ok(ranked.length >= 1, "一条都没匹配到");
  assert.equal(ranked[0], "view.terminal", `排出来是 ${JSON.stringify(ranked)}`);
  assert.ok(!ranked.includes("git.stash"), "Stash 里没有 term 这个子序列，不该出现");
});
