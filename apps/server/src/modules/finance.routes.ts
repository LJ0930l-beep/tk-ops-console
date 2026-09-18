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
import { badRequest, forbidden, notFound, ok, parseBody, parseQuery, paginate, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
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

/** 扣款构成（饼图）+ 到账 / 待打款：口径与列表完全同一份 WHERE */
function settlementSummary(q: Q): {
  rows: number;
  income_cny: number;
  deduction_cny: number;
  net_cny: number;
  paid_cny: number;
  pending_cny: number;
  statements: number;
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
  return {
    rows: Number(agg?.rows ?? 0),
    income_cny: Number(agg?.income_cny ?? 0),
    deduction_cny: Number(agg?.deduction_cny ?? 0),
    net_cny: Number(agg?.net_cny ?? 0),
    paid_cny: Number(agg?.paid_cny ?? 0),
    pending_cny: Number(agg?.pending_cny ?? 0),
    statements: Number(agg?.statements ?? 0),
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
    shopIds: requestedShops(req),
    start: rateDay(qv(req, 'start') ?? '') || undefined,
    end: rateDay(qv(req, 'end') ?? '') || undefined,
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

/** 逐单对账：预估 vs 结算，含差异拆解与残差；默认只列有结算流水的单 */
financeRouter.get(
  '/settlement/reconcile',
  requireMenu('finance'),
  requireCost,
  wrap((req, res) => {
    const result = reconcileByOrder(reconcileFilter(req));
    let list = result.list;
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
  }),
);

financeRouter.get(
  '/settlement/reconcile/export',
  requireMenu('finance'),
  requireCost,
  requireExport,
  wrap((req, res) => {
    const result = reconcileByOrder(reconcileFilter(req));
    writeOpLog({
      user_id: current(req).id,
      module: '财务中心',
      action: 'export',
      target_table: 'settlement_txn',
      after: { kind: 'settlement_reconcile', start: result.start, end: result.end, rows: result.list.length },
      ip: req.ip,
    });
    sendCsv(res, `settlement-reconcile-${result.start}_${result.end}.csv`, RECONCILE_HEADERS, result.list.map(reconcileCsvRow));
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
  voucher: z.string().max(200).nullish(),
  status: z.union([z.literal(1), z.literal(2)]),
  remark: z.string().max(500).nullish(),
});

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
    const fx = expenseCny(body);
    const id = insert('expense', { ...body, shop_id: body.shop_id ?? null, amount_cny: fx.amount_cny, created_by: user.id } as never);
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'create', target_table: 'expense', target_id: id, after: { ...body, ...fx }, ip: req.ip });
    ok(res, { id, ...fx }, fx.rate_missing ? '已登记：该币种当日无汇率，已用兜底牌价，请核对' : 'ok');
  }),
);

financeRouter.put(
  '/expense/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM expense WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('费用记录不存在');
    const body = parseBody(expenseBody.partial(), req.body);
    const merged = { ...before, ...body } as z.infer<typeof expenseBody>;
    const fx = expenseCny(merged);
    update('expense', id, { ...(body as Record<string, never>), amount_cny: fx.amount_cny } as never);
    writeOpLog({
      user_id: user.id,
      module: '财务中心',
      action: 'update',
      target_table: 'expense',
      target_id: id,
      before: { amount: before.amount, amount_cny: before.amount_cny, expense_date: before.expense_date, status: before.status },
      after: { ...body, amount_cny: fx.amount_cny },
      ip: req.ip,
    });
    ok(res, { id, ...fx });
  }),
);

financeRouter.delete(
  '/expense/:id',
  requireMenu('finance'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM expense WHERE id = ? AND is_deleted = 0`, id)) throw notFound('费用记录不存在');
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
    if (!row) throw notFound('费用记录不存在');
    if (Number(row.status) === 2) throw badRequest('该费用已标记付款');
    const body = parseBody(z.object({ payee: z.string().max(100).nullish(), voucher: z.string().max(200).nullish() }).partial(), req.body ?? {});
    const patch: Record<string, SqlParam> = { status: 2 };
    if (body?.payee) patch.payee = body.payee;
    if (body?.voucher) patch.voucher = body.voucher;
    update('expense', id, patch);
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'update', target_table: 'expense', target_id: id, before: { status: row.status }, after: { status: 2, ...body }, ip: req.ip });
    ok(res, { id, status: 2 });
  }),
);

/* ==================== 表 18 汇率 exchange_rate ==================== */

const rateQuery = (req: Request) =>
  parseQuery(
    z.object({ from: z.string().optional(), to: z.string().optional(), currency: z.string().optional(), source: z.coerce.number().int().optional() }),
    req.query,
  );

financeRouter.get(
  '/rate',
  requireMenu('finance'),
  wrap((req, res) => {
    const q = rateQuery(req);
    const list = listRates(q);
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

/** 缺日补齐：以各币种已有最新一条按日顺延补齐区间内缺失的牌价（手工补历史报表用） */
financeRouter.post(
  '/rate/fill-missing',
  requireMenu('finance'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(
      z.object({
        from: z.string().min(10).max(20),
        to: z.string().min(10).max(20),
        currencies: z.array(z.string().length(3)).optional(),
      }),
      req.body ?? {},
    );
    if (body.from > body.to) throw badRequest('起始日期不能晚于结束日期');
    const currencies = (body.currencies?.length ? body.currencies : listCurrencies()).filter((c) => c !== 'CNY');
    const filled: { rate_date: string; currency: string; rate_to_cny: number }[] = [];
    tx(() => {
      for (const cur of currencies) {
        const known = get<{ rate_date: string; rate_to_cny: number | string }>(
          `SELECT rate_date, rate_to_cny FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
          cur,
          body.to,
        );
        if (!known) continue;
        let rate = Number(known.rate_to_cny);
        const days = Math.max(0, Math.round((Date.parse(`${body.to}T00:00:00Z`) - Date.parse(`${body.from}T00:00:00Z`)) / 86400_000));
        for (let i = 0; i <= days; i++) {
          const day = new Date(Date.parse(`${body.from}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
          const hit = get<{ id: number }>(`SELECT id FROM exchange_rate WHERE is_deleted = 0 AND currency = ? AND rate_date = ?`, cur, day);
          if (hit) continue;
          insert('exchange_rate', { rate_date: day, currency: cur, rate_to_cny: rate, source: 1, created_by: user.id });
          filled.push({ rate_date: day, currency: cur, rate_to_cny: rate });
        }
      }
    });
    writeOpLog({ user_id: user.id, module: '财务中心', action: 'create', target_table: 'exchange_rate', after: { filled: filled.length, range: [body.from, body.to] }, ip: req.ip });
    ok(res, { filled, total: filled.length }, `补齐 ${filled.length} 条牌价`);
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

function reportFilter(req: Request) {
  const user = current(req);
  const start = rateDay(qv(req, 'start') ?? '') || undefined;
  const end = rateDay(qv(req, 'end') ?? '') || undefined;
  return { user, shopIds: requestedShops(req), start, end, includeSample: qv(req, 'include_sample') === '1' };
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
