/**
 * 派生汇总回写（方案 6.4「汇总作业」+ 表 2 / 表 6 / 表 15 的系统汇总列）
 *
 * 四条口径：
 *  1. SQLite 没有 UPDATE ... FROM，所有回写一律用相关子查询
 *     （UPDATE video SET gmv = (SELECT ... WHERE i.content_id = video.tk_video_id) WHERE ...），
 *     一条语句跑完全表，不在 JS 里逐行拼 SQL。
 *  2. 只回写「系统汇总列」（video.orders/gmv、creator.gmv_level、shop_listing.last_sync_at），
 *     人工录入列一律不碰。
 *  3. 达人带货 GMV 复用利润引擎（同一折算、切日与「未配返点率整行剔除」口径）；video.gmv 落库为人民币
 *     —— 内容中心把 SUM(v.gmv) 直接当 gmv_cny 用，两边必须同一口径。
 *  4. 返回值是「真正发生变化的行数」（幂等：连跑两次第二次为 0），并各写一条
 *     sync_log(task_type='aggregate') 供同步页排查。
 */
import { get, insert, run, update } from '../core/db.js';
import { rateToCnyExpr, toCnySql, todayUtc } from './rates.js';
import { computeProfitByDimension } from './profit.js';

export type AggregateTask = 'video' | 'creator' | 'listing';

export interface AggregateOutcome {
  task: AggregateTask;
  /** 发生回写（值确有变化）的行数 */
  affected: number;
  /** 参与计算的行数 */
  scanned: number;
  window: { start: string; end: string };
  sync_log_id: number;
}

const addDays = (day: string, n: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + n * 86400_000).toISOString().slice(0, 10) : day;
};

const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

const countOf = (sql: string, ...p: (number | string)[]): number => Number(get<{ c: number | string }>(sql, ...p)?.c ?? 0);

/** 单个汇总动作包一条 sync_log：开始即落库，结束回写行数与状态，失败也留痕 */
function withAggregateLog(
  task: AggregateTask,
  window: { start: string; end: string },
  fn: () => { affected: number; scanned: number },
  userId: number | null,
): AggregateOutcome {
  const logId = insert('sync_log', {
    task_type: 'aggregate',
    shop_id: null,
    window_start: window.start,
    window_end: window.end,
    started_at: stamp(),
    created_by: userId,
  });
  let res: { affected: number; scanned: number };
  let error: string | null = null;
  try {
    res = fn();
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
    res = { affected: 0, scanned: 0 };
  }
  update('sync_log', logId, {
    fetched: res.scanned,
    updated: res.affected,
    failed: error ? 1 : 0,
    status: error ? 3 : 1,
    error_msg: error,
    finished_at: stamp(),
  } as never);
  if (error) throw new Error(`汇总作业 ${task} 失败：${error}`);
  return { task, affected: res.affected, scanned: res.scanned, window, sync_log_id: logId };
}

/* ==================== 表 15 video：带货订单数与 GMV ==================== */

/** 视频带货归因：tk_order_item.content_id = video.tk_video_id；样品单/取消单/未配返点率的行不计 */
const VIDEO_ITEM_FROM = `FROM tk_order_item i
         JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
         JOIN tk_shop s ON s.id = o.shop_id
        WHERE i.is_deleted = 0 AND i.rebate_matched = 1
          AND o.order_status <> 'CANCELLED' AND o.is_sample_order = 0`;
// rebate_matched=0 = 这一行没映射到内部 SKU，也就没有品牌给的返点率。
// 它必须被**排除**而不是按 0 计入：0 的语义是「品牌确实一分钱返点都不给我们」，
// 排除的语义才是「这一行还没配」——混成一个数，带货榜与后面的投流/寄样建议就分不清是数据缺还是生意差
// （和当年 COALESCE(rate,1) 把缺汇率当 1:1 是同一类缺陷：不许给缺失值发明一个默认数）。

/** 明细实收折人民币：按订单日取价，取不到用 SQL 侧兜底牌价（与利润引擎同一套常量） */
// 汇率必须走 rateToCnyExpr：裸 rateSqlExpr 缺价时返回 NULL，SUM(金额 * NULL) 会把这一行静默吞掉
const VIDEO_AMOUNT_CNY = toCnySql('i.item_amount', 'o.currency', 'substr(o.order_time, 1, 10)');

