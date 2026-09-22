/**
 * 数据同步作业（方案 6.2 / 6.4 / 第七章）。
 *
 * 三条硬口径：
 *  1. 每次执行（含手动补跑）都写一条 sync_log：时间段、fetched/inserted/updated/failed、状态、耗时。
 *  2. 增量窗口前后重叠 config.syncOverlapMinutes 分钟，靠 tk_order_id / tk_return_id /
 *     (shop_id,tk_sku_id) 唯一索引去重 —— 宁可多拉，不能漏单，重复拉不产生重复行。
 *  3. 成本在订单明细写入时冻结：cost_snapshot =（采购 + 头程）× 数量（人民币）。
 *     映射不到内部 SKU 的行 sku_id=NULL、cost_matched=0，绝不按 0 成本参与利润，并 sendAlert。
 *
 * 「拉取」全部走 services/tiktok/client.ts 的工厂（mock / real 同一套入库代码路径），
 * 本文件只负责归一化 + 写库 + 日志 + 告警。
 */
import { MAP_STATUS, normalizeHandle, round2, unitCostCny } from '@tk/shared';
import { config } from '../config.js';
import { countRateFallbacks, rebuildCreatorDaily, rebuildProductChannelDaily, rebuildShopChannelDaily, rebuildVideoDaily } from '../services/analytics.js';
import { all, get, insert, run, scalar, tx, update } from '../core/db.js';
import { maskError } from '../core/redact.js';
import { sendAlert, writeOpLog } from '../core/oplog.js';
import { buildShopCredential, createTiktokClient, type ShopCredential, type SyncWindow } from '../services/tiktok/client.js';
import { flag, formatUtc, money, parseUtc, unixToUtc, utcToUnix } from '../services/tiktok/types.js';
import type { PlatformAffiliateOrder, PlatformMoney, PlatformOrder, PlatformOrderItem, PlatformProduct, PlatformReturn } from '../services/tiktok/types.js';

/** 无登录上下文的作业写操作日志时用 0 号「系统」用户 */
export const SYSTEM_USER_ID = 0;

/** task_type 取值即 PRD 6.1 的数据源名（'affiliate' / 'product' 是对外别称，入库分别归一到 affiliate_order / listing） */
export type SyncTaskType = 'order' | 'listing' | 'returns' | 'affiliate_order' | 'aggregate';
export type SyncTaskInput = SyncTaskType | 'affiliate' | 'product' | 'all';

export interface SyncOptions {
  /** 手动补跑：指定窗口起止（UTC 'YYYY-MM-DD HH:MM:SS'），不传则接上次 window_end 并重叠 */
  windowStart?: string;
  windowEnd?: string;
  /** 手动触发时记录操作人，用于日志归属 */
  user_id?: number;
}

export interface SyncResult {
  log_id: number;
  task_type: SyncTaskType;
  shop_id: number;
  window_start: string;
  window_end: string;
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  status: number;
  error_msg: string | null;
  started_at: string;
  finished_at: string;
  /** 作业自定义明细（如未匹配达人数、被回填的历史行数） */
  detail: Record<string, number>;
}

/** 落库计数器：real/mock 报文对拍要连它一起比（unmapped_items 这类计数就是运营看到的告警数） */
export interface Counters {
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  detail: Record<string, number>;
  errors: string[];
}

export const newCounters = (): Counters => ({ fetched: 0, inserted: 0, updated: 0, failed: 0, detail: {}, errors: [] });
const bump = (c: Counters, key: string, by = 1): void => {
  c.detail[key] = (c.detail[key] ?? 0) + by;
};
/** 上游报错可能整段带出凭证，落 sync_log / 告警之前一律过 maskError（与 services/jobs/queue.ts 同一口径） */
const pushError = (c: Counters, msg: string): void => {
  if (c.errors.length < 5) c.errors.push(maskError(msg));
};

/* ==================== 窗口与店铺 ==================== */

/** 上次同类任务的 window_end 往前挪 overlap 分钟 = 本次 window_start（宁可多拉不漏单） */
export function resolveWindow(taskType: SyncTaskType, shopId: number, opts: SyncOptions = {}): SyncWindow {
  const to = opts.windowEnd || utcStamp();
  if (opts.windowStart) return { from: opts.windowStart, to };
  const last = get<{ window_end: string | null }>(
    `SELECT window_end FROM sync_log WHERE task_type = ? AND shop_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
    taskType,
    shopId,
  );
  const base = parseUtc(last?.window_end);
  const anchor = parseUtc(to) ?? new Date();
  const from = base && base.getTime() > 0
    ? new Date(base.getTime() - config.syncOverlapMinutes * 60_000)
    : new Date(anchor.getTime() - 24 * 3600_000);
  return { from: formatUtc(from), to };
}

const utcStamp = (): string => formatUtc(new Date());

/** 参与同步的店铺：运营中 + 已授权（未授权店跳过，由店铺模块提示重新授权） */
export function activeShopIds(): number[] {
  return all<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 AND status = 1 AND auth_status IN (1, 2) ORDER BY id ASC`).map((s) => s.id);
}

/* ==================== 平台字段 → 本地枚举归一化 ==================== */
// 映射本身挪到 services/tiktok/normalize.ts（平台适配层）；本文件继续按原名使用并转出，调用点不变
import {
  normalizeContentType,
  normalizeFulfillment,
  normalizeListingStatus,
  normalizeOrderStatus,
  normalizeReturnType,
} from '../services/tiktok/normalize.js';

