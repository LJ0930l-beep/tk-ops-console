<template>
  <div>
    <ResourcePage
      ref="rp"
      api="/products/listing"
      title="店铺商品映射"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :row-class-name="rowClass"
      :before-submit="beforeSubmit"
      :action-width="150"
      dialog-width="720px"
    >
      <template #toolbar-extra>
        <div class="toolbar">
          <el-button v-if="canWrite" :icon="MagicStick" :loading="matching" @click="openMatch">按 seller_sku 自动匹配</el-button>
          <ImportDialog v-if="canWrite" table="shop_listing" button-text="导入店铺商品" @done="rp?.reload()" />
          <router-link to="/products/unmapped"><el-button :icon="Warning" plain type="danger" size="small">待映射清单</el-button></router-link>
          <span class="tip">本页待映射 {{ unmappedInPage }} 条；待映射行整行黄底，不计返点、不进利润（不是 0 利润）。</span>
        </div>
      </template>

      <template #actions="{ row }">
        <el-button v-if="canWrite && Number(row.map_status) === 2" link type="warning" size="small" @click="openBind(row)">绑定 SKU</el-button>
      </template>

      <template #form-extra="{ form }">
        <el-form-item label="匹配说明">
          <span class="tip">
            内部 SKU 留空即为「待映射」；自动匹配规则为 <code>seller_sku = product_sku.sku_code</code>（或前缀唯一命中），多命中不自动写入，需在此手工绑定。
          </span>
        </el-form-item>
        <el-form-item v-if="form.sku_id" label="当前内部 SKU">
          <span class="tip">{{ skuLabel(form.sku_id) }}</span>
        </el-form-item>
      </template>
    </ResourcePage>

    <el-dialog v-model="matchVisible" title="按 seller_sku 自动匹配" width="460px">
      <el-form label-width="100px">
        <el-form-item label="店铺">
          <el-select v-model="matchShop" clearable filterable placeholder="全部可见店铺" style="width: 100%">
            <el-option v-for="o in shopOpts" :key="String(o.value)" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <span class="tip">只处理 <code>sku_id</code> 为空的行；命中唯一 SKU 才写入，多命中留在人工清单。</span>
      <template #footer>
        <el-button @click="matchVisible = false">取消</el-button>
        <el-button type="primary" :loading="matching" @click="doMatch">开始匹配</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="bindVisible" title="手工绑定内部 SKU" width="520px">
      <el-descriptions :column="1" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="店铺">{{ bindRow?.shop_name ?? bindRow?.shop_id ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="平台商品">{{ bindRow?.product_name ?? '—' }}</el-descriptions-item>
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
      <span class="tip">绑定 SKU 后这一行才带得出品牌返点率，才会进利润；解绑请清空 SKU 后保存。</span>
      <template #footer>
        <el-button @click="bindVisible = false">取消</el-button>
        <el-button type="primary" :loading="binding" @click="doBind">保存绑定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { MagicStick, Warning } from '@element-plus/icons-vue';
import { MAP_STATUS } from '@tk/shared';
import { apiGet, apiPost, apiPut, errMsg, type Paged } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ImportDialog from '@/components/ImportDialog.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('product'));

const LISTING_STATUS: OptionDef[] = [
  { value: 1, label: '草稿', type: 'info' },
  { value: 2, label: '审核中', type: 'warning' },
  { value: 3, label: '在售', type: 'success' },
  { value: 4, label: '下架', type: 'info' },
  { value: 5, label: '违规', type: 'danger' },
];
const MAP_STATUS_OPTS: OptionDef[] = [
  { value: MAP_STATUS.MAPPED, label: '已映射', type: 'success' },
  { value: MAP_STATUS.UNMAPPED, label: '待映射', type: 'warning' },
];

const shopOpts = ref<OptionDef[]>([]);
const skuOpts = ref<OptionDef[]>([]);

async function loadSkus() {
  try {
    const r = await apiGet<Paged<Record<string, unknown>>>('/products/sku', { page: 1, pageSize: 200 });
    skuOpts.value = (r.list ?? []).map((s) => ({ value: Number(s.id), label: `${String(s.sku_code)}｜${String(s.spec ?? '')}｜${String(s.name_cn ?? '')}` }));
  } catch (e) {
    skuOpts.value = [];
    // 失败必须说一声：静默成空列表，界面就只显示「暂无数据」，
    // 用户和排障的人都分不出是「真没有」还是「接口挂了」（本轮就是这么被 /system/dict 骗过的）
    ElMessage.warning(errMsg(e));
  }
}

onMounted(async () => {
  const shops = await dict.shopOptions().catch(() => []);
  shopOpts.value = (shops ?? []).map((s) => ({ value: s.id, label: s.shop_name }));
  await loadSkus();
});

const columns = computed<ColumnDef[]>(() => [
  { prop: 'shop_name', label: '店铺', width: 150, fixed: 'left' },
  { prop: 'product_name', label: '平台商品名', minWidth: 200 },
  { prop: 'tk_product_id', label: '平台商品 ID', width: 150 },
  { prop: 'tk_sku_id', label: '平台 SKU ID', width: 150 },
  { prop: 'seller_sku', label: 'seller_sku', width: 150 },
  { prop: 'sku_code', label: '内部 SKU', width: 150 },
  { prop: 'sale_price', label: '售价(店铺币种)', width: 120, type: 'money', sortable: true },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'listing_status', label: '上架状态', width: 100, type: 'tag', options: LISTING_STATUS },
  { prop: 'map_status', label: '映射状态', width: 100, type: 'tag', options: MAP_STATUS_OPTS },
  { prop: 'last_sync_at', label: '最近同步', width: 150, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '商品/SKU', placeholder: '商品名 / seller_sku / 平台 SKU ID' },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts.value },
  { key: 'map_status', label: '映射状态', type: 'select', options: MAP_STATUS_OPTS },
  { key: 'listing_status', label: '上架状态', type: 'select', options: LISTING_STATUS },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'shop_id', label: '店铺', type: 'select', required: true, options: () => shopOpts.value },
  { key: 'sku_id', label: '内部 SKU', type: 'select', options: () => skuOpts.value, placeholder: '留空 = 待映射' },
  { key: 'tk_product_id', label: '平台商品 ID' },
  { key: 'tk_sku_id', label: '平台 SKU ID', disabledOnEdit: true, placeholder: '与店铺联合唯一' },
  { key: 'seller_sku', label: 'seller_sku', placeholder: '自动匹配依据，建议与 SKU 编码一致' },
  { key: 'product_name', label: '平台商品名', span: 24 },
  { key: 'sale_price', label: '售价', type: 'number', min: 0, precision: 2, default: 0 },
  { key: 'listing_status', label: '上架状态', type: 'select', options: LISTING_STATUS, default: 1 },
]);

