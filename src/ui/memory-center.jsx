import { useCallback, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/dialog.jsx";
import { Button } from "./components/button.jsx";
import { cn } from "./lib/cn.js";
import { t } from "../i18n.js";

/**
 * 记忆 —— 核心层、项目记忆、全局偏好。
 *
 * 2026-09-07 第二版（所有者连否两次：「太丑了」，要求照几家主流 AI 编辑器的设置页去做，
 * 并点名「关系图彻底删除」）。
 *
 * 被否掉的两种形状，记下来免得再走回去：
 *   · **3D 网络地球**：占掉整整一个栏目，看着热闹，但没人靠它办事——已连同 main.js 里那份
 *     命令式 WebGL（_mcGlobeInit / _mcScatter，约 145 行）和它的样式一起删干净。
 *   · **左侧栏 + 标签页**：只有三段内容却撑起一根 176px 的空栏，右边再塞一页表单。
 *
 * 这一版的形状：**一页到底、分段、无标签栏**（主流 AI 编辑器的「规则」页就是这么排的）。每段是
 * 「标题 + 一句人话 + 一块编辑区」，段与段之间一条发丝线；清空这类破坏性动作放在**它所属
 * 那一段的标题行右边**，而不是页脚——页脚只留一个保存，一次把三段都存了。
 *
 * 文案全部走 i18n 的 memory.* 键。上一版是英文字面量靠运行时翻译器现翻，同一屏里
 * 「记忆 / 保存」翻了而「Core / Graph / One entry per line…」没翻，中英混排是它看着廉价的
 * 头号原因。
 */
/** 宿主记下的记忆流水。只报数，不下判断。 */
const STAT_ROWS = [
  ["core.user", "memory.stat.coreUser", "核心条目（所有项目）"],
  ["core.project", "memory.stat.coreProject", "核心条目（这个项目）"],
  ["render.core", "memory.stat.renderCore", "带上核心块的轮次"],
  ["capture.core.accepted", "memory.stat.captured", "从你的话里记下的核心条目"],
  ["reflect.opened", "memory.stat.reflectOpened", "收尾时回看过记忆的轮次"],
  ["reflect.accepted", "memory.stat.reflectAccepted", "那些回看写下的条目"],
  ["retrieve.kg.hit", "memory.stat.kgHit", "检索到相关记忆的轮次"],
  ["retrieve.kg.empty", "memory.stat.kgEmpty", "没有相关记忆的轮次"],
  ["retrieve.ep.hit", "memory.stat.epHit", "命中过往任务的轮次"],
  ["retrieve.wf.hit", "memory.stat.wfHit", "命中工作流的轮次"],
];

/** 缺键时回落到中文原文：漏一个键不该让界面出现一串 memory.xxx。 */
const T = (key, fallback) => {
  const v = t(key);
  return v && v !== key ? v : fallback;
};
/** 有内容的行数。空行不算 —— 这个数是给人看「记了几条」的，不是字符统计。 */
const countLines = (s) => String(s || "").split("\n").filter((l) => l.trim()).length;

const EDITOR = cn(
  // 底色比面板深一档（--panel-2），读起来是一块**凹进去的输入区**，而不是一个描边的空方框。
  "w-full resize-none rounded-lg border border-border bg-[var(--panel-2)] px-3 py-2.5",
  "font-mono text-[12px] leading-6 text-foreground outline-none transition-colors",
  "placeholder:text-muted-foreground/60",
  "hover:border-[var(--line-strong)] focus:border-[var(--line-strong)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** 一段：标题行（标题 + 可选动作 + 行数）、一句人话、内容。 */
function Section({ title, desc, count, action, first, children }) {
  return (
    <section className={first ? "" : "border-t border-border pt-5"}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          {count != null ? (
            <span className="text-[11px] tabular-nums text-muted-foreground" translate="no">
              {count} {T("memory.lines", "行")}
            </span>
          ) : null}
        </div>
      </div>
      {desc ? <p className="my-0 mt-1 text-[12px] leading-5 text-muted-foreground">{desc}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** 段标题行右边那个「清空」：文字按钮，悬停才变红 —— 破坏性动作不该一直在视野里发红。 */
function ClearButton({ disabled, onClick, children }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className="h-6 rounded-md px-2 text-[11.5px] font-normal text-muted-foreground hover:bg-transparent hover:text-destructive"
    >
      {children}
    </Button>
  );
}

export function MemoryCenter({
  hasRoot,
  initialProject,
  initialGlobal,
  initialCore,
  memoryStats,
  onSaveCore,
  onSave,
  onClearProject,
  onClearGlobal,
  onClose,
}) {
  const [project, setProject] = useState(initialProject ?? "");
  const [global, setGlobal] = useState(initialGlobal ?? "");
  const [coreUser, setCoreUser] = useState(initialCore?.user ?? "");
  const [coreProject, setCoreProject] = useState(initialCore?.project ?? "");

  // 一个保存按钮把三段一起存。分页保存那一版每段各存各的，用户改了两段却只存下当前那段，
  // 而界面上没有任何地方说过这件事。
  const saveAll = useCallback(() => {
    onSaveCore?.(coreUser, coreProject);
    onSave?.(project, global);
  }, [coreUser, coreProject, project, global, onSaveCore, onSave]);

  const stats = STAT_ROWS.filter(([k]) => memoryStats?.[k] != null);
  const noFolder = T("memory.noFolder", "还没打开文件夹");

  return (
    <Dialog defaultOpen onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogContent className="flex h-[calc(var(--eh,100vh)*0.78)] sm:max-w-2xl flex-col gap-0 overflow-hidden rounded-[14px] p-0 shadow-xl">
        <DialogHeader className="shrink-0 space-y-0.5 border-b border-border px-6 py-4">
          <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">{T("memory.title", "记忆")}</DialogTitle>
          {/* my-0：app.css 给 <p> 上了 12px 上下外边距，不清掉的话标题和分隔线之间会多出一截空档。 */}
          <DialogDescription className="my-0 text-[12px] leading-5">
            {T("memory.subtitle", "每行一条。项目记忆只在当前项目生效，偏好设置跟着你走。")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <Section
            first
            title={T("memory.core.title", "核心记忆")}
            desc={`${T("memory.core.hint", "每一轮都在上下文里。写规则和偏好，别写笔记 —— 越短越管用。")}${T("memory.core.tagHint", "以 [你记的] 开头的是助手写的，删掉标记就当作你自己的。")}`}
            count={countLines(coreUser) + countLines(coreProject)}
          >
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-foreground">{T("memory.everyProject", "所有项目")}</div>
                <textarea
                  className={EDITOR}
                  rows={4}
                  spellCheck={false}
                  value={coreUser}
                  onChange={(e) => setCoreUser(e.target.value)}
                  placeholder={T("memory.core.minePlaceholder", "回复用中文\n答案短一点，先说结论")}
                />
              </div>
              <div>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[12px] font-medium text-foreground">{T("memory.thisProject", "这个项目")}</span>
                  {!hasRoot ? <span className="text-[11px] text-muted-foreground">{noFolder}</span> : null}
                </div>
                <textarea
                  className={EDITOR}
                  rows={4}
                  spellCheck={false}
                  disabled={!hasRoot}
                  value={coreProject}
                  onChange={(e) => setCoreProject(e.target.value)}
                  placeholder={T("memory.core.projectPlaceholder", "目标：给一家影院做订票站\n接口前缀是 /api/v2\n金额一律存分")}
                />
              </div>
            </div>
          </Section>

          <Section
            title={T("memory.tab.memory", "项目记忆")}
            desc={hasRoot
              ? T("memory.project.hint", "只在这个项目里生效，按相关性检索 —— 用不上的那几轮不会占上下文。")
              : noFolder}
            count={countLines(project)}
            action={hasRoot ? (
              <ClearButton onClick={() => { setProject(""); onClearProject?.(); }}>
                {T("memory.clear", "清空")}
              </ClearButton>
            ) : null}
          >
            <textarea
              className={EDITOR}
              rows={6}
              spellCheck={false}
              disabled={!hasRoot}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder={T("memory.project.placeholder", "这个项目用 pnpm\n界面走 shadcn/ui")}
            />
          </Section>

          <Section
            title={T("memory.tab.preferences", "偏好设置")}
            desc={T("memory.prefs.hint", "跟着你走，换项目也在。写做事的方式，不写这个项目的事实。")}
            count={countLines(global)}
            action={(
              <ClearButton onClick={() => { setGlobal(""); onClearGlobal?.(); }}>
                {T("memory.clear", "清空")}
              </ClearButton>
            )}
          >
            <textarea
              className={EDITOR}
              rows={6}
              spellCheck={false}
              value={global}
              onChange={(e) => setGlobal(e.target.value)}
              placeholder={T("memory.prefs.placeholder", "有一说一，别糊弄\n说「修好了」之前先自己验一遍")}
            />
          </Section>

          {stats.length ? (
            <Section title={T("memory.usage", "使用情况")}>
              {/* 一行一条、右侧对齐的数字。两栏各自收边：`last:` 只作用于 DOM 里的最后一个，
                  两栏布局下会出现「右栏收了线、左栏没收」的错位。 */}
              <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {stats.map(([k, key, fallback]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5">
                    <dt className="truncate text-[11.5px] text-muted-foreground">{T(key, fallback)}</dt>
                    <dd className="shrink-0 text-[12px] font-medium tabular-nums text-foreground" translate="no">{memoryStats[k]}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end border-t border-border px-6 py-3">
          {/* 主按钮跟着应用那对近黑/近白，不用品牌蓝 —— 发送按钮 2026-09-01 就定过这件事：
              一出现 iOS 系统蓝，整块就读成「系统控件」而不是这个产品自己的界面。 */}
          <Button
            size="sm"
            className="h-8 rounded-lg bg-[var(--send-bg)] px-4 text-[12.5px] font-medium text-[var(--send-fg)] shadow-none hover:opacity-90"
            onClick={saveAll}
          >
            {T("memory.save", "保存")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
