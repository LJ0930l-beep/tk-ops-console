/**
 * 利润引擎 —— 全系统唯一利润口径来源（方案 6.2「订单到利润」+ 设计要点 1 / 要点 3）
 *
 * 口径定义（要改口径只改这个文件，路由与别的 SQL 里不允许另起一套）：
 *  1. 预估口径：明细实收 item_amount（店铺币种）× 报表自然日汇率 − cost_snapshot（本身已是人民币）
 *     − est_commission（店铺币种折人民币）。预估毛利逐行调 shared/estItemProfitCny()，与前端同一算法。
 *  2. 实际口径：settlement_txn 才是平台真正打的钱。同一订单全部流水类型求和（订单收入 − 平台佣金 − 达人佣金
 *     − 运费 + 补贴 + 退款 + 调整）× 结算日汇率 = 结算实收。有结算流水的订单走结算口径，没有的走预估口径
 *     并标 is_estimated=1；两套并存互不覆盖，可逐单对账（reconcileByOrder）。
 *  3. 成本只读 tk_order_item.cost_snapshot，绝不回查 product_sku 当前成本（改成本价不改历史利润）。
 *  4. cost_matched=0（未映射 SKU）的订单行不进利润统计（连 GMV 一起剔），只出 warn 计数 ——
 *     按 0 成本混进来会让利润虚高（要点 1）。
 *  5. 达人免费样品单 is_sample_order=1 不计 GMV；取消单 CANCELLED 不计 GMV 也不计成本。
 *  6. 切日：order_time 存 UTC，报表按**店铺已保存的 IANA 时区**归自然日（shared statDateInZone，含夏令时）；
 *     时区不可用时才退回 REGION_TZ_OFFSET 固定偏移。
 *  7. 分摊：广告费有 video_id/spu_id 的直接归到视频/商品（顺带到达人），归不到的按该店铺当日 GMV 占比摊；
 *     费用 shop_id 有值的进该店，shop_id 为空 = 公共费用按各店 GMV 占比摊。池子 100% 摊完不吞不增，
 *     所以「各维度利润之和 = 全局利润」（只剩四舍五入的分级误差）。
 *  8. 退款冲减跟随原订单的统计日与维度（只有 COMPLETED 冲减），保证逐单可对账。
 *  9. 报表所有金额一律人民币，ProfitRow.currency 恒为 'CNY'。
 */
import {
  CONTENT_TYPE,
  REGION_TZ_OFFSET,
  adRoi,
  estItemProfitCny,
  num,
  profitRate,
  round2,
  statDateInZone,
  type CurrentUser,
  type DashboardSummary,
  type ProfitRow,
} from '@tk/shared';
import { all, get } from '../core/db.js';
import { hasMenu, personScope, shopScope } from '../core/auth.js';
import { notFound } from '../core/http.js';
import { maskError } from '../core/redact.js';
import { config } from '../config.js';
import { createRateConverter, rateDay, todayUtc } from './rates.js';

/* ==================== 常量 ==================== */

/** 报表维度；day / content / all 供趋势图与看板复用 */
export const PROFIT_DIMS = ['shop', 'sku', 'creator', 'month', 'day', 'content', 'all'] as const;
export type ProfitDim = (typeof PROFIT_DIMS)[number];
/** 利润报表页可切换的 4 个维度（方案 6.2 第 6 条） */
export const REPORT_DIMS = ['shop', 'sku', 'creator', 'month'] as const;
export const TREND_DIMS = ['day', 'shop', 'creator', 'sku', 'month'] as const;

export const CONTENT_TYPE_LABEL: Record<number, string> = {
  [CONTENT_TYPE.CREATOR_VIDEO]: '达人视频',
  [CONTENT_TYPE.CREATOR_LIVE]: '达人直播',
  [CONTENT_TYPE.OWN_VIDEO]: '自营视频',
  [CONTENT_TYPE.OWN_LIVE]: '自营直播',
  [CONTENT_TYPE.PRODUCT_CARD]: '商品卡',
};

export const SETTLE_TXN_LABEL: Record<number, string> = {
  1: '订单收入',
  2: '退款',
  3: '平台佣金',
  4: '达人佣金',
  5: '运费',
  6: '平台补贴',
  7: '调整',
  8: '其他',
};

export const EXPENSE_TYPE_LABEL: Record<number, string> = {
  1: '达人坑位费',
  2: '头程物流',
  3: '海外仓费',
  4: '工具订阅',
  5: '服务费',
  6: '其他',
};

export const AD_TYPE_LABEL: Record<number, string> = {
  1: 'GMV Max（商品）',
  2: 'GMV Max（直播）',
  3: '视频投流',
  4: '达人授权投放',
};

/**
 * 报表自然日：order_time 存 UTC，按**店铺已保存的 IANA 时区**归日（含夏令时）。
 * timezone 缺失或非法（脏数据/老库只填了 region）时退回站点固定偏移。
 */
export const siteDay = (
  utc: string | number | null | undefined,
  timezone: string | number | null | undefined,
  region?: string | number | null,
): string => statDateInZone(String(utc ?? ''), String(timezone ?? ''), REGION_TZ_OFFSET[String(region ?? '')] ?? 0);

const addDays = (day: string, n: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + n * 86400_000).toISOString().slice(0, 10);
};

export interface ProfitFilter {
  dim?: ProfitDim;
  /** 报表自然日（含），YYYY-MM-DD */
  start?: string;
  /** 报表自然日（含），YYYY-MM-DD */
  end?: string;
  /** 追加店铺过滤，与登录人数据范围取交集 */
  shopIds?: number[];
  /** 传了登录人就按 shopScope 收敛（工作台 / 利润报表必传） */
  user?: CurrentUser;
  /** 默认 false：样品单不计 GMV */
  includeSample?: boolean;
  /** 只看已结算订单（还没结算的不参与） */
  onlySettled?: boolean;
}

