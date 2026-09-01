// 多标签页 AI 会话：后台标签在跑的时候，不许影响你正在看的那个标签；
// 后台标签自己那一轮也不许因为"没在前台"而收不了尾。
//
// 用户实拍的问法是「多 tab ai 会话窗口 为什么持续性不行 难道是单线程导致的？容易中断和卡顿」。
// 单线程不是原因（后端每轮各自一个异步任务、各自的取消令牌和事件通道，没有全局锁）。
// 真正的原因是几处**该按会话分开、却写成了全局/按当前标签**的判据。这一份逐条钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fnSource, load, CODE } from "./helpers/source.mjs";

const el = (over = {}) => ({
  _cls: new Set(), _removed: [],
  classList: {
    _s: null,
    toggle(n, on) { if (on) this._s.add(n); else this._s.delete(n); },
    add(n) { this._s.add(n); }, remove(n) { this._s.delete(n); },
    contains(n) { return this._s.has(n); },
  },
  querySelectorAll() { return []; },
  ...over,
});
const container = () => { const c = el(); c.classList._s = c._cls; return c; };

test("后台标签的回合跑完，收尾清理照样执行——它的容器只是不在文档里", () => {
  // 切标签会把 chatEl 的子节点全摘掉再挂新标签的容器，于是后台标签的容器**离开了
  // document**。原来这里的门是 document.contains(c)，对后台标签恒假：is-streaming 没摘、
  // 思考卡还在、光标还在闪、消息操作条永久隐藏——一个**已经正常跑完**的回合，
  // 长得和「中途断了」一模一样。这就是"持续性不行"最直接的那条。
  const c = container();
  c.classList.add("is-streaming");
  let revealed = 0, thinkingRemoved = 0;
  const fn = load("_setStreaming", {
    backend: {},
    document: { contains: () => false }, // ← 后台标签：容器不在文档里
    _cancelSessionInteractions: () => {},
    _removeAllThinking: () => { thinkingRemoved++; },
    _revealMsgActions: () => { revealed++; },
    _renderChatTabs: () => {},
    _renderTokenMeter: () => {},
    saveChatHistory: () => {},
    _currentSession: () => null,
    _setSendBtnStop: () => {},
    queueMicrotask: () => {},
  });
  fn({ id: "bg", container: c, streaming: true }, false);
  assert.equal(c.classList.contains("is-streaming"), false, "is-streaming 没摘——切回去还在闪光标");
  assert.equal(thinkingRemoved, 1, "思考卡没清——看起来像卡在思考里");
  assert.equal(revealed, 1, "消息操作条永久藏着——那条回复看起来没跑完");
});

test("跟随滚动认会话、也认节点：后台标签不许拽动你正在看的那一屏", () => {
  const visible = { id: "front" };
  const chatEl = { scrollTop: 0, scrollHeight: 5000, clientHeight: 500, contains: (n) => n && n._inView === true };
  let scrolled = 0;
  const mk = () => load("_chatFollow", {
    chatEl,
    _chatPinned: true,
    _chatFollowRAF: 0,
    _chatFollowSession: null,
    _currentSession: () => visible,
    _markProgramScroll: () => { scrolled++; },
    requestAnimationFrame: (cb) => { cb(); return 1; },
  });
  // ① 传后台会话 → 不动
  scrolled = 0; mk()({ id: "bg" });
  assert.equal(scrolled, 0, "后台会话把前台的滚动条拽走了");
  // ② 传当前会话 → 动
  scrolled = 0; mk()(visible);
  assert.equal(scrolled, 1, "当前会话反而不跟随了");
  // ③ 传一个不在可见聊天区里的节点（后台标签的卡片）→ 不动
  scrolled = 0; mk()({ nodeType: 1, _inView: false });
  assert.equal(scrolled, 0, "后台标签写的那个节点把前台拽走了");
  // ④ 传一个在可见聊天区里的节点 → 动
  scrolled = 0; mk()({ nodeType: 1, _inView: true });
  assert.equal(scrolled, 1, "前台自己的节点反而不跟随了");
});

