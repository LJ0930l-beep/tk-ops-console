<template>
  <div class="page">
    <!-- 快捷录入：要求 10 秒一条（PRD §3.5 建联跟进表单） -->
    <el-card class="page-card" shadow="never">
      <template #header>
        <div class="quick-head">
          <b>快捷录入跟进</b>
          <span class="sub">选达人 → 选渠道 → 写一句结论 → 保存；联系时间取当前时间，保存后续保护期至多 7 天，结果为「谈妥」请直接建合作单。</span>
        </div>
      </template>
      <el-form inline class="quick-form" @submit.prevent="submitQuick">
        <el-form-item label="达人">
          <el-select v-model="quick.creator_id" filterable placeholder="扫 handle 带出" style="width: 210px" :loading="loadingCreators">
            <el-option v-for="o in creatorOpts" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="渠道">
          <el-select v-model="quick.channel" style="width: 140px">
            <el-option v-for="o in channelOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="结果">
          <el-select v-model="quick.result" style="width: 130px">
            <el-option v-for="o in resultOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="小结">
          <el-input v-model="quick.summary" ref="summaryRef" placeholder="一句话结论，≤500 字" maxlength="500" show-word-limit style="width: 300px" />
        </el-form-item>
        <el-form-item label="下次跟进">
          <el-date-picker v-model="quick.next_follow_at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="留空 = 不设提醒" style="width: 200px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Check" :loading="saving" @click="submitQuick">保存并继续</el-button>
          <el-button v-if="quickDraft.creator_id" @click="restoreDraft">放弃本次</el-button>
        </el-form-item>
      </el-form>
      <el-space wrap :size="18" class="stats">
        <span>跟进人：<b>{{ auth.user?.real_name ?? '-' }}</b></span>
        <span>待跟进（24h 内到点）：<b>{{ stats?.to_follow ?? '-' }}</b></span>
        <el-button link type="primary" size="small" @click="openDue">查看到点清单</el-button>
        <span>近 30 天全网漏斗：<b>{{ funnelText }}</b></span>
        <span class="sub">列表默认只看本人跟进，勾选「范围=本组/全部」可放大（后端按角色数据范围再收敛）；统计口径 GET /creators/stats?period=30d</span>
      </el-space>
    </el-card>

    <ResourcePage
      ref="rp"
      api="/creators/outreach"
      title="建联跟进"
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
      :default-page-size="20"
    >
      <template #toolbar>
        <el-button type="primary" plain :icon="Plus" @click="openDialog">补录跟进</el-button>
      </template>
    </ResourcePage>

    <!-- 到点待跟进：GET /creators/outreach/due（本人优先，含已跟进次数） -->
    <el-dialog v-model="due.visible" title="到点待跟进（next_follow_at 距今 ≤ 24 小时）" width="860px">
      <el-table v-loading="due.loading" :data="due.rows" size="small" max-height="420">
        <el-table-column prop="creator_handle" label="达人" width="180" />
        <el-table-column prop="user_name" label="跟进人" width="110" />
        <el-table-column prop="next_follow_at" label="应跟进时间" width="165" />
        <el-table-column prop="follow_times" label="已跟进次数" width="100" />
        <el-table-column prop="summary" label="上次小结" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="fillQuick(row as Row)">继续跟进</el-button>
            <el-button link type="warning" size="small" @click="goCollab(row as Row)">建合作单</el-button>
          </template>
        </el-table-column>
        <template #empty><span class="sub">没有到点的跟进，说明提醒字段没填或都已处理</span></template>
      </el-table>
      <template #footer><el-button @click="due.visible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Check, Plus } from '@element-plus/icons-vue';
import { OUTREACH_RESULT } from '@tk/shared';
import { apiGet, apiPost, errMsg } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useAuthStore } from '@/stores/auth';

type Row = Record<string, unknown>;

const route = useRoute();
const auth = useAuthStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);
const summaryRef = ref<unknown>(null);
const saving = ref(false);
const loadingCreators = ref(false);

const channelOptions: OptionDef[] = [
  { value: 1, label: 'TikTok 私信' },
  { value: 2, label: '邮件' },
  { value: 3, label: 'WhatsApp' },
  { value: 4, label: '平台定向邀约' },
];
const resultOptions: OptionDef[] = [
  { value: OUTREACH_RESULT.NO_REPLY, label: '未回复', type: 'info' },
  { value: OUTREACH_RESULT.REPLIED, label: '已回复', type: 'primary' },
  { value: OUTREACH_RESULT.INTERESTED, label: '有意向', type: 'primary' },
  { value: OUTREACH_RESULT.QUOTING, label: '报价中', type: 'warning' },
  { value: OUTREACH_RESULT.REJECTED, label: '拒绝', type: 'danger' },
  { value: OUTREACH_RESULT.AGREED, label: '谈妥', type: 'success' },
];

