import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/source.mjs";

// 收尾时「模型自己没跑验证，IDE 替它跑一次」那道 hook，探不到命令就静默 return，
// 一个字都不说，整轮零自动正确性检查。近 7 天 152 个动过代码的 run 里有 29 个（19%）
// 整轮一条命令都没跑过——那些 run 里这道 hook 是唯一的门。
//
// 而它原来三条腿**全部只看运行根一层**。用户打开的常常是装着项目的那个上层文件夹：
// 实测 30 个真实运行根里 19 个（63%）在根这层三条腿全空，其中 6 个只要下探一层就能探到。
//
// 下面钉的是这次改动的三个判据：探得到、不乱猜、以及目录名要能带中文。

/** 造一棵假树：files 是「相对路径 → 内容」，dirs 是「目录 → 子条目名」。 */
const build = (files, dirs, { isWin = false } = {}) =>
  load("_detectVerifyCmdRaw", {
    _projectStacks: new Map(),
    _verificationCommandsForStack: () => [],
    _isWin: isWin,
    _PY_COMPILE_SKIP: "-x 'SKIP'",
    _AGENT_CONTEXT_SKIP_DIRS: new Set(["node_modules", ".git", "dist", "target"]),
    _agentDirEntryName: (e) => e.name,
    _agentDirEntryIsDir: (e) => !!e.isDir,
    backend: {
      readTextFile: async (p) => {
        const key = String(p).replace(/^\/w\/?/, "");
        if (files[key] === undefined) throw new Error("no such file");
        return files[key];
      },
      readDir: async (d) => {
        const key = String(d).replace(/^\/w\/?/, "") || ".";
        if (dirs[key] === undefined) throw new Error("no such dir");
        return dirs[key];
      },
    },
  });

const PKG = JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } });

test("根这层探不到，就往下探一层", async () => {
  // 根下只有一个 web/ 子目录，项目本体在里面——这正是「打开了装项目的文件夹」那个形状。
  const detect = build(
    { "web/package.json": PKG },
    { ".": [{ name: "web", isDir: true }, { name: "README.md", isDir: false }] },
  );
  const cmd = await detect("/w");
  assert.ok(cmd, "根这层空，下探一层也没探到——那这一轮就是零自动检查");
  assert.match(cmd, /^cd "web" && /, "命令没有先切到子目录");
  assert.match(cmd, /npm run build|npm test/, "没用上子目录 package.json 里的脚本");
});

test("子目录名带中文时必须加引号——不加会被整条判成「不是验证命令」", async () => {
  const detect = build(
    { "逆水寒-自动化脚本/package.json": PKG },
    { ".": [{ name: "逆水寒-自动化脚本", isDir: true }] },
  );
  const cmd = await detect("/w");
  assert.match(cmd, /^cd "逆水寒-自动化脚本" && /, "中文目录名没加引号");
  // 和 _looksLikeVerificationCommand 里剥前导 cd 的那个正则对一遍：它只认引号形式或
  // 纯 ASCII 路径，不加引号的中文会让整条命令拿不到验证学分，等于白跑。
  const stripper = /^cd\s+(?:"[^"]*"|'[^']*'|[\w./~@:+-]+)$/i;
  assert.ok(stripper.test(cmd.split(/\s*&&\s*/)[0].trim()),
    "生成的 cd 段过不了 _looksLikeVerificationCommand 那道剥离");
});

test("两个子目录都能探到就放弃，不猜", async () => {
  // monorepo 或者「一个文件夹里放了好几个项目」：猜哪个都可能猜错，不如不猜。
  const detect = build(
    { "web/package.json": PKG, "api/package.json": PKG },
    { ".": [{ name: "web", isDir: true }, { name: "api", isDir: true }] },
  );
  assert.equal(await detect("/w"), null, "命中多个还硬选了一个");
});

test("根这层探到了就不再往下看", async () => {
  const detect = build(
    { "package.json": PKG, "web/package.json": PKG },
    { ".": [{ name: "web", isDir: true }] },
  );
  const cmd = await detect("/w");
  assert.doesNotMatch(cmd, /^cd /, "根上明明有项目，却切到子目录去了");
});

test("隐藏目录和 node_modules 不参与下探", async () => {
  const detect = build(
    { "node_modules/pkg/package.json": PKG, ".cache/package.json": PKG },
    { ".": [{ name: "node_modules", isDir: true }, { name: ".cache", isDir: true }] },
  );
  assert.equal(await detect("/w"), null, "把依赖目录或隐藏目录当成项目了");
});

test("根下有 .venv 但 manifest 在子目录：venv 那条腿要够得着", async () => {
  // 原来四个 venv 探测嵌在 `if (pyproject || requirements.txt || setup.py)` 的花括号
  // 里面，根下有 .venv 而 manifest 在下一层时连进都进不去。实测 30 个真实根里 3 个是这形状。
  const detect = build(
    { ".venv/bin/python": "", ".venv/bin/pytest": "" },
    { ".": [] },
  );
  const cmd = await detect("/w");
  assert.match(cmd, /\.venv\/bin\/pytest -q/, "根下的虚拟环境没被用上");
});

test("compileall 兜底必须带排除清单，否则会被反编译垃圾拖成恒红", async () => {
  const detect = build({ "requirements.txt": "flask\n" }, { ".": [] });
  const cmd = await detect("/w");
  assert.match(cmd, /python3 -m compileall -q -x 'SKIP' \./, "兜底命令没带排除清单");
});
