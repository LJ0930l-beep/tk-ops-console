<template>
  <div class="page" v-loading="loading">
    <PageHeader title="经营看板" :sub="caliberTip">
      <template #tag>
        <el-tag v-if="noShop" size="small" type="warning">无可见店铺</el-tag>
      </template>
      <template #actions>
        <el-radio-group v-model="days" size="small" @change="() => void load()">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="() => void load()">刷新</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="num(summary?.sync_failed) > 0"
      type="error"
      :closable="false"
      show-icon
      class="page-card tk-in"
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

    <!-- KPI 指标卡：数字滚动到位，一屏同时刷新时眼睛才知道哪个变了 -->
    <div class="stat-grid tk-in">
      <StatCard
        v-for="k in kpiCards"
        :key="k.label"
        :label="k.label"
        :value="k.value"
        :sub="k.sub"
        :delta="k.delta"
        :tone="k.tone"
        :money="k.money"
        :masked="k.masked"
        :precision="k.precision"
      />
    </div>

    <!-- 待办清单 -->
    <el-card class="page-card" shadow="never">
      <template #header><b>待办清单</b><span class="head-tip">点击卡片直达对应列表页并带上筛选条件</span></template>
      <div class="todo-grid tk-in">
        <div v-for="t in todoCards" :key="t.label" class="todo" :class="`todo-${t.level}`" @click="goto(t.path, t.query)">
          <div class="todo-count tk-num">{{ t.count }}</div>
          <div class="todo-body">
            <div class="todo-label">{{ t.label }}</div>
            <div class="todo-desc">{{ t.desc }}</div>
          </div>
          <el-icon class="todo-arrow"><ArrowRight /></el-icon>
        </div>
      </div>
    </el-card>

    <!-- 趋势 + 广告打平 -->
    <div class="chart-grid">
      <ChartCard title="带货 GMV / 日净利 / 订单趋势" :tip="trendTip" :span="8" :empty="!trend.length" empty-text="所选周期内没有成交">
        <div ref="trendEl" class="chart-host" />
      </ChartCard>
      <ChartCard title="广告投放离打平还差多少" :tip="gaugeTip" :span="4" height="240px" :empty="!gaugeDrawable" :empty-text="canSeeCost ? '没有广告消耗，或毛利非正 —— 画不出打平线' : '需金额权限'">
        <div ref="gaugeEl" class="chart-host" />
      </ChartCard>
    </div>

    <!-- 成交热力 + 内容占比 -->
    <div class="chart-grid">
      <ChartCard title="成交热力（一天一块，颜色越深带货 GMV 越高）" tip="看周期性：大促日、周末、断货日都会在这里露出来" :span="8" height="210px" :empty="!trend.length">
        <div ref="heatEl" class="chart-host" />
      </ChartCard>
      <ChartCard title="内容带货类型占比" :span="4" :empty="!split.length" empty-text="暂无内容归因数据">
        <div ref="pieEl" class="chart-host" />
      </ChartCard>
    </div>

    <!-- 店铺榜 + 达人榜 -->
    <div class="chart-grid">
      <ChartCard title="店铺带货 GMV Top 榜" tip="返点按 SKU 的返点率算，榜单只比带货规模" :span="6" :empty="!shopTop.length" empty-text="没有店铺汇总数据">
        <template #actions><el-button link type="primary" size="small" @click="goto('/orders')">看订单</el-button></template>
        <div ref="shopEl" class="chart-host" />
      </ChartCard>
      <ChartCard title="达人带货 Top 榜" tip="排名按带货 GMV（品牌的生意）；「有效返点率」才是我们这单能拿到的比例，投产比去达人 ROI 页看" :span="6">
        <template #actions><el-button link type="primary" size="small" @click="goto('/creators/roi')">达人 ROI</el-button></template>
        <el-table :data="summary?.creator_rank ?? []" size="small" border stripe :max-height="264" empty-text="暂无归因到达人的成交">
          <el-table-column type="index" label="#" width="46" />
          <el-table-column prop="handle" label="达人" min-width="110" show-overflow-tooltip>
            <template #default="{ row }">@{{ row.handle }}</template>
          </el-table-column>
          <el-table-column prop="gmv" label="带货 GMV(参考)" width="118" align="right">
            <template #default="{ row }"><span class="tk-num">{{ money(row.gmv) }}</span></template>
          </el-table-column>
          <el-table-column prop="orders" label="订单" width="66" align="right" />
          <el-table-column v-if="canSeeCost" prop="rebate" label="应收返点" width="108" align="right">
            <template #default="{ row }"><span class="tk-num money-cny">{{ mask(row.rebate) }}</span></template>
          </el-table-column>
          <el-table-column v-if="canSeeCost" label="有效返点率" width="150">
            <template #header>
              <el-tooltip content="返点 ÷ 带货 GMV。低于 SKU 名义返点率，说明这个达人带的货里低返点的款占多了。投产比（返点 ÷ 我们掏的钱）只有一个出处：达人 ROI 页。" placement="top">
                <span>有效返点率 <el-icon size="12"><QuestionFilled /></el-icon></span>
              </el-tooltip>
            </template>
            <template #default="{ row }">
              <span v-if="!(num(row.rebate) > 0 && num(row.gmv) > 0)" class="mask">—</span>
              <el-progress
                v-else
                :percentage="Math.min(100, (num(row.rebate) / num(row.gmv)) * 200)"
                :format="() => `${((num(row.rebate) / num(row.gmv)) * 100).toFixed(1)}%`"
                :stroke-width="12"
                :color="primary()"
              />
            </template>
          </el-table-column>
        </el-table>
      </ChartCard>
    </div>

    <!-- BD 榜 -->
    <el-card shadow="never">
      <template #header><b>BD 建联榜</b><span class="head-tip">谈妥率画成条：光看「谈妥 2 / 跟进 20」和「谈妥 2 / 跟进 3」不是一回事</span></template>
      <el-table :data="summary?.bd_rank ?? []" size="small" border stripe empty-text="暂无建联记录">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="real_name" label="BD" min-width="120" />
        <el-table-column prop="outreach" label="跟进数" width="100" align="right" />
        <el-table-column prop="agreed" label="谈妥数" width="100" align="right" />
        <el-table-column label="谈妥率" width="190">
          <template #default="{ row }">
            <el-progress
              :percentage="num(row.outreach) > 0 ? Math.round((num(row.agreed) / num(row.outreach)) * 100) : 0"
              :stroke-width="10"
              :color="primary()"
              :format="() => (num(row.outreach) > 0 ? `${((num(row.agreed) / num(row.outreach)) * 100).toFixed(1)}%` : '—')"
            />
          </template>
        </el-table-column>
        <el-table-column prop="gmv" label="带货 GMV" width="140" align="right">
          <template #default="{ row }"><span class="tk-num">{{ money(row.gmv) }}</span></template>
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
/**
 * 经营看板。
 *
 * 这轮加的图守一条：只画接口已经算好的全量聚合，绝不拿"当前一页 20 行"当总体。
 *   - 成交热力：gmv_trend 本来就是逐日的。折线看走向、热力看周期性（大促日 / 断货日一眼认得出）
 *   - 打平仪表：把"广告还能不能加"直接答掉。打平线 = 1 ÷ 占 GMV 的贡献毛利率，
 *     与规则引擎 ADS_LOSS 同一个算法（PRD §5.4「毛利率的分母」），不在前端另立口径。
 *
 * 页头那句说明是刻意占位而不是塞进卡片的灰字：这页有两个同名不同分母的"毛利率"
 * —— 接口的 est_profit_rate 是「每 1 元返点留下多少」，打平线要的是「每 1 元 GMV 留下多少」。
 * 不写清楚，一定有人当成数据错了去查后端。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowRight, QuestionFilled, Refresh } from '@element-plus/icons-vue';
import type { DashboardSummary } from '@tk/shared';
import { CONTENT_TYPE, MASK, SAMPLE_STATUS, adRoi, breakevenRoas, num, round2 } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';
import ChartCard from '@/components/ChartCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';

const router = useRouter();
const auth = useAuthStore();

const summary = ref<DashboardSummary | null>(null);
const loading = ref(false);
const days = ref(30);
const shopCount = ref(0);
const shopsLoaded = ref(false);

const trendEl = ref<HTMLDivElement>();
const heatEl = ref<HTMLDivElement>();
const gaugeEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();
const shopEl = ref<HTMLDivElement>();

/** 图表配色与 CSS 令牌同源，不在这里再抄一份 hex */
const primary = chartColor.primary;
const good = chartColor.success;
const danger = chartColor.danger;
const muted = chartColor.muted;

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

