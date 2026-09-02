// 模型悬浮卡：`showModelInfoCard` 先 `card.innerHTML = <模板>`，再对若干
// `.mic-*` 元素 `querySelector(...).remove()/textContent=`。
//
// 崩过一次（2026-09-02）：自定义端点那段披露搬了两次家、CSS 规则也删过一次，
// 落点元素 `.mic-note` 忘了加进模板 —— `querySelector(".mic-note")` 回 null，
// 三个分支每一个都是 `null.remove()` / `null.textContent=`，整张卡一渲染就
// 「TypeError: null is not an object」。凡是被 hover 到模型名就崩。
//
// 判据是结构：函数里每一个 `querySelector(".X")` 的目标类名，模板里都必须真的建了
// 那个元素。这条测试挡的是整整一类 bug（handler 引用了模板没建的元素），不只这一次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fnSource } from "./helpers/source.mjs";

const BODY = fnSource("showModelInfoCard");

// 模板里出现的 class="xxx"（含 innerHTML 之外由子函数拼进来的也算数——用整段函数源码扫）。
const built = new Set(
  [...BODY.matchAll(/class="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]),
);

// 函数直接 querySelector(".X") 的目标。
const queried = [...BODY.matchAll(/querySelector\("\.([a-z][a-z0-9-]*)"\)/g)].map((m) => m[1]);

assert.ok(queried.length >= 5, `只扫到 ${queried.length} 个 querySelector，锚点大概失效了`);
assert.ok(queried.includes("mic-note"), "没扫到 .mic-note —— 这条测试的核心用例丢了");

const missing = queried.filter((cls) => !built.has(cls));
assert.deepEqual(
  missing, [],
  `这些类被 querySelector 了，但 card.innerHTML 模板里没有对应元素：\n  ` +
    missing.map((c) => "." + c).join("\n  ") +
    `\n每一个都会让 querySelector 回 null，紧接着的 .remove()/.textContent= 直接崩掉整张卡。`,
);
