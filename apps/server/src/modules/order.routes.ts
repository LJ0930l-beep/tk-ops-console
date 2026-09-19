/**
 * 订单中心（方案表 6 tk_order / 表 7 tk_order_item / 表 8 tk_return）
 *
 * 三条口径（方案 5.3 要点，本模块逐条落地）：
 *  1. 成本一律读 tk_order_item.cost_snapshot（订单落库时冻结的人民币快照），本文件**只读不写**快照，
 *     改 SKU 成本不回溯历史（改价入口在商品中心）；
 *  2. cost_matched=0 的行没有成本，所有收入/成本/佣金/利润口径整体排除它们（绝不按 0 成本参与计算），
 *     响应里给 warn 与被排除的行数和金额；要补历史行请用「数据同步 → 派生汇总刷新」；
 *  3. is_sample_order=1 是达人免费样品单，不计 GMV 也不计利润（与利润引擎 includeSample=false 同口径）。
 *
 * 人民币折算：按订单日期取 exchange_rate → 取不到用该币种最近一天 → 再取不到用 1，并回 rate_missing。
 * 金额与状态人工不可改（方案表 6）；唯一允许人工写的订单字段是 is_sample_order，且必须留痕。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  CONTENT_TYPE,
  ORDER_STATUS_LABEL,
  REGION_TZ_OFFSET,
  RESPONSIBILITY,
  profitRate,
  round2,
  statDateInZone,
  zoneDayStartUtc,
  type CurrentUser,
} from '@tk/shared';
import { all, get, scalar, update, type SqlParam } from '../core/db.js';
import { badRequest, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { maskFields, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, writeOpLog } from '../core/oplog.js';

const MODULE = '订单中心';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19);

/* ==================== 枚举中文（方案表 6/7/8/16 注释） ==================== */

const CONTENT_TYPE_LABEL: Record<number, string> = {
  [CONTENT_TYPE.CREATOR_VIDEO]: '达人视频',
  [CONTENT_TYPE.CREATOR_LIVE]: '达人直播',
  [CONTENT_TYPE.OWN_VIDEO]: '自营视频',
  [CONTENT_TYPE.OWN_LIVE]: '自营直播',
  [CONTENT_TYPE.PRODUCT_CARD]: '商品卡',
};

const RESPONSIBILITY_LABEL: Record<number, string> = {
  [RESPONSIBILITY.UNSET]: '未归类',
  [RESPONSIBILITY.QUALITY]: '质量',
  [RESPONSIBILITY.LOGISTICS]: '物流',
  [RESPONSIBILITY.DESCRIPTION]: '描述不符',
  [RESPONSIBILITY.BUYER]: '买家原因',
};

const FULFILLMENT_LABEL: Record<number, string> = { 1: '平台仓', 2: '自发货', 3: '海外仓' };

const SETTLE_TXN_LABEL: Record<number, string> = {
  1: '订单收入',
  2: '退款',
  3: '平台佣金',
  4: '达人佣金',
  5: '运费',
  6: '平台补贴',
  7: '调整',
  8: '其他',
};

const contentLabel = (v: unknown): string | null => (v === null || v === undefined ? null : CONTENT_TYPE_LABEL[num(v)] ?? `类型${String(v)}`);
const responsibilityLabel = (v: unknown): string => RESPONSIBILITY_LABEL[num(v)] ?? '未归类';

const SAMPLE_TIP = '样品单不计 GMV，也不计利润（其成本走寄样/达人费用口径）';
const UNMAPPED_TIP = '存在成本未匹配的订单行：这些行已从收入、成本、佣金与利润中整体排除，绝不按 0 成本参与计算，请尽快在商品中心完成映射';

/** 无 can_see_cost 时掩码的字段集合（按接口分别取用） */
const LIST_COST_FIELDS = ['cost_cny', 'commission_cny', 'est_profit_cny', 'est_profit_rate'];
const ITEM_COST_FIELDS = ['cost_snapshot', 'unit_cost_cny', 'est_commission', 'est_commission_cny', 'commission_cny', 'profit_cny'];

/* ==================== SQL 片段 ==================== */

/** 汇率：按单据日期取当天 → 该币种最近一天 → NULL（调用方 COALESCE 成 1） */
const rateExprOf = (currencyCol: string, timeCol: string): string =>
  `(SELECT e.rate_to_cny
      FROM exchange_rate e
     WHERE e.currency = ${currencyCol} AND e.is_deleted = 0
     ORDER BY (e.rate_date <= COALESCE(substr(${timeCol}, 1, 10), '9999-12-31')) DESC, e.rate_date DESC
     LIMIT 1)`;

/** 订单维度（别名必须是 o） */
const RATE_RAW = rateExprOf('o.currency', 'o.order_time');
const RATE = `COALESCE(${RATE_RAW}, 1)`;
/** 售后维度（别名必须是 r） */
const RATE_RETURN = `COALESCE(${rateExprOf('r.currency', 'COALESCE(r.apply_time, r.finish_time)')}, 1)`;

/** 以下聚合子查询全部挂在别名 o 上；只有 cost_matched=1 的明细进入金额口径 */
const SUM_MATCHED_AMOUNT = `(SELECT COALESCE(SUM(i.item_amount), 0) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0 AND i.cost_matched = 1)`;
const SUM_UNMAPPED_AMOUNT = `(SELECT COALESCE(SUM(i.item_amount), 0) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0 AND i.cost_matched = 0)`;
const SUM_COMMISSION = `(SELECT COALESCE(SUM(i.est_commission), 0) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0 AND i.cost_matched = 1)`;
const SUM_COST = `(SELECT COALESCE(SUM(i.cost_snapshot), 0) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0 AND i.cost_matched = 1)`;
const SUM_REFUND = `(SELECT COALESCE(SUM(r.refund_amount), 0) FROM tk_return r WHERE r.order_id = o.id AND r.is_deleted = 0)`;
const COUNT_ITEMS = `(SELECT COUNT(*) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0)`;
const COUNT_UNMAPPED = `(SELECT COUNT(*) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0 AND i.cost_matched = 0)`;
const COUNT_SETTLED = `(SELECT COUNT(*) FROM settlement_txn t WHERE t.tk_order_id = o.tk_order_id AND t.is_deleted = 0)`;

