import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE, load } from "./helpers/source.mjs";
import {
  planModeOffer, planModeAnswerIsYes, dropWriteTools,
  planModeEnteredNote, planModeDeclinedNote, planModeNotOfferedNote,
  PLAN_MODE_YES, PLAN_MODE_NO,
} from "../src/agent/plan-mode-offer.js";
import { toolPolicy, readOnlyBlockedTypes } from "../src/agent/tool-policy.js";

// 所有者要的那件事（2026-09-04）：「我最新的 plan 模式也要能用，比如 update_plan 需要用到
// 我的 plan 模式时候，给用户确认，那么也能用」。判断权在模型、开关权在用户。
// 这里守的是那两句里的每一个字：**模型不声明就不问**、**用户不点头就不切**。

const steps = [{ content: "读 src/main.js 的派发链", status: "pending" }];
const base = { mode: "agent", requested: true, unattended: false, alreadyAsked: false, steps };

test("模型不声明，harness 一个字都不问", () => {
  assert.equal(planModeOffer({ ...base, requested: false }).ask, false);
  assert.equal(planModeOffer({ ...base, requested: false }).reason, "",
    "没声明就连「未生效」都不该说——那会变成每次 update_plan 都念一遍");
  assert.equal(planModeOffer().ask, false, "裸调用不许抛");
  // 反向：声明了就必须真的问出去，否则这个字段是个摆设。
  assert.equal(planModeOffer(base).ask, true);
});

test("问出去的那张卡片，两个选项都得在", () => {
  const o = planModeOffer(base);
  assert.equal(o.options.length, 2);
  assert.equal(o.options[0].label, PLAN_MODE_YES);
  assert.equal(o.options[1].label, PLAN_MODE_NO);
  assert.match(o.question, /Plan/, "问题里得出现模式名，用户才知道在确认什么");
  // 「是」那一项必须说清代价：进去之后写工具就没了。不说清等于骗用户点头。
  assert.match(o.options[0].description, /只读|撤下/);
});

test("四种不该问的情形，一种都不许漏", () => {
  assert.equal(planModeOffer({ ...base, mode: "plan" }).reason, "not-agent");
  assert.equal(planModeOffer({ ...base, mode: "chat" }).reason, "not-agent");
  assert.equal(planModeOffer({ ...base, steps: [] }).reason, "no-steps");
  assert.equal(planModeOffer({ ...base, steps: null }).reason, "no-steps");
  assert.equal(planModeOffer({ ...base, alreadyAsked: true }).reason, "already");
  assert.equal(planModeOffer({ ...base, unattended: true }).reason, "unattended");
  for (const r of ["not-agent", "no-steps", "already", "unattended"]) {
    assert.ok(planModeNotOfferedNote(r).length > 10,
      `${r} 这一路没有给模型任何反馈——它会以为自己已经在只读模式里，然后按只读的口径收尾`);
  }
});

// 默认值必须是「维持现状」。判错成「切了」= 用户要的改动一个字节没落盘；
// 判错成「没切」= 模型多写几个文件。两边代价不对称，就该往轻的那头倒。
test("只有真点了那个按钮才算同意", () => {
  assert.equal(planModeAnswerIsYes(`用户选择了：「${PLAN_MODE_YES}」。就按这个需求继续做。`), true);
  assert.equal(planModeAnswerIsYes(`用户选择了：「${PLAN_MODE_NO}」。就按这个需求继续做。`), false);
  assert.equal(planModeAnswerIsYes("[已取消] 当前等待已因任务停止或被新的请求替换，不要继续此步骤。"), false,
    "任务被停掉/被新请求替换，不是同意");
  assert.equal(planModeAnswerIsYes("用户输入了具体需求：随便你。就按这个继续做。"), false,
    "在「其他」里打字不是点了那个按钮");
  assert.equal(planModeAnswerIsYes("用户让你自行判断——按你认为最合理的方案直接继续做，别再问。"), false);
  assert.equal(planModeAnswerIsYes(""), false);
  assert.equal(planModeAnswerIsYes(), false);
  // 「不用，直接开始做」里不许碰巧含着「进入 Plan 模式」——否则否定答案会被读成同意。
  assert.ok(!PLAN_MODE_NO.includes(PLAN_MODE_YES));
});

