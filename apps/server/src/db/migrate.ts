import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  path.join(here, 'schema.sqlite.sql'),
  path.resolve(here, '../../src/db/schema.sqlite.sql'),
  path.resolve(here, '../../../src/db/schema.sqlite.sql'),
];

export function readSchema(): string {
  const file = CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) throw new Error(`schema.sqlite.sql 未找到，已尝试：${CANDIDATES.join(' | ')}`);
  return fs.readFileSync(file, 'utf8');
}

/** 老库原地升级：新列用 PRAGMA 探测后再 ALTER，重复执行无副作用 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[db] 迁移：${table}.${column} 已添加`);
}

/** 幂等建表：schema 全部使用 CREATE TABLE IF NOT EXISTS */
export function migrate(db: DatabaseSync): void {
  db.exec(readSchema());
  addColumnIfMissing(db, 'tk_shop', 'access_token_enc', 'TEXT');
}
