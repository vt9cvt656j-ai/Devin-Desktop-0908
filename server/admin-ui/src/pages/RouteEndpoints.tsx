import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Turtle,
  ListChecks,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Timer,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { TableSkeleton } from "@/components/TableSkeleton";
import { VendorMark, vendorName } from "@/components/VendorMark";
import { SectionReveal } from "@/components/motion/section-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Truncate } from "@/components/ui/table";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import { cn, dedupeModels, hasModel, sameModel } from "@/lib/utils";

/**
 * 多路由 —— 一条线路挂多个上游出口。
 *
 * # 这一屏的主角是「顺序」，所以按顺序排，不按表格排
 *
 * 加出口这件事本身只有三个输入（地址、密钥、进价倍率），不值得一整屏。真正需要看见的是
 * **同一条线路下这几个出口谁先被用**，因为那是这个功能的全部意义：便宜的先用、坏的靠后。
 * 做成一张平表（每行一个出口、有个"优先级"列）就要读着数字在脑子里重排一遍；
 * 直接按生效顺序竖着列，第一眼就是答案。
 *
 * # 挂多少个就能用多少个
 *
 * 以前网关一个请求最多换**两个**出口就收手，于是挂十个不等于十次机会 —— 第三个往后
 * 基本躺着。那道闸已经拆了：现在的闸是**时间**（客户端自己的耐心算出来的预算），
 * 而换线只发生在上游明确回了错误的时候，那类失败两三百毫秒就回来。十个这样的失败
 * 加起来还不到三秒，所以次数根本不是瓶颈，时间才是。
 *
 * 因此这一屏不再画「前两个」那条线。要画的是**顺序**本身：谁先被敲门。
 *
 * # 密钥只写不读
 *
 * 服务端只回「有没有配密钥」，不回密钥本身，后台页面也不例外。所以编辑时密钥框是空的，
 * 空着保存 = 沿用原值。这不是省事，是不想让一份明文密钥多在一个地方出现。
 */

type Endpoint = {
  id: string;
  route_id: string;
  label: string;
  base_url: string;
  has_key: boolean;
  cost_ratio: number;
  /** 换算成「每一美元官方价花多少人民币」。null = 这家站没填充值汇率。 */
  cost_cny: number | null;
  active: boolean;
  note: string;
  probe_ok: boolean | null;
  probe_at: string | null;
  probe_ms: number | null;
  /** 最近 7 天真实成绩，和探测是两个来源。探测会说假话，这个不会。 */
  real_ok: number;
  real_fail: number;
  real_ms: number | null;
  real_n: number;
  /** **派单窗口**的成败数（今天，样本不够退回 7 天）。排序读的是这两个，
   *  不是上面那两个 7 天的成绩单 —— 两个窗口不一样，混用会让这一屏画错顺序。 */
  rate_ok: number;
  rate_bad: number;
  last_ok_at: string | null;
  last_fail_at: string | null;
  probe_note: string;
  enabled_models: string[];
  protocol: string;
  capacity: number | null;
  sched: string;
  retry_in: number | null;
  live: string;
};

type Route = {
  id: string;
  label: string;
  protocol: string;
  vendor: string;
  base_url: string;
  /** 线路自带地址换算后的每美元官价人民币成本（倍率按 1.0 算）。null = 没填汇率。 */
  own_cost_cny: number | null;
  active: boolean;
  model_count: number;
  /** 这条线路**自己**开放的模型。 */
  models: string[];
  /** 派单真正拿来匹配的那一份：线路自己的 ∪ 各活跃出口 enabled_models 的并集。
   *  模型选择器必须用这一份 —— 「只由出口带进来」的模型不在 models 里，而它们恰恰
   *  是最容易排错的（服务端 expand() 会按模型把不承载它的出口整个 continue 掉）。 */
  effective_models: string[];
  /** 线路自带地址的成败（派单窗口口径）。此前前端只能硬写 0/0，于是它在屏上永远算靠谱。 */
  own_rate_ok: number;
  own_rate_bad: number;
  billing_mode: string;
  rate: number;
  cache_disabled: boolean;
  model_prices: Record<string, { in?: number; out?: number }>;
  model_names: Record<string, string>;
  /** 每个模型此刻的目录现价（每百万 token 美元）。留空的价格框按它收。 */
  catalog_prices?: Record<string, { in: number; out: number; cache_read?: number | null; cache_write?: number | null }>;
  cny_per_usd?: number;
  /** 这条线路的价在后台按哪种货币录。价本身永远是美元每百万 token。 */
  price_currency?: "usd" | "cny";
  sched: string;
  retry_in: number | null;
  live: string;
  endpoints: Endpoint[];
};

type Draft = {
  id?: string;
  route_id: string;
  label: string;
  base_url: string;
  api_key: string;
  /// 这条**线路**的报价币种（不是出口的）。在这个弹窗里改，保存时和价格一起提交。
  /// 放进 draft 而不是直接改 routes：切换币种要连着把几个价格框里的数换算过去，
  /// 那是一次编辑动作，取消弹窗就该整体作废。
  price_currency: Currency;
  cost_ratio: string;
  note: string;
  /// 空 = 跟线路一样。
  protocol: string;
  active: boolean;
  /// 空数组 = 承载线路的全部模型。
  enabled_models: string[];
  /// 空串 = 不填。
  capacity: string;
  /// 就地编辑的单模型定价。**存到线路上**，同一条线路的几个出口共用一份 ——
  /// 每个出口各存一份价的话，用户被扣多少钱就要看当时哪家先答。
  prices: Record<string, { in: string; out: string }>;
  names: Record<string, string>;
};

/**
 * 和服务端 `route_endpoints.rs` 的常量逐字对齐 —— 改那边必须改这里。
 * 这一屏是按同一套判据**重算**顺序的（为了在保存之前就能看到「改成 0.3 倍会排第几」），
 * 两边一旦分叉，这一屏显示的顺序就不是真正会发生的顺序。
 */
const PROBE_FRESH_SECS = 2 * 60 * 60;
const SLOW_FACTOR = 3;
const SLOW_FLOOR_MS = 5000;

/**
 * 可用性档。和服务端 `availability_tier` 同一套判据。
 *
 * **真实流量的结果盖过探测的结论。** 探测是合成的：拿一个模型发一句话，20 秒不回
 * 就判死。可 20 秒超时和「这个出口打不通」是两件事 —— 线上「梦幻API」三个出口探测
 * 全部 20001ms 判死，同一天接了 241 次真实请求全成功，而它们正是最便宜的几个。
 * 所以有新鲜的真实结果就按真实结果排；两边都有就听较晚的那个。真实失败同样算数，
 * 只认成功的话出口一失败就再也拿不到流量、也就永远翻不了身。
 *
 * 「测通了，但那是三天前的事」算没证据，不算测通 —— 陈旧的好消息不是好消息。
 * 没记时间的老行按新鲜处理，否则升级那一刻所有出口一起降档。
 */
function tier(e: Pick<Endpoint, "probe_ok" | "probe_at" | "last_ok_at" | "last_fail_at">, now: number): number {
  const freshReal = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || now - t > PROBE_FRESH_SECS * 1000) return null;
    return t;
  };
  const ok = freshReal(e.last_ok_at);
  const fail = freshReal(e.last_fail_at);
  if (ok != null && fail != null) return ok >= fail ? 0 : 2;
  if (ok != null) return 0;
  if (fail != null) return 2;

  if (e.probe_ok === false) return 2;
  if (e.probe_ok === null) return 1;
  if (!e.probe_at) return 0;
  const t = Date.parse(e.probe_at);
  if (!Number.isFinite(t)) return 0;
  return now - t <= PROBE_FRESH_SECS * 1000 ? 0 : 1;
}

/**
 * 判「慢不慢」拿哪个耗时。和服务端 `effective_ms` 同一套判据：**有真实流量就用真实的。**
 *
 * 探测只发一句 hi、只用一个模型、一轮一个样本；真实流量量的是用户实际等的那一段。
 * 线上这两个数差得很远（Grok 那个 0.005 倍的出口：探测 19551ms、真实 27556ms）。
 * 样本不够就退回探测 —— 一两次的均值被一个离群值就能拽走，而这个数会决定降不降级。
 */
const MIN_REAL_SAMPLES = 5;

function effectiveMs(e: Pick<Endpoint, "real_ms" | "real_n" | "probe_ms">): number | null {
  if (e.real_n >= MIN_REAL_SAMPLES && e.real_ms != null && e.real_ms > 0) return e.real_ms;
  return e.probe_ms;
}

/**
 * 这个出口靠不靠谱。和服务端 `is_reliable` 同一套判据。
 *
 * 低于这条线的整体排到靠谱的那批**后面**，价钱再便宜也不行 —— 因为省下的那点钱
 * 换来的是用户多卡一次。线上实测那组：寒鹤 99% / ¥0.20 对 自带地址 73% / ¥0.10，
 * 纯按钱算是后者划算（失败不花钱），但那 27% 的失败是「卡满整段预算才失败」。
 *
 * 样本不够一律算靠谱：没有证据不构成降级理由。
 */
const MIN_RATE_SAMPLES = 8;
const RELIABLE_FLOOR = 0.9;

function isReliable(e: Pick<Endpoint, "rate_ok" | "rate_bad">): boolean {
  return !confidentlyBelowFloor(e.rate_ok, e.rate_ok + e.rate_bad);
}

