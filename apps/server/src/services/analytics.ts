/**
 * V2.0 分析宽表层（§15.2）：事实表 → 日粒度宽表幂等重建 + ABC/漂移/衰减分析视图。
 *
 * 口径与 aggregate.ts / profit.ts / 订单列表保持一致，三件事不许分叉：
 *  - **归日**：一律 `tz_day(时间, 店铺 timezone, 站点 region)` = 店铺 IANA 时区自然日（含夏令时）。
 *    以前这里用 `substr(order_time,1,10)`（UTC 日），而利润引擎按店铺时区归日，
 *    同一笔订单在「行动中心/宽表」和「利润报表」会落在不同天，两个页面永远对不上。
 *  - **折人民币**：一律 `toCnySql()`（当日 → 更早 → 更晚 → `FALLBACK_RATE_TO_CNY` 常量），
 *    与 JS 侧 `getRate()` 同一套规则。以前直接乘 `rateSqlExpr()`，缺汇率时表达式变 NULL，
 *    `SUM(金额 * NULL)` 会**静默少算**这一行的金额——数字看着对，实际漏了。
 *  - CANCELLED 订单与样品单（is_sample_order=1）不计 GMV；待映射行计 GMV 不计利润（宽表只有 GMV 口径）。
 *  - 广告 `ad_daily.stat_date` 已是平台侧自然日，不再二次切日（与 ads.routes.ts 同一口径）。
 *  - 事实表没有的字段（visitors/impression/click/add_cart、直播分钟数据）本服务不造数，
 *    由导入或演示 seed 回填（source 列 fact/import/mock 区分）；重建只更新事实可推导列，
 *    保证「所有分析宽表都能追溯到事实表或同步批次」（§15.4）。
 *  - 每次重建写一条 sync_log(task_type='aggregate')，失败留痕；
 *    窗口内存在「只能走兜底常量」的单据时发 alert（§6.1 汇率缺失必须可解释，不许悄悄折算）。
 */
import { all, get, insert, run, update } from '../core/db.js';
import { sendAlert } from '../core/oplog.js';
import { rateMissingExpr, todayUtc, toCnySql } from './rates.js';
import { ABC_DEFAULTS, channelOfContentType } from '@tk/shared';

type Num = number | string | bigint | null;
const n = (v: Num | undefined): number => Number(v ?? 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

const addDays = (day: string, k: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + k * 86400_000).toISOString().slice(0, 10) : day;
};
const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

void channelOfContentType; // 渠道映射在 SQL 侧内联（CH()），与 shared 保持同一语义

/** content_type(1达人视频 2达人直播 3自营视频 4自营直播 5商品卡) → 渠道；空值按有无达人归联盟/自然 */
const CH = (ct = 'i.content_type', cr = 'i.creator_id'): string =>
  `CASE WHEN ${ct} IN (1,3) THEN 'video' WHEN ${ct} IN (2,4) THEN 'live' WHEN ${ct} = 5 THEN 'product_card' WHEN ${cr} IS NOT NULL THEN 'affiliate' ELSE 'organic' END`;

/** 店铺 IANA 时区自然日；别名 s 必须是 tk_shop（tz_day 由 core/db.ts 注册，第三参是站点兜底偏移） */
const DAY = (timeCol: string, s = 's'): string => `tz_day(${timeCol}, ${s}.timezone, ${s}.region)`;
/** 与所在自然日同价的人民币金额表达式（dateCol 传 DAY(...)，保证「同一行同一价」） */
const CNY = (amount: string, currency: string, day: string): string => toCnySql(amount, currency, day);
/** 该笔单据是否只能走兜底常量（用于窗口内的汇率缺失告警计数） */
const RATE_MISSED = (currency: string, day: string): string => rateMissingExpr(currency, day);

const SHOP_JOIN = (col: string, as = 's'): string => `JOIN tk_shop ${as} ON ${as}.id = ${col} AND ${as}.is_deleted = 0`;

const ORDER_WHERE = `i.is_deleted = 0 AND o.order_status <> 'CANCELLED' AND o.is_sample_order = 0`;
const RETURN_DONE = `r.is_deleted = 0 AND r.status = 'COMPLETED'`;
/** 退款归日到申请时间（缺失时退回完成时间），与退款人民币口径同一天 */
const RETURN_DAY = (s = 's'): string => DAY(`COALESCE(r.apply_time, r.finish_time)`, s);

