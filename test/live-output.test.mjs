// 长命令实时输出的尾巴：真往返，注入假定时器，不碰 DOM。
import test from "node:test";
import assert from "node:assert/strict";
import { createLiveTail } from "../src/agent/live-output.js";
import { SRC } from "./helpers/source.mjs";

/** 假定时器：schedule 记下回调，tick() 才触发；cancel 撤掉。 */
function fakeClock() {
  const pending = new Map();
  let seq = 0;
  return {
    schedule: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    cancel: (id) => { pending.delete(id); },
    tick: () => { const items = [...pending.values()]; pending.clear(); for (const it of items) it.fn(); },
    get pending() { return pending.size; },
  };
}

test("第一块立刻排一次渲染，节流窗口内的后续块合并进同一次", () => {
  const clock = fakeClock();
  const seen = [];
  const live = createLiveTail({ render: (t) => seen.push(t), schedule: clock.schedule, cancel: clock.cancel, throttleMs: 80 });
  live.push("a");
  live.push("b");
  live.push("c");
  assert.equal(clock.pending, 1, "三块只该排一个定时器");
  assert.deepEqual(seen, [], "节流：定时器没到之前不渲染");
  clock.tick();
  assert.deepEqual(seen, ["abc"], "一次渲染拿到合并后的全部内容");
  live.push("d");
  assert.equal(clock.pending, 1, "渲染过之后新块要重新排一次");
  clock.tick();
  assert.deepEqual(seen, ["abc", "abcd"]);
});

test("只保留尾部：刷屏的构建不能把渲染字符串越拼越长", () => {
  const clock = fakeClock();
  const seen = [];
  const live = createLiveTail({ render: (t) => seen.push(t), schedule: clock.schedule, cancel: clock.cancel, keep: 10 });
  live.push("0123456789ABCDEF");
  clock.tick();
  assert.equal(seen[0], "6789ABCDEF", "渲染的必须是尾巴，不是开头");
  for (let i = 0; i < 100; i++) live.push("xxxxxxxxxx");
  assert.ok(live.size <= 20, `缓冲区没封顶：${live.size}`);
  clock.tick();
  assert.equal(seen.at(-1).length, 10);
});

test("cancel 掐掉还没醒的定时器——否则它会把最终输出盖回预览", () => {
  const clock = fakeClock();
  const seen = [];
  const live = createLiveTail({ render: (t) => seen.push(t), schedule: clock.schedule, cancel: clock.cancel });
  live.push("partial");
  assert.equal(clock.pending, 1);
  live.cancel();
  assert.equal(clock.pending, 0, "cancel 之后不该还有挂着的定时器");
  clock.tick();
  assert.deepEqual(seen, [], "被掐掉的渲染不许再发生");
});

test("reset 清空缓冲并撤定时器（沙箱逃生门重跑同一条命令）", () => {
  const clock = fakeClock();
  const seen = [];
  const live = createLiveTail({ render: (t) => seen.push(t), schedule: clock.schedule, cancel: clock.cancel });
  live.push("first run");
  live.reset();
  assert.equal(live.size, 0);
  assert.equal(clock.pending, 0);
  live.push("second");
  clock.tick();
  assert.deepEqual(seen, ["second"], "第二次跑不能带着第一次的输出");
});

test("渲染函数抛异常不许冒泡到命令执行体；空块不排定时器", () => {
  const clock = fakeClock();
  const live = createLiveTail({ render: () => { throw new Error("DOM 没了"); }, schedule: clock.schedule, cancel: clock.cancel });
  live.push("");
  live.push(null);
  assert.equal(clock.pending, 0, "空块不该排渲染");
  live.push("x");
  assert.doesNotThrow(() => clock.tick());
  assert.equal(live.renders, 1);
});

test("接线：run_cmd 执行体真的把块喂给了它，并在整份结果重渲之前 cancel", () => {
  // 三处都要在：两次抓取调用都带 onChunk（沙箱逃生门那次重跑也要有实时输出），
  // 结束时先 cancel 再重渲。缺一处就是「有时候有实时输出，有时候没有」。
  const at = SRC.indexOf('let r = await backend.taskRunCapture(captureRoot, cmd, { timeoutSecs');
  assert.ok(at > 0, "run_cmd 的抓取调用改了形状，这条接线断言要跟着改");
  // 尾巴是在卡片元素旁边建的，离抓取调用有一百多行；窗口要够大，但仍锚在这条调用上。
  const block = SRC.slice(Math.max(0, at - 14000), at + 3500);
  assert.match(block, /createLiveTail\(\{/, "执行体没建实时尾巴");
  assert.equal((block.match(/onChunk: \(p\) => _live\.push\(p\?\.text\)/g) || []).length, 2, "两次抓取调用都要带 onChunk");
  assert.match(block, /_live\.reset\(\);\s*\n\s*r = await backend\.taskRunCapture/, "沙箱逃生门重跑前要 reset");
  const cancelAt = block.indexOf("_live.cancel();");
  const finalAt = block.indexOf("outputEl.innerHTML = _ansiHtml(output, { maxChars: 5000 })");
  assert.ok(cancelAt > 0 && finalAt > cancelAt, "整份结果重渲之前必须先 cancel 掉实时渲染");
  // Rust 侧：每读一块就发 task-capture-chunk，前端按 captureId 派发。
  assert.match(SRC, /listen\("task-capture-chunk"/, "前端没监听实时输出事件");
});
