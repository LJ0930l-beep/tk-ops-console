import { createServer, type AddressInfo, type IncomingHttpHeaders } from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RealTikTokShopClient,
  TikTokApiError,
  buildSign,
  sortedKeyValue,
} from '../src/services/tiktok/realClient.js';
import { buildShopCredential, createTiktokClient, resetClient, type ShopCredential } from '../src/services/tiktok/client.js';
import { MockTikTokShopClient } from '../src/services/tiktok/mockProvider.js';
import { decryptSecret, encryptSecret } from '../src/core/auth.js';
import { config } from '../src/config.js';
import { AppError } from '../src/core/http.js';
import { get, run } from '../src/core/db.js';
import { migrate } from '../src/db/migrate.js';
import { boot } from './helper.js';

/**
 * TikTok Shop 接口对接（EPIC-4-01）：签名契约、按店铺凭证、错误分类与重试。
 *
 * 真实店铺联调不在本 spec 范围内（无凭证、也不允许出网），改用本地 node:http 模拟平台：
 * 校验「查询串里的 sign 能被独立复算」这一条硬契约，以及凭证不进报文/日志。
 */

const { db } = boot();

const SECRET = 'SEC';
const PATH = '/order/202309/orders/search';

/* ==================== 签名纯函数 ==================== */

describe('官方签名算法', () => {
  it('固定向量：hex(HMAC_SHA256(secret, secret + path + 升序 KV + body + secret))', () => {
    expect(
      buildSign(SECRET, PATH, { timestamp: '1700000000', app_key: 'AK', shop_cipher: 'C1' }, '{"create_time_ge":1700000000}'),
    ).toBe('aee2cc743f13ee5dc1657f0234a8d1f53063e4b9c4709e8cadf6043084cc20c2');
  });

  it('与独立实现的 HMAC 结果一致', () => {
    const params = { app_key: 'AK', timestamp: '1700000000' };
    const body = '{"a":1}';
    const expectHex = crypto
      .createHmac('sha256', SECRET)
      .update(`${SECRET}${PATH}app_keyAKtimestamp1700000000${body}${SECRET}`, 'utf8')
      .digest('hex');
    expect(buildSign(SECRET, PATH, params, body)).toBe(expectHex);
  });

  it('参数升序拼接，忽略 sign/access_token 与空值（顺序不影响签名）', () => {
    expect(sortedKeyValue({ b: 2, a: '1', c: '', sign: 'zzz', access_token: 'secret-token', d: null })).toBe('a1b2');
    expect(buildSign(SECRET, PATH, { a: '1', b: '2' })).toBe(buildSign(SECRET, PATH, { b: '2', a: '1', sign: 'whatever' }));
    // 改一个字节就必须换签名：平台侧同样只认这套拼法
    expect(buildSign(SECRET, PATH, { a: '1', b: '2' })).not.toBe(buildSign(SECRET, PATH, { a: '1', b: '3' }));
    expect(buildSign(SECRET, PATH, { a: '1' }, '{}')).not.toBe(buildSign(SECRET, PATH, { a: '1' }));
  });
});

/* ==================== 按店铺凭证 ==================== */

