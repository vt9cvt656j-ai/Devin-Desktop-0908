// 会话第一发必然带着不完整的画像出门——那道等待窗口 6 秒，而完整裁决实测健康时
// 6.9~7.6 秒、拥堵时 19.8 秒，快通道首响应头 8~18 秒：**两条腿都赢不了它**。
//
// 但执行事实那条腿不用等任何模型：它算的是这一刻磁盘上确实有什么，纯本地同步计算。
// 把它并进第一发，就少一次整条对话的前缀缓存作废（本仓库另有实测：这类抖动把
// 120k token 请求的缓存命中率打到 2%）。
//
// 另一半：73 个维度里有 12 个零读者，占着提示词的键名清单，也占着模型每一轮必须判定
// 的面——而那正是「产不出大 JSON」的直接成因（同模型实测：40 条判定项 → 正文 0 字；
// 20 条 → 完整产出。卡的是输入规模，不是预算）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE as SRC, loadConst, fnSource as topLevelFn } from "./helpers/source.mjs";

const DIMS = loadConst("_AI_INTENT_DIMENSIONS");

// ── 一、执行事实并进第一发 ────────────────────────────────────────────
const send = topLevelFn("sendPrompt", { code: true });

test("第一发的画像后面紧跟着执行事实那条腿", () => {
  const at = send.indexOf("config.ideSemanticProfile = _sessionStableSemanticProfile(sess, _semanticProfileHeaderFor");
  assert.ok(at > 0, "第一发写画像那一行不见了");
  const after = send.slice(at, at + 1600);
  assert.match(after, /_executionFactSemanticFlags\(/,
    "执行事实还是只在循环边界跑——第一发仍然带空画像出门");
  assert.match(after, /_sessionStableSemanticProfile\(sess, _ideSemanticProfile\(_factFlags\)\)/,
    "算出来了却没并进请求头");
});

test("零事实时一个字都不发（不许凭空造旗标）", () => {
  const at = send.indexOf("_executionFactSemanticFlags(");
  const seg = send.slice(at, at + 400);
  assert.match(seg, /if \(Object\.keys\(_factFlags\)\.length\)/,
    "没有事实也去写请求头——那会把空画像写成一次真实的旗标变化，白白作废一次前缀缓存");
});

test("用的是本地同步计算，不引入任何等待", () => {
  const at = send.indexOf("_executionFactSemanticFlags(");
  const seg = send.slice(at - 200, at + 400);
  assert.doesNotMatch(seg, /await /, "这条腿加了 await——它的全部价值就是零延迟");
});

test("扫描失败不能把发送路径带崩", () => {
  const at = send.indexOf("_executionFactSemanticFlags(");
  const seg = send.slice(Math.max(0, at - 300), at + 500);
  assert.match(seg, /try \{/, "没有兜住异常");
  assert.match(seg, /catch \{\}/, "没有兜住异常");
});

test("第一发这条腿不许把写盘台账当输入（那时还没写过盘）", () => {
  // run 还不存在。传一个假的 _writeLedger 会凭空点亮 implementation——那是猜，不是事实。
  const at = send.indexOf("_executionFactSemanticFlags(");
  const seg = send.slice(at, at + 200);
  assert.match(seg, /_writeLedger: null/,
    "第一发就带上了写盘台账——这一刻还没有任何写入发生过");
});

test("分界没动，动的是时效", () => {
  // 原来这里钉的是 `hasWorkspace && snapshotReady && topLevel.length` 三条与，注释写着
  // 「一个字没放宽」。改成「目录快照 **或** 已识别技术栈」是刻意的，理由是实测：
  // 目录快照挂在 _agentContextCache 上，带 5 分钟 TTL，而这条腿存在的全部理由就是
  // **会话第一发**——那一刻它必然是冷的。线上 2026-08-23 六小时 383 次装配，整条腿
  // 只点亮 7 次（1.8%），其余全输给这道 TTL。
  //
  // 要守的分界一个字没变，而且是被**更强**的证据守住的：空目录既没有 topLevel，
  // 也扫不出技术栈（_projectStacks 在没有栈事实时会显式 delete 掉这个根）。
  const body = topLevelFn("_executionFactSemanticFlags", { code: true });
  assert.match(body, /evidence\.snapshotReady && \(evidence\.topLevel \|\| \[\]\)\.length\) \|\| stackKnown/,
    "「目录快照 或 已识别技术栈」这道判据不见了");
  assert.match(body, /evidence\?\.hasWorkspace/, "hasWorkspace 这道前置闸没了——会凭空给无工作区的会话造旗标");
  // engineering 只在**模型缺席**时由事实腿补。补成无条件就等于盖掉模型判的「这不是工程活」。
  assert.match(body, /opts\?\.modelProfileMissing && evidence\?\.hasWorkspace\) facts\.projectEngineering/,
    "事实腿点 engineering 时不再看「模型画像到没到」——那会盖掉模型自己的判断");
});

