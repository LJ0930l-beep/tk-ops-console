<template>
  <div class="page">
    <PageHeader title="模型服务商" sub="一家服务商可以带一串模型：反代/网关后面挂几十个名字，配一次地址就能全部选到。API Key 用 AES-256-GCM 加密存库，任何读接口都不会回传它，界面上只看「已配置」">
      <template #tag>
        <el-tag size="small" :type="allowedHosts.length ? 'success' : 'warning'">
          {{ allowedHosts.length ? `出网白名单 ${allowedHosts.length} 个域` : '未设置 AI_ALLOWED_HOSTS：任何 https 地址都能配' }}
        </el-tag>
        <el-tag v-if="plainHttpHosts.length" size="small" type="danger" effect="plain">
          明文放行 {{ plainHttpHosts.length }} 个地址：{{ plainHttpHosts.join(' / ') }}
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
      :action-width="260"
      dialog-width="720px"
    >
      <template #actions="{ row, reload }">
        <el-button link type="primary" size="small" :loading="pulling === Number(row.id)" @click="pull(row, reload)">拉模型</el-button>
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
const pulling = ref(0);
const allowedHosts = ref<string[]>([]);
/** 服务端设了 AI_ALLOW_HTTP_HOSTS 才非空：这几条内网地址允许明文，密钥会跟着明文过网，必须在界面上看得见 */
const plainHttpHosts = ref<string[]>([]);

const vendorOptions = Object.entries(AI_VENDOR_LABELS).map(([value, label]) => ({ value, label }));
const protocolOptions = Object.values(AI_PROTOCOL).map((v) => ({ value: v, label: v === 'openai' ? 'OpenAI 兼容（GPT / DeepSeek / 网关）' : 'Google Gemini 原生' }));
const yesNo = [{ value: 1, label: '是' }, { value: 0, label: '否' }];
/** has_key 是接口算出来的布尔值，不是 1/0 列：套用 yesNo 会匹配不上，单元格里直接印出 "true" */
const keyState = [{ value: 'true', label: '已配置', type: 'success' as const }, { value: 'false', label: '未配置', type: 'warning' as const }];

const columns = computed<ColumnDef[]>(() => [
  { prop: 'name', label: '名称', width: 150 },
  { prop: 'vendor', label: '厂商', width: 110 },
  { prop: 'protocol', label: '协议', width: 90 },
  { prop: 'model', label: '默认模型', width: 170 },
  { prop: 'model_count', label: '模型数', width: 90, align: 'center' },
  { prop: 'base_url', label: '接口地址', minWidth: 230 },
  { prop: 'has_key', label: 'API Key', width: 96, type: 'tag', options: keyState },
  { prop: 'supports_tools', label: '支持函数调用', width: 120, type: 'tag', options: yesNo },
  { prop: 'enabled', label: '启用', width: 80, type: 'tag', options: yesNo },
  { prop: 'is_default', label: '默认', width: 80, type: 'tag', options: yesNo },
  { prop: 'last_test_ok', label: '最近测活', width: 110, type: 'tag', options: [{ value: 1, label: '通过', type: 'success' }, { value: 0, label: '失败', type: 'danger' }] },
  { prop: 'last_test_at', label: '测活时间', type: 'datetime', width: 150 },
]);

const searchFields = computed<SearchDef[]>(() => [
  { key: 'keyword', label: '名称/模型', placeholder: '模糊，清单里的也算' },
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
  {
    key: 'model',
    label: '默认模型',
    span: 12,
    placeholder: '不确定的话先留空，保存后点「拉模型」',
    default: AI_VENDOR_PRESETS.openai.model,
  },
  {
    key: 'models',
    label: '可选模型清单',
    type: 'textarea',
    span: 24,
    placeholder:
      '反代 / 自建网关一家后面常挂几十个模型：一行一个（或逗号分隔）粘在这里，或者直接保存后点列表里的「拉模型」让服务商自己报。对话时可以逐条挑，不必为一堆模型建很多行。',
  },
  { key: 'api_key', label: 'API Key', span: 12, placeholder: '编辑时留空＝保持原密钥不变；填 null 才清空' },
  { key: 'temperature', label: 'temperature', type: 'number', span: 6, precision: 2, min: 0, max: 2, default: 0.3 },
  { key: 'max_output_tokens', label: '最大输出 token', type: 'number', span: 6, min: 64, max: 32000, default: 1024 },
  { key: 'price_in_per_1k', label: '输入单价/1K(¥)', type: 'number', span: 6, precision: 4, min: 0, default: 0 },
  { key: 'price_out_per_1k', label: '输出单价/1K(¥)', type: 'number', span: 6, precision: 4, min: 0, default: 0 },
  { key: 'supports_tools', label: '支持函数调用', type: 'switch', span: 8, default: 1 },
  { key: 'enabled', label: '启用', type: 'switch', span: 8, default: 1 },
  { key: 'is_default', label: '设为默认', type: 'switch', span: 8, default: 0 },
]);

interface PullResult {
  models: string[];
  default_model: string;
  fetched_total: number;
  added: number;
  truncated: boolean;
}

/**
 * 拉模型：让服务商自己报"我这里有哪几个模型"。
 * 反代/网关的模型名是人抄不全的，而这一步的失败原因（地址不对 / 密钥不对 / 没开 /models）
 * 都直接决定下一步做什么，所以把服务端的原文案原样显示出来，不压成一句"拉取失败"。
 */
async function pull(row: Record<string, unknown>, reload: () => void): Promise<void> {
  const id = Number(row.id);
  pulling.value = id;
  try {
    const res = await apiPost<PullResult>(`/ai/providers/${id}/models`, {});
    const cut = res.truncated ? `（网关报了 ${res.fetched_total} 个，只存前 ${res.models.length} 个）` : '';
    ElMessage.success(`取到 ${res.models.length} 个模型，新增 ${res.added} 个${cut}；默认 ${res.default_model || '（未设）'}`);
  } catch (e) {
    ElMessage.error(`拉模型失败：${errMsg(e)}`);
  } finally {
    pulling.value = 0;
    reload();
  }
}

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
    const u = await apiGet<{ allowed_hosts?: string[]; plain_http_hosts?: string[] }>('/ai/calls/usage');
    allowedHosts.value = u.allowed_hosts ?? [];
    plainHttpHosts.value = u.plain_http_hosts ?? [];
  } catch {
    /* 拿不到不影响配置 */
  }
});
</script>
