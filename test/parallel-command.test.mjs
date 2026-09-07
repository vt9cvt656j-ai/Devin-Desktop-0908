import test from "node:test";
import assert from "node:assert/strict";
import { load, fnSource } from "./helpers/source.mjs";
import { parallelUnsafeCommand } from "../src/agent/parallel-command.js";

/**
 * shell 命令的并行判据。
 *
 * 背景：`cmd` 此前整个不在并行表里，于是每一条 shell 命令都串行。实测用户机器 1218 条
 * 运行里，相邻的「运行→运行」有 340 对——每一对都在一个接一个地等。
 *
 * 放开它的风险不在「跑错」，在「跑对了但看到的世界变了」：同批并发的读，如果和一条
 * 切分支的命令撞上，读到的是另一个分支的内容，**读成功、不报错**。这个仓库在 `git`
 * 工具类型那一支上已经踩过一次，注释就在 _isReadOnlyParallel 里。
 */

const parallel = () => load("_isReadOnlyParallel", {
  _READ_ONLY_TYPES: new Set(["read", "list", "search"]),
  _GH_READ_OPS: ["pr_view"],
  _dbCallMayMutate: () => true,
  _looksLikeReadOnlyCommand: load("_looksLikeReadOnlyCommand"),
  _parallelUnsafeCommand: parallelUnsafeCommand,
});

test("只读 shell 命令可以并行，改动性的一律不行", () => {
  const can = parallel();
  const ok = (c) => can({ type: "cmd", command: c });
  for (const c of ["git log --oneline -5", "ls -la", "grep -rn foo src/", "cd /tmp && ls",
                   "npm ls", "git status | head -20", "cat package.json", "git branch"]) {
    assert.equal(ok(c), true, `只读命令被挡在并行外：${c}`);
  }
  for (const c of ["git commit -m x", "rm -rf /tmp/x", "npm install", "echo hi > f.txt",
                   "ls; rm -rf /", "ls && rm x", "find . -name '*.js' -delete", "cat $(whoami)"]) {
    assert.equal(ok(c), false, `会改动东西的命令被放进并行批：${c}`);
  }
});

test("切/建分支绝不许并行——它换掉整棵工作树，而并发的读不会报错", () => {
  const can = parallel();
  const ok = (c) => can({ type: "cmd", command: c });
  // 权限判据（要不要弹审批框）把这些也算只读，所以必须有第二层减法。
  const readOnly = load("_looksLikeReadOnlyCommand");
  for (const c of ["git branch feature-x", "git branch -d old", "git branch -f main HEAD~5"]) {
    assert.equal(readOnly(c), true, `前提变了：权限判据不再认为 ${c} 是只读，这条测试的落点没了`);
    assert.equal(ok(c), false, `${c} 被放进并行批 —— 同批的读会拿到另一个分支的内容且不报错`);
  }
  // 列分支照旧可以。
  for (const c of ["git branch", "git branch -a", "git branch --list"]) {
    assert.equal(parallelUnsafeCommand(c), false, `列分支被误排掉了：${c}`);
  }
  // Windows 的 attrib：查看可以，改属性不行。
  assert.equal(parallelUnsafeCommand("attrib f.txt"), false);
  assert.equal(parallelUnsafeCommand("attrib +r f.txt"), true);
  // 链式命令里任何一段不安全，整条就不安全。
  assert.equal(parallelUnsafeCommand("ls && git branch new"), true);
});

test("判据复用权限那一份，不另抄一份白名单", () => {
  // 两份手写名单必然漂——这个仓库为此付过很多次账（gh 的只读 op、git 的只读 op、
  // 并行类型表与子体只读类型表）。所以并行这一支必须**调用**权限判据，而不是复制它的规则。
  // 按 AST 取整个函数，不用固定字符窗口——判据一变长，窗口就守不住尾部而且照样是绿的。
  const branch = fnSource("_isReadOnlyParallel", { code: true });
  assert.match(branch, /t === "cmd"/, "并行判据里没有 cmd 这一支了");
  assert.match(branch, /_looksLikeReadOnlyCommand\(call\.command\)/,
    "cmd 并行判据没有复用权限那份白名单——另抄一份迟早漂");
  assert.match(branch, /_parallelUnsafeCommand\(call\.command\)/,
    "少了并行专属的那层减法：权限判据把 git branch <name> 也算只读");
  // termtask / browser 不许进来：前者是长跑任务，后者的 sidecar 单线程串行、并发无收益。
  assert.doesNotMatch(branch, /"termtask"|"browser"/,
    "termtask/browser 被放进只读并行批了");
});

/**
 * 时间线汇总的落盘。
 *
 * 这几个数在此之前**两侧都取不到**：客户端算了只喂界面上的跑秒表、随 run 消失；
 * 服务端的 request_id 是每会话一个（实测最长一条跨 22 小时），按它分组量不出
 * 「一条消息发几次模型请求」。
 */
