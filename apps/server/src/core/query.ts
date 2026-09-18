import type { Request } from 'express';
import { all, get, type SqlParam } from './db.js';
import { paginate } from './http.js';

/** req.query 的值 → SQL 参数；空值返回 null，由 Q.and 自动忽略该条件 */
export function toParam(v: unknown): SqlParam | null {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return toParam(v[0]);
  if (typeof v === 'object') return null;
  return typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' ? (v as SqlParam) : String(v);
}

/**
 * 统一的条件构造器：所有列表接口都用它拼 WHERE，
 * 值为空（undefined/null/''）时自动跳过该条件。
 */
export class Q {
  private parts: string[] = [];
  private args: SqlParam[] = [];

  constructor(initial?: string, ...params: SqlParam[]) {
    if (initial) this.and(initial, ...params);
  }

  /** cond 里用 ? 占位；任一参数为空则整条条件忽略 */
  and(cond: string, ...params: SqlParam[]): this {
    if (!cond || !cond.trim()) return this;
    if (params.length === 0) {
      this.parts.push(cond);
      return this;
    }
    if (params.some((p) => p === undefined || p === null || p === '')) return this;
    this.parts.push(cond);
    this.args.push(...params);
    return this;
  }

  /** 强制条件（如数据范围），空数组时生成 1 = 0 */
  in(cond: string, values: (string | number)[]): this {
    if (Array.isArray(values) && values.length === 0) {
      this.parts.push('1 = 0');
      return this;
    }
    return this.and(`${cond} (${values.map(() => '?').join(',')})`, ...values);
  }

  like(condTemplate: string, value: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    const slots = Math.max(1, condTemplate.split('?').length - 1);
    const filled: SqlParam[] = Array.from({ length: slots }, () => `%${String(value)}%`);
    return this.and(condTemplate, ...filled);
  }

  eq(column: string, value: unknown, asNumber = true): this {
    if (value === undefined || value === null || value === '') return this;
    return this.and(`${column} = ?`, asNumber ? Number(value) : String(value));
  }

  /** col >= ? 与 col <= ? 时间区间；传 req.query 的值即可，空值自动忽略 */
  between(col: string, from: unknown, to: unknown): this {
    return this.and(`${col} >= ?`, toParam(from)).and(`${col} <= ?`, toParam(to));
  }

  get whereSql(): string {
    return this.parts.length ? ` WHERE ${this.parts.join(' AND ')}` : '';
  }

  get params(): SqlParam[] {
    return this.args;
  }
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 分页查询：from 需自带别名，select 默认 t.*
 * @example queryPage(req, { select: 's.*, u.real_name AS owner_name', from: 'tk_shop s LEFT JOIN sys_user u ON u.id = s.owner_id', q: new Q('s.is_deleted = 0') })
 */
export function queryPage<T = Record<string, unknown>>(
  req: Request,
  opts: { from: string; q: Q; select?: string; orderBy?: string; extraFromParams?: SqlParam[] },
): PageResult<T> {
  const { limit, offset, page, pageSize } = paginate(req);
  const select = opts.select ?? 't.*';
  const from = opts.from.includes(' is_deleted') || opts.q.whereSql.includes('is_deleted') ? opts.from : opts.from;
  const where = opts.q.whereSql || ' WHERE 1 = 1';
  const params = [...opts.q.params, ...(opts.extraFromParams ?? [])];
  const list = all<T>(`SELECT ${select} FROM ${from}${where} ORDER BY ${opts.orderBy ?? 'id DESC'} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${from}${where}`, ...params)?.c ?? 0);
  return { list, total, page, pageSize };
}

/** 不分页列表（下拉选项用） */
export function queryList<T = Record<string, unknown>>(opts: { from: string; q: Q; select?: string; orderBy?: string; limit?: number }): T[] {
  const where = opts.q.whereSql || ' WHERE 1 = 1';
  const sql = `SELECT ${opts.select ?? '*'} FROM ${opts.from}${where} ORDER BY ${opts.orderBy ?? 'id DESC'}`;
  return opts.limit ? all<T>(`${sql} LIMIT ${Math.min(500, opts.limit)}`, ...opts.q.params) : all<T>(sql, ...opts.q.params);
}
