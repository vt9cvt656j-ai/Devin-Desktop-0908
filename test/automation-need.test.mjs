// 自动化「要不要跑」的档位（agent/automation-need.js）。纯函数，真跑。
import test from "node:test";
import assert from "node:assert/strict";
import { SRC, CODE } from "./helpers/source.mjs";
import { automationNeed, automationAllowed, automationBlockedReceipt, offerToVerifySuggestion, AUTOMATION_CALL_TYPES } from "../src/agent/automation-need.js";

const level = (text, extra = {}) => automationNeed({ text, ...extra }).level;

test("纯写代码 / 问答 / 调研：none——写完网站不起浏览器，不截图，不读屏", () => {
  for (const t of ["帮我写个官网", "做一个贪吃蛇游戏", "网站首页加个价格表", "那么 Telegram 和 Wecaht 哪个厉害？", "帮我做个预览功能", "重构一下登录模块", "写个 README"]) {
    assert.equal(level(t), "none", t);
  }
});

test("用户要求看 / 跑 / 测 / 操作：requested", () => {
  for (const t of ["帮我打开浏览器看看首页", "在浏览器里测一下登录流程", "run it and see", "帮我点一下那个弹窗", "登录一下 github 然后抓包", "跑一下看看效果", "帮我截个图", "自测一遍再交", "open the page and check the layout"]) {
    assert.equal(level(t), "requested", t);
  }
});

test("用户报告了运行时 / 显示问题：diagnostic（能看，但没有交付矩阵的义务）", () => {
  for (const t of ["页面白屏了", "报错了大哥", "it looks wrong on mobile", "按钮点不动", "样式乱了", "首页溢出了"]) {
    assert.equal(level(t), "diagnostic", t);
  }
});

test("裁决声明了自动化 / 抓包 / 浏览器目标：requested，哪怕原话没说", () => {
  assert.equal(level("改个按钮", { profile: { desktopAutomation: true } }), "requested");
  assert.equal(level("改个按钮", { profile: { browserAutomation: true } }), "requested");
  assert.equal(level("改个按钮", { profile: { browserGoal: "interactive" } }), "requested");
  assert.equal(level("改个按钮", { profile: { browserGoal: "none" } }), "none", "browserGoal=none 不是声明");
  assert.equal(level("改个按钮", { profile: { capture: true } }), "requested");
  assert.equal(level("改个按钮", { profile: { deliverySurface: "automation" } }), "requested");
  assert.equal(level("改个按钮", { profile: { debugProject: true } }), "diagnostic");
});

test("「继续 / 好的」沿用上一轮的档位；别的话不沿用", () => {
  assert.equal(level("继续", { prevLevel: "requested" }), "requested");
  assert.equal(level("ok", { prevLevel: "diagnostic" }), "diagnostic");
  assert.equal(level("继续", { prevLevel: "none" }), "none");
  assert.equal(level("再加个页脚", { prevLevel: "requested" }), "none", "新任务不继承上一轮的自动化档位");
});

test("IDE 自己续上的一轮：后台通知沿用上一轮；实时监听固定 diagnostic", () => {
  assert.equal(level("", { notice: { source: "background_monitor" }, prevLevel: "requested" }), "requested");
  assert.equal(level("", { notice: { source: "live_watch" }, prevLevel: "none" }), "diagnostic");
});

test("放行判据：none 只放 open / mytabs；diagnostic / requested 全放；非自动化调用不管", () => {
  assert.equal(automationAllowed("none", { type: "browser", action: "navigate" }), false);
  assert.equal(automationAllowed("none", { type: "browser", action: "open" }), true);
  assert.equal(automationAllowed("none", { type: "browser", action: "mytabs" }), true);
  assert.equal(automationAllowed("none", { type: "automation", method: "screen.capture" }), false);
  assert.equal(automationAllowed("none", { type: "readscreen" }), false);
  assert.equal(automationAllowed("none", { type: "uiclick" }), false);
  assert.equal(automationAllowed("none", { type: "screenshot", url: "http://localhost:5173" }), false);
  assert.equal(automationAllowed("none", { type: "write" }), true);
  assert.equal(automationAllowed("diagnostic", { type: "browser", action: "navigate" }), true);
  assert.equal(automationAllowed("requested", { type: "screenshot" }), true);
  for (const t of AUTOMATION_CALL_TYPES) assert.equal(automationAllowed("requested", { type: t }), true);
});

