/**
 * TikTok real 模式：录制的平台报文 ↔ mock 报文 落库对拍（docs/dev-options.md 选项 10 / 任务 #42）
 *
 * 钉住的行为与「不钉住就会悄悄烂掉」的理由：
 *  1. real 模式的代码从写下那天起没被任何测试真正喂过一份**平台形态**的响应
 *     （shop-auth.spec 只验签名与错误分类，报文里的订单是 `{id:'o1'}` 这种空壳）。
 *     真实店铺联调被授权挡着，所以这里用录制的报文顶替：信封、snake_case、Money 对象、
 *     Unix 秒、next_page_token 翻页全按 realClient.ts 请求侧与 types.ts 声明的口径写。
 *  2. 唯一有价值的断言是**对拍**：同一批逻辑单据，一份走 mock 口语、一份走平台方言，
 *     两边都必须过同一套 syncJobs 入库代码，落出的 tk_order / tk_order_item / shop_listing /
 *     tk_return / 归因列必须逐列相同，四类任务的 fetched/inserted/updated/failed/detail 也必须相同。
 *     mock 与 real 分叉在生产上的表现是「利润数字错了但同步日志报成功」，那是要出事的。
 *  3. 分叉不许被抹平：现在就已经知道对不上的地方（平台订单主键是 id 不是 order_id、
 *     buyer_user_info 给 country_id、售后 item_id 是平台明细 ID、tracking 在 packages[] 里、
 *     金额可能是「分」、时间可能是 ISO-8601、联盟报文是嵌套的）一律写成 D1…D8 的**现状快照**，
 *     哪天有人修了映射，这些用例会红，逼着同步更新 docs/tiktok-real-mode-mapping.md。
 *  4. 凭证红线：上游报错里的 access_token / app_secret 值不能进 sync_log，也不能进接口响应；
 *     fixture 里不许出现形似真凭证的串。
 *
 * 全程离线：报文经 RealTikTokShopClient 的**注入桩传输**进来（RECORDED_BASE_URL 永不解析），
 * 真实联调只在最后的 skipIf 块里，缺 TT_APP_KEY / TT_APP_SECRET 时整块跳过。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeContentType, normalizeFulfillment, normalizeListingStatus, normalizeOrderStatus, normalizeReturnType } from '../src/services/tiktok/normalize.js';
import { TikTokApiError, RealTikTokShopClient } from '../src/services/tiktok/realClient.js';
import { MockTikTokShopClient } from '../src/services/tiktok/mockProvider.js';
import { flag, money, unixToUtc } from '../src/services/tiktok/types.js';
import type { PlatformOrder } from '../src/services/tiktok/types.js';
import { newCounters, orderHeadOf, runTask, upsertPlatformOrder, attributionOf } from '../src/jobs/syncJobs.js';
import { config } from '../src/config.js';
import { get } from '../src/core/db.js';
import { maskError } from '../src/core/redact.js';
import { ACCOUNTS, auth, boot, login, pageOf } from './helper.js';
import {
  FAKE,
  FIXTURE_DIR,
  TWIN_WINDOW,
  attributionSnapshot,
  countersOf,
  createTwinShop,
  diffFields,
  fakeCred,
  orderSnapshot,
  parseFixture,
  readFixture,
  recordedClient,
  replay,
  listingSnapshot,
  returnSnapshot,
  stubTransport,
  syncTwinShop,
  type Captured,
  type RealRecords,
  type TwinResults,
} from './realModeHarness.js';
import { recordTwinFixtures, type TwinManifest } from './realModeRecorder.js';

const { http } = boot();
const token: Record<string, string> = {};

/** 两家结构完全一致的店：M 走 mock 口语，R 走录制的平台报文 */
const shopM = createTwinShop('M');
const shopR = createTwinShop('R');
const captured: Captured = { orders: [], products: [], returns: [], affiliate: [] };

