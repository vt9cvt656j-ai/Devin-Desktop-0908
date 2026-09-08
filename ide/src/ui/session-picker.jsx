import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/dialog.jsx";
import { Input } from "./components/input.jsx";
import { cn } from "./lib/cn.js";
import { t } from "../i18n.js";
import { groupByDay, metaText, normalizeRoot, scopeEntries, sortNewestFirst, timeLabel } from "./session-list.js";

/**
 * `/sessions` — 浏览、恢复这个项目里的会话。
 *
 * 2026-09-07 所有者三条要求：最新的排上面；每个窗口只看自己这个项目的会话；换了文件夹要
 * 自动更新。加上截图里暴露的第四条——标题被运行时翻译器翻成「会议」、Resume 翻成「简历」，
 * 说明这块又是英文字面量靠现翻，文案改走 i18n 的 sessions.* 键。
 *
 * 形状照主流 AI 编辑器的「历史」列表：按天分组（今天 / 昨天 / 近 7 天 / 更早），一行一段对话，
 * 右侧只有时间，第二行是计数。**没有标签、没有常驻底色**：第一版给当前会话铺了浅底、每行右边
 * 挂「当前 / 可恢复」小标签、页脚写「N 个可恢复」，所有者指着截图说「悬浮这个样式挨一起丑死了」
 *「可恢复、当前太丑了」——当前行铺底之后鼠标一悬到隔壁行就是两块灰连在一起。现在当前会话只靠
 * 字重区分，底色只在悬停时出现一块。
 *
 * 只看当前项目是**固定行为**，没有切换条：第一版在搜索框旁放了「只看 X / 全部项目」两个按钮，
 * 所有者当场否掉（「不用显示这个，有这个的话就太丑了」）。没开文件夹时无从谈「这个项目」，
 * 才退成全部。
 *
 * 纯展示：排序 / 过滤 / 分组在 session-list.js 的纯函数里，main.js 拥有会话状态并按需重新
 * 喂一份 entries（根目录一变，mount 那层会重画）。
 */
const T = (key, fallback) => {
  const v = t(key);
  return v && v !== key ? v : fallback;
};

export function SessionPicker({ entries = [], root = "", onPick, onClose }) {
  const [query, setQuery] = useState("");
  const hasRoot = !!normalizeRoot(root);
  // 没开文件夹时「这个项目」无从谈起，退成全部。
  const effectiveScope = hasRoot ? "project" : "all";
  const labels = useMemo(() => ({
    yesterday: T("sessions.yesterday", "昨天"),
    turns: T("sessions.turns", "轮"), msgs: T("sessions.msgs", "条"),
    files: T("sessions.files", "文件"), corrections: T("sessions.corrections", "纠正"),
  }), []);

  const rows = useMemo(() => {
    const scoped = scopeEntries(entries, root, effectiveScope);
    const q = query.trim().toLowerCase();
    const hit = q ? scoped.filter((e) => (e.search || "").includes(q)) : scoped;
    return sortNewestFirst(hit);
  }, [entries, root, effectiveScope, query]);
  const now = Date.now();
  const groups = useMemo(() => groupByDay(rows, now), [rows, now]);
  const bucketLabel = {
    today: T("sessions.today", "今天"), yesterday: T("sessions.yesterday", "昨天"),
    week: T("sessions.week", "近 7 天"), older: T("sessions.older", "更早"),
  };
  const emptyText = entries.length === 0
    ? T("sessions.empty", "还没有会话")
    : query.trim()
      ? T("sessions.noMatch", "没有匹配的会话")
      : T("sessions.noneInProject", "这个项目下还没有会话");

  return (
    <Dialog defaultOpen onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogContent className="flex max-h-[calc(var(--eh,100vh)*0.8)] sm:max-w-2xl flex-col gap-0 overflow-hidden rounded-[14px] p-0 shadow-xl">
        <DialogHeader className="shrink-0 space-y-0.5 border-b border-border px-6 py-4">
          <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">{T("sessions.title", "会话")}</DialogTitle>
          {/* my-0：app.css 给 <p> 上了 12px 上下外边距，不清掉标题和分隔线之间会多出一截空档。 */}
          <DialogDescription className="my-0 text-[12px] leading-5">
            {T("sessions.subtitle", "更早的对话会压成摘要留在上下文里，不只是屏幕上还看得见的那些。")}
          </DialogDescription>
        </DialogHeader>

        {/* 搜索框和下面的会话行**一样宽**：行的底色（hover / 当前）铺到 px-3 那一列，搜索框也铺到同一列，
            框内文字自带 px-3 内边距，于是占位文字和行里的文字仍然对齐在 24px。所有者 2026-09-07 指着
            截图说「搜索框要和下面一样的长度」——之前这里是 px-6，框比行两边各缩进 12px，看着像没对齐。 */}
        <div className="flex shrink-0 items-center gap-2 overflow-y-auto px-3 pt-4 pb-2 [scrollbar-gutter:stable]">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={T("sessions.search", "搜索会话、项目、文件线索…")}
            className="h-8 flex-1 rounded-lg border-border bg-[var(--panel-2)] text-[12.5px] shadow-none focus-visible:border-[var(--line-strong)] focus-visible:ring-0"
          />
        </div>

        {/* 两个容器都留出同一条滚动条槽（scrollbar-gutter）：经典滚动条（Windows、或 mac 上「总是显示」）
            会占宽度，只给列表留槽的话行的右边会比搜索框缩进一条滚动条；覆盖式滚动条下槽宽为 0，两边照旧齐。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-gutter:stable]">
          {rows.length === 0 ? (
            <p className="px-3 py-12 text-center text-[12.5px] text-muted-foreground">{emptyText}</p>
          ) : (
            groups.map((g) => (
              <div key={g.bucket}>
                <div className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">{bucketLabel[g.bucket]}</div>
                {g.items.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => onPick?.(e)}
                    className={cn(
                      "group flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
                      // 底色只在悬停时出现：当前会话不铺常驻底，否则鼠标一到隔壁行就是两块灰挨在一起。
                      "hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: e.dot }} />
                      {/* 用户自己打的第一句话、项目目录名——是内容和标识，不是界面文案，绝不能翻译。 */}
                      <span className={cn("truncate text-[13px] text-foreground", e.active && "font-medium")} data-i18n-skip>
                        {e.name || T("sessions.untitled", "（未命名会话）")}
                      </span>
                      {/* 右边只留时间；当前会话靠标题的字重区分，不挂标签。 */}
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" translate="no">{timeLabel(e.at, now, labels)}</span>
                    </span>
                    {(() => {
                      // 只看这个项目时每一行的项目名都一样，印它是噪音；看全部时它才是区分度。
                      const meta = [metaText(e.stats, labels), effectiveScope === "all" ? e.project : ""].filter(Boolean).join(" · ");
                      return meta ? (
                        <span className="truncate pl-3.5 text-[11px] tabular-nums text-muted-foreground" data-i18n-skip translate="no">{meta}</span>
                      ) : null;
                    })()}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

      </DialogContent>
    </Dialog>
  );
}
