# 模型线路大改造 — 后端改动计划（落地稿）

> 依据：微信文档《新建DOCX 文档.docx》（2026-09-07 收）
> 目标代码库：`server/`（Rust + Axum + Postgres + Redis；admin-ui 为 React 管理台）
> 本文档先把改动说清楚，再按 Phase 实施。每步独立可验证。**进度以 git 为准，见下方「实施进度」。**

> 这份文档解决什么问题：把产品文档（模型线路页的八个界面需求）翻译成后端可执行的改动清单。
> 它在整体里的位置：`server/` 的模型线路/多路由/健康体系重构的**第一个交付物**——先定迁移与
> 接口形状，再动代码。最不显然的取舍：用户日志和数据模型都**故意新增表、不碰计费链路**，
> 因为本项目注释里反复踩过"为报表改计费事务把钱改没"的坑（详见 §6）。

---

## 实施进度（2026-09-08 对照 `gao-dev` HEAD `3478fb5a`）

对照仓库实况回写，**未完成的不标完成**。工作区除 IDE 目录 `.mrdayone/` 外干净；该 HEAD 已与 `origin/gao-dev` 对齐。

| Phase | 状态 | 合入提交 | 证据 |
|---|---|---|---|
| 0 拍板 | **完成** | `c475e5f9` → `d18ba053` → `4da94d06` | A1 号池锁定；出口直挂分组；拍板 1–4 写入 §10；docx 逐项核对 5 处差异已按原文改 md |
| 1 迁移 M1–M6 | **完成** | `4d25a1fb` | `server/migrations/20260907_{model_groups,route_endpoints_group,endpoint_pricing,usage_log,channel_rates_pay,route_credentials}.sql`（6 文件 / +185 行） |
| 2 后端实体 | **前半完成** | `3478fb5a` | 见下表；派单埋点 / 停用护栏 / 线路新列 **未做** |
| 3 查询 API | 未开始 | — | 健康两视图、usage-log 三视图+搜索、official-prices、汇率同步排查 |
| 4 admin-ui | 未开始 | — | 用户日志、官方原价新屏 + 分组/线路/多路由/健康重构 |
| 5 收口 | 未开始 | — | 全链路走查；gao-dev → main 的 PR 尚未开（本轮只推 gao-dev） |

Phase 2 拆开（`3478fb5a`，+1054 / −2，5 文件）：

| 项 | 状态 | 落点 |
|---|---|---|
| `model_groups` CRUD + 排序/上下移 | **完成** | `server/src/model_groups.rs`（347 行）；`GET/POST /api/admin/model-groups`、`POST .../reorder`、`POST/DELETE .../:id`、`POST .../:id/move`（`main.rs` 499–513） |
| 号池 CRUD（A1） | **完成** | `server/src/route_credentials.rs`（431 行）；`GET/POST /api/admin/models/:id/credentials`、`POST/DELETE .../:cid`（`main.rs` 488–494） |
| 删线路护栏 | **完成** | `models.rs` `admin_delete`：`line_impact` 先返 `{needs_confirm, affected, total}`，`?confirm=true` 后同一事务删 `route_endpoints` + `models` |
| `usage_log` 骨架 | **完成** | `server/src/usage_log.rs`（211 行）：`spawn_ok` / `spawn_fail` / `spawn_stall`；写失败静默、不进结算事务 |
| `usage_log` 派单埋点 | **未做** | `server/src/` 除本文件外 **零处** `usage_log::` 调用；热路径尚未记成功/失败/卡死 |
| 线路停用护栏 | **未做** | 只有删除二次确认；停用（`active=false`）未做引用提示 |
| 线路界面新列 | **未做** | 计划里的 last_used / 启用模型 / Claude 强力版等未挂到 `admin_list` |
| Phase 2 验收 | **未做** | 计划要求 `cargo check` + `cargo test`（改 `models.rs` 必跑全量）+ 删组护栏手测；本批提交未把这三项当合入门槛跑过 |

下一步按计划顺序：Phase 2 后半（派单埋点 → 停用护栏 → 线路新列 → check/test），然后 Phase 3。

---

## 0. 结论摘要

文档要的是一次"线路体系"重构，不是加几个页面。核心差距有三个：

1. **没有"分组"实体**。现在只有 `models.group_into`（把一条线路的模型显示到另一条线路名下，
   `migrations/20260825_model_group_into.sql`），文档要的是真正管理分组（品牌锁定、筛选字段、
   路由归属、删除护栏、IDE 页签顺序）。→ 需新表 + 归属改造。
2. **"线路"的语义是"一个 base_url + 一把 key"**（`models` 一行 = 站点+key+模型集；
   多 key 组号池 = 建多行 models）。文档要"线路 = 号池/上游存储地"，一个 base_url 下面挂多把
   key 组成号池，key 可以重复出现在不同分组。→ 需要把 base_url 与 api_key 从 `models` 行拆开，
   或新增"号池成员"表。**这是全部改动里最大的语义分叉——二读后已锁定 A1（彻底拆号池，见 §9-A）。**
3. **用量日志缺了溯源需要的所有维度**。`model_usage` 是纯计费流水（只在成功扣费时插入），
   没有：失败调用、延迟、错误原因、用的哪把 API key、按出口/模型/用户聚合之外的检索能力。
   文档的"用户使用日志"（多维度筛选 + 报错维度 + 三种视图 + 搜索弹窗）现有数据根本撑不起来。
   → 需新日志表 + 在派单链路上补记录点。

其余是**已有能力的页面重组/升级**：健康页已有 `route_health`/`route_attempt`/`endpoint_usage` 数据源
（要加视图二、跳转详情、tooltip），汇率页已有 `channel_rates`（要降级、改计算方式、查同步 bug），
官方原价已有 `model_catalog` + `official_price()`（要独立成"统一适配页"）。

