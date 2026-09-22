/**
 * 后台任务队列回归（选项 7 / #41）
 *
 * 要钉住的行为：
 *  1. 未注册的 job_type 不许进队列（否则队列会变成任意字符串的执行入口）；
 *  2. 领取必须互斥：两个 worker 抢同一个任务，只能有一个拿到；
 *  3. 失败要按 attempts/max_attempts 退避重试，用尽才落失败并告警；
 *  4. 进程被 kill 留下的「在跑」僵尸任务要能退回队列；
 *  5. 接口层只开放给 system 菜单，且 error_msg 出口必须脱敏；
 *  6. POST /sync/run {async:true} 要按同步路径同样的数据范围算好店铺再入队。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { get, run } from '../src/core/db.js';
import {
  claimJob,
  drainJobs,
  enqueueJob,
  getJob,
  registerJobHandler,
  requeueStaleJobs,
  runClaimedJob,
  type JobRow,
} from '../src/services/jobs/queue.js';
import '../src/jobs/jobHandlers.js';
import { ACCOUNTS, auth, boot, dataOf, login, type TestContext } from './helper.js';

let ctx: TestContext;
const tok: Record<string, string> = {};

const SECRET = 'access_token=7F3C9E2B41A58D6C0E9F2B7A1D4C8E5F3A9B7C5D1E4F8A2B';

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
});

const jobRow = (id: number): JobRow | null => getJob(id);

// claimJob 取的是「id 最小的待跑任务」，上一条测试留在队列里的任务会被下一条认领走，
// 所以每条测试自己清空队列，断言才是「我刚入的那个队」。
beforeEach(() => {
  run('DELETE FROM job_queue');
});

describe('入队与领取', () => {
  it('未注册的 job_type 直接拒绝（不给任意字符串进队列的口子）', () => {
    expect(() => enqueueJob('rm_rf_root', {})).toThrow(/未注册的 job_type/);
  });

  it('领取互斥：同一个任务只能被一个 worker 拿到', async () => {
    registerJobHandler('spec_echo', (payload) => ({ echo: payload, at: 'ok' }));
    const id = enqueueJob('spec_echo', { hello: 'world' });
    const first = claimJob('worker-a');
    expect(first?.id).toBe(id);
    // 已被 1 号占用，第二个 worker 拿不到任何东西
    expect(claimJob('worker-b')).toBeNull();
    await runClaimedJob(first!);
    const done = jobRow(id);
    expect(Number(done?.status)).toBe(2);
    expect(JSON.parse(String(done?.result_json)).echo).toEqual({ hello: 'world' });
  });

  it('POST /api/system/jobs 只有 system 菜单能用，未知类型 400', async () => {
    const okRes = await ctx.http.post('/api/system/jobs').set(auth(tok.boss)).send({ job_type: 'analytics_rebuild', payload: { start: '2026-01-01', end: '2026-01-02' } });
    expect(okRes.status).toBe(200);
    const id = Number(dataOf<{ id: number }>(okRes.body).id);
    expect(id).toBeGreaterThan(0);
    expect((await ctx.http.get(`/api/system/jobs/${id}`).set(auth(tok.boss))).status).toBe(200);
    expect((await ctx.http.post('/api/system/jobs').set(auth(tok.boss)).send({ job_type: 'nope' })).status).toBe(400);
    expect((await ctx.http.post('/api/system/jobs').set(auth(tok.ops)).send({ job_type: 'analytics_rebuild' })).status).toBe(403);
    expect((await ctx.http.get('/api/system/jobs').set(auth(tok.opsManager))).status).toBe(200);
  });
});

describe('失败重试与僵尸回收', () => {
  it('失败后退避重排，用尽次数才落失败；错误文案必须脱敏', async () => {
    let calls = 0;
    registerJobHandler('spec_flaky', () => {
      calls += 1;
      if (calls < 3) throw new Error(`上游炸了 ${SECRET}`);
      return { recovered: true };
    });
    const id = enqueueJob('spec_flaky', {}, { maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      const job = claimJob('w');
      expect(job?.id).toBe(id);
      const outcome = await runClaimedJob(job!);
      if (outcome === 'retry') {
        // 退避到未来时间点，测试里直接把它拉回「现在可跑」
        run(`UPDATE job_queue SET run_after = NULL WHERE id = ?`, id);
      }
    }
    const row = jobRow(id);
    expect(Number(row?.status)).toBe(2);
    expect(Number(row?.attempts)).toBe(3);
    expect(String(row?.error_msg)).not.toContain('7F3C9E2B');
  });

  it('重试耗尽 → 状态 3，且接口视图里 error_msg 已打码', async () => {
    registerJobHandler('spec_always_fail', () => {
      throw new Error(`凭证泄漏风险 ${SECRET}`);
    });
    const id = enqueueJob('spec_always_fail', {}, { maxAttempts: 1 });
    await runClaimedJob(claimJob('w')!);
    expect(Number(jobRow(id)?.status)).toBe(3);
    const res = await ctx.http.get(`/api/system/jobs/${id}`).set(auth(tok.boss));
    const view = dataOf<{ error_msg: string; status: number }>(res.body);
    expect(view.status).toBe(3);
    expect(view.error_msg).toContain('***');
    expect(view.error_msg).not.toContain('7F3C9E2B');
  });

  it('进程被 kill 留下的「在跑」任务会被退回队列', () => {
    registerJobHandler('spec_zombie', () => ({ ok: true }));
    const id = enqueueJob('spec_zombie', {});
    const job = claimJob('dead-worker');
    expect(job?.id).toBe(id);
    run(`UPDATE job_queue SET started_at = datetime('now', '-2 hour') WHERE id = ?`, id);
    expect(requeueStaleJobs()).toBeGreaterThanOrEqual(1);
    expect(Number(jobRow(id)?.status)).toBe(0);
  });
});

describe('异步同步（POST /sync/run {async:true}）', () => {
  it('按同步路径同样的范围算好店铺再入队，跑完能在任务里看到结果', async () => {
    const res = await ctx.http.post('/api/sync/run').set(auth(tok.boss)).send({ task_type: 'aggregate', async: true });
    expect(res.status).toBe(200);
    const data = dataOf<{ queued: boolean; job_id: number; shop_ids: number[] }>(res.body);
    expect(data.queued).toBe(true);
    expect(Number(jobRow(data.job_id)?.status)).toBe(0);

    const drain = await ctx.http.post('/api/system/jobs/drain').set(auth(tok.boss)).send({});
    expect(drain.status).toBe(200);
    const after = jobRow(data.job_id);
    expect(Number(after?.status)).toBe(2);
    expect(JSON.parse(String(after?.result_json))).toBeTruthy();
  });

  it('受限范围角色异步跑别人的店会被拒（入队前就按同步路径算范围）', async () => {
    const mine = dataOf<Record<string, unknown>[]>(
      (await ctx.http.get('/api/shops/all').set(auth(tok.opsManager))).body,
    ).map((r) => Number(r.id));
    const all = dataOf<Record<string, unknown>[]>(
      (await ctx.http.get('/api/shops/all').set(auth(tok.boss))).body,
    ).map((r) => Number(r.id));
    const foreign = all.find((id) => !mine.includes(id));
    expect(foreign, '演示数据里应该存在一家不在 ops_manager 范围内的店').toBeTruthy();
    const res = await ctx.http.post('/api/sync/run').set(auth(tok.opsManager)).send({ task_type: 'order', shop_id: foreign, async: true });
    expect(res.status).toBe(404);
    // 被拒就不能留下任何排队任务（范围校验在入队之前，不是入队后再判）
    expect(get<{ c: number }>(`SELECT COUNT(*) AS c FROM job_queue`)?.c).toBe(0);
  });
});
