// 「业务逻辑错误没有任何机械检查」这条缺口。
//
// 交错验证此前只有一条腿：Monaco 内建 worker 的语法/类型诊断 + LSP。那条腿认的是
// 「这行编译不过」。而用户真正吃亏的一类 bug 在语法上全对、类型也全过：漏 await 的
// promise、该用 === 用了 ==、React hook 依赖不全、catch 了又吞掉、未使用变量背后藏着
// 拼错的名字。只有项目自己配的 linter 认得，而那份配置就躺在仓库里没人读。
// 纯 JS 项目最极端：没有类型检查，那条腿只剩语法。
//
// 这份守三件事：认得出项目配了什么、只跑改动的那几个文件、输出读得对（且只取 error）。
// 最后两条**真的把 eslint 跑起来**——解析器是照着输出格式写的，格式变了只有真跑才知道。
import test from "node:test";
import assert from "node:assert/strict";
// 走共享的 SRC，不自己读 main.js：从 main.js 搬出模块时自读会假红（元测试也拦这个）。
import { SRC as MAIN_SRC } from "./helpers/source.mjs";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SRC, fnSource } from "./helpers/source.mjs";
import {
  detectLinter, lintCommand, parseLintErrors, lintRan, lintFindings,
  newFindings, findingKey, lintReport,
} from "../src/agent/project-lint.js";

test("只按项目自己的配置认——仓库没配就什么都不跑", () => {
  assert.deepEqual(detectLinter(new Set(["package.json", "src"]), { name: "x" }), [],
    "没配 linter 却跑了一个——拿我们选的规则评判别人的代码，产出的全是噪音");
  assert.deepEqual(detectLinter(new Set(), null), []);

  const flat = detectLinter(new Set(["eslint.config.js"]), null);
  assert.equal(flat[0]?.id, "eslint", "扁平配置（新一代命名）没认出来");
  const legacy = detectLinter(new Set([".eslintrc.json"]), null);
  assert.equal(legacy[0]?.id, "eslint", "旧命名没认出来——大量存量仓库还在用");
  // 配置也可以整个塞在 package.json 里。
  assert.equal(detectLinter(new Set(["package.json"]), { eslintConfig: { rules: {} } })[0]?.id, "eslint");
  // 只在 devDependencies 里声明、配置还没落盘的也算。
  assert.equal(detectLinter(new Set(), { devDependencies: { eslint: "^9" } })[0]?.id, "eslint");

  assert.equal(detectLinter(new Set(["ruff.toml"]), null)[0]?.id, "ruff");
  assert.equal(detectLinter(new Set(["pyproject.toml"]), { pyprojectHasRuff: true })[0]?.id, "ruff");
  assert.equal(detectLinter(new Set(["go.mod"]), null)[0]?.id, "go-vet",
    "go vet 是工具链自带的，有 go.mod 就一定跑得起来");
  assert.equal(detectLinter(new Set(["go.mod", ".golangci.yml"]), null)[0]?.id, "golangci-lint",
    "项目配了 golangci 就用它，别退回更弱的 go vet");

  // 一个仓库可以同时是 JS 和 Python 的。
  const both = detectLinter(new Set(["eslint.config.js", "ruff.toml"]), null).map((l) => l.id);
  assert.deepEqual(both.sort(), ["eslint", "ruff"]);
});

test("只跑改动的那几个文件——交错验证里没有全仓扫描的余地", () => {
  const eslint = detectLinter(new Set(["eslint.config.js"]), null)[0];
  const cmd = lintCommand(eslint, ["src/a.ts", "src/b.tsx", "README.md", "app.py"]);
  assert.equal(cmd.program, "npx");
  assert.ok(cmd.args.includes("src/a.ts") && cmd.args.includes("src/b.tsx"));
  assert.ok(!cmd.args.includes("README.md"), "md 不归 eslint 管");
  assert.ok(!cmd.args.includes("app.py"), "py 不归 eslint 管");
  assert.ok(!cmd.args.some((a) => a === "." || a === "src" || a.includes("**")),
    `命令里出现了全仓/通配目标：${cmd.args.join(" ")}`);

  // 这一批里一个它管得着的文件都没有 → 整个跳过，不跑一次空扫描。
  assert.equal(lintCommand(eslint, ["README.md", "go.mod"]), null);
  assert.equal(lintCommand(eslint, []), null);

  // go vet 吃的是包不是文件。
  const vet = detectLinter(new Set(["go.mod"]), null)[0];
  assert.deepEqual(lintCommand(vet, ["cmd/server/main.go", "cmd/server/util.go"]).args,
    ["vet", "./cmd/server/..."], "同一个包不该被列两遍");
});

