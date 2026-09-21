/**
 * 投放中心（方案 6.2 投放 + 表 18 ad_daily）
 *
 * 四条口径（金额一律人民币出报表）：
 *  1. ad_daily.spend / gmv 存的是店铺投放币种，报表按 stat_date 当天的落库牌价折 CNY；
 *     取不到当日价就用该币种最近一条，再取不到用兜底常量并标 rate_missing（与利润引擎共用 rates.ts）。
 *  2. stat_date 已是平台侧自然日，这里不再二次切日；站点时区切日发生在订单侧（services/profit.ts）。
 *  3. ROI = 广告 GMV / 花费（shared 的 adRoi），花费为 0 时 roi=null，绝不返回 Infinity / 除零。
 *  4. 广告费进利润报表的「按 video/spu 归集、归不到按店铺当日 GMV 占比分摊」在 services/profit.ts 做，
 *     本模块只出投放视角（花费、曝光点击、广告 GMV、ROI），不重复实现第二套利润口径。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { adRoi, num, round2, type CurrentUser } from '@tk/shared';
import { all, get, insert, tx, update } from '../core/db.js';
import { badRequest, forbidden, notFound, ok, parseBody, paginate, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { canAccessShop, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
import { exportFormat, sendTable } from '../core/export.js';
import { AD_GROUP_DIMS, AD_TYPE_LABEL, adMetrics, resolveRange, type AdGroupDim } from '../services/profit.js';
import { createRateConverter, rateDay, toCnySql } from '../services/rates.js';
import { runAggregates } from '../services/aggregate.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

/** 花费/产出折人民币的 SQL 片段（按投放自然日取价，与 JS 侧共用兜底常量） */
const SPEND_CNY = toCnySql('a.spend', 'a.currency', 'a.stat_date');
const AD_GMV_CNY = toCnySql('a.gmv', 'a.currency', 'a.stat_date');

const GROUP_LABEL: Record<AdGroupDim, string> = {
  campaign: '广告计划',
  shop: '店铺',
  ad_type: '投放类型',
  spu: '商品 SPU',
  video: '视频素材',
  date: '自然日',
  creator: '达人',
};

/** 行级派生指标：所有比率都从人民币金额算，避免原币与 CNY 混着算出两个 ROI */
function derived(r: Record<string, number | string | null>): Record<string, number | string | null> {
  const spend = num(r.spend_cny);
  const gmv = num(r.gmv_cny);
  return {
    ...r,
    spend_cny: spend,
    gmv_cny: gmv,
    roi: adRoi(spend, gmv),
    ctr: num(r.impressions) > 0 ? round2((num(r.clicks) / num(r.impressions)) * 100) : 0,
    cvr: num(r.clicks) > 0 ? round2((num(r.conversions) / num(r.clicks)) * 100) : 0,
    cpm: num(r.impressions) > 0 ? round2((spend / num(r.impressions)) * 1000) : 0,
    cpc: num(r.clicks) > 0 ? round2(spend / num(r.clicks)) : 0,
    cost_per_order: num(r.conversions) > 0 ? round2(spend / num(r.conversions)) : 0,
  };
}

/** 区间入参归一：start/end 与 stat_date_from/to 与 from/to 三种写法都接（PRD §3.7） */
function adRangeInput(req: Request): { from?: string; to?: string } {
  return {
    from: qv(req, 'start') ?? qv(req, 'from') ?? qv(req, 'stat_date_from'),
    to: qv(req, 'end') ?? qv(req, 'to') ?? qv(req, 'stat_date_to'),
  };
}

