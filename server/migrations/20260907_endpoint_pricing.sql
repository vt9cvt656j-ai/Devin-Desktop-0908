-- 出口 × 模型 价格/计费（计划 §2-M3）。
--
-- 文档 B.创建/编辑出口弹窗右侧表：勾选启用、模型名、显示名、倍率、中转输入价、中转输出价、
-- 原厂输入价、原厂输出价、计费方式（跟随渠道/按 token/按调用次数/免费）。
-- 数据入口：`POST /api/admin/route-endpoints/:id/pull-models` 拉目录时把中转价/原厂价带成初始行。
--
-- ⚠️ 计费语义红线（计划 §9-C 默认，拍板 3）：这张表的倍率/中转价**只参与排序、健康、
-- 对账展示**（与 reconcile/endpoint_model_usage 同路），**不进用户账单**。用户账单仍走
-- models 上的价格 + compute_cost 计费链（20260851"换出口换不动账单"的核心设计）。
--
-- 倍率约束（docx 原话"倍率不可为 0，除非是完全免费"，见核对记录 #5）：
--   * 落库 CHECK (rate >= 0) 挡住负数；
--   * 0 只在 billing_mode='free'（计费方式=免费）时合法，非免费 rate=0 由应用层拒绝 400。
--   * 语义：0.7 = 原价七折、1.2 = 比原价贵 20%、1 = 原价。
CREATE TABLE IF NOT EXISTS endpoint_model_prices (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id      UUID NOT NULL REFERENCES route_endpoints (id) ON DELETE CASCADE,
    model_id         TEXT NOT NULL,            -- 上游模型名（claude-opus-5）
    enabled          BOOLEAN NOT NULL DEFAULT true,   -- 是否投入轮转
    display_name     TEXT NOT NULL DEFAULT '',  -- 空 = 按模型名显示
    rate             DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (rate >= 0),  -- 倍率；0 = 免费
    relay_in_usd     DOUBLE PRECISION,          -- 中转输入价（拉模型时带下来，可手改）
    relay_out_usd    DOUBLE PRECISION,
    official_in_usd  DOUBLE PRECISION,          -- 原厂价（快照，便于对比；实时价走 official_price()）
    official_out_usd DOUBLE PRECISION,
    billing_mode     TEXT NOT NULL DEFAULT 'channel',  -- channel|token|per_call|free
    per_call_usd     DOUBLE PRECISION,          -- 按次计费（billing_mode='per_call'）时生效
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (endpoint_id, model_id)
);

-- 弹窗按出口列模型、编辑时逐行更新，UNIQUE 已有隐式索引，此索引服务"按模型找出口"的展示。
CREATE INDEX IF NOT EXISTS idx_endpoint_model_prices_model
  ON endpoint_model_prices (model_id);