test("流式路径上的跟随滚动全都传了归属，一处都不许漏", () => {
  // 漏传就等于"按当前标签处理"，而后台标签每 90ms 一帧——一秒把你正在读的内容拽到底十来次。
  const bare = [...CODE.matchAll(/_chatFollow\(\)/g)];
  // 允许剩下的只有**外层已经判过 session** 的那几处。
  const lines = CODE.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /_chatFollow\(\)/.test(l));
  for (const [n, l] of lines) {
    assert.match(l, /=== _currentSession\(\)/,
      `第 ${n} 行的 _chatFollow() 既没传归属、外层也没判 session：${l.trim()}`);
  }
  assert.ok(bare.length <= 4, `裸调用点变多了（${bare.length} 处）——新加的那处多半没传归属`);
});

test("代码上色不许被别的标签页掐掉", () => {
  const fn = fnSource("highlightCode", { code: true });
  assert.doesNotMatch(fn, /_chatSessions\.some\(/,
    "又改回「任何会话在流式就不上色」了——开两个标签页，其中一个在跑，另一个所有代码块都是灰的");
  assert.match(fn, /_currentSession\(\)[\s\S]{0,80}streaming/,
    "判据不是「用户正看着的这个会话在流式」");
});

test("清洗/分段的记忆化是多槽——两个标签交替 flush 不许把命中率打成 0", () => {
  const clean = load("_cleanAgentText", {
    _perfPhase: () => {},
    _transformFileContentTags: (t) => t,
    _stripToolNarration: (t) => t,
    _stripAckOpeners: (t) => t,
    _stripTeachingSections: (t) => t,
  });
  const A = "标签页 A 的回复正文";
  const B = "标签页 B 的回复正文";
  clean(A); clean(B);
  // 交替再来一轮：单槽的话这两次都会 miss（各自被对方顶掉）。
  const cacheA = clean._cache;
  assert.ok(cacheA instanceof Map, "缓存不是 Map——又退回单槽了");
  assert.ok(cacheA.has(A) && cacheA.has(B), "两个标签的结果不能同时留在缓存里");
  assert.ok(cacheA.size <= 4, "缓存没有上限，长回复会把内存吃穿");
});

test("并发命令超限时排队，不许编一条「执行失败」喂给模型", () => {
  const src = CODE;
  // 判据钉在**行为**上：撞上限那条路径必须是 await 一个 Promise，而不是 return 一条结果。
  const gate = src.slice(src.indexOf("if (_runningTermCmds >= _MAX_CONCURRENT_CMDS)"));
  const body = gate.slice(0, gate.indexOf("_runningTermCmds++"));
  assert.doesNotMatch(body, /return \{/, "撞上限时又直接 return 了一条编出来的执行结果");
  assert.match(body, /await new Promise/, "撞上限时没有排队等位");
  assert.match(src, /_termCmdQueue\.push\(entry\)/, "没有排队");
  assert.match(src, /_releaseTermSlot/, "跑完没有唤醒排队的下一条");
});

test("本轮的模式和 steer 用的配置，取的是这个会话自己的", () => {
  const fn = fnSource("sendPrompt", { code: true });
  assert.match(fn, /const effectiveMode = _normalizeAiMode\(sess\?\.mode \|\| _currentAiMode\)/,
    "又按前台标签的模式跑后台会话了——而且会把结果永久写回那个会话");
  assert.match(fn, /if \(sess === _currentSession\(\)\) _currentAiMode = effectiveMode/,
    "后台回合把界面上的模式选择器改掉了");
  assert.match(fn, /sess\._lastAiConfig = config/, "没给会话留自己那份配置");
  const steer = fnSource("_steerRunningAgent", { code: true });
  assert.match(steer, /sess\._lastAiConfig \|\| _lastGoodAiConfig/,
    "实时引导仍旧拿全局配置——A 标签的引导会用上 B 标签的模型和线路");
});

test("发送键变「停止」也要判是不是当前标签", () => {
  const fn = fnSource("sendPrompt", { code: true });
  assert.match(fn, /if \(sess === _currentSession\(\)\) _setSendBtnStop\(true\)/,
    "后台标签一起跑，前台空闲标签的发送键就变成「停止」，点了什么都不发生");
});
