<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload">
        <el-form-item label="店铺">
          <el-select v-model="query.shop_id" clearable placeholder="全部" style="width: 160px" @change="reload">
            <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" clearable placeholder="全部" style="width: 130px" @change="reload">
            <el-option v-for="o in LIVE_STATUS" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="主播/场控">
          <el-input v-model="query.keyword" clearable placeholder="姓名或账号" style="width: 160px" @keyup.enter="reload" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
        </el-form-item>
        <el-form-item style="float: right">
          <el-button type="primary" :icon="Plus" @click="openCreate()">新建排班</el-button>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="排班只登记计划：同一账号时段重叠后端返回 409；开播前 1 天由作业推送提醒（站内信降级）。时间按你的浏览器时区展示，落库为 UTC。"
      />
    </el-card>

    <el-card shadow="never">
      <el-calendar v-model="calendarDate">
        <template #date-cell="{ data }">
          <div class="cell" :class="{ 'cell-other': data.type !== 'current' }" @click="pickedDay = data.day">
            <div class="cell-day">{{ Number(data.day.slice(-2)) }}</div>
            <div v-for="s in byDay(data.day).slice(0, 3)" :key="String(s.id)" class="cell-item" :class="`st-${s.status}`" @click.stop="openDay(s)">
              <span class="cell-time">{{ hm(s.plan_start) }}</span>
              <span class="cell-text">{{ s.shop_name || `#${s.shop_id}` }} / {{ s.host_name || '未派主播' }}</span>
            </div>
            <div v-if="byDay(data.day).length > 3" class="cell-more">+{{ byDay(data.day).length - 3 }} 场</div>
          </div>
        </template>
      </el-calendar>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <b>{{ pickedDay }} 排班明细（{{ dayRows.length }} 场）</b>
          <div>
            <el-button size="small" :icon="ArrowLeft" @click="shiftDay(-1)">前一天</el-button>
            <el-button size="small" @click="pickedDay = todayText()">今天</el-button>
            <el-button size="small" :icon="ArrowRight" @click="shiftDay(1)">后一天</el-button>
            <el-button size="small" type="primary" :icon="Plus" @click="openCreate(pickedDay)">当天新增</el-button>
          </div>
        </div>
      </template>
      <el-table v-loading="loading" :data="dayRows" border stripe size="small" empty-text="当天没有排班">
        <el-table-column label="计划时段" width="230">
          <template #default="{ row }">{{ hm(row.plan_start) }} - {{ hm(row.plan_end) }}（{{ durationText(row) }}）</template>
        </el-table-column>
        <el-table-column prop="shop_name" label="店铺" min-width="130" show-overflow-tooltip />
        <el-table-column label="直播账号" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.account_handle || (row.account_id ? `#${row.account_id}` : '-') }}</template>
        </el-table-column>
        <el-table-column prop="host_name" label="主播" width="100" />
        <el-table-column label="场控" width="100">
          <template #default="{ row }">{{ row.assistant_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="嘉宾达人" width="120">
          <template #default="{ row }">{{ row.creator_handle || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="95">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="实际起止" width="150">
          <template #default="{ row }">{{ row.actual_start ? `${hm(row.actual_start)} ~ ${row.actual_end ? hm(row.actual_end) : '进行中'}` : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="Number(row.status) === 1" link type="success" size="small" @click="changeStatus(row, 2)">开播</el-button>
            <el-button v-if="Number(row.status) === 2" link type="warning" size="small" @click="changeStatus(row, 3)">下播</el-button>
            <el-popconfirm v-if="Number(row.status) <= 2" title="取消排班仅打状态标记，可追溯。确认取消？" @confirm="changeStatus(row, 4)">
              <template #reference><el-button link type="danger" size="small">取消</el-button></template>
            </el-popconfirm>
            <el-button link type="info" size="small" @click="goReview(row)">复盘</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑排班' : '新建排班'" width="640px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="店铺" prop="shop_id">
              <el-select v-model="form.shop_id" filterable placeholder="必填" style="width: 100%">
                <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="直播账号">
              <el-select v-model="form.account_id" filterable clearable placeholder="选填，账号决定冲突判定" style="width: 100%">
                <el-option v-for="a in accounts" :key="a.id" :label="a.handle" :value="a.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="计划开播" prop="plan_start">
              <el-date-picker v-model="form.plan_start" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="计划下播" prop="plan_end">
              <el-date-picker v-model="form.plan_end" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="主播">
              <el-select v-model="form.host_id" filterable clearable placeholder="选填" style="width: 100%">
                <el-option v-for="u in users" :key="u.id" :label="`${u.real_name}${u.dept ? `（${u.dept}）` : ''}`" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="场控">
              <el-select v-model="form.assistant_id" filterable clearable placeholder="选填" style="width: 100%">
                <el-option v-for="u in users" :key="u.id" :label="u.real_name" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="嘉宾达人">
              <el-select v-model="form.creator_id" filterable clearable placeholder="选填" style="width: 100%">
                <el-option v-for="c in creators" :key="c.id" :label="`@${c.handle}`" :value="c.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-select v-model="form.status" style="width: 100%">
                <el-option v-for="o in LIVE_STATUS" :key="String(o.value)" :label="o.label" :value="o.value" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { ArrowLeft, ArrowRight, Plus, RefreshLeft, Search } from '@element-plus/icons-vue';
