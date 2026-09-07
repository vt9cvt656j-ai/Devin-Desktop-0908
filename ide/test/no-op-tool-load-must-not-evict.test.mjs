import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";

// 工具窗口在一次 run 里**只增不减、顺序不变**（2026-09-05 起；Claude Code / Cursor 的工具表整场静态）。
//
// 缓存断点挂在 tools 上、tools 排在请求最前面：踢一个专家、换个次序，四个断点全废，整份
// 54,212 token 的前缀重算。原来的"保留额 8"每装一次新工具就踢两个专家、还把新工具挪到
// 末尾——每一次装载都是一次全量重算。现在只剩数量/字节两道硬顶，撞顶时拒绝新装载，绝不换旧的。
const fit = load("_toolPayloadWindow", { _utf8ByteLength: (s) => Buffer.byteLength(String(s), "utf8") });
const sch = (n) => ({ type: "function", function: { name: n, description: "d", parameters: { type: "object", properties: {} } } });
const CORE = new Set(["read_file", "search_tools", "web_search", "web_fetch"]);
const window14 = [...CORE].map(sch).concat([...Array(10)].map((_, i) => sch("spec" + i)));
const names = (r) => r.tools.map((t) => t.function.name);

test("装载是 no-op 时，一个工具都不许踢——tools 要逐字节不变", () => {
  const before = names(fit(window14, [], CORE, 256, 512 * 1024));
  const r = fit(window14, [sch("web_search"), sch("web_fetch")], CORE, 256, 512 * 1024);
  assert.deepEqual(r.evicted, [], "请求的名字全都已在窗口里，却还是踢了人");
  assert.deepEqual(names(r), before, "tools 数组变了——缓存断点挂在它上面，整份前缀作废");
});

test("请求一个已装载的非核心工具：原位保留，不挪到末尾", () => {
  const before = names(fit(window14, [], CORE, 256, 512 * 1024));
  const r = fit(window14, [sch("spec3")], CORE, 256, 512 * 1024);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(names(r), before, "已装载的工具被重新排到了末尾——顺序一变前缀就废");
  assert.deepEqual(r.admitted, ["spec3"]);
});

test("真·新工具追加在末尾，谁都不踢、谁都不动", () => {
  const before = names(fit(window14, [], CORE, 256, 512 * 1024));
  const r = fit(window14, [sch("brand_new_tool")], CORE, 256, 512 * 1024);
  assert.deepEqual(r.evicted, [], "装一个新工具不该踢掉任何已装载的");
  assert.deepEqual(names(r), [...before, "brand_new_tool"], "新工具必须追加在末尾，前面的原样不动");
});

test("混合请求（一个已有 + 一个新的）：已有的原位，新的追加", () => {
  const before = names(fit(window14, [], CORE, 256, 512 * 1024));
  const r = fit(window14, [sch("web_search"), sch("another_new")], CORE, 256, 512 * 1024);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(names(r), [...before, "another_new"]);
});

test("完全不传 requested 时保持原样", () => {
  const r = fit(window14, [], CORE, 256, 512 * 1024);
  assert.deepEqual(r.evicted, []);
  assert.equal(r.tools.length, 14);
});

test("撞到数量上限时拒绝新装载，而不是换掉旧的", () => {
  const r = fit(window14, [sch("one_more")], CORE, 14, 512 * 1024);
  assert.deepEqual(r.rejected, ["one_more"], "撞顶要报在 rejected 里");
  assert.deepEqual(r.evicted, [], "撞顶也不许踢旧的");
  assert.equal(r.tools.length, 14);
});

test("保留额那套机制已经不在源码里", () => {
  assert.doesNotMatch(CODE, /maxRetainedSpecialists|retainLimit/, "「保留额」回来了——每装一次新工具就会踢人、重排、前缀作废");
});
