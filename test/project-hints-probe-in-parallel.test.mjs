import test from "node:test";
import assert from "node:assert/strict";
import { load, CODE } from "./helpers/source.mjs";

// _agentProjectServiceHints 跑在**每一个写过文件的智能体回合**上，且整体有 1600ms 超时。
// 它原来用三段 `for + await` 串行探路：13 个后端标记逐个探、13 个候选路径各先探目录再探
// 文件、4 个 .env 逐个读 —— 39 次 Tauri IPC 往返一个个加起来。超时一到整份结果作废：
// 钱付了、模型什么也没拿到，下一轮再付一次。这些探测彼此完全独立。
const build = (probeDelayMs, state) => load("_agentProjectServiceHints", {
  _normalizeFsPath: (p) => String(p),
  backend: { readTextFile: async (p) => { if (p.endsWith("package.json")) return "{}"; throw new Error("no"); } },
  _pathExistsAsFile: async () => { state.calls++; state.live++; state.peak = Math.max(state.peak, state.live);
    await new Promise((r) => setTimeout(r, probeDelayMs)); state.live--; return false; },
  _pathExistsAsDir: async () => { state.calls++; state.live++; state.peak = Math.max(state.peak, state.live);
    await new Promise((r) => setTimeout(r, probeDelayMs)); state.live--; return false; },
  _agentFindProjectFiles: async () => [],
  _agentTerminalEntries: () => [],
  _localDevServerUrl: () => "",
});

test("探测并行，不是一个个排队", async () => {
  const st = { calls: 0, live: 0, peak: 0 };
  const t0 = Date.now();
  await build(5, st)("/w");
  const ms = Date.now() - t0;
  assert.ok(st.calls >= 30, `探测次数 ${st.calls}，用例前提变了`);
  // 阈值要卡在"两层都并行"才过：外层 13 个路径并行、内层 dir/file 两次也并行 → 峰值 ≥26。
  // 写成 >5 是不够的——只把外层并行、内层仍串行时峰值是 13，照样通过（实测恒真）。
  assert.ok(st.peak >= 20, `峰值并发只有 ${st.peak} —— 有一层还在排队`);
  assert.ok(ms < st.calls * 5 * 0.4,
    `耗时 ${ms}ms，串行下界约 ${st.calls * 5}ms —— 没有真的并行`);
});

test("单次探测抛异常不许把整份结果炸掉", async () => {
  // 并行之后一条臂 reject 会让 Promise.all 整体 reject；原来的串行版本每次都在 try 里。
  const f = load("_agentProjectServiceHints", {
    _normalizeFsPath: (p) => String(p),
    backend: { readTextFile: async () => { throw new Error("no"); } },
    _pathExistsAsFile: async () => { throw new Error("boom"); },
    _pathExistsAsDir: async () => { throw new Error("boom"); },
    _agentFindProjectFiles: async () => [],
    _agentTerminalEntries: () => [],
    _localDevServerUrl: () => "",
  });
  await assert.doesNotReject(() => f("/w"));
});

test("命中时输出内容和顺序不变", async () => {
  const hit = new Set(["/w/Cargo.toml", "/w/Makefile"]);
  const f = load("_agentProjectServiceHints", {
    _normalizeFsPath: (p) => String(p),
    backend: { readTextFile: async () => { throw new Error("no"); } },
    _pathExistsAsFile: async (p) => hit.has(p),
    _pathExistsAsDir: async () => false,
    _agentFindProjectFiles: async () => [],
    _agentTerminalEntries: () => [],
    _localDevServerUrl: () => "",
  });
  const out = String(await f("/w"));
  const iRust = out.indexOf("Cargo.toml");
  const iMake = out.indexOf("Makefile");
  assert.ok(iRust > 0 && iMake > 0, "命中的标记没出现在输出里");
  assert.ok(iRust < iMake, "顺序变了——并行之后必须靠下标还原原顺序");
});

test("接线：三段都改成并行了", () => {
  assert.match(CODE, /const _markerHits = await Promise\.all\(_MARKERS\.map/);
  assert.match(CODE, /const _knownProbes = await Promise\.all\(_KNOWN_PATHS\.map/);
  assert.match(CODE, /const _envTexts = await Promise\.all\(_ENV_NAMES\.map/);
  assert.doesNotMatch(CODE, /if \(await _pathExistsAsDir\(abs\)\) known\.push/, "候选路径那段还是串行");
});
