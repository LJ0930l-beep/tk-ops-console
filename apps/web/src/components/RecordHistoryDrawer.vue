<template>
  <el-drawer v-model="show" :title="`变更历史 · ${title}`" size="760px" @open="load">
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
      <template #default>
        历史取自操作日志（只读，任何人都不能改）。这里显示的是 diff 后的字段：值没变的字段不列，
        凭证类字段（App Key / App Secret / Access Token / 密码 / 密文）只标注「改过」，不回显内容。
      </template>
    </el-alert>

    <div v-if="recordName" class="target">
      {{ recordName }}
      <span class="dim">（{{ table }} # {{ recordId }}）</span>
    </div>

    <el-table v-loading="loading" :data="flatRows" border size="small" :span-method="spanMethod" style="width: 100%">
      <el-table-column label="时间" width="150">
        <template #default="{ row }">
          <div>{{ formatUtcTimestamp(row.entry.created_at) || '—' }}</div>
          <div class="dim">{{ row.entry.module }} · {{ row.entry.ip || '无 IP' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="操作人" width="100">
        <template #default="{ row }">{{ row.entry.user_name || '（账号已删）' }}</template>
      </el-table-column>
      <el-table-column label="动作" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="ACTION_OPTIONS[row.entry.action]?.type ?? 'info'">{{ ACTION_OPTIONS[row.entry.action]?.label ?? row.entry.action }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="字段" width="150" prop="field" show-overflow-tooltip />
      <el-table-column label="从 → 到" min-width="280">
        <template #default="{ row }">
          <span class="from">{{ row.from || '（空）' }}</span>
          <span class="arrow">→</span>
          <span class="to">{{ row.to || '（空）' }}</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="这条记录还没有变更历史" :image-size="72" />
      </template>
    </el-table>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiGet, errMsg } from '@/api/client';
import { formatUtcTimestamp } from '@/utils/date';

interface FieldChange {
  field: string;
  from: string;
  to: string;
}
interface HistoryEntry {
  id: number;
  action: string;
  module: string;
  user_name: string | null;
  created_at: string;
  ip: string | null;
  changes: FieldChange[];
}
/** 一条日志 × 一个变化字段 = 一行；同一条日志的前三列靠 rowspan 合并，读起来才是「谁在什么时候改了这些」 */
interface FlatRow extends FieldChange {
  entry: HistoryEntry;
  rowspan: number;
}

const props = withDefaults(
  defineProps<{
    visible: boolean;
    table: string;
    recordId?: number | string;
    /** 业务名，用于抽屉标题（如「店铺」） */
    title?: string;
    /** 记录识别列，如店铺名 */
    recordName?: string;
  }>(),
  { recordId: '', title: '记录', recordName: '' },
);

const emit = defineEmits<{ 'update:visible': [boolean] }>();

const show = computed({ get: () => props.visible, set: (v: boolean) => emit('update:visible', v) });

const ACTION_OPTIONS: Record<string, { label: string; type: 'success' | 'primary' | 'danger' | 'warning' | 'info' }> = {
  create: { label: '新增', type: 'success' },
  update: { label: '修改', type: 'primary' },
  delete: { label: '删除', type: 'danger' },
  export: { label: '导出', type: 'warning' },
  login: { label: '登录', type: 'info' },
};

const loading = ref(false);
const entries = ref<HistoryEntry[]>([]);

const flatRows = computed<FlatRow[]>(() =>
  entries.value.flatMap((entry) => {
    const changes: FieldChange[] = entry.changes.length ? entry.changes : [{ field: '（无字段变化）', from: '—', to: '—' }];
    return changes.map((c, i) => ({ ...c, entry, rowspan: i === 0 ? changes.length : 0 }));
  }),
);

function spanMethod({ rowIndex, columnIndex }: { row: FlatRow; column: unknown; rowIndex: number; columnIndex: number }) {
  if (columnIndex > 2) return { rowspan: 1, colspan: 1 };
  const span = flatRows.value[rowIndex]?.rowspan ?? 0;
  return { rowspan: span, colspan: span ? 1 : 0 };
}

async function load() {
  if (!props.table || !props.recordId) return;
  loading.value = true;
  try {
    entries.value = await apiGet<HistoryEntry[]>('/system/oplog/history', { table: props.table, id: props.recordId });
  } catch (e) {
    entries.value = [];
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.target {
  margin-bottom: 8px;
  font-weight: 600;
}
.dim {
  color: #909399;
  font-size: 12px;
  font-weight: 400;
}
.from {
  color: #909399;
  word-break: break-all;
}
.arrow {
  margin: 0 6px;
  color: #c0c4cc;
}
.to {
  color: #303133;
  font-weight: 600;
  word-break: break-all;
}
</style>
