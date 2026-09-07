import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE } from "./helpers/source.mjs";

const LSP = readFileSync(new URL("../src/lsp-client.js", import.meta.url), "utf8");

// 干净文件 LSP 送的是**空数组** —— "没有问题"和"还没答"在 marker 数上长得一模一样
// （都是 0）。于是诊断门只能等满 4 秒上限，而且专挑"代码写对了"的时候罚：
// 写错了几百毫秒就出 marker 收工，写对了才等满。JS 那条腿早有显式完成信号
// （Monaco worker 的 _workerDoneAt），LSP 这条一直漏着。

test("LSP 侧记下了 publishDiagnostics 的到达时刻", () => {
  assert.match(LSP, /const _publishedAt = new Map\(\);/);
  assert.match(LSP, /_publishedAt\.set\(String\(uri\), Date\.now\(\)\)/,
    "没在 applyDiagnostics 里记 —— 干净文件那一路就还是没有信号");
  assert.match(LSP, /diagnosticsPublishedAt\(uri\) \{\s*\n\s*return Number\(_publishedAt\.get/,
    "记了却没暴露读取面");
});

test("记账要在最早的位置：uri 校验之后、任何 return 之前", () => {
  // applyDiagnostics 中途有好几处 return（模型找不到且诊断为空、有待冲的改动…）。
  // 记在后面的话，恰恰是"干净文件"那几条路径记不上——而那正是要救的场景。
  const at = LSP.indexOf("async function applyDiagnostics");
  const body = LSP.slice(at, at + 1400);
  const iSet = body.indexOf("_publishedAt.set");
  const iFirstReturn = body.indexOf("return;", body.indexOf("const uri = params.uri;"));
  assert.ok(iSet > 0 && iSet < iFirstReturn,
    "记账排在某个 return 后面了——干净文件那条路径记不上");
});

test("诊断门真的把这个信号接上了，且带挂载宽限", () => {
  assert.match(CODE, /lspManager\?\.diagnosticsPublishedAt\?\.\(t\.model\.uri\.toString\(\)\)/,
    "没读 LSP 的完成信号");
  assert.match(CODE, /const _lspReady = _lspPublishedAt >= started && now >= _lspPublishedAt \+ _TS_PUBLISH_GRACE_MS/,
    "没有挂载宽限，或者没排除本轮开始之前的旧信号");
  assert.match(CODE, /if \(has \|\| _workerReady \|\| _lspReady \|\| now >= own\(t\)\)/,
    "算出来了却没进结算条件");
});

test("只认本轮开始之后的信号——上一轮的旧时间戳不许提前收工", () => {
  // `_lspPublishedAt >= started` 这一条是必需的：Map 是跨轮存活的，不加这条判据的话
  // 上一轮留下的时间戳会让这一轮**立刻**判成已结算，等于整道门作废。
  assert.match(CODE, /_lspPublishedAt >= started/);
});

test("JS 那条腿原样保留——这次是补 LSP，不是改 JS", () => {
  assert.match(CODE, /const _workerReady = t\._workerDoneAt != null && now >= t\._workerDoneAt \+ _TS_PUBLISH_GRACE_MS/);
  assert.match(CODE, /const own = \(t\) => started \+ \(t\.jsFamily \? _INTERLEAVED_DIAG_TS_WAIT_MS : _INTERLEAVED_DIAG_MAX_WAIT_MS\)/);
});
