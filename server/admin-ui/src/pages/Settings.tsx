import { useEffect, useMemo, useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { SectionReveal } from "@/components/motion/section-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { cents } from "@/lib/format";
import { applySettings, creditCentsFromRaw, fxRateEditable, memberTierSupported, useSettings, type AdminSettings, type PlanQuota } from "@/lib/settings";

/**
 * 设置 —— 三个原本写死在代码里的运营参数，现在落在 app_settings / plan_quotas 表里。
 *
 * 这一屏之所以来得比想象中晚，是因为面值分母（663）曾经在四个文件里各有一份副本，
 * 其中三份在**写路径**上：运营输入的美元由前端乘 663 变成存库的真实分，服务端不做二次
 * 换算。只把服务端那份改成可配置，"发出去多少额度"会当场和"显示多少"对不上，而且不会
 * 有任何报错。所以先把四份合成一份（服务端下发，见 lib/settings.ts），才有这一屏。
 *
 * 每一项的生效范围都不一样，页面上必须逐条写清楚，因为它们都不可从界面上看出来：
 *  - 面值分母：只改**显示**。已有余额存的是真实分，不会变多也不会变少；改完之后同一笔
 *    余额显示成不同的面值美元。真正受影响的是**之后**发出去的额度。
 *  - 每日赠送：池子按 用户 × 自然日 存，今天已经领过的人要到明天日切才拿到新数。
 *  - 套餐额度：兑换时写进用户表，之后没有任何地方重新推导，所以改了**不会**追改已订阅
 *    的用户。
 */

const MONEY_SAMPLE_CREDIT_USD = 12.34;

/** 面值分母以"分"存储（663），但运营脑子里的单位是"美元"（6.63）。输入框用后者。 */
const toDollars = (rawCents: number) => (rawCents / 100).toFixed(2);
const toRawCents = (dollars: string) => Math.round((Number.parseFloat(dollars) || 0) * 100);

/**
 * 草稿里存的是**美元字符串**，不是分。
 *
 * 之前这三列直接把 5000 / 33000 / 500000 这样的整数分摆进输入框，标题也没有单位。
 * 结果是同一个框可以读成 $5000、$50、或者旁边那列印的 $7.54 —— 看起来像点数刻度，
 * 而这几个数是真金白银。控制台里其他每一个金额输入框（充值、赠送额度）都是美元，
 * 这里也必须是。
 */
type PlanDraft = Record<string, { total: string; window: string; weekly: string; days: string }>;

function planDraftFrom(plans: PlanQuota[]): PlanDraft {
  const d: PlanDraft = {};
  for (const p of plans) {
    d[p.plan] = {
      total: toDollars(p.total_cents),
      window: toDollars(p.window_cents),
      weekly: toDollars(p.weekly_cents),
      days: String(p.days),
    };
  }
  return d;
}

/** 万分比 → 「1 美元 = 多少人民币」。拿不到就空串（**不给默认值**，见 cnyPerUsd）。 */
function fxToYuan(bps: number | undefined): string {
  return typeof bps === "number" && bps > 0 ? String(Number((10000 / bps).toFixed(4))) : "";
}
/** 「1 美元 = 多少人民币」→ 万分比。输入非法回 0，调用方据此拒绝提交。 */
function yuanToFx(text: string): number {
  const n = parseFloat(String(text).trim());
  return Number.isFinite(n) && n > 0 ? Math.round(10000 / n) : 0;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

export function Settings() {
  const live = useSettings();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const [denomInput, setDenomInput] = useState(toDollars(live.raw_cents_per_credit_usd));
  /**
   * 汇率输入框用「1 美元 = 多少人民币」（7.10），因为那是运营脑子里的数；
   * 库里存的是它的**倒数的万分比**（1 人民币分折多少美元分，1408）。
   * 两个方向都在这一屏换算，别把万分比摆到用户面前 —— 1408 这个数没有人能一眼判断对错。
   */
  const [fxInput, setFxInput] = useState(fxToYuan(live.usd_per_cny_bps));
  const [freeInput, setFreeInput] = useState(String(live.free_points_daily));
  /**
   * 会员那一档的草稿。**空串 = 跟随非会员**（提交 `_clear: true`），填 0 = 关掉会员的
   * 免费额度。别把它写成 `Number.parseInt(x,10) || 0` 一把梭 —— 那样清空输入框会把全体
   * 会员的免费额度当天起归零，而后端不报任何错。
   */
  const [memberInput, setMemberInput] = useState(
    live.free_points_daily_member == null ? "" : String(live.free_points_daily_member),
  );
  /** 这台网关认不认第二档。见 lib/settings.ts 的 memberTierSupported。 */
  const [hasMemberTier, setHasMemberTier] = useState(memberTierSupported(live));
  const [plans, setPlans] = useState<PlanDraft>({});
  const [confirmDenom, setConfirmDenom] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  /** 两档共用一个换算：1 点 = raw_cents_per_point 真实计费分（服务端下发的只读常量）。 */
  // 每日赠送折成多少真实计费分。换算由服务端推导后下发（100 积分 = ¥1 + 后台汇率），
  // 前端不再自己假设一个点价 —— 那正是两边会漂开的地方。
  const dailyCost = (points: number) => cents(Math.round(points * live.raw_cents_per_point));
  /** 每日赠送折成人民币，直接说出来：这一屏的数字里只有它是运营真正在决定的。 */
  const dailyCny = (points: number) => (points * (live.cny_cents_per_point ?? 1) / 100).toFixed(2);
  const freePoints = Number.parseInt(freeInput, 10) || 0;
  const memberTrimmed = memberInput.trim();
  const memberSet = memberTrimmed !== "";
  const memberPoints = Number.parseInt(memberTrimmed, 10) || 0;
  const savedMemberText =
    live.free_points_daily_member == null ? "" : String(live.free_points_daily_member);
  const freeDirty = String(live.free_points_daily) !== freeInput.trim();
  const memberDirty = hasMemberTier && savedMemberText !== memberTrimmed;
  /** 会员按这个草稿最终会拿多少 —— 空串跟随非会员那一档。 */
  const memberEffective = memberSet ? memberPoints : freePoints;

  const refresh = async () => {
    setLoading(true);
    setErr("");
    try {
      const s = await api.get<AdminSettings>("/api/admin/settings");
      applySettings(s);
      setDenomInput(toDollars(s.raw_cents_per_credit_usd));
      setFreeInput(String(s.free_points_daily));
      setMemberInput(s.free_points_daily_member == null ? "" : String(s.free_points_daily_member));
      setHasMemberTier(memberTierSupported(s));
      setPlans(planDraftFrom(s.plans || []));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "读取设置失败");
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const savedDenom = live.raw_cents_per_credit_usd;
  const draftDenom = toRawCents(denomInput);
  const denomValid =
    draftDenom >= live.limits.raw_cents_per_credit_usd[0] &&
    draftDenom <= live.limits.raw_cents_per_credit_usd[1];
  const denomChanged = denomValid && draftDenom !== savedDenom;

  /**
   * 影响面预览。用一笔固定的真实分（现在正好显示成 $12.34）算出改完之后显示成多少 ——
   * 真实分一分没动，动的只是它显示成几美元。这是这个数唯一会立刻改变的东西。
   */
  const preview = useMemo(() => {
    const rawCents = Math.round(MONEY_SAMPLE_CREDIT_USD * savedDenom);
    const after = draftDenom > 0 ? Math.round((rawCents / draftDenom) * 100) : 0;
    return { rawCents, before: Math.round(MONEY_SAMPLE_CREDIT_USD * 100), after };
  }, [savedDenom, draftDenom]);

  const save = async (body: Record<string, unknown>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<AdminSettings>("/api/admin/settings", body);
      applySettings(r);
      setDenomInput(toDollars(r.raw_cents_per_credit_usd));
      if (typeof r.usd_per_cny_bps === "number") setFxInput(fxToYuan(r.usd_per_cny_bps));
      setFreeInput(String(r.free_points_daily));
      // 保存接口返回的**是另一份更小的 JSON**（settings.rs::admin_put 结尾那个 json!，
      // 没有 limits、没有 raw_cents_per_point），所以这里只按值回填，不去重算「支不支持」。
      if ("free_points_daily_member" in (r as object)) {
        setMemberInput(r.free_points_daily_member == null ? "" : String(r.free_points_daily_member));
      }
      if (r.plans) setPlans(planDraftFrom(r.plans));
      setMsg({ text: okText, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "保存失败", ok: false });
    }
    setBusy(false);
  };

  const savePlans = () => {
    const list = Object.entries(plans).map(([plan, d]) => ({
      plan,
      total_cents: toRawCents(d.total),
      window_cents: toRawCents(d.window),
      weekly_cents: toRawCents(d.weekly),
      days: Number.parseInt(d.days, 10) || 0,
    }));
    const bad = list.find((p) => p.window_cents <= 0);
    if (bad) {
      setMsg({
        text: `${bad.plan}：时段上限必须大于 0 —— 填 0 不是"不限"，是把这个套餐永久锁死`,
        ok: false,
      });
      return;
    }
    save({ plans: list }, "套餐额度已保存（只影响之后的开通与兑换）");
  };

  if (err) return <ErrorState message={err} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="设置"
        description="面值、每日赠送、套餐额度。改这里之前先看清每一项的生效范围 —— 三项都不一样。"
        actions={
          <Button variant="outline" onClick={refresh} disabled={loading || busy}>
            {loading ? "读取中…" : "重新读取"}
          </Button>
        }
      />

      {msg && (
        <SectionReveal>
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              msg.ok
                ? "border-border bg-secondary/40 text-foreground"
                : "border-border bg-secondary/40 text-foreground"
            }`}
          >
            <Badge variant={msg.ok ? "success" : "outline"}>{msg.ok ? "已保存" : "未保存"}</Badge>
            <span className="ml-2">{msg.text}</span>
          </div>
        </SectionReveal>
      )}

      {/*
        结算汇率。这一格 2026-09-08 才补上：在此之前汇率**只能改数据库**，而上面那段
        「由 1 点 = 1 人民币分和下面那格汇率推导，改汇率它自动跟上」的文案早就写着它 ——
        那格 UI 一直不存在。线路按人民币报价（模型线路 → 线路 / 多路由）直接踩在它上面：
        汇率错，录进去的每一条人民币价都错，而屏幕上看不出来。
      */}
      {fxRateEditable(live) && (
        <SectionReveal delay={60}>
          <Panel title="结算汇率" bodyClassName="p-5">
            <div className="max-w-md">
              <Label htmlFor="fx">1 美元 = 多少人民币</Label>
              <Input
                id="fx"
                inputMode="decimal"
                value={fxInput}
                onChange={(e) => setFxInput(e.target.value)}
                className="mt-1.5"
              />
              <Hint>
                当前 <span className="tabular-nums">¥{fxToYuan(live.usd_per_cny_bps) || "—"}</span>。
                两个地方用它：<b>每一笔扣费</b>（计价全程按美元算，最后一步折成用户钱包的人民币口径），
                以及<b>线路按人民币报价时的折算</b>。
                改它<b>不会改写任何已存的价</b> —— 那是当初谈定的价，不该随汇率漂；
                也不改动任何人已有的余额，改的是往后每一笔的折算。
              </Hint>
              <Button
                className="mt-3"
                disabled={busy || yuanToFx(fxInput) <= 0 || yuanToFx(fxInput) === live.usd_per_cny_bps}
                onClick={() => void save({ usd_per_cny_bps: yuanToFx(fxInput) }, "汇率已更新")}
              >
                保存汇率
              </Button>
              {fxInput.trim() !== "" && yuanToFx(fxInput) <= 0 && (
                <Hint>填一个大于 0 的数，比如 7.10。</Hint>
              )}
            </div>
          </Panel>
        </SectionReveal>
      )}

      <SectionReveal delay={70}>
        <Panel title="额度面值（混合汇率）" bodyClassName="p-5">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
            <div>
              <Label htmlFor="denom">1 美元面值额度 = 多少美元真实成本</Label>
              <Input
                id="denom"
                inputMode="decimal"
                value={denomInput}
                onChange={(e) => setDenomInput(e.target.value)}
                className="mt-1.5"
              />
              <Hint>
                当前 <span className="tabular-nums">{toDollars(savedDenom)}</span>（
                {savedDenom} 真实计费分 = 客户看到的 $1.00）。这是卖出的 1 美元额度对应的上游
                真实成本，不是人民币汇率 —— 渠道的购买价在「模型线路」里按渠道单独填。
              </Hint>
              <Button
                className="mt-3"
                disabled={!denomChanged || busy}
                onClick={() => {
                  setConfirmText("");
                  setConfirmDenom(true);
                }}
              >
                修改面值…
              </Button>
              {!denomValid && (
                <Hint>
                  需在 {toDollars(live.limits.raw_cents_per_credit_usd[0])} ~{" "}
                  {toDollars(live.limits.raw_cents_per_credit_usd[1])} 之间。
                </Hint>
              )}
            </div>

            <div className="rounded-xl border border-border bg-secondary/40 p-4">
              <h3 className="text-sm font-semibold">改完之后会发生什么</h3>
              <dl className="mt-3 space-y-3 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">一笔现在显示 {cents(preview.before)} 的余额</dt>
                  <dd className="tabular-nums font-medium">
                    {denomChanged ? `${cents(preview.before)} → ${cents(preview.after)}` : cents(preview.before)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">它存的真实计费分</dt>
                  <dd className="tabular-nums font-medium">
                    {preview.rawCents} → {preview.rawCents}
                  </dd>
                </div>
              </dl>
              <Hint>
                <strong className="font-medium text-foreground">能花的钱一分没变</strong>
                ：余额、套餐额度都是按真实计费分存的，结算也按真实分扣，改面值不碰它们。变的是
                同一笔真实分显示成多少面值美元 —— 客户会看到余额数字变了，却没有发生任何交易。
              </Hint>
              <Hint>
                真正受影响的是<strong className="font-medium text-foreground">之后</strong>发出去的额度：
                同样标价的商品，改完之后卖出去的那份真实额度不一样。已创建的商品、未支付的订单、
                未兑换的兑换码，真实分在创建时就冻结了，不会被追改。
              </Hint>
            </div>
          </div>
        </Panel>
      </SectionReveal>

      <SectionReveal delay={140}>
        <Panel title="每日赠送" bodyClassName="p-5">
          {/* 左栏从 20rem 放宽到 32rem：里面从一个输入框变成两个，20rem 塞不下两个 h-12。 */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,32rem)_1fr]">
            <div>
              {/*
                两档**并排**，不是上下堆。运营在这一屏真正要判断的是「会员比非会员多多少」，
                那是个相对量；一上一下、中间还各夹一段说明文字，就没法一眼比。
                非会员在左：它是基准，会员那档是在它之上的加码，阅读顺序跟着这个走。
              */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="free">非会员 · 每天赠送点数</Label>
                  <Input
                    id="free"
                    inputMode="numeric"
                    value={freeInput}
                    onChange={(e) => setFreeInput(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="free-member">会员 · 每天赠送点数</Label>
                  <Input
                    id="free-member"
                    inputMode="numeric"
                    value={memberInput}
                    onChange={(e) => setMemberInput(e.target.value)}
                    disabled={!hasMemberTier}
                    placeholder={
                      hasMemberTier ? `跟随非会员（${live.free_points_daily} 点）` : "网关尚未支持"
                    }
                    className="mt-1.5"
                  />
                </div>
              </div>

              {!loading && !hasMemberTier && (
                <Hint>
                  这台网关的设置接口里还没有会员这一档 —— 控制台和网关是两次独立发布，
                  <strong className="font-medium text-foreground">先把网关发上去</strong>
                  ，再回来刷新这一页，这个框就会解禁。在那之前所有人（包括会员）拿的都是
                  左边那一档，和现在完全一样。
                </Hint>
              )}

              <Hint>
                非会员当前 <span className="tabular-nums">{live.free_points_daily}</span> 点，
                每人每天 ¥{dailyCny(live.free_points_daily)}（{dailyCost(live.free_points_daily)} 真实成本）。
                {hasMemberTier &&
                  (live.free_points_daily_member == null ? (
                    <> 会员<strong className="font-medium text-foreground">没单独配</strong>，跟随非会员这一档。</>
                  ) : (
                    <>
                      {" "}会员当前 <span className="tabular-nums">{live.free_points_daily_member}</span> 点，
                      每人每天 ¥{dailyCny(live.free_points_daily_member)}（{dailyCost(live.free_points_daily_member)}）
                      {live.free_points_daily_member > live.free_points_daily && (
                        <>（比非会员每人每天多 ¥{dailyCny(live.free_points_daily_member - live.free_points_daily)}）</>
                      )}
                      。
                    </>
                  ))}
                {" "}100 积分 = ¥1（1 点 = {live.raw_cents_per_point.toFixed(4)} 真实计费分），两档同一个换算。非会员那格
                填 0 等于关掉免费额度。
                {hasMemberTier && (
                  <>
                    {" "}会员那格
                    <strong className="font-medium text-foreground">留空 = 跟随非会员</strong>
                    ，<strong className="font-medium text-foreground">填 0 = 关掉会员的免费额度</strong>
                    —— 这两个不是一回事。
                  </>
                )}
              </Hint>

              {hasMemberTier && memberSet && memberPoints < freePoints && (
                <Hint>
                  <strong className="font-medium text-foreground">会员这一档比非会员少。</strong>
                  不拦你 —— 会员的额度也可能是有意走套餐而不走免费池。但两个框填反了长得
                  一模一样，而且发出去之前没有任何别的地方会提醒你。
                </Hint>
              )}

              {/*
                **一个保存按钮，两档一次提交**，不是各存各的。
                这两个数的含义是相对的：分成两次保存，中间必然有一段「非会员 500 / 会员 300」
                这样**已经生效**的中间态，而发放是懒发放 —— 那几秒里恰好当天第一次调用的人
                就照着中间态领走了，且不结转、不补差。admin_put 本来就是一个事务里 COALESCE
                每个字段，一次 POST 就没有这道缝。
                只提交改过的那一档：两个都发会把没动过的那档也重写一遍 updated_by/updated_at，
                审计日志就说不清这次到底改了什么。
              */}
              <Button
                className="mt-3"
                disabled={busy || (!freeDirty && !memberDirty)}
                onClick={() => {
                  const body: Record<string, unknown> = {};
                  if (freeDirty) body.free_points_daily = freePoints;
                  if (memberDirty) {
                    // 空串是「跟随」，必须发 clear 而不是 0 —— 0 是「关掉会员免费额度」。
                    if (memberSet) body.free_points_daily_member = memberPoints;
                    else body.free_points_daily_member_clear = true;
                  }
                  save(
                    body,
                    `已保存（非会员 ${freePoints} 点${
                      hasMemberTier ? ` · 会员 ${memberEffective} 点` : ""
                    }，每个人要到他下一次日切后的第一次调用才拿到新数）`,
                  );
                }}
              >
                保存
              </Button>
            </div>
            <div className="rounded-xl border border-border bg-secondary/40 p-4">
              <h3 className="text-sm font-semibold">生效时间</h3>
              <Hint>
                免费池是按 <strong className="font-medium text-foreground">用户 × 自然日</strong> 存下来的：
                只有当用户当天第一次调用时，才会把当天的额度写进去。所以今天已经用过的人，池子里
                还是今天发的那份，改完不会立刻变多或变少 —— 新数字在他们
                <strong className="font-medium text-foreground">下一次日切之后</strong>的第一次调用生效。
              </Hint>
              <Hint>
                <strong className="font-medium text-foreground">
                  是会员还是非会员，在发放的那一刻判一次，当天不再重判。
                </strong>
                今天已经领过的人，当天升级成会员
                <strong className="font-medium text-foreground">不会补上差额</strong>
                ，要到明天日切后的第一次调用才拿到会员那一档。反过来同样：今天到期的会员，
                剩下这一天里手上还是会员那一份，不会被收回。这两句都会变成客服问题，先知道答案。
              </Hint>
              <Hint>
                算「会员」的判据是<strong className="font-medium text-foreground">有套餐、且没到期</strong>；
                不写到期时间的永久套餐一直算有效，已到期的会员算在非会员那一档。这条判据全站
                只有一处定义（服务端），这一屏不重复判断任何具体用户。
              </Hint>
              <Hint>
                这一项不改变任何人被收多少钱：免费点走的是免费池分支，扣不到余额上。它决定的是
                你每天送出去多少真实上游消耗 —— 会员那一档的总支出跟着
                <strong className="font-medium text-foreground">有效会员人数</strong>走，抬价之前先去
                「客户」页看一眼那个数。
              </Hint>
            </div>
          </div>
        </Panel>
      </SectionReveal>

      <SectionReveal delay={210}>
        <Panel
          title="套餐额度"
          aside={
            <Button onClick={savePlans} disabled={busy || loading}>
              保存套餐
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">套餐</TableHead>
                  <TableHead>总额度（真实计费 $）</TableHead>
                  <TableHead>时段上限（真实计费 $）</TableHead>
                  <TableHead>周上限（真实计费 $）</TableHead>
                  <TableHead className="w-24">天数</TableHead>
                  <TableHead className="w-52">客户看到（总 / 时段 / 周）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(live.plans || []).map((p) => {
                  const d = plans[p.plan] || { total: "", window: "", weekly: "", days: "" };
                  const set = (k: keyof typeof d, v: string) =>
                    setPlans((prev) => ({ ...prev, [p.plan]: { ...prev[p.plan], [k]: v } }));
                  // 客户看到的是面值，三列都要折算 —— 有争议的正是时段/周这两列。
                  // 走 creditCentsFromRaw 而不是自己除：这里原来写的是 `savedDenom || 663`，
                  // 又把分母抄了第四份。这个文件顶上的注释说的正是「663 曾经在四个文件里
                  // 各有一份副本」—— 结果修完之后自己又添了一份。
                  const face = (dollars: string) =>
                    cents(creditCentsFromRaw(toRawCents(dollars)));
                  return (
                    <TableRow key={p.plan}>
                      <TableCell className="font-medium">
                        {p.plan}
                        {p.is_default && (
                          <div className="mt-1">
                            <Badge variant="outline">出厂默认</Badge>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input inputMode="decimal" value={d.total} onChange={(e) => set("total", e.target.value)} />
                      </TableCell>
                      <TableCell>
                        <Input inputMode="decimal" value={d.window} onChange={(e) => set("window", e.target.value)} />
                      </TableCell>
                      <TableCell>
                        <Input inputMode="decimal" value={d.weekly} onChange={(e) => set("weekly", e.target.value)} />
                        {toRawCents(d.weekly) === 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">0 = 不限</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input inputMode="numeric" value={d.days} onChange={(e) => set("days", e.target.value)} />
                      </TableCell>
                      <TableCell className="tabular-nums text-xs text-muted-foreground">
                        <div>{face(d.total)}</div>
                        <div>{face(d.window)}</div>
                        <div>{toRawCents(d.weekly) === 0 ? "不限" : face(d.weekly)}</div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border p-5">
            <Hint>
              输入的是<strong className="font-medium text-foreground">真实计费美元</strong>
              —— 你实际付给上游的钱，和钱包余额同一个单位（结算时同一笔费用拆开，一部分扣套餐额度，
              一部分扣钱包）。右侧「客户看到」是同一笔钱按当前面值折算后、客户端上显示的数字。
              两个都是美元，差 {(savedDenom / 100).toFixed(2)} 倍，别看混。
            </Hint>
            <Hint>
              <strong className="font-medium text-foreground">同样是 0，两列的含义相反。</strong>
              周上限填 0 = <strong className="font-medium text-foreground">不限</strong>；
              时段上限填 0 = 把套餐<strong className="font-medium text-foreground">永久锁死</strong>
              （判定用的是「大于 0」），用户会一直看到「本时段额度已用完，请等待刷新」，而那个刷新
              永远刷不出额度。所以时段上限被数据库拦着，不允许填 0。
            </Hint>
            <Hint>
              改套餐<strong className="font-medium text-foreground">不会</strong>动已订阅的用户：额度在兑换那一刻
              写进用户表，之后没有任何地方重新推导。只有在「客户」页手动改套餐并勾上「重置额度」时才会重写。
            </Hint>
          </div>
        </Panel>
      </SectionReveal>

      <SectionReveal delay={280}>
        <Panel title="不在这里改的" bodyClassName="p-5">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium">
                100 积分 = ¥1（1 点 = {live.raw_cents_per_point.toFixed(4)} 真实计费分）
              </dt>
              <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                积分就是人民币面值的钱包额度，消耗按 token 走和钱包同一条计价，只在最后一步换算成点。
                这个换算**不是**手填的常量：由「1 点 = 1 人民币分」和下面那格汇率推导，
                改汇率它自动跟上。（曾经硬编码成 5 分/点，也就是 1 点 ≈ ¥0.355 —— 比设定大 35 倍，
                而且汇率改了不会跟。）
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium">渠道购买价</dt>
              <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                每条中转线路各自的进货价（¥1 买多少美元额度），在「模型线路」里按渠道填 —— 它和这一屏
                的面值是两个数，不要混。
              </dd>
            </div>
          </dl>
        </Panel>
      </SectionReveal>

      <Dialog open={confirmDenom} onOpenChange={setConfirmDenom}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认修改额度面值</DialogTitle>
            <DialogDescription>
              这会改变每一个客户看到的余额数字，而他们并没有发生任何交易。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted-foreground">面值</span>
                <span className="tabular-nums font-medium">
                  {toDollars(savedDenom)} → {toDollars(draftDenom)}
                </span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-4">
                <span className="text-muted-foreground">一笔 {cents(preview.before)} 的余额会显示成</span>
                <span className="tabular-nums font-medium">{cents(preview.after)}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-4">
                <span className="text-muted-foreground">它能花的真实金额</span>
                <span className="tabular-nums font-medium">不变</span>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              之后发出去的额度会按新面值折算；已创建的商品、未支付的订单和未兑换的兑换码保持原有的
              真实分不变。
            </p>
            <div>
              <Label htmlFor="confirm-denom">输入「确认」以继续</Label>
              <Input
                id="confirm-denom"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDenom(false)}>
              取消
            </Button>
            <Button
              disabled={confirmText.trim() !== "确认" || busy}
              onClick={async () => {
                setConfirmDenom(false);
                await save({ raw_cents_per_credit_usd: draftDenom }, "额度面值已更新");
              }}
            >
              确认修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
