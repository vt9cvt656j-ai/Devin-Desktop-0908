// 节点编号器四处共用（Rust 每次快照 / nodes·observe / read / find）：Rust 那份拷贝必须和 JS 逐字一致，
// 否则同一页面上红数字和 node 号是两套编号，模型按红数字点会点到别的元素。
// 三段页内脚本要能被解析、选项要被钳在上限内、传入的字符串不能把脚本本身弄坏。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NODE_TAG_SNIPPET, NODE_TAG_CAP, _readPageJS, _findInPageJS, _scrollToJS, READ_DEFAULTS, FIND_DEFAULTS } from "../src/agent/browser-read-scripts.js";
import { _NODES_EXTRACT_JS } from "../src/agent/browser-page-scripts.js";
import { _browserBatchFastJS } from "../src/agent/browser-batch-script.js";

const RS = readFileSync(new URL("../src-tauri/src/browser.rs", import.meta.url), "utf8");
const parses = (js) => { new Function(js); return true; };

test("Rust 的 NODE_TAG_JS 和 JS 的 NODE_TAG_SNIPPET 逐字相同，上限也一样——四处编号才是同一套", () => {
  const m = /const NODE_TAG_JS: &str = r##"([\s\S]*?)"##;/.exec(RS);
  assert.ok(m, "browser.rs 里没有 NODE_TAG_JS");
  assert.equal(m[1], NODE_TAG_SNIPPET, "Rust 那份编号器和 JS 漂了");
  const cap = /const NODE_TAG_CAP: usize = (\d+);/.exec(RS);
  assert.equal(Number(cap && cap[1]), NODE_TAG_CAP);
  assert.match(RS, /ENUMERATE_JS[\s\S]*__mtag\(__CAP__\)/, "Rust 的枚举脚本没有用编号器");
  assert.match(NODE_TAG_SNIPPET, /el\.setAttribute\('data-mnode',String\(id\)\);el\.setAttribute\('data-mref',String\(id\)\)/, "两种选择器要指向同一个元素");
});

test("nodes / observe / read / find / 滚到 都用同一份编号器", () => {
  assert.ok(_NODES_EXTRACT_JS.includes(NODE_TAG_SNIPPET), "nodes 快照没用共享编号器");
  assert.ok(_browserBatchFastJS([{ op: "observe" }]).includes(NODE_TAG_SNIPPET), "observe / batch 的 nodeList 没用共享编号器");
  assert.ok(_browserBatchFastJS([{ op: "observe" }]).includes(`__mtag(${NODE_TAG_CAP})`), "批处理那份写死的上限和 NODE_TAG_CAP 漂了");
  assert.ok(_NODES_EXTRACT_JS.includes(`__mtag(${NODE_TAG_CAP})`) && _readPageJS().includes(`var __CAP = ${NODE_TAG_CAP};`), "nodes / read 的上限没跟着 NODE_TAG_CAP");
  for (const js of [_readPageJS(), _findInPageJS({ text: "x" }), _scrollToJS({ text: "x" })]) assert.ok(js.includes(NODE_TAG_SNIPPET));
  assert.ok(!NODE_TAG_SNIPPET.includes("`") && !NODE_TAG_SNIPPET.includes("${"), "编号器里不能有反引号或 ${——Rust 原始字符串和 JS 模板都吃不下");
  assert.match(NODE_TAG_SNIPPET, /\[tabindex\]:not\(\[tabindex="-1"\]\)/, "可聚焦的自定义控件也要编号");
  assert.match(NODE_TAG_SNIPPET, /'••••'/, "密码框的值要打码");
});

test("三段页内脚本都是合法 JS，选项被钳在上限内，传入的字符串不会把脚本弄坏", () => {
  for (const js of [
    _readPageJS({ offset: -5, maxChars: 10, selector: "'\"<x>`${y}" }),
    _findInPageJS({ text: "a(b\"c`${d}", limit: 9999 }),
    _findInPageJS({ pattern: "\\d+", role: "button" }),
    _scrollToJS({ selector: "[data-mnode=\"3\"]", text: "x'y" }),
  ]) assert.ok(parses(js));
  assert.match(_readPageJS({ offset: -5, maxChars: 10 }), /"offset":0,"maxChars":500/);
  assert.match(_readPageJS({ maxChars: 999999 }), new RegExp(`"maxChars":${READ_DEFAULTS.maxCharsCap}`));
  assert.match(_readPageJS(), new RegExp(`"maxChars":${READ_DEFAULTS.maxChars}`));
  assert.match(_findInPageJS({ text: "x", limit: 9999 }), new RegExp(`"limit":${FIND_DEFAULTS.limitCap}`));
  assert.match(_findInPageJS({ text: "x" }), new RegExp(`"limit":${FIND_DEFAULTS.limit},"scroll":true`));
  assert.match(_findInPageJS({ text: "x", scroll: false }), /"scroll":false/);
});

test("read 的走法：正文容器优先 main/article、链接带 [n]、控件带角色和值、密码打码、分页给 next；find 给上下文和旁边的节点号并滚过去", () => {
  const js = _readPageJS();
  for (const sig of ["main,[role=\"main\"],article", "bestLen >= bodyLen * 0.4", "' [' + an + ']'", "tagOf(el, role", "'••••'", "next: next", "FENCE", "outline"]) assert.ok(js.includes(sig), `read 脚本少了 ${sig}`);
  const f = _findInPageJS({ text: "x" });
  for (const sig of ["createTreeWalker", "closestDeep(p, '[data-mnode]')", "scrollIntoView", "nodeMatches", "textMatches", "inView"]) assert.ok(f.includes(sig), `find 脚本少了 ${sig}`);
  const sc = _scrollToJS({ text: "x" });
  for (const sig of ["scrollIntoView", "not_found", "scrollY"]) assert.ok(sc.includes(sig), `滚到脚本少了 ${sig}`);
});
