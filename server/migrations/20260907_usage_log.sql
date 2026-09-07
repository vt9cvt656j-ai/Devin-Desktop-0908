-- 溯源日志（计划 §2-M4）。独立于计费，专记请求级结局——包括失败。
--
-- 为什么新表而不是往 `model_usage` 加列：20260854/20260857 迁移注释反复强调
-- `model_usage` 是计费链路（插入在结算事务里、外键与归属被测试钉死）。溯源要记
-- **失败调用**——计费流水里根本没有失败行；把失败塞进计费事务是拿钱的路径冒险。
--
-- 不带外键（计划 §6.2）：`route_id` / `endpoint_id` / `group_id` / `user_id` /
-- `api_key_id` 都是观测快照。删线路走 `model_usage.model_id ON DELETE SET NULL`
-- 会丢历史归属；用户日志/对账要按出口/线路名留冗余，本表故意不引用任何业务表，
-- 写失败必须静默、绝不进结算事务、不加会阻止删除的外键。
--
-- 数据入口（Phase 2 埋点，本迁移只建表）：
--   成功：models.rs 计费插入点旁路多写一份（不计费、不参与事务回滚）；
--   失败：route_health::record_fail 与派单超时/停用收口处补写。
CREATE TABLE IF NOT EXISTS usage_log (
    id                BIGSERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 覆盖"时间"维度
    day               DATE NOT NULL DEFAULT current_date,   -- 按天裁剪索引
    kind              TEXT NOT NULL,                        -- ok | fail | stall（请求级结局）
    user_id           UUID,                                 -- 维度：用户（NULL = 未绑定用户的网关请求）
    api_key_id        UUID,                                 -- 维度：API key（gateway 请求才填）
    route_id          UUID,                                 -- 维度：线路
    endpoint_id       UUID,                                 -- 维度：出口（可与 route_id 相同=自带地址）
    group_id          UUID,                                 -- 维度：分组（冗余存，免 JOIN）
    model_name        TEXT NOT NULL,                        -- 上游模型名（claude-opus-5）
    prompt_tokens     BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    cached_tokens     BIGINT NOT NULL DEFAULT 0,
    latency_ms        INTEGER,                              -- 首字/总耗时（按现有 real_ttfb 口径）
    http_status       INTEGER,                              -- 上游/网关状态码
    err_class         TEXT,                                 -- 错误归类：upstream_4xx|upstream_5xx|balance|timeout|cancel|auth|disabled
    err_detail        TEXT,                                 -- 原样错误摘要（限长由写入侧截断）
    cost_micro_usd    BIGINT NOT NULL DEFAULT 0,            -- 成功时=扣用户的钱（与计费同源）
    cost_cny_micro    BIGINT NOT NULL DEFAULT 0,            -- 用户实际付的人民币（wallet+quota，20260871 同口径）
    CONSTRAINT usage_log_kind_check CHECK (kind IN ('ok', 'fail', 'stall'))
);

CREATE INDEX IF NOT EXISTS idx_usage_log_created
    ON usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_day_route_model
    ON usage_log (day, route_id, model_name);               -- 线路/模型频次
CREATE INDEX IF NOT EXISTS idx_usage_log_day_api_key
    ON usage_log (day, api_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_log_user_day
    ON usage_log (user_id, day);
