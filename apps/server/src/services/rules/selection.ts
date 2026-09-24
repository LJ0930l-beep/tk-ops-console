/**
 * 选品流水线的规则（方案第十一章的「超时规则」与首页动作清单条目）
 *
 * 三条设计取舍：
 *  1. 阈值全部来自 alert_rule 表（threshold / params_json / window_days），代码里不写死天数 ——
 *     与 selection.routes.ts 用的 config.selection* 是两套用途：config 决定「看板卡片什么时候变红」，
 *     alert_rule 决定「要不要为这件事生成一条预警事件」，两者默认值一致但可各自调（跟 SAMPLE_SILENT 同一先例）；
 *  2. 日期差一律在 JS 里算，不新增 SQLite 专有的日期函数（julianday 那一类）
 *     （apps/server/tests/dialect-ratchet.spec.ts 会盯着这个数字，能少一处是一处）；
 *  3. 命中必须带 evidence 证据快照，且只检测/建议，绝不自动改状态 ——
 *     「测试到期未反馈」生成的是待办，不是把候选品自动丢进淘汰池。
 */
import { all } from '../../core/db.js';
import { SELECTION_CONCLUSION, SELECTION_STAGE, round2 } from '@tk/shared';
import type { Hit } from './engine.js';

/** 引擎传进来的规则行（engine.ts 里的 RuleRow 没导出，这里按用到的字段声明一份，结构兼容即可） */
interface Rule {
  rule_code: string;
  rule_name: string;
  metric: string;
  operator: string;
  threshold: number;
  window_days: number;
  params_json: string;
}

type Evaluator = (rule: Rule, end: string) => Hit[];

const r4 = (v: number): number => round2(v);

const msOf = (v: unknown): number => {
  const s = String(v ?? '').trim().replace(' ', 'T');
  const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? Number.NaN : t;
};

const hoursSince = (v: unknown, end: string): number => {
  const a = msOf(v);
  const b = msOf(end) || Date.now();
  return Number.isNaN(a) ? Number.NaN : (b - a) / 3_600_000;
};

const daysSince = (v: unknown, end: string): number => {
  const h = hoursSince(v, end);
  return Number.isNaN(h) ? Number.NaN : Math.floor(h / 24);
};

interface SelectionRow {
  id: number;
  code: string;
  name: string;
  stage: number;
  conclusion: number;
  shop_id: number | null;
  owner_id: number | null;
  stage_entered_at: string;
  test_started_at: string | null;
  test_snapshot: string | null;
}

const BASE = `SELECT id, code, name, stage, conclusion, shop_id, owner_id, stage_entered_at, test_started_at, test_snapshot
                FROM selection_flow WHERE is_deleted = 0`;

function snapshotOf(raw: string | null): Record<string, number> {
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, number>;
  } catch {
    return {};
  }
}

/** 阶段超时类规则的统一形状：一条 SQL 圈定阶段，JS 算停留天数，比较交给引擎的 operator/threshold */
function stageStale(stage: number, clock: (r: SelectionRow) => string | null) {
  return (rule: Rule, end: string): Hit[] => {
    const rows = all<SelectionRow>(`${BASE} AND stage = ?`, stage);
    return rows
      .map((r) => ({ r, days: daysSince(clock(r), end) }))
      .filter((x) => Number.isFinite(x.days) && x.days > rule.threshold)
      .map(({ r, days }) => ({
        target_type: 'selection',
        target_id: r.id,
        target_name: `${r.code} ${r.name}`,
        shop_id: r.shop_id,
        metric_value: days,
        evidence: {
          rule: rule.rule_code,
          selection_code: r.code,
          stage: r.stage,
          stage_entered_at: r.stage_entered_at,
          dwell_days: days,
          threshold_days: rule.threshold,
          window_days: rule.window_days,
          suggestion: `${rule.rule_name}：已停留 ${String(days)} 天，超过 ${String(rule.threshold)} 天口径`,
        },
      }));
  };
}

/** 登记后迟迟没进上架测试（方案 11.2 阶段一的超时规则） */
export const evalSelectionRegisterStale: Evaluator = stageStale(SELECTION_STAGE.REGISTERED, (r) => r.stage_entered_at);

/** 测试满期仍未提交结论 —— 方案把它列进 P0「今日必处理」 */
export const evalSelectionTestOverdue: Evaluator = (rule, end) => {
  const rows = all<SelectionRow>(`${BASE} AND stage = ? AND conclusion = ?`, SELECTION_STAGE.TESTING, SELECTION_CONCLUSION.PENDING);
  return rows
    .map((r) => ({ r, days: daysSince(r.test_started_at ?? r.stage_entered_at, end) }))
    .filter((x) => Number.isFinite(x.days) && x.days > rule.threshold)
    .map(({ r, days }) => ({
      target_type: 'selection',
      target_id: r.id,
      target_name: `${r.code} ${r.name}`,
      shop_id: r.shop_id,
      metric_value: days,
      evidence: {
        rule: rule.rule_code,
        selection_code: r.code,
        test_started_at: r.test_started_at,
        dwell_days: days,
        due_days: rule.threshold,
        overdue_by: days - rule.threshold,
        suggestion: `测试已满 ${String(days)} 天未提交结论（口径 ${String(rule.threshold)} 天），请负责人给出通过/不通过/复测并附数据快照`,
      },
    }));
};

