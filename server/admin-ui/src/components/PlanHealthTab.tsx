import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Panel } from "@/components/Panel";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { num } from "@/lib/format";

/**
 * 套餐体检 —— 回答「这个套餐给多少额度合适」。
 *
 * # 为什么不是原来那个试算器
 *
 * 原来的是**正向**的：先猜一个额度，再算保本倍率。两个毛病：
 *  1. 要人先猜额度，而「猜多少」正是要问的那个问题；
 *  2. 成本那一步要人**手选一个渠道**。线上真实情况是流量分散在八个中转上，
 *     购买价从 ¥1 买 $10 到 ¥1 买 $1 差十倍 —— 随手选中便宜那条，算出来的成本
 *     就漂亮得不像话，而那不是你实际在付的钱。
 *
 * 这一屏反过来：用量、渠道构成、套餐配置全部从库里取真实值，直接告诉你现有几个套餐
 * 是偏紧、合适、还是可以更大方。
 */

type Burn = {
  p50: number; p75: number; p90: number; max: number;
  active_days_p50: number; payers: number; requests: number;
};
type Channel = {
  name: string; host: string; usd_per_cny: number;
  requests: number; sell_usd: number; cny: number | null; share: number;
};
type Plan = {
  plan: string; label: string | null;
  total_cents: number; window_cents: number; days: number;
  visible_usd: number; price_cny: number | null;
  cost_best: number | null; cost_blended: number | null; cost_worst: number | null;
  margin_blended: number | null;
  lasts_p50_days: number | null; lasts_p90_days: number | null;
};
type Health = {
  denominator: number; window_days: number; enough_sample: boolean; min_payers: number;
  burn: Burn; channels: Channel[];
  blended_usd_per_cny: number | null;
  best_usd_per_cny: number | null; worst_usd_per_cny: number | null;
  unpriced_sell_usd: number; zero_cost_share: number | null;
  /** 这一屏的金额是拿多少行算的。usable < total 说明窗口里还有一批 2026-08-28
   *  单位切换之前的旧行被排除在外 —— 那不是丢数据，是不混加。 */
  usable_rows: number; total_rows: number; usable_since: string | null;
  /** 探针实测：这段时间中转账户真掉了多少上游美元、对应多少面值额度。没攒够样本时是 null。 */
  measured: {
    upstream_usd: number; visible_usd: number; requests: number;
    hours: number; upstream_per_visible_usd: number;
  } | null;
  plans: Plan[];
};

