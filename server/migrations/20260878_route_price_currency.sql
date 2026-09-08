-- 线路的**报价币种**，以及删掉从没被用过的出口余额令牌。
--
-- # 报价币种
--
-- 所有者 2026-09-08：「换成可以选择美金或者人民币，选择完成后，用户输入和输出价格
-- 就是人民币或者美金」。
--
-- 这不是记账单位的改变，是**录入口径**的改变。中转商各报各的价：OpenRouter 和多数海外
-- 中转报「美元每百万 token」，国内中转直接报人民币。此前后台只有一个美元框，运维拿到一张
-- 人民币报价单得自己先除一遍汇率再填 —— 除错一位就是整条线路的进价错一个数量级，
-- 而这件事在屏幕上看不出来。
--
-- **存进库的永远是美元。** `compute_cost` 全程按美元单价算（目录价 / 每模型覆盖 / 线路
-- 兜底价，单位都是「美元每百万 token」），只有到用户钱包那一步才过 `usd_micro_to_wallet_cents`
-- 折成人民币口径。这个顺序是刻意的：plan_health.rs 那句「单位永不随汇率漂」说的就是它 ——
-- 汇率一变，历史账不该跟着变。
--
-- 所以这一列**只决定后台那个输入框怎么读、怎么写**：折算发生在保存的那一刻，
-- 存下去之后这条线路的价就是一个确定的美元数，和以后的汇率再无关系。选人民币的线路
-- 日后改了汇率，已存的价不动（那是当初谈定的价），只有下次在框里改价时才按新汇率折。
--
-- 取值只有 'usd' 和 'cny'，默认 'usd' —— 这一列上线之前所有线路填的都是美元，不能改口径。
--
-- # 为什么顺手删 route_endpoints.balance_token
--
-- 它是给中转控制台余额接口用的第二套凭据（那些接口认控制台登录令牌，不认 sk- 调用密钥）。
-- 线上实测：**16 个出口，填了这个令牌的是 0 个**。这条路从上线到现在一次都没走过，
-- 余额探针一直走的是「留空就用调用密钥」那条兜底。留着它只是在「加一个出口」的表单里
-- 多占一格，而那一格正是所有者要用来放币种选择的位置。
--
-- **线路那一级的 models.balance_token 不动。** 同样实测：9 条线路里有 2 条填了
-- （其中 1 条还在启用），删了它们的余额那一列就读不出来。这一版只是把输入框从表单上撤掉，
-- 列和已存的值留着，探针照常用。要彻底删是另一件事，得先确认那条线路的余额可以不看。

ALTER TABLE models
  ADD COLUMN IF NOT EXISTS price_currency TEXT NOT NULL DEFAULT 'usd';

ALTER TABLE models
  DROP CONSTRAINT IF EXISTS models_price_currency_check;
ALTER TABLE models
  ADD CONSTRAINT models_price_currency_check CHECK (price_currency IN ('usd', 'cny'));

ALTER TABLE route_endpoints DROP COLUMN IF EXISTS balance_token;
