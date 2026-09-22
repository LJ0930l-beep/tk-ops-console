import { expect, test } from '@playwright/test';
import { collectForbidden, gotoRoute, login, me, sidebarTexts } from './fixtures';

/**
 * RBAC 可见性回归（选项 5 的第 ① 条路径）
 *
 * 后端已经有 rbac-matrix.spec 守住「接口层谁能调」，但**界面层**没有自动化：
 * 菜单少渲染一个组、路由守卫写反、或者「入口看不见到点进去才发现自己有权限」这类问题，
 * 接口测试全绿也能发生。这里就钉界面：该看到的看到、不该看到的看不到、硬敲 URL 也进不去。
 */
interface Case {
  user: string;
  label: string;
  canSee: { path: string; title: string };
  cannotSee: { path: string; title: string };
}

/** 每个角色「应当 / 不应当」看到的菜单组（组名取自 MainLayout 的 visibleMenus 标题） */
const GROUPS: Record<string, { show: string; hide: string }> = {
  chenbd: { show: '达人中心', hide: '财务中心' },
  finwu: { show: '财务中心', hide: '系统设置' },
  whzhao: { show: '库存', hide: '投放中心' },
  adskent: { show: '投放中心', hide: '系统设置' },
  yinuo: { show: '内容中心', hide: '财务中心' },
  limy: { show: '订单中心', hide: '系统设置' },
};

const CASES: Case[] = [
  { user: 'chenbd', label: 'BD', canSee: { path: '/creators/mine', title: '我的达人' }, cannotSee: { path: '/finance/profit', title: '利润报表' } },
  { user: 'finwu', label: '财务', canSee: { path: '/finance/profit', title: '利润报表' }, cannotSee: { path: '/system/users', title: '员工管理' } },
  { user: 'whzhao', label: '仓库', canSee: { path: '/stock/query', title: '库存查询' }, cannotSee: { path: '/ads/daily', title: '广告日报' } },
  { user: 'adskent', label: '投放', canSee: { path: '/ads/daily', title: '广告日报' }, cannotSee: { path: '/creators/collab', title: '合作单' } },
  { user: 'yinuo', label: '内容', canSee: { path: '/videos', title: '视频库' }, cannotSee: { path: '/stock/ledger', title: '出入库流水' } },
  { user: 'limy', label: '运营', canSee: { path: '/orders', title: '订单列表' }, cannotSee: { path: '/system/synclog', title: '同步监控' } },
];

test.describe('按角色登录', () => {
  for (const c of CASES) {
    test(`${c.label}（${c.user}）看到的菜单与权限一致`, async ({ page }) => {
      const consoleErrors: string[] = [];
      // vite dev 首拉懒加载 chunk 的 504 与它引发的动态 import 失败是开发服务器时序，不算应用缺陷
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !/Outdated Optimize Dep|Failed to fetch dynamically imported module/i.test(t)) consoleErrors.push(t);
      });
      const forbidden = collectForbidden(page);
      await login(page, c.user);
      const user = await me(page);

      // ① 有权限的页面：能进去，标题写进 document.title（afterEach 里设的，等于路由真的落地了）
      await gotoRoute(page, c.canSee.path);
      await expect(page).toHaveURL(new RegExp(`#/${c.canSee.path.slice(1)}`));
      await expect(page).toHaveTitle(new RegExp(escapeRe(c.canSee.title)));

      // ② 侧边栏按「菜单组」这一层校验可见性：折叠的子项不在 DOM 里，按叶子标题断言会假红，
      //    而「这个角色看得见哪个业务域」正是越权入口的第一道闸。
      const here = (await sidebarTexts(page)).join(' | ');
      const g = GROUPS[c.user];
      expect(here, `${c.label} 侧边栏应该能看到「${g.show}」：${here}`).toContain(g.show);

      // ③ 没权限的页面：硬敲 URL 也必须被守卫弹回 dashboard
      await page.goto(`/#${c.cannotSee.path}`);
      await expect(page).toHaveURL(/#\/dashboard/, { timeout: 15_000 });

      // ④ 侧边栏里根本不该出现那个业务域的入口（「看不见」是比「点不进」更早的一道防线）
      const away = (await sidebarTexts(page)).join(' | ');
      expect(away, `${c.label} 的侧边栏不该出现「${g.hide}」：${away}`).not.toContain(g.hide);

      // ④ 登录过程中不该有前端报错（组件懒加载失败、store 报错都在这露出来）
      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
      // 页面能打开但偷偷吃了一个 403 = 下拉是空的、用户不知道为什么：这类「静默降级」要当场红
      expect(forbidden, `不该发生的 403：${forbidden.join(' , ')}`).toEqual([]);
      expect(user.menu_perms.length).toBeGreaterThan(0);
    });
  }

  test('老板（boss）看得到所有菜单组，包括系统设置', async ({ page }) => {
    await login(page, 'boss');
    const user = await me(page);
    const sidebar = (await sidebarTexts(page)).join(' | ');
    for (const t of ['经营看板', '订单列表', '利润报表', '员工管理', '库存查询', '达人']) {
      expect(sidebar, `boss 侧边栏缺「${t}」：${sidebar}`).toContain(t);
    }
    expect(user.role_key).toBe('boss');
    await page.goto('/#/system/users');
    await expect(page).toHaveURL(/#\/system\/users/);
  });

  test('未登录直接敲业务 URL 会被送去登录页，登录后回到原页面', async ({ page }) => {
    await page.goto('/#/finance/profit');
    await expect(page).toHaveURL(/#\/login/);
    await login(page, 'boss');
    await page.goto('/#/finance/profit');
    await expect(page).toHaveURL(/#\/finance\/profit/);
  });
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
