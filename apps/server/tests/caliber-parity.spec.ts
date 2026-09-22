/**
 * 口径同源回归（#28 宽表 + #30 汇率/退款）
 *
 * 这一组是「同一个数在两个页面不一样」的守门用例，三条分叉都各有针对性：
 *  1. 宽表归日必须跟利润引擎一样按**店铺 IANA 时区**切自然日 —— 以前宽表用 substr(order_time,1,10)（UTC 日），
 *     一笔夏令时边界上的订单会同时出现在「行动中心 6/30」和「利润报表 7/1」。
 *  2. 缺汇率时金额不能被静默吞掉 —— 以前宽表乘的是裸 rateSqlExpr()，NULL 使 SUM 少算这一行；
 *     现在统一走 rateToCnyExpr / toCnySql（当日 → 更早 → 更晚 → 兜底常量），并要求可解释（rate_fallback_rows）。
 *  3. 净 GMV 只扣「已完成」退款 —— 以前 PROCESSING / REJECTED 也算退款，售后一关单历史数字就自己变大。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get, insert, run } from '../src/core/db.js';
import { countRateFallbacks, rebuildAnalytics, rebuildShopChannelDaily } from '../src/services/analytics.js';
import { AMOUNT_CNY, ATTRIBUTABLE_ORDER, RATE_JOIN, REFUND_JOIN } from '../src/services/creator/roi.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

const LA = 'America/Los_Angeles';
let ctx: ReturnType<typeof boot>;
let bossId = 0;
let shopId = 0;
const token: Record<string, string> = {};

/** 造一笔带单明细的订单，返回订单号与该明细行号 */
function makeOrder(opts: { time: string; currency: string; amount: number; tag: string }): number {
  const oid = insert('tk_order', {
    shop_id: shopId,
    tk_order_id: `CAL-${opts.tag}`,
    order_status: 'COMPLETED',
    order_time: opts.time,
    currency: opts.currency,
    total_paid: opts.amount,
    is_sample_order: 0,
  });
  insert('tk_order_item', {
    order_id: oid,
    item_amount: opts.amount,
    quantity: 1,
    unit_price: opts.amount,
    cost_matched: 1,
    cost_snapshot: 0,
    est_commission: 0,
  });
  return oid;
}

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(ctx.http, u);
  bossId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.boss)?.id ?? 0);
  // 汇率表里彻底清空 VND：让「兜底常量」这一档必然被走到，两个页面只能靠同一套规则对齐
  run(`DELETE FROM exchange_rate WHERE currency = 'VND'`);
  shopId = insert('tk_shop', {
    shop_name: 'Caliber Probe Store',
    region: 'US',
    currency: 'USD',
    timezone: LA,
    shop_type: 1,
    auth_status: 1,
    status: 1,
    owner_id: bossId,
  });
});

describe('宽表归日与利润引擎同源（店铺 IANA 时区，含夏令时）', () => {
  it('夏令时边界订单：UTC 06:30 属于洛杉矶的昨天，宽表不能记成 UTC 日', () => {
    makeOrder({ time: '2026-07-01 06:30:00', currency: 'USD', amount: 100, tag: 'DST' });
    const affected = rebuildShopChannelDaily('2026-06-25', '2026-07-05', bossId);
    expect(affected).toBeGreaterThan(0);

    const rows = ctx.db
      .prepare(`SELECT stat_date, gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND shop_id = ? AND channel <> 'ads'`)
      .all(shopId) as { stat_date: string; gmv: number }[];
    const days = rows.map((r) => r.stat_date);
    expect(days).toContain('2026-06-30');
    expect(days).not.toContain('2026-07-01');
  });

  it('同一笔订单：宽表 GMV 与订单汇总 by_day 落在同一天、同一个数', async () => {
    makeOrder({ time: '2026-08-05 06:30:00', currency: 'VND', amount: 1_000_000, tag: 'PARITY' });
    rebuildShopChannelDaily('2026-08-01', '2026-08-10', bossId);

    const wide = get<{ d: string; gmv: number }>(
      `SELECT stat_date AS d, gmv FROM analytics_shop_channel_daily
        WHERE is_deleted = 0 AND shop_id = ? AND channel <> 'ads' AND stat_date BETWEEN '2026-08-01' AND '2026-08-10'
        ORDER BY stat_date DESC LIMIT 1`,
      shopId,
    );
    const laDay = '2026-08-04'; // 06:30 UTC = 洛杉矶 08-04 23:30（PDT = UTC-7）
    expect(wide?.d).toBe(laDay);

    // 订单汇总接口的 by_day（tz_day 口径）必须与宽表同日同数
    const sum = dataOf<{ by_day: { stat_date: string; gmv_cny: number }[] }>(
      (await ctx.http.get(`/api/orders/summary?shop_id=${shopId}&order_time_from=2026-08-01&order_time_to=2026-08-10`).set(auth(token.boss))).body,
    );
    const dayRow = sum.by_day.find((r) => r.stat_date === laDay);
    expect(dayRow, `订单汇总里没有 ${laDay} 这一天，说明两个口径又分叉了`).toBeTruthy();
    expect(Number(dayRow?.gmv_cny)).toBeCloseTo(1000000 * 0.00029, 2); // VND 兜底常量
    expect(Math.abs(Number(dayRow?.gmv_cny) - Number(wide?.gmv))).toBeLessThan(0.01);
  });
});

