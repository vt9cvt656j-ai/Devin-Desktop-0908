import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { BEIAN, GEO_ATTRIBUTION, gonganHref, intlSiteUrl, isCnMirrorHost } from "@/lib/region";

/*
 * Every link here used to point at github.com/fendoushaonian/Devin-Desktop. That
 * repository is private, so all five returned 404 to visitors — a footer where nothing
 * works reads as an abandoned product. They are gone until the repo is public; what is
 * left is only destinations that actually resolve today.
 */
const columns = [
  {
    heading: "Product",
    links: [
      { label: "Overview", href: "#features" },
      { label: "How it works", href: "#architecture" },
      { label: "Extensibility", href: "#extensions" },
      { label: "Reviews", href: "#customers" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Download", href: "#download" },
      { label: "Sign in", href: "https://code.mrday.one/gate" },
      { label: "Create an account", href: "https://code.mrday.one/gate" },
    ],
  },
];

/*
 * 备案栏：只在中国区备案镜像 mrday.one.shuerzuo.cn 上出现。ICP 备案号和公安备案号是那个域名
 * 的法定义务（要在首页底部、要链到工信部 / 公安部的查询页）；美国站不显示。同一栏里给一个
 * 「访问国际站」——带 ?region=intl 回 mrday.one，nginx 见到它就种一年 cookie、不再分流。
 * 号码在 lib/region.ts 的 BEIAN 里填；没填的那项不渲染，不会出现一个空链接。
 */
function BeianLine() {
  if (typeof window === "undefined" || !isCnMirrorHost(window.location.hostname)) return null;
  const items: ReactNode[] = [];
  if (BEIAN.icp) {
    items.push(
      <a key="icp" href={BEIAN.icpHref} target="_blank" rel="noreferrer" className="hover:text-foreground">
        {BEIAN.icp}
      </a>,
    );
  }
  if (BEIAN.gongan) {
    // 公安备案要带官方的备案图标（全国互联网安全管理服务平台发的那枚国徽盾），图标和号码在同一个
    // 链接里，这是平台给的标准写法。图取自 beian.mps.gov.cn，存在 public/beian/gongan.png（62×67）。
    items.push(
      <a
        key="gongan"
        href={gonganHref(BEIAN.gonganCode)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        <img src="/beian/gongan.png" alt="" width={16} height={17} className="inline-block" />
        {BEIAN.gongan}
      </a>,
    );
  }
  items.push(
    <a key="intl" href={intlSiteUrl(window.location.pathname, window.location.hash)} className="hover:text-foreground">
      访问国际站 mrday.one
    </a>,
  );
  return (
    <p className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-xs text-muted-foreground">
      {items}
    </p>
  );
}

export function Footer() {
  return (
    // data-build：构建时间戳（vite.config.ts 的 define）。它在这里不是给人看的——它把每次构建的
    // 内容都变成不一样的，入口 bundle 的哈希因此每次部署都换，见 vite.config.ts 里的说明。
    <footer className="border-t border-border bg-background py-14" data-build={__SITE_BUILD__}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col justify-between gap-10 sm:flex-row">
          <div className="max-w-xs">
            <p className="flex items-center gap-2.5 font-display text-lg font-semibold">
              <img src="/logo.png" alt="" className="size-8" />
              Mr. Day One
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              A native desktop code editor for MacOS and Windows, with an agent that verifies its
              own work.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10">
            {columns.map((column) => (
              <div key={column.heading}>
                <p className="type-eyebrow mb-4">{column.heading}</p>
                <ul className="space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        {...(link.href.startsWith("http")
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <Separator className="my-10" />
        {/* text-center：这一行独占底部整行，左对齐会把它甩到最左边，和上面居中的版式对不齐。 */}
        <p className="text-center text-sm text-muted-foreground">
          © {new Date().getFullYear()} Mr. Day One.
        </p>
        {/* 地区分流用的 IP 库是 CC BY 4.0，署名是使用条件，两个域名都放。 */}
        <p className="mt-2 text-center text-xs text-muted-foreground/70">
          <a href={GEO_ATTRIBUTION.href} target="_blank" rel="noreferrer" className="hover:text-foreground">
            {GEO_ATTRIBUTION.text}
          </a>
        </p>
        <BeianLine />
      </div>
    </footer>
  );
}
