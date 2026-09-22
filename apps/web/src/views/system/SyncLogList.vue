<template>
  <div>
    <el-card class="health-card" shadow="never">
      <div class="head">
        <div>
          <span class="title">同步健康度</span>
          <span class="tip">每店每任务最近一次执行结果；<b class="bad">红色</b> 为失败或部分失败，共 {{ badCount }} 项异常。</span>
        </div>
        <el-button :icon="Refresh" :loading="healthLoading" @click="loadHealth">刷新</el-button>
      </div>

      <div v-loading="healthLoading" class="health-body">
        <div v-for="g in healthByShop" :key="String(g.shop_name)" class="shop-block">
          <div class="shop-name">{{ g.shop_name }}</div>
          <div class="cards">
            <el-tooltip v-for="(h, i) in g.items" :key="i" :content="h.error_msg ? sanitize(h.error_msg) : '执行正常'" placement="top">
              <div class="hcard" :class="Number(h.status) >= 2 ? 'bad' : 'ok'">
                <div class="hcard-top">
                  <span class="task">{{ taskLabel(h.task_type) }}</span>
                  <el-tag size="small" :type="statusTag(h.status)">{{ statusLabel(h.status) }}</el-tag>
                </div>
                <div class="hcard-meta">
                  <span>{{ fmtDateTime(h.started_at) }}</span>
                  <span>取 {{ num(h.fetched) }} / 失败 {{ num(h.failed) }}</span>
                </div>
              </div>
            </el-tooltip>
          </div>
        </div>
        <el-empty v-if="!healthLoading && !health.length" description="暂无同步记录：店铺授权后由定时任务写入，或用下方「立即重跑」手动补数据" :image-size="60" />
      </div>
    </el-card>

    <ResourcePage
      ref="rp"
      api="/system/synclog"
      title="同步日志"
      :columns="columns"
      :search-fields="searchFields"
      :extra-query="extraQuery"
      :map-row="mapRow"
      :createable="false"
      :editable="false"
      :deletable="false"
      :can-write="false"
      :row-class-name="rowClass"
      :action-width="90"
    >
      <template #toolbar-extra>
        <el-form inline class="inline-form" @submit.prevent>
          <el-form-item label="开始时间">
            <el-date-picker
              v-model="range"
              type="daterange"
              value-format="YYYY-MM-DD"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 240px"
              clearable
              @change="reloadFirst"
            />
          </el-form-item>
          <el-form-item>
            <el-button :icon="RefreshLeft" @click="resetAll">重置时间</el-button>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="VideoPlay" @click="openRun()">立即重跑</el-button>
          </el-form-item>
        </el-form>
      </template>

      <template #actions="{ row }">
        <el-button v-if="Number(row.status) >= 2" link type="warning" size="small" @click="openRun(row)">重跑该任务</el-button>
      </template>
    </ResourcePage>

    <el-dialog v-model="runVisible" title="立即重跑同步任务" width="560px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
        <template #default>提交 <code>POST /api/sync/run</code>，按时间窗口增量补跑（窗口会自动与既有重叠窗口对齐）；结果写入一条 sync_log。不填窗口＝接上次 <code>window_end</code> 继续，首次默认最近 24 小时；要重算历史区间必须显式填窗口。</template>
      </el-alert>
      <el-form :model="runForm" label-width="110px">
        <el-form-item label="任务类型" required>
          <el-select v-model="runForm.task_type" filterable style="width: 100%">
            <el-option v-for="o in RUN_TASK_OPTIONS" :key="String(o.value)" :label="o.label" :value="String(o.value)" />
          </el-select>
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="runForm.shop_id" clearable filterable placeholder="不选＝全部可见店铺" style="width: 100%">
            <el-option v-for="o in shopOpts" :key="String(o.value)" :label="o.label" :value="Number(o.value)" />
          </el-select>
        </el-form-item>
        <el-form-item label="窗口开始">
          <el-date-picker v-model="runForm.window_start" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
        <el-form-item label="窗口结束">
          <el-date-picker v-model="runForm.window_end" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="runVisible = false">取消</el-button>
        <el-button type="primary" :loading="running" @click="doRun">开始同步</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, RefreshLeft, VideoPlay } from '@element-plus/icons-vue';
import { apiGet, apiPost, errMsg, type Paged } from '@/api/client';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const dict = useDictStore();
const rp = ref();

