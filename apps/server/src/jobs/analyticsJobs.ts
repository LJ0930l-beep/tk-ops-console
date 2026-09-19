/**
 * V2.0 分析/规则定时任务：宽表重建 → 规则评估 → 效果回看（§19：规则任务失败要告警留痕）。
 * 与 syncJobs/creatorJobs 相同的注册约定：传入 cron 实例，返回已注册任务清单。
 */
import { insert, update } from '../core/db.js';
import { rebuildAnalytics } from '../services/analytics.js';
import { evaluateActionResults, evaluateRules } from '../services/rules/engine.js';
import { sendAlert } from '../core/oplog.js';

interface CronLike {
  schedule: (expr: string, fn: () => void) => unknown;
}

export interface RegisteredJob {
  name: string;
  expr: string;
}

const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** 规则评估失败也留 sync_log（task_type='aggregate'）并推送告警，不允许静默失败 */
export function runRulesCycle(userId: number | null = null): { events: number; results: number } {
  const logId = insert('sync_log', { task_type: 'aggregate', shop_id: null, started_at: stamp(), created_by: userId } as never);
  try {
    const outcome = evaluateRules({ userId });
    const results = evaluateActionResults();
    const msg = `规则${outcome.evaluated_rules}条 命中${outcome.hits} 新增事件${outcome.created_events} 冷却跳过${outcome.skipped_cooldown} 回看${results}`;
    update('sync_log', logId, { updated: outcome.created_events, status: outcome.errors.length ? 2 : 1, error_msg: outcome.errors.length ? JSON.stringify(outcome.errors) : msg, finished_at: stamp() } as never);
    if (outcome.errors.length) sendAlert({ title: '规则引擎部分失败', detail: outcome.errors.map((e) => `${e.rule_code}: ${e.message}`).join('; '), level: 'warn' });
    return { events: outcome.created_events, results };
  } catch (e) {
    update('sync_log', logId, { failed: 1, status: 3, error_msg: (e as Error).message, finished_at: stamp() } as never);
    sendAlert({ title: '规则引擎执行失败', detail: (e as Error).message, level: 'error' });
    throw e;
  }
}

export function registerAnalyticsJobs(cron: CronLike): RegisteredJob[] {
  const jobs: RegisteredJob[] = [
    // 每日 02:10 重建分析宽表（在订单/结算同步之后）
    { name: 'analytics_rebuild', expr: '10 2 * * *' },
    // 每日 02:40 规则评估 + 到期效果回看
    { name: 'rules_evaluate', expr: '40 2 * * *' },
  ];
  cron.schedule(jobs[0].expr, () => {
    try {
      const r = rebuildAnalytics(null);
      console.log(`[jobs] analytics_rebuild 完成，回写 ${r.affected} 行`);
    } catch (e) {
      console.error(`[jobs] analytics_rebuild 失败：${(e as Error).message}`);
      sendAlert({ title: '分析宽表重建失败', detail: (e as Error).message, level: 'error' });
    }
  });
  cron.schedule(jobs[1].expr, () => {
    try {
      const r = runRulesCycle(null);
      console.log(`[jobs] rules_evaluate 完成，新增事件 ${r.events}，回看 ${r.results}`);
    } catch (e) {
      console.error(`[jobs] rules_evaluate 失败：${(e as Error).message}`);
    }
  });
  return jobs;
}