/** 空字符串不提交，避免覆盖成 0 / 后端校验失败 */
function beforeSubmit(values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== '' && v !== undefined) out[k] = v;
  return out;
}

function rowClass({ row }: { row: Record<string, unknown> }): string {
  return Number(row.map_status) === MAP_STATUS.UNMAPPED ? 'listing-row-warn' : '';
}

const unmappedInPage = computed(() => (rp.value?.rows ?? []).filter((r: Record<string, unknown>) => Number(r.map_status) === MAP_STATUS.UNMAPPED).length);

function skuLabel(v: unknown) {
  return String(skuOpts.value.find((o) => String(o.value) === String(v))?.label ?? v);
}

/* ---------- 自动匹配 ---------- */
const matchVisible = ref(false);
const matching = ref(false);
const matchShop = ref<number>();

function openMatch() {
  matchShop.value = undefined;
  matchVisible.value = true;
}

async function doMatch() {
  matching.value = true;
  try {
    const res = await apiPost<Record<string, unknown>>('/products/listing/auto-match', { shop_id: matchShop.value });
    const matched = Number(res?.matched ?? res?.updated ?? res?.count ?? 0);
    const ambiguous = Number(res?.ambiguous ?? res?.multi ?? 0);
    ElMessage.success(`自动匹配完成：命中 ${matched} 条${ambiguous ? `，${ambiguous} 条多命中需人工绑定` : ''}`);
    matchVisible.value = false;
    rp.value?.reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    matching.value = false;
  }
}

/* ---------- 手工绑定 ---------- */
const bindVisible = ref(false);
const binding = ref(false);
const bindRow = ref<Record<string, unknown> | null>(null);
const bindSkuId = ref<number>();

function openBind(row: Record<string, unknown>) {
  bindRow.value = row;
  bindSkuId.value = row.sku_id == null ? undefined : Number(row.sku_id);
  bindVisible.value = true;
}

async function doBind() {
  const id = Number(bindRow.value?.id);
  if (!id) return;
  binding.value = true;
  try {
    await apiPut(`/products/listing/${id}`, { sku_id: bindSkuId.value ?? null });
    ElMessage.success('已绑定内部 SKU');
    bindVisible.value = false;
    rp.value?.reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    binding.value = false;
  }
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tip {
  color: #909399;
  font-size: 12px;
}
:deep(tr.listing-row-warn td.el-table__cell) {
  background: #fdf6ec !important;
}
</style>
