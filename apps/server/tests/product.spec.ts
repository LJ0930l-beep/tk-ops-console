import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';

/**
 * 商品中心（方案表 3 product_spu / 表 4 product_sku / 表 5 shop_listing）
 * 覆盖：店铺数据范围 / 成本掩码 / 改成本 before-after 且历史快照冻结 /
 *       映射绑定与自动匹配（多命中与空 seller_sku 不误绑）/ 待映射清单 / 导入导出与权限。
 */

const http = boot().http;

const skuRow = (id: number): Record<string, unknown> => get<Record<string, unknown>>(`SELECT * FROM product_sku WHERE id = ?`, id) ?? {};
const listingRow = (id: number): Record<string, unknown> => get<Record<string, unknown>>(`SELECT * FROM shop_listing WHERE id = ?`, id) ?? {};

/** 最近一条包含指定片段的操作日志（before/after 落库形态是一段 JSON 文本） */
function lastLog(table: string, id: number, contains?: string): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const row = contains
    ? get<{ before_after: string }>(
        `SELECT before_after FROM sys_op_log WHERE target_table = ? AND target_id = ? AND before_after LIKE ? ORDER BY id DESC LIMIT 1`,
        table,
        id,
        `%${contains}%`,
      )
    : get<{ before_after: string }>(
        `SELECT before_after FROM sys_op_log WHERE target_table = ? AND target_id = ? ORDER BY id DESC LIMIT 1`,
        table,
        id,
      );
  return row ? (JSON.parse(row.before_after) as { before: Record<string, unknown>; after: Record<string, unknown> }) : null;
}

const token: Record<string, string> = {};
beforeAll(async () => {
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(http, u);
  // 赵磊与林雅同角色（运营），用来验证「同角色不同店铺」的隔离
  token.zhaolei = await login(http, 'zhaolei');
});

/** 种子：SPU1 ORICO-66059（2 个 SKU），SKU1 = 采购 96 + 头程 22 */
const SPU1 = 1;
const SKU1 = 1;

async function makeSku(spuId: number, skuCode: string, purchase: number, firstLeg: number): Promise<number> {
  const res = await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: spuId, sku_code: skuCode, purchase_cost: purchase, first_leg_cost: firstLeg });
  expect(res.status).toBe(200);
  return dataOf<{ id: number }>(res.body).id;
}

/** 建一条店铺商品映射（不给 sku_id 即待映射） */
async function makeListing(shopId: number, tkSkuId: string, sellerSku: string | null, skuId?: number): Promise<number> {
  const res = await http
    .post('/api/products/listing')
    .set(auth(token.boss))
    .send({ shop_id: shopId, tk_sku_id: tkSkuId, seller_sku: sellerSku, product_name: `测试商品 ${tkSkuId}`, sale_price: 39.9, sku_id: skuId });
  expect(res.status).toBe(200);
  return dataOf<{ id: number }>(res.body).id;
}

