-- 线路号池（计划 §2-M6，§9-A 已锁 A1）。
--
-- 文档：线路 = 站点 + 连接协议；密钥/备注拆进号池。每把 key 一行，备注随 key。
-- 同一线路下不同备注禁止重复；同一把 key 可被不同分组的出口引用（出口挂
-- credential_id 是 Phase 2 的事）。线路本身不挂分组、不挂价格，只被
-- route_endpoints 引用。
--
-- 加密：api_key_enc 与 models.api_key 同一套 field_crypto（context = models.api_key），
-- 一次轮换覆盖两边。api_key_fp 是明文的确定性指纹，由应用层写入——SQL 解不开
-- 随机 nonce 密文，所以回填时 fp 留空，Phase 2 模块补齐。
--
-- 本迁移不删 models.api_key：旧派单路径仍读那一列。折叠/切换在 Phase 2。
CREATE TABLE IF NOT EXISTS route_credentials (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id    UUID NOT NULL REFERENCES models (id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',          -- 备注（= 路由名）；空 = 未命名
    api_key_enc TEXT NOT NULL DEFAULT '',          -- 与 models.api_key 同 context
    api_key_fp  TEXT,                              -- 明文指纹；NULL = 尚未回填
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一线路下非空备注唯一（文档：同一 base_url 的不同备注禁止重复）。
-- 空备注允许多把未命名 key，所以用部分唯一索引，不约束 label = ''。
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_credentials_route_label
    ON route_credentials (route_id, label)
    WHERE label <> '';

-- 同一线路下同一把 key 只留一份。空指纹不参与唯一（回填完成前允许并存）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_credentials_route_fp
    ON route_credentials (route_id, api_key_fp)
    WHERE api_key_fp IS NOT NULL AND api_key_fp <> '';

-- 取号池时的形状：「这条线路的、还开着的」。
CREATE INDEX IF NOT EXISTS idx_route_credentials_route
    ON route_credentials (route_id, active);

-- 每条现有线路搬一把 key 进号池。label 用线路名，避免空备注；api_key 原样拷贝。
INSERT INTO route_credentials (route_id, label, api_key_enc, active)
SELECT id, label, api_key, active
FROM models
WHERE NOT EXISTS (
    SELECT 1 FROM route_credentials rc WHERE rc.route_id = models.id
);
