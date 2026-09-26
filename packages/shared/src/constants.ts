/** 枚举与常量：与 docs/source-plan.txt 第五章字段说明一一对应 */

export const REGIONS = ['US', 'UK', 'ID', 'MY', 'TH', 'VN', 'PH', 'SG', 'MX'] as const;
export type Region = (typeof REGIONS)[number];

/** 一级菜单 key —— 权限 menu_perms 与前端路由使用同一套标识 */
export const MENU_KEYS = [
  'dashboard',
  'selection',
  'shop',
  'product',
  'order',
  'creator',
  'content',
  'ads',
  'finance',
  'stock',
  'system',
  'ai',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export const MENUS: { key: MenuKey; title: string; icon: string; phase: 1 | 2 | 3; children: { key: string; title: string; path: string }[] }[] = [
  { key: 'dashboard', title: '工作台', icon: 'Odometer', phase: 1, children: [{ key: 'action:center', title: '今日行动中心', path: '/actions' }, { key: 'dashboard:view', title: '经营看板', path: '/dashboard' }, { key: 'action:results', title: '效果回看', path: '/actions/results' }] },
  {
    // 选品是「商品进入销售体系之前」的前置流水线（方案第十一章），所以排在店铺之前
    key: 'selection', title: '选品管理', icon: 'Aim', phase: 3,
    children: [{ key: 'selection:board', title: '选品流水线', path: '/selection' }],
  },
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
      { key: 'product:sku', title: 'SKU 与返点', path: '/products/sku' },
      { key: 'product:listing', title: '店铺商品映射', path: '/products/listing' },
      { key: 'product:unmapped', title: '待映射清单', path: '/products/unmapped' },
      { key: 'product:abc', title: 'ABC 分层与渠道', path: '/products/abc' },
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
      { key: 'rule:center', title: '规则中心', path: '/system/rules' },
    ],
  },
  {
    // AI 助手排在最后：没配服务商之前它只是个报错页，不该占前面的视觉位
    key: 'ai', title: 'AI 助手', icon: 'MagicStick', phase: 3,
    children: [
      { key: 'ai:chat', title: 'AI 对话', path: '/ai/chat' },
      { key: 'ai:provider', title: '模型服务商', path: '/ai/providers' },
      { key: 'ai:audit', title: 'AI 调用审计', path: '/ai/audit' },
    ],
  },
];

/** 角色 data_scope */
export const DATA_SCOPE = { ALL: 1, DEPT: 2, SELF: 3, SHOPS: 4 } as const;

/**
 * 建议默认权限（方案 8.1）。
 *
 * `ai` 给到所有角色：AI 能看见什么、能改什么，靠的是「工具白名单 + 调用者本人的菜单与数据范围」，
 * 不是靠这个菜单键藏入口 —— 菜单只是让他有个对话页。真要给某个角色关掉，去角色权限页勾掉即可。
 */
export const DEFAULT_ROLES = [
  { role_key: 'boss', role_name: '老板', data_scope: DATA_SCOPE.ALL, can_see_cost: 1, can_see_contact: 1, can_export: 1, menu_perms: [...MENU_KEYS] },
  { role_key: 'ops_manager', role_name: '运营主管', data_scope: DATA_SCOPE.DEPT, can_see_cost: 1, can_see_contact: 0, can_export: 1, menu_perms: ['dashboard', 'selection', 'shop', 'product', 'order', 'content', 'ads', 'finance', 'system', 'ai'] },
  { role_key: 'ops', role_name: '运营', data_scope: DATA_SCOPE.SHOPS, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'selection', 'shop', 'product', 'order', 'content', 'ai'] },
  { role_key: 'bd_manager', role_name: 'BD 主管', data_scope: DATA_SCOPE.DEPT, can_see_cost: 0, can_see_contact: 1, can_export: 1, menu_perms: ['dashboard', 'creator', 'content', 'ai'] },
  { role_key: 'bd', role_name: '达人 BD', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 1, can_export: 0, menu_perms: ['dashboard', 'creator', 'content', 'ai'] },
  { role_key: 'content', role_name: '内容(编导/剪辑)', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'content', 'ai'] },
  { role_key: 'host', role_name: '主播/场控', data_scope: DATA_SCOPE.SELF, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'content', 'ai'] },
  { role_key: 'ads', role_name: '投放', data_scope: DATA_SCOPE.SHOPS, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'ads', 'order', 'ai'] },
  { role_key: 'finance', role_name: '财务', data_scope: DATA_SCOPE.ALL, can_see_cost: 1, can_see_contact: 0, can_export: 1, menu_perms: ['dashboard', 'finance', 'order', 'ads', 'ai'] },
  { role_key: 'warehouse', role_name: '仓库/发货', data_scope: DATA_SCOPE.ALL, can_see_cost: 0, can_see_contact: 0, can_export: 0, menu_perms: ['dashboard', 'creator', 'stock', 'ai'] },
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