export { normalizeContentType, normalizeFulfillment, normalizeListingStatus, normalizeOrderStatus, normalizeReturnType };

/**
 * 平台报文 → tk_order 头表列（纯计算，不碰库）。
 * 单独导出是给 real/mock 报文对拍用的：真实店铺联调之前，
 * 「同一个逻辑单据在两种报文形态下落成同一行」这件事只能靠这段映射被直接断言，
 * 藏在 upsert 里就没有可拍的入口。
 */
export function orderHeadOf(shopId: number, o: PlatformOrder, syncedAt = utcStamp()): Record<string, unknown> {
  const currency = String(o.currency ?? '').slice(0, 3).toUpperCase() || 'USD';
  const subtotal = money(o.products_amount);
  const sellerDiscount = money(o.seller_discount ?? o.discount_amount);
  const shipping = money(o.shipping_fee);
  const totalPaid = money(o.total_amount) || round2(subtotal - sellerDiscount + shipping);
  const tracking = o.tracking_info?.tracking_no ?? o.tracking_no ?? null;
  const courier = o.tracking_info?.courier_name;
  const carrier = (typeof courier === 'string' ? courier : courier?.name) ?? o.carrier ?? null;
  return {
    shop_id: shopId,
    tk_order_id: String(o.order_id ?? '').trim(),
    order_status: normalizeOrderStatus(o.status ?? o.sub_status),
    order_time: unixToUtc(o.create_time),
    paid_time: unixToUtc(o.payment_time),
    ship_time: unixToUtc(o.ship_time),
    buyer_region: String(o.buyer_user_info?.country ?? o.buyer_user_info?.region ?? '').slice(0, 8) || null,
    currency,
    subtotal,
    seller_discount: sellerDiscount,
    platform_discount: money(o.platform_discount),
    shipping_fee: shipping,
    total_paid: totalPaid,
    fulfillment_type: normalizeFulfillment(o.fulfillment_type),
    carrier: carrier ? String(carrier).slice(0, 64) : null,
    tracking_no: tracking ? String(tracking).slice(0, 64) : null,
    is_sample_order: flag(o.is_sample_order ?? (String(o.order_type ?? '').toUpperCase().includes('SAMPLE') ? 1 : 0)),
    synced_at: syncedAt,
  };
}

/* ==================== 订单落库 ==================== */

interface ResolvedItem {
  listing_id: number | null;
  sku_id: number | null;
  cost_matched: 0 | 1;
}

/** tk_sku_id（优先）或 seller_sku → shop_listing → product_sku；找不到即未映射 */
export function resolveItemSku(shopId: number, tkSkuId: string | null, sellerSku: string | null): ResolvedItem {
  const row = get<Record<string, number | string | null>>(
    `SELECT l.id AS listing_id, l.sku_id
       FROM shop_listing l
      WHERE l.shop_id = ? AND l.is_deleted = 0
        AND ((? <> '' AND l.tk_sku_id = ?) OR (? <> '' AND IFNULL(l.seller_sku, '') = ?))
      ORDER BY (l.tk_sku_id = ?) DESC, l.id ASC LIMIT 1`,
    shopId,
    tkSkuId ?? '',
    tkSkuId ?? '',
    sellerSku ?? '',
    sellerSku ?? '',
    tkSkuId ?? '',
  );
  if (!row) return { listing_id: null, sku_id: null, cost_matched: 0 };
  const listingId = Number(row.listing_id);
  const skuId = row.sku_id === null || row.sku_id === undefined ? null : Number(row.sku_id);
  return skuId ? { listing_id: listingId, sku_id: skuId, cost_matched: 1 } : { listing_id: listingId, sku_id: null, cost_matched: 0 };
}

/** 成本快照：冻结当时的（采购 + 头程）× 数量，人民币 */
export function snapshotCost(sku: { purchase_cost: number; first_leg_cost: number }, quantity: number): number {
  return round2(unitCostCny({ purchase_cost: Number(sku.purchase_cost), first_leg_cost: Number(sku.first_leg_cost) }) * Math.max(1, quantity));
}

/**
 * 单笔订单 upsert（含明细）。
 * 已存在的订单只刷新状态与物流节点，**不重写历史 cost_snapshot / 映射结果**（方案表 7「冻结」），
 * 映射后补齐的历史行由 refreshDerivedAggregates 统一处理并留痕。
 */
