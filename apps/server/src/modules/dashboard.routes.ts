/**
 * 工作台看板（PRD §3.1 + 方案 6.2）
 *
 * 三条硬规矩：
 *  1. 数字一律来自 services/profit.ts 的利润引擎（D11：订单汇总条 / 利润报表 / 工作台三处必须同源），
 *     本文件不写一行统计 SQL，只做「入参归一 + 权限 + 掩码 + 告警文案」。
 *  2. 钱敏感字段（应收返点 / 物流支出 / 预估毛利 / 毛利率 / 实际到账）无 can_see_cost 时按字段级掩码出 '***'，
 *     不是隐藏字段（TC-01）；同时保留 can_see_cost=false 让前端整块折叠。
 *     返点是**我们的收入**、也是和品牌签下来的商务条款，非成本权限一样不能露出金额。
 *  3. 样品单不计 GMV、未配返点率的行（rebate_matched=0）不计收入也不计佣金、按站点时区切日
 *     —— 全部由引擎保证，这里只透传区间并把口径写在文案里。
 */
import { Router, type Request } from 'express';
import type { CurrentUser, DashboardSummary } from '@tk/shared';
import { get } from '../core/db.js';
import { ok, qv, wrap } from '../core/http.js';
import { maskFields, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { maskError } from '../core/redact.js';
import { dashboardMetrics, todoCounts, todoDetails } from '../services/profit.js';
import { rateDay } from '../services/rates.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

export const dashboardRouter = Router();

/** 钱敏感字段：PRD §3.1 指标卡权限列标 can_see_cost 的那几张卡（est_cost 已随口径换成返点 + 物流两项） */
const COST_FIELDS = ['est_rebate', 'est_logistics', 'est_gross_profit', 'est_profit_rate', 'settled_amount'];

/** 达人榜行里属于「我们自己的钱」的列：无 can_see_cost 时一并掩掉（roi 已不再下发，留着防以后加回来时漏掩） */
const CREATOR_COST_FIELDS = ['cost', 'roi', 'rebate_cny', 'rebate', 'sample_shipping', 'fixed_fee_cny', 'commission_cny'];

/**
 * 达人榜行的掩码：COST_FIELDS 只处理顶层键，榜单这一层的钱藏在数组行里，得单独过一遍。
 * 这里刻意**不**再算 roi —— 达人投产比只有一个出处（/api/creators/roi/rank，按 PRD C9 的四项分母）。
 * 之前这里"行里有明细就用 collabRoi 再核一次、没有就透传引擎值"，结果透传出来的那个
 * 分母里混了广告与公共费用，和 ROI 页对不上，同一个达人在两页显示 0.02 与 1.90。
 */
function creatorRankView(rows: DashboardSummary['creator_rank'], canSeeCost: boolean): Record<string, unknown>[] {
  return (rows as Record<string, unknown>[]).map((r) => maskFields({ ...r }, CREATOR_COST_FIELDS, canSeeCost));
}

/** 区间归一：默认近 30 天（days 可给 1~365），也接受显式 start/end（from/to 作别名） */
function dashRange(req: Request): { start: string; end: string; days: number } {
  const days = Math.min(365, Math.max(1, Number(qv(req, 'days') ?? 30) || 30));
  const end = rateDay(qv(req, 'end') ?? qv(req, 'to') ?? '') || rateDay(new Date().toISOString());
  const start =
    rateDay(qv(req, 'start') ?? qv(req, 'from') ?? '') || new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { start, end: end < start ? start : end, days };
}

/** 可见店铺数：0 家时走 PRD §3.1 空态文案 */
function visibleShops(user: CurrentUser): number {
  const scope = shopScope(user, 'id');
  const row = get<{ c: number | string }>(`SELECT COUNT(*) AS c FROM tk_shop WHERE is_deleted = 0 AND status = 1 ${scope.sql}`, ...scope.params);
  return Number(row?.c ?? 0);
}

interface SyncAlarm {
  shop_name: string;
  task_type: string;
  error_msg: string;
  started_at: string;
}

/** 最近一条失败/部分失败的同步日志（告警横幅正文，PRD §3.1 告警态） */
function lastSyncError(user: CurrentUser): SyncAlarm | null {
  const scope = shopScope(user, 'sl.shop_id');
  const row = get<Record<string, string | number | null>>(
    `SELECT IFNULL(s.shop_name, '未知店铺') AS shop_name, sl.task_type, IFNULL(sl.error_msg, '') AS error_msg, sl.started_at
       FROM sync_log sl LEFT JOIN tk_shop s ON s.id = sl.shop_id
      WHERE sl.is_deleted = 0 AND sl.status IN (2, 3) ${scope.sql}
      ORDER BY sl.started_at DESC, sl.id DESC LIMIT 1`,
    ...scope.params,
  );
  if (!row) return null;
  return {
    shop_name: String(row.shop_name ?? ''),
    task_type: String(row.task_type ?? ''),
    error_msg: maskError(String(row.error_msg ?? '')),
    started_at: String(row.started_at ?? ''),
  };
}

/**
 * 看板汇总：严格覆盖 DashboardSummary 全字段（packages/shared/src/types.ts），
 * 另附 range / warn / rate_missing / alerts 等扩展键，前端按 DashboardSummary 读取即可。
 */
dashboardRouter.get(
  '/summary',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const range = dashRange(req);
    const payload = dashboardMetrics(user, { start: range.start, end: range.end });
    const shops = visibleShops(user);
    const alarm = payload.sync_failed > 0 ? lastSyncError(user) : null;
    const alerts: { key: string; level: 'error' | 'warning'; title: string; detail: string; link: string }[] = [];
    if (payload.sync_failed > 0) {
      alerts.push({
        key: 'sync_failed',
        level: 'error',
        title: `数据同步异常：最近 ${payload.sync_failed} 次同步任务失败或部分失败，看板数字可能不是最新`,
        detail: alarm ? `${alarm.shop_name} · ${alarm.task_type} · ${alarm.error_msg || '无错误详情'}` : '',
        link: '/system/synclog',
      });
    }
    if (payload.rate_missing) {
      alerts.push({
        key: 'rate_missing',
        level: 'warning',
        title: '报表区间内存在缺失汇率，已按兜底牌价折算',
        detail: '请到「财务中心 · 汇率维护」补齐后重看数字',
        link: '/finance/rate',
      });
    }
    if (payload.auth_expiring > 0) {
      alerts.push({
        key: 'auth_expiring',
        level: 'warning',
        title: `${payload.auth_expiring} 家店铺授权即将过期或已失效`,
        detail: '授权失效后订单/结算拉不到，数字会静默变旧',
        link: '/shops',
      });
    }
    ok(res, {
      ...maskFields({ ...payload } as unknown as Record<string, unknown>, COST_FIELDS, user.can_see_cost),
      /** 达人榜单独过一遍掩码：COST_FIELDS 只处理顶层键，榜单行的钱藏在数组里 */
      creator_rank: creatorRankView(payload.creator_rank, user.can_see_cost),
      /** 区间说明：anchored=1 表示区间内无单，已把窗口平移到最新一单所在日 */
      period: { ...range, anchored: payload.range.anchored, actual_start: payload.range.start, actual_end: payload.range.end },
      visible_shops: shops,
      empty_hint: shops === 0 ? '你还没有可见店铺，请联系管理员配置数据权限' : '',
      sync_error: alarm,
      alerts,
    });
  }),
);

/** 待办红点：只有计数，给顶栏角标用（比 /summary 轻，不动利润引擎） */
dashboardRouter.get(
  '/todos',
  requireMenu('dashboard'),
  wrap((req, res) => ok(res, todoCounts(current(req)))),
);

/** 待办明细：每类可点进去的清单（工作台抽屉用） */
dashboardRouter.get(
  '/todos/detail',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const limit = Math.min(100, Math.max(1, Number(qv(req, 'limit') ?? 20) || 20));
    ok(res, { counts: todoCounts(current(req)), groups: todoDetails(current(req), limit) });
  }),
);

/** 同一区间的 GMV / 订单趋势线（图表单独刷新时用，口径与 /summary 完全一致） */
dashboardRouter.get(
  '/trend',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const range = dashRange(req);
    const user = current(req);
    const payload = dashboardMetrics(user, { start: range.start, end: range.end });
    ok(res, {
      range: { ...range, ...payload.range },
      gmv_trend: payload.gmv_trend,
      shop_rank: payload.shop_rank,
      // 与 /summary 同一个 ROI 归一 + 掩码，两块图不能一个按返点算、一个按 GMV 算
      creator_rank: creatorRankView(payload.creator_rank, user.can_see_cost),
    });
  }),
);
