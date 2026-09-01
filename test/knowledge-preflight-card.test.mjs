import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blockFrom, fnSource, SRC } from "./helpers/source.mjs";
import { facetSummary, preflightSettleLabel, preflightBodyHtml, movePreflightCardsAfter, attachFacetLine, createPreflightCard, settlePreflightCard, designPreflightSections }
  from "../src/agent/knowledge-preflight-card.js";

/**
 * 专业域小抄合成一张卡。
 *
 * 用户实拍：一轮里连出四张一模一样的「知识检索」，把第一个模型回合之前的整片视野占满。
 * 它们其实是同一次预检的四个面（适用条件/硬性约束/常见坑/必须做的检查）——一个操作。
 */

// 命中数**故意不按阅读顺序递减**（1/3/0/2）。写成 3/2/1/0 的话，「按命中数重排」这个
// 变异不会改变任何顺序，下面那条顺序断言就是恒真的——第一版就是这么写的，变异测试当场
// 抓住了它。测试数据本身要能把被测的那件事分开。
const S = [
  { heading: "适用条件", bullets: ["a"] },
  { heading: "硬性约束", bullets: ["b", "c", "d"] },
  { heading: "常见坑", bullets: [] },
  { heading: "必须做的检查", bullets: ["e", "f"] },
];

test("四个面的命中数直接写在卡面上，不用点开", () => {
  assert.equal(facetSummary(S), "适用条件 1 · 硬性约束 3 · 常见坑 0 · 必须做的检查 2");
  // 失败的那一面写「失败」，不写 0：零命中是一个结论（域里确实没这个主题），
  // 失败是没有结论（语料好端端摆着，只是没拿到）。写成 0 就把后者伪装成前者。
  const F = [{ heading: "常见坑", bullets: [], failed: true }, { heading: "硬性约束", bullets: ["x"] }];
  assert.equal(facetSummary(F), "常见坑 失败 · 硬性约束 1");
  assert.equal(preflightSettleLabel(F), "1 条 · 2 面 · 1 面失败", "部分失败还是要报拿到的条数");
  // 全失败 → 空串，交给 _knowledgeSettleLabel 去说「检索失败 · 原因」。
  assert.equal(preflightSettleLabel([{ heading: "a", bullets: [], failed: true }]), "",
    "全失败时没有交回给唯一那个区分失败/零命中的判据 —— 会显示成「无可用命中」，等于说库里没有");
  assert.equal(preflightSettleLabel(S), "6 条 · 4 面");
  // 全空时说「无可用命中」，别报一个骗人的 0——这条和 _knowledgeSettleLabel 同口径。
  assert.equal(preflightSettleLabel([{ heading: "x", bullets: [] }]), "无可用命中");
  assert.equal(preflightSettleLabel([]), "无可用命中");
});

test("展开的正文按 rubric 固定顺序排，空的那一面留着标题", () => {
  const html = preflightBodyHtml(S);
  const order = ["适用条件", "硬性约束", "常见坑", "必须做的检查"]
    .map((h) => html.indexOf(`>${h}<`));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
    "顺序被打乱了——「适用条件→硬性约束→常见坑→必须做的检查」本身是一条阅读线，不按命中数重排");
  assert.match(preflightBodyHtml([{ heading: "常见坑", bullets: [], failed: true }]),
    /kpf__empty--fail">检索失败，不等于库里没有/, "失败的那一面在正文里也被写成了零命中");
  assert.match(html, /kpf__empty">无可用命中/,
    "空的那一面被静默丢掉了——「这一面没查到」和「这一面不存在」是两件事");
  // 第三态：命中了 N 段但一条要点都没压出来，不能和真零命中共用一句话。
  assert.match(preflightBodyHtml([{ heading: "常见坑", bullets: [], hits: 4 }]),
    /命中 4 段，未压出要点/, "命中了没压出要点被说成了「无可用命中」");
  assert.ok(preflightBodyHtml(S, null, 3).includes("已截断"), "超长没截断");
});

