/**
 * 商品中心（方案表 3 product_spu / 表 4 product_sku / 表 5 shop_listing）
 *
 * 品牌服务方（代运营）口径：货是品牌的，我们不背货款，SKU 上与钱有关的只有两个字段 ——
 * `rebate_rate`（品牌给我们的返点率，0-1，我们唯一收入的比例）与
 * `logistics_cost`（单件物流成本，人民币/件，品牌承担时填 0）。
 *
 * 两条口径必须守住：
 *  1. 返点与物流只维护在 product_sku 一处；改 rebate_rate / logistics_cost 只影响**之后**同步进来的订单，
 *     历史 tk_order_item.rebate_cny / logistics_cny 是落库时冻结的快照，本文件任何接口都不回写。
 *     rebate_rate = 0 视为「未配返点率」，同步进来的明细行 rebate_matched=0，整行退出利润口径。
 *  2. 映射关系（shop_listing.sku_id）是利润准不准的命门，绑定前后一律写 sys_op_log before/after；
 *     shop_listing 有店铺维度，所有列表接口走 shopScope 隔离；返点率与物流成本按 can_see_cost 掩码。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { DATA_SCOPE, MAP_STATUS, round2, type CurrentUser } from '@tk/shared';
import { all, get, insert, scalar, softDelete, tx, update, type SqlParam } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { maskFields, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, writeOpLog } from '../core/oplog.js';
import { exportFromList } from '../core/export.js';
import { rateToCnyExpr } from '../services/rates.js';
import { sendTable, type ExportCell } from '../core/export.js';

const MODULE = '商品中心';
/** 无成本查看权限时要掩码的字段：返点率是我们的商务条件，和运费一样敏感 */
const SKU_COST_FIELDS = ['rebate_rate', 'logistics_cost'];

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

/** zod nullish 字段在未传时是 undefined，落库必须跳过该列而不是写 null */
function rowOf(body: object): Record<string, SqlParam> {
  const out: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v as SqlParam;
  return out;
}

/** shopScope 给的是 'AND xxx IN (?)'，Q 内部自己拼 AND，所以并条件时要剥掉前缀（scope 为空则不产生条件） */
const withScope = (q: Q, scope: { sql: string; params: number[] }): Q => q.and(scope.sql.replace(/^\s*AND\s+/i, ''), ...scope.params);

/**
 * 按订单日期取汇率：当日 → 更早最近一条 → 更晚最近一条 → 兜底常量（rates.ts 单一来源）。
 * 与订单中心/宽表/利润引擎同一口径；原来这里以 `COALESCE(rate, 1)` 收尾，
 * 缺汇率时等于把 1 USD 当 1 CNY，待映射清单的影响金额会小一个数量级。
 */
const RATE_TO_CNY = rateToCnyExpr('o.currency', 'substr(o.order_time, 1, 10)');

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

/**
 * 品牌返点率：0-1 的比例（0.18 = 实收 GMV 的 18% 归我们），0 = 未配置。
 * 上限必须是 1 —— 有人会把「18%」填成 18，那是金额不是比率，会让返点直接放大 100 倍。
 */
const rebateRate = z.number().min(0, '品牌返点率不能为负数').max(1, '品牌返点率是比例（0.18 = 实收 GMV 的 18% 归我们），请填 0~1 的小数，不要填成金额');

