# Mr. Day One 官网 SEO 改造方案 v1.5

> 适用范围：[ide/website/](../ide/website/)（Vite + React 19 + TS + Tailwind 4 SPA）
> 部署目标：`https://mrday.one`（nginx 静态托管于 `154.44.13.133:/var/www/michael-sites/_hosts/www`）
> 文档状态：**评审稿**，不涉及代码改动
> v1 → v1.5 变更：新增 §13 Bing Webmaster Tools、§14 ASO、§15 GEO；§9 验证清单扩展
> 评审目标：多语言（中/英/日）+ Google 富媒体展示 + Google 英文搜索 + Bing 多引擎 + 应用商店分发（ASO）+ 生成式引擎引用（GEO）

---

## 0. 阅读对象与术语

- **SEO**：Search Engine Optimization，搜索引擎优化
- **JSON-LD**：JavaScript Object Notation for Linked Data，Google 推荐的结构化数据格式
- **hreflang**：跨语言/跨区域标签，告诉搜索引擎同一内容有不同语言版本
- **CLS / LCP / INP**：Core Web Vitals 三大指标，分别衡量视觉稳定性、最大内容渲染时延、交互响应
- **SPA**：Single Page Application，单页应用，初始 HTML 为空，依赖 JS 渲染
- **OG / Twitter Card**：社交分享卡片协议（Open Graph / Twitter）

---

## 1. 现状摘要（基线）

| 项目 | 当前实现 | SEO 影响 |
|---|---|---|
| 源码位置 | [ide/website/](../ide/website/) | — |
| 构建产物 | `ide/website/dist/`（`npm run build`，prebuild 钩子重生成 `public/tools.json`） | — |
| 部署 | `server/deploy-website.sh` 上传到 nginx 静态目录 | — |
| 路由 | `src/App.tsx` 内 `PAGES` 表 + `location.pathname` 正则匹配 | **SPA，爬虫拿不到内容** |
| HTML 入口 | [ide/website/index.html](../ide/website/index.html) | 单一一份，所有"页面"共用 |
| 多页面 | `/changelog`、`/rankings`、`/docs`、`/docs/<slug>` 由 nginx try_files 回落 + 客户端路由 | 同上 |
| `<title>` | 站内硬编码首页文案，子页运行时用 `document.title` 改写 | Google 能解析但慢、易漏 |
| `<meta description>` | 仅首页一份 | 子页沿用首页描述，无差异化 |
| Open Graph | **缺失** | 分享无卡片 |
| Twitter Card | **缺失** | 同上 |
| canonical | **缺失** | 易被判定重复内容 |
| sitemap.xml | **缺失** | 新页面收录慢 |
| robots.txt | **缺失** | 默认规则，但缺明确声明 |
| JSON-LD | **缺失** | 无富媒体卡片 |
| hreflang | **缺失** | 不支持多语言版本 |
| 图片 alt | 待核查（`src/assets/`） | 待补 |
| 结构化数据 | 仅 `public/tools.json`（给前端用，非 SEO） | 无 JSON-LD，富媒体不可见 |
| Google Search Console | **未注册** | 收录监控与索引请求缺失 |
| Bing Webmaster Tools | **未注册** | 占全球搜索 ~10%，且 ChatGPT 引用源之一（§13） |
| IndexNow | **未接入** | 页面更新无法秒级推送 |
| AI 爬虫策略 | `robots.txt` 未明确 | 未表态允许/拒绝 GPTBot/ClaudeBot 等（§15） |
| llms.txt | **缺失** | 不利于 LLM 抓取站内结构 |
| Mac App Store / Microsoft Store | 当前 `.dmg`/`.exe` 直分发，无应用商店上架 | ASO 现状待定（§14） |
| `public/app/` | 网页版 IDE，路径 `/app/`，独立 bundle | 不在 SEO 范围 |

**核心痛点**：现在的站是「一个 SPA + 一个共享 meta」，对搜索引擎几乎是「黑盒」。做多语言和富媒体，必须先解决「每个 URL 必须有一份独立 HTML」这个根问题。

---

## 2. 目标与边界

### 2.1 必须达成（Must-have）

1. 每个公开 URL 返回独立 HTML（含独立 `<title>` / `<meta>` / canonical / hreflang）
2. 至少 3 个语言版本：英文（默认）、简体中文、日文
3. 每个页面输出对应 JSON-LD，命中 Google Rich Result 候选集
4. 提供 `sitemap.xml`、`robots.txt`、`sitemap-{lang}.xml`（多语言）
5. Lighthouse SEO ≥ 95（移动/桌面）

### 2.2 应该达成（Should-have）

1. 下载页（`/`、`/product`）输出 `SoftwareApplication` JSON-LD，搜索结果出现「下载按钮」卡片
2. 产品页 `/product` 输出 `Product` + `BreadcrumbList`
3. `changelog` 每条更新输出 `Article` + `BreadcrumbList`
4. FAQ 区（如有）输出 `FAQPage`
5. 站内 OG 分享卡片可视化（Twitter / Facebook / LinkedIn）

### 2.3 不在范围（Out-of-scope）

- `/app/` 网页版 IDE 的 SEO（属于应用本身，不属于产品官网）
- `/login`、`/console-*`、`/account-*` 等用户私有页（应加 `noindex`）
- 后端搜索（如自建全文搜索）—— 暂不引入
- 广告投放 / 竞价（运营层面）

### 2.4 验收度量

