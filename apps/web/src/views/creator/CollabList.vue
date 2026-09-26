<template>
  <div class="page">
    <el-alert
      class="page-tip"
      type="info"
      show-icon
      :closable="false"
      title="状态流：已谈妥 → 待寄样 → 样品在途 → 待发布 → 已发布 → 已完结；超期未出内容由夜间作业置为「超期未履约」，任意状态可取消（需主管/老板）。坑位费>0 时点「生成费用」建待付款费用（幂等，重复点击不重复建）。合作单只记我们掏出去的钱（佣金 / 坑位费 / 寄样运费）：品牌给的返点率在 SKU 上维护，佣金若由品牌代付就把佣金率填 0，同一笔钱不许两边各记一次。"
    />
    <ResourcePage
      ref="rp"
      api="/creators/collab"
      title="合作单"
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
      :row-class-name="rowClass"
      :default-page-size="20"
      dialog-width="760px"
      :action-width="280"
    >
      <template #toolbar-extra>
        <el-button :icon="Star" @click="router.push('/creators/mine')">从我的达人建单</el-button>
      </template>
      <template #actions="{ row, reload }">
        <el-dropdown v-if="nextOf(row).length" trigger="click" @command="(s: number) => changeStatus(row, s, reload)">
          <el-button link type="warning" size="small">推进状态<el-icon><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="s in nextOf(row)" :key="s" :command="s">{{ statusLabel(s) }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="hasFee(row)" link type="success" size="small" :loading="feeBusy === Number(row.id)" @click="genExpense(row, reload)">生成费用</el-button>
        <el-button link type="primary" size="small" :loading="roiBusy === Number(row.id)" @click="showRoi(row)">投产比</el-button>
      </template>
      <template #toolbar="{ query }">
        <ExportButton url="/creators/collab/export" name="creators-collab" :params="query" />
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, Star } from '@element-plus/icons-vue';
import { COLLAB_STATUS, MASK } from '@tk/shared';
import { apiGet, apiPost, errMsg, type ApiPath } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';
import { useDictStore } from '@/stores/dict';

type Row = Record<string, unknown>;

const route = useRoute();
const router = useRouter();
const dict = useDictStore();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);
const feeBusy = ref(0);

const coopOptions: OptionDef[] = [
  { value: 1, label: '纯佣金', type: 'success' },
  { value: 2, label: '坑位费+佣金', type: 'warning' },
  { value: 3, label: '付费视频', type: 'primary' },
  { value: 4, label: '直播专场', type: 'danger' },
];
const statusOptions: OptionDef[] = [
  { value: COLLAB_STATUS.AGREED, label: '已谈妥', type: 'primary' },
  { value: COLLAB_STATUS.TO_SHIP, label: '待寄样', type: 'warning' },
  { value: COLLAB_STATUS.IN_TRANSIT, label: '样品在途', type: 'warning' },
  { value: COLLAB_STATUS.TO_PUBLISH, label: '待发布', type: 'info' },
  { value: COLLAB_STATUS.PUBLISHED, label: '已发布', type: 'success' },
  { value: COLLAB_STATUS.FINISHED, label: '已完结', type: 'success' },
  { value: COLLAB_STATUS.OVERDUE, label: '超期未履约', type: 'danger' },
  { value: COLLAB_STATUS.CANCELLED, label: '已取消', type: 'info' },
];
/** 合法流转表（与后端 COLLAB_FLOW 一致，非法流转后端 400；取消需主管/老板） */
const NEXT: Record<number, number[]> = {
  [COLLAB_STATUS.AGREED]: [COLLAB_STATUS.TO_SHIP, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.TO_SHIP]: [COLLAB_STATUS.IN_TRANSIT, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.IN_TRANSIT]: [COLLAB_STATUS.TO_PUBLISH, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.TO_PUBLISH]: [COLLAB_STATUS.PUBLISHED, COLLAB_STATUS.OVERDUE, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.PUBLISHED]: [COLLAB_STATUS.FINISHED, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.FINISHED]: [],
  [COLLAB_STATUS.OVERDUE]: [COLLAB_STATUS.PUBLISHED, COLLAB_STATUS.FINISHED, COLLAB_STATUS.CANCELLED],
  [COLLAB_STATUS.CANCELLED]: [],
};
const statusLabel = (v: number) => statusOptions.find((o) => o.value === Number(v))?.label ?? String(v);

