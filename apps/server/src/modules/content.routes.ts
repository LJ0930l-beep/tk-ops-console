import { Router, type Request } from 'express';
import { z } from 'zod';
import { COLLAB_STATUS, CONTENT_TYPE, DATA_SCOPE, POOL_STATUS, SAMPLE_STATUS, num, parseVideoId, round2, type CurrentUser } from '@tk/shared';
import { all, get, insert, run, scalar, softDelete, tx, update, type SqlParam } from '../core/db.js';
import { AppError, badRequest, forbidden, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { exportFromList } from '../core/export.js';
import { personScope, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
import { linkVideoToCollab, nowStr, tsOf } from '../services/creator/protect.js';
import { ATTRIBUTABLE_ORDER, AMOUNT_CNY, RATE_JOIN, REFUND_CNY, REFUND_JOIN, exchangeRate } from '../services/creator/roi.js';
import { refreshVideoAggregates, remindUpcomingLives } from '../jobs/creatorJobs.js';

/* ====================================================================
 * 内容中心（方案 5.4 表 13-14 + 6.1 步骤 5/6 + 6.3 直播闭环）
 * 挂载点：/api/content
 * ==================================================================== */

export const contentRouter = Router();

const current = (req: object): CurrentUser => (req as AuthedRequest).user;
const conflict = (msg: string): AppError => new AppError(409, msg, 40901);
const canWrite = requireMenu('content');

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
  if (v === undefined || v === null || v === '') return null;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const orderByOf = (req: Parameters<typeof qv>[0], map: Record<string, string>, def: string): string => {
  const key = qv(req, 'sortBy');
  const col = key ? map[key] : undefined;
  const dir = qv(req, 'sortOrder') === 'asc' ? 'ASC' : 'DESC';
  return col ? `${col} ${dir}, id DESC` : def;
};

/** 千次观看成交额（方案 6.3 / prd 3.6） */
const gpmOf = (gmv: number, views: number): number => (views > 0 ? round2((gmv / views) * 1000) : 0);

/** 时长（小时，两位小数） */
function hoursBetween(from: unknown, to: unknown): number | null {
  const a = tsOf(from);
  const b = tsOf(to);
  if (!a || !b || b < a) return null;
  return round2((b - a) / 3_600_000);
}

/* ---------------- 数据范围（方案 8.1：内容 / 主播只看自己参与的） ---------------- */

const deptIds = (): string => `(SELECT id FROM sys_user WHERE dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL)`;

/** 视频可见范围：剪辑人本人 / 参与的合作单归属 / 店铺范围 */
function videoScope(user: CurrentUser, alias = 'v'): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  const mine = `${alias}.editor_id = ?
     OR EXISTS (SELECT 1 FROM collaboration l WHERE l.id = ${alias}.collab_id AND l.owner_id = ?)
     OR EXISTS (SELECT 1 FROM creator c WHERE c.id = ${alias}.creator_id AND c.owner_id = ?)`;
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return {
      sql: `AND (${alias}.editor_id IN ${deptIds()} OR ${alias}.created_by IN ${deptIds()}
        OR EXISTS (SELECT 1 FROM collaboration l WHERE l.id = ${alias}.collab_id AND l.owner_id IN ${deptIds()}))`,
      params: [user.id, user.id, user.id],
    };
  }
  if (user.data_scope === DATA_SCOPE.SHOPS) {
    if (!user.shop_ids.length) return { sql: `AND (${mine})`, params: [user.id, user.id, user.id] };
    return {
      sql: `AND (${alias}.shop_id IN (${user.shop_ids.map(() => '?').join(',')}) OR ${mine})`,
      params: [...user.shop_ids, user.id, user.id, user.id],
    };
  }
  return { sql: `AND (${mine})`, params: [user.id, user.id, user.id] };
}

/** 直播可见范围：主播 / 场控本人，或店铺范围 */
function liveScope(user: CurrentUser, alias = 'l'): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return {
      sql: `AND (${alias}.host_id IN ${deptIds()} OR ${alias}.assistant_id IN ${deptIds()} OR ${alias}.created_by IN ${deptIds()})`,
      params: [user.id, user.id, user.id],
    };
  }
  if (user.data_scope === DATA_SCOPE.SHOPS && user.shop_ids.length) {
    return {
      sql: `AND (${alias}.shop_id IN (${user.shop_ids.map(() => '?').join(',')}) OR ${alias}.host_id = ? OR ${alias}.assistant_id = ?)`,
      params: [...user.shop_ids, user.id, user.id],
    };
  }
  return { sql: `AND (${alias}.host_id = ? OR ${alias}.assistant_id = ? OR ${alias}.created_by = ?)`, params: [user.id, user.id, user.id] };
}

const isManager = (user: CurrentUser): boolean => user.data_scope === DATA_SCOPE.ALL || user.data_scope === DATA_SCOPE.DEPT;

/* ==================== 表 13 视频 ==================== */

const videoBody = z.object({
  video_url: z.string().min(8).max(500),
  publisher_type: z.number().int().min(1).max(2).default(1),
  account_id: z.number().int().positive().nullish(),
  creator_id: z.number().int().positive().nullish(),
  collab_id: z.number().int().positive().nullish(),
  spu_id: z.number().int().positive().nullish(),
  shop_id: z.number().int().positive().nullish(),
  publish_time: z.string().max(20).nullish(),
  editor_id: z.number().int().positive().nullish(),
  views: z.number().int().min(0).default(0),
  likes: z.number().int().min(0).default(0),
  comments: z.number().int().min(0).default(0),
  shares: z.number().int().min(0).default(0),
  status: z.number().int().min(1).max(3).default(1),
});

const videoFrom = `video v
     LEFT JOIN creator c ON c.id = v.creator_id
     LEFT JOIN tk_account a ON a.id = v.account_id
     LEFT JOIN collaboration l ON l.id = v.collab_id
     LEFT JOIN product_spu p ON p.id = v.spu_id
     LEFT JOIN tk_shop s ON s.id = v.shop_id
     LEFT JOIN sys_user ed ON ed.id = v.editor_id
     LEFT JOIN sys_user cb ON cb.id = v.created_by`;
const videoSelect = `v.*, c.handle AS creator_handle, c.nickname AS creator_nickname, c.region AS creator_region,
       a.handle AS account_handle, a.nickname AS account_nickname, l.collab_no, l.status AS collab_status,
       p.name_cn AS spu_name, p.spu_code, s.shop_name, ed.real_name AS editor_name, cb.real_name AS created_by_name,
       (SELECT COUNT(*) FROM ad_daily ad WHERE ad.is_deleted = 0 AND ad.video_id = v.id) AS ad_rows`;

function decorateVideo(user: CurrentUser, row: Record<string, unknown>): Record<string, unknown> {
  const views = Number(row.views ?? 0);
  return {
    ...row,
    publisher_type: Number(row.publisher_type),
    gpm: gpmOf(num(row.gmv), views),
    can_edit: user.data_scope === DATA_SCOPE.ALL
      || Number(row.editor_id ?? -1) === user.id
      || Number(row.created_by ?? -1) === user.id
      || Number(row.creator_owner_id ?? -1) === user.id,
  };
}

