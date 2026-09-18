<template>
  <div class="page">
    <el-alert
      class="page-tip"
      type="warning"
      show-icon
      :closable="false"
      title="责任归属为「未归类」的售后会计入工作台待办；退款金额与平台状态由同步覆盖，客服只补填责任归属 / 是否回库 / 备注。"
    />
    <ResourcePage
      ref="rp"
      api="/orders/returns"
      title="售后单"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :createable="false"
      :editable="false"
      :deletable="false"
      :can-write="true"
      :row-class-name="rowClass"
      :map-row="mapRow"
      :action-width="90"
      dialog-width="520px"
    >
      <template #actions="{ row }">
        <el-button link type="primary" size="small" @click="openFill(row)">补填责任</el-button>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RESPONSIBILITY } from '@tk/shared';
import ResourcePage from '@/components/ResourcePage.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useDictStore } from '@/stores/dict';

const dict = useDictStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);

const RETURN_TYPE: OptionDef[] = [
  { value: 1, label: '仅退款', type: 'warning' },
  { value: 2, label: '退货退款', type: 'danger' },
];

/** RESPONSIBILITY 0~4（PRD §3.4），0 = 未归类需客服补填 */
const respOptions: OptionDef[] = [
  { value: RESPONSIBILITY.UNSET, label: '未归类', type: 'warning' },
  { value: RESPONSIBILITY.QUALITY, label: '质量问题', type: 'danger' },
  { value: RESPONSIBILITY.LOGISTICS, label: '物流问题', type: 'danger' },
  { value: RESPONSIBILITY.DESCRIPTION, label: '描述不符', type: 'warning' },
  { value: RESPONSIBILITY.BUYER, label: '买家原因', type: 'info' },
];

const RESTOCK: OptionDef[] = [
  { value: 1, label: '已回库', type: 'success' },
  { value: 0, label: '未回库', type: 'info' },
];

const shopOptions = computed<OptionDef[]>(() => dict.shops.map((s) => ({ value: s.id, label: s.shop_name })));
const reasonOptions = computed<OptionDef[]>(() => (dict.cache.return_reason ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));

const searchFields = computed<SearchDef[]>(() => [
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOptions.value },
  { key: 'responsibility', label: '责任归属', type: 'select', options: respOptions },
  { key: 'status', label: '平台状态', type: 'text', placeholder: '如 PROCESSING/COMPLETED' },
  { key: 'return_type', label: '售后类型', type: 'select', options: RETURN_TYPE },
  { key: 'apply_time', label: '申请时间', type: 'daterange' },
  { key: 'keyword', label: '关键字', type: 'text', placeholder: '售后单号/订单号/原因' },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'tk_return_id', label: '售后单号', width: 180 },
  {
    prop: 'tk_order_id',
    label: '订单号',
    width: 180,
    link: (row) => `/orders/${String(row.order_id ?? '')}`,
  },
  { prop: 'shop_name', label: '店铺', width: 130 },
  { prop: 'return_type', label: '类型', width: 100, type: 'tag', options: RETURN_TYPE },
  { prop: 'reason', label: '退款原因', minWidth: 160 },
  { prop: 'refund_amount', label: '退款金额', type: 'money', width: 110 },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'status', label: '平台状态', width: 130 },
  { prop: 'apply_time', label: '申请时间', type: 'datetime', width: 145 },
  { prop: 'finish_time', label: '完成时间', type: 'datetime', width: 145 },
  { prop: 'responsibility', label: '责任归属', width: 110, type: 'tag', options: respOptions },
  { prop: 'restock_text', label: '是否回库', width: 100 },
  { prop: 'remark', label: '备注', minWidth: 160 },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'responsibility', label: '责任归属', type: 'select', required: true, options: respOptions.filter((o) => o.value !== RESPONSIBILITY.UNSET), span: 24 },
  { key: 'is_restocked', label: '是否回库', type: 'switch', default: 0, span: 24 },
  { key: 'remark', label: '备注', type: 'textarea', span: 24, placeholder: '客服补填说明（金额与状态以平台同步为准）' },
]);

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const r = RESTOCK.find((o) => String(o.value) === String(row.is_restocked ?? 0));
  return { ...row, restock_text: row.is_restocked === undefined ? '-' : r?.label ?? '未回库' };
}

/** 未归类 = 告警底色，引导客服补填 */
function rowClass({ row }: { row: Record<string, unknown> }): string {
  return Number(row.responsibility ?? 0) === RESPONSIBILITY.UNSET ? 'warning-row' : '';
}

function openFill(row: Record<string, unknown>) {
  rp.value?.openEdit(row);
}

onMounted(() => {
  void dict.shopOptions().catch(() => undefined);
  void dict.dict('return_reason').catch(() => undefined);
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
</style>