test("撤工具是原地改那个数组，不是换一个新的", () => {
  const isBlocked = (n) => n === "write_file" || n === "run_cmd";
  const win = [
    { function: { name: "read_file" } }, { function: { name: "write_file" } },
    { function: { name: "update_plan" } }, { function: { name: "run_cmd" } },
  ];
  const same = win;
  const dropped = dropWriteTools(win, isBlocked);
  assert.deepEqual(dropped, ["write_file", "run_cmd"]);
  // 这个数组从 run 起点就被一路带进每一次请求（search_tools 换入换出走的也是 splice）。
  // 换成新数组的话，撤下来的工具在**下一次请求里原样还在**——整件事静默失效。
  assert.equal(win, same, "工具窗口被换成了新数组，撤下的工具不会真的从请求里消失");
  assert.deepEqual(win.map((t) => t.function.name), ["read_file", "update_plan"]);
  assert.deepEqual(dropWriteTools([], isBlocked), []);
  assert.deepEqual(dropWriteTools(null, isBlocked), []);
  assert.deepEqual(dropWriteTools(win, null), [], "判据缺席时不许把整个窗口清空");
  assert.deepEqual(win.map((t) => t.function.name), ["read_file", "update_plan"]);
});

test("拿真的 tool-policy 走一遍：写文件真的没了，取证工具一个没少", () => {
  // 用真判据，不是自编的形状——自编 isBlocked 只能证明 filter 会 filter。
  const blockedTypes = readOnlyBlockedTypes();
  assert.ok(blockedTypes.has("write"), "只读闸的声明表里没有 write，那这条链从头就是空的");
  const typeOf = { write_file: "write", edit_file: "edit", run_cmd: "cmd", read_file: "read", find_files: "find", update_plan: "plan" };
  const isBlocked = (n) => toolPolicy(typeOf[n])?.readOnlyModeBlocked === true;
  const win = Object.keys(typeOf).map((name) => ({ function: { name } }));
  const dropped = dropWriteTools(win, isBlocked);
  assert.ok(dropped.includes("write_file") && dropped.includes("edit_file") && dropped.includes("run_cmd"));
  const left = win.map((t) => t.function.name);
  assert.deepEqual(left, ["read_file", "find_files", "update_plan"],
    "取证工具被一起撤掉了——Plan 模式最需要的恰恰是它们；update_plan 撤了就连计划都改不了");
});

test("进入之后那段话：先撤回矛盾的指令，再说清系统提示词没变", () => {
  const note = planModeEnteredNote({ dropped: ["write_file", "edit_file"], discipline: "\n\n🧭 **Plan 模式纪律（只读，不执行）**：先取证再规划" });
  // 上面那段计划回执是切模式之前拼的，对 agent 模式说的是「现在去做第一步」。
  assert.match(note, /现在去做第一步」作废/, "不当场作废，模型读到的是两句直接打架的指令");
  assert.match(note, /write_file、edit_file/, "撤了哪些得说出来");
  assert.match(note, /Plan 模式纪律/, "纪律原文没带上——模型不知道只读模式该交付什么");
  // 模式是中途切的，而系统提示词整轮冻结（messages[0] 在 run 起点就定死）。它手上那份
  // 仍然是 Agent 的，里面写着去写代码。不点破的话，更早的那条看起来更权威。
  assert.match(note, /系统提示词整轮冻结/);
  assert.match(note, /以这一条为准/);
  // 这里要正面钉住那句禁令。反着写（doesNotMatch /已经实现/）是恒真守卫的经典形状：
  // 禁令本身就含这三个字，删掉整句反而变绿。
  assert.match(note, /不要在收尾里说任何东西已经实现了/, "只读轮没拦住「已实现」那句话");
});

test("用户不点头时，他的原话要原样带回给模型", () => {
  const note = planModeDeclinedNote("用户输入了具体需求：别废话，直接改 login.ts。就按这个继续做。");
  assert.match(note, /仍是 Agent 模式/);
  assert.match(note, /直接改 login\.ts/, "用户在「其他」里写的要求被吞了");
  assert.match(note, /现在去做第一步/, "拒绝之后要接着做，不是停在这里");
});

