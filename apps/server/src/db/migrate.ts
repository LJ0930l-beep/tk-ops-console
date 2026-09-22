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
  migrateNotificationDedupeIncludesSoftDelete(db);
  migrateLiveSessionIdempotency(db);
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

/**
 * 提醒去重键补 is_deleted（#31）。
 * 旧键不含软删标记：一条提醒被软删后，同一事件同一到期时间再也插不进来（唯一键冲突），
 * 「撤销后重发」和「清理后重跑」都会静默丢提醒。
 * 老库必须先 DROP 再按新列建 —— schema 里的 CREATE IF NOT EXISTS 对同名旧索引是不生效的。
 */
function migrateNotificationDedupeIncludesSoftDelete(db: DatabaseSync): void {
  const version = '2026-09-22-notification-dedupe-soft-delete-v1';
  if (db.prepare('SELECT 1 FROM schema_migration WHERE version = ?').get(version)) return;
  db.exec('BEGIN');
  try {
    db.exec('DROP INDEX IF EXISTS ux_user_notification_dedupe');
    db.exec(`CREATE UNIQUE INDEX ux_user_notification_dedupe
      ON user_notification(recipient_id, alert_event_id, due_at_snapshot, assignment_cycle, is_deleted)`);
    db.prepare('INSERT INTO schema_migration(version) VALUES (?)').run(version);
    db.exec('COMMIT');
    console.log('[db] 迁移：提醒去重键已包含 is_deleted');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 直播场次幂等键下沉到数据库（#30/#31）。
 * 导入中心一直对外承诺「(店铺, 开播时间) 即同一场」，但只靠应用层 SELECT-then-INSERT，
 * 并发导入或重跑就会插出两场重复直播，复盘数据被摊薄。
 * 老库可能已有历史重复：先把重复行软删（保留 id 最大那条 = 最新一次导入的结果），再建唯一索引。
 * 只软删不物理删，随时能按 sys_op_log / is_deleted 复原。
 */
function migrateLiveSessionIdempotency(db: DatabaseSync): void {
  const version = '2026-09-22-live-session-idempotent-v1';
  if (db.prepare('SELECT 1 FROM schema_migration WHERE version = ?').get(version)) return;
  db.exec('BEGIN');
  try {
    const dupes = db
      .prepare(
        `SELECT l.id FROM live_session l
           WHERE l.is_deleted = 0 AND l.plan_start IS NOT NULL
             AND EXISTS (SELECT 1 FROM live_session k
                          WHERE k.is_deleted = 0 AND k.shop_id = l.shop_id AND k.plan_start = l.plan_start AND k.id > l.id)`,
      )
      .all() as { id: number }[];
    if (dupes.length) {
      const mark = db.prepare(`UPDATE live_session SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?`);
      for (const d of dupes) mark.run(d.id);
      console.log(`[db] 迁移：直播场次重复 ${dupes.length} 行已软删（各保留最新一条）`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_live_shop_plan_start
      ON live_session(shop_id, plan_start) WHERE is_deleted = 0 AND plan_start IS NOT NULL`);
    db.prepare('INSERT INTO schema_migration(version) VALUES (?)').run(version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
