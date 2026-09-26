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
  /** 品牌给的返点率（小数，0.18 = 实收 GMV 的 18% 归我们）—— 我们唯一的收入口径 */
  rebate_rate: number;
  /** 单件物流成本（头程 + 海外仓，人民币），品牌方承担时填 0 */
  logistics_cost: number;
  weight_g: number | null;
  package_size: string | null;
  status: number;
  spu_code?: string;
  name_cn?: string;
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
  /** 冻结在成交时刻的品牌返点率（事后改 SKU 不影响历史单） */
  rebate_rate: number;
  /** 冻结的应收返点（人民币）= 实收折 CNY × rebate_rate */
  rebate_cny: number;
  /** 冻结的物流支出（人民币）= 单件物流成本 × 数量 */
  logistics_cny: number;
  /** 0 = 这一行还没配到返点率：不参与利润，也不许当成 0 收入（同「未映射不计成本」） */
  rebate_matched: 0 | 1;
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
  /** 寄样运费（我们掏的钱；样品货值是品牌出的，不再记在我们成本里） */
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
  est_rebate: number;
  est_logistics: number;
  est_gross_profit: number;
  est_profit_rate: number;
  settled_amount: number;
  ad_spend: number | null;
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
  /** `rebate` 是我们从该达人带货里应得的返点；`roi` = 返点 ÷（物流+佣金+广告+费用） */
  creator_rank: { creator_id: number; handle: string; gmv: number; orders: number; rebate: number; roi: number | null }[];
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
  /** 应收返点（人民币）：我们唯一收入，= 实收 × 成交时冻结的返点率 */
  rebate: number;
  /** 物流支出（人民币，头程/海外仓）；品牌承担时为 0 */
  logistics: number;
  commission: number;
  ad_spend: number;
  expense: number;
  settled_amount: number;
  profit: number;
  profit_rate: number;
  is_estimated: 0 | 1;
  orders: number;
}

/* ==================== V2.0 分析宽表与预警动作闭环（§15.2/§15.3） ==================== */

