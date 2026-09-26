<template>
  <div class="page" @click="onDomClick">
    <el-alert
      class="page-tip"
      type="info"
      show-icon
      :closable="false"
      title="订单金额与状态由同步作业写入，页面不可改（仅样品单标记可人工纠正并写日志）。灰底 = 样品单不计 GMV，黄底 = 含没配到品牌返点率的明细，这些行整体不计利润。"
    />
    <ResourcePage
      ref="rp"
      api="/orders"
      title="订单"
      :columns="columns"
      :search-fields="searchFields"
      :createable="false"
      :editable="false"
      :deletable="false"
      :can-write="false"
      :row-class-name="rowClass"
      :map-row="mapRow"
      :default-page-size="20"
      :action-width="80"
    >
      <template #toolbar="{ query }">
        <ExportButton url="/orders/export" name="orders" :params="query" />
      </template>
      <template #actions="{ row }">
        <el-button link type="primary" size="small" @click="goDetail(row)">详情</el-button>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ORDER_STATUS_LABEL } from '@tk/shared';
import ResourcePage from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';
import type { ColumnDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useDictStore } from '@/stores/dict';

const router = useRouter();
const dict = useDictStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);

/* ---- 订单状态（平台原文 → 中文，见 PRD §3.4） ---- */
const STATUS_TYPE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  UNPAID: 'warning',
  ON_HOLD: 'warning',
  ON_HOLD_SUBSTATUS_ESCALATION: 'danger',
  TO_BE_SHIPPED: 'primary',
  INVOICE_CREATED: 'primary',
  TRANSIT_TO_SHIP: 'primary',
  SHIPPED: 'primary',
  DELIVERED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'info',
};
const STATUSES = Object.keys(ORDER_STATUS_LABEL);
const statusOptions: OptionDef[] = STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABEL[s] ?? s, type: STATUS_TYPE[s] ?? 'info' }));
const statusFilterOptions: OptionDef[] = STATUSES.map((s) => ({ value: s, label: `${ORDER_STATUS_LABEL[s] ?? s}（${s}）` }));

const FULFILLMENT: OptionDef[] = [
  { value: 1, label: '平台仓', type: 'success' },
  { value: 2, label: '自发货', type: 'warning' },
  { value: 3, label: '海外仓', type: 'primary' },
];
const YES_NO: OptionDef[] = [
  { value: 1, label: '是' },
  { value: 0, label: '否' },
];

const shopOptions = computed<OptionDef[]>(() => dict.shops.map((s) => ({ value: s.id, label: s.shop_name })));
const regionOptions = computed<OptionDef[]>(() => (dict.cache.region ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));

const searchFields = computed<SearchDef[]>(() => [
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOptions.value },
  { key: 'order_status', label: '订单状态', type: 'select', options: statusFilterOptions },
  { key: 'order_time', label: '下单时间', type: 'daterange' },
  { key: 'paid_time', label: '支付时间', type: 'daterange' },
  { key: 'tk_order_id', label: '订单号', type: 'text', placeholder: 'tk_order_id 模糊' },
  { key: 'tk_sku', label: 'SKU', type: 'text', placeholder: 'tk_sku_id / seller_sku 模糊' },
  { key: 'region', label: '站点', type: 'select', dictType: 'region', options: regionOptions.value },
  { key: 'fulfillment_type', label: '履约方式', type: 'select', options: FULFILLMENT },
  { key: 'is_sample_order', label: '样品单', type: 'select', options: YES_NO },
  { key: 'only_unmapped', label: '仅含不计利润的行', type: 'select', options: [{ value: 1, label: '是（有未配返点率的明细）' }] },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'shop_name', label: '店铺', width: 130 },
  { prop: 'tk_order_id', label: '订单号', width: 180, link: (row) => `/orders/${String(row.id ?? '')}` },
  { prop: 'order_status', label: '状态', width: 100, type: 'tag', options: statusOptions },
  { prop: 'order_time', label: '下单时间', type: 'datetime', width: 145 },
  { prop: 'paid_time', label: '支付时间', type: 'datetime', width: 145 },
  { prop: 'total_paid', label: '买家实付(店铺币种)', type: 'money', width: 140 },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'total_paid_cny', label: '实付折 CNY·带货口径', type: 'money', width: 150 },
  { prop: 'subtotal', label: '商品小计', type: 'money', width: 105 },
  { prop: 'shipping_fee', label: '运费', type: 'money', width: 90 },
  { prop: 'item_count', label: '明细行数', width: 85 },
  { prop: 'fulfillment_type', label: '履约', width: 90, type: 'tag', options: FULFILLMENT },
  { prop: 'tracking_no', label: '运单号', width: 160 },
  { prop: 'sample_flag', label: '样品单', width: 110 },
  { prop: 'attribution', label: '带货归因', minWidth: 170 },
  { prop: 'est_profit', label: '预估贡献毛利(CNY)', type: 'money', width: 145 },
  { prop: 'synced_at', label: '同步时间', type: 'datetime', width: 145 },
]);

