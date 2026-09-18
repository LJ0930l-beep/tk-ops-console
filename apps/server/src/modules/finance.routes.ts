/**
 * 财务中心（方案 6.2 财务 + 表 16/17/18 + 设计要点 1/3/5）
 *
 * 四条口径（金额一律人民币出报表，明细币种只做过程展示）：
 *  1. settlement_txn 是平台实际打款流水，收入为正、扣款为负；列表与汇总都按结算日汇率折 CNY。
 *  2. 预估 vs 实际两套并存：/settlement/reconcile 逐单对齐（订单实收 vs 结算实收 + 差异拆解），
 *     差异必须能解释到「平台佣金 / 达人佣金 / 运费 / 退款 / 补贴 / 调整 / 收入基数」，残差只允许四舍五入。
 *  3. expense.amount_cny 在新增/修改时按当日汇率写入（取不到当日按该币种最近一条，再取不到用兜底常量并标 rate_missing）。
 *  4. 利润报表成本敏感：无 can_see_cost 直接 403（不是掩码成 ***，整张表都不给看）。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { round2, type CurrentUser } from '@tk/shared';
import { all, get, insert, softDelete, tx, update, type SqlParam } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, parseBody, paginate, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, writeOpLog } from '../core/oplog.js';
import {
  EXPENSE_TYPE_LABEL,
  REPORT_DIMS,
  SETTLE_TXN_LABEL,
  TREND_DIMS,
  computeOrderProfit,
  computeProfitReport,
  reconcileByOrder,
  type ProfitDim,
  type ReconcileRow,
} from '../services/profit.js';
import { createRateConverter, getRate, latestRates, listCurrencies, listRates, mockFetchRates, rateDay, toCnySql, upsertRate } from '../services/rates.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

/** 报表型接口统一要成本权限（要点 1：成本口径不能给无权限的人看） */
function requireCost(req: Request, _res: Response, next: NextFunction): void {
  const user = current(req);
  if (!user?.can_see_cost) return next(forbidden('利润报表含成本与利润口径，当前角色无成本查看权限'));
  next();
}

/** CSV 导出：加 BOM 让 Excel 直接识别 UTF-8 */
function sendCsv(res: Response, filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const esc = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(`\uFEFF${body}`);
}

const shopFilter = (req: Request, col: string): { sql: string; params: number[] } => {
  const scope = shopScope(current(req), col);
  const picked = Number(qv(req, 'shop_id') ?? 0);
  if (!picked) return scope;
  if (scope.sql && !scope.params.includes(picked)) return { sql: `AND 1 = 0`, params: [] };
  return { sql: `AND ${col} = ?`, params: [picked] };
};

/** 请求里的店铺范围（多选 shop_ids 优先，其次单个 shop_id），利润引擎与报表共用 */
function requestedShops(req: Request): number[] {
  const raw = qv(req, 'shop_ids') ?? '';
  const list = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const one = Number(qv(req, 'shop_id') ?? 0);
  if (one > 0) list.push(one);
  return [...new Set(list)];
}

/* ==================== 表 16 结算流水 settlement_txn ==================== */

export const financeRouter = Router();

/** 结算金额折人民币：按结算日落库汇率，取不到用兜底牌价（与 JS 侧同一套常量） */
const SETTLE_CNY = toCnySql('t.amount', "COALESCE(t.currency, 'USD')", "IFNULL(substr(t.statement_time, 1, 10), date('now'))");
const RETURN_CNY = toCnySql('t.refund_amount', "COALESCE(t.currency, 'USD')", "IFNULL(substr(t.apply_time, 1, 10), date('now'))");

function settlementBase(req: Request): { q: Q; orderScope: string } {
  const scope = shopFilter(req, 't.shop_id');
  const q = new Q('t.is_deleted = 0')
    .and(scope.sql || '', ...scope.params)
    .eq('t.statement_id', qv(req, 'statement_id'), false)
    .eq('t.tk_order_id', qv(req, 'tk_order_id') ?? qv(req, 'order_no'), false)
    .eq('t.txn_type', qv(req, 'txn_type'))
    .eq('t.payment_status', qv(req, 'payment_status'))
    .eq('t.currency', qv(req, 'currency'), false)
    // 区间：PRD §3.8 用 statement_time_from/to，from/to 作为简写一并接受
    .between('t.statement_time', qv(req, 'from') ?? qv(req, 'statement_time_from'), qv(req, 'to') ?? qv(req, 'statement_time_to'));
  return { q, orderScope: scope.sql };
}

const SETTLE_FROM = `settlement_txn t
       LEFT JOIN tk_shop s ON s.id = t.shop_id
       LEFT JOIN tk_order o ON o.tk_order_id = t.tk_order_id AND o.is_deleted = 0`;
const SETTLE_SELECT = `t.*, s.shop_name, o.id AS order_id, o.order_status, ROUND(${SETTLE_CNY}, 2) AS amount_cny`;
const SETTLE_ORDER = 't.statement_time DESC, t.id DESC';

/** 结算状态桶：1 已打款 / 2 处理中 / 3 打款失败（前端页顶卡片按 payment_status 读扁平键） */
interface SettleBucket {
  rows: number;
  income_cny: number;
  deduction_cny: number;
  net_cny: number;
  paid_cny: number;
  pending_cny: number;
  statements: number;
  paid_count: number;
  paid_amount: number;
  processing_count: number;
  processing_amount: number;
  failed_count: number;
  failed_amount: number;
  net_amount: number;
}

