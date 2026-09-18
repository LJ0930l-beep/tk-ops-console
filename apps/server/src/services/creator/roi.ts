import { collabRoi, num, round2 } from '@tk/shared';
import { all, get, type SqlParam } from '../../core/db.js';

/**
 * 达人 / 合作单 / BD 投产比（方案 6.1 收尾）
 *
 *   合作投产比 = 带货净 GMV ÷（样品成本 + 寄样运费 + 坑位费 + 达人佣金）
 *
 * 口径说明（方案「要点 3」：时间统一 UTC，金额统一人民币）：
 *   - 净 GMV = 归因到该达人 / 该合作单的 tk_order_item.item_amount − 对应行退款，
 *     并排除 is_sample_order = 1（表 6 注明「达人免费样品单：不计入 GMV」）与已取消订单；
 *   - 订单金额、退款、预估佣金按订单币种 × 当天下单汇率折 CNY，缺当天汇率取该币种最近一条；
 *   - sample_cost / shipping_cost / expense.amount_cny 本身已是 CNY，不再乘汇率。
 *
 * 归因两条路径（tk_order_item 上没有 collab_id，达人可来自明细也来自视频）：
 *   1) tk_order_item.content_id = video.tk_video_id → video.creator_id / video.collab_id
 *   2) tk_order_item.creator_id 直接归因（联盟接口回传）
 * 两条路径用 UNION 合并成 (订单行, 归因对象) 集合，同一行不会被重复累加。
 */

/** 可参与带货归因的订单 */
export const ATTRIBUTABLE_ORDER = `o.is_deleted = 0 AND o.is_sample_order = 0 AND o.order_status <> 'CANCELLED'`;

/** 逐单汇率：下单当天优先，取不到用该币种最近一条 */
export const RATE_JOIN = `LEFT JOIN exchange_rate er ON er.currency = o.currency AND er.is_deleted = 0
   AND er.id = (SELECT e2.id FROM exchange_rate e2
                 WHERE e2.currency = o.currency AND e2.is_deleted = 0
                   AND e2.rate_date <= substr(o.order_time, 1, 10)
                 ORDER BY e2.rate_date DESC LIMIT 1)`;

/** 行级退款：只扣已完成的退款（方案 5.3 净 GMV 口径 / prd 4.2 场景 D） */
const REFUND_JOIN = `LEFT JOIN (SELECT r.tk_order_item_id AS item_id, SUM(r.refund_amount) AS refund_amount
                    FROM tk_return r WHERE r.is_deleted = 0 AND r.status = 'COMPLETED' GROUP BY r.tk_order_item_id) rf ON rf.item_id = i.id`;
export { REFUND_JOIN };

/** 人民币口径表达式（依赖别名 i / o / er / rf） */
export const AMOUNT_CNY = `i.item_amount * COALESCE(er.rate_to_cny, 1)`;
export const REFUND_CNY = `COALESCE(rf.refund_amount, 0) * COALESCE(er.rate_to_cny, 1)`;
export const COMMISSION_CNY = `i.est_commission * COALESCE(er.rate_to_cny, 1)`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 日期字面量：先校验格式再内联，避免子查询里的 ? 打乱参数顺序 */
const lit = (v: string): string => (DATE_RE.test(v) ? `'${v}'` : `'1970-01-01'`);

/** 任意「币种列 + 日期列」→ 汇率标量子查询 */
const rateExpr = (currency: string, day: string): string =>
  `(SELECT e.rate_to_cny FROM exchange_rate e
     WHERE e.currency = ${currency} AND e.is_deleted = 0 AND e.rate_date <= ${day}
     ORDER BY e.rate_date DESC LIMIT 1)`;

/** 今天（UTC） */
export const today = (): string => new Date().toISOString().slice(0, 10);

export interface PeriodRange {
  /** 起始日 YYYY-MM-DD，空串 = 不限 */
  from: string;
  /** 结束日 YYYY-MM-DD，空串 = 不限 */
  to: string;
  days: number;
}