/** SQLite 幂等 upsert：命中部分唯一索引（WHERE is_deleted=0）则只更新事实推导列 */
function upsert(
  table: string,
  conflictCols: string,
  cols: string[],
  sets: string[],
  values: (string | number | null)[],
): number {
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(${conflictCols}) WHERE is_deleted = 0 DO UPDATE SET ${sets.join(', ')}, updated_at = datetime('now')`;
  return run(sql, ...values).changes;
}

/* ==================== 店铺 × 渠道 × 日 ==================== */

export function rebuildShopChannelDaily(start: string, end: string, userId: number | null): number {
  const merged = new Map<string, { orders: number; gmv: number; refund: number; ad_spend: number }>();
  const touch = (k: string) => {
    let v = merged.get(k);
    if (!v) merged.set(k, (v = { orders: 0, gmv: 0, refund: 0, ad_spend: 0 }));
    return v;
  };

  const dayO = DAY('o.order_time');
  const orderRows = all<{ d: string; shop_id: number; channel: string; orders: Num; gmv: Num }>(
    `SELECT ${dayO} AS d, o.shop_id AS shop_id, ${CH()} AS channel,
            COUNT(DISTINCT o.id) AS orders, ROUND(SUM(${CNY('i.item_amount', 'o.currency', dayO)}), 2) AS gmv
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       ${SHOP_JOIN('o.shop_id')}
      WHERE ${ORDER_WHERE} AND ${dayO} BETWEEN ? AND ?
      GROUP BY d, o.shop_id, channel`,
    start,
    end,
  );
  for (const r of orderRows) {
    const v = touch(`${r.d}|${r.shop_id}|${r.channel}`);
    v.orders += n(r.orders);
    v.gmv += n(r.gmv);
  }

  // 已完成退款按行级关联归回渠道与申请日；无行级关联的退款不摊（与 video 聚合同一口径）
  const dayR = RETURN_DAY();
  const refundRows = all<{ d: string; shop_id: number; channel: string; refund: Num }>(
    `SELECT ${dayR} AS d, r.shop_id AS shop_id, ${CH()} AS channel,
            ROUND(SUM(${CNY('r.refund_amount', 'r.currency', dayR)}), 2) AS refund
       FROM tk_return r
       JOIN tk_order_item i ON i.id = r.tk_order_item_id
       ${SHOP_JOIN('r.shop_id')}
      WHERE ${RETURN_DONE} AND ${dayR} BETWEEN ? AND ?
      GROUP BY d, r.shop_id, channel`,
    start,
    end,
  );
  for (const r of refundRows) touch(`${r.d}|${r.shop_id}|${r.channel}`).refund += n(r.refund);

  const adRows = all<{ d: string; shop_id: number; orders: Num; ad_spend: Num; gmv: Num }>(
    `SELECT a.stat_date AS d, a.shop_id AS shop_id, SUM(a.conversions) AS orders,
            ROUND(SUM(${CNY('a.spend', 'a.currency', 'a.stat_date')}), 2) AS ad_spend,
            ROUND(SUM(${CNY('a.gmv', 'a.currency', 'a.stat_date')}), 2) AS gmv
       FROM ad_daily a
      WHERE a.is_deleted = 0 AND a.stat_date BETWEEN ? AND ?
      GROUP BY d, a.shop_id`,
    start,
    end,
  );
  for (const r of adRows) {
    const v = touch(`${r.d}|${r.shop_id}|ads`);
    v.orders += n(r.orders);
    v.gmv += n(r.gmv);
    v.ad_spend += n(r.ad_spend);
  }

  let affected = 0;
  for (const [k, v] of merged) {
    const [d, s, c] = k.split('|');
    affected += upsert(
      'analytics_shop_channel_daily',
      'stat_date, shop_id, channel',
      ['stat_date', 'shop_id', 'channel', 'orders', 'gmv', 'refund', 'net_gmv', 'ad_spend', 'source', 'created_by'],
      [
        'orders = excluded.orders',
        'gmv = excluded.gmv',
        'refund = excluded.refund',
        'net_gmv = excluded.gmv - excluded.refund',
        'ad_spend = excluded.ad_spend',
      ],
      [d, Number(s), c, v.orders, r2(v.gmv), r2(v.refund), r2(v.gmv - v.refund), r2(v.ad_spend), 'fact', userId],
    );
  }
  return affected;
}

/* ==================== 商品(SPU) × 渠道 × 日 ==================== */

export function rebuildProductChannelDaily(start: string, end: string, userId: number | null): number {
  const merged = new Map<string, { shop_id: number; orders: number; gmv: number; refund: number }>();
  const touch = (k: string, shopId: number) => {
    let v = merged.get(k);
    if (!v) merged.set(k, (v = { shop_id: shopId, orders: 0, gmv: 0, refund: 0 }));
    return v;
  };

  const dayO = DAY('o.order_time');
  const orderRows = all<{ d: string; shop_id: number; spu_id: number; channel: string; orders: Num; gmv: Num }>(
    `SELECT ${dayO} AS d, o.shop_id AS shop_id, k.spu_id AS spu_id, ${CH()} AS channel,
            COUNT(DISTINCT o.id) AS orders, ROUND(SUM(${CNY('i.item_amount', 'o.currency', dayO)}), 2) AS gmv
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       ${SHOP_JOIN('o.shop_id')}
       JOIN shop_listing l ON l.id = i.listing_id
       JOIN product_sku k ON k.id = l.sku_id
      WHERE ${ORDER_WHERE} AND k.spu_id IS NOT NULL AND ${dayO} BETWEEN ? AND ?
      GROUP BY d, o.shop_id, k.spu_id, channel`,
    start,
    end,
  );
  for (const r of orderRows) {
    const v = touch(`${r.d}|${r.spu_id}|${r.channel}`, Number(r.shop_id));
    v.orders += n(r.orders);
    v.gmv += n(r.gmv);
  }

  const dayR = RETURN_DAY();
  const refundRows = all<{ d: string; shop_id: number; spu_id: number; channel: string; refund: Num }>(
    `SELECT ${dayR} AS d, r.shop_id AS shop_id, k.spu_id AS spu_id, ${CH()} AS channel,
            ROUND(SUM(${CNY('r.refund_amount', 'r.currency', dayR)}), 2) AS refund
       FROM tk_return r
       JOIN tk_order_item i ON i.id = r.tk_order_item_id
       ${SHOP_JOIN('r.shop_id')}
       JOIN shop_listing l ON l.id = i.listing_id
       JOIN product_sku k ON k.id = l.sku_id
      WHERE ${RETURN_DONE} AND k.spu_id IS NOT NULL
        AND ${dayR} BETWEEN ? AND ?
      GROUP BY d, r.shop_id, k.spu_id, channel`,
    start,
    end,
  );
  for (const r of refundRows) touch(`${r.d}|${r.spu_id}|${r.channel}`, Number(r.shop_id)).refund += n(r.refund);

  let affected = 0;
  for (const [k, v] of merged) {
    const [d, spu, c] = k.split('|');
    affected += upsert(
      'analytics_product_channel_daily',
      'stat_date, spu_id, channel',
      ['stat_date', 'shop_id', 'spu_id', 'channel', 'orders', 'gmv', 'refund', 'net_gmv', 'source', 'created_by'],
      [
        'shop_id = excluded.shop_id',
        'orders = excluded.orders',
        'gmv = excluded.gmv',
        'refund = excluded.refund',
        'net_gmv = excluded.gmv - excluded.refund',
      ],
      [d, v.shop_id, Number(spu), c, v.orders, r2(v.gmv), r2(v.refund), r2(v.gmv - v.refund), 'fact', userId],
    );
  }
  return affected;
}

/* ==================== 达人 × 日 ==================== */

export function rebuildCreatorDaily(start: string, end: string, userId: number | null): number {
  const merged = new Map<string, { shop_id: number | null; orders: number; gmv: number; refund: number; commission: number; sample_cost: number }>();
  const touch = (k: string) => {
    let v = merged.get(k);
    if (!v) merged.set(k, (v = { shop_id: null, orders: 0, gmv: 0, refund: 0, commission: 0, sample_cost: 0 }));
    return v;
  };

  const dayO = DAY('o.order_time');
  const orderRows = all<{ d: string; creator_id: number; shop_id: number; orders: Num; gmv: Num; commission: Num }>(
    `SELECT ${dayO} AS d, i.creator_id AS creator_id, MIN(o.shop_id) AS shop_id,
            COUNT(DISTINCT o.id) AS orders, ROUND(SUM(${CNY('i.item_amount', 'o.currency', dayO)}), 2) AS gmv,
            ROUND(SUM(${CNY('i.est_commission', 'o.currency', dayO)}), 2) AS commission
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       ${SHOP_JOIN('o.shop_id')}
      WHERE ${ORDER_WHERE} AND i.creator_id IS NOT NULL AND ${dayO} BETWEEN ? AND ?
      GROUP BY d, i.creator_id`,
    start,
    end,
  );
  for (const r of orderRows) {
    const v = touch(`${r.d}|${r.creator_id}`);
    v.shop_id = Number(r.shop_id);
    v.orders += n(r.orders);
    v.gmv += n(r.gmv);
    v.commission += n(r.commission);
  }

  const dayR = RETURN_DAY();
  const refundRows = all<{ d: string; creator_id: number; refund: Num }>(
    `SELECT ${dayR} AS d, i.creator_id AS creator_id,
            ROUND(SUM(${CNY('r.refund_amount', 'r.currency', dayR)}), 2) AS refund
       FROM tk_return r
       JOIN tk_order_item i ON i.id = r.tk_order_item_id
       ${SHOP_JOIN('r.shop_id')}
      WHERE ${RETURN_DONE} AND i.creator_id IS NOT NULL
        AND ${dayR} BETWEEN ? AND ?
      GROUP BY d, i.creator_id`,
    start,
    end,
  );
  for (const r of refundRows) touch(`${r.d}|${r.creator_id}`).refund += n(r.refund);

  // 寄样成本（sample_cost/shipping_cost 落库即人民币快照），按发货日归集；
  // 有合作单时按合作店铺时区归日，没有合作单退化成 UTC 日（没有店铺可参照）
  const dayS = DAY('sm.ship_time');
  const sampleRows = all<{ d: string; creator_id: number; c: Num }>(
    `SELECT ${dayS} AS d, sm.creator_id AS creator_id,
            ROUND(SUM(sm.sample_cost + sm.shipping_cost), 2) AS c
       FROM sample_shipment sm
       LEFT JOIN collaboration c ON c.id = sm.collab_id
       LEFT JOIN tk_shop s ON s.id = c.shop_id
      WHERE sm.is_deleted = 0 AND sm.ship_time IS NOT NULL AND ${dayS} BETWEEN ? AND ?
      GROUP BY d, sm.creator_id`,
    start,
    end,
  );
  for (const r of sampleRows) touch(`${r.d}|${r.creator_id}`).sample_cost += n(r.c);

  let affected = 0;
  for (const [k, v] of merged) {
    const [d, cid] = k.split('|');
    affected += upsert(
      'analytics_creator_daily',
      'stat_date, creator_id',
      ['stat_date', 'creator_id', 'shop_id', 'orders', 'gmv', 'refund', 'net_gmv', 'commission', 'sample_cost', 'source', 'created_by'],
      [
        'shop_id = COALESCE(excluded.shop_id, analytics_creator_daily.shop_id)',
        'orders = excluded.orders',
        'gmv = excluded.gmv',
        'refund = excluded.refund',
        'net_gmv = excluded.gmv - excluded.refund',
        'commission = excluded.commission',
        'sample_cost = excluded.sample_cost',
      ],
      [d, Number(cid), v.shop_id, v.orders, r2(v.gmv), r2(v.refund), r2(v.gmv - v.refund), r2(v.commission), r2(v.sample_cost), 'fact', userId],
    );
  }
  return affected;
}

/* ==================== 视频 × 日 ==================== */

export function rebuildVideoDaily(start: string, end: string, userId: number | null): number {
  const merged = new Map<string, { orders: number; gmv: number; refund: number; ad_spend: number }>();
  const touch = (k: string) => {
    let v = merged.get(k);
    if (!v) merged.set(k, (v = { orders: 0, gmv: 0, refund: 0, ad_spend: 0 }));
    return v;
  };

  const dayO = DAY('o.order_time');
  const orderRows = all<{ d: string; video_id: number; orders: Num; gmv: Num }>(
    `SELECT ${dayO} AS d, v.id AS video_id,
            COUNT(DISTINCT o.id) AS orders, ROUND(SUM(${CNY('i.item_amount', 'o.currency', dayO)}), 2) AS gmv
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       ${SHOP_JOIN('o.shop_id')}
       JOIN video v ON v.tk_video_id = i.content_id AND v.is_deleted = 0
      WHERE ${ORDER_WHERE} AND i.content_type IN (1, 3)
        AND ${dayO} BETWEEN ? AND ?
      GROUP BY d, v.id`,
    start,
    end,
  );
  for (const r of orderRows) {
    const v = touch(`${r.d}|${r.video_id}`);
    v.orders += n(r.orders);
    v.gmv += n(r.gmv);
  }

  const dayR = RETURN_DAY();
  const refundRows = all<{ d: string; video_id: number; refund: Num }>(
    `SELECT ${dayR} AS d, v.id AS video_id,
            ROUND(SUM(${CNY('r.refund_amount', 'r.currency', dayR)}), 2) AS refund
       FROM tk_return r
       JOIN tk_order_item i ON i.id = r.tk_order_item_id
       ${SHOP_JOIN('r.shop_id')}
       JOIN video v ON v.tk_video_id = i.content_id AND v.is_deleted = 0
      WHERE ${RETURN_DONE} AND i.content_type IN (1, 3)
        AND ${dayR} BETWEEN ? AND ?
      GROUP BY d, v.id`,
    start,
    end,
  );
  for (const r of refundRows) touch(`${r.d}|${r.video_id}`).refund += n(r.refund);

  const adRows = all<{ d: string; video_id: number; ad_spend: Num }>(
    `SELECT a.stat_date AS d, a.video_id AS video_id, ROUND(SUM(${CNY('a.spend', 'a.currency', 'a.stat_date')}), 2) AS ad_spend
       FROM ad_daily a
      WHERE a.is_deleted = 0 AND a.ad_type = 3 AND a.video_id IS NOT NULL AND a.stat_date BETWEEN ? AND ?
      GROUP BY d, a.video_id`,
    start,
    end,
  );
  for (const r of adRows) touch(`${r.d}|${r.video_id}`).ad_spend += n(r.ad_spend);

  let affected = 0;
  for (const [k, v] of merged) {
    const [d, vid] = k.split('|');
    affected += upsert(
      'analytics_video_daily',
      'stat_date, video_id',
      ['stat_date', 'video_id', 'orders', 'gmv', 'refund', 'net_gmv', 'ad_spend', 'source', 'created_by'],
      [
        'orders = excluded.orders',
        'gmv = excluded.gmv',
        'refund = excluded.refund',
        'net_gmv = excluded.gmv - excluded.refund',
        'ad_spend = excluded.ad_spend',
      ],
      // views / product_click 非事实可推导，保留导入或 seed 值不覆盖
      [d, Number(vid), v.orders, r2(v.gmv), r2(v.refund), r2(v.gmv - v.refund), r2(v.ad_spend), 'fact', userId],
    );
  }
  return affected;
}

/* ==================== 重建入口（调度器 / 同步页共用） ==================== */

/**
 * 窗口内「exchange_rate 查不到当天价、只能走兜底常量」的单据数。
 * PRD §6.1 要求汇率缺失可解释：宁可报出来让人补价，也不能让金额静默变形。
 */
export function countRateFallbacks(start: string, end: string): number {
  const dayO = DAY('o.order_time');
  const dayR = RETURN_DAY();
  const count = (sql: string): number => Number(get<{ c: Num }>(sql, start, end)?.c ?? 0);
  const orders = count(
    `SELECT COUNT(*) AS c FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
       ${SHOP_JOIN('o.shop_id')}
      WHERE ${ORDER_WHERE} AND ${dayO} BETWEEN ? AND ? AND ${RATE_MISSED('o.currency', dayO)}`,
  );
  const refunds = count(
    `SELECT COUNT(*) AS c FROM tk_return r
       JOIN tk_order_item i ON i.id = r.tk_order_item_id
       ${SHOP_JOIN('r.shop_id')}
      WHERE ${RETURN_DONE} AND ${dayR} BETWEEN ? AND ? AND ${RATE_MISSED('r.currency', dayR)}`,
  );
  const ads = count(`SELECT COUNT(*) AS c FROM ad_daily a WHERE a.is_deleted = 0 AND a.stat_date BETWEEN ? AND ? AND ${RATE_MISSED('a.currency', 'a.stat_date')}`);
  return orders + refunds + ads;
}

export interface RebuildOutcome {
  task: 'analytics';
  affected: number;
  window: { start: string; end: string };
  sync_log_id: number;
  /** 走兜底汇率的单据数（>0 时同步发 ALERT，提示去汇率页补价后重跑） */
  rate_fallback_rows: number;
}

export function rebuildAnalytics(user: { id?: number } | null = null, range: { start?: string; end?: string } = {}): RebuildOutcome {
  const end = range.end ?? todayUtc();
  const start = range.start ?? addDays(end, -400);
  const userId = user?.id ?? null;
  const logId = insert('sync_log', {
    task_type: 'aggregate',
    shop_id: null,
    window_start: start,
    window_end: end,
    started_at: stamp(),
    created_by: userId,
  });
  try {
    const affected =
      rebuildShopChannelDaily(start, end, userId) +
      rebuildProductChannelDaily(start, end, userId) +
      rebuildCreatorDaily(start, end, userId) +
      rebuildVideoDaily(start, end, userId);
    const fallback = countRateFallbacks(start, end);
    if (fallback > 0) {
      sendAlert({
        level: 'warn',
        title: `宽表有 ${fallback} 笔单据缺当日汇率，已按兜底常量折算`,
        detail: `窗口 ${start}~${end}：这些行的人民币金额用的是 FALLBACK_RATE_TO_CNY 常量而不是当日牌价，请在汇率页补录后重跑「派生汇总刷新」。`,
      });
    }
    update('sync_log', logId, { updated: affected, status: fallback > 0 ? 2 : 1, failed: fallback, finished_at: stamp() } as never);
    return { task: 'analytics', affected, window: { start, end }, sync_log_id: logId, rate_fallback_rows: fallback };
  } catch (e) {
    update('sync_log', logId, { failed: 1, status: 3, error_msg: (e as Error).message, finished_at: stamp() } as never);
    throw e;
  }
}

/* ==================== 分析视图：ABC 分层 / 渠道漂移 / 漏斗 ==================== */

/** ABC 阈值可在字典（dict_type='abc'，dict_value=a/b）配置，默认 80%/95%（§6.1 不得写死） */
export function getAbcThresholds(): { a: number; b: number } {
  const rows = all<{ dict_value: string; dict_label: string }>(
    `SELECT dict_value, dict_label FROM sys_dict WHERE dict_type = 'abc' AND is_deleted = 0 AND status = 1`,
  );
  const m: Record<string, number> = {};
  for (const r of rows) m[r.dict_value] = Number(r.dict_label);
  return {
    a: Number.isFinite(m.a) && m.a > 0 && m.a < 1 ? m.a : ABC_DEFAULTS.a_cum_share,
    b: Number.isFinite(m.b) && m.b > 0 && m.b <= 1 ? m.b : ABC_DEFAULTS.b_cum_share,
  };
}

export interface AbcRow {
  spu_id: number;
  spu_code: string;
  spu_name: string;
  category: string | null;
  net_gmv: number;
  share: number;
  cum_share: number;
  tier: 'A' | 'B' | 'C';
  channel_shares: Record<string, number>;
  max_channel: string | null;
  max_channel_share: number;
  hhi: number;
  /** 渠道占比 vs 上一等长窗口的变化（小数，正=占比上升） */
  share_delta: Record<string, number>;
  funnel: { impression: number; click: number; add_cart: number; orders: number; worst_stage: string | null };
}

const spanDays = (start: string, end: string): number =>
  Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1);

function channelAgg(start: string, end: string, shopId?: number | null): Map<number, { total: number; ch: Map<string, number>; imp: number; clk: number; cart: number; ord: number }> {
  const where = shopId ? 'AND t.shop_id = ?' : '';
  const rows = all<{ spu_id: number; channel: string; ng: Num; imp: Num; clk: Num; cart: Num; ord: Num }>(
    `SELECT t.spu_id, t.channel, SUM(t.net_gmv) AS ng, SUM(t.impression) AS imp, SUM(t.click) AS clk, SUM(t.add_cart) AS cart, SUM(t.orders) AS ord
       FROM analytics_product_channel_daily t
      WHERE t.is_deleted = 0 AND t.stat_date BETWEEN ? AND ? ${where}
      GROUP BY t.spu_id, t.channel`,
    ...(shopId ? [start, end, shopId] : [start, end]),
  );
  const m = new Map<number, { total: number; ch: Map<string, number>; imp: number; clk: number; cart: number; ord: number }>();
  for (const r of rows) {
    let v = m.get(Number(r.spu_id));
    if (!v) m.set(Number(r.spu_id), (v = { total: 0, ch: new Map(), imp: 0, clk: 0, cart: 0, ord: 0 }));
    const ng = n(r.ng);
    v.total += ng;
    v.ch.set(r.channel, (v.ch.get(r.channel) ?? 0) + ng);
    v.imp += n(r.imp);
    v.clk += n(r.clk);
    v.cart += n(r.cart);
    v.ord += n(r.ord);
  }
  return m;
}

/** 漏斗最异常段：三段转化率与全体 SPU 均值比，相对偏差最大（负向）的一段 */
function worstFunnelStage(f: { imp: number; clk: number; cart: number; ord: number }, avg: { ctr: number; cartRate: number; cvr: number }): string | null {
  const ctr = f.imp > 0 ? f.clk / f.imp : null;
  const cartRate = f.clk > 0 ? f.cart / f.clk : null;
  const cvr = f.cart > 0 ? f.ord / f.cart : null;
  const devs: [string, number][] = [];
  if (ctr !== null && avg.ctr > 0) devs.push(['曝光→点击', ctr / avg.ctr - 1]);
  if (cartRate !== null && avg.cartRate > 0) devs.push(['点击→加购', cartRate / avg.cartRate - 1]);
  if (cvr !== null && avg.cvr > 0) devs.push(['加购→下单', cvr / avg.cvr - 1]);
  if (!devs.length) return null;
  devs.sort((a, b) => a[1] - b[1]);
  return devs[0][1] < 0 ? devs[0][0] : null;
}

export function abcAnalysis(opts: { start: string; end: string; shopId?: number | null }): AbcRow[] {
  const { start, end } = opts;
  const th = getAbcThresholds();
  const cur = channelAgg(start, end, opts.shopId);
  const days = spanDays(start, end);
  const prev = channelAgg(addDays(start, -days), addDays(start, -1), opts.shopId);

  const spus = all<{ id: number; spu_code: string; name_cn: string; category: string | null }>(
    `SELECT id, spu_code, name_cn, category FROM product_spu WHERE is_deleted = 0`,
  );
  const spuInfo = new Map(spus.map((s) => [Number(s.id), s]));

  // 全体均值（漏斗对比基准）
  let tImp = 0, tClk = 0, tCart = 0, tOrd = 0;
  for (const v of cur.values()) { tImp += v.imp; tClk += v.clk; tCart += v.cart; tOrd += v.ord; }
  const avg = { ctr: tImp > 0 ? tClk / tImp : 0, cartRate: tClk > 0 ? tCart / tClk : 0, cvr: tCart > 0 ? tOrd / tCart : 0 };

  const grand = [...cur.values()].reduce((a, v) => a + Math.max(0, v.total), 0);
  const rows: AbcRow[] = [...cur.entries()]
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([spuId, v]) => {
      const info = spuInfo.get(spuId);
      const channelShares: Record<string, number> = {};
      let maxCh: string | null = null;
      let maxShare = 0;
      let hhi = 0;
      for (const [c, ng] of v.ch) {
        const share = v.total > 0 ? Math.max(0, ng) / v.total : 0;
        channelShares[c] = r2(share * 10000) / 10000;
        hhi += share * share;
        if (share > maxShare) { maxShare = share; maxCh = c; }
      }
      const prevV = prev.get(spuId);
      const shareDelta: Record<string, number> = {};
      if (prevV && prevV.total > 0) {
        for (const c of new Set([...v.ch.keys(), ...prevV.ch.keys()])) {
          const now = v.total > 0 ? Math.max(0, v.ch.get(c) ?? 0) / v.total : 0;
          const before = Math.max(0, prevV.ch.get(c) ?? 0) / prevV.total;
          shareDelta[c] = r2((now - before) * 10000) / 10000;
        }
      }
      return {
        spu_id: spuId,
        spu_code: info?.spu_code ?? `SPU${spuId}`,
        spu_name: info?.name_cn ?? `SPU ${spuId}`,
        category: info?.category ?? null,
        net_gmv: r2(v.total),
        share: grand > 0 ? v.total / grand : 0,
        cum_share: 0,
        tier: 'C' as 'A' | 'B' | 'C',
        channel_shares: channelShares,
        max_channel: maxCh,
        max_channel_share: r2(maxShare * 10000) / 10000,
        hhi: r2(hhi * 10000) / 10000,
        share_delta: shareDelta,
        funnel: {
          impression: v.imp,
          click: v.clk,
          add_cart: v.cart,
          orders: v.ord,
          worst_stage: worstFunnelStage({ imp: v.imp, clk: v.clk, cart: v.cart, ord: v.ord }, avg),
        },
      };
    });

  let cum = 0;
  for (const r of rows) {
    cum += r.share;
    r.cum_share = r2(cum * 10000) / 10000;
    r.tier = r.cum_share <= th.a || (r.cum_share - r.share) < th.a ? 'A' : r.cum_share <= th.b || (r.cum_share - r.share) < th.b ? 'B' : 'C';
  }
  return rows;
}

/* ==================== 规则引擎用的扫描视图 ==================== */

export interface ProductChannelScan {
  spu_id: number;
  spu_name: string;
  shop_id: number | null;
  max_channel: string | null;
  max_share: number;
  prev_max_share: number;
  rising: boolean;
  /** 周环比变化绝对值最大的渠道与其变化量 */
  drift_channel: string | null;
  drift_delta: number;
  /** 上架天数（product_spu.created_at 起算） */
  days_since_launch: number;
  net_gmv: number;
  orders: number;
  has_interaction: boolean;
}

/** 商品渠道扫描：依赖度 / 漂移 / 新品期，一次算完给规则引擎 */
export function scanProductChannels(end = todayUtc(), windowDays = 7): ProductChannelScan[] {
  const start = addDays(end, -(windowDays - 1));
  const days = windowDays;
  const cur = channelAgg(start, end);
  const prev = channelAgg(addDays(start, -days), addDays(start, -1));
  const spus = all<{ id: number; name_cn: string; created_at: string }>(
    `SELECT id, name_cn, created_at FROM product_spu WHERE is_deleted = 0`,
  );
  const info = new Map(spus.map((s) => [Number(s.id), s]));
  const out: ProductChannelScan[] = [];
  for (const [spuId, v] of cur) {
    if (v.total <= 0) continue;
    const s = info.get(spuId);
    let maxCh: string | null = null;
    let maxShare = 0;
    for (const [c, ng] of v.ch) {
      const share = Math.max(0, ng) / v.total;
      if (share > maxShare) { maxShare = share; maxCh = c; }
    }
    const p = prev.get(spuId);
    let prevMaxShare = 0;
    let driftCh: string | null = null;
    let driftDelta = 0;
    if (p && p.total > 0) {
      for (const [c, ng] of p.ch) prevMaxShare = Math.max(prevMaxShare, Math.max(0, ng) / p.total);
      for (const c of new Set([...v.ch.keys(), ...p.ch.keys()])) {
        const now = Math.max(0, v.ch.get(c) ?? 0) / v.total;
        const before = Math.max(0, p.ch.get(c) ?? 0) / p.total;
        if (Math.abs(now - before) > Math.abs(driftDelta)) { driftDelta = now - before; driftCh = c; }
      }
    }
    const launchedMs = s?.created_at ? Date.parse(String(s.created_at).replace(' ', 'T') + 'Z') : NaN;
    out.push({
      spu_id: spuId,
      spu_name: s?.name_cn ?? `SPU ${spuId}`,
      shop_id: null,
      max_channel: maxCh,
      max_share: maxShare,
      prev_max_share: prevMaxShare,
      rising: maxShare > prevMaxShare,
      drift_channel: driftCh,
      drift_delta: driftDelta,
      days_since_launch: Number.isFinite(launchedMs) ? Math.floor((Date.parse(`${end}T00:00:00Z`) - launchedMs) / 86400_000) : 9999,
      net_gmv: r2(v.total),
      orders: v.ord,
      has_interaction: v.ord > 0 || v.clk > 0 || v.cart > 0,
    });
  }
  return out;
}

export interface CreatorTrendScan {
  creator_id: number;
  creator_name: string;
  /** 近 N 周净 GMV（旧→新） */
  weekly_net_gmv: number[];
  decline_weeks: number;
  refund_rate: number;
  net_gmv_30d: number;
  sample_cost_30d: number;
  sample_roi: number | null;
}

/** 达人趋势扫描：连续下滑周数 / 退货率 / 样品 ROI（净 GMV ÷（样品成本+运费），附录 A） */
export function scanCreatorTrends(end = todayUtc(), weeks = 4): CreatorTrendScan[] {
  const start = addDays(end, -(weeks * 7 - 1));
  const rows = all<{ creator_id: number; d: string; net_gmv: Num }>(
    `SELECT creator_id, stat_date AS d, net_gmv FROM analytics_creator_daily
      WHERE is_deleted = 0 AND stat_date BETWEEN ? AND ?`,
    start,
    end,
  );
  const byCreator = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byCreator.get(Number(r.creator_id)) ?? Array<number>(weeks).fill(0);
    byCreator.set(Number(r.creator_id), arr);
    const wIdx = Math.min(weeks - 1, Math.floor((Date.parse(`${r.d}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (7 * 86400_000)));
    arr[wIdx] += n(r.net_gmv);
  }
  const stat30 = all<{ creator_id: number; net_gmv: Num; refund: Num; gmv: Num; sample_cost: Num }>(
    `SELECT creator_id, SUM(net_gmv) AS net_gmv, SUM(refund) AS refund, SUM(gmv) AS gmv, SUM(sample_cost) AS sample_cost
       FROM analytics_creator_daily WHERE is_deleted = 0 AND stat_date BETWEEN ? AND ? GROUP BY creator_id`,
    addDays(end, -29),
    end,
  );
  const s30 = new Map(stat30.map((r) => [Number(r.creator_id), r]));
  const names = all<{ id: number; handle: string; nickname: string | null }>(
    `SELECT id, handle, nickname FROM creator WHERE is_deleted = 0`,
  );
  const nameOf = new Map(names.map((c) => [Number(c.id), c.nickname || c.handle]));
  const out: CreatorTrendScan[] = [];
  for (const [cid, weekly] of byCreator) {
    let decline = 0;
    for (let i = weekly.length - 1; i > 0; i--) {
      if (weekly[i] < weekly[i - 1]) decline += 1;
      else break;
    }
    const s = s30.get(cid);
    const gmv30 = n(s?.gmv);
    const refundRate = gmv30 > 0 ? n(s?.refund) / gmv30 : 0;
    const sampleCost = n(s?.sample_cost);
    out.push({
      creator_id: cid,
      creator_name: nameOf.get(cid) ?? `达人${cid}`,
      weekly_net_gmv: weekly.map(r2),
      decline_weeks: decline,
      refund_rate: r2(refundRate * 10000) / 10000,
      net_gmv_30d: r2(n(s?.net_gmv)),
      sample_cost_30d: r2(sampleCost),
      sample_roi: sampleCost > 0 ? r2((n(s?.net_gmv) / sampleCost) * 100) / 100 : null,
    });
  }
  return out;
}

