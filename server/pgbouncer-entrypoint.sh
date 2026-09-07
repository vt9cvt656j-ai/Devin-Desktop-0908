#!/bin/sh
set -e

# 从环境变量生成 PgBouncer 配置。docker-compose 传进来 POSTGRES_USER/PASSWORD/DB。
mkdir -p /etc/pgbouncer

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
${POSTGRES_DB} = host=postgres port=5432 dbname=${POSTGRES_DB}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
pool_mode = transaction
# sqlx 建连时会发 `extra_float_digits` 这个启动参数，而事务池模式的 PgBouncer 默认
# 拒绝一切未知启动参数，表现是应用一起来就
#     Error: error returned from database: unsupported startup parameter: extra_float_digits
# 然后容器崩溃循环。`options` 一并放行：驱动在某些路径上也会带它。
# 注意别顺手把 search_path 也加进来——那是"静默忽略"，schema 解析会悄悄走默认值。
ignore_startup_parameters = extra_float_digits,options
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
max_client_conn = 200
max_prepared_statements = 100
server_idle_timeout = 300
client_idle_timeout = 0
client_login_timeout = 15
query_timeout = 0
query_wait_timeout = 30
# PG 17 的 password_encryption 是 scram-sha-256。auth_type=md5 + userlist 里放 md5 哈希时，
# PgBouncer 对**上游 Postgres** 认证会直接失败：
#     ERROR cannot do SCRAM authentication: wrong password type
#     WARNING pooler error: server login failed: wrong password type
# 因为 SCRAM 的 verifier 推导不出来 —— 手上只有 md5 哈希是不够的。
# userlist 放**明文**（下面那行）之后 PgBouncer 两侧都能算：对客户端做 scram、对服务端也做 scram。
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
admin_users = ${POSTGRES_USER}
stats_users = ${POSTGRES_USER}
EOF

# userlist 存**明文**：PgBouncer 需要它来给上游 Postgres 算 SCRAM verifier（见上面 auth_type
# 那段）。口令本来就以环境变量形式进了这个容器，写进容器内的文件不额外扩大暴露面。
umask 077
printf '"%s" "%s"\n' "${POSTGRES_USER}" "${POSTGRES_PASSWORD}" > /etc/pgbouncer/userlist.txt

exec pgbouncer /etc/pgbouncer/pgbouncer.ini
