/**
 * 库存中心（PRD §3.9 / EPIC-2-04，三期可选）
 *
 * 三条口径：
 *  1. 库存只有一个来源：`当前库存 = SUM(stock_ledger.quantity) GROUP BY (warehouse_id, sku_id)`，
 *     不建「库存余量表」，所以不存在两处同时改数对不上的问题（查询页只读）。
 *  2. 流水只可追加与冲销，没有 PUT / DELETE 路由（PRD §3.9）；改错就负数冲一笔，全程可追溯。
 *  3. 自动生成的三类流水（4 销售出库 / 5 样品出库 / 6 退货入库）带 ref_no 时按
 *     `ref_no + change_type + sku_id` 幂等（PRD §6 幂等）：重跑只更新数量，绝不重复扣库存。
 *
 * 安全阈值走 sys_dict(dict_type='safety_stock')：dict_value = SKU 编码，dict_label = 件数；
 * 另有 dict_value='*' 的全局默认，两者都没有时按 20 件。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CurrentUser } from '@tk/shared';
import { all, get, insert, softDelete, update } from '../core/db.js';
import { badRequest, notFound, ok, parseBody, paginate, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { requireMenu, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

export const stockRouter = Router();

/** warehouse.wh_type：1 国内仓 / 2 海外仓 / 3 平台仓 */
export const WH_TYPE_LABEL: Record<number, string> = { 1: '国内仓', 2: '海外仓', 3: '平台仓' };
/** stock_ledger.change_type：入库为正、出库为负（3 调拨 / 7 盘点双向） */
export const CHANGE_TYPE_LABEL: Record<number, string> = {
  1: '采购入库',
  2: '头程发货',
  3: '调拨',
  4: '销售出库',
  5: '样品出库',
  6: '退货入库',
  7: '盘点调整',
};
/** 出库方向（数量应为负）/ 入库方向（数量应为正） */
const OUTBOUND_TYPES = [2, 4, 5];
const INBOUND_TYPES = [1, 6];
/** 自动生成幂等的三类：平台/内部单号驱动，重跑不能重复扣库存 */
const AUTO_TYPES = [4, 5, 6];
const DEFAULT_SAFETY = 20;

/* ==================== 表 20 仓库 warehouse ==================== */

const warehouseBody = z.object({
  name: z.string().min(1).max(100),
  wh_type: z.number().int().min(1).max(3).default(1),
  region: z.string().max(8).nullish(),
  status: z.union([z.literal(0), z.literal(1)]).default(1),
});

/** 仓库名唯一（PRD §3.9：name ≤100 必填唯一）；schema 无唯一索引，靠服务层守 */
function assertWarehouseNameFree(name: string, exceptId = 0): void {
  const hit = get<{ id: number }>(`SELECT id FROM warehouse WHERE is_deleted = 0 AND name = ? AND id <> ?`, name, exceptId);
  if (hit) throw badRequest(`仓库名称「${name}」已存在（ID ${hit.id}），请换一个`);
}

function warehouseQuery(req: Request): Q {
  return new Q('w.is_deleted = 0')
    .eq('w.wh_type', qv(req, 'wh_type'))
    .eq('w.region', qv(req, 'region'), false)
    .eq('w.status', qv(req, 'status'))
    .like(`w.name LIKE ?`, qv(req, 'keyword'));
}

const WAREHOUSE_SELECT = `w.*,
       (SELECT COUNT(*) FROM stock_ledger sl WHERE sl.is_deleted = 0 AND sl.warehouse_id = w.id) AS ledger_rows,
       IFNULL((SELECT SUM(sl.quantity) FROM stock_ledger sl WHERE sl.is_deleted = 0 AND sl.warehouse_id = w.id), 0) AS total_qty`;

/** 仓库下拉（选仓用，不分页） */
function warehouseOptions(): { id: number; name: string; wh_type: number; region: string | null; status: number }[] {
  return all<{ id: number; name: string; wh_type: number; region: string | null; status: number }>(
    `SELECT id, name, wh_type, region, status FROM warehouse WHERE is_deleted = 0 ORDER BY id ASC`,
  );
}

