// 流式每一帧都会对**全量正文**重跑的那几个纯函数，现在都带缓存。
//
// 病根形状是同一个：这些函数挂在 90ms 一次的渲染回调上，而它们每次都从头处理整段回复。
// 一轮里已经落定的部分每帧都被重算一遍，真正会变的只有最后那一小段。150KB 的回复
// 每帧白分配一堆临时字符串 —— GC 压力比 CPU 更伤手感。
//
// 缓存是纯加速，所以这个文件守的是**结果一个字都不能变**：拿改动前的实现逐字照抄一份
// 做对拍。照抄品只在这里存在，源码里那份仍然是唯一实现（测试用 acorn 抠真函数来跑）。
import assert from "node:assert/strict";
import test from "node:test";
import { load, fnSource } from "./helpers/source.mjs";

const SEP = String.fromCharCode(1); // 源码里的分隔符是控制字符，终端和 grep 里都看不见

// ---- 改动前的 _dedupeRepeatedText，逐字照抄 ----
function oldRepeated(s) {
  if (!s || s.length < 50) return s;
  let t = s.trim();
  const paras = t.split(/\n{2,}/);
  const out = [];
  for (const p of paras) {
    const last = out.length ? out[out.length - 1].trim() : "";
    if (last && p.trim().length > 15 && p.trim() === last) continue;
    out.push(p);
  }
  if (out.length >= 2 && out.length % 2 === 0) {
    const h = out.length / 2;
    if (out.slice(0, h).map((x) => x.trim()).join(SEP) === out.slice(h).map((x) => x.trim()).join(SEP)) {
      return out.slice(0, h).join("\n\n");
    }
  }
  t = out.join("\n\n");
  const mid = Math.floor(t.length / 2);
  { const a = t.slice(0, mid).trim(), b = t.slice(mid).trim(); if (a.length > 40 && b === a) return a; }
  return t;
}
// ---- 改动前的 _dedupeRunNarrative，逐字照抄 ----
function oldNarrative(text, seen) {
  if (!text || !(seen instanceof Set)) return text || "";
  const kept = [];
  for (const paragraph of String(text).trim().split(/\n{2,}/)) {
    const key = paragraph.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
    if (key.length >= 12 && seen.has(key)) continue;
    kept.push(paragraph);
    if (key.length >= 12) seen.add(key);
  }
  while (seen.size > 160) seen.delete(seen.values().next().value);
  return kept.join("\n\n").trim();
}

const newRepeated = load("_dedupeRepeatedText");
const newNarrative = load("_dedupeRunNarrative", {
  _narrativeKey: load("_narrativeKey", { _NARRATIVE_KEY_CACHE: new Map() }),
});

