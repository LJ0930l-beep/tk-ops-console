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

/** 幂等建表：schema 全部使用 CREATE TABLE IF NOT EXISTS */
export function migrate(db: DatabaseSync): void {
  db.exec(readSchema());
}
