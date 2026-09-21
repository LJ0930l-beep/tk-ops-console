/**
 * V2.0 今日行动中心 + 预警动作闭环 + 规则配置（§4/§14/§15.3）
 *
 * 权限约定：
 *  - 查看/处理预警：dashboard 菜单；data_scope=3（BD 等）只能处理自己名下事件。
 *  - 规则查看：dashboard 菜单（普通运营可查看规则命中，§18）；修改阈值/启停：system 菜单。
 *  - 处理动作、规则修改一律 writeOpLog 留痕；引擎负责冷却去重与证据快照。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { DATA_SCOPE, MASK, type CurrentUser } from '@tk/shared';
import { all, get, run, update } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, paginate, parseBody, qv, wrap } from '../core/http.js';
import { canAccessShop, hasMenu, loadUser, personScope, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
import { reconcileDueAlertNotifications } from '../services/notifications.js';
import { abcAnalysis, liveMinutes, shopChannelStructure } from '../services/analytics.js';
import { bumpRuleVersion, evaluateActionResults, evaluateRules, handleEvent } from '../services/rules/engine.js';
import { rateDay } from '../services/rates.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

export const actionsRouter = Router();

const EVENT_SELECT = `
  SELECT ae.id, ae.rule_id, ar.rule_code, ar.rule_name, ae.target_type, ae.target_id, ae.target_name,
         ae.shop_id, ae.detected_at, ae.evidence_json, ae.priority, ae.status, ae.owner_id,
         IFNULL(u.real_name, '') AS owner_name, ae.due_at
    FROM alert_event ae
    JOIN alert_rule ar ON ar.id = ae.rule_id
    LEFT JOIN sys_user u ON u.id = ae.owner_id
   WHERE ae.is_deleted = 0`;

/** 预警读取、动作和效果回看共用同一条数据范围规则；无店铺事件按负责人收敛。 */
export function eventScope(user: CurrentUser): { sql: string; params: (number | string)[] } {
  const parts: string[] = [];
  const params: (number | string)[] = [];
  if (user.data_scope === DATA_SCOPE.SHOPS) {
    const shop = shopScope(user, 'ae.shop_id');
    parts.push(`((ae.shop_id IS NOT NULL AND 1 = 1 ${shop.sql}) OR (ae.shop_id IS NULL AND ae.owner_id = ?))`);
    params.push(...shop.params, user.id);
  }
  if (user.data_scope === DATA_SCOPE.DEPT) {
    const shop = shopScope(user, 'ae.shop_id');
    parts.push(`((ae.shop_id IS NOT NULL AND 1 = 1 ${shop.sql}) OR
      (ae.shop_id IS NULL AND ae.owner_id IN (SELECT id FROM sys_user WHERE dept = (SELECT dept FROM sys_user WHERE id = ?))))`);
    params.push(...shop.params, user.id);
  }
  if (user.data_scope === DATA_SCOPE.SELF) {
    parts.push('ae.owner_id = ?');
    params.push(user.id);
  }
  if (![DATA_SCOPE.ALL, DATA_SCOPE.DEPT, DATA_SCOPE.SELF, DATA_SCOPE.SHOPS].some((scope) => scope === user.data_scope)) parts.push('1 = 0');
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/** Personal due reminders are restricted by recipient identity and the same event scope as actions. */
actionsRouter.get(
  '/notifications',
  requireMenu('dashboard'),
  wrap((req, res) => {
    reconcileDueAlertNotifications();
    const user = current(req);
    const scope = eventScope(user);
    const where = `n.recipient_id = ? AND n.is_deleted = 0 AND n.stale_at IS NULL
      AND ae.is_deleted = 0 AND ae.status IN (0, 1) AND ae.owner_id = ?
      AND ae.due_at = n.due_at_snapshot AND datetime(ae.due_at) <= datetime('now')
      AND n.assignment_cycle = COALESCE((SELECT MAX(oa.id) FROM operation_action oa
        WHERE oa.alert_event_id = ae.id AND oa.action_type = 'transfer' AND oa.is_deleted = 0), 0)${scope.sql}`;
    const params = [user.id, user.id, ...scope.params];
    const unreadTotal = Number(get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM user_notification n
         JOIN alert_event ae ON ae.id = n.alert_event_id
        WHERE ${where} AND n.read_at IS NULL`,
      ...params,
    )?.c ?? 0);
    const list = all(
      `SELECT n.id, n.alert_event_id, n.due_at_snapshot AS due_at, n.read_at, n.created_at,
              ae.priority, ae.target_name, ar.rule_name
         FROM user_notification n
         JOIN alert_event ae ON ae.id = n.alert_event_id
         JOIN alert_rule ar ON ar.id = ae.rule_id
        WHERE ${where}
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC, n.id DESC
        LIMIT 50`,
      ...params,
    );
    ok(res, { list, unread_total: unreadTotal });
  }),
);

/** Mark a notification read only while its recipient still owns an in-scope open event. */
actionsRouter.post(
  '/notifications/:id/read',
  requireMenu('dashboard'),
  wrap((req, res) => {
    reconcileDueAlertNotifications();
    const user = current(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound('提醒不存在或已失效');
    const scope = eventScope(user);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const changed = updateNotificationRead(id, user.id, now, scope.sql, scope.params);
    if (!changed) throw notFound('提醒不存在或已失效');
    ok(res, { id, read_at: get<{ read_at: string }>(
      `SELECT read_at FROM user_notification WHERE id = ? AND recipient_id = ? AND is_deleted = 0`, id, user.id,
    )?.read_at ?? now });
  }),
);

function updateNotificationRead(
  id: number,
  userId: number,
  now: string,
  scopeSql: string,
  scopeParams: (number | string)[],
): number {
  const sql =
    `UPDATE user_notification
        SET read_at = COALESCE(read_at, ?), updated_at = ?
      WHERE id = ? AND recipient_id = ? AND is_deleted = 0 AND stale_at IS NULL
        AND EXISTS (
          SELECT 1 FROM alert_event ae
           WHERE ae.id = user_notification.alert_event_id AND ae.is_deleted = 0
             AND ae.status IN (0, 1) AND ae.owner_id = user_notification.recipient_id
             AND ae.due_at = user_notification.due_at_snapshot
             AND datetime(ae.due_at) <= datetime('now')
             AND user_notification.assignment_cycle = COALESCE((SELECT MAX(oa.id) FROM operation_action oa
               WHERE oa.alert_event_id = ae.id AND oa.action_type = 'transfer' AND oa.is_deleted = 0), 0)
             ${scopeSql}
        )`;
  return run(sql, now, now, id, userId, ...scopeParams).changes;
}

/** 只允许分析接口读取用户有权限的店铺；受限角色未选择店铺时默认第一家可见店。 */
function analyticsShopId(user: CurrentUser, requested: string | undefined): number | null {
  const scope = shopScope(user, 'id');
  if (requested !== undefined && requested !== '') {
    const id = Number(requested);
    const row = Number.isInteger(id)
      ? get<{ id: number }>(`SELECT id FROM tk_shop WHERE id = ? AND is_deleted = 0 ${scope.sql}`, id, ...scope.params)
      : undefined;
    if (!row) throw notFound('店铺不存在或不在你的数据范围内');
    return Number(row.id);
  }
  if (user.data_scope === DATA_SCOPE.ALL) return null;
  return Number(get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ${scope.sql} ORDER BY id LIMIT 1`, ...scope.params)?.id ?? -1);
}

/** 直播分钟是按场次 ID 查询，必须先确认场次归属在当前用户范围内。 */
function liveSessionScope(user: CurrentUser): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  if (user.data_scope === DATA_SCOPE.SELF) {
    return { sql: ' AND (l.host_id = ? OR l.assistant_id = ? OR l.created_by = ?)', params: [user.id, user.id, user.id] };
  }
  const members = '(SELECT id FROM sys_user WHERE dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL)';
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return {
      sql: ` AND (l.host_id IN ${members} OR l.assistant_id IN ${members} OR l.created_by IN ${members})`,
      params: [user.id, user.id, user.id],
    };
  }
  if (user.data_scope === DATA_SCOPE.SHOPS) {
    if (!user.shop_ids.length) {
      return { sql: ' AND (l.host_id = ? OR l.assistant_id = ? OR l.created_by = ?)', params: [user.id, user.id, user.id] };
    }
    return {
      sql: ` AND (l.shop_id IN (${user.shop_ids.map(() => '?').join(',')}) OR l.host_id = ? OR l.assistant_id = ?)`,
      params: [...user.shop_ids, user.id, user.id],
    };
  }
  return { sql: ' AND 1 = 0', params: [] };
}

