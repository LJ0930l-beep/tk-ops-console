-- ============================================================
-- TikTok 运营管理后台 · 生产环境等价 Schema（MySQL 8.0 方言）
-- 26 张表 = 业务表 20 + 系统支撑表 6，与 schema.sqlite.sql 逐字段等价
-- 约定：每表含公共字段 id / created_by / created_at / updated_at / is_deleted
-- 金额 DECIMAL(18,2)；时间统一存 UTC DATETIME；软删只打标记
-- 说明：SQLite 的部分唯一索引（WHERE is_deleted = 0）在 MySQL 中以
--       「唯一键 + is_deleted」等价实现；如需多份软删历史，删除时把
--       is_deleted 置为该行 id（0 仍表示未删除）即可保持唯一性语义。
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS schema_migration (
  version    VARCHAR(120) NOT NULL PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应用数据迁移记录';

CREATE TABLE IF NOT EXISTS sys_role (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_name       VARCHAR(50)   NOT NULL,
  role_key        VARCHAR(32)   NOT NULL,
  menu_perms      JSON          NOT NULL,              -- 可见菜单 key 数组
  data_scope      TINYINT       NOT NULL DEFAULT 3,    -- 1全部 2本组 3仅本人 4指定店铺
  can_see_cost    TINYINT       NOT NULL DEFAULT 0,
  can_see_contact TINYINT       NOT NULL DEFAULT 0,
  can_export      TINYINT       NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted      TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_role_key (role_key, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表22 角色表';

CREATE TABLE IF NOT EXISTS sys_user (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)   NOT NULL,
  password_hash VARCHAR(128)  NOT NULL,                -- scrypt$盐$摘要，不存明文
  real_name     VARCHAR(50)   NOT NULL,
  phone         VARCHAR(20),
  dept          VARCHAR(50),
  role_id       BIGINT UNSIGNED NOT NULL,
  status        TINYINT       NOT NULL DEFAULT 1,      -- 1在职 0停用
  last_login_at DATETIME,
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_username (username, is_deleted),
  KEY ix_user_role (role_id),
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES sys_role(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表21 用户表';

CREATE TABLE IF NOT EXISTS tk_shop (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_name      VARCHAR(100)  NOT NULL,
  tk_shop_id     VARCHAR(64),
  shop_cipher    VARCHAR(128),
  region         VARCHAR(8)    NOT NULL,               -- US/UK/ID/MY/TH/VN/PH/SG/MX
  shop_type      TINYINT       NOT NULL DEFAULT 1,     -- 1跨境店 2本土店
  currency       CHAR(3)       NOT NULL DEFAULT 'USD',
  timezone       VARCHAR(32)   NOT NULL DEFAULT 'Asia/Shanghai',
  auth_status    TINYINT       NOT NULL DEFAULT 0,     -- 0未授权 1已授权 2即将过期 3已失效
  token_expire_at DATETIME,
  owner_id       BIGINT UNSIGNED,
  status         TINYINT       NOT NULL DEFAULT 1,     -- 1运营中 2暂停 3已关店
  app_key_enc    TEXT,                                 -- AES-256-GCM 密文，页面/日志不回显
  app_secret_enc TEXT,
  access_token_enc VARCHAR(512),                        -- 按店铺保存的授权 token 密文，real 模式必需
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tk_shop_id (tk_shop_id, is_deleted),
  KEY ix_shop_owner (owner_id),
  CONSTRAINT fk_shop_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表1 店铺表';

CREATE TABLE IF NOT EXISTS tk_account (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  handle         VARCHAR(64)   NOT NULL,               -- 小写、去 @
  nickname       VARCHAR(100),
  account_type   TINYINT       NOT NULL DEFAULT 2,     -- 1官方号 2内容号 3直播号
  shop_id        BIGINT UNSIGNED,
  region         VARCHAR(8),
  followers      INT           NOT NULL DEFAULT 0,
  owner_id       BIGINT UNSIGNED,
  account_status TINYINT       NOT NULL DEFAULT 1,     -- 1正常 2限流 3封禁 4停用
  remark         VARCHAR(500),                          -- 不保存任何账号密码
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_handle (handle, is_deleted),
  KEY ix_account_shop (shop_id),
  CONSTRAINT fk_account_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_account_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表2 TikTok账号表';

CREATE TABLE IF NOT EXISTS product_spu (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spu_code   VARCHAR(64)   NOT NULL,
  name_cn    VARCHAR(200)  NOT NULL,
  name_en    VARCHAR(300),
  category   VARCHAR(100),
  main_image VARCHAR(500),
  owner_id   BIGINT UNSIGNED,
  status     TINYINT       NOT NULL DEFAULT 1,         -- 1开发中 2在售 3停售
  created_by BIGINT UNSIGNED,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_spu_code (spu_code, is_deleted),
  KEY ix_spu_category (category),
  CONSTRAINT fk_spu_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表3 商品表(SPU)';

CREATE TABLE IF NOT EXISTS product_sku (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spu_id         BIGINT UNSIGNED NOT NULL,
  sku_code       VARCHAR(64)     NOT NULL,
  spec           VARCHAR(200),                          -- 颜色/尺码/套装
  rebate_rate    DECIMAL(8,4)    NOT NULL DEFAULT 0,   -- 品牌给的返点率（0.18 = 实收 GMV 的 18% 归我们）
  logistics_cost DECIMAL(18,2)   NOT NULL DEFAULT 0,   -- 单件物流成本（头程+海外仓，人民币/件）
  weight_g       INT,
  package_size   VARCHAR(50),
  status         TINYINT         NOT NULL DEFAULT 1,   -- 1在售 0停售
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT         NOT NULL DEFAULT 0,
  UNIQUE KEY uk_sku_code (sku_code, is_deleted),
  KEY ix_sku_spu (spu_id),
  CONSTRAINT fk_sku_spu FOREIGN KEY (spu_id) REFERENCES product_spu(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表4 SKU表';

CREATE TABLE IF NOT EXISTS shop_listing (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id        BIGINT UNSIGNED NOT NULL,
  sku_id         BIGINT UNSIGNED,                       -- 未匹配时为空
  tk_product_id  VARCHAR(64),
  tk_sku_id      VARCHAR(64),
  seller_sku     VARCHAR(100),
  product_name   VARCHAR(300),
  sale_price     DECIMAL(18,2)   NOT NULL DEFAULT 0,   -- 店铺币种
  listing_status TINYINT         NOT NULL DEFAULT 1,   -- 1草稿 2审核中 3在售 4下架 5违规
  map_status     TINYINT         NOT NULL DEFAULT 2,   -- 1已映射 2待映射
  last_sync_at   DATETIME,
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT         NOT NULL DEFAULT 0,
  UNIQUE KEY ux_listing_shop_sku (shop_id, tk_sku_id, is_deleted),
  KEY ix_listing_map_status (map_status),
  KEY ix_listing_seller_sku (seller_sku),
  CONSTRAINT fk_listing_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_listing_sku FOREIGN KEY (sku_id) REFERENCES product_sku(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表5 店铺商品映射表';

CREATE TABLE IF NOT EXISTS tk_order (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id           BIGINT UNSIGNED NOT NULL,
  tk_order_id       VARCHAR(64)     NOT NULL,
  order_status      VARCHAR(32)     NOT NULL,           -- UNPAID/ON_HOLD/TO_BE_SHIPPED/TRANSIT_TO_SHIP/DELIVERED/COMPLETED/CANCELLED
  order_time        DATETIME,                            -- UTC
  paid_time         DATETIME,
  ship_time         DATETIME,
  buyer_region      VARCHAR(64),
  currency          CHAR(3)         NOT NULL DEFAULT 'USD',
  subtotal          DECIMAL(18,2)   NOT NULL DEFAULT 0,
  seller_discount   DECIMAL(18,2)   NOT NULL DEFAULT 0,
  platform_discount DECIMAL(18,2)   NOT NULL DEFAULT 0,
  shipping_fee      DECIMAL(18,2)   NOT NULL DEFAULT 0,
  total_paid        DECIMAL(18,2)   NOT NULL DEFAULT 0,
  fulfillment_type  TINYINT         NOT NULL DEFAULT 2, -- 1平台仓 2自发货 3海外仓
  carrier           VARCHAR(64),
  tracking_no       VARCHAR(64),
  is_sample_order   TINYINT         NOT NULL DEFAULT 0, -- 达人免费样品单：不计入 GMV
  synced_at         DATETIME,
  created_by        BIGINT UNSIGNED,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted        TINYINT         NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tk_order_id (tk_order_id, is_deleted),
  KEY ix_order_shop_time (shop_id, order_time),
  KEY ix_order_status (order_status),
  CONSTRAINT fk_order_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表6 订单表';

CREATE TABLE IF NOT EXISTS creator (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  handle        VARCHAR(64)  NOT NULL,                  -- 小写去 @，全公司一人一档
  nickname      VARCHAR(100),
  region        VARCHAR(8),
  followers     INT          NOT NULL DEFAULT 0,
  category_tags VARCHAR(200),                            -- 逗号分隔多选
  avg_views     INT          NOT NULL DEFAULT 0,
  gmv_level     VARCHAR(32),
  email         VARCHAR(128),                            -- 敏感：仅归属 BD 和主管可见
  whatsapp      VARCHAR(64),                             -- 敏感，同上
  owner_id      BIGINT UNSIGNED,                         -- 公海时为空
  protect_until DATE,                                    -- 到期无进展自动退回公海
  pool_status   TINYINT      NOT NULL DEFAULT 1,         -- 1公海 2私海 3合作中 4黑名单
  source        TINYINT      NOT NULL DEFAULT 1,         -- 1联盟广场 2TikTok搜索 3达人申样 4机构推荐
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT      NOT NULL DEFAULT 0,
  UNIQUE KEY uk_creator_handle (handle, is_deleted),
  KEY ix_creator_owner (owner_id, pool_status),
  KEY ix_creator_pool (pool_status, protect_until),
  CONSTRAINT fk_creator_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表9 达人库';

CREATE TABLE IF NOT EXISTS tk_order_item (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT UNSIGNED NOT NULL,
  listing_id      BIGINT UNSIGNED,
  sku_id          BIGINT UNSIGNED,                       -- 空=待映射，不参与利润并告警
  quantity        INT           NOT NULL DEFAULT 1,
  unit_price      DECIMAL(18,2) NOT NULL DEFAULT 0,
  discount        DECIMAL(18,2) NOT NULL DEFAULT 0,
  item_amount     DECIMAL(18,2) NOT NULL DEFAULT 0,
  rebate_rate     DECIMAL(8,4)  NOT NULL DEFAULT 0,     -- 成交时冻结的品牌返点率（事后改 SKU 不影响历史单）
  rebate_cny      DECIMAL(18,2) NOT NULL DEFAULT 0,     -- 冻结的应收返点（人民币）= 实收折 CNY × rebate_rate
  logistics_cny   DECIMAL(18,2) NOT NULL DEFAULT 0,     -- 冻结的物流支出（人民币）= 单件物流成本 × 数量
  rebate_matched  TINYINT       NOT NULL DEFAULT 0,     -- 1=返点率已配且快照有效；0 不参与利润
  creator_id      BIGINT UNSIGNED,                       -- 带货达人，自然流量为空
  content_type    TINYINT,                                -- 1达人视频 2达人直播 3自营视频 4自营直播 5商品卡
  content_id      VARCHAR(64),                            -- 视频 ID / 直播场次 ID
  commission_rate DECIMAL(5,2)  NOT NULL DEFAULT 0,
  est_commission  DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted      TINYINT       NOT NULL DEFAULT 0,
  KEY ix_item_order (order_id),
  KEY ix_item_sku (sku_id),
  KEY ix_item_creator (creator_id),
  KEY ix_item_content (content_type, content_id),
  CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES tk_order(id),
  CONSTRAINT fk_item_listing FOREIGN KEY (listing_id) REFERENCES shop_listing(id),
  CONSTRAINT fk_item_sku FOREIGN KEY (sku_id) REFERENCES product_sku(id),
  CONSTRAINT fk_item_creator FOREIGN KEY (creator_id) REFERENCES creator(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表7 订单明细表（全系统交汇点）';

CREATE TABLE IF NOT EXISTS tk_return (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id         BIGINT UNSIGNED,
  shop_id          BIGINT UNSIGNED NOT NULL,
  tk_return_id     VARCHAR(64)     NOT NULL,
  tk_order_item_id BIGINT UNSIGNED,
  return_type      TINYINT         NOT NULL DEFAULT 1,   -- 1仅退款 2退货退款
  reason           VARCHAR(200),
  refund_amount    DECIMAL(18,2)   NOT NULL DEFAULT 0,
  currency         CHAR(3)         NOT NULL DEFAULT 'USD',
  status           VARCHAR(32)     NOT NULL DEFAULT 'PROCESSING',
  apply_time       DATETIME,
  finish_time      DATETIME,
  responsibility   TINYINT         NOT NULL DEFAULT 0,   -- 0未归类 1质量 2物流 3描述不符 4买家原因
  is_restocked     TINYINT         NOT NULL DEFAULT 0,
  created_by       BIGINT UNSIGNED,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted       TINYINT         NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tk_return_id (tk_return_id, is_deleted),
  KEY ix_return_shop (shop_id, apply_time),
  CONSTRAINT fk_return_order FOREIGN KEY (order_id) REFERENCES tk_order(id),
  CONSTRAINT fk_return_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_return_item FOREIGN KEY (tk_order_item_id) REFERENCES tk_order_item(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表8 售后退款表';

CREATE TABLE IF NOT EXISTS creator_outreach (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  creator_id     BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  channel        TINYINT      NOT NULL DEFAULT 1,        -- 1私信 2邮件 3WhatsApp 4定向邀约
  contact_time   DATETIME     NOT NULL,
  summary        VARCHAR(500),
  result         TINYINT      NOT NULL DEFAULT 1,        -- 1未回复 2已回复 3有意向 4报价中 5拒绝 6谈妥
  next_follow_at DATETIME,                                -- 到点提醒
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT      NOT NULL DEFAULT 0,
  KEY ix_outreach_creator (creator_id, contact_time),
  KEY ix_outreach_user (user_id, contact_time),
  CONSTRAINT fk_outreach_creator FOREIGN KEY (creator_id) REFERENCES creator(id),
  CONSTRAINT fk_outreach_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表10 建联跟进表';

CREATE TABLE IF NOT EXISTS collaboration (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  collab_no       VARCHAR(32)     NOT NULL,              -- CBYYYYMMDD-0001
  creator_id      BIGINT UNSIGNED NOT NULL,
  shop_id         BIGINT UNSIGNED NOT NULL,
  spu_id          BIGINT UNSIGNED,
  coop_type       TINYINT         NOT NULL DEFAULT 1,    -- 1纯佣金 2坑位费+佣金 3付费视频 4直播专场
  commission_rate DECIMAL(5,2)    NOT NULL DEFAULT 0,
  fixed_fee       DECIMAL(18,2)   NOT NULL DEFAULT 0,
  fee_currency    CHAR(3)         NOT NULL DEFAULT 'USD',
  promised_videos INT             NOT NULL DEFAULT 0,
  promised_lives  INT             NOT NULL DEFAULT 0,
  deadline        DATE,
  tk_plan_id      VARCHAR(64),
  status          TINYINT         NOT NULL DEFAULT 1,    -- 1已谈妥 2待寄样 3样品在途 4待发布 5已发布 6已完结 7超期未履约 8取消
  owner_id        BIGINT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted      TINYINT         NOT NULL DEFAULT 0,
  UNIQUE KEY uk_collab_no (collab_no, is_deleted),
  KEY ix_collab_creator (creator_id),
  KEY ix_collab_owner (owner_id, status),
  CONSTRAINT fk_collab_creator FOREIGN KEY (creator_id) REFERENCES creator(id),
  CONSTRAINT fk_collab_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_collab_spu FOREIGN KEY (spu_id) REFERENCES product_spu(id),
  CONSTRAINT fk_collab_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表11 合作单表';

CREATE TABLE IF NOT EXISTS sample_shipment (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  collab_id     BIGINT UNSIGNED,
  creator_id    BIGINT UNSIGNED NOT NULL,
  sku_id        BIGINT UNSIGNED,
  quantity      INT           NOT NULL DEFAULT 1,
  shipping_cost DECIMAL(18,2) NOT NULL DEFAULT 0,       -- 寄样运费（人民币，我们掏的钱；样品货值由品牌承担）
  ship_method   TINYINT       NOT NULL DEFAULT 2,       -- 1平台免费样品 2线下自寄 3海外仓代发
  tk_order_id   VARCHAR(64),
  tracking_no   VARCHAR(64),
  ship_time     DATETIME,
  sign_time     DATETIME,
  status        TINYINT       NOT NULL DEFAULT 1,       -- 1待发 2在途 3已签收 4已出内容 5超期未出内容 6丢件
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT       NOT NULL DEFAULT 0,
  KEY ix_sample_collab (collab_id),
  KEY ix_sample_creator (creator_id),
  KEY ix_sample_status (status, sign_time),
  CONSTRAINT fk_sample_collab FOREIGN KEY (collab_id) REFERENCES collaboration(id),
  CONSTRAINT fk_sample_creator FOREIGN KEY (creator_id) REFERENCES creator(id),
  CONSTRAINT fk_sample_sku FOREIGN KEY (sku_id) REFERENCES product_sku(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表12 寄样表';

CREATE TABLE IF NOT EXISTS video (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tk_video_id    VARCHAR(64),
  video_url      VARCHAR(500)  NOT NULL,
  publisher_type TINYINT       NOT NULL DEFAULT 1,      -- 1自有账号 2达人
  account_id     BIGINT UNSIGNED,
  creator_id     BIGINT UNSIGNED,
  collab_id      BIGINT UNSIGNED,
  spu_id         BIGINT UNSIGNED,
  shop_id        BIGINT UNSIGNED,
  publish_time   DATETIME,
  editor_id      BIGINT UNSIGNED,                        -- 编导/剪辑（自有视频绩效）
  views          BIGINT        NOT NULL DEFAULT 0,
  likes          INT           NOT NULL DEFAULT 0,
  comments       INT           NOT NULL DEFAULT 0,
  shares         INT           NOT NULL DEFAULT 0,
  orders         INT           NOT NULL DEFAULT 0,      -- 系统汇总
  gmv            DECIMAL(18,2) NOT NULL DEFAULT 0,      -- 系统汇总
  status         TINYINT       NOT NULL DEFAULT 1,
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tk_video_id (tk_video_id, is_deleted),
  KEY ix_video_creator (creator_id),
  KEY ix_video_collab (collab_id),
  KEY ix_video_editor (editor_id),
  CONSTRAINT fk_video_account FOREIGN KEY (account_id) REFERENCES tk_account(id),
  CONSTRAINT fk_video_creator FOREIGN KEY (creator_id) REFERENCES creator(id),
  CONSTRAINT fk_video_collab FOREIGN KEY (collab_id) REFERENCES collaboration(id),
  CONSTRAINT fk_video_spu FOREIGN KEY (spu_id) REFERENCES product_spu(id),
  CONSTRAINT fk_video_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_video_editor FOREIGN KEY (editor_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表13 视频表';

CREATE TABLE IF NOT EXISTS live_session (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id   BIGINT UNSIGNED,
  shop_id      BIGINT UNSIGNED NOT NULL,
  host_id      BIGINT UNSIGNED,
  assistant_id BIGINT UNSIGNED,
  creator_id   BIGINT UNSIGNED,                          -- 达人专场时填
  plan_start   DATETIME,                                  -- 排班
  plan_end     DATETIME,
  actual_start DATETIME,
  actual_end   DATETIME,
  viewers      INT           NOT NULL DEFAULT 0,
  peak_online  INT           NOT NULL DEFAULT 0,
  orders       INT           NOT NULL DEFAULT 0,
  gmv          DECIMAL(18,2) NOT NULL DEFAULT 0,
  ad_spend     DECIMAL(18,2) NOT NULL DEFAULT 0,         -- 本场投流花费
  review_note  TEXT,                                      -- 复盘记录
  status       TINYINT       NOT NULL DEFAULT 1,         -- 1已排班 2直播中 3已结束 4取消
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT       NOT NULL DEFAULT 0,
  -- MySQL 没有部分索引：把「未删除行的计划开播时间」显式成生成列，
  -- 删除的行恒为 NULL，而 NULL 不参与唯一性比较 —— 等价于 SQLite 的 WHERE is_deleted = 0
  live_key     VARCHAR(32)   GENERATED ALWAYS AS (IF(is_deleted = 0, DATE_FORMAT(plan_start, '%Y-%m-%d %H:%i:%s'), NULL)) STORED,
  UNIQUE KEY ux_live_shop_plan_start (shop_id, live_key),
  KEY ix_live_shop_plan (shop_id, plan_start),
  KEY ix_live_host (host_id, plan_start),
  CONSTRAINT fk_live_account FOREIGN KEY (account_id) REFERENCES tk_account(id),
  CONSTRAINT fk_live_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_live_host FOREIGN KEY (host_id) REFERENCES sys_user(id),
  CONSTRAINT fk_live_assistant FOREIGN KEY (assistant_id) REFERENCES sys_user(id),
  CONSTRAINT fk_live_creator FOREIGN KEY (creator_id) REFERENCES creator(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表14 直播场次表';

CREATE TABLE IF NOT EXISTS ad_daily (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stat_date     DATE          NOT NULL,                 -- 按店铺站点时区的自然日
  advertiser_id VARCHAR(64),
  shop_id       BIGINT UNSIGNED NOT NULL,
  campaign_id   VARCHAR(64),
  campaign_name VARCHAR(200),
  ad_type       TINYINT       NOT NULL DEFAULT 1,       -- 1GMV Max商品 2GMV Max直播 3视频投流 4达人授权投放
  spu_id        BIGINT UNSIGNED,
  video_id      BIGINT UNSIGNED,
  spend         DECIMAL(18,2) NOT NULL DEFAULT 0,
  currency      CHAR(3)       NOT NULL DEFAULT 'USD',
  impressions   BIGINT        NOT NULL DEFAULT 0,
  clicks        INT           NOT NULL DEFAULT 0,
  conversions   INT           NOT NULL DEFAULT 0,
  gmv           DECIMAL(18,2) NOT NULL DEFAULT 0,       -- ROI = GMV ÷ 消耗
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_ad_daily (shop_id, campaign_id, stat_date, ad_type, is_deleted),
  KEY ix_ad_daily_date (stat_date),
  CONSTRAINT fk_ad_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_ad_spu FOREIGN KEY (spu_id) REFERENCES product_spu(id),
  CONSTRAINT fk_ad_video FOREIGN KEY (video_id) REFERENCES video(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表15 广告日报表';

CREATE TABLE IF NOT EXISTS settlement_txn (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id        BIGINT UNSIGNED NOT NULL,
  statement_id   VARCHAR(64),
  statement_time DATETIME,
  tk_order_id    VARCHAR(64),                            -- 非订单类调整为空
  txn_type       TINYINT       NOT NULL DEFAULT 1,       -- 1订单收入 2退款 3平台佣金 4达人佣金 5运费 6平台补贴 7调整 8其他
  amount         DECIMAL(18,2) NOT NULL DEFAULT 0,       -- 收入为正 扣款为负
  currency       CHAR(3)       NOT NULL DEFAULT 'USD',
  payment_id     VARCHAR(64),
  payment_status TINYINT       NOT NULL DEFAULT 2,       -- 1已打款 2处理中 3失败
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_settle_txn (shop_id, statement_id, tk_order_id, txn_type, is_deleted),
  KEY ix_settle_order (tk_order_id),
  KEY ix_settle_time (statement_time),
  CONSTRAINT fk_settle_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表16 结算流水表（利润以此为实际口径）';

CREATE TABLE IF NOT EXISTS expense (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  expense_date DATE          NOT NULL,
  expense_type TINYINT       NOT NULL DEFAULT 1,         -- 1达人坑位费 2头程物流 3海外仓费 4工具订阅 5服务费 6其他
  shop_id      BIGINT UNSIGNED,                           -- 空 = 公共费用，按规则分摊
  ref_type     VARCHAR(32),                               -- collaboration / sample_shipment / live_session
  ref_id       BIGINT UNSIGNED,
  amount       DECIMAL(18,2) NOT NULL DEFAULT 0,
  currency     CHAR(3)       NOT NULL DEFAULT 'CNY',
  amount_cny   DECIMAL(18,2) NOT NULL DEFAULT 0,         -- 按汇率表自动折算
  payee        VARCHAR(100),
  voucher      VARCHAR(500),
  status       TINYINT       NOT NULL DEFAULT 1,         -- 1待付款 2已付款
  remark       VARCHAR(500),
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT       NOT NULL DEFAULT 0,
  KEY ix_expense_shop_date (shop_id, expense_date),
  KEY ix_expense_ref (ref_type, ref_id),
  CONSTRAINT fk_expense_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表17 费用表';

CREATE TABLE IF NOT EXISTS exchange_rate (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rate_date   DATE          NOT NULL,
  currency    CHAR(3)       NOT NULL,
  rate_to_cny DECIMAL(18,6) NOT NULL,                    -- 1 单位外币 = ? 人民币
  source      TINYINT       NOT NULL DEFAULT 2,          -- 1 Frankfurter公开API 2手工 3延用前值 4演示数据
  created_by  BIGINT UNSIGNED,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted  TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_rate (rate_date, currency, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表18 汇率表';

CREATE TABLE IF NOT EXISTS warehouse (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  wh_type    TINYINT      NOT NULL DEFAULT 1,            -- 1国内仓 2海外仓 3平台仓
  region     VARCHAR(8),
  status     TINYINT      NOT NULL DEFAULT 1,            -- 1启用 0停用
  created_by BIGINT UNSIGNED,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT      NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表19 仓库表';

CREATE TABLE IF NOT EXISTS stock_ledger (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  sku_id       BIGINT UNSIGNED NOT NULL,
  change_type  TINYINT  NOT NULL DEFAULT 1,              -- 1品牌入仓 2头程调拨 3调拨 4销售出库 5样品出库 6退货入库 7盘点调整
  quantity     INT      NOT NULL DEFAULT 0,              -- 入库为正 出库为负
  ref_no       VARCHAR(64),
  op_time      DATETIME NOT NULL,
  operator_id  BIGINT UNSIGNED,
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT  NOT NULL DEFAULT 0,
  KEY ix_stock_wh_sku (warehouse_id, sku_id, op_time),
  CONSTRAINT fk_stock_wh FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
  CONSTRAINT fk_stock_sku FOREIGN KEY (sku_id) REFERENCES product_sku(id),
  CONSTRAINT fk_stock_operator FOREIGN KEY (operator_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表20 库存流水表（库存=流水汇总）';

CREATE TABLE IF NOT EXISTS sys_user_shop (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  shop_id    BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT      NOT NULL DEFAULT 0,
  UNIQUE KEY ux_user_shop (user_id, shop_id, is_deleted),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_us_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表23 数据权限表（员工×店铺）';

CREATE TABLE IF NOT EXISTS sys_op_log (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  op_time      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  module       VARCHAR(50)  NOT NULL,
  action       VARCHAR(20)  NOT NULL,                    -- create / update / delete / export / login
  target_table VARCHAR(50),
  target_id    BIGINT UNSIGNED,
  before_after JSON,                                      -- {"before":{},"after":{}}
  ip           VARCHAR(64),
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT      NOT NULL DEFAULT 0,
  KEY ix_op_log_user (user_id, op_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表24 操作日志表（系统写入，不可修改）';

CREATE TABLE IF NOT EXISTS sync_log (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_type    VARCHAR(32) NOT NULL,                     -- order / product / listing / returns / settlement / affiliate_order / ad / video / live
  shop_id      BIGINT UNSIGNED,
  window_start DATETIME,
  window_end   DATETIME,
  fetched      INT         NOT NULL DEFAULT 0,
  inserted     INT         NOT NULL DEFAULT 0,
  updated      INT         NOT NULL DEFAULT 0,
  failed       INT         NOT NULL DEFAULT 0,
  status       TINYINT     NOT NULL DEFAULT 1,           -- 1成功 2部分失败 3失败
  error_msg    TEXT,                                      -- 写入前必须过滤凭证字段
  started_at   DATETIME,
  finished_at  DATETIME,
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT     NOT NULL DEFAULT 0,
  KEY ix_sync_log_shop (shop_id, task_type, started_at),
  CONSTRAINT fk_synclog_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表25 同步日志表（失败/0条即告警）';

CREATE TABLE IF NOT EXISTS job_queue (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_type     VARCHAR(64)   NOT NULL COMMENT '必须在队列注册表里注册过',
  payload_json TEXT          COMMENT '入参 JSON 文本',
  status       TINYINT       NOT NULL DEFAULT 0 COMMENT '0待跑 1在跑 2成功 3失败',
  attempts     INT           NOT NULL DEFAULT 0,
  max_attempts INT           NOT NULL DEFAULT 3,
  run_after    DATETIME      COMMENT '退避到点才可领取',
  started_at   DATETIME,
  finished_at  DATETIME,
  worker       VARCHAR(64)   COMMENT '谁领走了（排查重复执行）',
  result_json  TEXT          COMMENT '出参摘要',
  error_msg    TEXT          COMMENT '已脱敏',
  created_by   BIGINT UNSIGNED,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT       NOT NULL DEFAULT 0,
  KEY ix_job_queue_claim (status, run_after, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表即队列：重活从请求周期里摘出来';

CREATE TABLE IF NOT EXISTS sys_dict (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dict_type  VARCHAR(50)  NOT NULL,                      -- category / creator_tag / return_reason / expense_type ...
  dict_value VARCHAR(50)  NOT NULL,
  dict_label VARCHAR(100) NOT NULL,
  sort       INT          NOT NULL DEFAULT 0,
  status     TINYINT      NOT NULL DEFAULT 1,            -- 1启用 0停用
  created_by BIGINT UNSIGNED,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT      NOT NULL DEFAULT 0,
  UNIQUE KEY ux_dict (dict_type, dict_value, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表26 数据字典表';

-- ============================================================
-- V2.0 增补（§15.2 分析宽表 + §15.3 预警与动作闭环）
-- 软删除唯一键沿用本文件约定：UNIQUE KEY 带 is_deleted 列；
-- 同一对象多次删除时，删除方需把 is_deleted 置为主键 id 以避开唯一冲突。
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics_shop_channel_daily (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stat_date  DATE          NOT NULL,
  shop_id    BIGINT UNSIGNED NOT NULL,
  channel    VARCHAR(20)   NOT NULL,                      -- product_card/live/video/affiliate/ads/organic
  visitors   INT           NOT NULL DEFAULT 0,
  orders     INT           NOT NULL DEFAULT 0,
  gmv        DECIMAL(18,2) NOT NULL DEFAULT 0,            -- 毛 GMV（人民币）
  refund     DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_gmv    DECIMAL(18,2) NOT NULL DEFAULT 0,
  ad_spend   DECIMAL(18,2) NOT NULL DEFAULT 0,
  source     VARCHAR(10)   NOT NULL DEFAULT 'fact',      -- fact/import/mock
  created_by BIGINT UNSIGNED,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_ascd (stat_date, shop_id, channel, is_deleted),
  CONSTRAINT fk_ascd_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 分析宽表：店铺x渠道x日';

CREATE TABLE IF NOT EXISTS analytics_product_channel_daily (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stat_date  DATE          NOT NULL,
  shop_id    BIGINT UNSIGNED NOT NULL,
  spu_id     BIGINT UNSIGNED NOT NULL,
  channel    VARCHAR(20)   NOT NULL,
  impression INT           NOT NULL DEFAULT 0,
  click      INT           NOT NULL DEFAULT 0,
  add_cart   INT           NOT NULL DEFAULT 0,
  orders     INT           NOT NULL DEFAULT 0,
  gmv        DECIMAL(18,2) NOT NULL DEFAULT 0,
  refund     DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_gmv    DECIMAL(18,2) NOT NULL DEFAULT 0,
  source     VARCHAR(10)   NOT NULL DEFAULT 'fact',
  created_by BIGINT UNSIGNED,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_apcd (stat_date, spu_id, channel, is_deleted),
  CONSTRAINT fk_apcd_shop FOREIGN KEY (shop_id) REFERENCES tk_shop(id),
  CONSTRAINT fk_apcd_spu FOREIGN KEY (spu_id) REFERENCES product_spu(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 分析宽表：商品x渠道x日（ABC/漂移/漏斗）';

CREATE TABLE IF NOT EXISTS analytics_creator_daily (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stat_date   DATE          NOT NULL,
  creator_id  BIGINT UNSIGNED NOT NULL,
  shop_id     BIGINT UNSIGNED,
  orders      INT           NOT NULL DEFAULT 0,
  gmv         DECIMAL(18,2) NOT NULL DEFAULT 0,
  refund      DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_gmv     DECIMAL(18,2) NOT NULL DEFAULT 0,
  rebate DECIMAL(18,2) NOT NULL DEFAULT 0,
  sample_shipping DECIMAL(18,2) NOT NULL DEFAULT 0,
  commission  DECIMAL(18,2) NOT NULL DEFAULT 0,
  source      VARCHAR(10)   NOT NULL DEFAULT 'fact',
  created_by  BIGINT UNSIGNED,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted  TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_acd (stat_date, creator_id, is_deleted),
  CONSTRAINT fk_acd_creator FOREIGN KEY (creator_id) REFERENCES creator(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 分析宽表：达人x日（效率与趋势）';

CREATE TABLE IF NOT EXISTS analytics_video_daily (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stat_date     DATE          NOT NULL,
  video_id      BIGINT UNSIGNED NOT NULL,
  views         INT           NOT NULL DEFAULT 0,
  product_click INT           NOT NULL DEFAULT 0,
  orders        INT           NOT NULL DEFAULT 0,
  gmv           DECIMAL(18,2) NOT NULL DEFAULT 0,
  refund        DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_gmv       DECIMAL(18,2) NOT NULL DEFAULT 0,
  ad_spend      DECIMAL(18,2) NOT NULL DEFAULT 0,
  source        VARCHAR(10)   NOT NULL DEFAULT 'fact',
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_avd (stat_date, video_id, is_deleted),
  CONSTRAINT fk_avd_video FOREIGN KEY (video_id) REFERENCES video(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 分析宽表：视频x日（生命周期/衰减）';

CREATE TABLE IF NOT EXISTS analytics_live_minute (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  live_session_id    BIGINT UNSIGNED NOT NULL,
  minute_ts          DATETIME      NOT NULL,
  online_users       INT           NOT NULL DEFAULT 0,
  product_click      INT           NOT NULL DEFAULT 0,
  orders             INT           NOT NULL DEFAULT 0,
  gmv                DECIMAL(18,2) NOT NULL DEFAULT 0,
  paid_traffic_ratio DECIMAL(5,4)  NOT NULL DEFAULT 0,
  source             VARCHAR(10)   NOT NULL DEFAULT 'import',
  created_by         BIGINT UNSIGNED,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted         TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_alm (live_session_id, minute_ts, is_deleted),
  CONSTRAINT fk_alm_live FOREIGN KEY (live_session_id) REFERENCES live_session(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 分析宽表：直播分钟曲线（接口不覆盖时导入）';

CREATE TABLE IF NOT EXISTS alert_rule (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_code      VARCHAR(50)   NOT NULL,
  rule_name      VARCHAR(100)  NOT NULL,
  target_type    VARCHAR(20)   NOT NULL,                  -- product/creator/video/live/sample/shop/ads
  scope_json     JSON          NOT NULL,
  metric         VARCHAR(50)   NOT NULL,
  operator       VARCHAR(4)    NOT NULL DEFAULT '>',
  threshold      DECIMAL(18,4) NOT NULL DEFAULT 0,
  window_days    INT           NOT NULL DEFAULT 7,
  priority       TINYINT       NOT NULL DEFAULT 1,        -- 0=P0 1=P1 2=P2
  cooldown_hours INT           NOT NULL DEFAULT 24,
  version        INT           NOT NULL DEFAULT 1,
  status         TINYINT       NOT NULL DEFAULT 1,
  params_json    JSON          NOT NULL,
  remark         VARCHAR(255),
  created_by     BIGINT UNSIGNED,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_rule_code (rule_code, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 预警规则定义（阈值全配置化，附录 B 为默认值）';

CREATE TABLE IF NOT EXISTS alert_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id       BIGINT UNSIGNED NOT NULL,
  target_type   VARCHAR(20)   NOT NULL,
  target_id     BIGINT UNSIGNED,
  target_name   VARCHAR(200),
  shop_id       BIGINT UNSIGNED,
  detected_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_json JSON          NOT NULL,
  priority      TINYINT       NOT NULL DEFAULT 1,
  status        TINYINT       NOT NULL DEFAULT 0,         -- 0待处理 1处理中 2已处理 3已忽略
  owner_id      BIGINT UNSIGNED,
  due_at        DATETIME,
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted    TINYINT       NOT NULL DEFAULT 0,
  KEY ix_event_rule_target (rule_id, target_type, target_id, detected_at),
  KEY ix_event_status (status, priority, detected_at),
  CONSTRAINT fk_event_rule FOREIGN KEY (rule_id) REFERENCES alert_rule(id),
  CONSTRAINT fk_event_owner FOREIGN KEY (owner_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 预警事件（一次具体预警，不覆盖历史）';

CREATE TABLE IF NOT EXISTS user_notification (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recipient_id       BIGINT UNSIGNED NOT NULL,
  alert_event_id     BIGINT UNSIGNED NOT NULL,
  notification_type  VARCHAR(32)   NOT NULL DEFAULT 'alert_due',
  due_at_snapshot    DATETIME      NOT NULL,                        -- 与 alert_event.due_at 同类型，快照比较不能靠隐式转换
  assignment_cycle   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  read_at            DATETIME,
  stale_at           DATETIME,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted         TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_user_notification_dedupe (recipient_id, alert_event_id, due_at_snapshot, assignment_cycle, is_deleted),
  KEY ix_user_notification_inbox (recipient_id, is_deleted, stale_at, read_at, created_at),
  CONSTRAINT fk_user_notification_recipient FOREIGN KEY (recipient_id) REFERENCES sys_user(id),
  CONSTRAINT fk_user_notification_event FOREIGN KEY (alert_event_id) REFERENCES alert_event(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人预警到期提醒收件箱';

CREATE TABLE IF NOT EXISTS operation_action (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  alert_event_id  BIGINT UNSIGNED NOT NULL,
  handler_id      BIGINT UNSIGNED NOT NULL,
  action_type     VARCHAR(20)   NOT NULL,                 -- handle/ignore/transfer/note
  action_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note            VARCHAR(500),
  expected_result VARCHAR(500),
  observe_until   DATETIME,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted      TINYINT       NOT NULL DEFAULT 0,
  KEY ix_action_event (alert_event_id),
  CONSTRAINT fk_action_event FOREIGN KEY (alert_event_id) REFERENCES alert_event(id),
  CONSTRAINT fk_action_handler FOREIGN KEY (handler_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 运营处理动作（人/类型/时间/备注/预期）';

CREATE TABLE IF NOT EXISTS action_result (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action_id        BIGINT UNSIGNED NOT NULL,
  evaluated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  before_json      JSON          NOT NULL,
  after_json       JSON          NOT NULL,
  result           VARCHAR(20)   NOT NULL DEFAULT 'pending', -- improved/unchanged/worse/pending
  improvement_rate DECIMAL(8,4),
  note             VARCHAR(500),
  created_by       BIGINT UNSIGNED,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted       TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_result_action (action_id, is_deleted),
  CONSTRAINT fk_result_action FOREIGN KEY (action_id) REFERENCES operation_action(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V2 动作效果回看（观察期后对比前后指标）';

-- ============ 选品管理（方案第十一章：候选品从登记到正式销售的五阶段流水线） ============
-- 与 schema.sqlite.sql 的表/列集合必须逐一对应（tests/schema-drift.spec.ts 会比对）

CREATE TABLE IF NOT EXISTS selection_flow (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(32)   NOT NULL,
  name             VARCHAR(255)  NOT NULL,
  image_url        VARCHAR(512),
  category         VARCHAR(64),
  brand_name       VARCHAR(128),
  list_price       DECIMAL(12,4) NOT NULL DEFAULT 0,
  planned_discount DECIMAL(8,4)  NOT NULL DEFAULT 0,
  rebate_rate      DECIMAL(8,4)  NOT NULL DEFAULT 0,
  commission_rate  DECIMAL(8,4)  NOT NULL DEFAULT 0,
  logistics_rate   DECIMAL(8,4)  NOT NULL DEFAULT 0,
  est_margin       DECIMAL(8,4)  NOT NULL DEFAULT 0,
  breakeven_roas   DECIMAL(8,4)  NOT NULL DEFAULT 0,
  source           VARCHAR(32),
  shop_id          BIGINT,
  spu_id           BIGINT,
  stage            TINYINT       NOT NULL DEFAULT 1,
  stage_entered_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  owner_id         BIGINT,
  registered_by    BIGINT,
  conclusion       TINYINT       NOT NULL DEFAULT 0,
  conclusion_note  TEXT,
  reject_reason    TEXT,
  adjustments      TEXT,
  test_started_at  DATETIME,
  test_snapshot    JSON          NOT NULL,
  checklist        JSON          NOT NULL,
  selling_at       DATETIME,
  remark           VARCHAR(512),
  created_by       BIGINT,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted       TINYINT       NOT NULL DEFAULT 0,
  UNIQUE KEY ux_selection_code (code, is_deleted),
  KEY ix_selection_stage (stage, stage_entered_at),
  KEY ix_selection_owner (owner_id, stage),
  KEY ix_selection_shop (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V3 选品流水线状态（五阶段）';

CREATE TABLE IF NOT EXISTS selection_log (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  selection_id   BIGINT      NOT NULL,
  from_stage     TINYINT     NOT NULL,
  to_stage       TINYINT     NOT NULL,
  action         VARCHAR(32) NOT NULL DEFAULT 'transition',
  operator_id    BIGINT,
  note           TEXT,
  created_by     BIGINT,
  created_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted     TINYINT     NOT NULL DEFAULT 0,
  KEY ix_selection_log_flow (selection_id, id),
  CONSTRAINT fk_selection_log_flow FOREIGN KEY (selection_id) REFERENCES selection_flow(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='V3 选品阶段流转日志';
