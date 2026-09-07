import { useCallback, useMemo, useState } from "react";
import { cn } from "./lib/cn.js";

/**
 * The archive window. Opening a `.zip` gives you this and nothing else.
 *
 * 2026-09-05 视觉重做（第二版）：对标 Windows 资源管理器 / 专业解压工具，克制到底。文件与
 * 目录图标用工作区那套真实 Material 图标（`iconFor`），不再自绘上色；去掉了压缩率的装饰
 * 进度条（改成朴素百分比）；行更紧、更平，选中是一整行浅色。名称 / 类型 / 大小 / 压缩后 /
 * 压缩率 明细列，folders 汇总其下所有内容，第一屏就能看出「里面什么大」。
 *
 * Presentational — main.js owns the listing and the actions.
 */

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = v / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function typeLabel(name, isDir) {
  if (isDir) return "文件夹";
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  const map = {
    js: "JavaScript", ts: "TypeScript", jsx: "JSX", tsx: "TSX", json: "JSON", py: "Python", rs: "Rust", go: "Go",
    java: "Java", c: "C", h: "C 头文件", cpp: "C++", cs: "C#", rb: "Ruby", php: "PHP", swift: "Swift", kt: "Kotlin",
    html: "HTML", css: "CSS", scss: "SCSS", md: "Markdown", txt: "文本", xml: "XML", yml: "YAML", yaml: "YAML", toml: "TOML",
    png: "PNG 图片", jpg: "JPEG 图片", jpeg: "JPEG 图片", gif: "GIF 图片", svg: "SVG 图片", webp: "WebP 图片", ico: "图标",
    pdf: "PDF 文档", doc: "Word 文档", docx: "Word 文档", xls: "Excel 表格", xlsx: "Excel 表格", ppt: "PPT", pptx: "PPT",
    zip: "压缩包", gz: "压缩包", tar: "归档", "7z": "压缩包", rar: "压缩包", jar: "Java 归档", so: "动态库", dylib: "动态库",
    dll: "动态库", exe: "可执行", bin: "二进制", wasm: "WebAssembly", ttf: "字体", otf: "字体", woff: "字体", woff2: "字体",
    mp4: "视频", mov: "视频", mp3: "音频", wav: "音频", lock: "锁文件",
  };
  return map[ext] || (ext ? `${ext.toUpperCase()} 文件` : "文件");
}

/** Immediate children of `cwd`, folders rolling up everything beneath them. */
function levelAt(entries, cwd) {
  const prefix = cwd ? `${cwd}/` : "";
  const folders = new Map();
  const files = [];
  for (const entry of entries) {
    const name = String(entry?.name || "").replace(/\/+$/, "");
    if (!name || (prefix && !name.startsWith(prefix))) continue;
    const rest = name.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (!entry?.is_dir) files.push({ ...entry, label: rest, isDir: false });
    } else {
      const label = rest.slice(0, slash);
      const folder = folders.get(label) || { label, isDir: true, size: 0, compressed: 0, count: 0 };
      folder.size += Number(entry?.size) || 0;
      folder.compressed += Number(entry?.compressed_size) || 0;
      if (!entry?.is_dir) folder.count += 1;
      folders.set(label, folder);
    }
  }
  return [...folders.values(), ...files];
}

const COLUMNS = [
  { key: "label", label: "名称", align: "left" },
  { key: "type", label: "类型", align: "left", width: "w-32", nosort: true },
  { key: "size", label: "大小", align: "right", width: "w-24" },
  { key: "compressed", label: "压缩后", align: "right", width: "w-24" },
  { key: "ratio", label: "压缩率", align: "right", width: "w-20" },
];

