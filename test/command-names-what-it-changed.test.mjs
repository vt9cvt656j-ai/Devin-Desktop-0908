import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";
import { changedPathsReport } from "../src/agent/command-fs-report.js";

const PATHS = ["/w/app/src/App.jsx", "/w/app/package.json", "/w/app/vite.config.js"];

test("改动清单不看退出码、也不看有没有拍快照", () => {
  // 三道闸（purpose=mutate / 快照没截断 / 退出码为 0）全是**撤销**的前提。
  // 清单本身是文件监视器免费给的观测事实，跟着撤销一起消失才是那个 bug。
  assert.equal(changedPathsReport(PATHS, "/w", { ok: true }).n, 3);
  assert.equal(changedPathsReport(PATHS, "/w", { ok: false }).n, 3, "命令失败就不列了？那正是最该列的时候");
  // 断言要挑"绝对前缀没了"，不能挑 /app\/src\/App\.jsx/ —— 绝对路径本身就含这段，
  // 不归一照样匹配（恒真守卫里"匹配到的东西两边都成立"那一种）。
  const lines = changedPathsReport(PATHS, "/w").text.split("\n").slice(1);
  assert.deepEqual(lines, ["app/src/App.jsx", "app/package.json", "app/vite.config.js"],
    "路径没归一到工作区相对");
  // 根不匹配时原样保留，别切出一段无意义的相对路径。
  assert.deepEqual(changedPathsReport(["/other/x.js"], "/w").text.split("\n").slice(1), ["/other/x.js"]);
});

test("失败但已写盘，口径必须和成功不同", () => {
  // 「失败」和「什么都没发生」不能是同一个返回值——模型下一步是重试还是回滚全看这句。
  const bad = changedPathsReport(PATHS, "/w", { ok: false }).text;
  assert.match(bad, /失败了，但工作区已经被改过/);
  assert.match(bad, /别按「什么都没发生」重试/);
  assert.doesNotMatch(changedPathsReport(PATHS, "/w", { ok: true }).text, /失败/);
});

test("没有改动就一个字不加；清单封顶且说清还剩几个", () => {
  assert.equal(changedPathsReport([], "/w").text, "");
  assert.equal(changedPathsReport(null, "/w").n, 0);
  const many = changedPathsReport([...Array(40)].map((_, i) => `/w/f${i}`), "/w", { max: 5 });
  assert.equal(many.n, 40);
  assert.equal(many.text.split("\n").length, 7, "5 个文件名 + 标题 + 「还有 N 个」");
  assert.match(many.text, /…还有 35 个/, "截断了却不说，模型会当这就是全部");
  // 去重：监视器可能对同一个文件报多次
  assert.equal(changedPathsReport(["/w/a", "/w/a", "/w/b"], "/w").n, 2);
});

test("清单走的是独立段，不进那个 900 字的摘要窗", () => {
  // content 尾巴会被 _headTailModelText(…, 900) 切成头 ~346 / 尾 ~422 字，
  // 二十个文件名在尾窗里放不下——算了也送不到，等于没做。
  const f = load("_executionToolResultForModel", {
    _stripAnsi: (t) => String(t || ""),
    _headTailModelText: (t, n) => String(t || "").slice(0, n),
    _clipPreservingErrors: (t) => String(t || ""),
  });
  const out = f({ type: "cmd", command: "npm create vite" },
    { changedFiles: 3, changedReport: "改了 3 个：\napp/src/App.jsx\napp/package.json\napp/vite.config.js",
      stdout: "x".repeat(5000), exitCode: 0, command: "npm create vite" }, {});
  assert.match(out, /工作区改动:/, "清单没有单独成段");
  assert.match(out, /app\/vite\.config\.js/, "清单被别的内容挤掉了");
  assert.match(out, /"changedFiles":3/, "结构化事实里没带改动文件数");
  // 没有清单时不许凭空多一段
  const none = f({ type: "cmd" }, { stdout: "ok", exitCode: 0 }, {});
  assert.doesNotMatch(none, /工作区改动:/);
});

test("执行器把清单接上了，且不受撤销那三道闸管", () => {
  assert.match(CODE, /const _fsReport = _changedPathsReport\(_fsSeen\.paths, root \|\| rootPath, \{ ok: result\.code === 0 \}\)/,
    "清单没在 _fsSeen 之后无条件算出来");
  assert.match(CODE, /changedFiles: _fsReport\.n,\s*\n\s*changedReport: _fsReport\.text,/,
    "算了却没随工具结果带出来");
  // 撤销那条保持原样，只管撤销。
  assert.match(CODE, /if \(_workspaceChangedByCommand && _preCmdSnap && !_preCmdSnap\.truncated\)/,
    "把撤销那条也改了——它本来就该要快照");
});
