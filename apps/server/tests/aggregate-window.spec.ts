/**
 * 「派生汇总刷新」窗口与覆盖面回归（#33）
 *
 * 两条都必须钉住，因为它们错的时候界面全是绿的：
 *  1. 不传窗口时不能退化成「最近 24 小时」——那是增量同步的语义，
 *     而派生汇总/宽表是全量重算；历史区间里补录的单据必须被算进去。
 *  2. 刷新必须真的动 analytics_* 宽表；以前它只纠偏映射与回填返点，
 *     宽表只有夜里那条 cron 会重算，操作者点完「刷新」看到的还是旧数字。
 *  3. 品牌服务方口径下宽表的两类列不许混：gmv/net_gmv 是品牌的带货规模（含没配返点率的行），
 *     rebate/commission 是我们的钱，只算 rebate_matched=1 的行；
 *     而 rebate_cny 本来就是成交时冻结的人民币，回写时再乘一次当日汇率就是双折算。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { rebateCny, round2 } from '@tk/shared';
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

/** 造一笔「很久以前」的已完成订单（人民币单，冻结返点 = 实收 × 返点率），返回报表自然日 */
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
  insert('tk_order_item', {
    order_id: oid,
    item_amount: amount,
    quantity: 1,
    unit_price: amount,
    // 人民币单汇率恒 1：应收返点 = 4321 × 0.2 = 864.20，物流 6
    rebate_rate: 0.2,
    rebate_cny: rebateCny(amount, 0.2),
    logistics_cny: 6,
    rebate_matched: 1,
    est_commission: 0,
  });
  return day;
}

/** 造一笔指定日期/币种的外币订单行（返点三列按落库口径手工冻结） */
function makeOldItem(opts: {
  tag: string;
  day: string;
  currency: string;
  fx: number;
  amount: number;
  rebateRate: number;
  logistics: number;
  commission: number;
  matched: 0 | 1;
  creatorId: number;
}): void {
  const oid = insert('tk_order', {
    shop_id: shopId,
    tk_order_id: `AGG-${opts.tag}`,
    order_status: 'COMPLETED',
    order_time: `${opts.day} 09:00:00`,
    currency: opts.currency,
    total_paid: opts.amount,
    is_sample_order: 0,
  });
  insert('tk_order_item', {
    order_id: oid,
    item_amount: opts.amount,
    quantity: 1,
    unit_price: opts.amount,
    creator_id: opts.creatorId,
    content_type: 1,
    // 冻结值就是成交当天的数：实收折 CNY = 200 × 7.5 = 1500 → 返点 1500 × 0.25 = 375
    rebate_rate: opts.matched ? opts.rebateRate : 0,
    rebate_cny: opts.matched ? rebateCny(round2(opts.amount * opts.fx), opts.rebateRate) : 0,
    logistics_cny: opts.matched ? opts.logistics : 0,
    rebate_matched: opts.matched,
    est_commission: opts.commission,
  });
}

const runAggregate = async (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
  dataOf<{ runs: Record<string, unknown>[] }>((await ctx.http.post('/api/sync/run').set(auth(token)).send({ task_type: 'aggregate', ...body })).body).runs[0] ?? {};

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

describe('宽表的返点列与窗口边界', () => {
  const DAY = '2025-11-12';
  const FX = 7.5; // 钉死当日牌价，让期望值能被手算复现
  let creatorId = 0;

  it('窗口外的历史天不许被顺手动到：只重算给定的那一段', async () => {
    creatorId = Number(get<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id ?? 0);
    expect(creatorId).toBeGreaterThan(0);
    insert('exchange_rate', { rate_date: DAY, currency: 'USD', rate_to_cny: FX, source: 2 });
    // 配到返点率的一行：实收 200 USD，折 CNY 200 × 7.5 = 1500，返点 1500 × 0.25 = 375，佣金 10 × 7.5 = 75
    makeOldItem({ tag: 'REBATE-OK', day: DAY, currency: 'USD', fx: FX, amount: 200, rebateRate: 0.25, logistics: 2, commission: 10, matched: 1, creatorId });
    // 没配返点率的一行：实收 50 USD（折 375）—— 计品牌带货额，但不计我们的返点与佣金
    makeOldItem({ tag: 'REBATE-NONE', day: DAY, currency: 'USD', fx: FX, amount: 50, rebateRate: 0, logistics: 0, commission: 5, matched: 0, creatorId });

    // 只重算 11-11：11-12 这两行还不该出现在宽表里
    await runAggregate({ window_start: '2025-11-11 00:00:00', window_end: '2025-11-11 23:59:59' });
    expect(
      get<{ c: number }>(`SELECT COUNT(*) AS c FROM analytics_creator_daily WHERE is_deleted = 0 AND stat_date = ? AND creator_id = ?`, DAY, creatorId)?.c,
    ).toBe(0);
  });

  it('返点/佣金只算 rebate_matched=1 的行，且 rebate_cny 不再乘一次汇率（双折算）', async () => {
    await runAggregate({ window_start: `${DAY} 00:00:00`, window_end: `${DAY} 23:59:59` });
    const row = get<{ orders: number; gmv: number; rebate: number; commission: number; net_gmv: number }>(
      `SELECT orders, gmv, rebate, commission, net_gmv FROM analytics_creator_daily
        WHERE is_deleted = 0 AND stat_date = ? AND creator_id = ?`,
      DAY,
      creatorId,
    );
    expect(row, `${DAY} 没进达人宽表，说明窗口或归日又分叉了`).toBeTruthy();
    // 带货额是品牌的生意：两行都算 → 200×7.5 + 50×7.5 = 1500 + 375 = 1875
    expect(Number(row?.gmv)).toBe(1875);
    expect(Number(row?.net_gmv)).toBe(1875);
    expect(Number(row?.orders)).toBe(2);
    // 我们的收入只有配了返点率的那一行，且直接取冻结的人民币 375
    // （若再乘一次当日 7.5 汇率就会变成 2812.5 —— 双折算就是这条断言守的）
    expect(Number(row?.rebate)).toBe(375);
    // 达人佣金同样只算配了返点率的行：10 × 7.5 = 75（未配那一行的 5 × 7.5 = 37.5 不许进来）
    expect(Number(row?.commission)).toBe(75);
  });

  it('店铺渠道宽表的 gmv 仍含未配返点率的行（档位口径不跟着钱口径一起改）', async () => {
    const row = get<{ gmv: number; net_gmv: number }>(
      `SELECT gmv, net_gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND stat_date = ? AND shop_id = ? AND channel <> 'ads'`,
      DAY,
      shopId,
    );
    // 1500 + 375 = 1875：ABC 分层与渠道结构看的是品牌带货规模
    expect(Number(row?.gmv)).toBe(1875);
    expect(Number(row?.net_gmv)).toBe(1875);
  });
});