/** PRD §3.9 的菜单路径是 /stock/warehouse，前端 ResourcePage 用 /stock/warehouses —— 两个都认 */
for (const base of ['/warehouses', '/warehouse']) {
  stockRouter.get(
    base,
    requireMenu('stock'),
    wrap((req, res) => ok(res, queryPage(req, { from: 'warehouse w', select: WAREHOUSE_SELECT, q: warehouseQuery(req), orderBy: 'w.id ASC' }))),
  );

  stockRouter.post(
    base,
    requireMenu('stock'),
    wrap((req, res) => {
      const user = current(req);
      const body = parseBody(warehouseBody, req.body);
      assertWarehouseNameFree(body.name);
      const id = insert('warehouse', { name: body.name, wh_type: body.wh_type, region: body.region ?? null, status: body.status, created_by: user.id } as never);
      writeOpLog({ user_id: user.id, module: '库存中心', action: 'create', target_table: 'warehouse', target_id: id, after: body, ip: req.ip });
      ok(res, { id, ...body }, `仓库「${body.name}」已创建`);
    }),
  );

  stockRouter.put(
    `${base}/:id`,
    requireMenu('stock'),
    wrap((req, res) => {
      const user = current(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) throw badRequest('仓库 ID 不合法');
      const before = get<Record<string, unknown>>(`SELECT * FROM warehouse WHERE id = ? AND is_deleted = 0`, id);
      if (!before) throw notFound('仓库不存在');
      const body = parseBody(warehouseBody.partial(), req.body);
      const name = String(body.name ?? before.name);
      assertWarehouseNameFree(name, id);
      update('warehouse', id, { ...body, name } as never);
      writeOpLog({
        user_id: user.id,
        module: '库存中心',
        action: 'update',
        target_table: 'warehouse',
        target_id: id,
        before: { name: before.name, wh_type: before.wh_type, region: before.region, status: before.status },
        after: { ...before, ...body, name },
        ip: req.ip,
      });
      ok(res, { id, name });
    }),
  );

  /** 停用为主：仍有在库数量时禁止删除，避免账面库存凭空消失 */
  stockRouter.delete(
    `${base}/:id`,
    requireMenu('stock'),
    wrap((req, res) => {
      const user = current(req);
      const id = Number(req.params.id);
      const before = get<{ name: string }>(`SELECT name FROM warehouse WHERE id = ? AND is_deleted = 0`, id);
      if (!before) throw notFound('仓库不存在');
      const qty = Number(get<{ q: number | string | null }>(`SELECT SUM(quantity) AS q FROM stock_ledger WHERE is_deleted = 0 AND warehouse_id = ?`, id)?.q ?? 0);
      if (qty > 0) throw badRequest(`「${before.name}」尚有在库 ${qty} 件，请先清仓或改为停用`);
      if (qty < 0) softDelete('warehouse', id);
      else update('warehouse', id, { status: 0 } as never);
      writeOpLog({ user_id: user.id, module: '库存中心', action: 'delete', target_table: 'warehouse', target_id: id, before, ip: req.ip });
      ok(res, { id }, qty < 0 ? `账面为负 ${qty} 件，仓库已标记删除，请核对流水` : '仓库已停用');
    }),
  );
}

stockRouter.get(
  '/warehouse/options',
  requireMenu('stock'),
  wrap((_req, res) => {
    const list = warehouseOptions();
    ok(res, { list, total: list.length });
  }),
);

/* ==================== 表 21 出入库流水 stock_ledger ==================== */

const ledgerBody = z.object({
  warehouse_id: z.number().int().positive(),
  sku_id: z.number().int().positive(),
  change_type: z.number().int().min(1).max(7),
  quantity: z.number().int(),
  ref_no: z.string().max(64).nullish(),
  op_time: z.string().min(10).max(20),
});

function ledgerQuery(req: Request): Q {
  return new Q('t.is_deleted = 0')
    .eq('t.warehouse_id', qv(req, 'warehouse_id'))
    .eq('t.sku_id', qv(req, 'sku_id'))
    .eq('t.change_type', qv(req, 'change_type'))
    .eq('t.ref_no', qv(req, 'ref_no'), false)
    .between('t.op_time', qv(req, 'op_time_from') ?? qv(req, 'from'), qv(req, 'op_time_to') ?? qv(req, 'to'))
    .like(`t.ref_no LIKE ? OR sk.sku_code LIKE ? OR sk.spec LIKE ? OR u.real_name LIKE ?`, qv(req, 'keyword'));
}

const LEDGER_FROM = `stock_ledger t
       LEFT JOIN warehouse w ON w.id = t.warehouse_id
       LEFT JOIN product_sku sk ON sk.id = t.sku_id
       LEFT JOIN product_spu sp ON sp.id = sk.spu_id
       LEFT JOIN sys_user u ON u.id = t.operator_id`;
const LEDGER_SELECT = `t.*, w.name AS warehouse_name, w.wh_type, sk.sku_code, sk.spec, sp.spu_code, sp.name_cn AS spu_name,
       IFNULL(u.real_name, '系统') AS operator_name`;

