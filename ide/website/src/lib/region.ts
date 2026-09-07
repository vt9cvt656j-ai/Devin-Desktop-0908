/*
 * 官网的「地区」这件事：美国官网 mrday.one 和中国区备案镜像 mrday.one.shuerzuo.cn 是同一份站点，
 * 只是域名不同。谁该去哪个域名，硬规则在 nginx（server/nginx/mrday-geo.conf：中国大陆 + 严管
 * 省份 → 镜像，其余留美国站），这里只补三件 nginx 做不到的事：
 *   1. 系统语言。nginx 只看 IP；IP 判成大陆、库里却没有省份时，浏览器语言是中文就当作大陆
 *      用户去镜像——「IP 和系统语言一起判」。非中文浏览器连 /__geo 都不查，美国访客零成本。
 *   2. 页脚的备案栏：只在镜像域名上出现（ICP 备案 + 公安备案是镜像域名的法定义务）。
 *   3. 「访问国际站」：镜像上的访客点它带 ?region=intl 回 mrday.one，nginx 种一年 cookie，
 *      之后不再分流。这里认同一个 cookie / 参数，别在两边各判各的。
 * 全部是纯函数，ide/test/website-region.test.mjs 真跑；DOM 只在 installRegionRouting 里碰。
 */

export const INTL_ORIGIN = "https://mrday.one";
/**
 * 镜像域名。和 nginx 的 $mrday_cn_host（server/nginx/mrday-geo.conf）是同一个值，测试对账。
 * 为什么不是 mrday.one.shuerzuo.cn：那个名字把 mrday.one 整个嵌在最前面，正是钓鱼域名的经典长相，
 * Chrome 会拦一页「您是想访问 mrday.one 吧?」，蓝色按钮一点就把人送回美国站。老名字只剩 301。
 */
export const CN_MIRROR_HOST = "mrday.shuerzuo.cn";
export const CN_MIRROR_ORIGIN = `https://${CN_MIRROR_HOST}`;
/** 曾经用过的镜像域名也算镜像：页脚照样出备案栏、不做客户端跳转（服务端已经 301 到现名）。 */
export const CN_MIRROR_HOSTS: readonly string[] = [CN_MIRROR_HOST, "mrday.one.shuerzuo.cn"];

/** 访客选择用的 cookie / 查询参数名；nginx 那边（mrday-geo.conf）认的是同一个。 */
export const REGION_COOKIE = "mrday_region";
export const REGION_PARAM = "region";

/**
 * 严管省份。**和 nginx 的名单是同一份**（server/nginx/mrday-geo.conf 的正则），由测试对账；
 * 改一处必须改另一处。英文名来自 DB-IP 库，两字母码来自 Cloudflare 的 cf-region-code。
 */
export const STRICT_REGIONS: readonly string[] = ["Fujian", "Jiangsu", "Zhejiang", "FJ", "JS", "ZJ"];

/**
 * 备案信息 —— 只在镜像域名的页脚显示。空串表示还没填：那一项不渲染，不会出现一个空链接。
 * 公安备案号形如「闽公网安备 35010202001234号」，gonganCode 是号里的那串数字（查询链接要用）。
 */
export const BEIAN = {
  icp: "浙ICP备2023014863号-3",
  icpHref: "https://beian.miit.gov.cn/",
  gongan: "沪公网安备31010602007814号",
  gonganCode: "31010602007814",
} as const;

/** 数据出处署名：DB-IP City Lite 是 CC BY 4.0，用它就得写这一行（放页脚，两个域名都放）。 */
export const GEO_ATTRIBUTION = { text: "IP Geolocation by DB-IP", href: "https://db-ip.com" } as const;

export function isCnMirrorHost(hostname: string): boolean {
  return CN_MIRROR_HOSTS.includes(String(hostname || "").toLowerCase());
}

/** 访客有没有明确选过国际站：cookie 或 ?region=intl。两处都认 "intl" 和老写法 "us"。 */
export function regionChoice(cookie: string, search: string): "intl" | "" {
  const fromArg = new URLSearchParams(String(search || "")).get(REGION_PARAM);
  if (fromArg === "intl" || fromArg === "us") return "intl";
  const m = String(cookie || "").match(new RegExp(`(?:^|;\\s*)${REGION_COOKIE}=([^;]*)`));
  const v = m ? decodeURIComponent(m[1]).trim() : "";
  return v === "intl" || v === "us" ? "intl" : "";
}

/**
 * nginx 的 /__geo 给的事实。country 是 ISO 两字母（没有就是 "XX"），region 是省名或省码，strict 是
 * nginx 自己的裁决，mirror 是**此刻真在服务的**镜像域名（改名过渡期新旧两个名字哪个有证书就是哪个，
 * 由 install-nginx.sh 决定；客户端跳转只认它，不认自己那份常量——常量可能领先于线上）。
 */
export interface GeoFacts {
  country?: string;
  region?: string;
  strict?: number | boolean;
  mirror?: string;
}

