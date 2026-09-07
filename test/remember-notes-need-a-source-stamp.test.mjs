import test from "node:test";
import assert from "node:assert/strict";
import { CODE, SRC } from "./helpers/source.mjs";

// 模型用 remember 给自己记的笔记（"读不到就用 X"这类）和用户亲口说的规矩，在记忆块里
// 长得一模一样 —— 而全局那块的标题原来还写着"用户级：身份/偏好/通用经验"。
// 于是模型把自己写的东西当成用户的偏好，每一轮都带上、每一轮都遵守。
// 自动归纳那条路早就有 _KG_INFERRED 戳了，remember 这条一直漏着。

test("remember 写进去的带来源戳", () => {
  assert.match(CODE, /const _KG_RECORDED = "\[运行中记下\]";/);
  assert.match(CODE, /_kgAddNote\(isGlobal \? "" : root, `\$\{_KG_RECORDED\} ` \+ call\.content\)/,
    "remember 还是不带戳落库 —— 模型自己的笔记和用户的规矩仍然分不开");
  assert.doesNotMatch(CODE, /const ok = _kgAddNote\(isGlobal \? "" : root, call\.content\);/,
    "旧的无戳写入还在");
});

test("戳记的是「怎么进来的」，不是「谁想出来的」", () => {
  // 用户说"记住X"和模型自己决定记，调用形状完全一样 —— 从调用分辨不出作者。
  // 所以戳只能陈述可知的事实：它是运行中经 remember 落进来的。
  // 断言的是注释本身，所以要用带注释的 SRC（CODE 是剥过的）。
  const at = SRC.indexOf('const _KG_RECORDED');
  const around = SRC.slice(Math.max(0, at - 900), at);
  assert.match(around, /不是"谁想出来的"|不是「谁想出来的」/,
    "注释没写清这个戳的语义边界，下一个人会当成作者标记");
});

test("全局记忆的标题不再谎称「用户级」", () => {
  assert.doesNotMatch(CODE, /全局记忆（跨所有项目·用户级：身份\/偏好\/通用经验/,
    "标题还在把模型自己的笔记称作用户级偏好");
  assert.match(CODE, /既有用户亲口交代的，也有你自己在运行中用 remember 记下的/,
    "标题没说清里面混着两种来源");
  assert.match(CODE, /带戳的是你自己的笔记，不是用户的规矩，权重要分开/,
    "说了混着两种，却没说怎么区分——等于没给判据");
});

test("项目记忆那条标题本来就是诚实的，别顺手改坏", () => {
  assert.match(CODE, /项目记忆（你之前用 remember 记的，跨会话保留）/);
});

test("自动归纳那条戳原样保留——这次是补 remember，不是改它", () => {
  assert.match(CODE, /const _KG_INFERRED = "\[据本轮归纳\]";/);
  assert.match(CODE, /_kgAddNote\(scopeRoot, `\$\{_KG_INFERRED\} ` \+ content\)/);
});
