<template>
  <div class="dict-page">
    <el-card class="left" shadow="never">
      <div class="head">
        <span class="title">字典类型</span>
        <el-button link type="primary" size="small" :icon="Refresh" @click="loadTypes">刷新</el-button>
      </div>
      <ul class="types">
        <li
          v-for="t in types"
          :key="t.dict_type"
          :class="{ active: t.dict_type === current }"
          @click="pick(t.dict_type)"
        >
          <div class="t-main">{{ typeLabel(t.dict_type) }}</div>
          <div class="t-sub">{{ t.dict_type }}</div>
          <span class="cnt">{{ t.cnt }}</span>
        </li>
      </ul>
      <el-divider style="margin: 8px 0" />
      <el-input v-model="newType" size="small" placeholder="新字典类型名（英文/下划线）" maxlength="50">
        <template #append><el-button @click="createType">新建类型</el-button></template>
      </el-input>
      <div class="tip">
        下拉选项全站统一走 <code>/api/system/dict/:type</code>，加选项不改程序；状态=停用的选项不出现在下拉里。
      </div>
    </el-card>

    <div class="right">
      <ResourcePage
        v-if="current"
        ref="rp"
        :key="`${current}-${tick}`"
        api="/system/dict"
        :title="`${typeLabel(current)} 字典项`"
        :columns="columns"
        :search-fields="searchFields"
        :form-fields="formFields"
        :extra-query="{ dict_type: current }"
        :before-submit="beforeSubmit"
        :can-write="canWrite"
        :action-width="130"
        dialog-width="620px"
      >
        <template #toolbar-extra>
          <span class="tip">当前类型：<b>{{ current }}</b>（{{ typeLabel(current) }}）· 唯一键 (dict_type, dict_value)</span>
        </template>
      </ResourcePage>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { apiGet, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const auth = useAuthStore();
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('system'));

const STATUS_OPTIONS: OptionDef[] = [
  { value: 1, label: '启用', type: 'success' },
  { value: 0, label: '停用', type: 'info' },
];
/** 方案表 26 已知类型中文名，其余原样展示 */
const TYPE_LABELS: Record<string, string> = {
  category: '商品品类',
  creator_tag: '达人标签',
  return_reason: '退款原因',
  expense_type: '费用类型',
  region: '站点',
  gmv_level: '达人带货力等级',
  safety_threshold: '库存安全阈值',
  ship_method: '发货方式',
};
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

interface TypeRow {
  dict_type: string;
  cnt: number;
}
const types = ref<TypeRow[]>([]);
const current = ref('');
const tick = ref(0);
const newType = ref('');

async function loadTypes() {
  try {
    types.value = await apiGet<TypeRow[]>('/system/dict/types');
    if (!current.value && types.value.length) current.value = types.value[0].dict_type;
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(loadTypes);

function pick(t: string) {
  if (current.value === t) return;
  current.value = t;
}

function createType() {
  const t = newType.value.trim();
  if (!t) return ElMessage.warning('请先填写字典类型名');
  newType.value = '';
  if (!types.value.some((x) => x.dict_type === t)) types.value = [...types.value, { dict_type: t, cnt: 0 }];
  current.value = t;
  tick.value += 1;
}

/** 右侧增删改后同步左侧计数 */
watch(
  () => rp.value?.rows?.length,
  (len) => {
    if (typeof len !== 'number' || !current.value) return;
    types.value = types.value.map((t) => (t.dict_type === current.value ? { ...t, cnt: len } : t));
  },
);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'dict_value', label: '选项值 value', width: 160 },
  { prop: 'dict_label', label: '显示名称 label', minWidth: 200 },
  { prop: 'sort', label: '排序', width: 90 },
  { prop: 'status', label: '状态', width: 90, type: 'tag', options: STATUS_OPTIONS },
  { prop: 'updated_at', label: '更新时间', width: 160, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [{ key: 'keyword', label: '选项', placeholder: '按 value / label 模糊搜索' }]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'dict_type', label: '字典类型', required: true, default: current.value, disabledOnEdit: true, placeholder: '≤50 字' },
  { key: 'dict_label', label: '显示名称', required: true, placeholder: '≤100 字，下拉里看到的文字' },
  { key: 'dict_value', label: '选项值', required: true, placeholder: '≤50 字，落库值，与类型联合唯一' },
  { key: 'sort', label: '排序', type: 'number', min: 0, max: 9999, precision: 0, default: 0 },
  { key: 'status', label: '状态', type: 'switch', default: 1 },
]);

/** 空字符串不提交，避免后端 zod 校验失败 */
function beforeSubmit(values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...values, dict_type: values.dict_type || current.value };
  for (const [k, v] of Object.entries(out)) if (v === '' || v === undefined) delete out[k];
  return out;
}
</script>

<style scoped>
.dict-page {
  display: flex;
  align-items: flex-start;
  gap: 0;
  padding: 16px;
}
.left {
  width: 240px;
  flex: none;
}
.right {
  flex: 1;
  min-width: 0;
}
.right :deep(.page) {
  padding: 0;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.types {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 52vh;
  overflow: auto;
}
.types li {
  position: relative;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.types li:hover {
  background: #f5f7fa;
}
.types li.active {
  background: #ecf5ff;
  color: #409eff;
}
.t-main {
  font-size: 13px;
  font-weight: 600;
}
.t-sub {
  font-size: 12px;
  color: #909399;
}
.cnt {
  position: absolute;
  right: 8px;
  top: 12px;
  font-size: 12px;
  color: #909399;
}
.tip {
  color: #909399;
  font-size: 12px;
  line-height: 1.5;
  margin-top: 8px;
  display: block;
}
</style>
