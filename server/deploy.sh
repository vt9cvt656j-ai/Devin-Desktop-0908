#!/usr/bin/env bash
# Deploy the backend to a server over SSH. Credentials stay in the caller's SSH
# agent or key file; .env is never copied from the development machine.
#
#   SERVER_HOST=154.44.13.133 SERVER_KEY=~/.ssh/michael_server ./deploy.sh
#
set -euo pipefail

: "${SERVER_HOST:?set SERVER_HOST, e.g. SERVER_HOST=154.44.13.133}"
SERVER_PORT="${SERVER_PORT:-22}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_KEY="${SERVER_KEY:-}"
# 部署目标：prod（默认）或 test。
#
#   ./deploy.sh          → 生产
#   TARGET=test ./deploy.sh   → 测试环境（另一套容器、另一块数据库盘、另一个端口）
#
# 两套环境**必须**在这三样上分开，少一样就会踩到生产：
#   · REMOTE_DIR   —— rsync 的落点。同一个目录的话，一次测试部署就把生产的代码覆盖了。
#   · COMPOSE_PROJECT —— 容器名/网络/**卷名**的前缀。它决定 pgdata 是两块盘还是一块。
#   · BACKEND_PORT / SITES_DIR —— 宿主端口与静态站目录（走 .env，见 docker-compose.yml）。
TARGET="${TARGET:-prod}"
case "$TARGET" in
  prod)
    REMOTE_DIR="${REMOTE_DIR:-/opt/michael-ide-deploy/server}"
    COMPOSE_PROJECT="server"
    COMPOSE_FILES="-f docker-compose.yml"
    ENV_FILE=".env"
    HEALTH_PORT="8080"
    ;;
  test)
    REMOTE_DIR="${REMOTE_DIR:-/opt/michael-ide-deploy/server-test}"
    COMPOSE_PROJECT="server-test"
    COMPOSE_FILES="-f docker-compose.yml -f docker-compose.test.yml"
    ENV_FILE=".env.test"
    HEALTH_PORT="8081"
    ;;
  *)
    echo "TARGET 只能是 prod 或 test（收到：${TARGET}）" >&2
    exit 1
    ;;
esac
echo "部署目标：${TARGET}（项目 ${COMPOSE_PROJECT}，端口 ${HEALTH_PORT}，目录 ${REMOTE_DIR}）"
REMOTE="${SERVER_USER}@${SERVER_HOST}"
REMOTE_Q="$(printf '%q' "$REMOTE_DIR")"
# 锁按目标分开：测试环境的一次构建不该把生产的发布挡在门外。
REMOTE_LOCK="${REMOTE_LOCK:-/var/lock/michael-ide-deploy-${TARGET}.lock}"
REMOTE_LOCK_Q="$(printf '%q' "$REMOTE_LOCK")"
DEPLOY_LOCK_TIMEOUT_SECS="${DEPLOY_LOCK_TIMEOUT_SECS:-900}"

