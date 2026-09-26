/**
 * AI 的工具白名单：定义 + 执行。
 *
 * 三条规矩：
 *  1. 工具只走**已有的 service 入口**（dashboardMetrics / computeProfitReport / handleEvent / recordOutreach），
 *     不在这里写第二套口径或第二条 SQL —— 那正是本项目一直防的分叉。
 *  2. 每个工具都带 `user`，读工具的数据范围由被调的 service 自己收敛（shopScope / eventScope），
 *     写工具落 op_log 的 created_by 是**点对话的那个人**，不是"AI"。
 *  3. 返回给模型的 JSON 一律裁剪：整张利润表几十行乘几十列塞回去，既烧 token 又让模型抓不到重点。
 */
import { z } from 'zod';
import { AI_TOOL, AI_WRITE_TOOLS, type AiToolName, type CurrentUser } from '@tk/shared';
import { all } from '../../core/db.js';
import { badRequest, forbidden } from '../../core/http.js';
import { dashboardMetrics, computeProfitReport } from '../profit.js';
import { eventScope, handleEvent } from '../rules/engine.js';
import { recordOutreach, outreachBody } from '../creator/outreach.js';
import type { AiToolSpec } from './types.js';

export interface ToolContext {
  user: CurrentUser;
  ip?: string;
  callId?: number | null;
  conversationId?: number | null;
}

export interface ToolDef {
  name: AiToolName;
  write: boolean;
  /** 需要哪个一级菜单；不满足时这个工具根本不会出现在给模型的清单里 */
  menu: 'dashboard' | 'creator';
  description: string;
  parameters: Record<string, unknown>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 数组只留前 n 条、对象只留白名单键：控制回给模型的体积 */
function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

const DAYS = { type: 'integer', minimum: 1, maximum: 365, description: '统计天数，区间为「今天-(days-1) ~ 今天」；不传按 30 天' } as const;
const MONTH = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}$',
  description: '自然月 YYYY-MM（问"本月/上月/某个月"必须用这个，别拿近 30 天当本月）；传了就忽略 days',
} as const;