test("正文是画出来的结构，不是一坨文本", () => {
  // 用户实拍：四个面六条要点糊成一整段。真凶是 .atc-viewport 没有 pre-wrap，而正文是
  // textContent 塞进去的纯文本——换行全被折叠。文本里本来就有结构，只是没人画。
  const html = preflightBodyHtml([{ heading: "常见坑", bullets: [
    "docker-compose → Compose is for local dev **and** small deployments, see `.dockerignore`.",
    "没有来源的一条",
  ] }]);
  // 面 / 条 / 来源三层都要在 DOM 里立得住。
  assert.match(html, /<div class="kpf__sec">/, "面没有成段");
  assert.equal((html.match(/class="kpf__item"/g) || []).length, 2, "条没有各自成行");
  assert.match(html, /<span class="kpf__src">docker-compose<\/span>/,
    "`来源 → 正文` 里的来源没有拆成行首标签——那个箭头是拼出来的分隔符，不是语料里的字");
  assert.doesNotMatch(html, /→/, "分隔符箭头还留在正文里");
  // 没有来源的那条不许凭空长出一个空标签。
  assert.equal((html.match(/class="kpf__src"/g) || []).length, 1, "没有来源的一条也画了来源标签");
  // markdown 的粗体/行内代码要真渲染——语料是 markdown，卡面上摊着 ** 和反引号很难看。
  assert.match(html, /<b>and<\/b>/, "粗体没渲染");
  assert.match(html, /<code>\.dockerignore<\/code>/, "行内代码没渲染");
});

test("正文默认就转义——它拼的是 HTML，语料是外来文本", () => {
  // attachFacetLine 的兜底是「原样返回」，那边喂的是我们自己拼的短标签；这里喂的是语料原文，
  // 不注入 escapeHtml 时兜底必须真转义，否则语料里一段 <script> 就直接进 DOM 了。
  const html = preflightBodyHtml([{ heading: "常见坑", bullets: ["<img src=x onerror=alert(1)> → <b>x</b>"] }]);
  assert.doesNotMatch(html, /<img/, "没注入转义器时兜底没转义——语料能往卡里注入标签");
  assert.match(html, /&lt;img/, "尖括号没被转义成实体");
  // 注入的转义器要真被用上。
  const used = preflightBodyHtml([{ heading: "x", bullets: ["abc"] }], (t) => `[${t}]`);
  assert.match(used, /\[abc\]/, "注入的 escapeHtml 没有被用");
});

test("坏输入一律不抛——它跑在渲染路径上", () => {
  for (const bad of [null, undefined, {}, [null], [{ bullets: null }], "x"]) {
    assert.doesNotThrow(() => facetSummary(bad));
    assert.doesNotThrow(() => preflightSettleLabel(bad));
    assert.doesNotThrow(() => preflightBodyHtml(bad));
  }
});

test("预检卡挪到思考卡后面，且只挪在它前面的那些", () => {
  // 极简 DOM 替身：只实现这个函数真正用到的四件事。
  const mk = (tag = "div") => {
    const el = { tag, children: [], parentNode: null, dataset: {},
      insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
        const i = ref ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        node.parentNode = this;
      },
      append(node) { this.insertBefore(node, null); },
      get nextSibling() {
        const c = this.parentNode?.children || []; return c[c.indexOf(this) + 1] || null;
      },
      querySelectorAll(sel) {
        assert.equal(sel, '[data-knowledge-preflight="1"]');
        return this.children.filter((c) => c.dataset.knowledgePreflight === "1");
      },
      compareDocumentPosition(other) {
        const c = this.parentNode?.children || [];
        return c.indexOf(other) < c.indexOf(this) ? 2 : 4;   // 2 = 在我之前
      } };
    return el;
  };
  const body = mk();
  const k1 = mk(); k1.dataset.knowledgePreflight = "1"; k1.id = "k1";
  const k2 = mk(); k2.dataset.knowledgePreflight = "1"; k2.id = "k2";
  const think = mk(); think.id = "think";
  const later = mk(); later.dataset.knowledgePreflight = "1"; later.id = "later";
  for (const n of [k1, k2, think, later]) body.append(n);

  assert.equal(movePreflightCardsAfter(body, think), 2, "在思考卡之前的两张没被挪");
  assert.deepEqual(body.children.map((c) => c.id), ["think", "k1", "k2", "later"],
    "顺序不对：两张要挪到思考卡后面且保持它们原来的相对顺序；思考卡之后的那张不许再挪");
  // 幂等：再挪一次不该变化（都已经在 anchor 之后了）。
  assert.equal(movePreflightCardsAfter(body, think), 0);
  assert.deepEqual(body.children.map((c) => c.id), ["think", "k1", "k2", "later"]);
  // 坏输入不抛。
  for (const [b, a] of [[null, think], [body, null], [body, {}], [undefined, undefined]]) {
    assert.doesNotThrow(() => movePreflightCardsAfter(b, a));
  }
});

