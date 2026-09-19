import { z, type ZodTypeAny } from 'zod';
import { REGION_TZ_OFFSET, statDateInZone, zoneOffsetMinutes, type CurrentUser, type MenuKey } from '@tk/shared';
import { formatUtc, parseUtc } from '../services/tiktok/types.js';
import { canAccessShop } from './auth.js';
import { badRequest } from './http.js';
import { insert, tx } from './db.js';
import { writeOpLog } from './oplog.js';

/**
 * 通用表格导入内核（方案第七章「接口覆盖不到用表格兜底」+ EPIC-1-02 导入半边）。
 *
 * 三条硬约束：
 *  1. 幂等：每表一个业务唯一键，重复导入同一文件只更新不新增（禁止先删后插）；
 *  2. 逐行独立：脏行进 errors 不影响其余行，整体记「部分失败」，绝不整批回滚；
 *  3. 留痕：一次导入一条 sync_log(task_type='import') + 一条 sys_op_log，
 *     来源标 web/manual，事后能和接口同步分开对账。
 */

/* ==================== 表头与取值归一 ==================== */

/** 表头指纹：忽略大小写、空格、下划线、连字符、冒号、括号、点与百分号，中英两种写法都能对上 */
const headKey = (s: unknown): string =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-():：.．%％()／]/g, '');

/** 千分位与货币符号先清掉；解析不出来就报脏行，不能默认 0（0 是合法业务值） */
const numOf = (v: unknown): number => Number(String(v ?? '').replace(/[,¥$￥\s]/g, ''));

/** 卖家中心/罗面表格里的数字常带千分位与货币符号，先清一遍再进类型 */
const NUM_HINT = '无法解析为数字：单元格里可能是 — / - / 「1.2万」这类文本，请填纯数字';
const numCell = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = numOf(v);
  if (!Number.isFinite(n)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: NUM_HINT });
  return n;
});
export const zNum = numCell;
export const zInt = numCell.transform((n) => Math.round(n));
export const zText = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
export const zDay = zText.pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}/, '日期需为 YYYY-MM-DD')).transform((v) => v.slice(0, 10));
export const zYesNo = z.union([z.string(), z.number(), z.boolean()]).transform((v) => {
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === '是' || s === '已回仓' ? 1 : 0;
});

/**
 * 把「按某时区读到的墙上时间」换算成 UTC 文本（系统内时间统一存 UTC）。
 * 换算一次后可能落到夏令时切换的另一侧，故用结果再取一次偏移。
 */
export function localTextToUtc(text: string, atMs: number, tz: string, region: string): string {
  const d = parseUtc(text);
  if (!d) return text;
  const fallback = REGION_TZ_OFFSET[region] ?? 0;
  const first = d.getTime() - (zoneOffsetMinutes(tz, atMs) ?? fallback) * 60_000;
  const off = zoneOffsetMinutes(tz, first) ?? fallback;
  return formatUtc(new Date(d.getTime() - off * 60_000));
}

export interface ImportColumn {
  key: string;
  label: string;
  aliases?: string[];
  required?: boolean;
  sample?: string;
  hint?: string;
}

export interface ImportCtx {
  user: CurrentUser;
  /** manual = 人工表格/粘贴；web = 浏览器侧抓取后回传 */
  source: 'manual' | 'web';
  userId: number;
  ip?: string;
}

/** 店铺行的定位结果：本地店铺 ID + 该店时区（时间列换算要用） */
export interface ShopRef {
  shop_id: number;
  timezone: string;
  region: string;
}

export interface ImportSpec {
  table: string;
  label: string;
  menu: MenuKey;
  columns: ImportColumn[];
  shape: ZodTypeAny;
  /**
   * 行内店铺定位。
   * `undefined` = 这一行没提店铺（可选列，跳过范围校验）；
   * `null` = 提了但找不到（按脏行拒绝）；ShopRef = 命中。
   */
  shopOf?: (row: Record<string, unknown>) => ShopRef | null | undefined;
  /** 需要按店铺时区换算成 UTC 的时间列（卖家中心导出的都是店铺当地墙上时间） */
  timeCols?: string[];
  /** 单行落库：同键存在即更新，返回 'inserted' | 'updated' */
  upsert: (row: Record<string, unknown>, ctx: ImportCtx) => 'inserted' | 'updated';
}

export interface ImportError {
  row: number;
  reason: string;
}

export interface ImportOutcome {
  total: number;
  accepted: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: ImportError[];
  log_id: number;
  status: number;
}

