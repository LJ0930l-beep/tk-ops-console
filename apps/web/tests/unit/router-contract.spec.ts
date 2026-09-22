import { describe, expect, it } from 'vitest';
import { MENU_KEYS } from '@tk/shared';
import { router } from '../../src/router';

/**
 * 前端路由表契约测试（「只有前端会犯、后端测试永远绿」的那类）：
 * 路由里写了某个 .vue，文件名拼错或页面被删，只有真的点进去才炸 ——
 * 这里逐条 resolve 懒加载组件，等于一次性把全部页面「点开」一遍。
 * （后端导出接口 ↔ 页面导出按钮的对应关系在 apps/server/tests/route-contract.spec.ts 里守，
 *   那里能直接读路由清单，不必让 vite 跨根目录 import。）
 */
const routes = router.getRoutes().filter((r) => r.meta?.menu);

describe('前端路由表', () => {
  it('路由条数与页面规模符合预期（不是被谁删空了）', () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
  });

  it('每条业务路由都有标题与合法菜单归属', () => {
    for (const r of routes) {
      expect(String(r.meta.title ?? ''), `${r.path} 缺 meta.title`).toBeTruthy();
      expect(MENU_KEYS).toContain(r.meta.menu);
    }
  });

  // 一次性点开 30 多个页面（每张页面都会拉自己的组件图），5 秒默认超时在并发跑测试的机器上会假红
  it('每个懒加载组件都能真的解析（文件名拼错 / 页面被删会在这里红）', { timeout: 60_000 }, async () => {
    const broken: string[] = [];
    for (const r of routes) {
      const loader = (r.components?.default ?? r.components) as unknown;
      if (typeof loader !== 'function') {
        broken.push(`${r.path}: 组件不是懒加载函数`);
        continue;
      }
      try {
        const mod = (await (loader as () => Promise<unknown>)()) as { default?: unknown };
        if (!mod?.default) broken.push(`${r.path}: 组件没有默认导出`);
      } catch (e) {
        broken.push(`${r.path}: ${(e as Error).message}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