const trend = computed(() => summary.value?.gmv_trend ?? []);
const split = computed(() => summary.value?.content_type_split ?? []);
const shopTop = computed(() => (summary.value?.shop_rank ?? []).slice(0, 10));
const netGmv = computed(() => round2(num(summary.value?.gmv) - num(summary.value?.refund_amount)));

/**
 * 环比 = 末 7 天对前 7 天。不满 14 天、或前一段为 0，就不给这个箭头 ——
 * 宁可少一个标记，也不要给出"涨了 340%"其实是前天 1 单今天 4 单的那种数。
 */
function wow(pick: (row: { gmv: number; orders: number; profit: number }) => number): number | null {
  const t = trend.value;
  if (t.length < 14) return null;
  const sum = (arr: { gmv: number; orders: number; profit: number }[]) => arr.reduce((s, r) => s + num(pick(r)), 0);
  const prev = sum(t.slice(-14, -7));
  return prev > 0 ? (sum(t.slice(-7)) - prev) / prev : null;
}

/** 占 GMV 的贡献毛利率：这是能换算成盈亏平衡 ROAS 的那个分母（PRD §5.4） */
const marginOnGmv = computed(() => (netGmv.value > 0 ? num(summary.value?.est_gross_profit) / netGmv.value : 0));
const breakEvenRoas = computed(() => breakevenRoas(marginOnGmv.value));
const adRoiNow = computed(() => {
  const s = summary.value;
  if (!s || !canSeeCost.value) return null;
  return s.ad_roi ?? adRoi(num(s.ad_spend), num(s.ad_gmv));
});
const gaugeDrawable = computed(() => breakEvenRoas.value !== null && adRoiNow.value !== null);

