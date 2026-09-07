import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";

// find_files 整棵子树跳过 20 个构建/依赖目录。原来这件事既没有结构化字段也没有文案，
// 而零命中那句还反过来断言「已完整遍历，确实不存在」—— 扫都没扫的地方被说成确认不存在。
// 这是「静默假话」里最典型的一种：返回值和真相无法区分。
const findFiles = (entries) => load("_agentFindFiles", {
  backend: { readDir: async (dir) => entries[dir] || [] },
  _agentDirEntryName: (e) => e.name,
  _agentDirEntryIsDir: (e) => !!e.dir,
  _globToRegExp: (p) => new RegExp("^" + p.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*") + "$"),
});

const tree = {
  "/w": [{ name: "src", dir: true }, { name: "node_modules", dir: true }, { name: "dist", dir: true }, { name: "readme.md" }],
  "/w/src": [{ name: "a.ts" }],
  "/w/node_modules": [{ name: "lib.ts" }],
  "/w/dist": [{ name: "bundle.js" }],
};

test("零命中时不许再说「已完整遍历，确实不存在」", async () => {
  const r = await findFiles(tree)("/w", "**/*.py");
  assert.equal(r.count, 0);
  assert.doesNotMatch(r.text, /已完整遍历，确实不存在/,
    "整棵子树被跳过，却断言「确认不存在」——扫都没扫");
  assert.match(r.text, /跳过/);
  assert.match(r.text, /node_modules/, "没点名跳过了什么，模型无从判断这个「没有」算不算数");
  assert.match(r.text, /dist/);
});

test("pattern 点名了被跳目录，当场就要说", async () => {
  // 模型找构建产物：find_files("dist/**/*.js") 回「无匹配」，它会据此认定产物没生成。
  const r = await findFiles(tree)("/w", "dist/**/*.js");
  assert.match(r.text, /pattern 里点名的/);
  assert.match(r.text, /默认跳过/);
  assert.match(r.text, /list_dir/, "要指一条真能看到那些文件的路");
});

test("被跳过的目录进结构化字段，不只是文案", async () => {
  const r = await findFiles(tree)("/w", "**/*.py");
  assert.ok(Array.isArray(r.skipped), "skipped 字段没有——下游只能去解析文案");
  assert.deepEqual([...r.skipped].sort(), ["dist", "node_modules"]);
});

test("真的完整走完时，那句「确实不存在」照旧", async () => {
  const clean = { "/w": [{ name: "src", dir: true }], "/w/src": [{ name: "a.ts" }] };
  const r = await findFiles(clean)("/w", "**/*.py");
  assert.equal(r.count, 0);
  assert.match(r.text, /已完整遍历，确实不存在/, "没有目录被跳过时这句是真的，不该被顺手删掉");
  assert.deepEqual(r.skipped, []);
});

test("有命中时不拿跳过的事去刷屏", async () => {
  const r = await findFiles(tree)("/w", "**/*.ts");
  assert.deepEqual(r.files, ["src/a.ts"]);
  // 正则要对得上真实文案（中间隔着 ** 强调符）。写成 /跳过了这些构建/ 是恒真的——
  // 它匹配不到任何东西，等于这条断言从来没守过。
  assert.doesNotMatch(r.text, /跳过了\*\*这些构建/, "命中了还念一遍跳过名单，等于每次调用都多一段噪音");
  assert.doesNotMatch(r.text, /node_modules/);
});

test("两份工具目录都写明了这件事（网关那份运行时说了算）", () => {
  assert.match(CODE, /Build and dependency directories are skipped entirely/);
});