test("只取 error；warning 一律丢掉", () => {
  const eslintOut = JSON.stringify([{
    filePath: "/repo/src/a.ts",
    messages: [
      { severity: 2, line: 12, ruleId: "no-floating-promises", message: "Promises must be awaited" },
      { severity: 1, line: 3, ruleId: "quotes", message: "Strings must use singlequote" },
      { fatal: true, line: 1, ruleId: null, message: "Parsing error: Unexpected token" },
    ],
  }]);
  const errs = parseLintErrors("eslint", eslintOut);
  assert.equal(errs.length, 2, "warning 被当成 error 了——阻断门里放风格就是把门玩坏");
  assert.equal(errs[0].line, 12);
  assert.equal(errs[0].rule, "no-floating-promises");
  assert.ok(errs[1].message.includes("Parsing error"), "fatal 必须当 error");

  // ruff 的形状不一样。
  const ruffErrs = parseLintErrors("ruff", JSON.stringify([
    { filename: "app.py", location: { row: 7 }, code: "F821", message: "Undefined name `reponse`" },
  ]));
  assert.deepEqual(ruffErrs, [{ rel: "app.py", line: 7, rule: "F821", message: "Undefined name `reponse`" }]);

  // go vet 不出 JSON，走行格式。
  const vetErrs = parseLintErrors("go-vet", "cmd/main.go:12:5: Printf format %d has arg s of wrong type string\n");
  assert.equal(vetErrs.length, 1);
  assert.equal(vetErrs[0].line, 12);

  // 读不懂就说读不懂，别猜。
  assert.deepEqual(parseLintErrors("eslint", "not json at all"), []);
  assert.deepEqual(parseLintErrors("eslint", ""), []);
});

test("biome / oxlint / golangci 的形状：用真实工具的实际输出，不是照文档猜", () => {
  // 下面这三份都是**实跑当前版本**抓到的原文（biome 2.5.10 / oxlint 1.80.0 / golangci v2）。
  // 解析器是照着输出格式写的，而格式会跟着上游大版本漂 —— 漂了之后解析恒返回空数组、
  // 整道门静默失效、测试还全绿。这条测试就是为这件事存在的。

  // biome 2.x：location.path 是**裸字符串**，行号在 location.start.line，正文叫 message。
  const biome2 = JSON.stringify({ diagnostics: [{
    severity: "error",
    message: "Using == may be unsafe if you are relying on type coercion.",
    category: "lint/suspicious/noDoubleEquals",
    location: { path: "src/a.js", start: { line: 2, column: 33 }, end: { line: 2, column: 35 } },
  }] });
  assert.deepEqual(parseLintErrors("biome", biome2), [{
    rel: "src/a.js", line: 2, rule: "lint/suspicious/noDoubleEquals",
    message: "Using == may be unsafe if you are relying on type coercion.",
  }], "biome 2.x 的字段读错了 —— 阻断门会开，但正文没有文件、没有行、没有说明");

  // biome 1.x：location.path 是 {file}，正文叫 description。存量项目还在用。
  const biome1 = JSON.stringify({ diagnostics: [{
    severity: "error", description: "Use === instead of ==", category: "lint/suspicious/noDoubleEquals",
    location: { path: { file: "src/a.js" }, span: [27, 29] },
  }] });
  const b1 = parseLintErrors("biome", biome1);
  assert.equal(b1.length, 1);
  assert.equal(b1[0].rel, "src/a.js");
  assert.equal(b1[0].message, "Use === instead of ==");

  // oxlint：span 里 line/column/offset 都在。取 offset 当行号的话，小文件里指向不存在的
  // 行，大文件里指向一个**存在但完全无关**的行 —— 而模型被明确要求去那儿修。
  const ox = JSON.stringify({ diagnostics: [{
    code: "eslint(eqeqeq)", severity: "error", filename: "src/a.js",
    message: "Expected === and instead saw ==",
    labels: [{ span: { offset: 34, length: 2, line: 2, column: 9 } }],
  }] });
  assert.equal(parseLintErrors("oxlint", ox)[0].line, 2,
    "取的是字节偏移量不是行号 —— 报出来的位置在文件里根本不存在");

  // golangci-lint：**不带格式标志**。v1 的 --out-format 在 v2 里已经删掉
  // （实测 2.13.1 报 unknown flag、退出码 3、stdout 空），而两个大版本都在用。
  // 默认文本输出两版一致，行格式解析本来就认它。
  const g = detectLinter(new Set(["go.mod", ".golangci.yml"]), null)[0];
  const gc = lintCommand(g, ["cmd/main.go"], "");
  assert.ok(!gc.args.some((a) => /out-format|output\./.test(a)),
    `带了会随上游漂的格式标志：${gc.args.join(" ")}`);
  assert.equal(parseLintErrors("golangci-lint",
    "cmd/main.go:12:5: Printf format %d has arg s of wrong type string (govet)").length, 1);
});

