<template>
  <div class="page">
    <PageHeader title="模型服务商" sub="一家服务商 = 一个模型入口。API Key 用 AES-256-GCM 加密存库，任何读接口都不会回传它，界面上只看「已配置」">
      <template #tag>
        <el-tag size="small" :type="allowedHosts.length ? 'success' : 'warning'">
          {{ allowedHosts.length ? `出网白名单 ${allowedHosts.length} 个域` : '未设置 AI_ALLOWED_HOSTS：任何 https 地址都能配' }}
        </el-tag>
      </template>
    </PageHeader>

    <ResourcePage
      ref="rp"
      api="/ai/providers"
      title="服务商"
      :columns="columns"
      :search-fields="searchFields"
      :form-fields="formFields"
      :default-page-size="20"
      :action-width="210"
      dialog-width="720px"
    >
      <template #actions="{ row, reload }">
        <el-button link type="primary" size="small" :loading="testing === Number(row.id)" @click="test(row, reload)">测活</el-button>
      </template>
    </ResourcePage>
  </div>
</template>

<script setup lang="ts">
/**
 * 服务商配置页。
 *
 * 表单里 api_key 是"写一次就看不见"的字段：编辑时留空 = 保持原值不动，
 * 这一点必须在 placeholder 与说明里写明白，否则运营会以为"没显示=没配"而重复填。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { AI_PROTOCOL, AI_VENDOR, AI_VENDOR_LABELS, AI_VENDOR_PRESETS } from '@tk/shared';
import { apiGet, apiPost, errMsg } from '@/api/client';
import ResourcePage, { type ColumnDef, type FormFieldDef, type SearchDef } from '@/components/ResourcePage.vue';
import PageHeader from '@/components/PageHeader.vue';

const rp = ref();
const testing = ref(0);
const allowedHosts = ref<string[]>([]);

const vendorOptions = Object.entries(AI_VENDOR_LABELS).map(([value, label]) => ({ value, label }));
const protocolOptions = Object.values(AI_PROTOCOL).map((v) => ({ value: v, label: v === 'openai' ? 'OpenAI 兼容（GPT / DeepSeek / 网关）' : 'Google Gemini 原生' }));
const yesNo = [{ value: 1, label: '是' }, { value: 0, label: '否' }];

const columns = computed<ColumnDef[]>(() => [
  { prop: 'name', label: '名称', width: 150 },
  { prop: 'vendor', label: '厂商', width: 110 },
  { prop: 'protocol', label: '协议', width: 90 },
  { prop: 'model', label: '模型', width: 170 },
  { prop: 'base_url', label: '接口地址', minWidth: 230 },
  { prop: 'has_key', label: 'API Key', width: 96, type: 'tag', options: yesNo },
  { prop: 'supports_tools', label: '支持函数调用', width: 120, type: 'tag', options: yesNo },
  { prop: 'enabled', label: '启用', width: 80, type: 'tag', options: yesNo },
  { prop: 'is_default', label: '默认', width: 80, type: 'tag', options: yesNo },
  { prop: 'last_test_ok', label: '最近测活', width: 110, type: 'tag', options: [{ value: 1, label: '通过', type: 'success' }, { value: 0, label: '失败', type: 'danger' }] },
  { prop: 'last_test_at', label: '测活时间', type: 'datetime', width: 150 },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '名称/模型', placeholder: '模糊' },
  { key: 'vendor', label: '厂商', type: 'select', options: vendorOptions },
  { key: 'enabled', label: '启用', type: 'select', options: yesNo },
]);

const formFields = computed<FormFieldDef[]>(() => [
  { key: 'name', label: '名称', required: true, span: 12, placeholder: '如：公司 GPT / DeepSeek 正式' },
  {
    key: 'vendor',
    label: '厂商',
    type: 'select',
    required: true,
    span: 12,
    options: vendorOptions,
    /** 默认值不只是好看：必填下拉留空会让"新增"点下去只弹一行红字，什么请求都不发 */
    default: AI_VENDOR.OPENAI,
    /** 换厂商就把协议 / 地址 / 模型一次填成该家的公开默认值，省得手抄错一个字母调半天 */
    onChange: (form) => {
      const preset = AI_VENDOR_PRESETS[form.vendor as keyof typeof AI_VENDOR_PRESETS];
      if (!preset) return;
      form.protocol = preset.protocol;
      if (preset.base_url) form.base_url = preset.base_url;
      if (preset.model) form.model = preset.model;
    },
  },
  { key: 'protocol', label: '报文协议', type: 'select', required: true, span: 12, options: protocolOptions, default: AI_PROTOCOL.OPENAI },
  { key: 'base_url', label: '接口地址', required: true, span: 12, placeholder: 'https://api.openai.com/v1', default: AI_VENDOR_PRESETS.openai.base_url },
  { key: 'model', label: '模型名', required: true, span: 12, placeholder: 'gpt-4o-mini / deepseek-chat / gemini-2.5-flash', default: AI_VENDOR_PRESETS.openai.model },
  { key: 'api_key', label: 'API Key', span: 12, placeholder: '编辑时留空＝保持原密钥不变；填 null 才清空' },
  { key: 'temperature', label: 'temperature', type: 'number', span: 6, precision: 2, min: 0, max: 2, default: 0.3 },
  { key: 'max_output_tokens', label: '最大输出 token', type: 'number', span: 6, min: 64, max: 32000, default: 1024 },
  { key: 'price_in_per_1k', label: '输入单价/1K(¥)', type: 'number', span: 6, precision: 4, min: 0, default: 0 },
  { key: 'price_out_per_1k', label: '输出单价/1K(¥)', type: 'number', span: 6, precision: 4, min: 0, default: 0 },
  { key: 'supports_tools', label: '支持函数调用', type: 'switch', span: 8, default: 1 },
  { key: 'enabled', label: '启用', type: 'switch', span: 8, default: 1 },
  { key: 'is_default', label: '设为默认', type: 'switch', span: 8, default: 0 },
]);

async function test(row: Record<string, unknown>, reload: () => void): Promise<void> {
  const id = Number(row.id);
  testing.value = id;
  try {
    const res = await apiPost<{ ok: boolean; reply?: string; error?: string }>(`/ai/providers/${id}/test`, {});
    if (res.ok) ElMessage.success(`测活通过：${res.reply ?? ''}`.slice(0, 90));
    else ElMessage.error(`测活失败：${res.error ?? '未知原因'}`);
  } catch (e) {
    ElMessage.error(errMsg(e));
  } finally {
    testing.value = 0;
    reload();
  }
}

onMounted(async () => {
  try {
    const u = await apiGet<{ allowed_hosts?: string[] }>('/ai/calls/usage');
    allowedHosts.value = u.allowed_hosts ?? [];
  } catch {
    /* 拿不到不影响配置 */
  }
});
</script>
