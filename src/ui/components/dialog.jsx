import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import { t } from "../../i18n.js";

/**
 * Dialog —— 这是"必须用 React"的那一类组件。
 *
 * 纯 CSS 层能把 <dialog> 变好看，但给不了 Radix 这些：焦点捕获与归还、Esc 与点击遮罩
 * 关闭、打开时锁滚动、aria-modal / labelledby / describedby 的自动接线、以及把内容
 * portal 到 body 以躲开父级 overflow 和 z-index 陷阱。
 *
 * 遮罩用 bg-black/50 —— 这是新组件，不是改现有 .sheet，所以不违反"不动配色"：
 * 现有 22 个对话框还是原来的 rgba(0,0,0,.28)，一个像素没动。
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

/*
 * z-index 用本应用的模态层（100000），不是 Tailwind 默认的 z-50。
 *
 * 这个组件是照 shadcn 原样搬过来的，而 shadcn 的 z-50 是给一个"页面里最高只有几十层"的
 * 站点设计的。这个 IDE 不是：`.composer`（聊天输入框那一片）就是 z-index 60，于是
 * `/sessions` 的会话面板一打开，输入框、模型选择器、发送按钮全都压在面板上面——面板左下角
 * 被盖住一块，看着像渲染坏了。app.css 里所有原生浮层（.ctp-overlay / .about-dialog-overlay /
 * .remote-dialog-overlay …）用的都是 100000，这里跟上，整套 shadcn 对话框（会话选择器、
 * 记忆中心、组件画廊）一次性对齐。
 *
 * 遮罩和内容同一层：Radix 把它们渲染成同一个 portal 里的兄弟节点，内容在后面，同 z-index
 * 时自然压在遮罩之上——原来 z-50 时也是这么工作的。
 */
export function DialogOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-[100000] bg-black/50",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({ className, children, showCloseButton = true, ...props }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-[100000] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-lg sm:max-w-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none cursor-pointer"
          >
            <XIcon className="size-4" />
            {/* 读屏器念的就是这句：写死英文的话，中文界面里它是整个对话框唯一一处英文。 */}
            <span className="sr-only">{t("common.close") || "关闭"}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-none", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
