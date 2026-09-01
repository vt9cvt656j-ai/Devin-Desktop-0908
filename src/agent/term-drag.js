/**
 * 终端里选中的输出拖进输入框。
 *
 * 这里只做纯粹的那几件：**按下的那一点是不是落在选区里**、片上显示什么标签、发送时展开成
 * 什么正文。xterm、DOM、鼠标事件全在 main.js 那一半，和编辑器选区那条（selection-drag.js）
 * 同一个分工。
 *
 * 为什么命中判定得自己算：xterm 用 WebGL/Canvas 画字，选区**不是 DOM 节点**，
 * `document.elementFromPoint` 只会拿到那张画布。判断"按在不在选中的那几个字上"只能
 * 从 `getSelectionPosition()`（缓冲区坐标）+ 单元格宽高反推。
 */

/**
 * 客户端坐标 (x, y) 落在终端当前选区里吗。
 *
 * · `rect`     —— `.xterm-screen` 的 getBoundingClientRect（字符网格的实际区域）
 * · `cols/rows`—— 终端的列数行数
 * · `sel`      —— `term.getSelectionPosition()`：{ start:{x,y}, end:{x,y} }，**缓冲区**坐标，
 *                 y 含滚动历史；`end.x` 是**开区间**（xterm 的约定）
 * · `viewportY`—— `term.buffer.active.viewportY`，视口顶端在缓冲区里的行号
 *
 * 任何一样缺了就返回 false：宁可这一次拖不起来，也不能在没有选区时把整个终端变成可拖区，
 * 那会把「按住拖来选字」这个终端最基本的操作整个盖掉。
 */
export function pointInTermSelection(x, y, opts) {
  const { rect, cols, rows, sel, viewportY = 0 } = opts || {};
  if (!rect || !sel || !sel.start || !sel.end) return false;
  const c = Math.max(1, Number(cols) || 0);
  const r = Math.max(1, Number(rows) || 0);
  const w = Number(rect.width) || 0;
  const h = Number(rect.height) || 0;
  if (!w || !h) return false;
  if (x < rect.left || x >= rect.left + w || y < rect.top || y >= rect.top + h) return false;

  const col = Math.floor((x - rect.left) / (w / c));
  const row = Math.floor((y - rect.top) / (h / r));
  const bufRow = row + (Number(viewportY) || 0);

  const a = { x: Number(sel.start.x) || 0, y: Number(sel.start.y) || 0 };
  const b = { x: Number(sel.end.x) || 0, y: Number(sel.end.y) || 0 };
  if (bufRow < a.y || bufRow > b.y) return false;
  if (a.y === b.y) return col >= a.x && col < b.x;
  if (bufRow === a.y) return col >= a.x;
  if (bufRow === b.y) return col < b.x;
  return true; // 中间那些整行都算
}

/**
 * 每行右边的空白要削掉。
 *
 * 终端是定宽网格，选到行尾时那一行后面跟着一长串填充空格。原样带进代码块，模型看到的是
 * 一片右侧留白的方阵，而且白占 token —— 一屏 80 列的输出能有一半是空格。
 */
export function trimTermText(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * 片上显示的标签。
 *
 * 一行就把那一行显示出来（`终端 1: pip install pyright`）——终端里选一行多半是选了一条命令
 * 或一句报错，把它显示出来，用户一眼认得出自己拖的是哪一条。多行才退回计数
 * （`终端 1: 12 行`）：多行的第一行未必有代表性，而一大段字符塞进片里只会把输入框撑爆。
 *
 * 宽度按**显示宽度**夹（中日韩算两格），和标签页标题同一把尺子。
 */
export function termChipLabel(tabLabel, text, maxWidth = 26) {
  const name = String(tabLabel || "终端").trim() || "终端";
  const lines = trimTermText(text).split("\n").filter((l) => l.trim());
  if (lines.length > 1) return `${name}: ${lines.length} 行`;
  const one = (lines[0] || "").trim();
  if (!one) return `${name}: 空`;
  return `${name}: ${clampWidth(one, Math.max(6, maxWidth))}`;
}

const width = (s) => [...String(s)].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
function clampWidth(s, max) {
  if (width(s) <= max) return s;
  let out = "", n = 0;
  for (const ch of String(s)) {
    const w = width(ch);
    if (n + w > max - 1) break;
    out += ch; n += w;
  }
  return out + "…";
}

/**
 * 发送时展开成的正文：一句出处 + 一个代码块。
 *
 * 三件事和编辑器那条选区（selectionText）一致，理由也一致：
 *  ① **围栏按内容算**——输出里出现 ``` 是常事（打印 markdown、贴代码块），固定三个反引号
 *     会把块提前关掉，后半段变成正文。
 *  ② **带出处**——说清是哪个终端、在哪个目录跑的，模型才知道这段是什么环境下的产物。
 *  ③ **截断要明说**——超上限只带前面一段并写清共多少行、带了多少行。默默少给几行会让模型
 *     以为自己看到了全部输出，然后基于半截日志下结论。
 */
export function termSnippetText(opts) {
  // 解构默认值只兜 undefined、兜不住 null，而这一层跑在发送路径上——调用方一次取空就整轮发不出去。
  const { label, cwd, text, maxLines = 200, maxChars = 8000 } = opts || {};
  const all = trimTermText(text).split("\n");
  let kept = all.slice(0, Math.max(1, maxLines));
  let body = kept.join("\n");
  if (body.length > maxChars) {
    body = body.slice(0, Math.max(0, maxChars));
    kept = body.split("\n");
    body = kept.join("\n");
  }
  const longest = (body.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const where = String(label || "终端").trim() || "终端";
  const at = String(cwd || "").trim();
  const dropped = all.length - kept.length;
  const tail = dropped > 0 ? `\n（选区共 ${all.length} 行，这里只带了前 ${kept.length} 行）` : "";
  return `\n用户在「${where}」里选中的输出${at ? `（工作目录 ${at}）` : ""}：\n${fence}\n${body}\n${fence}${tail}\n`;
}
