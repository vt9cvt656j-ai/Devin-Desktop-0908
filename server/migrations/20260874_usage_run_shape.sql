-- 给 model_usage 加「这一行属于哪一次运行、是第几步」。
--
-- # 为什么必须有它
--
-- 所有者的抱怨是「简单的东西做半天、几十分钟完成不了」。查下来最长的那一档是
-- **84 个回合 / 35 分钟**，而每回合约 30 秒里模型请求本身就占约 20 秒（客户端实测
-- turnMs p50 19.9 秒、等首字 6.4 秒），harness 加本地工具执行只剩 0.5–1.6 秒。
-- 也就是说 42 分钟里 harness 能动的上限约 2 分钟 —— 慢不在我们这一侧，
-- **真正的问题是「为什么是 84 轮」**。
--
-- 而这一问今天在库里**结构上问不出来**：model_usage 没有任何一列能把行归到一次运行。
-- 现在只能拿「同一个 user_id、相邻两行间隔 < 2 分钟」去猜边界，那个判据在用户
-- 连着提两个问题、或者一步跑了三分钟的时候就会把一次运行切成两半、或把两次并成一次。
--
-- 客户端**每一发都在传** `x-ide-run-id` 和 `x-ide-step-index`（src/main.js 的请求头装配，
-- 桌面端另经 src-tauri/src/ai.rs 的 with_ide_headers）。网关也读了 run_id ——
-- 但只用于前缀探针的日志和粘性亲和键（models.rs 的 affinity_scope），
-- **从不落库**。这两列不是新增测量，是把已经在手上的东西放到能和钱、和模型、
-- 和工具名 join 的地方。
--
-- # 落库之后能问出来的（今天一条都问不了）
--
--   · 一次运行到底几个回合、跨多长时间、花多少钱
--       SELECT run_id, count(*) turns,
--              extract(epoch from max(created_at)-min(created_at))::int secs,
--              sum(cost_cents) cents
--       FROM model_usage WHERE run_id IS NOT NULL AND ide_mode='agent'
--       GROUP BY 1 HAVING count(*) >= 16 ORDER BY turns DESC;
--
--   · 同一次运行里同一个工具被重复调了多少次（「一直在调工具却不收敛」的直接指标）
--       SELECT run_id, emitted_tool, count(*) FROM model_usage
--       WHERE run_id IS NOT NULL GROUP BY 1,2 HAVING count(*) >= 5 ORDER BY 3 DESC;
--
--   · 长运行的后半段是不是在原地打转（步号让「后半段」第一次可定义）
--       SELECT step_index/10 AS decile, count(*), round(avg(completion_tokens))
--       FROM model_usage WHERE run_id IN (...) GROUP BY 1 ORDER BY 1;
--
-- # 形状
--
-- run_id 是客户端生成的短标识（网关侧已有的校验是 `^[-_A-Za-z0-9]{8,128}$`），
-- 存 text 不存 uuid：它不是我们生成的，硬转 uuid 会在客户端换格式那天整列写不进去
-- 而且**静默**——插入失败只会打一行 error 日志，账照记，谁也不会发现遥测断了。
--
-- 两列都可空、**不给默认值**。0 或空串会撒谎（「这是第 0 步」），NULL 说的是
-- 「这条路径没传」：老客户端、responses_proxy、以及补扣重跑的队列行都没有这两个数，
-- 和 ref_micro_usd / endpoint_id 在那些路径上的处理完全一致。
ALTER TABLE model_usage
  ADD COLUMN IF NOT EXISTS run_id     text,
  ADD COLUMN IF NOT EXISTS step_index integer;

-- 按 run 归组是这两列唯一的用法，索引跟着它走。
-- 局部索引：NULL 的行（老数据、非 agent 路径）不进索引，省一大半空间。
CREATE INDEX IF NOT EXISTS model_usage_run_idx
  ON model_usage (run_id, step_index)
  WHERE run_id IS NOT NULL;
