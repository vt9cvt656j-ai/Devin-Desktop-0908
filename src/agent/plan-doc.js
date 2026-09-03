// Plan 模式那一屏的文档内容。
//
// # 判据换过一次，值得写清楚
//
// 第一版是**按关键词挑小节**：标题命中「目标/关键文件/计划/验证/风险」的留下，命中
// 「证据/背景」的去掉。线上第一份真实方案就把它证伪了 —— 模型写的小节叫
// 「第一梯队：先把这个做成完整体验」「第二梯队：补齐验证闭环」，前者一个关键词都不沾，
// 整段被丢；后者只因为标题里有「验证」二字侥幸留下。用户看到的是一份缺了一半、
// 从中间断开的方案（原话「显示内容不对、好少、不详细」）。
//
// 教训是：**方案的小节名是模型自由发挥的，任何关键词表都是在赌它怎么命名。**
// 现在反过来 —— 默认全留，只摘掉确定不属于文档的那两样：
//
//   · 第一个标题**之前**的开场白（「结论先给：……」这类，是说给人听的引子）；
//   · 结尾那句征询（「要补哪个，说一声我就动手」）。
//
// 这两样都有明确形状（位置固定 + 短 + 没有列表/代码），不靠猜语义。

/** 结尾那句「要不要我动手」。只在**最后一段**匹配，中间出现同样的话不动。 */
const CLOSING = /(说一声|告诉我|随时说|我就动手|要不要我|需要我)[^\n]{0,20}$/;

/** 把 markdown 按 ATX 标题切成小节。代码块里的 # 不算标题。 */
function splitSections(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  let cur = { title: "", level: 0, body: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (cur.title || cur.body.some((l) => l.trim())) out.push(cur);
      cur = { title: m[2].trim(), level: m[1].length, body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.title || cur.body.some((l) => l.trim())) out.push(cur);
  return out;
}

/** 这一段是不是「开场白」：没有标题、够短、不含列表和代码。 */
function isPreamble(sec) {
  if (sec.title) return false;
  const text = sec.body.join("\n").trim();
  if (!text) return true;
  if (/^\s*([-*+]|\d+[.)])\s+/m.test(text) || text.includes("```")) return false;
  return [...text].length <= 240;
}

/**
 * 从一份 Plan 回复里取出方案文档。
 *
 * 空回复返回空串 —— 调用方据此**不开窗口**，而不是开一张空白页。
 */
export function planCoreFromReply(md) {
  const text = String(md || "").trim();
  if (!text) return "";
  const sections = splitSections(text);
  if (!sections.length) return text;

  // 开场白只摘**最前面**那一段：中间的散文是小节正文，属于方案本身。
  let start = 0;
  if (isPreamble(sections[0])) start = 1;
  const kept = sections.slice(start);
  if (!kept.length) return text; // 整份就是一段引子 —— 那就原样给，总好过空白

  const out = kept
    .map((s) => (s.title ? `${"#".repeat(Math.min(4, Math.max(2, s.level)))} ${s.title}\n${s.body.join("\n")}` : s.body.join("\n")))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 结尾那句征询：只看最后一个非空行。
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    if (!lines[i].trim()) continue;
    if (CLOSING.test(lines[i].trim())) { lines.splice(i, 1); }
    break;
  }
  return lines.join("\n").trim();
}

/** 窗口标题：取第一个标题，没有就用默认名。太长的截断（标签栏放不下）。 */
// 把一段文字洗成干净的页签标题：去掉 emoji（🔴✅⚠️ 之类当图标看很丑）、markdown 记号、
// 前导项目符号/序号，折叠空白，按显示宽度截断。
export function cleanPlanTitle(raw, cap = 18) {
  const t = String(raw || "")
    // emoji / 杂项符号 / dingbat / 变体选择符：CJK（4E00-9FFF）不在这些区间，不会被误伤。
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu, "")
    .replace(/[*`#>~_]/g, "")
    .replace(/^\s*[-•·—*]+\s*/, "")          // 前导项目符号
    .replace(/^\s*\d+\s*[.、)\]]\s*/, "")      // 前导序号 "1. " "2、"
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return [...t].length > cap ? [...t].slice(0, cap).join("") + "…" : t;
}

// 方案的第一个小节标题——**只当兜底**。真正的标题优先取会话主题（用户那句请求），
// 因为评审型方案的小节名（「关键缺失」「亮点」）是"这一段讲什么"，不是整份方案的主题，
// 拿它当标题既不代表内容、又常常吓人。会话主题拿不到时才回到这里。
export function planTitleFromReply(md, fallback = "方案") {
  const first = splitSections(String(md || "")).find((s) => s.title);
  return cleanPlanTitle(first?.title || "") || fallback;
}