import type { LiveSession, PageResult } from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg } from '@/api/client';
import { useDictStore } from '@/stores/dict';
import type { RowLike } from '@/types/row';

type Row = LiveSession & Record<string, unknown>;

const dict = useDictStore();
const route = useRoute();
const router = useRouter();

/** live_session.status：1 已排班 / 2 直播中 / 3 已结束 / 4 取消 */
const LIVE_STATUS = [
  { value: 1, label: '已排班', type: 'primary' as const },
  { value: 2, label: '直播中', type: 'success' as const },
  { value: 3, label: '已结束', type: 'info' as const },
  { value: 4, label: '已取消', type: 'danger' as const },
];

const shops = ref<{ id: number; shop_name: string }[]>([]);
const accounts = ref<{ id: number; handle: string }[]>([]);
const users = ref<{ id: number; real_name: string; dept?: string | null }[]>([]);
const creators = ref<{ id: number; handle: string }[]>([]);

const loading = ref(false);
const saving = ref(false);
const rows = ref<Row[]>([]);
const calendarDate = ref(new Date());
const pickedDay = ref(todayText());
const dialogVisible = ref(false);
const editing = ref<Row | null>(null);
const formRef = ref<FormInstance>();
// 表单字段由 openCreate / openEdit 按弹窗分支动态写入，el-* 的 v-model 需要具体类型，故用 any 收口
const form = reactive<Record<string, any>>({});

const query = reactive<{ shop_id?: number; status?: number; keyword?: string }>({
  shop_id: route.query.shop_id ? Number(route.query.shop_id) : undefined,
  status: 1,
  keyword: '',
});

const rules: FormRules = {
  shop_id: [{ required: true, message: '请选择店铺', trigger: 'change' }],
  plan_start: [{ required: true, message: '请选择计划开播时间', trigger: 'change' }],
  plan_end: [{ required: true, message: '请选择计划下播时间', trigger: 'change' }],
};

const dayRows = computed(() => rows.value.filter((r) => localDay(r.plan_start) === pickedDay.value));

function statusLabel(v: unknown): string {
  if (v === undefined || v === null) return '-';
  return LIVE_STATUS.find((o) => String(o.value) === String(v))?.label ?? String(v);
}
function statusType(v: unknown): 'primary' | 'success' | 'info' | 'danger' | 'warning' {
  return LIVE_STATUS.find((o) => String(o.value) === String(v))?.type ?? 'info';
}