const gaugeTip = computed(() => {
  const be = breakEvenRoas.value;
  if (be === null) return '毛利非正：广告怎么投都是亏';
  return `打平线 ROAS ${be.toFixed(2)}（= 1 ÷ 占 GMV 的贡献毛利率 ${(marginOnGmv.value * 100).toFixed(1)}%）`;
});

/**
 * 趋势图的绿线是**日净利**（返点 − 物流 − 佣金 − 广告 − 公共费用），
 * 不是指标卡上那个不含广告的"预估贡献毛利"。接口里这一列就叫 profit，
 * 之前图例直接写成"预估贡献毛利"，于是同页两个数打架 —— 名字必须分开。
 */
const trendTip = '按店铺站点时区切日（PRD §5.5）。绿线是日净利 = 贡献毛利再扣掉广告与公共费用，和上面「预估贡献毛利」那张卡不是同一个数';

const caliberTip = computed(() => {
  const s = summary.value;
  if (!s) return '收入只有品牌返点：贡献毛利 = 应收返点 − 物流 − 达人佣金，货款与货值都在品牌那边';
  const perRebate = canSeeCost.value ? pctText(s.est_profit_rate) : MASK;
  const perGmv = netGmv.value > 0 ? `${(marginOnGmv.value * 100).toFixed(2)}%` : MASK;
  return `贡献毛利 ${mask(s.est_gross_profit)}：每 1 元返点里留下 ${perRebate}，每 1 元带货 GMV 里留下 ${perGmv} —— 两个都叫毛利率、分母不同，广告侧只看后者`;
});

interface Kpi {
  label: string;
  value: number | string;
  sub: string;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  money?: boolean;
  masked?: boolean;
  delta?: number | null;
  precision?: number;
}
const kpiCards = computed<Kpi[]>(() => {
  const s = summary.value;
  const roi = adRoiNow.value;
  const be = breakEvenRoas.value;
  const gross = num(s?.est_gross_profit);
  return [
    {
      label: '带货 GMV（净）',
      value: netGmv.value,
      sub: `退款率 ${pctText(s?.refund_rate)}，退款 ${money(s?.refund_amount)}｜GMV 是品牌的生意`,
      tone: 'info',
      money: true,
      delta: wow((r) => r.gmv),
      precision: 2,
    },
    { label: '订单数', value: num(s?.orders), sub: '非取消、非样品单', tone: 'primary', delta: wow((r) => r.orders) },
    {
      label: '应收返点（我们的收入）',
      value: canSeeCost.value ? num(s?.est_rebate) : MASK,
      sub: '实收 GMV × 品牌返点率；不含货款，货款是品牌垫的',
      tone: 'success',
      money: true,
      masked: !canSeeCost.value,
      precision: 2,
    },
    {
      label: '预估贡献毛利',
      value: canSeeCost.value ? gross : MASK,
      sub: `物流 ${mask(s?.est_logistics)}｜毛利率分母见页头`,
      tone: gross < 0 ? 'danger' : 'success',
      money: true,
      masked: !canSeeCost.value,
      precision: 2,
    },
    {
      label: '实际到账',
      value: canSeeCost.value ? num(s?.settled_amount) : MASK,
      sub: '平台打款结算流水折算（带货口径，不等于我们的收入）',
      tone: 'info',
      money: true,
      masked: !canSeeCost.value,
      precision: 2,
    },
    {
      label: '广告 ROAS',
      value: roi === null ? (canSeeCost.value ? '—' : MASK) : round2(roi),
      sub: be === null ? `消耗 ${mask(s?.ad_spend)}｜毛利非正，无打平线` : `消耗 ${mask(s?.ad_spend)}｜打平线 ${be.toFixed(2)}`,
      tone: roi === null || be === null ? 'info' : roi >= be ? 'success' : 'danger',
      precision: 2,
    },
    { label: '今日直播', value: num(s?.live_today), sub: '今日「已排班」场次数', tone: 'primary' },
  ];
});

