<template>
  <div class="page">
    <el-card class="page-card" shadow="never">
      <el-form inline @submit.prevent="reload(1)">
        <template v-for="f in searchFields" :key="f.key">
          <el-form-item :label="f.label">
            <el-input v-if="!f.type || f.type === 'text'" v-model="query[f.key]" clearable :placeholder="f.placeholder" style="width: 170px" @keyup.enter="reload(1)" />
            <el-select v-else-if="f.type === 'select'" v-model="query[f.key]" clearable placeholder="全部" style="width: 150px">
              <el-option v-for="o in resolveOptions(f)" :key="String(o.value)" :label="o.label" :value="o.value" />
            </el-select>
            <el-date-picker v-else-if="f.type === 'date'" v-model="query[f.key]" type="date" value-format="YYYY-MM-DD" style="width: 150px" clearable />
            <el-date-picker
              v-else-if="f.type === 'daterange'"
              v-model="rangeModel[f.key]"
              type="daterange"
              value-format="YYYY-MM-DD"
              start-placeholder="开始"
              end-placeholder="结束"
              style="width: 240px"
              clearable
              @change="(v: [string, string] | null) => { const fk = f.fromKey ?? `${f.key}_from`; const tk = f.toKey ?? `${f.key}_to`; if (v) { query[fk] = v[0]; query[tk] = v[1]; } else { delete query[fk]; delete query[tk]; } reload(1); }"
            />
          </el-form-item>
        </template>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="reload(1)">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
        <slot name="toolbar-extra" />
        <div>
          <slot name="toolbar" :reload="() => reload()" :query="query" />
          <el-button v-if="createable && canWrite" type="primary" :icon="Plus" @click="openCreate">新增</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="rows"
        border
        stripe
        size="small"
        :row-key="rowKey"
        :row-class-name="rowClassName"
        style="width: 100%"
        @sort-change="onSort"
      >
        <el-table-column type="index" label="#" width="48" />
        <template v-for="c in columns" :key="c.prop">
          <el-table-column
            :prop="c.prop"
            :label="c.label"
            :width="c.width"
            :min-width="c.minWidth ?? defaultWidth(c.type)"
            :sortable="c.sortable ? 'custom' : false"
            :fixed="c.fixed"
            :align="c.align ?? (c.type === 'money' || c.type === 'percent' ? 'right' : undefined)"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <el-image v-if="c.type === 'image'" :src="String(cell(row, c) ?? '')" style="width: 36px; height: 36px; border-radius: 4px" fit="cover" preview-teleported :preview-src-list="cell(row, c) ? [String(cell(row, c))] : []" />
              <template v-else-if="c.type === 'money'"><span :class="{ 'money-cny': c.prop.includes('cny') || c.prop.includes('cost') }">{{ fmtMoney(cell(row, c)) }}</span></template>
              <el-tag v-else-if="c.type === 'tag'" :type="tagType(cell(row, c), c.options)" size="small">{{ optionLabel(cell(row, c), c.options) }}</el-tag>
              <span v-else-if="c.type === 'datetime'">{{ fmtDateTime(cell(row, c)) }}</span>
              <span v-else-if="c.type === 'percent'">{{ cell(row, c) == null ? '-' : `${Number(cell(row, c)).toFixed(1)}%` }}</span>
              <span v-else-if="cell(row, c) === '***'" class="mask">***</span>
              <router-link v-else-if="c.link" :to="typeof c.link === 'function' ? (c.link as LinkFn)(row) : String(c.link)" style="color: #409eff; text-decoration: none">{{ String(cell(row, c) ?? '-') }}</router-link>
              <template v-else>{{ cell(row, c) ?? '-' }}</template>
            </template>
          </el-table-column>
        </template>
        <el-table-column v-if="editable || deletable || historyTable || $slots.actions" label="操作" :width="actionWidth" fixed="right">
          <template #default="{ row }">
            <slot name="actions" :row="row as RowLike" :reload="() => reload()" />
            <el-button v-if="editable && canWrite" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm v-if="deletable && canWrite" title="删除仅打标记可追溯，确认删除？" @confirm="doDelete(row)">
              <template #reference><el-button link type="danger" size="small">删除</el-button></template>
            </el-popconfirm>
            <el-button v-if="historyTable" link type="info" size="small" @click="openHistory(row)">变更历史</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 12px; justify-content: flex-end"
        @current-change="reload()"
        @size-change="reload(1)"
      />
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? `编辑${title}` : `新增${title}`" :width="dialogWidth" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="12">
          <template v-for="f in visibleFormFields" :key="f.key">
            <el-col :span="f.span ?? 12">
              <el-form-item :label="f.label" :prop="f.key">
                <el-select v-if="f.type === 'select'" v-model="form[f.key]" filterable clearable :disabled="Boolean(editing && f.disabledOnEdit)" style="width: 100%" @change="f.onChange?.(form)">
                  <el-option v-for="o in resolveOptions(f)" :key="String(o.value)" :label="o.label" :value="o.value" :disabled="o.disabled" />
                </el-select>
                <el-input-number v-else-if="f.type === 'number'" v-model="form[f.key]" :precision="f.precision ?? 2" :step="f.step ?? 1" :min="f.min" :max="f.max" controls-position="right" style="width: 100%" />
                <el-date-picker v-else-if="f.type === 'date'" v-model="form[f.key]" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
                <el-date-picker v-else-if="f.type === 'datetime'" v-model="form[f.key]" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
                <el-switch v-else-if="f.type === 'switch'" v-model="form[f.key]" :active-value="1" :inactive-value="0" />
                <el-input v-else-if="f.type === 'textarea'" v-model="form[f.key]" type="textarea" :rows="2" maxlength="500" show-word-limit />
                <el-input v-else v-model="form[f.key]" :disabled="Boolean(editing && f.disabledOnEdit)" :placeholder="f.placeholder" />
              </el-form-item>
            </el-col>
          </template>
        </el-row>
        <slot name="form-extra" :form="form as RowLike" :editing="editing" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSubmit">保存</el-button>
      </template>
    </el-dialog>

    <RecordHistoryDrawer
      v-if="historyTable"
      v-model:visible="historyVisible"
      :table="historyTable"
      :record-id="historyTarget?.id"
      :title="title"
      :record-name="historyRecordName"
    />
  </div>
