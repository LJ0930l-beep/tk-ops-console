/**
 * 平台字段 → 本地枚举的归一化（从 jobs/syncJobs.ts 搬过来，见 docs/dev-options.md 选项 11）
 *
 * 为什么单独一层：这些映射是「TikTok 这一家的字段口径」，
 * 原先和落库、窗口、日志混在同一个文件里；将来接第二个平台时，
 * 适配层的边界必须显式存在，否则映射会散落各处（同一个状态在两个文件里翻译成两个值）。
 * 纯函数、不碰数据库，同步作业与导入中心共用同一份。
 */

/* ==================== 平台字段 → 本地枚举归一化 ==================== */

/** 平台状态原文归一化到 tk_order.order_status（方案表 6 注释的取值域） */
export function normalizeOrderStatus(status: string | undefined | null): string {
  const s = String(status ?? '').trim().toUpperCase();
  if (!s) return 'ON_HOLD';
  if (s === 'INVOICE_CREATED') return 'TO_BE_SHIPPED';
  if (s.startsWith('ON_HOLD_SUBSTATUS')) return 'ON_HOLD';
  if (s === 'SHIPPED') return 'TRANSIT_TO_SHIP';
  if (s === 'PACKAGE_DELIVERED') return 'DELIVERED';
  if (s === 'PAYMENT_PENDING') return 'UNPAID';
  return s;
}

/** 1 平台仓 2 自发货 3 海外仓 */
export function normalizeFulfillment(v: string | number | undefined | null): number {
  if (typeof v === 'number') return v >= 1 && v <= 3 ? v : 2;
  const s = String(v ?? '').toUpperCase();
  if (s.includes('PLATFORM')) return 1;
  if (s.includes('OVERSEA') || s.includes('WAREHOUSE')) return 3;
  return 2;
}

/** 平台商品状态 → listing_status：1 草稿 2 审核中 3 在售 4 下架 5 违规 */
export function normalizeListingStatus(v: string | number | undefined | null): number {
  const s = String(v ?? '').toUpperCase();
  if (s.includes('VIOLAT') || s.includes('BLOCK') || s.includes('FREEZE')) return 5;
  if (s.includes('DEACTIVAT') || s.includes('INACTIVAT') || s.includes('OFFLINE')) return 4;
  if (s.includes('AUDIT') || s.includes('PENDING') || s.includes('REVIEW')) return 2;
  if (s.includes('DRAFT')) return 1;
  return 3;
}

/** 1 仅退款 2 退货退款（接口给英文枚举，卖家中心表格给中文，两边都要认） */
export const normalizeReturnType = (v: string | number | undefined | null): number => {
  const s = String(v ?? '').toUpperCase();
  if (s.includes('RETURN') || s.includes('退货') || s === '2') return 2;
  return 1;
};

/** 联盟内容形态 → content_type：1 达人视频 2 达人直播 3 自营视频 4 自营直播 5 商品卡 */
export function normalizeContentType(v: string | number | undefined | null, byCreator: boolean): number {
  const s = String(v ?? '').toUpperCase();
  if (s === 'LIVE' || s === 'LIVESTREAM' || s === 'ROOM') return byCreator ? 2 : 4;
  if (s === 'PRODUCT' || s === 'PRODUCT_CARD' || s === 'SHOWCASE') return 5;
  return byCreator ? 1 : 3;
}
