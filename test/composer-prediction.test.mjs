// 输入框那条灰字预测（Tab 补全）的档位顺序。
//
// 起因：用户报「预测内容不会实时变动，而且内容老是错的」。查下来不是没重算——
// activate() → _refreshChatHintIfEmpty() → _renderComposerGhost() 这条链是通的，
// 诊断和选区变化也有 400ms 防抖重算。问题在**档位顺序**：
//
//   `_runStateNextActionSuggestions` 默认只信 5 分钟内的运行状态，但「继续上次」那一档
//   特意传了 maxAgeMs: Infinity。它永不过期，于是只要这个会话跑过一次东西，5 分钟后
//   前面几档静默之后，它就永远顶在最上面，把最后那档「基于当前文件」的预测彻底压住。
//   用户切文件、改选区、看着新代码，灰字纹丝不动，推的还是一件早就做完的事。
//
// 修法：那一档只在**这个会话里用户还没发过话**时成立——那才是"接着上次继续"真正
// 有意义的一刻（打开软件）。一旦用户开口，当前正在看的东西就是更新鲜的证据。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// 从 main.js（无导出的浏览器单文件）里按名字抠真源码：全仓唯一那份提取器。
import { fnSource as grab, CODE as SRC_CODE, load, SRC as SHARED_SRC} from "./helpers/source.mjs";

// 源码文本用共享的那一份（helpers/source.mjs 的 SRC = main.js + src/agent/* 拼接）。
// 自己 readFileSync("src/main.js") 的话，每从 main.js 搬出一个模块就假红一次；
// 反方向更糟：「main.js 里不许出现 X」这类断言会在 X 搬进模块后恒绿，禁令悄悄失效。
const SRC = SHARED_SRC;


// 只桩掉两个外部依赖，_predictionAlreadyUsed 用真身——它参与判定。
const deps = {
  _runStateNextActionSuggestions: (sess, { maxAgeMs = 5 * 60_000 } = {}) => {
    const run = sess?._lastRunState;
    if (!run || Date.now() - run.updatedAt > maxAgeMs) return [];
    if (run.outcome === "awaiting_user") return [];
    return [{ label: run.label, send: run.send }];
  },
  _dynamicChatChips: () => [{ label: "解释 database.py", send: "解释 database.py：整体职责、关键函数/类型、数据流。" }],
  _predictionAlreadyUsed: new Function(`return ${grab("_predictionAlreadyUsed")}`)(),
};
const keys = Object.keys(deps);
const _composerPrediction = new Function(
  ...keys,
  `${grab("_composerPrediction")}; return _composerPrediction;`,
)(...keys.map((k) => deps[k]));

const STALE = { updatedAt: Date.now() - 3 * 60 * 60 * 1000, label: "把爬虫接上数据库", send: "继续：把爬虫接上数据库" };

test("用户开口之后，预测跟着当前文件走，而不是被三小时前的运行状态钉死", () => {
  const sess = { id: "s1", _lastRunState: STALE, _recentSent: ["你好啊"] };
  const p = _composerPrediction(sess);
  assert.equal(p.src, "ctx", `期望跟随当前上下文，实际是 ${p.src}：${p.text}`);
  assert.match(p.send, /database\.py/);
});

test("刚打开软件、这个会话还没发过话时，「继续上次」必须还在", () => {
  const sess = { id: "s2", _lastRunState: STALE, _recentSent: [] };
  const p = _composerPrediction(sess);
  assert.equal(p.src, "resume");
  assert.match(p.text, /继续上次/);
});

test("刚跑完一轮（5 分钟内）仍然优先接着那一轮，别被当前文件抢走", () => {
  const sess = { id: "s3", _lastRunState: { ...STALE, updatedAt: Date.now() - 1000 }, _recentSent: ["做个爬虫"] };
  assert.equal(_composerPrediction(sess).src, "run");
});

test("举着问题等人回答时不给预测", () => {
  const sess = { id: "s4", _lastRunState: { ...STALE, updatedAt: Date.now() - 1000, outcome: "awaiting_user" }, _recentSent: [] };
  assert.equal(_composerPrediction(sess), null);
});

test("计划里还有未完成的步骤时，接着计划走", () => {
  const sess = {
    id: "s5",
    _planSteps: [{ status: "pending", content: "把 crawler 接上 SQLite" }],
    _recentSent: ["开始吧"],
  };
  const p = _composerPrediction(sess);
  assert.equal(p.src, "plan");
  assert.match(p.send, /^继续：/);
});

test("源码里那道闸真的在——去掉它这组测试就没意义了", () => {
  const fn = grab("_composerPrediction");
  assert.match(fn, /_recentSent[^\n]*\)\.length\) \{[\s\S]{0,200}maxAgeMs: Infinity/,
    "「继续上次」那一档必须被「本会话还没发过话」这个条件包住");
});

