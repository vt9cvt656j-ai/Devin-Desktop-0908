// 聊天存档的合并。从 main.js 搬出来的纯函数 —— 它们不碰 DOM、不读全局，
// 而 main.js 有行数闸（见 test/main-size-budget.test.mjs），撞线时先搬模块再谈抬线。
//
// helpers/source.mjs 会把 src/agent/ 下每个模块和 main.js 拼成同一份 SRC，
// 所以原来那些按源码断言的守卫照常有效。

// 两份存档按**会话**合并，而不是「谁先有内容用谁」。
//
// 存档三层，恢复时依次尝试：SQLite 快照 → session.json → localStorage 镜像。判据原本
// 只有 `hasSavedChats`（有内容就用），**不比新旧**。而退出路径里只有 `onCloseRequested`
// 会 await 快照写完；`beforeunload` / `pagehide`（Tauri 直接 destroy webview、强杀、
// 更新重启走的正是这几条）跑不了异步，只来得及同步写 localStorage。
//
// 于是「几分钟前的快照 + 退出瞬间的镜像」两份都非空时，**旧的排在前面就赢了**。
//
// 合并而不是「整份取新的那个」：镜像按 media/text 预算截断过，整份采用会把所有老会话的
// 图片和长文一起降级。逐个会话比消息条数取更全的那个，只在一边出现的原样保留。
const _archiveMsgCount = (sess) => {
  if (!sess) return 0;
  const recent = sess.memory && sess.memory.recent;
  if (Array.isArray(recent)) return recent.length;
  return Array.isArray(sess.history) ? sess.history.length : 0;
};
const _mergeArchiveList = (primaryList, mirrorList) => {
  const out = [];
  const at = new Map();
  for (const sess of (Array.isArray(primaryList) ? primaryList : [])) {
    if (!sess) continue;
    if (sess.id) at.set(sess.id, out.length);
    out.push(sess);
  }
  for (const sess of (Array.isArray(mirrorList) ? mirrorList : [])) {
    if (!sess) continue;
    const i = sess.id ? at.get(sess.id) : undefined;
    if (i === undefined) { out.push(sess); continue; }
    // 两边都有同一个会话：谁的消息多要谁。相等留主存档 —— 它没被预算截断过。
    if (_archiveMsgCount(sess) > _archiveMsgCount(out[i])) out[i] = sess;
  }
  return out;
};
const _archiveHasChats = (v) => !!(v && ((Array.isArray(v.sessions) && v.sessions.length) || (Array.isArray(v.closedSessions) && v.closedSessions.length)));
// 「哪些标签是开着的」这件事，只有**更新的那份存档**说了算。
//
// 内容可以合并（谁的消息多要谁），但**成员资格**不能：并集会把用户已经关掉的会话又并回来。
// 实拍就是这样——SQLite 快照是几分钟前写的、里面还有后来被关掉的会话，而退出瞬间只来得及
// 同步写 localStorage 镜像；两份一取并集，关掉的全复活了。
// 判据是 savedAt。快照那份历史上没写 savedAt，所以缺失一律当**旧**（镜像是退出时才写的，
// 一定不比它旧），这样即使只有一边有时间戳也能判。
const _archiveAt = (v) => (Number.isFinite(v && v.savedAt) ? v.savedAt : 0);

function _mergeChatArchives(primary, mirror) {
  if (!_archiveHasChats(primary)) return mirror;
  if (!_archiveHasChats(mirror)) return primary;
  // 内容照旧逐会话取更全的那份（镜像被预算截断过，整份采用会把老会话的图片和长文降级）。
  const merged = _mergeArchiveList(primary.sessions, mirror.sessions);
  const closedSessions = _mergeArchiveList(primary.closedSessions, mirror.closedSessions);
  // 关掉的一律不算开着——不管它在哪份存档的 sessions 里出现过。这条**无条件**成立：
  // closedSessions 里有它，就说明用户确实关过。
  const closedIds = new Set((Array.isArray(closedSessions) ? closedSessions : []).map((x) => x && x.id).filter(Boolean));
  // 成员资格跟**更新**的那份：它才知道用户最后到底开着哪几个。
  // 只有在真能判出谁更新时才收窄（两边都没有 savedAt 就无从比较）——判不出来时保留并集，
  // 宁可多一个标签，也不能把用户还开着的会话弄丢。
  const at = { p: _archiveAt(primary), m: _archiveAt(mirror) };
  const newer = at.m === at.p ? null : (at.m > at.p ? mirror : primary);
  const openIds = newer
    ? new Set((Array.isArray(newer.sessions) ? newer.sessions : []).map((x) => x && x.id).filter(Boolean))
    : null;
  const sessions = merged.filter((x) => {
    if (!x) return false;
    if (!x.id) return true;                       // 没有 id 无从判断，保留
    if (closedIds.has(x.id)) return false;        // 用户关过它
    return openIds ? openIds.has(x.id) : true;    // 判不出新旧就都留着
  });
  // activeIdx 跟主存档：合并后主存档那些会话的下标原样不变，镜像的未必对得上。
  const idx = Number.isFinite(primary.activeIdx) ? primary.activeIdx : 0;
  return {
    sessions,
    closedSessions,
    activeIdx: Math.max(0, Math.min(idx, Math.max(0, sessions.length - 1))),
  };
}

// 已关闭会话在 localStorage 里另存一个 key，这两个函数是它的判据和读取侧。
//
// 变没变的判据用 **id 列表**，不用内容比对：归档条目是 _archiveChatSession 在关闭那一刻
// 序列化定型的普通对象，此后没有任何代码再改它，所以成员没变 ⇒ 内容没变。
// （checkpoint 那条 _closedCache 用的就是这个判据，这里刻意照抄它的形状。）
const _closedArchiveKey = (list) => (Array.isArray(list) ? list : []).map((s) => (s && s.id) || "").join(",");

// 把拆开的两个 key 合回一份恢复形状；两个参数都是 localStorage 原文，都可能是 null。
//
// 老用户的迁移腿在这里：归档 key 整个缺失时，回退读主 key 内嵌的那份 closedSessions。
// 不能写成 `closed || main.closedSessions` 这种更顺手的形式 —— 归档 key 一旦存在就是唯一
// 权威，**哪怕它是空数组**：用户把归档里最后一条重新打开之后它正是空的，兜底会把这种情况
// 误判成「还没迁移过」，那条已经不该存在的归档下次启动又冒出来。
function _readSplitChatMirror(rawMain, rawClosed) {
  let main = null;
  try { main = rawMain ? JSON.parse(rawMain) : null; } catch { main = null; }
  if (main && typeof main !== "object") main = null;
  let closed = null;
  try {
    const parsed = rawClosed ? JSON.parse(rawClosed) : null;
    if (parsed && Array.isArray(parsed.closedSessions)) closed = parsed.closedSessions;
  } catch { closed = null; }
  // 主 key 读不出来但归档还在（配额把主 key 挤掉过）：归档不该跟着一起丢。
  if (!main) main = closed && closed.length ? { sessions: [], closedSessions: closed, savedAt: 0 } : null;
  else if (closed) main.closedSessions = closed;
  if (!main) return null;
  // 判空必须**在合回来之后**：一个开着的会话都没有、只剩归档时，先判会把整份镜像当空的丢掉。
  return _archiveHasChats(main) ? main : null;
}

export { _archiveMsgCount, _mergeArchiveList, _archiveHasChats, _mergeChatArchives, _closedArchiveKey, _readSplitChatMirror };