/** 表头 → 字段：英文字段名、中文标签、别名三种写法混用都行；空单元格一律忽略（不覆盖已有值） */
export function mapRow(raw: Record<string, unknown>, columns: ImportColumn[]): Record<string, unknown> {
  const index = new Map<string, string>();
  for (const c of columns) {
    index.set(headKey(c.key), c.key);
    index.set(headKey(c.label), c.key);
    for (const a of c.aliases ?? []) index.set(headKey(a), c.key);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = index.get(headKey(k));
    if (!key || v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v.trim() : v;
    if (s === '') continue;
    out[key] = s;
  }
  return out;
}

interface ZodIssue {
  path: (string | number)[];
  message: string;
  code?: string;
  received?: unknown;
  unionErrors?: { issues: ZodIssue[] }[];
}

/** 列没给值时 zod 会报 invalid_union（union 分支各自报 undefined），递归下来判定「其实是缺列」 */
const isMissing = (i: ZodIssue): boolean =>
  (i.code === 'invalid_type' && i.received === 'undefined') ||
  (i.code === 'invalid_union' && (i.unionErrors ?? []).every((e) => e.issues.length > 0 && e.issues.every(isMissing)));

/** 把 zod 报错翻成运营看得懂的话，别把 "Invalid input" 这类框架术语丢给人工 */
function issueText(err: unknown, columns: ImportColumn[]): string {
  const labelOf = (key: string) => columns.find((c) => c.key === key)?.label ?? key;
  const issues = (err as { issues?: ZodIssue[] }).issues ?? [];
  return (
    issues
      .map((i) => {
        const field = labelOf(String(i.path.at(-1) ?? ''));
        if (isMissing(i)) return `${field}：必填，表格里没给这一列`;
        return `${field ? `${field}：` : ''}${i.message}`;
      })
      .join('; ') || '行格式错误'
  );
}

/** sqlite 的约束报错既难读又暴露表结构，一律翻成「哪儿不行 + 怎么办」 */
const DB_TEXT = /constraint failed|SQLITE_|no such (table|column)|has no column named/i;
const DB_HINTS: [RegExp, string][] = [
  [/UNIQUE constraint failed/i, '系统里已有同键记录（可能躺在回收站里），请恢复原记录或改走更新'],
  [/FOREIGN KEY constraint failed/i, '关联的主数据不存在，请先补齐对应档案'],
  [/NOT NULL constraint failed/i, '必填字段没值'],
  [/CHECK constraint failed/i, '取值不在允许范围内'],
  [/has no column named|no such column/i, '字段与系统表结构不匹配'],
];

function rowReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!DB_TEXT.test(msg)) return msg;
  const col = /constraint failed: [\w."]+\.([\w."]+)/i.exec(msg)?.[1]?.replace(/"/g, '');
  const hint = DB_HINTS.find(([re]) => re.test(msg))?.[1] ?? '数据无法落库';
  return `${col ? `${col}：` : ''}${hint}`;
}

/* ==================== 执行 ==================== */

export const IMPORT_ROW_LIMIT = 5000;

/** 一次导入：校验 → 范围把关 → 时间换算 → 逐行事务落库 → 日志留痕 */
export function runImport(spec: ImportSpec, rawRows: Record<string, unknown>[], ctx: ImportCtx): ImportOutcome {
  if (!rawRows.length) throw badRequest('没有可导入的行');
  if (rawRows.length > IMPORT_ROW_LIMIT) throw badRequest(`单次导入上限 ${IMPORT_ROW_LIMIT} 行，请拆分文件`);

  const errors: ImportError[] = [];
  const accepted: { row: number; data: Record<string, unknown> }[] = [];

  rawRows.forEach((raw, i) => {
    const row = i + 1;
    const parsed = spec.shape.safeParse(mapRow(raw, spec.columns)) as {
      success: boolean;
      data?: Record<string, unknown>;
      error?: unknown;
    };
    if (!parsed.success || !parsed.data) return void errors.push({ row, reason: issueText(parsed.error, spec.columns) });
    const data = parsed.data;
    if (spec.shopOf) {
      const ref = spec.shopOf(data);
      if (ref === null) return void errors.push({ row, reason: '店铺无法定位：请给 shop_id / 平台店铺 ID / 店铺名称其一' });
      if (ref) {
        if (!canAccessShop(ctx.user, ref.shop_id)) return void errors.push({ row, reason: `店铺 ${ref.shop_id} 不在你的数据范围内` });
        data.__shop = ref;
      }
    }
    accepted.push({ row, data });
  });

  let inserted = 0;
  let updated = 0;
  for (const { row, data } of accepted) {
    const ref = data.__shop as ShopRef | undefined;
    if (ref && spec.timeCols) {
      // 时间列以店铺墙上时间为准换算 UTC；换算不了的（空/乱值）保持原样交给落库层报错
      const atMs = Date.parse(`${String(data[spec.timeCols[0]] ?? '').replace(' ', 'T')}Z`) || Date.now();
      for (const col of spec.timeCols) {
        const v = data[col];
        if (typeof v === 'string' && v) data[col] = localTextToUtc(v, atMs, ref.timezone, ref.region);
      }
    }
    try {
      if (tx(() => spec.upsert(data, ctx)) === 'inserted') inserted += 1;
      else updated += 1;
    } catch (e) {
      errors.push({ row, reason: rowReason(e) });
    }
  }

  errors.sort((a, b) => a.row - b.row);
  const failed = errors.length;
  const startedAt = formatUtc(new Date());
  const status = failed === 0 ? 1 : inserted + updated > 0 ? 2 : 3;
  const firstShop = accepted[0]?.data.__shop as ShopRef | undefined;
  const logId = insert('sync_log', {
    task_type: 'import',
    shop_id: firstShop?.shop_id ?? null,
    fetched: rawRows.length,
    inserted,
    updated,
    failed,
    status,
    error_msg: failed ? errors.slice(0, 20).map((e) => `第 ${e.row} 行 ${e.reason}`).join(' | ') : null,
    started_at: startedAt,
    finished_at: formatUtc(new Date()),
    created_by: ctx.userId,
  });
  writeOpLog({
    user_id: ctx.userId,
    module: '导入中心',
    action: 'create',
    target_table: spec.table,
    target_id: logId,
    after: { table: spec.table, label: spec.label, source: ctx.source, total: rawRows.length, inserted, updated, failed },
    ip: ctx.ip,
  });
  return { total: rawRows.length, accepted: inserted + updated, inserted, updated, failed, errors, log_id: logId, status };
}

/** 导入行的自然日（按店铺时区），供注册表里需要 stat_date 的表复用 */
export const shopDay = (text: string, ref?: ShopRef): string =>
  statDateInZone(text, ref?.timezone ?? '', REGION_TZ_OFFSET[ref?.region ?? ''] ?? 0);
