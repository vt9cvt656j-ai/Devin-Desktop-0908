// 「写了但运行时到不了模型」的两类死重量，各配一道守卫。
//
// 这个仓库自己的测试注释里已经写下过判据（server/src/prompts.rs，design_tokens 那条）：
//     「这份文件写好之后有很长时间既不在 PROMPT_NAMES 也不在 prompt_graph 里，等于不存在
//      ——模型只能凭印象编间距和阴影。」
// PROMPT_NAMES 只喂一个管理员诊断接口和测试，它**不注入任何东西**；真正决定一个提示词模块
// 能不能到模型手里的，只有 prompt_graph 或代码里显式的 read_prompt。
//
// 2026-08-17 全量对账的结果：37 个提示词文件里有 10 个运行时到不了模型，22 个语义旗标里有
// 7 个服务端没有任何消费者。两类都不会让任何测试变红，也不会有任何日志——改了不生效，而且
// 看起来跟生效一模一样。这个文件把它们变成**显式清单**：想让一个文件/旗标躺着不用，就得在
// 下面写下理由；新加的没接上，当场红。
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// 正向源码断言必须跑在**剥掉注释**的源码上。注释不是代码：把一条契约从代码里删掉、
// 只在注释里留一句，assert.match 照样绿——本仓库已经这样漏过一整组模型可见的工具契约。
// 所以 `CLIENT` 绑定的是 CODE（注释整段置空，行号与偏移和原文一字不差）；
// 真要匹配注释本身的断言显式用 RAW_SRC，并在那一行写清为什么。
import { CODE as CLIENT, SRC as RAW_SRC } from "./helpers/source.mjs";
const RUST = readFileSync(join(HERE, "..", "..", "server", "src", "prompts.rs"), "utf8");
const GRAPH = JSON.parse(readFileSync(join(HERE, "..", "..", "server", "prompts", "prompt_graph.json"), "utf8"));
const PROMPT_DIR = join(HERE, "..", "..", "server", "prompts");

// 图里被引用的模块名（modes / agent / design 各层都算）。
function graphModules(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) (typeof item === "string" ? out.add(item) : graphModules(item, out));
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) graphModules(value, out);
  }
  return out;
}

// 提示词文件：躺着不用的，必须在这里写下理由。
//
// 判据不是「有没有价值」，是「运行时有没有路径到模型」。这几个的活版本都在客户端 main.js 里
// ——服务端这份是死副本，改了不生效。这是「两份目录」那个老坑的提示词版：真正的风险不是内容
// 不好，是有人改了服务端那份，以为上线了。
const RETIRED = {
  agent: "legacy 整份 agent 提示词，已拆成 agent_core + reasoning + 各条件模块；prompts.rs 有 legacy 断言钉着不注入",
  agent_lite: "legacy 精简版，同上，已被 agent_core 取代",
  design_system: "冻结的回滚样本，prompts.rs 明确断言它永不注入（保留作语义真源）",
  ui_design_flow: "michael-design 2.5 那次接通留下的中文稿，已被 design_core / design_tokens / design_components 等英文模块取代；塞回去会和新模块打架",
  ui_design_guide: "同 ui_design_flow，2.5 时期的中文稿，已被拆分后的 design_* 模块覆盖",
  next_action: "输入框「回复建议」的提示词，活版本是客户端的 _ASK_PREDICT_SYSTEM",
  compact: "对话压缩的提示词，活版本在客户端的压缩路径里",
  research_prompt: "research_project 子智能体的任务模板（带 {{FOCUS_EMPH}} 占位），活版本由客户端组装",
  design_research_prompt: "design_research 子智能体的任务模板（带 {{GOAL}} 占位），活版本由客户端组装",
  edit_rewrite: "编辑改写提示词，与客户端内联版本逐字重复",
  edit_transform: "编辑转换提示词，与客户端内联版本逐字重复",
  subagent_system: "子智能体人格，活版本是客户端的 _SUBAGENT_SYSTEM；网关对 subagent 模式刻意不注入任何系统提示词",
  worker_system: "worker 人格，活版本是客户端的 _WORKER_SYSTEM，同上",
};

