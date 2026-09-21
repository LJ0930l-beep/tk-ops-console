/**
 * 导入中心（EPIC-1-02 导入半边）：官方接口覆盖不到的数据，用卖家中心/罗面导出的表格一键兜底。
 *
 * 统一入口 `POST /api/system/import`，按 table 分发到本文件的注册表；
 * 落库全部走 core/importer.ts 的幂等通道（同键更新、脏行单行拒绝、sync_log + sys_op_log 留痕）。
 * 浏览器抓取（source='web'）与人工上传/粘贴（source='manual'）共用同一套契约，
 * 差别只记在留痕里，口径与字段校验完全一致。
 */
import { Router } from 'express';
import { z } from 'zod';
import { normalizeHandle, parseVideoId, type CurrentUser } from '@tk/shared';
import { get, insert, update, type SqlParam } from '../core/db.js';
import { badRequest, forbidden, ok, parseBody, qv, wrap } from '../core/http.js';
import { hasMenu, canAccessShop, type AuthedRequest } from '../core/auth.js';
import {
  IMPORT_ROW_LIMIT,
  runImport,
  zDay,
  zInt,
  zNum,
  zText,
  zYesNo,
  type ImportCtx,
  type ImportSpec,
  type ShopRef,
} from '../core/importer.js';
import { matchSkuBySellerSku, normalizeListingStatus, normalizeReturnType } from '../jobs/syncJobs.js';
import { MAX_RATE_TO_CNY, validIsoDay } from '../services/rates.js';

export const importRouter = Router();

/* ==================== 公共定位工具 ==================== */

/** shop_id（本地）/ tk_shop_id（平台）/ shop_name（店铺名称）三种写法都能定位到店铺，并带出时区 */
function locateShop(row: Record<string, unknown>): ShopRef | null | undefined {
  const byId = row.shop_id !== undefined ? Number(row.shop_id) : NaN;
  const pick = (where: string, ...p: SqlParam[]) =>
    get<{ id: number; timezone: string | null; region: string | null }>(
      `SELECT id, timezone, region FROM tk_shop WHERE is_deleted = 0 AND ${where}`,
      ...p,
    );
  if (Number.isInteger(byId) && byId > 0) {
    const s = pick('id = ?', byId);
    return s ? { shop_id: s.id, timezone: s.timezone ?? '', region: s.region ?? '' } : null;
  }
  const tk = row.tk_shop_id !== undefined ? String(row.tk_shop_id).trim() : '';
  if (tk) {
    const s = pick('tk_shop_id = ?', tk);
    return s ? { shop_id: s.id, timezone: s.timezone ?? '', region: s.region ?? '' } : null;
  }
  const name = row.shop_name !== undefined ? String(row.shop_name).trim() : '';
  if (name) {
    const s = pick('shop_name = ?', name);
    return s ? { shop_id: s.id, timezone: s.timezone ?? '', region: s.region ?? '' } : null;
  }
  return undefined;
}

/** 店铺可选的表（如视频）：没提就跳过范围校验 */
const optShop = locateShop;
/** 店铺必填的表：没提店铺等于脏行，绝不能 fallback 到「全部店铺」 */
const requireShop = (row: Record<string, unknown>): ShopRef | null => locateShop(row) ?? null;

const shopCol = { key: 'shop_id', label: '店铺ID', aliases: ['shop id', '本地店铺ID'], sample: '1', hint: '店铺ID / 平台店铺ID / 店铺名称 任选其一' };
const shopAltCols: ImportSpec['columns'][number][] = [
  shopCol,
  { key: 'tk_shop_id', label: '平台店铺ID', aliases: ['shop_id(平台)'], sample: '7495...' },
  { key: 'shop_name', label: '店铺名称', sample: 'ORICO MY Flagship' },
];

