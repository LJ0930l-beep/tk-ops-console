import { beforeAll, describe, expect, it } from 'vitest';
import { get, insert, run } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

const { http } = boot();
const tokens: Record<string, string> = {};

const idFor = (username: string): number => Number(get<{ id: number }>('SELECT id FROM sys_user WHERE username = ?', username)?.id ?? 0);

function seedEvent(input: { ruleCode: string; shopId: number | null; ownerId: number; name: string; evidence?: Record<string, unknown> }): number {
  const rule = get<{ id: number }>('SELECT id FROM alert_rule WHERE rule_code = ?', input.ruleCode);
  if (!rule) throw new Error(`missing rule ${input.ruleCode}`);
  return insert('alert_event', {
    rule_id: Number(rule.id),
    target_type: input.ruleCode === 'ADS_LOSS' ? 'ads' : 'product',
    target_id: input.shopId,
    target_name: input.name,
    shop_id: input.shopId,
    evidence_json: JSON.stringify(input.evidence ?? {}),
    priority: 1,
    status: 0,
    owner_id: input.ownerId,
  });
}

beforeAll(async () => {
  for (const [key, username] of Object.entries(ACCOUNTS)) tokens[key] = await login(http, username);
});

describe('行动中心店铺范围与敏感证据', () => {
  it('部门范围在撤销唯一团队店铺映射后立即失效', async () => {
    const managerId = idFor(ACCOUNTS.opsManager);
    const mapping = get<{ shop_id: number; user_id: number }>(
      `SELECT us.shop_id, us.user_id FROM sys_user_shop us
         JOIN sys_user member ON member.id = us.user_id AND member.status = 1 AND member.is_deleted = 0
         JOIN tk_shop shop ON shop.id = us.shop_id AND shop.is_deleted = 0
        WHERE us.is_deleted = 0 AND member.dept = (SELECT dept FROM sys_user WHERE id = ?)
        GROUP BY us.shop_id HAVING COUNT(DISTINCT member.id) = 1 ORDER BY us.shop_id LIMIT 1`,
      managerId,
    );
    expect(mapping).toBeTruthy();
    const eventId = seedEvent({
      ruleCode: 'CHANNEL_DEPENDENCY',
      shopId: Number(mapping!.shop_id),
      ownerId: idFor(ACCOUNTS.boss),
      name: `AUDIT_REVOKED_MAPPING_${Date.now()}`,
    });

    run(`UPDATE sys_user_shop SET is_deleted = 1 WHERE user_id = ? AND shop_id = ? AND is_deleted = 0`, mapping!.user_id, mapping!.shop_id);
    const eventList = await http.get('/api/actions/events').set(auth(tokens.opsManager));
    const analytics = await http.get('/api/actions/analytics/shop-channel').set(auth(tokens.opsManager)).query({ shop_id: mapping!.shop_id, weeks: 1 });
    expect(dataOf<{ list: { id: number }[] }>(eventList.body).list.some((row) => row.id === eventId)).toBe(false);
    expect(analytics.status).toBe(404);
  });

  it('店铺范围用户仅能查看负责人是本人的无店铺预警', async () => {
    const ownEvent = seedEvent({
      ruleCode: 'CHANNEL_DEPENDENCY', shopId: null, ownerId: idFor(ACCOUNTS.ops), name: `AUDIT_OWN_UNSCOPED_${Date.now()}`,
    });
    const unassignedEvent = seedEvent({
      ruleCode: 'CHANNEL_DEPENDENCY', shopId: null, ownerId: idFor(ACCOUNTS.boss), name: `AUDIT_UNASSIGNED_UNSCOPED_${Date.now()}`,
    });

    expect((await http.get(`/api/actions/events/${ownEvent}`).set(auth(tokens.ops))).status).toBe(200);
    expect((await http.get(`/api/actions/events/${unassignedEvent}`).set(auth(tokens.ops))).status).toBe(404);
  });

  it('跨店事件和回看记录在列表、详情、处理、结果与首页中均不可见', async () => {
    const opsId = idFor(ACCOUNTS.ops);
    const managerId = idFor(ACCOUNTS.opsManager);
    const bossId = idFor(ACCOUNTS.boss);
    const visibleShop = get<{ id: number }>(
      `SELECT s.id FROM tk_shop s JOIN sys_user_shop us ON us.shop_id = s.id
        WHERE us.user_id = ? AND us.is_deleted = 0 AND s.is_deleted = 0 ORDER BY s.id LIMIT 1`,
      opsId,
    );
    const outsideShop = get<{ id: number }>(
      `SELECT s.id FROM tk_shop s WHERE s.is_deleted = 0
        AND NOT EXISTS (SELECT 1 FROM sys_user_shop us WHERE us.user_id = ? AND us.shop_id = s.id AND us.is_deleted = 0)
        AND NOT EXISTS (SELECT 1 FROM sys_user_shop us JOIN sys_user member ON member.id = us.user_id
                         WHERE us.shop_id = s.id AND us.is_deleted = 0
                           AND member.dept = (SELECT dept FROM sys_user WHERE id = ?))
        ORDER BY s.id LIMIT 1`,
      opsId,
      managerId,
    );
    expect(visibleShop).toBeTruthy();
    expect(outsideShop).toBeTruthy();

    const foreignName = `AUDIT_FOREIGN_${Date.now()}`;
    const foreignId = seedEvent({ ruleCode: 'CHANNEL_DEPENDENCY', shopId: Number(outsideShop!.id), ownerId: bossId, name: foreignName });
    const handled = await http.post(`/api/actions/events/${foreignId}/handle`).set(auth(tokens.boss)).send({
      action_type: 'handle',
      note: 'AUDIT_FOREIGN_ACTION_NOTE',
      expected_result: 'AUDIT_FOREIGN_EXPECTED_RESULT',
      observe_until: '2020-01-01',
    });
    expect(handled.status).toBe(200);
    const actionId = Number(dataOf<{ action_id: number }>(handled.body).action_id);
    run(`UPDATE action_result SET result = 'improved', note = 'AUDIT_FOREIGN_RESULT_NOTE' WHERE action_id = ?`, actionId);

    const eventList = await http.get('/api/actions/events').set(auth(tokens.ops));
    expect(eventList.status).toBe(200);
    expect(dataOf<{ list: { id: number; target_name: string }[] }>(eventList.body).list.some((row) => row.id === foreignId || row.target_name === foreignName)).toBe(false);
    expect((await http.get(`/api/actions/events/${foreignId}`).set(auth(tokens.ops))).status).toBe(404);
    expect((await http.post(`/api/actions/events/${foreignId}/handle`).set(auth(tokens.ops)).send({ action_type: 'ignore' })).status).toBe(404);
    expect((await http.get(`/api/actions/analytics/shop-channel?shop_id=${outsideShop!.id}`).set(auth(tokens.ops))).status).toBe(404);
    expect((await http.get(`/api/actions/analytics/abc?shop_id=${outsideShop!.id}`).set(auth(tokens.ops))).status).toBe(404);

    const results = await http.get('/api/actions/results').set(auth(tokens.ops));
    expect(results.status).toBe(200);
    expect(JSON.stringify(results.body)).not.toContain('AUDIT_FOREIGN');
    const today = await http.get('/api/actions/today').set(auth(tokens.ops));
    expect(today.status).toBe(200);
    expect(JSON.stringify(dataOf(today.body).recent_results)).not.toContain('AUDIT_FOREIGN');

    const managerList = await http.get('/api/actions/events').set(auth(tokens.opsManager));
    expect(managerList.status).toBe(200);
    expect(dataOf<{ list: { id: number }[] }>(managerList.body).list.some((row) => row.id === foreignId)).toBe(false);
  });

  it('无成本权限的用户看不到广告亏损预警中的花费、毛利与结果快照', async () => {
    const shopId = Number(get<{ id: number }>(
      `SELECT s.id FROM tk_shop s JOIN sys_user_shop us ON us.shop_id = s.id
        WHERE us.user_id = ? AND us.is_deleted = 0 ORDER BY s.id LIMIT 1`,
      idFor(ACCOUNTS.ops),
    )?.id);
    const eventId = seedEvent({
      ruleCode: 'ADS_LOSS',
      shopId,
      ownerId: idFor(ACCOUNTS.boss),
      name: `AUDIT_COST_${Date.now()}`,
      evidence: {
        rule: 'ADS_LOSS',
        spend_cny: 321.5,
        attributed_gmv_cny: 1000,
        roas: 3.11,
        contribution_margin: 0.24,
        breakeven_roas: 4.16,
        margin_note: 'derived from product costs',
      },
    });
    const handled = await http.post(`/api/actions/events/${eventId}/handle`).set(auth(tokens.boss)).send({
      action_type: 'handle',
      note: 'AUDIT_PRIVATE_COST_NOTE',
      expected_result: 'AUDIT_PRIVATE_COST_EXPECTATION',
      observe_until: '2020-01-01',
    });
    expect(handled.status).toBe(200);
    const actionId = Number(dataOf<{ action_id: number }>(handled.body).action_id);
    run(`UPDATE action_result SET result = 'improved', note = 'AUDIT_PRIVATE_RESULT_NOTE' WHERE action_id = ?`, actionId);

    const detail = await http.get(`/api/actions/events/${eventId}`).set(auth(tokens.ops));
    expect(detail.status).toBe(200);
    const detailData = dataOf<{ evidence: Record<string, unknown>; actions: Record<string, unknown>[] }>(detail.body);
    expect(detailData.evidence).toMatchObject({ rule: 'ADS_LOSS', redacted: true });
    for (const key of ['spend_cny', 'attributed_gmv_cny', 'roas', 'contribution_margin', 'breakeven_roas', 'margin_note']) {
      expect(detailData.evidence).not.toHaveProperty(key);
    }
    expect(detailData.actions[0]?.note).toBe('***');
    expect(detailData.actions[0]?.expected_result).toBe('***');
    expect(detailData.actions[0]?.before_json).toBe('{"redacted":true}');

    const results = await http.get('/api/actions/results').set(auth(tokens.ops));
    const resultItem = dataOf<{ list: Record<string, unknown>[] }>(results.body).list.find((row) => Number(row.action_id) === actionId);
    expect(resultItem).toBeTruthy();
    expect(resultItem?.action_note).toBe('***');
    expect(resultItem?.note).toBe('***');
    expect(resultItem?.before_json).toBe('{"redacted":true}');

    const eventList = await http.get('/api/actions/events').set(auth(tokens.ops));
    const event = dataOf<{ list: { id: number; evidence: Record<string, unknown> }[] }>(eventList.body).list.find((row) => row.id === eventId);
    expect(event?.evidence).toMatchObject({ rule: 'ADS_LOSS', redacted: true });

    const today = await http.get('/api/actions/today').set(auth(tokens.ops));
    const recent = dataOf<{ recent_results: Record<string, unknown>[] }>(today.body).recent_results.find((row) => Number(row.id) === Number(resultItem?.id));
    expect(recent?.note).toBe('***');
    expect(recent?.before_json).toBe('{"redacted":true}');
  });

  it('店铺角色可以转派给同店在职成员，但不能跨店转派', async () => {
    const shopId = Number(get<{ id: number }>(
      `SELECT s.id FROM tk_shop s JOIN sys_user_shop us ON us.shop_id = s.id
        WHERE us.user_id = ? AND us.is_deleted = 0 ORDER BY s.id LIMIT 1`,
      idFor(ACCOUNTS.ops),
    )?.id);
    const sameShopMember = get<{ id: number }>(
      `SELECT u.id FROM sys_user u JOIN sys_user_shop us ON us.user_id = u.id
        WHERE us.shop_id = ? AND us.is_deleted = 0 AND u.status = 1 AND u.is_deleted = 0 AND u.id <> ? LIMIT 1`,
      shopId,
      idFor(ACCOUNTS.ops),
    );
    const otherShopMember = get<{ id: number }>(
      `SELECT u.id FROM sys_user u WHERE u.status = 1 AND u.is_deleted = 0 AND u.id <> ?
        AND NOT EXISTS (SELECT 1 FROM sys_user_shop us WHERE us.user_id = u.id AND us.shop_id = ? AND us.is_deleted = 0)
        LIMIT 1`,
      idFor(ACCOUNTS.ops),
      shopId,
    );
    expect(sameShopMember).toBeTruthy();
    expect(otherShopMember).toBeTruthy();

    const canTransfer = seedEvent({ ruleCode: 'CHANNEL_DEPENDENCY', shopId, ownerId: idFor(ACCOUNTS.ops), name: `AUDIT_TRANSFER_OK_${Date.now()}` });
    const allowed = await http.post(`/api/actions/events/${canTransfer}/handle`).set(auth(tokens.ops)).send({ action_type: 'transfer', owner_id: Number(sameShopMember!.id) });
    expect(allowed.status).toBe(200);

    const cannotTransfer = seedEvent({ ruleCode: 'CHANNEL_DEPENDENCY', shopId, ownerId: idFor(ACCOUNTS.ops), name: `AUDIT_TRANSFER_DENY_${Date.now()}` });
    const denied = await http.post(`/api/actions/events/${cannotTransfer}/handle`).set(auth(tokens.ops)).send({ action_type: 'transfer', owner_id: Number(otherShopMember!.id) });
    expect(denied.status).toBe(403);
  });

  it('允许转派的操作者仍不能把预警交给看不到该店的成员', async () => {
    const opsId = idFor(ACCOUNTS.ops);
    const bossId = idFor(ACCOUNTS.boss);
    const outsideShop = get<{ id: number }>(
      `SELECT s.id FROM tk_shop s WHERE s.is_deleted = 0
         AND NOT EXISTS (SELECT 1 FROM sys_user_shop us WHERE us.user_id = ? AND us.shop_id = s.id AND us.is_deleted = 0)
       ORDER BY s.id LIMIT 1`,
      opsId,
    );
    expect(outsideShop).toBeTruthy();
    const eventId = seedEvent({
      ruleCode: 'CHANNEL_DEPENDENCY',
      shopId: Number(outsideShop!.id),
      ownerId: bossId,
      name: `AUDIT_UNREADABLE_RECIPIENT_${Date.now()}`,
    });

    const denied = await http.post(`/api/actions/events/${eventId}/handle`).set(auth(tokens.boss)).send({
      action_type: 'transfer', owner_id: opsId,
    });
    expect(denied.status).toBe(403);
    expect(Number(get<{ owner_id: number }>('SELECT owner_id FROM alert_event WHERE id = ?', eventId)?.owner_id)).toBe(bossId);
  });
});

