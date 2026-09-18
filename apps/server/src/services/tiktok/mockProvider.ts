/**
 * Mock 数据源（TIKTOK_API_MODE=mock，默认）。
 *
 * 不访问外网：全部响应由**本地库里已有的数据 + 窗口参数**确定性地推导出来
 * （同一 shop + 同一 window.to 重复调用结果完全一致），因此同步作业可以对 mock
 * 与 real 使用同一条 upsert 路径，并把「幂等」「重叠窗口」写成可断言的测试。
 *
 * 刻意内置四类数据（方案 6.2 / 6.4）：
 *   A 新订单，能经映射表找到内部 SKU → 冻结成本快照
 *   B 新订单，平台 SKU 本地从没同步过 → 明细映射不上（cost_matched=0 并告警）
 *   C 新订单，命中「卖家 SKU 填错」的 listing → 有 listing 但没有内部 SKU
 *   D 达人免费样品单（is_sample_order=1，不计 GMV）
 *   E 状态往前推进的旧订单（验证增量更新而非只插新）
 *   F 带联盟归因（达人 handle + 视频 ID）的联盟订单
 */
import { all, get } from '../../core/db.js';
import type { ProductPage, ShopCredential, SyncWindow, TikTokApiMode, TikTokShopClient } from './client.js';
import type { PlatformAffiliateOrder, PlatformOrder, PlatformOrderItem, PlatformProduct, PlatformReturn } from './types.js';
import { formatUtc, utcToUnix, utcNow } from './types.js';

/** 与 seed.ts 同一套 LCG：给定种子即可复现 */
function makeRng(seed: number): { next: () => number; int: (min: number, max: number) => number; pick: <T>(arr: T[]) => T } {
  let s = seed >>> 0;
  const bit = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  return {
    next: bit,
    int: (min, max) => Math.floor(min + (max - min + 1) * bit()),
    pick: <T>(arr: T[]): T => arr[Math.floor(bit() * arr.length)] as T,
  };
}

/** FNV-1a：把「店铺 + 窗口」折成随机种子，保证跨进程可复现 */
function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (const ch of text) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** 站点币种的价格量级（与 seed 保持一致，PHP 面额大） */
const priceBase = (currency: string): number => (currency === 'USD' ? 45 : currency === 'MYR' ? 60 : currency === 'PHP' ? 900 : currency === 'SGD' ? 25 : 50);

