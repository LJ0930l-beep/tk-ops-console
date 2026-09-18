<template>
  <div class="page">
    <el-alert
      class="page-tip"
      type="info"
      show-icon
      :closable="false"
      title="私海达人归你跟进：保护期 ≤7 天黄色、已过期红色（夜间作业会自动退回公海）。邮箱/WhatsApp 按权限由后端返回 ***。"
    />
    <ResourcePage
      ref="rp"
      api="/creators"
      title="我的达人"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :extra-query="extraQuery"
      :createable="false"
      :editable="true"
      :deletable="false"
      :can-write="true"
      :map-row="mapRow"
      :before-submit="beforeSubmit"
      :row-class-name="rowClass"
      :action-width="230"
    >
      <template #toolbar-extra>
        <el-button :icon="Star" @click="router.push('/creators/pool')">去公海认领</el-button>
      </template>
      <template #actions="{ row, reload }">
        <el-button link type="primary" size="small" @click="toOutreach(row)">跟进</el-button>
        <el-button link type="success" size="small" @click="toCollab(row)">建合作单</el-button>
        <el-popconfirm title="退回公海后你将失去该达人归属，确认？" @confirm="release(row, reload)">
          <template #reference><el-button link type="warning" size="small">退回公海</el-button></template>
        </el-popconfirm>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Star } from '@element-plus/icons-vue';
import { POOL_STATUS, normalizeHandle } from '@tk/shared';
import { apiPost, errMsg } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';

const router = useRouter();
const auth = useAuthStore();
const dict = useDictStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);

/** 我的达人 = owner_id 本人（BD 的 data_scope=仅本人 由后端二次收敛） */
const extraQuery = reactive<Record<string, unknown>>({ owner_id: auth.user?.id ?? 0 });
const poolOptions: OptionDef[] = [
  { value: POOL_STATUS.PRIVATE, label: '私海', type: 'success' },
  { value: POOL_STATUS.COOPERATING, label: '合作中', type: 'primary' },
  { value: POOL_STATUS.PUBLIC, label: '公海', type: 'info' },
  { value: POOL_STATUS.BLACKLIST, label: '黑名单', type: 'danger' },
];
const sourceOptions: OptionDef[] = [
  { value: 1, label: '联盟广场' },
  { value: 2, label: 'TikTok 搜索' },
  { value: 3, label: '达人申样' },
  { value: 4, label: '机构推荐' },
];

const regionOptions = computed<OptionDef[]>(() => (dict.cache.region ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));
const tagOptions = computed<OptionDef[]>(() => (dict.cache.creator_tag ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));
const levelOptions = computed<OptionDef[]>(() => (dict.cache.gmv_level ?? []).map((d) => ({ value: d.dict_value, label: d.dict_label })));

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', type: 'text', placeholder: 'handle / 昵称 模糊' },
  { key: 'pool_status', label: '池状态', type: 'select', options: poolOptions },
  { key: 'region', label: '站点', type: 'select', dictType: 'region', options: regionOptions.value },
  { key: 'category_tags', label: '类目标签', type: 'select', dictType: 'creator_tag', options: tagOptions.value },
  { key: 'gmv_level', label: '带货力', type: 'select', dictType: 'gmv_level', options: levelOptions.value },
  { key: 'protect_state', label: '保护期', type: 'select', options: [{ value: 'expiring', label: '7 天内到期' }, { value: 'expired', label: '已过期' }] },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'handle', label: '达人 handle', width: 170 },
  { prop: 'nickname', label: '昵称', width: 150 },
  { prop: 'region', label: '站点', width: 70 },
  { prop: 'followers_text', label: '粉丝数', width: 110 },
  { prop: 'avg_views', label: '均播放', width: 100 },
  { prop: 'category_tags', label: '类目标签', minWidth: 140 },
  { prop: 'gmv_level', label: '带货力', width: 100 },
  { prop: 'email', label: '邮箱', width: 180 },
  { prop: 'whatsapp', label: 'WhatsApp', width: 150 },
  { prop: 'pool_status', label: '池状态', width: 90, type: 'tag', options: poolOptions },
  { prop: 'protect_until', label: '保护期至', type: 'date', width: 110 },
  { prop: 'protect_left', label: '剩余天数', width: 180 },
  { prop: 'source', label: '来源', width: 110, type: 'tag', options: sourceOptions },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'handle', label: 'handle', required: true, disabledOnEdit: true, span: 12 },
  { key: 'nickname', label: '昵称', span: 12 },
  { key: 'region', label: '站点', type: 'select', dictType: 'region', options: regionOptions.value, span: 12 },
  { key: 'category_tags', label: '类目标签', span: 12, placeholder: '多个用英文逗号分隔' },
  { key: 'followers', label: '粉丝数', type: 'number', min: 0, precision: 0, span: 12 },
  { key: 'avg_views', label: '均播放', type: 'number', min: 0, precision: 0, span: 12 },
  { key: 'gmv_level', label: '带货力', type: 'select', dictType: 'gmv_level', options: levelOptions.value, span: 12 },
  { key: 'source', label: '来源', type: 'select', options: sourceOptions, span: 12 },
  { key: 'email', label: '邮箱', span: 12 },
  { key: 'whatsapp', label: 'WhatsApp', span: 12 },
  { key: 'protect_until', label: '保护期至', type: 'date', span: 12 },
]);