/** 把 YYYY-MM-DD 往前推 n 天（UTC 算法，和利润引擎的区间口径一致） */
function rangeOfDays(days: number): { start: string; end: string } {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - (Math.max(1, days) - 1) * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * 读工具统一取区间：两端都含（与 computeProfitReport / dashboardMetrics 的 `day > range.end` 判定一致）。
 * 自然月截到今天 —— 没过完的月不把未来日子算进去，但也不退化成"近 30 天"。
 */
function periodRange(args: Record<string, unknown>): { start: string; end: string } {
  const month = String(args.month ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(month)) {
    const start = `${month}-01`;
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const last = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    return { start, end: last > today ? today : last };
  }
  return rangeOfDays(Number(args.days ?? 30) || 30);
}

export const AI_TOOLS: Record<AiToolName, ToolDef> = {
  [AI_TOOL.GET_DASHBOARD]: {
    name: AI_TOOL.GET_DASHBOARD,
    write: false,
    menu: 'dashboard',
    description: '读经营看板：净带货 GMV、订单数、应收返点（我们唯一的收入）、贡献毛利、广告 ROAS、待办计数、逐日趋势与店铺/达人榜。回答经营性问题先调它。',
    parameters: obj({ days: DAYS, month: MONTH }),
    async run(ctx, args) {
      const { start, end } = periodRange(args);
      const m = dashboardMetrics(ctx.user, { start, end }) as unknown as Record<string, unknown>;
      const trim = (rows: unknown, keys: readonly string[], n = 6) =>
        Array.isArray(rows) ? rows.slice(0, n).map((r) => pick(r as Record<string, unknown>, keys)) : [];
      return {
        区间: { start, end },
        指标: pick(m, [
          'gmv', 'orders', 'refund_amount', 'refund_rate', 'est_rebate', 'est_logistics', 'est_gross_profit',
          'est_profit_rate', 'settled_amount', 'ad_spend', 'ad_gmv', 'ad_roi', 'unmapped_listings',
          'creators_to_follow', 'samples_overdue', 'auth_expiring', 'sync_failed', 'live_today', 'can_see_cost',
        ]),
        逐日趋势: trim(m.gmv_trend, ['date', 'gmv', 'orders', 'profit'], 14),
        店铺榜: trim(m.shop_rank, ['shop_name', 'gmv', 'orders', 'profit']),
        达人榜: trim(m.creator_rank, ['handle', 'gmv', 'orders', 'rebate']),
        口径: 'est_profit_rate 的分母是应收返点；广告打平看的是占 GMV 的贡献毛利率，两者不同名同值',
      };
    },
  },

  [AI_TOOL.GET_PROFIT_REPORT]: {
    name: AI_TOOL.GET_PROFIT_REPORT,
    write: false,
    menu: 'dashboard',
    description: '读利润报表（与「财务中心 → 利润报表」同一引擎）：按店铺 / SKU / 达人 / 月份任一分维，给出应收返点、物流、达人佣金、广告、费用与贡献毛利。问"哪个店/哪个品/哪个达人在亏钱"时调它。',
    parameters: obj({
      dim: { type: 'string', enum: ['shop', 'sku', 'creator', 'month'], description: '统计维度，默认 shop' },
      days: DAYS,
      month: MONTH,
      only_settled: { type: 'boolean', description: '只看已结算订单，默认 false' },
    }),
    async run(ctx, args) {
      const { start, end } = periodRange(args);
      const dim = (['shop', 'sku', 'creator', 'month'].includes(String(args.dim)) ? String(args.dim) : 'shop') as 'shop' | 'sku' | 'creator' | 'month';
      const report = computeProfitReport({ user: ctx.user, dim, start, end, onlySettled: args.only_settled === true });
      const rows = (report.list ?? []).map((r) =>
        pick(r as unknown as Record<string, unknown>, ['dim_key', 'dim_name', 'orders', 'gmv', 'refund', 'net_gmv', 'rebate', 'logistics', 'commission', 'ad_spend', 'expense', 'profit', 'profit_rate', 'is_estimated']),
      );
      const sorted = [...rows].sort((a, b) => Number(a.profit ?? 0) - Number(b.profit ?? 0));
      return {
        区间: { start, end },
        维度: dim,
        合计: report.total ? pick(report.total as unknown as Record<string, unknown>, ['orders', 'gmv', 'net_gmv', 'rebate', 'logistics', 'commission', 'ad_spend', 'expense', 'profit', 'profit_rate']) : null,
        最亏的前10行: sorted.slice(0, 10),
        最赚的前10行: sorted.slice(-10).reverse(),
        行数: rows.length,
        口径: '贡献毛利 = 应收返点 −（物流 + 达人佣金 + 分摊广告 + 分摊费用）；没配返点率的订单行整体不在表内',
      };
    },
  },

  [AI_TOOL.LIST_ALERTS]: {
    name: AI_TOOL.LIST_ALERTS,
    write: false,
    menu: 'dashboard',
    description: '读还没闭环的预警（P0/P1/P2），含规则名、对象、优先级、到期时间与证据快照。问"现在有什么问题"时先调它，再决定要不要写处置动作。',
    parameters: obj({
      priority: { type: 'integer', minimum: 0, maximum: 2, description: '只看某个优先级；不传=全部' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: '最多返回几条，默认 15' },
    }),
    async run(ctx, args) {
      const scope = eventScope(ctx.user);
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15) || 15));
      const params: (number | string)[] = [...scope.params];
      let filter = `ae.status IN (0, 1)${scope.sql}`;
      if (args.priority !== undefined && args.priority !== null) {
        filter += ' AND ae.priority = ?';
        params.push(Number(args.priority));
      }
      const rows = all<Record<string, unknown>>(
        `SELECT ae.id, ar.rule_code AS rule_code, ar.rule_name AS rule_name, ae.target_type, ae.target_name, ae.priority,
                ae.status, ae.due_at, ae.evidence_json, COALESCE(u.real_name, '') AS owner_name
           FROM alert_event ae
           JOIN alert_rule ar ON ar.id = ae.rule_id
           LEFT JOIN sys_user u ON u.id = ae.owner_id
          WHERE ae.is_deleted = 0 AND ${filter}
          ORDER BY ae.priority ASC, ae.detected_at DESC
          LIMIT ?`,
        ...params,
        limit,
      );
      return {
        条数: rows.length,
        清单: rows.map((r) => ({
          预警ID: r.id,
          规则: r.rule_name,
          对象: r.target_name,
          对象类型: r.target_type,
          优先级: `P${Number(r.priority)}`,
          状态: Number(r.status) === 0 ? '新建' : '处理中',
          到期: r.due_at,
          负责人: r.owner_name || '未指派',
          证据: typeof r.evidence_json === 'string' ? safeJson(r.evidence_json) : r.evidence_json,
        })),
      };
    },
  },

  [AI_TOOL.RECORD_ALERT_ACTION]: {
    name: AI_TOOL.RECORD_ALERT_ACTION,
    write: true,
    menu: 'dashboard',
    description:
      '给一条预警写处置动作（处理 / 忽略 / 转派 / 仅备注），与「今日行动中心」点按钮走的是同一个函数。' +
      '必须先 list_alerts 拿到 event_id，且 note 要写清"做了什么、为什么"，不许编造没有做过的动作。',
    parameters: obj(
      {
        event_id: { type: 'integer', description: 'alert_event.id，来自 list_alerts' },
        action_type: { type: 'string', enum: ['handle', 'ignore', 'transfer', 'note'], description: '处置动作' },
        note: { type: 'string', maxLength: 500, description: '做了什么 / 为什么忽略。handle 与 ignore 必填' },
        expected_result: { type: 'string', maxLength: 200, description: '预期结果（handle 时用于效果回看对比）' },
        observe_until: { type: 'string', description: '观察到哪天，YYYY-MM-DD（handle 可选，默认 7 天后）' },
        owner_id: { type: 'integer', description: '转派给的员工 ID（action_type=transfer 时必填）' },
      },
      ['event_id', 'action_type'],
    ),
    async run(ctx, args) {
      const eventId = Number(args.event_id);
      if (!Number.isInteger(eventId) || eventId <= 0) throw badRequest('event_id 必须是 list_alerts 返回的整数 ID');
      // 数据范围：不在本人可见范围内的预警，AI 不能替他处理（与界面同一条 eventScope）
      const scope = eventScope(ctx.user);
      const visible = all<Record<string, unknown>>(
        `SELECT ae.id FROM alert_event ae JOIN alert_rule ar ON ar.id = ae.rule_id
          WHERE ae.is_deleted = 0 AND ae.id = ?${scope.sql}`,
        eventId,
        ...scope.params,
      );
      if (!visible.length) throw forbidden(`预警 #${eventId} 不在你的数据范围内，AI 不能替你处理它`);
      const actionType = String(args.action_type ?? '');
      if (actionType === 'transfer' && !Number(args.owner_id)) throw badRequest('转派必须指定 owner_id');
      if (['handle', 'ignore'].includes(actionType) && !String(args.note ?? '').trim()) throw badRequest(`${actionType} 必须写明 note（做了什么 / 为什么忽略）`);
      const out = handleEvent(eventId, ctx.user.id, {
        action_type: actionType as 'handle' | 'ignore' | 'transfer' | 'note',
        note: args.note == null ? null : String(args.note),
        expected_result: args.expected_result == null ? null : String(args.expected_result),
        observe_until: args.observe_until == null ? null : String(args.observe_until),
        owner_id: args.owner_id == null ? null : Number(args.owner_id),
      });
      return { action_id: out.action_id, event_status: out.status, 说明: '已写入处置流水，可在「今日行动中心 → 效果回看」追溯' };
    },
  },

  [AI_TOOL.CREATE_OUTREACH]: {
    name: AI_TOOL.CREATE_OUTREACH,
    write: true,
    menu: 'creator',
    description:
      '登记一条达人建联跟进（与「达人中心 → 建联跟进」快捷录入同一个函数）：公海达人会自动转入跟进人私海并续 7 天保护期。' +
      '黑名单达人与他人私海达人会被拒绝。result：1 未回复 2 已回复 3 有意向 4 报价中 5 拒绝 6 谈妥。',
    parameters: obj(
      {
        creator_id: { type: 'integer', description: '达人 ID' },
        result: { type: 'integer', minimum: 1, maximum: 6, description: '本次跟进结果，默认 1 未回复' },
        channel: { type: 'integer', minimum: 1, maximum: 4, description: '联系渠道，默认 1' },
        summary: { type: 'string', maxLength: 500, description: '一句话结论：聊了什么、对方要多少佣金、下一步' },
        next_follow_at: { type: 'string', description: '下次跟进时间 YYYY-MM-DD' },
      },
      ['creator_id'],
    ),
    async run(ctx, args) {
      const body = outreachBody.parse({
        creator_id: Number(args.creator_id),
        result: args.result == null ? undefined : Number(args.result),
        channel: args.channel == null ? undefined : Number(args.channel),
        summary: args.summary == null ? null : String(args.summary),
        next_follow_at: args.next_follow_at == null ? null : String(args.next_follow_at),
      });
      const out = recordOutreach(ctx.user, body, ctx.ip);
      return { outreach_id: out.id, creator: out.creator, hint: out.hint };
    },
  },
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