stockRouter.get(
  '/ledger',
  requireMenu('stock'),
  wrap((req, res) => {
    const q = ledgerQuery(req);
    const page = queryPage(req, { from: LEDGER_FROM, select: LEDGER_SELECT, q, orderBy: 't.op_time DESC, t.id DESC' });
    const agg = get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS cnt, IFNULL(SUM(t.quantity), 0) AS net_qty,
              IFNULL(SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END), 0) AS in_qty,
              IFNULL(SUM(CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END), 0) AS out_qty
         FROM ${LEDGER_FROM}${q.whereSql}`,
      ...q.params,
    );
    ok(res, {
      ...page,
      summary: {
        rows: Number(agg?.cnt ?? 0),
        net_qty: Number(agg?.net_qty ?? 0),
        in_qty: Number(agg?.in_qty ?? 0),
        out_qty: Number(agg?.out_qty ?? 0),
      },
    });
  }),
);

/** 手工登记流水（PRD §3.9：只可追加，改错走冲销；自动生成的三类按 ref_no 幂等） */
stockRouter.post(
  '/ledger',
  requireMenu('stock'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(ledgerBody, req.body);
    const wh = get<{ id: number; name: string; status: number }>(`SELECT id, name, status FROM warehouse WHERE id = ? AND is_deleted = 0`, body.warehouse_id);
    if (!wh) throw notFound('仓库不存在');
    if (Number(wh.status) !== 1) throw badRequest(`仓库「${wh.name}」已停用，不能记账`);
    const sku = get<{ id: number; sku_code: string }>(`SELECT id, sku_code FROM product_sku WHERE id = ? AND is_deleted = 0`, body.sku_id);
    if (!sku) throw notFound('SKU 不存在');
    if (body.quantity === 0) throw badRequest('数量不能为 0：入库填正数、出库填负数');
    const refNo = String(body.ref_no ?? '').trim() || null;
    const directionHint =
      OUTBOUND_TYPES.includes(body.change_type) && body.quantity > 0
        ? `「${CHANGE_TYPE_LABEL[body.change_type]}」为出库方向但数量为正，请核对`
        : INBOUND_TYPES.includes(body.change_type) && body.quantity < 0
          ? `「${CHANGE_TYPE_LABEL[body.change_type]}」为入库方向但数量为负，请核对`
          : '';
    const fields = {
      warehouse_id: body.warehouse_id,
      sku_id: body.sku_id,
      change_type: body.change_type,
      quantity: body.quantity,
      ref_no: refNo,
      op_time: body.op_time,
      operator_id: user.id,
      created_by: user.id,
    };
    // 幂等键 (ref_no, change_type, sku_id)：自动流水重跑只覆盖数量，人工流水允许同单号多笔
    const exist = refNo
      ? get<{ id: number; quantity: number }>(
          `SELECT id, quantity FROM stock_ledger WHERE is_deleted = 0 AND ref_no = ? AND change_type = ? AND sku_id = ?`,
          refNo,
          body.change_type,
          body.sku_id,
        )
      : undefined;
    const overwrite = !!exist && AUTO_TYPES.includes(body.change_type);
    const id = overwrite ? Number(exist?.id) : insert('stock_ledger', fields as never);
    if (overwrite) update('stock_ledger', id, fields as never);
    writeOpLog({
      user_id: user.id,
      module: '库存中心',
      action: overwrite ? 'update' : 'create',
      target_table: 'stock_ledger',
      target_id: id,
      before: overwrite ? { quantity: exist?.quantity, ref_no: refNo } : undefined,
      after: { ...fields, warehouse_name: wh.name, sku_code: sku.sku_code },
      ip: req.ip,
    });
    const warn = directionHint || (exist && !overwrite ? `同单号 ${refNo} 已有 ${exist.quantity} 件流水，本次按追加处理` : '');
    ok(res, { id, duplicated: overwrite, quantity: body.quantity }, overwrite ? `该单号已记过这笔流水，已按 ${body.quantity} 件覆盖（不重复扣库存）` : warn || '流水已追加');
  }),
);

/** 冲销：负数镜像一笔盘点调整，原流水不改（PRD §3.9「只可追加与冲销」） */
stockRouter.post(
  '/ledger/:id/reverse',
  requireMenu('stock'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) throw badRequest('流水 ID 不合法');
    const row = get<Record<string, unknown>>(`SELECT * FROM stock_ledger WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('流水不存在');
    const quantity = -Number(row.quantity ?? 0);
    if (quantity === 0) throw badRequest('原流水数量为 0，无需冲销');
    const refNo = `${String(row.ref_no ?? `#${id}`)}-REV`;
    if (get<{ id: number }>(`SELECT id FROM stock_ledger WHERE is_deleted = 0 AND ref_no = ? AND sku_id = ?`, refNo, Number(row.sku_id))) {
      throw badRequest('该流水已冲销过，不能重复冲销');
    }
    const newId = insert('stock_ledger', {
      warehouse_id: Number(row.warehouse_id),
      sku_id: Number(row.sku_id),
      change_type: 7,
      quantity,
      ref_no: refNo,
      op_time: String(qv(req, 'op_time') ?? new Date().toISOString().slice(0, 19).replace('T', ' ')),
      operator_id: user.id,
      created_by: user.id,
    } as never);
    writeOpLog({
      user_id: user.id,
      module: '库存中心',
      action: 'create',
      target_table: 'stock_ledger',
      target_id: newId,
      before: { id, quantity: Number(row.quantity) },
      after: { id: newId, quantity, ref_no: refNo },
      ip: req.ip,
    });
    ok(res, { id: newId, reverse_of: id, quantity }, `已冲销 #${id}（记为盘点调整 ${quantity} 件）`);
  }),
);