# ServerAlive*：连接**建立之后**才卡住的那种（这台机器的 SSH 时好时坏，握手能过、
# 传输中途静默 stall），ConnectTimeout 管不到——它只管建连那一下。没有保活探测的话，
# 一个半死的连接会一直挂到调用方的超时才被杀，rsync 的整个重试循环都轮不到跑。
# 15s×4 = 一条卡死的连接最多 60s 就被判死、抛错，交给下面的重试。
SSH_ARGS=(-p "$SERVER_PORT" -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
if [[ -n "$SERVER_KEY" ]]; then
  SSH_ARGS+=(-i "$SERVER_KEY")
fi

# ── 连接复用（这台机器最要命的一条）───────────────────────────────────────
#
# 这台服务器的 SSH **握手**经常直接失败，报 `banner exchange: … invalid format`。
# 手动 ssh 得重试 1–5 次是常态。每一次新连接都在重新赌这一下，而一次部署要建十几条
# 连接（ensure / backup / rsync / install-nginx / rollout / health…），于是「部署整体
# 成功」的概率被这些独立的赌局连乘掉。
#
# 实测过一次：rsync 直接被握手打死（`rsync: unexpected end of file`），而外层是
# `| tail` 的话这条错误还会被吞掉（tail 在进程被杀时不刷缓冲），现象就变成「部署停在
# syncing source、什么都没说」—— 极难判断，差点被误判成别的原因。
#
# 修法是别再赌：ControlMaster 只在开头**握手一次**，后面所有 ssh 和 rsync 都复用这条
# 已经建好的 TCP 连接，一次握手都不用再做。实测复用之后同一个 rsync 从「必失败」变成
# 2.4 秒跑完。
#
# ControlPath 放 /tmp 而不是 ~/.ssh：路径有长度上限（sockaddr_un 大约 104 字节），
# 家目录深一点就会静默超限。%C 是「主机+端口+用户」的哈希，短且唯一。
SSH_CTL="${SSH_CTL:-/tmp/mrday-deploy-cm-%C}"
SSH_ARGS+=(-o ControlMaster=auto -o "ControlPath=$SSH_CTL" -o ControlPersist=600)

# 主连接自己也要重试——它是唯一还需要真握手的那一次。
open_master() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if ssh "${SSH_ARGS[@]}" -O check "$REMOTE" >/dev/null 2>&1; then
      return 0   # 已经有一条活着的主连接（上一次部署留下的，ControlPersist 还没到期）
    fi
    if ssh "${SSH_ARGS[@]}" -M -N -f "$REMOTE" 2>/dev/null; then
      echo "SSH 主连接已建立（第 ${attempt} 次握手）"
      return 0
    fi
    echo "  SSH 握手被丢（第 ${attempt} 次），重试…" >&2
    sleep $((attempt))
  done
  echo "SSH 主连接建不起来（8 次握手全失败）——链路有问题，不继续部署" >&2
  return 1
}
close_master() {
  ssh "${SSH_ARGS[@]}" -O exit "$REMOTE" >/dev/null 2>&1 || true
}
# 无论成功、失败还是被 Ctrl-C，都把主连接收掉：留着的话下一次部署会复用一条**旧**连接，
# 而它可能连的是你上一次改 SERVER_HOST 之前的那台机器。
trap close_master EXIT
open_master || exit 1

# `status=$?` 放在 `if ssh …; then return 0; fi` 之后取到的是 **if 语句** 的退出码——
# 条件失败且没有 else 分支时它是 0。于是三次全失败之后这个函数返回 0，deploy.sh 一路走完
# 并打印 "deployment healthy"，实际什么都没部署。
#
# 这不是假想：2026-08-13 一次部署里远程构建因编译错误失败了三次，脚本照样报健康，
# 线上还跑着几小时前的旧镜像。同一个 bug 在本文件下面的 rsync_run 里已经被修过一次
# （注释就在那儿），ssh_run 这半边当时漏了。修法一样：用 `|| status=$?` 拿真实退出码，
# 它在 set -e 下也是安全的。
ssh_run() {
  local attempt status
  for attempt in 1 2 3 4 5; do
    status=0
    ssh "${SSH_ARGS[@]}" "$REMOTE" "$@" || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    # 255 是 ssh **自己**失败（握手掉线/连不上/认证不过），不是远端命令的返回值。
    # 这台机器的握手会随机以 "banner exchange ... invalid format" 掉，所以传输失败
    # 多给几次；远端命令自己报的错重试没意义，早点把真实退出码交出去。
    if [ "$status" -ne 255 ]; then
      echo "  remote step failed (exit ${status}); retrying" >&2
      [ "$attempt" -ge 3 ] && break
    else
      echo "  SSH 握手失败（第 ${attempt} 次，exit 255），重试…" >&2
    fi
    sleep $((attempt * 2))
  done
  echo "remote step failed after ${attempt} attempts (last exit ${status})" >&2
  return "$status"
}

# 远端真值探测：把「SSH 没连上」和「远端命令回答『否』」彻底分开。
#
# ssh 用 **255** 表示它自己失败；任何其它退出码都是远端命令自己的返回值。原来 .env
# 那道检查用的是 ssh_run，两者一律当成"远端说否"——于是这台机器上偶发的
# "banner exchange ... invalid format" 被翻译成了「服务器上没有 .env」。那是一条自信、
# 具体、而且完全错误的结论：.env 好端端地在那儿，照着这条提示去做（复制 .env.example
# 覆盖上去）会把生产的密码和密钥直接抹掉。
#
# 2026-08-19 实拍：连掉三次 → 脚本报 "No .env exists on the server" → 部署中止。
# 传输故障绝不能变成关于远端状态的断言；连不上就说连不上，什么都不判断。
ssh_true() {
  local attempt status
  for attempt in 1 2 3 4 5 6; do
    status=0
    ssh "${SSH_ARGS[@]}" "$REMOTE" "$@" >/dev/null 2>&1 || status=$?
    if [ "$status" -ne 255 ]; then
      return "$status"   # 远端真的回答了：0 = 是，非 0 = 否
    fi
    echo "  SSH 握手失败（第 ${attempt} 次），重试…" >&2
    sleep $((attempt * 3))
  done
  echo "" >&2
  echo "SSH 连不上 ${REMOTE}:${SERVER_PORT}（连续 6 次握手失败）。" >&2
  echo "这不是远端的状态，是连接问题——本次没有做任何判断，也没有改动服务器上任何东西。" >&2
  exit 2
}

