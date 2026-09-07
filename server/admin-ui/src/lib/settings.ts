/**
 * 运营参数的客户端镜像。唯一真相在服务端 `app_settings` / `plan_quotas` 表
 * （server/src/settings.rs），这里只是缓存一份用来渲染。
 *
 * 为什么需要这个文件：面值分母（663 真实计费分 = 客户看到的 $1.00）原先被硬编码了
 * 四份——Customers.tsx、Billing.tsx、static/admin.html、ide/src/main.js——其中三份在
 * **写路径**上：管理员输入的美元由前端乘 663 变成存库的真实分，服务端不做二次换算。
 * 也就是说，改服务端而不改前端，"发出去多少额度"会当场和"显示多少"对不上，而且没有
 * 任何报错。所以只要还有第二份字面量 663 存在，这个数就不能做成可配置的。
 *
 * 这里不引缓存库：一个运营台、一个操作员，参数一天改不了一次。模块级变量 +
 * useSyncExternalStore 足够，且与 api.ts "不引数据层依赖" 的取向一致。
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";

export type PlanQuota = {
  plan: string;
  total_cents: number;
  window_cents: number;
  weekly_cents: number;
  days: number;
  rank: number;
  /** 这一行是否还等于代码里的出厂值 —— 用来把「没人设置过」和「你设的」区分开。 */
  is_default?: boolean;
};

export type AdminSettings = {
  raw_cents_per_credit_usd: number;
  free_points_daily: number;
  /**
   * 会员那一档配的是什么。三态，别压成两态：
   *   undefined —— 这台网关还不认第二档（旧网关不发这个键）
   *   null      —— 认，但运营没单独配 → 跟随非会员那一档
   *   number    —— 配了这个数（0 合法，= 关掉会员的免费额度）
   */
  free_points_daily_member?: number | null;
  /** 会员**今天实际拿多少**（没配时 = free_points_daily）。展示用，别拿它回填输入框。 */
  free_points_daily_member_effective?: number;
  plans: PlanQuota[];
  limits: {
    raw_cents_per_credit_usd: [number, number];
    free_points_daily: [number, number];
    /** 旧网关不下发。它的**存在与否**就是「这台网关认不认第二档」的探针。 */
    free_points_daily_member?: [number, number];
  };
  /** 1 点值多少真实计费分。**不再是编译期常量**：由「100 积分 = ¥1」和后台汇率推导。 */
  raw_cents_per_point: number;
  /** 同一个数换个刻度（micro-USD/点），扣费实际用的就是它。 */
  micro_usd_per_point?: number;
  /** 1 点等于多少人民币分。100 积分 = ¥1 → 1。 */
  cny_cents_per_point?: number;
};

/** 网关答复之前的兜底，逐字等于改造前的硬编码值——首屏渲染行为不变。 */
export /**
 * 网关答复之前的兜底，逐字等于改造前的硬编码值——首屏渲染行为不变。
 *
 * # 这里**故意没有** free_points_daily_member / limits.free_points_daily_member
 *
 * 这个站是独立发布的（deploy.sh 只发后端容器，前端走 deploy-admin-ui.sh），所以
 * 「新控制台 + 旧网关」不是意外，是两次部署之间的常态。而 loadSettings 的合并写法是
 * `{ ...FALLBACK, ...s }`：只要兜底里有这个字段，旧网关下设置页就会拿兜底值当真值，
 * 印出一句「会员每天 40 点」—— 而那台网关连第二档的概念都没有。
 * 一个自信的假数比一句「暂不支持」难查得多。字段缺席 = 不支持，界面据此照实说。
 */
const FALLBACK: AdminSettings = {
  raw_cents_per_credit_usd: 663,
  free_points_daily: 40,
  plans: [],
  limits: { raw_cents_per_credit_usd: [1, 100000], free_points_daily: [0, 1000000] },
  // 兜底值按「100 积分 = ¥1」+ 默认汇率推导（1408 micro/点 ÷ 10000）≈ 0.14 真实分。
  // 原来这里是 5 —— 那是 1 点 ≈ ¥0.355 的旧口径，和后台设定差 35 倍。
  raw_cents_per_point: 0.1408,
  micro_usd_per_point: 1408,
  cny_cents_per_point: 1,
};

