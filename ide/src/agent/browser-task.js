// 浏览器「目标驱动」执行器，外加两个小助手（automation 的 browser.* 并入、前进/后退/刷新/标签页）。
//
// 为什么要有 task（2026-09-05 所有者原话：「不知道需要操作多少步」）：模型不知道一个网页任务要几步，
// 于是要么一步一轮（主循环每轮固定 ~24k token），要么在 batch 里猜一串步骤、页面一变就断。
// 这里把「观察 → 决定下一批动作 → 执行 → 再观察」收进**一次**工具调用：每轮只把目标、已做步骤和
// 当前页面的节点清单交给模型（几 k token），它回一小段 JSON；做完、被挡住、没进展或轮数用完就停。
// 主循环拿到的是一份带结果的流水账，不用自己数步。
export const TASK_DEFAULTS = { maxSteps: 12, hardMaxSteps: 30, maxActionsPerStep: 6, maxNodes: 140, textChars: 1200, historyLines: 14, replyTokens: 700 };
const TASK_OPS = new Set(["click", "type", "press", "select", "toggle", "scroll", "wait", "navigate"]);

/** nodes 快照 + 浏览器状态 → 给模型看的紧凑页面描述。视口内的节点排前面，总数封顶。 */
export function compactSnapshot(snap, state, limits = TASK_DEFAULTS) {
  const s = snap && typeof snap === "object" ? snap : {};
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  const on = nodes.filter((n) => n && !n.off);
  const off = nodes.filter((n) => n && n.off);
  const picked = [...on, ...off].slice(0, limits.maxNodes);
  const line = (n) => `[${n.i}] ${n.r || "?"}${n.n ? ` "${String(n.n).slice(0, 60)}"` : ""}${n.s ? ` s=${String(n.s).slice(0, 30)}` : ""}${n.off ? " off" : ""}`;
  const parts = [
    `url: ${s.url || state?.url || ""}`,
    `title: ${s.title || state?.title || ""}`,
  ];
  const cf = s.contexts && Array.isArray(s.contexts.crossOriginFrames) ? s.contexts.crossOriginFrames : [];
  if (cf.length) parts.push(`（页面里有 ${cf.length} 个跨域 iframe，够不着：${cf.slice(0, 3).join(", ")}）`);
  parts.push(`节点（[编号] 角色 "名称" s=状态；off=不在视口内；共 ${nodes.length}${nodes.length > picked.length ? `，只列 ${picked.length}` : ""}）：`);
  parts.push(picked.length ? picked.map(line).join("\n") : "（没有可交互节点）");
  const text = String(state?.text || "").replace(/\s+/g, " ").trim();
  if (text) parts.push(`可见文本节选：${text.slice(0, limits.textChars)}`);
  return parts.join("\n");
}

/** 页面指纹：连续几轮不变就是没进展。 */
export function pageFingerprint(snap, state) {
  const s = snap && typeof snap === "object" ? snap : {};
  const nodes = (Array.isArray(s.nodes) ? s.nodes : []).slice(0, 30).map((n) => `${n.r}:${n.n}`).join("|");
  return `${s.url || state?.url || ""}#${nodes}`;
}

const TASK_SYSTEM = [
  "你在替用户操作一个真实网页。只回一个 JSON 对象，不要任何别的文字：",
  '{"thought":"一句话说这一轮打算做什么","steps":[{"op":"click","node":12}],"done":false,"blocked":"","summary":""}',
  "op 只能是：click{node} / type{node,text} / press{key} / select{node,value} / toggle{node,checked} / scroll{amount} / wait{ms 或 node} / navigate{url}。",
  "node 必须是节点清单里的编号。每轮最多 6 步；会跳转页面的动作（点链接、提交表单）放在这一轮最后。",
  "目标达成就 done:true，并把用户要的东西（数据、结论、看到的内容）写进 summary，summary 就是交付物。",
  "遇到登录、验证码、支付确认、系统权限这类必须由人来做的事：blocked 写明卡在哪，steps 留空，不要绕。",
  "上一轮的动作没生效或页面没变，就换一种做法（换节点、先 scroll/wait 再看）；别原样重发。",
].join("\n");

/** 一轮请求：system 固定，user 带目标 / 进度 / 历史 / 当前页面。 */
export function buildTaskPrompt({ goal, history, page, stepNo, maxSteps, limits = TASK_DEFAULTS }) {
  const hist = (Array.isArray(history) ? history : []).slice(-limits.historyLines);
  const user = [
    `目标：${goal}`,
    `进度：第 ${stepNo}/${maxSteps} 轮`,
    hist.length ? `已做过的步骤与结果：\n${hist.join("\n")}` : "还没做任何步骤。",
    `当前页面：\n${page}`,
  ].join("\n\n");
  return [{ role: "system", content: TASK_SYSTEM }, { role: "user", content: user }];
}

