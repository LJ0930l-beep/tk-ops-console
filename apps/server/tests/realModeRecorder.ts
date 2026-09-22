/**
 * 录制器（开发者工具，CI 里不执行）
 *
 * 把「mock 数据源在固定窗口下产出的逻辑单据」改写成 TikTok 开放平台的报文方言，落成
 * `tests/fixtures/tiktok-real/*.json`。之所以能改写而不是凭空编：mock 与 real 描述的是同一批
 * 逻辑单据，只有**方言**不同 ——
 *
 *   mock 口语：裸数字金额 / 本地行 ID / `MOCK-*` 占位 ID / 布尔混数字
 *   平台方言：`{code,message,request_id,data}` 信封 + `data.orders|products|returns|affiliate_orders`
 *            + `next_page_token` 翻页 + Money 对象（金额是**主单位字符串**）+ Unix 秒 + snake_case
 *
 * 重新录制（只有 mockProvider 的方言变了才需要）：
 *   TT_RECORD_FIXTURES=1 npx vitest run tests/real-mode.spec.ts -t 重新录制
 * 录完必须 `npx vitest run tests/real-mode.spec.ts` 全绿：对拍读的是落盘的 JSON，不是这里的现算结果。
 *
 * 本文件不 import vitest，也不碰网络。
 */
import type { PlatformAffiliateOrder, PlatformMoney, PlatformOrder, PlatformOrderItem, PlatformProduct, PlatformReturn } from '../src/services/tiktok/types.js';
import type { Captured } from './realModeHarness.js';
import { writeFixture } from './realModeHarness.js';

export interface TwinPair {
  mock: string;
  real: string;
}

export interface TwinManifest {
  /** 录制来源说明：出问题时先查这里，再看 mockProvider 有没有改方言 */
  recorded_from: { shop_id: number; window_to: string; orders: number; returns: number; products: number; affiliate: number };
  orders: TwinPair[];
  returns: TwinPair[];
  /** mock 自造的平台 ID（`MOCK-*` / `9999x000001`）→ 平台风格的数字 ID */
  id_alias: Record<string, string>;
}

const num = (v: PlatformMoney): number => (typeof v === 'object' && v !== null ? Number(v.amount ?? 0) : Number(v ?? 0));

/** 平台的 Money 形态：主单位、两位小数字符串 + 币种（mock 侧是裸数字） */
const moneyObj = (v: PlatformMoney, currency: string): { amount: string; currency: string } => ({
  amount: num(v).toFixed(2),
  currency,
});

/** 明显是占位的翻页游标：真实游标是长串，但红线要求 fixture 里不许出现 32 位以上疑似凭证串 */
const pageToken = (n: number): string => `PAGE-TOKEN-${n}`;

/**
 * ID 别名表：mock 自造的 ID 一律换成平台风格数字串，两店才能各用各的命名空间。
 * 已经是数字的（对拍店自己插的 2288710001 之类）原样保留。
 */
export function makeAlias(): { of: (id: unknown) => string; table: () => Record<string, string> } {
  const table: Record<string, string> = {};
  let seq = 0;
  return {
    of: (id: unknown): string => {
      const raw = String(id ?? '');
      if (!raw) return raw;
      if (table[raw]) return table[raw];
      if (/^\d{6,}$/.test(raw)) return raw;
      const next = `574110${String(900000 + seq * 7).padStart(6, '0')}`;
      seq += 1;
      table[raw] = next;
      return next;
    },
    table: () => table,
  };
}

const envelope = <T>(key: string, rows: T[], nextToken: string | null, totalCount: number): Record<string, unknown> => ({
  code: 0,
  message: 'success',
  request_id: 'recorded-offline-0001',
  data: { [key]: rows, total_count: totalCount, next_page_token: nextToken ?? '', has_more: Boolean(nextToken) },
});

function orderPage(o: PlatformOrder, alias: ReturnType<typeof makeAlias>, realOrderId: string): Record<string, unknown> {
  const cur = String(o.currency ?? 'USD');
  const items = (o.items ?? []).map((it, i): Record<string, unknown> => itemPage(it, cur, alias, `${realOrderId}0${i}`));
  return {
    order_id: realOrderId,
    status: o.status,
    sub_status: o.sub_status,
    order_type: o.order_type,
    create_time: o.create_time,
    payment_time: o.payment_time,
    ship_time: o.ship_time,
    currency: o.currency,
    products_amount: moneyObj(o.products_amount, cur),
    seller_discount: moneyObj(o.seller_discount, cur),
    platform_discount: moneyObj(o.platform_discount, cur),
    discount_amount: moneyObj(o.seller_discount, cur),
    shipping_fee: moneyObj(o.shipping_fee, cur),
    total_amount: moneyObj(o.total_amount, cur),
    fulfillment_type: o.fulfillment_type,
    buyer_user_info: o.buyer_user_info ? { country: o.buyer_user_info.country } : undefined,
    // 平台给布尔，mock 给 0/1 —— 两边都必须落成同一个 is_sample_order
    is_sample_order: Number(o.is_sample_order ?? 0) === 1,
    tracking_info: o.tracking_info
      ? { tracking_no: o.tracking_info.tracking_no, courier_name: o.tracking_info.courier_name, shipping_provider_name: o.tracking_info.shipping_provider_name }
      : undefined,
    tracking_no: o.tracking_no,
    carrier: o.carrier,
    items,
  };
}

