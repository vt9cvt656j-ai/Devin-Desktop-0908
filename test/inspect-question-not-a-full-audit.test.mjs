import test from "node:test";
import assert from "node:assert";
import { SRC } from "./helpers/source.mjs";
import { workspaceToolMandate } from "../src/agent/workspace-mandate.js";

// 用户实拍：「用户说工作路径 是什么当前项目工作路径，我的居然会先看全部内容，
// 看完 跑个终端再看 ？？？？」
//
// 答案每一轮都已经在上下文里（环境块第一行就是「⚠️ 当前工作区根目录（所有相对路径基于此）」）。
// 让它去通读项目再跑终端的，是开工首轮那条 [AGENT_MODE_TOOL_REQUIRED]。

test("inspect 画像拿不到「再完成修改、运行」这半句——那是可改分支的词", () => {
  // 这是缺口的正身。_agentAnswerOnlyInspection 要求 intentSource === "ai"，而完整裁决
  // 只有会话第一轮等得起；第二轮起到场的是快通道画像：写 workspaceAction（能把强制令
  // 打开）+ intentSource="fast"（选不到收敛分支）。于是 inspect 落进了可改那条。
  const inspect = workspaceToolMandate({ workspaceAction: "inspect" }, false);
  assert.doesNotMatch(inspect, /再完成修改|完成修改、运行/);
  assert.match(inspect, /只读检查/);

  // 反方向同样要成立，否则这条修复就变成了「让所有轮都只读」——那正是历史上那个
  // 括号优先级 bug 的后果（让它改，它读一圈、讲一通该怎么改、然后停下）。
  const modify = workspaceToolMandate({ workspaceAction: "modify" }, false);
  assert.match(modify, /再完成修改/);
  assert.doesNotMatch(modify, /只读检查/);
});

test("收窄的是措辞不是能力——快通道画像不许把一轮变成只读", () => {
  // 拿快通道判断去把一轮标成只读是夺能力方向：explicitReadOnly 正因此在
  // _applyFastRouteBehaviorIfLanded 里被显式剥掉。中间这条分支必须遵守同一条线。
  const inspect = workspaceToolMandate({ workspaceAction: "inspect" }, false);
  assert.doesNotMatch(inspect, /不得运行命令|不得启动服务|不得安装依赖|不得修改文件/);
  // 而真正判定为「评价/解释型只读」（intentSource === "ai" 那条）仍然可以禁——
  // 那是完整裁决说的，不是快通道猜的。
  assert.match(workspaceToolMandate({ workspaceAction: "inspect" }, true), /不得运行命令/);
  assert.match(SRC, /merged\.explicitReadOnly = false;/,
    "快通道剥 explicitReadOnly 的那条不在了，本测试的前提就没了");
});

test("三条分支都要说明：已经注入的运行时状态就是已取得的证据", () => {
  // 用户那一幕的直接成因——模型不知道环境块算证据，于是照着「先取得真实证据」的字面，
  // 把工作区根目录这种手上已有的事实又去取了一遍。
  for (const out of [
    workspaceToolMandate({ workspaceAction: "inspect" }, true),
    workspaceToolMandate({ workspaceAction: "inspect" }, false),
    workspaceToolMandate({ workspaceAction: "modify" }, false),
  ]) {
    assert.match(out, /已经取得的证据/);
    assert.match(out, /工作区根目录/);
  }
});

test("环境块里那条根目录还在——它是上面那句话所指的东西", () => {
  // 这句是「答案本来就在手上」的物证。它没了，三条分支里那句话就成了空指。
  assert.match(SRC, /当前工作区根目录（所有相对路径基于此）/);
});

test("强制令的开关仍然只看 workspaceAction，没被这次改动改宽", () => {
  assert.match(SRC, /return profile\.workspaceAction === "inspect" \|\| profile\.workspaceAction === "modify";/);
});
