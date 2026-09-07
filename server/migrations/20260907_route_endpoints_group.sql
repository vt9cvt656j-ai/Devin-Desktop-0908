-- 出口挂分组（计划 §2-M2，§9-B 二读修订：替代原"线路挂分组"）。
--
-- 文档证据指向"分组的下属物是路由（出口配置）"而不是线路：
--   * 删除分组护栏查的是"该分组下是否有路由"（文档原话）；
--   * 多路由界面按分组分段、每段小标题右侧是"添加新路由"按钮 → 出口在选定分组下创建；
--   * 线路界面全程不出现分组——A1 号池化后线路只是"站点 + 连接协议"的存储地，被出口引用。
-- 所以 group_id 挂在 route_endpoints（出口）上；models（线路）不挂分组、不挂价格。
--
-- "同组多 key 同 base_url" = 组内多个出口；"同 key 跨分组" = 不同分组各建一个出口引用
-- 同一把 key（key 进 route_credentials 后无唯一索引冲突，见 M6）。
--
-- 拍板 2 默认：出口与分组一对一，不做多对多——否则删除分组的护栏语义要重定义。
ALTER TABLE route_endpoints
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES model_groups (id) ON DELETE SET NULL;

-- 多路由界面按分组分段拉取、删除护栏按分组数出口，都要走这个谓词。
CREATE INDEX IF NOT EXISTS idx_route_endpoints_group
  ON route_endpoints (group_id) WHERE group_id IS NOT NULL;
