import test from "node:test";
import assert from "node:assert/strict";
import { CODE, blockFrom } from "./helpers/source.mjs";

// 子智能体里的 run_cmd 原来恒用 60s 超时，模型声明的 timeout_secs 被**整个无视**；
// 而同一份 schema 的工具描述告诉它「上限 600s」「被杀了别改用 run_in_terminal」——
// 那两条在子体里都是假的（run_in_terminal 根本不在子体的工具集里）。
// 上限本身是对的（一条命令不许吃掉子体 5 分钟总预算），错的是**静默钳位**。
const seg = () => blockFrom('if (call.type === "cmd") {', { code: true, nth: 0 });

test("声明的 timeout_secs 参与计算，不再被无视", () => {
  assert.match(CODE, /const _askSecs = Number\(call\.timeoutSecs\) > 0 \? Math\.floor\(Number\(call\.timeoutSecs\)\) : 0;/,
    "又变回不看模型声明了");
  assert.match(CODE, /const _useSecs = Math\.min\(_askSecs \|\| 60, 60\);/,
    "上限没了——一条命令能吃掉子体的整个预算");
  assert.match(CODE, /setTimeout\([\s\S]{0,400}?\}\), _useSecs \* 1000\)/,
    "算出来了却没用上，定时器还是写死的");
});

test("钳位必须出声，且给的出路是子体真有的", () => {
  assert.match(CODE, /你声明的 timeout_secs=\$\{_askSecs\}s 被子智能体的单条命令上限钳到了/,
    "静默钳位——模型据此以为自己拿到了 600s");
  assert.match(CODE, /交回主智能体去跑，那边没有这条上限/,
    "没给出路，或者给的是 run_in_terminal（子体根本没有这个工具）");
  // 反面：别在这里教它用一个自己没有的工具
  const body = CODE.slice(CODE.indexOf("_clampNote"), CODE.indexOf("_clampNote") + 700);
  assert.doesNotMatch(body, /run_in_terminal/, "又把它指向一个子体里不存在的工具");
});

test("没超上限时不加那段话", () => {
  assert.match(CODE, /_askSecs > _useSecs\s*\n?\s*\? `（你声明的/,
    "无条件加——每条命令的失败回执都多一段与它无关的话");
});

test("failDigest 跟着实际用的秒数走，不是写死的 60", () => {
  assert.match(CODE, /\[failDigest:timeout-\$\{_useSecs\}s:/);
  assert.doesNotMatch(CODE, /\[failDigest:timeout-60s:/, "写死的 60 还在——排查时会对不上真实超时");
});