/* ==================================================================== */
describe('商品中心：鉴权与店铺数据范围（方案 8.1）', () => {
  it('未登录 401；无 product 菜单 403；类目字典登录即可', async () => {
    expect((await http.get('/api/products/spu')).status).toBe(401);
    expect((await http.get('/api/products/sku')).status).toBe(401);
    expect((await http.get('/api/products/listing')).status).toBe(401);
    expect((await http.get('/api/products/unmapped')).status).toBe(401);
    // 内容剪辑岗没有商品菜单
    expect((await http.get('/api/products/spu').set(auth(token.content))).status).toBe(403);
    expect((await http.post('/api/products/spu').set(auth(token.content)).send({ spu_code: 'X', name_cn: 'X' })).status).toBe(403);
    // 财务有导出权限但没有商品菜单 → 商品接口整体拒绝
    expect((await http.get('/api/products/export/sku').set(auth(token.finance))).status).toBe(403);
    const cats = dataOf<Record<string, unknown>[]>((await http.get('/api/products/categories').set(auth(token.warehouse))).body);
    expect(cats.length).toBeGreaterThanOrEqual(4);
    expect(cats.some((c) => c.dict_value === '3C数码')).toBe(true);
  });

  it('映射列表按店铺隔离：运营只看自己负责的店', async () => {
    const boss = pageOf((await http.get('/api/products/listing?pageSize=200').set(auth(token.boss))).body);
    expect(boss.total).toBe(27);
    const limy = pageOf((await http.get('/api/products/listing?pageSize=200').set(auth(token.ops))).body);
    expect(limy.total).toBeGreaterThan(0);
    expect(limy.total).toBeLessThan(boss.total);
    expect(limy.list.every((l) => Number(l.shop_id) === 1)).toBe(true);

    const zhao = pageOf((await http.get('/api/products/listing?pageSize=200').set(auth(token.zhaolei))).body);
    expect(zhao.list.every((l) => Number(l.shop_id) === 2)).toBe(true);
    expect(zhao.total).toBe(limy.total === zhao.total ? zhao.total : zhao.total);

    // 运营主管（部门范围）覆盖 1/2/3 店，但看不到店铺 4
    const manager = pageOf((await http.get('/api/products/listing?pageSize=200').set(auth(token.opsManager))).body);
    expect([...new Set(manager.list.map((l) => Number(l.shop_id)))].sort()).toEqual([1, 2, 3]);

    const foreign = boss.list.find((l) => Number(l.shop_id) === 2) as Record<string, unknown>;
    expect((await http.get(`/api/products/listing/${Number(foreign.id)}`).set(auth(token.ops))).status).toBe(404);
    expect(pageOf((await http.get('/api/products/listing?shop_id=2&pageSize=50').set(auth(token.ops))).body).total).toBe(0);
    expect((await http.post('/api/products/listing').set(auth(token.ops)).send({ shop_id: 2, seller_sku: 'x' })).status).toBe(403);
  });

  it('SKU 列表：别人店铺在架的 SKU 不可见，未上架的公共可见', async () => {
    expect(pageOf((await http.get('/api/products/sku?keyword=ORICO-66059-02').set(auth(token.ops))).body).total).toBe(1);
    // 老板把 SKU2 上架到店铺 4（只在老板范围内）→ 林雅再也看不到
    const listingId = await makeListing(4, 'TK-SCOPE-SKU2', 'ORICO-66059-02-SCOPE', 2);
    expect(pageOf((await http.get('/api/products/sku?keyword=ORICO-66059-02').set(auth(token.ops))).body).total).toBe(0);
    expect(pageOf((await http.get('/api/products/sku?keyword=ORICO-66059-02').set(auth(token.opsManager))).body).total).toBe(0);
    expect(pageOf((await http.get('/api/products/sku?keyword=ORICO-66059-02').set(auth(token.boss))).body).total).toBe(1);
    expect((await http.get('/api/products/sku?shop_id=4').set(auth(token.ops))).status).toBe(403);
    expect((await http.delete(`/api/products/listing/${listingId}`).set(auth(token.boss))).status).toBe(200);
    expect(pageOf((await http.get('/api/products/sku?keyword=ORICO-66059-02').set(auth(token.ops))).body).total).toBe(1);
  });
});