// ── 接线：上面那些函数在真实调用链上还在不在 ──────────────────────────
// 纯函数验得到行为，验不到「它被接上了」。这几条只钉调用点。
test("确认卡片走 ask_user 那条真路，且不花模型自己的提问预算", () => {
  const site = CODE.slice(CODE.indexOf("const _pmo = _planModeOffer("), CODE.indexOf("const _pmo = _planModeOffer(") + 2600);
  assert.match(site, /_executeToolStep\(_pmStep, \{ type: "askuser"/,
    "没走 ask_user 的执行路径——无人值守出口、任务停止时的取消全在那里面");
  assert.match(site, /const _pmBudget = run\._askUserCount, _pmWasAsk = run\._lastToolWasAsk;/);
  assert.match(site, /run\._askUserCount = _pmBudget; run\._lastToolWasAsk = _pmWasAsk;/,
    "harness 替它问的这一句，吃掉了模型自己那 3 次提问预算");
  assert.match(site, /requested: it\.call\.planMode === true/, "读的不是模型的声明");
  assert.match(site, /alreadyAsked: run\._planModeAsked === true/, "一轮问不止一次");
});

test("同意之后：模式、工具窗口、注册表、界面，四样一起翻", () => {
  const site = CODE.slice(CODE.indexOf("if (_planModeAnswerIsYes("), CODE.indexOf("if (_planModeAnswerIsYes(") + 1800);
  assert.match(site, /run\.mode = "plan";/, "只读闸每次工具调用现读 run.mode，不翻它什么都不会发生");
  assert.match(site, /_dropWriteTools\(toolSchemas, _readOnlyBlockedTool\)/,
    "窗口没撤：模型仍握着 write_file 的 schema，调一次拿一句 [BLOCKED]，然后去找绕路");
  assert.match(site, /run\._toolRegistry = _buildToolRegistry\(false, run\.mcpToolCache\)/,
    "注册表没窄：search_tools 能把写工具原样换回窗口");
  assert.match(site, /_pmSess === _currentSession\(\)/,
    "改全局模式没按标签页守住——别的标签页有自己的 run");
  assert.match(site, /_updateModeUI\(\)/, "指示器还写着 Agent 而写操作已经被挡，就是「机制变了界面没变」");
});

test("流完即写那条路也要认中途切的模式", () => {
  // write_file 的参数一流完整就**立刻真实落盘**，根本不经过派发和只读闸。它的开关读的
  // 同样是 run 起点那个 isAgent：不补这一处，切进 Plan 模式之后模型只要还能吐出
  // write_file 的调用（名字它自己会写，不必在工具表里），文件照样落盘。
  const hook = CODE.slice(CODE.indexOf("run._eagerStreamHook = run._eagerStreamHook"));
  assert.match(hook.slice(0, 300), /if \(!isAgent \|\| run\.mode !== "agent" \|\|/,
    "流完即写没认 run.mode——Plan 模式下写盘仍然绕过一切闸门");
});

test("画像迟到落地时，不许把撤下去的写工具加回来", () => {
  const sync = CODE.slice(CODE.indexOf("const _syncAgentToolWindowToProfile = ()"));
  assert.match(sync.slice(0, 600), /if \(!isAgent \|\| run\.mode !== "agent"\) return false;/,
    "只读 isAgent 那个起点常量：中途切成 plan 之后它仍是 true，_selectInitialTools(true, …) 会把写工具原样加回来");
});

test("plan_mode 是声明出来的字段，两份工具目录都得有", () => {
  const call = load("_mapToolCall", {
    _normPlanSteps: (x) => (Array.isArray(x) ? x : []),
    _normalizeArgKeys: (args) => args,
    _STR_ARG_KEYS: new Set(),
    _KNOWN_TOOLS: new Set(["update_plan"]),
    _canonicalToolName: () => "",
    _RETIRED_SEARCH_ALIASES: new Set(), _mcpToolMap: new Map(),
    USER_TOOL_PREFIX: undefined,
  });
  assert.equal(call("update_plan", { steps: [{ content: "a", status: "pending" }], plan_mode: true }, new Map()).planMode, true);
  assert.equal(call("update_plan", { steps: [], plan_mode: "true" }, new Map()).planMode, true, "字符串 true 也收——模型常这么发");
  assert.equal(call("update_plan", { steps: [] }, new Map()).planMode, false, "不声明就是 false，不能是 undefined 落到 === true 之外");
  assert.equal(call("update_plan", { steps: [], plan_mode: false }, new Map()).planMode, false);
  // 两份目录：客户端这份和网关那份必须都有。网关那份在运行时**赢**——只改客户端的话，
  // 走网关线路的模型根本看不见这个字段，整件事对绝大多数用户静默不存在。
  const catalog = readFileSync(new URL("../src/agent/tool-catalog.js", import.meta.url), "utf8");
  assert.match(catalog, /plan_mode: \{ type: "boolean"/, "客户端目录里没有 plan_mode");
  const gateway = JSON.parse(readFileSync(new URL("../../server/prompts/tools.json", import.meta.url), "utf8"));
  const up = (Array.isArray(gateway) ? gateway : gateway.tools || []).find((t) => t?.function?.name === "update_plan");
  assert.ok(up?.function?.parameters?.properties?.plan_mode,
    "网关那份目录里没有 plan_mode——运行时是它赢，这个字段等于没加");
  assert.match(String(up.function.parameters.properties.plan_mode.description), /Plan mode/,
    "字段在，但没告诉模型它是干什么的");
});
