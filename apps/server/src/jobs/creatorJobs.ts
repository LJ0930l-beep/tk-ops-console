import { COLLAB_STATUS, round2 } from '@tk/shared';
import { all, get, run, scalar } from '../core/db.js';
import { sendAlert, writeOpLog } from '../core/oplog.js';
import { checkOverdueSamples, releaseExpiredCreators } from '../services/creator/protect.js';
import { AMOUNT_CNY, ATTRIBUTABLE_ORDER, RATE_JOIN, REFUND_CNY, REFUND_JOIN } from '../services/creator/roi.js';

/**
 * 达人 / 内容相关定时任务（方案 6.1 闭环收尾 + 6.3 直播提醒）。
 *
 * 这里全部导出「纯函数」：内部不开线程、不注册定时器，
 * 既能被 node-cron 调用，也能被 HTTP 接口（手动触发按钮 / 单测）直接调用。
 * scheduler.ts 属于基座文件不可改，集成方式见模块交付说明：
 *   import cron from 'node-cron';
 *   import { registerCreatorJobs } from './creatorJobs.js';
 *   registerCreatorJobs(cron);   // 放进 startScheduler() 里
 *
 * 时间口径：库内统一 UTC 文本，DATETIME='YYYY-MM-DD HH:MM:SS'、DATE='YYYY-MM-DD'。
 */

/** 退回公海：保护期已过且期间无跟进 / 无在途合作单 */
export function recycleExpiredCreators(): number {
  const r = releaseExpiredCreators();
  if (r.released) {
    sendAlert({ title: '达人保护期到期自动回收', detail: `本次退回公海 ${r.released} 位：${r.handles.slice(0, 20).join(' / ')}` });
  }
  return r.released;
}

/** 寄样签收超期未出内容 → 状态 5，并告警提醒 BD 催更 */
export function flagOverdueSamples(): number {
  const r = checkOverdueSamples();
  return r.overdue;
}

/**
 * 超期未履约的合作单判定条件（路由列清单与作业改状态共用同一口径）：
 * 约定截止日已过 + 已挂视频数 < 约定条数 + 尚未完结/取消。
 */
export const OVERDUE_COLLAB_WHERE = `l.is_deleted = 0
       AND l.deadline IS NOT NULL
       AND date(l.deadline) < date('now')
       AND l.status NOT IN (${COLLAB_STATUS.FINISHED}, ${COLLAB_STATUS.CANCELLED})
       AND (SELECT COUNT(*) FROM video v WHERE v.is_deleted = 0 AND v.collab_id = l.id) < l.promised_videos`;

