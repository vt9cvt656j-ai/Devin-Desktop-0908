# Michael Design Library — motion-scroll-ambient

Page-level motion blueprints. Each entry is named after the effect a user asks for, with a copyable implementation. 12 entries.

## Scroll Scrub Pinned Story — 滚动钉住叙事 / 滚动驱动动画 [motion/scroll-scrub-pin-storytelling-gsap-scrolltrigger]

The signature scroll moment: one section pins in place while its inner content advances as the reader scrolls. 用户说「滚动的时候画面跟着变」「钉住那一屏慢慢讲」「scroll storytelling」时要的就是这个。

Library: GSAP 3.15 + ScrollTrigger (greensock/GSAP, 28.3k★). Since Webflow acquired it every plugin including ScrollTrigger, SplitText, MorphSVG and ScrollSmoother is free for commercial use under the GSAP Standard "No Charge" License. In React always wrap in `useGSAP()` from `@gsap/react` — it reverts every tween on unmount, which plain `useEffect` does not.

Implementation contract:

```js
useGSAP(() => {
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: sectionRef.current,
      start: "top top",
      end: "+=2400",          // pin distance in px = how long the story lasts
      scrub: 1,               // 1 = one second of catch-up smoothing, not true/0
      pin: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
    },
  })
  tl.to(".panel-1", { autoAlpha: 0, y: -40 })
    .fromTo(".panel-2", { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0 }, "<0.2")
}, { scope: sectionRef })
```

Numbers that matter: `scrub: 1` (never `scrub: true` — it couples 1:1 to the scrollbar and reads jittery on trackpads); pin distance 1.5–3x viewport height for a 2–4 beat story; `anticipatePin: 1` removes the one-frame jump on fast scroll.

Mobile and accessibility: pinning fights momentum scrolling on iOS. Use `ScrollTrigger.matchMedia` or `gsap.matchMedia()` to drop pin below 768px and replace the story with the same panels stacked and revealed on enter. Under `prefers-reduced-motion: reduce` disable scrub entirely and show the final state.

Pair with Lenis 1.3 (darkroomengineering/lenis, 15.7k★, MIT, 5.3 kB gzip) for smooth scrolling; wire `lenis.on('scroll', ScrollTrigger.update)` and drive `lenis.raf` from `gsap.ticker`, otherwise the two run on different clocks and the pin drifts. Do not use smooth scroll on content-heavy product UI — it hurts keyboard users and motion-sensitive readers.

## Section Reveal On Enter With Stagger — 区块进场 / 逐个浮现 / 渐显上移 [motion/section-reveal-enter-stagger-intersection-observer]

The workhorse: every section fades and rises a little as it enters the viewport, and its children arrive one after another. 用户说「往上浮出来」「一个一个出现」「进场动画」时要的是这个。This is the one motion pattern that belongs on essentially every page, and the one most often overdone.

Numbers: distance 16–24px on desktop, 10–12px on mobile. Duration 400–600ms. Easing `cubic-bezier(0.16, 1, 0.3, 1)` — one easing for the whole page. Children stagger 60–120ms; above 8 children cap total stagger at 600ms or the last card arrives after the reader already looked at it. Trigger once (`once: true`); replaying on scroll-up is the fastest way to make a page feel cheap.

React with Motion 13.2 (motiondivision/motion, 33.5k★, MIT):

```jsx
<motion.section
  initial={{ opacity: 0, y: 20 }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, amount: 0.25 }}
  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
>
  <motion.div variants={{ visible: { transition: { staggerChildren: 0.08 } } }}>…</motion.div>
</motion.section>
```

Zero-dependency version: one `IntersectionObserver` with `rootMargin: "0px 0px -10% 0px"` toggling a class, plus a CSS transition. On Tailwind v4 projects `tw-animate-css` (Wombosvideo/tw-animate-css, MIT, 25.3M weekly downloads — the highest of any animation package) gives `animate-in fade-in slide-in-from-bottom-4` utilities with no runtime JS; shadcn/ui ships with it by default now that `tailwindcss-animate` is unmaintained.

Never hand-write this per section. Build one `<Reveal>` / `<SectionReveal>` wrapper and use it everywhere, so the whole page shares one duration scale. Under `prefers-reduced-motion` reduce to opacity-only at 200ms and drop the translate.

