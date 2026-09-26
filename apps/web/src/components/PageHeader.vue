<template>
  <div class="page-head">
    <div class="ph-icon" :style="{ background: tint }">
      <el-icon size="18"><component :is="icon ?? PageF" /></el-icon>
    </div>
    <div class="ph-text">
      <div class="ph-title">
        {{ title }}
        <slot name="tag" />
      </div>
      <div v-if="sub" class="ph-sub">{{ sub }}</div>
    </div>
    <div class="ph-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 页头。存在的理由是「口径说明该放哪」：
 * 以前每页把两三百字的口径解释塞进第一张卡的灰色小字里，读的人要么跳过要么被淹没。
 * 这里给它一个固定位置（标题下方一行，超长省略、鼠标悬停看全），
 * 于是下面的卡片可以只讲数据。
 */
import { Files as PageF } from '@element-plus/icons-vue';

withDefaults(
  defineProps<{
    title: string;
    /** 一句话口径说明 */
    sub?: string;
    icon?: object;
    /** 图标底色，默认跟着主色 */
    tint?: string;
  }>(),
  { tint: 'var(--tk-primary)' },
);
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  gap: var(--tk-s3);
  background: var(--tk-surface);
  border: 1px solid var(--tk-line);
  border-radius: var(--tk-r-md);
  box-shadow: var(--tk-shadow-1);
  padding: var(--tk-s3) var(--tk-s4);
  margin-bottom: var(--tk-s4);
  animation: tk-fade-up var(--tk-dur) var(--tk-ease) both;
}
.ph-icon {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--tk-r-md);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ph-text {
  min-width: 0;
  flex: 1;
}
.ph-title {
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  color: var(--tk-ink);
}
.ph-sub {
  font-size: 12px;
  color: var(--tk-muted);
  line-height: 18px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--tk-s2);
}
</style>
