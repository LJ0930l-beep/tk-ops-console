<template>
  <div class="page">
    <el-alert
      class="page-tip"
      type="info"
      show-icon
      :closable="false"
      title="寄样成本为下单时 SKU 成本快照（后续改价不回溯）；红底 = 超期未出内容，黄底 = 已签收临近 7 天出内容期限。样品单回填 tk_order_id 后该订单不计 GMV。"
    />
    <ResourcePage
      ref="rp"
      api="/creators/sample"
      title="寄样单"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :createable="true"
      :editable="true"
      :deletable="false"
      :can-write="true"
      :map-row="mapRow"
      :before-submit="beforeSubmit"
      :row-class-name="rowClass"
      :default-page-size="20"
      dialog-width="760px"
      :action-width="230"
    >
      <template #toolbar-extra>
        <el-button :icon="Star" @click="router.push('/creators/collab')">去合作单登记寄样</el-button>
      </template>
      <template #actions="{ row, reload }">
        <el-button v-if="canShip(row)" link type="primary" size="small" @click="openAct('ship', row)">发货</el-button>
        <el-button v-if="canSign(row)" link type="success" size="small" @click="openAct('sign', row)">登记签收</el-button>
        <el-button v-if="canContent(row)" link type="warning" size="small" @click="mark(row, 'content', reload)">标记已出内容</el-button>
        <el-popconfirm v-if="canLost(row)" title="标记丢件后该样品成本仍计入达人 ROI 分母，确认？" @confirm="mark(row, 'lost', reload)">
          <template #reference><el-button link type="danger" size="small">丢件</el-button></template>
        </el-popconfirm>
      </template>
    </ResourcePage>

    <!-- 发货 / 签收 -->
    <el-dialog v-model="act.visible" :title="act.mode === 'ship' ? '寄样发货' : '登记签收'" width="480px" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="寄样单">
          <span>{{ act.row?.creator_handle ?? '-' }} / {{ act.row?.sku_code ?? '未选 SKU' }} × {{ act.row?.quantity ?? '-' }}</span>
        </el-form-item>
        <template v-if="act.mode === 'ship'">
          <el-form-item label="承运单号" required>
            <el-input v-model="act.tracking_no" placeholder="如 JNT2026091800123（status=在途 必填）" />
          </el-form-item>
          <el-form-item label="发货时间">
            <el-date-picker v-model="act.ship_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
          </el-form-item>
        </template>
        <el-form-item v-else label="签收时间" required>
          <el-date-picker v-model="act.sign_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
        <el-form-item>
          <span class="sub">发货后合作单自动「待寄样 → 样品在途」；签收后 {{ dueDays }} 天内无内容将置为「超期未出内容」。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="act.visible = false">取消</el-button>
        <el-button type="primary" :loading="act.saving" @click="submitAct">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Star } from '@element-plus/icons-vue';
import { SAMPLE_STATUS } from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg } from '@/api/client';
import ResourcePage from '@/components/ResourcePage.vue';
import type { ColumnDef, FormFieldDef, OptionDef, SearchDef } from '@/components/ResourcePage.vue';

type Row = Record<string, unknown>;

const router = useRouter();
const rp = ref<InstanceType<typeof ResourcePage> | null>(null);
/** 出内容期限（config.sampleContentDueDays 默认 7 天，前端仅用于高亮提示） */
const dueDays = 7;

const statusOptions: OptionDef[] = [
  { value: SAMPLE_STATUS.TO_SHIP, label: '待发', type: 'info' },
  { value: SAMPLE_STATUS.IN_TRANSIT, label: '在途', type: 'primary' },
  { value: SAMPLE_STATUS.SIGNED, label: '已签收', type: 'warning' },
  { value: SAMPLE_STATUS.CONTENT_DONE, label: '已出内容', type: 'success' },
  { value: SAMPLE_STATUS.OVERDUE, label: '超期未出内容', type: 'danger' },
  { value: SAMPLE_STATUS.LOST, label: '丢件', type: 'danger' },
];
const methodOptions: OptionDef[] = [
  { value: 1, label: '平台免费样品', type: 'primary' },
  { value: 2, label: '线下自寄', type: 'success' },
  { value: 3, label: '海外仓代发', type: 'warning' },
];