// ── 琐碎轮不该付深思考的钱 ────────────────────────────────────────────────
// 截图实证：一句"你好啊"，总耗时 21s、模型 5.6s 就开始出字，剩下十几秒全花在
// "要不要问他修 bug / 要不要列菜单"的反复推演上。这类轮次代码里本来就已经在省
// 系统提示词、跳过技能块和工作区预热了（_shouldUseLightweightAgentTurn），
// 唯独思考预算照付默认档（Claude 4.6 的 high = 24000 budget_tokens）。
test("琐碎轮不再偷偷把思考降档——用户选什么就发什么", () => {
  // 这一档降级删掉了。它写在"客户端还发不出 effort"的年代：当时 Claude 走
  // budget_tokens=24000，一句"你好啊"确实会烧掉整份预算。现在是 adaptive + effort，
  // 深浅由模型每轮自己定，前提没了，留下的只有"用户选的和实际发的不一致"。
  //
  // 后来轻量轮**整套删掉了**（见 sendPrompt 里那段说明）：它省下的提示词，代价是判错时
  // 模型手上一个工具都没有、还不知道自己缺了什么。这条用例现在只管一件事——
  // 思考档位不许被任何东西偷偷改写。
  const _start = SRC.indexOf("function _applyThinkingToConfig(");
  assert.ok(_start > 0, "_applyThinkingToConfig 没找到");
  const fn = SRC.slice(_start, _start + 6000);
  assert.doesNotMatch(fn, /opts\.lightTurn/, "轻量轮又在改写档位了");
  assert.doesNotMatch(fn, /\["minimal", "low", "medium"\]\.find/, "又在往最浅档压");

  // 轻量轮已删干净：留一个字都可能让下一个人以为还能靠它省点什么。
  assert.doesNotMatch(SRC, /_agentLightTurn|_shouldUseLightweightAgentTurn/,
    "轻量轮又回来了——它会在判错时把工具和技能一起拿走");
});

// ── 空工作区不能推「深挖整个项目」 ───────────────────────────────────────────
//
// 用户截图：工作区 小说 是个空文件夹，助手上一条刚说完「当前目录完全为空，没有任何
// 文件」，而输入框的灰字还在推「用 research_project 深挖整个项目，给我一份上手地图：
// 技术栈、目录结构、核心模块职责……」。预测和事实当场打架。
//
// 成因：那一档只判「有没有根目录」，从不看根目录里有没有东西。
// 空目录该问的是"做点什么"，不是"读懂什么"——这是两种完全不同的建议。
function chipsWith(entryCount) {
  const zh = (() => {
    const I = fs.readFileSync("src/i18n.js", "utf8");
    const at = I.indexOf("const ZH_CN");
    return Function("return {" + I.slice(I.indexOf("{", at) + 1, I.indexOf("\n};", at)) + "}")();
  })();
  const deps = {
    activePath: "", _pathToRel: (x) => x, t: (k) => zh[k] ?? k,
    monacoEditor: { getSelection: () => null, getModel: () => null },
    monaco: { editor: { getModelMarkers: () => [] } },
    openFiles: new Map(), _isGeneratedDependencyDiagnostic: () => false, _lastGitFiles: [],
    rootPath: "/w", workspaceRoots: ["/w"],
    _workspaceRootEntryCounts: new Map([["/w", entryCount]]), _treePath: (x) => x,
    // 实时预览页签的伪路径不是文件，不能当成「当前文件」推给用户；真实现只挡那一个常量。
    _realFilePath: (path) => (path && path !== "mrdayone:live-preview" ? path : ""),
  };
  const keys = Object.keys(deps);
  return new Function(...keys, grab("_dynamicChatChips") + "\n;return _dynamicChatChips;")(...keys.map((k) => deps[k]))();
}

test("空文件夹推的是「做点什么」，不是「深挖整个项目」", () => {
  const labels = chipsWith(0).map((c) => c.label).join(" | ");
  assert.ok(!/深挖/.test(labels), `空目录仍在推深挖：${labels}`);
  assert.match(labels, /开始做点什么|项目骨架/, `空目录该给可动手的建议：${labels}`);
});

test("有文件的项目照旧推「深挖整个项目」——别把好用的那档改坏了", () => {
  assert.match(chipsWith(37).map((c) => c.label).join(" | "), /深挖/);
});

test("还没扫完（undefined）不能当成空——刚打开大项目的头一秒不该推「新建」", () => {
  // 这个计数是异步扫出来的。把 undefined 当成 0，用户打开一个几千文件的仓库，
  // 第一眼看到的会是"这个文件夹是空的"。
  assert.match(chipsWith(undefined).map((c) => c.label).join(" | "), /深挖/);
});

