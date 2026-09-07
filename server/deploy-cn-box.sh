#!/usr/bin/env bash
# 把中国区官网镜像装到**国内那台机器**上（阿里云，备案接入的主机；通配符解析本来就把
# mrday.shuerzuo.cn 指着它），并让美国站的分流指向它。可以反复跑。
#
#   CN_BOX_SSH=root@47.115.210.101 CN_BOX_KEY=~/.ssh/xxx.pem SERVER_KEY=~/.ssh/michael_server ./deploy-cn-box.sh
#
# 为什么镜像要放国内：备案镜像原来和美国站在同一台美国机器上，中国访客要跨境连过来——慢、丢包、
# 时不时连不上（所有者原话「老是访问不了」），而且备案接入商查到 IP 不在它的机房会撤销接入。
# 放国内之后：中国访客就近、不跨境；名字用 mrday.shuerzuo.cn（老名字 mrday.one.shuerzuo.cn 会被
# Chrome 当成仿冒 mrday.one 的钓鱼站拦下）。
#
# 前置（只有所有者能做）：那台机器的 SSH 用户 + 密钥；阿里云安全组放开 80 / 443（现在是关的）。
#
# 步骤：
#   0. DNS：镜像域名必须解析到那台机器；
#   1. 那台机器上装 nginx / certbot / rsync（apt），开 ufw 的 80/443（如果 ufw 在用）；
#   2. 上传站点主体 snippet、分流替身、生成的 $mrday_cn_host、站点模板 → 渲染装上 80 口，reload；
#   3. 本地构建站点（和 deploy-website.sh 同一套，独立临时目录），rsync 到那台机器的站点目录；
#   4. certbot webroot 签证书，装上 443，reload；
#   5. 美国站：写 /etc/nginx/mrday-cn-host.external = 镜像域名，跑 install-nginx.sh —— 从此分流指向
#      国内机器，老名字在美国站只剩 301；
#   6. 从美国服务器和公网各验一遍。
# 之后每次发站点：deploy-website.sh 在 CN_BOX_SSH 设了的情况下会顺手把同一份构建 rsync 过去。
set -euo pipefail

CN_BOX_SSH="${CN_BOX_SSH:?需要 CN_BOX_SSH=用户@国内机器IP}"
CN_BOX_KEY="${CN_BOX_KEY:?需要 CN_BOX_KEY=那台机器的私钥路径}"
CN_HOST="${CN_HOST:-mrday.shuerzuo.cn}"
CN_WEB_ROOT="${CN_WEB_ROOT:-/var/www/michael-sites/_hosts/www}"   # 和 snippets/mrday-site-body.conf 里的 root 一致
SERVER_HOST="${SERVER_HOST:-154.44.13.133}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_KEY="${SERVER_KEY:-$HOME/.ssh/michael_server}"
REMOTE_DIR="${REMOTE_DIR:-/opt/michael-ide-deploy/server}"
BOX_IP="${CN_BOX_SSH##*@}"

retry() {
  local attempt status=0
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    status=$?
    echo "    (attempt $attempt failed, retrying in $((attempt * 3))s)" >&2
    sleep $((attempt * 3))
  done
  return "$status"
}
BOX=(retry ssh -i "$CN_BOX_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new "$CN_BOX_SSH")
BOXCP=(retry scp -i "$CN_BOX_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new)
US=(retry ssh -i "$SERVER_KEY" -o BatchMode=yes -o ConnectTimeout=30 "$SERVER_USER@$SERVER_HOST")

cd "$(dirname "$0")"

echo "==> 0/6 DNS：$CN_HOST 必须解析到 $BOX_IP"
resolved="$(curl -sS -m 20 -H 'accept: application/dns-json' "https://dns.google/resolve?name=$CN_HOST&type=A" 2>/dev/null \
  | sed -n 's/.*"data":"\([0-9.][0-9.]*\)".*/\1/p' | head -1)"
[ "$resolved" = "$BOX_IP" ] || { echo "✗ $CN_HOST 解析到「${resolved:-没有记录}」，不是 $BOX_IP；先改阿里云 DNS。" >&2; exit 1; }
echo "    $CN_HOST -> $resolved ✓"

echo "==> 1/6 那台机器：nginx / certbot / rsync，防火墙"
"${BOX[@]}" 'set -e; export DEBIAN_FRONTEND=noninteractive
  which nginx >/dev/null 2>&1 && which certbot >/dev/null 2>&1 && which rsync >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq nginx certbot rsync >/dev/null; }
  mkdir -p /var/www/certbot /etc/nginx/snippets /etc/nginx/conf.d /etc/nginx/sites-enabled
  if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
  nginx -v 2>&1; certbot --version 2>&1 | head -1'