/** 合作单归属校验：BD 只能挂自己 / 本组的合作单；剪辑人以「自己是剪辑人」为凭 */
function assertCollabUsable(user: CurrentUser, collabId: number, editorId: number | null | undefined): Record<string, unknown> {
  const collab = get<Record<string, unknown>>(
    `SELECT l.*, c.handle AS creator_handle, c.owner_id AS creator_owner_id FROM collaboration l
       JOIN creator c ON c.id = l.creator_id WHERE l.id = ? AND l.is_deleted = 0`,
    collabId,
  );
  if (!collab) throw notFound('合作单不存在');
  const owner = collab.owner_id === null || collab.owner_id === undefined ? null : Number(collab.owner_id);
  const creatorOwner = collab.creator_owner_id === null || collab.creator_owner_id === undefined ? null : Number(collab.creator_owner_id);
  if (user.data_scope === DATA_SCOPE.ALL) return collab;
  if (owner === user.id || creatorOwner === user.id) return collab;
  if (isManager(user) && owner !== null) {
    const same = get(`SELECT 1 AS x FROM sys_user WHERE id = ? AND dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL`, owner, user.id);
    if (same) return collab;
  }
  if (user.data_scope === DATA_SCOPE.SHOPS && user.shop_ids.includes(Number(collab.shop_id))) return collab;
  if (editorId != null && editorId === user.id) return collab;
  throw forbidden(`合作单 ${String(collab.collab_no)} 属于 ${collab.creator_handle ? `达人 @${String(collab.creator_handle)}` : '他人'}，不在你的数据范围内`);
}

/** 视频库列表：筛发布方 / 达人 / 账号 / 合作单 / SPU / 店铺 / 剪辑 / 时间，排序支持 views|gmv|orders */
/**
 * 列表与导出共用同一份筛选条件：导出绝不另写 WHERE，否则两边口径一定会漂
 * （本轮已经为此修过三处：ROI 死路径、字典整页 500、同步下拉枚举对不上）。
 * 返回的 Q 已含数据范围，别名固定为 v / l。
 */
function videoQ(req: Request, user: CurrentUser): Q {
  const scope = videoScope(user);
  const q = new Q('v.is_deleted = 0').and(scope.sql || '', ...scope.params);
  q.eq('v.publisher_type', qv(req, 'publisher_type'))
    .eq('v.creator_id', qv(req, 'creator_id'))
    .eq('v.account_id', qv(req, 'account_id'))
    .eq('v.collab_id', qv(req, 'collab_id'))
    .eq('v.spu_id', qv(req, 'spu_id'))
    .eq('v.shop_id', qv(req, 'shop_id'))
    .eq('v.editor_id', qv(req, 'editor_id'))
    .eq('v.status', qv(req, 'status'))
    .between('v.publish_time', qv(req, 'publish_time_from'), qv(req, 'publish_time_to'))
    .between('v.publish_time', qv(req, 'start_date'), qv(req, 'end_date'))
    .like(`v.tk_video_id LIKE ? OR v.video_url LIKE ? OR c.handle LIKE ? OR a.handle LIKE ? OR p.name_cn LIKE ?`, qv(req, 'keyword'));
  if (qv(req, 'with_orders') === '1') q.and('v.orders > 0');
  return q;
}

function liveQ(req: Request, user: CurrentUser): Q {
  const scope = liveScope(user);
  const q = new Q('l.is_deleted = 0').and(scope.sql || '', ...scope.params);
  q.eq('l.shop_id', qv(req, 'shop_id'))
    .eq('l.account_id', qv(req, 'account_id'))
    .eq('l.host_id', qv(req, 'host_id'))
    .eq('l.assistant_id', qv(req, 'assistant_id'))
    .eq('l.creator_id', qv(req, 'creator_id'))
    .eq('l.status', qv(req, 'status'))
    .between('l.plan_start', qv(req, 'plan_start_from') ?? qv(req, 'start_date'), qv(req, 'plan_start_to') ?? qv(req, 'end_date'))
    .like(`a.handle LIKE ? OR s.shop_name LIKE ? OR h.real_name LIKE ? OR c.handle LIKE ?`, qv(req, 'keyword'));
  return q;
}

/** 导出列：key 必须是 decorate* 输出里真实存在的键（用例逐类导出反解核对表头与行数） */
const VIDEO_EXPORT_COLUMNS = [
  { key: 'tk_video_id', label: '视频ID' },
  { key: 'video_url', label: '视频链接' },
  { key: 'creator_handle', label: '达人账号' },
  { key: 'account_handle', label: '发布账号' },
  { key: 'collab_no', label: '合作单号' },
  { key: 'spu_name', label: 'SPU' },
  { key: 'shop_name', label: '店铺' },
  { key: 'editor_name', label: '剪辑' },
  { key: 'publish_time', label: '发布时间' },
  { key: 'views', label: '播放' },
  { key: 'likes', label: '点赞' },
  { key: 'orders', label: '订单数' },
  { key: 'gmv', label: '带货额(原币)' },
  { key: 'gpm', label: '千次播放成交额' },
  { key: 'status', label: '状态' },
];

const LIVE_EXPORT_COLUMNS = [
  { key: 'plan_start', label: '计划开播' },
  { key: 'actual_start', label: '实际开播' },
  { key: 'actual_end', label: '结束时间' },
  { key: 'shop_name', label: '店铺' },
  { key: 'region', label: '站点' },
  { key: 'account_handle', label: '直播账号' },
  { key: 'host_name', label: '主播' },
  { key: 'assistant_name', label: '助播' },
  { key: 'creator_handle', label: '出镜达人' },
  { key: 'viewers', label: '观看人次' },
  { key: 'peak_online', label: '峰值在线' },
  { key: 'orders', label: '订单数' },
  { key: 'gmv', label: '成交额(原币)' },
  { key: 'gmv_cny', label: '成交额(CNY)' },
  { key: 'ad_spend', label: '直播投放消耗' },
  { key: 'status', label: '状态' },
];

/** 视频导出（PRD D13 九类之一）：与 /videos 同一份筛选、同一份装饰（含成本掩码） */
contentRouter.get(
  '/videos/export',
  requireMenu('content'),
  requireExport,
  wrap((req, res) => {
    const user = current(req);
    exportFromList(req, res, {
      module: '内容直播',
      targetTable: 'video',
      filename: `content-videos-${String(qv(req, 'start_date') ?? '').slice(0, 10) || 'all'}`,
      from: videoFrom,
      select: videoSelect,
      q: videoQ(req, user),
      orderBy: 'v.publish_time DESC, v.id DESC',
      columns: VIDEO_EXPORT_COLUMNS,
      decorate: (r) => decorateVideo(user, r),
      filters: {
        start_date: qv(req, 'start_date'),
        end_date: qv(req, 'end_date'),
        shop_id: qv(req, 'shop_id'),
        creator_id: qv(req, 'creator_id'),
        keyword: qv(req, 'keyword'),
      },
    });
  }),
);

