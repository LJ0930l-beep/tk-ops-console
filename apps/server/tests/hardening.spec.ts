import { describe, expect, it, vi } from 'vitest';
import { canAccessShop, decryptSecret, loadUser, shopScope } from '../src/core/auth.js';
import { all, get } from '../src/core/db.js';
import { AppError } from '../src/core/http.js';
import { errorHandler } from '../src/app.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';

/**
 * 安全加固回归（EPIC-1-03）：
 *  D1 默认凭证/升权封堵  D2 店铺凭证不出接口  D3 数据范围覆盖所有入口与写操作
 *  D4 范围参数不被误当店铺 ID  D5 受限角色列表接口不再 AND AND 500  D6 异常原文不外泄
 */

const { db, http } = boot();
const token: Record<string, string> = {};

/** 任何角色、任何店铺接口都不允许出现的列 */
const FORBIDDEN_KEYS = ['app_key_enc', 'app_secret_enc', 'access_token_enc', 'shop_cipher', 'password_hash'];

function keysOf(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) for (const n of node) keysOf(n, out);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node as Record<string, unknown>)) { out.add(k); keysOf(v, out); }
  return out;
}

const idOf = (username: string): number =>
  Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, username)?.id ?? 0);

/** 该账号在 /api/shops 列表里能看到的店铺 ID（与详情/写接口共用同一套范围口径） */
async function visibleShopIds(username: string): Promise<number[]> {
  const res = await http.get('/api/shops?page=1&pageSize=100').set(auth(token[username]));
  if (res.status !== 200) return [];
  return pageOf(res.body).list.map((r) => Number(r.id));
}

const allShopIds = (): number[] =>
  (db.prepare(`SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id`).all() as { id: number }[]).map((r) => Number(r.id));

describe('D2 店铺接口凭证不出网', () => {
  it('各角色店铺列表/详情/下拉的响应体都不含凭证列，只回显是否已配置', async () => {
    // finance 角色无 shop 菜单，越权入口由 D5 覆盖；这里只查有店铺权限的角色
    for (const u of [ACCOUNTS.boss, ACCOUNTS.ops, ACCOUNTS.opsManager]) {
      token[u] = token[u] || (await login(http, u));
      const list = await http.get('/api/shops?pageSize=50').set(auth(token[u]));
      expect(list.status).toBe(200);
      for (const k of keysOf(list.body)) expect(FORBIDDEN_KEYS).not.toContain(k);
      const options = await http.get('/api/shops/all').set(auth(token[u]));
      for (const k of keysOf(options.body)) expect(FORBIDDEN_KEYS).not.toContain(k);
    }
    const detail = await http.get('/api/shops/1').set(auth(token.boss));
    expect(detail.status).toBe(200);
    const row = dataOf<Record<string, unknown>>(detail.body);
    expect(FORBIDDEN_KEYS.some((k) => k in row)).toBe(false);
    expect('has_credential' in row).toBe(true);
  });

  it('重新授权只写入密文：接口、操作日志里都查不到明文与密文', async () => {
    const secret = { app_key: 'AK-tiktok-key-0001', app_secret: 'AS-tiktok-secret-0001', access_token: 'AT-tiktok-token-0001', shop_cipher: 'cipher-us-new-3' };
    const res = await http.post('/api/shops/3/auth').set(auth(token.boss)).send(secret);
    expect(res.status).toBe(200);

    const stored = get<Record<string, unknown>>(`SELECT * FROM tk_shop WHERE id = 3`);
    expect(String(stored.app_secret_enc)).not.toContain(secret.app_secret);
    expect(decryptSecret(String(stored.app_secret_enc))).toBe(secret.app_secret);
    expect(decryptSecret(String(stored.app_key_enc))).toBe(secret.app_key);
    expect(decryptSecret(String(stored.access_token_enc))).toBe(secret.access_token);

    const asText = JSON.stringify((await http.get('/api/shops?pageSize=50').set(auth(token.boss))).body)
      + JSON.stringify((await http.get('/api/shops/3').set(auth(token.boss))).body);
    for (const v of Object.values(secret)) expect(asText).not.toContain(v);

    const oplog = await http.get('/api/system/oplog?module=%E5%BA%97%E9%93%BA%E4%B8%8E%E8%B4%A6%E5%8F%B7&pageSize=20').set(auth(token.boss));
    const text = JSON.stringify(oplog.body);
    for (const v of Object.values(secret)) expect(text).not.toContain(v);
  });

  it('授权时留空 access_token 不清空原值（只更新提交字段）', async () => {
    const before = get<Record<string, unknown>>(`SELECT access_token_enc, shop_cipher FROM tk_shop WHERE id = 3`);
    const res = await http.post('/api/shops/3/auth').set(auth(token.boss)).send({ app_key: 'AK-2', app_secret: 'AS-2' });
    expect(res.status).toBe(200);
    const after = get<Record<string, unknown>>(`SELECT access_token_enc, shop_cipher FROM tk_shop WHERE id = 3`);
    expect(after.access_token_enc).toBe(before.access_token_enc);
    expect(after.shop_cipher).toBe(before.shop_cipher);
  });

  it('店铺更新接口不再接受 shop_cipher（防把明文密文写坏）', async () => {
    const res = await http.put('/api/shops/1').set(auth(token.boss)).send({ shop_cipher: 'hack', shop_name: 'ORICO MY Flagship' });
    expect(res.status).toBe(200);
    expect(String(get<{ shop_cipher: string }>(`SELECT shop_cipher FROM tk_shop WHERE id = 1`)?.shop_cipher)).not.toBe('hack');
  });
});

