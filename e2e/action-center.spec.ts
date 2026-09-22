import { expect, test } from '@playwright/test';
import { lastMessage, login } from './fixtures';

/**
 * 行动中心闭环（选项 5 的第 ③ 条路径）：跑规则 → 出现待办 → 处置 → 效果回看能看到这条处置。
 *
 * 这是 V2 的主线，也是「规则引擎只检测/建议、不自动执行」这条红线的界面证据：
 * 状态变化必须由人点「处理」并写下原因，系统才动。
 */
const NOTE = `e2e-${Date.now().toString(36)}：已联系投放核实，先暂停该计划`;

test.describe('行动中心闭环', () => {
  test('手动评估 → 待办能打开 → 处置一条 → 回看页留痕', async ({ page }) => {
    await login(page, 'boss');

    // ① 规则中心手动跑一轮（只有能编辑规则的角色看得到这个按钮）
    await page.goto('/#/system/rules');
    await expect(page).toHaveTitle(/规则中心/);
    const runBtn = page.getByRole('button', { name: /手动跑一轮/ });
    await expect(runBtn).toBeVisible();
    await runBtn.click();
    const evalMsg = await lastMessage(page);
    expect(evalMsg, `手动评估回执异常：${evalMsg}`).toMatch(/新增|命中|评估|生成|条/);

    // ② 行动中心：要么有待办行，要么是明确的空态（不能白屏、不能报错）
    await page.goto('/#/actions');
    await expect(page).toHaveTitle(/今日行动中心/);
    await expect(page.locator('.page-card').first()).toBeVisible({ timeout: 15_000 });
    const rows = page.locator('.ev-row');
    const openCount = await rows.count();
    if (openCount === 0) {
      await expect(page.locator('.el-empty, .stat-grid, .el-card').first()).toBeVisible();
      test.info().annotations.push({ type: 'note', description: '当前没有未闭环预警，处置步骤跳过（演示库可能已被处理完）' });
      return;
    }

    // ③ 处置第一行：必须写「做了什么 / 为什么忽略」才允许提交
    await rows.first().getByRole('button', { name: '处理' }).click();
    const panel = page.locator('.el-dialog:visible, .el-drawer:visible').last();
    await expect(panel).toBeVisible();
    await panel.getByPlaceholder(/你做了什么|为什么忽略/).fill(NOTE);
    await panel.getByRole('button', { name: /提交/ }).click();
    const msg = await lastMessage(page);
    expect(msg, `处置回执异常：${msg}`).toMatch(/已记录|已处理|已提交|成功|忽略|闭环/);

    // ④ 效果回看：处置要留下可追溯的记录
    await page.goto('/#/actions/results');
    await expect(page).toHaveTitle(/效果回看/);
    await expect(page.locator('.el-table, .el-empty').first()).toBeVisible({ timeout: 15_000 });
    const handled = await page.locator('.el-table__body tbody tr').count();
    expect(handled, '处置之后效果回看应当有记录').toBeGreaterThan(0);
  });

  test('待办详情能看到规则给出的证据，不是一句空提示', async ({ page }) => {
    await login(page, 'boss');
    await page.goto('/#/actions');
    const rows = page.locator('.ev-row');
    if ((await rows.count()) === 0) {
      test.info().annotations.push({ type: 'note', description: '没有未闭环预警可看' });
      return;
    }
    await rows.first().locator('.ev-main').click();
    const panel = page.locator('.el-dialog:visible, .el-drawer:visible').last();
    await expect(panel).toBeVisible();
    // 证据 chips 是规则引擎给出的判断依据：没有它，运营只会把预警当噪声忽略掉
    await expect(panel.locator('.chip, .el-descriptions__cell, .ev-chips').first()).toBeVisible();
  });

  test('只读角色（投放）看不到规则中心的编辑入口', async ({ page }) => {
    await login(page, 'adskent');
    await gotoForbiddenCheck(page);
  });
});

/** 投放没有 system 菜单：路由守卫会把 /system/rules 弹回 dashboard，界面也就拿不到「手动跑一轮」 */
async function gotoForbiddenCheck(page: import('@playwright/test').Page) {
  await page.goto('/#/system/rules');
  await expect(page).toHaveURL(/#\/dashboard/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /手动跑一轮/ })).toHaveCount(0);
}