let manifest: TwinManifest = readManifest();
let mockResults!: TwinResults;
let realResults!: TwinResults;
let realRecords!: RealRecords;

function readManifest(): TwinManifest {
  try {
    return JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as TwinManifest;
  } catch {
    // 只有「第一次录制前」才会走到这里；对拍用例会被下面的清单闸门挡住，不会假装通过
    return { recorded_from: { shop_id: 0, window_to: '', orders: 0, returns: 0, products: 0, affiliate: 0 }, orders: [], returns: [], id_alias: {} };
  }
}

const twinRecords = (shopId: number): Promise<RealRecords> =>
  parseFixture(
    {
      orders: readFixture('twin-orders'),
      products: readFixture('twin-products'),
      returns: readFixture('twin-returns'),
      affiliate: readFixture('twin-affiliate'),
    },
    fakeCred(shopId),
    TWIN_WINDOW,
  );

/** 只跑 mock 侧（录制时不需要 real 侧，也就不会去读还没录出来的报文） */
let mockSetup: Promise<void> | null = null;
const populateMockSide = (): Promise<void> =>
  (mockSetup ??= (async () => {
    mockResults = await syncTwinShop(shopM, { capture: captured });
  })());

/** 两侧各同步四类任务，只跑一次（同一进程内 shopM 的行不能写两遍） */
let setup: Promise<void> | null = null;
const populate = (): Promise<void> =>
  (setup ??= (async () => {
    await populateMockSide();
    realRecords = await twinRecords(shopR);
    realResults = await syncTwinShop(shopR, { serve: realRecords });
  })());

/** 需要「两侧都已落库」的用例组各自的入口（-t 单独跑录制时不该顺带把 real 侧写一遍） */
const ensureBothSides = async (): Promise<void> => {
  await populate();
  manifest = readManifest();
};

beforeAll(async () => {
  token.boss = await login(http, ACCOUNTS.boss);
});

afterAll(() => {
  vi.restoreAllMocks();
});

/* ==================== 录制入口（默认跳过） ==================== */

describe('录制：mock 方言 → 平台报文（只在 TT_RECORD_FIXTURES=1 时执行）', () => {
  it.skipIf(!process.env.TT_RECORD_FIXTURES)('重新录制四类报文与配对清单', async () => {
    await populateMockSide();
    const m = recordTwinFixtures(shopM, TWIN_WINDOW.to, captured);
    writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
    expect(m.orders.length).toBeGreaterThan(0);
  });

  it('录制清单在位（不在位就先跑：TT_RECORD_FIXTURES=1 npx vitest run tests/real-mode.spec.ts -t 重新录制）', async () => {
    await ensureBothSides();
    expect(manifest.orders.length, 'manifest.json 缺失或为空').toBeGreaterThan(0);
    expect(manifest.orders.length).toBe(captured.orders.length);
    expect(manifest.returns.length).toBe(captured.returns.length);
  });
});

/* ==================== 落库对拍：同一批逻辑单据，两种方言 ==================== */