describe('缺汇率不再静默吞金额', () => {
  it('宽表：币种既无当日价也无常量兜底时按 1 计价，金额不再变成 NULL 被 SUM 丢掉', () => {
    run(`DELETE FROM exchange_rate WHERE currency = 'XAF'`);
    makeOrder({ time: '2026-09-03 02:00:00', currency: 'XAF', amount: 500, tag: 'XAF' });
    rebuildShopChannelDaily('2026-09-01', '2026-09-05', bossId);
    const row = get<{ gmv: number }>(
      `SELECT gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND shop_id = ? AND stat_date = '2026-09-02' AND channel <> 'ads'`,
      shopId,
    );
    expect(Number(row?.gmv ?? 0)).toBeCloseTo(500, 2);
  });

  it('重建会数出「走了兜底」的单据数（PRD §6.1：汇率缺失必须可解释）', () => {
    const outcome = rebuildAnalytics({ id: bossId }, { start: '2026-08-01', end: '2026-09-05' });
    expect(outcome.rate_fallback_rows).toBeGreaterThanOrEqual(2);
    expect(countRateFallbacks('2026-08-01', '2026-09-05')).toBe(outcome.rate_fallback_rows);
    // 部分失败的批次要在同步日志上看得见，不能报「成功」
    const log = get<{ status: number; failed: number }>(`SELECT status, failed FROM sync_log WHERE id = ?`, outcome.sync_log_id);
    expect(Number(log?.status)).toBe(2);
    expect(Number(log?.failed)).toBeGreaterThan(0);
  });

  it('达人 ROI 表达式与宽表同档：缺价时按兜底常量而不是 1:1 假装有数', () => {
    const row = get<{ gmv_cny: number }>(
      `SELECT ROUND(SUM(${AMOUNT_CNY}), 2) AS gmv_cny
         FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
         ${RATE_JOIN} ${REFUND_JOIN}
        WHERE ${ATTRIBUTABLE_ORDER} AND o.shop_id = ? AND o.currency = 'VND'`,
      shopId,
    );
    // 1,000,000 VND × 兜底 0.00029 = 290（老写法会乘 NULL 变成 0/NULL）
    expect(Number(row?.gmv_cny)).toBeCloseTo(290, 2);
  });
});

describe('净 GMV 只扣已完成退款', () => {
  it('PROCESSING 的售后不影响净 GMV，转 COMPLETED 后才扣', async () => {
    const oid = makeOrder({ time: '2026-09-04 02:00:00', currency: 'USD', amount: 100, tag: 'REFUND' });
    const summaryOf = async (): Promise<{ gmv: number; net: number }> => {
      const res = await ctx.http.get(`/api/orders/summary?shop_id=${shopId}&order_time_from=2026-06-01&order_time_to=2026-12-31`).set(auth(token.boss));
      expect(res.status).toBe(200);
      const d = dataOf<{ totals: { gmv_cny: number; net_gmv_cny: number } }>(res.body);
      return { gmv: Number(d?.totals?.gmv_cny), net: Number(d?.totals?.net_gmv_cny) };
    };
    const before = await summaryOf();

    const retId = insert('tk_return', {
      order_id: oid,
      shop_id: shopId,
      tk_return_id: 'CAL-RET-PROCESSING',
      tk_order_item_id: Number(get<{ id: number }>(`SELECT id FROM tk_order_item WHERE order_id = ?`, oid)?.id ?? 0),
      return_type: 1,
      refund_amount: 60,
      currency: 'USD',
      status: 'PROCESSING',
      apply_time: '2026-09-04 03:00:00',
    });
    const processing = await summaryOf();
    expect(processing.net).toBeCloseTo(before.net, 2); // 未完成的退款不许改历史数字

    run(`UPDATE tk_return SET status = 'COMPLETED' WHERE id = ?`, retId);
    const done = await summaryOf();
    expect(done.net).toBeLessThan(processing.net);
    expect(processing.net - done.net).toBeGreaterThan(0);
  });
});