interface EventRow extends Record<string, unknown> {
  evidence_json: string;
  rule_code: string;
  priority: number;
  owner_id: number | null;
}

const withEvidence = (r: EventRow, user: CurrentUser) => {
  const { evidence_json, ...rest } = r;
  let evidence: unknown = {};
  try {
    evidence = JSON.parse(String(evidence_json || '{}'));
  } catch {
    evidence = { raw: String(evidence_json ?? '') };
  }
  if (!user.can_see_cost && r.rule_code === 'ADS_LOSS' && evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const parsed = evidence as Record<string, unknown>;
    evidence = {
      rule: r.rule_code,
      window: parsed.window,
      redacted: true,
    };
  }
  return { ...rest, evidence };
};

/** 广告亏损结果快照和自由文本可能包含成本数值，无成本权限时一并遮蔽。 */
function maskAdsActionResult<T extends Record<string, unknown>>(row: T, ruleCode: string, user: CurrentUser): T {
  if (user.can_see_cost || ruleCode !== 'ADS_LOSS') return row;
  const masked = { ...row } as Record<string, unknown>;
  for (const key of ['before_json', 'after_json']) {
    if (key in masked) masked[key] = JSON.stringify({ redacted: true });
  }
  for (const key of ['note', 'action_note', 'expected_result']) {
    if (typeof masked[key] === 'string' && masked[key]) masked[key] = MASK;
  }
  return masked as T;
}

