<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <el-form-item label="仓库">
          <el-select v-model="query.warehouse_id" clearable placeholder="全部" style="width: 160px" @change="reload(1)">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="变动类型">
          <el-select v-model="query.change_type" clearable placeholder="全部" style="width: 130px" @change="reload(1)">
            <el-option v-for="o in CHANGE_TYPE" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="SKU">
          <el-select v-model="query.sku_id" filterable clearable remote :remote-method="searchSku" placeholder="编码/规格" style="width: 180px" @change="reload(1)">
            <el-option v-for="s in skus" :key="s.id" :label="`${s.sku_code}${s.spec ? ` / ${s.spec}` : ''}`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="单号">
          <el-input v-model="query.keyword" clearable placeholder="ref_no 平台单号" style="width: 170px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item label="操作时间">
          <el-date-picker
            v-model="timeRange"
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
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="流水只可追加与冲销，历史行不可编辑：销售出库 / 退货入库 / 样品出库由服务自动生成（幂等键 ref_no + change_type + sku_id）；手工录入仅用于盘点与补录。入库为正、出库为负。"
      />
      <div style="margin-top: 8px">
        <el-button type="primary" :icon="Plus" @click="openCreate()">手工录入流水</el-button>
      </div>
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
        @sort-change="onSort"
      >
        <el-table-column prop="op_time" label="操作时间" width="160" sortable="custom">
          <template #default="{ row }">{{ dateTime(row.op_time) }}</template>
        </el-table-column>
        <el-table-column prop="warehouse_name" label="仓库" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.warehouse_name || (row.warehouse_id ? `#${row.warehouse_id}` : '-') }}</template>
        </el-table-column>
        <el-table-column prop="sku_code" label="SKU" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.sku_code || (row.sku_id ? `#${row.sku_id}` : '-') }}</template>
        </el-table-column>
        <el-table-column prop="spec" label="规格" min-width="120" show-overflow-tooltip />
        <el-table-column prop="change_type" label="变动类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="changeTag(row.change_type)">{{ changeLabel(row.change_type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="quantity" label="数量" width="100" align="right" sortable="custom">
          <template #default="{ row }">
            <span :class="num(row.quantity) < 0 ? 'out' : 'in'">{{ signedQty(row.quantity) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ref_no" label="关联单号" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作人" width="100">
          <template #default="{ row }">{{ row.operator_name || '系统' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="warning" size="small" @click="openReverse(row)">冲销</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有出入库流水：先维护仓库与 SKU，或手工录入一笔盘点">
            <el-button type="primary" @click="router.push('/stock/warehouse')">去仓库管理</el-button>
          </el-empty>
        </template>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 12px; justify-content: flex-end"
        @current-change="reload()"
        @size-change="reload(1)"
      />
    </el-card>

    <el-dialog v-model="dialogVisible" title="手工录入出入库流水" width="600px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="仓库" prop="warehouse_id">
              <el-select v-model="form.warehouse_id" filterable placeholder="必填" style="width: 100%">
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="SKU" prop="sku_id">
              <el-select v-model="form.sku_id" filterable remote :remote-method="searchSku" placeholder="输入编码搜索" style="width: 100%">
                <el-option v-for="s in skus" :key="s.id" :label="`${s.sku_code}${s.spec ? ` / ${s.spec}` : ''}`" :value="s.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="变动类型" prop="change_type">
              <el-select v-model="form.change_type" style="width: 100%">
                <el-option v-for="o in CHANGE_TYPE" :key="String(o.value)" :label="o.label" :value="o.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数量" prop="quantity">
              <el-input-number v-model="form.quantity" :step="1" :precision="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="操作时间" prop="op_time">
              <el-date-picker v-model="form.op_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联单号">
              <el-input v-model="form.ref_no" maxlength="64" placeholder="如 PO2026000 / 平台订单号" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert :type="qtyHint.type" :closable="false" show-icon :title="qtyHint.text" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { Plus, RefreshLeft, Search } from '@element-plus/icons-vue';
import type { PageResult, StockLedger } from '@tk/shared';
import { num } from '@tk/shared';
import { apiGet, apiPost, errMsg } from '@/api/client';

type Row = StockLedger & Record<string, unknown>;

const route = useRoute();
const router = useRouter();

/** stock_ledger.change_type：入库类型为正、出库类型为负（约定见 PRD §3.9） */
const CHANGE_TYPE = [
  { value: 1, label: '采购入库', type: 'success' as const },
  { value: 2, label: '头程发货', type: 'warning' as const },
  { value: 3, label: '调拨', type: 'primary' as const },
  { value: 4, label: '销售出库', type: 'danger' as const },
  { value: 5, label: '样品出库', type: 'danger' as const },
  { value: 6, label: '退货入库', type: 'success' as const },
  { value: 7, label: '盘点调整', type: 'info' as const },
];
/** 出库方向（数量为负）的变动类型 */
const OUTBOUND = [2, 4, 5];

const warehouses = ref<{ id: number; name: string }[]>([]);
const skus = ref<{ id: number; sku_code: string; spec?: string | null }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const saving = ref(false);
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);
const sortBy = ref('op_time');
const sortOrder = ref('desc');
const timeRange = ref<[string, string] | null>(null);
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<Record<string, number | string | undefined>>({});

const query = reactive<{ warehouse_id?: number; change_type?: number; sku_id?: number; keyword?: string }>({
  warehouse_id: route.query.warehouse_id ? Number(route.query.warehouse_id) : undefined,
  change_type: undefined,
  sku_id: undefined,
  keyword: '',
});

const rules: FormRules = {
  warehouse_id: [{ required: true, message: '请选择仓库', trigger: 'change' }],
  sku_id: [{ required: true, message: '请选择 SKU', trigger: 'change' }],
  change_type: [{ required: true, message: '请选择变动类型', trigger: 'change' }],
  quantity: [
    { required: true, message: '请输入数量', trigger: 'blur' },
    {
      validator: (_r: unknown, value: unknown, cb: (e?: Error) => void) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n === 0) cb(new Error('数量不能为 0（入库为正、出库为负）'));
        else cb();
      },
    },
  ],
  op_time: [{ required: true, message: '请选择操作时间', trigger: 'change' }],
};