/* ---------- 保护期剩余天数（PRD §3.5 告警态） ---------- */
function daysLeft(protectUntil: unknown): number | null {
  if (!protectUntil) return null;
  const t = Date.parse(`${String(protectUntil).slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(t)) return null;
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((t - base) / 86400000);
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const d = daysLeft(row.protect_until);
  let left = '-';
  if (d === null) left = '未设置保护期';
  else if (d < 0) left = `已过期 ${Math.abs(d)} 天·将自动退回公海`;
  else if (d === 0) left = '今日到期';
  else if (d <= 7) left = `剩 ${d} 天·请尽快跟进`;
  else left = `剩 ${d} 天`;
  const f = Number(row.followers ?? 0);
  return { ...row, protect_left: left, protect_days: d, followers_text: Number.isFinite(f) ? f.toLocaleString('zh-CN') : '-' };
}

function rowClass({ row }: { row: Record<string, unknown> }): string {
  const d = row.protect_days;
  if (d === null || d === undefined) return '';
  if (Number(d) < 0) return 'protect-danger';
  if (Number(d) <= 7) return 'protect-warn';
  return '';
}

function beforeSubmit(values: Record<string, unknown>) {
  const v = { ...values };
  if (typeof v.handle === 'string') v.handle = normalizeHandle(v.handle);
  delete v.followers_text;
  delete v.protect_left;
  delete v.protect_days;
  return v;
}

function toOutreach(row: Record<string, unknown>) {
  router.push({ path: '/creators/outreach', query: { creator_id: String(row.id ?? ''), handle: String(row.handle ?? '') } });
}
function toCollab(row: Record<string, unknown>) {
  router.push({ path: '/creators/collab', query: { creator_id: String(row.id ?? ''), handle: String(row.handle ?? ''), action: 'new' } });
}

/** 退回公海：owner_id=null、protect_until=null、pool_status=1 */
async function release(row: Record<string, unknown>, reload: () => void) {
  try {
    await apiPost(`/creators/${String(row.id)}/release`);
    ElMessage.success(`@${String(row.handle ?? '')} 已退回公海`);
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

onMounted(async () => {
  const before = extraQuery.owner_id;
  await auth.me().catch(() => undefined);
  extraQuery.owner_id = auth.user?.id ?? 0;
  /** 兜底：setup 时 user 还没水合，拿到 id 后重查一次 */
  if (before !== extraQuery.owner_id) rp.value?.reload(1);
  void dict.dict('region').catch(() => undefined);
  void dict.dict('creator_tag').catch(() => undefined);
  void dict.dict('gmv_level').catch(() => undefined);
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
:deep(.protect-warn td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(.protect-danger td.el-table__cell) {
  background: #fef0f0 !important;
  color: #c45656;
}
</style>
