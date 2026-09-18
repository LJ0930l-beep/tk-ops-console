import { Router } from 'express';
import { z } from 'zod';
import { SHOP_AUTH_STATUS, type CurrentUser } from '@tk/shared';
import { get, insert, softDelete, update } from '../core/db.js';
import { forbidden, notFound, ok, parseBody, wrap } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { encryptSecret, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';

export const current = (req: object): CurrentUser => (req as AuthedRequest).user;

/** 授权到期前 7 天自动标记「即将过期」（方案表 1 token_expire_at） */
function withAuthExpiry<T extends Record<string, unknown>>(row: T): T {
  const exp = row.token_expire_at ? Date.parse(String(row.token_expire_at).replace(' ', 'T') + 'Z') : 0;
  if (Number(row.auth_status) === SHOP_AUTH_STATUS.AUTHORIZED && exp && exp - Date.now() < 7 * 86400_000) {
    return { ...row, auth_status: SHOP_AUTH_STATUS.EXPIRING };
  }
  return row;
}

/* ==================== 表 1 店铺 tk_shop ==================== */
export const shopRouter = Router();

const shopBody = z.object({
  shop_name: z.string().min(1).max(100),
  tk_shop_id: z.string().max(64).nullish(),
  shop_cipher: z.string().max(128).nullish(),
  region: z.string().min(2).max(8),
  shop_type: z.union([z.literal(1), z.literal(2)]).default(1),
  currency: z.string().length(3),
  timezone: z.string().max(32).default('Asia/Shanghai'),
  auth_status: z.number().int().min(0).max(3).default(SHOP_AUTH_STATUS.UNAUTHORIZED),
  token_expire_at: z.string().nullish(),
  owner_id: z.number().int().nullish(),
  status: z.number().int().min(1).max(3).default(1),
});

function shopQuery(req: object, alias = 's'): Q {
  const q = new Q(`${alias}.is_deleted = 0`);
  const scope = shopScope(current(req), `${alias}.id`);
  return q.and(scope.sql || '', ...scope.params);
}

shopRouter.get(
  '/',
  requireMenu('shop'),
  wrap((req, res) => {
    const q = shopQuery(req)
      .like(`s.shop_name LIKE ?`, req.query.keyword)
      .eq('s.region', req.query.region, false)
      .eq('s.shop_type', req.query.shop_type)
      .eq('s.status', req.query.status)
      .eq('s.owner_id', req.query.owner_id);
    if (req.query.auth_status !== undefined && req.query.auth_status !== '') q.eq('s.auth_status', req.query.auth_status);
    const page = queryPage(req, {
      from: `tk_shop s LEFT JOIN sys_user ou ON ou.id = s.owner_id`,
      select: 's.*, ou.real_name AS owner_name',
      q,
      orderBy: 's.id DESC',
    });
    ok(res, { ...page, list: page.list.map(withAuthExpiry) });
  }),
);

shopRouter.get(
  '/all',
  wrap((_req, res) =>
    ok(res, queryList({ from: 'tk_shop', q: new Q('is_deleted = 0'), select: 'id, shop_name, region, currency, timezone, auth_status', orderBy: 'shop_name ASC', limit: 200 })),
  ),
);

/** 当前用户可见店铺（前端店铺下拉统一入口） */
shopRouter.get(
  '/mine',
  wrap((req, res) => {
    const scope = shopScope(current(req), 's.id');
    const q = new Q('s.is_deleted = 0').and(scope.sql || '', ...scope.params);
    ok(res, queryList({ from: 'tk_shop s', select: 's.id, s.shop_name, s.region, s.currency, s.timezone', q, orderBy: 's.shop_name ASC' }));
  }),
);

shopRouter.get(
  '/:id',
  requireMenu('shop'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    const row = get<Record<string, unknown>>(
      `SELECT s.*, ou.real_name AS owner_name FROM tk_shop s LEFT JOIN sys_user ou ON ou.id = s.owner_id WHERE s.id = ? AND s.is_deleted = 0`,
      id,
    );
    if (!row) throw notFound('店铺不存在');
    const scope = shopScope(current(req), 's.id');
    if (scope.sql && !scope.params.includes(id)) throw forbidden('该店铺不在你的数据范围内');
    ok(res, withAuthExpiry(row));
  }),
);

shopRouter.post(
  '/',
  requireMenu('shop'),
  wrap((req, res) => {
    const body = parseBody(shopBody, req.body);
    const id = insert('tk_shop', { ...body, created_by: current(req).id });
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'create', target_table: 'tk_shop', target_id: id, after: body, ip: req.ip });
    ok(res, { id });
  }),
);