const changeLabel = (v: unknown) => CHANGE_TYPE.find((o) => String(o.value) === String(v ?? ''))?.label ?? String(v ?? '-');
const changeTag = (v: unknown) => CHANGE_TYPE.find((o) => String(o.value) === String(v ?? ''))?.type ?? 'info';
const signedQty = (v: unknown) => {
  const n = num(v);
  return `${n > 0 ? '+' : ''}${n.toLocaleString('zh-CN')}`;
};
/** 数量符号与变动类型方向一致性提示（入库正 / 出库负，调拨与盘点双向） */
const qtyHint = computed<{ type: 'success' | 'warning' | 'error'; text: string }>(() => {
  const n = num(form.quantity);
  const ct = Number(form.change_type);
  const qtyText = signedQty(n);
  if (n === 0) return { type: 'error', text: '数量不能为 0：入库填正数、出库填负数' };
  if (OUTBOUND.includes(ct)) {
    return n < 0
      ? { type: 'success', text: `当前 ${qtyText} —— 出库方向，符号正确` }
      : { type: 'warning', text: `当前 ${qtyText} —— 该类型为出库方向，通常应填负数，请确认` };
  }
  if (ct === 3 || ct === 7) return { type: 'success', text: `当前 ${qtyText} —— 调拨 / 盘点按实际方向取正负` };
  return n > 0
    ? { type: 'success', text: `当前 ${qtyText} —— 入库方向，符号正确` }
    : { type: 'warning', text: `当前 ${qtyText} —— 该类型为入库方向，通常应填正数，请确认` };
});
const rowClass = ({ row }: { row: Row }) => (num(row.quantity) < 0 ? 'out-row' : '');

function dateTime(v: unknown): string {
  const s = String(v ?? '');
  return s ? s.replace('T', ' ').slice(0, 16) : '-';
}

async function reload(resetPage?: number): Promise<void> {
  if (resetPage) page.value = resetPage;
  loading.value = true;
  try {
    const data = await apiGet<PageResult<Row>>('/stock/ledger', {
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      op_time_from: timeRange.value?.[0],
      op_time_to: timeRange.value?.[1],
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
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
  query.warehouse_id = undefined;
  query.change_type = undefined;
  query.sku_id = undefined;
  query.keyword = '';
  timeRange.value = null;
  void reload(1);
}

function onSort({ prop, order }: { prop: string; order: string | null }): void {
  sortBy.value = order ? prop : 'op_time';
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc';
  void reload();
}

async function searchSku(keyword: string): Promise<void> {
  try {
    const data = await apiGet<PageResult<Record<string, unknown>>>('/products/skus', { page: 1, pageSize: 50, keyword });
    skus.value = (data.list ?? []) as { id: number; sku_code: string; spec?: string | null }[];
  } catch {
    /* SKU 接口未就绪时下拉为空，仍可手填 ID 之外的字段 */
  }
}

function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
/** 浏览器本地时间 → UTC 文本（后端统一存 UTC） */
function toUtcText(local: unknown): string | undefined {
  const s = String(local ?? '').trim();
  if (!s) return undefined;
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

function openCreate(): void {
  for (const k of Object.keys(form)) delete form[k];
  Object.assign(form, {
    warehouse_id: query.warehouse_id,
    sku_id: query.sku_id,
    change_type: 1,
    quantity: 1,
    op_time: nowLocal(),
    ref_no: '',
  });
  dialogVisible.value = true;
}

function openReverse(row: Row): void {
  for (const k of Object.keys(form)) delete form[k];
  Object.assign(form, {
    warehouse_id: row.warehouse_id,
    sku_id: row.sku_id,
    change_type: row.change_type,
    quantity: -num(row.quantity),
    op_time: nowLocal(),
    ref_no: `${String(row.ref_no ?? `#${row.id}`)}-REV`,
  });
  dialogVisible.value = true;
}

async function doSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  const qty = Number(form.quantity);
  const body = {
    warehouse_id: form.warehouse_id,
    sku_id: form.sku_id,
    change_type: form.change_type,
    quantity: qty,
    ref_no: form.ref_no || undefined,
    op_time: toUtcText(form.op_time),
  };
  saving.value = true;
  try {
    await apiPost('/stock/ledger', body);
    ElMessage.success('流水已追加');
    dialogVisible.value = false;
    void reload(1);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const data = await apiGet<PageResult<Record<string, unknown>>>('/stock/warehouses', { page: 1, pageSize: 200 });
    warehouses.value = (data.list ?? []) as { id: number; name: string }[];
  } catch {
    /* 仓库接口未就绪 */
  }
  void searchSku('');
  if (route.query.sku_id) query.sku_id = Number(route.query.sku_id);
  void reload(1);
});
</script>

<style scoped>
.in {
  color: #67c23a;
  font-weight: 600;
}
.out {
  color: #f56c6c;
  font-weight: 600;
}
:deep(.out-row) {
  background: #fef0f0;
}
</style>
