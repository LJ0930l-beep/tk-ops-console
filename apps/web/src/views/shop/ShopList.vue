<template>
  <div>
    <div v-if="rp && !rp.rows.length" class="page-tip">
      <el-alert type="info" :closable="false" show-icon title="还没有店铺">
        <template #default>
          先新增一个店铺并完成授权，之后才能同步商品、订单与结算数据。授权凭证（App Key / App Secret）加密存储，页面与操作日志均不回显明文。
        </template>
      </el-alert>
    </div>

    <ResourcePage
      ref="rp"
      api="/shops"
      title="店铺"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :row-class-name="rowClass"
      :map-row="mapRow"
      :action-width="210"
      dialog-width="720px"
    >
      <template #actions="{ row }">
        <el-button v-if="canWrite" link type="warning" size="small" @click="openAuth(row)">重新授权</el-button>
      </template>
    </ResourcePage>

    <el-dialog v-model="authVisible" :title="`重新授权 · ${authTarget?.shop_name ?? ''}`" width="520px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
        <template #default>提交后服务端加密保存 App Key / App Secret，明文不回显、不入日志；授权成功后 auth_status 置为「已授权」。</template>
      </el-alert>
      <el-form ref="authFormRef" :model="authForm" :rules="authRules" label-width="120px">
        <el-form-item label="App Key" prop="app_key">
          <el-input v-model="authForm.app_key" placeholder="开放平台应用 Key" />
        </el-form-item>
        <el-form-item label="App Secret" prop="app_secret">
          <el-input v-model="authForm.app_secret" type="password" show-password placeholder="开放平台应用密钥" />
        </el-form-item>
        <el-form-item label="Shop Cipher">
          <el-input v-model="authForm.shop_cipher" placeholder="店铺 Cipher（商品/订单接口必填）" maxlength="128" />
        </el-form-item>
        <el-form-item label="令牌到期时间">
          <el-date-picker v-model="authForm.token_expire_at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="authVisible = false">取消</el-button>
        <el-button type="primary" :loading="authLoading" @click="submitAuth">提交授权</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { REGIONS, SHOP_AUTH_STATUS } from '@tk/shared';
import { apiGet, apiPost, errMsg, type Paged } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const auth = useAuthStore();
/** 通用组件实例（rows / reload / openCreate）；用 any 以免依赖子组件类型导出 */
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('shop'));

const SHOP_TYPE: OptionDef[] = [
  { value: 1, label: '跨境店' },
  { value: 2, label: '本土店' },
];
const SHOP_STATUS: OptionDef[] = [
  { value: 1, label: '运营中', type: 'success' },
  { value: 2, label: '暂停', type: 'warning' },
  { value: 3, label: '已关店', type: 'info' },
];
const AUTH_STATUS: OptionDef[] = [
  { value: SHOP_AUTH_STATUS.UNAUTHORIZED, label: '未授权', type: 'info' },
  { value: SHOP_AUTH_STATUS.AUTHORIZED, label: '已授权', type: 'success' },
  { value: SHOP_AUTH_STATUS.EXPIRING, label: '即将过期', type: 'warning' },
  { value: SHOP_AUTH_STATUS.EXPIRED, label: '已失效', type: 'danger' },
];
const REGION_OPTIONS: OptionDef[] = REGIONS.map((r) => ({ value: r, label: r }));

/** 员工下拉：仅持 system 菜单的角色可读取 /system/users */
const ownerOptions = ref<OptionDef[]>([]);
const ownerOptionsFn = () => ownerOptions.value;

onMounted(async () => {
  if (!auth.menus.includes('system')) return; // 负责人下拉依赖 /system/users（需 system 菜单）
  try {
    const r = await apiGet<Paged<Record<string, unknown>>>('/system/users', { page: 1, pageSize: 200 });
    ownerOptions.value = (r.list ?? []).map((u) => ({ value: Number(u.id), label: `${String(u.real_name ?? u.username)}（${String(u.username)}）` }));
  } catch {
    /* 无权限时负责人下拉留空 */
  }
});

