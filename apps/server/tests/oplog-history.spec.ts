/**
 * 单条记录的字段级变更历史 GET /api/system/oplog/history（dev-options 选项 9）
 *
 * 没有这份 spec 会悄悄烂掉的两件事：
 *  1. 「diff 出真正改动的字段」是审计日志唯一能被运营读懂的形态。哪天有人把 before/after
 *     原文直接吐回前端（或改成只回 id 列表），页面看起来仍然是「有历史」，
 *     但要等用户在界面上看不出「这条记录为什么变成现在这样」才会暴露；
 *  2. 出口脱敏规则（凭证列只报「改过」不报值、updated_at 这类噪声列不列、
 *     自由文本里内联的 token 要过 redact）正是最容易被后续重构丢掉的那一类：
 *     删掉它的改动在功能测试里全绿，只有这里逐条钉住才会红。
 *     写入侧本来也靠各路由自觉剔除凭证列（shop.routes 的 stripCredentials），
 *     所以本 spec 特意塞了一条「写入侧忘了剔」的日志，验读取侧的兜底。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { boot, login, auth, dataOf, ACCOUNTS, type TestContext } from './helper.js';

interface FieldChange {
  field: string;
  from: string;
  to: string;
}
interface HistoryEntry {
  id: number;
  action: string;
  module: string;
  user_name: string | null;
  created_at: string;
  ip: string | null;
  changes: FieldChange[];
}

const NEW_NAME = '历史回归改名后的店';
/** 故意短于 32 位：这样「不泄漏」只能归功于列名/内联规则，而不是 redact 里的长度兜底 */
const SECRET = 'app-secret-3f9a1c';
const INLINE_TOKEN = 'abcd1234efgh5678ijkl';

let ctx: TestContext;
const tok: Record<string, string> = {};

const history = async (query: string, user = 'boss') => {
  const res = await ctx.http.get(`/api/system/oplog/history${query}`).set(auth(tok[user]));
  return { status: res.status, body: JSON.stringify(res.body), data: dataOf<HistoryEntry[]>(res.body) };
};

/** 直接写一条日志：模拟「新增的写接口忘了剔除凭证列」 */
const insertRawLog = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  ctx.db
    .prepare(
      `INSERT INTO sys_op_log (user_id, module, action, target_table, target_id, before_after, ip)
       VALUES (1, '店铺与账号', 'update', 'tk_shop', 1, ?, '10.0.0.9')`,
    )
    .run(JSON.stringify({ before, after }));
};

beforeAll(async () => {
  ctx = boot();
  for (const u of ['boss', 'ops', 'bd', 'opsManager'] as const) tok[u] ??= await login(ctx.http, ACCOUNTS[u]);
});

describe('变更历史：diff 出真正改动的字段', () => {
  it('走真实写接口改店铺名，历史里能看到「谁把哪个字段从什么改成什么」', async () => {
    const before = dataOf<{ shop_name: string }>((await ctx.http.get('/api/shops/1').set(auth(tok.boss))).body);
    expect((await ctx.http.put('/api/shops/1').set(auth(tok.boss)).send({ shop_name: NEW_NAME })).status).toBe(200);

    const { status, data } = await history('?table=tk_shop&id=1');
    expect(status).toBe(200);
    const entry = data[0];
    expect(entry.action).toBe('update');
    expect(entry.module).toBe('店铺与账号');
    expect(entry.user_name).toBe('陈新');
    expect(entry.created_at).toBeTruthy();
    expect(entry.changes).toContainEqual({ field: 'shop_name', from: before.shop_name, to: NEW_NAME });
    // before/after 原文不出接口：回的是 diff，不是那坨 JSON
    expect(entry).not.toHaveProperty('before_after');
    expect(JSON.stringify(entry.changes)).not.toContain('app_secret');
  });

  it('按时间倒序：最新一条在最前（回答「最后一次是谁改的」）', async () => {
    expect((await ctx.http.put('/api/shops/1').set(auth(tok.boss)).send({ region: 'TH' })).status).toBe(200);
    const { data } = await history('?table=tk_shop&id=1');
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.map((e) => Number(e.id))).toEqual([...data.map((e) => Number(e.id))].sort((a, b) => b - a));
  });

  it('别的记录的历史不会混进来（按 target_table + target_id 收口）', async () => {
    const { data } = await history('?table=tk_shop&id=1');
    expect(data.length).toBeGreaterThan(0);
    expect((await history('?table=tk_shop&id=999999')).data).toEqual([]);
    const other = await history('?table=tk_shop&id=2');
    expect(other.data.every((e) => !e.changes.some((c) => c.to === NEW_NAME))).toBe(true);
  });

  it('空编辑（值没变）保留条目但 changes 为空 —— 读接口不二次过滤', async () => {
    // 选「保留」而不是「过滤」：tk_shop 的 PUT 是无条件 writeOpLog，滤掉空变更条目会让人误判
    // 「这条记录没人动过」，而审计端点少一行比多一行更危险。噪音交给 changes 为空去表达。
    const { data: before } = await history('?table=tk_shop&id=1');
    expect((await ctx.http.put('/api/shops/1').set(auth(tok.boss)).send({ shop_name: NEW_NAME })).status).toBe(200);
    const { data } = await history('?table=tk_shop&id=1');
    expect(data.length).toBe(before.length + 1);
    expect(data[0].changes).toEqual([]);
    expect(data[0].action).toBe('update');
  });
});

