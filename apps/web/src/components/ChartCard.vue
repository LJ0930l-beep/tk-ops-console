<template>
  <el-card shadow="never" class="chart-card" :style="{ gridColumn: `span ${span}` }">
    <template #header>
      <div class="cc-head">
        <span class="cc-title">
          <b>{{ title }}</b>
          <span v-if="tip" class="head-tip" :title="tip">{{ tip }}</span>
        </span>
        <span class="cc-actions"><slot name="actions" /></span>
      </div>
    </template>
    <div v-show="!empty" class="cc-body" :style="{ height }">
      <slot />
    </div>
    <el-empty v-if="empty" :image-size="56" :description="emptyText" class="cc-empty" :style="{ minHeight: height }" />
  </el-card>
</template>

<script setup lang="ts">
/**
 * 图表卡：标题 + 口径说明 + 操作 + 空态，包一层固定的容器高度。
 *
 * 高度必须由 props 给死而不是靠内容撑：echarts 需要容器有确定尺寸才画得出来，
 * 之前有个页面把 .chart-box 的高度又在 scoped 里写了一遍（和全局那份 300px 撞车），
 * 改一处另一处不生效。现在整张卡只有这一处高度说法。
 * 空态用 v-show 而不是 v-if 留容器 —— 否则数据回来后 DOM 节点换了，图得重建。
 */
withDefaults(
  defineProps<{
    title: string;
    /** 口径说明：这张图按什么算的，一句话 */
    tip?: string;
    /** 12 栏栅格里占几栏 */
    span?: number;
    height?: string;
    empty?: boolean;
    emptyText?: string;
  }>(),
  { span: 12, height: '300px', empty: false, emptyText: '所选条件下没有数据' },
);
</script>

<style scoped>
.chart-card :deep(.el-card__body) {
  padding: var(--tk-s2) var(--tk-s3) var(--tk-s3);
}
.cc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tk-s3);
}
.cc-title {
  min-width: 0;
  overflow: hidden;
}
.cc-title .head-tip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.cc-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--tk-s2);
}
.cc-body {
  width: 100%;
}
</style>
