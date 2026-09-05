import test from "node:test";
import assert from "node:assert/strict";
import { automationNextStep } from "../src/agent/automation-hint.js";

test("sidecar 元素未找到 → 列真实可点项，不是换选择器猜；wait 超时 → 去确认会不会渲染", () => {
  const t = automationNextStep("browser.click", "元素未找到: #nope: Error -32000: Could not find node with given id");
  assert.ok(t.startsWith("\n"), "非空时带前导换行，直接接在失败文案后");
  assert.match(t, /querySelectorAll/);
  assert.match(t, /别换几个猜的选择器/);
  assert.match(automationNextStep("browser.wait", "超时: 等待元素 #h 超时"), /browser\.content/);
  assert.match(automationNextStep("browser.goto", "浏览器未启动"), /browser\.start/);
});

test("非浏览器方法或判定不了的原因 → 空串", () => {
  assert.equal(automationNextStep("mouse.click", "元素未找到"), "");
  assert.equal(automationNextStep("browser.click", "connection reset"), "");
  assert.equal(automationNextStep("", ""), "");
});
