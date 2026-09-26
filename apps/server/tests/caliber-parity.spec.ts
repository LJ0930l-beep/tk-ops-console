/**
 * 口径同源回归（#28 宽表 + #30 汇率/退款 + 品牌服务方返点口径）
 *
 * 这一组是「同一个数在两个页面不一样」的守门用例，分叉都各有针对性：
 *  1. 宽表归日必须跟利润引擎一样按**店铺 IANA 时区**切自然日 —— 以前宽表用 substr(order_time,1,10)（UTC 日），
 *     一笔夏令时边界上的订单会同时出现在「行动中心 6/30」和「利润报表 7/1」。
 *  2. 缺汇率时金额不能被静默吞掉 —— 以前宽表乘的是裸 rateSqlExpr()，NULL 使 SUM 少算这一行；
 *     现在统一走 rateToCnyExpr / toCnySql（当日 → 更早 → 更晚 → 兜底常量），并要求可解释（rate_fallback_rows）。
 *  3. 净 GMV 只扣「已完成」退款 —— 以前 PROCESSING / REJECTED 也算退款，售后一关单历史数字就自己变大。
 *  4. 返点口径（货是品牌的，我们唯一收入是品牌返点）前后端同一个数：
 *     `rebate_cny` = 实收折 CNY × 成交时冻结的 `rebate_rate`，行级贡献毛利 = 返点 − 物流 − 达人佣金，
 *     两边都只调 shared 的 estItemProfitCny()；缺汇率时快照与报表必须落到同一个兜底价上。
 *  5. rebate_matched=0（这一行没配到品牌返点率）整行退出钱口径并只出「不计利润行数」告警 ——
 *     既不能按 0 收入混进报表（把数据缺口算成亏本生意），也不能只剔返点却把它的佣金留在达人成本里。
 *  6. 投产比的分子是**我们的返点**不是品牌的带货 GMV；毛利率 ≤ 0 时不存在盈亏平衡点，ADS_LOSS 不许报。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { breakevenRoas, collabRoi, estItemProfitCny, rebateCny, round2, statDateInZone } from '@tk/shared';
import { all, get, insert, run } from '../src/core/db.js';
import { countRateFallbacks, rebuildAnalytics, rebuildShopChannelDaily } from '../src/services/analytics.js';
import { AMOUNT_CNY, ATTRIBUTABLE_ORDER, RATE_JOIN, REFUND_JOIN, roiByCreator } from '../src/services/creator/roi.js';
import { getRate } from '../src/services/rates.js';
import { computeOrderProfit, computeProfitReport } from '../src/services/profit.js';
import { evaluateRules } from '../src/services/rules/engine.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

const LA = 'America/Los_Angeles';
let ctx: ReturnType<typeof boot>;
let bossId = 0;
let shopId = 0;
const token: Record<string, string> = {};

/** 取某笔单据在利润引擎口径下的取价（报表自然日 → 更早 → 更晚 → 兜底常量），与快照/引擎同一条链 */
const fxOf = (currency: string, time: string, timezone = LA): number => getRate(currency, statDateInZone(time, timezone)).rate;

/**
 * 造一笔带单明细的订单（返点三项按落库口径冻结），返回订单号。
 * `logisticsCny` / `commission` 分别是物流支出与达人佣金（佣金按订单币种，物流本身已是人民币）。
 * `matched: 0` 模拟「SKU 没配到品牌返点率」的行：三个冻结值全部留空。
 */
