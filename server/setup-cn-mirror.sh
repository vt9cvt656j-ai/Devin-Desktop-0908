#!/usr/bin/env bash
# 把中国区备案镜像 mrday.one.shuerzuo.cn 接成官网的完整镜像，并打开按地区分流。
#
#   SERVER_KEY=~/.ssh/michael_server ./setup-cn-mirror.sh
#
# 可以反复跑：每一步都是幂等的（库已是最新就不重下，证书没到期就不重签，配置一样就不重装）。
# 顺序是刻意的，倒过来任何一步都会让 nginx 校验失败：
#   1. 上传 server/nginx 和两个脚本到部署目录（和 deploy.sh 同一个目录，cron 才找得到脚本）；
#   2. 拉地理库 —— 没有它，install-nginx.sh 只能装「不分流」的替身；
#   3. 装配置 —— 这一轮只会装上镜像域名的 80 口（ACME 入口 + 跳 https）和分流事实层；
#   4. 用 webroot 方式签证书 —— 走的正是第 3 步刚装的那个 80 口入口；
#   5. 再装一次配置 —— 这回证书在了，镜像的 443 站点才会被装上；
#   6. 从公网验一遍：镜像 200、/__geo 有读数、/app/ 送回美国站、mrday.one 本身没被误分流。
#
# 站点文件本身不归它管：mrday.one 和镜像读的是同一个目录，deploy-website.sh 照常发布即可。
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-154.44.13.133}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_KEY="${SERVER_KEY:-$HOME/.ssh/michael_server}"
REMOTE_DIR="${REMOTE_DIR:-/opt/michael-ide-deploy/server}"
# 现名。老名字 mrday.one.shuerzuo.cn 会被 Chrome 当成仿冒 mrday.one 的钓鱼站拦下（见
# nginx/mrday-geo.conf 里 $mrday_cn_host 的说明），只留 301。这里的值要和那个变量一致。
CN_HOST="${CN_HOST:-mrday.shuerzuo.cn}"
CN_LEGACY_HOST="${CN_LEGACY_HOST:-mrday.one.shuerzuo.cn}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"

SSH_BIN=(ssh -i "$SERVER_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o ConnectionAttempts=3)
SCP_BIN=(scp -i "$SERVER_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o ConnectionAttempts=3)

# 这台机器会在 ssh 握手途中掉线（deploy-website.sh 里有同样的重试，理由也一样）。
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
SSH=(retry "${SSH_BIN[@]}")
SCP=(retry "${SCP_BIN[@]}")

cd "$(dirname "$0")"

# DNS 是这条链唯一不在我们手里的一环：A 记录在阿里云的 shuerzuo.cn 解析里。没指到这台机器就
# 什么都别装——装了也是把分流目标指向一个不存在的站，还会让 certbot 白跑一次。
# 用 DoH 查而不用本机 dig：本机的 DNS 被代理接管，答的是假地址。
echo "==> 0/6 DNS：$CN_HOST 必须指向 $SERVER_HOST"
resolved="$(curl -sS -m 20 -H 'accept: application/dns-json' "https://dns.google/resolve?name=$CN_HOST&type=A" 2>/dev/null \
  | sed -n 's/.*"data":"\([0-9.][0-9.]*\)".*/\1/p' | head -1)"
if [ "$resolved" != "$SERVER_HOST" ]; then
  echo "✗ $CN_HOST 现在解析到「${resolved:-没有记录}」，不是 $SERVER_HOST。" >&2
  echo "  先去阿里云 DNS（shuerzuo.cn）加一条 A 记录：主机记录 ${CN_HOST%.shuerzuo.cn}，记录值 $SERVER_HOST，TTL 10 分钟；生效后再跑本脚本。" >&2
  exit 1
fi
echo "    $CN_HOST -> $resolved ✓"

echo "==> 1/6 上传 nginx 配置与脚本到 $REMOTE_DIR"
# 只传官网这一族（mrday-*）。其余 nginx 文件用部署目录里上次 deploy.sh 留下的那份——和线上装的
# 一致，install-nginx.sh 比对后会原样跳过。整目录传的话，仓库里别人还没部署的改动会被这次顺手
# 带上线，而这个脚本的名字里没有那件事。
"${SSH[@]}" "$REMOTE" "mkdir -p '$REMOTE_DIR/nginx'"
"${SCP[@]}" -q nginx/mrday-*.conf "$REMOTE:$REMOTE_DIR/nginx/"
"${SCP[@]}" -q install-nginx.sh geoip-update.sh "$REMOTE:$REMOTE_DIR/"
"${SSH[@]}" "$REMOTE" "chmod +x '$REMOTE_DIR/install-nginx.sh' '$REMOTE_DIR/geoip-update.sh'"

echo "==> 2/6 地理库（DB-IP City Lite，~130MB，第一次要等一会儿）"
"${SSH[@]}" "$REMOTE" "bash '$REMOTE_DIR/geoip-update.sh'" || echo "    地理库没拉到：分流先保持关闭，其余照装；网络好了再跑一次本脚本即可"

echo "==> 3/6 装配置（镜像 80 口 + 分流事实层）"
"${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && SRC=./nginx bash ./install-nginx.sh"

echo "==> 4/6 证书：$CN_HOST"
# 账号已经有（mrday.one 就是它签的），所以不用再给邮箱；--keep-until-expiring 让重复跑不重签。
"${SSH[@]}" "$REMOTE" "certbot certonly --non-interactive --agree-tos --keep-until-expiring \
  --webroot -w /var/www/certbot -d '$CN_HOST' --deploy-hook 'systemctl reload nginx'"

echo "==> 5/6 再装一次配置（这回证书在了，镜像的 443 站点上线）"
"${SSH[@]}" "$REMOTE" "cd '$REMOTE_DIR' && SRC=./nginx bash ./install-nginx.sh"

echo "==> 6/6 公网验证"
probe() { curl -sS -m 25 -o /dev/null -w '%{http_code} %{redirect_url}' "$@" 2>/dev/null || echo "000"; }
echo "    https://$CN_HOST/            -> $(probe "https://$CN_HOST/")"
echo "    https://$CN_HOST/__geo       -> $(curl -sS -m 25 "https://$CN_HOST/__geo" 2>/dev/null || echo unreachable)"
echo "    https://$CN_HOST/app/        -> $(probe "https://$CN_HOST/app/")   （应 302 回 https://mrday.one/app/）"
echo "    https://$CN_LEGACY_HOST/     -> $(probe "https://$CN_LEGACY_HOST/")   （老名字，应 301 到现名）"
echo "    https://mrday.one/           -> $(probe https://mrday.one/)   （本机不在严管地区时应 200）"
echo "    https://mrday.one/?region=cn -> $(probe 'https://mrday.one/?region=cn')   （测试开关，应 302 到镜像）"
echo "    https://mrday.one/__geo      -> $(curl -sS -m 25 https://mrday.one/__geo 2>/dev/null || echo unreachable)"
echo
echo "完成。站点文件由 deploy-website.sh 照常发布（两个域名读同一个目录）。"
