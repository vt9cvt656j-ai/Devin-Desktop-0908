// 流式草稿增量日志的两个纯逻辑：把缓冲的 delta 按轮次合并；恢复时把「日志重建」与「2s 快照」取较全者。
// 真正的写文件/读文件在 Rust（stream_draft.rs），这里只做能单测的纯计算。

/**
 * 把一批缓冲的 delta（{g, t, r}）按 gen 合并成若干 append 记录，保持首次出现顺序。
 * 一轮内 gen 恒定，正常只出一条；跨轮切换那一刻才会出两条。
 * @param {Array<{g?:number,t?:string,r?:string}>} batch
 * @returns {Array<{gen:number,text:string,reasoning:string}>}
 */
export function groupDeltasByGen(batch) {
  const order = [];
  const byGen = new Map();
  for (const d of Array.isArray(batch) ? batch : []) {
    if (!d) continue;
    const g = Number(d.g) || 0;
    if (!byGen.has(g)) { byGen.set(g, { gen: g, text: "", reasoning: "" }); order.push(g); }
    const e = byGen.get(g);
    if (typeof d.t === "string") e.text += d.t;
    if (typeof d.r === "string") e.reasoning += d.r;
  }
  return order.map((g) => byGen.get(g)).filter((e) => e.text || e.reasoning);
}

/**
 * 恢复：把 Rust 日志重建出的草稿并进 2s 快照草稿。
 * 同一会话两边都有时，正文/思考各取**较长**的一份（一轮内内容只增，长的就是更新的那份，
 * 而增量日志几乎总比 2s 快照新）；steps 只有快照里有，原样保留。日志独有的会话直接补进来。
 * @param {Array<{sessionId:string,text?:string,reasoning?:string,steps?:string}>} snapshots
 * @param {Array<{sessionId:string,text?:string,reasoning?:string}>} journal
 */
export function mergeJournalIntoDrafts(snapshots, journal) {
  const out = new Map();
  for (const d of Array.isArray(snapshots) ? snapshots : []) {
    if (d && typeof d.sessionId === "string") out.set(d.sessionId, { ...d });
  }
  for (const j of Array.isArray(journal) ? journal : []) {
    if (!j || typeof j.sessionId !== "string") continue;
    const cur = out.get(j.sessionId);
    if (!cur) {
      const fresh = { sessionId: j.sessionId, text: j.text || "", reasoning: j.reasoning || "", steps: "" };
      if (typeof j.html === "string" && j.html) { fresh.html = j.html; fresh.htmlAt = Number(j.htmlAt) || 0; }
      out.set(j.sessionId, fresh); continue;
    }
    const jt = String(j.text || ""), jr = String(j.reasoning || "");
    if (jt.length > String(cur.text || "").length) cur.text = jt;
    if (jr.length > String(cur.reasoning || "").length) cur.reasoning = jr;
    // 关闭前那一刻的 DOM 快照：两边都可能有（退出 flush 写进快照、3s 节拍写进日志），按拍摄时间取新的。
    if (typeof j.html === "string" && j.html && (Number(j.htmlAt) || 0) >= (Number(cur.htmlAt) || 0)) {
      cur.html = j.html; cur.htmlAt = Number(j.htmlAt) || 0;
    }
  }
  return [...out.values()];
}

/** 在途消息 DOM 快照的落盘节拍（毫秒）：比 400ms 的 delta 节拍慢，因为一次是整条消息的克隆 + 序列化。 */
export const HTML_SNAPSHOT_INTERVAL_MS = 3000;
/** 超过这个体积的快照放慢节拍：整份 HTML 要经 IPC 序列化一次，大的连着刷会顶到主线程。 */
export const HTML_SNAPSHOT_LARGE_BYTES = 512 * 1024;
/** 大快照的节拍倍数。3s → 9s：被强杀时最多多丢 6 秒，换掉长任务上的周期性卡顿。 */
export const HTML_SNAPSHOT_LARGE_FACTOR = 3;

/** 这一份快照下一次该隔多久再拍。只看上一次的体积——大的放慢，小的照旧。 */
export function htmlSnapshotInterval(lastBytes) {
  return Number(lastBytes) > HTML_SNAPSHOT_LARGE_BYTES
    ? HTML_SNAPSHOT_INTERVAL_MS * HTML_SNAPSHOT_LARGE_FACTOR
    : HTML_SNAPSHOT_INTERVAL_MS;
}

/**
 * 一拍：把每个会话缓冲的 delta 增量刷进 Rust 真文件；收尾会话删其日志文件。
 * 逻辑放模块里（main.js 有尺寸闸），main.js 只留一个 setInterval 薄壳注入 invoke。
 * 另外每 HTML_SNAPSHOT_INTERVAL_MS 把在途消息的 DOM 快照（`opts.snapshotHtml(session)`，由 main.js 注入
 * draft-recovery.js 的 liveMessageHtml）整份写进 Rust 文件——恢复时按「关闭前那一刻」原样塞回。
 * 只在内容变了才写；没变的快照写了也是白写。
 * @param {Array} sessions  _chatSessions
 * @param {(cmd:string,args:object)=>Promise} invoke  backend.invoke
 * @param {{snapshotHtml?:(s:object)=>string, now?:()=>number}} [opts]
 */
export async function drainJournal(sessions, invoke, opts = {}) {
  const snapshotHtml = typeof opts?.snapshotHtml === "function" ? opts.snapshotHtml : null;
  const now = typeof opts?.now === "function" ? opts.now() : Date.now();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s?.id) continue;
    if (s._journalClearPending) {
      s._journalClearPending = false;
      s._draftHtmlLast = "";
      try { await invoke("stream_draft_clear", { sessionId: s.id }); } catch {}
      continue;
    }
    const buf = s._journalBuf;
    if (buf && buf.length) {
      for (const rec of groupDeltasByGen(buf.splice(0, buf.length))) {
        try { await invoke("stream_draft_append", { sessionId: s.id, gen: rec.gen, text: rec.text, reasoning: rec.reasoning }); } catch {}
      }
    }
    if (!snapshotHtml || !s.streaming || !s._liveMsgEl) continue;
    if (now - (Number(s._draftHtmlAt) || 0) < htmlSnapshotInterval(s._draftHtmlBytes)) continue;
    s._draftHtmlAt = now;
    let html = "";
    try { html = String(snapshotHtml(s) || ""); } catch { html = ""; }
    if (!html || html === s._draftHtmlLast) continue;
    s._draftHtmlLast = html;
    s._draftHtmlBytes = html.length;
    try { await invoke("stream_draft_snapshot", { sessionId: s.id, gen: Number(s._runGen) || 0, at: now, html }); } catch {}
  }
}
