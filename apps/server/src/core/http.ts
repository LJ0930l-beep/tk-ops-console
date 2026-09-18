import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = status * 100,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new AppError(400, msg);
export const unauthorized = (msg = '请先登录') => new AppError(401, msg);
export const forbidden = (msg = '没有该操作权限') => new AppError(403, msg);
export const notFound = (msg = '记录不存在') => new AppError(404, msg);

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

/** 统一响应体：{ code, message, data } */
export const ok = (res: Response, data: unknown = null, message = 'ok') => res.json({ code: 0, message, data });

export const wrap =
  (fn: Handler): ((req: Request, res: Response, next: NextFunction) => void) =>
  (req, res, next) => {
    void Promise.resolve(fn(req, res)).catch(next);
  };

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body) as T;
  } catch (e) {
    if (e instanceof ZodError) throw badRequest(e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    throw e;
  }
}

export function parseQuery<T>(schema: ZodType<T>, q: unknown): T {
  return parseBody(schema, q);
}

const ID_COLUMNS = new Set(['id', 'user_id', 'owner_id', 'created_by', 'editor_id', 'operator_id', 'host_id', 'assistant_id']);

export function buildListSql(opts: {
  base: string;
  selectExtra?: string;
  filters?: Record<string, unknown>;
  likeKeys?: string[];
  idKeys?: string[];
  dateKeys?: string[];
  inKeys?: Record<string, unknown[]>;
  allowedSort?: string[];
  sortBy?: string;
  sortOrder?: string;
  defaultSort?: string;
}): { sql: string; params: (string | number | null)[]; countSql: string } {
  const where: string[] = ['t.is_deleted = 0'];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(opts.filters ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (opts.likeKeys?.includes(k)) {
      where.push(`(${k} LIKE ?)`);
      params.push(`%${String(v)}%`);
    } else if (opts.dateKeys?.includes(k)) {
      const col = String(k).replace(/_(from|to)$/, '');
      where.push(`${col} ${k.endsWith('_from') ? '>=' : '<='} ?`);
      params.push(String(v));
    } else {
      where.push(`${k} = ?`);
      params.push(ID_COLUMNS.has(k) || k.endsWith('_id') ? Number(v) : String(v));
    }
  }
  for (const [k, list] of Object.entries(opts.inKeys ?? {})) {
    if (!list?.length) continue;
    where.push(`${k} IN (${list.map(() => '?').join(',')})`);
    params.push(...list.map(Number));
  }
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const allowed = new Set(opts.allowedSort ?? []);
  const sort = allowed.has(opts.sortBy ?? '') ? opts.sortBy! : (opts.defaultSort ?? 'id');
  const dir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';
  return {
    sql: `SELECT t.* ${opts.selectExtra ?? ''} FROM (${opts.base}) t${whereSql} ORDER BY t.${sort} ${dir}, t.id DESC`,
    countSql: `SELECT COUNT(*) AS c FROM (${opts.base}) t${whereSql}`,
    params,
  };
}

/** 取单个 query 参数（避免数组类型） */
export const qv = (req: Request, key: string): string | undefined => {
  const v = req.query[key];
  const one = Array.isArray(v) ? v[0] : v;
  return one === undefined || one === null || one === '' ? undefined : String(one);
};

export function paginate(req: Request): { limit: number; offset: number; page: number; pageSize: number } {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const rawSize = Number(req.query.pageSize ?? 20) || 20;
  const pageSize = Math.min(200, Math.max(1, rawSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