echo "    （阿里云安全组的 80/443 要在控制台放开，脚本管不到那一层）"

echo "==> 2/6 nginx 配置（先只装 80 口，证书还没有）"
GEN="$(mktemp -d)"; trap 'rm -rf "$GEN"' EXIT
printf 'map $host $mrday_cn_host { default %s; }\n' "$CN_HOST" > "$GEN/mrday-cn-host.conf"
sed "s/__CN_HOST__/$CN_HOST/g" nginx/mrday-cn-box.conf > "$GEN/mrday-cn-box.full"
# 443 那段要等证书：先只装 80 口（文件里第一个 server{} 块）
awk 'BEGIN{n=0} /^server \{/{n++} n<=1' "$GEN/mrday-cn-box.full" > "$GEN/mrday-cn-box.http"
"${BOXCP[@]}" -q nginx/mrday-site-body.conf "$CN_BOX_SSH:/etc/nginx/snippets/mrday-site-body.conf"
"${BOXCP[@]}" -q nginx/mrday-geo-off.conf "$CN_BOX_SSH:/etc/nginx/conf.d/mrday-geo.conf"
"${BOXCP[@]}" -q "$GEN/mrday-cn-host.conf" "$CN_BOX_SSH:/etc/nginx/conf.d/mrday-cn-host.conf"
"${BOXCP[@]}" -q "$GEN/mrday-cn-box.http" "$CN_BOX_SSH:/etc/nginx/sites-enabled/mrday-cn-box"
"${BOX[@]}" "mkdir -p '$CN_WEB_ROOT' && rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx"

echo "==> 3/6 构建站点并同步到那台机器"
OUT="$(mktemp -d /tmp/mrday-site-cn.XXXXXX)"
( cd ../ide/website && node scripts/extract-tools.mjs && npx tsc -b && npx vite build --outDir "$OUT" --emptyOutDir >/dev/null )
[ -f "$OUT/index.html" ] || { echo "构建没有产出 index.html"; exit 1; }
retry rsync -az --delete -e "ssh -i $CN_BOX_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$OUT/" "$CN_BOX_SSH:$CN_WEB_ROOT/"
"${BOX[@]}" "chown -R www-data:www-data '$CN_WEB_ROOT' && chmod -R u=rwX,go=rX '$CN_WEB_ROOT'"
rm -rf "$OUT"

echo "==> 4/6 证书：$CN_HOST（那台机器上用 webroot 签）"
"${BOX[@]}" "certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
  --webroot -w /var/www/certbot -d '$CN_HOST' --deploy-hook 'systemctl reload nginx'"
"${BOXCP[@]}" -q "$GEN/mrday-cn-box.full" "$CN_BOX_SSH:/etc/nginx/sites-enabled/mrday-cn-box"
"${BOX[@]}" "nginx -t && systemctl reload nginx"

echo "==> 5/6 美国站：分流指向 $CN_HOST，老名字只剩 301"
"${US[@]}" "printf '%s\n' '$CN_HOST' > /etc/nginx/mrday-cn-host.external && cd '$REMOTE_DIR' && SRC=./nginx bash ./install-nginx.sh"

echo "==> 6/6 验证"
probe() { curl -sS -m 25 -o /dev/null -w '%{http_code} %{redirect_url}' "$@" 2>/dev/null || echo "000"; }
echo "    从美国服务器连国内镜像：$("${US[@]}" "curl -sS -m 25 -o /dev/null -w '%{http_code}' https://$CN_HOST/" 2>/dev/null || echo 000)"
echo "    https://$CN_HOST/__geo       -> $(curl -sS -m 25 "https://$CN_HOST/__geo" 2>/dev/null || echo unreachable)"
echo "    https://$CN_HOST/app/        -> $(probe "https://$CN_HOST/app/")   （应 302 回 https://mrday.one/app/）"
echo "    https://mrday.one/?region=cn -> $(probe 'https://mrday.one/?region=cn')   （应 302 到 https://$CN_HOST/…）"
echo "    https://mrday.one.shuerzuo.cn/ -> $(probe https://mrday.one.shuerzuo.cn/)   （老名字，应 301 到 $CN_HOST）"
echo
echo "完成。以后 deploy-website.sh 带着 CN_BOX_SSH / CN_BOX_KEY 跑，会把同一份构建同步到国内机器。"
