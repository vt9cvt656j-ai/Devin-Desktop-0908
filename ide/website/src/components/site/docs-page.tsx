import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, History, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { GATEWAY } from "@/lib/account";
import { mseFetch } from "@/lib/mse";
import { extractHeadings, renderMarkdownBlocks, type Heading } from "@/lib/markdown";
import { CodeBlock } from "@/components/site/code-block";
import {
  applyPageMeta,
  canonicalFor,
  descriptionFromMarkdown,
} from "@/lib/page-meta";

const DOCS_TITLE = "Docs — Mr. Day One";
const DOCS_DESCRIPTION = "Guides for installing and using Mr. Day One.";

/**
 * 用户文档。
 *
 * 内容全部来自网关（`/api/docs`），在管理台里写 —— 加一页文档不需要发版。
 *
 * # 三个刻意的结构决定
 *
 * **侧栏是 `<a>`，不是 `<button>`。** 这不是审美问题：button 会让 ⌘-点击开新标签页、中键、
 * 右键复制链接全部静默失效，而开发者读文档最常见的动作就是点开三四页对着看。更要命的是
 * 爬虫拿不到任何内页链接 —— 文档站第二大入口是搜索落地单页，全 button 的侧栏等于对搜索
 * 引擎隐身。点击时再 `preventDefault` 走 pushState，带修饰键的点击原样放行给浏览器。
 *
 * **`/docs` 是落地页，不自动跳第一篇。** 自动跳有三个问题：地址栏仍是 `/docs`，分享出去的
 * 内容取决于"第一篇是哪篇"，排序一改就漂；没有任何地方讲这套文档有哪些部分；而且正因为
 * 落地页和空状态是两套代码，空状态才会潦草成一个灰框。合成一套之后，`/docs` 从结构上
 * 永远不会空。
 *
 * **目录出不出，看这一篇有几个标题，不看总页数。** 页数多不代表这一篇长 —— 八篇里的一篇
 * 短文照样不该出目录，一篇长文该出。条件挂在内容上，判断才不会错。
 */

type Page = { slug: string; section: string; title: string; sort: number };
type Doc = { slug: string; section: string; title: string; body: string };

