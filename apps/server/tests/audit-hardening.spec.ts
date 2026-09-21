/**
 * 全项目审验轮（第三轮）补强回归
 *
 * 覆盖本轮证明的缺陷：
 *  1. /api/system/synclog 与 /health 原本只要登录就能读全量同步日志（含上游报错原文）；
 *  2. 工作台待办明细把 sync_log.error_msg 原样带进响应，绕过了既有的 maskError 口径；
 *  3. 达人 ROI 页三个维度全 404（前端调 /creators/roi，后端只有 /roi/rank），
 *     且 PRD §3.4 要求的「按合作单」维度后端根本没有；
 *  4. 库存页借用 /products/*，仓库角色没有 product 菜单，下拉永远空 → 改为 /stock/skus|/spus。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { boot, login, auth, dataOf, pageOf, ACCOUNTS, type TestContext } from './helper.js';

const SECRET = 'access_token=7F3C9E2B41A58D6C0E9F2B7A1D4C8E5F3A9B7C5D1E4F8A2B';

let ctx: TestContext;
const tok: Record<string, string> = {};

beforeAll(async () => {
  ctx = boot();
  for (const u of ['boss', 'bd', 'warehouse', 'opsManager'] as const) tok[u] ??= await login(ctx.http, ACCOUNTS[u]);
});

const putSyncError = () => {
  ctx.db
    .prepare(`INSERT INTO sync_log (shop_id, task_type, status, error_msg, started_at) VALUES (?, 'order', 3, ?, datetime('now'))`)
    .run(1, `上游返回失败：${SECRET} app_key=abc12345`);
};

describe('同步日志：菜单与数据范围', () => {
  it('列表只有 system 菜单可读', async () => {
    expect((await ctx.http.get('/api/system/synclog').set(auth(tok.boss))).status).toBe(200);
    expect((await ctx.http.get('/api/system/synclog').set(auth(tok.bd))).status).toBe(403);
  });

  it('健康度对全角色可见，但错误文案必须脱敏', async () => {
    putSyncError();
    const res = await ctx.http.get('/api/system/synclog/health').set(auth(tok.boss));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('7F3C9E2B41A58D6C0E9F2B7A1D4C8E5F3A9B7C5D1E4F8A2B');
    expect(body).not.toContain('abc12345');
    expect(body).toContain('access_token=***');
  });

  it('健康度按数据范围收敛：别人店铺的同步明细不给看', async () => {
    const boss = dataOf<{ shop_id: number }[]>((await ctx.http.get('/api/system/synclog/health').set(auth(tok.boss))).body);
    const bd = dataOf<{ shop_id: number }[]>((await ctx.http.get('/api/system/synclog/health').set(auth(tok.bd))).body);
    expect(boss.length).toBeGreaterThan(0);
    expect(bd).toEqual([]);
  });

  it('待办明细里的同步失败提示同样要脱敏', async () => {
    putSyncError();
    const res = await ctx.http.get('/api/dashboard/todos/detail').set(auth(tok.boss));
    const groups = dataOf<{ groups: { key: string; items: { hint: string }[] }[] }>(res.body).groups;
    const hints = (groups.find((g) => g.key === 'sync_failed')?.items ?? []).map((i) => i.hint).join('|');
    expect(hints).toContain('access_token=***');
    expect(hints).not.toContain('7F3C9E2B41A58D6C0E9F2B7A1D4C8E5F3A9B7C5D1E4F8A2B');
  });
});

describe('达人 ROI 排行：三档维度都要真出数', () => {
  const rank = async (query: string, user = 'boss') => {
    const res = await ctx.http.get(`/api/creators/roi/rank${query}`).set(auth(tok[user]));
    expect(res.status).toBe(200);
    return dataOf<{ dimension: string; list: Record<string, unknown>[] }>(res.body);
  };

  it('按达人 / 按 BD（含旧的 group=true 写法）', async () => {
    expect((await rank('?period=all&limit=5')).dimension).toBe('creator');
    expect((await rank('?period=all&dim=bd')).dimension).toBe('bd');
    expect((await rank('?period=all&group=true')).dimension).toBe('bd');
  });

  it('按合作单：出合作单号与合作方式/状态，成本列按权限掩码', async () => {
    const d = await rank('?period=all&dim=collab&limit=5');
    expect(d.dimension).toBe('collab');
    expect(d.list.length).toBeGreaterThan(0);
    const row = d.list[0];
    for (const key of ['collab_no', 'handle', 'coop_type', 'status', 'net_gmv_cny', 'cost', 'roi']) {
      expect(row).toHaveProperty(key);
    }
    const noCost = await rank('?period=all&dim=collab&limit=5', 'bd');
    expect(noCost.list[0]?.net_gmv_cny).toBe('***');
  });

  it('前端页面用的路径与后端一致（/creators/roi 这个 404 黑洞不能再回来）', async () => {
    expect((await ctx.http.get('/api/creators/roi?dim=creator').set(auth(tok.boss))).status).toBe(404);
  });
});

describe('库存选择器：不蹭 product 菜单也能选到商品', () => {
  it('仓库角色可搜 SKU 与 SPU', async () => {
    const skus = pageOf(await (await ctx.http.get('/api/stock/skus?page=1&pageSize=10').set(auth(tok.warehouse))).body);
    expect(skus.total).toBeGreaterThan(0);
    expect(Object.keys(skus.list[0]).sort()).toEqual(['id', 'name_cn', 'sku_code', 'spec', 'spu_code', 'spu_id', 'status']);
    const spus = pageOf((await ctx.http.get('/api/stock/spus?page=1&pageSize=10').set(auth(tok.warehouse))).body);
    expect(spus.total).toBeGreaterThan(0);
    expect(spus.list[0]).toHaveProperty('spu_code');
  });

  it('只出编码与规格，不带任何成本字段', async () => {
    const raw = JSON.stringify((await ctx.http.get('/api/stock/skus?page=1&pageSize=5').set(auth(tok.warehouse))).body);
    expect(raw).not.toMatch(/purchase_cost|first_leg_cost/);
  });

  it('同一个仓库角色走 /products/sku 仍然是 403（这正是旧写法下拉永远空的原因）', async () => {
    expect((await ctx.http.get('/api/products/sku').set(auth(tok.warehouse))).status).toBe(403);
  });
});
