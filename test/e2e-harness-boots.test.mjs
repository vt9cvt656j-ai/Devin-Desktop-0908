// e2e 台子不许再悄悄烂掉。
//
// 那个台子（test/e2e/）跑的是**真执行器 + 真磁盘**，而它被刻意排除在 `npm test` 之外
// ——它会 spawn("/bin/sh") 真跑命令，不适合进常规套件（原因写在 scripts/run-tests.mjs 顶部）。
// 代价是：它坏了没人知道。实际就发生了 —— main.js 后来加了五个 .jsx 导入，
// 而台子的桩里**写死了一个文件名**，于是它 ERR_UNKNOWN_FILE_EXTENSION 起不来，
// 而 `npm test` 一直全绿。同一个形状（手工维护的清单跟不上代码）这个仓库踩过好几次。
//
// 桩已经改成从真文件现读导出名、按后缀通配，所以那条腿不会再断。这个文件守的是
// **别再退回写死清单**，而且它不 spawn 任何东西，可以待在常规套件里。
//
// 完整的台子用 `npm run test:e2e` 跑（run3 就是「一项抛异常时批次还完不完整」那条，
// 按 test/E2E-HARNESS-SPEC.md 的规矩，智能体循环的改动要在那儿验，不是在单测里）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDE = join(HERE, "..");
const MAIN = join(IDE, "src", "main.js");

test("台子的三个入口都还在", () => {
  for (const f of ["run1.mjs", "run2.mjs", "run3.mjs", "run4.mjs", "hooks.mjs", "globals.mjs"]) {
    assert.ok(existsSync(join(HERE, "e2e", f)), `test/e2e/${f} 不见了`);
  }
});

test("main.js 的每一个 .jsx 导入，台子都解析得掉", async () => {
  const src = readFileSync(MAIN, "utf8");
  const jsx = [...src.matchAll(/^import\s+(?:[^"']*\s+from\s+)?["'](\.\/ui\/[^"']+\.jsx)["']/gm)].map((m) => m[1]);
  assert.ok(jsx.length >= 5, `只找到 ${jsx.length} 个 .jsx 导入，正则可能失配了`);
  const { resolve } = await import(pathToFileURL(join(HERE, "e2e", "hooks.mjs")).href);
  const parentURL = pathToFileURL(MAIN).href;
  for (const spec of jsx) {
    const r = await resolve(spec, { parentURL }, () => { throw new Error("落到了 next()：说明台子没桩住它"); });
    assert.match(r.url, /^stub:jsx:/, `${spec} 没被桩住——台子会 ERR_UNKNOWN_FILE_EXTENSION 起不来`);
  }
});

test("循环本体和模型轮替换口必须一直接得出来", async () => {
  // run4（循环测试台）全靠这两个：没有 _runAgenticLoop 就跑不了循环，
  // 没有 setModelTurn 就只能真发请求——要钱、非确定、还没法构造剧本。
  // 它们是 loader 往 main.js 尾部追加的，很容易在重构时被顺手删掉。
  const hooks = readFileSync(join(HERE, "e2e", "hooks.mjs"), "utf8");
  assert.match(hooks, /_runAgenticLoop/, "循环本体没被接出来，run4 会直接不可用");
  assert.match(hooks, /setModelTurn: \(fn\) => \{ _agentModelTurn = fn; \}/,
    "模型轮替换口没了：循环测试台只能真发请求");
});

test("桩是从真文件读导出名的，不是写死的名单", async () => {
  const hooks = readFileSync(join(HERE, "e2e", "hooks.mjs"), "utf8");
  // 写死单个文件名那种写法正是它烂掉的原因，别退回去。
  assert.doesNotMatch(hooks, /spec === "\.\/ui\/[^"]+\.jsx"/,
    "桩又退回写死文件名了：main.js 下次再加一个 .jsx，台子就又起不来");
  assert.match(hooks, /\/\\\.jsx\$\/\.test\(spec\)/, "缺按后缀通配的那条");
});

test("具名导出真的会被桩出来——ESM 链接期就要求名字存在", async () => {
  const { load } = await import(pathToFileURL(join(HERE, "e2e", "hooks.mjs")).href);
  const target = join(IDE, "src", "ui", "mount-slash-menu.jsx");
  assert.ok(existsSync(target), "样本文件不在了，换一个");
  const out = await load("stub:jsx:" + pathToFileURL(target).href, {}, () => { throw new Error("不该走 next"); });
  // main.js 从它 destructure 这两个名字；桩里没有的话，链接期直接报缺名字。
  for (const name of ["renderSlashMenu", "destroySlashMenu"]) {
    assert.ok(out.source.includes(`export function ${name}()`), `桩里缺 ${name}`);
  }
  assert.ok(!out.source.includes("export default"), "真文件没有默认导出，桩也不该凭空造一个");
});