/** 直播场次导出（PRD D13 九类之一） */
contentRouter.get(
  '/lives/export',
  requireMenu('content'),
  requireExport,
  wrap((req, res) => {
    const user = current(req);
    exportFromList(req, res, {
      module: '内容直播',
      targetTable: 'live_session',
      filename: `content-lives-${String(qv(req, 'start_date') ?? '').slice(0, 10) || 'all'}`,
      from: liveFrom,
      select: liveSelect,
      q: liveQ(req, user),
      orderBy: 'l.plan_start DESC, l.id DESC',
      columns: LIVE_EXPORT_COLUMNS,
      decorate: (r) => decorateLive(user, r),
      filters: {
        start_date: qv(req, 'start_date'),
        end_date: qv(req, 'end_date'),
        shop_id: qv(req, 'shop_id'),
        host_id: qv(req, 'host_id'),
      },
    });
  }),
);

contentRouter.get(
  '/videos',
  wrap((req, res) => {
    const user = current(req);
    const q = videoQ(req, user);
    const page = queryPage(req, {
      from: videoFrom,
      select: videoSelect,
      q,
      orderBy: orderByOf(req, { views: 'v.views', gmv: 'v.gmv', orders: 'v.orders', publish_time: 'v.publish_time', likes: 'v.likes', id: 'v.id' }, 'v.publish_time DESC, v.id DESC'),
    });
    ok(res, { ...page, list: page.list.map((r) => decorateVideo(user, r)) });
  }),
);

/**
 * 登记视频：tk_video_id 由 parseVideoId 从链接解析（解析失败 400、重复 409）；
 * 达人视频必须挂合作单，登记成功后寄样 → 4 已出内容、合作单 → 5 已发布。
 */
contentRouter.post(
  '/videos',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(videoBody, req.body);
    const tkVideoId = parseVideoId(body.video_url);
    if (!tkVideoId) throw badRequest(`无法从链接解析视频 ID，请检查链接（支持 /video/<id>、/v/<id>、?item_id=<id> 或纯数字 ID）：${body.video_url}`);
    if (get(`SELECT id FROM video WHERE tk_video_id = ?`, tkVideoId)) throw conflict(`该视频已登记（tk_video_id ${tkVideoId}）`);

    let creatorId = body.creator_id ?? null;
    let collabId = body.collab_id ?? null;
    if (Number(body.publisher_type) === 2) {
      if (!collabId) throw badRequest('达人视频必须挂合作单（collab_id 必填，方案表 13）');
      const collab = assertCollabUsable(user, collabId, body.editor_id ?? null);
      const collabCreator = Number(collab.creator_id);
      if (creatorId !== null && creatorId !== collabCreator) throw badRequest('达人与合作单不是同一人，请核对 creator_id / collab_id');
      creatorId = collabCreator;
      if (!body.spu_id && collab.spu_id) body.spu_id = Number(collab.spu_id);
      if (!body.shop_id) body.shop_id = Number(collab.shop_id);
    } else {
      if (!body.account_id) throw badRequest('自有账号视频必须选择发布账号（account_id 必填）');
      if (!get(`SELECT id FROM tk_account WHERE id = ? AND is_deleted = 0`, body.account_id)) throw notFound('TikTok 账号不存在');
      if (creatorId) throw badRequest('自有账号视频不能挂达人');
    }
    if (body.spu_id && !get(`SELECT id FROM product_spu WHERE id = ? AND is_deleted = 0`, body.spu_id)) throw notFound('SPU 不存在');
    const shopId = body.shop_id ?? null;
    if (shopId && !get(`SELECT id FROM tk_shop WHERE id = ? AND is_deleted = 0`, shopId)) throw notFound('店铺不存在');

    const editorId = Number(body.publisher_type) === 1 ? (body.editor_id ?? user.id) : (body.editor_id ?? null);
    const id = tx(() => {
      const newId = insert('video', cols({
        tk_video_id: tkVideoId,
        video_url: body.video_url,
        publisher_type: body.publisher_type ?? 1,
        account_id: Number(body.publisher_type) === 1 ? (body.account_id ?? null) : null,
        creator_id: Number(body.publisher_type) === 2 ? creatorId : null,
        collab_id: Number(body.publisher_type) === 2 ? collabId : null,
        spu_id: body.spu_id ?? null,
        shop_id: shopId,
        publish_time: body.publish_time ?? nowStr(),
        editor_id: editorId,
        views: body.views ?? 0,
        likes: body.likes ?? 0,
        comments: body.comments ?? 0,
        shares: body.shares ?? 0,
        status: body.status ?? 1,
        created_by: user.id,
      }));
      const linked = Number(body.publisher_type) === 2 ? linkVideoToCollab(newId) : { collab_id: null, samples: [] };
      writeOpLog({
        user_id: user.id,
        module: '内容中心',
        action: 'create',
        target_table: 'video',
        target_id: newId,
        after: { ...body, tk_video_id: tkVideoId, collab_id: collabId, linked_collab: linked.collab_id, samples_content_done: linked.samples },
        ip: req.ip,
      });
      return { newId, linked };
    });
    const collab = id.linked.collab_id ? get<Record<string, unknown>>(`SELECT collab_no, status FROM collaboration WHERE id = ?`, id.linked.collab_id) : null;
    ok(res, {
      id: id.newId,
      tk_video_id: tkVideoId,
      creator_id: creatorId,
      collab_id: collabId,
      collab_status: collab ? Number(collab.status) : null,
      sample_status: id.linked.samples.length ? SAMPLE_STATUS.CONTENT_DONE : null,
      samples_updated: id.linked.samples,
      hint: '带货订单数 / GMV 由 POST /content/videos/recalc 或汇总作业刷新',
    });
  }),
);

/** 汇总刷新：按 tk_video_id 关联订单明细重算 orders 与净 GMV（人民币） */
contentRouter.post(
  '/videos/recalc',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const refreshed = refreshVideoAggregates();
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'update', target_table: 'video', after: { action: 'recalc-aggregates', refreshed }, ip: req.ip });
    ok(res, { refreshed, at: nowStr(), last_run: nowStr() });
  }),
);

/** 带货排行 Top N */
contentRouter.get(
  '/videos/rank',
  wrap((req, res) => {
    const user = current(req);
    const scope = videoScope(user);
    const top = Math.min(100, intOf(qv(req, 'top')) ?? 10);
    const by = qv(req, 'by') === 'views' ? 'v.views' : 'v.gmv';
    const rows = all<Record<string, unknown>>(
      `SELECT ${videoSelect} FROM ${videoFrom}
        WHERE v.is_deleted = 0 AND v.status = 1 ${scope.sql}
        ORDER BY ${by} DESC, v.gmv DESC LIMIT ?`,
      ...scope.params, top,
    );
    ok(res, {
      by: by === 'v.views' ? 'views' : 'gmv',
      list: rows.map((r, i) => ({ ...decorateVideo(user, r), rank: i + 1 })),
      total: rows.length,
    });
  }),
);

