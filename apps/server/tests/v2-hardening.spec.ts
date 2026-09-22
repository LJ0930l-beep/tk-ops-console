/**
 * V2 尾巴收口回归（#31 + live_session 唯一键）
 *
 * 四条都是「现在能跑、但随时会咬人」的隐患：
 *  1. 提醒去重唯一键原来不含 is_deleted → 软删一条提醒后，同一事件同一到期时间再也插不进来；
 *     「撤销后重发」「清完重跑」都会撞 UNIQUE 或被静默丢弃。
 *  2. GET /actions/notifications 原来会顺手写库（reconcile）→ 只读接口能改数据，
 *     预取/重试/别人刷新都能触发写入。现在改到 POST /actions/notifications/sync。
 *  3. seed reset 原来会把 schema_migration 一起清空 → 迁移版本记忆丢失，
 *     下次 migrate 从头重放历史迁移（其中有的会改数据）。
 *  4. 直播场次 (店铺, 计划开播) 是导入中心对外承诺的幂等键，原来只写在应用层
 *     SELECT-then-INSERT 里，并发或重跑就能插出两场重复直播。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get, insert } from '../src/core/db.js';
import { seedDemoData } from '../src/db/seed.js';
import { ACCOUNTS, auth, boot, login, type TestContext } from './helper.js';

let ctx: TestContext;
const tok: Record<string, string> = {};

const userId = (username: string): number => Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, username)?.id ?? 0);
const noticeCount = (eventId: number): { all: number; alive: number } => ({
  all: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM user_notification WHERE alert_event_id = ?`, eventId)?.c ?? 0),
  alive: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM user_notification WHERE alert_event_id = ? AND is_deleted = 0`, eventId)?.c ?? 0),
});

function createDueEvent(owner: number, target: string): number {
  const ruleId = Number(get<{ id: number }>(`SELECT id FROM alert_rule ORDER BY id LIMIT 1`)?.id ?? 0);
  return insert('alert_event', {
    rule_id: ruleId,
    target_type: 'creator',
    target_name: target,
    shop_id: null,
    detected_at: '2000-01-01 00:00:00',
    evidence_json: JSON.stringify({ note: 'hardening' }),
    priority: 1,
    status: 0,
    owner_id: owner,
    due_at: '2000-01-02 00:00:00',
    created_by: owner,
  });
}

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
});

describe('提醒：读接口不写库，软删后可重发', () => {
  it('GET /notifications 不再产生或失效提醒', async () => {
    const owner = userId(ACCOUNTS.bd);
    const eventId = createDueEvent(owner, 'hardening-read-only');
    const before = noticeCount(eventId);
    expect(before.all).toBe(0);

    const res = await ctx.http.get('/api/actions/notifications').set(auth(tok.bd));
    expect(res.status).toBe(200);
    expect(noticeCount(eventId).all).toBe(before.all); // 关键：GET 之后一条都没多
  });

  it('POST /notifications/sync 才生成提醒；软删同一条后还能再发一次', async () => {
    const owner = userId(ACCOUNTS.bd);
    const eventId = createDueEvent(owner, 'hardening-resync');
    const sync = await ctx.http.post('/api/actions/notifications/sync').set(auth(tok.bd)).send({});
    expect(sync.status).toBe(200);
    expect(noticeCount(eventId).alive).toBe(1);

    const nid = Number(get<{ id: number }>(`SELECT id FROM user_notification WHERE alert_event_id = ? AND is_deleted = 0`, eventId)?.id ?? 0);
    ctx.db.prepare(`UPDATE user_notification SET is_deleted = 1 WHERE id = ?`).run(nid);

    // 旧唯一键（不含 is_deleted）在这里会直接 UNIQUE 冲突
    const again = await ctx.http.post('/api/actions/notifications/sync').set(auth(tok.bd)).send({});
    expect(again.status).toBe(200);
    const after = noticeCount(eventId);
    expect(after.alive).toBe(1);
    expect(after.all).toBe(2); // 一条留档（已软删）+ 一条新提醒
  });

  it('重复 sync 幂等：不会给同一事件堆提醒', async () => {
    const owner = userId(ACCOUNTS.content);
    const eventId = createDueEvent(owner, 'hardening-idempotent');
    for (let i = 0; i < 3; i++) expect((await ctx.http.post('/api/actions/notifications/sync').set(auth(tok.content))).status).toBe(200);
    expect(noticeCount(eventId).alive).toBe(1);
  });
});

describe('seed reset 不得清掉迁移版本表', () => {
  it('重置演示数据后 schema_migration 仍在（迁移记忆不被抹掉）', () => {
    seedDemoData({ reset: true });
    const rows = ctx.db.prepare(`SELECT version FROM schema_migration`).all() as { version: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.version)).toContain('2026-09-20-user-due-notifications-v1');
    // reset 也不能把索引打掉：唯一键还在才敢说「软删后可重发」
    const idx = ctx.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('ux_user_notification_dedupe','ux_live_shop_plan_start')`).all() as { name: string }[];
    expect(idx.map((i) => i.name).sort()).toEqual(['ux_live_shop_plan_start', 'ux_user_notification_dedupe']);
  });
});

describe('直播场次幂等键由数据库兜住', () => {
  const shopId = (): number => Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id ?? 0);

  it('同店铺同开播时间插第二次直接报唯一冲突', () => {
    const shop = shopId();
    const plan = '2026-09-30 20:00:00';
    insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), plan_start: plan, status: 1 });
    expect(() => insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), plan_start: plan, status: 1 })).toThrow(/UNIQUE constraint failed: live_session.shop_id, live_session.plan_start/);
  });

  it('软删原场次后可以重新排同一时间；未排时间的场次不受约束', () => {
    const shop = shopId();
    const plan = '2026-10-05 19:00:00';
    const id = insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), plan_start: plan, status: 1 });
    ctx.db.prepare(`UPDATE live_session SET is_deleted = 1 WHERE id = ?`).run(id);
    expect(() => insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), plan_start: plan, status: 1 })).not.toThrow();
    // plan_start 为 NULL（只排了人没排时间）不参与唯一性
    expect(() => insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), status: 1 })).not.toThrow();
    expect(() => insert('live_session', { shop_id: shop, host_id: userId(ACCOUNTS.content), status: 1 })).not.toThrow();
  });
});
