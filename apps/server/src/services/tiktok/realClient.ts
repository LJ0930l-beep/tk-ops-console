/**
 * TikTok Shop 开放平台真实客户端（官方 Open API 签名契约，方案第七章 / 6.4）。
 *
 * 签名规则（官方《如何生成签名》与 tiktok/ttspc-server-sample 中间件一致）：
 *   1. 查询参数剔除 sign、access_token 与空值，按 key 升序拼成 `key1value1key2value2…`（无 `=`、无 `&`）；
 *   2. base = path + 上面的串 + 请求体原文（无体时为空串）；
 *   3. signed = app_secret + base + app_secret；
 *   4. sign = HMAC-SHA256(key = app_secret, data = signed) 的**十六进制小写**；
 *   5. app_key / timestamp / sign 连同 shop_cipher 放在**查询串**里下发；access token 走
 *      `x-tts-access-token` 头。官方契约没有 nonce，也没有 x-tt-appkey/x-tt-sign 这类头。
 *
 * 202309 的 /search 系列是 POST：过滤条件在 JSON body 里，page_size / page_token 在查询串里，
 * 因此 body 只序列化一次 —— 参与签名的字节必须与真正发出的字节完全一致。
 *
 * 硬规则：app_secret / sign / app_key / access_token 一律不进日志、不进异常信息、不进响应体，
 * 所以这里所有 Error 的文案只保留 path、平台 code/message、request_id，并再过一遍 safe() 脱敏。
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
const MAX_RETRY = 2;

const ORDER_SEARCH_PATH = '/order/202309/orders/search';
const PRODUCT_SEARCH_PATH = '/product/202309/products/search';
const RETURN_SEARCH_PATH = '/return/202309/returns/search';
/** 联盟卖家接口路径以 Partner Center 当期文档为准，需单独申请权限 */
const AFFILIATE_SEARCH_PATH = '/affiliate/202312/orders/search';

/* ---------- 平台错误码：决定「改配置」还是「等一会儿」 ----------
 * 只按 code 分支会误判（105002 也可能是别的原因），故 code + message 关键字一起看。 */
const CODE_TOKEN_EXPIRED = 105002;
const CODE_SIGN_INVALID = 106001;
const CODE_RATE_LIMIT = 36009002;
const CODE_OVERLOAD = 36009004;
const CODE_CIPHER_MISMATCH = 101000;

type QueryValue = string | number | undefined | null;

const isEmpty = (v: QueryValue): boolean => v === undefined || v === null || v === '';

/** 升序拼 `key+value`：签名串与查询串必须由同一个 params 对象生成，否则平台判签名无效 */
export function sortedKeyValue(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && k !== 'access_token' && !isEmpty(v))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}${String(v)}`)
    .join('');
}

/** 官方签名：hex(HMAC_SHA256(app_secret, app_secret + path + sortedKV + body + app_secret))，返回值不得打印 */
export function buildSign(appSecret: string, path: string, params: Record<string, QueryValue>, body = ''): string {
  const base = `${appSecret}${path}${sortedKeyValue(params)}${body}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

export interface SignInput {
  appSecret: string;
  path: string;
  params: Record<string, QueryValue>;
  body?: string;
}

/** 单测用的纯签名入口（不触发任何网络调用） */
export const signRequest = (i: SignInput): string => buildSign(i.appSecret, i.path, i.params, i.body ?? '');

const urlQuery = (params: Record<string, QueryValue>): string =>
  Object.entries(params)
    .filter(([, v]) => !isEmpty(v))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/** 平台/网络侧失败：文案已由 safe() 脱敏，绝不含凭证与签名 */
export class TikTokApiError extends AppError {
  constructor(path: string, status: number, message: string, readonly requestId = '') {
    super(502, `TikTok 接口 ${path} 调用失败：${message}`, 50200 + (Number.isFinite(status) ? status : 0));
  }
}

/** 把平台错误码翻译成人能照着做的下一步（不含任何凭证） */
function describeFailure(code: number | undefined, message: string | undefined, status: number): string {
  const text = message ?? '';
  if (code === CODE_TOKEN_EXPIRED) return `授权令牌已过期（${CODE_TOKEN_EXPIRED}），请在「店铺与账号 → 重新授权」换新 token`;
  if (code === CODE_SIGN_INVALID) return `签名校验不通过（${CODE_SIGN_INVALID}），请核对 app_key / app_secret 与店铺站点`;
  if (code === CODE_CIPHER_MISMATCH) return `令牌与 shop_cipher 不匹配（${CODE_CIPHER_MISMATCH}），请重新授权并核对店铺密文`;
  if (status === 429 || code === CODE_RATE_LIMIT) return `触发限流（${code ?? status}），稍后重试`;
  if (code === CODE_OVERLOAD || /overload/i.test(text)) return '平台繁忙，稍后重试';
  return `HTTP ${status} code=${code ?? '-'} ${text || '平台未返回原因'}`;
}

const isRetryable = (status: number, code: number | undefined, message: string | undefined): boolean =>
  status === 429 || status >= 500 || code === CODE_RATE_LIMIT || code === CODE_OVERLOAD || /overload/i.test(message ?? '');