/** 单条视频带货归因明细（订单行 + 净 GMV 汇总） */
contentRouter.get(
  '/videos/:id/attribution',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const scope = videoScope(user);
    const video = get<Record<string, unknown>>(`SELECT * FROM video WHERE id = ? AND is_deleted = 0`, id);
    if (!video) throw notFound('视频不存在');
    if (scope.sql && !get(`SELECT v.id FROM video v WHERE v.id = ? ${scope.sql}`, id, ...scope.params)) throw forbidden('该视频不在你的数据范围内');
    const vid = String(video.tk_video_id ?? '');
    if (!vid) {
      ok(res, { video, list: [], total: 0, summary: { orders: 0, gmv_cny: 0, refund_cny: 0, net_gmv_cny: 0, commission_cny: 0 } });
      return;
    }
    const list = all<Record<string, unknown>>(
      `SELECT i.id AS item_id, i.order_id, o.tk_order_id, o.order_status, o.order_time, o.currency, o.is_sample_order,
              i.quantity, i.unit_price, i.item_amount, i.commission_rate, i.est_commission, i.content_type, i.creator_id,
              s.shop_name, sk.sku_code,
              ROUND(${AMOUNT_CNY}, 2) AS amount_cny,
              ROUND(${REFUND_CNY}, 2) AS refund_cny,
              ROUND(${AMOUNT_CNY} - ${REFUND_CNY}, 2) AS net_gmv_cny,
              ROUND(${AMOUNT_CNY.replace('i.item_amount', 'i.est_commission')}, 2) AS commission_cny
         FROM tk_order_item i
         JOIN tk_order o ON o.id = i.order_id
         LEFT JOIN shop_listing sl ON sl.id = i.listing_id
         LEFT JOIN tk_shop s ON s.id = o.shop_id
         LEFT JOIN product_sku sk ON sk.id = i.sku_id
         ${RATE_JOIN}
         ${REFUND_JOIN}
        WHERE i.is_deleted = 0 AND i.content_id = ?
        ORDER BY o.order_time DESC, i.id DESC LIMIT 200`,
      vid,
    );
    const summary = get<Record<string, number | null>>(
      `SELECT COUNT(DISTINCT CASE WHEN i.item_amount > 0 THEN o.id END) AS orders,
              ROUND(SUM(${AMOUNT_CNY}), 2) AS gmv_cny,
              ROUND(SUM(${REFUND_CNY}), 2) AS refund_cny,
              ROUND(SUM(${AMOUNT_CNY}) - SUM(${REFUND_CNY}), 2) AS net_gmv_cny,
              ROUND(SUM(${AMOUNT_CNY.replace('i.item_amount', 'i.est_commission')}), 2) AS commission_cny
         FROM tk_order_item i
         JOIN tk_order o ON o.id = i.order_id
         ${RATE_JOIN}
         ${REFUND_JOIN}
        WHERE i.is_deleted = 0 AND i.content_id = ? AND ${ATTRIBUTABLE_ORDER}`,
      vid,
    );
    ok(res, {
      video: { ...decorateVideo(user, video), attributed_orders: Number(summary?.orders ?? 0) },
      tk_video_id: vid,
      total: list.length,
      list,
      summary: {
        orders: Number(summary?.orders ?? 0),
        gmv_cny: num(summary?.gmv_cny),
        refund_cny: num(summary?.refund_cny),
        net_gmv_cny: num(summary?.net_gmv_cny),
        commission_cny: num(summary?.commission_cny),
      },
    });
  }),
);

contentRouter.get(
  '/videos/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const scope = videoScope(user);
    const row = get<Record<string, unknown>>(
      `SELECT ${videoSelect} FROM ${videoFrom} WHERE v.id = ? AND v.is_deleted = 0 ${scope.sql}`, id, ...scope.params,
    );
    if (!row) throw notFound('视频不存在或不在你的数据范围内');
    ok(res, decorateVideo(user, row));
  }),
);

contentRouter.put(
  '/videos/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM video WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('视频不存在');
    const body = parseBody(videoBody.partial().omit({ views: true, likes: true, comments: true, shares: true }), req.body);
    let tkVideoId = before.tk_video_id === null || before.tk_video_id === undefined ? null : String(before.tk_video_id);
    if (body.video_url && body.video_url !== String(before.video_url)) {
      const parsed = parseVideoId(body.video_url);
      if (!parsed) throw badRequest(`无法从新链接解析视频 ID，请检查链接：${body.video_url}`);
      const dup = get<{ id: number }>(`SELECT id FROM video WHERE tk_video_id = ? AND id <> ?`, parsed, id);
      if (dup) throw conflict(`该视频已被记录 #${dup.id} 登记（tk_video_id ${parsed}）`);
      tkVideoId = parsed;
    }
    const publisher = intOf(body.publisher_type) ?? Number(before.publisher_type);
    const collabId = body.collab_id === undefined ? (before.collab_id === null ? null : Number(before.collab_id)) : body.collab_id;
    let creatorId = body.creator_id === undefined ? (before.creator_id === null ? null : Number(before.creator_id)) : body.creator_id;
    if (publisher === 2) {
      if (!collabId) throw badRequest('达人视频必须挂合作单（collab_id 必填）');
      const collab = assertCollabUsable(user, collabId, body.editor_id ?? (before.editor_id === null ? null : Number(before.editor_id)));
      if (creatorId !== null && creatorId !== Number(collab.creator_id)) throw badRequest('达人与合作单不是同一人');
      creatorId = Number(collab.creator_id);
    }
    update('video', id, cols({ ...body, tk_video_id: tkVideoId, publisher_type: publisher, collab_id: publisher === 2 ? collabId : null, creator_id: publisher === 2 ? creatorId : null }));
    if (publisher === 2 && collabId) linkVideoToCollab(id);
    logVideoChange(user, req.ip, id, before, { ...before, ...body, tk_video_id: tkVideoId, publisher_type: publisher, collab_id: collabId, creator_id: creatorId });
    ok(res, { id, tk_video_id: tkVideoId });
  }),
);

function logVideoChange(user: CurrentUser, ip: string | undefined, id: number, before: Record<string, unknown>, after: Record<string, unknown>): void {
  writeOpLog({
    user_id: user.id,
    module: '内容中心',
    action: 'update',
    target_table: 'video',
    target_id: id,
    before: { video_url: before.video_url, tk_video_id: before.tk_video_id, spu_id: before.spu_id, editor_id: before.editor_id, collab_id: before.collab_id, creator_id: before.creator_id },
    after: { video_url: after.video_url, tk_video_id: after.tk_video_id, spu_id: after.spu_id, editor_id: after.editor_id, collab_id: after.collab_id, creator_id: after.creator_id },
    ip,
  });
}

contentRouter.delete(
  '/videos/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(`SELECT * FROM video WHERE id = ? AND is_deleted = 0`, id);
    if (!row) throw notFound('视频不存在');
    if (Number(row.created_by ?? -1) !== user.id && !isManager(user) && Number(row.editor_id ?? -1) !== user.id) throw forbidden('只能删除本人登记 / 剪辑的视频');
    softDelete('video', id);
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'delete', target_table: 'video', target_id: id, before: row, ip: req.ip });
    ok(res, { id });
  }),
);

/* ==================== 表 14 直播场次 ==================== */