describe('分析与 CRM 待办的范围一致性', () => {
  it('广告花费按成本权限脱敏，直播分钟沿用内容模块的场次范围', async () => {
    const opsId = idFor(ACCOUNTS.ops);
    const managerId = idFor(ACCOUNTS.opsManager);
    const bossId = idFor(ACCOUNTS.boss);
    const shopId = Number(get<{ id: number }>(`SELECT shop_id AS id FROM sys_user_shop WHERE user_id = ? AND is_deleted = 0 ORDER BY shop_id LIMIT 1`, opsId)?.id);
    const otherShopId = Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 AND id NOT IN (SELECT shop_id FROM sys_user_shop WHERE user_id = ? AND is_deleted = 0) ORDER BY id LIMIT 1`, opsId)?.id);
    expect(shopId).toBeGreaterThan(0);
    expect(otherShopId).toBeGreaterThan(0);

    const today = new Date().toISOString().slice(0, 10);
    const channel = `audit_private_spend_${Date.now()}`;
    insert('analytics_shop_channel_daily', { stat_date: today, shop_id: shopId, channel, gmv: 1000, net_gmv: 1000, ad_spend: 88 });
    insert('ad_daily', { stat_date: today, shop_id: shopId, campaign_id: channel, ad_type: 1, spend: 88, currency: 'USD', gmv: 300 });
    const channels = await http.get('/api/actions/analytics/shop-channel').set(auth(tokens.ops)).query({ shop_id: shopId, weeks: 1, end: today });
    expect(channels.status).toBe(200);
    const matching = dataOf<{ channels: Record<string, { ad_spend: number | null }> }[]>(channels.body)
      .map((week) => week.channels[channel])
      .filter((row): row is { ad_spend: number | null } => !!row);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.ad_spend).toBeNull();

    const dashboard = await http.get('/api/dashboard/summary').set(auth(tokens.ops)).query({ start: today, end: today });
    expect(dashboard.status).toBe(200);
    const summary = dataOf<{ ad_spend: number | null; ad_roi: number | null; ad_gmv: number }>(dashboard.body);
    expect(summary.ad_spend).toBeNull();
    expect(summary.ad_roi).toBeNull();

    const shopScopeCreatedSession = insert('live_session', { shop_id: otherShopId, created_by: opsId });
    expect((await http.get(`/api/actions/analytics/live/${shopScopeCreatedSession}/minutes`).set(auth(tokens.ops))).status).toBe(404);

    const managerShop = Number(get<{ id: number }>(
      `SELECT DISTINCT s.id FROM tk_shop s JOIN sys_user_shop us ON us.shop_id = s.id AND us.is_deleted = 0
         JOIN sys_user member ON member.id = us.user_id WHERE member.dept = (SELECT dept FROM sys_user WHERE id = ?)
           AND s.is_deleted = 0 ORDER BY s.id LIMIT 1`,
      managerId,
    )?.id);
    expect(managerShop).toBeGreaterThan(0);
    const outsideDeptParticipantSession = insert('live_session', { shop_id: managerShop, host_id: bossId, created_by: bossId });
    expect((await http.get(`/api/actions/analytics/live/${outsideDeptParticipantSession}/minutes`).set(auth(tokens.opsManager))).status).toBe(404);
  });

  it('达人跟进待办按记录 user_id、寄样待办按达人 owner 隔离', async () => {
    const bdId = idFor(ACCOUNTS.bd);
    const bd2Id = idFor(ACCOUNTS.bd2);
    const beforeBd = dataOf<{ creators_to_follow: number; samples_overdue: number }>((await http.get('/api/dashboard/todos').set(auth(tokens.bd))).body);
    const beforeBd2 = dataOf<{ creators_to_follow: number; samples_overdue: number }>((await http.get('/api/dashboard/todos').set(auth(tokens.bd2))).body);

    const handle = `audit-scope-${Date.now()}`;
    const creatorId = insert('creator', { handle, nickname: '审验隔离样本', owner_id: bd2Id, pool_status: 2 });
    const privateTracking = `AUDIT_PRIVATE_TRACKING_${Date.now()}`;
    insert('creator_outreach', {
      creator_id: creatorId,
      user_id: bdId,
      contact_time: '2000-01-01 00:00:00',
      summary: 'AUDIT_PRIVATE_OUTREACH_SUMMARY',
      next_follow_at: '2000-01-01 00:00:00',
    });
    insert('sample_shipment', {
      creator_id: creatorId,
      tracking_no: privateTracking,
      sign_time: '2000-01-01 00:00:00',
      status: 3,
    });

    const bdCounts = dataOf<{ creators_to_follow: number; samples_overdue: number }>((await http.get('/api/dashboard/todos').set(auth(tokens.bd))).body);
    const bd2Counts = dataOf<{ creators_to_follow: number; samples_overdue: number }>((await http.get('/api/dashboard/todos').set(auth(tokens.bd2))).body);
    expect(bdCounts.creators_to_follow).toBe(beforeBd.creators_to_follow + 1);
    expect(bdCounts.samples_overdue).toBe(beforeBd.samples_overdue);
    expect(bd2Counts.creators_to_follow).toBe(beforeBd2.creators_to_follow);
    expect(bd2Counts.samples_overdue).toBe(beforeBd2.samples_overdue + 1);

    const bdDetail = dataOf<{ groups: { key: string; items: { title: string; subtitle: string; hint: string }[] }[] }>(
      (await http.get('/api/dashboard/todos/detail').set(auth(tokens.bd))).body,
    );
    const bd2Detail = dataOf<{ groups: { key: string; items: { title: string; subtitle: string; hint: string }[] }[] }>(
      (await http.get('/api/dashboard/todos/detail').set(auth(tokens.bd2))).body,
    );
    const bdOutreach = bdDetail.groups.find((group) => group.key === 'creator_follow')?.items ?? [];
    const bd2Outreach = bd2Detail.groups.find((group) => group.key === 'creator_follow')?.items ?? [];
    const bdSamples = bdDetail.groups.find((group) => group.key === 'sample_overdue')?.items ?? [];
    const bd2Samples = bd2Detail.groups.find((group) => group.key === 'sample_overdue')?.items ?? [];
    expect(bdOutreach.some((item) => item.title === `@${handle}` && item.hint === 'AUDIT_PRIVATE_OUTREACH_SUMMARY')).toBe(true);
    expect(bd2Outreach.some((item) => item.title === `@${handle}`)).toBe(false);
    expect(bdSamples.some((item) => item.subtitle.includes(privateTracking))).toBe(false);
    expect(bd2Samples.some((item) => item.subtitle.includes(privateTracking))).toBe(true);
  });
});
