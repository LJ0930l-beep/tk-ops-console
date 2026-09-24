import { beforeAll, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/core/db.js';
import { DEFAULT_ALERT_RULES } from '@tk/shared';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

// 规则条数从 @tk/shared 的默认规则表推导，不再写死 —— 加规则的人不该顺手来改这个数
const RULES = DEFAULT_ALERT_RULES.length;

/**
 * V2.0 行动中心 + 规则引擎（§4/§14/§15.3/附录B）
 * 覆盖：默认规则落库 / 冷却去重 / 今日看板分级 / 处理-动作-效果回看闭环 /
 *       规则阈值配置化(版本+留痕) / 角色权限(运营只读、BD 仅本人) / 分析视图。
 */

const http = boot().http;
const token: Record<string, string> = {};

const userId = (username: string): number => Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, username)?.id ?? 0);
const ruleCount = (): number => Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM alert_rule WHERE is_deleted = 0`)?.c ?? 0);
const eventCount = (): number => Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM alert_event WHERE is_deleted = 0`)?.c ?? 0);
const firstOpenEvent = (exclude: number[] = []): { id: number; target_type: string } | undefined =>
  get<{ id: number; target_type: string }>(
    `SELECT id, target_type FROM alert_event WHERE is_deleted = 0 AND status IN (0,1) AND id NOT IN (${exclude.length ? exclude.join(',') : '0'}) ORDER BY id LIMIT 1`,
  );

beforeAll(async () => {
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(http, u);
});

describe('规则引擎：默认规则与冷却去重', () => {
  it('附录 B 的默认规则全部落库且启用', () => {
    expect(ruleCount()).toBe(RULES);
    const disabled = get<{ c: number }>(`SELECT COUNT(*) AS c FROM alert_rule WHERE status <> 1`)?.c ?? 0;
    expect(Number(disabled)).toBe(0);
    // 阈值不得写死：每条规则都有可配置的 metric/operator/threshold
    const bad = all<{ rule_code: string }>(`SELECT rule_code FROM alert_rule WHERE metric IS NULL OR operator IS NULL OR threshold IS NULL`);
    expect(bad).toHaveLength(0);
  });

  it('种子已跑过一轮评估，命中生成预警事件', () => {
    expect(eventCount()).toBeGreaterThan(0);
  });

  it('冷却期内重复评估不再重复刷屏（created_events=0）', async () => {
    const before = eventCount();
    const res = await http.post('/api/actions/evaluate').set(auth(token.boss)).send({});
    expect(res.status).toBe(200);
    const d = dataOf<{ created_events: number; skipped_cooldown: number; evaluated_rules: number }>(res.body);
    expect(d.evaluated_rules).toBe(RULES);
    expect(d.created_events).toBe(0);
    expect(eventCount()).toBe(before);
  });

  it('ensureDefaultRules 幂等：再评估不会新增/覆盖规则', async () => {
    await http.post('/api/actions/evaluate').set(auth(token.boss)).send({});
    expect(ruleCount()).toBe(RULES);
  });
});

describe('今日行动中心', () => {
  it('按 P0/P1/P2 分级返回，并附状态计数', async () => {
    const res = await http.get('/api/actions/today').set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<{ p0: { priority: number }[]; p1: { priority: number }[]; p2: { priority: number }[]; counts: Record<string, number> }>(res.body);
    expect(Array.isArray(d.p0)).toBe(true);
    expect(d.p0.every((e) => e.priority === 0)).toBe(true);
    expect(d.p1.every((e) => e.priority === 1)).toBe(true);
    expect(d.p2.every((e) => e.priority === 2)).toBe(true);
    expect(typeof d.counts).toBe('object');
  });

  it('事件详情返回解析后的证据与处理流水', async () => {
    const ev = firstOpenEvent();
    expect(ev).toBeTruthy();
    const res = await http.get(`/api/actions/events/${ev!.id}`).set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<{ id: number; evidence: Record<string, unknown>; actions: unknown[] }>(res.body);
    expect(d.id).toBe(ev!.id);
    expect(typeof d.evidence).toBe('object');
    expect(Array.isArray(d.actions)).toBe(true);
  });
});