test("预检卡只安置一次，且不止「思考卡」一个锚点", () => {
  // 两个缺陷合起来才是用户那句「要在思考中后面显示」真正被兑现：
  //   A 唯一锚点是思考卡 → 思考档位 off / 线路不回推理时，本轮一张 .think-card 都不建，
  //     这个函数一次都不会被调到，预检卡原地留在正文最前面。
  //   B body 整个 run 只建一次、anchor 每轮新建 → 上一轮摆好的卡对**新**锚点仍是 preceding，
  //     agent 每多跑一轮就再往下拖一次，最后停在整条消息末尾（「在所有内容后面」）。
  const mk = (id, pf) => {
    const n = { id, parentNode: null, dataset: pf ? { knowledgePreflight: "1" } : {} };
    n.compareDocumentPosition = (o) => (body.kids.indexOf(o) < body.kids.indexOf(n) ? 2 : 4);
    return n;
  };
  const body = { kids: [],
    querySelectorAll: () => body.kids.filter((k) => k.dataset?.knowledgePreflight === "1"),
    append(n) { n.parentNode = body; body.kids.push(n); },
    insertBefore(node, ref) {
      const i = body.kids.indexOf(node); if (i >= 0) body.kids.splice(i, 1);
      const at = ref ? body.kids.indexOf(ref) : body.kids.length;
      body.kids.splice(at < 0 ? body.kids.length : at, 0, node); node.parentNode = body;
    } };
  const order = () => body.kids.map((k) => k.id).join(">");

  const card = mk("卡", true); body.append(card);
  const t1 = mk("思考1"); body.append(t1);
  assert.equal(movePreflightCardsAfter(body, t1), 1);
  assert.equal(order(), "思考1>卡", "第一次没安置到锚点后面");

  // B：第二轮的新锚点不许把它再拖一次。
  body.append(mk("工具卡")); const t2 = mk("思考2"); body.append(t2);
  assert.equal(movePreflightCardsAfter(body, t2), 0, "又被新一轮的锚点拖走了——最后会停在消息末尾");
  assert.equal(order(), "思考1>卡>工具卡>思考2");

  // 重来一轮会把本轮思考卡整批 remove。判据若写成布尔位，这时是**过期的真**，
  // 重来的那一轮再也不会安置它；写成锚点引用则自动失效。
  body.kids = body.kids.filter((k) => k !== t1 && k !== t2);
  t1.parentNode = null; t2.parentNode = null;
  const t3 = mk("思考3"); body.append(t3);
  assert.equal(movePreflightCardsAfter(body, t3), 1, "锚点被重试清场移除后，卡没有重新变得可安置");

  // A：调用点必须不止思考卡一个。正文首帧那条覆盖「模型不吐 reasoning 但正常写正文」。
  assert.match(SRC, /_movePreflightCardsAfter\(body, reasoningEl\)/, "思考卡锚点没了");
  assert.match(SRC, /_movePreflightCardsAfter\(body, streamEl\)/,
    "正文首帧没有锚点——思考档位 off 时预检卡会一直压在最前面");
});

