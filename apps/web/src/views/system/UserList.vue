<template>
  <div>
    <ResourcePage
      ref="rp"
      api="/system/users"
      title="员工"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :deletable="false"
      :before-submit="beforeSubmit"
      :action-width="240"
      dialog-width="700px"
    >
      <template #toolbar-extra>
        <span class="tip">员工离职只做「停用」，不物理删除，历史记录（订单/跟进/日志）保持可追溯。</span>
      </template>

      <template #actions="{ row }">
        <el-button v-if="isBoss" link type="primary" size="small" @click="openShops(row)">分配店铺</el-button>
        <el-button v-if="canWrite" link type="warning" size="small" @click="resetPassword(row)">重置密码</el-button>
        <el-button v-if="canWrite && Number(row.status) === 1" link type="danger" size="small" @click="deactivate(row)">停用</el-button>
      </template>
    </ResourcePage>

    <el-dialog v-model="shopVisible" :title="`分配店铺 · ${shopTarget?.real_name ?? ''}`" width="520px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
        <template #default>勾选项即该员工的可见店铺（数据范围=按授权店铺时生效）；保存为整批覆盖，同事务写入 <code>sys_user_shop</code>。</template>
      </el-alert>
      <el-select v-model="shopIds" multiple filterable clearable placeholder="选择可见店铺" style="width: 100%" :loading="shopLoading">
        <el-option v-for="s in allShops" :key="String(s.id)" :label="`${s.shop_name}（${s.region}）`" :value="Number(s.id)" />
      </el-select>
      <template #footer>
        <el-button @click="shopVisible = false">取消</el-button>
        <el-button type="primary" :loading="shopSaving" @click="saveShops">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiGet, apiPost, apiPut, errMsg, type Paged } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

/** userRouter 整体 requireMenu('system')：无 system 菜单既看不到也写不了 */
const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('system'));
/** 授权类写操作（改角色/店铺范围/停高权账号）服务端要求 boss，前端同步只给 boss */
const isBoss = computed(() => auth.roleKey === 'boss');

const USER_STATUS: OptionDef[] = [
  { value: 1, label: '在职', type: 'success' },
  { value: 0, label: '停用', type: 'info' },
];

const roleOpts = ref<OptionDef[]>([]);
type ShopRow = { id: number; shop_name: string; region: string; currency: string };
const allShops = ref<ShopRow[]>([]);

onMounted(async () => {
  try {
    const roles = await apiGet<Record<string, unknown>[]>('/system/roles');
    // 非 boss 不得派发高危角色（与服务端 isPrivilegedRole 同口径）
    const privileged = (r: Record<string, unknown>) =>
      String(r.role_key) === 'boss' || Number(r.data_scope) === 1 || (r.menu_perms as string[] | undefined)?.includes('system');
    roleOpts.value = (roles ?? [])
      .filter((r) => isBoss.value || !privileged(r))
      .map((r) => ({ value: Number(r.id), label: `${String(r.role_name)}（${String(r.role_key)}）` }));
  } catch (e) {
    roleOpts.value = [];
    // 失败必须说一声：静默成空列表，界面就只显示「暂无数据」，
    // 用户和排障的人都分不出是「真没有」还是「接口挂了」（本轮就是这么被 /system/dict 骗过的）
    ElMessage.warning(errMsg(e));
  }
  allShops.value = (await dict.shopOptions().catch(() => [])) as ShopRow[];
});

const columns = computed<ColumnDef[]>(() => [
  { prop: 'username', label: '登录账号', width: 140, fixed: 'left' },
  { prop: 'real_name', label: '姓名', width: 120 },
  { prop: 'phone', label: '手机号', width: 130 },
  { prop: 'dept', label: '部门', width: 120 },
  { prop: 'role_name', label: '角色', width: 140 },
  { prop: 'role_key', label: '角色标识', width: 120 },
  { prop: 'shop_count', label: '授权店铺数', width: 110 },
  { prop: 'status', label: '状态', width: 90, type: 'tag', options: USER_STATUS },
  { prop: 'last_login_at', label: '最近登录', width: 150, type: 'datetime' },
  { prop: 'created_at', label: '入职时间', width: 150, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '账号/姓名', placeholder: '模糊搜索' },
  { key: 'role_id', label: '角色', type: 'select', options: roleOpts.value },
  { key: 'dept', label: '部门' },
  { key: 'status', label: '状态', type: 'select', options: USER_STATUS },
]);

