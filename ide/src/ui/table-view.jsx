import { useCallback, useMemo, useState } from "react";
import { cn } from "./lib/cn.js";

/**
 * The spreadsheet window — a real grid, not a wall of characters.
 *
 * 2026-09-05 视觉重做（第二版）：对标 Excel。列字母带（A/B/C）、行号槽、网格线、冻结表头与
 * 首列、活动单元格绿框、活动行列表头高亮、数字右对齐。文件图标用工作区那套真实 Material
 * 图标（csv 本来就是绿的），不再自绘。方言与编码是解析器的猜测，印在状态栏。
 *
 * Presentational — main.js owns the parse and the actions.
 */

const ALIGN = { number: "text-right tabular-nums", date: "tabular-nums", text: "" };

function colLetter(n) {
  let s = "";
  let i = n;
  for (;;) { s = String.fromCharCode(65 + (i % 26)) + s; if (i < 26) break; i = Math.floor(i / 26) - 1; }
  return s;
}

const IconSort = ({ dir }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3">
    {dir > 0 ? <path d="M7 14l5-5 5 5" /> : <path d="M7 10l5 5 5-5" />}
  </svg>
);
// 中性回退图标（应用里几乎总有真实图标，这里只作兜底，不上色）
const IconCsv = () => (
  <svg viewBox="0 0 24 24" fill="none" className="size-[18px]">
    <path d="M6 3.5h8L18.5 8v12.5H6z" fill="var(--xl-green)" fillOpacity="0.12" stroke="var(--xl-green)" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M14 3.5V8h4.5" stroke="var(--xl-green)" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M8.5 12.5h7M8.5 15h7M11.5 12v5" stroke="var(--xl-green)" strokeWidth="1.1" opacity="0.7" />
  </svg>
);
const IconReveal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-4">
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z" /><path d="M14 12l3-3M17 9v3M17 9h-3" />
  </svg>
);
const IconText = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-4">
    <path d="M6 4h9l3 3v13H6z" /><path d="M15 4v3h3M9 12h6M9 15h6M9 9h2" />
  </svg>
);

