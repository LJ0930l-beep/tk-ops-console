import { Router } from 'express';
import { z } from 'zod';
import { MENU_KEYS, type CurrentUser, type MenuKey } from '@tk/shared';
import { all, get, insert, run, softDelete, tx, update } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { hashPassword, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { maskError } from '../core/redact.js';
import { changesOfLogEntry, writeOpLog } from '../core/oplog.js';
import { config } from '../config.js';
import { drainJobs, enqueueJob, getJob, listJobs, requeueStaleJobs } from '../services/jobs/queue.js';

const current = (req: object): CurrentUser => (req as AuthedRequest).user;

/** 系统设置菜单只有老板与持 system 权限的角色可写 */
const sysOnly = requireMenu('system');

/**
 * 提权防线：`system` 菜单只决定「能否进入系统设置」，不代表能把权限发给任何人。
 * 角色写入、给用户改角色/数据范围、停用高权限账号都必须 boss，
 * 否则持 system 菜单的运营经理可以自建全权角色再挂到自己身上。
 */
function requireBoss(req: object, action: string): void {
  if (current(req).role_key !== 'boss') throw forbidden(`仅老板（boss）可以${action}`);
}

/** 高危角色：老板、全店数据范围或持有 system 菜单 */
function isPrivilegedRole(roleId: number): boolean {
  return !!get<{ id: number }>(
    `SELECT id FROM sys_role WHERE id = ? AND is_deleted = 0
       AND (role_key = 'boss' OR data_scope = 1 OR menu_perms LIKE '%"system"%')`,
    roleId,
  );
}

/** 目标账号是否已持有高危权限 */
function isPrivilegedUser(userId: number): boolean {
  const row = get<{ role_id: number }>(`SELECT role_id FROM sys_user WHERE id = ? AND is_deleted = 0`, userId);
  return !!row && isPrivilegedRole(Number(row.role_id));
}

/* ==================== 表 21 用户 sys_user ==================== */
export const userRouter = Router();
userRouter.use(sysOnly);

const userBody = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(8).max(64).optional(),
  real_name: z.string().min(1).max(50),
  phone: z.string().max(20).nullish(),
  dept: z.string().max(50).nullish(),
  role_id: z.number().int().positive(),
  status: z.union([z.literal(0), z.literal(1)]).default(1),
  shop_ids: z.array(z.number().int().positive()).optional(),
});

userRouter.get(
  '/',
  wrap((req, res) => {
    const q = new Q('u.is_deleted = 0')
      .like(`u.username LIKE ? OR u.real_name LIKE ?`, req.query.keyword)
      .eq('u.role_id', req.query.role_id)
      .eq('u.dept', req.query.dept, false)
      .eq('u.status', req.query.status);
    ok(res, queryPage(req, {
      from: `sys_user u JOIN sys_role r ON r.id = u.role_id`,
      select: 'u.id, u.username, u.real_name, u.phone, u.dept, u.role_id, r.role_name, r.role_key, u.status, u.last_login_at, u.created_at',
      q,
      orderBy: 'u.id ASC',
    }));
  }),
);

userRouter.get('/:id/shops', wrap((req, res) =>
  ok(res, all(`SELECT s.id AS shop_id, s.shop_name FROM sys_user_shop us JOIN tk_shop s ON s.id = us.shop_id WHERE us.user_id = ? AND us.is_deleted = 0`, Number(req.params.id))),
));

userRouter.post(
  '/',
  wrap((req, res) => {
    const body = parseBody(userBody, req.body);
    if (!body.password) throw badRequest('新建员工必须提供初始密码（至少 8 位）');
    if (isPrivilegedRole(body.role_id)) requireBoss(req, '创建高权限角色员工');
    if (body.shop_ids?.length) requireBoss(req, '绑定员工店铺范围');
    const id = tx(() => {
      const uid = insert('sys_user', {
        username: body.username,
        password_hash: hashPassword(body.password as string),
        real_name: body.real_name,
        phone: body.phone ?? null,
        dept: body.dept ?? null,
        role_id: body.role_id,
        status: body.status ?? 1,
        created_by: current(req).id,
      });
      for (const shop_id of body.shop_ids ?? []) insert('sys_user_shop', { user_id: uid, shop_id, created_by: current(req).id });
      return uid;
    });
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'create', target_table: 'sys_user', target_id: id, after: { ...body, password: '***' }, ip: req.ip });
    ok(res, { id });
  }),
);

