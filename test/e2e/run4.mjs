// 循环测试台：用桩模型喂固定剧本，量「harness 到底逼出了多少额外轮次」。
//
// 为什么需要它：这个循环里 harness 对模型说的话有 34 类、40 个注入点，每条都是
// 「你还应该再做点什么」；而 Claude Code 的循环里这个数是 **0**。用户报的
// 「简单事情也长篇大论 / 一个任务 27 步 / 190 万输入 token」很可能就是它们叠出来的。
// 但**从来没人量过**——没有数据就删是拍脑袋，留着就是继续挨骂。
//
// 这个台子给出的读数：剧本给了 N 轮，循环实际要了 M 轮。**M − N 就是被提醒逼出来的**，
// 每一轮都是一次真实的付费模型调用。开着跑一遍、关掉跑一遍，差值就是那 34 类的代价。
//
// 桩模型的支点是 hooks.mjs 里的 setModelTurn：`async function` 的绑定在模块内可重新
// 赋值，而循环是按名字调它的。没有这个口就只能真发请求（要钱、非确定、还没法构造剧本）。
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDE = join(HERE, "..", "..");
process.env.__DEEPSTUB_URL = pathToFileURL(join(HERE, "deepstub.mjs")).href;
register(pathToFileURL(join(HERE, "hooks.mjs")));
const { installGlobals } = await import(join(HERE, "globals.mjs"));
installGlobals();
globalThis.__viteEnv = { DEV: false, PROD: true, MODE: "test", BASE_URL: "/" };
globalThis.__viteGlob = () => ({});
globalThis.__E2E__ = true;
globalThis.fetch = () => Promise.reject(new Error("E2E: network disabled"));
await import(join(IDE, "src", "main.js"));
const H = globalThis.__testHooks;

const ROOT = mkdtempSync(join(tmpdir(), "e2e-loop-"));
const B = H.backend;
B.readTextFile = async (p) => fsp.readFile(p, "utf8");
B.writeTextFile = async (p, c) => { await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, c); return true; };
B.writeTextFileIfUnchanged = async (p, expected, content) => {
  const ex = fs.existsSync(p);
  if (expected == null ? ex : (!ex || fs.readFileSync(p, "utf8") !== expected)) throw new Error("[CONFLICT] file changed after it was read");
  await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, content); return true;
};
B.deleteTextFileIfUnchanged = async (p) => { await fsp.rm(p, { force: true }); return true; };
B.deletePath = async (p) => { await fsp.rm(p, { recursive: true, force: true }); return true; };
B.homeDir = async () => ROOT;
B.createFile = async (p) => { await fsp.mkdir(join(p, ".."), { recursive: true }); await fsp.writeFile(p, "", { flag: "a" }); return true; };
B.createDir = async (p) => { await fsp.mkdir(p, { recursive: true }); return true; };
B.readDir = async (p) => (await fsp.readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, path: join(p, d.name), isDir: d.isDirectory(), is_dir: d.isDirectory() }));
B.inspectFile = async (p) => { try { const st = await fsp.stat(p); return { exists: true, isDir: st.isDirectory(), size: st.size }; } catch { return { exists: false }; } };

let seq = 0;
const tc = (name, args) => ({ id: "tc" + (++seq), name, parsedArgs: args, argsRaw: JSON.stringify(args) });

/** 一次典型的工程活：写文件 → 跑测试 → 改一处 → 再跑 → 收尾。剧本给 5 轮。 */
const SCRIPT = [
  { text: "先建一个模块。", toolCalls: [tc("write_file", { path: "calc.py", content: "def add(a,b):\n    return a-b\n" })] },
  { text: "跑一下测试。", toolCalls: [tc("run_cmd", { command: "echo 'FAILED: expected 3 got -1' && exit 1" })] },
  { text: "看到了，减号写成了加号。", toolCalls: [tc("edit_file", { path: "calc.py", old_string: "return a-b", new_string: "return a+b" })] },
  { text: "再跑一次。", toolCalls: [tc("run_cmd", { command: "echo 'OK 1 passed'" })] },
  { text: "改好了：calc.py 里 add 之前写成了减法，已修正，测试通过。", toolCalls: [] },
];

async function once(nudgesOn) {
  try { globalThis.localStorage.setItem("michael-ide.harness-nudges", nudgesOn ? "on" : "off"); } catch {}
  let asked = 0;
  H.setModelTurn(async () => {
    const s = SCRIPT[Math.min(asked, SCRIPT.length - 1)];
    asked++;
    // 剧本用完之后一律「没有工具调用」——模型说它做完了。循环若还要更多轮，
    // 那就是 harness 在推翻模型的收尾决定，正是要量的东西。
    return asked > SCRIPT.length
      ? { text: "确实做完了。", reasoning: "", toolCalls: [], error: null }
      : { text: s.text, reasoning: "", toolCalls: s.toolCalls.map((x) => ({ ...x })), error: null };
  });
  const messages = [{ role: "user", content: "把 calc.py 里的加法修好，跑通测试。" }];
  const t0 = Date.now();
  try {
    await H._runAgenticLoop({
      config: { model: "stub", baseUrl: "http://x", apiKey: "k" },
      messages, root: ROOT, session: null, mode: "agent", task: "把 calc.py 里的加法修好，跑通测试。",
    });
  } catch (e) { return { error: String(e.message).slice(0, 160) }; }
  const st = globalThis.__nudgeStats || {};
  return {
    ms: Date.now() - t0,
    scripted: SCRIPT.length,
    asked,
    extra: asked - SCRIPT.length,
    msgs: messages.length,
    nudgeAttempts: st.attempts || 0,
    suppressed: st.suppressed || 0,
    counts: st.counts || {},
  };
}

const on = await once(true);
try { fs.rmSync(join(ROOT, "calc.py"), { force: true }); } catch {}
const off = await once(false);

const row = (label, r) => {
  if (r.error) { console.log(`  ${label}: 抛了 — ${r.error}`); return; }
  console.log(`  ${label.padEnd(10)} 模型轮=${String(r.asked).padStart(2)} (剧本 ${r.scripted}，多要 ${r.extra})  ` +
    `上下文消息=${String(r.msgs).padStart(3)}  提醒注入=${String(r.nudgeAttempts).padStart(2)}  耗时=${r.ms}ms`);
  const c = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  if (c.length) console.log(`             明细: ${c.map(([k, v]) => `${k}:${v}`).join(" ")}`);
};

console.log("\n===== 循环测试台：同一份剧本，开/关 harness 提醒 =====");
console.log(`  工作区: ${ROOT}`);
row("提醒开", on);
row("提醒关", off);
if (!on.error && !off.error) {
  console.log(`\n  差值：模型轮 ${on.asked} → ${off.asked}（少 ${on.asked - off.asked} 次付费调用），` +
    `上下文 ${on.msgs} → ${off.msgs} 条`);
  console.log(`  文件最终内容: ${JSON.stringify(fs.existsSync(join(ROOT, "calc.py")) ? fs.readFileSync(join(ROOT, "calc.py"), "utf8") : "(不存在)")}`);
}
process.exit(0);
