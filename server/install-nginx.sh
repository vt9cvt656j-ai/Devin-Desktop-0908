#!/usr/bin/env bash
# 把仓库里的 nginx 配置装到系统里。由 deploy.sh 在**远端**、在 flock 内、以 $REMOTE_DIR
# 为工作目录调用，且必须排在 rollout.sh **之前**（配置与颜色无关，先装配置再切颜色）。
#
# ## 为什么需要它
#
# `/etc/nginx/` 下那几份和 `server/nginx/` 下的同名文件此前是**手工拷过去的副本**（inode
# 不同，不是链接），而 deploy.sh 完全不碰它们。后果有两个方向：
#   · 改了仓库不生效 —— 提交完以为上线了，其实线上还是旧的；
#   · 有人直接改线上不留痕 —— 仓库和实际长期不一致，而没有任何东西会发现。
# 这次给 michael-backend.conf 加 upstream 间接层时就是手工装的，装完才想起来这件事本身
# 就该自动化。
#
# ## 失败时的行为
#
# 校验不过就**整体还原并让部署失败**，绝不留下半装的配置。顺序也是刻意的：装配置在起容器
# 之前，所以配置写错时容器一个都没动过。
#
# ## 一个不装的文件
#
# `michael-backend-upstream.conf` 是 rollout.sh 的生成物，指向此刻在服务的那种颜色。
# 它在仓库里**没有副本**，这里也绝不写它 —— 按字面装一份写死蓝色端口的进去，而绿色正在
# 服务的话，那一下就是把 nginx 指向一个已经停掉的端口，全站 502。
set -euo pipefail

SRC="${SRC:-./nginx}"
BAKDIR="${BAKDIR:-/root/nginx-backups}"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '  [nginx] %s\n' "$*"; }

# 官网按地区分流要两样外部条件，缺哪样就装对应的「安全形态」，绝不让整份配置校验失败：
#   · 地理库（geoip-update.sh 拉到 /etc/nginx/geoip/）不在 → 装 mrday-geo-off.conf：同名变量
#     恒为「不分流」，站点照常；
#   · 备案镜像的证书（setup-cn-mirror.sh 用 certbot 签）不在 → 不装它的 443 站点，并把之前装过
#     的一份删掉——ssl_certificate 指向不存在的文件是整份 nginx 配置一起挂。
GEO_SRC="mrday-geo-off.conf"
[ -f /etc/nginx/geoip/dbip-city-lite.mmdb ] && GEO_SRC="mrday-geo.conf"
# 中国区备案镜像用哪个名字，看**此刻谁有证书**：新名字 mrday.shuerzuo.cn 优先，没有就退回老名字
# mrday.one.shuerzuo.cn（它把 mrday.one 整个嵌在最前面，Chrome 会拦成仿冒 mrday.one 的钓鱼站，所以
# 要换；但新名字的 A 记录在阿里云、证书要等它生效后由 setup-cn-mirror.sh 签）。选定之后：
#   · sites-enabled/mrday-cn-site 从模板渲染（server_name / 证书路径）；
#   · conf.d/mrday-cn-host.conf 生成 $mrday_cn_host——分流跳转、80 口跳 https、老名字 301 都读它；
#   · 只有新名字在服务时才装老名字的 301 站点（否则老名字就是镜像本身，不能自己 301 自己）。
# 于是改名过渡期里随便哪天 deploy，镜像都不会指向一个还没上线的名字。名字只在这两行定义。
CN_HOST_NEW="mrday.shuerzuo.cn"
CN_HOST_OLD="mrday.one.shuerzuo.cn"
# 镜像也可以**不在这台机器上**：放到国内那台阿里云机器（备案接入的就是它，通配符解析本来就指着它，
# 中国访客就近、不用跨境）。deploy-cn-box.sh 装好那边之后，把名字写进 /etc/nginx/mrday-cn-host.external
# （一行）。写了它：分流目标就是它，这里不装镜像站点（证书在那边），老名字这里只剩 301。
EXTERNAL_CN_HOST="$(head -1 /etc/nginx/mrday-cn-host.external 2>/dev/null | tr -d '[:space:]')"
ACTIVE_CN_HOST=""
LOCAL_CN_SITE=0
if [ -n "$EXTERNAL_CN_HOST" ]; then
  ACTIVE_CN_HOST="$EXTERNAL_CN_HOST"
elif [ -f "/etc/letsencrypt/live/$CN_HOST_NEW/fullchain.pem" ]; then
  ACTIVE_CN_HOST="$CN_HOST_NEW"; LOCAL_CN_SITE=1
elif [ -f "/etc/letsencrypt/live/$CN_HOST_OLD/fullchain.pem" ]; then
  ACTIVE_CN_HOST="$CN_HOST_OLD"; LOCAL_CN_SITE=1
