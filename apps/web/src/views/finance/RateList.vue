<template>
  <ResourcePage
    api="/finance/rate"
    title="汇率"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    :map-row="mapRow"
    dialog-width="560px"
  >
    <template #toolbar="{ reload }">
      <el-button :loading="filling" @click="fillMissing(reload)">补最近 7 天缺失</el-button>
      <ImportDialog table="exchange_rate" button-text="导入汇率" @done="() => reload()" />
    </template>
    <template #toolbar-extra>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="汇率按 (rate_date, currency) 唯一：同一天的同一币种只能有一条，重复提交按覆盖处理。折算方向一律为「1 单位外币 = N 人民币」，CNY 恒为 1。"
        style="width: 560px"
      />
    </template>
  </ResourcePage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ImportDialog from '@/components/ImportDialog.vue';
import { apiPost, errMsg } from '@/api/client';

/** 站点常用币种（exchange_rate.currency） */
const CURRENCY: OptionDef[] = ['USD', 'MYR', 'PHP', 'SGD', 'THB', 'VND', 'IDR', 'GBP', 'MXN', 'CNY'].map((c) => ({
  value: c,
  label: c,
}));

/** exchange_rate.source：1 自动 / 2 手工 */
const SOURCE: OptionDef[] = [
  { value: 1, label: '自动', type: 'success' },
  { value: 2, label: '手工', type: 'warning' },
];

const filling = ref(false);

const columns: ColumnDef[] = [
  { prop: 'rate_date', label: '汇率日期', width: 120, type: 'date', sortable: true },
  { prop: 'currency', label: '币种', width: 90 },
  { prop: 'rate_text', label: '兑人民币汇率', width: 130 },
  { prop: 'source', label: '来源', width: 90, type: 'tag', options: SOURCE },
  { prop: 'updated_at', label: '更新时间', width: 150, type: 'datetime' },
];

const searchFields: SearchDef[] = [
  { key: 'currency', label: '币种', type: 'select', options: CURRENCY },
  { key: 'rate_date', label: '汇率日期', type: 'daterange' },
  { key: 'source', label: '来源', type: 'select', options: SOURCE },
];

const formFields: FormFieldDef[] = [
  { key: 'rate_date', label: '汇率日期', type: 'date', required: true, disabledOnEdit: true },
  {
    key: 'currency',
    label: '币种',
    type: 'select',
    required: true,
    options: CURRENCY,
    disabledOnEdit: true,
    onChange: (f) => {
      if (String(f.currency ?? '') === 'CNY') f.rate_to_cny = 1;
    },
  },
  { key: 'rate_to_cny', label: '兑人民币汇率', type: 'number', required: true, precision: 6, min: 0, default: 1 },
  { key: 'source', label: '来源', type: 'select', required: true, options: SOURCE, default: 2 },
];

/** DECIMAL(18,6) 语义，前端按 4 位展示（PRD §3.8 汇率维护） */
function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const v = Number(row.rate_to_cny ?? NaN);
  return { ...row, rate_text: Number.isFinite(v) ? v.toFixed(4) : '-' };
}

async function fillMissing(reload: () => void): Promise<void> {
  filling.value = true;
  try {
    const r = await apiPost<{ filled?: number }>('/finance/rate/fill-missing');
    ElMessage.success(`已补齐 ${r?.filled ?? 0} 条缺失汇率`);
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    filling.value = false;
  }
}
</script>
