import { describe, expect, it } from 'vitest';
import { REGION_TZ_OFFSET, isUsableZone, rebateCny, round2, statDateInZone, zoneDayStartUtc, zoneOffsetMinutes } from '@tk/shared';
import { computeOrderProfit, computeProfitReport } from '../src/services/profit.js';
import { get, insert, run } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

/**
 * 报表切日口径（PRD §3 + 附录「站点自然日」）：
 * 一切以 tk_shop.timezone 的 IANA 时区为准（含夏令时），时区缺失才退回站点固定偏移；
 * SQL 聚合（tz_day）与 JS 计算（siteDay/siteDayOf）必须落在同一个自然日。
 * 切日切错的代价在新口径下更直接：返点按「报表自然日的汇率」折 CNY 冻结，
 * 归错一天就等于用了另一天的牌价，整行的返点/物流/佣金/利润都会挪到别的日期上。
 */

const { db, http } = boot();
const LA = 'America/Los_Angeles';
const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const dayStart = (day: string, tz: string): string => utc(zoneDayStartUtc(day, tz));

describe('IANA 切日纯函数', () => {
  it('美国夏令时：UTC 06:30 属于前一天（旧固定偏移 -240 会算成当天）', () => {
    expect(statDateInZone('2026-07-01T06:30:00Z', LA)).toBe('2026-06-30');
    expect(statDateInZone('2026-07-01T09:30:00Z', LA)).toBe('2026-07-01');
    expect(statDateInZone('2026-07-01 06:30:00', LA)).toBe('2026-06-30');
    expect(statDateInZone('2026-07-01T06:30:00Z', LA, REGION_TZ_OFFSET.US)).not.toBe(
      statDateInZone('2026-07-01T06:30:00Z', '', REGION_TZ_OFFSET.US),
    );
  });

  it('冬令时同样按真实偏移（PST -8）而不是站点常量 -4 小时', () => {
    expect(statDateInZone('2026-01-15T06:30:00Z', LA)).toBe('2026-01-14');
    expect(statDateInZone('2026-01-15T06:30:00Z', 'Asia/Manila')).toBe('2026-01-15');
    expect(zoneOffsetMinutes(LA, Date.parse('2026-01-15T00:00:00Z'))).toBe(-480);
    expect(zoneOffsetMinutes(LA, Date.parse('2026-07-15T00:00:00Z'))).toBe(-420);
  });

  it('夏令时切换日：日界 UTC 随偏移挪一小时（春 23 小时、秋 25 小时）', () => {
    expect(dayStart('2026-03-07', LA)).toBe('2026-03-07 08:00:00');
    expect(dayStart('2026-03-08', LA)).toBe('2026-03-08 08:00:00');
    expect(dayStart('2026-03-09', LA)).toBe('2026-03-09 07:00:00');
    expect(zoneDayStartUtc('2026-03-09', LA) - zoneDayStartUtc('2026-03-08', LA)).toBe(23 * 3_600_000);
    expect(zoneDayStartUtc('2026-11-02', LA) - zoneDayStartUtc('2026-11-01', LA)).toBe(25 * 3_600_000);
    // 无夏令时站点恒等于固定偏移
    expect(dayStart('2026-07-01', 'Asia/Manila')).toBe('2026-06-30 16:00:00');
  });

  it('脏时区不抛错：退回入参偏移；isUsableZone 可据此提示', () => {
    expect(isUsableZone(LA)).toBe(true);
    expect(isUsableZone('Mars/Phobos')).toBe(false);
    expect(isUsableZone('')).toBe(false);
    expect(statDateInZone('2026-07-01T06:30:00Z', 'Mars/Phobos', -240)).toBe('2026-07-01');
    expect(statDateInZone('', LA)).toBe('');
    expect(statDateInZone('not-a-date', LA)).toBe('not-a-date');
    expect(Number.isNaN(zoneDayStartUtc('xxxx-01-01', LA))).toBe(true);
  });
});