/** 从模型回复里抠出第一个完整 JSON 对象（容忍 ```json 围栏和前后废话）。 */
export function extractJsonObject(text) {
  const t = String(text || "");
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** 模型回复 → 规整的决定；解析不出来返回 null。步骤只保留认识的 op 与合法字段。 */
export function parseTaskReply(text, limits = TASK_DEFAULTS) {
  const j = extractJsonObject(text);
  if (!j || typeof j !== "object") return null;
  const steps = (Array.isArray(j.steps) ? j.steps : [])
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const op = String(s.op || s.action || "").toLowerCase().trim();
      if (!TASK_OPS.has(op)) return null;
      const out = { op };
      if (s.node != null && Number.isFinite(+s.node)) out.node = Math.floor(+s.node);
      if (typeof s.text === "string") out.text = s.text;
      if (typeof s.key === "string" && s.key) out.key = s.key;
      if (s.value != null) out.value = String(s.value);
      if (typeof s.checked === "boolean") out.checked = s.checked;
      if (Number.isFinite(+s.amount)) out.amount = Math.round(+s.amount);
      if (Number.isFinite(+s.ms)) out.ms = Math.max(0, Math.min(15000, Math.round(+s.ms)));
      if (typeof s.url === "string" && /^https?:\/\//i.test(s.url)) out.url = s.url.trim();
      if (op === "navigate" && !out.url) return null;
      if (["click", "type", "select", "toggle"].includes(op) && out.node == null) return null;
      return out;
    })
    .filter(Boolean)
    .slice(0, limits.maxActionsPerStep);
  return {
    thought: String(j.thought || "").slice(0, 200),
    steps,
    done: j.done === true,
    blocked: String(j.blocked || "").slice(0, 300),
    summary: String(j.summary || "").slice(0, 4000),
  };
}

const describeStep = (s) => {
  switch (s.op) {
    case "click": return `click [${s.node}]`;
    case "type": return `type [${s.node}] "${String(s.text || "").slice(0, 40)}"`;
    case "press": return `press ${s.key || "Enter"}`;
    case "select": return `select [${s.node}] ${s.value ?? ""}`;
    case "toggle": return `toggle [${s.node}] ${s.checked === false ? "off" : "on"}`;
    case "scroll": return `scroll ${s.amount ?? 600}`;
    case "wait": return `wait ${s.node != null ? `[${s.node}]` : `${s.ms ?? 800}ms`}`;
    case "navigate": return `navigate ${s.url}`;
    default: return s.op;
  }
};

/** 把一批步骤按 navigate 切段，页内步骤走 fast batch，navigate 走 browser_navigate。 */
async function executeSteps(steps, { invoke, fastJs }) {
  const lines = [];
  let state = null;
  let ok = true;
  let i = 0;
  while (i < steps.length) {
    const s = steps[i];
    if (s.op === "navigate") {
      try { state = await invoke("browser_navigate", { url: s.url }); lines.push(`${describeStep(s)} ✓`); }
      catch (e) { lines.push(`${describeStep(s)} ✗ ${String(e?.message || e).slice(0, 120)}`); ok = false; break; }
      i++;
      continue;
    }
    let j = i;
    while (j < steps.length && steps[j].op !== "navigate") j++;
    const group = steps.slice(i, j).map((s2) => ({ op: s2.op, node: s2.node, text: s2.text, key: s2.key, value: s2.value, option: s2.value, checked: s2.checked, amount: s2.amount, ms: s2.ms }));
    try {
      state = await invoke("browser_eval", { script: fastJs(group) });
      let parsed = null; try { parsed = JSON.parse(String(state?.result || "{}")); } catch {}
      if (parsed && Array.isArray(parsed.log) && parsed.log.length) lines.push(...parsed.log.map((l) => String(l).slice(0, 160)));
      else lines.push(...group.map((g) => `${describeStep(g)} ${parsed && parsed.ok === false ? "✗" : "✓"}`));
      if (parsed && parsed.ok === false) { ok = false; break; }
    } catch (e) { lines.push(`${group.map(describeStep).join("; ")} ✗ ${String(e?.message || e).slice(0, 120)}`); ok = false; break; }
    i = j;
  }
  return { lines, state, ok };
}

/**
 * 目标驱动循环。返回 { status, summary, blocked, stepsRun, transcript, state, text }：
 * status ∈ done / blocked / stuck / budget / unavailable / failed；text 是给模型看的整段回执。
 */
