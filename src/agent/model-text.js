// 给模型看的文本裁剪：一段工具输出 / 一段旧回复要塞进有限预算时，该留什么、怎么说明省了什么。
//
// 五个出口一个原则——**错误在末尾、结论在末尾，盲目截前缀会丢掉唯一要紧的那几行**：
//   · _stripAnsi         终端控制序列去掉（和终端卡片同一个解析器，超大输入首尾各截一段再解析）；
//   · _headTailModelText 头 45% + 尾 55%，中间用一句**说清是二次省略**的标记替代；
//   · _foldAssistantText 折叠模型自己的旧回复（结论在尾部，尾部多给）；
//   · _hasErrorLine / _clipPreservingErrors  被裁掉的中段里的报错关键行以豁免块追回；
//   · _lexCompress / _smartCompress  词法压缩 + 保留 _IMPORTANT_LINE 命中的行。
// 纯函数；从 main.js 原样搬出，一行逻辑没改。
import { ansiToText as _ansiText } from "./ansi.js";

// --- Smarter context/prompt compression (grounded in RECOMP extractive + Selective
// Context + LLMLingua's keep-high-information idea). The old path truncated command
// output to its HEAD — but errors live at the END, so it dropped the one thing that
// matters. These keep the CORE: head + ALL error/important lines + tail, and squeeze
// the boilerplate, instead of a blind prefix cut. ---

// Lossless-ish lexical squeeze: trim trailing ws, collapse blank-line runs, fold a
// line repeated ≥3× into one + a count. No information lost, just redundancy.
export function _lexCompress(s) {
  const lines = String(s || "").replace(/[ \t]+$/gm, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run++;
    out.push(lines[i]);
    if (run >= 3) out.push(`…（上一行重复了 ${run} 次，已折叠）`);
    i += run - 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
// Lines that carry CORE signal and must survive compression (errors, failures, stack
// frames, file:line, "not found", test results…).
export const _IMPORTANT_LINE = /error|fail(ed|ure)?|✗|✖|panic|exception|traceback|warning|cannot (find|resolve)|undefined|未找到|找不到|错误|失败|拒绝|不存在|\bat .+:\d+|:\d+:\d+|\b\d+ (passed|failed|error)|assert|expected|实际|超时|timeout|refused|\bENOENT|\bE\d{2,}\b/i;
// Extractive compression to ~budget chars that NEVER drops error/important lines:
// head + every important middle line (capped) + tail. Used for non-refetchable
// outputs (run_cmd / browser …) where re-running isn't free.
export function _smartCompress(text, budget) {
  let s = _lexCompress(text);
  if (s.length <= budget * 1.4) return s;
  const lines = s.split("\n");
  const headN = 4, tailN = 6;
  if (lines.length <= headN + tailN + 2) return s.slice(0, Math.max(budget, 400)) + "\n…（已截断）";
  const head = lines.slice(0, headN);
  const tail = lines.slice(-tailN);
  const mid = lines.slice(headN, lines.length - tailN);
  const important = mid.filter((l) => _IMPORTANT_LINE.test(l)).slice(0, 18);
  const omitted = mid.length - important.length;
  const parts = [...head];
  if (important.length) parts.push(`…（中间 ${omitted} 行省略，下面保留 ${important.length} 行关键/报错信息）`, ...important);
  else parts.push(`…（中间 ${mid.length} 行省略以省上下文）`);
  parts.push(...tail);
  let out = parts.join("\n");
  // Hard ceiling so a flood of "error" lines can't blow past budget — but keep generous
  // room so the actual error message survives.
  const ceil = Math.max(budget * 2, 800);
  if (out.length > ceil) out = out.slice(0, ceil) + "\n…（仍过长，已截断）";
  return out;
}

export function _stripAnsi(s) {
  // 解析器的输入上限，首尾各留这么多字符。
  const budget = 200_000;
  // 走和终端卡片同一个解析器。旧的正则 `\x1b\[[0-9;]*[A-Za-z]` 匹配不到带 `?` 的私有
  // 序列（`\x1b[?25l` 这种隐藏光标的），它们会原样进模型上下文；`\r` 也没处理，于是
  // pip / npm 的进度条几十帧全都喂了进去，白烧 token 还盖住真正的结论。
  //
  // 逐字符解析比正则贵（实测 2MB 全彩日志 ~130ms）。下游本来就只取首尾几千字，
  // 所以超大输入先按**首尾**各截一段再解析——两头都保住，成本封在 ~25ms。
  const raw = String(s == null ? "" : s);
  if (raw.length > budget * 2) {
    return (
      _ansiText(raw.slice(0, budget)) +
      "\n…（中间省略）…\n" +
      _ansiText(raw.slice(-budget))
    );
  }
  return _ansiText(raw);
}

// A tool can emit megabytes of logs. Preserve the beginning for command context and
// the end for the actual final state, instead of handing the model only an arbitrary
// prefix. The structured execution envelope below carries exit status separately, so
// this is a size control rather than a keyword/error-word classifier.
export function _headTailModelText(value, maxChars) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit) return "";
  if (text.length <= limit) return text;
  // 措辞很要紧：这句话是模型判断"我手上是不是全部"的唯一依据。
  //
  // 原文是「中间 N 字中的部分**日志**已省略；保留开头和最终状态」。两个毛病：
  // (a) "日志"是个误导词——同一条路径上跑的还有网页正文、git diff、检索结果，
  //     模型看到"日志"会以为省掉的是噪声，而对一份 API 文档来说省掉的正是参数表。
  // (b) 它没说清这是**投递给模型时的二次省略**。工具自己可能已经截过一刀并附了说明
  //     （web_fetch 会写"这里只给了前 24000 字符"），那句说明活在 tail 里，于是模型
  //     同时收到"你有前 24000"和"中间省了"两句互相矛盾的话，无从知道到底缺了哪一段。
  const marker = `\n…（⚠️ 这里被**再次**省略过：原始结果共 ${text.length} 字，投递给你时只保留了开头和结尾，中间约 ${text.length - limit} 字不在上下文里。如果上面还有工具自己写的截断说明，那是另一层截断——两层叠加，你手上的比任何一句说明讲的都少。需要完整内容就换更窄的查询重取。）…\n`;
  if (limit <= marker.length + 2) return text.slice(-limit);
  const remaining = limit - marker.length;
  const head = Math.ceil(remaining * 0.45);
  const tail = Math.max(1, remaining - head);
  return text.slice(0, head) + marker + text.slice(-tail);
}

