#!/usr/bin/env bash
# Publish the official website (https://mrday.one) to the server.
#
#   SERVER_KEY=~/.ssh/michael_server ./deploy-website.sh
#
# The third hand-published frontend, after the account console and the sign-in page, and
# it hits the same traps as the others:
#
#   1. Files copied over ssh arrive owned by root with mode 640. nginx runs as www-data
#      and cannot read them, so the page loads unstyled or 403s. Ownership is set before
#      anything points at the new files.
#   2. index.html names the hashed bundle, so it goes LAST. Upload it first and every
#      request in between asks for assets that are not there yet. Assets are
#      content-hashed, so the old and new sets coexist safely.
#   3. The build regenerates public/tools.json from the IDE's tool registry (the website's
#      `prebuild` hook). Publishing dist/ without rebuilding is how the site ended up
#      advertising 147 tools for a week after the product dropped to 130 — so this script
#      always builds rather than shipping whatever happens to be sitting in dist/.
#   4. index.html names a bundle by content hash, so switching it over before that bundle
#      is actually on disk serves a page whose only script 404s — a blank white site. Trap
#      2 says index.html goes last; that is necessary but not sufficient, because the
#      upload ahead of it can half-fail on this host. So the switch is now *gated*: the
#      exact filename index.html points at has to be readable by nginx first. This is not
#      hypothetical — it took the site down once, and the run reported "deployed."
#
#   5. `public/app/` 是**手工同步**的 IDE 构建产物，不是这次构建生成的。它落后过两周半
#      （561 个提交），根因是它得用 `--base=/app/` 构建、而那个参数只存在于某个人的记忆里：
#      默认 base 产出的 index.html 引 `/assets/...`，放到 `/app/` 下全部 404，白屏。
#      现在有 `npm run build:web` 了（ide/package.json），发站点前先在 ide/ 跑它。
#      判据不是「记得跑」——下面第 6 条会当场拦住忘了跑的那次。
#   6. 归档里 `app/index.html` 引的每个资源都必须真的在归档里。第 4 条守的是站点自己的
#      index.html，这一条守内嵌 IDE 的：两者是两个独立的 bundle，各有各的白屏方式。
#
# The site is served straight out of this directory by sites-enabled/mrday-site; there is
# no container to restart and no cache to bust beyond the browser's.
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-154.44.13.133}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_KEY="${SERVER_KEY:-$HOME/.ssh/michael_server}"
WEB_ROOT="${WEB_ROOT:-/var/www/michael-sites/_hosts/www}"
STAGE_DIR="${STAGE_DIR:-/root/website-deploy}"
SITE_URL="${SITE_URL:-https://mrday.one}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"

