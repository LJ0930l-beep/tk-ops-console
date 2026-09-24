/**
 * V2.0 规则引擎（§14 / §15.3）：alert_rule 配置化评估 → alert_event 生成 → 动作闭环 → 效果回看。
 *
 * 硬约束（§0.1 / §21）：
 *  - 所有阈值、窗口、冷却、优先级来自 alert_rule 表；附录 B 默认值只是 seed，不得写死在代码。
 *  - 每条命中必须带 evidence_json 证据快照；同一规则同一对象在冷却期内不重复生成事件。
 *  - 引擎只检测与建议，不自动改广告预算/下架商品（§1 非目标）。
 */
import { all, get, insert, update } from '../../core/db.js';
import { badRequest, notFound } from '../../core/http.js';
import { DEFAULT_ALERT_RULES } from '@tk/shared';
import { rateToCnyExpr, todayUtc } from '../rates.js';
import { scanCreatorTrends, scanProductChannels, scanVideoDecay } from '../analytics.js';
import { SELECTION_EVALUATORS } from './selection.js';

type Num = number | string | bigint | null;
const n = (v: Num | undefined): number => Number(v ?? 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

const addDays = (day: string, k: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + k * 86400_000).toISOString().slice(0, 10) : day;
};
const addHours = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
const nowUtc = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

interface RuleRow {
  id: number;
  rule_code: string;
  rule_name: string;
  target_type: string;
  metric: string;
  operator: string;
  threshold: number;
  window_days: number;
  priority: number;
  cooldown_hours: number;
  params_json: string;
}

export interface Hit {
  target_type: string;
  target_id: number | null;
  target_name: string | null;
  shop_id: number | null;
  metric_value: number;
  evidence: Record<string, unknown>;
}

/** 幂等落默认规则：已存在（含用户改过的阈值）一律不覆盖，只补缺 */
export function ensureDefaultRules(userId: number | null = null): number {
  let added = 0;
  for (const r of DEFAULT_ALERT_RULES) {
    const exists = get(`SELECT id FROM alert_rule WHERE rule_code = ? AND is_deleted = 0`, r.rule_code);
    if (exists) continue;
    insert('alert_rule', { ...r, created_by: userId } as never);
    added += 1;
  }
  return added;
}

export function compare(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '==': return Math.abs(value - threshold) < 1e-9;
    default: return false;
  }
}

/* ==================== 单规则评估 ==================== */

function evalChannelDependency(rule: RuleRow, end: string): Hit[] {
  const params = JSON.parse(rule.params_json || '{}') as { rising?: boolean };
  const hits: Hit[] = [];
  for (const p of scanProductChannels(end, rule.window_days)) {
    if (p.max_channel === null) continue;
    if (params.rising !== false && !p.rising) continue;
    if (!compare(p.max_share, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'product',
      target_id: p.spu_id,
      target_name: p.spu_name,
      shop_id: p.shop_id,
      metric_value: r4(p.max_share),
      evidence: {
        rule: rule.rule_code,
        window_days: rule.window_days,
        max_channel: p.max_channel,
        max_share: r4(p.max_share),
        prev_max_share: r4(p.prev_max_share),
        rising: p.rising,
        net_gmv: p.net_gmv,
      },
    });
  }
  return hits;
}

function evalChannelMigration(rule: RuleRow, end: string): Hit[] {
  const hits: Hit[] = [];
  for (const p of scanProductChannels(end, rule.window_days)) {
    if (p.drift_channel === null) continue;
    if (!compare(Math.abs(p.drift_delta), rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'product',
      target_id: p.spu_id,
      target_name: p.spu_name,
      shop_id: p.shop_id,
      metric_value: r4(p.drift_delta),
      evidence: { rule: rule.rule_code, drift_channel: p.drift_channel, drift_delta: r4(p.drift_delta), net_gmv: p.net_gmv },
    });
  }
  return hits;
}

