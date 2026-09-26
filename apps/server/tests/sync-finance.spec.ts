import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_LABEL, rebateCny, round2 } from '@tk/shared';
import {
  activeShopIds,
  normalizeFulfillment,
  normalizeOrderStatus,
  refreshDerivedAggregates,
  resolveWindow,
  runTask,
  snapshotRebate,
  type SyncResult,
} from '../src/jobs/syncJobs.js';
import { MockTikTokShopClient } from '../src/services/tiktok/mockProvider.js';
import { getRate, rateDay } from '../src/services/rates.js';
import { all, get, insert, run } from '../src/core/db.js';
import { config } from '../src/config.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';

/**
 * 数据同步与财务结算的自动化回归（开发文档要求：同步 / 财务 / 预警三条链路必须有测试）。
 * 全程 mock 模式，不发任何外网请求；断言集中在幂等、留痕、失败告警与「不重复计钱」。
 * 品牌服务方口径下另外钉住两件事：返点三列在明细写入时冻结（改 SKU 不回溯历史），
 * 以及算不出返点的行（未映射 / SKU 没配返点率）计入 failed 而不是按 0 收入进报表。
 */

const { http } = boot();
const SHOP = 1;
const WIN = { windowStart: '2026-09-10 00:00:00', windowEnd: '2026-09-10 12:00:00' };
const nowUtc = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
const minusMinutes = (utc: string, mins: number): string =>
  new Date(Date.parse(`${utc.replace(' ', 'T')}Z`) - mins * 60000).toISOString().replace('T', ' ').slice(0, 19);

const countOf = (sql: string, ...p: (string | number)[]): number => Number(get<{ c: number }>(sql, ...p)?.c ?? 0);
const orders = (shopId = SHOP): number => countOf(`SELECT COUNT(*) AS c FROM tk_order WHERE shop_id = ? AND is_deleted = 0`, shopId);
const items = (shopId = SHOP): number =>
  countOf(`SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE o.shop_id = ? AND i.is_deleted = 0`, shopId);
const lastLog = (taskType: string, shopId: number | null): Record<string, unknown> | undefined =>
  get<Record<string, unknown>>(
    `SELECT * FROM sync_log WHERE task_type = ? AND ${shopId === null ? 'shop_id IS NULL' : 'shop_id = ?'} ORDER BY id DESC LIMIT 1`,
    taskType,
    ...(shopId === null ? [] : [shopId]),
  );

/** 明细行 + 所属订单的取价上下文（返点冻结时用的就是这个币种/这一天，逐字复算靠它） */
interface ItemRow {
  id: number;
  sku_id: number | null;
  quantity: number;
  item_amount: number;
  currency: string;
  order_time: string | null;
  paid_time: string | null;
  rebate_rate: number;
  rebate_cny: number;
  logistics_cny: number;
  rebate_matched: number;
}
const itemRow = (id: number): ItemRow | undefined =>
  get<ItemRow>(
    `SELECT i.id, i.sku_id, i.quantity, i.item_amount, i.rebate_rate, i.rebate_cny, i.logistics_cny, i.rebate_matched,
            o.currency, o.order_time, o.paid_time
       FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE i.id = ?`,
    id,
  );
/** 落库时的取价：订单币种 + 业务发生日（付款时间优先），与 upsertPlatformOrder 同一档 */
const rateOfOrder = (r: { currency: string; order_time: string | null; paid_time: string | null }): number =>
  getRate(r.currency, rateDay(String(r.paid_time ?? r.order_time ?? ''))).rate;

/** 临时替换 mock 客户端的某个接口，模拟平台侧异常/空返回 */
async function withMock<K extends keyof MockTikTokShopClient>(key: K, impl: MockTikTokShopClient[K], fn: () => Promise<void>): Promise<void> {
  const proto = MockTikTokShopClient.prototype as unknown as Record<string, unknown>;
  const original = proto[key as string];
  proto[key as string] = impl;
  try {
    await fn();
  } finally {
    proto[key as string] = original;
  }
}

describe('同步窗口与范围', () => {
  it('只同步「运营中 + 已授权」店铺，暂停/未授权店不进队列', () => {
    const active = activeShopIds();
    expect(active.length).toBeGreaterThan(0);
    for (const id of active) {
      const s = get<Record<string, number>>(`SELECT status, auth_status FROM tk_shop WHERE id = ?`, id);
      expect(s?.status).toBe(1);
      expect([1, 2]).toContain(s?.auth_status);
    }
    run(`UPDATE tk_shop SET status = 2 WHERE id = ?`, 4);
    expect(activeShopIds()).not.toContain(4);
    run(`UPDATE tk_shop SET status = 1 WHERE id = ?`, 4);
  });

  it('首次窗口取近 24 小时；有历史则接上次 window_end 并回退 overlap 分钟（宁多不漏）', () => {
    // sync_log.shop_id 有外键约束，只能用真实店铺：拿 shop 2 当沙箱，跑完删掉自己造的日志
    const SANDBOX = 2;
    run(`DELETE FROM sync_log WHERE shop_id = ? AND task_type = 'order'`, SANDBOX);
    const first = resolveWindow('order', SANDBOX, { windowEnd: '2026-09-10 12:00:00' });
    expect(first.from).toBe('2026-09-09 12:00:00');
    const logId = insert('sync_log', { task_type: 'order', shop_id: SANDBOX, window_start: '2026-09-10 00:00:00', window_end: '2026-09-10 12:00:00', started_at: nowUtc() });
    try {
      const next = resolveWindow('order', SANDBOX, { windowEnd: '2026-09-11 12:00:00' });
      expect(next.from).toBe(minusMinutes('2026-09-10 12:00:00', config.syncOverlapMinutes));
      // 手动补跑以人工窗口为准
      expect(resolveWindow('order', SANDBOX, WIN)).toEqual({ from: WIN.windowStart, to: WIN.windowEnd });
    } finally {
      run(`DELETE FROM sync_log WHERE id = ?`, Number(logId));
    }
  });
});