/** 今日行动中心：P0/P1/P2 + 我的待办 + 状态计数 + 最近效果回看（§4 首页第一屏） */
actionsRouter.get(
  '/today',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const scope = eventScope(user);
    const open = all<EventRow>(
      `${EVENT_SELECT} AND ae.status IN (0, 1) ${scope.sql} ORDER BY ae.priority ASC, ae.detected_at DESC LIMIT 300`,
      ...scope.params,
    ).map((r) => withEvidence(r, user));
    const counts = all<{ status: number; c: number }>(
      `SELECT ae.status, COUNT(*) AS c FROM alert_event ae WHERE ae.is_deleted = 0 ${scope.sql.replace(/ae\.owner_id/g, 'ae.owner_id')} GROUP BY ae.status`,
      ...scope.params,
    );
    const recentResults = all<Record<string, unknown>>(
      `SELECT acr.id, acr.result, acr.improvement_rate, acr.evaluated_at, acr.before_json, acr.after_json,
              oa.note, oa.expected_result, ae.target_name, ar.rule_name, ar.rule_code
         FROM action_result acr
         JOIN operation_action oa ON oa.id = acr.action_id AND oa.is_deleted = 0
         JOIN alert_event ae ON ae.id = oa.alert_event_id AND ae.is_deleted = 0
         JOIN alert_rule ar ON ar.id = ae.rule_id
        WHERE acr.is_deleted = 0 AND acr.result <> 'pending' ${scope.sql}
        ORDER BY acr.evaluated_at DESC LIMIT 10`,
      ...scope.params,
    ).map(({ rule_code, ...row }) => maskAdsActionResult(row, String(rule_code ?? ''), user));
    ok(res, {
      p0: open.filter((r) => Number(r.priority) === 0),
      p1: open.filter((r) => Number(r.priority) === 1),
      p2: open.filter((r) => Number(r.priority) === 2),
      mine: open.filter((r) => Number(r.owner_id) === user.id),
      counts: Object.fromEntries(counts.map((c) => [String(c.status), Number(c.c)])),
      recent_results: recentResults,
    });
  }),
);