function makeOrder(opts: {
  time: string;
  currency: string;
  amount: number;
  tag: string;
  rebateRate?: number;
  logisticsCny?: number;
  commission?: number;
  matched?: 0 | 1;
  creatorId?: number | null;
}): number {
  const matched = opts.matched ?? 1;
  const rate = matched ? (opts.rebateRate ?? 0) : 0;
  // 实收折 CNY = 明细实收 × 报表自然日汇率；应收返点 = 实收折 CNY × 冻结返点率（shared 单一算法）
  const amountCny = round2(opts.amount * fxOf(opts.currency, opts.time));
  const oid = insert('tk_order', {
    shop_id: shopId,
    tk_order_id: `CAL-${opts.tag}`,
    order_status: 'COMPLETED',
    order_time: opts.time,
    currency: opts.currency,
    total_paid: opts.amount,
    is_sample_order: 0,
  });
  insert('tk_order_item', {
    order_id: oid,
    item_amount: opts.amount,
    quantity: 1,
    unit_price: opts.amount,
    creator_id: opts.creatorId ?? null,
    content_type: opts.creatorId ? 1 : 5,
    rebate_rate: rate,
    rebate_cny: rebateCny(amountCny, rate),
    logistics_cny: matched ? round2(opts.logisticsCny ?? 0) : 0,
    rebate_matched: matched,
    est_commission: opts.commission ?? 0,
  });
  return oid;
}

/** 另开一家店铺（投放/告警类用例要按店分组，不能都挤在同一个 probe 店上） */
function makeShop(name: string, ownerId: number): number {
  return insert('tk_shop', {
    shop_name: name,
    region: 'US',
    currency: 'CNY',
    timezone: LA,
    shop_type: 1,
    auth_status: 1,
    status: 1,
    owner_id: ownerId,
  });
}

/** 在指定店铺造一笔 CNY 订单（人民币单：汇率恒 1，期望值可以纯手算） */
function cnyOrder(shop: number, opts: { tag: string; time: string; amount: number; rebateRate: number; logistics: number; commission: number }): number {
  const oid = insert('tk_order', {
    shop_id: shop,
    tk_order_id: `CAL-${opts.tag}`,
    order_status: 'COMPLETED',
    order_time: opts.time,
    currency: 'CNY',
    total_paid: opts.amount,
    is_sample_order: 0,
  });
  insert('tk_order_item', {
    order_id: oid,
    item_amount: opts.amount,
    quantity: 1,
    unit_price: opts.amount,
    // 人民币单：实收折 CNY 就是实收本身，所以冻结返点 = 实收 × 返点率
    rebate_rate: opts.rebateRate,
    rebate_cny: rebateCny(opts.amount, opts.rebateRate),
    logistics_cny: opts.logistics,
    rebate_matched: 1,
    est_commission: opts.commission,
  });
  return oid;
}

/** 某店命中的 ADS_LOSS 事件证据快照 */
const adsLossEvidence = (shop: number): Record<string, number>[] =>
  all<{ evidence_json: string }>(
    `SELECT ae.evidence_json AS evidence_json FROM alert_event ae JOIN alert_rule ar ON ar.id = ae.rule_id
      WHERE ae.is_deleted = 0 AND ar.rule_code = 'ADS_LOSS' AND ae.shop_id = ?`,
    shop,
  ).map((r) => JSON.parse(r.evidence_json) as Record<string, number>);

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(ctx.http, u);
  bossId = Number(get<{ id: number }>(`SELECT id FROM sys_user WHERE username = ?`, ACCOUNTS.boss)?.id ?? 0);
  // 汇率表里彻底清空 VND：让「兜底常量」这一档必然被走到，两个页面只能靠同一套规则对齐
  run(`DELETE FROM exchange_rate WHERE currency = 'VND'`);
  shopId = insert('tk_shop', {
    shop_name: 'Caliber Probe Store',
    region: 'US',
    currency: 'USD',
    timezone: LA,
    shop_type: 1,
    auth_status: 1,
    status: 1,
    owner_id: bossId,
  });
});

