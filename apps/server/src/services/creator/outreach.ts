/**
 * 建联跟进写入（表 10 creator_outreach）。
 *
 * 这段逻辑原来只在 creator.routes 的 POST /creators/outreach 里内联。抽出来的理由是
 * 「AI 助手」的写工具必须走**同一条**写入路径：同样的黑名单/他人私海判定、
 * 同样的公海转私海 + 保护期续期、同样的两条 op_log。
 * 复制一份到 AI 侧就会分叉 —— 而分叉的通常是"少校验了一个条件"的那一侧。
 */
import { z } from 'zod';
import { DATA_SCOPE, OUTREACH_RESULT, POOL_STATUS, type CurrentUser } from '@tk/shared';
import { get, insert, update, tx } from '../../core/db.js';
import { forbidden, notFound } from '../../core/http.js';
import { writeOpLog } from '../../core/oplog.js';
import { nowStr, renewProtectUntil } from './protect.js';

/** 10 秒一条：除达人 + 结果外全部可空（schema 放这里，route 与 AI 工具共用同一份校验） */
export const outreachBody = z.object({
  creator_id: z.number().int().positive(),
  result: z.number().int().min(1).max(6).default(OUTREACH_RESULT.NO_REPLY),
  channel: z.number().int().min(1).max(4).default(1),
  contact_time: z.string().max(20).nullish(),
  summary: z.string().max(500).nullish(),
  next_follow_at: z.string().max(20).nullish(),
});
export type OutreachInput = z.input<typeof outreachBody>;

export const isManager = (user: CurrentUser): boolean =>
  user.data_scope === DATA_SCOPE.ALL || user.data_scope === DATA_SCOPE.DEPT || user.role_key === 'boss';

/** 达人是否在我的可管理范围内（本人 / 本组 / 全量） */
export function inManageScope(user: CurrentUser, creator: Record<string, unknown>): boolean {
  const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
  if (ownerId === null || ownerId === user.id) return true;
  if (user.data_scope === DATA_SCOPE.ALL) return true;
  if (user.data_scope === DATA_SCOPE.DEPT) {
    return !!get(`SELECT 1 FROM sys_user WHERE id = ? AND dept = (SELECT dept FROM sys_user WHERE id = ?) AND dept IS NOT NULL`, ownerId, user.id);
  }
  return false;
}

export interface OutreachResult {
  id: number;
  creator: Record<string, unknown> | undefined;
  hint: string | null;
}

/**
 * 新增一条跟进：自动 user_id = 调用者、contact_time = now；
 * 随后为达人续期保护期（+7 天），公海达人自动转入跟进人私海（视为已建联）。
 * `ip` 只用于 op_log；AI 发起时传的是"点对话那个人的请求 IP"，不是模型的。
 */
export function recordOutreach(user: CurrentUser, body: OutreachInput, ip?: string): OutreachResult {
  const creator = get<Record<string, unknown>>(`SELECT * FROM creator WHERE id = ? AND is_deleted = 0`, body.creator_id);
  if (!creator) throw notFound('达人不存在');
  if (Number(creator.pool_status) === POOL_STATUS.BLACKLIST) throw forbidden('黑名单达人不能新建跟进');
  const ownerId = creator.owner_id === null || creator.owner_id === undefined ? null : Number(creator.owner_id);
  if (ownerId !== null && ownerId !== user.id && !inManageScope(user, creator)) {
    throw forbidden(`该达人已在 @${String(creator.handle)} 的他人私海，请先联系主管转交`);
  }

  const id = tx(() => {
    const newId = insert('creator_outreach', {
      creator_id: body.creator_id,
      user_id: user.id,
      channel: body.channel ?? 1,
      contact_time: body.contact_time || nowStr(),
      summary: body.summary ?? null,
      result: body.result ?? OUTREACH_RESULT.NO_REPLY,
      next_follow_at: body.next_follow_at ?? null,
      created_by: user.id,
    });
    const before = { owner_id: ownerId, pool_status: creator.pool_status, protect_until: creator.protect_until };
    const patch = {
      owner_id: ownerId === null ? user.id : ownerId,
      pool_status: Number(creator.pool_status) === POOL_STATUS.PUBLIC ? POOL_STATUS.PRIVATE : Number(creator.pool_status),
      protect_until: renewProtectUntil(creator.protect_until, 7),
    };
    update('creator', body.creator_id, patch);
    writeOpLog({ user_id: user.id, module: '达人中心', action: 'create', target_table: 'creator_outreach', target_id: newId, after: body, ip });
    if (before.owner_id !== patch.owner_id || String(before.protect_until) !== String(patch.protect_until) || before.pool_status !== patch.pool_status) {
      writeOpLog({
        user_id: user.id,
        module: '达人中心',
        action: 'update',
        target_table: 'creator',
        target_id: body.creator_id,
        before,
        after: { ...patch, reason: '建联跟进自动续期 / 公海转私海' },
        ip,
      });
    }
    return newId;
  });

  return {
    id,
    creator: get<Record<string, unknown>>(`SELECT owner_id, pool_status, protect_until FROM creator WHERE id = ?`, body.creator_id),
    hint: Number(body.result) === OUTREACH_RESULT.AGREED ? '结果=谈妥，请尽快创建合作单（POST /creators/collab）' : null,
  };
}
