import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";

const reg = new Map([...Array(24)].map((_, i) => [`t${i}`, { function: { name: `t${i}` } }]));
const names = [...Array(24)].map((_, i) => `t${i}`);
const withMastery = (p) => load("_criticRequestedToolSchemas", { growth: { getAvgMasteryStrict: () => p } });

test("调用方明确传的工具上限说了算，熟练度不许覆盖它", () => {
  // 原来是无条件赋值，两个方向同时错：
  //  · 弱模型那条传 8（53386 那段注释花力气把这道窗口挪到那一行才生效），老用户身上被抬成 15
  //    —— 等于修回到修之前，弱模型又拿回一堆稀释注意力的 schema；
  //  · 编排器那条传 Math.max(10, 候选数)（难任务常有 20+），被悄悄压到 15，
  //    模型亲选的工具从尾部被静默丢掉。
  const f = withMastery(0.9);          // 最高档，覆盖力最强
  assert.equal(f(names, reg, 8).length, 8, "弱模型的 8 工具窗口被熟练度抬宽了");
  assert.equal(f(names, reg, 4).length, 4, "方向纠偏那条传 4，被抬宽了");
  assert.equal(f(names, reg, 20).length, 20, "编排器亲选 20 个，被静默压到 15");
  assert.equal(f(names, reg, 16).length, 16);
});

test("没传上限时才按熟练度放宽，而且拿不到就保守", () => {
  assert.equal(withMastery(0.9)(names, reg).length, 15);
  assert.equal(withMastery(0.5)(names, reg).length, 12);
  // getAvgMasteryStrict 读失败回 null —— 非严格版会回 0.5，而 0.5 恰好越过 0.45 那道阈值，
  // 变成"失败反而给更多工具"。这里必须退回默认 8。
  assert.equal(withMastery(0.2)(names, reg).length, 8, "低熟练度也拿到了放宽后的窗口");
  assert.equal(withMastery(0.45)(names, reg).length, 8, "阈值是**大于** 0.45，等于不算");
  assert.equal(withMastery(0.46)(names, reg).length, 12);
  assert.equal(withMastery(0.7)(names, reg).length, 12, "上档阈值也是**大于** 0.7，等于不算");
  assert.equal(withMastery(0.71)(names, reg).length, 15);
  assert.equal(withMastery(null)(names, reg).length, 8, "拿不到熟练度时没有保守退回");
  assert.equal(withMastery(NaN)(names, reg).length, 8);
});

test("`Number(null)` 是 0 不是 NaN —— 没传不能被判成传了 0", () => {
  // 这是我修这条时自己踩的：光用 Number.isFinite(Number(maxTools)) 判"传没传"，
  // 没传时 Number(null)===0 → 上限 0 → 一个工具都发不出去，整轮模型手上空空。
  assert.ok(withMastery(null)(names, reg).length > 0, "没传上限时一个工具都没发出去");
  assert.match(CODE, /const _explicit = maxTools != null && Number\.isFinite\(Number\(maxTools\)\)/);
});

test("显式 0 仍然是 0（那是调用方真的要求不发工具）", () => {
  assert.equal(withMastery(0.9)(names, reg, 0).length, 0);
});
