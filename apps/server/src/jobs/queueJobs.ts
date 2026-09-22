/**
 * 队列心跳：每分钟把到点的后台任务催一轮（并回收僵死任务）。
 *
 * 没有常驻 worker 是刻意的：本项目单进程 + tsx watch，常驻循环会和热重载互相绞；
 * 每次 tick 只跑有限个（config.jobBatchSize），跑完就退，长任务由 attempts/退避保证最终完成。
 */
import { config } from '../config.js';
import { drainJobs, requeueStaleJobs } from '../services/jobs/queue.js';

interface CronLike {
  schedule: (expr: string, fn: () => void, opts?: Record<string, unknown>) => unknown;
}

const JOBS = [{ name: 'queue_drain', expr: '* * * * *' }];

export function registerQueueJobs(cron: CronLike): { name: string; expr: string }[] {
  cron.schedule(JOBS[0].expr, () => {
    void (async () => {
      try {
        const stale = requeueStaleJobs();
        const out = await drainJobs(config.jobBatchSize, 'cron');
        if (stale || out.claimed) console.log(`[jobs] queue_drain 领取 ${out.claimed}（成功 ${out.done}，重试 ${out.retried}，失败 ${out.failed}），回收僵死 ${stale}`);
      } catch (e) {
        console.log(`[jobs] queue_drain 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, { name: 'queue:drain', timezone: config.jobTimezone });
  return JOBS;
}