test("扫完目录要通知预测重算，否则灰字停在扫描前那一版", () => {
  // 「预测不会实时变」的另一半：事实是异步到的，到了没人通知，预测就一直是旧的。
  const at = SRC.indexOf("_workspaceRootEntryCounts.set(_treePath(path), entries.length)");
  assert.ok(at > 0, "找不到计数写入点");
  assert.match(SRC.slice(at, at + 700), /_refreshChatHintIfEmpty\(\)/,
    "算出目录有多少东西之后没有触发预测重算");
});

test("四个新词条三本词典都要有，少一本那个语言就露出原始键名", () => {
  const I = fs.readFileSync("src/i18n.js", "utf8");
  for (const k of ["assistant.chip.startProject", "assistant.prompt.startProject",
                   "assistant.chip.scaffoldHere", "assistant.prompt.scaffoldHere",
                   "tool.action.skill"]) {
    const n = I.split(`"${k}"`).length - 1;
    assert.equal(n, 3, `${k} 只在 ${n} 本词典里`);
  }
});

// ── 预测的是「用户接下来会打什么」，不是「环境暗示该干什么」 ──────────────────
//
// 用户第二次纠正：「这里预测是预测用户接下来会问什么，具体要问的问题，而不是乱猜」。
// 上一轮我修的是"空目录别推深挖项目"——那只是把一个错答案换成另一个来源相同的答案。
// 真正的断层是：原有五档全部读**环境状态**（报错数、git 脏、开着哪个文件、目录空否），
// 一档都没读对话。助手刚分析完三个项目怎么变现，输入框却在推「这个文件夹是空的」，
// 两件事毫无关系——这就是"乱猜"。
//
// 所以加了一档真正读对话的，并且排在最前面。判据来自 Claude Code 那套：
// 预测"他会打什么"而不是"接下来该做什么"，说不准就沉默。
function rejectAsk() {
  const i = SRC.indexOf("function _rejectPredictedAsk");
  const tail = '\n  return "";\n}';
  const end = SRC.indexOf(tail, i);
  assert.ok(i > 0 && end > i, "找不到 _rejectPredictedAsk");
  return new Function(SRC.slice(i, end + tail.length) + "\nreturn _rejectPredictedAsk;")();
}

test("用户真会打的那些话要放行", () => {
  const rej = rejectAsk();
  for (const v of ["那先做压缩包大侠的上架", "帮我把自动化框架发到 crates.io",
                   "先补 README 的例子", "第 3 个，重点打中文市场", "这个能跑起来吗"]) {
    assert.equal(rej(v), "", `误杀了一句用户真会打的话：${v}`);
  }
});

test("助手口吻一律拦下——「我来帮你…」不是用户会打的字", () => {
  const rej = rejectAsk();
  assert.equal(rej("我来帮你发到 crates.io"), "assistant_voice");
  assert.equal(rej("让我先看看这个文件"), "assistant_voice");
});

test("反问用户、客套、空泛的一律拦下", () => {
  const rej = rejectAsk();
  assert.equal(rej("你想先做哪一个？"), "question_to_user");
  assert.equal(rej("不错"), "evaluative");
  assert.equal(rej("继续"), "too_generic", "「继续」任何时候都成立，等于没预测");
});

test("模型叙述自己在沉默也要拦——提示词说了它照样会漏", () => {
  // 软的那层（提示词里要求"不确定就输出空"）会漏，所以必须配一层硬的。
  const rej = rejectAsk();
  assert.equal(rej("（保持沉默）"), "meta_wrapped");
  assert.equal(rej("无法预测用户意图"), "meta_text");
});

test("长度按中文卡 40 字，不是照搬英文那套 100 字符", () => {
  const rej = rejectAsk();
  // 夹具要留出真实余量。闸门从 32 放宽到 40 之后这条只剩 1 个字 —— 下次谁再动这个数，
  // 撞红的会是这条看起来跟他无关的测试。加长到 52 字，余量 12。
  assert.equal(rej("帮我把这个项目从头到尾重新梳理一遍，包括技术栈选型、目录结构、核心模块职责、数据流和各种边界情况"), "too_long");
  // 下边界也要钉：40 字整刚好放行，41 字被拒。只钉上限的话，闸门被人调成 10 也照样绿。
  assert.equal(rej("先把依赖装好再跑一遍类型检查确认全绿然后生成产物给我看一眼结果对不对呀"[0].repeat(40)), "");
  assert.equal(rej("啊".repeat(41)), "too_long");
  assert.equal(rej("先把自动化框架发到 crates.io。然后再补文档。"), "multiple_sentences",
    "用户不会一次打两句");
});