/** sync_log.task_type 的展示名：日志里会出现定时任务/导入写入的历史类型，展示要全 */
const TASK_LABELS: Record<string, string> = {
  order: 'order 订单',
  listing: 'listing 店铺商品',
  product: 'product 平台商品',
  returns: 'returns 售后退款',
  affiliate: 'affiliate 联盟归因回填',
  affiliate_order: 'affiliate_order 联盟订单',
  aggregate: 'aggregate 派生汇总刷新',
  all: 'all 一键全量补跑',
  settlement: 'settlement 结算流水',
  ad: 'ad 广告日报',
  video: 'video 视频数据',
  live: 'live 直播数据',
};
/** 筛选下拉：日志里可能出现的都列上 */
const TASK_OPTIONS: OptionDef[] = Object.entries(TASK_LABELS).map(([value, label]) => ({ value, label }));
/**
 * 「立即重跑」可提交的类型必须与后端 sync.routes.ts 的 TASK_TYPES 逐字一致：
 * 多一项就是 400 Invalid enum value（结算/广告/视频/直播各有自己的入口，不走 /sync/run），
 * 少一项则界面上根本点不到宽表刷新与一键全量补跑。
 */
const RUN_TASK_OPTIONS: OptionDef[] = ['order', 'listing', 'product', 'returns', 'affiliate_order', 'aggregate', 'all'].map((v) => ({
  value: v,
  label: TASK_LABELS[v],
}));
const STATUS_OPTIONS: OptionDef[] = [
  { value: 1, label: '成功', type: 'success' },
  { value: 2, label: '部分失败', type: 'warning' },
  { value: 3, label: '失败', type: 'danger' },
];

const shopOpts = ref<OptionDef[]>([]);
onMounted(async () => {
  const shops = await dict.shopOptions().catch(() => []);
  shopOpts.value = (shops ?? []).map((s) => ({ value: s.id, label: s.shop_name }));
  await loadHealth();
});

const taskLabel = (v: unknown) => TASK_LABELS[String(v ?? '')] ?? String(v ?? '—');
const statusLabel = (v: unknown) => String(STATUS_OPTIONS.find((o) => Number(o.value) === Number(v))?.label ?? v ?? '—');
const statusTag = (v: unknown) => STATUS_OPTIONS.find((o) => Number(o.value) === Number(v))?.type ?? 'info';
const num = (v: unknown) => Number(v ?? 0);
const fmtDateTime = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');

/** 凭证不回显：错误信息里的 secret/token/密码类键值一律替换为 *** */
function sanitize(v: unknown) {
  return String(v ?? '')
    .replace(/([A-Za-z_]*(?:app_key|app_secret|secret|token|password|api_key|access_key|authorization)[A-Za-z_]*)("|')?(\s*[:=]\s*)("|')?[^\s,;&"']+/gi, '$1$2$3$4***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***');
}

/* ---------- 健康度摘要 ---------- */
interface Health {
  shop_id: number | null;
  shop_name: string | null;
  task_type: string;
  status: number;
  fetched: number;
  failed: number;
  started_at: string | null;
  error_msg: string | null;
}
const healthLoading = ref(false);
const health = ref<Health[]>([]);
const healthByShop = computed(() => {
  const map = new Map<string, Health[]>();
  for (const h of health.value) {
    const key = String(h.shop_name ?? '（全店任务）');
    if (!map.has(key)) map.set(key, []);
    map.get(key)?.push(h);
  }
  return [...map.entries()].map(([shop_name, items]) => ({ shop_name, items }));
});
const badCount = computed(() => health.value.filter((h) => Number(h.status) >= 2).length);

async function loadHealth() {
  healthLoading.value = true;
  try {
    health.value = await apiGet<Health[]>('/system/synclog/health');
  } catch (e) {
    health.value = [];
    // 失败必须说一声：静默成空列表，界面就只显示「暂无数据」，
    // 用户和排障的人都分不出是「真没有」还是「接口挂了」（本轮就是这么被 /system/dict 骗过的）
    ElMessage.error(errMsg(e));
  } finally {
    healthLoading.value = false;
  }
}

/* ---------- 明细列表 ---------- */
const columns = computed<ColumnDef[]>(() => [
  { prop: 'started_at', label: '开始时间', width: 150, type: 'datetime', fixed: 'left' },
  { prop: 'task_type', label: '任务', width: 180 },
  { prop: 'shop_name', label: '店铺', width: 150 },
  { prop: 'window', label: '同步窗口', minWidth: 240 },
  { prop: 'fetched', label: '拉取', width: 80 },
  { prop: 'inserted', label: '新增', width: 80 },
  { prop: 'updated', label: '更新', width: 80 },
  { prop: 'failed', label: '失败', width: 80 },
  { prop: 'status', label: '状态', width: 100, type: 'tag', options: STATUS_OPTIONS },
  { prop: 'error_msg', label: '错误信息', minWidth: 220 },
  { prop: 'finished_at', label: '结束时间', width: 150, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'task_type', label: '任务类型', type: 'select', options: TASK_OPTIONS },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts.value },
  { key: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]);