/**
 * 「有把握它的真实成功率低于 RELIABLE_FLOOR」吗。和服务端 `confidently_below_floor`
 * 同一套判据：精确的单侧二项检验，P < 5% 才算有把握。
 *
 * 不用「成功数/总数 >= 0.9」直判，是因为小样本会被噪声牵着走 —— 线上真出现过
 * 8/9 = 89% 被判成不靠谱，而九次错一次说不明任何事。也不用 Wilson 上界：
 * 它在 p̂ 贴 0 那一端过激，第一发就失败的新出口会当场被判死。
 */
function confidentlyBelowFloor(ok: number, total: number): boolean {
  if (total <= 0 || ok < 0) return false;
  const n = total;
  const k = Math.min(ok, total);
  const p = RELIABLE_FLOOR;
  if (k / n >= p) return false;
  // 全程在对数空间算：直接递推 pmf 的话 (1-p)^n 在 n≈300 以上就下溢成 0，
  // 尾概率算成 0，于是 890/1000（89%，和 90% 没有显著差别）会被判成不靠谱。
  const logp = Math.log(p);
  const logq = Math.log(1 - p);
  const step = (i: number) => Math.log((n - i + 1) / i) + logp - logq;
  let lp = n * logq;
  let maxLp = lp;
  for (let i = 1; i <= k; i++) {
    lp += step(i);
    if (lp > maxLp) maxLp = lp;
  }
  lp = n * logq;
  let sum = Math.exp(lp - maxLp);
  for (let i = 1; i <= k; i++) {
    lp += step(i);
    sum += Math.exp(lp - maxLp);
  }
  return maxLp + Math.log(sum) < Math.log(0.05);
}

/**
 * 综合得分：**越小越先用**。和服务端 `endpoint_score` 同一套判据。
 *
 *   得分 = 进价 × (1 / 成功率) × √(首字延迟 / 同线路最快)
 *
 * `1/成功率`：一次失败的代价是白等一个来回，平均两次才成 = 代价翻倍。
 * `√(延迟倍数)`：慢要罚但不该压过价钱；首字延迟本身抖得厉害，线性会让排序天天翻。
 * 两个惩罚都有证据门槛和上限。
 *
 * 这个得分只在**同一个可靠性档内**决定先后 —— 跨档由 isReliable 那道闸说了算。
 */
const MIN_RATE = 0.2;
const MAX_SLOW_PENALTY = 3;

function endpointScore(
  cost: number,
  e: Pick<Endpoint, "rate_ok" | "rate_bad" | "real_ms" | "real_n" | "probe_ms">,
  bestMs: number | null,
): number {
  let score = Number.isFinite(cost) && cost > 0 ? cost : 1;
  const total = e.rate_ok + e.rate_bad;
  if (total >= MIN_RATE_SAMPLES) {
    score /= Math.min(1, Math.max(MIN_RATE, e.rate_ok / total));
  }
  const ms = effectiveMs(e);
  if (ms != null && ms > 0 && bestMs != null && bestMs > 0) {
    score *= Math.min(MAX_SLOW_PENALTY, Math.sqrt(Math.max(1, ms / bestMs)));
  }
  return score;
}

/** 慢得离谱。和服务端 `is_egregiously_slow` 同一套判据：两个条件必须同时成立。 */
function egregiouslySlow(ms: number | null, bestMs: number | null): boolean {
  if (ms == null || bestMs == null || !(bestMs > 0)) return false;
  return ms >= SLOW_FLOOR_MS && ms >= SLOW_FACTOR * bestMs;
}

/**
 * 排序里「便宜」这一维到底比什么。和服务端 `expand()` 里那段换算同一套判据。
 *
 * **倍率不能跨站比。** 它的单位是那家中转自己的余额单位，而一块钱能买到多少余额
 * 各家差几十倍。线上就有这个形状：GPT 线路上「梦幻API 0.15 倍」看着比「WE API
 * 0.16 倍」便宜，换算之后是每美元官价 ¥0.15 对 ¥0.016 —— 差十倍，而且方向是反的。
 *
 * **全有全无**：这条线路上只要有一个站没填汇率（线路自带地址也算），整条线路退回
 * 按倍率排。把没填的当成 1.0 顶上去是最糟的选择 —— 一个纯粹「没填」的站会凭空排
 * 到前面，而且没有任何地方会报错。这和「没查到 ≠ 没有」是同一条规矩。
 */
function costKeys(r: Route, live: Endpoint[]): { own: number; of: (e: Endpoint) => number } {
  const all = [r.own_cost_cny, ...live.map((e) => e.cost_cny)];
  if (all.every((v): v is number => v != null && Number.isFinite(v))) {
    return { own: r.own_cost_cny as number, of: (e) => e.cost_cny as number };
  }
  return { own: 1, of: (e) => e.cost_ratio };
}

/**
 * 按生效顺序排出这条线路的出口，线路自带地址算成本 1.0 的那个。
 *
 * 这里重算一遍而不是让服务端回排好的：这一屏要的是「**如果**我把这个改成 0.3 倍，
 * 它会排到第几」，而那要在保存之前就看得到。判据和服务端是同一套。
 */
function servesModel(r: Route, e: Endpoint, modelId: string): boolean {
  // 复刻服务端 `expand()`：出口 enabled_models 为空 = 承载**线路自己**开放的那些
  // （不是并集 —— 别的出口带来的货这个出口未必有）；非空 = 就这几款。
  return e.enabled_models.length === 0
    ? r.models.includes(modelId)
    : e.enabled_models.includes(modelId);
}

/**
 * `modelId` 为空 = 不按模型筛（全线路视角，老行为）。
 *
 * **派单是逐模型决定的，这一屏原来只画一份「这条线路的顺序」。** 服务端两处按模型筛：
 * 自带地址只在线路自己有这款货时才进候选，出口按 enabled_models 承载与否直接 continue。
 * 不筛的后果不是「略有出入」——线上 GPT 线路上屏幕排第 1 的出口对 gpt-5.6-luna 根本不是
 * 候选，近 7 天一次都没被派到过，而它占着第 1 名的位置，第 2、5 名同样不是候选。
 * 名次的分母也因此是错的。
 */
function ordered(r: Route, modelId = ""): Array<Endpoint | null> {
  const now = Date.now();
  const live = r.endpoints
    .filter((e) => e.active)
    .filter((e) => !modelId || servesModel(r, e, modelId));
  // 「慢不慢」是**相对同线路最快的那个**说的，一个出口自己看不出来。基准只取还活着的
  // 候选：一个已知打不通的出口耗时没有意义，拿它当基准会让所有人显得「不慢」。
  const bestMs = live
    .filter((e) => tier(e, now) < 2)
    .map((e) => effectiveMs(e))
    .filter((v): v is number => v != null && v > 0)
    .reduce<number | null>((a, v) => (a == null ? v : Math.min(a, v)), null);

  const cost = costKeys(r, live);
  const rows: Array<{ k: [number, number, number]; v: Endpoint | null }> = [
    // 线路自带的地址按第 0 档算，不是「还没测过」：它是在任的那个，今天所有流量都从它走。
    // 走「还没测过」的话，一个原价的备用中转只要测通就会把直连顶掉 —— 同价位凭空多一跳。
    // 它在探测表里没有行，所以也没有耗时，因此永远不会被判「慢」。
    // 判据和服务端 own_order_key 一致。
    // 线路自带地址在 route_attempt 里的成败记在**线路 id** 下，这一屏拿不到，
    // 所以它按「没有样本」算 —— 也就是算靠谱、不罚。和服务端一致（那边同样
    // 给自带地址塞的是 (0, 0)）。宁可不罚，不猜。
    // 自带地址。**成败数现在从服务端读**（own_rate_ok/own_rate_bad）——
    // 原来这里硬写 (0, 0)，旁边注释说「和服务端一致」，那句是假的：服务端
    // `expand()` 从 `load_own_rates` 真读得到这一对数并据此判它的可靠性档。
    // 于是屏上自带地址永远算靠谱，而派单可能正把它整档往后压。
    ...(modelId && !r.models.includes(modelId)
      ? [] // 线路自己没这款货 → 自带地址根本不是候选（服务端 own_has 那一处）
      : [{
          k: [0, isReliable({ rate_ok: r.own_rate_ok, rate_bad: r.own_rate_bad }) ? 0 : 1, cost.own],
          v: null,
        } as { k: [number, number, number]; v: Endpoint | null }]),
    ...live.map((e) => ({
      k: [
        tier(e, now),
        isReliable(e) ? 0 : 1,
        endpointScore(cost.of(e), e, bestMs),
      ] as [number, number, number],
      v: e,
    })),
  ];
  rows.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
  return rows.map((x) => x.v);
}

/**
 * 这一行**为什么**排在后面。`null` = 没被往后排。
 *
 * 压暗此前的判据是「被判了慢」，旁边注释还写着「那才是这一屏上唯一还会让一个出口
 * 往后靠的东西」—— 那句话已经不成立：排序的前两档（可用档 `tier`、可靠性档
 * `isReliable`）都排在得分之前，而「慢」只是得分里的一个 √倍数因子。
 *
 * 后果是方向反的：线上 Claude 线路重放，被压暗的第 2、3 行排在没压暗的第 4 行**前面**，
 * 而真正被整档踢到最后的第 5/6/7 行（探测打不通）全部满亮度。
 */
function demotedReason(r: Route, e: Endpoint | null, modelId = ""): string | null {
  const now = Date.now();
  if (e) {
    const t = tier(e, now);
    if (t === 2) return "测下来不通，整档排到最后";
    if (!isReliable(e)) return "成功率低于 90%，整档排在靠谱的那批之后";
    if (t === 1) return "探测结论过期/没测过，排在测通的之后";
  } else if (!isReliable({ rate_ok: r.own_rate_ok, rate_bad: r.own_rate_bad })) {
    return "线路自带地址成功率低于 90%，整档排在靠谱的那批之后";
  }
  return slowOnThisRoute(r, e, modelId) ? "比同线路最快的慢 3 倍以上且超过 5 秒" : null;
}

