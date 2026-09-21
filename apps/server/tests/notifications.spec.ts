import { beforeAll, describe, expect, it } from 'vitest';
import { get, insert } from '../src/core/db.js';
import { reconcileDueAlertNotifications } from '../src/services/notifications.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

const { http } = boot();
const tokens: Record<string, string> = {};

const userId = (username: string): number => Number(get<{ id: number }>('SELECT id FROM sys_user WHERE username = ?', username)?.id ?? 0);
const createDueEvent = (opts: { target: string; owner: number; shopId?: number | null; dueAt?: string }): number => {
  const ruleId = Number(get<{ id: number }>('SELECT id FROM alert_rule ORDER BY id LIMIT 1')?.id ?? 0);
  return insert('alert_event', {
    rule_id: ruleId,
    target_type: 'creator',
    target_name: opts.target,
    shop_id: opts.shopId ?? null,
    detected_at: '2000-01-01 00:00:00',
    evidence_json: JSON.stringify({ roas: 1.2, ad_spend: 98765.43, cost: 12345.67 }),
    priority: 1,
    status: 0,
    owner_id: opts.owner,
    due_at: opts.dueAt ?? '2000-01-02 00:00:00',
    created_by: opts.owner,
  });
};

beforeAll(async () => {
  for (const [key, username] of Object.entries(ACCOUNTS)) tokens[key] = await login(http, username);
});

describe('个人到期提醒', () => {
  it('按收件人和事件范围隔离，API 不返回预警证据或成本数据', async () => {
    const eventId = createDueEvent({ target: 'notification-recipient-check', owner: userId('chenbd') });
    const result = reconcileDueAlertNotifications(new Date('2026-09-20T12:00:00Z'), eventId);
    expect(result.created).toBe(1);

    const own = await http.get('/api/actions/notifications').set(auth(tokens.bd));
    expect(own.status).toBe(200);
    const ownData = dataOf<{ list: { id: number; alert_event_id: number; read_at: string | null }[]; unread_total: number }>(own.body);
    const notification = ownData.list.find((item) => item.alert_event_id === eventId);
    expect(notification).toBeTruthy();
    expect(ownData.unread_total).toBeGreaterThan(0);
    expect(JSON.stringify(own.body)).not.toContain('evidence');
    expect(JSON.stringify(own.body)).not.toContain('12345.67');
    expect(JSON.stringify(own.body)).not.toContain('98765.43');

    const boss = await http.get('/api/actions/notifications').set(auth(tokens.boss));
    expect(dataOf<{ list: { alert_event_id: number }[] }>(boss.body).list.some((item) => item.alert_event_id === eventId)).toBe(false);
    const crossedRead = await http.post(`/api/actions/notifications/${notification!.id}/read`).set(auth(tokens.boss)).send({});
    expect(crossedRead.status).toBe(404);

    const read = await http.post(`/api/actions/notifications/${notification!.id}/read`).set(auth(tokens.bd)).send({});
    expect(read.status).toBe(200);
    expect(dataOf<{ read_at: string }>(read.body).read_at).toBeTruthy();
    const idempotentRead = await http.post(`/api/actions/notifications/${notification!.id}/read`).set(auth(tokens.bd)).send({});
    expect(idempotentRead.status).toBe(200);
  });

  it('重复跑提醒任务只创建一条，并在转派和闭环时立即使旧通知失效', async () => {
    const bdId = userId('chenbd');
    const bd2Id = userId('lubd');
    const eventId = createDueEvent({ target: 'notification-transfer-check', owner: bdId });
    expect(reconcileDueAlertNotifications(new Date('2026-09-20T12:00:00Z'), eventId).created).toBe(1);
    expect(reconcileDueAlertNotifications(new Date('2026-09-20T12:01:00Z'), eventId).created).toBe(0);
    const original = get<{ id: number; stale_at: string | null }>(
      'SELECT id, stale_at FROM user_notification WHERE alert_event_id = ? AND recipient_id = ?', eventId, bdId,
    );
    expect(original?.stale_at).toBeNull();

    const transfer = await http.post(`/api/actions/events/${eventId}/handle`).set(auth(tokens.boss)).send({ action_type: 'transfer', owner_id: bd2Id });
    expect(transfer.status).toBe(200);
    expect(get<{ stale_at: string | null }>('SELECT stale_at FROM user_notification WHERE id = ?', original!.id)?.stale_at).toBeTruthy();

    const bd2Inbox = await http.get('/api/actions/notifications').set(auth(tokens.bd2));
    const transferred = dataOf<{ list: { id: number; alert_event_id: number }[] }>(bd2Inbox.body).list.find((item) => item.alert_event_id === eventId);
    expect(transferred).toBeTruthy();
    expect(transferred!.id).not.toBe(original!.id);

    const close = await http.post(`/api/actions/events/${eventId}/handle`).set(auth(tokens.bd2)).send({ action_type: 'handle', note: 'closed' });
    expect(close.status).toBe(200);
    expect(get<{ stale_at: string | null }>('SELECT stale_at FROM user_notification WHERE id = ?', transferred!.id)?.stale_at).toBeTruthy();
    const staleRead = await http.post(`/api/actions/notifications/${transferred!.id}/read`).set(auth(tokens.bd2)).send({});
    expect(staleRead.status).toBe(404);
  });

  it('不以收件人身份绕过预警店铺范围', async () => {
    const limyId = userId('limy');
    const otherShop = Number(get<{ id: number }>("SELECT id FROM tk_shop WHERE shop_name = 'HYGGE PH Official'")?.id ?? 0);
    expect(otherShop).toBeGreaterThan(0);
    const eventId = createDueEvent({ target: 'notification-scope-check', owner: limyId, shopId: otherShop });
    reconcileDueAlertNotifications(new Date('2026-09-20T12:00:00Z'), eventId);
    const inbox = await http.get('/api/actions/notifications').set(auth(tokens.ops));
    expect(inbox.status).toBe(200);
    const notification = get<{ id: number }>('SELECT id FROM user_notification WHERE alert_event_id = ? AND recipient_id = ?', eventId, limyId);
    expect(notification).toBeTruthy();
    expect(dataOf<{ list: { alert_event_id: number }[] }>(inbox.body).list.some((item) => item.alert_event_id === eventId)).toBe(false);
    const crossedScopeRead = await http.post(`/api/actions/notifications/${notification!.id}/read`).set(auth(tokens.ops)).send({});
    expect(crossedScopeRead.status).toBe(404);
  });

  it('确保 migration 已建用户通知表及去重索引', () => {
    expect(get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_notification'")?.name).toBe('user_notification');
    expect(get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_user_notification_dedupe'")?.name).toBe('ux_user_notification_dedupe');
    expect(get<{ c: number }>("SELECT COUNT(*) AS c FROM schema_migration WHERE version = '2026-09-20-user-due-notifications-v1'")?.c).toBe(1);
  });
});
