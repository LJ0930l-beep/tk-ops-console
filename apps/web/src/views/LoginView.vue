<template>
  <div class="login-wrap">
    <el-card class="login-card" shadow="always">
      <div style="text-align: center; margin-bottom: 20px">
        <el-icon size="36" color="#409eff"><Promotion /></el-icon>
        <h2 style="margin: 8px 0 4px">TikTok 运营管理后台</h2>
        <div style="color: #909399; font-size: 13px">多店铺 · 达人建联 · 内容直播 · 广告投放 · 利润核算</div>
      </div>
      <el-form :model="form" @keyup.enter="doLogin">
        <el-form-item>
          <el-input v-model="form.username" placeholder="登录账号" size="large" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password :prefix-icon="Lock" />
        </el-form-item>
        <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="doLogin">登 录</el-button>
      </el-form>
      <el-divider>演示账号（密码均为 Passw0rd!）</el-divider>
      <div class="demo-accounts">
        <el-tag v-for="a in demoAccounts" :key="a.u" size="small" effect="plain" style="cursor: pointer; margin: 2px" @click="fill(a.u)">
          {{ a.label }} {{ a.u }}
        </el-tag>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Lock, Promotion, User } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';
import { errMsg } from '@/api/client';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const loading = ref(false);
const form = reactive({ username: 'boss', password: 'Passw0rd!' });

const demoAccounts = [
  { label: '老板', u: 'boss' },
  { label: '运营', u: 'limy' },
  { label: 'BD', u: 'chenbd' },
  { label: '财务', u: 'finwu' },
  { label: '剪辑', u: 'yinuo' },
];

function fill(u: string) {
  form.username = u;
  form.password = 'Passw0rd!';
}

async function doLogin() {
  if (!form.username || !form.password) return ElMessage.warning('请输入账号与密码');
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    ElMessage.success(`欢迎，${auth.user?.real_name}`);
    router.push(String(route.query.redirect ?? '/actions'));
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1d2b3a 0%, #2b5876 100%);
}
.login-card {
  width: 400px;
  padding: 8px 12px 16px;
}
.demo-accounts {
  text-align: center;
}
</style>