describe('处理-动作-效果回看闭环', () => {
  it('handle：状态推进为已处理，落动作流水 + pending 效果回看快照', async () => {
    const ev = firstOpenEvent();
    expect(ev).toBeTruthy();
    const res = await http
      .post(`/api/actions/events/${ev!.id}/handle`)
      .set(auth(token.boss))
      .send({ action_type: 'handle', note: '暂停低效计划', expected_result: 'ROAS 回到盈亏线', observe_until: '2020-01-01' });
    expect(res.status).toBe(200);
    const d = dataOf<{ action_id: number; status: number }>(res.body);
    expect(d.status).toBe(2);

    expect(Number(get<{ status: number }>(`SELECT status FROM alert_event WHERE id = ?`, ev!.id)?.status)).toBe(2);
    const act = get<{ id: number; action_type: string }>(`SELECT id, action_type FROM operation_action WHERE id = ?`, d.action_id);
    expect(act?.action_type).toBe('handle');
    const ar = get<{ result: string; before_json: string }>(`SELECT result, before_json FROM action_result WHERE action_id = ?`, d.action_id);
    expect(ar?.result).toBe('pending');
    expect(String(ar?.before_json ?? '').length).toBeGreaterThan(2); // 有指标快照

    // 观察期已过（2020-01-01）→ 再评估应结算为非 pending
    const evalRes = await http.post('/api/actions/evaluate').set(auth(token.boss)).send({});
    expect(evalRes.status).toBe(200);
    const after = get<{ result: string }>(`SELECT result FROM action_result WHERE action_id = ?`, d.action_id);
    expect(['improved', 'unchanged', 'worse']).toContain(after?.result);
  });

  it('ignore：状态推进为已忽略', async () => {
    const ev = firstOpenEvent();
    expect(ev).toBeTruthy();
    const res = await http.post(`/api/actions/events/${ev!.id}/handle`).set(auth(token.boss)).send({ action_type: 'ignore', note: '数据噪声' });
    expect(res.status).toBe(200);
    expect(dataOf<{ status: number }>(res.body).status).toBe(3);
    expect(Number(get<{ status: number }>(`SELECT status FROM alert_event WHERE id = ?`, ev!.id)?.status)).toBe(3);
  });

  it('transfer 缺少 owner_id 时报错', async () => {
    const ev = firstOpenEvent();
    expect(ev).toBeTruthy();
    const res = await http.post(`/api/actions/events/${ev!.id}/handle`).set(auth(token.boss)).send({ action_type: 'transfer' });
    expect(res.status).toBe(400);
  });

  it('效果回看列表可分页查询', async () => {
    const res = await http.get('/api/actions/results').set(auth(token.boss)).query({ page: 1, pageSize: 10 });
    expect(res.status).toBe(200);
    const d = dataOf<{ list: unknown[]; total: number }>(res.body);
    expect(Array.isArray(d.list)).toBe(true);
    expect(d.total).toBeGreaterThan(0);
  });
});

describe('规则阈值配置化', () => {
  it('主管修改阈值：版本号 +1 且写操作日志', async () => {
    const rule = get<{ id: number; threshold: number; version: number }>(`SELECT id, threshold, version FROM alert_rule WHERE rule_code = 'VIDEO_DECAY'`);
    expect(rule).toBeTruthy();
    const res = await http.put(`/api/actions/rules/${rule!.id}`).set(auth(token.opsManager)).send({ threshold: 0.6, cooldown_hours: 48 });
    expect(res.status).toBe(200);
    const after = get<{ threshold: number; version: number }>(`SELECT threshold, version FROM alert_rule WHERE id = ?`, rule!.id);
    expect(Number(after?.threshold)).toBe(0.6);
    expect(Number(after?.version)).toBe(Number(rule!.version) + 1);
    const log = get<{ c: number }>(`SELECT COUNT(*) AS c FROM sys_op_log WHERE target_table = 'alert_rule' AND target_id = ?`, rule!.id)?.c ?? 0;
    expect(Number(log)).toBeGreaterThan(0);
  });
});

