// Plan 模式那一屏：虚拟页签 + 方案正文 + 底部「用不用这个方案」。
//
// 整块住在这里而不是 main.js：main.js 有行数闸（test/main-size-budget.test.mjs），
// 仓库规矩是「撞线先腾地方，再谈抬线」。依赖全部注入 —— 这一层不认识全局，
// 也因此能被单独测。
export function createPlanTab(deps) {
  const {
    editorContainer, renderMarkdownInto, sendPrompt,
    planCoreFromReply, planTitleFromReply, getSessionTitle,
    tabPath, tabName,
    openFiles, renderTabs, syncWelcome, activate, getActivePath,
    closeTab, onAccept, onDoc, isPlanMode,
  } = deps;
  const state = { el: null, md: "", title: tabName };

  function ensure() {
    if (state.el) return state.el;
    const pane = document.createElement("div");
    pane.className = "planpane";
    pane.id = "planPane";
    pane.innerHTML = `
      <div class="planpane__head"><span class="planpane__title"></span></div>
      <div class="planpane__body"></div>
      <div class="planpane__foot">
        <button type="button" class="planpane__btn planpane__btn--go" data-plan="go">按这个方案执行</button>
        <button type="button" class="planpane__btn" data-plan="dismiss">先不用</button>
      </div>`;
    pane.addEventListener("click", (e) => {
      const act = e.target.closest("[data-plan]")?.dataset.plan;
      if (act === "dismiss") { closeTab(); return; }
      if (act === "go") {
        // Plan 是只读模式，留在这儿它不会动手 —— 先切回 Agent，再把方案原文发回去。
        try { onAccept(); } catch {}
        sendPrompt(`按下面这个方案执行，逐条落地并自己验证：\n\n${state.md}`);
        closeTab();
      }
    });
    editorContainer.appendChild(pane);
    state.el = pane;
    return pane;
  }

  function render() {
    const pane = ensure();
    pane.querySelector(".planpane__title").textContent = state.title || tabName;
    const body = pane.querySelector(".planpane__body");
    while (body.firstChild) body.removeChild(body.firstChild);
    try { renderMarkdownInto(body, state.md); } catch { body.textContent = state.md; }
  }

  // 流式过程中就往这一屏写，不等回合跑完。300ms 节流 —— 跟得上眼睛，又不会每个
  // token 都重排一次 markdown。挂在 main.js 的 _streamDraftSave 上，因为那是流式
  // 过程中**带着累积文本反复被调用**的唯一一处；另找收尾点只会两边各说各话。
  let liveAt = 0;
  let liveTurn = null;
  // 一轮里模型分好几条消息说话（每跑一步一条），而 liveUpdate 每次只拿到**当前那条**的
  // 累积文本。所以「换了一条消息」必须往后接，不能顶掉前面那条 —— 否则收尾那条
  // 「方案交付完毕。给执行者的下一句话……」一到，整份方案就被两段话替换掉了，
  // 用户看到的正是「写的时候明明很多，写完只剩一点」。
  let liveDone = [];   // 本轮已经说完的那几条
  let liveCur = "";    // 当前这条累积到哪儿
  let liveShown = false; // 这一轮往面板里写过没有
  let sawHeading = false; // 已经见过小节标题（见 liveUpdate：只在还没开页签时才需要判）
  // 拆成两半：**记账**每个 token 都要做（很便宜），**拼全文**只在真要渲染时做。
  //
  // 原来 accumulate 一个函数干两件事，而 300ms 节流排在它**之后**判——于是每个 token
  // 都要付一次「展开数组 + filter + join 整份方案」。一份 8000 字的方案、按 token 流下来，
  // 就是几千次全文重建，全部落在主线程上。节流的意义本来就是「别每个 token 都做重活」，
  // 重活却排在节流前面，等于节流只省了 DOM、没省字符串。
  // 同一条在长，还是换了一条？
  //
  // 精确判据是 `text.startsWith(liveCur)`，而它在长方案上是**每个 token 一次 O(n)**：
  // V8 得先把整条 cons string 摊平再逐字比。实测 100k 字的方案、400 个 token：23.3ms，
  // 全部落在主线程上，而这还只是一个 300ms 窗口里的量。
  //
  // 长文本上改用长度单调性，依据是这个函数的**调用契约**：liveUpdate 是按 token 调的，
  // 传进来的是当前这条消息**到目前为止**的累积文本。所以一条新消息第一次被看见时
  // 必然只有几个字 —— 长度当场回落，判得出来。
  // 短文本（<4096）时照旧精确比较：那时 startsWith 的代价可以忽略，而「上一条很短、
  // 新一条第一片就更长」恰恰是长度判据唯一会看错的情形，正好被精确比较盖住。
  const EXACT_UNTIL = 4096;
  function isSameMessage(text) {
    if (!liveCur) return true;
    if (liveCur.length < EXACT_UNTIL) return text.startsWith(liveCur);
    return text.length >= liveCur.length;
  }
  function track(turn, text) {
    if (liveTurn !== turn) { liveTurn = turn; liveDone = []; liveCur = ""; liveShown = false; liveAt = 0; sawHeading = false; }
    if (isSameMessage(text)) liveCur = text;                             // 同一条在长
    else { if (liveCur.trim()) liveDone.push(liveCur); liveCur = text; } // 换了一条
  }
  function joinDoc() {
    return [...liveDone, liveCur].filter((s) => s.trim()).join("\n\n");
  }
  function accumulate(turn, text) { track(turn, text); return joinDoc(); }

  return {
    state,
    render,
    /** @param turn 这一轮的会话 id；@param md 到目前为止累积的回复文本 */
    liveUpdate(turn, md) {
      if (!isPlanMode()) return;
      track(turn, String(md || ""));
      // 已经开着页签：**先看节流，再拼全文**。拼全文是这条路径上唯一的重活。
      if (liveShown) {
        const now = Date.now();
        if (now - liveAt < 300) return;
        liveAt = now;
        this.openFromReply(joinDoc(), { focus: false }); // 只更新，不抢焦点
        return;
      }
      const doc = joinDoc();
      // **等到出现第一个小节标题再开页签**，不是一有字就开：模型开头总有一两句引子，
      // 那时开等于刚吐两个字就把编辑区抢走，比不写还烦。
      // 判据是「这一轮写过没有」，不是「页签开着没有」：页签开着但换了新一轮时，按后者
      // 会直接掉进下面的节流分支 —— 上一轮的方案要么被新一轮的第一个 token 顶掉，要么
      // 被节流挡住一直挂着不动。两种都不对。
      if (!sawHeading && !/^#{1,6}\s+\S/m.test(doc)) return;
      sawHeading = true;
      liveShown = true; liveAt = Date.now();
      // 第一次开才跟过去；页签已经在了就别抢焦点，用户可能正在别的文件里。
      this.openFromReply(doc, { focus: !openFiles.has(tabPath) });
    },

    // 回合收尾。**照样过累积器**：收尾那条消息只是本轮的最后一段，不是全文，
    // 直接拿它开窗就等于把前面几段扔了。流式没跑过时 liveDone 是空的，
    // 这里退化成「就用这一条」—— 和以前的行为一样。
    commit(turn, md) {
      if (!isPlanMode()) return false;
      return this.openFromReply(accumulate(turn, String(md || "")));
    },
    show() { ensure(); state.el.hidden = false; render(); },
    hide() { if (state.el) state.el.hidden = true; },
    /**
     * 用一份 Plan 回复打开/更新方案页签。
     *
     * **抽不出核心内容就不开**（返回 false）：空白页比没有更糟 ——
     * 「这一轮没有可执行内容」不该以一张空页的形式呈现。
     */
    openFromReply(markdown, { focus = true } = {}) {
      const core = planCoreFromReply(markdown);
      if (!core) return false;
      state.md = core;
      // **标题由模型自己起**：用方案正文的第一个标题（plan.txt 要求模型开头就写一个短标题，
      // 比如「项目评价：cursor-proxy」）。模型没给标题时，才回落到会话主题（用户那句请求）。
      // 上一版把会话主题排在前面，结果模型明明写了标题却被盖掉 —— 顺序反了。
      const modelTitle = planTitleFromReply(markdown, "");
      const sessTitle = (typeof getSessionTitle === "function" && getSessionTitle()) || "";
      state.title = modelTitle || sessTitle || tabName;
      try { onDoc(state.md, state.title); } catch {}
      // 页签名用**从方案里起的标题**，不再是死板的「方案」。方案一变（流式/重写）也跟着更新。
      const entry = openFiles.get(tabPath);
      if (!entry) {
        openFiles.set(tabPath, { model: null, name: state.title, dirty: false, viewState: null, isPlan: true });
        syncWelcome();
      } else if (entry.name !== state.title) {
        entry.name = state.title;
      }
      renderTabs();
      if (focus) activate(tabPath);
      else if (getActivePath() === tabPath) render();
      return true;
    },
  };
}
