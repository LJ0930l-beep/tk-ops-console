/**
 * TikTok real 模式离线对拍台（docs/dev-options.md 选项 10 / 任务 #42）
 *
 * 这里只做三件事，全部不碰网络：
 *  1. `recordedClient()` —— 把「录下来的平台报文」从 real 客户端的响应处理路径里灌进去
 *     （信封 code/message、data 里的数组字段名、next_page_token 翻页、错误分类、safe() 脱敏都真实走到）；
 *  2. `parseFixture()` —— 报文 → Platform* 原始结构，等价于「真店铺当天返回的东西」；
 *  3. `syncTwinShop()` —— 让同一份逻辑单据以两种方言（mock 口语 / 平台报文）各落一次库，
 *     走的是同一套 syncJobs 入库函数，产出的行可以逐列对拍。
 *
 * 为什么要有这套东西：real 模式从未与真实店铺联调（缺授权），而 mock 是「我们自己写的方言」。
 * 两边各自解释字段时，任何一列口径漂移都要到生产同步那天才暴露 —— 那就是利润数字错了还查不出为什么。
 *
 * 红线：桩传输只回存脱敏后的调用摘要（url 里带 app_key 与 sign），凭证一律是显眼的占位串。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { all, get, insert } from '../src/core/db.js';
import { MockTikTokShopClient } from '../src/services/tiktok/mockProvider.js';
import { RealTikTokShopClient, type RawResponse, type Transport, type TransportInit } from '../src/services/tiktok/realClient.js';
import type { ProductPage, ShopCredential } from '../src/services/tiktok/client.js';
import type { PlatformAffiliateOrder, PlatformOrder, PlatformProduct, PlatformReturn } from '../src/services/tiktok/types.js';
import { runTask, type SyncResult, type SyncTaskType } from '../src/jobs/syncJobs.js';

/* ==================== 报文（fixtures/tiktok-real/*.json） ==================== */

export const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tiktok-real/', import.meta.url));

/** 一份 fixture = 一串响应体（多页就是一个元素一页），顺序即返回顺序 */
export type EnvelopePages = Record<string, unknown>[];

export const fixturePath = (name: string): string => path.join(FIXTURE_DIR, `${name}.json`);

export function readFixture(name: string): EnvelopePages {
  const raw = readFileSync(fixturePath(name), 'utf8');
  const parsed = JSON.parse(raw) as EnvelopePages | Record<string, unknown>;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function writeFixture(name: string, pages: EnvelopePages): void {
  // 录制产物要能直接读，所以固定 2 空格缩进 + 结尾换行
  writeFileSync(fixturePath(name), `${JSON.stringify(pages, null, 2)}\n`, 'utf8');
}

/* ==================== 桩传输（永不外呼） ==================== */

/** 假到不可能真：32 位以上的十六进制串一律不许出现在 fixture 与凭证里 */
export const FAKE = {
  appKey: 'AK-FAKE-PLACEHOLDER',
  appSecret: 'SECRET-FAKE-PLACEHOLDER',
  accessToken: 'TOKEN-FAKE-PLACEHOLDER',
  shopCipher: 'CIPHER-FAKE-PLACEHOLDER',
} as const;

/** 永不解析的域名：万一哪天有人把桩传输换成真 fetch，它会以 DNS 失败暴露，而不是悄悄打到平台 */
export const RECORDED_BASE_URL = 'https://recorded.invalid';

/** 一次调用的脱敏摘要（刻意不含完整 url / sign / app_key） */
export interface StubCall {
  path: string;
  pageSize: string | null;
  pageToken: string | null;
  body: string;
  tokenHeader: boolean;
  signed: boolean;
  hasAppKey: boolean;
}

export interface StubResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 模拟连接层失败（DNS 挂了 / 连接被重置），走的是客户端的 catch 分支 */
  throws?: Error;
}

export interface Stub {
  transport: Transport;
  calls: StubCall[];
}

/** 按顺序回放报文；页用完还继续要，说明客户端没在 next_page_token 变空时停下来 —— 直接判失败 */
export function replay(pages: EnvelopePages): (callIndex: number) => StubResult {
  return (n: number) => {
    const page = pages[n];
    if (page === undefined) throw new Error(`桩传输被要多一页（第 ${n + 1} 页），但 fixture 只有 ${pages.length} 页：翻页没在游标取空时停下`);
    return { body: page };
  };
}

