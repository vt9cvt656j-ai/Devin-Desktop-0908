// 工具发现（src/agent/tool-discovery.js）的真往返：精确名通道、模糊检索与保守判据、就近候选、子智能体准入。
// 直接 import 产品模块；它要的四个 main.js 事实（名字归一化 / 严格变更名单 / 注册表 / 名字→类型）用桩注入。
import assert from "node:assert/strict";
import test from "node:test";
import {
  configureToolDiscovery, _searchToolsExactQuery, _searchToolsLookup, _searchToolsFuzzyMatch, _confidentFuzzyResolution,
  _nearestToolNames, _unknownToolHint, _subAgentUsableToolNames, _subAgentAdmitTools, _subAgentSearchToolsLabel,
  _toolMetaGuideSuffix, _toolSchemaFromRegistry,
} from "../src/agent/tool-discovery.js";

const schema = (name, description) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
const registry = new Map([
  ["read_file", schema("read_file", "读取文件内容")],
  ["write_file", schema("write_file", "写文件")],
  ["run_cmd", schema("run_cmd", "运行命令")],
  ["browser_click", schema("browser_click", "在浏览器里点击元素")],
  ["browser_batch", schema("browser_batch", "在浏览器里批量执行动作")],
  ["db_query", schema("db_query", "查询数据库")],
  ["deploy_site", schema("deploy_site", "发布站点")],
  ["mcp__docs__search", schema("mcp__docs__search", "搜索文档")],
  ["mcp__fs__delete", schema("mcp__fs__delete", "删除")],
]);
const typeOf = {
  read_file: "read", write_file: "write", run_cmd: "cmd", browser_click: "browser", browser_batch: "browser",
  db_query: "db", deploy_site: "cmd", mcp__docs__search: "mcp", mcp__fs__delete: "mcp",
};
const mapCall = (name) => (typeOf[name] ? { type: typeOf[name], mcpReadOnly: name === "mcp__docs__search" } : null);
configureToolDiscovery({
  _canonicalToolName: (n) => String(n || "").toLowerCase().replace(/[\s.-]+/g, "_"),
  _STRICT_MUTATING_TOOL_NAMES: new Set(["write_file", "deploy_site"]),
  _buildToolRegistry: () => registry,
  _mapToolCall: mapCall,
});

test("精确名通道走同一套归一：Read-File 能查到；未知的复合标识符不降级成松散词；mcp__ 名字不归一", () => {
  assert.equal(_searchToolsExactQuery("Read-File", registry).schema, registry.get("read_file"));
  assert.deepEqual(_searchToolsExactQuery("local_discovery", registry), { name: "local_discovery", schema: null });
  assert.equal(_searchToolsExactQuery("bogus", registry), null);
  assert.equal(_searchToolsExactQuery("mcp__docs__search", registry).name, "mcp__docs__search");
  assert.deepEqual(_searchToolsLookup("read_file", registry, new Set()), [registry.get("read_file")]);
  assert.deepEqual(_searchToolsLookup("read_file", registry, new Set(["read_file"])), [], "已装载的不重复给");
});

test("模糊检索：名字命中比描述命中重；标识符会拆子词；中文按二字滑窗命中描述", () => {
  const byName = _searchToolsFuzzyMatch("browser click", registry, new Set());
  assert.equal(byName[0].name, "browser_click");
  assert.ok(byName[0].matchedOn.includes("name"));
  assert.ok(byName[0].score > byName[1].score);
  const sub = _searchToolsFuzzyMatch("browser_click", registry, new Set());
  assert.equal(sub[0].name, "browser_click", "单个标识符 token 拆成子词才命中得了");
  const cjk = _searchToolsFuzzyMatch("浏览器点击", registry, new Set());
  assert.equal(cjk[0].name, "browser_click");
  assert.deepEqual(cjk[0].matchedOn, ["desc"], "二元组要归因到具体维度，不能统一记成 cjk");
});

