import { Router } from 'express';
import { z } from 'zod';
import {
  COLLAB_STATUS,
  DATA_SCOPE,
  OUTREACH_RESULT,
  POOL_STATUS,
  SAMPLE_STATUS,
  buildCollabNo,
  normalizeHandle,
  num,
  round2,
  unitCostCny,
  type CurrentUser,
} from '@tk/shared';
import { config } from '../config.js';
import { all, get, insert, run, scalar, softDelete, tx, update, type SqlParam } from '../core/db.js';
import { AppError, badRequest, forbidden, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryList, queryPage, toParam } from '../core/query.js';
import { maskFields, personScope, requireMenu, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, writeOpLog } from '../core/oplog.js';
import {
  checkOverdueSamples,
  markCollabPublished,
  nowStr,
  plusDays,
  releaseExpiredCreators,
  renewProtectUntil,
  today,
  tsOf,
} from '../services/creator/protect.js';
import {
  bdPerformance,
  exchangeRate,
  funnelCounts,
  resolvePeriod,
  roiByCollab,
  roiByCreator,
  type PeriodRange,
} from '../services/creator/roi.js';
import { OVERDUE_COLLAB_WHERE } from '../jobs/creatorJobs.js';

/* ====================================================================
 * 达人中心（方案 5.3 表 9-12 + 6.1 闭环 + 8.1/8.2 权限）
 * 挂载点：/api/creators
 * ==================================================================== */

export const creatorRouter = Router();

const current = (req: object): CurrentUser => (req as AuthedRequest).user;
const conflict = (msg: string): AppError => new AppError(409, msg, 40901);
/** 写权限：达人中心菜单（读接口只受数据范围 + 字段脱敏约束，供内容/BD 跨模块取数） */
const canWrite = requireMenu('creator');

const CONTACT_FIELDS = ['email', 'whatsapp'];
const COST_FIELDS = ['fixed_fee', 'fee_cny', 'sample_cost', 'shipping_cost'];
const ROI_COST_FIELDS = ['gmv_cny', 'refund_cny', 'net_gmv_cny', 'sample_cost', 'sample_shipping', 'fixed_fee_cny', 'commission_cny', 'cost', 'roi'];

/**
 * core 的 scope 片段（creatorScope / personScope / shopScope）自带前导 "AND "，
 * 用于裸拼 WHERE；喂给 Q 时必须去前缀，否则 Q 会再拼一次 AND 造成语法错误。
 */
const condOf = (sql: string): string => sql.replace(/^\s*AND\s+/i, '');

/**
 * 喂给 services/creator/roi.ts 的期间：该服务的 periodWhere(col, p, 'AND') 在
 * from / to 为空串（period=all）时会留下悬空的 `AND`，导致 SQLite 语法错误。
 * 服务层文件不在本模块可改范围，故在路由层把「不限」归一为全量日期边界（语义等价）。
 */
const PERIOD_MIN = '1970-01-01';
const PERIOD_MAX = '9999-12-31';
const safePeriod = (p: PeriodRange): PeriodRange => ({ from: p.from || PERIOD_MIN, to: p.to || PERIOD_MAX, days: p.days });

/** 请求体/行数据 → db 参数（undefined 丢弃、null 保留） */
function cols(obj: Record<string, unknown>): Record<string, SqlParam> {
  const out: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') out[k] = v as SqlParam;
    else out[k] = String(v);
  }
  return out;
}

const intOf = (v: unknown): number | null => {
  const p = toParam(v);
  if (p === null) return null;
  const n = Number(p);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** 类目标签：前端可传 'a,b' 或 ['a','b']，落库统一逗号文本 */
const tagsText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(',') : null;
};

/** 距今天数（负数 = 已过期）；非日期返回 null */
function daysFromToday(dateText: unknown): number | null {
  const s = String(dateText ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  return Math.round((tsOf(s.slice(0, 10)) - tsOf(today())) / 86_400_000);
}

/**
 * 达人可见范围（方案 8.1）：公海对所有人开放；私海仅本人 / 本组 / 全量角色可见。
 * 其余角色（如仅本人、指定店铺）只能看到公海 + 自己认领的。
 * 黑名单（pool_status=4）是全团队共享的「不参与认领 / 不再联系」名单，
 * 不受归属限制：BD 必须能看到并避开他人拉黑的达人（方案 6.1 防撞单）。
 */
function creatorScope(user: CurrentUser, alias = 'c'): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  const visibleBlacklist = ` OR ${alias}.pool_status = ${POOL_STATUS.BLACKLIST}`;
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return {
      sql: `AND (${alias}.owner_id IS NULL OR ${alias}.owner_id IN (SELECT id FROM sys_user WHERE dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL)${visibleBlacklist})`,
      params: [user.id],
    };
  }
  return { sql: `AND (${alias}.owner_id IS NULL OR ${alias}.owner_id = ?${visibleBlacklist})`, params: [user.id] };
}

/** 联系方式明文条件：can_see_contact 或该达人归属本人（BD 看自己私海） */
function contactAllowed(user: CurrentUser, ownerId: unknown): boolean {
  return user.can_see_contact || (ownerId !== null && ownerId !== undefined && Number(ownerId) === user.id);
}

function decorateCreator(user: CurrentUser, row: Record<string, unknown>): Record<string, unknown> {
  const ownerId = row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id);
  const pool = Number(row.pool_status ?? POOL_STATUS.PUBLIC);
  const masked = maskFields(row, CONTACT_FIELDS, contactAllowed(user, ownerId));
  return {
    ...masked,
    owner_id: ownerId,
    pool_status: pool,
    is_mine: ownerId !== null && ownerId === user.id,
    can_claim: ownerId === null && pool === POOL_STATUS.PUBLIC,
    can_edit: ownerId === null ? true : ownerId === user.id || user.data_scope === DATA_SCOPE.ALL || user.data_scope === DATA_SCOPE.DEPT,
    protect_days_left: daysFromToday(row.protect_until),
  };
}

const creatorSorts: Record<string, string> = {
  followers: 'c.followers',
  avg_views: 'c.avg_views',
  protect_until: 'c.protect_until',
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  handle: 'c.handle',
  id: 'c.id',
};

const orderByOf = (req: Parameters<typeof qv>[0], map: Record<string, string>, def: string): string => {
  const key = qv(req, 'sortBy');
  const col = key ? map[key] : undefined;
  const dir = qv(req, 'sortOrder') === 'asc' ? 'ASC' : 'DESC';
  return col ? `${col} ${dir}, ${Object.values(map)[0] ? 'id DESC' : 'id DESC'}` : def;
};

/* ---------------- 表 9 达人库 creator ---------------- */

const emailLike = z
  .string()
  .trim()
  .max(128)
  .refine((v) => v === '' || /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v), '邮箱格式不正确')
  .nullish();

const creatorBody = z.object({
  handle: z.string().min(2).max(64),
  nickname: z.string().max(100).nullish(),
  region: z.string().max(8).nullish(),
  followers: z.number().int().min(0).default(0),
  category_tags: z.union([z.string().max(200), z.array(z.string().max(50))]).nullish(),
  avg_views: z.number().int().min(0).default(0),
  gmv_level: z.string().max(32).nullish(),
  email: emailLike,
  whatsapp: z.string().max(64).nullish(),
  owner_id: z.number().int().positive().nullish(),
  pool_status: z.number().int().min(1).max(4).nullish(),
  source: z.number().int().min(1).max(4).default(1),
  protect_until: z.string().max(20).nullish(),
});
const creatorPatch = creatorBody.partial().omit({ handle: true }).extend({ handle: z.string().min(2).max(64).optional() });

const creatorListFrom = `creator c LEFT JOIN sys_user u ON u.id = c.owner_id`;
const creatorListSelect = `c.*, u.real_name AS owner_name`;

/**
 * 统一列表。scope=pool 公海 | mine 我的私海 | cooperating 合作中 | blacklist 黑名单 | all（默认，按可见范围）
 * BD 只能看到公海 + 自己私海；他人私海达人在可见范围外，联系方式一律 ***。
 */
creatorRouter.get(
  '/',
  wrap((req, res) => {
    const user = current(req);
    const vis = creatorScope(user);
    const scope = (qv(req, 'scope') ?? 'all').toLowerCase();
    const q = new Q('c.is_deleted = 0').and(condOf(vis.sql), ...vis.params);
    if (scope === 'pool') q.eq('c.pool_status', POOL_STATUS.PUBLIC);
    else if (scope === 'mine') q.and('c.owner_id = ?', user.id).and('c.pool_status <> ?', POOL_STATUS.PUBLIC);
    else if (scope === 'cooperating') q.eq('c.pool_status', POOL_STATUS.COOPERATING);
    else if (scope === 'blacklist') q.eq('c.pool_status', POOL_STATUS.BLACKLIST);
    else if (scope !== 'all') throw badRequest(`scope 不识别：${scope}（可用 pool/mine/cooperating/blacklist/all）`);

    q.like(`c.handle LIKE ? OR c.nickname LIKE ?`, qv(req, 'keyword'))
      .eq('c.region', qv(req, 'region'), false)
      .eq('c.pool_status', qv(req, 'pool_status'))
      .eq('c.owner_id', qv(req, 'owner_id'))
      .eq('c.gmv_level', qv(req, 'gmv_level'), false)
      .eq('c.source', qv(req, 'source'))
      .and('c.followers >= ?', intOf(qv(req, 'followers_min')))
      .and('c.followers <= ?', intOf(qv(req, 'followers_max')))
      .between('c.protect_until', qv(req, 'protect_until_from'), qv(req, 'protect_until_to'))
      .between('c.created_at', qv(req, 'created_from'), qv(req, 'created_to'));
    for (const tag of String(qv(req, 'category_tags') ?? '').split(',')) q.like('c.category_tags LIKE ?', tag.trim());
    if (qv(req, 'no_owner') === '1') q.and('c.owner_id IS NULL');

    const page = queryPage(req, {
      from: creatorListFrom,
      select: creatorListSelect,
      q,
      orderBy: orderByOf(req, creatorSorts, 'c.id DESC'),
    });
    ok(res, { ...page, list: page.list.map((r) => decorateCreator(user, r)) });
  }),
);