function creatorIdOf(handle: unknown): number | null {
  if (handle === undefined) return null;
  const h = normalizeHandle(String(handle));
  if (!h) return null;
  const hit = get<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 AND handle = ?`, h);
  if (!hit) throw new Error(`达人库里没有 @${h}，请先导入达人档案`);
  return hit.id;
}

/** 只回写表格里给了值的列（mapRow 已丢空单元格），所以重复导入不会把已有数据抹成空 */
const picked = (row: Record<string, unknown>, cols: string[]): Record<string, SqlParam> =>
  Object.fromEntries(cols.filter((c) => row[c] !== undefined && c !== '__shop').map((c) => [c, row[c] as SqlParam]));

/**
 * 全局业务键（视频 ID、售后单号）的幂等更新有个越界口子：
 * 行内店铺填的是自己范围内的店，被更新的那条记录却可能挂在别人名下，
 * 所以命中已有记录时必须按「那条记录的店铺」再把关一次。
 */
function assertRowShop(ctx: ImportCtx, shopId: unknown, what: string): void {
  const id = Number(shopId ?? 0);
  if (id && !canAccessShop(ctx.user, id)) throw new Error(`${what} 已归属店铺 ${id}，不在你的数据范围内`);
}

/** 通用 upsert：findId 命中即更新，否则带 extra 落新行 */
function upsertFn(
  table: string,
  cols: string[],
  findId: (row: Record<string, unknown>) => number,
  extra?: (row: Record<string, unknown>, ctx: ImportCtx) => Record<string, SqlParam>,
): ImportSpec['upsert'] {
  return (row, ctx) => {
    const data = picked(row, cols);
    const id = findId(row);
    if (id) {
      if (Object.keys(data).length) update(table, id, data);
      return 'updated';
    }
    insert(table, { ...data, ...(extra?.(row, ctx) ?? {}), created_by: ctx.userId });
    return 'inserted';
  };
}

const idBy = (sql: string, col: string): ((row: Record<string, unknown>) => number) => (row) => {
  const v = row[col];
  if (v === undefined) return 0;
  return Number(get<{ id: number }>(sql, String(v))?.id ?? 0);
};

/* ==================== 注册表 ==================== */

export const IMPORT_SPECS: ImportSpec[] = [
  {
    table: 'creator',
    label: '达人档案（主页可见数据）',
    menu: 'creator',
    columns: [
      { key: 'handle', label: '达人账号', aliases: ['unique_id', '账号', 'tiktok_id', '@handle'], required: true, sample: '@homereno', hint: '自动转小写去 @' },
      { key: 'nickname', label: '达人昵称', aliases: ['昵称', 'name'], sample: 'Home Reno' },
      { key: 'region', label: '国家地区', aliases: ['region'], sample: 'MY' },
      { key: 'followers', label: '粉丝数', aliases: ['粉丝'], sample: '128000' },
      { key: 'avg_views', label: '平均播放', aliases: ['均播', 'avg_views'], sample: '24000' },
      { key: 'gmv_level', label: '带货等级', aliases: ['等级'], sample: 'A' },
      { key: 'category_tags', label: '内容分类', aliases: ['类目', 'tags'], sample: '家居,收纳' },
      { key: 'email', label: '邮箱', sample: 'a@b.com', hint: '敏感字段：仅 creator 菜单可见' },
      { key: 'whatsapp', label: 'WhatsApp', sample: '+60123456789' },
    ],
    shape: z.object({
      handle: zText.pipe(z.string().min(2, '达人账号太短')).transform((h) => normalizeHandle(h)),
      nickname: zText.optional(),
      region: zText.optional(),
      followers: zInt.optional(),
      avg_views: zInt.optional(),
      gmv_level: zText.optional(),
      category_tags: zText.optional(),
      email: zText.optional(),
      whatsapp: zText.optional(),
    }),
    upsert: upsertFn(
      'creator',
      ['handle', 'nickname', 'region', 'followers', 'avg_views', 'gmv_level', 'category_tags', 'email', 'whatsapp'],
      idBy(`SELECT id FROM creator WHERE is_deleted = 0 AND handle = ?`, 'handle'),
      () => ({ pool_status: 1, source: 2 }),
    ),
  },
  {
    table: 'video',
    label: '视频数据（罗面导出）',
    menu: 'content',
    columns: [
      { key: 'tk_video_id', label: '视频ID', aliases: ['video_id', 'Item ID'], sample: '75210000000', hint: '给了视频链接可自动取' },
      { key: 'video_url', label: '视频链接', aliases: ['链接', 'url'], sample: 'https://www.tiktok.com/@homereno/video/75210000000' },
      { key: 'creator_handle', label: '达人账号', aliases: ['达人', 'author'], sample: '@homereno' },
      { key: 'publish_time', label: '发布时间', aliases: ['发布时间(当地)'], sample: '2026-09-10 20:30:00', hint: '按店铺时区解读后存 UTC' },
      { key: 'views', label: '播放量', aliases: ['播放'], sample: '12500' },
      { key: 'likes', label: '点赞量', aliases: ['点赞'], sample: '830' },
      { key: 'comments', label: '评论量', aliases: ['评论'], sample: '45' },
      { key: 'shares', label: '转发量', aliases: ['分享'], sample: '22' },
      { key: 'spu_code', label: '商品SPU编码', aliases: ['spu'], sample: 'SPU-LAMP-03' },
      ...shopAltCols,
    ],
    shape: z.object({
      tk_video_id: zText.optional(),
      video_url: zText.optional(),
      creator_handle: zText.optional(),
      publish_time: zText.optional(),
      views: zInt.optional(),
      likes: zInt.optional(),
      comments: zInt.optional(),
      shares: zInt.optional(),
      spu_code: zText.optional(),
      shop_id: zText.optional(),
      tk_shop_id: zText.optional(),
      shop_name: zText.optional(),
    }),
    timeCols: ['publish_time'],
    shopOf: optShop,
    upsert: (row, ctx) => {
      const vid = String(row.tk_video_id ?? '') || parseVideoId(String(row.video_url ?? '')) || '';
      if (!vid) throw new Error('视频ID 与视频链接至少给一个');
      const creator_id = creatorIdOf(row.creator_handle);
      const ref = row.__shop as ShopRef | undefined;
      const spu = row.spu_code
        ? get<{ id: number }>(`SELECT id FROM product_spu WHERE is_deleted = 0 AND spu_code = ?`, String(row.spu_code))
        : undefined;
      if (row.spu_code && !spu) throw new Error(`内部 SPU 编码 ${String(row.spu_code)} 不存在，请先在商品中心建档`);
      const exist = get<{ id: number; creator_id: number | null; shop_id: number | null; spu_id: number | null }>(
        `SELECT id, creator_id, shop_id, spu_id FROM video WHERE is_deleted = 0 AND tk_video_id = ?`,
        vid,
      );
      const data: Record<string, SqlParam> = {
        ...(row.views !== undefined ? { views: Number(row.views) } : {}),
        ...(row.likes !== undefined ? { likes: Number(row.likes) } : {}),
        ...(row.comments !== undefined ? { comments: Number(row.comments) } : {}),
        ...(row.shares !== undefined ? { shares: Number(row.shares) } : {}),
        ...(row.publish_time !== undefined ? { publish_time: String(row.publish_time) } : {}),
      };
      // 达人/店铺/商品只在缺失时补：抓取侧的空关系不该抹掉系统里已归因好的结果
      assertRowShop(ctx, exist?.shop_id, `视频 ${vid}`);
      if (ref && exist?.shop_id != null && Number(exist.shop_id) !== ref.shop_id) {
        throw new Error('已有视频号归属其他店铺，已拒绝跨店改写');
      }
      if (creator_id && !exist?.creator_id) data.creator_id = creator_id;
      if (ref && !exist?.shop_id) data.shop_id = ref.shop_id;
      if (spu && !exist?.spu_id) data.spu_id = spu.id;
      if (exist) {
        if (Object.keys(data).length) update('video', exist.id, data);
        return 'updated';
      }
      insert('video', {
        tk_video_id: vid,
        video_url: String(row.video_url ?? '') || `https://www.tiktok.com/@imported/video/${vid}`,
        publisher_type: creator_id ? 2 : 1,
        status: 1,
        ...data,
        created_by: ctx.userId,
      });
      return 'inserted';
    },
  },
  {
    table: 'live_session',
    label: '直播场次数据（罗面导出）',
    menu: 'content',
    timeCols: ['plan_start', 'actual_start', 'actual_end'],
    shopOf: requireShop,
    columns: [
      { key: 'plan_start', label: '开播时间', aliases: ['计划开播', '直播日期'], required: true, sample: '2026-09-12 20:00:00', hint: '与店铺一起构成幂等键' },
      { key: 'actual_start', label: '实际开播', sample: '2026-09-12 20:04:00' },
      { key: 'actual_end', label: '结束时间', sample: '2026-09-12 23:10:00' },
      { key: 'creator_handle', label: '主播达人账号', aliases: ['达人', '主播'], sample: '@homereno' },
      { key: 'viewers', label: '观看人次', aliases: ['场观'], sample: '8600' },
      { key: 'peak_online', label: '峰值在线', aliases: ['最高在线'], sample: '740' },
      { key: 'orders', label: '订单数', sample: '96' },
      { key: 'gmv', label: 'GMV', aliases: ['成交额', 'gmv(原币)'], sample: '4380.5' },
      { key: 'ad_spend', label: '直播投放消耗', aliases: ['消耗'], sample: '620' },
      ...shopAltCols,
    ],
    shape: z.object({
      plan_start: zText,
      actual_start: zText.optional(),
      actual_end: zText.optional(),
      creator_handle: zText.optional(),
      viewers: zInt.optional(),
      peak_online: zInt.optional(),
      orders: zInt.optional(),
      gmv: zNum.optional(),
      ad_spend: zNum.optional(),
      shop_id: zText.optional(),
      tk_shop_id: zText.optional(),
      shop_name: zText.optional(),
    }),
    upsert: (row, ctx) => {
      const ref = row.__shop as ShopRef;
      const plan = String(row.plan_start);
      const creator_id = creatorIdOf(row.creator_handle);
      const cols = ['actual_start', 'actual_end', 'viewers', 'peak_online', 'orders', 'gmv', 'ad_spend'];
      const data = picked(row, cols);
      if (creator_id) data.creator_id = creator_id;
      const exist = get<{ id: number }>(`SELECT id FROM live_session WHERE is_deleted = 0 AND shop_id = ? AND plan_start = ?`, ref.shop_id, plan);
      if (exist) {
        if (Object.keys(data).length) update('live_session', exist.id, data);
        return 'updated';
      }
      insert('live_session', {
        shop_id: ref.shop_id,
        plan_start: plan,
        // 表格里有结束时间或成交额，说明这是一场已结束的直播复盘数据
        status: row.actual_end || Number(row.gmv ?? 0) > 0 ? 3 : 1,
        ...data,
        created_by: ctx.userId,
      });
      return 'inserted';
    },
  },
  {
    table: 'tk_return',
    label: '售后单（退款/退货导出）',
    menu: 'order',
    timeCols: ['apply_time', 'finish_time'],
    shopOf: requireShop,
    columns: [
      { key: 'tk_return_id', label: '售后单号', aliases: ['return_id', '退款单号'], required: true, sample: 'RMA-5820001' },
      { key: 'tk_order_id', label: '订单号', aliases: ['order_id'], sample: '5795820001', hint: '给了就必须已在系统里，便于扣款归集' },
      { key: 'return_type', label: '售后类型', aliases: ['类型'], sample: '退货退款', hint: '仅退款 / 退货退款' },
      { key: 'reason', label: '售后原因', sample: '尺寸不符' },
      { key: 'refund_amount', label: '退款金额', aliases: ['金额'], sample: '39.9' },
      { key: 'currency', label: '币种', sample: 'MYR' },
      { key: 'status', label: '售后状态', aliases: ['状态'], sample: 'COMPLETED' },
      { key: 'apply_time', label: '申请时间', sample: '2026-09-13 10:20:00' },
      { key: 'finish_time', label: '完成时间', sample: '2026-09-15 09:00:00' },
      { key: 'responsibility', label: '责任归属', sample: '2', hint: '0未归类 1质量 2物流 3描述不符 4买家' },
      { key: 'is_restocked', label: '是否回仓', sample: '是' },
      ...shopAltCols,
    ],
    shape: z.object({
      tk_return_id: zText.pipe(z.string().min(3, '售后单号太短')),
      tk_order_id: zText.optional(),
      return_type: zText.optional(),
      reason: zText.optional(),
      refund_amount: zNum.optional(),
      currency: zText.optional(),
      status: zText.optional(),
      apply_time: zText.optional(),
      finish_time: zText.optional(),
      responsibility: zInt.optional(),
      is_restocked: zYesNo.optional(),
      shop_id: zText.optional(),
      tk_shop_id: zText.optional(),
      shop_name: zText.optional(),
    }),
    upsert: (row, ctx) => {
      const ref = row.__shop as ShopRef;
      const rid = String(row.tk_return_id);
      if (row.tk_order_id !== undefined) {
        const o = get<{ id: number }>(`SELECT id FROM tk_order WHERE is_deleted = 0 AND shop_id = ? AND tk_order_id = ?`, ref.shop_id, String(row.tk_order_id));
        if (!o) throw new Error(`订单 ${String(row.tk_order_id)} 不在系统里，请先导入/同步订单`);
        row.__order_id = o.id;
      }
      const cols = ['tk_return_id', 'reason', 'refund_amount', 'currency', 'status', 'apply_time', 'finish_time', 'responsibility', 'is_restocked'];
      const data = picked(row, cols);
      if (row.return_type !== undefined) data.return_type = normalizeReturnType(String(row.return_type));
      if (row.__order_id !== undefined) data.order_id = Number(row.__order_id);
      const exist = get<{ id: number; shop_id: number }>(`SELECT id, shop_id FROM tk_return WHERE is_deleted = 0 AND tk_return_id = ?`, rid);
      assertRowShop(ctx, exist?.shop_id, `售后单 ${rid}`);
      if (exist && Number(exist.shop_id) !== ref.shop_id) {
        throw new Error('已有售后单号归属其他店铺，已拒绝跨店改写');
      }
      if (exist) {
        delete data.tk_return_id;
        if (Object.keys(data).length) update('tk_return', exist.id, data);
        return 'updated';
      }
      insert('tk_return', { shop_id: ref.shop_id, ...data, created_by: ctx.userId });
      return 'inserted';
    },
  },
  {
    table: 'shop_listing',
    label: '店铺在架商品（商品列表导出）',
    menu: 'product',
    shopOf: requireShop,
    columns: [
      { key: 'tk_sku_id', label: '平台SKU ID', aliases: ['sku_id(平台)', '库存单元ID'], required: true, sample: '1729400001' },
      { key: 'tk_product_id', label: '平台商品ID', aliases: ['product_id'], sample: '1729300001' },
      { key: 'seller_sku', label: '卖家SKU', aliases: ['seller_sku', '商家编码'], sample: 'LAMP-03-US', hint: '能对上内部 SKU 编码时自动完成映射' },
      { key: 'product_name', label: '商品名称', aliases: ['品名'], sample: '北欧三档落地灯' },
      { key: 'sale_price', label: '售价', aliases: ['价格'], sample: '49.9' },
      { key: 'listing_status', label: '在架状态', aliases: ['状态'], sample: 'ACTIVATED', hint: '草稿/审核中/在售/下架/违规 或平台原文' },
      ...shopAltCols,
    ],
    shape: z.object({
      tk_sku_id: zText.pipe(z.string().min(2, '平台SKU ID 太短')),
      tk_product_id: zText.optional(),
      seller_sku: zText.optional(),
      product_name: zText.optional(),
      sale_price: zNum.optional(),
      listing_status: zText.optional(),
      shop_id: zText.optional(),
      tk_shop_id: zText.optional(),
      shop_name: zText.optional(),
    }),
    upsert: (row, ctx) => {
      const ref = row.__shop as ShopRef;
      const skuId = String(row.tk_sku_id);
      const cols = ['tk_product_id', 'seller_sku', 'product_name', 'sale_price'];
      const data = picked(row, cols);
      if (row.listing_status !== undefined) data.listing_status = normalizeListingStatus(String(row.listing_status));
      const mapped = matchSkuBySellerSku(row.seller_sku === undefined ? null : String(row.seller_sku));
      if (mapped) {
        data.sku_id = mapped;
        data.map_status = 1;
      }
      const exist = get<{ id: number }>(
        `SELECT id FROM shop_listing WHERE is_deleted = 0 AND shop_id = ? AND tk_sku_id = ?`,
        ref.shop_id,
        skuId,
      );
      if (exist) {
        // 已由接口同步映射上的行不被表格回退成待映射
        if (!mapped) delete data.map_status;
        if (Object.keys(data).length) update('shop_listing', exist.id, data);
        return 'updated';
      }
      insert('shop_listing', { shop_id: ref.shop_id, tk_sku_id: skuId, map_status: mapped ? 1 : 2, ...data, created_by: ctx.userId });
      return 'inserted';
    },
  },
  {
    table: 'exchange_rate',
    label: '汇率（每日对人民币）',
    menu: 'finance',
    columns: [
      { key: 'rate_date', label: '日期', required: true, sample: '2026-09-18' },
      { key: 'currency', label: '币种', required: true, sample: 'MYR' },
      { key: 'rate_to_cny', label: '对人民币汇率', required: true, sample: '1.52' },
    ],
    shape: z.object({
      rate_date: zDay.refine(validIsoDay, '汇率日期必须是有效的 YYYY-MM-DD'),
      currency: zText.pipe(z.string().regex(/^[A-Za-z]{3}$/, '币种请用三字母代码，如 MYR')).transform((c) => c.toUpperCase()),
      rate_to_cny: zNum.refine((n) => Number.isFinite(n) && n > 0 && n <= MAX_RATE_TO_CNY, '汇率必须是可存储的有限正数'),
    }).superRefine((row, ctx) => {
      if (row.currency === 'CNY' && row.rate_to_cny !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rate_to_cny'], message: 'CNY 汇率必须固定为 1' });
      }
    }),
    upsert: upsertFn(
      'exchange_rate',
      ['rate_date', 'currency', 'rate_to_cny'],
      (row) =>
        Number(
          get<{ id: number }>(
            `SELECT id FROM exchange_rate WHERE is_deleted = 0 AND rate_date = ? AND currency = ?`,
            String(row.rate_date),
            String(row.currency).toUpperCase(),
          )?.id ?? 0,
        ),
      () => ({ source: 2 }),
    ),
  },
];

