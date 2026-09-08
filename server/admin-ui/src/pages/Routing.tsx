import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, Layers, Plus, RefreshCw, Scale } from "lucide-react";
import { RatioSync } from "@/components/RatioSync";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Stat } from "@/components/Stat";
import { TableSkeleton } from "@/components/TableSkeleton";
import { SectionReveal } from "@/components/motion/section-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Truncate,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { useRowFlash } from "@/lib/flash";
import { cents, num } from "@/lib/format";
import { cn, hasModel } from "@/lib/utils";

/**
 * 模型线路 — the provider connections every IDE request is routed through, and what each
 * enabled model costs.
 *
 * What an operator does here: watch which routes are live, pull a failing provider OUT of
 * rotation, add or re-key a connection, and price the models it exposes.
 *
 * THE FIX: `models.active` gates every routing query (models.rs:1078, 1788, 1849, 2286) and
 * `UpdateReq.active` has existed all along (models.rs:1635) — but the old edit form never sent
 * it (admin.html:1834-1850). So the only way to stop a bad provider was DELETE, which drops the
 * api key, the enabled-model set, the display names and every per-model price with it. Each row
 * now has 停用/启用, and it posts `{ active }` and nothing else: every other UpdateReq field is
 * an Option that keeps its stored value when absent (models.rs:1663-1756), so a toggle cannot
 * damage the connection. The delete dialog offers 停用 as the reversible alternative.
 *
 * PRICE PRIORITY — mirrored from the code that actually charges, compute_cost (models.rs:2666-
 * 2673): per-model override → built-in official catalogue → connection-level input/output price.
 * The connection price is a FALLBACK for models the catalogue doesn't know, not a default, so
 * this screen labels it 兜底 rather than showing it as the model's price. Note that
 * list_for_client (models.rs:1797-1805) hands the IDE a different order (override → connection →
 * catalogue) — the two disagree, and a screen whose job is "what does this cost" has to follow
 * the billing path. Worth reconciling server-side.
 *
 * SERVER TRAPS this screen has to work around, all of them worth fixing in models.rs:
 *  - admin_update re-runs its per-call price check on EVERY update (models.rs:1713), including
 *    the `{ active }`-only post — so a per-call connection with unpriced models REFUSES to be
 *    stopped until it is priced. setActive() says what to do when that 400 comes back.
 *  - admin_create never persists `per_call_micro_usd` (the INSERT at models.rs:1536-1553 omits
 *    the column), so a sub-half-cent fee entered at 新建 lands as 0 = free. Blocked client-side.
 *  - UpdateReq has no `model_id`, and allowed_ids() falls back to that legacy column when the
 *    enabled set is empty (models.rs:750) — unchecking every model cannot hide it. Flagged in
 *    the dialog when it applies.
 *
 * Deliberately left out of the old 模型系统 tab:
 *  - 渠道汇率 and 模型渠道利润计算器 — a pricing exercise, not a routing one; they move to 定价试算.
 *  - API 密钥 (apikeys) — belongs with customers, not with provider routes.
 *  - Vendor logo SVGs — six hand-pasted brand paths with hardcoded hex, none of them ours to
 *    ship; the provider is a word in the row instead.
 *  - 拉取模型 dumping the raw catalogue into a 300px scroller with seven controls per line —
 *    same controls, but the list starts at what is actually enabled.
 */

type PriceOverride = { in?: number; out?: number };
type BillingOverride = { mode?: string; per_call_cents?: number; per_call_micro_usd?: number };

/** Exactly the shape of GET /api/admin/models (models.rs:1146-1175). */
type Conn = {
  id: string;
  label?: string;
  provider?: string;
  base_url?: string;
  model_id?: string | null;
  api_key_masked?: string;
  has_key?: boolean;
  rate?: number;
  active?: boolean;
  sort?: number;
  created_at?: string;
  input_price?: number;
  output_price?: number;
  cache_read_price?: number;
  cache_create_price?: number;
  /** 这条线路的价在后台按哪种货币录。**价本身永远是美元每百万 token**，这个只管输入框。 */
  price_currency?: "usd" | "cny";
  /** 1 美元折多少人民币（后台设置里那个全局汇率）。拿不到就只能按美元录。 */
  cny_per_usd?: number;
  cache_disabled?: boolean;
  description?: string;
  enabled_models?: string[];
  billing_mode?: string;
  per_call_cents?: number;
  per_call_micro_usd?: number;
  model_names?: unknown;
  model_prices?: unknown;
  /**
   * 每个在售模型的**实时 OpenRouter 目录价**，服务端每次都现取（内存目录，6 小时刷新）。
   *
   * 有它之后，打开一条已经配好的线路就能立刻看出「你填的」和「现价」差多少 ——
   * 以前只有点过「拉取模型」才有价，而那是一次性的，填完就再也看不见了。
   */
  catalog_prices?: Record<string, { in: number; out: number; cache_read?: number | null; cache_write?: number | null }>;
  model_caps?: unknown;
  power_route?: boolean;
  model_billing?: unknown;
  protocol?: string;
  /** 显示分组：把这条线路的模型挂在另一条线路的名字下。只影响 IDE 选择器上的标题。 */
  group_into?: string | null;
  /** 派单真正认的那一份：线路自己的 ∪ 各出口带来的。IDE 列表按它出。 */
  effective_models?: string[];
  /** 出口带来的模型 → 带来它的出口（备注或主机名）。 */
  carried_by?: Record<string, string[]>;
};

/** GET /api/admin/model-usage returns totals only (models.rs:1978-1991). */
type Usage = { calls?: number; spent_cents?: number };

const PROVIDERS = ["claude", "gpt", "deepseek", "gemini", "minimax", "glm", "other"];

/** The three JSON maps arrive as free-form serde_json::Value — never trust the shape. */
function asMap<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/**
 * Two units that format.ts deliberately does not cover, kept together so nothing formats money
 * inline anywhere else. `cents()` is integer-cent money: it renders a $0.0035 per-call fee as
 * "$0.00", which is the exact bug models.rs:550-553 documents (the field appeared to revert on
 * save). Per-call fees are micro-USD and token prices are USD per 1M — different units, not
 * cents. Move both into format.ts the moment a second screen needs them.
 */
const fee = (usd: number) => {
  if (!(usd > 0)) return "$0.00";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  // Sub-cent fees are the whole point of per_call_micro_usd — never round one down to $0.00.
  // Micro-USD is the storage floor, so nothing smaller than 0.000001 can actually be saved.
  return usd < 0.000001 ? "<$0.000001" : `$${usd.toFixed(6).replace(/0+$/, "")}`;
};
/** USD per 1M tokens. Bounded so an f64 out of the DB can't print as $0.30000000000000004. */
const per1M = (usd: number | undefined) => `$${Number((usd || 0).toFixed(4))}`;

/** Mirrors allowed_ids() (models.rs:750): an empty enabled set falls back to the legacy model_id. */
function allowedIds(c: Conn): string[] {
  if (c.enabled_models?.length) return c.enabled_models;
  return c.model_id ? [c.model_id] : [];
}

/** `active` is NOT NULL in the schema; treat a missing field as live rather than silently dark. */
const isOn = (c: Conn) => c.active !== false;

const MODES = ["rate", "per_call", "free"];

/** A per-model mode override, normalised the way the server reads it (models.rs:624-628). */
const ovMode = (ov: BillingOverride) => {
  const m = String(ov.mode ?? "").trim().toLowerCase();
  return MODES.includes(m) ? m : "";
};

/** Effective billing mode for one model: its own override, else the connection's. */
const billingMode = (c: Conn, ov: BillingOverride) => ovMode(ov) || c.billing_mode || "rate";

/**
 * Per-call fee in micro-USD, resolved exactly as effective_billing_micro does (models.rs:601-618):
 * per-model micro → connection micro → per-model cents → connection cents. The order matters —
 * a connection-level micro fee outranks a legacy whole-cent per-model override.
 */
function perCallMicro(c: Conn, ov: BillingOverride): number {
  const ovMicro = Number(ov.per_call_micro_usd) || 0;
  if (ovMicro > 0) return ovMicro;
  if ((c.per_call_micro_usd || 0) > 0) return c.per_call_micro_usd || 0;
  const ovCents =
    typeof ov.per_call_cents === "number" && ov.per_call_cents >= 0 ? ov.per_call_cents : null;
  return (ovCents ?? c.per_call_cents ?? 0) * 10_000;
}