fi
GEN="$(mktemp -d)"
trap 'rm -rf "$GEN"' EXIT
printf 'map $host $mrday_cn_host { default %s; }\n' "${ACTIVE_CN_HOST:-$CN_HOST_NEW}" > "$GEN/mrday-cn-host.conf"
CN_SITE_DEST="/etc/nginx/sites-enabled/mrday-cn-site"
CN_PAIR=""
if [ "$LOCAL_CN_SITE" = 1 ] && [ -f "$SRC/mrday-cn-site.conf" ]; then
  sed "s/__CN_HOST__/$ACTIVE_CN_HOST/g" "$SRC/mrday-cn-site.conf" > "$GEN/mrday-cn-site"
  CN_PAIR="$GEN/mrday-cn-site|$CN_SITE_DEST"
  say "备案镜像用的名字：$ACTIVE_CN_HOST（本机服务）"
elif [ -f "$CN_SITE_DEST" ]; then
  rm -f "$CN_SITE_DEST"
  if [ -n "$EXTERNAL_CN_HOST" ]; then say "备案镜像在别的机器上（$EXTERNAL_CN_HOST），本机镜像站点已撤下"; else say "备案镜像两个名字都没有证书，已撤下它的 443 站点（80 口的 ACME 入口还在）"; fi
fi
CN_LEGACY_DEST="/etc/nginx/sites-enabled/mrday-cn-legacy"
CN_LEGACY_PAIR=""
if [ -n "$ACTIVE_CN_HOST" ] && [ "$ACTIVE_CN_HOST" != "$CN_HOST_OLD" ] && [ -f "/etc/letsencrypt/live/$CN_HOST_OLD/fullchain.pem" ]; then
  CN_LEGACY_PAIR="mrday-cn-legacy.conf|$CN_LEGACY_DEST"
elif [ -f "$CN_LEGACY_DEST" ]; then
  rm -f "$CN_LEGACY_DEST"
  say "老名字的 301 站点已撤下（老名字自己就是镜像，或老证书没了）"
fi

# 仓库文件 → 系统落点。左边是 $SRC 下的文件名，右边是绝对路径。
PAIRS=(
  "michael-backend.conf|/etc/nginx/sites-available/michael-backend"
  "michael-limits.conf|/etc/nginx/conf.d/michael-limits.conf"
  "michael-security-headers.conf|/etc/nginx/snippets/michael-security-headers.conf"
  "michael-headers-account.conf|/etc/nginx/snippets/michael-headers-account.conf"
  "cloudflare-real-ip.conf|/etc/nginx/snippets/cloudflare-real-ip.conf"
  "michaelide-sites.conf|/etc/nginx/sites-available/michaelide-sites"
  "$GEO_SRC|/etc/nginx/conf.d/mrday-geo.conf"
  "$GEN/mrday-cn-host.conf|/etc/nginx/conf.d/mrday-cn-host.conf"
  "mrday-site-body.conf|/etc/nginx/snippets/mrday-site-body.conf"
  "mrday-site.conf|/etc/nginx/sites-enabled/mrday-site"
)
[ -n "$CN_PAIR" ] && PAIRS+=("$CN_PAIR")
[ -n "$CN_LEGACY_PAIR" ] && PAIRS+=("$CN_LEGACY_PAIR")

mkdir -p "$BAKDIR"
changed=()
restore_list=()

for pair in "${PAIRS[@]}"; do
  name="${pair%%|*}"
  dest="${pair##*|}"
  # 生成物（上面渲染进 $GEN 的）写的是绝对路径，仓库文件写的是 $SRC 下的文件名。
  case "$name" in
    /*) src="$name"; name="$(basename "$name")" ;;
    *)  src="$SRC/$name" ;;
  esac

  if [ ! -f "$src" ]; then
    say "仓库里没有 $name —— 跳过（这条落点保持现状）"
    continue
  fi
  # 内容一样就什么都不做：绝大多数部署都会走到这里，不该产生备份、也不该 reload。
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    continue
  fi

  if [ -f "$dest" ]; then
    cp "$dest" "$BAKDIR/$(basename "$dest").$TS"
    restore_list+=("$BAKDIR/$(basename "$dest").$TS|$dest")
  else
    # 目标本来不存在：还原时要删掉而不是拷回去。
    restore_list+=("|$dest")
  fi
  install -m 0644 "$src" "$dest"
  changed+=("$name")
  say "已更新 $dest"
done

if [ "${#changed[@]}" -eq 0 ]; then
  say "配置与仓库一致，无需改动"
  exit 0
fi

say "校验（nginx -t）"
if nginx -t 2>&1 | sed 's/^/  [nginx] /'; then
  systemctl reload nginx
  say "已 reload（优雅，不断连接）；本次更新：${changed[*]}"
else
  say "校验不通过 —— 整体还原，并让这次部署失败（容器一个都还没动）"
  for entry in "${restore_list[@]}"; do
    bak="${entry%%|*}"
    dest="${entry##*|}"
    if [ -n "$bak" ]; then cp "$bak" "$dest"; else rm -f "$dest"; fi
  done
  nginx -t >/dev/null 2>&1 || say "警告：还原后仍不通过，需要人工介入"
  exit 1
fi