const VIDEO_ORDERS_SUB = `(SELECT COUNT(DISTINCT i.order_id) ${VIDEO_ITEM_FROM} AND i.content_id = video.tk_video_id)`;
const VIDEO_GROSS_SUB = `(SELECT IFNULL(ROUND(SUM(${VIDEO_AMOUNT_CNY}), 2), 0) ${VIDEO_ITEM_FROM} AND i.content_id = video.tk_video_id)`;
/** 已完成退款按行级关联归到原视频冲减；没有行级关联的退款不摊（避免同一笔重复扣） */
const VIDEO_REFUND_SUB = `(SELECT IFNULL(ROUND(SUM(r.refund_amount * ${rateToCnyExpr('r.currency', 'substr(r.apply_time, 1, 10)')}), 2), 0)
         FROM tk_return r
         JOIN tk_order_item i ON i.id = r.tk_order_item_id
         JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
         JOIN tk_shop s ON s.id = o.shop_id
        WHERE r.is_deleted = 0 AND r.status = 'COMPLETED' AND i.content_id = video.tk_video_id)`;
const VIDEO_GMV_SUB = `(IFNULL(${VIDEO_GROSS_SUB}, 0) - IFNULL(${VIDEO_REFUND_SUB}, 0))`;

/** 重算 video.orders / video.gmv（人民币净 GMV） */
export function refreshVideoAggregates(userId: number | null = null): AggregateOutcome {
  const window = { start: addDays(todayUtc(), -365), end: todayUtc() };
  return withAggregateLog(
    'video',
    window,
    () => {
      const scope = `video.is_deleted = 0 AND video.tk_video_id IS NOT NULL`;
      const stale = countOf(
        `SELECT COUNT(*) AS c FROM video WHERE ${scope}
            AND (IFNULL(video.orders, 0) <> ${VIDEO_ORDERS_SUB} OR ABS(IFNULL(video.gmv, 0) - ${VIDEO_GMV_SUB}) > 0.01)`
      );
      const scanned = countOf(`SELECT COUNT(*) AS c FROM video WHERE video.is_deleted = 0 AND video.tk_video_id IS NOT NULL`);
      run(
        `UPDATE video SET
            orders = ${VIDEO_ORDERS_SUB},
            gmv = ${VIDEO_GMV_SUB},
            updated_at = datetime('now')
          WHERE ${scope}`
      );
      return { affected: stale, scanned };
    },
    userId,
  );
}

/* ==================== 表 6 creator：近 30 天带货等级 ==================== */

/** 带货等级区间（人民币净 GMV，近 30 个报表自然日），档位与 sys_dict 的 gmv_level 对齐 */
export const GMV_LEVEL_BANDS: { level: string; min: number }[] = [
  { level: 'A', min: 20000 },
  { level: 'B', min: 3000 },
  { level: 'C', min: 0 },
];

/** GMV（人民币）→ 等级；区间判定只写这一处，页面与作业同一结果 */
export function gmvLevelOf(netGmvCny: number): string {
  const v = Number(netGmvCny || 0);
  return GMV_LEVEL_BANDS.find((b) => v >= b.min)?.level ?? 'C';
}

/**
 * 近 30 天带货净 GMV 回写 creator.gmv_level。
 * 带货额直接复用利润引擎（未配返点率的行与样品单已经剔除）；区间内没有带货的达人不写回，
 * 保留人工评级，避免新签达人被无脑降级成 C。
 * 档位口径**不改成返点额**：gmv_level 描述的是「这个达人能带多大的品牌生意」（对外谈判用的量级），
 * 我们赚多少是另一件事 —— 返点/寄样运费在 analytics_creator_daily 里，由 analytics.rebuildCreatorDaily
 * 按日回写（本页不重复写这张宽表，两处写就会有两处口径）。
 */
