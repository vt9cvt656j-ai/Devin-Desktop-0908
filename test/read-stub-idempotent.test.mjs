// 读取去重的"桩"只许打一次，不许每轮重刷。
//
// # 机制
//
// 同一个文件被读多次时，Tier 1 会把较早那条完整读取替换成一行桩：
//   [同版本 <路径> 的较早读取已由后面的 <from>-<to>/<total> 行完整覆盖]
// 桩里带着**覆盖它的那次读取的行号段**。每来一次新的、范围更大的覆盖读取，行号段就变，
// 桩文本也就跟着变 —— 而这条消息躺在历史很靠前的位置，它一变，后面整段退出前缀缓存。
//
// 原来挡这件事的只有一条长度启发式 `content.length > 90`，而桩自己的长度取决于路径长短：
// 深路径（monorepo 里很常见）打出来的桩正好 100 字 > 90，那道闸就形同虚设。实测同一文件
// 读四次，最早那条消息四轮里有三轮内容不同。
//
// 判据是行为：拿 main.js 里那段原文真跑四轮，看那条消息变不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFrom, fnSource } from "./helpers/source.mjs";

const TIER1 = blockFrom("if (doCompact) {");
assert.ok(TIER1.includes("readsByPath"), "锚点没落在 Tier 1 读取去重那一段");
assert.ok(TIER1.includes("contextAvailable !== false"), "幂等判据不在这段里了");

const runTier1 = new Function(
  "messages", "toolIdx", "_readEvidenceCovers",
  "let readContextChanged = false;\n" + TIER1 + "\nreturn readContextChanged;",
);
const readEvidenceCovers = new Function(fnSource("_readEvidenceCovers") + "\nreturn _readEvidenceCovers;")();

// monorepo 里很常见的深路径：打出来的桩 100 字，正好越过那条 90 字的长度闸。
const DEEP = "packages/web/src/features/billing/components/InvoiceTable/index.tsx";
const read = (from, to, total, path = DEEP) => ({
  role: "tool",
  content: "文件内容".repeat(200),
  _ideMeta: { kind: "read", resultKind: "content", canonicalPath: path, from, to, total },
});

test("同一个文件反复读，最早那条读取的桩必须一字不变", () => {
  const messages = [{ role: "system", content: "sys" }];
  let prev = null;
  for (let turn = 1; turn <= 4; turn++) {
    if (turn === 1) messages.push(read(1, 100, 400), read(1, 200, 400));
    else messages.push(read(1, 100 + turn * 100, 400));
    const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    runTier1(messages, toolIdx, readEvidenceCovers);
    const now = String(messages[1].content);
    if (prev !== null) {
      assert.equal(now, prev,
        `第 ${turn} 轮又把历史里那条读取改了——它在很靠前的位置，一变，后面整段退出前缀缓存`);
    }
    assert.ok(now.length > 90, "这条测试要的就是「桩超过 90 字」那种路径，否则长度闸自己就挡住了，测不出东西");
    prev = now;
  }
});

test("桩该打的时候还是要打——幂等标记不能把去重本身关掉", () => {
  const messages = [{ role: "system", content: "sys" }, read(1, 100, 400), read(1, 200, 400)];
  const toolIdx = [1, 2];
  const before = String(messages[1].content).length;
  runTier1(messages, toolIdx, readEvidenceCovers);
  assert.ok(String(messages[1].content).length < before, "较早那条完整读取没有被折成桩，等于没省");
  assert.match(String(messages[1].content), /已由后面的 1-200\/400 行完整覆盖/);
  assert.equal(messages[1]._ideMeta.contextAvailable, false, "桩没打上标记，下一轮还会被重刷");
  assert.ok(String(messages[2].content).includes("文件内容"), "最新那条读取被误伤了");
});