/** 预警事件分页（历史/已处理查询） */
actionsRouter.get(
  '/events',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const scope = eventScope(user);
    const conds: string[] = [scope.sql];
    const params: (number | string)[] = [...scope.params];
    const priority = qv(req, 'priority');
    const status = qv(req, 'status');
    const targetType = qv(req, 'target_type');
    const ruleCode = qv(req, 'rule_code');
    if (priority !== undefined) { conds.push(' AND ae.priority = ?'); params.push(Number(priority)); }
    if (status !== undefined) { conds.push(' AND ae.status = ?'); params.push(Number(status)); }
    if (targetType) { conds.push(' AND ae.target_type = ?'); params.push(targetType); }
    if (ruleCode) { conds.push(' AND ar.rule_code = ?'); params.push(ruleCode); }
    const where = conds.join('');
    const { page, pageSize, limit, offset } = paginate(req);
    const total = Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM alert_event ae JOIN alert_rule ar ON ar.id = ae.rule_id WHERE ae.is_deleted = 0${where}`, ...params)?.c ?? 0);
    const list = all<EventRow>(
      `${EVENT_SELECT}${where} ORDER BY ae.priority ASC, ae.detected_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ).map((r) => withEvidence(r, user));
    ok(res, { list, total, page, pageSize });
  }),
);

/** 事件详情：证据 + 处理流水 + 效果回看 */
actionsRouter.get(
  '/events/:id',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const scope = eventScope(user);
    const row = get<EventRow>(`${EVENT_SELECT} AND ae.id = ? ${scope.sql}`, Number(req.params.id), ...scope.params);
    if (!row) throw notFound('预警事件不存在');
    const actions = all(
      `SELECT oa.id, oa.action_type, oa.action_at, oa.note, oa.expected_result, oa.observe_until,
              IFNULL(u.real_name, '') AS handler_name,
              acr.result, acr.improvement_rate, acr.before_json, acr.after_json, acr.evaluated_at
         FROM operation_action oa
         LEFT JOIN sys_user u ON u.id = oa.handler_id
         LEFT JOIN action_result acr ON acr.action_id = oa.id AND acr.is_deleted = 0
        WHERE oa.is_deleted = 0 AND oa.alert_event_id = ?
        ORDER BY oa.action_at ASC`,
      Number(req.params.id),
    );
    ok(res, { ...withEvidence(row, user), actions: actions.map((action) => maskAdsActionResult(action as Record<string, unknown>, row.rule_code, user)) });
  }),
);

const handleSchema = z.object({
  action_type: z.enum(['handle', 'ignore', 'transfer', 'note']),
  note: z.string().max(500).nullish(),
  expected_result: z.string().max(500).nullish(),
  observe_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  owner_id: z.number().int().positive().nullish(),
});

