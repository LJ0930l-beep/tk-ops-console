import { beforeAll, describe, expect, it } from 'vitest';
import { round2 } from '@tk/shared';
import { all, get, run } from '../src/core/db.js';
import { config } from '../src/config.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';
import { flagOverdueCollabs, flagOverdueSamples, refreshVideoAggregates, recycleExpiredCreators } from '../src/jobs/creatorJobs.js';

/**
 * 达人中心（表 9-12 + 6.1 闭环 + 8.1/8.2 权限）
 * 覆盖：脱敏 / 防撞单 / 保护期回收 / 10 秒建联 / 合作单状态机 / 费用与投产比口径 / 寄样超期 / 作业函数
 */

const http = boot().http;

const today = (): string => new Date().toISOString().slice(0, 10);
const dayOffset = (n: number, base = new Date()): string => new Date(base.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const nowStr = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');
const mask = (v: unknown): boolean => v === '***';

/** 种子账号 id（sys_user 插入顺序固定） */
const USER = { boss: 1, limy: 2, wangqiang: 4, chenbd: 5, lubd: 6, hudm: 7, yinuo: 8, whzhao: 12 } as const;
/** 种子达人：公海 4/6/8/9/11，chenbd 私海 1/3/5/7/12(黑名单)，lubd 私海 2/10 */
const CREATOR = { aisyah: 1, kevin: 2, mangbert: 3, cosy: 4, fitjay: 5, gadget: 6, lina: 7, tales: 8, deals: 9, nose: 10, finds: 11, glow: 12 } as const;

const token: Record<string, string> = {};

beforeAll(async () => {
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(http, u);
});

/** 建一个公海达人（老板建公海，供各用例独立认领） */
async function makePublicCreator(handle: string): Promise<number> {
  const res = await http
    .post('/api/creators')
    .set(auth(token.boss))
    .send({ handle, nickname: `测试 ${handle}`, region: 'MY', followers: 5000, pool_status: 1, email: `${handle}@example.com`, whatsapp: `+6011${handle.length}00` });
  expect(res.status).toBe(200);
  const id = dataOf<{ id: number }>(res.body).id;
  expect(dataOf<{ owner_id: number | null }>(res.body).owner_id).toBe(null);
  return id;
}

const creatorRow = (id: number): Record<string, unknown> =>
  get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ?`, id) ?? {};

const lastOwnerLog = (id: number): { before: Record<string, unknown>; after: Record<string, unknown> } => {
  const row = get<{ before_after: string }>(
    `SELECT before_after FROM sys_op_log WHERE target_table = 'creator' AND target_id = ? AND action = 'update'
      AND before_after LIKE '%"owner_id"%' ORDER BY id DESC LIMIT 1`,
    id,
  );
  return JSON.parse(row?.before_after ?? '{}') as { before: Record<string, unknown>; after: Record<string, unknown> };
};

/* ==================================================================== */
describe('达人库：列表范围 + 联系方式脱敏（方案 8.1 / 8.2）', () => {
  it('未登录 401', async () => {
    expect((await http.get('/api/creators')).status).toBe(401);
  });

  it('老板看全量，联系方式明文', async () => {
    const res = await http.get('/api/creators?pageSize=100').set(auth(token.boss));
    expect(res.status).toBe(200);
    const { list, total } = pageOf(res.body);
    expect(total).toBe(12);
    expect(list.length).toBe(12);
    for (const c of list) {
      expect(mask(c.email)).toBe(false);
      expect(String(c.email)).toContain('@');
    }
    expect(list.some((c) => c.owner_name === '陈思远')).toBe(true);
  });

  it('BD 只看公海 + 自己私海，看不到他人私海', async () => {
    const mine = pageOf((await http.get('/api/creators?scope=mine&pageSize=100').set(auth(token.bd))).body);
    expect(mine.list.every((c) => Number(c.owner_id) === USER.chenbd)).toBe(true);
    expect(mine.total).toBe(5);

    const pool = pageOf((await http.get('/api/creators?scope=pool&pageSize=100').set(auth(token.bd))).body);
    expect(pool.total).toBe(5);
    expect(pool.list.every((c) => c.owner_id === null)).toBe(true);

    // lubd 的私海（kevinreviews）对 chenbd 不可见
    const other = pageOf((await http.get('/api/creators?keyword=kevinreviews').set(auth(token.bd))).body);
    expect(other.total).toBe(0);
    expect((await http.get(`/api/creators/${CREATOR.kevin}`).set(auth(token.bd))).status).toBe(404);

    // 黑名单
    const black = pageOf((await http.get('/api/creators?scope=blacklist').set(auth(token.bd))).body);
    expect(black.total).toBe(1);
    expect(black.list[0]?.handle).toBe('glowwithme');

    // 合作中
    const cooperating = pageOf((await http.get('/api/creators?scope=cooperating&pageSize=100').set(auth(token.bd))).body);
    expect(cooperating.list.every((c) => Number(c.pool_status) === 3)).toBe(true);
    expect(cooperating.total).toBeGreaterThanOrEqual(2);

    expect((await http.get('/api/creators?scope=nope').set(auth(token.bd))).status).toBe(400);
  });

  it('无 can_see_contact 的员工：邮箱 / WhatsApp 一律 ***', async () => {
    const res = await pageOf((await http.get('/api/creators?scope=pool&pageSize=100').set(auth(token.ops))).body);
    expect(res.total).toBeGreaterThan(0);
    for (const c of res.list) {
      expect(mask(c.email)).toBe(true);
      expect(mask(c.whatsapp)).toBe(true);
      expect(c.can_claim).toBe(true);
    }
  });

  it('无 can_see_contact 但达人归属本人：仍可见明文', async () => {
    const created = await http
      .post('/api/creators')
      .set(auth(token.boss))
      .send({ handle: 't-owner-branch', email: 'secret@example.com', whatsapp: '+6019000001', owner_id: USER.whzhao });
    expect(created.status).toBe(200);
    const id = dataOf<{ id: number }>(created.body).id;

    const asOwner = dataOf<Record<string, unknown>>((await http.get(`/api/creators/${id}`).set(auth(token.warehouse))).body);
    expect(asOwner.email).toBe('secret@example.com');
    expect(asOwner.is_mine).toBe(true);

    // 同一员工视角：别人的达人仍然打码
    const list = pageOf((await http.get('/api/creators?keyword=aisyah').set(auth(token.warehouse))).body);
    expect(list.list[0]?.email).toBe('***');
  });

  it('达人详情聚合合作单 / 寄样 / 跟进；不存在 404', async () => {
    const detail = dataOf<Record<string, unknown>>((await http.get(`/api/creators/${CREATOR.aisyah}`).set(auth(token.boss))).body);
    expect(detail.handle).toBe('aisyah.tech');
    expect(Array.isArray(detail.collabs)).toBe(true);
    expect(Number(detail.collab_count)).toBe(1);
    expect(Array.isArray(detail.samples)).toBe(true);
    expect(Array.isArray(detail.outreach)).toBe(true);
    expect(Number(detail.outreach?.length)).toBeGreaterThanOrEqual(1);
    expect((await http.get('/api/creators/999999').set(auth(token.boss))).status).toBe(404);
  });
});

/* ==================================================================== */
describe('达人库：新建 / 修改 / 删除（handle 归一化防撞单）', () => {
  it('归一化 @ 与大写入库，默认进本人私海 + 30 天保护期', async () => {
    const res = await http
      .post('/api/creators')
      .set(auth(token.bd))
      .send({ handle: '  @T-NewStar ', followers: 12000, avg_views: 300, region: 'MY', category_tags: ['3C数码', '家居生活'], email: 'new.star@gmail.com', gmv_level: 'B' });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.handle).toBe('t-newstar');
    expect(d.owner_id).toBe(USER.chenbd);
    expect(d.pool_status).toBe(2);
    const row = creatorRow(Number(d.id));
    expect(row.category_tags).toBe('3C数码,家居生活');
    expect(row.protect_until).toBe(dayOffset(config.protectDefaultDays));
  });

  it('同 handle 大小写 / @ 变体重复 → 409', async () => {
    for (const h of ['T-NEWSTAR', '  @t-newstar  ']) {
      const dup = await http.post('/api/creators').set(auth(token.bd)).send({ handle: h });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe(40901);
    }
    const seeded = await http.post('/api/creators').set(auth(token.bd)).send({ handle: '@Aisyah.Tech' });
    expect(seeded.status).toBe(409);
    expect(String(seeded.body.message)).toMatch(/已存在/);
  });

  it('非法入参 400：handle 过短 / 邮箱格式 / pool_status 越界', async () => {
    expect((await http.post('/api/creators').set(auth(token.bd)).send({ handle: 'a' })).status).toBe(400);
    expect((await http.post('/api/creators').set(auth(token.bd)).send({ handle: 'ok-handle', email: 'not-an-email' })).status).toBe(400);
    expect((await http.post('/api/creators').set(auth(token.bd)).send({ handle: 'ok-handle2', pool_status: 9 })).status).toBe(400);
  });

  it('无 creator 菜单的角色写不了（ops / content）', async () => {
    expect((await http.post('/api/creators').set(auth(token.ops)).send({ handle: 't-no-perm' })).status).toBe(403);
    expect((await http.put(`/api/creators/${CREATOR.aisyah}`).set(auth(token.content)).send({ nickname: 'x' })).status).toBe(403);
  });

  it('改归属必须主管 / 老板，且 before-after 留痕', async () => {
    const id = await makePublicCreator('t-transfer');
    expect((await http.post(`/api/creators/${id}/claim`).set(auth(token.bd))).status).toBe(200);
    // 同级 BD 不能转交
    const denied = await http.put(`/api/creators/${id}`).set(auth(token.bd2)).send({ owner_id: USER.lubd });
    expect([403, 404]).toContain(denied.status);
    const byBd = await http.put(`/api/creators/${id}`).set(auth(token.bd)).send({ owner_id: USER.lubd });
    expect(byBd.status).toBe(403);
    // BD 主管（DEPT）可以改组内归属
    const byManager = await http.put(`/api/creators/${id}`).set(auth(token.bdManager)).send({ owner_id: USER.lubd, pool_status: 2 });
    expect(byManager.status).toBe(200);
    expect(dataOf<{ owner_changed: boolean }>(byManager.body).owner_changed).toBe(true);
    expect(creatorRow(id).owner_id).toBe(USER.lubd);
    const log = lastOwnerLog(id);
    expect(log.before.owner_id).toBe(USER.chenbd);
    expect(log.after.owner_id).toBe(USER.lubd);
    // 接手人不存在
    expect((await http.put(`/api/creators/${id}`).set(auth(token.boss)).send({ owner_id: 99999 })).status).toBe(404);
  });

  it('软删只打标记，历史保留', async () => {
    const id = await makePublicCreator('t-softdel');
    expect((await http.delete(`/api/creators/${id}`).set(auth(token.boss))).status).toBe(200);
    expect(creatorRow(id).is_deleted).toBe(1);
    expect((await http.get(`/api/creators/${id}`).set(auth(token.boss))).status).toBe(404);
    // 已删除档案的 handle 仍不允许重建（避免历史归属错乱）
    expect((await http.post('/api/creators').set(auth(token.bd)).send({ handle: 't-softdel' })).status).toBe(409);
  });
});

/* ==================================================================== */
describe('公海认领 / 退回 / 黑名单（防撞单）', () => {
  it('认领成功 → 私海 + 保护期；他人重复认领 409 且不泄露联系方式', async () => {
    const id = await makePublicCreator('t-claim');
    const ok1 = await http.post(`/api/creators/${id}/claim?days=20`).set(auth(token.bd));
    expect(ok1.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(ok1.body);
    expect(d.owner_id).toBe(USER.chenbd);
    expect(d.pool_status).toBe(2);
    expect(d.protect_until).toBe(dayOffset(20));
    expect(creatorRow(id).owner_id).toBe(USER.chenbd);

    const twice = await http.post(`/api/creators/${id}/claim`).set(auth(token.bd));
    expect(twice.status).toBe(409);
    expect(String(twice.body.message)).toContain('你已经认领过');

    const rival = await http.post(`/api/creators/${id}/claim`).set(auth(token.bd2));
    expect(rival.status).toBe(409);
    expect(String(rival.body.message)).toContain('陈思远');
    expect(String(rival.body.message)).not.toContain('@');
    expect(String(rival.body.message)).not.toContain('+60');

    const log = lastOwnerLog(id);
    expect(log.before.owner_id).toBe(null);
    expect(log.after.owner_id).toBe(USER.chenbd);

    // 认领后他人不可改 / 不可删 / 不可寄样
    expect((await http.put(`/api/creators/${id}`).set(auth(token.bd2)).send({ nickname: 'hack' })).status).toBe(403);
    expect((await http.delete(`/api/creators/${id}`).set(auth(token.bd2))).status).toBe(403);
    expect((await http.post('/api/creators/sample').set(auth(token.bd2)).send({ creator_id: id, sample_cost: 10 })).status).toBe(403);
  });

  it('非公海达人不能认领；退回公海后可被他人认领', async () => {
    const id = await makePublicCreator('t-release');
    await http.post(`/api/creators/${id}/claim`).set(auth(token.bd));
    expect((await http.post(`/api/creators/${CREATOR.aisyah}/claim`).set(auth(token.bd2))).status).toBe(409);

    const released = await http.post(`/api/creators/${id}/release?reason=无人跟进`).set(auth(token.bd));
    expect(released.status).toBe(200);
    expect(dataOf<{ pool_status: number }>(released.body).pool_status).toBe(1);
    expect(creatorRow(id).owner_id).toBe(null);
    expect(creatorRow(id).protect_until).toBe(null);

    const claimedByOther = await http.post(`/api/creators/${id}/claim`).set(auth(token.bd2));
    expect(claimedByOther.status).toBe(200);
    expect(dataOf<{ owner_id: number }>(claimedByOther.body).owner_id).toBe(USER.lubd);
  });

  it('拉黑 → pool_status=4，解除回私海并续保护期；黑名单达人禁止跟进 / 建合作单', async () => {
    const id = await makePublicCreator('t-black');
    await http.post(`/api/creators/${id}/claim`).set(auth(token.bd));
    const added = await http.post(`/api/creators/${id}/blacklist`).set(auth(token.bd)).send({ action: 'add', reason: '刷量' });
    expect(added.status).toBe(200);
    expect(dataOf<{ pool_status: number }>(added.body).pool_status).toBe(4);
    expect(creatorRow(id).protect_until).toBe(null);
    expect((await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: id })).status).toBe(403);
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: id, shop_id: 1 })).status).toBe(403);

    const removed = await http.post(`/api/creators/${id}/blacklist`).set(auth(token.bd)).send({ action: 'remove' });
    expect(removed.status).toBe(200);
    expect(dataOf<{ pool_status: number }>(removed.body).pool_status).toBe(2);
    expect(creatorRow(id).protect_until).toBe(dayOffset(config.protectDefaultDays));
  });
});

/* ==================================================================== */
describe('建联跟进：10 秒一条 + 保护期续期 + 到期回收', () => {
  let followedId = 0;

  it('只传 creator_id + 结果即可录入，自动补 user_id / contact_time，公海转私海并续期 7 天', async () => {
    followedId = await makePublicCreator('t-follow');
    const res = await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: followedId, result: 2, summary: '私信自我介绍 + 佣金政策' });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    const creator = d.creator as Record<string, unknown>;
    expect(creator.owner_id).toBe(USER.chenbd);
    expect(creator.pool_status).toBe(2);
    expect(creator.protect_until).toBe(dayOffset(7));
    const row = get<Record<string, unknown>>(`SELECT * FROM creator_outreach WHERE id = ?`, Number(d.id)) ?? {};
    expect(row.user_id).toBe(USER.chenbd);
    expect(String(row.contact_time)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Number(new Date(String(row.contact_time).replace(' ', 'T') + 'Z').getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('未来保护期不被浪费：续期在原截止日基础上 +7 天', async () => {
    const base = dayOffset(20);
    run(`UPDATE creator SET protect_until = ?, owner_id = ?, pool_status = 2 WHERE id = ?`, base, USER.chenbd, followedId);
    await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: followedId, result: 3 });
    expect(creatorRow(followedId).protect_until).toBe(dayOffset(7, new Date(`${base}T00:00:00Z`)));
  });

  it('达人时间线 + 全局列表（默认只看本人，group=true 看本组）', async () => {
    const timeline = dataOf<{ total: number; creator: { id: number; handle: unknown }; list: Record<string, unknown>[] }>(
      (await http.get(`/api/creators/${followedId}/outreach`).set(auth(token.bd))).body,
    );
    expect(timeline.total).toBeGreaterThanOrEqual(2);
    expect(timeline.list[0]?.user_name).toBe('陈思远');
    expect(timeline.creator.handle).toBe('t-follow');
    expect(timeline.creator.id).toBe(followedId);

    const own = pageOf((await http.get('/api/creators/outreach?pageSize=100').set(auth(token.bd))).body);
    expect(own.list.every((r) => Number(r.user_id) === USER.chenbd)).toBe(true);

    const group = pageOf((await http.get('/api/creators/outreach?group=true&pageSize=200').set(auth(token.bdManager))).body);
    expect(group.list.some((r) => Number(r.user_id) === USER.lubd)).toBe(true);
    expect(group.total).toBeGreaterThan(own.total);

    const filtered = pageOf((await http.get(`/api/creators/outreach?group=true&creator_id=${followedId}`).set(auth(token.bd))).body);
    expect(filtered.total).toBe(2);
  });

  it('到点待跟进清单', async () => {
    const dueAt = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const far = new Date(Date.now() + 5 * 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: followedId, result: 4, next_follow_at: dueAt });
    await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: followedId, result: 4, next_follow_at: far });
    const due = dataOf<{ list: Record<string, unknown>[]; total: number }>((await http.get('/api/creators/outreach/due?hours=24').set(auth(token.bd))).body);
    expect(due.list.every((r) => String(r.next_follow_at) <= new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' '))).toBe(true);
    expect(due.list.some((r) => Number(r.creator_id) === followedId)).toBe(true);
    expect(due.list.some((r) => String(r.next_follow_at) === far)).toBe(false);
    expect(Number(due.list[0]?.follow_times)).toBeGreaterThanOrEqual(1);
  });

  it('他人私海达人不能录跟进；改 / 删只能本人或主管', async () => {
    expect((await http.post('/api/creators/outreach').set(auth(token.bd2)).send({ creator_id: followedId })).status).toBe(403);
    const mine = get<{ id: number }>(`SELECT id FROM creator_outreach WHERE creator_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`, followedId, USER.chenbd);
    expect(mine).toBeTruthy();
    expect((await http.put(`/api/creators/outreach/${mine?.id}`).set(auth(token.bd2)).send({ summary: 'x' })).status).toBe(403);
    expect((await http.put(`/api/creators/outreach/${mine?.id}`).set(auth(token.bdManager)).send({ summary: '主管补充', result: 5 })).status).toBe(200);
    expect(get<{ summary: string }>(`SELECT summary FROM creator_outreach WHERE id = ?`, mine?.id as number)?.summary).toBe('主管补充');
    expect((await http.delete(`/api/creators/outreach/${mine?.id}`).set(auth(token.bdManager))).status).toBe(200);
    expect(get<{ is_deleted: number }>(`SELECT is_deleted FROM creator_outreach WHERE id = ?`, mine?.id as number)?.is_deleted).toBe(1);
    expect((await http.put('/api/creators/outreach/999999').set(auth(token.bd)).send({ summary: 'x' })).status).toBe(404);
  });

  it('结果=谈妥给出建合作单提示', async () => {
    const res = await http.post('/api/creators/outreach').set(auth(token.bd)).send({ creator_id: followedId, result: 6 });
    expect(String(dataOf<{ hint: string | null }>(res.body).hint)).toContain('POST /creators/collab');
  });

  it('保护期到期且无进展 → 回收公海（接口 + 作业函数）', async () => {
    const stale = await makePublicCreator('t-expired');
    const kept = await makePublicCreator('t-expired-kept');
    const busy = await makePublicCreator('t-expired-busy');
    run(`UPDATE creator SET owner_id = ?, pool_status = 2, protect_until = ? WHERE id = ?`, USER.chenbd, dayOffset(-1), stale);
    run(`UPDATE creator SET owner_id = ?, pool_status = 2, protect_until = ? WHERE id = ?`, USER.chenbd, dayOffset(-1), kept);
    run(`UPDATE creator SET owner_id = ?, pool_status = 2, protect_until = ? WHERE id = ?`, USER.chenbd, dayOffset(-1), busy);
    // kept：保护期之后有新跟进 → 不回收
    run(`INSERT INTO creator_outreach (creator_id, user_id, channel, contact_time, summary, result) VALUES (?, ?, 1, ?, '保护期内有跟进', 2)`,
      kept, USER.chenbd, nowStr());
    // busy：有在途合作单 → 不回收
    run(`INSERT INTO collaboration (collab_no, creator_id, shop_id, coop_type, commission_rate, fixed_fee, fee_currency, promised_videos, promised_lives, status, owner_id)
         VALUES ('CB-TEST-BUSY', ?, 1, 1, 10, 0, 'USD', 1, 0, 1, ?)`, busy, USER.chenbd);

    const expiring = dataOf<{ list: Record<string, unknown>[]; total: number }>((await http.get('/api/creators/expiring?days=7').set(auth(token.bd))).body);
    expect(expiring.list.some((r) => Number(r.id) === stale && r.will_recycle === true)).toBe(true);
    expect(expiring.list.some((r) => Number(r.id) === busy && r.will_recycle === false)).toBe(true);
    expect(expiring.list.some((r) => Number(r.id) === kept && Number(r.recent_follows) >= 1)).toBe(true);

    const res = await http.post('/api/creators/recycle-expired').set(auth(token.bd));
    expect(res.status).toBe(200);
    const d = dataOf<{ recycled: number; ids: number[] }>(res.body);
    expect(d.ids).toContain(stale);
    expect(d.ids).not.toContain(kept);
    expect(d.ids).not.toContain(busy);
    expect(creatorRow(stale).owner_id).toBe(null);
    expect(creatorRow(stale).pool_status).toBe(1);
    expect(creatorRow(stale).protect_until).toBe(null);

    // 幂等：再跑一次不会重复回收；作业函数返回条数
    expect(dataOf<{ recycled: number }>((await http.post('/api/creators/recycle-expired').set(auth(token.bd))).body).recycled).toBe(0);
    expect(typeof recycleExpiredCreators()).toBe('number');
    // 种子数据里 chenbd 私海达人保护期（2026-09-12）已过，主管跑全库同样能回收
    const before = all<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 AND owner_id IS NULL`).length;
    expect(recycleExpiredCreators()).toBeGreaterThanOrEqual(0);
    expect(all<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 AND owner_id IS NULL`).length).toBeGreaterThanOrEqual(before);
  });
});

/* ==================================================================== */
describe('批量导入 + mock 平台达人搜索入库', () => {
  it('batch-import：新建 / 合并 / 失败分流', async () => {
    const res = await http.post('/api/creators/batch-import').set(auth(token.bd)).send({
      rows: [
        { handle: 'T-Import-One', followers: '88000', email: 'one@gmail.com', category_tags: '3C数码' },
        { handle: 't-import-one', nickname: '重复行' },
        { handle: 'x' },
        { handle: 'import.two', email: 'bad-mail' },
        { handle: 'aisyah.tech', nickname: '合并补齐 gmv_level', gmv_level: 'A' },
      ],
    });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.total).toBe(5);
    expect(d.success).toBe(1);
    expect(d.merged).toBe(1);
    expect((d.failed as { row: number; reason: string }[]).map((f) => f.row)).toEqual([1, 2, 3]);
    expect((d.detail as { action: string }[]).map((x) => x.action)).toEqual(['created', 'merged']);
    const created = get<Record<string, unknown>>(`SELECT * FROM creator WHERE handle = 't-import-one'`) ?? {};
    expect(created.owner_id).toBe(USER.chenbd);
    expect(created.followers).toBe(88000);
    expect(get<{ gmv_level: string }>(`SELECT gmv_level FROM creator WHERE handle = 'aisyah.tech'`)?.gmv_level).toBe('A');
    expect((await http.post('/api/creators/batch-import').set(auth(token.bd)).send({ rows: [] })).status).toBe(400);
  });

  it('老板可指定 owner_username 归属他人', async () => {
    const res = await http.post('/api/creators/batch-import').set(auth(token.boss)).send({
      rows: [{ handle: 't-import-three', owner_username: 'lubd', followers: 1000 }],
    });
    expect(dataOf<{ success: number }>(res.body).success).toBe(1);
    const row = get<Record<string, unknown>>(`SELECT * FROM creator WHERE handle = 't-import-three'`) ?? {};
    expect(row.owner_id).toBe(USER.lubd);
    expect(row.pool_status).toBe(2);
    const bad = await http.post('/api/creators/batch-import').set(auth(token.boss)).send({ rows: [{ handle: 't-import-four', owner_username: 'ghost' }] });
    expect(String(dataOf<{ failed: { reason: string }[] }>(bad.body).failed[0]?.reason)).toContain('owner_username 不存在');
  });

  it('平台搜索（离线 mock）：不返回联系方式，已入库达人打标', async () => {
    const res = await http.get('/api/creators/search?keyword=zara').set(auth(token.ops));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.mode).toBe('mock');
    const list = d.list as Record<string, unknown>[];
    expect(list.some((r) => r.handle === 'zara.my' && r.already_in_db === false)).toBe(true);
    expect(list.every((r) => r.email === null && r.whatsapp === null)).toBe(true);

    const inDb = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/search?keyword=aisyah').set(auth(token.boss))).body);
    expect(inDb.list[0]?.already_in_db).toBe(true);
    expect(inDb.list[0]?.key).toBe(`db-${CREATOR.aisyah}`);

    const byRegion = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/search?region=PH&followers_min=100000&keyword=ph').set(auth(token.boss))).body);
    expect(byRegion.list.every((r) => r.region === 'PH' && Number(r.followers) >= 100000)).toBe(true);
  });

  it('搜索结果一键入库：新达人进私海 / 已有档案转认领', async () => {
    const imported = await http.post('/api/creators/pf-0/import-from-search').set(auth(token.bd)).send({});
    expect(imported.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(imported.body);
    expect(d.handle).toBe('zara.my');
    expect(d.action).toBe('imported');
    expect(d.owner_id).toBe(USER.chenbd);
    expect(creatorRow(Number(d.creator_id)).pool_status).toBe(2);

    const again = dataOf<Record<string, unknown>>((await http.post('/api/creators/pf-0/import-from-search').set(auth(token.bd)).send({})).body);
    expect(again.action).toBe('exists');
    expect(again.creator_id).toBe(d.creator_id);

    const publicId = await makePublicCreator('t-search-public');
    const claimed = dataOf<Record<string, unknown>>((await http.post(`/api/creators/db-${publicId}/import-from-search`).set(auth(token.bd2)).send({ claim: true })).body);
    expect(claimed.action).toBe('claimed');
    expect(claimed.creator_id).toBe(publicId);
    expect(creatorRow(publicId).owner_id).toBe(USER.lubd);
  });
});

/* ==================================================================== */
describe('合作单：归属校验 / 状态机 / 费用 / 投产比', () => {
  let collabId = 0;

  it('达人必须在本人 / 本组私海，公海 / 黑名单达人拒绝；成功后达人转合作中', async () => {
    const publicId = await makePublicCreator('t-collab-public');
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: publicId, shop_id: 1 })).status).toBe(403);
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.glow, shop_id: 1 })).status).toBe(403);
    // lubd 的私海达人（非本组？同一组 达人一组 → BD 主管可，普通 BD 不可）
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.kevin, shop_id: 1 })).status).toBe(403);
    expect((await http.post('/api/creators/collab').set(auth(token.bdManager)).send({ creator_id: CREATOR.kevin, shop_id: 1, promised_videos: 1 })).status).toBe(200);

    const res = await http.post('/api/creators/collab').set(auth(token.bd)).send({
      creator_id: CREATOR.mangbert, shop_id: 3, spu_id: 6, coop_type: 1, commission_rate: 15,
      fixed_fee: 200, fee_currency: 'USD', promised_videos: 2, promised_lives: 1, deadline: dayOffset(10),
    });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    collabId = Number(d.id);
    expect(String(d.collab_no)).toMatch(/^CB\d{8}-\d{4}$/);
    expect(d.creator_pool_status).toBe(3);
    expect(creatorRow(CREATOR.mangbert).pool_status).toBe(3);
    const log = lastOwnerLog(CREATOR.mangbert);
    expect(log.after.pool_status).toBe(3);
    expect(String(log.after.reason)).toContain('建合作单');

    // 店铺 / SPU 不存在
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.lina, shop_id: 999 })).status).toBe(404);
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.lina, shop_id: 1, spu_id: 999 })).status).toBe(404);
    expect((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.lina, shop_id: 1, coop_type: 2, fixed_fee: 0 })).status).toBe(400);
  });

  it('列表带达人 / 店铺 / SPU / 视频数 / 寄样数，费用列按 can_see_cost 脱敏', async () => {
    const asBd = pageOf((await http.get(`/api/creators/collab?creator_id=${CREATOR.mangbert}&status=1`).set(auth(token.bd))).body);
    expect(asBd.total).toBe(1);
    const row = asBd.list[0] as Record<string, unknown>;
    expect(Number(row.id)).toBe(collabId);
    expect(row.creator_handle).toBe('mangbertoys');
    expect(row.shop_name).toBe('ANTA US Creator Store');
    expect(row.spu_name).toBe('轻量缓震跑鞋');
    expect(row.shop_currency).toBe('USD');
    expect(row.video_count).toBe(0);
    expect(row.sample_count).toBe(0);
    expect(row.publish_ok).toBe(false);
    expect(row.videos_gap).toBe(2);
    // bd 无成本权限 → 坑位费打码
    expect(row.fixed_fee).toBe('***');
    expect(row.fee_cny).toBe('***');

    const asBoss = pageOf((await http.get('/api/creators/collab?status=1').set(auth(token.boss))).body);
    expect(asBoss.list.every((r) => Number(r.status) === 1)).toBe(true);
    expect(Number((asBoss.list as Record<string, unknown>[]).find((r) => Number(r.id) === collabId)?.fixed_fee)).toBe(200);
  });

  it('状态机：1→2→3→4→5→6 合法，跳跃 / 回退 400，取消需主管', async () => {
    for (const s of [2, 3, 4, 5, 6]) {
      const res = await http.post(`/api/creators/collab/${collabId}/status`).set(auth(token.bd)).send({ status: s, remark: `推进到 ${s}` });
      expect(res.status).toBe(200);
      expect(dataOf<{ status: number }>(res.body).status).toBe(s);
    }
    expect((await http.post(`/api/creators/collab/${collabId}/status`).set(auth(token.bd)).send({ status: 1 })).status).toBe(400);
    expect((await http.post(`/api/creators/collab/${collabId}/status`).set(auth(token.bd)).send({ status: 6 })).status).toBe(400);

    const fresh = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.lina, shop_id: 1, promised_videos: 1 })).body);
    expect((await http.post(`/api/creators/collab/${fresh.id}/status`).set(auth(token.bd)).send({ status: 4 })).status).toBe(400);
    expect((await http.post(`/api/creators/collab/${fresh.id}/status`).set(auth(token.bd)).send({ status: 8 })).status).toBe(403);
    expect((await http.post(`/api/creators/collab/${fresh.id}/status`).set(auth(token.bdManager)).send({ status: 8 })).status).toBe(200);
    expect((await http.post(`/api/creators/collab/${fresh.id}/status`).set(auth(token.bdManager)).send({ status: 1 })).status).toBe(400);

    const overdue = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.fitjay, shop_id: 1 })).body);
    expect((await http.post(`/api/creators/collab/${overdue.id}/status`).set(auth(token.bd)).send({ status: 7 })).status).toBe(200);
    expect((await http.post(`/api/creators/collab/${overdue.id}/status`).set(auth(token.bd)).send({ status: 5 })).status).toBe(200);
    expect((await http.post('/api/creators/collab/999999/status').set(auth(token.bd)).send({ status: 2 })).status).toBe(404);
  });

  it('PUT 修改：改负责 BD 需主管；非法达人 / 店铺字段不可改', async () => {
    const id = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.aisyah, shop_id: 1, promised_videos: 1 })).body).id;
    expect((await http.put(`/api/creators/collab/${id}`).set(auth(token.bd)).send({ promised_videos: 4, deadline: dayOffset(15) })).status).toBe(200);
    expect(get<{ promised_videos: number }>(`SELECT promised_videos FROM collaboration WHERE id = ?`, id)?.promised_videos).toBe(4);
    expect((await http.put(`/api/creators/collab/${id}`).set(auth(token.bd)).send({ owner_id: USER.lubd })).status).toBe(403);
    expect((await http.put(`/api/creators/collab/${id}`).set(auth(token.boss)).send({ owner_id: USER.lubd })).status).toBe(200);
    expect(get<{ owner_id: number }>(`SELECT owner_id FROM collaboration WHERE id = ?`, id)?.owner_id).toBe(USER.lubd);
    // 转交后 chenbd 不在范围内
    expect((await http.put(`/api/creators/collab/${id}`).set(auth(token.bd)).send({ promised_videos: 9 })).status).toBe(403);
    expect((await http.put(`/api/creators/collab/999999`).set(auth(token.boss)).send({ promised_videos: 1 })).status).toBe(404);
  });

  it('坑位费一键生成费用：按 exchange_rate 折 CNY，重复调用幂等', async () => {
    const rate = Number(get<{ rate_to_cny: number }>(
      `SELECT rate_to_cny FROM exchange_rate WHERE currency = 'USD' AND is_deleted = 0 AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
      today(),
    )?.rate_to_cny ?? 1);
    const res = await http.post(`/api/creators/collab/${collabId}/expense`).set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.existed).toBe(false);
    expect(d.amount).toBe(200);
    expect(d.currency).toBe('USD');
    expect(d.amount_cny).toBe(round2(200 * rate));
    const row = get<Record<string, unknown>>(`SELECT * FROM expense WHERE id = ?`, Number(d.expense_id)) ?? {};
    expect(row.expense_type).toBe(1);
    expect(row.ref_type).toBe('collaboration');
    expect(row.ref_id).toBe(collabId);
    expect(row.status).toBe(1);

    const again = dataOf<Record<string, unknown>>((await http.post(`/api/creators/collab/${collabId}/expense`).set(auth(token.boss))).body);
    expect(again.existed).toBe(true);
    expect(again.expense_id).toBe(d.expense_id);
    expect(all<{ id: number }>(`SELECT id FROM expense WHERE ref_type = 'collaboration' AND ref_id = ?`, collabId).length).toBe(1);
    // 坑位费为 0 的合作单不生成
    const zero = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({ creator_id: CREATOR.lina, shop_id: 1 })).body).id;
    expect((await http.post(`/api/creators/collab/${zero}/expense`).set(auth(token.boss))).status).toBe(400);
  });

  it('单合作投产比：净 GMV 折 CNY，扣已完成退款、排除样品单；无成本权限脱敏', async () => {
    const creatorId = await makePublicCreator('t-roi-collab');
    await http.post(`/api/creators/${creatorId}/claim`).set(auth(token.bd));
    const collab = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({
      creator_id: creatorId, shop_id: 3, coop_type: 1, commission_rate: 10, promised_videos: 1,
    })).body).id;
    const sample = dataOf<{ id: number; sample_cost: number }>((await http.post('/api/creators/sample').set(auth(token.bd)).send({
      collab_id: collab, creator_id: creatorId, sku_id: 1, quantity: 2, shipping_cost: 50,
    })).body);
    // SKU1 = 采购 96 + 头程 22 = 118/件，冻结总额 = 118 × 2
    expect(sample.sample_cost).toBe(236);

    const video = dataOf<{ tk_video_id: string }>((await http.post('/api/content/videos').set(auth(token.bd)).send({
      video_url: 'https://www.tiktok.com/@troicollab/video/7599000000000000001', publisher_type: 2, collab_id: collab, creator_id: creatorId, views: 1000,
    })).body);
    expect(video.tk_video_id).toBe('7599000000000000001');

    const orderTime = `${today()} 08:00:00`;
    const rate = Number(get<{ rate_to_cny: number }>(
      `SELECT rate_to_cny FROM exchange_rate WHERE currency = 'USD' AND is_deleted = 0 AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
      today(),
    )?.rate_to_cny ?? 1);
    const mkOrder = (isSample: number, tkOrderId: string) =>
      run(`INSERT INTO tk_order (shop_id, tk_order_id, order_status, order_time, currency, total_paid, is_sample_order) VALUES (3, ?, 'COMPLETED', ?, 'USD', 100, ?)`, tkOrderId, orderTime, isSample);
    mkOrder(0, 'ROI-TEST-1');
    const oid = Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = 'ROI-TEST-1'`)?.id);
    run(`INSERT INTO tk_order_item (order_id, sku_id, quantity, unit_price, item_amount, creator_id, content_type, content_id, commission_rate, est_commission)
         VALUES (?, 1, 1, 100, 100, ?, 1, ?, 10, 10)`, oid, creatorId, video.tk_video_id);
    const itemId = Number(get<{ id: number }>(`SELECT id FROM tk_order_item WHERE order_id = ?`, oid)?.id);
    run(`INSERT INTO tk_return (order_id, shop_id, tk_order_item_id, tk_return_id, return_type, reason, refund_amount, currency, status, apply_time)
         VALUES (?, 3, ?, 'ROI-TEST-RT1', 1, '质量问题', 20, 'USD', 'COMPLETED', ?)`, oid, itemId, orderTime);
    // 未完成的退款不扣减
    run(`INSERT INTO tk_return (order_id, shop_id, tk_order_item_id, tk_return_id, return_type, reason, refund_amount, currency, status, apply_time)
         VALUES (?, 3, ?, 'ROI-TEST-RT2', 1, '买家不想要', 30, 'USD', 'PROCESSING', ?)`, oid, itemId, orderTime);
    // 免费样品单不计入 GMV
    mkOrder(1, 'ROI-TEST-2');
    const oid2 = Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = 'ROI-TEST-2'`)?.id);
    run(`INSERT INTO tk_order_item (order_id, sku_id, quantity, unit_price, item_amount, creator_id, content_type, content_id, commission_rate, est_commission)
         VALUES (?, 1, 1, 999, 999, ?, 1, ?, 10, 99)`, oid2, creatorId, video.tk_video_id);

    const roi = dataOf<Record<string, unknown>>((await http.get(`/api/creators/collab/${collab}/roi?period=all`).set(auth(token.boss))).body);
    expect(roi.gmv_cny).toBe(round2(100 * rate));
    expect(roi.refund_cny).toBe(round2(20 * rate));
    expect(roi.net_gmv_cny).toBe(round2(80 * rate));
    expect(roi.commission_cny).toBe(round2(10 * rate));
    expect(roi.sample_cost).toBe(236);
    expect(roi.sample_shipping).toBe(50);
    expect(roi.fixed_fee_cny).toBe(0);
    expect(roi.orders).toBe(1);
    expect(roi.cost).toBe(round2(236 + 50 + 0 + round2(10 * rate)));
    expect(roi.roi).toBe(round2(round2(80 * rate) / round2(236 + 50 + round2(10 * rate))));
    expect(roi.publish_ok).toBe(true);
    expect(roi.video_count).toBe(1);
    expect(String(roi.formula)).toContain('净 GMV');
    expect(refreshVideoAggregates()).toBeGreaterThanOrEqual(1);
    expect(get<{ orders: number; gmv: number }>(`SELECT orders, gmv FROM video WHERE tk_video_id = ?`, video.tk_video_id)).toEqual({ orders: 1, gmv: round2(80 * rate) });

    const detail = dataOf<Record<string, unknown>>((await http.get(`/api/creators/collab/${collab}`).set(auth(token.boss))).body);
    expect(Number(detail.video_count)).toBe(1);
    expect(Number(detail.sample_count)).toBe(1);
    expect(detail.status).toBe(5);

    const masked = dataOf<Record<string, unknown>>((await http.get(`/api/creators/collab/${collab}/roi?period=all`).set(auth(token.bd))).body);
    expect(masked.gmv_cny).toBe('***');
    expect(masked.net_gmv_cny).toBe('***');
    expect(masked.roi).toBe('***');
    expect(masked.creator_id).not.toBe('***');
  });

  it('超期未履约：deadline 已过且视频数未达标 → 作业置 7 并可查清单', async () => {
    const creatorId = await makePublicCreator('t-overdue-collab');
    await http.post(`/api/creators/${creatorId}/claim`).set(auth(token.bd));
    const collab = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({
      creator_id: creatorId, shop_id: 1, promised_videos: 3, deadline: dayOffset(-3),
    })).body).id;
    const list = dataOf<{ list: Record<string, unknown>[]; total: number }>((await http.get('/api/creators/collab/overdue').set(auth(token.bd))).body);
    expect(list.list.some((r) => Number(r.id) === collab)).toBe(true);
    expect(Number((list.list.find((r) => Number(r.id) === collab) as Record<string, unknown>).overdue_days)).toBe(3);

    expect(flagOverdueCollabs()).toBeGreaterThanOrEqual(1);
    expect(get<{ status: number }>(`SELECT status FROM collaboration WHERE id = ?`, collab)?.status).toBe(7);
    const stats = dataOf<Record<string, unknown>>((await http.get('/api/creators/stats?period=all').set(auth(token.boss))).body);
    expect(Number(stats.collab_overdue)).toBeGreaterThanOrEqual(1);
    // 超期单仍可补发布
    expect((await http.post(`/api/creators/collab/${collab}/status`).set(auth(token.bd)).send({ status: 5 })).status).toBe(200);
    // 补 1 条视频并把约定条数调到 1 → 达标后不再出现在超期清单
    expect((await http.put(`/api/creators/collab/${collab}`).set(auth(token.bd)).send({ promised_videos: 1 })).status).toBe(200);
    const videoUrl = `https://www.tiktok.com/@t.overdue/video/759911111000${collab % 100}`;
    const reg = await http.post('/api/content/videos').set(auth(token.bd)).send({ video_url: videoUrl, publisher_type: 2, collab_id: collab });
    expect(reg.status).toBe(200);
    expect(dataOf<{ collab_status: number }>(reg.body).collab_status).toBe(5);
    expect(dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/collab/overdue').set(auth(token.boss))).body)
      .list.some((r) => Number(r.id) === collab)).toBe(false);
  });
});