describe('订单同步落库与幂等', () => {
  let first: SyncResult;

  it('拉到样例订单并写成功日志，状态/履约方式按平台原文归一化', async () => {
    const before = orders();
    [first] = await runTask('order', SHOP, WIN);
    expect(first.fetched).toBeGreaterThanOrEqual(4);
    expect(first.inserted).toBe(first.fetched - (first.updated || 0));
    expect(orders()).toBeGreaterThan(before);
    expect([1, 2]).toContain(first.status);
    const log = lastLog('order', SHOP);
    expect(log?.window_start).toBe(WIN.windowStart);
    expect(log?.finished_at).toBeTruthy();
    // 库里只允许出现归一化后的状态域取值（前端 ORDER_STATUS_LABEL 是唯一口径来源）
    const allowed = `(${Object.keys(ORDER_STATUS_LABEL).map((s) => `'${s}'`).join(',')})`;
    const bad = countOf(`SELECT COUNT(*) AS c FROM tk_order WHERE shop_id = ? AND order_status NOT IN ${allowed}`, SHOP);
    expect(bad).toBe(0);
  });

  it('平台状态原文按取值域归一化，域外原文不外泄给业务口径', () => {
    expect(normalizeOrderStatus('INVOICE_CREATED')).toBe('TO_BE_SHIPPED');
    expect(normalizeOrderStatus('shipped')).toBe('TRANSIT_TO_SHIP');
    expect(normalizeOrderStatus('PACKAGE_DELIVERED')).toBe('DELIVERED');
    expect(normalizeOrderStatus('PAYMENT_PENDING')).toBe('UNPAID');
    expect(normalizeOrderStatus('ON_HOLD_SUBSTATUS_FNR')).toBe('ON_HOLD');
    expect(normalizeOrderStatus('')).toBe('ON_HOLD');
    expect(normalizeOrderStatus(undefined)).toBe('ON_HOLD');
    expect(normalizeFulfillment('Fulfilled by Seller')).toBe(2);
    expect(normalizeFulfillment(1)).toBe(1);
  });

  it('同一窗口重复同步不产生重复订单与重复明细，只推进状态', async () => {
    const o = orders();
    const i = items();
    const [again] = await runTask('order', SHOP, WIN);
    expect(orders()).toBe(o);
    expect(items()).toBe(i);
    expect(again.updated).toBeGreaterThan(0);
    expect(again.inserted).toBe(0);
  });

  it('订单号已在回收站时同步失败，不更新不可见的历史订单', async () => {
    const orderExtId = `ORDER-TRASH-${Date.now()}`;
    const orderId = insert('tk_order', { shop_id: SHOP, tk_order_id: orderExtId, order_status: 'COMPLETED', currency: 'MYR', total_paid: 45 });
    run(`UPDATE tk_order SET is_deleted = 1 WHERE id = ?`, orderId);

    await withMock('getOrders', (async () => [{ order_id: orderExtId, status: 'COMPLETED', currency: 'MYR', total_amount: 0.01 }]) as MockTikTokShopClient['getOrders'], async () => {
      const [result] = await runTask('order', SHOP, WIN);
      expect(result.failed).toBe(1);
    });

    const hidden = get<{ is_deleted: number; total_paid: number }>(`SELECT is_deleted, total_paid FROM tk_order WHERE id = ?`, orderId)!;
    expect([Number(hidden.is_deleted), Number(hidden.total_paid)]).toEqual([1, 45]);
  });

  it('找不到内部 SKU 的明细计入 failed 并让日志变「部分失败」，绝不静默按 0 返点', async () => {
    expect(first.status).toBe(2);
    expect(first.detail.unmapped_items ?? 0).toBeGreaterThan(0);
    const unmapped = countOf(`SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE o.shop_id = ? AND i.rebate_matched = 0`, SHOP);
    expect(unmapped).toBeGreaterThan(0);
    // 未配到返点率的行不许留一个「已冻结但其实没返点」的假快照
    const fake = countOf(
      `SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
        WHERE o.shop_id = ? AND i.rebate_matched = 0 AND (i.rebate_rate <> 0 OR i.rebate_cny <> 0 OR i.logistics_cny <> 0)`,
      SHOP,
    );
    expect(fake).toBe(0);
    // 这些行不参与任何钱口径
    const listed = pageOf((await http.get(`/api/orders?shop_id=${SHOP}&only_unmapped=1&pageSize=50`).set(auth(await login(http, ACCOUNTS.boss)))).body);
    expect(listed.total).toBeGreaterThan(0);
  });

  it('返点快照冻结：rebate_cny = 实收折 CNY × 冻结返点率，改 SKU 返点率不回溯历史明细', async () => {
    const row = get<{ id: number; sku_id: number }>(
      `SELECT i.id, i.sku_id FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
        WHERE o.shop_id = ? AND i.rebate_matched = 1 AND i.rebate_cny > 0 LIMIT 1`,
      SHOP,
    );
    expect(row).toBeTruthy();
    const before = itemRow(row!.id)!;
    const sku = get<{ rebate_rate: number; logistics_cost: number }>(`SELECT rebate_rate, logistics_cost FROM product_sku WHERE id = ?`, before.sku_id)!;
    // 手算复核：实收折 CNY = item_amount × 业务发生日汇率；应收返点 = 该值 × 冻结返点率；
    // 物流 = 单件物流成本（本来就是人民币/件）× 数量，不再乘汇率。
    const amountCny = round2(before.item_amount * rateOfOrder(before));
    expect(before.rebate_rate).toBe(sku.rebate_rate);
    expect(before.rebate_cny).toBe(rebateCny(amountCny, sku.rebate_rate));
    expect(before.logistics_cny).toBe(round2(sku.logistics_cost * before.quantity));

    // 事后品牌把返点率谈到 0.9、物流涨到 88/件：历史单一条都不许动（要点 3）
    run(`UPDATE product_sku SET rebate_rate = 0.9, logistics_cost = 88 WHERE id = ?`, before.sku_id);
    try {
      await runTask('order', SHOP, WIN);
      const after = itemRow(row!.id)!;
      expect([Number(after.rebate_rate), Number(after.rebate_cny), Number(after.logistics_cny)]).toEqual([
        Number(before.rebate_rate),
        Number(before.rebate_cny),
        Number(before.logistics_cny),
      ]);
      // 重跑同步后仍与「成交当日」的价 + 成交时的率自洽，而不是与新协议 0.9 自洽
      expect(after.rebate_cny).toBe(rebateCny(round2(after.item_amount * rateOfOrder(after)), before.rebate_rate));
    } finally {
      run(`UPDATE product_sku SET rebate_rate = ?, logistics_cost = ? WHERE id = ?`, sku.rebate_rate, sku.logistics_cost, before.sku_id);
    }
  });

  it('返点冻结的纯函数口径：没配返点率的 SKU 与找不到 SKU 一样整行退出', () => {
    // 落库口径（syncJobs.snapshotRebate）：返点率 ≤ 0 一律 rebate_matched=0，三个冻结值全部留空
    const noRate = snapshotRebate({ rebate_rate: 0, logistics_cost: 14 }, 2, 1000);
    expect(noRate).toEqual({ rebate_rate: 0, rebate_cny: 0, logistics_cny: 0, rebate_matched: 0 });
    // 配了返点率才冻结：1000 元实收 × 0.22 = 220；物流 14/件 × 2 件 = 28（物流不折汇）
    expect(snapshotRebate({ rebate_rate: 0.22, logistics_cost: 14 }, 2, 1000)).toEqual({
      rebate_rate: 0.22,
      rebate_cny: 220,
      logistics_cny: 28,
      rebate_matched: 1,
    });
    // 没映射到 SKU（sku 为空）同样整行退出，绝不允许"按 0 收入继续算利润"
    expect(snapshotRebate(null, 1, 500).rebate_matched).toBe(0);
  });

  it('平台异常时记结构化失败日志，不把异常抛给调度器', async () => {
    await withMock('getOrders', (async () => { throw new Error('socket hang up'); }) as MockTikTokShopClient['getOrders'], async () => {
      const [r] = await runTask('order', SHOP, WIN);
      expect(r.status).toBe(3);
      expect(String(r.error_msg)).toContain('socket hang up');
      expect(lastLog('order', SHOP)?.status).toBe(3);
    });
  });

  it('平时有单却拉到 0 条按失败处理（防接口静默返回空）', async () => {
    const oid = insert('tk_order', {
      shop_id: SHOP, tk_order_id: `RECENT-${Date.now()}`, order_status: 'COMPLETED',
      order_time: nowUtc(), currency: 'MYR', total_paid: 10,
    });
    // 手工补一行「有返点」的近期单：冻结值按落库口径一起算，不留假快照
    // 实收折 CNY = 10 × 今日 MYR 牌价；应收返点 = 该值 × 0.2
    const fx = getRate('MYR', rateDay(nowUtc())).rate;
    insert('tk_order_item', {
      order_id: oid,
      item_amount: 10,
      quantity: 1,
      rebate_rate: 0.2,
      rebate_cny: rebateCny(round2(10 * fx), 0.2),
      logistics_cny: 0,
      rebate_matched: 1,
    });
    await withMock('getOrders', (async () => []) as MockTikTokShopClient['getOrders'], async () => {
      const [r] = await runTask('order', SHOP, { windowStart: '2026-01-01 00:00:00', windowEnd: '2026-01-02 00:00:00' });
      expect(r.status).toBe(3);
      expect(String(r.error_msg)).toMatch(/拉到 0 条/);
    });
  });
});

