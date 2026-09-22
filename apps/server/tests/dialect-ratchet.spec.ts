/**
 * SQL 方言债「只减不增」棘轮（docs/dev-options.md 选项 6 的第 ③ 步的地基）
 *
 * 为什么不直接做方言改造：那是 3–5 人日的事，而项目现在的并发量用不到（详见 docs/db-migration.md 的判断）。
 * 但「以后再改」最容易变成「永远改不了」——因为没人知道到底还欠多少。
 * 所以这里把 SQLite 专有写法逐类数出来钉住：
 *  - 新增一处同类写法 → 数字超预算 → 测试红，逼着要么改要么显式调高预算（并在 PR 里说明）；
 *  - 消灭一类写法 → 数字低于预算 → 也是红，提示把预算调下去。
 * 两种方向都要有反馈，否则棘轮只是一个「下限测试」，会一路涨。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

/** 只数真正阻碍换库的写法；COALESCE / `||` / 子查询这些两边都支持，不算债 */
const PATTERNS: Record<string, { re: RegExp; to: string }> = {
  "datetime('now')": { re: /datetime\('now'/g, to: 'CURRENT_TIMESTAMP / NOW()' },
  'datetime( 函数调用': { re: /\bdatetime\(/g, to: 'CAST(... AS TIMESTAMP) 或两侧各自的日期函数' },
  IFNULL: { re: /\bIFNULL\(/g, to: 'COALESCE（两边通用，可以直接替换）' },
  'substr( 取日期': { re: /\bsubstr\(/g, to: 'SUBSTRING(... FOR ...) / LEFT()' },
  julianday: { re: /\bjulianday\(/g, to: '日期差函数（DATEDIFF / date - date）' },
  'INSERT OR IGNORE': { re: /INSERT OR IGNORE/g, to: 'ON CONFLICT DO NOTHING / INSERT IGNORE' },
  PRAGMA: { re: /\bPRAGMA\s/g, to: '库专属配置，换库后由连接参数或 SET 处理' },
  'AUTOINCREMENT': { re: /AUTOINCREMENT/g, to: 'AUTO_INCREMENT / SERIAL' },
  group_concat: { re: /group_concat\(/g, to: 'STRING_AGG / GROUP_CONCAT 参数不同' },
  strftime: { re: /strftime\(/g, to: 'DATE_FORMAT / TO_CHAR' },
  '自定义 SQL 函数注册': { re: /\bdb\.function\(/g, to: 'MySQL/PG 侧要落成等价存储函数或生成列' },
};

/**
 * 预算 = 2026-09-22 实测值。改小请连带改这里；改大必须在 PR 里说清为什么又欠了一笔。
 * 迁移完成的目标是整块删掉这个文件（docs/db-migration.md 第 4 节）。
 */
const BUDGET: Record<string, number> = {
  "datetime('now')": 117,
  'datetime( 函数调用': 125,
  IFNULL: 59,
  'substr( 取日期': 38,
  julianday: 10,
  'INSERT OR IGNORE': 1,
  PRAGMA: 13,
  AUTOINCREMENT: 37,
  group_concat: 0,
  strftime: 0,
  '自定义 SQL 函数注册': 1,
};

function sourceFiles() {
  const list = execSync('git ls-files apps/server/src packages/shared/src', { cwd: ROOT, encoding: 'utf8' });
  return list.trim().split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.sql'));
}

describe('SQL 方言债棘轮', () => {
  const files = sourceFiles();
  const counts: Record<string, { n: number; where: string[] }> = {};
  for (const [name, { re }] of Object.entries(PATTERNS)) {
    let n = 0;
    const where: string[] = [];
    for (const f of files) {
      const src = readFileSync(`${ROOT}/${f}`, 'utf8');
      const m = src.match(new RegExp(re.source, 'g'));
      if (m?.length) {
        n += m.length;
        where.push(`${f}:${m.length}`);
      }
    }
    counts[name] = { n, where };
  }

  it('每一类 SQLite 专有写法都没超预算（新增方言债会在这里红）', () => {
    const over = Object.entries(BUDGET)
      .filter(([k]) => counts[k].n > BUDGET[k])
      .map(([k]) => `${k}: 实测 ${counts[k].n} > 预算 ${BUDGET[k]}（${counts[k].where.slice(0, 4).join(' ')}）`);
    expect(over, `换库工作量又变大了：\n${over.join('\n')}\n见 docs/db-migration.md`).toEqual([]);
  });

  it('预算没有虚高（还掉的债要从账上划掉，否则这份清单会变成摆设）', () => {
    const stale = Object.entries(BUDGET)
      .filter(([k]) => counts[k].n < BUDGET[k])
      .map(([k]) => `${k}: 实测 ${counts[k].n} < 预算 ${BUDGET[k]}`);
    expect(stale, `这些方言债已经变少了，把 BUDGET 一起改小：\n${stale.join('\n')}`).toEqual([]);
  });

  it('两份 DDL 的表数量与这份清单同源（schema-drift 已细校验，这里只兜底别整体漏）', () => {
    const sqlite = readFileSync(`${ROOT}/apps/server/src/db/schema.sqlite.sql`, 'utf8');
    const tables = (sqlite.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? []).length;
    expect(tables).toBeGreaterThanOrEqual(38);
  });
});