type TodoLevel = 'danger' | 'warning' | 'info';
const todoCards = computed(() => {
  const s = summary.value;
  const item = (label: string, count: number, desc: string, path: string, query: Record<string, string>, level: TodoLevel) => ({
    label,
    count: int(count),
    desc,
    path,
    query,
    level,
  });
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

/* ==================== 图表 ==================== */
function trendOption(): ChartOption | null {
  const t = trend.value;
  if (!t.length) return null;
  const showProfit = canSeeCost.value;
  return {
    ...motion(),
    tooltip: { trigger: 'axis' },
    legend: { data: showProfit ? ['带货GMV', '订单数', '日净利(含广告)'] : ['带货GMV', '订单数'], top: 0 },
    grid: { left: 60, right: 60, top: 42, bottom: 24 },
    xAxis: { type: 'category', data: t.map((x) => String(x.date ?? '').slice(5)), boundaryGap: false },
    yAxis: [
      { type: 'value', name: '金额(CNY)', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
      { type: 'value', name: '订单数', splitLine: { show: false } },
    ],
    series: [
      { name: '带货GMV', type: 'line', smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 }, data: t.map((x) => round2(num(x.gmv))) },
      /** 没有金额权限时这条线整个不进 option —— 只从 legend 里去掉、线还画着，等于漏数 */
      ...(showProfit
        ? [{ name: '日净利(含广告)', type: 'line', smooth: true, showSymbol: false, data: t.map((x) => round2(num(x.profit))) }]
        : []),
      { name: '订单数', type: 'bar', yAxisIndex: 1, barMaxWidth: 14, itemStyle: { color: good(), opacity: 0.55 }, data: t.map((x) => num(x.orders)) },
    ],
  };
}

/**
 * 打平仪表：轴线上「红段到打平线、绿段到顶」本身就是答案，
 * 不再另画参考线 —— 指针落在哪个色段比读数快得多。
 */
function gaugeOption(): ChartOption | null {
  const be = breakEvenRoas.value;
  const roi = adRoiNow.value;
  if (be === null || roi === null) return null;
  const max = Math.max(be * 1.6, roi * 1.2, 1);
  return {
    ...motion(),
    series: [
      {
        type: 'gauge',
        min: 0,
        max: round2(max),
        startAngle: 210,
        endAngle: -30,
        radius: '96%',
        center: ['50%', '60%'],
        splitNumber: 4,
        axisLine: { lineStyle: { width: 13, color: [[Math.min(0.999, be / max), danger()], [1, good()]] } },
        progress: { show: true, width: 13, roundCap: true, itemStyle: { color: roi >= be ? good() : danger() } },
        axisTick: { distance: -19, length: 4, lineStyle: { color: muted(), width: 1 } },
        splitLine: { distance: -20, length: 8, lineStyle: { color: muted(), width: 1 } },
        axisLabel: { distance: 15, fontSize: 10, color: muted(), formatter: (v: number) => v.toFixed(0) },
        pointer: { length: '56%', width: 5, itemStyle: { color: 'auto' } },
        anchor: { show: true, size: 10, itemStyle: { color: 'auto' } },
        title: { offsetCenter: [0, '34%'], fontSize: 12, color: muted() },
        detail: { offsetCenter: [0, '-14%'], fontSize: 26, fontWeight: 700, valueAnimation: true, formatter: (v: number) => v.toFixed(2), color: chartColor.ink() },
        data: [{ value: round2(roi), name: `实际 ROAS ｜ 打平线 ${be.toFixed(2)}` }],
      },
    ],
  };
}

function heatOption(): ChartOption | null {
  const t = trend.value;
  if (!t.length) return null;
  const data = t.map((x) => [String(x.date), round2(num(x.gmv))] as [string, number]);
  const max = Math.max(...data.map((d) => d[1]), 1);
  return {
    ...motion(),
    tooltip: { formatter: (p: { value: [string, number] }) => `${p.value[0]}<br/>带货 GMV ${money(p.value[1])}` },
    visualMap: {
      min: 0,
      max,
      right: 8,
      top: 'middle',
      itemWidth: 10,
      itemHeight: 80,
      text: ['高', '低'],
      textStyle: { color: muted(), fontSize: 11 },
      inRange: { color: ['#ecf5ff', '#a0cfff', primary(), '#1d5fd0'] },
    },
    calendar: {
      top: 30,
      left: 38,
      right: 58,
      bottom: 8,
      /** 两个方向都 auto：写死 18 会让 210px 的卡下面空一条白 —— 格子必须把高度吃满 */
      cellSize: ['auto', 'auto'],
      range: [data[0][0], data[data.length - 1][0]],
      itemStyle: { borderWidth: 2, borderColor: '#fff' },
      splitLine: { show: false },
      dayLabel: { color: muted(), fontSize: 10, nameMap: 'ZH' },
      monthLabel: { color: muted(), fontSize: 10, nameMap: 'ZH' },
      yearLabel: { show: false },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
  };
}

function pieOption(): ChartOption | null {
  const s = split.value;
  if (!s.length) return null;
  const total = round2(s.reduce((acc, x) => acc + num(x.gmv), 0));
  return {
    ...motion(),
    tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    /**
     * 这张卡在 4 栏宽（约 330px）里，扇区外标签一定会被裁成"…"。
     * 所以名字交给底部 legend，圆心放总数 —— 窄卡上不硬塞外部标签。
     */
    title: {
      text: `${round2(total / 10000)}万`,
      subtext: '带货 GMV 合计',
      left: 'center',
      top: '34%',
      textStyle: { fontSize: 18, fontWeight: 700, color: chartColor.ink() },
      subtextStyle: { fontSize: 11, color: muted() },
    },
    legend: { bottom: 0, left: 'center', icon: 'circle', itemWidth: 8, itemHeight: 8, type: 'scroll', textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['46%', '66%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: s.map((x) => ({ name: contentLabel(x.type), value: round2(num(x.gmv)) })),
      },
    ],
  };
}

function shopOption(): ChartOption | null {
  const rank = shopTop.value;
  if (!rank.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 100, right: 58, top: 16, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${round2(num(v) / 10000)}万` } },
    yAxis: { type: 'category', data: rank.map((r) => r.shop_name).reverse(), axisLabel: { width: 90, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: primary(), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', fontSize: 11, formatter: (p: { value: number }) => `${round2(num(p.value) / 10000)}万` },
        data: rank.map((r) => round2(num(r.gmv))).reverse(),
      },
    ],
  };
}

useChart(trendEl, trendOption, [summary, canSeeCost, days]);
useChart(heatEl, heatOption, [summary, days]);
useChart(gaugeEl, gaugeOption, [summary, canSeeCost, days]);
useChart(pieEl, pieOption, [summary, days]);
useChart(shopEl, shopOption, [summary, days]);

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
    summary.value = await apiGet<DashboardSummary>('/dashboard/summary', { days: days.value });
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadShops();
  void load();
});
</script>

<style scoped>
.todo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--tk-gap);
}
.todo {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--tk-line);
  border-left: 3px solid var(--tk-faint);
  border-radius: var(--tk-r-md);
  padding: 10px 12px;
  cursor: pointer;
  background: var(--tk-surface);
  transition: box-shadow var(--tk-dur) var(--tk-ease), transform var(--tk-dur) var(--tk-ease);
}
.todo:hover {
  box-shadow: var(--tk-shadow-2);
  transform: translateY(-2px);
}
.todo-count {
  font-size: 24px;
  font-weight: 700;
  min-width: 44px;
  text-align: center;
  color: var(--tk-ink-2);
}
.todo-label {
  font-size: 14px;
  font-weight: 600;
}
.todo-desc {
  font-size: 12px;
  color: var(--tk-muted);
  line-height: 16px;
}
.todo-arrow {
  margin-left: auto;
  color: var(--tk-faint);
  transition: transform var(--tk-dur) var(--tk-ease);
}
.todo:hover .todo-arrow {
  transform: translateX(3px);
}
.todo-danger {
  border-left-color: var(--tk-danger);
}
.todo-danger .todo-count {
  color: var(--tk-danger);
}
.todo-warning {
  border-left-color: var(--tk-warning);
}
.todo-warning .todo-count {
  color: var(--tk-warning);
}
.todo-info .todo-count {
  color: var(--tk-muted);
}
</style>