const creatorOpts = ref<{ value: number; label: string }[]>([]);
const skuOpts = ref<{ value: number; label: string }[]>([]);
const collabOpts = ref<{ value: number; label: string }[]>([]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'status', label: '状态', type: 'select', options: statusOptions },
  { key: 'creator_id', label: '达人', type: 'select', options: creatorOpts.value },
  { key: 'collab_id', label: '合作单', type: 'select', options: collabOpts.value },
  { key: 'ship_method', label: '寄样方式', type: 'select', options: methodOptions },
  { key: 'ship_time', label: '发货时间', type: 'daterange' },
  { key: 'overdue', label: '超期未出内容', type: 'select', options: [{ value: 1, label: '仅看超期' }] },
  { key: 'keyword', label: '关键字', type: 'text', placeholder: '达人 handle / 合作单号 / 快递单号 / SKU 编码' },
]);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'collab_no', label: '合作单号', width: 150 },
  { prop: 'creator_handle', label: '达人', width: 160 },
  { prop: 'sku_code', label: 'SKU', width: 140 },
  { prop: 'spu_name', label: '商品(SPU)', minWidth: 140 },
  { prop: 'quantity', label: '数量', width: 70 },
  { prop: 'sample_cost', label: '样品成本(CNY)🔒', type: 'money', width: 135 },
  { prop: 'shipping_cost', label: '运费(CNY)🔒', type: 'money', width: 120 },
  { prop: 'ship_method', label: '寄样方式', width: 120, type: 'tag', options: methodOptions },
  { prop: 'tk_order_id', label: '平台样品单号', width: 170 },
  { prop: 'tracking_no', label: '快递单号', width: 170 },
  { prop: 'ship_time', label: '发货时间', type: 'datetime', width: 145 },
  { prop: 'sign_time', label: '签收时间', type: 'datetime', width: 145 },
  { prop: 'status', label: '状态', width: 130, type: 'tag', options: statusOptions },
  { prop: 'video_count', label: '关联视频', width: 90 },
  { prop: 'due_text', label: '出内容期限', width: 150 },
  { prop: 'created_by_name', label: '登记人', width: 100 },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'creator_id', label: '达人', type: 'select', required: true, options: () => creatorOpts.value, span: 8 },
  { key: 'collab_id', label: '关联合作单', type: 'select', options: () => collabOpts.value, span: 8, placeholder: '可空（非合作寄样）' },
  { key: 'sku_id', label: '寄样 SKU', type: 'select', options: () => skuOpts.value, span: 8, placeholder: '空 = 手工填成本' },
  { key: 'quantity', label: '数量', type: 'number', required: true, min: 1, precision: 0, default: 1, span: 8 },
  { key: 'sample_cost', label: '样品成本(CNY)', type: 'number', min: 0, precision: 2, default: 0, span: 8, placeholder: '选 SKU 时后端按成本快照覆盖' },
  { key: 'shipping_cost', label: '运费(CNY)', type: 'number', min: 0, precision: 2, default: 0, span: 8 },
  { key: 'ship_method', label: '寄样方式', type: 'select', required: true, options: methodOptions, default: 2, span: 8 },
  { key: 'tk_order_id', label: '平台样品单号', span: 8, placeholder: 'ship_method=平台免费样品必填' },
  { key: 'tracking_no', label: '快递单号', span: 8 },
  { key: 'ship_time', label: '发货时间', type: 'datetime', span: 8 },
  { key: 'sign_time', label: '签收时间', type: 'datetime', span: 8 },
  { key: 'status', label: '状态', type: 'select', required: true, options: statusOptions, default: SAMPLE_STATUS.TO_SHIP, span: 8 },
]);

