// 任务计划的自动推进：什么样的证据才算"这一步做完了"。
//
// 假完成比不推进糟得多：一个停在"进行中"的步骤只是看着慢，用户会自己等；
// 一个假勾会让用户以为事情已经做了，然后基于一个没发生的事实往下走。
//
// 真实事故：一份 7 步的建站计划里有 3 步的措辞没被动词表认出来
// （"配置 Tailwind…设计 tokens"、"面包店门店信息与地图"、"把首页跑起来给用户看"），
// 而当时的兜底是「分不出类 → 任何证据都算完成」，于是模型只是读了个文件，
// 这三步就在界面上显示成做完了。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `SRC` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as SRC, SRC as RAW_SRC, fnSource as extractFn, load } from "./helpers/source.mjs";
import { planStepTargets, toolTouchedTargets, targetsConflict } from "../src/agent/plan-target.js";
import { partialCause as _partialCause, runOutcome as _runOutcome } from "../src/agent/outcome.js";

// 模型现在可以在 update_plan 里逐步声明 kind，动词表退化成兜底，所以这两个函数多了
// 一个依赖。本文件测的是**兜底那条路**（没有声明时的行为），声明那条路见
// test/plan-step-kind.test.mjs。
const PLAN_STEP_KINDS = new Set(["investigate", "implement", "execute", "verify"]);
const actionKind = new Function("_PLAN_STEP_KINDS",
  `${extractFn("_planStepActionKind")}\n;return _planStepActionKind;`)(PLAN_STEP_KINDS);
// 交付物判据（「这一步点了名的东西，这次调用动了没有」）已抽成 src/agent/plan-target.js。
// 按**真实实现**注进来 —— 在这里手写一份等价物就是测试台自编形状，实现改了它还绿。
const matches = new Function(
  "_PLAN_STEP_KINDS", "_planStepTargets", "_toolTouchedTargets", "_planTargetsConflict",
  `${extractFn("_planStepActionKind")}\n${extractFn("_planStepMatchesEvidence")}\n;return _planStepMatchesEvidence;`,
)(PLAN_STEP_KINDS, planStepTargets, toolTouchedTargets, targetsConflict);

// 用户那份真实计划，逐字照抄
const REAL_PLAN = [
  "创建 Vite + React + TypeScript 项目结构，配置 package.json 和依赖（Tailwind CSS、Framer Motion、Lucide React）",
  "配置 Tailwind CSS v4 CSS-first，设置面包店暖色调设计 tokens（stone + amber 配色）",
  "创建可复用基础组件（Button/Card/Container）使用 shadcn/ui 模式和语义 token",
  "实现 Navbar 组件（固定顶部、透明背景、logo + 导航链接 + CTA 按钮）",
  "实现 Hero section（全屏高度、背景图、标题动画）",
  "面包店门店信息与地图",
  "把首页跑起来给用户看",
];

test("一次读取不会把任何一步标成完成", () => {
  // read_file / list_dir / search 产出的是 investigate 证据。它只能推进"调查"型步骤，
  // 绝不该推进"实现"或"运行"型步骤——更不该推进一个连类型都判不出来的步骤。
  for (const step of REAL_PLAN) {
    assert.equal(matches({ content: step }, ["investigate"]), false,
      `一次读取就把这步标完成了：「${step.slice(0, 40)}」`);
  }
});

test("分不出类型的步骤一律不自动打勾", () => {
  // 旧兜底是「分不出类 → 有任何证据就算完成」，方向正好反了。
  // 判不出这一步要做什么，就没有资格断定它做完了；交回给模型自己的 update_plan。
  const unclassifiable = ["面包店门店信息与地图", "第二阶段", "收尾", "……"];
  for (const step of unclassifiable) {
    assert.equal(actionKind({ content: step }), "", `这条本该判不出类型：${step}`);
    for (const kinds of [["investigate"], ["implement"], ["verify"], ["execute"], ["implement", "verify"]]) {
      assert.equal(matches({ content: step }, kinds), false,
        `判不出类型却被 ${kinds.join("/")} 证据打勾了：${step}`);
    }
  }
});

test("对得上类型的真实证据仍然照常推进", () => {
  // 修复不能把自动推进整个废掉——那会让计划永远停在第一步。
  const cases = [
    ["实现 Navbar 组件", "implement"],
    ["创建 Vite + React + TypeScript 项目结构", "implement"],
    ["配置 Tailwind CSS v4，设置设计 tokens", "implement"],
    ["把首页跑起来给用户看", "execute"],
    ["部署到线上", "execute"],
    ["梳理现有代码结构", "investigate"],
    ["跑一遍测试确认没坏", "verify"],
  ];
  for (const [step, kind] of cases) {
    assert.equal(actionKind({ content: step }), kind, `分类错了：${step}`);
    assert.equal(matches({ content: step }, [kind]), true,
      `对应证据反而推不动了：${step}`);
  }
});

