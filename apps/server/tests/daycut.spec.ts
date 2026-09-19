import { describe, expect, it } from 'vitest';
import { REGION_TZ_OFFSET, isUsableZone, statDateInZone, zoneDayStartUtc, zoneOffsetMinutes } from '@tk/shared';
import { computeOrderProfit } from '../src/services/profit.js';
import { get, insert } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

/**
 * 报表切日口径（PRD §3 + 附录「站点自然日」）：
 * 一切以 tk_shop.timezone 的 IANA 时区为准（含夏令时），时区缺失才退回站点固定偏移；
 * SQL 聚合（tz_day）与 JS 计算（siteDay/siteDayOf）必须落在同一个自然日。
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
    insert('tk_order_item', { order_id: oid, item_amount: 100, cost_matched: 1, quantity: 1, unit_price: 100, est_commission: 5, cost_snapshot: 30 });
    return oid;
  };
  const summer = orderAt('2026-07-01 06:30:00');
  const winter = orderAt('2026-01-15 06:30:00');

  it('利润引擎的 stat_date 按洛杉矶自然日归属', () => {
    expect(computeOrderProfit(summer).stat_date).toBe('2026-06-30');
    expect(computeOrderProfit(winter).stat_date).toBe('2026-01-14');
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