/** 扣款构成（饼图）+ 到账 / 待打款：口径与列表完全同一份 WHERE */
function settlementSummary(q: Q): SettleBucket & {
  by_shop: { shop_id: number; shop_name: string; rows: number; net_cny: number; paid_cny: number; pending_cny: number; failed_cny: number }[];
  by_txn_type: { txn_type: number; txn_name: string; count: number; amount_src: number; amount_cny: number }[];
  by_payment_status: { payment_status: number; status_name: string; amount_cny: number; count: number }[];
} {
  const agg = get<Record<string, number | string | null>>(
    `SELECT COUNT(*) AS rows,
            IFNULL(ROUND(SUM(CASE WHEN t.amount >= 0 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS income_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.amount < 0 THEN -${SETTLE_CNY} ELSE 0 END), 2), 0) AS deduction_cny,
            IFNULL(ROUND(SUM(${SETTLE_CNY}), 2), 0) AS net_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 1 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS paid_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status <> 1 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS pending_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 2 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS processing_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 3 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS failed_cny,
            SUM(CASE WHEN t.payment_status = 1 THEN 1 ELSE 0 END) AS paid_count,
            SUM(CASE WHEN t.payment_status = 2 THEN 1 ELSE 0 END) AS processing_count,
            SUM(CASE WHEN t.payment_status = 3 THEN 1 ELSE 0 END) AS failed_count,
            COUNT(DISTINCT t.statement_id) AS statements
       FROM ${SETTLE_FROM}${q.whereSql}`,
    ...q.params,
  );
  const byType = all<{ txn_type: number | null; cnt: number | string; amount_src: number | null; amount_cny: number | null }>(
    `SELECT t.txn_type AS txn_type, COUNT(*) AS cnt, ROUND(SUM(t.amount), 2) AS amount_src, ROUND(SUM(${SETTLE_CNY}), 2) AS amount_cny
       FROM ${SETTLE_FROM}${q.whereSql}
      GROUP BY t.txn_type`,
    ...q.params,
  );
  const byStatus = all<{ payment_status: number; cnt: number | string; amount_cny: number | null }>(
    `SELECT t.payment_status AS payment_status, COUNT(*) AS cnt, ROUND(SUM(${SETTLE_CNY}), 2) AS amount_cny
       FROM ${SETTLE_FROM}${q.whereSql}
      GROUP BY t.payment_status ORDER BY t.payment_status ASC`,
    ...q.params,
  );
  const byShop = all<Record<string, number | string | null>>(
    `SELECT t.shop_id AS shop_id, IFNULL(s.shop_name, '店铺' || t.shop_id) AS shop_name,
            COUNT(*) AS cnt,
            IFNULL(ROUND(SUM(${SETTLE_CNY}), 2), 0) AS net_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 1 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS paid_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 2 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS pending_cny,
            IFNULL(ROUND(SUM(CASE WHEN t.payment_status = 3 THEN ${SETTLE_CNY} ELSE 0 END), 2), 0) AS failed_cny
       FROM ${SETTLE_FROM}${q.whereSql}
      GROUP BY t.shop_id, shop_name
      ORDER BY net_cny DESC`,
    ...q.params,
  );
  return {
    rows: Number(agg?.rows ?? 0),
    income_cny: Number(agg?.income_cny ?? 0),
    deduction_cny: Number(agg?.deduction_cny ?? 0),
    net_cny: Number(agg?.net_cny ?? 0),
    paid_cny: Number(agg?.paid_cny ?? 0),
    pending_cny: Number(agg?.pending_cny ?? 0),
    statements: Number(agg?.statements ?? 0),
    // 前端 SettlementList.vue 读扁平键：已打款 / 处理中 / 失败 各一组，净额与 income 同源
    paid_count: Number(agg?.paid_count ?? 0),
    paid_amount: Number(agg?.paid_cny ?? 0),
    processing_count: Number(agg?.processing_count ?? 0),
    processing_amount: Number(agg?.processing_cny ?? 0),
    failed_count: Number(agg?.failed_count ?? 0),
    failed_amount: Number(agg?.failed_cny ?? 0),
    net_amount: Number(agg?.net_cny ?? 0),
    by_shop: byShop.map((r) => ({
      shop_id: Number(r.shop_id),
      shop_name: String(r.shop_name ?? ''),
      rows: Number(r.cnt),
      net_cny: Number(r.net_cny ?? 0),
      paid_cny: Number(r.paid_cny ?? 0),
      pending_cny: Number(r.pending_cny ?? 0),
      failed_cny: Number(r.failed_cny ?? 0),
    })),
    by_txn_type: byType
      .map((r) => ({
        txn_type: Number(r.txn_type ?? 0),
        txn_name: SETTLE_TXN_LABEL[Number(r.txn_type ?? 0)] ?? '其他',
        count: Number(r.cnt),
        amount_src: Number(r.amount_src ?? 0),
        amount_cny: Number(r.amount_cny ?? 0),
      }))
      .sort((a, b) => Math.abs(b.amount_cny) - Math.abs(a.amount_cny)),
    by_payment_status: byStatus.map((r) => ({
      payment_status: Number(r.payment_status),
      status_name: Number(r.payment_status) === 1 ? '已打款' : Number(r.payment_status) === 3 ? '打款失败' : '处理中',
      amount_cny: Number(r.amount_cny ?? 0),
      count: Number(r.cnt),
    })),
  };
}

financeRouter.get(
  '/settlement',
  requireMenu('finance'),
  wrap((req, res) => {
    const { q } = settlementBase(req);
    const page = queryPage(req, { from: SETTLE_FROM, select: SETTLE_SELECT, q, orderBy: SETTLE_ORDER });
    ok(res, { ...page, summary: settlementSummary(q) });
  }),
);

financeRouter.get(
  '/settlement/summary',
  requireMenu('finance'),
  wrap((req, res) => ok(res, settlementSummary(settlementBase(req).q))),
);

/** 结算流水按账单号分批汇总（账单页签下钻用） */
financeRouter.get(
  '/settlement/statements',
  requireMenu('finance'),
  wrap((req, res) => {
    const { q } = settlementBase(req);
    const list = all<{
      statement_id: string | null;
      statement_time: string | null;
      shop_id: number;
      shop_name: string | null;
      cnt: number | string;
      amount_cny: number | null;
      paid_cny: number | null;
      pending_cny: number | null;
    }>(
      `SELECT t.statement_id, MIN(t.statement_time) AS statement_time, t.shop_id, s.shop_name,
              COUNT(*) AS cnt,
              ROUND(SUM(${SETTLE_CNY}), 2) AS amount_cny,
              ROUND(SUM(CASE WHEN t.payment_status = 1 THEN ${SETTLE_CNY} ELSE 0 END), 2) AS paid_cny,
              ROUND(SUM(CASE WHEN t.payment_status <> 1 THEN ${SETTLE_CNY} ELSE 0 END), 2) AS pending_cny
         FROM ${SETTLE_FROM}${q.whereSql}
        GROUP BY t.statement_id, t.shop_id
        ORDER BY amount_cny DESC`,
      ...q.params,
    ).map((r) => ({
      statement_id: r.statement_id ?? '',
      statement_time: r.statement_time,
      shop_id: Number(r.shop_id),
      shop_name: r.shop_name ?? '',
      count: Number(r.cnt),
      amount_cny: Number(r.amount_cny ?? 0),
      paid_cny: Number(r.paid_cny ?? 0),
      pending_cny: Number(r.pending_cny ?? 0),
    }));
    ok(res, { list, total: list.length });
  }),
);

