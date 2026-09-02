// 用户自己声明的角色。
//
// 角色以前是**三张写死的表**：合法名单、提示词、工具矩阵。加一个角色要改三处代码，
// 而这三处的查表函数早就写成了「按 key 查、查不到返回默认」——缺的从来不是分发，
// 是「行」的来源。
//
// 这里守住三条，每条都对着一种「加了等于没加」的失败：
//   1. 声明的提示词真的到了子智能体手里（否则角色只是个名字）
//   2. 声明的工具矩阵真的到了子智能体手里（否则 design 角色打不开浏览器）
//   3. 模型**知道**这个角色存在（枚举里没有的角色，它永远不会选）
import { readFileSync } from "node:fs";
import { roleCapabilities, ROLE_CAPABILITIES, ROLE_CAPABILITIES_READ } from "../src/agent/subagent-roles.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCapabilities } from "../src/agent/capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `SRC` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as SRC, SRC as RAW_SRC, fnSource as extractFn } from "./helpers/source.mjs";

const DECL = normalizeCapabilities({
  roles: [{
    name: "data",
    prompt: "你是数据工程专家：先看清表结构和数据量级，再动手。",
    tools: ["db_query", "http_request", "这个工具不存在"],
    types: ["db", "http"],
  }],
}, "项目配置");

/** 用给定声明构建 _userRoleMap（内部要查真实工具目录，所以把它也一并注入）。 */
function roleMapWith(caps) {
  return new Function(
    "_userCapabilities", "_buildAgentToolSchemas",
    `${extractFn("_userRoleMap")}\n;return _userRoleMap;`,
  )(
    () => caps,
    () => [
      { function: { name: "db_query" } },
      { function: { name: "http_request" } },
      { function: { name: "browser" } },
    ],
  )();
}

test("声明的提示词真的进了子智能体的角色段", () => {
  const block = new Function(
    "_userRoleMap", "_AGENT_ROLE_BLOCKS",
    `${extractFn("_agentRoleBlock")}\n;return _agentRoleBlock;`,
  )(() => roleMapWith(DECL), { frontend: "内置前端角色" });
  assert.match(block("data"), /数据工程专家/, "声明的角色提示词没到子智能体手里——那这个角色只是个名字");
  // 内置角色不受影响。
  assert.match(block("frontend"), /内置前端角色/);
  // 谁都不认识的角色仍然返回空，而不是抛错。
  assert.equal(block("不存在的角色"), "");
});

test("声明的工具矩阵真的到了子智能体手里，而写错的工具名被挡掉", () => {
  // 角色策略已搬进 src/agent/subagent-roles.js —— 直接用产品代码。
  // 用户自声明的角色表现在是**参数**（它要读工具注册表，留在 main.js 那边），
  // 所以这里传进去就行，不用再往沙箱里注三张矩阵。
  const caps = (role, write) => roleCapabilities(role, write, roleMapWith(DECL));

  const got = caps("data", true);
  assert.deepEqual(got.tools, ["db_query", "http_request"],
    "不存在的工具名必须被挡掉——放行的代价是子智能体派出去之后才发现手里没这件工具");
  assert.deepEqual(got.types, ["db", "http"]);
  // 只读子智能体照旧什么副作用工具都不给，用户声明也不能突破这条。
  assert.deepEqual(caps("data", false), { tools: [], types: [] });
  // 内置角色不受影响。
  // 内置角色不受影响（真表里 frontend 是 browser + generate_image）。
  assert.deepEqual(caps("frontend", true).tools, ["browser", "visual_compare", "generate_image"]);
});

test("没有任何声明时，角色行为和以前完全一样", () => {
  const empty = normalizeCapabilities({}, "");
  // 这条验的是「一条声明都没有时」——所以传的是**空**角色表，不是 DECL。
  const caps = (role, write) => roleCapabilities(role, write, roleMapWith(empty));
  // 内置角色不受影响（真表里 frontend 是 browser + generate_image）。
  assert.deepEqual(caps("frontend", true).tools, ["browser", "visual_compare", "generate_image"]);
  assert.deepEqual(caps("data", true), { tools: [], types: [] });
});

test("模型要知道这个角色存在——但没声明时提示词必须逐字节不变", () => {
  const suffix = new Function(
    "_userCapabilities",
    `${extractFn("_userRoleEnumSuffix")}\n;return _userRoleEnumSuffix;`,
  );
  // 没声明 → 空串。这段提示词在缓存前缀里，多一个字符就是一次全量未命中。
  assert.equal(suffix(() => normalizeCapabilities({}, ""))(), "",
    "没声明角色时也改了提示词——那会让所有用户白丢一次 prompt cache");
  assert.equal(suffix(() => DECL)(), "/data", "声明了角色，枚举里却没有它，模型永远不会选它");
});