SSH_BIN=(ssh -i "$SERVER_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o ConnectionAttempts=3)
SCP_BIN=(scp -i "$SERVER_KEY" -o BatchMode=yes -o ConnectTimeout=30 -o ConnectionAttempts=3)

# This host drops connections during the ssh handshake often enough to fail a deploy
# halfway. ConnectionAttempts does not cover it — the TCP connection succeeds and then
# dies — so the whole command is retried.
retry() {
  local attempt status=0
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    status=$?
    echo "    (attempt $attempt failed, retrying in $((attempt * 3))s)" >&2
    sleep $((attempt * 3))
  done
  return "$status"
}

SSH=(retry "${SSH_BIN[@]}")
SCP=(retry "${SCP_BIN[@]}")

cd "$(dirname "$0")/../ide/website"

# 同一台机器上两个会话同时发站点，会共用同一个 dist/：一边 rm -rf dist 重建，另一边正从 dist 打包。
# 2026-09-07 就这样发出去一份 index.html，指着一个从没上传的 bundle——而 Cloudflare 把那个 404
# 缓存住了，整站白屏。所以：① 整个发布过程持锁（mkdir 锁，macOS 没有 flock）；② 构建到本次
# 专用的临时目录，不碰共享的 dist/。锁超过 30 分钟视为上一次被强杀留下的，直接接管。
LOCK="/tmp/mrday-site-deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK" && mkdir "$LOCK"; else
    echo "另一个发布正在进行（$LOCK），等它结束再跑"; exit 1; fi
fi
OUT="$(mktemp -d /tmp/mrday-site-build.XXXXXX)"
TGZ="$OUT.tgz"
trap 'rmdir "$LOCK" 2>/dev/null; rm -rf "$OUT" "$TGZ" "$OUT.files"' EXIT

echo "==> building (re-extracting the tool catalogue from the IDE registry first)"
node scripts/extract-tools.mjs      # npm run build 的 prebuild 钩子；这里不走 npm，所以手工调
npx tsc -b
npx vite build --outDir "$OUT" --emptyOutDir

[ -f "$OUT/index.html" ] || { echo "build produced no index.html"; exit 1; }
TOOLS_COUNT="$(node -e 'process.stdout.write(String(require(process.argv[1]).count))' "$OUT/tools.json")"
echo "    catalogue in this build: ${TOOLS_COUNT} tools"

echo "==> uploading everything except index.html"
"${SSH[@]}" "$REMOTE" "mkdir -p $WEB_ROOT $STAGE_DIR"
# -r without index.html: rsync would be nicer, but scp is what is guaranteed present on
# both ends here and the payload is a few megabytes.
#
# COPYFILE_DISABLE + --no-xattrs: macOS tar otherwise stores every file's extended
# attributes, which the server's GNU tar cannot read. It then prints one warning per file —
# thousands of stderr lines pushed back through the ssh channel — and litters the web root
# with AppleDouble `._*` companions that nginx happily serves as 163-byte garbage.
# 只跳过站点自己那一个 index.html，用列名字的方式，不用 --exclude。
#
# 原来写的是 `--exclude index.html`。tar 的排除模式是按**路径片段**匹配的，所以它同时命中了
# `app/index.html` —— 而站点根下嵌着一整个 Web 版 IDE（`/app/`），那个文件里写着编辑器
# bundle 的哈希名。于是：资源每次都在更新，指向资源的那张入口表却从第一次部署起就没动过，
# 线上一直加载着几天前的旧 bundle。这个故障不会以任何形式报错 —— 新旧文件都在、都是 200，
# 只是没人再引用新的那份，纯靠肉眼比对哈希才发现。
#
# 加 `./` 前缀锚定也不行：实测 BSD tar 照样两个都排除，GNU tar 又是另一套语义。所以干脆
# 显式列出顶层条目，唯独漏掉 `index.html`。它要留到最后单独上传，理由见文件开头第 2、4 条。
( cd "$OUT" && ls -A | grep -vx 'index.html' ) > "$OUT.files"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TGZ" -C "$OUT" -T "$OUT.files"

# 上面那个故障能潜伏这么久，就是因为没人检查过归档内容。检查一次，成本是两行。
tar -tzf "$TGZ" | grep -qx 'app/index.html' \
  || { echo "✗ 归档里没有 app/index.html —— 嵌入的 IDE 又会停在旧 bundle 上"; exit 1; }
# 内嵌 IDE 的 index.html 指名了它自己那套 content-hash 资源。少一个就是白屏，而且是
# **只有网页版用户看得见**的白屏——桌面端走的是另一份产物，本地怎么点都是好的。
_APP_HTML="$(tar -xzOf "$TGZ" app/index.html)"
for _ref in $(printf '%s' "$_APP_HTML" | grep -oE '(src|href)="/app/[^"]+"' | sed 's/.*"\/app\/\(.*\)"/\1/'); do
  tar -tzf "$TGZ" | grep -qx "app/$_ref" \
    || { echo "✗ app/index.html 引的 app/$_ref 不在归档里 —— 网页版会白屏。"; \
         echo "   多半是忘了在 ide/ 跑 npm run build:web（它带 --base=/app/）。"; exit 1; }
done
echo "==> 内嵌 IDE 的资源引用齐全（$(printf '%s' "$_APP_HTML" | grep -coE '(src|href)="/app/[^"]+"') 个）"
tar -tzf "$TGZ" | grep -qx 'index.html' \
  && { echo "✗ 归档里含站点根 index.html —— 它必须留到 bundle 验证通过后再单独上传"; exit 1; }
"${SCP[@]}" -q "$TGZ" "$REMOTE:$STAGE_DIR/site.tgz"
rm -f "$TGZ"
"${SSH[@]}" "$REMOTE" "tar -xzf $STAGE_DIR/site.tgz -C $WEB_ROOT && rm -f $STAGE_DIR/site.tgz"

echo "==> handing the files to nginx (www-data)"
"${SSH[@]}" "$REMOTE" "find $WEB_ROOT -name '._*' -delete; chown -R www-data:www-data $WEB_ROOT && chmod -R u=rwX,go=rX $WEB_ROOT"

# The gate. Read the bundle name out of the index.html we are about to publish, and refuse
# to publish it unless that exact file is on the server and readable by nginx. Without this
# a half-finished upload becomes a white page — and every check further down still passes,
# because "/" returns 200 whether or not its script exists.
BUNDLE="$(sed -n 's/.*src="\(\/assets\/index-[A-Za-z0-9_-]*\.js\)".*/\1/p' "$OUT/index.html" | head -1)"
[ -n "$BUNDLE" ] || { echo "could not find the bundle name in the built index.html"; exit 1; }
echo "==> checking $BUNDLE landed before pointing the site at it"
"${SSH[@]}" "$REMOTE" "sudo -u www-data test -r $WEB_ROOT$BUNDLE" || {
  echo "ABORTED: $BUNDLE is not readable on the server — the live site is untouched." >&2
  echo "The upload did not finish. Re-run this script." >&2
  exit 1
}

echo "==> switching index.html over"
"${SCP[@]}" -q "$OUT/index.html" "$REMOTE:$STAGE_DIR/index.html"
"${SSH[@]}" "$REMOTE" "cp -a $WEB_ROOT/index.html $STAGE_DIR/index.html.live-backup 2>/dev/null || true"
"${SSH[@]}" "$REMOTE" "install -m 0644 -o www-data -g www-data $STAGE_DIR/index.html $WEB_ROOT/index.html"

echo "==> verifying"
"${SSH[@]}" "$REMOTE" "sudo -u www-data test -r $WEB_ROOT/index.html || { echo 'nginx cannot read index.html'; exit 1; }"

# Retried, and never fatal. By this point the files are installed, and this host drops TLS
# connections often enough that one failed probe says nothing about the deploy — aborting
# here would report a failure that did not happen. An earlier version piped a dropped
# response straight into JSON.parse and crashed the script after a successful publish.
code=""
for attempt in 1 2 3 4 5; do
  code="$(curl -s -o /dev/null -m 25 -w '%{http_code}' "$SITE_URL/" || true)"
  [ "$code" != "000" ] && [ -n "$code" ] && break
  sleep $((attempt * 2))
done
echo "    $SITE_URL -> HTTP ${code:-unreachable}"

# "/" returning 200 says nothing about whether the page can run: it is the bundle that
# would be missing. Fetch it over the same public URL a visitor would.
bundle_code=""
for attempt in 1 2 3 4 5; do
  bundle_code="$(curl -s -o /dev/null -m 25 -w '%{http_code}' "$SITE_URL$BUNDLE" || true)"
  [ "$bundle_code" != "000" ] && [ -n "$bundle_code" ] && break
  sleep $((attempt * 2))
done
echo "    $BUNDLE -> HTTP ${bundle_code:-unreachable}"
[ "$bundle_code" = "200" ] || echo "    WARNING: the page's script is not being served — check before telling anyone." >&2

body=""
for attempt in 1 2 3 4 5; do
  body="$(curl -fsS -m 25 "$SITE_URL/tools.json" 2>/dev/null || true)"
  [ -n "$body" ] && break
  sleep $((attempt * 2))
done
if [ -n "$body" ]; then
  count="$(printf '%s' "$body" | tr -d ' \n' | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
  echo "    served catalogue: ${count:-unparseable} tools"
else
  echo "    served catalogue: could not be checked (connection dropped) — verify by hand"
fi

# 中国区镜像放在国内那台机器上时（deploy-cn-box.sh 装的），同一份构建也同步过去：两边永远一样。
# 没设 CN_BOX_SSH 就跳过——镜像还在美国机器上的话它读的本来就是同一个目录。
if [ -n "${CN_BOX_SSH:-}" ]; then
  echo "==> syncing the same build to the China box ($CN_BOX_SSH)"
  CN_WEB_ROOT="${CN_WEB_ROOT:-$WEB_ROOT}"
  retry rsync -az --delete -e "ssh -i ${CN_BOX_KEY:?需要 CN_BOX_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$OUT/" "$CN_BOX_SSH:$CN_WEB_ROOT/" \
    && retry ssh -i "$CN_BOX_KEY" -o BatchMode=yes "$CN_BOX_SSH" "chown -R www-data:www-data '$CN_WEB_ROOT' && chmod -R u=rwX,go=rX '$CN_WEB_ROOT'" \
    || echo "    WARNING: China box sync failed — mrday.one is updated, the mirror is not. Re-run with CN_BOX_SSH set." >&2
fi

echo
echo "deployed. roll back index.html with:"
echo "  ssh -i $SERVER_KEY $REMOTE 'install -m 0644 -o www-data -g www-data $STAGE_DIR/index.html.live-backup $WEB_ROOT/index.html'"