const extraQuery = reactive<Row>({});
const creatorOpts = ref<{ value: number; label: string }[]>([]);
const spuOpts = ref<{ value: number; label: string }[]>([]);
const shopOpts = computed<OptionDef[]>(() => dict.shops.map((s) => ({ value: s.id, label: s.shop_name })));
const routeCreatorId = computed(() => Number(route.query.creator_id ?? 0) || undefined);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', type: 'text', placeholder: '合作单号 / 达人 handle / 店铺名' },
  { key: 'creator_id', label: '达人', type: 'select', options: creatorOpts.value },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts.value },
  { key: 'coop_type', label: '合作方式', type: 'select', options: coopOptions },
  { key: 'status', label: '状态', type: 'select', options: statusOptions },
  { key: 'deadline', label: '履约截止', type: 'daterange' },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'collab_no', label: '合作单号', width: 150 },
  { prop: 'creator_handle', label: '达人', width: 160 },
  { prop: 'shop_name', label: '店铺', width: 130 },
  { prop: 'spu_name', label: '商品(SPU)', minWidth: 150 },
  { prop: 'coop_type', label: '合作方式', width: 120, type: 'tag', options: coopOptions },
  { prop: 'commission_rate', label: '佣金率', type: 'percent', width: 90 },
  { prop: 'fixed_fee', label: '坑位费🔒', type: 'money', width: 120 },
  { prop: 'fee_currency', label: '币种', width: 70 },
  { prop: 'promised_text', label: '承诺内容', width: 130 },
  { prop: 'published_text', label: '已发布/差距', width: 120 },
  { prop: 'sample_count', label: '寄样数', width: 80 },
  { prop: 'fee_cny', label: '已生成费用(CNY)🔒', type: 'money', width: 150 },
  { prop: 'deadline', label: '履约截止', type: 'date', width: 110 },
  { prop: 'status', label: '状态', width: 110, type: 'tag', options: statusOptions },
  { prop: 'owner_name', label: '归属 BD', width: 100 },
  { prop: 'tk_plan_id', label: '联盟计划 ID', width: 150 },
  { prop: 'created_at', label: '建单时间', type: 'datetime', width: 145 },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'creator_id', label: '达人', type: 'select', required: true, options: () => creatorOpts.value, default: routeCreatorId.value, span: 8, disabledOnEdit: true },
  { key: 'shop_id', label: '店铺', type: 'select', required: true, options: () => shopOpts.value, span: 8, disabledOnEdit: true },
  { key: 'spu_id', label: '商品(SPU)', type: 'select', options: () => spuOpts.value, span: 8, placeholder: '可空（多品合作）' },
  { key: 'coop_type', label: '合作方式', type: 'select', required: true, options: coopOptions, default: 1, span: 8 },
  { key: 'commission_rate', label: '佣金率(%)', type: 'number', min: 0, max: 100, precision: 2, default: 0, span: 8, placeholder: '填百分数：18 = 18%；品牌代付达人佣金时填 0' },
  { key: 'fixed_fee', label: '坑位费金额🔒', type: 'number', min: 0, precision: 2, default: 0, span: 8, placeholder: '坑位费>0 才可生成费用' },
  { key: 'fee_currency', label: '坑位费币种', span: 8, placeholder: '如 USD（3 位）', default: 'USD' },
  { key: 'promised_videos', label: '承诺视频数', type: 'number', min: 0, precision: 0, default: 1, span: 8 },
  { key: 'promised_lives', label: '承诺直播数', type: 'number', min: 0, precision: 0, default: 0, span: 8 },
  { key: 'deadline', label: '履约截止', type: 'date', span: 8 },
  { key: 'tk_plan_id', label: '联盟计划 ID', span: 8 },
]);

/* ---------- 展示派生 ---------- */
function roiText(v: unknown): string {
  if (v === MASK) return MASK;
  if (v === undefined || v === null || v === '') return '—';
  return Number(v).toFixed(2);
}
function mapRow(row: Row): Row {
  const pv = Number(row.promised_videos ?? 0);
  const pl = Number(row.promised_lives ?? 0);
  const videos = Number(row.video_count ?? 0);
  const gap = Number(row.videos_gap ?? Math.max(0, pv - videos));
  const ok = row.publish_ok;
  return {
    ...row,
    promised_text: `${pv} 视频 / ${pl} 直播`,
    published_text: ok === true ? `已发布 ${videos} 达标` : ok === false ? `已发布 ${videos}（差 ${gap}）` : `已发布 ${videos}`,
  };
}

function hasFee(row: Row): boolean {
  return row.fixed_fee !== MASK && Number(row.fixed_fee ?? 0) > 0;
}
function nextOf(row: Row): number[] {
  return NEXT[Number(row.status ?? 0)] ?? [];
}
/** 已超期未完结 或 状态=超期未履约 → 红底 */
const OVERDUE_RISK: number[] = [COLLAB_STATUS.AGREED, COLLAB_STATUS.TO_SHIP, COLLAB_STATUS.IN_TRANSIT, COLLAB_STATUS.TO_PUBLISH];
function rowClass({ row }: { row: Row }): string {
  const st = Number(row.status ?? 0);
  if (st === COLLAB_STATUS.OVERDUE) return 'danger-row';
  const dl = row.deadline ? Date.parse(`${String(row.deadline).slice(0, 10)}T23:59:59`) : 0;
  if (dl && dl < Date.now() && OVERDUE_RISK.includes(st)) return 'warning-row';
  return '';
}