const columns = computed<ColumnDef[]>(() => [
  { prop: 'shop_name', label: '店铺名称', minWidth: 160, fixed: 'left' },
  { prop: 'tk_shop_id', label: '平台店铺 ID', width: 150 },
  { prop: 'region', label: '站点', width: 70 },
  { prop: 'shop_type', label: '店铺类型', width: 90, type: 'tag', options: SHOP_TYPE },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'timezone', label: '时区', width: 140 },
  { prop: 'auth_status', label: '授权状态', width: 100, type: 'tag', options: AUTH_STATUS },
  { prop: 'expire_left', label: '授权剩余', width: 110 },
  { prop: 'token_expire_at', label: '令牌到期时间', width: 150, type: 'datetime', sortable: true },
  { prop: 'owner_name', label: '负责人', width: 100 },
  { prop: 'status', label: '经营状态', width: 100, type: 'tag', options: SHOP_STATUS },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '店铺名称', placeholder: '模糊搜索' },
  { key: 'region', label: '站点', type: 'select', options: REGION_OPTIONS },
  { key: 'shop_type', label: '店铺类型', type: 'select', options: SHOP_TYPE },
  { key: 'auth_status', label: '授权状态', type: 'select', options: AUTH_STATUS },
  { key: 'status', label: '经营状态', type: 'select', options: SHOP_STATUS },
  ...(ownerOptions.value.length ? [{ key: 'owner_id', label: '负责人', type: 'select' as const, options: ownerOptions.value }] : []),
]);

/** 表单校验对齐后端 shopBody（zod） */
const formFields = computed<FormFieldDef[]>(() => [
  { key: 'shop_name', label: '店铺名称', required: true, span: 12, placeholder: '1~100 字' },
  { key: 'tk_shop_id', label: '平台店铺 ID', span: 12, placeholder: '选填，全局唯一' },
  { key: 'region', label: '站点', type: 'select', required: true, options: REGION_OPTIONS },
  { key: 'shop_type', label: '店铺类型', type: 'select', options: SHOP_TYPE, default: 1 },
  { key: 'currency', label: '币种', required: true, span: 12, placeholder: '3 位字母码，如 USD' },
  { key: 'timezone', label: '时区', span: 12, default: 'Asia/Shanghai', placeholder: '如 Asia/Shanghai' },
  { key: 'shop_cipher', label: 'Shop Cipher', span: 24, placeholder: '商品/订单接口需要，≤128 字' },
  { key: 'auth_status', label: '授权状态', type: 'select', options: AUTH_STATUS, default: SHOP_AUTH_STATUS.UNAUTHORIZED },
  { key: 'token_expire_at', label: '令牌到期时间', type: 'datetime' },
  { key: 'owner_id', label: '负责人', type: 'select', options: ownerOptionsFn },
  { key: 'status', label: '经营状态', type: 'select', options: SHOP_STATUS, default: 1 },
]);

/** 授权剩余天数（与后端 withAuthExpiry 同口径：小于 7 天视为即将过期） */
function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.token_expire_at;
  let left = '-';
  if (raw) {
    const exp = Date.parse(String(raw).replace(' ', 'T') + 'Z');
    if (Number.isFinite(exp)) {
      const days = Math.ceil((exp - Date.now()) / 86_400_000);
      left = days < 0 ? `已失效 ${-days} 天` : `剩 ${days} 天`;
    }
  }
  return { ...row, expire_left: left };
}

function rowClass({ row }: { row: Record<string, unknown> }): string {
  const s = Number(row.auth_status);
  if (s === SHOP_AUTH_STATUS.EXPIRED) return 'auth-row-danger';
  if (s === SHOP_AUTH_STATUS.EXPIRING) return 'auth-row-warn';
  return '';
}

/* ---------- 重新授权 ---------- */
const authVisible = ref(false);
const authLoading = ref(false);
const authTarget = ref<Record<string, unknown> | null>(null);
const authFormRef = ref<FormInstance>();
const authForm = reactive({ app_key: '', app_secret: '', shop_cipher: '', token_expire_at: '' });
const authRules: FormRules = {
  app_key: [{ required: true, message: '请填写 App Key', trigger: 'blur' }],
  app_secret: [{ required: true, message: '请填写 App Secret', trigger: 'blur' }],
};

function openAuth(row: Record<string, unknown>) {
  authTarget.value = row;
  authForm.app_key = '';
  authForm.app_secret = '';
  authForm.shop_cipher = String(row.shop_cipher ?? '');
  authForm.token_expire_at = '';
  authVisible.value = true;
}

async function submitAuth() {
  const id = Number(authTarget.value?.id);
  if (!id) return;
  const valid = await authFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  authLoading.value = true;
  try {
    await apiPost(`/shops/${id}/auth`, {
      app_key: authForm.app_key,
      app_secret: authForm.app_secret,
      shop_cipher: authForm.shop_cipher || undefined,
      token_expire_at: authForm.token_expire_at || undefined,
    });
    ElMessage.success('授权信息已更新');
    authVisible.value = false;
    rp.value?.reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    authLoading.value = false;
  }
}
</script>

<style scoped>
.page-tip {
  padding: 12px 16px 0;
}
:deep(tr.auth-row-warn td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(tr.auth-row-danger td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
