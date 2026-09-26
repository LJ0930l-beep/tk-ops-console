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

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** 老库原地升级：新列用 PRAGMA 探测后再 ALTER，重复执行无副作用 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[db] 迁移：${table}.${column} 已添加`);
}

/** 采购口径的旧列：两份方言 DDL 已不再声明它们，留着会让 schema-drift 校验两边不一致 */
function dropColumn(db: DatabaseSync, table: string, column: string): void {
  if (!hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  console.log(`[db] 迁移：${table}.${column} 已移除（采购口径）`);
}

/**
 * 口径切换：「自采自卖（有采购成本）」→「品牌服务方（只有返点与自己的支出）」。三条原则：
 *  1. **能等价换算的才换算**：头程成本本来就是物流成本，直接搬；「供应商」位置改成「品牌方」。
 *  2. **换不出来的绝不发明**：历史订单行的 cost_snapshot 是货款，推不出返点率，
 *     所以只能落在 `rebate_matched = 0`（不参与利润），而不是拿一个猜出来的比率把报表填满。
 *     老库升级后利润区会先空掉 —— 这是对的，它逼着人把返点率配进 SKU 再重跑派生汇总。
 *  3. 选品的老 `est_margin`（我们留下的比例）在新口径里正好等于返点率（佣金/物流未拆时），
 *     所以 `rebate_rate = est_margin`，等式仍然自洽。
 */
function migrateRebateCaliber(db: DatabaseSync): void {
  const version = '2026-09-25-brand-rebate-caliber-v1';
  if (db.prepare('SELECT 1 FROM schema_migration WHERE version = ?').get(version)) return;

  db.exec('BEGIN');
  try {
    addColumnIfMissing(db, 'product_sku', 'rebate_rate', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'product_sku', 'logistics_cost', 'REAL NOT NULL DEFAULT 0');
    if (hasColumn(db, 'product_sku', 'first_leg_cost')) {
      db.exec(`UPDATE product_sku SET logistics_cost = first_leg_cost WHERE logistics_cost = 0 AND first_leg_cost <> 0`);
    }

    addColumnIfMissing(db, 'tk_order_item', 'rebate_rate', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'tk_order_item', 'rebate_cny', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'tk_order_item', 'logistics_cny', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'tk_order_item', 'rebate_matched', 'INTEGER NOT NULL DEFAULT 0');

    addColumnIfMissing(db, 'analytics_creator_daily', 'rebate', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'analytics_creator_daily', 'sample_shipping', 'REAL NOT NULL DEFAULT 0');

    addColumnIfMissing(db, 'selection_flow', 'brand_name', 'TEXT');
    addColumnIfMissing(db, 'selection_flow', 'list_price', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'selection_flow', 'planned_discount', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'selection_flow', 'rebate_rate', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'selection_flow', 'commission_rate', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'selection_flow', 'logistics_rate', 'REAL NOT NULL DEFAULT 0');
    if (hasColumn(db, 'selection_flow', 'supplier')) {
      db.exec(`UPDATE selection_flow SET brand_name = supplier WHERE brand_name IS NULL AND supplier IS NOT NULL`);
    }
    db.exec(`UPDATE selection_flow SET rebate_rate = est_margin WHERE rebate_rate = 0 AND est_margin > 0`);

    dropColumn(db, 'product_sku', 'purchase_cost');
    dropColumn(db, 'product_sku', 'first_leg_cost');
    dropColumn(db, 'tk_order_item', 'cost_snapshot');
    dropColumn(db, 'tk_order_item', 'cost_matched');
    dropColumn(db, 'sample_shipment', 'sample_cost');
    dropColumn(db, 'analytics_creator_daily', 'sample_cost');
    dropColumn(db, 'selection_flow', 'supplier');
    dropColumn(db, 'selection_flow', 'purchase_price');
    dropColumn(db, 'selection_flow', 'moq');
    dropColumn(db, 'selection_flow', 'lead_days');

    const items = Number((db.prepare('SELECT COUNT(*) AS c FROM tk_order_item').get() as { c: number }).c ?? 0);
    db.prepare('INSERT INTO schema_migration(version) VALUES (?)').run(version);
    db.exec('COMMIT');
    if (items) {
      console.log(
        `[db] 口径切换：${items} 行历史订单没有可换算的返点率，已按「未配返点」处理（不计入利润）。` +
          `请在商品 SKU 配好品牌返点率后重跑「派生汇总」。`,
      );
    }
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 幂等建表：schema 全部使用 CREATE TABLE IF NOT EXISTS */
export function migrate(db: DatabaseSync): void {
  db.exec(readSchema());
  addColumnIfMissing(db, 'tk_shop', 'access_token_enc', 'TEXT');
  migrateDueNotificationIndexes(db);
  migrateLegacyRateSources(db);
  migrateNotificationDedupeIncludesSoftDelete(db);
  migrateLiveSessionIdempotency(db);
  migrateSelectionMenu(db);
  migrateRebateCaliber(db);
  migrateAiMenu(db);
}

/**
 * 「AI 助手」是后加的一级菜单，老库的 sys_role.menu_perms 不会自己长出来。
 * 补法与 migrateSelectionMenu 同一套：按内容判定幂等（可反复执行），
 * 权限列解析失败的行跳过不猜；已经手工给过 'ai' 的角色保持原样。
 * 口径：给所有本来就有工作台（dashboard）的角色补 —— AI 的可见数据与可写工具
 * 由「工具白名单 + 调用者本人的菜单/数据范围」决定，不靠这个菜单键做兜底。
 */
function migrateAiMenu(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT id, menu_perms FROM sys_role WHERE is_deleted = 0`).all() as { id: number; menu_perms: string }[];
  let hit = 0;
  for (const r of rows) {
    let perms: unknown;
    try {
      perms = JSON.parse(r.menu_perms);
    } catch {
      continue; // 权限列被改坏过，不该由这次迁移猜测
    }
    if (!Array.isArray(perms) || !perms.includes('dashboard') || perms.includes('ai')) continue;
    db.prepare(`UPDATE sys_role SET menu_perms = ? WHERE id = ?`).run(JSON.stringify([...perms, 'ai']), r.id);
    hit++;
  }
  if (hit) console.log(`[db] 迁移：${hit} 个角色的菜单已补上「AI 助手」`);
}

/**
 * 「选品管理」是后加的一级菜单，而已存在的 `sys_role.menu_perms` 不会自己长出新菜单 ——
 * 不补这一步，老库里连运营主管都看不到这个菜单，功能上线了界面上却像"没做"。
 * 口径：只给本来就能看到商品中心的角色补，其余权限一律不动（管理员手工改过的一律保留）。
 */
function migrateSelectionMenu(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT id, menu_perms FROM sys_role WHERE is_deleted = 0`).all() as { id: number; menu_perms: string }[];
  let hit = 0;
  for (const r of rows) {
    let perms: unknown;
    try {
      perms = JSON.parse(r.menu_perms);
    } catch {
      continue; // 权限列被改坏过，不该由这次迁移猜测
    }
    if (!Array.isArray(perms) || !perms.includes('product') || perms.includes('selection')) continue;
    db.prepare(`UPDATE sys_role SET menu_perms = ? WHERE id = ?`).run(JSON.stringify([...perms, 'selection']), r.id);
    hit++;
  }
  if (hit) console.log(`[db] 迁移：${hit} 个角色的菜单已补上「选品管理」`);
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
