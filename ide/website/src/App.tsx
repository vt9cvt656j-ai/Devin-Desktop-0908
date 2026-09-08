import { TooltipProvider } from "@/components/ui/tooltip";
import { Navbar } from "@/components/site/navbar";
import { Hero } from "@/components/site/hero";
import { LanguageMarquee } from "@/components/site/language-marquee";
import { Features } from "@/components/site/features";
import { Architecture } from "@/components/site/architecture";
import { ToolGallerySection } from "@/components/site/tool-gallery";
import { Testimonials } from "@/components/site/testimonials";
import { Cta } from "@/components/site/cta";
import { Footer } from "@/components/site/footer";
import { ChangelogPage } from "@/components/site/changelog-page";
import { RankingsPage } from "@/components/site/rankings-page";
import { DocsPage } from "@/components/site/docs-page";
import { NotFoundPage } from "@/components/site/not-found-page";
import {
  applyPageMeta,
  canonicalFor,
  HOME_DESCRIPTION,
  HOME_TITLE,
} from "@/lib/page-meta";

/**
 * 应用装配层。
 * 区块组件按访客旅程顺序挂载在 <main> 内,相邻区块的构图不要重复。
 */
/*
 * Standalone pages, chosen by path.
 *
 * nginx already falls back to index.html for unknown paths, so /changelog and /rankings
 * reach this bundle and are rendered here — no router dependency and no second build
 * entry. A table rather than a chain of conditions now that there is more than one: adding
 * a page is a line, and every one of them is visible in a single place. If any of these
 * ever grows sub-paths or needs history navigation, that is the point to bring in a real
 * router instead of teaching this to parse.
 *
 * title / description feed `applyPageMeta`. Docs articles override both after
 * the markdown loads — the row here is the `/docs` landing, and the fallback
 * while a slug is in flight.
 */
const PAGES: {
  match: RegExp;
  title: string;
  description: string;
  render: () => React.ReactNode;
  /** 带站点导航渲染。文档要靠它 —— 见下面 chrome 分支的说明。 */
  chrome?: boolean;
  /** 内容更宽的页面，导航条跟着加宽，两条左边缘才对得齐。 */
  wide?: boolean;
}[] = [
  {
    match: /^\/changelog\/?$/,
    title: "Update log — Mr. Day One",
    description:
      "Notable changes across the editor, the gateway, the account console, and this site.",
    render: () => <ChangelogPage />,
  },
  {
    match: /^\/rankings\/?$/,
    title: "Rankings — Mr. Day One",
    description: "Accounts ranked by real usage through the gateway.",
    render: () => <RankingsPage />,
  },
  // /docs 和 /docs/<slug> 都走这一页 —— 它自己按地址挑要显示哪一篇，并用 pushState 在
  // 页面之间切换（所以每一页都能被收藏和分享）。
  //
  // chrome: 文档要带站点导航。没有它，从搜索直接落到某一篇的人看不到 Product / Download /
  // 主题切换，只有一个返回箭头 —— 那是「个人博客」和「正经文档站」最直观的分界线。
  // wide: 文档是三栏、比其它页宽，导航条不加宽的话 logo 会比侧栏左边缘缩进近 100px。
  {
    match: /^\/docs(\/[^/]*)?\/?$/,
    title: "Docs — Mr. Day One",
    description: "Guides for installing and using Mr. Day One.",
    render: () => <DocsPage />,
    chrome: true,
    wide: true,
  },
];

export default function App() {
  const page = PAGES.find((p) => p.match.test(location.pathname));
  if (page) {
    applyPageMeta({
      title: page.title,
      description: page.description,
      canonical: canonicalFor(location.pathname),
    });
    return (
      <TooltipProvider delayDuration={150}>
        <div className="min-h-screen bg-background text-foreground antialiased">
          {page.chrome ? <Navbar wide={page.wide} /> : null}
          {page.render()}
          <Footer />
        </div>
      </TooltipProvider>
    );
  }

  const isHome = location.pathname === "/" || location.pathname === "";
  if (!isHome) {
    applyPageMeta({
      title: "Page not found — Mr. Day One",
      description: "This URL is not a page on Mr. Day One.",
      canonical: canonicalFor(location.pathname),
      robots: "noindex",
    });
    return (
      <TooltipProvider delayDuration={150}>
        <div className="min-h-screen bg-background text-foreground antialiased">
          <Navbar />
          <NotFoundPage />
          <Footer />
        </div>
      </TooltipProvider>
    );
  }

  applyPageMeta({
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: canonicalFor("/"),
  });

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-background text-foreground antialiased">
        <div aria-hidden className="scroll-progress" />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
        >
          Skip to main content
        </a>

        <Navbar />
        <main id="main">
          <Hero />
          <LanguageMarquee />
          <Features />
          <Architecture />
          <ToolGallerySection />
          <Testimonials />
          <Cta />
        </main>
        <Footer />
      </div>
    </TooltipProvider>
  );
}