/* ---------- 派生：出内容期限提示（due_date / due_days 由后端按 config.sampleContentDueDays 下发） ---------- */
function ts(v: unknown): number {
  if (!v) return 0;
  const s = String(v).replace(' ', 'T');
  return Date.parse(s + (s.endsWith('Z') ? '' : 'Z'));
}
function dayLeft(dateText: unknown): number {
  return Math.round((Date.parse(`${String(dateText).slice(0, 10)}T23:59:59`) - Date.now()) / 86400000);
}
function mapRow(row: Row): Row {
  const st = Number(row.status ?? 0);
  if (st === SAMPLE_STATUS.CONTENT_DONE) return { ...row, due_text: '已出内容' };
  if (st === SAMPLE_STATUS.LOST) return { ...row, due_text: '丢件·不计内容' };
  if (st === SAMPLE_STATUS.OVERDUE) return { ...row, due_text: '已超期·请催内容' };
  const due = row.due_date ? String(row.due_date) : '';
  if (due) {
    const left = dayLeft(due);
    return { ...row, due_text: left > 0 ? `剩 ${left} 天（${due.slice(0, 10)}）` : `超期 ${-left} 天·请催内容` };
  }
  if (st === SAMPLE_STATUS.SIGNED && ts(row.sign_time)) {
    const days = Number(row.due_days ?? dueDays);
    const left = days - Math.floor((Date.now() - ts(row.sign_time)) / 86400000);
    return { ...row, due_text: left > 0 ? `剩 ${left} 天` : `超期 ${-left} 天·请催内容` };
  }
  return { ...row, due_text: st === SAMPLE_STATUS.IN_TRANSIT ? '签收后起算' : '-' };
}
function rowClass({ row }: { row: Row }): string {
  const st = Number(row.status ?? 0);
  if (st === SAMPLE_STATUS.OVERDUE || st === SAMPLE_STATUS.LOST) return 'danger-row';
  if (st === SAMPLE_STATUS.SIGNED && String(row.due_text ?? '').startsWith('超期')) return 'danger-row';
  if (st === SAMPLE_STATUS.TO_SHIP) return 'warning-row';
  return '';
}

/* ---------- 按钮可用性（后端逐条校验：已签收不能再置在途、丢件不能签收、已出内容不能再改） ---------- */
const OPEN_STATES: number[] = [SAMPLE_STATUS.TO_SHIP, SAMPLE_STATUS.IN_TRANSIT, SAMPLE_STATUS.SIGNED, SAMPLE_STATUS.OVERDUE];
const canShip = (r: Row) => Number(r.status ?? 0) === SAMPLE_STATUS.TO_SHIP || Number(r.status ?? 0) === SAMPLE_STATUS.IN_TRANSIT;
const canSign = (r: Row) => Number(r.status ?? 0) === SAMPLE_STATUS.IN_TRANSIT || Number(r.status ?? 0) === SAMPLE_STATUS.OVERDUE;
const canContent = (r: Row) => Number(r.status ?? 0) === SAMPLE_STATUS.SIGNED || Number(r.status ?? 0) === SAMPLE_STATUS.OVERDUE;
const canLost = (r: Row) => OPEN_STATES.includes(Number(r.status ?? 0));

function beforeSubmit(values: Row): Row {
  const v = { ...values };
  if (Number(v.ship_method) === 1 && !v.tk_order_id) ElMessage.warning('平台免费样品必须回填平台样品单号，后端会校验（400）');
  if (Number(v.status) === SAMPLE_STATUS.IN_TRANSIT && !v.tracking_no) ElMessage.warning('状态=在途必须填快递单号，后端会校验（400）');
  if (Number(v.status) === SAMPLE_STATUS.SIGNED && !v.sign_time) ElMessage.warning('状态=已签收必须填签收时间，后端会校验（400）');
  if (!v.sku_id && !Number(v.sample_cost)) ElMessage.warning('未选 SKU 时请手工填样品成本，避免成本漏计');
  return v;
}

