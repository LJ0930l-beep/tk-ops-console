<template>
  <div class="page" v-loading="loading">
    <el-alert
      v-if="num(summary?.sync_failed) > 0"
      type="error"
      :closable="false"
      show-icon
      class="page-card"
      :title="`数据同步异常：最近 ${summary?.sync_failed} 次同步任务失败或部分失败，看板数字可能不是最新。`"
      description="点击进入同步监控查看错误详情并重跑任务。"
      @click="goto('/system/synclog', { status: '3' })"
    />

    <el-alert
      v-if="noShop"
      type="warning"
      :closable="false"
      show-icon
      class="page-card"
      title="你还没有可见店铺，请联系管理员配置数据权限（角色数据范围 / 授权店铺）。"
    />

    <!-- KPI 指标卡 -->
    <div class="stat-grid">
      <el-card v-for="k in kpiCards" :key="k.label" shadow="never" class="kpi">
        <div class="kpi-head">
          <span class="kpi-label">{{ k.label }}</span>
          <el-tag v-if="k.masked" size="small" type="info">需金额权限</el-tag>
        </div>
        <div class="kpi-value" :class="k.class">{{ k.value }}</div>
        <div class="kpi-sub">{{ k.sub }}</div>
      </el-card>
    </div>

    <!-- 待办清单 -->
    <el-card class="page-card" shadow="never">
      <template #header><b>待办清单</b><span class="head-tip">点击卡片直达对应列表页并带上筛选条件</span></template>
      <div class="todo-grid">
        <div v-for="t in todoCards" :key="t.label" class="todo" :class="`todo-${t.level}`" @click="goto(t.path, t.query)">
          <div class="todo-count">{{ t.count }}</div>
          <div class="todo-body">
            <div class="todo-label">{{ t.label }}</div>
            <div class="todo-desc">{{ t.desc }}</div>
          </div>
          <el-icon class="todo-arrow"><ArrowRight /></el-icon>
        </div>
      </div>
    </el-card>

    <!-- 趋势 + 内容类型 -->
    <el-row :gutter="16" class="page-card">
      <el-col :span="16">
        <el-card shadow="never">
          <template #header><b>近 30 天 带货 GMV / 贡献毛利 / 订单趋势</b><span class="head-tip">按店铺站点时区切日（PRD §5.5）；贡献毛利 = 应收返点 − 物流 − 达人佣金</span></template>
          <div ref="trendEl" class="chart-box" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <template #header><b>内容带货类型占比</b></template>
          <div ref="pieEl" class="chart-box" />
          <el-empty v-if="!(summary?.content_type_split?.length)" :image-size="60" description="暂无内容归因数据" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 店铺榜 + 达人榜 -->
    <el-row :gutter="16" class="page-card">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header><b>店铺带货 GMV Top 榜</b><span class="head-tip">返点按 SKU 的返点率算，榜单只比带货规模</span><el-button link type="primary" style="float: right" @click="goto('/orders')">看订单</el-button></template>
          <div ref="shopEl" class="chart-box" />
          <el-empty v-if="!(summary?.shop_rank?.length)" :image-size="60" description="没有店铺汇总数据" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header><b>达人带货 Top 榜</b><span class="head-tip">排名按带货 GMV（品牌的生意）；我们赚不赚钱看「投产比」列</span><el-button link type="primary" style="float: right" @click="goto('/creators/roi')">达人 ROI</el-button></template>
          <el-table :data="summary?.creator_rank ?? []" size="small" border stripe :max-height="300" empty-text="暂无归因到达人的成交">
            <el-table-column type="index" label="#" width="46" />
            <el-table-column prop="handle" label="达人" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">@{{ row.handle }}</template>
            </el-table-column>
            <el-table-column prop="gmv" label="带货 GMV(参考)" width="130" align="right">
              <template #default="{ row }">{{ money(row.gmv) }}</template>
            </el-table-column>
            <el-table-column prop="orders" label="订单" width="80" align="right" />
            <el-table-column v-if="canSeeCost" prop="cost" label="我方投入" width="110" align="right">
              <template #default="{ row }">{{ mask(row.cost) }}</template>
            </el-table-column>
            <el-table-column label="投产比(返点÷投入)" width="170">
              <template #default="{ row }">
                <span v-if="row.roi === null || row.roi === undefined" class="mask">—</span>
                <el-progress
                  v-else
                  :percentage="Math.min(100, Number(row.roi) * 20)"
                  :format="() => Number(row.roi).toFixed(2)"
                  :stroke-width="12"
                  :color="Number(row.roi) >= 1 ? '#67c23a' : '#e6a23c'"
                />
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- BD 榜 -->
    <el-card shadow="never">
      <template #header><b>BD 建联榜</b><span class="head-tip">跟进数 / 谈妥数 / 带货 GMV</span></template>
      <el-table :data="summary?.bd_rank ?? []" size="small" border stripe empty-text="暂无建联记录">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="real_name" label="BD" min-width="120" />
        <el-table-column prop="outreach" label="跟进数" width="100" align="right" />
        <el-table-column prop="agreed" label="谈妥数" width="100" align="right" />
        <el-table-column label="谈妥率" width="110" align="right">
          <template #default="{ row }">{{ num(row.outreach) > 0 ? `${((num(row.agreed) / num(row.outreach)) * 100).toFixed(1)}%` : '—' }}</template>
        </el-table-column>
        <el-table-column prop="gmv" label="带货 GMV" width="140" align="right">
          <template #default="{ row }">{{ money(row.gmv) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="goto('/creators/outreach', { user_id: String(row.user_id) })">看跟进</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowRight } from '@element-plus/icons-vue';
