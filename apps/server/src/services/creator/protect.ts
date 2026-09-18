import { COLLAB_STATUS, POOL_STATUS, SAMPLE_STATUS } from '@tk/shared';
import { config } from '../../config.js';
import { all, get, run, scalar, update } from '../../core/db.js';
import { sendAlert, writeOpLog } from '../../core/oplog.js';

/**
 * 达人公海 / 私海 / 保护期与寄样超期规则（方案 5.3 表 9、表 12 + 设计要点 2 + 6.1 闭环）。
 * 两个 check* 函数供定时任务（jobs/scheduler.ts）直接调用。
 *
 * 时间口径：库内统一 UTC 文本，DATETIME='YYYY-MM-DD HH:MM:SS'、DATE='YYYY-MM-DD'，
 * 字符串比较即时间先后比较，不需要再做时区换算。
 */

/** 当前 UTC 的 DATETIME 文本 */
export const nowStr = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** 当前 UTC 日期 YYYY-MM-DD */
export const today = (): string => nowStr().slice(0, 10);

/** 相对某天偏移 N 天的日期文本 */
export function plusDays(n: number, from: Date = new Date()): string {
  return new Date(from.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** 日期/DATETIME 文本 → 毫秒时间戳，解析失败返回 0 */
export function tsOf(v: unknown): number {
  if (!v) return 0;
  const s = String(v).trim();
  const t = Date.parse(s.length > 10 && !s.includes('T') && !s.endsWith('Z') ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 保护期截止日：已有未来截止日的在其基础上续期（不浪费剩余天数），否则从今天起算。
 * 认领默认 config.protectDefaultDays 天。
 */
export function renewProtectUntil(current: unknown, days = config.protectDefaultDays): string {
  const cur = String(current ?? '');
  const base = /^\d{4}-\d{2}-\d{2}/.test(cur) && cur.slice(0, 10) > today() ? cur.slice(0, 10) : today();
  return plusDays(days, new Date(`${base}T00:00:00Z`));
}

/** 进行中的合作单（未完结 / 未取消 / 未超期未履约） */
const ONGOING_COLLAB = `status NOT IN (${COLLAB_STATUS.FINISHED}, ${COLLAB_STATUS.CANCELLED}, ${COLLAB_STATUS.OVERDUE})`;

export interface ReleaseResult {
  released: number;
  ids: number[];
  handles: string[];
}

/**
 * 保护期到期且期间无进展 → 自动退回公海（owner_id 置空、pool_status=1）。
 * 「无进展」= 保护期截止日之后没有新的 creator_outreach，且名下没有在途 collaboration。
 * @param creatorIds 限定处理范围（局部回收/单测），不传则全库扫描
 */
export function releaseExpiredCreators(creatorIds?: number[]): ReleaseResult {
  const list = (creatorIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const restrict = list.length ? `AND c.id IN (${list.map(() => '?').join(',')})` : '';
  const rows = all<{ id: number; handle: string; protect_until: string | null }>(
    `SELECT c.id, c.handle, c.protect_until
       FROM creator c
      WHERE c.is_deleted = 0
        AND c.pool_status IN (?, ?)
        AND c.owner_id IS NOT NULL
        AND c.protect_until IS NOT NULL
        AND c.protect_until < date('now')
        AND NOT EXISTS (SELECT 1 FROM creator_outreach o
                         WHERE o.creator_id = c.id AND o.is_deleted = 0
                           AND (o.created_at > c.protect_until OR o.contact_time > c.protect_until))
        AND NOT EXISTS (SELECT 1 FROM collaboration l
                         WHERE l.creator_id = c.id AND l.is_deleted = 0 AND ${ONGOING_COLLAB})
       ${restrict}
      ORDER BY c.protect_until ASC`,
    POOL_STATUS.PRIVATE,
    POOL_STATUS.COOPERATING,
    ...list,
  );
  for (const r of rows) {
    update('creator', r.id, { owner_id: null, pool_status: POOL_STATUS.PUBLIC, protect_until: null } as never);
    writeOpLog({
      user_id: 0,
      module: '达人中心',
      action: 'update',
      target_table: 'creator',
      target_id: r.id,
      before: { protect_until: r.protect_until },
      after: { owner_id: null, pool_status: POOL_STATUS.PUBLIC, reason: '保护期到期无进展，自动退回公海' },
    });
    sendAlert({ title: '达人保护期到期退回公海', detail: `@${r.handle}（保护期至 ${r.protect_until}）` });
  }
  return { released: rows.length, ids: rows.map((r) => r.id), handles: rows.map((r) => r.handle) };
}

export interface OverdueResult {
  overdue: number;
  ids: number[];
  due_days: number;
}

/**
 * 寄样超期未出内容（方案表 12 status=5）：sign_time + config.sampleContentDueDays 已过
 * 且没有关联视频 → 置为超期并推送告警，提醒 BD 催更。
 * @param sampleIds 限定处理范围（局部检查/单测），不传则全库扫描
 */
export function checkOverdueSamples(sampleIds?: number[]): OverdueResult {
  const days = config.sampleContentDueDays;
  const list = (sampleIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const restrict = list.length ? `AND s.id IN (${list.map(() => '?').join(',')})` : '';
  const rows = all<{ id: number; handle: string; sign_time: string; due_date: string }>(
    `SELECT s.id, c.handle, s.sign_time, date(s.sign_time, ?) AS due_date
       FROM sample_shipment s
       JOIN creator c ON c.id = s.creator_id
      WHERE s.is_deleted = 0
        AND c.is_deleted = 0
        AND s.status = ?
        AND s.sign_time IS NOT NULL
        AND date(s.sign_time, ?) < date('now')
        AND NOT EXISTS (SELECT 1 FROM video v
                         WHERE v.is_deleted = 0
                           AND ((s.collab_id IS NOT NULL AND v.collab_id = s.collab_id)
                             OR (s.collab_id IS NULL AND v.creator_id = s.creator_id)))
       ${restrict}
      ORDER BY s.sign_time ASC`,
    `+${days} day`,
    SAMPLE_STATUS.SIGNED,
    `+${days} day`,
    ...list,
  );
  for (const r of rows) {
    update('sample_shipment', r.id, { status: SAMPLE_STATUS.OVERDUE } as never);
    sendAlert({
      title: '寄样超期未出内容',
      detail: `@${r.handle} 寄样单 #${r.id} 应于 ${r.due_date} 前出内容（签收 ${r.sign_time}），请 BD 催更`,
    });
  }
  return { overdue: rows.length, ids: rows.map((r) => r.id), due_days: days };
}

/** 该合作单/达人是否已有关联视频 */
function hasContentFor(creatorId: number, collabId: number | null): boolean {
  return !!scalar(
    `SELECT COUNT(*) AS c FROM video
      WHERE is_deleted = 0 AND (collab_id = ? OR (collab_id IS NULL AND creator_id = ?))`,
    collabId ?? -1,
    creatorId,
  );
}

/** 合作单推进到「已发布」，并把对应寄样标记为「已出内容」（6.1 步骤 5） */
export function markCollabPublished(collabId: number): { collab_status: number; samples: number[] } {
  const collab = get<{ id: number; creator_id: number; status: number }>(
    `SELECT id, creator_id, status FROM collaboration WHERE id = ? AND is_deleted = 0`,
    collabId,
  );
  if (!collab) return { collab_status: 0, samples: [] };
  if (collab.status < COLLAB_STATUS.PUBLISHED) {
    update('collaboration', collab.id, { status: COLLAB_STATUS.PUBLISHED } as never);
  }
  const samples = all<{ id: number }>(
    `SELECT id FROM sample_shipment WHERE collab_id = ? AND is_deleted = 0 AND status IN (?, ?)`,
    collab.id,
    SAMPLE_STATUS.SIGNED,
    SAMPLE_STATUS.OVERDUE,
  );
  for (const s of samples) update('sample_shipment', s.id, { status: SAMPLE_STATUS.CONTENT_DONE } as never);
  run(
    `UPDATE creator SET pool_status = ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0 AND pool_status IN (?, ?)`,
    POOL_STATUS.COOPERATING,
    collab.creator_id,
    POOL_STATUS.PUBLIC,
    POOL_STATUS.PRIVATE,
  );
  return { collab_status: COLLAB_STATUS.PUBLISHED, samples: samples.map((s) => s.id) };
}

/**
 * 视频挂上合作单后的联动：合作单 → 已发布(5)、寄样 → 已出内容(4)。
 * 未挂合作单的达人视频按 creator_id 兜底推进寄样状态。
 */
export function linkVideoToCollab(videoId: number): { collab_id: number | null; samples: number[] } {
  const v = get<{ id: number; creator_id: number | null; collab_id: number | null }>(
    `SELECT id, creator_id, collab_id FROM video WHERE id = ? AND is_deleted = 0`,
    videoId,
  );
  if (!v) return { collab_id: null, samples: [] };
  if (v.collab_id) return { collab_id: v.collab_id, samples: markCollabPublished(v.collab_id).samples };
  if (v.creator_id && hasContentFor(v.creator_id, null)) {
    run(
      `UPDATE sample_shipment SET status = ?, updated_at = datetime('now')
        WHERE creator_id = ? AND is_deleted = 0 AND status IN (?, ?)`,
      SAMPLE_STATUS.CONTENT_DONE,
      v.creator_id,
      SAMPLE_STATUS.SIGNED,
      SAMPLE_STATUS.OVERDUE,
    );
  }
  return { collab_id: null, samples: [] };
}
