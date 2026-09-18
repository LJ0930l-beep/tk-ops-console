/**
 * 商品中心（方案表 3 product_spu / 表 4 product_sku / 表 5 shop_listing）
 *
 * 两条口径必须守住：
 *  1. 成本只维护在 product_sku 一处；改 purchase_cost / first_leg_cost 只影响**之后**同步进来的订单，
 *     历史 tk_order_item.cost_snapshot 是落库时冻结的快照，本文件任何接口都不回写。
 *  2. 映射关系（shop_listing.sku_id）是利润准不准的命门，绑定前后一律写 sys_op_log before/after；
 *     shop_listing 有店铺维度，所有列表接口走 shopScope 隔离；成本字段按 can_see_cost 掩码。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { DATA_SCOPE, MAP_STATUS, round2, unitCostCny, type CurrentUser } from '@tk/shared';
import { all, get, insert, scalar, softDelete, tx, update, type SqlParam } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { maskFields, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, writeOpLog } from '../core/oplog.js';

const MODULE = '商品中心';
/** 无成本查看权限时要掩码的字段 */
const SKU_COST_FIELDS = ['purchase_cost', 'first_leg_cost', 'unit_cost'];

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

/** zod nullish 字段在未传时是 undefined，落库必须跳过该列而不是写 null */
function rowOf(body: object): Record<string, SqlParam> {
  const out: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v as SqlParam;
  return out;
}

/** shopScope 给的是 'AND xxx IN (?)'，Q 内部自己拼 AND，所以并条件时要剥掉前缀（scope 为空则不产生条件） */
const withScope = (q: Q, scope: { sql: string; params: number[] }): Q => q.and(scope.sql.replace(/^\s*AND\s+/i, ''), ...scope.params);

/** 按订单日期取汇率，取不到用该币种最近一天，再取不到用 1（与订单中心 /unmapped 同一口径） */
const RATE_TO_CNY = `(SELECT e.rate_to_cny
             FROM exchange_rate e
            WHERE e.currency = o.currency AND e.is_deleted = 0
            ORDER BY (e.rate_date <= COALESCE(substr(o.order_time, 1, 10), '9999-12-31')) DESC, e.rate_date DESC
            LIMIT 1)`;

/** 该店铺是否落在当前用户的数据范围内（写接口与显式 shop_id 筛选用） */
function assertShopInScope(user: CurrentUser, shopId: number | null | undefined): void {
  if (shopId === null || shopId === undefined) return;
  if (user.data_scope === DATA_SCOPE.ALL) return;
  const scope = shopScope(user, 's.id');
  if (!scope.sql) return;
  const hit = get<{ hit: number }>(`SELECT 1 AS hit FROM tk_shop s WHERE s.id = ? ${scope.sql}`, shopId, ...scope.params);
  if (!hit) throw forbidden(`店铺 #${shopId} 不在你的数据范围内`);
}

/* ==================== 入参校验 ==================== */

const spuBody = z.object({
  spu_code: z.string().min(1).max(64),
  name_cn: z.string().min(1).max(200),
  name_en: z.string().max(300).nullish(),
  category: z.string().max(100).nullish(),
  main_image: z.string().max(500).nullish(),
  owner_id: z.number().int().nullish(),
  status: z.number().int().min(1).max(3).default(1),
});

const skuBody = z.object({
  spu_id: z.number().int().positive(),
  sku_code: z.string().min(1).max(64),
  spec: z.string().max(200).nullish(),
  purchase_cost: z.number().min(0).default(0),
  first_leg_cost: z.number().min(0).default(0),
  weight_g: z.number().int().min(0).nullish(),
  package_size: z.string().max(50).nullish(),
  status: z.number().int().min(0).max(1).default(1),
});

const listingBody = z.object({
  shop_id: z.number().int().positive(),
  // 0 = 清空绑定（前端「解绑」按钮传法），落库归一为 null 并回落 map_status=2
  sku_id: z.number().int().min(0).nullish(),
  tk_product_id: z.string().max(64).nullish(),
  tk_sku_id: z.string().max(64).nullish(),
  seller_sku: z.string().max(100).nullish(),
  product_name: z.string().max(300).nullish(),
  sale_price: z.number().min(0).default(0),
  listing_status: z.number().int().min(1).max(5).default(1),
});

export const productRouter = Router();

/* ==================== 只读字典：登录即可（其他模块建单也要选类目） ==================== */

productRouter.get(
  '/categories',
  wrap((_req, res) =>
    ok(res, all(`SELECT dict_value, dict_label, sort FROM sys_dict WHERE dict_type = 'category' AND status = 1 AND is_deleted = 0 ORDER BY sort ASC, id ASC`)),
  ),
);

productRouter.use(requireMenu('product'));

/* ==================== 表 3 SPU ==================== */