userRouter.put(
  '/:id',
  wrap((req, res) => {
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM sys_user WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('员工不存在');
    const body = parseBody(userBody.partial().omit({ username: true }), req.body);
    if (body.shop_ids) requireBoss(req, '调整员工店铺范围');
    if (body.role_id && Number(body.role_id) !== Number(before.role_id) && (isPrivilegedUser(id) || isPrivilegedRole(body.role_id))) requireBoss(req, '调整账号角色');
    if (body.password && isPrivilegedUser(id)) requireBoss(req, '重置高权限账号密码');
    if (body.status !== undefined && isPrivilegedUser(id)) requireBoss(req, '变更高权限账号状态');
    tx(() => {
      const { shop_ids, password, ...rest } = body;
      if (Object.keys(rest).length) update('sys_user', id, rest as never);
      if (password) update('sys_user', id, { password_hash: hashPassword(password) } as never);
      if (shop_ids) {
        run(`UPDATE sys_user_shop SET is_deleted = 1, updated_at = datetime('now') WHERE user_id = ?`, id);
        for (const shop_id of shop_ids) {
          const exists = get<{ id: number }>(`SELECT id FROM sys_user_shop WHERE user_id = ? AND shop_id = ?`, id, shop_id);
          if (exists) run(`UPDATE sys_user_shop SET is_deleted = 0, updated_at = datetime('now') WHERE id = ?`, exists.id);
          else insert('sys_user_shop', { user_id: id, shop_id, created_by: current(req).id });
        }
      }
      return id;
    });
    const { password_hash: _ph, ...beforeSafe } = before;
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'update', target_table: 'sys_user', target_id: id, before: beforeSafe, after: { ...body, password: '***' }, ip: req.ip });
    ok(res, { id });
  }),
);

