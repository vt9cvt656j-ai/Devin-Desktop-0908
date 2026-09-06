// 设计类旗标只认「这一轮在做界面」，不认「项目里有界面」。
//
// 生产实测（2026-09-06，网关 assembled 日志 300 条）：design 旗标在 69% 的 agent 轮次上亮着，
// 首步就点亮 design 的 run 里只有 12% 后来真用过任何界面类工具；旗标在会话里只增不减（刻意的，
// 为了前缀缓存），于是第 16 步以后系统提示词涨到 103KB、22 个块，设计套件（约 45KB）挂在
// 大多数与界面无关的任务上。病根有两处，这里各钉一条：
//   1. `uiProject` 是**项目**属性（工作区里有界面），却被当成**这一轮**在做界面的信号去点
//      design / design_implementation / design_review / design_verification；
//   2. 合并腿把 deliverySurface=web_app/desktop 直接翻成 ui=true，而弱模型报的是项目类型
//      不是这一轮的交付物。
// 粘性并集本身不动（prefix-cache.test 钉着）：从没亮过的旗标根本不会进并集，所以「更难点亮」
// 不产生任何一次缓存失效。
import test from "node:test";
import assert from "node:assert/strict";
import { fnSource, load } from "./helpers/source.mjs";

const profileOf = load("_ideSemanticProfile", ["_ideSemanticProfile"]);
const flagsOf = (p) => new Set(profileOf(p).split(":")[1].split(",").filter(Boolean));
// 维度清单按真实的那份取子集：合并腿只把清单里的键从裁决拷进画像，空清单会把 verdict.ui 整个忽略掉。
const merge = load("_mergeAiIntentProfile", { _AI_INTENT_DIMENSIONS: ["ui", "uiProject", "fullWebsite", "implementation", "designKnowledgeRequired"], _aiIntentKnowledgeDomain: () => "" });
const eng = (extra) => ({
  projectState: "existing", deliverySurface: "code", changeScope: "local", architectureMode: "follow_existing",
  dataStrategy: "not_applicable", researchMode: "none", designMode: "none", domain: "", workspaceAction: "modify",
  captureMode: "none", browserGoal: "none", orchestrationMode: "solo", roleNeeds: [], runtimeActions: [],
  externalActions: [], researchTopics: [], rationale: [], ...extra,
});

test("项目里有界面（uiProject）但这一轮没做界面：四面设计旗一面都不亮", () => {
  const f = flagsOf({ applies: true, uiProject: true, workspaceAction: "modify" });
  assert.equal(f.has("engineering"), true);
  for (const flag of ["design", "design_implementation", "design_review", "design_verification"]) {
    assert.equal(f.has(flag), false, `${flag} 由项目属性点亮了——那正是 45KB 设计套件挂到后端任务上的来路`);
  }
});

test("这一轮确实在做界面（ui）：设计旗照常亮，网关那边的 design.base / implementation / verification 都能装配", () => {
  const f = flagsOf({ applies: true, ui: true, workspaceAction: "modify" });
  for (const flag of ["design", "design_implementation", "design_verification"]) assert.equal(f.has(flag), true, flag);
  assert.equal(flagsOf({ applies: true, ui: true, workspaceAction: "inspect" }).has("design_review"), true);
  assert.equal(flagsOf({ applies: true, designKnowledgeRequired: true }).has("design"), true);
});