describe('宽表归日与利润引擎同源（店铺 IANA 时区，含夏令时）', () => {
  it('夏令时边界订单：UTC 06:30 属于洛杉矶的昨天，宽表不能记成 UTC 日', () => {
    makeOrder({ time: '2026-07-01 06:30:00', currency: 'USD', amount: 100, tag: 'DST', rebateRate: 0.2 });
    const affected = rebuildShopChannelDaily('2026-06-25', '2026-07-05', bossId);
    expect(affected).toBeGreaterThan(0);

    const rows = ctx.db
      .prepare(`SELECT stat_date, gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND shop_id = ? AND channel <> 'ads'`)
      .all(shopId) as { stat_date: string; gmv: number }[];
    const days = rows.map((r) => r.stat_date);
    expect(days).toContain('2026-06-30');
    expect(days).not.toContain('2026-07-01');
  });

  it('同一笔订单：宽表 GMV 与订单汇总 by_day 落在同一天、同一个数', async () => {
    makeOrder({ time: '2026-08-05 06:30:00', currency: 'VND', amount: 1_000_000, tag: 'PARITY', rebateRate: 0.2 });
    rebuildShopChannelDaily('2026-08-01', '2026-08-10', bossId);

    const wide = get<{ d: string; gmv: number }>(
      `SELECT stat_date AS d, gmv FROM analytics_shop_channel_daily
        WHERE is_deleted = 0 AND shop_id = ? AND channel <> 'ads' AND stat_date BETWEEN '2026-08-01' AND '2026-08-10'
        ORDER BY stat_date DESC LIMIT 1`,
      shopId,
    );
    const laDay = '2026-08-04'; // 06:30 UTC = 洛杉矶 08-04 23:30（PDT = UTC-7）
    expect(wide?.d).toBe(laDay);

    // 订单汇总接口的 by_day（tz_day 口径）必须与宽表同日同数
    const sum = dataOf<{ by_day: { stat_date: string; gmv_cny: number }[] }>(
      (await ctx.http.get(`/api/orders/summary?shop_id=${shopId}&order_time_from=2026-08-01&order_time_to=2026-08-10`).set(auth(token.boss))).body,
    );
    const dayRow = sum.by_day.find((r) => r.stat_date === laDay);
    expect(dayRow, `订单汇总里没有 ${laDay} 这一天，说明两个口径又分叉了`).toBeTruthy();
    expect(Number(dayRow?.gmv_cny)).toBeCloseTo(1000000 * 0.00029, 2); // VND 兜底常量
    expect(Math.abs(Number(dayRow?.gmv_cny) - Number(wide?.gmv))).toBeLessThan(0.01);
  });
});

describe('缺汇率不再静默吞金额', () => {
  it('宽表：币种既无当日价也无常量兜底时按 1 计价，金额不再变成 NULL 被 SUM 丢掉', () => {
    run(`DELETE FROM exchange_rate WHERE currency = 'XAF'`);
    makeOrder({ time: '2026-09-03 02:00:00', currency: 'XAF', amount: 500, tag: 'XAF', rebateRate: 0.2 });
    rebuildShopChannelDaily('2026-09-01', '2026-09-05', bossId);
    const row = get<{ gmv: number }>(
      `SELECT gmv FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND shop_id = ? AND stat_date = '2026-09-02' AND channel <> 'ads'`,
      shopId,
    );
    expect(Number(row?.gmv ?? 0)).toBeCloseTo(500, 2);
  });

  it('重建会数出「走了兜底」的单据数（PRD §6.1：汇率缺失必须可解释）', () => {
    const outcome = rebuildAnalytics({ id: bossId }, { start: '2026-08-01', end: '2026-09-05' });
    expect(outcome.rate_fallback_rows).toBeGreaterThanOrEqual(2);
    expect(countRateFallbacks('2026-08-01', '2026-09-05')).toBe(outcome.rate_fallback_rows);
    // 部分失败的批次要在同步日志上看得见，不能报「成功」
    const log = get<{ status: number; failed: number }>(`SELECT status, failed FROM sync_log WHERE id = ?`, outcome.sync_log_id);
    expect(Number(log?.status)).toBe(2);
    expect(Number(log?.failed)).toBeGreaterThan(0);
  });

  it('达人 ROI 表达式与宽表同档：缺价时按兜底常量而不是 1:1 假装有数', () => {
    const row = get<{ gmv_cny: number }>(
      `SELECT ROUND(SUM(${AMOUNT_CNY}), 2) AS gmv_cny
         FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id
         ${RATE_JOIN} ${REFUND_JOIN}
        WHERE ${ATTRIBUTABLE_ORDER} AND o.shop_id = ? AND o.currency = 'VND'`,
      shopId,
    );
    // 1,000,000 VND × 兜底 0.00029 = 290（老写法会乘 NULL 变成 0/NULL）
    expect(Number(row?.gmv_cny)).toBeCloseTo(290, 2);
  });
});

