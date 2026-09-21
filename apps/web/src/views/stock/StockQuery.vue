<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <el-form-item label="仓库">
          <el-select v-model="query.warehouse_id" clearable placeholder="全部" style="width: 170px" @change="reload(1)">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="SKU">
          <el-input v-model="query.keyword" clearable placeholder="SKU 编码 / 规格" style="width: 180px" @keyup.enter="reload(1)" />
        </el-form-item>
        <el-form-item label="商品">
          <el-select v-model="query.spu_id" filterable clearable placeholder="全部 SPU" style="width: 200px" @change="reload(1)">
            <el-option v-for="s in spus" :key="s.id" :label="`${s.spu_code} ${s.name_cn}`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-switch v-model="lowOnly" active-text="只看低库存" inline-prompt style="margin-right: 10px" @change="reload(1)" />
          <el-button type="primary" :icon="Search" @click="reload(1)">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon>
        <template #title>
          当前库存 = 出入库流水按 (warehouse_id, sku_id) 汇总 SUM(quantity)，本表只读、不做两处同时改数（ERP 为准时请以此口径核对）。
          低于安全阈值（前端常量 {{ LOW_STOCK_THRESHOLD }} 件，SKU 自身有安全库存配置时以配置为准）标红并提示补货。
        </template>
      </el-alert>
    </el-card>

    <div class="stat-grid">
      <el-card shadow="never">
        <div class="kpi-label">SKU × 仓库 组合</div>
        <div class="kpi-value">{{ int(total) }}</div>
        <div class="kpi-sub">本页 {{ int(totalCombos) }} 行</div>
      </el-card>
      <el-card shadow="never">
        <div class="kpi-label">在库总量</div>
        <div class="kpi-value">{{ int(sumQty) }}</div>
        <div class="kpi-sub">本页汇总（含零库存行）</div>
      </el-card>
      <el-card shadow="never">
        <div class="kpi-label">低库存 / 断货</div>
        <div class="kpi-value" :class="lowCount ? 'danger' : ''">{{ int(lowCount) }} / {{ int(zeroCount) }}</div>
        <div class="kpi-sub">本页需补货或核对流水</div>
      </el-card>
    </div>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="filtered"
        border
        stripe
        size="small"
        :row-class-name="rowClass"
        style="width: 100%"
        @sort-change="onSort"
      >
        <el-table-column prop="warehouse_name" label="仓库" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.warehouse_name || `#${row.warehouse_id}` }}</template>
        </el-table-column>
        <el-table-column prop="sku_code" label="SKU 编码" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.sku_code || `#${row.sku_id}` }}</template>
        </el-table-column>
        <el-table-column prop="spec" label="规格" min-width="130" show-overflow-tooltip />
        <el-table-column prop="spu_code" label="SPU" min-width="120" show-overflow-tooltip />
        <el-table-column prop="qty" label="当前库存" width="110" align="right" sortable="custom">
          <template #default="{ row }">
            <span :class="isLow(row) ? 'danger' : ''">{{ int(qtyOf(row)) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="safety_stock" label="安全库存" width="100" align="right">
          <template #default="{ row }">{{ int(thresholdOf(row)) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="qtyOf(row) <= 0" size="small" type="danger">断货</el-tag>
            <el-tag v-else-if="isLow(row)" size="small" type="warning">低库存</el-tag>
            <el-tag v-else size="small" type="success">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="建议补货" width="110" align="right">
          <template #default="{ row }">
            <span v-if="suggestOf(row) > 0" class="danger">{{ int(suggestOf(row)) }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="goLedger(row)">看流水</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有库存汇总数据：登记一笔出入库流水后自动生成">
            <el-button type="primary" @click="router.push('/stock/ledger')">去录入流水</el-button>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import type { PageResult } from '@tk/shared';
import { num } from '@tk/shared';
import { apiGet, errMsg } from '@/api/client';

/** 行结构由后端聚合返回：{ warehouse_id, warehouse_name, sku_id, sku_code, spec, spu_code, qty, safety_stock? } */
type Row = { warehouse_id: number; sku_id: number } & Record<string, unknown>;

/** 低库存阈值（前端常量；后端若返回 safety_stock 则优先） */
const LOW_STOCK_THRESHOLD = 20;

const router = useRouter();
const warehouses = ref<{ id: number; name: string }[]>([]);
const spus = ref<{ id: number; spu_code: string; name_cn: string }[]>([]);
const rows = ref<Row[]>([]);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(50);
const total = ref(0);
const sortBy = ref('qty');
const sortOrder = ref('asc');
const lowOnly = ref(false);

const query = reactive<{ warehouse_id?: number; keyword?: string; spu_id?: number }>({
  warehouse_id: undefined,
  keyword: '',
  spu_id: undefined,
});

const int = (v: unknown) => (v === null || v === undefined ? '-' : Math.round(num(v)).toLocaleString('zh-CN'));
const qtyOf = (r: Row) => Math.round(num(r.qty ?? r.quantity ?? r.stock ?? 0));
const thresholdOf = (r: Row) => Math.round(num(r.safety_stock ?? LOW_STOCK_THRESHOLD));
const isLow = (r: Row) => qtyOf(r) <= thresholdOf(r) && qtyOf(r) > 0;
const suggestOf = (r: Row) => Math.max(0, thresholdOf(r) * 2 - qtyOf(r));
const rowClass = ({ row }: { row: Row }) => (qtyOf(row) <= 0 ? 'zero-row' : isLow(row) ? 'low-row' : '');

const filtered = computed(() => (lowOnly.value ? rows.value.filter((r) => qtyOf(r) <= thresholdOf(r)) : rows.value));
const totalCombos = computed(() => filtered.value.length);
const sumQty = computed(() => filtered.value.reduce((a, r) => a + qtyOf(r), 0));
const lowCount = computed(() => filtered.value.filter((r) => isLow(r)).length);
const zeroCount = computed(() => filtered.value.filter((r) => qtyOf(r) <= 0).length);

async function reload(resetPage?: number): Promise<void> {
  if (resetPage) page.value = resetPage;
  loading.value = true;
  try {
    const data = await apiGet<PageResult<Row>>('/stock/query', {
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null)),
    });
    rows.value = data.list ?? [];
    total.value = data.total ?? rows.value.length;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function resetQuery(): void {
  query.warehouse_id = undefined;
  query.keyword = '';
  query.spu_id = undefined;
  lowOnly.value = false;
  void reload(1);
}

function onSort({ prop, order }: { prop: string; order: string | null }): void {
  sortBy.value = order ? prop : 'qty';
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc';
  void reload();
}

function goLedger(row: Row): void {
  void router.push({ path: '/stock/ledger', query: { warehouse_id: String(row.warehouse_id), sku_id: String(row.sku_id) } });
}

onMounted(async () => {
  const [wh, spu] = await Promise.allSettled([
    apiGet<PageResult<Record<string, unknown>>>('/stock/warehouses', { page: 1, pageSize: 200 }),
    apiGet<PageResult<Record<string, unknown>>>('/stock/spus', { page: 1, pageSize: 200 }),
  ]);
  const list = (r: PromiseSettledResult<{ list: Record<string, unknown>[] }>) => (r.status === 'fulfilled' ? (r.value.list ?? []) : []);
  warehouses.value = list(wh) as { id: number; name: string }[];
  spus.value = list(spu) as { id: number; spu_code: string; name_cn: string }[];
  void reload(1);
});
</script>

<style scoped>
.danger {
  color: #f56c6c;
  font-weight: 600;
}
.kpi-label {
  font-size: 12px;
  color: #909399;
}
.kpi-value {
  font-size: 20px;
  font-weight: 600;
  margin: 4px 0;
}
.kpi-sub {
  font-size: 12px;
  color: #a8abb2;
}
:deep(.low-row),
:deep(.zero-row) {
  background: #fef0f0;
}
</style>
