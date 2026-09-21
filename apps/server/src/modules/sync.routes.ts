/**
 * 数据同步（方案 6.2 / 6.4 / 第七章：能走接口全走接口，接口覆盖不到用表格导入兜底）
 *
 * 本文件只做「入口 + 监控」：拉取在 services/tiktok/client.ts，落库/快照/日志在 jobs/syncJobs.ts，
 * 每次执行（含手动补跑与导入）都会留一条 sync_log。
 *
 * 权限：同步属系统能力（PRD 7.3 要求 requireMenu('system')），
 * 但日志与健康度仍按 shopScope 收敛，避免跨部门看到别人的店铺。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { DATA_SCOPE } from '@tk/shared';
import { config } from '../config.js';
import { all, get } from '../core/db.js';
import { badRequest, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
import {
  activeShopIds,
  importOrdersForShop,
  refreshDerivedAggregates,
  registerSyncJobs,
  runTask,
  runTaskForShopIds,
  type SyncResult,
  type SyncTaskInput,
} from '../jobs/syncJobs.js';

const MODULE = '数据同步';

/** 对外开放的任务类型（'affiliate' / 'product' 是 PRD 6.1 的叫法，入库归一到 affiliate_order / listing）
 *  导出给契约测试用：前端「立即重跑」下拉必须与这份清单逐字一致，多一项就是 400。 */
export const SYNC_TASK_TYPES = ['order', 'listing', 'returns', 'affiliate', 'product', 'affiliate_order', 'aggregate', 'all'] as const;
const TASK_TYPES = SYNC_TASK_TYPES;
const TASK_LABEL: Record<string, string> = {
  order: '订单同步',
  listing: '店铺商品同步',
  product: '平台商品同步',
  returns: '售后同步',
  affiliate: '联盟归因回填',
  affiliate_order: '联盟订单同步',
  aggregate: '派生汇总刷新',
  all: '一键全量补跑',
};

const scopeOf = (req: Request, col: string) => shopScope((req as AuthedRequest).user, col);
const applyScope = (q: Q, scope: { sql: string; params: number[] }): Q => q.and(scope.sql.replace(/^\s*AND\s+/i, ''), ...scope.params);

/** 范围内可见的店铺（同步只能对范围内的店下手） */
function scopedShopIds(req: Request): number[] {
  const scope = scopeOf(req, 's.id');
  return all<{ id: number }>(`SELECT s.id FROM tk_shop s WHERE s.is_deleted = 0 AND s.status = 1 ${scope.sql} ORDER BY s.id`, ...scope.params).map((r) => r.id);
}

/** 聚合刷新不依赖授权状态，但仍只可处理操作者可见的店铺。 */
function visibleShopIds(req: Request): number[] {
  const scope = scopeOf(req, 's.id');
  return all<{ id: number }>(`SELECT s.id FROM tk_shop s WHERE s.is_deleted = 0 ${scope.sql} ORDER BY s.id`, ...scope.params).map((r) => r.id);
}

function assertShopVisible(req: Request, shopId: number): void {
  const scope = scopeOf(req, 's.id');
  const hit = get<{ id: number }>(`SELECT s.id FROM tk_shop s WHERE s.id = ? AND s.is_deleted = 0 ${scope.sql}`, shopId, ...scope.params);
  if (!hit) throw notFound('店铺不存在或不在你的数据范围内');
}

/* ==================== 入参 ==================== */

const runBody = z
  .object({
    task_type: z.enum(TASK_TYPES),
    shop_id: z.number().int().positive().optional(),
    window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/, 'window_start 需用 UTC 格式 YYYY-MM-DD HH:MM:SS').optional(),
    window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/, 'window_end 需用 UTC 格式 YYYY-MM-DD HH:MM:SS').optional(),
  })
  .strict();

const itemRow = z
  .object({
    sku_id: z.union([z.string().min(1), z.number()]).optional(),
    seller_sku: z.string().max(100).optional(),
    quantity: z.number().int().min(1).default(1),
    price: z.number().min(0),
    seller_discount: z.number().min(0).optional(),
  })
  .passthrough();

