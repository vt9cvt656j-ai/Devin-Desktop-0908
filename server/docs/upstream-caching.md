# Anthropic 原生协议与提示缓存 —— 现在是怎么跑通的

> 最后一次核对：2026-09-03。这份文档描述的是**当前线上的真实形状**，不是计划。
> 上一版写着「网关原样转发请求体、不能把 base_url 指向 Anthropic 原生端点」——
> 那是网关还没有协议翻译层时候的事，已经不成立了。改这份文档的人请一并核对代码。

## 一、形状

```
桌面端 / 网页端
   │  发的是 OpenAI 形状（/v1/chat/completions 的 body）
   ▼
网关  ── 按这条线路的 protocol 字段分叉（Wire::of）
   ├─ "anthropic"      → oai_to_anthropic_with_cache()  → POST {base}/v1/messages
   ├─ "openai"         → 原样                            → POST {base}/v1/chat/completions
   └─ "xai_responses"  → oai_to_xai_responses()          → POST {base}/v1/responses
   │
   ▼  回执再翻回 OpenAI 形状（anthropic_to_oai / AnthSse），客户端只认识一种形状
```

**后台只要把线路的「协议」选成 anthropic 就够了**，不需要别的开关，也不需要自建
LiteLLM 之类的兼容代理。当前四条 anthropic 线路：

| 线路 | 主机 |
|---|---|
| 福利2.5折扣 | `api.teamorouter.com` |
| 福利2.2折扣 | `api.teamorouter.cn` |
| Claude | `api.hao.ai` |
| Claude 强力版 | `polly.modelbridge.cc` |

出站请求头是原生的：`x-api-key` + `anthropic-version: 2023-06-01` + 一组
`anthropic-beta`（照 Claude Code v2.1.153 的集合挑的，三方线路只发其中 7 项 ——
多发一项有被中转 503 的风险，一批中转正是靠这个指纹认 Claude Code 流量）。

> ⚠️ **中转商自己的文档也要求 Claude 走原生协议。** teamorouter 的接入文档原话：
> 用 OpenAI 兼容格式调 Claude 会导致 prompt cache、thinking 等能力丧失。
> 所以「网关里还有哪条路在拿 Claude 打 /chat/completions」是个必须持续盯的问题，
> 见下面第五节。

## 二、缓存断点打在哪，为什么

Anthropic 的请求序列是 `tools → system → messages`，缓存认**严格前缀**：
某个位置的字节变了，它后面的一切全部作废、按写入价重新写一遍。
硬上限是 **4 个显式断点**（第 5 个会 400）。四个都用满了：

| # | 位置 | 为什么在这 |
|---|---|---|
| 1 | tools 数组的最后一个工具 | 工具表在最前面且几乎不变，一个断点把整张表缓存住 |
| 2 | system 的**第一块**（网关的 L0 Prompt Graph） | 整条提示词里最稳定的字节，单独成一个嵌套前缀，后面的 Skill/system 块变化时不作废它 |
| 3 | system 的**最后一块** | 客户端拼的用户规则 / 授权框架 / 语言偏好 / 工具直觉表，一段对话里基本不变，通常几千 token |
| 4 | 最后一个 `tool_result` **块** | 工具结果是 append-only 的稳定履历。**钉在块上不是钉在消息上**——那条消息后面可能还跟着每轮都变的内容 |

多打一个嵌套断点**不额外收费**：整条前缀只按最长的那次写一遍，多一个断点只是多一个
能命中的位置。所以「用满 4 个」是纯赚。

**顶层绝不能出现 `cache_control` 字段**——那是「自动缓存」的开关，4 个显式断点
再加上它就是 400。测试 `cache_breakpoints_ask_for_the_one_hour_ttl` 钉着这条。

## 三、1 小时 TTL

默认对**所有** anthropic 线路开启，发的是 `cache_control: {"type":"ephemeral","ttl":"1h"}`。

- **不需要任何 beta 头。** `ttl` 现在是 GA 的（官方 prompt-caching 文档，2026-09 核对）。
  上一版代码把「发 ttl」和「发 `extended-cache-ttl-2025-04-11` 这个 beta」绑在一起，
  于是三方线路一个都拿不到 —— 现在两者彻底解耦，三方的请求指纹一个字节不变。
