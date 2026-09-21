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
  migrateDueNotificationIndexes(db);
  migrateLegacyRateSources(db);
}

/**
 * Inbox indexes are also declared in schema.sqlite.sql for fresh databases.
 * Reassert them for older/partially migrated databases and record the migration
 * so operators can identify when the per-user reminder inbox was installed.
 */
function migrateDueNotificationIndexes(db: DatabaseSync): void {
  const version = '2026-09-20-user-due-notifications-v1';
  if (db.prepare('SELECT 1 FROM schema_migration WHERE version = ?').get(version)) return;

  db.exec('BEGIN');
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_user_notification_dedupe
      ON user_notification(recipient_id, alert_event_id, due_at_snapshot, assignment_cycle)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_user_notification_inbox
      ON user_notification(recipient_id, is_deleted, stale_at, read_at, created_at)`);
    db.prepare('INSERT INTO schema_migration(version) VALUES (?)').run(version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The pre-Frankfurter /rate/fetch endpoint generated local mock values with source=1.
 * Relabel those existing rows once; later Frankfurter rows must keep source=1 on startup.
 */
function migrateLegacyRateSources(db: DatabaseSync): void {
  const version = '2026-09-20-rate-source-frankfurter-v2';
  if (db.prepare('SELECT 1 FROM schema_migration WHERE version = ?').get(version)) return;

  db.exec('BEGIN');
  try {
    db.exec('UPDATE exchange_rate SET source = 4 WHERE source = 1');
    db.prepare('INSERT INTO schema_migration(version) VALUES (?)').run(version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