describe('SQL 侧 tz_day 与 JS 侧同口径', () => {
  const call = (t: string, tz: unknown, region: unknown): string =>
    String(get<{ d: string }>(`SELECT tz_day(?, ?, ?) AS d`, t, tz, region)?.d);

  it('tz_day(utc, iana, region) 与 statDateInZone 结果一致', () => {
    for (const [t, tz] of [['2026-07-01 06:30:00', LA], ['2026-07-01 15:30:00', 'Asia/Manila'], ['2026-01-15 06:30:00', LA]] as const) {
      expect(call(t, tz, 'US')).toBe(statDateInZone(t, tz));
    }
  });

  it('时区列为空/非法时用站点码兜底，绝不整表报错', () => {
    expect(call('2026-07-01 06:30:00', '', 'US')).toBe('2026-07-01');
    expect(call('2026-07-01 06:30:00', null, 'US')).toBe('2026-07-01');
    expect(call('2026-07-01 06:30:00', 'Mars/Phobos', 'SG')).toBe('2026-06-30');
    expect(call('2026-07-01 20:00:00', '', '')).toBe('2026-07-01');
  });

  it('GROUP BY tz_day 能按站点自然日聚合（UTC 跨日的两单合成一天）', () => {
    const rows = db
      .prepare(
        `SELECT tz_day(o.order_time, s.timezone, s.region) AS stat_date, COUNT(*) AS c
           FROM tk_order o JOIN tk_shop s ON s.id = o.shop_id
          WHERE s.region = 'US' AND o.is_deleted = 0
          GROUP BY stat_date ORDER BY stat_date LIMIT 5`,
      )
      .all() as { stat_date: string; c: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.stat_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('端到端：一家美国店的跨日订单', () => {
  const bossId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.boss)?.id);

  const shopId = insert('tk_shop', {
    shop_name: 'DST Probe Store',
    region: 'US',
    currency: 'USD',
    timezone: LA,
    shop_type: 1,
    auth_status: 1,
    status: 1,
    owner_id: bossId,
  });
  /**
   * 钉住这两个报表自然日的美元牌价，让返点/利润能被纯手算复现：
   * 洛杉矶 6/30 用 7.5、1/14 用 7.2（不插这两行的话它们会掉进 seed 里"最近一条未来价"那一档，读起来不直观）。
   */
  const pinRate = (day: string, rate: number): void => {
    run(`DELETE FROM exchange_rate WHERE currency = 'USD' AND rate_date = ?`, day);
    insert('exchange_rate', { rate_date: day, currency: 'USD', rate_to_cny: rate, source: 2 });
  };
  pinRate('2026-06-30', 7.5);
  pinRate('2026-01-14', 7.2);

  const orderAt = (t: string): number => {
    const oid = insert('tk_order', {
      shop_id: shopId,
      tk_order_id: `DST-${t.replace(/[^0-9]/g, '')}`,
      order_status: 'COMPLETED',
      order_time: t,
      currency: 'USD',
      total_paid: 100,
      is_sample_order: 0,
    });
    // 实收 100 USD、返点率 0.2、单件物流 3 元、佣金 5 USD：
    // 6/30 那单 → 折 CNY 750，返点 750×0.2=150，佣金 5×7.5=37.5，毛利 150−3−37.5=109.5
    // 1/14 那单 → 折 CNY 720，返点 720×0.2=144，佣金 5×7.2=36  ，毛利 144−3−36  =105
    const laDay = statDateInZone(t, LA);
    const fx = laDay === '2026-06-30' ? 7.5 : 7.2;
    insert('tk_order_item', {
      order_id: oid,
      item_amount: 100,
      quantity: 1,
      unit_price: 100,
      rebate_rate: 0.2,
      rebate_cny: rebateCny(round2(100 * fx), 0.2),
      logistics_cny: 3,
      rebate_matched: 1,
      est_commission: 5,
    });
    return oid;
  };
  const summer = orderAt('2026-07-01 06:30:00');
  const winter = orderAt('2026-01-15 06:30:00');

  it('利润引擎的 stat_date 按洛杉矶自然日归属', () => {
    expect(computeOrderProfit(summer).stat_date).toBe('2026-06-30');
    expect(computeOrderProfit(winter).stat_date).toBe('2026-01-14');
  });

  it('整行的钱（返点/物流/佣金/利润）整笔落在站点自然日，不按 UTC 劈成两天', () => {
    const rep = computeProfitReport({ dim: 'day', start: '2026-01-14', end: '2026-06-30', shopIds: [shopId] });
    expect(rep.list.map((r) => r.dim_key)).toEqual(['2026-01-14', '2026-06-30']);
    const summerRow = rep.list.find((r) => r.dim_key === '2026-06-30')!;
    const winterRow = rep.list.find((r) => r.dim_key === '2026-01-14')!;
    // 6/30：实收折 CNY 100×7.5=750，返点 150，物流 3，佣金 37.5 → 利润 109.5
    expect(summerRow.gmv).toBe(750);
    expect(summerRow.rebate).toBe(150);
    expect(summerRow.logistics).toBe(3);
    expect(summerRow.commission).toBe(37.5);
    expect(summerRow.profit).toBe(109.5); // 150 − 3 − 37.5
    // 1/14：实收折 CNY 100×7.2=720，返点 144，物流 3，佣金 36 → 利润 105
    expect(winterRow.gmv).toBe(720);
    expect(winterRow.rebate).toBe(144);
    expect(winterRow.logistics).toBe(3);
    expect(winterRow.commission).toBe(36);
    expect(winterRow.profit).toBe(105); // 144 − 3 − 36
    // 合计 = 两行之和：切日错一天，两行的钱就会跑到别的日期上，合计虽然不变但按日曲线会变形
    expect(rep.total.rebate).toBe(294); // 150 + 144
    expect(rep.total.profit).toBe(214.5); // 109.5 + 105
    // 取价按报表自然日：UTC 6/30 与 UTC 7/1 的订单不能共用 7/1 的牌价
    expect(computeOrderProfit(summer).rate_source_date).toBe('2026-06-30');
    expect(computeOrderProfit(winter).rate_source_date).toBe('2026-01-14');
  });

  it('订单日报按日曲线同样落在站点自然日', async () => {
    const token = await login(http, ACCOUNTS.boss);
    const res = await http.get(`/api/orders/summary?shop_id=${shopId}`).set(auth(token));
    expect(res.status).toBe(200);
    const byDay = dataOf<{ by_day: { stat_date: string }[] }>(res.body).by_day;
    expect(byDay.map((r) => r.stat_date)).toEqual(['2026-01-14', '2026-06-30']);
  });

  it('店铺没填时区时两条链路一起退回站点偏移（口径不分裂）', () => {
    db.prepare(`UPDATE tk_shop SET timezone = '' WHERE id = ?`).run(shopId);
    try {
      expect(computeOrderProfit(summer).stat_date).toBe('2026-07-01');
      expect(String(get<{ d: string }>(`SELECT tz_day(o.order_time, s.timezone, s.region) AS d FROM tk_order o JOIN tk_shop s ON s.id=o.shop_id WHERE o.id = ?`, summer)?.d)).toBe('2026-07-01');
    } finally {
      db.prepare(`UPDATE tk_shop SET timezone = ? WHERE id = ?`).run(LA, shopId);
    }
  });
});