# rsync 也走同一条主连接（ControlPath 必须和上面 SSH_ARGS 里的逐字一致，否则它会
# 自己再建一条、又去赌那次握手）。
RSYNC_RSH="ssh -p $(printf '%q' "$SERVER_PORT") -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ControlMaster=auto -o ControlPath=$(printf '%q' "$SSH_CTL") -o ControlPersist=600"
if [[ -n "$SERVER_KEY" ]]; then
  RSYNC_RSH+=" -i $(printf '%q' "$SERVER_KEY")"
fi

echo "ensuring ${REMOTE_DIR} on ${REMOTE}:${SERVER_PORT}"
ssh_run "mkdir -p $REMOTE_Q"

echo "creating a pre-deploy backup when the installed backup script is available"
ssh_run "if test -x $REMOTE_Q/backup.sh; then $REMOTE_Q/backup.sh; fi"

echo "syncing source (excluding build output, dev dependencies and .env)"
# node_modules: the two admin frontends carry ~280MB of dev dependencies between them.
#   Nothing on the server builds them — they are built locally and their `dist/` is
#   published to /var/www by deploy-account-ui.sh — so syncing them shipped a third of a
#   gigabyte of development tooling onto the production host on every deploy, into a
#   directory that is otherwise 8MB. The Dockerfile never reads them either.
# --filter 'protect backups': --delete-delay removes anything on the server that is not
#   in this source tree, and `backups/` exists ONLY on the server (prompt rollbacks put
#   there deliberately, before this script ever ran). Without this line a routine deploy
#   silently deletes the rollbacks — which are exactly what someone reaches for when a
#   deploy goes wrong.
# Retried, like ssh_run above. This host drops a large share of SSH handshakes
# ("banner exchange: ... invalid format"), and a single dropped handshake mid-sync
# aborted the whole deploy with `unexpected end of file` — after the pre-deploy backup
# had already run, so it looked like a real failure rather than a flaky connection.
# rsync resumes from where it got to, so a retry is cheap and idempotent.
# `status=$?` used to sit AFTER an `if rsync …; then return 0; fi`, where `$?` is the exit status
# of the *if statement* — which is 0 when the condition failed and there is no else branch. So
# every failed attempt logged "failed (exit 0)" and, worse, the function returned 0 after all five
# attempts: the deploy carried on, rebuilt the container from the OLD files, health-checked green,
# and printed "deployment healthy" having shipped nothing. Observed for real (2026-08-10): five
# consecutive "unexpected end of file" rsync failures reported as a successful deploy. Capture the
# real exit code with `|| status=$?`, which is also safe under `set -e`.
rsync_run() {
  local attempt status
  for attempt in 1 2 3 4 5; do
    status=0
    # 注意 `--exclude '.env*'` 而不是 `--exclude .env`：rsync 带 --delete-delay，
    # 只排除 `.env` 的话，服务器上的 `.env.test`（本地没有这个文件）会被当成"多余文件"
    # **删掉** —— 表现是第一次测试部署报「No .env.test exists」，而它其实是刚被这次
    # rsync 删的。（注释必须写在命令**外面**：写在续行反斜杠后面会把命令截断。）
    # --timeout=90：rsync 自己的 I/O 超时，兜住「保活探测也没能及时判死」的残余情况。
    # 传输本身很小（只有源码，排掉了 target），正常几秒就完；90s 没有任何 I/O = 链路死了，
    # 抛错重试，而不是永远挂着等外层超时把整个部署连根拔掉（那正是刚才那次的现象）。
    rsync -az --timeout=90 --delete-delay -e "$RSYNC_RSH" \
      --exclude target --exclude '.env*' --exclude .git \
      --exclude .DS_Store --exclude node_modules \
      --exclude '*.tsbuildinfo' \
      --filter 'protect backups' \
      --exclude '*.bak' --exclude '*.bak.*' --exclude '*.bak-*' --exclude '*.pre-*' \
      ./ "$REMOTE:$REMOTE_DIR/" || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    echo "  sync attempt ${attempt} failed (exit ${status}); retrying"
    sleep $((attempt * 3))
  done
  echo "source sync failed after 5 attempts (last exit ${status}) — NOT deploying stale files" >&2
  return "$status"
}
# ── 部署来源追溯 ────────────────────────────────────────────────────────────
#
# 上面那条 rsync 同步的是 **`./`，也就是你 cd 进来的那个目录**。这个仓库同时存在四个
# 能部署的工作树（主工作树 + ~/.mrday-scratch 下三个钉在不同提交的 detached worktree），
# 而且主工作树长期带着好几个并行会话的未提交改动。于是「线上跑的是什么」取决于
# **最后一次是谁在哪个目录跑的这个脚本**，而这件事此前一个字都没被记下来。
#
# 这不是假想。2026-08-21 一批改动（Anthropic/Codex 协议头）从主工作树连部署了 5 次、
# 在线上跑了约一小时四十分；2026-08-22 有人从 ~/.mrday-scratch/wt-server（一个干净的
# detached worktree）部署了两次，那批未提交的改动就此被 rsync --delete-delay 静默覆盖掉。
# **没有人做过回滚决定**，也没有任何地方留下痕迹 —— 事后是靠比对服务器上源文件的 md5
# 才发现的。
#
# 所以这里做三件事，都很便宜：把来源算出来、打在屏幕上、随部署写到服务器上；
# 并且在「来源和上一次不一样」时**拦一下**，因为那正是上面那次事故的形状。
SRC_DIR="$(pwd -P)"
SRC_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
SRC_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
# 只数会被 rsync 送上去的那些：排除项和上面 rsync 的 --exclude 对齐。
# `{ grep … || true; }` 不是装饰：树**干净**时 `git status --porcelain` 一行都不输出，
# `grep -v` 没有任何行可输出就返回 1，`pipefail` 把整条管道判成失败，`set -e` 当场杀掉
# 整个脚本 —— 而且只在干净树上触发，也就是恰好在推荐的部署方式下炸。实测踩过：部署停在
# 「syncing source」、退出码 1、一个字的解释都没有（那两行 echo 还没来得及跑）。
SRC_DIRTY="$(git status --porcelain -- . 2>/dev/null | { grep -vE '^\?\? (target|node_modules)/' || true; } | wc -l | tr -d ' ')"
SRC_STAMP="path=${SRC_DIR} commit=${SRC_COMMIT} branch=${SRC_BRANCH} dirty=${SRC_DIRTY}"
echo "部署来源：${SRC_STAMP}"
if [ "${SRC_DIRTY}" != "0" ]; then
  echo "  ⚠ 这次带上去的包含 ${SRC_DIRTY} 处**未提交**改动 —— 下一次从别的目录部署会把它们盖掉。"
