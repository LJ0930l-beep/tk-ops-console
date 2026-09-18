import cron from 'node-cron';
import { registerSyncJobs } from './syncJobs.js';
import { registerCreatorJobs } from './creatorJobs.js';

/** 定时任务：订单/商品/售后/联盟增量同步 + 保护期回收 / 寄样超期 / 直播提醒 / 汇总刷新 */
export function startScheduler(): void {
  const sync = registerSyncJobs(cron).map((j) => `sync:${j.name} (${j.expr})`);
  const creator = registerCreatorJobs(cron).map((j) => `creator:${j.name} (${j.expression})`);
  for (const line of [...sync, ...creator]) console.log(`[jobs] 已注册 ${line}`);
}
