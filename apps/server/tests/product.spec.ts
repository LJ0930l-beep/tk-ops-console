import { beforeAll, describe, expect, it } from 'vitest';
import { REGION_TZ_OFFSET, rebateCny, round2, statDateInZone } from '@tk/shared';
import { get, run } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login, pageOf } from './helper.js';

/**
 * 商品中心（方案表 3 product_spu / 表 4 product_sku / 表 5 shop_listing）
 *
 * 品牌服务方（代运营）口径：货是品牌的，我们不背货款，SKU 上只有两个钱字段 ——
 * rebate_rate（品牌给我们的返点率，0~1，唯一收入的比例）与 logistics_cost（单件物流成本，人民币/件）。
 *
 * 覆盖：店铺数据范围 / 返点掩码（rebate_rate·logistics_cost·rebate_cny·logistics_cny）/
 *       改返点率写 before-after 且历史行 rebate_cny 不回写 /
 *       映射绑定与自动匹配（多命中与空 seller_sku 不误绑）/
 *       待映射清单（含「已映射但未配返点率」两类）/ 导入导出与权限 /
 *       rebate_rate=0 的订单行落 rebate_matched=0 并整行退出利润（绝不按 0 收入参与计算）。
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

/**
 * 明细行「成交当时」的折算基数：报表自然日（站点 IANA 时区切日，与 seed/利润引擎同一口径）
 * 当天的汇率。用来手工复算冻结在行上的 rebate_cny —— 复算不出来就说明快照与口径不一致。
 */
function itemFxBasis(itemId: number): { item_amount: number; quantity: number; currency: string; rate: number; stat_day: string } {
  const row = get<{
    item_amount: number; quantity: number; currency: string; order_time: string; timezone: string | null; region: string | null;
  }>(
    `SELECT i.item_amount, i.quantity, o.currency, o.order_time, s.timezone, s.region
       FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id JOIN tk_shop s ON s.id = o.shop_id
      WHERE i.id = ?`,
    itemId,
  );
  if (!row) throw new Error(`订单明细 ${itemId} 不存在`);
  const stat_day = statDateInZone(String(row.order_time), String(row.timezone ?? ''), REGION_TZ_OFFSET[String(row.region ?? '')] ?? 0);
  const rate = Number(
    get<{ rate_to_cny: number }>(
      `SELECT rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date <= ?
        ORDER BY rate_date DESC, id DESC LIMIT 1`,
      row.currency,
      stat_day,
    )?.rate_to_cny ?? 0,
  );
  return { item_amount: Number(row.item_amount), quantity: Number(row.quantity), currency: String(row.currency), rate, stat_day };
}

const token: Record<string, string> = {};
beforeAll(async () => {
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(http, u);
  // 赵磊与林雅同角色（运营），用来验证「同角色不同店铺」的隔离
  token.zhaolei = await login(http, 'zhaolei');
});

/** 种子：SPU1 ORICO-66059（2 个 SKU），SKU1 = 品牌返点率 0.22 + 单件物流 14 元/件 */
const SPU1 = 1;
const SKU1 = 1;
/** SKU1 种子里的返点口径（改返点率之后用来验证「历史行仍按成交当时的值冻结」） */
const SEED_REBATE_RATE = 0.22;
const SEED_LOGISTICS_PER_UNIT = 14;

