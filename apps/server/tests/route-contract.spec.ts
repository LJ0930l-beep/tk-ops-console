/**
 * 路由契约冒烟（scripts/smoke.mts 的门禁版）
 *
 * 存在的理由：前后端路径对不上、或某条列表 SQL 写错，在单接口测试里是抓不到的 ——
 * 每个 spec 只打自己关心的那几条路由，页面整片 500/404 也能全绿。
 * 这里把路由清单（scripts/route-inventory.mjs 扫源码得到）整体打一遍，
 * 断言「无 404（路由没挂）、无 500（SQL/口径炸了）」，403 属于正常的越权拦截。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
// @ts-expect-error 纯 JS 脚本，无类型声明
import { collectRoutes } from '../../../scripts/route-inventory.mjs';
import { boot, login, auth, dataOf, pageOf, ACCOUNTS, type TestContext } from './helper.js';

/** 仓库根：vitest 的 cwd 是 apps/server，扫源码要按本文件位置回推，别依赖 cwd */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

let ctx: TestContext;
let token = '';

const routes = (collectRoutes(ROOT) as { method: string; path: string; dynamic: boolean }[]).filter(
  (r) => r.method === 'GET' && !r.dynamic && !r.path.includes('${'),
);

/** 演示库订单窗口：区间参数要对准它，否则报表全是 0 行，绿得没有意义 */
function window_(): { from: string; to: string } {
  const row = ctx.db
    .prepare(`SELECT MIN(date(order_time)) AS lo, MAX(date(order_time)) AS hi FROM tk_order WHERE is_deleted = 0`)
    .get() as { lo: string; hi: string };
  return { from: row.lo, to: row.hi };
}

beforeAll(async () => {
  ctx = boot();
  token = await login(ctx.http, ACCOUNTS.boss);
});

describe('数据字典列表（曾因 queryPage 缺表别名整页 500）', () => {
  it('boss 能取到字典分页，且非 system 角色被拦', async () => {
    const res = await ctx.http.get('/api/system/dict?page=1&pageSize=5').set(auth(token));
    expect(res.status).toBe(200);
    const page = pageOf(res.body);
    expect(page.total).toBeGreaterThan(0);
    expect(page.list[0]).toHaveProperty('dict_type');
    expect((await ctx.http.get('/api/system/dict').set(auth(await login(ctx.http, ACCOUNTS.bd)))).status).toBe(403);
  });
});

describe('全部静态 GET 路由', () => {
  it('清单本身没被写坏（≥90 条，全部以 /api 开头）', () => {
    expect(routes.length).toBeGreaterThanOrEqual(90);
    expect(routes.every((r) => r.path.startsWith('/api/'))).toBe(true);
  });

  it('以 boss 打一遍：无 404（路由漏挂）、无 500（SQL 炸）', async () => {
    const { from, to } = window_();
    const q = `page=1&pageSize=5&from=${from}&to=${to}&table=creator&dim=creator`;
    const bad: string[] = [];
    for (const r of routes) {
      if (r.path === '/api/auth/login') continue;
      const res = await ctx.http.get(`${r.path}${r.path.includes('?') ? '&' : '?'}${q}`).set(auth(token));
      if (res.status === 404 || res.status >= 500) bad.push(`${r.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
    }
    expect(bad).toEqual([]);
  });

  it('受限角色（BD/仓库）打一遍：只允许 403 或范围内 404，不允许 500', async () => {
    const { from, to } = window_();
    const q = `page=1&pageSize=5&from=${from}&to=${to}`;
    const bad: string[] = [];
    for (const role of [ACCOUNTS.bd, ACCOUNTS.warehouse]) {
      const t = await login(ctx.http, role);
      for (const r of routes) {
        const res = await ctx.http.get(`${r.path}${r.path.includes('?') ? '&' : '?'}${q}`).set(auth(t));
        if (res.status >= 500) bad.push(`${role} ${r.path} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('看板与利润的切日口径', () => {
  it('趋势按店铺时区归日，且全部落在请求区间内', async () => {
    const { from, to } = window_();
    const data = dataOf<{ gmv_trend: { date: string }[] }>(
      (await ctx.http.get(`/api/dashboard/trend?from=${from}&to=${to}`).set(auth(token))).body,
    );
    expect(data.gmv_trend.length).toBeGreaterThan(0);
    expect(data.gmv_trend.every((x) => x.date >= from && x.date <= to)).toBe(true);
  });

  it('利润日报 sum_check 为 0（分项相加等于合计），且不缺汇率', async () => {
    const { from, to } = window_();
    const data = dataOf<{ sum_check: number; rate_missing: boolean; list: unknown[] }>(
      (await ctx.http.get(`/api/finance/profit/report?from=${from}&to=${to}`).set(auth(token))).body,
    );
    expect(data.list.length).toBeGreaterThan(0);
    expect(data.sum_check).toBe(0);
    expect(data.rate_missing).toBe(false);
  });
});
