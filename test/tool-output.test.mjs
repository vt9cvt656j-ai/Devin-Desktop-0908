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
  makeOverflowSink,
  TURN_TOOL_RESULTS_MAX_CHARS,
  PER_RESULT_FLOOR,
  OVERFLOW_MIN_OMITTED_CHARS,
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
  // 不锁死实参列表：这条守卫要守的是「批次有没有过这道闸」，不是它带几个参数。
  // 原来写死成 `capTurnToolResults(toolMsgs)`，于是给这道闸加落盘出口（多传一个参数）
  // 时它当场假红，而报出来的错说的是「段长没有任何上限」——和真实改动毫无关系。
  assert.match(SRC, /for \(const m of capTurnToolResults\(\s*toolMsgs\b[^)]*\)\) messages\.push\(m\)/,
    "并发批次没有过聚合预算 —— 段长本身没有任何上限");
  // 而「带没带落盘出口」单独守一条，说的是它自己的事。
  assert.match(SRC, /capTurnToolResults\(\s*toolMsgs\s*,[^)]*_overflowSink\s*\)/,
    "这道闸削短之后没有取回出口 —— 模型只知道被削了，拿不回被削掉的部分");
});

// ---- 被截断的内容：不但要「知道」，还要「拿得到」 ------------------------
//
// 投递层原本只做到「知道」：首尾预览 + 一句「原始结果共 N 字」，收尾是「换更窄的查询重取」。
// 而 run_cmd 这类**不可重取**的工具（重跑命令有副作用，被刻意排除在 _REFETCHABLE 之外）
// 上那句话是空的——模型只能对着缺一大块的内容往下猜，或者再跑一遍命令。
// 落盘之后它才兑现：正文给出绝对路径，模型用 read_file(offset/limit) 取回任意一段。

test("丢了一大块 → 落盘，并把绝对路径写进正文", () => {
  const wrote = [];
  const sink = makeOverflowSink({ dir: "/tmp/mrday/", writeText: (p, t) => wrote.push([p, t]) });
  const raw = "x".repeat(200_000);
  const note = sink(raw, 7871, "cmd");

  assert.equal(wrote.length, 1, "没有落盘");
  assert.equal(wrote[0][1], raw, "落盘的不是**完整**内容 —— 那就白落了");
  assert.match(note, /完整内容在 \/tmp\/mrday\/tool-\d{4}-cmd\.txt/, "正文里没给出路径");
  assert.ok(note.includes(wrote[0][0]), "正文里的路径和真正写的那个不是同一个");
  assert.match(note, /200000/, "没说原始有多长");
  assert.match(note, /7871/, "没说这次只投递了多少");
  assert.match(note, /read_file/, "没告诉模型用什么读");
  assert.match(note, /offset/, "大文件怎么分段读没说");
  // run_cmd 不可重取，所以必须明确劝阻重跑——否则模型的默认反应就是再跑一遍。
  assert.match(note, /不要为了看剩下的重跑/, "没劝阻重跑");
});

test("只丢一点点不落盘——不值得为几百字写一个文件", () => {
  const wrote = [];
  const sink = makeOverflowSink({ dir: "/tmp/mrday", writeText: (p, t) => wrote.push([p, t]) });
  assert.equal(sink("a".repeat(9_000), 8_000, "cmd"), "", "丢 1000 字也落盘了");
  assert.equal(wrote.length, 0);
  // 边界：刚好到阈值就落。
  assert.notEqual(sink("a".repeat(8_000 + OVERFLOW_MIN_OMITTED_CHARS), 8_000, "cmd"), "");
  assert.equal(wrote.length, 1);
});

test("写不出去就**不许**承诺路径——宁可没有，也不能指向一个不存在的文件", () => {
  const sink = makeOverflowSink({ dir: "/tmp/mrday", writeText: () => { throw new Error("EACCES"); } });
  assert.equal(sink("z".repeat(200_000), 100, "cmd"), "",
    "写失败了却还在正文里给路径 —— 模型会去 read_file 一个不存在的文件，白烧一轮");
});

test("没有可用目录时安静退化（网页版没有真文件系统）", () => {
  assert.equal(makeOverflowSink({ dir: "", writeText: () => {} })("z".repeat(99_999), 10, "cmd"), "");
  assert.equal(makeOverflowSink({ dir: "/tmp", writeText: null })("z".repeat(99_999), 10, "cmd"), "");
});

test("文件名逐次递增且不含可注入路径的字符", () => {
  const sink = makeOverflowSink({ dir: "/tmp/mrday", writeText: () => {} });
  const big = "q".repeat(200_000);
  const a = sink(big, 10, "cmd");
  const b = sink(big, 10, "../../etc/passwd");
  assert.match(a, /tool-0001-cmd\.txt/);
  assert.match(b, /tool-0002-etcpasswd\.txt/, `kind 里的路径分隔符没被剥掉：${b.slice(0, 160)}`);
  assert.ok(!b.includes(".."), "文件名里留下了 .. —— 那是路径穿越");
});

test("接线：投递层真的调了它，且喂的是**原始**正文而不是裁剪后的", () => {
  // 喂裁剪后的等于落盘一份同样缺中段的副本，那就白落了。
  assert.match(SRC, /message \+= _overflowSink\(rawMessage, message\.length, _rt\)/,
    "投递层没接落盘，或者喂错了参数（必须是 rawMessage，不是 message）");
});