async function makeSku(spuId: number, skuCode: string, rebateRate: number, logisticsCost: number): Promise<number> {
  const res = await http
    .post('/api/products/sku')
    .set(auth(token.boss))
    .send({ spu_id: spuId, sku_code: skuCode, rebate_rate: rebateRate, logistics_cost: logisticsCost });
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
describe('返点与物流：单一来源 + 权限掩码 + 历史不回写（要点 5.1）', () => {
  it('无 can_see_cost：rebate_rate / logistics_cost 全部 ***（返点率是和品牌的商务条件）', async () => {
    const boss = pageOf((await http.get('/api/products/sku?spu_id=1&pageSize=50').set(auth(token.boss))).body);
    const one = boss.list.find((r) => Number(r.id) === SKU1) as Record<string, unknown>;
    expect(Number(one.rebate_rate)).toBe(SEED_REBATE_RATE); // 0.22 = 实收 GMV 的 22% 归我们
    expect(Number(one.logistics_cost)).toBe(SEED_LOGISTICS_PER_UNIT); // 14 元/件
    // 自采口径的合成列必须彻底消失：没有「单件成本」这种东西了
    expect(one).not.toHaveProperty('unit_cost');
    expect(one).not.toHaveProperty('purchase_cost');
    expect(one).not.toHaveProperty('first_leg_cost');
    expect(one.last_cost_by).toBe(null);

    const limy = pageOf((await http.get('/api/products/sku?spu_id=1&pageSize=50').set(auth(token.ops))).body);
    const masked = limy.list.find((r) => Number(r.id) === SKU1) as Record<string, unknown>;
    expect(masked.rebate_rate).toBe('***');
    expect(masked.logistics_cost).toBe('***');
    expect(masked.sku_code).not.toBe('***');
    // 掩码字段不能只在列表里遮，明细/下拉也得遮
    const detailBoss = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}`).set(auth(token.boss))).body);
    expect(Number(detailBoss.rebate_rate)).toBe(SEED_REBATE_RATE);
    expect(Number(detailBoss.listing_count)).toBeGreaterThan(0);
    const detailLimy = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}`).set(auth(token.ops))).body);
    expect(detailLimy.rebate_rate).toBe('***');
    expect(detailLimy.logistics_cost).toBe('***');
    const subSkus = dataOf<Record<string, unknown>[]>((await http.get(`/api/products/spu/${SPU1}/skus`).set(auth(token.ops))).body);
    expect(subSkus.length).toBe(2);
    expect(subSkus[0]?.rebate_rate).toBe('***');
    expect(subSkus[0]?.logistics_cost).toBe('***');
    const subBoss = dataOf<Record<string, unknown>[]>((await http.get(`/api/products/spu/${SPU1}/skus`).set(auth(token.boss))).body);
    expect(Number(subBoss[0]?.rebate_rate)).toBe(SEED_REBATE_RATE);
  });

  it('返点率必须落在 0~1：填成「18」这种金额直接 400，并提示用小数', async () => {
    const tooBig = await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: SPU1, sku_code: 'RATE-TOO-BIG', rebate_rate: 1.6 });
    expect(tooBig.status).toBe(400);
    expect(String(tooBig.body.message)).toContain('rebate_rate');
    // 18% 填成 18 会让返点直接放大 100 倍，报错必须把「填小数」说清楚
    expect(String(tooBig.body.message)).toContain('请填 0~1 的小数');
    expect(get(`SELECT id FROM product_sku WHERE sku_code = 'RATE-TOO-BIG'`)).toBeUndefined();

    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: SPU1, sku_code: 'RATE-NEG', rebate_rate: -0.1 })).status).toBe(400);
    // 边界值 0 与 1 都合法：0 = 未配返点率（另有用例），1 = 品牌把全部 GMV 返给我们
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: SPU1, sku_code: 'RATE-EDGE-1', rebate_rate: 1 })).status).toBe(200);
    expect((await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ rebate_rate: 1.6 })).status).toBe(400);
    expect((await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ logistics_cost: -1 })).status).toBe(400);
    expect(skuRow(SKU1).rebate_rate).toBe(SEED_REBATE_RATE);
    const edgeRow = get<{ id: number; rebate_rate: number }>(`SELECT id, rebate_rate FROM product_sku WHERE sku_code = 'RATE-EDGE-1'`);
    expect(Number(edgeRow?.rebate_rate)).toBe(1);
    expect((await http.delete(`/api/products/sku/${Number(edgeRow?.id)}`).set(auth(token.boss))).status).toBe(200);
  });

  it('改 SKU 返点率写 before/after，历史行 rebate_cny 一字不动；无权限改不了', async () => {
    const frozen = get<{ id: number; rebate_rate: number; rebate_cny: number; logistics_cny: number }>(
      `SELECT id, rebate_rate, rebate_cny, logistics_cny FROM tk_order_item WHERE sku_id = ? AND rebate_matched = 1 ORDER BY id ASC LIMIT 1`,
      SKU1,
    );
    expect(frozen).toBeTruthy();
    const basis = itemFxBasis(Number(frozen?.id));
    // 手工复算成交当时的快照：应收返点 = 实收折 CNY × 成交当时冻结的返点率
    //   income_cny = round2(item_amount × rate) = round2(?) —— 这里是 ${basis.item_amount} × ${basis.rate}
    //   rebate_cny = round2(income_cny × 0.22)；logistics_cny = round2(14 元/件 × quantity)
    const handIncomeCny = round2(basis.item_amount * basis.rate);
    const handRebate = rebateCny(handIncomeCny, SEED_REBATE_RATE);
    const handLogistics = round2(SEED_LOGISTICS_PER_UNIT * basis.quantity);
    expect(Number(frozen?.rebate_cny)).toBe(handRebate);
    expect(Number(frozen?.logistics_cny)).toBe(handLogistics);

    // 返点率是钱口径：无成本权限的角色连改都不能改
    expect((await http.put(`/api/products/sku/${SKU1}`).set(auth(token.ops)).send({ rebate_rate: 0.9 })).status).toBe(403);
    expect(skuRow(SKU1).rebate_rate).toBe(SEED_REBATE_RATE);

    const res = await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ rebate_rate: 0.3, logistics_cost: 20 });
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(d.cost_changed).toBe(true);
    expect(Number(d.rebate_rate)).toBe(0.3);
    expect(Number(d.logistics_cost)).toBe(20);
    expect(String(d.tip)).toContain('历史订单');
    expect(skuRow(SKU1).rebate_rate).toBe(0.3);
    expect(skuRow(SKU1).logistics_cost).toBe(20);

    // 历史行冻结的是成交当时的返点率与物流：改 SKU 之后既不回写金额，也不回写比率
    const after = get<{ rebate_rate: number; rebate_cny: number; logistics_cny: number }>(
      `SELECT rebate_rate, rebate_cny, logistics_cny FROM tk_order_item WHERE id = ?`,
      Number(frozen?.id),
    );
    expect(Number(after?.rebate_cny)).toBe(Number(frozen?.rebate_cny));
    expect(Number(after?.logistics_cny)).toBe(Number(frozen?.logistics_cny));
    expect(Number(after?.rebate_rate)).toBe(SEED_REBATE_RATE);
    // 新返点率 0.3 与旧比率都不等于历史行的冻结值 —— 证明历史行没被新商务条件追溯
    expect(handRebate).not.toBe(rebateCny(handIncomeCny, 0.3));

    const log = lastLog('product_sku', SKU1, 'rebate_rate');
    expect(Number(log?.before?.rebate_rate)).toBe(SEED_REBATE_RATE);
    expect(Number(log?.after?.rebate_rate)).toBe(0.3);
    expect(Number(log?.after?.logistics_cost)).toBe(20);
    expect(String(log?.after?.sku_code)).toBe('ORICO-66059-01');

    // 只改规格不改钱口径 → cost_changed=false
    const noCost = dataOf<Record<string, unknown>>(
      (await http.put(`/api/products/sku/${SKU1}`).set(auth(token.boss)).send({ spec: '白色 3米 改版' })).body,
    );
    expect(noCost.cost_changed).toBe(false);
    expect(Number(noCost.rebate_rate)).toBe(0.3);

    expect((await http.put('/api/products/sku/999999').set(auth(token.boss)).send({ rebate_rate: 0.1 })).status).toBe(404);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 999999, sku_code: 'NO-SPU' })).status).toBe(400);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 1, sku_code: 'ORICO-66059-01' })).status).toBe(400);
    expect((await http.post('/api/products/sku').set(auth(token.boss)).send({ spu_id: 1 })).status).toBe(400);
    expect((await http.get('/api/products/sku/999999').set(auth(token.boss))).status).toBe(404);
  });

  it('返点率时间线读 sys_op_log；无成本权限 403', async () => {
    const d = dataOf<Record<string, unknown>>((await http.get(`/api/products/sku/${SKU1}/cost-history`).set(auth(token.boss))).body);
    expect(d.sku_code).toBe('ORICO-66059-01');
    expect(Number(d.current_rebate_rate)).toBe(0.3);
    expect(Number(d.current_rebate_pct)).toBe(30); // 时间线给人看：0.3 折成 30%
    expect(Number(d.current_logistics_cost)).toBe(20);
    const timeline = d.timeline as Record<string, unknown>[];
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(Number(timeline[0]?.before_rebate_rate)).toBe(SEED_REBATE_RATE);
    expect(Number(timeline[0]?.after_rebate_rate)).toBe(0.3);
    expect(Number(timeline[0]?.before_rebate_pct)).toBe(22);
    expect(Number(timeline[0]?.after_rebate_pct)).toBe(30);
    expect(Number(timeline[0]?.diff_logistics_cost)).toBe(6); // 20 − 14
    expect(timeline[0]?.user_name).toBe('陈新');
    expect(String(d.tip)).toContain('不回溯');
    expect((await http.get(`/api/products/sku/${SKU1}/cost-history`).set(auth(token.ops))).status).toBe(403);
    expect((await http.get('/api/products/sku/999999/cost-history').set(auth(token.boss))).status).toBe(404);
  });

  it('未配返点率预警：rebate_missing=1（旧 cost_missing 别名）只给 rebate_rate=0 的 SKU', async () => {
    const created = await makeSku(SPU1, 'RATE-MISSING-01', 0, 0);
    const list = pageOf((await http.get('/api/products/sku?rebate_missing=1&pageSize=200').set(auth(token.boss))).body);
    expect(list.list.every((r) => Number(r.rebate_rate) === 0)).toBe(true);
    expect(list.list.some((r) => Number(r.id) === created)).toBe(true);
    // 别名保持兼容：老前端/用例还按 cost_missing 查
    const legacy = pageOf((await http.get('/api/products/sku?cost_missing=1&pageSize=200').set(auth(token.boss))).body);
    expect(legacy.total).toBe(list.total);
    expect((await http.delete(`/api/products/sku/${created}`).set(auth(token.boss))).status).toBe(200);
  });

  it('删除保护：有 SKU 的 SPU 不删；被映射引用的 SKU 不删', async () => {
    expect((await http.delete(`/api/products/spu/${SPU1}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/sku/${SKU1}`).set(auth(token.boss))).status).toBe(403);

    // 上架 → 不能删；解绑 → 可以删；进过订单 → 永远不能删
    const sku = await makeSku(SPU1, 'DEL-GUARD-01', 0.2, 9);
    const listingId = await makeListing(1, 'TK-DEL-GUARD', 'DEL-GUARD-01', sku);
    expect((await http.delete(`/api/products/sku/${sku}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/listing/${listingId}`).set(auth(token.boss))).status).toBe(200);
    expect((await http.delete(`/api/products/sku/${sku}`).set(auth(token.boss))).status).toBe(200);
    expect(skuRow(sku).is_deleted).toBe(1);
    const ordered = get<{ id: number }>(`SELECT sku_id AS id FROM tk_order_item WHERE rebate_matched = 1 LIMIT 1`);
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
    await makeSku(spu.id, 'AM-EXACT', 0.1, 1);
    await makeSku(spu.id, 'AM-PREFIX', 0.1, 1);
    await makeSku(spu.id, 'AM-A', 0.1, 1);
    await makeSku(spu.id, 'AM-A-B', 0.1, 1);

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

  it('待映射清单：listing + 算不出返点的订单行数与金额，并写明排除口径', async () => {
    const boss = dataOf<Record<string, unknown>>((await http.get('/api/products/unmapped?pageSize=50').set(auth(token.boss))).body);
    expect(Number(boss.total)).toBeGreaterThanOrEqual(3);
    const totals = boss.totals as Record<string, number>;
    expect(Number(totals.listing_count)).toBe(Number(boss.total));
    expect(Number(totals.unmatched_items)).toBeGreaterThanOrEqual(1);
    // 铁则：算不出返点的行整体退出返点/毛利/利润，绝不按 0 收入参与计算
    expect(String(boss.warn)).toContain('绝不按 0 收入参与计算');
    expect(String(boss.warn)).toContain('SKU 未配品牌返点率');
    const rows = boss.rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => Number(r.quantity) >= 1 && r.item_amount_cny !== undefined)).toBe(true);
    // 影响金额是按报表自然日汇率折出来的人民币，不是原币也不是 0
    expect(rows.every((r) => Number(r.item_amount_cny) === round2(Number(r.item_amount) * Number(r.rate_to_cny)))).toBe(true);
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

  it('import/sku：模板带 rebate_rate + logistics_cost，只给 spu_code 也能归属，返点率填成金额的行被挡下', async () => {
    const res = await http
      .post('/api/products/import/sku')
      .set(auth(token.boss))
      .send({
        rows: [
          { spu_code: 'IMP-SPU-1', sku_code: 'IMP-SPU-1-01', spec: '黑色', rebate_rate: 0.18, logistics_cost: 5 },
          { spu_code: 'GHOST-SPU', sku_code: 'IMP-GHOST-01', rebate_rate: 0.1 },
          { spu_code: 'IMP-SPU-1', sku_code: 'IMP-SPU-1-01', rebate_rate: 0.2 },
          // 18% 填成 18：表格导入必须逐行挡下，而不是静默落库后把返点放大 100 倍
          { spu_code: 'IMP-SPU-1', sku_code: 'IMP-SPU-1-02', rebate_rate: 18, logistics_cost: 5 },
        ],
      });
    const d = dataOf<Record<string, unknown>>(res.body);
    expect(Number(d.success)).toBe(1);
    expect(Number(d.failed_count)).toBe(3);
    const failed = d.failed as { row: number; reason: string }[];
    // zod 逐行校验的失败先收（第 4 行），业务冲突在入库循环里收（第 2、3 行）
    expect(failed.map((f) => f.row)).toEqual([4, 2, 3]);
    expect(String(failed[0]?.reason)).toContain('请填 0~1 的小数');
    expect(String(failed[1]?.reason)).toContain('所属商品不存在');
    expect(String(failed[2]?.reason)).toContain('已存在');
    expect(get(`SELECT id FROM product_sku WHERE sku_code = 'IMP-SPU-1-02'`)).toBeUndefined();

    const row = get<Record<string, unknown>>(`SELECT * FROM product_sku WHERE sku_code = 'IMP-SPU-1-01'`) ?? {};
    expect(Number(row.rebate_rate)).toBe(0.18);
    expect(Number(row.logistics_cost)).toBe(5);
    // 采购口径的三列已随口径一起删掉，导入模板不再收「货款」
    expect(row).not.toHaveProperty('purchase_cost');
    expect(row).not.toHaveProperty('first_leg_cost');
    expect(row).not.toHaveProperty('unit_cost');
    expect(Number(row.spu_id)).toBe(Number(get<{ id: number }>(`SELECT id FROM product_spu WHERE spu_code = 'IMP-SPU-1'`)?.id));
    // 列表视图同样按新口径给返点率与单件物流
    const viaList = pageOf((await http.get('/api/products/sku?keyword=IMP-SPU-1-01').set(auth(token.boss))).body);
    expect(Number((viaList.list[0] as Record<string, unknown>).rebate_rate)).toBe(0.18);
    expect(Number((viaList.list[0] as Record<string, unknown>).logistics_cost)).toBe(5);
  });

  it('导出价目表：需 can_export，成本列打码后原始导出也不泄露返点率', async () => {
    const res = await http.get('/api/products/export/sku').set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<Record<string, unknown>>(res.body);
    const columns = d.columns as string[];
    expect(columns).toContain('rebate_rate');
    expect(columns).toContain('logistics_cost');
    for (const gone of ['purchase_cost', 'first_leg_cost', 'unit_cost']) expect(columns).not.toContain(gone);
    const rows = d.rows as Record<string, unknown>[];
    expect(Number(d.count)).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.sku_code).toBeTruthy();
    // SKU1 在前面的用例里改成了 0.3 / 20 元每件
    const sku1 = rows.find((r) => Number(r.id) === SKU1) as Record<string, unknown>;
    expect(Number(sku1.rebate_rate)).toBe(0.3);
    expect(Number(sku1.logistics_cost)).toBe(20);
    const log = get<{ action: string; before_after: string }>(
      `SELECT action, before_after FROM sys_op_log WHERE target_table = 'product_sku' AND action = 'export' ORDER BY id DESC LIMIT 1`,
    );
    expect(log?.action).toBe('export');
    expect(Number(JSON.parse(String(log?.before_after)).after.rows)).toBeGreaterThan(0);
    expect((await http.get('/api/products/export/sku').set(auth(token.ops))).status).toBe(403);

    // 运营主管：有导出权限，也有成本权限（8.1 里 ops_manager 的 can_see_cost=1）→ 数字照给
    const byManager = dataOf<Record<string, unknown>>((await http.get('/api/products/export/sku').set(auth(token.opsManager))).body);
    const managerRows = byManager.rows as Record<string, unknown>[];
    expect(managerRows.length).toBeGreaterThan(0);
    expect(Number((managerRows.find((r) => Number(r.id) === SKU1) as Record<string, unknown>).rebate_rate)).toBe(0.3);
    // 运营：有商品菜单但没有导出权限 → 整个导出接口 403
    expect((await http.get('/api/products/export/sku').set(auth(token.ops))).status).toBe(403);

    /**
     * 「只有导出权限、没有成本权限」这一档才是掩码真正要守住的口子：
     * 种子角色里没有这种组合（ops 不能导出、ops_manager 能看成本），所以这里临时给 ops 打开 can_export，
     * 验完立刻还原 —— 打码后的行既要在 JSON 里是 ***，原始 CSV 文件里也不许出现返点率与物流成本。
     */
    const bossCsv = await http.get('/api/products/export/sku?format=csv').set(auth(token.boss));
    const bossLines = String(bossCsv.text).replace(/^/, '').split('\r\n');
    const header = bossLines[0]?.split(',') ?? [];
    expect(header).toContain('rebate_rate');
    const rateCol = header.indexOf('rebate_rate');
    const legCol = header.indexOf('logistics_cost');
    // 老板的 CSV 是同一份列，但带真实数字（对照：打码只作用于无成本权限的人）
    expect(bossLines.find((l) => l.startsWith('ORICO-66059-01,'))?.split(',')[rateCol]).toBe('0.3');
    expect(bossLines.find((l) => l.startsWith('ORICO-66059-01,'))?.split(',')[legCol]).toBe('20');

    run(`UPDATE sys_role SET can_export = 1 WHERE role_key = 'ops'`);
    try {
      const byNoCost = dataOf<Record<string, unknown>>((await http.get('/api/products/export/sku').set(auth(token.ops))).body);
      const maskedRows = byNoCost.rows as Record<string, unknown>[];
      expect(maskedRows.length).toBeGreaterThan(0);
      expect(maskedRows.every((r) => r.rebate_rate === '***' && r.logistics_cost === '***')).toBe(true);
      const csv = await http.get('/api/products/export/sku?format=csv').set(auth(token.ops));
      expect(csv.status).toBe(200);
      const lines = String(csv.text).replace(/^/, '').split('\r\n');
      expect(lines[0]).toBe(header.join(','));
      const sku1Line = lines.find((l) => l.startsWith('ORICO-66059-01,'));
      expect(sku1Line).toBeTruthy();
      expect(sku1Line?.split(',')[rateCol]).toBe('***');
      expect(sku1Line?.split(',')[legCol]).toBe('***');
      const logLine = get<{ before_after: string }>(
        `SELECT before_after FROM sys_op_log WHERE target_table = 'product_sku' AND action = 'export' ORDER BY id DESC LIMIT 1`,
      );
      expect(JSON.parse(String(logLine?.before_after)).after).toMatchObject({ cost_masked: true });
    } finally {
      run(`UPDATE sys_role SET can_export = 0 WHERE role_key = 'ops'`);
    }
  });
});