export function TableView({ table, file, iconFor, onOpenAsText, onReveal }) {
  const [sort, setSort] = useState(null);
  const [sel, setSel] = useState(null); // { r, c } 活动单元格；c=-1 整行

  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const allRows = Array.isArray(table?.rows) ? table.rows : [];
  const hasHeader = table?.has_header !== false && columns.some((c, i) => c?.name && c.name !== colLetter(i));
  const fileIcon = iconFor?.(file?.name || "data.csv", false) || null;

  const rows = useMemo(() => {
    let out = allRows;
    if (sort) {
      const { index, dir } = sort;
      const numeric = columns[index]?.kind === "number";
      out = [...out].sort((a, b) => {
        const x = a[index] ?? "", y = b[index] ?? "";
        if (numeric) {
          const nx = parseFloat(String(x).replace(/[^0-9.eE+-]/g, "")), ny = parseFloat(String(y).replace(/[^0-9.eE+-]/g, ""));
          if (Number.isNaN(nx) && Number.isNaN(ny)) return 0;
          if (Number.isNaN(nx)) return 1;
          if (Number.isNaN(ny)) return -1;
          return dir * (nx - ny);
        }
        return dir * String(x).localeCompare(String(y), undefined, { numeric: true });
      });
    }
    return out;
  }, [allRows, columns, sort]);

  const cycleSort = useCallback((index) => {
    setSort((s) => (!s || s.index !== index ? { index, dir: 1 } : s.dir === 1 ? { index, dir: -1 } : null));
  }, []);

  return (
    <div className="ui-island flex h-full w-full min-h-0 flex-col bg-[var(--panel-solid)] text-foreground">
      {/* 工具条 */}
      <div className="flex flex-none items-center gap-3 border-b border-[var(--line-strong)] bg-[var(--panel-2)] px-3.5 py-2">
        <span className="flex-none">
          {fileIcon ? <img src={fileIcon} alt="" draggable={false} className="size-[22px]" /> : <IconCsv />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" title={file?.name} data-i18n-skip>{file?.name || "表格"}</div>
          <div className="truncate text-[11px] tabular-nums text-muted-foreground">
            {Number(table?.total_rows || 0).toLocaleString()} 行 × {columns.length} 列{table?.count_is_partial ? "（至少）" : ""}
          </div>
        </div>
        {onOpenAsText ? (
          <button type="button" onClick={onOpenAsText} className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--popover-surface)] px-3 text-[12.5px] text-foreground transition-colors hover:bg-accent"><IconText />以文本打开</button>
        ) : null}
        {onReveal ? (
          <button type="button" onClick={onReveal} className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--popover-surface)] px-3 text-[12.5px] text-foreground transition-colors hover:bg-accent"><IconReveal />在系统中显示</button>
        ) : null}
      </div>

      {table?.note ? (
        <p className="flex-none border-b border-border bg-muted/40 px-4 py-2 text-[12px] leading-relaxed text-muted-foreground">{table.note}</p>
      ) : null}

      {/* 网格 */}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--popover-surface)]">
        <table className="w-full border-separate border-spacing-0 text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 h-[22px] w-11 border-b border-r border-[var(--line-strong)] bg-[var(--panel-2)]" />
              {columns.map((col, i) => (
                <th key={`L${i}`} onClick={() => cycleSort(i)}
                  className={cn("sticky top-0 z-20 h-[22px] min-w-[120px] cursor-pointer select-none border-b border-r border-[var(--line-strong)] px-3 text-center text-[11px] font-medium transition-colors hover:text-[var(--xl-green)]",
                    sel?.c === i ? "bg-[var(--xl-green-soft)] font-semibold text-[var(--xl-green)]" : "bg-[var(--panel-2)] text-muted-foreground")}
                  title={`${col.name} · ${col.kind}`}>{colLetter(i)}</th>
              ))}
            </tr>
            {hasHeader ? (
              <tr>
                <th className="sticky left-0 top-[22px] z-30 w-11 border-b border-r border-[var(--line-strong)] bg-[var(--panel-2)] px-2 py-1.5 text-right text-[11px] font-normal text-muted-foreground">1</th>
                {columns.map((col, i) => (
                  <th key={`H${i}`} onClick={() => { cycleSort(i); setSel({ r: -1, c: i }); }} title={`${col.name} · ${col.kind}`}
                    className={cn("sticky top-[22px] z-20 cursor-pointer select-none whitespace-nowrap border-b border-r border-[var(--line-strong)] bg-[var(--panel-2)] px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-[var(--xl-green-soft)]",
                      col.kind === "number" ? "text-right" : "text-left")}>
                    <span className="inline-flex items-center gap-1.5" data-i18n-skip>
                      <span className="truncate">{col.name}</span>
                      {sort?.index === i ? <span className="text-[var(--xl-green)]"><IconSort dir={sort.dir} /></span> : null}
                    </span>
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="border-r border-b border-[var(--line)] bg-[var(--panel-2)]" />
                <td colSpan={columns.length} className="border-b border-[var(--line)] px-4 py-12 text-center text-muted-foreground">这个表格是空的</td>
              </tr>
            ) : rows.map((row, r) => (
              <tr key={r} className="group">
                <td onClick={() => setSel({ r, c: -1 })}
                  className={cn("sticky left-0 z-10 w-11 cursor-pointer border-r border-b border-[var(--line-strong)] px-2 py-1.5 text-right text-[11px] tabular-nums",
                    sel?.r === r ? "bg-[var(--xl-green-soft)] font-semibold text-[var(--xl-green)]" : "bg-[var(--panel-2)] text-muted-foreground group-hover:text-foreground")}>{r + 1}</td>
                {columns.map((col, c) => {
                  const active = sel?.r === r && sel?.c === c;
                  const inSel = sel?.r === r || (sel?.c === c && sel?.r === -1);
                  return (
                    <td key={c} onClick={() => setSel({ r, c })}
                      className={cn("relative max-w-[460px] truncate border-r border-b border-[var(--line)] px-3 py-1.5 text-foreground", ALIGN[col.kind] || "", inSel && !active ? "bg-[var(--xl-green-soft)]/60" : "", active ? "z-[5] bg-[var(--xl-green-soft)]" : "group-hover:bg-black/[0.015]")}
                      style={active ? { outline: "2px solid var(--xl-green)", outlineOffset: "-2px" } : undefined}
                      title={row[c] || ""} data-i18n-skip>{row[c]}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 状态栏 */}
      <div className="flex flex-none items-center gap-4 border-t border-[var(--line-strong)] bg-[var(--panel-2)] px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {Number(table?.total_rows || 0).toLocaleString()} 行
          {table?.truncated ? `（已载入 ${allRows.length.toLocaleString()}）` : ""}
        </span>
        {sel && sel.r >= 0 && sel.c >= 0 ? <span className="tabular-nums" data-i18n-skip>{colLetter(sel.c)}{sel.r + 1}</span> : null}
        <span className="ml-auto tabular-nums" data-i18n-skip>分隔符 {table?.delimiter} · {table?.encoding}{table?.has_header ? " · 首行为表头" : " · 无表头"}</span>
      </div>
    </div>
  );
}
