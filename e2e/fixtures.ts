import { expect, type Page } from '@playwright/test';

/** 演示口令不是真实凭证（项目里已明确），e2e 就用它，避免再造一套账号 */
export const PASSWORD = 'Passw0rd!';

export interface Me {
  id: number;
  name: string;
  role_key: string;
  role_name: string;
  data_scope: number;
  menu_perms: string[];
  can_export: number | boolean;
}

/** 走界面登录（不是塞 localStorage）：登录链路本身就是被测对象 */
export async function login(page: Page, username: string): Promise<void> {
  await page.goto('/#/login');
  // CI 冷启动时 vite 要先编译登录页这一块，不等表单真的出来就 fill，
  // 结果是把 20s 全烧在"登录后没能离开登录页"上（真红过一次，报的还是错的因）
  await page.getByRole('button', { name: /登\s*录/ }).waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByPlaceholder('登录账号').fill(username);
  await page.getByPlaceholder('密码').fill(PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  // 以前写成 waitForURL(/#\/(actions|dashboard|login)/) —— 正则把 /login 也算命中，
  // 等于根本没等，登录响应慢一点就误判成功。这里必须等到真的离开 /login。
  await expect
    .poll(() => page.url(), { timeout: 30_000, message: `${username} 登录后没能离开登录页` })
    .toMatch(/#\/(actions|dashboard)/);
}

/** 直接问后端要这个人的权限，用它去校验界面渲染 —— 而不是把角色表抄第二份进测试 */
export async function me(page: Page): Promise<Me> {
  return page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${localStorage.getItem('tk_token')}` } });
    const j = (await r.json()) as { data: Me };
    return j.data;
  });
}

/**
 * 侧边栏文字。
 *
 * 只取「一定能渲染出来」的那一层：Element Plus 的子菜单是懒渲染的，折叠时子项根本不在 DOM 里，
 * 所以断言要么点组标题（受动画与 unique-open 时序影响，脆），
 * 不如按**菜单组**这一粒度校验可见性 —— 「这个角色的侧边栏有没有财务中心」正是越权入口的第一道闸。
 */
export async function sidebarTexts(page: Page): Promise<string[]> {
  await page.locator('.el-menu').first().waitFor({ state: 'visible' });
  const items = await page.locator('.el-menu-item, .el-sub-menu__title').all();
  const out: string[] = [];
  for (const it of items) {
    const t = (await it.innerText()).replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * 进页面并等主体渲染。
 * 前几次可能吃到 vite dev 的 504 Outdated Optimize Dep（首次请求某懒加载 chunk 时它会重新预构建），
 * 那是开发服务器的时序，不是应用缺陷；重试而不是把它当红，真报错第二次仍然会红。
 */
export async function gotoRoute(page: Page, path: string): Promise<void> {
  const content = '#app .el-table, #app .el-card, #app .el-form, #app .el-descriptions, #app .el-calendar, #app canvas, #app .el-empty, #app .el-statistic';
  for (let i = 0; i < 4; i++) {
    await page.goto(`/#${path}`);
    await page.waitForTimeout(400);
    if (await page.locator(content).count()) return;
  }
  throw new Error(`${path} 渲染不出主体内容（重试 4 次后仍为空）`);
}

/** 403 的 XHR：界面「静默变空」的头号来源，测试里必须显式看见 */
export function collectForbidden(page: Page): string[] {
  const hits: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 403 && r.url().includes('/api/')) hits.push(`${r.status()} ${r.url()}`);
  });
  return hits;
}

/** Element Plus 的提示条：文案断言只走这里，避免抓到页面里同名的静态文字 */
export async function lastMessage(page: Page): Promise<string> {
  const el = page.locator('.el-message').last();
  await el.waitFor({ state: 'visible', timeout: 20_000 });
  return (await el.innerText()).trim();
}

/**
 * 触发本次动作之前先把屏幕上的旧提示清掉。
 * 不清会怎样：上一条 toast 还在 3s 展示期内、本次回执晚一步到，`lastMessage` 就把旧的那条当回执读走 ——
 * 于是断言报出"处置回执异常：评估 16 条规则…"这种驴唇不对马嘴的红（CI 上真红过一次）。
 * 只删 DOM 节点，不碰应用状态。
 */
export async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('.el-message').forEach((n) => n.remove()));
}

export async function hasToken(page: Page): Promise<boolean> {
  return Boolean(await page.evaluate(() => localStorage.getItem('tk_token')));
}
