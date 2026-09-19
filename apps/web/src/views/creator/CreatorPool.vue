<template>
  <div class="page">
    <el-alert
      class="page-tip"
      type="info"
      show-icon
      :closable="false"
      title="公海 = 未分配归属的达人资产，防撞单：认领后进入「我的达人」，保护期默认 30 天；逾期未跟进将被夜间作业自动退回公海。"
    />
    <ResourcePage
      ref="rp"
      api="/creators"
      title="达人"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :extra-query="extraQuery"
      :createable="true"
      :editable="true"
      :deletable="false"
      :can-write="true"
      :map-row="mapRow"
      :before-submit="beforeSubmit"
      :action-width="150"
    >
      <template #toolbar-extra>
        <ImportDialog table="creator" button-text="导入达人（表格/抓取）" @done="rp?.reload()" />
      </template>
      <template #actions="{ row, reload }">
        <el-button link type="primary" size="small" :loading="claiming === Number(row.id)" @click="claim(row, reload)">认领</el-button>
        <el-popconfirm title="加入黑名单后该达人不再参与认领，确认？" @confirm="blacklist(row, reload)">
          <template #reference><el-button link type="danger" size="small">黑名单</el-button></template>
        </el-popconfirm>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { POOL_STATUS, normalizeHandle } from '@tk/shared';
import { apiPost, errMsg } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import ImportDialog from '@/components/ImportDialog.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useDictStore } from '@/stores/dict';

const dict = useDictStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);
const claiming = ref(0);

/** 公海筛选：pool_status = 1（PRD §3.5） */
const extraQuery = { pool_status: POOL_STATUS.PUBLIC };

const poolOptions: OptionDef[] = [
  { value: POOL_STATUS.PUBLIC, label: '公海', type: 'info' },
  { value: POOL_STATUS.PRIVATE, label: '私海', type: 'success' },
  { value: POOL_STATUS.COOPERATING, label: '合作中', type: 'primary' },
  { value: POOL_STATUS.BLACKLIST, label: '黑名单', type: 'danger' },
];
const sourceOptions: OptionDef[] = [
  { value: 1, label: '联盟广场', type: 'primary' },
  { value: 2, label: 'TikTok 搜索', type: 'success' },
  { value: 3, label: '达人申样', type: 'warning' },
  { value: 4, label: '机构推荐', type: 'info' },
];

const regionOptions = computed<OptionDef[]>(() => (dict.cache.region ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));
const tagOptions = computed<OptionDef[]>(() => (dict.cache.creator_tag ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));
const levelOptions = computed<OptionDef[]>(() => (dict.cache.gmv_level ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', type: 'text', placeholder: 'handle / 昵称 模糊' },
  { key: 'region', label: '站点', type: 'select', dictType: 'region', options: regionOptions.value },
  { key: 'category_tags', label: '类目标签', type: 'select', dictType: 'creator_tag', options: tagOptions.value },
  { key: 'gmv_level', label: '带货力', type: 'select', dictType: 'gmv_level', options: levelOptions.value },
  { key: 'source', label: '来源', type: 'select', options: sourceOptions },
  { key: 'followers_min', label: '粉丝数≥', type: 'text', placeholder: '如 10000' },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'handle', label: '达人 handle', width: 170 },
  { prop: 'nickname', label: '昵称', width: 150 },
  { prop: 'region', label: '站点', width: 70 },
  { prop: 'followers_text', label: '粉丝数', width: 110 },
  { prop: 'avg_views', label: '均播放', width: 100 },
  { prop: 'category_tags', label: '类目标签', minWidth: 150 },
  { prop: 'gmv_level', label: '带货力', width: 110 },
  { prop: 'email', label: '邮箱', width: 180 },
  { prop: 'whatsapp', label: 'WhatsApp', width: 150 },
  { prop: 'pool_status', label: '池状态', width: 90, type: 'tag', options: poolOptions },
  { prop: 'source', label: '来源', width: 110, type: 'tag', options: sourceOptions },
  { prop: 'created_at', label: '入库时间', type: 'datetime', width: 145 },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'handle', label: 'handle', required: true, disabledOnEdit: true, span: 12, placeholder: '@gadgetgabe（自动小写去 @）' },
  { key: 'nickname', label: '昵称', span: 12 },
  { key: 'region', label: '站点', type: 'select', dictType: 'region', options: regionOptions.value, span: 12 },
  { key: 'source', label: '来源', type: 'select', options: sourceOptions, default: 1, span: 12 },
  { key: 'followers', label: '粉丝数', type: 'number', min: 0, precision: 0, default: 0, span: 12 },
  { key: 'avg_views', label: '均播放', type: 'number', min: 0, precision: 0, default: 0, span: 12 },
  { key: 'category_tags', label: '类目标签', span: 12, placeholder: '多个用英文逗号分隔，如 3C数码,家居生活' },
  { key: 'gmv_level', label: '带货力', type: 'select', dictType: 'gmv_level', options: levelOptions.value, span: 12 },
  { key: 'email', label: '邮箱', span: 12, placeholder: 'name@example.com' },
  { key: 'whatsapp', label: 'WhatsApp', span: 12, placeholder: '国际号，含国家码' },
]);

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const f = Number(row.followers ?? 0);
  return { ...row, followers_text: Number.isFinite(f) ? f.toLocaleString('zh-CN') : String(row.followers ?? '-') };
}

/** 保存前归一化 handle（与后端 normalizeHandle 一致，PRD §3.5） */
function beforeSubmit(values: Record<string, unknown>) {
  const v = { ...values };
  if (typeof v.handle === 'string') v.handle = normalizeHandle(v.handle);
  delete v.followers_text;
  return v;
}

/** 认领：公海 → 私海，owner=本人，protect_until = today + 30（PRD §3.5 / §4.1 场景 A） */
async function claim(row: Record<string, unknown>, reload: () => void) {
  claiming.value = Number(row.id);
  try {
    await apiPost(`/creators/${String(row.id)}/claim`);
    ElMessage.success(`已认领 @${String(row.handle ?? '')}，保护期 30 天`);
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    claiming.value = 0;
  }
}

async function blacklist(row: Record<string, unknown>, reload: () => void) {
  try {
    await apiPost(`/creators/${String(row.id)}/blacklist`);
    ElMessage.success('已加入黑名单');
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(() => {
  void dict.dict('region').catch(() => undefined);
  void dict.dict('creator_tag').catch(() => undefined);
  void dict.dict('gmv_level').catch(() => undefined);
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
</style>