/* ---------- 派生展示字段（后端原值保留，只做兜底拼装） ---------- */
function flagOf(v: unknown): string {
  if (v === undefined || v === null || v === '') return '-';
  return Number(v) === 1 ? '样品单·不计GMV' : '正常单';
}

function attributionOf(row: Record<string, unknown>): string {
  const direct = row.attribution ?? row.attribution_summary;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const parts: string[] = [];
  const handles = typeof row.creator_handles === 'string' ? row.creator_handles.split(',').filter(Boolean) : [];
  if (handles.length) parts.push(handles.slice(0, 2).join('、') + (handles.length > 2 ? ` 等 ${handles.length} 位` : ''));
  else if (Number(row.creator_count ?? 0) > 0) parts.push(`${Number(row.creator_count)} 位达人`);
  const attributed = Number(row.attributed_items ?? row.attributed_count ?? 0);
  if (attributed > 0) parts.push(`${attributed} 行已归因`);
  const contentTypes = row.content_types;
  if (typeof contentTypes === 'string' && contentTypes.trim()) parts.push(contentTypes);
  return parts.length ? parts.join(' · ') : '未归因·自然流量';
}

function unmappedCountOf(row: Record<string, unknown>): number {
  return Number(row.unmapped_items ?? row.has_unmapped ?? row.unmapped_count ?? 0) || 0;
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    sample_flag: flagOf(row.is_sample_order),
    attribution: attributionOf(row),
    unmapped_n: unmappedCountOf(row),
  };
}

/** 样品单灰底；含未配返点率明细黄底（那些行整体排除在利润之外，PRD §3.4 告警态） */
function rowClass({ row }: { row: Record<string, unknown> }): string {
  if (Number(row.is_sample_order) === 1) return 'sample-row';
  if (Number(row.unmapped_n ?? 0) > 0) return 'warning-row';
  return '';
}

/* ---------- 行点击 → 详情（ResourcePage 未暴露 row-click，用事件委托，忽略交互控件） ---------- */
function goDetail(row: Record<string, unknown>) {
  const id = row.id;
  if (id === undefined || id === null) return;
  router.push(`/orders/${String(id)}`);
}

function onDomClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null;
  if (!el || el.closest('button, a, input, textarea, .el-select, .el-tag, .el-checkbox, .el-pagination')) return;
  const tr = el.closest('tr.el-table__row');
  const tbody = tr?.parentElement;
  if (!tr || !tbody) return;
  const idx = Array.prototype.indexOf.call(tbody.children, tr) as number;
  const row = (rp.value?.rows ?? [])[idx];
  if (row) goDetail(row);
}

onMounted(async () => {
  await Promise.all([dict.shopOptions().catch(() => undefined), dict.dict('region').catch(() => undefined)]);
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
:deep(.sample-row) {
  color: #909399;
}
:deep(.sample-row td.el-table__cell) {
  background: #f5f5f5 !important;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