export function stubTransport(responder: (callIndex: number) => StubResult): Stub {
  const calls: StubCall[] = [];
  const transport: Transport = async (url: string, init: TransportInit): Promise<RawResponse> => {
    const u = new URL(url);
    const params = u.searchParams;
    // 先记录（下标 = 本次调用序号），再取报文
    calls.push({
      path: u.pathname,
      pageSize: params.get('page_size'),
      pageToken: params.get('page_token'),
      body: init.body ?? '',
      tokenHeader: Boolean(init.headers['x-tts-access-token']),
      signed: Boolean(params.get('sign')),
      hasAppKey: Boolean(params.get('app_key')),
    });
    const r = responder(calls.length - 1);
    if (r.throws) throw r.throws;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const headers = new Map(Object.entries(r.headers ?? {}));
    return {
      status: r.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => text,
    };
  };
  return { transport, calls };
}

/** 假凭证：real 客户端只校验「有没有」，签名与 header 照常走，值全是占位串 */
export function fakeCred(shopId: number, over: Partial<ShopCredential> = {}): ShopCredential {
  return {
    shopId,
    shopName: `对拍店铺 #${shopId}`,
    tkShopId: `749${String(shopId).padStart(6, '0')}`,
    shopCipher: FAKE.shopCipher,
    appKey: FAKE.appKey,
    appSecret: FAKE.appSecret,
    accessToken: FAKE.accessToken,
    currency: 'USD',
    region: 'US',
    timezone: 'America/Los_Angeles',
    ...over,
  };
}

export function recordedClient(pages: EnvelopePages): { client: RealTikTokShopClient; stub: Stub } {
  const stub = stubTransport(replay(pages));
  return { client: new RealTikTokShopClient(RECORDED_BASE_URL, stub.transport), stub };
}

/* ==================== 报文 → Platform 原始结构 ==================== */

export interface RealRecords {
  orders: PlatformOrder[];
  products: PlatformProduct[];
  returns: PlatformReturn[];
  affiliate: PlatformAffiliateOrder[];
  calls: StubCall[];
}

/**
 * 把四类 fixture 真过一遍 real 客户端的响应处理路径（不是直接反序列化成对象）：
 * 信封解包、data 里的数组字段名、游标翻页、has_more，全在这里被走一遍。
 */