/** 销售前准备清单长期没清完（方案 11.2 阶段四） */
export const evalSelectionPrepareOverdue: Evaluator = stageStale(SELECTION_STAGE.PREPARING, (r) => r.stage_entered_at);

/** 测试反馈积压：结论已提交但没落地（方案 11.2 阶段三要回写商品档案） */
export const evalSelectionFeedbackStale: Evaluator = stageStale(SELECTION_STAGE.FEEDBACK, (r) => r.stage_entered_at);

/**
 * 上架 48-72 小时的首次检测窗口（与新品冷启同一节奏）。
 * 命中条件是「落在窗口内且还没提交结论」，超窗就不该再报 —— 由 window_days 与 until_hours 共同界定。
 */
export const evalSelectionFirstCheck: Evaluator = (rule, end) => {
  const params = JSON.parse(rule.params_json || '{}') as { until_hours?: number };
  const until = params.until_hours ?? 72;
  const rows = all<SelectionRow>(`${BASE} AND stage = ? AND conclusion = ?`, SELECTION_STAGE.TESTING, SELECTION_CONCLUSION.PENDING);
  return rows
    .map((r) => ({ r, hours: hoursSince(r.test_started_at ?? r.stage_entered_at, end) }))
    .filter((x) => Number.isFinite(x.hours) && x.hours >= rule.threshold && x.hours <= until)
    .map(({ r, hours }) => ({
      target_type: 'selection',
      target_id: r.id,
      target_name: `${r.code} ${r.name}`,
      shop_id: r.shop_id,
      metric_value: r4(hours),
      evidence: {
        rule: rule.rule_code,
        selection_code: r.code,
        hours_since_launch: r4(hours),
        window: [rule.threshold, until],
        snapshot: snapshotOf(r.test_snapshot),
        suggestion: `上架 ${String(Math.round(hours))} 小时，做首次检测：CTR/加购率/转化率是否低于基准（低于基准不代表判死刑，窗口 ${String(until)}h 内继续观察）`,
      },
    }));
};

/**
 * 测试期表现优异（P1「建议提前进入销售准备」）。
 * 基准值必须来自规则参数（ctr_baseline / cvr_baseline），不写死在代码里；
 * 没配基准时不生成事件 —— 宁可不报，也不拿一个拍脑袋的数当基准。
 */
export const evalSelectionTestStrong: Evaluator = (rule, end) => {
  const params = JSON.parse(rule.params_json || '{}') as { ctr_baseline?: number; cvr_baseline?: number };
  if (!params.ctr_baseline && !params.cvr_baseline) return [];
  const rows = all<SelectionRow>(`${BASE} AND stage = ?`, SELECTION_STAGE.TESTING);
  const hits: Hit[] = [];
  for (const r of rows) {
    const snap = snapshotOf(r.test_snapshot);
    const ctrRatio = params.ctr_baseline && Number.isFinite(snap.ctr) ? snap.ctr / params.ctr_baseline : 0;
    const cvrRatio = params.cvr_baseline && Number.isFinite(snap.cvr) ? snap.cvr / params.cvr_baseline : 0;
    const over = Math.max(ctrRatio, cvrRatio);
    if (!(over > rule.threshold)) continue;
    hits.push({
      target_type: 'selection',
      target_id: r.id,
      target_name: `${r.code} ${r.name}`,
      shop_id: r.shop_id,
      metric_value: r4(over),
      evidence: {
        rule: rule.rule_code,
        selection_code: r.code,
        ctr: snap.ctr ?? null,
        cvr: snap.cvr ?? null,
        ctr_baseline: params.ctr_baseline ?? null,
        cvr_baseline: params.cvr_baseline ?? null,
        over_baseline: r4(over),
        days_in_test: daysSince(r.test_started_at ?? r.stage_entered_at, end),
        snapshot: snap,
        suggestion: `测试期指标达基准 ${String(r4(over))} 倍，建议提前提交结论并进入销售前准备`,
      },
    });
  }
  return hits;
};

/** rule_code -> 评估函数，由 services/rules/engine.ts 并进 EVALUATORS */
export const SELECTION_EVALUATORS: Record<string, Evaluator> = {
  SELECTION_REGISTER_STALE: evalSelectionRegisterStale,
  SELECTION_TEST_OVERDUE: evalSelectionTestOverdue,
  SELECTION_PREPARE_OVERDUE: evalSelectionPrepareOverdue,
  SELECTION_FEEDBACK_STALE: evalSelectionFeedbackStale,
  SELECTION_FIRST_CHECK: evalSelectionFirstCheck,
  SELECTION_TEST_STRONG: evalSelectionTestStrong,
};
