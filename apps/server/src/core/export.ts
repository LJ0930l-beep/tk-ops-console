/**
 * 统一导出（CSV / XLSX 同一份列定义）
 *
 * 为什么要有这一层：五个导出接口原先各写一套 CSV 拼装（转义、BOM、换行、响应头都重复一遍），
 * 有的还只回 JSON，导致「导出」这个能力在界面上点不到、格式也不齐（PRD DoD 要求可导出 Excel）。
 * 这里只留一个出口：调用方给「表头 + 行数据」，格式由 `?format=csv|xlsx` 决定。
 *
 * XLSX 走 ExcelJS 的 WorkbookWriter **流式**写：一行一行 commit 直接进 response，
 * 不在内存里堆整份工作簿 —— 订单导出上限 2 万行，单进程 SQLite 上堆一次就可能把服务拖住。
 */
import ExcelJS from 'exceljs';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { all, get } from './db.js';
import { badRequest } from './http.js';
import { writeOpLog } from './oplog.js';
import type { Q } from './query.js';

export type ExportCell = string | number | boolean | null | undefined;
export type ExportFormat = 'csv' | 'xlsx';

export interface ExportTable {
  /** 不含扩展名，例如 `profit-day-2026-07-01_2026-07-31` */
  filename: string;
  headers: string[];
  /** 允许传生成器：边查边写，不必先把全表 map 成数组 */
  rows: Iterable<ExportCell[]>;
  sheet?: string;
  /** 总行数（能提前知道就传）：超过上限直接拒绝，而不是先写一半再断 */
  count?: number;
}

/** 默认 CSV（与既有调用方保持兼容），显式 `?format=xlsx` 才出 Excel */
export function exportFormat(req: Request): ExportFormat {
  return String(req.query.format ?? '').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
}

const CSV_TYPE = 'text/csv; charset=utf-8';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** RFC 4180 转义；含逗号/引号/换行才加引号 */
const esc = (v: ExportCell): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 文件名只留安全字符：响应头里塞进中文/引号会被某些浏览器截断 */
const safeName = (name: string, ext: string): string => `${name.replace(/[^\w.\-]+/g, '_').replace(/_+$/, '')}.${ext}`;

function sendCsv(res: Response, t: ExportTable): void {
  const parts: string[] = [t.headers.map(esc).join(',')];
  for (const row of t.rows) parts.push(row.map(esc).join(','));
  res.setHeader('Content-Type', CSV_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(t.filename, 'csv')}"`);
  // BOM：Excel 双击打开中文不乱码
  res.end(`\uFEFF${parts.join('\r\n')}\r\n`);
}

async function sendXlsx(res: Response, t: ExportTable): Promise<void> {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(t.filename, 'xlsx')}"`);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet(t.sheet ?? 'Sheet1');
  sheet.addRow(t.headers).commit();
  // 列宽按表头长度给个够用的值：流式写入拿不到全量数据，不做「按内容自适应」
  sheet.columns = t.headers.map((h) => ({ width: Math.min(40, Math.max(10, String(h).length * 2 + 4)) }));
  for (const row of t.rows) {
    sheet.addRow(row.map((v) => (v === null || v === undefined ? '' : v))).commit();
  }
  await sheet.commit();
  await workbook.commit();
}

/**
 * 列表页导出出口：与列表接口共用同一份 FROM / SELECT / 查询条件（由调用方传进来），
 * 这里只加三件事——取全量（带上限护栏）、按调用方的列定义出表、写 action='export' 留痕。
 *
 * 为什么非要共用：只要导出自己写一份 WHERE，就一定会和列表漂移
 * （本轮已经为此修过三处：ROI 死路径、字典整页 500、同步下拉枚举对不上）。
 */
export function exportFromList(
  req: Request,
  res: Response,
  opts: {
    module: string;
    targetTable: string;
    filename: string;
    from: string;
    select: string;
    /** 与列表接口同一个 Q（含数据范围与全部筛选） */
    q: Q;
    orderBy?: string;
    columns: readonly (string | { key: string; label: string })[];
    /** 逐行加工（掩码、字典翻译等），与列表的 map 保持同一个函数 */
    decorate?: (row: Record<string, unknown>) => Record<string, unknown>;
    /** 行数上限，默认 config.exportMaxRows */
    cap?: number;
    /** 额外记进日志的筛选条件（不写敏感值） */
    filters?: Record<string, unknown>;
  },
): void {
  const cap = opts.cap ?? config.exportMaxRows;
  const total = Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${opts.from}${opts.q.whereSql}`, ...opts.q.params)?.c ?? 0);
  if (total > cap) throw badRequest(`导出行数 ${total} 超过上限 ${cap} 行，请缩小时间区间或加筛选条件后重试`);
  const rows = all<Record<string, unknown>>(
    `SELECT ${opts.select} FROM ${opts.from}${opts.q.whereSql} ORDER BY ${opts.orderBy ?? 'id DESC'} LIMIT ?`,
    ...opts.q.params,
    cap,
  ).map((r) => (opts.decorate ? opts.decorate(r) : r));
  const cols = opts.columns.map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
  writeOpLog({
    user_id: (req as { user?: { id?: number } }).user?.id ?? 0,
    module: opts.module,
    action: 'export',
    target_table: opts.targetTable,
    after: { rows: rows.length, filters: opts.filters ?? {}, format: exportFormat(req), cap },
    ip: req.ip,
  });
  void sendTable(res, { filename: opts.filename, headers: cols.map((c) => c.label), rows: rows.map((r) => cols.map((c) => r[c.key] as ExportCell)) }, exportFormat(req));
}

/** 导出唯一出口：格式由调用方从 exportFormat(req) 取，写日志与权限把关仍在各路由里 */
export async function sendTable(res: Response, t: ExportTable, format: ExportFormat = 'csv', maxRows = config.exportMaxRows): Promise<void> {
  // PRD B8：一期只做同步行数上限，超了明确拒绝并让人缩小范围，不做「先写一半再断流」
  const count = t.count ?? (Array.isArray(t.rows) ? t.rows.length : undefined);
  if (count !== undefined && count > maxRows) {
    throw badRequest(`导出行数 ${count} 超过上限 ${maxRows} 行，请缩小时间区间或加筛选条件后重试`);
  }
  if (format === 'xlsx') await sendXlsx(res, t);
  else sendCsv(res, t);
}
