// 用户规则：跨项目的长期要求。
//
// 项目级约定这个 IDE 一直会读（AGENTS.md / CLAUDE.md / .cursorrules，见 _gatherAgentContext），
// 但**用户级的一直没有**。「我一律用 pnpm」「回答用中文」「改完先跑测试」这类要求跟着人走、
// 不跟着项目走，以前只能每个项目重抄一遍，或者每轮对话重复一次。
//
// 存 ~/.michael-ide/rules.md（和 mcp.json 同目录，0600），进每一轮的系统提示词。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// 按名字取真源码只有一份实现：test/helpers/source.mjs 的 fnSource（acorn 按 AST 边界切）。
// 这个文件的源码断言历来跑在**原文**上，所以 SRC 仍绑定 main.js 原文，不动。
import { SRC, fnSource as extractFn } from "./helpers/source.mjs";
// 规则那一段的便捷桩（习惯留空）。_userRulesBlock 现在同时渲染两份文档，且用到 _clipUserDoc。
const block = (text, max = 4000) =>
  new Function("_userRulesText", "_userHabitsText", "_USER_RULES_MAX",
    `${extractFn("_clipUserDoc")};${extractFn("_userRulesBlock")};return _userRulesBlock();`)(text, "", max);

test("写了规则就进提示词，原文一字不改", () => {
  const out = block("回答用中文。\n包管理器一律用 pnpm。");
  assert.match(out, /回答用中文。/);
  assert.match(out, /包管理器一律用 pnpm。/);
});

test("没写规则时一个字节都不占——不能让空规则白付每轮的钱", () => {
  for (const empty of ["", "   ", "\n\n\t ", null, undefined]) {
    assert.equal(block(empty), "", `${JSON.stringify(empty)} 应该产出空串`);
  }
});

test("块里要说清它是谁写的、和项目约定谁大", () => {
  const out = block("x");
  assert.match(out, /用户规则/);
  assert.match(out, /高于项目约定/, "不说清优先级，模型碰上冲突只能瞎猜");
  assert.match(out, /约束/, "规则是硬约束，不是建议");
  assert.match(out, /本轮/, "本轮的明确指令必须能压过长期规则，否则用户改不动主意");
});

test("超长会截断并说明，而不是整段丢掉", () => {
  const out = block("A".repeat(50) + "B".repeat(50), 60);
  assert.ok(out.includes("A".repeat(50)), "前半段要保住");
  assert.ok(!out.includes("B".repeat(50)), "超出的部分不该进去");
  assert.match(out, /截断/);
  assert.match(out, /精简/, "要告诉用户怎么办，不能只说被截了");
});

