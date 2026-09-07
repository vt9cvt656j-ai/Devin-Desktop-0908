import test from "node:test";
import assert from "node:assert";
import { CODE } from "./helpers/source.mjs";

// 不带 name 的 read_terminal 走的是 _findAgentTerminal("")，它优先返回 activeTermTab
// ——**用户当前看着的那个标签页**，未必是智能体自己开的那个。默认不翻（用户说「看看终端」
// 时指的确实是它），但模型必须当场知道还有别的，否则下一步必然是 list_terminals + 再读一次。
test("不给 name 时，回执要点名没被选中的那几个终端", () => {
  assert.match(CODE, /const _alts = call\.name \? "" : _agentTerminalEntries\(\)\.filter\(\(it\) => it\.entry !== ent\)/,
    "没算出「另外还有哪些终端」");
  assert.match(CODE, /_alts \? `\\n（本次没给 name/, "算了却没拼进回执，等于没做");
  assert.match(CODE, /不必先 list_terminals/, "要明说不用再调一次——省的就是这一步");
});

test("给了 name 就不附这段——那时模型已经点名了，列表是噪音", () => {
  assert.match(CODE, /call\.name \? "" :/, "有 name 时也附，等于每条回执都多一段废话");
});

test("默认选择本身没被翻掉：仍然优先用户当前看着的那个标签页", () => {
  // 这条是把「不翻」写成不变量。要翻得有人明确决定，而不是顺手改掉。
  assert.match(CODE, /Number\.isInteger\(activeTermTab\) \? entries\.find\(\(item\) => item\.index === activeTermTab\) : null/);
});

test("read_terminal 仍能读到所有终端，不限任务页", () => {
  assert.match(CODE, /const ent = _findAgentTerminal\(call\.name\);/);
  assert.match(CODE, /return _findAgentTerminal\(name, \{ taskOnly: true \}\);/,
    "taskOnly 是 stop_terminal 那条的保留项，别扩到读取上");
});
