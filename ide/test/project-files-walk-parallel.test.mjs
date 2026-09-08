import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/source.mjs";

// `_agentFindProjectFiles` 跑在**每一个写过文件的智能体回合**上（找项目里的 .sqlite/.db），
// 整棵树读完才返回，而外面压着 1600ms 超时——超时一到整份结果作废，下一轮再付一次。
//
// 它原来是 `for` 里 `await walk(...)`：一个目录一次 Tauri IPC 往返，一个个排队。
// 本仓库实测 118~152 次往返、约 0.6~0.8 秒，而原生文件系统只花 7.7ms——97% 的墙钟
// 是往返在排队。同一个文件里的 marker 探测和 known-path 探测早就并行化了（195ms → 12ms），
// 唯独这棵树漏了。
//
// 下面三条钉的是并行化**不能**顺手改掉的东西：次序、短路、以及一条臂炸了别炸全场。

/** 造一棵可控的假树：每次 readDir 延迟 delayMs，并记录并发峰值。 */
const build = (tree, delayMs, state) =>
  load("_agentFindProjectFiles", {
    _normalizeFsPath: (p) => String(p),
    _normRel: (abs, root) => String(abs).slice(String(root).length + 1),
    _agentDirEntryName: (e) => e.name,
    _agentDirEntryIsDir: (e) => !!e.isDir,
    _AGENT_CONTEXT_SKIP_DIRS: new Set(["node_modules", ".git"]),
    backend: {
      readDir: async (dir) => {
        state.calls++;
        state.live++;
        state.peak = Math.max(state.peak, state.live);
        await new Promise((r) => setTimeout(r, delayMs));
        state.live--;
        if (tree[dir] === undefined) throw new Error("no such dir");
        return tree[dir];
      },
    },
  });

/** 一棵两层的树：根下 12 个目录，每个目录里一个 .sqlite。 */
function wideTree(width = 12) {
  const tree = { "/w": [] };
  for (let i = 0; i < width; i++) {
    const name = `d${String(i).padStart(2, "0")}`;
    tree["/w"].push({ name, isDir: true, path: `/w/${name}` });
    tree[`/w/${name}`] = [{ name: `f${i}.sqlite`, isDir: false, path: `/w/${name}/f${i}.sqlite` }];
  }
  return tree;
}

const isSqlite = ({ name, isDir }) => !isDir && /\.sqlite$/.test(name);

test("同层子目录并发读，不是一个个排队", async () => {
  const st = { calls: 0, live: 0, peak: 0 };
  const find = build(wideTree(), 5, st);
  const t0 = Date.now();
  const hits = await find("/w", isSqlite, { maxDepth: 3, maxHits: 40 });
  const ms = Date.now() - t0;

  assert.equal(hits.length, 12, `应当找到 12 个，实际 ${hits.length}`);
  assert.ok(st.calls >= 13, `readDir 只调了 ${st.calls} 次，用例前提变了`);
  // **判据是峰值并发，不是耗时。** 12 个子目录同层：并行时它们同时在飞，峰值 ≥8；
  // 串行时峰值恒为 1，中间没有灰色地带。这个数不看时钟，所以机器再忙也不会翻。
  //
  // 旁边 project-hints-probe-in-parallel 那条用的是「耗时 < 串行下界 × 0.4」，
  // 全量跑起来机器一忙它就翻（实测 86ms 对阈值 78ms，单跑必过）——那测的是负载不是并发。
  // 这里不重复那个错。耗时只在断言失败时打出来给人看，不参与判定。
  assert.ok(st.peak >= 8, `峰值并发只有 ${st.peak}（耗时 ${ms}ms）—— 还在一个个排队`);
});

test("次序和串行版逐字一致：并发只改快慢，不改结果", async () => {
  const st = { calls: 0, live: 0, peak: 0 };
  // 让**后面**的目录读得更快：串行时次序由目录顺序决定，天真的并行会变成
  // 「谁先回来谁在前」，这一条就是抓那个的。
  const tree = wideTree(6);
  const find = load("_agentFindProjectFiles", {
    _normalizeFsPath: (p) => String(p),
    _normRel: (abs, root) => String(abs).slice(String(root).length + 1),
    _agentDirEntryName: (e) => e.name,
    _agentDirEntryIsDir: (e) => !!e.isDir,
    _AGENT_CONTEXT_SKIP_DIRS: new Set(),
    backend: {
      readDir: async (dir) => {
        st.calls++;
        // d00 最慢、d05 最快，完全倒过来
        const m = /d(\d+)$/.exec(dir);
        await new Promise((r) => setTimeout(r, m ? 30 - Number(m[1]) * 5 : 0));
        if (tree[dir] === undefined) throw new Error("no such dir");
        return tree[dir];
      },
    },
  });
  const hits = await find("/w", isSqlite, { maxDepth: 3, maxHits: 40 });
  assert.deepEqual(hits, ["d00/f0.sqlite", "d01/f1.sqlite", "d02/f2.sqlite",
    "d03/f3.sqlite", "d04/f4.sqlite", "d05/f5.sqlite"],
    "并发之后次序按谁先返回排了——结果不再等价于串行版");
});

test("maxHits 仍然短路，不会把整棵树读完", async () => {
  const st = { calls: 0, live: 0, peak: 0 };
  // 200 个目录，只要 2 个命中：短路失效的话 readDir 会调满 201 次。
  const tree = { "/w": [] };
  for (let i = 0; i < 200; i++) {
    const name = `d${String(i).padStart(3, "0")}`;
    tree["/w"].push({ name, isDir: true, path: `/w/${name}` });
    tree[`/w/${name}`] = [{ name: `f${i}.sqlite`, isDir: false, path: `/w/${name}/f${i}.sqlite` }];
  }
  const hits = await build(tree, 0, st)("/w", isSqlite, { maxDepth: 3, maxHits: 2 });
  assert.equal(hits.length, 2, "maxHits 没有截断结果");
  assert.ok(st.calls < 100,
    `readDir 调了 ${st.calls} 次 —— maxHits 的短路失效了，整棵树被读完`);
});

test("一个目录读不动，不许把整份结果炸掉", async () => {
  // 并发之后一条臂 reject 会让 Promise.all 整体 reject；串行版每次都在 try 里。
  const st = { calls: 0, live: 0, peak: 0 };
  const tree = wideTree(4);
  delete tree["/w/d02"];  // 这个目录读不动
  const hits = await build(tree, 0, st)("/w", isSqlite, { maxDepth: 3, maxHits: 40 });
  assert.deepEqual(hits, ["d00/f0.sqlite", "d01/f1.sqlite", "d03/f3.sqlite"],
    "一个目录读不动就把整份结果丢了，或者顺序乱了");
});