/** 新建达人：handle 归一化后按唯一索引去重，重复 409（防撞单的根本） */
creatorRouter.post(
  '/',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(creatorBody, req.body);
    const handle = normalizeHandle(body.handle);
    if (handle.length < 2) throw badRequest('handle 归一化后至少 2 个字符');
    const dup = get<Record<string, unknown>>(`SELECT id, handle, owner_id, pool_status, is_deleted FROM creator WHERE handle = ?`, handle);
    if (dup) {
      throw conflict(
        `达人 @${handle} 已存在（#${Number(dup.id)}，${Number(dup.is_deleted) === 1 ? '已删除档案' : Number(dup.pool_status) === POOL_STATUS.PUBLIC ? '在公海，可直接认领' : '已有归属 BD'}）`,
      );
    }
    const isPublic = Number(body.pool_status ?? 0) === POOL_STATUS.PUBLIC && user.data_scope === DATA_SCOPE.ALL;
    const ownerId = user.data_scope === DATA_SCOPE.ALL ? (body.owner_id ?? null) : user.id;
    const protect = isPublic ? null : (body.protect_until ?? plusDays(config.protectDefaultDays));
    const id = tx(() =>
      insert('creator', cols({
        handle,
        nickname: body.nickname ?? null,
        region: body.region ?? null,
        followers: body.followers ?? 0,
        category_tags: tagsText(body.category_tags),
        avg_views: body.avg_views ?? 0,
        gmv_level: body.gmv_level ?? null,
        email: body.email || null,
        whatsapp: body.whatsapp ?? null,
        owner_id: isPublic ? null : ownerId,
        protect_until: protect,
        pool_status: isPublic ? POOL_STATUS.PUBLIC : ownerId ? POOL_STATUS.PRIVATE : POOL_STATUS.PUBLIC,
        source: body.source ?? 1,
        created_by: user.id,
      })),
    );
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'creator', target_id: id, after: { ...body, handle }, ip: req.ip });
    ok(res, { id, handle, owner_id: isPublic ? null : ownerId, pool_status: isPublic ? POOL_STATUS.PUBLIC : ownerId ? POOL_STATUS.PRIVATE : POOL_STATUS.PUBLIC });
  }),
);

creatorRouter.get(
  '/stats',
  wrap((req, res) => {
    const user = current(req);
    const vis = creatorScope(user);
    const count = (extra: string, ...extraParams: SqlParam[]) =>
      scalar<number>(`SELECT COUNT(*) FROM creator c WHERE c.is_deleted = 0 ${vis.sql} ${extra}`, ...vis.params, ...extraParams);
    const period = safePeriod(resolvePeriod(qv(req, 'period')));
    ok(res, {
      pool: count(`AND c.pool_status = ${POOL_STATUS.PUBLIC}`),
      private: count(`AND c.pool_status = ${POOL_STATUS.PRIVATE}`),
      cooperating: count(`AND c.pool_status = ${POOL_STATUS.COOPERATING}`),
      blacklist: count(`AND c.pool_status = ${POOL_STATUS.BLACKLIST}`),
      new_this_month: count(`AND substr(c.created_at, 1, 7) = substr(date('now'), 1, 7)`),
      content_published: count(`AND EXISTS (SELECT 1 FROM video v WHERE v.is_deleted = 0 AND v.creator_id = c.id)`),
      protect_expiring: count(`AND c.pool_status IN (${POOL_STATUS.PRIVATE}, ${POOL_STATUS.COOPERATING}) AND c.protect_until IS NOT NULL AND c.protect_until <= date('now', '+7 day')`),
      collab_overdue: scalar<number>(
        `SELECT COUNT(*) FROM collaboration l WHERE l.is_deleted = 0 AND l.status = ${COLLAB_STATUS.OVERDUE}`,
      ),
      sample_overdue: scalar<number>(`SELECT COUNT(*) FROM sample_shipment s WHERE s.is_deleted = 0 AND s.status = ${SAMPLE_STATUS.OVERDUE}`),
      to_follow: scalar<number>(
        `SELECT COUNT(DISTINCT o.creator_id) FROM creator_outreach o WHERE o.is_deleted = 0 AND o.next_follow_at IS NOT NULL AND o.next_follow_at <= datetime('now', '+1 day') AND o.result NOT IN (${OUTREACH_RESULT.REJECTED}, ${OUTREACH_RESULT.AGREED})`,
      ),
      funnel: funnelCounts(period),
    });
  }),
);

/** 保护期到期预警：protect_until 距今 <= 7 天且期间无新增跟进 / 无在途合作 */
creatorRouter.get(
  '/expiring',
  wrap((req, res) => {
    const user = current(req);
    const vis = creatorScope(user);
    const days = intOf(qv(req, 'days')) ?? 7;
    const mineOnly = qv(req, 'mine') === '1';
    const rows = all<Record<string, unknown>>(
      `SELECT c.id, c.handle, c.nickname, c.region, c.followers, c.owner_id, c.pool_status, c.protect_until, u.real_name AS owner_name,
              (SELECT COUNT(*) FROM creator_outreach o WHERE o.is_deleted = 0 AND o.creator_id = c.id AND o.contact_time > datetime(c.protect_until, '-7 day')) AS recent_follows,
              (SELECT COUNT(*) FROM collaboration l WHERE l.is_deleted = 0 AND l.creator_id = c.id AND l.status NOT IN (${COLLAB_STATUS.FINISHED}, ${COLLAB_STATUS.CANCELLED}, ${COLLAB_STATUS.OVERDUE})) AS ongoing_collabs
         FROM creator c LEFT JOIN sys_user u ON u.id = c.owner_id
        WHERE c.is_deleted = 0 ${vis.sql}
          AND c.owner_id IS NOT NULL
          AND c.pool_status IN (${POOL_STATUS.PRIVATE}, ${POOL_STATUS.COOPERATING})
          AND c.protect_until IS NOT NULL
          AND c.protect_until <= date('now', ?)
          ${mineOnly ? 'AND c.owner_id = ?' : ''}
        ORDER BY c.protect_until ASC`,
      ...vis.params,
      `+${Math.max(0, days)} day`,
      ...(mineOnly ? [user.id] : []),
    );
    ok(res, {
      days,
      list: rows.map((r) => ({
        ...decorateCreator(user, r),
        days_left: daysFromToday(r.protect_until),
        will_recycle: Number(r.recent_follows ?? 0) === 0 && Number(r.ongoing_collabs ?? 0) === 0,
      })),
      total: rows.length,
    });
  }),
);

/** 手动执行到期回收（主管 / 老板跑全库，BD 只能跑自己名下） */
creatorRouter.post(
  '/recycle-expired',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const manager = user.data_scope === DATA_SCOPE.ALL || user.data_scope === DATA_SCOPE.DEPT;
    const own = manager
      ? undefined
      : all<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 AND owner_id = ?`, user.id).map((r) => r.id);
    const result = releaseExpiredCreators(own);
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      after: { action: 'recycle-expired', released: result.released, ids: result.ids, scope: manager ? 'all' : 'mine' },
      ip: req.ip,
    });
    ok(res, { recycled: result.released, ids: result.ids, handles: result.handles });
  }),
);

const importRow = z.object({
  handle: z.string().min(2).max(64),
  nickname: z.string().max(100).nullish(),
  region: z.string().max(8).nullish(),
  followers: z.union([z.string(), z.number()]).nullish(),
  category_tags: z.union([z.string().max(200), z.array(z.string().max(50))]).nullish(),
  avg_views: z.union([z.string(), z.number()]).nullish(),
  gmv_level: z.string().max(32).nullish(),
  email: emailLike,
  whatsapp: z.string().max(64).nullish(),
  source: z.number().int().min(1).max(4).nullish(),
  owner_username: z.string().max(64).nullish(),
});

/**
 * 批量导入：handle 重复不报错而是合并（补齐缺失字段），非法行进 failed。
 * 新达人落到导入人私海（老板可指定 owner_username 归属他人）。
 */
creatorRouter.post(
  '/batch-import',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const { rows } = parseBody(z.object({ rows: z.array(z.unknown()).min(1, 'rows 不能为空').max(1000, '单次最多 1000 行') }), req.body);
    const seen = new Set<string>();
    let success = 0;
    let merged = 0;
    const failed: { row: number; reason: string }[] = [];
    const detail: { handle: string; action: 'created' | 'merged' }[] = [];

    rows.forEach((raw, idx) => {
      const parsed = importRow.safeParse(raw ?? {});
      if (!parsed.success) {
        failed.push({ row: idx, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const r = parsed.data;
      const handle = normalizeHandle(r.handle);
      if (handle.length < 2) {
        failed.push({ row: idx, reason: 'handle 归一化后为空或过短' });
        return;
      }
      if (seen.has(handle)) {
        failed.push({ row: idx, reason: `本批次内 handle 重复：@${handle}` });
        return;
      }
      seen.add(handle);
      const owner = r.owner_username
        ? user.data_scope === DATA_SCOPE.ALL
          ? get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ? AND is_deleted = 0`, r.owner_username)
          : undefined
        : undefined;
      if (r.owner_username && user.data_scope === DATA_SCOPE.ALL && !owner) {
        failed.push({ row: idx, reason: `owner_username 不存在：${r.owner_username}` });
        return;
      }
      const followers = intOf(r.followers) ?? 0;
      const avgViews = intOf(r.avg_views) ?? 0;
      try {
        tx(() => {
          const exist = get<Record<string, unknown>>(`SELECT * FROM creator WHERE handle = ?`, handle);
          if (exist) {
            if (Number(exist.is_deleted) === 1) {
              failed.push({ row: idx, reason: `@${handle} 档案已被删除，需管理员先恢复` });
              return;
            }
            const patch = cols({
              nickname: r.nickname ?? (exist.nickname ? undefined : null),
              region: r.region ?? (exist.region ? undefined : null),
              followers: followers > 0 ? followers : undefined,
              category_tags: tagsText(r.category_tags) ?? undefined,
              avg_views: avgViews > 0 ? avgViews : undefined,
              gmv_level: r.gmv_level ?? undefined,
              email: r.email || undefined,
              whatsapp: r.whatsapp ?? undefined,
              source: r.source ?? undefined,
              owner_id: owner ? owner.id : undefined,
            });
            if (Object.keys(patch).length) {
              update('creator', Number(exist.id), patch);
              logIfChanged({
                user_id: user.id,
                module: '达人中心',
                action: 'update',
                target_table: 'creator',
                target_id: Number(exist.id),
                before: exist,
                after: { ...exist, ...patch },
                keys: ['nickname', 'region', 'followers', 'category_tags', 'avg_views', 'gmv_level', 'email', 'whatsapp'],
                ip: req.ip,
              });
            }
            merged += 1;
            detail.push({ handle, action: 'merged' });
            return;
          }
          const ownerId = owner ? owner.id : user.data_scope === DATA_SCOPE.ALL ? null : user.id;
          const id = insert('creator', cols({
            handle,
            nickname: r.nickname ?? null,
            region: r.region ?? null,
            followers,
            category_tags: tagsText(r.category_tags),
            avg_views: avgViews,
            gmv_level: r.gmv_level ?? null,
            email: r.email || null,
            whatsapp: r.whatsapp ?? null,
            owner_id: ownerId,
            protect_until: ownerId ? plusDays(config.protectDefaultDays) : null,
            pool_status: ownerId ? POOL_STATUS.PRIVATE : POOL_STATUS.PUBLIC,
            source: r.source ?? 1,
            created_by: user.id,
          }));
          success += 1;
          detail.push({ handle, action: 'created' });
          writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'creator', target_id: id, after: { ...r, handle, batch: true }, ip: req.ip });
        });
      } catch (e) {
        failed.push({ row: idx, reason: e instanceof Error ? e.message : String(e) });
      }
    });

    writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'creator', after: { action: 'batch-import', total: rows.length, success, merged, failed: failed.length }, ip: req.ip });
    ok(res, { total: rows.length, success, merged, failed, detail });
  }),
);