test("一轮工具太多而被额外削短时，也要给出取回完整内容的路径", () => {
  // 这道闸此前是整条链上唯一「削了却不给取回办法」的地方：正文只说「分几轮调用」，
  // 而 run_cmd 这类工具重跑既有副作用、也会被同样削一遍。
  const wrote = [];
  const sink = makeOverflowSink({
    dir: "/tmp/x",
    writeText: (path, text) => wrote.push({ path, len: text.length }),
    minOmitted: 1_000,
  });
  const big = (n, ch) => ({ role: "tool", tool_call_id: `t${n}`, content: ch.repeat(60_000) });
  const msgs = [big(1, "a"), big(2, "b"), big(3, "c"), big(4, "d")];

  const out = capTurnToolResults(msgs, 40_000, sink);

  assert.equal(wrote.length, 4, "四条都被削了，四条都该落盘");
  for (const m of out) {
    assert.match(m.content, /完整结果已存盘/, "被削短的正文里必须有取回说明");
    assert.match(m.content, /\/tmp\/x\/tool-\d{4}-turnclip\.txt/, "必须给出真实路径");
  }
  // 落盘的是**原文**，不是削过的
  for (const w of wrote) assert.equal(w.len, 60_000, "落盘的必须是完整原文");
});

test("不给 sink 时行为和以前逐字一致（老调用方不受影响）", () => {
  const msgs = [
    { role: "tool", tool_call_id: "a", content: "x".repeat(60_000) },
    { role: "tool", tool_call_id: "b", content: "y".repeat(60_000) },
  ];
  const withoutSink = capTurnToolResults(msgs.map((m) => ({ ...m })), 40_000);
  const explicitNull = capTurnToolResults(msgs.map((m) => ({ ...m })), 40_000, null);
  assert.deepEqual(
    withoutSink.map((m) => m.content),
    explicitNull.map((m) => m.content),
  );
  for (const m of withoutSink) assert.doesNotMatch(m.content, /完整结果已存盘/);
});

test("写不出去时绝不承诺路径", () => {
  const sink = makeOverflowSink({
    dir: "/tmp/x",
    writeText: () => { throw new Error("磁盘满了"); },
    minOmitted: 1_000,
  });
  const out = capTurnToolResults(
    [{ role: "tool", tool_call_id: "a", content: "z".repeat(120_000) }],
    20_000,
    sink,
  );
  assert.doesNotMatch(out[0].content, /完整结果已存盘/, "写失败还给路径就是撒谎");
  assert.match(out[0].content, /这一轮同时发了太多工具/, "但「被削了」这件事照样要说");
});

// ---- 取回指针要活过后续的两次改写 ----------------------------------------
//
// 工具结果进了历史之后还会被改写两次：Tier 1 折叠成一行桩、Tier 2 压到 400 字。
// 那句给路径的话在正文**末尾**，两次改写都会把它扔掉 —— 文件还在、指针没了，
// 而模型被告知的是「重新调用一次取回」，对 run_cmd 这类不可重取的工具是空话。

test("折叠/再压缩之后，落盘路径必须还在", async () => {
  const { withOverflowPointer, overflowPathOf, overflowNote } =
    await import("../src/agent/tool-output.js");
  const original = "很长的命令输出".repeat(500) + overflowNote("/var/folders/ab/tool-0007-cmd.txt", 500_000, 8_000);

  assert.equal(overflowPathOf(original), "/var/folders/ab/tool-0007-cmd.txt");

  const folded = withOverflowPointer("[已折叠较早的 run_cmd 结果（原 500000 字）：npm ERR!…]", original);
  assert.match(folded, /\/var\/folders\/ab\/tool-0007-cmd\.txt/, "折叠桩把取回路径弄丢了");
  assert.match(folded, /read_file/, "只给路径不说怎么读，等于没给");

  const compressed = withOverflowPointer("压缩后的正文\n（原 500000 字，已抽取压缩）", original);
  assert.match(compressed, /\/var\/folders\/ab\/tool-0007-cmd\.txt/, "二次压缩把取回路径弄丢了");
});

test("原文里没有落盘路径时，改写结果一个字都不动", async () => {
  const { withOverflowPointer } = await import("../src/agent/tool-output.js");
  assert.equal(withOverflowPointer("[已折叠]", "普通结果，没有落盘"), "[已折叠]");
  assert.equal(withOverflowPointer("", ""), "");
});

test("已经带着路径的正文不再重复贴一遍", async () => {
  const { withOverflowPointer, overflowNote } = await import("../src/agent/tool-output.js");
  const original = "x".repeat(1000) + overflowNote("/tmp/t/tool-0001-cmd.txt", 99_999, 100);
  const once = withOverflowPointer("头部…" + original.slice(-200), original);
  assert.equal(once.match(/tool-0001-cmd\.txt/g).length, 1, "路径被贴了两遍");
});

test("main.js 的两处历史改写点都带上了指针", () => {
  assert.match(SRC, /content: withOverflowPointer\(`\[已折叠较早的/,
    "Tier 1 折叠没带取回指针 —— 文件还在，模型手上的路径没了");
  assert.match(SRC, /content: withOverflowPointer\(comp\.length < c\.length/,
    "Tier 2 再压缩没带取回指针");
});
