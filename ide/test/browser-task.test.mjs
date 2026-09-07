// 浏览器 task（目标驱动循环）与并入/导航助手：全部用假 invoke / 假模型真跑，不看源码文本。
import test from "node:test";
import assert from "node:assert/strict";
import { runBrowserTask, parseTaskReply, compactSnapshot, pageFingerprint, buildTaskPrompt, extractJsonObject, automationBrowserCall, mergedBrowserNote, historyScript, renderTabs, browserNavAction, taskModelConfig, TASK_DEFAULTS } from "../src/agent/browser-task.js";

const NODES = "NODES_SCRIPT";
function makeWorld({ pages, replies }) {
  // pages：每次观察返回的快照（按次序，用完就重复最后一个）；replies：模型每次的回复
  const calls = [];
  let obs = 0, asks = 0;
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === "browser_navigate") return { url: args.url, title: "nav", screenshot: "img" };
    if (name === "browser_eval" && args.script === NODES) {
      const p = pages[Math.min(obs, pages.length - 1)]; obs++;
      return { url: p.url, title: p.title, text: p.text || "", screenshot: "img", result: JSON.stringify({ url: p.url, title: p.title, nodes: p.nodes || [] }), blocked: p.blocked };
    }
    if (name === "browser_eval" && /^\(/.test(args.script)) return { screenshot: "img", result: "history" };
    if (name === "browser_eval") return { screenshot: "img", result: JSON.stringify({ ok: true, log: JSON.parse(args.script).map((s, i) => `${i + 1}. ${s.op} ✓`) }) };
    if (name === "browser_wait") return { screenshot: "img", url: "after-wait" };
    if (name === "browser_tab") return { screenshot: "img", result: JSON.stringify({ op: args.op, current: 1, count: 2, tabs: [{ tab: 0, title: "登录", url: "https://x.io/login", current: false }, { tab: 1, title: "邮箱", url: "https://mail.io/", current: true }] }) };
    return { screenshot: "img" };
  };
  const askModel = async (messages) => { const r = replies[Math.min(asks, replies.length - 1)]; asks++; return typeof r === "function" ? r(messages) : r; };
  return { calls, invoke, askModel, fastJs: (steps) => JSON.stringify(steps), nodesScript: NODES, asked: () => asks };
}
const login = { url: "https://x.io/login", title: "登录", nodes: [{ i: 1, r: "textbox", n: "邮箱" }, { i: 2, r: "textbox", n: "密码" }, { i: 3, r: "button", n: "登录" }] };
const home = { url: "https://x.io/home", title: "首页", nodes: [{ i: 1, r: "link", n: "账单" }, { i: 2, r: "text", n: "余额 ¥120" }], text: "欢迎回来 余额 ¥120" };