const channelFeeUsd = (c: Conn) => perCallMicro(c, {}) / 1_000_000;

/**
 * The models this connection would bill nothing for — the server's own check, resolved per model
 * exactly as models.rs:1713-1742 does it. A zero CHANNEL fee is fine when each model carries its
 * own price, so only flag models that end up charging zero.
 */
function unpriced(c: Conn): string[] {
  if (c.billing_mode !== "per_call") return [];
  if (channelFeeUsd(c) > 0) return [];
  const overrides = asMap<BillingOverride>(c.model_billing);
  return allowedIds(c).filter((id) => {
    const ov = overrides[id] || {};
    const mode = billingMode(c, ov);
    if (mode === "free" || mode === "rate") return false; // points-capped, or billed by tokens
    return perCallMicro(c, ov) <= 0;
  });
}

/**
 * 这个模型**实际按多少钱扣**，和网关同一个阶梯。
 *
 * # 倍率必须乘进来
 *
 * 上一版这里只显示单模型价：线上 claude-opus-5 写的是 $15/$25。而扣费是
 * **单模型价 × 线路倍率**（`compute_cost` 最后一行 `usd * 100.0 * rate`），这条线路
 * 倍率 2.5 —— 真实扣的是 $37.5/$62.5。两个数分在两列里，没有人会在脑子里乘一遍，
 * 而这一列的职责恰恰是「这个模型多少钱」。同一个毛病这文件里犯过一次
 * （卡片写 $3/M、账单按 $5/M 扣），当时的结论就是**展示和扣费必须共用一个阶梯**。
 *
 * 括号里把「单价 ×倍率」原样留着：这样这个数是怎么来的当场可核，不用去翻另一列。
 *
 * # 按次不乘
 *
 * 不是风格选择，是跟着分支走：`cost_for` 里 per_call 那一支直接 `return per_call_cents`，
 * 根本走不到乘倍率那一行。
 *
 * # 免费也要乘
 *
 * 「免费」是**付款去向**不是价格：成本照常算（`effective_billing_inner` 把 free 映射回
 * rate），只是从每日免费点数里扣。所以倍率一样在烧点数 —— 一个 68 倍的单价会让免费额度
 * 68 倍速见底，说成一句「免费额度」等于把这件事藏了。
 */
function modelCost(c: Conn, id: string): string {
  const ov = asMap<BillingOverride>(c.model_billing)[id] || {};
  const mode = billingMode(c, ov);
  if (mode === "per_call") {
    const usd = perCallMicro(c, ov) / 1_000_000;
    return usd > 0 ? `${fee(usd)} / 次` : "未计费";
  }
  const r = c.rate ?? 1;
  const mul = `×${Number(r.toFixed(4))}`;
  const p = asMap<PriceOverride>(c.model_prices)[id] || {};
  const hasOwn = (p.in || 0) > 0 || (p.out || 0) > 0;
  // The built-in catalogue beats the connection price: compute_cost only falls back to the
  // connection's input/output when the model is NOT catalogued (models.rs:2666-2673).
  const hasFallback = (c.input_price || 0) > 0 || (c.output_price || 0) > 0;
  const charged = hasOwn
    ? `${per1M((p.in || 0) * r)} / ${per1M((p.out || 0) * r)} 每 1M`
    : hasFallback
      ? `内置官方价 ${mul} · 兜底 ${per1M((c.input_price || 0) * r)}/${per1M((c.output_price || 0) * r)}`
      : `内置官方价 ${mul}`;
  if (mode === "free") return `免费额度 · 点数按 ${charged} 烧`;
  return hasOwn ? `${charged}（${per1M(p.in)}/${per1M(p.out)} ${mul}）` : charged;
}

/** 这条线路上有几个开放模型是自己定价的（倍率乘在这个价上，不是乘在官方价上）。 */
function ownPricedCount(c: Conn, ids: string[]): number {
  const m = asMap<PriceOverride>(c.model_prices);
  return ids.filter((id) => ((m[id]?.in || 0) > 0 || (m[id]?.out || 0) > 0)).length;
}

/**
 * 分组解析，一比一照抄 list_for_client（models.rs:1980-2003）。
 *
 * 只跳一层：A 分到 B、B 又分到 C，A 显示在 B 下面而不是 C 下面。指向自己、指向不存在的线路、
 * 指向一条已停用因而根本不在 /api/models 里的线路 —— 三种情况都退回自己的名字，所以配错的分组
 * 只会让分组不生效，不会让模型从选择器里消失。
 */
function headingOf(c: Conn, labelOf: Map<string, string>): string {
  const own = c.label || "未命名";
  if (!c.group_into || c.group_into === c.id) return own;
  return labelOf.get(c.group_into) ?? own;
}

/** 只有在转的线路进得了 /api/models，所以只有它们参与分组解析（models.rs:1979）。 */
function liveLabels(conns: Conn[]): Map<string, string> {
  return new Map(conns.filter(isOn).map((c) => [c.id, c.label || "未命名"]));
}

export type RoutingView = "routing" | "routing-groups";

