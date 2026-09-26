<template>
  <div class="creator-stats">
    <div class="stat-grid tk-in">
      <StatCard v-for="c in cards" :key="c.label" :label="c.label" :value="c.value" :sub="c.sub" :tone="c.tone" />
    </div>
    <div v-if="variant === 'outreach'" class="chart-grid">
      <ChartCard title="建联转化漏斗" tip="我可见范围内的达人资产，按建联结果逐级收窄；不随下方表格的筛选变化（接口只按数据范围与周期聚合）" :span="6" :empty="!funnelSteps.length" empty-text="还没有建联记录">
        <div ref="funnelEl" class="chart-host" />
      </ChartCard>
      <ChartCard title="从到达人到出单的链路条数" tip="触达 → 合作单 → 寄样 → 内容 → 订单：哪一段突然变细，就是流程断在哪" :span="6" :empty="!chainSteps.length" empty-text="链路还没有数据">
        <div ref="chainEl" class="chart-host" />
      </ChartCard>
    </div>
    <el-alert v-if="error" type="warning" :closable="false" show-icon class="page-tip" :title="`达人资产合计加载失败：${error}`" description="下面的列表不受影响：合计取的是 /creators/stats。" />
  </div>
</template>

<script setup lang="ts">
/**
 * 达人中心的资产条：寄样 / 合作单 / 建联跟进三页共用。
 *
 * 三页各自拉一次 /creators/stats 再写一遍卡片，是同一份数据的三份拷贝 ——
 * 之前就是这样，改一个指标名要翻三个文件。
 * 注意口径：这个接口只按「数据范围 + period」聚合，**不认表格上的筛选条件**，
 * 所以卡片文案与图上都写清"我可见范围内"，免得被当成"筛完只剩 3 条但卡上写 7"。
 */
import { computed, onMounted, ref } from 'vue';
import { num } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';
import { useChart } from '@/composables/useChart';
import type { ChartOption } from '@/utils/echarts';
import { chartColor, motion } from '@/utils/theme';
import ChartCard from '@/components/ChartCard.vue';
import StatCard from '@/components/StatCard.vue';

interface Stats {
  pool: number;
  private: number;
  cooperating: number;
  blacklist: number;
  new_this_month: number;
  content_published: number;
  protect_expiring: number;
  collab_overdue: number;
  sample_overdue: number;
  to_follow: number;
  funnel: { outreach: number; replied: number; interested: number; agreed: number; creators_contacted: number; collabs: number; samples: number; contents: number; orders: number };
}

const props = withDefaults(defineProps<{ variant?: 'sample' | 'collab' | 'outreach' }>(), { variant: 'collab' });

const stats = ref<Stats | null>(null);
const error = ref('');
const funnelEl = ref<HTMLDivElement>();
const chainEl = ref<HTMLDivElement>();

const cards = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const base = [
    { label: '公海达人', value: num(s.pool), sub: '未认领，谁都可以捞', tone: 'info' as const },
    { label: '私海达人', value: num(s.private), sub: '已认领并在保护期内', tone: 'primary' as const },
    { label: '合作中', value: num(s.cooperating), sub: `本月新增 ${num(s.new_this_month)} 位`, tone: 'success' as const },
  ];
  if (props.variant === 'sample') {
    return [
      ...base,
      { label: '寄样超期未出内容', value: num(s.sample_overdue), sub: '签收后超 7 天没产出内容', tone: s.sample_overdue > 0 ? ('danger' as const) : ('info' as const) },
      { label: '已产出内容', value: num(s.content_published), sub: '寄样换到的视频/直播场次', tone: 'success' as const },
      { label: '待跟进', value: num(s.to_follow), sub: '到 next_follow_at 或保护期将到期', tone: 'warning' as const },
    ];
  }
  if (props.variant === 'collab') {
    return [
      ...base,
      { label: '合作单超期未履约', value: num(s.collab_overdue), sub: '夜间作业置为「超期未履约」', tone: s.collab_overdue > 0 ? ('danger' as const) : ('info' as const) },
      { label: '已产出内容', value: num(s.content_published), sub: '合作单真正换来的东西', tone: 'success' as const },
      { label: '待跟进', value: num(s.to_follow), sub: '保护期 7 天内到期也要跟', tone: 'warning' as const },
    ];
  }
  return [
    ...base,
    { label: '待跟进', value: num(s.to_follow), sub: '到 next_follow_at 该联系的人了', tone: s.to_follow > 0 ? ('warning' as const) : ('info' as const) },
    { label: '保护期将到期', value: num(s.protect_expiring), sub: '到期不跟进就回公海', tone: 'warning' as const },
    { label: '黑名单', value: num(s.blacklist), sub: '不再建联', tone: 'danger' as const },
  ];
});

const funnelSteps = computed(() => {
  const f = stats.value?.funnel;
  if (!f) return [];
  return [
    { label: '建联记录', value: num(f.outreach) },
    { label: '有回复', value: num(f.replied) },
    { label: '有意向', value: num(f.interested) },
    { label: '谈妥', value: num(f.agreed) },
  ].filter((x, i) => x.value > 0 || i === 0);
});

const chainSteps = computed(() => {
  const f = stats.value?.funnel;
  if (!f) return [];
  return [
    { label: '触达达人', value: num(f.creators_contacted) },
    { label: '合作单', value: num(f.collabs) },
    { label: '寄样', value: num(f.samples) },
    { label: '内容', value: num(f.contents) },
    { label: '订单', value: num(f.orders) },
  ];
});

function funnelOption(): ChartOption | null {
  const steps = funnelSteps.value;
  if (!steps.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    color: [chartColor.primary(), '#5a8ee6', '#83aee9', '#a7c4ee'],
    series: [
      {
        type: 'funnel',
        left: '6%',
        right: '6%',
        top: 10,
        bottom: 10,
        minSize: '24%',
        gap: 3,
        label: { position: 'inside', color: '#fff', fontSize: 12, formatter: '{b} {c}' },
        data: steps.map((s) => ({ name: s.label, value: s.value })),
      },
    ],
  };
}

function chainOption(): ChartOption | null {
  const steps = chainSteps.value;
  if (!steps.length) return null;
  return {
    ...motion(),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 44, right: 20, top: 16, bottom: 26 },
    xAxis: { type: 'category', data: steps.map((s) => s.label), axisLabel: { fontSize: 11, interval: 0 } },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        type: 'bar',
        barMaxWidth: 34,
        itemStyle: { color: chartColor.primary(), borderRadius: [3, 3, 0, 0] },
        label: { show: true, position: 'top', fontSize: 11 },
        data: steps.map((s) => s.value),
      },
    ],
  };
}

useChart(funnelEl, funnelOption, [stats]);
useChart(chainEl, chainOption, [stats]);

async function load(): Promise<void> {
  try {
    stats.value = await apiGet<Stats>('/creators/stats');
    error.value = '';
  } catch (e) {
    stats.value = null;
    error.value = errMsg(e);
  }
}

onMounted(() => void load());
</script>

<style scoped>
.creator-stats :deep(.stat-grid) {
  margin-bottom: var(--tk-s4);
}
</style>