export async function runBrowserTask({ goal, maxSteps, startUrl, invoke, fastJs, nodesScript, askModel, onProgress, limits = TASK_DEFAULTS }) {
  const target = String(goal || "").trim();
  const budget = Math.max(1, Math.min(limits.hardMaxSteps, Math.round(Number(maxSteps) || limits.maxSteps)));
  const transcript = [];
  const history = [];
  let state = null;
  let status = "budget", blocked = "", summary = "", stepsRun = 0;
  const progress = (line) => { try { onProgress && onProgress(line); } catch {} };
  if (!target) return finish({ status: "failed", blocked: "task 需要 goal（一句话说清要在网页上做成什么）", transcript, state, stepsRun: 0, summary: "", goal: target, budget });
  if (startUrl) {
    try { state = await invoke("browser_navigate", { url: startUrl }); transcript.push(`0. navigate ${startUrl} ✓`); }
    catch (e) { return finish({ status: "failed", blocked: `打不开起始页 ${startUrl}：${String(e?.message || e).slice(0, 160)}`, transcript, state, stepsRun: 0, summary: "", goal: target, budget }); }
  }
  let lastFp = "", sameCount = 0, unparsed = 0, idle = 0;
  for (let step = 1; step <= budget; step++) {
    progress(`task 第 ${step}/${budget} 轮：观察页面`);
    let obs;
    try { obs = await invoke("browser_eval", { script: nodesScript }); }
    catch (e) { status = "failed"; blocked = `读不到页面：${String(e?.message || e).slice(0, 160)}`; break; }
    state = obs || state;
    if (obs && obs.blocked) { status = "blocked"; blocked = `页面是一道人机验证/反爬挑战（${obs.blocked}），要人在浏览器窗口里过一下`; break; }
    let snap = null; try { snap = JSON.parse(String(obs?.result || "{}")); } catch {}
    const fp = pageFingerprint(snap, obs);
    sameCount = fp === lastFp ? sameCount + 1 : 0;
    lastFp = fp;
    if (sameCount >= 3) { status = "stuck"; break; }
    const page = compactSnapshot(snap, obs, limits);
    progress(`task 第 ${step}/${budget} 轮：决定下一步`);
    const reply = parseTaskReply(await askModel(buildTaskPrompt({ goal: target, history, page, stepNo: step, maxSteps: budget, limits }), limits.replyTokens), limits);
    if (!reply) {
      unparsed++;
      if (step === 1 && unparsed === 1 && (await askModel([{ role: "user", content: "ping" }], 8)) == null) { status = "unavailable"; break; }
      if (unparsed >= 2) { status = "failed"; blocked = "模型两次没有按格式给出下一步"; break; }
      continue;
    }
    if (reply.blocked) { status = "blocked"; blocked = reply.blocked; summary = reply.summary; break; }
    if (reply.done) { status = "done"; summary = reply.summary; break; }
    if (!reply.steps.length) {
      idle++;
      history.push(`${step}. （模型没给动作：${reply.thought || "无说明"}）`);
      if (idle >= 2) { status = "stuck"; break; }
      continue;
    }
    progress(`task 第 ${step}/${budget} 轮：${reply.thought || reply.steps.map(describeStep).join("; ")}`);
    const ran = await executeSteps(reply.steps, { invoke, fastJs });
    stepsRun++;
    if (ran.state) state = ran.state;
    const line = `${step}. ${reply.thought ? reply.thought + " → " : ""}${ran.lines.join("; ")}`;
    history.push(line);
    transcript.push(line);
  }
  return finish({ status, blocked, summary, transcript, state, stepsRun, goal: target, budget });
}

function finish({ status, blocked, summary, transcript, state, stepsRun, goal, budget }) {
  const head = {
    done: "✅ 完成",
    blocked: `⛔ 被挡住：${blocked}`,
    stuck: "⏸ 没有进展（连续几轮页面没变化），已停下",
    budget: `⏱ ${budget} 轮用完还没做完`,
    unavailable: "task 模式在这条线路不可用（直连的自定义端点不发内置提示词）：改用 nodes 看页面，再用 batch 分步做，我每轮给下一步。",
    failed: `❌ 失败：${blocked}`,
  }[status] || status;
  const text = [
    `**浏览器 task**（目标：${goal}）— ${head}`,
    summary ? `结果：${summary}` : "",
    transcript.length ? `做过的步骤（${stepsRun} 轮）：\n${transcript.join("\n")}` : "",
    status === "budget" ? "可以把 max_steps 调大再发一次 task，或按流水账接着用 batch 做剩下的。" : "",
    status === "stuck" ? "换个切入点（先 nodes 看清页面、或 navigate 到更直接的页面）再发 task。" : "",
  ].filter(Boolean).join("\n");
  return { status, blocked, summary, transcript, state, stepsRun, text };
}