/* ---- 时间工具：后端存 UTC 文本，前端按浏览器时区展示 ---- */
const pad = (n: number) => String(n).padStart(2, '0');
const dayText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseUtc(v: unknown): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function todayText(): string {
  return dayText(new Date());
}
function localDay(v: unknown): string {
  const d = parseUtc(v);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hm(v: unknown): string {
  const d = parseUtc(v);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '-';
}
/** 浏览器本地时间字符串 → UTC 文本（提交后端） */
function toUtcText(local: unknown): string | undefined {
  const s = String(local ?? '').trim();
  if (!s) return undefined;
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}
function durationText(row: RowLike): string {
  const a = parseUtc(row.plan_start);
  const b = parseUtc(row.plan_end);
  if (!a || !b || b <= a) return '-';
  const min = Math.round((b.getTime() - a.getTime()) / 60000);
  return `${Math.floor(min / 60)} 小时 ${pad(min % 60)} 分`;
}
function byDay(day: string): Row[] {
  return rows.value.filter((r) => localDay(r.plan_start) === day).sort((x, y) => String(x.plan_start).localeCompare(String(y.plan_start)));
}
function shiftDay(offset: number): void {
  const [y, m, d] = pickedDay.value.split('-').map(Number);
  const nd = new Date(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + offset);
  pickedDay.value = dayText(nd);
  calendarDate.value = nd;
}

/** 覆盖日历可视月份（含前置 7 天缓冲） */
function rangeOfMonth(day: string): { from: string; to: string } {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(y ?? 2026, (m ?? 1) - 1, 1);
  const last = new Date(y ?? 2026, m ?? 1, 0);
  return { from: dayText(new Date(first.getFullYear(), first.getMonth(), first.getDate() - 7)), to: dayText(last) };
}

async function reload(): Promise<void> {
  const { from, to } = rangeOfMonth(pickedDay.value);
  loading.value = true;
  try {
    const data = await apiGet<PageResult<Row>>('/content/lives', {
      page: 1,
      pageSize: 200,
      plan_start_from: from,
      plan_start_to: to,
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
      sortBy: 'plan_start',
      sortOrder: 'asc',
    });
    rows.value = data.list ?? [];
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function resetQuery(): void {
  query.shop_id = undefined;
  query.status = 1;
  query.keyword = '';
  void reload();
}

function openCreate(day?: string): void {
  editing.value = null;
  for (const k of Object.keys(form)) delete form[k];
  const base = day ?? pickedDay.value;
  Object.assign(form, {
    shop_id: query.shop_id,
    status: 1,
    plan_start: `${base} 19:00:00`,
    plan_end: `${base} 22:00:00`,
  });
  dialogVisible.value = true;
}

function openDay(row: Row): void {
  pickedDay.value = localDay(row.plan_start);
  openEdit(row);
}

function openEdit(raw: RowLike): void {
  const row = raw as Row;
  editing.value = row;
  for (const k of Object.keys(form)) delete form[k];
  Object.assign(form, {
    shop_id: row.shop_id,
    account_id: row.account_id ?? undefined,
    host_id: row.host_id ?? undefined,
    assistant_id: row.assistant_id ?? undefined,
    creator_id: row.creator_id ?? undefined,
    plan_start: utcToLocalText(row.plan_start),
    plan_end: utcToLocalText(row.plan_end),
    status: row.status,
  });
  dialogVisible.value = true;
}

/** UTC 文本 → 本地 'YYYY-MM-DD HH:mm:ss'（供 datetime 选择器回填） */
function utcToLocalText(v: unknown): string {
  const d = parseUtc(v);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

async function doSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  const ps = toUtcText(form.plan_start);
  const pe = toUtcText(form.plan_end);
  if (ps && pe && ps >= pe) {
    ElMessage.error('计划下播必须晚于计划开播');
    return;
  }
  const body: Record<string, unknown> = { ...form, plan_start: ps, plan_end: pe };
  for (const k of ['account_id', 'host_id', 'assistant_id', 'creator_id']) if (body[k] === '' || body[k] === undefined) delete body[k];
  saving.value = true;
  try {
    if (editing.value) await apiPut(`/content/lives/${editing.value.id}`, body);
    else await apiPost('/content/lives', body);
    ElMessage.success('排班已保存');
    dialogVisible.value = false;
    void reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function changeStatus(raw: RowLike, status: number): Promise<void> {
  const row = raw as Row;
  const body: Record<string, unknown> = { status };
  if (status === 2) body.actual_start = toUtcText(nowLocal());
  if (status === 3) {
    body.actual_end = toUtcText(nowLocal());
    if (!row.actual_start) body.actual_start = String(row.plan_start ?? '');
  }
  try {
    await apiPut(`/content/lives/${row.id}`, body);
    ElMessage.success(status === 4 ? '排班已取消' : status === 2 ? '已标记开播' : '已标记下播，请去复盘页补数据');
    void reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function goReview(raw: RowLike): void {
  const row = raw as Row;
  void router.push({ path: '/lives', query: { id: String(row.id), shop_id: String(row.shop_id) } });
}

watch(calendarDate, (d) => {
  pickedDay.value = dayText(d);
  void reload();
});

onMounted(async () => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
  const [acc, usr, cre] = await Promise.allSettled([
    apiGet<PageResult<Record<string, unknown>>>('/accounts', { page: 1, pageSize: 200 }),
    apiGet<PageResult<Record<string, unknown>>>('/system/users', { page: 1, pageSize: 200 }),
    apiGet<PageResult<Record<string, unknown>>>('/creators', { page: 1, pageSize: 200 }),
  ]);
  const list = (r: PromiseSettledResult<{ list: Record<string, unknown>[] }>) => (r.status === 'fulfilled' ? (r.value.list ?? []) : []);
  accounts.value = list(acc) as { id: number; handle: string }[];
  users.value = list(usr) as { id: number; real_name: string; dept?: string | null }[];
  creators.value = list(cre) as { id: number; handle: string }[];
  if (route.query.date) pickedDay.value = String(route.query.date);
  void reload();
});
</script>

<style scoped>
.cell {
  height: 100%;
  padding: 2px;
}
.cell-day {
  font-weight: 600;
}
.cell-other {
  opacity: 0.45;
}
.cell-item {
  font-size: 12px;
  line-height: 18px;
  border-left: 3px solid #dcdfe6;
  padding-left: 4px;
  margin-top: 2px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cell-item.st-1 { border-left-color: #409eff; }
.cell-item.st-2 { border-left-color: #67c23a; }
.cell-item.st-3 { border-left-color: #909399; }
.cell-item.st-4 { border-left-color: #f56c6c; text-decoration: line-through; }
.cell-time { color: #409eff; margin-right: 4px; }
.cell-text { color: #606266; }
.cell-more { font-size: 12px; color: #909399; }
</style>