export function upsertPlatformOrder(shopId: number, o: PlatformOrder, c: Counters): void {
  const tkOrderId = String(o.order_id ?? '').trim();
  if (!tkOrderId) throw new Error('平台订单缺少 order_id');
  const exist = get<{ id: number; shop_id: number; is_deleted: number }>(`SELECT id, shop_id, is_deleted FROM tk_order WHERE tk_order_id = ?`, tkOrderId);
  if (exist && Number(exist.is_deleted) !== 0) {
    throw new Error('已有订单号位于回收站，已拒绝静默更新');
  }
  if (exist && Number(exist.shop_id) !== shopId) {
    // tk_order_id is globally unique today. A duplicate imported under another shop must fail
    // closed instead of silently re-parenting the existing order and its cost/attribution history.
    throw new Error('已有订单号归属其他店铺，已拒绝跨店改写');
  }
  const head = orderHeadOf(shopId, o);

  let orderId: number;
  if (exist) {
    orderId = Number(exist.id);
    update('tk_order', orderId, head as never);
    c.updated += 1;
  } else {
    orderId = insert('tk_order', { ...head, created_by: SYSTEM_USER_ID } as never);
    c.inserted += 1;
  }

  const items = o.items ?? [];
  bump(c, 'items', items.length);
  if (!items.length) return;

  const existing = all<{ id: number; listing_id: number | null; unit_price: number; quantity: number }>(
    `SELECT id, listing_id, unit_price, quantity FROM tk_order_item WHERE order_id = ? AND is_deleted = 0 ORDER BY id ASC`,
    orderId,
  );
  const used = new Set<number>();
  for (const raw of items) {
    const tkSkuId = raw.sku_id === undefined || raw.sku_id === null ? null : String(raw.sku_id);
    const sellerSku = raw.seller_sku ? String(raw.seller_sku) : null;
    const qty = Math.max(1, Number(raw.quantity ?? 1) || 1);
    const unit = money(raw.price);
    const discount = money(raw.seller_discount ?? raw.item_discount);
    const resolved = resolveItemSku(shopId, tkSkuId, sellerSku);
    const amount = round2(unit * qty - discount);

    // 明细去重键：能定位到 listing 时按 listing，否则退化成 (单价, 数量)
    const twin = existing.find(
      (e) => !used.has(e.id) && (resolved.listing_id !== null ? e.listing_id === resolved.listing_id : e.listing_id === null && Number(e.unit_price) === unit && Number(e.quantity) === qty),
    );
    if (twin) {
      used.add(twin.id);
      update('tk_order_item', twin.id, { quantity: qty, unit_price: unit, discount, item_amount: amount } as never);
      continue;
    }

    let costSnapshot = 0;
    let skuId = resolved.sku_id;
    if (resolved.cost_matched === 1 && skuId) {
      const sku = get<{ purchase_cost: number; first_leg_cost: number }>(`SELECT purchase_cost, first_leg_cost FROM product_sku WHERE id = ? AND is_deleted = 0`, skuId);
      if (sku) costSnapshot = snapshotCost(sku, qty);
      else skuId = null;
    }
    insert('tk_order_item', {
      order_id: orderId,
      listing_id: resolved.listing_id,
      sku_id: skuId,
      quantity: qty,
      unit_price: unit,
      discount,
      item_amount: amount,
      cost_snapshot: costSnapshot,
      cost_matched: skuId ? 1 : 0,
      created_by: SYSTEM_USER_ID,
    } as never);
    if (!skuId) {
      c.failed += 1;
      bump(c, 'unmapped_items');
    }
  }
}

/** 明细映射不上 → 每次同步都告警（方案 6.4：不能悄悄按 0 成本算） */
function alertUnmapped(shop: ShopCredential, count: number): void {
  if (count <= 0) return;
  sendAlert({
    title: `订单成本映射失败 ${count} 行`,
    detail: `店铺「${shop.shopName}」本次同步有 ${count} 条订单明细找不到内部 SKU，已进「待映射清单」；这些行不计入成本与利润，请尽快在商品中心完成映射`,
    level: 'error',
  });
}