| 指标 | 目标 |
|---|---|
| Google 索引公开页数 | 上线 4 周内 ≥ 90% |
| 关键字「Mr. Day One」、「AI-native code editor」首页命中 | Top 10 |
| 富媒体卡片在 Google 搜索结果可见 | ≥ 3 类（Software、Product、Breadcrumb） |
| Lighthouse SEO | ≥ 95 |
| LCP（移动 4G 模拟） | ≤ 2.5s |
| CLS | ≤ 0.1 |
| INP | ≤ 200ms |

---

## 3. 多语言策略（核心决策）

### 3.1 URL 结构选择

三种主流方案对比：

| 方案 | 示例 | 优点 | 缺点 |
|---|---|---|---|
| **子路径（推荐）** | `mrday.one/zh/`、`mrday.one/ja/` | 配置简单；同一域名；GTM/GA 一处；hreflang 易写 | 主域名权重需要分散传递 |
| 子域名 | `zh.mrday.one`、`ja.mrday.one` | 视觉独立 | SEO 视为独立站，权重不互通 |
| 国家域 | `mrday.cn` | 本地化最深 | 成本高、不必要 |

**推荐：子路径**。与品牌一体，hreflang 一份，部署最简单。

### 3.2 语言代码与默认域

| 语言 | URL 前缀 | `hreflang` 值 | 备注 |
|---|---|---|---|
| English（默认） | `/` | `en` | 不带前缀，根域为默认 |
| 简体中文 | `/zh/` | `zh-Hans` | 简体 |
| 繁体中文（可选） | `/zh-tw/` | `zh-Hant` | 第二阶段 |
| 日文 | `/ja/` | `ja` | — |
| 其他（未来） | `/de/`、`/es/` … | `de`、`es` … | 按需 |

### 3.3 翻译来源与流程

- 站内文案集中存放在 `src/i18n/{locale}.ts`，按 namespace 切分（`nav`、`hero`、`features`、`docs`、`changelog`、`footer`）
- 文案字段用 TypeScript 强类型约束（避免漏翻译）
- 不引入运行时 i18n 库（i18next、react-intl），原因：
  1. SPA 场景下，翻译文件打进 bundle 会拖慢首屏
  2. SEO 场景下，更需要「**预渲染时按 locale 注入**」，而非运行时切换
- 引入 `react-i18next` 仅作「客户端切换」兜底（用户已选语言后，CSR 内导航仍可用）

### 3.4 翻译执行

- 机器翻译：DeepL API（英文 → 中/日质量优于 Google Translate）
- 人工校对：关键页（首页、产品页、文档首页）必须人工过一遍
- 翻译不动的：代码示例、命令、文件名、版本号

### 3.5 语言切换器

- 位置：Navbar 右上角，`Globe` 图标（**SVG 自绘**，不用 emoji）
- 行为：点击展开下拉，列出当前支持语言；切换后跳到当前页面对应语言版本（如 `/product` → `/zh/product`）
- 持久化：`localStorage["locale"]`；无值时按 `navigator.language` 推断
- URL 与 localStorage 不一致时，**hreflang + canonical 决定搜索**，**语言切换器按 localStorage**

---

## 4. 富媒体结构化数据（JSON-LD）

### 4.1 全站通用

每个页面都应输出 `Organization` + `WebSite` JSON-LD（首页才输出完整 `WebSite.SearchAction`）：

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Mr. Day One",
  "url": "https://mrday.one",
  "logo": "https://mrday.one/logo.png",
  "sameAs": [
    "https://github.com/<org>",
    "https://x.com/<handle>",
    "https://www.linkedin.com/company/<handle>"
  ]
}
```

`WebSite`（仅首页）：

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Mr. Day One",
  "url": "https://mrday.one",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://mrday.one/docs?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
```

### 4.2 软件下载富卡片

`/`（CTA 区）和 `/product`：

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Mr. Day One",
  "operatingSystem": "Windows 10+, macOS 13+",
  "applicationCategory": "DeveloperApplication",
  "softwareVersion": "0.14.6",
  "downloadUrl": "https://mrday.one/",
  "fileSize": "<MB>",
  "screenshot": [
    "https://mrday.one/og/screenshot-1.png"
  ],
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "4.8",
    "ratingCount": "<N>"
  }
}
```

注：`aggregateRating` 需要真实数据；若无可不写，避免被 Google 判定为虚假。

### 4.3 文档页 `TechArticle`

`/docs/<slug>`：

```json
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "<article title>",
  "description": "<article excerpt>",
  "author": { "@type": "Organization", "name": "Mr. Day One" },
  "datePublished": "<ISO>",
  "dateModified": "<ISO>",
  "inLanguage": "<locale>",
  "proficiencyLevel": "Beginner"
}
```

### 4.4 Changelog `Article` + `BreadcrumbList`

`/changelog` 页面 + 每条更新：

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://mrday.one/" },
    { "@type": "ListItem", "position": 2, "name": "Changelog", "item": "https://mrday.one/changelog" },
    { "@type": "ListItem", "position": 3, "name": "v0.14.6", "item": "https://mrday.one/changelog#v0.14.6" }
  ]
}
```

每条更新块：

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Version 0.14.6 — <release title>",
  "datePublished": "2026-08-15",
  "articleSection": "Release Notes",
  "author": { "@type": "Organization", "name": "Mr. Day One" }
}
```

### 4.5 FAQ `FAQPage`

若产品页或文档页加 FAQ 区：

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Does Mr. Day One run on Windows 11?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, Windows 10 and 11 are supported."
      }
    }
  ]
}
```

### 4.6 注入方式

- 预渲染阶段，按当前 locale + route 在 HTML `<head>` 注入 `<script type="application/ld+json">…</script>`
- 客户端切换语言时，**移除旧 LD JSON，重新注入**（用 `react-helmet-async` 或同等能力的轻量方案）
- **禁止**：用 `dangerouslySetInnerHTML` 拼接不可信输入；所有 LD JSON 必须从结构化对象序列化，**纯函数构造**

