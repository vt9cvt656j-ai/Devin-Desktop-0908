# Michael Design Library — motion-micro-interactions

Control-level and component-level motion: cursor-following effects, hover and press feedback, expand/collapse, loading states, toasts, drawers, carousels and celebration moments. Each entry is named after the EFFECT a user asks for (中文效果名同列) and carries a copyable implementation with real numbers. 14 entries.

## Spotlight Card Following The Cursor — 鼠标跟随光晕 / 聚光灯卡片 / 光标辉光 [motion/spotlight-card-cursor-follow-radial-glow-mousemove]

A soft radial glow tracks the pointer across a card or a grid of cards. 用户说「鼠标跟着有个光」「聚光灯效果」「卡片跟随光晕」时要的就是这个。It is the single most requested "make it feel premium" effect and it costs almost nothing.

The whole trick is writing pointer position into two CSS custom properties and letting a `radial-gradient` read them, so no React state re-renders on mousemove:

```jsx
const onMove = (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`)
}
```

```css
.spotlight-card { position: relative; isolation: isolate; }
.spotlight-card::before {
  content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
  opacity: 0; transition: opacity .25s ease-out;
  background: radial-gradient(320px circle at var(--mx) var(--my),
              color-mix(in oklch, var(--primary) 18%, transparent), transparent 70%);
}
.spotlight-card:hover::before { opacity: 1; }
```

Numbers: radius 260–360px for a card, 480–600px for a full section. Accent mixed at 12–22% — above 25% it stops being a highlight and becomes a coloured wash. Fade the layer in over 200–260ms so entering the card is soft while the tracking itself stays instant.

Grid variant (the Magic UI "magic-card" pattern): attach one listener on the grid container and let each card read the same shared `--mx/--my` translated to its own box, so the glow appears to pass between neighbouring cards.

Register the properties for smooth interpolation where supported: `@property --mx { syntax: "<length>"; inherits: false; initial-value: 0px }`.

Touch devices have no hover — gate the whole effect behind `@media (hover: hover) and (pointer: fine)`. Under `prefers-reduced-motion: reduce` keep a static border highlight instead. This effect is decoration: it must never be the only affordance telling the user a card is interactive.

## 3D Tilt Card — 卡片 3D 倾斜 / 立体翻转 / 悬停歪一下 [motion/3d-tilt-card-perspective-rotate-hover-flip]

The card leans toward the cursor in three dimensions. 用户说「卡片 3D 翻转」「鼠标放上去会歪」「立体感的卡片」。

```css
.tilt-wrap { perspective: 900px; }
.tilt { transform: rotateX(var(--rx)) rotateY(var(--ry)) translateZ(0);
        transition: transform .18s ease-out; transform-style: preserve-3d; }