/** 处理预警：写动作流水并推进状态；handle 自动生成 pending 效果回看（观察期默认 7 天） */
actionsRouter.post(
  '/events/:id/handle',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(handleSchema, req.body ?? {});
    const id = Number(req.params.id);
    const scope = eventScope(user);
    const ev = get<{ id: number; owner_id: number | null; status: number; rule_id: number; shop_id: number | null }>(
      `SELECT id, owner_id, status, rule_id, shop_id FROM alert_event ae WHERE ae.id = ? AND ae.is_deleted = 0 ${scope.sql}`,
      id,
      ...scope.params,
    );
    if (!ev) throw notFound('预警事件不存在');
    if (user.data_scope === DATA_SCOPE.SELF && ev.owner_id !== null && Number(ev.owner_id) !== user.id) throw forbidden('只能处理自己名下的预警');
    if (body.action_type === 'transfer' && !body.owner_id) throw badRequest('转派必须指定 owner_id');
    if (body.action_type === 'transfer' && body.owner_id) {
      const owner = user.data_scope === DATA_SCOPE.SHOPS
        ? ev.shop_id !== null
          ? get<{ id: number }>(
            `SELECT u.id FROM sys_user u WHERE u.id = ? AND u.is_deleted = 0 AND u.status = 1
               AND EXISTS (SELECT 1 FROM sys_user_shop us WHERE us.user_id = u.id AND us.shop_id = ? AND us.is_deleted = 0)`,
            body.owner_id,
            ev.shop_id,
          )
          : get<{ id: number }>(
              `SELECT u.id FROM sys_user u WHERE u.id = ? AND u.is_deleted = 0 AND u.status = 1
                 AND u.dept IS NOT NULL AND u.dept = (SELECT dept FROM sys_user WHERE id = ?)`,
              body.owner_id,
              user.id,
            )
        : get<{ id: number }>(
            `SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0 AND status = 1 ${personScope(user, 'id', true).sql}`,
            body.owner_id,
            ...personScope(user, 'id', true).params,
            );
      if (!owner) throw forbidden('只能转派给数据范围内的在职成员');
      const recipient = loadUser(body.owner_id);
      if (!recipient || !hasMenu(recipient, 'dashboard')) throw forbidden('转派对象没有行动中心访问权限');
      if (ev.shop_id !== null) {
        if (!canAccessShop(recipient, Number(ev.shop_id))) throw forbidden('转派对象无权查看该店铺预警');
      } else if (
        (recipient.data_scope === DATA_SCOPE.DEPT && recipient.dept === null) ||
        ![DATA_SCOPE.ALL, DATA_SCOPE.SELF, DATA_SCOPE.DEPT, DATA_SCOPE.SHOPS].some((scope) => scope === recipient.data_scope)
      ) {
        throw forbidden('转派对象无法查看此类预警');
      }
    }
    const result = handleEvent(id, user.id, {
      action_type: body.action_type,
      note: body.note ?? null,
      expected_result: body.expected_result ?? null,
      observe_until: body.observe_until ?? null,
      owner_id: body.owner_id ?? null,
    });
    try {
      reconcileDueAlertNotifications(new Date(), id);
    } catch (error) {
      console.error(`[notifications] alert_event ${id} 提醒同步失败：${error instanceof Error ? error.message : String(error)}`);
    }
    writeOpLog({
      user_id: user.id,
      module: '行动中心',
      action: 'update',
      target_table: 'alert_event',
      target_id: id,
      after: { ...body, status: result.status },
      ip: req.ip,
    });
    ok(res, result);
  }),
);

/** 效果回看列表（§4.1：观察期后对比处理前后指标） */
actionsRouter.get(
  '/results',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const scope = eventScope(user);
    const { page, pageSize, limit, offset } = paginate(req);
    const base = `FROM action_result acr
       JOIN operation_action oa ON oa.id = acr.action_id AND oa.is_deleted = 0
       JOIN alert_event ae ON ae.id = oa.alert_event_id AND ae.is_deleted = 0
       JOIN alert_rule ar ON ar.id = ae.rule_id
      WHERE acr.is_deleted = 0 ${scope.sql}`;
    const total = Number(get<{ c: number }>(`SELECT COUNT(*) AS c ${base}`, ...scope.params)?.c ?? 0);
    const list = all<Record<string, unknown>>(
      `SELECT acr.id, acr.action_id, acr.evaluated_at, acr.before_json, acr.after_json, acr.result, acr.improvement_rate, acr.note,
              oa.action_at, oa.note AS action_note, oa.expected_result, oa.observe_until,
              ae.target_type, ae.target_name, ae.priority, ar.rule_code, ar.rule_name
         ${base} ORDER BY acr.evaluated_at DESC LIMIT ? OFFSET ?`,
      ...scope.params,
      limit,
      offset,
    );
    ok(res, { list: list.map(({ rule_code, ...row }) => maskAdsActionResult(row, String(rule_code ?? ''), user)), total, page, pageSize });
  }),
);