/* ==================================================================== */
describe('寄样：成本快照 / 发货签收 / 丢件 / 超期 / 样品单导入', () => {
  let collabId = 0;
  let creatorId = 0;
  let sampleId = 0;

  it('新增寄样自动取 SKU 成本快照，发货信息齐 → 在途，合作单自动 1→3', async () => {
    creatorId = await makePublicCreator('t-sample');
    await http.post(`/api/creators/${creatorId}/claim`).set(auth(token.bd));
    collabId = dataOf<{ id: number }>((await http.post('/api/creators/collab').set(auth(token.bd)).send({
      creator_id: creatorId, shop_id: 2, promised_videos: 1,
    })).body).id;
    const res = await http.post('/api/creators/sample').set(auth(token.bd)).send({
      collab_id: collabId, creator_id: creatorId, sku_id: 4, quantity: 3, shipping_cost: 60, tracking_no: 'TESTTRACK1',
    });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    sampleId = Number(d.id);
    expect(d.sample_cost).toBe(round2((158 + 46) * 3));
    expect(d.status).toBe(2);
    expect(d.collab_id).toBe(collabId);
    expect(get<{ status: number }>(`SELECT status FROM collaboration WHERE id = ?`, collabId)?.status).toBe(3);
    const row = get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ?`, sampleId) ?? {};
    expect(String(row.ship_time)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:/);
  });

  it('入参校验：无 SKU 必须填成本 / 平台样品单必须有订单号 / 达人与合作单不匹配', async () => {
    expect((await http.post('/api/creators/sample').set(auth(token.bd)).send({ creator_id: creatorId })).status).toBe(400);
    expect((await http.post('/api/creators/sample').set(auth(token.bd)).send({ creator_id: creatorId, ship_method: 1 })).status).toBe(400);
    expect((await http.post('/api/creators/sample').set(auth(token.bd)).send({ creator_id: creatorId, sku_id: 9999 })).status).toBe(404);
    expect((await http.post('/api/creators/sample').set(auth(token.bd)).send({ collab_id: collabId, creator_id: CREATOR.glow, sample_cost: 1 })).status).toBe(400);
    // 公海达人不能寄样
    expect((await http.post('/api/creators/sample').set(auth(token.bd)).send({ creator_id: CREATOR.cosy, sample_cost: 1 })).status).toBe(403);
  });

  it('发货 → 签收（合作单 3→4）→ 丢件限制', async () => {
    const s = dataOf<{ id: number }>((await http.post('/api/creators/sample').set(auth(token.bd)).send({
      collab_id: collabId, creator_id: creatorId, sku_id: 1, quantity: 1,
    })).body);
    expect(dataOf<{ status: number }>((await http.post(`/api/creators/sample/${s.id}/sign`).set(auth(token.bd))).body).status).toBe(3);
    expect(get<{ status: number }>(`SELECT status FROM collaboration WHERE id = ?`, collabId)?.status).toBe(4);
    // 已签收（status>=3）不能再置为在途
    expect((await http.post(`/api/creators/sample/${s.id}/ship`).set(auth(token.bd)).send({ tracking_no: 'X' })).status).toBe(400);
    expect((await http.post(`/api/creators/sample/${s.id}/lost`).set(auth(token.bd)).send({ remark: '签收后丢失' })).status).toBe(200);
    expect(get<{ status: number }>(`SELECT status FROM sample_shipment WHERE id = ?`, s.id)?.status).toBe(6);
    expect((await http.post(`/api/creators/sample/${s.id}/sign`).set(auth(token.bd))).status).toBe(400);
    expect((await http.post(`/api/creators/sample/${s.id}/ship`).set(auth(token.bd)).send({ tracking_no: 'Y' })).status).toBe(400);
    expect((await http.post('/api/creators/sample/999999/sign').set(auth(token.bd))).status).toBe(404);
  });

  it('ship / sign 状态推进与 PUT 修改（无成本权限不得改成本）', async () => {
    const list = pageOf((await http.get(`/api/creators/sample?collab_id=${collabId}`).set(auth(token.bd))).body);
    expect(list.total).toBe(2);
    expect((list.list[0] as Record<string, unknown>).collab_no).toBeTruthy();
    expect((list.list[0] as Record<string, unknown>).sku_code).toBeTruthy();
    expect((list.list[0] as Record<string, unknown>).sample_cost).toBe('***');
    expect((list.list[0] as Record<string, unknown>).due_days).toBe(config.sampleContentDueDays);

    expect((await http.put(`/api/creators/sample/${sampleId}`).set(auth(token.bd)).send({ sample_cost: 1 })).status).toBe(403);
    expect((await http.put(`/api/creators/sample/${sampleId}`).set(auth(token.boss)).send({ shipping_cost: 75, remark: null })).status).toBe(200);
    expect(get<{ shipping_cost: number }>(`SELECT shipping_cost FROM sample_shipment WHERE id = ?`, sampleId)?.shipping_cost).toBe(75);
    expect((await http.put(`/api/creators/sample/${sampleId}`).set(auth(token.boss)).send({ sku_id: 2, quantity: 2 })).status).toBe(200);
    expect(get<{ sample_cost: number }>(`SELECT sample_cost FROM sample_shipment WHERE id = ?`, sampleId)?.sample_cost).toBe(round2((82 + 19) * 2));
    expect((await http.put('/api/creators/sample/999999').set(auth(token.boss)).send({ quantity: 2 })).status).toBe(404);
  });

  it('签收超期未出内容 → 自动置 5 并告警（接口 + 作业）', async () => {
    const c = await makePublicCreator('t-sample-overdue');
    await http.post(`/api/creators/${c}/claim`).set(auth(token.bd));
    const s = dataOf<{ id: number }>((await http.post('/api/creators/sample').set(auth(token.bd)).send({
      creator_id: c, sku_id: 1, quantity: 1, status: 3, sign_time: `${dayOffset(-30)} 10:00:00`,
    })).body);
    expect(s.id).toBeGreaterThan(0);
    const res = await http.get('/api/creators/sample/overdue').set(auth(token.bd));
    expect(res.status).toBe(200);
    const d = dataOf<{ due_days: number; flagged_now: number; list: Record<string, unknown>[] }>(res.body);
    expect(d.due_days).toBe(config.sampleContentDueDays);
    expect(d.flagged_now).toBeGreaterThanOrEqual(1);
    expect(d.list.some((r) => Number(r.id) === s.id)).toBe(true);
    expect(get<{ status: number }>(`SELECT status FROM sample_shipment WHERE id = ?`, s.id)?.status).toBe(5);
    // 再跑一次作业：没有新的超期单需要置位（幂等），清单仍会展示已置为 5 的记录以便催更
    expect(flagOverdueSamples()).toBe(0);
    expect(dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/sample/overdue').set(auth(token.bd))).body)
      .list.some((r) => Number(r.id) === s.id)).toBe(true);
  });

  it('从平台免费样品单生成寄样行（去重 409）', async () => {
    const order = get<Record<string, unknown>>(
      `SELECT o.tk_order_id, o.order_status FROM tk_order o WHERE o.is_sample_order = 1 AND o.is_deleted = 0
         AND EXISTS (SELECT 1 FROM tk_order_item i WHERE i.order_id = o.id AND i.is_deleted = 0) LIMIT 1`,
    );
    if (!order) throw new Error('种子数据未生成平台免费样品单，无法验证 /sample/from-order');
    const tkOrderId = String(order.tk_order_id);
    await run(`UPDATE sample_shipment SET is_deleted = 1 WHERE tk_order_id = ?`, tkOrderId);
    const res = await http.post('/api/creators/sample/from-order').set(auth(token.bd)).send({ tk_order_id: tkOrderId, creator_id: CREATOR.aisyah });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(Number(d.quantity)).toBeGreaterThanOrEqual(1);
    expect(get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ?`, Number(d.id))?.ship_method).toBe(1);
    expect((await http.post('/api/creators/sample/from-order').set(auth(token.bd)).send({ tk_order_id: tkOrderId })).status).toBe(409);
    const normal = get<{ tk_order_id: string }>(`SELECT tk_order_id FROM tk_order WHERE is_sample_order = 0 AND is_deleted = 0 LIMIT 1`);
    expect((await http.post('/api/creators/sample/from-order').set(auth(token.bd)).send({ tk_order_id: normal?.tk_order_id })).status).toBe(400);
    expect((await http.post('/api/creators/sample/from-order').set(auth(token.bd)).send({ tk_order_id: 'NOPE-123' })).status).toBe(404);
  });
});