function spuListQ(req: Parameters<typeof current>[0]): { q: Q } {
  const user = current(req);
  const q = new Q('p.is_deleted = 0')
    .like('(p.spu_code LIKE ? OR p.name_cn LIKE ? OR p.name_en LIKE ?)', qv(req, 'keyword'))
    .eq('p.category', qv(req, 'category'), false)
    .eq('p.status', qv(req, 'status'))
    .eq('p.owner_id', qv(req, 'owner_id'));
  const shopId = qv(req, 'shop_id');
  if (shopId) {
    assertShopInScope(user, Number(shopId));
    q.and(
      `EXISTS (SELECT 1 FROM product_sku ks JOIN shop_listing kl ON kl.sku_id = ks.id AND kl.is_deleted = 0
                WHERE ks.spu_id = p.id AND ks.is_deleted = 0 AND kl.shop_id = ?)`,
      Number(shopId),
    );
  }
  return { q };
}

productRouter.get(
  '/spu',
  wrap((req, res) => {
    const { q } = spuListQ(req);
    ok(
      res,
      queryPage(req, {
        from: `product_spu p LEFT JOIN sys_user u ON u.id = p.owner_id`,
        select: `p.*, u.real_name AS owner_name,
                 (SELECT COUNT(*) FROM product_sku k WHERE k.spu_id = p.id AND k.is_deleted = 0) AS sku_count,
                 (SELECT COUNT(*) FROM shop_listing l JOIN product_sku k2 ON k2.id = l.sku_id
                   WHERE k2.spu_id = p.id AND l.is_deleted = 0 AND k2.is_deleted = 0) AS listing_count`,
        q,
        orderBy: 'p.id DESC',
      }),
    );
  }),
);

/** 下拉用（寄样 / 上架绑定选商品） */
productRouter.get(
  '/spu/all',
  wrap((_req, res) =>
    ok(
      res,
      queryList({
        from: 'product_spu p',
        q: new Q('p.is_deleted = 0'),
        select: 'p.id, p.spu_code, p.name_cn, p.category, p.status',
        orderBy: 'p.spu_code ASC',
        limit: 500,
      }),
    ),
  ),
);

function mustGetSpu(id: number): Record<string, unknown> {
  const row = get<Record<string, unknown>>(
    `SELECT p.*, u.real_name AS owner_name,
            (SELECT COUNT(*) FROM product_sku k WHERE k.spu_id = p.id AND k.is_deleted = 0) AS sku_count
       FROM product_spu p LEFT JOIN sys_user u ON u.id = p.owner_id
      WHERE p.id = ? AND p.is_deleted = 0`,
    id,
  );
  if (!row) throw notFound('商品不存在或已删除');
  return row;
}

productRouter.get('/spu/:id', wrap((req, res) => ok(res, mustGetSpu(Number(req.params.id)))));

productRouter.post(
  '/spu',
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(spuBody, req.body);
    if (get(`SELECT id FROM product_spu WHERE spu_code = ? AND is_deleted = 0`, body.spu_code)) throw badRequest(`款号 ${body.spu_code} 已存在`);
    const id = insert('product_spu', { ...rowOf(body), created_by: user.id });
    writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'product_spu', target_id: id, after: body, ip: req.ip });
    ok(res, { id });
  }),
);

