import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { seedDemoData } from './seed.js';

export function openDb(): DatabaseSync {
  if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** 启动准备：建表；空库按开关灌入演示数据，生产禁止自动生成演示账号 */
export function prepareDatabase(): DatabaseSync {
  const db = openDb();
  migrate(db);
  const users = Number((db.prepare(`SELECT COUNT(*) AS c FROM sys_user`).get() as { c: number }).c);
  if (users === 0) {
    if (!config.seedDemo) {
      throw new Error(
        '[db] 数据库为空且演示灌入已关闭（SEED_DEMO=false），拒绝启动以免自动生成内置口令的管理员账号。' +
          ' 请先用 db CLI 初始化真实账号，或在确实需要演示数据时显式设置 SEED_DEMO=true / DEMO_PASSWORD。',
      );
    }
    console.log('[db] 空库 → 建表完成并灌入演示数据');
    seedDemoData({ reset: false });
  }
  return db;
}
