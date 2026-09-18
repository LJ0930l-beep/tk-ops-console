<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <div class="head">
        <div>
          <span class="title">角色权限</span>
          <span class="tip">共 {{ roles.length }} 个角色；权限三层：菜单可见 → 数据范围 → 敏感字段/导出。变更立即对角色下所有账号生效，并写入操作日志。</span>
        </div>
        <div>
          <el-button :icon="Refresh" @click="load">刷新</el-button>
          <el-button v-if="canWrite" type="primary" :icon="Plus" @click="openCreate">新增角色</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="roles" border stripe size="small" row-key="id" style="width: 100%">
        <el-table-column prop="role_name" label="角色名称" width="150" fixed="left" show-overflow-tooltip />
        <el-table-column prop="role_key" label="角色标识" width="140" show-overflow-tooltip />
        <el-table-column prop="data_scope" label="数据范围" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="scopeTag(row.data_scope)">{{ scopeLabel(row.data_scope) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="敏感权限" width="230">
          <template #default="{ row }">
            <el-tag size="small" :type="on(row.can_see_cost) ? 'danger' : 'info'" effect="plain" class="perm">可见成本</el-tag>
            <el-tag size="small" :type="on(row.can_see_contact) ? 'warning' : 'info'" effect="plain" class="perm">联系方式</el-tag>
            <el-tag size="small" :type="on(row.can_export) ? 'success' : 'info'" effect="plain" class="perm">导出</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可见菜单" min-width="300">
          <template #default="{ row }">
            <el-tag v-for="k in permsOf(row)" :key="k" size="small" effect="plain" class="perm">{{ menuTitle(k) }}</el-tag>
            <span v-if="!permsOf(row).length" class="tip">未授权任何菜单</span>
          </template>
        </el-table-column>
        <el-table-column prop="user_count" label="账号数" width="90" align="right" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canWrite" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-else link size="small" @click="openEdit(row, true)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有角色，先新增一个或执行数据库 seed 初始化默认 10 个角色" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="visible" :title="readOnly ? '查看角色权限' : form.id ? '编辑角色' : '新增角色'" width="720px" destroy-on-close>
      <el-alert
        v-if="form.id && Number(form.user_count) > 0"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        :title="`该角色下有 ${form.user_count} 个账号，保存后其可见菜单、数据范围与敏感字段权限立即变化`"
      />
      <el-form :model="form" label-width="110px" :disabled="readOnly">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="角色名称" required>
              <el-input v-model="form.role_name" maxlength="50" placeholder="如 运营主管" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="角色标识" required>
              <el-input v-model="form.role_key" :disabled="readOnly || !!form.id" maxlength="50" placeholder="英文 key，唯一，如 ops_manager" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数据范围">
              <el-select v-model="form.data_scope" style="width: 100%">
                <el-option v-for="o in SCOPE_OPTIONS" :key="String(o.value)" :label="o.label" :value="Number(o.value)" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="敏感与导出">
              <div class="switches">
                <span class="sw"><em>可见成本</em><el-switch v-model="form.can_see_cost" :active-value="1" :inactive-value="0" /></span>
                <span class="sw"><em>联系方式</em><el-switch v-model="form.can_see_contact" :active-value="1" :inactive-value="0" /></span>
                <span class="sw"><em>导出</em><el-switch v-model="form.can_export" :active-value="1" :inactive-value="0" /></span>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="可见菜单">
          <el-checkbox-group v-model="form.menu_perms" class="menu-tree">
            <div v-for="m in MENUS" :key="m.key" class="menu-node">
              <el-checkbox :value="m.key">
                <span class="menu-title">{{ m.title }}</span>
                <el-tag size="small" type="info" effect="plain">阶段{{ m.phase }}</el-tag>
              </el-checkbox>
              <div class="menu-sub">{{ m.children.map((c) => c.title).join(' · ') }}</div>
            </div>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">{{ readOnly ? '关闭' : '取消' }}</el-button>
        <el-button v-if="!readOnly" type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import { DATA_SCOPE, MENUS, type MenuKey } from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('system'));

/** GET /system/roles 返回数组（非分页体），故本页自定义表格 */
const RoleRow = { id: 0, role_name: '', role_key: '', menu_perms: [] as string[], data_scope: 1, can_see_cost: 0, can_see_contact: 0, can_export: 0, user_count: 0 };
type RoleRow = typeof RoleRow;

const loading = ref(false);
const saving = ref(false);
const visible = ref(false);
const readOnly = ref(false);
const roles = ref<RoleRow[]>([]);
const form = reactive<RoleRow>({ ...RoleRow });

const SCOPE_OPTIONS = [
  { value: DATA_SCOPE.ALL, label: '全部数据', tag: 'danger' as const },
  { value: DATA_SCOPE.DEPT, label: '本部门数据', tag: 'warning' as const },
  { value: DATA_SCOPE.SELF, label: '仅本人数据', tag: 'info' as const },
  { value: DATA_SCOPE.SHOPS, label: '按授权店铺', tag: 'primary' as const },
];

async function load() {
  loading.value = true;
  try {
    roles.value = await apiGet<RoleRow[]>('/system/roles');
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function on(v: unknown) {
  return Number(v) === 1;
}
function permsOf(row: Record<string, unknown>) {
  return Array.isArray(row.menu_perms) ? (row.menu_perms as string[]) : [];
}
function menuTitle(key: string) {
  return MENUS.find((m) => m.key === key)?.title ?? key;
}
function scopeLabel(v: unknown) {
  return String(SCOPE_OPTIONS.find((o) => Number(o.value) === Number(v))?.label ?? `未知(${String(v)})`);
}
function scopeTag(v: unknown) {
  return SCOPE_OPTIONS.find((o) => Number(o.value) === Number(v))?.tag ?? 'info';
}

function openCreate() {
  Object.assign(form, { ...RoleRow, id: 0, menu_perms: ['dashboard'], data_scope: DATA_SCOPE.SELF, user_count: 0 });
  readOnly.value = false;
  visible.value = true;
}

function openEdit(row: RoleRow, view = false) {
  Object.assign(form, { ...row, menu_perms: [...(row.menu_perms ?? [])] });
  readOnly.value = view;
  visible.value = true;
}

async function submit() {
  if (!form.role_name.trim()) return ElMessage.warning('请填写角色名称');
  if (!form.role_key.trim()) return ElMessage.warning('请填写角色标识');
  const body = {
    role_name: form.role_name.trim(),
    role_key: form.role_key.trim(),
    menu_perms: form.menu_perms as MenuKey[],
    data_scope: Number(form.data_scope),
    can_see_cost: form.can_see_cost ? 1 : 0,
    can_see_contact: form.can_see_contact ? 1 : 0,
    can_export: form.can_export ? 1 : 0,
  };
  saving.value = true;
  try {
    if (form.id) await apiPut(`/system/roles/${form.id}`, body);
    else await apiPost('/system/roles', body);
    ElMessage.success('已保存，权限变更已写入操作日志');
    visible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}
.tip {
  color: #909399;
  font-size: 12px;
}
.perm {
  margin-right: 4px;
}
.switches {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.sw {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sw em {
  font-style: normal;
  font-size: 12px;
  color: #606266;
}
.menu-tree {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 12px;
}
.menu-node {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 4px 8px;
}
.menu-title {
  font-weight: 600;
  margin-right: 6px;
}
.menu-sub {
  color: #909399;
  font-size: 12px;
  padding-left: 24px;
  line-height: 1.4;
}
</style>