describe('商品 / 售后 / 联盟 / 派生刷新', () => {
  it('商品同步后待映射 listing 落成 map_status=2，可自动匹配的走 sku_code', async () => {
    const [r] = await runTask('listing', SHOP, WIN);
    expect(r.status).not.toBe(3);
    expect(r.fetched).toBeGreaterThan(0);
    const typo = get<Record<string, unknown>>(
      `SELECT map_status, sku_id FROM shop_listing WHERE shop_id = ? AND seller_sku = 'WRONG_SELLER_SKU_9999' AND is_deleted = 0`,
      SHOP,
    );
    expect(typo).toBeTruthy();
    expect(Number(typo?.map_status)).toBe(2);
    expect(typo?.sku_id ?? null).toBeNull();
  });

  it('售后与联盟归因各留一条日志且不中断', async () => {
    const [ret] = await runTask('returns', SHOP, WIN);
    expect(ret.log_id).toBeGreaterThan(0);
    const [aff] = await runTask('affiliate', SHOP, WIN);
    expect(aff.status).not.toBe(3);
    expect(['returns', 'affiliate_order']).toContain(String(lastLog(aff.task_type, SHOP)?.task_type));
  });

  it('售后同步拒绝跨店重复单号和跨店订单关联', async () => {
    const otherShop = get<{ id: number }>(`SELECT id FROM tk_shop WHERE id <> ? AND is_deleted = 0 ORDER BY id LIMIT 1`, SHOP)!;
    const orderExtId = `RETURN-SCOPE-ORDER-${Date.now()}`;
    const orderId = insert('tk_order', { shop_id: SHOP, tk_order_id: orderExtId, order_status: 'COMPLETED', currency: 'MYR' });
    const returnExtId = `RETURN-SCOPE-${Date.now()}`;
    insert('tk_return', { shop_id: otherShop.id, tk_return_id: returnExtId, refund_amount: 39.9, currency: 'MYR' });

    await withMock('getReturns', (async () => [{ return_id: returnExtId, order_id: orderExtId, refund_amount: 0.01, currency: 'MYR' }]) as MockTikTokShopClient['getReturns'], async () => {
      const [result] = await runTask('returns', SHOP, WIN);
      expect(result.failed).toBe(1);
    });

    const still = get<{ shop_id: number; order_id: number | null; refund_amount: number }>(
      `SELECT shop_id, order_id, refund_amount FROM tk_return WHERE tk_return_id = ?`, returnExtId,
    )!;
    expect([Number(still.shop_id), still.order_id, Number(still.refund_amount)]).toEqual([Number(otherShop.id), null, 39.9]);
  });

  it('售后同步拒绝引用跨店或回收站订单，并拒绝覆盖回收站售后', async () => {
    const otherShop = get<{ id: number }>(`SELECT id FROM tk_shop WHERE id <> ? AND is_deleted = 0 ORDER BY id LIMIT 1`, SHOP)!;
    const otherOrderExtId = `RETURN-CROSS-SHOP-ORDER-${Date.now()}`;
    insert('tk_order', { shop_id: otherShop.id, tk_order_id: otherOrderExtId, order_status: 'COMPLETED', currency: 'MYR' });
    const deletedOrderExtId = `RETURN-DELETED-ORDER-${Date.now()}`;
    const deletedOrderId = insert('tk_order', { shop_id: SHOP, tk_order_id: deletedOrderExtId, order_status: 'COMPLETED', currency: 'MYR' });
    run(`UPDATE tk_order SET is_deleted = 1 WHERE id = ?`, deletedOrderId);

    const trashedReturnId = `RETURN-TRASH-${Date.now()}`;
    const trashedReturn = insert('tk_return', { shop_id: SHOP, tk_return_id: trashedReturnId, refund_amount: 39.9, currency: 'MYR' });
    run(`UPDATE tk_return SET is_deleted = 1 WHERE id = ?`, trashedReturn);
    const crossShopReturnId = `RETURN-CROSS-SHOP-${Date.now()}`;
    const deletedOrderReturnId = `RETURN-DELETED-ORDER-REF-${Date.now()}`;

    await withMock('getReturns', (async () => [
      { return_id: crossShopReturnId, order_id: otherOrderExtId, refund_amount: 0.01, currency: 'MYR' },
      { return_id: deletedOrderReturnId, order_id: deletedOrderExtId, refund_amount: 0.01, currency: 'MYR' },
      { return_id: trashedReturnId, refund_amount: 0.01, currency: 'MYR' },
    ]) as MockTikTokShopClient['getReturns'], async () => {
      const [result] = await runTask('returns', SHOP, WIN);
      expect(result.failed).toBe(3);
    });

    expect(get(`SELECT id FROM tk_return WHERE tk_return_id = ?`, crossShopReturnId)).toBeUndefined();
    expect(get(`SELECT id FROM tk_return WHERE tk_return_id = ?`, deletedOrderReturnId)).toBeUndefined();
    expect(Number(get<{ refund_amount: number; is_deleted: number }>(`SELECT refund_amount, is_deleted FROM tk_return WHERE id = ?`, trashedReturn)?.refund_amount)).toBe(39.9);
    expect(Number(get<{ is_deleted: number }>(`SELECT is_deleted FROM tk_return WHERE id = ?`, trashedReturn)?.is_deleted)).toBe(1);
  });

  it('映射补齐后跑 aggregate：历史未配返点率的行回填返点快照并留操作日志', () => {
    const sku = get<{ id: number; sku_code: string; rebate_rate: number; logistics_cost: number }>(
      `SELECT id, sku_code, rebate_rate, logistics_cost FROM product_sku WHERE is_deleted = 0 ORDER BY id LIMIT 1`,
    );
    // 新口径下「回填」的前提是 SKU 上真的配了返点率，否则这一行继续留在待映射清单
    expect(Number(sku?.rebate_rate ?? 0)).toBeGreaterThan(0);
    const listing = insert('shop_listing', { shop_id: SHOP, sku_id: null, tk_sku_id: 'AGG-TEST-SKU', tk_product_id: 'AGG-TEST-P', seller_sku: 'AGG-TEST', product_name: '待映射', sale_price: 99, map_status: 2 });
    const order = insert('tk_order', { shop_id: SHOP, tk_order_id: 'AGG-TEST-ORDER', order_status: 'COMPLETED', order_time: nowUtc(), currency: 'MYR', total_paid: 99 });
    const item = insert('tk_order_item', { order_id: order, listing_id: listing, item_amount: 99, quantity: 2, rebate_matched: 0 });

    const r = refreshDerivedAggregates({ user_id: 1 });
    expect(r.status).toBe(1);
    // listing 状态自愈 + 明细回填
    expect(Number(get<{ map_status: number }>(`SELECT map_status FROM shop_listing WHERE id = ?`, listing)?.map_status)).toBe(2);
    const after = get<Record<string, unknown>>(`SELECT sku_id, rebate_matched, rebate_cny, logistics_cny FROM tk_order_item WHERE id = ?`, item);
    expect(Number(after?.rebate_matched)).toBe(0); // SKU 还没绑上，这一行仍然不算返点
    expect(Number(after?.rebate_cny)).toBe(0);

    run(`UPDATE shop_listing SET sku_id = ?, map_status = 1 WHERE id = ?`, sku!.id, listing);
    const r2 = refreshDerivedAggregates({ user_id: 1 });
    expect(Number(r2.detail.item_backfilled)).toBeGreaterThanOrEqual(1);
    expect(Number(get<{ rebate_matched: number }>(`SELECT rebate_matched FROM tk_order_item WHERE id = ?`, item)?.rebate_matched)).toBe(1);
    // 手算：实收折 CNY = 99 × MYR 当日牌价（2.12 × 0.9955 = 2.11）= 208.89；
    // 应收返点 = 208.89 × 0.22 = 45.9558 → 45.96；物流 = 14/件 × 2 件 = 28（人民币列不折汇）
    const fx = rateOfOrder(itemRow(item)!);
    expect(Number(get<{ rebate_cny: number }>(`SELECT rebate_cny FROM tk_order_item WHERE id = ?`, item)?.rebate_cny)).toBe(
      rebateCny(round2(99 * fx), sku!.rebate_rate),
    );
    expect(Number(get<{ logistics_cny: number }>(`SELECT logistics_cny FROM tk_order_item WHERE id = ?`, item)?.logistics_cny)).toBe(
      round2(sku!.logistics_cost * 2),
    );
    const log = get<Record<string, unknown>>(`SELECT before_after FROM sys_op_log WHERE target_table = 'tk_order_item' AND target_id = ? ORDER BY id DESC LIMIT 1`, item);
    const logged = String(log?.before_after ?? '');
    expect(logged).toContain('回填');
    expect(logged).toContain('"rebate_cny"'); // 回填前后的冻结值可追溯（此前无返点快照 → 现在按当日价冻结）
  });

  it('aggregate 幂等：第二次跑不再回填、不新增日志行以外的变化', () => {
    const before = countOf(`SELECT COUNT(*) AS c FROM tk_order_item WHERE rebate_matched = 1`);
    const r = refreshDerivedAggregates();
    expect(Number(r.detail.item_backfilled)).toBe(0);
    expect(countOf(`SELECT COUNT(*) AS c FROM tk_order_item WHERE rebate_matched = 1`)).toBe(before);
  });
});