const settleImportRow = z.object({
  shop_id: z.number().int().positive().optional(),
  tk_shop_id: z.string().max(64).optional(),
  statement_id: z.string().min(1).max(64),
  statement_time: z.string().max(32).nullish(),
  tk_order_id: z.string().max(64).nullish(),
  txn_type: z.number().int().min(1).max(8),
  amount: z.number(),
  currency: z.string().length(3).optional(),
  payment_id: z.string().max(64).nullish(),
  payment_status: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

/**
 * 账单导入：(shop_id, statement_id, tk_order_id, txn_type) 唯一（对齐 ux_settle_txn）。
 * 同一份账单重复导入只更新金额与打款状态，绝不产生第二条流水 —— 财务重跑不重复计钱。
 */
financeRouter.post(
  '/settlement/import',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(
      z.object({ rows: z.array(settleImportRow).min(1).max(5000), overwrite: z.boolean().default(true) }),
      req.body,
    );
    const scope = shopScope(user, 'id');
    const out = { total: body.rows.length, inserted: 0, updated: 0, skipped: 0, invalid: [] as { index: number; reason: string }[] };
    tx(() => {
      body.rows.forEach((r, index) => {
        const shopId =
          r.shop_id ??
          (r.tk_shop_id ? Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 AND tk_shop_id = ?`, String(r.tk_shop_id))?.id ?? 0) : 0);
        if (!shopId) return void out.invalid.push({ index, reason: 'shop_id / tk_shop_id 无法定位店铺' });
        if (scope.sql && !scope.params.includes(shopId)) return void out.invalid.push({ index, reason: `店铺 ${shopId} 不在你的数据范围内` });
        if (!get(`SELECT id FROM tk_shop WHERE id = ? AND is_deleted = 0`, shopId)) return void out.invalid.push({ index, reason: `店铺 ${shopId} 不存在` });
        const exist = get<{ id: number }>(
          `SELECT id FROM settlement_txn WHERE is_deleted = 0 AND shop_id = ? AND IFNULL(statement_id, '') = ? AND IFNULL(tk_order_id, '') = ? AND txn_type = ?`,
          shopId,
          r.statement_id,
          r.tk_order_id ?? '',
          r.txn_type,
        );
        if (exist) {
          if (!body.overwrite) return void (out.skipped += 1);
          update('settlement_txn', exist.id, {
            statement_time: r.statement_time ?? null,
            amount: r.amount,
            currency: r.currency ?? 'USD',
            payment_id: r.payment_id ?? null,
            payment_status: r.payment_status ?? 2,
          } as never);
          out.updated += 1;
          return;
        }
        insert('settlement_txn', {
          shop_id: shopId,
          statement_id: r.statement_id,
          statement_time: r.statement_time ?? null,
          tk_order_id: r.tk_order_id ?? null,
          txn_type: r.txn_type,
          amount: r.amount,
          currency: r.currency ?? 'USD',
          payment_id: r.payment_id ?? null,
          payment_status: r.payment_status ?? 2,
          created_by: user.id,
        });
        out.inserted += 1;
      });
    });
    writeOpLog({
      user_id: user.id,
      module: '财务中心',
      action: 'create',
      target_table: 'settlement_txn',
      after: out,
      ip: req.ip,
    });
    ok(res, out, `导入完成：新增 ${out.inserted}，更新 ${out.updated}，无效 ${out.invalid.length}`);
  }),
);

/* ==================== 逐单对账（要点 3） ==================== */

function reconcileFilter(req: Request) {
  const user = current(req);
  return {
    user,
    shopIds: reportShopIds(req, user),
    start: rateDay(qv(req, 'start') ?? qv(req, 'from') ?? '') || undefined,
    end: rateDay(qv(req, 'end') ?? qv(req, 'to') ?? '') || undefined,
    orderNo: qv(req, 'tk_order_id') ?? qv(req, 'order_no'),
  };
}

const RECONCILE_HEADERS = [
  '平台单号',
  '店铺',
  '币种',
  '站点统计日',
  '订单状态',
  '剔除原因',
  '预估实收(原币)',
  '预估实收(CNY)',
  '结算实收(CNY)',
  '已打款(CNY)',
  '差异(CNY)',
  '差异率(%)',
  '订单收入(CNY)',
  '退款(CNY)',
  '平台佣金(CNY)',
  '达人佣金-结算(CNY)',
  '达人佣金-预估(CNY)',
  '运费(CNY)',
  '补贴(CNY)',
  '调整(CNY)',
  '拆解残差(CNY)',
  '账单号',
  '未映射行',
  '汇率缺失',
];

const reconcileCsvRow = (r: ReconcileRow): (string | number)[] => [
  r.tk_order_id,
  r.shop_name,
  r.currency,
  r.stat_date,
  r.order_status,
  r.excluded_reason,
  r.est_total_paid_src,
  r.est_total_paid_cny,
  r.settled_cny,
  r.settled_paid_cny,
  r.diff_cny,
  r.diff_rate,
  r.settle_income_cny,
  r.settle_refund_cny,
  r.platform_fee_cny,
  r.settled_commission_cny,
  r.est_commission_cny,
  r.shipping_fee_cny,
  r.subsidy_cny,
  r.adjust_cny,
  r.explain_residual_cny,
  r.statements.join('|'),
  r.unmapped_items,
  r.rate_missing ? 1 : 0,
];

/**
 * 按单对账时把窗口起点拉到下单日：引擎默认只看近 30 天，
 * 而财务是按平台单号找回半年前的那一单，不能因为窗口外就查不到。
 */
function reconcileWindow(f: ReturnType<typeof reconcileFilter>): ReturnType<typeof reconcileFilter> {
  if (!f.orderNo || f.start) return f;
  const hit = get<{ order_time: string | null }>(
    `SELECT MIN(order_time) AS order_time FROM tk_order WHERE is_deleted = 0 AND tk_order_id = ?`,
    f.orderNo,
  );
  const day = rateDay(hit?.order_time ?? '');
  return day ? { ...f, start: day } : f;
}

/** 逐单对账：预估 vs 结算，含差异拆解与残差；默认只列有结算流水的单 */
const reconcileHandler = wrap((req: Request, res: Response) => {
  const f = reconcileWindow(reconcileFilter(req));
  const result = reconcileByOrder(f);
  let list = result.list;
  if (f.orderNo) list = list.filter((r) => r.tk_order_id === f.orderNo);
  const only = qv(req, 'only');
  if (only === 'settled') list = list.filter((r) => r.has_settlement);
  if (only === 'diff') list = list.filter((r) => Math.abs(r.diff_cny) > 0.01);
  if (only === 'unsettled') list = list.filter((r) => !r.has_settlement);
  const { page, pageSize } = paginate(req);
  ok(res, {
    start: result.start,
    end: result.end,
    anchored: result.anchored,
    summary: result.summary,
    total: list.length,
    page,
    pageSize,
    list: list.slice((page - 1) * pageSize, page * pageSize),
  });
});

/** PRD §3.8 的正式路径（按单号找回预估 vs 实际差异），与 /settlement/reconcile 同一实现 */
financeRouter.get('/reconcile', requireMenu('finance'), requireCost, reconcileHandler);
financeRouter.get(
  '/settlement/reconcile',
  requireMenu('finance'),
  requireCost,
  reconcileHandler,
);

financeRouter.get(
  '/settlement/reconcile/export',
  requireMenu('finance'),
  requireCost,
  requireExport,
  wrap((req, res) => {
    const f = reconcileWindow(reconcileFilter(req));
    const result = reconcileByOrder(f);
    const list = f.orderNo ? result.list.filter((r) => r.tk_order_id === f.orderNo) : result.list;
    writeOpLog({
      user_id: current(req).id,
      module: '财务中心',
      action: 'export',
      target_table: 'settlement_txn',
      after: { kind: 'settlement_reconcile', start: result.start, end: result.end, rows: list.length },
      ip: req.ip,
    });
    sendCsv(res, `settlement-reconcile-${result.start}_${result.end}.csv`, RECONCILE_HEADERS, list.map(reconcileCsvRow));
  }),
);

/** 按平台单号取该单全部结算流水 + 合计（订单详情 / 对账下钻；没有流水也返回空集，便于财务判断「未结算」） */
financeRouter.get(
  '/settlement/by-order/:tk_order_id',
  requireMenu('finance'),
  wrap((req, res) => {
    const no = String(req.params.tk_order_id ?? '').trim();
    if (!no) throw badRequest('平台单号不能为空');
    const scope = shopFilter(req, 't.shop_id');
    const q = new Q('t.is_deleted = 0').and(scope.sql || '', ...scope.params).and('t.tk_order_id = ?', no);
    const list = all<Record<string, unknown>>(
      `SELECT ${SETTLE_SELECT} FROM ${SETTLE_FROM}${q.whereSql} ORDER BY ${SETTLE_ORDER}`,
      ...q.params,
    );
    const order = get<Record<string, unknown>>(
      `SELECT o.id, o.tk_order_id, o.order_status, o.total_paid, o.currency, o.order_time, o.is_sample_order, o.shop_id, s.shop_name
         FROM tk_order o LEFT JOIN tk_shop s ON s.id = o.shop_id
        WHERE o.is_deleted = 0 AND o.tk_order_id = ? ORDER BY o.id ASC LIMIT 1`,
      no,
    );
    ok(res, { tk_order_id: no, list, total: list.length, summary: settlementSummary(q), order: order ?? null });
  }),
);

/** 单条结算流水详情（对账时从差异行点回原始流水） */
financeRouter.get(
  '/settlement/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) throw badRequest('结算流水 ID 不合法');
    const row = get<Record<string, unknown>>(
      `SELECT ${SETTLE_SELECT} FROM ${SETTLE_FROM} WHERE t.is_deleted = 0 AND t.id = ?`,
      id,
    );
    if (!row) throw notFound('结算流水不存在');
    const scope = shopScope(current(req), 'id');
    if (scope.sql && !get<{ id: number }>(`SELECT id FROM tk_shop WHERE id = ? ${scope.sql}`, Number(row.shop_id), ...scope.params)) {
      throw notFound('结算流水不存在');
    }
    ok(res, row);
  }),
);

/* ==================== 退款（表 8）：财务视角的实收冲减 ==================== */
financeRouter.get(
  '/return',
  requireMenu('finance'),
  wrap((req, res) => {
    const scope = shopFilter(req, 't.shop_id');
    const q = new Q('t.is_deleted = 0')
      .and(scope.sql || '', ...scope.params)
      .eq('t.status', qv(req, 'status'), false)
      .eq('t.responsibility', qv(req, 'responsibility'))
      .eq('t.tk_order_id', qv(req, 'tk_order_id'), false)
      .between('t.apply_time', qv(req, 'from'), qv(req, 'to'));
    const page = queryPage(req, {
      from: `tk_return t
             LEFT JOIN tk_shop s ON s.id = t.shop_id
             LEFT JOIN tk_order o ON o.id = t.order_id AND o.is_deleted = 0`,
      select: `t.*, s.shop_name, o.tk_order_id AS order_no, o.order_status, ROUND(${RETURN_CNY}, 2) AS refund_amount_cny`,
      q,
      orderBy: 't.apply_time DESC, t.id DESC',
    });
    const agg = get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS c, IFNULL(ROUND(SUM(${RETURN_CNY}), 2), 0) AS amount_cny,
              IFNULL(ROUND(SUM(CASE WHEN t.status = 'COMPLETED' THEN ${RETURN_CNY} ELSE 0 END), 2), 0) AS completed_cny,
              IFNULL(ROUND(SUM(CASE WHEN t.status = 'PROCESSING' THEN ${RETURN_CNY} ELSE 0 END), 2), 0) AS processing_cny
         FROM tk_return t${q.whereSql}`,
      ...q.params,
    );
    ok(res, {
      ...page,
      summary: {
        rows: Number(agg?.c ?? 0),
        amount_cny: Number(agg?.amount_cny ?? 0),
        completed_cny: Number(agg?.completed_cny ?? 0),
        processing_cny: Number(agg?.processing_cny ?? 0),
      },
    });
  }),
);

/* ==================== 表 17 费用 expense ==================== */

const expenseBody = z.object({
  expense_date: z.string().min(10).max(20),
  expense_type: z.number().int().min(1).max(6),
  shop_id: z.number().int().positive().nullish(),
  ref_type: z.string().max(32).nullish(),
  ref_id: z.number().int().nullish(),
  amount: z.number().min(0),
  currency: z.string().length(3),
  payee: z.string().max(100).nullish(),
  // PRD §3.8 表单：voucher ≤ 500
  voucher: z.string().max(500).nullish(),
  status: z.union([z.literal(1), z.literal(2)]),
  remark: z.string().max(500).nullish(),
});

/** PRD §3.8 表单：status=2（已付款）必须有收款方，否则钱付给谁无从追溯 */
function requirePayeeForPaid(row: { status?: unknown; payee?: unknown }, label = '标记为已付款'): void {
  if (Number(row.status) === 2 && !String(row.payee ?? '').trim()) throw badRequest(`${label}必须填写收款方`);
}

/** 费用金额折人民币：登记日取价，返回写入值与取价过程（响应里带 rate_missing） */
function expenseCny(input: { amount: number; currency: string; expense_date: string }): {
  amount_cny: number;
  rate: number;
  rate_source_date: string;
  rate_missing: boolean;
} {
  const day = rateDay(input.expense_date) || rateDay(new Date().toISOString());
  const info = getRate(input.currency, day);
  return { amount_cny: round2(input.amount * info.rate), rate: info.rate, rate_source_date: info.source_date, rate_missing: info.missing };
}

function expenseQuery(req: Request): Q {
  const scope = shopScope(current(req), 't.shop_id');
  return new Q('t.is_deleted = 0')
    .and(scope.sql || '', ...scope.params)
    .eq('t.expense_type', qv(req, 'expense_type'))
    .eq('t.status', qv(req, 'status'))
    .eq('t.ref_type', qv(req, 'ref_type'), false)
    .eq('t.ref_id', qv(req, 'ref_id'))
    .eq('t.shop_id', qv(req, 'shop_id'))
    .between('t.expense_date', qv(req, 'from'), qv(req, 'to'))
    .like(`t.payee LIKE ? OR t.remark LIKE ? OR t.voucher LIKE ?`, qv(req, 'keyword'));
}

const EXPENSE_FROM = `expense t
       LEFT JOIN tk_shop s ON s.id = t.shop_id
       LEFT JOIN collaboration cb ON t.ref_type = 'collaboration' AND cb.id = t.ref_id
       LEFT JOIN creator c ON c.id = cb.creator_id
       LEFT JOIN product_spu sp ON sp.id = cb.spu_id`;
const EXPENSE_SELECT = `t.*, s.shop_name, cb.collab_no, c.handle AS creator_handle, sp.name_cn AS spu_name`;

financeRouter.get(
  '/expense',
  requireMenu('finance'),
  wrap((req, res) => ok(res, queryPage(req, { from: EXPENSE_FROM, select: EXPENSE_SELECT, q: expenseQuery(req), orderBy: 't.expense_date DESC, t.id DESC' }))),
);

/** 费用汇总：按类型 / 月份 / 店铺，含已付未付（表 17 的公共费用按 GMV 分摊在利润报表里，这里只看原始台账） */
financeRouter.get(
  '/expense/summary',
  requireMenu('finance'),
  wrap((req, res) => {
    const q = expenseQuery(req);
    const groupBy = ['type', 'month', 'shop'].includes(qv(req, 'group_by') ?? '') ? (qv(req, 'group_by') as string) : 'type';
    const expr =
      groupBy === 'month'
        ? `substr(t.expense_date, 1, 7)`
        : groupBy === 'shop'
          ? `IFNULL(s.shop_name, '公共费用（未归店铺）')`
          : `t.expense_type`;
    const rows = all<Record<string, number | string | null>>(
      `SELECT ${expr} AS k, COUNT(*) AS cnt, ROUND(SUM(t.amount), 2) AS amount_src,
              ROUND(SUM(IFNULL(NULLIF(t.amount_cny, 0), t.amount)), 2) AS amount_cny,
              ROUND(SUM(CASE WHEN t.status = 2 THEN IFNULL(NULLIF(t.amount_cny, 0), t.amount) ELSE 0 END), 2) AS paid_cny,
              ROUND(SUM(CASE WHEN t.status = 1 THEN IFNULL(NULLIF(t.amount_cny, 0), t.amount) ELSE 0 END), 2) AS unpaid_cny
         FROM ${EXPENSE_FROM}${q.whereSql}
        GROUP BY k ORDER BY amount_cny DESC`,
      ...q.params,
    );
    const total = get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS cnt, ROUND(SUM(t.amount), 2) AS amount_src,
              ROUND(SUM(IFNULL(NULLIF(t.amount_cny, 0), t.amount)), 2) AS amount_cny,
              ROUND(SUM(CASE WHEN t.status = 2 THEN IFNULL(NULLIF(t.amount_cny, 0), t.amount) ELSE 0 END), 2) AS paid_cny,
              ROUND(SUM(CASE WHEN t.status = 1 THEN IFNULL(NULLIF(t.amount_cny, 0), t.amount) ELSE 0 END), 2) AS unpaid_cny,
              ROUND(SUM(CASE WHEN t.shop_id IS NULL THEN IFNULL(NULLIF(t.amount_cny, 0), t.amount) ELSE 0 END), 2) AS public_cny
         FROM ${EXPENSE_FROM}${q.whereSql}`,
      ...q.params,
    );
    ok(res, {
      group_by: groupBy,
      list: rows.map((r) => ({
        key: String(r.k),
        name: groupBy === 'type' ? (EXPENSE_TYPE_LABEL[Number(r.k)] ?? `类型${String(r.k)}`) : String(r.k),
        count: Number(r.cnt),
        amount_src: Number(r.amount_src),
        amount_cny: Number(r.amount_cny),
        paid_cny: Number(r.paid_cny),
        unpaid_cny: Number(r.unpaid_cny),
      })),
      total: {
        count: Number(total?.cnt ?? 0),
        amount_src: Number(total?.amount_src ?? 0),
        amount_cny: Number(total?.amount_cny ?? 0),
        paid_cny: Number(total?.paid_cny ?? 0),
        unpaid_cny: Number(total?.unpaid_cny ?? 0),
        public_cny: Number(total?.public_cny ?? 0),
      },
    });
  }),
);

const expenseCreateBody = expenseBody.partial({ expense_type: true, currency: true, status: true });

financeRouter.post(
  '/expense',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const input = parseBody(expenseCreateBody, req.body);
    const body: z.infer<typeof expenseBody> = {
      ...input,
      expense_type: input.expense_type ?? 1,
      currency: input.currency ?? 'CNY',
      status: input.status ?? 1,
    };
    requirePayeeForPaid(body, '登记为已付款');
    const fx = expenseCny(body);
    const id = insert('expense', { ...body, shop_id: body.shop_id ?? null, amount_cny: fx.amount_cny, created_by: user.id } as never);
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'create', target_table: 'expense', target_id: id, after: { ...body, ...fx }, ip: req.ip });
    ok(res, { id, ...fx }, fx.rate_missing ? '已登记：该币种当日无汇率，已用兜底牌价，请核对' : 'ok');
  }),
);

/** 费用行可见性：公共费用（shop_id 为空）只对全数据范围角色开放 */
function inExpenseScope(user: CurrentUser, shopId: number | null | undefined): boolean {
  const scope = shopScope(user, 'id');
  if (!scope.sql) return true;
  if (!shopId) return false;
  return !!get<{ id: number }>(`SELECT id FROM tk_shop WHERE id = ? ${scope.sql}`, shopId, ...scope.params);
}

financeRouter.put(
  '/expense/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM expense WHERE id = ? AND is_deleted = 0`, id);
    if (!before || !inExpenseScope(user, Number(before.shop_id ?? 0) || null)) throw notFound('费用记录不存在');
    const body = parseBody(expenseBody.partial(), req.body);
    const merged = { ...before, ...body } as z.infer<typeof expenseBody>;
    requirePayeeForPaid(merged, '标记为已付款');
    const fx = expenseCny(merged);
    update('expense', id, { ...(body as Record<string, never>), amount_cny: fx.amount_cny } as never);
    // PRD §3.8：改 amount / amount_cny / shop_id 必须留痕（钱和归属店铺是费用的两条命门）
    logIfChanged({
      user_id: user.id,
      module: '财务中心',
      action: 'update',
      target_table: 'expense',
      target_id: id,
      before: before as Record<string, unknown>,
      after: { ...(merged as unknown as Record<string, unknown>), amount_cny: fx.amount_cny },
      keys: ['amount', 'amount_cny', 'shop_id', 'status', 'expense_date', 'expense_type', 'payee'],
      ip: req.ip,
    });
    ok(res, { id, ...fx }, fx.rate_missing ? '已更新：该币种当日无汇率，已用兜底牌价，请核对' : 'ok');
  }),
);

financeRouter.delete(
  '/expense/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    const row = get<{ shop_id: number | null }>(`SELECT shop_id FROM expense WHERE id = ? AND is_deleted = 0`, id);
    if (!row || !inExpenseScope(current(req), row.shop_id)) throw notFound('费用记录不存在');
    softDelete('expense', id);
    writeOpLog({ user_id: current(req).id, module: '财务中心', action: 'delete', target_table: 'expense', target_id: id, ip: req.ip });
    ok(res, { id });
  }),
);

/** 标记已付款（1 待付款 → 2 已付款）；只有已登记的单据能改状态，金额不动 */
financeRouter.post(
  '/expense/:id/pay',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM expense WHERE id = ? AND is_deleted = 0`, id);
    if (!row || !inExpenseScope(user, Number(row.shop_id ?? 0) || null)) throw notFound('费用记录不存在');
    if (Number(row.status) === 2) throw badRequest('该费用已标记付款');
    const body = parseBody(z.object({ payee: z.string().max(100).nullish(), voucher: z.string().max(500).nullish() }).partial(), req.body ?? {});
    const patch: Record<string, SqlParam> = { status: 2 };
    if (body?.payee) patch.payee = body.payee;
    if (body?.voucher) patch.voucher = body.voucher;
    if (!String(patch.payee ?? row.payee ?? '').trim()) throw badRequest('标记为已付款必须填写收款方');
    update('expense', id, patch);
    logIfChanged({
      user_id: user.id,
      module: '财务中心',
      action: 'update',
      target_table: 'expense',
      target_id: id,
      before: { status: row.status, payee: row.payee, voucher: row.voucher },
      after: { ...row, ...patch },
      keys: ['status', 'payee', 'voucher'],
      ip: req.ip,
    });
    ok(res, { id, status: 2 });
  }),
);

/**
 * 从合作单批量生成坑位费（PRD §3.8 费用登记 / 方案 6.1：达人固定费要走财务台账）。
 * 幂等键 ref_type='collaboration' + ref_id + expense_type=1：同一合作单重复点只更新金额，不重复入账。
 * 只有 coop_type ∈ (2 坑位费+佣金, 3 付费视频, 4 直播专场) 且 fixed_fee > 0 且未取消的单才生成。
 */
financeRouter.post(
  '/expense/from-collab',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(
      z.object({
        collab_ids: z.array(z.number().int().positive()).max(500).optional(),
        expense_date: z.string().min(10).max(20).optional(),
        status: z.union([z.literal(1), z.literal(2)]).optional(),
      }),
      req.body ?? {},
    );
    const scope = shopScope(user, 'c.shop_id');
    const ids = (body.collab_ids ?? []).filter((n) => Number.isFinite(n) && n > 0);
    const collabs = all<Record<string, unknown>>(
      `SELECT c.id, c.collab_no, c.shop_id, c.coop_type, c.fixed_fee, c.fee_currency, c.status,
              substr(c.created_at, 1, 10) AS created_date, cr.handle AS payee
         FROM collaboration c
         LEFT JOIN creator cr ON cr.id = c.creator_id
        WHERE c.is_deleted = 0 AND c.fixed_fee > 0 AND c.coop_type IN (2, 3, 4) AND c.status <> 8 ${scope.sql}
          ${ids.length ? `AND c.id IN (${ids.map(() => '?').join(',')})` : ''}
        ORDER BY c.id ASC`,
      ...(ids.length ? [...scope.params, ...ids] : scope.params),
    );
    if (!collabs.length) throw badRequest('没有可生成的合作单：只有含固定费用（坑位费/付费视频/直播专场）且未取消的单能入账');
    const payStatus = body.status ?? 1;
    const out = { total: collabs.length, inserted: 0, updated: 0, skipped: 0, invalid: [] as { collab_id: number; reason: string }[] };
    tx(() => {
      for (const cb of collabs) {
        const collabId = Number(cb.id);
        const day = rateDay(body.expense_date ?? '') || String(cb.created_date ?? '') || rateDay(new Date().toISOString());
        const currency = String(cb.fee_currency ?? 'USD');
        const amount = Number(cb.fixed_fee ?? 0);
        const payee = String(cb.payee ?? '').trim();
        if (payStatus === 2 && !payee) {
          out.invalid.push({ collab_id: collabId, reason: '标记已付款需要收款方，该合作单没有达人账号可用作收款方' });
          continue;
        }
        const fx = expenseCny({ amount, currency, expense_date: day });
        const exist = get<{ id: number }>(
          `SELECT id FROM expense WHERE is_deleted = 0 AND ref_type = 'collaboration' AND ref_id = ? AND expense_type = 1`,
          collabId,
        );
        const fields: Record<string, SqlParam> = {
          expense_date: day,
          expense_type: 1,
          shop_id: Number(cb.shop_id),
          ref_type: 'collaboration',
          ref_id: collabId,
          amount,
          currency,
          amount_cny: fx.amount_cny,
          payee: payee || null,
          status: payStatus,
          remark: `由合作单 ${String(cb.collab_no ?? collabId)} 自动生成`,
        };
        if (exist) {
          const prev = get<Record<string, unknown>>(`SELECT * FROM expense WHERE id = ?`, exist.id);
          update('expense', exist.id, fields);
          logIfChanged({
            user_id: user.id,
            module: '财务中心',
            action: 'update',
            target_table: 'expense',
            target_id: exist.id,
            before: prev ?? {},
            after: { ...prev, ...fields },
            keys: ['amount', 'amount_cny', 'shop_id'],
            ip: req.ip,
          });
          out.updated += 1;
          continue;
        }
        insert('expense', { ...fields, created_by: user.id } as never);
        out.inserted += 1;
      }
    });
    writeOpLog({
      user_id: user.id,
      module: '财务中心',
      action: 'create',
      target_table: 'expense',
      after: { kind: 'from_collab', total: out.total, inserted: out.inserted, updated: out.updated },
      ip: req.ip,
    });
    ok(res, out, `生成完成：新增 ${out.inserted}，更新 ${out.updated}，无效 ${out.invalid.length}`);
  }),
);

/* ==================== 表 18 汇率 exchange_rate ==================== */

/** 汇率列表条件：ResourcePage 的 daterange 会发 rate_date_from / rate_date_to，from / to 作为别名一并接受 */
function rateFilter(req: Request): Q {
  const from = rateDay(qv(req, 'rate_date_from') ?? qv(req, 'from') ?? '');
  const to = rateDay(qv(req, 'rate_date_to') ?? qv(req, 'to') ?? '');
  return new Q('t.is_deleted = 0')
    .eq('t.currency', qv(req, 'currency'), false)
    .eq('t.source', qv(req, 'source'))
    .between('t.rate_date', from, to)
    .like(`t.currency LIKE ?`, qv(req, 'keyword'));
}

const RATE_SELECT = `t.id, t.rate_date, t.currency, t.rate_to_cny, t.source, t.updated_at,
       CASE WHEN t.source = 1 THEN '自动' ELSE '手工' END AS source_name`;

financeRouter.get(
  '/rate',
  requireMenu('finance'),
  wrap((req, res) => {
    const page = queryPage(req, { from: 'exchange_rate t', select: RATE_SELECT, q: rateFilter(req), orderBy: 't.rate_date DESC, t.currency ASC' });
    ok(res, { ...page, currencies: listCurrencies() });
  }),
);

/** 按条件取全量（不分页）：报表折算自检与前端画折线用 */
financeRouter.get(
  '/rate/list',
  requireMenu('finance'),
  wrap((req, res) => {
    const list = listRates({
      from: qv(req, 'rate_date_from') ?? qv(req, 'from') ?? undefined,
      to: qv(req, 'rate_date_to') ?? qv(req, 'to') ?? undefined,
      currency: qv(req, 'currency'),
      source: Number(qv(req, 'source') ?? 0) || undefined,
    });
    ok(res, { list, total: list.length, currencies: listCurrencies() });
  }),
);

/** 各币种最新牌价（前端「今天按多少折算」+ 缺价提示） */
financeRouter.get(
  '/rate/latest',
  requireMenu('finance'),
  wrap((_req, res) => {
    const list = latestRates();
    const missing = list.filter((r) => r.days_ago > 1).map((r) => r.currency);
    ok(res, { list, missing_days: missing, currencies: listCurrencies() });
  }),
);

financeRouter.post(
  '/rate',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(
      z.object({
        rate_date: z.string().min(10).max(20),
        currency: z.string().min(2).max(8),
        rate_to_cny: z.number().positive(),
        source: z.union([z.literal(1), z.literal(2)]).default(2),
      }),
      req.body,
    );
    const r = upsertRate({ ...body, user_id: user.id });
    writeOpLog({ user_id: user.id, module: '财务中心', action: r.created ? 'create' : 'update', target_table: 'exchange_rate', target_id: r.id, after: body, ip: req.ip });
    ok(res, r, r.created ? 'ok' : '该日该币种已有牌价，已覆盖更新');
  }),
);

/**
 * 编辑牌价（前端 ResourcePage 的编辑按钮走 PUT /finance/rate/:id）。
 * ux_rate(rate_date, currency) 仍要守住：改成别的日期/币种若已存在别的一条，按唯一键覆盖那条并停用本条，绝不留下两条同键。
 */
financeRouter.put(
  '/rate/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) throw badRequest('汇率 ID 不合法');
    const before = get<Record<string, unknown>>(`SELECT * FROM exchange_rate WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('汇率记录不存在');
    const body = parseBody(
      z
        .object({
          rate_date: z.string().min(10).max(20),
          currency: z.string().min(2).max(8),
          rate_to_cny: z.number().positive(),
          source: z.union([z.literal(1), z.literal(2)]),
        })
        .partial(),
      req.body,
    );
    const day = rateDay(body.rate_date ?? String(before.rate_date)) || String(before.rate_date);
    const currency = String(body.currency ?? before.currency ?? 'USD').toUpperCase();
    const rate = Number(body.rate_to_cny ?? before.rate_to_cny);
    if (!Number.isFinite(rate) || rate <= 0) throw badRequest('汇率必须是正数');
    const r = upsertRate({ rate_date: day, currency, rate_to_cny: rate, source: body.source ?? 2, user_id: user.id });
    if (r.id !== id) softDelete('exchange_rate', id);
    logIfChanged({
      user_id: user.id,
      module: '财务中心',
      action: 'update',
      target_table: 'exchange_rate',
      target_id: r.id,
      before: before as Record<string, unknown>,
      after: { ...before, rate_date: day, currency, rate_to_cny: rate, source: body.source ?? before.source },
      keys: ['rate_date', 'currency', 'rate_to_cny', 'source'],
      ip: req.ip,
    });
    ok(res, { ...r, id: r.id });
  }),
);

