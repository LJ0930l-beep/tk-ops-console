<template>
  <div class="page">
    <ResourcePage
      ref="rp"
      api="/finance/settlement/reconcile"
      title="逐单对账"
      :columns="columns"
      :search-fields="searchFields"
      :createable="false"
      :editable="false"
      :deletable="false"
      :can-write="false"
      :default-page-size="20"
      :row-class-name="rowClass"
      :map-row="mapRow"
      @loaded="onLoaded"
    >
      <template #stats="{ query }">
        <div v-if="sum" class="stat-grid tk-in">
          <StatCard label="流水笔数" :value="num(sum.rows)" :sub="`${sum.statements} 份账单`" tone="primary" />
          <StatCard label="收入类合计" :value="num(sum.income_cny)" sub="订单收入等正向流水（折 CNY）" tone="success" money :precision="2" />
          <StatCard label="扣减类合计" :value="num(sum.deduction_cny)" sub="退款 + 佣金 + 平台费 + 运费等" tone="warning" :precision="2" />
          <StatCard label="应得净额" :value="num(sum.net_cny)" sub="收入 − 扣减；这是我们找品牌结算的基数之一" tone="primary" money :precision="2" />
          <StatCard label="已打款" :value="num(sum.paid_cny)" :sub="`${num(sum.paid_count)} 笔已到账`" tone="success" money :precision="2" />
          <StatCard label="待打款" :value="num(sum.pending_cny)" :sub="`处理中 ${num(sum.processing_count)} 笔 · 失败 ${num(sum.failed_count)} 笔`" :tone="num(sum.failed_cny) > 0 ? 'danger' : 'info'" money :precision="2" />
        </div>
        <div class="chart-grid">
          <ChartCard title="钱按科目拆开" tip="正数（绿）是平台记给我们的，负数（红）是扣掉的；这张图就是「带货实付 → 实际打款」之间发生的事" :span="7" :empty="!typeRows.length" empty-text="所选条件下没有流水">
            <div ref="typeEl" class="chart-host" />
          </ChartCard>
          <ChartCard title="各店到账进度" tip="已打款 / 待打款 / 失败 堆叠；灰红段越长，说明这家店的钱还压在平台" :span="5" :empty="!shopRows.length" empty-text="没有分店数据">
            <div ref="shopEl" class="chart-host" />
          </ChartCard>
        </div>
        <el-alert v-if="sumError" type="warning" :closable="false" show-icon class="page-tip" :title="`结算合计加载失败：${sumError}`" description="合计与图取的是 /finance/settlement/summary；下面的逐单表不受影响。" />
      </template>
      <template #toolbar-extra>
        <el-alert type="info" :closable="false" show-icon class="page-tip">
          <template #title>
            逐单核「带货实付 vs 平台实际打款」。差异必须能拆到具体科目（佣金 / 平台费 / 运费 / 补贴 / 退款 / 人工调整），
            拆完剩下的 <code>explain_residual_cny</code> 应当恒等于 0 —— 残差不为 0 就说明有口径没被解释，不是「差不多就行」。
            注意：这里对的是平台的钱，<b>我们的收入只有品牌返点，走品牌账单另行核对</b>，不要把打款差异读成我们的盈亏。
            灰底 = 样品单或已取消，本就不该有结算；红底 = 差异超过 5%。
          </template>
        </el-alert>
      </template>
      <template #toolbar="{ query }">
        <ExportButton url="/finance/settlement/reconcile/export" name="settlement-reconcile" :params="query" />
      </template>
      <template #actions="{ row }">
        <el-button link type="primary" size="small" @click="openOrder(row)">结算流水</el-button>
      </template>
    </ResourcePage>

    <el-drawer v-model="drawer" size="52%" :title="`结算流水：${currentNo}`">
      <el-alert v-if="txnError" type="error" :closable="false" show-icon class="page-tip" :title="`结算流水加载失败：${txnError}`" description="对账结论仍来自同一份流水汇总，但这里看不到逐笔科目，先修接口再判断差异。" />
      <el-table v-loading="txnLoading" :data="txns" border size="small">
        <el-table-column prop="txn_type" label="类型" width="110" />
        <el-table-column prop="amount" label="原币金额" width="120" align="right" />
        <el-table-column prop="amount_cny" label="折 CNY" width="120" align="right" />
        <el-table-column prop="currency" label="币种" width="80" />
        <el-table-column prop="payment_status" label="打款状态" width="110" />
        <el-table-column prop="statement_id" label="账单号" min-width="150" />
        <el-table-column prop="statement_time" label="时间" width="160" />
        <template #empty>
          <el-empty
            v-if="!txnLoading"
            :description="txnError ? '流水没拉到（见上方错误），不是这单没有流水' : '该单暂无结算流水（未出账或未到结算周期）'"
            :image-size="60"
          />
        </template>
      </el-table>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