/** 202309 各 search 接口的数组字段名不同（orders / products / returns / list），取第一个非空数组 */
function pageList<T>(data: PlatformEnvelope<unknown>['data'], key: string): T[] {
  const d = data as Record<string, unknown> | null | undefined;
  for (const k of [key, 'list']) {
    const v = d?.[k];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RealTikTokShopClient implements TikTokShopClient {
  readonly mode: TikTokApiMode = 'real';

  private readonly baseUrl: string;

  constructor(baseUrl: string = config.tiktokBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 一次签名请求。网络异常 / 非 2xx / 平台 code≠0 都抛错；429、5xx、平台繁忙最多重试 2 次。
   * opts.body 只序列化一次，签名与发包共用同一串字节。
   */
  private async request<T>(
    shop: ShopCredential,
    path: string,
    opts: { method: 'GET' | 'POST'; query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<T> {
    if (!shop.appKey || !shop.appSecret) {
      throw new AppError(400, `店铺「${shop.shopName}」缺少接口凭证，请先在「店铺与账号 → 重新授权」补齐 app_key / app_secret`, 40020);
    }
    if (!shop.accessToken) {
      throw new AppError(400, `店铺「${shop.shopName}」未授权 access token，请在店铺页重新授权`, 40020);
    }
    const rawBody = opts.body === undefined ? '' : JSON.stringify(opts.body);
    let lastErr: TikTokApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      // timestamp 每次重试都要重新取，避免重试耗时导致令牌时间戳过期
      const params: Record<string, QueryValue> = {
        ...opts.query,
        app_key: shop.appKey,
        timestamp: String(Math.floor(Date.now() / 1000)),
        shop_cipher: shop.shopCipher ?? undefined,
      };
      params.sign = buildSign(shop.appSecret, path, params, rawBody);
      const url = `${this.baseUrl}${path}?${urlQuery(params)}`;

      let status = 0;
      let raw = '';
      try {
        const res = await fetch(url, {
          method: opts.method,
          headers: {
            'x-tts-access-token': shop.accessToken,
            ...(rawBody ? { 'content-type': 'application/json; charset=utf-8' } : {}),
          },
          ...(rawBody ? { body: rawBody } : {}),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        status = res.status;
        raw = await res.text();
        const retryAfter = Number(res.headers.get('retry-after'));
        if ((status === 429 || status >= 500) && attempt < MAX_RETRY) {
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * (attempt + 1));
          continue;
        }
      } catch (e) {
        const reason = e instanceof Error ? (e.name === 'TimeoutError' ? '请求超时' : e.message) : String(e);
        lastErr = new TikTokApiError(path, 0, this.safe(shop, `网络异常（${reason}）`));
        if (attempt < MAX_RETRY) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }

      let body: PlatformEnvelope<unknown> | undefined;
      try {
        body = JSON.parse(raw) as PlatformEnvelope<unknown>;
      } catch {
        throw new TikTokApiError(path, status, `返回非 JSON 报文（HTTP ${status}）`);
      }
      const failed = status >= 400 || (body?.code !== undefined && body.code !== 0);
      if (failed) {
        const why = describeFailure(body?.code, body?.message, status);
        lastErr = new TikTokApiError(path, status, this.safe(shop, why), body?.request_id ?? '');
        if (isRetryable(status, body?.code, body?.message) && attempt < MAX_RETRY) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      return body as T;
    }
    throw lastErr ?? new TikTokApiError(path, 0, '重试次数用尽');
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
        method: 'POST',
        query: { page_size: Math.min(100, window.limit ?? 100), page_token: cursor },
        // 官方区间是左闭右开：ge 含、lt 不含
        body: { create_time_ge: utcToUnix(window.from) || undefined, create_time_lt: utcToUnix(window.to) || undefined },
      });
      out.push(...pageList<PlatformOrder>(body?.data, 'orders'));
      cursor = body?.data?.next_page_token || undefined;
      if (!cursor || body?.data?.has_more === false) break;
    }
    return out;
  }

  async getProducts(shop: ShopCredential, cursor?: string | null): Promise<ProductPage> {
    const body = await this.request<PlatformEnvelope<PlatformProduct>>(shop, PRODUCT_SEARCH_PATH, {
      method: 'POST',
      query: { page_size: 50, page_token: cursor ?? undefined },
      body: {},
    });
    return { products: pageList<PlatformProduct>(body?.data, 'products'), nextCursor: body?.data?.next_page_token || null };
  }

  async getReturns(shop: ShopCredential, window: SyncWindow): Promise<PlatformReturn[]> {
    const out: PlatformReturn[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request<PlatformEnvelope<PlatformReturn>>(shop, RETURN_SEARCH_PATH, {
        method: 'POST',
        query: { page_size: 50, page_token: cursor },
        body: { create_time_ge: utcToUnix(window.from) || undefined, create_time_lt: utcToUnix(window.to) || undefined },
      });
      out.push(...pageList<PlatformReturn>(body?.data, 'returns'));
      cursor = body?.data?.next_page_token || undefined;
      if (!cursor) break;
    }
    return out;
  }

  async getAffiliateOrders(shop: ShopCredential, window: SyncWindow): Promise<PlatformAffiliateOrder[]> {
    const body = await this.request<PlatformEnvelope<PlatformAffiliateOrder>>(shop, AFFILIATE_SEARCH_PATH, {
      method: 'POST',
      query: { page_size: 50 },
      body: {
        order_create_time_ge: utcToUnix(window.from) || undefined,
        order_create_time_lt: utcToUnix(window.to) || undefined,
      },
    });
    return pageList<PlatformAffiliateOrder>(body?.data, 'affiliate_orders');
  }
}
