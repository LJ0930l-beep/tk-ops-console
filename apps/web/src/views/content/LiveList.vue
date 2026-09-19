<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <el-form-item label="店铺">
          <el-select v-model="query.shop_id" clearable placeholder="全部" style="width: 160px" @change="reload(1)">
            <el-option v-for="s in shops" :key="s.id" :label="s.shop_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="主播">
          <el-select v-model="query.host_id" filterable clearable placeholder="全部" style="width: 150px" @change="reload(1)">
            <el-option v-for="u in users" :key="u.id" :label="u.real_name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" clearable placeholder="全部" style="width: 120px" @change="reload(1)">
            <el-option v-for="o in LIVE_STATUS" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="计划时间">
          <el-date-picker
            v-model="planRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始"
            end-placeholder="结束"
            style="width: 240px"
            clearable
            @change="reload(1)"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reload(1)">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
          <ImportDialog table="live_session" button-text="导入直播数据" @done="() => reload()" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="复盘口径：viewers / peak_online / orders / gmv 由同步或导入填充，ad_spend 默认取自同店铺同日 ad_type=2（GMV Max 直播）的广告消耗，可在复盘弹窗内覆盖。仅「已结束」场次允许编辑。"
      />
    </el-card>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
        :row-class-name="rowClass"
        style="width: 100%"
        show-summary
        :summary-method="summary"
        @sort-change="onSort"
      >
        <el-table-column label="计划时段" width="180" fixed="left">
          <template #default="{ row }">{{ dt(row.plan_start) }} ~ {{ dt(row.plan_end) }}</template>
        </el-table-column>
        <el-table-column prop="shop_name" label="店铺" min-width="120" show-overflow-tooltip />
        <el-table-column prop="host_name" label="主播" width="90" />
        <el-table-column label="实际时长" width="110" align="right">
          <template #default="{ row }">{{ minutesText(actualMinutes(row)) }}</template>
        </el-table-column>
        <el-table-column label="实际起止" width="170">
          <template #default="{ row }">{{ row.actual_start ? `${dt(row.actual_start)} ~ ${row.actual_end ? dt(row.actual_end) : '进行中'}` : '-' }}</template>
        </el-table-column>
        <el-table-column prop="viewers" label="累计观看" width="95" align="right" sortable="custom">
          <template #default="{ row }">{{ int(row.viewers) }}</template>
        </el-table-column>
        <el-table-column prop="peak_online" label="峰值在线" width="95" align="right">
          <template #default="{ row }">{{ int(row.peak_online) }}</template>
        </el-table-column>
        <el-table-column prop="orders" label="订单" width="80" align="right">
          <template #default="{ row }">{{ int(row.orders) }}</template>
        </el-table-column>
        <el-table-column prop="gmv" label="GMV" width="110" align="right" sortable="custom">
          <template #default="{ row }">{{ money(row.gmv) }}</template>
        </el-table-column>
        <el-table-column prop="ad_spend" label="广告消耗" width="105" align="right">
          <template #default="{ row }">{{ money(row.ad_spend) }}</template>
        </el-table-column>
        <el-table-column label="GMV/小时" width="110" align="right">
          <template #default="{ row }">{{ money(gmvPerHour(row)) }}</template>
        </el-table-column>
        <el-table-column label="千次观看成交额" width="130" align="right">
          <template #default="{ row }">{{ money(gmvPer1k(row)) }}</template>
        </el-table-column>
        <el-table-column prop="review_note" label="复盘摘要" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.review_note">{{ row.review_note }}</span>
            <el-tag v-else size="small" type="warning">未复盘</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="168" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="Number(row.status) !== 3" @click="openCurve(row)">
              分钟曲线
            </el-button>
            <el-button link type="primary" size="small" :disabled="Number(row.status) !== 3" @click="openReview(row)">
              填写复盘
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="所选条件下没有直播场次">
            <el-button type="primary" @click="router.push('/lives/schedule')">去排班</el-button>
          </el-empty>
        </template>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 12px; justify-content: flex-end"
        @current-change="reload()"
        @size-change="reload(1)"
      />
    </el-card>

    <el-dialog v-model="dialogVisible" title="直播复盘" width="640px" destroy-on-close>
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="24">
            <el-form-item label="场次">
              <span>{{ current?.shop_name }} · {{ dt(current?.plan_start) }} ~ {{ dt(current?.plan_end) }}</span>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="实际开播">
              <el-date-picker v-model="form.actual_start" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="实际下播">
              <el-date-picker v-model="form.actual_end" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="累计观看">
              <el-input-number v-model="form.viewers" :min="0" :precision="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="峰值在线">
              <el-input-number v-model="form.peak_online" :min="0" :precision="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="订单数">
              <el-input-number v-model="form.orders" :min="0" :precision="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="GMV">
              <el-input-number v-model="form.gmv" :min="0" :precision="2" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="广告消耗">
              <el-input-number v-model="form.ad_spend" :min="0" :precision="2" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="实际时长">
              <span>{{ minutesText(formMinutes) }}</span>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="复盘纪要">
              <el-input v-model="form.review_note" type="textarea" :rows="4" maxlength="1000" show-word-limit placeholder="流程问题 / 话术与选品结论 / 待办跟进" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存复盘</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="curveVisible" title="直播分钟曲线" width="860px" destroy-on-close @closed="disposeCurve">
      <div v-loading="curveLoading">
        <div class="curve-sub" v-if="curveRow">
          {{ curveRow.shop_name }} · {{ dt(curveRow.plan_start) }} ~ {{ dt(curveRow.plan_end) }}
          <span class="curve-tip">在线人数 / GMV / 付费流量占比（广告叠加层）按分钟还原</span>
        </div>
        <div ref="curveEl" class="curve-box" />
        <el-empty v-if="!curveLoading && !curveRows.length" :image-size="60" description="该场次暂无分钟级数据（需同步或导入 analytics_live_minute）" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import * as echarts from 'echarts';