productRouter.put(
  '/spu/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const body = parseBody(spuBody.partial(), req.body);
    // 唯一性冲突先于存在性检查：即使目标行已软删，也要挡住「改成别人在用的款号」
    if (body.spu_code && get(`SELECT id FROM product_spu WHERE spu_code = ? AND id <> ? AND is_deleted = 0`, body.spu_code, id)) {
      throw badRequest(`款号 ${body.spu_code} 已被其他商品占用`);
    }
    const before = mustGetSpu(id);
    if (body.owner_id && !get(`SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0`, body.owner_id)) throw badRequest('负责人(owner_id)不存在');
    update('product_spu', id, rowOf(body));
    logIfChanged({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'product_spu',
      target_id: id,
      before,
      after: { ...before, ...body },
      keys: ['spu_code', 'name_cn', 'name_en', 'category', 'owner_id', 'status'],
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/** 软删除前置校验：还有 SKU 挂在下面就不许删，避免订单行失去商品归属 */
productRouter.delete(
  '/spu/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    mustGetSpu(id);
    const skus = scalar<number>(`SELECT COUNT(*) FROM product_sku WHERE spu_id = ? AND is_deleted = 0`, id);
    if (skus > 0) throw forbidden(`该商品下还有 ${skus} 个 SKU，请先删除或改挂 SKU`);
    softDelete('product_spu', id);
    writeOpLog({ user_id: user.id, module: MODULE, action: 'delete', target_table: 'product_spu', target_id: id, before: { id, sku_count: skus }, ip: req.ip });
    ok(res, { id });
  }),
);

productRouter.get(
  '/spu/:id/skus',
  wrap((req, res) => {
    const id = Number(req.params.id);
    mustGetSpu(id);
    const rows = all<Record<string, unknown>>(
      `SELECT k.*, p.spu_code,
              ROUND(k.purchase_cost + k.first_leg_cost, 2) AS unit_cost
         FROM product_sku k JOIN product_spu p ON p.id = k.spu_id
        WHERE k.spu_id = ? AND k.is_deleted = 0 ORDER BY k.sku_code ASC`,
      id,
    );
    ok(res, rows.map((r) => maskFields(r, SKU_COST_FIELDS, current(req).can_see_cost)));
  }),
);

/* ==================== 表 4 SKU 与成本 ==================== */

function skuListQ(req: Parameters<typeof current>[0]): { q: Q; from: string } {
  const user = current(req);
  const q = new Q('k.is_deleted = 0')
    .like('(k.sku_code LIKE ? OR k.spec LIKE ? OR p.name_cn LIKE ? OR p.spu_code LIKE ?)', qv(req, 'keyword'))
    .eq('k.spu_id', qv(req, 'spu_id'))
    .eq('k.status', qv(req, 'status'))
    .eq('p.category', qv(req, 'category'), false);
  if (qv(req, 'cost_missing') === '1') q.and('k.purchase_cost + k.first_leg_cost = 0');
  const shopId = qv(req, 'shop_id');
  if (shopId) {
    assertShopInScope(user, Number(shopId));
    q.and(`EXISTS (SELECT 1 FROM shop_listing l WHERE l.sku_id = k.id AND l.is_deleted = 0 AND l.shop_id = ?)`, Number(shopId));
  } else {
    // SPU/SKU 本身无店铺维度：只能看到「自己负责店铺上架过的」+「还没上架的」，别人的在架 SKU 不可见
    const scope = shopScope(user, 'l.shop_id');
    q.and(
      `(NOT EXISTS (SELECT 1 FROM shop_listing l0 WHERE l0.sku_id = k.id AND l0.is_deleted = 0)
        OR EXISTS (SELECT 1 FROM shop_listing l WHERE l.sku_id = k.id AND l.is_deleted = 0 ${scope.sql}))`,
      ...scope.params,
    );
  }
  return { q, from: `product_sku k JOIN product_spu p ON p.id = k.spu_id AND p.is_deleted = 0` };
}

/** SKU 视图：合成单件成本 + 成本查看权限掩码 + 最近一次改价人/时间（来自操作日志） */
function skuView(user: CurrentUser) {
  return (row: Record<string, unknown>): Record<string, unknown> => {
    const purchase = Number(row.purchase_cost ?? 0);
    const firstLeg = Number(row.first_leg_cost ?? 0);
    const log = get<{ op_time: string; user_name: string | null }>(
      `SELECT l.op_time, u.real_name AS user_name FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
        WHERE l.is_deleted = 0 AND l.target_table = 'product_sku' AND l.target_id = ?
          AND l.action IN ('update','delete')
        ORDER BY l.id DESC LIMIT 1`,
      Number(row.id),
    );
    return maskFields(
      {
        ...row,
        purchase_cost: purchase,
        first_leg_cost: firstLeg,
        unit_cost: round2(purchase + firstLeg),
        last_cost_by: log?.user_name ?? null,
        last_cost_at: log?.op_time ?? null,
      },
      SKU_COST_FIELDS,
      user.can_see_cost,
    );
  };
}

productRouter.get(
  '/sku',
  wrap((req, res) => {
    const { q, from } = skuListQ(req);
    const view = skuView(current(req));
    const page = queryPage(req, {
      from,
      select: `k.*, p.spu_code, p.name_cn, p.name_en, p.category, p.status AS spu_status,
               (SELECT COUNT(*) FROM shop_listing l WHERE l.sku_id = k.id AND l.is_deleted = 0) AS listing_count`,
      q,
      orderBy: 'k.id DESC',
    });
    ok(res, { ...page, list: page.list.map(view) });
  }),
);

productRouter.get(
  '/sku/:id',
  wrap((req, res) => {
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(
      `SELECT k.*, p.spu_code, p.name_cn, p.category,
              (SELECT COUNT(*) FROM shop_listing l WHERE l.sku_id = k.id AND l.is_deleted = 0) AS listing_count
         FROM product_sku k JOIN product_spu p ON p.id = k.spu_id
        WHERE k.id = ? AND k.is_deleted = 0`,
      id,
    );
    if (!row) throw notFound('SKU 不存在或已删除');
    ok(res, skuView(current(req))(row));
  }),
);

productRouter.post(
  '/sku',
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(skuBody, req.body);
    if (!get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, body.spu_id)) throw badRequest('所属商品(spu_id)不存在');
    if (get(`SELECT id FROM product_sku WHERE sku_code = ? AND is_deleted = 0`, body.sku_code)) throw badRequest(`SKU 编码 ${body.sku_code} 已存在`);
    const id = insert('product_sku', { ...rowOf(body), created_by: user.id });
    const unitCost = unitCostCny({ purchase_cost: Number(body.purchase_cost), first_leg_cost: Number(body.first_leg_cost) });
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'create',
      target_table: 'product_sku',
      target_id: id,
      after: { ...body, unit_cost: unitCost },
      ip: req.ip,
    });
    ok(res, { id, sku_code: body.sku_code, unit_cost: unitCost });
  }),
);

/**
 * 改成本：只影响之后同步的订单。
 * 这里只做两件事 —— 落库 + 写 before/after 操作日志（成本口径要能在成本时间线里追溯）；
 * 历史 tk_order_item.cost_snapshot 一律不回写。
 */
