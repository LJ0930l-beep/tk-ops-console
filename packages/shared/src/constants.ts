/** 枚举与常量：与 docs/source-plan.txt 第五章字段说明一一对应 */

export const REGIONS = ['US', 'UK', 'ID', 'MY', 'TH', 'VN', 'PH', 'SG', 'MX'] as const;
export type Region = (typeof REGIONS)[number];

/** 一级菜单 key —— 权限 menu_perms 与前端路由使用同一套标识 */
export const MENU_KEYS = [
  'dashboard',
  'shop',
  'product',
  'order',
  'creator',
  'content',
  'ads',
  'finance',
  'stock',
  'system',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export const MENUS: { key: MenuKey; title: string; icon: string; phase: 1 | 2 | 3; children: { key: string; title: string; path: string }[] }[] = [
  { key: 'dashboard', title: '工作台', icon: 'Odometer', phase: 1, children: [{ key: 'dashboard:view', title: '经营看板', path: '/dashboard' }] },
  {
    key: 'shop', title: '店铺与账号', icon: 'Shop', phase: 1,
    children: [
      { key: 'shop:list', title: '店铺管理', path: '/shops' },
      { key: 'account:list', title: 'TikTok 账号', path: '/accounts' },
    ],
  },
  {
    key: 'product', title: '商品中心', icon: 'Goods', phase: 1,
    children: [
      { key: 'product:spu', title: '商品(SPU)', path: '/products/spu' },
      { key: 'product:sku', title: 'SKU 与成本', path: '/products/sku' },
      { key: 'product:listing', title: '店铺商品映射', path: '/products/listing' },
      { key: 'product:unmapped', title: '待映射清单', path: '/products/unmapped' },
    ],
  },
  {
    key: 'order', title: '订单中心', icon: 'List', phase: 1,
    children: [
      { key: 'order:list', title: '订单列表', path: '/orders' },
      { key: 'order:detail', title: '订单详情', path: '/orders/:id' },
      { key: 'return:list', title: '售后退款', path: '/returns' },
    ],
  },
  {
    key: 'creator', title: '达人中心', icon: 'Star', phase: 1,
    children: [
      { key: 'creator:pool', title: '达人公海', path: '/creators/pool' },
      { key: 'creator:mine', title: '我的达人', path: '/creators/mine' },
      { key: 'creator:outreach', title: '建联跟进', path: '/creators/outreach' },
      { key: 'creator:collab', title: '合作单', path: '/creators/collab' },
      { key: 'creator:sample', title: '寄样管理', path: '/creators/sample' },
      { key: 'creator:roi', title: '达人 ROI 排行', path: '/creators/roi' },
    ],
  },
  {
    key: 'content', title: '内容中心', icon: 'VideoCamera', phase: 1,
    children: [
      { key: 'video:list', title: '视频库与带货排行', path: '/videos' },
      { key: 'live:schedule', title: '直播排班', path: '/lives/schedule' },
      { key: 'live:review', title: '直播复盘', path: '/lives' },
    ],
  },
  { key: 'ads', title: '投放中心', icon: 'TrendCharts', phase: 2, children: [{ key: 'ad:daily', title: '广告日报', path: '/ads/daily' }] },
  {
    key: 'finance', title: '财务中心', icon: 'Money', phase: 2,
    children: [
      { key: 'settlement:list', title: '结算对账', path: '/finance/settlement' },
      { key: 'expense:list', title: '费用登记', path: '/finance/expense' },
      { key: 'rate:list', title: '汇率维护', path: '/finance/rate' },
      { key: 'profit:report', title: '利润报表', path: '/finance/profit' },
    ],
  },
  {
    key: 'stock', title: '库存(可选)', icon: 'Box', phase: 3,
    children: [
      { key: 'warehouse:list', title: '仓库管理', path: '/stock/warehouse' },
      { key: 'stock:ledger', title: '出入库流水', path: '/stock/ledger' },
      { key: 'stock:query', title: '库存查询', path: '/stock/query' },
    ],
  },
  {
    key: 'system', title: '系统设置', icon: 'Setting', phase: 1,
    children: [
      { key: 'user:list', title: '员工管理', path: '/system/users' },
      { key: 'role:list', title: '角色权限', path: '/system/roles' },
      { key: 'oplog:list', title: '操作日志', path: '/system/oplog' },
      { key: 'synclog:list', title: '同步监控', path: '/system/synclog' },
      { key: 'dict:list', title: '数据字典', path: '/system/dict' },
    ],
  },
];

/** 角色 data_scope */
export const DATA_SCOPE = { ALL: 1, DEPT: 2, SELF: 3, SHOPS: 4 } as const;

/** 建议默认权限（方案 8.1） */
export const DEFAULT_ROLES = [
  { role_key: 'boss', role_name: '老板', data_scope: DATA_SCOPE.ALL, can_see_cost: 1, can_see_contact: 1, can_export: 1, menu_perms: [...MENU_KEYS] },
  { role_key: 'ops_manager', role_name: '运营主管', data_scope: DATA_SCOPE.DEPT, can_see_cost: 1, can_see_contact: 0, can_export: 1, menu_perms: ['dashboard', 'shop', 'product', 'order', 'content', 'ads', 'finance', 'system'] },
  { role_key: 'ops', role_name: '运营', data_scope: DATA_SCOPE.SHOPS, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'shop', 'product', 'order', 'content'] },
  { role_key: 'bd_manager', role_name: 'BD 主管', data_scope: DATA_SCOPE.DEPT, can_see_cost: 0, can_see_contact: 1, can_export: 1, menu_perms: ['dashboard', 'creator', 'content'] },
  { role_key: 'bd', role_name: '达人 BD', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 1, can_export: 0, menu_perms: ['dashboard', 'creator', 'content'] },
  { role_key: 'content', role_name: '内容(编导/剪辑)', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'content'] },
  { role_key: 'host', role_name: '主播/场控', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'content'] },
  { role_key: 'ads', role_name: '投放', data_scope: DATA_SCOPE.SHOPS, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'ads', 'order'] },
  { role_key: 'finance', role_name: '财务', data_scope: DATA_SCOPE.ALL, can_see_cost: 1, can_see_contact: 0, can_export: 1, menu_perms: ['dashboard', 'finance', 'order', 'ads'] },
  { role_key: 'warehouse', role_name: '仓库/发货', data_scope: DATA_SCOPE.ALL, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'creator', 'stock'] },
] as const;

