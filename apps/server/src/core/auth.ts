import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { MASK, DATA_SCOPE, type CurrentUser, type MenuKey } from '@tk/shared';
import { config } from '../config.js';
import { all, get } from './db.js';
import { forbidden, unauthorized } from './http.js';

/* ---------- 密码：只存加密摘要（scrypt，不存明文） ---------- */

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [algo, salt, hash] = (stored ?? '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(plain, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

/* ---------- 接口凭证加密保存（方案 6.4：不出现在页面和日志里） ---------- */

const key = crypto.createHash('sha256').update(config.jwtSecret).digest();
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  const [iv, tag, data] = stored.split('.');
  if (!iv || !tag || !data) return '';
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/* ---------- Token ---------- */

export interface JwtPayload {
  sub: number;
  username: string;
}

export const signToken = (u: JwtPayload): string => jwt.sign(u, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });

export const verifyToken = (token: string): JwtPayload => jwt.verify(token, config.jwtSecret) as unknown as JwtPayload;

export function loadUser(userId: number): CurrentUser | null {
  const row = get<Record<string, unknown>>(
    `SELECT u.id, u.username, u.real_name, u.dept, u.role_id, r.role_key, r.role_name, r.data_scope,
            r.can_see_cost, r.can_see_contact, r.can_export, r.menu_perms
       FROM sys_user u JOIN sys_role r ON r.id = u.role_id
      WHERE u.id = ? AND u.is_deleted = 0 AND u.status = 1`,
    userId,
  );
  if (!row) return null;
  const shopIds = all<{ shop_id: number }>(
    `SELECT shop_id FROM sys_user_shop WHERE user_id = ? AND is_deleted = 0`,
    userId,
  ).map((r) => r.shop_id);
  return {
    id: Number(row.id),
    username: String(row.username),
    real_name: String(row.real_name),
    dept: (row.dept as string | null) ?? null,
    role_key: String(row.role_key),
    role_name: String(row.role_name),
    data_scope: Number(row.data_scope),
    can_see_cost: Number(row.can_see_cost) === 1,
    can_see_contact: Number(row.can_see_contact) === 1,
    can_export: Number(row.can_export) === 1,
    menu_perms: JSON.parse(String(row.menu_perms ?? '[]')) as MenuKey[],
    shop_ids: shopIds,
  };
}

export interface AuthedRequest extends Request {
  user: CurrentUser;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(unauthorized());
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(unauthorized('登录已过期，请重新登录'));
  }
  const user = loadUser(payload.sub);
  if (!user) return next(unauthorized('账号已停用或不存在'));
  (req as AuthedRequest).user = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const user = loadUser(verifyToken(token).sub);
      if (user) (req as AuthedRequest).user = user;
    } catch {
      /* 忽略：交给下游鉴权处理 */
    }
  }
  next();
}

/* ---------- 菜单 / 按钮权限 ---------- */

export const requireMenu =
  (menu: MenuKey) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) return next(unauthorized());
    if (!user.menu_perms.includes(menu) && user.role_key !== 'boss') return next(forbidden(`无权访问「${menu}」模块`));
    next();
  };

export const requireExport = (req: Request, _res: Response, next: NextFunction): void => {
  const user = (req as AuthedRequest).user;
  if (!user) return next(unauthorized());
  if (!user.can_export) return next(forbidden('当前角色未开通导出权限'));
  next();
};

/* ---------- 数据范围：员工 × 店铺隔离（方案 8.1） ---------- */

/**
 * 生成店铺维度的范围过滤条件。
 * @param col 店铺列表达式，如 't.shop_id' 或 's.id'
 */
export function shopScope(user: CurrentUser, col: string): { sql: string; params: number[] } {
  switch (user.data_scope) {
    case DATA_SCOPE.ALL:
      return { sql: '', params: [] };
    case DATA_SCOPE.SHOPS:
      if (!user.shop_ids.length) return { sql: `AND 1 = 0`, params: [] };
      return { sql: `AND ${col} IN (${user.shop_ids.map(() => '?').join(',')})`, params: user.shop_ids };
    case DATA_SCOPE.SELF:
      return { sql: `AND ${col} IN (SELECT shop_id FROM tk_shop WHERE owner_id = ?)`, params: [user.id] };
    case DATA_SCOPE.DEPT:
      return {
        sql: `AND ${col} IN (SELECT s.shop_id FROM sys_user_shop s JOIN sys_user m ON m.id = s.user_id WHERE m.dept = (SELECT dept FROM sys_user WHERE id = ?))`,
        params: [user.id],
      };
    default:
      return { sql: `AND 1 = 0`, params: [] };
  }
}

/** 人员维度（BD 私海、剪辑绩效等）：仅本人 / 本组 / 全部 */
export function personScope(user: CurrentUser, col: string, dept = false): { sql: string; params: number[] } {
  if (user.data_scope === DATA_SCOPE.ALL) return { sql: '', params: [] };
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return {
      sql: dept ? `AND ${col} IN (SELECT id FROM sys_user WHERE dept = (SELECT dept FROM sys_user WHERE id = ?))` : '',
      params: dept ? [user.id] : [],
    };
  }
  return { sql: `AND ${col} = ?`, params: [user.id] };
}

/** 敏感字段掩码：成本/利润/联系方式无权限时显示 *** */
export function maskFields<T extends Record<string, unknown>>(row: T, fields: string[], allowed: boolean): T {
  if (allowed) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const f of fields) if (f in out) out[f] = MASK;
  return out as T;
}