describe('净 GMV 只扣已完成退款', () => {
  it('PROCESSING 的售后不影响净 GMV，转 COMPLETED 后才扣', async () => {
    const oid = makeOrder({ time: '2026-09-04 02:00:00', currency: 'USD', amount: 100, tag: 'REFUND', rebateRate: 0.2 });
    const summaryOf = async (): Promise<{ gmv: number; net: number }> => {
      const res = await ctx.http.get(`/api/orders/summary?shop_id=${shopId}&order_time_from=2026-06-01&order_time_to=2026-12-31`).set(auth(token.boss));
      expect(res.status).toBe(200);
      const d = dataOf<{ totals: { gmv_cny: number; net_gmv_cny: number } }>(res.body);
      return { gmv: Number(d?.totals?.gmv_cny), net: Number(d?.totals?.net_gmv_cny) };
    };
    const before = await summaryOf();

    const retId = insert('tk_return', {
      order_id: oid,
      shop_id: shopId,
      tk_return_id: 'CAL-RET-PROCESSING',
      tk_order_item_id: Number(get<{ id: number }>(`SELECT id FROM tk_order_item WHERE order_id = ?`, oid)?.id ?? 0),
      return_type: 1,
      refund_amount: 60,
      currency: 'USD',
      status: 'PROCESSING',
      apply_time: '2026-09-04 03:00:00',
    });
    const processing = await summaryOf();
    expect(processing.net).toBeCloseTo(before.net, 2); // 未完成的退款不许改历史数字

    run(`UPDATE tk_return SET status = 'COMPLETED' WHERE id = ?`, retId);
    const done = await summaryOf();
    expect(done.net).toBeLessThan(processing.net);
    expect(processing.net - done.net).toBeGreaterThan(0);
  });
});