const skuBody = z.object({
  spu_id: z.number().int().positive(),
  sku_code: z.string().min(1).max(64),
  spec: z.string().max(200).nullish(),
  rebate_rate: rebateRate.default(0),
  logistics_cost: z.number().min(0, '单件物流成本不能为负数').default(0),
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

/** SPU 列表与导出共用同一份 FROM/SELECT（导出绝不另写 SQL，否则两边口径一定会漂） */
const SPU_FROM = `product_spu p LEFT JOIN sys_user u ON u.id = p.owner_id`;
const SPU_SELECT = `p.*, u.real_name AS owner_name,
                 (SELECT COUNT(*) FROM product_sku k WHERE k.spu_id = p.id AND k.is_deleted = 0) AS sku_count,
                 (SELECT COUNT(*) FROM shop_listing l JOIN product_sku k2 ON k2.id = l.sku_id
                   WHERE k2.spu_id = p.id AND l.is_deleted = 0 AND k2.is_deleted = 0) AS listing_count`;
const SPU_EXPORT_COLUMNS = [
  { key: 'spu_code', label: 'SPU编码' },
  { key: 'name_cn', label: '品名(中)' },
  { key: 'name_en', label: '品名(英)' },
  { key: 'category', label: '类目' },
  { key: 'status', label: '状态' },
  { key: 'owner_name', label: '负责人' },
  { key: 'sku_count', label: 'SKU数' },
  { key: 'listing_count', label: '在架店铺数' },
  { key: 'created_at', label: '创建时间' },
];

productRouter.get(
  '/spu',
  wrap((req, res) => {
    const { q } = spuListQ(req);
    ok(res, queryPage(req, { from: SPU_FROM, select: SPU_SELECT, q, orderBy: 'p.id DESC' }));
  }),
);

/** SPU 导出（PRD D13 九类之一） */
productRouter.get(
  '/spu/export',
  requireExport,
  wrap((req, res) => {
    const { q } = spuListQ(req);
    exportFromList(req, res, {
      module: MODULE,
      targetTable: 'product_spu',
      filename: `product-spu-${String(qv(req, 'created_to') ?? '').slice(0, 10) || 'all'}`,
      from: SPU_FROM,
      select: SPU_SELECT,
      q,
      orderBy: 'p.id DESC',
      columns: SPU_EXPORT_COLUMNS,
      filters: { keyword: qv(req, 'keyword'), category: qv(req, 'category'), status: qv(req, 'status'), owner_id: qv(req, 'owner_id'), shop_id: qv(req, 'shop_id') },
    });
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
      `SELECT k.*, p.spu_code
         FROM product_sku k JOIN product_spu p ON p.id = k.spu_id
        WHERE k.spu_id = ? AND k.is_deleted = 0 ORDER BY k.sku_code ASC`,
      id,
    );
    ok(res, rows.map((r) => maskFields(r, SKU_COST_FIELDS, current(req).can_see_cost)));
  }),
);

/* ==================== 表 4 SKU 与返点 ==================== */

function skuListQ(req: Parameters<typeof current>[0]): { q: Q; from: string } {
  const user = current(req);
  const q = new Q('k.is_deleted = 0')
    .like('(k.sku_code LIKE ? OR k.spec LIKE ? OR p.name_cn LIKE ? OR p.spu_code LIKE ?)', qv(req, 'keyword'))
    .eq('k.spu_id', qv(req, 'spu_id'))
    .eq('k.status', qv(req, 'status'))
    .eq('p.category', qv(req, 'category'), false);
  /**
   * 「未配返点率」清单：新口径下这就是旧的「成本未维护」那一档待办（rebate_rate=0 的行同步进来全部不计利润）。
   * 查询键 rebate_missing 是正式名，cost_missing 是旧前端/用例的别名，两个都认。
   */
  if (qv(req, 'rebate_missing') === '1' || qv(req, 'cost_missing') === '1') q.and('k.rebate_rate = 0');
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

/** SKU 视图：返点率 + 单件物流成本 + 成本查看权限掩码 + 最近一次改口径人/时间（来自操作日志） */
function skuView(user: CurrentUser) {
  return (row: Record<string, unknown>): Record<string, unknown> => {
    const rate = Number(row.rebate_rate ?? 0);
    const logistics = Number(row.logistics_cost ?? 0);
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
        rebate_rate: rate,
        logistics_cost: logistics,
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
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'create',
      target_table: 'product_sku',
      target_id: id,
      after: body,
      ip: req.ip,
    });
    ok(res, { id, sku_code: body.sku_code, rebate_rate: body.rebate_rate, logistics_cost: body.logistics_cost });
  }),
);

/**
 * 改返点率 / 物流成本：只影响之后同步的订单。
 * 这里只做两件事 —— 落库 + 写 before/after 操作日志（商务口径要能在成本时间线里追溯）；
 * 历史 tk_order_item.rebate_cny / logistics_cny 一律不回写。
 */