function evalSampleSilent(rule: RuleRow, end: string): Hit[] {
  const rows = all<{ id: number; creator_id: number; nickname: string | null; handle: string; sign_time: string; days: Num }>(
    `SELECT s.id, s.creator_id, c.nickname, c.handle, s.sign_time,
            CAST(julianday(?) - julianday(substr(s.sign_time, 1, 10)) AS INTEGER) AS days
       FROM sample_shipment s
       JOIN creator c ON c.id = s.creator_id
      WHERE s.is_deleted = 0 AND s.status = 3 AND s.sign_time IS NOT NULL`,
    end,
  );
  return rows
    .filter((r) => compare(n(r.days), rule.operator, rule.threshold))
    .map((r) => ({
      target_type: 'sample',
      target_id: r.id,
      target_name: `${r.nickname || r.handle} 寄样单#${r.id}`,
      shop_id: null,
      metric_value: n(r.days),
      evidence: { rule: rule.rule_code, creator_id: r.creator_id, sign_time: r.sign_time, days_since_sign: n(r.days) },
    }));
}

function evalCreatorRefund(rule: RuleRow, end: string): Hit[] {
  // 类目基准暂无独立数据源：用全体达人 30 天平均退货率做基准（参数 baseline 可覆盖），口径写进证据
  const scans = scanCreatorTrends(end, 4);
  const withGmv = scans.filter((s) => s.net_gmv_30d > 0 || s.refund_rate > 0);
  const baseline = (() => {
    const params = JSON.parse(rule.params_json || '{}') as { baseline?: number };
    if (typeof params.baseline === 'number') return params.baseline;
    if (!withGmv.length) return 0;
    return withGmv.reduce((a, s) => a + s.refund_rate, 0) / withGmv.length;
  })();
  const hits: Hit[] = [];
  for (const s of scans) {
    const over = s.refund_rate - baseline;
    if (!compare(over, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'creator',
      target_id: s.creator_id,
      target_name: s.creator_name,
      shop_id: null,
      metric_value: r4(over),
      evidence: {
        rule: rule.rule_code,
        refund_rate: s.refund_rate,
        baseline: r4(baseline),
        baseline_source: '全体达人30天均值（规则参数可覆盖）',
        suggestion: '暂停寄样建议（由 BD/主管确认）',
      },
    });
  }
  return hits;
}

function evalCreatorDecline(rule: RuleRow, end: string): Hit[] {
  const weeks = Math.max(2, Math.ceil(rule.window_days / 7));
  const hits: Hit[] = [];
  for (const s of scanCreatorTrends(end, weeks)) {
    if (!compare(s.decline_weeks, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'creator',
      target_id: s.creator_id,
      target_name: s.creator_name,
      shop_id: null,
      metric_value: s.decline_weeks,
      evidence: { rule: rule.rule_code, weekly_net_gmv: s.weekly_net_gmv, decline_weeks: s.decline_weeks },
    });
  }
  return hits;
}

function evalNewProduct(rule: RuleRow, end: string): Hit[] {
  const params = JSON.parse(rule.params_json || '{}') as { until_hours?: number };
  const hits: Hit[] = [];
  for (const p of scanProductChannels(end, rule.window_days)) {
    const hours = p.days_since_launch * 24;
    let metricValue: number;
    if (rule.rule_code === 'NEW_PRODUCT_CHECK_1') {
      metricValue = hours;
      if (params.until_hours && hours > params.until_hours) continue;
    } else if (rule.rule_code === 'NEW_PRODUCT_FAIL') {
      metricValue = p.has_interaction ? 1 : 0;
      if (p.days_since_launch < 7 || p.days_since_launch > 14) continue;
    } else {
      metricValue = p.days_since_launch;
      if (p.days_since_launch > rule.threshold + rule.window_days) continue; // 结束很久的不刷屏
    }
    if (!compare(metricValue, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'product',
      target_id: p.spu_id,
      target_name: p.spu_name,
      shop_id: p.shop_id,
      metric_value: r2(metricValue),
      evidence: {
        rule: rule.rule_code,
        days_since_launch: p.days_since_launch,
        has_interaction: p.has_interaction,
        orders: p.orders,
        net_gmv: p.net_gmv,
      },
    });
  }
  return hits;
}