---

## 5. Meta 标签体系重构

### 5.1 `<title>` 规则

格式：`<页面标题> — Mr. Day One`

- 英文：`Mr. Day One — The AI-native editor that verifies its own work`
- 中文：`Mr. Day One — 会自我验证的 AI 代码编辑器`
- 日文：`Mr. Day One — 自分の作業を検証する AI ネイティブエディター`
- 子页：`Changelog — Mr. Day One`、`Documentation — Mr. Day One`

### 5.2 `<meta description>` 规则

- 长度：英文 150–160 字符；中文/日文 80–110 字符
- 每页独立，禁止复用
- 包含目标关键词（首页：`AI code editor`、`AI-native editor`、`agent loop`）
- 子页针对该页主题

### 5.3 必须补齐的 meta

每页：

```html
<meta name="description" content="..." />
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
<link rel="canonical" href="https://mrday.one/<canonical-path>" />
<link rel="alternate" hreflang="en" href="https://mrday.one/<en-path>" />
<link rel="alternate" hreflang="zh-Hans" href="https://mrday.one/zh/<zh-path>" />
<link rel="alternate" hreflang="ja" href="https://mrday.one/ja/<ja-path>" />
<link rel="alternate" hreflang="x-default" href="https://mrday.one/<en-path>" />

<!-- Open Graph -->
<meta property="og:type" content="<website|article>" />
<meta property="og:url" content="https://mrday.one/<path>" />
<meta property="og:title" content="..." />
<meta property="og:description" content="..." />
<meta property="og:image" content="https://mrday.one/og/<page>.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:locale" content="en_US" />
<meta property="og:locale:alternate" content="zh_CN" />
<meta property="og:locale:alternate" content="ja_JP" />
<meta property="og:site_name" content="Mr. Day One" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@<handle>" />
<meta name="twitter:title" content="..." />
<meta name="twitter:description" content="..." />
<meta name="twitter:image" content="https://mrday.one/og/<page>.png" />
```

私有页（`/login`、`/account/*`）：

```html
<meta name="robots" content="noindex,nofollow" />
```

### 5.4 OG 图片生成

- 尺寸：`1200×630`（Facebook/LinkedIn/标准）
- 每页一张静态图（首页、产品页、文档首页、Changelog）
- 命名：`og/<locale>/<page>.png`，例：`og/en/home.png`、`og/zh/product.png`
- 字体：与官网一致（Space Grotesk + Inter）
- **手工设计 SVG → 导出 PNG**（符合 TODO 8、40，不用 Emoji）
- 模板固定，文案按 locale 替换
- 数量预估：3 语言 × 5 页 = 15 张

---

## 6. 技术路线选择（不动代码，先定方案）

### 6.1 候选

| 路线 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. 预渲染（推荐）** | Vite 构建时按 `route × locale` 生成静态 HTML，每个 URL 一份 | 改动小；nginx 直接用；SEO 满血 | 动态数据需提前拉；构建时间翻 N 倍 |
| B. SSR（Node） | 引入 Express/Fastify + React 渲染 | 动态数据友好 | 需 Node 运行时，与现有 nginx 静态模型冲突；运维成本陡增 |
| C. 边缘 SSR（Cloudflare Workers） | 在 Workers 渲染 | 全球低延迟 | 当前部署未走 CF Workers，需重构 |
| D. 仅加 meta（不预渲染） | 保留 SPA，仅补 meta/sitemap/robots | 最小改动 | Google/Bing 仍难抓内容，富媒体缺失根因未解 |

**推荐 A**。

### 6.2 预渲染实现要点

- 工具：`vite-plugin-prerender-spa-plugin` 或 `vike`（前称 `vite-plugin-ssr`）
- 入口：复用当前 `App.tsx` 的 `PAGES` 表，扩展支持 `/zh/*`、`/ja/*` 前缀
- 路由全集：`/`、`/product`、`/changelog`、`/rankings`、`/model`、`/docs`、`/docs/<slug>` × 3 语言 = 18+ HTML（不含 docs 子文章）
- 渲染时机：`npm run build` 阶段完成；`prebuild` 已有（提取 tools.json），追加 `prerender` 钩子
- 数据预取：`/changelog`、`/rankings` 数据来源若为运行时 API，需改为构建时拉取并注入
- `public/app/`（网页版 IDE）不参与预渲染——保持原样

### 6.3 部署侧调整

`server/deploy-website.sh` 无需大改，仅注意：

- 预渲染后 `dist/` 内每个 `index.html` 都带具体路径（已是 Vite SPA fallback 的目录式结构，或全扁平——视插件产物）
- nginx try_files 配置保持 `try_files $uri $uri/ /index.html` 即可
- 新增的 `sitemap*.xml`、`robots.txt` 放在 `public/` 根目录，会被 Vite 复制到 `dist/`

### 6.4 nginx 配置补充建议

不在代码范围，但建议补：