// 语义旗标：客户端算了、也发进请求头了，但服务端没有任何消费者。
//
// 这几个不是「忘了接」，是**还没有内容可挂**：agent_research 由 research 一个旗标就开了，
// 官方/社区之分、staged/parallel 之分、brownfield 之分都还没有各自的模块。要让它们真的起作用
// 得先写出对应的提示词内容——那是产品内容决策，不该由一道断言替人拍板。
// 写在这里的意义是：它们的存在是**已知且有意的**，不是无人察觉的死重量。
const RESERVED_FLAGS = {
  official: "researchMode=official 的细分，agent_research 目前不按官方/社区分层",
  community: "researchMode=community 的细分，同上",
  collaboration_staged: "staged_roles 的细分，agent_collaboration 目前不区分编排形状",
  collaboration_parallel: "parallel_roles 的细分，同上",
  existing_project: "brownfield 信号，架构纪律目前写在 agent_engineering 里，没有单独模块",
  existing_website: "已有网站信号，同上；design 各层由 designMode 区分而不是这个旗标",
};

// 动态旗标族：名字不是字面量，是从数据拼出来的（`add(`domain_${...}`)`）。
// 上面那条 `add("…")` 正则**看不见它们**——而看不见不等于不存在：它们照样每轮被算出来、
// 照样进请求头、照样参与网关的缓存前缀。这正是这个文件存在的理由（"改了不生效，而且看
// 起来跟生效一模一样"）的动态版本，所以单列一张表，按前缀写明理由。
const RESERVED_FLAG_FAMILIES = {
  domain_: "专业域路由旗标（domain_healthcare / domain_reverse_engineering / domain_penetration_testing …），"
    + "取值逐字等于 server/knowledge/ 的 22 个目录名（`-` 换成 `_`）。客户端侧已经有真实消费者："
    + "_startDomainKnowledgePreflight 在首个模型回合前把该域语料嚼成结构化小抄注进本轮上下文。"
    + "网关侧的 semantic(\"domain_*\") 消费者尚未实现——这是与网关的待接契约，接上之前这条留在这里。",
};

