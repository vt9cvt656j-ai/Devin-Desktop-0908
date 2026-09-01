// 回复底下那行统计里的计时器，任务结束就得停。
//
// 用户实拍：「明明任务都结束了，却还一直在数」。它不是显示错了——那个 setInterval
// 真的还在一秒一跳，而且会一直跳到关掉这个窗口为止。
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFrom, fnSource, SRC, load } from "./helpers/source.mjs";

test("计时器自己会停，不靠「每条收尾路径都记得调 stop()」", () => {
  // 收尾段里 stop() 前面排着一串会抛的活（写记忆、存盘、渲染建议、改时间线）。任何一处抛
  // 出来，整段收尾就断在那里，计时器没人关——这就是用户看到的「一直在数」。
  // 手工名单治不了这个，判据要结构性的：每一跳问一句「这一轮还活着吗」。
  const fn = fnSource("_liveTurnStats");
  assert.match(fn, /isLive/, "计时器不认「这一轮还活着吗」，只能等别人来关它");
  assert.match(fn, /if \(el && typeof isLive === "function" && !isLive\(\)\) \{ freeze\(\); return; \}/,
    "每一跳没有自检——收尾一旦断在半路，它就永远跳下去");
  // 自停是**冻住**不是删掉：显式 stop() 意味着"最终那行马上就来"，删掉才对；
  // 自停时最终那行可能永远不来（收尾断了），删掉等于把统计整条抹掉。
  const fz = fn.slice(fn.indexOf("const freeze = ()"), fn.indexOf("const tick = ()"));
  assert.match(fz, /clearInterval\(timer\)/, "冻住时没停掉定时器——等于没冻");
  assert.match(fz, /classList\.remove\("turn-stats--live"\)/, "冻住之后还挂着 live 的样式");
  assert.doesNotMatch(fz, /el\.remove\(\)/, "自停时把统计行删了——收尾断了的话，用户什么都看不到");
  // 显式 stop() 仍然要删（最终那行紧接着就渲染出来）。
  const st = fn.slice(fn.indexOf("stop() {"));
  assert.match(st, /if \(el\) el\.remove\(\)/, "显式 stop 不删的话，会和最终那行并排出现两条统计");
});

test("两处创建都把「还活着吗」传进去了", () => {
  // 少传一处，那条路径就退回原来的样子——而且是静默的：不报错，只是数字永远不停。
  //
  // 断言必须切到**这两个创建块里面**去看：`isLive: _live` 在 main.js 里出现 6 次
  //（预检那几处也用同一个判据），按全文匹配的话，把这里删掉照样绿——那就是一条
  // 「断言真实、守的却是别处」的恒真守卫。
  // 按 AST 取这两个参数对象（blockFrom 的锚点不唯一时要显式给 nth，多一处会当场抛错——
  // 那正好也是"新增了第三个创建点却忘了传 isLive"的信号）。
  const blocks = [0, 1].map((nth) => blockFrom("= _liveTurnStats(body, {", { nth }));
  assert.ok(blocks.some((b) => /isLive: _live,/.test(b)), "智能体那条没传");
  assert.ok(blocks.some((b) => /isLive: \(\) => !!sess\.streaming,/.test(b)), "纯对话那条没传");
  assert.ok(blocks.every((b) => /isLive:/.test(b)), "有一处创建没传「还活着吗」——那条路径的计时器永远停不下来");

});

