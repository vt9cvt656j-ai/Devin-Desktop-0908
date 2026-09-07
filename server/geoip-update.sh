#!/usr/bin/env bash
# 拉 IP 地理库到 /etc/nginx/geoip/，供 conf.d/mrday-geo.conf（官网按地区分流）的 geoip2 用。
# 在**服务器上**跑；setup-cn-mirror.sh 第一次跑它，之后由它自己装的 cron 每月跑一次。
#
# 库是 DB-IP City Lite：免费、不用注册账号、CC BY 4.0（要求署名，官网页脚已带
# "IP Geolocation by DB-IP"）。每月 1 号出新库，文件名带年月：先试本月，没有就退回上月。
# 换入是原子的（临时名 + mv），nginx 靠 geoip2 的 auto_reload 一小时内自动用上，不 reload。
set -euo pipefail

DIR="${GEOIP_DIR:-/etc/nginx/geoip}"
DB="$DIR/dbip-city-lite.mmdb"
SELF="$(readlink -f "$0")"

say() { printf '  [geoip] %s\n' "$*"; }

mkdir -p "$DIR"
ok=""
for ym in "$(date +%Y-%m)" "$(date -d '-1 month' +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-city-lite-$ym.mmdb.gz"
  say "下载 $url"
  if curl -fsSL -m 900 --retry 3 -o "$DB.gz.tmp" "$url"; then
    if gunzip -c "$DB.gz.tmp" > "$DB.tmp"; then
      # mmdb 的元数据段里一定有这串标记；没有就是下到了一个错误页或半截文件。
      if grep -q --binary-files=text 'MaxMind.com' "$DB.tmp"; then
        mv -f "$DB.tmp" "$DB"
        chmod 0644 "$DB"
        rm -f "$DB.gz.tmp"
        say "已换入 $ym（$(du -h "$DB" | cut -f1)）"
        ok=1
        break
      fi
      say "$ym 的文件不是合法的 mmdb，丢弃"
    fi
  else
    say "$ym 还没发布或下载失败"
  fi
  rm -f "$DB.tmp" "$DB.gz.tmp"
done

if [ -z "$ok" ]; then
  if [ -f "$DB" ]; then
    say "这次没拉到新库，继续用现有的（$(date -r "$DB" +%F)）"
    exit 0
  fi
  say "没有任何可用的库 —— 分流保持关闭（install-nginx.sh 会装替身配置）"
  exit 1
fi

# 每月 3 号凌晨更新一次。写死到脚本自己的绝对路径，deploy.sh 同步到哪它就指到哪。
cat > /etc/cron.d/michael-geoip <<CRON
# 官网按地区分流用的 IP 库，每月更新（geoip-update.sh 自己写的）。
17 4 3 * * root $SELF >/var/log/michael-geoip.log 2>&1
CRON
chmod 0644 /etc/cron.d/michael-geoip
say "月度更新已登记（/etc/cron.d/michael-geoip）"
