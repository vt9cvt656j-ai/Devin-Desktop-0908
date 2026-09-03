// 场景：工具批次里有一项抛异常 —— 其余各项还落不落盘、每个 tool_call 还拿不拿得到结果。
//
// 这条按仓库自己的规矩来（test/E2E-HARNESS-SPEC.md）：
//   「A change is done when the harness completes the task, not when a unit test passes.」
// 单元测试里 execute 是桩；这里跑的是**真执行器**、往**真磁盘**写。
//
// 修之前：runOne 里任何一次没包住的 await 抛出，会穿过 Promise.all 炸出整个 for(iter)，
// 同批其余工具一条结果都进不了 messages —— 转录里有一条带 tool_calls 的 assistant 消息
// 和零条工具结果（不合法），而用户看到一句原生 JS 报错。
import { fileURLToPath as __f2u } from "node:url";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const __HERE = dirname(__f2u(import.meta.url));
const __IDE = join(__HERE, "..", "..");
const S = __HERE + "/";
process.env.__DEEPSTUB_URL = pathToFileURL(S + "deepstub.mjs").href;
register(pathToFileURL(S + "hooks.mjs"));
const { installGlobals } = await import(S + "globals.mjs");
installGlobals();
globalThis.__viteEnv = { DEV: false, PROD: true, MODE: "test", BASE_URL: "/" };
globalThis.__viteGlob = () => ({});
globalThis.__E2E__ = true;
globalThis.fetch = () => Promise.reject(new Error("E2E: network disabled"));
await import(join(__IDE, "src", "main.js"));
const H = globalThis.__testHooks;
const { runOrderedToolSegments } = await import(join(__IDE, "src", "agent", "tool-scheduler.js"));

const ROOT = mkdtempSync(join(tmpdir(), "e2e-sched-"));
const B = H.backend;
B.readTextFile = async (p) => fsp.readFile(p, "utf8");
B.writeTextFile = async (p, c) => { await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, c); return true; };
B.writeTextFileIfUnchanged = async (p, expected, content) => {
  const existsNow = fs.existsSync(p);
  if (expected == null ? existsNow : (!existsNow || fs.readFileSync(p, "utf8") !== expected)) throw new Error("[CONFLICT] file changed after it was read");
  await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, content); return true;
};
B.deleteTextFileIfUnchanged = async (p) => { await fsp.rm(p, { force: true }); return true; };
B.deletePath = async (p) => { await fsp.rm(p, { recursive: true, force: true }); return true; };
B.homeDir = async () => ROOT;
B.createFile = async (p) => { await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, "", { flag: "a" }); return true; };
B.createDir = async (p) => { await fsp.mkdir(p, { recursive: true }); return true; };
B.readDir = async (p) => (await fsp.readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, path: join(p, d.name), isDir: d.isDirectory(), is_dir: d.isDirectory() }));
B.inspectFile = async (p) => { try { const st = await fsp.stat(p); return { exists: true, isDir: st.isDirectory(), size: st.size }; } catch { return { exists: false }; } };

function makeStep() {
  const step = document.createElement("div");
  step.className = "agent-tool-call";
  step.innerHTML = `<div class="agent-tool-row"><span class="atc-name"></span></div><div class="atc-viewport"></div><div class="atc-result"></div>`;
  return step;
}
const mkRun = () => ({ mode: "agent", session: {}, _toolStep: 0, _failedPathAttempts: new Map(), _readSeen: new Map(),
  _readSig: new Map(), _dupReadN: 0, _reqId: "e2e-3", _toolLedger: [], _redactionMap: new Map(),
  _gitRepoHints: new Set(), _browserOpLog: [], _subAgentJobs: [], _scope: null, engineering: {} });

// 一批三项：写 A、一个注定抛异常的、写 C。修改类是硬屏障 → 串行，和真实批次同形。
const items = [
  { id: 0, call: { type: "write", path: "a.txt", content: "A landed\n" }, tc: { id: "tc0" } },
  { id: 1, call: { type: "write", path: "boom.txt", content: "never\n" }, tc: { id: "tc1" }, _explode: true },
  { id: 2, call: { type: "write", path: "c.txt", content: "C landed\n" }, tc: { id: "tc2" } },
];
const toolMsgs = [];
const errs = [];
const run = mkRun();

let escaped = null;
try {
  await runOrderedToolSegments(
    items,
    () => "",                                    // 全是硬屏障：串行，和修改类工具的真实分段一致
    async (it, index) => {
      // 模拟「执行器内部某处抛了一个没被包住的异常」——这正是修之前会炸掉整个 run 的形状。
      if (it._explode) throw new TypeError("Cannot read properties of undefined (reading 'x')");
      const out = await H._executeToolStepInner(makeStep(), it.call, ROOT, run);
      toolMsgs[index] = { role: "tool", tool_call_id: it.tc.id, content: String(out?.content || "") };
    },
    () => true,
    (it, index, error) => {
      errs.push({ index, msg: String(error.message).slice(0, 60) });
      toolMsgs[index] = { role: "tool", tool_call_id: it.tc.id, content: `[ERROR] 这个工具执行时抛出异常，未能完成：${error.message}` };
    },
  );
} catch (e) { escaped = e; }

const ok = (label, cond, extra = "") => { console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra ? "  " + extra : ""}`); return cond; };
console.log("ROOT:", ROOT);
console.log("\n===== 一项抛异常时的批次行为（真执行器 / 真磁盘）=====");
let pass = true;
pass = ok("异常没有冒泡出调度器（修之前这里会炸掉整个 for(iter)）", escaped === null, escaped ? String(escaped.message) : "") && pass;
pass = ok("抛异常之前那一项真的落盘了", fs.existsSync(join(ROOT, "a.txt"))) && pass;
pass = ok("抛异常之后那一项照样落盘了（没被前一项带走）", fs.existsSync(join(ROOT, "c.txt"))) && pass;
pass = ok("抛异常那一项没有落盘", !fs.existsSync(join(ROOT, "boom.txt"))) && pass;
pass = ok("每个 tool_call 都拿到了结果（少一条转录就不合法）", toolMsgs.filter(Boolean).length === 3,
  `实际 ${toolMsgs.filter(Boolean).length}/3`) && pass;
pass = ok("失败那条如实写成 [ERROR]，模型下一轮看得见", /^\[ERROR\]/.test(toolMsgs[1]?.content || "")) && pass;
pass = ok("兜底只被调了一次，且是抛异常的那一项", errs.length === 1 && errs[0].index === 1, JSON.stringify(errs)) && pass;
console.log("\n磁盘实况:", fs.readdirSync(ROOT).join(", "));
console.log(pass ? "\n全部通过" : "\n有失败项");
process.exit(pass ? 0 : 1);