/** 这个用户能看到哪些工具：菜单不够的直接从清单里摘掉（不给模型一个会 403 的选项） */
export function toolsFor(user: CurrentUser): ToolDef[] {
  const has = (m: 'dashboard' | 'creator') => user.role_key === 'boss' || user.menu_perms.includes(m);
  return Object.values(AI_TOOLS).filter((t) => has(t.menu));
}

export function toolSpecs(defs: ToolDef[]): AiToolSpec[] {
  return defs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export const isWriteTool = (name: string): boolean => (AI_WRITE_TOOLS as readonly string[]).includes(name);

/** 执行一次工具调用。找不到名字 = 模型幻觉出一个不存在的工具，回一段说明文字而不是抛异常打断对话 */
export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const def = (AI_TOOLS as Record<string, ToolDef | undefined>)[name];
  if (!def) {
    return { ok: false, payload: { error: `工具 ${name} 不存在；可用工具：${Object.keys(AI_TOOLS).join(' / ')}` } };
  }
  if (!toolsFor(ctx.user).some((t) => t.name === def.name)) {
    return { ok: false, payload: { error: `你没有「${def.menu === 'creator' ? '达人中心' : '工作台'}」菜单，AI 不会替你越权调用 ${name}` } };
  }
  try {
    return { ok: true, payload: await def.run(ctx, args) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof Error && 'status' in e ? Number((e as unknown as { status: number }).status) : 500;
    return { ok: false, payload: { error: msg || '工具执行失败', status } };
  }
}

/** 给模型看的"你是谁、你能干什么、规矩是什么" */
export function systemPrompt(user: CurrentUser, extra: string[]): string {
  const tools = toolsFor(user);
  return [
    '你是 TikTok 代运营后台里的经营助手。这个系统的收入口径是「品牌服务方」：货是品牌的，' +
      '我们只按实收 GMV 拿品牌返点，系统里没有采购价；贡献毛利 = 应收返点 −（物流 + 达人佣金 + 分摊广告 + 公共费用）。',
    '回答经营数字时不要凭记忆，必须调用工具取当前数据；调不到就直说取不到，不要编。',
    `今天是 ${new Date().toISOString().slice(0, 10)}。"本月/上月/9 月"这类说法先换成这个日期再算，` +
      '并把算出来的自然月用工具的 month 参数（YYYY-MM）传进去 —— 近 30 天不等于本月，' +
      '引用数字时必须复述工具返回的「区间」两端。',
    '你能写入的业务动作仅限这些白名单工具：' +
      `${tools.filter((t) => t.write).map((t) => t.name).join(' / ') || '（当前角色没有可写工具）'}。` +
      '删除、改价、上架、对外给达人发消息一律不允许，用户提这种要求要直接说明系统不开放给 AI 执行。',
    '写业务数据前必须已经用读工具确认对象存在（例如先 list_alerts 再 record_alert_action），' +
      '且备注/结论只能写用户真正说过要做的事，不许把建议写成"已处理"。',
    `当前用户：${user.real_name}（角色 ${user.role_key}，数据范围 data_scope=${user.data_scope}）。` +
      '你能看见和改动的数据以这个人的权限为限。',
    '用中文回答，简短直给：先结论、再依据（带数字与区间）、最后给下一步。金额一律人民币并说明分母口径。',
    ...extra,
  ].join('\n\n');
}
