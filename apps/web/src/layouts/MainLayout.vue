<template>
  <el-container style="height: 100vh">
    <el-aside :width="collapsed ? '64px' : '220px'" class="side">
      <div class="brand">
        <el-icon size="20" style="margin-right: 8px"><Promotion /></el-icon>
        <b v-show="!collapsed">TikTok 运营后台</b>
      </div>
      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        background-color="#1d2b3a"
        text-color="#a9b7c6"
        active-text-color="#ffd04b"
        router
      >
        <template v-for="m in visibleMenus" :key="m.key">
          <el-sub-menu v-if="m.children.length > 1" :index="m.key">
            <template #title>
              <el-icon><component :is="m.icon" /></el-icon>
              <span>{{ m.title }}</span>
            </template>
            <el-menu-item v-for="c in m.children" :key="c.path" :index="c.path">{{ c.title }}</el-menu-item>
          </el-sub-menu>
          <el-menu-item v-else :index="m.children[0]?.path">
            <el-icon><component :is="m.icon" /></el-icon>
            <template #title>{{ m.title }}</template>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="bar">
        <div class="bar-left">
          <el-icon style="cursor: pointer" size="18" @click="collapsed = !collapsed">
            <component :is="collapsed ? Expand : Fold" />
          </el-icon>
          <!-- 顶栏只报「在哪一组」，页面自己的标题交给页头：两处都写同一个标题会显得重复 -->
          <el-breadcrumb separator="/">
            <el-breadcrumb-item v-if="routeGroup">{{ routeGroup }}</el-breadcrumb-item>
            <el-breadcrumb-item>{{ routeTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div style="display: flex; align-items: center; gap: 14px">
          <el-popover
            v-if="canSeeActions"
            v-model:visible="notificationVisible"
            placement="bottom-end"
            :width="360"
            trigger="click"
            @show="loadNotifications"
          >
            <template #reference>
              <el-badge :value="notificationUnread" :hidden="notificationUnread === 0" :max="99">
                <el-button circle text aria-label="个人到期提醒">
                  <el-icon size="18"><Bell /></el-icon>
                </el-button>
              </el-badge>
            </template>
            <div class="notification-head">
              <b>个人到期提醒</b>
              <span>{{ notificationUnread }} 条未读</span>
            </div>
            <el-scrollbar v-loading="notificationsLoading" max-height="340px">
              <el-empty v-if="!notifications.length && !notificationsLoading" :image-size="48" description="暂无到期提醒" />
              <div v-for="item in notifications" :key="item.id" class="notification-row" :class="{ unread: !item.read_at }">
                <button class="notification-link" type="button" @click="openNotification(item)">
                  <span class="notification-title">{{ item.target_name || item.rule_name }}</span>
                  <span class="notification-sub">{{ item.rule_name }} · 到期 {{ formatUtcTimestamp(item.due_at) }}</span>
                </button>
                <el-button v-if="!item.read_at" link type="primary" size="small" @click="markNotificationRead(item)">标记已读</el-button>
              </div>
            </el-scrollbar>
          </el-popover>
          <el-tooltip content="同步监控"><el-badge :value="alertCount" :hidden="alertCount === 0" @click="router.push('/system/synclog')"><el-icon size="18"><Bell /></el-icon></el-badge></el-tooltip>
          <el-dropdown @command="onCommand">
            <span style="cursor: pointer; display: flex; align-items: center; gap: 6px">
              <el-avatar :size="28">{{ auth.user?.real_name?.[0] ?? '?' }}</el-avatar>
              {{ auth.user?.real_name }}<el-tag size="small" type="info">{{ auth.user?.role_name }}</el-tag>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="body">
        <router-view v-slot="{ Component }">
          <transition name="tk-route" mode="out-in">
            <keep-alive :max="10"><component :is="Component" :key="route.path" /></keep-alive>
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="pwdVisible" title="修改密码" width="380px">
    <el-form label-width="90px">
      <el-form-item label="原密码"><el-input v-model="pwd.oldPassword" type="password" show-password /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="pwd.newPassword" type="password" show-password placeholder="至少 8 位" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="pwdVisible = false">取消</el-button>
      <el-button type="primary" :loading="pwdLoading" @click="changePassword">确认</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ArrowDown, Bell, Expand, Fold, Promotion } from '@element-plus/icons-vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { MENUS } from '@tk/shared';
import { useAuthStore } from '@/stores/auth';
import { apiGet, apiPost, errMsg } from '@/api/client';
import { formatUtcTimestamp } from '@/utils/date';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const collapsed = ref(window.innerWidth < 992);
const alertCount = ref(0);
const notificationVisible = ref(false);
const notificationsLoading = ref(false);
const notifications = ref<DueNotification[]>([]);
const notificationUnread = ref(0);
let notificationTimer: ReturnType<typeof setInterval> | undefined;

interface DueNotification {
  id: number;
  alert_event_id: number;
  due_at: string;
  read_at: string | null;
  target_name: string | null;
  rule_name: string;
  priority: number;
}

// 侧边栏只有一个真相：MENUS ∩ 这个人的 menu_perms。
// 这里以前另有一份手写的 phaseReady 白名单，后果是新菜单在权限里、在路由里、直接敲 URL 也进得去，
// 唯独侧边栏没有入口 —— 界面上看就是"这功能没做"。要按阶段隐藏请去权限矩阵上配，别在组件里再记一份。
const visibleMenus = computed(() =>
  MENUS.filter((m) => auth.user?.role_key === 'boss' || auth.user?.menu_perms.includes(m.key)),
);
const activeMenu = computed(() => route.path);
const routeTitle = computed(() => String(route.meta.title ?? ''));
const routeGroup = computed(() => MENUS.find((m) => m.key === route.meta.menu)?.title ?? '');
const canSeeActions = computed(() => auth.user?.role_key === 'boss' || auth.user?.menu_perms.includes('dashboard') === true);

const pwdVisible = ref(false);
const pwdLoading = ref(false);
const pwd = reactive({ oldPassword: '', newPassword: '' });

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    auth.logout();
    router.push('/login');
  } else if (cmd === 'password') {
    pwd.oldPassword = '';
    pwd.newPassword = '';
    pwdVisible.value = true;
  }
}