## Parallax Depth Layers — 视差滚动 / 前后景错位 [motion/parallax-depth-layers-usescroll-usetransform]

Background moves slower than foreground, creating depth. 用户说「视差」「背景动得慢一点」「有层次感的滚动」。

Motion for React:

```jsx
const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] })
const y = useTransform(scrollYProgress, [0, 1], ["0%", "18%"])
return <motion.img style={{ y }} />
```

Budget: displacement 10–20% of the element height. Past 25% the layer visibly outruns its container and the seams show. Two or three depth planes maximum — every extra layer is another repaint band.

Pure CSS alternative with zero JS, now Baseline: `animation-timeline: view()` with `animation-range: entry 0% cover 60%`. Supported in Chrome/Edge 115+ and Safari 26+; Firefox is behind a flag as of 2026-09, so ship it as progressive enhancement inside `@supports (animation-timeline: view())` and let the static layout stand everywhere else.

Performance: only animate `transform` and `opacity`. A parallax on `background-position` or `top` repaints the whole layer every frame. Add `will-change: transform` on the moving layer only while it is in view, never globally.

Mobile: remove parallax below 768px. On a phone the viewport is short, the effect reads as jitter, and it competes with momentum scroll. `prefers-reduced-motion: reduce` removes it entirely.

## Sticky Stacking Cards — 卡片堆叠 / 层叠推进 [motion/sticky-stacking-cards-scroll-scale]

Cards stack on top of one another as you scroll, each one scaling down slightly as the next covers it. 用户说「卡片一张张叠上来」「层叠效果」。

Pure CSS skeleton, no library needed:

```css
.card { position: sticky; top: 12vh; }
.card:nth-child(1) { --i: 1 } /* … */
.card { transform: scale(calc(1 - (var(--n) - var(--i)) * 0.04)); transform-origin: top center; }
```

Add scroll-linked scale with `animation-timeline: view()` where supported, or `useScroll` + `useTransform` per card. Gap between sticky tops 8–14vh; scale step 0.03–0.05 per card behind; 3–5 cards, never more — past five the back of the stack is invisible and you are paying for nothing.

Each card needs an opaque surface or the stack reads as a smear. Give the top card a slightly stronger shadow than the ones behind it so the depth cue matches the scale cue.

Mobile: keep the stack but reduce scale step to 0.02 and top offset to 6vh; on very short viewports fall back to a plain vertical list. Reduced motion: plain list, no sticky.

## Scroll Progress Indicator — 阅读进度条 / 滚动进度 [motion/scroll-progress-indicator-reading-bar]

A thin bar at the top of the viewport that fills as the reader advances. Standard on long-form articles and documentation. 用户说「顶上的进度条」「读到哪了」。

Zero JavaScript, Baseline since 2024 in Chromium and Safari 26:

```css
@keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
.progress {
  position: fixed; inset-block-start: 0; inset-inline: 0; height: 3px;
  transform-origin: left; animation: grow linear both;
  animation-timeline: scroll(root block);
}
```

Fallback for Firefox: one passive `scroll` listener writing a CSS custom property, throttled with `requestAnimationFrame`. Do not compute layout in the handler — read `document.documentElement.scrollTop / scrollHeight` only.

Height 2–4px. Use the brand accent at full strength; this is one of the few places a saturated accent line is correct because it carries information. Add `@media (prefers-reduced-motion: reduce) { animation: none }` and keep the bar static at its current value — progress is information, so unlike decorative motion it should degrade to a visible state rather than disappear.

## Ambient Gradient Mesh Aurora — 氛围光斑 / 极光背景 / 呼吸光晕 [motion/ambient-gradient-mesh-aurora-blur-blob]

Soft coloured shapes drifting slowly behind the content, giving a flat page atmosphere without imagery. 用户说「背景有那种流动的光」「极光」「氛围感」。

Recipe: 2–4 absolutely positioned blobs, `filter: blur(64px)` (Tailwind `blur-3xl`), opacity 0.20–0.35, each on its own keyframe loop of 18–28s with different delays so they never sync. Animate `transform: translate3d()` and `scale()`, never `filter` or `background-position` — animating a blur radius forces a full re-rasterise every frame and will pin a laptop fan.

