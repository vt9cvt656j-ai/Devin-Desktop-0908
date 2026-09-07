// 改完之后把**改成什么样了**带回给模型。
//
// 现状：写工具的成功回执是「已修改 X（+3/-1 行）」。行数是执行事实，但它回答不了模型
// 下一步唯一关心的问题——**这段代码现在长什么样、缩进对不对、落在了哪一处**。
// 于是模型的下一步几乎必然是 read_file 把刚写完的文件再读一遍。生产遥测里 read_file
// 在长轮里占 20.8%，这类"读自己刚写的东西"就摊在里面。
//
// 这是 Claude Code 的形状：Edit 回一段带行号的改后片段，模型不用再读一次就能确认。
// 也符合本仓的分工尺子——运行事实挂在产生它的工具结果上，不另发提醒。
//
// 三条边界：
//   · 只对**外科手术式**的改动有意义（edit/multiedit）。整文件重写没有"那一段"，
//     模型手上就是它自己刚写的全文，回显等于把输入还给它。
//   · 必须封顶。回显的目的是"确认落点"，不是把文件再传一遍。
//   · 找不到落点就**什么都不加**，绝不猜——回一段错位的代码比不回更坏。
//
// 落点用 old/new **求差**得到，不用 new_string 去 indexOf。两个原因：
//   ① new_string 在缩进/CRLF 容错命中时会被就地改写，它那个可变副本的作用域比返回点窄
//      （实测 ReferenceError，被「undeclared identifiers」那条元测试逮住）；
//   ② multi_edit 只能拿 edits[0] 去猜，而第 1 处很可能已被后面的替换改掉。
// 求差对增、删、改一视同仁，两条写路径共用同一套判据。

const CONTEXT = 4;
const MAX_LINES = 24;
const MAX_CHARS = 1600;

/** old→new 里第一处到最后一处不同，落在 new 上的行区间（0-based，闭区间）。 */
export function changedRange(oldText, newText) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;           // 一字未改
  let ja = a.length - 1, jb = b.length - 1;
  while (ja >= i && jb >= i && a[ja] === b[jb]) { ja--; jb--; }
  // 纯删除时 jb < i：new 上没有"新行"，就把接缝那一行圈出来，让模型看见删完之后接上了谁。
  return { from: i, to: Math.max(i, jb) };
}

/**
 * 改动落在 new 上的那一段，带行号。
 * @returns 片段文本；一字未改 / 入参不合用时返回 ""
 */
export function changedSnippet(oldText, newText, opts = {}) {
  const body = String(newText || "");
  if (!body) return "";
  const range = changedRange(oldText, newText);
  if (!range) return "";
  const context = Number.isFinite(opts.context) ? opts.context : CONTEXT;
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : MAX_LINES;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : MAX_CHARS;

  const lines = body.split("\n");
  const from = Math.max(0, range.from - context);
  const to = Math.min(lines.length - 1, range.to + context);

  const out = [];
  let chars = 0;
  let truncated = false;
  for (let i = from; i <= to; i++) {
    if (out.length >= maxLines || chars > maxChars) { truncated = true; break; }
    // 行号是这段回显的**全部意义**：模型据此判断"改在了第几处"。宽度跟着最大行号走。
    const n = String(i + 1).padStart(String(to + 1).length, " ");
    // 单行也要封顶：压缩产物一行能有几万字符，一行就能把整个回执撑爆。
    const text = lines[i].length > 300 ? lines[i].slice(0, 300) + " …（本行过长已截断）" : lines[i];
    out.push(`${n}\u2502${text}`);
    chars += text.length + 2;
  }
  if (!out.length) return "";
  return out.join("\n") + (truncated ? "\n…（片段已截断）" : "");
}

/**
 * 拼成挂在工具结果末尾的那一段。定位不到就返回 ""——回执保持原样。
 *
 * **必须传 opts.redact，不传就不回显（失败关闭）。** 这段片段是文件正文，会随工具结果
 * 进模型上下文；read_file 那条路早就在打码了（31089 附近的注释记着同一个坑："此前这里
 * 发的是逐字符原文"）。默认放行等于给这条新出口开一个静默的密钥外泄口，所以判据反过来：
 * 没接打码器就当没配好，一个字不回。
 *
 * 片段一旦被打码器改动，整段回显也省掉、只留一句指路：编号打码只有 read_file 那一个出口
 * （占位符要按 run 级序号回写），在这里另开一个会让同一段内容出现两种占位符渲染。
 */
export function editEchoNote(oldText, newText, opts = {}) {
  const redact = typeof opts.redact === "function" ? opts.redact : null;
  if (!redact) return "";
  const snip = changedSnippet(oldText, newText, opts);
  if (!snip) return "";
  if (redact(snip) !== snip) return "\n\n（改动落在含疑似密钥的区域，已省略片段回显；要核对当前内容请 read_file。）";
  const more = Number(opts.moreEdits) > 0
    ? `（本次共 ${Number(opts.moreEdits) + 1} 处替换，下面是覆盖它们的那一段）`
    : "";
  return `\n\n改动后的片段${more}：\n\`\`\`\n${snip}\n\`\`\``;
}