/* ---- 选品管理（方案第十一章：候选品从登记到正式销售的五阶段流水线） ---- */

/** 候选品所处阶段。6=淘汰池是终态，不占看板列 */
export const SELECTION_STAGE = {
  REGISTERED: 1,
  TESTING: 2,
  FEEDBACK: 3,
  PREPARING: 4,
  SELLING: 5,
  ELIMINATED: 6,
} as const;
export type SelectionStage = (typeof SELECTION_STAGE)[keyof typeof SELECTION_STAGE];

export const SELECTION_STAGE_LABELS: Record<number, string> = {
  1: '商品选品登记',
  2: '店铺上架测试',
  3: '测试反馈',
  4: '销售前准备',
  5: '正常销售',
  6: '淘汰池',
};

/** 看板列顺序（正常销售之后移出选品端口，只在商品端口留一条历史） */
export const SELECTION_BOARD_STAGES = [1, 2, 3, 4, 5] as const;

/** 测试结论：未提交为 0；提交时必须携带测试期数据快照 */
export const SELECTION_CONCLUSION = { PENDING: 0, PASS: 1, FAIL: 2, RETEST: 3 } as const;
export const SELECTION_CONCLUSION_LABELS: Record<number, string> = { 0: '未提交', 1: '通过', 2: '不通过', 3: '需调整后复测' };

/** 选品来源（方案 11.1 阶段一） */
/** 候选品从哪来。没有"供应链推荐"了 —— 我们不找货，是品牌把货交给我们运营 */
export const SELECTION_SOURCES = ['市场调研', '竞品对标', '达人推荐', '品牌方指定', '平台榜单'] as const;

/**
 * 阶段四的销售前准备清单。
 * 缺一项就不允许进入「正常销售」——这是方案里最硬的一条规则，
 * 所以清单项必须是代码里的枚举而不是自由文本，否则前端多传/漏传都能绕过闸门。
 */
export const SELECTION_CHECKLIST = [
  { key: 'profile', label: '商品资料完善（标题/主图/详情/规格/SKU 编码）' },
  { key: 'price', label: '价格策略确认（售价/促销价/达人佣金）' },
  { key: 'stock', label: '库存确认（首批备货量/补货周期）' },
  { key: 'channel', label: '渠道策略确认（商品卡/直播/短视频/联盟）' },
  { key: 'finance', label: '财务确认（最终毛利率、盈亏平衡 ROAS）' },
  { key: 'compliance', label: '合规确认（类目资质、认证文件）' },
] as const;
export const SELECTION_CHECKLIST_KEYS = SELECTION_CHECKLIST.map((c) => c.key);

/** 测试期数据快照里必须出现的指标：一个都不许少，否则「没有数据支撑的结论」照样能提交 */
export const SELECTION_METRICS = ['impressions', 'ctr', 'cart_rate', 'cvr', 'refund_rate', 'gmv', 'net_margin'] as const;

/** 订单状态归一化后的分组 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  UNPAID: '待付款', ON_HOLD: '暂停', TO_BE_SHIPPED: '待发货', INVOICE_CREATED: '待发货',
  TRANSIT_TO_SHIP: '运输中', SHIPPED: '运输中', DELIVERED: '已签收', COMPLETED: '已完成',
  CANCELLED: '已取消', ON_HOLD_SUBSTATUS_ESCALATION: '暂停',
};

/* ---- AI 助手（模型服务商接入 + 工具调用） ---- */