/** 合作单超期未履约 → 状态 7（方案表 11「超期未履约」） */
export function flagOverdueCollabs(): number {
  const rows = all<{ id: number; collab_no: string; status: number; deadline: string; handle: string }>(
    `SELECT l.id, l.collab_no, l.status, l.deadline, c.handle
       FROM collaboration l JOIN creator c ON c.id = l.creator_id
      WHERE ${OVERDUE_COLLAB_WHERE}
        AND l.status IN (${COLLAB_STATUS.AGREED}, ${COLLAB_STATUS.TO_SHIP}, ${COLLAB_STATUS.IN_TRANSIT}, ${COLLAB_STATUS.TO_PUBLISH})
      ORDER BY l.deadline ASC`,
  );
  for (const r of rows) {
    run(`UPDATE collaboration SET status = ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, COLLAB_STATUS.OVERDUE, r.id);
    writeOpLog({
      user_id: 0,
      module: '达人中心',
      action: 'update',
      target_table: 'collaboration',
      target_id: r.id,
      before: { status: r.status },
      after: { status: COLLAB_STATUS.OVERDUE, reason: `约定截止日 ${r.deadline} 已过，视频数未达约定` },
    });
  }
  if (rows.length) {
    sendAlert({ title: '合作单超期未履约', detail: `${rows.length} 张合作单约定发布日已过且视频数未达标：${rows.slice(0, 10).map((r) => r.collab_no).join(' / ')}` });
  }
  return rows.length;
}

/**
 * 视频带货汇总刷新：按 tk_video_id 关联 tk_order_item.content_id，
 * 重算 orders（去重订单数）与 gmv（净 GMV 折人民币：排除样品单 / 已取消，扣已完成退款）。
 * @returns 实际发生变化的视频条数
 */
export function refreshVideoAggregates(): number {
  const agg = all<{ content_id: string; orders: number; gmv: number }>(
    `SELECT i.content_id AS content_id,
            COUNT(DISTINCT CASE WHEN i.item_amount > 0 THEN o.id END) AS orders,
            COALESCE(ROUND(SUM(${AMOUNT_CNY}) - SUM(${REFUND_CNY}), 2), 0) AS gmv
       FROM tk_order_item i
       JOIN tk_order o ON o.id = i.order_id
       ${RATE_JOIN}
       ${REFUND_JOIN}
      WHERE i.is_deleted = 0 AND i.content_id IS NOT NULL AND ${ATTRIBUTABLE_ORDER}
      GROUP BY i.content_id`,
  );
  const map = new Map(agg.map((a) => [String(a.content_id), a]));
  const videos = all<{ id: number; tk_video_id: string | null; orders: number; gmv: number }>(
    `SELECT id, tk_video_id, orders, gmv FROM video WHERE is_deleted = 0 AND tk_video_id IS NOT NULL`,
  );
  let changed = 0;
  for (const v of videos) {
    const hit = map.get(String(v.tk_video_id));
    const orders = Number(hit?.orders ?? 0);
    const gmv = round2(Number(hit?.gmv ?? 0));
    if (orders === Number(v.orders) && gmv === Number(v.gmv)) continue;
    run(`UPDATE video SET orders = ?, gmv = ?, updated_at = datetime('now') WHERE id = ?`, orders, gmv, v.id);
    changed += 1;
  }
  return changed;
}

/** 开播前一天提醒（方案 6.3 步骤 2） */
export function remindUpcomingLives(days = 1): number {
  const rows = all<{ id: number; plan_start: string | null; shop_name: string; host_name: string | null }>(
    `SELECT l.id, l.plan_start, s.shop_name, u.real_name AS host_name
       FROM live_session l
       JOIN tk_shop s ON s.id = l.shop_id
       LEFT JOIN sys_user u ON u.id = l.host_id
      WHERE l.is_deleted = 0 AND l.status = 1
        AND date(l.plan_start) BETWEEN date('now') AND date('now', ?)`,
    `+${Math.max(0, days)} day`,
  );
  for (const r of rows) {
    sendAlert({ title: '开播提醒', detail: `${r.shop_name} ${String(r.plan_start).slice(0, 16)} 开播，主播：${r.host_name ?? '未指定'}（场次 #${r.id}）` });
  }
  return rows.length;
}

/** 单次全量巡检：保护期回收 → 寄样超期 → 合作单超期 → 视频汇总 → 开播提醒 */
export function runCreatorMaintenance(): Record<string, number> {
  const result = {
    recycled_creators: recycleExpiredCreators(),
    overdue_samples: flagOverdueSamples(),
    overdue_collabs: flagOverdueCollabs(),
    refreshed_videos: refreshVideoAggregates(),
    live_reminders: remindUpcomingLives(1),
  };
  return result;
}

/** node-cron 的最小结构（不直接 import node-cron，方便测试注入假实现） */
export interface CronLike {
  schedule(expression: string, func: () => unknown, options?: unknown): unknown;
}

/**
 * 注册达人 / 内容相关作业（UTC 触发，避开订单同步高峰）。
 * 不改 scheduler.ts：由集成方在其 startScheduler() 内调用 registerCreatorJobs(cron)。
 */
export function registerCreatorJobs(cron: CronLike): { name: string; expression: string }[] {
  const jobs: { name: string; expression: string; fn: () => unknown }[] = [
    { name: 'creator-protect-recycle', expression: '10 2 * * *', fn: recycleExpiredCreators },
    { name: 'sample-overdue-flag', expression: '25 2 * * *', fn: flagOverdueSamples },
    { name: 'collab-overdue-flag', expression: '40 2 * * *', fn: flagOverdueCollabs },
    { name: 'video-aggregate-refresh', expression: '55 2 * * *', fn: refreshVideoAggregates },
    { name: 'live-start-reminder', expression: '0 1 * * *', fn: () => remindUpcomingLives(1) },
  ];
  for (const j of jobs) {
    cron.schedule(j.expression, () => {
      try {
        const n = j.fn();
        if (Number(n) > 0) console.log(`[jobs] ${j.name} 处理 ${n} 条`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[jobs] ${j.name} 执行失败:`, msg);
        sendAlert({ title: `定时任务失败：${j.name}`, detail: msg, level: 'error' });
      }
    }, { timezone: 'UTC' });
  }
  return jobs.map(({ name, expression }) => ({ name, expression }));
}

/** 供单测确认任务表可读（也便于排查「谁在什么时候跑过什么」） */
export function lastMaintenanceSummary(): string {
  const collabs = scalar(`SELECT COUNT(*) FROM collaboration WHERE is_deleted = 0 AND status = ?`, COLLAB_STATUS.OVERDUE);
  const samples = scalar(`SELECT COUNT(*) FROM sample_shipment WHERE is_deleted = 0 AND status = ?`, 5);
  const videos = get<{ c: number }>(`SELECT COUNT(*) AS c FROM video WHERE is_deleted = 0 AND orders > 0`)?.c ?? 0;
  return `超期合作单 ${collabs} / 超期寄样 ${samples} / 已出单视频 ${videos}`;
}