export function Routing({ view }: { view: RoutingView }) {
  const [ratioOpen, setRatioOpen] = useState(false);
  const [conns, setConns] = useState<Conn[]>([]);
  // IDE 那个列表的真实长度。这一屏的「开放模型」照它显示，别在前端按另一套规则重算。
  const [ideModelCount, setIdeModelCount] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage>({});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get<unknown[]>("/api/models")
      .then((r) => { if (alive) setIdeModelCount(Array.isArray(r) ? r.length : null); })
      .catch(() => { if (alive) setIdeModelCount(null); });
    return () => { alive = false; };
  }, []);
  const [busyId, setBusyId] = useState("");
  const [expanded, setExpanded] = useState("");
  // null = closed, { conn: null } = 新建, { conn } = 编辑.
  const [dialog, setDialog] = useState<{ conn: Conn | null } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Conn | null>(null);
  // 停用/启用是行内的写操作，反馈也留在行内：成功就这一行亮一下（240ms），
  // 失败亮成 destructive —— 一条线路撤出轮转是件大事，不该只靠按钮文字从"停用"变成"启用"来暗示。
  const { fire, toneOf } = useRowFlash();
  // Delete failures have to land INSIDE the modal — a page-level error behind the overlay
  // reads as "nothing happened" on the one action that cannot be undone.
  const [delErr, setDelErr] = useState("");

  // No polling here, unlike 总览: this screen is edited, and a 30s refresh would yank the table
  // out from under an open dialog. Every mutation reloads instead.
  const load = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([
        api.get<Conn[] | { items?: Conn[] }>("/api/admin/models"),
        // 分组那一屏不显示调用量，就别去要它。
        view === "routing"
          ? api.get<Usage>("/api/admin/model-usage").catch(() => ({}) as Usage)
          : Promise.resolve({} as Usage),
      ]);
      setConns(Array.isArray(m) ? m : m?.items || []);
      setUsage(u || {});
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    load();
  }, [load]);

  async function setActive(c: Conn, active: boolean) {
    setBusyId(c.id);
    setErr("");
    try {
      // ONLY `active` — see the header comment. Sending the rest would risk overwriting fields
      // this row never loaded.
      await api.post(`/api/admin/models/${c.id}`, { active });
      await load();
      fire(c.id, "ok");
    } catch (e) {
      fire(c.id, "error");
      const msg = e instanceof Error ? e.message : "操作失败";
      // admin_update runs its per-call price check on every update (models.rs:1713), so the
      // rescue action fails with a PRICING error on exactly the connections that need rescuing.
      setErr(
        unpriced(c).length
          ? `${msg}｜停用被服务端的计费校验挡住了：先进「编辑」给这些模型填「次费$」，或填渠道级「每次调用收费」，再停用。`
          : msg,
      );
    } finally {
      setBusyId("");
    }
  }

  async function remove(c: Conn) {
    setBusyId(c.id);
    setDelErr("");
    try {
      await api.del(`/api/admin/models/${c.id}`);
      setConfirmDel(null);
      await load();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId("");
    }
  }

  const live = conns.filter(isOn);
  // 「开放模型」数**从 IDE 那个接口取**，不在前端重算。
  //
  // 原来是 `allowedIds(c)` 求和，而 IDE 拿到的列表由服务端 list_for_client 算，
  // 两套规则不一样（比如强力线路里「普通线路也有」的 id 会被剔掉），
  // 于是这张卡的副标题写着「IDE 里能选到的」，数字却和 IDE 里能选到的对不上。
  const exposed = ideModelCount;
  const labelOf = liveLabels(conns);

  if (view === "routing-groups") {
    return <Groups conns={conns} loading={loading} err={err} onReload={load} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="模型线路"
        description="供应商连接和每个模型的价格。线路出问题就停用它——密钥、开放的模型和定价都留着，随时能再开。"
      />

      <ErrorState message={err} />

      {/* 入场错峰：标题 0，往下每段 +70ms（展示站 SectionReveal 的 Math.min(i,4)*70）。 */}
      <SectionReveal as="section" delay={70} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="在转线路" value={num(live.length)} hint={`共 ${conns.length} 条连接`} />
        <Stat label="开放模型" value={exposed == null ? "—" : num(exposed)} hint="IDE 里能选到的" />
        <Stat label="累计调用" value={num(usage.calls)} />
        {/* cost_cents 是「按倍率结算后从用户扣掉的钱」(models.rs:2715)，不是渠道成本。 */}
        <Stat label="累计计费" value={cents(usage.spent_cents)} hint="已含倍率" />
      </SectionReveal>

      <SectionReveal as="section" delay={140} className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">供应商连接</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw /> 刷新
            </Button>
            {/*
              同步倍率放在「新建连接」左边：它是一个**对着已有配置**做的动作，
              而新建是往里加东西。两个都是主按钮的话，最常用的那个会被挤掉。
            */}
            <Button variant="outline" size="sm" onClick={() => setRatioOpen(true)}>
              <Scale /> 同步倍率
            </Button>
            <Button size="sm" onClick={() => setDialog({ conn: null })}>
              <Plus /> 新建连接
            </Button>
          </div>
        </header>

        {/* Dialog 挂在按钮旁边就行，Radix 会 portal 到 body。 */}
        <RatioSync open={ratioOpen} onClose={() => setRatioOpen(false)} onApplied={load} />

        {loading && (
          <TableSkeleton
            rows={4}
            columns={["22%", "8%", "10%", "20%", "12%"]}
            label="供应商连接读取中"
          />
        )}

        {!loading && !conns.length && (
          <EmptyState
            title="还没有连接"
            hint="先建一条，保存后再进「编辑」拉取并勾选要开放给 IDE 的模型。"
            action={
              <Button size="sm" onClick={() => setDialog({ conn: null })}>
                <Plus /> 新建连接
              </Button>
            }
          />
        )}

        {!loading && conns.length > 0 && (
          /* 六列写死宽度：base_url 和 model id 都能长到把别的列挤没，密钥列是等宽掩码。 */
          <Table className="min-w-[72rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[20rem]">连接</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-32">开放模型</TableHead>
                <TableHead className="w-[18rem]">计费</TableHead>
                <TableHead className="w-40">密钥</TableHead>
                <TableHead className="w-[15rem] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conns.map((c) => {
                const ids = allowedIds(c);
                const names = asMap<string>(c.model_names);
                const dead = unpriced(c);
                const open = expanded === c.id;
                return (
                  <Fragment key={c.id}>
                    <TableRow data-flash={toneOf(c.id)} className={cn(!isOn(c) && "opacity-60")}>
                      <TableCell className="max-w-[20rem]">
                        <Truncate className="font-medium">{c.label || "未命名"}</Truncate>
                        <Truncate
                          className="text-xs text-muted-foreground"
                          title={`${c.provider || "other"} · ${c.base_url || "—"}`}
                        >
                          {c.provider || "other"} · {c.base_url || "—"}
                        </Truncate>
                        {/* 被分到别的名字下时说一声。否则在 IDE 里找不到这条线路的标题，
                            会以为它没生效 —— 而它其实在照常接单。 */}
                        {headingOf(c, labelOf) !== (c.label || "未命名") && (
                          <Truncate className="mt-0.5 text-xs text-muted-foreground">
                            <Layers aria-hidden className="mr-1 inline size-3 align-[-1px]" />
                            在 IDE 里显示为「{headingOf(c, labelOf)}」
                          </Truncate>
                        )}
                      </TableCell>
                      <TableCell>
                        {isOn(c) ? (
                          <Badge variant="success">在转</Badge>
                        ) : (
                          <Badge variant="outline">已停用</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? "" : c.id)}
                          aria-expanded={open}
                          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm transition-colors hover:bg-secondary"
                        >
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              "size-3.5 text-muted-foreground transition-transform",
                              open && "rotate-180",
                            )}
                          />
                          {ids.length ? `${ids.length} 个` : "未选择"}
                        </button>
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.billing_mode === "per_call" ? (
                          <span className="tabular-nums">按次 {fee(channelFeeUsd(c))}/次</span>
                        ) : (
                          <span className="tabular-nums">
                            {/*
                              这个 ×N **不是最终倍数**。它乘的是「这个模型在这条线路上的单价」，
                              而那个单价本身常常已经加过价了。只看这一列会把线路排错序：
                              线上 claude-sonnet-5 在 ×2.5 这条线路上实收 12.5 倍官方价，
                              比 ×8 那条线路的 8 倍还高。所以这里必须说清楚它乘在谁身上，
                              并把「有几个模型自己定价」摆出来 —— 那才是真正决定价钱的东西。
                            */}
                            <span title="倍率乘在「这个模型在这条线路上的单价」上，不是乘在官方价上。展开左边的「开放模型」看每个模型实际扣多少。">
                              按 Token ×{c.rate ?? 1}
                            </span>
                            {ownPricedCount(c, ids) > 0 && (
                              <span
                                className="text-muted-foreground"
                                title="这些模型有自己的单价，倍率乘在它上面 —— 最终倍数 = 单价倍数 × 这条线路的倍率"
                              >
                                {" "}· {ownPricedCount(c, ids)} 个模型自定价
                              </span>
                            )}
                            {((c.input_price || 0) > 0 || (c.output_price || 0) > 0) && (
                              <span
                                className="text-muted-foreground"
                                title="只用于内置价目表没收录的模型；收录的模型按官方价计费"
                              >
                                {" "}· 兜底 {per1M(c.input_price)}/{per1M(c.output_price)}
                              </span>
                            )}
                          </span>
                        )}
                        {dead.length > 0 && (
                          <div className="mt-0.5 text-xs text-destructive" title={dead.join("、")}>
                            {dead.length} 个模型不计费
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-40 font-mono text-xs text-muted-foreground">
                        <Truncate>{c.has_key === false ? "未配置" : c.api_key_masked || "—"}</Truncate>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyId === c.id}
                            onClick={() => setActive(c, !isOn(c))}
                          >
                            {isOn(c) ? "停用" : "启用"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDialog({ conn: c })}>
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-destructive/40 text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              setDelErr("");
                              setConfirmDel(c);
                            }}
                          >
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>

                    {open && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="bg-muted/50">
                          {ids.length ? (
                            <ul className="grid gap-2 sm:grid-cols-2">
                              {ids.map((id) => (
                                <li
                                  key={id}
                                  className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate font-mono text-xs" title={id}>
                                      {id}
                                    </span>
                                    {names[id] && (
                                      <span className="block truncate text-xs text-muted-foreground">
                                        显示为 {names[id]}
                                      </span>
                                    )}
                                  </span>
                                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                    {modelCost(c, id)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              这条连接还没勾选模型，IDE 的模型列表里看不到它。进「编辑」拉取并勾选。
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionReveal>

      {dialog && (
        <ConnectionDialog
          key={dialog.conn?.id || "new"}
          conn={dialog.conn}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            load();
          }}
        />
      )}

      {confirmDel && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDel(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>删除「{confirmDel.label || "未命名"}」？</DialogTitle>
              <DialogDescription>
                API Key、{allowedIds(confirmDel).length} 个已开放模型、它们的显示名和单独定价会一起消失，
                无法恢复。只是想让它别再接单的话，用「停用」——线路立刻撤出轮转，配置原样留着。
              </DialogDescription>
            </DialogHeader>
            {delErr && <p role="alert" className="text-sm text-destructive">{delErr}</p>}
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmDel(null)}>
                取消
              </Button>
              {isOn(confirmDel) && (
                <Button
                  variant="secondary"
                  disabled={busyId === confirmDel.id}
                  onClick={() => {
                    const c = confirmDel;
                    setConfirmDel(null);
                    setActive(c, false);
                  }}
                >
                  改为停用
                </Button>
              )}
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={busyId === confirmDel.id}
                onClick={() => remove(confirmDel)}
              >
                仍然删除
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * 线路分组 —— 把几条线路的模型收进同一个标题下面。
 *
 * 这一屏只写 models.group_into 一列，而那一列只喂 /api/models 的 `group` 字段，也就是 IDE 模型
 * 选择器里的分组标题（main.js:12422 拿它当桶名，14044 当标题渲染）。请求走哪条线路是按模型 id
 * 现算的（models.rs:5230-5238：所有在转、且开放了这个 id 的线路，按 sort、created_at 排，第一条
 * 接单），那段查询根本不看这一列。所以分组改的是标题，改不了计费、密钥、用量归属。
 *
 * 和「线路」那一屏分开，是因为这里每一个下拉框都是纯展示操作，而那边每一个按钮都能停掉线上流量。
 * 放在一起，会让人以为改分组也有同样的分量。
 */
function Groups({
  conns, loading, err, onReload,
}: {
  conns: Conn[];
  loading: boolean;
  err: string;
  onReload: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const labelOf = liveLabels(conns);
  const own = (c: Conn) => c.label || "未命名";

  /** 自己已经分到别处的线路。 */
  const grouped = new Set(conns.filter((c) => c.group_into).map((c) => c.id));
  /** 名下已经挂着别的线路的。 */
  const parents = new Set(conns.map((c) => c.group_into).filter(Boolean) as string[]);

  /**
   * 为什么这个目标选不了 —— 空字符串表示能选。
   *
   * 前三种服务端会直接 400（admin_group），在这里先灰掉，省得点完才知道不行。第四种服务端
   * 允许：停用的线路能当目标，只是它不在 /api/models 里，分组解析会退回自己的名字 ——
   * 等于白设一次，所以同样标出来。
   */
  function targetIssue(self: Conn, t: Conn): string {
    if (t.id === self.id) return "自己";
    if (grouped.has(t.id)) return "已分到别处";
    if (parents.has(self.id)) return "本身是个组";
    if (!isOn(t)) return "已停用";
    return "";
  }

  async function setGroup(c: Conn, target: string) {
    setBusyId(c.id);
    setNote(null);
    try {
      await api.post(`/api/admin/models/${c.id}/group`, { group_into: target || null });
      await onReload();
      const to = conns.find((x) => x.id === target);
      setNote({
        ok: true,
        text: to
          ? `「${own(c)}」的模型现在显示在「${own(to)}」下面。计费和用量还记在「${own(c)}」上。`
          : `「${own(c)}」恢复用自己的名字显示。`,
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setBusyId("");
    }
  }

  // IDE 里实际会看到的样子：只有在转的线路进得了 /api/models，标题相同的会并成一堆 ——
  // 这正是分组的原理，两条线路重名本来就已经并在一起了。
  //
  // 勾了「Claude 强力版」的线路不出现在这里：它的模型只要普通线路也有，就不会进 IDE 的
  // 选择器（强力版是悬浮卡片右上角那个按钮，不是一个分组）。和 list_for_client 里那段
  // `if m.power_route && plain_ids.contains(&mid)` 是同一条规则——这个预览自称一比一照抄
  // 服务端，不跟着改就会在这儿显示一个 IDE 里根本看不到的分组。
  const plainModels = new Set(
    conns.filter((c) => isOn(c) && !c.power_route).flatMap(allowedIds),
  );
  const visible = conns
    .filter(isOn)
    .filter((c) => !c.power_route || !allowedIds(c).every((m) => plainModels.has(m)));
  const buckets = new Map<string, Conn[]>();
  for (const c of visible) {
    const head = headingOf(c, labelOf);
    const bucket = buckets.get(head);
    if (bucket) bucket.push(c);
    else buckets.set(head, [c]);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="线路分组"
        description="把一条线路的模型收到另一条线路的名字下面，IDE 的模型列表里就只剩一个标题。只改标题——密钥、计费方式、单模型定价和用量统计都还在原来那条线路上，随时能取消。"
      />

      <ErrorState message={err} />
      {note && (
        <p
          role="status"
          className={cn(
            "rounded-lg border px-4 py-2.5 text-sm",
            note.ok
              ? "border-border bg-secondary/60 text-foreground"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {note.text}
        </p>
      )}

      {loading && <TableSkeleton rows={4} columns={["30%", "20%", "30%"]} label="线路读取中" />}

      {!loading && !conns.length && (
        <EmptyState title="还没有连接" hint="先去「线路」建一条，再回来决定它显示在哪个名字下。" />
      )}

      {!loading && conns.length > 0 && (
        <>
          <SectionReveal as="section" delay={70}>
            <Panel
              title="IDE 里会看到"
              aside={
                <span className="text-xs text-muted-foreground">
                  {buckets.size} 个标题 · 只统计在转的线路
                </span>
              }
              bodyClassName="p-5"
            >
              {buckets.size === 0 ? (
                <p className="text-sm text-muted-foreground">
                  没有在转的线路，模型列表现在是空的。
                </p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {[...buckets].map(([head, members]) => {
                    const ids = members.flatMap(allowedIds);
                    // 同一个 id 出现两次：选择器里只看得到一条，请求按 sort 落到排在前面
                    // 那条线路。分组之前这个冲突也在，只是分开显示时还看得出来。
                    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
                    return (
                      <li key={head} className="rounded-lg border border-border bg-background p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <Truncate className="font-medium">{head}</Truncate>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {ids.length} 个模型
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {members.map((m) => (
                            <Badge key={m.id} variant="outline" className="font-normal">
                              {own(m)}
                              {allowedIds(m).length ? ` · ${allowedIds(m).length}` : " · 0"}
                            </Badge>
                          ))}
                        </div>
                        {dupes.length > 0 && (
                          <p className="mt-2 text-xs text-destructive" title={dupes.join("、")}>
                            {dupes.length} 个模型 id 在这个标题下重复，列表里只会出现一条，
                            请求落到排序靠前的那条线路。
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </SectionReveal>

          <SectionReveal as="section" delay={140}>
            <Panel
              title="归到哪个名字下"
              aside={
                <Button variant="ghost" size="sm" onClick={() => void onReload()}>
                  <RefreshCw /> 刷新
                </Button>
              }
            >
              <Table className="min-w-[52rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[22rem]">线路</TableHead>
                    <TableHead className="w-28">状态</TableHead>
                    <TableHead className="w-28">开放模型</TableHead>
                    <TableHead className="w-[20rem]">显示在</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {conns.map((c) => {
                    // 分组解析出来的目标名。指向自己、指向已删除的、或指向一条停用因而不在
                    // /api/models 里的线路 —— 三种都拿不到名字，分组等于没生效。
                    const under =
                      c.group_into && c.group_into !== c.id ? labelOf.get(c.group_into) : undefined;
                    const dangling = !!c.group_into && !under;
                    const isParent = parents.has(c.id);
                    return (
                      <TableRow key={c.id} className={cn(!isOn(c) && "opacity-60")}>
                        <TableCell className="max-w-[22rem]">
                          <Truncate className="font-medium">{own(c)}</Truncate>
                          <Truncate className="text-xs text-muted-foreground">
                            {c.provider || "other"}
                          </Truncate>
                        </TableCell>
                        <TableCell>
                          {isOn(c) ? (
                            <Badge variant="success">在转</Badge>
                          ) : (
                            <Badge variant="outline">已停用</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-muted-foreground">
                          {allowedIds(c).length}
                        </TableCell>
                        <TableCell>
                          <Select
                            className="h-9 text-sm"
                            value={c.group_into || ""}
                            disabled={busyId === c.id}
                            onChange={(e) => void setGroup(c, e.target.value)}
                            aria-label={`${own(c)} 显示在哪个名字下`}
                          >
                            <option value="">自己的名字（{own(c)}）</option>
                            {conns
                              .filter((t) => t.id !== c.id)
                              .map((t) => {
                                const issue = targetIssue(c, t);
                                return (
                                  <option key={t.id} value={t.id} disabled={!!issue}>
                                    {own(t)}
                                    {issue && ` —— ${issue}`}
                                  </option>
                                );
                              })}
                          </Select>
                          {isParent && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              已经有线路分到这个名字下，先把它们放出来才能再往别处分。
                            </p>
                          )}
                          {under && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              计费和用量仍记在「{own(c)}」。
                            </p>
                          )}
                          {dangling && (
                            <p className="mt-1 text-xs text-destructive">
                              目标线路不在转，分组没生效，现在还是按自己的名字显示。
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Panel>
          </SectionReveal>
        </>
      )}
    </div>
  );
}

/** One editable line of the enabled-model list. Four parallel maps flattened into one row. */
/** 网关实时抓到的模型能力（GET /api/admin/models/:id/available 的 capabilities）。 */
type Caps = {
  source: "live" | "static";
  contexts?: number[];
  max_output?: number | null;
  efforts?: string[];
  default_effort?: string | null;
  /** **计费用的官方价**（锚定过的：窗口内最高，不跟上游的活动降价）。美元/百万 token。 */
  input_price?: number | null;
  output_price?: number | null;
  /** 上游此刻挂牌的价。和上面不同 = 它正在打折，而我们按官方价计费。 */
  spot_input_price?: number | null;
  spot_output_price?: number | null;
  /** 1 美元折多少人民币（后台设置的全局汇率）。价目全是美元，这里给出换算。 */
  cny_per_usd?: number | null;
  cache_read_price?: number | null;
  cache_write_price?: number | null;
  accepts_image?: boolean | null;
  generates_image?: boolean | null;
};
type Row = {
  id: string; on: boolean; name: string; pin: string; pout: string; mode: string; fee: string; ctx: string; caps?: Caps;
  /** 非空 = 这个模型不是线路自己的，是这些出口带来的。取消勾选会把它从那些出口上拿掉。 */
  carried?: string[];
  /** 拉取之后：上游已经不提供这个模型了。勾着也派不出去，该取消。 */
  gone?: boolean;
};

/** 把一列上下文档位写成人看的样子：1000000 → 1M，204800 → 200K。 */
function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * 一行实时能力摘要，跟在模型 id 下面。
 *
 * 这些以前全靠管理员自己查文档手填，填错没人知道、填漏就掉到"连接兜底价"。实测硬编码
 * 那张表 13 款里错了 6 款（deepseek-v4-flash 128K vs 真实 1.05M），所以让它直接可见
 * 比让人去核对靠谱。留空价格框即用这里显示的实时价。
 */
function CapsLine({ caps }: { caps?: Caps }) {
  if (!caps) return null;
  if (caps.source !== "live") {
    return (
      <span className="text-[10px] text-muted-foreground">
        实时目录未收录 · 价格与上下文需手填
      </span>
    );
  }
  const bits: string[] = [];
  if (caps.contexts?.length) {
    bits.push(`上下文 ${caps.contexts.map(fmtCtx).join(" / ")}`);
  }
  if (caps.max_output) bits.push(`出 ${fmtCtx(caps.max_output)}`);
  if (caps.input_price != null && caps.output_price != null) {
    // 美元和人民币一起给。价目全是「美元/百万 token」，而运营脑子里的数是人民币，
    // 两者差 7 倍 —— 不摆出来，填错一位数没有任何地方会提醒。
    const cny = caps.cny_per_usd
      ? ` ≈ ¥${(caps.input_price * caps.cny_per_usd).toFixed(2)}/¥${(caps.output_price * caps.cny_per_usd).toFixed(2)}`
      : "";
    bits.push(`$${caps.input_price}/$${caps.output_price}${cny} 每百万 token`);
  }
  // **上游在打折时说出来。** 计费走的是官方价（窗口内最高），挂牌价只是此刻的报价。
  // 不提示的话，运营看到的价和他去 OpenRouter 页面上看到的对不上，而两边都没错。
  const promoIn = caps.spot_input_price != null && caps.input_price != null
    && caps.spot_input_price < caps.input_price;
  const promoOut = caps.spot_output_price != null && caps.output_price != null
    && caps.spot_output_price < caps.output_price;
  if (promoIn || promoOut) {
    bits.push(
      `上游在打折（现挂 $${caps.spot_input_price}/$${caps.spot_output_price}），仍按官方价计费`,
    );
  }
  if (caps.cache_read_price != null) bits.push(`缓存读 $${caps.cache_read_price}`);
  // 空数组是有意义的答案：这个模型不吃思考档位（实测 glm-5 就是），不是"没查到"。
  bits.push(caps.efforts?.length ? `思考 ${caps.efforts.join("/")}` : "无思考档位");
  if (caps.accepts_image) bits.push("可看图");
  if (caps.generates_image) bits.push("出图");
  return <span className="text-[10px] text-muted-foreground">{bits.join(" · ")}</span>;
}

/**
 * 换算一个价格框里的字符串。空串原样返回 —— **留空是「跟随目录现价」，不是 0**，
 * 换个币种不该把它变成一个具体的数。
 *
 * 只在切换币种时调用，不在渲染时调用：每渲染一次换算一次，用户打字打到一半就被四舍五入。
 * 和 RouteEndpoints.tsx 里那个是同一条判据，两处必须同解。
 */
function convertPrice(text: string, factor: number): string {
  const t = String(text ?? "").trim();
  if (!t) return t;
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(factor) || factor <= 0) return t;
  return String(Number((n * factor).toFixed(6)));
}

function initialRows(c: Conn | null): Row[] {
  if (!c) return [];
  const names = asMap<string>(c.model_names);
  const prices = asMap<PriceOverride>(c.model_prices);
  const billing = asMap<BillingOverride>(c.model_billing);
  const caps = asMap<{ contexts?: number[] }>(c.model_caps);
  const live = c.catalog_prices || {};
  const own = allowedIds(c);
  // 出口带来的模型也要在这张表里：IDE 按 effective_models 出列表，这里只列线路自己的话，
  // 运维在 IDE 里看到一个模型、回到这页却找不到它，也没法取消 —— 所有者「我没用的模型了，
  // 他还保存着，很奇怪」。它们带着「由出口带来」的标记，取消勾选会从那些出口上拿掉。
  // 忽略大小写：出口把 minimax-m3 写成 MiniMax-M3 时，那不是「出口带来的新模型」，
  // 而是同一款货的另一种拼法（服务端已归并，这里是同一把尺的第二处）。
  const carriedIds = (c.effective_models || []).filter((id) => !hasModel(own, id));
  return [...own, ...carriedIds].map((id) => {
    const p = prices[id] || {};
    const b = billing[id] || {};
    // This box is the model's OWN fee. Never prefill it from the connection — saving would
    // then write the channel fee back as a per-model override that stops following it.
    const micro = Number(b.per_call_micro_usd) || (Number(b.per_call_cents) || 0) * 10_000;
    const carried = carriedIds.includes(id) ? (c.carried_by?.[id]?.length ? c.carried_by[id] : ["出口"]) : undefined;
    return {
      id,
      on: true,
      carried,
      name: names[id] || "",
      // 0 也要显示。用 `p.in ? …` 的话，存的 0 回显成空串，再保存一次就变成「留空」
      // ——一条配好的免费线路会在下一次编辑时**静默变回按官方价收费**。
      pin: typeof p.in === "number" ? String(p.in) : "",
      pout: typeof p.out === "number" ? String(p.out) : "",
      mode: ovMode(b),
      fee: micro > 0 ? String(micro / 1_000_000) : "",
      ctx: (caps[id]?.contexts || []).join(","),
      // 存的 model_caps 里只有上下文档位、没有价，所以价单独从实时目录带过来。
      caps: live[id]
        ? { source: "live" as const, input_price: live[id].in, output_price: live[id].out,
            cache_read_price: live[id].cache_read ?? null, cache_write_price: live[id].cache_write ?? null }
        : undefined,
    };
  });
}

/**
 * 你填的价是实时目录价的几倍。取入价和出价里**大**的那个 —— 一处离谱就够离谱了。
 * 拿不到现价（目录里没这一款）时回 0，调用方据此不显示。
 */
function priceGap(r: Row): number {
  const ci = r.caps?.input_price ?? 0;
  const co = r.caps?.output_price ?? 0;
  const gi = ci > 0 && nz(r.pin) > 0 ? nz(r.pin) / ci : 0;
  const go = co > 0 && nz(r.pout) > 0 ? nz(r.pout) / co : 0;
  return Math.max(gi, go);
}

const nz = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 「这一栏填了一个数」——**填 0 也算填了**。
 *
 * nz() 把 0 和留空塌成同一个值，那在别处没问题（它回答的是「有没有正数」），
 * 但价格这里两者是**相反的意思**：留空 = 按官方目录价收，填 0 = 一分不收。
 * 塌在一起的后果很具体：运维把入价出价都填 0 想开一条免费线路，保存时这一项被
 * 整个丢掉（下面那个 filter 只收非零项），后端拿不到覆盖 → 落到官方目录价 → 照收钱。
 */
const priceNum = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function ConnectionDialog({
  conn,
  onClose,
  onSaved,
}: {
  conn: Conn | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = conn !== null;
  const [label, setLabel] = useState(conn?.label || "");
  const [provider, setProvider] = useState((conn?.provider || "deepseek").toLowerCase());
  const [baseUrl, setBaseUrl] = useState(conn?.base_url || "");
  const [protocol, setProtocol] = useState(conn?.protocol || "anthropic");
  const [apiKey, setApiKey] = useState("");
  // 报价币种。**只管这一屏的输入框**：价存进库永远是美元每百万 token，
  // 折算发生在切币种和保存这两个时刻（见 convertPrice / toUsd）。
  // 汇率取不到（后台没下发）时一律锁在美元 —— 宁可显示美元，也不要用一个凭空的汇率
  // 把整条线路的进价算错一个数量级。
  const cnyRate = conn?.cny_per_usd && conn.cny_per_usd > 0 ? conn.cny_per_usd : 0;
  const [currency, setCurrency] = useState<"usd" | "cny">(
    conn?.price_currency === "cny" && (conn?.cny_per_usd ?? 0) > 0 ? "cny" : "usd",
  );
  const [active, setActiveField] = useState(conn ? isOn(conn) : true);
  const [description, setDescription] = useState(conn?.description || "");
  const [mode, setMode] = useState(conn?.billing_mode === "per_call" ? "per_call" : "rate");
  const [rate, setRate] = useState(String(conn?.rate ?? 1));
  // 输入/输出/缓存价的兜底字段已从编辑器移除（2026-08-18）：拉取的模型自带价格和缓存价，
  // 单模型价在下面「开放的模型」列表里逐个设。后端那几列留着（默认 0 = 用目录价），这里不再暴露。
  const [cacheDisabled, setCacheDisabled] = useState(Boolean(conn?.cache_disabled));
  // 「Claude 强力版」：勾上之后，IDE 里打开强力版开关的那一轮请求只会落到这条线路上。
  const [powerRoute, setPowerRoute] = useState(Boolean(conn?.power_route));
  const [perCall, setPerCall] = useState(String(conn ? channelFeeUsd(conn) : 0.2));
  // 库里存的是美元；这一屏若按人民币录，装进输入框时先折一次。
  // 折在**初始化**这一步，不在渲染那一步：渲染时折会让输入框在每次按键后被四舍五入。
  const [rows, setRows] = useState<Row[]>(() => {
    const base = initialRows(conn);
    const rate = conn?.cny_per_usd && conn.cny_per_usd > 0 ? conn.cny_per_usd : 0;
    if (conn?.price_currency !== "cny" || rate <= 0) return base;
    return base.map((r) => ({ ...r, pin: convertPrice(r.pin, rate), pout: convertPrice(r.pout, rate) }));
  });
  const [hint, setHint] = useState("");
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState("");

  /// 屏幕上那个数 → 存库用的美元。选美元时是恒等。
  const toUsd = (n: number) => (currency === "cny" && cnyRate > 0 ? Number((n / cnyRate).toFixed(9)) : n);
  /// 美元 → 屏幕上那个数。给现价、提示这类只读展示用。
  const toShown = (n: number) => (currency === "cny" && cnyRate > 0 ? Number((n * cnyRate).toFixed(6)) : n);
  const sym = currency === "cny" ? "¥" : "$";
  const ccy = currency === "cny" ? "人民币" : "美元";

  const patch = (id: string, part: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...part } : r)));

  /** Ask the provider what this key can actually call, then merge — never discard local edits. */
  async function fetchCatalog() {
    if (!conn) return;
    setFetching(true);
    setFormErr("");
    try {
      const r = await api.get<{
        models?: string[];
        enabled?: string[];
        capabilities?: Record<string, Caps>;
        catalog_size?: number;
      }>(`/api/admin/models/${conn.id}/available`);
      const stored = new Set(r.enabled || []);
      const caps = r.capabilities || {};
      const upstream = new Set(r.models || []);
      setRows((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        const added = (r.models || [])
          .filter((id) => !seen.has(id))
          .map<Row>((id) => ({
            id,
            on: stored.has(id),
            name: "",
            pin: "",
            pout: "",
            mode: "",
            fee: "",
            ctx: "",
            caps: caps[id],
          }));
        // 能力要贴到**已存在**的行上，不只新增的：常见操作是重复点"拉取"来刷新能力，
        // 只给新增行赋值的话，已经开着的模型永远看不到实时数据。
        // 已经在表里、但这次上游没回的：标成「已下架」，不替人取消 —— 出口带来的模型
        // 线路自己的地址本来就不一定有，那不算下架。
        return [
          ...prev.map((x) => ({
            ...x,
            ...(caps[x.id] ? { caps: caps[x.id] } : {}),
            gone: !x.carried && !upstream.has(x.id),
          })),
          ...added,
        ];
      });
      const goneNow = rows.filter((x) => !x.carried && x.on && !upstream.has(x.id)).length;
      const liveCount = Object.values(caps).filter((c) => c?.source === "live").length;
      setHint(
        ((r.catalog_size ?? 0) > 0
          ? `供应商返回 ${(r.models || []).length} 个模型，其中 ${liveCount} 个有实时能力数据（上下文/思考档位/价格自动带入，留空即用实时值）`
          : `供应商返回 ${(r.models || []).length} 个模型。能力目录暂不可用（网关刚启动或目录源不可达），价格请手填`) +
          (goneNow ? ` 已勾选的里有 ${goneNow} 个上游已不再提供，标了「已下架」，用旁边的按钮一键取消。` : ""),
      );
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "拉取失败");
    } finally {
      setFetching(false);
    }
  }

  async function save() {
    if (!label.trim() || !baseUrl.trim()) {
      setFormErr("名称和 baseUrl 必填");
      return;
    }
    const usd = nz(perCall);
    // admin_create's INSERT omits per_call_micro_usd (models.rs:1536-1553), so on 新建 the fee
    // survives only as whole cents — anything under half a cent is stored as 0 = free.
    if (!conn && mode === "per_call" && usd > 0 && Math.round(usd * 100) === 0) {
      setFormErr(`新建时「每次调用收费」只能存到分，${fee(usd)} 会被存成 0（等于不收费）。先填 ≥ $0.01 创建，再进「编辑」改成精确金额。`);
      return;
    }
    const on = rows.filter((r) => r.on);
    // 线路自己的名单只收线路自己的模型：出口带来的留在出口上（它进了这份名单，线路自带地址
    // 就会去接它的请求，而那个地址根本没有它，只会撞 404）。取消勾选的出口模型单独报给后端，
    // 从那些出口上拿掉。
    const ownOn = on.filter((r) => !r.carried);
    const dropFromEndpoints = rows.filter((r) => r.carried && !r.on).map((r) => r.id);
    // A one-sided price override is not "half configured", it is $0 for the other side:
    // compute_cost takes the pair as soon as either number is > 0 (models.rs:2669-2673).
    const half = on.find((r) => (priceNum(r.pin) !== null) !== (priceNum(r.pout) !== null));
    if (conn && half) {
      setFormErr(`「${half.id}」只填了入价或出价——覆盖价是成对生效的，另一边会按 $0 计费。两个都填，或都留空用官方价。`);
      return;
    }
    setBusy(true);
    setFormErr("");
    // A blank 倍率 must not become 0: compute_cost multiplies the whole bill by it
    // (models.rs:2715), so 0 makes every token call free. Blank → 1; an explicit 0 is honoured.
    const parsedRate = parseFloat(rate);
    const rateVal = Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : 1;
    const base = {
      label: label.trim(),
      provider,
      base_url: baseUrl.trim(),
      description: description.trim(),
      billing_mode: mode,
      rate: rateVal,
      power_route: powerRoute,
      cache_disabled: cacheDisabled,
      // Both units stay in sync: the paid path still settles whole cents, free models read micro.
      per_call_micro_usd: Math.round(usd * 1_000_000),
      per_call_cents: Math.max(0, Math.round(usd * 100)),
    };
    try {
      if (!conn) {
        // ModelReq (models.rs:1503-1519) — no protocol, no active, no enabled set on create.
        await api.post("/api/admin/models", {
          ...base,
          api_key: apiKey.trim(),
        });
      } else {
        const body: Record<string, unknown> = {
          ...base,
          active,
          protocol,
          enabled_models: ownOn.map((r) => r.id),
          drop_from_endpoints: dropFromEndpoints,
          // 手填的上下文兜底。只对实时目录没收录的模型有意义——目录有的时候网关不看这里。
          model_caps: Object.fromEntries(
            on
              .map((r) => {
                const list = r.ctx
                  .split(/[,，\s]+/)
                  .map((x) => Math.round(Number(x)))
                  .filter((n) => Number.isFinite(n) && n > 0);
                return list.length ? [r.id, { contexts: list }] : null;
              })
              .filter(Boolean) as [string, { contexts: number[] }][],
          ),
          // These three replace the whole stored map, so only keep entries for models that are
          // still exposed — config for a model you unchecked is dead weight.
          model_names: Object.fromEntries(on.filter((r) => r.name.trim()).map((r) => [r.id, r.name.trim()])),
          // 判据是「填了没有」，不是「填的是不是正数」：入价出价都填 0 = 这个模型一分不收，
          // 是一种**有意的定价**，必须原样发给后端。按 >0 过滤会把它整个丢掉，
          // 后端看不到覆盖就落回官方目录价 —— 运维以为开了免费线路，用户照样被扣钱。
          //
          // admin_update 是**整体替换**，不是 merge——只保留有手填价的模型，
          // 其它的不出现就等于清掉旧覆盖，自动跟随目录现价。
          // 报价币种：只影响这一屏怎么读写，价本身永远是美元每百万 token。
          price_currency: currency,
          // 折回美元。库里、算钱那一路全是美元，这里和下面 toUsd 是唯一的换算点。
          // 除以 cny_per_usd 而不是乘：那个数是「1 美元等于多少人民币」。
          model_prices: Object.fromEntries(
            on
              .filter((r) => priceNum(r.pin) !== null && priceNum(r.pout) !== null)
              .map((r) => [r.id, { in: toUsd(priceNum(r.pin) ?? 0), out: toUsd(priceNum(r.pout) ?? 0) }]),
          ),
          model_billing: Object.fromEntries(
            on
              .filter((r) => r.mode || nz(r.fee) > 0)
              .map((r) => {
                const micro = Math.round(nz(r.fee) * 1_000_000);
                const entry: BillingOverride = {};
                if (r.mode) entry.mode = r.mode;
                if (micro > 0) {
                  entry.per_call_micro_usd = micro;
                  entry.per_call_cents = Math.max(1, Math.round(micro / 10_000));
                }
                return [r.id, entry];
              }),
          ),
        };
        if (apiKey.trim()) body.api_key = apiKey.trim();
        // 空 = 沿用原值，和 api_key 同一规矩。一次「只改价格」的保存不该把令牌清掉。
        await api.post(`/api/admin/models/${conn.id}`, body);
      }
      onSaved();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑：${conn?.label || "未命名"}` : "新建供应商连接"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "密钥留空就是不改。停用只影响路由，下面的价格和模型都保留。"
              : "先建连接，保存后再进「编辑」拉取并勾选要开放的模型。新连接默认在转。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="cd-label">名称</Label>
            <Input
              id="cd-label"
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
              placeholder="如 官方 DeepSeek"
            />
          </div>
          <div>
            <Label htmlFor="cd-provider">品牌</Label>
            <Select id="cd-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cd-base">baseUrl</Label>
            <Input
              id="cd-base"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          <div>
            <Label htmlFor="cd-key">API Key{editing && "（留空=不改）"}</Label>
            <Input
              id="cd-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editing ? conn?.api_key_masked || "sk-…" : "sk-…"}
              autoComplete="off"
            />
          </div>
          {/*
            这一格原来是「余额令牌」（查中转控制台余额的第二套凭据）。2026-09-08 换成报价币种。
            令牌那一列**没有删**，已经填过的两条线路照旧能查余额，只是不再出现在表单里 ——
            要改它得改数据库。真正的理由是这一格的位置：中转商各报各的价，海外报美元每百万
            token，国内直接报人民币；此前只有一个美元框，运维拿到人民币报价单得自己先除一遍
            汇率，除错一位就是整条线路的进价错一个数量级，而这件事在屏幕上看不出来。
          */}
          <div>
            <Label htmlFor="cd-cur">报价币种</Label>
            <Select
              id="cd-cur"
              value={currency}
              disabled={cnyRate <= 0}
              onChange={(e) => {
                const next = e.target.value === "cny" ? "cny" : "usd";
                if (next === currency || cnyRate <= 0) { setCurrency(next); return; }
                // 数值不变，变的只是它的单位：把每一行的两个价一起换过去。
                const factor = next === "cny" ? cnyRate : 1 / cnyRate;
                setRows((prev) => prev.map((r) => ({
                  ...r, pin: convertPrice(r.pin, factor), pout: convertPrice(r.pout, factor),
                })));
                setCurrency(next);
              }}
            >
              <option value="usd">美元（$ / 百万 token）</option>
              <option value="cny">人民币（¥ / 百万 token）</option>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              下面「开放的模型」里的入价出价按这个币种读写。<b>存进库的永远是美元</b>——
              {cnyRate > 0
                ? `选人民币时按后台设置里的汇率（此刻 1 美元 ≈ ¥${cnyRate.toFixed(2)}）在保存那一刻折一次，之后这条线路的价就是一个定数，以后改汇率不会改动它。`
                : "后台还没下发汇率，暂时只能按美元录。"}
            </p>
          </div>
          {editing && (
            <div>
              <Label htmlFor="cd-protocol">上游协议</Label>
              <Select id="cd-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="anthropic">Anthropic 原生 /v1/messages</option>
                <option value="openai">OpenAI 兼容 /chat/completions</option>
                <option value="xai_responses">xAI Responses /v1/responses（grok 的思考摘要只在这条上给）</option>
              </Select>
            </div>
          )}
          <div className="sm:col-span-2">
            <Label htmlFor="cd-desc">描述（IDE 选模型时显示）</Label>
            <Input
              id="cd-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="如 擅长复杂推理与编程"
            />
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-border p-4">
          <Checkbox
            className="mt-1"
            checked={powerRoute}
            onChange={(e) => setPowerRoute(e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium">Claude 强力版线路</span>
            <span className="mt-0.5 block text-muted-foreground">
              勾上之后，IDE 里 Claude 模型卡片右上角的「强力版」开关打开时，那一轮请求只会落到
              勾了这个标记的线路上。没有勾任何线路时，那个开关会明确报错而不是悄悄退回普通线路——
              用户点了强力版就该走强力线路，退回去等于把他的选择改掉了。
            </span>
          </span>
        </label>

        {editing && (
          <label className="flex items-start gap-3 rounded-lg border border-border p-4">
            <Checkbox
              className="mt-1"
              checked={active}
              onChange={(e) => setActiveField(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium">投入轮转</span>
              <span className="mt-0.5 block text-muted-foreground">
                取消勾选＝这条线路不再接任何请求，IDE 的模型列表也不再出现它的模型。密钥和定价原样保留。
              </span>
            </span>
          </label>
        )}

        <div className="rounded-lg border border-border p-4">
          <Label htmlFor="cd-mode">计费方式</Label>
          <Select id="cd-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="rate">按 Token（真实成本 × 倍率）</option>
            <option value="per_call">按次（每次调用固定收费）</option>
          </Select>
          {mode === "rate" ? (
            <div className="mt-4 space-y-4">
              <div className="sm:max-w-56">
                <Label htmlFor="cd-rate">倍率</Label>
                <Input id="cd-rate" type="number" min="0" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cacheDisabled}
                  onChange={(e) => setCacheDisabled(e.target.checked)}
                />
                关闭缓存计费（缓存读/写都不收钱，输入输出价照常）
              </label>
            </div>
          ) : (
            <div className="mt-4 sm:max-w-56">
              <Label htmlFor="cd-percall">每次调用收费 $</Label>
              <Input
                id="cd-percall"
                type="number"
                min="0"
                step="0.000001"
                value={perCall}
                onChange={(e) => setPerCall(e.target.value)}
              />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            倍率是加价，3 = 按真实成本的 3 倍收；留空按 1 算，填 0 就是一分不收。价格和缓存价一律取自
            拉取的模型目录；单模型价在下面逐个设。勾上「关闭缓存计费」= 这条线路的缓存读/写都不收钱
            （灰产/便宜渠道用），输入输出价不受影响。
          </p>
        </div>

        {editing && (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <Label className="mb-0">开放的模型</Label>
              <div className="flex items-center gap-3">
                {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
                {/*
                  一键把这条线路上所有手填价清掉、改为跟随 OpenRouter 实时价。
                  清掉不是「设成 0」—— 保存时 model_prices 只收非零项，空着就是没有覆盖，
                  运行时会去查实时目录（effective_token_prices 的第二级）。
                  所以以后 OpenRouter 降价，你跟着降，不用再手工改一遍。
                */}
                {rows.some((r) => nz(r.pin) > 0 || nz(r.pout) > 0) && (
                  <Button
                    variant="outline"
                    size="sm"
                    title="清掉这条线路上所有手填的单模型价，全部改为跟随 OpenRouter 实时价"
                    onClick={() =>
                      setRows((prev) => prev.map((r) => ({ ...r, pin: "", pout: "" })))
                    }
                  >
                    全部用现价
                  </Button>
                )}
                {rows.some((r) => r.gone && r.on) && (
                  <Button
                    variant="outline"
                    size="sm"
                    title="拉取结果里没有的、但还勾着的模型：一键取消勾选（保存后生效）"
                    onClick={() =>
                      setRows((prev) => prev.map((r) => (r.gone && r.on ? { ...r, on: false } : r)))
                    }
                  >
                    去掉已下架的（{rows.filter((r) => r.gone && r.on).length}）
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={fetching || conn?.has_key === false}
                  onClick={fetchCatalog}
                >
                  {fetching ? "拉取中…" : "拉取可用模型"}
                </Button>
              </div>
            </div>
            <div className="max-h-72 overflow-auto rounded-lg border border-border p-1.5">
              {rows.length ? (
                rows.map((r) => (
                  <div key={r.id} className="flex min-w-[38rem] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/60">
                    <Checkbox
                      checked={r.on}
                      aria-label={`开放 ${r.id}`}
                      onChange={(e) => patch(r.id, { on: e.target.checked })}
                    />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-xs" title={r.id}>
                          {r.id}
                        </span>
                        {r.carried && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                            title={`线路自己的地址没有这个模型，是出口带来的：${r.carried.join("、")}。取消勾选会把它从那些出口上拿掉，IDE 里就看不到了。`}
                          >
                            由出口带来 · {r.carried.join("、")}
                          </Badge>
                        )}
                        {r.gone && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-destructive/40 text-[10px] text-destructive"
                            title="这次拉取上游没有回这个模型：勾着也派不出去。"
                          >
                            已下架
                          </Badge>
                        )}
                      </span>
                      <CapsLine caps={r.caps} />
                    </span>
                    <Input
                      className="h-9 w-28 shrink-0 px-2.5 text-sm"
                      value={r.name}
                      placeholder="显示名"
                      aria-label={`${r.id} 显示名`}
                      onChange={(e) => patch(r.id, { name: e.target.value })}
                    />
                    <Input
                      className="h-9 w-20 shrink-0 px-2.5 text-sm"
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.pin}
                      placeholder={r.caps?.input_price != null ? String(toShown(r.caps.input_price)) : "入价"}
                      title={
                        r.caps?.input_price != null
                          // 官方价是美元，这里按这一屏选定的币种折过再显示。不再并排摆两种
                          // 货币：一个框旁边有两个数，最容易发生的就是照着另一种货币的数字填。
                          ? `留空即用官方价 ${sym}${toShown(r.caps.input_price)}/1M。这一栏的单位是**${ccy}**每百万 token。`
                          : undefined
                      }
                      aria-label={`${r.id} 输入价`}
                      onChange={(e) => patch(r.id, { pin: e.target.value })}
                    />
                    <Input
                      className="h-9 w-20 shrink-0 px-2.5 text-sm"
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.pout}
                      placeholder={r.caps?.output_price != null ? String(toShown(r.caps.output_price)) : "出价"}
                      title={
                        r.caps?.output_price != null
                          // 官方价是美元，这里按这一屏选定的币种折过再显示。不再并排摆两种
                          // 货币：一个框旁边有两个数，最容易发生的就是照着另一种货币的数字填。
                          ? `留空即用官方价 ${sym}${toShown(r.caps.output_price)}/1M。这一栏的单位是**${ccy}**每百万 token。`
                          : undefined
                      }
                      aria-label={`${r.id} 输出价`}
                      onChange={(e) => patch(r.id, { pout: e.target.value })}
                    />
                    {/*
                      把实时价摆到明面上。
                      placeholder 只在输入框为空时看得见 —— 一旦填了数字，实时价就消失了，
                      于是没人知道自己填的那个数和现在的价差了多少。线上实测差到 37 倍
                      （deepseek-v4-flash 填 3，OpenRouter 现价 0.0795）。
                    */}
                    {r.caps?.input_price != null && (
                      <div className="flex w-44 shrink-0 items-center gap-1.5 text-[11px]">
                        {nz(r.pin) > 0 || nz(r.pout) > 0 ? (
                          <>
                            <span
                              className={cn(
                                "tabular-nums",
                                priceGap(r) >= 2 ? "font-medium text-amber-600" : "text-muted-foreground",
                              )}
                              // OpenRouter 报的是美元；按这一屏的币种折过再说，
                              // 否则「现价」那个数和旁边输入框里的数不是同一种货币。
                              title={`OpenRouter 现价 ${sym}${toShown(r.caps.input_price ?? 0)}/${sym}${toShown(r.caps.output_price ?? 0)} 每 1M`}
                            >
                              现价 {sym}{toShown(r.caps.input_price ?? 0)}/{sym}{toShown(r.caps.output_price ?? 0)}
                              {priceGap(r) >= 1.1 && ` · 你 ${priceGap(r).toFixed(1)}×`}
                            </span>
                            <button
                              type="button"
                              className="shrink-0 rounded border border-border px-1.5 py-0.5 hover:bg-muted"
                              title="清掉手填价，改为跟随 OpenRouter 实时价 —— 以后它降价你也跟着降"
                              onClick={() => patch(r.id, { pin: "", pout: "" })}
                            >
                              用现价
                            </button>
                          </>
                        ) : (
                          <span className="text-emerald-600">跟随现价</span>
                        )}
                      </div>
                    )}
                    {r.caps?.source !== "live" && (
                      <Input
                        className="h-9 w-36 shrink-0 px-2.5 text-sm"
                        value={r.ctx}
                        placeholder="上下文兜底"
                        aria-label={`${r.id} 上下文兜底`}
                        title={"实时目录里没有这一款，可在这里手填上下文档位（逗号分隔，如 128000,204800）。\n目录收录之后会自动改用目录的值，这里填的就不再生效。"}
                        onChange={(e) => patch(r.id, { ctx: e.target.value })}
                      />
                    )}
                    <div className="w-28 shrink-0">
                      <Select
                        className="h-9 pl-2.5 pr-8 text-sm"
                        value={r.mode}
                        aria-label={`${r.id} 计费方式`}
                        onChange={(e) => patch(r.id, { mode: e.target.value })}
                      >
                        <option value="">跟随渠道</option>
                        <option value="rate">按 Token</option>
                        <option value="per_call">按次</option>
                        <option value="free">免费</option>
                      </Select>
                    </div>
                    <Input
                      className="h-9 w-20 shrink-0 px-2.5 text-sm"
                      type="number"
                      min="0"
                      step="0.000001"
                      value={r.fee}
                      placeholder="次费$"
                      aria-label={`${r.id} 每次收费`}
                      onChange={(e) => patch(r.id, { fee: e.target.value })}
                    />
                  </div>
                ))
              ) : (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  还没有模型。点「拉取可用模型」，勾上要开放进 IDE 的。
                </p>
              )}
            </div>
            {conn?.model_id && !rows.some((r) => r.on) && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                一个都不勾也关不掉这条线路：勾选集为空时，服务端会退回旧的单模型字段「{conn.model_id}」，
                IDE 里仍然看得到它。要彻底停掉，请用列表里的「停用」。
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              「拉取可用模型」用的是已保存的密钥，刚填的新密钥要先保存才能拉。
              显示名只改 IDE 里的叫法，调用仍用原始 id。入价 / 出价要么都填、要么都留空——填了就以你填的为准（倍率照样叠加），
              留空才按内置官方价，**两栏都填 0 = 这个模型一分不收**（非会员、零余额也能用，和「免费」不同：那个走每日点数、点数用完就落到钱包）。选「按次」的模型必须填次费，否则服务端会拒绝保存；「免费」按次费折算成每日免费点数扣，不动钱包。
            </p>
          </div>
        )}

        {formErr && <p role="alert" className="text-sm text-destructive">{formErr}</p>}

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? "保存中…" : editing ? "保存" : "创建"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