> 规模估计：5~8 个迁移文件；后端新增/重写约 3 个模块；`models.rs` 语义级改动；
> admin-ui 新增 2 个大屏（用户日志、官方原价适配）、重构 4 屏（分组/线路/多路由/健康）。
> **建议按 Phase 分批合入，不要把 8 个迁移一次堆上去**（本项目每批迁移都有注释里的历史教训）。

---

## 1. 文档需求 → 现状差距总表

| # | 文档要求 | 现状（证据） | 差距等级 |
|---|---|---|---|
| 1 | 模型线路页签下移除"排序" | `Shell.tsx` 模型线路组有"排序"子页；`App.tsx` `ROUTING_OWN_SCREENS` 里 `routing-sort → RouteOrder.tsx`；后端 `POST /api/admin/models/sort`（main.rs:429 附近）、`RouteOrder.tsx`(311行) | 中（导航+删除） |
| 2 | 分组界面：创建/删除护栏/序号/品牌/筛选字段/上下移/一键排序 | 无分组实体；`Routing.tsx` 只有一个简版 `Groups`（view=`routing-groups`）；后端 `admin_group`（models.rs:2891）只改 `group_into` | **大（新模块）** |
| 3 | 多路由：按分组拉模型、同 key 可跨分组、出口 per-model 倍率/中转价/计费方式 | `route_endpoints`（20260851）只挂 `route_id`；每出口只有一个 `cost_ratio`；`admin_available`（route_endpoints.rs:3138）按线路拉目录；无出口级价格表 | **大（新表+改归属）** |
| 4 | 线路界面 = 号池存储地；一 base_url 多 key；删除/停用护栏提示 | `models` 一行=一站点+一 key；停用 `active`；删除无"被引用 X 路由"提示 | **大（见 §9-A）** |
| 5 | 健康页：两种视图、警告红黄绿、余额、跳用户日志、tooltip | `route_endpoints.rs:admin_health`(2232) + `RouteHealth.tsx`(371行) 已有基础（站点/状态/健康度/今天调用/花费）；无视图二/无余额列/无跳转 | 中 |
| 6 | 汇率降为模型内二级 + 充值汇率 = 套餐额度/支付金额 + 同步 bug | `relay-rates` 是**一级页签**（Shell.tsx ~169 `模型汇率`）；`channel_rates` 表（0022+20260863 host）；`relay_rates.rs admin_list`(175)/`admin_save`(304)；`ratio_sync` | 中 |
| 7 | 模型官方原价统一适配页（模型移除时联动删除） | `model_catalog` 表（20260838）、`official_price()`（models.rs:4978）、20260873 spot 价；无独立"所有已添加模型"适配页；`reconcile`/`pricing` 部分覆盖 | 中（新页） |
| 8 | 用户使用日志（溯源：token 去向、线路频次；时间/API key/分组/模型/用户多维筛选；搜索弹窗+饼图；当前页排序） | `model_usage` 只有成功计费行；无失败/延迟/错误/API key 维度；`/api/admin/model-usage`（models.rs:4340 `admin_usage`）只回 totals；无明细 API | **大（新模块）** |

---

## 2. 数据层迁移（Phase 1，一次规划、分文件落地）

迁移命名沿用本项目惯例（`migrations/20260907_*.sql`，当天日期）。

### M1 `20260907_model_groups.sql` — 分组实体（新）

