<template>
  <div>
    <ResourcePage
      ref="rp"
      api="/system/oplog"
      title="操作日志"
      :columns="columns"
      :search-fields="searchFields"
      :extra-query="extraQuery"
      :map-row="mapRow"
      :createable="false"
      :editable="false"
      :deletable="false"
      :can-write="false"
      :action-width="100"
    >
      <template #toolbar-extra>
        <el-form inline class="inline-form" @submit.prevent>
          <el-form-item label="操作时间">
            <el-date-picker
              v-model="range"
              type="daterange"
              value-format="YYYY-MM-DD"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 240px"
              clearable
              @change="reloadFirst"
            />
          </el-form-item>
          <el-form-item>
            <el-button :icon="RefreshLeft" @click="resetAll">重置时间</el-button>
          </el-form-item>
          <el-form-item>
            <span class="tip">日志只读，任何人不可修改或删除。</span>
          </el-form-item>
        </el-form>
      </template>

      <template #actions="{ row }">
        <el-button link type="primary" size="small" @click="openDetail(row)">变更详情</el-button>
      </template>
    </ResourcePage>

    <el-dialog v-model="detailVisible" title="变更前后对照" width="900px">
      <el-descriptions :column="4" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="时间">{{ fmtDateTime(detail?.op_time) }}</el-descriptions-item>
        <el-descriptions-item label="操作人">{{ detail?.user_name ?? detail?.user_id ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="模块">{{ detail?.module ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="动作">{{ detail?.action ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="目标表">{{ detail?.target_table ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="目标 ID">{{ detail?.target_id ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="IP" :span="2">{{ detail?.ip ?? '—' }}</el-descriptions-item>
      </el-descriptions>
      <div class="diff">
        <div class="col">
          <div class="col-head before">变更前 before</div>
          <pre>{{ beforeText }}</pre>
        </div>
        <div class="col">
          <div class="col-head after">变更后 after</div>
          <pre>{{ afterText }}</pre>
        </div>
      </div>
      <span class="tip">密码等敏感字段服务端已写死为 ***，日志不落明文。</span>
      <template #footer><el-button @click="detailVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshLeft } from '@element-plus/icons-vue';
import { MENUS } from '@tk/shared';
import ResourcePage, { type ColumnDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const rp = ref();

const ACTION_OPTIONS: OptionDef[] = [
  { value: 'create', label: '新增 create', type: 'success' },
  { value: 'update', label: '修改 update', type: 'primary' },
  { value: 'delete', label: '删除 delete', type: 'danger' },
  { value: 'export', label: '导出 export', type: 'warning' },
  { value: 'login', label: '登录 login', type: 'info' },
];
/** sys_op_log.module 落的是中文菜单名，登录写 auth */
const MODULE_OPTIONS: OptionDef[] = [...MENUS.map((m) => ({ value: m.title, label: m.title })), { value: 'auth', label: '登录认证 auth' }];

const columns = computed<ColumnDef[]>(() => [
  { prop: 'op_time', label: '操作时间', width: 150, type: 'datetime', fixed: 'left' },
  { prop: 'user_name', label: '操作人', width: 120 },
  { prop: 'module', label: '模块', width: 120 },
  { prop: 'action', label: '动作', width: 120, type: 'tag', options: ACTION_OPTIONS },
  { prop: 'target_table', label: '目标表', width: 140 },
  { prop: 'target_id', label: '记录 ID', width: 100 },
  { prop: 'changed_keys', label: '变更字段', minWidth: 200 },
  { prop: 'ip', label: 'IP', width: 130 },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'module', label: '模块', type: 'select', options: MODULE_OPTIONS },
  { key: 'action', label: '动作', type: 'select', options: ACTION_OPTIONS },
  { key: 'user_id', label: '操作人 ID' },
  { key: 'target_table', label: '目标表', placeholder: '如 tk_shop' },
]);

/** 后端时间区间参数名为 start_date / end_date（作用于 op_time） */
const range = ref<[string, string] | null>(null);
const extraQuery = computed<Record<string, unknown>>(() => ({ start_date: range.value?.[0], end_date: range.value?.[1] }));

function reloadFirst() {
  rp.value?.reload(1);
}
function resetAll() {
  range.value = null;
  rp.value?.reload(1);
}

/** before_after 摘要进列，详情弹窗看全量 JSON */
function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const parsed = parsePair(row.before_after);
  const keys = new Set<string>([...Object.keys(parsed.before ?? {}), ...Object.keys(parsed.after ?? {})]);
  return { ...row, changed_keys: [...keys].filter(Boolean).join('、') || '—' };
}

interface Pair {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}
function parsePair(v: unknown): Pair {
  if (!v) return {};
  try {
    const o = JSON.parse(String(v)) as Pair;
    return { before: (o.before ?? null) as Record<string, unknown> | null, after: (o.after ?? null) as Record<string, unknown> | null };
  } catch {
    return { before: { raw: String(v) } };
  }
}

const detailVisible = ref(false);
const detail = ref<Record<string, unknown> | null>(null);
const beforeText = ref('');
const afterText = ref('');

function openDetail(row: Record<string, unknown>) {
  detail.value = row;
  const p = parsePair(row.before_after);
  beforeText.value = pretty(p.before);
  afterText.value = pretty(p.after);
  detailVisible.value = true;
}

function pretty(v: unknown) {
  if (v === null || v === undefined) return '（无）';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
const fmtDateTime = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 19) : '—');
</script>

<style scoped>
.inline-form {
  margin-bottom: 0;
}
.inline-form :deep(.el-form-item) {
  margin-bottom: 0;
}
.tip {
  color: #909399;
  font-size: 12px;
}
.diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.col {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  overflow: hidden;
}
.col-head {
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}
.col-head.before {
  background: #909399;
}
.col-head.after {
  background: #409eff;
}
.col pre {
  margin: 0;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  background: #fafafa;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