/* ==================== 库存查询：流水汇总（只读） ==================== */

/** 安全阈值：SKU 专属 > 全局 '*' > 20（sys_dict 维护，PRD §3.9） */
const SAFETY_SQL = `CAST(IFNULL(
        (SELECT d.dict_label FROM sys_dict d WHERE d.is_deleted = 0 AND d.status = 1 AND d.dict_type = 'safety_stock' AND d.dict_value = sk.sku_code LIMIT 1),
        IFNULL((SELECT d.dict_label FROM sys_dict d WHERE d.is_deleted = 0 AND d.status = 1 AND d.dict_type = 'safety_stock' AND d.dict_value = '*' LIMIT 1), '${DEFAULT_SAFETY}')
      ) AS INTEGER)`;

function stockFilter(req: Request): { sql: string; params: (string | number)[] } {
  const parts: string[] = ['t.is_deleted = 0', 'sk.is_deleted = 0'];
  const params: (string | number)[] = [];
  const push = (cond: string, ...p: (string | number)[]): void => {
    parts.push(cond);
    params.push(...p);
  };
  const wh = Number(qv(req, 'warehouse_id') ?? 0);
  if (wh > 0) push('t.warehouse_id = ?', wh);
  const sku = Number(qv(req, 'sku_id') ?? 0);
  if (sku > 0) push('t.sku_id = ?', sku);
  const spu = Number(qv(req, 'spu_id') ?? 0);
  if (spu > 0) push('sk.spu_id = ?', spu);
  const type = Number(qv(req, 'wh_type') ?? 0);
  if (type > 0) push('w.wh_type = ?', type);
  const kw = String(qv(req, 'keyword') ?? '').trim();
  if (kw) push('(sk.sku_code LIKE ? OR sk.spec LIKE ? OR sp.name_cn LIKE ?)', `%${kw}%`, `%${kw}%`, `%${kw}%`);
  return { sql: `WHERE ${parts.join(' AND ')}`, params };
}

const STOCK_GROUPS = `stock_ledger t
       JOIN product_sku sk ON sk.id = t.sku_id
       LEFT JOIN product_spu sp ON sp.id = sk.spu_id
       LEFT JOIN warehouse w ON w.id = t.warehouse_id`;

const STOCK_BODY = `SELECT t.warehouse_id, w.name AS warehouse_name, w.wh_type, t.sku_id, sk.sku_code, sk.spec,
                          sk.spu_id, sp.spu_code, sp.name_cn AS spu_name,
                          SUM(t.quantity) AS qty, MAX(${SAFETY_SQL}) AS safety_stock,
                          MAX(t.op_time) AS last_op, COUNT(*) AS ledger_rows
                     FROM ${STOCK_GROUPS}
                     %WHERE%
                    GROUP BY t.warehouse_id, w.name, w.wh_type, t.sku_id, sk.sku_code, sk.spec, sk.spu_id, sp.spu_code, sp.name_cn`;

const SORT_COLS: Record<string, string> = {
  qty: 'g.qty',
  sku_code: 'g.sku_code',
  warehouse_name: 'g.warehouse_name',
  last_op: 'g.last_op',
};

