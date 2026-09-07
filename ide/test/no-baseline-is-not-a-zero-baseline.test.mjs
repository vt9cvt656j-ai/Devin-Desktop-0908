import test from "node:test";
import assert from "node:assert/strict";
import { CODE } from "./helpers/source.mjs";
import { isNewMarker } from "../src/agent/diagnostic-baseline.js";

const counts = new Map([["src/a.ts|TS2304|Cannot find name 'x'", 3]]);

test("没采过基线的文件，存量错误不算本轮新增", () => {
  // 用户实拍：「lsp 172 个报错…那些报错属于正常的没影响」，而收尾门照着这 172 条要求继续修。
  // 来路：`|| 0` 把「采过、当时是 0 次」和「根本没采过」压成了同一个值。
  const baselined = new Set(["src/a.ts"]);
  assert.equal(isNewMarker({ baselineCounts: counts, baselined, fileKey: "src/b.ts",
    identity: "src/b.ts|TS1005|;expected", occurrence: 1 }), false,
    "b.ts 没采过基线，它的存量错误被算成了本轮新增");
  // 采过基线、当时是 0 次 —— 现在冒出来就是真新增，这一半不能被顺手关掉。
  assert.equal(isNewMarker({ baselineCounts: counts, baselined, fileKey: "src/a.ts",
    identity: "src/a.ts|TS9999|new problem", occurrence: 1 }), true);
});

test("采过基线的逐条抵扣照旧：超过基线次数的才算新增", () => {
  const baselined = new Set(["src/a.ts"]);
  const at = (n) => isNewMarker({ baselineCounts: counts, baselined, fileKey: "src/a.ts",
    identity: "src/a.ts|TS2304|Cannot find name 'x'", occurrence: n });
  assert.equal(at(3), false, "第 3 次仍在基线内");
  assert.equal(at(4), true, "第 4 次超过基线 3 次，是新增");
});

test("基线采集那一趟本身，全部当「新」——它只用来生成基线，不驱动任何门", () => {
  assert.equal(isNewMarker({ baselineCounts: null, baselined: new Set(), fileKey: "x", identity: "i", occurrence: 1 }), true);
});

test("调用方没给「谁有基线」时退回旧行为，不许静默变严", () => {
  assert.equal(isNewMarker({ baselineCounts: counts, baselined: null, fileKey: "src/b.ts",
    identity: "src/b.ts|E|m", occurrence: 1 }), true);
});

test("采集侧：基线没跑成就不许标记成「采过」", () => {
  // 原来是在扩展名 filter 里无条件 add(key)：基线那一趟失败（语言服务器没起来/超时）时
  // 路径照样被标成采过，此后永不重试 —— 存量错误从此永久算成新增，门一开再也关不上。
  assert.match(CODE, /if \(baseline\.ran\) for \(const p of _newBaselinePaths\) run\._diagnosticBaselinePaths\.add\(/,
    "基线采集成功与否没有决定要不要登记");
  assert.doesNotMatch(CODE, /if \(run\._diagnosticBaselinePaths\.has\(key\)\) return false;\s*\n\s*run\._diagnosticBaselinePaths\.add\(key\);/,
    "又变回在 filter 里无条件登记了");
});

test("判定侧真的把「谁有基线」传下去了", () => {
  assert.match(CODE, /async function _interleavedDiagnostics\(editedRelPaths, root = "", baselineCounts = null, triedLangs = null, baselinedKeys = null\)/);
  assert.match(CODE, /run\._diagnosticBaselineCounts,\s*\n\s*run\._diagLangTried,\s*\n\s*run\._diagnosticBaselinePaths,/,
    "判定那次调用没把基线集合传进去，等于这条修复没接上");
  assert.match(CODE, /_isNewMarker\(\{ baselineCounts, baselined: baselinedKeys, fileKey: _fileKey, identity, occurrence \}\)/);
  assert.doesNotMatch(CODE, /occurrence > \(baselineCounts\.get\(identity\) \|\| 0\)\) fresh\.push/, "旧的 || 0 判据还在");
});