function itemPage(it: PlatformOrderItem, cur: string, alias: ReturnType<typeof makeAlias>, realItemId: string): Record<string, unknown> {
  return {
    id: realItemId,
    sku_id: alias.of(it.sku_id),
    product_id: alias.of(it.product_id),
    seller_sku: it.seller_sku,
    product_name: it.product_name,
    sku_name: it.sku_name,
    price: moneyObj(it.price, it.currency ?? cur),
    quantity: it.quantity,
    seller_discount: moneyObj(it.seller_discount, it.currency ?? cur),
    currency: it.currency ?? cur,
  };
}

function productPage(p: PlatformProduct, cur: string, alias: ReturnType<typeof makeAlias>): Record<string, unknown> {
  const id = alias.of(p.id ?? p.product_id);
  return {
    id,
    product_id: id,
    status: p.status,
    category_id: p.category_id,
    title: p.title,
    main_images: p.main_images ?? [],
    create_time: p.create_time,
    update_time: p.update_time,
    skus: (p.skus ?? []).map((s) => ({
      id: alias.of(s.id),
      sku_code: s.sku_code,
      seller_sku: s.seller_sku,
      /** 平台在 sku 层给 Money 对象；库存/图片本地无列，原样保留在报文里 */
      price: { amount: num(s.price ?? s.sale_price).toFixed(2), currency: (typeof s.price === 'object' ? s.price?.currency : undefined) ?? cur },
      stock: s.stock,
      status: s.status,
      sku_name: s.sku_name,
    })),
  };
}

function returnPage(r: PlatformReturn, alias: ReturnType<typeof makeAlias>, realReturnId: string, realOrderId: string): Record<string, unknown> {
  const cur = String(r.currency ?? 'USD');
  return {
    return_id: realReturnId,
    order_id: realOrderId,
    // 平台给的是「平台订单明细 ID」，不是本地行 ID：这条分叉由 D3 单独钉住，不在对拍里抹平
    item_id: alias.of(r.item_id),
    return_type: r.return_type,
    reason: r.reason,
    refund_amount: moneyObj(r.refund_amount ?? r.return_amount, cur),
    currency: r.currency,
    status: r.status,
    create_time: r.create_time,
    finish_time: r.finish_time,
    return_qty: r.return_qty,
    has_returned: r.has_returned,
  };
}

function affiliatePage(a: PlatformAffiliateOrder, alias: ReturnType<typeof makeAlias>, realOrderId: string, cur: string): Record<string, unknown> {
  return {
    order_id: realOrderId,
    item_id: alias.of(a.item_id),
    sku_id: a.sku_id === undefined ? undefined : alias.of(a.sku_id),
    seller_sku: a.seller_sku,
    creator_handle: a.creator_handle,
    content_type: a.content_type,
    video_id: a.video_id === undefined ? undefined : alias.of(a.video_id),
    live_id: a.live_id === undefined ? undefined : alias.of(a.live_id),
    seller_commission_rate: a.seller_commission_rate,
    seller_commission_amount: moneyObj(a.seller_commission_amount, cur),
    create_time: a.create_time,
  };
}

const REAL_ORDER_BASE = 574110000001000n;
const REAL_RETURN_BASE = 574110000002000n;

/** 录制：四类报文各一份（订单/商品分两页，翻页必须被走一遍） */
export function recordTwinFixtures(shopM: number, windowTo: string, captured: Captured): TwinManifest {
  const alias = makeAlias();
  const currency = 'USD';
  const orders = captured.orders;
  const orderPairs: TwinPair[] = orders.map((o, i) => ({ mock: String(o.order_id), real: String(REAL_ORDER_BASE + BigInt(i)) }));
  const returnPairs: TwinPair[] = captured.returns.map((r, i) => ({ mock: String(r.return_id), real: String(REAL_RETURN_BASE + BigInt(i)) }));
  const orderId = (mock: string | undefined): string =>
    orderPairs.find((p) => p.mock === mock)?.real ?? alias.of(mock);

  const half = Math.max(1, Math.ceil(orders.length / 2));
  writeFixture('twin-orders', [
    envelope('orders', orders.slice(0, half).map((o, i) => orderPage(o, alias, orderPairs[i]!.real)), pageToken(2), orders.length),
    envelope('orders', orders.slice(half).map((o, i) => orderPage(o, alias, orderPairs[half + i]!.real)), null, orders.length),
  ]);

  const products = captured.products;
  const pSplit = Math.max(1, products.length - 1);
  writeFixture('twin-products', [
    envelope('products', products.slice(0, pSplit).map((p) => productPage(p, currency, alias)), pageToken(2), products.length),
    envelope('products', products.slice(pSplit).map((p) => productPage(p, currency, alias)), null, products.length),
  ]);

  writeFixture('twin-returns', [
    envelope(
      'returns',
      captured.returns.map((r, i) => returnPage(r, alias, returnPairs[i]!.real, orderId(String(r.order_id)))),
      null,
      captured.returns.length,
    ),
  ]);

  writeFixture('twin-affiliate', [
    envelope(
      'affiliate_orders',
      captured.affiliate.map((a) => affiliatePage(a, alias, orderId(String(a.order_id)), currency)),
      null,
      captured.affiliate.length,
    ),
  ]);

  return {
    recorded_from: {
      shop_id: shopM,
      window_to: windowTo,
      orders: orders.length,
      returns: captured.returns.length,
      products: products.length,
      affiliate: captured.affiliate.length,
    },
    orders: orderPairs,
    returns: returnPairs,
    id_alias: alias.table(),
  };
}