test("拦下时的回执：说清没执行什么、为什么、出路；带 dev server 地址", () => {
  const r = automationBlockedReceipt({ type: "browser", action: "navigate" }, { devServerUrl: "http://localhost:5173" });
  assert.match(r, /^\[AUTOMATION_NOT_REQUESTED\]/);
  assert.match(r, /browser navigate/);
  assert.match(r, /http:\/\/localhost:5173/);
  assert.match(r, /由用户决定/);
  const r2 = automationBlockedReceipt({ type: "automation", computer: { action: "screenshot" } });
  assert.match(r2, /computer screenshot/);
});

test("结局卡片的选项：改过界面才给，带地址", () => {
  assert.equal(offerToVerifySuggestion({ uiTouched: false }), null);
  const o = offerToVerifySuggestion({ uiTouched: true, devServerUrl: "http://localhost:3000" });
  assert.match(o.label, /浏览器/);
  assert.match(o.send, /http:\/\/localhost:3000/);
});

// ── main.js 的接线：档位真的被读了（源码断言只守调用点，行为在上面真跑） ──────────────

test("执行器闸门在唯一授权检查点之前，按 run._automationNeed === \"none\" 拦", () => {
  const code = CODE;
  const gate = code.indexOf('run._automationNeed === "none" && typeof automationAllowed === "function"');
  const approve = code.indexOf("if (!(await _approveToolCall(call, run)))");
  assert.ok(gate > 0, "执行器里没有自动化按需的闸门");
  assert.ok(approve > gate, "闸门必须在授权检查点之前——这不是用户拒绝，不该弹框让他来拒");
  assert.match(code, /failure: \{ code: "automation_not_requested"/);
});

test("界面验收的义务、设计验收模块、收尾契约、下一步选项都读档位", () => {
  const code = CODE;
  assert.match(code, /run\.mode === "agent" && run\._automationNeed !== "none"\s*&& _implOps > 0/, "「没看过」那条追加没按档位拦");
  assert.match(code, /run\.engineering\?\.ui && didMutate && run\._automationNeed !== "none"\) \{\s*uiVerificationPassed = _uiVerifiedAtImplOps === _implOps;/, "uiVerificationPassed 没按档位放行");
  assert.match(code, /run\._automationNeed !== "none" && !uiVerificationPassed\) \{\s*run\._incompleteReason \|\|= "ui_verification_missing"/, "ui_verification_missing 没按档位拦");
  assert.match(code, /add\("design_verification", p\.ui && p\.workspaceAction === "modify" && !!p\.automationNeed && p\.automationNeed !== "none"\)/, "设计验收模块没按档位挂");
  assert.match(code, /\(p\.ui \|\| p\.uiProject\) && p\.automationNeed && p\.automationNeed !== "none"\) _finishChecks\.push/, "收尾契约那条浏览器矩阵没按档位");
  assert.match(code, /run\.automationNeed === "none" && \(run\.uiTouched \|\| Number\(run\.automationBlocked \|\| 0\) > 0\)\) \{\s*const _offer = offerToVerifySuggestion/, "结局卡片没有「在浏览器里检查一下」的选项");
  assert.match(code, /automationNeed: String\(run\._automationNeed \|\| ""\),\s*automationNeedReason: String\(run\._automationNeedReason \|\| ""\),[\s\S]{0,200}uiTouched: !!\(run\.engineering\?\.ui && didMutate\)/, "_lastRunState 没记档位与是否改过界面");
});

test("档位在 run 起点、画像迟到落地、快通道、插话合并四处都重算；开局窗口不再带桌面三件套", () => {
  const code = CODE;
  assert.equal((code.match(/typeof _computeAutomationNeed === "function"\) _computeAutomationNeed\(run,/g) || []).length, 4, "四处重算少了一处（每处都要带 typeof 守卫：那几个函数会被测试 load() 抠出来单独求值）");
  const core = /agent: \["read_file"[\s\S]*?\],/.exec(code);
  assert.ok(core, "agent 核心表不见了");
  for (const t of ["read_screen", "ui_click", "computer"]) assert.ok(!core[0].includes(`"${t}"`), `${t} 还在开局窗口里——它该按档位授予`);
  assert.match(code, /if \(run\._automationNeed && run\._automationNeed !== "none"\) \{\s*for \(const t of _AUTOMATION_NEED_TOOLS\)/, "档位授予没接进窗口同步");
});