test("execute 型步骤接受验证类证据，但反过来不成立", () => {
  // 跑起来之后拿到构建/测试输出，算它跑过了；但"跑一下"不能算"验证过了"。
  assert.equal(matches({ content: "把首页跑起来" }, ["verify"]), true);
  assert.equal(matches({ content: "跑一遍测试确认没坏" }, ["execute"]), false);
});

test("失败的工具调用不产生任何证据", () => {
  // 这条守的是另一半：工具报错了，那一步当然不算做完。
  const kinds = extractFn("_planEvidenceKindsForTool");
  assert.match(kinds, /_toolExecutionSucceeded\(call, result\)/,
    "取证据前必须先确认这次调用真的成功了");
  assert.match(kinds, /return \[\]/, "没成功就返回空证据");
});

test("兜底方向写进了注释，避免以后又被改回去", () => {
  const fn = extractFn("_planStepMatchesEvidence");
  assert.match(fn, /if \(!kind\) return false;/, "分不出类必须直接返回 false");
  assert.match(fn, /假完成|不要自动打勾/, "要写明为什么，否则很容易被当成过严又改回去");
});

// ── 中断之后说「继续」：不该从头重来 ─────────────────────────────────────────
//
// 用户报的：中断修复过程后让它继续，它会重新从头读取文件、任务计划被打乱不遵守、
// 上下文丢失。查下来是三处断口叠在一起：
//
//   1. 计划从来没进过执行模型的提示词。unfinishedPlan 只喂给了**意图分类器**
//      （旁路小模型，判定任务维度用），真正干活的模型从没见过这份计划。
//   2. 新一轮的 run._planSteps 只有模型自己调 update_plan 才有值，中断重开时是空的——
//      界面上计划条还画着，模型和执行侧手里却什么都没有。
//   3. 历史是 text-only（工具调用和结果不入库，为了压缩和重放安全），所以"读过什么"
//      只能靠证据账本转达；不明说，模型就会重读。
function resumeBlock() {
  const i = RAW_SRC.indexOf("function _resumeHandoffBlock");
  const tail = '\n  } catch { return ""; }\n}';
  const end = RAW_SRC.indexOf(tail, i);
  assert.ok(i > 0 && end > i, "找不到 _resumeHandoffBlock");
  return new Function(SRC.slice(i, end + tail.length) + "\nreturn _resumeHandoffBlock;")();
}
const PLAN = [
  { content: "读取现有实现", status: "completed" },
  { content: "补上隔离", status: "completed" },
  { content: "给失败分支补卡片", status: "in_progress" },
  { content: "跑完整测试", status: "pending" },
];

test("中断之后要把计划和进度交接给模型——不然它只能重新规划", () => {
  const out = resumeBlock()({ _planSteps: PLAN, _lastRunState: { outcome: "partial", task: "把卡片做完", incompleteReason: "用户中断" } });
  assert.match(out, /上次在做：把卡片做完/);
  assert.match(out, /中断在：用户中断/);
  assert.match(out, /已完成的步骤（真要接着做的话别重做）：读取现有实现、补上隔离/);
  assert.match(out, /还没做的步骤：给失败分支补卡片、跑完整测试/);
  assert.match(out, /不要重新 search 定位、也不要整份重读/, "没有明说别重读，它就会重读");
});

test("残留计划不许替用户把这一轮定性成「接着上次做」", () => {
  // 用户实拍：上一轮让它诊断，它列了 10 个问题在等决定（于是留下未完成步骤）；
  // 下一轮用户问「我的项目是干嘛用的」，模型回的却是"上一轮已交付诊断报告，现在等你
  // 决定：要立即修 / 要看某条 / ……"——问什么答什么这件最基本的事被这段话顶掉了。
  const out = resumeBlock()({ _planSteps: PLAN, _lastRunState: { outcome: "partial", task: "把卡片做完" } });
  assert.doesNotMatch(out, /这一轮是接着上次继续/,
    "又在用户开口之前替他把这一轮定性了——他这次问别的，就会被顶掉");
  assert.doesNotMatch(out, /直接从第一个未完成的步骤接着做。/,
    "无条件命令它接着做，等于覆盖用户这次真正说的话");
  assert.match(out, /这是背景，不是本轮要做的事/);
  assert.match(out, /本轮做什么，一律以下面 📌 里用户这次说的话为准/,
    "必须把判断权交回给用户这次说的话");
  assert.match(out, /他这次问的、要的是别的事 → 就回答\/去做他现在要的那件/);
  assert.match(out, /别反过来问他「要不要继续上次那个」/,
    "不写这句，它就会用一份选项菜单反问，而不是回答问题");
});