/** 这个出口在这一屏上是不是被判了「慢」。渲染徽章用，判据和 ordered() 同一处。 */
function slowOnThisRoute(r: Route, e: Endpoint | null, modelId = ""): boolean {
  if (!e) return false;
  const now = Date.now();
  // 基准必须取**和排序同一批**候选：选了模型之后不承载它的出口根本不参与排序，
  // 拿它们的耗时当基准会得出一个屏上任何一行都对不上的「最快」。
  const live = r.endpoints
    .filter((x) => x.active)
    .filter((x) => !modelId || servesModel(r, x, modelId));
  const bestMs = live
    .filter((x) => tier(x, now) < 2)
    .map((x) => effectiveMs(x))
    .filter((v): v is number => v != null && v > 0)
    .reduce<number | null>((a, v) => (a == null ? v : Math.min(a, v)), null);
  return egregiouslySlow(effectiveMs(e), bestMs);
}

/**
 * 这个数**一律说「倍」，不说「折」**。
 *
 * 不是措辞偏好：折是十分制、只在 0<v<1 这一段说得通。用折说话，1.5 这个合法的值
 * 无话可说；而上一版的 `v >= 1 → "进价原价"` 会把 1.2 也说成原价 ——
 * 那是一句关于钱的假话，而且正是它让人以为这里天生不能大于 1。
 *
 * 一律带「进价」二字：不带的话，列表里一个孤零零的「0.3×」很容易被当成卖价的倍率，
 * 而卖价那个是线路页上另一个数。
 *
 * `Number(toFixed(4))` 是为了去掉浮点尾巴（0.1+0.2 那类），不是四舍五入到四位：
 * 0.05 还是 0.05，0.35 还是 0.35。
 */
function ratioText(v: number): string {
  return `进价 ${Number(v.toFixed(4))}×`;
}

/**
 * 真实流量的结论。词表和服务端 `route_health::classify` 一致：
 * ok / degraded / error / unknown。自己另编一个词，就等于给自己造一条永远走不到的分支。
 */
function LiveDot({ live, className }: { live: string; className?: string }) {
  const map: Record<string, [string, string]> = {
    ok: ["bg-success", "真实流量最近成功过"],
    degraded: ["bg-warning", "最近成功过，但也在失败"],
    error: ["bg-destructive", "真实流量连续失败"],
  };
  const [color, title] = map[live] ?? ["bg-muted-foreground/40", "最近没有真实流量，不知道"];
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", color, className)}
      title={title}
      aria-label={title}
    />
  );
}

/**
 * 调度器眼里它现在是什么状态。
 *
 * 三种「现在别用它」的理由分开显示，不合成一个「不可用」—— 恢复方式完全不同：
 * 没额度要去充值、密钥被拒要去换密钥、限流什么都不用做。混成一个红点，
 * 运维看到了不知道该干什么。
 */
function SchedBadge({ sched, retryIn }: { sched: string; retryIn: number | null }) {
  if (sched === "live") return null;
  const mins = retryIn == null ? null : Math.max(1, Math.round(retryIn / 60));
  if (sched === "saturated") {
    return (
      <Badge variant="outline" className="shrink-0 border-warning/40 text-warning">
        <Timer /> 限流让位中
      </Badge>
    );
  }
  const label = sched === "no_quota" ? "已下架 · 没额度" : "已下架 · 密钥被拒";
  return (
    <Badge variant="outline" className="shrink-0 border-destructive/40 text-destructive">
      <PauseCircle /> {label}
      {mins != null && ` · ${mins} 分钟后再试`}
    </Badge>
  );
}

/**
 * 最近 7 天真实流量的成绩：成功率 + 成功那些的平均首字。
 *
 * 「哪个快、哪个稳」只有真实流量答得上来 —— 探测一个出口只发一句话、只用一个模型，
 * 而且它超时就判死，答不了这个问题。没有样本就明说没有，不拿探测的数字冒充。
 */
function RealBadge({ ok, fail, ms }: { ok: number; fail: number; ms: number | null }) {
  const total = ok + fail;
  if (total === 0) {
    return (
      <Badge variant="outline" className="shrink-0 text-muted-foreground" title="最近 7 天没有真实请求走过这个出口——不是坏，是没样本。排序此时退回看探测。">
        无真实流量
      </Badge>
    );
  }
  const rate = (ok / total) * 100;
  // 判据和排序一致：最近一次真实结果说了算，所以这里的颜色只反映成功率高低，
  // 不去重复排序那套档位——两套颜色叠在一起反而看不出谁在起作用。
  const good = rate >= 95;
  return (
    <Badge
      variant="outline"
      className={good ? "shrink-0 border-success/40 text-success" : "shrink-0 border-warning/40 text-warning"}
      title={`最近 7 天真实请求：成功 ${ok} 次、失败 ${fail} 次${ms != null ? `，成功那些平均首字 ${ms}ms` : "，没有可用的耗时样本"}。这是 7 天成绩单；排序读的是另一对数（今天，样本不够才退回 7 天），两者常常不同。耗时上，有 5 个以上真实样本时用真实首字，否则退回探测。`}
    >
      真实 {rate.toFixed(rate >= 99.95 || rate === 0 ? 0 : 1)}% · {total}次
      {ms != null ? ` · ${ms}ms` : ""}
    </Badge>
  );
}

function ProbeBadge({ ok, ms, note }: { ok: boolean | null; ms: number | null; note: string }) {
  if (ok === null) {
    return (
      <Badge variant="outline" className="shrink-0">
        还没测
      </Badge>
    );
  }
  if (ok) {
    return (
      <Badge variant="success" className="shrink-0">
        <Check /> {ms ?? "—"}ms
      </Badge>
    );
  }
  // 失败原因是这一格最有价值的信息（密钥被拒 / 没有这个模型 / 连不上），
  // 别藏进 tooltip：藏起来就等于运维还得再点一次才知道要改什么。
  return (
    <Badge
      variant="outline"
      className="max-w-[16rem] shrink-0 border-destructive/40 text-destructive"
      title={note}
    >
      <X /> <span className="truncate">{note || "不通"}</span>
    </Badge>
  );
}

/// 一个价格输入框里的字符串 → 数,或 `null` 表示**没填**。
///
/// 「填了 0」和「留空」必须分得开:填 0 = 有意的免费定价,要原样发给后端;
/// 留空 = 没有覆盖,后端应当落回实时目录价。用 `Number(x) || 0` 会把两者抹平。
/// 和 `Routing.tsx` 的 `priceNum` 是同一条判据 —— 两处必须同解。
const priceNum = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** 报价币种。价存进库永远是美元每百万 token，这个只管后台的输入框。 */
type Currency = "usd" | "cny";

/**
 * 换算一个价格框里的字符串。空串原样返回 —— **留空是「跟随现价」，不是 0**，
 * 换个币种不该把它变成一个具体的数。
 *
 * 只在切换币种和保存这两个时刻调用，不在每次渲染时调用：每渲染一次换算一次会让
 * 输入框里的数被反复四舍五入，用户打字打到一半就被改掉。
 */
const convertPrice = (text: string, factor: number): string => {
  const t = String(text ?? "").trim();
  if (!t) return t;
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(factor) || factor <= 0) return t;
  // 六位有效小数：美元每百万 token 最低到 0.01，折成人民币也就 0.07，
  // 再往下的位数是浮点噪音（`0.30000000000000004` 那种）。
  return String(Number((n * factor).toFixed(6)));
};

