<template>
  <el-card
    shadow="never"
    class="stat"
    :class="[`tone-${tone}`, { 'tk-lift': Boolean(to) }]"
    @click="goto"
  >
    <div class="stat-head">
      <span class="stat-label">{{ label }}</span>
      <slot name="extra">
        <el-tag v-if="masked" size="small" type="info">需金额权限</el-tag>
      </slot>
    </div>
    <div class="stat-value" :class="{ 'is-money': money }">
      <span class="tk-num">{{ text }}</span
      ><span v-if="suffix" class="stat-suffix">{{ suffix }}</span>
    </div>
    <div v-if="sub || delta !== undefined" class="stat-foot">
      <span v-if="delta !== undefined && delta !== null" class="stat-delta" :class="Number(delta) >= 0 ? 'up' : 'down'">
        <el-icon size="12"><component :is="Number(delta) >= 0 ? Top : Bottom" /></el-icon>
        {{ (Math.abs(Number(delta)) * 100).toFixed(1) }}%
      </span>
      <span v-if="sub" class="stat-sub">{{ sub }}</span>
    </div>
  </el-card>
</template>

<script setup lang="ts">
/**
 * 指标卡：数值可选地滚动到位（count-up）。
 *
 * 为什么要滚：一屏八九张卡同时刷新，数字硬跳的话眼睛跟不上"哪个变了"；
 * 从旧值补间到新值，变化本身就变成可读信息。为什么只滚 0.5 秒：
 * 后台系统天天看，超过这个数就从"提示变化"变成"让人等"。
 * 系统开了「减少动态效果」时直接落终值。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Bottom, Top } from '@element-plus/icons-vue';

const props = withDefaults(
  defineProps<{
    label: string;
    /** 给数字才滚动；给字符串（"***"、"—"、"12/34"）原样显示 */
    value: number | string | null | undefined;
    sub?: string;
    /** 环比：0.12 = +12% */
    delta?: number | null;
    tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
    suffix?: string;
    precision?: number;
    money?: boolean;
    masked?: boolean;
    to?: string;
    query?: Record<string, string>;
  }>(),
  { tone: 'primary', money: false, masked: false },
);

const router = useRouter();
const target = computed(() => (typeof props.value === 'number' && Number.isFinite(props.value) ? props.value : null));
const shown = ref(0);
let raf = 0;

const fmt = (n: number): string => {
  const dec = props.precision ?? (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
const text = computed(() => (target.value === null ? String(props.value ?? '—') : fmt(shown.value)));

watch(
  target,
  (to, from) => {
    if (to === null) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const start = from ?? 0;
    if (reduce || start === to || Math.abs(to - start) < 0.005) {
      shown.value = to;
      return;
    }
    cancelAnimationFrame(raf);
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / 520);
      const eased = 1 - Math.pow(1 - p, 3);
      shown.value = start + (to - start) * eased;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  },
  { immediate: true },
);

onUnmounted(() => cancelAnimationFrame(raf));

function goto(): void {
  if (props.to) void router.push({ path: props.to, query: props.query });
}
</script>

<style scoped>
.stat {
  border-left: 3px solid var(--tk-primary);
  overflow: hidden;
}
.stat :deep(.el-card__body) {
  padding: var(--tk-s3) var(--tk-s4);
}
.tone-success {
  border-left-color: var(--tk-success);
}
.tone-warning {
  border-left-color: var(--tk-warning);
}
.tone-danger {
  border-left-color: var(--tk-danger);
}
.tone-info {
  border-left-color: var(--tk-faint);
}
.stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tk-s2);
}
.stat-label {
  font-size: 12px;
  color: var(--tk-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-value {
  display: flex;
  align-items: baseline;
  font-size: 23px;
  font-weight: 600;
  line-height: 1.3;
  margin: 6px 0 2px;
  color: var(--tk-ink);
}
.stat-value.is-money {
  color: var(--tk-money);
}
.stat-suffix {
  font-size: 12px;
  font-weight: 400;
  color: var(--tk-muted);
  margin-left: 3px;
}
.stat-foot {
  display: flex;
  align-items: center;
  gap: var(--tk-s2);
  min-height: 16px;
}
.stat-delta {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: 12px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: var(--tk-r-sm);
}
.stat-delta.up {
  color: var(--tk-success);
  background: #f0f9eb;
}
.stat-delta.down {
  color: var(--tk-danger);
  background: #fef0f0;
}
.stat-sub {
  font-size: 12px;
  color: var(--tk-faint);
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
