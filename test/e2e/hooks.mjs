import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const STUB = "stub:";
const DEEP = new Set(["monaco-editor","@xterm/xterm","@xterm/addon-fit","@xterm/addon-webgl","@xterm/addon-web-links","three","3d-force-graph","globe.gl","three-spritetext","@neftaly/editcontext-polyfill"]);
export async function resolve(spec, ctx, next) {
  if (/\?(worker|raw|url|inline)$/.test(spec)) return { url: STUB + "worker", shortCircuit: true, format: "module" };
  // React 挂载岛（src/ui/*.jsx）一律桩掉：工具执行器不依赖它们，而 Node 的 ESM 加载器
  // 也不会解析 JSX。
  //
  // **这里原来是写死的一个文件名**（只桩了 mount-gallery.jsx）。后来 main.js 又加了
  // 五个 .jsx 导入，台子当场 ERR_UNKNOWN_FILE_EXTENSION 跑不起来 —— 而它被刻意排除在
  // `npm test` 之外，所以烂了很久、测试一直全绿。同一个形状（手工维护的清单跟不上代码）
  // 这个仓库已经踩过好几次，所以这次改成按后缀通配，桩的导出名从真文件里现读，
  // 再加一个也不用回来改这里。
  if (/\.jsx$/.test(spec) && /\/src\/main\.js$/.test(ctx.parentURL || "")) {
    return { url: STUB + "jsx:" + new URL(spec, ctx.parentURL).href, shortCircuit: true, format: "module" };
  }
  if (/\.(css|scss|less|svg|png|jpg|jpeg|gif|woff2?|ttf)(\?.*)?$/.test(spec)) return { url: STUB + "asset", shortCircuit: true, format: "module" };
  for (const d of DEEP) if (spec === d || spec.startsWith(d + "/")) return { url: STUB + "deep:" + spec, shortCircuit: true, format: "module" };
  try { return await next(spec, ctx); }
  catch (e) { console.error("[hooks] UNRESOLVED:", spec, "from", ctx.parentURL, "->", e.code || e.message); throw e; }
}
export async function load(url, ctx, next) {
  if (url === STUB + "worker") return { format: "module", shortCircuit: true, source: "export default class StubWorker { constructor(){this.onmessage=null;} postMessage(){} terminate(){} addEventListener(){} removeEventListener(){} }" };
  if (url === STUB + "ui-gallery") return { format: "module", shortCircuit: true, source: "export {};" };
  if (url === STUB + "asset") return { format: "module", shortCircuit: true, source: "export default {}; export const __asset=true;" };
  if (url.startsWith(STUB + "deep:")) {
    const name = url.slice((STUB + "deep:").length);
    return { format: "module", shortCircuit: true, source:
      `import { mk, mkMonaco } from ${JSON.stringify(process.env.__DEEPSTUB_URL)};\n` +
      `const R = ${name === "monaco-editor" ? "mkMonaco()" : `mk(${JSON.stringify(name)})`};\n` +
      `export default R;\n` +
      `export const __ns = R;\n` +
      // named exports the app actually destructures
      `export const Terminal = R.Terminal, FitAddon = R.FitAddon, WebglAddon = R.WebglAddon, WebLinksAddon = R.WebLinksAddon;\n` +
      `export const editor = R.editor, languages = R.languages, Uri = R.Uri, Range = R.Range, Position = R.Position, KeyMod = R.KeyMod, KeyCode = R.KeyCode, MarkerSeverity = R.MarkerSeverity, Selection = R.Selection, Emitter = R.Emitter, CancellationTokenSource = R.CancellationTokenSource;\n` };
  }
  if (url.startsWith(STUB + "jsx:")) {
    // ESM 的具名导入在**链接期**就要求名字存在，所以不能返回一个空模块了事 ——
    // 得把真文件里的导出名读出来，逐个给一个空实现。正则够用：这些挂载岛都是
    // 顶层 `export function X` / `export const X` 的直白写法，而且读错了只会在
    // 链接期立刻报名字缺失，不会静默跑出错误结果。
    const file = fileURLToPath(url.slice((STUB + "jsx:").length));
    let names = [];
    let hasDefault = false;
    try {
      const src = readFileSync(file, "utf8");
      names = [...src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(",")) {
          const as = part.split(/\s+as\s+/).pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(as) && as !== "default") names.push(as);
        }
      }
      hasDefault = /^\s*export\s+default\b/m.test(src);
    } catch { /* 文件读不到就退化成空模块：链接期会如实报缺哪个名字 */ }
    const uniq = [...new Set(names)];
    return { format: "module", shortCircuit: true, source:
      uniq.map((n2) => `export function ${n2}() {}`).join("\n")
      + (hasDefault ? "\nexport default function () {}" : "")
      + "\nexport const __jsxStub = true;\n" };
  }
  if (/\.json$/.test(url)) return { format: "module", shortCircuit: true, source: "export default " + readFileSync(fileURLToPath(url), "utf8") + ";" };
  const r = await next(url, ctx);
  if (/\/src\/main\.js$/.test(url) && r.source) {
    let s = r.source.toString();
    s = s.replace(/import\.meta\.glob/g, "globalThis.__viteGlob").replace(/import\.meta\.env/g, "globalThis.__viteEnv");
    // TEST HOOK: append module-scope export of the real executor. Loader-only, so the
    // shipped src/main.js is byte-for-byte unchanged in production.
    s += "\n\n/* __E2E_HOOK__ */\nif (globalThis.__E2E__) { globalThis.__testHooks = { _executeToolStepInner, backend, _normalizeFsPath, _resolveRel, _toolFailureKey, _resetToolFailure, setMode: (m)=>{ _currentAiMode = m; }, getMode: ()=>_currentAiMode, _runAgenticLoop, _harnessNudgesEnabled, addMessage, _currentSession, _chatSessions,\n    // 把模型轮换成桩：`async function` 的绑定在模块内可重新赋值，而循环是按名字调它的。\n    // 这是整个循环测试台的支点 —— 没有它就只能真发请求（要钱、非确定、还没法构造剧本）。\n    setModelTurn: (fn) => { _agentModelTurn = fn; },\n    getNudgeStats: () => globalThis.__nudgeStats };\n  try { globalThis.__testHooks.extra = { showToast, _fsDelta: typeof _fsDelta }; } catch (e) { globalThis.__testHookErr = e.message; } }\n";
    return { ...r, source: s };
  }
  return r;
}