describe('同步入口鉴权与限范围', () => {
  it('/api/sync/run 属系统能力：无 system 菜单的运营/BD 一律 403', async () => {
    const body = { task_type: 'order', shop_id: SHOP };
    for (const u of [ACCOUNTS.ops, ACCOUNTS.bd, ACCOUNTS.finance]) {
      const res = await http.post('/api/sync/run').set(auth(await login(http, u))).send(body);
      expect(res.status).toBe(403);
    }
  });

  it('有 system 菜单但店铺不在范围内：拒绝且不动数据', async () => {
    const mgr = await login(http, ACCOUNTS.opsManager);
    // 演示库里 shop 4 本来就有同步日志，只能比对新增量，不能断言「一条都没有」
    const before = countOf(`SELECT COUNT(*) AS c FROM sync_log WHERE shop_id = 4`);
    const res = await http.post('/api/sync/run').set(auth(mgr)).send({ task_type: 'order', shop_id: 4 });
    expect(res.status).toBe(404);
    expect(countOf(`SELECT COUNT(*) AS c FROM sync_log WHERE shop_id = 4`)).toBe(before);
    const mine = await http.post('/api/sync/run').set(auth(mgr)).send({ task_type: 'order', shop_id: 1 });
    expect(mine.status).toBe(200);
    expect(dataOf<{ summary: { fetched: number } }>(mine.body).summary.fetched).toBeGreaterThan(0);
  });

  it('无 shop_id 的批量同步与聚合只写入范围内店铺', async () => {
    const manager = await login(http, ACCOUNTS.opsManager);
    const managerId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.opsManager)?.id);
    const allowed = all<{ id: number }>(
      `SELECT DISTINCT s.id FROM tk_shop s
         JOIN sys_user_shop us ON us.shop_id = s.id AND us.is_deleted = 0
         JOIN sys_user member ON member.id = us.user_id AND member.is_deleted = 0
        WHERE s.is_deleted = 0 AND s.status = 1 AND s.auth_status = 1
          AND member.dept = (SELECT dept FROM sys_user WHERE id = ?)
        ORDER BY s.id`,
      managerId,
    ).map((r) => Number(r.id));
    const visible = all<{ id: number }>(
      `SELECT DISTINCT s.id FROM tk_shop s
         JOIN sys_user_shop us ON us.shop_id = s.id AND us.is_deleted = 0
         JOIN sys_user member ON member.id = us.user_id AND member.is_deleted = 0
        WHERE s.is_deleted = 0 AND member.dept = (SELECT dept FROM sys_user WHERE id = ?)
        ORDER BY s.id`,
      managerId,
    ).map((r) => Number(r.id));
    const outsider = get<{ id: number }>(
      `SELECT s.id FROM tk_shop s WHERE s.is_deleted = 0
        AND NOT EXISTS (SELECT 1 FROM sys_user_shop us JOIN sys_user member ON member.id = us.user_id
                         WHERE us.shop_id = s.id AND us.is_deleted = 0
                           AND member.dept = (SELECT dept FROM sys_user WHERE id = ?))
        ORDER BY s.id LIMIT 1`,
      managerId,
    );
    expect(allowed.length).toBeGreaterThan(0);
    expect(outsider).toBeTruthy();

    const firstLogId = Number(get<{ id: number }>(`SELECT IFNULL(MAX(id), 0) AS id FROM sync_log`)?.id ?? 0);
    const batch = await http.post('/api/sync/run').set(auth(manager)).send({
      task_type: 'order',
      window_start: '2099-01-01 00:00:00',
      window_end: '2099-01-01 00:15:00',
    });
    expect(batch.status).toBe(200);
    expect(dataOf<{ shop_ids: number[] }>(batch.body).shop_ids).toEqual(allowed);
    const batchLogs = all<{ shop_id: number | null }>(
      `SELECT shop_id FROM sync_log WHERE id > ? AND created_by = ? AND task_type = 'order'`,
      firstLogId,
      managerId,
    );
    expect(batchLogs.map((r) => Number(r.shop_id)).sort((a, b) => a - b)).toEqual(allowed);
    expect(batchLogs.some((r) => Number(r.shop_id) === Number(outsider!.id))).toBe(false);

    const listingId = insert('shop_listing', {
      shop_id: Number(outsider!.id),
      tk_sku_id: `SCOPE-OUTSIDE-${Date.now()}`,
      product_name: '范围外聚合回归样本',
      sale_price: 10,
      map_status: 1,
    });
    const aggregateLogId = Number(get<{ id: number }>(`SELECT IFNULL(MAX(id), 0) AS id FROM sync_log`)?.id ?? 0);
    const aggregate = await http.post('/api/sync/run').set(auth(manager)).send({ task_type: 'aggregate' });
    expect(aggregate.status).toBe(200);
    expect(dataOf<{ shop_ids: number[] }>(aggregate.body).shop_ids).toEqual(visible);
    expect(Number(get<{ map_status: number }>(`SELECT map_status FROM shop_listing WHERE id = ?`, listingId)?.map_status)).toBe(1);
    const aggregateLogs = all<{ shop_id: number | null }>(
      `SELECT shop_id FROM sync_log WHERE id > ? AND created_by = ? AND task_type = 'aggregate'`,
      aggregateLogId,
      managerId,
    );
    expect(aggregateLogs.length).toBe(visible.length);
    expect(aggregateLogs.every((r) => r.shop_id !== null && visible.includes(Number(r.shop_id)))).toBe(true);
  });

  it('未授权店铺不允许手动补跑，任务名也必须是白名单', async () => {
    const boss = await login(http, ACCOUNTS.boss);
    run(`UPDATE tk_shop SET auth_status = 0 WHERE id = 4`);
    expect((await http.post('/api/sync/run').set(auth(boss)).send({ task_type: 'order', shop_id: 4 })).status).toBe(400);
    run(`UPDATE tk_shop SET auth_status = 2 WHERE id = 4`);
    expect((await http.post('/api/sync/run').set(auth(boss)).send({ task_type: 'drop_table', shop_id: 4 })).status).toBe(400);
    expect((await http.get('/api/sync/logs?shop_id=4').set(auth(boss))).status).toBeLessThan(500);
  });
});

