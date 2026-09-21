<template>
  <div class="page">
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
        title="stat_date 为店铺站点时区的自然日（PRD §5.5）；ROI = GMV ÷ 消耗，消耗为 0 时显示「—」；CTR = 点击 ÷ 曝光，CPC = 消耗 ÷ 点击，CPM = 消耗 ÷ 曝光 × 1000。"
      />
    </el-card>

    <div class="stat-grid">
      <el-card v-for="k in kpiCards" :key="k.label" shadow="never" class="kpi-card">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-value">{{ k.value }}</div>
        <div class="kpi-sub">{{ k.sub }}</div>
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
        <el-table-column prop="spend" label="消耗" width="110" align="right" sortable="custom">
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
        <el-table-column prop="gmv" label="广告 GMV" width="120" align="right" sortable="custom">
          <template #default="{ row }">{{ money(row.gmv) }}</template>
        </el-table-column>
        <el-table-column prop="roi" label="ROI" width="90" align="right" sortable="custom">
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
import { useDictStore } from '@/stores/dict';

type Row = AdDaily & Record<string, unknown>;

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
const money = (v: unknown) => (v === '***' ? '***' : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const int = (v: unknown) => (v === null || v === undefined ? '-' : num(v).toLocaleString('zh-CN'));
const pct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
const roiOf = (r: Row): number | null => (r.roi === undefined || r.roi === null ? adRoi(num(r.spend), num(r.gmv)) : Number(r.roi));
const roiText = (r: Row): string => {
  const v = roiOf(r);
  return v === null ? '—' : v.toFixed(2);
};
const ctr = (r: Row) => (num(r.impressions) > 0 ? (num(r.clicks) / num(r.impressions)) * 100 : NaN);
const cpc = (r: Row) => (num(r.clicks) > 0 ? round2(num(r.spend) / num(r.clicks)) : 0);
const cpm = (r: Row) => (num(r.impressions) > 0 ? round2((num(r.spend) / num(r.impressions)) * 1000) : 0);
function roiClass(r: Row): string {
  const v = roiOf(r);
  if (v === null) return 'mask';
  return v >= 1 ? 'roi-good' : 'roi-bad';
}

const kpiCards = computed(() => {
  const spend = round2(rows.value.reduce((a, r) => a + num(r.spend), 0));
  const gmv = round2(rows.value.reduce((a, r) => a + num(r.gmv), 0));
  const conv = rows.value.reduce((a, r) => a + num(r.conversions), 0);
  const imp = rows.value.reduce((a, r) => a + num(r.impressions), 0);
  const clk = rows.value.reduce((a, r) => a + num(r.clicks), 0);
  const roi = adRoi(spend, gmv);
  return [
    { label: '消耗（本页）', value: money(spend), sub: `${rows.value.length} 行明细` },
    { label: '广告 GMV', value: money(gmv), sub: `转化 ${int(conv)} 单` },
    { label: '整体 ROI', value: roi === null ? '—' : roi.toFixed(2), sub: roi === null ? '无消耗' : 'GMV ÷ 消耗' },
    { label: '点击率 CTR', value: imp > 0 ? `${((clk / imp) * 100).toFixed(2)}%` : '—', sub: `点击 ${int(clk)} / 曝光 ${int(imp)}` },
  ];
});

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

function onSort({ prop, order }: { prop: string; order: string | null }): void {
  sortBy.value = order ? prop : 'stat_date';
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
.roi-good {
  color: #67c23a;
  font-weight: 600;
}
.roi-bad {
  color: #f56c6c;
  font-weight: 600;
}
</style>
