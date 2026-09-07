// 崩溃 / 重启恢复：把在途消息按「关闭前那一刻」定格（src/agent/draft-recovery.js）。
// 用户原话「关闭前啥样，他就要啥样」：思考卡、工具卡、正文段都要原样回来，横幅一句都不要。
// 这里用一个几十行的假 DOM 跑真行为（仓库没有 jsdom）：只实现模块用到的那几个查询。
import test from "node:test";
import assert from "node:assert/strict";
import { settleLiveClone, liveMessageHtml, markRecoveredMessage, recoveredThinkingOpen, LIVE_HTML_MAX_CHARS } from "../src/agent/draft-recovery.js";

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
  matches(sel) {
    return sel.split(",").map((s) => s.trim()).some((simple) => {
      if (/^\[(.+)\]$/.test(simple)) return this.attrs[RegExp.$1] != null;
      return simple.split(".").filter(Boolean).every((c) => this._cls.has(c));
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
  get outerHTML() { return `<${this.tag} class="${this.className}">${this.textContent}${this.children.map((c) => c.outerHTML).join("")}</${this.tag}>`; }
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