export function refreshCreatorAggregates(
  userId: number | null = null,
  range: { start?: string; end?: string } = {},
): AggregateOutcome {
  const end = range.end ?? todayUtc();
  const start = range.start ?? addDays(end, -29);
  return withAggregateLog(
    'creator',
    { start, end },
    () => {
      const rows = computeProfitByDimension({ dim: 'creator', start, end });
      let affected = 0;
      for (const r of rows) {
        const id = Number(/^C(\d+)$/.exec(r.dim_key)?.[1] ?? 0);
        if (!id) continue;
        const level = gmvLevelOf(r.net_gmv);
        const cur = get<{ gmv_level: string | null }>(`SELECT gmv_level FROM creator WHERE id = ? AND is_deleted = 0`, id);
        if (!cur || (cur.gmv_level ?? '') === level) continue;
        affected += update('creator', id, { gmv_level: level } as never);
      }
      return { affected, scanned: rows.filter((r) => /^C\d+$/.test(r.dim_key)).length };
    },
    userId,
  );
}

/* ==================== 表 2 shop_listing：同步时间 ==================== */

/**
 * 补齐 shop_listing.last_sync_at（只补空值，已有时间不覆盖 —— 真实同步时刻以同步作业写入的为准）：
 * 先取该店铺最近一次成功的 listing 同步结束时间，没有同步日志的退到该 SKU 最近一条订单时间。
 */
export function refreshListingSyncTime(userId: number | null = null): AggregateOutcome {
  const window = { start: addDays(todayUtc(), -1), end: todayUtc() };
  return withAggregateLog(
    'listing',
    window,
    () => {
      const scanned = countOf(`SELECT COUNT(*) AS c FROM shop_listing WHERE is_deleted = 0`);
      const itemOrderTime = `(SELECT MAX(o.order_time) FROM tk_order_item i
                 JOIN tk_order o ON o.id = i.order_id AND o.is_deleted = 0
                WHERE i.is_deleted = 0 AND i.listing_id = shop_listing.id)`;
      const bySyncLog = run(
        `UPDATE shop_listing SET
            last_sync_at = (SELECT sl.finished_at FROM sync_log sl
                             WHERE sl.is_deleted = 0 AND sl.shop_id = shop_listing.shop_id
                               AND sl.task_type = 'listing' AND sl.status = 1
                             ORDER BY sl.id DESC LIMIT 1),
            updated_at = datetime('now')
          WHERE is_deleted = 0 AND last_sync_at IS NULL
            AND EXISTS (SELECT 1 FROM sync_log sl
                         WHERE sl.is_deleted = 0 AND sl.shop_id = shop_listing.shop_id
                           AND sl.task_type = 'listing' AND sl.status = 1)`
      ).changes;
      const byOrder = run(
        `UPDATE shop_listing SET last_sync_at = ${itemOrderTime}, updated_at = datetime('now')
          WHERE is_deleted = 0 AND last_sync_at IS NULL AND ${itemOrderTime} IS NOT NULL`
      ).changes;
      return { affected: bySyncLog + byOrder, scanned };
    },
    userId,
  );
}

/* ==================== 一次跑完（财务/投放页的「刷新」按钮与调度器共用） ==================== */

export interface AggregateSummary {
  results: AggregateOutcome[];
  affected: number;
  scanned: number;
  errors: { task: AggregateTask; message: string }[];
  started_at: string;
  finished_at: string;
}

/** 三个汇总动作一次跑完；单个动作失败不影响其余（失败已经进自己的 sync_log） */
export function runAggregates(user: { id?: number } | null = null, range: { start?: string; end?: string } = {}): AggregateSummary {
  const userId = user?.id ?? null;
  const startedAt = new Date().toISOString();
  const results: AggregateOutcome[] = [];
  const errors: { task: AggregateTask; message: string }[] = [];
  const tasks: { name: AggregateTask; run: () => AggregateOutcome }[] = [
    { name: 'video', run: () => refreshVideoAggregates(userId) },
    { name: 'creator', run: () => refreshCreatorAggregates(userId, range) },
    { name: 'listing', run: () => refreshListingSyncTime(userId) },
  ];
  for (const t of tasks) {
    try {
      results.push(t.run());
    } catch (e) {
      errors.push({ task: t.name, message: (e as Error).message });
    }
  }
  return {
    results,
    affected: results.reduce((a, r) => a + r.affected, 0),
    scanned: results.reduce((a, r) => a + r.scanned, 0),
    errors,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}
