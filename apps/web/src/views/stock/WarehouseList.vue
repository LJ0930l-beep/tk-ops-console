<template>
  <ResourcePage
    api="/stock/warehouses"
    title="仓库"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    dialog-width="560px"
  >
    <template #toolbar-extra>
      <el-alert type="info" :closable="false" show-icon title="仓库为主数据：停用后不再参与出入库登记，历史流水保留。" style="width: 520px" />
    </template>
  </ResourcePage>
</template>

<script setup lang="ts">
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import { REGIONS } from '@tk/shared';

/** warehouse.wh_type：1 国内仓 / 2 海外仓 / 3 平台仓 */
const WH_TYPE: OptionDef[] = [
  { value: 1, label: '国内仓', type: 'primary' },
  { value: 2, label: '海外仓', type: 'success' },
  { value: 3, label: '平台仓', type: 'warning' },
];

const STATUS: OptionDef[] = [
  { value: 1, label: '启用', type: 'success' },
  { value: 0, label: '停用', type: 'info' },
];

const regionOpts: OptionDef[] = REGIONS.map((r) => ({ value: r, label: r }));

const columns: ColumnDef[] = [
  { prop: 'name', label: '仓库名称', minWidth: 180 },
  { prop: 'wh_type', label: '仓库类型', width: 110, type: 'tag', options: WH_TYPE },
  { prop: 'region', label: '站点', width: 90 },
  { prop: 'status', label: '状态', width: 90, type: 'tag', options: STATUS },
  { prop: 'created_at', label: '创建时间', width: 150, type: 'datetime' },
  { prop: 'updated_at', label: '更新时间', width: 150, type: 'datetime' },
];

const searchFields: SearchDef[] = [
  { key: 'keyword', label: '仓库名称', placeholder: '模糊查询' },
  { key: 'wh_type', label: '仓库类型', type: 'select', options: WH_TYPE },
  { key: 'region', label: '站点', type: 'select', options: regionOpts },
  { key: 'status', label: '状态', type: 'select', options: STATUS },
];

const formFields: FormFieldDef[] = [
  { key: 'name', label: '仓库名称', required: true, placeholder: '≤100 字符，全局唯一' },
  { key: 'wh_type', label: '仓库类型', type: 'select', required: true, options: WH_TYPE, default: 1 },
  { key: 'region', label: '站点', type: 'select', options: regionOpts, placeholder: '海外仓建议填写' },
  { key: 'status', label: '启用状态', type: 'switch', default: 1 },
];
</script>