export interface VideoDecayScan {
  video_id: number;
  video_url: string;
  /** 最近 3 日移动平均净 GMV */
  ma3: number;
  /** 近 7 日日净 GMV 峰值 */
  peak7: number;
  ratio: number;
  /** ma3 连续下降的周期数（当前 vs 前一周期） */
  consecutive: number;
  net_gmv_7d: number;
}

/** 视频衰减扫描（§8 默认算法：3 日均值 vs 7 日峰值，连续 2 期下降；阈值由规则中心传入） */
export function scanVideoDecay(end = todayUtc()): VideoDecayScan[] {
  const start = addDays(end, -13);
  const rows = all<{ video_id: number; d: string; net_gmv: Num }>(
    `SELECT video_id, stat_date AS d, net_gmv FROM analytics_video_daily
      WHERE is_deleted = 0 AND stat_date BETWEEN ? AND ?`,
    start,
    end,
  );
  const byVideo = new Map<number, Map<string, number>>();
  for (const r of rows) {
    let m = byVideo.get(Number(r.video_id));
    if (!m) byVideo.set(Number(r.video_id), (m = new Map()));
    m.set(r.d, (m.get(r.d) ?? 0) + n(r.net_gmv));
  }
  const ma3Of = (m: Map<string, number>, endDay: string): number => {
    let s = 0;
    for (let i = 0; i < 3; i++) s += m.get(addDays(endDay, -i)) ?? 0;
    return s / 3;
  };
  const urls = all<{ id: number; video_url: string }>(`SELECT id, video_url FROM video WHERE is_deleted = 0`);
  const urlOf = new Map(urls.map((v) => [Number(v.id), v.video_url]));
  const out: VideoDecayScan[] = [];
  for (const [vid, m] of byVideo) {
    const ma3 = ma3Of(m, end);
    const prevMa3 = ma3Of(m, addDays(end, -3));
    let peak7 = 0;
    let net7 = 0;
    for (let i = 0; i < 7; i++) {
      const v = m.get(addDays(end, -i)) ?? 0;
      peak7 = Math.max(peak7, v);
      net7 += v;
    }
    if (peak7 <= 0) continue;
    out.push({
      video_id: vid,
      video_url: urlOf.get(vid) ?? '',
      ma3: r2(ma3),
      peak7: r2(peak7),
      ratio: r2((ma3 / peak7) * 10000) / 10000,
      consecutive: ma3 < prevMa3 ? 2 : 1,
      net_gmv_7d: r2(net7),
    });
  }
  return out;
}

