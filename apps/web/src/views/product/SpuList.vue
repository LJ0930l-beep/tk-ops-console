<template>
  <div>
    <div v-if="rp && !rp.rows.length" class="page-tip">
      <el-alert type="info" :closable="false" show-icon title="还没有商品（SPU）">
        <template #default>
          可先手工新增，或用 CSV 导入 / 商品同步把店铺商品拉进来；SPU 建好后才能维护 SKU 与成本，成本缺失会导致利润算不准。
        </template>
      </el-alert>
    </div>

    <ResourcePage
      ref="rp"
      api="/products/spu"
      title="商品 SPU"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :can-write="canWrite"
      :action-width="150"
      dialog-width="720px"
    >
      <template #form-extra="{ form }">
        <el-form-item label="主图预览">
          <div class="img-preview">
            <el-image v-if="isUrl(String(form.main_image ?? ''))" :src="String(form.main_image)" fit="cover" style="width: 88px; height: 88px" />
            <span v-else class="tip">填写图片 URL（≤500 字，需以 http/https 开头）后在此预览</span>
          </div>
        </el-form-item>
      </template>
      <template #toolbar="{ query }">
        <ExportButton url="/products/spu/export" name="product-spu" :params="query" />
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';
import { apiGet, type Paged } from '@/api/client';
import ResourcePage, { type ColumnDef, type FormFieldDef, type OptionDef, type SearchDef } from '@/components/ResourcePage.vue';
import ExportButton from '@/components/ExportButton.vue';

const auth = useAuthStore();
const dict = useDictStore();
const rp = ref();

const canWrite = computed(() => auth.roleKey === 'boss' || auth.menus.includes('product'));

const SPU_STATUS: OptionDef[] = [
  { value: 1, label: '开发中', type: 'warning' },
  { value: 2, label: '在售', type: 'success' },
  { value: 3, label: '停售', type: 'info' },
];

const categoryOpts = ref<OptionDef[]>([]);
const ownerOpts = ref<OptionDef[]>([]);

onMounted(async () => {
  const rows = await dict.dict('category');
  categoryOpts.value = rows.map((d) => ({ value: d.dict_value, label: d.dict_label }));
  if (auth.menus.includes('system')) {
    try {
      const r = await apiGet<Paged<Record<string, unknown>>>('/system/users', { page: 1, pageSize: 200 });
      ownerOpts.value = (r.list ?? []).map((u) => ({ value: Number(u.id), label: `${String(u.real_name ?? u.username)}（${String(u.username)}）` }));
    } catch {
      /* 无 system 菜单时负责人下拉留空 */
    }
  }
});

const columns = computed<ColumnDef[]>(() => [
  { prop: 'spu_code', label: 'SPU 编码', width: 140, fixed: 'left' },
  { prop: 'name_cn', label: '商品名称(中文)', minWidth: 200 },
  { prop: 'name_en', label: '商品名称(英文)', minWidth: 180 },
  { prop: 'category', label: '品类', width: 110 },
  { prop: 'main_image', label: '主图 URL', width: 180 },
  { prop: 'owner_name', label: '负责人', width: 100 },
  { prop: 'status', label: '状态', width: 100, type: 'tag', options: SPU_STATUS },
  { prop: 'sku_count', label: 'SKU 数', width: 90, sortable: true },
  { prop: 'created_at', label: '创建时间', width: 150, type: 'datetime' },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '编码/名称', placeholder: 'SPU 编码或中英文名' },
  { key: 'category', label: '品类', type: 'select', options: categoryOpts.value },
  { key: 'status', label: '状态', type: 'select', options: SPU_STATUS },
  ...(ownerOpts.value.length ? [{ key: 'owner_id', label: '负责人', type: 'select' as const, options: ownerOpts.value }] : []),
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'spu_code', label: 'SPU 编码', required: true, disabledOnEdit: true, placeholder: '≤64 字，全局唯一' },
  { key: 'category', label: '品类', type: 'select', options: () => categoryOpts.value },
  { key: 'name_cn', label: '商品名称(中文)', required: true, span: 24, placeholder: '≤200 字' },
  { key: 'name_en', label: '商品名称(英文)', span: 24, placeholder: '≤300 字，用于店铺上架' },
  { key: 'main_image', label: '主图 URL', span: 24, placeholder: 'http(s)://…，≤500 字' },
  { key: 'owner_id', label: '负责人', type: 'select', options: () => ownerOpts.value },
  { key: 'status', label: '状态', type: 'select', options: SPU_STATUS, default: 1 },
]);

function isUrl(v: string) {
  return /^https?:\/\//i.test(v);
}
</script>

<style scoped>
.page-tip {
  padding: 12px 16px 0;
}
.img-preview {
  display: flex;
  align-items: center;
  min-height: 40px;
}
.tip {
  color: #909399;
  font-size: 12px;
}
</style>