const liveBody = z.object({
  account_id: z.number().int().positive().nullish(),
  shop_id: z.number().int().positive().nullish(),
  host_id: z.number().int().positive().nullish(),
  assistant_id: z.number().int().positive().nullish(),
  creator_id: z.number().int().positive().nullish(),
  plan_start: z.string().min(10).max(20),
  plan_end: z.string().min(10).max(20),
  actual_start: z.string().max(20).nullish(),
  actual_end: z.string().max(20).nullish(),
  viewers: z.number().int().min(0).default(0),
  peak_online: z.number().int().min(0).default(0),
  orders: z.number().int().min(0).default(0),
  gmv: z.number().min(0).default(0),
  ad_spend: z.number().min(0).nullish(),
  review_note: z.string().max(2000).nullish(),
  status: z.number().int().min(1).max(4).default(1),
});

const liveFrom = `live_session l
     LEFT JOIN tk_account a ON a.id = l.account_id
     LEFT JOIN tk_shop s ON s.id = l.shop_id
     LEFT JOIN sys_user h ON h.id = l.host_id
     LEFT JOIN sys_user as2 ON as2.id = l.assistant_id
     LEFT JOIN creator c ON c.id = l.creator_id`;
const liveSelect = `l.*, a.handle AS account_handle, a.nickname AS account_nickname, s.shop_name, s.currency AS shop_currency, s.region,
       h.real_name AS host_name, as2.real_name AS assistant_name, c.handle AS creator_handle`;

function decorateLive(user: CurrentUser, row: Record<string, unknown>): Record<string, unknown> {
  const viewers = Number(row.viewers ?? 0);
  const gmv = num(row.gmv);
  const currency = String(row.shop_currency ?? 'USD');
  const rate = exchangeRate(currency, String(row.plan_start ?? '').slice(0, 10));
  return {
    ...row,
    duration_hours: hoursBetween(row.actual_start, row.actual_end),
    gpm: gpmOf(gmv, viewers),
    gmv_cny: round2(gmv * rate),
    rate_to_cny: rate,
    avg_order_value: Number(row.orders ?? 0) > 0 ? round2(gmv / Number(row.orders)) : 0,
    can_review: user.data_scope === DATA_SCOPE.ALL || Number(row.host_id ?? -1) === user.id || Number(row.assistant_id ?? -1) === user.id,
  };
}

contentRouter.get(
  '/lives',
  wrap((req, res) => {
    const user = current(req);
    const q = liveQ(req, user);
    const page = queryPage(req, {
      from: liveFrom,
      select: liveSelect,
      q,
      orderBy: orderByOf(req, { plan_start: 'l.plan_start', gmv: 'l.gmv', viewers: 'l.viewers', orders: 'l.orders', id: 'l.id' }, 'l.plan_start DESC, l.id DESC'),
    });
    ok(res, { ...page, list: page.list.map((r) => decorateLive(user, r)) });
  }),
);

/** 排班日历：month=YYYY-MM，按日期分组（倒序），一天内按计划时间正序 */
contentRouter.get(
  '/lives/calendar',
  wrap((req, res) => {
    const user = current(req);
    const month = (qv(req, 'month') ?? new Date().toISOString().slice(0, 7)).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month 格式应为 YYYY-MM');
    const scope = liveScope(user);
    const rows = all<Record<string, unknown>>(
      `SELECT ${liveSelect} FROM ${liveFrom}
        WHERE l.is_deleted = 0 AND substr(l.plan_start, 1, 7) = ? ${scope.sql}
        ORDER BY l.plan_start ASC`,
      month, ...scope.params,
    );
    const days = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const day = String(r.plan_start ?? '').slice(0, 10) || '未定';
      const list = days.get(day) ?? [];
      list.push(decorateLive(user, r));
      days.set(day, list);
    }
    ok(res, {
      month,
      total: rows.length,
      days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list]) => ({
        date,
        count: list.length,
        gmv: round2(list.reduce((s, x) => s + num(x.gmv_cny), 0)),
        viewers: list.reduce((s, x) => s + Number(x.viewers ?? 0), 0),
        list,
      })),
    });
  }),
);

/** 开播前提醒清单（默认次日；alert=1 时同时推送告警） */
contentRouter.get(
  '/lives/reminder',
  wrap((req, res) => {
    const user = current(req);
    const days = intOf(qv(req, 'days')) ?? 1;
    const scope = liveScope(user);
    const list = all<Record<string, unknown>>(
      `SELECT ${liveSelect} FROM ${liveFrom}
        WHERE l.is_deleted = 0 AND l.status = 1
          AND date(l.plan_start) BETWEEN date('now') AND date('now', ?) ${scope.sql}
        ORDER BY l.plan_start ASC LIMIT 200`,
      `+${Math.max(0, days)} day`, ...scope.params,
    ).map((r) => decorateLive(user, r));
    const alerted = qv(req, 'alert') === '1' ? remindUpcomingLives(days) : 0;
    ok(res, { days, total: list.length, alerted, list });
  }),
);

/** 主播排行：场次 / 时长 / 场均 GMV / GPM / 投流花费 */
contentRouter.get(
  '/lives/host-rank',
  wrap((req, res) => {
    const user = current(req);
    const scope = liveScope(user);
    const from = qv(req, 'start_date') ?? null;
    const to = qv(req, 'end_date') ?? null;
    const rows = all<Record<string, unknown>>(
      `SELECT l.host_id AS host_id, h.real_name AS host_name, h.dept AS dept,
              COUNT(*) AS sessions,
              SUM(CASE WHEN l.actual_start IS NOT NULL AND l.actual_end IS NOT NULL THEN (julianday(l.actual_end) - julianday(l.actual_start)) * 24 ELSE 0 END) AS hours,
              COALESCE(SUM(l.gmv), 0) AS gmv,
              COALESCE(SUM(l.gmv * COALESCE((SELECT e.rate_to_cny FROM exchange_rate e
                WHERE e.currency = COALESCE(s.currency, 'USD') AND e.is_deleted = 0
                  AND e.rate_date <= substr(COALESCE(l.actual_end, l.plan_start), 1, 10)
                ORDER BY e.rate_date DESC LIMIT 1), 1)), 0) AS gmv_cny,
              COALESCE(SUM(l.viewers), 0) AS viewers,
              COALESCE(SUM(l.orders), 0) AS orders,
              COALESCE(SUM(l.ad_spend * COALESCE((SELECT e.rate_to_cny FROM exchange_rate e
                WHERE e.currency = COALESCE(s.currency, 'USD') AND e.is_deleted = 0
                  AND e.rate_date <= substr(COALESCE(l.actual_end, l.plan_start), 1, 10)
                ORDER BY e.rate_date DESC LIMIT 1), 1)), 0) AS ad_spend_cny,
              COALESCE(SUM(CASE WHEN l.review_note IS NOT NULL AND l.review_note <> '' THEN 1 ELSE 0 END), 0) AS reviewed
         FROM live_session l
         LEFT JOIN sys_user h ON h.id = l.host_id
         LEFT JOIN tk_shop s ON s.id = l.shop_id
        WHERE l.is_deleted = 0 AND l.status = 3 ${scope.sql}
          ${from ? `AND l.plan_start >= ?` : ''} ${to ? `AND l.plan_start <= ?` : ''}
        GROUP BY l.host_id, h.real_name, h.dept
        ORDER BY gmv_cny DESC`,
      ...scope.params,
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    );
    const list = rows.map((r) => {
      const sessions = Number(r.sessions ?? 0);
      const hours = round2(num(r.hours));
      const viewers = Number(r.viewers ?? 0);
      const gmvCny = round2(num(r.gmv_cny));
      return {
        host_id: r.host_id === null || r.host_id === undefined ? null : Number(r.host_id),
        host_name: r.host_name ?? '未指定主播',
        dept: r.dept ?? null,
        sessions,
        hours,
        gmv: round2(num(r.gmv)),
        gmv_cny: gmvCny,
        avg_gmv_per_session: sessions ? round2(gmvCny / sessions) : 0,
        gmv_per_hour: hours > 0 ? round2(gmvCny / hours) : 0,
        viewers,
        orders: Number(r.orders ?? 0),
        gpm: gpmOf(gmvCny, viewers),
        ad_spend_cny: round2(num(r.ad_spend_cny)),
        reviewed: Number(r.reviewed ?? 0),
      };
    });
    ok(res, { total: list.length, list });
  }),
);