test("路径一律落回仓库相对——绝对路径会把 go vet 那条腿整条打死", () => {
  // 抓 baseline 那次喂的是模型填的原始 call.path（通常相对），开阻断门那次喂的是
  // call._resolvedPath（一定绝对）。两次给同一个 linter 喂不同形状，轻则报告路径不一致、
  // baseline 抵扣对不上，重则像 go vet 这样直接拼出 `.//Users/...` 这种非法包模式
  // （实跑 exit=1、stderr 是 `pattern ./Users/…: lstat …: no such file or directory`，
  // 那段文本过不了行格式正则 → 解析空 → lintRan=false → 所有 Go 仓库上这条腿恒不可用）。
  const vet = detectLinter(new Set(["go.mod"]), null)[0];
  assert.deepEqual(
    lintCommand(vet, ["/Users/x/repo/cmd/server/main.go"], "/Users/x/repo").args,
    ["vet", "./cmd/server/..."],
    "绝对路径没落回相对 —— 拼出来的是非法包模式，这条腿在所有 Go 仓库上恒不可用",
  );
  // 相对路径照旧。
  assert.deepEqual(lintCommand(vet, ["cmd/server/main.go"], "/Users/x/repo").args, ["vet", "./cmd/server/..."]);
  // eslint 也要落回相对：两次调用的路径形状必须一致，否则 baseline 抵扣按文件名对不上。
  const es = detectLinter(new Set(["eslint.config.js"]), null)[0];
  assert.ok(lintCommand(es, ["/Users/x/repo/src/a.ts"], "/Users/x/repo").args.includes("src/a.ts"));
});

test("仓库里本来就有的问题不算模型头上——否则门一开就永远关不上", () => {
  const before = [
    { rel: "src/a.ts", line: 3, rule: "no-unused-vars", message: "'x' is defined but never used" },
  ];
  const after = [
    // 同一条，只是编辑让它挪了两行 —— 行号不进身份，不该被当成新的。
    { rel: "src/a.ts", line: 5, rule: "no-unused-vars", message: "'x' is defined but never used" },
    { rel: "src/a.ts", line: 9, rule: "no-floating-promises", message: "Promises must be awaited" },
  ];
  const fresh = newFindings(before, after);
  assert.equal(fresh.length, 1, "老问题被算成新引入的了");
  assert.equal(fresh[0].rule, "no-floating-promises");

  // 绝对路径和相对路径指的是同一个文件。
  assert.equal(
    findingKey({ rel: "/Users/x/repo/src/a.ts", rule: "r", message: "m" }),
    findingKey({ rel: "repo/src/a.ts", rule: "r", message: "m" }),
  );
  // 同一条重复出现只报一次。
  assert.equal(newFindings([], [after[1], { ...after[1], line: 40 }]).length, 1);
  // baseline 为空（没抓到）时全部都算新的——这是调用方按 ran:false 决定要不要用的前提。
  assert.equal(newFindings([], after).length, 2);
});

