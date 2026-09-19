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
import type { CurrentUser } from '@tk/shared';
import { all, get, update } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, paginate, parseBody, qv, wrap } from '../core/http.js';
import { requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
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

/** 数据范围：指定店铺角色限定事件店铺（无店铺的达人/寄样事件不受店铺范围限制）；仅本人角色只看自己名下或无主事件 */
function eventScope(user: CurrentUser): { sql: string; params: (number | string)[] } {
  const parts: string[] = [];
  const params: (number | string)[] = [];
  if (user.data_scope === 4) {
    const shop = shopScope(user, 'ae.shop_id');
    if (shop.sql) {
      parts.push(`(ae.shop_id IS NULL OR (1 = 1 ${shop.sql}))`);
      params.push(...shop.params);
    }
  }
  if (user.data_scope === 3) {
    parts.push(`(ae.owner_id = ? OR ae.owner_id IS NULL)`);
    params.push(user.id);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

interface EventRow extends Record<string, unknown> {
  evidence_json: string;
  priority: number;
  owner_id: number | null;
}

const withEvidence = (r: EventRow) => {
  const { evidence_json, ...rest } = r;
  let evidence: unknown = {};
  try {
    evidence = JSON.parse(String(evidence_json || '{}'));
  } catch {
    evidence = { raw: String(evidence_json ?? '') };
  }
  return { ...rest, evidence };
};

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
    ).map(withEvidence);
    const counts = all<{ status: number; c: number }>(
      `SELECT ae.status, COUNT(*) AS c FROM alert_event ae WHERE ae.is_deleted = 0 ${scope.sql.replace(/ae\.owner_id/g, 'ae.owner_id')} GROUP BY ae.status`,
      ...scope.params,
    );
    const recentResults = all(
      `SELECT acr.id, acr.result, acr.improvement_rate, acr.evaluated_at, acr.before_json, acr.after_json,
              oa.note, oa.expected_result, ae.target_name, ar.rule_name
         FROM action_result acr
         JOIN operation_action oa ON oa.id = acr.action_id AND oa.is_deleted = 0
         JOIN alert_event ae ON ae.id = oa.alert_event_id
         JOIN alert_rule ar ON ar.id = ae.rule_id
        WHERE acr.is_deleted = 0 AND acr.result <> 'pending'
        ORDER BY acr.evaluated_at DESC LIMIT 10`,
    );
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
    ).map(withEvidence);
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
    ok(res, { ...withEvidence(row), actions });
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
    const ev = get<{ id: number; owner_id: number | null; status: number; rule_id: number }>(
      `SELECT id, owner_id, status, rule_id FROM alert_event WHERE id = ? AND is_deleted = 0`,
      id,
    );
    if (!ev) throw notFound('预警事件不存在');
    if (user.data_scope === 3 && ev.owner_id !== null && Number(ev.owner_id) !== user.id) throw forbidden('只能处理自己名下的预警');
    if (body.action_type === 'transfer' && !body.owner_id) throw badRequest('转派必须指定 owner_id');
    const result = handleEvent(id, user.id, {
      action_type: body.action_type,
      note: body.note ?? null,
      expected_result: body.expected_result ?? null,
      observe_until: body.observe_until ?? null,
      owner_id: body.owner_id ?? null,
    });
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
    const { page, pageSize, limit, offset } = paginate(req);
    const base = `FROM action_result acr
       JOIN operation_action oa ON oa.id = acr.action_id AND oa.is_deleted = 0
       JOIN alert_event ae ON ae.id = oa.alert_event_id
       JOIN alert_rule ar ON ar.id = ae.rule_id
      WHERE acr.is_deleted = 0`;
    const total = Number(get<{ c: number }>(`SELECT COUNT(*) AS c ${base}`)?.c ?? 0);
    const list = all(
      `SELECT acr.id, acr.action_id, acr.evaluated_at, acr.before_json, acr.after_json, acr.result, acr.improvement_rate, acr.note,
              oa.action_at, oa.note AS action_note, oa.expected_result, oa.observe_until,
              ae.target_type, ae.target_name, ae.priority, ar.rule_code, ar.rule_name
         ${base} ORDER BY acr.evaluated_at DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    );
    ok(res, { list, total, page, pageSize });
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
    const shopId = qv(req, 'shop_id') ? Number(qv(req, 'shop_id')) : null;
    if (user.data_scope === 4 && shopId === null) {
      const shop = shopScope(user, 'id');
      // 指定店铺角色未选店时默认第一家可见店
      const first = get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ${shop.sql} ORDER BY id LIMIT 1`, ...shop.params);
      ok(res, shopChannelStructure({ shopId: first?.id ?? -1, weeks: Number(qv(req, 'weeks') ?? 8), end: rateDay(qv(req, 'end') ?? '') || undefined }));
      return;
    }
    ok(res, shopChannelStructure({ shopId, weeks: Number(qv(req, 'weeks') ?? 8), end: rateDay(qv(req, 'end') ?? '') || undefined }));
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
    const shopId = qv(req, 'shop_id') ? Number(qv(req, 'shop_id')) : user.data_scope === 4 ? (get<{ id: number }>(`SELECT id FROM tk_shop WHERE is_deleted = 0 ${shopScope(user, 'id').sql} ORDER BY id LIMIT 1`, ...shopScope(user, 'id').params)?.id ?? -1) : null;
    ok(res, { start, end, rows: abcAnalysis({ start, end, shopId }) });
  }),
);

actionsRouter.get(
  '/analytics/live/:id/minutes',
  requireMenu('dashboard'),
  wrap((req, res) => {
    ok(res, { list: liveMinutes(Number(req.params.id)) });
  }),
);