export async function syncOrdersForShop(shopId: number, opts: SyncOptions = {}): Promise<SyncResult> {
  return withSyncLog('order', shopId, opts, async (c, window) => {
    const shop = buildShopCredential(shopId);
    const orders = await createTiktokClient().getOrders(shop, window);
    c.fetched += orders.length;
    for (const o of orders) {
      try {
        tx(() => upsertPlatformOrder(shopId, o, c));
      } catch (e) {
        c.failed += 1;
        pushError(c, `订单 ${String(o.order_id ?? '?')} 落库失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    alertUnmapped(shop, c.detail.unmapped_items ?? 0);
  });
}

/* ==================== 手工导入（卖家中心导出表格兜底，方案第七章「接口覆盖不到」） ==================== */

const timeValue = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  return utcToUnix(s);
};

const moneyValue = (v: unknown): PlatformMoney => (v === null || v === undefined || v === '' ? 0 : (v as PlatformMoney));

/**
 * 导入行 → PlatformOrder：允许时间给 Unix 秒或 'YYYY-MM-DD HH:MM:SS'（UTC）文本，
 * 金额/优惠列名兼容「平台报文」与「卖家中心表格」两种写法。
 */
export function toPlatformOrder(row: Record<string, unknown>): PlatformOrder {
  const rawItems = Array.isArray(row.items) ? row.items : Array.isArray(row.order_items) ? row.order_items : [];
  const items: PlatformOrderItem[] = (rawItems as Record<string, unknown>[]).map((it) => ({
    id: (it.id as string | number | undefined) ?? undefined,
    sku_id: (it.sku_id ?? it.tk_sku_id) as string | number | undefined,
    product_id: (it.product_id ?? it.tk_product_id) as string | number | undefined,
    seller_sku: it.seller_sku === undefined || it.seller_sku === null ? undefined : String(it.seller_sku),
    product_name: it.product_name === undefined ? undefined : String(it.product_name),
    price: moneyValue(it.price ?? it.unit_price),
    quantity: Number(it.quantity ?? 1) || 1,
    seller_discount: moneyValue(it.seller_discount ?? it.discount),
    currency: it.currency === undefined ? undefined : String(it.currency),
    commission_rate: it.commission_rate === undefined ? undefined : Number(it.commission_rate),
  }));
  return {
    order_id: String(row.order_id ?? row.tk_order_id ?? '').trim(),
    status: row.status === undefined && row.order_status === undefined ? undefined : String(row.status ?? row.order_status),
    sub_status: row.sub_status === undefined ? undefined : String(row.sub_status),
    create_time: timeValue(row.create_time ?? row.order_time),
    payment_time: timeValue(row.payment_time ?? row.paid_time),
    ship_time: timeValue(row.ship_time),
    currency: row.currency === undefined || row.currency === '' ? undefined : String(row.currency),
    total_amount: moneyValue(row.total_amount ?? row.total_paid),
    products_amount: moneyValue(row.products_amount ?? row.subtotal),
    shipping_fee: moneyValue(row.shipping_fee),
    seller_discount: moneyValue(row.seller_discount),
    platform_discount: moneyValue(row.platform_discount),
    fulfillment_type: row.fulfillment_type as string | number | undefined,
    buyer_user_info: (row.buyer_user_info as PlatformOrder['buyer_user_info']) ?? (row.buyer_region ? { country: String(row.buyer_region) } : undefined),
    is_sample_order: row.is_sample_order as boolean | number | undefined,
    tracking_no: row.tracking_no === undefined ? undefined : String(row.tracking_no),
    carrier: row.carrier === undefined ? undefined : String(row.carrier),
    items,
  };
}

/**
 * 手工导入订单：与接口同步共用 upsertPlatformOrder（同一套成本快照 + 去重 + 告警），
 * 因此重复导入同一批次不会产生重复行。
 */
export async function importOrdersForShop(
  shopId: number,
  rows: Record<string, unknown>[],
  opts: SyncOptions = {},
): Promise<SyncResult> {
  return withSyncLog('order', shopId, opts, async (c) => {
    const shop = buildShopCredential(shopId);
    c.fetched += rows.length;
    for (const raw of rows) {
      const order = toPlatformOrder(raw);
      try {
        tx(() => upsertPlatformOrder(shopId, order, c));
        bump(c, 'imported');
      } catch (e) {
        c.failed += 1;
        bump(c, 'import_failed');
        pushError(c, `导入订单 ${order.order_id ?? '?'} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    alertUnmapped(shop, c.detail.unmapped_items ?? 0);
  });
}

/* ==================== 平台商品 → shop_listing ==================== */

/** seller_sku 与内部 sku_code 全等，或 sku_code 是 seller_sku 的前缀且唯一命中，才敢自动映射 */
export function matchSkuBySellerSku(sellerSku: string | null): number | null {
  const code = String(sellerSku ?? '').trim();
  if (!code) return null;
  const exact = get<{ id: number }>(`SELECT id FROM product_sku WHERE is_deleted = 0 AND sku_code = ?`, code);
  if (exact) return Number(exact.id);
  const prefixed = all<{ id: number }>(`SELECT id FROM product_sku WHERE is_deleted = 0 AND ? LIKE sku_code || '%' ORDER BY LENGTH(sku_code) DESC`, code);
  return prefixed.length === 1 ? Number(prefixed[0]?.id) : null;
}

export function upsertPlatformProduct(shopId: number, p: PlatformProduct, c: Counters): void {
  const tkProductId = String(p.id ?? p.product_id ?? '').trim();
  const skus = p.skus?.length ? p.skus : [];
  if (!skus.length) return;
  for (const s of skus) {
    const tkSkuId = String(s.id ?? '').trim();
    if (!tkSkuId) continue;
    const sellerSku = String(s.seller_sku ?? s.sku_code ?? '').trim() || null;
    const price = money(s.price ?? s.sale_price);
    const exist = get<{ id: number; sku_id: number | null }>(
      `SELECT id, sku_id FROM shop_listing WHERE shop_id = ? AND tk_sku_id = ? AND is_deleted = 0`,
      shopId,
      tkSkuId,
    );
    const skuId = exist?.sku_id ?? matchSkuBySellerSku(sellerSku);
    c.fetched += 1;
    const payload = {
      shop_id: shopId,
      sku_id: skuId ?? null,
      tk_product_id: tkProductId || null,
      tk_sku_id: tkSkuId,
      seller_sku: sellerSku,
      product_name: String(p.title ?? p.product_name ?? '').slice(0, 200) || null,
      sale_price: price,
      listing_status: normalizeListingStatus(s.status ?? p.status),
      map_status: skuId ? MAP_STATUS.MAPPED : MAP_STATUS.UNMAPPED,
      last_sync_at: utcStamp(),
    };
    if (exist) {
      update('shop_listing', Number(exist.id), payload as never);
      c.updated += 1;
    } else {
      insert('shop_listing', { ...payload, created_by: SYSTEM_USER_ID } as never);
      c.inserted += 1;
    }
    if (skuId) bump(c, 'auto_matched');
    else {
      c.failed += 1;
      bump(c, 'unmapped_listings');
    }
  }
}

export async function syncListingsForShop(shopId: number, opts: SyncOptions = {}): Promise<SyncResult> {
  return withSyncLog('listing', shopId, opts, async (c) => {
    const shop = buildShopCredential(shopId);
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = await createTiktokClient().getProducts(shop, cursor ?? null);
      for (const p of page.products) {
        try {
          tx(() => upsertPlatformProduct(shopId, p, c));
        } catch (e) {
          c.failed += 1;
          pushError(c, `商品 ${String(p.id ?? '')} 落库失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);
  });
}

/* ==================== 售后 → tk_return ==================== */

/** 售后报文 → tk_return 列（纯计算，同上：real/mock 对拍的入口） */
export function returnPayloadOf(shopId: number, r: PlatformReturn, orderId: number | null, itemId: number | null): Record<string, unknown> {
  return {
    shop_id: shopId,
    order_id: orderId,
    tk_return_id: String(r.return_id ?? '').trim(),
    tk_order_item_id: itemId,
    return_type: normalizeReturnType(r.return_type ?? r.type),
    reason: String(r.reason ?? r.customer_service_reason ?? '').slice(0, 200) || null,
    refund_amount: money(r.refund_amount ?? r.return_amount),
    currency: String(r.currency ?? '').slice(0, 3).toUpperCase() || 'USD',
    status: String(r.status ?? 'PROCESSING').toUpperCase(),
    apply_time: unixToUtc(r.apply_time ?? r.create_time ?? r.delivery_time),
    finish_time: unixToUtc(r.finish_time),
  };
}

export function upsertPlatformReturn(shopId: number, r: PlatformReturn, c: Counters): void {
  const returnId = String(r.return_id ?? '').trim();
  if (!returnId) throw new Error('平台售后单缺少 return_id');
  const tkOrderId = String(r.order_id ?? '').trim();
  const order = tkOrderId ? get<{ id: number; shop_id: number; is_deleted: number }>(`SELECT id, shop_id, is_deleted FROM tk_order WHERE tk_order_id = ?`, tkOrderId) : undefined;
  if (order && Number(order.is_deleted) !== 0) {
    throw new Error('售后单引用的订单位于回收站，已拒绝关联');
  }
  if (order && Number(order.shop_id) !== shopId) {
    throw new Error('售后单引用的订单归属其他店铺，已拒绝跨店关联');
  }
  const itemRef = String(r.item_id ?? '');
  const item = order
    ? get<{ id: number }>(
        `SELECT i.id FROM tk_order_item i
           LEFT JOIN shop_listing l ON l.id = i.listing_id
          WHERE i.order_id = ? AND i.is_deleted = 0
            AND (? = '' OR IFNULL(l.tk_sku_id, '') = ? OR CAST(i.id AS TEXT) = ?)
          ORDER BY i.id ASC LIMIT 1`,
        order.id,
        itemRef,
        itemRef,
        itemRef,
      )
    : undefined;
  const payload = returnPayloadOf(shopId, r, order?.id ?? null, item?.id ?? null);
  const exist = get<{ id: number; shop_id: number; is_deleted: number }>(`SELECT id, shop_id, is_deleted FROM tk_return WHERE tk_return_id = ?`, returnId);
  if (exist) {
    if (Number(exist.is_deleted) !== 0) {
      throw new Error('已有售后单号位于回收站，已拒绝静默更新');
    }
    if (Number(exist.shop_id) !== shopId) {
      throw new Error('已有售后单号归属其他店铺，已拒绝跨店改写');
    }
    const patch: Record<string, unknown> = { ...payload };
    delete patch.tk_return_id; // 业务主键不随同步改写
    if (r.has_returned !== undefined) patch.is_restocked = flag(r.has_returned);
    update('tk_return', Number(exist.id), patch as never);
    c.updated += 1;
  } else {
    insert('tk_return', { ...payload, is_restocked: flag(r.has_returned), responsibility: 0, created_by: SYSTEM_USER_ID } as never);
    c.inserted += 1;
  }
  c.fetched += 1;
  if (!order) bump(c, 'orphan_returns');
}

export async function syncReturnsForShop(shopId: number, opts: SyncOptions = {}): Promise<SyncResult> {
  return withSyncLog('returns', shopId, opts, async (c, window) => {
    const shop = buildShopCredential(shopId);
    const list = await createTiktokClient().getReturns(shop, window);
    for (const r of list) {
      try {
        tx(() => upsertPlatformReturn(shopId, r, c));
      } catch (e) {
        c.failed += 1;
        pushError(c, `售后单 ${String(r.return_id ?? '?')} 落库失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const orphan = c.detail.orphan_returns ?? 0;
    if (orphan > 0) {
      sendAlert({
        title: `售后单找不到对应订单 ${orphan} 条`,
        detail: `店铺「${shop.shopName}」本次有 ${orphan} 条售后的 order_id 在本地不存在，通常是订单同步落后，请先重跑 order 任务`,
      });
    }
  });
}

/* ==================== 联盟归因回填 ==================== */

/**
 * 联盟报文 → tk_order_item 归因列（纯计算，real/mock 报文对拍的入口）。
 * 归因是「更新已有明细行」而不是插新行，所以报文一旦换字段名不会报错，
 * 只会静默把佣金算成 0 —— 比插不上行更难发现，必须能被单独断言。
 * `matched` 保留原来的三档计数口径（达人建档 / 自营号 / 都没建档）。
 */
export function attributionOf(
  a: PlatformAffiliateOrder,
  target: { id: number; item_amount: number },
): { creator_id: number | null; content_type: number; content_id: string | null; commission_rate: number; est_commission: number; matched: 'creator' | 'own_account' | 'none' } {
  const handle = normalizeHandle(String(a.creator_handle ?? ''));
  const creator = handle ? get<{ id: number }>(`SELECT id FROM creator WHERE handle = ? AND is_deleted = 0`, handle) : undefined;
  const ownAccount = !creator && handle ? get<{ id: number }>(`SELECT id FROM tk_account WHERE handle = ? AND is_deleted = 0`, handle) : undefined;
  const rate = round2(Number(a.seller_commission_rate ?? a.commission_rate ?? 0) || 0);
  return {
    creator_id: creator?.id ?? null,
    content_type: normalizeContentType(a.content_type, Boolean(creator)),
    content_id: String(a.video_id ?? a.live_id ?? '').trim() || null,
    commission_rate: rate,
    est_commission: round2((Number(target.item_amount) * rate) / 100),
    matched: creator ? 'creator' : ownAccount ? 'own_account' : 'none',
  };
}

export async function applyAffiliateAttribution(shopId: number, opts: SyncOptions = {}): Promise<SyncResult> {
  return withSyncLog('affiliate_order', shopId, opts, async (c, window) => {
    const shop = buildShopCredential(shopId);
    const list = await createTiktokClient().getAffiliateOrders(shop, window);
    c.fetched += list.length;
    for (const a of list) {
      const target = pickAttributionTarget(shopId, a);
      if (!target) {
        c.failed += 1;
        bump(c, 'order_not_found');
        continue;
      }
      const patch = attributionOf(a, target);
      update('tk_order_item', target.id, {
        creator_id: patch.creator_id,
        content_type: patch.content_type,
        content_id: patch.content_id,
        commission_rate: patch.commission_rate,
        est_commission: patch.est_commission,
      } as never);
      c.updated += 1;
      if (patch.matched === 'creator') bump(c, 'creator_matched');
      else if (patch.matched === 'own_account') bump(c, 'own_account');
      else bump(c, 'creator_unmatched');
    }
    const missing = c.detail.order_not_found ?? 0;
    if (missing > 0) {
      sendAlert({
        title: `联盟归因有 ${missing} 条对不上订单明细`,
        detail: `店铺「${shop.shopName}」联盟订单接口的 order_id/sku 在本地订单明细中不存在，可能是订单同步滞后或联盟权限未开通`,
      });
    }
    if ((c.detail.creator_unmatched ?? 0) > 0) {
      sendAlert({
        title: `联盟归因有 ${c.detail.creator_unmatched} 个达人未入库`,
        detail: `店铺「${shop.shopName}」按 handle 归一化后在达人库找不到档案，已保留内容 ID 但未挂达人，请核对是否需要建档案`,
      });
    }
  });
}

export function pickAttributionTarget(shopId: number, a: PlatformAffiliateOrder): { id: number; item_amount: number } | undefined {
  const tkOrderId = String(a.order_id ?? '').trim();
  if (!tkOrderId) return undefined;
  const skuId = a.sku_id === undefined || a.sku_id === null ? '' : String(a.sku_id);
  const sellerSku = String(a.seller_sku ?? '');
  return get<{ id: number; item_amount: number }>(
    `SELECT i.id, i.item_amount
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.shop_id = ? AND o.is_deleted = 0
       LEFT JOIN shop_listing l ON l.id = i.listing_id
      WHERE o.tk_order_id = ? AND i.is_deleted = 0
        AND (IFNULL(l.tk_sku_id, '') = ? OR (? <> '' AND IFNULL(l.seller_sku, '') = ?))
      ORDER BY i.id ASC LIMIT 1`,
    shopId,
    tkOrderId,
    skuId,
    sellerSku,
    sellerSku,
  );
}

/* ==================== 派生汇总刷新 ==================== */

/**
 * 派生汇总刷新：映射纠偏 + 成本回填 + 四张分析宽表重建。
 *  1. listing.map_status 与 sku_id 保持一致（人工在库里直接改了 sku 也能纠偏）；
 *  2. 把 cost_matched=0（从来没有快照）且映射已补齐的历史明细按当前成本补一次，逐行写操作日志；
 *  3. 重建 analytics_*（§15.2 宽表）—— 以前「派生汇总刷新」根本不动宽表，
 *     宽表只有夜里那条 cron 会重算，界面点完「刷新」数字还是旧的。
 * 已冻结过 cost_snapshot 的历史行绝不回溯（方案表 7 + 要点 5.1）。
 *
 * 窗口：这是全量重算，不是增量。调用方没给窗口时按**源数据实际跨度**（最早订单 → 现在）算，
 * 并把生效窗口写进 sync_log；以前退化成 resolveWindow 的「最近 24 小时」，
 * 在历史数据上等于什么都没算，日志却报「成功」——这就是 #33。
 */
/** 源数据实际跨度（UTC）：宽表与成本回填都是全量重算，窗口必须覆盖到最早一单 */
function fullDataWindow(): SyncWindow {
  const span = get<{ lo: string | null; hi: string | null }>(
    `SELECT MIN(order_time) AS lo, MAX(order_time) AS hi FROM tk_order WHERE is_deleted = 0`,
  );
  const now = utcStamp();
  return { from: span?.lo ?? now, to: now };
}

export function refreshDerivedAggregates(opts: SyncOptions = {}, shopIds?: number[]): SyncResult {
  const startedAt = utcStamp();
  const user = opts.user_id ?? SYSTEM_USER_ID;
  const scopedIds = shopIds === undefined ? undefined : [...new Set(shopIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const shopFilter = scopedIds === undefined ? '' : scopedIds.length ? ` AND shop_id IN (${scopedIds.map(() => '?').join(',')})` : ' AND 1 = 0';
  const orderShopFilter = scopedIds === undefined ? '' : scopedIds.length ? ` AND o.shop_id IN (${scopedIds.map(() => '?').join(',')})` : ' AND 1 = 0';
  const scopeParams = scopedIds ?? [];
  const logShopId = scopedIds?.length === 1 ? scopedIds[0]! : 0;
  const window = opts.windowStart ? resolveWindow('aggregate', logShopId, opts) : fullDataWindow();
  const logId = insert('sync_log', {
    task_type: 'aggregate',
    shop_id: logShopId || null,
    window_start: window.from,
    window_end: window.to,
    started_at: startedAt,
    created_by: user,
  });
  let listingFixed = 0;
  let itemBackfilled = 0;
  let errorMsg: string | null = null;
  try {
    tx(() => {
      listingFixed = scalar<number>(
        `SELECT COUNT(*) FROM shop_listing
          WHERE is_deleted = 0 AND map_status <> (CASE WHEN sku_id IS NULL THEN 2 ELSE 1 END)${shopFilter}`,
        ...scopeParams,
      );
      if (listingFixed > 0) {
        run(
          `UPDATE shop_listing
              SET map_status = CASE WHEN sku_id IS NULL THEN 2 ELSE 1 END, updated_at = datetime('now')
            WHERE is_deleted = 0 AND map_status <> (CASE WHEN sku_id IS NULL THEN 2 ELSE 1 END)${shopFilter}`,
          ...scopeParams,
        );
      }
      const stale = all<{ id: number; listing_id: number; quantity: number; order_id: number }>(
        `SELECT i.id, i.listing_id, i.quantity, i.order_id
           FROM tk_order_item i
           JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
           JOIN shop_listing l ON l.id = i.listing_id AND l.shop_id = o.shop_id
          WHERE i.is_deleted = 0 AND i.cost_matched = 0 AND i.sku_id IS NULL AND l.sku_id IS NOT NULL${orderShopFilter}`,
        ...scopeParams,
      );
      for (const row of stale) {
        const sku = get<{ id: number; purchase_cost: number; first_leg_cost: number; sku_code: string }>(
          `SELECT k.id, k.purchase_cost, k.first_leg_cost, k.sku_code
             FROM product_sku k JOIN shop_listing l ON l.id = ? AND l.sku_id = k.id AND k.is_deleted = 0`,
          row.listing_id,
        );
        if (!sku) continue;
        const cost = snapshotCost(sku, Number(row.quantity));
        run(`UPDATE tk_order_item SET sku_id = ?, cost_snapshot = ?, cost_matched = 1, updated_at = datetime('now') WHERE id = ?`, sku.id, cost, row.id);
        itemBackfilled += 1;
        writeOpLog({
          user_id: user,
          module: '数据同步',
          action: 'update',
          target_table: 'tk_order_item',
          target_id: row.id,
          before: { order_id: row.order_id, sku_id: null, cost_matched: 0, cost_snapshot: 0 },
          after: { order_id: row.order_id, sku_id: sku.id, sku_code: sku.sku_code, cost_matched: 1, cost_snapshot: cost, reason: '映射补齐后按当前成本回填（此前无快照）' },
        });
      }
    });
  } catch (e) {
    errorMsg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    sendAlert({ title: '派生汇总刷新失败', detail: errorMsg, level: 'error' });
  }

  // 宽表重建：按生效窗口的日期区间全量重算，失败同样留痕
  let analyticsAffected = 0;
  let rateFallback = 0;
  try {
    const fromDay = window.from.slice(0, 10);
    const toDay = window.to.slice(0, 10);
    analyticsAffected =
      rebuildShopChannelDaily(fromDay, toDay, user) +
      rebuildProductChannelDaily(fromDay, toDay, user) +
      rebuildCreatorDaily(fromDay, toDay, user) +
      rebuildVideoDaily(fromDay, toDay, user);
    rateFallback = countRateFallbacks(fromDay, toDay);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    errorMsg = errorMsg ? `${errorMsg} / 宽表重建：${msg}` : `宽表重建：${msg}`;
    sendAlert({ title: '分析宽表重建失败', detail: msg, level: 'error' });
  }

  return finishSyncLog(logId, startedAt, window, {
    fetched: listingFixed + itemBackfilled + analyticsAffected,
    inserted: itemBackfilled,
    updated: listingFixed + analyticsAffected,
    failed: errorMsg ? 1 : 0,
    status: errorMsg ? 3 : 1,
    error_msg: errorMsg,
    detail: { listing_fixed: listingFixed, item_backfilled: itemBackfilled, analytics_rows: analyticsAffected, rate_fallback_rows: rateFallback },
  }, logShopId, 'aggregate');
}

/* ==================== sync_log 收口 ==================== */

interface TaskOutcome {
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  status: number;
  error_msg: string | null;
  detail: Record<string, number>;
}

function finishSyncLog(logId: number, startedAt: string, window: SyncWindow, out: TaskOutcome, shopId: number, taskType: SyncTaskType): SyncResult {
  const finishedAt = utcStamp();
  update('sync_log', logId, {
    fetched: out.fetched,
    inserted: out.inserted,
    updated: out.updated,
    failed: out.failed,
    status: out.status,
    error_msg: out.error_msg,
    finished_at: finishedAt,
  } as never);
  return {
    log_id: logId,
    task_type: taskType,
    shop_id: shopId,
    window_start: window.from,
    window_end: window.to,
    fetched: out.fetched,
    inserted: out.inserted,
    updated: out.updated,
    failed: out.failed,
    status: out.status,
    error_msg: out.error_msg,
    started_at: startedAt,
    finished_at: finishedAt,
    detail: out.detail,
  };
}

async function withSyncLog(taskType: SyncTaskType, shopId: number, opts: SyncOptions, body: (c: Counters, window: SyncWindow) => Promise<void>): Promise<SyncResult> {
  const startedAt = utcStamp();
  const window = resolveWindow(taskType, shopId, opts);
  const c = newCounters();
  let status = 1;
  let errorMsg: string | null = null;
  const logId = insert('sync_log', {
    task_type: taskType,
    shop_id: shopId,
    window_start: window.from,
    window_end: window.to,
    started_at: startedAt,
    created_by: opts.user_id ?? SYSTEM_USER_ID,
  });
  try {
    await body(c, window);
  } catch (e) {
    status = 3;
    // 这里的原文可能来自平台报文（上游 message 会回显入参），必须先脱敏再进 sync_log 与告警
    errorMsg = maskError(e instanceof Error ? e.message : String(e));
    sendAlert({ title: `同步任务 ${taskType} 失败（店铺 #${shopId}）`, detail: errorMsg, level: 'error' });
  }
  // 「平时每天有单、今天 0 条」按失败处理（方案 6.4）
  if (taskType === 'order' && c.fetched === 0 && status === 1) {
    const recent = scalar<number>(
      `SELECT COUNT(*) FROM tk_order WHERE shop_id = ? AND is_deleted = 0 AND order_time >= datetime('now','-30 days')`,
      shopId,
    );
    if (recent > 0) {
      status = 3;
      errorMsg = `近 30 天该店有 ${recent} 单，本次窗口 ${window.from} ~ ${window.to} 拉到 0 条，疑似接口异常或授权失效`;
      sendAlert({ title: `订单同步 0 条告警（店铺 #${shopId}）`, detail: errorMsg, level: 'error' });
    }
  }
  if (c.failed > 0 && status === 1) status = 2;
  return finishSyncLog(
    logId,
    startedAt,
    window,
    { fetched: c.fetched, inserted: c.inserted, updated: c.updated, failed: c.failed, status, error_msg: errorMsg ?? (c.errors.join(' | ') || null), detail: c.detail },
    shopId,
    taskType,
  );
}

/** 单店单任务分派（'all' 顺序：商品 → 订单 → 售后 → 联盟 → 派生刷新） */
export async function runTask(taskType: SyncTaskInput, shopId: number, opts: SyncOptions = {}): Promise<SyncResult[]> {
  switch (taskType) {
    case 'order':
      return [await syncOrdersForShop(shopId, opts)];
    case 'listing':
    case 'product':
      return [await syncListingsForShop(shopId, opts)];
    case 'returns':
      return [await syncReturnsForShop(shopId, opts)];
    case 'affiliate':
    case 'affiliate_order':
      return [await applyAffiliateAttribution(shopId, opts)];
    case 'aggregate':
      return [refreshDerivedAggregates(opts, [shopId])];
    case 'all': {
      const out: SyncResult[] = [];
      for (const t of ['listing', 'order', 'returns', 'affiliate_order'] as const) out.push(...(await runTask(t, shopId, opts)));
      out.push(refreshDerivedAggregates(opts, [shopId]));
      return out;
    }
    default:
      throw new Error(`未知同步任务类型：${String(taskType)}`);
  }
}

/** 全店批量入口：给调度器与 POST /sync/run（未指定 shop_id）用 */
export async function runTaskForAllShops(taskType: SyncTaskInput, opts: SyncOptions = {}): Promise<SyncResult[]> {
  if (taskType === 'aggregate') return [refreshDerivedAggregates(opts)];
  const out: SyncResult[] = [];
  for (const shopId of activeShopIds()) out.push(...(await runTask(taskType, shopId, opts)));
  return out;
}

/** 指定店铺批量入口：供有数据范围的手动操作复用，绝不重新枚举全局店铺。 */
export async function runTaskForShopIds(shopIds: number[], taskType: SyncTaskInput, opts: SyncOptions = {}): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const shopId of [...new Set(shopIds)]) out.push(...(await runTask(taskType, shopId, opts)));
  return out;
}

/* ==================== 调度注册 ==================== */

/** node-cron 兼容的最小接口：只依赖 schedule()，本模块不直接 import 第三方库 */
export interface CronLike {
  schedule: (expr: string, task: () => unknown, opts?: Record<string, unknown>) => unknown;
}

const safe = (name: string) => (e: unknown): void =>
  sendAlert({ title: `定时任务 ${name} 异常`, detail: e instanceof Error ? e.message : String(e), level: 'error' });

/**
 * 注册同步类定时任务（订单 15 分钟增量、售后每小时、商品/联盟每日）。
 * jobs/scheduler.ts 不在本次改动范围内，需要人工在 startScheduler() 里调用一次：
 *   registerSyncJobs(cron)   // cron = await import('node-cron')
 */
export function registerSyncJobs(cron: CronLike): { name: string; expr: string }[] {
  const jobs: { name: string; expr: string; run: () => void }[] = [
    { name: 'order', expr: '*/15 * * * *', run: () => void runTaskForAllShops('order').catch(safe('order')) },
    { name: 'returns', expr: '35 * * * *', run: () => void runTaskForAllShops('returns').catch(safe('returns')) },
    { name: 'listing', expr: '10 4 * * *', run: () => void runTaskForAllShops('listing').catch(safe('listing')) },
    { name: 'affiliate', expr: '50 3 * * *', run: () => void runTaskForAllShops('affiliate_order').catch(safe('affiliate')) },
    { name: 'aggregate', expr: '55 3 * * *', run: () => void refreshDerivedAggregates() },
  ];
  // 时区必须显式：不传时 node-cron 用服务器本地时区，同步窗口按 UTC 算就会错位
  for (const j of jobs) cron.schedule(j.expr, j.run, { name: `sync:${j.name}`, timezone: config.jobTimezone });
  return jobs.map(({ name, expr }) => ({ name, expr }));
}
