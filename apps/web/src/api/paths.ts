/**
 * API 路径契约 —— 由 `npm run openapi` 从后端路由生成，请勿手改。
 *
 * 作用：apiGet/apiPost/apiPut/apiDelete/apiDownload 的 url 参数是字面量联合类型，
 * endpoint 写错（拼错、或后端改名前端没跟）在 vue-tsc 阶段就红，而不是等用户点进页面才 404。
 * 带 :param 的路径生成 `${string}` 模板字面量类型，模板串拼错段数同样过不了检查。
 */
export const API_PATHS = [
  '/accounts',
  '/accounts/:id',
  '/actions/analytics/abc',
  '/actions/analytics/live/:id/minutes',
  '/actions/analytics/shop-channel',
  '/actions/evaluate',
  '/actions/events',
  '/actions/events/:id',
  '/actions/events/:id/handle',
  '/actions/notifications',
  '/actions/notifications/:id/read',
  '/actions/notifications/sync',
  '/actions/results',
  '/actions/rules',
  '/actions/rules/:id',
  '/actions/today',
  '/ads/daily',
  '/ads/daily/:id',
  '/ads/export',
  '/ads/import',
  '/ads/meta',
  '/ads/refresh',
  '/ads/roi/rank',
  '/ads/summary',
  '/ads/trend',
  '/ads/types',
  '/auth/login',
  '/auth/me',
  '/auth/password',
  '/content/content/summary',
  '/content/lives',
  '/content/lives/:id',
  '/content/lives/:id/cancel',
  '/content/lives/:id/finish',
  '/content/lives/:id/review',
  '/content/lives/:id/start',
  '/content/lives/calendar',
  '/content/lives/export',
  '/content/lives/host-rank',
  '/content/lives/reminder',
  '/content/options/collabs',
  '/content/options/creators',
  '/content/summary',
  '/content/videos',
  '/content/videos/:id',
  '/content/videos/:id/attribution',
  '/content/videos/export',
  '/content/videos/rank',
  '/content/videos/recalc',
  '/creators',
  '/creators/:id',
  '/creators/:id/blacklist',
  '/creators/:id/claim',
  '/creators/:id/import-from-search',
  '/creators/:id/outreach',
  '/creators/:id/release',
  '/creators/batch-import',
  '/creators/bd-performance',
  '/creators/collab',
  '/creators/collab/:id',
  '/creators/collab/:id/expense',
  '/creators/collab/:id/roi',
  '/creators/collab/:id/status',
  '/creators/collab/export',
  '/creators/collab/overdue',
  '/creators/expiring',
  '/creators/export',
  '/creators/outreach',
  '/creators/outreach/:id',
  '/creators/outreach/due',
  '/creators/recycle-expired',
  '/creators/roi/rank',
  '/creators/sample',
  '/creators/sample/:id',
  '/creators/sample/:id/lost',
  '/creators/sample/:id/ship',
  '/creators/sample/:id/sign',
  '/creators/sample/export',
  '/creators/sample/from-order',
  '/creators/sample/overdue',
  '/creators/search',
  '/creators/stats',
  '/dashboard/summary',
  '/dashboard/todos',
  '/dashboard/todos/detail',
  '/dashboard/trend',
  '/finance/expense',
  '/finance/expense/:id',
  '/finance/expense/:id/pay',
  '/finance/expense/export',
  '/finance/expense/from-collab',
  '/finance/expense/summary',
  '/finance/profit',
  '/finance/profit/export',
  '/finance/profit/order/:id',
  '/finance/profit/report',
  '/finance/profit/trend',
  '/finance/rate',
  '/finance/rate/:id',
  '/finance/rate/fetch',
  '/finance/rate/fill-missing',
  '/finance/rate/health',
  '/finance/rate/latest',
  '/finance/rate/list',
  '/finance/reconcile',
  '/finance/return',
  '/finance/settlement',
  '/finance/settlement/:id',
  '/finance/settlement/by-order/:tk_order_id',
  '/finance/settlement/import',
  '/finance/settlement/reconcile',
  '/finance/settlement/reconcile/export',
  '/finance/settlement/statements',
  '/finance/settlement/summary',
  '/orders',
  '/orders/:id',
  '/orders/:id/profit',
  '/orders/:id/sample',
  '/orders/export',
  '/orders/returns',
  '/orders/returns/:id',
  '/orders/returns/impact',
  '/orders/returns/stats',
  '/orders/summary',
  '/orders/unmatched',
  '/products/categories',
  '/products/export/sku',
  '/products/import/sku',
  '/products/import/spu',
  '/products/listing',
  '/products/listing/:id',
  '/products/listings/auto-match',
  '/products/mapping/auto',
  '/products/mapping/preview',
  '/products/sku',
  '/products/sku/:id',
  '/products/sku/:id/cost-history',
  '/products/spu',
  '/products/spu/:id',
  '/products/spu/:id/skus',
  '/products/spu/all',
  '/products/spu/export',
  '/products/unmapped',
  '/products/unmapped/export',
  '/shops',
  '/shops/:id',
  '/shops/:id/auth',
  '/shops/all',
  '/shops/mine',
  '/stock${base}/:id',
  '/stock/ledger',
  '/stock/ledger/:id/reverse',
  '/stock/meta',
  '/stock/query',
  '/stock/query/detail',
  '/stock/skus',
  '/stock/spus',
  '/stock/warehouse/options',
  '/sync/health',
  '/sync/import/orders',
  '/sync/logs',
  '/sync/run',
  '/sync/tasks',
  '/system/data-scope/:userId',
  '/system/dict',
  '/system/dict/:id',
  '/system/dict/:type',
  '/system/dict/types',
  '/system/import',
  '/system/import/tables',
  '/system/import/template',
  '/system/jobs',
  '/system/jobs/:id',
  '/system/jobs/drain',
  '/system/menus',
  '/system/oplog',
  '/system/roles',
  '/system/roles/:id',
  '/system/synclog',
  '/system/synclog/health',
  '/system/transfer-creator',
  '/system/users',
  '/system/users/:id',
  '/system/users/:id/deactivate',
  '/system/users/:id/shops',
] as const;