- **价目**：5 分钟写入 = 输入价 × 1.25，1 小时写入 = × 2.0，读回 = × 0.1
  （Fable 5.1 / Mythos 5.1 是 × 0.025）。
- **为什么值**：10 轮对话、每轮 7.5 万 token 前缀 ——
  5 分钟档每轮重写 = 10 × 7.5万 × 1.25 = **93.75 万**等效输入；
  1 小时档 = 7.5万 × 2.0 + 9 × 7.5万 × 0.1 = **21.75 万**。**便宜 4.3 倍。**
- **计费跟着分档走**：按上游回执里的 `usage.cache_creation.ephemeral_1h_input_tokens`
  单独按 2× 收。中转要是把 `ttl` 剥掉再转发，这个字段就是 0，自动退回 5 分钟档 ——
  既不会多收，也不会把一条本来划算的线路误判成亏本。

## 四、开关（都不用重新部署，改完重启容器即可）

| 环境变量 | 作用 |
|---|---|
| `MICHAEL_CACHE_TTL_1H=0` | 关掉 1 小时 TTL，退回 5 分钟 |
| `MICHAEL_PROMPT_CACHE=0` | 整个提示缓存关掉（连断点都不注入） |
| `MICHAEL_CACHE_TTL_HOSTS=a.com,b.com` | **非空**时只给名单内的主机发 ttl；空 = 全给（现状） |

还有一道**自动**闸：`cache_payoff.rs` 按每条线路自己的执行事实判「写进去读得回来吗」。
判据是算术不是厂商名单 —— `读取量 × 0.9 ≥ 5分钟写入 × 0.25 + 1小时写入 × 1.0`。
样本不足（< 20 万写入 token）一律放行，计数每 30 分钟半衰，所以关掉之后会自动重试。
**只影响写入，不影响读取**：关掉之后请求里不再带断点，但上游若仍有可用前缀照样命中。

## 五、以前为什么不生效 —— 五个独立成因

这一节是这份文档的核心。缓存「配好了却没用」不是一个原因，是五个叠在一起，
每一个单独看都不像 bug：

1. **检索回注块被搬到了最前面。** 上下文压缩把检索到的历史写成一条 `system` 消息、
   放在会话**尾部**（那个位置是照着实测数据挑的：排在前面时缓存量恒定在 24k~42k、
   不随请求增长）。但翻译按 role 匹配，所有 `system` 一律提到顶层 —— 而顶层排在
   **所有消息之前**。它每一步内容都变，于是每一轮整个前缀作废。
   → 现在：会话中途的 `system` 就地变成 `user` 轮，位置一寸不动。

2. **4 个断点只用了 3 个，还都打偏了。** 见第二节。

3. **1 小时 TTL 一条线路都没发出去。** 白名单环境变量线上是空的。见第三节。

4. **模型目录抖一下就把思考档位改掉。** 官方失效表：改 `output_config.effort`
   **总是作废整个 messages 缓存**。而目录每 6 小时是**整表替换**，某一轮上游没返回
   这个模型，档位就从 `max` 掉成 `high` —— 一次外部抖动 = 所有进行中长对话的前缀
   全部重写。
   → 现在：`supports_effort` 只记正面答案，「这一轮没查到」不等于「不支持」。

5. **思考签名只回放最后一轮。** 「最后一轮」的位置每轮往后移，同一条助手消息的字节
   在两次请求之间就变了。
   → 现在：每条助手消息都带自己的思考块，字节恒定。

## 六、思考签名的跨轮回传

上游回的助手轮里，`thinking` 块带一个 `signature`。此前整条链一个字都没保住：
非流式转换只取思考文字，流式的 `signature_delta` 事件落到 `_ => {}` 被静默丢弃，
下一轮重建助手消息时只生成 `text` + `tool_use`。后果是**模型每调一次工具，
就看不见自己上一轮的推理**。

现在：网关逐块配好对后以 `reasoning_blocks` 发给客户端（不透明数据），客户端原样存、
原样回传，下一轮还原成 `thinking` 块放在助手消息**最前面**（Anthropic 对块序有要求）。

四道必要条件，缺一条就静默跳过（退回今天的行为，安全）：
这一轮真的开了思考 / 模型逐字相同（签名绑模型，跨模型必 400）/ 签名非空 / 思考文字非空。

