/**
 * TikTok Shop 开放平台客户端契约与工厂（方案 6.4 / 七章）。
 *
 * 只有 `config.tiktokMode === 'real'` 才会构造 RealTikTokShopClient：
 * mock 模式下 real 实现连实例化都不会发生，杜绝离线环境误发外网请求。
 *
 * 依赖方向固定为 client → {mockProvider, realClient} → types，
 * mock/real 只以 `import type` 引用本文件的接口，运行期无环。
 *
 * provider 只做「拉取 + 归一化成平台原始结构」，写库/成本快照/同步日志一律在 jobs/syncJobs.ts，
 * 保证 mock 与 real 走同一套入库代码路径（结果可比、可测）。
 */
import { config } from '../../config.js';
import { get } from '../../core/db.js';
import { AppError } from '../../core/http.js';
import { decryptSecret } from '../../core/auth.js';
import { MockTikTokShopClient } from './mockProvider.js';
import { RealTikTokShopClient } from './realClient.js';
import type { PlatformAffiliateOrder, PlatformOrder, PlatformProduct, PlatformReturn } from './types.js';

export type TikTokApiMode = 'mock' | 'real';

/** 调用一次接口所需的店铺侧凭证；明文只在内存里存在，不落库、不进日志（方案 6.4） */
export interface ShopCredential {
  shopId: number;
  shopName: string;
  tkShopId: string | null;
  shopCipher: string | null;
  appKey: string;
  appSecret: string;
  accessToken: string;
  currency: string;
  region: string;
  timezone: string;
}

/** 一次增量拉取的窗口（UTC 文本 'YYYY-MM-DD HH:MM:SS'，前后窗口刻意重叠几分钟） */
export interface SyncWindow {
  /** 窗口起（含） */
  from: string;
  /** 窗口止（含） */
  to: string;
  /** 单次上限，防止一次拉爆内存 */
  limit?: number;
}

/** 商品接口是游标翻页：nextCursor 为空表示取完 */
export interface ProductPage {
  products: PlatformProduct[];
  nextCursor: string | null;
}

export interface TikTokShopClient {
  readonly mode: TikTokApiMode;
  /** POST /order/202309/orders/search —— 按创建时间窗口增量拉订单（含明细行） */
  getOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformOrder[]>;
  /** POST /product/202309/products/search —— 游标翻页拉平台商品 */
  getProducts(shop: ShopCredential, cursor?: string | null): Promise<ProductPage>;
  /** POST /return/202309/returns/search —— 售后退款单 */
  getReturns(shop: ShopCredential, window: SyncWindow): Promise<PlatformReturn[]>;
  /** 联盟卖家接口：联盟订单查询（带货归因） */
  getAffiliateOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformAffiliateOrder[]>;
}

/**
 * 从 tk_shop 组装调用凭证：接口凭证从密文列 AES-GCM 解出，只在本函数内存在。
 * access token 按店铺存 `access_token_enc`，**不提供全局环境变量兜底** ——
 * 一个 token 打所有店在多店铺下必然串号，real 模式缺 token 直接失败并写进 sync_log。
 * mock 模式不校验：本地样例数据源压根不用凭证，离线演示要能一路跑通。
 */
export function buildShopCredential(shopId: number): ShopCredential {
  const row = get<Record<string, unknown>>(`SELECT * FROM tk_shop WHERE id = ? AND is_deleted = 0`, shopId);
  if (!row) throw new Error(`店铺 #${shopId} 不存在或已删除，无法调用 TikTok 接口`);
  const tokenEnc = row.access_token_enc ? String(row.access_token_enc) : '';
  if (!tokenEnc && config.tiktokMode === 'real') {
    throw new AppError(400, `店铺「${row.shop_name}」未授权 access token，请在店铺页重新授权`, 40020);
  }
  return {
    shopId: Number(row.id),
    shopName: String(row.shop_name),
    tkShopId: row.tk_shop_id ? String(row.tk_shop_id) : null,
    shopCipher: row.shop_cipher ? String(row.shop_cipher) : null,
    appKey: decryptSecret(String(row.app_key_enc ?? '')),
    appSecret: decryptSecret(String(row.app_secret_enc ?? '')),
    accessToken: decryptSecret(tokenEnc),
    currency: String(row.currency ?? 'USD'),
    region: String(row.region ?? ''),
    timezone: String(row.timezone ?? 'UTC'),
  };
}

let cached: { mode: TikTokApiMode; client: TikTokShopClient } | null = null;

/** 客户端工厂：按 TIKTOK_API_MODE 返回 mock 或 real（默认 mock，离线也能把同步链路真跑一遍） */
export function createTiktokClient(mode: TikTokApiMode = config.tiktokMode): TikTokShopClient {
  if (cached && cached.mode === mode) return cached.client;
  const client: TikTokShopClient = mode === 'real' ? new RealTikTokShopClient() : new MockTikTokShopClient();
  cached = { mode, client };
  return client;
}

/** 早期命名兼容别名（与 createTiktokClient 同一实例缓存） */
export const getClient = createTiktokClient;

/** 测试 / 配置热切换用 */
export function resetClient(): void {
  cached = null;
}