/* ---- 业务状态枚举 ---- */
export const SHOP_AUTH_STATUS = { UNAUTHORIZED: 0, AUTHORIZED: 1, EXPIRING: 2, EXPIRED: 3 } as const;
export const POOL_STATUS = { PUBLIC: 1, PRIVATE: 2, COOPERATING: 3, BLACKLIST: 4 } as const;
export const OUTREACH_RESULT = { NO_REPLY: 1, REPLIED: 2, INTERESTED: 3, QUOTING: 4, REJECTED: 5, AGREED: 6 } as const;
export const COLLAB_STATUS = { AGREED: 1, TO_SHIP: 2, IN_TRANSIT: 3, TO_PUBLISH: 4, PUBLISHED: 5, FINISHED: 6, OVERDUE: 7, CANCELLED: 8 } as const;
export const SAMPLE_STATUS = { TO_SHIP: 1, IN_TRANSIT: 2, SIGNED: 3, CONTENT_DONE: 4, OVERDUE: 5, LOST: 6 } as const;
export const CONTENT_TYPE = { CREATOR_VIDEO: 1, CREATOR_LIVE: 2, OWN_VIDEO: 3, OWN_LIVE: 4, PRODUCT_CARD: 5 } as const;
export const MAP_STATUS = { MAPPED: 1, UNMAPPED: 2 } as const;
export const SETTLE_TXN_TYPE = { ORDER_IN: 1, REFUND: 2, PLATFORM_FEE: 3, CREATOR_FEE: 4, SHIPPING: 5, SUBSIDY: 6, ADJUST: 7, OTHER: 8 } as const;
export const RESPONSIBILITY = { UNSET: 0, QUALITY: 1, LOGISTICS: 2, DESCRIPTION: 3, BUYER: 4 } as const;

/** 订单状态归一化后的分组 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  UNPAID: '待付款', ON_HOLD: '暂停', TO_BE_SHIPPED: '待发货', INVOICE_CREATED: '待发货',
  TRANSIT_TO_SHIP: '运输中', SHIPPED: '运输中', DELIVERED: '已签收', COMPLETED: '已完成',
  CANCELLED: '已取消', ON_HOLD_SUBSTATUS_ESCALATION: '暂停',
};

export interface ApiResponse<T> { code: number; message: string; data: T }
export interface PageResult<T> { list: T[]; total: number; page: number; pageSize: number }
export interface PageQuery { page?: number; pageSize?: number; keyword?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' }

/** 敏感字段掩码值（无权限时前端看到 *** ） */
export const MASK = '***';