// 中性回退图标（应用里几乎总有真实 Material 图标；这里不上色，只作兜底）
const IconFolderFallback = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="size-[18px] text-muted-foreground">
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);
const IconFileFallback = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="size-[18px] text-muted-foreground">
    <path d="M6 3.5h8L18.5 8v12.5H6z" /><path d="M14 3.5V8h4.5" />
  </svg>
);
const IconHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-3.5"><path d="M4 11l8-6 8 6M6 10v9h12v-9" /></svg>
);
const IconReveal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-4"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z" /><path d="M14 12l3-3M17 9v3M17 9h-3" /></svg>
);
const IconExtract = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-4"><path d="M12 3v10M8 9l4 4 4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" /></svg>
);
const IconSort = ({ dir }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3">{dir > 0 ? <path d="M7 14l5-5 5 5" /> : <path d="M7 10l5 5 5-5" />}</svg>
);

function EntryIcon({ url, isDir }) {
  if (url) return <img src={url} alt="" draggable={false} className="mr-2.5 size-[18px] shrink-0 align-[-4px]" />;
  return <span className="mr-2.5 inline-flex align-[-4px]">{isDir ? <IconFolderFallback /> : <IconFileFallback />}</span>;
}

export function ArchiveBrowser({ archive, file, iconFor, onOpenEntry, onExtract, onReveal }) {
  const [cwd, setCwd] = useState("");
  const [sort, setSort] = useState({ key: "label", dir: 1 });
  const [selected, setSelected] = useState(null);
  const entries = Array.isArray(archive?.entries) ? archive.entries : [];
  const zipIcon = iconFor?.(file?.name || "archive.zip", false) || null;

  const rows = useMemo(() => {
    const level = levelAt(entries, cwd).map((row) => ({ ...row, size: Number(row.size) || 0, compressed: Number(row.compressed ?? row.compressed_size) || 0 }));
    const { key, dir } = sort;
    return level.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (key === "label") return dir * a.label.localeCompare(b.label, undefined, { numeric: true });
      if (key === "ratio") { const ra = a.size ? a.compressed / a.size : 0, rb = b.size ? b.compressed / b.size : 0; return dir * (ra - rb); }
      return dir * ((a[key] || 0) - (b[key] || 0));
    });
  }, [entries, cwd, sort]);

  const crumbs = cwd ? cwd.split("/") : [];
  const here = useMemo(() => {
    const files = rows.filter((r) => !r.isDir).length;
    return { files, dirs: rows.length - files, size: rows.reduce((n, r) => n + r.size, 0) };
  }, [rows]);

  const enter = useCallback((label) => { setCwd((c) => (c ? `${c}/${label}` : label)); setSelected(null); }, []);
  const toggleSort = useCallback((key) => { setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "label" ? 1 : -1 })); }, []);

  return (
    <div className="ui-island flex h-full min-h-0 flex-col bg-[var(--panel-solid)] text-foreground">
      {/* 标题条 */}
      <div className="flex flex-none items-center gap-2.5 border-b border-[var(--line-strong)] bg-[var(--panel-2)] px-3.5 py-2.5">
        <span className="flex-none">
          {zipIcon ? <img src={zipIcon} alt="" draggable={false} className="size-[26px]" /> : <IconFileFallback />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold" title={file?.name} data-i18n-skip>{file?.name || "压缩包"}</div>
          <div className="truncate text-[11px] text-muted-foreground tabular-nums">
            <span className="uppercase" data-i18n-skip>{archive?.format || "archive"}</span>{" · "}{formatBytes(file?.size)}
            {archive?.total_size ? ` · 解压后 ${formatBytes(archive.total_size)}` : ""}{archive?.encrypted ? " · 含加密条目" : ""}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {onReveal ? (
            <button type="button" onClick={onReveal} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--popover-surface)] px-3 text-[12.5px] text-foreground transition-colors hover:bg-accent"><IconReveal />在系统中显示</button>
          ) : null}
          <button type="button" onClick={() => onExtract?.()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-[filter] hover:brightness-110"><IconExtract />全部解压…</button>
        </div>
      </div>

      {/* 地址栏 */}
      <div className="flex flex-none items-center gap-0.5 overflow-x-auto border-b border-border bg-[var(--panel-2)] px-2.5 py-1.5 text-[12px]">
        <button type="button" onClick={() => { setCwd(""); setSelected(null); }}
          className={cn("inline-flex flex-none items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-accent", cwd ? "text-muted-foreground hover:text-foreground" : "font-medium text-foreground")}><IconHome />根目录</button>
        {crumbs.map((part, i) => (
          <span key={`${part}-${i}`} className="flex flex-none items-center gap-0.5">
            <span className="text-muted-foreground">›</span>
            <button type="button" onClick={() => { setCwd(crumbs.slice(0, i + 1).join("/")); setSelected(null); }}
              className={cn("max-w-[220px] truncate rounded px-2 py-1 transition-colors hover:bg-accent", i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")} data-i18n-skip>{part}</button>
          </span>
        ))}
      </div>

      {archive?.note ? (
        <p className="flex-none border-b border-border bg-muted/40 px-4 py-2 text-[12px] leading-relaxed text-muted-foreground">{archive.note}</p>
      ) : null}

      {/* 明细列表 */}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--popover-surface)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--panel-2)]">
              {COLUMNS.map((col) => (
                <th key={col.key} onClick={col.nosort ? undefined : () => toggleSort(col.key)}
                  className={cn("select-none border-b border-[var(--line-strong)] px-3.5 py-1.5 text-[11.5px] font-medium text-muted-foreground", col.nosort ? "" : "cursor-pointer transition-colors hover:text-foreground", col.align === "right" ? "text-right" : "text-left", col.width)}>
                  <span className={cn("inline-flex items-center gap-1", col.align === "right" ? "flex-row-reverse" : "")}>{col.label}{!col.nosort && sort.key === col.key ? <span className="text-primary"><IconSort dir={sort.dir} /></span> : null}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-muted-foreground">这一层是空的</td></tr>
            ) : rows.map((row) => {
              const key = `${row.isDir ? "d" : "f"}:${row.label}`;
              const ratio = row.size && row.compressed ? Math.round((row.compressed / row.size) * 100) : null;
              return (
                <tr key={key} onClick={() => setSelected(key)} onDoubleClick={() => (row.isDir ? enter(row.label) : onOpenEntry?.(row.name))}
                  className={cn("cursor-default transition-colors", selected === key ? "bg-primary/12" : "hover:bg-black/[0.028] dark:hover:bg-white/[0.035]")}
                  title={row.isDir ? `${row.count} 个文件 · 双击进入` : "双击预览"}>
                  <td className="max-w-0 truncate px-3.5 py-1"><span className="inline-flex items-center"><EntryIcon url={iconFor?.(row.isDir ? row.label : row.name || row.label, row.isDir)} isDir={row.isDir} /><span className="truncate" data-i18n-skip>{row.label}</span></span></td>
                  <td className="px-3.5 py-1 text-left text-muted-foreground" data-i18n-skip>{typeLabel(row.label, row.isDir)}</td>
                  <td className="px-3.5 py-1 text-right tabular-nums">{formatBytes(row.size)}</td>
                  <td className="px-3.5 py-1 text-right tabular-nums text-muted-foreground">{row.compressed ? formatBytes(row.compressed) : "—"}</td>
                  <td className="px-3.5 py-1 text-right tabular-nums text-muted-foreground">{ratio === null ? "—" : `${ratio}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 状态栏 */}
      <div className="flex flex-none items-center gap-4 border-t border-[var(--line-strong)] bg-[var(--panel-2)] px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{here.dirs} 个文件夹 · {here.files} 个文件 · {formatBytes(here.size)}</span>
        <span className="ml-auto tabular-nums" data-i18n-skip>
          共 {archive?.count_is_partial ? "至少 " : ""}{Number(archive?.total || 0).toLocaleString()} 项
          {archive?.truncated ? `（已载入 ${entries.length}）` : ""}{archive?.metadata_entries ? ` · ${archive.metadata_entries} 个附属条目` : ""}
        </span>
      </div>
    </div>
  );
}