function scopeSql(user?: CurrentUser, shopIds?: number[], col = 'o.shop_id'): { sql: string; params: number[] } {
  let sql = '';
  let params: number[] = [];
  if (user) {
    const s = shopScope(user, col);
    sql += ` ${s.sql}`;
    params.push(...s.params);
  }
  const list = (shopIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (list.length) {
    sql += ` AND ${col} IN (${list.map(() => '?').join(',')})`;
    params.push(...list);
  }
  return { sql, params };
}

/**
 * 区间归一：默认最近 30 天（含端点）。
 * 若区间内可见订单为 0（刚接入的店铺 / 历史演示库），把窗口整体平移到最新一单所在日，
 * 避免工作台整屏 0；响应带 anchored + range 说明用了哪段区间。
 */
export function resolveRange(f: ProfitFilter): { start: string; end: string; anchored: boolean } {
  const end = rateDay(f.end) || todayUtc();
  const start = rateDay(f.start) || addDays(end, -29);
  const norm = start <= end ? { start, end } : { start: end, end: start };
  if (f.start || f.end) return { ...norm, anchored: false };
  const scope = scopeSql(f.user, f.shopIds);
  const latest = get<{ order_time: string | null; region: string | null; timezone: string | null }>(
    `SELECT o.order_time AS order_time, s.region AS region, s.timezone AS timezone
       FROM tk_order o JOIN tk_shop s ON s.id = o.shop_id
      WHERE o.is_deleted = 0 AND o.order_time IS NOT NULL ${scope.sql}
      ORDER BY o.order_time DESC LIMIT 1`,
    ...scope.params,
  );
  if (!latest?.order_time) return { ...norm, anchored: false };
  const lastDay = siteDay(latest.order_time, latest.timezone, latest.region);
  if (!lastDay || lastDay >= norm.end) return { ...norm, anchored: false };
  return { start: addDays(lastDay, -29), end: lastDay, anchored: true };
}

/* ==================== 事实层 ==================== */

interface ItemFact {
  item_id: number;
  sku_id: number | null;
  spu_id: number | null;
  sku_label: string;
  spu_name: string;
  creator_id: number | null;
  content_type: number | null;
  quantity: number;
  amount_src: number;
  amount_cny: number;
  cost_cny: number;
  commission_src: number;
  commission_cny: number;
  gross_cny: number;
  matched: boolean;
}

export type ExcludeReason = '' | 'cancelled' | 'sample' | 'unmapped' | 'unsettled';

interface OrderFact {
  order_id: number;
  tk_order_id: string;
  shop_id: number;
  shop_name: string;
  currency: string;
  region: string;
  day: string;
  order_time: string;
  order_status: string;
  is_sample: boolean;
  excluded: ExcludeReason;
  total_paid_src: number;
  total_paid_cny: number;
  items: ItemFact[];
  /** 参与统计的明细（cost_matched=1）合计，人民币 */
  gmv_src: number;
  gmv_cny: number;
  cost_cny: number;
  commission_src: number;
  commission_cny: number;
  gross_cny: number;
  refund_src: number;
  refund_cny: number;
  net_gmv_cny: number;
  unmapped_items: number;
  unmapped_src: number;
  unmapped_cny: number;
  has_settlement: boolean;
  settled_src: number;
  settled_cny: number;
  settled_paid_cny: number;
  settled_pending_cny: number;
  settled_commission_cny: number;
  settle_by_type: Record<number, number>;
  settle_src_by_type: Record<number, number>;
  statements: string[];
  payment_status: number;
  rate: number;
  rate_source_date: string;
  rate_missing: boolean;
}

export interface ProfitWarn {
  /** 未映射订单行：方案要点 1 —— 不进利润，只报数 */
  unmapped_items: number;
  unmapped_amount_src: number;
  unmapped_amount_cny: number;
  unmapped_orders: number;
  sample_orders: number;
  sample_amount_cny: number;
  cancelled_orders: number;
  unsettled_orders: number;
  rate_missing: boolean;
  rate_missing_currencies: string[];
}

export interface ProfitFacts {
  /** 参与利润统计的订单 */
  orders: OrderFact[];
  /** 被剔除的订单（样品 / 取消 / 只有未映射行 / 未结算），供对账页说明 */
  excluded: OrderFact[];
  range: { start: string; end: string; anchored: boolean };
  warn: ProfitWarn;
}

const newOrderFact = (
  r: Record<string, number | string | null>,
  day: string,
): OrderFact => ({
  order_id: Number(r.order_id),
  tk_order_id: String(r.tk_order_id),
  shop_id: Number(r.shop_id),
  shop_name: String(r.shop_name),
  currency: String(r.currency),
  region: String(r.region),
  day,
  order_time: String(r.order_time),
  order_status: String(r.order_status),
  is_sample: Number(r.is_sample_order) === 1,
  excluded: '',
  total_paid_src: num(r.total_paid),
  total_paid_cny: 0,
  items: [],
  gmv_src: 0,
  gmv_cny: 0,
  cost_cny: 0,
  commission_src: 0,
  commission_cny: 0,
  gross_cny: 0,
  refund_src: 0,
  refund_cny: 0,
  net_gmv_cny: 0,
  unmapped_items: 0,
  unmapped_src: 0,
  unmapped_cny: 0,
  has_settlement: false,
  settled_src: 0,
  settled_cny: 0,
  settled_paid_cny: 0,
  settled_pending_cny: 0,
  settled_commission_cny: 0,
  settle_by_type: {},
  settle_src_by_type: {},
  statements: [],
  payment_status: 0,
  rate: 1,
  rate_source_date: day,
  rate_missing: false,
});

/** 一次取数：站点时区切日 → 逐行折人民币 → 分类（参与统计 / 剔除） */
export function loadFacts(f: ProfitFilter = {}): ProfitFacts {
  const range = resolveRange(f);
  const scope = scopeSql(f.user, f.shopIds);
  const conv = createRateConverter();
  const map = new Map<number, OrderFact>();

  const rows = all<Record<string, number | string | null>>(
    `SELECT o.id AS order_id, o.tk_order_id, o.shop_id, s.shop_name, s.region, s.timezone, o.currency, o.order_status,
            o.is_sample_order, o.order_time, o.total_paid, o.shipping_fee,
            i.id AS item_id, i.sku_id, i.quantity, i.item_amount, i.cost_snapshot, i.cost_matched,
            i.creator_id, i.content_type, i.est_commission,
            sk.spu_id, sk.sku_code, sk.spec, sp.name_cn AS spu_name, sp.spu_code
       FROM tk_order o
       JOIN tk_shop s ON s.id = o.shop_id
       JOIN tk_order_item i ON i.order_id = o.id AND i.is_deleted = 0
       LEFT JOIN product_sku sk ON sk.id = i.sku_id
       LEFT JOIN product_spu sp ON sp.id = sk.spu_id
      WHERE o.is_deleted = 0 AND o.order_time IS NOT NULL
        AND substr(o.order_time, 1, 10) >= ? AND substr(o.order_time, 1, 10) <= ?
        ${scope.sql}
      ORDER BY o.id ASC, i.id ASC`,
    // 切日按站点时区，UTC 日期窗口两端各放宽 1 天，再在 JS 里按自然日精确归日
    addDays(range.start, -1),
    addDays(range.end, 1),
    ...scope.params,
  );

  for (const r of rows) {
    const orderId = Number(r.order_id);
    let o = map.get(orderId);
    if (!o) {
      const day = siteDay(r.order_time, r.timezone, r.region);
      if (!day || day < range.start || day > range.end) continue;
      o = newOrderFact(r, day);
      map.set(orderId, o);
    }
    const info = conv.rate(o.currency, o.day);
    o.rate = info.rate;
    o.rate_source_date = info.source_date;
    o.total_paid_cny = round2(o.total_paid_src * info.rate);
    if (info.missing) o.rate_missing = true;

    const matched = Number(r.cost_matched) === 1;
    const amountSrc = num(r.item_amount);
    const costSrc = num(r.cost_snapshot);
    const commissionSrc = num(r.est_commission);
    const item: ItemFact = {
      item_id: Number(r.item_id),
      sku_id: r.sku_id === null || r.sku_id === undefined ? null : Number(r.sku_id),
      spu_id: r.spu_id === null || r.spu_id === undefined ? null : Number(r.spu_id),
      sku_label: `${String(r.sku_code ?? '')}${r.spec ? ` ${String(r.spec)}` : ''}`.trim(),
      spu_name: String(r.spu_name ?? r.spu_code ?? ''),
      creator_id: r.creator_id === null || r.creator_id === undefined ? null : Number(r.creator_id),
      content_type: r.content_type === null || r.content_type === undefined ? null : Number(r.content_type),
      quantity: num(r.quantity),
      amount_src: amountSrc,
      amount_cny: round2(amountSrc * info.rate),
      cost_cny: round2(costSrc),
      commission_src: commissionSrc,
      commission_cny: round2(commissionSrc * info.rate),
      gross_cny: 0,
      matched,
    };
    // 预估毛利只调 shared 的那一个函数（前后端同一算法）
    item.gross_cny = matched
      ? estItemProfitCny({
          item_amount: amountSrc,
          currency: o.currency,
          cost_snapshot: costSrc,
          est_commission: commissionSrc,
          commission_currency: o.currency,
          rate_to_cny: info.rate,
        })
      : 0;
    o.items.push(item);
    if (!matched) {
      o.unmapped_items += 1;
      o.unmapped_src = round2(o.unmapped_src + amountSrc);
      o.unmapped_cny = round2(o.unmapped_cny + item.amount_cny);
      continue;
    }
    o.gmv_src = round2(o.gmv_src + amountSrc);
    o.gmv_cny = round2(o.gmv_cny + item.amount_cny);
    o.cost_cny = round2(o.cost_cny + item.cost_cny);
    o.commission_src = round2(o.commission_src + commissionSrc);
    o.commission_cny = round2(o.commission_cny + item.commission_cny);
    o.gross_cny = round2(o.gross_cny + item.gross_cny);
  }

  attachRefunds(map, range.start, scope);
  attachSettlements(map, scope);
  for (const o of map.values()) {
    if (o.excluded) continue;
    if (o.order_status === 'CANCELLED') o.excluded = 'cancelled';
    else if (o.is_sample && !f.includeSample) o.excluded = 'sample';
    else if (!o.items.some((i) => i.matched)) o.excluded = 'unmapped';
    else if (f.onlySettled && !o.has_settlement) o.excluded = 'unsettled';
    o.net_gmv_cny = round2(o.gmv_cny - o.refund_cny);
  }

  const warn: ProfitWarn = {
    unmapped_items: 0,
    unmapped_amount_src: 0,
    unmapped_amount_cny: 0,
    unmapped_orders: 0,
    sample_orders: 0,
    sample_amount_cny: 0,
    cancelled_orders: 0,
    unsettled_orders: 0,
    rate_missing: false,
    rate_missing_currencies: [],
  };
  const orders: OrderFact[] = [];
  const excluded: OrderFact[] = [];
  for (const o of map.values()) {
    if (o.excluded) {
      excluded.push(o);
      if (o.excluded === 'sample') {
        warn.sample_orders += 1;
        warn.sample_amount_cny = round2(warn.sample_amount_cny + o.gmv_cny);
      }
      if (o.excluded === 'cancelled') warn.cancelled_orders += 1;
      if (o.excluded === 'unsettled') warn.unsettled_orders += 1;
    } else orders.push(o);
    if (o.unmapped_items) {
      warn.unmapped_items += o.unmapped_items;
      warn.unmapped_amount_src = round2(warn.unmapped_amount_src + o.unmapped_src);
      warn.unmapped_amount_cny = round2(warn.unmapped_amount_cny + o.unmapped_cny);
      warn.unmapped_orders += 1;
    }
    if (o.rate_missing) warn.rate_missing = true;
  }
  orders.sort((a, b) => (a.day === b.day ? a.order_id - b.order_id : a.day < b.day ? -1 : 1));
  excluded.sort((a, b) => (a.day === b.day ? a.order_id - b.order_id : a.day < b.day ? -1 : 1));
  warn.rate_missing_currencies = conv.missingCurrencies();
  warn.rate_missing = warn.rate_missing_currencies.length > 0;
  return { orders, excluded, range, warn };
}

/** 已完成退款按原订单归属冲减（PROCESSING / 已拒绝不冲减） */
function attachRefunds(map: Map<number, OrderFact>, fallbackDay: string, scope: { sql: string; params: number[] }): void {
  if (!map.size) return;
  const conv = createRateConverter();
  const rows = all<Record<string, number | string | null>>(
    `SELECT r.order_id AS order_id, r.refund_amount, r.currency, r.apply_time, s.region, s.timezone
       FROM tk_return r
       JOIN tk_order o ON o.id = r.order_id AND o.is_deleted = 0
       JOIN tk_shop s ON s.id = r.shop_id
      WHERE r.is_deleted = 0 AND r.status = 'COMPLETED' AND r.order_id IS NOT NULL ${scope.sql}`,
    ...scope.params,
  );
  for (const r of rows) {
    const o = map.get(Number(r.order_id));
    if (!o) continue;
    const cur = String(r.currency);
    const day = siteDay(r.apply_time, r.timezone, r.region) || fallbackDay;
    o.refund_src = round2(o.refund_src + num(r.refund_amount));
    o.refund_cny = round2(o.refund_cny + num(r.refund_amount) * conv.rate(cur, day).rate);
  }
}

/** 结算流水按平台单号挂回订单：全类型求和 = 这一单实际到账；payment_status=1 才是真打进来的钱 */
function attachSettlements(map: Map<number, OrderFact>, scope: { sql: string; params: number[] }): void {
  if (!map.size) return;
  const conv = createRateConverter();
  const rows = all<Record<string, number | string | null>>(
    `SELECT o.id AS order_id, t.txn_type, t.amount, t.currency, t.payment_status, t.statement_time, t.statement_id, s.region, s.timezone
       FROM settlement_txn t
       JOIN tk_order o ON o.tk_order_id = t.tk_order_id AND o.is_deleted = 0
       JOIN tk_shop s ON s.id = t.shop_id
      WHERE t.is_deleted = 0 AND t.tk_order_id IS NOT NULL ${scope.sql}`,
    ...scope.params,
  );
  for (const r of rows) {
    const o = map.get(Number(r.order_id));
    if (!o) continue;
    const day = siteDay(r.statement_time, r.timezone, r.region) || o.day;
    const info = conv.rate(String(r.currency), day);
    const amount = num(r.amount);
    const cny = round2(amount * info.rate);
    const type = Number(r.txn_type);
    o.has_settlement = true;
    o.settled_src = round2(o.settled_src + amount);
    o.settled_cny = round2(o.settled_cny + cny);
    o.settle_by_type[type] = round2((o.settle_by_type[type] ?? 0) + cny);
    o.settle_src_by_type[type] = round2((o.settle_src_by_type[type] ?? 0) + amount);
    if (type === 4) o.settled_commission_cny = round2(o.settled_commission_cny - cny);
    if (Number(r.payment_status) === 1) {
      o.settled_paid_cny = round2(o.settled_paid_cny + cny);
      o.payment_status = 1;
    } else {
      o.settled_pending_cny = round2(o.settled_pending_cny + cny);
      if (o.payment_status !== 1) o.payment_status = Number(r.payment_status) || 2;
    }
    if (r.statement_id && !o.statements.includes(String(r.statement_id))) o.statements.push(String(r.statement_id));
    if (info.missing) o.rate_missing = true;
  }
}

/* ==================== 维度归集 + 分摊 ==================== */

interface Side {
  gmv: number;
  refund: number;
  cost: number;
  commission: number;
  gross: number;
  income: number;
  paid: number;
  pending: number;
  orders: Set<string>;
}

interface Cell {
  key: string;
  name: string;
  shopIds: Set<number>;
  dates: Set<string>;
  spuIds: Set<number>;
  est: Side;
  set: Side;
  ad: number;
  adGmv: number;
  expense: number;
  unmappedItems: number;
  unmappedAmount: number;
  sampleOrders: number;
  rateMissing: boolean;
}

const side = (): Side => ({ gmv: 0, refund: 0, cost: 0, commission: 0, gross: 0, income: 0, paid: 0, pending: 0, orders: new Set<string>() });

const newCell = (key: string, name: string): Cell => ({
  key,
  name,
  shopIds: new Set<number>(),
  dates: new Set<string>(),
  spuIds: new Set<number>(),
  est: side(),
  set: side(),
  ad: 0,
  adGmv: 0,
  expense: 0,
  unmappedItems: 0,
  unmappedAmount: 0,
  sampleOrders: 0,
  rateMissing: false,
});

const NO_CREATOR_KEY = 'C0';

interface NameBook {
  creator: (id: number) => string;
  sku: (code: string, spu: string) => string;
}

function makeNameBook(): NameBook {
  const creators = new Map<number, string>(
    all<{ id: number; handle: string; nickname: string | null }>(`SELECT id, handle, nickname FROM creator WHERE is_deleted = 0`).map((r) => [
      r.id,
      `@${r.handle}${r.nickname ? ` (${r.nickname})` : ''}`,
    ]),
  );
  return {
    creator: (id) => creators.get(id) ?? `达人#${id}`,
    sku: (code, spu) => (code ? `${spu ? `${spu} / ` : ''}${code}` : spu || '未命名 SKU'),
  };
}

/** 明细 → 维度键。每个维度都覆盖全部参与统计的明细，所以「各维度利润之和 = 全局利润」 */
function keyOf(dim: ProfitDim, o: OrderFact, i: ItemFact, names: NameBook): { key: string; name: string } {
  switch (dim) {
    case 'shop':
      return { key: `S${o.shop_id}`, name: o.shop_name };
    case 'sku':
      return { key: `K${i.sku_id ?? 0}`, name: i.sku_id === null ? '未映射 SKU' : names.sku(i.sku_label, i.spu_name) };
    case 'creator':
      return i.creator_id === null ? { key: NO_CREATOR_KEY, name: '自然流量 / 未归因' } : { key: `C${i.creator_id}`, name: names.creator(i.creator_id) };
    case 'content':
      return { key: `T${i.content_type ?? 0}`, name: CONTENT_TYPE_LABEL[i.content_type ?? 0] ?? '未标记' };
    case 'month':
      return { key: o.day.slice(0, 7), name: `${o.day.slice(0, 7)}` };
    case 'day':
      return { key: o.day, name: o.day };
    default:
      return { key: 'ALL', name: '全部合计' };
  }
}

function buildCells(dim: ProfitDim, facts: ProfitFacts, names: NameBook): Cell[] {
  const cells = new Map<string, Cell>();
  const cellOf = (key: string, name: string): Cell => {
    let c = cells.get(key);
    if (!c) {
      c = newCell(key, name);
      cells.set(key, c);
    }
    return c;
  };

  for (const o of facts.orders) {
    const settled = o.has_settlement;
    const weights = new Map<string, { cell: Cell; w: number }>();
    for (const i of o.items) {
      if (!i.matched) continue;
      const k = keyOf(dim, o, i, names);
      const c = cellOf(k.key, k.name);
      c.shopIds.add(o.shop_id);
      c.dates.add(o.day);
      if (i.spu_id !== null) c.spuIds.add(i.spu_id);
      c.rateMissing = c.rateMissing || o.rate_missing;
      const s = settled ? c.set : c.est;
      s.gmv += i.amount_cny;
      s.cost += i.cost_cny;
      s.gross += i.gross_cny;
      s.commission += settled ? 0 : i.commission_cny;
      s.orders.add(o.tk_order_id);
      const prev = weights.get(k.key);
      weights.set(k.key, { cell: c, w: (prev?.w ?? 0) + i.amount_cny });
    }
    if (!weights.size) continue;
    // 订单级金额（退款 / 结算实收 / 结算达人佣金）按明细实收占比摊回各维度键
    const total = [...weights.values()].reduce((a, b) => a + b.w, 0);
    const share = (w: number): number => (total > 0 ? w / total : 1 / weights.size);
    for (const [, { cell, w }] of weights) {
      const sh = share(w);
      const s = settled ? cell.set : cell.est;
      s.refund += o.refund_cny * sh;
      s.income += settled ? o.settled_cny * sh : 0;
      s.paid += settled ? o.settled_paid_cny * sh : 0;
      s.pending += settled ? o.settled_pending_cny * sh : 0;
      s.commission += settled ? o.settled_commission_cny * sh : 0;
    }
  }
  return [...cells.values()];
}

/* ---------- 分摊池：广告费 + 其他费用 ---------- */

interface Pool {
  amount: number;
  shopId: number | null;
  date: string | null;
  creatorId: number | null;
  spuId: number | null;
}

/** 广告费/广告 GMV 池：ad_daily 本身即站点自然日，按 stat_date 汇率折 CNY */
function loadAdPool(f: ProfitFilter, range: { start: string; end: string }, kind: 'spend' | 'gmv'): Pool[] {
  const scope = scopeSql(f.user, f.shopIds, 'a.shop_id');
  const conv = createRateConverter();
  const rows = all<Record<string, number | string | null>>(
    `SELECT a.stat_date, a.shop_id, a.spu_id, a.video_id, a.spend, a.gmv, a.currency,
            v.spu_id AS v_spu_id, v.creator_id AS v_creator_id
       FROM ad_daily a
       LEFT JOIN video v ON v.id = a.video_id AND v.is_deleted = 0
      WHERE a.is_deleted = 0 AND a.stat_date >= ? AND a.stat_date <= ? ${scope.sql}`,
    range.start,
    range.end,
    ...scope.params,
  );
  return rows.map((r) => {
    const date = rateDay(r.stat_date);
    const rate = conv.rate(String(r.currency), date).rate;
    const spu = r.spu_id === null || r.spu_id === undefined ? null : Number(r.spu_id);
    const vspu = r.v_spu_id === null || r.v_spu_id === undefined ? null : Number(r.v_spu_id);
    return {
      amount: round2(num(kind === 'spend' ? r.spend : r.gmv) * rate),
      shopId: Number(r.shop_id),
      date,
      spuId: spu ?? vspu,
      creatorId: r.v_creator_id === null || r.v_creator_id === undefined ? null : Number(r.v_creator_id),
    };
  });
}

/** 费用池：amount_cny 已是人民币（登记时按汇率写入），shop_id 为空 = 公共费用 */
function loadExpensePool(f: ProfitFilter, range: { start: string; end: string }): Pool[] {
  const conv = createRateConverter();
  const shopIds = (f.shopIds ?? []).map(Number).filter((n) => n > 0);
  const tail = shopIds.length ? `AND (e.shop_id IS NULL OR e.shop_id IN (${shopIds.map(() => '?').join(',')}))` : '';
  const rows = all<Record<string, number | string | null>>(
    `SELECT e.expense_date, e.shop_id, e.amount, e.amount_cny, e.currency, e.ref_type, e.ref_id,
            c.creator_id AS collab_creator_id, c.spu_id AS collab_spu_id
       FROM expense e
       LEFT JOIN collaboration c ON e.ref_type = 'collaboration' AND c.id = e.ref_id AND c.is_deleted = 0
      WHERE e.is_deleted = 0 AND e.expense_date >= ? AND e.expense_date <= ? ${tail}`,
    range.start,
    range.end,
    ...shopIds,
  );
  return rows.map((r) => {
    const date = rateDay(r.expense_date);
    const stored = num(r.amount_cny);
    return {
      amount: stored > 0 ? round2(stored) : round2(num(r.amount) * conv.rate(String(r.currency), date).rate),
      shopId: r.shop_id === null || r.shop_id === undefined ? null : Number(r.shop_id),
      date,
      // 坑位费直接落到该达人（ref_type=collaboration），不做二次分摊
      creatorId: r.collab_creator_id === null || r.collab_creator_id === undefined ? null : Number(r.collab_creator_id),
      spuId: r.collab_spu_id === null || r.collab_spu_id === undefined ? null : Number(r.collab_spu_id),
    };
  });
}

const cellWeight = (c: Cell): number => c.est.gmv + c.set.gmv - c.est.refund - c.set.refund;

/** 直接归属命中：先按维度键，再按同店铺、同一天，最后全量按 GMV 占比 —— 池子必须摊完 */
function level1(dim: ProfitDim, c: Cell, p: Pool): boolean {
  switch (dim) {
    case 'all':
      return true;
    case 'shop':
      return p.shopId !== null && c.key === `S${p.shopId}`;
    case 'sku':
      return p.spuId !== null && c.spuIds.has(p.spuId);
    case 'creator':
      return p.creatorId !== null && c.key === `C${p.creatorId}`;
    case 'content':
      return false;
    case 'month':
      return !!p.date && c.key === p.date.slice(0, 7);
    case 'day':
      return !!p.date && c.key === p.date;
    default:
      return false;
  }
}

function spread(cells: Cell[], pools: Pool[], field: 'ad' | 'adGmv' | 'expense', dim: ProfitDim): void {
  if (!cells.length) return;
  for (const p of pools) {
    if (!p.amount) continue;
    const l1 = cells.filter((c) => level1(dim, c, p));
    const l2 = p.shopId === null ? [] : cells.filter((c) => c.shopIds.has(p.shopId as number));
    const l3 = !p.date ? [] : cells.filter((c) => c.dates.has(p.date as string));
    const targets = l1.length ? l1 : l2.length ? l2 : l3.length ? l3 : cells;
    const totalW = targets.reduce((a, c) => a + Math.max(0, cellWeight(c)), 0);
    for (const c of targets) {
      const sh = totalW > 0 ? Math.max(0, cellWeight(c)) / totalW : 1 / targets.length;
      c[field] += p.amount * sh;
    }
  }
}

/* ==================== 输出：ProfitRow ==================== */

export interface ProfitCellRow extends ProfitRow {
  /** 结算实收中「已打款」部分（工作台用） */
  settled_paid: number;
  /** 结算实收中「处理中/失败」= 待打款 */
  settled_pending: number;
  /** 广告归因 GMV（分摊后），与 ad_spend 同口径 */
  ad_gmv: number;
  /** 预估毛利 = Σ estItemProfitCny()，与结算口径无关，只做过程参考 */
  gross_profit: number;
  /** 分摊后毛利（预估口径，不减费用） */
  gross_after_ad: number;
  settled_orders: number;
  estimated_orders: number;
  /** 该维度内被剔除的未映射行数与金额（要点 1） */
  unmapped_items: number;
  unmapped_amount_cny: number;
  rate_missing: boolean;
  ad_roi: number | null;
  shop_ids: number[];
  dates: string[];
}

function rowOf(c: Cell): ProfitCellRow {
  const gmv = c.est.gmv + c.set.gmv;
  const refund = c.est.refund + c.set.refund;
  const net_gmv = gmv - refund;
  const cost = c.est.cost + c.set.cost;
  const commission = c.est.commission + c.set.commission;
  const settled = c.set.income;
  const profit = c.est.gmv - c.est.refund - c.est.commission + settled - cost - c.ad - c.expense;
  const orders = c.est.orders.size + c.set.orders.size;
  return {
    dim_key: c.key,
    dim_name: c.name,
    currency: 'CNY',
    gmv: round2(gmv),
    refund: round2(refund),
    net_gmv: round2(net_gmv),
    cost: round2(cost),
    commission: round2(commission),
    ad_spend: round2(c.ad),
    expense: round2(c.expense),
    settled_amount: round2(settled),
    profit: round2(profit),
    profit_rate: profitRate(profit, net_gmv),
    is_estimated: c.est.orders.size > 0 ? 1 : 0,
    orders,
    settled_paid: round2(c.set.paid),
    settled_pending: round2(c.set.pending),
    ad_gmv: round2(c.adGmv),
    gross_profit: round2(c.est.gross + c.set.gross),
    gross_after_ad: round2(net_gmv - cost - commission - c.ad),
    settled_orders: c.set.orders.size,
    estimated_orders: c.est.orders.size,
    unmapped_items: c.unmappedItems,
    unmapped_amount_cny: round2(c.unmappedAmount),
    rate_missing: c.rateMissing,
    ad_roi: adRoi(c.ad, c.adGmv),
    shop_ids: [...c.shopIds].sort((a, b) => a - b),
    dates: [...c.dates].sort(),
  };
}

function sumCells(cells: Cell[]): Cell {
  const acc = newCell('ALL', '全部合计');
  for (const c of cells) {
    for (const s of ['est', 'set'] as const) {
      acc[s].gmv += c[s].gmv;
      acc[s].refund += c[s].refund;
      acc[s].cost += c[s].cost;
      acc[s].commission += c[s].commission;
      acc[s].gross += c[s].gross;
      acc[s].income += c[s].income;
      acc[s].paid += c[s].paid;
      acc[s].pending += c[s].pending;
      for (const k of c[s].orders) acc[s].orders.add(k);
    }
    for (const x of c.shopIds) acc.shopIds.add(x);
    for (const x of c.dates) acc.dates.add(x);
    for (const x of c.spuIds) acc.spuIds.add(x);
    acc.ad += c.ad;
    acc.adGmv += c.adGmv;
    acc.expense += c.expense;
    acc.unmappedItems += c.unmappedItems;
    acc.unmappedAmount += c.unmappedAmount;
    acc.sampleOrders += c.sampleOrders;
    acc.rateMissing = acc.rateMissing || c.rateMissing;
  }
  return acc;
}

export interface ProfitReport {
  dim: ProfitDim;
  start: string;
  end: string;
  /** 区间被平移到有数据的最近 30 天 */
  anchored: boolean;
  list: ProfitCellRow[];
  total: ProfitCellRow;
  warn: ProfitWarn;
  rate_missing: boolean;
}

/** 利润报表主入口：行 + 合计行 + warn 计数。合计与各行同一次计算，保证 Σ行 = 合计 */
export function computeProfitReport(f: ProfitFilter & { dim?: ProfitDim }): ProfitReport {
  const dim: ProfitDim = f.dim ?? 'shop';
  const facts = loadFacts(f);
  const names = makeNameBook();
  const cells = buildCells(dim, facts, names);
  const range = { start: facts.range.start, end: facts.range.end };
  spread(cells, loadAdPool(f, range, 'spend'), 'ad', dim);
  spread(cells, loadAdPool(f, range, 'gmv'), 'adGmv', dim);
  spread(cells, loadExpensePool(f, range), 'expense', dim);
  // warn 里的未映射行按店铺落到对应维度行（dim=shop 时最直观）
  for (const o of [...facts.orders, ...facts.excluded]) {
    if (!o.unmapped_items) continue;
    const key = dim === 'shop' ? `S${o.shop_id}` : dim === 'all' ? 'ALL' : null;
    const c = key ? cells.find((x) => x.key === key) : undefined;
    if (c) {
      c.unmappedItems += o.unmapped_items;
      c.unmappedAmount += o.unmapped_cny;
    }
  }
  const list = cells.map(rowOf);
  list.sort(dim === 'month' || dim === 'day' ? (a, b) => (a.dim_key < b.dim_key ? -1 : a.dim_key > b.dim_key ? 1 : 0) : (a, b) => b.gmv - a.gmv || b.profit - a.profit);
  const total = rowOf(sumCells(cells));
  total.dim_name = dim === 'month' || dim === 'day' ? '合计' : '合计（全部维度）';
  total.unmapped_items = facts.warn.unmapped_items;
  total.unmapped_amount_cny = facts.warn.unmapped_amount_cny;
  return { dim, start: facts.range.start, end: facts.range.end, anchored: facts.range.anchored, list, total, warn: facts.warn, rate_missing: facts.warn.rate_missing };
}

/** 只要行（利润报表 / 看板共用） */
export function computeProfitByDimension(f: ProfitFilter & { dim: ProfitDim }): ProfitCellRow[] {
  return computeProfitReport(f).list;
}

/** 全局利润（唯一总数）：各维度行之和必须等于它 */
export function computeGlobalProfit(f: ProfitFilter = {}): ProfitCellRow {
  return computeProfitReport({ ...f, dim: 'all' }).total;
}

/* ==================== 单笔利润拆解 ==================== */

export interface OrderProfitBreakdown {
  order_id: number;
  tk_order_id: string;
  shop_id: number;
  shop_name: string;
  region: string;
  currency: string;
  order_time: string;
  stat_date: string;
  order_status: string;
  is_sample_order: number;
  excluded_reason: ExcludeReason;
  rate: number;
  rate_source_date: string;
  rate_missing: boolean;
  total_paid_src: number;
  total_paid_cny: number;
  /** 明细实收（不含买家运费），未映射行不计 */
  item_amount_src: number;
  income_cny: number;
  refund_src: number;
  refund_cny: number;
  net_gmv_cny: number;
  cost_cny: number;
  commission_src: number;
  commission_cny: number;
  gross_profit_cny: number;
  ad_spend_cny: number;
  expense_cny: number;
  has_settlement: boolean;
  settled_src: number;
  settled_amount_cny: number;
  settled_paid_cny: number;
  settled_commission_cny: number;
  settle_by_type: { txn_type: number; txn_name: string; amount_src: number; amount_cny: number }[];
  profit_cny: number;
  profit_rate: number;
  is_estimated: 0 | 1;
  unmapped_items: number;
  unmapped_amount_src: number;
  items: {
    item_id: number;
    sku_id: number | null;
    sku_label: string;
    spu_name: string;
    creator_id: number | null;
    content_type: number | null;
    content_name: string;
    quantity: number;
    item_amount_src: number;
    item_amount_cny: number;
    cost_cny: number;
    commission_src: number;
    commission_cny: number;
    gross_profit_cny: number;
    cost_matched: 0 | 1;
    counted: 0 | 1;
  }[];
}

/**
 * 单笔拆解（订单详情页 / 结算对账点进去看）。
 * 分摊广告与费用：该店铺该站点日的广告费与费用，按这一单占当日净 GMV 的比例承担。
 */
export function computeOrderProfit(orderId: number): OrderProfitBreakdown {
  const head = get<Record<string, number | string | null>>(
    `SELECT o.id AS order_id, o.order_time, o.shop_id, s.region, s.timezone FROM tk_order o JOIN tk_shop s ON s.id = o.shop_id WHERE o.id = ? AND o.is_deleted = 0`,
    orderId,
  );
  if (!head) throw notFound(`订单 ${orderId} 不存在`);
  const day = siteDay(head.order_time, head.timezone, head.region);
  const facts = loadFacts({ start: day, end: day, shopIds: [Number(head.shop_id)], includeSample: true });
  const o = [...facts.orders, ...facts.excluded].find((x) => x.order_id === orderId);
  if (!o) throw notFound(`订单 ${orderId} 无明细行`);

  const sameDay = [...facts.orders, ...facts.excluded].filter((x) => x.day === day && x.shop_id === o.shop_id);
  const weightOf = (x: OrderFact): number => x.gmv_cny - x.refund_cny;
  const totalW = sameDay.reduce((a, b) => a + Math.max(0, weightOf(b)), 0);
  const myW = Math.max(0, weightOf(o));
  const share = totalW > 0 ? myW / totalW : sameDay.length ? 1 / sameDay.length : 0;

  const range = { start: day, end: day };
  const adPool = loadAdPool({ start: day, end: day, shopIds: [o.shop_id] }, range, 'spend');
  const expensePool = loadExpensePool({ start: day, end: day, shopIds: [o.shop_id] }, range);
  const mySpus = new Set(o.items.map((i) => i.spu_id).filter((x): x is number => x !== null));
  const charge = (pools: Pool[]): number => {
    let direct = 0;
    const rest: Pool[] = [];
    for (const p of pools) {
      if (p.shopId !== null && p.shopId !== o.shop_id) continue;
      if (p.spuId !== null && mySpus.has(p.spuId)) direct += p.amount;
      else if (p.creatorId !== null && o.items.some((i) => i.creator_id === p.creatorId)) direct += p.amount;
      else rest.push(p);
    }
    return round2(direct + rest.reduce((a, b) => a + b.amount, 0) * share);
  };
  const ad_spend_cny = charge(adPool);
  const expense_cny = charge(expensePool);

  const profit = o.has_settlement
    ? o.settled_cny - o.cost_cny - ad_spend_cny - expense_cny
    : o.net_gmv_cny - o.commission_cny - o.cost_cny - ad_spend_cny - expense_cny;

  return {
    order_id: o.order_id,
    tk_order_id: o.tk_order_id,
    shop_id: o.shop_id,
    shop_name: o.shop_name,
    region: o.region,
    currency: o.currency,
    order_time: o.order_time,
    stat_date: o.day,
    order_status: o.order_status,
    is_sample_order: o.is_sample ? 1 : 0,
    excluded_reason: o.excluded,
    rate: o.rate,
    rate_source_date: o.rate_source_date,
    rate_missing: o.rate_missing,
    total_paid_src: o.total_paid_src,
    total_paid_cny: o.total_paid_cny,
    item_amount_src: o.gmv_src,
    income_cny: o.gmv_cny,
    refund_src: o.refund_src,
    refund_cny: o.refund_cny,
    net_gmv_cny: o.net_gmv_cny,
    cost_cny: o.cost_cny,
    commission_src: o.commission_src,
    commission_cny: o.commission_cny,
    gross_profit_cny: o.gross_cny,
    ad_spend_cny,
    expense_cny,
    has_settlement: o.has_settlement,
    settled_src: o.settled_src,
    settled_amount_cny: o.settled_cny,
    settled_paid_cny: o.settled_paid_cny,
    settled_commission_cny: o.settled_commission_cny,
    settle_by_type: Object.entries(o.settle_by_type).map(([t, v]) => ({
      txn_type: Number(t),
      txn_name: SETTLE_TXN_LABEL[Number(t)] ?? `类型${t}`,
      amount_src: o.settle_src_by_type[Number(t)] ?? 0,
      amount_cny: v,
    })),
    profit_cny: round2(profit),
    profit_rate: profitRate(profit, o.net_gmv_cny),
    is_estimated: o.has_settlement ? 0 : 1,
    unmapped_items: o.unmapped_items,
    unmapped_amount_src: o.unmapped_src,
    items: o.items.map((i) => ({
      item_id: i.item_id,
      sku_id: i.sku_id,
      sku_label: i.sku_label,
      spu_name: i.spu_name,
      creator_id: i.creator_id,
      content_type: i.content_type,
      content_name: CONTENT_TYPE_LABEL[i.content_type ?? 0] ?? '未标记',
      quantity: i.quantity,
      item_amount_src: i.amount_src,
      item_amount_cny: i.amount_cny,
      cost_cny: i.cost_cny,
      commission_src: i.commission_src,
      commission_cny: i.commission_cny,
      gross_profit_cny: i.gross_cny,
      cost_matched: i.matched ? 1 : 0,
      counted: i.matched ? 1 : 0,
    })),
  };
}

/* ==================== 逐单对账（要点 3） ==================== */

export interface ReconcileRow {
  order_id: number;
  tk_order_id: string;
  shop_id: number;
  shop_name: string;
  currency: string;
  order_time: string;
  stat_date: string;
  order_status: string;
  is_sample_order: number;
  excluded_reason: ExcludeReason;
  statements: string[];
  payment_status: number;
  has_settlement: boolean;
  est_total_paid_src: number;
  est_total_paid_cny: number;
  est_income_cny: number;
  est_commission_src: number;
  est_commission_cny: number;
  cost_cny: number;
  refund_cny: number;
  settled_src: number;
  settled_cny: number;
  settled_paid_cny: number;
  settled_commission_cny: number;
  /** 结算流水里的「订单收入」原值（对账时和预估收入比基数） */
  settle_income_cny: number;
  diff_cny: number;
  diff_rate: number;
  commission_diff_cny: number;
  platform_fee_cny: number;
  shipping_fee_cny: number;
  subsidy_cny: number;
  settle_refund_cny: number;
  adjust_cny: number;
  /** 结算实收减去各拆解项后的残差：恒 ≈ 0，用来证明「差异可解释」没有被漏掉的口径 */
  explain_residual_cny: number;
  est_profit_cny: number;
  settled_profit_cny: number;
  unmapped_items: number;
  rate_missing: boolean;
}

export interface ReconcileResult {
  start: string;
  end: string;
  anchored: boolean;
  list: ReconcileRow[];
  summary: {
    orders: number;
    settled_orders: number;
    unsettled_orders: number;
    /** 全部订单的预估实收（含还没结算的） */
    est_total_paid_cny: number;
    /** 全部结算流水实收 */
    settled_cny: number;
    /** 已结算订单的预估实收 —— 与 settled_cny 同基数，差额才有解释意义 */
    settled_est_paid_cny: number;
    /** 已结算订单：Σ(结算实收 − 预估实收) */
    diff_cny: number;
    /** 还没结算、仍挂在预估口径上的金额（要点 3：两套并存） */
    unsettled_est_paid_cny: number;
    est_commission_cny: number;
    settled_commission_cny: number;
    commission_diff_cny: number;
    /** 差异拆解五项 + 收入基数差：五项之和 ≈ diff_cny */
    income_diff_cny: number;
    platform_fee_cny: number;
    shipping_fee_cny: number;
    subsidy_cny: number;
    settle_refund_cny: number;
    adjust_cny: number;
    /** 拆解残差，恒 ≈ 0（不为 0 说明有流水类型没进对账口径） */
    explain_residual_cny: number;
    paid_cny: number;
    pending_cny: number;
  };
}

/** 预估 vs 结算逐单对账：差异要能解释 = 平台佣金 + 运费扣 + 补贴 + 退款 + 调整 + 收入基数差 */
export function reconcileByOrder(f: ProfitFilter = {}): ReconcileResult {
  const facts = loadFacts({ ...f, includeSample: true });
  const allOrders = [...facts.orders, ...facts.excluded];
  const list: ReconcileRow[] = allOrders.map((o) => {
    const t = (type: number): number => o.settle_by_type[type] ?? 0;
    const diff = round2(o.settled_cny - o.total_paid_cny);
    const estProfit = round2(o.net_gmv_cny - o.commission_cny - o.cost_cny);
    const row: ReconcileRow = {
      order_id: o.order_id,
      tk_order_id: o.tk_order_id,
      shop_id: o.shop_id,
      shop_name: o.shop_name,
      currency: o.currency,
      order_time: o.order_time,
      stat_date: o.day,
      order_status: o.order_status,
      is_sample_order: o.is_sample ? 1 : 0,
      excluded_reason: o.excluded,
      statements: o.statements,
      payment_status: o.payment_status,
      has_settlement: o.has_settlement,
      est_total_paid_src: o.total_paid_src,
      est_total_paid_cny: o.total_paid_cny,
      est_income_cny: o.gmv_cny,
      est_commission_src: o.commission_src,
      est_commission_cny: o.commission_cny,
      cost_cny: o.cost_cny,
      refund_cny: o.refund_cny,
      settled_src: o.settled_src,
      settled_cny: o.settled_cny,
      settled_paid_cny: o.settled_paid_cny,
      settled_commission_cny: o.settled_commission_cny,
      settle_income_cny: round2(t(1)),
      diff_cny: diff,
      diff_rate: profitRate(diff, o.total_paid_cny),
      commission_diff_cny: round2(o.settled_commission_cny - o.commission_cny),
      platform_fee_cny: round2(-t(3)),
      shipping_fee_cny: round2(-t(5)),
      subsidy_cny: round2(t(6)),
      settle_refund_cny: round2(-t(2)),
      adjust_cny: round2(t(7) + t(8)),
      explain_residual_cny: 0,
      est_profit_cny: estProfit,
      settled_profit_cny: round2(o.settled_cny - o.cost_cny),
      unmapped_items: o.unmapped_items,
      rate_missing: o.rate_missing,
    };
    // 结算实收 = 订单收入 − 退款 − 平台佣金 − 达人佣金 − 运费 + 补贴 + 调整；残差只应是四舍五入
    const explained =
      row.settle_income_cny - row.settle_refund_cny - row.platform_fee_cny - row.settled_commission_cny - row.shipping_fee_cny + row.subsidy_cny + row.adjust_cny;
    row.explain_residual_cny = round2(row.settled_cny - explained);
    return row;
  });
  list.sort((a, b) => Math.abs(b.diff_cny) - Math.abs(a.diff_cny) || b.settled_cny - a.settled_cny);
  const sum = (fn: (r: ReconcileRow) => number): number => round2(list.reduce((a, r) => a + fn(r), 0));
  const settled = list.filter((r) => r.has_settlement);
  const sumOf = (rows: ReconcileRow[], fn: (r: ReconcileRow) => number): number => round2(rows.reduce((a, r) => a + fn(r), 0));
  return {
    start: facts.range.start,
    end: facts.range.end,
    anchored: facts.range.anchored,
    list,
    summary: {
      orders: list.length,
      settled_orders: settled.length,
      unsettled_orders: list.length - settled.length,
      est_total_paid_cny: sum((r) => r.est_total_paid_cny),
      settled_cny: sum((r) => r.settled_cny),
      settled_est_paid_cny: sumOf(settled, (r) => r.est_total_paid_cny),
      diff_cny: sumOf(settled, (r) => r.diff_cny),
      unsettled_est_paid_cny: sumOf(list.filter((r) => !r.has_settlement), (r) => r.est_total_paid_cny),
      est_commission_cny: sum((r) => r.est_commission_cny),
      settled_commission_cny: sum((r) => r.settled_commission_cny),
      commission_diff_cny: sum((r) => r.commission_diff_cny),
      income_diff_cny: sumOf(settled, (r) => round2(r.settle_income_cny - r.est_total_paid_cny)),
      platform_fee_cny: sum((r) => r.platform_fee_cny),
      shipping_fee_cny: sum((r) => r.shipping_fee_cny),
      subsidy_cny: sum((r) => r.subsidy_cny),
      settle_refund_cny: sum((r) => r.settle_refund_cny),
      adjust_cny: sum((r) => r.adjust_cny),
      explain_residual_cny: sumOf(settled, (r) => r.explain_residual_cny),
      paid_cny: sum((r) => r.settled_paid_cny),
      pending_cny: sum((r) => r.settled_cny - r.settled_paid_cny),
    },
  };
}

/* ==================== 投放指标（广告日报口径，工作台与投放中心共用） ==================== */

export const AD_GROUP_DIMS = ['campaign', 'shop', 'ad_type', 'spu', 'video', 'date', 'creator'] as const;
export type AdGroupDim = (typeof AD_GROUP_DIMS)[number];

export interface AdMetricsRow {
  group_key: string;
  group_name: string;
  shop_id: number | null;
  shop_name: string | null;
  campaign_id: string | null;
  ad_type: number | null;
  spu_id: number | null;
  video_id: number | null;
  date: string | null;
  currency: string;
  spend: number;
  gmv: number;
  impressions: number;
  clicks: number;
  conversions: number;
  roi: number | null;
  ctr: number;
  cvr: number;
  cpm: number;
  cpc: number;
  cost_per_order: number;
  days: number;
}

/**
 * 广告日报聚合：全部折人民币后再算派生指标（跨币种混算才有意义）。
 * ROI = adRoi(消耗, GMV)；CTR = 点击/展示；CVR = 成交/点击；CPM = 千次展示成本；CPC = 单次点击成本。
 */
export function adMetrics(f: ProfitFilter & { group_by?: AdGroupDim } = {}): { list: AdMetricsRow[]; total: AdMetricsRow; range: { start: string; end: string; anchored: boolean } } {
  const group = f.group_by ?? 'campaign';
  const range = resolveRange(f);
  const scope = scopeSql(f.user, f.shopIds, 'a.shop_id');
  const conv = createRateConverter();
  const rows = all<Record<string, number | string | null>>(
    `SELECT a.stat_date, a.shop_id, a.campaign_id, a.campaign_name, a.ad_type, a.spu_id, a.video_id, a.currency,
            a.spend, a.impressions, a.clicks, a.conversions, a.gmv,
            s.shop_name, sp.name_cn AS spu_name, sp.spu_code, v.creator_id, c.handle AS creator_handle
       FROM ad_daily a
       JOIN tk_shop s ON s.id = a.shop_id
       LEFT JOIN product_spu sp ON sp.id = a.spu_id
       LEFT JOIN video v ON v.id = a.video_id
       LEFT JOIN creator c ON c.id = v.creator_id
      WHERE a.is_deleted = 0 AND a.stat_date >= ? AND a.stat_date <= ? ${scope.sql}
      ORDER BY a.stat_date ASC, a.id ASC`,
    range.start,
    range.end,
    ...scope.params,
  );
  const map = new Map<string, AdMetricsRow & { dates: Set<string> }>();
  for (const r of rows) {
    const date = rateDay(r.stat_date);
    const rate = conv.rate(String(r.currency), date).rate;
    const shopId = Number(r.shop_id);
    const spuId = r.spu_id === null || r.spu_id === undefined ? null : Number(r.spu_id);
    const videoId = r.video_id === null || r.video_id === undefined ? null : Number(r.video_id);
    const creatorId = r.creator_id === null || r.creator_id === undefined ? null : Number(r.creator_id);
    let key: string;
    let name: string;
    switch (group) {
      case 'shop':
        key = `S${shopId}`;
        name = String(r.shop_name);
        break;
      case 'ad_type':
        key = `A${num(r.ad_type)}`;
        name = AD_TYPE_LABEL[num(r.ad_type)] ?? `类型${num(r.ad_type)}`;
        break;
      case 'spu':
        key = `P${spuId ?? 0}`;
        name = spuId === null ? '未关联商品' : String(r.spu_name ?? r.spu_code ?? `SPU#${spuId}`);
        break;
      case 'video':
        key = `V${videoId ?? 0}`;
        name = videoId === null ? '未关联视频' : `视频#${videoId}${r.creator_handle ? ` (@${String(r.creator_handle)})` : ''}`;
        break;
      case 'creator':
        key = `C${creatorId ?? 0}`;
        name = creatorId === null ? '未关联达人' : `@${String(r.creator_handle ?? creatorId)}`;
        break;
      case 'date':
        key = date;
        name = date;
        break;
      default:
        key = `${shopId}|${String(r.campaign_id ?? '')}|${num(r.ad_type)}`;
        name = String(r.campaign_name ?? r.campaign_id ?? '未命名计划');
    }
    let g = map.get(key);
    if (!g) {
      g = {
        group_key: key,
        group_name: name,
        shop_id: shopId,
        shop_name: String(r.shop_name),
        campaign_id: r.campaign_id === null || r.campaign_id === undefined ? null : String(r.campaign_id),
        ad_type: num(r.ad_type),
        spu_id: spuId,
        video_id: videoId,
        date: group === 'date' ? date : null,
        currency: 'CNY',
        spend: 0,
        gmv: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        roi: null,
        ctr: 0,
        cvr: 0,
        cpm: 0,
        cpc: 0,
        cost_per_order: 0,
        days: 0,
        dates: new Set<string>(),
      };
      map.set(key, g);
    }
    g.dates.add(date);
    g.spend += num(r.spend) * rate;
    g.gmv += num(r.gmv) * rate;
    g.impressions += num(r.impressions);
    g.clicks += num(r.clicks);
    g.conversions += num(r.conversions);
  }
  const finish = (g: AdMetricsRow & { dates?: Set<string> }): AdMetricsRow => {
    const { dates, ...rest } = g;
    const spend = round2(g.spend);
    const gmv = round2(g.gmv);
    return {
      ...rest,
      spend,
      gmv,
      roi: adRoi(spend, gmv),
      ctr: g.impressions > 0 ? round2((g.clicks / g.impressions) * 100) : 0,
      cvr: g.clicks > 0 ? round2((g.conversions / g.clicks) * 100) : 0,
      cpm: g.impressions > 0 ? round2((spend / g.impressions) * 1000) : 0,
      cpc: g.clicks > 0 ? round2(spend / g.clicks) : 0,
      cost_per_order: g.conversions > 0 ? round2(spend / g.conversions) : 0,
      days: g.dates ? g.dates.size : 0,
    };
  };
  const list = [...map.values()].map((g) => finish(g as AdMetricsRow & { dates: Set<string> })).sort((a, b) => b.spend - a.spend || b.gmv - a.gmv);
  const merged = [...map.values()].reduce<AdMetricsRow & { dates: Set<string> }>(
    (acc, g) => ({
      ...acc,
      spend: acc.spend + g.spend,
      gmv: acc.gmv + g.gmv,
      impressions: acc.impressions + g.impressions,
      clicks: acc.clicks + g.clicks,
      conversions: acc.conversions + g.conversions,
      group_name: '合计',
      dates: new Set<string>([...acc.dates, ...g.dates]),
    }),
    {
      group_key: 'ALL',
      group_name: '合计',
      shop_id: null,
      shop_name: null,
      campaign_id: null,
      ad_type: null,
      spu_id: null,
      video_id: null,
      date: null,
      currency: 'CNY',
      spend: 0,
      gmv: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      roi: null,
      ctr: 0,
      cvr: 0,
      cpm: 0,
      cpc: 0,
      cost_per_order: 0,
      days: 0,
      dates: new Set<string>(),
    },
  );
  return { list, total: finish(merged), range };
}

/* ==================== 工作台：待办 + 看板指标 ==================== */

/** 待办判定条件（口径只写一次，计数与明细共用） */
const TODO_WHERE = {
  unmapped_listing: `l.is_deleted = 0 AND l.map_status = 2`,
  unmapped_item: `i.is_deleted = 0 AND i.cost_matched = 0 AND o.is_deleted = 0`,
  creator_follow: `o.is_deleted = 0 AND o.next_follow_at IS NOT NULL AND date(o.next_follow_at) <= date('now')`,
  sample_overdue: `s.is_deleted = 0 AND s.status IN (3, 5) AND s.sign_time IS NOT NULL
                     AND date(s.sign_time, ?) <= date('now')`,
  auth_expiring: `is_deleted = 0 AND (auth_status IN (2, 3) OR (token_expire_at IS NOT NULL AND date(token_expire_at) <= date('now', '+7 days')))`,
  sync_failed: `sl.is_deleted = 0 AND sl.task_type <> 'import' AND sl.id IN (SELECT MAX(id) FROM sync_log WHERE is_deleted = 0 AND task_type <> 'import' GROUP BY shop_id, task_type) AND sl.status IN (2, 3)`,
  live_today: `lv.is_deleted = 0 AND lv.status = 1 AND substr(lv.plan_start, 1, 10) = date('now')`,
};

export interface TodoItem {
  id: string;
  title: string;
  subtitle: string;
  hint: string;
  link: string;
}

export interface TodoGroup {
  key: string;
  label: string;
  count: number;
  link: string;
  items: TodoItem[];
}

const countOf = (sql: string, ...p: (number | string)[]): number => Number(get<{ c: number | string }>(sql, ...p)?.c ?? 0);

/** 样品签收后未出内容的超期阈值，与达人中心共用 config.sampleContentDueDays */
const sampleDueDays = (): string => `+${Math.max(1, Number(config.sampleContentDueDays) || 7)} day`;

/** CRM 待办只对有达人权限的角色开放，并按达人负责人收敛到本人/本组。 */
function crmTodoScope(user: CurrentUser, ownerCol: string): { sql: string; params: number[] } {
  return hasMenu(user, 'creator') ? personScope(user, ownerCol, true) : { sql: ' AND 1 = 0', params: [] };
}

/** 待办计数：工作台红点与「我的待办」列表同一套条件 */
export function todoCounts(user: CurrentUser): Record<'unmapped_listings' | 'unmapped_items' | 'creators_to_follow' | 'samples_overdue' | 'auth_expiring' | 'sync_failed' | 'live_today', number> {
  const shop = shopScope(user, 'l.shop_id');
  const shopItem = shopScope(user, 'o.shop_id');
  const shopAuth = shopScope(user, 'id');
  const shopSync = shopScope(user, 'sl.shop_id');
  const shopLive = shopScope(user, 'lv.shop_id');
  const outreachScope = crmTodoScope(user, 'o.user_id');
  const sampleScope = crmTodoScope(user, 'c.owner_id');
  return {
    unmapped_listings: countOf(`SELECT COUNT(*) AS c FROM shop_listing l WHERE ${TODO_WHERE.unmapped_listing} ${shop.sql}`, ...shop.params),
    unmapped_items: countOf(
      `SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE ${TODO_WHERE.unmapped_item} ${shopItem.sql}`,
      ...shopItem.params,
    ),
    creators_to_follow: countOf(
      `SELECT COUNT(DISTINCT o.creator_id) AS c FROM creator_outreach o JOIN creator c ON c.id = o.creator_id AND c.is_deleted = 0
        WHERE ${TODO_WHERE.creator_follow} ${outreachScope.sql}`,
      ...outreachScope.params,
    ),
    samples_overdue: countOf(
      `SELECT COUNT(*) AS c FROM sample_shipment s JOIN creator c ON c.id = s.creator_id AND c.is_deleted = 0
        WHERE ${TODO_WHERE.sample_overdue} ${sampleScope.sql}`,
      sampleDueDays(),
      ...sampleScope.params,
    ),
    auth_expiring: countOf(`SELECT COUNT(*) AS c FROM tk_shop WHERE ${TODO_WHERE.auth_expiring} ${shopAuth.sql}`, ...shopAuth.params),
    sync_failed: countOf(`SELECT COUNT(*) AS c FROM sync_log sl WHERE ${TODO_WHERE.sync_failed} ${shopSync.sql}`, ...shopSync.params),
    live_today: countOf(`SELECT COUNT(*) AS c FROM live_session lv WHERE ${TODO_WHERE.live_today} ${shopLive.sql}`, ...shopLive.params),
  };
}

/** 待办明细：每类给可点进去的清单（带 id 与文案），一次最多 limit 条，count 是全量数 */
export function todoDetails(user: CurrentUser, limit = 20): TodoGroup[] {
  const counts = todoCounts(user);
  const shopListing = shopScope(user, 'l.shop_id');
  const shopItem = shopScope(user, 'o.shop_id');
  const shopAuth = shopScope(user, 's.id');
  const shopSync = shopScope(user, 'sl.shop_id');
  const shopLive = shopScope(user, 'lv.shop_id');
  const outreachScope = crmTodoScope(user, 'o.user_id');
  const sampleScope = crmTodoScope(user, 'c.owner_id');
  const groups: TodoGroup[] = [];

  groups.push({
    key: 'unmapped',
    label: '待映射 SKU',
    count: counts.unmapped_listings + counts.unmapped_items,
    link: '/products/unmapped',
    items: [
      ...all<Record<string, string | number | null>>(
        `SELECT l.id, l.product_name, l.tk_sku_id, s.shop_name
           FROM shop_listing l JOIN tk_shop s ON s.id = l.shop_id
          WHERE ${TODO_WHERE.unmapped_listing} ${shopListing.sql} ORDER BY l.id DESC LIMIT ?`,
        ...shopListing.params,
        limit,
      ).map((r) => ({
        id: `listing-${String(r.id)}`,
        title: String(r.product_name ?? `listing#${String(r.id)}`),
        subtitle: `${String(r.shop_name ?? '')} · 平台 SKU ${String(r.tk_sku_id ?? '—')}`,
        hint: '待映射：请到「商品中心 → 待映射清单」绑定内部 SKU',
        link: '/products/unmapped',
      })),
      ...all<Record<string, string | number | null>>(
        `SELECT i.id, o.tk_order_id, s.shop_name, i.item_amount, o.currency
           FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id JOIN tk_shop s ON s.id = o.shop_id
          WHERE ${TODO_WHERE.unmapped_item} ${shopItem.sql} ORDER BY i.id DESC LIMIT ?`,
        ...shopItem.params,
        limit,
      ).map((r) => ({
        id: `item-${String(r.id)}`,
        title: `订单 ${String(r.tk_order_id)} 的未映射明细`,
        subtitle: `${String(r.shop_name ?? '')} · ${String(r.item_amount ?? '0')} ${String(r.currency ?? '')}`,
        hint: '未计成本，已从利润统计中剔除（要点 1）',
        link: '/products/unmapped?tab=items',
      })),
    ],
  });

  groups.push({
    key: 'creator_follow',
    label: '待跟进达人',
    count: counts.creators_to_follow,
    link: '/creators/outreach',
    items: all<Record<string, string | number | null>>(
      `SELECT o.id, o.creator_id, o.next_follow_at, o.summary, c.handle, u.real_name
         FROM creator_outreach o
         JOIN creator c ON c.id = o.creator_id AND c.is_deleted = 0
         LEFT JOIN sys_user u ON u.id = o.user_id
        WHERE ${TODO_WHERE.creator_follow} ${outreachScope.sql}
        ORDER BY o.next_follow_at ASC LIMIT ?`,
      ...outreachScope.params,
      limit,
    ).map((r) => ({
      id: `creator-${String(r.creator_id)}`,
      title: `@${String(r.handle ?? '')}`,
      subtitle: `${String(r.real_name ?? '未分配')} · 约定跟进 ${String(r.next_follow_at ?? '')}`,
      hint: String(r.summary ?? '到期未跟进'),
      link: '/creators/outreach',
    })),
  });

  groups.push({
    key: 'sample_overdue',
    label: '超期未出内容样品',
    count: counts.samples_overdue,
    link: '/creators/sample',
    items: all<Record<string, string | number | null>>(
      `SELECT s.id, s.sign_time, s.tracking_no, c.handle, p.name_cn
         FROM sample_shipment s
         JOIN creator c ON c.id = s.creator_id AND c.is_deleted = 0
         LEFT JOIN product_sku sk ON sk.id = s.sku_id
         LEFT JOIN product_spu p ON p.id = sk.spu_id
        WHERE ${TODO_WHERE.sample_overdue} ${sampleScope.sql}
        ORDER BY s.sign_time ASC LIMIT ?`,
      sampleDueDays(),
      ...sampleScope.params,
      limit,
    ).map((r) => ({
      id: `sample-${String(r.id)}`,
      title: `@${String(r.handle ?? '')} · ${String(r.name_cn ?? '样品')}`,
      subtitle: `签收 ${String(r.sign_time ?? '')} · 单号 ${String(r.tracking_no ?? '—')}`,
      hint: '签收已超期未出内容，催达人发布',
      link: '/creators/sample',
    })),
  });

  groups.push({
    key: 'auth_expiring',
    label: '授权即将过期店铺',
    count: counts.auth_expiring,
    link: '/shops',
    items: all<Record<string, string | number | null>>(
      `SELECT s.id, s.shop_name, s.token_expire_at, s.auth_status
         FROM tk_shop s WHERE ${TODO_WHERE.auth_expiring} ${shopAuth.sql} ORDER BY s.token_expire_at ASC LIMIT ?`,
      ...shopAuth.params,
      limit,
    ).map((r) => ({
      id: `shop-${String(r.id)}`,
      title: String(r.shop_name ?? ''),
      subtitle: `到期 ${String(r.token_expire_at ?? '—')}`,
      hint: Number(r.auth_status) === 3 ? '授权已失效，同步已跳过该店' : '授权即将过期，请重新授权',
      link: '/shops',
    })),
  });

  groups.push({
    key: 'sync_failed',
    label: '同步失败',
    count: counts.sync_failed,
    link: '/system/synclog',
    items: all<Record<string, string | number | null>>(
      `SELECT sl.id, sl.task_type, sl.error_msg, sl.started_at, s.shop_name
         FROM sync_log sl LEFT JOIN tk_shop s ON s.id = sl.shop_id
        WHERE ${TODO_WHERE.sync_failed} ${shopSync.sql} ORDER BY sl.id DESC LIMIT ?`,
      ...shopSync.params,
      limit,
    ).map((r) => ({
      id: `sync-${String(r.id)}`,
      title: `${String(r.shop_name ?? '全平台')} · ${String(r.task_type ?? '')} 同步异常`,
      subtitle: String(r.started_at ?? ''),
      hint: r.error_msg === null || r.error_msg === undefined ? '同步失败或数据异常' : maskError(String(r.error_msg)),
      link: '/system/synclog',
    })),
  });

  groups.push({
    key: 'live_today',
    label: '今日直播场次',
    count: counts.live_today,
    link: '/lives/schedule',
    items: all<Record<string, string | number | null>>(
      `SELECT lv.id, lv.plan_start, lv.plan_end, s.shop_name, u.real_name
         FROM live_session lv JOIN tk_shop s ON s.id = lv.shop_id LEFT JOIN sys_user u ON u.id = lv.host_id
        WHERE ${TODO_WHERE.live_today} ${shopLive.sql} ORDER BY lv.plan_start ASC LIMIT ?`,
      ...shopLive.params,
      limit,
    ).map((r) => ({
      id: `live-${String(r.id)}`,
      title: `${String(r.shop_name ?? '')} 直播 ${String(r.plan_start ?? '').slice(11, 16)}`,
      subtitle: `主播 ${String(r.real_name ?? '未排')} · ${String(r.plan_start ?? '')} ~ ${String(r.plan_end ?? '')}`,
      hint: '今日排班，开播前提醒主播与场控',
      link: '/lives/schedule',
    })),
  });

  return groups;
}

/** 工作台看板：严格返回 DashboardSummary 全字段；无成本权限时利润/成本类为 null */
export type DashboardPayload = Omit<DashboardSummary, 'est_cost' | 'est_gross_profit' | 'est_profit_rate' | 'settled_amount' | 'ad_spend' | 'ad_roi'> & {
  est_cost: number | null;
  est_gross_profit: number | null;
  est_profit_rate: number | null;
  settled_amount: number | null;
  ad_spend: number | null;
  ad_roi: number | null;
  net_gmv: number;
  settled_pending: number | null;
  ad_orders: number;
  range: { start: string; end: string; anchored: boolean };
  warn: ProfitWarn;
  rate_missing: boolean;
};

/**
 * 看板指标。全部复用利润引擎（同一口径），受 shopScope 约束；
 * can_see_cost=false 时成本/利润/结算字段为 null，前端据此整块隐藏。
 */
export function dashboardMetrics(user: CurrentUser, range: { start?: string; end?: string } = {}): DashboardPayload {
  const filter: ProfitFilter = { user, start: range.start, end: range.end };
  const overallReport = computeProfitReport({ ...filter, dim: 'all' });
  const overall = overallReport.total;
  const daily = computeProfitReport({ ...filter, dim: 'day' });
  const shops = computeProfitReport({ ...filter, dim: 'shop' });
  const creators = computeProfitReport({ ...filter, dim: 'creator' });
  const contents = computeProfitReport({ ...filter, dim: 'content' });
  const ads = adMetrics(filter);
  const todos = todoCounts(user);
  const canCost = user.can_see_cost;

  const dates = daily.list.map((r) => r.dim_key).sort();
  const gmv_trend = dates.map((d) => {
    const r = daily.list.find((x) => x.dim_key === d)!;
    return { date: d, gmv: r.gmv, orders: r.orders, profit: canCost ? r.profit : null as unknown as number };
  });
  const contentRows = new Map(contents.list.map((r) => [r.dim_key, r]));
  return {
    gmv: overall.gmv,
    orders: overall.orders,
    refund_amount: overall.refund,
    refund_rate: profitRate(overall.refund, overall.gmv),
    est_cost: canCost ? overall.cost : null,
    est_gross_profit: canCost ? overall.gross_profit : null,
    est_profit_rate: canCost ? profitRate(overall.gross_profit, overall.net_gmv || overall.gmv) : null,
    settled_amount: canCost ? overall.settled_paid : null,
    ad_spend: canCost ? overall.ad_spend : null,
    ad_gmv: overall.ad_gmv,
    ad_roi: canCost ? ads.total.roi : null,
    unmapped_listings: todos.unmapped_listings,
    creators_to_follow: todos.creators_to_follow,
    samples_overdue: todos.samples_overdue,
    auth_expiring: todos.auth_expiring,
    sync_failed: todos.sync_failed,
    live_today: todos.live_today,
    gmv_trend,
    shop_rank: shops.list.slice(0, 10).map((r) => ({
      shop_id: Number(r.dim_key.replace(/^S/, '')) || 0,
      shop_name: r.dim_name,
      gmv: r.gmv,
      orders: r.orders,
      profit: canCost ? r.profit : (null as unknown as number),
    })),
    creator_rank: creators.list
      .filter((r) => r.dim_key !== NO_CREATOR_KEY)
      .slice(0, 10)
      .map((r) => ({
        creator_id: Number(r.dim_key.replace(/^C/, '')) || 0,
        handle: r.dim_name,
        gmv: r.gmv,
        orders: r.orders,
        cost: canCost ? r.cost : (null as unknown as number),
        roi: canCost ? adRoi(r.cost + r.commission + r.ad_spend + r.expense, r.net_gmv) : (null as unknown as number),
      })),
    content_type_split: Object.entries(CONTENT_TYPE_LABEL).map(([t, label]) => {
      const r = contentRows.get(`T${t}`);
      return { type: label, gmv: r?.gmv ?? 0, orders: r?.orders ?? 0 };
    }),
    bd_rank: bdRank(user),
    can_see_cost: canCost,
    net_gmv: overall.net_gmv,
    settled_pending: canCost ? overall.settled_pending : null,
    ad_orders: ads.total.conversions,
    range: { start: daily.start, end: daily.end, anchored: daily.anchored },
    warn: overallReport.warn,
    rate_missing: overallReport.rate_missing,
  };
}

/**
 * BD 绩效：区间内跟进数 / 谈妥数 / 名下达人带货净 GMV。
 * 带货额直接复用利润引擎的达人维度（同一折算、切日与未映射剔除口径），不在 SQL 里另算一套。
 */
export function bdRank(user: CurrentUser, range: { start?: string; end?: string } = {}): DashboardSummary['bd_rank'] {
  const rep = computeProfitReport({ user, start: range.start, end: range.end, dim: 'creator' });
  const owners = new Map<number, number>(
    all<{ id: number; owner_id: number | null }>(`SELECT id, owner_id FROM creator WHERE is_deleted = 0 AND owner_id IS NOT NULL`).map((r) => [r.id, Number(r.owner_id)]),
  );
  const byOwner = new Map<number, { gmv: number; orders: number }>();
  for (const row of rep.list) {
    const creatorId = Number(/^C(\d+)$/.exec(row.dim_key)?.[1] ?? 0);
    if (!creatorId) continue;
    const ownerId = owners.get(creatorId);
    if (!ownerId) continue;
    const acc = byOwner.get(ownerId) ?? { gmv: 0, orders: 0 };
    acc.gmv += row.net_gmv;
    acc.orders += row.orders;
    byOwner.set(ownerId, acc);
  }
  const r = resolveRange({ user, start: range.start, end: range.end });
  const person = personScope(user, 'u.id', true);
  const rows = all<{ id: number; real_name: string; outreach: number | string; agreed: number | string }>(
    `SELECT u.id, u.real_name,
            (SELECT COUNT(*) FROM creator_outreach o
              WHERE o.is_deleted = 0 AND o.user_id = u.id AND o.contact_time >= ? AND o.contact_time <= ?) AS outreach,
            (SELECT COUNT(*) FROM creator_outreach o
              WHERE o.is_deleted = 0 AND o.user_id = u.id AND o.result = 6 AND o.contact_time >= ? AND o.contact_time <= ?) AS agreed
       FROM sys_user u JOIN sys_role rl ON rl.id = u.role_id
      WHERE u.is_deleted = 0 AND u.status = 1 AND rl.role_key IN ('bd', 'bd_manager') ${person.sql}`,
    `${r.start} 00:00:00`,
    `${r.end} 23:59:59`,
    `${r.start} 00:00:00`,
    `${r.end} 23:59:59`,
    ...person.params,
  );
  return rows
    .map((x) => ({
      user_id: x.id,
      real_name: x.real_name,
      outreach: Number(x.outreach),
      agreed: Number(x.agreed),
      gmv: round2(byOwner.get(x.id)?.gmv ?? 0),
    }))
    .sort((a, b) => b.gmv - a.gmv || b.outreach - a.outreach || b.agreed - a.agreed);
}
