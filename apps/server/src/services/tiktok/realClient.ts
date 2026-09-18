/**
 * TikTok Shop 开放平台真实客户端（方案第七章 / 6.4）。
 *
 * 签名思路参照官方样例仓库 tiktok/ttspc-server-sample 的 middleware：
 *   base = app_secret + path + 排序后的查询参数 + timestamp + nonce
 *   sign = base64( HMAC-SHA256(base, app_secret) )
 * 凭证与随机串通过 X-Tt-Appkey / X-Tt-Sign / X-Tt-Timestamp / X-Tt-Nonce 头部下发，
 * shop_cipher 作为查询参数参与签名。
 *
 * 硬规则：app_secret / sign / app_key / access_token 一律不进日志、不进异常信息、不进响应体，
 * 因此这里所有 Error 的文案只保留 path、平台 code/message、request_id。
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { AppError } from '../../core/http.js';
import type { TikTokApiMode, ProductPage, ShopCredential, SyncWindow, TikTokShopClient } from './client.js';
import type {
  PlatformAffiliateOrder,
  PlatformEnvelope,
  PlatformOrder,
  PlatformProduct,
  PlatformReturn,
} from './types.js';
import { utcToUnix } from './types.js';

const HTTP_TIMEOUT_MS = 15_000;
const MAX_PAGES = 50;

/** 平台订单状态原文不做归一化，仅本地映射时统一处理（syncJobs） */
const ORDER_SEARCH_PATH = '/order/202309/orders/search';
const PRODUCT_SEARCH_PATH = '/product/202309/products/search';
const RETURN_SEARCH_PATH = '/return/202309/returns/search';
/** 联盟卖家接口路径以 Partner Center 当期文档为准，需单独申请权限 */
const AFFILIATE_SEARCH_PATH = '/affiliate/202312/orders/search';

/** 排序后的查询参数串：签名与 URL 必须完全一致，否则平台判 10007 sign error */
function sortedQuery(params: Record<string, string | number | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
}

/**
 * 签名：app_secret + path + 排序参数 + timestamp + nonce → HMAC-SHA256 → base64。
 * 返回值只在请求函数内部使用，调用方不得打印。
 */
export function buildSign(appSecret: string, path: string, query: string, timestamp: string, nonce: string): string {
  const base = `${appSecret}${path}${query}${timestamp}${nonce}`;
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('base64');
}

export interface SignInput {
  appSecret: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
}

/** 单测用的纯签名入口（不触发任何网络调用） */
export const signRequest = (i: SignInput): string => buildSign(i.appSecret, i.path, i.query, i.timestamp, i.nonce);

/** 平台侧/网络侧失败统一成 502，异常文案已由 safe() 脱敏，绝不含凭证与签名 */
export class TikTokApiError extends AppError {
  constructor(path: string, status: number, message: string, readonly requestId = '') {
    super(502, `TikTok 接口 ${path} 调用失败：${message}`, 50200 + (Number.isFinite(status) ? status : 0));
  }
}

export class RealTikTokShopClient implements TikTokShopClient {
  readonly mode: TikTokApiMode = 'real';

  private readonly baseUrl: string;

  constructor(baseUrl: string = config.tiktokBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 一次签名 GET。网络异常/非 2xx/平台 code≠0 都抛错，
   * 错误文案只带 path 与平台消息，凭证与签名串被显式剔除。
   */
  private async request<T>(shop: ShopCredential, path: string, params: Record<string, string | number | undefined | null>): Promise<T> {
    if (!shop.appKey || !shop.appSecret) {
      throw new AppError(400, `店铺「${shop.shopName}」缺少接口凭证，请先在「店铺与账号 → 重新授权」补齐 app_key / app_secret`, 40020);
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const query = sortedQuery({ ...params, app_key: shop.appKey, shop_cipher: shop.shopCipher ?? undefined });
    const sign = buildSign(shop.appSecret, path, query, timestamp, nonce);
    const url = `${this.baseUrl}${path}?${query}`;

    let raw: string;
    let status: number;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          'x-tt-appkey': shop.appKey,
          'x-tt-sign': sign,
          'x-tt-timestamp': timestamp,
          'x-tt-nonce': nonce,
          'access-token': shop.accessToken,
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      status = res.status;
      raw = await res.text();
    } catch (e) {
      const reason = e instanceof Error ? e.name === 'TimeoutError' ? '请求超时' : e.message : String(e);
      throw new TikTokApiError(path, 0, this.safe(shop, `网络异常（${reason}）`));
    }

    let body: PlatformEnvelope<unknown> | undefined;
    try {
      body = JSON.parse(raw) as PlatformEnvelope<unknown>;
    } catch {
      throw new TikTokApiError(path, status, `返回非 JSON 报文（HTTP ${status}）`);
    }
    if (status >= 400 || (body?.code !== undefined && body.code !== 0)) {
      throw new TikTokApiError(
        path,
        status,
        this.safe(shop, `HTTP ${status} code=${body?.code ?? '-'} ${body?.message ?? '平台未返回原因'}`),
        body?.request_id ?? '',
      );
    }
    return body as T;
  }

  /** 兜底脱敏：即便平台把入参回显在 message 里，也不会把凭证带进日志 */
  private safe(shop: ShopCredential, text: string): string {
    let out = text;
    for (const secret of [shop.appSecret, shop.appKey, shop.accessToken, shop.shopCipher]) {
      if (secret && secret.length > 3) out = out.split(secret).join('***');
    }
    return out.replace(/sign=[^&\s]+/gi, 'sign=***').slice(0, 300);
  }

  async getOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformOrder[]> {
    const out: PlatformOrder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request<PlatformEnvelope<PlatformOrder>>(shop, ORDER_SEARCH_PATH, {
        order_status: undefined,
        create_time_ge: utcToUnix(window.from) || undefined,
        create_time_le: utcToUnix(window.to) || undefined,
        update_time_ge: undefined,
        limit: Math.min(100, window.limit ?? 100),
        page_token: cursor,
      });
      out.push(...(body?.data?.list ?? []));
      cursor = body?.data?.next_page_token || undefined;
      if (!cursor || body?.data?.has_more === false) break;
    }
    return out;
  }

  async getProducts(shop: ShopCredential, cursor?: string | null): Promise<ProductPage> {
    const body = await this.request<PlatformEnvelope<PlatformProduct>>(shop, PRODUCT_SEARCH_PATH, {
      page_size: 50,
      page_token: cursor ?? undefined,
    });
    return { products: body?.data?.list ?? [], nextCursor: body?.data?.next_page_token || null };
  }

  async getReturns(shop: ShopCredential, window: SyncWindow): Promise<PlatformReturn[]> {
    const out: PlatformReturn[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request<PlatformEnvelope<PlatformReturn>>(shop, RETURN_SEARCH_PATH, {
        create_time_ge: utcToUnix(window.from) || undefined,
        create_time_le: utcToUnix(window.to) || undefined,
        page_size: 50,
        page_token: cursor,
      });
      out.push(...(body?.data?.list ?? []));
      cursor = body?.data?.next_page_token || undefined;
      if (!cursor) break;
    }
    return out;
  }

  async getAffiliateOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformAffiliateOrder[]> {
    const body = await this.request<PlatformEnvelope<PlatformAffiliateOrder>>(shop, AFFILIATE_SEARCH_PATH, {
      order_create_time_ge: utcToUnix(window.from) || undefined,
      order_create_time_le: utcToUnix(window.to) || undefined,
      page_size: 50,
    });
    return body?.data?.list ?? [];
  }
}
