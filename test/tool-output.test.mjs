// 工具结果保真：这些判据全部**在 Node 里真跑**，不查源码文本。
//
// 为什么不写成源码断言：这一整类 bug 的形状就是「代码看着对、行为不对」——
// `output.slice(0, 2000)` 每一个字符都合法，它错在没人告诉模型少了什么。
// 只有真往返才抓得住「模型手上这段文本和真实发生的事差多少、它知不知道」。
import test from "node:test";
import assert from "node:assert/strict";
import {
  capTurnToolResults,
  allocateTurnResultBudget,
  TURN_TOOL_RESULTS_MAX_CHARS,
  PER_RESULT_FLOOR,
} from "../src/agent/tool-output.js";
import { SRC } from "./helpers/source.mjs";

// ---- 单轮聚合预算 --------------------------------------------------------

test("总量没超就一个字节都不动（同一个数组原样返回）", () => {
  const msgs = [
    { role: "tool", tool_call_id: "a", content: "短" },
    { role: "assistant", content: "…" },
  ];
  assert.equal(capTurnToolResults(msgs), msgs, "没超预算却重建了数组");
});

test("10 个并行工具各自贴着自己的上限 = 一轮 60 万字，必须被压回来", () => {
  // 这就是设这道闸的原因：逐次上限管不住并发批次，段长没有任何上限。
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: "tool", tool_call_id: `t${i}`, content: "d".repeat(60_000),
  }));
  const before = msgs.reduce((n, m) => n + m.content.length, 0);
  assert.equal(before, 600_000);

  const out = capTurnToolResults(msgs);
  const after = out.reduce((n, m) => n + (m.role === "tool" ? m.content.length : 0), 0);
  assert.ok(after <= TURN_TOOL_RESULTS_MAX_CHARS + 10 * 400,
    `压完还有 ${after} 字，预算是 ${TURN_TOOL_RESULTS_MAX_CHARS}`);
  assert.ok(after < before);
  // 入参不许被改。
  assert.equal(msgs[0].content.length, 60_000, "改了入参");
});

test("**绝不整条丢弃**——少一条结果，模型会默认那次调用成功了", () => {
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    role: "tool", tool_call_id: `t${i}`, content: "e".repeat(50_000),
  }));
  const out = capTurnToolResults(msgs);
  assert.equal(out.length, msgs.length, "条数变了");
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].tool_call_id, `t${i}`, "tool_call_id 对不上了——协议单元必须一一对应");
    assert.ok(out[i].content.length >= PER_RESULT_FLOOR - 400,
      `第 ${i} 条被削到 ${out[i].content.length} 字，低于地板`);
  }
});

test("**公平灌水**：10 条等长时每条拿到一样多，不许前几条被削到地板、后几条一字不动", () => {
  // 这条抓的是「从最长的开始削」那个贪心。它总量算得对、分布是灾难：
  // 10 条各 60000、预算 200000 时会把前六条削到 600 字、后三条完全不动 —— 六份证据毁了。
  const sizes = Array(10).fill(60_000);
  const alloc = allocateTurnResultBudget(sizes, 200_000);
  assert.equal(new Set(alloc).size, 1, `等长输入分出了不等的份额：${alloc.join(",")}`);
  assert.equal(alloc[0], 20_000);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 200_000);
});

test("灌水：短的原样留、把富余让给长的（与顺序无关）", () => {
  // 1 条 190000 + 9 条 1000 = 199000 < 200000 → 一条都不该动。
  assert.deepEqual(allocateTurnResultBudget([190_000, ...Array(9).fill(1_000)], 200_000),
    [190_000, ...Array(9).fill(1_000)], "没超预算却动了");
  // 短的让出富余之后，长的应当拿到远超「平均分」的额度。
  const a = allocateTurnResultBudget([300_000, 500, 500, 500], 200_000);
  assert.deepEqual(a.slice(1), [500, 500, 500], "短的被削了");
  assert.equal(a[0], 198_500, "长的没有吃到短的让出来的富余");
  // 与顺序无关：换个次序，同一组数得到同一组份额。
  const b = allocateTurnResultBudget([500, 300_000, 500, 500], 200_000);
  assert.deepEqual([...b].sort((x, y) => x - y), [...a].sort((x, y) => x - y), "结果跟顺序有关");
});