describe('返点口径前后端同源（贡献毛利 = 返点 − 物流 − 达人佣金）', () => {
  it('同一行明细：利润引擎的毛利与前端 estItemProfitCny 是同一个数，且都基于冻结返点', () => {
    // 人民币单（汇率恒 1）：实收 1000，返点率 0.18 → 应收返点 1000 × 0.18 = 180
    // 贡献毛利 = 返点 180 − 物流 7 − 达人佣金 60 = 113
    const oid = makeOrder({ time: '2026-03-10 12:00:00', currency: 'CNY', amount: 1000, tag: 'MARGIN', rebateRate: 0.18, logisticsCny: 7, commission: 60 });
    const front = estItemProfitCny({
      item_amount: 1000,
      currency: 'CNY',
      rebate_rate: 0.18,
      logistics_cny: 7,
      est_commission: 60,
      commission_currency: 'CNY',
      rate_to_cny: 1,
    });
    expect(front).toBe(113); // 180 − 7 − 60

    const b = computeOrderProfit(oid);
    expect(b.items[0].rebate_cny).toBe(180);
    expect(b.items[0].logistics_cny).toBe(7);
    expect(b.items[0].commission_cny).toBe(60);
    expect(b.items[0].gross_profit_cny).toBe(front);
    // 这一单当日无投放无费用 → 净利 = 毛利 = 113；平台结算款是品牌的钱，不许再加进利润
    expect(b.rebate_cny).toBe(180);
    expect(b.profit_cny).toBe(113);
    expect(b.settled_amount_cny).toBe(0);
  });

  it('返点快照与报表同一条取价链：缺汇率的币种两边都按兜底常量算出同一个返点', () => {
    // 1,000,000 VND 在洛杉矶日落 2026-08-04；VND 已被清空 → 兜底 0.00029
    // 实收折 CNY = 1,000,000 × 0.00029 = 290；应收返点 = 290 × 0.2 = 58
    const rep = computeProfitReport({ dim: 'shop', start: '2026-08-04', end: '2026-08-04', shopIds: [shopId] });
    const row = rep.list.find((r) => r.dim_key === `S${shopId}`);
    expect(row?.gmv).toBe(290);
    expect(row?.rebate).toBe(58);
    expect(get<{ rebate_cny: number }>(`SELECT rebate_cny FROM tk_order_item i JOIN tk_order o ON o.id = i.order_id WHERE o.tk_order_id = 'CAL-PARITY'`)?.rebate_cny).toBe(58);
    // 汇率缺失必须被报出来，而不是让 58 这个数看起来理所当然
    expect(rep.warn.rate_missing).toBe(true);
    expect(rep.warn.rate_missing_currencies).toContain('VND');
    expect(rep.rate_missing).toBe(true);
  });

  it('改 SKU 的当前返点率不回写已冻结明细，报表仍按成交时的比率', () => {
    // 明细冻结 0.18：实收 500 × 0.18 = 90（物流 3、佣金 0 → 毛利 87）
    const oid = makeOrder({ time: '2026-03-16 12:00:00', currency: 'CNY', amount: 500, tag: 'FREEZE', rebateRate: 0.18, logisticsCny: 3, commission: 0 });
    const skuId = insert('product_sku', { spu_id: Number(get<{ id: number }>(`SELECT id FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 1`)?.id), sku_code: 'CAL-FREEZE', rebate_rate: 0.18, logistics_cost: 3 });
    run(`UPDATE tk_order_item SET sku_id = ? WHERE order_id = ?`, skuId, oid);

    run(`UPDATE product_sku SET rebate_rate = 0.9, logistics_cost = 88 WHERE id = ?`, skuId);
    const b = computeOrderProfit(oid);
    expect(b.items[0].rebate_rate).toBe(0.18); // 读的是冻结列，不是 SKU 当前值
    expect(b.rebate_cny).toBe(90); // 500 × 0.18，若回查 SKU 会变成 500 × 0.9 = 450
    expect(b.logistics_cny).toBe(3); // 冻结值，若回查 SKU 会变成 88
    expect(b.profit_cny).toBe(87); // 90 − 3 − 0
    // 明细挂上 SKU 后重算也不许被 SKU 的当前值改写（SKU 留着：订单行还引用它，删了会撞外键）
    run(`UPDATE product_sku SET rebate_rate = 0.18, logistics_cost = 3 WHERE id = ?`, skuId);
  });

  it('看板的毛利率分母是我们的返点，不是品牌 GMV（est_cost 已被返点/物流两列取代）', async () => {
    const d = dataOf<{ est_rebate: number; est_logistics: number; est_gross_profit: number; est_profit_rate: number; gmv: number; est_cost?: number }>(
      (await ctx.http.get('/api/dashboard/summary?start=2026-03-10&end=2026-03-10').set(auth(token.boss))).body,
    );
    expect(d.est_rebate).toBe(180); // 1000 × 0.18
    expect(d.est_logistics).toBe(7);
    expect(d.est_gross_profit).toBe(113); // 180 − 7 − 60
    // 留存率 = 毛利 ÷ 我们的收入 = 113 ÷ 180 = 62.78%
    expect(d.est_profit_rate).toBe(62.78);
    // 老口径会把分母换成带货 GMV：113 ÷ 1000 = 11.3%，看着像"这生意只赚一成"，其实我们留下六成
    expect(d.est_profit_rate).not.toBe(11.3);
    expect(d.gmv).toBe(1000);
    expect(d.est_cost, 'est_cost 是采购口径的字段，新口径下不该再出现在看板上').toBeUndefined();
  });
});