function beforeSubmit(values: Row): Row {
  const v = { ...values };
  for (const k of ['commission_rate', 'fixed_fee', 'promised_videos', 'promised_lives']) {
    if (v[k] === undefined || v[k] === null) delete v[k];
  }
  if (typeof v.fee_currency === 'string') v.fee_currency = v.fee_currency.trim().toUpperCase();
  if (Number(v.coop_type) !== 1 && !Number(v.fixed_fee)) ElMessage.warning('非纯佣金合作未填坑位费，后端可能拒绝（400）');
  return v;
}

/* ---------- 操作 ---------- */
async function changeStatus(row: Row, status: number, reload: () => void) {
  try {
    await apiPost(`/creators/collab/${String(row.id)}/status`, { status });
    ElMessage.success(`${String(row.collab_no ?? '')} 状态已推进为「${statusLabel(status)}」`);
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

/** 生成待付款费用：expense_type=1 坑位费，ref_type='collaboration'，幂等 */
async function genExpense(row: Row, reload: () => void) {
  feeBusy.value = Number(row.id);
  try {
    const res = await apiPost<Row>(`/creators/collab/${String(row.id)}/expense`);
    ElMessage.success(res?.existed === true ? '该合作单坑位费费用已存在' : '已生成待付款坑位费费用（重复点击不会重复建）');
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    feeBusy.value = 0;
  }
}

/** 单合作投产比：GET /creators/collab/:id（响应含 roi 聚合，无成本权限时后端已掩码） */
const roiBusy = ref(0);
async function showRoi(row: Row) {
  roiBusy.value = Number(row.id);
  try {
    const d = await apiGet<Row>(`/creators/collab/${String(row.id)}`);
    const r = (d?.roi ?? d ?? {}) as Row;
    const text = [
      `应收返点(CNY)：${moneyText(r.rebate_cny)}　←我们的收入`,
      `寄样运费(CNY)：${moneyText(r.sample_shipping)}　坑位费(CNY)：${moneyText(r.fixed_fee_cny)}　达人佣金(CNY)：${moneyText(r.commission_cny)}`,
      `投入合计(CNY)：${moneyText(r.cost)}　投产比(返点÷投入)：${roiText(r.roi)}`,
      `带货净 GMV(CNY，品牌的生意规模，只作参考)：${moneyText(r.net_gmv_cny)}`,
      `出单数：${String(r.orders ?? '—')}　已发布视频：${String(d?.video_count ?? '—')} / 承诺 ${String(d?.promised_videos ?? '—')}`,
      '说明：投产比的分子是品牌给我们的返点，不是带货 GMV；样品货值由品牌承担，不计在我们投入里。',
    ].join('\n');
    try {
      await ElMessageBox.alert(h('div', { style: 'white-space: pre-line' }, text), `合作单 ${String(row.collab_no ?? '')} 投产比（返点 ÷ 投入）`, { confirmButtonText: '关闭' });
    } catch {
      /* 用户直接关闭 */
    }
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    roiBusy.value = 0;
  }
}
function moneyText(v: unknown): string {
  return v === MASK ? MASK : v === undefined || v === null || v === '' ? '—' : Number(v).toFixed(2);
}

/* ---------- 下拉数据（复用各自列表接口，与 /creators、/products/spus 同权限） ---------- */
function toOpts(rows: unknown, label: (r: Row) => string) {
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .filter((r) => r.id !== undefined && r.id !== null)
    .map((r) => ({ value: Number(r.id), label: label(r) }));
}
async function fetchOpts(path: ApiPath, label: (r: Row) => string) {
  try {
    const data = await apiGet<Row | Row[]>(path, { page: 1, pageSize: 200 });
    const rows = Array.isArray(data) ? data : (data as Row)?.list;
    return toOpts(rows, label);
  } catch (e) {
    ElMessage.warning(errMsg(e));
    return [] as { value: number; label: string }[];
  }
}
async function loadOptions() {
  const opts = await Promise.all([
    fetchOpts('/creators', (r) => `@${String(r.handle ?? '')}${r.nickname ? `（${String(r.nickname)}）` : ''}`),
    fetchOpts('/products/spu/all', (r) => `${String(r.spu_code ?? '')} ${String(r.name_cn ?? '')}`),
  ]);
  creatorOpts.value = opts[0];
  spuOpts.value = opts[1];
}

const pendingCreate = ref(false);
function applyRouteQuery() {
  if (route.name !== 'collab') return;
  const cid = Number(route.query.creator_id ?? 0);
  if (cid > 0) extraQuery.creator_id = cid;
  else delete extraQuery.creator_id;
  if (route.query.action === 'new') pendingCreate.value = true;
}
/** 过滤条件必须在 ResourcePage 首次拉数据前生效 */
applyRouteQuery();

watch(() => route.fullPath, applyRouteQuery);

onMounted(async () => {
  await Promise.all([dict.shopOptions().catch(() => undefined), loadOptions()]);
  if (pendingCreate.value) {
    pendingCreate.value = false;
    rp.value?.openCreate();
  }
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(.danger-row td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
