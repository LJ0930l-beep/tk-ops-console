/**
 * 汇率服务（方案表 18 / PRD 5.4 汇率与折算）——全系统唯一的外币 → 人民币折算入口
 *
 * 口径：
 *  1) 一律折成人民币：金额 × rate_to_cny；CNY 恒为 1。
 *  2) 按「业务发生日期」取价（订单 = 报表自然日、费用 = expense_date、广告 = stat_date、结算 = statement_time）。
 *     当日没有 → 回退该币种「更早的最近一条」（历史报表不因今天的汇率变化而改写昨天的数字）。
 *  3) 更早的也没有 → 再退「之后的最近一条」；完全没有 → 用兜底常量，并把 missing=true 带回调用方，
 *     报表响应里必须标 rate_missing，绝不静默按 1 折算（静默按 1 会把利润算成天文数字）。
 */
import { round2 } from '@tk/shared';
import { all, get, insert, update } from '../core/db.js';

export const CNY = 'CNY';

/** 兜底牌价：1 单位外币 = ? 人民币。仅在 exchange_rate 完全无该币种记录时使用，且必须标 missing */
export const FALLBACK_RATE_TO_CNY: Record<string, number> = {
  USD: 7.15, MYR: 2.12, PHP: 0.128, SGD: 5.6, THB: 0.2, IDR: 0.00045, VND: 0.00029, MXN: 0.42, GBP: 9.1, EUR: 7.8, CNY: 1,
};

/** 'YYYY-MM-DD HH:MM:SS' / ISO / 空值 → 统一 'YYYY-MM-DD' */
export const rateDay = (date: string | number | null | undefined): string => String(date ?? '').slice(0, 10);

/** 币种归一：去空格转大写，空视为 CNY */
export const normalizeCurrency = (currency: string | number | null | undefined): string => (String(currency ?? '') || CNY).trim().toUpperCase();

/** 今天（UTC 日历日），汇率表按日落库，与 datetime('now') 同口径 */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export interface RateInfo {
  /** 1 单位外币 = rate 人民币 */
  rate: number;
  /** 实际用到的汇率日期（兜底时为请求日） */
  source_date: string;
  /** true = 当日与历史都没有，用了兜底常量，报表必须提示 */
  missing: boolean;
}

/**
 * 取某币种在某日的对人民币汇率。
 * 当日 → 更早最近一条 → 更近最近一条 → 兜底常量（missing=true）。
 */
export function getRate(currency: string, date: string): RateInfo {
  const cur = normalizeCurrency(currency);
  const day = rateDay(date) || todayUtc();
  if (cur === CNY) return { rate: 1, source_date: day, missing: false };

  const before = get<{ rate_date: string; rate_to_cny: number | string }>(
    `SELECT rate_date, rate_to_cny FROM exchange_rate
      WHERE is_deleted = 0 AND currency = ? AND rate_date <= ?
      ORDER BY rate_date DESC, id DESC LIMIT 1`,
    cur,
    day,
  );
  const after = before
    ? undefined
    : get<{ rate_date: string; rate_to_cny: number | string }>(
        `SELECT rate_date, rate_to_cny FROM exchange_rate
          WHERE is_deleted = 0 AND currency = ? AND rate_date > ?
          ORDER BY rate_date ASC, id ASC LIMIT 1`,
        cur,
        day,
      );
  const hit = before ?? after;
  const rate = Number(hit?.rate_to_cny ?? NaN);
  if (hit && Number.isFinite(rate) && rate > 0) return { rate, source_date: hit.rate_date, missing: false };

  const fallback = FALLBACK_RATE_TO_CNY[cur];
  if (fallback && fallback > 0) return { rate: fallback, source_date: day, missing: true };
  return { rate: 1, source_date: day, missing: true };
}

/** 金额折人民币（只要数字时用这个；需要知道用了哪天/是否兜底时用 getRate） */
export function toCny(amount: number, currency: string, date: string): number {
  return round2(Number(amount || 0) * getRate(currency, date).rate);
}

/** 折人民币并带回取价信息 */
export function toCnyInfo(amount: number, currency: string, date: string): { amount_cny: number; rate: number; source_date: string; missing: boolean } {
  const info = getRate(currency, date);
  return { amount_cny: round2(Number(amount || 0) * info.rate), rate: info.rate, source_date: info.source_date, missing: info.missing };
}