let snapshot: AdminSettings = FALLBACK;
/**
 * 设置**真的从服务端读到过**没有。
 *
 * 分母是写路径上的乘数：运营输入的美元 × 分母 = 存库的真实分。没读到就用 FALLBACK 的 663
 * 去乘，而线上分母是运营可改的（服务端允许 1~100000）。改过之后一旦这次拉取失败，
 * 「发放 $50」会按错误的分母折算 —— 发出去的额度直接是错的，而页面上没有任何痕迹。
 *
 * 所以要把「兜底」和「真值」分开：显示路径继续用兜底（否则每个金额都变成 Infinity），
 * **写路径必须等真值到货**。
 */
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * 面值分母。**永远不会返回 0** —— 它在展示路径上是除数，0 会让每一个余额变成
 * Infinity。服务端有 CHECK 和 clamp，这里再兜一层，因为这是所有金额显示的入口。
 */
export function creditDenominator(): number {
  const n = Math.round(Number(snapshot.raw_cents_per_credit_usd));
  return Number.isFinite(n) && n >= 1 ? n : FALLBACK.raw_cents_per_credit_usd;
}

/** 真实计费分 → 面值分（客户看到的那个数，单位是分）。 */
export function creditCentsFromRaw(raw?: number | null): number {
  return Math.round(((raw || 0) / creditDenominator()) * 100);
}

/** 面值美元（输入框里的字符串）→ 存库的真实计费分。写路径。 */
export function rawCentsFromCreditDollars(dollars: string | number): number {
  const v = typeof dollars === "number" ? dollars : Number.parseFloat(dollars);
  return Math.round((Number.isFinite(v) ? v : 0) * creditDenominator());
}

export function currentSettings(): AdminSettings {
  return snapshot;
}

export function applySettings(next: Partial<AdminSettings>) {
  snapshot = { ...snapshot, ...next };
  // 设置页保存成功后会调它，那也算读到过真值了。
  loaded = true;
  emit();
}

let inflight: Promise<AdminSettings> | null = null;

/** 拉一次设置。重复调用共享同一个请求；失败保留兜底值，不让整台控制台白屏。 */
export async function loadSettings(force = false): Promise<AdminSettings> {
  if (inflight && !force) return inflight;
  inflight = api
    .get<AdminSettings>("/api/admin/settings")
    .then((s) => {
      snapshot = { ...FALLBACK, ...s };
      loaded = true;
      emit();
      return snapshot;
    })
    .catch(() => snapshot)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 设置到货了没有。**写金额之前必须问一次** —— 见 `loaded` 上面那段。
 *
 * 订阅走 useSettings()：它变化时组件会重渲染，所以按钮的禁用状态会自己跟上。
 */
export function settingsLoaded(): boolean {
  return loaded;
}

/** 组件里用它订阅：设置到货后自动重渲染，金额不会停在兜底面值上。 */
/**
 * 服务端**当前真实存在**的套餐 key 列表。
 *
 * # 为什么不能在前端写死
 *
 * 「运营在后台新建的套餐」是个真实存在的动作 —— 线上 `plan_quotas` 现在有 6 个套餐，
 * 而三个页面里各自写死的那份数组只有 5 个（trial/basic/pro/power/ultra），漏掉了 `ceshi`。
 * 症状不是报错，是**下拉框里没有那一档**：邮件群发筛不到那批用户、客户页筛选看不到、
 * 收款页发不出那一档的兑换码。运营会以为「这个套餐坏了」。
 *
 * 排序跟服务端的 rank 走（服务端已经按 rank 排好），所以档位高低的顺序在两边永远一致。
 *
 * 还没读到设置时回空数组 —— 调用方该显示「读取中」，而不是拿一份可能过期的名单顶上。
 */
export function planKeys(): string[] {
  return currentSettings().plans.map((p) => p.plan).filter(Boolean);
}

export function useSettings(): AdminSettings {
  return useSyncExternalStore(subscribe, currentSettings, currentSettings);
}

/** 这台网关认不认「会员那一档」。判据是 limits 里有没有这一项，不是值是不是 null。 */
export function memberTierSupported(s: AdminSettings = snapshot): boolean {
  return s.limits?.free_points_daily_member !== undefined;
}
