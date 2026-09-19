<template>
  <div class="page" v-loading="loading">
    <el-card class="page-card" shadow="never">
      <div class="toolbar">
        <span class="tb-label">店铺</span>
        <el-select v-model="shopId" placeholder="全部店铺" clearable style="width: 200px" @change="load">
          <el-option v-for="s in shops" :key="s.id" :label="s.shop_name || `店铺#${s.id}`" :value="s.id" />
        </el-select>
        <span class="tb-label">窗口</span>
        <el-radio-group v-model="days" @change="load">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <span class="muted" v-if="range.start">{{ range.start }} ~ {{ range.end }}</span>
        <el-button style="margin-left: auto" size="small" @click="load">刷新</el-button>
      </div>
    </el-card>

    <!-- ABC 分层概览 -->
    <div class="stat-grid">
      <el-card v-for="t in tierCards" :key="t.tier" shadow="never" class="kpi" :class="'tier-' + t.tier">
        <div class="kpi-head"><span class="kpi-label">{{ t.tier }} 类商品</span><el-tag size="small" effect="plain">{{ t.rule }}</el-tag></div>
        <div class="kpi-value">{{ t.count }}</div>
        <div class="kpi-sub">净 GMV {{ money(t.gmv) }} · 占比 {{ (t.share * 100).toFixed(1) }}%</div>
      </el-card>
    </div>

    <!-- 渠道结构漂移 -->
    <el-card class="page-card" shadow="never">
      <template #header><b>渠道结构周趋势</b><span class="head-tip">净 GMV 按周 × 渠道堆叠，观察渠道依赖与迁移（§6.2）</span></template>
      <div ref="chanEl" class="chart-box" />
      <el-empty v-if="!channelWeeks.length" :image-size="60" description="暂无渠道结构数据" />
    </el-card>

    <!-- ABC 明细 -->
    <el-card class="page-card" shadow="never">
      <template #header><b>商品 ABC 分层与渠道健康</b><span class="head-tip">A/B 阈值 80%/95%，可在数据字典 dict_type=abc 调整</span></template>
      <el-table :data="rows" size="small" border stripe row-key="spu_id" :default-sort="{ prop: 'net_gmv', order: 'descending' }">
        <el-table-column label="层级" width="70" align="center" sortable :sort-method="(a: AbcRow, b: AbcRow) => a.tier.localeCompare(b.tier)">
          <template #default="{ row }"><el-tag size="small" :type="tierType(row.tier)" effect="dark">{{ row.tier }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="spu_name" label="商品" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.spu_name }}<span class="muted"> {{ row.spu_code }}</span></template>
        </el-table-column>
        <el-table-column prop="category" label="类目" width="90" show-overflow-tooltip />
        <el-table-column prop="net_gmv" label="净 GMV" width="120" align="right" sortable>
          <template #default="{ row }">{{ money(row.net_gmv) }}</template>
        </el-table-column>
        <el-table-column label="累计占比" width="150">
          <template #default="{ row }">
            <el-progress :percentage="Math.min(100, num(row.cum_share) * 100)" :stroke-width="12" :color="tierColor(row.tier)" :format="() => (num(row.share) * 100).toFixed(1) + '%'" />
          </template>
        </el-table-column>
        <el-table-column label="渠道结构" min-width="210">
          <template #default="{ row }">
            <div class="chan-tags">
              <el-tag v-for="c in topChannels(row)" :key="c.key" size="small" effect="plain" :type="c.key === row.max_channel ? 'warning' : 'info'">
                {{ c.label }} {{ c.pct }}%
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="集中度 HHI" width="100" align="right">
          <template #default="{ row }"><span :class="{ risk: num(row.hhi) > 0.5 }">{{ num(row.hhi).toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="渠道漂移" width="130">
          <template #default="{ row }">
            <span v-for="d in drifts(row)" :key="d.key" class="drift" :class="d.up ? 'up' : 'down'">{{ d.label }} {{ d.up ? '▲' : '▼' }}{{ d.pct }}</span>
            <span v-if="!drifts(row).length" class="muted">稳定</span>
          </template>
        </el-table-column>
        <el-table-column label="漏斗短板" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.funnel?.worst_stage" size="small" type="danger" effect="plain">{{ STAGE_LABELS[row.funnel.worst_stage] || row.funnel.worst_stage }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as echarts from 'echarts';
import { CHANNELS, CHANNEL_LABELS, num, round2, type Channel } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';

interface AbcRow {
  spu_id: number;
  spu_code: string;
  spu_name: string;
  category: string | null;
  net_gmv: number;
  share: number;
  cum_share: number;
  tier: 'A' | 'B' | 'C';
  channel_shares: Record<string, number>;
  max_channel: string | null;
  max_channel_share: number;
  hhi: number;
  share_delta: Record<string, number>;
  funnel: { impression: number; click: number; add_cart: number; orders: number; worst_stage: string | null };
}
interface ChanWeek {
  week: string;
  total_net_gmv: number;
  channels: Record<string, { net_gmv: number }>;
  shares: Record<string, number>;
}
const STAGE_LABELS: Record<string, string> = { impression: '曝光', click: '点击', add_cart: '加购', orders: '转化' };