```css
@keyframes drift { 0%,100% { transform: translate3d(0,0,0) scale(1) } 50% { transform: translate3d(6%, -4%, 0) scale(1.12) } }
.blob { position:absolute; border-radius:9999px; filter: blur(64px); opacity:.28; animation: drift 22s ease-in-out infinite; }
```

Contain the layer: wrap in `overflow: hidden` with `isolation: isolate`, and keep contrast of the text above it at 4.5:1 against the *lightest* point of the animation, not the average.

For a richer version, Paper Shaders (paper-design/shaders, MIT) gives WebGL mesh gradients as React components at a fraction of hand-rolled Three.js; budget it as an above-the-fold-only cost and give it a static gradient fallback for `prefers-reduced-motion` and for `navigator.hardwareConcurrency <= 4`.

Never put drifting blobs behind dense text or data tables — reserve them for hero and CTA bands.

## Logo Wall Marquee — 跑马灯 / 无缝滚动 / logo 墙 [motion/logo-wall-marquee-infinite-scroll-seamless]

A row of customer logos or tags scrolling continuously and seamlessly. 用户说「logo 一直往左滚」「跑马灯」「无缝循环」。

The only correct structure is two identical tracks side by side, translating by exactly -50% of the pair:

```css
.marquee { display:flex; width:max-content; animation: slide 30s linear infinite; }
.marquee:hover { animation-play-state: paused; }
@keyframes slide { to { transform: translateX(-50%) } }
```

Duplicate the child list exactly once in markup (or with `aria-hidden="true"` on the clone so screen readers do not read logos twice). Speed 25–40s per cycle for 8–14 logos; faster than 20s reads as frantic.

Edge treatment: `mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent)` so logos fade at both ends instead of being cut by the container.

Pause on hover is mandatory — a reader who wants to look at one logo must be able to. Under `prefers-reduced-motion: reduce`, replace with a static wrapped grid; on mobile also prefer the static grid, since a 375px viewport shows two logos at a time and the motion is all the user perceives.

## Ken Burns Hero Media — 缓慢推近 / 背景慢放大 [motion/ken-burns-hero-slow-zoom-scale-drift]

The hero image drifts and zooms almost imperceptibly, so a static photograph feels alive. 用户说「背景图慢慢放大」「有点动但不打扰」。

Scale 1 → 1.06 over 14–20 seconds, `ease-in-out`, `alternate infinite`. Above 1.08 the crop visibly changes and text can collide with a moving subject. Pair with a slight translate (≤2%) so the movement is not purely radial.

```css
@keyframes kenburns { from { transform: scale(1) translate3d(0,0,0) } to { transform: scale(1.06) translate3d(-1.5%, 1%, 0) } }
.hero-media { animation: kenburns 18s ease-in-out infinite alternate; will-change: transform; }
```

Always on the media element inside an `overflow: hidden` container with an explicit `aspect-ratio`, never on a background-image of the section itself — otherwise the overlay text inherits the transform.

Keep the text overlay perfectly still. The whole effect depends on only one thing moving. Under reduced motion, freeze at `scale(1.02)` so the composition still matches the designed crop.

## Word And Character Reveal — 文字逐字浮现 / 逐词揭示 / 标题打散动画 [motion/word-character-text-reveal-splittext-stagger]

The headline arrives word by word or letter by letter. 用户说「文字一个一个出来」「标题逐字浮现」「文字动画」。

GSAP SplitText (now free) is the reliable splitter because it handles line wrapping, `masks: "lines"` for the clipped-from-below look, and it restores the original DOM on revert:

```js
const split = SplitText.create(h1Ref.current, { type: "words,lines", mask: "lines" })
gsap.from(split.words, { yPercent: 110, opacity: 0, duration: 0.7,
  ease: "power3.out", stagger: 0.045, scrollTrigger: { trigger: h1Ref.current, start: "top 85%", once: true } })
```

Motion for React equivalent: split in JS, map each word to a `motion.span` with `initial={{ y: "110%" }}` inside a parent with `overflow: hidden`, and `staggerChildren: 0.045`.

Numbers: per-word stagger 35–60ms; per-character only for headlines under ~20 characters, and then 15–25ms. Duration per unit 500–700ms. Reveal from 100–110% below inside a clipping mask reads far more crafted than a plain fade.

