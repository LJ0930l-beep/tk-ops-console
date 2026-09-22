<template>
  <el-dropdown v-if="canExport" trigger="click" @command="run">
    <el-button :icon="Download" :loading="busy">
      导出<el-icon class="el-icon--right"><ArrowDown /></el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="xlsx">Excel（.xlsx）</el-dropdown-item>
        <el-dropdown-item command="csv">CSV（.csv，Excel 可直接打开）</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
/**
 * 导出按钮：同一份筛选条件，格式二选一（后端 core/export.ts 出 CSV 或流式 XLSX）。
 * params 要传页面当前的查询条件，否则导出的是全量而不是「屏幕上这一屏」。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { ArrowDown, Download } from '@element-plus/icons-vue';
import { apiDownload, errMsg, type ApiPath } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ url: ApiPath; name: string; params?: Record<string, unknown> }>();

const auth = useAuthStore();
/** 没有导出权限就不显示按钮（后端也会 403，这里只是不给人点了才报错的体验） */
const canExport = computed(() => auth.canExport);
const busy = ref(false);

async function run(format: string): Promise<void> {
  busy.value = true;
  try {
    await apiDownload(props.url, { ...(props.params ?? {}), format }, `${props.name}.${format}`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    busy.value = false;
  }
}
</script>