/* ---------------- mock 联盟达人搜索（不访问外网，方案第七章） ---------------- */

interface PlatformCandidate {
  handle: string;
  nickname: string;
  region: string;
  followers: number;
  avg_views: number;
  category_tags: string;
  gmv_level: string;
  source: number;
}

/** 本地联盟广场候选池：离线可复现，字段形态模仿联盟达人广场返回 */
const AFFILIATE_POOL: PlatformCandidate[] = [
  { handle: 'zara.my', nickname: 'Zara Gadget', region: 'MY', followers: 128000, avg_views: 41000, category_tags: '3C数码', gmv_level: 'A', source: 1 },
  { handle: 'dailyhome.ph', nickname: 'Daily Home PH', region: 'PH', followers: 96000, avg_views: 26000, category_tags: '家居生活', gmv_level: 'B', source: 1 },
  { handle: 'runwithleo', nickname: 'Run with Leo', region: 'US', followers: 305000, avg_views: 88000, category_tags: '运动户外', gmv_level: 'A', source: 2 },
  { handle: 'makeupbymei', nickname: 'Mei Makeup', region: 'SG', followers: 74000, avg_views: 19000, category_tags: '美妆个护', gmv_level: 'B', source: 2 },
  { handle: 'kitchen.kaoru', nickname: 'Kaoru Kitchen', region: 'JP', followers: 51000, avg_views: 12000, category_tags: '家居生活', gmv_level: 'C', source: 1 },
  { handle: 'tech.vinh', nickname: 'Tech Vinh', region: 'VN', followers: 212000, avg_views: 54000, category_tags: '3C数码', gmv_level: 'A', source: 3 },
  { handle: 'thoibangiay', nickname: 'Thoi Bank Giay', region: 'VN', followers: 43000, avg_views: 9000, category_tags: '服饰', gmv_level: 'C', source: 3 },
  { handle: 'bangkokdeals', nickname: 'Bangkok Deals', region: 'TH', followers: 168000, avg_views: 37000, category_tags: '家居生活', gmv_level: 'B', source: 1 },
  { handle: 'gogreen.sg', nickname: 'Go Green SG', region: 'SG', followers: 27000, avg_views: 6100, category_tags: '家居生活', gmv_level: 'C', source: 4 },
  { handle: 'jaketking.my', nickname: 'Jaket King', region: 'MY', followers: 88000, avg_views: 21000, category_tags: '服饰', gmv_level: 'B', source: 4 },
  { handle: 'fitfood.ph', nickname: 'Fit Food PH', region: 'PH', followers: 132000, avg_views: 30000, category_tags: '运动户外', gmv_level: 'A', source: 2 },
  { handle: 'unclecharger', nickname: 'Uncle Charger', region: 'US', followers: 460000, avg_views: 121000, category_tags: '3C数码', gmv_level: 'A', source: 1 },
];

/**
 * 平台达人搜索（mock）：候选池 + 本地达人库联合返回，命中已有档案标 already_in_db。
 * 出于联系方式保护，搜索结果永不返回 email / whatsapp。
 */