/** 窗口内取一个确定性的时间点（UTC 文本） */
function timeInWindow(window: SyncWindow, rnd: { next: () => number }): string {
  const from = Date.parse(`${window.from.replace(' ', 'T')}Z`);
  const to = Date.parse(`${window.to.replace(' ', 'T')}Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return window.to;
  return formatUtc(new Date(from + Math.floor((to - from) * rnd.next())));
}

/** 平台明细行的商品列 */
interface MockSkuRef {
  tk_sku_id: string;
  tk_product_id: string;
  seller_sku: string;
  product_name: string;
  price: number;
}

interface ListedRow {
  id: number;
  tk_product_id: string | null;
  tk_sku_id: string | null;
  seller_sku: string | null;
  product_name: string | null;
  sale_price: number;
}

/** 老状态往前推一格：让「同一单被重复拉到」表现为 update 而不是 insert */
const NEXT_STATUS: Record<string, string> = {
  UNPAID: 'TO_BE_SHIPPED',
  ON_HOLD: 'TO_BE_SHIPPED',
  TO_BE_SHIPPED: 'TRANSIT_TO_SHIP',
  INVOICE_CREATED: 'TRANSIT_TO_SHIP',
  SHIPPED: 'DELIVERED',
  TRANSIT_TO_SHIP: 'DELIVERED',
  DELIVERED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

export class MockTikTokShopClient implements TikTokShopClient {
  readonly mode: TikTokApiMode = 'mock';

  /** 该店铺已映射（能找回内部 SKU）的平台 SKU */
  private mappedListings(shopId: number): ListedRow[] {
    return all<ListedRow>(
      `SELECT id, tk_product_id, tk_sku_id, seller_sku, product_name, sale_price
         FROM shop_listing
        WHERE shop_id = ? AND is_deleted = 0 AND map_status = 1 AND sku_id IS NOT NULL AND tk_sku_id IS NOT NULL
        ORDER BY id ASC
        LIMIT 6`,
      shopId,
    );
  }

  private toRef(row: ListedRow, currency: string): MockSkuRef {
    return {
      tk_sku_id: String(row.tk_sku_id),
      tk_product_id: String(row.tk_product_id ?? `1729${row.id}`),
      seller_sku: String(row.seller_sku ?? ''),
      product_name: String(row.product_name ?? `平台商品 ${row.id}`),
      price: round2(Number(row.sale_price) || priceBase(currency)),
    };
  }

  /** 卖家 SKU 填错的平台 SKU：商品同步会把它落成 map_status=2 的 listing */
  private typoRef(shopId: number): MockSkuRef {
    return {
      tk_sku_id: `MOCK-SKU-${shopId}-TYPO`,
      tk_product_id: `MOCK-PROD-${shopId}-TYPO`,
      seller_sku: 'WRONG_SELLER_SKU_9999',
      product_name: '错填卖家 SKU 的平台商品（待人工映射）',
      price: 49.9,
    };
  }

  /** 本地从没同步过的平台 SKU：明细完全找不到 listing */
  private ghostRef(shopId: number, currency: string): MockSkuRef {
    return {
      tk_sku_id: `9999${shopId}000001`,
      tk_product_id: `8888${shopId}000001`,
      seller_sku: 'NEW-ITEM-NOT-IN-MASTER',
      product_name: '平台新建商品（本地未建档）',
      price: round2(priceBase(currency) * 1.15),
    };
  }

  private buildOrder(shop: ShopCredential, stamp: string, tag: string, refs: MockSkuRef[], window: SyncWindow, rnd: ReturnType<typeof makeRng>, isSample: boolean): PlatformOrder {
    const orderId = `MOCK${shop.shopId}${stamp}${tag}`;
    const createdAt = timeInWindow(window, rnd);
    const paidAt = createdAt;
    const items: PlatformOrderItem[] = refs.map((ref, idx) => {
      const qty = isSample ? 1 : rnd.int(1, 2);
      return {
        id: `${orderId}${idx}`,
        sku_id: ref.tk_sku_id,
        product_id: ref.tk_product_id,
        seller_sku: ref.seller_sku,
        product_name: ref.product_name,
        sku_name: `SKU-${idx + 1}`,
        price: ref.price,
        quantity: qty,
        seller_discount: round2(ref.price * qty * 0.05),
        currency: shop.currency,
      };
    });
    const products = round2(items.reduce((a, b) => a + Number(b.price) * Number(b.quantity), 0));
    const discount = round2(items.reduce((a, b) => a + Number(b.seller_discount ?? 0), 0));
    const shipping = isSample ? 0 : round2(rnd.next() > 0.5 ? rnd.int(2, 9) : 0);
    return {
      order_id: orderId,
      status: isSample ? 'COMPLETED' : 'TO_BE_SHIPPED',
      create_time: utcToUnix(createdAt),
      payment_time: utcToUnix(paidAt),
      ship_time: isSample ? utcToUnix(paidAt) : 0,
      currency: shop.currency,
      products_amount: products,
      seller_discount: discount,
      platform_discount: 0,
      shipping_fee: shipping,
      total_amount: round2(products - discount + shipping),
      fulfillment_type: isSample ? 'FULFILLMENT_BY_SELLER' : rnd.pick(['FULFILLMENT_BY_SELLER', 'FULFILLMENT_BY_PLATFORM']),
      buyer_user_info: { country: shop.region },
      is_sample_order: isSample ? 1 : 0,
      order_type: isSample ? 'SAMPLE_ORDER' : 'NORMAL',
      tracking_info: isSample ? { tracking_no: `SAMPLE${shop.shopId}${stamp}`, courier_name: { name: 'J&T Express' } } : null,
      items,
    };
  }

  /** 最近一单原样重发但状态推进一格，模拟「更新时间落进本窗口」的增量单 */
  private changedOldOrder(shop: ShopCredential, window: SyncWindow): PlatformOrder | null {
    const head = get<Record<string, string | number | null>>(
      `SELECT tk_order_id, order_status, order_time, paid_time, currency, subtotal, seller_discount, platform_discount,
              shipping_fee, total_paid, carrier, tracking_no, fulfillment_type, is_sample_order
         FROM tk_order WHERE shop_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
      shop.shopId,
    );
    if (!head) return null;
    const rows = all<Record<string, string | number | null>>(
      `SELECT i.unit_price, i.quantity, i.discount, i.item_amount, l.tk_sku_id, l.tk_product_id, l.seller_sku, l.product_name
         FROM tk_order_item i LEFT JOIN shop_listing l ON l.id = i.listing_id
        WHERE i.order_id = ? AND i.is_deleted = 0 ORDER BY i.id ASC`,
      this.orderIdOfLocal(String(head.tk_order_id)),
    );
    if (!rows.length) return null;
    const status = NEXT_STATUS[String(head.order_status)] ?? 'COMPLETED';
    const items: PlatformOrderItem[] = rows.map((r, idx) => ({
      id: `${String(head.tk_order_id)}-${idx}`,
      sku_id: String(r.tk_sku_id ?? `LOCAL-${idx}`),
      product_id: String(r.tk_product_id ?? `0`),
      seller_sku: String(r.seller_sku ?? ''),
      product_name: String(r.product_name ?? ''),
      price: Number(r.unit_price),
      quantity: Number(r.quantity),
      seller_discount: Number(r.discount),
      currency: String(head.currency ?? shop.currency),
    }));
    return {
      order_id: String(head.tk_order_id),
      status,
      create_time: utcToUnix(String(head.order_time ?? '')),
      payment_time: utcToUnix(String(head.order_time ?? '')),
      ship_time: status === 'TRANSIT_TO_SHIP' || status === 'DELIVERED' || status === 'COMPLETED' ? utcToUnix(window.to) : 0,
      currency: String(head.currency ?? shop.currency),
      products_amount: Number(head.subtotal),
      seller_discount: Number(head.seller_discount),
      platform_discount: Number(head.platform_discount),
      shipping_fee: Number(head.shipping_fee),
      total_amount: Number(head.total_paid),
      fulfillment_type: Number(head.fulfillment_type),
      buyer_user_info: { country: shop.region },
      is_sample_order: Number(head.is_sample_order) ? 1 : 0,
      tracking_no: String(head.tracking_no ?? '') || undefined,
      carrier: String(head.carrier ?? '') || undefined,
      items,
    };
  }

  private orderIdOfLocal(tkOrderId: string): number {
    return Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = ?`, tkOrderId)?.id ?? 0);
  }

  async getOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformOrder[]> {
    const stamp = window.to.replace(/\D/g, '').slice(0, 14);
    const rnd = makeRng(hashSeed(`order|${shop.shopId}|${window.to}`));
    const mapped = this.mappedListings(shop.shopId);
    const refs = mapped.length ? mapped.map((r) => this.toRef(r, shop.currency)) : [];
    const out: PlatformOrder[] = [];

    const normalRefs = refs.length ? refs.slice(0, Math.min(2, refs.length)) : [this.ghostRef(shop.shopId, shop.currency)];
    out.push(this.buildOrder(shop, stamp, 'A1', normalRefs, window, rnd, false));
    out.push(this.buildOrder(shop, stamp, 'B2', [this.ghostRef(shop.shopId, shop.currency)], window, rnd, false));
    out.push(this.buildOrder(shop, stamp, 'C3', [this.typoRef(shop.shopId)], window, rnd, false));
    out.push(this.buildOrder(shop, stamp, 'D4', normalRefs.slice(0, 1), window, rnd, true));

    const changed = this.changedOldOrder(shop, window);
    if (changed) out.push(changed);
    return out;
  }

  /** 平台商品：第 1 页复用本地 listing（价格微调→表现为 updated）+ 1 个可自动匹配的新品；第 2 页给错填卖家 SKU 的商品 */
  async getProducts(shop: ShopCredential, cursor?: string | null): Promise<ProductPage> {
    const rnd = makeRng(hashSeed(`product|${shop.shopId}`));
    if (cursor === 'MOCK-P2') {
      const typo = this.typoRef(shop.shopId);
      return {
        products: [
          {
            id: typo.tk_product_id,
            product_id: typo.tk_product_id,
            title: typo.product_name,
            status: 'ACTIVATED',
            category_id: '100000',
            main_images: ['https://cdn.example.com/mock/typo.jpg'],
            update_time: utcToUnix(utcNow()),
            skus: [{ id: typo.tk_sku_id, sku_code: typo.seller_sku, seller_sku: typo.seller_sku, price: { amount: typo.price, currency: shop.currency }, stock: 30, status: 'ACTIVATED' }],
          },
        ],
        nextCursor: null,
      };
    }

    const listed = this.mappedListings(shop.shopId).slice(0, 4);
    const products: PlatformProduct[] = listed.map((row, i) => {
      const price = round2(Number(row.sale_price) * (1 + (i % 3) * 0.01));
      return {
        id: String(row.tk_product_id ?? `1729${row.id}`),
        product_id: String(row.tk_product_id ?? `1729${row.id}`),
        title: String(row.product_name ?? `平台商品 ${row.id}`),
        status: 'ACTIVATED',
        category_id: '100000',
        main_images: [`https://cdn.example.com/mock/${row.id}.jpg`],
        update_time: utcToUnix(utcNow()),
        skus: [
          {
            id: String(row.tk_sku_id),
            sku_code: String(row.seller_sku ?? ''),
            seller_sku: String(row.seller_sku ?? ''),
            price: { amount: price, currency: shop.currency },
            stock: rnd.int(20, 400),
            status: 'ACTIVATED',
          },
        ],
      };
    });

    // 未建档但卖家 SKU 规范的平台商品：应被 seller_sku → sku_code 自动映射命中
    const fresh = get<{ sku_code: string; spu_id: number }>(
      `SELECT k.sku_code, k.spu_id FROM product_sku k
        WHERE k.is_deleted = 0 AND k.status = 1
          AND NOT EXISTS (SELECT 1 FROM shop_listing l WHERE l.shop_id = ? AND l.sku_id = k.id AND l.is_deleted = 0)
        ORDER BY k.id ASC LIMIT 1`,
      shop.shopId,
    );
    if (fresh) {
      const tkSku = `MOCK-SKU-${shop.shopId}-NEW1`;
      products.push({
        id: `MOCK-PROD-${shop.shopId}-NEW1`,
        product_id: `MOCK-PROD-${shop.shopId}-NEW1`,
        title: `自动可匹配的新品 ${fresh.sku_code}`,
        status: 'ACTIVATED',
        category_id: '100000',
        main_images: [],
        update_time: utcToUnix(utcNow()),
        skus: [{ id: tkSku, sku_code: fresh.sku_code, seller_sku: fresh.sku_code, price: { amount: round2(priceBase(shop.currency) * 1.2), currency: shop.currency }, stock: 88, status: 'ACTIVATED' }],
      });
    }
    return { products, nextCursor: products.length ? 'MOCK-P2' : null };
  }

  async getReturns(shop: ShopCredential, window: SyncWindow): Promise<PlatformReturn[]> {
    const rnd = makeRng(hashSeed(`return|${shop.shopId}|${window.to}`));
    const orders = all<{ tk_order_id: string; currency: string; total_paid: number; first_item_id: number }>(
      `SELECT o.tk_order_id, o.currency, o.total_paid,
              (SELECT MIN(i.id) FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0) AS first_item_id
         FROM tk_order o
        WHERE o.shop_id = ? AND o.is_deleted = 0 AND o.is_sample_order = 0
        ORDER BY o.id DESC LIMIT 2`,
      shop.shopId,
    );
    if (!orders.length) return [];
    const reasons = ['Item was damaged during shipping', 'Not as described', 'Buyer changed mind'];
    return orders.map((o, i) => {
      const applyAt = timeInWindow(window, rnd);
      return {
        return_id: `MOCKRT-${shop.shopId}-${window.to.replace(/\D/g, '').slice(0, 14)}-${i}`,
        order_id: o.tk_order_id,
        item_id: i === 0 ? String(o.first_item_id ?? '') : '',
        return_type: i === 0 ? 'RETURN_AND_REFUND' : 'ONLY_REFUND',
        reason: rnd.pick(reasons),
        refund_amount: { amount: round2(Number(o.total_paid) * (i === 0 ? 1 : 0.4)), currency: o.currency },
        currency: o.currency,
        status: i === 0 ? 'COMPLETED' : 'PROCESSING',
        create_time: utcToUnix(applyAt),
        finish_time: i === 0 ? utcToUnix(window.to) : 0,
        return_qty: 1,
        has_returned: i === 0,
      };
    });
  }

  async getAffiliateOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformAffiliateOrder[]> {
    const items = all<{ tk_order_id: string; item_id: number; tk_sku_id: string | null; seller_sku: string | null; item_amount: number }>(
      `SELECT o.tk_order_id, i.id AS item_id, l.tk_sku_id, l.seller_sku, i.item_amount
         FROM tk_order_item i
         JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
         LEFT JOIN shop_listing l ON l.id = i.listing_id
        WHERE o.shop_id = ? AND i.is_deleted = 0
        ORDER BY i.id DESC
        LIMIT 8`,
      shop.shopId,
    );
    if (!items.length) return [];
    const creators = all<{ handle: string }>(`SELECT handle FROM creator WHERE is_deleted = 0 ORDER BY id ASC LIMIT 6`).map((c) => c.handle);
    const videos = all<{ tk_video_id: string }>(`SELECT tk_video_id FROM video WHERE is_deleted = 0 AND tk_video_id IS NOT NULL ORDER BY id DESC LIMIT 6`).map((v) => v.tk_video_id);
    if (!creators.length) return [];
    const rnd = makeRng(hashSeed(`affiliate|${shop.shopId}|${window.to}`));
    const rates = [10, 12, 15, 18];
    return items.map((it, idx) => {
      // 最后一条故意给一个本地达人库里不存在的 handle：验证「归因不丢字段但不误挂达人」
      const ghost = idx === items.length - 1;
      const handle = ghost ? '@Ghost.Creator.999' : `@${(creators[idx % creators.length] as string).toUpperCase()}`;
      const isLive = idx % 3 === 2;
      const contentId = (isLive ? videos[idx % videos.length] : videos[(idx + 1) % videos.length]) ?? `7500000${String(idx).padStart(11, '0')}`;
      return {
        order_id: it.tk_order_id,
        item_id: String(it.tk_sku_id ?? it.seller_sku ?? it.item_id),
        sku_id: it.tk_sku_id ?? undefined,
        seller_sku: it.seller_sku ?? undefined,
        creator_handle: handle,
        content_type: isLive ? 'LIVE' : 'VIDEO',
        video_id: isLive ? undefined : contentId,
        live_id: isLive ? contentId : undefined,
        seller_commission_rate: rates[idx % rates.length] as number,
        seller_commission_amount: round2(Number(it.item_amount) * ((rates[idx % rates.length] as number) / 100)),
        create_time: utcToUnix(window.from) || rnd.int(1, 1000),
      };
    });
  }
}
