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
      @loaded="onLoaded"
    >
      <!-- 合计与两张图：数据来自 /orders/summary，和下面这张表同一套筛选条件 -->
      <template #stats>
        <div v-if="sum" class="stat-grid tk-in">
          <StatCard label="订单数" :value="num(sum.totals.orders)" :sub="`取消 ${num(sum.totals.cancelled_orders)} · 样品单 ${num(sum.totals.sample_orders)}（都不计 GMV）`" tone="primary" />
          <StatCard label="净带货 GMV" :value="num(sum.totals.net_gmv_cny)" :sub="`退款率 ${num(sum.totals.refund_rate).toFixed(2)}%｜GMV 是品牌的生意`" tone="info" money :precision="2" />
          <StatCard label="应收返点（我们的收入）" :value="num(sum.totals.rebate_cny)" :sub="`占净 GMV ${share(sum.totals.rebate_cny, sum.totals.net_gmv_cny)}`" tone="success" money :precision="2" />
          <StatCard label="预估贡献毛利" :value="num(sum.totals.est_profit_cny)" :sub="`返点 − 物流 ${money2(sum.totals.logistics_cny)} − 佣金 ${money2(sum.totals.commission_cny)}`" :tone="num(sum.totals.est_profit_cny) < 0 ? 'danger' : 'success'" money :precision="2" />
          <StatCard label="不计利润的明细行" :value="num(sum.totals.unmapped_items)" sub="没配到品牌返点率 → 整行排除在收入与利润之外" :tone="num(sum.totals.unmapped_items) > 0 ? 'danger' : 'info'" />
        </div>
        <div class="chart-grid">
          <ChartCard title="逐日：订单数 / 应收返点 / 贡献毛利" :tip="dayTip" :span="7" :empty="!dayRows.length" empty-text="所选条件下没有订单">
            <div ref="dayEl" class="chart-host" />
          </ChartCard>
          <ChartCard title="分店：品牌的生意 vs 我们的钱" tip="三根柱子分别是净带货 GMV、我们应得的返点、扣完物流与佣金后的贡献毛利 —— 差距就是代运营的真实留存" :span="5" :empty="!shopRows.length" empty-text="没有分店数据">
            <div ref="shopEl" class="chart-host" />
          </ChartCard>
        </div>
        <el-alert v-if="sumError" type="warning" :closable="false" show-icon class="page-tip" :title="`订单合计加载失败：${sumError}`" description="合计与图取 /orders/summary；下面的分页表不受影响。" />
      </template>
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
import { ORDER_STATUS_LABEL, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import ChartCard from '@/components/ChartCard.vue';
import ExportButton from '@/components/ExportButton.vue';
import StatCard from '@/components/StatCard.vue';
import type { ColumnDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useDictStore } from '@/stores/dict';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';

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

/* ---------- 合计与图表（/orders/summary 与列表同一套 orderQ 筛选） ---------- */
interface Agg {
  orders: number;
  cancelled_orders: number;
  sample_orders: number;
  unmapped_items: number;
  gmv_cny: number;
  refund_cny: number;
  net_gmv_cny: number;
  rebate_cny: number;
  logistics_cny: number;
  commission_cny: number;
  est_profit_cny: number;
  refund_rate: number;
}
interface OrderSummary {
  totals: Agg;
  by_shop: (Agg & { shop_id: number; shop_name: string; region: string; currency: string })[];
  by_day: (Agg & { stat_date: string })[];
  note?: string;
}

const sum = ref<OrderSummary | null>(null);
const sumError = ref('');
const dayEl = ref<HTMLDivElement>();
const shopEl = ref<HTMLDivElement>();
const dayRows = computed(() => sum.value?.by_day ?? []);
const shopRows = computed(() => [...(sum.value?.by_shop ?? [])].sort((a, b) => num(b.net_gmv_cny) - num(a.net_gmv_cny)).slice(0, 8));

const money2 = (v: unknown) => round2(num(v)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const share = (v: unknown, base: unknown) => (num(base) > 0 ? `${((num(v) / num(base)) * 100).toFixed(1)}%` : '—');

const dayTip = '按站点时区自然日；GMV 含未配返点率的行（品牌的生意），返点与贡献毛利只算已配返点率的行 —— 与下方表格同一口径';

async function onLoaded(p: { params: Record<string, unknown> }): Promise<void> {
  const { page: _p, pageSize: _ps, sortBy: _s, sortOrder: _o, ...filter } = p.params;
  try {
    sum.value = await apiGet<OrderSummary>('/orders/summary', filter);
    sumError.value = '';
  } catch (e) {
    sum.value = null;
    sumError.value = errMsg(e);
  }
}

function dayOption(): ChartOption | null {
  const list = dayRows.value;
  if (!list.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis' },
    legend: { top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 62, right: 46, top: 34, bottom: 26 },
    xAxis: { type: 'category', data: list.map((r) => String(r.stat_date ?? '').slice(5)) },
    yAxis: [
      { type: 'value', name: '金额(CNY)', nameTextStyle: { fontSize: 11, color: chartColor.muted() }, axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
      { type: 'value', name: '订单', splitLine: { show: false } },
    ],
    series: [
      { name: '订单数', type: 'bar', yAxisIndex: 1, barMaxWidth: 16, itemStyle: { color: chartColor.success(), opacity: 0.55, borderRadius: [3, 3, 0, 0] }, data: list.map((r) => num(r.orders)) },
      { name: '应收返点', type: 'line', smooth: true, showSymbol: false, lineStyle: { color: chartColor.primary(), width: 2 }, itemStyle: { color: chartColor.primary() }, data: list.map((r) => round2(num(r.rebate_cny))) },
      { name: '贡献毛利', type: 'line', smooth: true, showSymbol: false, areaStyle: { opacity: 0.1 }, lineStyle: { color: chartColor.warning(), width: 2 }, itemStyle: { color: chartColor.warning() }, data: list.map((r) => round2(num(r.est_profit_cny))) },
    ],
  };
}

function shopOption(): ChartOption | null {
  const list = shopRows.value;
  if (!list.length) return null;
  const mk = (name: string, pick: (r: (typeof list)[number]) => number, color: string) => ({
    name,
    type: 'bar',
    barMaxWidth: 14,
    itemStyle: { color, borderRadius: [0, 3, 3, 0] },
    data: list.map((r) => round2(num(pick(r)))),
  });
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 96, right: 26, top: 12, bottom: 38 },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    yAxis: { type: 'category', data: list.map((r) => r.shop_name).reverse(), axisLabel: { width: 88, overflow: 'truncate', fontSize: 11 } },
    series: [
      mk('净带货 GMV', (r) => r.net_gmv_cny, '#c8dcf5'),
      mk('应收返点', (r) => r.rebate_cny, chartColor.primary()),
      mk('贡献毛利', (r) => r.est_profit_cny, chartColor.success()),
    ].map((s) => ({ ...s, data: [...s.data].reverse() })),
  };
}

useChart(dayEl, dayOption, [sum]);
useChart(shopEl, shopOption, [sum]);

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
