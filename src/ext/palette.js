// 命令面板（⌘⇧P）。内置动作和扩展贡献的命令都走这里，快速打开（⌘P）在 main.js 里
// 另有一份实现，但共用 .palette__* 这套样式，所以两边的行结构要一起看。
//
// 这一版对齐 VS Code / Cursor 那种形状，四件事是关键，缺一件就会露怯：
//   ① 模糊子序列匹配 + **把命中的字符高亮出来**（上一版是 indexOf，打字必须连着才有结果）；
//   ② 快捷键右对齐成键帽（上一版一个都不显示，`快速打开` 那条只好把 "(⌘P)" 硬拼进标题）；
//   ③ 空查询时按最近使用排在前面并分组（VS Code 的 recently used / other commands）；
//   ④ 方向键只改选中项，不整表重建（上一版每按一次方向键就 innerHTML="" 重建整个列表）。

import { t } from "../i18n.js";

const MRU_KEY = "mrday.palette.mru";
const MRU_MAX = 8;

/* 词首判据。中文没有空格，所以「汉字前面不是汉字」也算词首——否则中文标题里
   除了第一个字之外没有任何位置能拿到词首加分，排序就退化成「谁先出现谁赢」。 */
const SEP_RE = /[\s./\\\-_:()（）·、,，>»]/;
const CJK_RE = /[㐀-鿿豈-﫿]/;

export function isWordStart(text, i) {
  if (i <= 0) return i === 0;
  const p = text[i - 1], c = text[i];
  if (SEP_RE.test(p)) return true;
  if (/[a-z0-9]/.test(p) && /[A-Z]/.test(c)) return true;   // camelCase
  if (CJK_RE.test(c) && !CJK_RE.test(p)) return true;       // 中英交界
  return false;
}

/*
 * 模糊子序列匹配。返回 { score, positions } 或 null。
 *
 * 每个查询字符先在「词首」上找，找不到再退回最近的一个——所以 "of" 命中
 * "Open Folder" 的两个词首，而不是 "Open" 里的 o 和 f（后者根本没有 f）。
 * 计分只有四项：连续、词首、开头、跳过的距离。项再多就调不动了，也说不清为什么。
 */
export function fuzzyMatch(text, query) {
  if (!query) return { score: 0, positions: [] };
  const lowText = text.toLowerCase();
  const lowQuery = query.toLowerCase();
  const positions = [];
  let from = 0, score = 0, prev = -2;
  for (const ch of lowQuery) {
    if (ch === " ") continue;                 // 空格只当分隔，不参与匹配
    let atWordStart = -1, anywhere = -1;
    for (let k = from; k < lowText.length; k++) {
      if (lowText[k] !== ch) continue;
      if (anywhere === -1) anywhere = k;
      if (isWordStart(text, k)) { atWordStart = k; break; }
    }
    const hit = atWordStart === -1 ? anywhere : atWordStart;
    if (hit === -1) return null;
    if (hit === prev + 1) score += 8;
    if (isWordStart(text, hit)) score += 6;
    if (hit === 0) score += 4;
    score -= Math.min(hit - (prev + 1), 6);
    positions.push(hit);
    prev = hit;
    from = hit + 1;
  }
  return { score, positions };
}

/*
 * 一条命令的匹配。分类和标题两段分开高亮，所以要把拼接串上的下标还原回各自那一段。
 *
 * 两种拼接顺序都试：用户既会打 "git stash"（分类在前，跟屏幕上读到的一致），
 * 也会直接打 "stash"（标题在前，命中得更早分更高）。取分高的那个。
 */
export function matchCommand(cmd, query) {
  const title = String(cmd.title || "");
  const cat = String(cmd.category || "");
  if (!query) return { score: 0, title: [], cat: [] };
  let best = null;
  const orders = cat ? [[title, cat, "title"], [cat, title, "cat"]] : [[title, "", "title"]];
  for (const [head, tail, headKey] of orders) {
    const joined = tail ? `${head} ${tail}` : head;
    const m = fuzzyMatch(joined, query);
    if (!m) continue;
    const cut = head.length;
    const headPos = m.positions.filter((p) => p < cut);
    const tailPos = m.positions.filter((p) => p > cut).map((p) => p - cut - 1);
    const hit = headKey === "title"
      ? { score: m.score, title: headPos, cat: tailPos }
      : { score: m.score, title: tailPos, cat: headPos };
    if (!best || hit.score > best.score) best = hit;
  }
  if (best) return best;
  // 兜底：命令 id 也能搜（"pref.settings"），但不高亮，且压低到标题匹配之后。
  const byId = fuzzyMatch(String(cmd.id || ""), query);
  return byId ? { score: byId.score - 40, title: [], cat: [] } : null;
}