**自定义端点上整个剥掉**：签名是我们这条线路的上游签的，别家验不了，还可能被严格
校验消息字段的端点判 400。

## 七、出站形状闸

`wire_shape::normalize` 保证发出去的永远是一份合法的 Anthropic 对话：

- **孤儿 `tool_result` 整块丢掉**（它前面没有同 id 的 `tool_use` → 硬 400）
- **开头不是 `user` 就补一条**字节恒定的过渡语（→ 硬 400）

为什么修在这里而不是修上游的切点：有**三处**会在不看这两条约束的情况下裁掉历史开头
（客户端按覆盖前缀省略、压缩按 token 数贪心切段、写回时再切一次），修好一个不代表
另外两个不会再切。这里是所有路径的必经之处。

## 八、验证

```sql
-- Claude 线路的缓存读写比。> 1 才说明写进去的读得回来。
SELECT model_name,
       count(*) AS calls,
       sum(cached_tokens) AS cache_read,
       sum(cache_creation_tokens) AS cache_write,
       round(sum(cached_tokens)::numeric
             / NULLIF(sum(cache_creation_tokens),0), 2) AS read_per_write
FROM model_usage
WHERE created_at > now() - interval '24 hours'
  AND model_name ILIKE '%claude%'
  AND cache_creation_tokens > 0
GROUP BY 1
HAVING sum(cache_creation_tokens) > 100000
ORDER BY cache_write DESC;
```

2026-09-03 部署前的基线（24 小时）：

| 模型 | 读/写 |
|---|---|
| claude-fable-5-1 | 2.71 ✅ |
| claude-opus-5 | 0.77 ❌ 写得比读得多 |
| claude-opus-4-8 | 0.25 ❌ 写四份读回一份 |

后两个正是「5 分钟就过期、整条前缀每轮重写一遍」的形状。1 小时 TTL 之后这两个数应该
显著上去 —— **要有真实流量才量得出来**。

## 九、部署

```bash
cd server
SERVER_HOST=154.44.13.133 SERVER_KEY=~/.ssh/michael_server \
  CONFIRM_SOURCE_CHANGE=1 ./deploy.sh
```

- **`SERVER_KEY` 必填**。不带的话 ssh 会用默认 id_rsa，被服务器拒，报 publickey ——
  看着像密钥失效。
- `CONFIRM_SOURCE_CHANGE=1` 是「这次部署的源码目录和上次不是同一个」的确认闸。
  脚本会把来源写进服务器上的 `/opt/michael-ide-deploy/server/DEPLOYED_FROM`
  （路径、commit、分支、脏文件数、部署时间），**排查线上行为对不上时先读它**。
- 脚本无人值守跑完并退出 0：预备份 → rsync → 构建镜像 → 蓝绿切换（8080 ⇄ 8090）
  → 健康探测 → nginx reload → 排空旧端口。
- **脚本只发后端。** 前端（`/console`、网页版 IDE）是手工发布的静态站，它不碰。
- 部署前先看 `git status`：这棵树上常有别的会话未提交的改动，部署会一并带走。

### 部署后核实

```bash
ssh -i ~/.ssh/michael_server root@154.44.13.133 \
  'cd /opt/michael-ide-deploy/server; cat DEPLOYED_FROM;
   curl -s http://127.0.0.1:8090/health;
   docker ps --format "{{.Names}} {{.Status}}"'
```

注意端口是 **8090 或 8080**（蓝绿，看当前切到哪边），健康路径是 `/health` 不是
`/api/health`，容器名带 `green`/`blue` 后缀。

## 十、还没做的

- **中途 `system` → `user` 只在 Anthropic 这条路上做了。** OpenAI 那条仍然把它当普通
  消息发在原位（本来就没有「提到顶层」的问题），但那条路的缓存前缀稳定性没有单独审过。
- **压缩切段仍然不看工具配对。** 出站形状闸兜住了「不会 400」，但切在
  `assistant(tool_calls)` 和它的结果之间时，那次工具调用的上下文对模型来说仍然是断的。
  真正的修法是让摘要作为 `user` 轮注入（原生做法），而不是 `system` 块。
- **`cache_creation` 的分档不落库。** 计价用得到，但事后想按 TTL 分档对账查不出来。