```sql
CREATE TABLE IF NOT EXISTS model_groups (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq            INTEGER NOT NULL DEFAULT 0,        -- 序号（IDE 展示顺序，可改）
    name           TEXT NOT NULL UNIQUE,              -- 分组名（Claude / GPT / …）
    brand          TEXT NOT NULL DEFAULT 'other',     -- 枚举见下，锁定 IDE 图标
    active         BOOLEAN NOT NULL DEFAULT true,     -- 使用中 / 废弃
    filter_fields  TEXT[] NOT NULL DEFAULT '{}',      -- 筛选字段（不区分大小写），例 {Claude,cc,c-c}
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

品牌枚举（对齐 `route_endpoints.rs:vendor_of` 与 `PROVIDERS` 常量，前端 `VendorMark` 已有图标）：
`claude / gpt / deepseek / gemini / minimax / glm / grok / qwen / kimi / other`。
删除护栏**放后端事务里**：`DELETE FROM model_groups WHERE id=$1` 前先
`SELECT count(*) FROM route_endpoints WHERE group_id=$1`（分组下路由=出口，见 §9-B 挂载层结论），
>0 返回 400 "请先删除该分组下的所有路由"（文档原文文案）。

### M2 `20260907_route_endpoints_group.sql` — 出口挂分组（二读修订：替代原"线路挂分组"）

```sql
ALTER TABLE route_endpoints ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL;
CREATE INDEX ... ON route_endpoints (group_id);
```

**取舍说明（§9-B 修订后）**：分组的下属物是"路由"（文档原话：删除分组护栏查"该分组下是否有路由"、
多路由界面按分组分段、每段小标题右侧建出口），路由=route_endpoints 出口，故 group_id 挂在**出口**上；
models（线路）不挂分组、不挂价格，保持纯号池存储地（§10.1）。"同组多 key 同 base_url" = 组内多个
出口；"同 key 跨分组" = 不同分组各建一个出口引用同一把 key（A1 后 key 进 route_credentials，无唯一
索引冲突）。原稿"挂 models 经 route_id 继承"改动面小，但与文档证据冲突，撤销。

### M3 `20260907_endpoint_pricing.sql` — 出口 × 模型 价格/计费（新）

文档 B.创建/编辑出口弹窗右侧表：勾选启用、模型名、显示名、倍率、中转输入价、中转输出价、
原厂输入价、原厂输出价、计费方式（跟随渠道/按 token/按调用次数/免费）。

```sql
CREATE TABLE IF NOT EXISTS endpoint_model_prices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id    UUID NOT NULL REFERENCES route_endpoints(id) ON DELETE CASCADE,
    model_id       TEXT NOT NULL,            -- 上游模型名（claude-opus-5）
    enabled        BOOLEAN NOT NULL DEFAULT true,   -- 是否投入轮转
    display_name   TEXT NOT NULL DEFAULT '', -- 空 = 按模型名显示
    rate           DOUBLE PRECISION NOT NULL DEFAULT 1.0,  -- 倍率；0 = 免费；<1 折扣、>1 加价
    relay_in_usd   DOUBLE PRECISION,         -- 中转输入价（拉模型时带下来，可手改）
    relay_out_usd  DOUBLE PRECISION,
    official_in_usd DOUBLE PRECISION,        -- 原厂价（快照，便于对比；实时价走 official_price()）
    official_out_usd DOUBLE PRECISION,
    billing_mode   TEXT NOT NULL DEFAULT 'channel',  -- channel|token|per_call|free
    per_call_usd   DOUBLE PRECISION,         -- 按次计费时生效
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (endpoint_id, model_id)
);
```

**关键约束（文档原话）**：倍率不可为 0，除非完全免费——落库 `CHECK (rate >= 0)`，应用层把关：
`billing_mode='free'`（计费方式=免费）才允许 `rate = 0`；非免费 `rate = 0` 直接拒绝（400）。语义对齐 docx：
0.7 = 原价七折、1.2 = 比原价贵 120%、1 = 原价。拉模型时若中转能报出价格就带下来
（`relay_adapter` 已能从 sub2api 拉价目，见 src/relay_adapter.rs:634 `collect_sub2api_groups`）。

> ⚠️ **计费语义红线（必须先拍板，见 §9-C）**：这张表的倍率/中转价目前**只允许参与排序、健康、
> 对账展示**（与 `reconcile`/`endpoint_model_usage` 同路），**不进用户账单**。用户账单仍走
> `models` 上的价格 + `compute_cost`（models.rs:2666 起的计费链）。要让出口级价格参与计费，
> 等于推翻 20260851"换出口换不动账单"的核心设计并动结算事务——默认不做，除非用户明确要求。

### M4 `20260907_usage_log.sql` — 溯源日志（新，独立于计费）

**为什么新表而不是往 `model_usage` 加列**：20260854/20260857 迁移注释反复强调
`model_usage` 是计费链路（插入在结算事务里、外键与归属被测试钉死）。溯源要记**失败调用**——
计费流水里根本没有失败行；把失败塞进计费事务是拿钱的路径冒险。

```sql
CREATE TABLE IF NOT EXISTS usage_log (
    id             BIGSERIAL PRIMARY KEY,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 覆盖"时间"维度
    day            DATE NOT NULL DEFAULT current_date,   -- 按天裁剪索引
    kind           TEXT NOT NULL,             -- ok | fail | stall（请求级结局）
    user_id        UUID,                      -- 维度：用户（NULL = 未登录 API key？）
    api_key_id     UUID,                      -- 维度：API key（gateway 请求才填）
    route_id       UUID,                      -- 维度：线路
    endpoint_id    UUID,                      -- 维度：出口（可与 route_id 相同=自带地址）
    group_id       UUID,                      -- 维度：分组（冗余存，免 JOIN）
    model_name     TEXT NOT NULL,             -- 上游模型名（claude-opus-5）
    prompt_tokens  BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    cached_tokens  BIGINT NOT NULL DEFAULT 0,
    latency_ms     INTEGER,                   -- 首字/总耗时（按现有 real_ttfb 口径）
    http_status    INTEGER,                   -- 上游/网关状态码
    err_class      TEXT,                      -- 错误归类：upstream_4xx|upstream_5xx|balance|timeout|cancel|auth|…
    err_detail     TEXT,                      -- 原样错误摘要（限长）
    cost_micro_usd BIGINT NOT NULL DEFAULT 0, -- 成功时=扣用户的钱（与计费同源）
    cost_cny_micro BIGINT NOT NULL DEFAULT 0, -- 用户实际付的人民币（wallet+quota，20260871 同口径）
    PRIMARY KEY (id)
);
CREATE INDEX ... ON usage_log (created_at DESC);
CREATE INDEX ... ON usage_log (day, route_id, model_name);   -- 线路/模型频次
CREATE INDEX ... ON usage_log (day, api_key_id);
CREATE INDEX ... ON usage_log (user_id, day);
```

**数据从哪来（关键改动）**：在派单链路成功/失败收口处各加一条火后不管的旁路插入：
- 成功：`models.rs` 计费插入点（~6784 / 7695 两条 INSERT）同位置附近，把
  `latency / endpoint / model_name / tokens / user` 多写一份到 usage_log（不计费、不参与事务回滚语义——失败就算了）；
- 失败：`route_health::record_fail`（route_health.rs:140，已有 `status`）与派单"超过 X 秒没回应"
  的停用/超时收口处补写，`err_class` 归类要覆盖文档示例文案：`上游报错 400`、`余额不足 402`、
  `超过20秒没有回应`、`停用`（被动停用 = 线路 active=false 时出口不可用，报错列显示"停用"）。
- 现状 gateway 鉴权只记到 `user_id`（models.rs 4600-4630 一带查 key → user），usage_log 补 `api_key_id`
  需要在鉴权处把 key id 带进请求上下文。**api_keys 表当前与 model_usage 无任何关联列（已核实），
  这是"按 API key 视图"的数据缺口。**

### M5 `20260907_channel_rates_pay.sql` — 充值汇率改为"套餐额度/支付金额"推导

文档：充值汇率最好不要让运维计算，输入套餐额度和支付价格，`套餐额度 / 支付金额(￥) = 充值汇率`。

```sql
ALTER TABLE channel_rates
    ADD COLUMN IF NOT EXISTS package_credit DOUBLE PRECISION,  -- 套餐额度（无单位）
    ADD COLUMN IF NOT EXISTS paid_cny      DOUBLE PRECISION;   -- 支付金额（￥）
