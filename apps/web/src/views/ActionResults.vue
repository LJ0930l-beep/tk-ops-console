<template>
  <div class="page" v-loading="loading">
    <el-card class="page-card" shadow="never">
      <template #header>
        <b>预警处理效果回看</b>
        <span class="head-tip">观察期满后自动对比处理前后指标，判定改善 / 持平 / 恶化（§4.1）</span>
        <el-button style="float: right" size="small" @click="load">刷新</el-button>
      </template>
      <el-table :data="list" size="small" border stripe empty-text="暂无已评估的处理动作">
        <el-table-column prop="target_name" label="对象" min-width="130" show-overflow-tooltip />
        <el-table-column prop="rule_name" label="规则" min-width="120" show-overflow-tooltip />
        <el-table-column label="优先级" width="80" align="center">
          <template #default="{ row }"><el-tag size="small" :type="prioType(row.priority)" effect="dark">{{ 'P' + row.priority }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="action_at" label="处理时间" width="160" />
        <el-table-column prop="expected_result" label="预期结果" min-width="140" show-overflow-tooltip />
        <el-table-column prop="observe_until" label="观察至" width="110" />
        <el-table-column label="结论" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" :type="resultType(row.result)">{{ resultLabel(row.result) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="改善幅度" width="100" align="right">
          <template #default="{ row }">
            <span :class="rateClass(row)">{{ row.improvement_rate == null ? '—' : (num(row.improvement_rate) * 100).toFixed(1) + '%' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="evaluated_at" label="评估时间" width="160" />
        <el-table-column label="前后对比" min-width="180">
          <template #default="{ row }">
            <span class="muted">{{ brief(row.before_json) }} → {{ brief(row.after_json) }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="(p: number) => { page = p; load(); }"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { num } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';

interface Row {
  id: number;
  target_name: string | null;
  rule_name: string | null;
  priority: number;
  action_at: string;
  expected_result: string | null;
  observe_until: string | null;
  result: string;
  improvement_rate: number | null;
  evaluated_at: string;
  before_json: string;
  after_json: string;
}

const loading = ref(false);
const list = ref<Row[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;

const prioType = (p: number) => (p === 0 ? 'danger' : p === 1 ? 'warning' : 'info') as 'danger' | 'warning' | 'info';
const resultType = (r: string) => (r === 'improved' ? 'success' : r === 'worse' ? 'danger' : r === 'unchanged' ? 'info' : 'warning') as 'success' | 'danger' | 'info' | 'warning';
const resultLabel = (r: string) => ({ improved: '改善', unchanged: '持平', worse: '恶化', pending: '观察中' }[r] ?? r);
const rateClass = (row: Row) => (row.result === 'improved' ? 'up' : row.result === 'worse' ? 'down' : 'muted');

function brief(json: string | null): string {
  try {
    const o = JSON.parse(json || '{}') as Record<string, unknown>;
    const k = Object.keys(o).filter((x) => x !== 'metric');
    const metric = o.metric ? String(o.metric) : '';
    const val = k.map((x) => `${x}=${typeof o[x] === 'number' ? num(o[x]).toFixed(2) : String(o[x])}`).join(',');
    return metric ? `${metric}:${val || '—'}` : val || '—';
  } catch {
    return '—';
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const d = await apiGet<{ list: Row[]; total: number }>('/actions/results', { page: page.value, pageSize });
    list.value = d.list ?? [];
    total.value = d.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.head-tip { color: #909399; font-size: 12px; margin-left: 10px; font-weight: 400; }
.muted { color: #909399; font-size: 12px; }
.up { color: #67c23a; font-weight: 600; }
.down { color: #f56c6c; font-weight: 600; }
.pager { margin-top: 12px; justify-content: flex-end; }
</style>