describe('按店铺 access token（不再有共享环境变量兜底）', () => {
  it('schema/迁移后 tk_shop 有 access_token_enc 列，且重复迁移不报错', () => {
    const cols = db.prepare(`PRAGMA table_info(tk_shop)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('access_token_enc');
    expect(() => migrate(db)).not.toThrow();
    expect((db.prepare(`PRAGMA table_info(tk_shop)`).all() as { name: string }[]).filter((c) => c.name === 'access_token_enc')).toHaveLength(1);
  });

  it('加密存储 + 组凭证时解回明文；未授权店铺直接报错，绝不吃环境变量', () => {
    run('UPDATE tk_shop SET app_key_enc = ?, app_secret_enc = ?, access_token_enc = ? WHERE id = 1',
      encryptSecret('AK-shop1'), encryptSecret(SECRET), encryptSecret('AT-shop1'));
    const c1 = buildShopCredential(1);
    expect(c1).toMatchObject({ shopId: 1, appKey: 'AK-shop1', appSecret: SECRET, accessToken: 'AT-shop1', currency: 'MYR' });
    expect(decryptSecret(String(get<{ app_secret_enc: string }>(`SELECT app_secret_enc FROM tk_shop WHERE id = 1`)?.app_secret_enc))).toBe(SECRET);

    const realMode = config.tiktokMode;
    config.tiktokMode = 'real';
    process.env.TIKTOK_SHOP_ACCESS_TOKEN = 'AT-shared-should-be-ignored';
    try {
      const err = (() => { try { buildShopCredential(2); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(40020);
      expect((err as AppError).message).not.toContain('AT-shared-should-be-ignored');
      // mock 模式不校验凭证，否则离线演示的同步链路会整条挂掉
      config.tiktokMode = 'mock';
      expect(buildShopCredential(2).accessToken).toBe('');
    } finally {
      config.tiktokMode = realMode;
      delete process.env.TIKTOK_SHOP_ACCESS_TOKEN;
    }

    expect(() => buildShopCredential(9999)).toThrow(/不存在/);
  });
});

/* ==================== real 客户端对平台报文 ==================== */

interface Captured { url: string; method: string; headers: IncomingHttpHeaders; body: string }

let server: ReturnType<typeof createServer>;
let baseUrl = '';
let seen: Captured[] = [];
let responder: (n: number) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { code: 0, message: 'success', data: { orders: [] } } });

const cred = (over: Partial<ShopCredential> = {}): ShopCredential => ({
  shopId: 1,
  shopName: 'HYGGE PH Official',
  tkShopId: '741890137',
  shopCipher: 'CIPH/us+v1',
  appKey: 'AK',
  appSecret: SECRET,
  accessToken: 'AT-shop1',
  currency: 'USD',
  region: 'US',
  timezone: 'America/Los_Angeles',
  ...over,
});

const WINDOW = { from: '2026-09-01 00:00:00', to: '2026-09-02 00:00:00' };

const signOf = (url: string, body: string): { path: string; sign: string; params: Record<string, string> } => {
  const u = new URL(url, 'http://x');
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  const sign = params.sign ?? '';
  delete params.sign;
  return { path: u.pathname, sign, params };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: raw });
      const r = responder(seen.length);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  resetClient();
});

const reset = () => { seen = []; responder = () => ({ status: 200, body: { code: 0, message: 'success', data: { orders: [] } } }); };

describe('RealTikTokShopClient 报文契约', () => {
  it('订单查询是 POST：app_key/timestamp/sign/shop_cipher 走查询串，token 走 x-tts-access-token，区间用 create_time_lt', async () => {
    reset();
    responder = () => ({ status: 200, body: { code: 0, data: { orders: [{ id: 'o1', order_status: 'COMPLETED' }], next_page_token: '', has_more: false } } });
    const client = new RealTikTokShopClient(baseUrl);
    const orders = await client.getOrders(cred(), WINDOW);
    expect(orders).toHaveLength(1);

    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe('POST');
    const { path, sign, params } = signOf(req.url, req.body);
    expect(path).toBe(PATH);
    expect(params.app_key).toBe('AK');
    expect(/^\d{10}$/.test(params.timestamp)).toBe(true);
    expect(params.shop_cipher).toBe('CIPH/us+v1');
    // 平台侧复算：签名必须与「实际发出的字节」一致，含 URL 编解码往返
    expect(sign).toBe(buildSign(SECRET, path, params, req.body));
    expect(req.headers['x-tts-access-token']).toBe('AT-shop1');
    expect(String(req.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(req.body)).toEqual({ create_time_ge: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000), create_time_lt: Math.floor(Date.parse('2026-09-02T00:00:00Z') / 1000) });
    // 官方契约没有 nonce，也不该再用 x-tt-* 私有头
    expect(params.nonce).toBeUndefined();
    expect(Object.keys(req.headers).some((h) => h.startsWith('x-tt-'))).toBe(false);
  });

  it('凭证不全时根本不发请求，异常文案不含密钥', async () => {
    reset();
    const client = new RealTikTokShopClient(baseUrl);
    for (const bad of [{ appKey: '' }, { appSecret: '' }, { accessToken: '' }]) {
      await expect(client.getOrders(cred(bad), WINDOW)).rejects.toThrow(/缺少接口凭证|未授权 access token/);
    }
    expect(seen).toHaveLength(0);
    const err = await client.getOrders(cred({ accessToken: '' }), WINDOW).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    expect((err as AppError).code).toBe(40020);
    expect(JSON.stringify({ m: (err as Error).message })).not.toContain(SECRET);
  });

  it('平台 code 105002 → 令牌过期话术，且不外泄 token', async () => {
    reset();
    responder = () => ({ status: 200, body: { code: 105002, message: 'access token expired: AT-shop1', request_id: 'rq-1' } });
    const err = await new RealTikTokShopClient(baseUrl).getOrders(cred(), WINDOW).catch((e) => e);
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe(50400);
    expect(err.message).toContain('授权令牌已过期');
    expect(err.message).not.toContain('AT-shop1');
    expect(err.message).not.toContain(SECRET);
    expect(seen).toHaveLength(1);
  });

  it('106001 判签名、101000 判 cipher 不匹配，各只请求一次', async () => {
    reset();
    const client = new RealTikTokShopClient(baseUrl);
    for (const [code, hint] of [[106001, '签名校验不通过'], [101000, 'shop_cipher 不匹配']] as const) {
      responder = () => ({ status: 200, body: { code, message: 'biz error' } });
      await expect(client.getOrders(cred(), WINDOW)).rejects.toThrow(hint);
    }
    expect(seen).toHaveLength(2);
  });

  it('429 按 Retry-After 重试后成功；重试每次重取 timestamp 与签名', async () => {
    reset();
    responder = (n) => (n === 1 ? { status: 429, body: { code: 36009002, message: 'too many requests' }, headers: { 'retry-after': '1' } } : { status: 200, body: { code: 0, data: { orders: [{ id: 'o2' }] } } });
    const orders = await new RealTikTokShopClient(baseUrl).getOrders(cred(), WINDOW);
    expect(orders).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const s1 = signOf(seen[0].url, seen[0].body).sign;
    const s2 = signOf(seen[1].url, seen[1].body).sign;
    expect(s1).not.toBe(s2);
  });

  it('重试超过上限后抛出最后一次错误（5xx 也算可重试）', async () => {
    reset();
    responder = () => ({ status: 503, body: { code: 36009004, message: 'server overload' } });
    await expect(new RealTikTokShopClient(baseUrl).getOrders(cred(), WINDOW)).rejects.toThrow(/平台繁忙|HTTP 503/);
    expect(seen).toHaveLength(3);
  });

  it('返回非 JSON（网关 HTML）时报文不含凭证', async () => {
    reset();
    responder = () => ({ status: 400, body: '<!doctype html><title>502 Bad Gateway</title>' });
    const err = await new RealTikTokShopClient(baseUrl).getOrders(cred(), WINDOW).catch((e) => e);
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.message).toContain('返回非 JSON 报文');
    expect(err.message).not.toContain(SECRET);
  });

  it('商品游标翻页取到 next_page_token 为空才停', async () => {
    reset();
    responder = (n) => ({ status: 200, body: { code: 0, data: { products: [{ id: `p${n}` }], next_page_token: n < 3 ? `c${n}` : '' } } });
    const client = new RealTikTokShopClient(baseUrl);
    let cursor: string | null = null;
    const collected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const page = await client.getProducts(cred(), cursor);
      collected.push(...page.products.map((p) => String(p.id)));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual(['p1', 'p2', 'p3']);
    expect(seen).toHaveLength(3);
  });
});

/* ==================== 客户端工厂 ==================== */

describe('客户端工厂按模式构造', () => {
  it('默认 mock；real 模式才用真实客户端；resetClient 后重新构造', () => {
    resetClient();
    expect(createTiktokClient('mock')).toBeInstanceOf(MockTikTokShopClient);
    expect(createTiktokClient('mock')).toBe(createTiktokClient('mock'));
    expect(createTiktokClient('real')).toBeInstanceOf(RealTikTokShopClient);
    expect(createTiktokClient('real').mode).toBe('real');
    resetClient();
    expect(createTiktokClient('mock').mode).toBe('mock');
  });

  it('mock 客户端可离线跑通四类拉取，供同步链路回归', async () => {
    const mock = new MockTikTokShopClient();
    const c = cred({ shopCipher: null });
    const [orders, products, returns, aff] = await Promise.all([
      mock.getOrders(c, WINDOW), mock.getProducts(c), mock.getReturns(c, WINDOW), mock.getAffiliateOrders(c, WINDOW),
    ]);
    expect(orders.length).toBeGreaterThan(0);
    expect(products.products.length).toBeGreaterThan(0);
    expect(Array.isArray(returns)).toBe(true);
    expect(Array.isArray(aff)).toBe(true);
  });
});
