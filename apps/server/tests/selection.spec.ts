/**
 * 选品管理回归（方案第十一章）
 *
 * 这一章的价值全在「闸门」上：状态机不许绕、结论必须带数据、清单没清完不许上架。
 * 这三条只要有一条能被绕过，流水线就会在两周内退化成一张谁都不维护的选品表，
 * 而且退化时界面上完全看不出来 —— 所以每一项都从 HTTP 打一遍，而不是只测函数。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SELECTION_CHECKLIST_KEYS, SELECTION_CONCLUSION, SELECTION_STAGE } from '@tk/shared';
import { get, getDb, run } from '../src/core/db.js';
import { migrate } from '../src/db/migrate.js';
import { ACCOUNTS, auth, boot, dataOf, login, type TestContext } from './helper.js';

let ctx: TestContext;
const tok: Record<string, string> = {};

const SNAP = { impressions: 9000, ctr: 0.035, cart_rate: 0.06, cvr: 0.018, refund_rate: 0.02, gmv: 2100, net_margin: 0.33 };

/** 把 UTC 时间往前挪 N 天，格式与库里的 datetime 文本一致（不用 datetime() SQL 函数，别再添方言债） */
const daysAgoStamp = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

const register = async (owner: string, over: Record<string, unknown> = {}) =>
  ctx.http.post('/api/selection').set(auth(tok[owner])).send({
    name: '选品回归样品',
    category: '家居',
    supplier: '测试供应商',
    purchase_price: 8.8,
    moq: 200,
    lead_days: 7,
    est_margin: 0.5,
    source: '市场调研',
    ...over,
  });

/** 把候选品推到指定阶段（走真实接口，不用 SQL 后门 —— 后门测不到闸门） */
async function advanceTo(id: number, stage: number, note = '推进'): Promise<void> {
  if (stage >= SELECTION_STAGE.TESTING) {
    await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.TESTING, shop_id: shopA, note });
  }
  if (stage >= SELECTION_STAGE.FEEDBACK) {
    await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.PASS, note: '数据达标', snapshot: SNAP });
  }
  if (stage >= SELECTION_STAGE.PREPARING) {
    await ctx.http.post(`/api/selection/${id}/conclusion/confirm`).set(auth(tok.boss)).send({});
  }
}

let shopA = 0;

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
  shopA = Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id ?? 0);
  expect(shopA).toBeGreaterThan(0);
});

describe('登记', () => {
  it('自动生成候选品编号与预估盈亏平衡 ROAS，并落在登记阶段', async () => {
    const res = await register('ops');
    expect(res.status).toBe(200);
    const data = dataOf<{ id: number; code: string; stage: number; breakeven_roas: number }>(res.body);
    expect(data.code).toMatch(/^SEL-\d{4}-\d{4}$/);
    expect(Number(data.stage)).toBe(SELECTION_STAGE.REGISTERED);
    // 毛利率 0.5 ⇒ Break-even ROAS = 2，这是给投放留的基准，不能算错
    expect(Number(data.breakeven_roas)).toBeCloseTo(2, 2);
    const logs = dataOf<unknown[]>(
      (await ctx.http.get(`/api/selection/${data.id}/logs`).set(auth(tok.boss))).body,
    );
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('名称必填，毛利率只能 0-1', async () => {
    expect((await register('ops', { name: '' })).status).toBe(400);
    expect((await register('ops', { est_margin: 1.6 })).status).toBe(400);
  });
});

describe('状态机闸门', () => {
  it('不许跳阶段：登记直接到销售前准备被拒', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    const res = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.PREPARING, note: '想抄近路' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('不允许');
  });

  it('测试阶段不给「直接跳测试反馈」的出边：状态机和接口文案得说同一句话', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    const detail = dataOf<{ next_stages: number[] }>((await ctx.http.get(`/api/selection/${id}`).set(auth(tok.boss))).body);
    // next_stages 是前端按钮的唯一来源：把 2→3 报出去，用户点到的就是一个必然被拒的按钮
    expect(detail.next_stages).not.toContain(SELECTION_STAGE.FEEDBACK);
    const res = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.FEEDBACK });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('提交测试结论');
  });

  it('进上架测试必须指定测试店铺', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    const noShop = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.TESTING, note: '上架' });
    expect(noShop.status).toBe(400);
    expect(String(noShop.body.message)).toContain('店铺');
    expect((await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.TESTING, shop_id: shopA, note: '上架' })).status).toBe(200);
  });

  it('淘汰必须写原因（复盘要用）', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    expect((await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.ELIMINATED, note: '  ' })).status).toBe(400);
    const ok = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.ELIMINATED, note: '同类目三家低价内卷，无投放空间' });
    expect(ok.status).toBe(200);
    expect(Number(dataOf<{ reject_reason: string }>(ok.body).reject_reason ? 1 : 0)).toBe(1);
  });

  it('每次流转都留下日志，且带操作人', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.PREPARING);
    const list = dataOf<{ operator_name: string; from_stage: number; to_stage: number }[]>(
      (await ctx.http.get(`/api/selection/${id}/logs`).set(auth(tok.boss))).body,
    );
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((l) => Number(l.to_stage) === SELECTION_STAGE.TESTING)).toBe(true);
    expect(list.every((l) => l.operator_name)).toBe(true);
  });
});

