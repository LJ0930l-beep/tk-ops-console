import { describe, expect, it } from 'vitest';
import { all, get } from '../src/core/db.js';
import { IMPORT_ROW_LIMIT } from '../src/core/importer.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

/**
 * 导入中心回归（EPIC-1-02 导入半边）：
 *  B1 幂等——同业务键重复导入只更新不新增，禁止先删后插
 *  B2 逐行独立——脏行进 errors，其余照常落库，整体记「部分失败」
 *  B3 把关——目标表菜单不通 403 且不留日志；越权店铺单行拒绝
 *  B4 时间——卖家中心表格是店铺墙上时间，落库统一 UTC
 *  B5 留痕——一条 sync_log(task_type='import') + 一条 sys_op_log，能区分 web/manual
 *  B6 稳健——受限角色灌任意脏数据不出 5xx
 */

const { db, http } = boot();
const token: Record<string, string> = {};

interface ImportOut {
  total: number;
  accepted: number;
  inserted: number;
  updated: number;
  failed: number;
  status: number;
  log_id: number;
  errors: { row: number; reason: string }[];
}

async function bearer(username: string): Promise<Record<string, string>> {
  token[username] ??= await login(http, username);
  return auth(token[username]);
}

const post = async (username: string, body: Record<string, unknown>) =>
  http.post('/api/system/import').set(await bearer(username)).send(body);