test("时间线汇总只做时间戳之差，不做任何推断", async () => {
  const { summarizeTiming } = await import("../src/agent/turn-timing.js");
  const t = summarizeTiming({
    startedAt: 1000,
    turns: [
      { kind: "main", startedAt: 1500, requestStartedAt: 1600, firstProgressAt: 4600, endedAt: 9000 },
      { kind: "main", startedAt: 9000, requestStartedAt: 9100, firstProgressAt: 10100, endedAt: 12000, retryCount: 1 },
      { kind: "aux", startedAt: 12000, requestStartedAt: 12050, firstProgressAt: 12550, endedAt: 12900 },
    ],
  });
  assert.equal(t.turns, 3, "轮数不对——「一条消息发几次模型请求」就是靠它答的");
  assert.equal(t.prepMs, 600, "准备开销＝run 开始到第一个请求发出，用户感受到的沉默在这里");
  assert.equal(t.ttfbMs, 1000, "首字取的是**请求发出**到第一个进度，不是从 run 开始算");
  assert.equal(t.retries, 1);
  assert.deepEqual(t.kinds, { main: 2, aux: 1 }, "按轮次类型分——主调用和辅助调用要能分开数");
});

test("时间线算不出来时返回 null，绝不抛——抛了整条情景记录会静默消失", async () => {
  const { summarizeTiming } = await import("../src/agent/turn-timing.js");
  // _recordEpisode 整个包在 try 里且异常被吞。这里任何一个输入让它抛，
  // 用户丢的不是一个字段，是**那一整条运行记录**。
  for (const bad of [null, undefined, {}, { turns: null }, { turns: [] }, { turns: [null] },
                     { startedAt: NaN, turns: [{ startedAt: "x", firstProgressAt: {} }] },
                     { turns: [{ kind: { toString() { throw new Error("boom"); } } }] }]) {
    assert.doesNotThrow(() => summarizeTiming(bad), `坏输入让它抛了：${JSON.stringify(bad)}`);
  }
  assert.equal(summarizeTiming(null), null);
  assert.equal(summarizeTiming({ turns: [] }), null, "没有轮次就不该写这个字段");
  // 时间戳缺席时给 null 而不是 0——0 是个会骗人的答案（看起来像「零延迟」）。
  const partial = summarizeTiming({ turns: [{ kind: "main", startedAt: 5 }] });
  assert.equal(partial.ttfbMs, undefined, "取不到首字就不该编一个数出来");
  assert.equal(partial.turns, 1);
});

test("情景档案真的写了 timing 字段", () => {
  const ep = fnSource("_recordEpisode", { code: true });
  assert.match(ep, /_summarizeTiming\(run\.timeline\)/,
    "时间线汇总没有接进情景档案——数还是只在内存里，run 一结束就没了");
  assert.match(ep, /timing: t/, "算出来了却没落进记录");
});

/**
 * 意图裁决前台等待的胜负记账。
 *
 * `_INTENT_FOREGROUND_WAIT_MS` 被反复调过（1500 → 8000 → 15000 → 6000），每一次都是拿
 * 几条手工实测在赌。输赢的后果差得很远：赢＝网关按完整画像挂上工程/调研/设计各层
 * （26951 字节），输＝只剩 agent.base 四块（18885 字节）——「突然变弱智、工具也不用了」
 * 的物理成因。这几条守的是「这个数以后不用再靠赌」。
 */
test("裁决等待的胜负要记下来，且记账绝不能影响那道 race", async () => {
  const { recordIntentRace, summarizeIntentRace } = await import("../src/agent/turn-timing.js");
  const s = {};
  recordIntentRace(s, true, 4200);
  recordIntentRace(s, false, 6000);
  recordIntentRace(s, true, 3100);
  assert.deepEqual(summarizeIntentRace(s), { won: 2, lost: 1, wonMs: 4200, lostMs: 6000 });
  // 没数据就不写这个字段——0/0 会被误读成「一次都没赢」。
  assert.equal(summarizeIntentRace({}), null);
  assert.equal(summarizeIntentRace(null), null);
  // 记账在 Promise.race 的两条臂上，抛一下整轮就废了。
  for (const bad of [null, undefined, 0, "", { _intentRace: null }]) {
    assert.doesNotThrow(() => recordIntentRace(bad, true, 1), `记账抛了：${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => recordIntentRace(s, true, NaN));
  assert.doesNotThrow(() => recordIntentRace(s, false, "x"));
});

test("两条臂都记账，且落进情景档案", () => {
  const race = fnSource("_aiIntentProfile", { code: true });
  const src = race || "";
  // 赢的那条臂（裁决先到）和输的那条臂（超时先到）都要记——只记一边，比率就是假的。
  // 守的是"这条臂记了账"，不是"它长什么样"：钉逐字字面量会被纯增量的扩充打成假红。
  // （原来这条臂还多记一笔"完整裁决真实用了多久"给第一轮的第二段等待用；2026-09-05 第一发
  // 不再等裁决，那本跨会话的账连同等待一起删了。）
  assert.match(src, /_mark\(true\);[^\n]*return v;/, "裁决赢的那条臂没记账");
  assert.match(src, /_mark\(false\); resolve\(null\);/,
    "超时赢的那条臂没记账 —— 只记一边的话胜率恒为 100%");
  assert.match(src, /typeof _intentRaceMarker === "function"/,
    "记账没做 typeof 兜底 —— 沙箱里裸引用会抛，而它在 adopted.then 里，一抛整轮挂死");
  const ep = fnSource("_recordEpisode", { code: true });
  assert.match(ep, /_summarizeIntentRace\(session\)/,
    "记了账却没落盘——数据还是随会话消失，这个数就还得继续赌");
});
