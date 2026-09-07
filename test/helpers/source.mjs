// Shared accessors for the src/main.js source text used by the source-assertion tests.
//
// Why this exists: dozens of tests assert `assert.match(SRC, /…/)` to prove that a
// contract (a routing hint, a prompt line, a guard) is really present in the shipped
// code. Raw source text also contains COMMENTS, so a contract that was deleted from the
// code but left behind in a comment keeps every one of those assertions green. That trap
// has already fired here: five tool-contract assertions stayed green off a comment line
// that literally labelled itself "兼容旧提示契约" after the text had been removed from
// the model-visible channel.
//
// `CODE` is the same file with every comment blanked out — byte offsets and line numbers
// are preserved, so failure output still points at the right line. String and template
// literals and regex literals are untouched, so prompt text living inside a template
// literal still matches. Positive assertions ("this contract must exist") belong on CODE.
// `SRC` stays available for the handful of assertions that deliberately inspect comments.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acorn from "acorn";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAIN_PATH = join(HERE, "../../src/main.js");

/** Raw main.js text, comments included. Only for assertions that target comments. */
/**
 * 「客户端源码」现在**跨多个文件**：main.js 加上从它抽出去的那些模块。
 *
 * 这里必须把它们拼起来，否则每抽出去一块，一大批按源文本断言的测试就会以
 *「这段代码不见了」的形式集体假红——实测抽工具目录那一次直接红了 161 条。
 * 它们断言的是「产品里有没有这段代码」，而代码搬到隔壁文件并不改变这个事实。
 *
 * 拼接顺序：main.js 在前（大量断言依赖它内部的前后顺序），模块按文件名排在后面，
 * 每块之间插一行分隔注释，免得两个文件的收尾和开头在正则里粘成一句。
 *
 * **注意**：这只让「这段代码在不在」这类断言继续成立。要验行为，请直接
 * `import` 那个模块——抠源码验得到行为，验不到「它在真实调用链上还在不在」。
 */
const AGENT_DIR = join(dirname(MAIN_PATH), "agent");
export const SRC = [
  readFileSync(MAIN_PATH, "utf8"),
  ...readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      // 拼进来之前把 `import …` 整行和 `export ` 前缀去掉。
      //
      // 不去的话 acorn 解析这份拼接文本会撞上重复声明——main.js `import { X }` 而模块里
      // `export const X`，同一份文本里就是两个 X（实测 USER_TOOL_PREFIX 直接把 155 个
      // 测试文件打成解析失败）。这份拼接的用途只有一个：让「产品里有没有这段代码」
      // 这类**文本**断言在代码搬家之后继续成立，所以去掉模块语法不影响它要回答的问题。
      const body = readFileSync(join(AGENT_DIR, f), "utf8")
        .split("\n")
        // 整行去掉：`import …` 和纯再导出的 `export { … }`（后者去掉 export 之后
        // 会剩一个裸的块语句，形状变了；直接丢更干净）。
        .filter((line) => !/^\s*import\s/.test(line) && !/^\s*export\s*\{/.test(line))
        // 前缀去掉：`export default X` / `export const|let|function|class|async …`。
        .map((line) => line
          .replace(/^(\s*)export\s+default\s+/, "$1")
          .replace(/^(\s*)export\s+/, "$1"))
        .join("\n");
      // 再包一层块作用域：只去模块语法还不够——main.js 那边 `import { X }` 的绑定
      // 和模块里的 `const X` 仍然在同一份顶层文本里撞名。包进 `{}` 之后 const/let/class
      // 都成了块级声明，谁也不撞谁，而**文本一个字没变**，正则该匹配的照样匹配。
      return `\n// ==== src/agent/${f} ====\n{\n` + body + "\n}\n";
    }),
].join("\n");

/**
 * Blank out every comment in `source`, preserving length and line breaks so offsets and
 * line numbers stay identical to the original.
 */
export function stripComments(source) {
  const ranges = [];
  acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    onComment(_block, _text, start, end) { ranges.push([start, end]); },
  });
  if (!ranges.length) return source;
  const out = source.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    }
  }
  return out.join("");
}

