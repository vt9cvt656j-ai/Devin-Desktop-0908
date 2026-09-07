import { cn } from "./lib/cn.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/tooltip.jsx";

/**
 * The `/` command palette above the prompt box.
 *
 * Built in shadcn's Command language rather than the old `.atmenu` markup it shared with the
 * @-file picker. That sharing is why it looked the way it did: the @-menu's proportions
 * (18px container radius, 12px rows, 9px/12px padding) are right for file rows with icons and
 * directory paths, and far too loose for two words of text. It also inherited the @-menu's blue
 * `is-active` wash, which made every command read as a link.
 *
 * The command is rendered without its leading `/` — the slash is already visible in the input
 * the user just typed, so repeating it in every row is noise.
 *
 * Colour comes from the theme bridge in tailwind.css (bg-popover / text-foreground /
 * bg-accent / text-muted-foreground), so this follows light and dark with no variant of its own.
 *
 * # 两层盒子，不是一层
 *
 * 外层画边框、圆角、阴影并且**不滚**；内层 `.slashmenu-scroll` 才是滚动容器，高度上限由
 * `_updateSlashMenu` 按输入条上方的真实空间算好、写进 `--slash-max-h`。写成一层的话滚动一起
 * 带走边框，圆角会在滚动时被切掉半个。
 *
 * # 每一行都能悬停看全文
 *
 * 描述那一列是 `truncate` 的——技能的说明动辄一两句话，再加上 `参数：…` 的提示，列表里
 * 只能看到开头。装好三十个技能时这不是「偶尔截断」，是**大多数行都看不全**。所以每一行
 * 挂一个 tooltip，把命令名和完整描述原样摆出来。Provider 在 island.jsx 里已经包好了。
 */
export function SlashMenu({ items = [], activeIndex = 0, onPick, onHover }) {
  if (!items.length) return null;
  return (
    <div
      role="listbox"
      aria-label="Commands"
      className="overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <div className="slashmenu-scroll p-1">
        {items.map((item, i) => {
          const active = i === activeIndex;
          return (
            <Tooltip key={item.cmd}>
              <TooltipTrigger asChild>
                <div
                  role="option"
                  aria-selected={active}
                  // 键盘上下选中时把当前行滚进可见区。面板现在有高度上限，不做这一步的话
                  // 按方向键选到第十几行，选中态在看不见的地方移动，看上去像按键没反应。
                  ref={active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  // mousedown, not click: the prompt's blur handler closes this menu, and blur lands
                  // before click would. preventDefault keeps focus in the textarea.
                  onMouseDown={(event) => { event.preventDefault(); onPick?.(i); }}
                  onMouseEnter={() => onHover?.(i)}
                  className={cn(
                    "flex cursor-default select-none items-baseline gap-2 rounded-md px-2 py-1.5",
                    "text-[13px] leading-5 transition-colors",
                    active ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  {/* The command name is a literal you TYPE, not UI copy. The auto-localizer would
                      otherwise render `sessions` as 会话 — which cannot be typed to run anything.
                      Same category as the model picker's entries in AUTO_I18N_SKIP_SELECTOR, and
                      excluded the same way. The description beside it is copy and still translates. */}
                  <span className="shrink-0 font-medium" data-i18n-skip>{item.cmd}</span>
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">{item.desc}</span>
                </div>
              </TooltipTrigger>
              {/* 往左弹：助手栏贴着窗口右缘，往右没有地方。撞到边缘时 Radix 自己会翻面。 */}
              <TooltipContent side="left" align="start" sideOffset={10} className="max-w-[360px] whitespace-normal break-words">
                <span className="font-medium" data-i18n-skip>/{item.cmd}</span>
                {item.desc ? <span className="mt-0.5 block leading-relaxed opacity-90">{item.desc}</span> : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
