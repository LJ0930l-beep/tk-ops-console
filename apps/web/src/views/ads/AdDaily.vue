<template>
  <div class="page">
    <PageHeader title="广告日报" sub="这里的 ROI 是带货口径 = GMV ÷ 消耗：GMV 是品牌的生意、不是我们的收入，所以 ROAS ≥ 1 并不等于赚钱">
      <template #tag>
        <el-tag v-if="trendTotal" size="small" :type="(trendTotal.roi ?? 0) < 1 ? 'danger' : 'info'">全期间 ROAS {{ trendTotal.roi === null ? '—' : Number(trendTotal.roi).toFixed(2) }}</el-tag>
      </template>
    </PageHeader>

    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <el-form-item label="统计日期" required>
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始"
            end-placeholder="结束"
            :clearable="false"
            style="width: 240px"
            @change="reload(1)"
          />
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="query.shop_id" clearable placeholder="全部" style="width: 160px" @change="reload(1)">
            <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="广告类型">
          <el-select v-model="query.ad_type" clearable placeholder="全部" style="width: 150px" @change="reload(1)">
            <el-option v-for="o in AD_TYPE" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="计划">
          <el-input v-model="query.campaign_id" clearable placeholder="campaign_id" style="width: 140px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item label="计划名称">
          <el-input v-model="query.keyword" clearable placeholder="campaign_name 模糊" style="width: 170px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reload(1)">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
          <el-button :icon="Calendar" @click="quickLast7">近 7 天</el-button>
          <el-button :icon="TrendCharts" @click="quickLast30">近 30 天</el-button>
          <ExportButton url="/ads/export" name="ad-daily" :params="exportParams" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="stat_date 为店铺站点时区的自然日（PRD §5.5）；这里的 ROI 是带货口径 = GMV ÷ 消耗，GMV 是品牌的生意、不是我们的收入，所以 ROAS≥1 并不等于赚钱。"
        description="消耗是我们掏的钱、GMV 是品牌的生意。我们能不能靠投流回本，看的是贡献毛利率（品牌返点率 − 物流 − 达人佣金）：盈亏平衡 ROAS = 1 ÷ 贡献毛利率，返点 20% 毛利就要 ROAS 5 才打平。本页只对「ROAS<1 必亏」标红，其余不判好坏，逐日结论交给规则中心的「广告低于盈亏线」（ADS_LOSS）；消耗为 0 时 ROAS 显示「—」。CTR = 点击 ÷ 曝光，CPC = 消耗 ÷ 点击，CPM = 消耗 ÷ 曝光 × 1000。"
      />
    </el-card>

    <div class="stat-grid tk-in">
      <StatCard v-for="k in kpiCards" :key="k.label" :label="k.label" :value="k.value" :sub="k.sub" :tone="k.tone" />
    </div>

    <el-alert v-if="chartError" type="warning" :closable="false" show-icon class="page-card" :title="`投放趋势与计划榜加载失败：${chartError}`" description="下面的表格不受影响：图取的是全量聚合接口，表取的是分页明细。" />
    <div class="chart-grid">
      <ChartCard title="逐日消耗与 ROAS" :tip="trendTip" :span="7" :empty="!trendRows.length" empty-text="这个区间没有投放数据">
        <div ref="trendEl" class="chart-host" />
      </ChartCard>
      <ChartCard title="计划 ROAS 榜（Top 10）" :tip="rankTip" :span="5" :empty="!rankRows.length" empty-text="没有可比的计划">
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
        style="width: 100%"
        show-summary
        :summary-method="summary"
        @sort-change="onSort"
      >
        <el-table-column prop="stat_date" label="统计日期" width="110" fixed="left" sortable="custom">
          <template #default="{ row }">{{ String(row.stat_date ?? '').slice(0, 10) }}</template>
        </el-table-column>
        <el-table-column prop="shop_name" label="店铺" min-width="120" show-overflow-tooltip />
        <el-table-column prop="ad_type" label="广告类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="adTypeTag(row.ad_type)">{{ adTypeLabel(row.ad_type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="campaign_id" label="计划 ID" width="130" show-overflow-tooltip />
        <el-table-column prop="campaign_name" label="计划名称" min-width="170" show-overflow-tooltip />
        <el-table-column prop="advertiser_id" label="广告账户" width="130" show-overflow-tooltip />
        <el-table-column prop="spend" label="消耗(我们掏)" width="120" align="right" sortable="custom">
          <template #default="{ row }">{{ money(row.spend) }} <span class="cur">{{ row.currency }}</span></template>
        </el-table-column>
        <el-table-column prop="impressions" label="曝光" width="100" align="right" sortable="custom">
          <template #default="{ row }">{{ int(row.impressions) }}</template>
        </el-table-column>
        <el-table-column prop="clicks" label="点击" width="90" align="right">
          <template #default="{ row }">{{ int(row.clicks) }}</template>
        </el-table-column>
        <el-table-column label="CTR" width="85" align="right">
          <template #default="{ row }">{{ pct(ctr(row)) }}</template>
        </el-table-column>
        <el-table-column label="CPC" width="90" align="right">
          <template #default="{ row }">{{ money(cpc(row)) }}</template>
        </el-table-column>
        <el-table-column label="CPM" width="90" align="right">
          <template #default="{ row }">{{ money(cpm(row)) }}</template>
        </el-table-column>
        <el-table-column prop="conversions" label="转化" width="90" align="right">
          <template #default="{ row }">{{ int(row.conversions) }}</template>
        </el-table-column>
        <el-table-column prop="gmv" label="广告带货 GMV" width="135" align="right" sortable="custom">
          <template #default="{ row }">{{ money(row.gmv) }}</template>
        </el-table-column>
        <el-table-column prop="roi" label="ROAS(GMV÷消耗)" width="140" align="right" sortable="custom">
          <template #default="{ row }">
            <span :class="roiClass(row)">{{ roiText(row) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="未同步到广告数据：检查广告账户授权，或改用人工补录 / 导入">
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
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Calendar, RefreshLeft, Search, TrendCharts } from '@element-plus/icons-vue';
import type { AdDaily, PageResult } from '@tk/shared';
import { adRoi, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import ExportButton from '@/components/ExportButton.vue';
import ChartCard from '@/components/ChartCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';
import { useDictStore } from '@/stores/dict';
import type { RowLike } from '@/types/row';

type Row = AdDaily & Record<string, unknown>;

/** /ads/trend 与 /ads/roi/rank 的行（全期间聚合，不是分页表里那一页） */
interface TrendRow {
  date?: string;
  spend: number;
  gmv: number;
  roi: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
}
interface RankRow {
  group_name: string;
  spend: number;
  gmv: number;
  roi: number | null;
}

const dict = useDictStore();
const router = useRouter();

/** ad_daily.ad_type：1 GMV Max 商品 / 2 GMV Max 直播 / 3 视频投流 / 4 达人授权投放 */
const AD_TYPE = [
  { value: 1, label: 'GMV Max 商品', type: 'primary' as const },
  { value: 2, label: 'GMV Max 直播', type: 'success' as const },
  { value: 3, label: '视频投流', type: 'warning' as const },
  { value: 4, label: '达人授权投放', type: 'danger' as const },
];

const shops = ref<{ id: number; shop_name: string }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);
const sortBy = ref('stat_date');
const sortOrder = ref('desc');
const dateRange = ref<[string, string]>([dayOffset(-6), dayText(new Date())]);

const query = reactive<{ shop_id?: number; ad_type?: number; campaign_id?: string; keyword?: string }>({
  shop_id: undefined,
  ad_type: undefined,
  campaign_id: '',
  keyword: '',
});

/** 导出用与列表完全相同的筛选条件，否则「导出的不是屏幕上这一屏」 */
const exportParams = computed<Record<string, unknown>>(() => ({
  stat_date_from: dateRange.value[0],
  stat_date_to: dateRange.value[1],
  ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
}));

/* ---- 派生指标 ---- */
/* ---- 派生指标：入参按 RowLike 收口，插槽给出的是 DefaultRow ---- */
const money = (v: unknown) => (v === '***' ? '***' : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const int = (v: unknown) => (v === null || v === undefined ? '-' : num(v).toLocaleString('zh-CN'));
const pct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
const roiOf = (r: RowLike): number | null => (r.roi === undefined || r.roi === null ? adRoi(num(r.spend), num(r.gmv)) : Number(r.roi));
const roiText = (r: RowLike): string => {
  const v = roiOf(r);
  return v === null ? '—' : v.toFixed(2);
};
const ctr = (r: RowLike) => (num(r.impressions) > 0 ? (num(r.clicks) / num(r.impressions)) * 100 : NaN);
const cpc = (r: RowLike) => (num(r.clicks) > 0 ? round2(num(r.spend) / num(r.clicks)) : 0);
const cpm = (r: RowLike) => (num(r.impressions) > 0 ? round2((num(r.spend) / num(r.impressions)) * 1000) : 0);
function roiClass(r: RowLike): string {
  const v = roiOf(r);
  if (v === null) return 'mask';
  // 只标「一定亏」的那一侧：贡献毛利率 ≤ 100% ⇒ 盈亏平衡 ROAS ≥ 1，所以 ROAS<1 必亏。
  // ROAS≥1 不代表盈利（要看返点率），本页不下这个结论，交给「广告低于盈亏线」预警规则按 1/毛利率判。
  return v < 1 ? 'roi-bad' : '';
}

const kpiCards = computed(() => {
  const t = trendTotal.value;
  const spend = t ? num(t.spend) : round2(rows.value.reduce((a, r) => a + num(r.spend), 0));
  const gmv = t ? num(t.gmv) : round2(rows.value.reduce((a, r) => a + num(r.gmv), 0));
  const conv = t ? num(t.conversions) : rows.value.reduce((a, r) => a + num(r.conversions), 0);
  const imp = t ? num(t.impressions) : rows.value.reduce((a, r) => a + num(r.impressions), 0);
  const clk = t ? num(t.clicks) : rows.value.reduce((a, r) => a + num(r.clicks), 0);
  const roi = t && t.roi !== null && t.roi !== undefined ? num(t.roi) : adRoi(spend, gmv);
  /** 有 /ads/trend 就报全期间，没有才退回"本页"—— 一页 50 行当总体是假的合计 */
  const scope = t ? '全期间' : '本页';
  return [
    { label: `消耗（${scope}·我们掏）`, value: round2(spend), sub: t ? `${trendRows.value.length} 天有投放` : `${rows.value.length} 行明细`, tone: 'warning' as const, precision: 2 },
    { label: '广告带货 GMV', value: round2(gmv), sub: `转化 ${int(conv)} 单（品牌的生意规模）`, tone: 'info' as const, precision: 2 },
    {
      label: '整体 ROAS',
      value: roi === null ? '—' : round2(roi),
      sub: roi === null ? '无消耗' : 'GMV ÷ 消耗：≥1 只是不打负，回本看盈亏平衡 ROAS = 1 ÷ 贡献毛利率',
      tone: (roi === null ? 'info' : roi < 1 ? 'danger' : 'primary') as 'info' | 'danger' | 'primary',
      precision: 2,
    },
    { label: '点击率 CTR', value: imp > 0 ? round2((clk / imp) * 100) : '—', suffix: '%', sub: `点击 ${int(clk)} / 曝光 ${int(imp)}`, tone: 'primary' as const, precision: 2 },
  ];
});

/* ---------- 逐日趋势与计划榜 ---------- */
const trendEl = ref<HTMLDivElement>();
const rankEl = ref<HTMLDivElement>();
const trendRows = ref<TrendRow[]>([]);
const trendTotal = ref<TrendRow | null>(null);
const rankRows = ref<RankRow[]>([]);
const chartError = ref('');

const trendTip = '消耗（柱）与 ROAS（线）逐日；只跟店铺与日期范围走 —— 接口不按广告类型/计划聚合，所以那两个筛选不影响这张图';
const rankTip = 'ROAS 从高到低 Top 10；条上标消耗，红条是 ROAS < 1（连品牌的 GMV 都没盖住花费）';

function trendOption(): ChartOption | null {
  const list = trendRows.value;
  if (!list.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis' },
    legend: { top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 62, right: 52, top: 34, bottom: 26 },
    xAxis: { type: 'category', data: list.map((r) => String(r.date ?? '').slice(5)) },
    yAxis: [
      { type: 'value', name: '消耗', nameTextStyle: { fontSize: 11, color: chartColor.muted() }, axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
      { type: 'value', name: 'ROAS', splitLine: { show: false } },
    ],
    series: [
      { name: '消耗', type: 'bar', barMaxWidth: 18, itemStyle: { color: chartColor.warning(), opacity: 0.8, borderRadius: [3, 3, 0, 0] }, data: list.map((r) => round2(num(r.spend))) },
      {
        name: 'ROAS',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        showSymbol: list.length <= 40,
        lineStyle: { color: chartColor.primary(), width: 2 },
        itemStyle: { color: chartColor.primary() },
        data: list.map((r) => (r.roi === null || r.roi === undefined ? null : round2(num(r.roi)))),
        markLine: { silent: true, symbol: 'none', label: { formatter: 'ROAS 1.0', fontSize: 10 }, lineStyle: { type: 'dashed', color: chartColor.muted() }, data: [{ yAxis: 1 }] },
      },
    ],
  };
}

function rankOption(): ChartOption | null {
  const list = rankRows.value.slice(0, 10);
  if (!list.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 118, right: 62, top: 12, bottom: 22 },
    xAxis: { type: 'value', name: 'ROAS', nameTextStyle: { fontSize: 11, color: chartColor.muted() } },
    yAxis: { type: 'category', data: list.map((r) => r.group_name).reverse(), axisLabel: { width: 110, overflow: 'truncate', fontSize: 11 } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 14,
        data: list
          .map((r) => ({ value: r.roi === null || r.roi === undefined ? 0 : round2(num(r.roi)), itemStyle: { color: num(r.roi) < 1 ? chartColor.danger() : chartColor.success(), borderRadius: [0, 3, 3, 0] } }))
          .reverse(),
        label: {
          show: true,
          position: 'right',
          fontSize: 10,
          formatter: (p: { dataIndex: number }) => `${round2(num(list[list.length - 1 - p.dataIndex].spend) / 10000)}万`,
        },
      },
    ],
  };
}

useChart(trendEl, trendOption, [trendRows]);
useChart(rankEl, rankOption, [rankRows]);

/** 图表拉的是全量聚合接口，与下面那张分页表同源不同形；失败只影响图，不能把表格一起带崩 */
async function loadCharts(): Promise<void> {
  const base: Record<string, unknown> = { stat_date_from: dateRange.value[0], stat_date_to: dateRange.value[1] };
  if (query.shop_id) base.shop_id = query.shop_id;
  try {
    const [t, r] = await Promise.all([
      apiGet<{ rows: TrendRow[]; total: TrendRow }>('/ads/trend', base),
      apiGet<{ list: RankRow[] }>('/ads/roi/rank', { ...base, group_by: 'campaign', limit: 10 }),
    ]);
    trendRows.value = t.rows ?? [];
    trendTotal.value = t.total ?? null;
    rankRows.value = r.list ?? [];
    chartError.value = '';
  } catch (e) {
    trendRows.value = [];
    trendTotal.value = null;
    rankRows.value = [];
    chartError.value = errMsg(e);
  }
}

function dayText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dayText(d);
}
function quickLast7(): void {
  dateRange.value = [dayOffset(-6), dayText(new Date())];
  void reload(1);
}
function quickLast30(): void {
  dateRange.value = [dayOffset(-29), dayText(new Date())];
  void reload(1);
}

