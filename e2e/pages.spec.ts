import { expect, test } from '@playwright/test';
import { gotoRoute, login } from './fixtures';

/**
 * 全页面兜底遍历：每一页都真的用浏览器打开一次，要求
 *  ① 没有 JS 运行时错误（pageerror / console error）；
 *  ② 没有 5xx 响应（后端 SQL/口径炸了在这露出来）；
 *  ③ 页面主体真的渲染出内容（不是白屏 —— 白屏在「接口 200 但前端解包失败」时最容易骗过人）。
 *
 * 这条不值 3 分钟写，但它是唯一能抓到「某页面只有老板权限 + 组件懒加载失败 + 表格插槽报错」
 * 这类组合问题的门禁；人工走查做过三轮，每次都是靠眼睛，改一版就要重来一次。
 */
const PAGES: { path: string; title: string }[] = [
  { path: '/actions', title: '今日行动中心' },
  { path: '/actions/results', title: '效果回看' },
  { path: '/dashboard', title: '经营看板' },
  { path: '/shops', title: '店铺管理' },
  { path: '/accounts', title: 'TikTok 账号' },
  { path: '/products/spu', title: '商品(SPU)' },
  { path: '/products/sku', title: 'SKU 与成本' },
  { path: '/products/listing', title: '店铺商品映射' },
  { path: '/products/unmapped', title: '待映射清单' },
  { path: '/products/abc', title: 'ABC 分层与渠道' },
  { path: '/orders', title: '订单列表' },
  { path: '/returns', title: '售后退款' },
  { path: '/creators/pool', title: '达人公海' },
  { path: '/creators/mine', title: '我的达人' },
  { path: '/creators/outreach', title: '建联跟进' },
  { path: '/creators/collab', title: '合作单' },
  { path: '/creators/sample', title: '寄样管理' },
  { path: '/creators/roi', title: '达人 ROI 排行' },
  { path: '/videos', title: '视频库' },
  { path: '/lives/schedule', title: '直播排班' },
  { path: '/lives', title: '直播复盘' },
  { path: '/ads/daily', title: '广告日报' },
  { path: '/finance/settlement', title: '结算对账' },
  { path: '/finance/reconcile', title: '逐单对账' },
  { path: '/finance/expense', title: '费用登记' },
  { path: '/finance/rate', title: '汇率维护' },
  { path: '/finance/profit', title: '利润报表' },
  { path: '/stock/warehouse', title: '仓库管理' },
  { path: '/stock/ledger', title: '出入库流水' },
  { path: '/stock/query', title: '库存查询' },
  { path: '/system/users', title: '员工管理' },
  { path: '/system/roles', title: '角色权限' },
  { path: '/system/oplog', title: '操作日志' },
  { path: '/system/synclog', title: '同步监控' },
  { path: '/system/dict', title: '数据字典' },
  { path: '/system/rules', title: '规则中心' },
];

/** 与本项目无关的浏览器噪声：devtools 提示、SourceMap、favicon */
const IGNORE = /Download the Vue Devtools|source map|favicon|Failed to load resource: the server responded with a status of 404/i;

test.describe('全页面遍历', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'boss');
  });

  for (const p of PAGES) {
    test(p.title, async ({ page }) => {
      const errors: string[] = [];
      const server5xx: string[] = [];
      page.on('console', (m) => {
        const t = m.text();
        // 按需引入改造的专属回归：只在模板里用到的组件/图标没被注册时，Vue 只报 warning，
        // 界面表现为「按钮没了 / 图标空白」，不点进来根本发现不了 —— 所以 warning 也要判红。
        if (/Failed to resolve component/.test(t)) errors.push(t);
        else if (m.type() === 'error' && !IGNORE.test(t)) errors.push(t);
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('response', (r) => {
        if (r.status() >= 500) server5xx.push(`${r.status()} ${r.url()}`);
      });

      try {
        await gotoRoute(page, p.path);
      } catch (e) {
        // 白屏时最先要看到的是浏览器自己说的那句话，别让「重试 4 次仍为空」把线索吞掉
        throw new Error(`${p.title} 打不开：${(e as Error).message}\n  前端报错：${errors.join(' | ') || '(无)'}\n  5xx：${server5xx.join(' , ') || '(无)'}`);
      }
      await expect(page).toHaveTitle(new RegExp(p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), { timeout: 20_000 });
      // 主体渲染：要么有表格/卡片/图表，要么明确是空态；纯白屏两者都没有
      const body = page.locator('#app');
      await expect(body).toBeVisible();
      const hasContent = await body.locator('.el-table, .el-card, .el-form, canvas, .el-empty, .el-descriptions').count();
      expect(hasContent, `${p.title} 页什么都没渲染出来（白屏？）`).toBeGreaterThan(0);
      // 让懒加载 chunk 与首屏接口有机会失败
      await page.waitForTimeout(600);

      expect(server5xx, `后端 5xx：${server5xx.join(' , ')}`).toEqual([]);
      expect(errors, `前端报错：${errors.join(' | ')}`).toEqual([]);
    });
  }

  test('订单详情（带参数的路由）也能打开', async ({ page }) => {
    const list = await page.evaluate(async () => {
      const r = await fetch(`/api/orders?page=1&pageSize=1`, { headers: { authorization: `Bearer ${localStorage.getItem('tk_token')}` } });
      const j = (await r.json()) as { data: { list: { id: number }[] } };
      return j.data.list[0]?.id ?? 0;
    });
    expect(list, '演示库里应该至少有一张订单').toBeGreaterThan(0);
    await page.goto(`/#/orders/${list}`);
    await expect(page).toHaveTitle(/订单详情/);
    await expect(page.locator('#app .el-descriptions, #app .el-card, #app .el-table').first()).toBeVisible();
  });
});
