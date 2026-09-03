// Plan 模式那一屏的流式更新：**重活必须排在节流之后**。
//
// 原来 accumulate() 一个函数干两件事——维护段落账本（便宜）和拼出整份方案（贵：
// 展开数组 + filter + join 全文）——而 300ms 节流排在它**之后**才判。
// 于是一份 8000 字的方案按 token 流下来，就是几千次全文重建，全部落在主线程上。
// 节流的意义本来就是「别每个 token 都做重活」，重活却排在节流前面。
import test from "node:test";
import assert from "node:assert/strict";
import { createPlanTab } from "../src/agent/plan-tab.js";

function mk() {
  const calls = { openFromReply: 0, joins: 0 };
  const openFiles = new Map();
  const pane = {
    querySelector: () => ({ textContent: "", firstChild: null, removeChild() {}, appendChild() {} }),
    addEventListener() {}, innerHTML: "", hidden: false, classList: { add() {}, remove() {} },
  };
  const tab = createPlanTab({
    editorContainer: { appendChild() {} },
    renderMarkdownInto() { calls.joins++; },
    sendPrompt() {}, planCoreFromReply: (md) => md, planTitleFromReply: () => "标题",
    getSessionTitle: () => "会话", tabPath: "/plan", tabName: "方案",
    openFiles, renderTabs() {}, syncWelcome() {}, activate() {}, getActivePath: () => "/other",  // 不走 render()：那条会去建真 DOM，Node 里没有 document
    closeTab() {}, onAccept() {}, onDoc() { calls.openFromReply++; }, isPlanMode: () => true,
  });
  // ensure() 会去建 DOM —— 这里只走 openFromReply 那条（onDoc 是它的观测点）。
  return { tab, calls };
}

test("页签开着之后，节流窗口内的 token 不许再拼全文（按工作量量，不按调用次数）", () => {
  // joinDoc 是纯字符串操作，外面挂不上桩 —— 所以量**工作量**：喂一份很大的方案，
  // 在同一个 300ms 窗口里连喂 N 个 token。节流排在拼全文之前是 O(N)，排在之后是 O(N·文档长度)。
  // 两者相差两三个数量级，不会被机器快慢淹掉。
  const BIG = "# 方案标题\n" + "这是一段很长的方案正文，用来把全文重建的代价放大。".repeat(4000); // ~100k 字
  const run = () => {
    const { tab, calls } = mk();
    tab.liveUpdate("t1", BIG);              // 开页签
    const opened = calls.openFromReply;
    let text = BIG;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 400; i++) { text += "字"; tab.liveUpdate("t1", text); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, extra: calls.openFromReply - opened };
  };
  const { ms, extra } = run();
  assert.equal(extra, 0, "节流窗口里不该有任何一次渲染");
  // 400 个 token × 100k 字的全文重建 ≈ 40MB 字符串构造，实测几十毫秒；
  // 只记账不拼全文实测 <2ms。阈值放到 25ms，只拦真正的退化。
  // 实测：改前 24.9ms（大头是 startsWith 把 100k 串摊平，不是拼全文——量过才知道），
  // 改后 0.06ms。阈值 5ms，只拦真正的退化。
  assert.ok(ms < 5,
    `节流窗口里 400 个 token 花了 ${ms.toFixed(2)}ms —— 多半是又有人在每个 token 上做 O(全文) 的活了。`);
});

test("换了一轮要重新开始，不把上一轮的方案接在后面", () => {
  const { tab, calls } = mk();
  tab.liveUpdate("t1", "# 第一轮\n正文");
  const n1 = calls.openFromReply;
  tab.liveUpdate("t2", "# 第二轮\n正文");
  assert.ok(calls.openFromReply > n1, "新一轮出现标题时必须重新开");
});

test("模型分几条消息说话时，后面那条接在前面后面，不是顶掉", () => {
  const { tab } = mk();
  const seen = [];
  // 用 commit 观测拼出来的全文（它走同一个累积器）
  tab.liveUpdate("t1", "# 标题\n第一段");
  tab.liveUpdate("t1", "# 标题\n第一段更长了");
  // 换了一条消息（不再以 liveCur 开头）
  const doc = (() => { let d = null; const orig = tab.openFromReply.bind(tab);
    tab.openFromReply = (md, o) => { d = md; return orig(md, o); };
    tab.commit("t1", "第二条消息的内容"); tab.openFromReply = orig; return d; })();
  assert.ok(doc && doc.includes("第一段更长了") && doc.includes("第二条消息的内容"),
    `换消息时把前面那段丢了：${JSON.stringify(String(doc).slice(0, 120))}`);
});

test("换消息的判定不许被那条长度快路径放过——正文丢了比慢严重得多", () => {
  // 长文本上用长度单调性代替 startsWith，依据是调用契约：liveUpdate 按 token 调，
  // 一条新消息第一次被看见时只有几个字，长度当场回落。这条测试守住那个前提真的够用。
  const grab = () => {
    const { tab } = mk();
    let last = null;
    const orig = tab.openFromReply.bind(tab);
    tab.openFromReply = (md, o) => { last = md; return orig(md, o); };
    return { tab, doc: () => last };
  };
  // ① 长消息（远超 4096）之后换一条短消息：必须接在后面，不能顶掉
  {
    const { tab, doc } = grab();
    const LONG = "# 标题\n" + "长正文。".repeat(3000);
    tab.liveUpdate("t1", LONG);
    tab.liveUpdate("t1", "收尾那句话");          // 新消息第一片，长度回落
    tab.commit("t1", "收尾那句话");
    assert.ok(doc().includes("长正文。") && doc().includes("收尾那句话"),
      "长方案被收尾那条短消息顶掉了 —— 这正是「写的时候很多，写完只剩一点」");
  }
  // ② 短消息（<4096，走精确比较）之后换一条**更长**的：长度判据会看错，精确比较必须接住
  {
    const { tab, doc } = grab();
    tab.liveUpdate("t1", "# 好");                 // 很短
    tab.liveUpdate("t1", "完全不同的第二条消息，而且比第一条长得多".repeat(3));
    tab.commit("t1", "完全不同的第二条消息，而且比第一条长得多".repeat(3));
    assert.ok(doc().includes("# 好"),
      "上一条很短、新一条第一片就更长 —— 正是长度判据唯一会看错的情形，必须由精确比较盖住");
  }
  // ③ 同一条正常增长：不许被误判成换了消息（那会把同一段文字重复两遍）
  {
    const { tab, doc } = grab();
    const BASE = "# 标题\n" + "内容".repeat(3000);
    tab.liveUpdate("t1", BASE);
    tab.liveUpdate("t1", BASE + "又长了一点");
    tab.commit("t1", BASE + "又长了一点");
    const n = (doc().match(/# 标题/g) || []).length;
    assert.equal(n, 1, `同一条消息被当成两条，标题出现了 ${n} 次`);
  }
});
