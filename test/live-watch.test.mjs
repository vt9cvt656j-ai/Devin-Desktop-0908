// 实时监听的纯逻辑（agent/live-watch.js）：判错、去重、限流、规则、拼通知。真跑。没有界面：规则来自工作区的 .mrdayone/live-watch.json。
import test from "node:test";
import assert from "node:assert/strict";
import { SRC, CODE } from "./helpers/source.mjs";
import {
  normalizeLiveWatchConfig, normalizeRule, detectTerminalError, detectPreviewError,
  detectCaptureFailure, eventSignature, makeWatchEvent, newWatchState, matchRules, decideFire, composeWatchNotice,
  DEFAULT_LIVE_WATCH, LIVE_WATCH_CONFIG_FILE,
} from "../src/agent/live-watch.js";

test("配置归一：默认全开、mode=auto；坏值回默认；规则去掉不成形的", () => {
  const c = normalizeLiveWatchConfig(null);
  assert.equal(c.mode, "auto");
  assert.deepEqual(c.sources, { preview: true, terminal: true, capture: true, screen: true });
  assert.equal(c.cooldownSec, DEFAULT_LIVE_WATCH.cooldownSec);
  const d = normalizeLiveWatchConfig({ mode: "weird", sources: { preview: false }, rules: [{ source: "screen", pattern: "x" }, { source: "terminal", pattern: "boom", prompt: "修" }], cooldownSec: 5, maxPer10Min: 999 });
  assert.equal(d.mode, "auto");
  assert.equal(d.sources.preview, false);
  assert.equal(d.rules.length, 1, "screen 规则没应用名不成形");
  assert.equal(d.cooldownSec, 30);
  assert.equal(d.maxPer10Min, 20);
});

test("规则文件住在工作区的 .mrdayone 下——没有界面，智能体按用户的话写它", () => {
  assert.equal(LIVE_WATCH_CONFIG_FILE, ".mrdayone/live-watch.json");
});

test("终端判错只认强形状：栈 / traceback / panic / 编译失败 / 端口占用；警告和 ready 行不算", () => {
  const yes = [
    "TypeError: Cannot read properties of undefined (reading 'map')\n    at App (/src/App.tsx:12:20)\n    at renderWithHooks (react-dom.js:1:1)\n",
    "Traceback (most recent call last):\n  File \"app.py\", line 3\nZeroDivisionError: division by zero\n",
    "Error: listen EADDRINUSE: address already in use :::3000\n",
    "thread 'main' panicked at src/main.rs:4:5:\nboom\n",
    "\x1b[31merror\x1b[0m TS2322: Type string is not assignable\n",
    "Exception in thread \"main\" java.lang.NullPointerException\n",
    "[ERROR] request failed\n",
  ];
  for (const c of yes) assert.equal(detectTerminalError(c).hit, true, JSON.stringify(c.slice(0, 40)));
  const no = [
    "  vite v5 ready in 300ms\n  ➜ Local: http://localhost:5173/\n",
    "npm WARN deprecated foo@1.0.0\n(node:123) DeprecationWarning: x\n",
    "  [vite] hmr update /src/App.tsx\n",
    "warning: unused variable `x`\n",
    "GET /api/items 200 12ms\n",
  ];
  for (const c of no) assert.equal(detectTerminalError(c).hit, false, JSON.stringify(c.slice(0, 40)));
});

test("终端判错：命中必须落在新到的那一段里（旧尾巴里的栈不重复触发），且带前后几行", () => {
  const prev = "TypeError: old one\n    at a (x.js:1:1)\n";
  const chunk = "GET / 200\n";
  const r = detectTerminalError(prev + chunk, { minIndex: prev.length - 10 });
  assert.equal(r.hit, false, "旧栈不该再触发");
  const chunk2 = "ReferenceError: y is not defined\n    at b (y.js:2:2)\n";
  const r2 = detectTerminalError(prev + chunk2, { minIndex: prev.length - 10 });
  assert.equal(r2.hit, true);
  assert.match(r2.excerpt, /ReferenceError/);
  assert.doesNotMatch(r2.excerpt.split("\n")[0], /^TypeError/);
});

test("预览控制台只要 error 级，且过滤已知噪音；抓包只算 5xx / 连接错误", () => {
  assert.equal(detectPreviewError("error", "Uncaught TypeError: x is not a function"), true);
  assert.equal(detectPreviewError("warn", "anything"), false);
  assert.equal(detectPreviewError("error", "GET http://localhost/favicon.ico 404"), false);
  assert.equal(detectPreviewError("error", "Download the React DevTools for a better development experience"), false);
  assert.equal(detectCaptureFailure({ status: 500 }).hit, true);
  assert.equal(detectCaptureFailure({ status: 404 }).hit, false);
  assert.equal(detectCaptureFailure({ status: 0, error: "ECONNRESET" }).hit, true);
  assert.equal(detectCaptureFailure({ status: 200 }).hit, false);
});

test("签名抹掉行号 / 哈希 / 路径：同一个错误在不同位置算同一个", () => {
  const a = eventSignature("preview", "TypeError: boom at /Users/x/app/src/App.tsx:12:20 chunk-a1b2c3d4e5f6g7h8.js");
  const b = eventSignature("preview", "TypeError: boom at /Users/y/other/App.tsx:99:1 chunk-ffffffffffffffff.js");
  assert.equal(a, b);
  assert.notEqual(a, eventSignature("preview", "ReferenceError: boom"));
  assert.notEqual(a, eventSignature("terminal", "TypeError: boom"));
});