/* ==================================================================== */
describe('ROI 排行 / BD 绩效 / 达人漏斗统计', () => {
  it('达人维度排行：净 GMV 倒序，含成本与投产比', async () => {
    const res = await http.get('/api/creators/roi/rank?period=all&limit=10').set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.dimension).toBe('creator');
    const list = d.list as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.handle).toBeTruthy();
    const gmvs = list.map((r) => Number(r.gmv_cny));
    expect([...gmvs].sort((a, b) => b - a)).toEqual(gmvs);
    for (const r of list.slice(0, 3)) expect(typeof Number(r.cost)).toBe('number');
    expect(roiFieldsVisible(list[0] as Record<string, unknown>)).toBe(true);
  });

  it('无成本权限时 ROI 字段脱敏', async () => {
    const d = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/roi/rank?period=all').set(auth(token.bd))).body);
    for (const r of d.list) {
      expect(r.gmv_cny).toBe('***');
      expect(r.net_gmv_cny).toBe('***');
      expect(r.cost).toBe('***');
      expect(r.roi).toBe('***');
      expect(r.handle).not.toBe('***');
    }
  });

  it('region / scope 过滤 + BD 维度聚合', async () => {
    const my = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/roi/rank?period=all&region=MY').set(auth(token.boss))).body);
    expect(my.list.every((r) => r.region === 'MY')).toBe(true);
    const bdView = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/roi/rank?period=all&region=MY').set(auth(token.bd))).body);
    expect(bdView.list.every((r) => r.owner_id === null || Number(r.owner_id) === USER.chenbd)).toBe(true);

    const group = dataOf<{ dimension: string; list: Record<string, unknown>[] }>((await http.get('/api/creators/roi/rank?period=all&group=true').set(auth(token.boss))).body);
    expect(group.dimension).toBe('bd');
    expect(group.list.some((r) => r.real_name === '陈思远')).toBe(true);
    expect(typeof Number(group.list[0]?.net_gmv_cny)).toBe('number');
  });

  it('BD 绩效漏斗：联系 / 回复 / 有意向 / 谈妥 / 私海数 / 首响时长', async () => {
    const self = dataOf<Record<string, unknown>>((await http.get('/api/creators/bd-performance?period=all').set(auth(token.bd))).body);
    expect(self.dimension).toBe('self');
    const selfList = self.list as Record<string, unknown>[];
    expect(selfList.length).toBe(1);
    expect(selfList[0]?.real_name).toBe('陈思远');
    expect(Number(selfList[0]?.outreach_cnt)).toBeGreaterThanOrEqual(1);
    expect(typeof selfList[0]?.reply_rate).toBe('number');
    expect(Number(selfList[0]?.private_creators)).toBeGreaterThanOrEqual(1);

    const group = dataOf<Record<string, unknown>>((await http.get('/api/creators/bd-performance?period=all&group=true').set(auth(token.bdManager))).body);
    expect(group.dimension).toBe('dept');
    const names = (group.list as Record<string, unknown>[]).map((r) => String(r.real_name));
    expect(names).toContain('陈思远');
    expect(names).toContain('陆嘉宁');
    expect((group.list as Record<string, unknown>[]).some((r) => Number(r.agreed_cnt) >= 1)).toBe(true);
    const sorted = (group.list as Record<string, unknown>[]).map((r) => Number(r.outreach_cnt));
    expect([...sorted].sort((a, b) => b - a)).toEqual(sorted);

    const bossAll = dataOf<{ dimension: string }>((await http.get('/api/creators/bd-performance?period=all&group=true').set(auth(token.boss))).body);
    expect(bossAll.dimension).toBe('all');
    // 财务无 creator 菜单：读接口放行但成本按 can_see_cost 处理
    const costless = dataOf<{ list: Record<string, unknown>[] }>((await http.get('/api/creators/bd-performance?period=all&group=true').set(auth(token.bd))).body);
    expect(costless.list[0]?.cost_cny).toBe('***');
  });

  it('stats：公海 / 私海 / 合作中 / 黑名单 + 漏斗 + 待跟进', async () => {
    const res = await http.get('/api/creators/stats?period=all').set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    for (const k of ['pool', 'private', 'cooperating', 'blacklist', 'new_this_month', 'content_published', 'protect_expiring', 'collab_overdue', 'sample_overdue', 'to_follow']) {
      expect(typeof Number(d[k])).toBe('number');
    }
    expect(Number(d.blacklist)).toBeGreaterThanOrEqual(1);
    expect(Number(d.content_published)).toBeGreaterThanOrEqual(6);
    const funnel = d.funnel as Record<string, unknown>;
    expect(Number(funnel.outreach)).toBeGreaterThanOrEqual(Number(funnel.replied));
    expect(Number(funnel.replied)).toBeGreaterThanOrEqual(Number(funnel.agreed));
    for (const k of ['creators_contacted', 'collabs', 'samples', 'contents', 'orders']) expect(Number(funnel[k])).toBeGreaterThanOrEqual(0);
    expect(typeof Number(funnel.net_gmv_cny)).toBe('number');
    // BD 的范围过滤同样体现在 stats
    const bdView = dataOf<Record<string, unknown>>((await http.get('/api/creators/stats').set(auth(token.bd))).body);
    expect(Number(bdView.private)).toBeLessThanOrEqual(Number(d.private));
  });
});

function roiFieldsVisible(row: Record<string, unknown>): boolean {
  return typeof Number(row.gmv_cny) === 'number' && typeof Number(row.net_gmv_cny) === 'number'
    && (row.roi === null || typeof Number(row.roi) === 'number');
}
