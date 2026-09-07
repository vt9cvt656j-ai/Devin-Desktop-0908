-- 退了多少钱。
--
-- `charge.refunded` 的 webhook 里 `amount_refunded` 一直是被读出来的（stripe.rs 拿它
-- 按比例追回佣金），但读完就扔了：订单上只留一个 `refunded_at` 时间戳。于是
--
--   · 收入汇总不知道该扣多少 —— 总览页的「已收款」按 `charged_cents` 全额计，
--     退过款的单原封不动地留在里面；
--   · 部分退款和全额退款在库里长得一模一样。客户退了 $10 的那一单，和整笔退掉的
--     那一单，`refunded_at` 都是一个时间戳，只能靠去 Stripe 后台一单单看。
--
-- 可空,而且 NULL 不是 0：NULL = 「没记」（本迁移之前的旧行，以及拒付那条路——
-- dispute 对象上根本没有 amount_refunded），0 = 「确实一分没退」。报表必须能区分
-- 这两件事，否则一批 NULL 会被当成「全都没退钱」混进收入里，而那正是要修的错。
--
-- 单位跟 `charged_cents` 走（Stripe 的最小货币单位，币种看 `charged_currency`），
-- 不跟 `amount_cents`：后者是目录挂牌价，实收和它可以不同（货币选项、优惠券、
-- 汇率），拿挂牌价去减退款额是两把尺子相减。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_cents bigint;

-- 收入汇总要按「这段时间里退了多少」取数，而退款时刻和下单时刻可以差很远。
CREATE INDEX IF NOT EXISTS idx_orders_refunded
  ON orders (refunded_at DESC)
  WHERE refunded_at IS NOT NULL;