describe('real 报文 ↔ mock 报文落库对拍', () => {
  beforeAll(ensureBothSides);

  it('四类任务的计数口径一致（fetched/inserted/updated/failed/detail 就是运营看到的告警数）', () => {
    for (const task of ['listing', 'order', 'returns', 'affiliate_order'] as const) {
      const diffs = diffFields(countersOf(realResults[task]), countersOf(mockResults[task]));
      expect(diffs, `任务 ${task} 的同步计数分叉：${diffs.join('；')} —— 要么改了对拍台两侧任一侧，要么重跑录制`).toEqual([]);
    }
  });

  it('订单头 + 明细逐列一致（含 Money 对象 → REAL、Unix 秒 → UTC 文本、嵌套 tracking、样品单布尔）', () => {
    expect(manifest.orders.length).toBeGreaterThan(0);
    for (const pair of manifest.orders) {
      const diffs = diffFields(orderSnapshot(pair.real), orderSnapshot(pair.mock));
      expect(diffs, `订单 ${pair.mock} ↔ ${pair.real} 分叉：${diffs.join('；')}`).toEqual([]);
    }
  });

  it('归一化层同样一致：orderHeadOf 去掉身份列后逐列相同（不依赖数据库）', () => {
    const drop = ['shop_id', 'tk_order_id', 'synced_at'];
    for (let i = 0; i < manifest.orders.length; i++) {
      const real = orderHeadOf(shopR, realRecords.orders[i]!);
      const mock = orderHeadOf(shopM, captured.orders[i]!);
      const diffs = diffFields(
        Object.fromEntries(Object.entries(real).filter(([k]) => !drop.includes(k))),
        Object.fromEntries(Object.entries(mock).filter(([k]) => !drop.includes(k))),
      );
      expect(diffs, `orderHeadOf 第 ${i + 1} 单分叉：${diffs.join('；')}`).toEqual([]);
    }
  });

  it('listing 逐列一致（含 seller_sku 自动映射命中的内部 sku_id 与 map_status）', () => {
    const diffs = diffFields(listingSnapshot(shopR), listingSnapshot(shopM));
    expect(diffs, `shop_listing 分叉：${diffs.join('；')}`).toEqual([]);
    expect(listingSnapshot(shopM).length).toBeGreaterThan(0);
  });

  it('售后逐列一致（item 归属除外：见 D3）', () => {
    expect(manifest.returns.length).toBeGreaterThan(0);
    // 两店各自的单号换成同一个符号（#n），对拍的才是「同一笔逻辑售后」
    const tokenFor = (key: 'mock' | 'real') => {
      const map: Record<string, string> = {};
      manifest.orders.forEach((p, i) => {
        map[p[key]] = `#${i + 1}`;
      });
      return (tkOrderId: string | null): string => (tkOrderId === null ? '(无单)' : map[tkOrderId] ?? '(对拍外的单)');
    };
    const strip = (r: Record<string, unknown>): Record<string, unknown> => {
      const { item_matched: _m, item_sku: _s, ...rest } = r;
      return rest;
    };
    for (const pair of manifest.returns) {
      const diffs = diffFields(strip(returnSnapshot(pair.real, tokenFor('real'))), strip(returnSnapshot(pair.mock, tokenFor('mock'))));
      expect(diffs, `售后 ${pair.mock} ↔ ${pair.real} 分叉：${diffs.join('；')}`).toEqual([]);
    }
  });

  it('联盟归因逐列一致（达人 handle、内容形态、佣金率与预估佣金）', () => {
    const diffs = diffFields(attributionSnapshot(shopR), attributionSnapshot(shopM));
    expect(diffs, `归因后的 tk_order_item 分叉：${diffs.join('；')}`).toEqual([]);
    expect(attributionSnapshot(shopM).length).toBeGreaterThan(0);
  });

  it('归一化函数对两种方言的入参给出同一个值（状态 / 履约 / 商品状态 / 售后类型 / 内容形态）', () => {
    // 平台报文给的是原文枚举串，mock 有时给数字、有时给原文；这里把两边实际用到的形态都点一遍
    expect(normalizeFulfillment('FULFILLMENT_BY_PLATFORM')).toBe(1);
    expect(normalizeFulfillment(1)).toBe(normalizeFulfillment('FULFILLMENT_BY_PLATFORM'));
    expect(normalizeFulfillment('FULFILLMENT_BY_SELLER')).toBe(normalizeFulfillment(2));
    expect(normalizeListingStatus('ACTIVATED')).toBe(3);
    expect(normalizeListingStatus('DEACTIVATED')).toBe(4);
    expect(normalizeReturnType('RETURN_AND_REFUND')).toBe(2);
    expect(normalizeReturnType('ONLY_REFUND')).toBe(1);
    expect(normalizeContentType('LIVE', true)).toBe(2);
    expect(normalizeContentType('LIVE', false)).toBe(4);
    expect(normalizeContentType('PRODUCT_CARD', true)).toBe(5);
    expect(normalizeOrderStatus(undefined)).toBe('ON_HOLD');
    // 落库行的状态必须已经是归一化后的形态（real 报文不许把平台原文直接写进库）
    const statuses = new Set(manifest.orders.map((p) => String(orderSnapshot(p.real).order_status)));
    expect(statuses.size).toBeGreaterThan(0);
    for (const s of statuses) expect(s).toBe(normalizeOrderStatus(s));
  });
});

