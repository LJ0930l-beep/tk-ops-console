import { expect, type Page, test } from '@playwright/test';
import { clearMessages, lastMessage, login } from './fixtures';

/**
 * 选品流水线（方案第十一章）的界面主路径：登记 → 上架测试 → 提交结论 → 结论落地 → 清单闸门 → 正常销售。
 *
 * 为什么值得用浏览器跑一遍而不是只测接口：这一章的价值全在「闸门」上，而闸门有两层 ——
 * 表单挡在前面（缺指标 / 没写原因根本发不出去），状态机与清单挡在后面（400 文案要原样落到用户眼前）。
 * 只有点一遍才知道两层都在；清单没清完那一步特意先撞一次后端拒绝，
 * 因为「点了没反应 / 静默通过」正是这条流水线最容易烂掉的地方。
 */

/** Element Plus 的下拉：点开再挑，选项渲染在 body 下的 popper 里 */
async function pick(page: Page, label: string, option: string | RegExp): Promise<void> {
  const item = page.locator(`.el-dialog:visible .el-form-item:has(> .el-form-item__label:text-is("${label}"))`).last();
  await item.locator('.el-select').first().click();
  const dd = page.locator('.el-select-dropdown:visible').last();
  await dd.locator('.el-select-dropdown__item', { hasText: option }).first().click();
  await expect(dd).toBeHidden({ timeout: 10_000 });
}

/** el-input-number：fill 之后必须 blur，否则值还没提交进 model */
async function putNumber(page: Page, label: string, value: string): Promise<void> {
  const input = page
    .locator(`.el-dialog:visible .el-form-item:has(> .el-form-item__label:text-is("${label}"))`)
    .last()
    .locator('input')
    .first();
  await input.fill(value);
  await input.blur();
}

const field = (page: Page, label: string) =>
  page.locator(`.el-dialog:visible .el-form-item:has(> .el-form-item__label:text-is("${label}"))`).last();

/**
 * 表格行里的下拉：必须取「最后一个」popper。
 * Element Plus 的下拉是 teleport 到 body 的，上一行那个正在关闭的 popper 在过渡期里还算可见，
 * 用 first() 会点到它 —— 表现为「点了没反应」，然后超时。
 */
async function pickFirstOption(page: Page, trigger: ReturnType<Page['locator']>): Promise<void> {
  await trigger.click();
  const dd = page.locator('.el-select-dropdown:visible').last();
  await dd.locator('.el-select-dropdown__item').first().click();
  await expect(dd).toBeHidden({ timeout: 10_000 });
}

const card = (page: Page, code: string) => page.locator('.scard').filter({ hasText: code });
const act = (page: Page, code: string, name: string) => card(page, code).getByRole('button', { name });
const dialog = (page: Page) => page.locator('.el-dialog:visible').last();

/** 编号是后端生成的，前端提交后的 toast 用的是自己的文案 —— 所以回读接口拿编号，不在文案里猜 */
async function codeOf(page: Page, name: string): Promise<string> {
  const code = await page.evaluate(async (kw: string) => {
    const r = await fetch(`/api/selection?keyword=${encodeURIComponent(kw)}&page=1&pageSize=5`, {
      headers: { authorization: `Bearer ${localStorage.getItem('tk_token')}` },
    });
    const j = (await r.json()) as { data: { list: { code: string }[] } };
    return j.data.list[0]?.code ?? '';
  }, name);
  expect(code, `界面登记完却在列表里找不到「${name}」`).toBeTruthy();
  return code;
}

/** 走界面登记一个候选品，返回后端生成的候选品编号 */
async function register(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: /登记候选品/ }).click();
  await expect(dialog(page)).toBeVisible();
  await field(page, '品名').locator('input').first().fill(name);
  await putNumber(page, '采购价', '9');
  await putNumber(page, '预估毛利率', '0.4');
  await putNumber(page, '起订量', '100');
  await putNumber(page, '交货周期(天)', '5');
  await pick(page, '选品来源', '市场调研');
  await clearMessages(page);
  await dialog(page).getByRole('button', { name: /登记/ }).click();
  const msg = await lastMessage(page);
  expect(msg, `登记回执异常：${msg}`).toMatch(/已登记/);
  const code = await codeOf(page, name);
  await expect(card(page, code)).toBeVisible({ timeout: 20_000 });
  return code;
}

async function openBoard(page: Page): Promise<void> {
  await page.goto('/#/selection');
  await expect(page).toHaveTitle(/选品流水线/);
  await expect(page.locator('.board .col')).toHaveCount(5, { timeout: 20_000 });
}