test("阻断正文有界，且说清这是项目自己的规则", () => {
  assert.equal(lintReport("eslint", []), "", "没有 finding 时不发块");
  const many = Array.from({ length: 30 }, (_, i) => ({ rel: "a.ts", line: i, rule: "r", message: `m${i}` }));
  const text = lintReport("eslint", many);
  assert.ok(text.includes("还有 10 条同类"), "没有截断——三十条错误糊进上下文");
  assert.ok(text.includes("项目自己的规则"),
    "没说清规则来源，模型会以为是 harness 强加的口味，然后去改 lint 配置绕过它");
});

test("「没跑成」和「跑了、干干净净」必须可分——这是整块最容易静默失效的地方", () => {
  // `npx --no-install eslint` 在没装 eslint 的项目里：正常启动、非零退出、stdout 空、
  // stderr 是 npm 的报错。进程跑起来了，所以没有 note；解析器拿到空串返回空数组。
  // 少了 lintRan 这一层，它就等于「零错误，干干净净」——用户以为写时检查在保护他。
  assert.equal(
    lintRan("eslint", { code: 1, stdout: "", stderr: "npm error npx canceled due to missing packages" }),
    false,
    "没装 eslint 被读成「零错误」了",
  );
  assert.equal(lintRan("eslint", { code: 0, stdout: "[]", stderr: "" }), true, "真跑过、真干净");
  assert.equal(lintRan("eslint", { code: 1, stdout: '[{"filePath":"a.js","messages":[]}]' }), true,
    "有合法 JSON 就是跑过了，退出码非零只说明它发现了问题");
  assert.equal(lintRan("eslint", { code: 1, stdout: "Cannot find module 'eslint'" }), false,
    "输出不是 JSON = 没跑成");

  // go vet：退出码 0 就是干净；非零但一条都解析不出来，说明是工具自己出错。
  assert.equal(lintRan("go-vet", { code: 0, stdout: "", stderr: "" }), true);
  assert.equal(lintRan("go-vet", { code: 1, stdout: "", stderr: "go: cannot find main module" }), false,
    "工具自己出错被当成「代码有问题」了");
  assert.equal(lintRan("go-vet", { code: 1, stdout: "", stderr: "a.go:7:2: Printf format %d has arg s of wrong type string" }), true);
});

test("诊断可能在 stderr——只读 stdout 的话 go vet 永远报告零问题", () => {
  const out = { code: 1, stdout: "", stderr: "cmd/main.go:7:2: Printf format %d has arg s of wrong type string" };
  const findings = lintFindings("go-vet", out);
  assert.equal(findings.length, 1, "stderr 里的诊断被丢了");
  assert.equal(findings[0].line, 7);
  // stdout 里有东西时以 stdout 为准（JSON 类都写 stdout）。
  assert.equal(lintFindings("eslint", {
    stdout: JSON.stringify([{ filePath: "a.ts", messages: [{ severity: 2, line: 1, ruleId: "r", message: "m" }] }]),
    stderr: "some warning noise",
  }).length, 1);
});

// ── 真的跑一遍 ───────────────────────────────────────────────────────────────
// 解析器是照着输出格式写的。格式在版本之间会变，而变了之后解析恒返回空数组、
// 整道门静默失效、测试全绿——正是这个仓库反复踩的那类坑。所以这一条真起一个进程。
const eslintAvailable = (() => {
  const probe = spawnSync("npx", ["--no-install", "eslint", "--version"], { encoding: "utf8", timeout: 60_000 });
  return probe.status === 0 && /\d+\./.test(String(probe.stdout || ""));
})();