creatorRouter.get(
  '/search',
  wrap((req, res) => {
    const keyword = (qv(req, 'keyword') ?? '').trim().toLowerCase().replace(/^@+/, '');
    const region = (qv(req, 'region') ?? '').trim().toUpperCase();
    const fMin = intOf(qv(req, 'followers_min')) ?? 0;
    const fMax = intOf(qv(req, 'followers_max')) ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(100, intOf(qv(req, 'limit')) ?? 30);

    const inDb = all<Record<string, unknown>>(
      `SELECT c.id, c.handle, c.nickname, c.region, c.followers, c.avg_views, c.category_tags, c.gmv_level, c.pool_status, c.owner_id, c.source,
              u.real_name AS owner_name
         FROM creator c LEFT JOIN sys_user u ON u.id = c.owner_id
        WHERE c.is_deleted = 0 AND c.pool_status <> ${POOL_STATUS.BLACKLIST}
          AND (c.handle LIKE ? OR c.nickname LIKE ? OR c.category_tags LIKE ?)
          AND c.followers BETWEEN ? AND ?
        ORDER BY c.followers DESC LIMIT ?`,
      `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, fMin, fMax, limit,
    );
    const existing = new Set(inDb.map((r) => String(r.handle)));
    const list: Record<string, unknown>[] = inDb.map((r) => ({
      key: `db-${Number(r.id)}`,
      already_in_db: true,
      creator_id: Number(r.id),
      handle: r.handle,
      nickname: r.nickname,
      region: r.region,
      followers: Number(r.followers),
      avg_views: Number(r.avg_views ?? 0),
      category_tags: r.category_tags,
      gmv_level: r.gmv_level,
      source: Number(r.source ?? 1),
      pool_status: Number(r.pool_status),
      owner_name: r.owner_name,
      email: null,
      whatsapp: null,
    }));

    for (const [i, p] of AFFILIATE_POOL.entries()) {
      if (list.length >= limit) break;
      if (existing.has(p.handle)) continue;
      if (keyword && !p.handle.toLowerCase().includes(keyword) && !p.nickname.toLowerCase().includes(keyword) && !p.category_tags.includes(keyword)) continue;
      if (region && p.region !== region) continue;
      if (p.followers < fMin || p.followers > fMax) continue;
      list.push({
        key: `pf-${i}`,
        already_in_db: false,
        creator_id: null,
        ...p,
        owner_name: null,
        email: null,
        whatsapp: null,
      });
    }
    ok(res, { mode: config.tiktokMode === 'real' ? 'mock(offline fallback)' : 'mock', total: list.length, list });
  }),
);

/** 搜索结果一键入库：:id 支持 pf-<n> 候选键 / db-<id> / 达人数字 ID（已存在则补齐并可选认领） */
creatorRouter.post(
  '/:id/import-from-search',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const param = String(req.params.id ?? '');
    const body = parseBody(creatorBody.partial().extend({ claim: z.boolean().optional() }), req.body);
    const candidate = AFFILIATE_POOL[Number(param.replace(/^pf-/, ''))];
    const useCandidate = param.startsWith('pf-') && !!candidate;
    const target = useCandidate
      ? undefined
      : get<Record<string, unknown>>(`SELECT * FROM creator WHERE handle = ? OR id = ?`, normalizeHandle(param.replace(/^db-/, '')), intOf(param.replace(/^db-/, '')) ?? -1);
    const src: PlatformCandidate | undefined = useCandidate ? candidate : target ? ({
      handle: String(target.handle),
      nickname: (target.nickname as string | null) ?? null as never,
      region: (target.region as string | null) ?? null as never,
      followers: Number(target.followers ?? 0),
      avg_views: Number(target.avg_views ?? 0),
      category_tags: (target.category_tags as string | null) ?? '',
      gmv_level: (target.gmv_level as string | null) ?? '',
      source: Number(target.source ?? 1),
    } as PlatformCandidate) : undefined;

    const handle = normalizeHandle(String(src?.handle ?? param));
    if (!handle) throw badRequest('达人 handle 不能为空');
    const exist = get<Record<string, unknown>>(`SELECT * FROM creator WHERE handle = ? AND is_deleted = 0`, handle);
    if (exist) {
      const ownerId = exist.owner_id === null || exist.owner_id === undefined ? null : Number(exist.owner_id);
      const claim = body.claim ?? true;
      if (claim && ownerId === null && Number(exist.pool_status) === POOL_STATUS.PUBLIC) {
        update('creator', Number(exist.id), cols({
          owner_id: user.id,
          pool_status: POOL_STATUS.PRIVATE,
          protect_until: plusDays(config.protectDefaultDays),
        }));
        writeOpLog({
          user_id: user.id,
          module: '达人中心',
          action: 'update',
          target_table: 'creator',
          target_id: Number(exist.id),
          before: { owner_id: ownerId, pool_status: exist.pool_status, protect_until: exist.protect_until },
          after: { owner_id: user.id, pool_status: POOL_STATUS.PRIVATE, reason: '搜索结果一键入库（已存在 → 认领）' },
          ip: req.ip,
        });
        ok(res, { creator_id: Number(exist.id), handle, action: 'claimed' });
        return;
      }
      ok(res, { creator_id: Number(exist.id), handle, action: 'exists', owner_id: ownerId });
      return;
    }
    const ownerId = user.data_scope === DATA_SCOPE.ALL ? null : user.id;
    const id = insert('creator', cols({
      handle,
      nickname: src?.nickname ?? null,
      region: src?.region ?? null,
      followers: src?.followers ?? 0,
      avg_views: src?.avg_views ?? 0,
      category_tags: tagsText(src?.category_tags ?? '') ?? null,
      gmv_level: src?.gmv_level ?? null,
      owner_id: ownerId,
      protect_until: ownerId ? plusDays(config.protectDefaultDays) : null,
      pool_status: ownerId ? POOL_STATUS.PRIVATE : POOL_STATUS.PUBLIC,
      source: src?.source ?? 1,
      created_by: user.id,
    }));
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'creator', target_id: id, after: { handle, from: 'affiliate-search' }, ip: req.ip });
    ok(res, { creator_id: id, handle, action: 'imported', owner_id: ownerId });
  }),
);

/* ---------------- 表 10 建联跟进 creator_outreach ---------------- */

const outreachBody = z.object({
  creator_id: z.number().int().positive(),
  /** 10 秒一条：除达人 + 结果外全部可空 */
  result: z.number().int().min(1).max(6).default(OUTREACH_RESULT.NO_REPLY),
  channel: z.number().int().min(1).max(4).default(1),
  contact_time: z.string().max(20).nullish(),
  summary: z.string().max(500).nullish(),
  next_follow_at: z.string().max(20).nullish(),
});

const outreachFrom = `creator_outreach o
     JOIN creator c ON c.id = o.creator_id
     LEFT JOIN sys_user u ON u.id = o.user_id`;
const outreachSelect = `o.*, c.handle AS creator_handle, c.nickname AS creator_nickname, c.pool_status, c.owner_id AS creator_owner_id, u.real_name AS user_name`;

function outreachQuery(req: Parameters<typeof qv>[0], user: CurrentUser): Q {
  const q = new Q('o.is_deleted = 0');
  const group = qv(req, 'group') === 'true' || qv(req, 'group') === '1';
  const scope = qv(req, 'user_id') ? { sql: '', params: [] as number[] } : group ? personScope(user, 'o.user_id', true) : { sql: `AND o.user_id = ?`, params: [user.id] };
  q.and(condOf(scope.sql), ...scope.params);
  if (qv(req, 'all') === '1' && !qv(req, 'user_id')) q.and(condOf(personScope(user, 'o.user_id', true).sql), ...personScope(user, 'o.user_id', true).params);
  return q
    .eq('o.creator_id', qv(req, 'creator_id'))
    .eq('o.user_id', qv(req, 'user_id'))
    .eq('o.channel', qv(req, 'channel'))
    .eq('o.result', qv(req, 'result'))
    .between('o.contact_time', qv(req, 'contact_time_from'), qv(req, 'contact_time_to'))
    .like(`c.handle LIKE ? OR o.summary LIKE ?`, qv(req, 'keyword'));
}

/** 全局跟进列表（默认只看本人，group=true 看本组 / 老板看全部） */
creatorRouter.get(
  '/outreach',
  wrap((req, res) =>
    ok(res, queryPage(req, {
      from: outreachFrom,
      select: outreachSelect,
      q: outreachQuery(req, current(req)),
      orderBy: 'o.contact_time DESC, o.id DESC',
    })),
  ),
);

/** 到点待跟进：next_follow_at 距今 <= 24h，本人的排前面 */
creatorRouter.get(
  '/outreach/due',
  wrap((req, res) => {
    const user = current(req);
    const hours = intOf(qv(req, 'hours')) ?? 24;
    const group = qv(req, 'group') === 'true' || qv(req, 'group') === '1';
    const scope = group ? personScope(user, 'o.user_id', true) : { sql: '', params: [] as number[] };
    const limit = Math.min(200, intOf(qv(req, 'limit')) ?? 100);
    const list = all<Record<string, unknown>>(
      `SELECT ${outreachSelect},
              (SELECT COUNT(*) FROM creator_outreach x WHERE x.is_deleted = 0 AND x.creator_id = o.creator_id) AS follow_times
         FROM ${outreachFrom}
        WHERE o.is_deleted = 0 AND o.next_follow_at IS NOT NULL
          AND o.next_follow_at <= datetime('now', ?)
          AND o.result NOT IN (${OUTREACH_RESULT.REJECTED})
          ${scope.sql}
        ORDER BY (CASE WHEN o.user_id = ? THEN 0 ELSE 1 END), o.next_follow_at ASC
        LIMIT ?`,
      `+${Math.max(1, hours)} hour`, ...scope.params, user.id, limit,
    );
    ok(res, { hours, list, total: list.length });
  }),
);

/**
 * 新增跟进：自动 user_id = 当前用户、contact_time = now；
 * 随后为达人续期保护期（+7 天），公海达人自动转入本人私海（视为已建联）。
 */
creatorRouter.post(
  '/outreach',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(outreachBody, req.body);
    const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, body.creator_id);
    if (!creator) throw notFound('达人不存在');
    if (Number(creator.pool_status) === POOL_STATUS.BLACKLIST) throw forbidden('黑名单达人不能新建跟进');
    const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
    if (ownerId !== null && ownerId !== user.id && !inManageScope(user, creator)) {
      throw forbidden(`该达人已在 @${String(creator.handle)} 的他人私海，请先联系主管转交`);
    }

    const result = tx(() => {
      const id = insert('creator_outreach', cols({
        creator_id: body.creator_id,
        user_id: user.id,
        channel: body.channel ?? 1,
        contact_time: body.contact_time || nowStr(),
        summary: body.summary ?? null,
        result: body.result ?? OUTREACH_RESULT.NO_REPLY,
        next_follow_at: body.next_follow_at ?? null,
        created_by: user.id,
      }));
      // 公海有跟进 → 直接进跟进人私海；已有归属 → 保护期续到 max(现有, today+7)
      const before = { owner_id: ownerId, pool_status: creator.pool_status, protect_until: creator.protect_until };
      const patch = cols({
        owner_id: ownerId === null ? user.id : ownerId,
        pool_status: Number(creator.pool_status) === POOL_STATUS.PUBLIC ? POOL_STATUS.PRIVATE : Number(creator.pool_status),
        protect_until: renewProtectUntil(creator.protect_until, 7),
      });
      update('creator', body.creator_id, patch);
      writeOpLog({
        user_id: user.id,
        module: '达人中心',
        action: 'create',
        target_table: 'creator_outreach',
        target_id: id,
        after: body,
        ip: req.ip,
      });
      if (before.owner_id !== patch.owner_id || String(before.protect_until) !== String(patch.protect_until) || before.pool_status !== patch.pool_status) {
        writeOpLog({
          user_id: user.id,
          module: '达人中心',
          action: 'update',
          target_table: 'creator',
          target_id: body.creator_id,
          before,
          after: { ...patch, reason: '建联跟进自动续期 / 公海转私海' },
          ip: req.ip,
        });
      }
      return id;
    });
    const after = get<Record<string, unknown>>(`SELECT owner_id, pool_status, protect_until FROM creator WHERE id = ?`, body.creator_id);
    ok(res, {
      id: result,
      creator: after,
      hint: Number(body.result) === OUTREACH_RESULT.AGREED ? '结果=谈妥，请尽快创建合作单（POST /creators/collab）' : null,
    });
  }),
);

creatorRouter.put(
  '/outreach/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM creator_outreach WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('跟进记录不存在');
    if (Number(before.user_id) !== user.id && !isManager(user)) throw forbidden('只能修改本人的跟进记录（主管可改本组）');
    const body = parseBody(outreachBody.partial().omit({ creator_id: true }), req.body);
    update('creator_outreach', id, cols(body));
    logIfChanged({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator_outreach',
      target_id: id,
      before,
      after: { ...before, ...body },
      keys: ['channel', 'contact_time', 'summary', 'result', 'next_follow_at'],
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

creatorRouter.delete(
  '/outreach/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM creator_outreach WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('跟进记录不存在');
    if (Number(row.user_id) !== user.id && !isManager(user)) throw forbidden('只能删除本人的跟进记录（主管可删本组）');
    softDelete('creator_outreach', id);
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'delete', target_table: 'creator_outreach', target_id: id, before: row, ip: req.ip });
    ok(res, { id });
  }),
);

function isManager(user: CurrentUser): boolean {
  return user.data_scope === DATA_SCOPE.ALL || user.data_scope === DATA_SCOPE.DEPT || user.role_key === 'boss';
}

/** 达人是否在我的可管理范围内（本人 / 本组 / 全量） */
function inManageScope(user: CurrentUser, creator: Record<string, unknown>): boolean {
  const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
  if (ownerId === null || ownerId === user.id) return true;
  if (user.data_scope === DATA_SCOPE.ALL) return true;
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return !!get(`SELECT 1 FROM sys_user WHERE id = ? AND dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL`, ownerId, user.id);
  }
  return false;
}

/* ---------------- 表 11 合作单 collaboration ---------------- */

const collabBody = z.object({
  creator_id: z.number().int().positive(),
  shop_id: z.number().int().positive(),
  spu_id: z.number().int().positive().nullish(),
  coop_type: z.number().int().min(1).max(4).default(1),
  commission_rate: z.number().min(0).max(100).default(0),
  fixed_fee: z.number().min(0).default(0),
  fee_currency: z.string().length(3).default('USD'),
  promised_videos: z.number().int().min(0).default(0),
  promised_lives: z.number().int().min(0).default(0),
  deadline: z.string().max(20).nullish(),
  tk_plan_id: z.string().max(64).nullish(),
  owner_id: z.number().int().positive().nullish(),
});

function collabScope(user: CurrentUser, alias = 'l'): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  if (user.data_scope === DATA_SCOPE.DEPT) return personScope(user, `${alias}.owner_id`, true);
  if (user.data_scope === DATA_SCOPE.SHOPS) {
    if (!user.shop_ids.length) return { sql: `AND ${alias}.owner_id = ?`, params: [user.id] };
    return {
      sql: `AND (${alias}.shop_id IN (${user.shop_ids.map(() => '?').join(',')}) OR ${alias}.owner_id = ?)`,
      params: [...user.shop_ids, user.id],
    };
  }
  return { sql: `AND ${alias}.owner_id = ?`, params: [user.id] };
}

const collabFrom = `collaboration l
     JOIN creator c ON c.id = l.creator_id
     LEFT JOIN tk_shop s ON s.id = l.shop_id
     LEFT JOIN product_spu p ON p.id = l.spu_id
     LEFT JOIN sys_user u ON u.id = l.owner_id`;
const collabSelect = `l.*, c.handle AS creator_handle, c.nickname AS creator_nickname, c.region, c.pool_status AS creator_pool_status,
       s.shop_name, s.currency AS shop_currency, p.name_cn AS spu_name, p.spu_code AS spu_code, u.real_name AS owner_name,
       (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 AND v.collab_id = l.id) AS video_count,
       (SELECT COUNT(*) FROM sample_shipment sm WHERE sm.is_deleted = 0 AND sm.collab_id = l.id) AS sample_count,
       (SELECT COALESCE(SUM(e.amount_cny), 0) FROM expense e WHERE e.is_deleted = 0 AND e.expense_type = 1 AND e.ref_type = 'collaboration' AND e.ref_id = l.id) AS fee_cny`;

function decorateCollab(user: CurrentUser, row: Record<string, unknown>): Record<string, unknown> {
  const out = maskFields(row, COST_FIELDS, user.can_see_cost);
  const promised = Number(row.promised_videos ?? 0);
  const videos = Number(row.video_count ?? 0);
  return { ...out, publish_ok: promised > 0 ? videos >= promised : null, videos_gap: Math.max(0, promised - videos) };
}

function loadCollab(id: number, user: CurrentUser): Record<string, unknown> {
  const row = get<Record<string, unknown>>(
    `SELECT ${collabSelect} FROM ${collabFrom} WHERE l.id = ? AND l.is_deleted = 0`,
    id,
  );
  if (!row) throw notFound('合作单不存在');
  const scope = collabScope(user);
  if (scope.sql) {
    const cond = new Q('l.id = ? AND l.is_deleted = 0', id).and(condOf(scope.sql), ...scope.params);
    const hit = get(`SELECT l.id FROM ${collabFrom}${cond.whereSql}`, ...cond.params);
    if (!hit) throw forbidden('该合作单不在你的数据范围内');
  }
  return row;
}

/** 合作单列表：JOIN 达人 handle / 店铺名 / SPU 名 / 负责 BD，附视频数与寄样数 */
creatorRouter.get(
  '/collab',
  wrap((req, res) => {
    const user = current(req);
    const scope = collabScope(user);
    const q = new Q('l.is_deleted = 0').and(condOf(scope.sql), ...scope.params);
    q.eq('l.creator_id', qv(req, 'creator_id'))
      .eq('l.shop_id', qv(req, 'shop_id'))
      .eq('l.spu_id', qv(req, 'spu_id'))
      .eq('l.status', qv(req, 'status'))
      .eq('l.coop_type', qv(req, 'coop_type'))
      .eq('l.owner_id', qv(req, 'owner_id'))
      .between('l.deadline', qv(req, 'deadline_from'), qv(req, 'deadline_to'))
      .between('l.created_at', qv(req, 'created_from'), qv(req, 'created_to'))
      .like(`l.collab_no LIKE ? OR c.handle LIKE ? OR c.nickname LIKE ? OR s.shop_name LIKE ?`, qv(req, 'keyword'));
    const page = queryPage(req, {
      from: collabFrom,
      select: collabSelect,
      q,
      orderBy: orderByOf(req, { deadline: 'l.deadline', status: 'l.status', fixed_fee: 'l.fixed_fee', commission_rate: 'l.commission_rate', created_at: 'l.created_at', id: 'l.id' }, 'l.id DESC'),
    });
    ok(res, { ...page, list: page.list.map((r) => decorateCollab(user, r)) });
  }),
);

/** 新建合作单：达人必须在本人 / 本组私海；成功后达人转「合作中」 */
creatorRouter.post(
  '/collab',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(collabBody, req.body);
    const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, body.creator_id);
    if (!creator) throw notFound('达人不存在');
    const pool = Number(creator.pool_status);
    if (pool === POOL_STATUS.PUBLIC) throw forbidden(`达人 @${String(creator.handle)} 还在公海，请先认领再建合作单`);
    if (pool === POOL_STATUS.BLACKLIST) throw forbidden('黑名单达人不能创建合作单');
    if (!inManageScope(user, creator)) throw forbidden(`达人 @${String(creator.handle)} 不在你或你本组的私海，不能建合作单`);
    if (body.coop_type !== 1 && Number(body.fixed_fee) === 0 && body.coop_type === 2) throw badRequest('坑位费 + 佣金模式下 fixed_fee 必须大于 0');
    const shop = get<Record<string, unknown>>(`SELECT id, shop_name, is_deleted FROM tk_shop WHERE id = ?`, body.shop_id);
    if (!shop || Number(shop.is_deleted) === 1) throw notFound('合作店铺不存在');
    if (body.spu_id && !get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, body.spu_id)) throw notFound('SPU 不存在');

    const ownerId = user.data_scope === DATA_SCOPE.ALL ? (body.owner_id ?? (creator.owner_id as number | null) ?? user.id) : ((creator.owner_id as number | null) ?? user.id);
    const { id, collab_no } = tx(() => {
      const seq = nextCollabSeq();
      const no = buildCollabNo(new Date(), seq);
      const newId = insert('collaboration', cols({
        ...body,
        collab_no: no,
        owner_id: ownerId,
        status: COLLAB_STATUS.AGREED,
        created_by: user.id,
      }));
      const before = { owner_id: creator.owner_id, pool_status: creator.pool_status };
      update('creator', body.creator_id, cols({ owner_id: ownerId, pool_status: POOL_STATUS.COOPERATING }));
      writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'collaboration', target_id: newId, after: { ...body, collab_no: no }, ip: req.ip });
      writeOpLog({
        user_id: user.id,
        module: '达人中心',
        action: 'update',
        target_table: 'creator',
        target_id: body.creator_id,
        before,
        after: { owner_id: ownerId, pool_status: POOL_STATUS.COOPERATING, reason: `建合作单 ${no}` },
        ip: req.ip,
      });
      return { id: newId, collab_no: no };
    });
    ok(res, { id, collab_no, creator_pool_status: POOL_STATUS.COOPERATING });
  }),
);

/** 当天合作单序号：CB<YYYYMMDD>-<4 位>，冲突自动顺延（buildCollabNo 生成） */
function nextCollabSeq(): number {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let seq = scalar<number>(`SELECT COUNT(*) + 1 FROM collaboration WHERE collab_no LIKE ?`, `CB${stamp}-%`);
  while (get(`SELECT id FROM collaboration WHERE collab_no = ?`, buildCollabNo(new Date(), seq))) seq += 1;
  return seq;
}

/** 超期未履约清单：deadline 已过且视频数未达约定（不区分是否已被作业置 7） */
creatorRouter.get(
  '/collab/overdue',
  wrap((req, res) => {
    const user = current(req);
    const scope = collabScope(user);
    const q = new Q(`1 = 1`).and(condOf(scope.sql), ...scope.params);
    const rows = all<Record<string, unknown>>(
      `SELECT ${collabSelect} FROM ${collabFrom}
        WHERE ${OVERDUE_COLLAB_WHERE} ${q.whereSql.replace(/^ WHERE/, 'AND')}
        ORDER BY l.deadline ASC LIMIT ?`,
      ...q.params,
      Math.min(500, intOf(qv(req, 'limit')) ?? 200),
    );
    ok(res, {
      list: rows.map((r) => ({ ...decorateCollab(user, r), overdue_days: -(daysFromToday(r.deadline) ?? 0) })),
      total: rows.length,
      job: 'flagOverdueCollabs()',
    });
  }),
);

creatorRouter.get(
  '/collab/:id',
  wrap((req, res) => {
    const user = current(req);
    const row = loadCollab(Number(req.params.id), user);
    const roi = roiByCollab(Number(req.params.id));
    ok(res, { ...decorateCollab(user, row), roi: user.can_see_cost ? roi : maskFields(roi ?? {}, ROI_COST_FIELDS, false) });
  }),
);

creatorRouter.put(
  '/collab/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = loadCollab(id, user);
    const body = parseBody(collabBody.partial().omit({ creator_id: true, shop_id: true }), req.body);
    if (body.owner_id !== undefined && Number(body.owner_id) !== Number(before.owner_id) && !isManager(user)) {
      throw forbidden('只有主管 / 老板可以变更合作单负责 BD');
    }
    update('collaboration', id, cols(body));
    const keys = ['commission_rate', 'fixed_fee', 'fee_currency', 'promised_videos', 'promised_lives', 'deadline', 'tk_plan_id', 'coop_type', 'owner_id', 'status'];
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'collaboration',
      target_id: id,
      before: Object.fromEntries(keys.map((k) => [k, before[k]])),
      after: { ...before, ...body },
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/**
 * 状态流转：1 已谈妥 → 2 待寄样 → 3 样品在途 → 4 待发布 → 5 已发布 → 6 已完结；
 * 任意非终态可跳 7 超期未履约 / 8 取消（取消需主管），其余一律 400。
 */
const COLLAB_FLOW: Record<number, number[]> = {
  [COLLAB_STATUS.AGREED]: [COLLAB_STATUS.TO_SHIP, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.TO_SHIP]: [COLLAB_STATUS.IN_TRANSIT, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.IN_TRANSIT]: [COLLAB_STATUS.TO_PUBLISH, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.TO_PUBLISH]: [COLLAB_STATUS.PUBLISHED, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.PUBLISHED]: [COLLAB_STATUS.FINISHED, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.FINISHED]: [],
  [COLLAB_STATUS.OVERDUE]: [COLLAB_STATUS.PUBLISHED, COLLAB_STATUS.FINISHED, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.CANCELLED]: [],
};

creatorRouter.post(
  '/collab/:id/status',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadCollab(id, user);
    const body = parseBody(z.object({ status: z.number().int().min(1).max(8), remark: z.string().max(200).nullish() }), req.body);
    const from = Number(row.status);
    const to = body.status;
    if (from === to) throw badRequest(`合作单已处于该状态（${to}）`);
    if (!isManager(user) && user.role_key !== 'boss' && to === COLLAB_STATUS.CANCELLED) throw forbidden('取消合作单需要主管 / 老板权限');
    if (!(COLLAB_FLOW[from] ?? []).includes(to)) {
      throw badRequest(`非法状态流转：${from} → ${to}（允许：${(COLLAB_FLOW[from] ?? []).join('/') || '无，已是终态'}）`);
    }
    update('collaboration', id, cols({ status: to }));
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'collaboration',
      target_id: id,
      before: { status: from },
      after: { status: to, remark: body.remark ?? null },
      ip: req.ip,
    });
    ok(res, { id, status: to });
  }),
);

/** 坑位费一键生成待付款费用行（幂等：同 ref_type + ref_id 已存在则不重复建） */
creatorRouter.post(
  '/collab/:id/expense',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadCollab(id, user);
    const fee = num(row.fixed_fee);
    if (fee <= 0) throw badRequest('该合作单坑位费为 0，无需生成费用');
    const existed = get<Record<string, unknown>>(
      `SELECT id, amount, currency, amount_cny FROM expense WHERE is_deleted = 0 AND expense_type = 1 AND ref_type = 'collaboration' AND ref_id = ?`,
      id,
    );
    if (existed) {
      ok(res, { expense_id: Number(existed.id), existed: true, amount: existed.amount, currency: existed.currency, amount_cny: existed.amount_cny });
      return;
    }
    const date = today();
    const currency = String(row.fee_currency ?? 'USD');
    const rate = exchangeRate(currency, date);
    const amount_cny = round2(fee * rate);
    const expenseId = insert('expense', cols({
      expense_date: date,
      expense_type: 1,
      shop_id: row.shop_id,
      ref_type: 'collaboration',
      ref_id: id,
      amount: fee,
      currency,
      amount_cny,
      payee: `达人 ${String(row.creator_handle ?? '')}`,
      status: 1,
      remark: `合作单 ${String(row.collab_no)} 坑位费`,
      created_by: user.id,
    }));
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'create',
      target_table: 'expense',
      target_id: expenseId,
      after: { ref_type: 'collaboration', ref_id: id, amount: fee, currency, rate_to_cny: rate, amount_cny },
      ip: req.ip,
    });
    ok(res, { expense_id: expenseId, existed: false, amount: fee, currency, rate_to_cny: rate, amount_cny, status: 1 });
  }),
);

/** 单个合作投产比 + 发布达标（净 GMV ÷（样品 + 运费 + 坑位费 + 佣金）） */
creatorRouter.get(
  '/collab/:id/roi',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadCollab(id, user);
    const period: PeriodRange = qv(req, 'period') ? resolvePeriod(qv(req, 'period')) : { from: '', to: '', days: 0 };
    const roi = roiByCollab(id, period);
    if (!roi) throw notFound('合作单不存在');
    const videos = Number(row.video_count ?? 0);
    const promised = Number(row.promised_videos ?? 0);
    const payload: Record<string, unknown> = {
      ...roi,
      promised_videos: promised,
      promised_lives: Number(row.promised_lives ?? 0),
      video_count: videos,
      publish_ok: promised > 0 ? videos >= promised : null,
      deadline: row.deadline,
      status: row.status,
      formula: '净 GMV(CNY) ÷（样品成本 + 寄样运费 + 坑位费(CNY) + 达人佣金(CNY)）',
    };
    ok(res, user.can_see_cost ? payload : maskFields(payload, ROI_COST_FIELDS, false));
  }),
);

/* ---------------- 表 12 寄样 sample_shipment ---------------- */

const sampleBody = z.object({
  collab_id: z.number().int().positive().nullish(),
  creator_id: z.number().int().positive(),
  sku_id: z.number().int().positive().nullish(),
  quantity: z.number().int().min(1).default(1),
  shipping_cost: z.number().min(0).default(0),
  ship_method: z.number().int().min(1).max(3).default(2),
  tk_order_id: z.string().max(64).nullish(),
  tracking_no: z.string().max(64).nullish(),
  ship_time: z.string().max(20).nullish(),
  sign_time: z.string().max(20).nullish(),
  sample_cost: z.number().min(0).nullish(),
  status: z.number().int().min(1).max(6).nullish(),
});

const sampleFrom = `sample_shipment sm
     JOIN creator c ON c.id = sm.creator_id
     LEFT JOIN collaboration l ON l.id = sm.collab_id
     LEFT JOIN product_sku sk ON sk.id = sm.sku_id
     LEFT JOIN product_spu p ON p.id = sk.spu_id
     LEFT JOIN sys_user u ON u.id = sm.created_by`;
const sampleSelect = `sm.*, c.handle AS creator_handle, c.nickname AS creator_nickname, c.owner_id AS creator_owner_id,
       l.collab_no, l.status AS collab_status, l.promised_videos, sk.sku_code, p.name_cn AS spu_name, u.real_name AS created_by_name,
       (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 AND (v.collab_id = sm.collab_id OR (sm.collab_id IS NULL AND v.creator_id = sm.creator_id))) AS video_count`;

function decorateSample(user: CurrentUser, row: Record<string, unknown>): Record<string, unknown> {
  const out = maskFields(row, COST_FIELDS, user.can_see_cost);
  const sign = String(row.sign_time ?? '');
  return {
    ...out,
    due_days: config.sampleContentDueDays,
    due_date: /^\d{4}-\d{2}-\d{2}/.test(sign) ? plusDays(config.sampleContentDueDays, new Date(`${sign.slice(0, 10)}T00:00:00Z`)) : null,
  };
}

function advanceCollab(collabId: unknown, to: number, user: CurrentUser): void {
  const id = Number(collabId);
  if (!id || Number.isNaN(id)) return;
  const row = get<{ status: number }>(`SELECT status FROM collaboration WHERE id = ? AND is_deleted = 0`, id);
  if (!row) return;
  if (to > Number(row.status) && Number(row.status) < COLLAB_STATUS.PUBLISHED) {
    update('collaboration', id, cols({ status: to }));
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'update', target_table: 'collaboration', target_id: id, before: { status: row.status }, after: { status: to, reason: '寄样流程自动推进' } });
  }
}

/** 寄样列表（超期判定：status=3 已签收且 sign_time + sampleContentDueDays 已过且无关联视频） */
creatorRouter.get(
  '/sample',
  wrap((req, res) => {
    const user = current(req);
    const vis = creatorScope(user, 'c');
    const q = new Q('sm.is_deleted = 0').and(condOf(vis.sql), ...vis.params);
    q.eq('sm.status', qv(req, 'status'))
      .eq('sm.creator_id', qv(req, 'creator_id'))
      .eq('sm.collab_id', qv(req, 'collab_id'))
      .eq('sm.ship_method', qv(req, 'ship_method'))
      .eq('sm.sku_id', qv(req, 'sku_id'))
      .between('sm.ship_time', qv(req, 'ship_time_from'), qv(req, 'ship_time_to'))
      .between('sm.sign_time', qv(req, 'sign_time_from'), qv(req, 'sign_time_to'))
      .like(`c.handle LIKE ? OR l.collab_no LIKE ? OR sm.tracking_no LIKE ? OR sk.sku_code LIKE ?`, qv(req, 'keyword'));
    if (qv(req, 'overdue') === '1') {
      q.and(`sm.status = ${SAMPLE_STATUS.SIGNED} AND sm.sign_time IS NOT NULL AND date(sm.sign_time, ?) < date('now')`, `+${config.sampleContentDueDays} day`);
    }
    const page = queryPage(req, {
      from: sampleFrom,
      select: sampleSelect,
      q,
      orderBy: orderByOf(req, { sign_time: 'sm.sign_time', ship_time: 'sm.ship_time', status: 'sm.status', id: 'sm.id' }, 'sm.id DESC'),
    });
    ok(res, { ...page, list: page.list.map((r) => decorateSample(user, r)) });
  }),
);

/** 新增寄样：自动取 SKU 成本快照（unitCostCny × 数量，人民币），发货信息齐了自动置在途 */
creatorRouter.post(
  '/sample',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(sampleBody, req.body);
    const creator = get<Record<string, unknown>>(`SELECT id, handle, pool_status, owner_id FROM creator WHERE id = ? AND is_deleted = 0`, body.creator_id);
    if (!creator) throw notFound('达人不存在');
    if (Number(creator.pool_status) === POOL_STATUS.PUBLIC) throw forbidden(`达人 @${String(creator.handle)} 在公海，请先认领再寄样`);
    if (Number(creator.pool_status) === POOL_STATUS.BLACKLIST) throw forbidden('黑名单达人不能寄样');
    if (!inManageScope(user, creator)) throw forbidden('该达人不在你或你本组的私海');
    if (body.ship_method === 1 && !body.tk_order_id) throw badRequest('平台免费样品必须填 tk_order_id');
    let collabId: number | null = body.collab_id ?? null;
    if (collabId) {
      const collab = get<Record<string, unknown>>(`SELECT id, creator_id, is_deleted FROM collaboration WHERE id = ?`, collabId);
      if (!collab || Number(collab.is_deleted) === 1) throw notFound('合作单不存在');
      if (Number(collab.creator_id) !== body.creator_id) throw badRequest('合作单与达人不是同一人');
    } else {
      collabId = get<{ id: number }>(
        `SELECT id FROM collaboration WHERE creator_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
        body.creator_id,
      )?.id ?? null;
    }
    let sampleCost = body.sample_cost;
    if (body.sku_id) {
      const sku = get<{ purchase_cost: number; first_leg_cost: number; sku_code: string }>(
        `SELECT purchase_cost, first_leg_cost, sku_code FROM product_sku WHERE id = ? AND is_deleted = 0`,
        body.sku_id,
      );
      if (!sku) throw notFound('SKU 不存在');
      sampleCost = round2(unitCostCny(sku) * (body.quantity ?? 1));
    } else if (sampleCost === undefined || sampleCost === null) {
      throw badRequest('未选 SKU 时必须手工填写 sample_cost（人民币）');
    }
    const shipped = !!body.tracking_no || !!body.ship_time;
    const status = body.status ?? (body.sign_time ? SAMPLE_STATUS.SIGNED : shipped ? SAMPLE_STATUS.IN_TRANSIT : SAMPLE_STATUS.TO_SHIP);
    const id = tx(() => {
      const newId = insert('sample_shipment', cols({
        collab_id: collabId,
        creator_id: body.creator_id,
        sku_id: body.sku_id ?? null,
        quantity: body.quantity ?? 1,
        sample_cost: sampleCost ?? 0,
        shipping_cost: body.shipping_cost ?? 0,
        ship_method: body.ship_method ?? 2,
        tk_order_id: body.tk_order_id ?? null,
        tracking_no: body.tracking_no ?? null,
        ship_time: body.ship_time ?? (shipped ? nowStr() : null),
        sign_time: body.sign_time ?? null,
        status,
        created_by: user.id,
      }));
      writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'sample_shipment', target_id: newId, after: { ...body, sample_cost: sampleCost ?? 0 }, ip: req.ip });
      if (status >= SAMPLE_STATUS.IN_TRANSIT) advanceCollab(collabId, COLLAB_STATUS.IN_TRANSIT, user);
      if (status >= SAMPLE_STATUS.SIGNED) advanceCollab(collabId, COLLAB_STATUS.TO_PUBLISH, user);
      return newId;
    });
    ok(res, { id, sample_cost: sampleCost ?? 0, collab_id: collabId, status });
  }),
);