test("病态输入：条数太多时全部落到地板，且**宁可整轮略超**也不压成空", () => {
  const alloc = allocateTurnResultBudget(Array(300).fill(8_000), 200_000);
  assert.ok(alloc.every((v) => v >= PER_RESULT_FLOOR), "有结果被压到地板以下");
  assert.ok(alloc.reduce((a, b) => a + b, 0) > 200_000, "地板兜底没生效（说明有的被压成空了）");
});

test("先削最长的：一条短诊断不该为一条巨型日志陪葬", () => {
  const small = "这条只有几十个字的诊断信息，很关键。".repeat(3);
  const msgs = [
    { role: "tool", tool_call_id: "small", content: small },
    { role: "tool", tool_call_id: "huge", content: "f".repeat(400_000) },
  ];
  const out = capTurnToolResults(msgs);
  assert.equal(out[0].content, small, "短的那条被按比例砍了 —— 损失惨重而省不下多少");
  assert.ok(out[1].content.length < 400_000, "长的那条没被削");
});

test("被额外削短时要说清是「这一轮工具太多」，不是这个工具自己的上限", () => {
  // 两种原因的下一步动作完全不同：前者该分几轮调用，后者该收窄这一次的范围。
  const msgs = [
    { role: "tool", tool_call_id: "a", content: "g".repeat(150_000) },
    { role: "tool", tool_call_id: "b", content: "h".repeat(150_000) },
  ];
  const out = capTurnToolResults(msgs);
  const cut = out.find((m) => m.content.includes("⚠️"));
  assert.ok(cut, "削了却没有任何标记 —— 又是一次「模型以为自己看全了」");
  assert.match(cut.content, /这一轮/, "没说清是本轮聚合超限");
  assert.match(cut.content, /分几轮调用/, "没给出下一步该怎么做");
  assert.ok(/150000/.test(cut.content), "没说原本多长");
});

test("非 tool 消息和非字符串正文一律不碰", () => {
  const msgs = [
    { role: "assistant", content: "i".repeat(500_000) },
    { role: "tool", tool_call_id: "x", content: [{ type: "text", text: "j".repeat(500_000) }] },
    { role: "tool", tool_call_id: "y", content: "k".repeat(300_000) },
  ];
  const out = capTurnToolResults(msgs);
  assert.equal(out[0].content.length, 500_000, "动了 assistant 消息");
  assert.ok(Array.isArray(out[1].content), "把分块正文压成字符串了");
  assert.ok(out[2].content.length < 300_000, "该削的那条没削");
});

// ---- 接线：光有纯函数不算数 ----------------------------------------------

test("run_cmd 在捕获期不许再切——那一刀让投递层的机器恒不触发", () => {
  // 投递层给 cmd 的预算是 8000 且走 _clipPreservingErrors（带「错误关键行从被省略的中段
  // 豁免捞回」）。捕获期先切到 2000，2000 < 8000 → 原样返回 → 那套机器一次都没跑过。
  // 实测 263,977 字的 npm test 失败输出：切在捕获期 → FAIL/TypeError/汇总行一条不见；
  // 不切 → 7,871 字，三者俱在，还多一句原始字数。
  assert.doesNotMatch(SRC, /output \? output\.slice\(0, 2000\)/, "那条静默截断又回来了");
  assert.match(SRC, /let _content = output \|\| \(result\.code === 0 \? "\(executed\)"/,
    "run_cmd 的模型正文又在捕获期被切了 —— 投递层那套错误行豁免会再次恒不触发");
});

test("失败结果也要脱色：[ERROR] 那条提前返回不许绕过 _stripAnsi", () => {
  // 命中提前返回的主力就是 run_cmd/termtask 的失败结果，也正是最可能满屏 SGR 的那一类。
  // 成功的命令走 case "cmd" 会脱色，失败的反而不脱——实测彩色输出 31.8% 是转义序列。
  const at = SRC.indexOf('/\\[(ERROR|BLOCKED|DENIED|失败|不可用|error)\\]/i.test(c)');
  assert.ok(at > 0, "那条提前返回的判据改写了，这条守卫要跟着改");
  const block = SRC.slice(at, SRC.indexOf("}", SRC.indexOf("return", at)) + 1);
  assert.match(block, /_stripAnsi\(c\)/, "失败正文没脱色就投递给模型了");
});

test("工具批次推进消息流时过了聚合预算这道闸", () => {
  assert.match(SRC, /for \(const m of capTurnToolResults\(toolMsgs\)\) messages\.push\(m\)/,
    "并发批次没有过聚合预算 —— 段长本身没有任何上限");
});