describe('变更历史：出口脱敏（红线）', () => {
  it('重新授权接口本身不把密钥写进历史，明文不出现在响应体任何位置', async () => {
    expect(
      (
        await ctx.http
          .post('/api/shops/1/auth')
          .set(auth(tok.boss))
          .send({ app_key: 'AK-live-9f3c', app_secret: SECRET, access_token: `${SECRET}-at`, shop_cipher: 'CIPHER-77' })
      ).status,
    ).toBe(200);
    const { body } = await history('?table=tk_shop&id=1');
    for (const secret of [SECRET, 'AK-live-9f3c', 'CIPHER-77']) expect(body).not.toContain(secret);
  });

  it('写入侧漏剔凭证列时，读取侧兜底：字段照报，值一律 (已屏蔽)', async () => {
    insertRawLog(
      { app_secret_enc: `${SECRET}-old`, shop_cipher: 'CIPHER-77-old', status: 1, updated_at: '2026-01-01 00:00:00' },
      { app_secret_enc: `${SECRET}-new`, shop_cipher: 'CIPHER-77-new', status: 2, updated_at: '2026-09-09 10:10:10' },
    );
    const { body, data } = await history('?table=tk_shop&id=1');
    for (const secret of [`${SECRET}-old`, `${SECRET}-new`, 'CIPHER-77-old', 'CIPHER-77-new']) expect(body).not.toContain(secret);
    const changes = data[0].changes;
    expect(changes).toContainEqual({ field: 'app_secret_enc', from: '(已屏蔽)', to: '(已屏蔽)' });
    expect(changes).toContainEqual({ field: 'shop_cipher', from: '(已屏蔽)', to: '(已屏蔽)' });
    // 有意义的字段照常可见，屏蔽不能顺手把整条日志抹掉
    expect(changes).toContainEqual({ field: 'status', from: '1', to: '2' });
    // updated_at 每次写都变，列出来只会淹没真正的变更
    expect(changes.some((c) => c.field === 'updated_at')).toBe(false);
  });

  it('自由文本里内联的 token 走 redact 口径', async () => {
    insertRawLog(
      { remark: '无' },
      { remark: `授权备注 access_token=${INLINE_TOKEN} 请妥善保管` },
    );
    const { body } = await history('?table=tk_shop&id=1');
    expect(body).not.toContain(INLINE_TOKEN);
    expect(body).toContain('access_token=***');
  });
});

describe('变更历史：权限与参数', () => {
  /** 与 GET /api/system/oplog 列表同一条：整段 opLogRouter 吃 system 菜单 */
  it('没有 system 菜单就是 403，哪怕自己是这条记录的可见范围内的负责人', async () => {
    for (const user of ['bd', 'ops'] as const) expect((await history('?table=tk_shop&id=1', user)).status).toBe(403);
    expect((await ctx.http.get('/api/system/oplog/history?table=tk_shop&id=1')).status).toBe(401);
  });

  it('持 system 菜单的非老板角色可读（与列表接口一致，不按记录数据范围额外收敛）', async () => {
    expect((await history('?table=tk_shop&id=1', 'opsManager')).status).toBe(200);
    expect((await ctx.http.get('/api/system/oplog').set(auth(tok.opsManager))).status).toBe(200);
  });

  it('table / id 缺失或非法直接 400，不放到 SQL 里猜', async () => {
    for (const q of ['', '?table=tk_shop', '?id=1', '?table=tk_shop&id=0', '?table=tk_shop&id=abc', '?table=tk_shop;drop&id=1']) {
      expect((await history(q)).status).toBe(400);
    }
    expect((await history('?table=tk_shop&id=1&limit=1')).data).toHaveLength(1);
  });
});