test("真跑一次 eslint，解析器读得懂它今天的输出", { skip: !eslintAvailable && "本机没有 eslint（跳过，不是通过）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mrday-lint-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "eslint.config.js"),
      'export default [{ files: ["**/*.js"], rules: { eqeqeq: "error", "no-unused-vars": "warn" } }];\n');
    writeFileSync(join(dir, "package.json"), '{"name":"t","type":"module"}\n');
    // eqeqeq 是 error，no-unused-vars 是 warn —— 正好验证「只取 error」。
    writeFileSync(join(dir, "src/a.js"), 'const unused = 1;\nexport const f = (a, b) => a == b;\n');

    const linter = detectLinter(new Set(["eslint.config.js", "package.json"]), null)[0];
    assert.equal(linter.id, "eslint");
    const cmd = lintCommand(linter, ["src/a.js"]);
    const out = spawnSync(cmd.program, cmd.args, { cwd: dir, encoding: "utf8", timeout: 120_000 });

    const findings = parseLintErrors("eslint", out.stdout);
    assert.equal(findings.length, 1,
      `解析器读不懂 eslint 今天的输出（拿到 ${findings.length} 条）。原始输出：\n${out.stdout}\n${out.stderr}`);
    assert.equal(findings[0].rule, "eqeqeq");
    assert.equal(findings[0].line, 2);
    assert.ok(findings[0].rel.endsWith("src/a.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const goAvailable = spawnSync("go", ["version"], { encoding: "utf8", timeout: 60_000 }).status === 0;

test("真跑一次 go vet，解析器读得懂它今天的输出", { skip: !goAvailable && "本机没有 go（跳过，不是通过）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mrday-vet-"));
  try {
    mkdirSync(join(dir, "cmd"), { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/t\n\ngo 1.21\n");
    // 这段**编译得过、类型也对**，只有 vet 认得出 %d 配了个 string ——
    // 正是「语法和类型那条腿看不见的那一类」。
    writeFileSync(join(dir, "cmd/main.go"),
      'package main\n\nimport "fmt"\n\nfunc main() {\n\ts := "x"\n\tfmt.Printf("%d\\n", s)\n}\n');

    const linter = detectLinter(new Set(["go.mod"]), null)[0];
    assert.equal(linter.id, "go-vet");
    const cmd = lintCommand(linter, ["cmd/main.go"]);
    const out = spawnSync(cmd.program, cmd.args, { cwd: dir, encoding: "utf8", timeout: 180_000 });
    // go vet 把诊断写在 stderr。
    const findings = parseLintErrors("go-vet", `${out.stdout}\n${out.stderr}`);
    assert.ok(findings.length >= 1,
      `解析器读不懂 go vet 今天的输出。原始：\n${out.stdout}\n${out.stderr}`);
    const hit = findings.find((f) => /Printf|format/i.test(f.message));
    assert.ok(hit, `没抓到那条格式串错误：${JSON.stringify(findings)}`);
    assert.ok(hit.rel.endsWith("main.go"));
    assert.equal(hit.line, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 接线 ─────────────────────────────────────────────────────────────────────
test("这条腿真的接在那道阻断门上，而不是算完就扔", () => {
  const loop = fnSource("_runAgenticLoop", { code: true });
  assert.ok(loop.includes("_projectLintFindings("),
    "循环里根本没调用项目 linter —— 模块写了没人用");
  assert.match(loop, /run\._diagnosticBlock\s*=\s*_noProgressLint\s*<\s*2\s*\?\s*_lintReportText/,
    "lint 结果没进 _diagnosticBlock —— 那是收尾门唯一会读的地方，不进去就是只写不读");
  // **自己的收敛计数。** 共用诊断那条腿的 _noProgressVerify 是恒真的：
  // 「类型干净」正是走进 lint 分支的前提，而那个计数器每轮都在 _errNow===0 里被重置成 0。
  assert.ok(loop.includes("_noProgressLint++"), "lint 这条腿没有自己的收敛计数，那道界结构上不存在");
  assert.ok(!/_noProgressVerify\s*<\s*2\s*\?\s*_lintReportText/.test(loop),
    "又用回了诊断那条腿的计数器 —— 它在这条路上恒等于 0");
  assert.ok(loop.includes("[BLOCKING_NEW_DIAGNOSTICS]"),
    "没有推给模型的阻断提示");

  // baseline 必须在**改动之前**抓：抓晚了，仓库里原有的问题会被算成模型引入的，
  // 门一开就永远关不上。
  const before = loop.indexOf("_projectLintFindings(_lintTargets, root, null)");
  const after = loop.indexOf("_projectLintFindings([...run._diagnosticCheckPaths]");
  assert.ok(before > 0, "没有在改动前抓 baseline");
  // baseline 有**自己的**已抓集合。和诊断那条共用的话：上面那个 filter 是无条件
  // add(key) 的，而 lint baseline 可能失败（没装 linter / 超时 / 版本不对）——
  // 失败时这批路径已被标记「抓过」，此后再不重试，仓库原有的 lint 错会被永久算成
  // 模型新引入的，门一开就再也关不上。
  assert.ok(loop.includes("run._lintBaselinePaths"),
    "lint baseline 没有独立的已抓集合 —— 抓失败一次就再也不重试");
  const markAt = loop.indexOf("run._lintBaselinePaths.add");
  const ranAt = loop.indexOf("if (_lintBase.ran)");
  assert.ok(ranAt > 0 && markAt > ranAt, "没抓到也标记成「抓过」了");
  assert.ok(after > before, "两次调用的先后顺序反了");

  // 「配了却跑不起来」必须如实说出去，不能静默当成零问题。
  assert.ok(SRC.includes("lintless:"), "没跑成时没有任何事实交代 —— 会被当成「零错误」");
  // 这两层在执行那一侧（_projectLintFindings），不在循环里。
  const exec = fnSource("_projectLintFindings", { code: true });
  assert.ok(exec.includes("_lintRan(linter.id, out)"),
    "少了这一层，npx 找不到 eslint 的非零退出会被读成「零错误、干干净净」");
  assert.ok(exec.includes("_lintFindings(linter.id, out)"),
    "只读 stdout 的话 go vet 永远报告零问题（它的诊断在 stderr）");
});

// ── 调用点必须把 root 传进来，否则模块里那段防护是在空转 ────────────────────
//
// `lintCommand(linter, relPaths, root)` 里 `_relativeTo` 专门防「传进来的是绝对路径」：
// 阻断门那次调用喂的就是 `_resolvedPath`。而 go vet 吃的是**包模式**，
// `./` + 绝对路径 = `.//Users/…/…`，go 直接报 lstat 失败 —— 整条项目 linter 腿
// 在所有 Go 仓库上恒不可用，而且失败长得像「跑了、没问题」。
//
// 这一条守两头：模块里的归一化真的有效，以及 main.js 真的把 root 传下去了。
test("go vet 拿到的是仓库相对包路径，不是 .//绝对路径", () => {
  const linter = { id: "go-vet", langs: new Set(["go"]) };
  const abs = "/Users/michael/proj/pkg/svc/handler.go";
  const withRoot = lintCommand(linter, [abs], "/Users/michael/proj");
  assert.deepEqual(withRoot.args, ["vet", "./pkg/svc/..."]);
  // 对照：不传 root 就是那个坏掉的形状 —— 留着它，说明这条断言守的是真东西
  const noRoot = lintCommand(linter, [abs]);
  assert.match(noRoot.args[1], /^\.\/\//, "对照组失效了：不传 root 现在也是对的？那这条守卫就没有对象了");
  // 相对路径本来就对，加了归一化也不能弄坏
  assert.deepEqual(lintCommand(linter, ["pkg/svc/handler.go"], "/Users/michael/proj").args,
    ["vet", "./pkg/svc/..."]);
  // 仓库根目录下的文件 → ./...
  assert.deepEqual(lintCommand(linter, ["/Users/michael/proj/main.go"], "/Users/michael/proj").args,
    ["vet", "./..."]);
});

test("main.js 的调用点真的把 root 传下去了——少这一个参数，上面那段归一化就是空转", () => {
  assert.match(MAIN_SRC, /const cmd = _lintCommand\(linter, files, root\);/,
    "_lintCommand 的调用点没传 root —— go vet 会拿到 .//绝对路径，整条腿在 Go 仓库上恒不可用");
});