test("动态拼出来的旗标族同样要有交代——字面量正则看不见它们，缓存前缀看得见", () => {
  const fn = /function _ideSemanticProfile\(profile\)\s*\{([\s\S]*?)\n\}/.exec(CLIENT);
  assert.ok(fn, "找不到 _ideSemanticProfile——旗标清单的来源变了");
  // `add(`前缀${表达式}`)` 里那截固定前缀。
  const families = [...new Set([...fn[1].matchAll(/add\(`([a-z0-9_]+)\$\{/g)].map((m) => m[1]))];
  const undeclared = families.filter((f) => !(f in RESERVED_FLAG_FAMILIES));
  assert.deepEqual(undeclared, [],
    `这些旗标族是拼出来的，字面量正则扫不到，服务端也没人认领：${undeclared.join(", ")}。`
    + `要么在 prompts.rs 里消费，要么在 RESERVED_FLAG_FAMILIES 里写明是预留。`);

  for (const [prefix, why] of Object.entries(RESERVED_FLAG_FAMILIES)) {
    assert.ok(families.includes(prefix),
      `RESERVED_FLAG_FAMILIES 里的 ${prefix} 客户端已经不算了，删掉这条`);
    assert.ok(why && why.length >= 10, `RESERVED_FLAG_FAMILIES.${prefix} 得写清为什么预留`);
    assert.ok(!new RegExp(`semantic\\("${prefix}`).test(RUST),
      `${prefix} 服务端已经在消费了，但仍留在 RESERVED_FLAG_FAMILIES 里——清单和现实对不上`);
  }
});

test("每个提示词文件都必须运行时到得了模型，否则要写明为什么躺着", () => {
  const files = readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4));
  assert.ok(files.length > 20, `只扫到 ${files.length} 个提示词文件——路径或后缀变了，这条断言等于没跑`);

  const routed = graphModules(GRAPH);
  const codeRead = new Set([...RUST.matchAll(/read_prompt\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

  const orphans = files.filter((f) => !routed.has(f) && !codeRead.has(f) && !(f in RETIRED));
  assert.deepEqual(orphans, [],
    `这些提示词文件运行时到不了模型（既不在 prompt_graph、也没有 read_prompt），而且没写明理由：`
    + `${orphans.join(", ")}。要么挂进图里，要么在 RETIRED 里写下为什么。`
    + `注意 PROMPT_NAMES 不算——它只喂诊断接口，不注入任何东西。`);

  // 反向：RETIRED 里的条目必须真的还在、且真的没被路由。删了文件却留着条目会让清单变成谎言；
  // 后来把它接进图里却忘了删条目，会让下一个人以为它仍然是死的。
  for (const [name, why] of Object.entries(RETIRED)) {
    assert.ok(files.includes(name), `RETIRED 里的 ${name} 已经没有对应文件了，删掉这条`);
    assert.ok(why && why.length >= 10, `RETIRED.${name} 得写清理由`);
    assert.ok(!routed.has(name),
      `${name} 已经挂进 prompt_graph 了，但仍留在 RETIRED 里——清单和现实对不上`);
  }
});

// 改了死副本 ≠ 上线。这道闸把「静默无效」变成「当场变红」。
//
// RETIRED 那张表已经写明这几份到不了模型，可它拦不住**有人去改它们**——实测：
//   worker_system.txt  2026-08-20 「先写骨架再补满没限定…」  ← 一条防数据丢失的规则，没上线
//   subagent_system.txt 2026-08-19 「人格提示词把子体真有的两…」          ← 没上线
//   agent.txt          2026-08-21 「带着假设往下做要先说出来」            ← 没上线
// 一周之内三次。登记表是**说明**，不是**机制**——所以再加一道内容闸。
//
// 哈希变了要么是你改错了地方（改活版本），要么是你刻意改这份死副本并已经把内容同步到活版本
// （那就连同这里的哈希一起更新，并在提交信息里写明同步到了哪儿）。
const RETIRED_SHA = {
  agent: ["564a0a807060908b", "ide/src/main.js 的 _AI_MODE_PROMPTS.agent（已被 agent_core + reasoning + 条件模块取代）"],
  agent_lite: ["2da999202b2c34c3", "无活版本，已被 agent_core 取代"],
  design_system: ["d50756e1f4ca2d37", "冻结的回滚样本，永不注入"],
  ui_design_flow: ["06a746e754d4eb58", "已被 design_core / design_tokens / design_components 取代"],
  // 2026-08-30 刻意同步：活版本（design_content.txt）的桌面生图尺寸从 1792x1024 改成
  // 当前生图后端真正支持的 1536x1024（超了会被静默压过去），这份死副本里同一个数字
  // 一起跟上，免得哪天它被复活时带回一个错的尺寸。真正上线的是 design_content.txt。
  ui_design_guide: ["05710c92ee96f29c", "同上"],
  next_action: ["6825461eb0e92fdd", "ide/src/main.js 的 _ASK_PREDICT_SYSTEM"],
  compact: ["8f932b79ccd35757", 'ide/src/main.js 里 _P(\"compact\", …) 的第二参数'],
  research_prompt: ["dc96974e4c285f6a", 'ide/src/main.js 里 _P(\"research_prompt\", …) 的第二参数'],
  design_research_prompt: ["5c13d54eba296a6a", 'ide/src/main.js 里 _P(\"design_research_prompt\", …) 的第二参数'],
  edit_rewrite: ["0bbe60046596aebc", 'ide/src/main.js 里 _P(\"edit_rewrite\", …) 的第二参数'],
  edit_transform: ["94169a59438d84a2", 'ide/src/main.js 里 _P(\"edit_transform\", …) 的第二参数'],
  // 2026-08-26 刻意同步：活版本（ide/src/main.js 的 _SUBAGENT_SYSTEM）里那句
  // 「you do not have the browser tool」已改成「按角色给」，这份死副本一起跟上，
  // 免得哪天它被复活时带回一句假话。真正上线的是活版本那一处。
  subagent_system: ["d711c5bd53aa0d2f", "ide/src/main.js 的 _SUBAGENT_SYSTEM"],
  worker_system: ["ac8a85c2d1d0b4d3", "ide/src/main.js 的 _WORKER_SYSTEM"],
};

test("死副本被改动时要当场变红——改了它不等于上线", () => {
  for (const [name, [want, live]] of Object.entries(RETIRED_SHA)) {
    assert.ok(name in RETIRED, `${name} 已经不在 RETIRED 里了，两张表对不上`);
    const got = createHash("sha256")
      .update(readFileSync(join(PROMPT_DIR, `${name}.txt`)))
      .digest("hex").slice(0, 16);
    assert.equal(got, want,
      `server/prompts/${name}.txt 被改动了，而它**运行时到不了模型**——改它零效果。\n`
      + `活版本在：${live}。\n`
      + "要么去改活版本；要么这次是刻意同步（内容已经进了活版本），那就把这里的哈希一起更新，"
      + "并在提交信息里写清同步到了哪儿。实测一周内有三次修复写进死副本从未上线。");
  }
});
test("客户端算出来的每个语义旗标，服务端都得有消费者，否则要写明是预留", () => {
  const fn = /function _ideSemanticProfile\(profile\)\s*\{([\s\S]*?)\n\}/.exec(CLIENT);
  assert.ok(fn, "找不到 _ideSemanticProfile——旗标清单的来源变了");
  const flags = [...fn[1].matchAll(/add\("([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(flags.length > 15, `只解析出 ${flags.length} 个旗标——正则失效了`);

  const consumed = new Set([...RUST.matchAll(/semantic\("([a-z0-9_]+)"\)/g)].map((m) => m[1]));
  // v3：旗标的消费者是 prompt_graph.json 里模块条目的 head.flags / not_flags。
  const graphKeys = new Set((GRAPH.modules || []).flatMap((m) => [...(m.head?.flags || []), ...(m.head?.not_flags || [])]));

  const dead = flags.filter((f) => !consumed.has(f) && !graphKeys.has(f) && !(f in RESERVED_FLAGS));
  assert.deepEqual(dead, [],
    `这些旗标客户端每轮都在算、也发进了请求头，但服务端一个消费者都没有：${dead.join(", ")}。`
    + `要么在 prompts.rs 里消费它，要么在 RESERVED_FLAGS 里写明是预留——`
    + `旗标进请求头就会参与网关的缓存前缀，白算的旗标是要付钱的。`);

  for (const [flag, why] of Object.entries(RESERVED_FLAGS)) {
    assert.ok(flags.includes(flag), `RESERVED_FLAGS 里的 ${flag} 客户端已经不算了，删掉这条`);
    assert.ok(why && why.length >= 10, `RESERVED_FLAGS.${flag} 得写清为什么预留`);
    assert.ok(!consumed.has(flag),
      `${flag} 服务端已经在消费了，但仍留在 RESERVED_FLAGS 里——清单和现实对不上`);
  }
});

test("回答质量模块要管「怎么说话」，不只管「说什么」", () => {
  // 用户："讲话也和人一样，而不是人机发言。"
  // 补之前 answer_quality.txt 只有 13 行，全是内容质量（先给结论、要证据、别假装完成），
  // **关于语气一个字都没有**。唯一沾边的是客户端那条禁令（不许寒暄/不许列功能菜单），
  // 是个否定规则，没有正面标准——于是"像人"这件事没有任何地方负责。
  // 语气规范拆进了 voice.txt：chat 常驻；agent 每轮带 answer_core 里的压缩版，整份用 load_guide 自取。
  const text = readFileSync(join(PROMPT_DIR, "voice.txt"), "utf8");

  assert.match(text, /How to sound like a person, not a chatbot/,
    "语气规范不见了——没有它，回答就退回模板腔");

  // 具体的反模式必须点名。写"要自然一点"是没法执行的，模型只会继续套模板。
  for (const [pattern, why] of [
    // 措辞 2026-08-25 改过（原文是 "Open by restating the request"），点名的属性没变：
    // 禁的是空开场，不是禁「说清你把需求理解成了什么」。只钉动词短语，别钉整句。
    [/Echo the request back/, "复述用户的问题当开场"],
    [/As an AI/, "「作为AI」这类套话"],
    // 措辞收短了（和「验证状态尾巴」合并成一条仪式化结尾），点名的属性没变。
    [/Anything else\?/, "机械追问「还需要我做什么」"],
    // 用户 2026-08-20 两次点名要禁的结尾。第一次只堵了「验证状态」这个词，写在
    // ide/AGENTS.md 的「说话黑名单」里——那是**本仓库自己的**项目文件，用户在别的
    // 项目里干活时它根本不生效，而且换个名字（「验证情况」）就绕过去了。
    // 所以这条搬进全局提示词，并且按**形状**禁：一段收尾清点 + 附在答案后面的补充说明。
    // 断言也跟着按形状钉，别再钉某一个词。
    [/rundown of what you checked/, "收尾清点你验证了什么"],
    // 提示词是按 100 列折行的，断言不能假设短语落在同一行。
    [/asides bolted after\s+the answer/, "答案后面再挂一段补充说明"],
    [/[Bb]anned by shape, not wording/, "按形状禁而不是按措辞禁"],
    [/reads as translated English/, "中文翻译腔"],
    [/Summarise what you just said/, "总结自己刚说过的话"],
  ]) {
    assert.match(text, pattern, `反模式少了「${why}」——不点名的话模型不知道自己在犯`);
  }
  // 正面标准也要有：只列禁令会让回答变得干瘪。
  assert.match(text, /the way a colleague at the next desk would/,
    "缺了正面标准——只有禁令，回答会从模板腔变成干瘪");
  assert.match(text, /Lead with bad news when there is bad news/,
    "坏消息先说，这是「像人」里最难也最要紧的一条");
  assert.match(text, /Name things concretely/, "要求具体名词，否则会退回「相关内容」这种泛指");

  // chat 每轮带整份；其余模式和 agent 每轮带 answer_core（里面有「像邻桌同事那样说」那句压缩版），
  // 整份靠 load_guide 自取——这是「必须 / 按需」两层的刻意分工。
  assert.ok(GRAPH.modes.chat.includes("voice"), "chat 模式没挂 voice——聊天会退回模板腔");
  assert.ok(GRAPH.core.includes("answer_core"), "answer_core 不在 agent core 上");
  for (const mode of ["chat", "plan", "explorer", "reviewer"]) {
    assert.ok((GRAPH.modes[mode] || []).includes("answer_core"),
      `${mode} 模式没挂 answer_core——那个模式说话会退回模板腔`);
  }
  const core = readFileSync(join(PROMPT_DIR, "answer_core.txt"), "utf8");
  assert.match(core, /colleague at the next desk/, "压缩版少了正面标准");
  assert.ok((GRAPH.modules || []).some((m) => m.id === "reply_style" && m.files.includes("voice") && m.pull),
    "voice 要能被 agent 用 load_guide 自取");
});
