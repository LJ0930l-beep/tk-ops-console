import { expect, test, type Page } from '@playwright/test';
import { clearMessages, lastMessage, login } from './fixtures';

/**
 * AI 助手的端到端（PRD §3.13）。
 *
 * 这一轮定的是"没配服务商就报错、不做 mock"，所以界面侧能真跑通的是**配置面 + 报错面**：
 *  - 没配服务商时，对话页必须说人话并把入口指过去，而不是白屏或让人对着输入框空等；
 *  - 服务商的新建要真的落到后端，并且密钥在界面上任何地方都读不回来（这是安全回归）；
 *  - 测活打不通的地址必须把失败原因显示出来，不许静默。
 *
 * 真实模型往返不在这里测：那需要一个能连的外网端点，CI 里既不稳定也不该有。
 * 报文形态、工具循环与写入留痕由 apps/server/tests/ai.spec.ts 用注入的桩 transport 覆盖。
 */

const KEY = 'sk-e2e-should-never-come-back';

/** 每次跑都用新名字：e2e 复用同一个临时库时，固定名会撞 ux_ai_provider_name */
const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
const PROVIDER_NAME = `e2e GPT ${runTag}`;

/** 通过接口把所有服务商停用，让"没有可用服务商"成为一个可制造的确定前提 */
async function disableAllProviders(page: Page): Promise<void> {
  const token = await page.evaluate(() => localStorage.getItem('tk_token'));
  const res = await page.request.get('/api/ai/providers?page=1&pageSize=100', { headers: { authorization: `Bearer ${token}` } });
  const list = ((await res.json()).data?.list ?? []) as { id: number; enabled: number }[];
  for (const p of list.filter((x) => Number(x.enabled) === 1)) {
    await page.request.put(`/api/ai/providers/${p.id}`, { data: { enabled: 0 }, headers: { authorization: `Bearer ${token}` } });
  }
}

/**
 * ResourcePage 的表单控件没有稳定的 label for，只能按标签文字定位到它所在的 form-item。
 * 用一条 CSS `:has()` 选择器而不是 locator.filter({has}) —— 后者在"内层定位器从另一个根创建"时
 * 匹配不到东西，表现就是干等到超时（e2e/selection.spec.ts 里的同名 helper 早就踩过，照它写）。
 */
const field = (page: Page, label: string) =>
  page.locator(`.el-dialog:visible .el-form-item:has(> .el-form-item__label:text-is("${label}"))`).last();

test.describe('AI 助手', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'boss');
  });

  test('没有启用的服务商时，对话页给出可执行的下一步', async ({ page }) => {
    // 先制造前提：库里可能已有上一轮留下的服务商，"一家都没配"不能靠运气
    await page.goto('/#/ai/providers');
    await disableAllProviders(page);

    await page.goto('/#/ai/chat');
    await expect(page).toHaveTitle(/AI 对话/);
    const alert = page.locator('.el-alert').first();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/模型服务商/);
    // 没服务商就不该让人对着输入框空等
    await expect(page.locator('.composer textarea')).toBeDisabled();
    await expect(page.getByRole('button', { name: '去配置服务商' })).toBeVisible();
  });

  test('新建服务商：密钥写得进、读不出，测活失败要回原因', async ({ page }) => {
    await page.goto('/#/ai/providers');
    await page.getByRole('button', { name: '新增' }).first().click();
    const dialog = page.locator('.el-dialog:visible').last();
    await expect(dialog).toBeVisible();
    await field(page, '名称').locator('input').fill(PROVIDER_NAME);
    await field(page, '接口地址').locator('input').fill('https://api.e2e.invalid/v1');
    await field(page, '模型名').locator('input').fill('gpt-4o-mini');
    await field(page, 'API Key').locator('input').fill(KEY);
    await clearMessages(page);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect.poll(() => lastMessage(page), { timeout: 20_000 }).toMatch(/成功|已保存|创建/);

    const row = page.locator('.el-table__body tr').filter({ hasText: PROVIDER_NAME });
    await expect(row).toBeVisible();
    // 整页文本里找密钥：`.page` 会同时命中页面根节点与 ResourcePage 的根节点（strict mode 直接报错），
    // 所以取 #app 的全文。
    const visible = await page.locator('#app').innerText();
    expect(visible, 'API Key 不许出现在任何列表单元格里').not.toContain(KEY);
    expect(visible).not.toContain('api_key_enc');

    await clearMessages(page);
    await row.getByRole('button', { name: '测活' }).click();
    const msg = await lastMessage(page);
    expect(msg, `测活回执异常：${msg}`).toMatch(/测活失败|失败|超时|不通|无效/);
    // 失败原因要留在列表里，不能只闪一条 toast
    await expect(row).toContainText(/失败|e2e/);
  });

  test('AI 审计页两个面都能出表', async ({ page }) => {
    await page.goto('/#/ai/audit');
    await expect(page).toHaveTitle(/AI 调用审计/);
    await expect(page.locator('.stat-grid .el-card').first()).toBeVisible();
    for (const tab of ['出网调用', 'AI 写入动作']) {
      await page.getByRole('tab', { name: tab }).click();
      // 两个页签的表格同时存在，未激活的那个只是 display:none —— 不加 :visible 会抓到隐藏的那个
      await expect(page.locator('.el-tab-pane:visible .el-table, .el-tab-pane:visible .el-empty').first()).toBeVisible();
    }
  });
});
