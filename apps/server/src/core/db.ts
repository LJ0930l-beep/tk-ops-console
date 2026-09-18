import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type SqlParam = string | number | bigint | null | Uint8Array;

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  instance = new DatabaseSync(config.dbFile);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  instance.exec('PRAGMA busy_timeout = 5000');
  return instance;
}

/** 测试注入：换成内存库 */
export function setDb(db: DatabaseSync): void {
  instance = db;
}

export function newMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
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
