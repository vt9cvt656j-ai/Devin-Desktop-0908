# Michael Design Library — motion-library-stack

Which animation library to reach for, verified against the real repositories in September 2026. 6 entries.

## Choosing An Animation Library — 动画库选型 / 用哪个动画库 [motion/animation-library-selection-decision-matrix-2026]

The decision is mostly settled in 2026, and the biggest change is how much no longer needs a library at all. 用户问「用什么动画库」「动画用什么做」时按这个顺序判。

**Nothing, if the browser does it.** View Transitions reached Baseline newly available on 2025-10-14 (Firefox 144 completed it) and handles route and shared-element morphs. CSS scroll-driven animations (`animation-timeline: scroll()` / `view()`) cover progress bars, entrance reveals and parallax in Chromium 115+ and Safari 26+, with Firefox still behind a flag — ship behind `@supports`. `@starting-style` plus `transition-behavior: allow-discrete` animates elements entering the top layer, so `popover` and `<dialog>` no longer need a JS mount delay. Three effects that used to justify a dependency now cost zero bytes.

**Tailwind projects: `tw-animate-css`** (Wombosvideo/tw-animate-css, MIT, 25.3M weekly downloads — the highest of any package in this space). CSS-only enter/exit utilities and `data-[state=open]` variants, no runtime JS. shadcn/ui ships with it on Tailwind v4; the older `tailwindcss-animate` is unmaintained and should not go into a new project.

**Component motion: Motion** (motiondivision/motion, 33.5k★, MIT, npm `motion` 18.3M weekly plus the `framer-motion` alias at 41.0M, v13.2.0 released 2026-09-02, ~1,088 commits in the last year). 44.5 kB gzip full, from ~2.3 kB with the `animate()` mini build or ~6 kB via `LazyMotion` + `motion/react-m`. Vue support is real but lives in a sibling package, `motion-v` (motiondivision/motion-vue).

**Timeline and scroll choreography: GSAP** (greensock/GSAP, 28.3k★, 3.15.0 released 2026-04-13, 26.7 kB gzip core). Since the Webflow acquisition every plugin — ScrollTrigger, SplitText, MorphSVG, ScrollSmoother, Flip — is free for commercial use. The licence is GSAP's own "No Charge" licence, not MIT/OSI, which matters only if your organisation requires OSI-approved dependencies.

The two are complementary, not rivals: Motion for component state, presence and layout; GSAP when one timeline must orchestrate many elements against scroll progress. Using both on one page is normal and costs about 70 kB gzip together.

## Scroll And 3D Stack — 滚动叙事 / 3D 展示选型 [motion/scroll-3d-stack-gsap-lenis-three-r3f-budget]

**Smooth scroll: Lenis** (darkroomengineering/lenis, 15.7k★, MIT, 5.3 kB gzip, 1.3.26 released 2026-08-05, 1.32M weekly). The successor to Locomotive Scroll, which is effectively frozen. Wire it to GSAP by driving `lenis.raf` from `gsap.ticker` and calling `ScrollTrigger.update` on its scroll event; running both on their own clocks makes pinned sections drift. Do not put smooth scroll on content-heavy product UI — it hurts keyboard paging and motion-sensitive readers.

**3D: Three.js** (mrdoob/three.js, 115.3k★, MIT, 14.0M weekly) with **React Three Fiber** (pmndrs/react-three-fiber, 32.2k★, MIT, 9.7.0 released 2026-07-31, 4.67M weekly) and **drei** (pmndrs/drei, 9.9k★, MIT, 3.51M weekly) for cameras, controls, loaders and scroll binding. This is the only mainstream path for 3D in React and it is healthy.

Budget honestly before committing: Three.js alone is ~150 kB gzip, a Draco-compressed glTF hero model 0.5–3 MB, and a scroll-scrubbed frame sequence 2–6 MB. Any of these is an above-the-fold-only cost that needs a loading state, a WebGL-unsupported fallback, and testing on a mid-range phone rather than the development machine.

