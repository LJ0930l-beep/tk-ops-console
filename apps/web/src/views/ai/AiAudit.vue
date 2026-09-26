<template>
  <div class="page">
    <PageHeader title="AI 调用审计" sub="每一次出网与每一次由 AI 发起的写入都留痕：谁问的、用了哪家模型、多少 token、估算花了多少钱、改动了哪张表的哪一行">
      <template #tag>
        <el-tag size="small" :type="usage.scope === '本人' ? 'info' : 'success'">统计范围：{{ usage.scope ?? '—' }}</el-tag>
      </template>
    </PageHeader>

    <div class="stat-grid tk-in">
      <StatCard label="调用次数" :value="num(usage.calls)" :sub="`失败 ${Math.max(0, num(usage.calls) - num(usage.ok))} 次`" :tone="num(usage.calls) > num(usage.ok) ? 'warning' : 'primary'" />
      <StatCard label="成功次数" :value="num(usage.ok)" sub="只有成功的调用才可能产生写入" tone="success" />
      <StatCard label="累计 token" :value="num(usage.tokens)" sub="输入 + 输出，按服务商回传值统计" tone="info" />
      <StatCard label="估算花费" :value="num(usage.cost_cny)" sub="按服务商里填的单价估，不是账单；单价没填就是 0" tone="warning" :precision="4" />
    </div>

    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane label="出网调用" name="calls">
          <ResourcePage
            api="/ai/calls"
            title="调用记录"
            :columns="callColumns"
            :search-fields="callSearch"
            :createable="false"
            :editable="false"
            :deletable="false"
            :can-write="false"
            :default-page-size="20"
          />
        </el-tab-pane>
        <el-tab-pane label="AI 写入动作" name="actions">
          <ResourcePage
            api="/ai/actions"
            title="AI 写入"
            :columns="actionColumns"
            :search-fields="actionSearch"
            :createable="false"
            :editable="false"
            :deletable="false"
            :can-write="false"
            :default-page-size="20"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * AI 审计页。存在的意义是"AI 说它做了，得能查到它真做了"：
 * 写入那一列点进 op_log 能看到同一条业务写入的人工视角记录，created_by 是发起对话的人。
 */
import { computed, onMounted, ref } from 'vue';
import { num } from '@tk/shared';
import { apiGet } from '@/api/client';
import ResourcePage, { type ColumnDef, type SearchDef } from '@/components/ResourcePage.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';

const tab = ref<'calls' | 'actions'>('calls');
const usage = ref<{ calls?: number; ok?: number; tokens?: number; cost_cny?: number; scope?: string }>({});

const STATUS = [
  { value: 1, label: '成功', type: 'success' as const },
  { value: 2, label: '失败', type: 'danger' as const },
];
const ACTION_STATUS = [
  { value: 1, label: '已执行', type: 'success' as const },
  { value: 2, label: '被拒', type: 'warning' as const },
  { value: 3, label: '执行失败', type: 'danger' as const },
];

const callColumns = computed<ColumnDef[]>(() => [
  { prop: 'created_at', label: '时间', type: 'datetime', width: 150 },
  { prop: 'user_name', label: '发起人', width: 110 },
  { prop: 'provider_name', label: '服务商', width: 130 },
  { prop: 'model', label: '模型', width: 160 },
  { prop: 'status', label: '结果', width: 90, type: 'tag', options: STATUS },
  { prop: 'prompt_tokens', label: '输入 token', width: 110, align: 'right' },
  { prop: 'completion_tokens', label: '输出 token', width: 110, align: 'right' },
  { prop: 'latency_ms', label: '耗时(ms)', width: 100, align: 'right' },
  { prop: 'cost_cny', label: '估算花费(¥)', width: 120, align: 'right' },
  { prop: 'tool_count', label: '工具调用数', width: 110, align: 'right' },
  { prop: 'conversation_id', label: '会话', width: 90, align: 'right' },
  { prop: 'error_msg', label: '失败原因', minWidth: 240 },
]);

const actionColumns = computed<ColumnDef[]>(() => [
  { prop: 'created_at', label: '时间', type: 'datetime', width: 150 },
  { prop: 'user_name', label: '落库操作人', width: 120 },
  { prop: 'tool_name', label: '工具', width: 180 },
  { prop: 'status', label: '结果', width: 100, type: 'tag', options: ACTION_STATUS },
  { prop: 'target_table', label: '写入表', width: 150 },
  { prop: 'target_id', label: '记录 ID', width: 100, align: 'right' },
  { prop: 'conversation_id', label: '会话', width: 90, align: 'right' },
  { prop: 'arguments', label: '模型给的参数', minWidth: 260 },
  { prop: 'error_msg', label: '失败/被拒原因', minWidth: 220 },
]);

const callSearch = computed<SearchDef[]>(() => [
  { key: 'status', label: '结果', type: 'select', options: STATUS },
  { key: 'provider_id', label: '服务商 ID', placeholder: '精确' },
  { key: 'start_date', label: '起始日', type: 'date' },
  { key: 'end_date', label: '截止日', type: 'date' },
]);

const actionSearch = computed<SearchDef[]>(() => [
  { key: 'status', label: '结果', type: 'select', options: ACTION_STATUS },
  { key: 'tool_name', label: '工具', placeholder: '如 record_alert_action' },
]);

onMounted(async () => {
  try {
    usage.value = await apiGet<typeof usage.value>('/ai/calls/usage');
  } catch {
    usage.value = {};
  }
});
</script>
