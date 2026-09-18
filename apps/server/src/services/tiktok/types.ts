/**
 * TikTok Shop 开放平台原始报文结构（方案第七章）。
 *
 * 字段名与 Partner Center 文档保持 camelCase 一致，**不做任何本地归一化**：
 * 本地列名（tk_order / tk_order_item …）与枚举映射统一放在 jobs/syncJobs.ts 处理，
 * 这样「卖家中心导出表格兜底导入」与「接口同步」能共用同一套入库函数。
 *
 * 平台的金额/时间在不同版本里形态不稳定（字符串、数字、{amount,currency} 对象、Unix 秒），
 * 因此这里用宽松类型接收，落库前一律过本文件底部的归一化工具。
 */

/** 平台金额：可能是 "12.34" / 12.34 / { amount: '12.34', currency: 'USD' } */
export type PlatformMoney = string | number | null | undefined | { amount?: string | number; currency?: string };

/** 平台时间：Unix 秒（int），0 或缺失表示「没有该节点」 */
export type PlatformTime = number | string | null | undefined;

/** 平台统一响应外层 */
export interface PlatformEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    list?: T[];
    total_count?: number;
    next_page_token?: string;
    has_more?: boolean;
  } | null;
}

/* ---------------- 订单 /order/202309/orders/search ---------------- */

export interface PlatformOrderItem {
  /** 平台订单明细行 ID（本地 26 表未预留列，仅用于对账日志） */
  id?: string | number;
  sku_id?: string | number;
  product_id?: string | number;
  seller_sku?: string;
  product_name?: string;
  sku_name?: string;
  price?: PlatformMoney;
  quantity?: number;
  /** 分摊到本行的卖家优惠 */
  seller_discount?: PlatformMoney;
  item_discount?: PlatformMoney;
  currency?: string;
  /** 联盟佣金（部分版本随订单返回，正式归因以联盟订单接口为准） */
  commission_rate?: number;
}

export interface PlatformOrder {
  order_id?: string | number;
  /** UNPAID / ON_HOLD / TO_BE_SHIPPED / INVOICE_CREATED / TRANSIT_TO_SHIP / SHIPPED / DELIVERED / COMPLETED / CANCELLED */
  status?: string;
  sub_status?: string;
  create_time?: PlatformTime;
  payment_time?: PlatformTime;
  ship_time?: PlatformTime;
  delivery_time?: PlatformTime;
  cancel_time?: PlatformTime;
  currency?: string;
  /** 买家实付（含运费） */
  total_amount?: PlatformMoney;
  /** 商品原价合计 */
  products_amount?: PlatformMoney;
  shipping_fee?: PlatformMoney;
  seller_discount?: PlatformMoney;
  platform_discount?: PlatformMoney;
  discount_amount?: PlatformMoney;
  fulfillment_type?: string | number;
  buyer_user_info?: { country?: string; region?: string; city?: string } | null;
  /** 达人免费样品单：不计入 GMV */
  is_sample_order?: boolean | number;
  order_type?: string;
  tracking_info?: { tracking_no?: string; courier_name?: string | { name?: string }; shipping_provider_name?: string } | null;
  carrier?: string;
  tracking_no?: string;
  items?: PlatformOrderItem[];
}

/* ---------------- 商品 /product/202309/products/search ---------------- */

export interface PlatformProductSku {
  id?: string | number;
  sku_code?: string;
  seller_sku?: string;
  price?: PlatformMoney;
  sale_price?: PlatformMoney;
  stock?: number;
  status?: string;
  /** 部分版本在 sku 层给规格名 */
  sku_name?: string;
}

export interface PlatformProduct {
  id?: string | number;
  product_id?: string | number;
  title?: string;
  product_name?: string;
  status?: string;
  category_id?: string | number;
  main_images?: string[];
  create_time?: PlatformTime;
  update_time?: PlatformTime;
  skus?: PlatformProductSku[];
}

/* ---------------- 售后 /return/202309/returns/search ---------------- */

export interface PlatformReturn {
  return_id?: string | number;
  order_id?: string | number;
  item_id?: string | number;
  /** ONLY_REFUND / RETURN_AND_REFUND / REPLACEMENT */
  return_type?: string;
  type?: string;
  reason?: string;
  customer_service_reason?: string;
  refund_amount?: PlatformMoney;
  return_amount?: PlatformMoney;
  currency?: string;
  status?: string;
  create_time?: PlatformTime;
  apply_time?: PlatformTime;
  finish_time?: PlatformTime;
  delivery_time?: PlatformTime;
  return_qty?: number;
  /** 货是否退回卖家仓（用于 is_restocked 初值） */
  has_returned?: boolean;
}

/* ---------------- 联盟订单（Affiliate Seller API，带货归因） ---------------- */

export interface PlatformAffiliateOrder {
  order_id?: string | number;
  item_id?: string | number;
  sku_id?: string | number;
  seller_sku?: string;
  /** 平台达人 ID，本地达人库按 handle 建档，故同时回传 handle */
  creator_id?: string | number;
  affiliate_creator_id?: string | number;
  creator?: string | number;
  creator_handle?: string;
  /** VIDEO / LIVE / PRODUCT */
  content_type?: string;
  video_id?: string | number;
  live_id?: string | number;
  /** 佣金率，单位 % */
  seller_commission_rate?: number;
  commission_rate?: number;
  platform_commission_rate?: number;
  /** 达人佣金金额（店铺币种） */
  seller_commission_amount?: PlatformMoney;
  create_time?: PlatformTime;
}

/* ==================== 报文归一化工具（时间/金额） ==================== */

/** 全站时间统一 UTC，文本格式 YYYY-MM-DD HH:MM:SS（SQLite datetime('now') 同格式） */
export function formatUtc(d: Date): string {
  return `${d.toISOString().replace('T', ' ').slice(0, 19)}`;
}

export const utcNow = (): string => formatUtc(new Date());

/** 'YYYY-MM-DD HH:MM:SS'（UTC）→ Date */
export function parseUtc(text: string | null | undefined): Date | null {
  if (!text) return null;
  const iso = String(text).trim().replace(' ', 'T');
  const t = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 'YYYY-MM-DD HH:MM:SS'（UTC）→ Unix 秒 */
export function utcToUnix(text: string | null | undefined): number {
  const d = parseUtc(text);
  return d ? Math.floor(d.getTime() / 1000) : 0;
}

/** Unix 秒（平台时间）→ 'YYYY-MM-DD HH:MM:SS'（UTC）；0/空 → null */
export function unixToUtc(sec: PlatformTime): string | null {
  const n = Number(typeof sec === 'string' ? sec.trim() : sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatUtc(new Date(Math.round(n) * 1000));
}

/** 时间文本平移若干分钟（同步窗口重叠用） */
export function shiftMinutes(text: string, minutes: number): string {
  const d = parseUtc(text) ?? new Date();
  return formatUtc(new Date(d.getTime() + minutes * 60_000));
}

const roundMoney = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * 平台金额 → 本地 REAL（主单位、两位小数）。
 * 纯数字若明显是「分」（大于等价值且带 currency 对象）不猜尺度：只认字符串/数字主单位与 Money 对象。
 */
export function money(v: PlatformMoney): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object') return roundMoney(Number(v.amount ?? 0) || 0);
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? roundMoney(n) : 0;
}

/** 平台布尔/枚举 → 0/1 */
export function flag(v: boolean | number | string | null | undefined): 0 | 1 {
  if (typeof v === 'string') return ['true', 'yes', '1', 'y'].includes(v.toLowerCase()) ? 1 : 0;
  return v === true || Number(v) === 1 ? 1 : 0;
}
