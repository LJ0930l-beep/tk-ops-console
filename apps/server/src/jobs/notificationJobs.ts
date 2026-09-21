import { sendAlert } from '../core/oplog.js';
import { reconcileDueAlertNotifications } from '../services/notifications.js';

interface CronLike {
  schedule: (expr: string, fn: () => void) => unknown;
}

export interface NotificationJob {
  name: string;
  expr: string;
}

/** Run once at startup and then every 15 minutes; the unique inbox key makes retries safe. */
export function runDueNotificationCycle(): { created: number; staled: number } {
  return reconcileDueAlertNotifications();
}

export function registerNotificationJobs(cron: CronLike): NotificationJob[] {
  const job = { name: 'alert_due_notifications', expr: '*/15 * * * *' };
  cron.schedule(job.expr, () => {
    try {
      const result = runDueNotificationCycle();
      if (result.created || result.staled) {
        console.log(`[jobs] ${job.name} 新增 ${result.created} 条，失效 ${result.staled} 条`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[jobs] ${job.name} 失败：${message}`);
      sendAlert({ title: '个人到期提醒任务失败', detail: message, level: 'error' });
    }
  });
  return [job];
}