const orderRow = z
  .object({
    order_id: z.union([z.string().min(1), z.number()]),
    status: z.string().min(1).max(60),
    order_time: z.union([z.string().min(1), z.number()]).optional(),
    create_time: z.union([z.string().min(1), z.number()]).optional(),
    paid_time: z.union([z.string().min(1), z.number()]).optional(),
    ship_time: z.union([z.string().min(1), z.number()]).optional(),
    currency: z.string().length(3).optional(),
    subtotal: z.number().min(0).optional(),
    total_amount: z.number().min(0).optional(),
    total_paid: z.number().min(0).optional(),
    shipping_fee: z.number().min(0).optional(),
    seller_discount: z.number().min(0).optional(),
    platform_discount: z.number().min(0).optional(),
    fulfillment_type: z.union([z.number().int(), z.string().max(40)]).optional(),
    buyer_region: z.string().max(8).optional(),
    carrier: z.string().max(64).optional(),
    tracking_no: z.string().max(64).optional(),
    is_sample_order: z.union([z.number().int().min(0).max(1), z.boolean()]).optional(),
    items: z.array(itemRow).min(1, '至少要有一行明细'),
  })
  .passthrough();

const importBody = z
  .object({
    shop_id: z.number().int().positive(),
    rows: z.array(z.unknown()).min(1, 'rows 不能为空').max(2000, '单次导入不要超过 2000 行'),
  })
  .strict();

/* ==================== 路由 ==================== */

export const syncRouter = Router();
syncRouter.use(requireMenu('system'));

/** 可用任务与当前调度表达式（用纯函数 registerSyncJobs 取表，不产生任何定时任务） */
syncRouter.get(
  '/tasks',
  wrap((_req, res) => {
    const schedule = registerSyncJobs({ schedule: () => undefined });
    ok(res, {
      mode: config.tiktokMode,
      base_url: config.tiktokBaseUrl,
      overlap_minutes: config.syncOverlapMinutes,
      tasks: schedule.map((j) => ({ key: j.name, label: TASK_LABEL[j.name] ?? j.name, cron: j.expr })),
      manual_only: ['aggregate'],
      tip: '调度注册需在 jobs/scheduler.ts 内调用 registerSyncJobs(cron)，本接口只回读表达式',
    });
  }),
);

/**
 * 手动补跑 / 立即同步。
 * 不给 shop_id = 对范围内全部「运营中 + 已授权」店铺执行；给了只对这家店执行。
 */
syncRouter.post(
  '/run',
  wrap(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = parseBody(runBody, req.body);
    const opts = { windowStart: body.window_start, windowEnd: body.window_end, user_id: user.id };
    let results: SyncResult[];
    let targets: number[];
    if (body.shop_id) {
      assertShopVisible(req, body.shop_id);
      targets = [body.shop_id];
      if (body.task_type === 'aggregate') {
        results = [refreshDerivedAggregates(opts, [body.shop_id])];
      } else {
        if (!activeShopIds().includes(body.shop_id)) throw badRequest('该店铺未处于「运营中 + 已授权」状态，请先在店铺管理完成授权');
        results = await runTask(body.task_type as SyncTaskInput, body.shop_id, opts);
      }
    } else if (body.task_type === 'aggregate') {
      if (user.data_scope === DATA_SCOPE.ALL) {
        targets = [];
        results = [refreshDerivedAggregates(opts)];
      } else {
        targets = visibleShopIds(req);
        if (!targets.length) throw badRequest('范围内没有可刷新的店铺');
        results = await runTaskForShopIds(targets, 'aggregate', opts);
      }
    } else {
      targets = scopedShopIds(req).filter((id) => activeShopIds().includes(id));
      if (!targets.length) throw badRequest('范围内没有可同步的店铺（需运营中且已授权）');
      results = await runTaskForShopIds(targets, body.task_type as SyncTaskInput, opts);
    }
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'create',
      target_table: 'sync_log',
      after: {
        task_type: body.task_type,
        shop_ids: targets,
        window_start: body.window_start ?? null,
        window_end: body.window_end ?? null,
        mode: config.tiktokMode,
        logs: results.map((r) => r.log_id),
      },
      ip: req.ip,
    });
    ok(
      res,
      {
        task_type: body.task_type,
        shop_ids: targets,
        runs: results,
        summary: {
          fetched: results.reduce((s, r) => s + r.fetched, 0),
          inserted: results.reduce((s, r) => s + r.inserted, 0),
          updated: results.reduce((s, r) => s + r.updated, 0),
          failed: results.reduce((s, r) => s + r.failed, 0),
          status: results.some((r) => r.status === 3) ? 3 : results.some((r) => r.status === 2) ? 2 : 1,
        },
      },
      results.some((r) => r.status === 3) ? '部分同步失败，请看 error_msg' : 'ok',
    );
  }),
);