test("每一轮都带用户规则——不再有绕过它的精简路径", () => {
  // 以前有条「轻量轮」会换一份精简系统提示词，用户规则得在那条路上单独再拼一次。
  // 那条路删了，现在只有一份 fullPrompt，规矩对每一轮都生效。
  assert.match(SRC, /const fullPrompt = sysPrompt \+ _modelStyleTuning\(config\.model\) \+ userRulesBlock \+/);
});
test("点菜单是在编辑器里开标签页，不是弹一个 textarea", () => {
  // 让人写 markdown 却塞进一个小框里——不给语法高亮、不给查找替换、不给撤销栈，
  // 而这个应用本身就是个编辑器。
  assert.match(SRC, /async function openUserDocTab\(kind = "rules"\)/);
  assert.match(SRC, /await openFile\(path,/, "要真的开成编辑器标签页");
  assert.ok(!SRC.includes("openUserRulesPanel"), "旧的弹窗实现要删干净");
  assert.ok(!SRC.includes("_USER_DOC_META"), "弹窗的文案表也该跟着走");
});

test("这两份文档的保存要改道，否则沙箱会拒绝写入", () => {
  // 编辑器保存走 write_text_file_if_unchanged，它的 require_inside_workspace(path, true)
  // 明确拒绝"在 HOME 底下但不在工作区里"的写入——正是挡着 ~/.ssh 的那条。
  assert.match(SRC, /function _userDocKindForPath\(path\)/);
  // 两个写盘点都要改道：手动保存和后台持久化
  const hooks = [...SRC.matchAll(/const _docKind = _userDocKindForPath\(path\);/g)];
  assert.equal(hooks.length, 2, `编辑器有两处写盘，都要改道，实际改了 ${hooks.length} 处`);
  // 光有判定不算数，得真的改道。只断言判定那行存在的话，把 `? _writeUserDoc(...)` 改回
  // 普通写盘照样能过——变异验证时就是它先漏掉的。
  const routed = [...SRC.matchAll(/\?\s*_writeUserDoc\(_docKind, snapshot\)/g)];
  assert.equal(routed.length, 2, `两处写盘都要改道，实际 ${routed.length} 处`);
  // 保存后要刷新内存那份，否则改完当轮还是旧内容
  assert.match(SRC, /function _writeUserDoc\(kind, text\)[\s\S]{0,260}_userHabitsText = text; else _userRulesText = text;/);
});

test("路径判定要精确匹配，不能把工作区里同名的 rules.md 也劫持了", () => {
  const fn = new Function("_userDocPaths",
    `${extractFn("_userDocKindForPath")};return _userDocKindForPath;`)({
      rules: "/home/me/.michael-ide/rules.md",
      habits: "/home/me/.michael-ide/habits.md",
    });
  assert.equal(fn("/home/me/.michael-ide/rules.md"), "rules");
  assert.equal(fn("/home/me/.michael-ide/habits.md"), "habits");
  assert.equal(fn("/work/proj/rules.md"), "", "项目里自己的 rules.md 不该被劫持");
  assert.equal(fn("/home/me/.michael-ide/rules.md.bak"), "");
  assert.equal(fn(""), "");
  assert.equal(fn(null), "");
});

// ── ⋮ 菜单 ────────────────────────────────────────────────────────────────

test("菜单两项都是「用户自己写、AI 要照做」的东西", () => {
  const shell = fs.readFileSync("src/app/Shell.jsx", "utf8");
  assert.match(shell, /capabilityHabitsItem/);
  assert.match(shell, /capabilityRulesItem/);
  // 技能面板不属于这里——它列的是磁盘上发现的 SKILL.md，不是用户在这儿写的字。
  assert.ok(!shell.includes("capabilitySkillsItem"), "技能项已移走（高级设置 → Skills 仍可达）");
  assert.ok(!shell.includes("capabilityMcpItem"), "MCP 项已移走（高级设置 → MCP 仍可达）");
  assert.match(SRC, /_habitsItem\.addEventListener\("click"[\s\S]{0,140}openUserDocTab\("habits"\)/);
  assert.match(SRC, /_rulesItem\.addEventListener\("click"[\s\S]{0,140}openUserDocTab\("rules"\)/);
});

// ── 习惯 vs 规则：措辞必须分得开，否则就是同一个框写两遍 ──────────────────

const twoBlocks = (rules, habits, max = 4000) =>
  new Function("_userRulesText", "_userHabitsText", "_USER_RULES_MAX",
    `${extractFn("_clipUserDoc")};${extractFn("_userRulesBlock")};return _userRulesBlock();`)(rules, habits, max);

test("规则是硬约束、习惯是默认做法——两段措辞不能一样", () => {
  const out = twoBlocks("不许推 main", "我用 pnpm");
  assert.match(out, /不许推 main/);
  assert.match(out, /我用 pnpm/);
  // 规则：约束、违反即错
  const rulesPart = out.slice(out.indexOf("用户规则"), out.indexOf("用户习惯"));
  assert.match(rulesPart, /约束/);
  assert.match(rulesPart, /违反/);
  // 习惯：默认做法、可以偏离但要说
  const habitsPart = out.slice(out.indexOf("用户习惯"));
  assert.match(habitsPart, /默认/);
  assert.match(habitsPart, /偏离/);
  assert.match(habitsPart, /说一句|说明/, "不声不响地偏离，用户看到的就是「没听我的」");
});

test("只写了一个的时候，另一个一个字节都不占", () => {
  const onlyRules = twoBlocks("A", "");
  assert.match(onlyRules, /用户规则/);
  assert.ok(!onlyRules.includes("用户习惯"), "没写习惯就不该出现习惯那一段");
  const onlyHabits = twoBlocks("", "B");
  assert.match(onlyHabits, /用户习惯/);
  assert.ok(!onlyHabits.includes("用户规则"), "没写规则就不该出现规则那一段");
  assert.equal(twoBlocks("", ""), "");
  assert.equal(twoBlocks("  ", "\n\t "), "");
});

test("两份文档各自落盘，不会互相覆盖", () => {
  // 面板、读取、保存都带 kind；漏传的话两个框会写进同一个文件
  assert.match(SRC, /backend\.invoke\("user_rules_read", \{ kind \}\)/);
  assert.match(SRC, /backend\.invoke\("user_rules_save", \{ text, kind \}\)/);
  assert.match(SRC, /read\("rules"\), read\("habits"\)/, "启动时两份都要读");
});

test("对齐算法：宽窗口正居中，贴边时夹进视口，绝不跑出屏幕", () => {
  const body = /const _alignCapabilitiesMenu = \(\) => \{[\s\S]*?\n  \};/.exec(SRC)[0];
  const place = (winW, btnCenter, menuW, wrapLeft) => {
    const _menu = { offsetWidth: menuW, style: {} };
    const _capBtn = { getBoundingClientRect: () => ({ left: btnCenter - 14, right: btnCenter + 14 }) };
    const _wrap = { getBoundingClientRect: () => ({ left: wrapLeft }) };
    // 视口宽度现在走 viewportW()（CSS 视口，不是物理像素 —— 见 src/agent/layout-density.js）。
    // 这套注入清单是手工维护的：给热函数加一个辅助函数，这里不补就整条 ReferenceError。
    new Function("_menu", "_capBtn", "_wrap", "viewportW", `${body}; _alignCapabilitiesMenu();`)(
      _menu, _capBtn, _wrap, () => winW);
    return parseInt(_menu.style.left, 10) + wrapLeft;
  };
  // 有地方就真的居中
  assert.equal(place(1600, 800, 148, 700) + 74, 800);
  // 按钮贴着右缘（这就是真实情况：实测按钮中心离窗口右缘只有 30px，居中会溢出 58px）
  const right = place(1280, 1250, 148, 1236);
  assert.ok(right + 148 <= 1280, `右边跑出去了：${right + 148}`);
  assert.ok(right > 1000, "也不该被甩到左边去");
  // 极端：视口比菜单还窄 / innerWidth 报 0。夹紧的上下界会反过来——顺序写错就会把菜单
  // 推到屏幕外（第一版就是这么错的）。
  assert.equal(place(100, 50, 148, 40), 8);
  assert.equal(place(0, 558, 148, 544), 8);
});

// ── 冷启动：规则必须在启动时读一次 ────────────────────────────────────────
//
// 这是上一版真实存在的 bug，也是「内容要真实实现」最要命的一处：`_refreshUserRules()`
// 写了但**一个调用者都没有**。`_userRulesText` 初值是空串，唯一填它的地方是打开规则面板
// 时那段内联读取。于是重启 App 之后，用户上周写的规则一轮都没进过提示词——而且
// `_userRulesBlock()` 只会安静返回空串，不报错、没有任何迹象。菜单上那句"每轮都遵守"
// 在冷启动后是假的。

test("启动时必须读一次用户规则，否则重启后规则一轮都不生效", () => {
  const calls = [...SRC.matchAll(/_refreshUserRules\(\)/g)];
  assert.ok(calls.length >= 2,
    `_refreshUserRules 除了定义之外必须有调用点，实际只出现 ${calls.length} 次`);
  // 就在启动段里，和 initLocale 一起
  assert.match(SRC, /initLocale\(\);[\s\S]{0,600}void _refreshUserRules\(\);/,
    "要在启动段调用——放在别处（比如首轮发送时）会让第一轮仍然是空的");
});

test("菜单打开时把状态画到行上——删掉副标题后这是唯一能看出状态的地方", () => {
  assert.match(SRC, /_habitsItem\?\.classList\.toggle\("is-active", String\(_userHabitsText \|\| ""\)\.trim\(\)\.length > 0\)/);
  assert.match(SRC, /_rulesItem\?\.classList\.toggle\("is-active", String\(_userRulesText \|\| ""\)\.trim\(\)\.length > 0\)/);
  // 必须在菜单显示之前刷，否则第一次打开看到的是上一次的状态
  assert.match(SRC, /_paintCapabilityState\(\); _menu\.hidden = false;/);
  const css = fs.readFileSync("src/styles/app.css", "utf8");
  assert.match(css, /\.assistant-capability__item\.is-active \{ color: var\(--accent\); \}/);
});

test("role=\"menu\" 要配得上这个名字：方向键能走", () => {
  // 声明了 role="menu" 却只处理 Escape，屏幕阅读器会播报一个"菜单"然后发现它不像菜单。
  assert.match(SRC, /const _moveCapabilityFocus = \(delta\) => \{/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.ok(SRC.includes(`ev.key === "${key}"`), `菜单键盘契约缺 ${key}`);
  }
});

// ── 版式：单行，向自家其它下拉看齐 ────────────────────────────────────────

test("菜单收窄变矮，且不再是全应用唯一的两行排版", () => {
  const css = fs.readFileSync("src/styles/app.css", "utf8");
  const menu = /\.assistant-capability__menu\s*\{([^}]*)\}/.exec(css);
  assert.ok(menu, "找不到菜单规则");
  const width = /min-width:\s*(\d+)px/.exec(menu[1]);
  assert.ok(width && Number(width[1]) <= 120, `菜单还是太宽：${width?.[1]}px`);

  const item = /\.assistant-capability__item\s*\{([^}]*)\}/.exec(css);
  const pad = /padding:\s*(\d+)px/.exec(item[1]);
  assert.ok(pad && Number(pad[1]) <= 7, `每项还是太高：padding ${pad?.[1]}px`);

  // 副标题那一层整个不存在了——三个 class 在 CSS / JSX / JS 里都不该再出现
  const shell = fs.readFileSync("src/app/Shell.jsx", "utf8");
  for (const cls of ["__item-sub", "__item-main", "__item-title"]) {
    assert.ok(!css.includes(`assistant-capability${cls}`), `CSS 里还留着 ${cls}`);
    assert.ok(!shell.includes(`assistant-capability${cls}`), `JSX 里还留着 ${cls}`);
  }
});

test("菜单文案走真正的 i18n 键，不靠启发式翻译；三份字典都齐", () => {
  const shell = fs.readFileSync("src/app/Shell.jsx", "utf8");
  assert.match(shell, /data-i18n="assistant\.capability\.habits"/);
  assert.match(shell, /data-i18n="assistant\.capability\.rules"/);
  // 裸中文文本节点会走 localizeLooseTextNode 的启发式通道——那条路曾经被幻觉翻译污染过。
  const i18n = fs.readFileSync("src/i18n.js", "utf8");
  for (const key of ["assistant.capability.habits", "assistant.capability.rules"]) {
    const n = [...i18n.matchAll(new RegExp(`"${key.replace(/\./g, "\\.")}"\\s*:`, "g"))].length;
    assert.equal(n, 3, `${key} 应在 EN/ZH/JA 三份字典里各一条，实际 ${n} 条`);
  }
  // 同名键重复会被后写的覆盖，等于改了个寂寞
  assert.ok(!i18n.includes("assistant.capability.skillsSub"), "副标题的键该随排版一起删掉");
  assert.ok(!i18n.includes('"assistant.capability.skills"'), "技能项已移出这个菜单，它的键也该走");
  assert.ok(!i18n.includes("assistant.capability.mcpSub"), "MCP 项已移出菜单，它的键也该走");
  // 按钮说明词不能还写着 MCP
  assert.ok(!/capabilities\.open": "[^"]*MCP/.test(i18n), "按钮说明还写着 MCP，但菜单里早就没有了");
});

test("两项的名字是「用户习惯」和「用户规则」", () => {
  const i18n = fs.readFileSync("src/i18n.js", "utf8");
  assert.match(i18n, /"assistant\.capability\.habits": "用户习惯"/);
  assert.match(i18n, /"assistant\.capability\.rules": "用户规则"/);
  assert.ok(!i18n.includes("全局技能"), "「全局技能」名不副实（技能发现也覆盖项目目录）");
  assert.ok(!i18n.includes('"assistant.capability.skills"'), "技能项已移出这个菜单");
});

test("L0（走网关）线路下用户规则不会被丢掉", () => {
  // _l0MessagesWithSkills 把原来那条 system 消息整条丢掉，只用 clientBlocks + skillsBlock
  // 重建。任何没列进 clientBlocks 的块，在默认线路下就等于从没发过。
  // 用户规则/习惯此前正是漏在这里：UI 上写着"每轮都遵守"，实际一个字都没到模型手上。
  // 这类失效完全无声——功能看起来做完了，只是不起作用。
  const rebuild = extractFn("_l0MessagesWithSkills");
  assert.match(rebuild, /source\.slice\(1\)/, "确认它确实会丢掉原 system 消息");

  const callSites = [...SRC.matchAll(/const clientBlocks = [\s\S]{0,400}?;/g)].map((m) => m[0]);
  assert.ok(callSites.length >= 2, `找不到两个 clientBlocks 组装点，只找到 ${callSites.length}`);
  for (const site of callSites) {
    assert.match(site, /_userRulesBlock\(\)/,
      `这个 clientBlocks 漏了用户规则，L0 下用户写的规则会被静默丢弃：\n${site}`);
  }
});

// ---- 派出去的子智能体也得知道用户定了什么规矩 ----
//
// 主智能体每轮都带用户规则（上面那条钉着 fullPrompt 的组成），子智能体此前一个字都收不到。
// 而会写文件的 worker 正是很多代码的真实作者：用户写下「不许推 main / 改完必须跑测试 /
// 用 pnpm 不用 npm」，主智能体照做，转手派出去的 worker 不知道有这回事 —— 用户看到的就是
// 「我定的规则不起效」，而且越是大活儿（越会派子体）越不起效。
//
// 这里不补就没有别处能补：网关对 subagent 模式明确「一个字的系统提示词都不加」，
// 子体人格全部来自客户端本地这一份。
test("子智能体的系统提示词必须带上用户规则", () => {
  const i = SRC.indexOf("const sysPrompt = (write");
  assert.ok(i > 0, "子智能体的系统提示词拼装挪走了，这条断言失去落点");
  const seg = SRC.slice(i, SRC.indexOf("_SUBAGENT_TRUTH;", i) + 20);
  // 不锁死实参：子体这一路还要带上 { ladder: true }（它收不到网关那份指令层级），
  // 而把整串实参写死会让"加个参数"这种纯增量改动当场假红，报的错还和真实改动无关。
  assert.match(seg, /\+ _userRulesBlock\([^)]*\)/,
    "派出去的子智能体收不到用户规则——它写的代码不受用户规矩约束，用户看到的就是「规则不起效」");
  assert.match(seg, /_userRulesBlock\(\{[^}]*ladder: true/,
    "子体收不到网关那份指令层级，这一路必须自己补 —— 否则它手上没有任何排序");
  // 技能块早就在里面了；同为用户自己写下的东西，规则块不该缺席。两者要么都在，要么这条
  // 断言就该跟着改——不许只剩技能块。
  assert.match(seg, /skillsBlock/, "技能块也不见了，这条对照失去意义");
  // 语言和风格同样是用户在设置面板里亲手选的值，同样只有这一条补给路：_agentModelTurn 那边
  // 的 clientBlocks 一到子体就被 `if (!_isSub)` 整个丢弃。子体的简报是直接渲染给用户看的，
  // 语言不对当场就看得出来。
  // 比的是**带加号的源码形态**——上面那段说明注释里会提到这些名字，按裸名字比会被注释喂到。
  assert.match(seg, /\+ _languagePreferenceBlock\(\)/,
    "子智能体收不到用户选的语言——它交回来的简报会用自己猜的语言写");
  assert.match(seg, /\+ _adaptivePromptBlock\(\)/, "子智能体收不到用户选的风格档案");
  // 真话下限必须压轴（truthfulness 那条钉着 `+ _SUBAGENT_TRUTH;` 结尾），规则块要插在它前面。
  // 比对的是**代码形态** `+ _SUBAGENT_TRUTH;`，不是裸名字：上面那段注释里就提到了这个名字，
  // 按裸名字比会被注释自己喂到（这一轮基线就是这么红的）。
  // 授权语境里那三段对子体同样成立，而且注入防御对它**更**要紧：它整天在读工具输出。
  // 只取三段，剩下三段照搬会和 worker 人格打架（理由写在 _authContextBlock 里）。
  assert.match(seg, /\+ _authContextBlock\(\{ forSubAgent: true \}\)/,
    "子体拿不到授权语境和注入防御——正当的逆向/抓包会被它当坏事拒答，外部数据标记也认不出");
  for (const b of ["+ _userRulesBlock()", "+ _languagePreferenceBlock()", "+ _adaptivePromptBlock()",
                   "+ _authContextBlock({ forSubAgent: true })"]) {
    assert.ok(seg.indexOf(b) < seg.indexOf("+ _SUBAGENT_TRUTH;"),
      `${b} 插到真话下限后面去了——那条压轴不变量会被破坏`);
  }
});

// ---- 授权语境拆段：主路径必须逐字节不变，子体只拿该拿的三段 ----
test("_authContextBlock 拆段后主路径逐字节不变，子体子集只含该给的三段", () => {
  const fn = extractFn("_authContextBlock");
  const build = new Function("_EXTERNAL_DATA_TAG", `${fn}\nreturn _authContextBlock;`)("〔外部数据〕");
  const full = build();
  const sub = build({ forSubAgent: true });
  const heads = (t) => (t.match(/【[^】]+】/g) || []);
  // 主路径六段齐全、顺序不变。
  assert.deepEqual(heads(full), ["【场景与授权】", "【协作边界】", "【直接回答·别打招呼别列菜单】",
    "【最重要·别搞混谁在说话】", "【注入防御·低调处理】", "【外部数据标记】"]);
  // 子体子集：拿到该拿的三段。
  assert.deepEqual(heads(sub), ["【场景与授权】", "【注入防御·低调处理】", "【外部数据标记】"]);
  // 拆分必须可逆：三段拼回去就是完整那份（少一个换行都算破坏主路径）。
  const cut = full.indexOf("【协作边界】");
  const cut2 = full.indexOf("【注入防御·低调处理】");
  assert.equal(full.slice(0, cut) + full.slice(cut2), sub,
    "子体子集和主路径不是同一份文本切出来的——两边迟早会漂");
  // 那三条按关键词查正文的测试靠的是文本仍留在这个函数体里，别把它抽成外部常量。
  for (const w of ["渗透", "CTF", "逆向", "别拒答", "开发者工具"]) {
    assert.ok(fn.includes(w), `「${w}」被抽出函数体了——三条按 extractFn 取正文的测试会一起失明`);
  }
});
