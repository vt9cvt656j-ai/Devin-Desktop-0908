# Michael Design Library — components-primitives

Single-control blueprints (单个组件 / 控件蓝本): sizing scale, variant API, the full state matrix, keyboard and ARIA contract, and component-level motion parameters for each primitive. Use these when the task is "make me one component", not a whole page. 12 entries.

## Button Primitive — 按钮组件 / 主次按钮 / 变体与状态 [components/button-variants-sizes-states-cva-loading]

The control every design system is judged by. 用户说「做一个按钮组件」「按钮要几种样式」时，要的是下面这张完整矩阵，不是一个 class 串。

Variant API with `class-variance-authority`, the shape shadcn/ui uses and the one worth copying:

```ts
const button = cva("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0", {
  variants: {
    variant: { default:"bg-primary text-primary-foreground hover:bg-primary/90",
               secondary:"bg-secondary text-secondary-foreground hover:bg-secondary/80",
               outline:"border border-input bg-background hover:bg-accent hover:text-accent-foreground",
               ghost:"hover:bg-accent hover:text-accent-foreground",
               link:"text-primary underline-offset-4 hover:underline",
               destructive:"bg-destructive text-destructive-foreground hover:bg-destructive/90" },
    size: { sm:"h-8 px-3 text-xs", md:"h-9 px-4", lg:"h-10 px-6", icon:"size-9 p-0" },
  },
  defaultVariants: { variant: "default", size: "md" },
})
```

Sizing scale: heights 32 / 36 / 40px. Horizontal padding roughly 1.5x the vertical rhythm. Icon-only buttons are square at the same height — never a rectangle with a centred glyph. Minimum touch target 44x44 on coarse pointers; pad the hit area with a pseudo-element rather than growing the visual box.

The six states, every variant, no exceptions: rest, hover (120–160ms colour shift), active (80–100ms, `scale(0.985)`), focus-visible (2px ring at 2px offset — never removed, never merged into hover), disabled (opacity 0.5, no transition, `aria-disabled` rather than the `disabled` attribute when the button must stay focusable to explain why), and loading.

Loading is where most implementations break the layout: measure and hold the button's width, render a spinner in place of the label, keep the label text present but visually hidden so the accessible name survives, and set `aria-busy="true"`.

Contract: render a real `<button>` with an explicit `type`; support `asChild` (Radix `Slot`) so it can become a link without losing the styling; an icon-only button requires `aria-label`; the accessible name must state the action ("Delete project", not "Delete" plus context the screen reader never receives).

## Text Input And Textarea — 输入框组件 / 文本框状态 [components/text-input-textarea-states-validation-affix]

```ts
const input = cva("flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background placeholder:text-muted-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive")
```

Heights match the button scale exactly (32 / 36 / 40px) — an input and a button side by side that differ by 2px is the most common visual defect in hand-built forms.

States: rest, hover (border one step stronger), focus (ring, and border to the accent), filled, invalid (`aria-invalid="true"` driving the border, plus a message wired by `aria-describedby`), disabled, read-only (distinct from disabled: read-only stays focusable and copyable, and should not be greyed out).

Never use placeholder as the label. Placeholder disappears on input, fails contrast at typical greys, and is invisible to some assistive tech. Label above, 6–8px gap. Helper text and error text occupy the same slot below — reserve its height so the form does not jump when an error appears.

Affixes (a leading icon, a trailing unit, a clear button) live inside the border, absolutely positioned, with matching padding added to the input so text never slides under them. The clear button is a real button with `aria-label`, tab-reachable.

Textarea: `min-height` of 3 lines, `field-sizing: content` where supported for auto-grow (Chromium 123+), otherwise a small JS auto-resize on input. `resize-y` only — horizontal resize breaks every layout.

Validate on blur and on submit, never on every keystroke: telling someone their email is invalid while they are still on the third character is the most disliked interaction in forms.

## Select And Combobox — 下拉选择 / 搜索选择器 [components/select-combobox-listbox-keyboard-typeahead]

A native `<select>` is the correct answer whenever you only need single choice from a short list — it is accessible, it works on every device, and mobile gets the platform picker for free. Reach for a custom listbox only when you genuinely need search, multi-select, rich option rows, or async loading.

For the custom case build on a headless primitive (Radix Select, Base UI Select, or `cmdk` for the command-palette style) rather than hand-rolling — the keyboard and focus behaviour below is where hand-rolled versions always fall short.

