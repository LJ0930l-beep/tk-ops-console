import { config } from '../config.js';
import { insert } from './db.js';
import { maskError } from './redact.js';

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

/* ==================== 读取侧：一条记录的字段级变更历史（选项 9） ==================== */

/** 单条日志 diff 出的一个变化字段；值统一转成文本，前端直接渲染「从 → 到」 */
export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

/**
 * 凭证列名黑名单：值永不回给前端（红线）。写入侧本就该剔除（见 shop.routes 的 CREDENTIAL_COLUMNS），
 * 这里挡的是「以后有人加了写接口忘了剔」—— 出口兜底不能只有一层。
 * 刻意不含裸 token/key：token_expire_at（令牌到期）与 role_key 都是要给人看的业务字段。
 */
const CREDENTIAL_FIELD_RE = /app_key|secret|access_token|refresh_token|\bsign\b|password|_enc$|cipher/i;

/** 内联在自由文本里的凭证（备注中粘贴 token 这类），整段过 redact 的脱敏口径 */
const INLINE_CREDENTIAL_RE = /(^|[^a-z])(app[_-]?secret|access[_-]?token|app[_-]?key|password|sign|token)\s*[=:]\s*\S/i;

/** 每次写入都自己变、对「这条记录为什么变成现在这样」毫无信息量的列 */
const NOISE_FIELDS = new Set(['updated_at']);

const MASKED_VALUE = '(已屏蔽)';

const asText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function displayValue(v: unknown): string {
  const text = asText(v);
  return INLINE_CREDENTIAL_RE.test(text) ? maskError(text) : text;
}

/** before/after 谁改了哪个字段：值没变的不列，凭证列只报「改过」不报值 */
function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): FieldChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const out: FieldChange[] = [];
  for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (NOISE_FIELDS.has(field)) continue;
    const from = asText(b[field]);
    const to = asText(a[field]);
    if (from === to) continue;
    out.push(
      CREDENTIAL_FIELD_RE.test(field)
        ? { field, from: MASKED_VALUE, to: MASKED_VALUE }
        : { field, from: displayValue(b[field]), to: displayValue(a[field]) },
    );
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

/** 落库的是 JSON 文本 {"before":{},"after":{}}；解析不出来就当没有字段变化，绝不把原文回给前端 */
export function changesOfLogEntry(beforeAfter: unknown): FieldChange[] {
  if (!beforeAfter) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(beforeAfter));
  } catch {
    return [];
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const pick = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  return diffFields(pick(obj.before), pick(obj.after));
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