describe('卖家表格导入与结算对账', () => {
  const boss = () => login(http, ACCOUNTS.boss);

  it('表格导入与接口同步共用一套入库：重复导入不重复计行', async () => {
    const rows = [
      {
        order_id: 'CSV-0001', status: 'TO_BE_SHIPPED', order_time: '2026-09-10 01:00:00', currency: 'MYR',
        subtotal: 100, total_paid: 100, items: [{ seller_sku: 'NO-SUCH-SKU', quantity: 1, price: 100 }],
      },
    ];
    const res = await http.post('/api/sync/import/orders').set(auth(await boss())).send({ shop_id: SHOP, rows });
    expect(res.status).toBe(200);
    expect(dataOf<{ accepted: number; failed: unknown[] }>(res.body)).toMatchObject({ accepted: 1 });
    const again = await http.post('/api/sync/import/orders').set(auth(await boss())).send({ shop_id: SHOP, rows });
    const id = Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = 'CSV-0001'`)?.id);
    expect(id).toBeGreaterThan(0);
    expect(countOf(`SELECT COUNT(*) AS c FROM tk_order_item WHERE order_id = ?`, id)).toBe(1);
    const unbound = get<{ rebate_matched: number; rebate_cny: number; rebate_rate: number }>(
      `SELECT rebate_matched, rebate_cny, rebate_rate FROM tk_order_item WHERE order_id = ?`, id,
    );
    // 找不到内部 SKU → 没有返点率可冻结：整行退出钱口径（不是"返点 0 元"）
    expect([Number(unbound?.rebate_matched), Number(unbound?.rebate_cny), Number(unbound?.rebate_rate)]).toEqual([0, 0, 0]);
    expect(dataOf<{ run: { inserted: number; updated: number } }>(again.body).run.inserted).toBe(0);
    // 明细缺行直接判参数错误，不落半条订单
    expect((await http.post('/api/sync/import/orders').set(auth(await boss())).send({ shop_id: SHOP, rows: [{ order_id: 'CSV-0002', status: 'X' }] })).status).toBe(400);
  });

  it('导入路径同样冻结返点：rebate_cny = 实收折 CNY × SKU 返点率，物流 = 单件成本 × 件数', async () => {
    const listing = get<{ seller_sku: string; sku_id: number }>(
      `SELECT seller_sku, sku_id FROM shop_listing WHERE shop_id = ? AND sku_id IS NOT NULL AND IFNULL(seller_sku, '') <> '' ORDER BY id LIMIT 1`,
      SHOP,
    )!;
    const sku = get<{ rebate_rate: number; logistics_cost: number }>(`SELECT rebate_rate, logistics_cost FROM product_sku WHERE id = ?`, listing.sku_id)!;
    // 人民币单（汇率恒 1）：单价 50 × 2 件 = 实收 100；
    // 应收返点 = 100 × rebate_rate（seed 的 0.22 → 22）；物流 = logistics_cost × 2（seed 的 14 → 28）
    const res = await http.post('/api/sync/import/orders').set(auth(await boss())).send({
      shop_id: SHOP,
      rows: [
        {
          order_id: `CSV-REBATE-${Date.now()}`, status: 'COMPLETED', order_time: '2026-09-10 01:00:00', currency: 'CNY',
          subtotal: 100, total_paid: 100, items: [{ seller_sku: listing.seller_sku, quantity: 2, price: 50 }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const row = get<{ item_amount: number; quantity: number; rebate_matched: number; rebate_rate: number; rebate_cny: number; logistics_cny: number }>(
      `SELECT i.item_amount, i.quantity, i.rebate_matched, i.rebate_rate, i.rebate_cny, i.logistics_cny
         FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
        WHERE o.tk_order_id LIKE 'CSV-REBATE-%' LIMIT 1`,
    )!;
    expect(Number(row.item_amount)).toBe(100);
    expect(Number(row.rebate_matched)).toBe(1);
    expect(Number(row.rebate_rate)).toBe(sku.rebate_rate);
    expect(Number(row.rebate_cny)).toBe(rebateCny(round2(100 * rateOfOrder({ currency: 'CNY', order_time: '2026-09-10 01:00:00', paid_time: null })), sku.rebate_rate));
    expect(Number(row.logistics_cny)).toBe(round2(sku.logistics_cost * 2));
    // 汇率档位复核：CNY 恒 1，所以 100 元的实收折 CNY 还是 100 → 返点就是 100 × 返点率
    expect(rateOfOrder({ currency: 'CNY', order_time: '2026-09-10 01:00:00', paid_time: null })).toBe(1);
    expect(Number(row.rebate_cny)).toBe(round2(100 * sku.rebate_rate));
  });

  it('SKU 上没配返点率的行单独计入 rebate_unconfigured，且 sku_id 照实保留不写假快照', async () => {
    const listing = get<{ seller_sku: string; sku_id: number }>(
      `SELECT seller_sku, sku_id FROM shop_listing WHERE shop_id = ? AND sku_id IS NOT NULL AND IFNULL(seller_sku, '') <> '' ORDER BY id LIMIT 1`,
      SHOP,
    )!;
    const before = get<{ rebate_rate: number }>(`SELECT rebate_rate FROM product_sku WHERE id = ?`, listing.sku_id)!;
    const extId = `CSV-NORATE-${Date.now()}`;
    // 品牌还没谈下返点率：映射是好的（listing 已绑 SKU），缺的是比率
    run(`UPDATE product_sku SET rebate_rate = 0 WHERE id = ?`, listing.sku_id);
    try {
      const res = await http.post('/api/sync/import/orders').set(auth(await boss())).send({
        shop_id: SHOP,
        rows: [
          {
            order_id: extId, status: 'COMPLETED', order_time: '2026-09-10 01:00:00', currency: 'CNY',
            subtotal: 100, total_paid: 100, items: [{ seller_sku: listing.seller_sku, quantity: 1, price: 100 }],
          },
        ],
      });
      expect(res.status).toBe(200);
      const run0 = dataOf<{ run: SyncResult }>(res.body).run;
      // 两类"算不出返点"分开计数：建映射 vs 配返点率，运营要做的事不一样
      expect(Number(run0.detail.rebate_unconfigured ?? 0)).toBeGreaterThanOrEqual(1);
      expect(run0.failed).toBeGreaterThan(0);
      expect(Number(run0.detail.unmapped_items ?? 0)).toBe(0);

      const row = get<{ sku_id: number | null; rebate_matched: number; rebate_rate: number; rebate_cny: number; logistics_cny: number }>(
        `SELECT sku_id, rebate_matched, rebate_rate, rebate_cny, logistics_cny FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE o.tk_order_id = ?`,
        extId,
      )!;
      expect(row.sku_id).toBe(listing.sku_id); // 映射结果照实保留，不把行降级成"未映射"
      expect([Number(row.rebate_matched), Number(row.rebate_rate), Number(row.rebate_cny), Number(row.logistics_cny)]).toEqual([0, 0, 0, 0]);
    } finally {
      run(`UPDATE product_sku SET rebate_rate = ? WHERE id = ?`, before.rebate_rate, listing.sku_id);
      run(`DELETE FROM tk_order_item WHERE order_id = (SELECT id FROM tk_order WHERE tk_order_id = ?)`, extId);
      run(`DELETE FROM tk_order WHERE tk_order_id = ?`, extId);
    }
  });

  it('订单全局键已归属另一店铺时拒绝导入，且不改写原店订单', async () => {
    const orderId = `CROSS-SHOP-${Date.now()}`;
    insert('tk_order', {
      shop_id: SHOP,
      tk_order_id: orderId,
      order_status: 'COMPLETED',
      order_time: nowUtc(),
      currency: 'MYR',
      total_paid: 81,
      created_by: 1,
    } as never);

    const res = await http.post('/api/sync/import/orders').set(auth(await boss())).send({
      shop_id: 4,
      rows: [{ order_id: orderId, status: 'CANCELLED', total_paid: 1, items: [{ price: 1, quantity: 1 }] }],
    });

    expect(res.status).toBe(200);
    expect(dataOf<{ run: { inserted: number; updated: number; failed: number } }>(res.body).run).toMatchObject({ inserted: 0, updated: 0, failed: 1 });
    expect(get<{ shop_id: number; order_status: string; total_paid: number }>(
      `SELECT shop_id, order_status, total_paid FROM tk_order WHERE tk_order_id = ?`, orderId,
    )).toMatchObject({ shop_id: SHOP, order_status: 'COMPLETED', total_paid: 81 });
  });

  it('结算账单重复导入只更新金额，不产生第二条流水', async () => {
    const tkOrderId = 'CSV-0001';
    const row = { shop_id: SHOP, statement_id: 'ST-TEST-1', tk_order_id: tkOrderId, txn_type: 1, amount: 88, currency: 'MYR', payment_status: 1 };
    const first = await http.post('/api/finance/settlement/import').set(auth(await boss())).send({ rows: [row] });
    expect(first.status).toBe(200);
    expect(dataOf<{ inserted: number; updated: number }>(first.body)).toMatchObject({ inserted: 1, updated: 0 });
    const second = await http.post('/api/finance/settlement/import').set(auth(await boss())).send({ rows: [{ ...row, amount: 90 }] });
    expect(dataOf<{ inserted: number; updated: number }>(second.body)).toMatchObject({ inserted: 0, updated: 1 });
    expect(countOf(`SELECT COUNT(*) AS c FROM settlement_txn WHERE statement_id = 'ST-TEST-1' AND tk_order_id = ?`, tkOrderId)).toBe(1);
    expect(Number(get<{ amount: number }>(`SELECT amount FROM settlement_txn WHERE tk_order_id = ? AND statement_id = 'ST-TEST-1'`, tkOrderId)?.amount)).toBe(90);
  });

  it('越权店铺的账单行进 invalid 而不是写库', async () => {
    const mgr = await login(http, ACCOUNTS.opsManager);
    const res = await http.post('/api/finance/settlement/import').set(auth(mgr)).send({
      rows: [{ shop_id: 4, statement_id: 'ST-ESC-1', tk_order_id: 'CSV-0001', txn_type: 1, amount: 10, currency: 'SGD' }],
    });
    expect(res.status).toBe(200);
    const d = dataOf<{ inserted: number; invalid: { reason: string }[] }>(res.body);
    expect(d.inserted).toBe(0);
    expect(String(d.invalid[0]?.reason)).toContain('不在你的数据范围内');
    expect(countOf(`SELECT COUNT(*) AS c FROM settlement_txn WHERE statement_id = 'ST-ESC-1'`)).toBe(0);
  });

  it('逐单对账：差异能被拆解项解释，残差≈0；平台结算款不再进我们的利润', async () => {
    const res = await http.get('/api/finance/settlement/reconcile?only=settled&pageSize=50').set(auth(await boss()));
    expect(res.status).toBe(200);
    const d = dataOf<{ list: Record<string, number>[]; summary: Record<string, number> }>(res.body);
    expect(d.list.length).toBeGreaterThan(0);
    for (const r of d.list.slice(0, 30)) {
      expect(Number(r.has_settlement)).toBe(1);
      expect(Math.abs(Number(r.explain_residual_cny))).toBeLessThan(1);
      expect(r.stat_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 预估侧利润 = 冻结返点 − 冻结物流 − 预估佣金；结算侧只把支出换成平台实扣的达人佣金。
      // 两个式子里都没有 settled_cny —— 那是打进品牌店的钱，加进来就是把同一笔钱记两遍。
      expect(Number(r.est_profit_cny)).toBe(round2(Number(r.rebate_cny) - Number(r.logistics_cny) - Number(r.est_commission_cny)));
      expect(Number(r.settled_profit_cny)).toBe(round2(Number(r.rebate_cny) - Number(r.logistics_cny) - Number(r.settled_commission_cny)));
    }
    expect(Number(d.summary.settled_orders)).toBeGreaterThan(0);
    // 结算实收仍然单独出列（对账要用），但它没进上面任何一个利润式子
    expect(Number(d.summary.settled_cny)).toBeGreaterThan(0);
  });
});
