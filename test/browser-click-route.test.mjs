import test from "node:test";
import assert from "node:assert/strict";
import { clickPrefersCdp, typePrefersCdp, locateStep, cdpFailureFallsBackToJs, runClickOrTypeStep } from "../src/agent/browser-click-route.js";

test("纯点击走 CDP；修饰键/多击/右键/坐标偏移/期望校验留在 JS 路", () => {
  assert.ok(clickPrefersCdp({ selector: "#go" }));
  assert.ok(clickPrefersCdp({ target: "登录", role: "button" }));
  assert.ok(!clickPrefersCdp({ selector: "#go", modifiers: "shift" }));
  assert.ok(!clickPrefersCdp({ selector: "#go", clickCount: 2 }));
  assert.ok(!clickPrefersCdp({ selector: "#go", button: "right" }));
  assert.ok(!clickPrefersCdp({ selector: "#go", x: 4 }));
  assert.ok(!clickPrefersCdp({ selector: "#go", expectText: "已保存" }));
  assert.ok(!clickPrefersCdp({ selector: "#go", expect_absent: true }));
  assert.ok(!clickPrefersCdp(null));
});

test("纯输入走 CDP；append 和期望校验留在 JS 路（Rust 那条总是先清空）", () => {
  assert.ok(typePrefersCdp({ selector: "#name", text: "michael" }));
  assert.ok(!typePrefersCdp({ selector: "#name", text: "x", append: true }));
  assert.ok(!typePrefersCdp({ selector: "#name", text: "x", expectValue: "x" }));
  assert.ok(!typePrefersCdp({ selector: "#name" }));
});

test("定位步：click 带 text 当目标，type 默认 textbox 角色", () => {
  assert.deepEqual(locateStep({ text: "登录" }, "", "click"), { op: "locate", kind: "click", selector: "", target: "登录", role: "", text: "登录" });
  assert.deepEqual(locateStep({ target: "邮箱" }, "[data-mnode=\"3\"]", "type"), { op: "locate", kind: "type", selector: "[data-mnode=\"3\"]", target: "邮箱", role: "textbox", text: "" });
});

test("元素找到了但不可点的失败不回落 JS 路（回落会在遮罩上点一下报成功）；其它失败回落", () => {
  assert.ok(!cdpFailureFallsBackToJs("元素被 .cookie-banner 遮住（covered）"));
  assert.ok(!cdpFailureFallsBackToJs("disabled"));
  assert.ok(cdpFailureFallsBackToJs("No node found for selector"));
  assert.ok(cdpFailureFallsBackToJs(""));
});

function harness({ locate = { ok: true, log: ["1. locate #go ✓ button#go @10,20"] }, cdpError = null, jsResult = { ok: true, log: ["1. click ✓ (js)"] } } = {}) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === "browser_eval") {
      const isLocate = /"op":"locate"/.test(args.script);
      return { screenshot: "img", result: JSON.stringify(isLocate ? locate : jsResult) };
    }
    if (cdpError) throw new Error(cdpError);
    return { screenshot: "img" };
  };
  const fastJs = (steps) => JSON.stringify(steps);
  return { calls, invoke, fastJs };
}

test("纯点击：页内只定位，随后 Rust browser_click 按 [data-mfind] 发 trusted 事件", async () => {
  const h = harness();
  const r = await runClickOrTypeStep({ kind: "click", call: { selector: "#go" }, selector: "#go", smartStep: { op: "click", selector: "#go" }, invoke: h.invoke, fastJs: h.fastJs });
  assert.equal(r.via, "cdp");
  assert.deepEqual(h.calls.map((c) => c[0]), ["browser_eval", "browser_click"]);
  assert.equal(h.calls[1][1].selector, "[data-mfind]");
  assert.match(h.calls[0][1].script, /"op":"locate"/);
  assert.equal(r.parsed.ok, true);
  assert.match(r.parsed.log[0], /CDP trusted click ✓/);
  assert.match(r.state.result, /"via":"cdp"/);
});

test("type 走 CDP 路时把文本交给 browser_type；带 append 时整段留在 JS 路", async () => {
  const h = harness();
  const r = await runClickOrTypeStep({ kind: "type", call: { selector: "#name", text: "michael" }, selector: "#name", smartStep: { op: "type" }, invoke: h.invoke, fastJs: h.fastJs });
  assert.equal(r.via, "cdp");
  assert.deepEqual(h.calls[1], ["browser_type", { selector: "[data-mfind]", text: "michael" }]);
  const h2 = harness();
  const r2 = await runClickOrTypeStep({ kind: "type", call: { selector: "#name", text: "x", append: true }, selector: "#name", smartStep: { op: "type", append: true }, invoke: h2.invoke, fastJs: h2.fastJs });
  assert.equal(r2.via, "js");
  assert.deepEqual(h2.calls.map((c) => c[0]), ["browser_eval"]);
  assert.doesNotMatch(h2.calls[0][1].script, /locate/);
});

test("定位失败：直接把 JS 路同形的 log/candidates 交回去，不再碰 Rust", async () => {
  const h = harness({ locate: { ok: false, log: ["1. locate ✗ 找不到 #nope candidates=button#go | a#lnk"], failed: { reason: "not_found" } } });
  const r = await runClickOrTypeStep({ kind: "click", call: { selector: "#nope" }, selector: "#nope", smartStep: { op: "click" }, invoke: h.invoke, fastJs: h.fastJs });
  assert.equal(r.via, "locate");
  assert.equal(r.parsed.ok, false);
  assert.match(r.parsed.log[0], /candidates=/);
  assert.deepEqual(h.calls.map((c) => c[0]), ["browser_eval"]);
});

test("Rust 那条找不到节点就回落 JS 路；元素被遮住则原样抛回（回落只会点在遮罩上）", async () => {
  const h = harness({ cdpError: "No node found for selector" });
  const r = await runClickOrTypeStep({ kind: "click", call: { selector: "#go" }, selector: "#go", smartStep: { op: "click" }, invoke: h.invoke, fastJs: h.fastJs });
  assert.equal(r.via, "js");
  assert.deepEqual(h.calls.map((c) => c[0]), ["browser_eval", "browser_click", "browser_eval"]);
  const h2 = harness({ cdpError: "[失败] 操作不到「[data-mfind]」：covered by div.cookie-banner" });
  await assert.rejects(() => runClickOrTypeStep({ kind: "click", call: { selector: "#go" }, selector: "#go", smartStep: { op: "click" }, invoke: h2.invoke, fastJs: h2.fastJs }), /covered by/);
});

test("修饰键点击整段留在 JS 路（一次 browser_eval，不定位）", async () => {
  const h = harness();
  const r = await runClickOrTypeStep({ kind: "click", call: { selector: "#go", modifiers: "shift" }, selector: "#go", smartStep: { op: "click", modifiers: "shift" }, invoke: h.invoke, fastJs: h.fastJs });
  assert.equal(r.via, "js");
  assert.deepEqual(h.calls.map((c) => c[0]), ["browser_eval"]);
});
