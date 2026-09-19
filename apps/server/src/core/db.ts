import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { REGION_TZ_OFFSET, statDateInZone } from '@tk/shared';
import { config } from '../config.js';

export type SqlParam = string | number | bigint | null | Uint8Array;

let instance: DatabaseSync | null = null;

/**
 * SQLite 没有时区库：把切日能力注册为 SQL 函数 tz_day(utc_text, iana_zone, region)。
 * 第三参是站点码（US/MY/…），时区列为空或脏数据时退回该站点固定偏移，
 * 保证 SQL 聚合口径与 JS 侧 siteDay()/siteDayOf() 完全一致（同一个自然日）。
 */
function registerSqlFunctions(db: DatabaseSync): void {
  db.function('tz_day', { deterministic: true }, (utc: unknown, tz: unknown, region: unknown) =>
    statDateInZone(
      utc === null || utc === undefined ? '' : String(utc),
      tz === null || tz === undefined ? '' : String(tz),
      REGION_TZ_OFFSET[region === null || region === undefined ? '' : String(region)] ?? 0,
    ),
  );
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  instance = new DatabaseSync(config.dbFile);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  instance.exec('PRAGMA busy_timeout = 5000');
  registerSqlFunctions(instance);
  return instance;
}

/** 测试注入：换成内存库 */
export function setDb(db: DatabaseSync): void {
  registerSqlFunctions(db);
  instance = db;
}

export function newMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  registerSqlFunctions(db);
  return db;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export interface RunResult { changes: number; lastInsertRowid: number }

export function run(sql: string, ...params: SqlParam[]): RunResult {
  const r = getDb().prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid as bigint) };
}

export function insert(table: string, data: Record<string, SqlParam>): number {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return run(sql, ...keys.map((k) => data[k])).lastInsertRowid;
}

export function update(table: string, id: number, data: Record<string, SqlParam>): number {
  const keys = Object.keys(data).filter((k) => k !== 'id');
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  return run(sql, ...keys.map((k) => data[k]), id).changes;
}

/** 软删除：只打标记不真删（方案 8.2 硬规则） */
export function softDelete(table: string, id: number): number {
  return run(`UPDATE ${table} SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?`, id).changes;
}

export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function scalar<T = number>(sql: string, ...params: SqlParam[]): T {
  const row = get<Record<string, T>>(sql, ...params);
  return row ? (Object.values(row)[0] as T) : (0 as unknown as T);
}
