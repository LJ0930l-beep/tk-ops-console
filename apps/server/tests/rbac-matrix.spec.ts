/**
 * 权限矩阵快照（docs/dev-options.md 选项 8 的可落地小步）
 *
 * 角色定义是权限的唯一来源，改一行就能放权 —— 但改动的「后果」在代码评审里看不见：
 * 比如给 BD 加个 finance 菜单，就等于把成本口径给了 SELF 范围的人。
 * 所以这里把矩阵导出成一份可读的快照文件并逐条守住几条硬约束：
 *  - 快照变了必须显式更新文件（等于强制有人在 diff 里看到权限变化）；
 *  - 能进财务菜单的角色必须能看成本（利润报表整页 403，不给成本等于没开这个菜单）；
 *    投放菜单反过来允许 can_see_cost=0 —— 那是掩码语义，不是 403，两条规则不一样；
 *  - 能进系统设置（改角色、改数据范围）的角色不允许是 SELF 范围；
 *  - 任何 menu_perms 都必须落在 MENU_KEYS 内，且每个角色至少一个菜单。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_SCOPE, DEFAULT_ROLES, MENU_KEYS } from '@tk/shared';

const SNAPSHOT = fileURLToPath(new URL('./__snapshots__/rbac-matrix.json', import.meta.url));

const matrix = DEFAULT_ROLES.map((r) => ({
  role_key: r.role_key,
  role_name: r.role_name,
  data_scope: r.data_scope,
  can_see_cost: r.can_see_cost,
  can_see_contact: r.can_see_contact,
  can_export: r.can_export,
  menus: [...r.menu_perms].sort(),
})).sort((a, b) => a.role_key.localeCompare(b.role_key));

describe('角色权限矩阵', () => {
  it('与已提交的快照一致（要改权限就更新快照，让 diff 里看得见）', () => {
    if (!existsSync(SNAPSHOT)) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
    }
    expect(readFileSync(SNAPSHOT, 'utf8').trim()).toBe(JSON.stringify(matrix, null, 2).trim());
  });

  it('菜单键合法、每个角色至少一个菜单', () => {
    for (const r of DEFAULT_ROLES) {
      expect(r.menu_perms.length, `${r.role_key} 没有任何菜单`).toBeGreaterThan(0);
      for (const m of r.menu_perms) expect(MENU_KEYS).toContain(m);
    }
  });

  it('能进财务菜单的角色必须能看成本（利润报表是整页 403，不是掩码）', () => {
    for (const r of DEFAULT_ROLES) {
      if (r.menu_perms.includes('finance')) {
        expect(r.can_see_cost, `${r.role_key} 有财务菜单却不能看成本`).toBe(1);
      }
    }
  });

  it('投放菜单允许不看成本（广告 ROI 走掩码而不是整页拒绝）—— 记下这个刻意的差别', () => {
    const adsRole = DEFAULT_ROLES.find((r) => r.role_key === 'ads');
    expect(adsRole?.menu_perms).toContain('ads');
    expect(adsRole?.can_see_cost).toBe(0);
  });

  it('能进系统设置的角色不允许是 SELF 数据范围', () => {
    for (const r of DEFAULT_ROLES) {
      if (r.menu_perms.includes('system')) {
        expect(r.data_scope, `${r.role_key} 管系统设置却是 SELF 范围`).not.toBe(DATA_SCOPE.SELF);
      }
    }
  });

  it('老板是唯一的超级角色：全菜单 + ALL 范围 + 三项敏感开关全开', () => {
    const boss = DEFAULT_ROLES.find((r) => r.role_key === 'boss');
    expect(boss).toBeTruthy();
    expect(boss?.data_scope).toBe(DATA_SCOPE.ALL);
    expect(boss?.can_see_cost).toBe(1);
    expect(boss?.can_see_contact).toBe(1);
    expect(boss?.can_export).toBe(1);
    expect([...boss?.menu_perms ?? []].sort()).toEqual([...MENU_KEYS].sort());
  });
});
