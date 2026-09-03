// git 改动条的行 diff：剥掉公共前后缀之后，要守住的到底是什么。
//
// lineDiffHunks 原本是完整 O(n·m) 矩阵 LCS。4000 行的文件一次分配 (n+1)×(m+1)×4
// = **64MB** 的 Uint32Array 并跑 1600 万格，然后立刻变垃圾。它挂在打字停顿 450ms
// 上（updateGutter），触发条件只是「在 git 仓库里编辑被跟踪的文件」——写代码的默认状态。
// 上游那行 450ms 的注释写着 `was 250 — full-doc diff on every pause was too hot`：
// 症状早被撞见，当时只是把防抖调大，卡顿被推迟而不是消除。
//
// **这个文件存在的原因**：改这个函数时我先论证了「剥前后缀是逐字节等价变换」——
// 公共后缀给 dp[i+1][j] 和 dp[i][j+1] 加同一个常数，tie-break 不变。
// 论证听着对，但对拍测试当场证伪：5000 组里 162 组输出不同。
// 真实情况是**走到中段末尾时循环直接结束**，而全量版会继续把中段尾行和后缀首行匹配掉，
// 于是在「一串相同行里删哪一行」这种本来就有歧义的地方选了另一个同样最优的位置。
//
// 所以这里守的不是「和旧版逐字节一样」（那是假的），而是两条真不变量：
//   ① 补丁仍然有效：把 hunk 应用到 a 得到的就是 b
//   ② 补丁仍然最小：改动的行数和全量矩阵版一模一样
// 这也正是 git 的取舍：Myers 之前先剥公共前后缀，同样接受歧义处的位置差异。
//
// 真函数用 acorn 从 src/main.js 抠出来跑（fnSource），不复刻逻辑——复刻一份就等于
// 守着测试台自己写的算法，源码怎么改都是绿的。
import assert from "node:assert/strict";
import test from "node:test";
import { fnSource } from "./helpers/source.mjs";

const ctx = {};
new Function(
  `${fnSource("_LINE_DIFF_CELL_BUDGET")}\n${fnSource("lineDiffHunks")}\n${fnSource("_lineDiffHunksCore")}\n` +
  `this.lineDiffHunks = lineDiffHunks; this.core = _lineDiffHunksCore; this.BUDGET = _LINE_DIFF_CELL_BUDGET;`,
).call(ctx);
const { lineDiffHunks, core } = ctx;

/** 把 hunk 应用回 a，应该原样得到 b。 */
function applyHunks(a, b, hunks) {
  const out = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.aStart) out.push(a[i++]);
    i += h.aCount;
    for (let k = 0; k < h.bCount; k++) out.push(b[h.bStart + k]);
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}
const size = (hs) => hs.reduce((s, h) => s + h.aCount + h.bCount, 0);

/** 固定种子的 LCG：用例集必须可复现，不能每次跑都换一批。 */
function rnd(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function corpus(seed, alphabet) {
  const r = rnd(seed);
  const cases = [];
  for (let t = 0; t < 4000; t++) {
    const a = Array.from({ length: 1 + Math.floor(r() * 60) }, () => "L" + Math.floor(r() * alphabet));
    const b = a.slice();
    for (let e = 0, E = Math.floor(r() * 5); e < E; e++) {
      const k = Math.floor(r() * Math.max(1, b.length));
      const op = r();
      if (op < 0.34) b.splice(k, 1);
      else if (op < 0.67) b.splice(k, 0, "X" + Math.floor(r() * 9));
      else b[k] = "Y" + Math.floor(r() * 9);
    }
    cases.push([a, b]);
  }
  return cases;
}

// alphabet=6 是**故意**取小的：相同行越多，歧义越多，剥后缀越容易露馅。
for (const [label, seed, alphabet] of [["高重复行", 7, 6], ["低重复行", 42, 24]]) {
  test(`${label}：补丁仍然有效——应用 hunk 得到的就是 b`, () => {
    for (const [a, b] of corpus(seed, alphabet)) {
      assert.deepEqual(applyHunks(a, b, lineDiffHunks(a, b)), b,
        `hunk 应用不回 b：a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    }
  });

  test(`${label}：补丁仍然最小——改动行数和全量矩阵版一致`, () => {
    for (const [a, b] of corpus(seed, alphabet)) {
      assert.equal(size(lineDiffHunks(a, b)), size(core(a, b)),
        `改动行数变了：a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    }
  });
}

test("大文件改一行：原来整片不画改动条，现在画得出", () => {
  const a = Array.from({ length: 4000 }, (_, i) => "line " + i);
  const b = a.slice();
  b[2000] = "CHANGED";
  const hunks = lineDiffHunks(a, b);
  // 旧代码在 updateGutter 里有 `if (orig.length > 4000 || mod.length > 4000) return 空`，
  // 于是 4000 行以上的文件**永远**没有 git 改动条。守卫现在量的是剥完之后的规模。
  assert.ok(hunks, "4000 行文件必须还能出 hunk（守卫不该按文件行数一刀切）");
  assert.deepEqual(hunks, [{ aStart: 2000, aCount: 1, bStart: 2000, bCount: 1 }]);
});

test("剥前后缀之后真的没建大表：4000 行改一行必须是毫秒以下", () => {
  const a = Array.from({ length: 4000 }, (_, i) => "line " + i);
  const b = a.slice();
  b[2000] = "CHANGED";
  lineDiffHunks(a, b); // 预热
  const t0 = process.hrtime.bigint();
  lineDiffHunks(a, b);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 全量矩阵版实测 ~53ms。放到 5ms 是给慢机器留的余量——真退回全量矩阵必然远超。
  assert.ok(ms < 5, `4000 行改一行花了 ${ms.toFixed(2)}ms，像是又在建全表`);
});

test("病态输入（整份被换掉）返回 null，让调用方放弃这一次绘制", () => {
  const a = Array.from({ length: 5000 }, (_, i) => "a" + i);
  const b = Array.from({ length: 5000 }, (_, i) => "b" + i);
  assert.equal(lineDiffHunks(a, b), null);
});

test("空输入 / 全同 / 一侧为空这些边界不炸", () => {
  assert.deepEqual(lineDiffHunks([], []), []);
  assert.deepEqual(lineDiffHunks(["x"], ["x"]), []);
  assert.deepEqual(lineDiffHunks([], ["x"]), [{ aStart: 0, aCount: 0, bStart: 0, bCount: 1 }]);
  assert.deepEqual(lineDiffHunks(["x"], []), [{ aStart: 0, aCount: 1, bStart: 0, bCount: 0 }]);
});
