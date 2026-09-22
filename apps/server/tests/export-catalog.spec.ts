/**
 * PRD D13「九类导出」收口回归
 *
 * 新增的 8 个导出端点（SPU / 待映射清单 / 达人 / 合作单 / 寄样 / 视频 / 直播 / 费用）
 * 全部走 core/export.ts 的 exportFromList：与列表接口共用同一份 FROM/SELECT/查询条件。
 * 这里钉四件事：
 *  1. csv 与 xlsx 两种格式都真能出文件（魔数 + 反解表头）；
 *  2. 权限三层不被绕过：没 finance/content/product/creator 菜单的角色一律 403，
 *     没有 can_export 的角色一律 403（xlsx 也不例外）；
 *  3. 每次导出都写 sys_op_log(action='export')，且带上筛选条件；
 *  4. 导出与列表**同源**：同一个筛选下，导出行数 = 列表 total（防止两边 WHERE 漂移）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { get } from '../src/core/db.js';
import { ACCOUNTS, auth, boot, dataOf, login, type TestContext } from './helper.js';

let ctx: TestContext;
const tok: Record<string, string> = {};

/** 与列表接口成对出现：path = 导出，list = 同一段筛选的列表接口 */
const RESOURCES: { name: string; path: string; list: string; menu: keyof typeof MENU_OWNER; owner: string }[] = [
  { name: 'SPU', path: '/api/products/spu/export', list: '/api/products/spu', menu: 'product', owner: 'opsManager' },
  { name: '待映射清单', path: '/api/products/unmapped/export', list: '/api/products/unmapped', menu: 'product', owner: 'opsManager' },
  { name: '达人', path: '/api/creators/export', list: '/api/creators', menu: 'creator', owner: 'bd' },
  { name: '合作单', path: '/api/creators/collab/export', list: '/api/creators/collab', menu: 'creator', owner: 'bd' },
  { name: '寄样', path: '/api/creators/sample/export', list: '/api/creators/sample', menu: 'creator', owner: 'bd' },
  { name: '视频', path: '/api/content/videos/export', list: '/api/content/videos', menu: 'content', owner: 'content' },
  { name: '直播', path: '/api/content/lives/export', list: '/api/content/lives', menu: 'content', owner: 'content' },
  { name: '费用', path: '/api/finance/expense/export', list: '/api/finance/expense', menu: 'finance', owner: 'finance' },
];

const MENU_OWNER = { product: 1, creator: 1, content: 1, finance: 1 } as const;

const opLogCount = (table: string): number =>
  Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM sys_op_log WHERE action = 'export' AND target_table = ?`, table)?.c ?? 0);

async function xlsxHeaders(body: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  return (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ''));
}

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
});

describe('九类导出：两种格式都能出真文件', () => {
  for (const r of RESOURCES) {
    it(`${r.name}：CSV 带 BOM，XLSX 能被反解且表头非空`, async () => {
      // BD/剪辑/运营都没有 can_export（正向用例必须用有导出权的账号），所以统一用 boss 验证格式本身
      const owner = tok.boss;
      const csv = await ctx.http.get(`${r.path}?format=csv`).set(auth(owner));
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
      expect(csv.text.split('\r\n').length).toBeGreaterThan(1);

      const xls = await ctx.http.get(`${r.path}?format=xlsx`).set(auth(owner)).responseType('blob');
      expect(xls.status).toBe(200);
      expect(xls.headers['content-type']).toContain('spreadsheetml');
      const buf = xls.body as Buffer;
      expect(buf.subarray(0, 2).toString()).toBe('PK');
      const headers = await xlsxHeaders(buf);
      expect(headers.length).toBeGreaterThan(3);
      expect(headers.every((h) => h.length > 0)).toBe(true);
      // CSV 与 XLSX 表头必须是同一份（同源列定义）
      expect(headers.join(',')).toBe(csv.text.replace(/^﻿/, '').split('\r\n')[0]);
    });
  }
});

describe('九类导出：权限三层与留痕', () => {
  it('没有 can_export 的角色（BD / 剪辑 / 运营）一律 403，格式无关', async () => {
    for (const r of RESOURCES) {
      for (const role of ['bd', 'content', 'ops'] as const) {
        // BD / 剪辑连对应菜单都没有，先按菜单挡；有菜单但没导出权的按导出挡 —— 两条都必须是 403
        const res = await ctx.http.get(`${r.path}?format=xlsx`).set(auth(tok[role]));
        expect(res.status, `${role} 导出 ${r.name} 不该通过`).toBe(403);
      }
    }
  });

  it('菜单不对的账号也过不去（导出沿用列表同一层菜单把关）', async () => {
    const res = await ctx.http.get('/api/finance/expense/export?format=csv').set(auth(tok.opsManager));
    // ops_manager 有 finance 菜单：这条应当放行（证明把关是按菜单而不是按角色名硬编码）
    expect(res.status).toBe(200);
    const warehouse = await ctx.http.get('/api/products/spu/export?format=csv').set(auth(tok.warehouse));
    expect(warehouse.status).toBe(403);
  });

  it('每次导出都写 sys_op_log(action=export)，并记下筛选条件与格式', async () => {
    const before = opLogCount('video');
    const res = await ctx.http.get('/api/content/videos/export?format=csv&start_date=2026-08-01&end_date=2026-09-18').set(auth(tok.boss));
    expect(res.status).toBe(200);
    expect(opLogCount('video')).toBe(before + 1);
    const log = get<{ before_after: string | null }>(
      `SELECT before_after FROM sys_op_log WHERE action = 'export' AND target_table = 'video' ORDER BY id DESC LIMIT 1`,
    );
    const detail = JSON.parse(String(log?.before_after ?? '{}')) as Record<string, { filters?: Record<string, unknown>; format?: string; rows?: number }>;
    const after = detail.after ?? detail;
    expect(after.format).toBe('csv');
    // 只许记「导出了多少行」，不许把导出内容本身塞进日志（否则 sys_op_log 变成第二份数据源，
    // 敏感字段跟着日志表一起扩散）
    expect(typeof after.rows).toBe('number');
    expect(Number(after.rows)).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(detail)).not.toContain('video_url');
    expect(after.filters?.start_date).toBe('2026-08-01');
  });
});

describe('九类导出：与列表同源', () => {
  for (const r of RESOURCES) {
    it(`${r.name}：导出行数与同筛选下的列表 total 一致`, async () => {
      const owner = tok.boss;
      const list = await ctx.http.get(`${r.list}?page=1&pageSize=5`).set(auth(owner));
      expect(list.status).toBe(200);
      const total = Number(dataOf<{ list: unknown[]; total: number }>(list.body).total);
      const csv = await ctx.http.get(`${r.path}?format=csv`).set(auth(owner));
      const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines.length - 1).toBe(total); // 表头之外正好等于列表总数
    });
  }
});