function adTypeLabel(v: unknown): string {
  return AD_TYPE.find((o) => String(o.value) === String(v ?? ''))?.label ?? String(v ?? '-');
}
function adTypeTag(v: unknown): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  return AD_TYPE.find((o) => String(o.value) === String(v ?? ''))?.type ?? 'info';
}

async function reload(resetPage?: number): Promise<void> {
  if (resetPage) page.value = resetPage;
  if (!dateRange.value?.[0] || !dateRange.value?.[1]) {
    ElMessage.warning('统计日期区间必填');
    return;
  }
  loading.value = true;
  try {
    const data = await apiGet<PageResult<Row>>('/ads/daily', {
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      stat_date_from: dateRange.value[0],
      stat_date_to: dateRange.value[1],
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
    });
    rows.value = data.list ?? [];
    total.value = data.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
    void loadCharts();
  }
}

function resetQuery(): void {
  query.shop_id = undefined;
  query.ad_type = undefined;
  query.campaign_id = '';
  query.keyword = '';
  dateRange.value = [dayOffset(-6), dayText(new Date())];
  void reload(1);
}

function onSort({ prop, order }: { prop: string | null; order: string | null; column?: unknown }): void {
  sortBy.value = order && prop ? prop : 'stat_date';
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc';
  void reload();
}