test.describe('选品流水线', () => {
  test('登记 → 测试 → 结论 → 清单闸门 → 正常销售，全程走界面', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, 'boss');
    await openBoard(page);

    /* ① 登记：后端自动给候选品编号与盈亏平衡 ROAS（毛利率 0.5 ⇒ 基准 ROAS = 2） */
    const code = await register(page, `e2e 选品 ${Date.now().toString(36)}`);
    expect(await card(page, code).innerText(), '卡片应当显示停留天数与超时档位').toMatch(/停留 \d+ 天/);

    /* ② 进上架测试：必须指定测试店铺 */
    await act(page, code, '流转').click();
    await expect(dialog(page)).toBeVisible();
    await pick(page, '目标阶段', '店铺上架测试');
    await pick(page, '测试店铺', /.+/);
    await field(page, '流转说明').locator('textarea').fill('e2e 小流量测试');
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    let msg = await lastMessage(page);
    expect(msg, `流转回执异常：${msg}`).toMatch(/已流转到「店铺上架测试」/);
    await expect(card(page, code)).toBeVisible({ timeout: 20_000 });

    /* ③ 测试结论：七个指标少一个都发不出去（表单先挡），补齐后才进「测试反馈」 */
    await act(page, code, '测试结论').click();
    const concl = dialog(page);
    await expect(concl.getByText(/少一个后端都会退回/)).toBeVisible();
    await pick(page, '测试结论', '通过');
    await field(page, '结论说明').locator('textarea').fill('CTR 与转化均达基准');
    await putNumber(page, '曝光量', '9000');
    await clearMessages(page);
    await concl.getByRole('button', { name: /提交结论/ }).click();
    await expect(concl.locator('.el-form-item__error').first()).toContainText(/必填/);
    for (const [label, value] of [
      ['点击率 CTR', '0.035'],
      ['加购率', '0.06'],
      ['转化率 CVR', '0.018'],
      ['退款率', '0.02'],
      ['GMV(店铺币种)', '2100'],
      ['净利率', '0.33'],
    ] as const) {
      await putNumber(page, label, value);
    }
    await clearMessages(page);
    await concl.getByRole('button', { name: /提交结论/ }).click();
    msg = await lastMessage(page);
    expect(msg, `结论提交回执异常：${msg}`).toMatch(/测试结论已记录/);

    /* ④ 结论落地：通过 ⇒ 销售前准备 */
    await expect(card(page, code)).toBeVisible({ timeout: 20_000 });
    await act(page, code, '按结论落地').click();
    await clearMessages(page);
    await page.locator('.el-message-box:visible').getByRole('button', { name: /确认落地/ }).click();
    msg = await lastMessage(page);
    expect(msg, `结论落地回执异常：${msg}`).toMatch(/已按结论流转到「销售前准备」/);

    /* ⑤ 清单闸门：没勾完就想转正常销售，必须被后端当面拒绝并说清缺哪几项 */
    await act(page, code, '流转').click();
    await expect(dialog(page)).toBeVisible();
    await pick(page, '目标阶段', '正常销售');
    await pick(page, '关联 SPU', /.+/);
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    msg = await lastMessage(page);
    expect(msg, `清单没勾完竟然放行了：${msg}`).toMatch(/销售前准备清单未完成/);
    expect(msg).toMatch(/合规确认/);
    await dialog(page).getByRole('button', { name: /取消/ }).click();

    /* ⑥ 勾完六项（每项都要落到责任人）后才能真正上架：先勾完再指定人，
       避免勾一次重渲染一次把下一个下拉的时序打乱 */
    await act(page, code, '准备清单').click();
    const ck = dialog(page);
    const rows = ck.locator('.el-table__body tbody tr');
    await expect(rows).toHaveCount(6);
    const n = await rows.count();
    for (let i = 0; i < n; i++) await rows.nth(i).locator('.el-checkbox').first().click();
    for (let i = 0; i < n; i++) await pickFirstOption(page, rows.nth(i).locator('.el-select').first());
    await clearMessages(page);
    await ck.getByRole('button', { name: /保存清单/ }).click();
    msg = await lastMessage(page);
    expect(msg, `清单保存回执异常：${msg}`).toMatch(/清单进度 6\/6/);

    await act(page, code, '流转').click();
    await expect(dialog(page)).toBeVisible();
    await pick(page, '目标阶段', '正常销售');
    await pick(page, '关联 SPU', /.+/);
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    msg = await lastMessage(page);
    expect(msg, `转正常销售回执异常：${msg}`).toMatch(/已流转到「正常销售」/);

    /* ⑦ 收尾：看板最后一列留一格（方案 11.4：此后归商品端口管），列表里状态确实变了 */
    await expect(card(page, code)).toBeVisible({ timeout: 20_000 });
    await page.locator('input[placeholder*="品名"]').first().fill(code);
    await page.getByRole('button', { name: /查\s*询/ }).first().click();
    await page.getByRole('tab', { name: /候选品列表/ }).click();
    const row = page.locator('.el-tab-pane:visible .el-table__body tbody tr').filter({ hasText: code });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('正常销售');
  });

  test('淘汰要写原因，进淘汰池后能捞回登记', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, 'boss');
    await openBoard(page);
    const code = await register(page, `e2e 淘汰 ${Date.now().toString(36)}`);

    await act(page, code, '流转').click();
    await pick(page, '目标阶段', '淘汰池');
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    // 没写原因连请求都发不出去：表单这一层挡在前面，后端那条 400 只是兜底
    await expect(field(page, '淘汰原因').locator('.el-form-item__error')).toContainText(/淘汰必须写明原因/);
    await field(page, '淘汰原因').locator('textarea').fill('同类目三家低价内卷，无投放空间');
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    let msg = await lastMessage(page);
    expect(msg, `淘汰回执异常：${msg}`).toMatch(/已流转到「淘汰池」/);

    await page.getByRole('tab', { name: /淘汰池/ }).click();
    const dead = page.locator('.el-tab-pane:visible .el-table').first();
    await expect(dead).toBeVisible();
    const row = dead.locator('tbody tr').filter({ hasText: code });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('低价内卷');

    // 捞回登记：淘汰池不是垃圾桶，复盘后可以重跑流水线
    await row.getByRole('button', { name: /流转/ }).click();
    await pick(page, '目标阶段', '商品选品登记');
    await clearMessages(page);
    await dialog(page).getByRole('button', { name: /确认流转/ }).click();
    msg = await lastMessage(page);
    expect(msg, `捞回登记回执异常：${msg}`).toMatch(/已流转到「商品选品登记」/);
  });
});