productRouter.put(
  '/sku/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM product_sku WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('SKU 不存在或已删除');
    const body = parseBody(skuBody.partial(), req.body);
    const touchingCost = body.purchase_cost !== undefined || body.first_leg_cost !== undefined;
    if (touchingCost && !user.can_see_cost) throw forbidden('当前角色无成本维护权限');
    if (body.spu_id && !get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, body.spu_id)) throw badRequest('所属商品(spu_id)不存在');
    if (body.sku_code && get(`SELECT id FROM product_sku WHERE sku_code = ? AND id <> ? AND is_deleted = 0`, body.sku_code, id)) {
      throw badRequest(`SKU 编码 ${body.sku_code} 已被占用`);
    }
    update('product_sku', id, rowOf(body));
    const after = { ...before, ...body };
    const beforeUnit = round2(Number(before.purchase_cost ?? 0) + Number(before.first_leg_cost ?? 0));
    const afterUnit = round2(Number(after.purchase_cost ?? 0) + Number(after.first_leg_cost ?? 0));
    const costChanged =
      touchingCost && (Number(before.purchase_cost) !== Number(after.purchase_cost) || Number(before.first_leg_cost) !== Number(after.first_leg_cost));
    // 留痕带上合成单件成本 unit_cost：成本时间线要能直接看出改价前后差异
    logIfChanged({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'product_sku',
      target_id: id,
      before: { ...before, unit_cost: beforeUnit },
      after: { ...after, unit_cost: afterUnit },
      keys: ['sku_code', 'spec', 'purchase_cost', 'first_leg_cost', 'unit_cost', 'weight_g', 'package_size', 'status'],
      ip: req.ip,
    });
    ok(res, {
      id,
      cost_changed: costChanged,
      unit_cost: afterUnit,
      tip: '成本修改只对之后同步进来的订单生效，历史订单沿用落库时冻结的 cost_snapshot',
    });
  }),
);

productRouter.delete(
  '/sku/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT id, sku_code, spu_id FROM product_sku WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('SKU 不存在或已删除');
    const listed = scalar<number>(`SELECT COUNT(*) FROM shop_listing WHERE sku_id = ? AND is_deleted = 0`, id);
    if (listed > 0) throw forbidden(`该 SKU 已被 ${listed} 个店铺商品映射引用，请先解绑再删除`);
    const used = scalar<number>(`SELECT COUNT(*) FROM tk_order_item WHERE sku_id = ? AND is_deleted = 0`, id);
    if (used > 0) throw forbidden(`该 SKU 已出现在 ${used} 条订单明细中，不能删除（成本可改，历史不可抹）`);
    softDelete('product_sku', id);
    writeOpLog({ user_id: user.id, module: MODULE, action: 'delete', target_table: 'product_sku', target_id: id, before, ip: req.ip });
    ok(res, { id });
  }),
);

/**
 * 成本变更时间线：数据源就是 sys_op_log（操作日志没有更新入口，天然当审计账本用）。
 * 无成本权限的人不返回该清单（requireMenu 已挡住 product 菜单，这里再加一道成本判断）。
 */
productRouter.get(
  '/sku/:id/cost-history',
  wrap((req, res) => {
    const user = current(req);
    if (!user.can_see_cost) throw forbidden('无成本查看权限');
    const id = Number(req.params.id);
    const sku = get<Record<string, unknown>>(`SELECT id, sku_code, purchase_cost, first_leg_cost FROM product_sku WHERE id = ? AND is_deleted = 0`, id);
    if (!sku) throw notFound('SKU 不存在或已删除');
    const logs = all<Record<string, unknown>>(
      `SELECT l.id, l.op_time, l.action, l.user_id, u.real_name AS user_name, l.before_after
         FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
        WHERE l.is_deleted = 0 AND l.target_table = 'product_sku' AND l.target_id = ?
        ORDER BY l.id DESC`,
      id,
    );
    const timeline: Record<string, unknown>[] = [];
    for (const l of logs) {
      const parsed = JSON.parse(String(l.before_after ?? '{}')) as { before?: Record<string, unknown>; after?: Record<string, unknown> };
      const b = parsed.before ?? {};
      const a = parsed.after ?? {};
      const hasCost = b.purchase_cost !== undefined || b.first_leg_cost !== undefined || a.purchase_cost !== undefined || a.first_leg_cost !== undefined;
      // 只有成本字段真的变了才算一条改价记录；只改规格/状态的 update 不进时间线
      const costChanged = b.purchase_cost !== a.purchase_cost || b.first_leg_cost !== a.first_leg_cost;
      if (!hasCost || !costChanged) continue;
      const beforeUnit = round2(Number(b.purchase_cost ?? 0) + Number(b.first_leg_cost ?? 0));
      const afterUnit = round2(Number(a.purchase_cost ?? 0) + Number(a.first_leg_cost ?? 0));
      timeline.push({
        log_id: Number(l.id),
        op_time: String(l.op_time),
        action: String(l.action),
        user_id: Number(l.user_id),
        user_name: l.user_name ?? null,
        before_purchase_cost: b.purchase_cost ?? null,
        after_purchase_cost: a.purchase_cost ?? null,
        before_first_leg_cost: b.first_leg_cost ?? null,
        after_first_leg_cost: a.first_leg_cost ?? null,
        before_unit_cost: beforeUnit,
        after_unit_cost: afterUnit,
        diff_unit_cost: round2(afterUnit - beforeUnit),
      });
    }
    ok(res, {
      sku_id: id,
      sku_code: String(sku.sku_code),
      current_unit_cost: round2(Number(sku.purchase_cost) + Number(sku.first_leg_cost)),
      timeline,
      tip: '成本变更只对之后落库的订单生效，历史 cost_snapshot 不回溯',
    });
  }),
);