fi

read_remote_stamp() {
  local attempt out
  for attempt in 1 2 3; do
    if out="$(ssh "${SSH_ARGS[@]}" "$REMOTE" "cat $REMOTE_Q/DEPLOYED_FROM 2>/dev/null" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    sleep 2
  done
  return 0   # 读不到就当第一次部署，不拦
}
PREV_STAMP="$(read_remote_stamp | head -1)"
PREV_PATH="$(printf '%s' "$PREV_STAMP" | sed -n 's/.*path=\([^ ]*\).*/\1/p')"
PREV_DIRTY="$(printf '%s' "$PREV_STAMP" | sed -n 's/.*dirty=\([0-9]*\).*/\1/p')"
if [ -n "$PREV_PATH" ] && [ "$PREV_PATH" != "$SRC_DIR" ]; then
  echo "" >&2
  echo "⚠ 部署来源变了：" >&2
  echo "    上一次：${PREV_STAMP}" >&2
  echo "    这一次：${SRC_STAMP}" >&2
  if [ "${PREV_DIRTY:-0}" != "0" ] && [ "${SRC_DIRTY}" = "0" ]; then
    echo "" >&2
    echo "  上一次部署带着 ${PREV_DIRTY} 处未提交改动，这一次的树是干净的 ——" >&2
    echo "  继续下去会把那批改动从线上**静默移除**，这正是 2026-08-22 那次事故的形状。" >&2
  fi
  if [ "${CONFIRM_SOURCE_CHANGE:-}" != "1" ]; then
    echo "" >&2
    echo "  确认要这么做就带上 CONFIRM_SOURCE_CHANGE=1 重跑。" >&2
    exit 1
  fi
  echo "  已通过 CONFIRM_SOURCE_CHANGE=1 确认，继续。" >&2
fi

