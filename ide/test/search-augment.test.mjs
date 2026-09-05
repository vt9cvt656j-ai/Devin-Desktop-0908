// search 增强（src/agent/search-augment.js）：零命中接语义、标识符附符号定义 —— 只附加，不替换。
import test from "node:test";
import assert from "node:assert/strict";
import { augmentSearchResult, looksLikeIdentifier } from "../src/agent/search-augment.js";

test("标识符判定：像变量/函数名的才算，句子和带空格的不算", () => {
  assert.ok(looksLikeIdentifier("buildBM25Index"));
  assert.ok(looksLikeIdentifier("_kgRetrieve"));
  assert.ok(!looksLikeIdentifier("where are invoices validated"));
  assert.ok(!looksLikeIdentifier("ab"));
  assert.ok(!looksLikeIdentifier("src/main.js"));
});

test("查标识符且符号索引有定义 → 附定义；有文本命中时不附语义", () => {
  const out = augmentSearchResult({ query: "buildBM25Index", totalHits: 3,
    symbolHits: [{ kind: "function", path: "src/main.js", line: 42852, sig: "async function buildBM25Index(root)" }],
    semanticHits: [{ path: "x", start: 1, end: 2, score: 1, snippet: "no" }] });
  assert.match(out, /符号索引里「buildBM25Index」的定义/);
  assert.match(out, /src\/main\.js:42852/);
  assert.doesNotMatch(out, /语义/, "有文本命中时不该塞语义兜底");
});

test("零命中 → 按语义给几处，并标明不是精确匹配；索引没就绪就明说；都没有就一个字不加", () => {
  const out = augmentSearchResult({ query: "invoice validation", totalHits: 0,
    semanticHits: [{ path: "src/billing.ts", start: 10, end: 30, score: 12.3, snippet: "function validateInvoice(...) {\n  …" }] });
  assert.match(out, /文本没命中/);
  assert.match(out, /src\/billing\.ts:10-30/);
  assert.match(out, /不是精确匹配/);
  assert.match(augmentSearchResult({ query: "x y", totalHits: 0, semanticHits: [], semanticIndexReady: false }), /语义索引还没建好/);
  assert.equal(augmentSearchResult({ query: "x y", totalHits: 0, semanticHits: [] }), "");
  assert.equal(augmentSearchResult({ query: "x y", totalHits: 5 }), "");
});

test("符号定义最多 8 条并说明还有更多；语义最多 5 条、片段压到一行", () => {
  const sym = Array.from({ length: 12 }, (_, i) => ({ kind: "fn", path: `f${i}.js`, line: i, sig: "s" }));
  const out = augmentSearchResult({ query: "thing", totalHits: 1, symbolHits: sym });
  assert.equal((out.match(/\[fn\]/g) || []).length, 8);
  assert.match(out, /共 12 处，只列前 8/);
  const sem = Array.from({ length: 9 }, (_, i) => ({ path: `p${i}`, start: 1, end: 2, score: 1, snippet: "a\nb   c" }));
  const out2 = augmentSearchResult({ query: "q q", totalHits: 0, semanticHits: sem });
  assert.equal((out2.match(/^\[\d\]/gm) || []).length, 5);
  assert.match(out2, /a b c/);
});
