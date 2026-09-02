import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import JavaScriptObfuscator from "javascript-obfuscator";
import { stripToolIp } from "./build/strip-tool-ip.mjs";
import { stripToolGuidesPlugin } from "./build/strip-tool-guides-plugin.mjs";

// Build-time IP strip: blank tool DESCRIPTION text in `_buildAgentToolSchemas` so the
// shipped bundle carries no tool-library prose. Runtime-neutral (L0 sends only tool
// names; the gateway injects full schemas). Build-only so dev keeps readable sources.
// Runs BEFORE the obfuscator (enforced by plugin order below) and FAILS the build if
// the target function moved/renamed, so a refactor can't silently re-leak the IP.
function stripToolIpPlugin() {
  return {
    name: "strip-tool-ip",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      // 目录字面量 2026-08-25 从 main.js 搬到了 src/agent/tool-catalog.js，两个都要过。
      const path = id.replace(/\\/g, "/");
      const isCatalog = /\/src\/agent\/tool-catalog\.js$/.test(path);
      if (!/\/src\/main\.js$/.test(path) && !isCatalog) return null;
      const { code: out, changed, found } = stripToolIp(code);
      // main.js 里现在只剩组装逻辑（描述已搬走），所以那一侧不再要求剥到东西；
      // **目录模块那一侧才是要保护的**，它必须剥到、而且要剥到足够多。
      if (isCatalog && !found) {
        throw new Error(
          "[strip-tool-ip] 目录字面量在 src/agent/tool-catalog.js 里找不到 —— 剥离没有执行，" +
          "构建出来的包会带着全部工具描述。改了那个文件的结构就要同步 build/strip-tool-ip.mjs。",
        );
      }
      if (isCatalog && changed < 100) {
        throw new Error(
          `[strip-tool-ip] 目录里只剥掉了 ${changed} 条描述（141 条工具，预期远不止），` +
          "多半漏了某一段。拒绝发布一个剥了一半的包。",
        );
      }
      // main.js 那一侧：描述已经搬走，剥到几条都正常，不设阈值也不要求 found。
      // 它仍然要过一遍是因为组装逻辑里还留着少量内联描述（实测 31 条）。
      return { code: out, map: null };
    },
  };
}

// L2 client hardening (anti-reverse): obfuscate OUR application code (`src/**`) in the
// production bundle so the agent's orchestration logic isn't readable in the shipped
// desktop app. Combined with L0 (prompts + tool schemas never leave the gateway), the
// client carries neither the IP text nor legible logic.
//
// Default ON (opt OUT with `OBFUSCATE=0 npm run build`).
// 2026-07-13 postmortem: the first default-on build shipped a DEAD desktop app. Cause:
// the obfuscator moved the `import("@tauri-apps/...")` specifier strings into its
// string array, so vite could no longer statically bundle those dynamic imports; at
// runtime the bare specifiers are unresolvable in the webview and the top-level
// `await tauriBackend()` threw, killing the whole module. Browser smoke tests missed
// it because only `inTauri` code paths execute those imports. Hence:
//   • reservedStrings keeps every "@tauri-apps/..." literal intact for the bundler;
//   • dynamicImportGuard() below FAILS THE BUILD if any emitted app chunk still
//     contains a runtime-computed import(...) specifier.
// Conservative settings only:
//   • renameGlobals OFF  — Tauri/`window` globals & ESM import/export bindings survive.
//   • controlFlowFlattening / selfDefending / debugProtection OFF — these are the
//     breaking + slow transforms; dial them up only after the app runs clean obfuscated.
// node_modules (Monaco / xterm / vendor) are excluded by the plugin's default matcher —
// never obfuscate the big third-party chunks (slow + can break them).
const OBFUSCATE = process.env.OBFUSCATE !== "0";