function evalVideoDecay(rule: RuleRow, end: string): Hit[] {
  const params = JSON.parse(rule.params_json || '{}') as { consecutive?: number };
  const need = params.consecutive ?? 2;
  const hits: Hit[] = [];
  for (const v of scanVideoDecay(end)) {
    if (v.consecutive < need) continue;
    if (!compare(v.ratio, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'video',
      target_id: v.video_id,
      target_name: v.video_url || `视频#${v.video_id}`,
      shop_id: null,
      metric_value: v.ratio,
      evidence: { rule: rule.rule_code, ma3: v.ma3, peak7: v.peak7, ratio: v.ratio, consecutive: v.consecutive, net_gmv_7d: v.net_gmv_7d },
    });
  }
  return hits;
}

function evalAdsLoss(rule: RuleRow, end: string): Hit[] {
  const start = addDays(end, -(rule.window_days - 1));
  const adRate = rateToCnyExpr('a.currency', 'a.stat_date');
  const ads = all<{ shop_id: number; spend: Num; gmv: Num }>(
    `SELECT a.shop_id, ROUND(SUM(a.spend * ${adRate}), 2) AS spend, ROUND(SUM(a.gmv * ${adRate}), 2) AS gmv
       FROM ad_daily a WHERE a.is_deleted = 0 AND a.stat_date BETWEEN ? AND ? GROUP BY a.shop_id`,
    start,
    end,
  );
  const orderRate = rateToCnyExpr('o.currency', 'substr(o.order_time, 1, 10)');
  const margins = all<{ shop_id: number; gmv: Num; cost: Num; commission: Num }>(
    `SELECT o.shop_id, ROUND(SUM(i.item_amount * ${orderRate}), 2) AS gmv,
            ROUND(SUM(i.cost_snapshot), 2) AS cost, ROUND(SUM(i.est_commission * ${orderRate}), 2) AS commission
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
      WHERE i.is_deleted = 0 AND i.cost_matched = 1 AND o.order_status <> 'CANCELLED' AND o.is_sample_order = 0
        AND substr(o.order_time, 1, 10) BETWEEN ? AND ?
      GROUP BY o.shop_id`,
    start,
    end,
  );
  const marginOf = new Map(margins.map((m) => {
    const gmv = n(m.gmv);
    return [Number(m.shop_id), gmv > 0 ? (gmv - n(m.cost) - n(m.commission)) / gmv : 0];
  }));
  const hits: Hit[] = [];
  for (const a of ads) {
    const spend = n(a.spend);
    if (spend <= 0) continue;
    const roas = n(a.gmv) / spend;
    // 广告前贡献毛利率（简化口径：净 GMV-采购成本-佣金；平台费/物流未扣，写入证据可解释）
    const margin = marginOf.get(Number(a.shop_id)) ?? 0;
    if (margin <= 0) continue;
    const breakeven = 1 / margin;
    const metric = roas / breakeven;
    if (!compare(metric, rule.operator, rule.threshold)) continue;
    hits.push({
      target_type: 'ads',
      target_id: Number(a.shop_id),
      target_name: `店铺#${a.shop_id} 投放`,
      shop_id: Number(a.shop_id),
      metric_value: r4(metric),
      evidence: {
        rule: rule.rule_code,
        window: { start, end },
        spend_cny: r2(spend),
        attributed_gmv_cny: r2(n(a.gmv)),
        roas: r2(roas * 100) / 100,
        contribution_margin: r4(margin),
        breakeven_roas: r2(breakeven * 100) / 100,
        margin_note: '贡献毛利率=（GMV-成本快照-佣金）/GMV，未扣平台费/物流',
      },
    });
  }
  return hits;
}

