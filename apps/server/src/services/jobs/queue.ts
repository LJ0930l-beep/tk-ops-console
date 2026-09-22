/**
 * 任务队列（docs/dev-options.md 选项 7）：重活从请求周期里摘出来。
 *
 * 为什么用表而不是引 Redis：本项目就是「单进程 + SQLite」，
 * 引 BullMQ 要先加一个 Redis 运维面，收益（分布式并发、延迟队列）在这里用不上。
 * 表即队列的代价是「同一台机器上的多个进程会抢同一张表」——
 * 用 UPDATE ... WHERE id = (SELECT ... FOR UPDATE 语义) 的乐观领取解决：
 * 认领靠 `status = 0` 的条件更新，抢到的人把 status 改成 1，抢不到就返回 null，
 * 即使真的起了两个进程也不会重复执行（同步作业本身还有一层幂等）。
 *
 * 语义约定：
 *  - status：0 待跑 / 1 在跑 / 2 成功 / 3 失败（重试耗尽也算 3）；
 *  - attempts 只在**领取时** +1，所以进程被 kill 在跑中的任务会因为 attempts 未清零而被
 *    requeueJob 重新排队，直到 max_attempts 用尽；
 *  - payload/result 是 JSON 文本；错误文案一律截断，且不允许写进上游凭证（见 core/redact 的用法）。
 */
import { all, get, insert, run, update } from '../../core/db.js';
import { config } from '../../config.js';
import { maskError } from '../../core/redact.js';
import { sendAlert } from '../../core/oplog.js';

export type JobStatus = 0 | 1 | 2 | 3;

export interface JobRow {
  id: number;
  job_type: string;
  payload_json: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error_msg: string | null;
  created_by: number | null;
  worker: string | null;
}

export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => unknown | Promise<unknown>;

const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
const selectCols = `id, job_type, payload_json, status, attempts, max_attempts, run_after, started_at, finished_at, result_json, error_msg, created_by, worker`;

/** 注册表：job_type -> 处理函数。没注册的类型不允许入队也不允许跑，避免把任意字符串塞进队列 */
const handlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, fn: JobHandler): void {
  handlers.set(jobType, fn);
}

export const registeredJobTypes = (): string[] => [...handlers.keys()].sort();

export function enqueueJob(jobType: string, payload: Record<string, unknown> = {}, opts: { createdBy?: number | null; maxAttempts?: number; runAfter?: string } = {}): number {
  if (!handlers.has(jobType)) throw new Error(`未注册的 job_type：${jobType}（可注册：${registeredJobTypes().join(' / ') || '无'}）`);
  return insert('job_queue', {
    job_type: jobType,
    payload_json: JSON.stringify(payload ?? {}),
    status: 0,
    attempts: 0,
    max_attempts: opts.maxAttempts ?? config.jobMaxAttempts,
    run_after: opts.runAfter ?? null,
    created_by: opts.createdBy ?? null,
  } as never);
}

/**
 * 领取一个待跑任务（原子）：条件更新抢占，抢不到返回 null。
 * 到点条件 run_after 允许为空（立刻跑）或已到时间。
 */
export function claimJob(worker: string): JobRow | null {
  const cand = get<{ id: number }>(
    `SELECT id FROM job_queue
      WHERE status = 0 AND (run_after IS NULL OR run_after <= datetime('now'))
      ORDER BY id ASC LIMIT 1`,
  );
  if (!cand) return null;
  const taken = run(
    `UPDATE job_queue
        SET status = 1, attempts = attempts + 1, started_at = datetime('now'), updated_at = datetime('now'), worker = ?
      WHERE id = ? AND status = 0`,
    worker,
    cand.id,
  );
  if (!taken.changes) return null;
  const row = get<JobRow>(`SELECT ${selectCols}, worker FROM job_queue WHERE id = ?`, cand.id);
  return row ?? null;
}

/** 跑一个任务（成功/失败都收尾）；失败且还有次数就重新排队 */
export async function runClaimedJob(job: JobRow): Promise<'done' | 'retry' | 'failed'> {
  const fn = handlers.get(job.job_type);
  if (!fn) {
    finish(job.id, 3, null, `未注册的 job_type：${job.job_type}`);
    return 'failed';
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(job.payload_json ?? '{}')) as Record<string, unknown>;
  } catch {
    finish(job.id, 3, null, 'payload_json 不是合法 JSON');
    return 'failed';
  }
  try {
    const result = await fn(payload, job);
    finish(job.id, 2, JSON.stringify(result ?? null), null);
    return 'done';
  } catch (e) {
    const msg = maskError(e instanceof Error ? e.message : String(e));
    if (job.attempts < job.max_attempts) {
      // 还能重试：回到待跑，退避时间由 config 决定（不写死）
      run(
        `UPDATE job_queue
            SET status = 0, error_msg = ?, updated_at = datetime('now'),
                run_after = datetime('now', ?)
          WHERE id = ?`,
        msg,
        `+${config.jobRetryBackoffSeconds} seconds`,
        job.id,
      );
      return 'retry';
    }
    finish(job.id, 3, null, msg);
    sendAlert({ title: `后台任务失败（重试 ${job.max_attempts} 次后用尽）：${job.job_type}`, detail: `任务 #${job.id}：${msg}`, level: 'error' });
    return 'failed';
  }
}

function finish(id: number, status: JobStatus, resultJson: string | null, errorMsg: string | null): void {
  update('job_queue', id, { status, result_json: resultJson, error_msg: errorMsg, finished_at: stamp() } as never);
}

/** 供调度器/接口用：一次最多跑 batch 个，跑完返回统计（不常驻，避免和 tsx watch 抢线程） */
export async function drainJobs(batch = config.jobBatchSize, worker = 'inline'): Promise<{ claimed: number; done: number; failed: number; retried: number }> {
  const out = { claimed: 0, done: 0, failed: 0, retried: 0 };
  for (let i = 0; i < batch; i++) {
    const job = claimJob(worker);
    if (!job) break;
    out.claimed++;
    const r = await runClaimedJob(job);
    if (r === 'done') out.done++;
    else if (r === 'retry') out.retried++;
    else out.failed++;
  }
  return out;
}

export function getJob(id: number): JobRow | null {
  return get<JobRow>(`SELECT ${selectCols} FROM job_queue WHERE id = ? AND is_deleted = 0`, id) ?? null;
}

export function listJobs(status?: number | null, limit = 50): JobRow[] {
  const where = status === undefined || Number.isNaN(Number(status)) ? '' : 'AND status = ?';
  const params = where ? [Number(status), limit] : [limit];
  return all<JobRow>(`SELECT ${selectCols} FROM job_queue WHERE is_deleted = 0 ${where} ORDER BY id DESC LIMIT ?`, ...params);
}

/** 心跳把「进程被 kill 导致的僵死在跑任务」退回队列，否则它们永远卡在 status=1 */
export function requeueStaleJobs(afterSeconds = config.jobStaleMinutes * 60): number {
  const r = run(
    `UPDATE job_queue
        SET status = CASE WHEN attempts < max_attempts THEN 0 ELSE 3 END,
            updated_at = datetime('now'),
            error_msg = CASE WHEN attempts < max_attempts THEN error_msg ELSE '任务超时未结束且重试已用尽' END
      WHERE status = 1 AND is_deleted = 0
        AND datetime(started_at) < datetime('now', ?)`,
    `-${Math.max(1, afterSeconds)} seconds`,
  );
  return r.changes;
}