/** 从「我的达人」跳转过来时按达人过滤 */
const extraQuery = reactive<Row>({});
const creatorOpts = ref<{ value: number; label: string }[]>([]);

/** GET /creators/stats 的全局口径（漏斗为全网，非本人） */
interface Funnel {
  outreach?: number;
  replied?: number;
  agreed?: number;
  creators_contacted?: number;
  collabs?: number;
  samples?: number;
  contents?: number;
  orders?: number;
}
interface Stats {
  to_follow?: number;
  funnel?: Funnel;
}
const stats = ref<Stats | null>(null);
const funnelText = computed(() => {
  const f = stats.value?.funnel;
  if (!f) return '-';
  const rate = f.outreach ? `${((Number(f.replied ?? 0) / Number(f.outreach)) * 100).toFixed(0)}%` : '-';
  return `建联 ${String(f.outreach ?? 0)} → 回复 ${String(f.replied ?? 0)}（${rate}）→ 谈妥 ${String(f.agreed ?? 0)} → 合作单 ${String(f.collabs ?? 0)}`;
});

const quick = reactive<Row>({});
const quickDraft = reactive<Row>({});

const creatorIdFromQuery = computed(() => Number(route.query.creator_id ?? 0) || undefined);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', type: 'text', placeholder: '达人 handle / 跟进小结' },
  { key: 'creator_id', label: '达人', type: 'select', options: creatorOpts.value },
  { key: 'result', label: '结果', type: 'select', options: resultOptions },
  { key: 'channel', label: '渠道', type: 'select', options: channelOptions },
  { key: 'contact_time', label: '联系时间', type: 'daterange' },
  { key: 'group', label: '范围', type: 'select', options: [{ value: 'true', label: '本组 / 全部' }] },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'creator_handle', label: '达人 handle', width: 170 },
  { prop: 'user_name', label: '跟进人', width: 110 },
  { prop: 'channel', label: '渠道', width: 130, type: 'tag', options: channelOptions },
  { prop: 'contact_time', label: '联系时间', type: 'datetime', width: 150 },
  { prop: 'summary', label: '跟进小结', minWidth: 260 },
  { prop: 'result', label: '结果', width: 100, type: 'tag', options: resultOptions },
  { prop: 'next_follow_at', label: '下次跟进', type: 'datetime', width: 150 },
  { prop: 'follow_state', label: '提醒状态', width: 110 },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'creator_id', label: '达人', type: 'select', required: true, options: () => creatorOpts.value, default: creatorIdFromQuery.value, span: 12 },
  { key: 'channel', label: '渠道', type: 'select', required: true, options: channelOptions, default: 1, span: 12 },
  { key: 'contact_time', label: '联系时间', type: 'datetime', span: 12, placeholder: '留空 = 取当前时间' },
  { key: 'result', label: '结果', type: 'select', required: true, options: resultOptions, default: OUTREACH_RESULT.NO_REPLY, span: 12 },
  { key: 'next_follow_at', label: '下次跟进', type: 'datetime', span: 12 },
  { key: 'summary', label: '跟进小结', type: 'textarea', span: 24, placeholder: '≤500 字' },
]);

