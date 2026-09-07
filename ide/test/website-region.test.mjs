// 官网地区分流的纯逻辑（ide/website/src/lib/region.ts）真跑，外加和 nginx 那份名单的对账。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  STRICT_REGIONS, CN_MIRROR_HOST, CN_MIRROR_HOSTS, INTL_ORIGIN, REGION_COOKIE,
  isCnMirrorHost, regionChoice, isStrictRegion, hasChineseLanguage, shouldRedirectToMirror,
  mirrorUrlFor, intlSiteUrl, gonganHref, canonicalFor,
} from "../website/src/lib/region.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NGINX = join(HERE, "../../server/nginx");

test("严管名单：客户端那份和 nginx 那份是同一份（改一处必须改另一处）", () => {
  const geo = readFileSync(join(NGINX, "mrday-geo.conf"), "utf8");
  const m = /\$mrday_cn_strict \{[\s\S]*?"~\*\^CN:\(([^)]+)\)"\s+1;/.exec(geo);
  assert.ok(m, "nginx 的严管正则找不到了（mrday-geo.conf 的 $mrday_cn_strict）");
  const inNginx = m[1].split("|").map((s) => s.trim());
  for (const r of STRICT_REGIONS) assert.ok(inNginx.includes(r), `客户端名单里的 ${r} 不在 nginx 名单里`);
  for (const r of inNginx) {
    const bare = r.replace(/^CN-/, "");
    assert.ok(STRICT_REGIONS.includes(bare), `nginx 名单里的 ${r} 不在客户端名单里`);
  }
  assert.deepEqual([...STRICT_REGIONS].sort(), ["FJ", "Fujian", "JS", "Jiangsu", "ZJ", "Zhejiang"].sort(),
    "用户点名的是福建、江苏、浙江；扩名单要所有者拍板");
});

test("镜像域名只有一份：nginx 的 $mrday_cn_host、镜像站点的 server_name / 证书路径、客户端常量三处一致；老名字只剩 301", () => {
  const real = readFileSync(join(NGINX, "mrday-geo.conf"), "utf8");
  const off = readFileSync(join(NGINX, "mrday-geo-off.conf"), "utf8");
  const cn = readFileSync(join(NGINX, "mrday-cn-site.conf"), "utf8");
  const legacy = readFileSync(join(NGINX, "mrday-cn-legacy.conf"), "utf8");
  const site = readFileSync(join(NGINX, "mrday-site.conf"), "utf8");
  const install = readFileSync(join(NGINX, "../install-nginx.sh"), "utf8");
  const setup = readFileSync(join(NGINX, "../setup-cn-mirror.sh"), "utf8");
  // 名字只在 install-nginx.sh 顶上定义；站点文件是模板，$mrday_cn_host 是它生成的，两份 geo 配置都不许再写死
  assert.match(install, new RegExp(`^CN_HOST_NEW="${CN_MIRROR_HOST.replace(/\\./g, "\\\\.")}"$`, "m"), "install-nginx.sh 的新名字和常量不一致");
  assert.match(install, /^CN_HOST_OLD="mrday\.one\.shuerzuo\.cn"$/m, "install-nginx.sh 的老名字不见了");
  assert.match(install, /printf 'map \$host \$mrday_cn_host \{ default %s; \}\\n' "\$\{ACTIVE_CN_HOST:-\$CN_HOST_NEW\}"/, "$mrday_cn_host 必须由 install-nginx.sh 按证书生成");
  assert.match(install, /sed "s\/__CN_HOST__\/\$ACTIVE_CN_HOST\/g" "\$SRC\/mrday-cn-site\.conf"/, "镜像站点要从模板渲染");
  assert.match(install, /\[ "\$ACTIVE_CN_HOST" != "\$CN_HOST_OLD" \] && \[ -f "\/etc\/letsencrypt\/live\/\$CN_HOST_OLD\/fullchain\.pem" \]/, "老名字的 301 只在镜像不是老名字时才装");
  assert.match(install, /EXTERNAL_CN_HOST="\$\(head -1 \/etc\/nginx\/mrday-cn-host\.external/, "镜像放到国内机器上的开关（external 文件）不见了");
  assert.match(install, /if \[ -n "\$EXTERNAL_CN_HOST" \]; then\s*ACTIVE_CN_HOST="\$EXTERNAL_CN_HOST"/, "external 名字必须优先于本机证书");
  assert.doesNotMatch(real + off, /\$mrday_cn_host \{/, "geo 配置里不许再写死镜像名字（它是按证书生成的）");
  assert.match(cn, /server_name __CN_HOST__;/, "镜像站点模板的 server_name 要留占位符");
  assert.match(cn, /\/etc\/letsencrypt\/live\/__CN_HOST__\/fullchain\.pem/, "镜像站点模板的证书路径要留占位符");
  const cnCode = cn.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(cnCode, /shuerzuo\.cn/, "模板里除注释外不许写死任何一个名字（名字由 install-nginx.sh 渲染进去）");
  assert.match(setup, new RegExp(`CN_HOST:-${CN_MIRROR_HOST.replace(/\\./g, "\\\\.")}`), "setup-cn-mirror.sh 的默认域名和常量不一致");
  // 钓鱼长相的老名字：任何地方都不许再拿它当跳转目标；只允许出现在 server_name（301 入口）里
  assert.doesNotMatch(site + cn + real + off, /https:\/\/mrday\.one\.shuerzuo\.cn/, "又把老名字当跳转目标了——Chrome 会拦成钓鱼站");
  assert.match(legacy, /server_name mrday\.one\.shuerzuo\.cn;[\s\S]*return 301 https:\/\/\$mrday_cn_host\$request_uri;/, "老名字要 301 到现名");
  assert.match(site, /server_name mrday\.shuerzuo\.cn mrday\.one\.shuerzuo\.cn;/, "80 口要同时接现名和老名字（ACME 入口 + 跳 https）");
  assert.ok(CN_MIRROR_HOSTS.includes("mrday.one.shuerzuo.cn") && isCnMirrorHost("mrday.one.shuerzuo.cn"), "老名字上页脚也要出备案栏、且不做客户端跳转");
  // 现名不能再嵌任何真实域名：这正是老名字被 Chrome 拦的原因
  assert.doesNotMatch(CN_MIRROR_HOST, /mrday\.one/, "镜像域名里不能再出现 mrday.one 这个完整域名");
});

test("nginx 侧的形状：分流只在 mrday.one 的 location /，镜像从不分流，/app/ 两边互送不成环", () => {
  const site = readFileSync(join(NGINX, "mrday-site.conf"), "utf8");
  const cn = readFileSync(join(NGINX, "mrday-cn-site.conf"), "utf8");
  const body = readFileSync(join(NGINX, "mrday-site-body.conf"), "utf8");
  assert.match(site, /if \(\$mrday_cn_redirect\) \{\s*return 302 https:\/\/\$mrday_cn_host\$request_uri;/, "美国站的分流跳转不在了（或没走 $mrday_cn_host）");
  assert.doesNotMatch(site, /return 301 https:\/\/\$mrday_cn_host\$request_uri;\s*\}\s*try_files/, "分流必须是 302，301 会被浏览器记死");
  assert.doesNotMatch(cn, /mrday_cn_redirect/, "镜像是分流的终点，自己再分流就是死循环");
  assert.match(cn, /location \^~ \/app\/ \{\s*return 302 https:\/\/mrday\.one\$request_uri;/, "镜像上的网页版 IDE 要送回 mrday.one（会话 cookie 钉在 .mrday.one）");
  const appBlock = /location \^~ \/app\/ \{([\s\S]*?)\n    \}/.exec(site);
  assert.ok(appBlock && /try_files \$uri \$uri\/ \/app\/index\.html;/.test(appBlock[1]), "mrday.one 的 /app/ 要原地服务网页版 IDE");
  assert.doesNotMatch(appBlock[1], /mrday_cn_redirect|return 30/, "mrday.one 的 /app/ 不能分流，否则和镜像互相踢");
  assert.match(appBlock[1], /location ~ \/\\\. \{ deny all;/, "^~ 会绕开外层的点文件拒绝规则，/app/ 里要再钉一次");
  assert.match(site, /server_name mrday\.shuerzuo\.cn mrday\.one\.shuerzuo\.cn;[\s\S]*?acme-challenge/, "镜像域名的 80 口要给 certbot 留入口");
  assert.match(body, /location = \/__geo/, "页面要能读到 nginx 的地理事实");
  // 分流事实层和替身的变量集合必须一致：替身少一个变量，装替身那天 nginx -t 就挂
  const real = readFileSync(join(NGINX, "mrday-geo.conf"), "utf8");
  const off = readFileSync(join(NGINX, "mrday-geo-off.conf"), "utf8");
  // 变量要么由 map 定义，要么由 geoip2 块直接产出（$mrday_country / $mrday_region）。
  const vars = (s) => [...s.matchAll(/^\s*(?:map [^\n]*?(\$mrday_[a-z_]+) \{|(\$mrday_[a-z_]+)\s+(?:default=|source=))/gm)]
    .map((x) => x[1] || x[2]).sort();
  assert.deepEqual(vars(off), vars(real), "mrday-geo-off.conf 的变量和 mrday-geo.conf 不一致");
  for (const v of vars(real)) assert.ok(/\$mrday_(cn_host|country|region|cn_strict|stay_cookie|arg|cn_redirect|set_region_cookie)$/.test(v));
  // 测试开关：?region=cn 无条件当严管地区——人在美国也能亲眼看一遍分流链，两份配置都要认。
  assert.match(real, /"~:cn\$"\s+1;/, "真分流层丢了 ?region=cn 测试开关");
  assert.match(off, /map \$mrday_arg \$mrday_cn_redirect \{[\s\S]*?cn\s+1;/, "替身也要认 ?region=cn");
  // 判断链里不许有能从外面写的输入：Cloudflare 的地理头只是请求头，直连源站就能伪造（实测过）。
  assert.doesNotMatch(real, /\$http_cf_ipcountry|\$http_cf_region_code/, "又开始信 CF-IPCountry / cf-region-code 了——它们是可伪造的请求头");
});

test("镜像域名识别与访客选择：cookie / ?region=intl 都认，老写法 us 也认", () => {
  assert.equal(isCnMirrorHost(CN_MIRROR_HOST), true);
  assert.equal(isCnMirrorHost("MRDAY.SHUERZUO.CN"), true);
  assert.equal(isCnMirrorHost("mrday.one"), false);
  assert.equal(isCnMirrorHost("www.shuerzuo.cn"), false, "同一主域下别的站不是镜像");
  assert.equal(regionChoice("", "?region=intl"), "intl");
  assert.equal(regionChoice("", "?region=us&x=1"), "intl");
  assert.equal(regionChoice(`theme=dark; ${REGION_COOKIE}=intl`, ""), "intl");
  assert.equal(regionChoice(`${REGION_COOKIE}=cn`, ""), "");
  assert.equal(regionChoice("", ""), "");
});

test("省份与语言判定：认英文名、省码、CN- 前缀、DB-IP 的 Sheng 后缀；zh 家族都算中文", () => {
  for (const r of ["Fujian", "fujian", "Zhejiang Sheng", "JS", "CN-FJ", "zj"]) assert.equal(isStrictRegion(r), true, r);
  for (const r of ["Guangdong", "Beijing", "Shanghai", "", null, "FJX"]) assert.equal(isStrictRegion(r), false, String(r));
  assert.equal(hasChineseLanguage(["en-US", "zh-CN"]), true);
  assert.equal(hasChineseLanguage(["zh"]), true);
  assert.equal(hasChineseLanguage(["zh-Hant-TW"]), true);
  assert.equal(hasChineseLanguage(["en-US", "ja"]), false);
  assert.equal(hasChineseLanguage(null), false);
});

test("要不要换到镜像：只有「nginx 已裁定」或「大陆 + 省份未知 + 中文」两种情况说是", () => {
  const base = { hostname: "mrday.one", cookie: "", search: "", languages: ["zh-CN"] };
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "CN", region: "", strict: 1 } }), true, "nginx 裁定了就跳（兜底）");
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "CN", region: "" } }), true, "大陆 + 省份未知 + 中文 → 镜像");
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "CN", region: "Zhejiang" } }), true, "大陆 + 严管省 → 镜像");
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "CN", region: "Guangdong" } }), false, "大陆但不在名单里的省：不受限，留美国站");
  assert.equal(shouldRedirectToMirror({ ...base, languages: ["en-US"], geo: { country: "CN", region: "" } }), false, "省份未知但不是中文浏览器 → 不跳");
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "US", region: "CA" } }), false);
  assert.equal(shouldRedirectToMirror({ ...base, geo: { country: "XX" } }), false, "没查到国家就不动");
  assert.equal(shouldRedirectToMirror({ ...base, geo: null }), false, "/__geo 没答就不动");
  assert.equal(shouldRedirectToMirror({ ...base, cookie: `${REGION_COOKIE}=intl`, geo: { country: "CN", strict: 1 } }), false, "选过国际站就不再跳");
  assert.equal(shouldRedirectToMirror({ ...base, search: "?region=intl", geo: { country: "CN", strict: 1 } }), false);
  assert.equal(shouldRedirectToMirror({ ...base, hostname: CN_MIRROR_HOST, geo: { country: "CN", strict: 1 } }), false, "已经在镜像上了");
});