/**
 * 协议只有两种：`openai` 兼容报文（GPT / DeepSeek / 各类自建网关）与 `gemini` 原生报文。
 * 厂商"预设"只是给协议 + base_url + 默认模型一组初值，不新增第三种协议 ——
 * 加一家的成本应该是填一行预设，而不是再写一个适配器。
 */
export const AI_PROTOCOL = { OPENAI: 'openai', GEMINI: 'gemini' } as const;
export type AiProtocol = (typeof AI_PROTOCOL)[keyof typeof AI_PROTOCOL];

export const AI_VENDOR = { OPENAI: 'openai', DEEPSEEK: 'deepseek', GEMINI: 'gemini', CUSTOM: 'custom' } as const;
export type AiVendor = (typeof AI_VENDOR)[keyof typeof AI_VENDOR];

export const AI_VENDOR_LABELS: Record<AiVendor, string> = {
  openai: 'OpenAI（GPT）',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  custom: '自定义（OpenAI 兼容网关）',
};

export const AI_VENDOR_PRESETS: Record<AiVendor, { protocol: AiProtocol; base_url: string; model: string; key_hint: string }> = {
  openai: { protocol: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key_hint: 'sk-...' },
  deepseek: { protocol: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key_hint: 'sk-...' },
  gemini: { protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', key_hint: 'AIza...' },
  custom: { protocol: 'openai', base_url: '', model: '', key_hint: '' },
};

export const AI_MESSAGE_ROLE = { SYSTEM: 'system', USER: 'user', ASSISTANT: 'assistant', TOOL: 'tool' } as const;

/** 一次模型调用的结果状态：失败也要落审计表，否则"AI 答不上来"和"没调"分不清 */
export const AI_CALL_STATUS = { SUCCESS: 1, FAILED: 2 } as const;
export const AI_CALL_STATUS_LABELS: Record<number, string> = { 1: '成功', 2: '失败' };

/**
 * AI 发起的写入状态。没有"待确认"这一档：按本轮定的边界，白名单内的写入直接执行，
 * 但"权限不够/不在名单内被拒"和"执行失败"都必须留痕，事后能追到是哪条消息让它写的。
 */
export const AI_ACTION_STATUS = { EXECUTED: 1, REJECTED: 2, FAILED: 3 } as const;
export const AI_ACTION_STATUS_LABELS: Record<number, string> = { 1: '已执行', 2: '被拒', 3: '执行失败' };

/**
 * AI 能调的工具。读工具只回数据（且按调用者的数据范围过滤）；
 * 写工具一律复用"人在界面上写时走的同一条路径"（同样的校验、同样的数据范围、同样的 op_log）。
 * 删除、改价/上架、对外给达人发消息这三类**永远不进这个名单**。
 *
 * 达人 ROI 不单开工具：get_profit_report(dim='creator') 已经按同一条利润口径给得出，
 * 再开一个"第二套 ROI 查询"就是又一次分叉。
 */
export const AI_TOOL = {
  GET_DASHBOARD: 'get_dashboard',
  GET_PROFIT_REPORT: 'get_profit_report',
  LIST_ALERTS: 'list_alerts',
  RECORD_ALERT_ACTION: 'record_alert_action',
  CREATE_OUTREACH: 'create_outreach',
} as const;
export type AiToolName = (typeof AI_TOOL)[keyof typeof AI_TOOL];

export const AI_WRITE_TOOLS: readonly AiToolName[] = [AI_TOOL.RECORD_ALERT_ACTION, AI_TOOL.CREATE_OUTREACH];

export const AI_TOOL_LABELS: Record<AiToolName, string> = {
  [AI_TOOL.GET_DASHBOARD]: '读经营看板',
  [AI_TOOL.GET_PROFIT_REPORT]: '读利润报表（可按店铺/SKU/达人/月份）',
  [AI_TOOL.LIST_ALERTS]: '读未闭环预警',
  [AI_TOOL.RECORD_ALERT_ACTION]: '给预警写处置动作',
  [AI_TOOL.CREATE_OUTREACH]: '登记一条建联跟进',
};

export interface ApiResponse<T> { code: number; message: string; data: T }
export interface PageResult<T> { list: T[]; total: number; page: number; pageSize: number }
export interface PageQuery { page?: number; pageSize?: number; keyword?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' }

/** 敏感字段掩码值（无权限时前端看到 *** ） */
export const MASK = '***';
