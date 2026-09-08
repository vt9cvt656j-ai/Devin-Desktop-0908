// 账单面板（2026-09-07 重做：所有者「太丑了，没有 cursor / windsurf 那种大厂风格」）。
//
// 能在 Node 里跑的一律真跑：日期序列、按模型、柱高、数字不许被自动翻译；
// 只有「主循环有没有接上」「CSS 有没有退回硬编码色」这类用源码守调用点。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  COST_UNIT_EPOCH, utcDay, addDays, fillDays, dailySeries, modelRows, barHeights, shortDay, escapeHtml, paymentSource,
} from "../src/ui/billing-panel.js";
import { CODE, SRC } from "./helpers/source.mjs";
import { looseUiTextEligible as eligible } from "../src/i18n.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf8");
const PANEL = read("../src/ui/billing-panel.js");
const CSS = read("../src/styles/app.css");
const I18N = read("../src/i18n.js");
const MODELS_RS = read("../../server/src/models.rs");

const day = (d) => `2026-09-${String(d).padStart(2, "0")}`;
const at = (d, h = 12) => `2026-09-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const NOW = Date.parse(at(7, 23));

test("日期是按 UTC 切的字符串运算，不受本地时区影响", () => {
  assert.equal(utcDay("2026-09-07T23:30:00Z"), "2026-09-07");
  assert.equal(utcDay(new Date(Date.UTC(2026, 8, 1))), "2026-09-01");
  assert.equal(utcDay("不是时间"), "");
  assert.equal(addDays("2026-09-07", -6), "2026-09-01");
  assert.equal(addDays("2026-08-31", 1), "2026-09-01", "跨月");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01", "2026 不是闰年");
});

test("没有调用的那天要在图上占一格 —— 否则「三天没用」和「三天连着用」长得一样", () => {
  const pts = fillDays([{ day: day(1), cost_cents: 100, calls: 2 }, { day: day(3), cost_cents: 50, calls: 1 }], day(1), day(4));
  assert.deepEqual(pts.map((p) => p.day), [day(1), day(2), day(3), day(4)]);
  assert.deepEqual(pts.map((p) => p.cents), [100, 0, 50, 0]);
  assert.deepEqual(pts.map((p) => p.calls), [2, 0, 1, 0]);
  // 同一天来两条要相加，不是后一条盖掉前一条
  const dup = fillDays([{ day: day(1), cost_cents: 10, calls: 1 }, { day: day(1), cost_cents: 5, calls: 2 }], day(1), day(1));
  assert.deepEqual(dup, [{ day: day(1), cents: 15, calls: 3 }]);
  // 起止算反 / 时钟漂了也不能死循环
  assert.ok(fillDays([], "2020-01-01", "2030-01-01").length <= 400, "没有上限，界面会卡死");
  assert.equal(fillDays([{ day: "", cost_cents: 9 }], day(1), day(1))[0].cents, 0, "没有日期的点要丢掉");
});

test("每日消费优先用网关聚合；窗口起点不早于单位分水岭", () => {
  const data = {
    window_from: "2026-09-05T00:00:00Z",
    daily: [{ day: day(5), cost_cents: 300, calls: 9 }, { day: day(7), cost_cents: 100, calls: 4 }],
  };
  const s = dailySeries(data, { now: NOW, days: 30 });
  assert.equal(s.source, "server");
  assert.equal(s.from, day(5), "网关下发的窗口起点比 30 天窗口晚，要听网关的");
  assert.equal(s.to, day(7));
  assert.deepEqual(s.points.map((p) => p.cents), [300, 0, 100]);
  // 网关没下发窗口时用客户端那份分水岭兜底，仍然不会画到它之前
  const noWindow = dailySeries({ daily: [{ day: "2026-08-01", cost_cents: 999, calls: 1 }] }, { now: NOW, days: 365 });
  assert.equal(noWindow.from, COST_UNIT_EPOCH);
  assert.ok(!noWindow.points.some((p) => p.day < COST_UNIT_EPOCH), "画到了分水岭之前，那段的单位是另一种");
});

test("老网关没有聚合时回落到明细，并且**说明自己是回落**", () => {
  const recent = [
    { time: at(7, 3), cost_cents: 40, model: "a" },
    { time: at(6, 3), cost_cents: 60, model: "a" },
    { time: at(6, 9), cost_cents: 10, model: "b" },
  ];
  const s = dailySeries({ recent, window_from: "2026-09-01T00:00:00Z" }, { now: NOW });
  assert.equal(s.source, "recent", "界面靠这一位决定要不要写「按最近 200 条明细统计」");
  assert.equal(s.from, day(6), "回落时从明细里最早那天起画，不假装有更早的数据");
  assert.deepEqual(s.points.map((p) => p.cents), [70, 40]);
  assert.deepEqual(s.points.map((p) => p.calls), [2, 1]);
  // 分水岭之前的明细一条都不许进图
  const old = dailySeries({ recent: [{ time: "2026-08-01T00:00:00Z", cost_cents: 9999 }] }, { now: NOW });
  assert.deepEqual(old.points.map((p) => p.cents).filter(Boolean), [], "旧单位的行被画进来了");
});

test("按模型：前 8 名之外的钱并成「其他」，一分都不许静默抹掉", () => {
  const data = {
    window_cost_cents: 1000,
    by_model: [{ model: "x", cost_cents: 600, calls: 3 }, { model: "y", cost_cents: 300, calls: 2 }],
  };
  const rows = modelRows(data);
  assert.deepEqual(rows.map((r) => r.model), ["x", "y", "其他"]);
  assert.equal(rows[2].cents, 100, "1000 − 600 − 300 = 100 要有人认领");
  assert.ok(Math.abs(rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9, "占比之和不是 1");
  assert.equal(rows[0].share, 0.6);
  // 正好凑满就别多一行灰字
  assert.equal(modelRows({ window_cost_cents: 900, by_model: data.by_model }).length, 2);
  // 老网关：从明细自己数，同样只取前 8
  const recent = Array.from({ length: 12 }, (_, i) => ({ time: at(7), cost_cents: 12 - i, model: `m${i}` }));
  const fallback = modelRows({ recent, window_from: "2026-09-01T00:00:00Z" });
  assert.equal(fallback.length, 8, "回落也要封顶 8 行");
  assert.equal(fallback[0].model, "m0", "按花的钱排序");
  assert.equal(modelRows({}).length, 0, "什么都没有时不要凭空造行");
});

test("柱高：峰值满格，非零的一天至少看得见，零就是零", () => {
  const h = barHeights([{ cents: 0 }, { cents: 1 }, { cents: 50 }, { cents: 100 }]);
  assert.equal(h[0], 0, "没有调用的那天不该有柱子（样式另给一根 2px 底座）");
  assert.ok(h[1] >= 4, `花了一分钱的一天高 ${h[1]}%，看不见等于没画`);
  assert.equal(h[2], 50);
  assert.equal(h[3], 100);
  assert.deepEqual(barHeights([{ cents: 0 }, { cents: 0 }]), [0, 0], "全零不许除零");
  assert.equal(shortDay("2026-09-07"), "09/07");
});

test("拼 HTML 的地方都过转义，模型名不能变成标签", () => {
  assert.equal(escapeHtml('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
  // 服务端给的字符串（模型名、报错正文）只有三条路能进 innerHTML，每一条都必须包一层。
  // 这里不扫「所有插值」——数字、我们自己算出的 class 名不需要转义，扫全部只会逼着
  // 后来的人给安全的地方也套一层，那是噪音不是防线。
  for (const [what, re] of [
    ["明细里的模型名", /escapeHtml\(String\(r\?\.model \|\| "—"\)\)/g],
    ["按模型那一行", /escapeHtml\(name\)/g],
    ["柱子的悬停文字", /title="\$\{escapeHtml\(tip\)\}"/g],
    ["取数失败的报错正文", /escapeHtml\(String\(err\?\.message \|\| err\)\)/g],
  ]) {
    assert.ok((PANEL.match(re) || []).length >= 1, `${what}没过 escapeHtml —— 服务端数据直通 innerHTML`);
  }
  assert.equal((PANEL.match(/escapeHtml\(String\(r\?\.model \|\| "—"\)\)/g) || []).length, 2,
    "模型名在 title 和正文各出现一次，两处都要转义");
  // 套餐名走 textContent，不进 innerHTML —— 这条一破就是又一个注入口。
  assert.match(PANEL, /chip\.textContent = plan/, "套餐名改成拼 HTML 了");
});

test("客户端和网关的单位分水岭必须是同一天", () => {
  const server = /COST_UNIT_EPOCH: &str = "(\d{4}-\d{2}-\d{2})/.exec(MODELS_RS);
  assert.ok(server, "网关那边的分水岭常量改名了，这条对账要跟着改");
  assert.equal(COST_UNIT_EPOCH, server[1],
    "两处写了不同的日期 —— 网关按自己那天聚合，客户端兜底按另一天，图会缺一段或多一段");
  // 网关必须真的把这三样发下来，否则客户端永远走回落那条路而没人发现
  for (const field of ['"window_from"', '"window_cost_cents"', '"window_calls"', '"daily"', '"by_model"']) {
    assert.ok(MODELS_RS.includes(field), `/api/usage 少了 ${field}`);
  }
  // SUM() 回 numeric 不回 bigint：不显式转，Rust 按 i64 接会运行期 500（编译期查不出）
  const handler = MODELS_RS.split("pub async fn user_usage")[1].split("\npub ")[0];
  const sums = handler.match(/SUM\([a-z_]+\)/g) || [];
  assert.ok(sums.length >= 4, `只找到 ${sums.length} 处 SUM，锚点多半漂了`);
  assert.equal((handler.match(/COALESCE\(SUM\([a-z_]+\),0\)::bigint/g) || []).length, sums.length,
    "有 SUM() 没显式 ::bigint —— 空表测不出来，线上直接 500");
  assert.ok(/COUNT\(\*\)::bigint/.test(handler), "COUNT(*) 同样要转");
});

test("带单位的数字不许被自动翻译成「1.8千」", () => {
  // 实拍：账单表格同一列里 "2.0k" 和 "1.8千" 并排 —— "1.8k" 因为那个 k 是字母，
  // 通过了「必须含字母」那道闸，被当成一句话送去翻译。这里跑的是真函数（i18n.js 直接导出的）。
  for (const s of ["1.8k", "2.0k", "27.5k", "56.8k", "1.4M", "120ms", "16px", "$0.005", "58%", "3.9 k"]) {
    assert.equal(eligible(s), false, `「${s}」是带单位的数字，不该送去翻译`);
  }
  // 真正的文案一个都不许误伤
  for (const s of ["No activity yet", "Daily spend", "3 files changed", "Retry in 5 seconds"]) {
    assert.equal(eligible(s), true, `「${s}」是文案，被误判成数字了`);
  }
  // 标准的「别翻这块」属性要被认：组件靠它给数字列免疫
  assert.ok(I18N.includes(`'[translate="no"]'`), "AUTO_I18N_SKIP_SELECTOR 里没有 [translate=\"no\"]");
  assert.ok(/translate="no"/.test(PANEL), "面板里的数字没有标 translate=\"no\"");
});

test("明细一列一种钱：免费池付的行也印钱，谁付的用标签说", () => {
  // 所有者实拍 2026-09-07：「22.462 点」挨着「$0.012」，读成免费点扣了两千倍。
  // 其实 1 点 = ¥0.01 = 1 计费分，22.462 点 = ¥0.22，和旁边同量级——单位混排才是那个「严重有问题」。
  const free = paymentSource({ free_points_spent: 6.238, cost_cents: 7 });
  assert.equal(free.kind, "free", "池子付满（计费分向上取整差半分以内）= 免费点");
  const mixed = paymentSource({ free_points_spent: 22.462, cost_cents: 44 });
  assert.equal(mixed.kind, "mixed", "池子只付了一半、剩下记进额度 = 免费点+额度");
  assert.match(mixed.title, /22\.462/, "点数放进悬停，不占那一列");
  assert.equal(paymentSource({ free_points_spent: 0, cost_cents: 8 }).kind, "paid");
  assert.equal(paymentSource({}).kind, "paid");
  // 渲染：费用列永远走 fmtUsd(cost_cents)，不再按 pts 分叉印「点」
  assert.doesNotMatch(PANEL, /pts > 0 \? `\$\{Math\.round\(pts \* 1000\) \/ 1000\} \$\{T\("billing\.points"/, "费用列又按点分叉了");
  assert.match(PANEL, /const cost = fmtUsd\(Number\(r\?\.cost_cents\) \|\| 0\);/, "费用列没有统一成钱");
  assert.match(PANEL, /bill__src bill__src--\$\{src\.kind\}/, "支付来源标签没画");
});