/** 新建排班（状态 1 已排班）；同账号时段重叠 → 409 */
contentRouter.post(
  '/lives',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(liveBody, req.body);
    if (tsOf(body.plan_start) >= tsOf(body.plan_end)) throw badRequest('计划开播时间必须早于计划下播时间');
    let shopId = intOf(body.shop_id);
    if (body.account_id) {
      const acc = get<Record<string, unknown>>(`SELECT id, handle, shop_id FROM tk_account WHERE id = ? AND is_deleted = 0`, body.account_id);
      if (!acc) throw notFound('直播账号不存在');
      if (!shopId) shopId = acc.shop_id === null || acc.shop_id === undefined ? null : Number(acc.shop_id);
    }
    if (!shopId) throw badRequest('必须选择店铺（或选择已绑定店铺的直播账号）');
    const shop = get<Record<string, unknown>>(`SELECT id, shop_name FROM tk_shop WHERE id = ? AND is_deleted = 0`, shopId);
    if (!shop) throw notFound('店铺不存在');
    for (const [label, key] of [['主播', 'host_id'], ['场控', 'assistant_id']] as const) {
      const v = intOf(body[key]);
      if (v !== null && !get(`SELECT id FROM sys_user WHERE id = ? AND is_deleted = 0`, v)) throw notFound(`${label}不存在`);
    }
    if (body.creator_id && !get(`SELECT id FROM creator WHERE id = ? AND is_deleted = 0`, body.creator_id)) throw notFound('达人不存在');
    // 主播 / 剪辑（仅本人范围）自己建的场次只能自己看到，允许选任意店铺；组 / 店铺范围角色必须落在范围内
    const boundToShops = user.data_scope === DATA_SCOPE.SHOPS || user.data_scope === DATA_SCOPE.DEPT;
    const scope = shopScope(user, 'x.id');
    if (boundToShops && scope.sql && !get(`SELECT x.id FROM tk_shop x WHERE x.id = ? ${scope.sql}`, shopId, ...scope.params)) {
      throw forbidden('该店铺不在你的数据范围内');
    }
    if (body.account_id) {
      const clash = get<{ id: number; plan_start: string }>(
        `SELECT id, plan_start FROM live_session WHERE is_deleted = 0 AND status IN (1, 2) AND account_id = ?
           AND plan_start < ? AND plan_end > ?`,
        body.account_id, body.plan_end, body.plan_start,
      );
      if (clash) throw conflict(`账号在该时段已有排班（场次 #${clash.id}，${clash.plan_start}），请改时间或换账号`);
    }
    const id = insert('live_session', cols({
      ...body,
      shop_id: shopId,
      status: body.status ?? 1,
      ad_spend: body.ad_spend ?? 0,
      created_by: user.id,
    }));
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'create', target_table: 'live_session', target_id: id, after: body, ip: req.ip });
    ok(res, { id, status: body.status ?? 1, shop_id: shopId });
  }),
);

function loadLive(id: number, user: CurrentUser): Record<string, unknown> {
  const row = get<Record<string, unknown>>(`SELECT ${liveSelect} FROM ${liveFrom} WHERE l.id = ? AND l.is_deleted = 0`, id);
  if (!row) throw notFound('直播场次不存在');
  const scope = liveScope(user);
  if (scope.sql && !get(`SELECT l.id FROM ${liveFrom} WHERE l.id = ? AND l.is_deleted = 0 ${scope.sql}`, id, ...scope.params)) {
    throw forbidden('该场次不在你的数据范围内');
  }
  return row;
}

contentRouter.put(
  '/lives/:id',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = loadLive(id, user);
    const body = parseBody(liveBody.partial(), req.body);
    if (tsOf(body.plan_start ?? before.plan_start) >= tsOf(body.plan_end ?? before.plan_end)) throw badRequest('计划开播时间必须早于计划下播时间');
    if (Number(before.status) === 4 && !isManager(user)) throw forbidden('已取消的场次不能修改');
    const accountId = intOf(body.account_id) ?? (before.account_id === null ? null : Number(before.account_id));
    if (accountId && (body.plan_start || body.plan_end)) {
      const clash = get<{ id: number }>(
        `SELECT id FROM live_session WHERE is_deleted = 0 AND status IN (1, 2) AND account_id = ? AND id <> ?
           AND plan_start < ? AND plan_end > ?`,
        accountId, id,
        String(body.plan_end ?? before.plan_end ?? ''), String(body.plan_start ?? before.plan_start ?? ''),
      );
      if (clash) throw conflict(`账号在该时段已有其它排班（场次 #${clash.id}）`);
    }
    update('live_session', id, cols(body));
    writeOpLog({
      user_id: user.id,
      module: '内容中心',
      action: 'update',
      target_table: 'live_session',
      target_id: id,
      before: { plan_start: before.plan_start, plan_end: before.plan_end, host_id: before.host_id, assistant_id: before.assistant_id, account_id: before.account_id, status: before.status },
      after: { ...before, ...body },
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

/** 开播：写 actual_start → 状态 2 直播中 */
contentRouter.post(
  '/lives/:id/start',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadLive(id, user);
    if (Number(row.status) === 3) throw badRequest('该场次已结束');
    if (Number(row.status) === 4) throw badRequest('该场次已取消');
    if (Number(row.status) === 2) throw badRequest('该场次已在直播中');
    const body = parseBody(z.object({ actual_start: z.string().max(20).nullish() }), req.body);
    const actual_start = body.actual_start || nowStr();
    update('live_session', id, cols({ actual_start, status: 2 }));
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'update', target_table: 'live_session', target_id: id, before: { status: row.status, actual_start: row.actual_start }, after: { status: 2, actual_start }, ip: req.ip });
    ok(res, { id, status: 2, actual_start });
  }),
);

