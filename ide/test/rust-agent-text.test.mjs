// Rust 侧也在往包里放「面向模型的文本」，而 JS 那套剥离和扫描一个字都够不着它。
//
// 实测（target/release/bundle/macos/Mr. Day One.app/Contents/MacOS/michael-ide，30.9 MB）：
//   '已铺好'                       2 次      ← web_scaffold.rs 的脚手架说明
//   '【直接用这些原件，不要重造】'    1 次
//   '谷歌 Material 3 预设'          1 次
//   汉字字符总数                22872 个
//
// **`strings` 查不到它们**：默认只输出 ASCII 序列，UTF-8 的中文被整段跳过。实测
//   strings michael-ide | grep -c '已铺好'                        → 0
//   python3 -c "open(p,'rb').read().count('已铺好'.encode())"      → 2
// 任何「strings 扫了一遍没中文，干净」的结论都是假的。这条测试按**字节**查。
//
// 为什么是棘轮而不是白名单：源码里现在有 21 段这样的文本，散在 11 个文件。逐条写进
// 白名单要做 21 次「它到底给谁看」的判断，而那张表接下来只会烂掉（有人删了一条，
// 白名单里那条就永远绿着守空气）。棘轮只回答一个不需要判断的问题：**它变多了没有**。
// 迁移到网关的过程中基线跟着往下走，方向是单调的，谁也不用维护理由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RS_DIR = join(ROOT, "src-tauri/src");

// 基线：2026-08-27 实测。**只许降不许升**。
// 这 21 段全是工具结果里的散文——写给模型看的操作指导，和 tool-guides.js 的 usage_note
// 是同一物种，只是写在 Rust 里所以 build/strip-*.mjs 全都够不着。抽查确认的三条（qr.rs 那条随 decode_qr 工具一起删了）：
//   accessibility.rs:555  "…等一下再 read_screen 一次，别据此断定页面上没有它。"
//   git.rs:689            "…文件后来改过名的话，用 git_log 看重命名历史。"   ← 直接给模型指路
//   web_scaffold.rs:152   "…【直接用这些原件，不要重造】…【不要建 tailwind.config.js…】"
// 修法一律相同：客户端只回**结构化事实**（错误码 / 计数 / preset 名），措辞归网关。
const BASELINE = {
  "accessibility.rs": 3,
  "archive.rs": 1,
  // 2026-08-30 6 → 5：「操作不到「X」：disabled/not_visible/covered by」那段诊断原来在
  // browser_click / browser_type 里**抄了三份**，收进 unactionable_reason() 一处共用。
  // 措辞本身仍在客户端（它要区分三种形状、且和 click_via_eval 的返回值强耦合），
  // 但至少不会再改一处漂三份。
  // 2026-09-07 5 → 4：会话提示里那两段散文（Chrome 137 不再认命令行扩展、接管用户自研应用）
  // 改成原生层只回码和事实（[EXT_IGNORED_CHROME137] / [ATTACHED_OWN_APP]），措辞挪到
  // main.js 的 _browserSessionNoteText，顺带有了三语——写在二进制里的中文永远只有一种语言。
  // 同一轮 ai.rs 那两条重复的 MSE 文案改成 [MSE_SESSION_GONE]，所以它连基线都不用有。
  "browser.rs": 4,
  "capture.rs": 1,
  "git.rs": 1,
  "knowledge.rs": 2,
  "protocol.rs": 1,
  "sysctl.rs": 3,
  "ui_clone.rs": 1,
  "web_scaffold.rs": 1,
};

// 注释和 #[cfg(test)] 模块都不进 release 二进制，先去掉，否则量出来的是「源码里有多少中文」
// 而不是「包里有多少中文」—— 本仓 ai.rs 是 10604 : 1331，差了八倍。
function shippedSource(text) {
  let s = text.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (;;) {
    const at = s.search(/#\[cfg\(test\)\]/);
    if (at < 0) break;
    const open = s.indexOf("{", at);
    if (open < 0) { s = s.slice(0, at); break; }
    let d = 0, q = null, i = open;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "{") d++;
      else if (c === "}" && --d === 0) break;
    }
    s = s.slice(0, at) + s.slice(Math.min(i + 1, s.length));
  }
  // 原始字符串 r#"…"# 里可以有裸引号（accessibility.rs 里有 8 个，装着 PowerShell 脚本）。
  // 不先摘掉，下面那个 "…" 正则会从一个裸引号一路吞到几百行外，把整段代码当成一条文案。
  // 假阳性多了这条测试会被人关掉，那比没有它更糟。
  return s.replace(/r(#*)"[\s\S]*?"\1/g, '""');
}

const chineseCount = (s) => (s.match(/[一-鿿]/g) || []).length;

/** 每个 .rs 文件里「>= 40 个汉字的单行字符串字面量」的条数。 */
function census() {
  const out = {};
  for (const f of readdirSync(RS_DIR).filter((n) => n.endsWith(".rs")).sort()) {
    const src = shippedSource(readFileSync(join(RS_DIR, f), "utf8"));
    let n = 0;
    // 只看**长**的：>= 40 个汉字的一段话才可能是给模型读的操作指导。
    // 短句基本是报错文案（"读 {style_rel} 失败"），阈值低了会淹没在噪音里。
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.){40,}?)"/g)) if (chineseCount(m[1]) >= 40) n++;
    if (n) out[f] = n;
  }
  return out;
}