/**
 * 一次报表取数内复用的汇率器：按 币种|日期 记忆化，并记录哪些币种走了兜底价。
 * 利润引擎与看板共用同一个解析器，保证同一批次取数口径完全一致。
 */
export function createRateConverter(): {
  rate: (currency: string, date: string) => RateInfo;
  cny: (amount: number, currency: string, date: string) => number;
  /** 走了兜底常量的币种（报表提示 rate_missing 用） */
  missingCurrencies: () => string[];
} {
  const cache = new Map<string, RateInfo>();
  const missing = new Set<string>();
  const rate = (currency: string, date: string): RateInfo => {
    const cur = normalizeCurrency(currency);
    const key = `${cur}|${rateDay(date)}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = getRate(cur, date);
      cache.set(key, hit);
      if (hit.missing) missing.add(cur);
    }
    return hit;
  };
  return {
    rate,
    cny: (amount, currency, date) => round2(Number(amount || 0) * rate(currency, date).rate),
    missingCurrencies: () => [...missing].sort(),
  };
}

/** 金额折人民币：币种已经在 CNY 语义下（成本快照/样品成本/费用 amount_cny）时的统一写法 */
export const asCny = (amount: number): number => round2(Number(amount || 0));

/** 兜底汇率的 SQL 表达式（汇总回写时用，JS 与 SQL 同一套常量） */
export function fallbackRateSql(currencyCol: string): string {
  const whens = Object.entries(FALLBACK_RATE_TO_CNY)
    .filter(([c]) => c !== CNY)
    .map(([c, r]) => `WHEN ${currencyCol} = '${c}' THEN ${r}`)
    .join(' ');
  return `CASE ${whens} ELSE 1 END`;
}

/** 取价 SQL 表达式：当日 → 更早最近一条 → 兜底常量（用于必须留在 SQL 里的汇总回写） */
export function rateSqlExpr(currencyCol: string, dateCol: string): string {
  return `(SELECT e.rate_to_cny FROM exchange_rate e
            WHERE e.is_deleted = 0 AND e.currency = ${currencyCol} AND e.rate_date <= ${dateCol}
            ORDER BY e.rate_date DESC, e.id DESC LIMIT 1)`;
}

/** 带汇率折算的 SQL 表达式（CNY 直接返回原金额） */
export function toCnySql(amountCol: string, currencyCol: string, dateCol: string): string {
  return `(CASE WHEN ${currencyCol} = 'CNY' THEN ${amountCol}
           ELSE ${amountCol} * IFNULL(${rateSqlExpr(currencyCol, dateCol)}, ${fallbackRateSql(currencyCol)}) END)`;
}

export interface RateRow {
  id: number;
  rate_date: string;
  currency: string;
  rate_to_cny: number;
  source: number;
  /** 与上一日的波动百分比，前端展示涨跌用 */
  change_pct: number | null;
}

/** 汇率列表：日期区间 + 币种，按日期倒序 */
export function listRates(opts: { from?: string; to?: string; currency?: string | null; source?: number | null } = {}): RateRow[] {
  const rows = all<{ id: number; rate_date: string; currency: string; rate_to_cny: number | string; source: number }>(
    `SELECT id, rate_date, currency, rate_to_cny, source FROM exchange_rate
      WHERE is_deleted = 0 AND (? = '' OR currency = ?) AND (? = '' OR rate_date >= ?) AND (? = '' OR rate_date <= ?)
      ORDER BY currency ASC, rate_date DESC, id DESC`,
    opts.currency ?? '',
    opts.currency ?? '',
    rateDay(opts.from ?? ''),
    rateDay(opts.from ?? ''),
    rateDay(opts.to ?? ''),
    rateDay(opts.to ?? ''),
  ).map((r) => ({ id: r.id, rate_date: r.rate_date, currency: r.currency, rate_to_cny: Number(r.rate_to_cny), source: Number(r.source) }));
  const prevByDay = new Map<string, number>();
  return rows.map((r) => {
    const prev = prevByDay.get(r.currency);
    prevByDay.set(r.currency, r.rate_to_cny);
    return { ...r, change_pct: prev && prev > 0 ? round2(((r.rate_to_cny - prev) / prev) * 100) : null };
  });
}

/** 各币种最新一条（前端「今天按多少折算」展示 + 缺失日补齐基准） */
export function latestRates(): { currency: string; rate_date: string; rate_to_cny: number; source: number; days_ago: number }[] {
  return all<{ currency: string; rate_date: string; rate_to_cny: number | string; source: number }>(
    `SELECT e.currency, e.rate_date, e.rate_to_cny, e.source
       FROM exchange_rate e
       JOIN (SELECT currency, MAX(rate_date) AS md FROM exchange_rate WHERE is_deleted = 0 GROUP BY currency) m
         ON m.currency = e.currency AND m.md = e.rate_date
      WHERE e.is_deleted = 0
      GROUP BY e.currency
      ORDER BY e.currency ASC`,
  ).map((r) => ({
    currency: r.currency,
    rate_date: r.rate_date,
    rate_to_cny: Number(r.rate_to_cny),
    source: Number(r.source),
    days_ago: Math.floor((Date.parse(`${todayUtc()}T00:00:00Z`) - Date.parse(`${r.rate_date}T00:00:00Z`)) / 86400_000),
  }));
}

/** 可见币种（汇率表里有的 + 店铺在用的），下拉用 */
export function listCurrencies(): string[] {
  const set = new Set<string>(all<{ currency: string }>(`SELECT DISTINCT currency FROM exchange_rate WHERE is_deleted = 0`).map((r) => r.currency));
  for (const s of all<{ currency: string }>(`SELECT DISTINCT currency FROM tk_shop WHERE is_deleted = 0`)) set.add(s.currency);
  return [...set].sort();
}

export interface RateUpsertInput {
  rate_date: string;
  currency: string;
  rate_to_cny: number;
  /** 1 自动 2 手工 */
  source?: number;
  user_id?: number | null;
}

/** 维护汇率：(rate_date, currency) 唯一（ux_rate），已存在则覆盖更新 */
export function upsertRate(input: RateUpsertInput): { id: number; created: boolean; rate_date: string; currency: string } {
  const currency = normalizeCurrency(input.currency);
  const day = rateDay(input.rate_date);
  const exist = get<{ id: number }>(`SELECT id FROM exchange_rate WHERE is_deleted = 0 AND rate_date = ? AND currency = ?`, day, currency);
  if (exist) {
    update('exchange_rate', exist.id, { rate_to_cny: input.rate_to_cny, source: input.source ?? 2 } as never);
    return { id: exist.id, created: false, rate_date: day, currency };
  }
  const id = insert('exchange_rate', {
    rate_date: day,
    currency,
    rate_to_cny: input.rate_to_cny,
    source: input.source ?? 2,
    created_by: input.user_id ?? null,
  });
  return { id, created: true, rate_date: day, currency };
}

/** 汇率保留精度：小额币种（PHP/IDR 等）4 位小数会丢信息，统一按量级取位 */
export const roundRate = (n: number): number => (n >= 100 ? round2(n) : Math.round((n + Number.EPSILON) * 100000) / 100000);

/**
 * 「拉取公开牌价」的本地模拟：在上一日值上加 ±0.15% 的确定性波动（同一天重复调用结果一致），
 * 不访问外网；source=1 自动。真实对接时替换本函数体即可，调用方与口径不变。
 */
export function mockFetchRates(opts: { date?: string; currencies?: string[] } = {}): {
  date: string;
  rows: { currency: string; rate_to_cny: number; prev_rate: number; created: boolean }[];
} {
  const date = rateDay(opts.date ?? todayUtc());
  const currencies = (opts.currencies?.length ? opts.currencies.map(normalizeCurrency) : listCurrencies()).filter((c) => c !== CNY);
  const rows = currencies.map((cur) => {
    const last = get<{ rate_to_cny: number | string }>(
      `SELECT rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? ORDER BY rate_date DESC, id DESC LIMIT 1`,
      cur,
    );
    const prev = Number(last?.rate_to_cny ?? FALLBACK_RATE_TO_CNY[cur] ?? 1);
    const drift = ((dateKey(date) % 7) - 3) * 0.0005;
    const rate = roundRate(prev * (1 + drift));
    const r = upsertRate({ rate_date: date, currency: cur, rate_to_cny: rate, source: 1, user_id: null });
    return { currency: cur, rate_to_cny: rate, prev_rate: prev, created: r.created };
  });
  return { date, rows };
}

/** 日期串 → 稳定整数（模拟波动的种子，避免引入随机数导致报表数字不可复现） */
function dateKey(date: string): number {
  return date.replace(/-/g, '').slice(-5) ? Number(date.replace(/-/g, '').slice(-5)) : 0;
}