```
# /etc/nginx/sites-enabled/mrday-site
server {
  listen 443 ssl http2;
  server_name mrday.one;

  # gzip 已生效
  gzip on;
  gzip_types text/plain text/css application/json application/javascript application/ld+json application/xml image/svg+xml;

  # SEO 文件强缓存
  location = /sitemap.xml         { expires 1h; }
  location = /robots.txt          { expires 1d; }

  # 预渲染的静态 HTML 长缓存（带版本号时）
  location ~* \.html$             { expires -1; add_header Cache-Control "no-cache"; }

  # 静态资源
  location /assets/               { expires 1y; add_header Cache-Control "public, immutable"; }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

---

## 7. 各页面 SEO 清单

### 7.1 `/`（首页）

- title：`Mr. Day One — The AI-native editor that verifies its own work`
- description：英文强调「verifies its own work / agent loop / repo indexing」
- JSON-LD：`WebSite` + `Organization` + `SoftwareApplication`
- OG：1200×630，产品截图 + slogan
- hreflang：`en`、`zh-Hans`、`ja`、`x-default`

### 7.2 `/product`

- title：`Product — Mr. Day One`
- description：功能全景、对比竞品（Cursor、Copilot）
- JSON-LD：`Product` + `BreadcrumbList`（`Home › Product`）
- OG：特性图

### 7.3 `/model`

- title：`Model — Mr. Day One`
- description：模型选择 / Agent loop / 上下文策略
- JSON-LD：`Article` + `BreadcrumbList`

### 7.4 `/rankings`

- title：`Rankings — Mr. Day One`
- description：评测榜单、第三方基准
- JSON-LD：`ItemList`（榜单） + `BreadcrumbList`

### 7.5 `/changelog`

- title：`Changelog — Mr. Day One`
- description：版本更新日志
- JSON-LD：每条 `Article`；外层 `BreadcrumbList`
- OG：版本号 + 关键改动

### 7.6 `/docs` 和 `/docs/<slug>`

- title：`Documentation — Mr. Day One` / `<doc title> — Docs · Mr. Day One`
- description：每篇文章独立摘要
- JSON-LD：`TechArticle` + `BreadcrumbList`
- 文章之间用 `Article.mainEntity` / `relatedLink` 互联
- **关键**：`/docs` 集合页要支持 Google 「site links search box」

### 7.7 `/login`

- `<meta name="robots" content="noindex,nofollow">`
- 不输出 OG、JSON-LD

### 7.8 `/app/*`（网页版 IDE）

- `<meta name="robots" content="noindex,nofollow">`
- 不参与 sitemap
- **理由**：这是应用而非文档，索引意义不大

---

## 8. 实施路线图（分阶段）

### Phase 1 — 基础（**第 1 周**）

- [ ] 引入 `react-helmet-async`，封装 `<SeoHead>` 组件
- [ ] 拆 `src/i18n/{en,zh,ja}.ts`，首页 + Navbar + Footer 文案落地
- [ ] 为 7 个公开页生成预渲染 HTML（`vite-plugin-prerender-spa`）
- [ ] 每页注入：title、description、canonical、hreflang
- [ ] `robots.txt`、`sitemap.xml`（英文为主）落地
- [ ] OG 图：英文首页 1 张
- [ ] Google Search Console 验证站点

### Phase 2 — 多语言（**第 2–3 周**）

- [ ] 翻译：中文、日文首页 + 产品页 + 文档首页 + Changelog
- [ ] 预渲染矩阵：`3 语言 × 7 页 = 21 个 HTML`
- [ ] 语言切换器组件
- [ ] hreflang 完整配置
- [ ] `sitemap-en.xml`、`sitemap-zh.xml`、`sitemap-ja.xml` 三份
- [ ] OG 图：中、日各 5 张

### Phase 3 — 富媒体（**第 4 周**）

- [ ] `Organization` + `WebSite` JSON-LD 注入
- [ ] `SoftwareApplication` JSON-LD（下载页）
- [ ] `BreadcrumbList` 全站
- [ ] `Article` JSON-LD（changelog 条目）
- [ ] `TechArticle` JSON-LD（docs 文章）
- [ ] Google Rich Results Test 全量过一遍

### Phase 4 — 验证与调优（**第 5–6 周**）

- [ ] Lighthouse SEO 跑分（移动/桌面）
- [ ] PageSpeed Insights 性能调优
- [ ] Search Console 索引覆盖率
- [ ] hreflang 验证（Search Console 国际定位报告）
- [ ] 关键字排名监控（基础 20 个词）
- [ ] 收录量周报

---

## 9. 验证与监控

### 9.1 上线前必须通过的检查

| 检查项 | 工具 | 通过标准 |
|---|---|---|
| 富媒体 | Google Rich Results Test | 无 error，有 warning 需评估 |
| 移动友好 | Google Mobile-Friendly Test | 通过 |
| 性能 | PageSpeed Insights | LCP ≤ 2.5s、CLS ≤ 0.1、INP ≤ 200ms |
| SEO 综合 | Lighthouse | ≥ 95 |
| hreflang | GSC 国际定位报告 | 无错误 |
| sitemap | GSC + Bing WMT 双站点地图 | 双引擎均「已处理」 |
| robots | 抓取测试（`/robots.txt`） | 200，可解析 |
| canonical | URL 检查工具 | 与 href 一致 |
| OG | Facebook Sharing Debugger / Twitter Card Validator | 卡片正常 |
| Bing 抓取 | Bing WMT URL Inspection | 索引、Markup、Keyword 一致 |
| AI 爬虫可访问 | 各家 `User-Agent` 验证（GPTBot/ClaudeBot/PerplexityBot/Google-Extended） | 关键爬虫不被误拦 |
| IndexNow 推送 | `server/logs/indexnow.log` | 部署即推、HTTP 200 |
| Rich Results 多引擎 | Schema Markup Validator（schema.org） | JSON-LD 合规 |

### 9.2 上线后监控

- **Google Search Console**：覆盖范围、效果、增强功能、Core Web Vitals
- **Bing Webmaster Tools**：URL Inspection、SEO Analyzer、Crawl Control、AI Performance（公开预览，§13.5）
- **IndexNow** 提交日志（`server/logs/indexnow.log`）
- 关键字排名（人工 spot check，前 20 个目标词，含中/英/日）
- 收录量周报：`server/scripts/seo-audit.sh` 跑 `site:mrday.one`、`site:zh.mrday.one`、`site:ja.mrday.one` 抓取数量
- AI 引用监控：每周跑 prompt audit（25–50 条），解析 ChatGPT / Perplexity / Gemini 引用情况（详见 §15.6）
- Core Web Vitals（CrUX）

---

## 10. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 预渲染使构建时间翻倍 | CI 变慢 | 增量构建 + 缓存；docs 文章列表稳定后单独缓存 |
| 翻译不准/漏翻 | 信任感下降 | DeepL 起草 + 人工复核关键页 |
| hreflang 错配 | 索引错语言版本 | 上线前 Search Console 全量验证 |
| 多语言 OG 图数量翻倍 | 设计成本 | 模板化 SVG → 一次性导出 |
| JSON-LD 报错被 Google 忽略 | 富媒体不展示 | Rich Results Test 上线前必过 |
| `public/app/` 网页版 IDE 也跑同一 `App.tsx` | 误把 IDE 路径加入 sitemap | sitemap 显式 exclude `/app/*` |
| `localStorage` 与 URL 语言不一致 | 用户切语言后搜索仍命中旧版本 | 以 URL 为权威，切换器只改 URL |

---

## 11. 落地清单（可勾选）

### 11.1 代码侧（不动手，先列）

- [ ] `ide/website/src/lib/seo.ts`：构造 title/description/canonical/hreflang/OG/Twitter
- [ ] `ide/website/src/components/seo-head.tsx`：基于 `react-helmet-async` 的封装
- [ ] `ide/website/src/components/json-ld.tsx`：注入 JSON-LD
- [ ] `ide/website/src/components/language-switcher.tsx`
- [ ] `ide/website/src/i18n/{en,zh,ja}.ts`
- [ ] `ide/website/src/i18n/types.ts`：TS 强类型
- [ ] `ide/website/public/robots.txt`
- [ ] `ide/website/scripts/build-sitemap.mjs`：根据路由列表生成 `sitemap*.xml`
- [ ] `ide/website/vite.config.ts`：注册预渲染插件
- [ ] `ide/website/package.json`：新增依赖与 `prerender` 脚本

### 11.2 设计侧

- [ ] OG 模板设计稿（SVG，含中/英/日版本）
- [ ] Language Switcher 图标（SVG 自绘）
- [ ] 「下载」卡片视觉

### 11.3 内容侧

- [ ] DeepL 翻译产物
- [ ] 人工校对（首页、产品页、文档首页、Changelog）
- [ ] 关键字清单（主 + 长尾）

### 11.4 运维侧

- [ ] Google Search Console 站点验证
- [ ] Bing Webmaster 验证
- [ ] sitemap 提交
- [ ] nginx 配置微调（gzip、缓存策略）

---

## 12. 评审请决策

下列待你拍板，确认后我才进入实施阶段：

### SEO & 多语言

1. **多语言范围**：先做中/英/日，繁体/其他延后？是否同意？
2. **URL 结构**：子路径 `/zh/`、`/ja/`？是否同意？
3. **技术路线**：预渲染（方案 A）？还是先只做最小改动（方案 D）观察一段时间？
4. **OG 图预算**：3 语言 × 5 页 = 15 张，由设计同学做还是我直接用 SVG 模板出？
5. **关键字清单**：是否已有 SEO 目标词？还是由我先调研 Top 30 候选词给你挑？
6. **时间节奏**：6 周落地可接受？还是要求更紧 / 更松？

### Bing & 多引擎

7. **Bing WMT 验证方式**：从 GSC 一键导入（最快）/ DNS TXT / 文件上传？
8. **IndexNow 接入**：是否同意我写一个 `server/scripts/indexnow-submit.sh` 在每次部署后自动推送 sitemap 中所有 URL？

### ASO

9. **分发渠道现状**：Mac 是 `.dmg` 直接下载（首页 CTA 显式标 `MacOS 13+ · Intel · .dmg`、`Apple Silicon Mac? Get that build`）。是否计划上架 Mac App Store / Microsoft Store？还是继续走 `.dmg`/`.exe` 直分发？

### GEO

10. **AI 爬虫策略**：默认放行 GPTBot、ClaudeBot、PerplexityBot、OAI-SearchBot、Google-Extended、anthropic-ai、cohere-ai（允许训练/检索）。如有顾虑可逐个白名单。
11. **llms.txt**：是否要加？2026 主流 LLM 尚未官方支持读取，但作为「对 AI 友好」信号有加分。
12. **站外权威源**：是否愿意投入时间在 Wikipedia / Wikidata / Reddit / YouTube / Trustpilot / Hacker News 等做品牌存在？2026 数据：行业出版物引用加权 ~5x。
13. **GEO 测量**：是否采购第三方工具（LLM Pulse、Profound、Otterly、Peec.ai）？还是先自建脚本跑 25–50 条 prompt？

---

## 13. Bing Webmaster Tools（与 GSC 并列）

### 13.1 为什么必须做 Bing

- 2026 年 Bing 占全球桌面搜索 ~10%（仍有量）
- **ChatGPT 搜索 ~87% 的引用来自 Bing top 结果**——做 Bing = 做 ChatGPT 引用源
- Bing 自动共享 sitemap 给 Yahoo Search，**一次提交两个引擎**
- Bing WMT 2026 推出 **AI Performance 报告**（公开预览），可监控 Copilot/AI 引擎引用

### 13.2 验证方式（5 选 1）

| 方式 | 适用 | 备注 |
|---|---|---|
| **从 GSC 导入**（推荐） | GSC 已验证域名 | 几秒钟 |
| **Domain Connect** | DNS 在 GoDaddy/Bluehost/Wix | 一键 |
| `BingSiteAuth.xml` 上传 | 有 FTP 权限 | 与 GSC `google*.html` 同源思路 |
| `<meta>` 标签 | CMS / 可改 HTML | 加在首页 `<head>` |
| DNS TXT / CNAME | 可控 DNS | 改动稍大 |

`www.` 与裸域 Bing 视为**独立属性**，二选一时以 canonical 为准。

### 13.3 Sitemap 提交

1. 登录 `https://www.bing.com/webmasters`
2. 左侧 `Sitemaps` → `Submit Sitemap`
3. 提交 `https://mrday.one/sitemap.xml`（如有 index 文件：`sitemap_index.xml`）
4. 多语言场景：分别提交 `sitemap-en.xml`、`sitemap-zh.xml`、`sitemap-ja.xml`

**限制**：单 sitemap ≤ 50,000 URL、≤ 50 MB；超过用 sitemap index 串接。

### 13.4 IndexNow 接入（强烈建议）

IndexNow 让 URL 变更秒级推送，是 Bing 官方推荐、与 Yandex/DuckDuckGo 等共用的协议。

**接入步骤**：

1. 在 [https://www.indexnow.org/](https://www.indexnow.org/) 生成 API Key（128-bit hex）
2. 把 key 写到 `https://mrday.one/<key>.txt`（每个站点一个 key）
3. 每次部署后，调用 `https://api.indexnow.org/indexnow`：

   ```json
   {
     "host": "mrday.one",
     "key": "<key>",
     "keyLocation": "https://mrday.one/<key>.txt",
     "urlList": [
       "https://mrday.one/",
       "https://mrday.one/zh/",
       "https://mrday.one/ja/product"
     ]
   }
   ```

4. 推荐做法：`server/scripts/indexnow-submit.sh` 读 `sitemap.xml` 后批量推送，挂在 `deploy-website.sh` 末尾
5. 日志写到 `server/logs/indexnow.log`，便于追踪

**配额**：免费版每分钟 10,000 URL，每日 100,000 URL，超出会 429。

### 13.5 Bing WMT 必用功能清单

- **URL Submission**：手动提交单 URL 优先抓取
- **Crawl Control**：调节 Bing 抓取频率、屏蔽段
- **Site Scan**：自动审计 SEO 问题
- **Backlinks**：外链监控
- **Robots.txt Tester**：与 GSC 等价
- **SEO Analyzer**：内容质量评分
- **AI Performance**（公开预览）：监控 Copilot/AI 引擎引用

### 13.6 与 GSC 的差异点

| 维度 | GSC | Bing WMT |
|---|---|---|
| 数据延迟 | 1–3 天 | 实时 ~ 数小时 |
| AI 引擎数据 | Google AI Overviews | Copilot / ChatGPT 引用源 |
| 关键字工具 | 内置 + URL Inspection | Keyword Research（独立工具） |
| 反向链接 | 链接文件 + Links | Backlinks 报告 |
| 抓取频率上限 | 默认 | 可手动调 |
| Sitemap 上限 | 50,000 / 50MB | 同 |

---

## 14. ASO（应用商店优化）

> 当前部署：`download for Windows`、`.dmg` 直下载（首页 CTA 显式标 `MacOS 13+ · Intel · .dmg`、`Apple Silicon Mac? Get that build`），是**直分发**而非应用商店。
> ASO 章节按用户要求前置规划，但实际是否要做，取决于你接下来的分发决策（见 §12.9）。

### 14.1 上架优先级

| 商店 | 优先级 | 备注 |
|---|---|---|
| Mac App Store | **P0**（如要上） | 用户基数大、付费转化好；沙盒限制需评估（Tauri/SPA 是否兼容） |
| Microsoft Store（Windows） | **P1** | Windows 桌面主分发；可与 .exe 并存 |
| 第三方 Windows 商店 | **P2** | 暂无主流渠道，可观察 |
| iOS / iPadOS | **未来** | Mr. Day One 是 IDE，移动端场景弱 |
| 中国应用市场（华为、小米、OPPO、vivo、TapTap） | **P3** | 海外产品入驻难度大；按市场策略决定 |

### 14.2 Mac App Store 关键因子（2026）

**核心排名信号**：

1. **App Title（≤30 字符）**：放主关键词。候选：`Mr. Day One — AI Code Editor` 或 `Day One: AI Code Editor`
2. **Subtitle（≤30 字符）**：补充关键词，例：`Agent Loop · Repo Indexing · Verify`
3. **Keywords 字段（100 字符）**：逗号分隔、不带空格、不重复 Title/Subtitle 已用词。例如：
   `agent,ai,code,editor,ide,coding,assistant,terminal,debug,verify,refactor`
4. **下载速度（velocity）**：Apple 2026 比累积下载量更看重**加速度**——发布日冲量策略
5. **评论新鲜度 + 开发者回复**：比平均分更被 Apple 重视

**Mac 专属 2026 因子**：

- **Apple Silicon 原生支持**（必备，否则 2025 年底起明显掉权重）
- **macOS 最新版首发兼容**（仅 13+ 不够，要追到 14/15）
- **Privacy Nutrition Labels**：完整、准确；2025 隐私执法后信任信号影响排名
- **Bundle ID 与公证**：未公证或包名冲突直接下架

**转化因子**：

- **横屏截图（3–10 张）+ 预览视频**（Apple 2026 扩大视频位）
- **本地化文案**：美、英、德、日、中（按目标市场）

### 14.3 Microsoft Store 关键因子

- **Package Identity / MSIX**：Tauri 默认产物是 NSIS 安装包，需重打包为 MSIX
- **Store listing keywords**：英文 7 个 + 备用
- **Age rating + Content rating**：如实填写
- **Update cadence**：Windows 商店鼓励月度小更
- **Cross-device support**：声明桌面/平板/hololens 时影响分发范围

### 14.4 ASO 元数据资产清单（待补）

无论是否上商店，**统一的元数据 + 截图素材**都建议集中管理：

```
/marketing/app-store/
├── app-store-metadata.yaml       # 标题/副标题/描述/关键字（多语言）
├── screenshots/
│   ├── mac/
│   │   ├── en/01-hero.png       # 2560×1600 起步
│   │   ├── zh/01-hero.png
│   │   └── ja/01-hero.png
│   ├── windows/
│   └── ipad/
├── preview-videos/
├── icons/
│   ├── 1024.png                 # App Store 营销
│   ├── 512.png                  # Microsoft Store
│   └── store-front-*.png
└── privacy-labels.yaml          # 隐私数据声明（Data Not Collected 优先）
```

**建议做法**：截图用同一个 Figma/SVG 模板，按 locale × store 组合批量导出；**避免逐张硬编码**（TODO 30）。

### 14.5 描述文案结构（建议）

```
[Hook — 1 句价值主张]
[社会证明 — 1 行]
[核心功能 — 3 块，每块 ≤ 80 字]
[差异化 — vs 竞品对比]
[隐私 + 信任声明]
[CTA — 下载按钮 + 系统要求]
```

字数：Mac App Store 描述 ≤ 4000 字（首屏 170 字最重要）。

---

## 15. GEO（生成式引擎优化）

### 15.1 什么是 GEO

针对 ChatGPT / Perplexity / Gemini / Claude / Grok / AI Overviews 等**生成式引擎**的引用优化。
**和 SEO 的关系**：GEO ≠ 替代 SEO；强 SEO 直接喂 GEO 的实时检索。两者并行做。

### 15.2 2026 核心数据

- 44.2% 的 LLM 引用来自**页面前 30%**
- 每页加 1 个统计事实 → AI 可见度 +41%
- ChatGPT **约 87% 的引用对应 Bing top 结果**（所以 Bing WMT 必须做）
- **53.6% 的 ChatGPT 响应不返回 web 源**——测量时要先过滤掉
- Perplexity vs ChatGPT 产品页引用率差 ~50 倍——平台差异巨大

### 15.3 内容架构（站内）

#### 15.3.1 答案前置

每篇文章 / 每个区块：

- **首段 40–60 词直接回答问题**（不要铺垫、不要品牌故事开头）
- H1 = 问题本身（例：`How does Mr. Day One verify AI-generated code?`）
- H2/H3 每个只回答一个问题

#### 15.3.2 事实密度

- 每 100–150 词 1 个可验证事实（统计、命名实体、日期、引用）
- 命名实体优先（产品名、技术名、人物名）—— 实体是 LLM 抽取的高频对象

#### 15.3.3 E-E-A-T 信号

- **作者 bio**：即使是团队发布，也署 `Engineering Team at Mr. Day One` + 链接到团队页
- **发布日期 + 最近更新日期**：在首屏 100 字内出现 `Published 2026-xx-xx · Updated 2026-yy-yy`
- **原创研究 / 数据**：发布 benchmarks、对比测试结果（被 LLM 引用率显著高于二手信息）

#### 15.3.4 列表 / FAQ / 表格优先

- Top N 列表、step-by-step、FAQ、对比表——AI 引擎**事实偏好**这些结构
- `FAQPage` JSON-LD 必加（见 §4.5）

### 15.4 技术实施（站内）

#### 15.4.1 不挡 AI 爬虫

`robots.txt` 显式表态：

```
# Allow AI crawlers (GEO)
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: cohere-ai
Allow: /
```

注意区分：

- `GPTBot`（OpenAI 训练抓取）vs `OAI-SearchBot`（ChatGPT 搜索引用）——**两者都建议放行**，否则 ChatGPT 搜索不会出现你的页面
- `Google-Extended` ≠ `Googlebot`：前者是 Google AI 训练用的；如果你想被 AI Overviews 引用但不想被训练，可以只放 Google-Extended

#### 15.4.2 llms.txt（实验性）

按 [llmstxt.org](https://llmstxt.org/) 规范在站点根放 `/llms.txt`：

```
# Mr. Day One
> The AI-native code editor that verifies its own work.

## Docs
- [Getting Started](https://mrday.one/docs/getting-started): ...
- [Agent Loop](https://mrday.one/docs/agent-loop): ...

## Changelog
- [v0.14.6](https://mrday.one/changelog#v0.14.6): ...
```

**状态**：2026 主要 LLM（OpenAI、Anthropic、Google）尚未官方支持读取，但放一个零成本，且作为「对 AI 友好」信号有加分。

#### 15.4.3 Schema 增强

GEO 需要 §4 已规划的 schema 之外，补充：

- `HowTo`：教程步骤
- `Course` / `LearningResource`：文档站可加
- `Dataset` / `SoftwareSourceCode`：开源 / 工具型站点可加
- `QAPage`：QA 内容
- `ClaimReview`：事实核查
- `Review` + `aggregateRating`（仅在真实有用户评价时）

嵌套结构尤其有效——比如 Article 内嵌 FAQPage，LLM 抽取更准。

#### 15.4.4 服务端 HTML（强化 §6 决策）

**AI 爬虫不执行 JS**——SPA 的「首屏 HTML 只有 `<div id="root">`」对 GEO 是致命的。这就是为什么 §6 必须选 A（预渲染）或 B/C（SSR），不能选 D。

### 15.5 站外权威源（off-page GEO）

LLM 引用高度依赖**第三方权威站点**。按杠杆从高到低：

| 来源 | 杠杆 | 行动 |
|---|---|---|
| **Wikipedia / Wikidata** | 最高 | 创建 Wikidata 实体（Q-ID），积累引用 |
| **行业出版物**（TechCrunch、The Verge、9to5Mac、Hacker News） | 很高 | 发布 PR、技术解读文章 |
| **Reddit / YouTube 字幕** | 高 | 真实用户讨论/视频被大量引用 |
| **Trustpilot / G2 / Capterra** | 高 | 评分 + 评论被 LLM 频繁引用 |
| **GitHub README / Release Notes** | 中 | 与官网 changelog 联动 |
| **Product Hunt 档案** | 中 | 维护完整档案 |

**关键原则**：站外内容要「**实体一致**」——品牌名、创始人、发布日期、关键数据在所有渠道都一致。LLM 用实体匹配。

### 15.6 测量（Measurement）

**指标**：

- **Share of Voice**（引用份额）：每周跑 25–50 条 buyer-intent prompt，记录你被引用的比例
- **Citation Frequency**：被引用的总次数
- **Citation Sources**：哪些域名引用了你
- **Sentiment**：引用时的情感倾向
- **Position**：在 LLM 回答中你排第几

**目标平台**（2026）：

- ChatGPT（含搜索）
- Perplexity
- Gemini（含 AI Overviews）
- Google AI Mode
- Claude.ai
- Copilot（Bing）

**做法**：

- 自建 prompt 监控脚本：`server/scripts/geo-audit.sh` —— 调用各家 API 或 UI 抓结果 → 解析品牌出现
- 第三方工具：LLM Pulse、Profound、Otterly、Peec.ai——可选项

### 15.7 落地清单（增量）

**站内**：

- [ ] `robots.txt` 加 AI 爬虫规则（§15.4.1）
- [ ] `llms.txt`（§15.4.2）
- [ ] 内容改写：所有 H1 改为问题形式；首段 40–60 词直接答
- [ ] 关键页加统计/事实引用密度
- [ ] 文档加 FAQ / HowTo / TechArticle JSON-LD
- [ ] 团队页 + 作者署名

**站外**：

- [ ] 创建 Wikidata 实体
- [ ] Reddit（r/programming、r/MacApps、r/ChatGPTCoding）发布 AMA/案例研究
- [ ] Product Hunt 档案维护
- [ ] YouTube 教学视频（带完整字幕）
- [ ] G2/Capterra/Trustpilot 引导真实用户评价
- [ ] Hacker News Show HN（重要里程碑时）

**测量**：

- [ ] `server/scripts/geo-audit.sh`：每周 prompt 审计
- [ ] 仪表盘：`/internal/geo-dashboard`（内部页面，看 GEO 趋势）

---

## 附录 A：参考规范

### SEO & 富媒体

- Google Search Central — [Multi-regional and multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
- Google — [Structured Data General Guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- schema.org — [SoftwareApplication](https://schema.org/SoftwareApplication)、[TechArticle](https://schema.org/TechArticle)、[BreadcrumbList](https://schema.org/BreadcrumbList)、[FAQPage](https://schema.org/FAQPage)
- Google — [hreflang tags](https://developers.google.com/search/docs/specialty/international/localized-versions)
- Web Vitals — [LCP / CLS / INP](https://web.dev/vitals/)

### Bing & 多引擎

- Bing Webmaster Tools — [官方站点](https://www.bing.com/webmasters)
- IndexNow — [协议规范](https://www.indexnow.org/)、[API 文档](https://learn.microsoft.com/bing/index-now)
- Bing — [URL Submission API](https://learn.microsoft.com/bing/webmaster/url-submission-api)
- Bing Webmaster Blog — [AI Performance 报告（公开预览）](https://blogs.bing.com/webmaster)

### ASO

- Apple Developer — [App Store Marketing Resources](https://developer.apple.com/app-store/marketing/)
- Apple — [Privacy Nutrition Labels](https://developer.apple.com/app-store/app-privacy-details/)
- Microsoft — [Microsoft Store submission guide](https://learn.microsoft.com/windows/uwp/publish/)
- App Store Connect — [App Metadata](https://developer.apple.com/help/app-store-connect/manage-app-information)

### GEO

- Princeton/Georgia Tech — [GEO 原始论文 (Agrawal et al., 2023)](https://arxiv.org/abs/2311.09735)
- llmstxt.org — [llms.txt 提案](https://llmstxt.org/)
- OpenAI — [GPTBot 与 OAI-SearchBot 文档](https://platform.openai.com/docs/gptbot)
- Google — [Google-Extended User-Agent](https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers)
- Anthropic — [ClaudeBot 文档](https://www.anthropic.com/index/claude-bot-information)
- Perplexity — [PerplexityBot](https://docs.perplexity.ai/docs/perplexitybot)

## 附录 B：相关文件索引

- 源码：[ide/website/index.html](../ide/website/index.html)、[ide/website/src/App.tsx](../ide/website/src/App.tsx)
- 部署脚本：[server/deploy-website.sh](../server/deploy-website.sh)
- 现有同名构建产物（仅 HTML 副本，无资源）：[mrday-one-website/](../mrday-one-website/)
- 网页版 IDE（不在 SEO 范围）：[ide/website/public/app/](../ide/website/public/app/)

---

> 文档作者：自动化智能体
> 评审状态：待用户决策
> 下一步：用户确认 12 节后进入 Phase 1 实施