/**
 * 结算逐单对账（PRD §3.8 二期 DoD：「逐单对账可定位差异来源——退款未入账 / 佣金差异 / 汇率差异」）。
 *
 * 后端 /finance/settlement/reconcile 早就有了（含逐单差异拆解与残差校验），
 * 但一直没有页面承载 —— 于是它的导出也等于白写：这一页把接口和导出同时接上。
 * 整页只读，钱与状态都由结算流水决定，人工不可改。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { MASK, num, round2 } from '@tk/shared';
import { apiGet, errMsg, type Paged } from '@/api/client';
import ResourcePage, { type ColumnDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ChartCard from '@/components/ChartCard.vue';
import ExportButton from '@/components/ExportButton.vue';
import StatCard from '@/components/StatCard.vue';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';

const router = useRouter();
const rp = ref();

const money = (v: unknown) => (v === MASK ? MASK : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const ONLY_OPTIONS: OptionDef[] = [
  { value: 'diff', label: '只看有差异' },
  { value: 'settled', label: '只看已结算' },
  { value: 'unsettled', label: '只看未结算' },
];

const columns = computed<ColumnDef[]>(() => [
  { prop: 'tk_order_id', label: '平台单号', width: 180, fixed: 'left' },
  { prop: 'shop_name', label: '店铺', width: 150 },
  { prop: 'stat_date', label: '站点统计日', width: 110 },
  { prop: 'order_status', label: '订单状态', width: 130 },
  { prop: 'excluded_reason', label: '剔除原因', width: 120 },
  { prop: 'settled_flag', label: '结算', width: 90, type: 'tag' },
  { prop: 'est_total_paid_cny', label: '带货实付(CNY)', width: 130, type: 'money' },
  { prop: 'settled_paid_cny', label: '实际打款(CNY)', width: 130, type: 'money' },
  { prop: 'diff_cny', label: '差异(CNY)', width: 120, type: 'money', sortable: true },
  { prop: 'diff_rate_pct', label: '差异率', width: 100, type: 'percent' },
  { prop: 'commission_diff_cny', label: '佣金差', width: 110, type: 'money' },
  { prop: 'platform_fee_cny', label: '平台费', width: 110, type: 'money' },
  { prop: 'shipping_fee_cny', label: '运费', width: 110, type: 'money' },
  { prop: 'subsidy_cny', label: '补贴', width: 110, type: 'money' },
  { prop: 'settle_refund_cny', label: '退款扣减', width: 110, type: 'money' },
  { prop: 'adjust_cny', label: '人工调整', width: 110, type: 'money' },
  { prop: 'explain_residual_cny', label: '未解释残差', width: 120, type: 'money', sortable: true },
  { prop: 'est_profit_cny', label: '预估贡献毛利(CNY)', width: 150, type: 'money' },
  { prop: 'settled_profit_cny', label: '结算口径贡献毛利', width: 150, type: 'money' },
  { prop: 'unmapped_items', label: '未配返点行·不计利润', width: 150, align: 'right' },
  { prop: 'rate_flag', label: '汇率', width: 90, type: 'tag' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'tk_order_id', label: '平台单号', placeholder: '精确单号' },
  { key: 'only', label: '只看', type: 'select', options: ONLY_OPTIONS },
  { key: 'stat_date', label: '统计日', type: 'daterange', fromKey: 'from', toKey: 'to' },
]);

/** 只读页：把后端布尔/枚举翻成表格能直接显示的形态 */
function mapRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    ...r,
    settled_flag: r.has_settlement ? '已结算' : '未结算',
    rate_flag: r.rate_missing ? '兜底价' : '牌价',
    // diff_rate 后端是小数（0.05 = 5%），percent 列按「已是百分数」渲染，所以另加展示键、不动原字段
    diff_rate_pct: r.diff_rate === MASK ? MASK : round2(num(r.diff_rate) * 100),
  };
}

function rowClass(row: Record<string, unknown>): string {
  if (String(row.excluded_reason ?? '')) return 'row-muted';
  return Math.abs(num(row.diff_rate)) > 0.05 ? 'row-danger' : '';
}