/** 店铺渠道结构（店铺页顶部堆叠图 / 渠道漂移）：按周聚合占比与环比 */
export function shopChannelStructure(opts: { end?: string; shopId?: number | null; weeks?: number } = {}) {
  const end = opts.end ?? todayUtc();
  const weeks = opts.weeks ?? 8;
  const start = addDays(end, -(weeks * 7 - 1));
  const where = opts.shopId ? 'AND shop_id = ?' : '';
  const rows = all<{ d: string; channel: string; net_gmv: Num; gmv: Num; orders: Num; ad_spend: Num }>(
    `SELECT stat_date AS d, channel, net_gmv, gmv, orders, ad_spend FROM analytics_shop_channel_daily
      WHERE is_deleted = 0 AND stat_date BETWEEN ? AND ? ${where} ORDER BY stat_date`,
    ...(opts.shopId ? [start, end, opts.shopId] : [start, end]),
  );
  const weekly = new Map<string, Map<string, { net_gmv: number; gmv: number; orders: number; ad_spend: number }>>();
  for (const r of rows) {
    // ISO 周键：以周一为起点
    const t = Date.parse(`${r.d}T00:00:00Z`);
    const monday = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400_000).toISOString().slice(0, 10);
    let wk = weekly.get(monday);
    if (!wk) weekly.set(monday, (wk = new Map()));
    let c = wk.get(r.channel);
    if (!c) wk.set(r.channel, (c = { net_gmv: 0, gmv: 0, orders: 0, ad_spend: 0 }));
    c.net_gmv += n(r.net_gmv);
    c.gmv += n(r.gmv);
    c.orders += n(r.orders);
    c.ad_spend += n(r.ad_spend);
  }
  return [...weekly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, ch]) => {
      const total = [...ch.values()].reduce((a, v) => a + v.net_gmv, 0);
      const shares: Record<string, number> = {};
      for (const [c, v] of ch) shares[c] = total > 0 ? r2((v.net_gmv / total) * 10000) / 10000 : 0;
      return { week, total_net_gmv: r2(total), channels: Object.fromEntries([...ch].map(([c, v]) => [c, { ...v, net_gmv: r2(v.net_gmv), gmv: r2(v.gmv), ad_spend: r2(v.ad_spend) }])), shares };
    });
}

/** 直播分钟曲线（页面直读；数据来自导入或 seed，本服务不造数） */
export function liveMinutes(liveSessionId: number) {
  return all(
    `SELECT minute_ts, online_users, product_click, orders, gmv, paid_traffic_ratio, source
       FROM analytics_live_minute WHERE is_deleted = 0 AND live_session_id = ? ORDER BY minute_ts`,
    liveSessionId,
  );
}