import { init as echartsInit, type ECharts } from '@/utils/echarts';
import type { DashboardSummary } from '@tk/shared';
import { CONTENT_TYPE, MASK, SAMPLE_STATUS, adRoi, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const summary = ref<DashboardSummary | null>(null);
const loading = ref(false);
const shopCount = ref(0);
const shopsLoaded = ref(false);

const trendEl = ref<HTMLDivElement>();
const shopEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();
let trendChart: ECharts | null = null;
let shopChart: ECharts | null = null;
let pieChart: ECharts | null = null;

/** can_see_cost 以接口返回为准（服务端 maskFields 同步下发），回落本地登录态 */
const canSeeCost = computed(() => (summary.value ? !!summary.value.can_see_cost : auth.canSeeCost));
const noShop = computed(() => shopsLoaded.value && shopCount.value === 0);
const money = (v: unknown) => (v === MASK ? MASK : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const mask = (v: unknown) => (canSeeCost.value ? money(v) : MASK);
const int = (v: unknown) => (v === MASK ? MASK : Math.round(num(v)).toLocaleString('zh-CN'));
const pctText = (v: unknown) => (v === MASK ? MASK : `${num(v).toFixed(2)}%`);

/** content_type_split.type 可能是 CONTENT_TYPE 数字或中文名，统一渲染为中文 */
const CONTENT_LABEL: Record<number, string> = {
  [CONTENT_TYPE.CREATOR_VIDEO]: '达人视频',
  [CONTENT_TYPE.CREATOR_LIVE]: '达人直播',
  [CONTENT_TYPE.OWN_VIDEO]: '自有视频',
  [CONTENT_TYPE.OWN_LIVE]: '自有直播',
  [CONTENT_TYPE.PRODUCT_CARD]: '商品卡',
};
const contentLabel = (t: unknown) => CONTENT_LABEL[Number(t)] ?? String(t ?? '-');

const kpiCards = computed(() => {
  const s = summary.value;
  const roi = canSeeCost.value && s ? (s.ad_roi ?? adRoi(num(s.ad_spend), num(s.ad_gmv))) : null;
  return [
    { label: '带货 GMV（净）', value: money(s?.gmv), sub: `退款率 ${pctText(s?.refund_rate)}，退款 ${money(s?.refund_amount)}｜GMV 是品牌的生意`, class: '', masked: false },
    { label: '订单数', value: int(s?.orders), sub: '非取消、非样品单', class: '', masked: false },
    { label: '应收返点（我们的收入）', value: mask(s?.est_rebate), sub: '实收 GMV × 品牌返点率；不含货款，货款是品牌垫的', class: 'profit', masked: !canSeeCost.value },
    {
      label: '预估贡献毛利',
      value: mask(s?.est_gross_profit),
      sub: `贡献毛利率 ${canSeeCost.value ? pctText(s?.est_profit_rate) : MASK} = 返点 − 物流 − 达人佣金；物流支出 ${mask(s?.est_logistics)}`,
      class: 'profit',
      masked: !canSeeCost.value,
    },
    { label: '实际到账', value: mask(s?.settled_amount), sub: '平台打款结算流水折算（带货口径，不等于我们的收入）', class: 'profit', masked: !canSeeCost.value },
    { label: '广告', value: canSeeCost.value ? (roi === null ? '—' : roi.toFixed(2)) : MASK, sub: `消耗 ${mask(s?.ad_spend)} / 带货 GMV ${money(s?.ad_gmv)}｜打平线看贡献毛利率`, class: '', masked: !canSeeCost.value },
    { label: '今日直播', value: int(s?.live_today), sub: '今日「已排班」场次数', class: '', masked: false },
  ];
});

type TodoLevel = 'danger' | 'warning' | 'info';
const todoCards = computed(() => {
  const s = summary.value;
  const item = (
    label: string,
    count: number,
    desc: string,
    path: string,
    query: Record<string, string>,
    level: TodoLevel,
  ) => ({ label, count: int(count), desc, path, query, level });
  return [
    item('未配返点率的店铺商品', num(s?.unmapped_listings), '这些行没配到品牌返点率 → 整体不参与利润（不是 0 利润），看板数字会缺一大块收入', '/products/unmapped', { map_status: '2' }, num(s?.unmapped_listings) > 0 ? 'danger' : 'info'),
    item('待跟进达人', num(s?.creators_to_follow), '到 next_follow_at 或保护期 7 天内到期', '/creators/outreach', { todo: 'to_follow' }, num(s?.creators_to_follow) > 0 ? 'warning' : 'info'),
    item('超期未出内容', num(s?.samples_overdue), '寄样签收后超 7 天未产出内容', '/creators/sample', { status: String(SAMPLE_STATUS.OVERDUE) }, num(s?.samples_overdue) > 0 ? 'danger' : 'info'),
    item('授权即将过期', num(s?.auth_expiring), 'auth_status=即将过期/已过期，同步会跳过', '/shops', { auth_status: '2' }, num(s?.auth_expiring) > 0 ? 'danger' : 'info'),
    item('同步异常', num(s?.sync_failed), '最近一次同步失败或部分失败', '/system/synclog', { status: '3' }, num(s?.sync_failed) > 0 ? 'danger' : 'info'),
    item('今日直播', num(s?.live_today), '今日排班场次，开播前 1 天自动提醒', '/lives/schedule', {}, 'info'),
  ];
});

function goto(path: string, query: Record<string, string> = {}): void {
  void router.push({ path, query });
}

/* ==================== echarts ==================== */
function initCharts(): void {
  if (trendEl.value && !trendChart) trendChart = echartsInit(trendEl.value);
  if (shopEl.value && !shopChart) shopChart = echartsInit(shopEl.value);
  if (pieEl.value && !pieChart) pieChart = echartsInit(pieEl.value);
}

function renderCharts(): void {
  const s = summary.value;
  const trend = s?.gmv_trend ?? [];
  const dates = trend.map((t) => String(t.date ?? '').slice(5));
  const showProfit = canSeeCost.value;
  trendChart?.setOption(
    {
      tooltip: { trigger: 'axis' },
      legend: { data: showProfit ? ['带货GMV', '订单数', '预估贡献毛利'] : ['带货GMV', '订单数'] },
      grid: { left: 60, right: 60, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: [
        { type: 'value', name: '金额(CNY)', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
        { type: 'value', name: '订单数', splitLine: { show: false } },
      ],
      series: [
        {
          name: '带货GMV',
          type: 'line',
          smooth: true,
          showSymbol: false,
          areaStyle: { opacity: 0.12 },
          data: trend.map((t) => round2(num(t.gmv))),
        },
        {
          name: '预估贡献毛利',
          type: 'line',
          smooth: true,
          showSymbol: false,
          show: showProfit,
          data: trend.map((t) => round2(num(t.profit))),
        },
        {
          name: '订单数',
          type: 'bar',
          yAxisIndex: 1,
          barMaxWidth: 14,
          itemStyle: { color: '#91cc75', opacity: 0.6 },
          data: trend.map((t) => num(t.orders)),
        },
      ],
    },
    true,
  );

  const rank = (s?.shop_rank ?? []).slice(0, 10);
  shopChart?.setOption(
    {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 100, right: 40, top: 20, bottom: 30 },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
      yAxis: { type: 'category', data: rank.map((r) => r.shop_name).reverse(), axisLabel: { width: 90, overflow: 'truncate' } },
      series: [
        {
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: '#409eff', borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right' },
          data: rank.map((r) => round2(num(r.gmv))).reverse(),
        },
      ],
    },
    true,
  );

  const split = s?.content_type_split ?? [];
  pieChart?.setOption(
    {
      tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['38%', '62%'],
          center: ['50%', '44%'],
          label: { formatter: '{b}\n{d}%' },
          data: split.map((x) => ({ name: contentLabel(x.type), value: round2(num(x.gmv)) })),
        },
      ],
    },
    true,
  );
}

function resizeCharts(): void {
  trendChart?.resize();
  shopChart?.resize();
  pieChart?.resize();
}

async function loadShops(): Promise<void> {
  try {
    const rows = await apiGet<{ id: number }[]>('/shops/mine');
    shopCount.value = Array.isArray(rows) ? rows.length : 0;
    shopsLoaded.value = true;
  } catch {
    shopsLoaded.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    summary.value = await apiGet<DashboardSummary>('/dashboard/summary', { days: 30 });
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
  await nextTick();
  initCharts();
  renderCharts();
}

watch([summary, canSeeCost], () => renderCharts());

onMounted(() => {
  void loadShops();
  void load();
  window.addEventListener('resize', resizeCharts);
});

/** 布局用 keep-alive：首次挂载已加载，再次进入时刷新数据并重算画布尺寸 */
let mountedOnce = false;
onActivated(() => {
  if (mountedOnce) {
    nextTick(resizeCharts);
    void load();
  }
  mountedOnce = true;
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeCharts);
  trendChart?.dispose();
  shopChart?.dispose();
  pieChart?.dispose();
  trendChart = null;
  shopChart = null;
  pieChart = null;
});
</script>

<style scoped>
.kpi {
  border-left: 3px solid #409eff;
}
.kpi-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.kpi-label {
  font-size: 12px;
  color: #909399;
}
.kpi-value {
  font-size: 22px;
  font-weight: 600;
  margin: 6px 0 2px;
  color: #303133;
}
.kpi-value.profit {
  color: #c45656;
}
.kpi-sub {
  font-size: 12px;
  color: #a8abb2;
  line-height: 16px;
}
.head-tip {
  font-size: 12px;
  color: #909399;
  margin-left: 8px;
}
.todo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.todo {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 10px 12px;
  cursor: pointer;
  transition: box-shadow 0.2s;
}
.todo:hover {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
}
.todo-count {
  font-size: 24px;
  font-weight: 700;
  min-width: 44px;
  text-align: center;
}
.todo-label {
  font-size: 14px;
  font-weight: 600;
}
.todo-desc {
  font-size: 12px;
  color: #909399;
  line-height: 16px;
}
.todo-arrow {
  margin-left: auto;
  color: #c0c4cc;
}
.todo-danger .todo-count {
  color: #f56c6c;
}
.todo-warning .todo-count {
  color: #e6a23c;
}
.todo-info .todo-count {
  color: #909399;
}
.chart-box {
  height: 300px;
}
</style>