/** 合计行：本页汇总；跨页全量汇总需服务端聚合接口（见接口缺口） */
function summary({ columns: cols, data }: { columns: { property: string }[]; data: Row[] }): string[] {
  const sum = (f: (r: Row) => number) => round2(data.reduce((a, r) => a + f(r), 0));
  const spend = sum((r) => num(r.spend));
  const gmv = sum((r) => num(r.gmv));
  return cols.map((c, i) => {
    if (i === 0) return '本页合计';
    switch (c.property) {
      case 'spend':
        return money(spend);
      case 'impressions':
        return int(sum((r) => num(r.impressions)));
      case 'clicks':
        return int(sum((r) => num(r.clicks)));
      case 'conversions':
        return int(sum((r) => num(r.conversions)));
      case 'gmv':
        return money(gmv);
      case 'roi': {
        const v = adRoi(spend, gmv);
        return v === null ? '—' : v.toFixed(2);
      }
      default:
        return '';
    }
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
.kpi-card :deep(.el-card__body) {
  padding: 12px 14px;
}
.kpi-label {
  font-size: 12px;
  color: #909399;
}
.kpi-value {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  margin: 4px 0;
}
.kpi-sub {
  font-size: 12px;
  color: #a8abb2;
}
.cur {
  color: #909399;
  font-size: 11px;
}
.roi-bad {
  color: #f56c6c;
  font-weight: 600;
}
</style>
