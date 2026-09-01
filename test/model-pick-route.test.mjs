/*
 * 点了哪一行，就必须发到哪条线路。
 *
 * 后台的「分组」（models.group_into）会把另一条线路的模型并进同一个标题下。线上真配着
 * 这么一组：专属线路 `glm-5.3-flash`（倍率 1、没有多路由出口）被分组显示到「智普」下，
 * 而「智普」自己的一个出口（15token）也声明了 glm-5.3-flash —— 于是模型选择器的「智普」
 * 组里出现**两行同名**，一行倍率 1、一行倍率 2。
 *
 * 原来的选择链是 `selectModel(m.id, grpLabel)`：被点中的那一行手里攥着确定的 `connId`，
 * 调用方把它扔了，下游再按 (id, 组名) 回查 —— 而回查是「同组内命中即返回列表里靠前的
 * 那条」。服务端按 sort 下发，智普 sort=50、专属线路 sort=110，所以**点哪一行都解析成
 * 智普**。它会被写进 gatewayRouteId、作为 x-ide-route 发给网关，而网关按被选中的**线路**
 * 计费（不是按模型），于是用户点的是倍率 1 那行、账单按倍率 2 出。
 *
 * 这条测的是行为：同一份目录，只改「传不传 connId」，解析结果必须不同。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, SRC, at } from "./helpers/source.mjs";

// 线上那一组的形状：同一个组标题下两行同名，connId 不同。
const GROUPS = [
  {
    label: "智普",
    models: [
      { id: "glm-5.3-flash", connId: "route-zhipu", label: "智普那条（倍率 2）" },
      { id: "glm-5.3-flash", connId: "route-dedicated", label: "专属那条（倍率 1）" },
    ],
  },
  {
    label: "Claude",
    models: [{ id: "claude-opus-5", connId: "route-claude", label: "Claude" }],
  },
];

const entry = load("_modelCatalogEntry", {
  MODEL_GROUPS: GROUPS,
  _CUSTOM_MODEL_PREFIX: "custom:",
  _customModelById: () => null,
  loadConfig: () => ({ modelGroup: "" }),
});

test("传了 connId 就必须解析成那一条，不许回查", () => {
  assert.equal(
    entry("glm-5.3-flash", "智普", "route-dedicated").connId,
    "route-dedicated",
    "点的是专属线路那一行，却解析到了别的线路 —— 请求和账单都会走错",
  );
  assert.equal(
    entry("glm-5.3-flash", "智普", "route-zhipu").connId,
    "route-zhipu",
    "另一行也要能被精确选中，否则只是把偏好从一边挪到了另一边",
  );
});

test("不传 connId 时行为逐字不变（组内取靠前的那条）", () => {
  assert.equal(
    entry("glm-5.3-flash", "智普").connId,
    "route-zhipu",
    "旧行为变了 —— 所有不传 connId 的调用点（上下文上限、思考档位、强力版按钮…）会跟着漂",
  );
});

test("跨分组的消歧没有被这次改动带坏", () => {
  assert.equal(entry("claude-opus-5", "Claude").connId, "route-claude");
  // 组名对不上时退回第一条，而不是返回 null 让整块信息消失。
  assert.equal(entry("claude-opus-5", "已经被改名的组").connId, "route-claude");
});

test("认不出的 connId 不能让选择落空", () => {
  // 传了个过期/错误的 connId（线路被删、后台改配置）时，必须退回按组解析，
  // 而不是返回 null —— 那会让模型卡片、上下文上限、价格全部消失。
  assert.equal(
    entry("glm-5.3-flash", "智普", "route-that-no-longer-exists").connId,
    "route-zhipu",
    "认不出的 connId 让解析落空了",
  );
});

test("菜单点击真的把那一行的 connId 交了出去", () => {
  // 纯函数对了不等于调用点用了它：这个 bug 的本体就在调用点。
  at(SRC, "selectModel(m.id, grpLabel, m.connId);", "模型菜单的点击处理");
  assert.equal(
    SRC.includes("selectModel(m.id, grpLabel);"),
    false,
    "还有地方在丢掉 connId 调 selectModel",
  );
  // 存进配置的那一位也必须来自解析结果，否则发出去的 x-ide-route 还是错的。
  at(SRC, 'gatewayRouteId: String(_picked?.connId || "")', "选中后写回配置");
});