export async function parseFixture(
  envelopes: { orders: EnvelopePages; products: EnvelopePages; returns: EnvelopePages; affiliate: EnvelopePages },
  cred: ShopCredential,
  window: { from: string; to: string },
): Promise<RealRecords> {
  const calls: StubCall[] = [];
  const o = recordedClient(envelopes.orders);
  const orders = await o.client.getOrders(cred, window);
  calls.push(...o.stub.calls);

  const p = recordedClient(envelopes.products);
  const products: PlatformProduct[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < config.tiktokMaxPages; page++) {
    const res = await p.client.getProducts(cred, cursor ?? null);
    products.push(...res.products);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  calls.push(...p.stub.calls);

  const r = recordedClient(envelopes.returns);
  const returns = await r.client.getReturns(cred, window);
  calls.push(...r.stub.calls);

  const a = recordedClient(envelopes.affiliate);
  const affiliate = await a.client.getAffiliateOrders(cred, window);
  calls.push(...a.stub.calls);

  return { orders, products, returns, affiliate, calls };
}

/* ==================== 对拍用的两家「同构店铺」 ==================== */

/** 对拍窗口：mock 的输出只由「店铺 + window.to」决定，钉住窗口就钉住了数据 */
export const TWIN_WINDOW = { from: '2026-09-10 00:00:00', to: '2026-09-10 12:00:00' };
export const TWIN_SYNC_OPTS = { windowStart: TWIN_WINDOW.from, windowEnd: TWIN_WINDOW.to };

/** 两店内部主数据/平台 ID 完全一致，落库结果才可比（价格刻意带零头，能抓出四舍五入分叉） */
export const TWIN_LISTINGS = [
  { tkProductId: '2288700001', tkSkuId: '2288710001', name: '对拍商品一', salePrice: 45.9 },
  { tkProductId: '2288700002', tkSkuId: '2288710002', name: '对拍商品二', salePrice: 88.55 },
] as const;

const ownerId = (): number => Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = 'boss'`)?.id ?? 0);

/** 建一家干净店铺（自己插 2 条已映射 listing，不依赖演示库里哪几条恰好是已映射的） */
export function createTwinShop(tag: string): number {
  const shopId = insert('tk_shop', {
    shop_name: `对拍店 ${tag}`,
    region: 'US',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    shop_type: 1,
    auth_status: 1,
    status: 1,
    owner_id: ownerId(),
  });
  const skus = all<{ id: number; sku_code: string }>(
    `SELECT id, sku_code FROM product_sku WHERE is_deleted = 0 AND status = 1 AND purchase_cost > 0 ORDER BY id ASC LIMIT 2`,
  );
  if (skus.length !== TWIN_LISTINGS.length) throw new Error(`演示库的内部 SKU 不足 ${TWIN_LISTINGS.length} 条，对拍前提不成立`);
  TWIN_LISTINGS.forEach((l, i) => {
    insert('shop_listing', {
      shop_id: shopId,
      sku_id: skus[i]!.id,
      tk_product_id: l.tkProductId,
      tk_sku_id: l.tkSkuId,
      seller_sku: skus[i]!.sku_code,
      product_name: l.name,
      sale_price: l.salePrice,
      listing_status: 3,
      map_status: 1,
    });
  });
  return shopId;
}

/* ==================== 两侧同步：同一套入库代码，两种报文方言 ==================== */

export interface Captured {
  orders: PlatformOrder[];
  products: PlatformProduct[];
  returns: PlatformReturn[];
  affiliate: PlatformAffiliateOrder[];
}

/**
 * 给一个店跑完四类任务（顺序与 runTask('all') 一致：商品 → 订单 → 售后 → 联盟）。
 *
 * `serve` 传了就把 MockTikTokShopClient 的对应方法换成真实报文解析出来的记录
 * —— 换的是「数据源」，不是入库代码，所以 real 侧与 mock 侧共用 syncJobs 那一套 upsert 与计数。
 * `capture` 传了则相反：把 mock 的原始返回抄一份出来，供录制器改写成平台方言。
 * 两者都只对传入的那家店铺生效，其它店（含演示数据）走的还是原实现。
 */
type CaptureKey = 'orders' | 'products' | 'returns' | 'affiliate';
type MockMethod = (this: MockTikTokShopClient, ...args: unknown[]) => unknown;

const METHOD_OF: Record<CaptureKey, string> = {
  orders: 'getOrders',
  products: 'getProducts',
  returns: 'getReturns',
  affiliate: 'getAffiliateOrders',
};
const CAPTURE_KEYS = Object.keys(METHOD_OF) as CaptureKey[];
const TASK_OF: Record<CaptureKey, SyncTaskType> = {
  products: 'listing',
  orders: 'order',
  returns: 'returns',
  affiliate: 'affiliate_order',
};

export type TwinResults = Record<SyncTaskType, SyncResult>;

export async function syncTwinShop(shopId: number, opts: { serve?: RealRecords; capture?: Captured } = {}): Promise<TwinResults> {
  const { serve, capture } = opts;
  const proto = MockTikTokShopClient.prototype as unknown as Record<string, MockMethod | undefined>;
  const saved = {} as Record<CaptureKey, MockMethod | undefined>;
  for (const key of CAPTURE_KEYS) {
    const method = METHOD_OF[key];
    saved[key] = proto[method];
    if (!serve && !capture) continue;
    proto[method] = async function (this: MockTikTokShopClient, ...args: unknown[]): Promise<unknown> {
      const [shop, ...rest] = args as [ShopCredential, ...unknown[]];
      const original = saved[key] as MockMethod;
      if (shop.shopId !== shopId) return original.apply(this, [shop, ...rest]);
      if (serve) return key === 'products' ? { products: serve.products, nextCursor: null } : serve[key];
      const out = await original.apply(this, [shop, ...rest]);
      const bag = capture as unknown as Record<CaptureKey, unknown[]>;
      // 商品是分页拉的，逐页累加才拿得到全量
      bag[key].push(...(key === 'products' ? (out as ProductPage).products : (out as unknown[])));
      return out;
    };
  }
  try {
    const out = {} as TwinResults;
    for (const key of CAPTURE_KEYS) {
      const [result] = await runTask(TASK_OF[key], shopId, TWIN_SYNC_OPTS);
      out[TASK_OF[key]] = result;
    }
    return out;
  } finally {
    for (const key of CAPTURE_KEYS) proto[METHOD_OF[key]] = saved[key];
  }
}

/* ==================== 落库行快照（对拍的读侧） ==================== */

export const pick = (row: Record<string, unknown>, cols: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

export const ORDER_COLUMNS = [
  'order_status', 'order_time', 'paid_time', 'ship_time', 'buyer_region', 'currency',
  'subtotal', 'seller_discount', 'platform_discount', 'shipping_fee', 'total_paid',
  'fulfillment_type', 'carrier', 'tracking_no', 'is_sample_order',
] as const;

export const ITEM_COLUMNS = [
  'sku_id', 'quantity', 'unit_price', 'discount', 'item_amount', 'cost_snapshot', 'cost_matched', 'seller_sku',
] as const;

export const LISTING_COLUMNS = [
  'sku_id', 'seller_sku', 'product_name', 'sale_price', 'listing_status', 'map_status',
] as const;

export const RETURN_COLUMNS = [
  'return_type', 'reason', 'refund_amount', 'currency', 'status', 'apply_time', 'finish_time', 'is_restocked', 'responsibility',
] as const;

export const ITEM_ORDER = 'ORDER BY i.id ASC';

/** 订单头 + 明细（listing_id / 行 ID 两店必然不同，换成「有没有挂上 listing」+ 内部 sku_id） */
export function orderSnapshot(tkOrderId: string): Record<string, unknown> {
  const head = get<Record<string, unknown>>(`SELECT * FROM tk_order WHERE tk_order_id = ?`, tkOrderId);
  if (!head) throw new Error(`库里没有订单 ${tkOrderId}：这一列对拍无从谈起`);
  const items = all<Record<string, unknown>>(
    `SELECT i.quantity, i.unit_price, i.discount, i.item_amount, i.cost_snapshot, i.cost_matched, i.sku_id,
            IFNULL(l.seller_sku, '') AS seller_sku, (i.listing_id IS NOT NULL) AS has_listing,
            IFNULL(l.map_status, 0) AS map_status
       FROM tk_order_item i LEFT JOIN shop_listing l ON l.id = i.listing_id
      WHERE i.order_id = ? AND i.is_deleted = 0 ${ITEM_ORDER}`,
    Number(head.id),
  );
  return { ...pick(head, ORDER_COLUMNS), items: items.map((it) => ({ ...pick(it, ITEM_COLUMNS), has_listing: it.has_listing, map_status: it.map_status })) };
}

export function listingSnapshot(shopId: number): Record<string, unknown>[] {
  const rows = all<Record<string, unknown>>(
    `SELECT sku_id, seller_sku, product_name, sale_price, listing_status, map_status
       FROM shop_listing WHERE shop_id = ? AND is_deleted = 0 ORDER BY seller_sku ASC, id ASC`,
    shopId,
  );
  return rows.map((r) => pick(r, LISTING_COLUMNS));
}

/** 售后行：order_id / item_id 换成符号（两店各一份单据，数值 ID 不同但语义必须一致） */
export function returnSnapshot(tkReturnId: string, orderToken: (tkOrderId: string | null) => string): Record<string, unknown> {
  const row = get<Record<string, unknown>>(
    `SELECT t.*, o.tk_order_id AS oid, (t.tk_order_item_id IS NOT NULL) AS item_matched,
            IFNULL(l.tk_sku_id, '') AS item_sku
       FROM tk_return t
       LEFT JOIN tk_order o ON o.id = t.order_id
       LEFT JOIN tk_order_item i ON i.id = t.tk_order_item_id
       LEFT JOIN shop_listing l ON l.id = i.listing_id
      WHERE t.tk_return_id = ?`,
    tkReturnId,
  );
  if (!row) throw new Error(`库里没有售后 ${tkReturnId}`);
  return { ...pick(row, RETURN_COLUMNS), order_ref: orderToken(row.oid === null ? null : String(row.oid)), item_matched: row.item_matched, item_sku: row.item_sku };
}

/** 联盟归因后的明细行：按位置对齐（两侧写入顺序都是报文的顺序） */
export function attributionSnapshot(shopId: number): Record<string, unknown>[] {
  const rows = all<Record<string, unknown>>(
    `SELECT i.content_type, i.content_id, i.commission_rate, i.est_commission, i.item_amount,
            IFNULL(c.handle, '') AS creator_handle, o.tk_order_id AS oid
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id
       LEFT JOIN creator c ON c.id = i.creator_id
      WHERE o.shop_id = ? AND i.is_deleted = 0 ${ITEM_ORDER}`,
    shopId,
  );
  return rows.map((r) => pick(r, ['content_type', 'content_id', 'commission_rate', 'est_commission', 'item_amount', 'creator_handle']));
}

/** sync_log 计数器对拍用：去掉时间与店铺，只剩「这次同步算出了什么」 */
export function countersOf(r: SyncResult | undefined): Record<string, unknown> {
  if (!r) return {};
  return { task_type: r.task_type, fetched: r.fetched, inserted: r.inserted, updated: r.updated, failed: r.failed, status: r.status, detail: r.detail };
}

/** 逐字段找不同：失败时只报真正分叉的列，不甩整份快照 */
export function diffFields(actual: unknown, expected: unknown, prefix = ''): string[] {
  if (Object.is(actual, expected)) return [];
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return [`${prefix || '值'}: 一边是数组一边不是`];
    const out = actual.length === expected.length ? [] : [`长度 ${actual.length} vs ${expected.length}`];
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      out.push(...diffFields(actual[i], expected[i], `${prefix}[${i}]`));
    }
    return out;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(e)])];
    const out: string[] = [];
    for (const k of keys) out.push(...diffFields(a[k], e[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  return [`${prefix || '值'}：${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`];
}