Keyboard contract that must hold: Enter or Space or ArrowDown opens; ArrowUp/ArrowDown move the active option and scroll it into view; Home/End jump to first and last; typing letters does type-ahead with a ~500ms reset; Enter selects; Escape closes and returns focus to the trigger; Tab closes and moves on. The trigger carries `aria-expanded`, `aria-haspopup="listbox"` and `aria-controls`; the active option carries `aria-selected` and is pointed at by `aria-activedescendant`.

Sizing: trigger height matches the input scale. Popover width matches the trigger by default (`--radix-select-trigger-width`); let it exceed only when option text genuinely needs it. Cap the list at 8–10 visible rows and scroll — a 40-item dropdown that covers the viewport is unusable.

Motion: 150–180ms fade with a 4px rise and `transform-origin` at the trigger edge, driven from `data-[state=open]`. Under 120ms it flickers; over 250ms it feels sticky on a control people open repeatedly.

Empty and loading states are part of the component, not an afterthought: "No results" with the current query echoed, and a skeleton row set while options load.

## Dialog And Modal — 对话框 / 弹窗组件 [components/dialog-modal-focus-trap-overlay-escape]

Sizing: `max-w-md` for a confirmation, `max-w-lg`/`max-w-2xl` for a form, `max-h-[85vh]` with the body scrolling and the header and footer pinned. On mobile below 640px go full-height or convert to a bottom sheet; a centred modal on a 375px viewport wastes the edges and puts actions under the keyboard.

Structure is fixed: title (the accessible name, wired via `aria-labelledby`), optional description (`aria-describedby`), scrollable body, action row. Actions bottom-right on desktop with the primary action last; stacked full-width on mobile with the primary on top.

Non-negotiable behaviour: focus moves into the dialog on open (to the first field, or the dialog itself — not to the close button, and never to a destructive action); focus is trapped while open; Escape closes; focus returns to the element that opened it; the page behind is inert and does not scroll; the overlay closes on click only when there is no unsaved input.

Motion: overlay fades 150ms; panel 180–220ms with `scale(0.97) → 1` and an 8px rise. Exit slightly faster than enter. Anything longer makes a confirm dialog feel like it is loading.

A destructive confirmation names the object and the consequence in the title ("Delete 3 projects?"), puts the irreversible detail in the body, and labels the button with the verb ("Delete"), never "OK". The safe action is the default focus.

Use `<dialog>` with `showModal()` where the stack allows — the top layer, the focus trap and Escape come from the platform, and `@starting-style` now animates the entry natively without a JS mount delay.

## Tabs — 标签页组件 / 选项卡 [components/tabs-roving-focus-indicator-panels]

Sizing: trigger height 32–36px, horizontal padding 12–16px, gap 4px in a pill container or 24px on an underline row. The indicator is 2px for underline, or a filled pill with the same radius as the container minus its padding.

Keyboard contract: the tab list is a single tab stop (roving `tabindex`) — Tab enters the active tab and the next Tab leaves the whole list to the panel. ArrowLeft/ArrowRight move between tabs, Home/End jump to ends. Default to automatic activation (selecting on arrow) for cheap panels; use manual activation (arrow moves, Enter selects) when switching triggers a fetch. Roles: `tablist`, `tab` with `aria-selected` and `aria-controls`, `tabpanel` with `aria-labelledby` and `tabIndex={0}` so its content is reachable.

Motion: the indicator slides between tabs over 200–250ms with `cubic-bezier(0.16,1,0.3,1)`. With Motion, one `layoutId` on the indicator gives this for free and handles resizes correctly. Panel content cross-fades over 150ms — do not slide panels horizontally unless the tabs represent a real sequence; lateral movement implies order that tabs usually do not have.

Overflow on narrow viewports: make the list horizontally scrollable with `scroll-snap-align` on each trigger and mask both edges. Never wrap tabs to a second line, and never collapse them into a select without keeping the current label visible.

Tabs must not hide content the user needs to compare, and the selected tab must survive a reload when it is meaningful state (put it in the URL).

## Data Table — 数据表格组件 / 列表密度 [components/data-table-density-sorting-selection-sticky]

Density scale, which is the first decision: comfortable (row 52px, cell padding 16px), default (44px / 12px), compact (36px / 8px). Ship at least default and compact and let the user switch — anyone reading a table all day wants compact, anyone glancing at five rows wants comfortable.

Column rules: numbers right-aligned with `font-variant-numeric: tabular-nums`; text left; the primary identifier column sticky on horizontal scroll; actions in a trailing column of fixed width, not floating over content. Header row sticky with an opaque background and a bottom hairline — a header that becomes transparent over scrolling rows is a classic defect.

States that must all exist: loading (skeleton rows matching the real column widths, never a centred spinner that collapses the layout), empty (an explanation and the primary action that would create the first row), error with retry, no-results-for-filter (distinct from empty — it must offer to clear the filter), and row selection.