/* ---------- 发货 / 签收 / 状态标记 ---------- */
const act = reactive({
  visible: false,
  mode: 'ship' as 'ship' | 'sign',
  row: null as Row | null,
  tracking_no: '',
  ship_time: '',
  sign_time: '',
  saving: false,
});
const nowStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function openAct(mode: 'ship' | 'sign', row: Row) {
  act.mode = mode;
  act.row = row;
  act.tracking_no = String(row.tracking_no ?? '');
  act.ship_time = String(row.ship_time ?? nowStr());
  act.sign_time = String(row.sign_time ?? nowStr());
  act.visible = true;
}

async function submitAct() {
  const row = act.row;
  if (!row) return;
  if (act.mode === 'ship' && !act.tracking_no.trim()) return ElMessage.warning('请填写快递单号');
  act.saving = true;
  try {
    if (act.mode === 'ship') {
      await apiPost(`/creators/sample/${String(row.id)}/ship`, {
        tracking_no: act.tracking_no.trim(),
        ship_time: act.ship_time || nowStr(),
      });
      ElMessage.success('已发货，状态置为在途，合作单自动推进');
    } else {
      await apiPost(`/creators/sample/${String(row.id)}/sign`, { sign_time: act.sign_time || nowStr() });
      ElMessage.success(`已登记签收，${dueDays} 天内需出内容，合作单自动转「待发布」`);
    }
    act.visible = false;
    rp.value?.reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    act.saving = false;
  }
}

/**
 * 出内容 / 丢件。
 * 后端没有 /sample/:id/content 接口：内容中心给视频挂上合作单（或夜间作业）会自动置 4，
 * 这里用 PUT /creators/sample/:id 的 status 做人工兜底。
 */
async function mark(row: Row, action: 'content' | 'lost', reload: () => void) {
  try {
    if (action === 'content') await apiPut(`/creators/sample/${String(row.id)}`, { status: SAMPLE_STATUS.CONTENT_DONE });
    else await apiPost(`/creators/sample/${String(row.id)}/lost`, {});
    ElMessage.success(action === 'content' ? '已标记出内容' : '已标记丢件（成本仍计入达人 ROI 分母）');
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

/* ---------- 下拉数据（复用各列表接口，同权限与数据范围） ---------- */
function toOpts(rows: unknown, label: (r: Row) => string) {
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .filter((r) => r.id !== undefined && r.id !== null)
    .map((r) => ({ value: Number(r.id), label: label(r) }));
}
/** 兼容分页对象 {list} 与纯数组（/products/spu/all 直接返回数组） */
async function fetchOpts(path: string, label: (r: Row) => string) {
  try {
    const data = await apiGet<Row | Row[]>(path, { page: 1, pageSize: 200 });
    const rows = Array.isArray(data) ? data : (data as Row)?.list;
    return toOpts(rows, label);
  } catch {
    return [] as { value: number; label: string }[];
  }
}
async function loadOptions() {
  [creatorOpts.value, skuOpts.value, collabOpts.value] = await Promise.all([
    fetchOpts('/creators', (r) => `@${String(r.handle ?? '')}${r.nickname ? `（${String(r.nickname)}）` : ''}`),
    fetchOpts('/products/sku', (r) => `${String(r.sku_code ?? '')}${r.spec ? ` ${String(r.spec)}` : ''}`),
    fetchOpts('/creators/collab', (r) => `${String(r.collab_no ?? '')} @${String(r.creator_handle ?? '')}`),
  ]);
}

onMounted(() => {
  void loadOptions();
});
</script>

<style scoped>
.page-tip {
  margin-bottom: 12px;
}
.sub {
  color: #909399;
  font-size: 12px;
}
:deep(.warning-row td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(.danger-row td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
