-- 损益要的两个事实：**这一笔的售价用一个不会漂的单位记下来**，
-- 和**运营方替用户吃掉了多少**。
--
-- # 为什么 cost_cents 不够
--
-- `model_usage.cost_cents` 的单位在 2026-08-28（c387e33）变过一次：那之前是**美元分**
-- （`compute_cost` 的返回值直接扣），那之后是**人民币分**（`usd_micro_to_wallet_cents`
-- 折算之后才扣）。两种单位差 7.1 倍（汇率 1408），而库里**没有任何一列能把它们分开** ——
-- 所有 `SUM(cost_cents)` 的读者（用户端「累计消费」、admin_usage、rankings、plan_health）
-- 都在把两种单位直接相加，一声不吭。
--
-- 回填是做不到的：换算回去要知道每一行当时的汇率，而汇率是 app_settings 里一个可改的
-- 单值、没有历史。所以这里**不回填**，改用「新列有没有值」区分年代 —— 和
-- `endpoint_id IS NULL` 表示「20260871 之前写的行」是同一套惯例。
--
--   sell_micro_usd IS NULL  →  这一行在本迁移之前写的，cost_cents 的单位要看 created_at
--   sell_micro_usd IS NOT NULL → 单位确定，报表用这一列
--
-- 单位是 micro-USD（1 美分 = 10000）而不是分：一次 glm-5.3-flash 调用只值 $0.003，
-- 按分存全是 0，而那恰好是需要看清的那一档。这也是 ref_micro_usd 选同一单位的理由，
-- 两列因此可以直接相减得毛利，不用先过任何汇率。
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS sell_micro_usd bigint;

-- # 运营吸收：今天它在任何表里都不存在
--
-- `split_fused_charge` 对**靠套餐额度放行**的调用刻意不制造钱包债务：配额窗口尾巴上
-- 超出的那一段由运营方吸收（那段注释和 `subscription_quota_overshoot_does_not_create_wallet_debt`
-- 就是为它写的）。但 `model_usage.cost_cents` 写的是 `charge.total_cents()`，也就是
-- **实际扣到的钱** —— 配额和钱包同时为 0 时这一行记 0，而上游那笔钱是真付了的。
--
-- 后果是这块支出在任何一张报表上都不存在：既不在计费流水里，也不在毛利里，只有
-- `tracing::warn!` 一行，容器一换就没了。想回答「这个月替用户吃掉了多少」只能拿上游
-- 账单和本地流水对差。
--
-- 这一列只**记录**，不改变任何金额，也不改变 cost_cents 的含义。于是新行上有两条
-- 随时可查的恒等式，任何一条破了都说明单位又漂了：
--
--   cost_cents = wallet_cents + quota_cents + free_milli_points_spent / 1000
--   应收       = cost_cents + absorbed_cents
--
-- NOT NULL DEFAULT 0 而不是可空：按量付费这条路上「没有吸收」是一个**确定的事实**
-- （超支全额记为债务），不是「不知道」。可空会让报表分不清这两件事，而这张表已经
-- 因为「0 同时表示免费和算不出来」吃过一次亏。
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS absorbed_cents bigint NOT NULL DEFAULT 0;

-- 损益视图按 (天, 模型) 和 (天, 出口) 两种方式取数，而这张表每次调用都在长。
-- endpoint_id 那条索引 20260871 已经建过，这里补按天的那条。
CREATE INDEX IF NOT EXISTS idx_model_usage_day_model
  ON model_usage (created_at, model_name);

-- 「本月替用户吃掉了多少」是这一列唯一的用途，而它天生稀疏（只有配额边界上那几笔），
-- 全表扫描去找它不划算。
CREATE INDEX IF NOT EXISTS idx_model_usage_absorbed
  ON model_usage (created_at DESC)
  WHERE absorbed_cents > 0;