export function RouteEndpoints() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  // 「按哪个模型看」。空 = 全部模型合计（老行为）。
  //
  // 这一屏画的是「谁会先被派到」，而**派单是逐模型决定的**：出口按 enabled_models 筛，
  // 成败数也按模型统计。选了模型之后前端按同一套判据筛，服务端也用 ?model= 把成败数
  // 收窄到这一个模型 —— 两侧同口径，画出来的才是真的会发生的顺序。
  const [modelFilter, setModelFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  // 「拉取」的结果：这家有哪些、缺哪些。缺的那部分才是运维真正要看的 ——
  // 它直接回答「这个出口能不能顶上」。
  const [fetched, setFetched] = useState<{
    here: string[];
    missing: string[];
    /// 这家有、线路没有的：勾上就会新增到 IDE 列表
    extra: string[];
    /// 同上，但算不出价格 —— 开放出去用户一分不付、上游照收
    extra_no_price: string[];
  } | null>(null);
  const [fetching, setFetching] = useState(false);

  const load = useCallback(async (model = modelFilter) => {
    setErr(null);
    try {
      // 成败数按这个模型取。不带的话屏上是全模型合计，而派单看的是这个模型自己的
      // 战绩 —— 两者能差到判定翻转（实测 deepseek 线路：合并 0/13「从没成过」，
      // 按 deepseek-v4-flash 看是 67/88）。
      const qs = model ? `?model=${encodeURIComponent(model)}` : "";
      const body = await api.get<{ routes: Route[] }>(`/api/admin/route-endpoints${qs}`);
      setRoutes(body.routes ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "读取失败");
    }
  }, [modelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<{ probe?: { ok: boolean; note: string; ms: number } }>(
        "/api/admin/route-endpoints",
        {
          id: draft.id,
          route_id: draft.route_id,
          label: draft.label,
          base_url: draft.base_url,
          api_key: draft.api_key,
          cost_ratio: Number(draft.cost_ratio) || 1,
          note: draft.note,
          protocol: draft.protocol,
          active: draft.active,
          enabled_models: draft.enabled_models,
          capacity: draft.capacity.trim() ? Number(draft.capacity) : null,
          // 只把**改动过的**送上去，服务端做合并而不是覆盖 ——
          // 整份覆盖会把线路上别的模型的价抹掉。
          // **两个框都得填。** 原来是 `in || out`（有一个就提交）加 `Number(v.in) || 0`，
          // 于是「只改了输出价」提交的是 {in: 0, out: 新值} —— 而每模型价在
          // `effective_token_prices` 里是**第一优先级**，它会盖掉实时目录价。
          // 输入价被清成 0 的后果不止输入白送：`effective_cache_prices` 在有每模型覆盖时
          // 按 `输入价 × 倍率` 算缓存读/写，输入价 0 → 缓存两条腿一起归零。
          // 而缓存正是 Claude 这类模型账单里最大的一项。
          //
          // 判据是「填了没有」，不是「填的是不是正数」：两边都填 0 = 有意的免费定价，
          // 必须原样发上去（和 Routing.tsx 那一处同解）。
          // merge_route_pricing 是 merge 模式——不出现的键会保留旧值。
          // 所以清空价格（跟随现价）必须显式发 null 让后端把旧覆盖删掉。
          // 报价币种存在**线路**上（和价格同一条线：同线路的出口共用一份价）。
          price_currency: draft.price_currency,
          // 折回美元再提交。库里、算钱那一路全是美元每百万 token，这里是唯一的换算点。
          // 除以汇率而不是乘：cny_per_usd 是「1 美元等于多少人民币」。
          model_prices: Object.fromEntries(
            Object.entries(draft.prices).map(([k, v]) => {
              const hasPrice = priceNum(v.in) !== null && priceNum(v.out) !== null;
              if (!hasPrice) return [k, null];
              const rate = draft.price_currency === "cny" ? cnyRate(draft.route_id) : 0;
              const back = (n: number) => (rate > 0 ? Number((n / rate).toFixed(9)) : n);
              return [k, { in: back(priceNum(v.in) ?? 0), out: back(priceNum(v.out) ?? 0) }];
            }),
          ),
          model_names: Object.fromEntries(
            Object.entries(draft.names).filter(([, v]) => v.trim()),
          ),
        },
      );
      // 保存后立刻回探测结论：填错密钥最想马上知道，而不是等它在候选池里躺 15 分钟。
      const p = r?.probe;
      setNote(
        p && !p.ok
          ? { text: `已保存，但探测没通过：${p.note}`, ok: false }
          : { text: p ? `已保存，探测通过（${p.ms}ms）` : "已保存", ok: true },
      );
      setDraft(null);
      await load();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "保存失败", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function probe(kind: "endpoint" | "route", id: string) {
    setProbing(id);
    setNote(null);
    try {
      const path =
        kind === "endpoint"
          ? `/api/admin/route-endpoints/${id}/probe`
          : `/api/admin/routes/${id}/probe`;
      const r = await api.post<{ ok: boolean; ms: number; note: string }>(path, {});
      setNote(r.ok ? { text: `通了，${r.ms}ms`, ok: true } : { text: `不通：${r.note}`, ok: false });
      await load();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "探测失败", ok: false });
    } finally {
      setProbing(null);
    }
  }

  /// 问这个中转有哪些模型：线路开放但它没有的自动取消勾选；它多出来的只**列出来**，不替你勾。
  ///
  /// 原来是「它有的全勾上（含线路本来没有的新模型）」—— 所有者：「我每次问他有什么模型，
  /// 新增的他都自动勾选一堆」。一个中转动辄回八九十款模型，全勾上等于把整份目录塞进 IDE。
  /// 勾哪些新模型是运维的决定，拉取只负责把事实摆出来。
  async function fetchModels() {
    if (!draft) return;
    setFetching(true);
    setNote(null);
    try {
      const r = await api.post<{
        here: string[];
        missing: string[];
        extra: string[];
        extra_no_price: string[];
        upstream_total: number;
      }>(
        "/api/admin/route-endpoints/available",
        {
          id: draft.id,
          route_id: draft.route_id,
          base_url: draft.base_url,
          api_key: draft.api_key,
        },
      );
      setFetched({
        here: r.here ?? [],
        missing: r.missing ?? [],
        extra: r.extra ?? [],
        extra_no_price: r.extra_no_price ?? [],
      });
      // 只做减法：当前勾着的（空 = 线路全部）去掉它没有的。多出来的那些在下面标「这家新有」，
      // 要开放自己勾。
      const routeModels = routeOf(draft.route_id)?.models ?? [];
      const cur = draft.enabled_models.length ? draft.enabled_models : routeModels;
      const missing = r.missing ?? [];
      const next = cur.filter((m) => !hasModel(missing, m));
      setDraft({ ...draft, enabled_models: next });
      const gone = cur.length - next.length;
      const fresh = (r.extra ?? []).length + (r.extra_no_price ?? []).length;
      setNote({
        text: `这家有 ${(r.here ?? []).length} 个线路上的模型` +
          (gone ? `，${gone} 个它没有（已取消勾选）` : "") +
          (fresh ? `；另有 ${fresh} 个线路上没有的，列在下面，要开放自己勾` : ""),
        ok: true,
      });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "拉取失败", ok: false });
    } finally {
      setFetching(false);
    }
  }

  async function relist(id: string) {
    setNote(null);
    try {
      await api.post(`/api/admin/route-endpoints/${id}/relist`, {});
      setNote({ text: "已放回轮转。真不行的话下一个请求会把它再下架。", ok: true });
      await load();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "恢复失败", ok: false });
    }
  }

  async function remove(e: Endpoint) {
    if (!confirm(`删掉这个出口？\n\n${e.base_url}\n\n之后这条线路的流量不会再走它。`)) return;
    try {
      await api.del(`/api/admin/route-endpoints/${e.id}`);
      await load();
    } catch (x) {
      setNote({ text: x instanceof Error ? x.message : "删除失败", ok: false });
    }
  }

  const list = routes ?? [];
  /// 编辑出口时要知道它属于哪条线路 —— 那条线路开放的模型就是这个出口的可选范围。
  const routeOf = (id: string) => list.find((r) => r.id === id);

  // ── 报价币种 ──────────────────────────────────────────────────────
  //
  // 库里存的、后端算钱用的，**永远是美元每百万 token**。这里只有输入框和它旁边那些
  // 提示按选定的币种显示；换算发生在两个时刻：切换币种（把框里的数换过去）和保存
  // （换回美元再提交）。渲染时不换算 —— 每渲染一次换算一次会让用户打字打到一半被四舍五入。
  //
  // 汇率取后台设置里那一个（cny_per_usd = 10000 / usd_per_cny_bps），和扣费同源。
  // 拿不到就退回美元：**宁可显示美元，也不要用一个默认汇率把人民币价算错** ——
  // 一个凭空的汇率会静默地让整条线路的进价错一个数量级。
  const cnyRate = (routeId: string): number => {
    const v = routeOf(routeId)?.cny_per_usd;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  /// 这条线路此刻按哪种货币录（改到一半时以 draft 为准）。汇率取不到一律当美元。
  const routeCurrency = (routeId: string): Currency => {
    const want = draft && draft.route_id === routeId ? draft.price_currency : routeOf(routeId)?.price_currency;
    return want === "cny" && cnyRate(routeId) > 0 ? "cny" : "usd";
  };
  /// 美元 → 屏幕上显示的那个币种。
  const showNum = (usd: number, routeId: string): number =>
    routeCurrency(routeId) === "cny" ? Number((usd * cnyRate(routeId)).toFixed(6)) : usd;
  /// 当前币种的符号和中文名，只用于文案。
  const sym = (routeId: string) => (routeCurrency(routeId) === "cny" ? "¥" : "$");
  const ccy = (routeId: string) => (routeCurrency(routeId) === "cny" ? "人民币" : "美元");
  /// 切币种：把几个价格框里的数一起换过去，数值本身不变，变的只是它的单位。
  const setRouteCurrency = (routeId: string, next: Currency) => {
    setDraft((d) => {
      if (!d) return d;
      const rate = cnyRate(routeId);
      if (next === d.price_currency || rate <= 0) return { ...d, price_currency: next };
      const factor = next === "cny" ? rate : 1 / rate;
      const prices = Object.fromEntries(
        Object.entries(d.prices).map(([k, v]) => [k, { in: convertPrice(v.in, factor), out: convertPrice(v.out, factor) }]),
      );
      return { ...d, price_currency: next, prices };
    });
  };

  /// 库里**已经存着**的每模型价,字符串形态,按当前币种。改一半时另一半从这里回填 ——
  /// 回填空串的话,提交判据一收紧就会把这一条整个丢掉(等于运维改一半就撤销了另一半)。
  const storedPrice = (m: string, side: "in" | "out"): string => {
    const v = draft ? routeOf(draft.route_id)?.model_prices?.[m]?.[side] : undefined;
    if (v === undefined || v === null) return "";
    return String(draft ? showNum(v, draft.route_id) : v);
  };
  /// 这个模型此刻的目录现价，按当前币种；目录没收录就没有。
  const livePrice = (m: string): { in: number; out: number } | null => {
    const v = draft ? routeOf(draft.route_id)?.catalog_prices?.[m] : undefined;
    return v && typeof v.in === "number" && typeof v.out === "number"
      ? { in: showNum(v.in, draft!.route_id), out: showNum(v.out, draft!.route_id) }
      : null;
  };
  /// 价格框里此刻显示的那个数（草稿里填的，其次库里存的）。
  const shownPrice = (m: string, side: "in" | "out"): string =>
    String(draft?.prices[m]?.[side] ?? storedPrice(m, side) ?? "");
  /// 你填的价是现价的几倍，取入价出价里大的那个。拿不到现价或没填回 0。
  const priceGapOf = (m: string): number => {
    const live = livePrice(m);
    if (!live) return 0;
    const pin = priceNum(shownPrice(m, "in")) ?? 0;
    const pout = priceNum(shownPrice(m, "out")) ?? 0;
    const gi = live.in > 0 && pin > 0 ? pin / live.in : 0;
    const go = live.out > 0 && pout > 0 ? pout / live.out : 0;
    return Math.max(gi, go);
  };
  /// 这个模型的两个价是不是都有(草稿里填的,或库里已存的)。
  /// 目录查不到价的模型必须两个都有才能开放 —— 只填输入价就勾上的话,
  /// 输出 token 会按 0 永久免费,而 Claude/DeepSeek 的出价是入价的 3~5 倍。
  const bothPriced = (m: string): boolean =>
    priceNum(draft?.prices[m]?.in ?? storedPrice(m, "in")) !== null &&
    priceNum(draft?.prices[m]?.out ?? storedPrice(m, "out")) !== null;
  // 只数**在轮转里**的。停用的单独说 —— 把它们混进「额外出口」会让人以为有那么多在接流量。
  const extra = list.reduce((n, r) => n + r.endpoints.filter((e) => e.active).length, 0);
  const parked = list.reduce((n, r) => n + r.endpoints.filter((e) => !e.active).length, 0);
  // 数的是**生效判据**的档，不是探测原始结论：一个探测超时但今天真实成功过的出口
  // 排序里是好的，这里再把它记成「打不通」，两处就会对不上，运维照着去修一个
  // 根本没坏的出口。判据统一在 tier()。
  const tierNow = Date.now();
  const broken = list.reduce(
    (n, r) => n + r.endpoints.filter((e) => e.active && tier(e, tierNow) === 2).length,
    0,
  );
  const untested = list.reduce(
    (n, r) => n + r.endpoints.filter((e) => e.active && tier(e, tierNow) === 1).length,
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="多路由"
        description="给一条线路挂几个不同的中转地址。模型、价格、账单全都跟着线路走——出口只决定这一次请求从哪儿发出去，换出口不会改用户被扣的钱。"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw /> 刷新
          </Button>
        }
      />

      {/* 按模型看。**默认是「全部模型」= 老行为**，选一个模型才切到「派单真正会怎么排」。
          默认不自动选，是因为「全部」这一档回答的是另一个有用的问题（这条线路整体如何）；
          但那一档下的顺序**不代表任何一次真实派单** —— 下面那句提示把这件事说出来。 */}
      {routes && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">按模型看：</span>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={modelFilter}
            onChange={(e) => {
              setModelFilter(e.target.value);
              void load(e.target.value);
            }}
          >
            <option value="">全部模型（合计，不代表任何一次真实派单）</option>
            {[...new Set(list.flatMap((r) => r.effective_models))].sort().map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {modelFilter ? (
            <span className="text-[12px] text-muted-foreground">
              下面每条线路只列**承载这个模型**的出口，成败数也只算这个模型 —— 和网关派单同口径。
            </span>
          ) : (
            <span className="text-[12px] text-warning">
              合计视角：不承载某个模型的出口也列在里面，名次的分母因此偏大。要看真实派单顺序请选一个模型。
            </span>
          )}
        </div>
      )}

      <ErrorState message={err} />

      {note ? (
        <p className={cn("text-sm", note.ok ? "text-success" : "text-destructive")}>{note.text}</p>
      ) : null}

      {!routes && <TableSkeleton rows={3} columns={["30%", "20%", "20%", "20%"]} label="读取中" />}

      {routes && !list.length && (
        <EmptyState title="还没有线路" hint="先到「线路」建一条连接，再回来给它挂中转地址。" />
      )}

      {routes && list.length > 0 && (
        <>
          <SectionReveal as="section" delay={70} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="线路" value={num(list.length)} hint="每条各自计价" />
            <Stat
              label="额外出口"
              value={num(extra)}
              hint={parked ? `线路自带的那个不算在内 · 另有 ${parked} 个已停用` : "线路自带的那个不算在内"}
            />
            <Stat label="测下来不通" value={num(broken)} hint={broken ? "已自动排到最后" : "都通"} />
            <Stat label="还没测过" value={num(untested)} hint="排在通过的之后" />
          </SectionReveal>

          <SectionReveal as="section" delay={140} className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              同一条线路下按{" "}
              <b className="text-foreground">「能用的在前 → 稳的在前 → 便宜的在前」</b>{" "}
              自动排序（第二档是<b className="text-foreground">可靠性</b>，不是快慢——
              快慢已经并进第三档的得分里，按 √倍数计、最多罚 3 倍）。<b className="text-foreground">挂多少个就能用多少个</b>——
              一个请求能换几个出口由<b className="text-foreground">时间</b>决定，不由次数决定：
              换线只发生在上游明确回了错误的时候，而那类失败（401 / 404 / 429）两三百毫秒就回来，
              十个加起来还不到三秒。总时长由客户端自己的耐心封顶，多试几个不会让人多等。
            </p>

            {list.map((r) => {
              const rows = ordered(r, modelFilter);
              const vname = vendorName(r.vendor);
              return (
                <Card key={r.id} className={cn(!r.active && "opacity-60")}>
                  <CardHeader>
                    <VendorMark vendor={r.vendor} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Truncate className="font-semibold">{r.label || "未命名"}</Truncate>
                        <LiveDot live={r.live} />
                        {!r.active && <Badge variant="outline">已停用</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {vname ? `${vname} · ` : ""}
                        {r.model_count} 个模型
                        {r.effective_models.length > r.model_count
                          ? `（另有 ${r.effective_models.length - r.model_count} 个由出口带来）`
                          : ""}
                        {" · "}{r.protocol} 协议
                        {r.endpoints.filter((e) => e.active).length
                          ? ` · ${r.endpoints.filter((e) => e.active).length} 个额外出口`
                          : ""}
                        {r.endpoints.some((e) => !e.active)
                          ? ` · ${r.endpoints.filter((e) => !e.active).length} 个已停用`
                          : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDraft({
                          route_id: r.id,
                          // 币种从线路读；这一格改的是线路，保存时随价格一起提交。
                          price_currency: (r?.price_currency === "cny" ? "cny" : "usd"),
                          label: "",
                          base_url: "",
                          api_key: "",
                          cost_ratio: "1",
                          note: "",
                          protocol: "",
                          active: true,
                          enabled_models: [],
                          capacity: "",
                          prices: {},
                          names: {},
                        })
                      }
                    >
                      <Plus /> 加一个出口
                    </Button>
                  </CardHeader>

                  <Separator />

                  <ol className="divide-y divide-border">
                    {rows.map((e, i) => {
                      // 压暗的判据是「**这一行确实被往后排了**」，不再只看「慢」。
                      // 只看慢的话方向是反的：慢只是得分里的一个因子，而可用档和可靠性档
                      // 排在得分之前 —— 被整档踢到最后的那几行反而满亮度。
                      const slow = slowOnThisRoute(r, e, modelFilter);
                      const why = demotedReason(r, e, modelFilter);
                      const beyond = why !== null;
                      const id = e?.id ?? r.id;
                      return (
                        <li key={id}>
                          <div
                            className={cn(
                              "flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 transition-colors hover:bg-accent/40",
                              // 用不到的压暗，但仍然可读、仍然可操作 —— 它们是兜底，不是垃圾。
                              beyond && "opacity-60",
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums",
                                beyond
                                  ? "bg-muted text-muted-foreground"
                                  : "bg-foreground text-background",
                              )}
                            >
                              {i + 1}
                            </span>
                            <LiveDot live={e ? e.live : r.live} />
                            <div className="min-w-0 flex-1">
                              <Truncate
                                className="font-mono text-[13px]"
                                title={e ? e.base_url : r.base_url}
                              >
                                {e ? e.base_url : r.base_url || "—"}
                              </Truncate>
                              <p className="text-xs text-muted-foreground">
                                {e ? (
                                  <>
                                    {e.label || "未命名出口"}
                                    {" · "}
                                    {e.has_key ? "自带密钥" : "用线路的密钥"}
                                    {/* 只承载一部分模型是个容易忘的设置：设完就再也看不见，
                                        然后某天有人问「为什么这个便宜出口没被用上」。 */}
                                    {/*
                                      分子分母不是同一个集合：分子是这个出口自己声明有哪些货
                                      （可以包含线路本身没有的），分母是线路开放的模型数。
                                      于是会出现 3/2 这种分子大于分母的显示（线上 OHub 挂在
                                      deepseek 线路下就是）。只数**真正落在这条线路上的那部分**。
                                    */}
                                    {e.enabled_models.length > 0 &&
                                      (() => {
                                        // 名字要写出来。原来只写「只承载 3/5 个模型」，运维得打开编辑
                                        // 窗口才知道是哪三个 —— 而窗口里当时也不列出口带来的那些。
                                        const onRoute = e.enabled_models.filter((m) =>
                                          hasModel(r.models || [], m),
                                        );
                                        const extra = e.enabled_models.filter(
                                          (m) => !hasModel(r.models || [], m),
                                        );
                                        const few = (xs: string[]) =>
                                          xs.length <= 6 ? xs.join("、") : `${xs.slice(0, 6).join("、")} 等 ${xs.length} 个`;
                                        return (
                                          <span title={e.enabled_models.join("\n")}>
                                            {` · 只承载 ${onRoute.length}/${r.model_count} 个：${few(onRoute) || "（线路上的一个都不承载）"}`}
                                            {extra.length > 0 && ` · 另带来线路没有的 ${extra.length} 个：${few(extra)}`}
                                          </span>
                                        );
                                      })()}
                                    {e.capacity != null && ` · 容量 ${e.capacity}`}
                                    {e.protocol ? ` · ${e.protocol} 协议` : ""}
                                    {!e.active ? " · 已停用" : ""}
                                    {e.note ? ` · ${e.note}` : ""}
                                  </>
                                ) : (
                                  "线路自带的地址"
                                )}
                              </p>
                            </div>
                            {/*
                              线路自带的地址**没有 cost_ratio 这个东西**（models 表没这一列），
                              原来对它显示 `进价 1×`，和隔壁真出口的 `1.1×` `0.15×` 长得一模一样，
                              看起来像"这条线路的进价是 1 倍"——那是个常量，不是读来的。
                            */}
                            {e ? (
                              // 三元的每一支只能是一个表达式 —— 加同级徽章必须套片段。
                              <>
                              <Badge variant={e.cost_ratio < 1 ? "success" : "outline"}>
                                {ratioText(e.cost_ratio)}
                              </Badge>
                              {/*
                                倍率旁边必须给出换算后的数，否则这一栏是误导的：
                                线上「梦幻API 0.15 倍」看着比「WE API 0.16 倍」便宜，
                                换算之后是 ¥0.15 对 ¥0.016，差十倍而且方向反了。
                                排序比的就是这个换算后的数。
                              */}
                              <Badge
                                variant="outline"
                                className="shrink-0 text-muted-foreground"
                                title={
                                  e.cost_cny == null
                                    ? "这家站还没填充值汇率，算不出真实成本。这条线路上只要有一个没填，整条线路就退回按倍率排——而倍率跨站不可比。"
                                    : "每花掉一美元官方价，你实际付多少人民币。倍率只在同一家中转内部可比，跨站要看这个数——排序比的就是它。"
                                }
                              >
                                {e.cost_cny == null
                                  ? "汇率没填"
                                  : `¥${e.cost_cny < 0.01 ? e.cost_cny.toFixed(4) : e.cost_cny.toFixed(3)}/官价$1`}
                              </Badge>
                              </>
                            ) : (
                              <Badge variant="outline" title="线路自带的地址没有单独的进价系数，排序时按 1 处理">
                                进价未设
                              </Badge>
                            )}
                            <SchedBadge
                              sched={e ? e.sched : r.sched}
                              retryIn={e ? e.retry_in : r.retry_in}
                            />
                            {e ? (
                              // 三元的每一支只能是一个表达式 —— 加同级徽章必须套片段。
                              <>
                              <ProbeBadge ok={e.probe_ok} ms={e.probe_ms} note={e.probe_note} />
                              {/*
                                真实成绩挨着探测徽章放。探测判死而真实一直成功是线上
                                实际发生过的事（梦幻API：探测 20001ms 超时，当天 241 次
                                真实请求全成），只显示探测的话那个红是误导人的。
                                排序读的也是这一栏，不是探测。
                              */}
                              <RealBadge ok={e.real_ok} fail={e.real_fail} ms={e.real_ms} />
                              {/*
                                降级必须看得见。不标出来的话，一个便宜出口莫名其妙
                                排在第三位，运维只会以为排序坏了 —— 而它是被判「慢」
                                往后靠的，理由具体且可核对。
                              */}
                              {slow && (
                                <Badge
                                  variant="outline"
                                  className="border-warning/40 text-warning"
                                  title={`比这条线路最快的出口慢 ${SLOW_FACTOR} 倍以上，而且自己超过 ${SLOW_FLOOR_MS / 1000} 秒（两个条件必须同时成立）。注意「慢」**不单独占一档**：它按 √倍数计进第三档的得分、最多罚 3 倍，所以一个又慢又便宜的出口仍然可能排在前面。真正会整档往后压的是可用档和可靠性档。`}
                                >
                                  <Turtle className="size-3" /> 慢
                                </Badge>
                              )}
                              </>
                            ) : (
                              <Badge variant="outline">直连</Badge>
                            )}
                            {/*
                              **归因**。数字前端一直都有（成功率、耗时、进价），缺的是
                              「所以它为什么排在这儿」。压暗本身不说明原因，运维看到一行
                              灰的只会猜；而排序的前两档是整档后置的，一句话就能说清。
                            */}
                            {why && (
                              <Badge
                                variant="outline"
                                className="border-muted-foreground/30 text-muted-foreground"
                                title={why}
                              >
                                {why.length > 16 ? `${why.slice(0, 16)}…` : why}
                              </Badge>
                            )}
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={probing === id}
                                onClick={() => void probe(e ? "endpoint" : "route", id)}
                              >
                                <Zap /> {probing === id ? "测…" : "测一下"}
                              </Button>
                              {/* 充完钱不想等调度器那一轮时用。放回去它就是普通候选，
                                  真不行会立刻再被下架 —— 点了不会留下任何坏状态。 */}
                              {(e ? e.sched : r.sched).startsWith("no_quota") ||
                              (e ? e.sched : r.sched) === "auth" ? (
                                <Button size="sm" variant="ghost" onClick={() => void relist(id)}>
                                  <PlayCircle /> 立刻恢复
                                </Button>
                              ) : null}
                              {e && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setDraft({
                                        id: e.id,
                                        route_id: e.route_id,
                                        // 币种从线路读；这一格改的是线路，保存时随价格一起提交。
                                        price_currency: (routeOf(e.route_id)?.price_currency === "cny" ? "cny" : "usd"),
                                        label: e.label,
                                        base_url: e.base_url,
                                        // 服务端不回密钥，所以这里必然是空的；空着保存 = 沿用。
                                        api_key: "",
                                                      cost_ratio: String(e.cost_ratio),
                                        note: e.note,
                                        protocol: e.protocol,
                                        active: e.active,
                                        enabled_models: e.enabled_models,
                                        capacity: e.capacity == null ? "" : String(e.capacity),
                                        prices: {},
                                        names: {},
                                      })
                                    }
                                  >
                                    编辑
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="删掉这个出口"
                                    onClick={() => void remove(e)}
                                  >
                                    <Trash2 />
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  {/*
                    **停用的出口也要看得见。**

                    开关的文案是「投入轮转（取消勾选 = 留着配置但不接任何请求）」——
                    可它此前一停用就从这一屏彻底消失：不可见、不可编辑、不可删除。
                    而且**重建不回来**：唯一索引 (route_id, lower(base_url), key_fp) 没有
                    `WHERE active`，同址同密钥再加一个会撞 23505，报「这条线路下已经有一个
                    地址和密钥都相同的出口了」，指着一行屏幕上不存在的记录。

                    **故意不并进上面那个 `<ol>`**：那串序号的意思是「第几个被派到」，
                    把不接流量的行编进去等于谎报轮转位次；而且 `costKeys()` 的「全有全无」
                    是对活跃候选求的，一个没填汇率的停用出口会把整条线路的比价单位翻掉。
                  */}
                  {r.endpoints.some((e) => !e.active) && (
                    <div className="border-t border-border px-5 py-3">
                      <p className="type-eyebrow mb-2 text-muted-foreground">
                        已停用（留着配置，不接任何请求）
                      </p>
                      <ul className="space-y-1.5">
                        {r.endpoints
                          .filter((e) => !e.active)
                          .map((e) => (
                            <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm opacity-70">
                              <span className="font-medium">{e.label || "未命名出口"}</span>
                              <span className="font-mono text-[12px] text-muted-foreground">
                                {e.base_url}
                              </span>
                              <Badge variant="outline">{ratioText(e.cost_ratio)}</Badge>
                              {e.enabled_models.length > 0 && (
                                <span className="text-[12px] text-muted-foreground">
                                  只承载 {e.enabled_models.join("、")}
                                </span>
                              )}
                              <span className="ml-auto flex items-center gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setDraft({
                                      id: e.id,
                                      route_id: e.route_id,
                                      // 币种从线路读；这一格改的是线路，保存时随价格一起提交。
                                      price_currency: (routeOf(e.route_id)?.price_currency === "cny" ? "cny" : "usd"),
                                      label: e.label,
                                      base_url: e.base_url,
                                      api_key: "",
                                                  cost_ratio: String(e.cost_ratio),
                                      note: e.note,
                                      protocol: e.protocol,
                                      active: e.active,
                                      enabled_models: e.enabled_models,
                                      capacity: e.capacity == null ? "" : String(e.capacity),
                                      prices: {},
                                      names: {},
                                    })
                                  }
                                >
                                  编辑
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label="删掉这个出口"
                                  onClick={() => void remove(e)}
                                >
                                  <Trash2 />
                                </Button>
                              </span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </Card>
              );
            })}
          </SectionReveal>
        </>
      )}

      <Dialog
        open={!!draft}
        onOpenChange={(o) => {
          if (!o) {
            setDraft(null);
            // 不清的话，下次打开另一个出口会看到上一个的拉取结果 —— 一份看起来
            // 很可信、其实属于别人的名单。
            setFetched(null);
          }
        }}
      >
        {/*
          横版。竖着排的时候这个表单有八段，弹窗最高只有 88vh —— 底下的模型表和
          「保存」按钮要滚下去才看得见，而模型表自己还有一层滚动条，两层套在一起
          很容易以为已经到底了。左边是「这条出口本身」，右边是「它有哪些模型」，
          两边各自不长，一屏就装得下。窄屏（lg 以下）自动回到单列。
        */}
        <DialogContent className="max-w-5xl gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "改一个出口" : "加一个出口"}</DialogTitle>
            <DialogDescription>
              同一条线路的出口对用户完全等价——同样的模型、同样的账单，只有我的进价不同。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
              {/* 左列：这条出口本身怎么连 */}
              <div className="grid content-start gap-4">
              <div>
                <Label htmlFor="e-url">中转地址</Label>
                <Input
                  id="e-url"
                  value={draft.base_url}
                  placeholder="https://xxx.com/v1"
                  onChange={(ev) => setDraft({ ...draft, base_url: ev.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  同一个地址可以挂多个出口——一个账号一把密钥。它们各有各的余额和限速，
                  额度耗尽或密钥失效时自动换下一个。只有地址和密钥都一样才算重复。
                </p>
              </div>
              <div>
                <Label htmlFor="e-key">密钥</Label>
                <Input
                  id="e-key"
                  type="password"
                  autoComplete="off"
                  value={draft.api_key}
                  placeholder={draft.id ? "留空 = 不改" : "sk-…"}
                  onChange={(ev) => setDraft({ ...draft, api_key: ev.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  留空就用线路自己的密钥。存进库时加密，之后任何页面都读不回来。
                </p>
              </div>
              {/*
                这一格原来是「余额令牌」（查中转控制台余额用的第二套凭据）。
                2026-09-08 换成报价币种，两个理由：
                  · 令牌那一格线上 **16 个出口填了 0 个**，从上线到现在一次都没走过 ——
                    余额探针一直走「留空就用调用密钥」那条兜底。线路那一级还留着，探针照常。
                  · 中转商各报各的价：海外报美元每百万 token，国内直接报人民币。此前只有一个
                    美元框，运维拿到人民币报价单得自己先除一遍汇率再填，除错一位就是整条线路
                    的进价错一个数量级，而这件事在屏幕上看不出来。
                币种挂在**线路**上（同线路的出口共用一份价，见下面价格框那段注释），
                所以这里改的是线路的字段，保存时和价格一起提交。
              */}
              <div>
                <Label htmlFor="e-cur">报价币种</Label>
                <Select
                  id="e-cur"
                  value={routeCurrency(draft.route_id)}
                  onChange={(ev) => setRouteCurrency(draft.route_id, ev.target.value as Currency)}
                >
                  <option value="usd">美元（$ / 百万 token）</option>
                  <option value="cny">人民币（¥ / 百万 token）</option>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  下面的价格框按这个币种读写。<b>存进库的永远是美元</b>——选人民币时按后台
                  设置里的汇率（此刻 1 美元 ≈ ¥{(routeOf(draft.route_id)?.cny_per_usd ?? 0).toFixed(2)}）
                  在保存那一刻折一次，之后这条线路的价就是一个定数，以后改汇率不会改动它。
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label
                    htmlFor="e-ratio"
                    title="照抄中转那边写的倍率本身：0.3 = 按官方价的 0.3 倍进货，1 = 原价，大于 1 也能填（比原价贵的替补，排在直连后面）。它只决定先用哪个出口，不进用户账单。"
                  >
                    倍率
                  </Label>
                  <Input
                    id="e-ratio"
                    value={draft.cost_ratio}
                    placeholder="0.3"
                    onChange={(ev) => setDraft({ ...draft, cost_ratio: ev.target.value })}
                  />
                  {/*
                    叫「进价倍率」不叫「折扣」：线路那页那个加价的也叫倍率，同一类东西
                    该用同一族词，否则读起来像两个不相干的设置。用「进价」前缀区分方向 ——
                    一个是我付出去的，一个是用户付进来的。

                    而且这不只是换个词：说成折扣就会带出一条「不能大于 1」的上限，
                    上游那边的分组倍率本来就可以大于 1，比原价贵的替补出口也是合法配置。
                    服务端那条上限已经跟着一起拆了（见 clean_ratio）。
                  */}
                </div>
                <div>
                  <Label htmlFor="e-cap">能扛多少</Label>
                  <Input
                    id="e-cap"
                    value={draft.capacity}
                    placeholder="留空 = 不填"
                    onChange={(ev) => setDraft({ ...draft, capacity: ev.target.value })}
                  />
                  {/*
                    只在「首选被限流、要挑替补」时起作用。平时所有流量都走最便宜那个，
                    这个数一点作用都没有 —— 所以不填是完全正常的默认。
                  */}
                </div>
                <div>
                  <Label htmlFor="e-label">备注</Label>
                  <Input
                    id="e-label"
                    value={draft.label}
                    placeholder="转卖A"
                    onChange={(ev) => setDraft({ ...draft, label: ev.target.value })}
                  />
                </div>
              </div>
              {/*
                说明文字通栏放，不塞进三列格子里。塞进去的话每列只有一百来像素宽，
                一句话被切成六行四个字的豆腐块 —— 字都在，但没人会去读。
                输入框适合并排，解释性文字不适合。

                「倍率」那一段按用户要求删了，剩下的说明挪进了标签的 title：
                这个数在中转那边就叫倍率，照抄就行，不需要一整段文字讲它。
              */}
              <p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
                <b>能扛多少</b>：同条线路下用同一把尺（RPM 或随便一个相对值），
                只在别的出口被限流、要挑替补时才用到，平时留空就行。
              </p>
              <div>
                <Label htmlFor="e-proto">上游协议</Label>
                <Select
                  id="e-proto"
                  value={draft.protocol}
                  onChange={(ev) => setDraft({ ...draft, protocol: ev.target.value })}
                >
                  <option value="">跟线路一样</option>
                  <option value="anthropic">Anthropic 原生 /v1/messages</option>
                  <option value="openai">OpenAI 兼容 /chat/completions</option>
                  <option value="xai_responses">xAI Responses /v1/responses（grok 的思考摘要只在这条上给）</option>
                </Select>
                {/*
                  协议是「这条线怎么说话」，可以和线路不同 —— 官方直连走 Anthropic 原生，
                  而最便宜的那批转卖往往只提供 OpenAI 兼容。没有这一项，那批就挂不上来。
                */}
                <p className="mt-1 text-xs text-muted-foreground">
                  便宜的转卖常常只有 OpenAI 兼容口，这里可以和线路不一样。
                </p>
              </div>
              </div>

              {/* 右列：它有哪些模型 —— 这一块最高，单独占一列才不用滚 */}
              <div className="grid content-start gap-4">
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="e-models">这个出口有哪些模型</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={fetching || !draft.base_url.trim()}
                    onClick={() => void fetchModels()}
                  >
                    <ListChecks /> {fetching ? "问它…" : "问它有什么"}
                  </Button>
                </div>
                {/*
                  计费只读显示。加一个出口时你要知道它的流量会被按什么价计费，
                  但**计费是线路的属性**——同一条线路的几个出口对用户完全等价，
                  只有我的进价不同。让它在出口这一层可改，同一个模型用户被扣多少钱
                  就要看当时哪家先答，那正是整套多路由第一天就堵死的洞。
                */}
                {(() => {
                  const r = routeOf(draft.route_id);
                  if (!r) return null;
                  return (
                    <div className="mt-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
                      <span className="text-muted-foreground">这条线路怎么计费：</span>
                      <b>
                        {/*
                          按次计费**不乘倍率** —— cost_for 里 per_call 那一支直接
                          return per_call_cents，走不到 `usd * 100 * rate` 那行。
                          原来两种模式都写「× N 倍」，按次那一档是假的。
                        */}
                        {r.billing_mode === "per_call" ? "按次（不乘倍率）" : `按 Token × ${r.rate} 倍`}
                      </b>
                      {r.cache_disabled && <span className="text-muted-foreground">（缓存不收钱）</span>}
                      <span className="text-muted-foreground">
                        {" "}
                        · 走这个出口的流量按同一套价扣 —— 换出口不改用户账单，所以计费只能在
                        「线路」那页改。
                      </span>
                    </div>
                  );
                })()}
                <div className="mt-1.5 overflow-hidden rounded-lg border border-border">
                  {/*
                    表头：三个空输入框不写标题的话，没人分得出哪个是什么。

                    叫「输入价 / 输出价」，**绝不能叫「入价 / 出价」**。这个产品里
                    「进价」到处都指**你付给中转的成本**（对账、模型汇率都是这个意思），
                    而「入价」和它一字之差、读音也近 —— 而这两个框写进的是
                    `route.model_prices`，那是**用户付的价**。一个把进价填进来的人
                    会当场改掉客户账单，而且没有任何地方会提示他。
                    列宽和下面的行用同一套 grid，改一处要一起改。
                  */}
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_7rem_4.5rem_4.5rem_auto] items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span className="w-3" />
                    <span>模型</span>
                    <span>显示名</span>
                    <span>输入价</span>
                    <span>输出价</span>
                    <span />
                  </div>
                  {/*
                    高度跟着视口走，不是一个定值。弹窗自己封顶 88vh，而这张表是里面
                    唯一会长的东西 —— 写死 24rem 的话，1440×900 正好装得下，
                    换成 1280×800 就超 14px，于是又回到「两层滚动条套在一起」。
                    88vh 减去表以外那些（实测约 24rem）就是它能占的高度，短屏自动缩。
                    线上那个 89 款模型的出口就会撞到这个上限 —— 定值在那儿是真会溢出的。
                  */}
                  <div className="max-h-[min(24rem,calc(88vh-24rem))] overflow-y-auto">
                  {dedupeModels([
                    ...(routeOf(draft.route_id)?.models ?? []),
                    // 这个出口**自己带来的**（线路没有、之前勾过的）。原来不在这份清单里 ——
                    // 不重新拉取就看不见，而它们正是运维最想核对的那几个：
                    // 所有者「多路由那些勾选的模型看不到」说的就是这个。
                    ...draft.enabled_models,
                    // 这家有、线路没有的：勾上会新增到 IDE 列表。算不出价的也列出来，
                    // 但标红且勾不动 —— 让人看见「为什么这个不能用」，而不是它凭空消失。
                    ...(fetched?.extra ?? []),
                    ...(fetched?.extra_no_price ?? []),
                  ]).map((m) => {
                    // 一律走 hasModel：出口把 minimax-m3 写成 MiniMax-M3 时，这一行仍然是
                    // 「线路自己的」而不是「这个出口带来的」，勾选状态也认得出来。
                    const onRoute = hasModel(routeOf(draft.route_id)?.models ?? [], m);
                    const carried = !onRoute && hasModel(draft.enabled_models, m);
                    const isNew = !carried && !onRoute && hasModel(fetched?.extra ?? [], m);
                    const noPrice = hasModel(fetched?.extra_no_price ?? [], m);
                    const on =
                      draft.enabled_models.length === 0 || hasModel(draft.enabled_models, m);
                    const absent = hasModel(fetched?.missing ?? [], m);
                    return (
                      <label
                        key={m}
                        className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_7rem_4.5rem_4.5rem_auto] items-center gap-2 border-b border-border px-3 py-1.5 text-[13px] last:border-b-0 hover:bg-accent/40"
                      >
                        <input
                          type="checkbox"
                          checked={on && (!noPrice || bothPriced(m))}
                          disabled={noPrice && !bothPriced(m)}
                          onChange={(ev) => {
                            const all = routeOf(draft.route_id)?.models ?? [];
                            const cur = draft.enabled_models.length ? draft.enabled_models : all;
                            const next = ev.target.checked
                              ? dedupeModels([...cur, m])
                              : cur.filter((x) => !sameModel(x, m));
                            setDraft({ ...draft, enabled_models: next });
                          }}
                        />
                        <span
                          className={cn("truncate font-mono", noPrice && "text-destructive")}
                          title={m}
                        >
                          {m}
                        </span>
                        {/*
                          就地填价。它写到**线路**上（同线路的出口共用一份），不是写到
                          这个出口上。放在这儿只是因为「发现新模型」和「给它定价」是同一件事
                          的两半 —— 让人跑去另一页再回来，多数人会直接放弃，然后这个模型
                          就永远开放不了。
                        */}
                        <Input
                          className="h-7 w-full text-xs"
                          placeholder="显示名"
                          value={draft.names[m] ?? routeOf(draft.route_id)?.model_names?.[m] ?? ""}
                          onClick={(ev) => ev.preventDefault()}
                          onChange={(ev) =>
                            setDraft({ ...draft, names: { ...draft.names, [m]: ev.target.value } })
                          }
                        />
                        <Input
                          className="h-7 w-full text-xs"
                          placeholder={livePrice(m) ? String(livePrice(m)!.in) : "输入价"}
                          title={
                            livePrice(m)
                              // 现价（目录价）本身是美元，livePrice 已经按这条线路的币种折过了，
                              // 所以这里直接用，不再乘一次汇率。选人民币时不再并排显示美元：
                              // 一个框旁边摆两种货币，最容易发生的就是照着另一种的数字填。
                              ? `留空即按现价 ${sym(draft.route_id)}${livePrice(m)!.in}/1M 收。`
                                + `单位是${ccy(draft.route_id)}每百万 token，这是用户付的价。`
                              : `目录里没有这个模型的现价：要开放它，入价出价都得填（${ccy(draft.route_id)}每百万 token）`
                          }
                          value={
                            draft.prices[m]?.in ?? storedPrice(m, "in")
                          }
                          onClick={(ev) => ev.preventDefault()}
                          onChange={(ev) =>
                            setDraft({
                              ...draft,
                              prices: {
                                ...draft.prices,
                                [m]: { in: ev.target.value, out: draft.prices[m]?.out ?? storedPrice(m, "out") },
                              },
                            })
                          }
                        />
                        <Input
                          className="h-7 w-full text-xs"
                          placeholder={livePrice(m) ? String(livePrice(m)!.out) : "输出价"}
                          title={
                            livePrice(m)
                              // 现价（目录价）本身是美元，livePrice 已经按这条线路的币种折过了，
                              // 所以这里直接用，不再乘一次汇率。选人民币时不再并排显示美元：
                              // 一个框旁边摆两种货币，最容易发生的就是照着另一种的数字填。
                              ? `留空即按现价 ${sym(draft.route_id)}${livePrice(m)!.out}/1M 收。`
                                + `单位是${ccy(draft.route_id)}每百万 token，这是用户付的价。`
                              : `目录里没有这个模型的现价：要开放它，入价出价都得填（${ccy(draft.route_id)}每百万 token）`
                          }
                          value={
                            draft.prices[m]?.out ?? storedPrice(m, "out")
                          }
                          onClick={(ev) => ev.preventDefault()}
                          onChange={(ev) =>
                            setDraft({
                              ...draft,
                              prices: {
                                ...draft.prices,
                                [m]: { in: draft.prices[m]?.in ?? storedPrice(m, "in"), out: ev.target.value },
                              },
                            })
                          }
                        />
                        <span className="flex shrink-0 items-center gap-1">
                        {/*
                          和「线路」页同一套话：留空 = 跟随现价（绿），填了 = 摆出现价和倍数，
                          一键「用现价」清掉手填价。原来这一格什么都没有，价格框又是空的，
                          运维分不出「没定价」和「按现价收」—— 所有者：「没写的话也应该和线路那里
                          一样能用实时现价，或者我手动输入」。
                        */}
                        {(() => {
                          const live = livePrice(m);
                          if (!live) return null;
                          const filled = shownPrice(m, "in").trim() !== "" || shownPrice(m, "out").trim() !== "";
                          if (!filled) {
                            return (
                              <span
                                className="text-[11px] text-emerald-600"
                                title={`按 OpenRouter 现价收：${sym(draft.route_id)}${live.in}/${sym(draft.route_id)}${live.out} 每 1M，它降价你自动跟着降`}
                              >
                                跟随现价
                              </span>
                            );
                          }
                          const gap = priceGapOf(m);
                          return (
                            <>
                              <span
                                className={cn("text-[11px] tabular-nums", gap >= 2 ? "font-medium text-amber-600" : "text-muted-foreground")}
                                title={`OpenRouter 现价 $${live.in}/$${live.out} 每 1M`}
                              >
                                现价 {live.in}/{live.out}
                                {gap >= 1.1 && ` · 你 ${gap.toFixed(1)}×`}
                              </span>
                              <button
                                type="button"
                                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                                title="清掉手填价，改为跟随 OpenRouter 现价（保存后生效，同一条线路的几个出口共用这份价）"
                                onClick={(ev) => {
                                  ev.preventDefault();
                                  setDraft({ ...draft, prices: { ...draft.prices, [m]: { in: "", out: "" } } });
                                }}
                              >
                                用现价
                              </button>
                            </>
                          );
                        })()}
                        {carried && (
                          <Badge
                            variant="outline"
                            className="shrink-0"
                            title="线路自己没有这个模型，是这个出口带来的；取消勾选它就不再出现在 IDE 里（除非别的出口也带）"
                          >
                            这个出口带来的
                          </Badge>
                        )}
                        {isNew && (
                          <Badge variant="success" className="shrink-0">
                            这家新有
                          </Badge>
                        )}
                        {noPrice && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-destructive/40 text-destructive"
                            title={`目录里查不到这个模型的官方价。在左边两个价都填上（每百万 token ${ccy(draft.route_id)}）就能开放 —— 那是用户付的价，不是你的进价。不填的话用户一分不付、上游照收你的钱。`}
                          >
                            要填价
                          </Badge>
                        )}
                        {absent && (
                          <Badge variant="outline" className="border-destructive/40 text-destructive">
                            它没有
                          </Badge>
                        )}
                        </span>
                      </label>
                    );
                  })}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  「问它有什么」只会取消它没有的模型，<b>不会替你勾新模型</b>；它多出来的标「这家新有」，
                  勾上才会<b>新增到 IDE 的模型列表</b>，按这条线路的倍率计费。
                  <br />
                  <b className="text-foreground">输入价 / 输出价是「用户付多少」，不是你的进价。</b>
                  单位每百万 token {ccy(draft.route_id)}，最终扣费 = 这个价 × 这条线路的倍率。
                  <b>填了会存到线路上</b>（同一条线路的几个出口共用一份价，和「线路」那页是同一份）；
                  留空 = 按框里灰字写的现价收，它降价你自动跟着降；目录里没现价的要两个都填。
                  你付给中转的<b>进价</b>在「模型对账」里填，两者不是一回事 ——
                  把进价填到这儿会当场改掉客户账单。
                  全勾 = 承载这条线路的全部模型（以后线路加了新模型也自动跟着有）。
                  取消勾选的模型不会被派到这个出口——转卖商之间的货不一样，派过去只会撞一个 404。
                  {/*
                    原来这里还有半句「而每个请求只有 2 次机会」。那道闸已经拆了：
                    网关侧现在是时间预算（同一份文件 53 行和 507 行都在讲「挂多少个就能用多少个，
                    换几个出口由时间决定不由次数决定」）。一句过期的限制会让人不敢多挂出口。
                  */}
                </p>
              </div>

              </div>

              {/*
                页脚通栏。「投入轮转」和两个按钮放同一行：它是一个开关不是一段表单，
                塞进左列会把左右两列的高度差再拉开一截。
              */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 lg:col-span-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(ev) => setDraft({ ...draft, active: ev.target.checked })}
                  />
                  投入轮转（取消勾选 = 留着配置但不接任何请求）
                </label>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    取消
                  </Button>
                  <Button disabled={busy || !draft.base_url.trim()} onClick={() => void save()}>
                    {busy ? "保存并测试…" : "保存并测试"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
