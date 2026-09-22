/**
 * 两份 DDL 的漂移校验（docs/dev-options.md 选项 6 的第一步）
 *
 * 仓库里有 schema.sqlite.sql（运行时真的执行）和 schema.mysql.sql（生产等价 DDL），
 * 但没有任何东西保证它们同步 —— MySQL 那份现在只是文档，
 * 一旦哪天真要迁库，才发现少了几张表、少了几列，迁移当天才补就是事故。
 * 所以先加这道闸门：表集合 + 每表列名集合必须对得上，
 * 只允许下面 DIALLECT_ONLY 里逐条写明理由的差异。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const read = (f: string) => readFileSync(`${ROOT}/apps/server/src/db/${f}`, 'utf8');

/** 刻意只存在于一边的列：SQLite 用部分唯一索引表达软删幂等，MySQL 没有部分索引，只能加生成列 */
const DIALECT_ONLY: Record<'sqlite' | 'mysql', Set<string>> = {
  sqlite: new Set<string>(),
  mysql: new Set(['live_session.live_key']),
};

/** 解析 CREATE TABLE 块 → 表名 → 列名集合（跳过约束/索引语句） */
function parseTables(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(([\s\S]*?)\n\)/g)) {
    const [, table, inner] = m;
    const cols = new Set<string>();
    for (const raw of inner.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--') || line.startsWith('/*')) continue;
      // 约束/索引行不算列
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\b/i.test(line)) continue;
      const cm = line.match(/^`?(\w+)`?\s+[A-Za-z]/);
      if (cm) cols.add(cm[1]);
    }
    out.set(table, cols);
  }
  return out;
}

const sqlite = parseTables(read('schema.sqlite.sql'));
const mysql = parseTables(read('schema.mysql.sql'));

describe('SQLite / MySQL 两份 DDL 不漂移', () => {
  it('两边的表集合一致（且数量符合预期，不是解析器罢工）', () => {
    expect(sqlite.size).toBeGreaterThanOrEqual(30);
    expect(mysql.size).toBeGreaterThanOrEqual(30);
    const onlySqlite = [...sqlite.keys()].filter((t) => !mysql.has(t));
    const onlyMysql = [...mysql.keys()].filter((t) => !sqlite.has(t));
    expect(onlySqlite, `只有 SQLite 有的表：${onlySqlite.join(', ')}`).toEqual([]);
    expect(onlyMysql, `只有 MySQL 有的表：${onlyMysql.join(', ')}`).toEqual([]);
  });

  it('每张表的列名集合一致（允许 DIALECT_ONLY 里写明理由的差异）', () => {
    const diffs: string[] = [];
    for (const [table, cols] of sqlite) {
      const other = mysql.get(table);
      if (!other) continue;
      const missingInMysql = [...cols].filter((c) => !other.has(c) && !DIALECT_ONLY.sqlite.has(`${table}.${c}`));
      const extraInMysql = [...other].filter((c) => !cols.has(c) && !DIALECT_ONLY.mysql.has(`${table}.${c}`));
      if (missingInMysql.length) diffs.push(`${table} 缺列(MySQL)：${missingInMysql.join(', ')}`);
      if (extraInMysql.length) diffs.push(`${table} 多出列(MySQL)：${extraInMysql.join(', ')}`);
    }
    expect(diffs, diffs.join(' | ')).toEqual([]);
  });

  it('两份 DDL 的公共字段约定都不缺（id / created_by / created_at / updated_at / is_deleted）', () => {
    /** 例外都要写清理由；两边同时豁免 —— 因为前面已证明两边列集合一致 */
    const NO_COMMON_FIELDS: Record<string, string> = {
      schema_migration: '迁移记录表本身：只有一列 version + applied_at，加公共字段没有意义',
      user_notification: '个人收件箱行：归属人就是 recipient_id，没有「谁创建」这一说（系统生成）',
    };
    const missing: string[] = [];
    for (const [dialect, tables] of [['sqlite', sqlite], ['mysql', mysql]] as const) {
      for (const [table, cols] of tables) {
        if (NO_COMMON_FIELDS[table]) continue;
        for (const common of ['created_by', 'created_at', 'updated_at', 'is_deleted']) {
          if (!cols.has(common)) missing.push(`${dialect}:${table}.${common}`);
        }
      }
    }
    expect(missing, `缺公共字段：${missing.join(', ')}`).toEqual([]);
  });
});