/** 当前库存 = SUM(quantity)：低库存/断货按 sys_dict 阈值判定，本表只读不改数 */
stockRouter.get(
  '/query',
  requireMenu('stock'),
  wrap((req, res) => {
    const f = stockFilter(req);
    const body = STOCK_BODY.replace('%WHERE%', f.sql);
    const { limit, offset, page, pageSize } = paginate(req);
    const sortBy = SORT_COLS[qv(req, 'sortBy') ?? ''] ? (qv(req, 'sortBy') as string) : 'qty';
    const asc = qv(req, 'sortOrder') === 'asc';
    // 「只看低库存」是聚合后的条件，只能挂在包装层的 WHERE 上
    const lowOnly = qv(req, 'low_only') === '1' || qv(req, 'low') === '1';
    const wrapper = `FROM (${body}) g ${lowOnly ? 'WHERE g.qty <= g.safety_stock' : ''}`;
    const list = all<Record<string, unknown>>(`SELECT * ${wrapper} ORDER BY ${SORT_COLS[sortBy]} ${asc ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`, ...f.params, limit, offset);
    const total = Number(get<{ c: number | string }>(`SELECT COUNT(*) AS c ${wrapper}`, ...f.params)?.c ?? 0);
    const agg = get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS combos, IFNULL(SUM(g.qty), 0) AS total_qty,
              SUM(CASE WHEN g.qty <= 0 THEN 1 ELSE 0 END) AS zero_rows,
              SUM(CASE WHEN g.qty > 0 AND g.qty <= g.safety_stock THEN 1 ELSE 0 END) AS low_rows
         FROM (${body}) g`,
      ...f.params,
    );
    ok(res, {
      list: list.map((r) => ({ ...r, status: Number(r.qty ?? 0) <= 0 ? '断货' : Number(r.qty ?? 0) <= Number(r.safety_stock ?? DEFAULT_SAFETY) ? '低库存' : '正常' })),
      total,
      page,
      pageSize,
      summary: {
        combos: Number(agg?.combos ?? 0),
        total_qty: Number(agg?.total_qty ?? 0),
        zero_rows: Number(agg?.zero_rows ?? 0),
        low_rows: Number(agg?.low_rows ?? 0),
        threshold_default: DEFAULT_SAFETY,
      },
    });
  }),
);

/** 单个 SKU × 仓库的流水下钻（查询页「看流水」用，口径同 /ledger） */
stockRouter.get(
  '/query/detail',
  requireMenu('stock'),
  wrap((req, res) => {
    const skuId = Number(qv(req, 'sku_id') ?? 0);
    if (skuId <= 0) throw badRequest('sku_id 必填');
    const q = ledgerQuery(req).eq('t.sku_id', skuId);
    ok(res, queryPage(req, { from: LEDGER_FROM, select: LEDGER_SELECT, q, orderBy: 't.op_time ASC, t.id ASC' }));
  }),
);

/**
 * SKU / SPU 选择器：库存建档必须选 SKU，但仓库角色没有 product 菜单，
 * 所以这里只出编码与规格（无成本字段），按 stock 菜单把关，不让前端去蹭 /products/*。
 */
stockRouter.get(
  '/skus',
  requireMenu('stock'),
  wrap((req, res) => {
    const q = new Q('k.is_deleted = 0').like(
      `k.sku_code LIKE ? OR k.spec LIKE ? OR p.name_cn LIKE ? OR p.spu_code LIKE ?`,
      qv(req, 'keyword'),
    );
    ok(res, queryPage(req, {
      from: 'product_sku k LEFT JOIN product_spu p ON p.id = k.spu_id AND p.is_deleted = 0',
      select: 'k.id, k.sku_code, k.spec, k.status, k.spu_id, p.spu_code, p.name_cn',
      q,
      orderBy: 'k.id DESC',
    }));
  }),
);

stockRouter.get(
  '/spus',
  requireMenu('stock'),
  wrap((req, res) => {
    const q = new Q('p.is_deleted = 0').like(`p.name_cn LIKE ? OR p.spu_code LIKE ?`, qv(req, 'keyword'));
    ok(res, queryPage(req, {
      from: 'product_spu p',
      select: 'p.id, p.spu_code, p.name_cn, p.category, p.status',
      q,
      orderBy: 'p.spu_code ASC',
    }));
  }),
);

/** 变动类型 / 仓库类型字典（前端下拉与标签色用） */
stockRouter.get(
  '/meta',
  requireMenu('stock'),
  wrap((_req, res) =>
    ok(res, {
      change_type: Object.entries(CHANGE_TYPE_LABEL).map(([v, label]) => ({ value: Number(v), label })),
      wh_type: Object.entries(WH_TYPE_LABEL).map(([v, label]) => ({ value: Number(v), label })),
      outbound: OUTBOUND_TYPES,
      inbound: INBOUND_TYPES,
      warehouses: warehouseOptions(),
      threshold_default: DEFAULT_SAFETY,
    }),
  ),
);
