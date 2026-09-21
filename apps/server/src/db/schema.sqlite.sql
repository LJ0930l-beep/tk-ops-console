-- ============================================================
-- TikTok 运营管理后台 · 运行时 Schema（SQLite 方言）
-- 26 张表 = 业务表 20 + 系统支撑表 6
-- 约定：每表含公共字段 id / created_by / created_at / updated_at / is_deleted
-- 生产环境等价 DDL 见 schema.mysql.sql；时间统一存 UTC（ISO-8601 文本）
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migration (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 5.8 系统支撑（一期，其余模块依赖它，故先建） ----------

CREATE TABLE IF NOT EXISTS sys_role (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name       TEXT    NOT NULL,
  role_key        TEXT    NOT NULL UNIQUE,           -- boss / ops_manager / ops / bd_manager / bd / content / host / ads / finance / warehouse
  menu_perms      TEXT    NOT NULL DEFAULT '[]',     -- JSON: 可见菜单 key 数组
  data_scope      INTEGER NOT NULL DEFAULT 3,        -- 1全部 2本组 3仅本人 4指定店铺
  can_see_cost    INTEGER NOT NULL DEFAULT 0,
  can_see_contact INTEGER NOT NULL DEFAULT 0,
  can_export      INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sys_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  real_name     TEXT NOT NULL,
  phone         TEXT,
  dept          TEXT,
  role_id       INTEGER NOT NULL REFERENCES sys_role(id),
  status        INTEGER NOT NULL DEFAULT 1,          -- 1在职 0停用
  last_login_at TEXT,
  created_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sys_user_shop (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES sys_user(id),
  shop_id    INTEGER NOT NULL REFERENCES tk_shop(id),
  created_by INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_shop ON sys_user_shop(user_id, shop_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS sys_op_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  op_time      TEXT    NOT NULL DEFAULT (datetime('now')),
  module       TEXT    NOT NULL,
  action       TEXT    NOT NULL,                     -- create / update / delete / export / login
  target_table TEXT,
  target_id    INTEGER,
  before_after TEXT,                                 -- JSON {"before":{},"after":{}}
  ip           TEXT,
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_op_log_user ON sys_op_log(user_id, op_time);

CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type    TEXT    NOT NULL,                     -- order / product / listing / returns / settlement / affiliate_order / ad / video / live
  shop_id      INTEGER REFERENCES tk_shop(id),
  window_start TEXT,
  window_end   TEXT,
  fetched      INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 1,           -- 1成功 2部分失败 3失败
  error_msg    TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sync_log_shop ON sync_log(shop_id, task_type, started_at);

CREATE TABLE IF NOT EXISTS sys_dict (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_type  TEXT NOT NULL,                          -- category / creator_tag / return_reason / expense_type ...
  dict_value TEXT NOT NULL,
  dict_label TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  status     INTEGER NOT NULL DEFAULT 1,             -- 1启用 0停用
  created_by INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dict ON sys_dict(dict_type, dict_value) WHERE is_deleted = 0;

-- ---------- 5.1 基础档案（一期） ----------

CREATE TABLE IF NOT EXISTS tk_shop (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_name     TEXT    NOT NULL,
  tk_shop_id    TEXT    UNIQUE,
  shop_cipher   TEXT,
  region        TEXT    NOT NULL,                    -- US/UK/ID/MY/TH/VN/PH/SG/MX
  shop_type     INTEGER NOT NULL DEFAULT 1,          -- 1跨境店 2本土店
  currency      TEXT    NOT NULL DEFAULT 'USD',
  timezone      TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
  auth_status   INTEGER NOT NULL DEFAULT 0,          -- 0未授权 1已授权 2即将过期 3已失效
  token_expire_at TEXT,
  owner_id      INTEGER REFERENCES sys_user(id),
  status        INTEGER NOT NULL DEFAULT 1,          -- 1运营中 2暂停 3已关店
  app_key_enc   TEXT,                                -- 加密保存的接口凭证（页面/日志不出现）
  app_secret_enc TEXT,
  access_token_enc TEXT,                             -- 按店铺保存的授权 token 密文，real 模式必需
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_shop_owner ON tk_shop(owner_id);

CREATE TABLE IF NOT EXISTS tk_account (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  handle         TEXT    NOT NULL UNIQUE,            -- 小写、去 @
  nickname       TEXT,
  account_type   INTEGER NOT NULL DEFAULT 2,         -- 1官方号 2内容号 3直播号
  shop_id        INTEGER REFERENCES tk_shop(id),
  region         TEXT,
  followers      INTEGER NOT NULL DEFAULT 0,
  owner_id       INTEGER REFERENCES sys_user(id),
  account_status INTEGER NOT NULL DEFAULT 1,         -- 1正常 2限流 3封禁 4停用
  remark         TEXT,
  created_by     INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_account_shop ON tk_account(shop_id);

CREATE TABLE IF NOT EXISTS product_spu (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  spu_code   TEXT    NOT NULL UNIQUE,
  name_cn    TEXT    NOT NULL,
  name_en    TEXT,
  category   TEXT,
  main_image TEXT,
  owner_id   INTEGER REFERENCES sys_user(id),
  status     INTEGER NOT NULL DEFAULT 1,             -- 1开发中 2在售 3停售
  created_by INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_spu_category ON product_spu(category);

CREATE TABLE IF NOT EXISTS product_sku (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  spu_id          INTEGER NOT NULL REFERENCES product_spu(id),
  sku_code        TEXT    NOT NULL UNIQUE,
  spec            TEXT,
  purchase_cost   REAL    NOT NULL DEFAULT 0,        -- 采购成本（人民币/件）
  first_leg_cost  REAL    NOT NULL DEFAULT 0,        -- 头程成本（人民币/件）
  weight_g        INTEGER,
  package_size    TEXT,
  status          INTEGER NOT NULL DEFAULT 1,        -- 1在售 0停售
  created_by      INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sku_spu ON product_sku(spu_id);

CREATE TABLE IF NOT EXISTS shop_listing (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES tk_shop(id),
  sku_id         INTEGER REFERENCES product_sku(id),  -- 未匹配时为空
  tk_product_id  TEXT,
  tk_sku_id      TEXT,
  seller_sku     TEXT,
  product_name   TEXT,
  sale_price     REAL NOT NULL DEFAULT 0,
  listing_status INTEGER NOT NULL DEFAULT 1,          -- 1草稿 2审核中 3在售 4下架 5违规
  map_status     INTEGER NOT NULL DEFAULT 2,          -- 1已映射 2待映射
  last_sync_at   TEXT,
  created_by     INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_listing_shop_sku ON shop_listing(shop_id, tk_sku_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS ix_listing_map_status ON shop_listing(map_status);
CREATE INDEX IF NOT EXISTS ix_listing_seller_sku ON shop_listing(seller_sku);

-- ---------- 5.2 订单中心（一期） ----------

CREATE TABLE IF NOT EXISTS tk_order (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id          INTEGER NOT NULL REFERENCES tk_shop(id),
  tk_order_id      TEXT    NOT NULL UNIQUE,
  order_status     TEXT    NOT NULL,                  -- UNPAID/ON_HOLD/TO_BE_SHIPPED/TRANSIT_TO_SHIP/DELIVERED/COMPLETED/CANCELLED
  order_time       TEXT,
  paid_time        TEXT,
  ship_time        TEXT,
  buyer_region     TEXT,
  currency         TEXT    NOT NULL DEFAULT 'USD',
  subtotal         REAL    NOT NULL DEFAULT 0,
  seller_discount  REAL    NOT NULL DEFAULT 0,
  platform_discount REAL   NOT NULL DEFAULT 0,
  shipping_fee     REAL    NOT NULL DEFAULT 0,
  total_paid       REAL    NOT NULL DEFAULT 0,
  fulfillment_type INTEGER NOT NULL DEFAULT 2,        -- 1平台仓 2自发货 3海外仓
  carrier          TEXT,
  tracking_no      TEXT,
  is_sample_order  INTEGER NOT NULL DEFAULT 0,        -- 达人免费样品单：不计入 GMV
  synced_at        TEXT,
  created_by       INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_order_shop_time ON tk_order(shop_id, order_time);
CREATE INDEX IF NOT EXISTS ix_order_status ON tk_order(order_status);

CREATE TABLE IF NOT EXISTS tk_order_item (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES tk_order(id),
  listing_id     INTEGER REFERENCES shop_listing(id),
  sku_id         INTEGER REFERENCES product_sku(id),   -- 空 = 待映射，不参与利润并告警
  quantity       INTEGER NOT NULL DEFAULT 1,
  unit_price     REAL    NOT NULL DEFAULT 0,
  discount       REAL    NOT NULL DEFAULT 0,
  item_amount    REAL    NOT NULL DEFAULT 0,
  cost_snapshot  REAL    NOT NULL DEFAULT 0,           -- 下单时冻结的（采购+头程）×数量，人民币
  cost_matched   INTEGER NOT NULL DEFAULT 0,           -- 1=成本快照有效
  creator_id     INTEGER REFERENCES creator(id),       -- 带货达人，自然流量为空
  content_type   INTEGER,                               -- 1达人视频 2达人直播 3自营视频 4自营直播 5商品卡
  content_id     TEXT,                                  -- 视频 ID / 直播场次 ID
  commission_rate REAL   NOT NULL DEFAULT 0,
  est_commission  REAL   NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_item_order ON tk_order_item(order_id);
CREATE INDEX IF NOT EXISTS ix_item_sku ON tk_order_item(sku_id);
CREATE INDEX IF NOT EXISTS ix_item_creator ON tk_order_item(creator_id);
CREATE INDEX IF NOT EXISTS ix_item_content ON tk_order_item(content_type, content_id);

CREATE TABLE IF NOT EXISTS tk_return (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER REFERENCES tk_order(id),
  shop_id       INTEGER NOT NULL REFERENCES tk_shop(id),
  tk_return_id  TEXT    NOT NULL UNIQUE,
  tk_order_item_id INTEGER REFERENCES tk_order_item(id),
  return_type   INTEGER NOT NULL DEFAULT 1,            -- 1仅退款 2退货退款
  reason        TEXT,
  refund_amount REAL    NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'USD',
  status        TEXT    NOT NULL DEFAULT 'PROCESSING',
  apply_time    TEXT,
  finish_time   TEXT,
  responsibility INTEGER NOT NULL DEFAULT 0,           -- 0未归类 1质量 2物流 3描述不符 4买家原因
  is_restocked  INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_return_shop ON tk_return(shop_id, apply_time);

-- ---------- 5.3 达人中心（一期） ----------

CREATE TABLE IF NOT EXISTS creator (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  handle        TEXT    NOT NULL UNIQUE,              -- 小写去 @
  nickname      TEXT,
  region        TEXT,
  followers     INTEGER NOT NULL DEFAULT 0,
  category_tags TEXT,                                  -- 逗号分隔多选
  avg_views     INTEGER NOT NULL DEFAULT 0,
  gmv_level     TEXT,
  email         TEXT,                                   -- 敏感字段
  whatsapp      TEXT,                                   -- 敏感字段
  owner_id      INTEGER REFERENCES sys_user(id),        -- 公海时为空
  protect_until TEXT,
  pool_status   INTEGER NOT NULL DEFAULT 1,             -- 1公海 2私海 3合作中 4黑名单
  source        INTEGER NOT NULL DEFAULT 1,             -- 1联盟广场 2TikTok搜索 3达人申样 4机构推荐
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_creator_owner ON creator(owner_id, pool_status);
CREATE INDEX IF NOT EXISTS ix_creator_pool ON creator(pool_status, protect_until);

CREATE TABLE IF NOT EXISTS creator_outreach (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id      INTEGER NOT NULL REFERENCES creator(id),
  user_id         INTEGER NOT NULL REFERENCES sys_user(id),
  channel         INTEGER NOT NULL DEFAULT 1,           -- 1私信 2邮件 3WhatsApp 4定向邀约
  contact_time    TEXT    NOT NULL,
  summary         TEXT,
  result          INTEGER NOT NULL DEFAULT 1,           -- 1未回复 2已回复 3有意向 4报价中 5拒绝 6谈妥
  next_follow_at  TEXT,
  created_by      INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_outreach_creator ON creator_outreach(creator_id, contact_time);
CREATE INDEX IF NOT EXISTS ix_outreach_user ON creator_outreach(user_id, contact_time);

CREATE TABLE IF NOT EXISTS collaboration (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_no        TEXT    NOT NULL UNIQUE,
  creator_id       INTEGER NOT NULL REFERENCES creator(id),
  shop_id          INTEGER NOT NULL REFERENCES tk_shop(id),
  spu_id           INTEGER REFERENCES product_spu(id),
  coop_type        INTEGER NOT NULL DEFAULT 1,           -- 1纯佣金 2坑位费+佣金 3付费视频 4直播专场
  commission_rate  REAL    NOT NULL DEFAULT 0,
  fixed_fee        REAL    NOT NULL DEFAULT 0,
  fee_currency     TEXT    NOT NULL DEFAULT 'USD',
  promised_videos  INTEGER NOT NULL DEFAULT 0,
  promised_lives   INTEGER NOT NULL DEFAULT 0,
  deadline         TEXT,
  tk_plan_id       TEXT,
  status           INTEGER NOT NULL DEFAULT 1,           -- 1已谈妥 2待寄样 3样品在途 4待发布 5已发布 6已完结 7超期未履约 8取消
  owner_id         INTEGER REFERENCES sys_user(id),
  created_by       INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_collab_creator ON collaboration(creator_id);
CREATE INDEX IF NOT EXISTS ix_collab_owner ON collaboration(owner_id, status);

CREATE TABLE IF NOT EXISTS sample_shipment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_id     INTEGER REFERENCES collaboration(id),
  creator_id    INTEGER NOT NULL REFERENCES creator(id),
  sku_id        INTEGER REFERENCES product_sku(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  sample_cost   REAL    NOT NULL DEFAULT 0,             -- SKU 成本快照（人民币）
  shipping_cost REAL    NOT NULL DEFAULT 0,             -- 寄样运费（人民币）
  ship_method   INTEGER NOT NULL DEFAULT 2,             -- 1平台免费样品 2线下自寄 3海外仓代发
  tk_order_id   TEXT,
  tracking_no   TEXT,
  ship_time     TEXT,
  sign_time     TEXT,
  status        INTEGER NOT NULL DEFAULT 1,             -- 1待发 2在途 3已签收 4已出内容 5超期未出内容 6丢件
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sample_collab ON sample_shipment(collab_id);
CREATE INDEX IF NOT EXISTS ix_sample_creator ON sample_shipment(creator_id);
CREATE INDEX IF NOT EXISTS ix_sample_status ON sample_shipment(status, sign_time);

-- ---------- 5.4 内容直播 ----------

CREATE TABLE IF NOT EXISTS video (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tk_video_id    TEXT    UNIQUE,
  video_url      TEXT    NOT NULL,
  publisher_type INTEGER NOT NULL DEFAULT 1,            -- 1自有账号 2达人
  account_id     INTEGER REFERENCES tk_account(id),
  creator_id     INTEGER REFERENCES creator(id),
  collab_id      INTEGER REFERENCES collaboration(id),
  spu_id         INTEGER REFERENCES product_spu(id),
  shop_id        INTEGER REFERENCES tk_shop(id),
  publish_time   TEXT,
  editor_id      INTEGER REFERENCES sys_user(id),
  views          INTEGER NOT NULL DEFAULT 0,
  likes          INTEGER NOT NULL DEFAULT 0,
  comments       INTEGER NOT NULL DEFAULT 0,
  shares         INTEGER NOT NULL DEFAULT 0,
  orders         INTEGER NOT NULL DEFAULT 0,            -- 系统汇总
  gmv            REAL    NOT NULL DEFAULT 0,            -- 系统汇总
  status         INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_video_creator ON video(creator_id);
CREATE INDEX IF NOT EXISTS ix_video_collab ON video(collab_id);
CREATE INDEX IF NOT EXISTS ix_video_editor ON video(editor_id);

CREATE TABLE IF NOT EXISTS live_session (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER REFERENCES tk_account(id),
  shop_id      INTEGER NOT NULL REFERENCES tk_shop(id),
  host_id      INTEGER REFERENCES sys_user(id),
  assistant_id INTEGER REFERENCES sys_user(id),
  creator_id   INTEGER REFERENCES creator(id),
  plan_start   TEXT,
  plan_end     TEXT,
  actual_start TEXT,
  actual_end   TEXT,
  viewers      INTEGER NOT NULL DEFAULT 0,
  peak_online  INTEGER NOT NULL DEFAULT 0,
  orders       INTEGER NOT NULL DEFAULT 0,
  gmv          REAL    NOT NULL DEFAULT 0,
  ad_spend     REAL    NOT NULL DEFAULT 0,
  review_note  TEXT,
  status       INTEGER NOT NULL DEFAULT 1,              -- 1已排班 2直播中 3已结束 4取消
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_live_shop_plan ON live_session(shop_id, plan_start);
CREATE INDEX IF NOT EXISTS ix_live_host ON live_session(host_id, plan_start);

-- ---------- 5.5 投放（二期） ----------

CREATE TABLE IF NOT EXISTS ad_daily (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date     TEXT    NOT NULL,                       -- 按店铺站点时区的自然日
  advertiser_id TEXT,
  shop_id       INTEGER NOT NULL REFERENCES tk_shop(id),
  campaign_id   TEXT,
  campaign_name TEXT,
  ad_type       INTEGER NOT NULL DEFAULT 1,             -- 1GMV Max商品 2GMV Max直播 3视频投流 4达人授权投放
  spu_id        INTEGER REFERENCES product_spu(id),
  video_id      INTEGER REFERENCES video(id),
  spend         REAL    NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'USD',
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  conversions   INTEGER NOT NULL DEFAULT 0,
  gmv           REAL    NOT NULL DEFAULT 0,
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ad_daily ON ad_daily(shop_id, campaign_id, stat_date, ad_type) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS ix_ad_daily_date ON ad_daily(stat_date);

-- ---------- 5.6 财务中心（二期） ----------

CREATE TABLE IF NOT EXISTS settlement_txn (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES tk_shop(id),
  statement_id   TEXT,
  statement_time TEXT,
  tk_order_id    TEXT,
  txn_type       INTEGER NOT NULL DEFAULT 1,             -- 1订单收入 2退款 3平台佣金 4达人佣金 5运费 6平台补贴 7调整 8其他
  amount         REAL    NOT NULL DEFAULT 0,             -- 收入为正 扣款为负
  currency       TEXT    NOT NULL DEFAULT 'USD',
  payment_id     TEXT,
  payment_status INTEGER NOT NULL DEFAULT 2,             -- 1已打款 2处理中 3失败
  created_by     INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_settle_txn ON settlement_txn(shop_id, statement_id, tk_order_id, txn_type) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS ix_settle_order ON settlement_txn(tk_order_id);
CREATE INDEX IF NOT EXISTS ix_settle_time ON settlement_txn(statement_time);

CREATE TABLE IF NOT EXISTS expense (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT    NOT NULL,
  expense_type INTEGER NOT NULL DEFAULT 1,               -- 1达人坑位费 2头程物流 3海外仓费 4工具订阅 5服务费 6其他
  shop_id      INTEGER REFERENCES tk_shop(id),           -- 空 = 公共费用
  ref_type     TEXT,                                     -- collaboration / sample_shipment / live_session
  ref_id       INTEGER,
  amount       REAL    NOT NULL DEFAULT 0,
  currency     TEXT    NOT NULL DEFAULT 'CNY',
  amount_cny   REAL    NOT NULL DEFAULT 0,               -- 按汇率表自动折算
  payee        TEXT,
  voucher      TEXT,
  status       INTEGER NOT NULL DEFAULT 1,               -- 1待付款 2已付款
  remark       TEXT,
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_expense_shop_date ON expense(shop_id, expense_date);
CREATE INDEX IF NOT EXISTS ix_expense_ref ON expense(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS exchange_rate (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_date   TEXT    NOT NULL,
  currency    TEXT    NOT NULL,
  rate_to_cny REAL    NOT NULL,
  source      INTEGER NOT NULL DEFAULT 2,                -- 1 Frankfurter公开API 2手工 3延用前值 4演示数据
  created_by  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rate ON exchange_rate(rate_date, currency) WHERE is_deleted = 0;

-- ---------- 5.7 库存（可选，三期） ----------

CREATE TABLE IF NOT EXISTS warehouse (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  wh_type    INTEGER NOT NULL DEFAULT 1,                 -- 1国内仓 2海外仓 3平台仓
  region     TEXT,
  status     INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouse(id),
  sku_id       INTEGER NOT NULL REFERENCES product_sku(id),
  change_type  INTEGER NOT NULL DEFAULT 1,               -- 1采购入库 2头程发货 3调拨 4销售出库 5样品出库 6退货入库 7盘点调整
  quantity     INTEGER NOT NULL DEFAULT 0,               -- 入库为正 出库为负
  ref_no       TEXT,
  op_time      TEXT    NOT NULL,
  operator_id  INTEGER REFERENCES sys_user(id),
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_stock_wh_sku ON stock_ledger(warehouse_id, sku_id, op_time);

-- ============================================================
-- V2.0 增补（2026-09-19《TikTok Shop 多端口运营决策后台 V2.0》§15.2/§15.3）
-- 第二层：分析宽表（可由事实表聚合或导入回填，source 标注来源，均可追溯）
-- 第三层：预警与动作闭环表
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics_shop_channel_daily (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date   TEXT    NOT NULL,                         -- 报表自然日（站点切日口径与利润引擎一致）
  shop_id     INTEGER NOT NULL REFERENCES tk_shop(id),
  channel     TEXT    NOT NULL,                         -- product_card/live/video/affiliate/ads/organic
  visitors    INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  gmv         REAL    NOT NULL DEFAULT 0,               -- 毛 GMV（人民币）
  refund      REAL    NOT NULL DEFAULT 0,
  net_gmv     REAL    NOT NULL DEFAULT 0,               -- 净 GMV = gmv - refund
  ad_spend    REAL    NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'fact',          -- fact=事实表聚合 import=导入 mock=演示
  created_by  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ascd ON analytics_shop_channel_daily(stat_date, shop_id, channel) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS analytics_product_channel_daily (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date   TEXT    NOT NULL,
  shop_id     INTEGER NOT NULL REFERENCES tk_shop(id),
  spu_id      INTEGER NOT NULL REFERENCES product_spu(id),
  channel     TEXT    NOT NULL,
  impression  INTEGER NOT NULL DEFAULT 0,
  click       INTEGER NOT NULL DEFAULT 0,
  add_cart    INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  gmv         REAL    NOT NULL DEFAULT 0,
  refund      REAL    NOT NULL DEFAULT 0,
  net_gmv     REAL    NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'fact',
  created_by  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_apcd ON analytics_product_channel_daily(stat_date, spu_id, channel) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS analytics_creator_daily (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date    TEXT    NOT NULL,
  creator_id   INTEGER NOT NULL REFERENCES creator(id),
  shop_id      INTEGER REFERENCES tk_shop(id),
  orders       INTEGER NOT NULL DEFAULT 0,
  gmv          REAL    NOT NULL DEFAULT 0,
  refund       REAL    NOT NULL DEFAULT 0,
  net_gmv      REAL    NOT NULL DEFAULT 0,
  sample_cost  REAL    NOT NULL DEFAULT 0,              -- 当日寄样成本（采购+运费，人民币）
  commission   REAL    NOT NULL DEFAULT 0,
  source       TEXT    NOT NULL DEFAULT 'fact',
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_acd ON analytics_creator_daily(stat_date, creator_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS analytics_video_daily (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date     TEXT    NOT NULL,
  video_id      INTEGER NOT NULL REFERENCES video(id),
  views         INTEGER NOT NULL DEFAULT 0,
  product_click INTEGER NOT NULL DEFAULT 0,
  orders        INTEGER NOT NULL DEFAULT 0,
  gmv           REAL    NOT NULL DEFAULT 0,
  refund        REAL    NOT NULL DEFAULT 0,
  net_gmv       REAL    NOT NULL DEFAULT 0,
  ad_spend      REAL    NOT NULL DEFAULT 0,
  source        TEXT    NOT NULL DEFAULT 'fact',
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_avd ON analytics_video_daily(stat_date, video_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS analytics_live_minute (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  live_session_id    INTEGER NOT NULL REFERENCES live_session(id),
  minute_ts          TEXT    NOT NULL,                  -- UTC 分钟时刻
  online_users       INTEGER NOT NULL DEFAULT 0,
  product_click      INTEGER NOT NULL DEFAULT 0,
  orders             INTEGER NOT NULL DEFAULT 0,
  gmv                REAL    NOT NULL DEFAULT 0,
  paid_traffic_ratio REAL    NOT NULL DEFAULT 0,        -- 0~1
  source             TEXT    NOT NULL DEFAULT 'import',
  created_by         INTEGER,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_alm ON analytics_live_minute(live_session_id, minute_ts) WHERE is_deleted = 0;

-- ---------- V2.0 第三层：预警与动作闭环 ----------

CREATE TABLE IF NOT EXISTS alert_rule (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code      TEXT    NOT NULL,                      -- CHANNEL_DEPENDENCY 等（附录 B）
  rule_name      TEXT    NOT NULL,
  target_type    TEXT    NOT NULL,                      -- product/creator/video/live/sample/shop/ads
  scope_json     TEXT    NOT NULL DEFAULT '{}',         -- 适用站点/类目/店铺过滤
  metric         TEXT    NOT NULL,                      -- 评估指标名
  operator       TEXT    NOT NULL DEFAULT '>',          -- > >= < <= ==
  threshold      REAL    NOT NULL DEFAULT 0,
  window_days    INTEGER NOT NULL DEFAULT 7,            -- 观察窗口
  priority       INTEGER NOT NULL DEFAULT 1,            -- 0=P0 1=P1 2=P2
  cooldown_hours INTEGER NOT NULL DEFAULT 24,           -- 同规则同对象冷却
  version        INTEGER NOT NULL DEFAULT 1,
  status         INTEGER NOT NULL DEFAULT 1,            -- 1启用 0停用
  params_json    TEXT    NOT NULL DEFAULT '{}',         -- 规则私有参数（连续周数、峰值比例等）
  remark         TEXT,
  created_by     INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rule_code ON alert_rule(rule_code) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS alert_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id       INTEGER NOT NULL REFERENCES alert_rule(id),
  target_type   TEXT    NOT NULL,
  target_id     INTEGER,
  target_name   TEXT,
  shop_id       INTEGER REFERENCES tk_shop(id),
  detected_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  evidence_json TEXT    NOT NULL DEFAULT '{}',          -- 命中证据快照
  priority      INTEGER NOT NULL DEFAULT 1,
  status        INTEGER NOT NULL DEFAULT 0,             -- 0待处理 1处理中 2已处理 3已忽略
  owner_id      INTEGER REFERENCES sys_user(id),
  due_at        TEXT,
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_event_rule_target ON alert_event(rule_id, target_type, target_id, detected_at);
CREATE INDEX IF NOT EXISTS ix_event_status ON alert_event(status, priority, detected_at);

-- 到期提醒：收件人和指派周期均参与幂等键；过期记录保留以供审计，不复用 stale 行。
CREATE TABLE IF NOT EXISTS user_notification (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id       INTEGER NOT NULL REFERENCES sys_user(id),
  alert_event_id     INTEGER NOT NULL REFERENCES alert_event(id),
  notification_type  TEXT    NOT NULL DEFAULT 'alert_due',
  due_at_snapshot    TEXT    NOT NULL,
  assignment_cycle   INTEGER NOT NULL DEFAULT 0,
  read_at            TEXT,
  stale_at           TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_notification_dedupe
  ON user_notification(recipient_id, alert_event_id, due_at_snapshot, assignment_cycle);
CREATE INDEX IF NOT EXISTS ix_user_notification_inbox
  ON user_notification(recipient_id, is_deleted, stale_at, read_at, created_at);

CREATE TABLE IF NOT EXISTS operation_action (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_event_id  INTEGER NOT NULL REFERENCES alert_event(id),
  handler_id      INTEGER NOT NULL REFERENCES sys_user(id),
  action_type     TEXT    NOT NULL,                     -- handle/ignore/transfer/note
  action_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  note            TEXT,
  expected_result TEXT,
  observe_until   TEXT,                                 -- 观察期截止，到期生成效果回看
  created_by      INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_action_event ON operation_action(alert_event_id);

CREATE TABLE IF NOT EXISTS action_result (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id        INTEGER NOT NULL REFERENCES operation_action(id),
  evaluated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  before_json      TEXT    NOT NULL DEFAULT '{}',
  after_json       TEXT    NOT NULL DEFAULT '{}',
  result           TEXT    NOT NULL DEFAULT 'pending',  -- improved/unchanged/worse/pending
  improvement_rate REAL,
  note             TEXT,
  created_by       INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  is_deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_result_action ON action_result(action_id) WHERE is_deleted = 0;