/** 下播：写 actual_end + 场观/GMV/订单；ad_spend 缺省时从 ad_daily（同店同日 GMV Max 直播）汇总 */
contentRouter.post(
  '/lives/:id/finish',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadLive(id, user);
    if (Number(row.status) === 4) throw badRequest('该场次已取消，不能结束');
    const body = parseBody(z.object({
      actual_end: z.string().max(20).optional(),
      viewers: z.number().int().min(0).optional(),
      peak_online: z.number().int().min(0).optional(),
      orders: z.number().int().min(0).optional(),
      gmv: z.number().min(0).optional(),
      ad_spend: z.number().min(0).optional(),
      review_note: z.string().max(2000).optional(),
    }), req.body);
    const actual_end = body.actual_end || nowStr();
    const start = String(row.actual_start ?? row.plan_start ?? '');
    const statDate = start.slice(0, 10);
    const currency = String(row.shop_currency ?? 'USD');
    const shopRate = exchangeRate(currency, statDate) || 1;
    let adSpend: number;
    let adSpendCny: number;
    let adSource: 'manual' | 'ad_daily' | 'none' = 'none';
    if (body.ad_spend !== undefined && body.ad_spend !== null) {
      // 手工填的花费按店铺币种记账（与 live_session.gmv 口径一致）
      adSpend = round2(body.ad_spend);
      adSpendCny = round2(adSpend * shopRate);
      adSource = 'manual';
    } else {
      const spendCny = num(scalar<number>(
        `SELECT COALESCE(SUM(ad.spend * COALESCE((SELECT e.rate_to_cny FROM exchange_rate e
               WHERE e.currency = ad.currency AND e.is_deleted = 0 AND e.rate_date <= ad.stat_date
               ORDER BY e.rate_date DESC LIMIT 1), 1)), 0)
           FROM ad_daily ad
          WHERE ad.is_deleted = 0 AND ad.shop_id = ? AND ad.stat_date = ? AND ad.ad_type = 2`,
        Number(row.shop_id), statDate,
      ));
      if (spendCny > 0) {
        adSpendCny = round2(spendCny);
        adSpend = round2(spendCny / shopRate);
        adSource = 'ad_daily';
      } else {
        adSpend = round2(num(row.ad_spend));
        adSpendCny = round2(adSpend * shopRate);
      }
    }
    const patch = cols({
      actual_end,
      status: 3,
      viewers: body.viewers === undefined ? row.viewers : body.viewers,
      peak_online: body.peak_online === undefined ? row.peak_online : body.peak_online,
      orders: body.orders === undefined ? row.orders : body.orders,
      gmv: body.gmv === undefined ? row.gmv : body.gmv,
      ad_spend: adSpend,
      review_note: body.review_note ?? (row.review_note as string | null),
    });
    update('live_session', id, patch);
    writeOpLog({
      user_id: user.id,
      module: '内容中心',
      action: 'update',
      target_table: 'live_session',
      target_id: id,
      before: { status: row.status, actual_end: row.actual_end, viewers: row.viewers, gmv: row.gmv, ad_spend: row.ad_spend },
      after: { ...patch, ad_spend_cny: adSpendCny, ad_spend_source: adSource },
      ip: req.ip,
    });
    ok(res, {
      id,
      status: 3,
      actual_end,
      duration_hours: hoursBetween(start, actual_end),
      currency,
      ad_spend: adSpend,
      ad_spend_cny: adSpendCny,
      ad_spend_source: adSource,
    });
  }),
);

/** 复盘：仅主播 / 场控本人（或主管 / 老板）可写 */
contentRouter.post(
  '/lives/:id/review',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadLive(id, user);
    const isSelf = Number(row.host_id ?? -1) === user.id || Number(row.assistant_id ?? -1) === user.id;
    if (!isSelf && !isManager(user) && user.role_key !== 'boss' && Number(row.created_by ?? -1) !== user.id) {
      throw forbidden('只有该场次的主播 / 场控可以写复盘');
    }
    const body = parseBody(z.object({ review_note: z.string().min(1).max(2000), ad_spend: z.number().min(0).nullish() }), req.body);
    update('live_session', id, cols({ review_note: body.review_note, ...(body.ad_spend !== undefined ? { ad_spend: body.ad_spend } : {}) }));
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'update', target_table: 'live_session', target_id: id, before: { review_note: row.review_note }, after: { review_note: body.review_note }, ip: req.ip });
    ok(res, { id, review_note: body.review_note });
  }),
);

/** 取消排班 */
contentRouter.post(
  '/lives/:id/cancel',
  canWrite,
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const row = loadLive(id, user);
    if (Number(row.status) === 3) throw badRequest('已结束的场次不能取消');
    update('live_session', id, cols({ status: 4 }));
    writeOpLog({ user_id: user.id, module: '内容中心', action: 'update', target_table: 'live_session', target_id: id, before: { status: row.status }, after: { status: 4, reason: qv(req, 'reason') ?? null }, ip: req.ip });
    ok(res, { id, status: 4 });
  }),
);

/* ==================== 内容汇总（供前端图表） ==================== */

