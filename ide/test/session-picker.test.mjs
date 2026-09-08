// /sessions 会话列表（2026-09-07 所有者：最新的排上面；每个窗口只看自己这个项目；换文件夹自动更新）。
//
// 排序 / 过滤 / 分组 / 文案是纯函数，直接 import 跑；主循环的三个接线点（updatedAt 的写点、
// 根目录变化的广播、mount 的监听）用源码守。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeRoot, sameProject, sortNewestFirst, scopeEntries, dayBucket, groupByDay, timeLabel, metaText,
} from "../src/ui/session-list.js";
import { CODE, fnSource } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf8");
const PICKER = read("../src/ui/session-picker.jsx");
const MOUNT = read("../src/ui/mount-session-picker.jsx");
const I18N = read("../src/i18n.js");

const NOON = Date.parse("2026-09-07T12:00:00"); // 本地时间，桶按本地日历切
const H = 3_600_000, D = 24 * H;

test("最近活动在前：按 at 倒序，没时间戳的沉底，相同的保持原顺序", () => {
  const rows = [
    { key: "a", at: NOON - 5 * D }, { key: "b", at: 0 }, { key: "c", at: NOON }, { key: "d" }, { key: "e", at: NOON - H },
  ];
  assert.deepEqual(sortNewestFirst(rows).map((r) => r.key), ["c", "e", "a", "b", "d"]);
  assert.deepEqual(sortNewestFirst(null), []);
});

test("只看这个项目：按归一化后的根目录比，尾部斜杠和反斜杠不算差异；没开文件夹就是全部", () => {
  const rows = [
    { key: "1", projectPath: "/Users/m/Desktop/Mrday.one" },
    { key: "2", projectPath: "/Users/m/Desktop/Mrday.one/" },
    { key: "3", projectPath: "C:\\work\\other" },
    { key: "4", projectPath: "" },
  ];
  assert.deepEqual(scopeEntries(rows, "/Users/m/Desktop/Mrday.one/", "project").map((r) => r.key), ["1", "2"]);
  assert.deepEqual(scopeEntries(rows, "C:/work/other", "project").map((r) => r.key), ["3"]);
  assert.equal(scopeEntries(rows, "", "project").length, 4, "没有根目录时无从谈「这个项目」，退成全部");
  assert.equal(scopeEntries(rows, "/Users/m/Desktop/Mrday.one", "all").length, 4);
  assert.equal(normalizeRoot("C:\\a\\b\\"), "C:/a/b");
  assert.equal(sameProject("", ""), false, "两个空不算同一个项目");
});

test("按天分组：今天 / 昨天 / 近 7 天 / 更早，空组不出现，顺序固定", () => {
  assert.equal(dayBucket(NOON - H, NOON), "today");
  assert.equal(dayBucket(NOON - D, NOON), "yesterday");
  assert.equal(dayBucket(NOON - 3 * D, NOON), "week");
  assert.equal(dayBucket(NOON - 7 * D, NOON), "older");
  assert.equal(dayBucket(0, NOON), "older", "没时间戳的归到更早，不能凭空变成今天");
  const sorted = sortNewestFirst([{ key: "old", at: NOON - 30 * D }, { key: "now", at: NOON }, { key: "y", at: NOON - D }]);
  assert.deepEqual(groupByDay(sorted, NOON).map((g) => [g.bucket, g.items.map((i) => i.key)]),
    [["today", ["now"]], ["yesterday", ["y"]], ["older", ["old"]]]);
});

test("行尾的时间：今天只给时刻，昨天带「昨天」，同年 MM/DD，跨年带年份", () => {
  const at = Date.parse("2026-09-07T09:05:00");
  assert.equal(timeLabel(at, NOON), "09:05");
  assert.equal(timeLabel(at - D, NOON, { yesterday: "昨天" }), "昨天 09:05");
  assert.equal(timeLabel(at - 10 * D, NOON), "08/28");
  assert.equal(timeLabel(Date.parse("2025-12-31T09:05:00"), NOON), "2025/12/31");
  assert.equal(timeLabel(0, NOON), "");
});

test("第二行的计数：轮数、文件、纠正；条数只在和轮数不同时出现，零值不印", () => {
  assert.equal(metaText({ totalTurns: 6, recentCount: 6, fileEvidenceCount: 7, correctionCount: 1 }), "6 轮 · 7 文件 · 1 纠正");
  assert.equal(metaText({ totalTurns: 20, recentCount: 8 }), "20 轮 · 8 条");
  assert.equal(metaText({ totalTurns: 0, recentCount: 0 }), "");
  assert.equal(metaText({ totalTurns: 3 }, { turns: "turns" }), "3 turns");
});