/** 同步日志（等价 /api/system/synclog，前端监控页与本页共用） */
syncRouter.get(
  '/logs',
  wrap((req, res) => {
    const q = applyScope(new Q('l.is_deleted = 0'), scopeOf(req, 'l.shop_id'));
    q.eq('l.task_type', qv(req, 'task_type'), false)
      .eq('l.shop_id', qv(req, 'shop_id'))
      .eq('l.status', qv(req, 'status'))
      .like('l.error_msg LIKE ?', qv(req, 'keyword'));
    const days = qv(req, 'days');
    if (days) q.and(`l.started_at >= datetime('now', ?)`, `-${Math.max(1, Number(days) || 7)} days`);
    if (qv(req, 'only_failed') === '1') q.and('l.status <> 1');
    const page = queryPage(req, {
      from: `sync_log l LEFT JOIN tk_shop s ON s.id = l.shop_id LEFT JOIN sys_user u ON u.id = l.created_by`,
      select: `l.*, s.shop_name, s.region, u.real_name AS operator_name,
               CAST((julianday(l.finished_at) - julianday(l.started_at)) * 86400 AS INTEGER) AS duration_seconds`,
      q,
      orderBy: 'l.id DESC',
    });
    const STATUS_LABEL: Record<number, string> = { 1: '成功', 2: '部分失败', 3: '失败' };
    ok(res, {
      ...page,
      list: page.list.map((row) => ({ ...row, status_label: STATUS_LABEL[Number(row.status)] ?? String(row.status ?? '') })),
    });
  }),
);

/**
 * 同步健康度：每店每任务最近一次状态 + 未同步提醒。
 * 工作台红点与本页共用，故只要登录可见（但仍在 system 菜单下）。
 */