test("地址搬家：路径、查询、锚点一个不丢；国际站链接带 ?region=intl；canonical 随域名走", () => {
  assert.equal(mirrorUrlFor("https://mrday.one/docs/x?a=1#download"), `https://${CN_MIRROR_HOST}/docs/x?a=1#download`);
  assert.equal(mirrorUrlFor("http://mrday.one/"), `https://${CN_MIRROR_HOST}/`, "一律 https");
  // 线上报的镜像名字优先（改名过渡期常量领先于线上）；报了个不认识的名字就回退常量，绝不跳去陌生域名
  assert.equal(mirrorUrlFor("https://mrday.one/x", "mrday.one.shuerzuo.cn"), "https://mrday.one.shuerzuo.cn/x");
  assert.equal(mirrorUrlFor("https://mrday.one/x", "evil.example"), `https://${CN_MIRROR_HOST}/x`);
  assert.equal(canonicalFor("mrday.one.shuerzuo.cn", "/docs"), "https://mrday.one.shuerzuo.cn/docs", "老名字上 canonical 指自己，不指还没上线的新名字");
  const intl = new URL(intlSiteUrl("/changelog", "#v1"));
  assert.equal(intl.origin, INTL_ORIGIN);
  assert.equal(intl.pathname, "/changelog");
  assert.equal(intl.searchParams.get("region"), "intl");
  assert.equal(intl.hash, "#v1");
  assert.equal(canonicalFor("mrday.one", "/docs"), "https://mrday.one/docs");
  assert.equal(canonicalFor(CN_MIRROR_HOST, "/docs"), `https://${CN_MIRROR_HOST}/docs`);
  assert.equal(gonganHref("闽公网安备 35010202001234号"), "https://beian.mps.gov.cn/#/query/webSearch?code=35010202001234");
  assert.equal(gonganHref(""), "https://beian.mps.gov.cn/");
});
