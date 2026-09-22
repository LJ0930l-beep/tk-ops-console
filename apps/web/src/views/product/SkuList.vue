<template>
  <div>
    <div v-if="rp && !rp.rows.length" class="page-tip">
      <el-alert type="info" :closable="false" show-icon title="还没有 SKU">
        <template #default>
          SKU 挂在 SPU 下，一个规格一行。采购成本 + 头程成本 = 单件成本（人民币/件），成本未维护的 SKU 会让订单利润算不平，请优先补齐。
        </template>
      </el-alert>
    </div>

    <ResourcePage
      ref="rp"
      api="/products/sku"
      title="SKU"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :action-width="150"
      dialog-width="720px"
    >
      <template #toolbar="{ query }">
        <ExportButton url="/products/export/sku" name="product-sku" :params="query" />
      </template>
      <template #form-extra="{ form, editing }">
        <el-form-item v-if="canSeeCost" label="成本口径">
          <el-alert type="warning" :closable="false" show-icon :title="`单件成本 = 采购成本 + 头程成本 = ${unitCost(form)} CNY/件`">
            <template #default>
              <span class="tip">
                修改成本<b>只影响后续订单</b>，历史订单已按下单当时冻结 <code>cost_snapshot</code>，不回溯改写。
                <template v-if="editing">该 SKU 近 90 天订单行数 {{ numOrDash((editing as Record<string, unknown>).order_rows_90d) }}、被映射店铺数 {{ numOrDash((editing as Record<string, unknown>).listing_shop_count) }}。</template>
              </span>
            </template>
          </el-alert>
        </el-form-item>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { num } from '@tk/shared';
import { apiGet, type Paged, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('product'));
/** PRD 3.0 敏感字段：无权限时后端返回 *** ；本页按分工要求直接不出成本列 */
const canSeeCost = computed(() => auth.canSeeCost);

const SKU_STATUS: OptionDef[] = [
  { value: 1, label: '在售', type: 'success' },
  { value: 0, label: '停售', type: 'info' },
];
const YES: OptionDef[] = [{ value: 1, label: '仅看成本未维护' }];

const spuOpts = ref<OptionDef[]>([]);
const categoryOpts = ref<OptionDef[]>([]);

async function loadSpus() {
  try {
    const r = await apiGet<Paged<Record<string, unknown>>>('/products/spu', { page: 1, pageSize: 200 });
    spuOpts.value = (r.list ?? []).map((s) => ({ value: Number(s.id), label: `${String(s.spu_code)}｜${String(s.name_cn ?? '')}` }));
  } catch (e) {
    spuOpts.value = [];
    // 失败必须说一声：静默成空列表，界面就只显示「暂无数据」，
    // 用户和排障的人都分不出是「真没有」还是「接口挂了」（本轮就是这么被 /system/dict 骗过的）
    ElMessage.warning(errMsg(e));
  }
}

onMounted(async () => {
  await loadSpus();
  categoryOpts.value = (await dict.dict('category')).map((d) => ({ value: d.dict_value, label: d.dict_label }));
});

const columns = computed<ColumnDef[]>(() => {
  const costCols: ColumnDef[] = canSeeCost.value
    ? [
        { prop: 'purchase_cost', label: '采购成本(CNY/件)', width: 130, type: 'money', sortable: true },
        { prop: 'first_leg_cost', label: '头程成本(CNY/件)', width: 130, type: 'money', sortable: true },
        { prop: 'unit_cost', label: '单件成本(CNY)', width: 130, type: 'money', sortable: true },
      ]
    : [];
  return [
    { prop: 'sku_code', label: 'SKU 编码', width: 150, fixed: 'left' },
    { prop: 'spu_code', label: 'SPU 编码', width: 140 },
    { prop: 'name_cn', label: '商品名称', minWidth: 180 },
    { prop: 'spec', label: '规格', minWidth: 130 },
    ...costCols,
    { prop: 'weight_g', label: '重量(g)', width: 90 },
    { prop: 'package_size', label: '包装尺寸', width: 120 },
    { prop: 'status', label: '状态', width: 90, type: 'tag', options: SKU_STATUS },
    { prop: 'updater_name', label: '最近改价人', width: 110 },
    { prop: 'updated_at', label: '最近修改时间', width: 150, type: 'datetime' },
  ];
});

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: 'SKU/规格', placeholder: '编码或规格' },
  { key: 'spu_id', label: '所属 SPU', type: 'select', options: spuOpts.value },
  { key: 'category', label: '品类', type: 'select', options: categoryOpts.value },
  { key: 'status', label: '状态', type: 'select', options: SKU_STATUS },
  { key: 'cost_missing', label: '成本维护', type: 'select', options: YES },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'spu_id', label: '所属 SPU', type: 'select', required: true, span: 24, options: () => spuOpts.value },
  { key: 'sku_code', label: 'SKU 编码', required: true, disabledOnEdit: true, placeholder: '≤64 字，全局唯一；店铺 seller_sku 按此自动匹配' },
  { key: 'spec', label: '规格', placeholder: '如 黑色/XL' },
  ...(canSeeCost.value
    ? [
        { key: 'purchase_cost', label: '采购成本', type: 'number' as const, min: 0, precision: 2, default: 0 },
        { key: 'first_leg_cost', label: '头程成本', type: 'number' as const, min: 0, precision: 2, default: 0 },
      ]
    : []),
  { key: 'weight_g', label: '重量(g)', type: 'number', min: 0, precision: 0, default: 0 },
  { key: 'package_size', label: '包装尺寸', placeholder: '格式 长x宽x高（cm），≤50 字' },
  { key: 'status', label: '状态', type: 'select', options: SKU_STATUS, default: 1 },
]);

function unitCost(form: Record<string, unknown>) {
  return (num(form.purchase_cost) + num(form.first_leg_cost)).toFixed(2);
}
function numOrDash(v: unknown) {
  return v === undefined || v === null || v === '***' ? '—' : String(v);
}
</script>

<style scoped>
.page-tip {
  padding: 12px 16px 0;
}
.tip {
  color: #909399;
  font-size: 12px;
}
</style>
