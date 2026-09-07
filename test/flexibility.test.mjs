// 灵活度：哪些命令该被"这是长驻服务"拦下、哪些不该。
//
// 拦错的代价是双向的，而且都很贵：
//   · 过宽 —— `cat scripts/serve.md`、`git log --grep=serve`、`npx vitest run --watch=false`
//     被当成 dev server 拒掉，模型收到的还是一句与事实相反的「它不会返回」，只能瞎改命令，
//     一轮白烧。这类误伤在日常开发里遍地都是。
//   · 过窄 —— 裸 `vite`、`jest --watch` 这种真的会挂住的命令漏过去，前台跑起来就卡死整个回合。
//
// 老判据是拿一张词表扫整条命令字符串，两头都占了：既拦了一堆无辜命令，又漏了真服务。
// 现在按**每一段的段首命令**判断——决定会不会挂住的是跑的哪个程序，不是命令行里出现过哪个词。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `SRC` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as SRC, SRC as RAW_SRC } from "./helpers/source.mjs";

function loadPredicate() {
  const at = RAW_SRC.indexOf("function _commandStartsLongRunningServer(");
  assert.ok(at > 0, "找不到 _commandStartsLongRunningServer");
  const end = RAW_SRC.indexOf("\n}\n", at);
  assert.ok(end > at, "函数没有行首收尾大括号");
  const declsAt = RAW_SRC.indexOf("const _LONG_RUNNING_HEADS");
  assert.ok(declsAt > 0 && declsAt < at, "找不到常量表");
  return new Function(
    SRC.slice(declsAt, at) + SRC.slice(at, end + 2) + "\n;return _commandStartsLongRunningServer;",
  )();
}

const isServer = loadPredicate();

// —— 必须放行：这些只是名字里带了 serve/watch，跑完就退出 ——
const MUST_PASS = [
  ["测试跑一次就退出", "npx vitest run --watch=false"],
  ["显式关掉 watch", "npm test -- --watch=false"],
  ["搜索 watch 这个词", 'grep -rn "watch" src/'],
  ["读一个叫 serve 的文档", "cat scripts/serve.md"],
  ["按文件名搜 serve", "rg serve --files-with-matches"],
  ["构建时明确不 watch", "node build.js --no-watch"],
  ["在提交信息里搜 serve", "git log --grep=serve"],
  ["普通串联命令", "ls && echo done"],
  ["装依赖", "npm install"],
  ["跑测试", "npm test"],
  ["构建", "npm run build"],
  ["类型检查", "npx tsc --noEmit"],
  ["查看 package.json 里的 dev 脚本", "cat package.json | grep dev"],
];

// —— 必须拦住：这些跑起来不会自己退出 ——
const MUST_BLOCK = [
  ["npm dev 脚本", "npm run dev"],
  ["裸 vite（老判据漏掉的）", "vite"],
  ["jest watch（老判据漏掉的）", "jest --watch"],
  ["python 内置服务器", "python -m http.server 8000"],
  ["uvicorn", "uvicorn app:main"],
  ["yarn start", "yarn start"],
  ["带环境变量前缀", "PORT=3000 npm run dev"],
  ["nodemon", "nodemon index.js"],
  ["npx next dev", "npx next dev"],
  ["带路径前缀的可执行文件", "./node_modules/.bin/vite"],
  ["先 cd 再起服务", "cd app && npm start"],
  ["django runserver", "python manage.py runserver"],
  ["gunicorn", "gunicorn wsgi:app"],
];

for (const [what, cmd] of MUST_PASS) {
  test(`放行：${what}`, () => {
    assert.equal(isServer(cmd), false,
      `\`${cmd}\` 跑完就退出，拦下来只会让模型收到一句与事实相反的解释，白烧一轮`);
  });
}

for (const [what, cmd] of MUST_BLOCK) {
  test(`拦住：${what}`, () => {
    assert.equal(isServer(cmd), true,
      `\`${cmd}\` 不会自己退出，放进前台会卡死整个回合`);
  });
}

test("空输入不炸", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(isServer(v), false);
});

test("判据不再是扫整条命令字符串", () => {
  const at = RAW_SRC.indexOf("function _commandStartsLongRunningServer(");
  const body = SRC.slice(at, RAW_SRC.indexOf("\n}\n", at));
  assert.match(body, /split\(/, "必须按段切开再看段首");
  // 老写法的特征：一条含 serve|watch 的大正则直接 .test(整条命令)
  assert.doesNotMatch(body, /\(serve\|watch\|/,
    "不能再用词表扫整串——那既拦无辜命令又漏真服务");
});

// —— 等待期间必须说清在等什么 ——

test("请求已发出但上游还没开口时，界面要说明在等首字节", () => {
  // 「请求发出、还没收到第一个字节」和「正在接收内容」此前显示成一模一样的跑秒表。
  // 用户于是以为首字节已经到了、界面卡着不画，实际是上游还没开口——有些中转不做流式
  // 转发，要等整段生成完才发第一个字节，那段时间本来就没有任何内容可显示。
  // 两种状态长得一样，就没法判断该等还是该重试。
  const at = RAW_SRC.indexOf("function _turnStatsText(");
  assert.ok(at > 0, "找不到 _turnStatsText");
  const fn = SRC.slice(at, RAW_SRC.indexOf("\n}\n", at));
  assert.match(fn, /live/, "实时统计要能区分 live 与收尾");
  // 「等待上游首字节」那句 2026-09-07 按所有者要求撤掉；「接收中」留着。
  assert.doesNotMatch(fn, /等待上游首字节/, "那句话所有者要求撤掉，别加回来");
  assert.match(fn, /接收中/, "已经开始收但还没画出来时要说明在接收");
  assert.ok(RAW_SRC.indexOf("live: true,") > 0, "实时统计必须以 live 模式渲染");
});