productRouter.put(
  '/sku/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM product_sku WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('SKU 不存在或已删除');
    const body = parseBody(skuBody.partial(), req.body);
    /** 返点率与物流成本都是钱口径，改哪个都算「动成本」 */
    const touchingCost = body.rebate_rate !== undefined || body.logistics_cost !== undefined;
    if (touchingCost && !user.can_see_cost) throw forbidden('当前角色无成本维护权限');
    if (body.spu_id && !get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, body.spu_id)) throw badRequest('所属商品(spu_id)不存在');
    if (body.sku_code && get(`SELECT id FROM product_sku WHERE sku_code = ? AND id <> ? AND is_deleted = 0`, body.sku_code, id)) {
      throw badRequest(`SKU 编码 ${body.sku_code} 已被占用`);
    }
    update('product_sku', id, rowOf(body));
    const after = { ...before, ...body };
    const rebateChanged = Number(before.rebate_rate ?? 0) !== Number(after.rebate_rate ?? 0);
    const costChanged = touchingCost && (rebateChanged || Number(before.logistics_cost ?? 0) !== Number(after.logistics_cost ?? 0));
    // 留痕只存原始两列，成本时间线自己折算成「返点率 % + 物流元/件」
    logIfChanged({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'product_sku',
      target_id: id,
      before,
      after,
      keys: ['sku_code', 'spec', 'rebate_rate', 'logistics_cost', 'weight_g', 'package_size', 'status'],
      ip: req.ip,
    });
    ok(res, {
      id,
      cost_changed: costChanged,
      rebate_rate: Number(after.rebate_rate ?? 0),
      logistics_cost: Number(after.logistics_cost ?? 0),
      tip: rebateChanged
        ? '返点率修改只对之后同步进来的订单生效，历史订单沿用落库时冻结的 rebate_cny；老历史行请在同步页重跑「派生汇总」回填'
        : '成本修改只对之后同步进来的订单生效，历史订单沿用落库时冻结的 rebate_cny / logistics_cny',
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
 * 返点率 / 物流成本变更时间线：数据源就是 sys_op_log（操作日志没有更新入口，天然当审计账本用）。
 * 无成本权限的人不返回该清单（requireMenu 已挡住 product 菜单，这里再加一道成本判断）。
 */
productRouter.get(
  '/sku/:id/cost-history',
  wrap((req, res) => {
    const user = current(req);
    if (!user.can_see_cost) throw forbidden('无成本查看权限');
    const id = Number(req.params.id);
    const sku = get<Record<string, unknown>>(`SELECT id, sku_code, rebate_rate, logistics_cost FROM product_sku WHERE id = ? AND is_deleted = 0`, id);
    if (!sku) throw notFound('SKU 不存在或已删除');
    const logs = all<Record<string, unknown>>(
      `SELECT l.id, l.op_time, l.action, l.user_id, u.real_name AS user_name, l.before_after
         FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
        WHERE l.is_deleted = 0 AND l.target_table = 'product_sku' AND l.target_id = ?
        ORDER BY l.id DESC`,
      id,
    );
    /** 比例折算成百分数：时间线是给人看的，0.18 不如 18% 直观 */
    const pctOf = (v: unknown): number => round2(Number(v ?? 0) * 100);
    const timeline: Record<string, unknown>[] = [];
    for (const l of logs) {
      const parsed = JSON.parse(String(l.before_after ?? '{}')) as { before?: Record<string, unknown>; after?: Record<string, unknown> };
      const b = parsed.before ?? {};
      const a = parsed.after ?? {};
      const hasCost = b.rebate_rate !== undefined || b.logistics_cost !== undefined || a.rebate_rate !== undefined || a.logistics_cost !== undefined;
      // 只有钱口径字段真的变了才算一条变更记录；只改规格/状态的 update 不进时间线
      const costChanged = b.rebate_rate !== a.rebate_rate || b.logistics_cost !== a.logistics_cost;
      if (!hasCost || !costChanged) continue;
      timeline.push({
        log_id: Number(l.id),
        op_time: String(l.op_time),
        action: String(l.action),
        user_id: Number(l.user_id),
        user_name: l.user_name ?? null,
        before_rebate_rate: b.rebate_rate ?? null,
        after_rebate_rate: a.rebate_rate ?? null,
        before_rebate_pct: b.rebate_rate === undefined ? null : pctOf(b.rebate_rate),
        after_rebate_pct: a.rebate_rate === undefined ? null : pctOf(a.rebate_rate),
        before_logistics_cost: b.logistics_cost ?? null,
        after_logistics_cost: a.logistics_cost ?? null,
        diff_logistics_cost: round2(Number(a.logistics_cost ?? 0) - Number(b.logistics_cost ?? 0)),
      });
    }
    ok(res, {
      sku_id: id,
      sku_code: String(sku.sku_code),
      current_rebate_rate: Number(sku.rebate_rate ?? 0),
      current_rebate_pct: pctOf(sku.rebate_rate),
      current_logistics_cost: Number(sku.logistics_cost ?? 0),
      timeline,
      tip: '返点率与物流成本变更只对之后落库的订单生效，历史 rebate_cny / logistics_cny 不回溯；老历史行请重跑「派生汇总」',
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
       /* 新口径下「没算出来」有两种：没绑内部 SKU、绑了但 SKU 没配返点率 —— 都落在 rebate_matched=0，
          这一列就是这条映射上不进利润的行数 */
       (SELECT COUNT(*) FROM tk_order_item oi WHERE oi.listing_id = l.id AND oi.is_deleted = 0 AND oi.rebate_matched = 0) AS unmapped_item_count`;

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
      tip: '历史订单行的返点快照保持冻结，仅之后同步的订单按新映射取品牌返点率',
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

/**
 * 「未映射」在新口径下等于「这一行算不出应收返点」：
 * 明细没绑到内部 SKU，或绑到了但 SKU 的品牌返点率还是 0 —— 两种都落 rebate_matched = 0。
 */
const UNMAPPED_ITEM_WHERE = `oi.is_deleted = 0 AND oi.rebate_matched = 0`;
const UNMAPPED_ITEMS_SUB = `(SELECT COUNT(*) FROM tk_order_item oi WHERE oi.listing_id = l.id AND ${UNMAPPED_ITEM_WHERE})`;
const UNMAPPED_AMOUNT_SUB = `(SELECT COALESCE(SUM(oi.item_amount), 0) FROM tk_order_item oi WHERE oi.listing_id = l.id AND ${UNMAPPED_ITEM_WHERE})`;
const UNMAPPED_COUNT = `${UNMAPPED_ITEMS_SUB} AS unmatched_item_count`;
const UNMAPPED_AMOUNT = `${UNMAPPED_AMOUNT_SUB} AS unmatched_amount`;

/** 待映射清单：列表与导出共用（FROM/SELECT/Q 三份都只有一份，两边口径才不会漂） */
const UNMAPPED_FROM = `shop_listing l JOIN tk_shop s ON s.id = l.shop_id`;
const UNMAPPED_SELECT = `l.*, s.shop_name, s.currency, s.region, ${UNMAPPED_COUNT}, ${UNMAPPED_AMOUNT}`;

function unmappedQ(req: Parameters<typeof current>[0], scope: { sql: string; params: number[] }): Q {
  return withScope(new Q(`l.is_deleted = 0 AND l.map_status = ${MAP_STATUS.UNMAPPED}`), scope)
    .like('(l.product_name LIKE ? OR l.seller_sku LIKE ? OR l.tk_sku_id LIKE ?)', qv(req, 'keyword'))
    .eq('l.shop_id', qv(req, 'shop_id'));
}

const UNMAPPED_EXPORT_COLUMNS = [
  { key: 'tk_sku_id', label: '平台SKU' },
  { key: 'seller_sku', label: '店内编码' },
  { key: 'product_name', label: '平台商品名' },
  { key: 'shop_name', label: '店铺' },
  { key: 'region', label: '站点' },
  { key: 'currency', label: '币种' },
  { key: 'unmatched_item_count', label: '算不出返点的订单行数' },
  { key: 'unmatched_amount', label: '受影响金额(原币)' },
  { key: 'map_status', label: '映射状态' },
  { key: 'updated_at', label: '更新时间' },
];

productRouter.get(
  '/unmapped/export',
  requireExport,
  wrap((req, res) => {
    const user = current(req);
    exportFromList(req, res, {
      module: MODULE,
      targetTable: 'shop_listing',
      filename: 'product-unmapped',
      from: UNMAPPED_FROM,
      select: UNMAPPED_SELECT,
      q: unmappedQ(req, shopScope(user, 'l.shop_id')),
      orderBy: 'unmatched_item_count DESC, l.id DESC',
      columns: UNMAPPED_EXPORT_COLUMNS,
      filters: { keyword: qv(req, 'keyword'), shop_id: qv(req, 'shop_id') },
    });
  }),
);

/**
 * 待映射清单 = map_status=2 的 listing + 其算不出返点的订单行数与影响金额；
 * rows 里额外给出所有「没有返点快照（rebate_matched=0）」的订单行，供运营定位到底是哪几笔单进不了利润。
 * 清单里的行有两类，处理动作不一样，所以把 sku_id 一并给出：NULL=补映射，非 NULL=去 SKU 上配返点率。
 */
productRouter.get(
  '/unmapped',
  wrap((req, res) => {
    const user = current(req);
    const scope = shopScope(user, 'l.shop_id');
    const orderScope = { sql: scope.sql.replace(/l\.shop_id/g, 'o.shop_id'), params: scope.params };
    const page = queryPage(req, {
      from: UNMAPPED_FROM,
      select: UNMAPPED_SELECT,
      q: unmappedQ(req, scope),
      orderBy: 'unmatched_item_count DESC, l.id DESC',
    });
    const rows = all<Record<string, unknown>>(
      `SELECT oi.id AS item_id, o.id AS order_id, o.tk_order_id, o.order_time, o.order_status, o.currency,
              o.shop_id, s.shop_name, l.id AS listing_id, l.tk_sku_id, l.seller_sku, l.product_name,
              oi.sku_id, oi.quantity, oi.unit_price, oi.item_amount,
              ROUND(oi.item_amount * ${RATE_TO_CNY}, 2) AS item_amount_cny,
              ${RATE_TO_CNY} AS rate_to_cny
         FROM tk_order_item oi
         JOIN tk_order o ON o.id = oi.order_id AND o.is_deleted = 0
         JOIN tk_shop s ON s.id = o.shop_id
         LEFT JOIN shop_listing l ON l.id = oi.listing_id
        WHERE oi.is_deleted = 0 AND oi.rebate_matched = 0 ${orderScope.sql}
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
      warn: '以下订单行算不出应收返点（没映射到内部 SKU，或 SKU 未配品牌返点率），已从返点/毛利/利润计算中整体排除（绝不按 0 收入参与计算），请尽快完成映射或配置返点率，然后重跑「派生汇总」',
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

/**
 * 导入行允许只给 spu_code（按款号归属 spu），故 spu_id 从必填放宽为选填。
 * 列名即模板表头：sku_code / spec / rebate_rate / logistics_cost / weight_g / package_size / status；
 * rebate_rate 走同一个 0~1 校验 —— 表格里把 18% 填成 18 的行会被逐行挡下（reason 里带中文说明），
 * 而不是静默落库后让返点放大 100 倍。
 */
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

/** SKU 导出列：返点率是比例（0.18），物流成本是人民币/件；没有「合成单件成本」这一列了 */
const EXPORT_COLUMNS = [
  'sku_code',
  'spu_code',
  'name_cn',
  'category',
  'spec',
  'rebate_rate',
  'logistics_cost',
  'weight_g',
  'package_size',
  'status',
  'listing_count',
] as const;

productRouter.get(
  '/export/sku',
  requireExport,
  wrap(async (req, res) => {
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
    const format = String(qv(req, 'format') ?? '').toLowerCase();
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
        format: format === 'csv' || format === 'xlsx' ? format : 'json',
      },
      ip: req.ip,
    });
    // 默认仍回 JSON（前端表格/既有用例依赖），?format=csv|xlsx 才出文件
    if (format === 'csv' || format === 'xlsx') {
      await sendTable(
        res,
        { filename: `product-sku-${new Date().toISOString().slice(0, 10)}`, headers: [...EXPORT_COLUMNS], rows: list.map((r) => EXPORT_COLUMNS.map((c) => r[c] as ExportCell)) },
        format as 'csv' | 'xlsx',
      );
      return;
    }
    ok(res, { columns: [...EXPORT_COLUMNS], count: list.length, rows: list });
  }),
);