export function hasChineseLanguage(languages: readonly string[] | undefined | null): boolean {
  return (languages || []).some((l) => /^zh\b/i.test(String(l || "")));
}

export function isStrictRegion(region: string | undefined | null): boolean {
  const r = String(region || "").trim();
  if (!r) return false;
  // 不锚定结尾：DB-IP 有时写成 "Zhejiang Sheng"；省码可能带 "CN-" 前缀。
  return STRICT_REGIONS.some((s) => new RegExp(`^(?:CN-)?${s}\\b`, "i").test(r));
}

/**
 * 这个页面要不要换到镜像域名去。只在美国站上问这个问题；答「是」的只有两种情况：
 *   · nginx 已经裁定 strict（正常情况下 nginx 自己就跳了，这里是兜底）；
 *   · IP 在中国大陆、库里没有省份、浏览器语言是中文 —— 「IP + 语言」那一刀。
 * 大陆但省份明确不在名单里 → 不换（不受限的用户留在美国站，那是产品的本意）。
 */
export function shouldRedirectToMirror(input: {
  hostname: string;
  cookie: string;
  search: string;
  languages: readonly string[] | undefined | null;
  geo: GeoFacts | null | undefined;
}): boolean {
  if (isCnMirrorHost(input.hostname)) return false;
  if (regionChoice(input.cookie, input.search) === "intl") return false;
  const geo = input.geo;
  if (!geo || String(geo.country || "").toUpperCase() !== "CN") return false;
  if (geo.strict === 1 || geo.strict === true) return true;
  const region = String(geo.region || "").trim();
  if (region) return isStrictRegion(region);
  return hasChineseLanguage(input.languages);
}

/** 把当前地址原样搬到镜像域名：路径、查询、锚点一个不丢（下载锚点 #download 也要跟着走）。 */
export function mirrorUrlFor(href: string, mirrorHost: string = CN_MIRROR_HOST): string {
  const u = new URL(href);
  u.protocol = "https:";
  u.host = isCnMirrorHost(mirrorHost) ? mirrorHost : CN_MIRROR_HOST;
  return u.toString();
}

/** 镜像页脚「访问国际站」的地址：带上 ?region=intl，mrday.one 见到它就种 cookie、不再分流。 */
export function intlSiteUrl(pathname = "/", hash = ""): string {
  const u = new URL(pathname, INTL_ORIGIN);
  u.searchParams.set(REGION_PARAM, "intl");
  u.hash = hash;
  return u.toString();
}

/** 公安备案的查询链接（备案号里的数字串）。 */
export function gonganHref(code: string): string {
  const digits = String(code || "").replace(/\D/g, "");
  return digits ? `https://beian.mps.gov.cn/#/query/webSearch?code=${digits}` : "https://beian.mps.gov.cn/";
}

/** 规范地址随所在域名走：镜像（新旧名字都算）把自己当正主，其余一律指向美国站；搜索引擎不会把两份内容当成互相抄。 */
export function canonicalFor(hostname: string, pathname = "/"): string {
  const origin = isCnMirrorHost(hostname) ? `https://${String(hostname).toLowerCase()}` : INTL_ORIGIN;
  return new URL(pathname, origin).toString();
}

async function fetchGeo(timeoutMs: number): Promise<GeoFacts | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch("/__geo", { signal: ctl.signal, credentials: "omit", cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as GeoFacts;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 页面一进来就跑（main.tsx，渲染之前）：先写 canonical，再决定要不要换域名。
 * 返回 true 表示已经发起跳转。
 */
export async function installRegionRouting(w: Window = window): Promise<boolean> {
  const { hostname, pathname, search, href } = w.location;
  try {
    let link = w.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = w.document.createElement("link");
      link.rel = "canonical";
      w.document.head.appendChild(link);
    }
    link.href = canonicalFor(hostname, pathname);
  } catch {
    /* 没有 head 可写就算了，canonical 只是锦上添花 */
  }
  if (isCnMirrorHost(hostname)) return false;
  if (regionChoice(w.document.cookie, search) === "intl") return false;
  // 非中文浏览器连 /__geo 都不查：nginx 那一刀已经按 IP 做完了，这里只补「语言」那一半。
  if (!hasChineseLanguage(w.navigator.languages)) return false;
  const geo = await fetchGeo(1500);
  if (!shouldRedirectToMirror({ hostname, cookie: w.document.cookie, search, languages: w.navigator.languages, geo })) return false;
  // 只跳到线上此刻真在服务的那个镜像名字（nginx 在 /__geo 里报的）。nginx 没报（老版本配置）或报了
  // 个不认识的名字就不跳：常量可能领先于线上（改名过渡期），按常量跳会把人送到一个还没上线的域名。
  const mirror = String(geo?.mirror || "").toLowerCase();
  if (!isCnMirrorHost(mirror)) return false;
  w.location.replace(mirrorUrlFor(href, mirror));
  return true;
}