/** main.js with all comments blanked out. Use this for positive source assertions. */
/**
 * 工具目录的**源码文本**（src/agent/tool-catalog.js）。
 *
 * 141 条 schema 的字面量已经从 `_buildAgentToolSchemas` 搬进那个模块，所以
 * `extractFn("_buildAgentToolSchemas")` 现在只拿得到组装逻辑，捞不到任何一条 schema。
 * 按源文本断言 schema 的地方改用这个。
 *
 * **不过更好的做法是直接 import 那个模块**：`baseTools()` 等三个 getter 返回的是
 * 数据结构，`.find(t => t.function.name === "x")` 比正则可靠得多。这个导出只是给
 * 存量断言用的过渡。
 */
export const TOOL_CATALOG_SRC = readFileSync(join(dirname(MAIN_PATH), "agent", "tool-catalog.js"), "utf8")
  // 去掉 `export ` 前缀：这份文本会被塞进 `new Function` 跑，而那里面不允许模块语法。
  // 文本内容不变，正则该匹配的照样匹配。
  .replace(/^(\s*)export\s+/gm, "$1");

export const CODE = stripComments(SRC);

export function decodeXd(encoded) {
  const k = [0x4D, 0x52, 0x44, 0x41, 0x59];
  const b = Buffer.from(encoded, "base64");
  for (let i = 0; i < b.length; i++) b[i] ^= k[i % k.length];
  return b.toString("utf8");
}

export function allDecodedStrings(text) {
  const re = /_xd\("([A-Za-z0-9+/=]+)"\)/g;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    try { results.push(decodeXd(m[1])); } catch {}
  }
  return results;
}

// ---------------------------------------------------------------------------
// 按名字取真源码：整个 test/ 目录唯一的一份提取器
// ---------------------------------------------------------------------------
//
// 在这之前 test/ 下有 16 份手抄副本、4 种互不相同的语义（朴素计括号、找 "\n}\n" 收尾、
// 逐字符跳注释和字符串、acorn）。它们不只是重复代码，是四种不同的「函数体是什么」：
//   · 朴素计括号那几份不认字符串字面量。实测 capabilities-wiring 用它抽 _executeToolStepInner，
//     抽到 1,040,765 字节，真函数只有 406,715——main.js 里一句 `t.startsWith("{")` 让计数差 1，
//     于是多跑了一万四千行。那个用例当时仍然绿，纯属它断言的分支恰好落在真函数体内。
//     截断的那一侧会把 new Function 炸成看不懂的 SyntaxError；跑过头的那一侧会让
//     「函数体里不得出现 X」这类反向断言看见别人的代码，可能假红也可能假绿。
//   · 找 "\n}\n" 的那几份挑的是排版，不是语法。
//   · 于是修一个提取 bug 要同时改九个文件，历史上就出现过「只修了 mcp/skills 那两份」的分叉。
//
// 这里只有一条实现：acorn 解析整份 main.js，按 AST 节点边界切。注释、字符串、模板、正则
// 一概不可能干扰，async 天然带上，FunctionDeclaration 和 `const 名 = 箭头` 两种都认。
//
// 切的是 SRC（原文）而不是 CODE：抽出来的东西要能 new Function 跑起来，也要能被
// 「源码里必须写着这一行」的断言匹配。要在剥了注释的文本上断言，传 { code: true }。
const _ast = acorn.parse(SRC, {
  ecmaVersion: "latest",
  sourceType: "module",
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
});

/**
 * 测试里要把生产常量换掉的地方。
 *
 * 名字进了这张表，`load()` 解析依赖时就不再回 main.js 抓真值，而是拼一条字面量声明。
 * 覆盖发生在**依赖解析这一层**，用例代码一个字都不用改。
 *
 * _AI_MODEL_RETRY_DELAY_MS 在 main.js 里是 2_000，退避是 equal jitter：等 [base/2, base]。
 * model-resume 那条「没出过字 → 走重试」的用例守的是走哪条分支，和退避时长毫无关系，
 * 却因为依赖是从 main.js 原样抓的而真睡一次随机 1–2 秒——整个套件最慢的一条，而且每次
 * 时长都不一样，看 duration 根本发现不了真正变慢的测试。退避曲线本身在 logic.test.mjs
 * 里另有专测（那里手工注入 120ms，正是这个机制的特例）。
 */
export const OVERRIDES = { _AI_MODEL_RETRY_DELAY_MS: 1 };

/** 从一批语句里按名字找声明（认 export 包一层的写法）。 */
function _scanStatements(body, name) {
  const hits = [];
  for (const stmt of body) {
    const node =
      stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
    if (!node) continue;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) hits.push({ fn: node });
    else if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id?.type === "Identifier" && d.id.name === name && d.init) hits.push({ varDecl: d });
      }
    }
  }
  return hits;
}

