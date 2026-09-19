import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_LABEL } from '@tk/shared';
import { activeShopIds, normalizeFulfillment, normalizeOrderStatus, refreshDerivedAggregates, resolveWindow, runTask, type SyncResult } from '../src/jobs/syncJobs.js';
import { MockTikTokShopClient } from '../src/services/tiktok/mockProvider.js';
import { get, insert, run } from '../src/core/db.js';
import { config } from '../src/config.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';

/**
 * 数据同步与财务结算的自动化回归（开发文档要求：同步 / 财务 / 预警三条链路必须有测试）。
 * 全程 mock 模式，不发任何外网请求；断言集中在幂等、留痕、失败告警与「不重复计钱」。
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

  it('找不到内部 SKU 的明细计入 failed 并让日志变「部分失败」，绝不静默按 0 成本', async () => {
    expect(first.status).toBe(2);
    expect(first.detail.unmapped_items ?? 0).toBeGreaterThan(0);
    const unmapped = countOf(`SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE o.shop_id = ? AND i.cost_matched = 0`, SHOP);
    expect(unmapped).toBeGreaterThan(0);
    // 这些行不参与成本/利润口径
    const listed = pageOf((await http.get(`/api/orders?shop_id=${SHOP}&only_unmapped=1&pageSize=50`).set(auth(await login(http, ACCOUNTS.boss)))).body);
    expect(listed.total).toBeGreaterThan(0);
  });

  it('成本快照冻结：改 SKU 采购成本不回溯历史明细', async () => {
    const row = get<{ id: number; sku_id: number; cost_snapshot: number }>(
      `SELECT i.id, i.sku_id, i.cost_snapshot FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
        WHERE o.shop_id = ? AND i.cost_matched = 1 AND i.cost_snapshot > 0 LIMIT 1`,
      SHOP,
    );
    expect(row).toBeTruthy();
    run(`UPDATE product_sku SET purchase_cost = purchase_cost + 999 WHERE id = ?`, row!.sku_id);
    await runTask('order', SHOP, WIN);
    expect(Number(get<{ cost_snapshot: number }>(`SELECT cost_snapshot FROM tk_order_item WHERE id = ?`, row!.id)?.cost_snapshot)).toBe(row!.cost_snapshot);
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
    insert('tk_order_item', { order_id: oid, item_amount: 10, cost_matched: 1 });
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

  it('映射补齐后跑 aggregate：历史待映射行回填成本快照并留操作日志', () => {
    const sku = get<{ id: number; purchase_cost: number; first_leg_cost: number }>(
      `SELECT id, purchase_cost, first_leg_cost FROM product_sku WHERE is_deleted = 0 LIMIT 1`,
    );
    const listing = insert('shop_listing', { shop_id: SHOP, sku_id: null, tk_sku_id: 'AGG-TEST-SKU', tk_product_id: 'AGG-TEST-P', seller_sku: 'AGG-TEST', product_name: '待映射', sale_price: 99, map_status: 2 });
    const order = insert('tk_order', { shop_id: SHOP, tk_order_id: 'AGG-TEST-ORDER', order_status: 'COMPLETED', order_time: nowUtc(), currency: 'MYR', total_paid: 99 });
    const item = insert('tk_order_item', { order_id: order, listing_id: listing, item_amount: 99, quantity: 2, cost_matched: 0 });

    const r = refreshDerivedAggregates({ user_id: 1 });
    expect(r.status).toBe(1);
    // listing 状态自愈 + 明细回填
    expect(Number(get<{ map_status: number }>(`SELECT map_status FROM shop_listing WHERE id = ?`, listing)?.map_status)).toBe(2);
    const after = get<Record<string, unknown>>(`SELECT sku_id, cost_matched, cost_snapshot FROM tk_order_item WHERE id = ?`, item);
    run(`UPDATE shop_listing SET sku_id = ?, map_status = 1 WHERE id = ?`, sku!.id, listing);
    const r2 = refreshDerivedAggregates({ user_id: 1 });
    expect(Number(r2.detail.item_backfilled)).toBeGreaterThanOrEqual(1);
    expect(Number(get<{ cost_matched: number }>(`SELECT cost_matched FROM tk_order_item WHERE id = ?`, item)?.cost_matched)).toBe(1);
    expect(Number(get<{ cost_snapshot: number }>(`SELECT cost_snapshot FROM tk_order_item WHERE id = ?`, item)?.cost_snapshot))
      .toBe(Math.round(((sku!.purchase_cost + sku!.first_leg_cost) * 2 + Number.EPSILON) * 100) / 100);
    expect(after?.cost_matched).toBe(0);
    const log = get<Record<string, unknown>>(`SELECT before_after FROM sys_op_log WHERE target_table = 'tk_order_item' AND target_id = ? ORDER BY id DESC LIMIT 1`, item);
    expect(String(log?.before_after)).toContain('映射补齐');
  });

  it('aggregate 幂等：第二次跑不再回填、不新增日志行以外的变化', () => {
    const before = countOf(`SELECT COUNT(*) AS c FROM tk_order_item WHERE cost_matched = 1`);
    const r = refreshDerivedAggregates();
    expect(Number(r.detail.item_backfilled)).toBe(0);
    expect(countOf(`SELECT COUNT(*) AS c FROM tk_order_item WHERE cost_matched = 1`)).toBe(before);
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
    expect(Number(get<{ cost_matched: number }>(`SELECT cost_matched FROM tk_order_item WHERE order_id = ?`, id)?.cost_matched)).toBe(0);
    expect(dataOf<{ run: { inserted: number; updated: number } }>(again.body).run.inserted).toBe(0);
    // 明细缺行直接判参数错误，不落半条订单
    expect((await http.post('/api/sync/import/orders').set(auth(await boss())).send({ shop_id: SHOP, rows: [{ order_id: 'CSV-0002', status: 'X' }] })).status).toBe(400);
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

  it('逐单对账：差异能被拆解项解释，残差≈0', async () => {
    const res = await http.get('/api/finance/settlement/reconcile?only=settled&pageSize=50').set(auth(await boss()));
    expect(res.status).toBe(200);
    const d = dataOf<{ list: Record<string, unknown>[]; summary: Record<string, number> }>(res.body);
    expect(d.list.length).toBeGreaterThan(0);
    for (const r of d.list.slice(0, 30)) {
      expect(Number(r.has_settlement)).toBe(1);
      expect(Math.abs(Number(r.explain_residual_cny))).toBeLessThan(1);
      expect(r.stat_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(Number(d.summary.settled_orders)).toBeGreaterThan(0);
  });
});