/* ==================== 表 5 店铺商品映射 ==================== */

const LISTING_FROM = `shop_listing l
       JOIN tk_shop s ON s.id = l.shop_id
       LEFT JOIN product_sku k ON k.id = l.sku_id AND k.is_deleted = 0
       LEFT JOIN product_spu p ON p.id = k.spu_id`;

const LISTING_SELECT = `l.*, s.shop_name, s.currency, s.region, k.sku_code, k.spec, p.spu_code, p.name_cn,
       (SELECT COUNT(*) FROM tk_order_item oi WHERE oi.listing_id = l.id AND oi.is_deleted = 0) AS order_item_count,
       (SELECT COUNT(*) FROM tk_order_item oi WHERE oi.listing_id = l.id AND oi.is_deleted = 0 AND oi.sku_id IS NULL) AS unmapped_item_count`;

function listingQ(req: Parameters<typeof current>[0]): Q {
  return withScope(new Q('l.is_deleted = 0'), shopScope(current(req), 'l.shop_id'))
    .like('(l.product_name LIKE ? OR l.seller_sku LIKE ? OR l.tk_sku_id LIKE ? OR k.sku_code LIKE ?)', qv(req, 'keyword'))
    .eq('l.shop_id', qv(req, 'shop_id'))
    .eq('l.map_status', qv(req, 'map_status'))
    .eq('l.listing_status', qv(req, 'listing_status'))
    .eq('l.sku_id', qv(req, 'sku_id'))
    .and('l.sku_id IS NULL', qv(req, 'unmapped_only') === '1' ? 1 : null);
}

function loadListing(req: Parameters<typeof current>[0], id: number): Record<string, unknown> | undefined {
  const scope = shopScope(current(req), 'l.shop_id');
  return get<Record<string, unknown>>(`SELECT ${LISTING_SELECT} FROM ${LISTING_FROM} WHERE l.id = ? AND l.is_deleted = 0 ${scope.sql}`, id, ...scope.params);
}

productRouter.get(
  '/listing',
  wrap((req, res) =>
    ok(res, queryPage(req, { from: LISTING_FROM, select: LISTING_SELECT, q: listingQ(req), orderBy: 'l.map_status ASC, l.id DESC' })),
  ),
);

productRouter.get(
  '/listing/:id',
  wrap((req, res) => {
    const row = loadListing(req, Number(req.params.id));
    if (!row) throw notFound('店铺商品映射不存在或不在你的数据范围内');
    ok(res, row);
  }),
);

productRouter.post(
  '/listing',
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(listingBody, req.body);
    assertShopInScope(user, body.shop_id);
    if (body.sku_id && !get(`SELECT id FROM product_sku WHERE id = ? AND is_deleted = 0`, body.sku_id)) throw badRequest('内部 SKU(sku_id) 不存在');
    if (body.tk_sku_id && get(`SELECT id FROM shop_listing WHERE shop_id = ? AND tk_sku_id = ? AND is_deleted = 0`, body.shop_id, body.tk_sku_id)) {
      throw badRequest('该店铺下这个平台 SKU ID 已存在（shop_id + tk_sku_id 唯一）');
    }
    const id = insert('shop_listing', {
      ...rowOf(body),
      sku_id: body.sku_id || null,
      map_status: body.sku_id ? MAP_STATUS.MAPPED : MAP_STATUS.UNMAPPED,
      created_by: user.id,
    });
    writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'shop_listing', target_id: id, after: { ...body, map_status: body.sku_id ? 1 : 2 }, ip: req.ip });
    ok(res, { id, map_status: body.sku_id ? MAP_STATUS.MAPPED : MAP_STATUS.UNMAPPED });
  }),
);

/**
 * 手工绑定 / 改映射。只改 listing 本身：
 * 已经落库的订单行成本快照保持冻结（要补历史行请用同步任务的 refreshDerivedAggregates）。
 */
