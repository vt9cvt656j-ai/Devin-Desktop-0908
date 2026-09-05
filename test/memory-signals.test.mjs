// 「这句话值不值得长期记」—— 拿真实对话里会出现的句子做真往返。
//
// 旧规则在 1274 条真实消息上送进全局库 0 条。这里的每个正例都是人真会这么说的形状，
// 每个反例都是旧规则或新规则曾经/可能误收的形状；只测判断，不测存储。
import test from "node:test";
import assert from "node:assert/strict";
import { judgeDurableUtterance as judge } from "../src/agent/memory-signals.js";

test("人怎么说偏好，就按那个形状收：回复语言 / 长度 / 语气 → 跨项目", () => {
  // 头两句只有 5 个字：最常见的说法恰恰最短，门槛 6 会把它们全挡掉（新测试第一次跑就撞上了）。
  for (const s of ["回复用中文", "用中文回答", "用中文回答我", "回复别太长，直接说结论", "不用解释那么多，给命令就行", "我习惯用 pnpm，别给我 npm 命令", "以后都用 TypeScript 写"]) {
    const j = judge(s);
    assert.ok(j, `该收却没收：${s}`);
    assert.equal(j.scope, "global", `该是跨项目：${s}`);
  }
});

test("说这个仓库怎么做 → 本项目；带 必须/禁止/一律 的是规矩，其余是偏好", () => {
  const a = judge("这个项目必须用 pnpm 装依赖，别用 npm");
  assert.equal(a?.scope, "project");
  assert.equal(a?.kind, "rule");
  const b = judge("组件统一放在 src/components 目录");
  assert.equal(b?.scope, "project");
  assert.equal(b?.kind, "preference");
});

test("形状闸：问句 / 推迟语 / 一次性任务 / 太短 都不记", () => {
  assert.equal(judge("别的还有什么 bug 呢？"), null, "问句不是偏好");
  assert.equal(judge("这个问题下次再看"), null, "推迟语被当成了「从此每次」");
  assert.equal(judge("帮我修一下登录页，必须今天弄完"), null, "一次性任务被当成了持久规矩");
  assert.equal(judge("好的"), null);
  assert.equal(judge("继续"), null);
});

test("跨项目信号压过任务式开头：「以后」在，就算句子以动词开头也收", () => {
  const j = judge("改文件之前以后都先读一遍再动手");
  assert.ok(j && j.scope === "global");
});

test("变异守卫：把跨项目词表清空，语言/长度类偏好必须掉出去（否则这条判据是摆设）", () => {
  // 不改源码做变异：用一个只含项目信号的句子对照 —— 它必须落在 project 而不是 global。
  const j = judge("这个仓库的接口命名统一用 snake_case");
  assert.equal(j?.scope, "project", "没有任何跨项目词的句子被判成了跨项目");
});
