/** 数据实体类型：字段与 docs/schema 保持一致，供前后端共用 */
import type { MenuKey } from './constants.js';

export interface BaseEntity {
  id: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  is_deleted: 0 | 1;
}

export interface SysUser extends BaseEntity {
  username: string;
  real_name: string;
  phone: string | null;
  dept: string | null;
  role_id: number;
  status: number;
  last_login_at: string | null;
}

export interface SysRole extends BaseEntity {
  role_name: string;
  role_key: string;
  menu_perms: MenuKey[];
  data_scope: number;
  can_see_cost: 0 | 1;
  can_see_contact: 0 | 1;
  can_export: 0 | 1;
}

export interface CurrentUser {
  id: number;
  username: string;
  real_name: string;
  dept: string | null;
  role_key: string;
  role_name: string;
  data_scope: number;
  can_see_cost: boolean;
  can_see_contact: boolean;
  can_export: boolean;
  menu_perms: MenuKey[];
  shop_ids: number[];
}

export interface TkShop extends BaseEntity {
  shop_name: string;
  tk_shop_id: string | null;
  shop_cipher: string | null;
  region: string;
  shop_type: number;
  currency: string;
  timezone: string;
  auth_status: number;
  token_expire_at: string | null;
  owner_id: number | null;
  status: number;
  owner_name?: string | null;
}

export interface TkAccount extends BaseEntity {
  handle: string;
  nickname: string | null;
  account_type: number;
  shop_id: number | null;
  region: string | null;
  followers: number;
  owner_id: number | null;
  account_status: number;
  remark: string | null;
  shop_name?: string | null;
}

export interface ProductSpu extends BaseEntity {
  spu_code: string;
  name_cn: string;
  name_en: string | null;
  category: string | null;
  main_image: string | null;
  owner_id: number | null;
  status: number;
  sku_count?: number;
}

export interface ProductSku extends BaseEntity {
  spu_id: number;
  sku_code: string;
  spec: string | null;
  purchase_cost: number;
  first_leg_cost: number;
  weight_g: number | null;
  package_size: string | null;
  status: number;
  spu_code?: string;
  name_cn?: string;
  unit_cost?: number;
}

export interface ShopListing extends BaseEntity {
  shop_id: number;
  sku_id: number | null;
  tk_product_id: string | null;
  tk_sku_id: string | null;
  seller_sku: string | null;
  product_name: string | null;
  sale_price: number;
  listing_status: number;
  map_status: number;
  last_sync_at: string | null;
  shop_name?: string | null;
  sku_code?: string | null;
}

export interface TkOrder extends BaseEntity {
  shop_id: number;
  tk_order_id: string;
  order_status: string;
  order_time: string | null;
  paid_time: string | null;
  ship_time: string | null;
  buyer_region: string | null;
  currency: string;
  subtotal: number;
  seller_discount: number;
  platform_discount: number;
  shipping_fee: number;
  total_paid: number;
  fulfillment_type: number;
  carrier: string | null;
  tracking_no: string | null;
  is_sample_order: 0 | 1;
  synced_at: string | null;
  shop_name?: string | null;
  item_count?: number;
  est_profit?: number | null;
}

export interface TkOrderItem extends BaseEntity {
  order_id: number;
  listing_id: number | null;
  sku_id: number | null;
  quantity: number;
  unit_price: number;
  discount: number;
  item_amount: number;
  cost_snapshot: number;
  cost_matched: 0 | 1;
  creator_id: number | null;
  content_type: number | null;
  content_id: string | null;
  commission_rate: number;
  est_commission: number;
  sku_code?: string | null;
  creator_handle?: string | null;
}

export interface TkReturn extends BaseEntity {
  order_id: number | null;
  shop_id: number;
  tk_return_id: string;
  tk_order_item_id: number | null;
  return_type: number;
  reason: string | null;
  refund_amount: number;
  currency: string;
  status: string;
  apply_time: string | null;
  finish_time: string | null;
  responsibility: number;
  is_restocked: 0 | 1;
  shop_name?: string | null;
}

export interface Creator extends BaseEntity {
  handle: string;
  nickname: string | null;
  region: string | null;
  followers: number;
  category_tags: string | null;
  avg_views: number;
  gmv_level: string | null;
  email: string | null;
  whatsapp: string | null;
  owner_id: number | null;
  protect_until: string | null;
  pool_status: number;
  source: number;
  owner_name?: string | null;
}

export interface CreatorOutreach extends BaseEntity {
  creator_id: number;
  user_id: number;
  channel: number;
  contact_time: string;
  summary: string | null;
  result: number;
  next_follow_at: string | null;
  creator_handle?: string | null;
  user_name?: string | null;
}

