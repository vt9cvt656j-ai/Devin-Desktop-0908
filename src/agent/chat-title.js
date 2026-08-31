/**
 * 会话标签页的标题：从**第一句话**里取，而不是 `Chat 1 / Chat 2 / Chat 3`。
 *
 * 用户：「要弄成 cursor 那种 tab 标题的，而不是我这种固定的 Chat 1、Chat 2、Chat 3」。
 * 固定编号还有个副作用：编号里的「Chat」会跟着界面语言翻，于是同一排标签会出现
 * `Chat 1 / 聊天 2 / Chat 3` 这种半中半英——因为它们是在不同语言下建出来的。
 *
 * 纯字符串进出，没有 DOM、没有网络、没有模型调用。**不叫模型**是有意的：标题要在敲下
 * 回车的那一刻就出现，而且离线、没配模型、额度用完时都得照样有。
 */

/** 中日韩字符按两格算——按字符数截，中文标题会比英文长出一倍。 */
function width(s) {
  let n = 0;
  for (const ch of String(s)) n += /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}

/** 按显示宽度截断，末尾补省略号。 */
function clampWidth(s, max) {
  if (width(s) <= max) return s;
  let out = "";
  for (const ch of String(s)) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

/**
 * 从一条用户消息里取标题。取不出来返回空串——调用方据此保留原来的名字，
 * 绝不能让标签变成空白。
 */
export function chatTitleFrom(text, { maxWidth = 22 } = {}) {
  let s = String(text ?? "");
  // 代码块整段丢掉：拖进来的选区、粘贴的报错都在里面，拿它当标题看不出这一轮在聊什么。
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  // 各种 @ 引用也丢掉（@code:… 是拖进来的选区，@github:… 是仓库，@路径 是文件）：
  // 它们是**附件**，不是这句话的意思。
  s = s.replace(/(^|\s)@[^\s]+/g, " ");
  // 引用出处那一行是我们自己拼的，不是用户说的。
  s = s.replace(/^\s*引用\s+\S+\s+第\s*\d+(?:-\d+)?\s*行[：:]\s*$/gm, " ");
  // 取第一段有内容的话。
  const line = s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";
  // markdown 的行首标记、列表符号、多余空白去掉。
  const clean = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+>]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clampWidth(clean, maxWidth);
}

/**
 * 这个名字是不是「还没被内容命名过」的默认名。
 *
 * 结构标记（session._titled）是主判据；这条正则只用来兜**历史里存下来的**老会话——
 * 它们没有那个标记。`Chat 3`、`聊天 2`、`チャット 1` 都算，因为默认名是跟着界面语言走的。
 */
export function isDefaultChatName(name) {
  return /^\s*(chat|聊天|チャット|채팅|unterhaltung|charla|conversa|чат)\s*\d+\s*$/i.test(String(name ?? ""));
}