test("读过对话的那一档排在所有环境档之前", () => {
  const fn = grab("_composerPrediction");
  const askAt = fn.indexOf("sess._askPredict");
  const envAt = fn.indexOf("_runStateNextActionSuggestions(sess)");
  assert.ok(askAt > 0, "没有读对话的那一档");
  assert.ok(askAt < envAt, "对话档排在了环境档后面——环境档一命中就再也轮不到它");
});

test("对话往前走了，旧预测就作废", () => {
  // 不作废的话，用户发完新消息还会看到针对上一轮的那句预测。
  assert.match(grab("_composerPrediction"), /ask\.turnKey === \(\(sess\.memory && sess\.memory\.recent\) \|\| \[\]\)\.length/);
});

test("被拒的原因要记下来，「为什么这儿没有预测」得答得出来", () => {
  assert.match(SRC, /sess\._askPredictReject = why/);
  assert.match(SRC, /sess\._askPredictReject = "already_sent"/);
});

test("助手举着问题等回答时，ask 档必须照常工作——那是预测最准的一刻", () => {
  /*
   * 用户截图里助手结尾是「想先搞哪个？我直接帮你实现。」，输入框里却是
   * 「解释 src/types.ts：整体职责、关键函数/类型、数据流…」。
   *
   * 原因是 awaiting_user 把**整档**关掉了：`_maybeSuggestNext` 不发起预测，
   * `_composerPrediction` 开头直接 return null。那道闸的理由（举着问题时预测出
   * 「回答上面的问题」毫无意义）只对**环境档**成立 —— 它们没读过对话，除了空话给不出
   * 别的。而对读过对话的 ask 档，助手把 1/2/3 摆出来正是它最准的时候。
   */
  const src = SRC_CODE;
  // 触发点不再按 awaiting_user 跳过。
  const suggest = grab("_maybeSuggestNext", { code: true });
  assert.ok(!/outcome !== "awaiting_user"[\s\S]{0,120}_predictNextAsk/.test(suggest),
    "awaiting_user 时仍然不发起预测——最贵的那个场景还是黑的");
  assert.match(suggest, /void _predictNextAsk\(sess\)/, "根本不发起预测了");

  // 渲染侧：awaiting_user 时 ask 档可命中，环境档被挡。
  const pick = grab("_composerPrediction", { code: true });
  assert.ok(!/outcome === "awaiting_user"\) return null/.test(pick),
    "还是一刀切 return null，ask 档一起被挡掉了");
  assert.match(pick, /_awaitingUser/, "没有把闸门收窄成只挡环境档");

  // 行为验证：awaiting_user + 有 ask 预测 → 出 ask；没有 ask 预测 → 弃权（不掉到环境档）。
  const mk = (ask) => ({
    id: "s", memory: { recent: [{ role: "user" }, { role: "assistant" }] },
    _lastRunState: { outcome: "awaiting_user" },
    _askPredict: ask ? { text: "先搞 1 和 6", turnKey: 2 } : null,
    _recentSent: [], _planSteps: [],
  });
  const predict = load("_composerPrediction", {
    _runStateNextActionSuggestions: () => [{ label: "环境档不该出现", send: "环境档不该出现" }],
    _dynamicChatChips: () => [{ label: "解释 src/types.ts", send: "解释 src/types.ts" }],
    _predictionAlreadyUsed: () => false,
  });
  assert.equal(predict(mk(true))?.src, "ask", "举着问题时 ask 档没出来");
  assert.equal(predict(mk(false)), null, "ask 档没话说时掉到环境档了——该弃权");
});

test("聊起来之后，环境档不许顶替 ask 档——宁可空着也别给一句不相干的", () => {
  /*
   * 「解释 src/types.ts」来自 `ctx` 档（`_dynamicChatChips`），它只看**打开的文件**，
   * 一个字的对话都没读过。把它当 ask 档的降级替补是反的：空输入框是中性的，
   * 一句不相干的预测是负分 —— 用户聊了二十轮，输入框还在让他解释一个碰巧打开的文件。
   *
   * 会话刚打开、还没说过话时环境档仍然有用（那时它是唯一线索）。
   */
  const predict = load("_composerPrediction", {
    _runStateNextActionSuggestions: () => [{ label: "跑一遍验证", send: "跑一遍验证" }],
    _dynamicChatChips: () => [{ label: "解释 src/types.ts", send: "解释 src/types.ts" }],
    _predictionAlreadyUsed: () => false,
  });
  const sess = (turns) => ({
    id: "s", memory: { recent: Array.from({ length: turns }, () => ({ role: "user" })) },
    _lastRunState: null, _askPredict: null, _recentSent: [], _planSteps: [],
  });
  assert.equal(predict(sess(0))?.src, "run", "会话刚打开时环境档该照常出——那是唯一线索");
  assert.equal(predict(sess(6)), null, "聊起来之后环境档还在顶替 ask 档");
  // 源码侧钉住判据本身，免得阈值被人悄悄调大回去。
  const pick = grab("_composerPrediction", { code: true });
  assert.match(pick, /_envTiersAllowed = !_awaitingUser && _turns < 2/, "环境档的准入判据被改了");
  assert.match(pick, /if \(!_envTiersAllowed\) return null;/, "判据算了却没用来挡");
});