describe('未配返点率的行：不计钱口径，但必须计告警（要点 1）', () => {
  it('rebate_matched=0 的行不进利润报表任何金额，却出现在「不计利润行数」里', async () => {
    // 配对齐的一行：实收 1000 × 0.18 = 返点 180，物流 7，佣金 60 → 利润 113
    makeOrder({ time: '2026-03-11 12:00:00', currency: 'CNY', amount: 1000, tag: 'OK-ROW', rebateRate: 0.18, logisticsCny: 7, commission: 60 });
    // 没配返点率的一行：实收 500 —— 既不能按 0 返点混进报表，也不能把它当亏损
    makeOrder({ time: '2026-03-11 13:00:00', currency: 'CNY', amount: 500, tag: 'NO-RATE', matched: 0 });

    const res = await ctx.http
      .get(`/api/finance/profit/report?dim=shop&shop_id=${shopId}&start=2026-03-11&end=2026-03-11`)
      .set(auth(token.boss));
    expect(res.status).toBe(200);
    const d = dataOf<{
      list: { dim_key: string; unmapped_items: number; unmapped_amount_cny: number }[];
      total: { gmv: number; rebate: number; logistics: number; commission: number; profit: number; orders: number; unmapped_items: number; unmapped_amount_cny: number };
      warn: { unmapped_items: number; unmapped_amount_cny: number; unmapped_amount_src: number; unmapped_orders: number };
    }>(res.body);

    // 只有配了返点率的那一单进统计：GMV 1000（不是 1500）、返点 180、物流 7、佣金 60、利润 113
    expect(d.total.gmv).toBe(1000);
    expect(d.total.rebate).toBe(180);
    expect(d.total.logistics).toBe(7);
    expect(d.total.commission).toBe(60);
    expect(d.total.profit).toBe(113);
    expect(d.total.orders).toBe(1);
    // 但这一行必须被数出来：漏映射时运营看到的必须是「有 1 行没算」，不是「一切正常」
    expect(d.warn.unmapped_items).toBe(1);
    expect(d.warn.unmapped_orders).toBe(1);
    expect(d.warn.unmapped_amount_src).toBe(500);
    expect(d.warn.unmapped_amount_cny).toBe(500);
    expect(d.total.unmapped_items).toBe(1);
    expect(d.total.unmapped_amount_cny).toBe(500);
    expect(d.list.find((r) => r.dim_key === `S${shopId}`)?.unmapped_items).toBe(1);
  });

  it('整单只有未配返点率行时退出统计并留 excluded 说明，不产出一条 0 收入利润', () => {
    // CAL-NO-RATE 那一单（实收 500，无返点率）单独看：GMV/返点/利润全部不计，只出未映射金额
    const facts = computeProfitReport({ dim: 'all', start: '2026-03-11', end: '2026-03-11', shopIds: [shopId] });
    expect(facts.total.gmv).toBe(1000);
    expect(facts.total.profit).toBe(113);
    expect(facts.warn.unmapped_items).toBe(1);
    const rep = computeProfitReport({ dim: 'shop', start: '2026-03-11', end: '2026-03-11', shopIds: [shopId] });
    expect(rep.list).toHaveLength(1); // 只剩有返点的那一店一行；整单未映射的店行不成立
  });

  it('达人 ROI 侧同样整行退出：没配返点率的行不许只剔返点却把佣金记成达人成本', () => {
    const creatorId = insert('creator', { handle: 'caliber-unmapped', nickname: '未映射行达人', region: 'US' });
    // 这一行实收 800、佣金 120，但 SKU 没配到返点率 → 按口径整行退出（利润引擎即如此）
    makeOrder({ time: '2026-03-12 12:00:00', currency: 'CNY', amount: 800, tag: 'ROI-NOMAP', matched: 0, commission: 120, creatorId });

    const profitRow = computeProfitReport({ dim: 'creator', start: '2026-03-12', end: '2026-03-12', shopIds: [shopId] }).list.find((r) => r.dim_key === `C${creatorId}`);
    expect(profitRow, '整行未配返点率的达人不该出现在利润报表的达人维度里').toBeUndefined();

    const roi = roiByCreator({ period: { from: '2026-03-12', to: '2026-03-12', days: 1 }, limit: 500 }).find((r) => r.creator_id === creatorId);
    expect(roi, 'ROI 榜里出现了一个我们根本收不到钱的达人，说明两侧口径分叉了').toBeTruthy();
    // 与利润引擎同源：这一行的佣金也不能算成达人的投入（否则 ROI 被单向压低，见 roi.ts 文件头自述的理由）。
    // ⚠ 本条断言目前是红的：src/services/creator/roi.ts:145 的 `SUM(COMMISSION_CNY)` 没带 rebate_matched 过滤，
    //    与 profit.ts loadFacts（未映射行 continue，佣金一并剔除）和 analytics.ts rebuildCreatorDaily
    //    （commission 走 REBATE_OK 分支）两套同源实现都不一致 —— 修 roi.ts，不要放宽这里。
    expect(Number(roi?.rebate_cny)).toBe(0);
    expect(Number(roi?.commission_cny)).toBe(0);
    expect(roi?.roi ?? null).toBeNull();
  });
});

