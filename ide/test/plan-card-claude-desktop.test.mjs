// 任务计划卡的样式照 Claude 桌面端。参照不是猜的：从它本地 Code Cache 的字符串表里抠出来的类名——
//   清单容器 .epitaxy-card-outline = box-shadow: 0 0 0 1px var(--cds-border)（文字色淡透明的一圈），列表 flex-col；
//   行 flex items-start gap-g3 decoration-1，[data-done] 的行 line-through + text-[var(--t5)]；
//   图标格 shrink-0 size-[16px] mt-[1px]；未完成 size-[12px] rounded-full border-alpha-3；完成 <Icon Check size=sm text-primary>，
//   勾的路径 M3 8.5 L6.5 12 L13 4.5（ion-dist 内置 UI 的渲染函数 Ru，逐字抄的）。
// 所有者原话：「这个 ui 框要做出来，包括 ui 和 claude desktop 要一样」。之前两版（卡片壳+进度条 /
// 竖时间线）被否，这一版的框是参照里真有的那张描边卡，不是装饰。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fnSource } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/styles/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const block = (sel) => { const i = CSS.indexOf("\n" + sel + " {"); assert.ok(i > 0, sel + " 没了"); return CSS.slice(i, CSS.indexOf("}", i)); };

test("清单装在描边卡里：一圈淡透明的 box-shadow 环，没有实线、底色和阴影", () => {
  const list = block(".agent-plan__list");
  assert.match(list, /box-shadow:\s*0 0 0 1px color-mix\(in srgb, var\(--text\) \d+%, transparent\)/, "描边环没了——Claude 的 epitaxy-card-outline 就是这一圈");
  assert.match(list, /border:\s*0/, "别再用实线 border，参照是透明色环");
  assert.match(list, /border-radius:\s*\d+px/);
  assert.ok(!/background/.test(list) && !/box-shadow:\s*0 \d+px/.test(list), "卡片壳（底色/投影）那一版被否过，别长回来");
  assert.match(list, /flex-direction:\s*column/);
});

test("记号逐字照 Claude：完成=细勾无圆底+1px 删除线压暗；未完成=12px 淡透明空心圆；进行中=同环换正文色", () => {
  const icon = fnSource("_planStepIcon", { code: true });
  assert.ok(!/atc-spin/.test(icon), "进行中又用回 IDE 的转圈——被否过");
  assert.match(icon, /d="M3 8\.5L6\.5 12 13 4\.5"/, "勾的路径必须是 Claude 那份 M3 8.5 L6.5 12 L13 4.5");
  assert.ok(!/<circle[^>]*fill="currentColor"/.test(icon), "勾底下不许有实心圆（那版被否：「好丑」）");
  assert.ok(!/agent-plan__dot\b/.test(icon), "6px 小点那版被否了，别长回来");
  assert.match(icon, /agent-plan__box--todo"><span class="agent-plan__ring"><\/span>/, "未完成是 12px 空心圆环");
  assert.match(icon, /agent-plan__box--active"><span class="agent-plan__ring"><\/span>/, "进行中是同一只圆环");
  const ring = block(".agent-plan__ring");
  assert.match(ring, /width:\s*12px;\s*height:\s*12px;\s*border-radius:\s*50%/, "圆环 12px（Claude：size-[12px] rounded-full）");
  assert.match(ring, /border:\s*1px solid color-mix\(in srgb, var\(--text\) \d+%, transparent\)/, "描边要是文字色的淡透明（Claude：border-alpha-3）");
  assert.match(block(".agent-plan__box--active .agent-plan__ring"), /border-color:\s*var\(--text\)/, "进行中的环换成正文色");
  assert.match(block(".agent-plan__box--done"), /color:\s*var\(--text\)/, "勾是正文色（Claude：text-primary），行文字才是压暗的");
  const done = block(".agent-plan__row--done .agent-plan__txt");
  assert.match(done, /line-through/); assert.match(done, /text-decoration-thickness:\s*1px/, "删除线 1px（Claude：decoration-1）");
  const box = block(".agent-plan__box");
  assert.match(box, /width:\s*16px;\s*height:\s*16px;\s*margin-top:\s*1px/, "图标格 16px、比首行低 1px（Claude：size-[16px] mt-[1px]）");
  assert.ok(!/font-weight:\s*[67]00/.test(block(".agent-plan__row--active")), "进行中不靠加粗强调");
});