shopRouter.put(
  '/:id',
  requireMenu('shop'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM tk_shop WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('店铺不存在');
    const body = parseBody(shopBody.partial(), req.body);
    update('tk_shop', id, body as never);
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'update', target_table: 'tk_shop', target_id: id, before, after: { ...before, ...body }, ip: req.ip });
    ok(res, { id });
  }),
);

shopRouter.delete(
  '/:id',
  requireMenu('shop'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM tk_shop WHERE id = ? AND is_deleted = 0`, id)) throw notFound('店铺不存在');
    if (get(`SELECT id FROM tk_order WHERE shop_id = ? AND is_deleted = 0 LIMIT 1`, id)) throw forbidden('该店铺已有订单，不能删除（可改为暂停/关店）');
    softDelete('tk_shop', id);
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'delete', target_table: 'tk_shop', target_id: id, ip: req.ip });
    ok(res, { id });
  }),
);

/** 重新授权：接口凭证 AES-GCM 加密保存，明文不出现在页面与日志（方案 6.4） */
shopRouter.post(
  '/:id/auth',
  requireMenu('shop'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM tk_shop WHERE id = ? AND is_deleted = 0`, id)) throw notFound('店铺不存在');
    const body = parseBody(
      z.object({ app_key: z.string().min(1), app_secret: z.string().min(1), shop_cipher: z.string().optional(), token_expire_at: z.string().optional() }),
      req.body,
    );
    update('tk_shop', id, {
      app_key_enc: encryptSecret(body.app_key),
      app_secret_enc: encryptSecret(body.app_secret),
      shop_cipher: body.shop_cipher ?? null,
      auth_status: SHOP_AUTH_STATUS.AUTHORIZED,
      token_expire_at: body.token_expire_at ?? null,
    } as never);
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'update', target_table: 'tk_shop', target_id: id, after: { auth: 'renewed' }, ip: req.ip });
    ok(res, { id });
  }),
);

/* ==================== 表 2 TikTok 账号 tk_account ==================== */
export const accountRouter = Router();
accountRouter.use(requireMenu('shop'));

const accountBody = z.object({
  handle: z.string().min(2).max(64),
  nickname: z.string().max(100).nullish(),
  account_type: z.number().int().min(1).max(3).default(2),
  shop_id: z.number().int().nullish(),
  region: z.string().max(8).nullish(),
  followers: z.number().int().min(0).default(0),
  owner_id: z.number().int().nullish(),
  account_status: z.number().int().min(1).max(4).default(1),
  remark: z.string().max(500).nullish(),
});

accountRouter.get(
  '/',
  wrap((req, res) => {
    const scope = shopScope(current(req), 'a.shop_id');
    const q = new Q('a.is_deleted = 0')
      .and(scope.sql || '', ...scope.params)
      .like(`a.handle LIKE ? OR a.nickname LIKE ?`, req.query.keyword)
      .eq('a.shop_id', req.query.shop_id)
      .eq('a.account_type', req.query.account_type)
      .eq('a.account_status', req.query.account_status);
    ok(res, queryPage(req, {
      from: `tk_account a LEFT JOIN tk_shop s ON s.id = a.shop_id LEFT JOIN sys_user ou ON ou.id = a.owner_id`,
      select: 'a.*, s.shop_name, ou.real_name AS owner_name',
      q,
      orderBy: 'a.id DESC',
    }));
  }),
);

accountRouter.post(
  '/',
  wrap((req, res) => {
    const body = parseBody(accountBody, req.body);
    const handle = body.handle.trim().toLowerCase().replace(/^@+/, '');
    const id = insert('tk_account', { ...body, handle, created_by: current(req).id });
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'create', target_table: 'tk_account', target_id: id, after: body, ip: req.ip });
    ok(res, { id });
  }),
);

accountRouter.put(
  '/:id',
  wrap((req, res) => {
    const id = Number(req.params.id);
    const before = get<Record<string, unknown>>(`SELECT * FROM tk_account WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('账号不存在');
    const body = parseBody(accountBody.partial(), req.body);
    if (body.handle) body.handle = body.handle.trim().toLowerCase().replace(/^@+/, '');
    update('tk_account', id, body as never);
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'update', target_table: 'tk_account', target_id: id, before, after: { ...before, ...body }, ip: req.ip });
    ok(res, { id });
  }),
);

accountRouter.delete(
  '/:id',
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!get(`SELECT id FROM tk_account WHERE id = ? AND is_deleted = 0`, id)) throw notFound('账号不存在');
    softDelete('tk_account', id);
    writeOpLog({ user_id: current(req).id, module: '店铺与账号', action: 'delete', target_table: 'tk_account', target_id: id, ip: req.ip });
    ok(res, { id });
  }),
);