test("两轮做完：第一轮填表并点登录，第二轮看到首页就 done，summary 就是交付物", async () => {
  const w = makeWorld({ pages: [login, home], replies: [
    '{"thought":"填邮箱密码并登录","steps":[{"op":"type","node":1,"text":"a@b.io"},{"op":"type","node":2,"text":"pw"},{"op":"click","node":3}],"done":false}',
    '```json\n{"thought":"已登录","steps":[],"done":true,"summary":"余额 ¥120"}\n```',
  ] });
  const r = await runBrowserTask({ goal: "登录并读出余额", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  assert.equal(r.status, "done");
  assert.equal(r.summary, "余额 ¥120");
  assert.equal(r.stepsRun, 1);
  assert.match(r.text, /✅ 完成/);
  assert.match(r.text, /结果：余额 ¥120/);
  assert.match(r.transcript[0], /^1\. 填邮箱密码并登录 → 1\. type ✓; 2\. type ✓; 3\. click ✓/);
  const evals = w.calls.filter((c) => c[0] === "browser_eval" && c[1].script !== NODES);
  assert.equal(evals.length, 1, "一轮的三步合成一次 fast batch");
  assert.deepEqual(JSON.parse(evals[0][1].script).map((s) => s.op), ["type", "type", "click"]);
});

test("模型给的下一步里 navigate 会把一批切开：页内步骤先走 fast batch，再 browser_navigate", async () => {
  const w = makeWorld({ pages: [login, home], replies: [
    '{"thought":"先输入再跳转","steps":[{"op":"type","node":1,"text":"x"},{"op":"navigate","url":"https://x.io/home"},{"op":"click","node":1}],"done":false}',
    '{"done":true,"summary":"ok"}',
  ] });
  await runBrowserTask({ goal: "g", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  const seq = w.calls.filter((c) => !(c[0] === "browser_eval" && c[1].script === NODES)).map((c) => c[0]);
  assert.deepEqual(seq, ["browser_eval", "browser_navigate", "browser_eval"]);
});

test("被登录/验证码挡住：blocked 原样带回，不再继续；轮数用完给出接着做的办法", async () => {
  const w = makeWorld({ pages: [login], replies: ['{"thought":"要验证码","steps":[],"blocked":"页面要求短信验证码，需要用户输入"}'] });
  const r = await runBrowserTask({ goal: "g", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  assert.equal(r.status, "blocked");
  assert.match(r.text, /⛔ 被挡住：页面要求短信验证码/);
  const w2 = makeWorld({ pages: [login, home, login, home], replies: ['{"thought":"点","steps":[{"op":"click","node":1}]}'] });
  const r2 = await runBrowserTask({ goal: "g", maxSteps: 2, invoke: w2.invoke, fastJs: w2.fastJs, nodesScript: w2.nodesScript, askModel: w2.askModel });
  assert.equal(r2.status, "budget");
  assert.equal(r2.stepsRun, 2);
  assert.match(r2.text, /max_steps/);
});

test("页面连续几轮没变化就判没进展停下；模型两次不按格式也停下；线路不可用单独报", async () => {
  const w = makeWorld({ pages: [login], replies: ['{"thought":"点","steps":[{"op":"click","node":3}]}'] });
  const r = await runBrowserTask({ goal: "g", maxSteps: 10, invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  assert.equal(r.status, "stuck");
  assert.ok(r.stepsRun <= 3, `没进展还在点：跑了 ${r.stepsRun} 轮`);
  const w2 = makeWorld({ pages: [login], replies: ["我觉得应该先点登录", "还是先点登录吧"] });
  const r2 = await runBrowserTask({ goal: "g", invoke: w2.invoke, fastJs: w2.fastJs, nodesScript: w2.nodesScript, askModel: w2.askModel });
  assert.equal(r2.status, "failed");
  assert.match(r2.text, /没有按格式/);
  const w3 = makeWorld({ pages: [login], replies: [null] });
  const r3 = await runBrowserTask({ goal: "g", invoke: w3.invoke, fastJs: w3.fastJs, nodesScript: w3.nodesScript, askModel: w3.askModel });
  assert.equal(r3.status, "unavailable");
  assert.match(r3.text, /nodes.*batch/);
});

test("人机验证页直接停：obs.blocked 带回原因；没 goal 是失败不是空转", async () => {
  const w = makeWorld({ pages: [{ ...login, blocked: "cloudflare" }], replies: ['{"done":true}'] });
  const r = await runBrowserTask({ goal: "g", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  assert.equal(r.status, "blocked");
  assert.match(r.blocked, /cloudflare/);
  assert.equal(w.asked(), 0, "挡住了就不该再问模型");
  const r2 = await runBrowserTask({ goal: "  ", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, askModel: w.askModel });
  assert.equal(r2.status, "failed");
});

test("提示词：system 固定说清格式与停止条件；user 带目标/进度/历史/页面；历史只留最近几条", () => {
  const msgs = buildTaskPrompt({ goal: "买票", history: Array.from({ length: 30 }, (_, i) => `${i + 1}. x`), page: "url: a", stepNo: 5, maxSteps: 12 });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /只回一个 JSON 对象/);
  assert.match(msgs[0].content, /blocked/);
  assert.match(msgs[1].content, /目标：买票/);
  assert.match(msgs[1].content, /第 5\/12 轮/);
  assert.ok(!msgs[1].content.includes("\n1. x\n"), "太早的历史不该还在");
  assert.ok(msgs[1].content.includes("30. x"));
});

test("回复解析：围栏/废话可容忍，不认识的 op 与缺 node 的动作被丢掉，最多 6 步", () => {
  const r = parseTaskReply('好的，这是我的决定：```json\n{"thought":"t","steps":[{"op":"click","node":"4"},{"op":"hover","node":1},{"op":"click"},{"op":"navigate","url":"ftp://x"},{"op":"navigate","url":"https://ok.io"},{"op":"press","key":"Enter"},{"op":"wait","ms":99999},{"op":"scroll","amount":600},{"op":"select","node":2,"value":"CN"},{"op":"toggle","node":5,"checked":false}],"done":"yes"}\n``` 完毕');
  assert.deepEqual(r.steps.map((s) => s.op), ["click", "navigate", "press", "wait", "scroll", "select"]);
  assert.equal(r.steps[0].node, 4);
  assert.equal(r.steps[3].ms, 15000, "等待时长封顶");
  assert.equal(r.done, false, "done 必须是布尔 true");
  assert.equal(parseTaskReply("没有 json"), null);
  assert.deepEqual(extractJsonObject('前缀 {"a":"}{","b":1} 后缀'), { a: "}{", b: 1 });
});

test("页面压缩：视口内的节点排前面、总数封顶、跨域 iframe 要说、文本节选；指纹只看 url 和前几个节点", () => {
  const few = [{ i: 1, r: "link", n: "off-one", off: true }, ...Array.from({ length: 5 }, (_, k) => ({ i: k + 2, r: "button", n: `b${k}` }))];
  const small = compactSnapshot({ url: "u", title: "t", nodes: few }, {});
  assert.ok(small.indexOf('[2] button "b0"') < small.indexOf("[1] link"), "视口外的排后面");
  const nodes = [{ i: 1, r: "link", n: "off-one", off: true }, ...Array.from({ length: 200 }, (_, k) => ({ i: k + 2, r: "button", n: `b${k}` }))];
  const page = compactSnapshot({ url: "u", title: "t", nodes, contexts: { crossOriginFrames: ["https://pay.io"] } }, { text: "  hello   world  " });
  assert.match(page, /^url: u\ntitle: t/);
  assert.match(page, /跨域 iframe/);
  assert.match(page, /只列 140/);
  assert.match(page, /可见文本节选：hello world/);
  assert.equal(pageFingerprint({ url: "u", nodes }, {}), pageFingerprint({ url: "u", nodes: nodes.slice(0, 30) }, {}));
  assert.notEqual(pageFingerprint({ url: "u", nodes }, {}), pageFingerprint({ url: "v", nodes }, {}));
});

test("automation 的 browser.* 映射成 browser 工具调用；不认识的 browser.* 返回 null 交回 sidecar", () => {
  assert.equal(automationBrowserCall("browser.goto", { url: "https://a.io" }).action, "navigate");
  const start = automationBrowserCall("browser.start", { headless: true, profile: "isolated" });
  assert.equal(start.action, "observe"); assert.equal(start.fresh, true); assert.equal(start.mode, "isolated");
  assert.equal(automationBrowserCall("browser.start", { profile: "session", url: "https://a.io" }).action, "navigate");
  const t = automationBrowserCall("browser.type", { selector: "#name", text: "michael" });
  assert.equal(t.type, "browser"); assert.equal(t.selector, "#name"); assert.equal(t.text, "michael");
  assert.equal(automationBrowserCall("browser.wait", { selector: "#h", timeout: 1500 }).ms, 1500);
  assert.equal(automationBrowserCall("browser.content", {}).action, "observe");
  assert.equal(automationBrowserCall("browser.close", { force: true }).force, true);
  assert.equal(automationBrowserCall("browser.frobnicate", {}), null);
  assert.equal(automationBrowserCall("mouse.click", { x: 1 }), null);
  assert.match(mergedBrowserNote("navigate"), /同一只浏览器/);
});

test("前进/后退/刷新走页内 history，再等一拍；tab 走 browser_tab 且回执渲染成清单", async () => {
  assert.match(historyScript("reload"), /location\.reload/);
  assert.match(historyScript("forward"), /history\.forward/);
  assert.match(historyScript("anything"), /history\.back/);
  const w = makeWorld({ pages: [], replies: [] });
  const st = await browserNavAction({ act: "back", call: {}, invoke: w.invoke });
  assert.deepEqual(w.calls.map((c) => c[0]), ["browser_eval", "browser_wait"]);
  assert.equal(st.url, "after-wait");
  const tabs = await browserNavAction({ act: "tab", call: { op: "switch", tab: 1 }, invoke: w.invoke });
  assert.deepEqual(w.calls[2], ["browser_tab", { op: "switch", index: 1, url: null }]);
  assert.match(tabs.result, /★ \[1\] 邮箱 — https:\/\/mail\.io\//);
  assert.match(tabs.result, /  \[0\] 登录/);
  assert.match(renderTabs({ tabs: [] }), /空/);
});

test("模型 config：直连自定义模型按它的地址/协议且不走网关；否则走网关", () => {
  const base = { baseUrl: "https://gw", apiKey: "k", model: "cm-1" };
  const cm = taskModelConfig(base, (id) => (id === "cm-1" ? { id: "cm-1", name: "gpt-x", baseUrl: "https://mine", apiKey: "kk", protocol: "openai" } : null));
  assert.equal(cm.viaGateway, false); assert.equal(cm.model, "gpt-x"); assert.equal(cm.customModelId, "cm-1");
  assert.equal(taskModelConfig(base, () => null).viaGateway, true);
  assert.equal(TASK_DEFAULTS.hardMaxSteps, 30);
});

// ── 2026-09-06 加的 read / find / note / back / tab ──
const article = { url: "https://x.io/post", title: "文章", nodes: [{ i: 1, r: "link", n: "下一页" }], text: "第一段 价格 99 元" };
const readJs = (o) => `READ:${JSON.stringify(o)}`;
const findJs = (o) => `FIND:${JSON.stringify(o)}`;
function makeReaderWorld({ pages, replies }) {
  const w = makeWorld({ pages, replies });
  const inner = w.invoke;
  w.invoke = async (name, args) => {
    w.calls.push([name, args]);
    if (name === "browser_eval" && /^READ:/.test(args.script)) { const o = JSON.parse(args.script.slice(5)); return { screenshot: "img", url: "https://x.io/post", result: JSON.stringify({ root: "main", offset: o.offset || 0, chars: 5, total: 12, next: (o.offset || 0) + 5 < 12 ? (o.offset || 0) + 5 : null, outline: [], text: o.offset ? "后半段" : "价格 99 元" }) }; }
    if (name === "browser_eval" && /^FIND:/.test(args.script)) { const o = JSON.parse(args.script.slice(5)); return { screenshot: "img", url: "https://x.io/post", result: JSON.stringify({ query: o.text, nodeMatches: [], textMatches: o.text === "价格" ? [{ ctx: "价格 99 元", node: 1, inView: true }] : [], scrolled: true }) }; }
    w.calls.pop();
    return inner(name, args);
  };
  return w;
}

test("read / find / note 是观察：读到的内容进下一轮提示，记下的发现每轮都带着并进最后的 summary；连着读几页不算没进展", async () => {
  const seen = [];
  const w = makeReaderWorld({ pages: [article], replies: [
    '{"thought":"先读正文","steps":[{"op":"read"},{"op":"find","text":"价格"}],"done":false}',
    (msgs) => { seen.push(msgs[1].content); return '{"thought":"记下价格","steps":[{"op":"note","text":"价格 99 元"},{"op":"read","offset":5}],"done":false}'; },
    (msgs) => { seen.push(msgs[1].content); return '{"thought":"继续读","steps":[{"op":"read","offset":10}],"done":false}'; },
    (msgs) => { seen.push(msgs[1].content); return '{"done":true}'; },
  ] });
  const r = await runBrowserTask({ goal: "读出价格", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, readJs, findJs, askModel: w.askModel });
  assert.equal(r.status, "done", r.text);
  assert.equal(r.summary, "价格 99 元", "done 没写 summary 时，记下的发现就是交付物");
  assert.deepEqual(r.findings, ["价格 99 元"]);
  assert.match(seen[0], /上一轮读到的：[\s\S]*价格 99 元/, "read 的内容要进下一轮提示");
  assert.match(seen[0], /查找「价格」/, "find 的结果也要进下一轮提示");
  assert.match(seen[1], /已记下的发现[\s\S]*1\. 价格 99 元/, "note 记下的东西每轮都带着");
  assert.match(seen[2], /已记下的发现/);
  assert.match(r.transcript[0], /read ✓ \(还有后面，下一页 offset=5\); find "价格" ✓ 1 处/);
  assert.equal(r.stepsRun, 3, "页面三轮没变，但每轮都只是读，不该判成没进展");
  const evals = w.calls.filter((c) => c[0] === "browser_eval" && /^READ:/.test(c[1].script)).map((c) => JSON.parse(c[1].script.slice(5)).offset);
  assert.deepEqual(evals, [0, 5, 10]);
});

test("back 走页内 history 再等一拍；tab 走 browser_tab（action 给标签页操作）；回复里的 offset/pattern/role 都被认出来", async () => {
  const w = makeReaderWorld({ pages: [article, login], replies: [
    '{"thought":"回退再开新页","steps":[{"op":"back"},{"op":"tab","action":"new","url":"https://mail.io/"}],"done":false}',
    '{"done":true,"summary":"ok"}',
  ] });
  const r = await runBrowserTask({ goal: "g", invoke: w.invoke, fastJs: w.fastJs, nodesScript: w.nodesScript, readJs, findJs, askModel: w.askModel });
  assert.equal(r.status, "done");
  const seq = w.calls.filter((c) => !(c[0] === "browser_eval" && c[1].script === NODES)).map((c) => c[0]);
  assert.deepEqual(seq, ["browser_eval", "browser_wait", "browser_tab"]);
  assert.deepEqual(w.calls.find((c) => c[0] === "browser_tab")[1], { op: "new", index: null, url: "https://mail.io/" });
  assert.match(r.transcript[0], /back ✓ → after-wait; tab new https:\/\/mail\.io\/ ✓/);
  const p = parseTaskReply('{"steps":[{"op":"read","offset":"6000"},{"op":"find","pattern":"\\\\d+ 元","role":"link"},{"op":"find"},{"op":"note","text":"  "},{"op":"tab","action":"switch","index":2},{"op":"tab"}]}');
  assert.deepEqual(p.steps, [{ op: "read", offset: 6000 }, { op: "find", pattern: "\\d+ 元", role: "link" }, { op: "tab", tabOp: "switch", index: 2 }, { op: "tab", tabOp: "list" }], "find 没给条件、note 没内容要丢掉");
});

test("提示词里的 op 清单包含 read / find / note / back / tab，且说明 note 会进 summary", () => {
  const msgs = buildTaskPrompt({ goal: "g", history: [], page: "url: a", stepNo: 1, maxSteps: 3, findings: ["A"], extras: "读到的东西" });
  assert.match(msgs[0].content, /read\{offset\} \/ find\{text 或 pattern, role\} \/ note\{text\} \/ back \/ tab/);
  assert.match(msgs[0].content, /最后自动进 summary/);
  assert.match(msgs[1].content, /已记下的发现[\s\S]*1\. A/);
  assert.match(msgs[1].content, /上一轮读到的：\n读到的东西/);
  assert.ok(msgs[1].content.indexOf("上一轮读到的") < msgs[1].content.indexOf("当前页面："), "读到的在页面之前");
  assert.equal(TASK_DEFAULTS.hardMaxSteps, 30);
});