describe('D3+D4 店铺数据范围覆盖所有入口与写操作', () => {
  it('GET /shops/all 需要 shop 菜单：BD 拿不到全店列表', async () => {
    token[ACCOUNTS.bd] = token[ACCOUNTS.bd] || (await login(http, ACCOUNTS.bd));
    const res = await http.get('/api/shops/all').set(auth(token[ACCOUNTS.bd]));
    expect(res.status).toBe(403);
  });

  it('GET /shops/all 与 /shops/mine 同范围：受限角色不会看到全部 4 店', async () => {
    for (const u of [ACCOUNTS.ops, ACCOUNTS.opsManager]) {
      token[u] = token[u] || (await login(http, u));
      const all = await http.get('/api/shops/all').set(auth(token[u]));
      const mine = await http.get('/api/shops/mine').set(auth(token[u]));
      expect(all.status).toBe(200);
      const ids = (dataOf<Record<string, unknown>[]>(all.body)).map((r) => Number(r.id)).sort();
      expect(ids).toEqual((dataOf<Record<string, unknown>[]>(mine.body)).map((r) => Number(r.id)).sort());
      expect(ids.length).toBeLessThan(allShopIds().length);
    }
  });

  it('列表可见集合与详情/改/授权/删的越权判定完全一致（含用户 ID 与店铺 ID 撞号）', async () => {
    for (const u of [ACCOUNTS.ops, ACCOUNTS.opsManager, ACCOUNTS.bd, ACCOUNTS.content]) {
      token[u] = token[u] || (await login(http, u));
      const visible = new Set(await visibleShopIds(u));
      for (const id of allShopIds()) {
        const headers = auth(token[u]);
        const detail = await http.get(`/api/shops/${id}`).set(headers);
        expect([200, 403, 404]).toContain(detail.status);
        if (!visible.has(id)) {
          expect([403, 404]).toContain(detail.status);
          expect((await http.put(`/api/shops/${id}`).set(headers).send({ status: 2 })).status).toBe(403);
          expect((await http.post(`/api/shops/${id}/auth`).set(headers).send({ app_key: 'x', app_secret: 'y' })).status).toBe(403);
          expect((await http.delete(`/api/shops/${id}`).set(headers)).status).toBe(403);
        }
      }
    }
  });

  it('运营主管（DEPT 范围，用户 ID=4）改不动第 4 号店铺：曾把范围参数当成店铺 ID', async () => {
    expect(idOf(ACCOUNTS.opsManager)).toBe(4);
    expect(allShopIds()).toContain(4);
    const before = String(get<{ shop_name: string }>(`SELECT shop_name FROM tk_shop WHERE id = 4`)?.shop_name);
    const res = await http.put('/api/shops/4').set(auth(token[ACCOUNTS.opsManager])).send({ shop_name: 'HACKED BY wangqiang' });
    expect(res.status).toBe(403);
    expect(String(get<{ shop_name: string }>(`SELECT shop_name FROM tk_shop WHERE id = 4`)?.shop_name)).toBe(before);
  });

  it('四种数据范围生成的 SQL 都能真实执行，SELF 按负责人收敛', () => {
    for (const u of [ACCOUNTS.boss, ACCOUNTS.ops, ACCOUNTS.opsManager, ACCOUNTS.bd, ACCOUNTS.content]) {
      const user = loadUser(idOf(u));
      expect(user).toBeTruthy();
      const scope = shopScope(user!, 'id');
      // SELF 片段曾写成 `SELECT shop_id FROM tk_shop`，一执行就 500
      expect(() => all<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ${scope.sql}`, ...scope.params)).not.toThrow();
      expect(() => canAccessShop(user!, 1)).not.toThrow();
    }
  });

  it('SELF 范围用户只看到自己负责的店铺（负责人变更后立即可见）', async () => {
    const bdId = idOf(ACCOUNTS.bd);
    const bossId = idOf(ACCOUNTS.boss);
    db.prepare(`UPDATE tk_shop SET owner_id = ? WHERE id = 4`).run(bdId);
    try {
      const mine = dataOf<Record<string, unknown>[]>((await http.get('/api/shops/mine').set(auth(token[ACCOUNTS.bd]))).body);
      expect(mine.map((r) => Number(r.id))).toEqual([4]);
    } finally {
      db.prepare(`UPDATE tk_shop SET owner_id = ? WHERE id = 4`).run(bossId);
    }
  });
});

describe('D1 有 system 菜单不等于能发权限', () => {
  const opsMgr = () => auth(token[ACCOUNTS.opsManager]);
  const bossRoleId = () => Number(get<{ id: number }>(`SELECT id FROM sys_role WHERE role_key = 'boss'`)?.id);
  const opsMgrId = () => idOf(ACCOUNTS.opsManager);

  it('运营主管可进系统设置读数据，但角色新增/修改一律 403', async () => {
    expect((await http.get('/api/system/roles').set(opsMgr())).status).toBe(200);
    const create = await http.post('/api/system/roles').set(opsMgr()).send({
      role_name: '超级权限', role_key: 'super', menu_perms: ['dashboard', 'shop', 'finance', 'system'], data_scope: 1, can_see_cost: 1, can_export: 1,
    });
    expect(create.status).toBe(403);
    expect(get(`SELECT id FROM sys_role WHERE role_key = 'super'`)).toBeFalsy();
    expect((await http.put(`/api/system/roles/${bossRoleId()}`).set(opsMgr()).send({ can_see_cost: 0 })).status).toBe(403);
  });

  it('运营主管不能把自己或同事改成老板，也不能绑定店铺范围', async () => {
    const bossRole = bossRoleId();
    for (const target of [opsMgrId(), idOf(ACCOUNTS.ops)]) {
      const res = await http.put(`/api/system/users/${target}`).set(opsMgr()).send({ role_id: bossRole });
      expect(res.status).toBe(403);
      expect(Number(get<{ role_id: number }>(`SELECT role_id FROM sys_user WHERE id = ?`, target)?.role_id)).not.toBe(bossRole);
    }
    expect((await http.put(`/api/system/data-scope/${opsMgrId()}`).set(opsMgr()).send({ shop_ids: [1, 2, 3, 4] })).status).toBe(403);
    expect((await http.post('/api/system/users').set(opsMgr()).send({
      username: 'selfhelp', real_name: '自助提权', password: 'Passw0rd!', role_id: bossRole,
    })).status).toBe(403);
    expect((await http.post('/api/system/users').set(opsMgr()).send({
      username: 'selfhelp2', real_name: '越权绑店', password: 'Passw0rd!', role_id: Number(get<{ id: number }>(`SELECT id FROM sys_role WHERE role_key = 'ops'`)?.id), shop_ids: [1, 2, 3, 4],
    })).status).toBe(403);
  });

  it('运营主管不能停用老板或改老板密码', async () => {
    const boss = idOf(ACCOUNTS.boss);
    expect((await http.post(`/api/system/users/${boss}/deactivate`).set(opsMgr())).status).toBe(403);
    expect((await http.put(`/api/system/users/${boss}`).set(opsMgr()).send({ password: 'Passw0rd!' })).status).toBe(403);
    expect((await http.put(`/api/system/users/${boss}`).set(opsMgr()).send({ status: 0 })).status).toBe(403);
    expect(Number(get<{ status: number }>(`SELECT status FROM sys_user WHERE id = ?`, boss)?.status)).toBe(1);
  });

  it('普通业务字段仍由 system 菜单放行；老板保留完整的授权能力', async () => {
    expect((await http.put(`/api/system/users/${idOf(ACCOUNTS.ops)}`).set(opsMgr()).send({ real_name: '林雅' })).status).toBe(200);
    const bossAuth = auth(token[ACCOUNTS.boss]);
    const roleId = await http.post('/api/system/roles').set(bossAuth).send({ role_name: '只读审计', role_key: 'auditor', menu_perms: ['dashboard'], data_scope: 3 });
    expect(roleId.status).toBe(200);
    expect((await http.put(`/api/system/data-scope/${idOf(ACCOUNTS.ops)}`).set(bossAuth).send({ shop_ids: [1, 2] })).status).toBe(200);
  });
});

describe('D5 受限角色的列表接口不再因 SQL 拼接返回 5xx', () => {
  const LIMITED = [ACCOUNTS.ops, ACCOUNTS.opsManager, ACCOUNTS.bd, ACCOUNTS.content, ACCOUNTS.ads, ACCOUNTS.warehouse];
  const PATHS = ['/api/shops', '/api/shops/mine', '/api/shops/all', '/api/ads/daily', '/api/content/videos', '/api/finance/settlement', '/api/orders', '/api/creators'];

  it.each(LIMITED)('%s 逐个列表接口只返回 2xx/4xx', async (u) => {
    token[u] = token[u] || (await login(http, u));
    for (const p of PATHS) {
      const res = await http.get(`${p}?page=1&pageSize=5`).set(auth(token[u]));
      if (res.status >= 500) throw new Error(`${u} ${p} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('受限角色打到详情 / 子资源 / 同步健康度接口也不 500', async () => {
    // 这些位置曾把 scope 片段裸拼在 `= 0` 后面，拼出 `0AND` 直接 SQL 语法错误
    const one = (sql: string): number => Number(get<{ id: number }>(sql)?.id ?? 0);
    const orderId = one(`SELECT id FROM tk_order WHERE is_deleted = 0 ORDER BY id LIMIT 1`);
    const returnId = one(`SELECT id FROM tk_return WHERE is_deleted = 0 ORDER BY id LIMIT 1`);
    const videoId = one(`SELECT id FROM video WHERE is_deleted = 0 ORDER BY id LIMIT 1`);
    const liveId = one(`SELECT id FROM live_session WHERE is_deleted = 0 ORDER BY id LIMIT 1`);
    const DETAILS = [
      `/api/orders/${orderId}`,
      `/api/orders/${orderId}/profit`,
      `/api/orders/returns/${returnId}`,
      `/api/content/videos/${videoId}`,
      `/api/content/videos/${videoId}/attribution`,
      `/api/content/lives/${liveId}`,
      '/api/sync/health',
      '/api/sync/logs?page=1&pageSize=5',
      '/api/sync/tasks',
    ];
    for (const u of LIMITED) {
      token[u] = token[u] || (await login(http, u));
      for (const p of DETAILS) {
        const res = await http.get(p).set(auth(token[u]));
        if (res.status >= 500) throw new Error(`${u} ${p} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        expect(res.status).toBeLessThan(500);
      }
    }
  });

  it('受限角色的列表结果确实被范围收敛（不是放开成全部）', async () => {
    const shopIdsOf = async (u: string): Promise<Set<number>> => {
      const rows = pageOf((await http.get('/api/ads/daily?pageSize=200').set(auth(token[u]))).body).list as Record<string, unknown>[];
      return new Set(rows.map((r) => Number(r.shop_id)).filter((n) => Number.isFinite(n) && n > 0));
    };
    const mine = await shopIdsOf(ACCOUNTS.ads);
    const all = await shopIdsOf(ACCOUNTS.boss);
    expect(mine.size).toBeGreaterThan(0);
    expect(mine.size).toBeLessThan(all.size);
    for (const id of mine) expect(all.has(id)).toBe(true);
  });
});

describe('D6 异常原文只进服务端日志', () => {
  const mockRes = () => {
    const res: { statusCode?: number; body?: unknown } = {};
    return {
      res,
      status(code: number) { res.statusCode = code; return this; },
      json(body: unknown) { res.body = body; return this; },
    };
  };

  it('非 AppError 统一 500 通用文案，不含 SQL 片段与列名', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = mockRes();
    errorHandler(
      new Error('SqliteError: no such column: s.access_token_xxx -- at SELECT s.shop_name, s.access_token_xxx FROM tk_shop s WHERE s.is_deleted = 0 AND AND 1=0'),
      {} as never, r as never, (() => undefined) as never,
    );
    expect(r.res.statusCode).toBe(500);
    expect((r.res.body as { code: number; message: string }).code).toBe(50000);
    expect(JSON.stringify(r.res.body)).not.toMatch(/SqliteError|access_token|tk_shop|SELECT/i);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('唯一约束冲突返回 409，AppError 原样透传状态码与文案', () => {
    const dup = mockRes();
    errorHandler(new Error('UNIQUE constraint failed: tk_shop.tk_shop_id'), {} as never, dup as never, (() => undefined) as never);
    expect(dup.res.statusCode).toBe(409);
    expect((dup.res.body as { code: number }).code).toBe(40900);

    const biz = mockRes();
    errorHandler(new AppError(403, '该店铺不在你的数据范围内', 40300), {} as never, biz as never, (() => undefined) as never);
    expect(biz.res.statusCode).toBe(403);
    expect((biz.res.body as { message: string }).message).toBe('该店铺不在你的数据范围内');
  });

  it('未注册接口返回 404 JSON 而非 HTML/异常', async () => {
    const res = await http.get('/api/not-exist').set(auth(token[ACCOUNTS.boss]));
    expect(res.status).toBe(404);
    expect((res.body as { code: number }).code).toBe(40400);
  });
});