test("正常收尾之后开的新任务，不能被上一轮的旧计划粘住", () => {
  assert.equal(resumeBlock()({ _planSteps: PLAN, _lastRunState: { outcome: "success" } }), "");
});

test("计划全做完 / 压根没有计划时，不输出这段", () => {
  const rb = resumeBlock();
  assert.equal(rb({ _planSteps: PLAN.map((x) => ({ ...x, status: "completed" })), _lastRunState: { outcome: "partial" } }), "");
  assert.equal(rb({ _lastRunState: { outcome: "failed" } }), "");
});

test("这段要真的进提示词，而且排在项目上下文之前", () => {
  // 它讲的是"这一轮该怎么接"，比项目背景更该被先读到。
  const at = RAW_SRC.indexOf("const _dynPreamble =");
  assert.ok(at > 0);
  const seg = SRC.slice(at, at + 500);
  assert.match(seg, /_resumeBlock \? _resumeBlock \+ "\\n\\n" : ""/, "交接块没有拼进提示词");
  assert.ok(seg.indexOf("_resumeBlock") < seg.indexOf("项目上下文"), "交接块排在了项目上下文后面");
});

test("计划继承：限 agent 模式、排在 planSteps 声明之后、并同步局部变量", () => {
  const loop = extractFn("_runAgenticLoop");
  const at = loop.indexOf("run._planSteps = _prevPlan.map");
  assert.ok(at > 0, "找不到继承块");
  const seg = loop.slice(Math.max(0, at - 700), at + 200);

  assert.match(seg, /_prevOutcome === "failed" \|\| _prevOutcome === "partial"/,
    "继承没有限定在「确实没跑完」，正常收尾后的新任务会被旧计划粘住");
  // 只读模式继承来的实现步骤根本执行不了，却会触发无模式门的 planFinish：
  // 最多 3 个多余回合去催一个只读模式"继续做下一步"，再给正常回答盖上未完成。
  assert.match(seg, /isAgent &&/, "继承没有模式门");
  // 只设 run._planSteps 的话循环局部的 planSteps 永远是 null，好几处判据都以为「没有计划」。
  //（那两条靠它的注入——planNudge / planRefresh——2026-09-02 已并进〔执行状态〕块和
  // update_plan 的工具描述，但 planSteps 本身仍有别的读者。）
  assert.match(seg, /planSteps = run\._planSteps;/, "没有同步循环局部的 planSteps");
  // isAgent 在 planSteps 声明附近才出现，继承块必须排在它之后
  assert.ok(loop.indexOf("let didMutate = false") < at, "继承块排在了 planSteps 声明之前");
  assert.ok(loop.indexOf("const isAgent = run.mode ===") < at, "继承块排在 isAgent 声明之前，拿不到它");
});

test("user_stopped 要有对应人话，不能把内部枚举名甩给用户", () => {
  const at = RAW_SRC.indexOf("const _INCOMPLETE_LABELS");
  assert.ok(at > 0);
  assert.match(SRC.slice(at, at + 600), /user_stopped: "/,
    "新枚举值没有人话，建议行会退回泛泛的「继续完成剩余部分」，send 串还会写「因 user_stopped 未完成」");
});

