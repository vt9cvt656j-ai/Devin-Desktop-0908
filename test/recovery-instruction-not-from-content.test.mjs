// 喂给模型的那条「这次失败了、别重复调用」不能由**正文内容**触发。
//
// 判据在这个文件里有两处实现，此前只修了一处：
//   · `_toolExecutionSucceeded` —— 系统内部用（推进计划、记执行事实）。它早就为
//     read/search/logs/termread/knowledge 五类改用**只看首行**的判据，注释里记着实测：
//     一句 markdown 链接 `[Error handling](…)` 就会让一次成功的检索被判失败。
//   · `_blockedToolRecoveryInstruction` —— **把文字真正写进模型上下文的那一半**。
//     它仍是全文正则，且被 `_toolMsgForModel` 对所有工具无差别调用，把 `[RECOVERY:…]`
//     拼在 role:"tool" 消息末尾。
//
// 于是同一条结果内部算「成功」，喂给模型的却是「这次失败了，别在没有新证据时重复
// 同一个工具调用」。一次读得好好的文件、一次命中的检索，被明确告知失败且不要重试。
//
// **只放宽那五类。** git / browser / write 那批喂进来的是已格式化文本，全局锚定会让真
// 失败漏判 —— 隔壁有一条测试正是用 git 反向钉死这件事的（test/logic.test.mjs 里
// 「只放宽 read/search，不许顺手放宽别人」那条）。

import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/source.mjs";

// _CAPABILITY_ROUTES 是一大段常量文本，恢复指示里插值用；这里只关心判据，给个占位。
const recover = load("_blockedToolRecoveryInstruction", {
  _toolFailureMarkerAtHead: load("_toolFailureMarkerAtHead"),
  _CAPABILITY_ROUTES: "（能力路线占位）",
});
const flagged = (type, content) => !!recover(content, { type }, { type, content });

test("内容投递型工具：正文里的 [ERROR] 不许触发恢复指示", () => {
  assert.equal(flagged("read", 'import x;\nconsole.error("[ERROR] connect failed");\n'), false,
    "读到源码里的 [ERROR] 行就被告知「这次失败了、别重复调用」");
  assert.equal(flagged("knowledge", "参见 [Error handling](https://x/y) 一节。"), false,
    "一句 markdown 链接让成功的检索被判失败 —— 注释里点名的那个事故");
  assert.equal(flagged("search", 'src/a.ts:12: log("[ERROR] x")'), false,
    "搜 error 这件事本身会把标记捞进正文，于是搜索自己判自己失败");
  assert.equal(flagged("logs", "12:00 [ERROR] upstream 503\n12:01 [INFO] recovered"), false,
    "read_logs 的唯一用途就是取回含错误的日志，按正文判会死循环");
  assert.equal(flagged("termread", "$ npm test\n[ERROR] 1 failing\n"), false);
});

test("这五类的真失败一条都不能漏 —— harness 的失败回执一律首行带标记", () => {
  for (const [type, body] of [
    ["read", "[ERROR] read_file 需要 path 参数。"],
    ["read", "[ERROR/AMBIGUOUS_PATH] 路径不唯一"],
    ["search", "[不可用] 未打开工作区，无法搜索。"],
    ["knowledge", "[失败] 检索链路异常"],
    ["logs", "[BLOCKED] 用户拒绝了这次调用"],
  ]) {
    assert.equal(flagged(type, body), true, `真失败被漏了：${type} / ${body}`);
  }
});

test("**不许顺手放宽别人** —— git/write/browser 仍按全文判", () => {
  // 这正是隔壁那条测试用 git 反向钉死的东西：那批喂进来的是已格式化文本，
  // 全局锚定会让真失败漏判。
  assert.equal(flagged("git", "前面正常\n[ERROR] 后面炸了"), true,
    "git 被顺手放宽了 —— 它的真失败会漏判");
  assert.equal(flagged("write", "正常\n[BLOCKED] 权限问题"), true);
  assert.equal(flagged("cmd", "编译中\n[失败] 链接错误"), true);
});

test("干净的成功回执一个字都不该多说", () => {
  assert.equal(flagged("edit", "已修改 src/log.ts（+1/-1 行）。"), false);
  assert.equal(flagged("read", "export const a = 1;\n"), false);
});
