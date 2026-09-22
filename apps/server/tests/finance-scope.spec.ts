/**
 * 财务写入范围与按单结算读订单（#29）
 *
 * 两条都属于「读侧守了、写侧没守」的同类漏洞：
 *  1. 费用挂到哪家店 / 是不是公共费用，决定这笔钱摊进谁的利润。
 *     以前 POST 与 PUT 都不校验目标 shop_id：范围外的角色能把成本塞进别人的店，
 *     也能把费用改成「公共费用」让它摊给全部门店 —— 而读侧 inExpenseScope() 是挡的，
 *     于是出现「看不见但改得动」。
 *  2. /settlement/by-order/:no 的结算流水按范围过滤了，但顺带返回的订单块没有 ——
 *     知道平台单号就能读到别人店的订单状态与金额。越权一律按「不存在」处理，不暴露存在性。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { get, insert } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login, type TestContext } from './helper.js';

let ctx: TestContext;
const tok: Record<string, string> = {};
let outsiderShop = 0;
let myShop = 0;
let wangqiangId = 0;

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
  const bossId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.boss)?.id ?? 0);
  wangqiangId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.opsManager)?.id ?? 0);
  const mkShop = (name: string): number =>
    insert('tk_shop', { shop_name: name, region: 'MY', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', shop_type: 1, auth_status: 1, status: 1, owner_id: bossId });

  // opsManager 是 DEPT 范围：没有 sys_user_shop 关联的店铺天然在他范围外
  outsiderShop = mkShop('Scope Probe Store（他店）');
  myShop = mkShop('Scope Probe Store（本部门）');
  insert('sys_user_shop', { user_id: wangqiangId, shop_id: myShop, created_by: bossId });

  // 他店里的一单，用于按单结算的越权读取
  insert('tk_order', {
    shop_id: outsiderShop,
    tk_order_id: 'FIN-SCOPE-ORDER',
    order_status: 'COMPLETED',
    order_time: '2026-09-01 02:00:00',
    currency: 'MYR',
    total_paid: 8899,
    is_sample_order: 0,
  });
  insert('settlement_txn', {
    shop_id: outsiderShop,
    tk_order_id: 'FIN-SCOPE-ORDER',
    txn_type: 1,
    amount: 100,
    currency: 'MYR',
    payment_status: 2,
    statement_time: '2026-09-05 02:00:00',
  });
});

const expenseCount = (shopId: number | null): number =>
  Number(
    get<{ c: number }>(
      shopId ? `SELECT COUNT(*) AS c FROM expense WHERE is_deleted = 0 AND shop_id = ?` : `SELECT COUNT(*) AS c FROM expense WHERE is_deleted = 0 AND shop_id IS NULL`,
      ...(shopId ? [shopId] : []),
    )?.c ?? 0,
  );

describe('费用归属必须是操作者范围内的店铺', () => {
  it('DEPT 角色不能把费用挂到自己范围外的店铺（403，且不落库）', async () => {
    const before = expenseCount(outsiderShop);
    const res = await ctx.http
      .post('/api/finance/expense')
      .set(auth(tok.opsManager))
      .send({ shop_id: outsiderShop, expense_type: 3, amount: 500, expense_date: '2026-09-01', title: '越权挂店', currency: 'CNY' });
    expect(res.status).toBe(403);
    expect(String(res.body.message)).toContain('数据范围');
    expect(expenseCount(outsiderShop)).toBe(before);
  });

  it('非全数据范围角色不能登记「公共费用」（会摊给所有店）', async () => {
    const before = expenseCount(null);
    const res = await ctx.http
      .post('/api/finance/expense')
      .set(auth(tok.opsManager))
      .send({ expense_type: 3, amount: 900, expense_date: '2026-09-01', title: '越权公共费用', currency: 'CNY' });
    expect(res.status).toBe(403);
    expect(expenseCount(null)).toBe(before);
  });

  it('合法路径不受影响：ALL 角色可建公共费用，DEPT 角色可建本店费用', async () => {
    const pub = await ctx.http
      .post('/api/finance/expense')
      .set(auth(tok.finance))
      .send({ expense_type: 3, amount: 900, expense_date: '2026-09-01', title: '办公室租金', currency: 'CNY' });
    expect(pub.status).toBe(200);
    const mine = await ctx.http
      .post('/api/finance/expense')
      .set(auth(tok.opsManager))
      .send({ shop_id: myShop, expense_type: 3, amount: 300, expense_date: '2026-09-01', title: '本店推广', currency: 'CNY' });
    expect(mine.status).toBe(200);
  });

  it('改归属同样要守：不能把自己范围内的费用挪到别家店或改成公共费用', async () => {
    const id = Number(
      (await ctx.http.post('/api/finance/expense').set(auth(tok.opsManager)).send({ shop_id: myShop, expense_type: 3, amount: 120, expense_date: '2026-09-02', title: '待挪费用', currency: 'CNY' })).body.data.id,
    );
    const moveOut = await ctx.http.put(`/api/finance/expense/${id}`).set(auth(tok.opsManager)).send({ shop_id: outsiderShop });
    expect(moveOut.status).toBe(403);
    const toPublic = await ctx.http.put(`/api/finance/expense/${id}`).set(auth(tok.opsManager)).send({ shop_id: null });
    expect(toPublic.status).toBe(403);
    expect(Number(get<{ shop_id: number }>(`SELECT shop_id FROM expense WHERE id = ?`, id)?.shop_id)).toBe(myShop);

    // 只改金额不碰归属，必须照常能改
    const justAmount = await ctx.http.put(`/api/finance/expense/${id}`).set(auth(tok.opsManager)).send({ amount: 150 });
    expect(justAmount.status).toBe(200);
  });
});

describe('按单结算不得读出别家店的订单', () => {
  it('DEPT 角色查他店的平台单号：订单块为 null（按不存在处理），流水同样为空', async () => {
    const res = await ctx.http.get('/api/finance/settlement/by-order/FIN-SCOPE-ORDER').set(auth(tok.opsManager));
    expect(res.status).toBe(200);
    const d = dataOf<{ order: unknown; list: unknown[] }>(res.body);
    expect(d.order).toBeNull();
    expect(d.list).toHaveLength(0);
  });

  it('ALL 角色查同一单号能读到订单（守边界不能把正常路径也堵死）', async () => {
    const res = await ctx.http.get('/api/finance/settlement/by-order/FIN-SCOPE-ORDER').set(auth(tok.finance));
    const d = dataOf<{ order: { shop_id: number; total_paid: number } | null; list: unknown[] }>(res.body);
    expect(Number(d.order?.shop_id)).toBe(outsiderShop);
    expect(Number(d.order?.total_paid)).toBe(8899);
    expect(d.list.length).toBeGreaterThan(0);
  });

  it('店铺授权关系没建错：opsManager 确实看不到那家店（前提断言）', async () => {
    const rows = dataOf<{ list: { id: number }[] }>((await ctx.http.get('/api/shops?page=1&pageSize=200').set(auth(tok.opsManager))).body);
    const ids = rows.list.map((r) => Number(r.id));
    expect(ids).toContain(myShop);
    expect(ids).not.toContain(outsiderShop);
  });
});