```

后端 `admin_save`（relay_rates.rs:304）在两者都填时**服务端计算** `usd_per_cny = package_credit / paid_cny`
再落库（文档原话"不要让运维计算"），并把结果回显；只填其一则维持手填模式并提示。
（现有 `usd_per_cny` 语义 = ¥1 买到多少上游余额单位，与文档公式同向，不需要换单位。）
配套"数据动态同步 bug"：不开新功能的排查任务（§5-4），涉及 `relay_rates` 三处读取点
（load 105 / admin_list 214 / 548 等）与 `ratio-sync` 的预览/写入。

### M6 `20260907_route_credentials.sql` — 号池成员表（A1 已锁，必做）

文档"线路 = 号池"：一条线路（站点）下面多把 key，每把 key 一个备注（=路由名），
同一 base_url 的不同备注禁止重复、同 key 可进不同分组。→ 新表 `route_credentials`
（route_id, api_key_enc, api_key_fp, label, active）或改挂 `route_endpoints`。
**§9-A 已锁 A1，本迁移必做（不再"视拍板"）**；现有 models 行的 api_key 如何搬迁、
`models` 行如何折叠为线路，落 Phase 1 时按 §9-A1 详细设计。

---

## 3. 后端改动清单（按模块）

### 3.1 `src/models.rs`（线路/模型侧，最大的既有文件）
- **分组归属（§9-B 修订）**：分组挂在 route_endpoints（出口）上（见 M2），**models 行不存 group_id**；
  线路列表要展示的分组/组序来自引用它的出口 JOIN model_groups。原"models 增 group_id 读写"方案撤销，
  实施时凡涉分组归属一律落到出口层。
- **线路界面新列**：上次使用时间（从 `model_usage`/`usage_log` 取 `max(created_at)`，从未使用=NULL）、
  使用中模型数量（`enabled_models` 与 endpoint_model_prices.enabled 口径二选一，见 §9-D）、
  计费方式下拉展示（按 token/混合/按次——按"当前线路计费模式"聚合显示）。
- **停用护栏**：`UpdateReq` 已有 `active`（Routing.tsx 注释证实）。新增在 active true→false 时统计
  "将影响 X 个路由中的 Y 个出口"并随响应返回，前端提示（文档原话）。
- **删除护栏**：DELETE 前数被引用路由/出口，>0 返回影响明细（分组名+路由名前 5 条，超出折叠）——
  返回结构 `{ affected: [{ group, route_label }], total }`，前端弹窗；用户确认后**同一事务内同步删除
  引用该线路的全部 route_endpoints**（文档："删除该线路的同时，被引用的路由被同步删除"）。实现点：
  确认 route_endpoints→models 外键（无则迁移加 ON DELETE CASCADE，或服务端先删出口再删线路）。
- **创建/编辑线路弹窗（原稿漏列，二读补全）**：base url；连接协议下拉（Anthropic 原生
  /v1/messages、OpenAI 兼容/chat/completions、xAI Responses/v1/responses —— grok 思考摘要只在这条
  协议给）；**多把 API key（➕逐个添加）+ 每把 key 一个备注 + "测试连接"按钮**（备注=多路由列表的
  "路由名称"，手填或默认取 base_url host，同一 base_url 的不同备注禁止重复）；勾选：Claude强力版
  线路（新布尔，语义见拍板 1）、投入轮转（=active）、关闭缓存计费（关 models 缓存计费开关，
  对应 0014/0021 迁移）。→ 新增 `POST /api/admin/models/test-connection`：用线路协议发最小探测
  （复用 model_probe/prefix_probe 探测逻辑），返回延迟/状态。
- **线路行可展开模型级明细（文档示例复核）**：一行线路下能展开模型行（上游模型名/计费方式/
  上次使用时间）——列表"使用中模型数量 / 计费方式(按token|混合|按次) / 上次使用时间"是聚合展示，
  展开行是模型级口径；后端列表响应带模型明细（enabled 模型 + billing_mode + max(created_at)），
  前端展开渲染。
- **`admin_sort` / models.sort 语义（A1 已锁）**：号池化后"线路间排序"被分组/出口结构取代，
  排序语义需重定义，详细设计落 Phase 1；UI 层面 RouteOrder 屏删除，一键排序入口并入分组屏（按 seq）。
- **官方原价适配数据**：新增 `admin_official_prices`（全量 models 的当前官方价 + model_catalog 快照 +
  对比状态），供新页"拉取模型原价"按钮调用 `model_catalog` 刷新（已有 official_price()/catalog 加载路径）。

### 3.2 新模块 `src/model_groups.rs`（分组 CRUD，约 200 行）
- `GET/POST /api/admin/model-groups`（list/create）
- `PATCH/POST /api/admin/model-groups/:id`（改名/品牌/使用状态/筛选字段/seq 调整）
- `POST /api/admin/model-groups/reorder`（一键排序：接受整组 seq 数组，事务内写）——替代现有
  `/api/admin/models/sort`
- `DELETE /api/admin/model-groups/:id`（护栏：分组下有路由 → 400 + 文案）
- `POST /api/admin/model-groups/:id/move`（↑/↓ 换序）
- 筛选字段规则：数组里每个词不区分大小写匹配模型名/上游名；为空 = 组内不限。

### 3.3 `src/route_endpoints.rs`（多路由/出口侧）
- **上游协议（docx 弹窗四选一，原稿漏列）**：`跟线路一样`（默认，跟随所引线路的连接协议）/ `Anthropic 原生 /v1/messages` /
  `OpenAI 兼容 /chat/completions` / `xAI Responses /v1/responses`（grok 思考摘要只在这条协议上给，同线路弹窗）。
- `Endpoint` 结构加 `group_id`（继承自 route）与备注规则校验；`admin_save`(2693)：
  - 备注默认取 base_url host（已有 host_of 工具在 relay_rates.rs:62，可提共用），
    手填备注与同 base_url 其它备注查重（文档：同一 base_url 不同备注禁止重复）；
  - 拉模型范围 = 分组 filter 内的模型（文档：claude 分组里 API 拉的只能是 claude 相关模型）——
    `admin_available`(3138) 与拉目录逻辑加 `group_id` 过滤；
  - "是否投入轮转"落 `active`。
- **新读写 endpoint_model_prices**：`admin_list`/`admin_save` 带出/写入该出口的 per-model 价格表；
  新增 `POST /api/admin/route-endpoints/:id/pull-models`（拉目录时把中转价/原厂价带下来成初始行）。
- **删除语义核对**（现状已符合文档）：`admin_delete`(3220) 只删出口配置不动线路/模型——
  保持并补测试。
- **排序规则保持**（现状 303-446 `endpoint_score`/可靠性/降级判定已经是一套成熟规则，
  文档"序号由原系统规则判断" = 继续沿用，UI 序号只读）。
- **列表"汇率"列**：展示该出口 host 对应 `channel_rates.usd_per_cny`（￥/$ 格式，如 ￥1/$1、
  ￥1.56/$1），与汇率页同源、写入后即时生效，纯展示列、不需要新字段。
- **备注查重落点修正**："同一 base_url 的不同备注禁止重复"（文档原话，出现在**线路弹窗**）——
  A1 号池下备注属于 key（credential），查重在号池写入处做（见 M6），不在出口层；出口的
  "路由名称"只是把所引 key 的备注带上来显示。

### 3.4 `src/route_health.rs` + 健康查询
- 七天健康度 = `route_attempt`(20260866) 聚合：`(ok)/(ok+fail)` 近 7 天；
  tooltip 明细（请求数/失败数/成功平均延迟）由 `admin_health` 一并返回（需在
  `route_endpoints.rs:admin_health` 2232 处扩展返回体，route_attempt 已按 day 聚合，7 天 SUM 即可）。
- 视图二（站点 × 模型）数据源：`route_attempt` 已有 (day, endpoint_id, model_id) 粒度 → 新增
  `GET /api/admin/route-health/models`（按 base_url × model 展开 + 倍率来自 endpoint_model_prices）。
- 余额列：已有 `?balance=1` 开关（2230 注释），视图一加该列即可。
- 每行加"跳转详情"→ `usage-log?endpoint_id=…&model=…`（见 3.6）。

### 3.5 `src/relay_rates.rs` + `channel_rates`
- 汇率从一级页签挪到"模型线路"二级：路由不变（`/api/admin/relay-rates`），变的是**前端导航层级**；
  但文档要"模型汇率界面……原界面由一级降级到模型内的二级"，并**排查数据动态同步 bug**：
  `load`(105)/`usd_per_cny`(77)/`admin_list`(175)/`admin_save`(304)/`admin_model_prices`(541)/
  `ratio_preview`(1160)/`ratio_apply`(1299) 这条链路单独过一遍：写入后内存表是否真的 reload、
  `relay_adapter` 拉价后是否触发 reload、前端两个接口（站级+模型级）的竞态（RelayRates.tsx:141 注释
  提过"两个接口一起拉"）。**该 bug 是排查任务，不预设结论，落一个复现步骤再修。**

### 3.6 新模块 `src/usage_log.rs`（溯源，核心新模块）
- `GET /api/admin/usage-log`：多维度明细（分页/当前页排序/筛选：时间窗、线路、模型、报错、分组、
  用户、API key）。
  - 视图一（时间）：`时间 | 站点名+base url | 模型 | 用户名 | 输入/输出token | 缓存 | 消耗额度$ | 成本￥ | 延迟 | 错误 | 其他`
  - 视图二（API key）：按 `api_key_id` 聚合 `最后调用时间 | 调用次数 | tokens | 消耗 | 成本 | 平均延迟 | 最后错误`
  - 视图三（分组/模型/用户）：按所选维度聚合，列同上
  - 排序**只对当前页生效**（文档明确）：SQL 层 `OFFSET/LIMIT` 后内存排序，字段白名单防注入。
- `GET /api/admin/usage-log/search`（全表搜索，弹窗）：
  - 主题：模型 / 分组 / 用户 / 告警 / 线路(url/备注)
  - 每个主题返回"统计板块"数据（饼图数值：已用额度/充值额度、已支出成本+线路余额、告警数、
    分组消耗金额/全部支出、某模型在各路由用量/总用量）
- `GET /api/admin/usage-log/stats`：顶部统计板块（分组/线路/路由/模型数量、输入输出 token、
  充值用户数/用户数、用户花费$、支出￥、毛利￥、告警数）——毛利 = 用户花费 - 支出（成本），
  口径对齐 reconcile（20260871 已把"用户实际付的人民币"落库，别再用 channel_rates 折算）。
- 由健康页跳入：`/api/admin/usage-log` 支持 `?endpoint_id=&model=` 预设过滤。

### 3.7 `src/main.rs`（路由注册，209-649 区间）
新增：
```
/api/admin/model-groups            GET/POST/PATCH/DELETE…
/api/admin/model-groups/reorder     POST
/api/admin/route-endpoints/:id/pull-models  POST
/api/admin/route-health/models      GET
/api/admin/usage-log                GET
/api/admin/usage-log/search         GET
/api/admin/usage-log/stats          GET
/api/admin/official-prices          GET/POST(拉取刷新)
```
删除/改：
```
/api/admin/models/sort              → 移到分组 reorder（或保留但只对组内生效）
```
路由注册 + CORS 暴露头名单（main.rs 640 行附近的 `EXPOSED_HEADERS`）若新响应头需补。

### 3.8 采集埋点（3.4/3.6 的前提，最重要的一处代码改动）
派单主链在 `models.rs`（chat/chat_completions/responses_proxy 共用 `bill`/`compute_cost` 计费段）。
在**成功扣费收口**与**失败/停用/超时收口**各放一个 `usage_log` 旁路写入（tokio::spawn、失败静默），
把 `endpoint_id`、`model_name`、tokens、latency、err_class、api_key_id 记下来。**这是整个
"用户使用日志"能不能成立的地基**——没有它，所有筛选都只能查成功且无延迟/错误。改完必须
`cargo test`（现有计费测试会钉住 `model_usage` 插入形状，旁路写不得改动它的列）。

---

## 4. admin-ui 对应改动（页面级，UI 细节以文档为准）

| 页面 | 动作 |
|---|---|
| `components/Shell.tsx` | "模型线路"组内：删"排序"子页；"模型汇率"从一级叶签移进组内（或作为模型线路下一级）；新增"用户使用日志"、"官方原价适配"入口；NavKey 类型同步 |
| `App.tsx` | `ROUTING_OWN_SCREENS` 增删对应 view；RoutingView 联合类型同步（Routing.tsx:274） |
| `pages/Routing.tsx`（线路） | 按文档 §线路界面 重做表单：标题区按钮 **刷新 / 新建连接**（docx 示例原文）；行=序号/站点名+base_url/使用状态/模型数量/计费方式/上次使用时间/按钮列；停用提示影响 X 路由 Y 出口；删除弹窗列受影响路由明细 |
| `pages/Routing.tsx`（分组，替换现有 Groups） | 全新建：统计区块 + 表单（序号/名称/品牌下拉/使用状态/筛选字段/模型数量/↑↓/一键排序）；删除护栏文案 |
| `pages/RouteEndpoints.tsx`（多路由，1550 行改造） | 顶部统计 5 项；按分组分段；行内：倍率/汇率/报错/延迟(红黄绿)/七天健康度(tooltip)/测试/编辑/删除；创建弹窗：左（中转地址下拉/协议/备注/投入轮转）+ 右（模型总览/拉取模型 + per-model 表格，接口 3.3） |
| `pages/RouteHealth.tsx` | 两种视图切换；警告状态红黄绿；余额/最后探测结果列；视图二行跳"使用详情" |
| `pages/RelayRates.tsx` + `RatioSync.tsx` | 汇率挪层级；加套餐额度/支付金额输入（后端算汇率并回显）；修复同步 bug 后走查 |
| `pages/RouteOrder.tsx` | 删除（排序并入分组） |
| **新 `pages/UsageLog.tsx`** | 用户使用日志大屏：统计板块、三视图切换、筛选条、当前页排序、分页、搜索弹窗（按主题 + 饼图） |
| **新 `pages/OfficialPrices.tsx`** | 官方原价统一适配：统计（启用/有原价/无原价）+ 全模型表 + 拉取按钮 + 保存 |
| `pages/Reconcile.tsx` / `Adapters.tsx` / `Pricing.tsx` | 如需随上述字段改动联调 |

---

## 5. 执行顺序与验证（每个 Phase 的验收标准）

进度细节与提交哈希见文首「实施进度」。下面验收标准不改，只标当前状态。

- **Phase 0 拍板（先做，不写码）** ✅：A（号池）二读已锁 **A1**；剩余拍板见 §10 拍板 1–4（Claude强力版
  语义 / 出口能否属多组 / 出口价格进不进账单 / 行级倍率口径）。拍完再动 Phase 1。
- **Phase 1 迁移** ✅：M1–M6（M6 随 A1 必做）。跑 `cargo test`（sqlx 迁移测试若钉了旧表会立刻红，先改测试预期）。
- **Phase 2 后端采集与实体** ◐ 前半已合入，后半未做：usage_log 埋点 + model_groups 模块 + models/route_endpoints 归属与护栏。
  验证：`cargo check` + `cargo test`（本项目测试很重，注释风格看，改 models.rs 必跑全量）；护栏手动
  （建组→加路由→删组应 400）。
- **Phase 3 查询 API** ☐：健康两视图 / usage-log 三视图+搜索 / official-prices / 汇率计算与同步排查。
  验证：起服务（run_in_terminal）用真实库各点一发请求核对列；汇率同步 bug 走复现步骤。
- **Phase 4 admin-ui** ☐：按 §4 逐屏，每屏 `npm run build`（admin-ui）过 typecheck。注意现有
  admin-ui 有 262 个存量 TS 报错（含 `Routing.tsx` 等文件的历史问题），**只认新增的，先修自己引入的**。
- **Phase 5 收口** ☐：全链路走查（建分组→建线路号池→拉模型→多路由→发真请求→健康→日志溯源）；
  IDE 侧模型表单确认分组/图标/顺序生效（文档反复强调"IDE 中展示"）；按 AGENTS.md 提交流程走
  gao-dev → PR。

---

## 6. 风险与注意（都是本项目注释里真实踩过的）

1. **别拿计费路径冒险**（20260851/20260854/20260857 注释反复强调）：usage_log 是观测，
   写失败必须静默；绝不进结算事务、不加会阻止删除的外键。
2. **model_usage 删除语义**：`model_id` 带 ON DELETE SET NULL，删线路会丢历史归属——
   用户日志/对账要按"出口/线路名"留冗余快照（usage_log 存 route_id/endpoint_id 不带外键）。
3. **UI 一个萝卜一个坑**：App.tsx 的 `ROUTING_OWN_SCREENS` 注释就是教训——加屏必须同步排除名单，
   否则两屏叠渲染。
4. **后端所有读取点别只改一半**：`relay_rates` 对 `channel_rates` 有三处读（load/列表/逐模型比价），
   加套餐额度字段要三处一起过，防止"填了但不生效"（文档说的同步 bug 很可能就是这类）。
5. **IDE 端消费**：`/api/models`（list_for_client）与 `model_groups` 的顺序/图标/筛选要在 IDE 模型表单
   可见——后端返回结构里 group 信息不能只给 admin 屏，客户端那份也要带（models.rs:2990 一带的
   client 响应加 group 字段），这是"管理员创建分组并展示在 IDE"的唯一通道。

---

## 7. 工作量拆解（粗）

| 块 | 后端 | admin-ui | 独立可交付 |
|---|---|---|---|
| M1–M6 迁移 + 测试修正 | 1.5 | 0 | ✅ 可先合 |
| 分组实体与护栏 | 0.5–1 天 | 0.5 天 | ✅ |
| 线路号池/停删护栏（§9-A 已锁 A1） | 1–2 天 | 1 天 | ✅ |
| 出口 per-model 价格 + 拉模型 | 1 天 | 1 天 | ✅ |
| usage_log 埋点 | 0.5–1 天 | 0 | ✅ 先于 UI |
| usage-log 三视图/搜索 API | 1–1.5 天 | 1.5–2 天 | ✅ |
| 健康两视图 + 汇率降级/计算 + 原价页 | 1 天 | 1 天 | ✅ |
| 收口走查 + IDE 联调 | 0.5 天 | 0.5 天 | — |

---

## 8. 事实缺口（已核实部分 + 仍待实施时精读的）

**2026-09-07 已核实（写进计划时可当结论用）：**

- ✅ `model_usage.model_name` = **上游模型名**（`tokens.model_name`，INSERT models.rs:7695 一带绑的就是
  它）；且 `model_id` 走子查询（线路删了取 NULL 而不是撞外键）、`model_name` 是 NOT NULL 独立列。
  → usage_log 按 `model_name` 文本聚合即可，**不要**依赖 `model_id` 外键——删线路后历史照查。
- ✅ `endpoint_model_usage.model_id` 注释明说也是模型名文本（`claude-opus-5` 这种）——三张观测表
  口径一致，按模型聚合无歧义。
- ✅ `route_endpoints.admin_health`(2232) 返回 `rows` 已含：`calls_today`、`calls_7d`、`balance`
  （`?balance=1` 时）、`probe_ms`、`last_ok_secs_ago`、余额比对状态。→ 健康页视图一大部分列现成，
  **缺的是**：7 天 ok/fail 拆分（tooltip 用，`route_attempt` 有按天粒度可 SUM）、警告状态红黄绿判定、
  视图二按 站点×模型 展开（需新聚合或新端点 3.4）。
- ✅ `channel_rates` 现列：`name / usd_per_cny / note / host`（host 唯一索引，20260863 加的）；
  `relay_rates.rs` 对它有**三处**读取（107 / 214 / 548）——加套餐额度/支付金额列时三处一起过，
  防"填了不生效"（文档说的同步 bug 大概率就是这类只改一半）。
- ✅ `api_keys` 表与 `model_usage` **没有任何关联列**（已 grep 全部迁移）——"按 API key 视图"
  必须新加采集：鉴权处把 `api_key_id` 带进请求上下文（gateway 鉴权在 models.rs ~4600-4630，
  现已能查到 key → user）。

**仍待实施时精读（不阻塞计划）：**

- `model_catalog` 与 `models` 的关联键（按 model_id 文本匹配？20260838 建表）——原价页
  "模型移除时这里也要移除"的联动删钩子挂哪，落 Phase 3 时看建表迁移与 `official_price()` 读法定。
- 派单失败/超时收口的确切函数位置（route_health::record_fail 已有 status，但"超过 X 秒没回应"的
  超时收口在 models.rs 哪几处）——落 Phase 2 埋点时按调用栈精确定位。

---

## 9. 语义决策点（Phase 0 拍板）

### A. "线路"拆不拆号池 —— 文档已锁 A1，按 A1 执行（原"请拍板"撤销）
- **现状**：`models` 行 = base_url + api_key + 模型集（一个站点配多 key = 多行）。
- **文档**：线路界面示例里一个站点名只占一行、下面折叠模型；创建线路弹窗支持一个 base_url 配
  多个 key（➕逐个添加、每把 key 一个备注）组号池；多路由"同一分组多个 key 同 base_url"、
  "不同分组同 key 同 base_url"。
- 方案 A1（采纳）：线路(站点+连接协议) 与 密钥/备注 拆开——每把 key 一行进号池表
  （备注随 key，同 base_url 不同备注禁止重复）；线路是纯存储地：不挂分组、不挂价格，
  被 route_endpoints 引用。
- 方案 A2（否决）：一行一 key、"号池"只做 UI 折叠——唯一索引会拦"不同分组同 key 同 base_url"
  （文档原话），创建线路弹窗"多 key + 多备注"也表达不了，只能放开唯一索引硬凑，埋数据脏。
- **结论**：A1。二读 docx 后从"请拍板"改为直接执行。

### B. 分组挂在哪一层 —— 复核修正为「出口直接挂 group_id」（原"挂 models"推荐撤销）
文档证据指向**出口（route_endpoints）直接挂分组**，不是挂在 models（线路）：
- 删除分组护栏 = 查"该分组下是否有**路由**"（文档原话，路由=出口配置）；
- 多路由界面**按分组分段**、每段小标题右侧是"添加新路由"按钮 → 出口在选定分组下创建；
- 线路界面全程不出现分组（线路只是号池存储地，被出口引用）。
A1 号池化后：出口 = 引用「线路 + 该线路某把 key(备注)」+ 所属分组 + per-model 配置。
"同组多 key 同 base_url" = 组内多个出口；"同 key 跨分组" = 两个分组各建一个出口引用同一把 key。
- 原"分组挂 models、出口经 route_id 继承"改动面小，但与上面四条文档证据冲突，撤销。
- **待拍板（拍板 2）**：一个出口能否同时归属多个分组？默认**一对一**。

### C. 出口级倍率/中转价进不进用户账单
默认**不进**（只做排序/展示/对账），保持 20260851"换出口换不动账单"。若要做"不同出口对同一模型
不同卖价"，那是计费重构，单独立项。**请确认默认即可。**

### D. "使用中模型数量"口径
分组表里=该分组下所有线路 enabled 模型去重数；线路行里=该线路 enabled_models 数还是
endpoint_model_prices.enabled 数。默认：**行内=线路 enabled_models 长度；组内=去重并集**。

---

---

## 10. docx 二读复核（2026-09-07）—— 修订点与待拍板

二读 docx 全文后，对 §9 做了三处修订：A 锁 A1（号池）、B 改为出口直接挂分组、M1 删除护栏改查出口。
另补以下确认：

1. **线路=纯号池存储地**：线路行不出现分组、不直接持价格——"使用中模型数量 / 计费方式 /
   上次使用时间"都是从引用它的出口/模型**聚合**而来（示例行下还能展开模型级明细行），见 §3.1。
2. **多路由"报错信息"列**要能呈现文档示例全部文案：`停用`（所属线路停用→出口被动不可用，
   配置保留）、`上游报错 400`、`余额不足（402）`、`超过20秒没有回应`、健康列 `无真实流量`
   （有健康度但当日 0 调用的 UI 展示态，不落库）——展示映射来自 usage_log.err_class（M4）。
3. **健康页顶部按钮补 "测试告警邮件"**：Phase 3 加 `POST /api/admin/health/test-alert`
   （复用 email.rs 发一封测试告警邮件），原稿漏列。
4. **用户日志视图一**：`备注`列=所引 key 的备注（即多路由"路由名称"），站点名+base url 作副行
   （示例两行式）；"其他"列=前端展开（请求详情），后端不建字段。
5. **多路由"汇率"列**=host 的 usd_per_cny 展示，见 §3.3 补条。
6. **统计区块项数按页不同（示例复核）**：多路由页=5 项（上游数量/总出口数量/正在活动数量/异常数量/
   未测试数量）；线路页、健康页=4 项（无"未测试"）。上游数量=不重复 base_url 数；总出口数量=各分组
   出口总和（文档示例"五个上游×五种模型=25 个连接"即视图二的 25 行）。

### 拍板 1：Claude强力版线路 勾选语义

文档只在线路弹窗出现、未说明作用。默认按**布尔标记**落字段（列表/详情展示），不改路由与计费行为；
若实际影响协议选择或计费，请说明，否则实施时只做标记字段。

### 拍板 2：出口能否同时归属多个分组（承 §9-B）

默认**一对一**：同 key 同 base_url 要进另一组 = 再建一个出口引用同一把 key（A1 下 key 已独立，
天然支持）。不做多对多，否则删除分组护栏（"该分组下是否有路由"）语义要重定义。

### 拍板 3：出口级倍率/每次收费 进不进用户账单（重申 §9-C）

文档没说"不同出口不同卖价进用户账单"；出口弹窗的价格只参与排序/健康/对账/拉模型预填，
用户实际扣费仍走 models 计费链（线路行的"计费方式(按token|混合|按次)"才是账单口径）。维持默认，
理解有误请指出。

### 拍板 4：多路由列表"行级倍率"显示口径

出口下每个模型各有倍率（1.0x/8.0x/5$/次…），列表行只显示一个"倍率"。默认：**显示该出口的
渠道级倍率**（保留 route_endpoints.cost_ratio 作"跟随渠道"基准与列表展示；模型级
endpoint_model_prices.rate 在"按照token"时覆盖它）。若你想显示主模型/首个启用模型的倍率，请说明。

*本文档落地：`server/docs/2026-09-07-routing-rework-plan.md`。拍板 1-4 后按 Phase 实施，
每个 Phase 一个 gao-dev 提交 + PR。*

---

## 11. docx ↔ md 逐项核对记录（2026-09-07 二轮，用户要求验证准确度）

> 本轮把《新建DOCX 文档.docx》（508 行全文）与本文档逐段比对。结论：**八个界面需求全覆盖，
> 无重大错转述、无张冠李戴**。md 中超出 docx 的推演（A1 号池、出口挂分组、usage_log 新表、
> 计费红线）都在正文显式标注了依据与“待拍板”，没有把设计伪装成文档原话。
> 发现的差异共 5 处，均已按 docx 为准处置：

| # | 位置 | docx 原文要点 | md 原表述 | 差异判定 | 处置 |
|---|---|---|---|---|---|
| 1 | 多路由 B 弹窗·上游协议 | 下拉四选：**跟线路一样** / Anthropic 原生 /v1/messages / OpenAI 兼容 /chat/completions / xAI Responses /v1/responses（grok 思考摘要只在这条给） | §3.1/§3.3 只列三种具体协议 | md 漏了“跟线路一样”（出口默认继承所引线路协议） | §3.3 已补（见上） |
| 2 | 线路 A 主界面 | 标题区按钮 **刷新 / 新建连接**（docx 示例原文） | §4 未列刷新按钮 | 遗漏（UI 细节） | §4 已补（见上） |
| 3 | 用户日志·视图一“备注”列 | docx 原文：`备注（由创建线路时的备注（手动填写或者站点名/通过 base url 自动填充）获得）` | §10.4：备注列=所引 key 的备注（即多路由“路由名称”） | 措辞差异但**语义一致**：docx 线路弹窗明说“弹窗里的备注就是多路由列表中的路由名称”；A1 号池化后备注随 key 存，日志行的备注即该次调用出口所引 key 的备注 | §10.4 维持，本条存档备查 |
| 4 | 用户日志·视图二“API key”列 | 示例显示为脱敏 `Sk-******naocd` | 未提显示形式 | 遗漏（UI：key 必须脱敏展示；后端本就不存明文，有 FIELD_ENCRYPTION 加密存储） | 实施 Phase 4 时视图二按脱敏尾显渲染，本条存档 |
| 5 | M3 倍率约束 | docx 原文：`倍率不可为0，除非是完全免费` | 原 CHECK 注释绕（既写 rate=0 OR rate>0 又写 rate<>0） | 表述自相矛盾，易误实施 | M3 已改为：`CHECK (rate >= 0)`，免费模式才允许 0，非免费 rate=0 拒绝 400 |

**核对方式**：两份文件均为本轮全文读取（docx 508 行 / md 491 行），逐界面、逐列、逐弹窗字段比对；
上表只列差异项，未列出的条目即判定 md 转述与 docx 一致（含 md 显式标注的合理工程设计延伸）。
