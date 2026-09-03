// 一轮工具调用的执行顺序，以及**出错时不许炸掉整个 run**。
//
// 搬出来之前，execute 里任何一次没被包住的 await 抛出，都会穿过 Promise.all 一路炸出外层
// `for (let iter …)` 整个智能体循环。抛出那一刻 messages 里有一条**带 tool_calls 的
// assistant 消息**和**零条工具结果** —— 转录当场不合法（下一次请求会被上游拒），
// 而用户看到的是一句原生 JS 报错。专门堵这个洞的 `[未执行]` 兜底挂在一条走不到的分支上，
// 因为异常压根到不了那里。
//
// 段语义是原样搬过来的，所以这个文件两头都守：**顺序不许变**，**异常不许升级成致命**。
import assert from "node:assert/strict";
import test from "node:test";
import { runOrderedToolSegments } from "../src/agent/tool-scheduler.js";

const alwaysLive = () => true;

test("硬屏障串行、相邻同键并行——段语义和搬出来之前逐字一致", async () => {
  const events = [];
  let active = 0, maxParallel = 0;
  const items = [{ k: "" }, { k: "read" }, { k: "read" }, { k: "" }, { k: "read" }];
  await runOrderedToolSegments(items, (it) => it.k, async (it, i) => {
    if (!it.k) { events.push("barrier" + i); return; }
    active++; maxParallel = Math.max(maxParallel, active);
    await new Promise((r) => setTimeout(r, 5));
    events.push("read" + i);
    active--;
  }, alwaysLive, () => {});
  assert.equal(maxParallel, 2, "相邻的两个 read 必须并行");
  assert.deepEqual(events, ["barrier0", "read1", "read2", "barrier3", "read4"],
    "顺序变了：硬屏障必须把前后隔开");
});

test("一项抛出：其余各项照常拿到结果，异常不冒泡", async () => {
  const done = [];
  const errs = [];
  const items = [{ k: "read", id: 0 }, { k: "read", id: 1 }, { k: "read", id: 2 }];
  await assert.doesNotReject(() => runOrderedToolSegments(items, (it) => it.k, async (it) => {
    if (it.id === 1) throw new Error("boom");
    done.push(it.id);
  }, alwaysLive, (it, i, e) => errs.push({ i, msg: String(e.message) })));
  assert.deepEqual(done, [0, 2], "同段里别的项被那次抛出带走了");
  assert.deepEqual(errs, [{ i: 1, msg: "boom" }], "失败项必须交给调用方去落一条结果");
});

test("串行段里一项抛出：后面的项照跑，不是整批断掉", async () => {
  const done = [];
  const errs = [];
  const items = [{ k: "", id: 0 }, { k: "", id: 1 }, { k: "", id: 2 }];
  await runOrderedToolSegments(items, () => "", async (it) => {
    if (it.id === 0) throw new Error("first blew up");
    done.push(it.id);
  }, alwaysLive, (it, i, e) => errs.push(i));
  assert.deepEqual(done, [1, 2]);
  assert.deepEqual(errs, [0]);
});

test("兜底自己抛也不许升级成致命——否则前功尽弃", async () => {
  // **串行段和并行段都要试。** 只试并行段是测不出来的：并行那支外面套着 allSettled，
  // 兜底抛出的异常会被它吞掉，于是「兜底不包 try」这个变异照样绿（实测过）。
  // 真正会冒泡的是串行段那一支 —— 那里是直接 `await runOne(...)`。
  for (const key of ["", "read"]) {
    await assert.doesNotReject(() => runOrderedToolSegments(
      [{ k: key }], (it) => it.k,
      async () => { throw new Error("boom"); },
      alwaysLive,
      () => { throw new Error("兜底自己也炸了"); },
    ), `段键 ${JSON.stringify(key)} 这一支：兜底抛出冒泡了，等于没有容器`);
  }
});

test("没传 onItemError 时也不许炸循环（退化成吞掉，但不致命）", async () => {
  await assert.doesNotReject(() => runOrderedToolSegments(
    [{ k: "" }], () => "", async () => { throw new Error("boom"); }, alwaysLive,
  ));
});

test("按了停就不再往下推进", async () => {
  const done = [];
  let live = true;
  const items = [{ k: "" }, { k: "" }, { k: "" }];
  await runOrderedToolSegments(items, () => "", async (it, i) => {
    done.push(i);
    if (i === 0) live = false;
  }, () => live, () => {});
  assert.deepEqual(done, [0], "用户按停之后还在跑后续工具");
});

test("并行段里多项同时抛：每一项都要被单独报出来", async () => {
  const errs = [];
  await runOrderedToolSegments(
    [{ k: "w" }, { k: "w" }, { k: "w" }], (it) => it.k,
    async (it, i) => { throw new Error("e" + i); },
    alwaysLive, (it, i) => errs.push(i),
  );
  assert.deepEqual(errs.sort(), [0, 1, 2],
    "Promise.all 会让第一个 reject 吃掉其余全部——每个 tool_call 都得有自己的结果");
});