/** 寄样超期清单：把已签收但超过 sampleContentDueDays 未出内容的置为 5 并返回，同时告警 */
creatorRouter.get(
  '/sample/overdue',
  wrap((req, res) => {
    const user = current(req);
    const flagged = checkOverdueSamples();
    const vis = creatorScope(user, 'c');
    const rows = all<Record<string, unknown>>(
      `SELECT ${sampleSelect} FROM ${sampleFrom}
        WHERE sm.is_deleted = 0 AND sm.status IN (${SAMPLE_STATUS.OVERDUE}, ${SAMPLE_STATUS.SIGNED}) ${vis.sql}
          AND sm.sign_time IS NOT NULL AND date(sm.sign_time, ?) < date('now')
          AND (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0
                 AND (v.collab_id = sm.collab_id OR (sm.collab_id IS NULL AND v.creator_id = sm.creator_id))) = 0
        ORDER BY sm.sign_time ASC LIMIT ?`,
      ...vis.params,
      `+${config.sampleContentDueDays} day`,
      Math.min(500, intOf(qv(req, 'limit')) ?? 200),
    );
    ok(res, {
      due_days: flagged.due_days,
      flagged_now: flagged.overdue,
      list: rows.map((r) => decorateSample(user, r)),
      total: rows.length,
    });
  }),
);

