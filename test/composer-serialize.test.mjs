// 输入框里内容一多就卡顿——真凶是把 contentEditable 序列化成文本的那一段是**二次**的。
//
// 用户实拍：「对话框里面如果发的内容过于长、过于多，会卡顿很久」。在真浏览器里量过：
// 每敲一个字，500 行 14ms / 1000 行 31ms / 2000 行 181ms / 3000 行 528ms。
// 病根是 `out += …` 配 `out.endsWith("\n")`：每遇到一个块级元素就对正在生长的字符串调一次
// endsWith，而它会把 V8 的绳索字符串摊平，于是每次都重新拷贝已攒出的全部内容。
// 改成分片进数组 + 末字符单独记之后：3000 行 528ms → 12ms。
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/source.mjs";

// 够用的假 DOM：只提供 _ceSerialize 真正读的那几样。
const text = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
const el = (tag, kids = [], cls = "") => ({
  nodeType: 1, tagName: tag, childNodes: kids,
  classList: { contains: (n) => cls.split(" ").includes(n) },
});
const chip = (label) => ({ ...el("SPAN", [], "composer-chip"), _label: label });

const serialize = load("_ceSerialize", { _chipText: (c) => " @" + c._label + " " });

test("序列化的结果一个字都不许变", () => {
  const root = el("DIV", [
    text("开头"),
    el("BR"),
    text("第二行"),
    el("DIV", [text("块里的字")]),
    el("DIV", [text("另一块")]),
    text("​"),                       // 零宽垫片要剥掉
    chip("README.md"),
    text("尾巴"),
  ]);
  assert.equal(serialize(root), "开头\n第二行\n块里的字\n另一块 @README.md 尾巴");
});

test("块级元素之间只补一个换行，且开头不补", () => {
  // 这条钉的正是被改掉的那个判据：原来是 `out && !out.endsWith("\n")`，
  // 现在是 `parts.length && last !== "\n"`——两者必须等价。
  assert.equal(serialize(el("DIV", [el("DIV", [text("a")]), el("DIV", [text("b")])])), "a\nb");
  assert.equal(serialize(el("DIV", [el("DIV", [text("a")])])), "a", "第一个块前面补了换行");
  assert.equal(serialize(el("DIV", [text("x"), el("BR"), el("DIV", [text("y")])])), "x\ny",
    "BR 之后紧跟块级元素，补了第二个换行");
  assert.equal(serialize(el("DIV", [el("DIV", []), el("DIV", [text("a")])])), "a",
    "空块也算数了——它什么都没产出，不该让后面那块补换行");
  assert.equal(serialize(el("DIV", [text("​"), el("DIV", [text("a")])])), "a",
    "整节点都是零宽垫片，剥完等于什么都没产出，不该触发补换行");
});

test("规模上去不许变成二次的", () => {
  // 判据是**时间**，不是源码长相：这一段的病就是"看起来完全正常"。
  // 老写法在 Node 上 6000 块要几百毫秒，新写法个位数毫秒——预算给 40 倍余量。
  const build = (n) => el("DIV", Array.from({ length: n },
    (_, i) => el("DIV", [text("第 " + i + " 行：const value = compute(" + i + "); // 一段中文说明文字")])));
  const timeIt = (n) => { const root = build(n); const t0 = process.hrtime.bigint(); const out = serialize(root); return { ms: Number(process.hrtime.bigint() - t0) / 1e6, len: out.length }; };
  timeIt(500); // 预热，别让第一次的 JIT 编译算进账
  const small = timeIt(1500);
  const big = timeIt(6000);
  assert.ok(big.len > small.len * 3.5, "样本没按比例变大，这条判据会失效");
  assert.ok(big.ms < 150, `6000 块用了 ${big.ms.toFixed(0)}ms——又变回二次的了（老写法在这里是几百毫秒）`);
  // 4 倍数据不该超过 12 倍时间。二次的话是 16 倍起。
  const ratio = big.ms / Math.max(0.05, small.ms);
  assert.ok(ratio < 12, `数据涨 4 倍、耗时涨 ${ratio.toFixed(1)} 倍——不是线性的`);
});