rsync_run
# 落一份来源到服务器上，供下一次比对，也让「线上这份是从哪来的」随时能答。
ssh_run "{ printf '%s\n' $(printf '%q' "$SRC_STAMP"); printf 'deployed_at=%s\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\"; } > $REMOTE_Q/DEPLOYED_FROM"

echo "checking for ${REMOTE_DIR}/${ENV_FILE} on the server"
if ! ssh_true "test -f $REMOTE_Q/$(printf '%q' "$ENV_FILE")"; then
  echo "No ${ENV_FILE} exists on the server. Copy .env.example to ${ENV_FILE} and fill in"
  echo "   JWT_SECRET / POSTGRES_PASSWORD / QQ_SMTP_* before the first run."
  if [ "$TARGET" = "test" ]; then
    echo "   测试环境还必须设 BACKEND_PORT=8081 和 SITES_DIR=/var/www/michael-sites-test，"
    echo "   否则它会去抢生产的端口、往生产的静态站目录里写。"
  fi
  exit 1
fi

echo "validating, updating and health-checking containers (serialized)"
# Compose replaces the single host-published backend container in place. Two
# deploys started together can therefore stop a freshly started container and
# leave nginx with a much longer 502 window. Hold a host-side flock through the
# replacement and health check so only one rollout can touch the project at a
# time. The lock is operational coordination only; it does not change request
# handling or access policy.
# `--env-file` 是给 **${VAR} 插值**用的（POSTGRES_USER / BACKEND_PORT / SITES_DIR 这些
# 写在 compose 文件里的占位）。它和服务里的 `env_file:` 是两件事：后者只把变量注入容器，
# 不参与插值。生产靠目录里那个 `.env` 被 Compose 自动加载，测试目录里没有 `.env`，
# 必须显式指过去，否则所有 ${VAR} 都会插成空串（表现是一堆 "variable is not set"）。
DC="docker compose -p $COMPOSE_PROJECT --env-file $ENV_FILE $COMPOSE_FILES"
if [ "$TARGET" = "prod" ]; then
  # 生产走蓝绿：先起新颜色、验康健、再切 nginx 的 upstream、最后停旧的。
  # 完整理由和失败时的行为写在 rollout.sh 顶部。
  #
  # 换掉的是原来的 `up -d --build` —— 它**先毁后建**：在确认新镜像跑得起来之前就把正在
  # 服务的容器销毁了。线上两周 1,499 次 `connect() failed (111)` / `upstream prematurely
  # closed`，**每一次都落在部署时刻**，日常运行零次。而且新版起不来时没有回滚可言。
  # 先装 nginx 配置、再切颜色。两件事的顺序是刻意的：
  #   · 配置与颜色无关，先装完就不会和切换互相干扰；
  #   · 配置校验不过时**容器一个都还没动**，这次部署干干净净地失败。
  # 在这之前 /etc/nginx 下的那几份是手工拷过去的副本，deploy.sh 完全不碰 —— 于是
  # 「改了仓库不生效」和「改了线上不留痕」两个方向的漂移都没人发现。
  REMOTE_DEPLOY_CMD="cd $REMOTE_Q && bash ./install-nginx.sh && COMPOSE_PROJECT='$COMPOSE_PROJECT' ENV_FILE='$ENV_FILE' COMPOSE_FILES='$COMPOSE_FILES' bash ./rollout.sh"
else
  # 测试环境保持就地替换：它前面没有 nginx（不对公网开放，靠 SSH 端口转发访问），
  # 没有可切换的 upstream，蓝绿在这里既无处可切也无人受益。
  REMOTE_DEPLOY_CMD="cd $REMOTE_Q && $DC config --quiet && $DC up -d --build && for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do if curl -fsS http://127.0.0.1:${HEALTH_PORT}/health >/dev/null; then $DC ps; exit 0; fi; sleep 2; done; $DC logs --tail=100 backend; exit 1"
fi
REMOTE_DEPLOY_CMD_Q="$(printf '%q' "$REMOTE_DEPLOY_CMD")"
ssh_run "flock -w $DEPLOY_LOCK_TIMEOUT_SECS $REMOTE_LOCK_Q bash -c $REMOTE_DEPLOY_CMD_Q"
if [ "$TARGET" = "prod" ]; then
  echo "deployment healthy at https://code.mrday.one/health"
else
  echo "测试环境已就绪：ssh -L ${HEALTH_PORT}:127.0.0.1:${HEALTH_PORT} 上去之后开 http://127.0.0.1:${HEALTH_PORT}/health"
  echo "（它不对公网开放，宿主 nginx 不代理这个端口）"
fi