test("设计预检也走融合卡——不能只修专业域那条路", () => {
  // 融合卡和「挪到思考卡后面」最初只做在专业域（domain_*）那条路上，michael-design
  // 那条一个字都没改：三条 plan 各建一张卡、且从不打 data-knowledge-preflight，
  // 于是 movePreflightCardsAfter 一张都选不到。结果是——设计任务（这个产品最主打的
  // 场景）看到的仍然是「三张知识检索卡压在最前面」，也就是用户原话抱怨的那一幕。
  // 从代码 review 上很容易误以为已经修完，所以这条测试单独钉设计那条路。
  const pre = fnSource("_runMichaelDesignPreflight", { code: true }) || "";
  assert.ok(pre.length > 400, "取不到 _runMichaelDesignPreflight 正文");
  assert.match(pre, /_createPreflightCard\(body, "michael-design", _createToolStep\)/,
    "设计预检没建融合卡——三条检索还是各出一张");
  assert.match(pre, /_settlePreflightCard\(card,/, "设计预检的融合卡没结算");
  // 每条 plan 各建一张卡的老写法必须消失，否则融合等于没做。
  assert.doesNotMatch(pre, /step = _createToolStep\(call\)/,
    "每条 plan 又各建一张卡了——这正是「一下出一堆」的成因");
  // 失败 vs 零命中的结构判据不许在这次改动里丢掉。
  assert.match(pre, /failed: !result\?\.knowledge/,
    "设计预检丢了「失败 vs 零命中」的结构判据");
  // 卡面那一行的条数要来自**专业域那条路同一个抽取器**，不是拿命中数凑一个等长空数组，
  // 也不是在这条路上另写一份行级过滤——各写一份迟早漂开，卡面数字就和正文对不上了。
  assert.match(pre, /_designPreflightSections\(results, _domainKnowledgeBullets\)/,
    "设计预检没把真实抽取器注入进去");

  // 摊 sections 这段是纯函数，做真往返，别只钉源码。
  const secs = designPreflightSections([
    { plan: { purpose: "信息架构" }, result: { content: "AAA" }, failed: false },
    { plan: { id: "motion" },        result: { content: "BBB" }, failed: false },
    { plan: { purpose: "媒体" },     result: { content: "" }, failed: true, failResult: { content: "[失败] 超时" } },
  ], (txt) => (txt ? [txt] : []));
  assert.deepEqual(secs.map((x) => x.heading), ["信息架构", "motion", "媒体"], "heading 没回落到 plan.id");
  assert.deepEqual(secs.map((x) => x.bullets.length), [1, 1, 0]);
  assert.deepEqual(secs.map((x) => x.failed), [false, false, true], "失败面没被标出来");
  assert.equal(facetSummary(secs), "信息架构 1 · motion 1 · 媒体 失败",
    "失败面在卡面上写成了 0——那会把「没拿到」伪装成「库里没有」");
  // 坏输入不抛：它跑在渲染路径上。
  for (const bad of [null, undefined, "x", [null]]) {
    assert.doesNotThrow(() => designPreflightSections(bad, null));
  }
});

test("调用点：一个域只建一张卡，且思考卡出现时会挪", () => {
  const pre = fnSource("_runDomainKnowledgePreflight", { code: true })
    || SRC.slice(SRC.indexOf("四面预检") - 3000, SRC.indexOf("四面预检") + 3000);
  assert.match(pre, /_createPreflightCard\(body, domain, _createToolStep\)/, "域级那张卡没了");
  assert.match(pre, /_settlePreflightCard\(_groupStep, sections/, "组卡没结算");
  // 建卡时必须打标记，否则挪位置那一步找不到它。判据在模块里，做真往返。
  const made = createPreflightCard(
    { appendChild() {} },
    "ui-ux",
    (call) => ({ _call: call, dataset: {} }),
  );
  assert.equal(made?.dataset?.knowledgePreflight, "1", "卡没打标记");
  assert.match(String(made?._call?.query || ""), /四面预检/);
  assert.equal(createPreflightCard(null, "x", () => ({})), null);
  assert.equal(createPreflightCard({ appendChild() {} }, "x", null), null);
  // 四条 rubric 各自不许再建卡（那正是「一轮连出四张」的成因）。
  assert.doesNotMatch(pre, /step = _createToolStep\(call\)/, "每条 rubric 又各建一张卡了");
  assert.match(SRC, /_movePreflightCardsAfter\(body, reasoningEl\)/,
    "思考卡出现时没有把预检卡挪下去");
  // 四个面必须摆在**卡面上**。要点开才看得见的话，这次合并就变成了 app.css 里
  // 记着的那个被删掉的抽屉：「把内容藏到第二个地方让用户再去翻」。
  // 四个面必须摆在卡面上（不是点开才见）——真往返验它。
  let settled = null;
  const okStep = { querySelector: (q) => (q === ".atc-viewport" ? vp : q === ".atc-action-row" ? row : null),
    ownerDocument: { createElement: () => ({ set className(v) { this._c = v; }, set innerHTML(v) { this._h = v; } }) } };
  const vp = { textContent: "", innerHTML: "" };
  const row = { parentNode: { insertBefore: (el) => { row._line = el._h; } } };
  settlePreflightCard(okStep, S, { settleToolStep: (_s, _r, l) => { settled = l; },
    knowledgeSettleLabel: (_c, _r, l) => l || "检索失败", escapeHtml: (x) => x });
  assert.match(String(row._line || ""), /适用条件 1/, "四个面没摆到卡面上");
  assert.equal(settled, "6 条 · 4 面");
  // innerHTML 而不是 textContent：.atc-viewport 没有 pre-wrap，纯文本的换行会被折叠成一坨。
  assert.equal(vp.textContent, "", "正文又走回 textContent 了——换行会被折叠，四个面糊成一整段");
  assert.match(vp.innerHTML, /class="kpf__facet">适用条件</, "正文没写进 viewport");
  // 全失败 → 交回 knowledgeSettleLabel。
  settlePreflightCard(okStep, [{ heading: "a", bullets: [], failed: true }],
    { settleToolStep: (_s, _r, l) => { settled = l; }, knowledgeSettleLabel: () => "检索失败 · 超时", escapeHtml: (x) => x });
  assert.equal(settled, "检索失败 · 超时", "全失败没走那个唯一区分失败/零命中的判据");
  for (const bad of [null, {}]) assert.doesNotThrow(() => settlePreflightCard(bad, S, {}));
  for (const bad of [null, {}]) assert.doesNotThrow(() => attachFacetLine(bad, "x", null));
});

test("知识检索有自己的图标，不再退回「读文件」那张纸", async () => {
  // 图标表原来内联在 main.js 里（50 个 GitHub Octicons 的实心图形）。2026-09-01 整套换成
  // 24 网格的描边图形并搬进 src/agent/tool-icons.js——实心图在 15px 上糊成色块，形状差别
  // 读不出来，而这个产品指望图标承担"这一步在干什么"的第一眼判断。判据不变：知识检索
  // 必须有自己的图形，且不和「读文件」「外部检索」共用。
  const { TOOL_ICONS, toolIconSvg, toolIconFamily } = await import("../src/agent/tool-icons.js");
  assert.ok(TOOL_ICONS.knowledge, "没有 knowledge 的图形 —— 会退回兜底的文件图");
  assert.notEqual(TOOL_ICONS.knowledge, TOOL_ICONS.read, "知识检索又和「读文件」共用一张图了");
  assert.notEqual(TOOL_ICONS.knowledge, TOOL_ICONS._ksearch, "内置语料和外部检索工具该是两张图");
  // 描边、跟随 currentColor：写死颜色就跟不了主题，也跟不了族色。
  const svg = toolIconSvg("knowledge");
  assert.match(svg, /stroke="currentColor"/, "图标不是描边、或者没跟 currentColor");
  assert.doesNotMatch(svg, /fill="#|fill="white"/, "图标写死了颜色，跟不了主题和状态");
  assert.match(svg, /viewBox="0 0 24 24"/, "和其余工具图标不同栅格");
  assert.equal(toolIconFamily("knowledge"), "read", "知识检索该归到「读」这一族");
});

test("展开正文的样式真在 CSS 里，且行内代码盖得住上面那条清零", () => {
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  for (const cls of [".kpf__sec", ".kpf__facet", ".kpf__n", ".kpf__item", ".kpf__src", ".kpf__empty"]) {
    assert.ok(css.includes(cls), `${cls} 没有样式——正文会退回没有结构的一坨`);
  }
  // .atc-viewport code 把行内代码的底色和内边距清零了，同特异度靠源码顺序决定；
  // 写成 .atc-viewport .kpf code（0,2,1）才盖得住。
  // 找带 { 的那条规则本身：上面那段注释里也写着这个选择器，按裸选择器找会匹配到注释，
  // 规则被改窄成 .kpf code 也照样绿。
  const i = css.indexOf(".atc-viewport .kpf code {");
  assert.ok(i > 0, "行内代码没写成 .atc-viewport .kpf code —— 会被上面那条清零规则盖掉");
  assert.match(css.slice(i, css.indexOf("}", i)), /background:/, "行内代码没有底色，等于没样式");
});
