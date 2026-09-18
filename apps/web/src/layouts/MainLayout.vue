<template>
  <el-container style="height: 100vh">
    <el-aside :width="collapsed ? '64px' : '220px'" style="background: #1d2b3a; transition: width 0.2s">
      <div style="height: 56px; display: flex; align-items: center; color: #fff; padding: 0 16px; white-space: nowrap; overflow: hidden">
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
      <el-header style="display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #e4e7ed; height: 56px">
        <div style="display: flex; align-items: center; gap: 12px">
          <el-icon style="cursor: pointer" size="18" @click="collapsed = !collapsed">
            <component :is="collapsed ? 'Expand' : 'Fold'" />
          </el-icon>
          <span style="font-size: 15px; font-weight: 600">{{ routeTitle }}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 14px">
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
      <el-main style="padding: 0; overflow-y: auto">
        <router-view v-slot="{ Component }">
          <keep-alive :max="10"><component :is="Component" :key="route.path" /></keep-alive>
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
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { MENUS } from '@tk/shared';
import { useAuthStore } from '@/stores/auth';
import { apiGet, apiPost, errMsg } from '@/api/client';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const collapsed = ref(window.innerWidth < 992);
const alertCount = ref(0);

const phaseReady = new Set(['dashboard', 'shop', 'product', 'order', 'creator', 'content', 'ads', 'finance', 'system', 'stock']);
const visibleMenus = computed(() =>
  MENUS.filter((m) => phaseReady.has(m.key) && (auth.user?.role_key === 'boss' || auth.user?.menu_perms.includes(m.key))),
);
const activeMenu = computed(() => route.path);
const routeTitle = computed(() => String(route.meta.title ?? ''));

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

onMounted(async () => {
  try {
    const rows = await apiGet<{ status: number }[]>('/system/synclog/health');
    alertCount.value = (Array.isArray(rows) ? rows : []).filter((r) => Number(r.status) >= 2).length;
  } catch {
    /* 静默 */
  }
});
</script>