Accessibility is the part everyone gets wrong: splitting a heading into spans destroys it for screen readers. Put the original string in `aria-label` on the heading and `aria-hidden="true"` on the split container. Under `prefers-reduced-motion` do not split at all — render the plain heading.

## Animated Number Count Up — 数字滚动 / 数字增长 / 翻牌计数 [motion/animated-number-count-up-odometer-tabular]

Metrics count up when the stat band scrolls into view. 用户说「数字滚动上去」「数据跳动」「计数动画」。

Use `number-flow` (barvian/number-flow, 7.7k★, MIT) rather than hand-rolling: it is a Web Component with React/Vue/Svelte wrappers, animates digit by digit like an odometer, and — the reason it wins — it formats through `Intl.NumberFormat`, so currency, percentages, compact notation and locale separators all stay correct mid-animation.

```jsx
<NumberFlow value={value} format={{ notation: "compact", maximumFractionDigits: 1 }} />
```

Hand-rolled fallback: `requestAnimationFrame` easing from 0 to target over 1.2–1.8s with `easeOutExpo`, triggered once by IntersectionObserver.

Always set `font-variant-numeric: tabular-nums` on the number, or the layout shifts on every frame as glyph widths change. Duration 1.2–2s; longer and the reader has moved on. Round to the precision you actually display — animating to 1,247,392 and showing "1.2M" wastes the effect.

Reduced motion: render the final value immediately. A number that never arrives is a bug, not a graceful degradation.

## Scroll Linked Image Sequence — 滚动帧序列 / 产品 360 展示 [motion/scroll-linked-image-sequence-canvas-product-walkthrough]

Scrolling scrubs through a pre-rendered frame sequence, the technique behind product-launch pages that appear to rotate an object as you scroll. 用户说「滚动的时候产品转起来」「像苹果官网那样」。

Draw to a `<canvas>`, never to 100+ `<img>` tags. Preload frames into an array, and on ScrollTrigger `onUpdate` draw `frames[Math.round(progress * (count - 1))]`.

Budget honestly: 60–120 frames at 1280px wide WebP is 2–6 MB. That is a hero-only cost. Ship a `<link rel="preload">` for the first frame, render it as a static poster immediately, and only start the sequence once enough frames are decoded. Below 768px either drop to a 24-frame version or replace with a single still — mobile data budgets do not survive this effect.

For true 3D instead of pre-rendered frames use React Three Fiber 9.7 (pmndrs/react-three-fiber, 32.2k★, MIT) with drei's `useScroll`; a glTF model with Draco compression is often smaller than the frame sequence and stays sharp at any viewport. Either way give it a loading state, a WebGL-unsupported fallback, and verify frame timing on a mid-range phone, not only on the development machine.

## Page And Route Transitions — 页面转场 / 路由切换动画 / 元素飞过去 [motion/page-route-transition-view-transitions-shared-element]

Navigating between pages morphs shared elements instead of cutting. 用户说「点进去详情页那个图片飞过去」「页面切换过渡」「共享元素」。

The View Transitions API is the zero-dependency answer and reached Baseline newly available on 2025-10-14 when Firefox 144 shipped it. The old WICG/view-transitions repository was archived on 2026-08-21; the live specification now lives in the CSS Working Group drafts, so link users to the CSS spec, not the archived repo.

```js
document.startViewTransition(() => updateTheDOM())
```

```css
.card-image { view-transition-name: hero-image; } /* same name on both pages */
::view-transition-old(hero-image), ::view-transition-new(hero-image) { animation-duration: .35s; }
```

Every `view-transition-name` must be unique per document at the moment of the transition, otherwise the whole transition is skipped silently — assign the name only to the item being navigated, then clear it.

Cross-document transitions (plain multi-page sites) need `@view-transition { navigation: auto }` in both documents, same-origin.

Where you need an interruptible, drag-following transition, View Transitions is the wrong tool — a snapshot-based transition cannot be reversed mid-flight. Use Motion's `layoutId` for shared-element morphing that stays interactive. Duration 300–400ms; longer makes navigation feel slow, which is the opposite of the goal. Under `prefers-reduced-motion`, skip the transition and navigate instantly.