/** 直连自定义模型时按它的地址/协议发；否则走网关。给 _cognitiveLegComplete 用的 config。 */
export function taskModelConfig(base, byId) {
  const cfg = base && typeof base === "object" ? base : {};
  const cm = typeof byId === "function" ? byId(cfg.model) : null;
  if (cm) return { ...cfg, baseUrl: cm.baseUrl, apiKey: cm.apiKey, model: cm.name, protocol: cm.protocol, customModelId: cm.id || cm.name, viaGateway: false };
  return { ...cfg, viaGateway: true };
}

// ── automation 的 browser.* 并入 browser 工具 ──
// 两条 CDP 路（sidecar 的 chromiumoxide 与应用内的 headless_chrome）各起一只浏览器、各一份 profile：
// 模型用 automation browser.goto 开的页面，在 browser 工具里看不到，登录态也不通。产品答案是
// **浏览器只有一只**：browser.* 一律映射成 browser 工具的动作，automation 只管页面之外的桌面输入与录制回放。
const BROWSER_CALL_BASE = { type: "browser", action: "", url: "", fresh: false, mode: "headed", force: false, selector: "", target: "", role: "", text: "", fields: {}, submit: false, submitText: "", key: "", steps: null, uploadPaths: [], script: "", goal: "", maxSteps: 0, op: "", tab: undefined };

export function automationBrowserCall(method, params) {
  const m = String(method || "").trim().toLowerCase();
  const p = params && typeof params === "object" ? params : {};
  const sel = String(p.selector || "");
  switch (m) {
    case "browser.start": {
      const isolated = String(p.profile || "").toLowerCase() === "isolated";
      const url = String(p.url || "");
      return { ...BROWSER_CALL_BASE, action: url ? "navigate" : "observe", url, fresh: isolated, mode: isolated ? "isolated" : "headed" };
    }
    case "browser.goto": return { ...BROWSER_CALL_BASE, action: "navigate", url: String(p.url || "") };
    case "browser.click": return { ...BROWSER_CALL_BASE, action: "click", selector: sel, target: String(p.target || p.text || "") };
    case "browser.type": return { ...BROWSER_CALL_BASE, action: "type", selector: sel, target: String(p.target || ""), text: String(p.text ?? "") };
    case "browser.wait": return { ...BROWSER_CALL_BASE, action: "wait", selector: sel, ms: Number.isFinite(+p.timeout) ? Math.round(+p.timeout) : (Number.isFinite(+p.ms) ? Math.round(+p.ms) : undefined) };
    case "browser.eval": return { ...BROWSER_CALL_BASE, action: "eval", script: String(p.script || p.expression || "") };
    case "browser.screenshot": return { ...BROWSER_CALL_BASE, action: "screenshot" };
    case "browser.content": return { ...BROWSER_CALL_BASE, action: "observe" };
    case "browser.close": return { ...BROWSER_CALL_BASE, action: "close", force: !!p.force };
    default: return null;
  }
}

export function mergedBrowserNote(action) {
  return `[并入] automation 的 browser.* 就是 browser 工具（同一只浏览器、同一份登录态，没有第二只）。这次已按 browser action:"${action}" 执行；下一步直接用 browser。`;
}

// ── 前进 / 后退 / 刷新 / 标签页 ──
export function historyScript(act) {
  const a = String(act || "").toLowerCase();
  if (a === "reload") return "(() => { location.reload(); return \"reload\"; })()";
  if (a === "forward") return "(() => { history.forward(); return \"forward\"; })()";
  return "(() => { history.back(); return \"back\"; })()";
}

/** 标签页回执（Rust 回的是结构化事实）→ 给模型的清单。 */
export function renderTabs(json) {
  let v = json;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return String(json || ""); } }
  const tabs = Array.isArray(v?.tabs) ? v.tabs : [];
  if (!tabs.length) return "标签页：（空）";
  return `标签页（${tabs.length} 个，★=当前，之后的 click/type/observe 都作用于当前标签页；切换用 tab op:"switch" tab:<编号>）：\n`
    + tabs.map((t) => `${t.current ? "★" : " "} [${t.tab}] ${String(t.title || "").slice(0, 60) || "(无标题)"} — ${String(t.url || "").slice(0, 120)}`).join("\n");
}

/** back / forward / reload / tab 的执行；返回浏览器状态（tab 的 result 已换成可读清单）。 */
export async function browserNavAction({ act, call, invoke }) {
  const a = String(act || "").toLowerCase();
  if (a === "tab") {
    const st = await invoke("browser_tab", { op: String(call?.op || "list").toLowerCase(), index: Number.isFinite(+call?.tab) ? Math.floor(+call.tab) : null, url: call?.url ? String(call.url) : null });
    if (st && typeof st === "object") st.result = renderTabs(st.result);
    return st;
  }
  await invoke("browser_eval", { script: historyScript(a) });
  return invoke("browser_wait", { selector: null, ms: 900 });
}
