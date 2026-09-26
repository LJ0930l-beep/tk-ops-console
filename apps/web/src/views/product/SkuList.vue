<template>
  <div>
    <div v-if="rp && !rp.rows.length" class="page-tip">
      <el-alert type="info" :closable="false" show-icon title="还没有 SKU">
        <template #default>
          SKU 挂在 SPU 下，一个规格一行。我们是品牌服务方：货是品牌的，我们不付货款，每个 SKU 要维护的是
          <b>品牌返点率</b>（我们唯一收入的来源）与<b>单件物流成本</b>（人民币/件，品牌承担填 0）。
          返点率没配的 SKU，它出的订单行不参与利润，请优先补齐。
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
      :map-row="decorate"
      :can-write="canWrite"
      :action-width="150"
      dialog-width="720px"
    >
      <template #toolbar="{ query }">
        <ExportButton url="/products/export/sku" name="product-sku" :params="query" />
      </template>
      <template #form-extra="{ form, editing }">
        <el-form-item v-if="canSeeCost" label="收入与物流口径">
          <el-alert type="warning" :closable="false" show-icon :title="`这一行的收入 = 实收金额 × 品牌返点率 ${rateText(form.rebate_rate)}；我们掏的只有物流 ${logisticsText(form.logistics_cost)} CNY/件`">
            <template #default>
              <span class="tip">
                改返点率<b>只影响后续订单</b>：历史订单已按成交当时冻结 <code>rebate_rate</code> / <code>rebate_cny</code> / <code>logistics_cny</code>，不回溯改写。
                返点率填 0 = 还没跟品牌谈到数，这种 SKU 出的订单行整体不参与利润（不会按 0 收入计）。
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
import { MASK, num, round2 } from '@tk/shared';
import { apiGet, type Paged, errMsg } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('product'));
/** 返点率与物流是「我们这一侧的账」，与旧口径的成本同级：无 can_see_cost 时后端掩码，本页按分工不出这两列 */
const canSeeCost = computed(() => auth.canSeeCost);

const SKU_STATUS: OptionDef[] = [
  { value: 1, label: '在售', type: 'success' },
  { value: 0, label: '停售', type: 'info' },
];
const YES: OptionDef[] = [{ value: 1, label: '仅看返点率未配' }];
/** 后端下发的是小数（0.18），ResourcePage 的 percent 列按「已是百分数」渲染，所以另加展示键，不改原字段 */
const REBATE_STATE: OptionDef[] = [
  { value: '已配返点', label: '已配返点', type: 'success' },
  { value: '未配·不计利润', label: '未配·不计利润', type: 'danger' },
];

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
  const rebateCols: ColumnDef[] = canSeeCost.value
    ? [
        { prop: 'rebate_rate_pct', label: '品牌返点率', width: 110, type: 'percent' },
        { prop: 'logistics_cost', label: '单件物流(CNY/件)', width: 130, type: 'money', sortable: true },
        { prop: 'rebate_state', label: '返点维护', width: 130, type: 'tag', options: REBATE_STATE },
      ]
    : [];
  return [
    { prop: 'sku_code', label: 'SKU 编码', width: 150, fixed: 'left' },
    { prop: 'spu_code', label: 'SPU 编码', width: 140 },
    { prop: 'name_cn', label: '商品名称', minWidth: 180 },
    { prop: 'spec', label: '规格', minWidth: 130 },
    ...rebateCols,
    { prop: 'weight_g', label: '重量(g)', width: 90 },
    { prop: 'package_size', label: '包装尺寸', width: 120 },
    { prop: 'status', label: '状态', width: 90, type: 'tag', options: SKU_STATUS },
    { prop: 'updater_name', label: '最近维护人', width: 110 },
    { prop: 'updated_at', label: '最近修改时间', width: 150, type: 'datetime' },
  ];
});

/** 只加展示键（百分数 / 维护状态），后端原字段一个都不动：编辑表单直接吃 rebate_rate 原值，动了就串单位 */
function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const rate = row.rebate_rate;
  const masked = rate === MASK || rate === null || rate === undefined;
  return {
    ...row,
    rebate_rate_pct: masked ? rate : round2(num(rate) * 100),
    rebate_state: masked ? '—' : num(rate) > 0 ? '已配返点' : '未配·不计利润',
  };
}

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: 'SKU/规格', placeholder: '编码或规格' },
  { key: 'spu_id', label: '所属 SPU', type: 'select', options: spuOpts.value },
  { key: 'category', label: '品类', type: 'select', options: categoryOpts.value },
  { key: 'status', label: '状态', type: 'select', options: SKU_STATUS },
  // 新口径下「成本未维护」这件事就是「没配到品牌返点率」，筛选键跟着改名（后端需支持 rebate_missing）
  { key: 'rebate_missing', label: '返点率维护', type: 'select', options: YES },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'spu_id', label: '所属 SPU', type: 'select', required: true, span: 24, options: () => spuOpts.value },
  { key: 'sku_code', label: 'SKU 编码', required: true, disabledOnEdit: true, placeholder: '≤64 字，全局唯一；店铺 seller_sku 按此自动匹配' },
  { key: 'spec', label: '规格', placeholder: '如 黑色/XL' },
  ...(canSeeCost.value
    ? [
        {
          key: 'rebate_rate',
          label: '品牌返点率',
          type: 'number' as const,
          min: 0,
          max: 1,
          precision: 4,
          step: 0.01,
          default: 0,
          placeholder: '小数：0.18 = 实收 GMV 的 18% 归我们；没谈到先填 0',
        },
        {
          key: 'logistics_cost',
          label: '单件物流(CNY)',
          type: 'number' as const,
          min: 0,
          precision: 2,
          step: 1,
          default: 0,
          placeholder: '头程 + 海外仓，人民币/件；品牌承担填 0',
        },
      ]
    : []),
  { key: 'weight_g', label: '重量(g)', type: 'number', min: 0, precision: 0, default: 0 },
  { key: 'package_size', label: '包装尺寸', placeholder: '格式 长x宽x高（cm），≤50 字' },
  { key: 'status', label: '状态', type: 'select', options: SKU_STATUS, default: 1 },
]);

/** 表单里的小数 → 百分数文案（只用于提示，不参与任何金额汇总） */
function rateText(v: unknown): string {
  if (v === MASK) return MASK;
  const n = num(v);
  return `${round2(n * 100)}%`;
}
function logisticsText(v: unknown): string {
  return v === MASK ? MASK : num(v).toFixed(2);
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