</template>

<script lang="ts">
export type LinkFn = (row: Record<string, unknown>) => string;

export interface ColumnDef {
  prop: string;
  label: string;
  width?: number | string;
  minWidth?: number | string;
  type?: 'text' | 'money' | 'tag' | 'datetime' | 'date' | 'percent' | 'link' | 'image';
  align?: 'left' | 'center' | 'right';
  options?: OptionDef[];
  dictType?: string;
  sortable?: boolean;
  fixed?: 'left' | 'right' | boolean;
  link?: string | LinkFn;
}

export interface OptionDef {
  value: string | number;
  label: string;
  type?: 'success' | 'warning' | 'danger' | 'info' | 'primary';
  disabled?: boolean;
}

export interface SearchDef {
  key: string;
  label: string;
  type?: 'text' | 'select' | 'date' | 'daterange';
  options?: OptionDef[];
  dictType?: string;
  placeholder?: string;
  fromKey?: string;
  toKey?: string;
}

export interface FormFieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'date' | 'datetime' | 'textarea' | 'switch';
  required?: boolean;
  options?: OptionDef[] | (() => OptionDef[]);
  dictType?: string;
  default?: unknown;
  span?: number;
  precision?: number;
  step?: number;
  min?: number;
  max?: number;
  disabledOnEdit?: boolean;
  placeholder?: string;
  onChange?: (form: Record<string, unknown>) => void;
  when?: (form: Record<string, unknown>, editing: boolean) => boolean;
}
</script>

<script setup lang="ts">
import type { RowLike } from '@/types/row';
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormRules } from 'element-plus';
import { Plus, RefreshLeft, Search } from '@element-plus/icons-vue';
import { apiDelete, apiGet, apiPost, apiPut, errMsg, type Paged } from '@/api/client';
import type { ApiPath } from '@/api/paths';
import { useDictStore, type DictOption } from '@/stores/dict';
import RecordHistoryDrawer from './RecordHistoryDrawer.vue';

/**
 * 通用 CRUD 组件按 REST 约定拼 `/资源/:id`。组件本身不知道某家资源有没有 :id 路由，
 * 这一处拼接不做校验；真正的把关在调用方传进来的 api 字面量（已经是 ApiPath 类型）。
 */
const restUrl = (base: ApiPath, seg: unknown): ApiPath => `${base}/${seg as string | number}` as ApiPath;

const props = withDefaults(
  defineProps<{
    api: ApiPath;
    title: string;
    columns: ColumnDef[];
    searchFields?: SearchDef[];
    formFields?: FormFieldDef[];
    extraQuery?: Record<string, unknown>;
    createable?: boolean;
    editable?: boolean;
    deletable?: boolean;
    /** 传库表名（如 tk_shop）即开启行内「变更历史」；不给就不显示，各页按需要接入 */
    historyTable?: string;
    canWrite?: boolean;
    rowKey?: string;
    actionWidth?: number;
    dialogWidth?: string;
    defaultPageSize?: number;
    rowClassName?: (row: { row: Record<string, unknown> }) => string;
    beforeSubmit?: (values: Record<string, unknown>, editing: unknown) => Record<string, unknown>;
    mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  }>(),
  {
    createable: true,
    editable: true,
    deletable: true,
    canWrite: true,
    rowKey: 'id',
    actionWidth: 140,
    dialogWidth: '640px',
    defaultPageSize: 20,
  },
);

const dict = useDictStore();
const loading = ref(false);
const saving = ref(false);
const rows = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(props.defaultPageSize);
const query = reactive<Record<string, any>>({});
const rangeModel = reactive<Record<string, [string, string] | null>>({});
const sortBy = ref('');
const sortOrder = ref('');

const dialogVisible = ref(false);
const editing = ref<Record<string, unknown> | null>(null);
const form = reactive<Record<string, any>>({});
const formRef = ref();

