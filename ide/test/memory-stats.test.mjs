import test from "node:test";
import assert from "node:assert/strict";
import { configureMemoryStats, memStat, memStats, MEMORY_STATS_KEY } from "../src/agent/memory-stats.js";

function fakeStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; }

test("累加落盘、读回；换存储即重置；坏存储不抛", () => {
  const st = fakeStorage();
  configureMemoryStats({ storage: st });
  memStat("reflect.opened"); memStat("reflect.opened"); memStat("reflect.accepted", 3);
  assert.deepEqual(memStats(), { "reflect.opened": 2, "reflect.accepted": 3 });
  assert.ok(st._m.get(MEMORY_STATS_KEY).includes("reflect.opened"), "没落盘");
  // 换一个新实例读同一份存储：数得回来
  configureMemoryStats({ storage: st });
  assert.equal(memStats()["reflect.accepted"], 3);
  configureMemoryStats({ storage: fakeStorage() });
  assert.deepEqual(memStats(), {}, "换一份空存储就该是空的");
  // 存储抛异常也不许把调用方打断
  configureMemoryStats({ storage: { getItem: () => { throw new Error("boom"); }, setItem: () => { throw new Error("boom"); } } });
  assert.doesNotThrow(() => memStat("x"));
});