/* ==================== 信封 / 翻页 / 错误分类：报文是真的过了 real 客户端 ==================== */

describe('录制的报文确实走了 real 客户端的响应处理路径', () => {
  it('翻页：两页取完就停，第二页带上上一页的 next_page_token；订单条数等于两页之和', async () => {
    const pages = readFixture('twin-orders');
    const { client, stub } = recordedClient(pages);
    const orders = await client.getOrders(fakeCred(shopR), TWIN_WINDOW);
    expect(orders.length).toBe(manifest.orders.length);
    expect(stub.calls.map((c) => c.pageToken)).toEqual([null, 'PAGE-TOKEN-2']);
    expect(stub.calls.every((c) => c.signed && c.hasAppKey && c.tokenHeader)).toBe(true);
    expect(stub.calls.every((c) => c.path === '/order/202309/orders/search')).toBe(true);
  });

  it('商品用游标翻页（page_size=50），联盟接口不翻页只取一次', async () => {
    const rec = await twinRecords(9001);
    const products = rec.calls.filter((c) => c.path === '/product/202309/products/search');
    expect(products.length).toBe(2);
    expect(products.map((c) => c.pageToken)).toEqual([null, 'PAGE-TOKEN-2']);
    expect(products.every((c) => c.pageSize === '50')).toBe(true);
    expect(rec.calls.filter((c) => c.path === '/affiliate/202312/orders/search')).toHaveLength(1);
    expect(rec.products.length).toBe(manifest.recorded_from.products);
    expect(rec.affiliate.length).toBe(manifest.recorded_from.affiliate);
  });

  it('桩传输只回存脱敏后的调用摘要：url 里的 app_key 与 sign 不会被测试输出带出去', async () => {
    const stub = stubTransport(replay([{ code: 0, data: { orders: [] } }]));
    await new RealTikTokShopClient('https://recorded.invalid', stub.transport).getOrders(fakeCred(1), TWIN_WINDOW);
    expect(Object.keys(stub.calls[0]!).sort()).toEqual(['body', 'hasAppKey', 'pageSize', 'pageToken', 'path', 'signed', 'tokenHeader']);
    const dump = JSON.stringify(stub.calls);
    expect(dump).not.toContain(FAKE.appKey);
    expect(dump).not.toContain(FAKE.accessToken);
    expect(dump).not.toMatch(/sign=/);
  });

  it('离线保证：注入桩之后 globalThis.fetch 一次都不会被碰到', async () => {
    const spy = vi.fn(() => {
      throw new Error('不该出网');
    });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const rec = await twinRecords(9002);
      expect(rec.orders.length).toBe(manifest.orders.length);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('信封里的数组字段名：orders/products/returns/affiliate_orders 之外还认 list 兜底', async () => {
    const { client } = recordedClient([{ code: 0, message: 'success', data: { list: [{ order_id: 'L1' }, { order_id: 'L2' }], next_page_token: '' } }]);
    const orders = await client.getOrders(fakeCred(1), TWIN_WINDOW);
    expect(orders.map((o) => o.order_id)).toEqual(['L1', 'L2']);
  });

  it('平台 code≠0 翻译成人话，且不含任何凭证', async () => {
    const { client } = recordedClient([{ code: 105002, message: 'access token expired', request_id: 'rq-1' }]);
    const err = (await client.getOrders(fakeCred(1), TWIN_WINDOW).catch((e) => e)) as TikTokApiError;
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.message).toContain('授权令牌已过期');
    expect(err.message).not.toContain(FAKE.accessToken);
    expect(err.message).not.toContain(FAKE.appSecret);
  });

  it('游标不收敛时按 config.tiktokMaxPages 截断（上限不写死在代码里）', async () => {
    const limit = 3;
    const saved = config.tiktokMaxPages;
    config.tiktokMaxPages = limit;
    const stub = stubTransport(() => ({ body: { code: 0, data: { orders: [{ order_id: 'x' }], next_page_token: 'PAGE-TOKEN-LOOP' } } }));
    try {
      const orders = await new RealTikTokShopClient('https://recorded.invalid', stub.transport).getOrders(fakeCred(1), TWIN_WINDOW);
      expect(stub.calls).toHaveLength(limit);
      expect(orders).toHaveLength(limit);
    } finally {
      config.tiktokMaxPages = saved;
    }
  });

  it('传输层失败会重试到 config.tiktokMaxRetry 上限，错误文案只留 path 与原因', async () => {
    const saved = config.tiktokMaxRetry;
    config.tiktokMaxRetry = 1;
    const stub = stubTransport(() => ({ throws: new Error('connect ECONNREFUSED') }));
    try {
      const err = (await new RealTikTokShopClient('https://recorded.invalid', stub.transport)
        .getOrders(fakeCred(1), TWIN_WINDOW)
        .catch((e) => e)) as TikTokApiError;
      expect(err).toBeInstanceOf(TikTokApiError);
      expect(err.message).toContain('网络异常');
      expect(stub.calls).toHaveLength(2); // 首次 + 1 次重试
    } finally {
      config.tiktokMaxRetry = saved;
    }
  });
});

/* ==================== 已知分叉：真实店铺联调当天会咬人的地方 ==================== */

/** 手写报文 → 过一遍 real 客户端的响应处理路径 → 过一遍入库前的那段归一化（分叉观察在生产代码里，不是对拍台造的） */
async function landOrderRecord(order: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { client } = recordedClient([{ code: 0, data: { orders: [order], next_page_token: '' } }]);
  const [parsed] = await client.getOrders(fakeCred(shopR), TWIN_WINDOW);
  return orderHeadOf(shopR, parsed as PlatformOrder);
}

describe('已知分叉 D1…D8（现状快照：修了映射这些用例会红，逼着同步改映射文档）', () => {
  beforeAll(ensureBothSides);

  it('D1 平台订单主键是 id：当前映射只认 order_id，整单直接落库失败', async () => {
    const { client } = recordedClient([{ code: 0, data: { orders: [{ id: '574110000999999', status: 'TO_BE_SHIPPED', currency: 'USD' }], next_page_token: '' } }]);
    const [parsed] = await client.getOrders(fakeCred(shopR), TWIN_WINDOW);
    expect(parsed.order_id).toBeUndefined(); // 报文里有 id，但我们声明的字段叫 order_id
    expect(() => upsertPlatformOrder(shopR, parsed, newCounters())).toThrow(/缺少 order_id/);
    // 补一行别名映射（order_id ← id）就能落，说明缺口很薄 —— 但必须补，否则 real 模式一单都进不来
    const head = orderHeadOf(shopR, { ...parsed, order_id: String((parsed as Record<string, unknown>).id ?? '') });
    expect(head.tk_order_id).toBe('574110000999999');
  });

  it('D2 buyer_user_info 给 country_id / region_id：buyer_region 会落成 NULL', async () => {
    const head = await landOrderRecord({
      order_id: '574110000999901',
      status: 'TO_BE_SHIPPED',
      currency: 'USD',
      buyer_user_info: { country_id: 'US', region_id: 'California', city_name: 'Los Angeles' },
    });
    expect(head.buyer_region).toBeNull();
  });

  it('D3 售后 item_id 是平台明细 ID：本地行归属拿不到（mock 发的是本地行 ID，所以从没有暴露过）', () => {
    const pair = manifest.returns[0]!;
    const mockRow = get<{ tk_order_item_id: number | null }>(`SELECT tk_order_item_id FROM tk_return WHERE tk_return_id = ?`, pair.mock);
    const realRow = get<{ tk_order_item_id: number | null }>(`SELECT tk_order_item_id FROM tk_return WHERE tk_return_id = ?`, pair.real);
    expect(mockRow?.tk_order_item_id).not.toBeNull();
    expect(realRow?.tk_order_item_id).toBeNull();
    // 两条售后金额本身是一致的，丢的只是「这笔退款算在哪个明细行上」
    expect(Number(realRow && returnSnapshot(pair.real, () => '').refund_amount)).toBe(Number(returnSnapshot(pair.mock, () => '').refund_amount));
  });

  it('D4 物流在 packages[].tracking_info 里：carrier / tracking_no 会落成 NULL', async () => {
    const head = await landOrderRecord({
      order_id: '574110000999902',
      status: 'SHIPPED',
      currency: 'USD',
      packages: [{ tracking_info: { tracking_no: 'JT000000123', courier_name: { name: 'J&T Express' } } }],
    });
    expect(head.tracking_no).toBeNull();
    expect(head.carrier).toBeNull();
    expect(head.order_status).toBe('TRANSIT_TO_SHIP'); // 状态这条是对的，丢的只有运单
  });

  it('D5 时间是 ISO-8601 带偏移时当前只认 Unix 秒：order_time 落成 NULL', async () => {
    expect(unixToUtc('2026-09-10T10:30:00+08:00')).toBeNull();
    const head = await landOrderRecord({ order_id: '574110000999903', status: 'TO_BE_SHIPPED', currency: 'USD', create_time: '2026-09-10T10:30:00+08:00' });
    expect(head.order_time).toBeNull();
  });

  it('D6 金额给「分」（minor units）时不猜尺度：会按面值放大 100 倍入库', () => {
    expect(money({ amount: '4590', currency: 'USD' })).toBe(4590); // 报文层无从判断是 45.90 还是 4590
    expect(money({ amount: '45.90', currency: 'USD' })).toBe(45.9);
    expect(money('45.90')).toBe(45.9);
    expect(money(45.9)).toBe(45.9);
  });

  it('D7 联盟报文真实结构是 data.orders[].order_item_pairs[]：当前取不到就是静默 0 条', async () => {
    const { client } = recordedClient([
      { code: 0, data: { orders: [{ order_id: '574110000999904', order_item_pairs: [{ order_item_id: '1', affiliate_creator_id: '7000001' }] }], next_page_token: '' } },
    ]);
    const list = await client.getAffiliateOrders(fakeCred(shopR), TWIN_WINDOW);
    expect(list).toEqual([]); // 没报错，也没归因 —— 联调时最容易出现「佣金全 0」的假象
  });

  it('D8 平台给了但本地没有列的东西：库存、主图、类目、佣金金额，一律落不进库', () => {
    const cols = new Set((get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'shop_listing'`)?.sql ?? '').split(/[\s(,)]/).filter(Boolean));
    expect(cols.has('stock')).toBe(false);
    expect(cols.has('main_image')).toBe(false);
    // 佣金按「费率 × 明细金额」算，报文里的 seller_commission_amount 直接丢弃
    const patch = attributionOf({ content_type: 'VIDEO', seller_commission_rate: 10, seller_commission_amount: { amount: '999.00', currency: 'USD' } }, { id: 1, item_amount: 100 });
    expect(patch.est_commission).toBe(10);
  });
});

/* ==================== 方言容错：同一列的多种平台写法必须归到同一个值 ==================== */

describe('方言容错（realClient/types 声明的宽松形态）', () => {
  const base = { order_id: '574110000888001', status: 'TO_BE_SHIPPED', currency: 'USD' };

  it('卖家优惠：seller_discount 缺失时退到 discount_amount；实付缺失时用 小计-优惠+运费', async () => {
    const withDiscount = await landOrderRecord({ ...base, products_amount: { amount: '100.00', currency: 'USD' }, discount_amount: { amount: '10.00', currency: 'USD' }, shipping_fee: { amount: '5.00', currency: 'USD' } });
    expect(withDiscount.seller_discount).toBe(10);
    expect(withDiscount.total_paid).toBe(95); // 100 - 10 + 5
    const withPaid = await landOrderRecord({ ...base, total_amount: { amount: '120.00', currency: 'USD' } });
    expect(withPaid.total_paid).toBe(120);
  });

  it('明细优惠：item_discount 是 seller_discount 的别名；币种缺失时按订单币种兜底', async () => {
    const { client } = recordedClient([
      {
        code: 0,
        data: {
          orders: [{ ...base, currency: 'USD', items: [{ id: 'i1', sku_id: '2288710001', quantity: 2, price: { amount: '10.00', currency: 'USD' }, item_discount: { amount: '3.00', currency: 'USD' } }] }],
          next_page_token: '',
        },
      },
    ]);
    const [o] = await client.getOrders(fakeCred(shopR), TWIN_WINDOW);
    const it = o!.items?.[0];
    expect(money(it!.seller_discount ?? it!.item_discount)).toBe(3);
    expect(flag(1)).toBe(flag(true));
    expect(flag('true')).toBe(1);
  });

  it('状态原文：ON_HOLD_SUBSTATUS_* 归到 ON_HOLD，PAYMENT_PENDING 归到 UNPAID，未知原文原样留', async () => {
    for (const [raw, want] of [
      ['ON_HOLD_SUBSTATUS_ESCALATION', 'ON_HOLD'],
      ['PAYMENT_PENDING', 'UNPAID'],
      ['PACKAGE_DELIVERED', 'DELIVERED'],
      ['', 'ON_HOLD'],
      ['INSUFFICIENT_STOCK_REPLACEMENT', 'INSUFFICIENT_STOCK_REPLACEMENT'],
    ] as const) {
      const head = await landOrderRecord({ ...base, status: raw });
      expect(head.order_status).toBe(want);
    }
  });

  it('币种小写、地区超长都要被收进列宽（currency 3 位、buyer_region 8 位）', async () => {
    const head = await landOrderRecord({ ...base, currency: 'usd', buyer_user_info: { country: 'Metro Manila NCR' } });
    expect(head.currency).toBe('USD');
    expect(String(head.buyer_region).length).toBeLessThanOrEqual(8);
  });
});

/* ==================== 凭证红线 ==================== */

/** 64 位十六进制形似真值，但 DEADBEEF 重复串一眼就知道是占位 */
const LEAK_TOKEN = `access_token=${'DEADBEEF'.repeat(8)}`;
const LEAK_APP_SECRET = 'app_secret=SECRET-FAKE-PLACEHOLDER';

describe('凭证不出现在日志与响应里', () => {
  it('上游报错文本里的 access_token 值进不了 sync_log，也进不了接口响应', async () => {
    const proto = MockTikTokShopClient.prototype as unknown as Record<string, unknown>;
    const original = proto.getOrders;
    proto.getOrders = async () => {
      throw new Error(`平台回显入参：${LEAK_TOKEN}&${LEAK_APP_SECRET}&sign=abc123`);
    };
    let result;
    try {
      [result] = await runTask('order', shopM, { windowStart: '2026-01-01 00:00:00', windowEnd: '2026-01-02 00:00:00' });
    } finally {
      proto.getOrders = original;
    }
    expect(result?.status).toBe(3);
    expect(String(result?.error_msg)).toContain('平台回显入参');
    expect(String(result?.error_msg)).not.toContain('DEADBEEF');
    const stored = get<{ error_msg: string }>(`SELECT error_msg FROM sync_log WHERE id = ?`, Number(result?.log_id));
    expect(String(stored?.error_msg)).not.toContain('DEADBEEF');
    expect(String(stored?.error_msg)).not.toContain('SECRET-FAKE-PLACEHOLDER');
    const res = await http.get(`/api/system/synclog?shop_id=${shopM}&task_type=order`).set(auth(token.boss));
    expect(res.status).toBe(200);
    expect(JSON.stringify(pageOf(res.body).list)).not.toContain('DEADBEEF');
  });

  it('real 客户端自己那层也拦：网络异常里带的凭证不会漏进异常文案', async () => {
    const cred = fakeCred(shopR);
    const stub = stubTransport(() => ({ throws: new Error(`拨号失败 ?${LEAK_TOKEN}&${LEAK_APP_SECRET}&access_key=${cred.appKey}`) }));
    const err = (await new RealTikTokShopClient('https://recorded.invalid', stub.transport)
      .getOrders(cred, TWIN_WINDOW)
      .catch((e) => e)) as TikTokApiError;
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.message).toContain('网络异常');
    expect(err.message).not.toContain('DEADBEEF');
    expect(err.message).not.toContain(FAKE.appSecret);
    expect(err.message).not.toContain(FAKE.appKey);
    // 再过一遍出口口径（maskError）也不该出现任何凭证形态的串
    expect(maskError(err.message)).toBe(err.message);
  });

  it('fixture 目录里没有任何形似真凭证的串（32 位以上长串 / 凭证类字段名）', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const text = readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
      expect(text, `${f} 出现了长串疑似凭证`).not.toMatch(/[A-Za-z0-9_-]{32,}/);
      expect(text, `${f} 出现了凭证字段名`).not.toMatch(/access_token|app_secret|app_key|"sign"/i);
    }
  });

  it('报文的 request_id / 游标都是占位值', () => {
    const pages = readFixture('twin-orders');
    expect(JSON.stringify(pages)).toContain('PAGE-TOKEN-2');
    expect(JSON.stringify(pages)).not.toMatch(/eyJ[A-Za-z0-9+/=]{20,}/); // 真实游标是长 base64，出现就说明有人塞了真报文
  });
});

/* ==================== 真实店铺联调冒烟：默认整块跳过 ==================== */

describe.skipIf(!process.env.TT_APP_KEY || !process.env.TT_APP_SECRET)('真实店铺联调冒烟（只读，缺凭证时永不执行）', () => {
  it('商品接口读一页，只打印条数', async () => {
    const accessToken = process.env.TT_ACCESS_TOKEN;
    expect(accessToken, '联调还需要 TT_ACCESS_TOKEN（按店铺的 access token）').toBeTruthy();
    const cred = fakeCred(shopR, {
      appKey: String(process.env.TT_APP_KEY),
      appSecret: String(process.env.TT_APP_SECRET),
      accessToken: String(accessToken),
      shopCipher: process.env.TT_SHOP_CIPHER ?? null,
    });
    const page = await new RealTikTokShopClient().getProducts(cred, null);
    // 只报计数，不打报文：真实店铺的商品标题/图片 URL 不该出现在 CI 日志里
    console.log(`[real-smoke] baseUrl=${config.tiktokBaseUrl} products=${page.products.length} hasNext=${Boolean(page.nextCursor)}`);
    expect(page.products.length).toBeGreaterThanOrEqual(0);
    const first = page.products[0] as Record<string, unknown> | undefined;
    if (first) {
      // 平台主键字段是 id：这里失败就说明 D1 已经修好，同步更新映射文档与对拍用例
      expect(Object.keys(first)).toContain('id');
      expect(first.status ?? first.main_status).toBeTruthy();
    }
  });
});