/* ---------- 合计与两张图（跟着同一套筛选条件走） ---------- */
interface TxnTypeRow {
  txn_type: number;
  txn_name: string;
  count: number;
  amount_cny: number;
}
interface ShopRow {
  shop_id: number;
  shop_name: string | null;
  rows: number;
  net_cny: number;
  paid_cny: number;
  pending_cny: number;
  failed_cny: number;
}
interface SettleSummary {
  rows: number;
  income_cny: number;
  deduction_cny: number;
  net_cny: number;
  paid_cny: number;
  pending_cny: number;
  statements: number;
  paid_count: number;
  processing_count: number;
  failed_count: number;
  failed_cny: number;
  by_txn_type: TxnTypeRow[];
  by_shop: ShopRow[];
}

const sum = ref<SettleSummary | null>(null);
const sumError = ref('');
const typeEl = ref<HTMLDivElement>();
const shopEl = ref<HTMLDivElement>();

const typeRows = computed(() => sum.value?.by_txn_type ?? []);
const shopRows = computed(() => [...(sum.value?.by_shop ?? [])].sort((a, b) => num(b.net_cny) - num(a.net_cny)).slice(0, 8));

/** ResourcePage 每次拉到数据后把真正发出去的筛选条件回吐到这里，合计与图就永远和下面那张表同口径 */
async function onLoaded(p: { params: Record<string, unknown> }): Promise<void> {
  const { page: _p, pageSize: _ps, sortBy: _s, sortOrder: _o, ...filter } = p.params;
  try {
    sum.value = await apiGet<SettleSummary>('/finance/settlement/summary', filter);
    sumError.value = '';
  } catch (e) {
    sum.value = null;
    sumError.value = errMsg(e);
  }
}

function typeOption(): ChartOption | null {
  const list = typeRows.value;
  if (!list.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: { name: string; value: number }[]) => `${p[0]?.name ?? ''}<br/>${money(Number(p[0]?.value ?? 0))}` },
    grid: { left: 92, right: 70, top: 10, bottom: 22 },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    yAxis: { type: 'category', data: list.map((r) => r.txn_name).reverse(), axisLabel: { fontSize: 11 } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        data: list
          .map((r) => ({ value: round2(num(r.amount_cny)), itemStyle: { color: num(r.amount_cny) < 0 ? chartColor.danger() : chartColor.success(), borderRadius: [0, 3, 3, 0] } }))
          .reverse(),
        label: { show: true, position: 'right', fontSize: 10, formatter: (p: { value: number }) => `${round2(num(p.value) / 10000)}万` },
      },
    ],
  };
}

function shopOption(): ChartOption | null {
  const list = shopRows.value;
  if (!list.length) return null;
  const mk = (name: string, pick: (r: ShopRow) => number, color: string) => ({
    name,
    type: 'bar',
    stack: 's',
    barMaxWidth: 20,
    itemStyle: { color },
    data: list.map((r) => round2(num(pick(r)))),
  });
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 60, right: 16, top: 12, bottom: 40 },
    xAxis: { type: 'category', data: list.map((r) => r.shop_name ?? `#${r.shop_id}`), axisLabel: { fontSize: 10, interval: 0, rotate: 20, width: 76, overflow: 'truncate' } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    series: [
      mk('已打款', (r) => num(r.paid_cny), chartColor.success()),
      mk('待打款', (r) => num(r.pending_cny), chartColor.warning()),
      mk('失败', (r) => num(r.failed_cny), chartColor.danger()),
    ],
  };
}

useChart(typeEl, typeOption, [sum]);
useChart(shopEl, shopOption, [sum]);

/* ---------- 下钻：某单的全部结算流水 ---------- */
const drawer = ref(false);
const currentNo = ref('');
const txnLoading = ref(false);
const txnError = ref('');
const txns = ref<Record<string, unknown>[]>([]);

async function openOrder(row: Record<string, unknown>): Promise<void> {
  currentNo.value = String(row.tk_order_id ?? '');
  drawer.value = true;
  txnLoading.value = true;
  txnError.value = '';
  try {
    const data = await apiGet<{ list: Record<string, unknown>[] }>(`/finance/settlement/by-order/${encodeURIComponent(currentNo.value)}`);
    txns.value = data?.list ?? [];
  } catch (e) {
    // 流水拉不到不影响对账结论（本页数据来自同一份结算流水汇总），但空抽屉会被读成「这单没流水」：
    // 失败必须在抽屉里点名，同时 toast 一次服务端原文
    txns.value = [];
    txnError.value = errMsg(e);
    ElMessage.error(errMsg(e));
  } finally {
    txnLoading.value = false;
  }
}

void router;
</script>

<style scoped>
.page-tip {
  margin-bottom: 8px;
}
</style>
