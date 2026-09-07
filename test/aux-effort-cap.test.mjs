// 辅助调用的思考档位必须**封顶**，不能靠删键。
//
// 删掉 reasoningEffort 留下的是供应商默认档，对原生推理模型就是深档 ——
// main.js 里 `_billableAiComplete` 自己的注释早就写着「删了 reasoning* 键模型照样推理」。
// 后果是意图裁决把预算全烧在推理上、正文零字节：
//   · 线上两天 **64 次辅助调用的输出恰好卡在 4996**（= 请求的 900 + 4096 推理余量），
//     占辅助调用 13%；另有 4997×3、4995×2 —— 是死点不是巧合；
//   · 能力账本里 deepseek-v4-pro 的裁决**工程半最近 20 条有 11 条是空的**。
// 半份解不出 JSON 就不进缓存，同一句话下一轮重发、再烧一次 —— 用户侧的形状是
// 「第一发的画像是空的 → 突然变弱智」。
//
// 加余量那条路已经试过（原地实测：900 烧光、4996 照样烧光），所以是封顶。

import test from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC } from "./helpers/source.mjs";
import { auxEffortFor } from "../src/agent/aux-effort.js";

test("没拨过档位时也要发一个具体的低档 —— 省略才是出事的那种形状", () => {
  assert.equal(auxEffortFor({}), "low");
  assert.equal(auxEffortFor(null), "low");
  assert.equal(auxEffortFor({ model: "deepseek-v4-pro" }), "low",
    "原生推理模型不发字段就是深档，一次分类烧掉整份预算");
});

test("高档一律封顶到 low", () => {
  for (const high of ["high", "xhigh", "max", "medium", "HIGH"]) {
    assert.equal(auxEffortFor({ reasoningEffort: high }), "low", `${high} 没被封顶`);
  }
});

test("比 low 更低的照用户的来，只封上界", () => {
  assert.equal(auxEffortFor({ reasoningEffort: "minimal" }), "minimal");
  assert.equal(auxEffortFor({ reasoningEffort: "low" }), "low");
  assert.equal(auxEffortFor({ reasoningEffort: "off" }), "off",
    "用户显式关了思考，辅助调用不该背着他开一份");
  assert.equal(auxEffortFor({ thinkingEffort: "none" }), "none");
});

test("reasoningEffort 优先于 thinkingEffort（前者是映射后的实际值）", () => {
  assert.equal(auxEffortFor({ reasoningEffort: "minimal", thinkingEffort: "max" }), "minimal");
});

test("意图裁决真的接上了它，而且不再删那个键", () => {
  assert.match(SRC, /intentConfig\.reasoningEffort = auxEffortFor\(config\)/,
    "裁决没用封顶后的档位 —— 原生推理模型会把预算全烧在推理上");
  // 快通道是同一个 bug 的第二处，而且更经不起：它只要 200 token 的输出。
  assert.match(SRC, /cfg\.reasoningEffort = auxEffortFor\(config\)/,
    "快通道没封顶 —— 200 token 的输出上限配深档推理，正文必然一个字不剩");
  // 只数**赋值点**：SRC 里还拼着 src/agent 的模块源码，光数函数名会把定义也数进去。
  assert.equal((SRC.match(/reasoningEffort = auxEffortFor\(config\)/g) || []).length, 2,
    "辅助调用的封顶点应该正好两处（意图裁决、快通道）—— 少一处那条腿还在烧满档");
  // 删键那条路必须消失：删掉留下的是供应商默认深档，正是出事的形状。
  assert.doesNotMatch(SRC, /for \(const key of \["reasoningEffort", "thinkingBudget"/,
    "又把 reasoningEffort 删掉了 —— 留下的是供应商默认深档");
});

test("三条认知腿那条判据没被顺手改掉", () => {
  // _cognitiveLegEffort 在「没拨过档位」时返回 {}，有测试逐条钉着（「别凭空造一个
  // 默认深度出来花钱」）。它的前提对原生推理模型不成立，但那是另一处的既有保护，
  // 这次不动 —— 顺手改掉会打翻那条守卫。
  assert.match(SRC, /if \(!pref \|\| pref === "off"\) return \{\};/,
    "顺手改了认知腿的判据 —— 那条有独立的测试钉着，要改得单独论证");
});