export type ApiPath =
  | '/accounts'
  | `/accounts/${string}`
  | '/actions/analytics/abc'
  | `/actions/analytics/live/${string}/minutes`
  | '/actions/analytics/shop-channel'
  | '/actions/evaluate'
  | '/actions/events'
  | `/actions/events/${string}`
  | `/actions/events/${string}/handle`
  | '/actions/notifications'
  | `/actions/notifications/${string}/read`
  | '/actions/notifications/sync'
  | '/actions/results'
  | '/actions/rules'
  | `/actions/rules/${string}`
  | '/actions/today'
  | '/ads/daily'
  | `/ads/daily/${string}`
  | '/ads/export'
  | '/ads/import'
  | '/ads/meta'
  | '/ads/refresh'
  | '/ads/roi/rank'
  | '/ads/summary'
  | '/ads/trend'
  | '/ads/types'
  | '/auth/login'
  | '/auth/me'
  | '/auth/password'
  | '/content/content/summary'
  | '/content/lives'
  | `/content/lives/${string}`
  | `/content/lives/${string}/cancel`
  | `/content/lives/${string}/finish`
  | `/content/lives/${string}/review`
  | `/content/lives/${string}/start`
  | '/content/lives/calendar'
  | '/content/lives/export'
  | '/content/lives/host-rank'
  | '/content/lives/reminder'
  | '/content/options/collabs'
  | '/content/options/creators'
  | '/content/summary'
  | '/content/videos'
  | `/content/videos/${string}`
  | `/content/videos/${string}/attribution`
  | '/content/videos/export'
  | '/content/videos/rank'
  | '/content/videos/recalc'
  | '/creators'
  | `/creators/${string}`
  | `/creators/${string}/blacklist`
  | `/creators/${string}/claim`
  | `/creators/${string}/import-from-search`
  | `/creators/${string}/outreach`
  | `/creators/${string}/release`
  | '/creators/batch-import'
  | '/creators/bd-performance'
  | '/creators/collab'
  | `/creators/collab/${string}`
  | `/creators/collab/${string}/expense`
  | `/creators/collab/${string}/roi`
  | `/creators/collab/${string}/status`
  | '/creators/collab/export'
  | '/creators/collab/overdue'
  | '/creators/expiring'
  | '/creators/export'
  | '/creators/outreach'
  | `/creators/outreach/${string}`
  | '/creators/outreach/due'
  | '/creators/recycle-expired'
  | '/creators/roi/rank'
  | '/creators/sample'
  | `/creators/sample/${string}`
  | `/creators/sample/${string}/lost`
  | `/creators/sample/${string}/ship`
  | `/creators/sample/${string}/sign`
  | '/creators/sample/export'
  | '/creators/sample/from-order'
  | '/creators/sample/overdue'
  | '/creators/search'
  | '/creators/stats'
  | '/dashboard/summary'
  | '/dashboard/todos'
  | '/dashboard/todos/detail'
  | '/dashboard/trend'
  | '/finance/expense'
  | `/finance/expense/${string}`
  | `/finance/expense/${string}/pay`
  | '/finance/expense/export'
  | '/finance/expense/from-collab'
  | '/finance/expense/summary'
  | '/finance/profit'
  | '/finance/profit/export'
  | `/finance/profit/order/${string}`
  | '/finance/profit/report'
  | '/finance/profit/trend'
  | '/finance/rate'
  | `/finance/rate/${string}`
  | '/finance/rate/fetch'
  | '/finance/rate/fill-missing'
  | '/finance/rate/health'
  | '/finance/rate/latest'
  | '/finance/rate/list'
  | '/finance/reconcile'
  | '/finance/return'
  | '/finance/settlement'
  | `/finance/settlement/${string}`
  | `/finance/settlement/by-order/${string}`
  | '/finance/settlement/import'
  | '/finance/settlement/reconcile'
  | '/finance/settlement/reconcile/export'
  | '/finance/settlement/statements'
  | '/finance/settlement/summary'
  | '/orders'
  | `/orders/${string}`
  | `/orders/${string}/profit`
  | `/orders/${string}/sample`
  | '/orders/export'
  | '/orders/returns'
  | `/orders/returns/${string}`
  | '/orders/returns/impact'
  | '/orders/returns/stats'
  | '/orders/summary'
  | '/orders/unmatched'
  | '/products/categories'
  | '/products/export/sku'
  | '/products/import/sku'
  | '/products/import/spu'
  | '/products/listing'
  | `/products/listing/${string}`
  | '/products/listings/auto-match'
  | '/products/mapping/auto'
  | '/products/mapping/preview'
  | '/products/sku'
  | `/products/sku/${string}`
  | `/products/sku/${string}/cost-history`
  | '/products/spu'
  | `/products/spu/${string}`
  | `/products/spu/${string}/skus`
  | '/products/spu/all'
  | '/products/spu/export'
  | '/products/unmapped'
  | '/products/unmapped/export'
  | '/shops'
  | `/shops/${string}`
  | `/shops/${string}/auth`
  | '/shops/all'
  | '/shops/mine'
  | `/stock${string}/${string}`
  | '/stock/ledger'
  | `/stock/ledger/${string}/reverse`
  | '/stock/meta'
  | '/stock/query'
  | '/stock/query/detail'
  | '/stock/skus'
  | '/stock/spus'
  | '/stock/warehouse/options'
  | '/sync/health'
  | '/sync/import/orders'
  | '/sync/logs'
  | '/sync/run'
  | '/sync/tasks'
  | `/system/data-scope/${string}`
  | '/system/dict'
  | `/system/dict/${string}`
  | '/system/dict/types'
  | '/system/import'
  | '/system/import/tables'
  | '/system/import/template'
  | '/system/jobs'
  | `/system/jobs/${string}`
  | '/system/jobs/drain'
  | '/system/menus'
  | '/system/oplog'
  | '/system/roles'
  | `/system/roles/${string}`
  | '/system/synclog'
  | '/system/synclog/health'
  | '/system/transfer-creator'
  | '/system/users'
  | `/system/users/${string}`
  | `/system/users/${string}/deactivate`
  | `/system/users/${string}/shops`
;