describe('测试结论必须带数据快照', () => {
  it('缺指标直接被拒，并点名缺哪几个', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    const partial = { ctr: 0.03, gmv: '不是数字' } as unknown as Record<string, number>;
    const res = await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.PASS, note: '看着不错', snapshot: partial });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('测试数据快照缺少指标');
    expect(String(res.body.message)).toContain('impressions');
  });

  it('没有快照的结论不算结论：快照原样入库并进日志', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    const res = await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.PASS, note: 'CTR/转化均达基准', snapshot: SNAP });
    expect(res.status).toBe(200);
    const detail = dataOf<{ stage: number; conclusion: number; snapshot: Record<string, number> }>(
      (await ctx.http.get(`/api/selection/${id}`).set(auth(tok.boss))).body,
    );
    expect(Number(detail.stage)).toBe(SELECTION_STAGE.FEEDBACK);
    expect(Number(detail.conclusion)).toBe(SELECTION_CONCLUSION.PASS);
    expect(Number(detail.snapshot.gmv)).toBe(SNAP.gmv);
    const logs = dataOf<{ action: string; note: string }[]>(
      (await ctx.http.get(`/api/selection/${id}/logs`).set(auth(tok.boss))).body,
    );
    expect(logs.some((l) => l.action === 'submit_conclusion' && l.note.includes('impressions'))).toBe(true);
  });

  it('复测必须写调整项；不通过必须写原因', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    expect((await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.RETEST, note: '转化偏低', snapshot: SNAP })).status).toBe(400);
    expect((await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.RETEST, note: '转化偏低', adjustments: '换主图 + 改标题', snapshot: SNAP })).status).toBe(200);
    const back = await ctx.http.post(`/api/selection/${id}/conclusion/confirm`).set(auth(tok.boss)).send({});
    expect(back.status).toBe(200);
    expect(Number(dataOf<{ stage: number }>(back.body).stage)).toBe(SELECTION_STAGE.TESTING);
  });

  it('只有测试阶段能提交结论', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    const res = await ctx.http.post(`/api/selection/${id}/conclusion`).set(auth(tok.boss)).send({ conclusion: SELECTION_CONCLUSION.PASS, note: '还没测试呢', snapshot: SNAP });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('店铺上架测试');
  });
});