const specOf = (table: string): ImportSpec => {
  const spec = IMPORT_SPECS.find((s) => s.table === table);
  if (!spec) throw badRequest(`不支持的导入表：${table}（可用：${IMPORT_SPECS.map((s) => s.table).join(' / ')}）`);
  return spec;
};

/* ==================== 接口 ==================== */

/** 三张表接口一律按目标表的菜单把关：仓库角色看不到财务/订单的字段清单 */
const guardMenu = (spec: ImportSpec, user: CurrentUser): ImportSpec => {
  if (!hasMenu(user, spec.menu)) throw forbidden(`没有「${spec.label}」的导入权限`);
  return spec;
};

/** 元数据：前端导入向导据此渲染模板列、必填标记与提示（只回当前角色可导入的表） */
importRouter.get(
  '/import/tables',
  wrap((req, res) => {
    const user = (req as AuthedRequest).user;
    ok(
      res,
      IMPORT_SPECS.filter((s) => hasMenu(user, s.menu)).map((s) => ({
        table: s.table,
        label: s.label,
        menu: s.menu,
        row_limit: IMPORT_ROW_LIMIT,
        columns: s.columns.map((c) => ({ key: c.key, label: c.label, required: !!c.required, sample: c.sample ?? '', hint: c.hint ?? '' })),
      })),
    );
  }),
);