/** 校验对齐后端 userBody：username 编辑时禁改、password 仅新建必填 */
const formFields = computed<FormFieldDef[]>(() => [
  { key: 'username', label: '登录账号', required: true, disabledOnEdit: true, placeholder: '2~64 字，创建后不可修改' },
  { key: 'password', label: '初始密码', required: true, when: (_f, editing) => !editing, placeholder: '8~64 位，仅新建时必填' },
  { key: 'real_name', label: '姓名', required: true, placeholder: '1~50 字' },
  { key: 'phone', label: '手机号', placeholder: '≤20 字' },
  { key: 'dept', label: '部门', placeholder: '≤50 字' },
  { key: 'role_id', label: '角色', type: 'select', required: true, options: () => roleOpts.value },
  { key: 'status', label: '状态', type: 'select', options: USER_STATUS, default: 1 },
]);

/** 新建不传 shop_ids：店铺授权统一走「分配店铺」，避免两处写同一张表 */
function beforeSubmit(values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== '' && v !== undefined) out[k] = v;
  return out;
}

/* ---------- 分配店铺 ---------- */
const shopVisible = ref(false);
const shopLoading = ref(false);
const shopSaving = ref(false);
const shopTarget = ref<Record<string, unknown> | null>(null);
const shopIds = ref<number[]>([]);

async function openShops(row: Record<string, unknown>) {
  shopTarget.value = row;
  shopIds.value = [];
  shopVisible.value = true;
  shopLoading.value = true;
  try {
    const rows = await apiGet<{ shop_id: number; shop_name: string }[]>(`/system/users/${row.id}/shops`);
    shopIds.value = (rows ?? []).map((s) => Number(s.shop_id));
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    shopLoading.value = false;
  }
}

async function saveShops() {
  const id = Number(shopTarget.value?.id);
  if (!id) return;
  shopSaving.value = true;
  try {
    await apiPut(`/system/data-scope/${id}`, { shop_ids: shopIds.value });
    ElMessage.success(`已保存 ${shopIds.value.length} 个可见店铺`);
    shopVisible.value = false;
    rp.value?.reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    shopSaving.value = false;
  }
}

/* ---------- 重置密码 / 停用 ---------- */
async function resetPassword(row: Record<string, unknown>) {
  try {
    const r = await ElMessageBox.prompt(`为员工「${String(row.real_name)}」设置新密码（至少 8 位）`, '重置密码', {
      confirmButtonText: '确定重置',
      cancelButtonText: '取消',
      inputType: 'password',
      inputPlaceholder: '8~64 位',
      inputValidator: (v: string) => (v && v.length >= 8 && v.length <= 64 ? true : '密码长度需为 8~64 位'),
    });
    await apiPut(`/system/users/${Number(row.id)}`, { password: String(r.value) });
    ElMessage.success('密码已重置，请线下告知本人并提醒尽快修改');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errMsg(e));
  }
}

async function deactivate(row: Record<string, unknown>) {
  try {
    await ElMessageBox.confirm(
      `停用后「${String(row.real_name)}（${String(row.username)}）」立即无法登录，其历史数据全部保留。确认停用？`,
      '停用员工',
      { confirmButtonText: '确认停用', cancelButtonText: '取消', type: 'warning' },
    );
    await apiPost(`/system/users/${Number(row.id)}/deactivate`);
    ElMessage.success('已停用');
    rp.value?.reload();
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errMsg(e));
  }
}
</script>

<style scoped>
.tip {
  color: #909399;
  font-size: 12px;
}
</style>
