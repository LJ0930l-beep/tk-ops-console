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
import { all, get, insert, tx, update } from '../core/db.js';

export const CNY = 'CNY';

/** 汇率来源：1 Frankfurter 公开 API；2 手工；3 从前值延用；4 演示数据。 */
export const RATE_SOURCE = { FRANKFURTER: 1, MANUAL: 2, CARRIED: 3, DEMO: 4 } as const;
export type RateSource = (typeof RATE_SOURCE)[keyof typeof RATE_SOURCE];
/** MySQL schema stores DECIMAL(18,6): maximum representable positive exchange rate. */
export const MAX_RATE_TO_CNY = 999_999_999_999.99;

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
  source?: RateSource;
  user_id?: number | null;
}

/** 维护汇率：(rate_date, currency) 唯一（ux_rate）；自动/延用值永不覆盖手工值。 */
export function upsertRate(input: RateUpsertInput): { id: number; created: boolean; rate_date: string; currency: string; skipped?: 'manual' } {
  const currency = normalizeCurrency(input.currency);
  const day = rateDay(input.rate_date);
  const source = input.source ?? RATE_SOURCE.MANUAL;
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('币种必须使用三字母代码');
  if (!validIsoDay(day)) throw new Error('汇率日期必须是有效的 YYYY-MM-DD');
  if (![1, 2, 3, 4].includes(source)) throw new Error('汇率来源不合法');
  if (!Number.isFinite(input.rate_to_cny) || input.rate_to_cny <= 0 || input.rate_to_cny > MAX_RATE_TO_CNY) throw new Error('汇率必须是可存储的有限正数');
  if (currency === CNY && input.rate_to_cny !== 1) throw new Error('CNY 汇率必须固定为 1');
  const exist = get<{ id: number; source: number }>(`SELECT id, source FROM exchange_rate WHERE is_deleted = 0 AND rate_date = ? AND currency = ?`, day, currency);
  if (exist) {
    if (Number(exist.source) === RATE_SOURCE.MANUAL && source !== RATE_SOURCE.MANUAL) {
      return { id: exist.id, created: false, rate_date: day, currency, skipped: 'manual' };
    }
    update('exchange_rate', exist.id, { rate_to_cny: input.rate_to_cny, source } as never);
    return { id: exist.id, created: false, rate_date: day, currency };
  }
  const id = insert('exchange_rate', {
    rate_date: day,
    currency,
    rate_to_cny: input.rate_to_cny,
    source,
    created_by: input.user_id ?? null,
  });
  return { id, created: true, rate_date: day, currency };
}

/** 汇率保留六位小数，与 exchange_rate DECIMAL(18,6) 对齐，避免小额币种被截断。 */
export const roundRate = (n: number): number => Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;

const FRANKFURTER_RATES_URL = 'https://api.frankfurter.dev/v2/rates';
const FRANKFURTER_TIMEOUT_MS = 8_000;

export class PublicRateSourceError extends Error {
  constructor(message = '公开汇率服务暂不可用') {
    super(message);
    this.name = 'PublicRateSourceError';
  }
}

export class InvalidRateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRateRequestError';
  }
}

export function validIsoDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

interface FrankfurterRate {
  date?: unknown;
  base?: unknown;
  quote?: unknown;
  rate?: unknown;
}

/**
 * 从 Frankfurter v2 获取 CNY 基准牌价。API 返回「1 CNY = x 外币」，落库前取倒数，
 * 统一成「1 外币 = N CNY」。所有响应先完整校验，再开启事务写入，避免网络/脏响应留下半批数据。
 */
export async function fetchPublicRates(opts: { date?: string; currencies?: string[] } = {}): Promise<{
  date: string;
  source: 'Frankfurter v2 public API';
  rows: { currency: string; rate_to_cny: number; prev_rate: number | null; created: boolean; skipped?: 'manual' }[];
}> {
  const requestedDate = opts.date ? rateDay(opts.date) : undefined;
  if (requestedDate && !validIsoDay(requestedDate)) throw new InvalidRateRequestError('汇率日期必须是有效的 YYYY-MM-DD');
  const requestedCurrencies = opts.currencies?.length ? opts.currencies : listCurrencies();
  const currencies = [...new Set(requestedCurrencies.map(normalizeCurrency).filter((c) => c !== CNY))];
  if (currencies.length === 0) throw new InvalidRateRequestError('没有可刷新的外币');
  if (currencies.length > 100 || currencies.some((c) => !/^[A-Z]{3}$/.test(c))) {
    throw new InvalidRateRequestError('币种列表不合法');
  }

  const url = new URL(FRANKFURTER_RATES_URL);
  url.searchParams.set('base', CNY);
  url.searchParams.set('quotes', currencies.join(','));
  if (requestedDate) url.searchParams.set('date', requestedDate);

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FRANKFURTER_TIMEOUT_MS) });
    if (!response.ok) throw new PublicRateSourceError();
    payload = await response.json();
  } catch (error) {
    if (error instanceof PublicRateSourceError) throw error;
    throw new PublicRateSourceError();
  }

  if (!Array.isArray(payload)) throw new PublicRateSourceError('公开汇率服务返回格式异常');
  const byCurrency = new Map<string, { date: string; rate_to_cny: number }>();
  for (const entry of payload as FrankfurterRate[]) {
    const cur = normalizeCurrency(typeof entry?.quote === 'string' ? entry.quote : '');
    const base = normalizeCurrency(typeof entry?.base === 'string' ? entry.base : '');
    const day = typeof entry?.date === 'string' ? entry.date : '';
    const rawRate = entry?.rate;
    const inverse = typeof rawRate === 'number' ? 1 / rawRate : NaN;
    const roundedInverse = roundRate(inverse);
    if (!currencies.includes(cur) || byCurrency.has(cur) || base !== CNY || !validIsoDay(day)
      || !Number.isFinite(rawRate) || Number(rawRate) <= 0 || !Number.isFinite(inverse) || inverse <= 0
      || !Number.isFinite(roundedInverse) || roundedInverse <= 0 || roundedInverse > MAX_RATE_TO_CNY) {
      throw new PublicRateSourceError('公开汇率服务返回无效牌价');
    }
    if ((requestedDate && day > requestedDate) || (!requestedDate && day > todayUtc())) {
      throw new PublicRateSourceError('公开汇率服务返回了晚于当前日期的牌价');
    }
    byCurrency.set(cur, { date: day, rate_to_cny: roundedInverse });
  }
  if (byCurrency.size !== currencies.length || currencies.some((cur) => !byCurrency.has(cur))) {
    throw new PublicRateSourceError('公开汇率服务未返回全部请求币种');
  }
  const dates = new Set([...byCurrency.values()].map((r) => r.date));
  if (dates.size !== 1) throw new PublicRateSourceError('公开汇率服务返回的牌价日期不一致');

  const date = [...dates][0] as string;
  const rows = tx(() => currencies.map((currency) => {
    const rate = (byCurrency.get(currency) as { rate_to_cny: number }).rate_to_cny;
    const prev = get<{ rate_to_cny: number | string }>(
      `SELECT rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? ORDER BY rate_date DESC, id DESC LIMIT 1`, currency,
    );
    const r = upsertRate({ rate_date: date, currency, rate_to_cny: rate, source: RATE_SOURCE.FRANKFURTER });
    return { currency, rate_to_cny: rate, prev_rate: prev ? Number(prev.rate_to_cny) : null, created: r.created, skipped: r.skipped };
  }));
  return { date, source: 'Frankfurter v2 public API', rows };
}