/** 从平台免费样品单（tk_order.is_sample_order=1）生成寄样行 */
creatorRouter.post(
  '/sample/from-order',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(z.object({ tk_order_id: z.string().min(1).max(64), creator_id: z.number().int().positive().nullish() }), req.body);
    const order = get<Record<string, unknown>>(`SELECT * FROM tk_order WHERE tk_order_id = ? AND is_deleted = 0`, body.tk_order_id);
    if (!order) throw notFound('订单不存在');
    if (Number(order.is_sample_order) !== 1) throw badRequest(`订单 ${body.tk_order_id} 不是达人免费样品单（is_sample_order=0）`);
    if (get(`SELECT id FROM sample_shipment WHERE is_deleted = 0 AND tk_order_id = ?`, body.tk_order_id)) {
      throw conflict(`该样品单已生成寄样记录，勿重复导入`);
    }
    const firstItem = get<Record<string, unknown>>(
      `SELECT i.sku_id, i.quantity, i.creator_id, COALESCE(SUM(i.quantity), 0) AS qty
         FROM tk_order_item i WHERE i.order_id = ? AND i.is_deleted = 0
        GROUP BY i.sku_id ORDER BY MAX(i.id) ASC`,
      Number(order.id),
    );
    if (!firstItem) throw badRequest('样品单没有明细行，无法生成寄样');
    const creatorId = body.creator_id ?? (firstItem.creator_id === null || firstItem.creator_id === undefined ? null : Number(firstItem.creator_id));
    if (!creatorId) throw badRequest('样品单明细未归因到达人，请传 creator_id');
    const creator = get<Record<string, unknown>>(`SELECT id, handle FROM creator WHERE id = ? AND is_deleted = 0`, creatorId);
    if (!creator) throw notFound('达人不存在');
    const skuId = firstItem.sku_id === null || firstItem.sku_id === undefined ? null : Number(firstItem.sku_id);
    const quantity = Number(firstItem.qty ?? firstItem.quantity ?? 1);
    const sku = skuId ? get<{ purchase_cost: number; first_leg_cost: number }>(`SELECT purchase_cost, first_leg_cost FROM product_sku WHERE id = ?`, skuId) : undefined;
    const sampleCost = sku ? round2(unitCostCny(sku) * quantity) : 0;
    const status = ['DELIVERED', 'COMPLETED'].includes(String(order.order_status))
      ? SAMPLE_STATUS.SIGNED
      : ['SHIPPED', 'TRANSIT_TO_SHIP'].includes(String(order.order_status))
        ? SAMPLE_STATUS.IN_TRANSIT
        : SAMPLE_STATUS.TO_SHIP;
    const collabId = get<{ id: number }>(
      `SELECT id FROM collaboration WHERE creator_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
      creatorId,
    )?.id ?? null;
    const id = tx(() => {
      const newId = insert('sample_shipment', cols({
        collab_id: collabId,
        creator_id: creatorId,
        sku_id: skuId,
        quantity,
        sample_cost: sampleCost,
        shipping_cost: round2(num(order.shipping_fee) * exchangeRate(order.currency, today().slice(0, 10))),
        ship_method: 1,
        tk_order_id: body.tk_order_id,
        tracking_no: order.tracking_no ?? null,
        ship_time: order.ship_time ?? null,
        sign_time: status >= SAMPLE_STATUS.SIGNED ? String(order.ship_time ?? nowStr()) : null,
        status,
        created_by: user.id,
      }));
      writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'sample_shipment', target_id: newId, after: { tk_order_id: body.tk_order_id, creator_id: creatorId, from_order: true }, ip: req.ip });
      if (collabId && status >= SAMPLE_STATUS.IN_TRANSIT) advanceCollab(collabId, COLLAB_STATUS.IN_TRANSIT, user);
      return newId;
    });
    ok(res, { id, creator_id: creatorId, sku_id: skuId, quantity, sample_cost: sampleCost, status, hint: sampleCost === 0 ? '样品 SKU 未映射成本，寄样成本按 0 计，请先做商品映射' : null });
  }),
);

creatorRouter.put(
  '/sample/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('寄样单不存在');
    if (!user.can_see_cost && (req.body?.sample_cost !== undefined || req.body?.shipping_cost !== undefined)) throw forbidden('没有成本查看权限，不能修改寄样成本');
    const body = parseBody(sampleBody.partial().omit({ creator_id: true }), req.body);
    if (body.sku_id) {
      const sku = get<{ purchase_cost: number; first_leg_cost: number }>(`SELECT purchase_cost, first_leg_cost FROM product_sku WHERE id = ? AND is_deleted = 0`, body.sku_id);
      if (!sku) throw notFound('SKU 不存在');
      body.sample_cost = round2(unitCostCny(sku) * Number(body.quantity ?? before.quantity ?? 1));
    }
    update('sample_shipment', id, cols(body));
    logIfChanged({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'sample_shipment',
      target_id: id,
      before,
      after: { ...before, ...body },
      keys: ['sku_id', 'quantity', 'sample_cost', 'shipping_cost', 'ship_method', 'tk_order_id', 'tracking_no', 'ship_time', 'sign_time', 'status', 'collab_id'],
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/** 发货：填 tracking_no / ship_time → 状态 2 在途，合作单自动 2→3 */
creatorRouter.post(
  '/sample/:id/ship',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('寄样单不存在');
    if (Number(row.status) >= SAMPLE_STATUS.SIGNED) throw badRequest(`已签收的寄样单不能再置为在途（当前状态 ${Number(row.status)}）`);
    const body = parseBody(z.object({ tracking_no: z.string().min(1).max(64), ship_time: z.string().max(20).nullish(), carrier: z.string().max(64).nullish() }), req.body);
    const ship_time = body.ship_time || nowStr();
    update('sample_shipment', id, cols({ tracking_no: body.tracking_no, ship_time, status: SAMPLE_STATUS.IN_TRANSIT }));
    advanceCollab(row.collab_id, COLLAB_STATUS.IN_TRANSIT, user);
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'sample_shipment',
      target_id: id,
      before: { status: row.status, tracking_no: row.tracking_no },
      after: { status: SAMPLE_STATUS.IN_TRANSIT, tracking_no: body.tracking_no, ship_time, carrier: body.carrier ?? null },
      ip: req.ip,
    });
    ok(res, { id, status: SAMPLE_STATUS.IN_TRANSIT, ship_time });
  }),
);

/** 登记签收 → 状态 3，合作单自动 → 4 待发布（签收即开始计超期天数） */
creatorRouter.post(
  '/sample/:id/sign',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('寄样单不存在');
    if (Number(row.status) === SAMPLE_STATUS.LOST) throw badRequest('丢件寄样单不能登记签收');
    if (Number(row.status) >= SAMPLE_STATUS.CONTENT_DONE) throw badRequest(`该寄样单已出内容，无需再登记签收`);
    const body = parseBody(z.object({ sign_time: z.string().max(20).nullish() }), req.body);
    const sign_time = body.sign_time || nowStr();
    update('sample_shipment', id, cols({ sign_time, status: SAMPLE_STATUS.SIGNED }));
    advanceCollab(row.collab_id, COLLAB_STATUS.TO_PUBLISH, user);
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'sample_shipment',
      target_id: id,
      before: { status: row.status, sign_time: row.sign_time },
      after: { status: SAMPLE_STATUS.SIGNED, sign_time, due_date: plusDays(config.sampleContentDueDays, new Date(`${sign_time.slice(0, 10)}T00:00:00Z`)) },
      ip: req.ip,
    });
    ok(res, { id, status: SAMPLE_STATUS.SIGNED, sign_time, due_date: plusDays(config.sampleContentDueDays, new Date(`${sign_time.slice(0, 10)}T00:00:00Z`)) });
  }),
);

/** 丢件：状态 6，成本仍在达人 ROI 分母里（方案表 12） */
creatorRouter.post(
  '/sample/:id/lost',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM sample_shipment WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('寄样单不存在');
    if (Number(row.status) >= SAMPLE_STATUS.CONTENT_DONE) throw badRequest('已出内容的寄样单不能标记丢件');
    const body = parseBody(z.object({ remark: z.string().max(200).nullish() }), req.body);
    update('sample_shipment', id, cols({ status: SAMPLE_STATUS.LOST }));
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'sample_shipment',
      target_id: id,
      before: { status: row.status },
      after: { status: SAMPLE_STATUS.LOST, remark: body.remark ?? null },
      ip: req.ip,
    });
    ok(res, { id, status: SAMPLE_STATUS.LOST });
  }),
);

/* ---------------- 达人 ROI 排行 / BD 绩效 ---------------- */

/** 按达人聚合（group=true 时按 BD 聚合到人，即 BD 绩效榜） */
creatorRouter.get(
  '/roi/rank',
  wrap((req, res) => {
    const user = current(req);
    const period = safePeriod(resolvePeriod(qv(req, 'period')));
    const region = (qv(req, 'region') ?? '').trim().toUpperCase();
    const group = qv(req, 'group') === 'true' || qv(req, 'group') === '1';
    const limit = Math.min(200, intOf(qv(req, 'limit')) ?? 50);
    if (group) {
      const sc = personScope(user, 'u.id', true);
      const rows = bdPerformance({ period, scopeSql: sc.sql, scopeParams: sc.params });
      ok(res, { dimension: 'bd', period, list: user.can_see_cost ? rows : rows.map((r) => maskFields(r as unknown as Record<string, unknown>, ['net_gmv_cny', 'cost_cny', 'roi'], false)) });
      return;
    }
    const vis = creatorScope(user, 'c');
    const scopeSql = `${vis.sql}${region ? ' AND c.region = ?' : ''}`;
    const rows = roiByCreator({ period, scopeSql, scopeParams: [...vis.params, ...(region ? [region] : [])], limit });
    ok(res, {
      dimension: 'creator',
      period,
      total: rows.length,
      list: user.can_see_cost
        ? rows
        : rows.map((r) => maskFields(r as unknown as Record<string, unknown>, ROI_COST_FIELDS, false)),
    });
  }),
);

/** BD 工作量与漏斗：联系次数 / 回复率 / 有意向数 / 谈妥数 / 私海达人数 / 平均首响时长 */
creatorRouter.get(
  '/bd-performance',
  wrap((req, res) => {
    const user = current(req);
    const group = qv(req, 'group') === 'true' || qv(req, 'group') === '1';
    const period = safePeriod(resolvePeriod(qv(req, 'period')));
    const sc = group ? personScope(user, 'u.id', true) : { sql: `AND u.id = ?`, params: [user.id] };
    const base = bdPerformance({ period, scopeSql: sc.sql, scopeParams: sc.params });
    const byUser = new Map<number, Record<string, unknown>>();
    for (const r of base) byUser.set(r.user_id, { ...r });

    const interested = all<{ user_id: number; interested_cnt: number }>(
      `SELECT o.user_id AS user_id, SUM(CASE WHEN o.result = ${OUTREACH_RESULT.INTERESTED} THEN 1 ELSE 0 END) AS interested_cnt
         FROM creator_outreach o WHERE o.is_deleted = 0 GROUP BY o.user_id`,
    );
    const privates = all<{ owner_id: number; private_creators: number }>(
      `SELECT c.owner_id AS owner_id, COUNT(*) AS private_creators FROM creator c
        WHERE c.is_deleted = 0 AND c.pool_status IN (${POOL_STATUS.PRIVATE}, ${POOL_STATUS.COOPERATING}) AND c.owner_id IS NOT NULL
        GROUP BY c.owner_id`,
    );
    const firstResponse = all<{ user_id: number; avg_first_response_hours: number | null }>(
      `SELECT f.user_id AS user_id, ROUND(AVG((julianday(r.first_reply) - julianday(f.first_contact)) * 24), 2) AS avg_first_response_hours
         FROM (SELECT creator_id, user_id, MIN(contact_time) AS first_contact FROM creator_outreach WHERE is_deleted = 0 GROUP BY creator_id, user_id) f
         JOIN (SELECT creator_id, user_id, MIN(contact_time) AS first_reply FROM creator_outreach
                WHERE is_deleted = 0 AND result >= ${OUTREACH_RESULT.REPLIED} GROUP BY creator_id, user_id) r
           ON r.creator_id = f.creator_id AND r.user_id = f.user_id
        GROUP BY f.user_id`,
    );
    for (const r of interested) { const t = byUser.get(Number(r.user_id)); if (t) t.interested_cnt = Number(r.interested_cnt); }
    for (const r of privates) { const t = byUser.get(Number(r.owner_id)); if (t) t.private_creators = Number(r.private_creators); }
    for (const r of firstResponse) { const t = byUser.get(Number(r.user_id)); if (t) t.avg_first_response_hours = num(r.avg_first_response_hours); }

    const list: Record<string, unknown>[] = [...byUser.values()].map((r) => ({
      interested_cnt: 0,
      private_creators: 0,
      avg_first_response_hours: null,
      ...r,
      ...(user.can_see_cost ? {} : maskFields(r, ['net_gmv_cny', 'cost_cny', 'roi'], false)),
    }));
    list.sort((a, b) => Number(b.outreach_cnt ?? 0) - Number(a.outreach_cnt ?? 0));
    ok(res, { period, dimension: group ? (user.data_scope === DATA_SCOPE.ALL ? 'all' : 'dept') : 'self', total: list.length, list });
  }),
);

/* ---------------- 达人档案（动态 :id 路由统一放在静态路由之后） ---------------- */

creatorRouter.get(
  '/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const vis = creatorScope(user);
    const row = get<Record<string, unknown>>(
      `SELECT ${creatorListSelect} FROM ${creatorListFrom} WHERE c.id = ? AND c.is_deleted = 0${vis.sql ? ` ${vis.sql}` : ''}`,
      id, ...vis.params,
    );
    if (!row) throw notFound('达人不存在或不在你的数据范围内');
    const collabs = queryList({
      from: 'collaboration l LEFT JOIN tk_shop s ON s.id = l.shop_id LEFT JOIN product_spu p ON p.id = l.spu_id',
      q: new Q('l.is_deleted = 0').eq('l.creator_id', id),
      select: `l.*, s.shop_name, p.name_cn AS spu_name, (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 AND v.collab_id = l.id) AS video_count`,
      orderBy: 'l.id DESC',
      limit: 50,
    });
    ok(res, {
      ...decorateCreator(user, row),
      collab_count: collabs.length,
      collabs: collabs.map((c) => decorateCollab(user, c as unknown as Record<string, unknown>)),
      samples: queryList({ from: 'sample_shipment sm LEFT JOIN product_sku sk ON sk.id = sm.sku_id', q: new Q('sm.is_deleted = 0').eq('sm.creator_id', id), select: 'sm.*, sk.sku_code', orderBy: 'sm.id DESC', limit: 50 }),
      outreach: queryList({ from: 'creator_outreach o LEFT JOIN sys_user u ON u.id = o.user_id', q: new Q('o.is_deleted = 0').eq('o.creator_id', id), select: 'o.*, u.real_name AS user_name', orderBy: 'o.contact_time DESC', limit: 50 }),
      roi: user.can_see_cost ? roiByCreator({ period: { from: '', to: '', days: 0 }, scopeSql: 'AND c.id = ?', scopeParams: [id], limit: 1 })[0] ?? null : null,
    });
  }),
);

creatorRouter.put(
  '/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('达人不存在');
    if (!inManageScope(user, before)) throw forbidden('该达人在他人私海，不能修改');
    const body = parseBody(creatorPatch, req.body);
    const patch: Record<string, unknown> = { ...body };
    if (body.category_tags !== undefined) patch.category_tags = tagsText(body.category_tags);
    if (body.email !== undefined) patch.email = body.email || null;
    let newHandle: string | null = null;
    if (body.handle !== undefined) {
      newHandle = normalizeHandle(body.handle);
      if (newHandle !== String(before.handle)) {
        const dup = get<Record<string, unknown>>(`SELECT id, pool_status, owner_id FROM creator WHERE handle = ?`, newHandle);
        if (dup) throw conflict(`handle @${newHandle} 已被达人 #${Number(dup.id)} 占用`);
      }
    }
    // 改归属必须主管 / 老板，并且强制 before/after 留痕
    if (patch.owner_id !== undefined && Number(patch.owner_id ?? -1) !== Number(before.owner_id ?? -1)) {
      if (!isManager(user)) throw forbidden('只有主管 / 老板可以变更达人归属');
      if (patch.owner_id !== null && !get(`SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0`, Number(patch.owner_id))) throw notFound('接手员工不存在');
      const ownerId = patch.owner_id === null ? null : Number(patch.owner_id);
      const pool = ownerId === null ? POOL_STATUS.PUBLIC : Number(before.pool_status) === POOL_STATUS.PRIVATE ? POOL_STATUS.PRIVATE : Number(before.pool_status);
      patch.owner_id = ownerId;
      patch.pool_status = pool;
      patch.protect_until = ownerId === null ? null : (before.protect_until ?? plusDays(config.protectDefaultDays));
      update('creator', id, cols({ ...patch, handle: newHandle ?? undefined }));
      writeOpLog({
        user_id: user.id,
        module: '达人中心',
        action: 'update',
        target_table: 'creator',
        target_id: id,
        before: { owner_id: before.owner_id, pool_status: before.pool_status, protect_until: before.protect_until, owner_name: before.owner_name ?? null },
        after: { owner_id: ownerId, pool_status: pool, protect_until: patch.protect_until ?? null },
        ip: req.ip,
      });
      ok(res, { id, owner_changed: true });
      return;
    }
    update('creator', id, cols({ ...patch, handle: newHandle ?? undefined }));
    logIfChanged({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      target_id: id,
      before,
      after: { ...before, ...patch, handle: newHandle ?? before.handle },
      keys: ['handle', 'nickname', 'region', 'followers', 'category_tags', 'avg_views', 'gmv_level', 'email', 'whatsapp', 'pool_status', 'protect_until', 'source'],
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/** 软删：只打标记，历史跟进 / 合作单保留（方案 8.2） */
creatorRouter.delete(
  '/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('达人不存在');
    if (!inManageScope(user, before)) throw forbidden('该达人在他人私海，不能删除');
    softDelete('creator', id);
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'delete', target_table: 'creator', target_id: id, before, ip: req.ip });
    ok(res, { id });
  }),
);

