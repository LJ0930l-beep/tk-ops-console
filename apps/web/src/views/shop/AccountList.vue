<template>
  <div>
    <div v-if="rp && !rp.rows.length" class="page-tip">
      <el-alert type="info" :closable="false" show-icon title="还没有登记 TikTok 账号">
        <template #default>
          官方号 / 内容号 / 直播号在此统一维护，视频库与直播排班都从这里的账号取数。备注字段禁止填写账号密码。
        </template>
      </el-alert>
    </div>

    <ResourcePage
      ref="rp"
      api="/accounts"
      title="TikTok 账号"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :row-class-name="rowClass"
      dialog-width="680px"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { REGIONS } from '@tk/shared';
import { useAuthStore } from '@/stores/auth';
import { useDictStore, type DictOption } from '@/stores/dict';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

/** 全部子接口都要 shop 菜单（accountRouter.use(requireMenu('shop'))） */
const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('shop'));

const ACCOUNT_TYPE: OptionDef[] = [
  { value: 1, label: '官方号', type: 'primary' },
  { value: 2, label: '内容号' },
  { value: 3, label: '直播号', type: 'success' },
];
const ACCOUNT_STATUS: OptionDef[] = [
  { value: 1, label: '正常', type: 'success' },
  { value: 2, label: '限流', type: 'warning' },
  { value: 3, label: '封禁', type: 'danger' },
  { value: 4, label: '停用', type: 'info' },
];
const REGION_OPTIONS: OptionDef[] = REGIONS.map((r) => ({ value: r, label: r }));

/** 店铺下拉统一走 dict store（缓存 + 全站同一份） */
const regionDict = ref<DictOption[]>([]);
onMounted(async () => {
  await Promise.all([dict.shopOptions().catch(() => []), dict.dict('region').catch(() => [])]);
  regionDict.value = dict.cache['region'] ?? [];
});
const shopOpts = computed<OptionDef[]>(() => dict.shops.map((s) => ({ value: s.id, label: s.shop_name })));
const regionOpts = computed<OptionDef[]>(() =>
  regionDict.value.length ? regionDict.value.map((d) => ({ value: d.dict_value, label: d.dict_label })) : REGION_OPTIONS,
);

const columns = computed<ColumnDef[]>(() => [
  { prop: 'handle', label: '账号 Handle', minWidth: 150, fixed: 'left' },
  { prop: 'nickname', label: '昵称', minWidth: 130 },
  { prop: 'account_type', label: '账号类型', width: 100, type: 'tag', options: ACCOUNT_TYPE },
  { prop: 'shop_name', label: '所属店铺', width: 150 },
  { prop: 'region', label: '站点', width: 70 },
  { prop: 'followers', label: '粉丝数', width: 100, sortable: true },
  { prop: 'owner_name', label: '负责人', width: 100 },
  { prop: 'account_status', label: '账号状态', width: 100, type: 'tag', options: ACCOUNT_STATUS },
  { prop: 'remark', label: '备注', minWidth: 160 },
  { prop: 'created_at', label: '登记时间', width: 150, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: 'Handle/昵称', placeholder: '模糊搜索' },
  { key: 'shop_id', label: '所属店铺', type: 'select', options: shopOpts.value },
  { key: 'account_type', label: '账号类型', type: 'select', options: ACCOUNT_TYPE },
  { key: 'account_status', label: '账号状态', type: 'select', options: ACCOUNT_STATUS },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'handle', label: '账号 Handle', required: true, placeholder: '2~64 字，提交后自动转小写去 @' },
  { key: 'nickname', label: '昵称' },
  { key: 'account_type', label: '账号类型', type: 'select', options: ACCOUNT_TYPE, default: 2 },
  { key: 'shop_id', label: '所属店铺', type: 'select', options: () => shopOpts.value },
  { key: 'region', label: '站点', type: 'select', options: () => regionOpts.value },
  { key: 'followers', label: '粉丝数', type: 'number', min: 0, max: 9_999_999_999, precision: 0, default: 0 },
  { key: 'account_status', label: '账号状态', type: 'select', options: ACCOUNT_STATUS, default: 1 },
  { key: 'remark', label: '备注', type: 'textarea', span: 24, placeholder: '≤500 字；禁止填写账号密码' },
]);

/** account_status ≠ 1 整行标红（PRD 3.2 告警态） */
function rowClass({ row }: { row: Record<string, unknown> }): string {
  return Number(row.account_status) === 1 ? '' : 'account-row-danger';
}
</script>

<style scoped>
.page-tip {
  padding: 12px 16px 0;
}
:deep(tr.account-row-danger td.el-table__cell) {
  background: #fef0f0 !important;
}
</style>