function slugFromPath(): string {
  const m = location.pathname.match(/^\/docs\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** 带修饰键的点击是"用另一种方式打开"，必须原样交给浏览器。 */
function plainClick(e: React.MouseEvent) {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

export function DocsPage() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [navError, setNavError] = useState(false);
  const [slug, setSlug] = useState<string>(slugFromPath);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [state, setState] = useState<"ok" | "missing" | "error">("ok");
  const [active, setActive] = useState("");
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onPop = () => setSlug(slugFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await mseFetch(`${GATEWAY}/api/docs`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { pages?: Page[] };
        if (alive) setPages(j.pages ?? []);
      } catch {
        // 取不到 ≠ 一篇都没有。把失败当成空，会让一次网络抖动看起来像"文档被删光了"。
        if (alive) {
          setNavError(true);
          setPages([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const target = slug;

  useEffect(() => {
    if (!target) {
      setDoc(null);
      setState("ok");
      return;
    }
    let alive = true;
    setState("ok");
    void (async () => {
      try {
        const r = await mseFetch(`${GATEWAY}/api/docs/${encodeURIComponent(target)}`, {
          cache: "no-store",
        });
        // 404 仍然读得出来：状态码取自密文内层，MSE 不会把它抹平成 200。
        if (r.status === 404) throw new Error("missing");
        if (!r.ok) throw new Error("error");
        const j = (await r.json()) as Doc;
        if (alive) setDoc(j);
      } catch (e) {
        // 「这一页不存在」和「网络坏了」是两回事，给出的下一步动作完全不同。
        if (alive) {
          setDoc(null);
          setState(e instanceof Error && e.message === "missing" ? "missing" : "error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [target]);

  // App.tsx can only stamp the /docs landing meta — it does not re-run when
  // this page pushStates between slugs. Missing articles must noindex or
  // Google will treat the 200 + "这一页不存在" body as a real result (soft-404).
  useEffect(() => {
    if (!target) {
      applyPageMeta({
        title: DOCS_TITLE,
        description: DOCS_DESCRIPTION,
        canonical: canonicalFor("/docs"),
      });
      return;
    }
    if (state === "missing" || state === "error") {
      applyPageMeta({
        title:
          state === "missing"
            ? "这一页不存在 — Mr. Day One"
            : "没能加载这一页 — Mr. Day One",
        description: DOCS_DESCRIPTION,
        canonical: canonicalFor(location.pathname),
        robots: "noindex",
      });
      return;
    }
    if (doc) {
      applyPageMeta({
        title: `${doc.title} — Docs — Mr. Day One`,
        description: descriptionFromMarkdown(doc.body) || DOCS_DESCRIPTION,
        canonical: canonicalFor(location.pathname),
      });
    }
  }, [target, state, doc]);

  const open = useCallback((next: string) => {
    history.pushState(null, "", next ? `/docs/${next}` : "/docs");
    setSlug(next);
    setActive("");
    window.scrollTo({ top: 0 });
  }, []);

  // 深链进来时，把侧栏里当前那条滚进可视区 —— 否则第 20 篇的读者看到的是一列没有高亮的标题。
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [target, pages]);

  const list = pages ?? [];
  const outline: Heading[] = doc ? extractHeadings(doc.body).filter((h) => h.level <= 3) : [];
  const showNav = list.length >= 2 && !!target;
  const showToc = outline.length >= 3;

  // scrollspy。IntersectionObserver 的 entries 只含**状态变化**的元素 —— 直接拿它定 active
  // 是这类实现最常见的错法，必须自己维护一个集合。
  useEffect(() => {
    if (!showToc) return;
    const els = outline
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        const first = outline.find((h) => seen.has(h.id));
        if (first) setActive(first.id);
        else {
          // 长章节正中间时没有任何标题在带内，退化成"取最后一个已经滚过去的"。
          const above = els.filter((el) => el.getBoundingClientRect().top < 96).pop();
          if (above) setActive(above.id);
        }
      },
      { rootMargin: "-88px 0px -65% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [doc?.slug, showToc, outline]);

  // 分组保持服务端次序，这里只切分。
  const sections: { name: string; items: Page[] }[] = [];
  for (const p of list) {
    const name = p.section || "文档";
    const last = sections[sections.length - 1];
    if (last && last.name === name) last.items.push(p);
    else sections.push({ name, items: [p] });
  }

  const idx = list.findIndex((p) => p.slug === target);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const nav = (
    <>
      {sections.map((s, i) => (
        <div key={s.name} className={i === 0 ? "" : "mt-7"}>
          {sections.length > 1 ? <p className="doc-nav-group mb-2 pl-3">{s.name}</p> : null}
          {/* 不用 space-y：条目之间留空会把左边那条竖线打断成虚线。 */}
          <ul className="border-l border-border">
            {s.items.map((p) => (
              <li key={p.slug}>
                <a
                  href={`/docs/${p.slug}`}
                  aria-current={p.slug === target ? "page" : undefined}
                  onClick={(e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    open(p.slug);
                  }}
                  className={cn(
                    // -ml-px + border-l-2：选中与否盒模型一致，切换时不会横向抖 2px。
                    "-ml-px block border-l-2 py-[5px] pl-3 pr-2 text-[13.5px] leading-6 transition-colors",
                    p.slug === target
                      ? "border-brand font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                >
                  {p.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );

  return (
    <main id="main" className="mx-auto w-full max-w-[84rem] px-4 pb-24 pt-10 sm:px-6 lg:px-8">
      {!target ? (
        <DocsLanding pages={list} failed={navError} onOpen={open} />
      ) : (
        <div
          className={cn(
            "grid gap-x-12",
            showNav && "lg:grid-cols-[15rem_minmax(0,1fr)]",
            showNav && showToc && "xl:grid-cols-[15rem_minmax(0,1fr)_13rem]",
          )}
        >
          {showNav ? (
            <>
              {/* 窄屏：原生 <details>。抽屉要焦点陷阱、滚动锁、Esc、遮罩，四五十行有状态代码；
                  details 默认收起、键盘和无障碍语义都是原生的、零 JS。 */}
              <details className="mb-8 rounded-xl border border-border lg:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  <span className="truncate">{doc?.title ?? "文档目录"}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </summary>
                <div className="border-t border-border px-3 py-3">{nav}</div>
              </details>

              <nav
                ref={navRef}
                aria-label="文档目录"
                className="hidden min-w-0 lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-4rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:border-r lg:border-border/60 lg:pb-16 lg:pr-6"
              >
                {nav}
              </nav>
            </>
          ) : null}

          <article className="min-w-0">
            {state === "missing" ? (
              <Notice
                title="这一页不存在"
                body="它可能已经改名或还没发布。"
                action={{ label: "回到文档首页", onClick: () => open("") }}
              />
            ) : state === "error" ? (
              <Notice
                title="没能加载这一页"
                body="网络或服务暂时不可用。"
                action={{ label: "重试", onClick: () => setSlug((s) => s) }}
              />
            ) : !doc ? (
              <Skeleton />
            ) : (
              <>
                <nav
                  aria-label="面包屑"
                  className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground"
                >
                  <a
                    href="/docs"
                    onClick={(e) => {
                      if (!plainClick(e)) return;
                      e.preventDefault();
                      open("");
                    }}
                    className="transition-colors hover:text-foreground"
                  >
                    文档
                  </a>
                  {doc.section ? (
                    <>
                      <span className="text-border">/</span>
                      <span>{doc.section}</span>
                    </>
                  ) : null}
                </nav>

                <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                  {doc.title}
                </h1>

                {/* 1024–1279：右栏没空间，目录降级成正文上方一行可展开的。 */}
                {showToc ? (
                  <details className="mt-8 rounded-xl border border-border bg-secondary/30 px-4 py-3 xl:hidden">
                    <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
                      本页内容
                      <ChevronDown className="size-4 text-muted-foreground" />
                    </summary>
                    <ul className="mt-3 space-y-1.5">
                      {outline.map((h) => (
                        <li key={h.id}>
                          <a
                            href={`#${h.id}`}
                            className={cn(
                              "text-[13px] text-muted-foreground transition-colors hover:text-foreground",
                              h.level === 3 && "pl-4",
                            )}
                          >
                            {h.text}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {/*
                  正文里的站内链接接回 pushState，否则 [见配置](/docs/config) 会整页重载。
                  委托在容器上，因为内容是 innerHTML 出来的，挂不上 React 事件。
                */}
                <div
                  className="doc-body mt-8"
                  onClick={(e) => {
                    const a = (e.target as HTMLElement).closest("a");
                    const h = a?.getAttribute("href");
                    if (!h?.startsWith("/docs/") || !plainClick(e)) return;
                    e.preventDefault();
                    open(h.slice("/docs/".length));
                  }}
                >
                  {renderMarkdownBlocks(doc.body).map((b, i) =>
                    b.kind === "code" ? (
                      <CodeBlock key={i} lang={b.lang} title={b.title} code={b.code} />
                    ) : (
                      // display:contents —— 这层包装不参与布局，纵向节奏仍由 .doc-body 的
                      // 后代选择器统一管。
                      <div key={i} className="doc-seg" dangerouslySetInnerHTML={{ __html: b.html }} />
                    ),
                  )}
                </div>

                {(prev || next) && (
                  <nav className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
                    {prev ? <PageLink dir="prev" page={prev} onOpen={open} /> : <span />}
                    {next ? <PageLink dir="next" page={next} onOpen={open} /> : <span />}
                  </nav>
                )}
              </>
            )}
          </article>

          {showNav && showToc ? (
            <aside className="hidden min-w-0 xl:sticky xl:top-6 xl:block xl:max-h-[calc(100vh-4rem)] xl:self-start xl:overflow-y-auto">
              <p className="doc-nav-group mb-3">本页内容</p>
              <ul className="border-l border-border">
                {outline.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className={cn(
                        "-ml-px block border-l-2 py-1 text-[13px] leading-snug transition-colors",
                        h.level === 3 ? "pl-6" : "pl-3",
                        h.id === active
                          ? "border-brand font-medium text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
      )}
    </main>
  );
}

/** 上一页 / 下一页。方向决定箭头在哪边、文字往哪对齐。 */
function PageLink({
  dir,
  page,
  onOpen,
}: {
  dir: "prev" | "next";
  page: Page;
  onOpen: (s: string) => void;
}) {
  return (
    <a
      href={`/docs/${page.slug}`}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        onOpen(page.slug);
      }}
      className={cn(
        "group rounded-xl border border-border p-4 transition-colors hover:border-brand/40",
        dir === "next" && "sm:col-start-2 sm:text-right",
      )}
    >
      <span className="text-xs text-muted-foreground">{dir === "prev" ? "上一页" : "下一页"}</span>
      <span
        className={cn(
          "mt-1 flex items-center gap-1.5 text-[15px] font-medium",
          dir === "next" && "sm:justify-end",
        )}
      >
        {dir === "prev" ? <ChevronLeft className="size-4 shrink-0 text-muted-foreground" /> : null}
        {page.title}
        {dir === "next" ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : null}
      </span>
    </a>
  );
}

/**
 * `/docs` 的落地页 —— 也是空状态。
 *
 * 一套代码，不是两套。空的时候只是卡片少一张、标题换一句：读者来 /docs 是带着具体问题来的
 * （怎么装、怎么接模型），文档空不代表答案不存在 —— 站内已经有下载、更新日志、控制台。
 * 空状态的任务是把人转走，不是让人按后退。
 *
 * 不用虚线灰框、不居中、不写"暂无内容"：那三样加起来传达的是"这个产品没人维护"。
 */
function DocsLanding({
  pages,
  failed,
  onOpen,
}: {
  pages: Page[];
  failed: boolean;
  onOpen: (s: string) => void;
}) {
  const empty = pages.length === 0;
  const cards = [
    { icon: Download, href: "/#download", title: "安装 Mr. Day One", body: "macOS 与 Windows 桌面版，两分钟装完。" },
    { icon: History, href: "/changelog", title: "看看最近改了什么", body: "每一次值得说的改动都写在这里。" },
    { icon: KeyRound, href: "https://code.mrday.one/dashboard#models", title: "配置模型", body: "在控制台里选模型、看用量、管额度。" },
  ];

  return (
    <div className="max-w-5xl">
      <p className="type-eyebrow mb-3">文档</p>
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        {empty ? "文档正在写" : "Mr. Day One 文档"}
      </h1>
      <p className="type-measure mt-4 text-pretty text-[15.5px] leading-relaxed text-muted-foreground">
        {failed
          ? "文档目录暂时没能加载出来，稍后再试。下面这些入口一直可用。"
          : empty
            ? "第一批文档正在整理。在那之前，下面这几个入口能解决大部分问题。"
            : "从左边挑一篇开始，或者直接看下面几个最常用的入口。"}
      </p>

      {empty && !failed ? (
        <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-brand" /> 第一批文档发布中
        </span>
      ) : null}

      {!empty ? (
        <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {groupOf(pages).map((s) => (
            <div key={s.name}>
              <p className="doc-nav-group mb-3">{s.name}</p>
              <ul className="space-y-1.5">
                {s.items.map((p) => (
                  <li key={p.slug}>
                    <a
                      href={`/docs/${p.slug}`}
                      onClick={(e) => {
                        if (!plainClick(e)) return;
                        e.preventDefault();
                        onOpen(p.slug);
                      }}
                      className="text-[15px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-12 grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <a
            key={c.title}
            href={c.href}
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-brand/40"
          >
            <c.icon className="size-5 text-muted-foreground transition-colors group-hover:text-brand" />
            <p className="mt-3 text-[15px] font-medium">{c.title}</p>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{c.body}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

function groupOf(pages: Page[]) {
  const out: { name: string; items: Page[] }[] = [];
  for (const p of pages) {
    const name = p.section || "文档";
    const last = out[out.length - 1];
    if (last && last.name === name) last.items.push(p);
    else out.push({ name, items: [p] });
  }
  return out;
}

/** 加载中。骨架屏而不是「Loading…」——后者会让版面在内容到达时整个跳一下。 */
function Skeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-3 w-24 rounded bg-secondary" />
      <div className="mt-4 h-9 w-2/3 rounded bg-secondary" />
      <div className="mt-8 space-y-3">
        {[100, 92, 96, 60].map((w, i) => (
          <div key={i} className="h-4 rounded bg-secondary" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="mt-8 h-32 rounded-xl bg-secondary" />
    </div>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { label: string; onClick: () => void };
}) {
  return (
    <div className="max-w-md">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">{body}</p>
      <button
        type="button"
        onClick={action.onClick}
        className="mt-6 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-secondary"
      >
        {action.label}
      </button>
    </div>
  );
}
