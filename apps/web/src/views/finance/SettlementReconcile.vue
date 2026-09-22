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
    >
      <template #toolbar-extra>
        <el-alert type="info" :closable="false" show-icon class="page-tip">
          <template #title>
            逐单核「预估收入 vs 平台实际打款」。差异必须能拆到具体科目（佣金 / 平台费 / 运费 / 补贴 / 退款 / 人工调整），
            拆完剩下的 <code>explain_residual_cny</code> 应当恒等于 0 —— 残差不为 0 就说明有口径没被解释，不是「差不多就行」。
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
      <el-table v-loading="txnLoading" :data="txns" border size="small">
        <el-table-column prop="txn_type" label="类型" width="110" />
        <el-table-column prop="amount" label="原币金额" width="120" align="right" />
        <el-table-column prop="amount_cny" label="折 CNY" width="120" align="right" />
        <el-table-column prop="currency" label="币种" width="80" />
        <el-table-column prop="payment_status" label="打款状态" width="110" />
        <el-table-column prop="statement_id" label="账单号" min-width="150" />
        <el-table-column prop="statement_time" label="时间" width="160" />
      </el-table>
      <el-empty v-if="!txnLoading && !txns.length" description="该单暂无结算流水（未出账或未到结算周期）" :image-size="60" />
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
import { num } from '@tk/shared';
import { apiGet, type Paged } from '@/api/client';
import ResourcePage, { type ColumnDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';

const router = useRouter();
const rp = ref();

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
  { prop: 'est_total_paid_cny', label: '预估实付(CNY)', width: 120, type: 'money' },
  { prop: 'settled_paid_cny', label: '实际打款(CNY)', width: 130, type: 'money' },
  { prop: 'diff_cny', label: '差异(CNY)', width: 120, type: 'money', sortable: true },
  { prop: 'diff_rate', label: '差异率', width: 100, type: 'percent' },
  { prop: 'commission_diff_cny', label: '佣金差', width: 110, type: 'money' },
  { prop: 'platform_fee_cny', label: '平台费', width: 110, type: 'money' },
  { prop: 'shipping_fee_cny', label: '运费', width: 110, type: 'money' },
  { prop: 'subsidy_cny', label: '补贴', width: 110, type: 'money' },
  { prop: 'settle_refund_cny', label: '退款扣减', width: 110, type: 'money' },
  { prop: 'adjust_cny', label: '人工调整', width: 110, type: 'money' },
  { prop: 'explain_residual_cny', label: '未解释残差', width: 120, type: 'money', sortable: true },
  { prop: 'est_profit_cny', label: '预估利润', width: 120, type: 'money' },
  { prop: 'settled_profit_cny', label: '结算口径利润', width: 130, type: 'money' },
  { prop: 'unmapped_items', label: '待映射行', width: 100, align: 'right' },
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
    diff_rate: num(r.diff_rate),
  };
}

function rowClass(row: Record<string, unknown>): string {
  if (String(row.excluded_reason ?? '')) return 'row-muted';
  return Math.abs(num(row.diff_rate)) > 0.05 ? 'row-danger' : '';
}

/* ---------- 下钻：某单的全部结算流水 ---------- */
const drawer = ref(false);
const currentNo = ref('');
const txnLoading = ref(false);
const txns = ref<Record<string, unknown>[]>([]);

async function openOrder(row: Record<string, unknown>): Promise<void> {
  currentNo.value = String(row.tk_order_id ?? '');
  drawer.value = true;
  txnLoading.value = true;
  try {
    const data = await apiGet<{ list: Record<string, unknown>[] }>(`/finance/settlement/by-order/${encodeURIComponent(currentNo.value)}`);
    txns.value = data?.list ?? [];
  } catch {
    // 流水拉不到不影响对账结论（本页数据来自同一份结算流水汇总），只在抽屉里给空态
    txns.value = [];
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
