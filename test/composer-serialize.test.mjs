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
  // 判据是**和老写法同场比**，不是"绝对耗时低于某个数"——后者在机器忙的时候会假红。
  // 老写法就搁在这里，两个实现跑同一份输入、同一个进程，机器负载对两边一视同仁。
  const quadratic = (root) => {
    let out = "";
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue.replace(/\u200b/g, "");
        else if (c.nodeType === 1) {
          if (c.classList && c.classList.contains("composer-chip")) out += " @x ";
          else if (c.tagName === "BR") out += "\n";
          else { if ((c.tagName === "DIV" || c.tagName === "P") && out && !out.endsWith("\n")) out += "\n"; walk(c); }
        }
      }
    };
    walk(root); return out;
  };
  const timeIt = (fn, root) => { const t0 = process.hrtime.bigint(); const out = fn(root); return { ms: Number(process.hrtime.bigint() - t0) / 1e6, len: out.length }; };
  timeIt(serialize, build(500)); timeIt(quadratic, build(500)); // 预热，别让 JIT 编译算进账
  const root = build(6000);
  const now = timeIt(serialize, root);
  const then = timeIt(quadratic, root);
  assert.equal(now.len, then.len, "两个实现的输出长度都对不上，这条判据在比两样不同的东西");
  assert.ok(then.ms / Math.max(0.05, now.ms) > 5,
    `新写法只比老写法快 ${(then.ms / Math.max(0.05, now.ms)).toFixed(1)} 倍——二次那条又回来了`
    + `（实测应在 50 倍以上；本次 新 ${now.ms.toFixed(1)}ms / 老 ${then.ms.toFixed(1)}ms）`);
});