const obfuscatorOptions = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,           // keep chunk import/export bindings intact
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  // splitStrings OFF: it splits EVERY string literal into concatenated chunks —
  // including the emitted dynamic-import chunk paths (`import("assets/x.js")`) — which
  // turns them into computed specifiers the bundler can't resolve → dead app in Tauri.
  // reservedStrings doesn't exempt strings from splitStrings, so it must stay off when
  // obfuscating a bundled chunk that contains dynamic imports.
  splitStrings: false,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: false,
  deadCodeInjection: false,
  controlFlowFlattening: false,
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  // Keep literal every string the bundler still needs to resolve at runtime:
  //   ^@tauri-apps/  — bare module specifiers for dynamic import()
  //   \.js$          — emitted chunk paths (vite __vite__mapDeps + import("assets/x.js"))
  //   ^assets/ , ^\./ — same chunk-path strings in other forms
  // Without these the obfuscator would move them into its string array and the
  // dynamic import specifier becomes computed → dead app in Tauri.
  reservedStrings: ["^@tauri-apps/", "\\.js$", "^assets/", "^\\./"],
};

const COMPUTED_IMPORT_RE = /import\(\s*[^"'`)\s]/;

// Packages reachable ONLY from globe.gl / three (see manualChunks below for why this is an
// explicit list and how to regenerate it). `tslib` is intentionally excluded: it is shared
// with other runtime dependencies and belongs in `vendor`.
const THREE_GLOBE_TREE = new Set([
  "@babel/runtime", "@turf/boolean-point-in-polygon", "@turf/helpers", "@turf/invariant",
  "@tweenjs/tween.js", "@types/geojson", "accessor-fn", "d3-array", "d3-color",
  "d3-delaunay", "d3-format", "d3-geo", "d3-geo-voronoi", "d3-interpolate", "d3-octree",
  "d3-scale", "d3-scale-chromatic", "d3-selection", "d3-time", "d3-time-format",
  "d3-tricontour", "data-bind-mapper", "delaunator", "earcut", "float-tooltip",
  "frame-ticker", "globe.gl", "h3-js", "index-array-by", "internmap", "kapsule",
  "lodash-es", "point-in-polygon-hao", "polished", "preact", "robust-predicates",
  "simplesignal", "three", "three-conic-polygon-geometry", "three-geojson-geometry",
  "three-globe", "three-render-objects", "three-slippy-map-globe", "tinycolor2",
]);

// Obfuscate OUR app entry chunks AFTER the whole build is written to disk. This has
// to happen in `writeBundle`, not `transform`/`renderChunk`: under vite 8 / rolldown
// both earlier hooks get their output re-minified by rolldown's built-in pass, which
// stripped the obfuscation right back out (verified: shipped bundles had zero
// string-array/`_0x` markers even with the plugin "running"). writeBundle is the last
// word — nothing runs after it, so what we write here is exactly what ships.
// Scope: only main-*/overlay-* (our code). Never touch vendor/monaco/xterm chunks —
// obfuscating those is slow and breaks them. Fails the build if obfuscation would
// break a dynamic import (dead app in Tauri) or if it silently produced no markers.
function obfuscateAppChunks() {
  return {
    name: "obfuscate-app-chunks",
    apply: "build",
    enforce: "post",
    async writeBundle(options, bundle) {
      if (!OBFUSCATE) return;
      const fs = await import("node:fs");
      const path = await import("node:path");
      const outDir = options.dir || "dist";
      for (const fileName of Object.keys(bundle)) {
        const chunk = bundle[fileName];
        if (chunk.type !== "chunk") continue;
        if (!/^(main|overlay)-/.test(fileName.replace(/^assets\//, ""))) continue;
        const full = path.resolve(outDir, fileName);
        let src = fs.readFileSync(full, "utf8");
        // rolldown emits dynamic imports as TEMPLATE literals: import(`./x-hash.js`).
        // javascript-obfuscator's reservedStrings only exempts plain string literals,
        // not template literals, so it would transform these paths → computed import →
        // dead app. Convert the STATIC (no ${…}) ones to plain strings first; then the
        // reservedStrings patterns (^\./ , \.js$) protect them through obfuscation.
        src = src.replace(/import\(`([^`$]+)`\)/g, 'import("$1")');
        const out = JavaScriptObfuscator.obfuscate(src, obfuscatorOptions).getObfuscatedCode();
        if (!/_0x[0-9a-f]/.test(out)) {
          throw new Error(`[obfuscate] ${fileName}: obfuscation produced no markers — refusing to ship an unobfuscated bundle.`);
        }
        if (COMPUTED_IMPORT_RE.test(out)) {
          throw new Error(`[obfuscate] ${fileName}: obfuscation broke a dynamic import() specifier (would be a dead app in Tauri). Check reservedStrings.`);
        }
        fs.writeFileSync(full, out);
      }
    },
  };
}

// Build-time invariant: every dynamic import in OUR chunks must have a literal
// specifier ("..." or `...`), i.e. something the bundler already resolved. A
// computed specifier means a transform (obfuscator or otherwise) destroyed one —
// that ships as a dead app in Tauri, so fail the BUILD, not the user.
function dynamicImportGuard() {
  const COMPUTED_IMPORT_RE = /import\(\s*[^"'`)\s]/;
  return {
    name: "dynamic-import-guard",
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        if (!/^assets\/(main|overlay)-/.test(fileName)) continue; // only our app entries
        if (COMPUTED_IMPORT_RE.test(chunk.code)) {
          throw new Error(
            `[dynamic-import-guard] ${fileName} contains a runtime-computed import(...) specifier — ` +
            "the bundler could not resolve it statically (an obfuscator/transform likely rewrote the " +
            "import string). This would ship a dead app in Tauri. Fix the transform (e.g. add the " +
            "specifier to obfuscatorOptions.reservedStrings) instead of shipping.",
          );
        }
      }
    },
  };
}

// Build-time invariant: the three.js/globe tree must stay OFF the startup path.
//
// Splitting it into its own chunk is only half the job — the half that silently regresses
// is the other direction. If any package that imports `three` is missing from
// THREE_GLOBE_TREE it lands in `vendor`, `vendor` then *statically* imports three3d, and
// because index.html modulepreloads vendor the whole 2 MB is back on cold start while the
// build still looks correct (a three3d chunk exists, the app runs). Same outcome if the
// entry HTML ever preloads three3d directly.
//
// So assert both directions: nothing eagerly loaded may reference three3d, and three3d
// must actually exist as long as globe.gl is a dependency.
function threeChunkGuard() {
  return {
    name: "three-chunk-guard",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle);
      const three3d = names.filter((n) => /^assets\/three3d-/.test(n));
      if (three3d.length === 0) {
        throw new Error(
          "[three-chunk-guard] no three3d chunk was emitted — manualChunks no longer matches " +
          "the globe/three tree (a dependency rename?). Without it the 2 MB tree is folded " +
          "back into `vendor`, which index.html modulepreloads, and every cold start pays for " +
          "a panel most users never open.",
        );
      }
      for (const [fileName, chunk] of Object.entries(bundle)) {
        // Only chunks that are themselves eagerly loaded can drag three3d into startup.
        // `vendor` and the entry chunks are modulepreloaded; three3d's own facade is not.
        if (chunk.type !== "chunk") continue;
        if (!/^assets\/(vendor|rolldown-runtime|main|overlay|tailwind)-/.test(fileName)) continue;
        const eager = (chunk.imports || []).filter((i) => /three3d-/.test(i));
        if (eager.length) {
          throw new Error(
            `[three-chunk-guard] ${fileName} statically imports ${eager.join(", ")} — the ` +
            "globe/three tree is back on the startup path. A package that imports `three` is " +
            "missing from THREE_GLOBE_TREE in this file (check for new transitive deps of " +
            "three-globe, which declare `three` as a peerDependency). Add it and rebuild.",
          );
        }
      }
      const html = bundle["index.html"];
      if (html && html.type === "asset" && /three3d-/.test(String(html.source))) {
        throw new Error(
          "[three-chunk-guard] index.html references the three3d chunk (modulepreload or " +
          "script tag) — it must only be reachable through the lazy import in main.js.",
        );
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  // The app's own version, so the desktop heartbeat can tell the gateway which build is
  // running. Read from package.json at build time rather than hardcoded, because a
  // second place to bump is a place that gets forgotten.
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version,
    ),
  },
  plugins: [
    // enforce:"pre" → tool-IP strip runs before bundling.
    stripToolIpPlugin(),
    // 同上，剥 src/tool-guides.js 的 TOOL_METADATA / TOOL_EXAMPLES 散文。
    //
    // **这个插件 2026-08-27 就写好了，但一直没接进来**（引入它的那笔提交里没有
    // vite.config.js），于是 143 个工具的完整使用说明整份跟着发布包出门。用仓里自己的
    // 解码器（build/bundle-strings.mjs）读 dist/assets/main-*.js 实测：16,782 条字符串里，
    // 两个探针各命中 93 条和 61 条；接上之后同样的探针是 0 和 0。
    // 明文 grep 只看得到 44 和 0 —— 混淆器把约四分之三的字面量搬进了编码字符串表，
    // 以明文为判据的泄漏检查对大部分泄漏面**结构性失明**，而且是安静地失明。
    // 两者都是 enforce:"pre"，顺序无关（见 build/strip-tool-guides-plugin.mjs 文件头）。
    stripToolGuidesPlugin(),
    // React islands: shadcn components mounted into the existing vanilla shell.
    // Only touches .jsx/.tsx — src/main.js has no JSX, so the 59k-line shell is not
    // transformed and its 907 source-text test assertions keep matching.
    react(),
    // Tailwind v4. Preflight is deliberately NOT imported (see src/ui/tailwind.css):
    // its reset would restyle every element in 14,111 lines of existing CSS.
    tailwindcss(),
    // writeBundle → obfuscate the final emitted app chunks.
    // React/Radix land in `vendor` (see manualChunks), which this never touches.
    obfuscateAppChunks(),
    // generateBundle → assert dynamic imports survived (runs after obfuscation).
    dynamicImportGuard(),
    // generateBundle → assert the globe/three tree stayed off the startup path.
    threeChunkGuard(),
  ],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    // Monaco's core (editor.api) is an inherently large, unsplittable vendor
    // chunk (~2.3 MB). Size the threshold to clear it while still flagging any
    // unexpected growth in the application bundle.
    chunkSizeWarningLimit: 2400,
    rollupOptions: {
      // overlay.html = the red-glow "controlling the computer" overlay window. Second HTML
      // entry so it's emitted to dist/ for the production build (dev serves it directly).
      input: { main: "index.html", overlay: "overlay.html" },
      output: {
        manualChunks(id) {
          // Let Vite keep splitting Monaco languages into on-demand chunks —
          // returning undefined here preserves that lazy behaviour.
          if (id.includes("monaco-editor")) return;
          if (id.includes("@xterm")) return "xterm";
          // three.js + globe.gl and their entire private dependency tree.
          //
          // MUST come before the node_modules catch-all. src/main.js:39073 already loads
          // the memory-centre globe lazily (`await Promise.all([import("globe.gl"),
          // import("three")])`), but with everything under node_modules folded into
          // `vendor` that laziness was decorative: the emitted globe.gl chunk was a
          // 73-byte re-export stub and the real 2.02 MB lived in `vendor`, which
          // index.html modulepreloads. Measured 2026-08-22: vendor 2,442,537 B, of which
          // ~2.02 MB is this tree — about 27% of the JS parsed on every cold start, for a
          // panel most users never open.
          //
          // An explicit package list, not a regex: the tree includes names a
          // "three-*" pattern misses (three-geojson-geometry, three-slippy-map-globe are
          // dependencies of three-globe that declare three as a *peer*), and missing one
          // leaves it in vendor, which then statically imports three3d and drags the whole
          // chunk back into startup — the exact failure the split is meant to avoid.
          //
          // Regenerate after any dependency change: walk `dependencies` transitively from
          // ["globe.gl","three"], then subtract the closure of every other direct
          // dependency. tslib is deliberately absent — it is shared with other packages
          // and must stay in vendor.
          if (id.includes("node_modules")) {
            const norm = id.replace(/\\/g, "/");
            const rest = norm.slice(norm.lastIndexOf("node_modules/") + 13);
            const seg = rest.split("/");
            const name = seg[0].startsWith("@") ? `${seg[0]}/${seg[1]}` : seg[0];
            if (THREE_GLOBE_TREE.has(name)) return "three3d";
            return "vendor";
          }
        },
      },
    },
  },
});
