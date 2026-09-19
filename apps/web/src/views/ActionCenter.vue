<template>
  <div class="page" v-loading="loading">
    <!-- 顶部：状态计数 + 优先级概览 -->
    <div class="stat-grid">
      <el-card v-for="c in countCards" :key="c.label" shadow="never" class="kpi" :class="c.cls">
        <div class="kpi-head"><span class="kpi-label">{{ c.label }}</span></div>
        <div class="kpi-value" :style="{ color: c.color }">{{ c.value }}</div>
        <div class="kpi-sub">{{ c.sub }}</div>
      </el-card>
    </div>

    <el-alert
      v-if="!loading && totalOpen === 0"
      type="success"
      :closable="false"
      show-icon
      class="page-card"
      title="今日无待处理预警"
      description="所有规则命中均已处理或忽略。规则每日 02:40 自动评估，也可在规则中心手动补跑。"
    />

    <!-- P0 今日必处理 -->
    <el-card v-if="data.p0.length" class="page-card prio-card p0" shadow="never">
      <template #header>
        <b><el-tag type="danger" effect="dark" size="small">P0</el-tag> 今日必处理</b>
        <span class="head-tip">{{ data.p0.length }} 条 · 24 小时内闭环</span>
      </template>
      <EventList :events="data.p0" @open="openDetail" @act="openHandle" />
    </el-card>

    <!-- P1 本周观察 -->
    <el-card v-if="data.p1.length" class="page-card prio-card p1" shadow="never">
      <template #header>
        <b><el-tag type="warning" effect="dark" size="small">P1</el-tag> 本周观察</b>
        <span class="head-tip">{{ data.p1.length }} 条 · 7 天内跟进</span>
      </template>
      <EventList :events="data.p1" @open="openDetail" @act="openHandle" />
    </el-card>

    <!-- P2 趋势参考 -->
    <el-card v-if="data.p2.length" class="page-card prio-card p2" shadow="never">
      <template #header>
        <b><el-tag type="info" effect="dark" size="small">P2</el-tag> 趋势参考</b>
        <span class="head-tip">{{ data.p2.length }} 条 · 不强制处理</span>
      </template>
      <EventList :events="data.p2" @open="openDetail" @act="openHandle" />
    </el-card>

    <el-row :gutter="16">
      <!-- 我的待办 -->
      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header><b>我的待办</b><span class="head-tip">派给我名下的未闭环预警</span></template>
          <el-empty v-if="!data.mine.length" :image-size="60" description="暂无指派给你的预警" />
          <div v-else class="mine-list">
            <div v-for="e in data.mine" :key="e.id" class="mine-item" @click="openDetail(e.id)">
              <el-tag size="small" :type="prioType(e.priority)">{{ 'P' + e.priority }}</el-tag>
              <span class="mine-name">{{ e.target_name || e.rule_name }}</span>
              <span class="mine-rule">{{ e.rule_name }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
      <!-- 最近效果回看 -->
      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header>
            <b>最近效果回看</b>
            <el-button link type="primary" style="float: right" @click="goto('/actions/results')">全部</el-button>
          </template>
          <el-empty v-if="!data.recent_results.length" :image-size="60" description="处理满观察期后自动对比前后指标" />
          <el-table v-else :data="data.recent_results" size="small" border stripe :max-height="260">
            <el-table-column prop="target_name" label="对象" min-width="110" show-overflow-tooltip />
            <el-table-column prop="rule_name" label="规则" min-width="110" show-overflow-tooltip />
            <el-table-column label="结论" width="92">
              <template #default="{ row }">
                <el-tag size="small" :type="resultType(row.result)">{{ resultLabel(row.result) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="改善幅度" width="96" align="right">
              <template #default="{ row }">{{ row.improvement_rate == null ? '—' : (num(row.improvement_rate) * 100).toFixed(1) + '%' }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 处理弹窗 -->
    <el-dialog v-model="handleVisible" :title="`处理预警 · ${handleTarget?.rule_name ?? ''}`" width="520px">
      <el-form label-width="96px">
        <el-form-item label="对象">
          <span>{{ handleTarget?.target_name || '—' }}</span>
          <el-tag size="small" :type="prioType(handleTarget?.priority ?? 2)" style="margin-left: 8px">{{ 'P' + (handleTarget?.priority ?? '-') }}</el-tag>
        </el-form-item>
        <el-form-item label="动作">
          <el-radio-group v-model="form.action_type">
            <el-radio-button v-for="(lbl, k) in ACTION_TYPE_LABELS" :key="k" :value="k">{{ lbl }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.action_type === 'transfer'" label="转派给">
          <el-select v-if="owners.length" v-model="form.owner_id" filterable placeholder="选择负责人" style="width: 100%">
            <el-option v-for="o in owners" :key="o.id" :label="o.real_name" :value="o.id" />
          </el-select>
          <el-input-number v-else v-model="form.owner_id" :min="1" placeholder="负责人用户ID" />
        </el-form-item>
        <el-form-item v-if="form.action_type === 'handle'" label="预期结果">
          <el-input v-model="form.expected_result" placeholder="例如：ROAS 回到盈亏线以上 / 补齐内容承接" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item v-if="form.action_type === 'handle'" label="观察至">
          <el-date-picker v-model="form.observe_until" type="date" value-format="YYYY-MM-DD" placeholder="默认 7 天后" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="你做了什么 / 为什么忽略" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="handleVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitHandle">提交</el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" title="预警详情" size="560px">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="规则">{{ detail.rule_name }}（{{ detail.rule_code }}）</el-descriptions-item>
          <el-descriptions-item label="对象">{{ detail.target_name || '—' }}</el-descriptions-item>
          <el-descriptions-item label="优先级"><el-tag size="small" :type="prioType(detail.priority)">{{ 'P' + detail.priority }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="状态"><el-tag size="small">{{ ALERT_EVENT_STATUS_LABELS[detail.status] }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="发现时间">{{ detail.detected_at }}</el-descriptions-item>
          <el-descriptions-item label="处理时限">{{ detail.due_at || '—' }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ detail.owner_name || '未指派' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="sec">命中证据</h4>
        <div class="ev-grid">
          <div v-for="(v, k) in evidenceEntries(detail.evidence)" :key="k" class="ev-item">
            <span class="ev-k">{{ k }}</span><span class="ev-v">{{ v }}</span>
          </div>
          <el-empty v-if="!Object.keys(evidenceEntries(detail.evidence)).length" :image-size="50" description="无证据快照" />
        </div>

        <h4 class="sec">处理流水</h4>
        <el-timeline v-if="detail.actions?.length">
          <el-timeline-item v-for="a in detail.actions" :key="a.id" :timestamp="a.action_at" placement="top">
            <b>{{ ACTION_TYPE_LABELS[a.action_type] || a.action_type }}</b>
            <span style="color: #909399"> · {{ a.handler_name }}</span>
            <div v-if="a.note" class="act-note">{{ a.note }}</div>
            <div v-if="a.expected_result" class="act-note">预期：{{ a.expected_result }}</div>
            <el-tag v-if="a.result" size="small" :type="resultType(a.result)" style="margin-top: 4px">
              回看：{{ resultLabel(a.result) }}{{ a.improvement_rate != null ? ` (${(num(a.improvement_rate) * 100).toFixed(1)}%)` : '' }}
            </el-tag>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else :image-size="50" description="尚无处理记录" />

        <div style="margin-top: 12px" v-if="detail.status === 0 || detail.status === 1">
          <el-button type="primary" @click="openHandle(detail.id)">处理</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ACTION_TYPE_LABELS, ALERT_EVENT_STATUS_LABELS, num } from '@tk/shared';
import { apiGet, apiPost, errMsg } from '@/api/client';
import EventList from './action-center/EventList.vue';

interface ApiEvent {
  id: number;
  rule_id: number;
  rule_code: string;
  rule_name: string;
  target_type: string;
  target_id: number | null;
  target_name: string | null;
  shop_id: number | null;
  detected_at: string;
  priority: number;
  status: number;
  owner_id: number | null;
  owner_name: string;
  due_at: string | null;
  evidence: Record<string, unknown>;
}
interface ResultRow {
  id: number;
  result: string;
  improvement_rate: number | null;
  target_name: string | null;
  rule_name: string | null;
}
interface TodayData {
  p0: ApiEvent[];
  p1: ApiEvent[];
  p2: ApiEvent[];
  mine: ApiEvent[];
  counts: Record<string, number>;
  recent_results: ResultRow[];
}
interface DetailEvent extends ApiEvent {
  actions?: { id: number; action_type: string; action_at: string; note: string | null; expected_result: string | null; handler_name: string; result: string | null; improvement_rate: number | null }[];
}

const router = useRouter();
const loading = ref(false);
const data = reactive<TodayData>({ p0: [], p1: [], p2: [], mine: [], counts: {}, recent_results: [] });

const totalOpen = computed(() => data.p0.length + data.p1.length + data.p2.length);
const countCards = computed(() => [
  { label: 'P0 今日必处理', value: data.p0.length, sub: '24 小时内闭环', color: '#f56c6c', cls: 'c-danger' },
  { label: 'P1 本周观察', value: data.p1.length, sub: '7 天内跟进', color: '#e6a23c', cls: 'c-warn' },
  { label: 'P2 趋势参考', value: data.p2.length, sub: '不强制处理', color: '#909399', cls: '' },
  { label: '待处理总数', value: totalOpen.value, sub: `已处理 ${data.counts['2'] ?? 0} · 已忽略 ${data.counts['3'] ?? 0}`, color: '#409eff', cls: '' },
]);

const prioType = (p: number) => (p === 0 ? 'danger' : p === 1 ? 'warning' : 'info') as 'danger' | 'warning' | 'info';
const resultType = (r: string) => (r === 'improved' ? 'success' : r === 'worse' ? 'danger' : r === 'unchanged' ? 'info' : 'warning') as 'success' | 'danger' | 'info' | 'warning';
const resultLabel = (r: string) => ({ improved: '改善', unchanged: '持平', worse: '恶化', pending: '观察中' }[r] ?? r);

/** 证据渲染：跳过 rule/window 元字段，数字保留 4 位，比率转百分比展示由模板兜底 */
function evidenceEntries(ev: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ev ?? {})) {
    if (k === 'rule' || k === 'window' || v === null || v === undefined || typeof v === 'object') continue;
    out[k] = typeof v === 'number' ? String(Number(v.toFixed ? v.toFixed(4) : v)) : String(v);
  }
  return out;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const d = await apiGet<TodayData>('/actions/today');
    Object.assign(data, { p0: d.p0 ?? [], p1: d.p1 ?? [], p2: d.p2 ?? [], mine: d.mine ?? [], counts: d.counts ?? {}, recent_results: d.recent_results ?? [] });
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

/* ---- 详情抽屉 ---- */
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<DetailEvent | null>(null);
async function openDetail(id: number): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await apiGet<DetailEvent>(`/actions/events/${id}`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    detailLoading.value = false;
  }
}

/* ---- 处理弹窗 ---- */
const handleVisible = ref(false);
const submitting = ref(false);
const handleTarget = ref<ApiEvent | null>(null);
const owners = ref<{ id: number; real_name: string }[]>([]);
const form = reactive<{ action_type: string; note: string; expected_result: string; observe_until: string; owner_id: number | undefined }>({
  action_type: 'handle',
  note: '',
  expected_result: '',
  observe_until: '',
  owner_id: undefined,
});

function openHandle(id: number): void {
  const e = [...data.p0, ...data.p1, ...data.p2, ...data.mine].find((x) => x.id === id) ?? (detail.value && detail.value.id === id ? detail.value : null);
  if (!e) return;
  handleTarget.value = e;
  form.action_type = 'handle';
  form.note = '';
  form.expected_result = '';
  form.observe_until = '';
  form.owner_id = undefined;
  handleVisible.value = true;
  if (!owners.value.length) loadOwners();
}

async function loadOwners(): Promise<void> {
  try {
    const r = await apiGet<{ list?: { id: number; real_name: string }[] } | { id: number; real_name: string }[]>('/system/users', { pageSize: 200 });
    owners.value = Array.isArray(r) ? r : ((r as { list?: { id: number; real_name: string }[] }).list ?? []);
  } catch {
    owners.value = [];
  }
}

async function submitHandle(): Promise<void> {
  if (!handleTarget.value) return;
  if (form.action_type === 'transfer' && !form.owner_id) {
    ElMessage.warning('转派必须选择负责人');
    return;
  }
  submitting.value = true;
  try {
    await apiPost(`/actions/events/${handleTarget.value.id}/handle`, {
      action_type: form.action_type,
      note: form.note || null,
      expected_result: form.expected_result || null,
      observe_until: form.observe_until || null,
      owner_id: form.owner_id ?? null,
    });
    ElMessage.success('已记录处理动作');
    handleVisible.value = false;
    detailVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    submitting.value = false;
  }
}

function goto(path: string): void {
  void router.push(path);
}

onMounted(load);
onActivated(() => {
  if (!loading.value) void load();
});
</script>

<style scoped>
.kpi { border-left: 3px solid #dcdfe6; }
.kpi.c-danger { border-left-color: #f56c6c; }
.kpi.c-warn { border-left-color: #e6a23c; }
.kpi-head { display: flex; justify-content: space-between; align-items: center; }
.kpi-label { color: #909399; font-size: 13px; }
.kpi-value { font-size: 30px; font-weight: 700; line-height: 1.3; }
.kpi-sub { color: #a8abb2; font-size: 12px; margin-top: 2px; }
.head-tip { color: #909399; font-size: 12px; margin-left: 10px; font-weight: 400; }
.prio-card.p0 :deep(.el-card__header) { background: #fef0f0; }
.prio-card.p1 :deep(.el-card__header) { background: #fdf6ec; }
.prio-card.p2 :deep(.el-card__header) { background: #f4f4f5; }
.mine-list { display: flex; flex-direction: column; gap: 8px; }
.mine-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 6px; cursor: pointer; }
.mine-item:hover { border-color: #409eff; background: #f5f9ff; }
.mine-name { font-weight: 600; }
.mine-rule { color: #909399; font-size: 12px; margin-left: auto; }
.sec { margin: 16px 0 8px; font-size: 14px; }
.ev-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.ev-item { display: flex; justify-content: space-between; background: #f7f8fa; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.ev-k { color: #909399; }
.ev-v { font-weight: 600; word-break: break-all; text-align: right; }
.act-note { color: #606266; font-size: 13px; margin-top: 2px; }
</style>
