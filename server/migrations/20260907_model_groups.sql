-- 分组实体（计划 §2-M1）。
--
-- 为什么要这张表：`models.group_into`（20260825）只是把一条线路的模型"显示"到另一条
-- 线路名下，喂的是 IDE 模型选择器里唯一一个字段；它没有序号、没有品牌、没有筛选字段、
-- 没有"分组下有没有路由"的删除护栏。产品文档要的是真正可管理的分组：品牌锁定 IDE 图标、
-- 筛选字段收窄可拉模型、路由归属（出口挂分组，见 M2）、删除护栏、IDE 页签顺序。
--
-- 删除护栏在后端事务里做（`DELETE` 前先数 route_endpoints.group_id 引用，>0 返回 400
-- "请先删除该分组下的所有路由"）；下面 FK 的 ON DELETE SET NULL 只是兜底——它保证
-- "删分组"绝不会连带删掉出口配置，最坏情况是出口退回"未分组"。
CREATE TABLE IF NOT EXISTS model_groups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq           INTEGER NOT NULL DEFAULT 0,       -- 序号（IDE 展示顺序，可改）
    name          TEXT NOT NULL UNIQUE,             -- 分组名（Claude / GPT / …）
    brand         TEXT NOT NULL DEFAULT 'other',    -- 枚举：claude|gpt|deepseek|gemini|minimax|glm|grok|qwen|kimi|other，锁定 IDE 图标
    active        BOOLEAN NOT NULL DEFAULT true,    -- 使用中 / 废弃
    filter_fields TEXT[] NOT NULL DEFAULT '{}',     -- 筛选字段（不区分大小写），例 {Claude,cc,c-c}；空 = 组内不限
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IDE 按序号顺序展示分组；分组不多，这个索引只是让 ORDER BY seq 走索引而非全表排序。
CREATE INDEX IF NOT EXISTS idx_model_groups_seq ON model_groups (seq);
