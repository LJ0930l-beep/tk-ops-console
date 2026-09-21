/**
 * 接口限流回归（建议 1：全站此前零限流）
 *
 * vitest 下 NODE_ENV=test，config.rateLimit.enabled 默认关闭（整套回归会从 127.0.0.1 打上千次请求），
 * 所以这里显式把阈值调到很小，证明三档限流各自真的会触发，并且：
 *  - 只数登录失败，成功登录不占额度；
 *  - 429 走项目统一的 { code, message, data } 信封，前端 errMsg() 能直接显示；
 *  - 阈值由 config/环境变量驱动，不写死在中间件里。
 *
 * 注意：setDb 是模块级单例，一个进程里同时只有一个「当前库」，
 * 所以每个用例都自己 boot 一份、用完即弃，绝不跨用例复用 app（否则前一个 app 会读到后一个的库）。
 */
import { describe, it, expect } from 'vitest';
import { boot, auth, login, ACCOUNTS, DEFAULT_PASSWORD } from './helper.js';
import { config } from '../src/config.js';
import type { RateLimitConfig } from '../src/config.js';

const TIGHT: RateLimitConfig = {
  enabled: true,
  windowMinutes: 15,
  max: 5,
  loginWindowMinutes: 15,
  loginMax: 3,
  exportWindowMinutes: 15,
  exportMax: 1,
};

describe('限流开关与阈值来源', () => {
  it('测试环境默认关闭，阈值全部来自 config（可被环境变量覆盖）', () => {
    expect(config.rateLimit.enabled).toBe(false);
    expect(config.rateLimit.max).toBeGreaterThan(0);
    expect(config.rateLimit.loginMax).toBeGreaterThan(0);
    expect(config.rateLimit.exportMax).toBeGreaterThan(0);
  });

  it('关掉限流时连打 30 次全部 200', async () => {
    const app = boot(true, { rateLimit: false });
    const t = await login(app.http, ACCOUNTS.boss);
    for (let i = 0; i < 30; i++) {
      expect((await app.http.get('/api/dashboard/summary').set(auth(t))).status).toBe(200);
    }
  });
});

describe('登录档：防爆破', () => {
  it('连续失败超过阈值即 429，且回项目统一信封', async () => {
    const app = boot(true, { rateLimit: { ...TIGHT, loginMax: 2, max: 100 } });
    const bad = { username: 'boss', password: 'wrong-password' };
    expect((await app.http.post('/api/auth/login').send(bad)).status).not.toBe(429);
    expect((await app.http.post('/api/auth/login').send(bad)).status).not.toBe(429);
    const third = await app.http.post('/api/auth/login').send(bad);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe(42900);
    expect(String(third.body.message)).toContain('登录失败次数过多');
    expect(third.body.data).toBeNull();
  });

  it('成功登录不占额度（skipSuccessfulRequests），正常人不会被自己锁死', async () => {
    const app = boot(true, { rateLimit: { ...TIGHT, loginMax: 1, max: 100 } });
    for (let i = 0; i < 5; i++) {
      expect((await app.http.post('/api/auth/login').send({ username: ACCOUNTS.boss, password: DEFAULT_PASSWORD })).status).toBe(200);
    }
  });

  it('按 IP+用户名计数：锁住 boss 不影响别的账号登录', async () => {
    const app = boot(true, { rateLimit: { ...TIGHT, loginMax: 1, max: 100 } });
    await app.http.post('/api/auth/login').send({ username: 'boss', password: 'nope' });
    expect((await app.http.post('/api/auth/login').send({ username: 'boss', password: 'nope' })).status).toBe(429);
    expect((await app.http.post('/api/auth/login').send({ username: ACCOUNTS.finance, password: DEFAULT_PASSWORD })).status).toBe(200);
  });
});

describe('全局档与导出档', () => {
  it('全局超过 max 后 429，并带 RateLimit 标准响应头', async () => {
    const max = 4;
    const app = boot(true, { rateLimit: { ...TIGHT, max, loginMax: 100 } });
    const t = await login(app.http, ACCOUNTS.boss);
    // 登录本身已占 1 次全局额度，所以再打 max-1 次刚好用满
    for (let i = 0; i < max - 1; i++) {
      expect((await app.http.get('/api/auth/me').set(auth(t))).status).toBe(200);
    }
    const over = await app.http.get('/api/auth/me').set(auth(t));
    expect(over.status).toBe(429);
    expect(over.body.code).toBe(42900);
    expect(String(over.body.message)).toContain('过于频繁');
    expect(over.headers['ratelimit']).toBeDefined();
  });

  it('导出单独一档：第二次导出就 429，且不牵连普通列表', async () => {
    const app = boot(true, { rateLimit: { ...TIGHT, max: 100, loginMax: 100, exportMax: 1 } });
    const t = await login(app.http, ACCOUNTS.boss);
    expect((await app.http.get('/api/orders/export').set(auth(t))).status).toBe(200);
    const second = await app.http.get('/api/orders/export').set(auth(t));
    expect(second.status).toBe(429);
    expect(String(second.body.message)).toContain('导出');
    expect((await app.http.get('/api/orders?page=1&pageSize=5').set(auth(t))).status).toBe(200);
  });
});