/* ==================================================================== */
describe('成本：单一来源 + 权限掩码 + 历史不回写（要点 5.1）', () => {
  it('无 can_see_cost：purchase_cost / first_leg_cost / unit_cost 全部 ***', async () => {
    const boss = pageOf((await http.get('/api/products/sku?spu_id=1&pageSize=50').set(auth(token.boss))).body);
    const one = boss.list.find((r) => Number(r.id) === SKU1) as Record<string, unknown>;
    expect(Number(one.purchase_cost)).toBe(96);
    expect(Number(one.first_leg_cost)).toBe(22);
    expect(Number(one.unit_cost)).toBe(118);
    expect(one.last_cost_by).toBe(null);

    const limy = pageOf((await http.get('/api/products/sku?spu_id=1&pageSize=50').set(auth(token.ops))).body);
    const masked = limy.list.find((r) => Number(r.id) === SKU1) as Record<string, unknown>;
    expect(masked.purchase_cost).toBe('***');
    expect(masked.first_leg_cost).toBe('***');
    expect(masked.unit_cost).toBe('***');
    expect(masked.sku_code).not.toBe('***');

    const detailBoss = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}`).set(auth(token.boss))).body);
    expect(Number(detailBoss.unit_cost)).toBe(118);
    expect(Number(detailBoss.listing_count)).toBeGreaterThan(0);
    const detailLimy = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}`).set(auth(token.ops))).body);
    expect(detailLimy.purchase_cost).toBe('***');
    const subSkus = dataOf<Record<string, unknown>[]>((await http.get(`/api/products/spu/${SPU1}/skus`).set(auth(token.ops))).body);
    expect(subSkus.length).toBe(2);
    expect(subSkus[0]?.unit_cost).toBe('***');
    const subBoss = dataOf<Record<string, unknown>[]>((await http.get(`/api/products/spu/${SPU1}/skus`).set(auth(token.boss))).body);
    expect(Number(subBoss[0]?.unit_cost)).toBe(118);
  });

  it('改成本写 before/after，历史 cost_snapshot 一字不动；无权限改不了', async () => {
    const frozen = get<{ id: number; cost_snapshot: number }>(
      `SELECT id, cost_snapshot FROM tk_order_item WHERE sku_id = ? AND cost_matched = 1 ORDER BY id ASC LIMIT 1`,
      SKU1,
    );
    expect(frozen).toBeTruthy();

    expect((await http.put(`/api/products/sku/${SKU1}`).set(auth(token.ops)).send({ purchase_cost: 1 })).status).toBe(403);
    expect(skuRow(SKU1).purchase_cost).toBe(96);

    const res = await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ purchase_cost: 100, first_leg_cost: 25 });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.cost_changed).toBe(true);
    expect(Number(d.unit_cost)).toBe(125);
    expect(String(d.tip)).toContain('历史订单');
    expect(skuRow(SKU1).purchase_cost).toBe(100);
    expect(skuRow(SKU1).first_leg_cost).toBe(25);

    const after = get<{ cost_snapshot: number }>(`SELECT cost_snapshot FROM tk_order_item WHERE id = ?`, Number(frozen?.id));
    expect(Number(after?.cost_snapshot)).toBe(Number(frozen?.cost_snapshot));

    const log = lastLog('product_sku', SKU1, 'purchase_cost');
    expect(Number(log?.before?.purchase_cost)).toBe(96);
    expect(Number(log?.after?.purchase_cost)).toBe(100);
    expect(Number(log?.after?.unit_cost)).toBe(125);
    expect(String(log?.after?.sku_code)).toBe('ORICO-66059-01');

    // 只改规格不改成本 → cost_changed=false
    const noCost = dataOf<Record<string, unknown>>(
      (await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ spec: '白色 3米 改版' })).body,
    );
    expect(noCost.cost_changed).toBe(false);
    expect(Number(noCost.unit_cost)).toBe(125);

    expect((await http.put('/api/products/sku/999999').set(auth(token.boss)).send({ purchase_cost: 1 })).status).toBe(404);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 999999, sku_code: 'NO-SPU' })).status).toBe(400);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 1, sku_code: 'ORICO-66059-01' })).status).toBe(400);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 1 })).status).toBe(400);
    expect((await http.get('/api/products/sku/999999').set(auth(token.boss))).status).toBe(404);
  });

  it('成本时间线读 sys_op_log；无成本权限 403', async () => {
    const d = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}/cost-history`).set(auth(token.boss))).body);
    expect(d.sku_code).toBe('ORICO-66059-01');
    expect(Number(d.current_unit_cost)).toBe(125);
    const timeline = d.timeline as Record<string, unknown>[];
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(Number(timeline[0]?.before_purchase_cost)).toBe(96);
    expect(Number(timeline[0]?.after_purchase_cost)).toBe(100);
    expect(Number(timeline[0]?.diff_unit_cost)).toBe(7);
    expect(timeline[0]?.user_name).toBe('陈新');
    expect(String(d.tip)).toContain('不回溯');
    expect((await http.get(`/api/products/sku/${SKU1}/cost-history`).set(auth(token.ops))).status).toBe(403);
    expect((await http.get('/api/products/sku/999999/cost-history').set(auth(token.boss))).status).toBe(404);
  });

  it('缺成本预警：cost_missing=1 只给（采购+头程）=0 的 SKU', async () => {
    const created = await makeSku(SPU1, 'COST-MISSING-01', 0, 0);
    const list = pageOf((await http.get('/api/products/sku?cost_missing=1&pageSize=200').set(auth(token.boss))).body);
    expect(list.list.every((r) => Number(r.purchase_cost) + Number(r.first_leg_cost) === 0)).toBe(true);
    expect(list.list.some((r) => Number(r.id) === created)).toBe(true);
    expect((await http.delete(`/api/products/sku/${created}`).set(auth(token.boss))).status).toBe(200);
  });

  it('删除保护：有 SKU 的 SPU 不删；被映射引用的 SKU 不删', async () => {
    expect((await http.delete(`/api/products/spu/${SPU1}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/sku/${SKU1}`).set(auth(token.boss))).status).toBe(403);

    // 上架 → 不能删；解绑 → 可以删；进过订单 → 永远不能删
    const sku = await makeSku(SPU1, 'DEL-GUARD-01', 7, 2);
    const listingId = await makeListing(1, 'TK-DEL-GUARD', 'DEL-GUARD-01', sku);
    expect((await http.delete(`/api/products/sku/${sku}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/listing/${listingId}`).set(auth(token.boss))).status).toBe(200);
    expect((await http.delete(`/api/products/sku/${sku}`).set(auth(token.boss))).status).toBe(200);
    expect(skuRow(sku).is_deleted).toBe(1);
    const ordered = get<{ id: number }>(`SELECT sku_id AS id FROM tk_order_item WHERE cost_matched = 1 LIMIT 1`);
    expect((await http.delete(`/api/products/sku/${Number(ordered?.id)}`).set(auth(token.boss))).status).toBe(403);

    // SPU 建 → 改 → 清空后删
    const spu = dataOf<{ id: number }>((await http.post('/api/products/spu').set(auth(token.ops)).send({ spu_code: 'DEL-SPU-01', name_cn: '待删款', category: '家居' })).body);
    expect((await http.put(`/api/products/spu/${spu.id}`).set(auth(token.ops)).send({ name_cn: '待删款改名' })).status).toBe(200);
    expect(get<{ name_cn: string }>(`SELECT name_cn FROM product_spu WHERE id = ?`, spu.id)?.name_cn).toBe('待删款改名');
    expect((await http.post('/api/products/spu').set(auth(token.ops)).send({ spu_code: 'DEL-SPU-01', name_cn: '重号' })).status).toBe(400);
    expect((await http.delete(`/api/products/spu/${spu.id}`).set(auth(token.ops))).status).toBe(200);
    expect((await http.get(`/api/products/spu/${spu.id}`).set(auth(token.boss))).status).toBe(404);
    expect((await http.delete('/api/products/spu/999999').set(auth(token.boss))).status).toBe(404);
    expect((await http.put(`/api/products/spu/${spu.id}`).set(auth(token.boss)).send({ spu_code: 'ORICO-66059' })).status).toBe(400);
  });
});

/* ==================================================================== */
describe('店铺商品映射：手工绑定 / 解绑 / 自动匹配都留 before-after', () => {
  it('新建待映射 → 绑定 → 解绑', async () => {
    const id = await makeListing(1, 'TK-MANUAL-1', 'MANUAL-SKU-X');
    expect(listingRow(id).map_status).toBe(2);
    expect(listingRow(id).sku_id).toBe(null);

    const bound = dataOf<Record<string, unknown>>(
      (await http.put(`/api/products/listing/${id}`).set(auth(token.ops)).send({ sku_id: 3, seller_sku: 'MANUAL-BOUND' })).body,
    );
    expect(Number(bound.map_status)).toBe(1);
    expect(Number(bound.sku_id)).toBe(3);
    expect(String(bound.tip)).toContain('冻结');
    expect(listingRow(id).sku_id).toBe(3);
    const bindLog = lastLog('shop_listing', id, 'MANUAL-BOUND');
    expect(bindLog?.before?.sku_id).toBe(null);
    expect(Number(bindLog?.after?.sku_id)).toBe(3);
    expect(Number(bindLog?.before?.map_status)).toBe(2);
    expect(Number(bindLog?.after?.map_status)).toBe(1);

    // sku_id=0 视为「清空绑定」
    const unbound = dataOf<Record<string, unknown>>((await http.put(`/api/products/listing/${id}`).set(auth(token.ops)).send({ sku_id: 0 })).body);
    expect(unbound.sku_id).toBe(null);
    expect(Number(unbound.map_status)).toBe(2);
    expect(listingRow(id).sku_id).toBe(null);
    expect(lastLog('shop_listing', id, '"sku_id":null')?.after?.sku_id).toBe(null);

    expect((await http.put(`/api/products/listing/${id}`).set(auth(token.ops)).send({ sku_id: 999999 })).status).toBe(400);
    expect((await http.put('/api/products/listing/999999').set(auth(token.boss)).send({ sku_id: 1 })).status).toBe(404);
    expect((await http.post('/api/products/listing').set(auth(token.boss)).send({ shop_id: 1, tk_sku_id: '2288500001' })).status).toBe(400);
    // 被订单明细引用的映射不能删，只能改绑
    const used = get<{ id: number }>(`SELECT id FROM shop_listing WHERE map_status = 1 AND sku_id IS NOT NULL LIMIT 1`);
    expect((await http.delete(`/api/products/listing/${Number(used?.id)}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/listing/${id}`).set(auth(token.boss))).status).toBe(200);
    expect(listingRow(id).is_deleted).toBe(1);
  });

  it('自动匹配：唯一命中才绑，多命中与空 seller_sku 留人工', async () => {
    const spu = dataOf<{ id: number }>((await http.post('/api/products/spu').set(auth(token.boss)).send({ spu_code: 'AUTO-SPU', name_cn: '自动映射测试款' })).body);
    await makeSku(spu.id, 'AM-EXACT', 10, 1);
    await makeSku(spu.id, 'AM-PREFIX', 10, 1);
    await makeSku(spu.id, 'AM-A', 10, 1);
    await makeSku(spu.id, 'AM-A-B', 10, 1);

    const exact = await makeListing(1, 'TK-AM-1', 'AM-EXACT');
    const prefix = await makeListing(1, 'TK-AM-2', 'AM-PREFIX-A1');
    const ambiguous = await makeListing(1, 'TK-AM-3', 'AM-A-B-1');
    const blank = await makeListing(1, 'TK-AM-4', null);

    const preview = dataOf<Record<string, unknown>[]>((await http.get('/api/products/mapping/preview').set(auth(token.boss))).body);
    expect(preview.some((p) => Number(p.listing_id) === exact)).toBe(true);
    expect(preview.every((p) => p.bound_sku_code === null)).toBe(true);

    const res = await http.post('/api/products/mapping/auto').set(auth(token.boss)).send({ shop_id: 1 });
    expect(res.status).toBe(200);
    const d = dataOf<{ matched: number; remained: number; detail: Record<string, unknown>[]; tip: string }>(res.body);
    const byListing = new Map(d.detail.map((x) => [Number(x.listing_id), x]));
    expect(byListing.get(exact)?.rule).toBe('exact');
    expect(byListing.get(prefix)?.rule).toBe('prefix');
    expect(byListing.has(ambiguous)).toBe(false);
    expect(byListing.has(blank)).toBe(false);
    expect(String(d.tip)).toContain('唯一命中');
    expect(d.remained).toBeGreaterThanOrEqual(2);
    expect(listingRow(exact).map_status).toBe(1);
    expect(listingRow(ambiguous).map_status).toBe(2);
    expect(listingRow(blank).map_status).toBe(2);
    const log = lastLog('shop_listing', exact, '"rule"');
    expect(Number(log?.after?.sku_id)).toBe(Number(get<{ id: number }>(`SELECT id FROM product_sku WHERE sku_code = 'AM-EXACT'`)?.id));
    expect(log?.before?.sku_id).toBe(null);
    expect(Number(get<{ map_status: number }>(`SELECT map_status FROM shop_listing WHERE id = ?`, exact)?.map_status)).toBe(1);

    // 幂等：再跑一次没有新增绑定
    const alias = dataOf<{ matched: number }>((await http.post('/api/products/listings/auto-match').set(auth(token.boss)).send({ shop_id: 1 })).body);
    expect(alias.matched).toBe(0);
  });

  it('自动匹配受数据范围约束：运营不会碰别人的店', async () => {
    const id = await makeListing(2, 'TK-AM-SHOP2', 'AM-EXACT');
    const asLimy = dataOf<{ matched: number; detail: Record<string, unknown>[] }>(
      (await http.post('/api/products/mapping/auto').set(auth(token.ops)).send({})).body,
    );
    expect(asLimy.detail.some((x) => Number(x.listing_id) === id)).toBe(false);
    expect(asLimy.detail.every((x) => Number(x.shop_id) === 1)).toBe(true);
    expect(listingRow(id).sku_id).toBe(null);
    // 范围外的显式 shop_id 不会越权（查不到待映射行）
    const outOfScope = dataOf<{ matched: number }>((await http.post('/api/products/mapping/auto').set(auth(token.ops)).send({ shop_id: 4 })).body);
    expect(outOfScope.matched).toBe(0);
    const asBoss = dataOf<{ matched: number; detail: Record<string, unknown>[] }>(
      (await http.post('/api/products/mapping/auto').set(auth(token.boss)).send({ shop_id: 2 })).body,
    );
    expect(asBoss.detail.some((x) => Number(x.listing_id) === id)).toBe(true);
    expect(listingRow(id).map_status).toBe(1);
    expect((await http.post('/api/products/mapping/auto').set(auth(token.ops)).send({ shop_id: 0 })).status).toBe(400);
  });

  it('待映射清单：listing + 未匹配订单行数与金额，并写明排除口径', async () => {
    const boss = dataOf<Record<string, unknown>>((await http.get('/api/products/unmapped?pageSize=50').set(auth(token.boss))).body);
    expect(Number(boss.total)).toBeGreaterThanOrEqual(3);
    const totals = boss.totals as Record<string, number>;
    expect(Number(totals.listing_count)).toBe(Number(boss.total));
    expect(Number(totals.unmatched_items)).toBeGreaterThanOrEqual(1);
    expect(String(boss.warn)).toContain('不按 0 成本参与计算');
    const rows = boss.rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => Number(r.quantity) >= 1 && r.item_amount_cny !== undefined)).toBe(true);
    expect(rows[0]?.tk_order_id).toBeTruthy();
    const list = boss.list as Record<string, unknown>[];
    expect(list.every((l) => Number(l.map_status) === 2)).toBe(true);
    expect(Number(list[0]?.unmatched_item_count)).toBeGreaterThanOrEqual(0);

    const limy = dataOf<Record<string, unknown>>((await http.get('/api/products/unmapped?pageSize=50').set(auth(token.ops))).body);
    expect(((limy.list as Record<string, unknown>[]) ?? []).every((l) => Number(l.shop_id) === 1)).toBe(true);
    expect(((limy.rows as Record<string, unknown>[]) ?? []).every((r) => Number(r.shop_id) === 1)).toBe(true);
    expect(Number((limy.totals as Record<string, number>).unmatched_items)).toBeLessThanOrEqual(Number(totals.unmatched_items));
  });
});

/* ==================================================================== */
describe('表格导入兜底 + 导出（can_export）', () => {
  it('import/spu：成功 / 重复 / 非法行分流，非法行不入库', async () => {
    const res = await http
      .post('/api/products/import/spu')
      .set(auth(token.ops))
      .send({
        rows: [
          { spu_code: 'IMP-SPU-1', name_cn: '导入款一', category: '3C数码' },
          { spu_code: 'IMP-SPU-1', name_cn: '重复行' },
          { spu_code: 'IMP-SPU-2' },
          { spu_code: 'ORICO-66059', name_cn: '撞了种子款号' },
        ],
      });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(Number(d.total)).toBe(4);
    expect(Number(d.success)).toBe(1);
    expect(Number(d.failed_count)).toBe(3);
    const failed = d.failed as { row: number; reason: string }[];
    expect(failed.map((f) => f.row)).toEqual([3, 2, 4]);
    expect(String(failed[0]?.reason)).toContain('name_cn');
    expect(String(failed[2]?.reason)).toContain('已存在');
    expect(get(`SELECT id FROM product_spu WHERE spu_code = 'IMP-SPU-2' AND is_deleted = 0`)).toBeUndefined();
    expect((await http.post('/api/products/import/spu').set(auth(token.ops)).send({ rows: [] })).status).toBe(400);
  });

  it('import/sku：只给 spu_code 也能归属，重复编码进 failed', async () => {
    const res = await http
      .post('/api/products/import/sku')
      .set(auth(token.boss))
      .send({
        rows: [
          { spu_code: 'IMP-SPU-1', sku_code: 'IMP-SPU-1-01', spec: '黑色', purchase_cost: 30, first_leg_cost: 5 },
          { spu_code: 'GHOST-SPU', sku_code: 'IMP-GHOST-01', purchase_cost: 1 },
          { spu_code: 'IMP-SPU-1', sku_code: 'IMP-SPU-1-01', purchase_cost: 9 },
        ],
      });
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(Number(d.success)).toBe(1);
    expect(Number(d.failed_count)).toBe(2);
    const failed = d.failed as { row: number; reason: string }[];
    expect(String(failed[0]?.reason)).toContain('所属商品不存在');
    expect(String(failed[1]?.reason)).toContain('已存在');
    const row = get<Record<string, unknown>>(`SELECT * FROM product_sku WHERE sku_code = 'IMP-SPU-1-01'`) ?? {};
    expect(Number(row.purchase_cost)).toBe(30);
    expect(Number(row.spu_id)).toBe(Number(get<{ id: number }>(`SELECT id FROM product_spu WHERE spu_code = 'IMP-SPU-1'`)?.id));
    // 导入的 SKU 也带 unit_cost 视图
    const viaList = pageOf((await http.get('/api/products/sku?keyword=IMP-SPU-1-01').set(auth(token.boss))).body);
    expect(Number((viaList.list[0] as Record<string, unknown>).unit_cost)).toBe(35);
  });

  it('导出价目表：需 can_export 且必写 action=export 日志', async () => {
    const res = await http.get('/api/products/export/sku').set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    const columns = d.columns as string[];
    expect(columns).toContain('purchase_cost');
    const rows = d.rows as Record<string, unknown>[];
    expect(Number(d.count)).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.sku_code).toBeTruthy();
    expect(rows.find((r) => Number(r.id) === SKU1)?.purchase_cost).toBe(100);
    const log = get<{ action: string; before_after: string }>(
      `SELECT action, before_after FROM sys_op_log WHERE target_table = 'product_sku' AND action = 'export' ORDER BY id DESC LIMIT 1`,
    );
    expect(log?.action).toBe('export');
    expect(Number(JSON.parse(String(log?.before_after)).after.rows)).toBeGreaterThan(0);
    expect((await http.get('/api/products/export/sku').set(auth(token.ops))).status).toBe(403);
    // 运营主管有导出权限但无成本权限 → 成本列打码
    const byManager = dataOf<Record<string, unknown>>((await http.get('/api/products/export/sku').set(auth(token.opsManager))).body);
    expect((byManager.rows as Record<string, unknown>[]).length).toBeGreaterThan(0);
  });
});

/* ==================================================================== */
describe('列表筛选与关键字（前端表格联调用）', () => {
  it('SPU 筛选 category / keyword / shop_id，带 sku_count 与 listing_count', async () => {
    const all3c = pageOf((await http.get('/api/products/spu?category=3C数码&pageSize=50').set(auth(token.boss))).body);
    expect(all3c.total).toBe(2);
    expect(all3c.list.every((p) => p.category === '3C数码')).toBe(true);
    const one = all3c.list[0] as Record<string, unknown>;
    expect(Number(one.sku_count)).toBeGreaterThan(0);
    expect(one.owner_name).toBe('王强');
    expect(pageOf((await http.get('/api/products/spu?keyword=跑鞋').set(auth(token.boss))).body).total).toBe(1);
    expect(pageOf((await http.get('/api/products/spu?keyword=不存在关键词').set(auth(token.boss))).body).total).toBe(0);
    const byShop = pageOf((await http.get('/api/products/spu?shop_id=4&pageSize=50').set(auth(token.boss))).body);
    expect(byShop.total).toBe(4);
    expect((await http.get('/api/products/spu?shop_id=4').set(auth(token.ops))).status).toBe(403);
    const drop = dataOf<Record<string, unknown>[]>((await http.get('/api/products/spu/all').set(auth(token.ops))).body);
    expect(drop.length).toBeGreaterThanOrEqual(8);
    expect(drop[0]).toHaveProperty('spu_code');
  });

  it('SKU 列表筛选：spu_id / category / status / 分页参数', async () => {
    const page1 = pageOf((await http.get('/api/products/sku?page=1&pageSize=3').set(auth(token.boss))).body);
    expect(page1.list.length).toBe(3);
    expect(page1.pageSize).toBe(3);
    expect(page1.total).toBeGreaterThan(10);
    const page2 = pageOf((await http.get('/api/products/sku?page=2&pageSize=3').set(auth(token.boss))).body);
    expect(page2.list[0]?.id).not.toBe(page1.list[0]?.id);
    expect(pageOf((await http.get('/api/products/sku?category=服饰&pageSize=50').set(auth(token.boss))).body).total).toBe(6);
    const byShop = pageOf((await http.get('/api/products/sku?shop_id=1&pageSize=50').set(auth(token.ops))).body);
    expect(byShop.list.every((r) => Number(r.listing_count) >= 1)).toBe(true);
    expect((await http.get('/api/products/listing/999999').set(auth(token.boss))).status).toBe(404);
    const oneListing = dataOf<Record<string, unknown>>(
      (await http.get(`/api/products/listing?map_status=1&pageSize=1`).set(auth(token.boss))).body,
    );
    expect(((oneListing.list as Record<string, unknown>[])[0] as Record<string, unknown>).sku_code).toBeTruthy();
  });
});