/** 整棵树走一遍找同名声明：main.js 里有真正嵌套在别的函数里的声明。 */
function _scanEverywhere(name) {
  const hits = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    if (typeof node.type !== "string") return;
    seen.add(node);
    if (node.type === "FunctionDeclaration" && node.id?.name === name) hits.push({ fn: node });
    else if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id?.type === "Identifier" && d.id.name === name && d.init) hits.push({ varDecl: d });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk(node[key]);
    }
  };
  walk(_ast);
  return hits;
}

function _declFor(name) {
  // 顶层优先。顶层没有就整棵树扫——老的 indexOf 版本抓的是文件里第一处 `function 名(`，
  // 全文唯一时这里给出同一个答案；不唯一就当场报歧义，而不是随手挑一个。
  const top = _scanStatements(_ast.body, name);
  if (top.length) return top[0];
  const nested = _scanEverywhere(name);
  if (nested.length === 1) return nested[0];
  if (nested.length > 1) {
    const at = nested.map((d) => (d.fn ?? d.varDecl).start).join(", ");
    throw new Error(`main.js 里 ${name} 有 ${nested.length} 处同名声明（offset ${at}），按名字取源码是歧义的`);
  }
  return null;
}

/**
 * 按名字取一段声明的源码。
 *
 * - `function 名(…) {…}` / `async function 名(…) {…}` → 整段原文（async 前缀在内）
 * - `const 名 = …`（箭头函数或任何值）→ 重新拼成 `const 名 = <初始化表达式>;`
 *
 * @param {string} name
 * @param {{ code?: boolean }} [opts] code:true 时从 CODE（注释置空的那份）里切，
 *   用于对函数体做正向源码断言——注释里引用一段已经删掉的旧代码就能把断言喂绿。
 */
export function fnSource(name, { code = false } = {}) {
  const found = _declFor(name);
  if (!found) throw new Error(`main.js 里找不到声明 ${name}`);
  const text = code ? CODE : SRC;
  if (found.fn) return text.slice(found.fn.start, found.fn.end);
  const d = found.varDecl;
  return `const ${name} = ${text.slice(d.init.start, d.init.end)};`;
}

/**
 * 取「以某段源码起头的那个语法结构」的完整源码。
 *
 * fnSource 按**名字**取声明，够不着三类锚点：调度分支
 * （`} else if (call.type === "browser") {`）、回调注册（`el.addEventListener("scroll", …)`）、
 * 函数内部的局部块。这些地方历来写成
 *     SRC.slice(RAW_SRC.indexOf(锚点), RAW_SRC.indexOf(锚点) + 2000)
 * 两个毛病：
 *   · **固定字符数**——被守的那段一变长，窗口尾部就滑出去，断言从此守的是别的东西；
 *   · **锚点不唯一时 indexOf 闷声挑第一个**——本仓有个锚点在源码里出现 16 次。
 *
 * 这里两条都堵掉：区间由 AST 节点边界决定（长多少都盖得住），锚点不唯一就**当场抛错**。
 * 判据是「锚点最后一个字符落在哪个最小节点里」——`} else if (…) {` 的最后一个字符
 * 正是该分支块的 `{`，于是取到的就是这个分支的完整块。
 *
 * @param {string} anchor 源码里的一段字面文本（含它结尾的 `{` 时最准）
 * @param {{ code?: boolean, nth?: number, enclosing?: boolean }} [opts]
 *   code:true 从剥了注释的那份切（做正向断言时用，免得匹配到注释里引用的旧代码）；
 *   nth 只在确实存在多处同形锚点、且你明确要第 n 个时才传（从 0 数）；
 *   enclosing:true 取**包住锚点的那个函数体**，而不是锚点自己所在的最小节点——
 *   锚点是一行普通语句（`if (…) return;`）而你想要整个回调时用它。不加的话
 *   `blockFrom("… return;")` 只会还给你那条 return 语句本身。
 */
