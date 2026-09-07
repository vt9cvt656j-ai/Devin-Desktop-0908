import test from "node:test";
import assert from "node:assert/strict";
import { CODE, fnSource } from "./helpers/source.mjs";
import { toolPolicy, readOnlyBlockedTypes } from "../src/agent/tool-policy.js";
import { baseTools, readonlyExternalTools, writeTools } from "../src/agent/tool-catalog.js";

// 只读模式（Explorer / Plan / Reviewer）的工具窗口靠 _readOnlyBlockedTool 过滤。
// 它原来把**模型看见的工具名**去掉下划线，拿去查**内部调用类型**为键的策略表 —— 两个
// 命名空间。142 个工具里只有 5 个能对上，而且全是巧合（ui_click→uiclick、
// multi_edit→multiedit、save_skill→saveskill、learn_design→learndesign、
// create_project→createproject）；write_file→"writefile"、run_cmd→"runcmd"、
// run_worker→"runworker" 在表里都不存在，一律拿默认值 false。
// 后果：只读模式的工具窗口里照样摆着写文件、跑命令、派可写 worker，模型据此规划，
// 动手时才被拒 —— 白走一轮，正是"做点事就撞门"。

/** 产品自己那份 名字→类型 映射（_mapToolCall 的 case 表），别在测试里手抄一份。 */
function nameToType() {
  // 按 `case "x":` 切段再取该段第一个 type —— 有的分支是块体
  // （case "run_cmd": { … return { type: "cmd", … } }），单行正则会整条漏掉。
  const body = fnSource("_mapToolCall", { code: true });
  const m = new Map();
  const parts = body.split(/case "([a-z_0-9]+)":/);
  for (let i = 1; i < parts.length; i += 2) {
    const hit = /type:\s*"([a-z_0-9]+)"/.exec(parts[i + 1] || "");
    if (hit) m.set(parts[i], hit[1]);
  }
  assert.ok(m.size > 80, `只抠到 ${m.size} 条映射，取法跟不上源码了`);
  return m;
}

const CATALOG = [...baseTools(), ...readonlyExternalTools(), ...writeTools()]
  .map((t) => t.name || t.function?.name).filter(Boolean);

test("判据用真实映射，不是「工具名去下划线」", () => {
  assert.match(CODE, /const t = _mapToolCall\(n, \{\}\)\?\.type;/,
    "又拿工具名去凑策略表的键了");
  assert.doesNotMatch(fnSource("_readOnlyBlockedTool", { code: true }), /replace\(\/_\/g, ""\)/,
    "去下划线那一招回来了");
  // 查不到类型要**放行**，不是拦掉：拦掉会在映射表跟不上时把整个只读模式的工具清空。
  // （目录里当前每个工具都有映射，所以这条只能钉源码形状——它守的是将来新增的工具。）
  assert.match(fnSource("_readOnlyBlockedTool", { code: true }), /return !!t && toolPolicy\(t\)\?\.readOnlyModeBlocked === true;/,
    "查不到类型时改成拦掉了——映射一跟不上，只读模式就一个工具都没有");
});

test("组合起来之后，会写盘/跑命令的工具真的落进只读禁用集合", () => {
  const map = nameToType();
  const blocked = (name) => {
    const t = map.get(name);
    return !!t && toolPolicy(t)?.readOnlyModeBlocked === true;
  };
  // 这几个是只读模式绝不该出现在窗口里的
  for (const n of ["write_file", "edit_file", "multi_edit", "run_cmd", "run_worker",
                   "delete_path", "move_path", "copy_path", "create_dir", "run_in_terminal"]) {
    assert.equal(blocked(n), true, `${n} 在只读模式的工具窗口里仍然发得出去`);
  }
  // 只读工具当然不能被误伤
  for (const n of ["read_file", "list_dir", "search", "find_files", "git_status", "get_diagnostics"]) {
    assert.equal(blocked(n), false, `${n} 是纯读，被挡掉等于只读模式什么都干不了`);
  }
});

test("去下划线那一招在这份真实目录上确实只能碰对 5 个", () => {
  // 这条把"为什么必须改"钉成可复现的数字：判据一旦退回去，这里立刻和上面那条一起红。
  const old = (name) => {
    const k = String(name || "").replace(/_/g, "").toLowerCase();
    try { return toolPolicy(k)?.readOnlyModeBlocked === true; } catch { return false; }
  };
  const hit = CATALOG.filter(old).sort();
  assert.deepEqual(hit, ["create_project", "learn_design", "multi_edit", "save_skill", "ui_click"],
    "巧合命中的那批变了——说明目录或策略表动过，这条数字要跟着复核");
  assert.ok(readOnlyBlockedTypes().size > hit.length * 4,
    "真正该挡的类型远多于去下划线能碰对的那几个");
});