test("去重 + 限流：同签名冷却期内只报一次；十分钟内最多 N 次；off 只记录；记录里有 outcome", () => {
  const cfg = normalizeLiveWatchConfig({ cooldownSec: 60, maxPer10Min: 2 });
  const st = newWatchState();
  const ev = (text, at) => makeWatchEvent({ source: "preview", kind: "preview_error", text, at });
  assert.equal(decideFire(st, ev("A", 1000), cfg, "auto", 1000).reason, "auto");
  assert.equal(decideFire(st, ev("A", 2000), cfg, "auto", 2000).reason, "duplicate");
  assert.equal(decideFire(st, ev("B", 3000), cfg, "auto", 3000).reason, "auto");
  assert.equal(decideFire(st, ev("C", 4000), cfg, "auto", 4000).reason, "rate_limited");
  assert.equal(decideFire(st, ev("A", 1000 + 61_000), cfg, "auto", 1000 + 61_000).reason, "rate_limited", "冷却过了但十分钟名额用完");
  assert.equal(decideFire(st, ev("D", 1000 + 11 * 60_000), cfg, "auto", 1000 + 11 * 60_000).reason, "auto", "十分钟过了名额回来");
  assert.equal(decideFire(newWatchState(), ev("E", 1), cfg, "off", 1).reason, "off");
  assert.equal(decideFire(newWatchState(), ev("F", 1), cfg, "ask", 1).reason, "ask");
  assert.deepEqual(st.recent.map((r) => r.outcome), ["auto", "rate_limited", "rate_limited", "auto", "duplicate", "auto"]);
});

test("规则：来源 + 文字（或正则）+ 应用名；命中的规则带 prompt 进通知", () => {
  const rules = [
    normalizeRule({ source: "preview", pattern: "支付失败", prompt: "把支付按钮改成灰色并提示稍后再试" }),
    normalizeRule({ source: "screen", app: "记事本", pattern: "未响应" }),
    normalizeRule({ source: "any", pattern: "^Fatal", isRegex: true }),
  ];
  const ev = makeWatchEvent({ source: "preview", kind: "preview_error", text: "订单页：支付失败 code=9" });
  assert.equal(matchRules(rules, ev).prompt, "把支付按钮改成灰色并提示稍后再试");
  assert.equal(matchRules(rules, makeWatchEvent({ source: "terminal", kind: "x", text: "Fatal: db down" })).source, "any");
  assert.equal(matchRules(rules, makeWatchEvent({ source: "screen", kind: "x", text: "程序未响应", where: "记事本" })).app, "记事本");
  assert.equal(matchRules(rules, makeWatchEvent({ source: "screen", kind: "x", text: "程序未响应", where: "别的应用" })), null);
  const n = composeWatchNotice(ev, { rule: rules[0], previewUrl: "http://localhost:5173/" });
  assert.match(n.text, /^〔实时监听〕/);
  assert.match(n.text, /http:\/\/localhost:5173\//);
  assert.match(n.text, /把支付按钮改成灰色/);
  assert.match(n.display, /规则命中/);
  const m = composeWatchNotice(makeWatchEvent({ source: "terminal", kind: "terminal_js-error", text: "TypeError: boom", where: "▶ dev" }), { tail: "line1\nline2", terminalLabel: "dev · npm run dev" });
  assert.match(m.text, /终端「dev · npm run dev」/);
  assert.match(m.text, /定位根因并修好/);
  assert.match(m.text, /line2/);
});

// ── main.js 接线：源头挂上了、通知走后台监控那条路 ─────────────────────────────

test("四个源头都接进了汇合点，汇合点走 _queueNotice(kind=watch) + _drainFollowups", () => {
  const code = CODE;
  assert.match(code, /_previewPushLog\(\{[\s\S]{0,400}?\}\);\s*try \{ _liveWatchPreviewLog\(d\); \} catch \{\}/, "预览控制台没接");
  assert.match(code, /try \{ _liveWatchTerminalChunk\(entry, ev\.data, _prevOut\); \} catch \{\}/, "任务终端没接");
  assert.match(code, /_captureTotal\+\+;\s*try \{ _liveWatchCaptureFlow\(flow\); \} catch \{\}/, "抓包没接");
  assert.match(code, /backend\.invoke\("probe_screen", \{ app, pid: null \}\)/, "界面规则没走 probe（不作废 ref 的那条路）");
  assert.match(code, /_queueNotice\(sess, notice\.text, \{ source: "live_watch", kind: "watch"/, "没走后台通知那条路");
  assert.match(code, /_liveWatchDispatch[\s\S]{0,300}_drainFollowups\(sess\)/, "排了通知没有 drain");
  assert.match(code, /String\(meta\.kind \|\| ""\) === "watch"/, "_queueNotice 没有实时监听的措辞");
  assert.match(code, /options\.notice\.source === "live_watch"/, "通知行没有实时监听的样式");
});

test("长驻服务才盯：一次性命令的报错不触发（模型自己在处理）", () => {
  const code = CODE;
  const fn = code.slice(code.indexOf("function _liveWatchTerminalChunk("), code.indexOf("function _liveWatchCaptureFlow("));
  assert.match(fn, /_looksLikeServiceCommand\(cmd\)/);
  assert.match(fn, /minIndex: Math\.max\(0, prev\.length - 160\)/, "命中没限定在新到的那一段");
});