const cny = (v?: number | null) => (v == null ? "—" : `¥${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const usd = (v?: number | null) => (v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const days = (v?: number | null) => (v == null ? "—" : v >= 999 ? "999+ 天" : `${Math.round(v)} 天`);

/**
 * 一个套餐的判定。四档，判据都写在这里而不是散在渲染里。
 *
 * 「撑不到期」用的是**中位付费用户**：如果一半的付费用户在套餐到期前就把额度烧完，
 * 那这个额度就是偏紧的——用户的体感是「不抗用」，而这正是老板要避免的。
 * 「可以更大方」用的是 p90：连最重的那一档都用不掉一半，说明额度堆着没人用，
 * 那这份大方没花在刀刃上，不如把数字做得更好看（面值调大）或把价压下来。
 */
/**
 * `lasts_*_days` 的单位是**活跃日**，套餐的 `days` 是**自然日**，两者不能直接比。
 *
 * 一个用户 30 天里只有 12 天在用（线上实测中位活跃 2 天、p90 9 天），
 * 「12 个活跃日用光」不等于「第 12 天就用光了」—— 按自然日算他能撑到期。
 * 原来直接 `lasts_p50_days < p.days`，于是几乎每一档都被判成「偏紧」，
 * 而那个判定会直接推着人去加额度。
 *
 * 换算：活跃日 ÷ 占空比 = 自然日，占空比 = 中位活跃天数 ÷ 统计窗口天数。
 */
const toCalendarDays = (activeDays: number, h: Health) => {
  const duty = h.burn.active_days_p50 / Math.max(h.window_days, 1);
  return duty > 0 ? activeDays / duty : activeDays;
};

function verdict(p: Plan, h: Health) {
  if (p.price_cny == null) return { tone: "muted", text: "没有对应商品", why: "plan_quotas 里有这一档，但商品表里没有在售的对应商品。" };
  if (p.margin_blended != null && p.margin_blended < 0)
    return { tone: "danger", text: "亏本", why: `按现在的渠道构成，用户把额度用完要花 ${cny(p.cost_blended)}，比售价还高。` };
  if (p.lasts_p50_days != null && toCalendarDays(p.lasts_p50_days, h) < p.days)
    return {
      tone: "warn",
      text: "偏紧",
      why: `一半的付费用户会在第 ${Math.round(p.lasts_p50_days)} 个活跃日用光 —— 按他们的实际使用节奏（${h.window_days} 天里活跃 ${Math.round(h.burn.active_days_p50)} 天）折合约 ${Math.round(toCalendarDays(p.lasts_p50_days, h))} 个自然日，而套餐是 ${p.days} 天的。`,
    };
  if (p.lasts_p90_days != null && toCalendarDays(p.lasts_p90_days, h) > p.days * 2)
    return { tone: "ok", text: "可以更大方", why: `连最重的那一档用户都只用掉不到一半。额度堆着没人用，不如把面值做得更好看。` };
  return { tone: "ok", text: "合适", why: "中位用户用得到期，重度用户也不会一天烧光。" };
}

const toneBadge = (t: string) =>
  t === "danger" ? <Badge variant="outline" className="border-red-500/50 text-red-600 dark:text-red-400">亏本</Badge>
  : t === "warn" ? <Badge variant="outline">偏紧</Badge>
  : t === "muted" ? <Badge variant="secondary">无商品</Badge>
  : null;

export function PlanHealthTab() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState("");
  // 额度建议器的两个输入。
  //
  // 售价**不写死**：以前是 "295"，抄的是主力档当时的价。运营在后台改了价，这个默认值不会动，
  // 于是这一屏最醒目的那个「建议面值额度」会继续按一个已经不存在的售价算。
  // 现在等接口回来，用**服务端下发的真实售价**里最贵的那一档来播种（那是主力走量的位置）。
  // 毛利 50% 是个目标，不是事实，写死没问题 —— 它本来就该由人来定。
  const [price, setPrice] = useState("");
  const [margin, setMargin] = useState("50");

  useEffect(() => {
    let alive = true;
    api.get<Health>("/api/admin/plan-health")
      .then((r) => {
        if (!alive) return;
        setH(r); setErr("");
        setPrice((cur) => {
          if (cur) return cur;
          const top = (r.plans || [])
            .filter((x) => typeof x.price_cny === "number" && x.price_cny! > 0)
            .sort((a, b) => (b.price_cny || 0) - (a.price_cny || 0))[0];
          return top?.price_cny ? String(top.price_cny) : "";
        });
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "读取失败"); });
    return () => { alive = false; };
  }, []);

  /**
   * 反推：卖 P 元、留 m% 毛利，能给多少额度。
   *
   * 成本预算 = P × (1 − m)。它能买到的真实额度 = 预算 × 综合购买价 × 100（分）。
   * 面值美元 = 真实分 ÷ 分母。
   *
   * 用**综合购买价**而不是最便宜那条：流量不会全落在最便宜那条上，按它算等于给自己
   * 一个买不到的成本。下面同时把「最好 / 最差」两条也列出来，看得见区间。
   */
  const suggestion = useMemo(() => {
    if (!h) return null;
    const p = Number.parseFloat(price);
    const m = Number.parseFloat(margin);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(m) || m < 0 || m >= 100) return null;
    const budget = p * (1 - m / 100);
    const at = (rate: number | null) =>
      rate && rate > 0 ? { raw: budget * rate * 100, visible: (budget * rate * 100) / h.denominator } : null;
    const blended = at(h.blended_usd_per_cny);
    return {
      budget,
      blended,
      best: at(h.best_usd_per_cny),
      worst: at(h.worst_usd_per_cny),
      lastsP50: blended && h.enough_sample && h.burn.p50 > 0 ? blended.raw / h.burn.p50 : null,
      lastsP90: blended && h.enough_sample && h.burn.p90 > 0 ? blended.raw / h.burn.p90 : null,
    };
  }, [h, price, margin]);

  if (err) return <ErrorState message={err} />;
  if (!h) return <EmptyState title="读取中" hint="正在从真实用量和渠道构成里算。" />;

  const b = h.burn;
  const unpricedShare = h.unpriced_sell_usd > 0 && h.channels.length
    ? h.unpriced_sell_usd / h.channels.reduce((a, c) => a + c.sell_usd, 0)
    : 0;
  const placeholderish = h.channels.filter((c) => c.usd_per_cny === 1 && c.sell_usd > 0);

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="付费用户日耗（中位）"
          value={`${num(Math.round(b.p50))} 真实分`}
          hint={h.enough_sample ? `${b.payers} 个付费用户 · 最近 ${h.window_days} 天` : `样本只有 ${b.payers} 人，不足 ${h.min_payers} 人不给分位数`}
        />
        <Stat label="重度用户日耗（p90）" value={`${num(Math.round(b.p90))} 真实分`} hint={`最高的一天 ${num(Math.round(b.max))}`} />
        <Stat label="活跃天数（中位）" value={`${Math.round(b.active_days_p50)} 天`} hint="一个付费用户一个周期里真正用的天数" />
        <Stat
          label="综合渠道购买价"
          value={h.blended_usd_per_cny ? `¥1 → $${h.blended_usd_per_cny.toFixed(2)}` : "—"}
          hint={
            h.best_usd_per_cny && h.worst_usd_per_cny
              ? `最好 $${h.best_usd_per_cny.toFixed(0)} · 最差 $${h.worst_usd_per_cny.toFixed(0)}`
              : "还没有渠道购买价"
          }
        />
      </section>

      {h.measured && (
        <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm">
          <div className="font-medium">
            实测：每 $1 面值额度，中转账户真掉了 ${h.measured.upstream_per_visible_usd.toFixed(2)} 上游额度
          </div>
          <p className="mt-2 text-muted-foreground">
            这是余额探针在 {h.measured.hours.toFixed(0)} 小时里量出来的（掉账 $
            {h.measured.upstream_usd.toFixed(2)} ÷ 同期消耗 ${h.measured.visible_usd.toFixed(2)} 面值，
            {num(h.measured.requests)} 次请求），**不经过任何价目表**，所以没有「售价当成本」那层偏差。
            上面那些按倍率推算的成本，可以拿它对一下：推算用的是 {h.denominator / 100} ÷ 线路倍率，
            实测是 {h.measured.upstream_per_visible_usd.toFixed(2)} —— 两者差得多，说明倍率不是唯一的加价层。
          </p>
          <p className="mt-2 text-muted-foreground">
            只给总量，不分站：额度按线路归属，而请求会 failover 到别的站的出口，
            「这个站掉的钱」和「归到这个站的额度」不是同一批请求。总量上这些错配互相抵消，分站不行。
            换成人民币还要乘各站的充值汇率，那一项仍然是你手填的。
          </p>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm">
        <div className="font-medium">这几个数是有偏的，而且两个方向相反 —— 当区间看，别当准数</div>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            · <b>日耗是下限。</b>
            {h.zero_cost_share != null && ` 有 ${(h.zero_cost_share * 100).toFixed(0)}% 的请求记成 0 分`}
            （线路被删、模型在该线路没配价、以及订阅用户额度见底后由运营吸收的超支），
            token 照跑但不计入。所以真实用量比这里高，「能撑几天」是偏乐观的。
          </li>
          <li>
            · <b>成本是上限。</b> 扣用户的额度里含**两层**加价：线路倍率，以及每个模型自己挂的
            单价（线上有目录 $5、你挂 $15 的）。这里只除掉了倍率那一层，所以折出来的人民币
            成本比真实采购价高。真要算准，得把各出口的进价录进「出口明细」。
          </li>
        </ul>
      </div>

      {(unpricedShare > 0.02 || placeholderish.length > 0) && (
        <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm">
          <div className="font-medium">还有两个已知缺口</div>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {unpricedShare > 0.02 && (
              <li>
                · 有 {(unpricedShare * 100).toFixed(0)}% 的真实消耗跑在**没填购买价**的中转上，
                这部分按 0 元算不进成本 —— 实际成本比下面列的高。
              </li>
            )}
            {placeholderish.length > 0 && (
              <li>
                · {placeholderish.map((c) => c.host || c.name).join("、")} 的购买价填的是「¥1 买 $1」。
                如果那是占位符而不是真实价，这几条线的成本会差十倍，而它们占了{" "}
                {(placeholderish.reduce((a, c) => a + c.share, 0) * 100).toFixed(0)}% 的消耗。
              </li>
            )}
          </ul>
        </div>
      )}

      <Panel title="现有套餐体检">
        <Table className="min-w-[64rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">套餐</TableHead>
              <TableHead numeric className="w-28">面值额度</TableHead>
              <TableHead numeric className="w-24">售价</TableHead>
              <TableHead numeric className="w-32">用完的成本</TableHead>
              <TableHead numeric className="w-24">毛利率</TableHead>
              <TableHead numeric className="w-40">能撑几个活跃日</TableHead>
              <TableHead className="w-56">判定</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {h.plans.map((p) => {
              const v = verdict(p, h);
              return (
                <TableRow key={p.plan}>
                  <TableCell>
                    <div className="font-medium">{p.label || p.plan}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.plan} · {p.days} 天 · 时段上限 {num(p.window_cents)}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    {usd(p.visible_usd)}
                    <div className="text-xs text-muted-foreground">{num(p.total_cents)} 真实分</div>
                  </TableCell>
                  <TableCell numeric>{cny(p.price_cny)}</TableCell>
                  <TableCell numeric>
                    {cny(p.cost_blended)}
                    <div className="text-xs text-muted-foreground">
                      最好 {cny(p.cost_best)} · 最差 {cny(p.cost_worst)}
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    {p.margin_blended == null ? "—" : `${p.margin_blended.toFixed(0)}%`}
                  </TableCell>
                  <TableCell numeric>
                    {days(p.lasts_p50_days)}
                    <div className="text-xs text-muted-foreground">重度 {days(p.lasts_p90_days)}</div>
                  </TableCell>
                  <TableCell>
                    {toneBadge(v.tone)}
                    <div className="mt-1 text-xs text-muted-foreground">{v.why}</div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <Panel title="反过来算：卖这个价，该给多少额度">
          <div className="space-y-4 p-5">
            <div>
              <Label htmlFor="ph-price">套餐售价（¥）</Label>
              <Input id="ph-price" type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ph-margin">想留多少毛利（%）</Label>
              <Input id="ph-margin" type="number" min="0" max="99" step="1" value={margin} onChange={(e) => setMargin(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">
              按**综合**渠道购买价算，不是按最便宜那条 —— 流量不会全落在最便宜那条上，
              按它算等于给自己一个买不到的成本。
            </p>
          </div>
        </Panel>

        <Panel title="建议">
          {!suggestion ? (
            <EmptyState compact title="填个售价和毛利率" hint="两个都填了才算得出来。" />
          ) : (
            <div className="divide-y divide-border">
              <Row label="成本预算" value={cny(suggestion.budget)} hint={`售价 × (1 − 毛利率)`} />
              <Row
                label="建议面值额度"
                value={usd(suggestion.blended?.visible)}
                hint={suggestion.blended ? `${num(Math.round(suggestion.blended.raw))} 真实分 · 页面上写给用户看的就是左边这个数` : "还没有综合购买价"}
                strong
              />
              <Row
                label="同样的钱在最好/最差渠道上"
                value={`${usd(suggestion.best?.visible)} / ${usd(suggestion.worst?.visible)}`}
                hint="渠道购买价差十倍，能给的额度就差十倍"
              />
              <Row
                label="中位付费用户能用"
                value={days(suggestion.lastsP50)}
                hint={h.enough_sample ? `按每活跃日 ${num(Math.round(b.p50))} 真实分算` : "样本不足，不给这个数"}
              />
              <Row
                label="重度用户能用"
                value={days(suggestion.lastsP90)}
                hint={h.enough_sample ? `按每活跃日 ${num(Math.round(b.p90))} 真实分算` : "样本不足，不给这个数"}
              />
            </div>
          )}
        </Panel>
      </div>

      <Panel title={`真实流量落在哪些中转上（最近 ${h.window_days} 天）`}>
        {h.total_rows > h.usable_rows && (
          <div className="mb-3 text-xs text-muted-foreground">
            窗口里 {num(h.total_rows)} 次调用，其中 {num(h.usable_rows)} 次的金额单位是可辨的，
            上面的钱只按这一批算。其余是 2026-08-28 计费单位切换之前写下的行，
            当时的「真实计费分」是美元分、之后是人民币分，混着相加会差 7.1 倍。
            {h.usable_since ? ` 可用数据从 ${new Date(h.usable_since).toLocaleDateString()} 起。` : ""}
          </div>
        )}
        <Table className="min-w-[52rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">连接</TableHead>
              <TableHead className="w-56">地址</TableHead>
              <TableHead numeric className="w-32">渠道购买价</TableHead>
              <TableHead numeric className="w-24">占消耗</TableHead>
              <TableHead numeric className="w-28">售价</TableHead>
              <TableHead numeric className="w-28">人民币成本</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {h.channels.map((c) => (
              <TableRow key={`${c.name}-${c.host}`}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">{c.host || "—"}</TableCell>
                <TableCell numeric>
                  {c.usd_per_cny > 0 ? `¥1 → $${c.usd_per_cny}` : <span className="text-muted-foreground">没填</span>}
                </TableCell>
                <TableCell numeric>{(c.share * 100).toFixed(1)}%</TableCell>
                <TableCell numeric>{usd(c.sell_usd)}</TableCell>
                <TableCell numeric>{c.cny == null ? "—" : cny(c.cny)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}

function Row({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-3">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className={strong ? "text-xl font-semibold tabular-nums" : "tabular-nums"}>{value}</div>
    </div>
  );
}