export const CHANNELS = ['product_card', 'live', 'video', 'affiliate', 'ads', 'organic'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = {
  product_card: '商品卡',
  live: '直播',
  video: '短视频',
  affiliate: '联盟',
  ads: '付费广告',
  organic: '自然流量',
};

/** content_type(1达人视频 2达人直播 3自营视频 4自营直播 5商品卡) → 分析渠道；空值按有无达人归联盟/自然 */
export function channelOfContentType(contentType: number | null, creatorId?: number | null): Channel {
  if (contentType === 1 || contentType === 3) return 'video';
  if (contentType === 2 || contentType === 4) return 'live';
  if (contentType === 5) return 'product_card';
  return creatorId ? 'affiliate' : 'organic';
}

export interface ShopChannelDaily {
  stat_date: string;
  shop_id: number;
  channel: Channel;
  visitors: number;
  orders: number;
  gmv: number;
  refund: number;
  net_gmv: number;
  ad_spend: number;
  source: string;
}

export interface ProductChannelDaily {
  stat_date: string;
  shop_id: number;
  spu_id: number;
  channel: Channel;
  impression: number;
  click: number;
  add_cart: number;
  orders: number;
  gmv: number;
  refund: number;
  net_gmv: number;
  source: string;
}

export interface CreatorDaily {
  stat_date: string;
  creator_id: number;
  shop_id: number | null;
  orders: number;
  gmv: number;
  refund: number;
  net_gmv: number;
  /** 我们按这一天的实收 GMV 应得的返点（人民币） */
  rebate: number;
  /** 寄样运费（我们的支出；样品货值由品牌承担，不记这里） */
  sample_shipping: number;
  commission: number;
  source: string;
}

export interface VideoDaily {
  stat_date: string;
  video_id: number;
  views: number;
  product_click: number;
  orders: number;
  gmv: number;
  refund: number;
  net_gmv: number;
  ad_spend: number;
  source: string;
}

export interface LiveMinute {
  live_session_id: number;
  minute_ts: string;
  online_users: number;
  product_click: number;
  orders: number;
  gmv: number;
  paid_traffic_ratio: number;
  source: string;
}

export type AlertTargetType = 'product' | 'creator' | 'video' | 'live' | 'sample' | 'shop' | 'ads' | 'selection';
export type AlertOperator = '>' | '>=' | '<' | '<=' | '==';

export interface AlertRule {
  id: number;
  rule_code: string;
  rule_name: string;
  target_type: AlertTargetType;
  scope_json: string;
  metric: string;
  operator: AlertOperator;
  threshold: number;
  window_days: number;
  priority: 0 | 1 | 2;
  cooldown_hours: number;
  version: number;
  status: 0 | 1;
  params_json: string;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertEvent {
  id: number;
  rule_id: number;
  rule_code?: string;
  rule_name?: string;
  target_type: AlertTargetType;
  target_id: number | null;
  target_name: string | null;
  shop_id: number | null;
  detected_at: string;
  evidence_json: string;
  priority: 0 | 1 | 2;
  status: 0 | 1 | 2 | 3;
  owner_id: number | null;
  owner_name?: string;
  due_at: string | null;
  actions?: OperationAction[];
}

export interface OperationAction {
  id: number;
  alert_event_id: number;
  handler_id: number;
  handler_name?: string;
  action_type: 'handle' | 'ignore' | 'transfer' | 'note';
  action_at: string;
  note: string | null;
  expected_result: string | null;
  observe_until: string | null;
  result?: ActionResult;
}

export interface ActionResult {
  id: number;
  action_id: number;
  evaluated_at: string;
  before_json: string;
  after_json: string;
  result: 'improved' | 'unchanged' | 'worse' | 'pending';
  improvement_rate: number | null;
  note: string | null;
}

export const ALERT_PRIORITY_LABELS: Record<number, string> = { 0: 'P0 今日必处理', 1: 'P1 本周观察', 2: 'P2 趋势参考' };
export const ALERT_EVENT_STATUS_LABELS: Record<number, string> = { 0: '待处理', 1: '处理中', 2: '已处理', 3: '已忽略' };
export const ACTION_TYPE_LABELS: Record<string, string> = { handle: '处理', ignore: '忽略', transfer: '转派', note: '备注' };

/** 附录 B 默认规则（seed 落入 alert_rule；所有阈值必须在规则中心可改，不得写死） */
export const DEFAULT_ALERT_RULES: Omit<AlertRule, 'id' | 'created_at' | 'updated_at'>[] = [
  { rule_code: 'CHANNEL_DEPENDENCY', rule_name: '单渠道依赖红灯', target_type: 'product', scope_json: '{}', metric: 'max_channel_share', operator: '>', threshold: 0.8, window_days: 7, priority: 0, cooldown_hours: 24, version: 1, status: 1, params_json: '{"rising":true}', remark: '最大渠道占比>80%且持续上升；站点/类目/店铺可配' },
  { rule_code: 'CHANNEL_MIGRATION', rule_name: '渠道迁移', target_type: 'product', scope_json: '{}', metric: 'channel_share_delta', operator: '>', threshold: 0.15, window_days: 7, priority: 1, cooldown_hours: 48, version: 1, status: 1, params_json: '{}', remark: '渠道占比周环比变化绝对值>15pct' },
  { rule_code: 'SAMPLE_SILENT', rule_name: '样品签收未发布', target_type: 'sample', scope_json: '{}', metric: 'days_since_sign', operator: '>', threshold: 14, window_days: 14, priority: 0, cooldown_hours: 24, version: 1, status: 1, params_json: '{}', remark: '签收后>14天未发布；类目/合作类型可配' },
  { rule_code: 'CREATOR_REFUND', rule_name: '达人退货异常', target_type: 'creator', scope_json: '{}', metric: 'refund_rate_over_baseline', operator: '>', threshold: 0.05, window_days: 30, priority: 1, cooldown_hours: 72, version: 1, status: 1, params_json: '{}', remark: '退货率>类目基准+5pct，生成暂停寄样建议' },
  { rule_code: 'CREATOR_DECLINE', rule_name: '达人净GMV下滑', target_type: 'creator', scope_json: '{}', metric: 'weekly_net_gmv_decline_weeks', operator: '>=', threshold: 2, window_days: 28, priority: 1, cooldown_hours: 168, version: 1, status: 1, params_json: '{}', remark: '净GMV连续2周下降' },
  { rule_code: 'NEW_PRODUCT_CHECK_1', rule_name: '新品首次检测', target_type: 'product', scope_json: '{}', metric: 'hours_since_launch', operator: '>=', threshold: 48, window_days: 3, priority: 2, cooldown_hours: 24, version: 1, status: 1, params_json: '{"until_hours":72}', remark: '上架48-72h形成冷启健康度，不直接判死刑' },
  { rule_code: 'NEW_PRODUCT_FAIL', rule_name: '冷启失败候选', target_type: 'product', scope_json: '{}', metric: 'day7_valid_interaction', operator: '<', threshold: 1, window_days: 7, priority: 0, cooldown_hours: 48, version: 1, status: 1, params_json: '{}', remark: '第7天仍无有效互动/订单/内容承接' },
  { rule_code: 'NEW_PRODUCT_END', rule_name: '新品期结束', target_type: 'product', scope_json: '{}', metric: 'days_since_launch', operator: '>=', threshold: 14, window_days: 14, priority: 2, cooldown_hours: 336, version: 1, status: 1, params_json: '{}', remark: '第14天移出新品池，进入常规ABC分层' },
  { rule_code: 'VIDEO_DECAY', rule_name: '视频衰减', target_type: 'video', scope_json: '{}', metric: 'ma3_over_peak7', operator: '<', threshold: 0.5, window_days: 7, priority: 1, cooldown_hours: 72, version: 1, status: 1, params_json: '{"consecutive":2}', remark: '连续2周期3日均值<近7日峰值50%且方向一致' },
  { rule_code: 'ADS_LOSS', rule_name: '广告低于盈亏线', target_type: 'ads', scope_json: '{}', metric: 'roas_vs_breakeven', operator: '<', threshold: 1, window_days: 7, priority: 0, cooldown_hours: 24, version: 1, status: 1, params_json: '{}', remark: 'ROAS<Break-even ROAS（1/贡献毛利率；毛利率=（应收返点−物流−达人佣金）÷实收）' },
  /* 选品流水线（方案第十一章 11.2 超时规则 + 第三节首页动作清单新增条目）
     天数默认值与 apps/server/src/config.ts 的 SELECTION_* 一致，两处都可调 */
  { rule_code: 'SELECTION_REGISTER_STALE', rule_name: '候选品登记未进测试', target_type: 'selection', scope_json: '{}', metric: 'days_since_register', operator: '>', threshold: 7, window_days: 7, priority: 1, cooldown_hours: 72, version: 1, status: 1, params_json: '{}', remark: '登记后>7天未进入上架测试，提醒登记人（方案11.2阶段一）' },
  { rule_code: 'SELECTION_TEST_OVERDUE', rule_name: '测试到期未反馈', target_type: 'selection', scope_json: '{}', metric: 'days_in_test_without_conclusion', operator: '>', threshold: 14, window_days: 14, priority: 0, cooldown_hours: 24, version: 1, status: 1, params_json: '{}', remark: '上架测试满14天仍未提交结论，进P0今日必处理（方案11.2阶段二）' },
  { rule_code: 'SELECTION_FIRST_CHECK', rule_name: '测试首次检测', target_type: 'selection', scope_json: '{}', metric: 'hours_since_test_start', operator: '>=', threshold: 48, window_days: 3, priority: 2, cooldown_hours: 48, version: 1, status: 1, params_json: '{"until_hours":72}', remark: '上架48-72h做首次检测：CTR/加购率/转化率是否低于基准，不直接判死刑' },
  { rule_code: 'SELECTION_TEST_STRONG', rule_name: '测试中表现优异', target_type: 'selection', scope_json: '{}', metric: 'test_metric_over_baseline', operator: '>', threshold: 1.2, window_days: 14, priority: 1, cooldown_hours: 168, version: 1, status: 1, params_json: '{"ctr_baseline":0.025,"cvr_baseline":0.012}', remark: '测试期CTR/转化率超基准1.2倍，建议提前进入销售准备（基准值必须配在参数里）' },
  { rule_code: 'SELECTION_FEEDBACK_STALE', rule_name: '测试反馈积压', target_type: 'selection', scope_json: '{}', metric: 'days_in_feedback', operator: '>', threshold: 3, window_days: 3, priority: 1, cooldown_hours: 72, version: 1, status: 1, params_json: '{}', remark: '结论已提交但>3天未回写分流（方案11.2阶段三）' },
  { rule_code: 'SELECTION_PREPARE_OVERDUE', rule_name: '销售前准备超时', target_type: 'selection', scope_json: '{}', metric: 'days_in_prepare', operator: '>', threshold: 7, window_days: 7, priority: 1, cooldown_hours: 72, version: 1, status: 1, params_json: '{}', remark: '进入销售前准备>7天清单未清完，提醒负责人（方案11.2阶段四）' },
];

/* ---- 选品管理（方案第十一章） ---- */

/** 测试期数据快照：结论必须带着它提交，缺任何一个指标后端都拒绝 */
export interface SelectionSnapshot {
  impressions: number;
  ctr: number;
  cart_rate: number;
  cvr: number;
  refund_rate: number;
  gmv: number;
  net_margin: number;
}

/** 销售前准备清单项 */
export interface SelectionCheckItem {
  done: number;
  owner?: number | null;
  due?: string | null;
}

export interface SelectionFlowRow {
  id: number;
  code: string;
  name: string;
  image_url: string | null;
  category: string | null;
  /** 品牌方（货是品牌的，我们不背货款；替代原「供应商」） */
  brand_name: string | null;
  /** 建议售价（店铺币种） */
  list_price: number;
  /** 计划折扣率（0.2 = 让 20%）。只作档案与复盘口径，不参与利润回算 */
  planned_discount: number;
  /** 品牌给的返点率（我们唯一收入的比例） */
  rebate_rate: number;
  /** 计划达人佣金率（我们掏 or 品牌代付；两边不许重复记） */
  commission_rate: number;
  /** 计划物流费率（占实收比例；品牌承担填 0） */
  logistics_rate: number;
  /** 预估贡献毛利率 = 返点率 − 佣金率 − 物流费率，服务端算，不手填 */
  est_margin: number;
  /** 盈亏平衡 ROAS = 1 / 预估贡献毛利率 */
  breakeven_roas: number;
  source: string | null;
  shop_id: number | null;
  spu_id: number | null;
  stage: number;
  stage_entered_at: string;
  owner_id: number | null;
  registered_by: number | null;
  conclusion: number;
  conclusion_note: string | null;
  adjustments: string | null;
  test_started_at: string | null;
  test_snapshot: string;
  checklist: string;
  selling_at: string | null;
  remark: string | null;
}

/** 看板卡片：dwell_days / overdue_level 由后端按 config 阈值现算，前端不自己推 */
export interface SelectionBoardCard extends SelectionFlowRow {
  dwell_days: number;
  due_days: number | null;
  overdue_level: 'ok' | 'warn' | 'over';
  owner_name?: string | null;
  shop_name?: string | null;
  registered_name?: string | null;
}

export interface SelectionLogRow {
  id: number;
  selection_id: number;
  from_stage: number;
  to_stage: number;
  action: string;
  operator_id: number | null;
  note: string | null;
  created_at: string;
  operator_name?: string | null;
}

/** ABC 分层默认阈值（§6.1；必须在规则中心可配置） */
export const ABC_DEFAULTS = { a_cum_share: 0.8, b_cum_share: 0.95 };
