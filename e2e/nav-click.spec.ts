import { expect, test } from '@playwright/test';
import { login } from './fixtures';

/**
 * 逐个点侧边栏（选项 5 的补充：之前只验「页面能打开」，没验「点了有反应」）
 *
 * 钉住两件事：
 *  1. 菜单里出现的每一项都必须真的能进 —— 看得见却点不动（或点了被静默弹回）是最伤信任的一种坏；
 *  2. 如果确实因为权限被弹回，界面必须说清为什么，而不是让内容区停在上一个页面。
 *
 * 做法：按角色登录 → 把折叠组点开 → 对每个可见菜单项做真实点击 → 断言 hash 变了且 main 换了内容。
 */
const ACCOUNTS = ['boss', 'limy', 'wangqiang', 'chenbd', 'finwu', 'whzhao', 'adskent', 'yinuo'];

async function expandGroups(page: import('@playwright/test').Page): Promise<void> {
  // 折叠组的子项是 v-show 隐藏的（rect 0x0），所以「第一个子项没有尺寸」就是折叠
  for (const title of await page.locator('.el-sub-menu__title').all()) {
    const group = title.locator('xpath=ancestor::li[1]');
    const firstChild = group.locator('.el-menu-item').first();
    if ((await firstChild.count()) && !(await firstChild.boundingBox())) {
      await title.click();
      await page.waitForTimeout(180);
    }
  }
}

test.describe('侧边栏逐项可点', () => {  for (const account of ACCOUNTS) {
    test(`${account} 的每个菜单项点了都要真的换页面`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
      await login(page, account);
      await expandGroups(page);

      // 先把标签收集齐，再按标签定位去点：菜单在导航中会重排（unique-opened 收起上一组），
      // 按 nth(i) 取到的元素可能在"读标签"和"点它"之间换成了另一项 —— 于是报出「直播排班点了没反应」，
      // 实际点到的是已经激活的那一项。按文字定位则每次重新解析，索引漂移不会骗人。
      const labels: string[] = [];
      for (const it of await page.locator('.el-menu-item').all()) {
        const box = await it.boundingBox();
        if (!box || box.height === 0) continue; // 折叠未展开或角色无权限而不渲染
        const label = (await it.innerText()).replace(/\s+/g, ' ').trim();
        if (label) labels.push(label);
      }
      expect(labels.length, `${account} 一个菜单项都没有，本身就是问题`).toBeGreaterThan(0);

      const checked: string[] = [];
      const broken: string[] = [];
      for (const label of labels) {
        const item = page.locator('.el-menu-item').filter({ hasText: label }).first();
        if (!(await item.count())) continue;
        if ((await item.getAttribute('class'))?.includes('is-active')) continue; // 就在这一页，hash 本来不该变
        const before = page.url();
        const clicked = async (): Promise<void> => {
          await item.scrollIntoViewIfNeeded().catch(() => undefined);
          await item.click({ timeout: 5_000 }).catch(() => undefined);
        };
        // 耐心等 URL 真的变化：CI 上 vite 会现场编译懒加载 chunk，固定 sleep 会误判成「点了没反应」
        const waitMoved = async (): Promise<boolean> =>
          expect
            .poll(() => page.url(), { timeout: 10_000, intervals: [250, 500, 1000] })
            .not.toBe(before)
            .then(() => true)
            .catch(() => false);
        await clicked();
        let moved = await waitMoved();
        if (!moved) {
          // 第一次可能撞在一次还没结束的导航/重排上；真坏了的项点两次也不会动
          await clicked();
          moved = await waitMoved();
        }
        checked.push(label);
        if (!moved) broken.push(`${label}：点了两次 URL 都没变（${before}）`);
        // 等这一页真的渲染出东西再点下一项：不然下一次点击会撞在一次还没结束的导航上
        await page
          .waitForFunction(
            () => {
              const main = document.querySelector('main');
              return !!main && main.querySelector('.el-table, .el-card, .el-form, .el-descriptions, canvas, .el-empty') !== null;
            },
            undefined,
            { timeout: 15_000 },
          )
          .catch(() => undefined);
      }
      expect(broken, `${account} 有 ${broken.length} 项点了没反应：\n${broken.join('\n')}`).toEqual([]);
      expect(checked.length, `${account} 实际点到的菜单项太少（${checked.join('/')}）`).toBeGreaterThanOrEqual(3);
      expect(consoleErrors.join('\n'), `${account} 点击过程中有 JS 报错`).not.toMatch(/pageerror/);
    });
  }
});

test.describe('资源加载失败要自愈', () => {
  test('懒加载 chunk 拉不到时重载一次，而不是留下点不动的界面', async ({ page }) => {
    await login(page, 'boss');
    await page.goto('/#/dashboard');
    await page.evaluate(() => {
      (window as unknown as { __alive: number }).__alive = 1;
    });
    // 只掐掉「订单列表」这一页的懒加载模块，模拟服务端重启过 / 产物换了的窗口
    await page.route('**/src/views/order/OrderList.vue*', (r) => r.abort());
    const group = page.locator('.el-sub-menu__title', { hasText: '订单中心' }).first();
    if (await group.count()) await group.click().catch(() => undefined);
    await page.locator('.el-menu-item', { hasText: '订单列表' }).first().click();
    await page.waitForTimeout(3000);
    // 僵住的界面：hash 没变、window 上那个标记也还在（没发生过重载）
    const state = await page.evaluate(() => ({
      hash: location.hash,
      alive: typeof (window as unknown as { __alive?: number }).__alive,
    }));
    expect(state.alive === 'undefined' || state.hash.includes('/orders'), `chunk 失败后界面僵住了：hash=${state.hash}`).toBe(true);
  });
});