productRouter.put(
  '/listing/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = loadListing(req, id);
    if (!before) throw notFound('店铺商品映射不存在或不在你的数据范围内');
    const body = parseBody(listingBody.partial(), req.body);
    const shopId = Number(body.shop_id ?? before.shop_id);
    assertShopInScope(user, shopId);
    // sku_id 传 0 视为解绑（前端「清空绑定」按钮）
    const nextSkuId = body.sku_id === undefined ? Number(before.sku_id ?? 0) || null : body.sku_id || null;
    if (nextSkuId && !get(`SELECT id, sku_code FROM product_sku WHERE id = ? AND is_deleted = 0`, nextSkuId)) throw badRequest('内部 SKU(sku_id) 不存在');
    const tkSkuId = body.tk_sku_id === undefined ? String(before.tk_sku_id ?? '') || null : body.tk_sku_id || null;
    if (tkSkuId && get(`SELECT id FROM shop_listing WHERE shop_id = ? AND tk_sku_id = ? AND id <> ? AND is_deleted = 0`, shopId, tkSkuId, id)) {
      throw badRequest('该店铺下这个平台 SKU ID 已被另一条映射占用');
    }
    const mapStatus = nextSkuId ? MAP_STATUS.MAPPED : MAP_STATUS.UNMAPPED;
    tx(() => {
      update('shop_listing', id, {
        ...rowOf(body),
        shop_id: shopId,
        tk_sku_id: tkSkuId,
        sku_id: nextSkuId,
        map_status: mapStatus,
      });
      return id;
    });
    logIfChanged({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'shop_listing',
      target_id: id,
      before: {
        sku_id: before.sku_id ?? null,
        seller_sku: before.seller_sku ?? null,
        tk_sku_id: before.tk_sku_id ?? null,
        map_status: before.map_status,
        sale_price: before.sale_price,
        listing_status: before.listing_status,
      },
      after: {
        sku_id: nextSkuId,
        seller_sku: body.seller_sku ?? before.seller_sku ?? null,
        tk_sku_id: tkSkuId,
        map_status: mapStatus,
        sale_price: body.sale_price ?? before.sale_price,
        listing_status: body.listing_status ?? before.listing_status,
      },
      keys: ['sku_id', 'seller_sku', 'tk_sku_id', 'map_status', 'sale_price', 'listing_status'],
      ip: req.ip,
    });
    ok(res, {
      id,
      sku_id: nextSkuId,
      map_status: mapStatus,
      tip: '历史订单行的成本快照保持冻结，仅之后同步的订单按新映射取成本',
    });
  }),
);