function summaryHandler() {
  return wrap((req, res) => {
    const user = current(req);
    const vs = videoScope(user);
    const ls = liveScope(user);
    const from = qv(req, 'start_date') ?? null;
    const to = qv(req, 'end_date') ?? null;
    const vRange = [from ? `AND v.publish_time >= ?` : '', to ? `AND v.publish_time <= ?` : ''].join(' ');
    const lRange = [from ? `AND l.plan_start >= ?` : '', to ? `AND l.plan_start <= ?` : ''].join(' ');
    const vParams = [...vs.params, ...(from ? [from] : []), ...(to ? [to] : [])];
    const lParams = [...ls.params, ...(from ? [from] : []), ...(to ? [to] : [])];

    const video = get<Record<string, unknown>>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(v.views),0) AS views, COALESCE(SUM(v.likes),0) AS likes,
              COALESCE(SUM(v.orders),0) AS orders, COALESCE(ROUND(SUM(v.gmv),2),0) AS gmv_cny
         FROM video v WHERE v.is_deleted = 0 ${vs.sql} ${vRange}`, ...vParams,
    );
    const live = get<Record<string, unknown>>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(l.viewers),0) AS viewers, COALESCE(SUM(l.orders),0) AS orders,
              COALESCE(SUM(l.gmv),0) AS gmv_raw,
              COALESCE(ROUND(SUM(l.gmv * (SELECT e.rate_to_cny FROM exchange_rate e WHERE e.currency = COALESCE(s.currency,'USD') AND e.is_deleted = 0 AND e.rate_date <= substr(COALESCE(l.actual_end, l.plan_start), 1, 10) ORDER BY e.rate_date DESC LIMIT 1)), 2), 0) AS gmv_cny,
              COALESCE(SUM(l.ad_spend),0) AS ad_spend,
              COALESCE(ROUND(SUM(CASE WHEN l.actual_start IS NOT NULL AND l.actual_end IS NOT NULL THEN (julianday(l.actual_end) - julianday(l.actual_start)) * 24 ELSE 0 END)), 2) AS hours
         FROM live_session l LEFT JOIN tk_shop s ON s.id = l.shop_id
        WHERE l.is_deleted = 0 ${ls.sql} ${lRange}`, ...lParams,
    );

    const publisherSplit = all<Record<string, unknown>>(
      `SELECT v.publisher_type AS publisher_type, COUNT(*) AS cnt, COALESCE(SUM(v.views),0) AS views,
              COALESCE(SUM(v.orders),0) AS orders, COALESCE(ROUND(SUM(v.gmv),2),0) AS gmv_cny
         FROM video v WHERE v.is_deleted = 0 ${vs.sql} ${vRange}
        GROUP BY v.publisher_type`, ...vParams,
    ).map((r) => ({
      publisher_type: Number(r.publisher_type),
      label: Number(r.publisher_type) === 2 ? '达人' : '自有账号',
      videos: Number(r.cnt ?? 0),
      views: Number(r.views ?? 0),
      orders: Number(r.orders ?? 0),
      gmv_cny: num(r.gmv_cny),
      gmv_share: 0,
    }));
    const totalGmv = round2(publisherSplit.reduce((s, x) => s + x.gmv_cny, 0));
    for (const p of publisherSplit) p.gmv_share = totalGmv > 0 ? round2((p.gmv_cny / totalGmv) * 100) : 0;

    const liveSplit = all<Record<string, unknown>>(
      `SELECT CASE WHEN l.creator_id IS NULL THEN '自营直播' ELSE '达人专场' END AS kind, COUNT(*) AS cnt,
              COALESCE(SUM(l.viewers),0) AS viewers, COALESCE(SUM(l.orders),0) AS orders,
              COALESCE(ROUND(SUM(l.gmv * (SELECT e.rate_to_cny FROM exchange_rate e WHERE e.currency = COALESCE(s.currency,'USD') AND e.is_deleted = 0 AND e.rate_date <= substr(COALESCE(l.actual_end, l.plan_start), 1, 10) ORDER BY e.rate_date DESC LIMIT 1)), 2), 0) AS gmv_cny
         FROM live_session l LEFT JOIN tk_shop s ON s.id = l.shop_id
        WHERE l.is_deleted = 0 ${ls.sql} ${lRange}
        GROUP BY kind`, ...lParams,
    ).map((r) => ({ kind: String(r.kind), sessions: Number(r.cnt ?? 0), viewers: Number(r.viewers ?? 0), orders: Number(r.orders ?? 0), gmv_cny: num(r.gmv_cny) }));

    const contentTypeSplit = all<Record<string, unknown>>(
      `SELECT i.content_type AS content_type, COUNT(DISTINCT CASE WHEN i.item_amount > 0 THEN o.id END) AS orders,
              ROUND(SUM(${AMOUNT_CNY}) - SUM(${REFUND_CNY}), 2) AS net_gmv_cny
         FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id ${RATE_JOIN} ${REFUND_JOIN}
        WHERE i.is_deleted = 0 AND ${ATTRIBUTABLE_ORDER} ${from ? `AND o.order_time >= ?` : ''} ${to ? `AND o.order_time <= ?` : ''}
        GROUP BY i.content_type ORDER BY net_gmv_cny DESC`,
      ...(from ? [from] : []), ...(to ? [to] : []),
    ).map((r) => ({
      content_type: r.content_type === null || r.content_type === undefined ? null : Number(r.content_type),
      label: Object.entries(CONTENT_TYPE).find(([, v]) => v === Number(r.content_type))?.[0] ?? '未归因',
      orders: Number(r.orders ?? 0),
      net_gmv_cny: num(r.net_gmv_cny),
    }));

    const topVideo = get<Record<string, unknown>>(
      `SELECT v.id, v.tk_video_id, v.gmv, v.orders, v.views, c.handle AS creator_handle FROM video v
        LEFT JOIN creator c ON c.id = v.creator_id WHERE v.is_deleted = 0 ${vs.sql} ORDER BY v.gmv DESC LIMIT 1`,
      ...vs.params,
    );
    ok(res, {
      range: { start_date: from, end_date: to },
      video: {
        count: Number(video?.cnt ?? 0),
        views: Number(video?.views ?? 0),
        likes: Number(video?.likes ?? 0),
        orders: Number(video?.orders ?? 0),
        gmv_cny: num(video?.gmv_cny),
        gpm: gpmOf(num(video?.gmv_cny), Number(video?.views ?? 0)),
        top: topVideo ?? null,
      },
      live: {
        count: Number(live?.cnt ?? 0),
        viewers: Number(live?.viewers ?? 0),
        orders: Number(live?.orders ?? 0),
        gmv: num(live?.gmv_raw),
        gmv_cny: num(live?.gmv_cny),
        ad_spend: num(live?.ad_spend),
        hours: num(live?.hours),
        gpm: gpmOf(num(live?.gmv_cny), Number(live?.viewers ?? 0)),
      },
      publisher_split: publisherSplit,
      live_split: liveSplit,
      content_type_split: contentTypeSplit,
      note: 'video.gmv_cny = 净 GMV 折人民币（排除样品单 / 已取消，扣已完成退款）；live.gmv 为场次登记原值，gmv_cny 按店铺币种折算',
    });
  });
}

contentRouter.get('/content/summary', summaryHandler());
contentRouter.get('/summary', summaryHandler());

/* ---------------- 内容侧的达人 / 合作单下拉（跨模块只读取数，脱敏） ---------------- */

contentRouter.get(
  '/options/creators',
  wrap((req, res) => {
    const user = current(req);
    const list = queryList({
      from: `creator c LEFT JOIN sys_user u ON u.id = c.owner_id`,
      q: new Q(`c.is_deleted = 0 AND c.pool_status IN (${POOL_STATUS.PRIVATE}, ${POOL_STATUS.COOPERATING})`)
        .like(`c.handle LIKE ? OR c.nickname LIKE ?`, qv(req, 'keyword')),
      select: `c.id, c.handle, c.nickname, c.region, c.followers, c.pool_status, u.real_name AS owner_name`,
      orderBy: 'c.followers DESC',
      limit: 100,
    });
    ok(res, list);
  }),
);

contentRouter.get(
  '/options/collabs',
  wrap((req, res) => {
    const user = current(req);
    const scope = personScope(user, 'l.owner_id', true);
    const q = new Q(`l.is_deleted = 0 AND l.status NOT IN (${COLLAB_STATUS.CANCELLED})`)
      .and(scope.sql || '', ...scope.params)
      .eq('l.creator_id', qv(req, 'creator_id'))
      .like(`l.collab_no LIKE ? OR c.handle LIKE ?`, qv(req, 'keyword'));
    ok(res, queryList({
      from: `collaboration l JOIN creator c ON c.id = l.creator_id LEFT JOIN product_spu p ON p.id = l.spu_id`,
      select: `l.id, l.collab_no, l.creator_id, l.shop_id, l.spu_id, l.status, l.promised_videos, c.handle AS creator_handle, p.name_cn AS spu_name,
               (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 AND v.collab_id = l.id) AS video_count`,
      q,
      orderBy: 'l.id DESC',
      limit: 100,
    }));
  }),
);

export default contentRouter;