function rnd(seed) { let x = seed; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
const POOL = ["这是一段明显超过十五个字符门槛的正文内容甲", "这是一段明显超过十五个字符门槛的正文内容乙",
  "这是一段明显超过十五个字符门槛的正文内容丙", "短句", "另一段足够长足够长足够长足够长的内容丁",
  "**加粗的总结句**——它和上一条只差标点和装饰", "总结句它和上一条只差标点和装饰",
  // **大小写必须进语料**：指纹里那个 .toLowerCase() 对纯中文是空操作，
  // 全中文的语料测不出「漏了 toLowerCase」（变异测试实测：那一版是绿的）。
  "The Summary Line Here Is Long Enough", "the summary line here is long enough",
  "MixedCase Paragraph With Enough Length To Pass"];
function corpus(seed, n) {
  const r = rnd(seed); const out = [];
  for (let t = 0; t < n; t++) {
    let paras = Array.from({ length: 1 + Math.floor(r() * 6) }, () => POOL[Math.floor(r() * POOL.length)]);
    if (r() < 0.4) paras = paras.concat(paras);                  // 整段重复
    if (r() < 0.3 && paras.length) paras.splice(1, 0, paras[0]);  // 相邻重复
    let text = paras.join("\n\n");
    // **前后空白必须进语料**：`if (s.length < 50) return s` 返回的是**原始** s（没 trim），
    // 所以「拿 trim 过的字符串当缓存键」会把长度跨在 50 两侧的输入混为一谈。
    // 不造这种输入的话，那个错误的缓存键是测不出来的（变异测试实测：也是绿的）。
    if (r() < 0.25) text = "  " + text;
    if (r() < 0.25) text = text + "   \n";
    out.push(text);
  }
  // 专门补几条长度刚好卡在 50 附近、且带前后空白的
  for (const base of ["x".repeat(46), "y".repeat(48), "z".repeat(52)]) {
    out.push(base, " " + base, base + "  ", "  " + base + "  ");
  }
  return out;
}

test("_dedupeRepeatedText 加缓存之后结果一字不变", () => {
  let deduped = 0;
  for (const text of corpus(3, 3000)) {
    const want = oldRepeated(text);
    assert.equal(newRepeated(text), want, `结果变了：${JSON.stringify(text).slice(0, 80)}`);
    if (want !== text && want !== text.trim()) deduped++;
  }
  // 没这一条的话，语料全是「不触发去重」也照样绿 —— 那就等于什么都没测。
  assert.ok(deduped > 200, `语料里只有 ${deduped} 组真的发生了去重，测试没覆盖到主逻辑`);
});

test("_dedupeRepeatedText 同一输入重复调用结果稳定（缓存没返回错的东西）", () => {
  for (const text of corpus(9, 300)) {
    const a = newRepeated(text);
    assert.equal(newRepeated(text), a);
    assert.equal(newRepeated(text), a);
  }
});

test("_dedupeRepeatedText 的缓存是有界的", () => {
  for (const text of corpus(11, 200)) newRepeated(text);
  const size = newRepeated._cache?.size ?? 0;
  assert.ok(size > 0 && size <= 4, `缓存槽数 ${size}：无界的话长会话会一直涨`);
});

test("每条返回路径都真的写进了缓存——只验结果对，漏写缓存是看不见的", () => {
  // 变异测试实测：把某一条 return 的 _dcPut 去掉，结果依然全对，
  // 上面那些断言一条都不红 —— 而那条路径从此每帧付全价。所以要正面验缓存被写了。
  const long = "这是一段明显超过十五个字符门槛的正文内容甲";
  const cases = {
    "整段重复（路径 2）": [long, "另一段足够长足够长足够长足够长的内容丁", long, "另一段足够长足够长足够长足够长的内容丁"].join("\n\n"),
    "半文重复（路径 3）": ("A".repeat(60) + "B".repeat(20)).repeat(2),
    // **必须超过 50 字符**：`if (s.length < 50) return s` 是一条无需缓存的早退
    // （它本来就是 O(1)）。用例短于 50 就走不到默认路径，测的是另一件事。
    "不触发去重（默认路径）": [long, "另一段足够长足够长足够长足够长的内容丁", "第三段也要够长够长够长够长够长"].join("\n\n"),
  };
  for (const [what, input] of Object.entries(cases)) {
    assert.ok(input.length >= 50, `${what} 的用例只有 ${input.length} 字符，会走 <50 的早退，测不到目标路径`);
    newRepeated._cache?.clear();
    newRepeated(input);
    assert.ok(newRepeated._cache?.has(input),
      `${what} 这条路径没把结果写进缓存：流式每一帧都会重跑它`);
  }
});

test("缓存的读键和写键一致——不一致只降命中率、不改结果，正面验才看得见", () => {
  // 变异测试实测：把读侧改成 `_dc.has(s.trim())` 而写侧仍用 s，**所有结果断言都是绿的**
  // —— 键不匹配时只是落空、重算一遍，答案照样对，只是每帧付全价。
  // 所以要正面证明「命中」：往缓存里塞一个哨兵，再调一次，拿到哨兵才算真命中。
  const base = ["这是一段明显超过十五个字符门槛的正文内容甲",
    "另一段足够长足够长足够长足够长的内容丁", "第三段也要够长够长够长够长够长"].join("\n\n");
  for (const input of [base, "  " + base, base + "  \n", "  " + base + "  "]) {
    newRepeated._cache?.clear();
    newRepeated(input);
    newRepeated._cache.set(input, "SENTINEL");
    assert.equal(newRepeated(input), "SENTINEL",
      `输入 ${JSON.stringify(input.slice(0, 12))}… 没命中缓存：读键和写键不是同一个`);
  }
});

test("指纹缓存真的被填了（不然记忆化等于没做）", () => {
  const cache = new Map();
  const key = load("_narrativeKey", { _NARRATIVE_KEY_CACHE: cache });
  const p = "这是一段明显超过十五个字符门槛的正文内容甲";
  const first = key(p);
  assert.ok(cache.has(p), "第一次调用没写缓存");
  assert.equal(key(p), first);
  // 有界：超了整段清空。
  for (let i = 0; i < 600; i++) key("段落" + i + "内容内容内容内容内容内容");
  assert.ok(cache.size <= 513, `指纹缓存涨到 ${cache.size}，没有上界`);
});

test("_dedupeRunNarrative 指纹记忆化之后结果一字不变，跨帧累积状态也一致", () => {
  // seen 是**跨轮累积**的状态，缓存只能作用在指纹计算上、不能碰它。
  // 所以要连着喂好几帧、并且比对两边的 seen 集合本身。
  const seenA = new Set(), seenB = new Set();
  for (const text of corpus(5, 1200)) {
    for (let frame = 0; frame < 3; frame++) {
      assert.equal(newNarrative(text, seenA), oldNarrative(text, seenB), "输出变了");
    }
    assert.deepEqual([...seenA], [...seenB], "seen 的累积状态漂了 —— 跨轮去重会跟着错");
  }
  assert.ok(seenA.size > 0, "语料没往 seen 里放过任何指纹，测试没测到东西");
});
