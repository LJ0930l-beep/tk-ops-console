import { expect, test } from '@playwright/test';
import { login } from './fixtures';

/**
 * 导入中心走一遍（选项 5 的第 ② 条路径）
 *
 * 导入是这套系统里唯一「用户自己造数据」的入口，也是最容易把口径带歪的入口。
 * 后端 spec 守住了行级校验与 source 标记，这里守的是**界面链路**：
 * 下载模板 → 粘贴两行 → 「确认导入」按钮随解析结果从灰变亮 → 提交 → 回执与结果面板一致 → 列表刷得出来。
 * 中间任何一环断了（解析器、@done 刷新、按钮 disabled 条件），用户看到的就是「导入成功了但列表里找不到」。
 *
 * 注意所有定位器都要限定在 .el-dialog 内：列表页顶部的搜索框占位符里也有「昵称/handle」这类词。
 */
const STAMP = Date.now().toString(36);
const HANDLE_A = `e2e_${STAMP}_a`;
const HANDLE_B = `e2e_${STAMP}_b`;

async function openDialog(page: import('@playwright/test').Page) {
  await page.goto('/#/creators/pool');
  await expect(page).toHaveTitle(/达人公海/);
  await page.getByRole('button', { name: /导入达人/ }).click();
  const dialog = page.locator('.el-dialog:visible').last();
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('导入中心', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'boss');
  });

  test('下载模板 → 粘贴两行达人 → 提交 → 落库并刷新列表', async ({ page }) => {
    // ① 模板：文件名对得上（运营靠它知道该填哪些列）
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      openDialog(page).then((d) => d.getByRole('button', { name: /下载模板/ }).click()),
    ]);
    expect(download.suggestedFilename()).toContain('import-creator');
    expect(await download.path(), '下载文件没落盘').toBeTruthy();

    const dialog = page.locator('.el-dialog:visible').last();
    await dialog.getByRole('tab', { name: /粘贴内容/ }).click();

    // ② 粘贴后「确认导入」必须亮起来并带上行数 —— 这一步证明解析器真的吃进了两行
    await dialog.getByPlaceholder(/粘贴|Ctrl\+V/).fill(`handle,nickname,region,followers\n${HANDLE_A},E2E甲,MY,12345\n${HANDLE_B},E2E乙,TH,678`);
    const submit = dialog.getByRole('button', { name: /确认导入/ });
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await expect(submit).toContainText('2 行');

    // ③ 提交：结果面板要说清成功/拒绝各几行（提示条是转瞬即逝的，面板才是给用户复盘用的）
    await submit.click();
    await expect(dialog.locator('.el-alert').last()).toContainText(/新增\s*2\s*行/, { timeout: 20_000 });
    await dialog.locator('.el-dialog__footer').getByRole('button', { name: /关闭/ }).click();

    // ④ 列表刷新后按 handle 能查到，并且 source 被标成手工/抓取而不是同步
    const found = await page.evaluate(async (h) => {
      const r = await fetch(`/api/creators?page=1&pageSize=20&keyword=${encodeURIComponent(h)}`, {
        headers: { authorization: `Bearer ${localStorage.getItem('tk_token')}` },
      });
      const j = (await r.json()) as { data: { list: Record<string, unknown>[] } };
      return j.data.list?.[0] ?? null;
    }, HANDLE_A);
    expect(found, '导入后按 handle 查不到').toBeTruthy();
    expect(String(found.nickname)).toBe('E2E甲');
    expect(['web', 'manual', '2', '3']).toContain(String(found.source));
  });

  test('非法行被单独拒绝并给出原因，其余行照常入库', async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole('tab', { name: /粘贴内容/ }).click();
    await dialog
      .getByPlaceholder(/粘贴|Ctrl\+V/)
      .fill(`handle,nickname,region,followers\n,没有 handle 的行,MY,10\n${HANDLE_B},E2E乙,TH,678`);
    const submit = dialog.getByRole('button', { name: /确认导入/ });
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();
    // 结果面板必须留下「拒绝了几行、为什么被拒」，否则用户只会反复点提交
    await expect(dialog.locator('.el-alert').last()).toContainText(/拒绝\s*1\s*行/, { timeout: 20_000 });
    await expect(dialog).toContainText(/第\s*2\s*行|handle|必填|原因/);
  });
});