financeRouter.delete(
  '/rate/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM exchange_rate WHERE id = ? AND is_deleted = 0`, id)) throw notFound('汇率记录不存在');
    softDelete('exchange_rate', id);
    writeOpLog({ user_id: current(req).id, module: '财务中心', action: 'delete', target_table: 'exchange_rate', target_id: id, ip: req.ip });
    ok(res, { id });
  }),
);

/**
 * 拉取牌价（本地模拟，不访问外网）：不传币种则刷新全部在用币种，source=1 自动。
 * 返回逐币种新旧值，前端据此提示「今日牌价已刷新」。
 */
financeRouter.post(
  '/rate/fetch',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(z.object({ date: z.string().min(10).max(20).optional(), currencies: z.array(z.string().length(3)).optional() }), req.body ?? {});
    const out = mockFetchRates({ date: body.date, currencies: body.currencies });
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'create', target_table: 'exchange_rate', after: out, ip: req.ip });
    ok(res, out, `已刷新 ${out.rows.length} 个币种 ${out.date} 牌价`);
  }),
);

/**
 * 缺日补齐：以各币种已有最新一条按日顺延补齐区间内缺失的牌价（手工补历史报表用）。
 * 前端 RateList.vue 是「补最近 7 天缺失」按钮、不带请求体 → 不传 from/to 时默认按今天往前 7 天。
 * 响应里 filled 是补上的条数（前端直接展示），明细放 detail。
 */