/** 模板下载：表头 + 一行示例（UTF-8 BOM，Excel 双击打开中文不乱码） */
importRouter.get(
  '/import/template',
  wrap((req, res) => {
    const spec = guardMenu(specOf(qv(req, 'table') ?? ''), (req as AuthedRequest).user);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${spec.table}.csv"`);
    res.send(`\uFEFF${[spec.columns.map((c) => esc(c.label)).join(','), spec.columns.map((c) => esc(c.sample ?? '')).join(',')].join('\n')}\n`);
  }),
);

const importBody = z.object({
  table: z.string().min(1),
  source: z.enum(['manual', 'web']).optional(),
  rows: z.array(z.record(z.union([z.string(), z.number()]))).min(1, '至少一行').max(IMPORT_ROW_LIMIT, `单次上限 ${IMPORT_ROW_LIMIT} 行`),
});

importRouter.post(
  '/import',
  wrap((req, res) => {
    const user = (req as AuthedRequest).user;
    const body = parseBody(importBody, req.body);
    const spec = guardMenu(specOf(body.table), user);
    const ctx: ImportCtx = { user, userId: user.id, source: body.source === 'web' ? 'web' : 'manual', ip: req.ip };
    const out = runImport(spec, body.rows as Record<string, unknown>[], ctx);
    ok(res, out, out.failed ? `成功 ${out.inserted + out.updated} 行，拒绝 ${out.failed} 行` : `成功导入 ${out.accepted} 行`);
  }),
);