test("第一发把「模型画像到没到」当条件传进事实腿", () => {
  // 不传这个条件，engineering 就只剩模型裁决一个来源。线上实测：免费线被上游限流 159 次、
  // 83% 的装配画像全空，于是 13KB 架构纪律和 4.3MB 专业语料**同时**够不着模型
  // （网关那边 engineering_intent 一面旗门着这两样）。
  // 2026-09-08：条件从 `!_routeSource` 换成 `!_routeJudged`。**这条测试此前是恒绿的**：
  // `_routeSource` 的兜底项是本地证据对象，永远 truthy，所以 `!_routeSource` 恒假——
  // 这里断言的那条兜底一次都没触发过，而断言只看字面量在不在，看不出这一点。
  // 现在钉的是单独算的 `_routeJudged`，它只认「完整裁决落定」和「快通道落定」。
  const at = send.indexOf("_executionFactSemanticFlags(");
  const seg = send.slice(at, at + 240);
  assert.match(seg, /modelProfileMissing: !_routeJudged/,
    "没把「这一轮两条腿都没回」传下去——分类器一挂，engineering 就永远补不上");
  // 并且这个条件必须真的可能为真：拿本地证据兜底的表达式恒真，等于这条兜底是死的。
  assert.ok(!/const _routeJudged = [^\n]*\|\| _turnEngineeringResolved\b/.test(send),
    "_routeJudged 又挂了本地证据兜底——那样它恒真，这条兜底重新变死");
});

// ── 二、删掉零读者维度 ────────────────────────────────────────────────
const DEAD = ["paletteHarmonyRequired", "cardLayoutRequired", "cardStylingRequired",
  "semanticIconRequired", "gitHistory", "gitLocalMutation", "gitReviewMutation",
  "nativeHtmlRequested", "darkThemeRequested", "gradientThemeRequested",
  "monochromeThemeRequested", "categoryProductSurface",
  // 第二批：只写不读的那三个。判据要看**读**，不是看出现次数——
  // databaseDecisionRequired 唯一的「读」在同一句赋值的右边（自引用），上一轮漏了。
  "gitReadOnly", "existingUiStackSignal", "databaseDecisionRequired",
  // 新加的那条「只写不读」守卫当场又抓出一个：它写进的 referenceWebsiteRequired
  // 才是真有读者的那个，它自己没有。
  "referenceWebsiteRequested"];

test("12 个零读者维度已从模型必判清单里删掉", () => {
  const back = DEAD.filter((k) => DIMS.includes(k));
  assert.deepEqual(back, [],
    `这些维度又回来了：${back.join(",")}——它们没有任何读者，只占着模型每一轮的判定面`);
});

test("它们确实没有读者（这是删它们的全部理由）", () => {
  for (const k of DEAD) {
    const hits = (SRC.match(new RegExp(`\\b${k}\\b`, "g")) || []).length;
    assert.equal(hits, 0, `${k} 在源码里还有 ${hits} 处——删早了，先接上读者`);
  }
});

test("有读者的维度一个都没被误删", () => {
  // 反向断言。只断言"那 12 个没了"是绿的摆设——把整张表删空它也绿。
  // 只列**确实在维度表里**的（projectEngineering / substantial / existingProject 是派生
  // 字段，不在这张表里——照抄一份没核过的名单，反向断言就成了自己红自己）。
  for (const k of ["implementation", "ui", "uiProject", "git", "debugProject",
    "securityRisk", "fullWebsite", "database", "businessLogic", "needsOfficialResearch"]) {
    assert.ok(DIMS.includes(k), `${k} 被误删了——它有真实读者`);
  }
  // 精确对数，不用下限。下限是绿的摆设：把维度表删掉 5 个它照样过（2026-08-23 变异实测）。
  // 这个数变了要**刻意**改这里并说明为什么——和本仓库钉开局工具窗口大小同款。
  // 2026-08-23 再删 3 个：gitReadOnly（连定义之外一次都没出现）、existingUiStackSignal
  // 与 databaseDecisionRequired（**只写不读**——后者那个「读」是同一句赋值右边的自引用，
  // 上一轮的判据把它当成了真读者，所以漏掉了）。加了「只写不读」守卫之后当场又抓出
  // referenceWebsiteRequested，一并删。61 → 57。
  assert.equal(DIMS.length, 57,
    `维度数变成 ${DIMS.length} 了。加维度＝模型每轮多一项必判，删维度＝可能删掉有读者的；`
    + "两种都该在这里留下痕迹");
});

test("键名清单确实变短了（这是收益本身）", () => {
  // 模型每一轮都要读这份清单并逐项判定。它的长度就是「输入规模」的一部分。
  assert.ok(DIMS.join(",").length <= 1000,
    `键名清单 ${DIMS.join(",").length} 字符——删了 12 个还没降下来，说明删的不是它`);
});

test("维度表里不许再有「只写不读」的", () => {
  // 上一轮按「出现次数」判，漏掉了 databaseDecisionRequired——它唯一的那次「读」
  // 在同一句赋值的右边（`m.X = !!(m.X || …)`），是自引用不是消费者。
  // 这条按**读写位置**判，把那一类一并守住。
  const dead = [];
  for (const d of DIMS) {
    const reads = (SRC.match(new RegExp(`\\b\\w+\\.${d}\\b(?!\\s*=(?!=))`, "g")) || []).length;
    // 自引用：`x.D = ...x.D...` 同一行里既写又读，那次读不算消费者
    const selfRef = (SRC.match(new RegExp(`\\b\\w+\\.${d}\\s*=[^\\n]*\\b\\w+\\.${d}\\b`, "g")) || []).length;
    if (reads - selfRef <= 0) dead.push(d);
  }
  assert.deepEqual(dead, [],
    `这些维度只写不读，占着模型每一轮的判定面却没有任何消费者：${dead.join(",")}`);
});