/** 计 GMV / 计利润的条件：非样品单且非取消 */
const COUNTABLE = `o.is_sample_order = 0 AND o.order_status <> 'CANCELLED'`;

const ORDER_FROM = `tk_order o JOIN tk_shop s ON s.id = o.shop_id`;

const ORDER_SELECT = `o.*, s.shop_name, s.region, s.timezone,
        ${COUNT_ITEMS} AS item_count,
        ${COUNT_UNMAPPED} AS unmapped_item_count,
        ${SUM_MATCHED_AMOUNT} AS matched_amount,
        ${SUM_UNMAPPED_AMOUNT} AS unmapped_amount,
        ${SUM_COMMISSION} AS commission_local,
        ${SUM_COST} AS cost_cny,
        ${SUM_REFUND} AS refund_local,
        ${COUNT_SETTLED} AS settled_count,
        ${RATE_RAW} AS rate_to_cny`;

/** 聚合口径：外层 FROM 必须是 ORDER_FROM（别名 o / s） */
const AGGREGATE_SELECT = `
        COUNT(*) AS orders,
        SUM(CASE WHEN o.order_status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_orders,
        SUM(CASE WHEN o.is_sample_order = 1 THEN 1 ELSE 0 END) AS sample_orders,
        COALESCE(SUM(${COUNT_UNMAPPED}), 0) AS unmapped_items,
        ROUND(SUM(CASE WHEN ${COUNTABLE} THEN o.total_paid * ${RATE} ELSE 0 END), 2) AS gmv_cny,
        ROUND(SUM(${SUM_REFUND} * ${RATE}), 2) AS refund_cny,
        ROUND(SUM(CASE WHEN ${COUNTABLE} THEN (o.total_paid - ${SUM_REFUND}) * ${RATE} ELSE 0 END), 2) AS net_gmv_cny,
        ROUND(SUM(${SUM_COST}), 2) AS cost_cny,
        ROUND(SUM(${SUM_COMMISSION} * ${RATE}), 2) AS commission_cny,
        ROUND(SUM(CASE WHEN ${COUNTABLE} THEN (${SUM_MATCHED_AMOUNT} - ${SUM_COMMISSION}) * ${RATE} - ${SUM_COST} ELSE 0 END), 2) AS est_profit_cny`;

/** 按店铺 IANA 时区切自然日（含夏令时，tz_day 由 core/db.ts 注册，第三参是站点兜底偏移） */
const tzDayExpr = (timeCol: string, tzCol: string, regionCol: string): string => `tz_day(${timeCol}, ${tzCol}, ${regionCol})`;

const scopeOf = (req: Request, col: string): { sql: string; params: number[] } => shopScope(current(req), col);

/** shopScope 返回 'AND xxx'，Q 内部自己拼 AND，并条件时要剥掉前缀 */
const applyScope = (q: Q, scope: { sql: string; params: number[] }): Q => q.and(scope.sql.replace(/^\s*AND\s+/i, ''), ...scope.params);

/** 站点时区自然日（tz 为 tk_shop.timezone，缺失时退回站点固定偏移） */
function siteDayOf(orderTime: unknown, timezone: unknown, region: unknown): string {
  const t = String(orderTime ?? '');
  if (!t) return '';
  return statDateInZone(
    `${t.replace(' ', 'T')}${t.includes('Z') ? '' : 'Z'}`,
    String(timezone ?? ''),
    REGION_TZ_OFFSET[String(region ?? '')] ?? 0,
  );
}

/** 自然日 → UTC 时间窗（费用分摊取同店当日单量做分母用），按店铺时区含夏令时 */
function dayWindowUtc(day: string, timezone: unknown, region: unknown): { from: string; to: string } {
  const start = zoneDayStartUtc(
    day,
    String(timezone ?? ''),
    REGION_TZ_OFFSET[String(region ?? '')] ?? 0,
  );
  if (!Number.isFinite(start)) return { from: '', to: '' };
  return { from: fmt(new Date(start)), to: fmt(new Date(start + 86_400_000)) };
}

/* ==================== 列表条件与视图 ==================== */

