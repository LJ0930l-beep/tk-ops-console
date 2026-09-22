<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <el-form-item label="店铺">
          <el-select v-model="query.shop_id" clearable placeholder="全部" style="width: 160px" @change="reload(1)">
            <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="流水类型">
          <el-select v-model="query.txn_type" clearable placeholder="全部" style="width: 130px" @change="reload(1)">
            <el-option v-for="o in TXN_TYPE" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="打款状态">
          <el-select v-model="query.payment_status" clearable placeholder="全部" style="width: 120px" @change="reload(1)">
            <el-option v-for="o in PAYMENT_STATUS" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="结算单号">
          <el-input v-model="query.statement_id" clearable placeholder="statement_id" style="width: 160px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item label="订单号">
          <el-input v-model="query.tk_order_id" clearable placeholder="按订单号查流水" style="width: 180px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item label="结算时间">
          <el-date-picker
            v-model="timeRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始"
            end-placeholder="结束"
            style="width: 240px"
            clearable
            @change="reload(1)"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reload(1)">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon show-with-transition>
        <template #title>
          结算流水为平台真实回款记录，整页只读（同步覆盖，不可人工编辑）。收入为正、扣款为负；只有「已打款」计入实收，「处理中」单独统计。
          金额展示原币种与折算人民币双列，折 CNY 由后端 amount_cny 字段提供（若后端未返回则该列隐藏）。
        </template>
      </el-alert>
    </el-card>

    <div class="stat-grid">
      <el-card v-for="c in summaryCards" :key="c.label" shadow="never">
        <div class="kpi-label">{{ c.label }}<el-tag v-if="!c.server" size="small" type="info" style="margin-left: 6px">本页</el-tag></div>
        <div class="kpi-value" :class="c.class">{{ c.value }}</div>
        <div class="kpi-sub">{{ c.sub }}</div>
      </el-card>
    </div>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
        style="width: 100%"
        show-summary
        :summary-method="summary"
        @sort-change="onSort"
      >
        <el-table-column prop="statement_id" label="结算单号" width="160" show-overflow-tooltip fixed="left" />
        <el-table-column prop="statement_time" label="结算时间" width="150" sortable="custom">
          <template #default="{ row }">{{ dateTime(row.statement_time) }}</template>
        </el-table-column>
        <el-table-column prop="tk_order_id" label="平台订单号" width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <router-link v-if="row.tk_order_id" :to="orderLink(row)" class="link">{{ String(row.tk_order_id) }}</router-link>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column prop="shop_name" label="店铺" min-width="120" show-overflow-tooltip />
        <el-table-column prop="txn_type" label="流水类型" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="txnTag(row.txn_type)">{{ txnLabel(row.txn_type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额（原币）" width="130" align="right" sortable="custom">
          <template #default="{ row }">
            <span :class="num(row.amount) < 0 ? 'amt-neg' : 'amt-pos'">{{ signed(row.amount) }}</span>
            <span class="cur">{{ row.currency }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="hasCny" prop="amount_cny" label="折 CNY" width="130" align="right">
          <template #default="{ row }">
            <span :class="num(row.amount_cny) < 0 ? 'amt-neg' : 'amt-pos'">{{ signed(row.amount_cny) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="payment_id" label="打款单号" width="160" show-overflow-tooltip />
        <el-table-column prop="payment_status" label="打款状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="payTag(row.payment_status)">{{ payLabel(row.payment_status) }}</el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="该条件下没有结算流水：结算为每日同步，可检查结算任务或按订单号查询">
            <el-button type="primary" @click="router.push('/system/synclog')">查看同步监控</el-button>
          </el-empty>
        </template>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 12px; justify-content: flex-end"
        @current-change="reload()"
        @size-change="reload(1)"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import type { PageResult, SettlementTxn } from '@tk/shared';
import { SETTLE_TXN_TYPE, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useDictStore } from '@/stores/dict';
import type { RowLike } from '@/types/row';

type Row = SettlementTxn & Record<string, unknown>;

const dict = useDictStore();
const route = useRoute();
const router = useRouter();

type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

/** settlement_txn.txn_type（SETTLE_TXN_TYPE：收入为正 / 扣款为负） */
const TXN_TYPE: { value: number; label: string; type: TagType }[] = [
  { value: SETTLE_TXN_TYPE.ORDER_IN, label: '订单收入', type: 'success' },
  { value: SETTLE_TXN_TYPE.REFUND, label: '退款', type: 'danger' },
  { value: SETTLE_TXN_TYPE.PLATFORM_FEE, label: '平台佣金', type: 'warning' },
  { value: SETTLE_TXN_TYPE.CREATOR_FEE, label: '达人佣金', type: 'warning' },
  { value: SETTLE_TXN_TYPE.SHIPPING, label: '运费', type: 'info' },
  { value: SETTLE_TXN_TYPE.SUBSIDY, label: '平台补贴', type: 'primary' },
  { value: SETTLE_TXN_TYPE.ADJUST, label: '调整', type: 'info' },
  { value: SETTLE_TXN_TYPE.OTHER, label: '其他', type: 'info' },
];

/** settlement_txn.payment_status：1 已打款 / 2 处理中 / 3 失败 */
const PAYMENT_STATUS: { value: number; label: string; type: TagType }[] = [
  { value: 1, label: '已打款', type: 'success' },
  { value: 2, label: '处理中', type: 'warning' },
  { value: 3, label: '失败', type: 'danger' },
];

const shops = ref<{ id: number; shop_name: string }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);
const sortBy = ref('statement_time');
const sortOrder = ref('desc');
const timeRange = ref<[string, string] | null>(null);
const serverSummary = ref<Record<string, number> | null>(null);

const query = reactive<{ shop_id?: number; txn_type?: number; payment_status?: number; statement_id?: string; tk_order_id?: string }>({
  shop_id: route.query.shop_id ? Number(route.query.shop_id) : undefined,
  txn_type: undefined,
  payment_status: undefined,
  statement_id: '',
  tk_order_id: route.query.tk_order_id ? String(route.query.tk_order_id) : '',
});

/** 后端提供 amount_cny 时才展示双列 */
const hasCny = computed(() => rows.value.some((r) => r.amount_cny !== undefined && r.amount_cny !== null));

const money = (v: number) => num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: unknown) => `${num(v) > 0 ? '+' : num(v) < 0 ? '-' : ''}${money(Math.abs(num(v)))}`;
function dateTime(v: unknown): string {
  const s = String(v ?? '');
  return s ? s.replace('T', ' ').slice(0, 16) : '—';
}
const txnLabel = (v: unknown) => TXN_TYPE.find((o) => String(o.value) === String(v ?? ''))?.label ?? String(v ?? '-');
const txnTag = (v: unknown) => TXN_TYPE.find((o) => String(o.value) === String(v ?? ''))?.type ?? 'info';
const payLabel = (v: unknown) => PAYMENT_STATUS.find((o) => String(o.value) === String(v ?? ''))?.label ?? String(v ?? '-');
const payTag = (v: unknown) => PAYMENT_STATUS.find((o) => String(o.value) === String(v ?? ''))?.type ?? 'info';
/** settlement_txn 只有平台订单号，跳订单列表按号检索；入参按 RowLike 收口（插槽给的是 DefaultRow） */
const orderLink = (row: RowLike) => `/orders?keyword=${encodeURIComponent(String(row.tk_order_id ?? ''))}`;

const summaryCards = computed(() => {
  const src = serverSummary.value;
  const bucket = (status: number) => {
    const list = rows.value.filter((r) => Number(r.payment_status) === status);
    return { count: list.length, amount: round2(list.reduce((a, r) => a + num(r.amount_cny ?? r.amount), 0)) };
  };
  const pick = (status: number, countKey: string, amountKey: string) =>
    src ? { count: num(src[countKey]), amount: num(src[amountKey]) } : bucket(status);
  const paid = pick(1, 'paid_count', 'paid_amount');
  const processing = pick(2, 'processing_count', 'processing_amount');
  const failed = pick(3, 'failed_count', 'failed_amount');
  const net = src ? num(src.net_amount) : round2(rows.value.reduce((a, r) => a + num(r.amount_cny ?? r.amount), 0));
  return [
    { label: '已打款', value: money(paid.amount), sub: `${paid.count} 笔流水`, class: 'amt-pos', server: !!src },
    { label: '处理中', value: money(processing.amount), sub: `${processing.count} 笔流水（未计入实收）`, class: '', server: !!src },
    { label: '失败', value: money(failed.amount), sub: `${failed.count} 笔流水，需人工核对`, class: 'amt-neg', server: !!src },
    { label: '净额合计', value: signed(net), sub: '收入 − 扣款（优先折 CNY）', class: net < 0 ? 'amt-neg' : 'amt-pos', server: !!src },
  ];
});

async function reload(resetPage?: number): Promise<void> {
  if (resetPage) page.value = resetPage;
  loading.value = true;
  const params = {
    page: page.value,
    pageSize: pageSize.value,
    sortBy: sortBy.value,
    sortOrder: sortOrder.value,
    statement_time_from: timeRange.value?.[0],
    statement_time_to: timeRange.value?.[1],
    ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
  };
  try {
    const data = await apiGet<PageResult<Row>>('/finance/settlement', params);
    rows.value = data.list ?? [];
    total.value = data.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
  void loadSummary(params);
}

/** 页顶按店/按状态汇总：优先服务端 /finance/settlement/summary，缺失则回退本页统计 */
async function loadSummary(params: Record<string, unknown>): Promise<void> {
  try {
    const { shop_id, txn_type, payment_status, statement_id, tk_order_id, statement_time_from, statement_time_to } = params;
    serverSummary.value = await apiGet<Record<string, number>>('/finance/settlement/summary', {
      shop_id,
      txn_type,
      payment_status,
      statement_id,
      tk_order_id,
      statement_time_from,
      statement_time_to,
    });
  } catch {
    serverSummary.value = null;
  }
}

function resetQuery(): void {
  query.shop_id = undefined;
  query.txn_type = undefined;
  query.payment_status = undefined;
  query.statement_id = '';
  query.tk_order_id = '';
  timeRange.value = null;
  void reload(1);
}

function onSort({ prop, order }: { prop: string | null; order: string | null; column?: unknown }): void {
  sortBy.value = order && prop ? prop : 'statement_time';
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc';
  void reload();
}

function summary({ columns: cols, data }: { columns: { property: string }[]; data: Row[] }): string[] {
  const amt = round2(data.reduce((a, r) => a + num(r.amount), 0));
  const cny = round2(data.reduce((a, r) => a + num(r.amount_cny ?? r.amount), 0));
  return cols.map((c, i) => {
    if (i === 0) return '本页合计';
    if (c.property === 'amount') return signed(amt);
    if (c.property === 'amount_cny') return signed(cny);
    return '';
  });
}

onMounted(() => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
  void reload(1);
});
</script>

<style scoped>
.kpi-label {
  font-size: 12px;
  color: #909399;
}
.kpi-value {
  font-size: 20px;
  font-weight: 600;
  margin: 4px 0;
}
.kpi-sub {
  font-size: 12px;
  color: #a8abb2;
}
.amt-pos {
  color: #67c23a;
}
.amt-neg {
  color: #f56c6c;
}
.cur {
  color: #909399;
  font-size: 11px;
}
.link {
  color: #409eff;
  text-decoration: none;
}
</style>
