import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { setDb } from '../src/core/db.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemoData } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

export interface TestContext {
  db: DatabaseSync;
  /** supertest 实例，直接 .get('/api/...') */
  http: ReturnType<typeof request>;
}

/** 内存库 + 建表 + 演示数据，返回 supertest 客户端 */
export function boot(seed = true): TestContext {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  setDb(db);
  migrate(db);
  if (seed) seedDemoData({});
  return { db, http: request(createApp()) };
}

export const DEFAULT_PASSWORD = 'Passw0rd!';

export async function login(http: ReturnType<typeof request>, username = 'boss', password = DEFAULT_PASSWORD): Promise<string> {
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`登录失败 ${username}: ${JSON.stringify(res.body)}`);
  return res.body.data.token as string;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** 常用账号：老板/运营/BD/财务/剪辑 */
export const ACCOUNTS = {
  boss: 'boss',
  ops: 'limy',
  opsManager: 'wangqiang',
  bd: 'chenbd',
  bd2: 'lubd',
  content: 'yinuo',
  finance: 'finwu',
  ads: 'adskent',
  warehouse: 'whzhao',
} as const;

/** 取出 { list, total } 分页体 */
export function pageOf<T = Record<string, unknown>>(body: unknown): { list: T[]; total: number } {
  const data = (body as { data: { list: T[]; total: number } }).data;
  return { list: data?.list ?? [], total: data?.total ?? 0 };
}

export function dataOf<T = Record<string, unknown>>(body: unknown): T {
  return (body as { data: T }).data;
}