Sorting: the whole header cell is the button; show the direction with an arrow and set `aria-sort="ascending" | "descending" | "none"`. Selection: header checkbox with an indeterminate state, `aria-label` per row checkbox naming the row, and a selection bar that appears with a 150ms rise reporting the count and the bulk actions.

Row hover 100ms background only — never lift or scale a row; the whole grid ripples. Keep row height constant across states; a table that reflows as you move down it is exhausting to read.

Pagination or virtualisation past ~200 rows. Under `prefers-reduced-motion` remove the selection-bar transition and keep everything instant.

## Form Field Composition — 表单字段 / 标签描述错误 [components/form-field-label-description-error-contract]

The wrapper that makes every control in a form behave consistently. This is the piece hand-built forms almost always skip, and it is why their accessibility fails.

Anatomy and order: label → optional description → control → error or helper. Label 13–14px medium, `htmlFor` bound to the control id. Description 12–13px muted, above the control (it informs the answer, so it must be read before the field, and `aria-describedby` order follows DOM order). Error 12–13px in the destructive colour, below.

The wiring contract: one generated id per field; `aria-describedby` listing the description id and, when present, the error id; `aria-invalid="true"` on the control when invalid; `aria-required` only where the visual asterisk also appears. Never rely on colour alone for the error — an icon or the text itself must carry it.

Reserve the message row's height (`min-height: 1.25rem`) so validation does not shift the form. Group related controls in a `<fieldset>` with a `<legend>`; a radio group without one is unlabelled for screen readers no matter how obvious it looks.

Required vs optional: mark whichever set is smaller, and say which convention you used at the top of the form.

Submission: disable the submit button only while the request is in flight (never as a "form is invalid" signal — that hides why), move focus to the first invalid field on failed submit, and announce the summary through a live region. On success, the confirmation must not be a toast alone if the user needs to act on it.

Vertical rhythm: 16–20px between fields, 28–36px between groups. Labels and controls left-aligned on one axis; two-column forms only for genuinely short paired values such as city and postcode.

## Card Component — 卡片组件 / 可点击卡片 [components/card-surface-elevation-clickable-affordance]

Anatomy: media (fixed `aspect-ratio`, never a bare `<img>` that reflows), header (title + optional meta), body, footer actions. Padding 16px compact / 20–24px default, consistent on all four sides; a card with 24px top and 16px bottom reads as a mistake even when nobody can name it.

Surface craft rather than a heavy drop shadow: one step of background elevation from the page, a 1px hairline border at low alpha, radius from the token scale (usually 8–12px), and a shadow so soft it only separates edges (`0 1px 2px` at rest). Save real elevation for overlays.

Interactive cards have three requirements most implementations miss. The whole card must be the target, not just the title — use a stretched pseudo-element over the card from the real link (`::after { position:absolute; inset:0 }`) so the accessible name stays on the link and the card stays one tab stop. Secondary actions inside the card need `position: relative; z-index: 1` to escape that overlay. And the card needs `:focus-within` styling matching its hover state, or keyboard users get no feedback at all.

Hover for interactive cards only: `translateY(-2px)` plus shadow `0 1px 2px` → `0 8px 20px` over 160ms. Never scale a card containing text. A static card must have no hover state whatsoever — a hover on something unclickable is a lie.

Card grids: count the cards before choosing the grid (2 → two columns, 3 → three, 4 → 2x2, 5 → 3+2 centred or a lead card spanning). Equalise heights with `grid-auto-rows: 1fr` and push the footer down with `mt-auto`, so a shorter card does not leave its action floating mid-box.

## Badge Tag And Chip — 徽章 / 标签 / 状态点 [components/badge-tag-chip-status-semantic-removable]

Three different controls people call the same thing, and mixing them up is why status colours end up meaningless.

Badge is read-only status: height 20–22px, padding 2px 8px, radius full or 4px, text 11–12px medium. Semantic colours (success / warning / danger / info / neutral) come from a role scale that is separate from the brand accent — a page where the accent also means "success" cannot express either.

Tag is a category label, usually neutral and often many at once: same size, neutral surface, no colour coding unless the taxonomy itself is colour-coded.

Chip is interactive — removable or toggleable. Height 24–28px because it needs a target; the remove control is a real button with `aria-label="Remove <name>"`, minimum 20px, and removing one must move focus to the next chip or the input, never to `<body>`.

Status must not be colour-only: pair the colour with a dot, an icon, or the word itself. A red and a green badge are identical to a large share of users, and both are grey when printed.

