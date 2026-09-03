// bm25 检索的倒排表：加了它之后，结果必须和全表扫一模一样。
//
// 原来的内层循环是 `for (const c of _bm25Index.chunks)` —— **每个查询词扫一遍全部
// chunk**。本仓 26,700 个 chunk，而中文一句话能切出几十个 token，于是「按下回车」
// 那一刻同步跑几十遍全表扫（实测 50~110ms）。索引里本来就在遍历 tf 更新 df，
// 顺手把 term → chunk[] 建出来即可，查询就只碰真正命中的那几个。
//
// 这个文件守的是**结果不变**：倒排表是纯加速，排序和分数都不该动。
// 真函数用 acorn 从 src/main.js 抠出来跑，索引是合成的（真索引要扫工作区）。
import assert from "node:assert/strict";
import test from "node:test";
import { fnSource, loadConst } from "./helpers/source.mjs";

const ctx = {};
new Function(
  `${fnSource("_BM25_K1")}\n${fnSource("_BM25_B")}\n${fnSource("_BM25_STOP")}\n${fnSource("_bm25Index")}\n` +
  `${fnSource("_tokenize")}\n${fnSource("_bm25AddChunk")}\n${fnSource("bm25Search")}\n` +
  `this.addChunk = _bm25AddChunk;` +
  `this.idx = _bm25Index; this.bm25Search = bm25Search;`,
).call(ctx);
const { idx, bm25Search } = ctx;

/** 建一个合成索引；同时按老写法（无倒排表）算一份对照。 */
function buildSynthetic(seed, nChunks, vocab) {
  let x = seed;
  const r = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  idx.chunks = []; idx.df.clear(); idx.post.clear(); idx.totalLen = 0;
  for (let i = 0; i < nChunks; i++) {
    const toks = Array.from({ length: 5 + Math.floor(r() * 40) }, () => "t" + Math.floor(r() * vocab));
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    // **用源码里那个真函数收 chunk**，不在测试台里另拼一份索引：
    // 自拼的话，源码里漏建倒排表照样绿（实测过，这个守卫一开始就是恒真的）。
    ctx.addChunk({ id: i, path: `f${i % 17}.js`, start: 1, end: 9, snippet: "s" + i, termFreq: tf, len: toks.length });
  }
  idx.avgLen = idx.totalLen / (idx.chunks.length || 1);
  idx.built = true;
  idx.root = "/synthetic";
}

/** 老实现：内层全表扫。分数公式逐字照抄，只有遍历范围不同。 */
function fullScanSearch(qToks, topK) {
  const N = idx.chunks.length, avg = idx.avgLen || 1, K1 = 1.5, B = 0.75;
  const scores = new Map();
  for (const term of qToks) {
    const df = idx.df.get(term) || 0;
    if (df === 0) continue;
    const s = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const c of idx.chunks) {
      const tf = c.termFreq.get(term);
      if (!tf) continue;
      scores.set(c.id, (scores.get(c.id) || 0) + s * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (c.len / avg)))));
    }
  }
  const sorted = [...idx.chunks].filter((c) => scores.has(c.id));
  sorted.sort((a, b) => scores.get(b.id) - scores.get(a.id));
  return sorted.slice(0, topK || 10).map((c) => ({ ...c, score: scores.get(c.id) }));
}

test("公式常数没漂：测试台里的 K1/B 必须就是源码里那两个", () => {
  // 上面 fullScanSearch 写死了 1.5 / 0.75。源码一改常数而这里不改，对拍就变成
  // 「两套不同公式互相验证」——恒绿。所以先把它们钉死。
  assert.equal(loadConst("_BM25_K1"), 1.5);
  assert.equal(loadConst("_BM25_B"), 0.75);
});

test("倒排表检索的结果和全表扫逐条一致（分数、顺序、条数）", () => {
  for (const [seed, n, vocab] of [[11, 400, 60], [23, 1200, 200], [37, 300, 25]]) {
    buildSynthetic(seed, n, vocab);
    for (let q = 0; q < 60; q++) {
      const qToks = Array.from({ length: 1 + (q % 6) }, (_, k) => "t" + ((q * 7 + k * 13) % vocab));
      const got = bm25Search(qToks.join(" "), 10);
      const want = fullScanSearch(qToks, 10);
      assert.equal(got.length, want.length, `条数不同 seed=${seed} q=${q}`);
      for (let i = 0; i < want.length; i++) {
        assert.equal(got[i].id, want[i].id, `第 ${i} 条命中不同 seed=${seed} q=${q}`);
        assert.ok(Math.abs(got[i].score - want[i].score) < 1e-9, `分数不同 seed=${seed} q=${q}`);
      }
    }
  }
});

test("查询真的没再全表扫：内层碰到的 chunk 数远小于总数", () => {
  buildSynthetic(11, 2000, 400);
  let touched = 0;
  const orig = new Map();
  for (const c of idx.chunks) { orig.set(c, c.termFreq); c.termFreq = { get: (t) => { touched++; return orig.get(c).get(t); } }; }
  bm25Search("t1 t2 t3", 10);
  for (const c of idx.chunks) c.termFreq = orig.get(c);
  // 3 个词全表扫 = 6000 次。倒排表下只碰命中的，本例是几十量级。
  assert.ok(touched < 600, `内层碰了 ${touched} 个 chunk，像是还在全表扫（全表扫是 6000）`);
});

test("倒排表缺失时退回全表扫，结果不变（旧索引兼容）", () => {
  buildSynthetic(23, 300, 40);
  const want = fullScanSearch(["t1", "t2"], 10);
  idx.post.clear(); // 模拟一份没有 post 的旧索引
  const got = bm25Search("t1 t2", 10);
  assert.deepEqual(got.map((c) => c.id), want.map((c) => c.id));
});

test("df 和倒排表都真的被填了——对拍看不见这一层", () => {
  // 对拍两版都读同一份 df，所以 df 整个漏建时两边**一致地**返回空，测试照样绿
  // （变异测试实测如此）。这条直接从 chunks 重算一遍来堵那个洞。
  buildSynthetic(11, 300, 50);
  const df = new Map();
  for (const c of idx.chunks) for (const [t] of c.termFreq) df.set(t, (df.get(t) || 0) + 1);
  assert.ok(df.size > 0, "合成语料本身要有词");
  for (const [term, n] of df) {
    assert.equal(idx.df.get(term), n, `df 对不上：${term}`);
    assert.equal(idx.post.get(term)?.length, n, `倒排表条数对不上：${term}`);
  }
});