test("模型编出来的角色名仍然挡住", () => {
  // 放宽到用户声明不等于放开：编出来的角色既没提示词也没工具矩阵，派出去是个空壳。
  assert.match(SRC, /_AI_AGENT_ROLES\.has\(item\) \|\| _userRoleMap\(\)\.has\(item\)/,
    "角色过滤要么被删了、要么没接上用户声明");
});

/**
 * 角色可以声明自己跑在哪个模型上（参照 Claude Code 的 subagent frontmatter `model:`）。
 *
 * 这条守的核心是**默认不变**：没声明 model 的角色必须和以前一模一样跑在用户此刻
 * 选的模型上。harness 替用户挑模型这件事在本仓库是被明令删掉的（_pickCheapModel），
 * 所以「加了这个能力」绝不能顺带变成「harness 现在会挑模型了」。
 */
test("角色没声明模型时，子体拿到的就是父体那份 config 本身", () => {
  const src = extractFn("_runSubAgent");
  const at = src.indexOf("let _subConfig = config;");
  assert.ok(at > 0, "子体配置的落点不见了");
  // 默认路径是恒等：只有 _roleModel 非空**且**和父体不同才会新建对象。
  assert.match(src.slice(at, at + 900), /if \(_roleModel && _roleModel !== config\?\.model\) \{/,
    "没声明模型时必须走恒等路径——新建一份 config 就是在悄悄改计费口径");
});

test("声明的模型查不到时继承父体，并且说出来", () => {
  const src = extractFn("_runSubAgent");
  const at = src.indexOf("let _subConfig = config;");
  const blk = src.slice(at, at + 1200);
  assert.match(blk, /MODEL_NAMES && MODEL_NAMES\[_roleModel\]/,
    "存在性必须查——声明一个不存在的模型会让这个角色的每一次派发都失败");
  assert.match(blk, /_roleModelNote = `\[role:\$\{role\}\] 声明的模型/,
    "查不到时要留下可见理由，不能静默继承");
  // customModelId 必须一并丢掉：推理档位按 `customModelId || model` 查用户偏好，
  // 留着的话新模型会去读旧连接的档位。
  assert.match(blk, /customModelId: undefined/,
    "换模型没清 customModelId——推理档位会去读旧连接的偏好");
});

test("上下文上限跟着实际跑的那个模型，不是父体的", () => {
  // 角色声明成小窗口模型时，按父模型的上限裁剪 = 本地以为还装得下、上游直接截断。
  const src = extractFn("_runSubAgent");
  // 键是 `customModelId || model`：自定义线路上 config.model 已被改写成上游真名，
  // 只传 model 就查不到用户在卡片上选的窗口（见 logic.test.mjs 那条自定义端点的往返）。
  // 角色声明了自己的模型时 customModelId 为空，回落到 _roleModel，这条的原意不变。
  assert.match(src, /_effectiveContextLimit\(_subConfig\?\.customModelId \|\| _subConfig\?\.model\)/,
    "裁剪用的还是父体的模型");
});

test("角色声明里的 model 一路带到派发", () => {
  const declared = normalizeCapabilities({
    roles: [{ name: "heavy", prompt: "深度分析角色。", model: "claude-opus-5" }],
  }, "项目配置");
  assert.equal(declared.errors.length, 0, `声明不该报错：${declared.errors.join("；")}`);
  assert.equal(declared.roles[0].model, "claude-opus-5", "声明层就把 model 丢了");
  // 没写 model 的角色拿到空串，不是 undefined —— 派发那边用 String(...) 判空。
  const plain = normalizeCapabilities({ roles: [{ name: "plainrole", prompt: "普通角色。" }] }, "项目配置");
  assert.equal(plain.roles[0].model, "", "没声明时必须是空串，让派发侧的判空是恒定的");
  // 携带层：_userRoleMap 必须把它带过去，否则声明到此为止。
  assert.match(extractFn("_userRoleMap"), /model: r\.model \|\| ""/,
    "_userRoleMap 没把声明的模型带给派发侧");
});

test("没有加角色级 effort —— 那会把刚删掉的静默改档装回来", () => {
  // 推理档位在本产品里是**按模型存的用户偏好**：角色换了模型，档位自动跟着那个模型走。
  // 再加一个角色级 effort 就等于「用户在转盘上选了一档、实际发出去另一档」，
  // 而 _applyThinkingToConfig 的注释里写着那两道自动降档刚刚才被删除。
  const src = extractFn("_runSubAgent");
  const at = src.indexOf("let _subConfig = config;");
  assert.doesNotMatch(src.slice(at, at + 1200), /reasoningEffort|thinkingEffort/,
    "子体派发处开始改推理档位了——那正是被删掉的那个形状");
  const caps = normalizeCapabilities({
    roles: [{ name: "effortrole", prompt: "试图声明档位的角色。", effort: "high" }],
  }, "项目配置");
  assert.equal(caps.roles[0].effort, undefined,
    "角色声明开始接收 effort 了——档位只有一处真相：用户给那个模型选的偏好");
});

/**
 * 可写矩阵必须是只读矩阵的**超集**。
 *
 * 这条不是风格问题，它修的是一个反过来的现实：两张角色表分两次写成，只读那张后补、
 * 补完没并进可写那张，于是「能动手修的那一档反而看不到证据」——前端的可写 worker
 * 拿不到截图比对，安全的可写 worker 拿不到流量取证，而它们才是真正需要那些证据的人。
 *
 * 判据写成不变量而不是逐个角色列清单：以后往只读表加东西、忘了并进可写表，这条会红。
 */
test("每个角色的可写工具集，必须包含它的只读工具集", () => {
  const lost = [];
  for (const role of new Set([...Object.keys(ROLE_CAPABILITIES), ...Object.keys(ROLE_CAPABILITIES_READ)])) {
    const ro = roleCapabilities(role, false);
    const rw = roleCapabilities(role, true);
    for (const t of ro.tools) if (!rw.tools.includes(t)) lost.push(`${role}.tools 丢了 ${t}`);
    for (const t of ro.types) if (!rw.types.includes(t)) lost.push(`${role}.types 丢了 ${t}`);
  }
  assert.deepEqual(lost, [],
    `可写档比只读档还少工具——能动手修的那一档反而看不到证据：\n  ${lost.join("\n  ")}`);
});

test("并集不许把副作用工具漏给只读子体", () => {
  // 上面那条是"写侧要更多"，这条守反方向：只读侧一件副作用工具都不许多出来。
  for (const role of Object.keys(ROLE_CAPABILITIES)) {
    const ro = roleCapabilities(role, false).tools;
    for (const t of ["generate_image", "http_request", "docker_compose_up"]) {
      assert.ok(!ro.includes(t), `只读角色 ${role} 拿到了副作用工具 ${t}`);
    }
  }
});

/**
 * 用户声明的角色，必须真的到得了模型的**工具枚举**里。
 *
 * 这条修的是一个静态可证的死路：L0（走网关时默认开）把内置工具的 schema 整个丢掉、
 * 只发名字，由网关按它自己那份 tools.json 回填。而 _applyUserRoleEnums 补角色名补的
 * 正是客户端这份 schema——也就是被丢掉的那份。网关那份目录用户改不了，实测里面
 * run_subagent / run_worker / spawn_multiple_agents 的 role 枚举只有 11 个内置角色名。
 *
 * 后果不是"少一个选项"：提示词、工具矩阵、轮数、模型全配好了，模型却看不到这个名字，
 * 于是永远选不中——整套声明是哑的。和本仓库记着的「枚举没判据就恒等于默认值，
 * 整道门结构性哑掉」是同一个形状。
 */
test("声明了角色时，派发工具的 schema 必须随请求体发出去而不是交给网关回填", () => {
  const turn = extractFn("_agentModelTurn");
  const at = turn.indexOf("const _stat = _staticToolNames()");
  assert.ok(at > 0, "L0 那段的落点不见了，这条断言要跟着改");
  const blk = turn.slice(Math.max(0, at - 900), at + 500);
  assert.match(blk, /_userCapabilities\(\)\.roles \|\| \[\]\)\.length/,
    "没有按「用户声明过角色吗」分流——声明的角色到不了模型的枚举里");
  assert.match(blk, /"run_subagent", "run_worker", "spawn_multiple_agents"/,
    "三个派发工具没被点名——漏一个，那个入口的用户角色就还是哑的");
  assert.match(blk, /_dispatchNames && _dispatchNames\.has\(_n\)/,
    "分流没接进那个循环，等于加了个没人读的变量");
  // 反向：没声明角色时一个字节都不许多发（那三份 schema 不便宜）。
  assert.match(blk, /_rolesDeclared\s*\?[\s\S]{0,120}:\s*null/,
    "没声明角色时也在多发 schema——这条改动的代价必须只落在真用了它的人身上");
});

test("网关那份目录里确实只有内置角色（这条改动的前提）", () => {
  // 前提变了就该重新核这条改动还需不需要。判据直接读那份真目录。
  const doc = JSON.parse(readFileSync(join(HERE, "..", "..", "server", "prompts", "tools.json"), "utf8"));
  const list = Array.isArray(doc) ? doc : (doc.tools || []);
  const t = list.find((x) => (x?.function?.name || x?.name) === "run_subagent");
  assert.ok(t, "网关目录里没有 run_subagent —— 前提变了");
  const en = t.function?.parameters?.properties?.role?.enum || t.parameters?.properties?.role?.enum;
  assert.ok(Array.isArray(en) && en.length, "role 枚举读不到");
  assert.ok(!en.includes("data"),
    "网关目录里出现了用户自定义角色名——那说明回填路径变了，这条改动的前提要重核");
});