describe('投产比分子是返点不是 GMV', () => {
  it('带货额大的达人投产比排在带货额小的达人之后：分子用应收返点', () => {
    // 达人 A：带货 10000，返点率 1% → 返点 10000 × 0.01 = 100；投入 = 物流 20 + 佣金 80 = 100 → ROI 100/100 = 1
    const aId = insert('creator', { handle: 'caliber-big-gmv', nickname: '大带货低返点', region: 'US' });
    // 达人 B：带货 1000，返点率 30% → 返点 1000 × 0.3 = 300；投入 = 物流 5 + 佣金 60 = 65 → ROI 300/65 = 4.62
    const bId = insert('creator', { handle: 'caliber-small-gmv', nickname: '小带货高返点', region: 'US' });
    makeOrder({ time: '2026-03-13 12:00:00', currency: 'CNY', amount: 10000, tag: 'ROI-A', rebateRate: 0.01, logisticsCny: 20, commission: 80, creatorId: aId });
    makeOrder({ time: '2026-03-13 13:00:00', currency: 'CNY', amount: 1000, tag: 'ROI-B', rebateRate: 0.3, logisticsCny: 5, commission: 60, creatorId: bId });

    const rows = roiByCreator({ period: { from: '2026-03-13', to: '2026-03-13', days: 1 }, limit: 500 });
    const a = rows.find((r) => r.creator_id === aId);
    const b = rows.find((r) => r.creator_id === bId);
    expect(a && b).toBeTruthy();
    expect(Number(a?.gmv_cny)).toBe(10000);
    expect(Number(b?.gmv_cny)).toBe(1000);
    expect(Number(a?.rebate_cny)).toBe(100);
    expect(Number(b?.rebate_cny)).toBe(300);
    expect(Number(a?.cost)).toBe(100); // 20 + 80
    expect(Number(b?.cost)).toBe(65); // 5 + 60
    expect(a?.roi).toBeCloseTo(1, 2); // 100 ÷ 100
    expect(b?.roi).toBeCloseTo(4.62, 2); // 300 ÷ 65 = 4.6153…
    // 带货额排序会把 A 放前面，但「谁值得我们投入」必须按返点投产比排：B > A
    expect(Number(a?.gmv_cny)).toBeGreaterThan(Number(b?.gmv_cny));
    expect(Number(a?.roi)).toBeLessThan(Number(b?.roi));
    // 与前端共用同一个函数（shared/collabRoi），不是 SQL 里另算一套
    expect(b?.roi).toBe(collabRoi({ rebate_cny: 300, sample_shipping: 0, fixed_fee_cny: 0, commission_cny: 60, logistics_cny: 5 }));
    // 老口径（分子用带货 GMV）会得到 A = 10000/100 = 100、B = 1000/65 ≈ 15.38，亏钱的 A 会被排到榜首
    // —— 下面这两个不等式就是防它回潮：换算法后排名必须整体反过来
    expect(10000 / 100).toBeGreaterThan(1000 / 65);
    expect(Number(a?.roi)).toBeLessThan(Number(b?.roi));
  });
});