import type { LiveSession, PageResult } from '@tk/shared';
import { num, round2 } from '@tk/shared';
import { apiGet, apiPut, errMsg } from '@/api/client';
import ImportDialog from '@/components/ImportDialog.vue';
import { useDictStore } from '@/stores/dict';

type Row = LiveSession & Record<string, unknown>;

const dict = useDictStore();
const route = useRoute();
const router = useRouter();

const LIVE_STATUS = [
  { value: 1, label: '已排班', type: 'primary' as const },
  { value: 2, label: '直播中', type: 'success' as const },
  { value: 3, label: '已结束', type: 'info' as const },
  { value: 4, label: '已取消', type: 'danger' as const },
];

const shops = ref<{ id: number; shop_name: string }[]>([]);
const users = ref<{ id: number; real_name: string }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const saving = ref(false);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const sortBy = ref('plan_start');
const sortOrder = ref('desc');
const planRange = ref<[string, string] | null>(null);
const dialogVisible = ref(false);
const current = ref<Row | null>(null);
const form = reactive<Record<string, number | string | undefined>>({});

const query = reactive<{ shop_id?: number; host_id?: number; status?: number }>({
  shop_id: route.query.shop_id ? Number(route.query.shop_id) : undefined,
  host_id: undefined,
  status: 3,
});

const formMinutes = computed(() => diffMinutes(form.actual_start, form.actual_end));

function statusLabel(v: unknown): string {
  return LIVE_STATUS.find((o) => String(o.value) === String(v ?? ''))?.label ?? String(v ?? '-');
}
function statusType(v: unknown): 'primary' | 'success' | 'info' | 'danger' | 'warning' {
  return LIVE_STATUS.find((o) => String(o.value) === String(v ?? ''))?.type ?? 'info';
}

