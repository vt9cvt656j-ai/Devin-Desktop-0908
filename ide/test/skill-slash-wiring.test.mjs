// `/技能名` 这条入口在 main.js 上真的接通了——纯逻辑在 skill-invoke.test.mjs 里验；
// 这里守的是调用点：sendPrompt 拦截、斜杠菜单列技能、模型目录跳过手动触发的、多技能包安装。
//
// 源码断言只用来守"这段代码在不在真实调用链上"，行为一律用 load() 抠出来真跑。
import test from "node:test";
import assert from "node:assert/strict";
import { fnSource, load, CODE } from "./helpers/source.mjs";

test("sendPrompt 把 /技能 展开成正文发给模型，气泡和标题用用户敲的那行", () => {
  const src = fnSource("sendPrompt", { code: true });
  assert.match(src, /parseSlashInvocation\(text\)/, "sendPrompt 没有解析 /技能");
  assert.match(src, /findSlashSkill\(\[\.\.\._loadSkillsLocal\(\), \.\.\._fileSkills\]/, "查技能要同时看账号里的自定义技能和技能库");
  assert.match(src, /text = buildSlashInvocationMessage\(_skill, _inv\.args/, "命中后 text 必须换成展开正文——那才是模型要执行的");
  assert.match(src, /addMessage\("user", _slashDisplay \|\| text/, "气泡要画用户敲的那行，不是几千字的技能正文");
  assert.match(src, /_chatTitleFrom\(_slashDisplay \|\| text\)/, "标签页标题也取用户敲的那行");
  assert.match(src, /_ideMeta: \{ slashDisplay: _slashDisplay \}/, "显示文本挂在 _ideMeta 下，出线口会摘掉它");
  // 拦截必须在排队判据之后：排队存的是原话，出队再展开。
  const queueAt = src.indexOf("_queueFollowup(_rs, text, attachments)");
  const slashAt = src.indexOf("parseSlashInvocation(text)");
  assert.ok(queueAt > 0 && slashAt > queueAt, "拦截跑到排队之前了：排队里存的会是展开正文，出队再展开一次");
  // 冷启动技能库还没扫完时要等那一次，否则启动后第一条 /命令 永远查不到技能。
  assert.match(src.slice(slashAt, slashAt + 400), /_refreshFileSkills\(\)/, "冷启动没等技能扫描，第一条 /命令 会当普通消息发出去");
});

test("历史重画时 /技能 那条气泡仍然显示用户敲的那行", () => {
  const src = fnSource("_renderMsgRange", { code: true });
  assert.match(src, /m\._ideMeta\?\.slashDisplay \|\| m\.content/, "重画没读 slashDisplay，切标签回来气泡变成整段技能正文");
});

test("斜杠菜单列出装好的技能：选中只填 /名字 ，参数提示写在描述里，同名内置命令优先", () => {
  const rows = load("_skillSlashCommands", {
    _SLASH: [{ cmd: "memory", desc: "内置", action() {} }],
    _loadSkillsLocal: () => [{ id: "l1", name: "memory", desc: "撞名的技能", prompt: "x" }],
    _fileSkills: [
      { id: "f1", name: "handoff", desc: "Compact the conversation", prompt: "Write a handoff.", userInvoked: true, argumentHint: "What will the next session be used for?" },
      { id: "f2", name: "tdd", desc: "Test-driven development", prompt: "Red → green." },
      { id: "f3", name: "empty", desc: "没正文", prompt: "" },
    ],
  })();
  assert.deepEqual(rows.map((r) => r.cmd), ["handoff", "tdd"], "空正文的不列；和内置 /memory 撞名的让位");
  assert.equal(rows[0].prompt, "/handoff ", "选中只填 /名字 加一个空格，等用户补参数");
  assert.match(rows[0].desc, /手动触发/);
  assert.match(rows[0].desc, /参数：What will the next session be used for\?/, "argument-hint 要在菜单里看得见");
  assert.doesNotMatch(rows[1].desc, /手动触发/, "模型也能调的不打这个标");
  assert.ok(rows.every((r) => r.skill === true));
});

test("斜杠菜单的候选列表真的把技能拼进去了", () => {
  const src = fnSource("_updateSlashMenu", { code: true });
  assert.match(src, /\.\.\._userSlashCommands\(\), \.\.\._skillSlashCommands\(\), \.\.\._mcpSlashCommands\(\)/,
    "技能要排在用户自定义命令之后、MCP 模板之前");
});

test("disable-model-invocation 的技能不进模型目录——它只有 /名字 一条入口", () => {
  const catalog = load("_skillCatalogBlock", {
    _loadSkillsLocal: () => [],
    _fileSkills: [
      { id: "a", name: "grill-me", desc: "A relentless interview", prompt: "Call grilling.", userInvoked: true },
      { id: "b", name: "grilling", desc: "Interview the user relentlessly", prompt: "Ask until resolved." },
    ],
    _isSkillActive: () => false,
  })();
  assert.match(catalog, /grilling：/, "模型可调的要列");
  assert.doesNotMatch(catalog, /grill-me/, "手动触发的列进去就是每轮白付的上下文，模型还会照着人类向的描述乱调");
});

test("从仓库安装走多技能计划：认 plugin.json 清单，装全部而不是第一个", () => {
  const src = fnSource("_skillInstallFromRepo", { code: true });
  assert.match(src, /planSkillPackInstall\(tree, \{ pluginJson, repoName: item\.name \}\)/, "没走安装计划");
  assert.match(src, /\.claude-plugin\/plugin\.json/, "没读作者的发布清单");
  assert.match(src, /for \(let i = 0; i < plan\.skills\.length; i\+\+\)/, "还是只装一个");
  assert.match(src, /pack: item\.full/, "合集里的技能要记住来自哪个包，市场卡片按它亮已安装");
  assert.match(src, /failed\.push\(/, "一个装不上不该把整包作废");
});

test("市场搜索框直接给 owner/repo 就直达那个仓库", () => {
  const src = fnSource("_skillRegistryPage", { code: true });
  assert.match(src, /api\.github\.com\/repos\/\$\{direct\[1\]\}\/\$\{direct\[2\]\}/, "没有直达分支：搜 mattpocock/skills 全靠全文搜索碰运气");
  assert.match(src, /verdict: "unknown"/, "直达结果也不许猜 yes");
});

test("已装列表给手动触发的技能打标，并且不给「设为常驻」——钉一行路由壳进每次请求毫无意义", () => {
  const panel = fnSource("renderSkillsTool", { code: true });
  assert.match(panel, /s\.userInvoked \? `<span class="mcpfp-badge"/, "没打「/ 手动触发」标");
  assert.match(panel, /s\.userInvoked \? "" : `<button type="button" class="ctp-btn ctp-btn--sm/, "手动触发的还能被设为常驻");
});

test("两个新模块都在 main.js 的真实导入里，不是只在测试里 import", () => {
  assert.match(CODE, /from "\.\/agent\/skill-invoke\.js"/);
  assert.match(CODE, /from "\.\/agent\/skill-pack\.js"/);
});