syncRouter.get(
  '/health',
  wrap((req, res) => {
    const scope = scopeOf(req, 's.id');
    const rows = all<Record<string, unknown>>(
      `SELECT s.id AS shop_id, s.shop_name, s.region, s.currency, s.auth_status, s.token_expire_at,
              tk.task_type AS task_type,
              l.id AS log_id, l.window_start, l.window_end, l.fetched, l.inserted, l.updated, l.failed,
              l.status, l.error_msg, l.started_at, l.finished_at
         FROM tk_shop s
         CROSS JOIN (SELECT 'order' AS task_type UNION ALL SELECT 'listing' UNION ALL SELECT 'returns' UNION ALL SELECT 'affiliate_order') tk
         LEFT JOIN sync_log l ON l.shop_id = s.id AND l.task_type = tk.task_type AND l.is_deleted = 0
           AND l.id = (SELECT MAX(l2.id) FROM sync_log l2 WHERE l2.shop_id = s.id AND l2.task_type = tk.task_type AND l2.is_deleted = 0)
        WHERE s.is_deleted = 0 ${scope.sql}
        ORDER BY s.id ASC, tk.task_type ASC`,
      ...scope.params,
    );
    const STATUS_LABEL: Record<number, string> = { 1: '成功', 2: '部分失败', 3: '失败', 0: '从未同步' };
    const items: Record<string, unknown>[] = rows.map((r) => {
      const status = r.status === null || r.status === undefined ? 0 : Number(r.status);
      const ageHours =
        r.started_at === null || r.started_at === undefined
          ? null
          : Math.max(0, Math.round(((Date.now() - Date.parse(`${String(r.started_at).replace(' ', 'T')}Z`)) / 3_600_000) * 10) / 10);
      return {
        ...r,
        task_label: TASK_LABEL[String(r.task_type)] ?? String(r.task_type),
        status,
        status_label: STATUS_LABEL[status] ?? String(status),
        age_hours: ageHours,
        stale: status !== 1 || ageHours === null || ageHours > 24,
      };
    });
    const unmappedListings = Number(
      get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM shop_listing l WHERE l.is_deleted = 0 AND l.map_status = 2 ${scope.sql.replace(/s\.id/g, 'l.shop_id')}`,
        ...scope.params,
      )?.c ?? 0,
    );
    const unmappedItems = Number(
      get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
          WHERE i.is_deleted = 0 AND i.cost_matched = 0 ${scope.sql.replace(/s\.id/g, 'o.shop_id')}`,
        ...scope.params,
      )?.c ?? 0,
    );
    const byShop: Record<string, { shop_id: number; shop_name: unknown; tasks: Record<string, unknown>[] }> = {};
    for (const r of items) {
      const key = String(r.shop_id);
      byShop[key] = byShop[key] ?? { shop_id: Number(key), shop_name: r.shop_name, tasks: [] };
      byShop[key].tasks.push(r);
    }
    ok(res, {
      mode: config.tiktokMode,
      overlap_minutes: config.syncOverlapMinutes,
      schedule: registerSyncJobs({ schedule: () => undefined }),
      items,
      by_shop: Object.values(byShop),
      counters: {
        total: items.length,
        never: items.filter((r) => Number(r.status) === 0).length,
        failed: items.filter((r) => Number(r.status) === 3).length,
        partial: items.filter((r) => Number(r.status) === 2).length,
        stale_over_24h: items.filter((r) => r.stale === true && Number(r.status) !== 0).length,
        unmapped_listings: unmappedListings,
        unmapped_items: unmappedItems,
      },
      warn:
        items.filter((r) => Number(r.status) === 3).length > 0
          ? '存在失败/0 条异常的同步任务，请查看 error_msg 并手动重跑'
          : undefined,
    });
  }),
);

/** 卖家中心表格导入兜底（方案第七章）：与接口同步共用 upsert + 快照 + 去重 + 告警 */
syncRouter.post(
  '/import/orders',
  wrap(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = parseBody(importBody, req.body);
    assertShopVisible(req, body.shop_id);
    const rows: Record<string, unknown>[] = [];
    const failed: { row: number; reason: string }[] = [];
    body.rows.forEach((raw, idx) => {
      const parsed = orderRow.safeParse(raw);
      if (parsed.success) rows.push(parsed.data as Record<string, unknown>);
      else {
        const issues = (parsed.error as unknown as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? [];
        failed.push({ row: idx + 1, reason: issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ') || '行格式错误' });
      }
    });
    if (!rows.length) throw badRequest(`没有可用行（共 ${body.rows.length} 行全部校验失败）`);
    const result = await importOrdersForShop(body.shop_id, rows, { user_id: user.id });
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'create',
      target_table: 'sync_log',
      target_id: result.log_id,
      after: {
        source: 'manual_import',
        task_type: 'order',
        shop_id: body.shop_id,
        total: body.rows.length,
        accepted: rows.length,
        rejected: failed.length,
        inserted: result.inserted,
        updated: result.updated,
      },
      ip: req.ip,
    });
    ok(
      res,
      { total: body.rows.length, accepted: rows.length, failed, run: result },
      failed.length ? `已导入 ${rows.length} 行，${failed.length} 行被拒绝` : 'ok',
    );
  }),
);