// 折叠**自己**早先的回复：保留头尾，因为结论在末尾。
//
// 不复用 _headTailModelText：那句 marker 的收尾是"需要完整内容就换更窄的查询重取"，
// 那是写给工具结果的。贴到 assistant 自己的旧回复上等于叫模型去重取一段根本没有任何
// 工具能取回的文本——正好和这里要治的毛病相冲。
export function _foldAssistantText(text, budget) {
  const raw = String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (!limit || raw.length <= limit) return raw;
  const marker = "\n…（你这段早先的回复太长，只保留了开头和结尾；中间已永久省略，无法取回。"
    + "下面的结尾部分是当时的结论，以它为准，不要重新推导。）\n";
  if (limit <= marker.length + 2) return raw.slice(-limit);
  const remaining = limit - marker.length;
  const head = Math.ceil(remaining * 0.35); // 结论比开场白值钱，尾部多给一点
  const tail = Math.max(1, remaining - head);
  return raw.slice(0, head) + marker + raw.slice(-tail);
}

// ── 方案B/E 统一裁剪出口 ──────────────────────────────────────────────────────
// 错误关键行判定：编译/运行报错、系统 errno、异常栈帧。仅作"裁剪时豁免保留"的
// 尺寸控制辅助，不做语义分类（语义判断仍归模型）。
// 测试失败的主标记也算错误行。原表只有 `failed`，只能命中汇总行（"3 failed"）——
// 而汇总行只说挂了几条，不说哪条、为什么。真正要救的是 jest/vitest 的 `FAIL x.test.ts`
// 和 `✕`、go 的 `--- FAIL: TestX`、TAP/node --test 的 `not ok 1 -`、pytest 的 `E assert`，
// 以及 Expected/Received 这对明细。它们全落在被对折掉的中段里，模型于是凭猜去改。
export function _hasErrorLine(text) {
  return /error|E\d{3}|ENOENT|EACCES|panic|exception|fatal|fail(ed)?\b|--- FAIL|not ok \d|[✕✗×]|AssertionError|assert\b|Expected:|Received:|Traceback|\bat\s+.+:\d+/i
    .test(String(text || ""));
}

// 在预算内裁剪长文本，但被裁掉中段里的错误关键行（含前后各 1 行上下文）以豁免块
// 追回：截断预算里错误内容优先于普通输出——"报错行正好被对折裁掉"从机制上消失。
// 豁免总量 ≤2KB 且不超预算一半，豁免本身不会反过来撑爆上下文；预算内放得下时
// 原样返回，零行为变化。（行切分用 \u000d?\u000a 免疫写法，不含字面换行。）
export function _clipPreservingErrors(text, budget) {
  const raw = String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (!limit) return "";
  if (raw.length <= limit) return raw;
  const rescueMax = Math.min(2048, Math.floor(limit / 2));
  const lines = raw.split(/\u000d?\u000a/);
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!_hasErrorLine(lines[i])) continue;
    keep.add(i);
    if (i > 0) keep.add(i - 1);
    if (i + 1 < lines.length) keep.add(i + 1);
  }
  // **先算正文，再只捞正文里没有的**（原来从末行往前挑、末尾正是已投递的 tail → 全是重复、
  // 白扔 26% 预算、中段根因 0% 可见）。判据见 logic.test.mjs 同名测试。
  const probe = _headTailModelText(raw, Math.max(200, limit - rescueMax - 80));
  let rescue = "";
  if (keep.size) {
    const picked = [...keep].sort((a, b) => a - b);
    const parts = [];
    const seen = new Set();
    let total = 0;
    for (let i = picked.length - 1; i >= 0; i--) {
      const line = lines[picked[i]].trim().slice(0, 320);
      if (!line || probe.includes(line)) continue;
      const shape = line.replace(/\d+/g, "#").replace(/\s+/g, " ");
      if (seen.has(shape)) continue; seen.add(shape);   // 同形报错只留一条，别被刷屏吃光额度
      if (total + line.length + 1 > rescueMax) break;
      parts.unshift(line);
      total += line.length + 1;
    }
    rescue = parts.join("\u000a");
  }
  if (!rescue) return _headTailModelText(raw, limit);
  const base = _headTailModelText(raw, Math.max(200, limit - rescue.length - 80));
  const missing = rescue.split(/\u000d?\u000a/).filter((line) => line && !base.includes(line));
  if (!missing.length) return base;
  return `${base}\u000a〔截断豁免·错误关键行（原文位于被省略的中段）〕\u000a${missing.join("\u000a")}`;
}
