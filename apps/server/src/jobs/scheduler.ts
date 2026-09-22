import cron from 'node-cron';
import { config } from '../config.js';
import { registerSyncJobs } from './syncJobs.js';
import { registerCreatorJobs } from './creatorJobs.js';
import { registerAnalyticsJobs } from './analyticsJobs.js';
import { registerNotificationJobs } from './notificationJobs.js';
import { registerQueueJobs } from './queueJobs.js';
import './jobHandlers.js'; // 副作用：注册 job_type，必须早于任何入队/领取

/** 定时任务：订单/商品/售后/联盟增量同步 + 保护期回收 / 寄样超期 / 直播提醒 / 汇总刷新 + V2.0 宽表重建 / 规则评估 */
export function startScheduler(): void {
  const sync = registerSyncJobs(cron).map((j) => `sync:${j.name} (${j.expr})`);
  const creator = registerCreatorJobs(cron).map((j) => `creator:${j.name} (${j.expression})`);
  const analytics = registerAnalyticsJobs(cron).map((j) => `analytics:${j.name} (${j.expr})`);
  const notifications = registerNotificationJobs(cron).map((j) => `notification:${j.name} (${j.expr})`);
  const queue = registerQueueJobs(cron).map((j) => `queue:${j.name} (${j.expr})`);
  for (const line of [...sync, ...creator, ...analytics, ...notifications, ...queue]) console.log(`[jobs] 已注册 ${line} @${config.jobTimezone}`);
}