/** 认领：仅公海可认领，条件更新保证并发下只有一人成功 */
creatorRouter.post(
  '/:id/claim',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!creator) throw notFound('达人不存在');
    const days = intOf(qv(req, 'days')) ?? config.protectDefaultDays;
    const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
    if (ownerId !== null && ownerId === user.id) throw conflict('你已经认领过该达人');
    if (ownerId !== null) {
      const holder = get<{ real_name: string; dept: string | null }>(`SELECT real_name, dept FROM sys_user WHERE id = ?`, ownerId);
      throw conflict(`该达人已被 ${holder?.real_name ?? `员工#${ownerId}`} 认领（保护期至 ${String(creator.protect_until ?? '—')}），请联系主管协调转交`);
    }
    if (Number(creator.pool_status) !== POOL_STATUS.PUBLIC) throw badRequest(`仅公海达人可认领（当前 pool_status=${Number(creator.pool_status)}）`);
    const protect = plusDays(Math.max(1, days));
    const changed = tx(() => run(
      `UPDATE creator SET owner_id = ?, pool_status = ?, protect_until = ?, updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0 AND owner_id IS NULL AND pool_status = ?`,
      user.id, POOL_STATUS.PRIVATE, protect, id, POOL_STATUS.PUBLIC,
    ).changes);
    if (!changed) {
      const now = get<{ owner_id: number | null }>(`SELECT owner_id FROM creator WHERE id = ?`, id);
      const holder = now?.owner_id ? get<{ real_name: string }>(`SELECT real_name FROM sys_user WHERE id = ?`, now.owner_id) : undefined;
      throw conflict(`认领失败：该达人刚被 ${holder?.real_name ?? '其他 BD'} 认领`);
    }
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      target_id: id,
      before: { owner_id: null, pool_status: POOL_STATUS.PUBLIC, protect_until: null },
      after: { owner_id: user.id, pool_status: POOL_STATUS.PRIVATE, protect_until: protect },
      ip: req.ip,
    });
    ok(res, { id, owner_id: user.id, pool_status: POOL_STATUS.PRIVATE, protect_until: protect });
  }),
);