productRouter.delete(
  '/listing/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadListing(req, id);
    if (!row) throw notFound('店铺商品映射不存在或不在你的数据范围内');
    const items = scalar<number>(`SELECT COUNT(*) FROM tk_order_item WHERE listing_id = ? AND is_deleted = 0`, id);
    if (items > 0) throw forbidden(`该映射已被 ${items} 条订单明细引用，不能删除（可改绑到其它 SKU）`);
    softDelete('shop_listing', id);
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'delete',
      target_table: 'shop_listing',
      target_id: id,
      before: { shop_id: row.shop_id, tk_sku_id: row.tk_sku_id, seller_sku: row.seller_sku, sku_id: row.sku_id },
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/* ==================== 待映射清单 ==================== */

const UNMAPPED_ITEMS_SUB = `(SELECT COUNT(*) FROM tk_order_item oi WHERE oi.listing_id = l.id AND oi.is_deleted = 0 AND oi.sku_id IS NULL)`;
const UNMAPPED_AMOUNT_SUB = `(SELECT COALESCE(SUM(oi.item_amount), 0) FROM tk_order_item oi WHERE oi.listing_id = l.id AND oi.is_deleted = 0 AND oi.sku_id IS NULL)`;
const UNMAPPED_COUNT = `${UNMAPPED_ITEMS_SUB} AS unmatched_item_count`;
const UNMAPPED_AMOUNT = `${UNMAPPED_AMOUNT_SUB} AS unmatched_amount`;

/**
 * 待映射清单 = map_status=2 的 listing + 其未匹配订单行数与影响金额；
 * rows 里额外给出所有「没有成本快照」的订单行，供运营定位到底是哪几笔单算不出利润。
 */
productRouter.get(
  '/unmapped',
  wrap((req, res) => {
    const user = current(req);
    const scope = shopScope(user, 'l.shop_id');
    const orderScope = { sql: scope.sql.replace(/l\.shop_id/g, 'o.shop_id'), params: scope.params };
    const page = queryPage(req, {
      from: `shop_listing l JOIN tk_shop s ON s.id = l.shop_id`,
      select: `l.*, s.shop_name, s.currency, s.region, ${UNMAPPED_COUNT}, ${UNMAPPED_AMOUNT}`,
      q: withScope(new Q(`l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED}`), scope)
        .like('(l.product_name LIKE ? OR l.seller_sku LIKE ? OR l.tk_sku_id LIKE ?)', qv(req, 'keyword'))
        .eq('l.shop_id', qv(req, 'shop_id')),
      orderBy: 'unmatched_item_count DESC, l.id DESC',
    });
    const rows = all<Record<string, unknown>>(
      `SELECT oi.id AS item_id, o.id AS order_id, o.tk_order_id, o.order_time, o.order_status, o.currency,
              o.shop_id, s.shop_name, l.id AS listing_id, l.tk_sku_id, l.seller_sku, l.product_name,
              oi.quantity, oi.unit_price, oi.item_amount,
              ROUND(oi.item_amount * COALESCE(${RATE_TO_CNY}, 1), 2) AS item_amount_cny,
              COALESCE(${RATE_TO_CNY}, 1) AS rate_to_cny
         FROM tk_order_item oi
         JOIN tk_order o ON o.id = oi.order_id AND o.is_deleted = 0
         JOIN tk_shop s ON s.id = o.shop_id
         LEFT JOIN shop_listing l ON l.id = oi.listing_id
        WHERE oi.is_deleted = 0 AND (oi.sku_id IS NULL OR oi.cost_matched = 0) ${orderScope.sql}
        ORDER BY o.order_time DESC LIMIT 50`,
      ...orderScope.params,
    );
    const totals = get<Record<string, number>>(
      `SELECT COUNT(*) AS listing_count,
              COALESCE(SUM(${UNMAPPED_ITEMS_SUB}), 0) AS unmatched_items,
              COALESCE(SUM(${UNMAPPED_AMOUNT_SUB}), 0) AS unmatched_amount
         FROM shop_listing l JOIN tk_shop s ON s.id = l.shop_id
        WHERE l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED} ${scope.sql}`,
      ...scope.params,
    );
    ok(res, {
      ...page,
      rows,
      totals: totals ?? { listing_count: 0, unmatched_items: 0, unmatched_amount: 0 },
      warn: '以下订单行没有成本快照，已从成本/毛利/利润计算中整体排除（绝不按 0 成本参与计算），请尽快完成映射或补成本价',
    });
  }),
);

/* ==================== 自动映射 ==================== */

const autoMatchSchema = z.object({ shop_id: z.number().int().positive().optional() });

/**
 * 按 seller_sku 与 product_sku.sku_code 匹配：全等优先，其次唯一前缀命中。
 * 多命中或空 seller_sku 不自动写 —— 宁可留人工，也不能错绑导致利润失真。
 */
function autoMatch(req: Parameters<typeof current>[0]): {
  matched: number;
  remained: number;
  detail: { listing_id: number; shop_id: number; seller_sku: string; sku_id: number; sku_code: string; rule: string }[];
} {
  const user = current(req);
  const body = parseBody(autoMatchSchema, req.body ?? {});
  const scope = shopScope(user, 'l.shop_id');
  const pending = all<Record<string, unknown>>(
    `SELECT l.id, l.shop_id, l.seller_sku, l.tk_sku_id FROM shop_listing l
      WHERE l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED} ${scope.sql}${body.shop_id ? ' AND l.shop_id = ?' : ''}`,
    ...scope.params,
    ...(body.shop_id ? [body.shop_id] : []),
  );
  const detail: { listing_id: number; shop_id: number; seller_sku: string; sku_id: number; sku_code: string; rule: string }[] = [];
  tx(() => {
    for (const row of pending) {
      const sellerSku = String(row.seller_sku ?? '').trim();
      if (!sellerSku) continue;
      const exact = all<{ id: number; sku_code: string }>(`SELECT id, sku_code FROM product_sku WHERE is_deleted = 0 AND sku_code = ?`, sellerSku);
      const prefixed = exact.length
        ? []
        : all<{ id: number; sku_code: string }>(`SELECT id, sku_code FROM product_sku WHERE is_deleted = 0 AND ? LIKE sku_code || '%' ORDER BY LENGTH(sku_code) DESC`, sellerSku);
      const hit = exact.length === 1 ? exact[0] : prefixed.length === 1 ? prefixed[0] : null;
      if (!hit) continue;
      const rule = exact.length === 1 ? 'exact' : 'prefix';
      update('shop_listing', Number(row.id), { sku_id: hit.id, map_status: MAP_STATUS.MAPPED });
      detail.push({ listing_id: Number(row.id), shop_id: Number(row.shop_id), seller_sku: sellerSku, sku_id: hit.id, sku_code: hit.sku_code, rule });
      writeOpLog({
        user_id: user.id,
        module: MODULE,
        action: 'update',
        target_table: 'shop_listing',
        target_id: Number(row.id),
        before: { sku_id: null, map_status: MAP_STATUS.UNMAPPED, seller_sku: sellerSku },
        after: { sku_id: hit.id, map_status: MAP_STATUS.MAPPED, seller_sku: sellerSku, sku_code: hit.sku_code, rule },
        ip: req.ip,
      });
    }
  });
  const remained = scalar<number>(
    `SELECT COUNT(*) FROM shop_listing l WHERE l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED} ${scope.sql}`,
    ...scope.params,
  );
  return { matched: detail.length, remained, detail };
}

productRouter.get(
  '/mapping/preview',
  wrap((req, res) => {
    const user = current(req);
    const scope = shopScope(user, 'l.shop_id');
    ok(
      res,
      all<Record<string, unknown>>(
        `SELECT l.id AS listing_id, l.shop_id, s.shop_name, l.tk_sku_id, l.seller_sku, l.product_name, k.sku_code AS bound_sku_code
           FROM shop_listing l JOIN tk_shop s ON s.id = l.shop_id
           LEFT JOIN product_sku k ON k.id = l.sku_id
          WHERE l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED} ${scope.sql}
          ORDER BY l.id DESC LIMIT 200`,
        ...scope.params,
      ),
    );
  }),
);

productRouter.post(
  '/mapping/auto',
  wrap((req, res) => ok(res, { ...autoMatch(req), tip: '仅唯一命中才自动绑定，多命中或空 seller_sku 仍留在待映射清单' })),
);

/** PRD 6.1 前端按钮用的路径别名，行为与 /mapping/auto 完全一致 */
productRouter.post('/listings/auto-match', wrap((req, res) => ok(res, autoMatch(req))));

/* ==================== Excel 导入兜底（前端解析后传 rows） ==================== */

function parseImportRows<T>(req: { body: unknown }, schema: z.ZodType<T>): { rows: { row: number; data: T }[]; failed: { row: number; reason: string }[]; total: number } {
  const raw = (req.body as { rows?: unknown })?.rows;
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('rows 不能为空，格式 { rows: [ {...} ] }');
  if (raw.length > 2000) throw badRequest('单次导入不要超过 2000 行，请拆分后再传');
  const rows: { row: number; data: T }[] = [];
  const failed: { row: number; reason: string }[] = [];
  raw.forEach((item, idx) => {
    const r = schema.safeParse(item);
    if (r.success) rows.push({ row: idx + 1, data: r.data });
    else failed.push({ row: idx + 1, reason: r.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ') || '数据格式错误' });
  });
  return { rows, failed, total: raw.length };
}

/** 导入行允许只给 spu_code（按款号归属 spu），故 spu_id 从必填放宽为选填 */
const importSkuRow = skuBody.extend({ spu_id: skuBody.shape.spu_id.optional(), spu_code: z.string().max(64).nullish() });

productRouter.post(
  '/import/spu',
  wrap((req, res) => {
    const user = current(req);
    const { rows, failed, total } = parseImportRows(req, spuBody);
    const parsed = new Set(rows.map((r) => r.row));
    tx(() => {
      for (const item of rows) {
        if (get(`SELECT id FROM product_spu WHERE spu_code = ? AND is_deleted = 0`, item.data.spu_code)) {
          failed.push({ row: item.row, reason: `款号 ${item.data.spu_code} 已存在` });
          continue;
        }
        const id = insert('product_spu', { ...rowOf(item.data), created_by: user.id });
        writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'product_spu', target_id: id, after: { ...item.data, import: true }, ip: req.ip });
      }
    });
    ok(res, { success: rows.length - failed.filter((f) => parsed.has(f.row)).length, failed, total, failed_count: failed.length });
  }),
);

productRouter.post(
  '/import/sku',
  wrap((req, res) => {
    const user = current(req);
    const { rows, failed, total } = parseImportRows(req, importSkuRow);
    const parsed = new Set(rows.map((r) => r.row));
    tx(() => {
      for (const item of rows) {
        const { spu_code: spuCode, ...data } = item.data;
        const spuId = Number(data.spu_id || (spuCode ? get<{ id: number }>(`SELECT id FROM product_spu WHERE spu_code = ? AND is_deleted = 0`, spuCode)?.id ?? 0 : 0));
        if (!spuId || !get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, spuId)) {
          failed.push({ row: item.row, reason: `所属商品不存在（spu_id=${data.spu_id ?? '-'} spu_code=${spuCode ?? '-'}）` });
          continue;
        }
        if (get(`SELECT id FROM product_sku WHERE sku_code = ? AND is_deleted = 0`, data.sku_code)) {
          failed.push({ row: item.row, reason: `SKU 编码 ${data.sku_code} 已存在` });
          continue;
        }
        const id = insert('product_sku', { ...rowOf(data), spu_id: spuId, created_by: user.id });
        writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'product_sku', target_id: id, after: { ...item.data, spu_id: spuId, import: true }, ip: req.ip });
      }
    });
    ok(res, { success: rows.length - failed.filter((f) => parsed.has(f.row)).length, failed, total, failed_count: failed.length });
  }),
);