/* ---- 时间与格式化 ---- */
const pad = (n: number) => String(n).padStart(2, '0');
const dayText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseUtc(v: unknown): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function dt(v: unknown): string {
  const d = parseUtc(v);
  return d ? `${dayText(d).slice(5)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '-';
}
function utcText(local: unknown): string | undefined {
  const s = String(local ?? '').trim();
  if (!s) return undefined;
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}
function localText(v: unknown): string {
  const d = parseUtc(v);
  if (!d) return '';
  return `${dayText(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function diffMinutes(a: unknown, b: unknown): number {
  const x = parseUtc(a);
  const y = parseUtc(b);
  if (!x || !y || y <= x) return 0;
  return Math.round((y.getTime() - x.getTime()) / 60000);
}
const minutesText = (m: number) => (m > 0 ? `${Math.floor(m / 60)} 小时 ${pad(m % 60)} 分` : '-');
const int = (v: unknown) => (v === null || v === undefined ? '-' : num(v).toLocaleString('zh-CN'));
const money = (v: unknown) => (v === '***' ? '***' : num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* ---- 派生指标（PRD §3.6 直播复盘） ---- */
const actualMinutes = (row: Row) => diffMinutes(row.actual_start, row.actual_end) || diffMinutes(row.plan_start, row.plan_end);
const gmvPerHour = (row: Row) => {
  const m = actualMinutes(row);
  return m > 0 ? round2((num(row.gmv) / m) * 60) : 0;
};
const gmvPer1k = (row: Row) => (num(row.viewers) > 0 ? round2((num(row.gmv) / num(row.viewers)) * 1000) : 0);
const rowClass = ({ row }: { row: Row }) => (row.review_note ? '' : 'unreviewed-row');

async function reload(resetPage?: number): Promise<void> {
  if (resetPage) page.value = resetPage;
  loading.value = true;
  try {
    const data = await apiGet<PageResult<Row>>('/content/lives', {
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      plan_start_from: planRange.value?.[0],
      plan_start_to: planRange.value?.[1],
      ...Object.fromEntries(
        Object.entries(query as Record<string, unknown>).filter(([, v]) => v !== '' && v !== undefined && v !== null),
      ),
    });
    rows.value = data.list ?? [];
    total.value = data.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function resetQuery(): void {
  query.shop_id = undefined;
  query.host_id = undefined;
  query.status = 3;
  planRange.value = null;
  void reload(1);
}

function onSort({ prop, order }: { prop: string; order: string | null }): void {
  sortBy.value = order ? prop : 'plan_start';
  sortOrder.value = order === 'ascending' ? 'asc' : order === 'descending' ? 'desc' : 'desc';
  void reload();
}

function openReview(row: Row): void {
  current.value = row;
  for (const k of Object.keys(form)) delete form[k];
  Object.assign(form, {
    actual_start: localText(row.actual_start),
    actual_end: localText(row.actual_end),
    viewers: num(row.viewers),
    peak_online: num(row.peak_online),
    orders: num(row.orders),
    gmv: num(row.gmv),
    ad_spend: num(row.ad_spend),
    review_note: String(row.review_note ?? ''),
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!current.value) return;
  if (form.actual_start && form.actual_end && String(form.actual_start) >= String(form.actual_end)) {
    ElMessage.error('实际下播必须晚于实际开播');
    return;
  }
  const body: Record<string, unknown> = {
    actual_start: utcText(form.actual_start),
    actual_end: utcText(form.actual_end),
    viewers: form.viewers,
    peak_online: form.peak_online,
    orders: form.orders,
    gmv: form.gmv,
    ad_spend: form.ad_spend,
    review_note: form.review_note,
  };
  saving.value = true;
  try {
    await apiPut(`/content/lives/${current.value.id}`, body);
    ElMessage.success('复盘已保存');
    dialogVisible.value = false;
    void reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

/* ---- 直播分钟曲线（§3.6 直播复盘：在线/GMV/付费流量叠加层，按分钟还原） ---- */
interface MinuteRow {
  minute_ts: string;
  online_users: number;
  product_click: number;
  orders: number;
  gmv: number;
  paid_traffic_ratio: number;
  source: string;
}
const curveVisible = ref(false);
const curveLoading = ref(false);
const curveRow = ref<Row | null>(null);
const curveRows = ref<MinuteRow[]>([]);
const curveEl = ref<HTMLDivElement>();
let curveChart: echarts.ECharts | null = null;

const hhmm = (ts: string): string => {
  const d = parseUtc(ts);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : String(ts).slice(11, 16);
};

function renderCurve(): void {
  if (!curveEl.value) return;
  if (!curveChart) curveChart = echarts.init(curveEl.value);
  const rows = curveRows.value;
  curveChart.setOption(
    {
      tooltip: { trigger: 'axis' },
      legend: { data: ['在线人数', 'GMV', '付费流量占比'], bottom: 0 },
      grid: { left: 56, right: 100, top: 24, bottom: 44 },
      xAxis: { type: 'category', data: rows.map((r) => hhmm(r.minute_ts)) },
      yAxis: [
        { type: 'value', name: '在线', position: 'left' },
        { type: 'value', name: 'GMV', position: 'right', splitLine: { show: false } },
        { type: 'value', name: '付费%', position: 'right', offset: 54, min: 0, max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } },
      ],
      series: [
        { name: 'GMV', type: 'bar', yAxisIndex: 1, barMaxWidth: 12, itemStyle: { color: '#91cc75', opacity: 0.7 }, data: rows.map((r) => round2(num(r.gmv))) },
        { name: '在线人数', type: 'line', yAxisIndex: 0, smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 }, lineStyle: { color: '#409eff' }, itemStyle: { color: '#409eff' }, data: rows.map((r) => num(r.online_users)) },
        { name: '付费流量占比', type: 'line', yAxisIndex: 2, smooth: true, showSymbol: false, lineStyle: { type: 'dashed', color: '#e6a23c' }, itemStyle: { color: '#e6a23c' }, data: rows.map((r) => round2(num(r.paid_traffic_ratio) * 100)) },
      ],
    },
    true,
  );
}

async function openCurve(row: Row): Promise<void> {
  curveRow.value = row;
  curveRows.value = [];
  curveVisible.value = true;
  curveLoading.value = true;
  try {
    const d = await apiGet<{ list: MinuteRow[] }>(`/actions/analytics/live/${row.id}/minutes`);
    curveRows.value = d.list ?? [];
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    curveLoading.value = false;
  }
  await nextTick();
  await nextTick();
  if (curveRows.value.length) renderCurve();
}

function disposeCurve(): void {
  curveChart?.dispose();
  curveChart = null;
}

/** 合计行：本页汇总（全量汇总需服务端聚合，见接口缺口说明） */
function summary({ columns: cols, data }: { columns: { property: string }[]; data: Row[] }): string[] {
  const sum = (f: (r: Row) => number) => round2(data.reduce((a, r) => a + f(r), 0));
  return cols.map((c, i) => {
    if (i === 0) return '本页合计';
    switch (c.property) {
      case 'viewers':
        return int(sum((r) => num(r.viewers)));
      case 'peak_online':
        return int(sum((r) => num(r.peak_online)));
      case 'orders':
        return int(sum((r) => num(r.orders)));
      case 'gmv':
        return money(sum((r) => num(r.gmv)));
      case 'ad_spend':
        return money(sum((r) => num(r.ad_spend)));
      default:
        return '';
    }
  });
}

onMounted(async () => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
  try {
    const usr = await apiGet<PageResult<Record<string, unknown>>>('/system/users', { page: 1, pageSize: 200 });
    users.value = (usr.list ?? []) as { id: number; real_name: string }[];
  } catch {
    /* 无 system 菜单权限时静默：主播筛选不可用 */
  }
  if (route.query.status) query.status = Number(route.query.status);
  await reload(1);
  const id = route.query.id ? Number(route.query.id) : 0;
  const target = id ? rows.value.find((r) => Number(r.id) === id) : undefined;
  if (target && Number(target.status) === 3) openReview(target);
});

onUnmounted(disposeCurve);
</script>

<style scoped>
.el-table :deep(.unreviewed-row) {
  background: #fdf6ec;
}
.curve-box {
  height: 360px;
}
.curve-sub {
  font-size: 13px;
  color: #606266;
  margin-bottom: 8px;
}
.curve-tip {
  color: #909399;
  font-size: 12px;
  margin-left: 8px;
}
</style>