const count = (table: string): number =>
  Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE is_deleted = 0`)?.c ?? 0);

const userIdOf = (username: string): number =>
  Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, username)?.id ?? 0);

/* ---------- 用现网真实数据构造外键，避免和 seed 打架 ---------- */

const shopOne = get<{ id: number; timezone: string }>(
  `SELECT id, timezone FROM tk_shop WHERE is_deleted = 0 AND owner_id = (SELECT id FROM sys_user WHERE username = 'limy')`,
)!;
const shopTwo = get<{ id: number }>(
  `SELECT id FROM tk_shop WHERE is_deleted = 0 AND id <> ? ORDER BY id`,
  shopOne.id,
)!;
const existingSku = get<{ id: number; sku_code: string }>(
  `SELECT id, sku_code FROM product_sku WHERE is_deleted = 0 AND sku_code <> '' ORDER BY id`,
)!;
const orderOne = get<{ id: number; tk_order_id: string; currency: string }>(
  `SELECT id, tk_order_id, currency FROM tk_order WHERE is_deleted = 0 AND shop_id = ? ORDER BY id`,
  shopOne.id,
)!;
const topCreator = get<{ id: number; handle: string }>(
  `SELECT id, handle FROM creator WHERE is_deleted = 0 ORDER BY followers DESC, id`,
)!;
const spuOne = get<{ id: number; spu_code: string }>(`SELECT id, spu_code FROM product_spu WHERE is_deleted = 0 ORDER BY id`)!;

describe('导入中心：元数据与模板', () => {
  it('注册表暴露六类兜底数据，并带出必填列给向导渲染', async () => {
    const res = await http.get('/api/system/import/tables').set(await bearer(ACCOUNTS.boss));
    expect(res.status).toBe(200);
    const tables = dataOf<{ table: string; label: string; menu: string; columns: { key: string; label: string; required: boolean }[] }[]>(res.body);
    expect(tables.map((t) => t.table).sort()).toEqual(
      ['creator', 'exchange_rate', 'live_session', 'shop_listing', 'tk_return', 'video'].sort(),
    );
    const creator = tables.find((t) => t.table === 'creator');
    expect(creator?.menu).toBe('creator');
    expect(creator?.columns.find((c) => c.key === 'handle')?.required).toBe(true);
    expect(creator?.columns.every((c) => c.label.length > 0)).toBe(true);
  });

  it('元数据与模板按目标表菜单把关：仓库角色只看到达人那一栏，也下不到汇率模板', async () => {
    const res = await http.get('/api/system/import/tables').set(await bearer(ACCOUNTS.warehouse));
    const tables = dataOf<{ table: string }[]>(res.body);
    expect(tables.map((t) => t.table)).toEqual(['creator']);

    const denied = await http.get('/api/system/import/template?table=exchange_rate').set(await bearer(ACCOUNTS.warehouse));
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('汇率');
    // 越权探测不留日志：GET 本身不写库，但确保没有把 403 变成 5xx
    expect((await http.get('/api/system/import/template?table=creator').set(await bearer(ACCOUNTS.warehouse))).status).toBe(200);
  });

  it('模板是带 BOM 的 CSV：中文表头 + 一行示例，列数对齐', async () => {
    const res = await http.get('/api/system/import/template?table=tk_return').set(await bearer(ACCOUNTS.boss));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="import-tk_return.csv"');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const [head, sample] = res.text.slice(1).trimEnd().split('\n');
    expect(head).toContain('售后单号');
    expect(head.split(',')).toHaveLength(sample.split(',').length);
  });

  it('未知表名 → 400，并把可用表名回给用户', async () => {
    const res = await http.get('/api/system/import/template?table=nope').set(await bearer(ACCOUNTS.boss));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('live_session');
  });
});

describe('导入中心：达人档案（幂等 + 表头兼容 + 逐行独立）', () => {
  const handle = 'import.test.creator';

  const batch = (): Record<string, unknown>[] => [
    { 达人账号: `@${handle}`, 达人昵称: '导入测试号', 国家地区: 'MY', 粉丝数: '128,000', 平均播放: '24000' },
    { unique_id: `${handle.toUpperCase()}_2`, name: '第二个', 带货等级: 'A', 内容分类: '家居,收纳' },
    { 达人昵称: '没有账号的脏行', 粉丝数: '10' },
  ];

  it('首次导入 2 成功 1 脏行；重复导入同一文件 inserted=0、全部 updated，表内行数不变', async () => {
    const before = count('creator');
    const first = await post(ACCOUNTS.bd, { table: 'creator', rows: batch() });
    expect(first.status).toBe(200);
    const a = dataOf<ImportOut>(first.body);
    expect([a.inserted, a.updated, a.failed, a.status]).toEqual([2, 0, 1, 2]);
    expect(a.errors).toEqual([{ row: 3, reason: expect.stringContaining('handle：必填') }]);
    expect(a.errors[0].reason).not.toMatch(/Invalid input|expected/i);
    expect(count('creator')).toBe(before + 2);

    const second = await post(ACCOUNTS.bd, { table: 'creator', rows: batch() });
    const b = dataOf<ImportOut>(second.body);
    expect([b.inserted, b.updated, b.failed]).toEqual([0, 2, 1]);
    expect(count('creator')).toBe(before + 2);
  });

  it('英文字段名/中文标签/别名混用都对得上；@ 与前缀大写被归一；千分位被清洗', async () => {
    const row = get<{ handle: string; followers: number; nickname: string; region: string }>(
      `SELECT handle, followers, nickname, region FROM creator WHERE is_deleted = 0 AND handle = ?`,
      handle,
    )!;
    expect(row.followers).toBe(128000);
    expect(row.nickname).toBe('导入测试号');
    expect(row.region).toBe('MY');
    const second = get<{ handle: string; avg_views: number; nickname: string; gmv_level: string }>(
      `SELECT handle, avg_views, nickname, gmv_level FROM creator WHERE is_deleted = 0 AND handle LIKE ?`,
      `${handle}%_2`,
    )!;
    expect(second.handle).toBe(`${handle}_2`.toLowerCase());
    expect([second.nickname, second.gmv_level, second.avg_views]).toEqual(['第二个', 'A', 0]);
  });

  it('只给部分列再导一次：未给出的列不被抹空（表格抓取列缺失是常态）', async () => {
    const thin = await post(ACCOUNTS.bd, { table: 'creator', rows: [{ 达人账号: `@${handle}`, 粉丝数: '130000' }] });
    expect(dataOf<ImportOut>(thin.body)).toMatchObject({ inserted: 0, updated: 1, failed: 0 });
    const after = get<{ nickname: string; followers: number }>(`SELECT nickname, followers FROM creator WHERE handle = ?`, handle)!;
    expect([after.nickname, after.followers]).toEqual(['导入测试号', 130000]);
  });

  it('一次导入留一条 sync_log + 一条 sys_op_log，能还原谁在什么来源导了什么', async () => {
    const res = await post(ACCOUNTS.bd, { table: 'creator', source: 'web', rows: [{ handle: 'import.log.check', 粉丝数: '7' }] });
    const out = dataOf<ImportOut>(res.body);
    const log = get<Record<string, unknown>>(`SELECT * FROM sync_log WHERE id = ?`, out.log_id)!;
    expect(log.task_type).toBe('import');
    expect([Number(log.fetched), Number(log.inserted), Number(log.failed), Number(log.status)]).toEqual([1, 1, 0, 1]);
    expect(Number(log.created_by)).toBe(userIdOf(ACCOUNTS.bd));

    const op = get<Record<string, unknown>>(`SELECT * FROM sys_op_log WHERE module = '导入中心' AND target_id = ?`, out.log_id)!;
    expect(op.target_table).toBe('creator');
    expect(op.action).toBe('create');
    expect(String(op.ip ?? '').length).toBeGreaterThan(0);
    const payload = JSON.parse(String(op.before_after ?? '{}'));
    expect(payload.after).toMatchObject({ table: 'creator', source: 'web', inserted: 1, failed: 0 });
  });

  it('脏行原因写进 sync_log.error_msg，同步健康页能直接看到第几行错', async () => {
    const res = await post(ACCOUNTS.bd, { table: 'creator', rows: [{ handle: 'import.reason', 粉丝数: '1' }, { 粉丝数: '2' }] });
    const out = dataOf<ImportOut>(res.body);
    const log = get<{ error_msg: string; status: number }>(`SELECT error_msg, status FROM sync_log WHERE id = ?`, out.log_id)!;
    expect(log.status).toBe(2);
    expect(log.error_msg).toContain('第 2 行');
    expect(log.error_msg).toContain('handle');
  });
});

describe('导入中心：直播场次（店铺墙上时间 → UTC + 范围把关）', () => {
  const planLocal = '2026-09-12 20:00:00';
  const row = (shop: Record<string, unknown>): Record<string, unknown> => ({
    ...shop,
    开播时间: planLocal,
    结束时间: '2026-09-12 23:10:00',
    观看人次: '8600',
    GMV: '4,380.5',
  });

  it('plan_start/actual_end 按店铺时区换算成 UTC 落库，重复导入同一场只更新', async () => {
    expect(shopOne.timezone).toBe('Asia/Kuala_Lumpur'); // UTC+8，无夏令时
    const before = count('live_session');
    const res = await post(ACCOUNTS.ops, { table: 'live_session', source: 'web', rows: [row({ 店铺ID: shopOne.id })] });
    expect(res.status).toBe(200);
    expect(dataOf<ImportOut>(res.body)).toMatchObject({ inserted: 1, failed: 0, status: 1 });
    expect(count('live_session')).toBe(before + 1);

    const stored = get<{ plan_start: string; actual_end: string; gmv: number; status: number }>(
      `SELECT plan_start, actual_end, gmv, status FROM live_session WHERE is_deleted = 0 AND shop_id = ? ORDER BY id DESC`,
      shopOne.id,
    )!;
    expect([stored.plan_start, stored.actual_end]).toEqual(['2026-09-12 12:00:00', '2026-09-12 15:10:00']);
    expect([stored.gmv, stored.status]).toEqual([4380.5, 3]);

    const again = await post(ACCOUNTS.ops, { table: 'live_session', source: 'web', rows: [row({ 店铺ID: shopOne.id })] });
    expect(dataOf<ImportOut>(again.body)).toMatchObject({ inserted: 0, updated: 1, failed: 0 });
    expect(count('live_session')).toBe(before + 1);
  });

  it('店铺填了但不InRange → 单行拒绝；完全没填 → 脏行，绝不默认落到某个店或全店', async () => {
    const before = count('live_session');
    const res = await post(ACCOUNTS.ops, {
      table: 'live_session',
      rows: [row({ 店铺ID: shopTwo.id }), row({ 店铺名称: '不存在的店' }), row({})],
    });
    expect(res.status).toBe(200);
    const out = dataOf<ImportOut>(res.body);
    expect([out.inserted, out.failed, out.status]).toEqual([0, 3, 3]);
    const reasons = out.errors.map((e) => e.reason).join('|');
    expect(reasons).toContain('数据范围');
    expect(reasons).toContain('无法定位');
    expect(count('live_session')).toBe(before);
  });

  it('SELF 范围的 BD 有 content 菜单，但一行都写不进别人的店铺', async () => {
    const res = await post(ACCOUNTS.bd, { table: 'live_session', rows: [row({ 店铺ID: shopOne.id })] });
    expect(res.status).toBe(200);
    const out = dataOf<ImportOut>(res.body);
    expect([out.inserted, out.status]).toEqual([0, 3]);
    expect(out.errors[0]?.reason).toContain('数据范围');
  });
});

describe('导入中心：在架商品与售后单（自动映射 + 关联校验）', () => {
  it('卖家SKU能对上内部编码时自动映射；对不上留待映射；缺列的重导不回退映射结果', async () => {
    const res = await post(ACCOUNTS.ops, {
      table: 'shop_listing',
      rows: [
        { "平台SKU ID": '900000001', 卖家SKU: existingSku.sku_code, 商品名称: '导入的在售品', 售价: '49.9', 在架状态: '在售', 店铺ID: shopOne.id },
        { "平台SKU ID": '900000002', 卖家SKU: 'NO-SUCH-CODE-XYZ', 售价: '19.9', 在架状态: 'DEACTIVATED', 店铺ID: shopOne.id },
      ],
    });
    expect(res.status).toBe(200);
    expect(dataOf<ImportOut>(res.body).inserted).toBe(2);
    const a = get<Record<string, unknown>>(
      `SELECT * FROM shop_listing WHERE is_deleted = 0 AND shop_id = ? AND tk_sku_id = '900000001'`,
      shopOne.id,
    )!;
    expect([Number(a.sku_id), Number(a.map_status), Number(a.listing_status)]).toEqual([existingSku.id, 1, 3]);
    const b = get<Record<string, unknown>>(
      `SELECT * FROM shop_listing WHERE is_deleted = 0 AND shop_id = ? AND tk_sku_id = '900000002'`,
      shopOne.id,
    )!;
    expect([Number(b.map_status), Number(b.listing_status)]).toEqual([2, 4]);

    const again = await post(ACCOUNTS.ops, { table: 'shop_listing', rows: [{ "平台SKU ID": '900000001', 售价: '52.9', 店铺ID: shopOne.id }] });
    expect(dataOf<ImportOut>(again.body)).toMatchObject({ inserted: 0, updated: 1 });
    const still = get<Record<string, unknown>>(
      `SELECT * FROM shop_listing WHERE is_deleted = 0 AND shop_id = ? AND tk_sku_id = '900000001'`,
      shopOne.id,
    )!;
    expect([Number(still.map_status), Number(still.sale_price), String(still.product_name)]).toEqual([1, 52.9, '导入的在售品']);
  });

  it('售后单：订单必须已在系统里，售后类型文案归一为枚举，同单号重导只更新', async () => {
    const before = count('tk_return');
    const good = {
      售后单号: 'RMA-IMPORT-001',
      订单号: orderOne.tk_order_id,
      售后类型: '退货退款',
      退款金额: '39.9',
      币种: orderOne.currency,
      店铺ID: shopOne.id,
    };
    const res = await post(ACCOUNTS.ops, {
      table: 'tk_return',
      rows: [good, { ...good, 售后单号: 'RMA-IMPORT-002', 订单号: '5799999999999' }, { 售后类型: '仅退款', 店铺ID: shopOne.id }],
    });
    const out = dataOf<ImportOut>(res.body);
    expect([out.inserted, out.failed]).toEqual([1, 2]);
    const reasons = out.errors.map((e) => e.reason).join('|');
    expect(reasons).toContain('不在系统里');
    expect(reasons).toContain('tk_return_id');
    const row001 = get<Record<string, unknown>>(`SELECT * FROM tk_return WHERE tk_return_id = 'RMA-IMPORT-001'`)!;
    expect([Number(row001.order_id), Number(row001.return_type), Number(row001.refund_amount)]).toEqual([orderOne.id, 2, 39.9]);
    expect(count('tk_return')).toBe(before + 1);

    const again = await post(ACCOUNTS.ops, { table: 'tk_return', rows: [{ ...good, 退款金额: '45.0' }] });
    expect(dataOf<ImportOut>(again.body)).toMatchObject({ inserted: 0, updated: 1 });
    expect(count('tk_return')).toBe(before + 1);
    const after = get<{ refund_amount: number }>(`SELECT refund_amount FROM tk_return WHERE tk_return_id = 'RMA-IMPORT-001'`)!;
    expect(after.refund_amount).toBe(45);
  });
});

describe('导入中心：汇率与视频', () => {
  it('币种统一大写，(日期,币种) 构成幂等键', async () => {
    const day = '2026-09-18';
    db.exec(`DELETE FROM exchange_rate WHERE rate_date = '${day}'`);
    const res = await post(ACCOUNTS.finance, {
      table: 'exchange_rate',
      rows: [
        { 日期: day, 币种: 'myr', 对人民币汇率: '1.52' },
        { rate_date: day, currency: 'PHP', rate_to_cny: '0.125' },
      ],
    });
    expect(dataOf<ImportOut>(res.body).inserted).toBe(2);
    const again = await post(ACCOUNTS.finance, { table: 'exchange_rate', rows: [{ 日期: day, 币种: 'MYR', 对人民币汇率: '1.55' }] });
    expect(dataOf<ImportOut>(again.body)).toMatchObject({ inserted: 0, updated: 1 });
    const rows = all<{ currency: string; rate_to_cny: number }>(`SELECT currency, rate_to_cny FROM exchange_rate WHERE rate_date = ?`, day);
    expect(rows.map((r) => r.currency).sort()).toEqual(['MYR', 'PHP']);
    expect(rows.find((r) => r.currency === 'MYR')?.rate_to_cny).toBe(1.55);
  });

  it('视频：只有链接也能取到视频ID，发布时间按店铺时区换算，达人与商品自动归因', async () => {
    const res = await post(ACCOUNTS.ops, {
      table: 'video',
      source: 'web',
      rows: [
        {
          视频链接: 'https://www.tiktok.com/@homereno/video/7521000000000001111',
          达人账号: `@${topCreator.handle}`,
          商品SPU编码: spuOne.spu_code,
          发布时间: '2026-09-10 20:30:00',
          播放量: '12,500',
          点赞量: '830',
          店铺ID: shopOne.id,
        },
        { 播放量: '10' },
        { 视频链接: 'https://example.com/not-a-video' },
      ],
    });
    expect(res.status).toBe(200);
    const out = dataOf<ImportOut>(res.body);
    expect([out.inserted, out.failed]).toEqual([1, 2]);
    const v = get<Record<string, unknown>>(`SELECT * FROM video WHERE tk_video_id = '7521000000000001111'`)!;
    expect(String(v.video_url)).toContain('7521000000000001111');
    expect([Number(v.views), Number(v.likes), Number(v.creator_id), Number(v.spu_id), Number(v.shop_id)]).toEqual([
      12500, 830, topCreator.id, spuOne.id, shopOne.id,
    ]);
    expect(v.publish_time).toBe('2026-09-10 12:30:00');
    expect(Number(v.publisher_type)).toBe(2);
  });

  it('抓取侧只回传指标时，已归因好的达人/商品不被抹掉；SPU 不存在则拒绝并提示先建档', async () => {
    const again = await post(ACCOUNTS.ops, { table: 'video', rows: [{ 视频ID: '7521000000000001111', 播放量: '13000' }] });
    expect(dataOf<ImportOut>(again.body)).toMatchObject({ inserted: 0, updated: 1, failed: 0 });
    const still = get<Record<string, unknown>>(`SELECT * FROM video WHERE tk_video_id = '7521000000000001111'`)!;
    expect([Number(still.views), Number(still.creator_id), Number(still.spu_id)]).toEqual([13000, topCreator.id, spuOne.id]);

    const bad = await post(ACCOUNTS.ops, { table: 'video', rows: [{ 视频ID: '7521000000000002222', 商品SPU编码: 'SPU-NOT-EXIST' }] });
    const out = dataOf<ImportOut>(bad.body);
    expect(out.inserted).toBe(0);
    expect(out.errors[0]?.reason).toContain('商品中心建档');
    const noCreator = await post(ACCOUNTS.ops, { table: 'video', rows: [{ 视频ID: '7521000000000003333', 达人账号: '@no-such-handle' }] });
    expect(dataOf<ImportOut>(noCreator.body).errors[0]?.reason).toContain('请先导入达人档案');
  });
});

describe('导入中心：权限边界与入参校验', () => {
  it('目标表菜单不通 → 403，且一条导入日志都不留', async () => {
    const logsBefore = count('sync_log');
    const opBefore = Number(get<{ m: number }>(`SELECT COALESCE(MAX(id), 0) m FROM sys_op_log`)?.m ?? 0);
    const res = await post(ACCOUNTS.ops, { table: 'exchange_rate', rows: [{ 日期: '2026-09-17', 币种: 'USD', 对人民币汇率: '7.1' }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40300);
    expect(res.body.message).toContain('汇率');
    expect(res.body.data).toBe(null);
    expect(count('sync_log')).toBe(logsBefore);
    expect(Number(get<{ m: number }>(`SELECT COALESCE(MAX(id), 0) m FROM sys_op_log`)?.m ?? 0)).toBe(opBefore);
  });

  it('未登录 401；未知表 400；空 rows 400；超行数上限 400', async () => {
    const t = await bearer(ACCOUNTS.boss);
    expect((await http.post('/api/system/import').send({ table: 'creator', rows: [{ handle: 'x' }] })).status).toBe(401);
    expect((await http.post('/api/system/import').set(t).send({ table: 'nope', rows: [{ a: 1 }] })).status).toBe(400);
    const empty = await http.post('/api/system/import').set(t).send({ table: 'creator', rows: [] });
    expect(empty.status).toBe(400);
    const tooMany = await http
      .post('/api/system/import')
      .set(t)
      .send({ table: 'creator', rows: Array.from({ length: IMPORT_ROW_LIMIT + 1 }, (_, i) => ({ handle: `over-${i}` })) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toContain(String(IMPORT_ROW_LIMIT));
  });

  it('受限角色对每张表灌任意脏数据都不出 5xx', async () => {
    const tables = ['creator', 'video', 'live_session', 'tk_return', 'shop_listing', 'exchange_rate'];
    for (const username of [ACCOUNTS.bd, ACCOUNTS.content, ACCOUNTS.warehouse]) {
      for (const table of tables) {
        const res = await post(username, {
          table,
          rows: [{ 乱填: 'xxx' }, { shop_id: '999999', handle: '   ' }, { 日期: 'not-a-date', 币种: '人民币', 对人民币汇率: 'abc' }],
        });
        expect([200, 400, 403]).toContain(res.status);
        expect(res.status).toBeLessThan(500);
      }
    }
  });

  it('source 只接受 manual / web，抓取回传与人工表格在留痕里能分开', async () => {
    const web = await post(ACCOUNTS.bd, { table: 'creator', source: 'web', rows: [{ handle: 'import.source.web' }] });
    const manual = await post(ACCOUNTS.bd, { table: 'creator', rows: [{ handle: 'import.source.manual' }] });
    const src = (logId: number) =>
      JSON.parse(String(get<{ before_after: string }>(`SELECT before_after FROM sys_op_log WHERE target_id = ?`, logId)?.before_after ?? '{}')).after.source;
    expect(src(dataOf<ImportOut>(web.body).log_id)).toBe('web');
    expect(src(dataOf<ImportOut>(manual.body).log_id)).toBe('manual');
    const bad = await post(ACCOUNTS.bd, { table: 'creator', source: 'crawler', rows: [{ handle: 'import.source.bad' }] });
    expect(bad.status).toBe(400);
  });
});