test("主循环：每轮开跑碰 updatedAt，新会话带 updatedAt，根目录一变就广播", () => {
  assert.match(fnSource("_setStreaming"), /if \(on\) sess\.updatedAt = Date\.now\(\);/, "开跑时没碰 updatedAt，倒序就没有依据");
  assert.match(fnSource("_createChatSession"), /updatedAt: Date\.now\(\)/, "新会话没有 updatedAt");
  assert.match(fnSource("setActiveWorkspaceRoot"), /new CustomEvent\("mrday:root-changed"/, "换根目录没广播，面板开着时不会更新");
  const picker = fnSource("_openSessionPicker");
  assert.match(picker, /const load = async \(\) =>/, "取数没有改成可重复调用的 load()");
  assert.match(picker, /at: Number\(s\.updatedAt\) \|\| Number\(s\.closedAt\) \|\| Number\(s\.created\) \|\| 0/, "内存里的会话没带时间戳（含两级回退）");
  assert.match(picker, /at: Number\(r\.updatedAt\) \|\| Number\(r\.closedAt\) \|\| Number\(r\.created\) \|\| 0/, "归档行没带时间戳");
  assert.match(picker, /projectPath: s\.project \|\| ""/, "行上没有项目路径，按项目过滤无从做起");
  assert.match(picker, /root: rootPath \|\| ""/, "没把当前根目录交给面板");
  assert.match(picker, /openSessionPickerIsland\(\{\s*load,/, "面板没拿到 load()");
  assert.doesNotMatch(picker, /"#1a73e8"/, "模式点的兜底色又回到 Google 蓝了");
});

test("mount：监听根目录变化并用 load() 重画，关掉时把监听摘掉", () => {
  assert.match(MOUNT, /export const ROOT_CHANGED_EVENT = "mrday:root-changed"/);
  assert.match(MOUNT, /window\.addEventListener\(ROOT_CHANGED_EVENT, onRoot\)/, "没监听根目录变化");
  assert.match(MOUNT, /window\.removeEventListener\(ROOT_CHANGED_EVENT, onRoot\)/, "关掉面板不摘监听，会越积越多");
  assert.match(MOUNT, /host\._cleanup\?\.\(\)/, "close() 没调清理");
  assert.match(MOUNT, /if \(!host\.isConnected\) return;/, "面板已经关了还在重画");
  assert.match(MOUNT, /root=\{data\?\.root \|\| ""\}/, "根目录没传给岛");
});

test("岛：固定只看这个项目（没有切换条）；按天分组；文案全部走 sessions.* 三语", () => {
  assert.match(PICKER, /const effectiveScope = hasRoot \? "project" : "all"/, "只看当前项目要是固定行为；没开文件夹时退成全部");
  // 所有者否掉了「只看 X / 全部项目」切换条（「有这个的话就太丑了」）：不许回来
  assert.ok(!/role="tablist"|setScope|sessions\.scopeAll|sessions\.scopeProject/.test(PICKER), "切换条又回来了");
  // 所有者把「当前 / 可恢复」标签和「N 个可恢复」页脚也否了：一个都不许回来
  assert.ok(!/e\.tag|resumableSuffix|sessions\.current|sessions\.resume/.test(PICKER), "标签或页脚又回来了");
  assert.match(PICKER, /e\.active && "font-medium"/, "当前会话要靠字重能认出来");
  assert.doesNotMatch(PICKER, /e\.active && "bg-/, "当前会话又铺常驻底色了——悬停时两块灰会挨在一起");
  assert.match(PICKER, /scopeEntries\(entries, root, effectiveScope\)/);
  assert.match(PICKER, /sortNewestFirst\(hit\)/, "搜索结果没按最近活动排");
  assert.match(PICKER, /groupByDay\(rows, now\)/, "没按天分组");
  assert.match(PICKER, /\(e\.search \|\| ""\)\.includes\(q\)/, "搜索要覆盖摘要和文件线索那份全文");
  // 文案：每个键三种语言都要有
  const keys = [...new Set([...PICKER.matchAll(/T\("(sessions\.[\w.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 15, `只扫到 ${keys.length} 个文案键，取法多半坏了`);
  for (const key of keys) {
    const hits = (I18N.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length;
    assert.equal(hits, 3, `${key} 只有 ${hits} 种语言`);
  }
  // 用户自己打的话和项目名是内容，不许送去翻译；时间和计数标了 translate="no"
  assert.match(PICKER, /data-i18n-skip>\s*\{e\.name/, "会话标题（用户的原话）没有免翻标记");
  assert.ok((PICKER.match(/translate="no"/g) || []).length >= 2, "数字没标 translate=\"no\"，会被翻成「千」那种东西");
  // 不许再有写死的英文界面文案
  assert.doesNotMatch(PICKER, />\s*(?:Sessions|resumable|No sessions yet|CURRENT|RESUME)\s*</, "又出现写死的英文文案");
});