test("耗时定格在内容写完的那一刻，不含收尾", () => {
  // 用户读这个数是「这次回答花了多久」，不是「包括等结算、写盘在内的一切」。
  // 而且这一行必须在 finally 的**最前面**：后面任何一步抛出来，计时器都已经停了。
  const fin = blockFrom("} catch (e) { if (!err) err = String(e); }\n  finally {");
  const head = fin.slice(0, fin.indexOf("clearAgentRetryToast"));
  assert.match(head, /const _contentDoneMs = Date\.now\(\) - _taskStartedAt;/,
    "没有在收尾一开始就定格耗时");
  assert.match(head, /_liveStats\.stop\(\);/, "stop 不在 finally 的最前面——后面一抛就又关不掉了");
  // 最终那行用的就是定格的数，不是"现在几点"。
  assert.equal((SRC.match(/elapsedMs: _contentDoneMs,/g) || []).length, 2,
    "两条路径没有都用定格的耗时（一条是纯对话，一条是智能体）");
  // 门禁拦下那条（blockedBody）压根没起过计时器，它照旧现算，不在这条守卫的范围里。
  const stray = SRC.split("\n").filter((ln) => /elapsedMs: Date\.now\(\) - _taskStartedAt/.test(ln));
  assert.ok(stray.every((ln) => ln.includes("blockedBody")),
    `还有别的地方用「现在几点」算最终耗时（把收尾也算进去了）：\n${stray.join("\n")}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// 2026-09-01：上面那两条测试**全绿**，而用户仍然实拍到「明明做完了所有内容，还是一直
// 在运行中，也没停止，计数器也在增加」。
//
// 它们守的是「isLive 有没有接上」，没有守「isLive 有没有可能变假」。而当时的 isLive 是
//   () => !!session.streaming && 代际相符
// 而 `session.streaming` 恰恰是收尾段里 `_setStreaming(session, false)` 那一行置回的 ——
// 也就是**计时器的自停依赖着那条它本来要绕开的行**。收尾段里那一行前面排着十几条裸语句
// （结算计划、收子体、判验证、算结局），finally 保证的是「进入」不是「跑完」，任意一条
// 抛出，streaming 永远是 true：按钮红着、秒数跳着，而且一个字都不报。
//
// 这是「恒真守卫的第五种形状」——断言真实，却守错了东西。下面补的是能证伪的那种。
import { test as t2 } from "node:test";
import { CODE } from "./helpers/source.mjs";
import * as acorn from "acorn";
import { readFileSync as _rf } from "node:fs";
import { MAIN_PATH as _MP } from "./helpers/source.mjs";

const _AST = acorn.parse(_rf(_MP, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });
function _walk(node, fn, seen = new Set()) {
  if (!node || typeof node.type !== "string" || seen.has(node)) return;
  seen.add(node); fn(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && _walk(c, fn, seen));
    else if (v && typeof v.type === "string") _walk(v, fn, seen);
  }
}

t2("「这一轮还活着吗」不许只靠收尾段置回的那个标志", () => {
  // 判据：_live 里必须有一条**不经过 _setStreaming** 就会变真的项。
  // 循环一退出就写死 run._loopExitedAt，前面没有任何可抛出的东西。
  assert.match(CODE, /const _live = \(\) => !!session\.streaming[\s\S]{0,160}!run\._loopExitedAt;/,
    "_live 又变回只看 session.streaming 了——收尾段一抛，计时器和停止按钮就一起卡死");
});

t2("每一处「结束流式」的收尾里，界面复位都不可能被跳过", () => {
  // 这一条扫的是**全部**收尾点，不是某一个：智能体循环、纯对话、生图三条路各有一个
  // finally，形状一模一样 —— 一串裸语句，然后才轮到 _setStreaming(x, false)。
  // finally 保证「进入」不保证「跑完」，所以其中任何一句抛出，界面就永远停在运行中。
  // 纯对话那条尤其致命：夹在中间的是两个网络往返（等计费落定、向网关取结算），
  // 网关抖一下就会 reject。
  //
  // 判据：排在界面复位前面的语句，要么整条被 try 兜住，要么不含任何可能抛出的调用。
  // 下面这几个是宿主内置且规范保证不抛的，不算：
  const SAFE = new Set(["_live", "now", "clearTimeout", "clearInterval", "cancelAnimationFrame"]);
  const sites = [];
  _walk(_AST, (n) => {
    if (n.type === "CallExpression" && n.callee?.name === "_setStreaming" && n.arguments?.[1]?.value === false) {
      sites.push(n.loc.start.line);
    }
  });
  assert.ok(sites.length >= 3, `只找到 ${sites.length} 处 _setStreaming(x,false)，锚点多半漂了`);

  const bad = [];
  let inFinally = 0;
  for (const ln of sites) {
    let fin = null;
    _walk(_AST, (n) => {
      if (n.type === "TryStatement" && n.finalizer
          && n.finalizer.loc.start.line < ln && n.finalizer.loc.end.line > ln
          && (!fin || n.finalizer.loc.start.line > fin.loc.start.line)) fin = n.finalizer;
    }, new Set());
    if (!fin) continue;               // 不在收尾段里的那几处是普通流程，不适用
    inFinally++;
    for (const st of fin.body) {
      if (st.loc.start.line >= ln || st.type === "TryStatement") continue;
      _walk(st, (n) => {
        if (n.type !== "CallExpression") return;
        const name = n.callee?.name || n.callee?.property?.name || "?";
        if (!SAFE.has(name)) bad.push(`行 ${n.loc.start.line} 的 ${name}() 排在行 ${ln} 的界面复位前面，且没有 try 兜住`);
      }, new Set());
    }
  }
  assert.ok(inFinally >= 3, `只有 ${inFinally} 处收尾段被检到，应该是三条路各一处`);
  assert.deepStrictEqual(bad, [],
    `这些会把停止按钮和计时器一起卡死（用户实拍「明明做完了…还是一直在运行中」）：\n  ${bad.join("\n  ")}`);
});

t2("智能体那条还有第二道判据：循环一退出就写死，与收尾段无关", () => {
  let fin = null, tsLine = 0;
  _walk(_AST, (n) => {
    if (n.type === "CallExpression" && n.callee?.name === "_setStreaming"
        && n.arguments?.[0]?.name === "session" && n.arguments?.[1]?.value === false) tsLine = n.loc.start.line;
  });
  assert.ok(tsLine, "找不到 _setStreaming(session, false)");
  _walk(_AST, (n) => {
    if (n.type === "TryStatement" && n.finalizer
        && n.finalizer.loc.start.line < tsLine && n.finalizer.loc.end.line > tsLine
        && (!fin || n.finalizer.loc.start.line > fin.loc.start.line)) fin = n.finalizer;
  }, new Set());
  const before = fin.body.filter((s) => s.loc.start.line < tsLine);
  const srcLines = _rf(_MP, "utf8").split("\n");
  const setter = before.find((s) => /_loopExitedAt\s*=/.test(srcLines[s.loc.start.line - 1]));
  assert.ok(setter, "finally 里没有写 _loopExitedAt");
  assert.strictEqual(before.filter((s) => s.type === "TryStatement" && s.loc.start.line < setter.loc.start.line).length, 0,
    "_loopExitedAt 排到记账后面去了——记账抛了它就写不上，等于没有第二条判据");
});

t2("行为验证：isLive 一变假，定时器当场被清掉，且不再改动那一行", () => {
  // 上面两条是结构断言。这一条把真函数取出来跑，证明「冻住」真的发生。
  let live = true, ticks = 0, cleared = false, timerFn = null;
  const el = { className: "", innerHTML: "", title: "", classList: { remove() {}, add() {} }, remove() {} };
  const body = { lastElementChild: null, appendChild(n) { body.lastElementChild = n; } };
  const fn = load("_liveTurnStats", {
    document: { createElement: () => el },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    setInterval: (f) => { timerFn = f; return 7; },
    clearInterval: (id) => { if (id === 7) cleared = true; },
    _turnStatsText: () => { ticks++; return { html: `t${ticks}` }; },
    _turnStatsTitle: () => "",
  });

  const stats = fn(body, { startedAt: 0, isLive: () => live });
  assert.strictEqual(ticks, 1, "创建时应该先渲染一次");
  timerFn(); assert.strictEqual(ticks, 2, "还活着的时候每一跳都要更新");

  live = false;              // 回合结束（比如 _loopExitedAt 被写上）
  timerFn();
  assert.ok(cleared, "isLive 变假之后没有清掉定时器——它会一直跳到关窗为止");
  const frozen = el.innerHTML;
  timerFn(); timerFn();
  assert.strictEqual(el.innerHTML, frozen, "冻住之后还在改那一行——数字仍然在动");
  assert.ok(body.lastElementChild === el, "冻住时把统计行删掉了——收尾断了的话用户就什么都看不到");
  stats.stop();
});

t2("停止按钮：单色细环 + 方块，红色渐变和红光脉冲不许回来", () => {
  const CSS = _rf(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const icon = CODE.slice(CODE.indexOf("const _STOP_ICON"), CODE.indexOf("function _setSendBtnStop"));
  assert.match(icon, /class="send-stop__track"/, "环的轨道没了——只剩一段孤零零的弧");
  assert.match(icon, /class="send-stop__arc"[^>]*stroke-dasharray/, "转的那段弧没了");
  assert.match(icon, /<rect[^>]*rx="1\.7"[^>]*fill="currentColor"/, "中间那个圆角方块没了——按钮不再表示「点它会停」");
  assert.doesNotMatch(icon, /#e03030|#f55050|red/i, "图标里又写死了红色");

  const block = CSS.slice(CSS.indexOf("\n.send.is-stop {"), CSS.indexOf("/* ---- model picker"));
  assert.doesNotMatch(block, /linear-gradient\(180deg, #f55050/, "红色渐变胶囊又回来了");
  assert.doesNotMatch(block, /send-stop-pulse/, "红光一呼一吸又回来了——它一直在动，用户分不出「在跑」和「卡住了」");
  assert.match(block, /animation: send-stop-spin/, "环不转了——那就没有任何东西在表示「还在跑」");
  // 环真的转起来，靠的是它自己的 keyframes；减少动态效果时要退成整圈而不是一段静止的弧。
  assert.match(CSS, /@keyframes send-stop-spin \{ to \{ transform: rotate\(360deg\); \} \}/, "缺 send-stop-spin");
  const rm = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce) {", CSS.indexOf(".send-stop__arc")));
  assert.match(rm.slice(0, 260), /\.send-stop__arc \{ animation: none; stroke-dasharray: none;/,
    "开了「减少动态效果」之后剩一段不动的弧，看着像画错了");
});

t2("发送按钮：平色圆 + 描边箭头，且没内容时看得出来不能点", () => {
  const CSS = _rf(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const SHELL = _rf(new URL("../src/app/Shell.jsx", import.meta.url), "utf8");
  const block = CSS.slice(CSS.indexOf("\n.send {"), CSS.indexOf("\n.send.is-stop {"));
  assert.doesNotMatch(block, /linear-gradient/, "渐变又回来了——这一代的按钮是平的一块颜色");
  assert.doesNotMatch(block, /box-shadow: 0 1px 2px rgba\(10, 132, 255/, "蓝色外发光又回来了");
  assert.doesNotMatch(block, /inset 0 1px 0 rgba\(255, 255, 255/, "顶上那道内高光又回来了");
  assert.match(block, /border-radius: 50%;/, "不是圆了——运行态是圆环，两态必须同形");
  // 没东西可发时要看得出来。以前 disabled 设了但一条样式都没有，按钮照旧是饱和的蓝。
  assert.match(CSS, /\.send:disabled \{[^}]*cursor: default;/, "禁用态没样式——看上去完全可点，点了没反应");

  // 首屏那一份和运行时替换的那一份必须是同一个箭头，否则第一次发送前后会换画法。
  const icon = CODE.slice(CODE.indexOf("const _SEND_ICON"), CODE.indexOf("const _STOP_ICON"));
  assert.doesNotMatch(icon, /#i-arrow-up/, "又去借 Git 推送那个雪碧图了——动它会连带改掉推送按钮");
  const d = [...icon.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(d.length >= 2, "箭头的路径没了");
  for (const path of d) {
    assert.ok(SHELL.includes(path), `首屏那份缺了 d="${path}" —— 第一次发送前后箭头会换一种画法`);
  }
});
