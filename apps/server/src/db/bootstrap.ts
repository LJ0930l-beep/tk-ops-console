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

/** 启动准备：建表；空库自动灌入演示数据，保证开箱即可验收 */
export function prepareDatabase(): DatabaseSync {
  const db = openDb();
  migrate(db);
  const users = Number((db.prepare(`SELECT COUNT(*) AS c FROM sys_user`).get() as { c: number }).c);
  if (users === 0) {
    console.log('[db] 空库 → 建表完成并灌入演示数据');
    seedDemoData({ reset: false });
  }
  return db;
}
