import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import MainLayout from '@/layouts/MainLayout.vue';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: MainLayout,
    redirect: '/actions',
    children: [
      { path: 'actions', name: 'actions', component: () => import('@/views/ActionCenter.vue'), meta: { title: '今日行动中心', menu: 'dashboard' } },
      { path: 'actions/results', name: 'action-results', component: () => import('@/views/ActionResults.vue'), meta: { title: '效果回看', menu: 'dashboard' } },
      { path: 'dashboard', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { title: '经营看板', menu: 'dashboard' } },

      { path: 'selection', name: 'selection', component: () => import('@/views/selection/SelectionBoard.vue'), meta: { title: '选品流水线', menu: 'selection' } },

      { path: 'shops', name: 'shops', component: () => import('@/views/shop/ShopList.vue'), meta: { title: '店铺管理', menu: 'shop' } },
      { path: 'accounts', name: 'accounts', component: () => import('@/views/shop/AccountList.vue'), meta: { title: 'TikTok 账号', menu: 'shop' } },

      { path: 'products/spu', name: 'spu', component: () => import('@/views/product/SpuList.vue'), meta: { title: '商品(SPU)', menu: 'product' } },
      { path: 'products/sku', name: 'sku', component: () => import('@/views/product/SkuList.vue'), meta: { title: 'SKU 与返点', menu: 'product' } },
      { path: 'products/listing', name: 'listing', component: () => import('@/views/product/ListingList.vue'), meta: { title: '店铺商品映射', menu: 'product' } },
      { path: 'products/unmapped', name: 'unmapped', component: () => import('@/views/product/UnmappedList.vue'), meta: { title: '待映射清单', menu: 'product' } },
      { path: 'products/abc', name: 'product-abc', component: () => import('@/views/product/ProductAbc.vue'), meta: { title: 'ABC 分层与渠道', menu: 'product' } },

      { path: 'orders', name: 'orders', component: () => import('@/views/order/OrderList.vue'), meta: { title: '订单列表', menu: 'order' } },
      { path: 'orders/:id', name: 'order-detail', component: () => import('@/views/order/OrderDetail.vue'), meta: { title: '订单详情', menu: 'order' } },
      { path: 'returns', name: 'returns', component: () => import('@/views/order/ReturnList.vue'), meta: { title: '售后退款', menu: 'order' } },

      { path: 'creators/pool', name: 'creator-pool', component: () => import('@/views/creator/CreatorPool.vue'), meta: { title: '达人公海', menu: 'creator' } },
      { path: 'creators/mine', name: 'creator-mine', component: () => import('@/views/creator/CreatorMine.vue'), meta: { title: '我的达人', menu: 'creator' } },
      { path: 'creators/outreach', name: 'outreach', component: () => import('@/views/creator/OutreachList.vue'), meta: { title: '建联跟进', menu: 'creator' } },
      { path: 'creators/collab', name: 'collab', component: () => import('@/views/creator/CollabList.vue'), meta: { title: '合作单', menu: 'creator' } },
      { path: 'creators/sample', name: 'sample', component: () => import('@/views/creator/SampleList.vue'), meta: { title: '寄样管理', menu: 'creator' } },
      { path: 'creators/roi', name: 'creator-roi', component: () => import('@/views/creator/CreatorRoi.vue'), meta: { title: '达人 ROI 排行', menu: 'creator' } },

      { path: 'videos', name: 'videos', component: () => import('@/views/content/VideoList.vue'), meta: { title: '视频库', menu: 'content' } },
      { path: 'lives/schedule', name: 'live-schedule', component: () => import('@/views/content/LiveSchedule.vue'), meta: { title: '直播排班', menu: 'content' } },
      { path: 'lives', name: 'lives', component: () => import('@/views/content/LiveList.vue'), meta: { title: '直播复盘', menu: 'content' } },

      { path: 'ads/daily', name: 'ad-daily', component: () => import('@/views/ads/AdDaily.vue'), meta: { title: '广告日报', menu: 'ads' } },

      { path: 'finance/settlement', name: 'settlement', component: () => import('@/views/finance/SettlementList.vue'), meta: { title: '结算对账', menu: 'finance' } },
      { path: 'finance/reconcile', name: 'reconcile', component: () => import('@/views/finance/SettlementReconcile.vue'), meta: { title: '逐单对账', menu: 'finance' } },
      { path: 'finance/expense', name: 'expense', component: () => import('@/views/finance/ExpenseList.vue'), meta: { title: '费用登记', menu: 'finance' } },
      { path: 'finance/rate', name: 'rate', component: () => import('@/views/finance/RateList.vue'), meta: { title: '汇率维护', menu: 'finance' } },
      { path: 'finance/profit', name: 'profit', component: () => import('@/views/finance/ProfitReport.vue'), meta: { title: '利润报表', menu: 'finance' } },

      { path: 'stock/warehouse', name: 'warehouse', component: () => import('@/views/stock/WarehouseList.vue'), meta: { title: '仓库管理', menu: 'stock' } },
      { path: 'stock/ledger', name: 'stock-ledger', component: () => import('@/views/stock/StockLedger.vue'), meta: { title: '出入库流水', menu: 'stock' } },
      { path: 'stock/query', name: 'stock-query', component: () => import('@/views/stock/StockQuery.vue'), meta: { title: '库存查询', menu: 'stock' } },

      { path: 'system/users', name: 'users', component: () => import('@/views/system/UserList.vue'), meta: { title: '员工管理', menu: 'system' } },
      { path: 'system/roles', name: 'roles', component: () => import('@/views/system/RoleList.vue'), meta: { title: '角色权限', menu: 'system' } },
      { path: 'system/oplog', name: 'oplog', component: () => import('@/views/system/OpLogList.vue'), meta: { title: '操作日志', menu: 'system' } },
      { path: 'system/synclog', name: 'synclog', component: () => import('@/views/system/SyncLogList.vue'), meta: { title: '同步监控', menu: 'system' } },
      { path: 'system/dict', name: 'dict', component: () => import('@/views/system/DictList.vue'), meta: { title: '数据字典', menu: 'system' } },
      { path: 'system/rules', name: 'rules', component: () => import('@/views/system/RulesCenter.vue'), meta: { title: '规则中心', menu: 'system' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/actions' },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (to.meta.public) return true;
  if (!auth.isLoggedIn) return { path: '/login', query: { redirect: to.fullPath } };
  if (!auth.user) {
    try {
      await auth.me();
    } catch {
      return { path: '/login' };
    }
  }
  const menu = to.meta.menu as string | undefined;
  if (menu && auth.user && !auth.user.menu_perms.includes(menu as never) && auth.user.role_key !== 'boss') {
    // 不吭声地弹回看板，用户读到的是「这个菜单坏了」；说清楚是谁挡的
    ElMessage.warning(`你的角色没有「${String(to.meta.title ?? to.path)}」权限，已回到经营看板`);
    return { path: '/dashboard' };
  }
  return true;
});

/**
 * 懒加载 chunk 拉不到时必须自愈。
 *
 * 不处理的后果就是「点了没反应」：vue-router 遇到 import() 失败只放弃这次导航，
 * 而 el-menu 的高亮已经跳过去了 —— 用户看到的是界面死了，实际是服务端重启过 / 端口连错了 /
 * 部署换了产物（本项目真踩过：5173 被另一个 React 项目占着，所有模块请求回来的都是 HTML）。
 * 只重载一次，避免服务端真不在时陷入刷新循环。
 */
const CHUNK_RELOAD_KEY = 'tk_chunk_reloaded';

router.onError((error) => {
  const msg = String((error as Error)?.message ?? error);
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return;
  if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    ElMessage.error('页面资源加载失败：请确认后端服务在跑、地址是 http://127.0.0.1:8787，然后重新刷新');
    return;
  }
  sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  window.location.reload();
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '')} · TikTok 运营管理后台`;
  // 这次导航成功了，就把「只重载一次」的闸门重新打开
  sessionStorage.removeItem(CHUNK_RELOAD_KEY);
});