```

Compute normalised offsets from the card centre and clamp: `--ry = (x/w - .5) * 12deg`, `--rx = -(y/h - .5) * 12deg`. Maximum tilt 8–14 degrees; past 15 the text on the card becomes hard to read and the perspective distortion looks like a bug. Perspective 800–1000px — smaller values exaggerate wildly.

Reset on `mouseleave` with a slightly longer transition (300–400ms) than the tracking one, so leaving feels settled rather than snapped.

For an actual front/back flip (a different effect users also call 翻转): two faces with `backface-visibility: hidden`, the back pre-rotated `rotateY(180deg)`, parent toggling `rotateY(180deg)` over 500–600ms. The flipped face must be reachable by keyboard — bind the flip to `:focus-within` as well as `:hover`, and never hide essential content behind it.

Lift and shadow should move together: pair the tilt with `translateY(-2px)` and a shadow that grows from `0 1px 2px` to `0 12px 24px` at reduced alpha. Gate behind `@media (hover: hover)`, disable under reduced motion.

## Magnetic Button — 磁吸按钮 / 吸附跟随 [motion/magnetic-button-cursor-attraction-elastic-snap]

The button drifts a few pixels toward the cursor as it approaches, then snaps back. 用户说「按钮会吸过来」「磁吸效果」。

Displacement is the whole design: 6–10px maximum for a normal button, never more than 12. Compute `dx = (cursorX - centerX) * 0.25` inside a hit area padded ~40px beyond the button, and animate with a spring rather than a linear transition — Motion's `{ type: "spring", stiffness: 200, damping: 18 }` gives the elastic return that makes the effect read as magnetic instead of laggy.

Move the label with the button but at a lower factor (about 0.4x of the button's own displacement) so the two separate slightly; that parallax between shell and text is what sells it.

Apply this to at most one or two elements per page — the primary CTA and perhaps a logo. On a page where every button is magnetic, nothing feels special and pointer targeting genuinely suffers.

Hard requirements: `@media (hover: hover) and (pointer: fine)` only; full reset on blur and on `mouseleave`; never let the transform take the button more than half its own width off its layout position, or clicking near the edge misses. Reduced motion: no displacement, keep a colour/scale hover instead.

## Border Beam And Shine — 光束边框 / 描边流光 / 卡片扫光 [motion/border-beam-shine-conic-gradient-animated-border]

A bright dot or band travels around the border of a card or button. 用户说「边框有光在跑」「流光边框」「扫光」。The signature Magic UI effect (magicuidesign/magicui, 22.2k★, MIT — clean for commercial use, unlike some copy-paste kits that carry a Commons Clause rider forbidding redistribution).

Modern implementation with a registered angle property, no JS:

```css
@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg }
.beam { position: relative; border-radius: 12px; }
.beam::before {
  content:""; position:absolute; inset:-1px; border-radius:inherit; padding:1px;
  background: conic-gradient(from var(--angle), transparent 70%, var(--primary), transparent);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: spin 4s linear infinite;
}
@keyframes spin { to { --angle: 360deg } }
```

The mask-composite pair is what makes it a border and not a filled shape; without `@property` the angle cannot interpolate and the gradient jumps.

Numbers: cycle 3–6s; beam covering 20–30% of the perimeter; border width 1–1.5px. Run it on one or two focal elements only — a page of beaming borders looks like an error state.

Shine variant (a diagonal highlight sweeping across on hover): a skewed translucent band translated from -150% to 150% over 700–900ms, clipped by `overflow: hidden`. Trigger on hover, not on a loop, or it becomes wallpaper.

## Button And Control Feedback States — 按钮反馈 / 悬停按压 / 交互微动效 [motion/button-control-feedback-hover-press-focus-states]

The baseline every interactive element owes the user. 用户说「按钮没反应」「点着不跟手」时缺的通常是这一层，而不是什么炫效果。

The four states, with numbers that work at product scale:
- Hover: 120–160ms ease-out. Background one step darker/lighter, or `translateY(-1px)` with the shadow going from `0 1px 2px` to `0 4px 10px`. Do not scale a rectangular button — scaling blurs its text and shifts neighbours.
- Press (`:active`): 80–100ms, `translateY(0) scale(0.985)`. The press must be faster than the hover; a slow press feels disconnected from the finger.
- Focus-visible: a 2px ring at 2px offset in the accent colour. Never remove it, never replace it with the hover style — keyboard users need a state hover cannot express.
- Disabled: opacity 0.5, `cursor: not-allowed`, and no transition at all.

Icon buttons may translate their icon 1–2px in the direction of travel (`group-hover:translate-x-1` on a trailing arrow) — the most reliable "this goes somewhere" cue there is.

Loading: swap the label for a spinner while holding the button's exact width (measure before swap, or render the label invisible behind the spinner), otherwise the layout jumps and adjacent controls move under the pointer mid-click.

One easing (`cubic-bezier(0.16, 1, 0.3, 1)`) and one duration scale (`--duration-fast: 120ms`, `--duration: 200ms`, `--duration-slow: 320ms`) for the whole product. These four states apply to every genuinely interactive element — link, card, tab, row, chip — not only to things shaped like buttons.

## Accordion And Collapse — 手风琴展开 / 折叠面板 / 展开收起 [motion/accordion-collapse-expand-height-grid-rows]

Content expands and collapses smoothly. 用户说「手风琴展开」「点开收起有动画」「高度动画」。

`height: auto` is not animatable. Two correct solutions:

Grid rows (works everywhere today, no measurement):
```css
.collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease-out; }
.collapse[data-open="true"] { grid-template-rows: 1fr; }
.collapse > div { overflow: hidden; min-height: 0; }
```

`interpolate-size: allow-keywords` plus `transition: height` animates to `auto` natively in Chromium 129+; ship it inside `@supports` with the grid version as the fallback.

Numbers: 240–320ms opening, 200–260ms closing — closing slightly faster always reads better. Fade the content in over the last 60% of the open so text does not appear squeezed. Rotate the chevron 180deg over the same duration.

On Radix or Base UI primitives use the exposed CSS variables (`--radix-accordion-content-height`) and drive keyframes from `data-[state=open]` / `data-[state=closed]`; with Tailwind v4 the `tw-animate-css` package provides `data-[state=open]:animate-in` variants directly.

Accessibility: `aria-expanded` on the trigger and a real `<button>`. Never animate an element that currently has focus inside it out of view. Under reduced motion, snap open and closed instantly — instant is a perfectly good accordion.

## Ripple On Click — 波纹点击 / 水波扩散 [motion/ripple-click-material-radial-expand-pointer]

A circle expands from the exact point of contact. 用户说「点一下有波纹」「水波纹效果」。

Insert a span at the pointer coordinates, size it to the element's diagonal so it always covers the corner furthest from the click, scale from 0 to 1 over 500–600ms while fading opacity 0.35 → 0, then remove the node on `animationend`.

```js
const d = Math.hypot(rect.width, rect.height) * 2
span.style.cssText = `width:${d}px;height:${d}px;left:${x-d/2}px;top:${y-d/2}px`
```

The container needs `position: relative; overflow: hidden` and the ripple `pointer-events: none`, or the ripple swallows the second click of a double-click. Always remove the node — a long-lived toolbar accumulating ripple spans is a real memory leak.

Use ripples only in a Material-flavoured system. Mixed into a system whose other controls use lift-and-shadow feedback they read as a foreign object. Keep the press-state transform as well; ripple alone gives no feedback at the moment of contact, only after.

Reduced motion: skip the ripple and keep the press state.

## Skeleton And Shimmer Loading — 骨架屏 / 加载闪光 / 占位动画 [motion/skeleton-shimmer-loading-placeholder-pulse]

Grey placeholders shaped like the coming content, with a highlight sweeping across. 用户说「骨架屏」「加载的时候那个灰色闪一下」。

The skeleton must match the real layout box for box, including line count and the last line being shorter. A skeleton that does not match causes a visible reflow the moment data lands, which is worse than a spinner.

```css
.skeleton { background: linear-gradient(90deg, var(--muted) 25%, var(--muted-foreground)/.12 37%, var(--muted) 63%);
            background-size: 400% 100%; animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { from { background-position: 100% 0 } to { background-position: -100% 0 } }
```

Cycle 1.2–1.6s. A calm `opacity` pulse between 1 and 0.6 is equally acceptable and cheaper. Only animate `background-position` on a sized gradient, never `width`.

Rules: no skeleton for waits under ~300ms — show nothing, the flash is worse than the wait. Beyond ~3s a skeleton stops reassuring; move to a progress indication with real information. Mark the region `aria-busy="true"` and `aria-hidden` the skeleton nodes themselves.

Under reduced motion, keep the static grey blocks and drop the sweep. The information ("content is coming, here is its shape") survives without any movement at all.

## Toast Notification — 吐司提示 / 消息条 / 通知弹出 [motion/toast-notification-stack-swipe-promise-states]

A transient message slides in, stacks with its siblings and leaves. 用户说「右下角弹一条提示」「吐司」。

Use Sonner (emilkowalski/sonner, 12.9k★, MIT, ~9 kB, zero dependencies) on React; it is the de-facto standard and gets the hard parts right: stacking with scale/offset, swipe-to-dismiss, and the promise lifecycle. Vue and Svelte have well-maintained ports (`vue-sonner`, `svelte-sonner`).

```jsx
toast.promise(save(), { loading: "保存中…", success: "已保存", error: (e) => `保存失败：${e.message}` })
```

Numbers: enter 200–260ms from 16px below (or from the edge it docks to); exit 150–200ms; default dwell 4s, errors 6s or until dismissed — never auto-dismiss something the user must act on. Stack at most 3 visible, older ones scaled 0.95 and offset 8–14px behind.

Position bottom-right on desktop, top on mobile (bottom collides with the browser chrome and the thumb). Announce through a polite live region; an error toast should be `role="alert"`.

A toast is the wrong control for anything that must be read: destructive confirmations, form validation next to a field, or errors requiring a retry belong inline or in a dialog.

## Drawer And Bottom Sheet — 抽屉 / 底部弹出 / 侧边滑出 [motion/drawer-bottom-sheet-slide-drag-snap-points]

A panel slides in from an edge and can be dragged away. 用户说「底部滑上来那个」「抽屉」「侧边栏滑出」。

Vaul (emilkowalski/vaul, MIT) is the reference implementation for the mobile bottom sheet — drag-to-dismiss with velocity, snap points, background scale, and correct scroll locking. On desktop side panels, Radix or Base UI Dialog with a slide animation is enough.

Numbers: enter 280–350ms with a decelerating ease; exit 200–250ms. Dismiss threshold: dragged past 40% of the sheet height, or a flick faster than ~0.5 px/ms. The sheet must follow the finger 1:1 while dragging — any smoothing there feels broken — and only apply spring physics on release.

Mandatory: scroll lock on the body while open, focus trap inside, Escape closes, an overlay that also closes on click, and `overscroll-behavior: contain` on the scrollable content so dragging its bottom does not pull the page behind it. Snap points (say 40% and 92%) are worth it only when there is a genuine two-stage reading; otherwise one height is calmer.

Reduced motion: fade the panel and overlay in place over 150ms instead of sliding.

## Typewriter And Rotating Words — 打字机效果 / 文字轮播 / 逐字输入 [motion/typewriter-rotating-words-cursor-caret-cycle]

Text types itself out, often cycling through several phrases. 用户说「打字机效果」「文字一个个打出来」「标题轮流换词」。

Type at 45–70ms per character, delete at 25–35ms (deleting must be visibly faster), hold each completed phrase 1.4–2s. A blinking caret at 1s steps — `animation: blink 1s step-end infinite` — is what makes it read as typing rather than as a reveal.

Reserve the width. The classic defect is the headline reflowing on every character because the container hugs the text: measure the longest phrase and set `min-width`, or render all phrases stacked invisibly and absolutely position the animated one.

Accessibility: the animated node gets `aria-hidden="true"` and the full sentence (with every rotating option, or at least the primary one) lives in a visually hidden element. A screen reader must never receive a stream of one-character updates — with `aria-live` on the typing node it would announce the line dozens of times.

Use it for exactly one line per page, in the hero. Under `prefers-reduced-motion: reduce`, render the first phrase complete and static, caret included but not blinking.

## Confetti And Celebration — 彩带 / 撒花 / 庆祝动画 [motion/confetti-celebration-canvas-particles-success-moment]

Particles burst on a success moment. 用户说「成功了撒个花」「彩带」。

`canvas-confetti` (catdad/canvas-confetti, ISC, ~6 kB) remains the right tool: one function call, its own canvas, no React tree involvement.

```js
confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, disableForReducedMotion: true })
```

That last option is built in — use it rather than writing your own check.

Numbers: 80–150 particles, spread 60–90 degrees, origin slightly below centre so the burst rises into the viewport. One burst, or two staggered by ~150ms from opposite sides for a bigger moment. Never loop it.

Reserve it for genuine milestones — payment succeeded, onboarding finished, goal reached. Firing confetti on an ordinary save teaches the user to ignore it, and it is actively hostile in a tool people use all day. Import it lazily (`await import("canvas-confetti")`) at the moment of celebration so it never costs anything on first load.

For continuous ambient particle fields (a hero background rather than a moment) this is the wrong library; that is a `tsparticles` or a lightweight WebGL job, with a much stricter performance budget.

## Carousel And Snap Rail — 轮播 / 横向滑动 / 卡片滑轨 [motion/carousel-snap-rail-embla-scroll-snap-drag]

A horizontally scrollable row of cards with snapping. 用户说「轮播」「左右滑的卡片」「走马灯」。

For most cases no library is needed:
```css
.rail { display:flex; gap:1rem; overflow-x:auto; scroll-snap-type: x mandatory; scroll-padding-inline:1rem; }
.rail > * { flex: 0 0 min(78%, 340px); scroll-snap-align: start; }
```
Add `scrollbar-width: none` only if you provide visible arrow controls; removing the scrollbar without an alternative affordance hides the interaction entirely.

When you need drag with momentum, looping, autoplay or precise slide indices, use Embla Carousel (davidjerleke/embla-carousel, 8.4k★, MIT) — framework-agnostic core with React/Vue/Svelte wrappers, and the one shadcn/ui builds its Carousel on.

Numbers: snap transition 280–400ms; peek the next card by 12–20% so it is obvious the rail continues; autoplay, if used at all, at 5–7s and it must stop on hover, on focus and after any manual interaction, permanently.

Accessibility: arrows are real buttons with labels; the rail is keyboard-scrollable; if it autoplays, provide a pause control. Under reduced motion disable autoplay entirely and make snapping instant (`scroll-behavior: auto`).

## Animated Icons On Hover — 图标动效 / 图标悬停动画 [motion/animated-icon-hover-svg-stroke-pathlength-draw]

Icons come alive on hover — a stroke draws itself, an arrow nudges, a bell rings once. 用户说「图标动一下」「图标会动的那种」。

Two reliable techniques. Stroke drawing uses `pathLength` normalised to 1 so the same code works for any path length:

```css
path { stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset .5s ease-out; }
.group:hover path { stroke-dashoffset: 0; }
```
with `pathLength="1"` on the path element.

Transform nudges are simpler and used far more: `group-hover:translate-x-0.5` on an arrow, `group-hover:rotate-12` on a settings gear, `group-hover:scale-110` on a heart, all at 150–200ms.

`pqoqubbw/icons` (8.1k★, MIT) is a copy-paste set of Motion-animated Lucide icons — useful as reference implementations even when you only take the idea.

Restraint is the entire craft here: animate icons in navigation, feature cards and empty states; never in a dense toolbar or a data table, where a dozen twitching glyphs destroy scannability. Keep the motion under 250ms and make it settle — an icon that keeps looping while hovered becomes the only thing on screen.

Icons that carry state (a loading spinner, a play/pause toggle) are not decoration and must animate on state change, not on hover, with the state also exposed to assistive technology.
