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
      <el-button type="primary" :loading="fetching" @click="fetchPublic(reload)">拉取公开日汇率</el-button>
      <el-button :loading="filling" @click="fillMissing(reload)">补最近 7 天缺失</el-button>
      <ImportDialog table="exchange_rate" button-text="导入汇率" @done="() => reload()" />
    </template>
    <template #toolbar-extra>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="公开汇率来自 Frankfurter v2（日频数据，非实时成交价）；手工值不会被自动刷新覆盖，补缺值与演示数据会单独标记。折算方向为「1 单位外币 = N 人民币」，CNY 恒为 1。"
        style="width: 640px"
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

/** exchange_rate.source：公开 API、手工、延用前值、演示数据分别展示 */
const SOURCE: OptionDef[] = [
  { value: 1, label: 'Frankfurter 公开 API', type: 'success' },
  { value: 2, label: '手工', type: 'warning' },
  { value: 3, label: '延用前值', type: 'info' },
  { value: 4, label: '演示数据', type: 'danger' },
];

const filling = ref(false);
const fetching = ref(false);

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
];

/** 保留与数据库一致的六位精度，尤其避免 VND/IDR 等小额币种显示失真。 */
function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const v = Number(row.rate_to_cny ?? NaN);
  return { ...row, rate_text: Number.isFinite(v) ? v.toFixed(6) : '-' };
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

async function fetchPublic(reload: () => void): Promise<void> {
  fetching.value = true;
  try {
    const r = await apiPost<{ rows?: { skipped?: string }[]; date?: string }>('/finance/rate/fetch', {});
    const rows = r?.rows ?? [];
    const skipped = rows.filter((row) => row.skipped === 'manual').length;
    ElMessage.success(`已拉取 ${r?.date ?? '最新'} 公开牌价：${rows.length - skipped} 个币种更新，${skipped} 个手工值保留`);
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    fetching.value = false;
  }
}
</script>
