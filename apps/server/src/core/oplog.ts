import { config } from '../config.js';
import { insert } from './db.js';

export interface OpLogInput {
  user_id: number;
  module: string;
  action: 'create' | 'update' | 'delete' | 'export' | 'login';
  target_table?: string;
  target_id?: number | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** 操作日志：谁在什么时候改了什么；任何人不可修改（表无更新入口） */
export function writeOpLog(e: OpLogInput): void {
  insert(
    'sys_op_log',
    {
      user_id: e.user_id,
      module: e.module,
      action: e.action,
      target_table: e.target_table ?? null,
      target_id: e.target_id ?? null,
      before_after: JSON.stringify({ before: e.before ?? null, after: e.after ?? null }),
      ip: e.ip ?? null,
      created_by: e.user_id,
    },
  );
}

export function logIfChanged(e: OpLogInput & { before: Record<string, unknown>; after: Record<string, unknown>; keys: string[] }): void {
  const picked = (o: Record<string, unknown>) => Object.fromEntries(e.keys.map((k) => [k, o[k]]));
  const changed = e.keys.some((k) => String(e.before[k] ?? '') !== String(e.after[k] ?? ''));
  if (changed) writeOpLog({ ...e, before: picked(e.before), after: picked(e.after) });
}

/**
 * 同步/授权告警（方案 6.4）。无 webhook 时降级为服务端日志，
 * 保证本地开发不依赖企业微信 / 飞书也能跑通。
 */
export function sendAlert(payload: { title: string; detail: string; level?: 'warn' | 'error' }): void {
  const line = `[ALERT:${payload.level ?? 'warn'}] ${payload.title} — ${payload.detail}`;
  if (config.alertWebhook) {
    void fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: line } }),
    }).catch(() => undefined);
  }
  console.warn(line);
}