financeRouter.post(
  '/rate/fill-missing',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(
      z.object({
        from: z.string().min(10).max(20).optional(),
        to: z.string().min(10).max(20).optional(),
        days: z.coerce.number().int().min(1).max(366).optional(),
        currencies: z.array(z.string().length(3)).optional(),
      }),
      req.body ?? {},
    );
    const today = rateDay(new Date().toISOString());
    const days = body.days ?? 7;
    const to = rateDay(body.to ?? '') || today;
    const from = rateDay(body.from ?? '') || new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400_000).toISOString().slice(0, 10);
    if (from > to) throw badRequest('起始日期不能晚于结束日期');
    const currencies = (body.currencies?.length ? body.currencies : listCurrencies()).filter((c) => c !== 'CNY');
    const detail: { rate_date: string; currency: string; rate_to_cny: number }[] = [];
    tx(() => {
      for (const cur of currencies) {
        const known = get<{ rate_date: string; rate_to_cny: number | string }>(
          `SELECT rate_date, rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
          cur,
          to,
        );
        if (!known) continue;
        let rate = Number(known.rate_to_cny);
        const span = Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000));
        for (let i = 0; i <= span; i++) {
          const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
          const hit = get<{ rate_to_cny: number | string }>(
            `SELECT rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date = ?`,
            cur,
            day,
          );
          if (hit) {
            rate = Number(hit.rate_to_cny);
            continue;
          }
          insert('exchange_rate', { rate_date: day, currency: cur, rate_to_cny: rate, source: 1, created_by: user.id });
          detail.push({ rate_date: day, currency: cur, rate_to_cny: rate });
        }
      }
    });
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'create', target_table: 'exchange_rate', after: { filled: detail.length, range: [from, to] }, ip: req.ip });
    ok(res, { filled: detail.length, total: detail.length, range: { from, to }, detail }, `补齐 ${detail.length} 条牌价`);
  }),
);

/* ==================== 利润报表（表 19 / 方案 6.2 第 6 条） ==================== */

const reportDims = (req: Request): ProfitDim[] => {
  const raw = qv(req, 'dim') ?? 'shop';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = new Set<string>(REPORT_DIMS);
  for (const d of list) if (!allowed.has(d)) throw badRequest(`dim 只支持 ${[...REPORT_DIMS].join(' / ')}`);
  return (list.length ? list : ['shop']) as ProfitDim[];
};

/** region 无匹配店铺时的哨兵：正整数、落在 IN 里、永远匹配不到，等价于空结果 */
const NO_SHOP = 999999999;

/** 店铺范围：shop_id / shop_ids 与 region 取交集（PRD §3.8 利润报表筛 region） */
function reportShopIds(req: Request, user: CurrentUser): number[] {
  const picked = requestedShops(req);
  const region = qv(req, 'region');
  if (!region) return picked;
  const scoped = shopScope(user, 'id');
  const rows = all<{ id: number }>(
    `SELECT id FROM tk_shop WHERE is_deleted = 0 AND region = ? ${scoped.sql}`,
    ...([region, ...scoped.params] as SqlParam[]),
  );
  const ids = rows.map((r) => Number(r.id));
  if (!picked.length) return ids.length ? ids : [NO_SHOP];
  const hit = picked.filter((id) => ids.includes(id));
  return hit.length ? hit : [NO_SHOP];
}

function reportFilter(req: Request) {
  const user = current(req);
  // 期间：报表用 start/end，前端利润页用 from/to，两种都接受
  const start = rateDay(qv(req, 'start') ?? qv(req, 'from') ?? '') || undefined;
  const end = rateDay(qv(req, 'end') ?? qv(req, 'to') ?? '') || undefined;
  return {
    user,
    shopIds: reportShopIds(req, user),
    start,
    end,
    includeSample: qv(req, 'include_sample') === '1',
    onlySettled: qv(req, 'only_settled') === '1',
  };
}

const profitReportHandler = wrap((req: Request, res: Response) => {
  const f = reportFilter(req);
  const dims = reportDims(req);
  const reports = dims.map((dim) => computeProfitReport({ ...f, dim }));
  const main = reports[reports.length - 1];
  const sumCheck = round2(main.list.reduce((a, r) => a + r.profit, 0) - main.total.profit);
  ok(res, {
    dim: main.dim,
    start: main.start,
    end: main.end,
    anchored: main.anchored,
    list: main.list,
    total: main.total,
    warn: main.warn,
    rate_missing: main.rate_missing,
    /** Σ各维度行 − 合计行：只在四舍五入内（分摊守恒自检） */
    sum_check: sumCheck,
    multi: reports.length > 1 ? Object.fromEntries(reports.map((r) => [r.dim, { list: r.list, total: r.total }])) : undefined,
  });
});

financeRouter.get('/profit/report', requireMenu('finance'), requireCost, profitReportHandler);
/** 前端利润表页的简称路径，与 /profit/report 同一口径同一实现 */
financeRouter.get('/profit', requireMenu('finance'), requireCost, profitReportHandler);

/** 趋势：按报表自然日的 GMV / 利润 / 广告费 / 结算序列 */
financeRouter.get(
  '/profit/trend',
  requireMenu('finance'),
  requireCost,
  wrap((req, res) => {
    const f = reportFilter(req);
    const dimRaw = qv(req, 'dim') ?? 'day';
    if (!TREND_DIMS.includes(dimRaw as (typeof TREND_DIMS)[number])) throw badRequest(`dim 只支持 ${TREND_DIMS.join(' / ')}`);
    const rep = computeProfitReport({ ...f, dim: dimRaw as ProfitDim });
    const isDay = dimRaw === 'day';
    const metric = qv(req, 'metric') ?? (isDay ? 'profit' : 'gmv');
    const pick = (r: (typeof rep.list)[number]): number => {
      switch (metric) {
        case 'gmv':
          return r.gmv;
        case 'net_gmv':
          return r.net_gmv;
        case 'cost':
          return r.cost;
        case 'commission':
          return r.commission;
        case 'ad_spend':
          return r.ad_spend;
        case 'expense':
          return r.expense;
        case 'settled':
          return r.settled_amount;
        case 'orders':
          return r.orders;
        case 'profit_rate':
          return r.profit_rate;
        default:
          return r.profit;
      }
    };
    ok(res, {
      dim: dimRaw,
      metric,
      start: rep.start,
      end: rep.end,
      rows: rep.list.map((r) => ({ key: r.dim_key, name: r.dim_name, date: isDay ? r.dim_key : null, value: pick(r), gmv: r.gmv, profit: r.profit, orders: r.orders })),
      total: rep.total,
      warn: rep.warn,
    });
  }),
);

const PROFIT_HEADERS = [
  '维度',
  '名称',
  '币种',
  'GMV(CNY)',
  '退款(CNY)',
  '净GMV(CNY)',
  '成本(CNY)',
  '佣金(CNY)',
  '广告费(CNY)',
  '费用(CNY)',
  '结算实收(CNY)',
  '利润(CNY)',
  '利润率(%)',
  '是否含预估',
  '订单数',
  '未映射行数',
  '未映射金额(CNY)',
  '汇率缺失',
];

financeRouter.get(
  '/profit/export',
  requireMenu('finance'),
  requireCost,
  requireExport,
  wrap((req, res) => {
    const f = reportFilter(req);
    const rawDim = qv(req, 'dim') ?? 'shop';
    if (!(REPORT_DIMS as readonly string[]).includes(rawDim)) throw badRequest(`dim 只支持 ${REPORT_DIMS.join(' / ')}`);
    const dim = rawDim as (typeof REPORT_DIMS)[number];
    const rep = computeProfitReport({ ...f, dim });
    writeOpLog({
      user_id: current(req).id,
      module: '财务中心',
      action: 'export',
      target_table: 'tk_order_item',
      after: { kind: 'profit_report', dim, start: rep.start, end: rep.end, rows: rep.list.length },
      ip: req.ip,
    });
    const rows = [...rep.list, rep.total].map((r) => [
      r.dim_key,
      r.dim_name,
      r.currency,
      r.gmv,
      r.refund,
      r.net_gmv,
      r.cost,
      r.commission,
      r.ad_spend,
      r.expense,
      r.settled_amount,
      r.profit,
      r.profit_rate,
      r.is_estimated,
      r.orders,
      r.unmapped_items,
      r.unmapped_amount_cny,
      r.rate_missing ? 1 : 0,
    ]);
    sendCsv(res, `profit-${dim}-${rep.start}_${rep.end}.csv`, PROFIT_HEADERS, rows);
  }),
);

/** 单笔利润拆解（订单详情页 / 对账点进去看） */
financeRouter.get(
  '/profit/order/:id',
  requireMenu('finance'),
  requireCost,
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) throw badRequest('订单 ID 不合法');
    const user = current(req);
    const row = get<{ shop_id: number }>(`SELECT shop_id FROM tk_order WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('订单不存在');
    const scope = shopScope(user, 'id');
    if (scope.sql && !scope.params.includes(row.shop_id)) throw forbidden('该店铺不在你的数据范围内');
    ok(res, computeOrderProfit(id));
  }),
);

/* ==================== 汇率自检：报表区间内哪些天/币种走了兜底价 ==================== */

financeRouter.get(
  '/rate/health',
  requireMenu('finance'),
  wrap((req, res) => {
    const conv = createRateConverter();
    const shops = all<{ currency: string }>(`SELECT DISTINCT currency FROM tk_shop WHERE is_deleted = 0`);
    const day = rateDay(qv(req, 'date') ?? '') || rateDay(new Date().toISOString());
    const list = shops.map((s) => {
      const info = conv.rate(s.currency, day);
      return { currency: s.currency, date: day, ...info };
    });
    ok(res, { date: day, list, missing: list.filter((r) => r.missing).map((r) => r.currency) });
  }),
);