const loading = ref(false);
const shopId = ref<number | undefined>(undefined);
const days = ref(30);
const shops = ref<{ id: number; shop_name?: string }[]>([]);
const rows = ref<AbcRow[]>([]);
const range = reactive({ start: '', end: '' });
const channelWeeks = ref<ChanWeek[]>([]);

const money = (v: unknown) => num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tierType = (t: string) => (t === 'A' ? 'success' : t === 'B' ? 'warning' : 'info') as 'success' | 'warning' | 'info';
const tierColor = (t: string) => (t === 'A' ? '#67c23a' : t === 'B' ? '#e6a23c' : '#909399');

const totalGmv = computed(() => rows.value.reduce((s, r) => s + num(r.net_gmv), 0));
const tierCards = computed(() => {
  const mk = (tier: 'A' | 'B' | 'C', rule: string) => {
    const list = rows.value.filter((r) => r.tier === tier);
    const gmv = list.reduce((s, r) => s + num(r.net_gmv), 0);
    return { tier, rule, count: list.length, gmv, share: totalGmv.value ? gmv / totalGmv.value : 0 };
  };
  return [mk('A', '累计≤80%'), mk('B', '80%~95%'), mk('C', '>95%')];
});

function topChannels(row: AbcRow): { key: string; label: string; pct: number }[] {
  return Object.entries(row.channel_shares || {})
    .filter(([, v]) => num(v) > 0.001)
    .sort((a, b) => num(b[1]) - num(a[1]))
    .slice(0, 3)
    .map(([k, v]) => ({ key: k, label: CHANNEL_LABELS[k as Channel] || k, pct: Math.round(num(v) * 100) }));
}
function drifts(row: AbcRow): { key: string; label: string; up: boolean; pct: string }[] {
  return Object.entries(row.share_delta || {})
    .filter(([, v]) => Math.abs(num(v)) >= 0.05)
    .sort((a, b) => Math.abs(num(b[1])) - Math.abs(num(a[1])))
    .slice(0, 2)
    .map(([k, v]) => ({ key: k, label: CHANNEL_LABELS[k as Channel] || k, up: num(v) > 0, pct: Math.abs(num(v) * 100).toFixed(0) + 'pct' }));
}

/* ---- 渠道结构周趋势图 ---- */
const chanEl = ref<HTMLDivElement>();
let chanChart: echarts.ECharts | null = null;
function renderChart(): void {
  if (!chanEl.value) return;
  if (!chanChart) chanChart = echarts.init(chanEl.value);
  const weeks = channelWeeks.value;
  const present = CHANNELS.filter((c) => weeks.some((w) => num(w.channels?.[c]?.net_gmv) > 0));
  chanChart.setOption(
    {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: present.map((c) => CHANNEL_LABELS[c]), bottom: 0, type: 'scroll' },
      grid: { left: 60, right: 30, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: weeks.map((w) => w.week.slice(5)) },
      yAxis: { type: 'value', name: '净GMV', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
      series: present.map((c) => ({
        name: CHANNEL_LABELS[c],
        type: 'bar',
        stack: 'gmv',
        barMaxWidth: 40,
        emphasis: { focus: 'series' },
        data: weeks.map((w) => round2(num(w.channels?.[c]?.net_gmv))),
      })),
    },
    true,
  );
}
function resize(): void {
  chanChart?.resize();
}

async function loadShops(): Promise<void> {
  try {
    const r = await apiGet<{ id: number; shop_name?: string }[]>('/shops/mine');
    shops.value = Array.isArray(r) ? r : [];
  } catch {
    shops.value = [];
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const params: Record<string, unknown> = { days: days.value };
    if (shopId.value) params.shop_id = shopId.value;
    const [abc, chan] = await Promise.all([
      apiGet<{ start: string; end: string; rows: AbcRow[] }>('/actions/analytics/abc', params),
      apiGet<ChanWeek[]>('/actions/analytics/shop-channel', { weeks: 8, ...(shopId.value ? { shop_id: shopId.value } : {}) }),
    ]);
    rows.value = abc.rows ?? [];
    range.start = abc.start;
    range.end = abc.end;
    channelWeeks.value = Array.isArray(chan) ? chan : [];
    await nextTick();
    renderChart();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadShops();
  await load();
  window.addEventListener('resize', resize);
});
onUnmounted(() => {
  window.removeEventListener('resize', resize);
  chanChart?.dispose();
  chanChart = null;
});
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tb-label { color: #606266; font-size: 13px; }
.muted { color: #909399; font-size: 12px; }
.head-tip { color: #909399; font-size: 12px; margin-left: 10px; font-weight: 400; }
.kpi-head { display: flex; justify-content: space-between; align-items: center; }
.kpi-label { color: #909399; font-size: 13px; }
.kpi-value { font-size: 30px; font-weight: 700; line-height: 1.3; }
.kpi-sub { color: #a8abb2; font-size: 12px; margin-top: 2px; }
.kpi.tier-A { border-left: 3px solid #67c23a; }
.kpi.tier-B { border-left: 3px solid #e6a23c; }
.kpi.tier-C { border-left: 3px solid #909399; }
.chan-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.drift { font-size: 12px; margin-right: 6px; }
.drift.up { color: #f56c6c; }
.drift.down { color: #409eff; }
.risk { color: #f56c6c; font-weight: 600; }
</style>