test("三种语言的账单文案齐全", () => {
  const keys = [...PANEL.matchAll(/T\("([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15, `只扫到 ${keys.length} 个文案 key，取法多半坏了`);
  for (const key of new Set(keys)) {
    const hits = (I18N.match(new RegExp(`"${key.replace(".", "\\.")}":`, "g")) || []).length;
    assert.ok(hits >= 3, `「${key}」只在 ${hits} 种语言里有，EN / ZH / JA 三份都要`);
  }
});

test("主循环只剩接线，钱怎么换算、图标从哪来都是注入的", () => {
  assert.match(CODE, /import \{ openBillingPanel as _openBillingPanel \} from "\.\/ui\/billing-panel\.js";/);
  const fn = CODE.slice(CODE.indexOf("async function _showBillingPanel()"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(body.length < 1200, `接线函数 ${body.length} 字符，正文又搬回 main.js 了`);
  for (const dep of ["fmtUsd:", "tokenShort:", "icon:", "fetchUsage:", "locale:"]) {
    assert.ok(body.includes(dep), `没注入 ${dep}`);
  }
  assert.match(body, /_dbIcon\(kind\)/, "图标要从 db-icons（lucide 烤出的那份）来，别手画 SVG");
  assert.match(body, /"\/api\/usage"/);
  // 老那版一个字都不许留下：留着就是两套样式共存，下一个人不知道该改哪份
  assert.ok(!CODE.includes("billing-dialog"), "main.js 里还有旧面板的残骸");
  assert.ok(!CSS.includes("billing-dialog"), "app.css 里还有旧面板的样式");
  assert.ok(!SRC.includes("billing-dialog__table"), "旧表格样式还在");
});

test("面板一律用应用自己的 token，不许再出现 Material 那套硬编码色", () => {
  const at = CSS.indexOf("/* ── 账单面板");
  assert.ok(at > 0, "账单样式块的锚点没了");
  // 切到下一个**顶层**分区注释为止：块内部自己也有注释，按 "\n/* " 切会在第一条内部注释处
  // 就断掉（实测只切出 720 字符，下面几条断言于是全部落在空气上——恒真守卫的第一种形状）。
  const block = CSS.slice(at, CSS.indexOf("\n/* ---- titlebar menu bar", at));
  assert.ok(block.length > 3000, `只切出 ${block.length} 字符，切法坏了`);
  assert.ok(block.includes(".bill__pgi"), "切出来的块没到样式末尾");
  // 上一版那几个 Google 色是这次要修的东西本身
  for (const hex of ["#1a73e8", "#202124", "#5f6368", "#f8f9fa", "#e8eaed", "#dadce0", "#d93025", "#f1f3f4"]) {
    assert.ok(!block.includes(hex), `又硬编码了 ${hex}，深色模式会当场穿帮`);
  }
  const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexes, [], `账单样式里不该有任何写死的颜色：${hexes.join(" ")}`);
  for (const token of ["var(--popover-surface)", "var(--text)", "var(--text-dim)", "var(--line)", "var(--scrim)", "var(--shadow)", "var(--hover)"]) {
    assert.ok(block.includes(token), `没用 ${token}`);
  }
  // 数字列不对齐的话，多贵的设计都白搭
  assert.ok((block.match(/font-variant-numeric: tabular-nums/g) || []).length >= 5, "数字没走等宽数字");
  // dialog 只在打开时 flex：无条件写 display 会盖掉 UA 的 dialog:not([open]){display:none}
  assert.ok(block.includes(".bill[open] { display: flex;"), "display 没挂在 [open] 上，关着的对话框会显示出来");
  // 深色不再需要第二套规则 —— 有的话说明又开始硬编码了
  assert.ok(!/\[data-theme="dark"\][^\n]*\.bill\b/.test(CSS), "又给账单面板写了一套深色覆盖，说明颜色没走 token");
});