/** '30d' / '90d' / '2026-09' / 'YYYY-MM-DD~YYYY-MM-DD' / 'all' → 区间；识别不了按近 30 天 */
export function resolvePeriod(period?: string | null): PeriodRange {
  const p = String(period ?? '30d').trim();
  if (p === 'all') return { from: '', to: '', days: 0 };
  const lastDays = (n: number): PeriodRange => ({
    from: new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10),
    to: today(),
    days: n,
  });
  if (/^\d+d$/.test(p)) return lastDays(Number(p.slice(0, -1)));
  if (/^\d{4}-\d{2}$/.test(p)) {
    const next = new Date(`${p}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { from: `${p}-01`, to: next.toISOString().slice(0, 10), days: 31 };
  }
  const range = p.split('~');
  if (range.length === 2 && DATE_RE.test(range[0] as string) && DATE_RE.test(range[1] as string)) {
    const [a, b] = [range[0] as string, range[1] as string];
    return { from: a, to: b, days: Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1 };
  }
  return lastDays(30);
}

/**
 * 汇率查询（方案 5.6 表 20）：指定日期优先，缺失则回退该币种最近一条。
 * 坑位费一键生成费用时折算 amount_cny 用。
 */
export function exchangeRate(currency: unknown, date?: string): number {
  const cur = String(currency ?? '').toUpperCase();
  if (!cur || cur === 'CNY') return 1;
  const day = DATE_RE.test(String(date ?? '')) ? (date as string) : today();
  const hit = get<{ rate_to_cny: number }>(
    `SELECT rate_to_cny FROM exchange_rate WHERE currency = ? AND is_deleted = 0 AND rate_date <= ?
      ORDER BY rate_date DESC LIMIT 1`,
    cur,
    day,
  ) ?? get<{ rate_to_cny: number }>(
    `SELECT rate_to_cny FROM exchange_rate WHERE currency = ? AND is_deleted = 0 ORDER BY rate_date DESC LIMIT 1`,
    cur,
  );
  return num(hit?.rate_to_cny) || 1;
}

type AttrKey = 'creator' | 'collab';

/** (订单行 id, 归因对象 id) 集合 */
function attrSql(key: AttrKey): string {
  const base = `FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id`;
  const cond = `i.is_deleted = 0 AND ${ATTRIBUTABLE_ORDER}`;
  const byContent = `SELECT i.id AS item_id, v.${key === 'creator' ? 'creator_id' : 'collab_id'} AS key_id
                       ${base} JOIN video v ON v.tk_video_id = i.content_id AND v.is_deleted = 0
                      WHERE ${cond} AND v.${key === 'creator' ? 'creator_id' : 'collab_id'} IS NOT NULL`;
  if (key === 'collab') return byContent;
  const byColumn = `SELECT i.id AS item_id, i.creator_id AS key_id ${base} WHERE ${cond} AND i.creator_id IS NOT NULL`;
  return `${byColumn} UNION ${byContent}`;
}

/** 按归因对象聚合的净收入 / 佣金（人民币） */
function incomeSql(key: AttrKey, period: PeriodRange): string {
  const where: string[] = [];
  if (period.from) where.push(`substr(o.order_time, 1, 10) >= ${lit(period.from)}`);
  if (period.to) where.push(`substr(o.order_time, 1, 10) <= ${lit(period.to)}`);
  return `SELECT k.key_id AS key_id,
                 SUM(${AMOUNT_CNY}) AS gmv_cny,
                 SUM(${REFUND_CNY}) AS refund_cny,
                 SUM(${COMMISSION_CNY}) AS commission_cny,
                 COUNT(DISTINCT CASE WHEN i.item_amount > 0 THEN o.id END) AS orders
            FROM (${attrSql(key)}) k
            JOIN tk_order_item i ON i.id = k.item_id
            JOIN tk_order o ON o.id = i.order_id
            ${RATE_JOIN}
            ${REFUND_JOIN}
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           GROUP BY k.key_id`;
}

/**
 * 寄样成本（人民币）：sample_cost 登记时即按「单件成本 × 数量」冻结为总额（prd 3.5），
 * 因此汇总时不再乘 quantity。按合作单归集。
 */
const SAMPLE_COST_BY_COLLAB = `SELECT s.collab_id AS collab_id, SUM(s.sample_cost) AS sample_cost,
                                       SUM(s.shipping_cost) AS shipping_cost
                                  FROM sample_shipment s WHERE s.is_deleted = 0 AND s.collab_id IS NOT NULL
                                 GROUP BY s.collab_id`;

/** 坑位费（人民币）：已生成费用单时以费用表 amount_cny 为准，否则按币种汇率折算 */
const COLLAB_FEE_CNY = `(COALESCE(
      (SELECT SUM(e.amount_cny) FROM expense e
        WHERE e.is_deleted = 0 AND e.ref_type = 'collaboration' AND e.ref_id = l.id AND e.expense_type = 1),
      l.fixed_fee * COALESCE(${rateExpr('l.fee_currency', 'substr(l.created_at, 1, 10)')}, 1)))`;

/** 期间内某列上的日期过滤，例如 l.created_at */
function periodWhere(col: string, period: PeriodRange, prefix: string): string {
  const parts: string[] = [];
  if (period.from) parts.push(`substr(${col}, 1, 10) >= ${lit(period.from)}`);
  if (period.to) parts.push(`substr(${col}, 1, 10) <= ${lit(period.to)}`);
  return `${prefix}${parts.length ? ` AND ${parts.join(' AND ')}` : ''}`;
}

export interface RoiRow {
  creator_id: number;
  handle: string;
  nickname: string | null;
  region: string | null;
  owner_id: number | null;
  owner_name: string | null;
  collabs: number;
  published_videos: number;
  orders: number;
  gmv_cny: number;
  refund_cny: number;
  net_gmv_cny: number;
  sample_cost: number;
  sample_shipping: number;
  fixed_fee_cny: number;
  commission_cny: number;
  cost: number;
  roi: number | null;
}

/**
 * 达人维度 ROI 排行（净 GMV / 成本 / 投产比）。
 * @param opts.scopeSql personScope(user, 'c.owner_id') 生成的 AND 片段
 */
export function roiByCreator(opts: { period: PeriodRange; scopeSql?: string; scopeParams?: SqlParam[]; limit?: number }): RoiRow[] {
  const scope = opts.scopeSql ? opts.scopeSql.replace(/^\s*AND\s+/i, '') : '';
  const sql = `
    SELECT c.id AS creator_id, c.handle, c.nickname, c.region, c.owner_id, u.real_name AS owner_name,
           (SELECT COUNT(*) FROM collaboration l WHERE l.creator_id = c.id AND l.is_deleted = 0) AS collabs,
           (SELECT COUNT(*) FROM video v WHERE v.creator_id = c.id AND v.is_deleted = 0
             AND v.collab_id IN (SELECT l.id FROM collaboration l WHERE l.creator_id = c.id)) AS published_videos,
           COALESCE(inc.orders, 0) AS orders,
           COALESCE(inc.gmv_cny, 0) AS gmv_cny,
           COALESCE(inc.refund_cny, 0) AS refund_cny,
           COALESCE(sc.sample_cost, 0) AS sample_cost,
           COALESCE(sc.shipping_cost, 0) AS sample_shipping,
           COALESCE(fee.fixed_fee_cny, 0) AS fixed_fee_cny,
           COALESCE(inc.commission_cny, 0) AS commission_cny
      FROM creator c
      LEFT JOIN sys_user u ON u.id = c.owner_id
      LEFT JOIN (${incomeSql('creator', opts.period)}) inc ON inc.key_id = c.id
      LEFT JOIN (SELECT s.creator_id AS creator_id, SUM(s.sample_cost) AS sample_cost,
                        SUM(s.shipping_cost) AS shipping_cost
                   FROM sample_shipment s WHERE s.is_deleted = 0 GROUP BY s.creator_id) sc ON sc.creator_id = c.id
      LEFT JOIN (SELECT l.creator_id AS creator_id, SUM(${COLLAB_FEE_CNY}) AS fixed_fee_cny
                   FROM collaboration l WHERE l.is_deleted = 0
                    ${periodWhere('l.created_at', opts.period, '')} GROUP BY l.creator_id) fee ON fee.creator_id = c.id
     WHERE c.is_deleted = 0 ${scope ? `AND ${scope}` : ''}
     ORDER BY gmv_cny DESC, c.id ASC
     LIMIT ${Math.min(500, Math.max(1, opts.limit ?? 100))}`;
  const rows = all<Record<string, unknown>>(sql, ...(opts.scopeParams ?? []));
  return rows.map((r) => finishRoi(r));
}

function finishRoi(r: Record<string, unknown>): RoiRow {
  const sample_cost = round2(num(r.sample_cost));
  const sample_shipping = round2(num(r.sample_shipping));
  const fixed_fee_cny = round2(num(r.fixed_fee_cny));
  const commission_cny = round2(num(r.commission_cny));
  const net_gmv_cny = round2(num(r.gmv_cny) - num(r.refund_cny));
  return {
    creator_id: Number(r.creator_id),
    handle: String(r.handle ?? ''),
    nickname: (r.nickname as string | null) ?? null,
    region: (r.region as string | null) ?? null,
    owner_id: r.owner_id === null || r.owner_id === undefined ? null : Number(r.owner_id),
    owner_name: (r.owner_name as string | null) ?? null,
    collabs: Number(r.collabs ?? 0),
    published_videos: Number(r.published_videos ?? 0),
    orders: Number(r.orders ?? 0),
    gmv_cny: round2(num(r.gmv_cny)),
    refund_cny: round2(num(r.refund_cny)),
    net_gmv_cny,
    sample_cost,
    sample_shipping,
    fixed_fee_cny,
    commission_cny,
    cost: round2(sample_cost + sample_shipping + fixed_fee_cny + commission_cny),
    roi: collabRoi({ net_gmv_cny, sample_cost, sample_shipping, fixed_fee_cny, commission_cny }),
  };
}

export interface CollabRoiRow extends RoiRow {
  collab_id: number;
  collab_no: string;
  status: number;
  coop_type: number;
}

/** 单张合作单的投产比：达人 ROI 的最小口径（方案表 11「达人 ROI 就按合作单算」） */
export function roiByCollab(collabId: number, period: PeriodRange = { from: '', to: '', days: 0 }): CollabRoiRow | null {
  const sql = `
    SELECT l.id AS collab_id, l.collab_no, l.status, l.coop_type, l.creator_id,
           c.handle, c.nickname, c.region, c.owner_id, u.real_name AS owner_name,
           (SELECT COUNT(*) FROM video v WHERE v.collab_id = l.id AND v.is_deleted = 0) AS collabs,
           (SELECT COUNT(*) FROM video v WHERE v.collab_id = l.id AND v.is_deleted = 0) AS published_videos,
           COALESCE(inc.orders, 0) AS orders,
           COALESCE(inc.gmv_cny, 0) AS gmv_cny,
           COALESCE(inc.refund_cny, 0) AS refund_cny,
           COALESCE(sc.sample_cost, 0) AS sample_cost,
           COALESCE(sc.shipping_cost, 0) AS sample_shipping,
           COALESCE(${COLLAB_FEE_CNY}, 0) AS fixed_fee_cny,
           COALESCE(inc.commission_cny, 0) AS commission_cny
      FROM collaboration l
      JOIN creator c ON c.id = l.creator_id
      LEFT JOIN sys_user u ON u.id = c.owner_id
      LEFT JOIN (${incomeSql('collab', period)}) inc ON inc.key_id = l.id
      LEFT JOIN (${SAMPLE_COST_BY_COLLAB}) sc ON sc.collab_id = l.id
     WHERE l.id = ? AND l.is_deleted = 0`;
  const row = all<Record<string, unknown>>(sql, collabId)[0];
  if (!row) return null;
  return { ...finishRoi(row), collab_id: Number(row.collab_id), collab_no: String(row.collab_no), status: Number(row.status), coop_type: Number(row.coop_type) };
}

export interface BdRow {
  user_id: number;
  real_name: string;
  dept: string | null;
  outreach_cnt: number;
  replied_cnt: number;
  agreed_cnt: number;
  reply_rate: number;
  collab_cnt: number;
  creator_cnt: number;
  net_gmv_cny: number;
  cost_cny: number;
  roi: number | null;
}

/**
 * BD 绩效（方案表 10「用来算 BD 工作量和回复率」+ 6.1 按 BD 出排行）：
 * 建联数 / 回复数 / 回复率 / 谈妥数 / 合作单数 / 带货净 GMV / 成本 / 投产比
 */
export function bdPerformance(opts: { period: PeriodRange; scopeSql?: string; scopeParams?: SqlParam[] }): BdRow[] {
  const p = opts.period;
  const sql = `
    SELECT u.id AS user_id, u.real_name, u.dept,
           (SELECT COUNT(*) FROM creator_outreach o WHERE o.user_id = u.id AND o.is_deleted = 0
             ${periodWhere('o.contact_time', p, 'AND')}) AS outreach_cnt,
           (SELECT COUNT(*) FROM creator_outreach o WHERE o.user_id = u.id AND o.is_deleted = 0 AND o.result >= 2
             ${periodWhere('o.contact_time', p, 'AND')}) AS replied_cnt,
           (SELECT COUNT(*) FROM creator_outreach o WHERE o.user_id = u.id AND o.is_deleted = 0 AND o.result = 6
             ${periodWhere('o.contact_time', p, 'AND')}) AS agreed_cnt,
           (SELECT COUNT(*) FROM collaboration l WHERE l.owner_id = u.id AND l.is_deleted = 0) AS collab_cnt,
           (SELECT COUNT(DISTINCT l.creator_id) FROM collaboration l WHERE l.owner_id = u.id AND l.is_deleted = 0) AS creator_cnt,
           COALESCE(inc.net_gmv_cny, 0) AS net_gmv_cny,
           COALESCE(sc.sample_cost, 0) + COALESCE(sc.shipping_cost, 0) + COALESCE(fee.fixed_fee_cny, 0)
             + COALESCE(inc.commission_cny, 0) AS cost_cny
      FROM sys_user u
      LEFT JOIN (SELECT c.owner_id AS owner_id, SUM(x.gmv_cny - x.refund_cny) AS net_gmv_cny,
                        SUM(x.commission_cny) AS commission_cny
                   FROM creator c JOIN (${incomeSql('creator', p)}) x ON x.key_id = c.id
                  WHERE c.is_deleted = 0 AND c.owner_id IS NOT NULL GROUP BY c.owner_id) inc ON inc.owner_id = u.id
      LEFT JOIN (SELECT c2.owner_id AS owner_id, SUM(s.sample_cost) AS sample_cost,
                        SUM(s.shipping_cost) AS shipping_cost
                   FROM sample_shipment s JOIN creator c2 ON c2.id = s.creator_id
                  WHERE s.is_deleted = 0 AND c2.is_deleted = 0 AND c2.owner_id IS NOT NULL GROUP BY c2.owner_id) sc ON sc.owner_id = u.id
      LEFT JOIN (SELECT c3.owner_id AS owner_id, SUM(${COLLAB_FEE_CNY}) AS fixed_fee_cny
                   FROM collaboration l JOIN creator c3 ON c3.id = l.creator_id
                  WHERE l.is_deleted = 0 AND c3.is_deleted = 0 AND c3.owner_id IS NOT NULL
                    ${periodWhere('l.created_at', p, 'AND')} GROUP BY c3.owner_id) fee ON fee.owner_id = u.id
     WHERE u.is_deleted = 0 AND u.status = 1
       AND (u.id IN (SELECT user_id FROM creator_outreach WHERE is_deleted = 0)
         OR u.id IN (SELECT owner_id FROM collaboration WHERE is_deleted = 0)
         OR u.id IN (SELECT owner_id FROM creator WHERE is_deleted = 0))
       ${opts.scopeSql ?? ''}
     ORDER BY net_gmv_cny DESC, outreach_cnt DESC, u.id ASC`;
  return all<Record<string, unknown>>(sql, ...(opts.scopeParams ?? [])).map((r) => {
    const outreach = Number(r.outreach_cnt ?? 0);
    const replied = Number(r.replied_cnt ?? 0);
    const cost_cny = round2(num(r.cost_cny));
    const net_gmv_cny = round2(num(r.net_gmv_cny));
    return {
      user_id: Number(r.user_id),
      real_name: String(r.real_name ?? ''),
      dept: (r.dept as string | null) ?? null,
      outreach_cnt: outreach,
      replied_cnt: replied,
      agreed_cnt: Number(r.agreed_cnt ?? 0),
      reply_rate: outreach > 0 ? round2((replied / outreach) * 100) : 0,
      collab_cnt: Number(r.collab_cnt ?? 0),
      creator_cnt: Number(r.creator_cnt ?? 0),
      net_gmv_cny,
      cost_cny,
      roi: collabRoi({ net_gmv_cny, sample_cost: 0, sample_shipping: 0, fixed_fee_cny: cost_cny, commission_cny: 0 }),
    };
  });
}

/** 达人漏斗：建联 → 谈妥 → 寄样 → 出内容 → 出单（方案 6.1 各步流水） */
export function funnelCounts(period: PeriodRange): {
  outreach: number;
  replied: number;
  agreed: number;
  creators_contacted: number;
  collabs: number;
  samples: number;
  contents: number;
  orders: number;
  net_gmv_cny: number;
} {
  const od = periodWhere('o.contact_time', period, 'AND');
  const ld = periodWhere('l.created_at', period, 'AND');
  const sd = periodWhere('s.created_at', period, 'AND');
  const row = get<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM creator_outreach o WHERE o.is_deleted = 0 ${od}) AS outreach,
       (SELECT COUNT(*) FROM creator_outreach o WHERE o.is_deleted = 0 AND o.result >= 2 ${od}) AS replied,
       (SELECT COUNT(*) FROM creator_outreach o WHERE o.is_deleted = 0 AND o.result = 6 ${od}) AS agreed,
       (SELECT COUNT(DISTINCT o.creator_id) FROM creator_outreach o WHERE o.is_deleted = 0 ${od}) AS creators_contacted,
       (SELECT COUNT(*) FROM collaboration l WHERE l.is_deleted = 0 ${ld}) AS collabs,
       (SELECT COUNT(*) FROM sample_shipment s WHERE s.is_deleted = 0 ${sd}) AS samples,
       (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 ${periodWhere('v.publish_time', period, 'AND')}) AS contents,
       (SELECT COUNT(DISTINCT o.id) FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
         WHERE i.is_deleted = 0 AND i.creator_id IS NOT NULL AND ${ATTRIBUTABLE_ORDER}
           ${period.from ? `AND substr(o.order_time, 1, 10) >= ${lit(period.from)}` : ''}
           ${period.to ? `AND substr(o.order_time, 1, 10) <= ${lit(period.to)}` : ''}) AS orders,
       (SELECT COALESCE(SUM(x.gmv_cny - x.refund_cny), 0) FROM (${incomeSql('creator', period)}) x) AS net_gmv_cny`,
  );
  return {
    outreach: Number(row?.outreach ?? 0),
    replied: Number(row?.replied ?? 0),
    agreed: Number(row?.agreed ?? 0),
    creators_contacted: Number(row?.creators_contacted ?? 0),
    collabs: Number(row?.collabs ?? 0),
    samples: Number(row?.samples ?? 0),
    contents: Number(row?.contents ?? 0),
    orders: Number(row?.orders ?? 0),
    net_gmv_cny: round2(num(row?.net_gmv_cny)),
  };
}