test("提示词要给出字数、给弃权出口、给例子——软要求和硬闸门必须对齐", () => {
  const p = SRC_CODE.slice(SRC_CODE.indexOf("const _ASK_PREDICT_SYSTEM"),
                           SRC_CODE.indexOf("const _ASK_PREDICT_SYSTEM") + 4000);
  // 硬闸门卡 40 字，提示词必须写出一个数（此前只说「越短越好」，模型无从遵守）。
  assert.match(p, /30 字以内/, "提示词没有给出字数上限——模型不知道会被 40 字硬毙");
  // 弃权出口：没有它，模型必然硬编一句，然后被硬闸门拒掉，再触发兜底降级。
  assert.match(p, /拿不准就输出空/, "没有给模型弃权出口");
  assert.match(p, /空是\*\*合法且正确\*\*的答案/, "没有说清空是正确答案而不是失败");
  // few-shot：这类任务例子比规则管用，而且必须覆盖「助手提问→选编号」这个最高价值场景。
  assert.match(p, /## 例子/, "没有 few-shot");
  assert.match(p, /先搞 1 和 6/, "缺「助手提问 → 用户回编号」这个最贵的例子");
  assert.match(p, /→ （空）/, "缺「该弃权」的反例");
  assert.match(p, /第一人称对助手说话/, "没有明确用户口吻");
});

test("「助手在等你拿主意」要喂给模型，而且判据只用已有的两个", () => {
  /*
   * 这是整个预测里信息量最大的一条，此前完全没喂。模型只拿到一段扁平的
   * `用户：/助手：` 文本，得自己从里面读出「这是在问我」—— 助手那段一长就读不出来。
   *
   * 判据不新造：`run.outcome === "awaiting_user"`（调了 ask_user，确凿的执行事实）
   * 和 `_detectChoiceOptions`（选项写在正文里时的保守检测，卡片行用的就是它）。
   * 两个都不命中就什么都不加 —— 宁可不提示，也不要拿正则猜「这句是不是问句」。
   */
  const fn = grab("_predictNextAsk", { code: true });
  assert.match(fn, /_detectChoiceOptions\(/, "没有复用已有的选项检测");
  assert.match(fn, /outcome === "awaiting_user"/, "没有用 ask_user 这个执行事实");
  assert.match(fn, /content: convo \+ _cue/, "线索算了却没喂进请求");
  // 不许自己造问句正则——那正是这个仓库反复否掉的「拿预测代替事实」。
  assert.ok(!/[？?]\s*\$\/|endsWith\("？"\)/.test(fn),
    "自己拿正则猜问句了，该用已有的两个执行事实判据");
});

test("硬过滤的极性：用户对助手说「你…吗？」「我先…」是最常见的追问，不是要拦的东西", () => {
  /*
   * 这一档预测的是**用户**会打的话，用户嘴里的「你」指的正是助手。
   * 两条规则原来的判据把这层关系搞反了，实测：
   *   question_to_user  `/^(你|您|要不要|需要我)/` + 问号 → 六句自然追问 6/6 全杀
   *   assistant_voice   含「我来/我先/我会」→「我先跑一下测试」这种用户第一人称也杀
   * 而这恰恰是一轮回复之后最常见的两种句式，也就是这个功能唯一有价值的场景。
   */
  const rej = rejectAsk();
  for (const ok of [
    "你能把它改成 TypeScript 吗？", "你刚才说的第二点能展开讲讲吗？",
    "你确定这样不会破坏缓存吗？", "你说的那个文件在哪？",
    "要不要顺便把测试也加上？", "需要我提供完整报错吗？",
    "我来试试你说的第二个方案", "我先跑一下测试", "我会不会漏了什么？",
  ]) assert.equal(rej(ok), "", `这是用户真会打的话，不该拦：${ok}`);

  // 真正的助手口吻仍要拦住——放宽不是拆掉。
  for (const [bad, why] of [
    ["让我看看", "assistant_voice"], ["我可以帮你重构一下", "assistant_voice"],
    ["接下来我会先读一遍代码", "assistant_voice"],
    ["Let me check that file", "assistant_voice"], ["I'll fix it now", "assistant_voice"],
    ["你想先做哪个？", "question_to_user"], ["您希望我从哪里开始？", "question_to_user"],
  ]) assert.equal(rej(bad), why, `这个该拦却放行了：${bad}`);
});

test("喂给模型的助手消息要取尾巴——收尾那句问话在结尾，截头等于没喂", () => {
  /*
   * agent 轮写进 recent 的是整轮叙事的拼接，一轮跑二十步可以上万字。
   * 原来一律 slice(0, 700) 截头 —— 喂进去的是这一轮**刚开始**在做什么，
   * 而用户要回应的是助手**最后**说的那句。截图里「想先搞哪个？我直接帮你实现。」
   * 正好在结尾，一个字都没进去。
   */
  const fn = grab("_predictNextAsk", { code: true });
  assert.match(fn, /who === "助手" \? "…" \+ body\.slice\(-700\)/,
    "助手消息还是截头——收尾那句问话喂不进去");
  assert.match(fn, /body\.slice\(0, 700\)/, "用户消息不该改成截尾，他的诉求在开头");
  assert.ok(!/\.slice\(0, 700\)`/.test(fn), "还有一处无差别截头");
});

test("单飞闸不能自己把自己拆了", () => {
  /*
   * `if (inflight) return;` 原来落在 try 里，而 finally 无条件清标志 ——
   * 被挡住的那次 return 之后照样跑 finally，把**正在飞的那次**的标志清成了 false，
   * 第三次调用就和第一次并发。两条都写 _askPredict，谁后落谁赢。
   */
  const fn = grab("_predictNextAsk", { code: true });
  const gateAt = fn.indexOf("_askPredictInflight) return;");
  const tryAt = fn.indexOf("try {");
  assert.ok(gateAt > 0 && tryAt > gateAt, "单飞闸还在 try 里面——finally 会把在飞的那次清掉");
  // 定时器要在 finally 清，否则抛异常那条路上它会空放一次 abort。
  assert.match(fn, /finally \{[\s\S]{0,200}clearTimeout\(_to\)/, "定时器没在 finally 里清");
});

test("预测的输出预算要按模型能力给，60 对原生推理模型等于零输出", () => {
  /*
   * 生产库 model_usage 近三天实测（预测调用靠和主轮共享 request_id 识别）：
   *   stealth/ox-alpha  265 次，188 次（71%）completion_tokens 顶满 60
   *   glm-5.2           47 次，27 次（57%）顶满
   * 原生推理模型的推理和正文共用同一份输出预算，60 全被推理吃掉，正文一个字不剩。
   */
  // 读**剥掉注释**的源码。这几条断言禁的写法在注释里被逐字引用过（说明为什么不能那么写），
  // 直接对原文断言会被自己的注释喂到 —— 这个仓库有前科，一律先剥注释。
  // 按 AST 取**这一个函数**。原先是 `SRC_CODE.slice(indexOf(...), +6000)`：函数一长，
  // temperature 那句就被挤出窗口（实际发生过）。而去掉长度上界更糟 —— src 会变成「从这里
  // 到文件末尾」，于是 main.js 别处任何一个 temperature: 0.3 都会把下面那条否定断言打红。
  // 两种都是固定窗口的死法，正解是不切窗口。
  const src = grab("_predictNextAsk", { code: true });
  assert.ok(!/max_tokens:\s*60\b/.test(src),
    "又写死 max_tokens: 60 了——原生推理模型会零输出");
  assert.match(src, /max_tokens: _predictMaxTokens\(_predictCfg\.model\)/,
    "预算没有按模型能力算");

  // 判据必须是「模型自己声明了推理档位」，不是模型名单——和 _criticMaxTokens 同源。
  // 取样必须**只**框住 _predictMaxTokens 的函数体。它后面紧挨着 _criticMaxTokens，
  // 那个函数有一模一样的能力声明判据行 —— 固定长度的窗口会溢进去，把判据换成模型名单
  // 也照样绿（变异实测漏网）。用 fnSource 按声明取。
  const budget = grab("_predictMaxTokens", { code: true });
  assert.match(budget, /_thinkingProfileFor\(model\)\?\.kind/,
    "预算判据不是模型的能力声明——换成模型名单，新模型上来又是零输出");
  assert.ok(!/\/[^/\n]*ox-alpha[^/\n]*\//.test(budget) && !/includes\(/.test(budget),
    "又按模型名单判了");
  assert.match(budget, /_AUX_REASONING_HEADROOM_TOKENS/,
    "余量没有复用共享常量，又散了一个新魔数");

  // temperature：这是单点预测不是创作，和同文件其它有界辅助调用一致取 0。
  //
  // 不再 `src.slice(0, 6000)`：src 已经是按 AST 取出的**整个函数体**，再切一刀就是
  // 第二层固定窗口。函数里多几行注释，temperature 那句就被挤出窗口 —— 实际发生过一次，
  // 而这种切法更常见的死法是窗口仍然覆盖、却不再守住它要守的那行，且一直是绿的。
  assert.ok(!/temperature:\s*0\.3/.test(src), "temperature 还是 0.3");
  assert.match(src, /temperature: 0,/, "temperature 不是 0");
});

test("预测必须显式关思考，否则网关把它升级成 effort=high + max_tokens 40000", () => {
  /*
   * 这是 Claude 那条路上「预测从来不出现」的真正原因，而且和 token 饥饿是**两回事**。
   *
   * 网关 `thinking_effort_for(body)` 在客户端什么思考字段都不发时，结尾是
   * `.or(Some("high"))`；`thinking_on` 一旦为真，max_tokens 被抬到 40000。
   * 于是一次「猜一句话」变成深思考大请求，然后被期限掐死。
   * 生产数据对得上：claude-fable-5 三天 70 组请求，预测行 0 条。
   */
  // 按 AST 抠整个函数，不切固定长度的窗口：函数一长（这段注释就长），窗口够不到
  // 尾部的断言目标，而测试**仍然是绿的** —— 它守的东西已经不在它看的那段里了。
  // code:true 取的是注释置空的那一份：下面有一条否定断言，而这个函数的注释里
  // 正好引用了它禁的那个写法，拿原文断言会被自己的注释喂到。
  const src = grab("_predictNextAsk", { code: true });
  assert.match(src, /reasoning_effort: "off"/, "没有显式关思考——网关会补成 high");

  // **只能**用 reasoning_effort:"off"。分叉前那道守卫判的是 `thinking` 键在不在
  // （不看 type），发 {type:"disabled"} 会把 max_tokens 抬到 32000——关思考反而放大预算。
  assert.ok(!/thinking:\s*\{\s*type:\s*"disabled"\s*\}/.test(src),
    "发了 thinking:{type:disabled}——那会把 max_tokens 抬到 32000");

  // 只对**网关上的 Anthropic 一族**发。两条路都会 400：自定义端点上游未知；而网关是
  // 按线路协议分叉的，非 anthropic 的线路原样透传 body。2026-08-25 线上实测，
  // stealth/ox-alpha 当天 7 次 400，报文是
  // `reasoning_effort: invalid option: expected one of "max"|…|"none"` —— off 不在枚举里。
  assert.match(
    src,
    /_predictCfg\.viaGateway && _isAnthropicWireFamily\(_predictCfg\.model\) \? \{ reasoning_effort: "off" \} : \{\}/,
    "这个枚举发到了 anthropic 桥以外的线路上，会被上游 400 打回，那些模型上预测一条都不出",
  );

  // 网关那两条判据本身也钉一下，免得服务端改了这边毫不知情。
  const gw = fs.readFileSync(new URL("../../server/src/models.rs", import.meta.url), "utf8");
  assert.match(gw, /\.or\(Some\("high"\)\)/,
    "网关的默认档变了——如果不再默认 high，这里的 off 就该重新评估");
  assert.match(gw, /is_some_and\(\|e\| !e\.is_empty\(\) && e != "off"\)/,
    "网关不再把 off 排除在 has_thinking 之外了——那 off 也会触发 32000 地板");
  // 上面「按模型名判该不该发 off」之所以成立，前提是网关按**线路协议**分叉：
  // 非 anthropic 的线路不会把 body 改成 anthropic 形状，客户端塞的枚举会落到上游手里。
  // 2026-08-26 起这个分叉从布尔量 `let anthropic = conn.protocol == "anthropic"` 换成了
  // 三态的 Wire 枚举（新增 xai_responses 那条桥），判据跟着换成枚举本身。
  assert.match(gw, /let wire = Wire::of\(&conn\.protocol\)/,
    "网关不再按线路协议分叉了——客户端按模型名判该不该发 off 的整套判据都要重新评估");
  assert.match(gw, /Wire::Anthropic\s*=>/,
    "Wire 枚举里没有 Anthropic 分支了——上面那条 off 只该发给 anthropic 桥");
});

test("期限要和预算一起抬，只改一半是把顶满上限换成静默超时", () => {
  // 按 AST 取整个函数体，**不要**固定字符窗口。原先是 `+ 8000`：函数一长，尾部那两条
  // 「失败留痕」断言就落到窗口外 —— 这次是响亮地红了（加了 6 行注释就越界），但同样的
  // 形状更常见的死法是窗口仍然覆盖、却不再守住它本来要守的那几行，而且一直是绿的。
  const src = grab("_predictNextAsk", { code: true });
  // 钉「算出来的期限**真的被用上**」，不是「算出来了」。只验前者的话，把 setTimeout 的
  // 第二个参数改回 12000、让 _deadlineMs 变成死值，测试照样绿（变异实测漏网）。
  assert.match(src, /_cognitiveLegDeadlineMs\(_predictCfg\)/, "没复用已有的分档期限助手");
  assert.match(src, /ctrl\.abort\(\); \}, _deadlineMs\)/,
    "算出来的期限没被 setTimeout 用上——还是写死的那个数");
  assert.ok(!/\}, 12000\)/.test(src), "还是写死 12 秒——抬了预算之后必然全部超时");

  // 失败路径要留痕，否则「为什么这儿没有预测」在最常见的两种失败上是空的。
  assert.match(src, /_askPredictReject = _timedOut \? "timeout" : "request_failed"/,
    "网络失败/非 200 没有记录原因");
  assert.match(src, /_askPredictReject = sess\._askPredictReject \|\| "threw"/,
    "抛异常（含 abort）没有记录原因");
});

test("预测不能卡住收尾——只后台跑，不 await", () => {
  // 注意别匹配到函数定义那一处——第一个 _predictNextAsk(sess) 是 `async function` 的签名。
  assert.match(SRC, /void _predictNextAsk\(sess\)/,
    "收尾处没有以后台方式触发预测");
  assert.ok(!/await _predictNextAsk\(/.test(SRC),
    "await 了这次预测，模型慢一点整轮收尾就跟着卡");
});

test("没有预测时，要把「为什么没有」留下来——否则那句承诺是空的", () => {
  // _askPredictReject 记着读对话那一档被拒的具体原因（too_long / assistant_voice /
  // meta_text / already_sent …），但在接上读者之前**没有任何地方读它**：
  // 代码里那句「为什么这儿没有预测要答得出来」是句空话。
  const fn = grab("_renderComposerGhost");
  assert.match(fn, /sess\._askPredictReject/, "拒绝原因仍然没有读者");
  assert.match(fn, /本轮没有给出预测：/, "没有把原因呈现出来");
  // 有预测时要把上一次的原因清掉，否则 tooltip 会一直挂着一条过期的解释。
  assert.match(fn, /promptEl\.removeAttribute\("title"\)/, "有预测时没有清掉旧的解释");
});

test("工具图标是单色的——按类型分配色的那 43 条已经不在了", () => {
  // 这条测试原来守的是「那 24 个没有专属配色的图标别变成透明方块」，判据是一条明写的
  // 默认粉彩底。2026-09-01 判据换了：**按类型分配色整套删掉**（用户实拍一轮十个工具，
  // 说「展示的内容很杂乱」——一屏下来是一条绿橙蓝紫红的彩虹）。类型的区分本来就由图标
  // **形状**承担，再给每种配一个底色是把同一件事说两遍，而且说得很吵。
  // 所以现在守的是反过来那一半：默认样式仍然明写（不会变透明方块），而且不许有人
  // 按类型把配色加回来。
  // 先剥 CSS 注释：解释这条改动的注释里原样引用了 `{ … }`，不剥的话
  // 下面 [^}]* 会在注释里的那个花括号处断掉（这个仓库同一个坑踩过三次）。
  const APP_CSS = fs.readFileSync("src/styles/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(APP_CSS, /\.atc-type-icon \{[^}]*background: transparent; color: var\(--atc-dim\);[^}]*\}/s,
    "默认样式没了——图标会变成没颜色的空方块");
  const perType = [...APP_CSS.matchAll(/\.agent-tool-step--[\w-]+ \.atc-type-icon[^{}]*\{([^}]*)\}/g)]
    .filter((m) => /background\s*:|(^|;)\s*color\s*:/.test(m[1]));
  assert.deepEqual(perType.map((m) => m[0].split("{")[0].trim()), [],
    "又有人按工具类型给图标上色了——那正是用户说的「杂乱」");
});

test("判断走不走 Anthropic 桥：Haiku 算，牛来/GPT 不算", () => {
  const isAnthropicWire = new Function(`return ${grab("_isAnthropicWireFamily")}`)();

  // Haiku 是最容易判漏的一族：它在档位表里的 kind 是 "none"（没有可调档位），
  // 所以任何按 kind 判的写法都会把它整族漏掉，而它照样走 anthropic 桥。
  for (const id of ["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "mythos-1"]) {
    assert.equal(isAnthropicWire(id), true, `${id} 该被判成走 anthropic 桥`);
  }

  // 这几个走的是原样透传的线路，收到 "off" 会被上游 400 打回。
  for (const id of ["stealth/ox-alpha", "gpt-5.6-sol", "grok-4.5", "deepseek-v4-pro", "gemini-3-pro"]) {
    assert.equal(isAnthropicWire(id), false, `${id} 不走 anthropic 桥，不该收到 off`);
  }

  assert.equal(isAnthropicWire(""), false, "空模型名不该被判成 Anthropic");
  assert.equal(isAnthropicWire(undefined), false, "缺模型名不该被判成 Anthropic");
});