describe('权限边界', () => {
  it('普通运营可查看规则命中，但不可修改阈值 / 触发评估', async () => {
    const view = await http.get('/api/actions/rules').set(auth(token.ops));
    expect(view.status).toBe(200);
    expect(dataOf<{ list: unknown[] }>(view.body).list.length).toBe(RULES);

    const rule = get<{ id: number }>(`SELECT id FROM alert_rule LIMIT 1`);
    const put = await http.put(`/api/actions/rules/${rule!.id}`).set(auth(token.ops)).send({ threshold: 0.1 });
    expect(put.status).toBe(403);

    const evalRes = await http.post('/api/actions/evaluate').set(auth(token.ops)).send({});
    expect(evalRes.status).toBe(403);
  });

  it('BD(data_scope=3) 只能处理自己名下预警', async () => {
    const bdId = userId('chenbd');
    const bossId = userId('boss');
    expect(bdId).toBeGreaterThan(0);

    // 归属老板的事件：BD 直接按 id 处理应被拒
    const evBoss = firstOpenEvent();
    expect(evBoss).toBeTruthy();
    run(`UPDATE alert_event SET owner_id = ?, status = 0 WHERE id = ?`, bossId, evBoss!.id);
    const denied = await http.post(`/api/actions/events/${evBoss!.id}/handle`).set(auth(token.bd)).send({ action_type: 'note', note: 'x' });
    expect(denied.status).toBe(404);

    // 归属 BD 自己的事件：可处理
    const evBd = firstOpenEvent([evBoss!.id]);
    expect(evBd).toBeTruthy();
    run(`UPDATE alert_event SET owner_id = ?, status = 0 WHERE id = ?`, bdId, evBd!.id);
    const allowed = await http.post(`/api/actions/events/${evBd!.id}/handle`).set(auth(token.bd)).send({ action_type: 'note', note: '已联系达人' });
    expect(allowed.status).toBe(200);
  });

  it('BD 的今日看板只含本人名下预警', async () => {
    const bdId = userId('chenbd');
    const res = await http.get('/api/actions/today').set(auth(token.bd));
    expect(res.status).toBe(200);
    const d = dataOf<{ p0: { owner_id: number | null }[]; p1: { owner_id: number | null }[]; p2: { owner_id: number | null }[] }>(res.body);
    const all_ = [...d.p0, ...d.p1, ...d.p2];
    expect(all_.every((e) => e.owner_id !== null && Number(e.owner_id) === bdId)).toBe(true);
  });
});

describe('分析视图', () => {
  it('商品 ABC 分层：tier∈{A,B,C}，累计占比单调不减', async () => {
    const res = await http.get('/api/actions/analytics/abc').set(auth(token.boss)).query({ days: 30 });
    expect(res.status).toBe(200);
    const d = dataOf<{ start: string; end: string; rows: { tier: string; cum_share: number }[] }>(res.body);
    expect(d.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (d.rows.length) {
      expect(d.rows.every((r) => ['A', 'B', 'C'].includes(r.tier))).toBe(true);
      for (let i = 1; i < d.rows.length; i++) expect(d.rows[i].cum_share).toBeGreaterThanOrEqual(d.rows[i - 1].cum_share - 1e-9);
    }
  });

  it('店铺渠道结构：按周返回渠道占比', async () => {
    const res = await http.get('/api/actions/analytics/shop-channel').set(auth(token.boss)).query({ weeks: 8 });
    expect(res.status).toBe(200);
    const d = dataOf<{ week: string; shares: Record<string, number> }[]>(res.body);
    expect(Array.isArray(d)).toBe(true);
    if (d.length) {
      expect(d[0].week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof d[0].shares).toBe('object');
    }
  });
});
