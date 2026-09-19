/**
 * V2.0 演示数据：分析宽表流量列回填 + 直播分钟曲线 + 默认规则 + 首轮预警事件。
 *
 * 原则（§15.4 可追溯）：事实列（orders/gmv/refund/net_gmv/ad_spend）一律由
 * rebuildAnalytics() 从事实表推导；本文件只回填事实表没有的流量列
 * （visitors/impression/click/add_cart/views/分钟曲线），演示库专用，确定性 RNG。
 */
import { all, insert, run } from '../core/db.js';
import { todayUtc } from '../services/rates.js';
import { rebuildAnalytics } from '../services/analytics.js';
import { ensureDefaultRules, evaluateRules } from '../services/rules/engine.js';

function makeRng(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    },
    int(a: number, b: number): number {
      return a + Math.floor(this.next() * (b - a + 1));
    },
  };
}

const addDays = (day: string, k: number): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + k * 86400_000).toISOString().slice(0, 10);
};

export function seedV2DemoData(opts: { withEvents?: boolean } = {}): void {
  const rng = makeRng(20260919);
  const today = todayUtc();
  ensureDefaultRules(null);

  // 1) 事实列先从事实表重建（幂等 upsert，只写事实可推导列）
  rebuildAnalytics(null);

  // 2) 店铺×渠道：visitors 回填（mock 流量，事实表无此数据）
  const shopRows = all<{ id: number; orders: number }>(
    `SELECT id, orders FROM analytics_shop_channel_daily WHERE is_deleted = 0 AND channel <> 'ads'`,
  );
  for (const r of shopRows) {
    const visitors = Math.max(60, Number(r.orders) * rng.int(18, 60) + rng.int(0, 300));
    run(`UPDATE analytics_shop_channel_daily SET visitors = ? WHERE id = ?`, visitors, r.id);
  }

  // 3) 商品×渠道：漏斗列回填（曝光→点击→加购；转化率带随机离散，制造漏斗断点差异）
  const prodRows = all<{ id: number; orders: number }>(
    `SELECT id, orders FROM analytics_product_channel_daily WHERE is_deleted = 0`,
  );
  for (const r of prodRows) {
    const impression = rng.int(800, 9000) + Number(r.orders) * rng.int(120, 400);
    const click = Math.round(impression * (0.02 + rng.next() * 0.06));
    const addCart = Math.round(click * (0.08 + rng.next() * 0.22));
    run(`UPDATE analytics_product_channel_daily SET impression = ?, click = ?, add_cart = ? WHERE id = ?`, impression, click, addCart, r.id);
  }

  // 4) 视频×日：近 14 天 views/product_click 回填；无事实行的补 mock 净 GMV 曲线，
  //    每第 3 条视频做衰减曲线（前高后低），保证 VIDEO_DECAY 规则在演示库可命中
  const videos = all<{ id: number }>(`SELECT id FROM video WHERE is_deleted = 0 ORDER BY id`);
  videos.forEach((v, vi) => {
    const decay = vi % 3 === 0;
    const base = rng.int(3000, 24000);
    for (let d = 13; d >= 0; d--) {
      const date = addDays(today, -d);
      const prog = (13 - d) / 13;
      const shape = decay ? Math.max(0.04, 1.05 - prog * 1.25) : 0.55 + 0.75 * Math.abs(Math.sin(prog * 3.1)) + rng.next() * 0.25;
      const views = Math.max(30, Math.round(base * shape));
      const productClick = Math.round(views * (0.01 + rng.next() * 0.03));
      const ts = date;
      run(
        `INSERT INTO analytics_video_daily (stat_date, video_id, views, product_click, orders, gmv, refund, net_gmv, ad_spend, source)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 'mock')
         ON CONFLICT(stat_date, video_id) WHERE is_deleted = 0 DO NOTHING`,
        ts,
        v.id,
        views,
        productClick,
        Math.round(views * 0.0015),
        Math.round(views * 0.09 * 100) / 100,
        Math.round(views * 0.09 * 100) / 100,
      );
      // 已有事实行则插入被唯一索引拒绝 —— 补一句只更新流量列（事实 GMV 列不碰）
      run(
        `UPDATE analytics_video_daily SET views = ?, product_click = ? WHERE stat_date = ? AND video_id = ? AND is_deleted = 0`,
        views,
        productClick,
        date,
        v.id,
      );
    }
  });

  // 5) 直播分钟曲线：已结束场次按 actual_start~actual_end 生成 5 分钟粒度演示数据（source='import'）
  const lives = all<{ id: number; actual_start: string; actual_end: string | null }>(
    `SELECT id, actual_start, actual_end FROM live_session WHERE is_deleted = 0 AND status = 3 AND actual_start IS NOT NULL`,
  );
  for (const lv of lives) {
    const startMs = Date.parse(String(lv.actual_start).replace(' ', 'T') + 'Z');
    const endMs = lv.actual_end ? Date.parse(String(lv.actual_end).replace(' ', 'T') + 'Z') : startMs + 120 * 60_000;
    if (!Number.isFinite(startMs)) continue;
    const minutes = Math.min(180, Math.max(15, Math.round((endMs - startMs) / 60_000)));
    const peak = rng.int(120, 900);
    const paidRatio = Math.round((0.15 + rng.next() * 0.45) * 1000) / 1000;
    for (let m = 0; m <= minutes; m += 5) {
      const prog = m / minutes;
      const online = Math.max(5, Math.round(peak * Math.sin(Math.PI * Math.min(1, prog * 1.1)) * (0.7 + rng.next() * 0.5)));
      const orders = rng.next() < 0.35 ? rng.int(0, 3) : 0;
      const ts = new Date(startMs + m * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      run(
        `INSERT INTO analytics_live_minute (live_session_id, minute_ts, online_users, product_click, orders, gmv, paid_traffic_ratio, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'import')
         ON CONFLICT(live_session_id, minute_ts) WHERE is_deleted = 0 DO NOTHING`,
        lv.id,
        ts,
        online,
        Math.round(online * (0.05 + rng.next() * 0.15)),
        orders,
        Math.round(orders * rng.int(60, 220) * 100) / 100,
        paidRatio,
      );
    }
  }

  // 6) 首轮规则评估：让演示库登录即有行动中心数据（冷却机制保证重复 seed 不刷屏）
  if (opts.withEvents !== false) {
    try {
      evaluateRules({});
    } catch {
      // 演示数据失败不阻塞 seed 主流程
    }
  }
}

void insert;