export interface Collaboration extends BaseEntity {
  collab_no: string;
  creator_id: number;
  shop_id: number;
  spu_id: number | null;
  coop_type: number;
  commission_rate: number;
  fixed_fee: number;
  fee_currency: string;
  promised_videos: number;
  promised_lives: number;
  deadline: string | null;
  tk_plan_id: string | null;
  status: number;
  owner_id: number | null;
  creator_handle?: string | null;
  shop_name?: string | null;
  spu_name?: string | null;
  owner_name?: string | null;
}

export interface SampleShipment extends BaseEntity {
  collab_id: number | null;
  creator_id: number;
  sku_id: number | null;
  quantity: number;
  sample_cost: number;
  shipping_cost: number;
  ship_method: number;
  tk_order_id: string | null;
  tracking_no: string | null;
  ship_time: string | null;
  sign_time: string | null;
  status: number;
  creator_handle?: string | null;
  sku_code?: string | null;
  collab_no?: string | null;
}

export interface Video extends BaseEntity {
  tk_video_id: string | null;
  video_url: string;
  publisher_type: number;
  account_id: number | null;
  creator_id: number | null;
  collab_id: number | null;
  spu_id: number | null;
  shop_id: number | null;
  publish_time: string | null;
  editor_id: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  orders: number;
  gmv: number;
  creator_handle?: string | null;
  account_handle?: string | null;
  editor_name?: string | null;
  spu_name?: string | null;
}

export interface LiveSession extends BaseEntity {
  account_id: number | null;
  shop_id: number;
  host_id: number | null;
  assistant_id: number | null;
  creator_id: number | null;
  plan_start: string | null;
  plan_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  viewers: number;
  peak_online: number;
  orders: number;
  gmv: number;
  ad_spend: number;
  review_note: string | null;
  status: number;
  host_name?: string | null;
  shop_name?: string | null;
}

export interface AdDaily extends BaseEntity {
  stat_date: string;
  advertiser_id: string | null;
  shop_id: number;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_type: number;
  spu_id: number | null;
  video_id: number | null;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
  conversions: number;
  gmv: number;
  roi?: number | null;
}

export interface SettlementTxn extends BaseEntity {
  shop_id: number;
  statement_id: string | null;
  statement_time: string | null;
  tk_order_id: string | null;
  txn_type: number;
  amount: number;
  currency: string;
  payment_id: string | null;
  payment_status: number;
}

export interface Expense extends BaseEntity {
  expense_date: string;
  expense_type: number;
  shop_id: number | null;
  ref_type: string | null;
  ref_id: number | null;
  amount: number;
  currency: string;
  amount_cny: number;
  payee: string | null;
  voucher: string | null;
  status: number;
  remark: string | null;
}

export interface ExchangeRate extends BaseEntity {
  rate_date: string;
  currency: string;
  rate_to_cny: number;
  source: number;
}

export interface Warehouse extends BaseEntity {
  name: string;
  wh_type: number;
  region: string | null;
  status: number;
}

export interface StockLedger extends BaseEntity {
  warehouse_id: number;
  sku_id: number;
  change_type: number;
  quantity: number;
  ref_no: string | null;
  op_time: string;
  operator_id: number | null;
}

export interface SyncLog extends BaseEntity {
  task_type: string;
  shop_id: number | null;
  window_start: string | null;
  window_end: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  status: number;
  error_msg: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SysOpLog extends BaseEntity {
  user_id: number;
  op_time: string;
  module: string;
  action: string;
  target_table: string | null;
  target_id: number | null;
  before_after: string | null;
  ip: string | null;
  user_name?: string | null;
}

export interface SysDict extends BaseEntity {
  dict_type: string;
  dict_value: string;
  dict_label: string;
  sort: number;
  status: number;
}

/** 工作台看板指标 */
export interface DashboardSummary {
  gmv: number;
  orders: number;
  refund_amount: number;
  refund_rate: number;
  est_cost: number;
  est_gross_profit: number;
  est_profit_rate: number;
  settled_amount: number;
  ad_spend: number;
  ad_gmv: number;
  ad_roi: number | null;
  unmapped_listings: number;
  creators_to_follow: number;
  samples_overdue: number;
  auth_expiring: number;
  sync_failed: number;
  live_today: number;
  gmv_trend: { date: string; gmv: number; orders: number; profit: number }[];
  shop_rank: { shop_id: number; shop_name: string; gmv: number; orders: number; profit: number }[];
  creator_rank: { creator_id: number; handle: string; gmv: number; orders: number; cost: number; roi: number | null }[];
  content_type_split: { type: string; gmv: number; orders: number }[];
  bd_rank: { user_id: number; real_name: string; outreach: number; agreed: number; gmv: number }[];
  can_see_cost: boolean;
}

/** 利润报表行 */
export interface ProfitRow {
  dim_key: string;
  dim_name: string;
  currency: string;
  gmv: number;
  refund: number;
  net_gmv: number;
  cost: number;
  commission: number;
  ad_spend: number;
  expense: number;
  settled_amount: number;
  profit: number;
  profit_rate: number;
  is_estimated: 0 | 1;
  orders: number;
}
