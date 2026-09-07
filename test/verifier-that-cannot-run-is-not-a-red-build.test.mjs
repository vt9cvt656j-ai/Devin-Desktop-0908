import test from "node:test";
import assert from "node:assert/strict";
import { freshBuildFailure } from "../src/agent/verification-evidence.js";

const rec = (o) => ({ verifierRecognized: true, implementationVersion: 1, timedOut: false, cwd: "/w", command: "npm test", ...o });
const red = (r) => !!freshBuildFailure({ _executionEvidence: [r] }, 1);

test("字段名读对：证据记录里只有 stdout/stderr，没有 output/tail", () => {
  // 这条判据原来读的是 `e.output || e.tail` —— 而 _executionEvidenceFromTool 产出的字段
  // 只有 stdout/stderr，**这两个名字一个都不存在**。于是整条文本腿恒等于空串、恒不匹配，
  // 只剩退出码 127/126 那一半在工作。走退出码 1 的那一批"验证器自己没起来"全部漏网。
  assert.equal(red(rec({ exitCode: 1, stderr: "pytest: command not found" })), false,
    "验证器没装却被判成红构建——会逼一个做完的任务再返修两轮");
  assert.equal(red(rec({ exitCode: 1, stdout: "sh: 1: vitest: not found" })), false, "stdout 那一路也要认");
  // 反向：这两个不存在的字段就算真被塞进来也不该顶替 stdout/stderr 的位置
  assert.equal(red(rec({ exitCode: 1, output: "pytest: command not found", stderr: "AssertionError: 1 != 2" })), true,
    "读了不存在的字段、反而忽略了真实的 stderr");
});

test("运行器说「我没有这个脚本」是执行事实，不是代码的证词", () => {
  assert.equal(red(rec({ exitCode: 1, stderr: 'npm ERR! Missing script: "test"' })), false);
  assert.equal(red(rec({ exitCode: 1, stderr: "error: no such task: coverage" })), false);
  assert.equal(red(rec({ exitCode: 1, stderr: "Unknown command: bench" })), false);
});

test("真的红还是要判红——这条修复不许顺手把红灯一起关掉", () => {
  assert.equal(red(rec({ exitCode: 1, stderr: "AssertionError: expected 1 to equal 2" })), true);
  assert.equal(red(rec({ exitCode: 2, stdout: "error[E0308]: mismatched types" })), true);
  assert.equal(red(rec({ exitCode: 1, stderr: "2 failed, 18 passed" })), true);
});

test("被测代码自己打印 not found，不算「验证器没起来」", () => {
  // 判据必须锚在行首的运行器口吻上。正文里出现 not found 完全可能是被测代码打印的——
  // 拿它当"验证器没起来"，等于给失败的测试开一条免检通道。
  assert.equal(red(rec({ exitCode: 1, stdout: "FAIL user.test.js\n  expected 404 not found" })), true);
  assert.equal(red(rec({ exitCode: 1, stdout: "3 tests failed: resource not found in cache" })), true);
});

test("退出码那一半照旧", () => {
  assert.equal(red(rec({ exitCode: 127, stderr: "vhs: not found" })), false);
  assert.equal(red(rec({ exitCode: 126, stderr: "permission denied" })), false);
  assert.equal(red(rec({ exitCode: 0, stderr: "" })), false, "绿的当然不是红构建");
});
