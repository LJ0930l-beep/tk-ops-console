<template>
  <div class="page">
    <el-alert type="error" :closable="false" show-icon class="notice" title="以下数据行不计入成本与利润，且会持续在工作台告警">
      <template #default>
        成本按订单明细的 <code>cost_snapshot</code> 冻结，取不到内部 SKU 的行一律不参与毛利/利润计算（绝不按 0 成本计入）。请尽快补齐映射：绑定后历史订单会在下次汇总时回填成本。
      </template>
    </el-alert>

    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane label="A. 未映射的店铺商品" name="listing">
          <ResourcePage
            ref="rpA"
            api="/products/listings"
            title="店铺商品映射"
            :columns="listingColumns"
            :search-fields="listingSearch"
            :extra-query="unmappedQuery"
            :createable="false"
            :editable="false"
            :deletable="false"
            :can-write="false"
            :row-class-name="listingRowClass"
            :action-width="120"
          >
            <template #actions="{ row }">
              <el-button link type="primary" size="small" @click="openBind(row)">去绑定</el-button>
            </template>
          </ResourcePage>
        </el-tab-pane>

        <el-tab-pane label="B. 已出单但取不到成本的订单行" name="order-item">
          <el-form inline @submit.prevent="loadOrderItems(1)">
            <el-form-item label="店铺">
              <el-select v-model="oiQuery.shop_id" clearable filterable placeholder="全部" style="width: 160px">
                <el-option v-for="o in shopOpts" :key="String(o.value)" :label="o.label" :value="Number(o.value)" />
              </el-select>
            </el-form-item>
            <el-form-item label="关键词">
              <el-input v-model="oiQuery.keyword" clearable placeholder="平台订单号 / 平台 SKU ID" style="width: 200px" @keyup.enter="loadOrderItems(1)" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :icon="Search" @click="loadOrderItems(1)">查询</el-button>
              <el-button :icon="RefreshLeft" @click="resetOi">重置</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="oiLoading" :data="oiRows" border stripe size="small" :row-class-name="() => 'oi-row-danger'" style="width: 100%">
            <el-table-column type="index" label="#" width="48" />
            <el-table-column prop="tk_order_id" label="平台订单号" width="180" show-overflow-tooltip>
              <template #default="{ row }">
                <router-link v-if="row.order_id" :to="`/orders/${String(row.order_id)}`" class="link">{{ String(row.tk_order_id ?? '-') }}</router-link>
                <span v-else>{{ row.tk_order_id ?? '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="shop_name" label="店铺" width="150" show-overflow-tooltip />
            <el-table-column prop="tk_sku_id" label="平台 SKU ID" width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ row.tk_sku_id ?? row.seller_sku ?? '-' }}</template>
            </el-table-column>
            <el-table-column prop="sku_code" label="内部 SKU" width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.sku_code ?? '—' }}</template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="80" />
            <el-table-column prop="item_amount" label="明细金额(店铺币种)" width="150" align="right">
              <template #default="{ row }"><span class="money">{{ fmtMoney(row.item_amount) }}</span></template>
            </el-table-column>
            <el-table-column prop="order_time" label="下单时间" width="150">
              <template #default="{ row }">{{ fmtDateTime(row.order_time ?? row.paid_time) }}</template>
            </el-table-column>
            <el-table-column prop="miss_reason" label="缺失原因" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ reason(row) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openBindFromItem(row)">去绑定</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="没有取不到成本的订单行——所有已出单明细都已映射到内部 SKU">
                <el-button :icon="Refresh" @click="loadOrderItems(1)">重新检查</el-button>
              </el-empty>
            </template>
          </el-table>
          <el-pagination
            v-model:current-page="oiPage"
            v-model:page-size="oiPageSize"
            :total="oiTotal"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next, jumper"
            style="margin-top: 12px; justify-content: flex-end"
            @current-change="loadOrderItems()"
            @size-change="loadOrderItems(1)"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="bindVisible" title="绑定内部 SKU" width="520px">
      <el-descriptions :column="1" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="店铺">{{ bindRow?.shop_name ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="平台商品">{{ bindRow?.product_name ?? bindRow?.tk_product_id ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="平台 SKU ID">{{ bindRow?.tk_sku_id ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="seller_sku">{{ bindRow?.seller_sku ?? '—' }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="100px">
        <el-form-item label="内部 SKU">
          <el-select v-model="bindSkuId" filterable clearable placeholder="搜索 SKU 编码 / 规格" style="width: 100%">
            <el-option v-for="o in skuOpts" :key="String(o.value)" :label="o.label" :value="Number(o.value)" />
          </el-select>
        </el-form-item>
      </el-form>
      <span class="tip">绑定后该行才计入成本与利润；若 seller_sku 与 SKU 编码一致，可到「店铺商品映射」页用自动匹配批量处理。</span>
      <template #footer>
        <el-button @click="bindVisible = false">取消</el-button>
        <el-button type="primary" :loading="binding" @click="doBind">保存绑定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import { MAP_STATUS } from '@tk/shared';
import { useRouter } from 'vue-router';
import { apiGet, apiPut, errMsg, type Paged } from '@/api/client';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const router = useRouter();
const dict = useDictStore();

const tab = ref<'listing' | 'order-item'>('listing');
const rpA = ref();
const unmappedQuery = { map_status: MAP_STATUS.UNMAPPED };

const shopOpts = ref<OptionDef[]>([]);
const skuOpts = ref<OptionDef[]>([]);

onMounted(async () => {
  const shops = await dict.shopOptions().catch(() => []);
  shopOpts.value = (shops ?? []).map((s) => ({ value: s.id, label: s.shop_name }));
  await loadSkus();
});

async function loadSkus() {
  try {
    const r = await apiGet<Paged<Record<string, unknown>>>('/products/skus', { page: 1, pageSize: 200 });
    skuOpts.value = (r.list ?? []).map((s) => ({ value: Number(s.id), label: `${String(s.sku_code)}｜${String(s.spec ?? '')}｜${String(s.name_cn ?? '')}` }));
  } catch {
    skuOpts.value = [];
  }
}

const LISTING_STATUS: OptionDef[] = [
  { value: 1, label: '草稿', type: 'info' },
  { value: 2, label: '审核中', type: 'warning' },
  { value: 3, label: '在售', type: 'success' },
  { value: 4, label: '下架', type: 'info' },
  { value: 5, label: '违规', type: 'danger' },
];

const listingColumns = computed<ColumnDef[]>(() => [
  { prop: 'shop_name', label: '店铺', width: 150, fixed: 'left' },
  { prop: 'product_name', label: '平台商品名', minWidth: 200 },
  { prop: 'tk_product_id', label: '平台商品 ID', width: 150 },
  { prop: 'tk_sku_id', label: '平台 SKU ID', width: 150 },
  { prop: 'seller_sku', label: 'seller_sku', width: 150 },
  { prop: 'sale_price', label: '售价(店铺币种)', width: 130, type: 'money' },
  { prop: 'listing_status', label: '上架状态', width: 100, type: 'tag', options: LISTING_STATUS },
  { prop: 'last_sync_at', label: '最近同步', width: 150, type: 'datetime' },
]);

const listingSearch = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '商品/SKU', placeholder: '商品名 / seller_sku / 平台 SKU ID' },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts.value },
]);

function listingRowClass({ row }: { row: Record<string, unknown> }): string {
  return Number(row.map_status) === MAP_STATUS.UNMAPPED || row.sku_id == null ? 'listing-row-warn' : '';
}

/* ---------- Tab B：订单行取不到成本 ---------- */
const oiLoading = ref(false);
const oiRows = ref<Record<string, unknown>[]>([]);
const oiTotal = ref(0);
const oiPage = ref(1);
const oiPageSize = ref(20);
const oiQuery = reactive<{ shop_id?: number; keyword?: string }>({});

async function loadOrderItems(resetPage?: number) {
  if (resetPage) oiPage.value = resetPage;
  oiLoading.value = true;
  try {
    const data = await apiGet<Paged<Record<string, unknown>>>('/products/unmapped/order-items', {
      page: oiPage.value,
      pageSize: oiPageSize.value,
      ...Object.fromEntries(Object.entries(oiQuery).filter(([, v]) => v !== '' && v != null)),
    });
    oiRows.value = data.list ?? [];
    oiTotal.value = data.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    oiLoading.value = false;
  }
}

function resetOi() {
  oiQuery.shop_id = undefined;
  oiQuery.keyword = undefined;
  loadOrderItems(1);
}

function reason(row: Record<string, unknown>) {
  if (row.miss_reason) return String(row.miss_reason);
  if (row.sku_id == null) return '未绑定内部 SKU（无映射）';
  if (Number(row.cost_matched) === 0) return '成本快照未匹配（绑定过晚或 SKU 已删）';
  return '成本缺失';
}

const fmtMoney = (v: unknown) => (v == null || v === '' || v === '***' ? '-' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtDateTime = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 16) : '-');

/* ---------- 绑定 ---------- */
const bindVisible = ref(false);
const binding = ref(false);
const bindRow = ref<Record<string, unknown> | null>(null);
const bindSkuId = ref<number>();
const bindListingId = ref<number>();

function openBind(row: Record<string, unknown>) {
  bindRow.value = row;
  bindListingId.value = Number(row.id);
  bindSkuId.value = row.sku_id == null ? undefined : Number(row.sku_id);
  bindVisible.value = true;
}

function openBindFromItem(row: Record<string, unknown>) {
  const listingId = Number(row.listing_id ?? 0);
  if (!listingId) {
    ElMessage.warning('该订单行没有关联的店铺商品记录，请到「店铺商品映射」页新增映射');
    void router.push({ path: '/products/listing', query: { keyword: String(row.tk_sku_id ?? row.seller_sku ?? '') } });
    return;
  }
  openBind({ ...row, id: listingId });
}

async function doBind() {
  if (!bindListingId.value) return;
  binding.value = true;
  try {
    await apiPut(`/products/listings/${bindListingId.value}`, { sku_id: bindSkuId.value ?? null });
    ElMessage.success('已绑定内部 SKU，利润将在下次汇总时纳入该成本');
    bindVisible.value = false;
    rpA.value?.reload();
    loadOrderItems();
    await loadSkus();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    binding.value = false;
  }
}

onMounted(() => loadOrderItems(1));
</script>

<style scoped>
.page {
  padding: 16px;
}
/* ResourcePage 自带 .page 内边距，嵌在 Tab 里时去掉 */
:deep(.el-tab-pane .page) {
  padding: 0;
}
.notice {
  margin-bottom: 12px;
}
.link {
  color: #409eff;
  text-decoration: none;
}
.tip {
  color: #909399;
  font-size: 12px;
}
.money {
  color: #c45656;
}
:deep(tr.listing-row-warn td.el-table__cell) {
  background: #fdf6ec !important;
}
:deep(tr.oi-row-danger td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
