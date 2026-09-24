import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_ROLES, REGION_TZ_OFFSET, SELECTION_CHECKLIST_KEYS, SELECTION_STAGE_LABELS, buildCollabNo, round2, statDateInZone } from '@tk/shared';
import { seedV2DemoData } from './seedV2.js';
import { config } from '../config.js';
import { hashPassword } from '../core/auth.js';
import { insert, run, get, all } from '../core/db.js';
import { migrate } from './migrate.js';

/* 确定性随机：同一 seed 每次生成同样的数据，便于测试与验收对账 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return {
    next: () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff),
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)),
    pick: <T>(arr: T[]): T => arr[Math.floor(((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * arr.length)] as T,
  };
}

const rng = makeRng(20260814);
const iso = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const daysAgo = (n: number, hour = 9, minute = 0) => {
  const d = new Date(Date.UTC(2026, 8, 18));
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
const RATE: Record<string, number> = { USD: 7.15, MYR: 2.12, PHP: 0.128, SGD: 5.6, CNY: 1 };

export function seedDemoData(opts: { reset?: boolean } = {}): void {
  if (opts.reset) {
    const hasSeq = !!get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
    run('PRAGMA foreign_keys = OFF');
    // schema_migration 必须留着：清掉它就等于把「这个库已经跑过哪些幂等升级」的记忆抹了，
    // 下次 migrate 会从头再放一遍历史迁移（有的迁移是会改数据的）
    const tables = all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'`,
    );
    for (const t of tables) run(`DELETE FROM ${t.name}`);
    if (hasSeq) run(`DELETE FROM sqlite_sequence`);
    run('PRAGMA foreign_keys = ON');
  }

  /* ---------- 角色 ---------- */
  const roleId: Record<string, number> = {};
  for (const r of DEFAULT_ROLES) {
    roleId[r.role_key] = insert('sys_role', {
      role_name: r.role_name,
      role_key: r.role_key,
      menu_perms: JSON.stringify([...r.menu_perms]),
      data_scope: r.data_scope,
      can_see_cost: r.can_see_cost,
      can_see_contact: r.can_see_contact,
      can_export: r.can_export,
    });
  }

  /* ---------- 员工 ---------- */
  const uid: Record<string, number> = {};
  const users: [string, string, string, string][] = [
    ['boss', '陈新', 'boss', '管理层'],
    ['limy', '林雅', 'ops', '运营一组'],
    ['zhaolei', '赵磊', 'ops', '运营一组'],
    ['wangqiang', '王强', 'ops_manager', '运营一组'],
    ['chenbd', '陈思远', 'bd', '达人一组'],
    ['lubd', '陆嘉宁', 'bd', '达人一组'],
    ['hudm', '胡敏', 'bd_manager', '达人一组'],
    ['yinuo', '伊诺', 'content', '内容组'],
    ['hostlin', '林小芳', 'host', '直播组'],
    ['adskent', '肯特', 'ads', '投放组'],
    ['finwu', '吴珊', 'finance', '财务部'],
    ['whzhao', '赵国庆', 'warehouse', '仓储部'],
  ];
  for (const [username, real_name, role, dept] of users) {
    uid[username] = insert('sys_user', {
      username,
      password_hash: hashPassword(config.demoPassword),
      real_name,
      phone: `1380000${String(Object.keys(uid).length + 1000)}`,
      dept,
      role_id: roleId[role] as number,
      status: 1,
      last_login_at: iso(daysAgo(rng.int(0, 3), 8)),
    });
  }

  /* ---------- 店铺 ---------- */
  const shopSpecs: [string, string, string, string, number][] = [
    ['ORICO MY Flagship', 'MY', 'MYR', 'Asia/Kuala_Lumpur', 1],
    ['HYGGE PH Official', 'PH', 'PHP', 'Asia/Manila', 1],
    ['ANTA US Creator Store', 'US', 'USD', 'America/Los_Angeles', 1],
    ['Conqland SG Local', 'SG', 'SGD', 'Asia/Singapore', 2],
  ];
  const shopId: number[] = [];
  shopSpecs.forEach(([name, region, currency, tz, type], i) => {
    shopId.push(
      insert('tk_shop', {
        shop_name: name,
        tk_shop_id: `7418${900000 + i * 137}`,
        shop_cipher: `cipher-${region.toLowerCase()}-${i + 1}`,
        region,
        shop_type: type,
        currency,
        timezone: tz,
        auth_status: i === 3 ? 2 : 1,
        token_expire_at: iso(daysAgo(i === 3 ? -5 : i * 40 + 60)),
        owner_id: uid[i === 0 ? 'limy' : i === 1 ? 'zhaolei' : 'boss'] as number,
        status: 1,
      }),
    );
  });
  for (const [u, shops] of [['limy', [0]], ['zhaolei', [1]], ['adskent', [0, 1, 2]], ['wangqiang', [0, 1, 2]]] as [string, number[]][]) {
    for (const s of shops) insert('sys_user_shop', { user_id: uid[u] as number, shop_id: shopId[s] as number });
  }

  /* ---------- TikTok 账号 ---------- */
  const accIds: number[] = [];
  const accounts: [string, string, number, number][] = [
    ['oricomy', 'ORICO Malaysia', 1, 0],
    ['hygge.ph', 'HYGGE PH', 1, 1],
    ['anta.us.live', 'ANTA US Live', 3, 2],
    ['techdaily.my', 'Tech Daily MY', 2, 0],
    ['homedecor.ph', 'Home Decor PH', 2, 1],
  ];
  for (const [handle, nickname, type, s] of accounts) {
    accIds.push(
      insert('tk_account', {
        handle,
        nickname,
        account_type: type,
        shop_id: shopId[s] as number,
        region: shopSpecs[s]?.[1],
        followers: rng.int(8000, 620000),
        owner_id: uid[rng.pick(['yinuo', 'hostlin', 'limy'])] as number,
        account_status: 1,
        remark: '人工登记，粉丝数定期更新',
      }),
    );
  }

  /* ---------- 商品 / SKU ---------- */
  const spuIds: number[] = [];
  const spus: [string, string, string, string][] = [
    ['ORICO-66059', '奥睿科六口快充插线板', 'ORICO 6-in-1 GaN Power Strip', '3C数码'],
    ['ORICO-CB2P', '奥睿科双口车充', 'ORICO Dual Port Car Charger', '3C数码'],
    ['HYGGE-R99', '北欧三档落地灯', 'HYGGE Nordic Floor Lamp', '家居'],
    ['HYGGE-K41', '香薰加湿器', 'HYGGE Aroma Humidifier', '家居'],
    ['ANTA-LABAN', '速干训练短袖', 'ANTA Dri-Fit Training Tee', '服饰'],
    ['ANTA-SLIP', '轻量缓震跑鞋', 'ANTA Cushion Running Shoe', '服饰'],
  ];
  for (const [code, cn, en, cat] of spus) {
    spuIds.push(
      insert('product_spu', {
        spu_code: code,
        name_cn: cn,
        name_en: en,
        category: cat,
        main_image: `https://cdn.example.com/img/${code}.jpg`,
        owner_id: uid.wangqiang as number,
        status: 2,
      }),
    );
  }

  const skuIds: number[] = [];
  const skuSpecs: [number, string, string, number, number, number][] = [
    [0, '白/6USB+2C/3m', '白色 3米', 96, 22, 780],
    [0, '黑/6USB+2C/1.8m', '黑色 1.8米', 82, 19, 640],
    [1, '灰/双口36W', '灰色', 21, 6, 96],
    [2, '米白/1.6m', '米白', 158, 46, 3200],
    [2, '深灰/1.6m', '深灰', 158, 46, 3200],
    [3, '白/4L', '白色 4L', 112, 34, 1500],
    [3, '绿/4L', '绿色 4L', 118, 34, 1500],
    [4, '黑/M', '黑色 M', 46, 12, 210],
    [4, '黑/L', '黑色 L', 46, 12, 215],
    [4, '蓝/XL', '蓝色 XL', 49, 12, 220],
    [5, '白/38', '白色 38', 132, 38, 620],
    [5, '白/40', '白色 40', 132, 38, 640],
    [5, '灰/42', '灰色 42', 138, 38, 660],
  ];
  for (const [si, skuTail, spec, purchase, firstLeg, weight] of skuSpecs) {
    const spu = spuIds[si] as number;
    const seq = skuIds.filter((_, idx) => skuSpecs[idx]?.[0] === si).length + 1;
    const code = `${spus[si]?.[0]}-${String(seq).padStart(2, '0')}`;
    void skuTail;
    skuIds.push(
      insert('product_sku', {
        spu_id: spu,
        sku_code: code,
        spec: spec.replace(/\s/g, ''),
        purchase_cost: purchase,
        first_leg_cost: firstLeg,
        weight_g: weight,
        package_size: '20x15x8',
        status: 1,
      }),
    );
  }

  /* ---------- 店铺商品映射（含 2 条待映射，触发工作台提醒） ---------- */
  const listings: { id: number; shop: number; sku: number | null; price: number; name: string }[] = [];
  let tkSkuSeq = 1;
  shopId.forEach((shop, si) => {
    const cur = shopSpecs[si]?.[2] as string;
    const base = cur === 'USD' ? 45 : cur === 'MYR' ? 60 : cur === 'PHP' ? 900 : 25;
    skuIds.forEach((sku, i) => {
      if (i % (si === 3 ? 4 : 2) !== 0) return;
      const price = round2(base * (1 + (i % 5) * 0.35));
      const spuIdx = skuSpecs.findIndex((x) => (spuIds[x[0]] as number) === sku);
      const productName = `${spus[spuIdx]?.[2] ?? 'listing'} - ${skuSpecs[spuIdx]?.[2] ?? ''}`.trim();
      const id = insert('shop_listing', {
        shop_id: shop,
        sku_id: sku,
        tk_product_id: `1729${String(300000 + si * 1000 + i)}`,
        tk_sku_id: `2288${String(500000 + tkSkuSeq++)}`,
        seller_sku: (all<{ sku_code: string }>(`SELECT sku_code FROM product_sku WHERE id=?`, sku)[0]?.sku_code ?? '') + `-S${si + 1}`,
        product_name: productName,
        sale_price: price,
        listing_status: 3,
        map_status: 1,
        last_sync_at: iso(daysAgo(rng.int(0, 2), 3)),
      });
      listings.push({ id, shop, sku, price, name: productName });
    });
  });
  for (let i = 0; i < 2; i++) {
    const id = insert('shop_listing', {
      shop_id: shopId[i] as number,
      sku_id: null,
      tk_product_id: `1729${String(900000 + i)}`,
      tk_sku_id: `2288${String(900000 + i)}`,
      seller_sku: '',
      product_name: `未识别平台商品 ${i + 1}`,
      sale_price: 39.9,
      listing_status: 3,
      map_status: 2,
      last_sync_at: iso(daysAgo(1, 3)),
    });
    listings.push({ id, shop: shopId[i] as number, sku: null, price: 39.9, name: `未识别平台商品 ${i + 1}` });
  }

  /* ---------- 达人库（公海 / 私海 / 合作中 / 黑名单） ---------- */
  const creatorIds: number[] = [];
  const creatorMeta: [string, string, string, number][] = [
    ['aisyah.tech', 'Aisyah Tech', 'MY', 2],
    ['kevinreviews', 'Kevin Reviews', 'MY', 2],
    ['mangbertoys', 'Mang Bert', 'PH', 2],
    ['cosy.ph', 'Cosy PH', 'PH', 1],
    ['fitwithjay', 'Fit with Jay', 'US', 2],
    ['gadgetgabe', 'Gadget Gabe', 'US', 1],
    ['homewithlina', 'Home with Lina', 'SG', 2],
    ['techtales', 'Tech Tales', 'MY', 1],
    ['dealsdrop', 'Deals Drop', 'PH', 1],
    ['runnerose', 'Run Nose', 'US', 2],
    ['dailyfinds.my', 'Daily Finds MY', 'MY', 1],
    ['glowwithme', 'Glow With Me', 'PH', 2],
  ];
  const bdUsers = ['chenbd', 'lubd'];
  creatorMeta.forEach(([handle, nickname, region, pool], i) => {
    const owner = pool === 2 || pool === 3 ? bdUsers[i % 2] : null;
    creatorIds.push(
      insert('creator', {
        handle,
        nickname,
        region,
        followers: rng.int(12000, 890000),
        category_tags: handle.includes('tech') || handle.includes('gadget') ? '3C数码' : handle.includes('fit') || handle.includes('run') ? '运动户外' : '家居生活',
        avg_views: rng.int(3000, 210000),
        gmv_level: rng.pick(['A', 'B', 'B', 'C']),
        email: `${handle.replace(/[^\w]/g, '')}@gmail.com`,
        whatsapp: `+6012${rng.int(100000, 999999)}`,
        owner_id: owner ? (uid[owner] as number) : null,
        protect_until: owner ? iso(daysAgo(i === 3 ? -60 : 6, 0)).slice(0, 10) : null,
        pool_status: pool === 1 ? 1 : i === 11 ? 4 : i % 4 === 0 ? 3 : 2,
        source: rng.int(1, 4),
      }),
    );
  });

  /* ---------- 建联跟进 ---------- */
  creatorIds.forEach((cid, i) => {
    const owner = get<{ owner_id: number | null }>(`SELECT owner_id FROM creator WHERE id=?`, cid)?.owner_id;
    if (!owner) return;
    const rounds = rng.int(1, 4);
    for (let k = 0; k < rounds; k++) {
      insert('creator_outreach', {
        creator_id: cid,
        user_id: owner,
        channel: rng.int(1, 4),
        contact_time: iso(daysAgo(50 - i * 3 - k * 2, rng.int(1, 10))),
        summary: rng.pick(['首次私信自我介绍并说明佣金政策', '回复 interested，询问样品', '已寄样，提醒发布视频', '对方要求提高坑位费至 200USD', '确认挂车链接并约定发布时间']),
        result: Math.min(6, k + rng.int(1, 2)),
        next_follow_at: iso(daysAgo(-rng.int(1, 6), 10)),
      });
    }
  });

  /* ---------- 合作单 ---------- */
  const collabIds: number[] = [];
  creatorIds.forEach((cid, i) => {
    if (i % 2 !== 0) return;
    const owner = get<{ owner_id: number | null }>(`SELECT owner_id FROM creator WHERE id=?`, cid)?.owner_id ?? (uid.chenbd as number);
    const shop = shopId[i % shopId.length] as number;
    const status = [1, 2, 3, 4, 5, 6, 5, 7][Math.min(i / 2, 7)] ?? 5;
    collabIds.push(
      insert('collaboration', {
        collab_no: buildCollabNo(daysAgo(40 - i), i + 1),
        creator_id: cid,
        shop_id: shop,
        spu_id: spuIds[i % spuIds.length] as number,
        coop_type: rng.int(1, 4),
        commission_rate: rng.pick([10, 12, 15, 18, 20]),
        fixed_fee: i % 3 === 0 ? rng.int(80, 320) : 0,
        fee_currency: (shopSpecs[i % shopId.length]?.[2] as string) ?? 'USD',
        promised_videos: rng.int(1, 3),
        promised_lives: i % 5 === 0 ? 1 : 0,
        deadline: iso(daysAgo(-10 - i, 0)).slice(0, 10),
        status,
        owner_id: owner,
      }),
    );
  });

  /* ---------- 寄样（含超期未出内容） ---------- */
  collabIds.forEach((clid, i) => {
    if (i % 3 === 2) return;
    const c = get<{ creator_id: number; shop_id: number }>(`SELECT creator_id, shop_id FROM collaboration WHERE id=?`, clid);
    const sku = skuIds[i % skuIds.length] as number;
    const unit = get<{ purchase_cost: number; first_leg_cost: number }>(`SELECT purchase_cost, first_leg_cost FROM product_sku WHERE id=?`, sku);
    const shipped = i % 4 !== 0;
    insert('sample_shipment', {
      collab_id: clid,
      creator_id: c?.creator_id as number,
      sku_id: sku,
      quantity: rng.int(1, 2),
      sample_cost: round2(((unit?.purchase_cost ?? 0) + (unit?.first_leg_cost ?? 0)) * 1),
      shipping_cost: rng.int(18, 65),
      ship_method: rng.pick([1, 2, 2, 3]),
      tracking_no: shipped ? `JNT${rng.int(10000000, 99999999)}` : null,
      ship_time: shipped ? iso(daysAgo(28 - i * 2, 6)) : null,
      sign_time: shipped ? iso(daysAgo(24 - i * 2, 11)) : null,
      status: shipped ? (i % 5 === 0 ? 3 : 4) : 1,
    });
  });

  /* ---------- 视频（自有 + 达人），带货数据由汇总作业刷新 ---------- */
  const videoIds: number[] = [];
  creatorIds.forEach((cid, i) => {
    if (i % 2 !== 0) return;
    const cl = collabIds.find((x) => get<{ creator_id: number }>(`SELECT creator_id FROM collaboration WHERE id=?`, x)?.creator_id === cid);
    const shop = (get<{ shop_id: number }>(`SELECT shop_id FROM collaboration WHERE id=?`, cl ?? 0)?.shop_id ?? shopId[0]) as number;
    const vid = `75${String(2100000000 + i * 137).slice(0, 9)}`;
    videoIds.push(
      insert('video', {
        tk_video_id: vid,
        video_url: `https://www.tiktok.com/@${creatorMeta[i]?.[0]}/video/${vid}`,
        publisher_type: 2,
        creator_id: cid,
        collab_id: cl ?? null,
        spu_id: spuIds[i % spuIds.length] as number,
        shop_id: shop,
        publish_time: iso(daysAgo(20 - (i % 8) * 2, rng.int(2, 12))),
        views: rng.int(5000, 480000),
        likes: rng.int(200, 32000),
        comments: rng.int(10, 2400),
        shares: rng.int(5, 1800),
      }),
    );
  });
  for (let i = 0; i < 6; i++) {
    const vid = `75${String(2300000000 + i * 911).slice(0, 9)}`;
    videoIds.push(
      insert('video', {
        tk_video_id: vid,
        video_url: `https://www.tiktok.com/@${accounts[i % accounts.length]?.[0]}/video/${vid}`,
        publisher_type: 1,
        account_id: accIds[i % accIds.length] as number,
        spu_id: spuIds[i % spuIds.length] as number,
        shop_id: shopId[i % shopId.length] as number,
        editor_id: uid.yinuo as number,
        publish_time: iso(daysAgo(18 - i * 2, rng.int(2, 12))),
        views: rng.int(2000, 260000),
        likes: rng.int(120, 21000),
        comments: rng.int(8, 1500),
        shares: rng.int(3, 900),
      }),
    );
  }

  /* ---------- 汇率（近 60 天） ---------- */
  for (let d = 0; d < 60; d++) {
    const date = iso(daysAgo(d, 0)).slice(0, 10);
    for (const [cur, base] of Object.entries(RATE)) {
      if (cur === 'CNY') continue;
      insert('exchange_rate', {
        rate_date: date,
        currency: cur,
        rate_to_cny: round2(base * (1 + ((d % 7) - 3) * 0.0015)),
        source: 4,
      });
    }
  }

  const rateOf = (date: string, cur: string) => get<{ rate_to_cny: number }>(`SELECT rate_to_cny FROM exchange_rate WHERE rate_date=? AND currency=?`, date, cur)?.rate_to_cny ?? RATE[cur] ?? 1;

  /* ---------- 订单 + 明细（成本快照 + 带货归因） ---------- */
  const mappedListings = listings.filter((l) => l.sku);
  const orderIds: number[] = [];
  for (let n = 0; n < 260; n++) {
    const dayOffset = Math.floor(rng.next() * 58);
    const orderDate = daysAgo(dayOffset, rng.int(0, 23), rng.int(0, 59));
    const shopIdx = n % shopId.length;
    const shop = shopId[shopIdx] as number;
    const cur = shopSpecs[shopIdx]?.[2] as string;
    const pool = mappedListings.filter((l) => l.shop === shop);
    const itemCount = rng.int(1, Math.min(3, pool.length));
    const status = rng.pick(['COMPLETED', 'COMPLETED', 'COMPLETED', 'DELIVERED', 'SHIPPED', 'TO_BE_SHIPPED', 'CANCELLED']);
    const isSample = n % 37 === 0;
    const subtotal = round2(Array.from({ length: itemCount }, () => (rng.pick(pool) as { price: number }).price * rng.int(1, 2)).reduce((a, b) => a + b, 0));
    const sellerDiscount = round2(subtotal * (rng.next() > 0.7 ? 0.08 : 0));
    const shipping = round2(rng.next() > 0.6 ? rng.int(3, 12) * (cur === 'PHP' ? 20 : 1) : 0);
    const oid = insert('tk_order', {
      shop_id: shop,
      tk_order_id: `57${String(81000000000 + n * 7919)}`,
      order_status: status,
      order_time: iso(orderDate),
      paid_time: status === 'UNPAID' ? null : iso(orderDate),
      ship_time: ['SHIPPED', 'DELIVERED', 'COMPLETED'].includes(status) ? iso(orderDate) : null,
      buyer_region: shopSpecs[shopIdx]?.[1],
      currency: cur,
      subtotal,
      seller_discount: sellerDiscount,
      platform_discount: round2(subtotal * (rng.next() > 0.85 ? 0.05 : 0)),
      shipping_fee: shipping,
      total_paid: round2(subtotal - sellerDiscount + shipping),
      fulfillment_type: rng.pick([1, 2, 2, 3]),
      carrier: status === 'TO_BE_SHIPPED' ? null : rng.pick(['J&T Express', 'NinjaVan', 'DHL eCommerce', 'Flash']),
      tracking_no: status === 'TO_BE_SHIPPED' ? null : `MY${rng.int(100000000, 999999999)}`,
      is_sample_order: isSample ? 1 : 0,
      synced_at: iso(daysAgo(dayOffset > 0 ? dayOffset - 1 : 0, 3)),
    });
    orderIds.push(oid);

    let remaining = sellerDiscount;
    for (let k = 0; k < itemCount; k++) {
      const l = pool[k % pool.length] as { id: number; shop: number; sku: number; price: number };
      const qty = rng.int(1, 2);
      const gross = round2(l.price * qty);
      const share = k === itemCount - 1 ? remaining : round2(Math.min(remaining, gross * 0.08));
      remaining = round2(remaining - share);
      const unit = get<{ purchase_cost: number; first_leg_cost: number }>(`SELECT purchase_cost, first_leg_cost FROM product_sku WHERE id=?`, l.sku as number);
      const unitCost = (unit?.purchase_cost ?? 0) + (unit?.first_leg_cost ?? 0);
      const creatorVideo = rng.next() > 0.45 ? rng.pick(videoIds) : null;
      const vid = creatorVideo ? get<{ tk_video_id: string; creator_id: number }>(`SELECT tk_video_id, creator_id FROM video WHERE id=?`, creatorVideo) : undefined;
      const rate = rng.pick([0, 0, 10, 12, 15, 18, 20]);
      const itemAmount = round2(gross - share);
      insert('tk_order_item', {
        order_id: oid,
        listing_id: l.id,
        sku_id: l.sku,
        quantity: qty,
        unit_price: l.price,
        discount: share,
        item_amount: itemAmount,
        cost_snapshot: round2(unitCost * qty * (RATE.CNY ?? 1)),
        cost_matched: 1,
        creator_id: vid?.creator_id ?? null,
        content_type: vid ? 1 : rng.pick([3, 5]),
        content_id: vid?.tk_video_id ?? (rng.next() > 0.7 ? String(rng.pick(videoIds)) : null),
        commission_rate: rate,
        est_commission: round2((itemAmount * rate) / 100),
      });
    }
    // 待映射订单行：cost_matched=0，必须进告警而不是按 0 成本计算
    if (n % 23 === 0) {
      const unmapped = listings.find((l) => !l.sku && l.shop === shop);
      if (unmapped) {
        insert('tk_order_item', {
          order_id: oid,
          listing_id: unmapped.id,
          sku_id: null,
          quantity: 1,
          unit_price: 39.9,
          discount: 0,
          item_amount: 39.9,
          cost_snapshot: 0,
          cost_matched: 0,
          content_type: 5,
          commission_rate: 0,
          est_commission: 0,
        });
      }
    }
  }

  /* ---------- 售后退款 ---------- */
  for (let i = 0; i < 40; i++) {
    const oid = rng.pick(orderIds) as number;
    const o = get<Record<string, number | string>>(`SELECT o.id, o.shop_id, o.currency, o.total_paid FROM tk_order o WHERE o.id=?`, oid);
    if (!o) continue;
    const applyDate = daysAgo(rng.int(1, 40), rng.int(1, 20));
    insert('tk_return', {
      order_id: oid,
      shop_id: Number(o.shop_id),
      tk_return_id: `RT${String(700000 + i * 37)}`,
      return_type: rng.pick([1, 2, 2]),
      reason: rng.pick(['商品与描述不符', '物流破损', '尺码不合适', '买家不想要了', '质量问题-不亮']),
      refund_amount: round2(Number(o.total_paid) * rng.pick([0.3, 0.5, 1])),
      currency: String(o.currency),
      status: rng.pick(['COMPLETED', 'COMPLETED', 'PROCESSING', 'SELLER_REJECTED']),
      apply_time: iso(applyDate),
      finish_time: iso(daysAgo(rng.int(0, 1), 4)),
      responsibility: rng.int(0, 4),
      is_restocked: rng.pick([0, 1]),
    });
  }

  /* ---------- 直播场次 ---------- */
  // (店铺, 计划开播) 是直播场次的幂等键，库里已有唯一索引兜着（导入中心同一口径）。
  // 所以这里不能随机取日期：两回随机撞同一天同一时段，插到第二场就直接违反唯一键。
  for (let i = 0; i < 26; i++) {
    const shop = shopId[i % shopId.length] as number;
    const start = daysAgo(i < 4 ? -1 - i : ((i * 3) % 45) + 1, [2, 9, 19, 20][i % 4] as number);
    start.setUTCMinutes(i % 60, 0, 0); // 分钟随序号走：同一店铺复发时保证开播时刻必不同
    const live = i >= 4;
    insert('live_session', {
      account_id: accIds[(i + 2) % accIds.length] as number,
      shop_id: shop,
      host_id: uid.hostlin as number,
      assistant_id: uid.yinuo as number,
      plan_start: iso(start),
      plan_end: iso(new Date(start.getTime() + rng.int(2, 4) * 3600_000)),
      actual_start: live ? iso(start) : null,
      actual_end: live ? iso(new Date(start.getTime() + rng.int(2, 4) * 3600_000)) : null,
      viewers: live ? rng.int(800, 26000) : 0,
      peak_online: live ? rng.int(60, 1800) : 0,
      orders: live ? rng.int(3, 88) : 0,
      gmv: live ? round2(rng.int(400, 16000) * (shopSpecs[i % shopId.length]?.[2] === 'PHP' ? 40 : 1)) : 0,
      ad_spend: live ? round2(rng.int(50, 1400)) : 0,
      review_note: live ? rng.pick(['流量高峰在 21:30，主推款转化 3.1%，下次增加优惠券', '场观达标，鞋类讲解时间过短，需补脚本', '投流 ROI 1.9，可放量']) : null,
      status: live ? 3 : 1,
    });
  }

  /* ---------- 广告日报 ---------- */
  for (let d = 0; d < 30; d++) {
    const date = iso(daysAgo(d, 0)).slice(0, 10);
    shopId.forEach((shop, si) => {
      for (let c = 0; c < 3; c++) {
        const spend = round2(rng.int(120, 1400) * (shopSpecs[si]?.[2] === 'PHP' ? 30 : 1));
        insert('ad_daily', {
          stat_date: date,
          advertiser_id: `74${String(100000 + si * 7)}`,
          shop_id: shop,
          campaign_id: `CSB-${si + 1}-${c + 1}`,
          campaign_name: `${shopSpecs[si]?.[0].split(' ')[0]}-GMVMax-${c + 1}`,
          ad_type: rng.pick([1, 1, 2, 3, 4]),
          spu_id: spuIds[(si + c) % spuIds.length] as number,
          video_id: videoIds[(si * 3 + c) % videoIds.length] as number,
          spend,
          currency: shopSpecs[si]?.[2] as string,
          impressions: rng.int(20000, 900000),
          clicks: rng.int(400, 22000),
          conversions: rng.int(5, 420),
          gmv: round2(spend * (0.8 + rng.next() * 3.4)),
        });
      }
    });
  }

  /* ---------- 结算流水（利润以此为准） ---------- */
  const settledOrders = orderIds.filter((_, i) => i % 3 !== 2);
  for (const oid of settledOrders) {
    const o = get<Record<string, string | number>>(
      `SELECT o.id, o.shop_id, o.tk_order_id, o.currency, o.total_paid, o.order_time, s.timezone, s.region
         FROM tk_order o JOIN tk_shop s ON s.id = o.shop_id WHERE o.id=?`,
      oid,
    );
    if (!o) continue;
    const statDay = statDateInZone(String(o.order_time), String(o.timezone ?? ''), REGION_TZ_OFFSET[String(o.region ?? '')] ?? 0);
    const items = all<{ est_commission: number }>(`SELECT est_commission FROM tk_order_item WHERE order_id=?`, Number(o.id));
    const commission = round2(items.reduce((a, b) => a + Number(b.est_commission), 0));
    const stmt = `ST${statDay.replace(/-/g, '')}-${String(oid).padStart(5, '0')}`;
    const rows: [number, number][] = [
      [1, Number(o.total_paid)],
      [3, -round2(Number(o.total_paid) * 0.05)],
      [5, -round2(Number(o.total_paid) * 0.03)],
    ];
    if (commission > 0) rows.push([4, -commission]);
    for (const [txn, amount] of rows) {
      insert('settlement_txn', {
        shop_id: Number(o.shop_id),
        statement_id: stmt,
        statement_time: iso(daysAgo(rng.int(0, 10), 2)),
        tk_order_id: String(o.tk_order_id),
        txn_type: txn,
        amount: round2(amount),
        currency: String(o.currency),
        payment_id: `PM${String(500000 + oid)}`,
        payment_status: rng.pick([1, 1, 1, 2]),
      });
    }
  }
  for (let i = 0; i < 12; i++) {
    const oid = rng.pick(orderIds) as number;
    const o = get<Record<string, string | number>>(`SELECT shop_id, tk_order_id, currency FROM tk_order WHERE id=?`, oid);
    if (!o) continue;
    insert('settlement_txn', {
      shop_id: Number(o.shop_id),
      statement_id: `ST-R${i}`,
      statement_time: iso(daysAgo(i + 1, 3)),
      tk_order_id: String(o.tk_order_id),
      txn_type: 2,
      amount: -round2(rng.int(20, 300) * (String(o.currency) === 'PHP' ? 30 : 1)),
      currency: String(o.currency),
      payment_status: 1,
    });
  }

  /* ---------- 费用（坑位费 / 头程 / 海外仓等） ---------- */
  collabIds.forEach((clid, i) => {
    const c = get<Record<string, number | string>>(`SELECT fixed_fee, fee_currency, shop_id FROM collaboration WHERE id=?`, clid);
    if (!c || Number(c.fixed_fee) <= 0) return;
    insert('expense', {
      expense_date: iso(daysAgo(i * 3 + 2, 0)).slice(0, 10),
      expense_type: 1,
      shop_id: Number(c.shop_id),
      ref_type: 'collaboration',
      ref_id: clid,
      amount: Number(c.fixed_fee),
      currency: String(c.fee_currency),
      amount_cny: round2(Number(c.fixed_fee) * (rateOf(iso(daysAgo(i * 3 + 2, 0)).slice(0, 10), String(c.fee_currency)) as number)),
      payee: `达人 ${creatorMeta[i * 2]?.[1] ?? ''}`,
      status: 2,
    });
  });
  const commonExpenses: [number, string, number, string][] = [
    [2, '头程海运 3 柜（华南→吉隆坡）', 46800, 'CNY'],
    [3, '海外仓月度仓储费', 12800, 'CNY'],
    [4, 'ERP/工具年费订阅', 6800, 'CNY'],
    [6, '第三方达人机构服务费', 9500, 'CNY'],
    [5, '店铺视觉外包', 4200, 'CNY'],
  ];
  commonExpenses.forEach(([type, remark, amount, cur], i) => {
    insert('expense', {
      expense_date: iso(daysAgo(i * 5 + 3, 0)).slice(0, 10),
      expense_type: type,
      shop_id: i % 2 === 0 ? (shopId[0] as number) : null,
      amount,
      currency: cur,
      amount_cny: amount,
      payee: '第三方服务商',
      remark,
      status: i === 4 ? 1 : 2,
    });
  });

  /* ---------- 库存 ---------- */
  const whId = insert('warehouse', { name: '东莞国内仓', wh_type: 1, region: 'CN', status: 1 });
  const whId2 = insert('warehouse', { name: '吉隆坡海外仓', wh_type: 2, region: 'MY', status: 1 });
  skuIds.forEach((sku, i) => {
    insert('stock_ledger', { warehouse_id: whId as number, sku_id: sku, change_type: 1, quantity: rng.int(300, 2600), ref_no: `PO${2026000 + i}`, op_time: iso(daysAgo(55 - i, 8)) });
    insert('stock_ledger', { warehouse_id: whId as number, sku_id: sku, change_type: 2, quantity: -rng.int(100, 800), ref_no: `FL${2026000 + i}`, op_time: iso(daysAgo(45 - i, 8)) });
    insert('stock_ledger', { warehouse_id: whId2 as number, sku_id: sku, change_type: 3, quantity: rng.int(80, 600), ref_no: `TF${2026000 + i}`, op_time: iso(daysAgo(35 - i, 8)) });
    insert('stock_ledger', { warehouse_id: whId2 as number, sku_id: sku, change_type: 4, quantity: -rng.int(10, 200), ref_no: `SO${2026000 + i}`, op_time: iso(daysAgo(10 + i, 8)) });
    insert('stock_ledger', { warehouse_id: whId2 as number, sku_id: sku, change_type: 5, quantity: -rng.int(1, 4), ref_no: `SP${2026000 + i}`, op_time: iso(daysAgo(8 + i, 8)) });
  });

  /* ---------- 数据字典 ---------- */
  const dicts: [string, string, string][] = [
    ['category', '3C数码', '3C数码'], ['category', '家居', '家居'], ['category', '服饰', '服饰'], ['category', '美妆', '美妆'],
    ['creator_tag', '3C数码', '3C数码'], ['creator_tag', '家居生活', '家居生活'], ['creator_tag', '运动户外', '运动户外'], ['creator_tag', '美妆个护', '美妆个护'],
    ['return_reason', '质量', '质量问题'], ['return_reason', '物流', '物流破损'], ['return_reason', '描述不符', '与描述不符'], ['return_reason', '买家原因', '买家原因'],
    ['expense_type', '1', '达人坑位费'], ['expense_type', '2', '头程物流'], ['expense_type', '3', '海外仓费'], ['expense_type', '4', '工具订阅'],
    ['region', 'MY', '马来西亚'], ['region', 'PH', '菲律宾'], ['region', 'US', '美国'], ['region', 'SG', '新加坡'], ['region', 'TH', '泰国'], ['region', 'VN', '越南'],
    ['gmv_level', 'A', 'A（高带货力）'], ['gmv_level', 'B', 'B（中等）'], ['gmv_level', 'C', 'C（待观察）'],
  ];
  dicts.forEach(([t, v, l], i) => insert('sys_dict', { dict_type: t, dict_value: v, dict_label: l, sort: i % 20, status: 1 }));

  /* ---------- 同步日志（含 1 条失败，驱动告警与工作台红点） ---------- */
  shopId.forEach((shop, i) => {
    insert('sync_log', {
      task_type: 'order', shop_id: shop,
      window_start: iso(daysAgo(1, 0)), window_end: iso(daysAgo(0, 0)),
      fetched: 40 + i * 7, inserted: 12 + i, updated: 26 + i * 5, failed: 0, status: 1,
      started_at: iso(daysAgo(0, 3)), finished_at: iso(daysAgo(0, 3, 5)),
    });
  });
  insert('sync_log', {
    task_type: 'settlement', shop_id: shopId[2] as number,
    window_start: iso(daysAgo(2, 0)), window_end: iso(daysAgo(1, 0)),
    fetched: 0, inserted: 0, updated: 0, failed: 1, status: 3,
    error_msg: 'auth expired: shop token invalid (sub_code=105001)',
    started_at: iso(daysAgo(1, 2)), finished_at: iso(daysAgo(1, 2, 1)),
  });

  /* ---------- 选品流水线（方案第十一章：五阶段 + 超时预警 + 淘汰池） ---------- */
  // 故意把每个阶段都摆出「绿 / 黄 / 红」三种停留时长，看板与规则才有东西可看；
  // 天数对齐 config 的 SELECTION_* 默认口径（7 / 14 / 3 / 7）。
  const selSpu = all<{ id: number; name: string }>(`SELECT id, name_cn AS name FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 4`);
  const selOwner = [Number(uid.limy ?? 0), Number(uid.wangqiang ?? 0), Number(uid.boss ?? 0)].filter((n) => n > 0);
  const selChecklist = (doneKeys: string[]): string =>
    JSON.stringify(Object.fromEntries(SELECTION_CHECKLIST_KEYS.map((k) => [k, { done: doneKeys.includes(k) ? 1 : 0 }])));
  const selSnap = (impressions: number, ctr: number, cart: number, cvr: number, refund: number, gmv: number, margin: number): string =>
    JSON.stringify({ impressions, ctr, cart_rate: cart, cvr, refund_rate: refund, gmv, net_margin: margin });
  /**
   * 选品的时间戳锚在「跑种子的那一刻」，不用上面那个 2026-09-18 的历史基准日：
   * 停留天数是流水线的"当前状态"，锚在历史日上会让演示数据每天自己变红一点，
   * 一周后满屏全是超时 —— 那正是这一章要解决的问题，不该由演示数据自己制造。
   */
  const selDaysAgo = (n: number, hour = 9, minute = 0) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(hour, minute, 0, 0);
    return d;
  };
  const selections: {
    name: string; category: string; supplier: string; price: number; moq: number; lead: number; margin: number;
    source: string; stage: number; dwell: number; testDwell?: number; hours?: number; owner: number; shop: number;
    conclusion?: number; note?: string; adjust?: string; snap?: string; done?: string[]; spu?: number; reject?: string;
  }[] = [
    { name: '折叠硅胶洗碗刷', category: '家居', supplier: '义乌百洁', price: 3.2, moq: 500, lead: 7, margin: 0.62, source: '市场调研', stage: 1, dwell: 2, owner: selOwner[0] ?? 1, shop: 0 },
    { name: '磁吸手机支架车载款', category: '3C数码', supplier: '深圳锐目', price: 11.5, moq: 300, lead: 10, margin: 0.48, source: '竞品对标', stage: 1, dwell: 5, owner: selOwner[0] ?? 1, shop: Number(shopId[1]) },
    { name: '宠物自动喂食器', category: '家居', supplier: '宁波宠趣', price: 46, moq: 100, lead: 15, margin: 0.41, source: '达人推荐', stage: 1, dwell: 9, owner: selOwner[1] ?? 2, shop: Number(shopId[0]) },
    { name: '便携榨汁杯 Type-C', category: '3C数码', supplier: '中山小电', price: 18.8, moq: 200, lead: 12, margin: 0.55, source: '市场调研', stage: 2, dwell: 4, testDwell: 3, owner: selOwner[0] ?? 1, shop: Number(shopId[0]), snap: selSnap(8200, 0.031, 0.062, 0.014, 0.021, 1240, 0.31) },
    { name: '可降解垃圾袋加厚', category: '家居', supplier: '潍坊绿源', price: 5.6, moq: 1000, lead: 6, margin: 0.66, source: '供应链推荐', stage: 2, dwell: 11, testDwell: 10, owner: selOwner[1] ?? 2, shop: Number(shopId[1]), snap: selSnap(15600, 0.019, 0.038, 0.007, 0.034, 980, 0.18) },
    { name: '硅胶保鲜盖十二件套', category: '家居', supplier: '东莞硅胶厂', price: 9.4, moq: 400, lead: 9, margin: 0.58, source: '竞品对标', stage: 2, dwell: 17, testDwell: 16, owner: selOwner[0] ?? 1, shop: Number(shopId[2] ?? shopId[0]), snap: selSnap(9100, 0.022, 0.041, 0.008, 0.052, 610, 0.09) },
    { name: '高颜值收纳箱透明', category: '家居', supplier: '台州塑业', price: 13.2, moq: 300, lead: 8, margin: 0.6, source: '市场调研', stage: 2, dwell: 3, hours: 52, owner: selOwner[1] ?? 2, shop: Number(shopId[0]), snap: selSnap(4300, 0.052, 0.094, 0.026, 0.012, 2180, 0.42) },
    { name: '无线蓝牙麦克风', category: '3C数码', supplier: '深圳声谷', price: 27.5, moq: 150, lead: 14, margin: 0.44, source: '达人推荐', stage: 3, dwell: 4, testDwell: 13, owner: selOwner[0] ?? 1, shop: Number(shopId[1]), conclusion: 1, note: '测试期 CTR 与转化率均达基准 1.6 倍，退货率低于类目均值，建议进入销售准备', snap: selSnap(12800, 0.041, 0.083, 0.021, 0.018, 3420, 0.38) },
    { name: '儿童防夹手门挡', category: '家居', supplier: '义乌童安', price: 4.1, moq: 800, lead: 7, margin: 0.52, source: '供应链推荐', stage: 3, dwell: 1, testDwell: 12, owner: selOwner[1] ?? 2, shop: Number(shopId[0]), conclusion: 3, note: '主图点击尚可但转化明显低于基准', adjust: '换主图（场景图）+ 标题加「防夹手」关键词 + 详情页补尺寸图', snap: selSnap(6700, 0.034, 0.021, 0.004, 0.028, 260, 0.11) },
    { name: '厨房计时器磁吸款', category: '家居', supplier: '温州计时', price: 7.8, moq: 500, lead: 8, margin: 0.57, source: '竞品对标', stage: 4, dwell: 8, owner: selOwner[0] ?? 1, shop: Number(shopId[1]), conclusion: 1, note: '测试通过', done: ['profile', 'price', 'channel'], snap: selSnap(11200, 0.038, 0.071, 0.019, 0.016, 2760, 0.36), spu: selSpu[0]?.id },
    { name: '可折叠沥水篮', category: '家居', supplier: '揭阳塑品', price: 10.6, moq: 350, lead: 10, margin: 0.54, source: '市场调研', stage: 4, dwell: 3, owner: selOwner[1] ?? 2, shop: Number(shopId[2] ?? shopId[0]), conclusion: 1, note: '测试通过', done: ['profile', 'price', 'stock', 'channel', 'compliance'], snap: selSnap(9800, 0.036, 0.068, 0.017, 0.02, 2210, 0.34), spu: selSpu[1]?.id },
    { name: '桌面理线器套装', category: '3C数码', supplier: '东莞硅胶', price: 6.3, moq: 600, lead: 6, margin: 0.61, source: '供应链推荐', stage: 5, dwell: 6, owner: selOwner[0] ?? 1, shop: Number(shopId[0]), conclusion: 1, note: '测试通过，已正式上架', done: ['profile', 'price', 'stock', 'channel', 'finance', 'compliance'], snap: selSnap(13400, 0.044, 0.079, 0.023, 0.014, 4180, 0.44), spu: selSpu[2]?.id ?? selSpu[0]?.id },
    { name: '低价塑料水杯', category: '家居', supplier: '台州杯业', price: 2.4, moq: 2000, lead: 5, margin: 0.22, source: '竞品对标', stage: 6, dwell: 20, owner: selOwner[1] ?? 2, shop: Number(shopId[1]), conclusion: 2, reject: '毛利率仅 22%，扣物流后为负；同类目已有三家低价内卷，不具备投放空间', snap: selSnap(5200, 0.012, 0.018, 0.002, 0.071, 90, -0.08) },
    { name: '网红迷你加湿器', category: '3C数码', supplier: '深圳小电', price: 15.9, moq: 200, lead: 12, margin: 0.47, source: '达人推荐', stage: 6, dwell: 31, owner: selOwner[0] ?? 1, shop: Number(shopId[0]), conclusion: 2, reject: '退货率 11.4%（雾化量与描述不符），复测仍高，判定不通过', snap: selSnap(7600, 0.029, 0.052, 0.011, 0.114, 540, 0.06) },
  ];
  selections.forEach((s, i) => {
    const entered = iso(selDaysAgo(s.dwell, 9, i % 60));
    const id = insert('selection_flow', {
      code: `SEL-${new Date().getUTCFullYear()}-${String(i + 1).padStart(4, '0')}`,
      name: s.name,
      image_url: null,
      category: s.category,
      supplier: s.supplier,
      purchase_price: s.price,
      moq: s.moq,
      lead_days: s.lead,
      est_margin: s.margin,
      breakeven_roas: s.margin > 0 ? Math.round((1 / s.margin) * 100) / 100 : 0,
      source: s.source,
      // shop=0 表示「还没分到测试店铺」——登记阶段的候选品本来就该是这样，
      // 顺带把「无店铺候选品只对登记人可见」这条范围口径放进演示数据里
      shop_id: s.shop || null,
      spu_id: s.spu ?? null,
      stage: s.stage,
      stage_entered_at: entered,
      owner_id: s.owner,
      registered_by: s.owner,
      conclusion: s.conclusion ?? 0,
      conclusion_note: s.note ?? null,
      adjustments: s.adjust ?? null,
      test_started_at: s.stage >= 2 && s.stage < 5 ? iso(selDaysAgo(s.testDwell ?? s.dwell, 10, (i * 7) % 60)) : null,
      test_snapshot: s.snap ?? '{}',
      checklist: selChecklist(s.done ?? []),
      selling_at: s.stage === 5 ? entered : null,
      reject_reason: s.reject ?? null,
      remark: null,
      created_by: s.owner,
      created_at: iso(selDaysAgo(s.dwell + 9, 8)),
    });
    // 上架后 48-72 小时的首检窗口：用 hours 字段精确造一条「正在窗口内」的数据
    if (s.hours) run(`UPDATE selection_flow SET test_started_at = ? WHERE id = ?`, iso(new Date(Date.now() - s.hours * 3_600_000)), id);
    const from = s.stage === 1 ? 0 : s.stage - 1;
    if (from > 0) {
      insert('selection_log', {
        selection_id: Number(id), from_stage: from, to_stage: s.stage, action: 'transition', operator_id: s.owner,
        note: `演示数据：进入${SELECTION_STAGE_LABELS[s.stage] ?? ''}`, created_at: entered,
      });
    }
    insert('selection_log', {
      selection_id: Number(id), from_stage: 0, to_stage: 1, action: 'register', operator_id: s.owner,
      note: '候选品登记', created_at: iso(selDaysAgo(s.dwell + 9, 8)),
    });
  });

  // V2.0：分析宽表重建 + 演示流量回填 + 默认规则 + 首轮预警事件
  seedV2DemoData();

  return undefined as unknown as void;
}

/** 测试专用：内存库 + 建表 + 最小种子 */
export function bootstrapMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