function orderQ(req: Request): Q {
  const q = applyScope(new Q('o.is_deleted = 0'), scopeOf(req, 'o.shop_id'));
  q.eq('o.shop_id', qv(req, 'shop_id'))
    .eq('o.fulfillment_type', qv(req, 'fulfillment_type'))
    .eq('o.is_sample_order', qv(req, 'is_sample_order'))
    .eq('s.region', qv(req, 'region'), false);
  const keyword = qv(req, 'keyword');
  if (keyword) {
    // 关键字：平台单号 / 物流单号 / 明细上的 seller_sku / 达人 handle
    const like = `%${keyword}%`;
    q.and(
      `(o.tk_order_id LIKE ? OR o.tracking_no LIKE ? OR EXISTS (
          SELECT 1 FROM tk_order_item ik
          LEFT JOIN shop_listing lk ON lk.id = ik.listing_id
          LEFT JOIN creator ck ON ck.id = ik.creator_id
         WHERE ik.order_id = o.id AND ik.is_deleted = 0
           AND (IFNULL(lk.seller_sku, '') LIKE ? OR IFNULL(ck.handle, '') LIKE ?)))`,
      like,
      like,
      like,
      like,
    );
  }
  const statuses = (qv(req, 'order_status') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (statuses.length) q.in('o.order_status IN', statuses);
  q.between('o.order_time', qv(req, 'order_time_from'), qv(req, 'order_time_to'));
  q.between('o.paid_time', qv(req, 'paid_time_from'), qv(req, 'paid_time_to'));
  const days = qv(req, 'days');
  if (days) q.and(`o.order_time >= datetime('now', ?)`, `-${Math.max(1, Number(days) || 30)} days`);
  if (qv(req, 'only_unmapped') === '1') q.and(`EXISTS (SELECT 1 FROM tk_order_item i2 WHERE i2.order_id = o.id AND i2.is_deleted = 0 AND i2.cost_matched = 0)`);
  if (qv(req, 'has_return') === '1') q.and(`EXISTS (SELECT 1 FROM tk_return r2 WHERE r2.order_id = o.id AND r2.is_deleted = 0)`);
  const settled = qv(req, 'settled');
  if (settled === '0') q.and(`NOT EXISTS (SELECT 1 FROM settlement_txn t2 WHERE t2.tk_order_id = o.tk_order_id AND t2.is_deleted = 0)`);
  if (settled === '1') q.and(`EXISTS (SELECT 1 FROM settlement_txn t2 WHERE t2.tk_order_id = o.tk_order_id AND t2.is_deleted = 0)`);
  if (qv(req, 'creator_id')) {
    q.and(`EXISTS (SELECT 1 FROM tk_order_item i3 WHERE i3.order_id = o.id AND i3.is_deleted = 0 AND i3.creator_id = ?)`, num(qv(req, 'creator_id')));
  }
  if (qv(req, 'content_type')) {
    q.and(`EXISTS (SELECT 1 FROM tk_order_item i4 WHERE i4.order_id = o.id AND i4.is_deleted = 0 AND i4.content_type = ?)`, num(qv(req, 'content_type')));
  }
  return q;
}

/** 订单行 → 视图：算人民币口径与预估毛利，再按 can_see_cost 掩码 */
function orderView(user: CurrentUser) {
  return (row: Record<string, unknown>): Record<string, unknown> => {
    const rate = num(row.rate_to_cny) || 1;
    const sample = num(row.is_sample_order) === 1;
    const cancelled = String(row.order_status) === 'CANCELLED';
    const counted = !sample && !cancelled;
    const matched = num(row.matched_amount);
    const commission = num(row.commission_local);
    const cost = num(row.cost_cny);
    const refund = num(row.refund_local);
    const incomeCny = round2(matched * rate);
    const profit = counted ? round2((matched - commission) * rate - cost) : 0;
    return maskFields(
      {
        ...row,
        order_status_label: ORDER_STATUS_LABEL[String(row.order_status ?? '')] ?? String(row.order_status ?? ''),
        fulfillment_label: FULFILLMENT_LABEL[num(row.fulfillment_type)] ?? null,
        rate_to_cny: round2(rate),
        rate_missing: row.rate_to_cny === null || row.rate_to_cny === undefined,
        counts_for_gmv: counted ? 1 : 0,
        gmv_cny: counted ? round2(num(row.total_paid) * rate) : 0,
        refund_cny: round2(refund * rate),
        net_gmv_cny: counted ? round2((num(row.total_paid) - refund) * rate) : 0,
        cost_cny: round2(cost),
        commission_cny: round2(commission * rate),
        unmapped_amount_cny: round2(num(row.unmapped_amount) * rate),
        est_profit_cny: profit,
        est_profit_rate: profitRate(profit, incomeCny),
        is_settled: num(row.settled_count) > 0,
        is_estimated: num(row.settled_count) > 0 ? 0 : 1,
        warn: num(row.unmapped_item_count) > 0 ? UNMAPPED_TIP : undefined,
      },
      LIST_COST_FIELDS,
      user.can_see_cost,
    );
  };
}

/** 范围内可见的一张订单头（聚合列齐备） */
function loadOrder(req: Request, id: number): Record<string, unknown> {
  const scope = scopeOf(req, 'o.shop_id');
  const row = get<Record<string, unknown>>(
    `SELECT ${ORDER_SELECT} FROM ${ORDER_FROM} WHERE o.id = ? AND o.is_deleted = 0 ${scope.sql}`,
    id,
    ...scope.params,
  );
  if (!row) throw notFound('订单不存在或不在你的数据范围内');
  return row;
}

/* ==================== 路由 ==================== */

export const orderRouter = Router();
orderRouter.use(requireMenu('order'));

/* -------------------- 列表 / 汇总 / 未匹配 / 导出：静态路径必须排在 /:id 之前 -------------------- */

orderRouter.get(
  '/',
  wrap((req, res) => {
    const user = current(req);
    const q = orderQ(req);
    const page = queryPage(req, { from: ORDER_FROM, select: ORDER_SELECT, q, orderBy: 'o.order_time DESC, o.id DESC' });
    const stats = get<Record<string, unknown>>(`SELECT ${AGGREGATE_SELECT} FROM ${ORDER_FROM}${q.whereSql}`, ...q.params) ?? {};
    ok(res, {
      ...page,
      list: page.list.map(orderView(user)),
      stats: { ...stats, refund_rate: profitRate(num(stats.refund_cny), num(stats.gmv_cny)) },
      tip: '样品单与已取消订单不计 GMV；est_profit 仅含冻结成本快照与达人佣金，不含广告与费用分摊',
    });
  }),
);

/** 订单汇总：总量 / 按店铺 / 按站点时区自然日，同一套筛选与数据范围 */
orderRouter.get(
  '/summary',
  wrap((req, res) => {
    const q = orderQ(req);
    const where = q.whereSql;
    const params = q.params;
    const totals = get<Record<string, unknown>>(`SELECT ${AGGREGATE_SELECT} FROM ${ORDER_FROM}${where}`, ...params) ?? {};
    const byShop = all<Record<string, unknown>>(
      `SELECT o.shop_id AS shop_id, s.shop_name AS shop_name, s.region AS region, s.currency AS currency, ${AGGREGATE_SELECT}
         FROM ${ORDER_FROM}${where}
        GROUP BY o.shop_id, s.shop_name, s.region, s.currency
        ORDER BY gmv_cny DESC LIMIT 100`,
      ...params,
    );
    const byDay = all<Record<string, unknown>>(
      `SELECT ${tzDayExpr('o.order_time', 's.timezone', 's.region')} AS stat_date, ${AGGREGATE_SELECT}
         FROM ${ORDER_FROM}${where}
        GROUP BY stat_date ORDER BY stat_date ASC LIMIT 400`,
      ...params,
    );
    const withRate = (r: Record<string, unknown>) => ({ ...r, refund_rate: profitRate(num(r.refund_cny), num(r.gmv_cny)) });
    ok(res, {
      totals: withRate(totals),
      by_shop: byShop.map(withRate),
      by_day: byDay.map(withRate),
      note: '按日切分用站点时区自然日（与 ad_daily.stat_date 同口径）；GMV 与利润均已排除样品单、已取消订单与待映射明细行',
    });
  }),
);

/** 无成本快照的订单行：只读清单，永不参与成本/利润计算 */
orderRouter.get(
  '/unmatched',
  wrap((req, res) => {
    const q = applyScope(new Q('i.is_deleted = 0 AND i.cost_matched = 0'), scopeOf(req, 'o.shop_id'));
    q.eq('o.shop_id', qv(req, 'shop_id'))
      .eq('l.map_status', qv(req, 'map_status'))
      .like('o.tk_order_id LIKE ? OR l.tk_sku_id LIKE ? OR l.seller_sku LIKE ? OR l.product_name LIKE ?', qv(req, 'keyword'));
    const days = qv(req, 'days');
    if (days) q.and(`o.order_time >= datetime('now', ?)`, `-${Math.max(1, Number(days) || 30)} days`);
    const from = `tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       JOIN tk_shop s ON s.id = o.shop_id
       LEFT JOIN shop_listing l ON l.id = i.listing_id
       LEFT JOIN creator c ON c.id = i.creator_id`;
    const page = queryPage(req, {
      from,
      select: `i.*, o.tk_order_id, o.order_time, o.order_status, o.currency, o.shop_id, o.is_sample_order,
               s.shop_name, s.region, l.id AS listing_id, l.tk_sku_id, l.seller_sku, l.product_name, l.map_status,
               c.handle AS creator_handle,
               ${RATE_RAW} AS rate_to_cny,
               ROUND(i.item_amount * ${RATE}, 2) AS item_amount_cny`,
      q,
      orderBy: 'o.order_time DESC, i.id DESC',
    });
    const totals = get<Record<string, unknown>>(
      `SELECT COUNT(*) AS item_count,
              COUNT(DISTINCT i.order_id) AS order_count,
              ROUND(COALESCE(SUM(i.item_amount), 0), 2) AS amount_local,
              ROUND(COALESCE(SUM(i.item_amount * ${RATE}), 0), 2) AS amount_cny
         FROM ${from}${q.whereSql}`,
      ...q.params,
    );
    ok(res, {
      ...page,
      list: page.list.map((row) => ({
        ...row,
        unmapped: true,
        cost_snapshot: null,
        order_status_label: ORDER_STATUS_LABEL[String(row.order_status ?? '')] ?? String(row.order_status ?? ''),
        cost_note: '无成本快照，未参与任何利润计算',
      })),
      totals: totals ?? {},
      warn: UNMAPPED_TIP,
    });
  }),
);

const EXPORT_COLUMNS = [
  'tk_order_id',
  'shop_name',
  'region',
  'order_status',
  'order_status_label',
  'order_time',
  'paid_time',
  'currency',
  'rate_to_cny',
  'subtotal',
  'seller_discount',
  'platform_discount',
  'shipping_fee',
  'total_paid',
  'gmv_cny',
  'net_gmv_cny',
  'item_count',
  'unmapped_item_count',
  'cost_cny',
  'commission_cny',
  'est_profit_cny',
  'fulfillment_type',
  'carrier',
  'tracking_no',
  'is_sample_order',
  'synced_at',
] as const;

/** 导出：requireExport 权限 + 必写 action='export' 日志；?format=csv 直接给带 BOM 的 CSV */
orderRouter.get(
  '/export',
  requireExport,
  wrap((req, res) => {
    const user = current(req);
    const q = orderQ(req);
    const rows = all<Record<string, unknown>>(
      `SELECT ${ORDER_SELECT} FROM ${ORDER_FROM}${q.whereSql} ORDER BY o.order_time DESC LIMIT 20000`,
      ...q.params,
    );
    const list = rows.map(orderView(user));
    const filters = {
      shop_id: qv(req, 'shop_id') ?? null,
      order_status: qv(req, 'order_status') ?? null,
      keyword: qv(req, 'keyword') ?? null,
      order_time_from: qv(req, 'order_time_from') ?? null,
      order_time_to: qv(req, 'order_time_to') ?? null,
      days: qv(req, 'days') ?? null,
    };
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'export',
      target_table: 'tk_order',
      after: { rows: list.length, format: qv(req, 'format') === 'csv' ? 'csv' : 'json', filters, cost_masked: !user.can_see_cost },
      ip: req.ip,
    });
    if (qv(req, 'format') === 'csv') {
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [EXPORT_COLUMNS.join(','), ...list.map((r) => EXPORT_COLUMNS.map((c) => esc(r[c])).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="orders-${fmt(new Date()).slice(0, 10)}.csv"`);
      res.send(`﻿${csv}`);
      return;
    }
    ok(res, { columns: [...EXPORT_COLUMNS], count: list.length, rows: list });
  }),
);

/* -------------------- 售后退款 -------------------- */

const RETURN_FROM = `tk_return r
       JOIN tk_shop s ON s.id = r.shop_id
       LEFT JOIN tk_order o ON o.id = r.order_id
       LEFT JOIN tk_order_item i ON i.id = r.tk_order_item_id
       LEFT JOIN shop_listing l ON l.id = i.listing_id
       LEFT JOIN product_sku k ON k.id = i.sku_id
       LEFT JOIN creator c ON c.id = i.creator_id`;

const RETURN_SELECT = `r.*, s.shop_name, s.region,
       o.tk_order_id, o.order_time, o.order_status, o.currency AS order_currency,
       i.id AS item_id, i.quantity, i.item_amount, i.cost_matched, i.sku_id, i.content_type, i.content_id,
       l.tk_sku_id, l.seller_sku, l.product_name, k.sku_code, c.handle AS creator_handle,
       ${RATE_RETURN} AS rate_to_cny,
       ROUND(r.refund_amount * ${RATE_RETURN}, 2) AS refund_amount_cny`;

function returnQ(req: Request): Q {
  const q = applyScope(new Q('r.is_deleted = 0'), scopeOf(req, 'r.shop_id'));
  q.eq('r.shop_id', qv(req, 'shop_id'))
    .eq('r.status', qv(req, 'status'), false)
    .eq('r.return_type', qv(req, 'return_type'))
    .eq('r.responsibility', qv(req, 'responsibility'))
    .eq('r.is_restocked', qv(req, 'is_restocked'))
    .like('r.tk_return_id LIKE ? OR o.tk_order_id LIKE ? OR r.reason LIKE ?', qv(req, 'keyword'));
  q.between('r.apply_time', qv(req, 'apply_time_from'), qv(req, 'apply_time_to'));
  const days = qv(req, 'days');
  if (days) q.and(`r.apply_time >= datetime('now', ?)`, `-${Math.max(1, Number(days) || 30)} days`);
  if (qv(req, 'unset_responsibility') === '1') q.and('r.responsibility = 0');
  if (qv(req, 'orphan') === '1') q.and('r.order_id IS NULL');
  return q;
}

const returnView = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  return_type_label: num(row.return_type) === 2 ? '退货退款' : '仅退款',
  responsibility_label: responsibilityLabel(row.responsibility),
  content_type_label: contentLabel(row.content_type),
  order_status_label: ORDER_STATUS_LABEL[String(row.order_status ?? '')] ?? null,
  orphan: row.order_id === null || row.order_id === undefined,
  rate_missing: row.rate_to_cny === null || row.rate_to_cny === undefined,
});

orderRouter.get(
  '/returns',
  wrap((req, res) => {
    const q = returnQ(req);
    const page = queryPage(req, { from: RETURN_FROM, select: RETURN_SELECT, q, orderBy: 'r.apply_time DESC, r.id DESC' });
    const totals = get<Record<string, unknown>>(
      `SELECT COUNT(*) AS returns,
              COALESCE(SUM(r.refund_amount), 0) AS refund_amount_local,
              ROUND(COALESCE(SUM(r.refund_amount * ${RATE_RETURN}), 0), 2) AS refund_amount_cny,
              COALESCE(SUM(CASE WHEN r.responsibility = 0 THEN 1 ELSE 0 END), 0) AS unset_responsibility,
              COALESCE(SUM(CASE WHEN r.is_restocked = 1 THEN 1 ELSE 0 END), 0) AS restocked
         FROM ${RETURN_FROM}${q.whereSql}`,
      ...q.params,
    );
    ok(res, {
      ...page,
      list: page.list.map(returnView),
      totals: totals ?? {},
      tip: '退款金额与状态由同步覆盖，人工只补 responsibility / is_restocked',
    });
  }),
);

/** 售后分析：退款原因 Top + 责任归属分布 + 状态/类型分布 */
orderRouter.get(
  '/returns/stats',
  wrap((req, res) => {
    const q = returnQ(req);
    const where = q.whereSql;
    const params = q.params;
    const group = (col: string): Record<string, unknown>[] =>
      all<Record<string, unknown>>(
        `SELECT ${col} AS k, COUNT(*) AS count, ROUND(COALESCE(SUM(r.refund_amount * ${RATE_RETURN}), 0), 2) AS refund_cny
           FROM ${RETURN_FROM}${where}
          GROUP BY ${col} ORDER BY count DESC LIMIT 30`,
        ...params,
      );
    const reasonTop = all<Record<string, unknown>>(
      `SELECT IFNULL(NULLIF(TRIM(r.reason), ''), '（未填原因）') AS reason, COUNT(*) AS count,
              ROUND(COALESCE(SUM(r.refund_amount * ${RATE_RETURN}), 0), 2) AS refund_cny
         FROM ${RETURN_FROM}${where}
        GROUP BY reason ORDER BY refund_cny DESC LIMIT 10`,
      ...params,
    );
    const responsibility = group('r.responsibility').map((r): Record<string, unknown> => ({ ...r, responsibility_label: responsibilityLabel(r.k) }));
    const status = group('r.status');
    const type = group('r.return_type').map((r): Record<string, unknown> => ({ ...r, return_type_label: num(r.k) === 2 ? '退货退款' : '仅退款' }));
    const shop = group('r.shop_id');
    const unset = num(responsibility.find((r) => num(r.k) === RESPONSIBILITY.UNSET)?.count);
    ok(res, {
      reason_top: reasonTop,
      responsibility_top: responsibility,
      status_dist: status,
      type_dist: type,
      shop_dist: shop,
      unset_responsibility: unset,
      tip: 'responsibility=0 表示客服尚未归类，工作台红点按该计数提醒',
    });
  }),
);

/** 售后对经营的影响：退款额、退款率、回仓率、未回仓损失，按店铺拆分 */
orderRouter.get(
  '/returns/impact',
  wrap((req, res) => {
    const user = current(req);
    const q = returnQ(req);
    const where = q.whereSql;
    const params = q.params;
    const totals = get<Record<string, unknown>>(
      `SELECT COUNT(*) AS returns,
              COUNT(DISTINCT r.order_id) AS refund_orders,
              ROUND(COALESCE(SUM(r.refund_amount * ${RATE_RETURN}), 0), 2) AS refund_cny,
              COALESCE(SUM(CASE WHEN r.is_restocked = 1 THEN 1 ELSE 0 END), 0) AS restocked,
              COALESCE(SUM(CASE WHEN r.status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed,
              ROUND(COALESCE(SUM(CASE WHEN r.is_restocked = 0 THEN i.cost_snapshot ELSE 0 END), 0), 2) AS lost_cost_cny
         FROM ${RETURN_FROM}${where}`,
      ...params,
    );
    const byShop = all<Record<string, unknown>>(
      `SELECT r.shop_id AS shop_id, s.shop_name AS shop_name, COUNT(*) AS returns,
              ROUND(COALESCE(SUM(r.refund_amount * ${RATE_RETURN}), 0), 2) AS refund_cny,
              ROUND(COALESCE(SUM(CASE WHEN r.is_restocked = 0 THEN i.cost_snapshot ELSE 0 END), 0), 2) AS lost_cost_cny
         FROM ${RETURN_FROM}${where}
        GROUP BY r.shop_id, s.shop_name ORDER BY refund_cny DESC LIMIT 100`,
      ...params,
    );
    const oq = orderQ(req);
    const gmv = num(
      get<Record<string, unknown>>(
        `SELECT ROUND(SUM(CASE WHEN ${COUNTABLE} THEN o.total_paid * ${RATE} ELSE 0 END), 2) AS gmv_cny FROM ${ORDER_FROM}${oq.whereSql}`,
        ...oq.params,
      )?.gmv_cny,
    );
    const returns = num(totals?.returns);
    ok(res, {
      totals: {
        ...(totals ?? {}),
        gmv_cny: round2(gmv),
        refund_rate: profitRate(num(totals?.refund_cny), gmv),
        restock_rate: returns > 0 ? round2((num(totals?.restocked) / returns) * 100) : 0,
      },
      by_shop: byShop.map((r) => maskFields(r, ['lost_cost_cny'], user.can_see_cost)),
      note: 'lost_cost_cny = 未回仓订单行已冻结成本的损失口径（无成本快照的行按排除处理，不按 0 计入）',
    });
  }),
);

const returnUpdateBody = z
  .object({
    responsibility: z.number().int().min(0).max(4).optional(),
    is_restocked: z.number().int().min(0).max(1).optional(),
  })
  .strict();

/** 客服补填：只允许改责任归属与是否回仓（金额/状态由同步覆盖，方案表 8；表内无人工备注列，备注走操作日志） */
orderRouter.put(
  '/returns/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const scope = scopeOf(req, 'r.shop_id');
    const before = get<Record<string, unknown>>(`SELECT r.* FROM tk_return r WHERE r.id = ? AND r.is_deleted = 0 ${scope.sql}`, id, ...scope.params);
    if (!before) throw notFound('售后单不存在或不在你的数据范围内');
    const body = parseBody(returnUpdateBody, req.body);
    if (body.responsibility === undefined && body.is_restocked === undefined) throw badRequest('至少提交 responsibility / is_restocked 之一');
    update('tk_return', id, {
      ...(body.responsibility === undefined ? {} : { responsibility: body.responsibility }),
      ...(body.is_restocked === undefined ? {} : { is_restocked: body.is_restocked }),
    });
    logIfChanged({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'tk_return',
      target_id: id,
      before: { responsibility: before.responsibility, is_restocked: before.is_restocked },
      after: { responsibility: body.responsibility ?? num(before.responsibility), is_restocked: body.is_restocked ?? num(before.is_restocked) },
      keys: ['responsibility', 'is_restocked'],
      ip: req.ip,
    });
    ok(res, {
      id,
      responsibility: body.responsibility ?? num(before.responsibility),
      is_restocked: body.is_restocked ?? num(before.is_restocked),
      tip: '退款金额与状态由同步覆盖，人工不可改',
    });
  }),
);

orderRouter.get(
  '/returns/:id',
  wrap((req, res) => {
    const scope = scopeOf(req, 'r.shop_id');
    const row = get<Record<string, unknown>>(
      `SELECT ${RETURN_SELECT} FROM ${RETURN_FROM} WHERE r.id = ? AND r.is_deleted = 0 ${scope.sql}`,
      Number(req.params.id),
      ...scope.params,
    );
    if (!row) throw notFound('售后单不存在或不在你的数据范围内');
    const siblingReturns = row.order_id === null || row.order_id === undefined ? [] : all<Record<string, unknown>>(
      `SELECT tk_return_id, refund_amount, currency, status, responsibility, apply_time, reason
         FROM tk_return WHERE is_deleted = 0 AND order_id = ? ORDER BY apply_time DESC`,
      num(row.order_id),
    );
    const logs = all<Record<string, unknown>>(
      `SELECT l.id, l.op_time, l.action, l.user_id, u.real_name AS user_name, l.before_after
         FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
        WHERE l.is_deleted = 0 AND l.target_table = 'tk_return' AND l.target_id = ? ORDER BY l.id DESC LIMIT 50`,
      Number(row.id),
    );
    ok(res, { ...returnView(row), returns_of_order: siblingReturns, op_logs: logs });
  }),
);

/* -------------------- 订单详情 / 利润 -------------------- */

orderRouter.get(
  '/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const head = loadOrder(req, id);
    const rate = num(head.rate_to_cny) || 1;
    const items = all<Record<string, unknown>>(
      `SELECT i.*, l.tk_product_id, l.tk_sku_id, l.seller_sku, l.product_name, l.map_status,
              k.sku_code, k.spec, c.handle AS creator_handle, c.nickname AS creator_nickname, v.video_url
         FROM tk_order_item i
         LEFT JOIN shop_listing l ON l.id = i.listing_id
         LEFT JOIN product_sku k ON k.id = i.sku_id
         LEFT JOIN creator c ON c.id = i.creator_id
         LEFT JOIN video v ON v.tk_video_id = i.content_id
        WHERE i.order_id = ? AND i.is_deleted = 0 ORDER BY i.id ASC`,
      id,
    );
    const itemView = (row: Record<string, unknown>): Record<string, unknown> => {
      const matched = num(row.cost_matched) === 1;
      const qty = Math.max(1, num(row.quantity));
      const itemAmount = num(row.item_amount);
      const cost = num(row.cost_snapshot);
      const commissionCny = round2(num(row.est_commission) * rate);
      return maskFields(
        {
          ...row,
          unmapped: !matched,
          unit_price_cny: round2(num(row.unit_price) * rate),
          item_amount_cny: round2(itemAmount * rate),
          unit_cost_cny: matched ? round2(cost / qty) : null,
          est_commission_cny: commissionCny,
          commission_cny: commissionCny,
          profit_cny: matched ? round2((itemAmount - num(row.est_commission)) * rate - cost) : null,
          content_type_label: contentLabel(row.content_type),
          cost_note: matched ? null : '成本未匹配，未参与利润计算',
        },
        ITEM_COST_FIELDS,
        user.can_see_cost,
      );
    };
    const settlements = all<Record<string, unknown>>(
      `SELECT t.id, t.statement_id, t.statement_time, t.txn_type, t.amount, t.currency, t.payment_id, t.payment_status,
              ROUND(t.amount * ${rateExprOf('t.currency', 'COALESCE(t.statement_time, t.created_at)')}, 2) AS amount_cny
         FROM settlement_txn t
        WHERE t.is_deleted = 0 AND t.tk_order_id = ?
        ORDER BY t.statement_time ASC, t.id ASC`,
      String(head.tk_order_id),
    ).map((r) => ({ ...r, txn_type_label: SETTLE_TXN_LABEL[num(r.txn_type)] ?? '其他' }));
    const returns = all<Record<string, unknown>>(
      `SELECT r.id, r.tk_return_id, r.return_type, r.reason, r.refund_amount, r.currency, r.status, r.apply_time, r.finish_time,
              r.responsibility, r.is_restocked, r.tk_order_item_id,
              ROUND(r.refund_amount * ${RATE_RETURN}, 2) AS refund_amount_cny
         FROM tk_return r WHERE r.is_deleted = 0 AND r.order_id = ? ORDER BY r.apply_time DESC`,
      id,
    ).map((r) => ({ ...r, responsibility_label: responsibilityLabel(r.responsibility) }));
    const logs = all<Record<string, unknown>>(
      `SELECT l.id, l.op_time, l.action, l.user_id, u.real_name AS user_name, l.before_after
         FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
        WHERE l.is_deleted = 0 AND l.target_table = 'tk_order' AND l.target_id = ? ORDER BY l.id DESC LIMIT 50`,
      id,
    );
    const rateMissing = head.rate_to_cny === null || head.rate_to_cny === undefined;
    ok(res, {
      ...orderView(user)(head),
      items: items.map(itemView),
      settlements,
      returns,
      op_logs: logs,
      rate_missing: rateMissing,
      fx_note: rateMissing
        ? `汇率表没有 ${String(head.currency)} 的记录，本次按 1 折算，人民币金额仅供参考`
        : `汇率按订单日期取（${String(head.currency)} → CNY = ${round2(rate)}）`,
      tip: num(head.unmapped_item_count) > 0 ? UNMAPPED_TIP : undefined,
    });
  }),
);

/**
 * 单订单利润分解（方案 6.2）：收入 → 成本快照 → 达人佣金 → 退款冲减 → 广告分摊 → 其他费用分摊 → 利润/利润率。
 * 广告与费用按「同店同站点自然日内已匹配金额占比」分摊，口径写在各自 basis 字段里。
 * 没有结算流水 → is_estimated=1。
 */
orderRouter.get(
  '/:id/profit',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const head = loadOrder(req, id);
    const rate = num(head.rate_to_cny) || 1;
    const rateMissing = head.rate_to_cny === null || head.rate_to_cny === undefined;
    const shopId = num(head.shop_id);
    const region = String(head.region ?? '');
    const timezone = String(head.timezone ?? '');
    const sample = num(head.is_sample_order) === 1;
    const cancelled = String(head.order_status) === 'CANCELLED';
    const counted = !sample && !cancelled;

    const items = all<Record<string, unknown>>(
      `SELECT i.*, k.sku_code, c.handle AS creator_handle
         FROM tk_order_item i
         LEFT JOIN product_sku k ON k.id = i.sku_id
         LEFT JOIN creator c ON c.id = i.creator_id
        WHERE i.order_id = ? AND i.is_deleted = 0 ORDER BY i.id ASC`,
      id,
    );
    const matchedItems = items.filter((it) => num(it.cost_matched) === 1);
    const unmappedItems = items.filter((it) => num(it.cost_matched) !== 1);
    const incomeLocal = round2(matchedItems.reduce((s, it) => s + num(it.item_amount), 0));
    const costCny = round2(matchedItems.reduce((s, it) => s + num(it.cost_snapshot), 0));
    const commissionLocal = round2(matchedItems.reduce((s, it) => s + num(it.est_commission), 0));
    const commissionCny = round2(commissionLocal * rate);
    const incomeCny = round2(incomeLocal * rate);

    const returnRows = all<Record<string, unknown>>(
      `SELECT tk_return_id, return_type, reason, refund_amount, currency, status, responsibility, is_restocked, apply_time
         FROM tk_return WHERE is_deleted = 0 AND order_id = ? ORDER BY apply_time DESC`,
      id,
    );
    const refundCny = round2(returnRows.reduce((s, r) => s + num(r.refund_amount) * (String(r.currency) === 'CNY' ? 1 : rate), 0));

    const day = siteDayOf(head.order_time, timezone, region);
    const win = dayWindowUtc(day, timezone, region);
    const spendRows = day
      ? all<Record<string, unknown>>(
          `SELECT currency, COALESCE(SUM(spend), 0) AS spend FROM ad_daily WHERE is_deleted = 0 AND shop_id = ? AND stat_date = ? GROUP BY currency`,
          shopId,
          day,
        )
      : [];
    const spendCny = round2(spendRows.reduce((s, r) => s + num(r.spend) * (String(r.currency) === 'CNY' ? 1 : rate), 0));
    const expenseCny = day
      ? round2(
          num(
            scalar<SqlParam>(
              `SELECT COALESCE(SUM(amount_cny), 0) FROM expense WHERE is_deleted = 0 AND shop_id = ? AND expense_date = ?`,
              shopId,
              day,
            ),
          ),
        )
      : 0;
    const dayMatchedCny = day
      ? round2(
          num(
            scalar<SqlParam>(
              `SELECT COALESCE(SUM(i.item_amount * ${RATE}), 0)
                 FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
                WHERE i.is_deleted = 0 AND i.cost_matched = 1 AND o.shop_id = ?
                  AND ${COUNTABLE} AND o.order_time >= ? AND o.order_time < ?`,
              shopId,
              win.from,
              win.to,
            ),
          ),
        )
      : 0;
    const share = dayMatchedCny > 0 ? Math.min(1, incomeCny / dayMatchedCny) : 0;
    const allocAd = counted ? round2(spendCny * share) : 0;
    const allocExpense = counted ? round2(expenseCny * share) : 0;

    const tkOrderId = String(head.tk_order_id);
    const settledCount = num(scalar<SqlParam>(`SELECT COUNT(*) FROM settlement_txn WHERE is_deleted = 0 AND tk_order_id = ?`, tkOrderId));
    const settledIncomeCny = round2(
      num(
        scalar<SqlParam>(
          `SELECT COALESCE(SUM(t.amount * ${rateExprOf('t.currency', 'COALESCE(t.statement_time, t.created_at)')}), 0)
             FROM settlement_txn t WHERE t.is_deleted = 0 AND t.tk_order_id = ? AND t.txn_type = 1`,
          tkOrderId,
        ),
      ),
    );

    const grossProfit = counted ? round2(incomeCny - costCny - commissionCny) : 0;
    const profit = counted ? round2(grossProfit - refundCny - allocAd - allocExpense) : 0;
    const basis = `同店 ${day || '-'} 站点自然日消耗 × 本单已匹配金额 ÷ 当日全店已匹配金额（占比 ${round2(share * 100)}%）`;

    ok(
      res,
      maskFields(
        {
          order_id: id,
          tk_order_id: tkOrderId,
          shop_id: shopId,
          shop_name: head.shop_name,
          region,
          currency: String(head.currency),
          order_status: String(head.order_status),
          order_status_label: ORDER_STATUS_LABEL[String(head.order_status ?? '')] ?? String(head.order_status ?? ''),
          order_time: head.order_time ?? null,
          stat_date: day,
          counts_for_gmv: counted ? 1 : 0,
          fx: {
            currency: String(head.currency),
            rate_to_cny: round2(rate),
            rate_missing: rateMissing,
            note: rateMissing
              ? `汇率表缺少 ${String(head.currency)}，按 1 折算，人民币金额仅供参考`
              : '汇率按订单日期取，取不到用该币种最近一天，再取不到用 1',
          },
          income: {
            total_paid: num(head.total_paid),
            total_paid_cny: round2(num(head.total_paid) * rate),
            matched_amount: incomeLocal,
            income_cny: incomeCny,
            matched_items: matchedItems.length,
            excluded_unmapped_items: unmappedItems.length,
            excluded_unmapped_amount: round2(unmappedItems.reduce((s, it) => s + num(it.item_amount), 0)),
            excluded_unmapped_amount_cny: round2(unmappedItems.reduce((s, it) => s + num(it.item_amount) * rate, 0)),
            note: '收入只统计已匹配成本的明细行；未匹配行整体排除（不按 0 成本参与计算）',
          },
          cost: maskFields(
            {
              cost_cny: costCny,
              matched_items: matchedItems.length,
              unmatched_items: unmappedItems.length,
              basis: 'tk_order_item.cost_snapshot 冻结快照（（采购+头程）×数量，人民币），不回写',
              note: sample ? SAMPLE_TIP : undefined,
            },
            ['cost_cny'],
            user.can_see_cost,
          ),
          commission: maskFields(
            {
              commission_local: commissionLocal,
              commission_total_cny: commissionCny,
              items: matchedItems
                .filter((it) => num(it.est_commission) > 0 || it.creator_id !== null)
                .map((it) =>
                  maskFields(
                    {
                      item_id: num(it.id),
                      sku_code: it.sku_code ?? null,
                      creator_id: it.creator_id,
                      creator_handle: it.creator_handle ?? null,
                      content_type: it.content_type,
                      content_type_label: contentLabel(it.content_type),
                      content_id: it.content_id ?? null,
                      commission_rate: num(it.commission_rate),
                      commission_cny: round2(num(it.est_commission) * rate),
                    },
                    ['commission_cny', 'commission_rate'],
                    user.can_see_cost,
                  ),
                ),
            },
            ['commission_local', 'commission_total_cny'],
            user.can_see_cost,
          ),
          refund: {
            refund_cny: refundCny,
            count: returnRows.length,
            returns: returnRows.map((r) => ({ ...r, responsibility_label: responsibilityLabel(r.responsibility) })),
            note: '退款按本单汇率折算人民币，作为收入的冲减项',
          },
          ad_spend: maskFields(
            {
              shop_day_spend_cny: spendCny,
              shop_day_matched_cny: dayMatchedCny,
              allocated_cny: allocAd,
              share: round2(share * 100) / 100,
              basis,
            },
            ['shop_day_spend_cny', 'allocated_cny'],
            user.can_see_cost,
          ),
          other_expense: maskFields(
            {
              shop_day_expense_cny: expenseCny,
              allocated_cny: allocExpense,
              share: round2(share * 100) / 100,
              basis: `同店 ${day || '-'} 费用登记（amount_cny）按同一占比分摊`,
            },
            ['shop_day_expense_cny', 'allocated_cny'],
            user.can_see_cost,
          ),
          gross_profit_cny: grossProfit,
          profit_cny: profit,
          profit_rate: profitRate(profit, incomeCny),
          settled: { has_settlement: settledCount > 0, rows: settledCount, settled_income_cny: settledIncomeCny },
          is_estimated: settledCount > 0 ? 0 : 1,
          warn: [
            unmappedItems.length ? UNMAPPED_TIP : null,
            rateMissing ? '汇率缺失，人民币金额按 1 折算' : null,
            sample ? SAMPLE_TIP : null,
            cancelled ? '已取消订单不计 GMV 与利润' : null,
            settledCount === 0 ? '未结算，利润为预估口径（is_estimated=1）' : null,
          ]
            .filter(Boolean)
            .join('；'),
        },
        ['gross_profit_cny', 'profit_cny', 'profit_rate'],
        user.can_see_cost,
      ),
    );
  }),
);

const sampleBody = z.object({ is_sample_order: z.number().int().min(0).max(1), reason: z.string().max(200).optional() }).strict();

/** 人工纠正样品单标记：方案表 6 唯一允许人工写的订单字段，影响 GMV 口径故必须留痕 */
orderRouter.put(
  '/:id/sample',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = loadOrder(req, id);
    const body = parseBody(sampleBody, req.body);
    update('tk_order', id, { is_sample_order: body.is_sample_order });
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'tk_order',
      target_id: id,
      before: { is_sample_order: num(before.is_sample_order), gmv_cny_affected: round2(num(before.total_paid) * (num(before.rate_to_cny) || 1)) },
      after: { is_sample_order: body.is_sample_order, reason: body.reason ?? null, note: '样品单标记影响 GMV 与利润口径' },
      ip: req.ip,
    });
    ok(res, { id, is_sample_order: body.is_sample_order, tip: '样品单不计 GMV 与利润，改标记只影响统计口径，不改金额' });
  }),
);