function adQuery(req: Request): { q: Q; shopIds: number[] } {
  const user = current(req);
  const scope = shopScope(user, 'a.shop_id');
  const input = adRangeInput(req);
  const shopIds = (qv(req, 'shop_ids') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const picked = Number(qv(req, 'shop_id') ?? 0);
  if (picked > 0 && !shopIds.includes(picked)) shopIds.push(picked);
  if (shopIds.some((id) => !canAccessShop(user, id))) throw forbidden('存在不在你的数据范围内的店铺');
  const q = new Q('a.is_deleted = 0')
    .and(scope.sql || '', ...scope.params)
    .and(shopIds.length ? 'a.shop_id IN (' + shopIds.map(() => '?').join(',') + ')' : '', ...shopIds)
    .eq('a.ad_type', qv(req, 'ad_type'))
    .eq('a.advertiser_id', qv(req, 'advertiser_id'), false)
    .eq('a.campaign_id', qv(req, 'campaign_id'), false)
    .eq('a.spu_id', qv(req, 'spu_id'))
    .eq('a.video_id', qv(req, 'video_id'))
    .eq('a.stat_date', qv(req, 'date'), false)
    // PRD §3.7 筛选项是 stat_date_from/to；from/to 作为简写一并接受（前端 AdDaily.vue 用全称）
    .between('a.stat_date', input.from, input.to)
    .like(`a.campaign_name LIKE ? OR a.campaign_id LIKE ?`, qv(req, 'keyword'));
  return { q, shopIds };
}

/** 给 adMetrics 用的过滤器：与列表共用同一份店铺范围与区间解析，避免口径分叉 */
function adFilter(req: Request) {
  const { shopIds } = adQuery(req);
  const user = current(req);
  const input = adRangeInput(req);
  const range = resolveRange({ user, start: input.from, end: input.to });
  return { user, shopIds: shopIds.length ? shopIds : undefined, start: range.start, end: range.end };
}

function groupBy(req: Request, fallback: AdGroupDim): AdGroupDim {
  const raw = qv(req, 'group_by') ?? fallback;
  if (!(AD_GROUP_DIMS as readonly string[]).includes(raw)) throw badRequest(`group_by 只支持 ${AD_GROUP_DIMS.join(' / ')}`);
  return raw as AdGroupDim;
}

export const adsRouter = Router();

/* ==================== 广告日报明细 ==================== */

const AD_FROM = `ad_daily a
       JOIN tk_shop s ON s.id = a.shop_id
       LEFT JOIN product_spu sp ON sp.id = a.spu_id
       LEFT JOIN video v ON v.id = a.video_id
       LEFT JOIN creator c ON c.id = v.creator_id`;
const AD_SELECT = `a.*, s.shop_name, s.region, sp.name_cn AS spu_name, sp.spu_code,
       v.tk_video_id, c.handle AS creator_handle,
       ROUND(${SPEND_CNY}, 2) AS spend_cny, ROUND(${AD_GMV_CNY}, 2) AS gmv_cny`;

adsRouter.get(
  '/daily',
  requireMenu('ads'),
  wrap((req, res) => {
    const { q } = adQuery(req);
    const page = queryPage(req, { from: AD_FROM, select: AD_SELECT, q, orderBy: 'a.stat_date DESC, a.spend DESC, a.id DESC' });
    const list = (page.list as Record<string, number | string | null>[]).map((r) => ({
      ...derived(r),
      ad_type_name: AD_TYPE_LABEL[num(r.ad_type)] ?? `类型${num(r.ad_type)}`,
    }));
    const agg = get<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS rows, IFNULL(ROUND(SUM(${SPEND_CNY}), 2), 0) AS spend_cny,
              IFNULL(ROUND(SUM(${AD_GMV_CNY}), 2), 0) AS gmv_cny,
              IFNULL(SUM(a.impressions), 0) AS impressions, IFNULL(SUM(a.clicks), 0) AS clicks,
              IFNULL(SUM(a.conversions), 0) AS conversions, COUNT(DISTINCT a.stat_date) AS days
         FROM ${AD_FROM}${q.whereSql}`,
      ...q.params,
    );
    ok(res, { ...page, list, summary: derived(agg ?? { rows: 0 }) });
  }),
);

/** 分组汇总：campaign / shop / ad_type / spu / video / creator / date */
adsRouter.get(
  '/summary',
  requireMenu('ads'),
  wrap((req, res) => {
    const dim = groupBy(req, 'campaign');
    const out = adMetrics({ ...adFilter(req), group_by: dim });
    ok(res, { group_by: dim, group_label: GROUP_LABEL[dim], ...out });
  }),
);

/** 投产榜：ROI 从高到低（order=worst 反向），可按最低花费过滤脏数据 */
adsRouter.get(
  '/roi/rank',
  requireMenu('ads'),
  wrap((req, res) => {
    const dim = groupBy(req, 'campaign');
    const minSpend = Number(qv(req, 'min_spend') ?? 0) || 0;
    const limitRaw = Number(qv(req, 'limit') ?? 20);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 20;
    const order = qv(req, 'order') === 'worst' ? 'worst' : 'best';
    const out = adMetrics({ ...adFilter(req), group_by: dim });
    const picked = out.list
      .filter((r) => r.spend >= minSpend)
      .sort((a, b) => {
        const av = a.roi === null ? -1 : a.roi;
        const bv = b.roi === null ? -1 : b.roi;
        return order === 'worst' ? av - bv || a.spend - b.spend : bv - av || b.spend - a.spend;
      });
    ok(res, {
      group_by: dim,
      group_label: GROUP_LABEL[dim],
      order,
      min_spend: minSpend,
      start: out.range.start,
      end: out.range.end,
      anchored: out.range.anchored,
      list: picked.slice(0, limit),
      best: picked[0] ?? null,
      worst: picked.length ? picked[picked.length - 1] : null,
      total: out.total,
    });
  }),
);

/** 投放趋势：按自然日的花费/广告 GMV/ROI 序列，by_shop=1 时附分店曲线 */
adsRouter.get(
  '/trend',
  requireMenu('ads'),
  wrap((req, res) => {
    const filter = adFilter(req);
    const daily = adMetrics({ ...filter, group_by: 'date' });
    const rows = daily.list.map((r) => ({
      date: r.date ?? r.group_key,
      spend: r.spend,
      gmv: r.gmv,
      roi: r.roi,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      ctr: r.ctr,
      cvr: r.cvr,
      cpm: r.cpm,
      cpc: r.cpc,
      cost_per_order: r.cost_per_order,
    }));
    ok(res, {
      start: daily.range.start,
      end: daily.range.end,
      anchored: daily.range.anchored,
      rows,
      total: daily.total,
      by_shop:
        qv(req, 'by_shop') === '1'
          ? adMetrics({ ...filter, group_by: 'shop' }).list.map((r) => ({
              shop_id: r.shop_id,
              shop_name: r.group_name,
              spend: r.spend,
              gmv: r.gmv,
              roi: r.roi,
            }))
          : undefined,
    });
  }),
);

/** 投放类型字典（前端下拉用，不把魔法数字抄到前端） */
adsRouter.get(
  '/types',
  requireMenu('ads'),
  wrap((_req, res) => {
    ok(res, Object.entries(AD_TYPE_LABEL).map(([k, v]) => ({ ad_type: Number(k), name: v })));
  }),
);

/* ==================== 广告数据导入（唯一键：店铺+计划+日期+类型） ==================== */

const adImportRow = z.object({
  stat_date: z.string().min(10).max(20),
  shop_id: z.number().int().positive().optional(),
  tk_shop_id: z.string().max(64).optional(),
  advertiser_id: z.string().max(64).nullish(),
  campaign_id: z.string().max(64).nullish(),
  campaign_name: z.string().max(200).nullish(),
  ad_type: z.number().int().min(1).max(4).optional(),
  spu_id: z.number().int().positive().nullish(),
  spu_code: z.string().max(64).nullish(),
  video_id: z.number().int().positive().nullish(),
  tk_video_id: z.string().max(64).nullish(),
  spend: z.number().min(0),
  currency: z.string().length(3).optional(),
  impressions: z.number().int().min(0).optional(),
  clicks: z.number().int().min(0).optional(),
  conversions: z.number().int().min(0).optional(),
  gmv: z.number().min(0).optional(),
});

const findId = (sql: string, val: unknown): number | null => {
  if (val === null || val === undefined || val === '') return null;
  const row = get<{ id: number }>(sql, String(val));
  return row ? Number(row.id) : null;
};

interface AdImportResult {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  invalid: { index: number; reason: string }[];
  ids: number[];
}

/**
 * 广告日报落库（导入与手工补录共用同一条通道）：
 * 同一 (shop_id, campaign_id, stat_date, ad_type) 命中 ux_ad_daily 时只更新指标，
 * 不产生第二条流水 —— 平台账单重跑不能把花费算两遍。
 */
function applyAdRows(user: CurrentUser, rows: z.infer<typeof adImportRow>[], overwrite = true): AdImportResult & { rate_missing: string[] } {
  const userId = user.id;
  const conv = createRateConverter();
  const out: AdImportResult = { total: rows.length, inserted: 0, updated: 0, skipped: 0, invalid: [], ids: [] };
  const missing = new Set<string>();
  tx(() => {
    rows.forEach((r, index) => {
      const shopId = r.shop_id ?? findId(`SELECT id FROM tk_shop WHERE is_deleted = 0 AND tk_shop_id = ?`, r.tk_shop_id);
      if (!shopId) return void out.invalid.push({ index, reason: 'shop_id / tk_shop_id 无法定位店铺' });
      if (!canAccessShop(user, Number(shopId))) return void out.invalid.push({ index, reason: `店铺 ${shopId} 不在你的数据范围内` });
      const statDate = rateDay(r.stat_date);
      if (!statDate) return void out.invalid.push({ index, reason: 'stat_date 不是合法日期' });
      const currency = r.currency ?? String(get<{ currency: string }>(`SELECT currency FROM tk_shop WHERE id = ?`, shopId)?.currency ?? 'USD');
      if (conv.rate(currency, statDate).missing) missing.add(currency);
      const payload: Record<string, string | number | null> = {
        stat_date: statDate,
        advertiser_id: r.advertiser_id ?? null,
        shop_id: shopId,
        campaign_id: r.campaign_id ?? null,
        campaign_name: r.campaign_name ?? null,
        ad_type: r.ad_type ?? 1,
        spu_id: r.spu_id ?? findId(`SELECT id FROM product_spu WHERE is_deleted = 0 AND spu_code = ?`, r.spu_code),
        video_id: r.video_id ?? findId(`SELECT id FROM video WHERE is_deleted = 0 AND tk_video_id = ?`, r.tk_video_id),
        spend: round2(r.spend),
        currency,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        conversions: r.conversions ?? 0,
        gmv: round2(r.gmv ?? 0),
      };
      const exist = get<{ id: number }>(
        `SELECT id FROM ad_daily WHERE is_deleted = 0 AND shop_id = ? AND IFNULL(campaign_id, '') = ? AND stat_date = ? AND ad_type = ?`,
        shopId,
        r.campaign_id ?? '',
        statDate,
        payload.ad_type,
      );
      if (exist) {
        if (!overwrite) return void (out.skipped += 1);
        update('ad_daily', exist.id, payload);
        out.updated += 1;
        out.ids.push(exist.id);
        return;
      }
      out.ids.push(insert('ad_daily', { ...payload, created_by: userId }));
      out.inserted += 1;
    });
  });
  return { ...out, rate_missing: [...missing] };
}

const importMessage = (out: AdImportResult & { rate_missing: string[] }): string =>
  `导入完成：新增 ${out.inserted}，更新 ${out.updated}，跳过 ${out.skipped}，无效 ${out.invalid.length}${
    out.rate_missing.length ? `；${out.rate_missing.join('/')} 无落库汇率，已用兜底牌价` : ''
  }`;

adsRouter.post(
  '/import',
  requireMenu('ads'),
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(z.object({ rows: z.array(adImportRow).min(1).max(5000), overwrite: z.boolean().optional() }), req.body);
    const out = applyAdRows(user, body.rows, body.overwrite ?? true);
    writeOpLog({ user_id: user.id, module: '投放中心', action: 'create', target_table: 'ad_daily', after: { ...out, ids: undefined }, ip: req.ip });
    ok(res, out, importMessage(out));
  }),
);

/** 人工补录单条（PRD §3.7「表单（人工补录/导入）」）：与导入同一条唯一键，重复提交按更新 */
adsRouter.post(
  '/daily',
  requireMenu('ads'),
  wrap((req, res) => {
    const user = current(req);
    const row = parseBody(adImportRow, req.body);
    const out = applyAdRows(user, [row]);
    if (out.invalid.length) throw badRequest(out.invalid[0].reason);
    writeOpLog({ user_id: user.id, module: '投放中心', action: 'create', target_table: 'ad_daily', target_id: out.ids[0] ?? null, after: { ...row, inserted: out.inserted, updated: out.updated }, ip: req.ip });
    ok(res, { id: out.ids[0] ?? null, inserted: out.inserted, updated: out.updated, rate_missing: out.rate_missing }, out.inserted ? '已录入' : '已按唯一键更新既有记录');
  }),
);

/** 修改单条投放日报（人工纠错：金额与计数重填，唯一键不允许改，避免与账单重跑打架） */
adsRouter.put(
  '/daily/:id',
  requireMenu('ads'),
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = get<Record<string, string | number | null>>(`SELECT * FROM ad_daily WHERE id = ? AND is_deleted = 0`, id);
    if (!before) throw notFound('广告日报记录不存在');
    if (!canAccessShop(user, Number(before.shop_id))) throw forbidden('该店铺不在你的数据范围内');
    const body = parseBody(adImportRow.partial(), req.body);
    const patch: Record<string, string | number | null> = {};
    for (const k of ['spend', 'impressions', 'clicks', 'conversions', 'gmv', 'currency', 'campaign_name', 'advertiser_id', 'spu_id', 'video_id'] as const) {
      if (body[k] !== undefined) patch[k] = k === 'spend' || k === 'gmv' ? round2(num(body[k])) : body[k];
    }
    update('ad_daily', id, patch);
    writeOpLog({ user_id: user.id, module: '投放中心', action: 'update', target_table: 'ad_daily', target_id: id, before, after: { ...before, ...patch }, ip: req.ip });
    ok(res, { id });
  }),
);

/** 手工重跑派生汇总（视频 / 达人 / 链接），广告费与利润报表都依赖这些落库快照 */
adsRouter.post(
  '/refresh',
  requireMenu('ads'),
  wrap((req, res) => {
    const user = current(req);
    const input = adRangeInput(req);
    const range = resolveRange({ user, start: input.from, end: input.to });
    const summary = runAggregates(user, { start: range.start, end: range.end });
    writeOpLog({ user_id: user.id, module: '投放中心', action: 'update', target_table: 'sync_log', after: summary, ip: req.ip });
    ok(
      res,
      summary,
      `汇总完成：扫描 ${summary.scanned} 行，回写 ${summary.affected} 行${summary.errors.length ? `，失败 ${summary.errors.length} 项` : ''}`,
    );
  }),
);

/* ==================== 导出 ==================== */

const AD_HEADERS = [
  '日期',
  '店铺',
  '账户',
  '计划ID',
  '计划名',
  '投放类型',
  '币种',
  '花费(原币)',
  '花费(CNY)',
  '广告GMV(CNY)',
  'ROI',
  '曝光',
  '点击',
  '转化',
  'CTR(%)',
  'CVR(%)',
  'CPM',
  'CPC',
  '单均成本',
];

adsRouter.get(
  '/export',
  requireMenu('ads'),
  requireExport,
  wrap(async (req, res) => {
    const user = current(req);
    const { q } = adQuery(req);
    const input = adRangeInput(req);
    const range = resolveRange({ user, start: input.from, end: input.to });
    const rows = all<Record<string, number | string | null>>(
      `SELECT ${AD_SELECT.replace('a.*', 'a.id')} FROM ${AD_FROM}${q.whereSql} ORDER BY a.stat_date ASC, a.id ASC LIMIT 20000`,
      ...q.params,
    );
    const lines = [
      AD_HEADERS,
      ...rows.map((raw) => {
        const r = derived(raw);
        return [
          rateDay(r.stat_date) ?? '',
          r.shop_name ?? '',
          r.advertiser_id ?? '',
          r.campaign_id ?? '',
          r.campaign_name ?? '',
          AD_TYPE_LABEL[num(raw.ad_type)] ?? '',
          r.currency ?? '',
          num(raw.spend),
          num(r.spend_cny),
          num(r.gmv_cny),
          r.roi ?? '',
          num(raw.impressions),
          num(raw.clicks),
          num(raw.conversions),
          r.ctr,
          r.cvr,
          r.cpm,
          r.cpc,
          r.cost_per_order,
        ];
      }),
    ];
    const format = exportFormat(req);
    await sendTable(res, { filename: `ad-daily-${range.start}_${range.end}`, headers: AD_HEADERS, rows: lines.slice(1) }, format);
    writeOpLog({ user_id: user.id, module: '投放中心', action: 'export', target_table: 'ad_daily', after: { rows: rows.length, range, format }, ip: req.ip });
  }),
);

/** 分页与维度元信息（前端表格初始化用；pageSize 上限由 core/http 收敛到 200） */
adsRouter.get(
  '/meta',
  requireMenu('ads'),
  wrap((req, res) => {
    const p = paginate(req);
    ok(res, { page: p.page, page_size: p.pageSize, group_by: AD_GROUP_DIMS.map((d) => ({ key: d, label: GROUP_LABEL[d] })) });
  }),
);