test("Rust 里面向模型的散文只许减少，不许增加", () => {
  const now = census();
  const grew = [];
  for (const [f, n] of Object.entries(now)) {
    const base = BASELINE[f] || 0;
    if (n > base) grew.push(`${f}: ${base} → ${n}`);
  }
  assert.deepEqual(grew, [],
    `这些 Rust 文件里新增了面向模型的长文案：\n  ${grew.join("\n  ")}\n`
    + "工具结果里的措辞属于网关，不属于客户端二进制——客户端回结构化事实（错误码/计数/枚举名），"
    + "由网关把它渲染成给模型看的话。确实必须写在客户端的，改 BASELINE 并在这里写清理由。");

  // 反向：基线里的条目消失了要把基线跟着降下来，否则那一格永远绿着，
  // 别人后来往同一个文件里加回两条也不会红——这是「断言真实却守错了东西」的形状。
  const stale = Object.entries(BASELINE).filter(([f, n]) => (now[f] || 0) < n)
    .map(([f, n]) => `${f}: 基线 ${n}，实际 ${now[f] || 0}`);
  assert.deepEqual(stale, [],
    `基线高于实际，说明这些已经修过了，把 BASELINE 调到实际值锁住成果：\n  ${stale.join("\n  ")}`);
});

test("普查器本身没坏（不许量出 0 条还报通过）", () => {
  const now = census();
  const total = Object.values(now).reduce((a, b) => a + b, 0);
  assert.ok(total >= 10,
    `全仓只量到 ${total} 条 —— 普查器坏了（正则、注释剥离或 r#"…"# 处理），`
    + "而它坏掉的表现恰好是「一切干净」。修好它再看结果。");
  // 阳性对照：一段**当前确实存在**的文本必须被这个判据数到。
  const scaffold = shippedSource(readFileSync(join(RS_DIR, "web_scaffold.rs"), "utf8"));
  assert.ok(/【直接用这些原件，不要重造】/.test(scaffold),
    "阳性对照不在剥离后的源码里 —— shippedSource 把它误删了，普查结果不作数。");
});

test("发布二进制里按字节核对（strings 查不到中文，必须按字节查）", () => {
  const candidates = [
    "target/release/bundle/macos/Mr. Day One.app/Contents/MacOS/michael-ide",
    "target/aarch64-apple-darwin/release/bundle/macos/Mr. Day One.app/Contents/MacOS/michael-ide",
    "src-tauri/target/release/michael-ide",
  ].map((p) => join(ROOT, p)).filter((p) => existsSync(p));

  if (!candidates.length) {
    assert.ok(process.env.IDE_RELEASE_CHECK !== "1",
      "没找到已构建的 release 二进制，这条核对一次都没跑。发布路径上「没跑」不等于「通过」。");
    return;
  }
  const bin = readFileSync(candidates[0]);
  // 阳性对照：这段文本**必然**在二进制里。找不到 = 读法坏了，而不是「干净」。
  assert.ok(bin.includes(Buffer.from("已铺好", "utf8")),
    "阳性对照 '已铺好' 在二进制里找不到 —— 这条核对看不见它本该看见的东西，任何结论都不作数。"
    + "（若 web_scaffold 的 note 已经搬到网关，把对照换成另一段仍在的中文，并把 BASELINE 降下来。）");

  // 前端那份 IP 不该以明文出现在二进制里 —— dist 被 Tauri 压缩内嵌，本来就搜不到。
  // 这条断言的价值不在「保证干净」，而在于把「搜不到 ≠ 没有」写进代码：
  // 前端的泄漏必须在**打包之前**扫 dist/assets（见 test/bundle-ip-leak.test.mjs），
  // 在二进制上扫等于什么都没扫。
  assert.equal(bin.includes(Buffer.from("【何时用】", "utf8")), false,
    "二进制里出现了明文的【何时用】—— 说明 dist 不再被压缩内嵌，前端扫描的时机要重新定。");
});