**Lighter alternatives worth knowing**: `cobe` (shuding/cobe, 5.8k★, MIT) draws the Vercel/Linear-style rotating globe in about 5 kB — when the requirement is "a globe" rather than "a 3D scene", this is a hundredth of the cost. Paper Shaders gives WebGL mesh gradients as React components without hand-writing shaders.

**Avoid**: Theatre.js (12.7k★) has not published since May 2024; `react-flip-toolkit` and `use-gesture` are both effectively frozen and their jobs are now covered by Motion's `layout`/`layoutId` and built-in gestures.

## Component Effect Kits And Their Licences — 特效组件库 / 复制粘贴组件 许可证 [motion/component-effect-kits-licence-commons-clause-risk]

Copy-paste effect kits are how most "make it look impressive" requests get answered, and their licences are not uniform. For a product that emits code into a user's project this is a real constraint, not a footnote. 用户说「要那种炫酷组件」时先看这一条。

**Safe, MIT**: Magic UI (magicuidesign/magicui, 22.2k★, MIT) — 210 registry entries of which about 75 are real components: `border-beam`, `animated-beam` (connecting lines between nodes, the standard way to draw an integration diagram), `magic-card` (cursor-following spotlight), `shine-border`, `meteors`, `particles`, `retro-grid`, `warp-background`, `flickering-grid`, `text-reveal`, `text-animate`, `hyper-text`, `sparkles`, `marquee`, `dock`. Installs through the shadcn CLI. Motion Primitives (ibelick/motion-primitives, MIT) is a more restrained set that suits product UI rather than marketing pages, though it has been quiet since March 2026. `pqoqubbw/icons` (8.1k★, MIT) gives Motion-animated Lucide icons.

**Restricted — do not redistribute**: React Bits (DavidHDev/react-bits) is the most-starred of them all at 46.9k★ and was second in the 2025 JavaScript Rising Stars, but it is **MIT + Commons Clause**, which explicitly forbids selling, sublicensing or redistributing the components. Emitting its source into a customer's project as part of a paid product is exactly the case that clause targets. animate-ui (imskyleen/animate-ui) carries the same rider and has been unmaintained since December 2025. canvas-ui is very new (created July 2026) with an unclear licence.

The safe pattern regardless of kit: take the *technique* — the gradient maths, the timing, the mask trick — and reimplement it against the project's own design tokens. That produces better-integrated code anyway, since these kits ship their own colour and radius choices which will not match the project.

## Micro-interaction Helper Libraries — 微交互常用库 / 吐司抽屉轮播 [motion/micro-interaction-helper-libraries-toast-drawer-carousel-counter]

Single-purpose packages that are genuinely better than hand-rolling, all verified active. 用户要吐司、抽屉、轮播、数字滚动这些时直接用这里的。

- **Sonner** (emilkowalski/sonner, 12.9k★, MIT, ~9 kB, zero dependencies, v2.0.8 in August 2026) — toasts. Stacking, swipe-to-dismiss and `toast.promise()` three-state handling. Ports: `vue-sonner` (1.06M weekly), `svelte-sonner` (441k).
- **Vaul** (emilkowalski/vaul, MIT) — the mobile bottom sheet with drag physics, snap points and correct scroll locking. The part everyone gets wrong when hand-rolling.
- **Embla Carousel** (davidjerleke/embla-carousel, 8.4k★, MIT) — framework-agnostic carousel core with React/Vue/Svelte wrappers; what shadcn/ui's Carousel is built on. Most rails do not need it at all — CSS `scroll-snap-type` covers the common case.
- **number-flow** (barvian/number-flow, 7.7k★, MIT) — odometer digit animation that keeps `Intl.NumberFormat` correct mid-animation for currency, percentages and compact notation. Wrappers for React, Vue and Svelte.
- **@formkit/auto-animate** (formkit/auto-animate, 13.9k★, MIT, 6.8 kB) — one line (`useAutoAnimate(ref)`) gives correct add/remove/reorder transitions for any list. Deliberately offers no configuration, which is why it is the right amount of machinery for tables, todo lists and filter results.
- **canvas-confetti** (catdad/canvas-confetti, ISC, ~6 kB) — celebration bursts, with `disableForReducedMotion` built in. Import it lazily at the moment of use.
- **cmdk** — command palette with filtering and keyboard navigation; the base for shadcn/ui's Command.