Motion: chips animate in and out over 150ms (opacity plus a 4px rise). For a list of chips, `useAutoAnimate` from `@formkit/auto-animate` (formkit/auto-animate, 13.9k★, MIT, 6.8 kB) gives correct add/remove/reorder transitions in one line and is the right amount of machinery for this.

Never put a badge inside a heading in a way that changes the heading's accessible name, and never encode a count in a badge without also exposing it in text for assistive tech.

## Tooltip And Popover — 提示气泡 / 浮层定位 [components/tooltip-popover-positioning-delay-dismiss]

Tooltip is a short label for a control; popover is a container for content and controls. They differ in behaviour, and conflating them produces overlays keyboard users can never reach.

Tooltip: opens on hover and on focus, closes on blur, on leave, and on Escape. Open delay 400–700ms, close delay ~100ms with a shared "group" timer so moving between adjacent icons does not re-wait. Never put interactive content in one — a link inside a hover-only tooltip is unreachable by keyboard and by touch. Content must be short; if it needs a paragraph, it is a popover. `role="tooltip"` and `aria-describedby` from the trigger; do not use `aria-label` as well or the name is overwritten.

Popover: opens on click, traps nothing but returns focus on close, closes on Escape and outside click. The native `popover` attribute plus `popovertarget` now gives top-layer rendering, light-dismiss and focus handling with no JavaScript, and CSS Anchor Positioning handles placement where supported; fall back to Floating UI for browsers without anchor positioning.

Positioning rules for both: 6–8px offset from the trigger; flip to the opposite side when it would overflow; shift along the cross axis to stay in view; keep an 8px minimum from the viewport edge; the arrow, if present, stays within the trigger's bounds.

Motion: 120–160ms fade with a 4px translate from the trigger's direction, `transform-origin` set to the anchor edge. Tooltips should feel instant once the delay has elapsed.

On touch there is no hover: either the information moves into the interface permanently, or the trigger becomes a tap-to-open popover. A tooltip-only affordance does not exist on a phone.

## Switch Checkbox And Radio — 开关 / 勾选框 / 单选 [components/switch-checkbox-radio-toggle-states-group]

Choose by semantics, not by looks: switch = takes effect immediately (a setting); checkbox = a value to be submitted, and the only one of the three that supports an indeterminate state; radio = exactly one from a set, always in a group with a legend.

Sizes: switch 36x20 or 44x24 with a thumb inset 2px; checkbox and radio 16px or 20px. All three need a 44px touch target — expand the hit area with padding on the label, not by enlarging the visual control. The label is always clickable and bound with `htmlFor`.

States for each: rest, hover (surface or border one step), focus-visible (ring on the control, never on the whole row), checked, indeterminate (checkbox only, `el.indeterminate = true` — it is a property, not an attribute, and it cannot be set from HTML), disabled, and invalid for required groups.

Motion: switch thumb travels over 180–220ms with `cubic-bezier(0.16,1,0.3,1)`, the track colour crossfading over the same duration; the thumb may overshoot ~1px on a spring but must not bounce visibly. Checkbox draws its tick with `stroke-dasharray`/`stroke-dashoffset` over 150ms — a tick that fades in reads cheaper than one that draws. Under reduced motion both snap.

A switch must never require a separate save action, and it must reflect the server state after the request — optimistic toggling is fine, but a failure has to visibly revert with an explanation, or the user believes a setting is on when it is not.

## Empty State — 空状态 / 首次使用 / 无结果 [components/empty-state-first-run-no-results-error-distinct]

Three different screens people build as one, and merging them is why products feel unfinished.

First run (nothing exists yet): explain what this area is for in one sentence, show the primary creation action as a filled button, and optionally a secondary "import" or "see an example" path. This is the highest-leverage empty state in the product and deserves an illustration or a diagram, not a shrug icon.

No results (filters or search returned nothing): echo the query back, offer to clear the filters as a real button, and suggest the nearest broader search. Never show the first-run copy here — telling someone who just searched that they have no projects, when they have four hundred, reads as a bug.

Error (loading failed): say what failed in one sentence, keep it non-technical, and give a retry button. Preserve whatever was already on screen instead of replacing the whole region when possible.

Layout: centred column, `max-width` around 380–420px, 48–64px vertical padding, icon or illustration 48–96px, title 16–18px semibold, body 13–14px muted, one primary action. Do not fill the space with a large decorative image that pushes the action below the fold.

Motion: a 200ms fade with an 8px rise on mount is enough. Never animate an empty state repeatedly or loop an illustration — it is a state the user may sit in while thinking.

Accessibility: the empty state replaces content, so it must be announced. Put it in the same live region as the results count, and make sure the primary action receives focus order that matches its visual position.
