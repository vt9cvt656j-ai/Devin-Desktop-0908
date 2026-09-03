// 空转断路器的进展度量。两个方向相反的错各守一半：拦不住 / 会误杀。
//
// 这些判据全都是**真往返**（在 Node 里真的调那个函数），不是源码正则——
// 源码断言只用来守「主循环确实在用这个账本」这一件事。

import test from "node:test";
import assert from "node:assert/strict";
import { createProgressLedger } from "../src/agent/idle-progress.js";
import { SRC } from "./helpers/source.mjs";

test("反复重跑一条自称在装依赖的命令，不算进展", () => {
  // 这是断路器**最典型的目标场景**，而它原来在这里恰好失效：
  // run_cmd 的「改了工作区」可以只来自模型自填的 purpose，于是每轮 +1、每轮清零计数。
  const p = createProgressLedger();
  p.noteImplOp({ cmdLike: true, fsDelta: true });      // 先有一次真改动 → 监视器证明自己
  const base = p.total(0);
  for (let i = 0; i < 20; i++) p.noteImplOp({ cmdLike: true, fsDelta: false });
  assert.equal(p.total(0) - base, 0, "自称改了工作区但一个文件没动，照样被算成 20 次进展");
});

test("监视器还没证明过自己时，一律信声明（宁可漏拦，绝不误杀）", () => {
  // 远端模式、监视器没起来、或者根本没拍快照时，_fsDelta 恒为 false。
  // 这时候拿它去否掉声明，会把正在正常干活的 run 掐掉——那比漏拦严重得多。
  const p = createProgressLedger();
  for (let i = 0; i < 5; i++) {
    assert.equal(p.noteImplOp({ cmdLike: true, fsDelta: false }), true, "第 " + i + " 次被误判成没进展");
  }
  assert.equal(p.total(0), 5);
  assert.equal(p.watcherProven(), false);
});

test("监视器一旦报过一次真实变化，就从此有分量", () => {
  const p = createProgressLedger();
  assert.equal(p.watcherProven(), false);
  p.noteImplOp({ cmdLike: true, fsDelta: false });     // 还没证明 → 信声明，计数
  assert.equal(p.total(0), 1);
  p.noteImplOp({ cmdLike: true, fsDelta: true });      // 证明了
  assert.equal(p.total(0), 2);
  assert.equal(p.watcherProven(), true);
  p.noteImplOp({ cmdLike: true, fsDelta: false });     // 从此不再采信空声明
  assert.equal(p.total(0), 2, "监视器已证明可用，仍然采信了空声明");
});

test("写文件、改文件这类工具本身就是执行事实，不需要再核", () => {
  const p = createProgressLedger();
  p.noteImplOp({ cmdLike: true, fsDelta: true });      // 让监视器先证明自己
  const base = p.total(0);
  p.noteImplOp({ cmdLike: false, fsDelta: false });
  p.noteImplOp({ cmdLike: false });
  assert.equal(p.total(0) - base, 2, "write/edit 被 fsDelta 误伤了");
});

test("进展只增不减 —— 验证凭据过期不该被算成「退步」", () => {
  // 主循环每记一次产出，就会**故意**删掉 build/test/run/package 四类验证凭据
  // （凭据随产物过期，这是对的）。原来的判据直接数那个集合的 size，于是
  // 「改代码 → 跑测试 → 改代码」这种最正常的节奏，净变化可能是 -3：
  // 水位线不升，反倒记一次空转。账本这一份只添不删。
  const p = createProgressLedger();
  for (const k of ["build", "test", "run", "package"]) p.noteRuntimeKind(k);
  const afterVerify = p.total(0);
  assert.equal(afterVerify, 4);

  // 模拟主循环那一步：记一次产出，同时把四类凭据作废（对账本没有任何影响）
  p.noteImplOp({ cmdLike: false });
  assert.ok(p.total(0) > afterVerify, "改了一次代码之后，进展度量反而没涨");

  // 再跑一遍测试：类别已经见过 → 不重复计数，但也绝不掉下去
  const before = p.total(0);
  p.noteRuntimeKind("test");
  assert.equal(p.total(0), before, "同一类运行期证据被重复计成了新进展");
});

test("同一类证据重复出现不算新进展（不然一直跑同一条测试就永远拦不住）", () => {
  const p = createProgressLedger();
  for (let i = 0; i < 30; i++) { p.noteRuntimeKind("test"); p.noteExternalKind("http"); }
  assert.equal(p.total(0), 2);
});

test("新证据（读取/搜索）照样算进展", () => {
  const p = createProgressLedger();
  assert.equal(p.total(0), 0);
  assert.equal(p.total(7), 7);
});

test("主循环确实拿这个账本当空转判据，而不是那个会缩水的集合", () => {
  // 这一条是源码断言，守的是「接上了没有」——行为部分上面已经真跑过了。
  assert.match(SRC, /const _progressNow = _progress\.total\(_novelEvidenceCount\);/,
    "空转判据没走进展账本 —— 两个坑（拦不住 / 误杀）会同时回来");
  assert.match(SRC, /_progress\.noteImplOp\(\{[^}]{0,240}fsDelta: it\.rawResult\?\._fsDelta\s*[,}]/,
    "记产出时没有把文件监视器的观测事实带进账本 —— 自称装依赖就能造出进展");
  // 不锁排版（这条自己刚被自己的一次合行打中）：守的是「有没有同时记进另一本」。
  assert.match(SRC, /_runtimeEffects\.add\(kind\);\s*_progress\.noteRuntimeKind\(kind\);/,
    "运行期证据没同时记进只增不减的那一份 —— 验证凭据过期会被当成退步");
  assert.match(SRC, /_externalEffects\.add\(kind\);\s*_progress\.noteExternalKind\(kind\);/,
    "外部证据没记进账本");
});
