// 崩溃 / 重启恢复：把在途消息按「关闭前那一刻」定格（src/agent/draft-recovery.js）。
// 用户原话「关闭前啥样，他就要啥样」：思考卡、工具卡、正文段都要原样回来，横幅一句都不要。
// 这里用一个几十行的假 DOM 跑真行为（仓库没有 jsdom）：只实现模块用到的那几个查询。
import test from "node:test";
import assert from "node:assert/strict";
import { settleLiveClone, liveMessageHtml, markRecoveredMessage, recoveredThinkingOpen, shedInlineMedia, shedLargestBlocks, LIVE_HTML_MAX_CHARS } from "../src/agent/draft-recovery.js";

class El {
  constructor(tag, classes = [], attrs = {}, children = []) {
    this.tag = tag; this._cls = new Set(classes); this.attrs = { ...attrs }; this.children = children; this.textContent = "";
    for (const c of children) c.parent = this;
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c), contains: (c) => self._cls.has(c),
    };
  }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  matches(sel) {
    return sel.split(",").map((s) => s.trim()).some((simple) => {
      if (/^\[(.+)\]$/.test(simple)) return this.attrs[RegExp.$1] != null;
      // 标签名（"img"）和类链（".a.b"）都要认：瘦身那段按标签找媒体元素。
      const m = /^([a-z][a-z0-9]*)?((?:\.[^.]+)*)$/i.exec(simple);
      if (!m) return false;
      if (m[1] && m[1].toLowerCase() !== String(this.tag).toLowerCase()) return false;
      return m[2].split(".").filter(Boolean).every((c) => this._cls.has(c));
    });
  }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const out = [];
    for (const n of this.walk()) {
      for (const p of parts) {
        const chain = p.split(/\s+/);           // 只支持后代选择器 ".a .b"
        const last = chain[chain.length - 1];
        if (!n.matches(last)) continue;
        if (chain.length === 1 || chain.slice(0, -1).every((anc) => { let q = n.parent; while (q) { if (q.matches(anc)) return true; q = q.parent; } return false; })) { out.push(n); break; }
      }
    }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  cloneNode() { const k = new El(this.tag, [...this._cls], this.attrs, this.children.map((c) => c.cloneNode())); k.textContent = this.textContent; return k; }
  // 属性也要进去：内嵌图片那几百 KB 的 data URL 就在属性里，不算进来就量不出体积。
  get outerHTML() {
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<${this.tag} class="${this.className}"${attrs}>${this.textContent}${this.children.map((c) => c.outerHTML).join("")}</${this.tag}>`;
  }
}
const doc = { createElement: (tag) => new El(tag) };

function liveMsg() {
  const thinkTitle = new El("span", ["think-title"]); thinkTitle.textContent = "思考中";
  const think = new El("div", ["think-card", "streaming"], {}, [new El("div", ["think-head"], {}, [thinkTitle])]);
  const doneRes = new El("span", ["atc-result", "atc-result--ok"]); doneRes.textContent = "已读取";
  const doneStep = new El("div", ["agent-tool-step"], {}, [doneRes]);
  const runRes = new El("span", ["atc-result"], {}, [new El("span", ["atc-spin"])]);
  const runStep = new El("div", ["agent-tool-step", "is-running"], {}, [runRes]);
  const stats = new El("div", ["turn-stats", "turn-stats--live"]);
  const acts = new El("div", ["msg__acts", "is-pending"]);
  const body = new El("div", ["msg__body"], {}, [think, doneStep, runStep, new El("div", ["thinking"]), new El("span", ["stream-cursor"]), new El("div", ["next-steps"]), new El("div", [], { "data-transient": "1" })]);
  const main = new El("div", ["msg__main"], {}, [body, stats, acts]);
  return new El("div", ["msg", "assistant"], {}, [main]);
}

test("定格：瞬时 UI 去掉，思考卡收成已思考，跑一半的工具卡标成中断，操作条出场", () => {
  const msg = settleLiveClone(liveMsg());
  assert.equal(msg.querySelectorAll(".thinking, .stream-cursor, .next-steps, [data-transient]").length, 0, "占位 / 光标 / 临时 chips 不许进快照");
  const think = msg.querySelector(".think-card");
  assert.ok(think && !think.classList.contains("streaming"), "思考卡不能还在 streaming（光标会永远闪）");
  assert.equal(think.querySelector(".think-title").textContent, "已思考");
  const steps = msg.querySelectorAll(".agent-tool-step");
  assert.equal(steps.length, 2, "做完的和跑一半的工具卡一张都不少");
  assert.equal(steps[0].querySelector(".atc-result").textContent, "已读取", "做完的卡原样保留");
  assert.ok(steps[1].classList.contains("is-interrupted") && !steps[1].classList.contains("is-running"));
  assert.equal(steps[1].querySelector(".atc-result").textContent, "中断", "跑一半的卡要定格成状态，不能让圈永远转");
  assert.ok(!msg.querySelector(".turn-stats").classList.contains("turn-stats--live"));
  assert.ok(!msg.querySelector(".msg__acts").classList.contains("is-pending"), "复制 / 反馈按钮得能用");
});

test("liveMessageHtml：克隆后序列化，原节点不动；超上限就放弃", () => {
  const live = liveMsg();
  const html = liveMessageHtml(live);
  assert.match(html, /已思考/); assert.match(html, /is-interrupted/);
  assert.ok(live.querySelector(".think-card").classList.contains("streaming"), "拍快照不许动正在流的真节点");
  assert.ok(live.querySelector(".thinking"), "真节点上的占位不能被拍快照顺手删掉");
  assert.equal(liveMessageHtml(live, 10), "", "超过上限返回空串，恢复退到文字那条路");
  assert.equal(liveMessageHtml(null), ""); assert.equal(liveMessageHtml({}), "");
  assert.ok(LIVE_HTML_MAX_CHARS >= 1_000_000);
});

test("恢复时挂状态行：在操作条之前、只挂一次、不是正文", () => {
  const msg = markRecoveredMessage(liveMsg(), { document: doc });
  assert.ok(msg.classList.contains("is-interrupted"));
  const main = msg.querySelector(".msg__main");
  const idx = (cls) => main.children.findIndex((c) => c.classList.contains(cls));
  assert.ok(idx("msg__interrupted") >= 0 && idx("msg__interrupted") < idx("msg__acts"), "状态行要在操作条上面");
  assert.match(main.querySelector(".msg__interrupted").textContent, /重启/);
  assert.equal(main.querySelector(".msg__interrupted").attrs.role, "status");
  markRecoveredMessage(msg, { document: doc });
  assert.equal(msg.querySelectorAll(".msg__interrupted").length, 1, "重复调用不许叠两行");
  assert.equal(msg.querySelector(".msg__body").querySelectorAll(".msg__interrupted").length, 0, "状态不进正文区");
  assert.equal(markRecoveredMessage(null, { document: doc }), null);
});

test("没有 HTML 快照时的思考默认展开：只有正文为空且有思考时才展开", () => {
  assert.equal(recoveredThinkingOpen({ hasText: false, hasReason: true }), true);
  assert.equal(recoveredThinkingOpen({ hasText: true, hasReason: true }), false);
  assert.equal(recoveredThinkingOpen({ hasText: false, hasReason: false }), false);
});

// ── 超预算不许整份丢：所有者「软件只要被关闭之前的内容就都不显示了」的落点 ─────────────
//
// 原来是「太大就返回 ""」，于是**专挑最该保住的那些丢**：一轮里只要有一张截图（data URL 的
// base64 几百 KB 到几 MB）或几个大文件预览，快照当场超限、静默变空，恢复退回那份
// 「这一轮执行过的步骤（N 步）」清单。现在按代价从小到大瘦身。

/** 造一张带 N 字节 data URL 的截图卡（就是压垮快照的那个东西）。 */
function shotCard(bytes) {
  const img = new El("img", ["atc-shot", "atc-shot--full"], { src: "data:image/png;base64," + "A".repeat(bytes) });
  const vp = new El("div", ["atc-viewport"], {}, [img]);
  const res = new El("span", ["atc-result", "atc-result--ok"]); res.textContent = "已截图";
  return new El("div", ["agent-tool-step"], {}, [res, vp]);
}
/** 造一张展开区里塞了 N 个字的读取卡。 */
function readCard(chars) {
  const pre = new El("pre", ["tc-pre"]); pre.textContent = "x".repeat(chars);
  const vp = new El("div", ["atc-viewport"], {}, [pre]);
  const res = new El("span", ["atc-result", "atc-result--ok"]); res.textContent = "已读取";
  return new El("div", ["agent-tool-step"], {}, [res, vp]);
}
function msgWith(...cards) {
  const body = new El("div", ["msg__body"], {}, cards);
  return new El("div", ["msg", "assistant"], {}, [new El("div", ["msg__main"], {}, [body])]);
}

test("一张大截图不该让整份快照变成空——图换成占位，卡片和结果原样留着", () => {
  const msg = msgWith(shotCard(400_000));
  const cap = 100_000;
  assert.equal(msg.outerHTML.length > cap, true, "前提：这条消息确实超预算");
  const html = liveMessageHtml(msg, cap);
  assert.notEqual(html, "", "超预算就整份丢＝恢复退回步骤清单，正是所有者报的那个症状");
  assert.ok(html.length <= cap);
  assert.match(html, /agent-tool-step/, "工具卡不能跟着图一起没了");
  assert.match(html, /已截图/, "卡片上的结果要留着");
  assert.match(html, /data-shed="media"/, "被换掉的图要标出来");
  assert.doesNotMatch(html, /AAAAAAAAAA/, "几百 KB 的 base64 不该还在里面");
  assert.match(html, /svg/, "占位图本身要在，位置和说明都还在");
});

test("图换完还超，就从最大的展开区开始收；卡头一律保留，小的那些不动", () => {
  const msg = msgWith(readCard(80_000), readCard(2_000), shotCard(120_000));
  const cap = 20_000;
  const html = liveMessageHtml(msg, cap);
  assert.notEqual(html, "");
  assert.ok(html.length <= cap);
  assert.equal((html.match(/agent-tool-step/g) || []).length, 3, "三张卡一张都不能少");
  assert.match(html, /已读取/);
  assert.match(html, /重启后没有保留/, "被收掉的展开区要说清楚它去哪了");
  assert.match(html, /xx/, "小的那份展开区不该被顺手收掉");
});

test("没超预算时一个字都不动——正常那条路的保真度不受影响", () => {
  const msg = msgWith(shotCard(100), readCard(50));
  const html = liveMessageHtml(msg, LIVE_HTML_MAX_CHARS);
  assert.doesNotMatch(html, /data-shed/, "没超就不该瘦身");
  assert.match(html, /data:image\/png;base64,A{100}/, "小图原样保留");
});

test("两级都做完还超（重量在正文本身）才返回空——那份正文走文字那条老路照样恢复", () => {
  const body = new El("div", ["msg__body"]); body.textContent = "字".repeat(50_000);
  const msg = new El("div", ["msg", "assistant"], {}, [new El("div", ["msg__main"], {}, [body])]);
  assert.equal(liveMessageHtml(msg, 1_000), "");
});

test("瘦身两级各自是纯函数，单独也能验", () => {
  const msg = msgWith(shotCard(50_000));
  assert.equal(shedInlineMedia(msg), 1, "认得出 img 上的大 data URL");
  assert.equal(shedInlineMedia(msg), 0, "换过一次就不该再算一次");
  const big = msgWith(readCard(30_000));
  assert.equal(shedLargestBlocks(big, 1_000), 1);
  assert.equal(shedLargestBlocks(msgWith(readCard(10)), 1_000_000), 0, "没超预算就一个都不收");
});
