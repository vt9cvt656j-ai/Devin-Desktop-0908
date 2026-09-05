// web_fetch 失败时的下一步，按失败原因分。
//
// 原来只有一套通用文案：「检查 URL、检查网络；反爬/要渲染/要登录就换 http_request、browser、curl」。
// 对 404 这是错的建议：地址不存在，换什么工具都抓不到，模型照着换三种工具各试一次才放弃
// （本机经验表 web_fetch 失败率 11%，2026-09-05）。这里只对**能判定**的原因给具体下一步；
// 判定不了就返回空串，调用方沿用通用文案。
export function webFetchNextStep(message, url) {
  const m = String(message || "");
  let host = "";
  let pathWords = "";
  try {
    const u = new URL(String(url || ""));
    host = u.hostname;
    pathWords = u.pathname.split(/[\/\-_.]+/).filter((w) => w.length >= 3 && !/^(html?|php|aspx?|index)$/i.test(w)).slice(0, 4).join(" ");
  } catch { /* 不是合法 URL，下面照样给得出话 */ }
  if (/^HTTP (404|410)\b/.test(m)) {
    const site = host ? `site:${host} ` : "";
    return `这个地址不存在（${m.slice(0, 8)}是服务端明确回的，不是网络问题，重试和换工具都没用）。`
      + `下一步：web_search 搜 \`${site}${pathWords || "<路径里的词>"}\` 拿到真实链接再抓；`
      + `${host && /github\.com$/i.test(host) ? "GitHub 上的东西直接 github_search；" : ""}`
      + `文档站常见的是版本目录改了名，从站点首页或文档目录页进去找。`;
  }
  if (/^HTTP 401\b/.test(m)) return "服务端要登录（401）：匿名抓不到。有 token 就用 http_request 带 Authorization 头；没有就 browser 打开让用户登录后再读。";
  if (/DNS 解析失败/.test(m)) return `域名解析不了（${host || "这个主机"}）：多半是域名拼错或内网地址，先核对域名；确定没错再看网络/VPN。`;
  if (/timed out|timeout|超时/i.test(m)) return "超时：先原样重试一次；再超时就换 http_request（可调 timeout）或 browser 打开。";
  return "";
}