Prefer the headless primitive plus your own styling (Radix, Base UI) over a styled widget library for anything that carries state, and keep the helper packages for the narrow jobs above.

## Vue Svelte And Plain JavaScript — Vue 动画 / Svelte 动画 / 原生 JS 动画 [motion/vue-svelte-vanilla-animation-stack-framework-native]

Not every project is React, and the right answer differs. 用户的项目是 Vue、Svelte 或纯静态页时看这条。

**Vue**: start with the built-in `<Transition>` and `<TransitionGroup>` — they cover enter/leave and list reordering with CSS classes and no dependency, including FLIP for moves. Add **motion-v** (motiondivision/motion-vue, MIT) when you need the Motion API: `whileInView`, presence, layout animation, springs. `@vueuse/motion` remains a reasonable lighter option inside a project already using VueUse.

**Svelte**: the framework ships the animation layer. `svelte/transition` (fade, fly, slide, scale, draw), `svelte/animate` (`flip` for list reordering) and `svelte/motion` (`tweened`, `spring`) together handle almost everything without a package. Reach outside only for scroll choreography (GSAP) or 3D (Threlte).

**Plain JavaScript / static pages**: the `animate()` function from the same `motion` package is the cross-framework answer at roughly 2.3 kB, built on the Web Animations API with a hybrid engine for spring physics. **anime.js v4** (juliangarnier/anime, MIT) was rewritten with a modern ES-module API and is a solid alternative with a timeline model closer to GSAP's. For pure CSS work, a `@keyframes` block plus `IntersectionObserver` toggling a class is still the smallest and most durable thing that works.

Cross-framework rule of thumb: if the project already has Tailwind, do it in CSS; if it already has Motion or GSAP, use that rather than adding a second engine. Two animation libraries in one project almost always means two easing scales and two duration conventions, and the page reads inconsistent even when each individual effect is fine.

## Designer Authored Animation — Lottie 与 Rive 怎么选 [motion/lottie-vs-rive-designer-authored-vector-state-machine]

When the animation is authored by a designer rather than coded, there are two formats and the choice is about interactivity. 用户拿来一个 AE 导出的动画、或者要「那种会响应鼠标的插画」时看这条。

**Lottie** plays back a vector animation exported from After Effects. Use `@lottiefiles/dotlottie-react` (1.19M weekly) over the legacy `lottie-react` where possible: the `.lottie` container is substantially smaller than raw `.json`, and the player is a Rust/WASM runtime with noticeably better performance than the old JS renderer. Right for: onboarding illustrations, empty-state art, loading sequences, celebratory moments — anything that plays and finishes.

**Rive** (`@rive-app/react-canvas`, MIT, 839k weekly, 4.34.1 released 2026-09-04) adds a state machine, so the artwork responds to input: a button with hover/press/loading states authored by the designer, a character whose eyes follow the cursor, a toggle that morphs. The runtime is around 200 kB of WASM, which only pays off when you are actually using the interactivity. Right for: interactive mascots, stateful icons, game-like UI.

Rules for both: they are assets, so they need a loading state and a static poster frame; they must respect `prefers-reduced-motion` (pause and show a still); decorative ones get `aria-hidden="true"` while meaningful ones need a text equivalent; and neither should sit in the critical rendering path of a first paint.

Before reaching for either, ask whether the effect can be done in CSS or Motion. A 40 kB Lottie of a spinning circle is a mistake that ships surprisingly often.
