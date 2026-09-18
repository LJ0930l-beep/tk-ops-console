<template>
  <ResourcePage
    ref="pageRef"
    api="/finance/expense"
    title="费用"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    :map-row="mapRow"
    :before-submit="beforeSubmit"
    dialog-width="720px"
    :action-width="200"
  >
    <template #toolbar-extra>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="人民币金额（amount_cny）由服务端按 expense_date 当日汇率自动折算，页面不可手改；店铺留空即为「公共费用」，利润报表按各店净 GMV 占比分摊。"
        style="width: 660px"
      />
    </template>

    <template #actions="{ row, reload }">
      <el-button
        v-if="Number(row.status) === 1"
        link
        type="success"
        size="small"
        :loading="paying === Number(row.id)"
        @click="markPaid(row, reload)"
      >
        标记已付款
      </el-button>
      <el-button v-else link type="warning" size="small" :loading="paying === Number(row.id)" @click="markUnpaid(row, reload)">
        撤回待付款
      </el-button>
      <el-button v-if="row.voucher" link type="primary" size="small" @click="openVoucher(row)">凭证</el-button>
    </template>
  </ResourcePage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import { apiPut, errMsg } from '@/api/client';
import { useDictStore } from '@/stores/dict';

const dict = useDictStore();
const pageRef = ref<InstanceType<typeof ResourcePage>>();
const shops = ref<{ id: number; shop_name: string }[]>([]);
const paying = ref(0);

/** expense.expense_type：1 达人坑位费 / 2 头程物流 / 3 海外仓费 / 4 工具订阅 / 5 服务费 / 6 其他 */
const EXPENSE_TYPE: OptionDef[] = [
  { value: 1, label: '达人坑位费', type: 'danger' },
  { value: 2, label: '头程物流', type: 'warning' },
  { value: 3, label: '海外仓费', type: 'warning' },
  { value: 4, label: '工具订阅', type: 'info' },
  { value: 5, label: '服务费', type: 'info' },
  { value: 6, label: '其他', type: 'info' },
];

/** expense.status：1 待付款 / 2 已付款 */
const PAY_STATUS: OptionDef[] = [
  { value: 1, label: '待付款', type: 'warning' },
  { value: 2, label: '已付款', type: 'success' },
];

const REF_TYPE: OptionDef[] = [
  { value: 'collaboration', label: '合作单' },
  { value: 'sample_shipment', label: '寄样单' },
  { value: 'live_session', label: '直播场次' },
];

const CURRENCY: OptionDef[] = ['CNY', 'USD', 'MYR', 'PHP', 'SGD', 'THB', 'VND', 'IDR', 'GBP', 'MXN'].map((c) => ({ value: c, label: c }));

const shopOpts = (): OptionDef[] => shops.value.map((s) => ({ value: s.id, label: s.shop_name }));

const columns: ColumnDef[] = [
  { prop: 'expense_date', label: '费用日期', width: 110, type: 'date', sortable: true },
  { prop: 'expense_type', label: '费用类型', width: 110, type: 'tag', options: EXPENSE_TYPE },
  { prop: 'shop_display', label: '归属', width: 130 },
  { prop: 'ref_display', label: '关联单据', width: 120 },
  { prop: 'amount', label: '原币金额', width: 110, type: 'money' },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'amount_cny', label: '人民币金额', width: 120, type: 'money' },
  { prop: 'payee', label: '收款方', width: 130 },
  { prop: 'status', label: '付款状态', width: 95, type: 'tag', options: PAY_STATUS },
  { prop: 'remark', label: '备注', minWidth: 140 },
];

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '关键字', placeholder: '收款方 / 备注' },
  { key: 'expense_type', label: '费用类型', type: 'select', options: EXPENSE_TYPE },
  { key: 'shop_id', label: '店铺', type: 'select', options: shopOpts() },
  { key: 'status', label: '付款状态', type: 'select', options: PAY_STATUS },
  { key: 'expense_date', label: '费用日期', type: 'daterange' },
]);

const formFields: FormFieldDef[] = [
  { key: 'expense_date', label: '费用日期', type: 'date', required: true },
  { key: 'expense_type', label: '费用类型', type: 'select', required: true, options: EXPENSE_TYPE, default: 1 },
  { key: 'shop_id', label: '归属店铺', type: 'select', options: shopOpts, placeholder: '留空 = 公共费用' },
  { key: 'amount', label: '原币金额', type: 'number', required: true, min: 0, precision: 2 },
  { key: 'currency', label: '币种', type: 'select', required: true, options: CURRENCY, default: 'CNY' },
  { key: 'ref_type', label: '关联类型', type: 'select', options: REF_TYPE },
  { key: 'ref_id', label: '关联 ID', type: 'number', precision: 0, min: 1 },
  { key: 'payee', label: '收款方', placeholder: '状态为已付款时必填' },
  { key: 'voucher', label: '凭证附件', placeholder: '图片/PDF 链接（≤500 字符）' },
  { key: 'status', label: '付款状态', type: 'select', required: true, options: PAY_STATUS, default: 1 },
  { key: 'remark', label: '备注', type: 'textarea', span: 24 },
];

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const refType = row.ref_type ? String(row.ref_type) : '';
  const refId = row.ref_id ? String(row.ref_id) : '';
  const refLabel = REF_TYPE.find((o) => o.value === refType)?.label ?? refType;
  return {
    ...row,
    shop_display: row.shop_name || (row.shop_id ? `#${row.shop_id}` : '公共费用'),
    ref_display: refType && refId ? `${refLabel} #${refId}` : refType || '-',
  };
}

function beforeSubmit(values: Record<string, unknown>): Record<string, unknown> {
  const v = { ...values };
  for (const k of ['shop_id', 'ref_type', 'ref_id', 'payee', 'voucher', 'remark']) {
    if (v[k] === '' || v[k] === undefined) delete v[k];
  }
  if (v.ref_id !== undefined && v.ref_type === undefined) delete v.ref_id;
  return v;
}

async function markPaid(row: Record<string, unknown>, reload: () => void): Promise<void> {
  if (!row.payee) {
    ElMessage.warning('状态为「已付款」必须填写收款方，请先编辑补全');
    return;
  }
  await changeStatus(row, 2, reload);
}

async function markUnpaid(row: Record<string, unknown>, reload: () => void): Promise<void> {
  await changeStatus(row, 1, reload);
}

async function changeStatus(row: Record<string, unknown>, status: number, reload: () => void): Promise<void> {
  paying.value = Number(row.id);
  try {
    await apiPut(`/finance/expense/${row.id}`, { status });
    ElMessage.success(status === 2 ? '已标记为付款完成' : '已撤回为待付款');
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    paying.value = 0;
  }
}

function openVoucher(row: Record<string, unknown>): void {
  const url = String(row.voucher ?? '');
  if (url) window.open(/^https?:\/\//i.test(url) ? url : `https://${url}`, '_blank');
}

onMounted(() => {
  dict
    .shopOptions()
    .then((s) => (shops.value = s.map((x) => ({ id: x.id, shop_name: x.shop_name }))))
    .catch(() => undefined);
});
</script>