/** 后端时间区间参数名为 start_date / end_date（作用于 started_at） */
const range = ref<[string, string] | null>(null);
const extraQuery = computed<Record<string, unknown>>(() => ({ start_date: range.value?.[0], end_date: range.value?.[1] }));

function reloadFirst() {
  rp.value?.reload(1);
}
function resetAll() {
  range.value = null;
  rp.value?.reload(1);
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const s = row.window_start ? String(row.window_start).replace('T', ' ').slice(0, 16) : '';
  const e = row.window_end ? String(row.window_end).replace('T', ' ').slice(0, 16) : '';
  return { ...row, window: s || e ? `${s || '—'} ~ ${e || '—'}` : '—', error_msg: sanitize(row.error_msg) };
}

function rowClass({ row }: { row: Record<string, unknown> }): string {
  return Number(row.status) >= 2 ? 'sync-row-danger' : '';
}

/* ---------- 立即重跑 ---------- */
const runVisible = ref(false);
const running = ref(false);
const runForm = reactive<{ task_type: string; shop_id?: number; window_start?: string; window_end?: string }>({ task_type: 'order' });

function openRun(row?: Record<string, unknown>) {
  runForm.task_type = String(row?.task_type ?? 'order');
  runForm.shop_id = row?.shop_id == null ? undefined : Number(row.shop_id);
  runForm.window_start = row?.window_start ? String(row.window_start).replace(' ', 'T').slice(0, 16).replace('T', ' ') : undefined;
  runForm.window_end = row?.window_end ? String(row.window_end).replace(' ', 'T').slice(0, 16).replace('T', ' ') : undefined;
  runVisible.value = true;
}

async function doRun() {
  if (!runForm.task_type) return ElMessage.warning('请选择任务类型');
  running.value = true;
  try {
    const res = await apiPost<{ task_type?: string; shop_ids?: number[]; runs?: { window_start?: string; window_end?: string }[]; summary?: Record<string, number> }>(
      '/sync/run',
      {
        task_type: runForm.task_type,
        shop_id: runForm.shop_id,
        window_start: runForm.window_start,
        window_end: runForm.window_end,
      },
    );
    // 计数在 summary 里，窗口在 runs 里：不填窗口时后端只算增量（接上次窗口，首次＝最近 24 小时），
    // 不把实际窗口回显出来，用户会把「窗口没覆盖到数据」误读成「重算成功但没数据」。
    const s = res?.summary ?? {};
    const w = res?.runs?.[0];
    const win = w?.window_start && w?.window_end ? `，窗口 ${String(w.window_start).slice(0, 16)} ~ ${String(w.window_end).slice(0, 16)}` : '';
    ElMessage.success(
      `已执行 ${String(res?.task_type ?? runForm.task_type)}（${res?.shop_ids?.length ?? 0} 家店${win}）：拉取 ${num(s.fetched)} 条，新增 ${num(s.inserted)}，更新 ${num(s.updated)}，失败 ${num(s.failed)}`,
    );
    runVisible.value = false;
    rp.value?.reload(1);
    await loadHealth();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    running.value = false;
  }
}
</script>

<style scoped>
.health-card {
  margin: 16px 16px 0;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}
.tip {
  color: #909399;
  font-size: 12px;
}
.bad {
  color: #f56c6c;
}
.health-body {
  min-height: 60px;
  max-height: 240px;
  overflow: auto;
}
.shop-block {
  margin-bottom: 8px;
}
.shop-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.hcard {
  width: 210px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 6px 8px;
  background: #fff;
}
.hcard.ok {
  border-left: 3px solid #67c23a;
}
.hcard.bad {
  border-left: 3px solid #f56c6c;
  background: #fef0f0;
}
.hcard-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
}
.hcard-meta {
  display: flex;
  justify-content: space-between;
  color: #909399;
  font-size: 12px;
  margin-top: 2px;
}
.inline-form {
  margin-bottom: 0;
}
.inline-form :deep(.el-form-item) {
  margin-bottom: 0;
}
:deep(tr.sync-row-danger td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
