/**
 * 导出回归（建议 3 / DoD 导出半边）
 *
 * 五个导出接口现在共用 core/export.ts：同一份表头与行数据，`?format=csv|xlsx` 决定格式。
 * 这里验的是「真的能打开的 Excel」而不是「200 就算过」：
 * 把响应体当二进制读回来，用 ExcelJS 反解，核对表头与首行数据，
 * 顺带守住两条老口径 —— 不带 format 时仍回 JSON（前端表格与既有用例依赖），CSV 仍带 BOM。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { boot, login, auth, dataOf, ACCOUNTS, type TestContext } from './helper.js';
import { sendTable } from '../src/core/export.js';
import { config } from '../src/config.js';

let ctx: TestContext;
const tok: Record<string, string> = {};

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) tok[k] = await login(ctx.http, u);
});

const EXPORTS = [
  { name: '订单', url: '/api/orders/export?format=xlsx', needsJsonDefault: true },
  { name: 'SKU', url: '/api/products/export/sku?format=xlsx', needsJsonDefault: true },
  { name: '广告日报', url: '/api/ads/export?format=xlsx', needsJsonDefault: false },
  { name: '利润报表', url: '/api/finance/profit/export?format=xlsx', needsJsonDefault: false },
  { name: '结算对账', url: '/api/finance/settlement/reconcile/export?format=xlsx', needsJsonDefault: false },
];

/** 反解 XLSX：表头 + 数据行数 */
async function readXlsx(buf: Buffer): Promise<{ headers: string[]; rowCount: number; firstRow: unknown[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ''));
  const firstRow = (sheet.getRow(2).values as unknown[]).slice(1);
  return { headers, rowCount: sheet.rowCount, firstRow };
}

describe('XLSX 导出', () => {
  for (const e of EXPORTS) {
    it(`${e.name}：回真的能反解的 xlsx（PK 魔数 + 表头 + 数据行）`, async () => {
      const res = await ctx.http.get(e.url).set(auth(tok.boss)).responseType('blob');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain('.xlsx');
      const buf = res.body as Buffer;
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.subarray(0, 2).toString()).toBe('PK');
      const { headers, rowCount } = await readXlsx(buf);
      expect(headers.length).toBeGreaterThan(3);
      expect(headers.every((h) => h.length > 0)).toBe(true);
      expect(rowCount).toBeGreaterThan(1);
    });
  }

  it('导出内容与 CSV 同源：表头一致、首行数据一致', async () => {
    const x = await readXlsx((await ctx.http.get('/api/orders/export?format=xlsx').set(auth(tok.boss)).responseType('blob')).body as Buffer);
    const csv = (await ctx.http.get('/api/orders/export?format=csv').set(auth(tok.boss))).text as string;
    const [head, first] = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(x.headers.join(',')).toBe(head);
    // CSV 里带引号转义，这里只比对第一个字段（订单号），够证明两边取的是同一份数据
    expect(String(x.firstRow[0])).toBe(first.split(',')[0].replace(/"/g, ''));
  });
});

describe('行数上限（PRD B8：一期只做同步导出，超了明确拒绝）', () => {
  it('默认上限 2 万行，来自 config 而不是写死在导出里', () => {
    expect(config.exportMaxRows).toBe(20000);
  });

  it('超上限直接抛 400，而不是先写一半再断流', async () => {
    const res = { setHeader() {}, end() {} } as unknown as Response;
    await expect(sendTable(res, { filename: 'x', headers: ['a'], rows: [[1], [2], [3]] }, 'csv', 2)).rejects.toThrow(/超过上限 2 行/);
  });

  it('传了 count 时按 count 判定（生成器场景也能提前拒绝）', async () => {
    const res = { setHeader() {}, end() {} } as unknown as Response;
    const rows = function* (): Generator<number[]> {
      yield [1];
    };
    await expect(sendTable(res, { filename: 'x', headers: ['a'], rows: rows(), count: 99999 }, 'xlsx', 10)).rejects.toThrow(/99999/);
  });
});

describe('CSV 与 JSON 的老口径没被破坏', () => {
  it('CSV 仍带 BOM、仍是 text/csv', async () => {
    const res = await ctx.http.get('/api/finance/profit/export?format=csv').set(auth(tok.boss));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect((res.text as string).charCodeAt(0)).toBe(0xfeff);
  });

  it('不带 format 时，订单与 SKU 导出仍回 JSON 信封', async () => {
    for (const url of ['/api/orders/export', '/api/products/export/sku']) {
      const data = dataOf<{ columns: string[]; count: number; rows: unknown[] }>(
        (await ctx.http.get(url).set(auth(tok.boss))).body,
      );
      expect(Array.isArray(data.columns)).toBe(true);
      expect(data.count).toBe(data.rows.length);
    }
  });

  it('无导出权限的角色仍然是 403（加了格式不能顺手放开权限）', async () => {
    // bd 角色 can_export=0
    for (const e of EXPORTS) {
      expect((await ctx.http.get(e.url).set(auth(tok.bd))).status).toBe(403);
    }
  });

  it('无成本权限的角色拿不到利润/对账导出（xlsx 也不行）', async () => {
    expect((await ctx.http.get('/api/finance/profit/export?format=xlsx').set(auth(tok.ops))).status).toBe(403);
    expect((await ctx.http.get('/api/finance/settlement/reconcile/export?format=xlsx').set(auth(tok.ops))).status).toBe(403);
  });
});
