-- 充值汇率改为"套餐额度 / 支付金额"推导（计划 §2-M5）。
--
-- 文档：充值汇率最好不要让运维计算。输入套餐额度和支付价格，
-- `套餐额度 / 支付金额(￥) = 充值汇率`。
--
-- 两列均可空：两者都填时后端 `admin_save`（relay_rates.rs）服务端计算
-- `usd_per_cny = package_credit / paid_cny` 再落库并把结果回显；
-- 只填其一则维持手填 `usd_per_cny` 模式。
-- 现有 `usd_per_cny` 语义 = ¥1 买到多少上游余额单位，与文档公式同向，不换单位。
-- 本迁移只加列；计算逻辑在 Phase 3。
ALTER TABLE channel_rates
    ADD COLUMN IF NOT EXISTS package_credit DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS paid_cny       DOUBLE PRECISION;

ALTER TABLE channel_rates
    ADD CONSTRAINT channel_rates_package_credit_pos
        CHECK (package_credit IS NULL OR package_credit > 0),
    ADD CONSTRAINT channel_rates_paid_cny_pos
        CHECK (paid_cny IS NULL OR paid_cny > 0);