async function changePassword() {
  pwdLoading.value = true;
  try {
    await apiPost('/auth/password', { ...pwd });
    ElMessage.success('密码已更新');
    pwdVisible.value = false;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    pwdLoading.value = false;
  }
}

async function loadNotifications(): Promise<void> {
  if (!canSeeActions.value) return;
  notificationsLoading.value = true;
  try {
    // 提醒 inbox 由调度器每 15 分钟生成；这里显式补一次同步（写操作只在 POST 上做，GET 已经不改库了）
    await apiPost('/actions/notifications/sync', {}).catch(() => undefined);
    const result = await apiGet<{ list: DueNotification[]; unread_total: number }>('/actions/notifications');
    notifications.value = result.list ?? [];
    notificationUnread.value = Number(result.unread_total ?? 0);
  } catch {
    /* Keep the global header quiet when a reminder refresh fails. */
  } finally {
    notificationsLoading.value = false;
  }
}

async function markNotificationRead(item: DueNotification): Promise<boolean> {
  try {
    const wasUnread = !item.read_at;
    const result = await apiPost<{ id: number; read_at: string }>(`/actions/notifications/${item.id}/read`, {});
    item.read_at = result.read_at;
    if (wasUnread) notificationUnread.value = Math.max(0, notificationUnread.value - 1);
    return true;
  } catch (error) {
    ElMessage.error(errMsg(error));
    await loadNotifications();
    return false;
  }
}

async function openNotification(item: DueNotification): Promise<void> {
  if (!await markNotificationRead(item)) return;
  notificationVisible.value = false;
  await router.push({ path: '/actions', query: { event_id: String(item.alert_event_id) } });
}

onMounted(async () => {
  try {
    const rows = await apiGet<{ status: number }[]>('/system/synclog/health');
    alertCount.value = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.status) >= 2).length;
  } catch {
    /* 静默 */
  }
  await loadNotifications();
  notificationTimer = setInterval(() => void loadNotifications(), 60_000);
});

onBeforeUnmount(() => {
  if (notificationTimer) clearInterval(notificationTimer);
});
</script>

<style scoped>
.side {
  background: var(--tk-navy);
  transition: width var(--tk-dur) var(--tk-ease);
}
.brand {
  height: 56px;
  display: flex;
  align-items: center;
  color: #fff;
  padding: 0 var(--tk-s4);
  white-space: nowrap;
  overflow: hidden;
}
/* 当前菜单项：EP 默认只换个字色，一屏 37 项里很难一眼找到自己在哪 */
.side :deep(.el-menu-item.is-active) {
  background: #16222e !important;
  position: relative;
}
.side :deep(.el-menu-item.is-active)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--tk-navy-active);
}
.side :deep(.el-menu-item:hover),
.side :deep(.el-sub-menu__title:hover) {
  background: #223444 !important;
}
.side :deep(.el-menu) {
  border-right: none;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--tk-surface);
  border-bottom: 1px solid var(--tk-border);
  height: 56px;
  position: sticky;
  top: 0;
  z-index: 10;
}
.bar-left {
  display: flex;
  align-items: center;
  gap: var(--tk-s3);
}
.bar-left :deep(.el-breadcrumb) {
  font-size: 14px;
  line-height: 1;
}
.bar-left :deep(.el-breadcrumb__inner) {
  color: var(--tk-muted);
  font-weight: 400;
}
.bar-left :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
  color: var(--tk-ink);
  font-weight: 600;
}
.body {
  padding: 0;
  overflow-y: auto;
  background: var(--tk-canvas);
}
.notification-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.notification-head span, .notification-sub { color: var(--tk-muted); font-size: 12px; }
.notification-row { display: flex; align-items: center; gap: var(--tk-s2); padding: 9px 4px; border-top: 1px solid var(--tk-line); transition: background var(--tk-dur) var(--tk-ease); }
.notification-row:hover { background: var(--tk-surface-2); }
.notification-row.unread .notification-title { font-weight: 600; }
.notification-link { display: flex; flex: 1; min-width: 0; flex-direction: column; align-items: flex-start; gap: 3px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.notification-title, .notification-sub { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notification-link:hover .notification-title { color: var(--tk-primary); }
</style>