const visibleFormFields = computed(() => (props.formFields ?? []).filter((f) => !f.when || f.when(form, !!editing.value)));

const rules = computed<FormRules>(() =>
  Object.fromEntries(
    (props.formFields ?? [])
      .filter((f) => f.required)
      .map((f) => [
        f.key,
        [{ required: true, message: `请填写${f.label}`, trigger: f.type === 'select' ? 'change' : 'blur' }],
      ]),
  ),
);

function cell(row: Record<string, unknown>, c: ColumnDef): unknown {
  const v = row[c.prop];
  if (c.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return v;
}

const fmtMoney = (v: unknown) => (v === '***' || v === null || v === undefined || v === '' ? (v === '***' ? '***' : '-') : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtDateTime = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 16) : '-');
const defaultWidth = (t?: string) => (t === 'money' ? 110 : t === 'datetime' ? 150 : t === 'tag' ? 100 : undefined);

function optionLabel(v: unknown, opts?: OptionDef[]): string {
  if (v === null || v === undefined || v === '') return '-';
  if (v === '***') return '***';
  return String(opts?.find((o) => String(o.value) === String(v))?.label ?? v);
}
function tagType(v: unknown, opts?: OptionDef[]) {
  return opts?.find((o) => String(o.value) === String(v))?.type ?? 'info';
}

function resolveOptions(f: { options?: OptionDef[] | (() => OptionDef[]); dictType?: string }): OptionDef[] {
  if (typeof f.options === 'function') return f.options();
  if (f.options) return f.options;
  if (f.dictType) return (dict.cache[f.dictType] ?? []).map((d: DictOption) => ({ value: d.dict_value, label: d.dict_label }));
  return [];
}

async function preloadDicts() {
  const types = new Set<string>();
  for (const c of props.columns) if (c.dictType) types.add(c.dictType);
  for (const f of props.searchFields ?? []) if (f.dictType) types.add(f.dictType);
  for (const f of props.formFields ?? []) if (f.dictType) types.add(f.dictType);
  await Promise.all([...types].map((t) => dict.dict(t).catch(() => undefined)));
}

async function reload(resetPage?: number) {
  if (resetPage) page.value = resetPage;
  loading.value = true;
  try {
    const data = await apiGet<Paged<Record<string, unknown>>>(props.api, {
      page: page.value,
      pageSize: pageSize.value,
      ...(sortBy.value ? { sortBy: sortBy.value, sortOrder: sortOrder.value } : {}),
      ...props.extraQuery,
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
    });
    rows.value = (data.list ?? []).map((r) => (props.mapRow ? props.mapRow(r) : r));
    total.value = data.total ?? 0;
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    loading.value = false;
  }
}

function onSort({ prop, order }: { prop: string | null; order: string | null }) {
  sortBy.value = order && prop ? prop : '';
  sortOrder.value = order === 'ascending' ? 'asc' : order === 'descending' ? 'desc' : '';
  reload();
}

function resetQuery() {
  for (const k of Object.keys(query)) delete query[k];
  for (const k of Object.keys(rangeModel)) delete rangeModel[k];
  reload(1);
}

function openCreate() {
  editing.value = null;
  for (const k of Object.keys(form)) delete form[k];
  for (const f of props.formFields ?? []) if (f.default !== undefined) form[f.key] = f.default;
  dialogVisible.value = true;
}

function openEdit(row: Record<string, unknown>) {
  editing.value = row;
  for (const k of Object.keys(form)) delete form[k];
  for (const f of props.formFields ?? []) {
    const v = row[f.key];
    form[f.key] = v === null || v === undefined ? (f.default ?? undefined) : v;
  }
  dialogVisible.value = true;
}

async function doSubmit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  const values = props.beforeSubmit ? props.beforeSubmit({ ...form }, editing.value) : { ...form };
  saving.value = true;
  try {
    if (editing.value) await apiPut(restUrl(props.api, editing.value.id), values);
    else await apiPost(props.api, values);
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    saving.value = false;
  }
}

async function doDelete(row: Record<string, unknown>) {
  try {
    await apiDelete(restUrl(props.api, row.id as string | number));
    ElMessage.success('已删除');
    reload();
  } catch (e) {
    ElMessage.error(errMsg(e));
  }
}

/* ---------- 变更历史（opt-in：传了 historyTable 才出现） ---------- */
const historyVisible = ref(false);
const historyTarget = ref<RowLike | null>(null);
/** 抽屉里点明是哪条记录：各页都把第一列当识别列（店铺名 / SKU 编码 / 员工姓名） */
const historyRecordName = computed(() => {
  const first = props.columns[0];
  return historyTarget.value && first ? String(historyTarget.value[first.prop] ?? '') : '';
});

function openHistory(row: Record<string, unknown>) {
  historyTarget.value = row;
  historyVisible.value = true;
}

onMounted(async () => {
  await preloadDicts();
  reload(1);
});

defineExpose({ reload, openEdit, openCreate, rows });
</script>
