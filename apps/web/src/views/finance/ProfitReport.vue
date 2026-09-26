<template>
  <div class="page">
    <PageHeader title="利润报表" sub="我们的收入只有品牌返点：贡献毛利 = 应收返点 −（物流 + 达人佣金 + 分摊广告 + 分摊费用）。货款与货值都在品牌那边，从来不进我们的账。">
      <template #tag>
        <el-tag v-if="rows.length" size="small" :type="totals.profit < 0 ? 'danger' : 'success'">{{ rows.length }} 行 · 预估 {{ estimatedRows }} 行</el-tag>
      </template>
      <template #actions>
        <ExportButton url="/finance/profit/export" :name="`profit-${dim}`" :params="exportParams" />
      </template>
    </PageHeader>

    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="load">
        <el-form-item label="统计维度">
          <el-radio-group v-model="dim" @change="load">
            <el-radio-button v-for="d in DIMS" :key="d.value" :value="d.value">{{ d.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="期间">
          <el-date-picker
            v-model="period"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始"
            end-placeholder="结束"
            :clearable="false"
            style="width: 240px"
            @change="load"
          />
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="query.shop_id" clearable placeholder="全部" style="width: 160px" @change="load">
            <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="站点">
          <el-select v-model="query.region" clearable placeholder="全部" style="width: 110px" @change="load">
            <el-option v-for="r in REGIONS" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="口径">
          <el-switch v-model="query.only_settled" active-text="只看已结算" inline-prompt style="margin-right: 12px" @change="load" />
          <el-switch v-model="query.include_sample" active-text="含样品单" inline-prompt @change="load" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" :loading="loading" @click="load">生成报表</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
          <ExportButton url="/finance/profit/export" :name="`profit-${dim}`" :params="exportParams" />
        </el-form-item>
      </el-form>

      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 8px">
        <template #title>
          「带货 GMV / 净带货 GMV / 结算实收」是品牌的生意规模与平台打款，只作分母与对账用，不是我们的收入；贡献毛利率 = 贡献毛利 ÷ 净带货 GMV。
          灰字「预估」行为未结算订单，共 {{ estimatedRows }} 行。样品单默认不计 GMV（PRD §5.7）；
          没配到品牌返点率的订单行整体不在本表内（连 GMV 一起剔，不是按 0 返点算），去「商品中心 → 待映射清单」补齐。
        </template>
      </el-alert>
    </el-card>

    <!-- 合计：先看总数，再看钱去哪儿，最后才看逐行明细 -->
    <div class="stat-grid tk-in">
      <StatCard label="应收返点（我们的收入）" :value="totals.rebate" :sub="`有效返点率 ${pct(totals.rebate, totals.netGmv)}`" tone="success" money :precision="2" />
      <StatCard label="物流支出" :value="totals.logistics" sub="头程 + 海外仓操作，按件冻结在订单行上" tone="warning" :precision="2" />
      <StatCard label="达人佣金" :value="totals.commission" :sub="`占返点 ${pct(totals.commission, totals.rebate)}`" tone="warning" :precision="2" />
      <StatCard label="广告消耗" :value="totals.ad_spend" :sub="`占返点 ${pct(totals.ad_spend, totals.rebate)}｜这是最大的一块变动成本`" tone="warning" :precision="2" />
      <StatCard label="公共费用" :value="totals.expense" sub="按 GMV 占比分摊到本表口径" tone="info" :precision="2" />
      <StatCard label="贡献毛利" :value="totals.profit" :sub="`贡献毛利率 ${pct(totals.profit, totals.netGmv)}（分母＝净带货 GMV）`" :tone="totals.profit < 0 ? 'danger' : 'success'" money :precision="2" />
    </div>

    <div class="chart-grid">
      <ChartCard title="钱去哪儿了（从应收返点到贡献毛利）" tip="瀑布：每一段是被扣掉的一项。段与段之间没有对齐就是亏损扩大的方向" :span="7" :empty="!rows.length" empty-text="所选期间没有可算利润的行">
        <div ref="fallEl" class="chart-host" />
      </ChartCard>
      <ChartCard :title="`贡献毛利 ${dimLabel} 榜`" tip="正绿负红；条子长短只看绝对值，谁在赚钱谁在烧钱一眼分明" :span="5" :empty="rows.length < 2" empty-text="只有一个维度值，榜没有意义">
        <div ref="rankEl" class="chart-host" />
      </ChartCard>
    </div>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
        :row-class-name="rowClass"
        style="width: 100%"
        show-summary
        :summary-method="summary"
      >
        <el-table-column prop="dim_name" :label="dimLabel" min-width="160" fixed="left" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.dim_name || row.dim_key }}</span>
            <el-tag v-if="Number(row.is_estimated) === 1" size="small" type="info" class="est-tag">预估</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="orders" label="订单数" width="90" align="right">
          <template #default="{ row }">{{ int(row.orders) }}</template>
        </el-table-column>
        <el-table-column prop="gmv" label="带货 GMV" width="120" align="right">
          <template #default="{ row }">{{ money(row.gmv) }}</template>
        </el-table-column>
        <el-table-column prop="refund" label="退款" width="110" align="right">
          <template #default="{ row }">{{ money(row.refund) }}</template>
        </el-table-column>
        <el-table-column prop="net_gmv" label="净带货 GMV" width="125" align="right">
          <template #default="{ row }">{{ money(row.net_gmv) }}</template>
        </el-table-column>
        <el-table-column prop="rebate" label="应收返点·我们的收入" width="150" align="right">
          <template #default="{ row }">{{ money(row.rebate) }}</template>
        </el-table-column>
        <el-table-column prop="logistics" label="物流支出" width="115" align="right">
          <template #default="{ row }">{{ money(row.logistics) }}</template>
        </el-table-column>
        <el-table-column prop="commission" label="达人佣金" width="110" align="right">
          <template #default="{ row }">{{ money(row.commission) }}</template>
        </el-table-column>
        <el-table-column prop="ad_spend" label="广告消耗" width="110" align="right">
          <template #default="{ row }">{{ money(row.ad_spend) }}</template>
        </el-table-column>
        <el-table-column prop="expense" label="费用" width="110" align="right">
          <template #default="{ row }">{{ money(row.expense) }}</template>
        </el-table-column>
        <el-table-column prop="settled_amount" label="结算实收(带货)" width="135" align="right">
          <template #default="{ row }">{{ money(row.settled_amount) }}</template>
        </el-table-column>
        <el-table-column prop="profit" label="贡献毛利" width="120" align="right">
          <template #default="{ row }">
            <span :class="num(row.profit) < 0 ? 'neg' : 'pos'">{{ money(row.profit) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="profit_rate" label="贡献毛利率" width="105" align="right">
          <template #default="{ row }">
            <span :class="num(row.profit_rate) < 0 ? 'neg' : 'pos'">{{ rate(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="currency" label="币种" width="80" />
        <template #empty>
          <el-empty description="所选期间没有可算利润的行：确认订单/结算/广告已同步、SKU 都配到了品牌返点率，或放宽期间" />
        </template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import type { ProfitRow } from '@tk/shared';
import { REGIONS, num, profitRate, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useDictStore } from '@/stores/dict';
import type { RowLike } from '@/types/row';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';
import ChartCard from '@/components/ChartCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';

type Dim = 'shop' | 'sku' | 'creator' | 'month';

/**
 * /finance/profit 现在按品牌服务方口径回：收入侧是 `rebate`（应收返点），支出侧是 `logistics`（物流），
 * 不再有 `cost`（货款在品牌那边）。shared 的 ProfitRow 还没跟上这两个键，先在本页按接口实际返回收口。
 */
type Row = ProfitRow & { rebate: number; logistics: number };

const dict = useDictStore();

/** 报表维度（PRD §3.8 利润报表：必做 4 个维度） */
const DIMS: { value: Dim; label: string }[] = [
  { value: 'shop', label: '按店铺' },
  { value: 'sku', label: '按 SKU' },
  { value: 'creator', label: '按达人' },
  { value: 'month', label: '按月份' },
];

const shops = ref<{ id: number; shop_name: string }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const dim = ref<Dim>('shop');
const period = ref<[string, string]>([monthStart(0), dayText(new Date())]);

const query = reactive<{ shop_id?: number; region?: string; only_settled: boolean; include_sample: boolean }>({
  shop_id: undefined,
  region: undefined,
  only_settled: false,
  include_sample: false,
});

const dimLabel = computed(() => DIMS.find((d) => d.value === dim.value)?.label.replace('按', '') ?? '维度');
const estimatedRows = computed(() => rows.value.filter((r) => Number(r.is_estimated) === 1).length);

/* ---------- 合计与两张图 ---------- */
const fallEl = ref<HTMLDivElement>();
const rankEl = ref<HTMLDivElement>();

const sumOf = (pick: (r: Row) => number) => round2(rows.value.reduce((a, r) => a + num(pick(r)), 0));
const totals = computed(() => ({
  netGmv: sumOf((r) => r.net_gmv),
  rebate: sumOf((r) => r.rebate),
  logistics: sumOf((r) => r.logistics),
  commission: sumOf((r) => r.commission),
  ad_spend: sumOf((r) => r.ad_spend),
  expense: sumOf((r) => r.expense),
  profit: sumOf((r) => r.profit),
}));
const pct = (v: number, base: number) => (base > 0 ? `${((num(v) / num(base)) * 100).toFixed(1)}%` : '—');

/**
 * 瀑布：占位段透明，可见段从"扣完之后的余额"起画。
 * 最后一段是贡献毛利 —— 为负时画到零线以下并标红，这正是这张图要说的话。
 */
function waterfallOption(): ChartOption | null {
  if (!rows.value.length) return null;
  const t = totals.value;
  const steps = [
    { name: '应收返点', amount: t.rebate, deduct: false },
    { name: '− 物流', amount: t.logistics, deduct: true },
    { name: '− 达人佣金', amount: t.commission, deduct: true },
    { name: '− 广告分摊', amount: t.ad_spend, deduct: true },
    { name: '− 公共费用', amount: t.expense, deduct: true },
    { name: '贡献毛利', amount: t.profit, deduct: false },
  ];
  const base: number[] = [];
  const bar: { value: number; itemStyle: { color: string; borderRadius: number[] } }[] = [];
  let running = 0;
  steps.forEach((s, i) => {
    if (i === 0) {
      base.push(0);
      running = s.amount;
      bar.push({ value: s.amount, itemStyle: { color: chartColor.success(), borderRadius: [3, 3, 0, 0] } });
    } else if (i === steps.length - 1) {
      base.push(s.amount >= 0 ? 0 : s.amount);
      bar.push({ value: Math.abs(s.amount), itemStyle: { color: s.amount < 0 ? chartColor.danger() : chartColor.primary(), borderRadius: [3, 3, 0, 0] } });
    } else {
      running -= s.amount;
      base.push(running);
      bar.push({ value: s.amount, itemStyle: { color: chartColor.warning(), borderRadius: [3, 3, 0, 0] } });
    }
  });
  return {
    ...motion(),
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (p: { name: string; dataIndex: number }[]) => {
        const i = p[0]?.dataIndex ?? 0;
        return `${steps[i].name}<br/>${money(steps[i].amount)}`;
      },
    },
    grid: { left: 62, right: 18, top: 26, bottom: 30 },
    xAxis: { type: 'category', data: steps.map((s) => s.name), axisLabel: { fontSize: 11, interval: 0 } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    series: [
      { type: 'bar', stack: 'w', silent: true, itemStyle: { color: 'transparent' }, data: base },
      {
        type: 'bar',
        stack: 'w',
        barMaxWidth: 42,
        data: bar,
        label: { show: true, position: 'top', fontSize: 11, formatter: (p: { dataIndex: number }) => money(steps[p.dataIndex].amount) },
      },
    ],
  };
}

function rankOption(): ChartOption | null {
  if (rows.value.length < 2) return null;
  const top = [...rows.value].sort((a, b) => Math.abs(num(b.profit)) - Math.abs(num(a.profit))).slice(0, 12);
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: { name: string; value: number }[]) => `${p[0]?.name ?? ''}<br/>贡献毛利 ${money(Number(p[0]?.value ?? 0))}` },
    grid: { left: 110, right: 60, top: 12, bottom: 22 },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    yAxis: { type: 'category', data: top.map((r) => String(r.dim_name || r.dim_key)).reverse(), axisLabel: { width: 100, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 14,
        data: top
          .map((r) => ({ value: round2(num(r.profit)), itemStyle: { color: num(r.profit) < 0 ? chartColor.danger() : chartColor.success(), borderRadius: [0, 3, 3, 0] } }))
          .reverse(),
        label: { show: true, position: 'right', fontSize: 10, formatter: (p: { value: number }) => `${round2(num(p.value) / 10000)}万` },
      },
    ],
  };
}

useChart(fallEl, waterfallOption, [rows, dim]);
useChart(rankEl, rankOption, [rows, dim]);

const money = (v: unknown) => (v === '***' ? '***' : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const int = (v: unknown) => (v === null || v === undefined ? '-' : num(v).toLocaleString('zh-CN'));
const rate = (r: RowLike) => `${num(r.profit_rate).toFixed(2)}%`;
const rowClass = ({ row }: { row: Row }) => (Number(row.is_estimated) === 1 ? 'estimated-row' : '');

function dayText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function monthStart(offset: number): string {
  const d = new Date();
  return dayText(new Date(d.getFullYear(), d.getMonth() + offset, 1));
}

/** 导出与报表同源：维度、期间、店铺/站点与两个口径开关一并带上 */
const exportParams = computed<Record<string, unknown>>(() => ({
  dim: dim.value,
  from: period.value[0],
  to: period.value[1],
  shop_id: query.shop_id || undefined,
  region: query.region || undefined,
  only_settled: query.only_settled ? 1 : 0,
  include_sample: query.include_sample ? 1 : 0,
}));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await apiGet<Row[] | { list?: Row[] }>('/finance/profit', {
      dim: dim.value,
      from: period.value[0],
      to: period.value[1],
      shop_id: query.shop_id || undefined,
      region: query.region || undefined,
      only_settled: query.only_settled ? 1 : 0,
      include_sample: query.include_sample ? 1 : 0,
    });
    rows.value = Array.isArray(data) ? data : (data?.list ?? []);
  } catch (e) {
    rows.value = [];
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function resetQuery(): void {
  query.shop_id = undefined;
  query.region = undefined;
  query.only_settled = false;
  query.include_sample = false;
  period.value = [monthStart(0), dayText(new Date())];
  void load();
}

/** 常驻合计行：金额（含应收返点/物流）逐列求和；率一律不求和，合计口径重算 */
function summary({ columns: cols, data }: { columns: { property: string }[]; data: Row[] }): string[] {
  const sum = (f: (r: Row) => number) => round2(data.reduce((a, r) => a + num(f(r)), 0));
  const netGmv = sum((r) => num(r.net_gmv));
  const profit = sum((r) => num(r.profit));
  return cols.map((c, i) => {
    if (i === 0) return `合计（${data.length} 行，预估 ${data.filter((r) => Number(r.is_estimated) === 1).length} 行）`;
    switch (c.property) {
      case 'orders':
        return int(sum((r) => num(r.orders)));
      case 'profit_rate':
        // 率不能相加：按合计的「贡献毛利 ÷ 净带货 GMV」重算
        return `${profitRate(profit, netGmv).toFixed(2)}%`;
      case 'currency':
      case 'dim_name':
        return '';
      default:
        return money(sum((r) => num(r[c.property as keyof Row] as number)));
    }
  });
}

onMounted(() => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
  void load();
});
</script>

<style scoped>
.pos {
  color: #303133;
  font-weight: 600;
}
.neg {
  color: #f56c6c;
  font-weight: 600;
}
.est-tag {
  margin-left: 6px;
}
:deep(.estimated-row) {
  color: #909399;
}
</style>