/** 退回公海：清空归属与保护期 */
creatorRouter.post(
  '/:id/release',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!creator) throw notFound('达人不存在');
    if (!inManageScope(user, creator)) throw forbidden('该达人在他人私海，不能退回公海');
    const ongoing = scalar<number>(
      `SELECT COUNT(*) FROM collaboration WHERE creator_id = ? AND is_deleted = 0 AND status NOT IN (${COLLAB_STATUS.FINISHED}, ${COLLAB_STATUS.CANCELLED}, ${COLLAB_STATUS.OVERDUE})`,
      id,
    );
    const before = { owner_id: creator.owner_id, pool_status: creator.pool_status, protect_until: creator.protect_until };
    update('creator', id, cols({ owner_id: null, pool_status: POOL_STATUS.PUBLIC, protect_until: null }));
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      target_id: id,
      before,
      after: { owner_id: null, pool_status: POOL_STATUS.PUBLIC, protect_until: null, ongoing_collabs: ongoing, reason: qv(req, 'reason') ?? '手工退回公海' },
      ip: req.ip,
    });
    ok(res, { id, pool_status: POOL_STATUS.PUBLIC, ongoing_collabs: ongoing });
  }),
);

/** 黑名单：action=add 拉黑（pool_status=4）/ remove 解除（回私海或公海） */
creatorRouter.post(
  '/:id/blacklist',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!creator) throw notFound('达人不存在');
    if (!inManageScope(user, creator)) throw forbidden('该达人在他人私海，不能变更黑名单状态');
    const body = parseBody(z.object({ action: z.enum(['add', 'remove']).default('add'), reason: z.string().max(200).nullish() }), req.body);
    const before = { pool_status: creator.pool_status, protect_until: creator.protect_until };
    const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
    const after = body.action === 'add'
      ? { pool_status: POOL_STATUS.BLACKLIST, protect_until: null }
      : { pool_status: ownerId === null ? POOL_STATUS.PUBLIC : POOL_STATUS.PRIVATE, protect_until: ownerId === null ? null : plusDays(config.protectDefaultDays) };
    update('creator', id, cols(after));
    writeOpLog({
      user_id: user.id,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      target_id: id,
      before: { ...before, owner_id: ownerId },
      after: { ...after, owner_id: ownerId, blacklist_action: body.action, reason: body.reason ?? null },
      ip: req.ip,
    });
    ok(res, { id, ...after });
  }),
);

/** 达人跟进时间线 */
creatorRouter.get(
  '/:id/outreach',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const creator = get<Record<string, unknown>>(`SELECT id, handle FROM creator WHERE id = ? AND is_deleted = 0`, id);
    if (!creator) throw notFound('达人不存在');
    const page = queryPage(req, {
      from: outreachFrom,
      select: outreachSelect,
      q: new Q('o.is_deleted = 0').eq('o.creator_id', id),
      orderBy: 'o.contact_time DESC, o.id DESC',
    });
    ok(res, {
      creator: { id: Number(creator.id), handle: creator.handle },
      ...page,
      list: page.list.map((r) => maskFields(r, CONTACT_FIELDS, contactAllowed(user, r.creator_owner_id))),
    });
  }),
);

export default creatorRouter;
