/**
 * 后台任务的具体活计（注册到 services/jobs/queue.ts 的表即队列上）。
 *
 * 单独一个文件是为了「注册」这件事只发生一次：调度器、HTTP 接口、测试都从这里进，
 * 不会出现「接口能入队但没人认这个 job_type」的情况（未注册类型入队会直接抛错）。
 */
import { runTask, runTaskForShopIds, refreshDerivedAggregates } from './syncJobs.js';
import { rebuildAnalytics } from '../services/analytics.js';
import { registerJobHandler } from '../services/jobs/queue.js';
import { evaluateRules } from '../services/rules/engine.js';

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const numOr = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const list = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0) : [];

/** 同步任务：与 POST /api/sync/run 同一套语义，只是挪到后台跑，前端拿 job id 轮询 */
async function runSyncJob(payload: Record<string, unknown>): Promise<unknown> {
  const taskType = str(payload.task_type) ?? 'all';
  const opts = { windowStart: str(payload.window_start), windowEnd: str(payload.window_end), user_id: numOr(payload.user_id) };
  const targets = list(payload.shop_ids);
  if (taskType === 'aggregate') {
    // aggregate 的「空范围」是有意语义：全数据范围角色刷全部派生数据
    return targets.length ? refreshDerivedAggregates(opts, targets) : refreshDerivedAggregates(opts);
  }
  const shopId = numOr(payload.shop_id);
  if (shopId) return runTask(taskType as never, shopId, opts);
  if (!targets.length) throw new Error('异步同步必须指定 shop_ids（同步作业不支持「所有店铺」的空范围猜测）');
  return runTaskForShopIds(targets, taskType as never, opts);
}

registerJobHandler('sync_run', runSyncJob);
registerJobHandler('analytics_rebuild', (payload) => rebuildAnalytics(numOr(payload.user_id) === undefined ? null : { id: numOr(payload.user_id) }, { start: str(payload.start), end: str(payload.end) }));
registerJobHandler('rules_evaluate', (payload) => evaluateRules({ end: str(payload.end), userId: numOr(payload.user_id) ?? null }));

export const JOB_TYPES = ['sync_run', 'analytics_rebuild', 'rules_evaluate'] as const;