function readMru() {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function writeMru(ids) {
  try { localStorage.setItem(MRU_KEY, JSON.stringify(ids.slice(0, MRU_MAX))); } catch { /* 隐私模式 */ }
}

/* 把命中的字符包进 <mark>。用 DOM 拼而不是拼 HTML 串——命令标题里有扩展贡献的文本。 */
function fillHighlighted(el, text, positions) {
  el.textContent = "";
  if (!positions || !positions.length) { el.textContent = text; return; }
  const hits = new Set(positions);
  let buf = "", marked = false;
  const flush = () => {
    if (!buf) return;
    if (marked) {
      const m = document.createElement("mark");
      m.className = "palette__hit";
      m.textContent = buf;
      el.appendChild(m);
    } else {
      el.appendChild(document.createTextNode(buf));
    }
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    if (hit !== marked) { flush(); marked = hit; }
    buf += text[i];
  }
  flush();
}

export function createCommandPalette({ getCommands, getBindings }) {
  const overlay = document.createElement("div");
  overlay.className = "palette";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="palette__panel" role="dialog" aria-label="Command palette">
      <input class="palette__input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"
             data-i18n-placeholder="palette.placeholder" placeholder="Type a command…" spellcheck="false" />
      <div class="palette__list" role="listbox"></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".palette__input");
  const list = overlay.querySelector(".palette__list");
  list.id = "palette-list";
  input.setAttribute("aria-controls", "palette-list");

  let commands = [];
  let entries = [];        // { cmd, title:number[], cat:number[], group:string }
  let rows = [];           // 与 entries 同序的 DOM 行，方向键只动 class
  let cursor = 0;
  let restoreFocus = null;

  function refresh() {
    const q = input.value.trim();
    const mru = readMru();
    if (!q) {
      // 空查询：最近用过的排前面并分组，其余保持注册顺序（那是作者排的，不是字典序）。
      const rank = new Map(mru.map((id, i) => [id, i]));
      const recent = commands.filter((c) => rank.has(c.id))
        .sort((a, b) => rank.get(a.id) - rank.get(b.id));
      const rest = commands.filter((c) => !rank.has(c.id));
      entries = [
        ...recent.map((cmd) => ({ cmd, title: [], cat: [], group: t("palette.recent") })),
        ...rest.map((cmd, i) => ({ cmd, title: [], cat: [], group: recent.length ? t("palette.others") : "" })),
      ];
    } else {
      const rank = new Map(mru.map((id, i) => [id, i]));
      entries = commands
        .map((cmd) => {
          const m = matchCommand(cmd, q);
          if (!m) return null;
          // 用过的在同分时浮上来，但加权很小——搜索结果的第一位应该由匹配质量决定。
          const bonus = rank.has(cmd.id) ? (MRU_MAX - rank.get(cmd.id)) * 2 : 0;
          return { cmd, title: m.title, cat: m.cat, score: m.score + bonus, group: "" };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    }
    cursor = 0;
    render();
  }

  function render() {
    list.innerHTML = "";
    rows = [];
    // 一次渲染取一次键位表。上一版按行取，27 行就把反向索引建了 27 遍。
    const bindings = getBindings ? (getBindings() || {}) : {};
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "palette__empty";
      empty.textContent = t("palette.noResults");
      list.appendChild(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    let lastGroup = null;
    entries.forEach((entry, i) => {
      if (entry.group && entry.group !== lastGroup) {
        const head = document.createElement("div");
        head.className = "palette__group";
        head.textContent = entry.group;
        list.appendChild(head);
      }
      lastGroup = entry.group;

      const cmd = entry.cmd;
      const row = document.createElement("div");
      row.className = "palette__item palette__item--cmd";
      row.id = `palette-opt-${i}`;
      row.setAttribute("role", "option");
      if (cmd.category) {
        const cat = document.createElement("span");
        cat.className = "palette__cat";
        fillHighlighted(cat, cmd.category, entry.cat);
        row.appendChild(cat);
      }
      const title = document.createElement("span");
      title.className = "palette__title";
      fillHighlighted(title, String(cmd.title || ""), entry.title);
      row.appendChild(title);

      // 键位表按动作 id 排，而命令 id 大多同名；view.terminal 那种改过名的自带 kb 指过去。
      const keys = bindings[cmd.kb || cmd.id];
      if (keys && keys.length) {
        const box = document.createElement("span");
        box.className = "palette__keys";
        for (const k of keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = k;
          box.appendChild(kbd);
        }
        row.appendChild(box);
      }

      row.addEventListener("mousemove", () => { if (cursor !== i) setCursor(i, false); });
      row.addEventListener("click", () => run(cmd));
      list.appendChild(row);
      rows.push(row);
    });
    setCursor(cursor, true);
  }

  /* 只改两行的 class。上一版这里调 render()，于是鼠标划过就整表重建。 */
  function setCursor(next, scroll) {
    if (!rows.length) return;
    rows[cursor]?.classList.remove("is-active");
    rows[cursor]?.removeAttribute("aria-selected");
    cursor = Math.max(0, Math.min(next, rows.length - 1));
    const row = rows[cursor];
    if (!row) return;
    row.classList.add("is-active");
    row.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", row.id);
    if (scroll !== false) row.scrollIntoView({ block: "nearest" });
  }

  function move(delta) {
    if (!rows.length) return;
    // 环绕。到底了还按下去就回第一条，这是这类面板的通行做法。
    setCursor((cursor + delta % rows.length + rows.length) % rows.length, true);
  }

  function run(cmd) {
    writeMru([cmd.id, ...readMru().filter((id) => id !== cmd.id)]);
    close();
    try {
      cmd.run();
    } catch (err) {
      console.error("[palette] command failed:", err);
    }
  }

  function open() {
    commands = getCommands();
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.value = "";
    input.placeholder = t("palette.placeholder");
    overlay.hidden = false;
    refresh();
    input.focus();
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    // 焦点还给打开它的那个元素，否则关掉之后焦点掉到 body 上，键盘用户就断线了。
    try { restoreFocus?.focus(); } catch { /* 元素已被移除 */ }
    restoreFocus = null;
  }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    const page = 10;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); setCursor(cursor + page, true); }
    else if (e.key === "PageUp") { e.preventDefault(); setCursor(cursor - page, true); }
    else if (e.key === "Home") { e.preventDefault(); setCursor(0, true); }
    else if (e.key === "End") { e.preventDefault(); setCursor(rows.length - 1, true); }
    else if (e.key === "Enter") { e.preventDefault(); if (entries[cursor]) run(entries[cursor].cmd); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  return { open, close };
}