describe('盈亏平衡 ROAS：毛利率 ≤ 0 就没有平衡点', () => {
  it('shared 层：毛利率为正才是 1/毛利率，0 与负数一律 null', () => {
    expect(breakevenRoas(0.2)).toBe(5); // 1 / 0.2
    expect(breakevenRoas(0.125)).toBe(8); // 1 / 0.125
    expect(breakevenRoas(0)).toBeNull();
    expect(breakevenRoas(-0.02)).toBeNull();
  });

  it('ADS_LOSS：负毛利率的店铺不报「低于盈亏线」，正毛利率的照常报且平衡线可复算', () => {
    // 店 N：实收 1000，返点 1000 × 0.18 = 180，物流 100，佣金 100 → 毛利 −20，毛利率 −20/1000 = −0.02 → 无平衡点
    const shopN = makeShop('Caliber Negative Margin', bossId);
    cnyOrder(shopN, { tag: 'ADS-N', time: '2026-03-20 12:00:00', amount: 1000, rebateRate: 0.18, logistics: 100, commission: 100 });
    insert('ad_daily', { stat_date: '2026-03-20', shop_id: shopN, campaign_id: 'CAL-N', ad_type: 1, spend: 1000, gmv: 500, currency: 'CNY' });
    // 店 P：实收 1000，返点 1000 × 0.2 = 200，物流 0，佣金 0 → 毛利率 200/1000 = 0.2 → 平衡 ROAS = 1/0.2 = 5
    const shopP = makeShop('Caliber Positive Margin', bossId);
    cnyOrder(shopP, { tag: 'ADS-P', time: '2026-03-20 12:00:00', amount: 1000, rebateRate: 0.2, logistics: 0, commission: 0 });
    insert('ad_daily', { stat_date: '2026-03-20', shop_id: shopP, campaign_id: 'CAL-P', ad_type: 1, spend: 100, gmv: 300, currency: 'CNY' });

    const outcome = evaluateRules({ end: '2026-03-20' });
    // 规则评估器自己不能炸（炸了会被记进 errors 并静默地"一条都不命中"）
    expect(outcome.errors.find((e) => e.rule_code === 'ADS_LOSS')).toBeUndefined();

    // ROAS = 300/100 = 3 < 5 → 落在盈亏线下（3/5 = 0.6 < 1）
    const hit = adsLossEvidence(shopP);
    expect(hit).toHaveLength(1);
    expect(Number(hit[0].roas)).toBeCloseTo(3, 2);
    expect(Number(hit[0].contribution_margin)).toBeCloseTo(0.2, 4);
    expect(Number(hit[0].breakeven_roas)).toBeCloseTo(5, 2);
    // N 店 ROAS = 500/1000 = 0.5，看着更差，但毛利率是负的：拿 1/负毛利率 当平衡线会报出一个永远达不到的假指标
    expect(adsLossEvidence(shopN)).toHaveLength(0);
  });
});