test("design_data 那条白名单判据一字不动（route-envelope 钉着），它已经按 dataStrategy 判过了", () => {
  assert.match(fnSource("_ideSemanticProfile", { code: true }),
    /add\("design_data", p\.uiProject && \["local", "server", "inspect_existing", "undecided"\]\.includes/);
});

test("合并腿：deliverySurface=web_app/desktop 单独出现只说明项目形态，不把这一轮判成界面任务", () => {
  for (const surface of ["web_app", "desktop"]) {
    const p = merge({ _isAgentMode: true }, { engineering: eng({ deliverySurface: surface }) }, "把这个 Rust 函数里的变量名改掉");
    assert.equal(p.ui, false, `${surface} 单独出现就把 ui 点亮了`);
    assert.equal(p.uiProject, true, `${surface} 仍然是「工作区有界面」这个事实`);
    assert.equal(p.designKnowledgeRequired, false, `${surface} 单独出现就要求设计体系了`);
  }
});

test("合并腿：带前端/设计角色、或明确的 ui 维度、或 ui_component/website 交付面，仍判成界面任务（既有场景不退）", () => {
  const cases = [
    ["desktop + frontend 角色", { engineering: eng({ deliverySurface: "desktop", roleNeeds: ["frontend"] }) }],
    ["web_app + design 角色", { engineering: eng({ deliverySurface: "web_app", roleNeeds: ["design"] }) }],
    ["web_app + ui 维度", { ui: true, engineering: eng({ deliverySurface: "web_app" }) }],
    ["ui_component", { engineering: eng({ deliverySurface: "ui_component" }) }],
    ["website", { engineering: eng({ deliverySurface: "website" }) }],
    ["mixed + frontend 角色", { engineering: eng({ deliverySurface: "mixed", roleNeeds: ["frontend", "backend"] }) }],
  ];
  for (const [name, verdict] of cases) {
    const p = merge({ _isAgentMode: true }, verdict, name);
    assert.equal(p.ui, true, `${name}：ui 没亮`);
    assert.equal(p.designKnowledgeRequired, true, `${name}：设计体系没挂上`);
  }
});

test("fullWebsite 说的是交付整站/整个前端：在已有 web_app 里改一处不算，新建/从零设计才算", () => {
  const modify = merge({ _isAgentMode: true }, { ui: true, engineering: eng({ deliverySurface: "web_app" }) }, "改一下登录页的按钮");
  assert.equal(modify.fullWebsite, false, "改现有页面被当成整站交付，会把 design_content / design_motion / 完整设计知识包全挂上");
  const create = merge({ _isAgentMode: true }, { ui: true, semantic: { action: "create" }, engineering: eng({ deliverySurface: "website", architectureMode: "design_new" }) }, "做一个官网");
  assert.equal(create.fullWebsite, true);
  const declared = merge({ _isAgentMode: true }, { ui: true, fullWebsite: true, engineering: eng({ deliverySurface: "web_app" }) }, "整个前端重做");
  assert.equal(declared.fullWebsite, true, "模型明确声明的 fullWebsite 必须保留");
});

test("意图分类器：工程半的示例是中性的，且写明示例只示意形状——弱模型照抄示例时抄到的是 solo/code/none", () => {
  const src = fnSource("_aiIntentProfile");
  assert.doesNotMatch(src, /"orchestrationMode":"staged_roles","roleNeeds":\["architect","frontend","test"\]/,
    "大而全的示例又回来了：glm 首步平均 13 个旗标、83% 点设计、67% 点调研，就是照抄它的形状");
  assert.doesNotMatch(src, /"dimensions":\{"ui":true,"uiProject":true/, "示例里的 ui/uiProject 会被弱模型原样抄回来");
  assert.match(src, /"orchestrationMode":"solo","roleNeeds":\[\]/, "工程半示例应是 solo、空角色");
  assert.match(src, /示例取值只示意形状/, "得告诉模型示例值不是答案");
  assert.match(src, /ui 只在\*\*这一轮\*\*要新建\/修改\/评审可见界面时为 true/, "ui 与 uiProject 的含义必须分开写清");
  assert.match(src, /判不准就省略/, "误判比漏判贵：这句在快通道里早就有，完整裁决也要有");
});

test("快通道的含义要点也分开写 ui / uiProject / fullWebsite（两条路同一份定义）", () => {
  const src = fnSource("_fastRoutingFlags");
  assert.doesNotMatch(src, /designKnowledgeRequired\/ui\/uiProject=涉及可见界面/, "三个键共用一句「涉及可见界面」，模型分不清项目属性和本轮任务");
  assert.match(src, /ui=这一轮要新建\/修改\/评审可见界面/);
  assert.match(src, /uiProject=工作区里有界面这一事实/);
});

test("客户端自己注入的设计块也只认这一轮：项目有界面但这轮不做界面时不发 4K 的设计律", () => {
  const craft = fnSource("_uiDesignCraftBlock", { code: true });
  assert.doesNotMatch(craft, /if \(!\(p\.ui \|\| p\.uiProject\)\)/, "_uiDesignCraftBlock 还在按 uiProject 发整块");
  assert.match(craft, /_uiStructuralSignal\(text\)/, "结构事实兜底（改到前端源码就提醒）必须还在");
  const plan = fnSource("_michaelDesignResearchPlan", { code: true });
  assert.doesNotMatch(plan, /p\.designKnowledgeRequired \|\| p\.uiProject/, "设计预检三条检索还在按 uiProject 起跑");
  const frame = fnSource("_agentDecisionFrameBlock", { code: true });
  assert.doesNotMatch(frame, /if \(p\.ui \|\| p\.uiProject\) \{\n\s*lines\.push\("UI\/前端律/, "决策框架里的 UI/前端律还在按 uiProject 发");
});