/* ---------- 派生列：到点提醒 ---------- */
function ts(v: unknown): number {
  if (!v) return 0;
  return Date.parse(String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z'));
}
function mapRow(row: Row): Row {
  const next = row.next_follow_at;
  let state = '-';
  if (next) {
    const t = ts(next);
    const diffDays = Math.round((t - Date.now()) / 86400000);
    if (t && t < Date.now()) state = diffDays <= -1 ? `逾期 ${Math.abs(diffDays)} 天` : '今日到点';
    else state = `待跟进（${Number.isFinite(diffDays) ? diffDays : '?'} 天后）`;
  }
  return { ...row, follow_state: state, due_now: !!next && ts(next) > 0 && ts(next) <= Date.now() };
}
function rowClass({ row }: { row: Row }): string {
  if (Number(row.result) === OUTREACH_RESULT.AGREED) return 'agreed-row';
  return row.due_now ? 'warning-row' : '';
}

/* ---------- 快捷录入 ---------- */
function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function restoreDraft() {
  Object.keys(quick).forEach((k) => delete quick[k]);
  Object.assign(quick, { creator_id: quickDraft.creator_id, channel: quickDraft.channel, result: quickDraft.result });
}

async function submitQuick() {
  if (!quick.creator_id) return ElMessage.warning('请先选择达人');
  saving.value = true;
  try {
    await apiPost('/creators/outreach', {
      creator_id: quick.creator_id,
      channel: quick.channel ?? 1,
      result: quick.result ?? OUTREACH_RESULT.NO_REPLY,
      summary: quick.summary || null,
      contact_time: nowStr(),
      next_follow_at: quick.next_follow_at || null,
    });
    ElMessage.success(Number(quick.result) === OUTREACH_RESULT.AGREED ? '已记录：结果=谈妥，请去建合作单' : '跟进已记录，保护期已续期');
    quickDraft.creator_id = quick.creator_id;
    quickDraft.channel = quick.channel;
    quickDraft.result = OUTREACH_RESULT.NO_REPLY;
    Object.keys(quick).forEach((k) => delete quick[k]);
    Object.assign(quick, { creator_id: quickDraft.creator_id, channel: quickDraft.channel, result: quickDraft.result });
    void loadStats();
    rp.value?.reload(1);
    await nextTick();
    (summaryRef.value as { focus?: () => void } | null)?.focus?.();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

function openDialog() {
  rp.value?.openCreate();
}

/** 补录表单：联系时间留空取当前；结果=谈妥时提示走合作单 */
function beforeSubmit(values: Row): Row {
  const v = { ...values };
  if (!v.contact_time) v.contact_time = nowStr();
  if (Number(v.result) === OUTREACH_RESULT.AGREED) ElMessage.info('结果为「谈妥」：请到合作单建单，保护期不再自动续期');
  return v;
}

/* ---------- 下拉与统计 ---------- */
function toOpts(rows: unknown) {
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .filter((r) => r.id !== undefined && r.id !== null)
    .map((r) => ({ value: Number(r.id), label: `@${String(r.handle ?? '')}${r.nickname ? `（${String(r.nickname)}）` : ''}` }));
}
/** 达人下拉复用列表接口（与 /creators 列表同一权限与数据范围） */
async function loadCreators() {
  loadingCreators.value = true;
  try {
    const data = await apiGet<Row>('/creators', { page: 1, pageSize: 200 });
    creatorOpts.value = toOpts(data?.list);
  } catch {
    creatorOpts.value = [];
  } finally {
    loadingCreators.value = false;
  }
}
async function loadStats() {
  try {
    stats.value = await apiGet<Stats>('/creators/stats', { period: '30d' });
  } catch {
    stats.value = null;
  }
}

/* ---------- 到点待跟进 ---------- */
const due = reactive({ visible: false, loading: false, rows: [] as Row[] });
async function openDue() {
  due.visible = true;
  due.loading = true;
  try {
    const data = await apiGet<Row>('/creators/outreach/due', { hours: 24, limit: 100 });
    due.rows = Array.isArray(data?.list) ? (data.list as Row[]) : [];
  } catch (e) {
    ElMessage.error(errMsg(e));
    due.rows = [];
  } finally {
    due.loading = false;
  }
}
/** 到点记录 → 回填快捷录入的达人，直接续一条跟进 */
function fillQuick(row: Row) {
  quick.creator_id = row.creator_id;
  quick.channel = quick.channel ?? Number(row.channel ?? 1);
  quick.result = OUTREACH_RESULT.NO_REPLY;
  due.visible = false;
  void nextTick(() => (summaryRef.value as { focus?: () => void } | null)?.focus?.());
}
function goCollab(row: Row) {
  due.visible = false;
  void router.push({ path: '/creators/collab', query: { creator_id: String(row.creator_id ?? ''), action: 'new' } });
}

function applyRouteQuery() {
  if (route.name !== 'outreach') return;
  const cid = Number(route.query.creator_id ?? 0);
  if (cid > 0) extraQuery.creator_id = cid;
  else delete extraQuery.creator_id;
}
/** 必须在子组件（ResourcePage）首次拉数据前生效 */
applyRouteQuery();

watch(() => route.fullPath, applyRouteQuery);

onMounted(async () => {
  await Promise.all([loadCreators(), loadStats()]);
  Object.assign(quick, { channel: 1, result: OUTREACH_RESULT.NO_REPLY });
});
</script>

<style scoped>
.quick-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.quick-form {
  margin-bottom: 4px;
}
.quick-form :deep(.el-form-item) {
  margin-bottom: 10px;
}
.stats {
  font-size: 12px;
  color: #606266;
}
.sub {
  color: #909399;
  font-size: 12px;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(.agreed-row td.el-table__cell) {
  background: #f0f9eb !important;
}
</style>