/* ==================== 导出（can_export 才可调，并写导出日志） ==================== */

const EXPORT_COLUMNS = [
  'sku_code',
  'spu_code',
  'name_cn',
  'category',
  'spec',
  'purchase_cost',
  'first_leg_cost',
  'unit_cost',
  'weight_g',
  'package_size',
  'status',
  'listing_count',
] as const;

productRouter.get(
  '/export/sku',
  requireExport,
  wrap((req, res) => {
    const user = current(req);
    const { q, from } = skuListQ(req);
    const view = skuView(user);
    const rows = all<Record<string, unknown>>(
      `SELECT k.*, p.spu_code, p.name_cn, p.category,
              (SELECT COUNT(*) FROM shop_listing l WHERE l.sku_id = k.id AND l.is_deleted = 0) AS listing_count
         FROM ${from}${q.whereSql} ORDER BY k.sku_code ASC`,
      ...q.params,
    );
    const list = rows.map(view);
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'export',
      target_table: 'product_sku',
      after: {
        rows: list.length,
        columns: [...EXPORT_COLUMNS],
        filters: { keyword: qv(req, 'keyword'), spu_id: qv(req, 'spu_id'), shop_id: qv(req, 'shop_id'), category: qv(req, 'category') },
        cost_masked: !user.can_see_cost,
      },
      ip: req.ip,
    });
    ok(res, { columns: [...EXPORT_COLUMNS], count: list.length, rows: list });
  }),
);