test("用户按停必须产出可续跑的结局，否则整套交接是死的", () => {
  // 按停时循环是**干净 break** 出来的：不抛异常（finalErr 空），也没走到那几个会设
  // _incompleteReason 的收尾门。于是结局被判成 success——而交接块和计划继承都只在
  // failed/partial 时成立，两个机制一个都不会触发。交接写得再好也喂不到。
  const loop = extractFn("_runAgenticLoop");
  assert.match(loop, /const _stoppedEarly = !_live\(\);/,
    "没有捕捉「这一轮是被停掉的」这个事实");
  // 那串 || 先拆成具名成因链，后来整个搬进 src/agent/outcome.js（为了能真跑而不是
  // 匹配源码文本）。被守的性质一个字没变：「被停掉」必须进入结局判定，而且必须排在
  // **第一位**——排在后面就会被别的分支抢先命中，存档里记下的成因就不是真正促成它的那一个。
  //
  // 分两处守：判定本身做真往返，调用点守「这个事实真的被传进去了」。
  // 少了后者，判定再对也可能压根没人喂它。
  assert.equal(_partialCause({ stoppedEarly: true }), "stopped_early");
  assert.equal(_partialCause({ stoppedEarly: true, incompleteReason: "x", hitCap: true, didMutate: true }),
    "stopped_early", "「被停掉」被别的成因抢先了，存档里记下的就不是真正促成它的那一个");
  assert.equal(_runOutcome({ stoppedEarly: true }), "partial",
    "按停后结局仍是 success —— 交接块和计划继承都只在 failed/partial 时成立，一个都不会触发");
  assert.match(loop, /stoppedEarly: _stoppedEarly/,
    "「这一轮是被停掉的」没被传进结局判定，判定再对也没人喂它");
  // 「结局由成因派生」现在由 outcome.js 保证（runOutcome 拿 partialCause 的结果当参数），
  // 这里守调用点：主循环必须把算出来的那个成因传回去，不许另起一份平行判定。
  assert.match(loop, /_runOutcomeOf\(_outcomeFacts, _partialCause\)/,
    "结局必须由成因派生——另起一份平行判定迟早和成因漂开");
  assert.equal(_runOutcome({ hitCap: true }, ""), "success",
    "runOutcome 必须以传进来的成因为准，不许自己再判一次");
  assert.match(loop, /run\._incompleteReason = run\._incompleteReason \|\| "user_stopped"/,
    "没有记下中断原因，交接块就说不出「中断在哪」");

  // 取值时机：_setStreaming(session, false) 之后 _live() 对所有运行都为假，
  // 正常收尾的会被误判成中断。
  // 先剥注释：上面那段解释里原样引用了 _setStreaming(session, false)，
  // 不剥的话这条顺序断言是在跟我自己的注释较劲（这个仓库踩过好几次）。
  const code = loop.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const capture = code.indexOf("const _stoppedEarly = !_live();");
  const teardown = code.indexOf("_setStreaming(session, false)");
  assert.ok(capture > 0 && teardown > 0, "锚点缺失");
  assert.ok(capture < teardown,
    "在 _setStreaming(false) 之后才取值——那时每一次运行看起来都像被停了");
});

// ── 三条 plan 提醒并进已有通道（2026-09-02）───────────────────────────────────
// 事实（还剩哪几步 / 状态多久没动）→〔执行状态〕块，每一轮都在；
// 义务（改动铺开就该先落计划）→ update_plan 的工具描述，静态、走缓存。
// 三条 _pushNudge 因此整条撤掉。下面这条守的是「真的搬过去了」，不是「删干净了」。
test("plan 的三条提醒搬进每轮状态块与工具描述，事实与义务一条都不能少", () => {
  const line = load("_planStateLineText", { _PLAN_STATE_TAG: "〔计划〕" });
  const steps = (...st) => st.map((status, i) => ({ status, content: `第${i + 1}件事`, kind: "write" }));

  // ① 后面还欠着的步骤要点名（原 planRefresh：每 8 轮说一次还剩哪几步）。
  const mid = line({ _planSteps: steps("completed", "in_progress", "pending", "pending", "pending") });
  assert.match(mid, /后面还有 3 步/, "不点名剩余步骤，planRefresh 就是被删掉而不是被搬走");
  assert.match(mid, /第3件事/, "要点名具体是哪几步，只报数字等于没说");

  // ② 状态一直不动要说出来（原 planStale：连续 8 次工具调用签名没变）。
  const fresh = { _planSteps: steps("completed", "pending", "pending"), _planSigStaleOps: 7 };
  assert.doesNotMatch(line(fresh), /一个都没动过/, "没到阈值就说话 = 每轮都在骂人");
  const stale = { _planSteps: steps("completed", "pending", "pending"), _planSigStaleOps: 9 };
  assert.match(line(stale), /9 次工具调用里/, "到了阈值必须说，否则进度条一直 0/N 没人管");
  assert.match(line(stale), /进度条就一直停在 1\/3/, "要把用户那侧看到的数字摆出来");

  // ③ 义务在**网关那份**工具描述里（发布构建会把客户端描述剥空，模型只看得到网关那份）。
  const gw = JSON.parse(readFileSync(join(HERE, "..", "..", "server", "prompts", "tools.json"), "utf8"));
  const up = (gw.find((t) => (t.function || t).name === "update_plan")?.function || {}).description || "";
  assert.match(up, /three or more files/i, "原 planNudge 的义务没进工具描述 —— 那就是纯删弱");
  assert.match(up, /land one before you touch the next file/i);

  // ④ 三条 _pushNudge 确实不在了（搬走之后留着就是两处说同一件事）。
  const loop = extractFn("_runAgenticLoop");
  for (const c of ["planStale", "planRefresh", "planNudge"]) {
    assert.doesNotMatch(loop, new RegExp(`_pushNudge\\("${c}"`), `${c} 还在推消息`);
  }
  // 但台账要留着：_planSigStaleOps 没人维护的话，②那段永远不成立。
  assert.match(loop, /run\._planSigStaleOps = \(run\._planSigStaleOps \|\| 0\) \+ items\.length/,
    "陈旧计数没人加，状态块里那句话永远不会出现");
  assert.match(loop, /run\._planSigStaleOps = 0;/, "签名变了不清零，那句话就会永久卡住");
});