export function blockFrom(anchor, { code = false, nth = null, enclosing = false } = {}) {
  const hits = [];
  for (let i = SRC.indexOf(anchor); i >= 0; i = SRC.indexOf(anchor, i + 1)) hits.push(i);
  if (!hits.length) throw new Error(`源码里找不到锚点：${JSON.stringify(anchor.slice(0, 80))}`);
  if (hits.length > 1 && nth == null) {
    throw new Error(
      `锚点出现 ${hits.length} 次，按下标取就是赌运气：${JSON.stringify(anchor.slice(0, 80))}\n`
      + `换一段唯一的锚点，或者确实要第 n 个时传 { nth }。`);
  }
  const at = hits[nth ?? 0];
  const pos = at + anchor.length - 1;
  let best = null;
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node.start === "number" && typeof node.end === "number"
      && node.start <= pos && pos < node.end
      && (!best || node.end - node.start < best.end - best.start)) best = node;
    for (const k of Object.keys(node)) if (k !== "type") walk(node[k]);
  })(_ast);
  if (!best) throw new Error(`锚点落在任何 AST 节点之外：${JSON.stringify(anchor.slice(0, 80))}`);
  if (enclosing) {
    // 往上找包住它的那个函数体。第二遍扫：取「包含锚点、且是函数/块」里最小的那个，
    // 但要比 best 本身大，否则又退回原地。
    let fn = null;
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      const t = node.type;
      if ((t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression")
        && node.start <= pos && pos < node.end
        && node.end - node.start > best.end - best.start
        && (!fn || node.end - node.start < fn.end - fn.start)) fn = node;
      for (const k of Object.keys(node)) if (k !== "type") walk(node[k]);
    })(_ast);
    if (!fn) throw new Error(`锚点外面没有函数可取：${JSON.stringify(anchor.slice(0, 80))}`);
    best = fn.body || fn;
  }
  return (code ? CODE : SRC).slice(best.start, best.end);
}

/**
 * 找不到就抛错的 indexOf —— 专治「顺序断言恒真」。
 *
 * `assert.ok(seg.indexOf(A) < seg.indexOf(B))` 有个哑掉的方向：**A 被删掉时
 * indexOf 返回 -1，而 `-1 < 任何下标` 恒成立**。于是这条守卫只挡得住「把 A 挪到 B
 * 后面」，挡不住「把 A 整个删掉」——而后者才是重构时真会发生、后果也一样的那种。
 * 实测两例：删除锁 `_treeDeleteBusy = true;`（删掉它，连点几下就叠出好几个确认框）、
 * 大写入的上限判断 `_LIVE_EDITOR_PREVIEW_MAX_CHARS`（删掉它，大文件照旧走编辑器
 * 预览路径）——两条测试都一声不吭。
 *
 * 用法：`assert.ok(at(seg, A) < at(seg, B), "…")`，A 不在了就当场报「找不到」。
 */
export function at(text, needle, what = "") {
  const i = String(text).indexOf(needle);
  if (i < 0) {
    throw new Error(
      `顺序断言的锚点找不到${what ? `（${what}）` : ""}：${JSON.stringify(String(needle).slice(0, 70))}\n`
      + "它要么被删了、要么改了写法。注意 indexOf 返回 -1 会让 `-1 < 下标` 恒成立，"
      + "所以这里必须抛错，而不是让比较静默通过。");
  }
  return i;
}

/** 一条依赖的源码：名字在 OVERRIDES 里就拼字面量，否则回 main.js 抓真源。 */
function _depSource(name) {
  if (Object.hasOwn(OVERRIDES, name)) return `const ${name} = ${JSON.stringify(OVERRIDES[name])};`;
  return fnSource(name);
}

/**
 * 把 main.js 里的真函数取出来跑。
 *
 * @param {string} name 要拿到手的那个声明名
 * @param {Record<string, unknown> | string[]} [deps]
 *   - 对象：键名作为形参注入（桩、常量、别的模块的真实现）
 *   - 数组：按名字把这些声明一起从 main.js 抓进来（顺序即拼接顺序），
 *     其中命中 OVERRIDES 的换成字面量
 *
 * 数组形式配合「构造时接住 ReferenceError、把缺的名字 unshift 进去再来一次」的循环，
 * 就能自动补齐依赖闭包（见 test/model-resume.test.mjs）。
 */
export function load(name, deps = {}) {
  if (Array.isArray(deps)) {
    return new Function(`${deps.map(_depSource).join("\n")}\n;return ${name};`)();
  }
  const keys = Object.keys(deps);
  return new Function(...keys, `${_depSource(name)}\n;return ${name};`)(...keys.map((k) => deps[k]));
}

/** 取一条顶层 const 的**值**（在空作用域里求值，所以它不能引用别的模块级变量）。 */
export function loadConst(name) {
  return new Function(`${fnSource(name)}\n;return ${name};`)();
}