describe('销售前准备清单', () => {
  it('清单没清完不许转正常销售，并列出缺哪几项', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.PREPARING);
    const res = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.SELLING, spu_id: 1, note: '上架' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('销售前准备清单未完成');
    expect(String(res.body.message)).toContain('合规确认');
  });

  it('六项全勾完 + 关联 SPU 才能转正常销售，并写下正式销售时间', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.PREPARING);
    const spu = Number(get<{ id: number }>(`SELECT id FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id ?? 0);
    const allDone = Object.fromEntries(SELECTION_CHECKLIST_KEYS.map((k) => [k, { done: 1 }]));
    expect((await ctx.http.put(`/api/selection/${id}/checklist`).set(auth(tok.boss)).send(allDone)).status).toBe(200);
    const noSpu = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.SELLING, note: '上架' });
    expect(noSpu.status).toBe(400);
    const ok = await ctx.http.post(`/api/selection/${id}/stage`).set(auth(tok.boss)).send({ to_stage: SELECTION_STAGE.SELLING, spu_id: spu, note: '上架' });
    expect(ok.status).toBe(200);
    const body = dataOf<{ stage: number; selling_at: string | null; spu_id: number }>(ok.body);
    expect(Number(body.stage)).toBe(SELECTION_STAGE.SELLING);
    expect(Number(body.spu_id)).toBe(spu);
    expect(body.selling_at).toBeTruthy();
  });

  it('未知清单项与错阶段都要被挡', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    expect((await ctx.http.put(`/api/selection/${id}/checklist`).set(auth(tok.boss)).send({ profile: { done: 1 } })).status).toBe(400);
    await advanceTo(id, SELECTION_STAGE.PREPARING);
    expect((await ctx.http.put(`/api/selection/${id}/checklist`).set(auth(tok.boss)).send({ 随便编一项: { done: 1 } })).status).toBe(400);
  });
});

describe('看板、漏斗与超时', () => {
  it('看板五列 + 卡片带停留天数与超时档位', async () => {
    const board = dataOf<{ columns: { stage: number; cards: { dwell_days: number; overdue_level: string }[]; title: string }[]; thresholds: Record<string, number> }>(
      (await ctx.http.get('/api/selection/board').set(auth(tok.boss))).body,
    );
    expect(board.columns.length).toBe(5);
    expect(board.columns[0].title).toContain('登记');
    expect(board.thresholds.conclusion_due_days).toBeGreaterThan(0);
    const cards = board.columns.flatMap((c) => c.cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => ['ok', 'warn', 'over'].includes(String(c.overdue_level)))).toBe(true);
    expect(cards.every((c) => Number(c.dwell_days) >= 0)).toBe(true);
  });

  it('把测试中的候选品改到超期，档位立刻变红（阈值只有一份，前后端同口径）', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    const before = dataOf<{ overdue_level: string; dwell_days: number }>(
      (await ctx.http.get(`/api/selection/${id}`).set(auth(tok.boss))).body,
    );
    expect(before.overdue_level).toBe('ok');
    run(`UPDATE selection_flow SET test_started_at = ? WHERE id = ?`, daysAgoStamp(30), id);
    const after = dataOf<{ overdue_level: string; dwell_days: number; due_days: number }>(
      (await ctx.http.get(`/api/selection/${id}`).set(auth(tok.boss))).body,
    );
    expect(after.overdue_level).toBe('over');
    expect(Number(after.dwell_days)).toBeGreaterThanOrEqual(29);
    expect(Number(after.due_days)).toBeGreaterThan(0);
    const only = dataOf<{ list: unknown[] }>((await ctx.http.get('/api/selection?overdue=1&page=1&pageSize=50').set(auth(tok.boss))).body);
    expect(only.list.length).toBeGreaterThan(0);
  });

  it('漏斗四步齐全且通过率在 0-1', async () => {
    const f = dataOf<{ steps: { key: string; value: number }[]; pass_rate: number; eliminated: number }>(
      (await ctx.http.get('/api/selection/funnel').set(auth(tok.boss))).body,
    );
    expect(f.steps.map((s) => s.key)).toEqual(['registered', 'tested', 'passed', 'selling']);
    expect(Number(f.steps[0].value)).toBeGreaterThanOrEqual(Number(f.steps[3].value));
    expect(Number(f.pass_rate)).toBeGreaterThanOrEqual(0);
    expect(Number(f.pass_rate)).toBeLessThanOrEqual(1);
    expect(Number(f.eliminated)).toBeGreaterThanOrEqual(0);
  });
});

describe('权限与数据范围', () => {
  it('没有选品菜单的角色连不上（内容/仓库）', async () => {
    expect((await ctx.http.get('/api/selection').set(auth(tok.content))).status).toBe(403);
    expect((await ctx.http.post('/api/selection').set(auth(tok.warehouse)).send({ name: 'x' })).status).toBe(403);
  });

  it('编辑接口改不动 stage 与结论', async () => {
    const id = Number(dataOf<{ id: number }>((await register('ops')).body).id);
    await ctx.http.put(`/api/selection/${id}`).set(auth(tok.ops)).send({ name: '改名了', stage: 5, conclusion: 1 });
    const row = get<{ stage: number; conclusion: number; name: string }>(`SELECT stage, conclusion, name FROM selection_flow WHERE id = ?`, id);
    expect(Number(row?.stage)).toBe(SELECTION_STAGE.REGISTERED);
    expect(Number(row?.conclusion)).toBe(SELECTION_CONCLUSION.PENDING);
    expect(String(row?.name)).toBe('改名了');
  });

  it('老库升级：有商品菜单的角色会被补上「选品管理」，其余权限不动', async () => {
    // 新库的 DEFAULT_ROLES 本来就带 selection，所以先把角色改回"上线前"的样子再跑迁移
    run(`UPDATE sys_role SET menu_perms = ? WHERE role_key = 'ops'`, JSON.stringify(['dashboard', 'shop', 'product', 'order']));
    run(`UPDATE sys_role SET menu_perms = ? WHERE role_key = 'bd'`, JSON.stringify(['dashboard', 'creator', 'content', 'product']));
    run(`UPDATE sys_role SET menu_perms = ? WHERE role_key = 'finance'`, JSON.stringify(['dashboard', 'finance', 'order']));
    migrate(getDb());
    const permsOf = (key: string): string[] =>
      JSON.parse(String(get<{ menu_perms: string }>(`SELECT menu_perms FROM sys_role WHERE role_key = ?`, key)?.menu_perms ?? '[]')) as string[];
    expect(permsOf('ops')).toContain('selection');
    // 手工改过的其它权限必须原样保留，迁移只加不减
    expect(permsOf('ops')).toEqual(['dashboard', 'shop', 'product', 'order', 'selection']);
    expect(permsOf('bd')).toContain('selection');
    expect(permsOf('finance')).not.toContain('selection');
  });

  it('导出要 can_export：内容角色有选品菜单也没有导出权', async () => {
    const res = await ctx.http.get('/api/selection/export?format=csv').set(auth(tok.content));
    expect(res.status).toBe(403);
    const boss = await ctx.http.get('/api/selection/export?format=csv').set(auth(tok.boss));
    expect(boss.status).toBe(200);
    expect(boss.text).toContain('SEL-');
  });
});

describe('选品规则', () => {
  it('测试到期未反馈会生成 P0 事件，且带候选品编号', async () => {
    const id = Number(dataOf<{ id: number }>((await register('boss')).body).id);
    await advanceTo(id, SELECTION_STAGE.TESTING);
    run(`UPDATE selection_flow SET test_started_at = ? WHERE id = ?`, daysAgoStamp(20), id);
    const evalRes = dataOf<{ created_events: number }>(
      (await ctx.http.post('/api/actions/evaluate').set(auth(tok.boss)).send({})).body,
    );
    expect(Number(evalRes.created_events)).toBeGreaterThan(0);
    const hit = get<{ target_name: string; priority: number }>(
      `SELECT e.target_name, r.priority FROM alert_event e JOIN alert_rule r ON r.id = e.rule_id
        WHERE e.is_deleted = 0 AND r.rule_code = 'SELECTION_TEST_OVERDUE' AND e.target_id = ?`,
      id,
    );
    expect(hit).toBeTruthy();
    expect(Number(hit?.priority)).toBe(0);
    expect(String(hit?.target_name)).toContain('SEL-');
  });

  it('同一规则同一候选品在冷却期内不重复刷屏', async () => {
    const first = dataOf<{ created_events: number }>(
      (await ctx.http.post('/api/actions/evaluate').set(auth(tok.boss)).send({})).body,
    );
    void first;
    const second = dataOf<{ skipped_cooldown: number; created_events: number }>(
      (await ctx.http.post('/api/actions/evaluate').set(auth(tok.boss)).send({})).body,
    );
    expect(Number(second.skipped_cooldown)).toBeGreaterThan(0);
  });
});