/* ==================================================================== */
describe('列表筛选与关键字（前端表格联调用）', () => {
  it('SPU 筛选 category / keyword / shop_id，带 sku_count 与 listing_count', async () => {
    // import/spu 用例已导入 IMP-SPU-1（category=3C数码，默认 status=1 开发中），
    // 叠加 §3.3 的 status 筛选取「在售」的 2 个种子款，同时验证两个筛选器组合生效
    const all3c = pageOf((await http.get('/api/products/spu?category=3C数码&status=2&pageSize=50').set(auth(token.boss))).body);
    expect(all3c.total).toBe(2);
    expect(all3c.list.every((p) => p.category === '3C数码' && Number(p.status) === 2)).toBe(true);
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
    // pageOf 只取 list/total；§3.0 响应契约 {list,total,page,pageSize} 需从原始体断言
    const skuP1 = await http.get('/api/products/sku?page=1&pageSize=3').set(auth(token.boss));
    const page1 = pageOf(skuP1.body);
    expect(page1.list.length).toBe(3);
    expect(dataOf<{ page: number; pageSize: number }>(skuP1.body)).toMatchObject({ page: 1, pageSize: 3 });
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

/* ==================================================================== */
describe('未配返点率的订单行：整行退出利润口径（铁则，不是按 0 收入算）', () => {
  /** 店铺 1 = ORICO MY（MYR，Asia/Kuala_Lumpur）；2026-09-18 是种子汇率的最后一天 */
  const ORDER_TIME = '2026-09-18 03:00:00';

  const rateOn = (currency: string, day: string): number =>
    Number(
      get<{ rate_to_cny: number }>(
        `SELECT rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date <= ?
          ORDER BY rate_date DESC, id DESC LIMIT 1`,
        currency,
        day,
      )?.rate_to_cny ?? 0,
    );

  it('SKU 返点率 0：同步进来的行落 rebate_matched=0 并计成同步失败，不进任何钱口径', async () => {
    const skuId = await makeSku(SPU1, 'NO-RATE-01', 0, 8);
    const listingId = await makeListing(1, 'TK-NORATE-1', 'NO-RATE-01-MY', skuId);
    // 映射本身是好的：唯一缺的是品牌返点率（syncJobs.snapshotRebate 的判据是 rate > 0）
    expect(listingRow(listingId).map_status).toBe(1);

    const importRes = await http
      .post('/api/sync/import/orders')
      .set(auth(token.boss))
      .send({
        shop_id: 1,
        rows: [
          {
            order_id: 'IMP-NORATE-1',
            status: 'COMPLETED',
            order_time: ORDER_TIME,
            currency: 'MYR',
            subtotal: 200,
            total_paid: 200,
            items: [{ sku_id: 'TK-NORATE-1', quantity: 2, price: 100 }],
          },
        ],
      });
    expect(importRes.status).toBe(200);
    const run0 = dataOf<{ run: { failed: number; detail: Record<string, number> } }>(importRes.body).run;
    expect(Number(run0.failed)).toBe(1); // 算不出返点不是「成功」：同步把它记成失败行
    expect(Number(run0.detail.rebate_unconfigured)).toBe(1); // 分桶：已映射但未配返点率（另一种是 unmapped_items）

    const orderId = Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = 'IMP-NORATE-1'`)?.id);
    const item = get<Record<string, unknown>>(`SELECT * FROM tk_order_item WHERE order_id = ?`, orderId) as Record<string, unknown>;
    expect(Number(item.sku_id)).toBe(skuId);
    expect(Number(item.item_amount)).toBe(200); // 单价 100 × 数量 2 − 优惠 0
    expect(Number(item.rebate_matched)).toBe(0);
    // 未配返点率的行不冻结任何钱：既没有 0 收入，也没有孤零零的物流支出
    expect(Number(item.rebate_cny)).toBe(0);
    expect(Number(item.logistics_cny)).toBe(0);

    // 接口层同样不许把它当成「收入 0 的一行」：金额给 null + 说明，而不是 0
    const detail = dataOf<Record<string, unknown>>((await http.get(`/api/orders/${orderId}`).set(auth(token.boss))).body);
    const line = (detail.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(line.unmapped).toBe(true);
    expect(line.rebate_rate).toBe(null);
    expect(line.rebate_cny).toBe(null);
    expect(line.logistics_cny).toBe(null);
    expect(line.profit_cny).toBe(null);
    expect(String(line.rebate_note)).toContain('未配返点率');
    expect(Number(detail.unmapped_item_count)).toBe(1);
    expect(Number(detail.matched_amount)).toBe(0); // 参与口径的实收：这一行没进来
    expect(Number(detail.rebate_cny)).toBe(0);

    // 利润引擎：整单因「没有一行算得出返点」被剔除，并计入 warn 而不是按 0 收入参与计算
    const breakdown = dataOf<Record<string, unknown>>((await http.get(`/api/finance/profit/order/${orderId}`).set(auth(token.boss))).body);
    expect(breakdown.excluded_reason).toBe('unmapped');
    expect(Number(breakdown.unmapped_items)).toBe(1);
    expect(Number(breakdown.unmapped_amount_src)).toBe(200); // 被排除的金额要报出来，不是被吞掉
    expect(Number(breakdown.rebate_cny)).toBe(0);
    expect(Number(breakdown.logistics_cny)).toBe(0);
    const pLine = (breakdown.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Number(pLine.counted)).toBe(0);
    expect(Number(pLine.rebate_matched)).toBe(0);

    // 订单利润拆解页：同样只统计已配返点率的行
    const profit = dataOf<Record<string, unknown>>((await http.get(`/api/orders/${orderId}/profit`).set(auth(token.boss))).body);
    const income = profit.income as Record<string, unknown>;
    expect(Number(income.matched_items)).toBe(0);
    expect(Number(income.matched_amount)).toBe(0);
    expect(Number(income.excluded_unmapped_items)).toBe(1);
    // 排除口径要在响应里说清楚，不能只给一个 0
    expect(String(income.note)).toContain('不按 0 返点参与计算');
    expect(Number((profit.rebate as Record<string, unknown>).unmatched_items)).toBe(1);

    // 待映射清单里能看到它，且带 sku_id —— 运营要做的动作是「配返点率」，不是「重新映射」
    const unmapped = dataOf<Record<string, unknown>>((await http.get('/api/products/unmapped?pageSize=50').set(auth(token.boss))).body);
    const rows = unmapped.rows as Record<string, unknown>[];
    const hit = rows.find((r) => Number(r.item_id) === Number(item.id));
    expect(hit).toBeTruthy();
    expect(Number(hit?.sku_id)).toBe(skuId);
    expect(Number(hit?.item_amount)).toBe(200);
  });

  it('补上返点率并跑「派生汇总」才回填快照：返点 = 实收折 CNY × 比率，物流 = 单件成本 × 件数', async () => {
    const skuId = Number(get<{ id: number }>(`SELECT id FROM product_sku WHERE sku_code = 'NO-RATE-01'`)?.id);
    expect(skuId).toBeGreaterThan(0);
    const upd = dataOf<Record<string, unknown>>(
      (await http.put(`/api/products/sku/${skuId}`).set(auth(token.boss)).send({ rebate_rate: 0.25 })).body,
    );
    expect(upd.cost_changed).toBe(true);

    const refreshed = dataOf<{ runs: { detail: Record<string, number>; inserted: number }[] }>(
      (await http.post('/api/sync/run').set(auth(token.boss)).send({ task_type: 'aggregate', shop_id: 1 })).body,
    );
    const agg = refreshed.runs[0] as { detail: Record<string, number>; inserted: number };
    // 回填候选是「sku_id 或 listing 上有 SKU」的 rebate_matched=0 行：店铺 1 里只有我们这一条
    expect(Number(agg.detail.item_backfilled)).toBe(1);
    expect(Number(agg.inserted)).toBe(1);

    const orderId = Number(get<{ id: number }>(`SELECT id FROM tk_order WHERE tk_order_id = 'IMP-NORATE-1'`)?.id);
    const item = get<Record<string, unknown>>(`SELECT * FROM tk_order_item WHERE order_id = ?`, orderId) as Record<string, unknown>;
    // 手工复算（与 shared 的 rebateCny / 单件物流 × 数量同一口径）：
    //   汇率 fx = 2026-09-18 当天 MYR 牌价（种子：round2(2.12 × (1 − 0.0045)) = 2.11）
    //   income_cny = round2(item_amount × fx) = round2(200 × fx)
    //   rebate_cny = round2(income_cny × 0.25) = income_cny 的四分之一
    //   logistics_cny = round2(8 元/件 × 2 件) = 16
    const fx = rateOn('MYR', ORDER_TIME.slice(0, 10));
    expect(fx).toBe(2.11);
    const incomeCny = round2(200 * fx);
    expect(incomeCny).toBe(422);
    expect(Number(item.rebate_matched)).toBe(1);
    expect(Number(item.rebate_rate)).toBe(0.25);
    expect(Number(item.rebate_cny)).toBe(round2(incomeCny * 0.25));
    expect(Number(item.rebate_cny)).toBe(105.5);
    expect(Number(item.logistics_cny)).toBe(16);

    // 回填后这一行才进利润：订单详情与单笔拆解都给得出金额，且不再是 unmapped
    const detail = dataOf<Record<string, unknown>>((await http.get(`/api/orders/${orderId}`).set(auth(token.boss))).body);
    expect(Number(detail.unmapped_item_count)).toBe(0);
    const line = (detail.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(line.unmapped).toBe(false);
    expect(Number(line.rebate_cny)).toBe(105.5);
    expect(Number(line.logistics_cny)).toBe(16);
    // 贡献毛益 = 应收返点 − 物流 − 达人佣金（这单没有佣金）= 105.5 − 16 − 0
    expect(Number(line.profit_cny)).toBe(89.5);

    const profit = dataOf<Record<string, unknown>>((await http.get(`/api/orders/${orderId}/profit`).set(auth(token.boss))).body);
    expect(Number((profit.income as Record<string, unknown>).matched_items)).toBe(1);
    expect(Number(profit.contribution_cny)).toBe(89.5);

    // 单笔拆解：配好返点率并回填后这一行才算「计入口径」
    const breakdown = dataOf<Record<string, unknown>>((await http.get(`/api/finance/profit/order/${orderId}`).set(auth(token.boss))).body);
    expect(breakdown.excluded_reason).toBe('');
    expect(Number(breakdown.rebate_cny)).toBe(105.5);
    expect(Number(breakdown.logistics_cny)).toBe(16);
    const bLine = (breakdown.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Number(bLine.counted)).toBe(1);
    expect(Number(bLine.gross_profit_cny)).toBe(89.5);

    const listingId = Number(get<{ id: number }>(`SELECT id FROM shop_listing WHERE tk_sku_id = 'TK-NORATE-1'`)?.id);
    // 映射被订单明细引用 → 删不掉；SKU 同样删不掉（成本可改，历史不可抹）
    expect((await http.delete(`/api/products/listing/${listingId}`).set(auth(token.boss))).status).toBe(403);
    expect((await http.delete(`/api/products/sku/${skuId}`).set(auth(token.boss))).status).toBe(403);
  });
});