test("保守判据：结构化维度命中且拉开 2 分才算硬；只命中描述、或者并列，都交给语义编排器", () => {
  const strong = _confidentFuzzyResolution(_searchToolsFuzzyMatch("browser click", registry, new Set()));
  assert.deepEqual(strong.map((h) => h.name), ["browser_click"]);
  assert.equal(_confidentFuzzyResolution(_searchToolsFuzzyMatch("browser", registry, new Set())), null, "两个并列 = 查询有歧义");
  assert.equal(_confidentFuzzyResolution(_searchToolsFuzzyMatch("浏览器点击", registry, new Set())), null, "只在描述里出现过是弱信号");
  const loaded = _confidentFuzzyResolution(_searchToolsFuzzyMatch("browser click", registry, new Set(["browser_click"])));
  assert.deepEqual(loaded.map((h) => h.name), ["browser_batch"], "已装载的不参与，剩下的独占就是硬命中");
  assert.equal(_confidentFuzzyResolution([]), null);
});

test("就近候选：分隔符无关的精确/前缀/包含才算，字符重合率不够的宁可不给", () => {
  assert.deepEqual(_nearestToolNames("readfile", [...registry.keys()]), ["read_file"]);
  assert.deepEqual(_nearestToolNames("browser", [...registry.keys()]), ["browser_batch", "browser_click"]);
  assert.deepEqual(_nearestToolNames("zzzz", [...registry.keys()]), []);
});

test("子智能体：按自己的沙箱列可用名；叫错名字时给最接近的候选，没有候选就指路 search_tools", () => {
  assert.deepEqual(_subAgentUsableToolNames(["read", "browser"], false), ["browser_batch", "browser_click", "read_file"]);
  assert.match(_unknownToolHint("read_fil", ["read"], false), /read_file/);
  assert.match(_unknownToolHint("zzzz", ["read"], false), /search_tools/);
});

test("子智能体准入：类型在沙箱内且非严格变更才装；严格变更/未声明只读的 MCP 都点名交回父任务；匹配器炸了返回空", () => {
  const admit = (query, execTypes, loaded = new Set()) => _subAgentAdmitTools(query, { registry, loaded, execTypes, mapCall });
  assert.deepEqual(admit("read_file", ["read"]).admitted, [registry.get("read_file")]);
  assert.deepEqual(admit("write_file", ["write"]), { admitted: [], outside: ["write_file"] }, "严格变更工具不在初始名单里就是沙箱外");
  assert.deepEqual(admit("deploy_site", ["cmd"]).outside, ["deploy_site"], "类型对上也不行：deploy_site 映射到 cmd 却会发布到公网");
  assert.deepEqual(admit("mcp__docs__search", ["mcp"]).admitted, [registry.get("mcp__docs__search")], "服务自己声明只读的 MCP 可以给");
  assert.deepEqual(admit("mcp__fs__delete", ["mcp"]).outside, ["mcp__fs__delete"], "没声明只读的按可能有副作用处理");
  assert.deepEqual(admit("browser click", ["browser"]).admitted.map((s) => s.function.name), ["browser_click", "browser_batch"], "模糊命中的按分数依次装");
  assert.deepEqual(_subAgentAdmitTools("read_file", { registry: null, loaded: new Set(), execTypes: ["read"], mapCall }), { admitted: [], outside: [] });
});

test("卡片标签跟着三种结局走", () => {
  assert.equal(_subAgentSearchToolsLabel([1], []), "已加载 1·子任务");
  assert.equal(_subAgentSearchToolsLabel([], ["x"]), "沙箱外 1 · 交回主任务");
  assert.equal(_subAgentSearchToolsLabel([1], ["x"]), "已加载 1 · 沙箱外 1");
  assert.equal(_subAgentSearchToolsLabel([], []), "无匹配");
});

test("按名字取 schema：Map 和数组两种注册表都认，别名走归一；没有元数据的工具后缀为空", () => {
  assert.equal(_toolSchemaFromRegistry(registry, "Read-File"), registry.get("read_file"));
  assert.equal(_toolSchemaFromRegistry([...registry.values()], "read_file"), registry.get("read_file"));
  assert.equal(_toolSchemaFromRegistry(registry, "nope"), null);
  assert.equal(_toolSchemaFromRegistry(null, "read_file"), null);
  assert.equal(_toolMetaGuideSuffix("no_such_tool_anywhere"), "");
});