const EVALUATORS: Record<string, (rule: RuleRow, end: string) => Hit[]> = {
  CHANNEL_DEPENDENCY: evalChannelDependency,
  CHANNEL_MIGRATION: evalChannelMigration,
  SAMPLE_SILENT: evalSampleSilent,
  CREATOR_REFUND: evalCreatorRefund,
  CREATOR_DECLINE: evalCreatorDecline,
  NEW_PRODUCT_CHECK_1: evalNewProduct,
  NEW_PRODUCT_FAIL: evalNewProduct,
  NEW_PRODUCT_END: evalNewProduct,
  VIDEO_DECAY: evalVideoDecay,
  ADS_LOSS: evalAdsLoss,
  // 选品流水线（方案第十一章）：超时/首检/表现优异，规则实现单独成文件，这张表只负责分发
  ...SELECTION_EVALUATORS,
};

/* ==================== 冷却去重 + 事件生成 ==================== */

function inCooldown(rule: RuleRow, hit: Hit): boolean {
  const last = get<{ detected_at: string }>(
    `SELECT detected_at FROM alert_event
      WHERE is_deleted = 0 AND rule_id = ? AND target_type = ?
        AND ((target_id IS NULL AND ? IS NULL) OR target_id = ?)
      ORDER BY detected_at DESC LIMIT 1`,
    rule.id,
    hit.target_type,
    hit.target_id,
    hit.target_id,
  );
  if (!last?.detected_at) return false;
  const t = Date.parse(String(last.detected_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && Date.now() - t < rule.cooldown_hours * 3600_000;
}

function ownerOf(hit: Hit): number | null {
  if (hit.target_type === 'creator') {
    const row = get<{ owner_id: number | null }>(`SELECT owner_id FROM creator WHERE id = ? AND is_deleted = 0`, hit.target_id);
    return row?.owner_id ?? null;
  }
  if (hit.target_type === 'sample') {
    const row = get<{ owner_id: number | null }>(
      `SELECT c.owner_id FROM sample_shipment s JOIN creator c ON c.id = s.creator_id WHERE s.id = ?`,
      hit.target_id,
    );
    return row?.owner_id ?? null;
  }
  if (hit.target_type === 'product' && hit.target_id !== null) {
    const row = get<{ owner_id: number | null }>(`SELECT owner_id FROM product_spu WHERE id = ? AND is_deleted = 0`, hit.target_id);
    return row?.owner_id ?? null;
  }
  if (hit.target_type === 'selection' && hit.target_id !== null) {
    // 选品事件的负责人是「当前阶段负责人」，不是登记人 —— 卡片卡在谁手里就提醒谁
    const row = get<{ owner_id: number | null }>(`SELECT owner_id FROM selection_flow WHERE id = ? AND is_deleted = 0`, hit.target_id);
    return row?.owner_id ?? null;
  }
  return null;
}

const dueOf = (priority: number): string => addHours(priority === 0 ? 24 : priority === 1 ? 24 * 7 : 24 * 14);

export interface EvaluateOutcome {
  evaluated_rules: number;
  hits: number;
  created_events: number;
  skipped_cooldown: number;
  errors: { rule_code: string; message: string }[];
}

/** 跑一轮全部启用规则；单条规则失败不影响其余（失败留 sync_log 由外层记录） */
export function evaluateRules(opts: { end?: string; userId?: number | null } = {}): EvaluateOutcome {
  const end = opts.end ?? todayUtc();
  const userId = opts.userId ?? null;
  ensureDefaultRules(userId);
  const rules = all<RuleRow>(
    `SELECT id, rule_code, rule_name, target_type, metric, operator, threshold, window_days, priority, cooldown_hours, params_json
       FROM alert_rule WHERE is_deleted = 0 AND status = 1`,
  );
  const out: EvaluateOutcome = { evaluated_rules: rules.length, hits: 0, created_events: 0, skipped_cooldown: 0, errors: [] };
  for (const rule of rules) {
    try {
      const fn = EVALUATORS[rule.rule_code];
      if (!fn) {
        out.errors.push({ rule_code: rule.rule_code, message: '未实现的规则评估器' });
        continue;
      }
      const hits = fn({ ...rule, threshold: n(rule.threshold) }, end);
      out.hits += hits.length;
      for (const hit of hits) {
        if (inCooldown(rule, hit)) {
          out.skipped_cooldown += 1;
          continue;
        }
        insert('alert_event', {
          rule_id: rule.id,
          target_type: hit.target_type,
          target_id: hit.target_id,
          target_name: hit.target_name,
          shop_id: hit.shop_id,
          detected_at: nowUtc(),
          evidence_json: JSON.stringify(hit.evidence),
          priority: rule.priority,
          status: 0,
          owner_id: ownerOf(hit),
          due_at: dueOf(rule.priority),
          created_by: userId,
        } as never);
        out.created_events += 1;
      }
    } catch (e) {
      out.errors.push({ rule_code: rule.rule_code, message: (e as Error).message });
    }
  }
  return out;
}

/* ==================== 动作闭环 ==================== */

export interface TargetSnapshot {
  metric: string;
  value: number;
}

/** 目标当前指标快照（效果回看的 before/after 同一算法） */
export function metricSnapshot(targetType: string, targetId: number | null, end = todayUtc()): TargetSnapshot {
  const start7 = addDays(end, -6);
  if (targetType === 'product' && targetId !== null) {
    const row = get<{ ng: Num }>(
      `SELECT SUM(net_gmv) AS ng FROM analytics_product_channel_daily WHERE is_deleted = 0 AND spu_id = ? AND stat_date BETWEEN ? AND ?`,
      targetId, start7, end,
    );
    return { metric: 'net_gmv_7d', value: r2(n(row?.ng)) };
  }
  if (targetType === 'creator' && targetId !== null) {
    const row = get<{ ng: Num }>(
      `SELECT SUM(net_gmv) AS ng FROM analytics_creator_daily WHERE is_deleted = 0 AND creator_id = ? AND stat_date BETWEEN ? AND ?`,
      targetId, start7, end,
    );
    return { metric: 'net_gmv_7d', value: r2(n(row?.ng)) };
  }
  if (targetType === 'video' && targetId !== null) {
    const row = get<{ ng: Num }>(
      `SELECT SUM(net_gmv) AS ng FROM analytics_video_daily WHERE is_deleted = 0 AND video_id = ? AND stat_date BETWEEN ? AND ?`,
      targetId, addDays(end, -2), end,
    );
    return { metric: 'net_gmv_3d', value: r2(n(row?.ng)) };
  }
  if (targetType === 'sample' && targetId !== null) {
    const row = get<{ sign_time: string | null }>(`SELECT sign_time FROM sample_shipment WHERE id = ?`, targetId);
    const t = row?.sign_time ? Date.parse(String(row.sign_time).slice(0, 10) + 'T00:00:00Z') : NaN;
    return { metric: 'days_since_sign', value: Number.isFinite(t) ? Math.floor((Date.parse(`${end}T00:00:00Z`) - t) / 86400_000) : 0 };
  }
  if (targetType === 'ads' && targetId !== null) {
    const adRate = rateToCnyExpr('a.currency', 'a.stat_date');
    const row = get<{ spend: Num; gmv: Num }>(
      `SELECT ROUND(SUM(a.spend * ${adRate}), 2) AS spend, ROUND(SUM(a.gmv * ${adRate}), 2) AS gmv
         FROM ad_daily a WHERE a.is_deleted = 0 AND a.shop_id = ? AND a.stat_date BETWEEN ? AND ?`,
      targetId, start7, end,
    );
    const spend = n(row?.spend);
    return { metric: 'roas_7d', value: spend > 0 ? r2((n(row?.gmv) / spend) * 100) / 100 : 0 };
  }
  return { metric: 'none', value: 0 };
}

export interface HandleInput {
  action_type: 'handle' | 'ignore' | 'transfer' | 'note';
  note?: string | null;
  expected_result?: string | null;
  observe_until?: string | null;
  owner_id?: number | null;
}

/** 处理预警：写 operation_action 流水并推进事件状态；handle 同时生成 pending 效果回看行 */
export function handleEvent(eventId: number, handlerId: number, input: HandleInput): { action_id: number; status: number } {
  const ev = get<{ id: number; target_type: string; target_id: number | null; status: number }>(
    `SELECT id, target_type, target_id, status FROM alert_event WHERE id = ? AND is_deleted = 0`,
    eventId,
  );
  if (!ev) throw notFound('预警事件不存在');
  if (input.action_type === 'transfer' && !input.owner_id) {
    throw badRequest('转派必须指定 owner_id');
  }
  const observeUntil =
    input.action_type === 'handle'
      ? (input.observe_until ?? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10))
      : (input.observe_until ?? null);
  const actionId = insert('operation_action', {
    alert_event_id: eventId,
    handler_id: handlerId,
    action_type: input.action_type,
    action_at: nowUtc(),
    note: input.note ?? null,
    expected_result: input.expected_result ?? null,
    observe_until: observeUntil,
    created_by: handlerId,
  } as never);

  let status = ev.status;
  if (input.action_type === 'handle') {
    status = 2;
    const before = metricSnapshot(ev.target_type, ev.target_id);
    insert('action_result', {
      action_id: actionId,
      evaluated_at: nowUtc(),
      before_json: JSON.stringify(before),
      after_json: '{}',
      result: 'pending',
      created_by: handlerId,
    } as never);
  } else if (input.action_type === 'ignore') {
    status = 3;
  } else if (input.action_type === 'transfer') {
    status = 1;
    update('alert_event', eventId, { owner_id: input.owner_id } as never);
  } else if (status === 0) {
    status = 1;
  }
  update('alert_event', eventId, { status } as never);
  return { action_id: actionId, status };
}

/** 观察期到期的 pending 回看行：重算快照，给出 improved/unchanged/worse 与改善率 */
export function evaluateActionResults(end = todayUtc()): number {
  const pendings = all<{ id: number; action_id: number; before_json: string; observe_until: string; target_type: string; target_id: number | null }>(
    `SELECT ar.id, ar.action_id, ar.before_json, oa.observe_until, ae.target_type, ae.target_id
       FROM action_result ar
       JOIN operation_action oa ON oa.id = ar.action_id AND oa.is_deleted = 0
       JOIN alert_event ae ON ae.id = oa.alert_event_id AND ae.is_deleted = 0
      WHERE ar.is_deleted = 0 AND ar.result = 'pending' AND oa.observe_until IS NOT NULL AND oa.observe_until <= ?`,
    end,
  );
  let done = 0;
  for (const p of pendings) {
    const before = JSON.parse(p.before_json || '{}') as TargetSnapshot;
    const after = metricSnapshot(p.target_type, p.target_id, end);
    // days_since_sign 类指标越小越好，其余越大越好
    const lowerBetter = after.metric === 'days_since_sign';
    const base = Math.abs(before.value);
    const rate = base > 0 ? (after.value - before.value) / base : after.value > before.value ? 1 : after.value < before.value ? -1 : 0;
    const signed = lowerBetter ? -rate : rate;
    const result = signed > 0.02 ? 'improved' : signed < -0.02 ? 'worse' : 'unchanged';
    update('action_result', p.id, {
      evaluated_at: nowUtc(),
      after_json: JSON.stringify(after),
      result,
      improvement_rate: r4(signed),
    } as never);
    done += 1;
  }
  return done;
}

/** 规则版本迭代：改阈值等参数即 version+1（§4.1 规则可根据命中率/误报率迭代） */
export function bumpRuleVersion(ruleId: number): void {
  const row = get<{ version: number }>(`SELECT version FROM alert_rule WHERE id = ? AND is_deleted = 0`, ruleId);
  if (row) update('alert_rule', ruleId, { version: n(row.version) + 1 } as never);
}
