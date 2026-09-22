/**
 * 「派生汇总刷新」窗口与覆盖面回归（#33）
 *
 * 两条都必须钉住，因为它们错的时候界面全是绿的：
 *  1. 不传窗口时不能退化成「最近 24 小时」——那是增量同步的语义，
 *     而派生汇总/宽表是全量重算；历史区间里补录的单据必须被算进去。
 *  2. 刷新必须真的动 analytics_* 宽表；以前它只纠偏映射与回填成本，
 *     宽表只有夜里那条 cron 会重算，操作者点完「刷新」看到的还是旧数字。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get, insert } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login, type TestContext } from './helper.js';

let ctx: TestContext;
let token = '';
let shopId = 0;

beforeAll(async () => {
  ctx = boot();
  token = await login(ctx.http, ACCOUNTS.boss);
  shopId = Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id ?? 0);
  expect(shopId).toBeGreaterThan(0);
});

/** 造一笔「很久以前」的已完成订单：老逻辑的 24 小时窗口永远碰不到它 */
function makeOldOrder(tag: string, amount: number): string {
  const day = '2025-11-11';
  const oid = insert('tk_order', {
    shop_id: shopId,
    tk_order_id: `AGG-${tag}`,
    order_status: 'COMPLETED',
    order_time: `${day} 09:00:00`,
    currency: 'CNY',
    total_paid: amount,
    is_sample_order: 0,
  });
  insert('tk_order_item', { order_id: oid, item_amount: amount, quantity: 1, unit_price: amount, cost_matched: 1, cost_snapshot: 0, est_commission: 0 });
  return day;
}

describe('aggregate 任务', () => {
  it('不传窗口时按源数据跨度重算，历史订单也会进宽表', async () => {
    const day = makeOldOrder('HISTORY', 4321);
    const before = Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND stat_date = ?`, day)?.c ?? 0);
    expect(before).toBe(0); // 重算前，那一天在宽表里不存在

    const res = await ctx.http.post('/api/sync/run').set(auth(token)).send({ task_type: 'aggregate' });
    expect(res.status).toBe(200);
    const data = dataOf<{ runs: { window_start: string; window_end: string; detail?: Record<string, number> }[] }>(res.body);
    const run0 = data.runs[0];
    expect(run0).toBeTruthy();
    // 生效窗口必须覆盖到 2025 年那笔订单，而不是「最近 24 小时」
    expect(run0.window_start.slice(0, 4) <= '2025').toBe(true);
    expect(run0.window_end >= new Date().toISOString().slice(0, 10)).toBe(true);

    const row = get<{ gmv: number }>(
      `SELECT gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND stat_date = ? AND shop_id = ?`,
      day,
      shopId,
    );
    expect(Number(row?.gmv ?? 0)).toBeCloseTo(4321, 2);
  });

  it('刷新结果里能看到宽表回写了多少行（不能只报「成功」）', async () => {
    const res = await ctx.http.post('/api/sync/run').set(auth(token)).send({ task_type: 'aggregate', window_start: '2025-01-01 00:00:00', window_end: '2026-12-31 23:59:59' });
    const detail = dataOf<{ runs: { detail?: Record<string, number> }[] }>(res.body).runs[0]?.detail ?? {};
    expect(Number(detail.analytics_rows ?? 0)).toBeGreaterThan(0);
    expect(detail).toHaveProperty('listing_fixed');
    expect(detail).toHaveProperty('item_backfilled');
    // 日志行也要看得出这次真的动了宽表（updated 里含回写行数）
    const log = get<{ updated: number; window_start: string }>(
      `SELECT updated, window_start FROM sync_log WHERE task_type = 'aggregate' ORDER BY id DESC LIMIT 1`,
    );
    expect(Number(log?.updated)).toBeGreaterThan(0);
  });

  it('显式给了窗口就尊重给定的窗口（增量补算历史某一段的能力不能被全量重算吃掉）', async () => {
    const res = await ctx.http
      .post('/api/sync/run')
      .set(auth(token))
      .send({ task_type: 'aggregate', window_start: '2026-01-01 00:00:00', window_end: '2026-01-31 23:59:59' });
    const run0 = dataOf<{ runs: { window_start: string; window_end: string }[] }>(res.body).runs[0];
    expect(run0.window_start).toBe('2026-01-01 00:00:00');
    expect(run0.window_end).toBe('2026-01-31 23:59:59');
  });
});