/** 离职停用：不真删，历史记录保留（方案表 21） */
userRouter.post(
  '/:id/deactivate',
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0`, id)) throw notFound('员工不存在');
    if (isPrivilegedUser(id)) requireBoss(req, '停用高权限账号');
    update('sys_user', id, { status: 0 } as never);
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'update', target_table: 'sys_user', target_id: id, after: { status: 0 }, ip: req.ip });
    ok(res, { id });
  }),
);

/* ==================== 表 22 角色 sys_role ==================== */
export const roleRouter = Router();
roleRouter.use(sysOnly);

const roleBody = z.object({
  role_name: z.string().min(1).max(50),
  role_key: z.string().min(2).max(50),
  menu_perms: z.array(z.enum([...MENU_KEYS] as [string, ...string[]])).default([]),
  data_scope: z.number().int().min(1).max(4).default(3),
  can_see_cost: z.union([z.literal(0), z.literal(1)]).default(0),
  can_see_contact: z.union([z.literal(0), z.literal(1)]).default(0),
  can_export: z.union([z.literal(0), z.literal(1)]).default(0),
});

roleRouter.get('/', wrap((_req, res) =>
  ok(res, queryList({
    from: 'sys_role r',
    q: new Q('r.is_deleted = 0'),
    select: 'r.*, (SELECT COUNT(*) FROM sys_user u WHERE u.role_id = r.id AND u.is_deleted = 0) AS user_count',
    orderBy: 'r.id ASC',
  }).map((r) => ({ ...r, menu_perms: JSON.parse(String((r as Record<string, unknown>).menu_perms ?? '[]')) }))),
));

roleRouter.post(
  '/',
  wrap((req, res) => {
    requireBoss(req, '新增角色');
    const body = parseBody(roleBody, req.body);
    const id = insert('sys_role', { ...body, menu_perms: JSON.stringify(body.menu_perms), created_by: current(req).id });
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'create', target_table: 'sys_role', target_id: id, after: body, ip: req.ip });
    ok(res, { id });
  }),
);

roleRouter.put(
  '/:id',
  wrap((req, res) => {
    requireBoss(req, '修改角色的菜单/数据范围/敏感开关');
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM sys_role WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('角色不存在');
    const body = parseBody(roleBody.partial(), req.body);
    update('sys_role', id, { ...body, menu_perms: body.menu_perms ? JSON.stringify(body.menu_perms) : undefined } as never);
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'update', target_table: 'sys_role', target_id: id, before, after: { ...before, ...body }, ip: req.ip });
    ok(res, { id });
  }),
);

/* ==================== 表 23 数据权限 sys_user_shop ==================== */
export const dataScopeRouter = Router();
dataScopeRouter.use(sysOnly);

dataScopeRouter.get('/:userId', wrap((req, res) =>
  ok(res, all(`SELECT us.id, us.shop_id, s.shop_name, s.region FROM sys_user_shop us JOIN tk_shop s ON s.id = us.shop_id WHERE us.user_id = ? AND us.is_deleted = 0`, Number(req.params.userId))),
));

dataScopeRouter.put(
  '/:userId',
  wrap((req, res) => {
    requireBoss(req, '调整员工店铺范围');
    const userId = Number(req.params.userId);
    const { shop_ids } = parseBody(z.object({ shop_ids: z.array(z.number().int().positive()) }), req.body);
    tx(() => {
      run(`UPDATE sys_user_shop SET is_deleted = 1, updated_at = datetime('now') WHERE user_id = ?`, userId);
      for (const shop_id of shop_ids) {
        const exists = get<{ id: number }>(`SELECT id FROM sys_user_shop WHERE user_id = ? AND shop_id = ?`, userId, shop_id);
        if (exists) run(`UPDATE sys_user_shop SET is_deleted = 0, updated_at = datetime('now') WHERE id = ?`, exists.id);
        else insert('sys_user_shop', { user_id: userId, shop_id, created_by: current(req).id });
      }
      return userId;
    });
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'update', target_table: 'sys_user_shop', target_id: userId, after: { shop_ids }, ip: req.ip });
    ok(res, { userId });
  }),
);

/* ==================== 表 24 操作日志（只读，任何人不能改） ==================== */
export const opLogRouter = Router();
opLogRouter.use(sysOnly);

opLogRouter.get('/', wrap((req, res) => {
  const q = new Q('l.is_deleted = 0')
    .eq('l.user_id', req.query.user_id)
    .eq('l.module', req.query.module, false)
    .eq('l.action', req.query.action, false)
    .eq('l.target_table', req.query.target_table, false)
    .between('l.op_time', req.query.start_date, req.query.end_date);
  ok(res, queryPage(req, {
    from: 'sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id',
    select: 'l.*, u.real_name AS user_name',
    q,
    orderBy: 'l.op_time DESC',
  }));
}));

/**
 * 单条记录的字段级变更历史（选项 9 的可落地小步）：扁平的 /oplog 列表答不出
 * 「这条记录为什么变成现在这样」，这里按 target_table + target_id 聚合，并把
 * before/after 原文 diff 成「哪个字段从什么改成什么」。
 *
 * 权限沿用本段开头的整段守卫（与列表同一条）：日志里有别人的操作与改前改后原文，
 * 只有能读全量审计日志的角色才能按记录查 —— 不能因为「查的是同一条记录」就放宽到该记录的可见范围。
 * 空变更的条目照样返回（动作本身要留痕）；凭证列只报「改过」，值一律不出接口。
 */
opLogRouter.get('/history', wrap((req, res) => {
  const table = qv(req, 'table');
  if (!table || !/^[a-z][a-z0-9_]{1,63}$/.test(table)) throw badRequest('table 需为表名（小写字母、数字、下划线）');
  const id = Number(qv(req, 'id'));
  if (!Number.isInteger(id) || id <= 0) throw badRequest('记录 ID 不合法');
  const cap = config.oplogHistoryMaxRows;
  const limit = Math.min(cap, Math.max(1, Number(qv(req, 'limit')) || cap));
  const rows = all<Record<string, unknown>>(
    `SELECT l.id, l.action, l.module, l.ip, l.op_time AS created_at, l.before_after, u.real_name AS user_name
       FROM sys_op_log l LEFT JOIN sys_user u ON u.id = l.user_id
      WHERE l.is_deleted = 0 AND l.target_table = ? AND l.target_id = ?
      ORDER BY l.id DESC LIMIT ?`,
    table, id, limit,
  );
  ok(res, rows.map((r) => ({
    id: r.id,
    action: r.action,
    module: r.module,
    user_name: r.user_name ?? null,
    created_at: r.created_at,
    ip: r.ip ?? null,
    changes: changesOfLogEntry(r.before_after),
  })));
}));

/* ==================== 表 25 同步日志（含失败告警状态） ==================== */
export const syncLogRouter = Router();

syncLogRouter.get(
  '/',
  sysOnly,
  wrap((req, res) => {
    const q = new Q('sl.is_deleted = 0')
      .eq('sl.task_type', req.query.task_type, false)
      .eq('sl.shop_id', req.query.shop_id)
      .eq('sl.status', req.query.status)
      .between('sl.started_at', req.query.start_date, req.query.end_date);
    ok(res, queryPage(req, {
      from: 'sync_log sl LEFT JOIN tk_shop s ON s.id = sl.shop_id',
      select: 'sl.*, s.shop_name',
      q,
      orderBy: 'sl.started_at DESC',
    }));
  }),
);

/**
 * 同步健康度：最近一次各任务状态，供顶栏红点与系统监控页。
 * 顶栏对所有角色可见，所以这里不挡菜单，但必须按数据范围收敛、且错误文案过脱敏，
 * 否则任何登录用户都能读到别人店铺的同步明细和上游报错原文。
 */
syncLogRouter.get('/health', wrap((req, res) => {
  const scope = shopScope(current(req), 'sl.shop_id');
  const rows = all<Record<string, unknown>>(
    `SELECT sl.shop_id, s.shop_name, sl.task_type, sl.status, sl.fetched, sl.failed, sl.started_at, sl.error_msg
       FROM sync_log sl
       JOIN tk_shop s ON s.id = sl.shop_id
      WHERE sl.is_deleted = 0 AND sl.id IN (SELECT MAX(id) FROM sync_log WHERE is_deleted = 0 GROUP BY shop_id, task_type) ${scope.sql}
      ORDER BY sl.status DESC, s.shop_name`,
    ...scope.params,
  );
  ok(res, rows.map((r) => ({ ...r, error_msg: r.error_msg === null ? null : maskError(String(r.error_msg)) })));
}));

/* ==================== 表 26 数据字典 ==================== */
export const dictRouter = Router();

dictRouter.get('/types', wrap((_req, res) =>
  ok(res, all(`SELECT dict_type, COUNT(*) AS cnt FROM sys_dict WHERE is_deleted = 0 GROUP BY dict_type ORDER BY dict_type`)),
));

dictRouter.get('/:type', wrap((req, res) =>
  ok(res, all(`SELECT dict_value, dict_label, sort FROM sys_dict WHERE dict_type = ? AND status = 1 AND is_deleted = 0 ORDER BY sort, id`, String(req.params.type))),
));

const dictBody = z.object({
  dict_type: z.string().min(1).max(50),
  dict_value: z.string().min(1).max(50),
  dict_label: z.string().min(1).max(100),
  sort: z.number().int().default(0),
  status: z.union([z.literal(0), z.literal(1)]).default(1),
});

dictRouter.get('/', sysOnly, wrap((req, res) => {
  const q = new Q('t.is_deleted = 0')
    .eq('t.dict_type', req.query.dict_type, false)
    .like(`t.dict_label LIKE ? OR t.dict_value LIKE ?`, req.query.keyword);
  // queryPage 默认 select t.*，from 必须自带别名 t，否则整页 500（no such table: t）
  ok(res, queryPage(req, { from: 'sys_dict t', q, orderBy: 't.dict_type ASC, t.sort ASC' }));
}));

dictRouter.post(
  '/',
  sysOnly,
  wrap((req, res) => {
    const body = parseBody(dictBody, req.body);
    const id = insert('sys_dict', { ...body, created_by: current(req).id });
    writeOpLog({ user_id: current(req).id, module: '系统设置', action: 'create', target_table: 'sys_dict', target_id: id, after: body, ip: req.ip });
    ok(res, { id });
  }),
);

dictRouter.put('/:id', sysOnly, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!get(`SELECT id FROM sys_dict WHERE id = ? AND is_deleted = 0`, id)) throw notFound('字典项不存在');
  update('sys_dict', id, parseBody(dictBody.partial(), req.body) as never);
  ok(res, { id });
}));

dictRouter.delete('/:id', sysOnly, wrap((req, res) => {
  softDelete('sys_dict', Number(req.params.id));
  ok(res, null);
}));

/* ==================== 系统路由聚合 ==================== */
export const systemRouter = Router();
systemRouter.use('/users', userRouter);
systemRouter.use('/roles', roleRouter);
systemRouter.use('/data-scope', dataScopeRouter);
systemRouter.use('/oplog', opLogRouter);
systemRouter.use('/synclog', syncLogRouter);
systemRouter.use('/dict', dictRouter);

/** BD 离职一键交接：私海达人 + 合作单 + 跟进 全部转给接手人（方案 8.2 硬规则） */
systemRouter.post(
  '/transfer-creator',
  requireMenu('creator'),
  wrap((req, res) => {
    const { from_user_id, to_user_id } = parseBody(
      z.object({ from_user_id: z.number().int().positive(), to_user_id: z.number().int().positive() }),
      req.body,
    );
    if (from_user_id === to_user_id) throw badRequest('交接人不能是同一人');
    if (!get(`SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0`, to_user_id)) throw notFound('接手员工不存在');
    const result = tx(() => {
      const creators = all<{ id: number }>(`SELECT id FROM creator WHERE owner_id = ? AND pool_status IN (2,3) AND is_deleted = 0`, from_user_id);
      for (const c of creators) update('creator', c.id, { owner_id: to_user_id } as never);
      const collabs = all<{ id: number }>(`SELECT id FROM collaboration WHERE owner_id = ? AND status NOT IN (6,8) AND is_deleted = 0`, from_user_id);
      for (const c of collabs) update('collaboration', c.id, { owner_id: to_user_id } as never);
      run(`UPDATE creator_outreach SET user_id = ? WHERE user_id = ? AND result NOT IN (5,6)`, to_user_id, from_user_id);
      return { creators: creators.length, collabs: collabs.length };
    });
    writeOpLog({ user_id: current(req).id, module: '达人中心', action: 'update', target_table: 'creator', after: { from_user_id, to_user_id, ...result }, ip: req.ip });
    ok(res, result);
  }),
);

/** 菜单权限元数据（前端渲染菜单用） */
systemRouter.get('/menus', wrap((req, res) => {
  const u = current(req);
  ok(res, { menus: MENU_KEYS, perms: u.menu_perms, can_see_cost: u.can_see_cost, can_export: u.can_export, can_see_contact: u.can_see_contact, data_scope: u.data_scope, shop_ids: u.shop_ids });
}));

/* ==================== 后台任务队列（表即队列，选项 7） ==================== */
/**
 * 重活（一键全量补跑、宽表重建、规则评估）以前是「HTTP 请求里同步跑完」：
 * 请求一直挂着，浏览器超时、代理断连、进程重启就丢一次执行，且没有任何状态可查。
 * 现在提供入队 / 查状态 / 手动催一轮三个接口，菜单一律 system。
 */
export const jobRouter = Router();

const jobBody = z.object({
  job_type: z.enum(['sync_run', 'analytics_rebuild', 'rules_evaluate']),
  payload: z.record(z.unknown()).default({}),
  run_after: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/, 'run_after 需用 YYYY-MM-DD HH:MM:SS').optional(),
});

const parseJson = (v: unknown): unknown => {
  if (v === null || v === undefined || v === '') return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

const jobView = (row: Record<string, unknown> | null) =>
  row && {
    ...row,
    payload: parseJson(row.payload_json),
    result: parseJson(row.result_json),
    // 任务失败原因可能带上游报错，出口前一律脱敏
    error_msg: row.error_msg ? maskError(String(row.error_msg)) : null,
  };

jobRouter.get('/', requireMenu('system'), wrap((req, res) => {
  const status = qv(req, 'status');
  ok(res, listJobs(status === '' ? null : Number(status)).map((r) => jobView(r as unknown as Record<string, unknown>)));
}));

jobRouter.get('/:id', requireMenu('system'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('任务 ID 不合法');
  const row = getJob(id);
  if (!row) throw notFound('任务不存在');
  ok(res, jobView(row as unknown as Record<string, unknown>));
}));

jobRouter.post('/', requireMenu('system'), wrap((req, res) => {
  const user = current(req);
  const body = parseBody(jobBody, req.body ?? {});
  const payload = { ...(body.payload as Record<string, unknown>), user_id: user.id };
  const id = enqueueJob(body.job_type, payload, { createdBy: user.id, runAfter: body.run_after });
  writeOpLog({ user_id: user.id, module: '系统设置', action: 'create', target_table: 'job_queue', target_id: id, after: { job_type: body.job_type, payload }, ip: req.ip });
  ok(res, { id, status: 0 }, `任务 #${id} 已入队`);
}));

/** 手动催一轮：把到点的任务跑掉（生产由调度器每分钟一次，这里给运维与测试用） */
jobRouter.post('/drain', requireMenu('system'), wrap(async (req, res) => {
  const user = current(req);
  const stale = requeueStaleJobs();
  const out = await drainJobs(config.jobBatchSize, `http#${user.id}`);
  ok(res, { requeued_stale: stale, ...out });
}));
systemRouter.use('/jobs', jobRouter);