/** 手动跑一轮规则（system 菜单；调度器每日自动跑，这里供管理员补跑/验证阈值） */
actionsRouter.post(
  '/evaluate',
  requireMenu('system'),
  wrap((req, res) => {
    const user = current(req);
    const end = rateDay(qv(req, 'end') ?? '') || undefined;
    const outcome = evaluateRules({ end, userId: user.id });
    const results = evaluateActionResults(end);
    writeOpLog({ user_id: user.id, module: '行动中心', action: 'update', target_table: 'alert_rule', after: { evaluate: outcome, results }, ip: req.ip });
    ok(res, { ...outcome, results_evaluated: results });
  }),
);

/** 规则清单：普通运营可查看（§18 规则权限），修改走 system */
actionsRouter.get(
  '/rules',
  requireMenu('dashboard'),
  wrap((_req, res) => {
    const list = all(
      `SELECT id, rule_code, rule_name, target_type, scope_json, metric, operator, threshold, window_days,
              priority, cooldown_hours, version, status, params_json, remark, updated_at
         FROM alert_rule WHERE is_deleted = 0 ORDER BY priority ASC, rule_code ASC`,
    );
    ok(res, { list });
  }),
);

const ruleUpdateSchema = z.object({
  rule_name: z.string().max(100).optional(),
  operator: z.enum(['>', '>=', '<', '<=', '==']).optional(),
  threshold: z.number().optional(),
  window_days: z.number().int().min(1).max(365).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  cooldown_hours: z.number().int().min(1).max(24 * 30).optional(),
  status: z.union([z.literal(0), z.literal(1)]).optional(),
  params_json: z.string().max(2000).optional(),
  scope_json: z.string().max(2000).optional(),
  remark: z.string().max(255).nullish(),
});

/** 修改规则阈值/启停：版本号 +1，全程留痕（阈值全部配置化，§0 硬规则） */
actionsRouter.put(
  '/rules/:id',
  requireMenu('system'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM alert_rule WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('规则不存在');
    const body = parseBody(ruleUpdateSchema, req.body ?? {});
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) {
      update('alert_rule', id, patch as never);
      bumpRuleVersion(id);
      writeOpLog({ user_id: user.id, module: '行动中心', action: 'update', target_table: 'alert_rule', target_id: id, before, after: patch, ip: req.ip });
    }
    ok(res, get(`SELECT * FROM alert_rule WHERE id = ?`, id));
  }),
);

/* ==================== 分析视图（店铺渠道结构 / 商品 ABC / 直播分钟） ==================== */

actionsRouter.get(
  '/analytics/shop-channel',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const shopId = analyticsShopId(user, qv(req, 'shop_id'));
    const result = shopChannelStructure({ shopId, weeks: Number(qv(req, 'weeks') ?? 8), end: rateDay(qv(req, 'end') ?? '') || undefined });
    ok(res, user.can_see_cost ? result : result.map((w) => ({
      ...w,
      channels: Object.fromEntries(Object.entries(w.channels).map(([key, value]) => [key, { ...value, ad_spend: null }])),
    })));
  }),
);

actionsRouter.get(
  '/analytics/abc',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const user = current(req);
    const end = rateDay(qv(req, 'end') ?? '') || new Date().toISOString().slice(0, 10);
    const days = Math.min(180, Math.max(1, Number(qv(req, 'days') ?? 30) || 30));
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const shopId = analyticsShopId(user, qv(req, 'shop_id'));
    ok(res, { start, end, rows: abcAnalysis({ start, end, shopId }) });
  }),
);

actionsRouter.get(
  '/analytics/live/:id/minutes',
  requireMenu('dashboard'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    const scope = liveSessionScope(current(req));
    const session = Number.isInteger(id)
      ? get<{ id: number }>(`SELECT l.id FROM live_session l WHERE l.id = ? AND l.is_deleted = 0 ${scope.sql}`, id, ...scope.params)
      : undefined;
    if (!session) throw notFound('直播场次不存在或不在你的数据范围内');
    ok(res, { list: liveMinutes(id) });
  }),
);
